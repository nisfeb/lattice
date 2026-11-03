//! The urb engine: urb-fetch's Rust core (libmesa through `urb`'s native
//! host), linked into the app and run on a thread of its own, as
//! urb-gateway's main runs it. It reads pages people publish with lattice
//! on the Urbit network, as a comet this app makes once and keeps, so
//! someone with no ship can read them (the shipless reader, reader.rs).
//!
//! The engine is a read path for page content and nothing else. It never
//! pokes, posts, comments, follows or bookmarks: every action that writes
//! or acts as the user belongs to the user's ship. Every request it makes
//! goes through `submit_read`, and a test reads this file's own source to
//! hold it to that (`only_reads_are_submitted`).
//!
//! State lives in `<app_data_dir>/urb/` (0700), opened as the Go and Rust
//! gateways open theirs (`urb_gateway::state::find`): `comet.key` (0600,
//! mined the first time, over HTTPS to bootstrap.urbit.org), `<comet>.db`
//! (libmesa's SQLite store) and `<comet>.db.port` (the UDP port the
//! identity keeps, since publishers answer the address they last saw).
//! One comet per install: every new comet leaves a record on each ship it
//! reads, so it is never remade per run, test or window.
//!
//! Nothing starts at launch. The thread starts the first time something
//! asks for a read.

// nothing calls the engine until the reader does
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use urb_engine::host::net::{libmesa_log, random, Log, NetIo};
use urb_engine::host::{Event, Host};
use urb_engine::{Failure, Reply, Request};
use urb_gateway::state::{self, GatewayUdp};

/// A body larger than this is refused, so a hostile publisher cannot
/// balloon the app.
pub const MAX_BODY: usize = 4 * 1024 * 1024;

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

/// what callers hand the host's thread
enum Job {
    Read(String, Sender<Result<NativePage, ReadError>>),
    Close(Sender<()>),
}

struct Running {
    jobs: Sender<Job>,
    waker: Option<Sender<Event>>,
}

struct Inner {
    status: Status,
    run: Option<Running>,
}

/// The engine, one per app (managed state).
pub struct Engine {
    dir: PathBuf,
    /// a fake ship's name on a fake network (`urbit -F`), for tests: the
    /// fleet's fake network has no comets
    fake: Option<String>,
    inner: Arc<Mutex<Inner>>,
}

impl Engine {
    /// The engine for state in `dir`. Does nothing yet: nothing is made on
    /// disk and no thread runs until the first read.
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
            inner: Arc::new(Mutex::new(Inner { status: Status::Off, run: None })),
        }
    }

    pub fn status(&self) -> Status {
        self.inner.lock().unwrap().status.clone()
    }

    /// Start the host's thread unless it runs or is starting. A failed
    /// start (no network for the comet's first mining, another lattice on
    /// the store) is tried again by the next read.
    pub fn start(&self) {
        let mut g = self.inner.lock().unwrap();
        if matches!(g.status, Status::Booting | Status::Ready { .. }) {
            return;
        }
        let (jobs_tx, jobs_rx) = channel::<Job>();
        g.status = Status::Booting;
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
        g.run = None;
    };
    if let Err(e) = make_dir(dir) {
        return fail(e);
    }
    let log: Log = Arc::new(log_line);
    libmesa_log(log.clone());
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
    let mut host = Host::new(io, random);
    let our = match host.open(fake.is_some()) {
        Ok(o) => o,
        Err(f) => return fail(f.message),
    };
    log_line(&format!("running as {our}"));
    inner.lock().unwrap().status = Status::Ready { our };
    let mut pending: Vec<(u64, Sender<Result<NativePage, ReadError>>)> = Vec::new();
    loop {
        loop {
            match jobs.try_recv() {
                Ok(Job::Read(url, tx)) => pending.push((submit_read(&mut host, url), tx)),
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
        pending.retain(|(id, tx)| match host.take(*id) {
            Some(r) => {
                let _ = tx.send(result_of(r));
                false
            }
            None => true,
        });
        host.turn();
    }
}

/// The one request the engine ever makes.
fn submit_read<I: urb_engine::host::Io>(host: &mut Host<I>, url: String) -> u64 {
    host.submit(Request::Read(url))
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
        ReadError::Failed(m.to_string())
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
        assert_eq!(boot_error("no network"), ReadError::Failed("no network".into()));
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
        let e = Engine::fake(tmp.clone(), "~bidlys-donref-dozzod-dozwep");
        let t = std::time::Instant::now();
        let p = e.read(&url, Duration::from_secs(60), true).expect("the first read");
        eprintln!("first read {:?} ({} by {})", t.elapsed(), p.key, p.how);
        assert!(p.body.contains(&nonce), "{}", p.body);
        assert_eq!(p.mark, "gmi");
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
