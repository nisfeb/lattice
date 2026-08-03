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
pub fn heal_mountpoint(mountpoint: &str) {
    match std::fs::metadata(mountpoint) {
        Err(e) if e.raw_os_error() == Some(107) => {
            #[cfg(target_os = "macos")]
            let _ = std::process::Command::new("umount").arg(mountpoint).status();
            #[cfg(not(target_os = "macos"))]
            let _ = std::process::Command::new("fusermount3")
                .args(["-u", mountpoint])
                .status();
        }
        Err(_) => {
            let _ = std::fs::create_dir_all(mountpoint);
        }
        Ok(_) => {}
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
