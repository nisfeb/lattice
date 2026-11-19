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
/// How long a read may take once the engine runs.
pub const BUDGET: Duration = Duration::from_secs(45);
/// How long the engine may take to start before a read gives up on it. The first start makes the
/// comet, which is not the ship's being away and is not counted against the read.
pub const BOOT: Duration = Duration::from_secs(120);

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
        let spawned = std::thread::Builder::new().name("urb-engine".into()).spawn(move || {
            // a panic in the engine is a failed start, said and tried again, not a reader that waits for ever
            let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| host_thread(&dir, fake.as_deref(), &inner, jobs_rx)));
            if ran.is_err() {
                let mut g = inner.lock().unwrap_or_else(|e| e.into_inner());
                g.status = Status::Failed("the reader stopped unexpectedly".into());
                g.failed_at = Some(Instant::now());
                g.run = None;
            }
        });
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
        // the read's time starts when the engine runs: while it starts, only the start's own limit counts
        let (began, slice) = (Instant::now(), Duration::from_millis(250));
        let mut ready_at: Option<Instant> = None;
        loop {
            match rx.recv_timeout(slice) {
                Ok(r) => return r,
                Err(RecvTimeoutError::Timeout) => match self.status() {
                    Status::Booting if began.elapsed() > BOOT => return Err(ReadError::Failed("The reader is taking too long to start. Check your connection and try again.".into())),
                    Status::Booting => {}
                    _ if ready_at.get_or_insert_with(Instant::now).elapsed() > budget => {
                        return Err(ReadError::Unreachable(format!("No answer within {} seconds. The ship may be away: try again.", budget.as_secs())));
                    }
                    _ => {}
                },
                // the thread ended: its start failed, or it was closed
                Err(RecvTimeoutError::Disconnected) => {
                    return match self.status() {
                        Status::Failed(m) => Err(boot_error(&m)),
                        _ => Err(ReadError::Failed("the reader stopped".into())),
                    };
                }
            }
        }
    }

    /// Closes the store and ends the thread, waiting a moment for it. `false` when it did not
    /// stop in that time.
    pub fn close(&self) -> bool {
        let run = {
            let mut g = self.inner.lock().unwrap();
            g.status = Status::Off;
            g.run.take()
        };
        let Some(run) = run else { return true };
        let (tx, rx) = channel();
        if run.jobs.send(Job::Close(tx)).is_err() {
            return true;
        }
        if let Some(w) = &run.waker {
            let _ = w.send(Event::Wake);
        }
        rx.recv_timeout(Duration::from_secs(5)).is_ok()
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
            Status::Ready { .. } => true,
            _ => false,
        };
        if !self.close() {
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
            let mut g = self.inner.lock().unwrap();
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
        // another copy holding the store is said as that. Anything else that could not be mended says where the files are
        Err(e) if e.ends_with("is in use by another process") => return fail(e),
        Err(e) => return fail(format!("{e}. Its files are in {}: move that folder aside to start again with a new identity", dir.display())),
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
    {
        let mut g = inner.lock().unwrap();
        // closed while it was starting: it does not come up as ready with nobody to hand it work
        if g.run.is_none() {
            drop(g);
            let _ = host.close();
            return;
        }
        g.status = Status::Ready { our };
    }
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
        Damage::Identity => n == "comet.key" || [".db", ".db-wal", ".db-shm", ".db.port"].iter().any(|x| n.ends_with(x)),
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

    fn engine_at(dir: PathBuf, fake: Option<&str>, status: Status) -> Engine {
        Engine { dir, fake: fake.map(str::to_string), inner: Arc::new(Mutex::new(Inner { status, failed_at: None, step: "", run: None })) }
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
        // a port file that is not a number goes, and one that is stays
        put("~sampel.db.port", "not a port");
        put("~other.db.port", "40123");
        set_aside(&d, Damage::Port).unwrap();
        let left = names(&d);
        assert!(left.contains(&"comet.key".to_owned()) && left.contains(&"~sampel.db".to_owned()) && left.contains(&"~other.db.port".to_owned()) && !left.contains(&"~sampel.db.port".to_owned()));
        let aside = left.iter().find(|n| n.starts_with("damaged-")).unwrap().clone();
        assert_eq!(names(&d.join(&aside)), ["~sampel.db.port"], "set aside, never deleted");
        std::fs::remove_dir_all(d.join(&aside)).unwrap();
        // a damaged store takes the keyfile and every store with it, and leaves what is not the identity's
        set_aside(&d, Damage::Identity).unwrap();
        let left = names(&d);
        let aside = left.iter().find(|n| n.starts_with("damaged-")).unwrap().clone();
        assert_eq!(left.iter().filter(|n| !n.starts_with("damaged-")).collect::<Vec<_>>(), ["keys.txt"]);
        assert_eq!(names(&d.join(&aside)), ["comet.key", "~other.db.port", "~sampel.db", "~sampel.db-wal"]);
        // nothing damaged, nothing moved
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
        let e = Engine { dir: d.clone(), fake: None, inner: Arc::new(Mutex::new(Inner { status: Status::Off, failed_at: None, step: "", run: None })) };
        assert_eq!((e.status(), e.step(), e.our()), (Status::Off, "", None));
        e.close();
        assert!(!d.exists(), "no folder, no key and no thread until a read");
    }
}
