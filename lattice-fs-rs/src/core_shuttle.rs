//! Concurrency permutation tests for the refresh path, on awslabs/shuttle.
//!
//! HOW TO RUN
//! ----------
//!     CARGO_TARGET_DIR=target/shuttle RUSTFLAGS='--cfg shuttle' \
//!         cargo test --lib shuttle_tests -- --test-threads=1
//!
//! A plain `cargo test` never compiles this module, so the normal suite stays
//! fast. `--cfg shuttle` flips src/sync.rs over to shuttle's Mutex and
//! thread::spawn, which is what lets shuttle's scheduler see the core's three
//! background threads (watch, warm, refresh) and permute them. The separate
//! CARGO_TARGET_DIR only stops the RUSTFLAGS change from invalidating the
//! normal build's cache; it is not required. `--test-threads=1` keeps the
//! per-iteration output readable, and shuttle is already parallel-hostile in
//! the sense that each execution is a whole scheduling universe.
//!
//! To replay a reported failure, paste its schedule string into
//! `shuttle::replay(f, "...")` (there is a commented example at the bottom).
//!
//! WHAT IS UNDER TEST
//! ------------------
//! The three writers of `State`: the watch thread's invalidate, the warm
//! thread's one-shot dump swap, and `ensure_fresh`'s background dump swap,
//! racing a `commit()` on the FUSE path. The `Projection` seam means none of
//! this needs a ship, a socket, or a mount: `Ship` below is an in-memory,
//! linearizable stand-in whose `dump()` returns whatever the ship holds at the
//! instant it is read, which is exactly the "snapshot from the past" a slow
//! round trip produces.
//!
//! Time is NOT modelled: shuttle permutes threads, not clocks. `Instant`
//! elapses ~0 during an execution, so the tests reach the stale branch by
//! setting `vt_ts = None` (which `ensure_fresh` treats as stale) rather than
//! by waiting out TREE_TTL.

use super::*;
use crate::sync::{thread, Arc, Mutex};
use shuttle::sync::atomic::{AtomicUsize, Ordering};

/// Iterations (distinct random schedules) per test. These paths have a handful
/// of threads and a handful of scheduling points, so low thousands is already a
/// thorough sweep and still only seconds of wall clock. Raise it for a deeper
/// soak with `SHUTTLE_ITERS=200000`; shuttle's own `SHUTTLE_RANDOM_SEED` pins
/// the run if you want the same sweep twice.
fn iters() -> usize {
    std::env::var("SHUTTLE_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(5_000)
}

// ---------- the fake ship ----------

/// An in-memory ship. Linearizable: a `write` is visible to every `dump` that
/// starts after it returns, and to none that finished before. That is the
/// property the stale-swap guard exists to cope with, so it must be modelled
/// exactly rather than approximated.
#[derive(Default)]
struct Ship {
    pages: Mutex<HashMap<String, Vec<u8>>>, // rel -> body
    dumps: AtomicUsize,
    fail_dumps: bool,   // every dump() returns Err (a flapping nexus)
    notify: bool,       // watch() fires on_change once, then returns
}

impl Ship {
    fn with(pages: &[(&str, &str)]) -> Arc<Self> {
        Arc::new(Ship { pages: Ship::seed(pages), ..Default::default() })
    }
    /// Same, but its watch() fires one invalidate, so the watch thread becomes
    /// a fourth racing writer of State instead of returning immediately.
    fn watching(pages: &[(&str, &str)]) -> Arc<Self> {
        Arc::new(Ship { pages: Ship::seed(pages), notify: true, ..Default::default() })
    }
    fn seed(pages: &[(&str, &str)]) -> Mutex<HashMap<String, Vec<u8>>> {
        Mutex::new(pages.iter().map(|(k, v)| (k.to_string(), v.as_bytes().to_vec())).collect())
    }
}

impl Projection for Ship {
    fn ship(&self) -> String {
        "~shuttle".into()
    }
    fn list(&self) -> Result<Vec<Node>, PErr> {
        Ok(self.dump()?.0)
    }
    fn read(&self, rel: &str) -> Result<Vec<u8>, PErr> {
        self.pages
            .lock()
            .unwrap()
            .get(rel)
            .cloned()
            .ok_or_else(|| PErr::new(libc::ENOENT, "shuttle ship: no such rel"))
    }
    fn dump(&self) -> Result<crate::projection::Dump, PErr> {
        self.dumps.fetch_add(1, Ordering::SeqCst);
        if self.fail_dumps {
            return Err(PErr::new(libc::EIO, "shuttle ship: dump failed"));
        }
        // Two separate lock acquisitions would let a write land between them
        // and hand back a torn snapshot the real page-dump can never produce.
        let pages = self.pages.lock().unwrap();
        let mut nodes = Vec::new();
        let mut bodies = HashMap::new();
        for (rel, body) in pages.iter() {
            nodes.push(Node {
                rel: rel.clone(),
                is_dir: false,
                is_page: true,
                kind: "md".into(),
                size: body.len() as u64,
                mtime: 1_780_000_000,
                readonly: false,
            });
            bodies.insert(rel.clone(), body.clone());
        }
        Ok((nodes, bodies))
    }
    fn errors(&self, _rel: &str) -> Result<String, PErr> {
        Ok(String::new())
    }
    fn write(&self, rel: &str, _kind: &str, data: &[u8], _create: bool) -> Result<(), PErr> {
        self.pages.lock().unwrap().insert(rel.to_string(), data.to_vec());
        Ok(())
    }
    fn mkdir(&self, _rel: &str) -> Result<(), PErr> {
        Ok(())
    }
    fn delete(&self, rel: &str) -> Result<(), PErr> {
        self.pages.lock().unwrap().remove(rel);
        Ok(())
    }
    fn mv(&self, _s: &str, _d: &str) -> Result<(), PErr> {
        Ok(())
    }
    fn watch(&self, on_change: &(dyn Fn() + Send + Sync)) {
        if self.notify {
            on_change();
        }
    }
}

// ---------- helpers ----------

/// Spin until `f` holds, yielding to shuttle's scheduler each time. BOUNDED:
/// a condition that never arrives has to fail the test, not hang the run (a
/// latched `refresh_pending` is precisely such a condition, and an unbounded
/// spin would turn that bug into an infinite loop instead of a report).
///
/// The bound is enormous relative to what these paths need (a background
/// refresh is ~10 scheduling steps), so a real settle is never missed.
fn settle(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..2_000 {
        if f() {
            return;
        }
        thread::yield_now();
    }
    panic!("shuttle: `{what}` never settled -- livelock or a latched flag");
}

fn dirty_handle(rel: &str, body: &[u8]) -> Handle {
    Handle {
        rel: rel.into(),
        kind: "md".into(),
        buf: body.to_vec(),
        dirty: true,
        new: false,
        scratch: false,
    }
}

/// `read_cache_bytes` is a running total maintained by four different call
/// sites. If it ever disagrees with the map it is counting, the cap either
/// stops admitting bodies (reads silently go back to the wire forever) or
/// stops bounding them (the client OOMs on a big tree).
fn assert_accounting(s: &State, at: &str) {
    let actual: usize = s.read_cache.iter().map(|(k, v)| k.len() + v.len()).sum();
    assert_eq!(
        s.read_cache_bytes, actual,
        "read_cache_bytes disagrees with the cache contents at {at}"
    );
}

/// Bring the mount up and wait out the constructor's warm thread, so a test
/// that wants to isolate a LATER race is not also racing the warm swap.
/// `warm` is set at the tail of `apply_swap`, under the same lock, so
/// observing it means that swap is fully applied.
fn warmed(ship: Arc<Ship>) -> Arc<GrubberyFs> {
    let fs = Arc::new(GrubberyFs::new(ship as Arc<dyn Projection>));
    settle("the warm dump", || fs.st.lock().unwrap().warm);
    fs
}

// ---------- 1. the stale-swap guard ----------

#[test]
fn a_background_swap_never_resurrects_a_superseded_body() {
    // A refresh whose dump left the ship BEFORE a save must not land after it
    // and put the pre-write body back. Losing a save this way is silent: the
    // editor reported success, and the file reads back as its old content.
    shuttle::check_random(
        || {
            let ship = Ship::with(&[("note", "old")]);
            let fs = warmed(ship.clone());

            // stale, so ensure_fresh kicks a background dump (time is not
            // modelled; vt_ts = None is the same branch TREE_TTL reaches)
            fs.st.lock().unwrap().vt_ts = None;
            fs.ensure_fresh(); // kicks exactly one background dump, then returns

            // the user saves while that dump is somewhere on the wire
            let w = {
                let fs = fs.clone();
                thread::spawn(move || {
                    fs.st.lock().unwrap().handles.insert(1, dirty_handle("note", b"NEWER!"));
                    fs.commit(1).unwrap();
                })
            };
            w.join().unwrap();

            // refresh_pending is cleared in the same critical section that
            // applies (or discards) the swap, so this waits for the swap too
            settle("the background refresh", || !fs.st.lock().unwrap().refresh_pending);

            let s = fs.st.lock().unwrap();
            assert_eq!(
                ship.pages.lock().unwrap()["note"],
                b"NEWER!",
                "the write must have reached the ship"
            );
            assert_ne!(
                s.read_cache.get("note").map(|b| b.as_slice()),
                Some(&b"old"[..]),
                "a stale snapshot resurrected the pre-write body"
            );
            assert_eq!(
                s.vt["/note.md"].node.as_ref().unwrap().size,
                6,
                "a stale snapshot restored the pre-write size (the kernel derives \
                 an O_APPEND offset from it)"
            );
            assert_accounting(&s, "the end of the stale-swap test");
        },
        iters(),
    );
}

// ---------- 2. the cold path's swap ----------

#[test]
fn a_cold_blocking_dump_never_resurrects_a_superseded_body() {
    // Same invariant, other swapper. `refresh_blocking` runs while nothing is
    // warm yet, and two callers can be inside it at once: whoever loses gets a
    // snapshot older than the state it is swapping into. A write that lands in
    // between must survive that.
    shuttle::check_random(
        || {
            let ship = Ship::with(&[("note", "old")]);
            // deliberately NOT warmed: the constructor's warm thread is one of
            // the racers here
            let fs = Arc::new(GrubberyFs::new(ship.clone() as Arc<dyn Projection>));

            let a = {
                let fs = fs.clone();
                thread::spawn(move || fs.ensure_fresh()) // cold -> refresh_blocking
            };
            let b = {
                let fs = fs.clone();
                thread::spawn(move || {
                    fs.st.lock().unwrap().handles.insert(1, dirty_handle("note", b"NEWER!"));
                    fs.commit(1).unwrap();
                })
            };
            a.join().unwrap();
            b.join().unwrap();
            // the constructor's warm thread is detached; its swap is guarded by
            // the same generation check, so let it land before the assertions
            settle("the warm dump", || fs.st.lock().unwrap().warm);
            settle("every dump", || ship.dumps.load(Ordering::SeqCst) >= 1);

            let s = fs.st.lock().unwrap();
            assert_ne!(
                s.read_cache.get("note").map(|b| b.as_slice()),
                Some(&b"old"[..]),
                "a cold blocking dump resurrected the pre-write body"
            );
            assert_accounting(&s, "the end of the cold-path test");
        },
        iters(),
    );
}

// ---------- 3. refresh_pending liveness ----------

#[test]
fn refresh_pending_never_latches_true() {
    // refresh_pending coalesces concurrent refreshes: exactly one thread gets
    // to spawn the dump. If it is ever left true with nothing in flight, the
    // tree never refreshes again for the life of the mount, and staleness is
    // frozen forever. No example-based test produces that; only an ordering
    // does.
    shuttle::check_random(
        || {
            let ship = Ship::with(&[("note", "old")]);
            let fs = warmed(ship.clone());

            // three callers pile onto one stale tree, plus a save
            let mut hs = Vec::new();
            for _ in 0..3 {
                let fs = fs.clone();
                hs.push(thread::spawn(move || {
                    fs.st.lock().unwrap().vt_ts = None;
                    fs.ensure_fresh();
                }));
            }
            {
                let fs = fs.clone();
                hs.push(thread::spawn(move || {
                    fs.st.lock().unwrap().handles.insert(1, dirty_handle("note", b"NEWER!"));
                    fs.commit(1).unwrap();
                }));
            }
            for h in hs {
                h.join().unwrap();
            }

            settle("refresh_pending", || !fs.st.lock().unwrap().refresh_pending);

            // and the flag must still be USABLE, not merely false: a later
            // stale tree has to be able to kick another refresh
            let before = ship.dumps.load(Ordering::SeqCst);
            fs.st.lock().unwrap().vt_ts = None;
            fs.ensure_fresh();
            settle("the follow-up refresh", || !fs.st.lock().unwrap().refresh_pending);
            assert!(
                ship.dumps.load(Ordering::SeqCst) > before,
                "refresh_pending latched: no refresh can ever run again"
            );
        },
        iters(),
    );
}

#[test]
fn a_failing_dump_still_clears_refresh_pending() {
    // The flag has to be cleared on the error path too. A nexus that 500s for
    // one refresh must not wedge every refresh after it.
    shuttle::check_random(
        || {
            let ship = Ship::with(&[("note", "old")]);
            let fs = warmed(ship);

            let broken = Arc::new(Ship { fail_dumps: true, ..Default::default() });
            let fs = Arc::new(GrubberyFs {
                proj: broken.clone() as Arc<dyn Projection>,
                st: fs.st.clone(),
                uid: fs.uid,
                gid: fs.gid,
            });

            fs.st.lock().unwrap().vt_ts = None;
            fs.ensure_fresh();
            settle("the failed refresh", || !fs.st.lock().unwrap().refresh_pending);

            let before = broken.dumps.load(Ordering::SeqCst);
            fs.st.lock().unwrap().vt_ts = None;
            fs.ensure_fresh();
            settle("the follow-up refresh", || !fs.st.lock().unwrap().refresh_pending);
            assert!(
                broken.dumps.load(Ordering::SeqCst) > before,
                "a failed dump latched refresh_pending"
            );
            // a failed dump must also leave the tree it could not replace alone
            let s = fs.st.lock().unwrap();
            assert!(s.warm && s.vt.contains_key("/note.md"), "a failed dump wiped the tree");
            assert_accounting(&s, "the end of the failing-dump test");
        },
        iters(),
    );
}

// ---------- 4. cache byte accounting ----------

#[test]
fn cache_accounting_survives_concurrent_insert_evict_and_swap() {
    // Every writer of read_cache also has to move read_cache_bytes by exactly
    // the same amount: body()'s read-through insert, publish()'s overwrite,
    // apply_swap's wholesale replace plus its recent-ledger carry-forward, and
    // the watch thread's clear. Four sites, one running total, all under one
    // lock but in any order.
    shuttle::check_random(
        || {
            // `watching` puts the watch thread's cache-clear into the mix as a
            // fourth writer of read_cache/read_cache_bytes
            let ship = Ship::watching(&[("note", "old"), ("other", "hello")]);
            let fs = warmed(ship.clone());

            let mut hs = Vec::new();
            {
                // read-through insert of a rel the cache may or may not hold
                let fs = fs.clone();
                hs.push(thread::spawn(move || {
                    let _ = fs.body("other");
                }));
            }
            {
                // publish: overwrite an entry (or add a brand-new one)
                let fs = fs.clone();
                hs.push(thread::spawn(move || {
                    fs.st.lock().unwrap().handles.insert(1, dirty_handle("note", b"NEWER!"));
                    fs.commit(1).unwrap();
                }));
            }
            {
                // apply_swap: wholesale replace
                let fs = fs.clone();
                hs.push(thread::spawn(move || {
                    fs.st.lock().unwrap().vt_ts = None;
                    fs.ensure_fresh();
                }));
            }
            {
                // an observer: the total must be consistent at EVERY point an
                // outside thread can take the lock, not merely at the end
                let fs = fs.clone();
                hs.push(thread::spawn(move || {
                    for _ in 0..4 {
                        assert_accounting(&fs.st.lock().unwrap(), "an interleaved observation");
                        thread::yield_now();
                    }
                }));
            }
            for h in hs {
                h.join().unwrap();
            }
            settle("the background refresh", || !fs.st.lock().unwrap().refresh_pending);
            assert_accounting(&fs.st.lock().unwrap(), "quiescence");
        },
        iters(),
    );
}

// ---------- 5. no deadlock, no panic, under everything at once ----------

#[test]
fn the_whole_refresh_path_is_deadlock_free() {
    // Shuttle fails an execution on deadlock (every thread blocked) and on any
    // panic, including a poisoned-mutex unwrap. This one exists to drive all
    // four writers of State at once and let shuttle look for both.
    shuttle::check_random(
        || {
            let ship = Ship::with(&[("a", "1"), ("b", "22")]);
            let fs = Arc::new(GrubberyFs::new(ship.clone() as Arc<dyn Projection>));

            let mut hs = Vec::new();
            for (fh, rel, body) in [(1u64, "a", &b"aaa"[..]), (2, "b", &b"bbbb"[..])] {
                let fs = fs.clone();
                hs.push(thread::spawn(move || {
                    fs.st.lock().unwrap().handles.insert(fh, dirty_handle(rel, body));
                    fs.commit(fh).unwrap();
                }));
            }
            {
                let fs = fs.clone();
                hs.push(thread::spawn(move || {
                    fs.ensure_fresh();
                    let _ = fs.body("a");
                }));
            }
            {
                let fs = fs.clone();
                hs.push(thread::spawn(move || {
                    fs.st.lock().unwrap().vt_ts = None;
                    fs.ensure_fresh();
                }));
            }
            for h in hs {
                h.join().unwrap();
            }
            settle("the background refresh", || !fs.st.lock().unwrap().refresh_pending);
            settle("the warm dump", || fs.st.lock().unwrap().warm);

            let s = fs.st.lock().unwrap();
            assert_accounting(&s, "the end of the deadlock test");
            // both saves reached the ship and neither was rolled back locally
            assert_eq!(ship.pages.lock().unwrap()["a"], b"aaa");
            assert_eq!(ship.pages.lock().unwrap()["b"], b"bbbb");
            for (rel, stale) in [("a", &b"1"[..]), ("b", &b"22"[..])] {
                assert_ne!(
                    s.read_cache.get(rel).map(|b| b.as_slice()),
                    Some(stale),
                    "{rel} was rolled back to its pre-write body"
                );
            }
        },
        iters(),
    );
}

// To replay a failure shuttle reports, swap check_random for:
//
//     shuttle::replay(|| { ..the same closure.. }, "910a63a2f...");
//
// The schedule string is deterministic, so the failing interleaving reruns
// exactly, which is what makes a one-in-ten-thousand ordering debuggable.
