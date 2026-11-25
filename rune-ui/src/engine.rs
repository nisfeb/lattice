//! The urb engine: urb-fetch's Rust core over libmesa, linked into the app
//! and run on a thread of its own, as the desktop app runs it
//! (`desktop/src/engine.rs`, which this follows). It reads pages, folders,
//! comments, and forum/furum boards people publish with lattice on the
//! Urbit network, as a comet this app makes once and keeps, so someone
//! with no ship can browse, comment, and post.
//!
//! The engine reads page content, public folder/comment/title lists, and
//! lattice forum and furum boards (`boards`, read calls only), and makes
//! two writes, each as the comet itself: a comment on a published page,
//! poked to the publisher's `comments.sig`, and a post or reply on a
//! public lattice forum board, poked to the host's forum inbox
//! (`forum_write`). It never votes, publishes, writes to a furum board,
//! or acts as the user's ship. Every request it makes goes through
//! `submit_read`, `submit_board`, `submit_comment`, `submit_forum_write`,
//! `submit_open_list`, `submit_thread`, or `submit_dir_index`, and a test
//! reads this file's own source to hold it to that
//! (`only_reads_and_comments_are_submitted`).
//!
//! State lives in `<config>/lattice-rune/urb/` (0700), opened as
//! urb-fetch's gateways open theirs (`urb_gateway::state::find`):
//! `comet.key` (0600, mined the first time, over HTTPS to
//! bootstrap.urbit.org), `<comet>.db` (libmesa's SQLite store) and
//! `<comet>.db.port` (the UDP port the identity keeps, since publishers
//! answer the address they last saw). One comet for this app on this
//! machine: every new comet leaves a record on each ship it reads, so it
//! is never remade for a run, a test or a window. It is not the desktop
//! app's comet: two programs cannot hold one store.
//!
//! Nothing starts until something asks for a read.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use urb_engine::core::{ForumCall, FurumCall};
use urb_engine::host::net::{Log, NetIo, libmesa_log, random};
use urb_engine::host::{Event, Host};
use urb_engine::js::{self, Js};
use urb_engine::url::{Mount, PEER_BASES, de_urb};
use urb_engine::{Failure, Int, Reply, Request, Value};
use urb_gateway::state::{self, GatewayUdp};

/// A body larger than this is refused, so a hostile publisher cannot
/// balloon the app.
pub const MAX_BODY: usize = 4 * 1024 * 1024;
/// A start that failed is not tried again for this long.
pub const RETRY_AFTER: Duration = Duration::from_secs(5);
/// How long a read may take once the engine runs.
pub const BUDGET: Duration = Duration::from_secs(45);
/// How long a side peek (titles, comments, threads, forum-comets) may wait.
pub const PEEK_BUDGET: Duration = Duration::from_secs(6);
/// How long a comet comment or forum write may wait for an answer.
pub const COMMENT_BUDGET: Duration = Duration::from_secs(20);
/// How long the engine may take to start before a read gives up on it. The first start makes the
/// comet, which is not the ship's being away and is not counted against the read.
pub const BOOT: Duration = Duration::from_secs(120);
/// How long a publisher may take over a small grub (`/pub/comments`) before the peek gives up.
const PEEK_WAIT_MS: u64 = 4_000;
/// Maximum size of a `/pub/*` cord the reader will parse.
pub const THREAD_MAX: usize = 1024 * 1024;
/// Caps for a comet forum post/reply (matching `desktop/src/boards.rs`).
pub const FORUM_TITLE_MAX: usize = 300;
pub const FORUM_LINK_MAX: usize = 2048;
pub const FORUM_TEXT_MAX: usize = 10_000;
/// Cap for a comet page comment.
pub const COMMENT_MAX: usize = 4_000;

/// A page as the engine read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativePage {
    /// its key in the publisher's vault
    pub key: String,
    pub body: String,
    /// the mark it was published under (`gmi` when it had none)
    pub mark: String,
}

/// Why a read gave no page, in words to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadError {
    /// the ship answered and has no such page for us: unpublished, or
    /// private to ships the comet is not
    NotPublished(String),
    /// no answer
    Unreachable(String),
    /// another copy of the app holds the engine's store
    Busy,
    Failed(String),
}

impl ReadError {
    pub fn words(&self) -> String {
        match self {
            ReadError::NotPublished(w) | ReadError::Unreachable(w) | ReadError::Failed(w) => w.clone(),
            ReadError::Busy => "Another lattice-rune on this computer is using the reader. Close it and try again.".into(),
        }
    }
}

/// Why a comment or forum write did not go through.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommentError {
    /// the publisher answered and refused the poke
    Refused(String),
    /// no answer within the budget
    Unanswered(String),
    /// the engine could not send it
    Failed(String),
}

impl CommentError {
    pub fn words(&self) -> String {
        match self {
            CommentError::Refused(w) => format!("Refused: {w}"),
            CommentError::Unanswered(w) => format!("No answer from the ship: {w}"),
            CommentError::Failed(w) => w.clone(),
        }
    }
}

/// One comment from a page's public comment list (`/pub/thread/<page>/list`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PubComment {
    pub id: String,
    pub author: String,
    /// unix milliseconds (0 when absent)
    pub when: i64,
    pub body: String,
}

/// One page from a publisher's `/pub/titles` or a granted folder's `dir-index`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageTitle {
    pub key: String,
    pub secs: i64,
    pub title: String,
}

/// What a peek at a granted folder's `dir-index` gave.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DirIndex {
    Got(Vec<PageTitle>),
    Refused,
    Silent,
}

/// What a publisher does with comets' comments on a page (`/pub/comets`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CometMode {
    #[default]
    Open,
    /// taken, but reviewed before they appear
    Held,
    /// not taken
    Off,
}

/// A page's comet policy: its mode, and the unix second until which it is
/// at its cap of comet comments, when it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Comets {
    pub mode: CometMode,
    pub full_until: Option<u64>,
}

/// A publisher's comment settings: which pages take comments (`/pub/comments`)
/// and per-page comet policies (`/pub/comets`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Opened {
    pub names: Vec<String>,
    /// `None` when `/pub/comets` could not be read; `Some(vec![])` for older lattice.
    pub comets: Option<Vec<(String, Comets)>>,
}

/// A read of a board: lattice forum or furum.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BoardAsk {
    Forum { host: String, board: String },
    ForumThread { host: String, board: String, post: Int },
    FurumPosts { host: String, board: String },
    FurumComments { host: String, board: String, post: u64 },
}

/// A write on a lattice forum board: a new post or a reply in a thread. Never a vote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ForumWrite {
    Post { board: String, title: String, url: Option<String>, body: Option<String> },
    Reply { board: String, post: Int, parent: Option<Int>, body: String },
}

/// Which app keeps a remote board address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoardApp {
    Forum,
    Furum,
}

/// A parsed `urb://` address for a lattice forum or furum board/thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardPlace {
    pub app: BoardApp,
    pub host: String,
    pub board: String,
    /// post id as decimal digits (undotted)
    pub post: Option<String>,
}

impl BoardPlace {
    pub fn prefix(&self) -> &'static str {
        match self.app {
            BoardApp::Forum => "forum",
            BoardApp::Furum => "furum",
        }
    }

    pub fn board_url(&self) -> String {
        format!("urb://{}/{}/{}", self.host, self.prefix(), self.board)
    }

    pub fn thread_url(&self, id: &str) -> String {
        match self.app {
            BoardApp::Forum => format!("{}/{}", self.board_url(), dotted(id)),
            BoardApp::Furum => format!("{}/{id}", self.board_url()),
        }
    }

    pub fn url(&self) -> String {
        match &self.post {
            Some(id) => self.thread_url(id),
            None => self.board_url(),
        }
    }

    /// Key used by `api::Board.board` / `api::Thread.board`.
    pub fn board_key(&self) -> String {
        match self.app {
            BoardApp::Forum => format!("{}/{}", self.host, self.board),
            BoardApp::Furum => format!("{}/furum/{}", self.host, self.board),
        }
    }
}

/// Where the engine is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Off,
    Booting,
    Ready { our: String },
    Closing,
    Failed(String),
}

type Answer = Sender<Result<NativePage, ReadError>>;
type Told = Sender<Result<Js, ReadError>>;
type Said = Sender<Result<(), CommentError>>;
type Cord = Sender<Result<Option<String>, String>>;

struct Comment {
    ship: String,
    base: &'static str,
    page: String,
    body: String,
}

/// what callers hand the host's thread
enum Job {
    Read(String, Answer),
    Expire(String),
    Pages(String, Sender<Option<Vec<String>>>),
    Comment(Comment, Said),
    OpenList(String, &'static str, List, Cord),
    Thread(String, &'static str, String, Cord),
    DirIndex(String, &'static str, String, Cord),
    ForumWrite(String, ForumWrite, Said),
    Board(BoardAsk, Told),
    Close,
}

/// what the host's thread waits on
enum Wait {
    Read(Answer, String),
    Comment(Said, &'static str),
    OpenList(Cord),
    Board(Told),
}

struct Running {
    jobs: Sender<Job>,
    waker: Option<Sender<Event>>,
}

struct Inner {
    status: Status,
    failed_at: Option<Instant>,
    /// what a start is doing, in words
    step: &'static str,
    run: Option<Running>,
    /// Waiters notified once the host thread has exited and closed its store.
    close_waiters: Vec<Sender<()>>,
}

/// Ensures `Inner` leaves `Closing`/`Booting`/`Ready` for `Off` and notifies any
/// close waiters when the host thread exits for any reason.
struct ExitGuard {
    inner: Arc<Mutex<Inner>>,
}

impl Drop for ExitGuard {
    fn drop(&mut self) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !matches!(g.status, Status::Failed(_)) {
            g.status = Status::Off;
        }
        g.run = None;
        for tx in g.close_waiters.drain(..) {
            let _ = tx.send(());
        }
    }
}

/// The engine, one for the app. A clone is the same engine.
#[derive(Clone)]
pub struct Engine {
    dir: PathBuf,
    /// a fake ship's name on a fake network (`urbit -F`), for tests: a
    /// fake network has no comets
    fake: Option<String>,
    inner: Arc<Mutex<Inner>>,
}

impl Engine {
    /// The engine for state in `dir`. Nothing is made on disk and no
    /// thread runs until the first read.
    ///
    /// A build for working on takes `LATTICE_ENGINE_FAKE=<ship>` to run as
    /// that ship on a fake network (`new-moon-of:~ship` for a moon of its
    /// own), so a check can read a fake ship. A release build does not read it.
    pub fn new(dir: PathBuf) -> Engine {
        let fake = cfg!(debug_assertions).then(|| std::env::var("LATTICE_ENGINE_FAKE").ok()).flatten().filter(|f| !f.is_empty());
        Engine { dir, fake, inner: Arc::new(Mutex::new(Inner { status: Status::Off, failed_at: None, step: "", run: None, close_waiters: Vec::new() })) }
    }

    pub fn status(&self) -> Status {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).status.clone()
    }

    /// What a start in progress is doing. Empty when not starting.
    pub fn step(&self) -> &'static str {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.status == Status::Booting { g.step } else { "" }
    }

    /// The name the engine runs as, once it runs.
    pub fn our(&self) -> Option<String> {
        match self.status() {
            Status::Ready { our } => Some(our),
            _ => None,
        }
    }

    /// Starts the host's thread unless it runs, is starting, or is still closing.
    pub fn start(&self) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(g.status, Status::Booting | Status::Ready { .. } | Status::Closing) {
            return;
        }
        if matches!(g.status, Status::Failed(_)) && g.failed_at.is_some_and(|t| t.elapsed() < RETRY_AFTER) {
            return;
        }
        let (jobs_tx, jobs_rx) = channel::<Job>();
        g.status = Status::Booting;
        g.step = "Starting";
        g.run = Some(Running { jobs: jobs_tx, waker: None });
        drop(g);
        let (dir, fake, inner) = (self.dir.clone(), self.fake.clone(), self.inner.clone());
        let spawned = std::thread::Builder::new().name("urb-engine".into()).spawn(move || {
            let _exit = ExitGuard { inner: inner.clone() };
            // a panic in the engine is a failed start, said and tried again, not a reader that waits for ever
            let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| host_thread(&dir, fake.as_deref(), &inner, jobs_rx)));
            if ran.is_err() {
                let mut g = inner.lock().unwrap_or_else(|e| e.into_inner());
                if g.status != Status::Closing {
                    g.status = Status::Failed("the reader stopped unexpectedly".into());
                    g.failed_at = Some(Instant::now());
                }
                g.run = None;
            }
        });
        if let Err(e) = spawned {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.status = Status::Failed(format!("no thread for the reader: {e}"));
            g.failed_at = Some(Instant::now());
            g.run = None;
            for tx in g.close_waiters.drain(..) {
                let _ = tx.send(());
            }
        }
    }

    /// Reads `url` (an urb:// address), waiting at most `budget`. The
    /// caller is a worker's thread, never the window's.
    pub fn read(&self, url: &str, budget: Duration) -> Result<NativePage, ReadError> {
        self.start();
        let (tx, rx) = channel();
        {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Status::Failed(m) = &g.status {
                return Err(boot_error(m));
            }
            if g.status == Status::Closing {
                return Err(ReadError::Failed("the reader is closing".into()));
            }
            let Some(run) = &g.run else { return Err(ReadError::Failed("the reader stopped".into())) };
            if run.jobs.send(Job::Read(url.to_string(), tx)).is_err() {
                return Err(ReadError::Failed("the reader stopped".into()));
            }
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
        self.wait_read(rx, budget)
    }

    /// Board reads (`BoardAsk`), sent together so they run at once, each
    /// waiting at most `budget` once the engine is ready. Starts the engine
    /// on first use, just as `read` does.
    pub fn boards(&self, asks: Vec<BoardAsk>, budget: Duration) -> Vec<Result<Js, ReadError>> {
        self.start();
        let mut rxs = Vec::with_capacity(asks.len());
        {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Status::Failed(m) = &g.status {
                let e = boot_error(m);
                return asks.iter().map(|_| Err(e.clone())).collect();
            }
            if g.status == Status::Closing {
                return asks.iter().map(|_| Err(ReadError::Failed("the reader is closing".into()))).collect();
            }
            let Some(run) = &g.run else {
                return asks.iter().map(|_| Err(ReadError::Failed("the reader stopped".into()))).collect();
            };
            for a in asks {
                let (tx, rx) = channel();
                let _ = run.jobs.send(Job::Board(a, tx));
                rxs.push(rx);
            }
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
        let began = Instant::now();
        let mut ready_at: Option<Instant> = None;
        rxs.into_iter().map(|rx| self.wait_read_from(rx, budget, began, &mut ready_at)).collect()
    }

    fn wait_read<T>(&self, rx: Receiver<Result<T, ReadError>>, budget: Duration) -> Result<T, ReadError> {
        let mut ready_at = None;
        self.wait_read_from(rx, budget, Instant::now(), &mut ready_at)
    }

    fn wait_read_from<T>(&self, rx: Receiver<Result<T, ReadError>>, budget: Duration, began: Instant, ready_at: &mut Option<Instant>) -> Result<T, ReadError> {
        let slice = Duration::from_millis(250);
        loop {
            match rx.recv_timeout(slice) {
                Ok(r) => return r,
                Err(RecvTimeoutError::Timeout) => match self.status() {
                    Status::Booting if began.elapsed() > BOOT => return Err(ReadError::Failed("The reader is taking too long to start. Check your connection and try again.".into())),
                    Status::Booting => {}
                    Status::Closing => return Err(ReadError::Failed("the reader is closing".into())),
                    _ if ready_at.get_or_insert_with(Instant::now).elapsed() > budget => {
                        return Err(ReadError::Unreachable(format!("No answer within {} seconds. The ship may be away: try again.", budget.as_secs())));
                    }
                    _ => {}
                },
                Err(RecvTimeoutError::Disconnected) => {
                    return match self.status() {
                        Status::Failed(m) => Err(boot_error(&m)),
                        _ => Err(ReadError::Failed("the reader stopped".into())),
                    };
                }
            }
        }
    }

    /// Ages the cached revision list for `url`'s ship so the next read asks the publisher afresh.
    pub fn expire(&self, url: &str) {
        let Ok(u) = de_urb(url) else { return };
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(run) = g.run.as_ref().filter(|_| matches!(g.status, Status::Ready { .. })) else { return };
        if run.jobs.send(Job::Expire(u.ship)).is_ok() {
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
    }

    /// The page keys named in the cached revision list for `ship`.
    pub fn pages(&self, ship: &str) -> Option<Vec<String>> {
        let (tx, rx) = channel();
        {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !matches!(g.status, Status::Ready { .. }) {
                return None;
            }
            let run = g.run.as_ref()?;
            run.jobs.send(Job::Pages(ship.into(), tx)).ok()?;
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
        rx.recv_timeout(Duration::from_secs(2)).ok()?
    }

    /// Published pages of `ship` with their times and titles (`/pub/titles`).
    pub fn titles(&self, ship: &str, budget: Duration) -> Option<Vec<PageTitle>> {
        self.peek_bases(budget, |base, tx| Job::OpenList(ship.into(), base, List::Titles, tx)).map(|c| page_titles(&c))
    }

    /// Granted folder's `dir-index` under `/page/<folder>`.
    pub fn dir_index(&self, ship: &str, folder: &str, budget: Duration) -> DirIndex {
        let Some(folder) = thread_page(folder) else { return DirIndex::Refused };
        let start = Instant::now();
        for base in PEER_BASES {
            let left = budget.saturating_sub(start.elapsed());
            if left.is_zero() {
                return DirIndex::Silent;
            }
            let (tx, rx) = channel();
            {
                let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                if !matches!(g.status, Status::Ready { .. }) {
                    return DirIndex::Silent;
                }
                let Some(run) = g.run.as_ref() else { return DirIndex::Silent };
                if run.jobs.send(Job::DirIndex(ship.into(), base, folder.clone(), tx)).is_err() {
                    return DirIndex::Silent;
                }
                if let Some(w) = &run.waker {
                    let _ = w.send(Event::Wake);
                }
            }
            match rx.recv_timeout(left) {
                Ok(Ok(Some(cord))) => return DirIndex::Got(page_titles(&cord)),
                Ok(Ok(None)) | Ok(Err(_)) => {}
                Err(_) => return DirIndex::Silent,
            }
        }
        DirIndex::Refused
    }

    /// Pages of `ship` that take comments (`/pub/comments`) and their comet policies (`/pub/comets`).
    pub fn comments_open(&self, ship: &str, budget: Duration) -> Option<Opened> {
        let start = Instant::now();
        for base in PEER_BASES {
            let left = budget.saturating_sub(start.elapsed());
            if left.is_zero() {
                return None;
            }
            let (tx, rx) = channel();
            let (ctx, crx) = channel();
            {
                let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                if !matches!(g.status, Status::Ready { .. }) {
                    return None;
                }
                let run = g.run.as_ref()?;
                run.jobs.send(Job::OpenList(ship.into(), base, List::Comments, tx)).ok()?;
                run.jobs.send(Job::OpenList(ship.into(), base, List::Comets, ctx)).ok()?;
                if let Some(w) = &run.waker {
                    let _ = w.send(Event::Wake);
                }
            }
            match rx.recv_timeout(left) {
                Ok(Ok(Some(cord))) => {
                    let left = budget.saturating_sub(start.elapsed());
                    let comets = match crx.recv_timeout(left) {
                        Ok(Ok(Some(c))) => Some(comet_policies(&c)),
                        Ok(Ok(None)) => Some(Vec::new()),
                        _ => None,
                    };
                    return Some(Opened { names: open_names(&cord), comets });
                }
                Ok(Ok(None)) | Ok(Err(_)) => {}
                Err(_) => return None,
            }
        }
        None
    }

    /// Pages of `ship` with a public comment list (`/pub/threads`).
    pub fn threads(&self, ship: &str, budget: Duration) -> Option<Vec<String>> {
        self.peek_bases(budget, |base, tx| Job::OpenList(ship.into(), base, List::Threads, tx)).map(|c| open_names(&c))
    }

    /// Public comment list for `page` of `ship` (`/pub/thread/<page>/list`).
    pub fn thread(&self, ship: &str, page: &str, budget: Duration) -> Option<Vec<PubComment>> {
        let page = thread_page(page)?;
        self.peek_bases(budget, |base, tx| Job::Thread(ship.into(), base, page.clone(), tx)).map(|c| thread_list(&c))
    }

    /// Forum boards on `host` that accept comet posts (`/pub/forum-comets`).
    pub fn forum_open(&self, host: &str, budget: Duration) -> Option<Vec<String>> {
        self.peek_bases(budget, |base, tx| Job::OpenList(host.into(), base, List::ForumComets, tx)).map(|c| open_names(&c))
    }

    /// Comment on a published page as the reader identity (`%comment-action` poked to `comments.sig`).
    pub fn comment(&self, ship: &str, page: &str, body: &str, budget: Duration) -> Result<(), CommentError> {
        let start = Instant::now();
        let mut first = None;
        for base in PEER_BASES {
            let left = budget.saturating_sub(start.elapsed()).max(Duration::from_secs(1));
            let c = Comment { ship: ship.into(), base, page: page.into(), body: body.into() };
            match self.comment_at(c, left) {
                Ok(()) => return Ok(()),
                Err(CommentError::Refused(w)) => {
                    first.get_or_insert(CommentError::Refused(w));
                }
                Err(e) => return Err(first.unwrap_or(e)),
            }
        }
        Err(first.unwrap_or_else(|| CommentError::Failed("no lattice base".into())))
    }

    fn comment_at(&self, c: Comment, budget: Duration) -> Result<(), CommentError> {
        let (tx, rx) = channel();
        {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !matches!(g.status, Status::Ready { .. }) {
                return Err(CommentError::Failed("the reader isn't ready yet".into()));
            }
            let Some(run) = &g.run else { return Err(CommentError::Failed("the reader stopped".into())) };
            if run.jobs.send(Job::Comment(c, tx)).is_err() {
                return Err(CommentError::Failed("the reader stopped".into()));
            }
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
        match rx.recv_timeout(budget) {
            Ok(r) => r,
            Err(RecvTimeoutError::Timeout) => Err(CommentError::Unanswered(format!("no answer within {}s", budget.as_secs()))),
            Err(RecvTimeoutError::Disconnected) => Err(CommentError::Failed("the reader stopped".into())),
        }
    }

    /// Post or reply on a lattice forum board as the reader identity.
    pub fn forum_write(&self, host: &str, w: ForumWrite, budget: Duration) -> Result<(), CommentError> {
        let (tx, rx) = channel();
        {
            let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !matches!(g.status, Status::Ready { .. }) {
                return Err(CommentError::Failed("the reader isn't ready yet".into()));
            }
            let Some(run) = &g.run else { return Err(CommentError::Failed("the reader stopped".into())) };
            if run.jobs.send(Job::ForumWrite(host.into(), w, tx)).is_err() {
                return Err(CommentError::Failed("the reader stopped".into()));
            }
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
        match rx.recv_timeout(budget) {
            Ok(r) => r,
            Err(RecvTimeoutError::Timeout) => Err(CommentError::Unanswered(format!("no answer within {}s", budget.as_secs()))),
            Err(RecvTimeoutError::Disconnected) => Err(CommentError::Failed("the reader stopped".into())),
        }
    }

    fn peek_bases(&self, budget: Duration, job: impl Fn(&'static str, Cord) -> Job) -> Option<String> {
        let start = Instant::now();
        for base in PEER_BASES {
            let left = budget.saturating_sub(start.elapsed());
            if left.is_zero() {
                return None;
            }
            let (tx, rx) = channel();
            {
                let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                if !matches!(g.status, Status::Ready { .. }) {
                    return None;
                }
                let run = g.run.as_ref()?;
                run.jobs.send(job(base, tx)).ok()?;
                if let Some(w) = &run.waker {
                    let _ = w.send(Event::Wake);
                }
            }
            match rx.recv_timeout(left) {
                Ok(Ok(Some(cord))) => return Some(cord),
                Ok(Ok(None)) | Ok(Err(_)) => {}
                Err(_) => return None,
            }
        }
        None
    }

    fn begin_close(&self, waiter: Option<Sender<()>>) -> bool {
        let (already_off, run) = {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            match g.status {
                Status::Off | Status::Failed(_) if g.run.is_none() => (true, None),
                Status::Closing => {
                    if let Some(tx) = waiter {
                        g.close_waiters.push(tx);
                    }
                    (false, None)
                }
                _ => {
                    let run = g.run.take();
                    if run.is_none() {
                        g.status = Status::Off;
                        (true, None)
                    } else {
                        g.status = Status::Closing;
                        if let Some(tx) = waiter {
                            g.close_waiters.push(tx);
                        }
                        (false, run)
                    }
                }
            }
        };
        if let Some(run) = run {
            let _ = run.jobs.send(Job::Close);
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
        already_off
    }

    /// Signals the host thread to close its store and exit without blocking the caller.
    /// Returns `true` if the engine is already stopped, or `false` while it holds `Status::Closing`
    /// until the host thread actually exits.
    pub fn close(&self) -> bool {
        self.begin_close(None)
    }

    /// Closes the store and waits up to `timeout` for the host thread to exit. Returns `false`
    /// when it did not stop in that time; the engine stays in `Status::Closing` until the thread
    /// exits so no concurrent `start()` can open the same store.
    pub fn close_wait(&self, timeout: Duration) -> bool {
        let (tx, rx) = channel();
        if self.begin_close(Some(tx)) {
            return true;
        }
        rx.recv_timeout(timeout).is_ok()
    }

    /// The identity this computer has: the one running, or the one its keyfile names. `None` before
    /// one is made. A fake identity has no file to move, so it is not named here.
    pub fn identity(&self) -> Option<String> {
        if self.fake.is_some() {
            return None;
        }
        self.our().or_else(|| comet_of_keyfile(std::fs::read_to_string(self.dir.join("comet.key")).ok()?.trim()))
    }

    /// Whether an export of the identity here has been made.
    pub fn exported(&self) -> bool {
        self.dir.join("comet.key").exists() && crate::cometid::exported_at(&self.dir).is_some()
    }

    /// Where the identity's files are.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Closed for a move of the identity: refused while a start is in progress (it may be mining
    /// or opening the store) and for a fake ship. True when it was running, to start it again after.
    fn close_for_move(&self) -> Result<bool, String> {
        if self.fake.is_some() {
            return Err("a fake test identity cannot be moved".into());
        }
        let was = match self.status() {
            Status::Booting => return Err("The anonymous identity is still starting. Try again in a moment.".into()),
            Status::Closing => return Err("The anonymous identity is still closing. Try again in a moment.".into()),
            Status::Ready { .. } => true,
            _ => false,
        };
        if !self.close_wait(Duration::from_secs(5)) {
            return Err("The anonymous identity did not stop in time. Try again in a moment.".into());
        }
        Ok(was)
    }

    /// The identity, for an export file: the engine closed first, so the store is copied whole,
    /// and started again after if it ran.
    pub fn export_identity(&self) -> Result<crate::cometid::Identity, String> {
        let was = self.close_for_move()?;
        let got = crate::cometid::read_dir(&self.dir, comet_of_keyfile);
        if was {
            self.start();
        }
        got
    }

    /// Makes `id` (from an export file) the reader identity, in place of whatever was here, which
    /// is moved aside and never deleted (`cometid::install`). The engine is closed for it and
    /// started again as the new identity if it ran: an engine that was off starts at the next read,
    /// as it always does. `Some(folder)` names where the old one went.
    pub fn import_identity(&self, id: &crate::cometid::Identity) -> Result<Option<PathBuf>, String> {
        if comet_of_keyfile(&id.keyfile).as_deref() != Some(id.ship.as_str()) {
            return Err("That identity file does not hold an anonymous identity.".into());
        }
        let was = self.close_for_move()?;
        let aside = crate::cometid::install(&self.dir, id)?;
        {
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.failed_at = None;
            if matches!(g.status, Status::Failed(_)) {
                g.status = Status::Off;
            }
        }
        if let Some(a) = &aside {
            log_line(&format!("identity replaced by {}, the old one kept in {}", id.ship, a.display()));
        }
        if was {
            self.start();
        }
        Ok(aside)
    }
}

/// The comet a keyfile names, or `None` when it is not a comet's keyfile (a comet is the one rank
/// wider than 64 bits).
pub fn comet_of_keyfile(text: &str) -> Option<String> {
    let (ship, _, _) = urb_engine::engine::keyfile_ship(text)?;
    (ship.1 != 0).then(|| urb_engine::engine::ship_text(ship))
}

fn make_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // an existing folder made looser by hand is tightened again
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| format!("{}: {e}", dir.display()))
}

/// The engine's own words go to stderr when `LATTICE_LOG` is set, as the desktop app's do.
fn log_line(l: &str) {
    if std::env::var_os("LATTICE_LOG").is_some() {
        eprintln!("engine: {l}");
    }
}

/// A fake ship's name: as given, or, for `new-moon-of:~ship`, a moon of
/// that ship made once and kept in the folder.
fn fake_name(dir: &Path, fake: &str) -> Result<String, String> {
    let Some(parent) = fake.strip_prefix("new-moon-of:") else { return Ok(fake.to_string()) };
    let kept = dir.join("fake-moon");
    if let Ok(name) = std::fs::read_to_string(&kept) {
        return Ok(name.trim().to_string());
    }
    let (lo, hi) = urb_engine::engine::ship_parse(parent).ok_or_else(|| format!("not a ship: {parent}"))?;
    if hi != 0 || lo >> 32 != 0 {
        return Err(format!("{parent} has no moons"));
    }
    let r = random(4);
    let high = u32::from_be_bytes([r[0], r[1], r[2], r[3]]).max(1) as u64;
    let name = urb_engine::engine::ship_text(((high << 32) | lo, 0));
    std::fs::write(&kept, format!("{name}\n")).map_err(|e| format!("{}: {e}", kept.display()))?;
    Ok(name)
}

/// The host's thread: find or mine the identity, open it, then take jobs
/// and turn the host until closed.
fn host_thread(dir: &Path, fake: Option<&str>, inner: &Arc<Mutex<Inner>>, jobs: Receiver<Job>) {
    let fail = |m: String| {
        log_line(&format!("start failed: {m}"));
        let mut g = inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.status != Status::Closing {
            g.status = Status::Failed(m);
            g.failed_at = Some(Instant::now());
        }
        g.run = None;
    };
    let closing = || inner.lock().unwrap_or_else(|e| e.into_inner()).status == Status::Closing;
    if closing() {
        return;
    }
    if let Err(e) = make_dir(dir) {
        return fail(e);
    }
    let log: Log = Arc::new(log_line);
    libmesa_log(log.clone());
    let step = |w: &'static str| inner.lock().unwrap_or_else(|e| e.into_inner()).step = w;
    if fake.is_none() && !dir.join("comet.key").exists() {
        step("Setting up this computer");
    }
    let fake = match fake.map(|f| fake_name(dir, f)).transpose() {
        Ok(f) => f,
        Err(e) => return fail(e),
    };
    let fake = fake.as_deref();
    if closing() {
        return;
    }
    let found = match find_state(dir, fake.unwrap_or("")) {
        Ok(f) => f,
        // another copy holding the store is said as that. Anything else that could not be mended says where the files are
        Err(e) if e.ends_with("is in use by another process") => return fail(e),
        Err(e) => return fail(format!("{e}. Its files are in {}: move that folder aside to start again with a new identity", dir.display())),
    };
    if closing() {
        return;
    }
    let udp = GatewayUdp { fake: fake.is_some(), port: found.port, log: log.clone(), udp: None };
    let io = NetIo::new(Box::new(udp), Box::new(found.store), log);
    let waker = io.waker();
    if let Some(run) = &mut inner.lock().unwrap_or_else(|e| e.into_inner()).run {
        run.waker = Some(waker);
    }
    step("Joining the Urbit network");
    let mut host = Host::new(io, random);
    if fake.is_none() {
        // ships' keys already looked up, kept between runs, as the desktop app keeps them
        host.set_keys(std::rc::Rc::new(urb_engine::host::keys::FileKeys::new(dir.join("keys"))) as _);
    }
    let our = match host.open(fake.is_some()) {
        Ok(o) => o,
        Err(f) => return fail(f.message),
    };
    log_line(&format!("running as {our}"));
    {
        let mut g = inner.lock().unwrap_or_else(|e| e.into_inner());
        // closed while it was starting: it does not come up as ready with nobody to hand it work
        if g.status == Status::Closing || g.run.is_none() {
            drop(g);
            let _ = host.close();
            return;
        }
        g.status = Status::Ready { our };
    }
    let mut pending: Vec<(u64, Wait, Instant)> = Vec::new();
    loop {
        loop {
            match jobs.try_recv() {
                Ok(Job::Read(url, tx)) => pending.push((submit_read(&mut host, url.clone()), Wait::Read(tx, url), Instant::now())),
                Ok(Job::Pages(ship, tx)) => {
                    let _ = tx.send(host.core().cached_revs(&ship).map(|l| l.into_iter().map(|(k, _)| k).collect()));
                }
                Ok(Job::Expire(ship)) => {
                    log_line(&format!("expire the revision list of {ship}"));
                    host.core().expire_revs(&ship);
                }
                Ok(Job::Comment(c, tx)) => {
                    log_line(&format!("comment to {} on {} at {}", c.ship, c.page, c.base));
                    pending.push((submit_comment(&mut host, c), Wait::Comment(tx, "comment"), Instant::now()));
                }
                Ok(Job::OpenList(ship, base, list, tx)) => {
                    pending.push((submit_open_list(&mut host, ship, base, list), Wait::OpenList(tx), Instant::now()));
                }
                Ok(Job::Thread(ship, base, page, tx)) => {
                    pending.push((submit_thread(&mut host, ship, base, &page), Wait::OpenList(tx), Instant::now()));
                }
                Ok(Job::DirIndex(ship, base, folder, tx)) => {
                    pending.push((submit_dir_index(&mut host, ship, base, &folder), Wait::OpenList(tx), Instant::now()));
                }
                Ok(Job::ForumWrite(to, w, tx)) => {
                    log_line(&format!("forum write to {to}"));
                    pending.push((submit_forum_write(&mut host, to, w), Wait::Comment(tx, "forum write"), Instant::now()));
                }
                Ok(Job::Board(a, tx)) => {
                    log_line(&format!("board read {a:?}"));
                    pending.push((submit_board(&mut host, a), Wait::Board(tx), Instant::now()));
                }
                Ok(Job::Close) => {
                    let _ = host.close();
                    drop(host);
                    return;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                // every Engine is gone: close as a Close would
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    let _ = host.close();
                    return;
                }
            }
        }
        pending.retain(|(id, wait, at)| match host.take(*id) {
            Some(r) => {
                match wait {
                    Wait::Read(tx, url) => {
                        log_line(&format!("read {url} in {} ms", at.elapsed().as_millis()));
                        let _ = tx.send(result_of(r));
                    }
                    Wait::Board(tx) => {
                        let got = board_of(r);
                        log_line(&format!("board read in {} ms: {}", at.elapsed().as_millis(), got.is_ok()));
                        let _ = tx.send(got);
                    }
                    Wait::Comment(tx, what) => {
                        let got = said_of(r);
                        log_line(&format!("{what} in {} ms: {got:?}", at.elapsed().as_millis()));
                        let _ = tx.send(got);
                    }
                    Wait::OpenList(tx) => {
                        let got = cord_of(r);
                        log_line(&format!("peek in {} ms: {}", at.elapsed().as_millis(), if got.is_ok() { "ok" } else { "failed" }));
                        let _ = tx.send(got);
                    }
                }
                false
            }
            None => true,
        });
        host.turn();
    }
}

/// `state::find`, and when a file in the folder is damaged (a keyfile cut short by a crash while
/// it was mined, a store SQLite cannot open, a port file that is not a number), the damage set
/// aside and one more try, as the desktop app's engine does. A damaged port costs only the port,
/// and the identity is kept. A damaged keyfile or store costs the identity: the keyfile and every
/// store in the folder go into `damaged-<ms>/`, never deleted, and a new comet is made. A store
/// held by another copy of the app is not damage and is left alone.
fn find_state(dir: &Path, fake: &str) -> Result<state::Found, String> {
    let e = match state::find(dir, "", false, fake) {
        Ok(f) => return Ok(f),
        Err(e) => e,
    };
    let what = damage(&e);
    if what == Damage::None {
        return Err(e);
    }
    log_line(&format!("state damaged ({e}), setting it aside"));
    set_aside(dir, what)?;
    state::find(dir, "", false, fake)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Damage {
    None,
    /// a `.db.port` file that is not a port
    Port,
    /// the keyfile or a store
    Identity,
}

/// What a `state::find` failure says is damaged, by urb-gateway's and libmesa's own words.
fn damage(e: &str) -> Damage {
    if e.ends_with("is in use by another process") || e.ends_with("can't open lockfile") {
        Damage::None
    } else if e.starts_with("strconv.Atoi: parsing") || e.starts_with("invalid port") {
        Damage::Port
    } else if e.ends_with(": mesa: not a keyfile") || e.ends_with(": can't open database") || e.ends_with(": can't initialize database") || e.ends_with(": can't prepare statements") {
        Damage::Identity
    } else {
        Damage::None
    }
}

/// Moves the damaged files out of the way, into a folder of their own beside them.
fn set_aside(dir: &Path, what: Damage) -> Result<(), String> {
    let names: Vec<String> = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten().filter_map(|e| e.file_name().into_string().ok()).collect();
    let gone = |n: &str| match what {
        Damage::Port => n.ends_with(".db.port"),
        // with the identity goes what was said of it: that it was exported, and which posts were its own. Left behind, the new one made in its place would be said to have been exported
        Damage::Identity => n == "comet.key" || n == "exported" || n == "my-posts.json" || [".db", ".db-wal", ".db-shm", ".db.port"].iter().any(|x| n.ends_with(x)),
        Damage::None => false,
    };
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let aside = dir.join(format!("damaged-{stamp}"));
    for n in names.iter().filter(|n| gone(n)) {
        // a port file that reads as a port is not the damaged one
        if what == Damage::Port && std::fs::read_to_string(dir.join(n)).is_ok_and(|t| t.trim().parse::<u16>().is_ok()) {
            continue;
        }
        std::fs::create_dir_all(&aside).map_err(|e| format!("{}: {e}", aside.display()))?;
        std::fs::rename(dir.join(n), aside.join(n)).map_err(|e| format!("{n}: {e}"))?;
    }
    Ok(())
}

/// A read: page content.
fn submit_read<I: urb_engine::host::Io>(host: &mut Host<I>, url: String) -> u64 {
    host.submit(Request::Read(url))
}

/// A board read: only read calls of lattice's forum and furum readers.
fn submit_board<I: urb_engine::host::Io>(host: &mut Host<I>, a: BoardAsk) -> u64 {
    host.submit(match a {
        BoardAsk::Forum { host, board } => Request::Forum { host, call: ForumCall::Board(board) },
        BoardAsk::ForumThread { host, board, post } => Request::Forum {
            host,
            call: ForumCall::Thread(board, urb_engine::msg::Id::Big(false, post)),
        },
        BoardAsk::FurumPosts { host, board } => Request::Furum { host, call: FurumCall::Posts(board) },
        BoardAsk::FurumComments { host, board, post } => Request::Furum { host, call: FurumCall::Comments(board, post as f64) },
    })
}

/// A comment poked to the publisher's `comments.sig` inbox as `(/lattice, comment-action)`.
fn submit_comment<I: urb_engine::host::Io>(host: &mut Host<I>, c: Comment) -> u64 {
    host.submit(Request::Poke {
        ship: c.ship,
        folder: c.base.into(),
        name: "comments.sig".into(),
        mark: ("/lattice".into(), "comment-action".into()),
        value: comment_noun(&c.page, &c.body),
    })
}

/// A forum write: `NewPost` or `NewComment`, never a vote.
fn submit_forum_write<I: urb_engine::host::Io>(host: &mut Host<I>, to: String, w: ForumWrite) -> u64 {
    host.submit(Request::Forum { host: to, call: forum_call(w) })
}

fn forum_call(w: ForumWrite) -> ForumCall {
    let big = |i: Int| urb_engine::msg::Id::Big(false, i);
    match w {
        ForumWrite::Post { board, title, url, body } => ForumCall::NewPost { name: board, title: Some(title), url, body },
        ForumWrite::Reply { board, post, parent, body } => ForumCall::NewComment { name: board, post: big(post), body: Some(body), parent: parent.map(big) },
    }
}

/// The cords the engine peeks under `/pub`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum List {
    Comments,
    Comets,
    ForumComets,
    Threads,
    Titles,
}

impl List {
    fn name(self) -> &'static str {
        match self {
            List::Comments => "comments",
            List::Comets => "comets",
            List::ForumComets => "forum-comets",
            List::Threads => "threads",
            List::Titles => "titles",
        }
    }
}

fn submit_open_list<I: urb_engine::host::Io>(host: &mut Host<I>, ship: String, base: &str, list: List) -> u64 {
    host.submit(Request::Peek {
        ship,
        folder: format!("{base}/pub"),
        name: Some(list.name().into()),
        conv: urb_engine::core::Conv::Cord,
        wait: Some(PEEK_WAIT_MS),
    })
}

fn submit_thread<I: urb_engine::host::Io>(host: &mut Host<I>, ship: String, base: &str, page: &str) -> u64 {
    host.submit(Request::Peek {
        ship,
        folder: format!("{base}/pub/thread{page}"),
        name: Some("list".into()),
        conv: urb_engine::core::Conv::Cord,
        wait: Some(PEEK_WAIT_MS),
    })
}

fn submit_dir_index<I: urb_engine::host::Io>(host: &mut Host<I>, ship: String, base: &str, folder: &str) -> u64 {
    host.submit(Request::Peek {
        ship,
        folder: format!("{base}/page{folder}"),
        name: Some("dir-index".into()),
        conv: urb_engine::core::Conv::Cord,
        wait: Some(PEEK_WAIT_MS),
    })
}

/// lattice's `comment-action`: `[page=path body=@t]`.
fn comment_noun(page: &str, body: &str) -> Value<'static> {
    Value::Array(vec![urb_engine::codec::path(page), Value::Text(body.into())])
}

fn board_of(r: Result<Reply, Failure>) -> Result<Js, ReadError> {
    match r {
        Ok(Reply::Js(j)) => Ok(j),
        Ok(_) => Err(ReadError::Failed("the read gave no board".into())),
        Err(f) => Err(error_of(&f)),
    }
}

fn said_of(r: Result<Reply, Failure>) -> Result<(), CommentError> {
    match r {
        Ok(Reply::Poke(p)) if p.ok => Ok(()),
        Ok(Reply::Poke(p)) if p.later => Err(CommentError::Unanswered(p.error.unwrap_or_default())),
        Ok(Reply::Poke(p)) => Err(CommentError::Refused(p.error.unwrap_or_else(|| "refused".into()))),
        Ok(_) => Err(CommentError::Failed("the poke gave no answer".into())),
        Err(f) if f.later => Err(CommentError::Unanswered(f.message)),
        Err(f) => Err(CommentError::Failed(f.message)),
    }
}

fn cord_of(r: Result<Reply, Failure>) -> Result<Option<String>, String> {
    match r {
        Ok(Reply::Peek(urb_engine::core::Peeked::Text(t))) => Ok(Some(t)),
        Ok(Reply::Peek(urb_engine::core::Peeked::Null)) => Ok(None),
        Ok(_) => Err("the peek gave no text".into()),
        Err(f) => Err(f.message),
    }
}

fn result_of(r: Result<Reply, Failure>) -> Result<NativePage, ReadError> {
    match r {
        Ok(Reply::Read(p)) if p.body.len() > MAX_BODY => Err(ReadError::Failed(format!("The page is {} MB, over the reader's {} MB.", p.body.len() / (1024 * 1024), MAX_BODY / (1024 * 1024)))),
        Ok(Reply::Read(p)) => Ok(NativePage { key: p.key, mark: p.mark.unwrap_or_else(|| "gmi".into()), body: p.body }),
        Ok(_) => Err(ReadError::Failed("the read gave no page".into())),
        Err(f) => Err(error_of(&f)),
    }
}

/// A core failure, by the gateway's codes and words.
fn error_of(f: &Failure) -> ReadError {
    let (status, words) = urb_gateway::routes::fail_of(f);
    let words = String::from_utf8_lossy(&words).trim().to_owned();
    match status {
        404 => ReadError::NotPublished(words),
        504 => ReadError::Unreachable(words),
        _ if f.later => ReadError::Unreachable(words),
        _ => ReadError::Failed(words),
    }
}

/// Why the engine could not start, as a read's error.
fn boot_error(m: &str) -> ReadError {
    if m.ends_with("is in use by another process") { ReadError::Busy } else { ReadError::Failed(plain_boot(m)) }
}

/// A failed start in words for someone new to Urbit. The first start
/// fetches a list over HTTPS; with no connection that is what fails.
pub fn plain_boot(m: &str) -> String {
    if m.starts_with("Get \"") || m.starts_with("mesa: comet-stars") {
        "The reader couldn't reach the internet to set itself up. Check your connection and try again.".into()
    } else {
        format!("The reader couldn't start: {m}")
    }
}

// ------------------------------------------------------------ pure parsers & helpers

/// A page's key as the path under `/pub/thread` or `/page`: `/<seg>/<seg>...`.
pub fn thread_page(key: &str) -> Option<String> {
    let segs: Vec<&str> = key.trim_start_matches('/').split('/').collect();
    let ok = |s: &&str| !s.is_empty() && *s != "." && *s != ".." && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b));
    (segs.iter().all(ok)).then(|| format!("/{}", segs.join("/")))
}

/// Strict `@p` check matching `desktop::urb::is_patp`.
pub fn is_patp(s: &str) -> bool {
    s.starts_with('~') && s.bytes().all(|b| b == b'~' || b == b'-' || b.is_ascii_lowercase()) && urb_engine::engine::ship_parse(s).is_some()
}

/// A page's public comment list JSON (`{"v":1,"comments":[{"id","author","when","body"}]}`).
pub fn thread_list(cord: &str) -> Vec<PubComment> {
    if cord.len() > THREAD_MAX {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(cord) else { return Vec::new() };
    let Some(cs) = v.get("comments").and_then(|c| c.as_array()) else { return Vec::new() };
    cs.iter()
        .filter_map(|c| {
            let text = |k: &str| c.get(k).and_then(|x| x.as_str()).map(String::from);
            Some(PubComment {
                id: text("id").unwrap_or_default(),
                author: text("author").filter(|a| is_patp(a))?,
                when: c.get("when").and_then(|w| w.as_i64().or_else(|| w.as_f64().map(|f| f as i64))).unwrap_or(0),
                body: text("body")?,
            })
        })
        .collect()
}

/// `/pub/comments`, `/pub/threads`, or `/pub/forum-comets`: one name per line.
pub fn open_names(cord: &str) -> Vec<String> {
    if cord.len() > THREAD_MAX {
        return Vec::new();
    }
    cord.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

/// `/pub/titles` or `dir-index`: `<key>\t<unix-seconds>\t<title>`.
pub fn page_titles(cord: &str) -> Vec<PageTitle> {
    if cord.len() > THREAD_MAX {
        return Vec::new();
    }
    cord.lines()
        .filter_map(|l| {
            let l = l.strip_suffix('\r').unwrap_or(l);
            let mut f = l.split('\t');
            let (key, secs, title) = (f.next()?, f.next()?, f.next()?);
            if f.next().is_some() || !key.starts_with('/') {
                return None;
            }
            Some(PageTitle { key: key.into(), secs: secs.parse().ok()?, title: title.into() })
        })
        .collect()
}

/// `/pub/comets`: `<name> <mode>` or `<name> <mode> <until>`.
pub fn comet_policies(cord: &str) -> Vec<(String, Comets)> {
    if cord.len() > THREAD_MAX {
        return Vec::new();
    }
    cord.lines()
        .filter_map(|l| {
            let t: Vec<&str> = l.split_whitespace().collect();
            let (name, mode, until) = match t.as_slice() {
                [n, m] => (*n, *m, None),
                [n, m, u] => (*n, *m, Some(u.parse::<u64>().ok()?)),
                _ => return None,
            };
            let mode = match mode {
                "held" => CometMode::Held,
                "off" => CometMode::Off,
                _ => CometMode::Open,
            };
            Some((name.to_string(), Comets { mode, full_until: until }))
        })
        .collect()
}

/// Minutes (rounded up) until a page's comet cap frees, or `None` when not capped.
pub fn full_mins(c: &Comets) -> Option<u64> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    c.full_until.filter(|&u| u > now).map(|u| (u - now).div_ceil(60).max(1))
}

/// Whether a list entry and a page key name the same page (ignoring leading slashes).
pub fn same_page(name: &str, key: &str) -> bool {
    !key.is_empty() && name.trim_start_matches('/') == key.trim_start_matches('/')
}

/// The ship and the path an address names, as the browser shows a page of
/// another ship: `urb://~sampel/notes/plan` is `~sampel` and `notes/plan`,
/// and an address with no path is the ship's `index`.
pub fn place(url: &str) -> Option<(String, String)> {
    let u = de_urb(url).ok()?;
    Some((u.ship, u.rel.join("/")))
}

/// Build folder entries `(display_name, urb_url, is_folder)` from a ship's
/// published page keys and optional `/pub/titles` (or a granted folder's `dir-index`).
/// Folders come first sorted by name, then pages sorted by name.
pub fn dir_entries(ship: &str, dir: &[String], pages: &[String], titles: &[PageTitle]) -> Vec<(String, String, bool)> {
    let mut dirs: BTreeMap<String, ()> = BTreeMap::new();
    let mut files: BTreeMap<String, String> = BTreeMap::new();
    let all_keys = pages.iter().map(String::as_str).chain(titles.iter().map(|t| t.key.as_str()));
    for key in all_keys {
        let r: Vec<&str> = key.split('/').filter(|s| !s.is_empty()).collect();
        if r.len() <= dir.len() || r.iter().zip(dir).any(|(a, b)| *a != b) {
            continue;
        }
        let seg = r[dir.len()].to_string();
        if r.len() == dir.len() + 1 {
            let title = titles.iter().find(|t| same_page(&t.key, key)).map(|t| t.title.clone()).unwrap_or_default();
            files.entry(seg).and_modify(|cur| {
                if cur.is_empty() && !title.is_empty() {
                    *cur = title.clone();
                }
            }).or_insert(title);
        } else {
            dirs.insert(seg, ());
        }
    }
    let join_url = |seg: &str, folder: bool| -> String {
        let mut path: Vec<&str> = dir.iter().map(String::as_str).collect();
        path.push(seg);
        let n = if path.first().is_some_and(|d| d.len() == 1) { "n/" } else { "" };
        let slash = if folder { "/" } else { "" };
        format!("urb://{ship}/{n}{}{slash}", path.join("/"))
    };
    let mut out = Vec::with_capacity(dirs.len() + files.len());
    for name in dirs.into_keys() {
        let url = join_url(&name, true);
        out.push((name, url, true));
    }
    for (name, title) in files {
        let url = join_url(&name, false);
        let label = if !title.is_empty() && title != name { format!("{name} \u{b7} {title}") } else { name };
        out.push((label, url, false));
    }
    out
}

/// Decimal digits as an `@ud` prints them: `1234567` -> `1.234.567`.
pub fn dotted(id: &str) -> String {
    let mut out = String::with_capacity(id.len() + id.len() / 3);
    for (i, c) in id.chars().enumerate() {
        if i > 0 && (id.len() - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(c);
    }
    out
}

fn seg_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Parse a `urb://` address naming a lattice forum or furum board or thread.
/// Accepts dotted `@ud` (`1.000`) and plain decimal (`1000`) forum post ids.
pub fn board_place(url: &str) -> Option<BoardPlace> {
    if let Ok(u) = de_urb(url) {
        match (&u.mount, u.rel.as_slice()) {
            (Mount::Forum { post }, [board]) => {
                return Some(BoardPlace { app: BoardApp::Forum, host: u.ship, board: board.clone(), post: post.as_ref().map(|i: &Int| i.decimal()) });
            }
            (Mount::N, [furum, board]) if furum == "furum" && seg_ok(board) => {
                return Some(BoardPlace { app: BoardApp::Furum, host: u.ship, board: board.clone(), post: None });
            }
            (Mount::N, [furum, board, id]) if furum == "furum" && seg_ok(board) => {
                let n = id.parse::<u64>().ok().filter(|n| *n < (1 << 53) && *id == n.to_string())?;
                return Some(BoardPlace { app: BoardApp::Furum, host: u.ship, board: board.clone(), post: Some(n.to_string()) });
            }
            _ => {}
        }
    }
    // Also tolerate plain decimal forum post ids without dots (e.g. urb://~ship/forum/board/1000)
    let rest = url.trim().strip_prefix("urb://").unwrap_or(url.trim()).trim_end_matches('/');
    let parts: Vec<&str> = rest.split('/').collect();
    if let [ship, "forum", board, post] = parts.as_slice() {
        if is_patp(ship) && seg_ok(board) && !post.is_empty() && post.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            let digits: String = post.chars().filter(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() && digits.parse::<u64>().is_ok() {
                return Some(BoardPlace { app: BoardApp::Forum, host: (*ship).to_owned(), board: (*board).to_owned(), post: Some(digits) });
            }
        }
    }
    None
}

/// Convert a decimal integer string into `urb_engine::Int`.
pub fn int_of_u64(n: u64) -> Int {
    Int::from_le(&n.to_le_bytes())
}

/// Parse a `BoardPlace`'s post id into `urb_engine::Int`.
pub fn post_int(post: &str) -> Option<Int> {
    post.parse::<u64>().ok().map(int_of_u64)
}

fn js_get<'a>(x: &'a Js, k: &str) -> Option<&'a Js> {
    match x {
        Js::Obj(o) => o.get(k),
        _ => None,
    }
}

fn js_str(x: Option<&Js>) -> Option<String> {
    match x {
        Some(Js::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

fn js_u64(x: Option<&Js>) -> Option<u64> {
    match x {
        Some(Js::Num(n)) if n.fract() == 0.0 && *n >= 0.0 => js::number_text(*n).parse().ok(),
        Some(Js::Big(i)) => i.decimal().parse().ok(),
        Some(Js::Str(s)) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse().ok(),
        _ => None,
    }
}

fn js_date_da(x: Option<&Js>) -> String {
    match x {
        Some(Js::Date(Some(ms))) => crate::api::da_of_ms(*ms),
        _ => String::new(),
    }
}

fn js_arr(x: Option<&Js>) -> &[Js] {
    match x {
        Some(Js::Arr(a)) => a,
        _ => &[],
    }
}

fn js_post(p: &Js) -> Option<crate::api::ForumPost> {
    let id = js_u64(js_get(p, "id"))?;
    let created = js_date_da(js_get(p, "created"));
    let active = js_get(p, "active").map(|x| js_date_da(Some(x))).filter(|s| !s.is_empty()).unwrap_or_else(|| created.clone());
    let up = js_arr(js_get(p, "up")).len() as u64;
    let down = js_arr(js_get(p, "down")).len() as u64;
    let tags: Vec<String> = js_arr(js_get(p, "tags")).iter().filter_map(|t| js_str(Some(t))).collect();
    let pinned = matches!(js_get(p, "pinned"), Some(Js::Bool(true)));
    Some(crate::api::ForumPost {
        id,
        title: js_str(js_get(p, "title")).unwrap_or_default(),
        author: js_str(js_get(p, "author")).unwrap_or_default(),
        created,
        link: js_str(js_get(p, "url")).filter(|u| !u.is_empty()),
        body: js_str(js_get(p, "body")).filter(|b| !b.trim().is_empty()),
        up,
        down,
        comments: js_u64(js_get(p, "comments")).unwrap_or(0),
        pinned,
        tags,
        active,
    })
}

fn js_comment(c: &Js) -> Option<crate::api::ForumComment> {
    let id = js_u64(js_get(c, "id"))?;
    let up = js_get(c, "up").map(|u| js_arr(Some(u)).len() as u64);
    let down = js_get(c, "down").map(|d| js_arr(Some(d)).len() as u64);
    Some(crate::api::ForumComment {
        id,
        parent: js_u64(js_get(c, "parent")),
        author: js_str(js_get(c, "author")).unwrap_or_default(),
        created: js_date_da(js_get(c, "created")),
        body: js_str(js_get(c, "body")).unwrap_or_default(),
        up,
        down,
    })
}

/// Convert a lattice forum `Board` JS reply into `api::Board`.
pub fn js_to_forum_board(place: &BoardPlace, b: &Js) -> crate::api::Board {
    let info = js_get(b, "info");
    let posts: Vec<crate::api::ForumPost> = js_arr(js_get(b, "posts")).iter().filter_map(js_post).collect();
    let count = posts.len() as u64;
    let title = info.and_then(|i| js_str(js_get(i, "title"))).filter(|s| !s.is_empty()).unwrap_or_else(|| place.board.clone());
    let description = info.and_then(|i| js_str(js_get(i, "description"))).unwrap_or_default();
    let sidebar = info.and_then(|i| js_str(js_get(i, "sidebar"))).unwrap_or_default();
    crate::api::Board {
        board: place.board_key(),
        title,
        description,
        public: true,
        count,
        posts,
        sidebar,
        role: Some("reader".into()),
        page: None,
    }
}

/// Convert a lattice forum `Thread` JS reply into `api::Thread`.
pub fn js_to_forum_thread(place: &BoardPlace, t: &Js) -> Option<crate::api::Thread> {
    let title = js_get(t, "info").and_then(|i| js_str(js_get(i, "title"))).filter(|s| !s.is_empty()).unwrap_or_else(|| place.board.clone());
    let post = js_post(js_get(t, "post")?)?;
    let comments: Vec<crate::api::ForumComment> = js_arr(js_get(t, "comments")).iter().filter_map(js_comment).collect();
    Some(crate::api::Thread {
        board: place.board_key(),
        title,
        post,
        comments,
        role: Some("reader".into()),
    })
}

/// Convert a furum `Posts` JS reply into `api::Board`.
pub fn js_to_furum_board(place: &BoardPlace, p: &Js) -> crate::api::Board {
    let posts: Vec<crate::api::ForumPost> = js_arr(Some(p)).iter().filter_map(js_post).collect();
    let count = posts.len() as u64;
    crate::api::Board {
        board: place.board_key(),
        title: place.board.clone(),
        description: format!("furum board on {}", place.host),
        public: true,
        count,
        posts,
        sidebar: String::new(),
        role: Some("reader".into()),
        page: None,
    }
}

/// Convert furum `Posts` + `Comments` JS replies into `api::Thread`.
pub fn js_to_furum_thread(place: &BoardPlace, posts_js: &Js, comments_js: &Js) -> Option<crate::api::Thread> {
    let want_id: u64 = place.post.as_deref()?.parse().ok()?;
    let post = js_arr(Some(posts_js)).iter().filter_map(js_post).find(|p| p.id == want_id)?;
    let comments: Vec<crate::api::ForumComment> = js_arr(Some(comments_js)).iter().filter_map(js_comment).collect();
    Some(crate::api::Thread {
        board: place.board_key(),
        title: place.board.clone(),
        post,
        comments,
        role: Some("reader".into()),
    })
}

/// The page kind the app knows a mark by. What it does not know is shown as text.
pub fn kind_of(mark: &str) -> &'static str {
    // the kinds the app has a view for, or colours as source
    const KNOWN: &[&str] = &["md", "html", "gmi", "geojson", "scad", "tex", "fods", "fodt", "svg", "csv", "json", "js", "css", "hoon", "txt"];
    match mark {
        "markdown" => "md",
        "htm" => "html",
        "gemini" => "gmi",
        m => KNOWN.iter().copied().find(|k| *k == m).unwrap_or("txt"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors `desktop/src/engine.rs::only_reads_and_comments_are_submitted`:
    /// every request submitted to the host is a page read, a board read,
    /// a page comment poke, a forum post/reply, or a `/pub` / `dir-index` peek.
    /// Never a vote, publish, inbox watch, or furum write.
    #[test]
    fn only_reads_and_comments_are_submitted() {
        let src = include_str!("engine.rs");
        let code = src.split("\n#[cfg(test)]\nmod tests").next().unwrap();
        let named: Vec<&str> = code
            .match_indices("Request::")
            .map(|(i, _)| {
                let rest = &code[i + 9..];
                &rest[..rest.find(|c: char| !c.is_alphanumeric()).unwrap_or(rest.len())]
            })
            .collect();
        assert_eq!(
            named,
            ["Read", "Forum", "Forum", "Furum", "Furum", "Poke", "Forum", "Peek", "Peek", "Peek"],
            "the engine names only Request::Read, the board reads, one Poke, the forum write and three Peeks"
        );
        for word in ["Inbox", "PubPut", "PubRemove", "Pub {", "Watch"] {
            assert!(!code.contains(&format!("Request::{word}")), "{word}");
        }
        for word in ["submit_as", ".call(", "submit_open_as"] {
            assert!(!code.contains(word), "the engine uses {word}");
        }
        let calls: Vec<&str> = code
            .match_indices("Call::")
            .map(|(i, _)| {
                let rest = &code[i - 5..];
                &rest[..rest.find(['(', ' ']).unwrap_or(rest.len())]
            })
            .collect();
        assert_eq!(
            calls,
            [
                "ForumCall::Board",
                "ForumCall::Thread",
                "FurumCall::Posts",
                "FurumCall::Comments",
                "ForumCall::NewPost",
                "ForumCall::NewComment",
            ],
            "only the board readers' read calls, and a forum post or reply"
        );
        assert_eq!(code.matches(".submit(").count(), 7, "seven submits: read, board, comment, forum write, open list, thread, dir index");
        let names = &code[code.find("impl List {").unwrap()..];
        let names = &names[..names.find("\n}\n").unwrap()];
        let quoted: Vec<&str> = names.split('"').skip(1).step_by(2).collect();
        assert_eq!(quoted, ["comments", "comets", "forum-comets", "threads", "titles"], "{names}");
        let poke = &code[code.find("fn submit_comment<").unwrap()..];
        let poke = &poke[..poke.find("\n}\n").unwrap()];
        assert!(poke.contains("name: \"comments.sig\".into()"), "{poke}");
        assert!(poke.contains("mark: (\"/lattice\".into(), \"comment-action\".into())"), "{poke}");
    }

    #[test]
    fn thread_and_pub_list_parsers_work() {
        let got = thread_list(
            r#"{"v":1,"comments":[
              {"id":"0v1","author":"~sampel-palnet","when":1730000000000,"body":"hello"},
              {"id":"0v2","author":"~notaship","body":"bad"},
              {"author":"~zod","when":5,"body":"ok"}]}"#,
        );
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].author, "~sampel-palnet");
        assert_eq!(got[1].author, "~zod");
        assert_eq!(open_names("/a\n\n /b \n"), ["/a", "/b"]);
        let titles = page_titles("/notes/one\t1700000000\tFirst\n/notes/two\t1700000001\t\nbad\n");
        assert_eq!(titles.len(), 2);
        assert_eq!(titles[0], PageTitle { key: "/notes/one".into(), secs: 1700000000, title: "First".into() });
        let pols = comet_policies("/a held\n/b off\n/c open 1700000000\n");
        assert_eq!(pols.len(), 3);
        assert_eq!(pols[0].1.mode, CometMode::Held);
        assert_eq!(pols[1].1.mode, CometMode::Off);
        assert_eq!(pols[2].1.full_until, Some(1700000000));
        assert_eq!(thread_page("blog/post").as_deref(), Some("/blog/post"));
        assert_eq!(thread_page("/a/../b"), None);
    }

    #[test]
    fn dir_entries_lists_folders_then_pages_with_titles() {
        let pages = vec!["/notes/a".into(), "/notes/sub/deep".into(), "/notes/b".into(), "/other/x".into()];
        let titles = vec![PageTitle { key: "/notes/a".into(), secs: 10, title: "Alpha".into() }];
        let got = dir_entries("~zod", &["notes".into()], &pages, &titles);
        assert_eq!(
            got,
            vec![
                ("sub".into(), "urb://~zod/notes/sub/".into(), true),
                ("a \u{b7} Alpha".into(), "urb://~zod/notes/a".into(), false),
                ("b".into(), "urb://~zod/notes/b".into(), false),
            ]
        );
    }

    #[test]
    fn board_place_parses_forum_and_furum_urls() {
        assert_eq!(
            board_place("urb://~zod/forum/general"),
            Some(BoardPlace { app: BoardApp::Forum, host: "~zod".into(), board: "general".into(), post: None })
        );
        assert_eq!(
            board_place("urb://~zod/forum/general/1.000"),
            Some(BoardPlace { app: BoardApp::Forum, host: "~zod".into(), board: "general".into(), post: Some("1000".into()) })
        );
        assert_eq!(
            board_place("urb://~zod/forum/general/42"),
            Some(BoardPlace { app: BoardApp::Forum, host: "~zod".into(), board: "general".into(), post: Some("42".into()) })
        );
        assert_eq!(
            board_place("urb://~zod/furum/dev/7"),
            Some(BoardPlace { app: BoardApp::Furum, host: "~zod".into(), board: "dev".into(), post: Some("7".into()) })
        );
        assert_eq!(board_place("urb://~zod/notes/hello"), None);
    }

    fn engine_at(dir: PathBuf, fake: Option<&str>, status: Status) -> Engine {
        Engine { dir, fake: fake.map(str::to_string), inner: Arc::new(Mutex::new(Inner { status, failed_at: None, step: "", run: None, close_waiters: Vec::new() })) }
    }

    #[test]
    fn an_identity_is_not_moved_while_it_starts_or_when_it_is_fake() {
        let d = temp("move");
        let e = engine_at(d.clone(), None, Status::Booting);
        assert!(e.export_identity().unwrap_err().contains("still starting"));
        assert!(matches!(e.status(), Status::Booting), "and the start is left alone");
        let e = engine_at(d.clone(), Some("new-moon-of:~zod"), Status::Off);
        assert!(e.export_identity().unwrap_err().contains("fake"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_import_that_is_not_a_comet_is_refused_and_nothing_is_touched() {
        let d = temp("import");
        std::fs::write(d.join("comet.key"), "kept").unwrap();
        let e = engine_at(d.clone(), None, Status::Off);
        let id = crate::cometid::Identity { ship: "~zod".into(), keyfile: "not a keyfile".into(), db: vec![1], wal: vec![], exported: 0, my_posts: vec![] };
        assert!(e.import_identity(&id).unwrap_err().contains("does not hold"));
        assert_eq!(std::fs::read_to_string(d.join("comet.key")).unwrap(), "kept");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "nothing was set aside");
        assert!(comet_of_keyfile("").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A comet's keyfile, mined here from fixed bytes under a star. Nothing is asked of any network,
    /// and the comet is never started.
    fn mined(seed: u8) -> (String, String) {
        let key = urb_engine::engine::mine_comet_under(&[0x100], &[seed; 64]).expect("a comet is mined");
        (comet_of_keyfile(&key).expect("and it is a comet"), key)
    }

    #[test]
    fn an_identity_moves_from_one_folder_to_another_through_a_sealed_file() {
        let (a, b) = (temp("move-a"), temp("move-b"));
        let ((one, one_key), (two, two_key)) = (mined(1), mined(2));
        assert_ne!(one, two);
        for (d, name, key) in [(&a, &one, &one_key), (&b, &two, &two_key)] {
            std::fs::write(d.join("comet.key"), key).unwrap();
            std::fs::write(d.join(format!("{}.db", name.trim_start_matches('~'))), format!("store of {name}")).unwrap();
        }
        let first = engine_at(a.clone(), None, Status::Off);
        assert_eq!(first.identity().as_deref(), Some(one.as_str()));
        assert!(!first.exported());
        let id = first.export_identity().unwrap();
        let file = crate::cometid::seal(&id, "a long passphrase").unwrap();
        crate::cometid::mark_exported(first.dir()).unwrap();
        assert!(first.exported());

        let second = engine_at(b.clone(), None, Status::Off);
        let opened = crate::cometid::open(&file, "a long passphrase").unwrap();
        let aside = second.import_identity(&opened).unwrap().expect("the old identity is set aside");
        assert_eq!(second.identity().as_deref(), Some(one.as_str()));
        assert!(matches!(second.status(), Status::Off), "an engine that was off is not started by an import");
        assert!(!second.exported(), "the copy here has not been exported from here");
        assert_eq!(std::fs::read(b.join(format!("{}.db", one.trim_start_matches('~')))).unwrap(), format!("store of {one}").into_bytes());
        assert_eq!(std::fs::read_to_string(aside.join("comet.key")).unwrap().trim(), two_key.trim(), "the old keyfile is kept");
        assert!(aside.join(format!("{}.db", two.trim_start_matches('~'))).exists(), "with its store");
        for d in [a, b] {
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    /// Puts a mined comet and a stand-in store in `LATTICE_ID_SCRATCH`, for a headless run of the
    /// export and import screens. The comet is never started.
    #[test]
    #[ignore = "a fixture: LATTICE_ID_SCRATCH names the folder"]
    fn a_scratch_identity_for_a_headless_run() {
        let Ok(dir) = std::env::var("LATTICE_ID_SCRATCH") else { return };
        let seed = std::env::var("LATTICE_ID_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(7u8);
        let (d, (name, key)) = (PathBuf::from(dir), mined(seed));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("comet.key"), key).unwrap();
        std::fs::write(d.join(format!("{}.db", name.trim_start_matches('~'))), format!("store of {name}")).unwrap();
        eprintln!("scratch identity {name}");
    }

    #[test]
    fn export_with_no_identity_says_so() {
        let d = temp("none");
        let e = engine_at(d.clone(), None, Status::Off);
        assert!(e.export_identity().is_err());
        assert!(matches!(e.status(), Status::Off), "an engine that was off is not started by an export");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn nothing_starts_the_engine_ahead_of_a_read() {
        // A comet is made only by a read someone asked for (page or board), and restarted after an
        // identity move only if it was running before.
        let src = include_str!("engine.rs");
        let code = src.split("\n#[cfg(test)]\nmod tests").next().unwrap();
        assert_eq!(code.matches("self.start()").count(), 4, "read, boards, and the restart after an export and an import");
        assert!(code.contains("if was {\n            self.start();"), "a restart only of an engine that ran");
        let app = include_str!("lib.rs");
        assert!(!app.contains("e.start()") && !app.contains("engine.start()") && !app.contains("Engine::start"), "the app never starts it itself");
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lattice-rune-engine-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn damage_is_told_from_a_store_in_use() {
        assert_eq!(damage("/x/a.db is in use by another process"), Damage::None);
        assert_eq!(damage("/x/a.db.lock: can't open lockfile"), Damage::None);
        assert_eq!(damage("strconv.Atoi: parsing \"x\": invalid syntax"), Damage::Port);
        assert_eq!(damage("invalid port 99999"), Damage::Port);
        for e in ["/x/comet.key: mesa: not a keyfile", "/x/a.db: can't open database", "/x/a.db: can't initialize database", "/x/a.db: can't prepare statements"] {
            assert_eq!(damage(e), Damage::Identity, "{e}");
        }
        assert_eq!(damage("Get \"https://bootstrap.urbit.org\": no route"), Damage::None, "no network is not damage");
    }

    #[test]
    fn a_damaged_port_costs_only_the_port_and_a_damaged_store_the_identity() {
        let d = temp("aside");
        let put = |n: &str, t: &str| std::fs::write(d.join(n), t).unwrap();
        let names = |p: &Path| {
            let mut v: Vec<String> = std::fs::read_dir(p).unwrap().flatten().filter_map(|e| e.file_name().into_string().ok()).collect();
            v.sort();
            v
        };
        for n in ["comet.key", "~sampel.db", "~sampel.db-wal", "keys.txt"] {
            put(n, "x");
        }
        put("~sampel.db.port", "not a port");
        put("~other.db.port", "40123");
        set_aside(&d, Damage::Port).unwrap();
        let left = names(&d);
        assert!(left.contains(&"comet.key".to_owned()) && left.contains(&"~sampel.db".to_owned()) && left.contains(&"~other.db.port".to_owned()) && !left.contains(&"~sampel.db.port".to_owned()));
        let aside = left.iter().find(|n| n.starts_with("damaged-")).unwrap().clone();
        assert_eq!(names(&d.join(&aside)), ["~sampel.db.port"], "set aside, never deleted");
        std::fs::remove_dir_all(d.join(&aside)).unwrap();
        set_aside(&d, Damage::Identity).unwrap();
        let left = names(&d);
        let aside = left.iter().find(|n| n.starts_with("damaged-")).unwrap().clone();
        assert_eq!(left.iter().filter(|n| !n.starts_with("damaged-")).collect::<Vec<_>>(), ["keys.txt"]);
        assert_eq!(names(&d.join(&aside)), ["comet.key", "~other.db.port", "~sampel.db", "~sampel.db-wal"]);
        set_aside(&d, Damage::None).unwrap();
        assert_eq!(names(&d).len(), 2);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn an_address_gives_its_ship_and_path() {
        assert_eq!(place("urb://~sampel-palnet/notes/plan"), Some(("~sampel-palnet".into(), "notes/plan".into())));
        assert_eq!(place("urb://~zod"), Some(("~zod".into(), "index".into())));
        assert_eq!(place("urb://~zod/"), Some(("~zod".into(), "index".into())));
        assert_eq!(place("https://example.com/x"), None);
        assert_eq!(place("urb://nobody/x"), None);
    }

    #[test]
    fn a_mark_is_a_kind_the_app_knows_or_text() {
        assert_eq!((kind_of("md"), kind_of("gmi"), kind_of("html"), kind_of("geojson")), ("md", "gmi", "html", "geojson"));
        assert_eq!((kind_of("fods"), kind_of("hoon"), kind_of("svg")), ("fods", "hoon", "svg"), "a published sheet is a sheet, not its XML");
        assert_eq!((kind_of("txt"), kind_of("weird"), kind_of("")), ("txt", "txt", "txt"));
    }

    #[test]
    fn a_start_that_fails_says_why_in_plain_words() {
        assert!(plain_boot("Get \"https://bootstrap.urbit.org/x\": no route").contains("couldn't reach the internet"));
        assert_eq!(plain_boot("odd"), "The reader couldn't start: odd");
        assert_eq!(boot_error("/x/y.db is in use by another process"), ReadError::Busy);
        assert!(ReadError::Busy.words().contains("Another lattice-rune"));
    }

    #[test]
    fn an_engine_not_asked_makes_nothing() {
        let d = std::env::temp_dir().join(format!("lattice-rune-engine-{}", std::process::id()));
        let e = Engine { dir: d.clone(), fake: None, inner: Arc::new(Mutex::new(Inner { status: Status::Off, failed_at: None, step: "", run: None, close_waiters: Vec::new() })) };
        assert_eq!((e.status(), e.step(), e.our()), (Status::Off, "", None));
        e.close();
        assert!(!d.exists(), "no folder, no key and no thread until a read");
    }

    #[test]
    fn poisoned_inner_mutex_is_recovered() {
        let e = engine_at(std::env::temp_dir().join("lattice-rune-engine-poison"), None, Status::Off);
        let inner = e.inner.clone();
        let _ = std::thread::spawn(move || {
            let _g = inner.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert_eq!(e.status(), Status::Off);
        assert_eq!(e.step(), "");
        assert!(e.close());
    }

    #[test]
    fn close_while_booting_is_non_blocking_and_holds_closing_until_thread_exits() {
        let d = temp("closing-boot");
        let (jobs_tx, jobs_rx) = channel::<Job>();
        let (release_tx, release_rx) = channel::<()>();
        let inner = Arc::new(Mutex::new(Inner {
            status: Status::Booting,
            failed_at: None,
            step: "Joining",
            run: Some(Running { jobs: jobs_tx, waker: None }),
            close_waiters: Vec::new(),
        }));
        let e = Engine { dir: d.clone(), fake: None, inner: inner.clone() };

        let worker_inner = inner.clone();
        let worker = std::thread::spawn(move || {
            let _exit = ExitGuard { inner: worker_inner };
            let _keep_rx = jobs_rx;
            let _ = release_rx.recv();
        });

        let began = Instant::now();
        assert!(!e.close(), "close returns false while host thread is still exiting");
        assert!(began.elapsed() < Duration::from_millis(200), "close must not block while booting");
        assert_eq!(e.status(), Status::Closing);

        e.start();
        assert_eq!(e.status(), Status::Closing);
        assert!(e.inner.lock().unwrap().run.is_none(), "no second host_thread may be started during Closing");
        assert!(e.export_identity().unwrap_err().contains("still closing"));

        assert!(!e.close_wait(Duration::from_millis(20)));
        assert_eq!(e.status(), Status::Closing);

        let e_wait = e.clone();
        let waiter = std::thread::spawn(move || e_wait.close_wait(Duration::from_secs(2)));
        std::thread::sleep(Duration::from_millis(15));
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(waiter.join().unwrap(), "close_wait wakes once old thread exits");
        assert_eq!(e.status(), Status::Off);
        assert!(e.close(), "close on Off returns true immediately");
        let _ = std::fs::remove_dir_all(&d);
    }
}
