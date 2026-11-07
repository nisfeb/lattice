//! The rules every JSON store in the data dir follows.
//!
//! - A file that will not parse is moved aside to `<name>.corrupt-<time>`
//!   and logged before the store starts empty. The next write would
//!   otherwise erase the only copy of whatever was in it.
//! - A read-modify-write holds an exclusive file lock beside the store, so
//!   a second copy of the app on the same data dir cannot interleave with
//!   this one. The in-process Mutex each store has only covers one process.
//! - The data dir itself is locked once at startup (`lock_dir`), so a
//!   second copy says so and exits instead of sharing it.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Where a store that will not parse is moved: `<name>.corrupt-<secs>`,
/// with a counter when that name is taken, so a second corrupt copy in the
/// same second never replaces the first.
fn aside_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let base = path.with_file_name(format!("{name}.corrupt-{}", now_secs()));
    if !base.exists() {
        return base;
    }
    (1..)
        .map(|i| path.with_file_name(format!("{name}.corrupt-{}-{i}", now_secs())))
        .find(|p| !p.exists())
        .unwrap_or(base)
}

/// Read the JSON store at `path`. Missing is the default. A file that will
/// not parse is moved aside and logged, and only then is the default
/// returned. When it cannot be moved aside, the default is still returned,
/// and the log says the file is still in place.
pub fn read_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return T::default(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            let aside = aside_path(path);
            let moved = std::fs::rename(path, &aside);
            crate::commands::dlog(&format!(
                "store: {} does not parse ({e}); {}",
                path.display(),
                match moved {
                    Ok(()) => format!("moved aside to {}", aside.display()),
                    Err(m) => format!("could not move it aside ({m})"),
                }
            ));
            T::default()
        }
    }
}

/// The lock file beside a store: `.<name>.lock`.
fn lock_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!(".{name}.lock"))
}

fn open_lock(p: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    if let Some(dir) = p.parent() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(p)
}

/// Run `f` holding an exclusive lock on the store at `path`, across
/// processes. The lock is released when `f` returns.
pub fn locked<R>(path: &Path, f: impl FnOnce() -> R) -> Result<R, String> {
    let lp = lock_path(path);
    let file = open_lock(&lp).map_err(|e| format!("{}: {e}", lp.display()))?;
    file.lock().map_err(|e| format!("{}: {e}", lp.display()))?;
    let out = f();
    let _ = file.unlock();
    Ok(out)
}

/// The data dir's lock, held for as long as the app runs.
pub struct DirLock {
    _file: File,
}

/// The name of the data dir's lock file.
pub const DIR_LOCK: &str = "lattice.lock";

/// Take the data dir's exclusive lock. Err names why: another copy holds
/// it (with its pid when it wrote one), or the file could not be opened.
pub fn lock_dir(dir: &Path) -> Result<DirLock, String> {
    use std::io::{Read, Seek, Write};
    let p = dir.join(DIR_LOCK);
    let mut file = open_lock(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    match file.try_lock() {
        Ok(()) => {
            let _ = file.set_len(0);
            let _ = file.seek(std::io::SeekFrom::Start(0));
            let _ = write!(file, "{}", std::process::id());
            Ok(DirLock { _file: file })
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            let mut pid = String::new();
            let _ = file.read_to_string(&mut pid);
            let pid = pid.trim();
            Err(if pid.is_empty() {
                format!("another copy of lattice is already using {}", dir.display())
            } else {
                format!("another copy of lattice (pid {pid}) is already using {}", dir.display())
            })
        }
        Err(std::fs::TryLockError::Error(e)) => Err(format!("{}: {e}", p.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "lattice-store-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn asides(d: &Path, name: &str) -> Vec<PathBuf> {
        std::fs::read_dir(d)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(&format!("{name}.corrupt-")))
            .collect()
    }

    #[test]
    fn a_store_that_will_not_parse_is_moved_aside_not_erased() {
        let d = tmp("corrupt");
        let p = d.join("s.json");
        std::fs::write(&p, b"{half a store").unwrap();
        let got: Vec<u32> = read_json(&p);
        assert!(got.is_empty());
        assert!(!p.exists(), "the corrupt file is no longer where the next write lands");
        let a = asides(&d, "s.json");
        assert_eq!(a.len(), 1);
        assert_eq!(std::fs::read(&a[0]).unwrap(), b"{half a store");
        // a second corrupt copy in the same second keeps the first
        std::fs::write(&p, b"[nope").unwrap();
        let _: Vec<u32> = read_json(&p);
        assert_eq!(asides(&d, "s.json").len(), 2);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn missing_and_good_stores_read_normally() {
        let d = tmp("good");
        let p = d.join("s.json");
        let got: Vec<u32> = read_json(&p);
        assert!(got.is_empty());
        std::fs::write(&p, b"[1,2]").unwrap();
        let got: Vec<u32> = read_json(&p);
        assert_eq!(got, [1, 2]);
        assert!(asides(&d, "s.json").is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_second_holder_of_the_data_dir_is_refused() {
        let d = tmp("dirlock");
        let first = lock_dir(&d).expect("first copy takes the lock");
        let second = lock_dir(&d).err().expect("a second copy is refused");
        assert!(second.contains(&std::process::id().to_string()), "{second}");
        drop(first);
        lock_dir(&d).expect("free again once the first copy exits");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn locked_read_modify_writes_from_two_handles_lose_nothing() {
        // Two handles on one file stand in for two processes: flock locks
        // belong to the open file description, so they exclude each other
        // the same way.
        let d = tmp("rmw");
        let p = d.join("n.json");
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let p = p.clone();
                std::thread::spawn(move || {
                    for _ in 0..25 {
                        locked(&p, || {
                            let mut v: Vec<u32> = read_json(&p);
                            v.push(1);
                            std::thread::yield_now();
                            crate::session::write_private(&p, &serde_json::to_vec(&v).unwrap()).unwrap();
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let v: Vec<u32> = read_json(&p);
        assert_eq!(v.len(), 200);
        std::fs::remove_dir_all(&d).ok();
    }
}
