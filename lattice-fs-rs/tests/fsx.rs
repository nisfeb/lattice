//! fsx: random read/write/truncate torture against a real kernel mount.
//!
//! fsx (NeXT/Apple, by way of LTP and xfstests) hammers one file with random
//! reads, writes and truncates while keeping a shadow copy in memory as the
//! oracle. Any byte that comes back wrong stops the run and prints the exact
//! operation that diverged, plus the seed to reproduce it. That covers the
//! parts of the FUSE surface a hand-written test never reaches: writes past
//! EOF that must zero-fill the hole, a truncate that grows and one that
//! shrinks, reads straddling the end of the file, and the interaction of all
//! three at offsets nobody would think to pick.
//!
//! HOW TO RUN
//! ----------
//!     tests/fsx.sh
//!
//! That script fetches and compiles fsx (it is a single GPL C file, deliberately
//! NOT vendored here) into target/fsx, then runs this test with FSX_BIN
//! pointing at it. With no fsx binary at $FSX_BIN or target/fsx, this test
//! SKIPS, so a fresh checkout's `cargo test` needs neither the network nor a C
//! compiler. Once fsx IS built, a plain `cargo test` picks it up and runs it.
//!
//! Longer sweeps without editing anything:
//!     FSX_OPS=200000 FSX_SEED=7 cargo test --test fsx -- --nocapture
//!
//! `-R -W` are mandatory, not tuning: this filesystem implements no mmap, so
//! fsx's mapped-read and mapped-write operations would test the kernel's page
//! cache rather than us, and fail on a mount that never services them.
//! `-S <seed>` and a bounded `-N` keep it a fixed, CI-sized run rather than an
//! open-ended fuzz.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use lattice_fs::projection::{Dump, Node, PErr, Projection};

const OPS: usize = 20_000; // bounded for CI (a few seconds). Millions is a soak, not a test.
const SEED: u32 = 20_260_803; // fixed, so a failure is reproducible by rerunning
const MAX_FILE: usize = 128 * 1024;
// 1-in-N chance of close+open between ops. This is the interesting knob for
// THIS filesystem: a close flushes the whole body to the ship and the next open
// reloads it, so it is the only way an op sequence crosses the buffer/ship
// boundary. A pure in-buffer run would never exercise the round trip.
const CLOSE_PROB: usize = 50;

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// The smallest ship that can hold one page. fsx only ever touches one file,
/// so nothing here needs to be clever: it exists to give the FUSE layer
/// somewhere to flush to.
#[derive(Default)]
struct Ship {
    pages: Mutex<HashMap<String, (String, Vec<u8>)>>,
}

impl Projection for Ship {
    fn ship(&self) -> String {
        "~fsx".into()
    }
    fn list(&self) -> Result<Vec<Node>, PErr> {
        Ok(self.dump()?.0)
    }
    fn read(&self, rel: &str) -> Result<Vec<u8>, PErr> {
        self.pages
            .lock()
            .unwrap()
            .get(rel)
            .map(|(_, b)| b.clone())
            .ok_or_else(|| PErr::new(libc::ENOENT, "no such page"))
    }
    fn dump(&self) -> Result<Dump, PErr> {
        let pages = self.pages.lock().unwrap();
        let mut nodes = Vec::new();
        let mut bodies = HashMap::new();
        for (rel, (kind, body)) in pages.iter() {
            nodes.push(Node {
                rel: rel.clone(),
                is_dir: false,
                is_page: true,
                kind: kind.clone(),
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
    fn write(&self, rel: &str, kind: &str, data: &[u8], _create: bool) -> Result<(), PErr> {
        self.pages
            .lock()
            .unwrap()
            .insert(rel.to_string(), (kind.to_string(), data.to_vec()));
        Ok(())
    }
    fn mkdir(&self, _rel: &str) -> Result<(), PErr> {
        Ok(())
    }
    fn delete(&self, rel: &str) -> Result<(), PErr> {
        self.pages.lock().unwrap().remove(rel);
        Ok(())
    }
    fn mv(&self, src: &str, dst: &str) -> Result<(), PErr> {
        let v = self.pages.lock().unwrap().remove(src);
        if let Some(v) = v {
            self.pages.lock().unwrap().insert(dst.to_string(), v);
        }
        Ok(())
    }
    fn watch(&self, _on_event: &(dyn Fn(lattice_fs::transport::WatchEvent) + Send + Sync)) {}
}

fn fsx_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FSX_BIN") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    // the default tests/fsx.sh builds into
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/fsx");
    p.is_file().then_some(p)
}

#[test]
fn fsx_finds_no_read_write_truncate_mismatch() {
    // env overrides make a longer soak a one-liner without touching the file
    let ops: usize = env_or("FSX_OPS", OPS);
    let seed: u32 = env_or("FSX_SEED", SEED);
    let Some(fsx) = fsx_bin() else {
        eprintln!("skipped: no fsx binary (run tests/fsx.sh, or set FSX_BIN)");
        return;
    };

    let tmp = std::env::temp_dir().join(format!("lattice-fs-fsx-{}", std::process::id()));
    let mnt = tmp.join("mnt");
    let logs = tmp.join("logs"); // .fsxgood/.fsxlog live OUTSIDE the mount
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&mnt).unwrap();
    fs::create_dir_all(&logs).unwrap();

    let ship = Arc::new(Ship::default());
    ship.pages.lock().unwrap().insert("torture".into(), ("md".into(), Vec::new()));

    let session = match lattice_fs::spawn(ship.clone() as Arc<dyn Projection>, mnt.to_str().unwrap())
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("skipped: no usable FUSE here ({e})");
            let _ = fs::remove_dir_all(&tmp);
            return;
        }
    };

    let out = Command::new(&fsx)
        .arg("-R") // no mmap read  \ this filesystem implements no mmap at all,
        .arg("-W") // no mmap write /  so both are required, not optional
        .args(["-N", &ops.to_string()])
        .args(["-S", &seed.to_string()])
        .args(["-l", &MAX_FILE.to_string()])
        .args(["-c", &CLOSE_PROB.to_string()])
        .args(["-P", logs.to_str().unwrap()])
        .arg(mnt.join("torture.md"))
        .output();

    drop(session); // unmount before asserting, so a failure cannot leave it up
    let out = match out {
        Ok(o) => o,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            panic!("could not run {}: {e}", fsx.display());
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let ok = out.status.success();
    let report = format!(
        "fsx {ops} ops, seed {seed}\n--- stdout ---\n{stdout}\n--- stderr ---\n{}",
        String::from_utf8_lossy(&out.stderr),
    );
    let _ = fs::remove_dir_all(&tmp);
    assert!(ok, "fsx found a mismatch.\n{report}");
    // A zero exit is not enough on its own: fsx also exits 0 if it never got
    // as far as an operation. This line is printed only after every op has
    // been replayed against the in-memory oracle and matched.
    assert!(
        stdout.contains("All operations completed A-OK!"),
        "fsx exited clean without completing its run.\n{report}"
    );
    println!("fsx: {ops} ops (seed {seed}) with no mismatch");
}
