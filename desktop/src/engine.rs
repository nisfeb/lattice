//! The urb engine: urb-fetch's Rust core (libmesa through `urb`'s native
//! host), linked into the app and run on a thread of its own, as
//! urb-gateway's main runs it. It reads pages people publish with lattice
//! on the Urbit network, as a comet this app makes once and keeps, so
//! someone with no ship can read them (the shipless reader, reader.rs).
//!
//! The engine reads page content, and lattice forum and furum boards
//! (`boards`, read calls only), and makes two writes, each as the comet
//! itself: a comment on a published page, poked to the publisher's comment
//! inbox (owner, 2026-11-03: someone using the app anonymously can browse
//! and comment), and a post or a reply on a public lattice forum board,
//! poked to the host's forum inbox (`forum_write`). It never votes,
//! follows, bookmarks or publishes, never writes to a furum board, and
//! never acts as the user's ship. Every request it makes goes through
//! `submit_read`, `submit_board`, `submit_comment`, `submit_forum_write`
//! or `submit_open_list`, and a test reads this file's own source to hold
//! it to that (`only_reads_and_comments_are_submitted`).
//!
//! State lives in `<app_data_dir>/urb/` (0700), opened as the Go and Rust
//! gateways open theirs (`urb_gateway::state::find`): `comet.key` (0600,
//! mined the first time, over HTTPS to bootstrap.urbit.org), `<comet>.db`
//! (libmesa's SQLite store) and `<comet>.db.port` (the UDP port the
//! identity keeps, since publishers answer the address they last saw).
//! One comet per install: every new comet leaves a record on each ship it
//! reads, so it is never remade per run, test or window.
//!
//! With no ship configured, the app starts the engine at launch
//! (`prewarm`), so the reader is ready, and the start list read, by the
//! time someone opens it. A comet made that way is unclaimed (an
//! `unclaimed` file beside it) until the reader is used (`claim`). An
//! unclaimed comet is kept across launches and reused, so launches that
//! never read mint no new comet, but it does not count as the reader
//! having been used, and connecting a ship deletes it (`drop_unclaimed`).
//! With a ship configured the engine starts only when something asks for
//! a read.


use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use urb_engine::host::net::{libmesa_log, random, Log, NetIo};
use urb_engine::host::{Event, Host};
use urb_engine::url::{APP_BASE, DESK_BASE};
use urb_engine::core::{ForumCall, FurumCall};
use urb_engine::js::Js;
use urb_engine::{Failure, Int, Reply, Request, Value};
use urb_gateway::state::{self, GatewayUdp};

/// A body larger than this is refused, so a hostile publisher cannot
/// balloon the app.
pub const MAX_BODY: usize = 4 * 1024 * 1024;

/// A start that failed is not tried again for this long. The reader's
/// setup page reloads itself every second, and each reload asks for a read:
/// without the wait every reload would start the engine again, so a
/// failure (another lattice on the store, no network) would show as
/// "setting up" forever and never as what it is.
pub const RETRY_AFTER: Duration = Duration::from_secs(5);

/// Beside a comet made before anyone asked to read (see the top).
const UNCLAIMED: &str = "unclaimed";
/// How long a publisher may take over a small grub (`/pub/comments`)
/// before the peek gives up: the read just made has the flow open.
const PEEK_WAIT_MS: u64 = 5_000;

/// How long the warm-up's reads wait each.
const WARM_BUDGET: Duration = Duration::from_secs(30);
/// How long the warm-up keeps asking for the start list while its
/// publisher does not answer: a new comet's first contact with a ship can
/// take two minutes (~nisfeb took 117 s), and one read gives up at 30 s
/// (the core's peek timeout, though its peek waits on for a late answer).
const WARM_FOR: Duration = Duration::from_secs(180);

/// A page as the engine read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativePage {
    /// its key in the publisher's vault
    pub key: String,
    pub body: String,
    /// the mark it was published under (`gmi` when it had none)
    pub mark: String,
    /// how it was read (a scry, a keen), for the log
    pub how: String,
}

/// Why a read gave no page. Each carries the gateway's words for it
/// (`urb_gateway::routes::fail_of`), so the app says what the gateway says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadError {
    /// the ship answered and has no such page for us: unpublished, or
    /// private to ships the comet is not
    NotPublished(String),
    /// no answer; `later` when trying again may work
    Unreachable { later: bool, words: String },
    /// another lattice holds the engine's store
    Busy,
    /// the engine is still starting and the caller would not wait
    Booting,
    Failed(String),
}

/// Where the engine is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Off,
    Booting,
    Ready { our: String },
    Failed(String),
}

/// Why a comment was not sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommentError {
    /// the publisher's ship refused the poke, in its words
    Refused(String),
    /// no answer in time; the comment may not have gone
    Unanswered(String),
    /// the reader could not send it at all (not started, stopped)
    Failed(String),
}

/// Something that reads pages: the engine, or a test's stand-in.
pub trait Reads: Send + Sync {
    fn read(&self, url: &str, budget: Duration, wait_boot: bool) -> Result<NativePage, ReadError>;
    /// Drop what is kept for `url`'s ship, so the next read of it is
    /// fresh: a reload. The identity and its flows stay.
    fn expire(&self, url: &str) {
        let _ = url;
    }
    /// what a start in progress is doing, in words
    fn step(&self) -> &'static str {
        ""
    }
    /// the reader identity's name, once it runs
    fn our(&self) -> Option<String> {
        None
    }
    /// Comment `body` on the page `page` (its key, as a read gave it) of
    /// `ship`, as the reader identity.
    fn comment(&self, ship: &str, page: &str, body: &str, budget: Duration) -> Result<(), CommentError> {
        let _ = (ship, page, body, budget);
        Err(CommentError::Failed("this reader cannot comment".into()))
    }
    /// The pages of `ship` that take comments, by the names its revision
    /// list gives them (`/<path>`), from lattice's `/pub/comments`, with
    /// each page's comet policy from `/pub/comets` beside it. `None` when
    /// that is not known: no answer, or a lattice too old to say.
    fn comments_open(&self, ship: &str, budget: Duration) -> Option<Opened> {
        let _ = (ship, budget);
        None
    }
    /// The published pages of `ship` with a public comment list, by the
    /// names `/pub/comments` gives them, from lattice's `/pub/threads`.
    /// `None` when that is not known: no answer, or a lattice too old to
    /// publish comments.
    fn threads(&self, ship: &str, budget: Duration) -> Option<Vec<String>> {
        let _ = (ship, budget);
        None
    }
    /// The public comments on the page `page` (its key) of `ship`, oldest
    /// first, from lattice's `/pub/thread/<page>/list`. `None` when that is
    /// not known; a list that is too big or malformed is empty.
    fn thread(&self, ship: &str, page: &str, budget: Duration) -> Option<Vec<PubComment>> {
        let _ = (ship, page, budget);
        None
    }
    /// The boards of `host` that take posts and replies from comets, from
    /// lattice's `/pub/forum-comets`. `None` when the host does not say (an
    /// older lattice, or no answer): the reader offers the form and the host
    /// decides.
    fn forum_open(&self, host: &str, budget: Duration) -> Option<Vec<String>> {
        let _ = (host, budget);
        None
    }
    /// Start a post or reply on a lattice forum board as the reader
    /// identity. `Ok` means the host took the poke in, not that it landed.
    fn forum_write(&self, host: &str, w: ForumWrite, budget: Duration) -> Result<(), CommentError> {
        let _ = (host, w, budget);
        Err(CommentError::Failed("this reader cannot post".into()))
    }
    /// Read boards and threads, all at once, each within `budget`: one
    /// result per ask, in order.
    fn boards(&self, asks: Vec<BoardAsk>, budget: Duration) -> Vec<Result<Js, ReadError>> {
        let _ = budget;
        asks.iter().map(|_| Err(ReadError::Failed("this reader cannot read boards".into()))).collect()
    }
    /// Each published page of `ship` with when it last changed (unix
    /// seconds) and its title, from lattice's `/pub/titles`: one
    /// `PageTitle` a page, keyed as its revision list names it. `None` when
    /// that is not known: no answer, or a lattice too old to say.
    fn titles(&self, ship: &str, budget: Duration) -> Option<Vec<PageTitle>> {
        let _ = (ship, budget);
        None
    }
    /// The pages of `ship` its kept revision list names (`/<path>`), as the
    /// last read of one of its pages got it, with when each was last
    /// changed where that is known. `None` when no list is kept. Asks
    /// nothing of the network.
    fn pages(&self, ship: &str) -> Option<Vec<(String, Option<i64>)>> {
        let _ = ship;
        None
    }
    /// The pages in `folder` (`/<path>`) of `ship` as its `dir-index` grub
    /// names them, the lines of `/pub/titles`, for a folder `ship` grants
    /// to ships it names. Only those ships may read it.
    fn dir_index(&self, ship: &str, folder: &str, budget: Duration) -> DirIndex {
        let _ = (ship, folder, budget);
        DirIndex::Silent
    }
}

/// What a folder's `dir-index` peek heard (`Reads::dir_index`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DirIndex {
    /// its pages
    Got(Vec<PageTitle>),
    /// an answer, and not an index: none there, or not ours to read
    Refused,
    /// no answer in time, or a reader not ready
    Silent,
}

/// A published page as `/pub/titles` names it: its key (`/<path>`), when
/// it last changed in unix seconds, and its title, empty when it has none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageTitle {
    pub key: String,
    pub secs: i64,
    pub title: String,
}

/// What a publisher says of commenting: the pages that take comments
/// (`/pub/comments`), and the comet policy of each page that is not
/// plainly open (`/pub/comets`, empty when the publisher has none).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Opened {
    pub names: Vec<String>,
    /// `None` when `/pub/comets` gave no answer in time: the cap state is
    /// not known, which is not the same as open
    pub comets: Option<Vec<(String, Comets)>>,
}

/// A public comment on a published page, as its publisher lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PubComment {
    pub id: String,
    /// the author's @p
    pub author: String,
    /// unix milliseconds
    pub when: i64,
    /// raw plain text
    pub body: String,
}

/// How a page takes comments from comets, the anonymous identities the
/// reader comments as.
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

/// A read of a board, one of four: a lattice forum's board or one of its
/// threads, or a furum board's posts or one post's comments. Nothing here
/// posts, comments or votes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BoardAsk {
    Forum { host: String, board: String },
    ForumThread { host: String, board: String, post: Int },
    FurumPosts { host: String, board: String },
    FurumComments { host: String, board: String, post: u64 },
}

/// A write on a lattice forum board, the only two a comet makes: a new
/// post, or a reply in a thread. Never a vote: a comet is free to mint,
/// so its vote would count for nothing, and the host refuses one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ForumWrite {
    Post { board: String, title: String, url: Option<String>, body: Option<String> },
    Reply { board: String, post: Int, parent: Option<Int>, body: String },
}

/// where a board read's result goes
type Told = Sender<Result<Js, ReadError>>;

/// where a read's result goes
type Answer = Sender<Result<NativePage, ReadError>>;
/// where a comment's result goes
type Said = Sender<Result<(), CommentError>>;
/// where a peek's result goes: the cord, `None` for no such grub
type Cord = Sender<Result<Option<String>, String>>;

/// A comment for the host's thread: the publisher, the lattice base to
/// poke at, the page's path and the text.
struct Comment {
    ship: String,
    base: &'static str,
    page: String,
    body: String,
}

/// what callers hand the host's thread
enum Job {
    Read(String, Answer),
    /// the ship whose kept revision list is to go (`Engine::expire`)
    Expire(String),
    /// the names in the revision list kept for a ship (`Engine::pages`)
    Pages(String, Sender<Option<Vec<String>>>),
    Comment(Comment, Said),
    /// a publisher's `/pub/comments` or `/pub/comets`, at a lattice base
    OpenList(String, &'static str, List, Cord),
    /// a publisher's public comment list for a page, at a lattice base
    Thread(String, &'static str, String, Cord),
    /// a granted folder's `dir-index`, at a lattice base
    DirIndex(String, &'static str, String, Cord),
    ForumWrite(String, ForumWrite, Said),
    Board(BoardAsk, Told),
    Close(Sender<()>),
}

/// what the host's thread waits on
enum Wait {
    Read(Answer, String),
    /// a comment or a forum write, by its label in the log
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
    /// when the last start failed
    failed_at: Option<Instant>,
    /// what a start is doing, in words for the reader's setup page
    step: &'static str,
    run: Option<Running>,
    /// an unclaimed comet is to go: the host's thread deletes it once its
    /// start is done, rather than reach the network with it
    discard: bool,
}

/// The engine, one per app (managed state). A clone is the same engine.
#[derive(Clone)]
pub struct Engine {
    dir: PathBuf,
    /// a fake ship's name on a fake network (`urbit -F`), for tests: the
    /// fleet's fake network has no comets
    fake: Option<String>,
    inner: Arc<Mutex<Inner>>,
}

impl Engine {
    /// The engine for state in `dir`. Does nothing yet: nothing is made on
    /// disk and no thread runs until `prewarm` or the first read.
    ///
    /// Debug builds take `LATTICE_ENGINE_FAKE=<ship>` to run as that ship
    /// on a fake network, so the end-to-end checks can read a fleet ship.
    /// A release build ignores it, as it ignores LATTICE_PROBE_JS.
    pub fn new(dir: PathBuf) -> Engine {
        let fake = cfg!(debug_assertions)
            .then(|| std::env::var("LATTICE_ENGINE_FAKE").ok())
            .flatten()
            .filter(|s| !s.is_empty());
        Engine::with(dir, fake)
    }

    #[cfg(test)]
    pub fn fake(dir: PathBuf, ship: &str) -> Engine {
        Engine::with(dir, Some(ship.to_string()))
    }

    fn with(dir: PathBuf, fake: Option<String>) -> Engine {
        Engine {
            dir,
            fake,
            inner: Arc::new(Mutex::new(Inner { status: Status::Off, failed_at: None, step: "", run: None, discard: false })),
        }
    }

    /// The state folder.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn status(&self) -> Status {
        self.inner.lock().unwrap().status.clone()
    }

    /// What a start in progress is doing: making the identity (the first
    /// time only) or opening it. Empty when not starting.
    pub fn step(&self) -> &'static str {
        let g = self.inner.lock().unwrap();
        if g.status == Status::Booting {
            g.step
        } else {
            ""
        }
    }

    /// Start the host's thread unless it runs or is starting. A failed
    /// start (no network for the comet's first mining, another lattice on
    /// the store) is tried again by the first read RETRY_AFTER after it.
    pub fn start(&self) {
        let mut g = self.inner.lock().unwrap();
        if matches!(g.status, Status::Booting | Status::Ready { .. }) {
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
        std::thread::Builder::new()
            .name("urb-engine".into())
            .spawn(move || host_thread(&dir, fake.as_deref(), &inner, jobs_rx))
            .expect("spawn the engine's thread");
    }

    /// Read `url` (an urb:// address), waiting at most `budget`. With
    /// `wait_boot` false a read made while the engine is still starting
    /// gives `Booting` at once (and the start goes on).
    pub fn read(&self, url: &str, budget: Duration, wait_boot: bool) -> Result<NativePage, ReadError> {
        self.start();
        let (tx, rx) = channel();
        {
            let g = self.inner.lock().unwrap();
            match &g.status {
                Status::Booting if !wait_boot => return Err(ReadError::Booting),
                Status::Failed(m) => return Err(boot_error(m)),
                _ => {}
            }
            let Some(run) = &g.run else { return Err(ReadError::Failed("the reader stopped".into())) };
            if run.jobs.send(Job::Read(url.to_string(), tx)).is_err() {
                return Err(ReadError::Failed("the reader stopped".into()));
            }
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
        match rx.recv_timeout(budget) {
            Ok(r) => r,
            Err(RecvTimeoutError::Timeout) => Err(ReadError::Unreachable {
                later: true,
                words: format!("no answer within {}s", budget.as_secs()),
            }),
            // the thread ended: its start failed, or it was closed
            Err(RecvTimeoutError::Disconnected) => match self.status() {
                Status::Failed(m) => Err(boot_error(&m)),
                _ => Err(ReadError::Failed("the reader stopped".into())),
            },
        }
    }

    /// A reload: the revision list kept for `url`'s ship (60 s, the
    /// core's REVS_TTL) is aged, so the next read asks the publisher for
    /// it again and keens the page's newest revision. The pages libmesa
    /// keeps are each one revision's, under its own id, so a new revision
    /// is never answered from them; nothing else is kept between reads.
    /// The comet, its flows and the ship's base stay. Jobs run in order,
    /// so a read asked for after this sees it. Nothing happens while the
    /// engine is not running: it then keeps nothing.
    pub fn expire(&self, url: &str) {
        let Ok(u) = urb_engine::url::de_urb(url) else { return };
        let g = self.inner.lock().unwrap();
        let Some(run) = g.run.as_ref().filter(|_| matches!(g.status, Status::Ready { .. })) else { return };
        if run.jobs.send(Job::Expire(u.ship)).is_ok() {
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
    }

    /// The pages of `ship` its kept revision list names
    /// (`Reads::pages`). The list says each page's revision and id but not
    /// when it changed: lattice keeps that in `/pub/index`, a noun map the
    /// core's peeks cannot read, so every time is unknown here.
    pub fn pages(&self, ship: &str) -> Option<Vec<(String, Option<i64>)>> {
        let (tx, rx) = channel();
        {
            let g = self.inner.lock().unwrap();
            if !matches!(g.status, Status::Ready { .. }) {
                return None;
            }
            let run = g.run.as_ref()?;
            run.jobs.send(Job::Pages(ship.into(), tx)).ok()?;
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
        let names = rx.recv_timeout(Duration::from_secs(2)).ok()??;
        Some(names.into_iter().map(|n| (n, None)).collect())
    }

    /// Comment on a published page as the reader identity: a
    /// `%comment-action` poked to the publisher's `comments.sig`, the inbox
    /// lattice opens to every foreign ship, as `/comment-remote` pokes it
    /// from a ship. Lattice runs at one of two bases; the desk install is
    /// tried first, and the other only when the first is refused. The
    /// publisher decides whether the comment lands, and says nothing when
    /// it does not (banned, comments off), so `Ok` means sent, not posted.
    pub fn comment(&self, ship: &str, page: &str, body: &str, budget: Duration) -> Result<(), CommentError> {
        let start = Instant::now();
        let mut first = None;
        for base in [DESK_BASE, APP_BASE] {
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

    /// Board reads (`BoardAsk`), sent together so they run at once, each
    /// waiting at most `budget` from now. A board read waits for a start in
    /// progress only as long as the budget, as a page read with
    /// `wait_boot` false does not: the reader shows `Booting` instead.
    pub fn boards(&self, asks: Vec<BoardAsk>, budget: Duration) -> Vec<Result<Js, ReadError>> {
        self.start();
        let mut rxs = Vec::with_capacity(asks.len());
        {
            let g = self.inner.lock().unwrap();
            let refuse = match &g.status {
                Status::Booting => Some(ReadError::Booting),
                Status::Failed(m) => Some(boot_error(m)),
                _ => None,
            };
            if let Some(e) = refuse {
                return asks.iter().map(|_| Err(e.clone())).collect();
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
        let start = Instant::now();
        rxs.into_iter()
            .map(|rx| match rx.recv_timeout(budget.saturating_sub(start.elapsed())) {
                Ok(r) => r,
                Err(RecvTimeoutError::Timeout) => Err(ReadError::Unreachable {
                    later: true,
                    words: format!("no answer within {}s", budget.as_secs()),
                }),
                Err(RecvTimeoutError::Disconnected) => Err(ReadError::Failed("the reader stopped".into())),
            })
            .collect()
    }

    fn comment_at(&self, c: Comment, budget: Duration) -> Result<(), CommentError> {
        let (tx, rx) = channel();
        {
            let g = self.inner.lock().unwrap();
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
            Err(RecvTimeoutError::Timeout) => {
                Err(CommentError::Unanswered(format!("no answer within {}s", budget.as_secs())))
            }
            Err(RecvTimeoutError::Disconnected) => Err(CommentError::Failed("the reader stopped".into())),
        }
    }

    /// The pages of `ship` that take comments (`Reads::comments_open`):
    /// lattice's `/pub/comments` cord, at the desk install's base first and
    /// the older base when the first has none.
    /// `/pub/comets` is asked for at the same time, on the same budget; a
    /// publisher without it (an older lattice) has every page open.
    pub fn comments_open(&self, ship: &str, budget: Duration) -> Option<Opened> {
        let start = Instant::now();
        for base in [DESK_BASE, APP_BASE] {
            let left = budget.saturating_sub(start.elapsed());
            if left.is_zero() {
                return None;
            }
            let (tx, rx) = channel();
            let (ctx, crx) = channel();
            {
                let g = self.inner.lock().unwrap();
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
                        // an older lattice keeps no /pub/comets
                        Ok(Ok(None)) => Some(Vec::new()),
                        _ => None,
                    };
                    return Some(Opened { names: open_names(&cord), comets });
                }
                // none here, or not lattice's base: the other one may be
                Ok(Ok(None)) | Ok(Err(_)) => {}
                Err(_) => return None,
            }
        }
        None
    }

    /// The boards of `host` that take comet posts (`Reads::forum_open`):
    /// lattice's `/pub/forum-comets` cord, as `comments_open` reads its list.
    pub fn forum_open(&self, host: &str, budget: Duration) -> Option<Vec<String>> {
        self.list_cord(host, List::ForumComets, budget).map(|c| open_names(&c))
    }

    /// The published pages of `ship` with their times and titles
    /// (`Reads::titles`): lattice's `/pub/titles` cord, as `comments_open`
    /// reads its list.
    pub fn titles(&self, ship: &str, budget: Duration) -> Option<Vec<PageTitle>> {
        self.list_cord(ship, List::Titles, budget).map(|c| page_titles(&c))
    }

    /// One of lattice's lists of `ship` as a cord, at the desk install's
    /// base first and the older base when the first has none. `None` when
    /// neither has it or there is no answer within `budget`.
    fn list_cord(&self, ship: &str, list: List, budget: Duration) -> Option<String> {
        let start = Instant::now();
        for base in [DESK_BASE, APP_BASE] {
            let left = budget.saturating_sub(start.elapsed());
            if left.is_zero() {
                return None;
            }
            let (tx, rx) = channel();
            {
                let g = self.inner.lock().unwrap();
                if !matches!(g.status, Status::Ready { .. }) {
                    return None;
                }
                let run = g.run.as_ref()?;
                run.jobs.send(Job::OpenList(ship.into(), base, list, tx)).ok()?;
                if let Some(w) = &run.waker {
                    let _ = w.send(Event::Wake);
                }
            }
            match rx.recv_timeout(left) {
                Ok(Ok(Some(cord))) => return Some(cord),
                // none here, or not lattice's base: the other one may be
                Ok(Ok(None)) | Ok(Err(_)) => {}
                Err(_) => return None,
            }
        }
        None
    }

    /// The pages of `ship` with a public comment list (`Reads::threads`):
    /// lattice's `/pub/threads` cord, as `comments_open` reads its list.
    pub fn threads(&self, ship: &str, budget: Duration) -> Option<Vec<String>> {
        self.peek_bases(budget, |base, tx| Job::OpenList(ship.into(), base, List::Threads, tx)).map(|c| open_names(&c))
    }

    /// The pages in `folder` of `ship` its `dir-index` names
    /// (`Reads::dir_index`), at the desk install's base first and the older
    /// base when the first has none.
    pub fn dir_index(&self, ship: &str, folder: &str, budget: Duration) -> DirIndex {
        let Some(folder) = thread_page(folder) else { return DirIndex::Refused };
        let start = Instant::now();
        for base in [DESK_BASE, APP_BASE] {
            let left = budget.saturating_sub(start.elapsed());
            if left.is_zero() {
                return DirIndex::Silent;
            }
            let (tx, rx) = channel();
            {
                let g = self.inner.lock().unwrap();
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
                // none here, refused, or not lattice's base: the other one may be
                Ok(Ok(None)) | Ok(Err(_)) => {}
                Err(_) => return DirIndex::Silent,
            }
        }
        DirIndex::Refused
    }

    /// The public comments on `page` of `ship` (`Reads::thread`): lattice's
    /// `/pub/thread/<page>/list` cord, as `comments_open` reads its list.
    pub fn thread(&self, ship: &str, page: &str, budget: Duration) -> Option<Vec<PubComment>> {
        let page = thread_page(page)?;
        self.peek_bases(budget, |base, tx| Job::Thread(ship.into(), base, page.clone(), tx)).map(|c| thread_list(&c))
    }

    /// One peek at the desk install's base first and the older base when
    /// the first has none, within `budget`: the cord, or `None` for none at
    /// either, no answer, or a reader not ready.
    fn peek_bases(&self, budget: Duration, job: impl Fn(&'static str, Cord) -> Job) -> Option<String> {
        let start = Instant::now();
        for base in [DESK_BASE, APP_BASE] {
            let left = budget.saturating_sub(start.elapsed());
            if left.is_zero() {
                return None;
            }
            let (tx, rx) = channel();
            {
                let g = self.inner.lock().unwrap();
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
                // none here, or not lattice's base: the other one may be
                Ok(Ok(None)) | Ok(Err(_)) => {}
                Err(_) => return None,
            }
        }
        None
    }

    /// A post or reply on a lattice forum board, as the reader identity:
    /// the forum reader's newPost or newComment, an `action` poked to the
    /// host's `forum.sig`, which stamps the author from the transport. The
    /// host's base is the one its board reads found.
    pub fn forum_write(&self, host: &str, w: ForumWrite, budget: Duration) -> Result<(), CommentError> {
        let (tx, rx) = channel();
        {
            let g = self.inner.lock().unwrap();
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
            Err(RecvTimeoutError::Timeout) => {
                Err(CommentError::Unanswered(format!("no answer within {}s", budget.as_secs())))
            }
            Err(RecvTimeoutError::Disconnected) => Err(CommentError::Failed("the reader stopped".into())),
        }
    }

    /// Start the engine before anyone reads, and read `warm` (the start
    /// list) and the first page it links to, so the first page someone
    /// opens is already on its way. A comet this makes is unclaimed until
    /// `claim`. Only for an app with no ship configured.
    pub fn prewarm(&self, warm: Option<&str>) {
        if let Err(e) = self.mark_unclaimed() {
            log_line(&format!("prewarm: {e}"));
            return;
        }
        self.inner.lock().unwrap().discard = false;
        self.start();
        // a fake network (the end-to-end checks) has no start list
        let Some(warm) = warm.filter(|_| self.fake.is_none()).map(String::from) else { return };
        let e = self.clone();
        let _ = std::thread::Builder::new().name("urb-warm".into()).spawn(move || {
            let Ok(p) = e.warm_until(&warm, WARM_FOR) else { return };
            if let Some(next) = first_link(&p.body) {
                let _ = e.warm_read(&next);
            }
        });
    }

    /// Before a start nobody asked for: a comet about to be made is
    /// marked unclaimed. One already there (claimed, or unclaimed from an
    /// earlier launch) is reused as it is, so launches that never read
    /// mint no new comet.
    fn mark_unclaimed(&self) -> Result<(), String> {
        if self.fake.is_some() || self.dir.join("comet.key").exists() {
            return Ok(());
        }
        make_dir(&self.dir)?;
        std::fs::write(self.dir.join(UNCLAIMED), b"").map_err(|e| format!("{UNCLAIMED}: {e}"))
    }

    /// `warm_read`, asked again while the publisher has not answered yet
    /// (a first contact), until `within` has gone.
    fn warm_until(&self, url: &str, within: Duration) -> Result<NativePage, ReadError> {
        let t = Instant::now();
        loop {
            match self.warm_read(url) {
                Err(ReadError::Unreachable { later: true, .. }) if t.elapsed() < within => {
                    std::thread::sleep(Duration::from_secs(1));
                }
                r => return r,
            }
        }
    }

    fn warm_read(&self, url: &str) -> Result<NativePage, ReadError> {
        if self.inner.lock().unwrap().discard {
            return Err(ReadError::Failed("discarded".into()));
        }
        let t = Instant::now();
        let r = self.read(url, WARM_BUDGET, true);
        log_line(&format!("warmed {url} in {} ms: {}", t.elapsed().as_millis(), if r.is_ok() { "ok" } else { "no page" }));
        r
    }

    /// The reader is being used: its comet is kept from now on.
    pub fn claim(&self) {
        let mut g = self.inner.lock().unwrap();
        g.discard = false;
        let _ = std::fs::remove_file(self.dir.join(UNCLAIMED));
    }

    /// Has the reader been used (is there a claimed comet on disk)?
    pub fn claimed(&self) -> bool {
        self.dir.join("comet.key").exists() && !self.dir.join(UNCLAIMED).exists()
    }

    /// Delete a comet nobody claimed (a ship was connected, or is
    /// configured at launch), closing the engine first. A start still in progress
    /// deletes it itself when done. Nothing happens to a claimed comet.
    pub fn drop_unclaimed(&self) {
        if !self.dir.join(UNCLAIMED).exists() {
            return;
        }
        {
            let mut g = self.inner.lock().unwrap();
            g.discard = true;
            if g.status == Status::Booting {
                return;
            }
        }
        self.close();
        log_line("deleting the unclaimed reader identity");
        discard_identity(&self.dir);
    }

    /// Close the engine, waiting up to 2 s so libmesa makes its last save.
    /// False when it ran and did not say it had closed in that time.
    pub fn close(&self) -> bool {
        let (tx, rx) = channel();
        {
            let mut g = self.inner.lock().unwrap();
            let Some(run) = g.run.take() else { return true };
            g.status = Status::Off;
            if self.fake.is_none() {
                crate::render::set_exported_running(None);
            }
            if run.jobs.send(Job::Close(tx)).is_err() {
                return true;
            }
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
        rx.recv_timeout(Duration::from_secs(2)).is_ok()
    }

    /// The reader identity's @p: the running one, or the one on disk.
    /// `None` when there is none yet.
    pub fn identity(&self) -> Option<String> {
        if let Status::Ready { our } = self.status() {
            return Some(our);
        }
        let text = std::fs::read_to_string(self.dir.join("comet.key")).ok()?;
        comet_of_keyfile(text.trim())
    }

    /// When the identity here was last exported (cometid.rs).
    pub fn exported_at(&self) -> Option<u64> {
        self.dir.join("comet.key").exists().then(|| crate::cometid::exported_at(&self.dir)).flatten()
    }

    /// Closed for a move of the identity: refused while a start is in
    /// progress (it may be mining or opening the store) and for a fake
    /// ship. True when it was running, to start it again after.
    fn close_for_move(&self) -> Result<bool, String> {
        if self.fake.is_some() {
            return Err("a fake test identity cannot be moved".into());
        }
        let was = match self.status() {
            Status::Booting => {
                return Err("The anonymous identity is still starting. Try again in a moment.".into())
            }
            Status::Ready { .. } => true,
            _ => false,
        };
        if !self.close() {
            return Err("The anonymous identity did not stop in time. Try again in a moment.".into());
        }
        Ok(was)
    }

    /// The identity, for an export file: the engine closed first, so the
    /// store is copied whole, and started again after if it ran. An
    /// exported identity is claimed, so connecting a node keeps it, and
    /// marked exported, so the settings card can warn that it may now run
    /// elsewhere.
    pub fn export_identity(&self) -> Result<crate::cometid::Identity, String> {
        let was = self.close_for_move()?;
        let got = crate::cometid::read_dir(&self.dir, comet_of_keyfile);
        if got.is_ok() {
            self.claim();
        }
        if was {
            self.start();
        }
        got
    }

    /// Make `id` (from an export file) the reader identity, in place of
    /// whatever was here, which is moved aside (cometid::install, never
    /// deleted). The engine is closed for it and started again on the new
    /// identity. `Some(folder)` names where the old one went.
    pub fn import_identity(&self, id: &crate::cometid::Identity) -> Result<Option<PathBuf>, String> {
        if comet_of_keyfile(&id.keyfile).as_deref() != Some(id.ship.as_str()) {
            return Err("That identity file does not hold an anonymous identity.".into());
        }
        self.close_for_move()?;
        let aside = crate::cometid::install(&self.dir, id)?;
        {
            let mut g = self.inner.lock().unwrap();
            g.discard = false;
            g.failed_at = None;
            if matches!(g.status, Status::Failed(_)) {
                g.status = Status::Off;
            }
        }
        if let Some(a) = &aside {
            log_line(&format!("identity replaced by {}, the old one kept in {}", id.ship, a.display()));
        }
        self.start();
        Ok(aside)
    }
}

impl Reads for Engine {
    fn read(&self, url: &str, budget: Duration, wait_boot: bool) -> Result<NativePage, ReadError> {
        Engine::read(self, url, budget, wait_boot)
    }
    fn expire(&self, url: &str) {
        Engine::expire(self, url)
    }
    fn comments_open(&self, ship: &str, budget: Duration) -> Option<Opened> {
        Engine::comments_open(self, ship, budget)
    }
    fn pages(&self, ship: &str) -> Option<Vec<(String, Option<i64>)>> {
        Engine::pages(self, ship)
    }
    fn titles(&self, ship: &str, budget: Duration) -> Option<Vec<PageTitle>> {
        Engine::titles(self, ship, budget)
    }
    fn dir_index(&self, ship: &str, folder: &str, budget: Duration) -> DirIndex {
        Engine::dir_index(self, ship, folder, budget)
    }
    fn forum_open(&self, host: &str, budget: Duration) -> Option<Vec<String>> {
        Engine::forum_open(self, host, budget)
    }
    fn threads(&self, ship: &str, budget: Duration) -> Option<Vec<String>> {
        Engine::threads(self, ship, budget)
    }
    fn thread(&self, ship: &str, page: &str, budget: Duration) -> Option<Vec<PubComment>> {
        Engine::thread(self, ship, page, budget)
    }
    fn forum_write(&self, host: &str, w: ForumWrite, budget: Duration) -> Result<(), CommentError> {
        Engine::forum_write(self, host, w, budget)
    }
    fn step(&self) -> &'static str {
        Engine::step(self)
    }
    fn our(&self) -> Option<String> {
        match self.status() {
            Status::Ready { our } => Some(our),
            _ => None,
        }
    }
    fn comment(&self, ship: &str, page: &str, body: &str, budget: Duration) -> Result<(), CommentError> {
        Engine::comment(self, ship, page, body, budget)
    }
    fn boards(&self, asks: Vec<BoardAsk>, budget: Duration) -> Vec<Result<Js, ReadError>> {
        Engine::boards(self, asks, budget)
    }
}

/// The comet a keyfile names, or `None` when it is not a comet's keyfile
/// (a comet is the one rank wider than 64 bits).
pub fn comet_of_keyfile(text: &str) -> Option<String> {
    let (ship, _, _) = urb_engine::engine::keyfile_ship(text)?;
    (ship.1 != 0).then(|| urb_engine::engine::ship_text(ship))
}

/// The state folder, 0700, made on the engine's first start.
fn make_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    // an existing folder made looser by hand is tightened again
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("{}: {e}", dir.display()))
}

/// An unclaimed comet's files, deleted (the marker last, so a crash
/// part way leaves it to be found next launch). The history is kept.
fn discard_identity(dir: &Path) {
    let names: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    for n in names {
        if n == "comet.key" || [".db", ".db-wal", ".db-shm", ".db-journal", ".db.lock", ".db.port"].iter().any(|x| n.ends_with(x)) {
            let _ = std::fs::remove_file(dir.join(n));
        }
    }
    let _ = std::fs::remove_file(dir.join(UNCLAIMED));
}

/// The first urb:// link in a gemtext page.
fn first_link(body: &str) -> Option<String> {
    body.lines()
        .filter_map(|l| l.strip_prefix("=>"))
        .filter_map(|l| l.split_whitespace().next())
        .find(|u| u.starts_with("urb://~"))
        .map(String::from)
}

fn log_line(l: &str) {
    crate::commands::dlog(&format!("engine: {l}"));
}

/// The folder of ships' points (urb-fetch's FileKeys) inside the state
/// folder `dir`, shared by every identity that runs from it: a point is
/// public, and a comet made after another one then finds the publishers'
/// points on disk instead of asking the roller. Not for a fake ship, whose
/// network is the fleet's.
fn key_cache(dir: &Path, fake: Option<&str>) -> Option<std::rc::Rc<dyn urb_engine::keys::KeyStore>> {
    fake.is_none().then(|| std::rc::Rc::new(urb_engine::host::keys::FileKeys::new(dir.join(KEYS))) as _)
}

/// key_cache's folder in the state folder
const KEYS: &str = "keys";

/// The host's thread: find or mine the identity, open it, then take jobs
/// and turn the host until closed.
fn host_thread(dir: &Path, fake: Option<&str>, inner: &Arc<Mutex<Inner>>, jobs: Receiver<Job>) {
    let fail = |m: String| {
        log_line(&format!("start failed: {m}"));
        let mut g = inner.lock().unwrap();
        g.status = Status::Failed(m);
        g.failed_at = Some(Instant::now());
        g.run = None;
    };
    if let Err(e) = make_dir(dir) {
        return fail(e);
    }
    let log: Log = Arc::new(log_line);
    libmesa_log(log.clone());
    let step = |w: &'static str| inner.lock().unwrap().step = w;
    if fake.is_none() && !dir.join("comet.key").exists() {
        step("Setting up this computer");
    }
    let fake = match fake.map(|f| fake_name(dir, f)).transpose() {
        Ok(f) => f,
        Err(e) => return fail(e),
    };
    let fake = fake.as_deref();
    let found = match find_state(dir, fake.unwrap_or("")) {
        Ok(f) => f,
        Err(e) => return fail(e),
    };
    // a ship was connected while the comet was made: no network with it
    if inner.lock().unwrap().discard && dir.join(UNCLAIMED).exists() {
        drop(found);
        return discarded(dir, inner);
    }
    let udp = GatewayUdp { fake: fake.is_some(), port: found.port, log: log.clone(), udp: None };
    let io = NetIo::new(Box::new(udp), Box::new(found.store), log);
    let waker = io.waker();
    if let Some(run) = &mut inner.lock().unwrap().run {
        run.waker = Some(waker);
    }
    step("Joining the Urbit network");
    let mut host = Host::new(io, random);
    if let Some(keys) = key_cache(dir, fake) {
        host.set_keys(keys);
    }
    let our = match host.open(fake.is_some()) {
        Ok(o) => o,
        Err(f) => return fail(f.message),
    };
    log_line(&format!("running as {our}"));
    {
        // one lock, so a drop_unclaimed that saw the start in progress is
        // seen here
        let mut g = inner.lock().unwrap();
        if !(g.discard && dir.join(UNCLAIMED).exists()) {
            g.status = Status::Ready { our };
            // an exported identity still running here gets the reader's banner
            if fake.is_none() {
                crate::render::set_exported_running(crate::cometid::exported_at(dir));
            }
        } else {
            drop(g);
            let _ = host.close();
            return discarded(dir, inner);
        }
    }
    let mut pending: Vec<(u64, Wait, Instant)> = Vec::new();
    loop {
        loop {
            match jobs.try_recv() {
                Ok(Job::Read(url, tx)) => {
                    pending.push((submit_read(&mut host, url.clone()), Wait::Read(tx, url), Instant::now()))
                }
                Ok(Job::Pages(ship, tx)) => {
                    let _ = tx.send(host.core().cached_revs(&ship).map(|l| l.into_iter().map(|(k, _)| k).collect()));
                }
                Ok(Job::Expire(ship)) => {
                    log_line(&format!("expire the revision list of {ship}"));
                    host.core().expire_revs(&ship);
                }
                Ok(Job::Comment(c, tx)) => {
                    log_line(&format!("comment to {} on {} at {}", c.ship, c.page, c.base));
                    pending.push((submit_comment(&mut host, c), Wait::Comment(tx, "comment"), Instant::now()))
                }
                Ok(Job::OpenList(ship, base, list, tx)) => {
                    pending.push((submit_open_list(&mut host, ship, base, list), Wait::OpenList(tx), Instant::now()))
                }
                Ok(Job::Thread(ship, base, page, tx)) => {
                    pending.push((submit_thread(&mut host, ship, base, &page), Wait::OpenList(tx), Instant::now()))
                }
                Ok(Job::DirIndex(ship, base, folder, tx)) => {
                    pending.push((submit_dir_index(&mut host, ship, base, &folder), Wait::OpenList(tx), Instant::now()))
                }
                Ok(Job::ForumWrite(to, w, tx)) => {
                    log_line(&format!("forum write to {to}"));
                    pending.push((submit_forum_write(&mut host, to, w), Wait::Comment(tx, "forum write"), Instant::now()))
                }
                Ok(Job::Board(a, tx)) => {
                    log_line(&format!("board read {a:?}"));
                    pending.push((submit_board(&mut host, a), Wait::Board(tx), Instant::now()))
                }
                Ok(Job::Close(done)) => {
                    let _ = host.close();
                    // the store closed before the answer, so a caller
                    // that copies it (cometid's export) copies it whole
                    drop(host);
                    let _ = done.send(());
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

/// The end of a start whose unclaimed comet is to go.
fn discarded(dir: &Path, inner: &Arc<Mutex<Inner>>) {
    log_line("deleting the unclaimed reader identity");
    discard_identity(dir);
    let mut g = inner.lock().unwrap();
    g.status = Status::Off;
    g.run = None;
    g.discard = false;
}

/// A fake identity for tests. `new-moon-of:~ship` is a moon of that ship
/// (a galaxy, star or planet) made up once per state folder and kept in its `fake-moon`: a
/// publisher remembers each identity's flows, so a fresh folder must not
/// reuse a name an earlier run used.
fn fake_name(dir: &Path, fake: &str) -> Result<String, String> {
    let Some(parent) = fake.strip_prefix("new-moon-of:") else { return Ok(fake.to_string()) };
    let kept = dir.join("fake-moon");
    if let Ok(name) = std::fs::read_to_string(&kept) {
        return Ok(name.trim().to_string());
    }
    let name = moon_of(parent)?;
    std::fs::write(&kept, format!("{name}\n")).map_err(|e| format!("{}: {e}", kept.display()))?;
    Ok(name)
}

/// A moon of `parent` no one has used, by its random high half.
fn moon_of(parent: &str) -> Result<String, String> {
    let (lo, hi) = urb_engine::engine::ship_parse(parent).ok_or_else(|| format!("not a ship: {parent}"))?;
    if hi != 0 || lo >> 32 != 0 {
        return Err(format!("{parent} has no moons"));
    }
    let r = random(4);
    let high = u32::from_be_bytes([r[0], r[1], r[2], r[3]]).max(1) as u64;
    Ok(urb_engine::engine::ship_text(((high << 32) | lo, 0)))
}

/// `state::find`, and when a file in the folder is damaged (a keyfile cut
/// short by a crash while it was mined, a store SQLite cannot open, a port
/// file that is not a number), the damage set aside and one more try. A
/// damaged port only costs the port, kept by the same identity. A damaged
/// keyfile or store costs the identity: the keyfile and every store in the
/// folder go into `damaged-<ms>/` (never deleted), and a new comet is made.
/// A store held by another lattice is not damage and is left alone.
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

/// What a `state::find` failure says is damaged, by state.rs's and
/// libmesa's words.
fn damage(e: &str) -> Damage {
    if e.ends_with("is in use by another process") || e.ends_with("can't open lockfile") {
        Damage::None
    } else if e.starts_with("strconv.Atoi: parsing") || e.starts_with("invalid port") {
        Damage::Port
    } else if e.ends_with(": mesa: not a keyfile")
        || e.ends_with(": can't open database")
        || e.ends_with(": can't initialize database")
        || e.ends_with(": can't prepare statements")
    {
        Damage::Identity
    } else {
        Damage::None
    }
}

/// Move the damaged files out of the way (see find_state).
fn set_aside(dir: &Path, what: Damage) -> Result<(), String> {
    let names: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    let gone = |n: &str| match what {
        Damage::Port => n.ends_with(".db.port"),
        Damage::Identity => {
            n == "comet.key" || [".db", ".db-wal", ".db-shm", ".db.port"].iter().any(|x| n.ends_with(x))
        }
        Damage::None => false,
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let aside = dir.join(format!("damaged-{stamp}"));
    for n in names.iter().filter(|n| gone(n)) {
        if what == Damage::Port && std::fs::read_to_string(dir.join(n)).is_ok_and(|t| t.trim().parse::<u16>().is_ok()) {
            continue;
        }
        std::fs::create_dir_all(&aside).map_err(|e| format!("{}: {e}", aside.display()))?;
        std::fs::rename(dir.join(n), aside.join(n)).map_err(|e| format!("{n}: {e}"))?;
    }
    Ok(())
}

/// A read: one of the two requests the engine ever makes.
fn submit_read<I: urb_engine::host::Io>(host: &mut Host<I>, url: String) -> u64 {
    host.submit(Request::Read(url))
}

/// A board read: the read calls of furum's and lattice's forum readers,
/// and no others (`only_reads_and_comments_are_submitted`).
fn submit_board<I: urb_engine::host::Io>(host: &mut Host<I>, a: BoardAsk) -> u64 {
    host.submit(match a {
        BoardAsk::Forum { host, board } => Request::Forum { host, call: ForumCall::Board(board) },
        BoardAsk::ForumThread { host, board, post } => Request::Forum {
            host,
            call: ForumCall::Thread(board, urb_engine::msg::Id::Big(false, post)),
        },
        BoardAsk::FurumPosts { host, board } => Request::Furum { host, call: FurumCall::Posts(board) },
        BoardAsk::FurumComments { host, board, post } => {
            Request::Furum { host, call: FurumCall::Comments(board, post as f64) }
        }
    })
}

/// A board read's result as the app sees it.
fn board_of(r: Result<Reply, Failure>) -> Result<Js, ReadError> {
    match r {
        Ok(Reply::Js(j)) => Ok(j),
        Ok(_) => Err(ReadError::Failed("the read gave no board".into())),
        Err(f) => Err(error_of(&f)),
    }
}

/// A comment, the engine's only write: `[page=path body=@t]` (lattice's
/// `comment-action`) to the publisher's `comments.sig`. The publisher takes
/// the author from the transport, so it names the reader identity.
fn submit_comment<I: urb_engine::host::Io>(host: &mut Host<I>, c: Comment) -> u64 {
    host.submit(Request::Poke {
        ship: c.ship,
        folder: c.base.into(),
        name: "comments.sig".into(),
        mark: ("/lattice".into(), "comment-action".into()),
        value: comment_noun(&c.page, &c.body),
    })
}

/// A forum write: the forum reader's newPost or newComment, and never a
/// vote (`only_reads_and_comments_are_submitted`).
fn submit_forum_write<I: urb_engine::host::Io>(host: &mut Host<I>, to: String, w: ForumWrite) -> u64 {
    host.submit(Request::Forum { host: to, call: forum_call(w) })
}

/// the forum reader's call for a write
fn forum_call(w: ForumWrite) -> ForumCall {
    let big = |i: Int| urb_engine::msg::Id::Big(false, i);
    match w {
        ForumWrite::Post { board, title, url, body } => ForumCall::NewPost { name: board, title: Some(title), url, body },
        ForumWrite::Reply { board, post, parent, body } => {
            ForumCall::NewComment { name: board, post: big(post), body: Some(body), parent: parent.map(big) }
        }
    }
}

/// The cords the engine peeks, beside the pages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum List {
    /// `/pub/comments`, the published pages that take comments
    Comments,
    /// `/pub/comets`, each page's comet policy when it is not plain open
    Comets,
    /// `/pub/forum-comets`, the forum boards that take comet posts
    ForumComets,
    /// `/pub/threads`, the published pages with a public comment list
    Threads,
    /// `/pub/titles`, each published page's last change and title
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

/// The engine's one peek, a read of no page: one of lattice's lists
/// (`List`), as a cord. It is under `/pub`, which lattice opens to every
/// foreign ship as it opens the pages.
fn submit_open_list<I: urb_engine::host::Io>(host: &mut Host<I>, ship: String, base: &str, list: List) -> u64 {
    host.submit(Request::Peek {
        ship,
        folder: format!("{base}/pub"),
        name: Some(list.name().into()),
        conv: urb_engine::core::Conv::Cord,
        wait: Some(PEEK_WAIT_MS),
    })
}

/// The other peek: a page's public comment list, the file `list` in the
/// dir `/pub/thread/<page>`. `page` is a `thread_page`.
fn submit_thread<I: urb_engine::host::Io>(host: &mut Host<I>, ship: String, base: &str, page: &str) -> u64 {
    host.submit(Request::Peek {
        ship,
        folder: format!("{base}/pub/thread{page}"),
        name: Some("list".into()),
        conv: urb_engine::core::Conv::Cord,
        wait: Some(PEEK_WAIT_MS),
    })
}

/// The third peek: a granted folder's index, the file `dir-index` in the
/// folder's own dir under `/page`, which lattice lets only the ships the
/// folder is granted to read. `folder` is a `thread_page`.
fn submit_dir_index<I: urb_engine::host::Io>(host: &mut Host<I>, ship: String, base: &str, folder: &str) -> u64 {
    host.submit(Request::Peek {
        ship,
        folder: format!("{base}/page{folder}"),
        name: Some("dir-index".into()),
        conv: urb_engine::core::Conv::Cord,
        wait: Some(PEEK_WAIT_MS),
    })
}

/// A page's key as the path under `/pub/thread`: `/<seg>/<seg>...`, each
/// segment non-empty and not `.` or `..`, nothing but the characters a
/// lattice path segment takes. `None` for anything else.
pub fn thread_page(key: &str) -> Option<String> {
    let segs: Vec<&str> = key.trim_start_matches('/').split('/').collect();
    let ok = |s: &&str| {
        !s.is_empty()
            && *s != "."
            && *s != ".."
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
    };
    (segs.iter().all(ok)).then(|| format!("/{}", segs.join("/")))
}

/// The most of a public comment list the reader takes.
pub const THREAD_MAX: usize = 1024 * 1024;

/// A page's public comment list, `{"v":1,"comments":[{"id", "author",
/// "when", "body"}]}`, oldest first. A comment without an author or a body
/// is skipped, other fields are ignored, and a list over THREAD_MAX or not
/// that shape is empty.
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
                author: text("author")?,
                when: c.get("when").and_then(|w| w.as_i64().or_else(|| w.as_f64().map(|f| f as i64))).unwrap_or(0),
                body: text("body")?,
            })
        })
        .collect()
}

/// lattice's `comment-action`: the page's path, then the text
fn comment_noun(page: &str, body: &str) -> Value<'static> {
    Value::Array(vec![urb_engine::codec::path(page), Value::Text(body.into())])
}

/// A cord peek's result: the text, or `None` when the publisher has no
/// such grub.
fn cord_of(r: Result<Reply, Failure>) -> Result<Option<String>, String> {
    match r {
        Ok(Reply::Peek(urb_engine::core::Peeked::Text(t))) => Ok(Some(t)),
        Ok(Reply::Peek(urb_engine::core::Peeked::Null)) => Ok(None),
        Ok(_) => Err("the peek gave no text".into()),
        Err(f) => Err(f.message),
    }
}

/// `/pub/comments`'s cord: one published page's name a line
pub fn open_names(cord: &str) -> Vec<String> {
    cord.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

/// `/pub/titles`'s cord: a line a published page,
/// `<key>\t<unix-seconds>\t<title>`, the key as the revision list names it
/// and the title, which may be empty, with no tab or newline. A line that
/// is not that (no key, a time that is not a number, a tab too many or too
/// few) is skipped.
pub fn page_titles(cord: &str) -> Vec<PageTitle> {
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

/// `/pub/comets`'s cord: a line a page, `<name> <mode>` or
/// `<name> <mode> <until>`, `<mode>` one of `open`, `held` or `off` and
/// `<until>` the unix second the page's comet cap lasts to. A line that is
/// not that is skipped; a mode not known is open.
pub fn comet_policies(cord: &str) -> Vec<(String, Comets)> {
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

/// A comment's result as the app sees it.
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

/// A read's result as the app sees it.
fn result_of(r: Result<Reply, Failure>) -> Result<NativePage, ReadError> {
    match r {
        Ok(Reply::Read(p)) if p.body.len() > MAX_BODY => Err(ReadError::Failed(format!(
            "the page is {} MB, over the reader's {} MB",
            p.body.len() / (1024 * 1024),
            MAX_BODY / (1024 * 1024)
        ))),
        Ok(Reply::Read(p)) => Ok(NativePage {
            key: p.key,
            mark: p.mark.unwrap_or_else(|| "gmi".into()),
            body: p.body,
            how: p.how.into(),
        }),
        Ok(_) => Err(ReadError::Failed("the read gave no page".into())),
        Err(f) => Err(error_of(&f)),
    }
}

/// A core failure, by the gateway's codes and words.
fn error_of(f: &Failure) -> ReadError {
    let (status, words) = urb_gateway::routes::fail_of(f);
    let words = String::from_utf8_lossy(&words).into_owned();
    match status {
        404 => ReadError::NotPublished(words),
        504 => ReadError::Unreachable { later: true, words },
        _ if f.later => ReadError::Unreachable { later: true, words },
        _ => ReadError::Failed(words),
    }
}

/// Why the engine could not start, as a read's error.
fn boot_error(m: &str) -> ReadError {
    if m.ends_with("is in use by another process") {
        ReadError::Busy
    } else {
        ReadError::Failed(plain_boot(m))
    }
}

/// A failed start in words for someone new to Urbit. The first start
/// fetches a list over HTTPS (`state::mine_comet`, "Get ..."); with no
/// connection that is what fails. The engine's own words are in the log.
pub fn plain_boot(m: &str) -> String {
    if m.starts_with("Get \"") || m.starts_with("mesa: comet-stars") {
        "lattice couldn't reach the internet to set up the reader. Check your connection and try again.".into()
    } else {
        format!("The reader couldn't start: {m}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use urb_engine::core::{Kind, Page, NO_LATTICE};

    fn page(body: &str, mark: Option<&str>) -> Result<Reply, Failure> {
        Ok(Reply::Read(Page {
            key: "/k".into(),
            body: body.into(),
            how: "keen",
            mark: mark.map(Into::into),
        }))
    }

    /// The rule as a test: the engine reads, and its writes are a comment
    /// to a publisher's comment inbox and a post or reply on a lattice
    /// forum board. Every request it names is a Read, a board read, that
    /// Poke, a forum write, or one Peek of a list under the publisher's
    /// `/pub`; it submits in five places, and it never publishes or hears
    /// an inbox. Its forum and furum calls are the readers' read calls and
    /// the forum's newPost and newComment, by name: never a vote, a note or
    /// a furum write. A change that needs any of those has to change this
    /// test on purpose.
    #[test]
    fn only_reads_and_comments_are_submitted() {
        let src = include_str!("engine.rs");
        let code = &src[..src.find("\n#[cfg(test)]\nmod tests").expect("the tests")];
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
                "ForumCall::NewComment"
            ],
            "only the board readers' read calls, and a forum post or reply"
        );
        assert_eq!(code.matches(".submit(").count(), 7, "seven submits: read, board, comment, forum write, open list, thread, dir index");
        assert_eq!(code.matches("submit_dir_index(").count(), 1, "submit_dir_index, called once");
        // the dir-index peek reads a folder's index under /page and nothing else
        let peek = &code[code.find("fn submit_dir_index<").unwrap()..];
        let peek = &peek[..peek.find("\n}\n").unwrap()];
        assert!(peek.contains("folder: format!(\"{base}/page{folder}\")") && peek.contains("name: Some(\"dir-index\".into())"), "{peek}");
        assert_eq!(code.matches("submit_thread(").count(), 1, "submit_thread, called once");
        // the thread peek reads a page's list under /pub/thread and nothing else
        let peek = &code[code.find("fn submit_thread<").unwrap()..];
        let peek = &peek[..peek.find("\n}\n").unwrap()];
        assert!(peek.contains("folder: format!(\"{base}/pub/thread{page}\")") && peek.contains("name: Some(\"list\".into())"), "{peek}");
        assert_eq!(code.matches("submit_forum_write(").count(), 1, "submit_forum_write, called once");
        assert_eq!(code.matches("submit_board(").count(), 1, "submit_board, called once");
        assert_eq!(code.matches("submit_open_list(").count(), 1, "submit_open_list, called once");
        // the peek reads one of lattice's lists under /pub and nothing else
        let peek = &code[code.find("fn submit_open_list<").unwrap()..];
        let peek = &peek[..peek.find("\n}\n").unwrap()];
        assert!(peek.contains("folder: format!(\"{base}/pub\")") && peek.contains("name: Some(list.name().into())"), "{peek}");
        let names = &code[code.find("impl List {").unwrap()..];
        let names = &names[..names.find("\n}\n").unwrap()];
        let quoted: Vec<&str> = names.split('"').skip(1).step_by(2).collect();
        assert_eq!(quoted, ["comments", "comets", "forum-comets", "threads", "titles"], "{names}");
        assert_eq!(code.matches("submit_read(").count(), 1, "submit_read, called once");
        assert_eq!(code.matches("submit_comment(").count(), 1, "submit_comment, called once");
        // a forum write is logged as one, not as a comment
        assert!(code.contains("Wait::Comment(tx, \"comment\")") && code.contains("Wait::Comment(tx, \"forum write\")"));
        // the poke goes to the comment inbox, with lattice's comment mark
        let poke = &code[code.find("fn submit_comment<").unwrap()..];
        let poke = &poke[..poke.find("\n}\n").unwrap()];
        assert!(poke.contains("name: \"comments.sig\".into()"), "{poke}");
        assert!(poke.contains("mark: (\"/lattice\".into(), \"comment-action\".into())"), "{poke}");
    }

    #[test]
    fn a_public_comment_list_is_read_and_bounded() {
        let got = thread_list(
            r#"{"v":1,"extra":true,"comments":[
              {"id":"0v1","author":"~sampel-palnet","when":1730000000000,"body":"first <b>\nline","x":1},
              {"id":"0v2","author":"~zod","body":"no time"},
              {"id":"0v3","body":"no author"},
              {"author":"~nec","when":5,"body":""}]}"#,
        );
        let c = |id: &str, author: &str, when, body: &str| PubComment { id: id.into(), author: author.into(), when, body: body.into() };
        assert_eq!(
            got,
            [
                c("0v1", "~sampel-palnet", 1_730_000_000_000, "first <b>\nline"),
                c("0v2", "~zod", 0, "no time"),
                c("", "~nec", 5, ""),
            ]
        );
        for bad in ["", "not json", "{\"v\":1}", "{\"comments\":{}}", "[1,2]"] {
            assert!(thread_list(bad).is_empty(), "{bad}");
        }
        let big = format!("{{\"comments\":[{{\"author\":\"~zod\",\"body\":\"{}\"}}]}}", "x".repeat(THREAD_MAX));
        assert!(thread_list(&big).is_empty(), "over the cap is empty");
        assert_eq!(open_names("/blog/post\n\n /notes/a \n"), ["/blog/post", "/notes/a"]);
    }

    #[test]
    fn a_thread_peek_names_only_a_plain_page_path() {
        assert_eq!(thread_page("/blog/post").as_deref(), Some("/blog/post"));
        assert_eq!(thread_page("blog/post").as_deref(), Some("/blog/post"));
        for bad in ["", "/", "/a//b", "/a/../b", "/a/.", "/a b", "/a/b/", "/a%2fb"] {
            assert_eq!(thread_page(bad), None, "{bad}");
        }
    }

    #[test]
    fn page_titles_are_read_line_by_line() {
        let t = |key: &str, secs, title: &str| PageTitle { key: key.into(), secs, title: title.into() };
        let got = page_titles(
            "/site/docs/one\t1700000000\tThe first one\n/site/docs/two\t1700000001\t\n\
             /site/x\tsoon\tNo time\n/site/y\t1\tA\ttab too many\n/site/z\t2\n\
             no-slash\t3\tNo key\n\n  \n/a b\t-5\t  spaced  \r\n/last\t4\tLast",
        );
        assert_eq!(
            got,
            [
                t("/site/docs/one", 1_700_000_000, "The first one"),
                t("/site/docs/two", 1_700_000_001, ""),
                t("/a b", -5, "  spaced  "),
                t("/last", 4, "Last"),
            ]
        );
        assert!(page_titles("").is_empty());
    }

    #[test]
    fn comet_policies_are_read_line_by_line() {
        let c = |mode, full_until| Comets { mode, full_until };
        let got = comet_policies(
            "/notes/a held\n/notes/b off\n/notes/c open 1700000000\n/notes/d held 1700000001\n\
             /notes/e sideways\n/notes/f held soon\n/notes/g\n/notes/h off 1 2\n\n  \n",
        );
        assert_eq!(
            got,
            [
                ("/notes/a".to_string(), c(CometMode::Held, None)),
                ("/notes/b".to_string(), c(CometMode::Off, None)),
                ("/notes/c".to_string(), c(CometMode::Open, Some(1_700_000_000))),
                ("/notes/d".to_string(), c(CometMode::Held, Some(1_700_000_001))),
                ("/notes/e".to_string(), c(CometMode::Open, None)),
            ]
        );
        assert!(comet_policies("").is_empty());
    }

    #[test]
    fn a_forum_write_is_the_forum_readers_new_post_or_comment() {
        let big = |n: u8| Int::from_le(&[n]);
        match forum_call(ForumWrite::Post { board: "b".into(), title: "t".into(), url: None, body: Some("x".into()) }) {
            ForumCall::NewPost { name, title, url, body } => {
                assert_eq!((name.as_str(), title.as_deref(), url, body.as_deref()), ("b", Some("t"), None, Some("x")))
            }
            c => panic!("{c:?}"),
        }
        match forum_call(ForumWrite::Reply { board: "b".into(), post: big(7), parent: None, body: "r".into() }) {
            ForumCall::NewComment { name, post: urb_engine::msg::Id::Big(false, p), body, parent: None } => {
                assert_eq!((name.as_str(), p.decimal().as_str(), body.as_deref()), ("b", "7", Some("r")))
            }
            c => panic!("{c:?}"),
        }
    }

    #[test]
    fn a_comment_is_lattices_comment_action() {
        use urb_engine::Noun;
        let n = Noun::of(&comment_noun("/notes/a", "hi")).unwrap();
        let want = Noun::cell(
            Noun::cell(Noun::atom(b"notes"), Noun::cell(Noun::atom(b"a"), Noun::atom(&[]))),
            Noun::atom(b"hi"),
        );
        assert!(n == want);
    }

    #[test]
    fn a_comments_answer_says_what_happened() {
        use urb_engine::core::Poked;
        let poked = |ok, error: Option<&str>, later| Ok(Reply::Poke(Poked { ok, error: error.map(Into::into), later }));
        assert_eq!(said_of(poked(true, None, false)), Ok(()));
        assert_eq!(said_of(poked(false, Some("weir: denied"), false)), Err(CommentError::Refused("weir: denied".into())));
        assert_eq!(said_of(poked(false, None, false)), Err(CommentError::Refused("refused".into())));
        assert_eq!(
            said_of(poked(false, Some("~zod did not answer"), true)),
            Err(CommentError::Unanswered("~zod did not answer".into()))
        );
        assert!(matches!(said_of(Ok(Reply::True)), Err(CommentError::Failed(_))));
        let f = Failure { later: true, ..Failure::urb("timeout") };
        assert!(matches!(said_of(Err(f)), Err(CommentError::Unanswered(_))));
    }

    #[test]
    fn a_comment_needs_a_running_reader() {
        let e = Engine::with(tmp("nocomment"), None);
        assert!(matches!(
            e.comment("~zod", "/a", "hi", Duration::from_secs(1)),
            Err(CommentError::Failed(m)) if m.contains("isn't ready")
        ));
    }

    #[test]
    fn failures_map_by_the_gateways_codes() {
        let f = |m: &str, later| Failure { later, ..Failure::urb(m) };
        assert_eq!(
            error_of(&f("urb://~zod/x: not published", false)),
            ReadError::NotPublished("urb://~zod/x is not published".into())
        );
        assert!(matches!(
            error_of(&f(&format!("~zod {NO_LATTICE}"), true)),
            ReadError::Unreachable { later: true, words } if words.starts_with("~zod did not answer")
        ));
        assert!(matches!(
            error_of(&f(&format!("~zod {NO_LATTICE}"), false)),
            ReadError::Failed(w) if w.contains("shares no lattice pages")
        ));
        assert!(matches!(
            error_of(&Failure { kind: Kind::Error, message: "timeout".into(), later: true }),
            ReadError::Unreachable { later: true, .. }
        ));
        assert_eq!(boot_error("mesa: /x/fake.db is in use by another process"), ReadError::Busy);
        assert_eq!(boot_error("no network"), ReadError::Failed("The reader couldn't start: no network".into()));
        let offline = "Get \"https://bootstrap.urbit.org/comet-stars.jam\": Dns Failed: resolve dns name";
        assert!(matches!(boot_error(offline), ReadError::Failed(m) if m.contains("couldn't reach the internet")));
    }

    #[test]
    fn a_page_reads_with_its_mark_or_as_gemtext() {
        let p = result_of(page("# hi", Some("md"))).unwrap();
        assert_eq!((p.mark.as_str(), p.body.as_str(), p.how.as_str()), ("md", "# hi", "keen"));
        assert_eq!(result_of(page("x", None)).unwrap().mark, "gmi");
        assert!(matches!(result_of(Ok(Reply::True)), Err(ReadError::Failed(_))));
    }

    #[test]
    fn a_body_over_four_megabytes_is_refused() {
        let big = "x".repeat(MAX_BODY + 1);
        assert!(matches!(result_of(page(&big, None)), Err(ReadError::Failed(m)) if m.contains("over")));
        let ok = "x".repeat(MAX_BODY);
        assert!(result_of(page(&ok, None)).is_ok());
    }

    #[test]
    fn a_fake_moon_is_made_once_per_folder() {
        let m = moon_of("~wep").unwrap();
        assert!(m.ends_with("-dozzod-dozwep") && m.len() == "~bidlys-donref-dozzod-dozwep".len(), "{m}");
        assert_ne!(m, moon_of("~wep").unwrap());
        assert!(moon_of(&m).is_err() && moon_of("nope").is_err());
        let tmp = std::env::temp_dir().join(format!("engine-moon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let a = fake_name(&tmp, "new-moon-of:~wep").unwrap();
        assert_eq!(fake_name(&tmp, "new-moon-of:~wep").unwrap(), a);
        assert_eq!(fake_name(&tmp, "~zod").unwrap(), "~zod");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    fn tmp(name: &str) -> PathBuf {
        let t = std::env::temp_dir().join(format!("engine-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        t
    }

    /// The setup page reloads every 2 s and each reload reads: a failed
    /// start must then say why, not start again and say "setting up".
    #[test]
    fn a_failed_start_says_why_and_waits_before_trying_again() {
        let t = tmp("refail");
        std::fs::create_dir_all(&t).unwrap();
        // the state folder's place is taken by a file, so the start fails
        std::fs::write(t.join("urb"), b"x").unwrap();
        let e = Engine::with(t.join("urb"), Some("~zod".into()));
        assert_eq!(e.read("urb://~zod/x", Duration::from_secs(5), false), Err(ReadError::Booting));
        for _ in 0..200 {
            if matches!(e.status(), Status::Failed(_)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(e.status(), Status::Failed(_)), "{:?}", e.status());
        for _ in 0..3 {
            let got = e.read("urb://~zod/x", Duration::from_secs(5), false);
            assert!(matches!(got, Err(ReadError::Failed(ref m)) if m.starts_with("The reader couldn't start")), "{got:?}");
            assert!(matches!(e.status(), Status::Failed(_)));
        }
        // after the wait, a read starts it again
        e.inner.lock().unwrap().failed_at = Some(Instant::now() - RETRY_AFTER);
        assert_eq!(e.read("urb://~zod/x", Duration::from_secs(5), false), Err(ReadError::Booting));
        for _ in 0..200 {
            if matches!(e.status(), Status::Failed(_)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn damage_is_told_from_a_store_in_use() {
        assert_eq!(damage("mesa: /d/x.db is in use by another process"), Damage::None);
        assert_eq!(damage("/d/x.db: can't open lockfile"), Damage::None);
        assert_eq!(damage("strconv.Atoi: parsing \"zz\": invalid syntax"), Damage::Port);
        assert_eq!(damage("invalid port 70000"), Damage::Port);
        assert_eq!(damage("/d/comet.key: mesa: not a keyfile"), Damage::Identity);
        assert_eq!(damage("/d/x.db: can't initialize database"), Damage::Identity);
        assert_eq!(damage("open /d/comet.key: permission denied"), Damage::None);
        assert_eq!(damage("Get \"https://x\": timeout"), Damage::None);
    }

    /// A fake ship, so no network: find_state opens the store and the port.
    #[test]
    fn a_damaged_port_file_is_replaced_and_the_identity_kept() {
        let t = tmp("badport");
        std::fs::create_dir_all(&t).unwrap();
        let ship = "~bidlys-donref-dozzod-dozwep";
        let port = t.join("fake-bidlys-donref-dozzod-dozwep.db.port");
        drop(find_state(&t, ship).unwrap());
        assert!(t.join("fake-bidlys-donref-dozzod-dozwep.db").exists());
        std::fs::write(&port, b"not a port").unwrap();
        let f = find_state(&t, ship).unwrap();
        assert_eq!(std::fs::read_to_string(&port).unwrap().trim(), f.port.to_string());
        drop(f);
        let aside: Vec<_> = std::fs::read_dir(&t).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("damaged-")).collect();
        assert_eq!(aside.len(), 1);
        let kept: Vec<String> = std::fs::read_dir(aside[0].path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(kept, ["fake-bidlys-donref-dozzod-dozwep.db.port"], "only the port goes");
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn a_damaged_store_is_set_aside_with_its_keyfile() {
        let t = tmp("baddb");
        std::fs::create_dir_all(&t).unwrap();
        let ship = "~bidlys-donref-dozzod-dozwep";
        let db = t.join("fake-bidlys-donref-dozzod-dozwep.db");
        std::fs::write(&db, vec![0x5au8; 8192]).unwrap();
        std::fs::write(t.join("comet.key"), b"0wkey\n").unwrap();
        std::fs::write(t.join("history.json"), b"[]").unwrap();
        let direct = state::find(&t, "", false, ship).err().unwrap_or_default();
        assert_eq!(damage(&direct), Damage::Identity, "{direct}");
        drop(find_state(&t, ship).unwrap());
        let aside = std::fs::read_dir(&t).unwrap().flatten().find(|e| e.file_name().to_string_lossy().starts_with("damaged-")).unwrap().path();
        assert_eq!(std::fs::read(aside.join("fake-bidlys-donref-dozzod-dozwep.db")).unwrap(), vec![0x5au8; 8192]);
        assert_eq!(std::fs::read(aside.join("comet.key")).unwrap(), b"0wkey\n");
        // the history is the reader's, not the identity's
        assert!(t.join("history.json").exists() && !t.join("comet.key").exists());
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn a_keyfile_cut_short_is_set_aside() {
        let t = tmp("badkey");
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(t.join("comet.key"), b"").unwrap();
        let e = state::find(&t, "", false, "").err().unwrap_or_default();
        assert_eq!(damage(&e), Damage::Identity, "{e}");
        std::fs::write(t.join("ab.db"), b"x").unwrap();
        std::fs::write(t.join("ab.db.port"), b"30000\n").unwrap();
        set_aside(&t, Damage::Identity).unwrap();
        let left: Vec<String> = std::fs::read_dir(&t).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left.len(), 1, "{left:?}");
        assert!(left[0].starts_with("damaged-"));
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn the_warm_up_follows_the_first_urb_link() {
        let body = "# Start\n=> https://x.example not this\n=>urb://~zod/a First\n=> urb://~nec/b\n";
        assert_eq!(first_link(body).as_deref(), Some("urb://~zod/a"));
        assert_eq!(first_link("# none\nurb://~zod/a\n"), None);
    }

    /// A comet made for the first-run page and never used is not kept; a
    /// used one is, and so is the history either way.
    #[test]
    fn an_unclaimed_identity_goes_and_a_claimed_one_stays() {
        let t = tmp("unclaimed");
        let e = Engine::with(t.clone(), None);
        let made = |t: &Path| {
            make_dir(t).unwrap();
            for n in ["comet.key", "ab.db", "ab.db-wal", "ab.db.port", "history.json", UNCLAIMED] {
                std::fs::write(t.join(n), b"x").unwrap();
            }
        };
        made(&t);
        assert!(!e.claimed(), "made at launch, not yet used");
        e.drop_unclaimed();
        let left: Vec<String> = std::fs::read_dir(&t).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, ["history.json"]);
        made(&t);
        e.claim();
        assert!(e.claimed());
        e.drop_unclaimed();
        assert!(t.join("comet.key").exists() && t.join("ab.db").exists());
        // a start in progress is left to delete it itself
        std::fs::write(t.join(UNCLAIMED), b"").unwrap();
        e.inner.lock().unwrap().status = Status::Booting;
        e.drop_unclaimed();
        assert!(t.join("comet.key").exists() && e.inner.lock().unwrap().discard);
        std::fs::remove_dir_all(&t).unwrap();
    }

    /// Two launches that never read: the second reuses the first's comet,
    /// still unclaimed, and mints nothing.
    #[test]
    fn launches_without_reading_reuse_one_unclaimed_comet() {
        let t = tmp("reuse");
        let first = Engine::with(t.clone(), None);
        first.mark_unclaimed().unwrap();
        assert!(t.join(UNCLAIMED).exists());
        // what the first launch's start mined
        std::fs::write(t.join("comet.key"), b"0wfirst\n").unwrap();
        first.close();
        let second = Engine::with(t.clone(), None);
        second.mark_unclaimed().unwrap();
        assert_eq!(std::fs::read(t.join("comet.key")).unwrap(), b"0wfirst\n");
        assert!(t.join(UNCLAIMED).exists() && !second.claimed());
        second.claim();
        assert!(second.claimed());
        std::fs::remove_dir_all(&t).unwrap();
    }

    /// A ship connected while the reader got ready: the start ends without
    /// the network, and its identity is gone.
    #[test]
    fn a_discarded_start_deletes_its_identity() {
        let t = tmp("discard");
        let e = Engine::fake(t.clone(), "~bidlys-donref-dozzod-dozwep");
        make_dir(&t).unwrap();
        std::fs::write(t.join(UNCLAIMED), b"").unwrap();
        e.inner.lock().unwrap().discard = true;
        e.start();
        for _ in 0..200 {
            if e.status() != Status::Booting {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(e.status(), Status::Off);
        assert!(!t.join("fake-bidlys-donref-dozzod-dozwep.db").exists() && !t.join(UNCLAIMED).exists());
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn new_makes_nothing_on_disk() {
        let tmp = std::env::temp_dir().join(format!("engine-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let e = Engine::with(tmp.join("urb"), None);
        assert_eq!(e.status(), Status::Off);
        assert!(!tmp.exists());
        e.close();
        assert!(!tmp.exists());
    }

    #[test]
    fn the_state_dir_is_made_private() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("engine-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let dir = tmp.join("urb");
        make_dir(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        make_dir(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn a_second_engine_on_one_store_is_busy() {
        // a fake ship, so no network is touched: open on a fake network
        // with no galaxies answering still opens the store first
        let tmp = std::env::temp_dir().join(format!("engine-busy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let a = Engine::fake(tmp.clone(), "~bidlys-donref-dozzod-dozwep");
        let b = Engine::fake(tmp.clone(), "~bidlys-donref-dozzod-dozwep");
        a.start();
        for _ in 0..200 {
            if a.status() != Status::Booting {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(a.status(), Status::Ready { .. }), "{:?}", a.status());
        let got = b.read("urb://~wep/x", Duration::from_secs(5), true);
        assert_eq!(got, Err(ReadError::Busy));
        a.close();
        b.close();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A real read on the fleet, as a fake moon of the publisher: run by
    /// scripts/desktop-engine-fleet.sh, which publishes the page. Plain
    /// `cargo test` (CI) skips it as ignored; run by hand with no fleet it
    /// says so and passes.
    #[test]
    #[ignore = "needs a fleet ship: scripts/desktop-engine-fleet.sh"]
    fn engine_reads_a_fleet_page() {
        if std::env::var("LATTICE_FLEET").as_deref() != Ok("1") {
            eprintln!("skipped: LATTICE_FLEET=1 is not set (run scripts/desktop-engine-fleet.sh)");
            return;
        }
        let url = std::env::var("FLEET_PAGE").expect("FLEET_PAGE");
        let nonce = std::env::var("FLEET_NONCE").expect("FLEET_NONCE");
        let tmp = std::env::temp_dir().join(format!("engine-fleet-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let e = Engine::fake(tmp.clone(), "new-moon-of:~wep");
        let t = std::time::Instant::now();
        let p = e.read(&url, Duration::from_secs(60), true).expect("the first read");
        eprintln!("first read {:?} ({} by {})", t.elapsed(), p.key, p.how);
        assert!(p.body.contains(&nonce), "{}", p.body);
        assert_eq!(p.mark, "gmi");
        let shown = crate::render::page(&url, &p, crate::render::Mode::Shipless, "k", &crate::render::Talk::default());
        assert!(shown.html.contains("href=\"/read?url=urb%3A%2F%2F~wep%2Fother\""), "{}", shown.html);
        assert!(shown.html.contains("href=\"/read?url=urb%3A%2F%2F~wep%2Fnotes%2Fmore\""));
        assert_eq!(shown.title, "Desktop engine check");
        let t = std::time::Instant::now();
        let again = e.read(&url, Duration::from_secs(10), true).expect("the second read");
        let warm = t.elapsed();
        eprintln!("second read {warm:?}");
        assert_eq!(again.body, p.body);
        assert!(warm < Duration::from_millis(50), "warm read took {warm:?}");
        let missing = format!("{url}-not-there");
        assert!(matches!(
            e.read(&missing, Duration::from_secs(60), true),
            Err(ReadError::NotPublished(_))
        ));
        e.close();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The anonymous identity moved to a fresh profile, live, reads only:
    /// a comet in `LATTICE_LIVE_A` (an app data `urb/` folder, mined there
    /// if there is none) reads urb://~nisfeb/start, is exported to
    /// `LATTICE_LIVE_FILE` and closed, and the file is imported into
    /// `LATTICE_LIVE_B` (another profile's empty folder), which must run as
    /// the same @p and read the same page. Never writes to a ship.
    #[test]
    #[ignore = "live: LATTICE_LIVE_A, LATTICE_LIVE_B and LATTICE_LIVE_FILE"]
    fn an_identity_moves_to_a_fresh_profile_live() {
        let (Ok(a), Ok(b), Ok(file)) =
            (std::env::var("LATTICE_LIVE_A"), std::env::var("LATTICE_LIVE_B"), std::env::var("LATTICE_LIVE_FILE"))
        else {
            eprintln!("skipped: LATTICE_LIVE_A, LATTICE_LIVE_B and LATTICE_LIVE_FILE are not all set");
            return;
        };
        const START: &str = "urb://~nisfeb/start";
        let first = Engine::with(PathBuf::from(&a), None);
        let p = first.read(START, Duration::from_secs(180), true).expect("A reads the start page");
        let our_a = first.identity().expect("A has an identity");
        eprintln!("A is {our_a}, read {} ({} bytes)", p.key, p.body.len());
        let id = first.export_identity().expect("export");
        assert_eq!(id.ship, our_a);
        let sealed = crate::cometid::seal(&id, "live check passphrase").unwrap();
        crate::cometid::mark_exported(first.dir()).unwrap();
        std::fs::write(&file, &sealed).unwrap();
        assert!(first.close(), "A closes");
        assert!(first.exported_at().is_some());

        let opened = crate::cometid::open(&std::fs::read(&file).unwrap(), "live check passphrase").unwrap();
        assert_eq!(
            crate::cometid::open(&sealed, "not the passphrase"),
            Err(crate::cometid::OpenError::WrongPassphrase)
        );
        let second = Engine::with(PathBuf::from(&b), None);
        assert_eq!(second.identity(), None, "B starts with no identity");
        second.import_identity(&opened).expect("import");
        let p = second.read(START, Duration::from_secs(180), true).expect("B reads the start page");
        assert_eq!(second.identity().as_deref(), Some(our_a.as_str()));
        assert_eq!(second.status(), Status::Ready { our: our_a.clone() });
        assert!(second.claimed() && second.exported_at().is_none());
        eprintln!("B is {our_a}, read {} ({} bytes)", p.key, p.body.len());
        second.close();
    }

    #[test]
    fn a_real_identity_keeps_ships_points_in_the_state_folder() {
        // Without this the engine started with no key cache, and every
        // comet's first read of a publisher waited on the roller.
        let d = std::env::temp_dir().join(format!("engine-keys-{}", std::process::id()));
        assert!(key_cache(&d, None).is_some(), "a real identity gets the cache");
        assert!(key_cache(&d, Some("~zod")).is_none(), "a fake ship is the fleet's");
        let src = include_str!("engine.rs");
        let wired = src.find(&["if let Some(keys) = key_cache(dir, fake) {\n", "        host.set_keys(keys);"].concat());
        let opened = src.find(&["let our = match host.open(", "fake.is_some()) {"].concat());
        assert!(matches!((wired, opened), (Some(w), Some(o)) if w < o), "set_keys must come before open");
    }

    /// The second comet in one state folder, live, reads only: a comet
    /// reads urb://~nisfeb/start, is set aside as an import sets it aside,
    /// and a new comet mined in the same folder reads it again. With the
    /// key cache its first read skips the roller. A third comet in a fresh
    /// folder, with no cache, is the control. Never writes to a ship.
    #[test]
    #[ignore = "live: LATTICE_LIVE_KEYS=1"]
    fn a_second_comet_reads_from_the_key_cache_live() {
        if std::env::var("LATTICE_LIVE_KEYS").as_deref() != Ok("1") {
            eprintln!("skipped: LATTICE_LIVE_KEYS=1 is not set");
            return;
        }
        const START: &str = "urb://~nisfeb/start";
        let base = std::env::temp_dir().join(format!("engine-keys-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let ready = |e: &Engine| {
            e.start();
            let t = Instant::now();
            while !matches!(e.status(), Status::Ready { .. }) {
                assert!(t.elapsed() < Duration::from_secs(300), "never ready: {:?}", e.status());
                std::thread::sleep(Duration::from_millis(100));
            }
        };
        let first_read = |e: &Engine, label: &str| {
            ready(e);
            let t = Instant::now();
            e.read(START, Duration::from_secs(120), true).expect("reads the start page");
            let took = t.elapsed();
            eprintln!("{label}: first read {took:?} as {}", e.identity().unwrap_or_default());
            took
        };
        let shared = base.join("shared");
        let a = Engine::with(shared.clone(), None);
        first_read(&a, "comet 1");
        assert!(a.close());
        assert!(std::fs::read_dir(shared.join(KEYS)).map(|d| d.count() > 0).unwrap_or(false), "points were kept");
        // set aside as an import does, keeping the cache
        let aside = shared.join("aside");
        std::fs::create_dir_all(&aside).unwrap();
        for e in std::fs::read_dir(&shared).unwrap().flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n == "comet.key" || n.contains(".db") || n == UNCLAIMED {
                std::fs::rename(e.path(), aside.join(&n)).unwrap();
            }
        }
        let b = Engine::with(shared.clone(), None);
        let warm = first_read(&b, "comet 2, same folder");
        b.close();
        let c = Engine::with(base.join("fresh"), None);
        let cold = first_read(&c, "comet 3, fresh folder");
        c.close();
        eprintln!("second comet {warm:?}, control {cold:?}");
        let _ = std::fs::remove_dir_all(&base);
    }
}
