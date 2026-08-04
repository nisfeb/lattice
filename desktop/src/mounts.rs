//! In-process fuse mounts. Each live mount is a fuser::BackgroundSession.
//! Dropping the session unmounts, so removing from the map IS the unmount.

use std::collections::HashMap;
use std::sync::Mutex;

use lattice_fs::{default_cookie_path, projection_http};
use tauri::{AppHandle, State};

use crate::config::{self, MountSpec};

/// mountpoint -> (root, live session)
pub struct MountMap(pub Mutex<HashMap<String, (String, fuser::BackgroundSession)>>);

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
    let mut m = map.0.lock().unwrap();
    if m.contains_key(&mountpoint) {
        return Err(format!("{mountpoint} is already mounted"));
    }
    let proj = projection_for(&app, &root, &sock, &ship)?;
    heal_mountpoint(&mountpoint);
    let session = lattice_fs::spawn(proj, &mountpoint).map_err(|e| e.to_string())?;
    m.insert(mountpoint.clone(), (root.clone(), session));
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

/// Make a mountpoint usable: detach a stale fuse mount left by a run that
/// died without unmounting ("Transport endpoint is not connected", os 107),
/// and create the directory if it does not exist yet.
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

    use super::{expand_home, heal_mountpoint};
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
