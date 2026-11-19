//! The urb engine: urb-fetch's Rust core over libmesa, linked into the app
//! and run on a thread of its own, as the desktop app runs it
//! (`desktop/src/engine.rs`, which this follows). It reads pages people
//! publish with lattice on the Urbit network, as a comet this app makes
//! once and keeps, so someone with no ship can read them.
//!
//! Here the engine reads page content and does nothing else. It makes no
//! write of any kind: no comment, no post, no vote, no follow. Every
//! request it makes goes through `submit_read`, and a test reads this
//! file's own source to hold it to that. It never acts as the user's ship.
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

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use urb_engine::host::net::{Log, NetIo, libmesa_log, random};
use urb_engine::host::{Event, Host};
use urb_engine::{Failure, Reply, Request};
use urb_gateway::state::{self, GatewayUdp};

/// A body larger than this is refused, so a hostile publisher cannot
/// balloon the app.
pub const MAX_BODY: usize = 4 * 1024 * 1024;
/// A start that failed is not tried again for this long.
pub const RETRY_AFTER: Duration = Duration::from_secs(5);
/// How long a read may take: the first one makes the comet and meets the ship.
pub const BUDGET: Duration = Duration::from_secs(45);

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

/// Where the engine is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Off,
    Booting,
    Ready { our: String },
    Failed(String),
}

type Answer = Sender<Result<NativePage, ReadError>>;

/// what callers hand the host's thread
enum Job {
    Read(String, Answer),
    Close(Sender<()>),
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
        Engine { dir, fake, inner: Arc::new(Mutex::new(Inner { status: Status::Off, failed_at: None, step: "", run: None })) }
    }

    pub fn status(&self) -> Status {
        self.inner.lock().unwrap().status.clone()
    }

    /// What a start in progress is doing. Empty when not starting.
    pub fn step(&self) -> &'static str {
        let g = self.inner.lock().unwrap();
        if g.status == Status::Booting { g.step } else { "" }
    }

    /// The name the engine runs as, once it runs.
    pub fn our(&self) -> Option<String> {
        match self.status() {
            Status::Ready { our } => Some(our),
            _ => None,
        }
    }

    /// Starts the host's thread unless it runs or is starting.
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
        let spawned = std::thread::Builder::new().name("urb-engine".into()).spawn(move || host_thread(&dir, fake.as_deref(), &inner, jobs_rx));
        if let Err(e) = spawned {
            let mut g = self.inner.lock().unwrap();
            g.status = Status::Failed(format!("no thread for the reader: {e}"));
            g.failed_at = Some(Instant::now());
            g.run = None;
        }
    }

    /// Reads `url` (an urb:// address), waiting at most `budget`. The
    /// caller is a worker's thread, never the window's.
    pub fn read(&self, url: &str, budget: Duration) -> Result<NativePage, ReadError> {
        self.start();
        let (tx, rx) = channel();
        {
            let g = self.inner.lock().unwrap();
            if let Status::Failed(m) = &g.status {
                return Err(boot_error(m));
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
            Err(RecvTimeoutError::Timeout) => Err(ReadError::Unreachable(format!("No answer within {} seconds. The ship may be away: try again.", budget.as_secs()))),
            // the thread ended: its start failed, or it was closed
            Err(RecvTimeoutError::Disconnected) => match self.status() {
                Status::Failed(m) => Err(boot_error(&m)),
                _ => Err(ReadError::Failed("the reader stopped".into())),
            },
        }
    }

    /// Closes the store and ends the thread, waiting a moment for it.
    pub fn close(&self) {
        let run = {
            let mut g = self.inner.lock().unwrap();
            g.status = Status::Off;
            g.run.take()
        };
        let Some(run) = run else { return };
        let (tx, rx) = channel();
        if run.jobs.send(Job::Close(tx)).is_ok() {
            if let Some(w) = &run.waker {
                let _ = w.send(Event::Wake);
            }
            let _ = rx.recv_timeout(Duration::from_secs(5));
        }
    }
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
    // a damaged folder is said, not mended: the desktop app sets damage aside and makes a new comet,
    // which is a choice about an identity that this first cut does not make for anyone
    let found = match state::find(dir, "", false, fake.unwrap_or("")) {
        Ok(f) => f,
        Err(e) => return fail(e),
    };
    let udp = GatewayUdp { fake: fake.is_some(), port: found.port, log: log.clone(), udp: None };
    let io = NetIo::new(Box::new(udp), Box::new(found.store), log);
    let waker = io.waker();
    if let Some(run) = &mut inner.lock().unwrap().run {
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
    inner.lock().unwrap().status = Status::Ready { our };
    let mut pending: Vec<(u64, Answer, String, Instant)> = Vec::new();
    loop {
        loop {
            match jobs.try_recv() {
                Ok(Job::Read(url, tx)) => pending.push((submit_read(&mut host, url.clone()), tx, url, Instant::now())),
                Ok(Job::Close(done)) => {
                    let _ = host.close();
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
        pending.retain(|(id, tx, url, at)| match host.take(*id) {
            Some(r) => {
                log_line(&format!("read {url} in {} ms", at.elapsed().as_millis()));
                let _ = tx.send(result_of(r));
                false
            }
            None => true,
        });
        host.turn();
    }
}

/// The one request this engine makes: a page's content.
fn submit_read<I: urb_engine::host::Io>(host: &mut Host<I>, url: String) -> u64 {
    host.submit(Request::Read(url))
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

/// The ship and the path an address names, as the browser shows a page of
/// another ship: `urb://~sampel/notes/plan` is `~sampel` and `notes/plan`,
/// and an address with no path is the ship's `index`.
pub fn place(url: &str) -> Option<(String, String)> {
    let u = urb_engine::url::de_urb(url).ok()?;
    Some((u.ship, u.rel.join("/")))
}

/// The page kind the app knows a mark by. What it does not know is shown as text.
pub fn kind_of(mark: &str) -> &'static str {
    match mark {
        "md" | "markdown" => "md",
        "html" | "htm" => "html",
        "gmi" | "gemini" => "gmi",
        "geojson" => "geojson",
        "scad" => "scad",
        "tex" => "tex",
        _ => "txt",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_reads_are_submitted() {
        // every request to the host is made in one place, and that place asks only to read
        let src = include_str!("engine.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        assert_eq!(code.matches("host.submit(").count(), 1, "one place submits");
        assert_eq!(code.matches("Request::").count(), 1, "and it makes one kind of request");
        assert!(code.contains("host.submit(Request::Read(url))"));
        for no in ["Poke", "Comment", "ForumCall", "FurumCall"] {
            assert!(!code.contains(no), "{no} has no place in a reader");
        }
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
        assert_eq!((kind_of("txt"), kind_of("hoon"), kind_of("")), ("txt", "txt", "txt"));
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
        let e = Engine { dir: d.clone(), fake: None, inner: Arc::new(Mutex::new(Inner { status: Status::Off, failed_at: None, step: "", run: None })) };
        assert_eq!((e.status(), e.step(), e.our()), (Status::Off, "", None));
        e.close();
        assert!(!d.exists(), "no folder, no key and no thread until a read");
    }
}
