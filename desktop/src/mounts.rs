//! In-process fuse mounts. Each live mount is a fuser::BackgroundSession.
//! Dropping the session unmounts, so removing from the map IS the unmount.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use lattice_fs::{default_cookie_path, projection_http};
use tauri::{AppHandle, State};

use crate::config::{self, MountSpec};

/// mountpoint -> (root, live session)
pub struct MountMap(pub Mutex<HashMap<String, (String, fuser::BackgroundSession)>>);

/// Mountpoints with a mount in flight.
///
/// The map cannot express this on its own: its value is a live session, and
/// the moment a reservation is needed is precisely the moment no session
/// exists yet. Without it, two adds of the same path both get past the map
/// check while the lock is down and both reach `heal_mountpoint`, which runs
/// `fusermount3 -uz` and would tear down the mount the other one just made.
/// Re-checking the map afterwards repairs the map and not the filesystem.
fn inflight() -> &'static Mutex<HashSet<String>> {
    static INFLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    INFLIGHT.get_or_init(Default::default)
}

/// Holds a mountpoint's reservation and releases it on every exit path,
/// including the `?` returns between here and the insert.
struct Reservation(String);
impl Drop for Reservation {
    fn drop(&mut self) {
        inflight().lock().unwrap().remove(&self.0);
    }
}

/// macOS needs macFUSE installed. Linux needs fusermount3 on PATH.
pub fn fuse_check() -> (bool, String) {
    #[cfg(target_os = "macos")]
    {
        let ok = std::path::Path::new("/Library/Filesystems/macfuse.fs").exists();
        let hint = if ok { String::new() } else {
            "macFUSE not found — install it from https://macfuse.github.io".into()
        };
        (ok, hint)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let ok = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|d| d.join("fusermount3").exists()))
            .unwrap_or(false);
        let hint = if ok { String::new() } else {
            "fusermount3 not found — install your distro's fuse3 package".into()
        };
        (ok, hint)
    }
}

#[derive(serde::Serialize)]
pub struct Status {
    pub fuse_available: bool,
    pub hint: String,
}

#[tauri::command]
pub fn status() -> Status {
    let (fuse_available, hint) = fuse_check();
    Status { fuse_available, hint }
}

/// Build the projection for a mount. A `sock` selects lick, a ship on this
/// machine, reachable with no URL, no +code and no cookie, because opening the
/// socket inside the pier IS the authorization. Otherwise HTTP against the
/// configured ship, which does need a session.
pub fn projection_for(
    app: &AppHandle,
    root: &str,
    sock: &str,
    ship: &str,
) -> Result<std::sync::Arc<dyn lattice_fs::Projection>, String> {
    if !sock.is_empty() {
        if !std::path::Path::new(sock).exists() {
            return Err(format!(
                "{sock} is gone — that ship is not running, or its lattice is not up"
            ));
        }
        return lattice_fs::projection_lick(sock, ship, root);
    }
    let cfg = config::load(app);
    if cfg.url.is_empty() {
        return Err("connect to a ship first, or mount a ship running on this machine".into());
    }
    projection_http(&cfg.url, &default_cookie_path(), root)
}

#[tauri::command]
pub fn add_mount(
    app: AppHandle,
    map: State<MountMap>,
    mountpoint: String,
    root: String,
    sock: Option<String>,
    ship: Option<String>,
) -> Result<(), String> {
    let mountpoint = expand_home(mountpoint.trim());
    let sock = sock.unwrap_or_default();
    let ship = ship.unwrap_or_default();
    validate_mountpoint(&mountpoint)?;
    // Cheap checks under the locks, then RELEASE them. Neither lock spans I/O,
    // the same rule remount() follows: status, list_mounts and remove_mount
    // stay answerable while a mount is coming up, and healing a wedged
    // mountpoint alone can take 5 seconds.
    //
    // The reservation is taken here rather than after the I/O because
    // heal_mountpoint is destructive. A second add that got this far would
    // unmount the first one's session, and no later map check can undo that.
    let _reserved = {
        let mut inf = inflight().lock().unwrap();
        if map.0.lock().unwrap().contains_key(&mountpoint) {
            return Err(format!("{mountpoint} is already mounted"));
        }
        if !inf.insert(mountpoint.clone()) {
            return Err(format!("{mountpoint} is already being mounted"));
        }
        Reservation(mountpoint.clone())
    };
    let proj = projection_for(&app, &root, &sock, &ship)?;
    heal_mountpoint(&mountpoint);
    let session = lattice_fs::spawn(proj, &mountpoint).map_err(|e| e.to_string())?;
    {
        let mut m = map.0.lock().unwrap();
        // remove_mount could have run while this mount was coming up, so the
        // map is still re-checked. The reservation is what makes a competing
        // ADD impossible; this covers everything else.
        if m.contains_key(&mountpoint) {
            drop(session); // dropping the session IS the unmount
            return Err(format!("{mountpoint} is already mounted"));
        }
        m.insert(mountpoint.clone(), (root.clone(), session));
    }
    // persist for auto-remount on launch
    let mut cfg = config::load(&app);
    cfg.mounts.retain(|s| s.mountpoint != mountpoint);
    cfg.mounts.push(MountSpec { mountpoint, root, sock, ship });
    config::save(&app, &cfg)
}

#[tauri::command]
pub fn remove_mount(
    app: AppHandle,
    map: State<MountMap>,
    mountpoint: String,
) -> Result<(), String> {
    let removed = map.0.lock().unwrap().remove(&mountpoint); // drop = unmount
    if removed.is_none() {
        return Err(format!("{mountpoint} is not mounted"));
    }
    let mut cfg = config::load(&app);
    cfg.mounts.retain(|s| s.mountpoint != mountpoint);
    config::save(&app, &cfg)
}

#[tauri::command]
pub fn list_mounts(app: AppHandle, map: State<MountMap>) -> Vec<MountSpec> {
    // the live sessions are the truth about what is mounted. The config
    // carries how each one is reached, so the list can say "over lick".
    let cfg = config::load(&app);
    map.0
        .lock()
        .unwrap()
        .iter()
        .map(|(mp, (root, _))| {
            let saved = cfg.mounts.iter().find(|s| &s.mountpoint == mp);
            MountSpec {
                mountpoint: mp.clone(),
                root: root.clone(),
                sock: saved.map(|s| s.sock.clone()).unwrap_or_default(),
                ship: saved.map(|s| s.ship.clone()).unwrap_or_default(),
            }
        })
        .collect()
}

/// Is this path a fuse mount, according to the kernel's own table?
///
/// Read from /proc, which never enters the filesystem, so it cannot block the
/// way stat() does. That distinction is the whole point: stat() on a mount
/// whose daemon is alive but WEDGED never returns, and the caller is parked in
/// uninterruptible sleep where even SIGKILL cannot reach it.
#[cfg(target_os = "linux")]
fn is_fuse_mount(mountpoint: &str) -> bool {
    let Ok(table) = std::fs::read_to_string("/proc/self/mounts") else {
        return false;
    };
    table.lines().any(|line| {
        let mut f = line.split_whitespace();
        let (_dev, dir, ty) = (f.next(), f.next(), f.next());
        //  /proc escapes spaces (and a few others) as octal
        dir.map(|d| d.replace("\\040", " ")).as_deref() == Some(mountpoint)
            //  "fuse" or "fuse.sshfs", but NOT "fusectl": that is the kernel
            //  control filesystem at /sys/fs/fuse/connections, and a prefix
            //  test would have had us trying to unmount it.
            && ty.is_some_and(|t| t == "fuse" || t.starts_with("fuse."))
    })
}

/// stat(), but the caller gets control back even if the filesystem never
/// answers. The probe thread stays parked in that case, which we cannot help:
/// it is blocked in the kernel. What matters is that WE are not.
fn stat_bounded(mountpoint: &str, wait: std::time::Duration) -> Option<std::io::Result<()>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let p = mountpoint.to_string();
    std::thread::spawn(move || {
        let _ = tx.send(std::fs::metadata(&p).map(|_| ()));
    });
    rx.recv_timeout(wait).ok()
}

/// Make a mountpoint usable: detach a mount left by a previous run, and create
/// the directory if it does not exist yet.
///
/// A stale mount is detached WITHOUT stat'ing it first. The old code only
/// recognised os error 107 (ENOTCONN), which is a DEAD daemon; a daemon that
/// is alive but hung returns nothing at all, so the stat blocked forever. On
/// the startup path that produced an app that never opened a window and could
/// not be killed, which is how this was found.
pub fn heal_mountpoint(mountpoint: &str) {
    #[cfg(target_os = "linux")]
    if is_fuse_mount(mountpoint) {
        //  lazy: detach now even if something is still parked on it
        let _ = std::process::Command::new("fusermount3")
            .args(["-uz", mountpoint])
            .status();
    }
    match stat_bounded(mountpoint, std::time::Duration::from_secs(5)) {
        //  it answered and is gone: make the directory
        Some(Err(e)) if e.raw_os_error() == Some(107) => {
            #[cfg(target_os = "macos")]
            let _ = std::process::Command::new("umount").arg(mountpoint).status();
            #[cfg(not(target_os = "macos"))]
            let _ = std::process::Command::new("fusermount3")
                .args(["-uz", mountpoint])
                .status();
        }
        Some(Err(_)) => {
            let _ = std::fs::create_dir_all(mountpoint);
        }
        Some(Ok(())) => {}
        //  never answered. Leave it alone rather than pile more blocked calls
        //  onto it; the mount this was preparing for will fail and say so.
        None => eprintln!("heal_mountpoint: {mountpoint} did not respond, skipping"),
    }
}

fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    p.to_string()
}

/// The mountpoint comes from the webview, which renders ship-served content.
/// Mounting FUSE over an arbitrary path — a mountpoint of `/etc` or
/// `~/.ssh` — would shadow a directory the user did not mean to hide behind a
/// live filesystem. So the path is validated as a trust boundary, the same
/// reasoning as `openable()` for URLs: policy here, not a suggestion in the
/// page's javascript.
///
/// Two rules. The mountpoint must resolve in-or-under `$HOME` (after symlink
/// resolution, so `~/link -> /etc` cannot escape), and it must not be an
/// existing NON-EMPTY directory (mounting over content hides it for the life
/// of the mount, which reads as lost files). A missing path is fine —
/// heal_mountpoint creates it — and an existing EMPTY dir is the normal case.
fn validate_mountpoint(mountpoint: &str) -> Result<(), String> {
    let p = std::path::Path::new(mountpoint);
    if mountpoint.trim().is_empty() {
        return Err("mountpoint is empty".into());
    }
    if !p.is_absolute() {
        return Err(format!("{mountpoint}: mountpoint must be an absolute path"));
    }
    // Resolve symlinks. The full path may not exist yet, so canonicalize the
    // longest existing ancestor and re-append the non-existing tail. Only a
    // NotFound walks up a level; anything else (a permission denied) is a real
    // failure, not a reason to keep climbing toward the root.
    let mut ancestor = p;
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let canon = loop {
        match std::fs::canonicalize(ancestor) {
            Ok(c) => break c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                match (ancestor.parent(), ancestor.file_name()) {
                    (Some(par), Some(name)) => {
                        tail.push(name);
                        ancestor = par;
                    }
                    _ => return Err(format!("{mountpoint}: cannot resolve mountpoint")),
                }
            }
            Err(e) => return Err(format!("{}: {e}", ancestor.display())),
        }
    };
    let mut resolved = canon;
    for name in tail.iter().rev() {
        resolved.push(name);
    }
    // A `..` surviving in the not-yet-created tail would let the resolved path
    // escape the canonicalized ancestor. Refuse it outright: a mountpoint has
    // no legitimate need for parent traversal.
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("{mountpoint}: '..' is not allowed in a mountpoint"));
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let home_canon = std::fs::canonicalize(&home).unwrap_or_else(|_| std::path::PathBuf::from(&home));
    if !resolved.starts_with(&home_canon) {
        return Err(format!(
            "{mountpoint}: mounts must live under $HOME ({})",
            home_canon.display()
        ));
    }
    // An existing directory must be empty; an existing non-dir (a file) is
    // never a mountpoint. A missing path is created later, so it passes.
    if let Ok(md) = std::fs::metadata(&resolved) {
        if md.is_dir() {
            let mut entries = std::fs::read_dir(&resolved)
                .map_err(|e| format!("{}: {e}", resolved.display()))?;
            if entries.next().is_some() {
                return Err(format!(
                    "{mountpoint}: not mounting over a non-empty directory"
                ));
            }
        } else {
            return Err(format!("{mountpoint}: exists and is not a directory"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_fuse_mount, stat_bounded};
    use std::time::Duration;

    //  This decides whether we run fusermount3 on a path, so a false positive
    //  means unmounting something we do not own.
    #[test]
    fn only_real_fuse_mounts_are_recognised() {
        assert!(!is_fuse_mount("/"), "root is not fuse");
        assert!(!is_fuse_mount("/no/such/path/here"), "a missing path is not a mount");
        //  fusectl lives here on any linux box with fuse loaded, and its type
        //  starts with "fuse". It must NOT be treated as a fuse mount.
        assert!(
            !is_fuse_mount("/sys/fs/fuse/connections"),
            "fusectl is not a fuse mount and must never be unmounted"
        );
    }

    //  The property that matters is that the CALLER comes back. A wedged
    //  daemon cannot be conjured in a unit test, so this pins the ordinary
    //  path; the timeout branch is what the wedge exercises in the field.
    #[test]
    fn a_responsive_path_answers_within_the_deadline() {
        let r = stat_bounded("/", Duration::from_secs(5));
        assert!(matches!(r, Some(Ok(()))), "root should stat cleanly: {r:?}");
        let missing = stat_bounded("/no/such/path/here", Duration::from_secs(5));
        assert!(matches!(missing, Some(Err(_))), "a missing path errors, it does not hang");
    }

    use super::{expand_home, heal_mountpoint, validate_mountpoint};
    use proptest::prelude::*;

    #[test]
    fn a_mountpoint_is_made_usable_before_anything_mounts_on_it() {
        // Every mount and every remount on launch goes through here first. If
        // it stopped creating the directory, mounting a fresh path would fail
        // for good; if it took the fusermount3 branch for an ordinary missing
        // path, it would try to unmount something that was never mounted and
        // still leave nothing to mount on.
        let base = std::env::temp_dir().join(format!("lattice-heal-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let mp = base.join("nested/mnt");
        let path = mp.to_string_lossy().into_owned();

        heal_mountpoint(&path);
        assert!(mp.is_dir(), "a mountpoint that does not exist yet must be created");

        // healing a live mountpoint is a no-op: it must not disturb a
        // directory that is already there (or already mounted)
        std::fs::write(mp.join("keep"), b"x").unwrap();
        heal_mountpoint(&path);
        assert!(mp.join("keep").exists(), "an existing mountpoint was disturbed");

        std::fs::remove_dir_all(&base).ok();
    }

    /// Every mountpoint rule is relative to $HOME, so these tests need one that
    /// exists on disk. The nix build sandbox sets HOME=/homeless-shelter and
    /// never creates it, so canonicalize() returned NotFound and the unwrap
    /// panicked — a security test failing as a BUILD error, which reads as
    /// "the mount guard is broken" when the guard was never exercised.
    /// Create it when absent; if the sandbox forbids that too, say so out loud
    /// rather than reporting a pass we did not earn.
    fn home_for_test() -> Option<std::path::PathBuf> {
        let h = std::env::var("HOME").ok()?;
        if !std::path::Path::new(&h).exists() {
            std::fs::create_dir_all(&h).ok()?;
        }
        match std::fs::canonicalize(&h) {
            Ok(p) => Some(p),
            Err(e) => {
                eprintln!("SKIPPED: no usable $HOME ({h}): {e}");
                None
            }
        }
    }

    #[test]
    fn a_mountpoint_must_live_under_home_and_not_hide_content() {
        // The mountpoint is webview input. These are the cases that turn
        // "mount a ship's pages" into "shadow a directory the user owns":
        // escaping $HOME, and mounting over a directory that already has
        // things in it.
        let Some(home) = home_for_test() else { return };

        // the normal cases: a missing path under HOME, and an existing EMPTY dir
        let missing = home.join(format!("lattice-val-{}-missing", std::process::id()));
        assert!(validate_mountpoint(missing.to_str().unwrap()).is_ok(),
            "a fresh path under HOME is the common case");
        let empty = home.join(format!("lattice-val-{}-empty", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        assert!(validate_mountpoint(empty.to_str().unwrap()).is_ok(),
            "an existing empty dir is fine");
        std::fs::remove_dir_all(&empty).ok();

        // outside $HOME: refused, whether or not it exists
        assert!(validate_mountpoint("/etc/lattice-mnt").is_err(), "/etc is not under HOME");
        assert!(validate_mountpoint("/tmp/lattice-mnt-x").is_err(), "/tmp is not under HOME");

        // a non-empty dir under HOME: refused (mounting hides its contents)
        let full = home.join(format!("lattice-val-{}-full", std::process::id()));
        std::fs::create_dir_all(&full).unwrap();
        std::fs::write(full.join("keep"), b"x").unwrap();
        let e = validate_mountpoint(full.to_str().unwrap()).unwrap_err();
        assert!(e.contains("non-empty"), "{e}");
        std::fs::remove_dir_all(&full).ok();

        // an existing regular file is not a mountpoint at all
        let file = home.join(format!("lattice-val-{}-file", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_mountpoint(file.to_str().unwrap()).is_err());
        std::fs::remove_file(&file).ok();

        // '..' is refused outright: no parent traversal in a mountpoint
        let dots = format!("{}/x/../mnt", home.display());
        assert!(validate_mountpoint(&dots).is_err(), "'..' must be refused");

        // a relative path is refused before any of the above
        assert!(validate_mountpoint("relative/mnt").is_err());
        assert!(validate_mountpoint("").is_err());
    }

    #[test]
    fn a_symlink_cannot_smuggle_a_mount_out_of_home() {
        // ~/link -> /tmp, then ~/link/mnt: the path STRING is under HOME but
        // resolves outside it. Canonicalizing the existing ancestor catches it.
        let Some(home) = home_for_test() else { return };
        let outside = std::env::temp_dir().join(format!("lattice-esc-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        let link = home.join(format!("lattice-link-{}", std::process::id()));
        std::fs::remove_file(&link).ok();
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let through = link.join("mnt");
        let e = validate_mountpoint(through.to_str().unwrap()).unwrap_err();
        assert!(e.contains("under $HOME"), "symlink escape must be caught: {e}");
        std::fs::remove_file(&link).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    proptest! {
        // total over any user-typed mountpoint, expands exactly the "~/"
        // prefix (against $HOME), and touches nothing else
        #[test]
        fn expand_home_is_exact(p in ".*") {
            let out = expand_home(&p);
            match (p.strip_prefix("~/"), std::env::var("HOME")) {
                (Some(rest), Ok(home)) => prop_assert_eq!(out, format!("{home}/{rest}")),
                _ => prop_assert_eq!(out, p),
            }
        }
    }
}
