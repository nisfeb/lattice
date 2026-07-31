//! In-process fuse mounts. Each live mount is a fuser::BackgroundSession;
//! dropping the session unmounts, so removing from the map IS the unmount.

use std::collections::HashMap;
use std::sync::Mutex;

use lattice_fs::{default_cookie_path, projection_http};
use tauri::{AppHandle, State};

use crate::config::{self, MountSpec};

/// mountpoint -> (root, live session)
pub struct MountMap(pub Mutex<HashMap<String, (String, fuser::BackgroundSession)>>);

/// macOS needs macFUSE installed; Linux needs fusermount3 on PATH.
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

#[tauri::command]
pub fn add_mount(
    app: AppHandle,
    map: State<MountMap>,
    mountpoint: String,
    root: String,
) -> Result<(), String> {
    let mountpoint = expand_home(mountpoint.trim());
    let mut m = map.0.lock().unwrap();
    if m.contains_key(&mountpoint) {
        return Err(format!("{mountpoint} is already mounted"));
    }
    let cfg = config::load(&app);
    if cfg.url.is_empty() {
        return Err("connect to a ship first".into());
    }
    heal_mountpoint(&mountpoint);
    let proj = projection_http(&cfg.url, &default_cookie_path(), &root)?;
    let session = lattice_fs::spawn(proj, &mountpoint).map_err(|e| e.to_string())?;
    m.insert(mountpoint.clone(), (root.clone(), session));
    // persist for auto-remount on launch
    let mut cfg = config::load(&app);
    cfg.mounts.retain(|s| s.mountpoint != mountpoint);
    cfg.mounts.push(MountSpec { mountpoint, root });
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
pub fn list_mounts(map: State<MountMap>) -> Vec<MountSpec> {
    map.0
        .lock()
        .unwrap()
        .iter()
        .map(|(mp, (root, _))| MountSpec { mountpoint: mp.clone(), root: root.clone() })
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
