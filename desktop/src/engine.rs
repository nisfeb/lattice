//! The urb engine: urb-fetch's Rust core (libmesa through `urb`'s native
//! host), linked into the app and run on a thread of its own, as
//! urb-gateway's main runs it. It reads pages people publish with lattice
//! on the Urbit network, as a comet this app makes once and keeps, so
//! someone with no ship can read them (the shipless reader, reader.rs).
//!
//! The engine reads page content, and makes one write: a comment on a
//! published page, poked to the publisher's comment inbox as the comet
//! itself (owner, 2026-11-03: someone using the app anonymously can browse
//! and comment). It never posts, follows, bookmarks or publishes, and never
//! acts as the user's ship. Every request it makes goes through
//! `submit_read` or `submit_comment`, and a test reads this file's own
//! source to hold it to that (`only_reads_and_comments_are_submitted`).
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
use urb_engine::{Failure, Reply, Request, Value};
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
}

/// where a read's result goes
type Answer = Sender<Result<NativePage, ReadError>>;
/// where a comment's result goes
type Said = Sender<Result<(), CommentError>>;

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
    Comment(Comment, Said),
    Close(Sender<()>),
}

/// what the host's thread waits on
enum Wait {
    Read(Answer, String),
    Comment(Said),
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
    pub fn close(&self) {
        let (tx, rx) = channel();
        {
            let mut g = self.inner.lock().unwrap();
            let Some(run) = g.run.take() else { return };
            g.status = Status::Off;
            if run.jobs.send(Job::Close(tx)).is_err() {
                return;
            }
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
        }
        let _ = rx.recv_timeout(Duration::from_secs(2));
    }
}

impl Reads for Engine {
    fn read(&self, url: &str, budget: Duration, wait_boot: bool) -> Result<NativePage, ReadError> {
        Engine::read(self, url, budget, wait_boot)
    }
    fn expire(&self, url: &str) {
        Engine::expire(self, url)
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
                Ok(Job::Expire(ship)) => {
                    log_line(&format!("expire the revision list of {ship}"));
                    host.core().expire_revs(&ship);
                }
                Ok(Job::Comment(c, tx)) => {
                    log_line(&format!("comment to {} on {} at {}", c.ship, c.page, c.base));
                    pending.push((submit_comment(&mut host, c), Wait::Comment(tx), Instant::now()))
                }
                Ok(Job::Close(done)) => {
                    let _ = host.close();
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
                    Wait::Comment(tx) => {
                        let got = said_of(r);
                        log_line(&format!("comment in {} ms: {got:?}", at.elapsed().as_millis()));
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

/// lattice's `comment-action`: the page's path, then the text
fn comment_noun(page: &str, body: &str) -> Value<'static> {
    Value::Array(vec![urb_engine::codec::path(page), Value::Text(body.into())])
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

    /// The rule as a test: the engine reads, and its one write is a
    /// comment to a publisher's comment inbox. Every request it names is a
    /// Read or that Poke, it submits in two places, and it never peeks,
    /// publishes, hears an inbox or calls a forum or a furum board. A
    /// change that needs any of those has to change this test on purpose.
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
        assert_eq!(named, ["Read", "Poke"], "the engine names only Request::Read and one Poke");
        for word in ["Peek", "Inbox", "Furum", "Forum", "PubPut", "PubRemove", "Pub {", "Watch"] {
            assert!(!code.contains(&format!("Request::{word}")), "{word}");
        }
        for word in ["FurumCall", "ForumCall", "submit_as", ".call(", "submit_open_as"] {
            assert!(!code.contains(word), "the engine uses {word}");
        }
        assert_eq!(code.matches(".submit(").count(), 2, "two submits, in submit_read and submit_comment");
        assert_eq!(code.matches("submit_read(").count(), 1, "submit_read, called once");
        assert_eq!(code.matches("submit_comment(").count(), 1, "submit_comment, called once");
        // the poke goes to the comment inbox, with lattice's comment mark
        let poke = &code[code.find("fn submit_comment<").unwrap()..];
        let poke = &poke[..poke.find("\n}\n").unwrap()];
        assert!(poke.contains("name: \"comments.sig\".into()"), "{poke}");
        assert!(poke.contains("mark: (\"/lattice\".into(), \"comment-action\".into())"), "{poke}");
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
}
