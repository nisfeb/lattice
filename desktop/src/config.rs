//! Persisted app config: the ship URL and the mounts to restore on launch.
//! Lives at <app_config_dir>/config.json.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Config {
    pub url: String,
    #[serde(default)]
    pub mounts: Vec<MountSpec>,
    /// The ship's @p, learned at connect. Display and queue keying only.
    #[serde(default)]
    pub ship: String,
    /// The offline queue's directory key, resolved ONCE and then never
    /// recomputed. See queue.rs: a key that improved itself later would
    /// rename the queue directory out from under the edits it protects.
    #[serde(default)]
    pub queue_key: String,
    /// Scheduled vault backups to the host. Empty by default — nothing is
    /// written to anyone's disk until they ask for it.
    #[serde(default)]
    pub backups: Vec<BackupSchedule>,
}

/// One recurring backup: how often, where, and how many to keep.
///
/// Several of these are the point. "7 daily, 4 weekly, 12 monthly" is three
/// schedules pointing at the same directory with different periods and
/// different keep counts, which is why retention is per-schedule and pruning
/// only ever considers a schedule's OWN archives.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct BackupSchedule {
    /// stable identity, so editing a schedule does not orphan its archives
    pub id: String,
    /// user's name for it, and the archive filename stem: lattice-<label>-<stamp>.tar
    pub label: String,
    /// period in hours. Hours rather than a calendar rule because a period is
    /// all this needs: 24 daily, 168 weekly, 720 monthly. A real calendar
    /// month would drag in date arithmetic to answer a question nobody asked —
    /// "monthly" here means every 30 days, and the UI says so.
    pub every_hours: u64,
    /// how many of THIS schedule's archives to keep. 0 means keep everything.
    pub keep: u32,
    /// host directory the archives are written to
    pub dir: String,
    /// unix seconds of the last successful write. 0 = never run.
    #[serde(default)]
    pub last_run: u64,
    /// paused schedules stay configured but never come due
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MountSpec {
    pub mountpoint: String,
    pub root: String,
    /// lick socket inside a local pier. Empty = mount over HTTP against the
    /// configured ship, which is what every pre-lick config has. Hence
    /// serde(default), so an existing config.json still loads.
    #[serde(default)]
    pub sock: String,
    /// @p label for a lick mount, display only
    #[serde(default)]
    pub ship: String,
}

pub fn load_at(p: &Path) -> Config {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_at(p: &Path, c: &Config) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    std::fs::write(p, s).map_err(|e| e.to_string())
}

fn path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn require_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    path(app).ok_or_else(|| "no app config dir to save into".to_string())
}

/// A config we cannot locate reads as the default, exactly as an unreadable or
/// corrupt one does (see load_at). load runs on the backup thread, on the
/// remount thread and inside the webview's navigation callback, so losing the
/// config dir must not take any of them down with it.
pub fn load(app: &tauri::AppHandle) -> Config {
    match path(app) {
        Some(p) => load_at(&p),
        None => {
            crate::commands::dlog("config: no app config dir; using defaults");
            Config::default()
        }
    }
}

/// The one lock guarding every load-modify-save span through config.json.
/// It lives here, with the load and the save it sits between, rather than
/// with any one caller: a lock a caller can reach around is no lock at all.
/// connect, add_mount, remove_mount, queue_key, set_backup_schedules, and
/// backup_write all take this same lock now; before, a private mutex in
/// commands.rs covered only the last two, and the other four raced it freely.
fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
}

/// Load config.json at `p`, hand it to `f` to mutate, save only if `f`
/// succeeds, all under the one lock, so a failure (the schedule an id names
/// is gone, an archive write failed) leaves the file untouched instead of
/// persisting a half-applied change. Raw-path, alongside load_at/save_at, so
/// a test can drive the exact span a real caller runs without a live
/// AppHandle.
pub fn try_update_at<T>(
    p: &Path,
    f: impl FnOnce(&mut Config) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = lock().lock().unwrap();
    let mut cfg = load_at(p);
    let out = f(&mut cfg)?;
    save_at(p, &cfg)?;
    Ok(out)
}

/// Load, let `f` mutate in place, save unconditionally, all under the one
/// lock. The shape every plain writer (no failure path of its own) wants.
pub fn update_at(p: &Path, f: impl FnOnce(&mut Config)) -> Result<Config, String> {
    try_update_at(p, |cfg| {
        f(cfg);
        Ok(cfg.clone())
    })
}

/// try_update_at against the app's own config.json.
pub fn try_update<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&mut Config) -> Result<T, String>,
) -> Result<T, String> {
    try_update_at(&require_path(app)?, f)
}

/// update_at against the app's own config.json. The helper every ordinary
/// writer should reach for: load config.json, apply `f`, save it back, all
/// under the one lock, so no caller can load-modify-save around it.
pub fn update(app: &tauri::AppHandle, f: impl FnOnce(&mut Config)) -> Result<Config, String> {
    update_at(&require_path(app)?, f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        // per-process path: several test binaries run at once under
        // cargo-mutants, and a shared filename had them clobbering each other
        let p = tmp("roundtrip");
        let c = Config {
            url: "http://localhost:8080".into(),
            ship: String::new(),
            queue_key: String::new(),
            // a schedule must survive the round trip too: it is the only thing
            // in here whose loss silently stops backups from ever running
            backups: vec![BackupSchedule {
                id: "b1".into(),
                label: "daily".into(),
                every_hours: 24,
                keep: 7,
                dir: "/tmp/backups".into(),
                last_run: 1_700_000_000,
                enabled: true,
            }],
            mounts: vec![MountSpec {
                mountpoint: "/tmp/l".into(),
                root: "notes".into(),
                sock: String::new(),
                ship: String::new(),
            }],
        };
        save_at(&p, &c).unwrap();
        let back = load_at(&p);
        assert_eq!(back.url, c.url);
        assert_eq!(back.mounts.len(), 1);
        assert_eq!(back.mounts[0].root, "notes");
        std::fs::remove_file(&p).ok();
    }

    use proptest::prelude::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "lattice-cfg-prop-{}-{tag}-{}.json",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    proptest! {
        // few cases: each one touches the filesystem
        #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

        // a corrupt/hand-edited config file must load as the default, never
        // panic the app at startup
        #[test]
        fn load_is_total_on_arbitrary_bytes(bytes in proptest::collection::vec(any::<u8>(), 0..256)) {
            let p = tmp("junk");
            std::fs::write(&p, &bytes).unwrap();
            let _ = load_at(&p);
            std::fs::remove_file(&p).ok();
        }

        // save -> load is the identity for any field content (quotes,
        // backslashes, unicode, everything JSON escaping must survive)
        #[test]
        fn config_roundtrips(
            url in ".{0,32}",
            mounts in proptest::collection::vec((".{0,16}", ".{0,16}", ".{0,16}", ".{0,16}"), 0..4),
        ) {
            let c = Config {
                url: url.clone(),
                ship: String::new(),
                queue_key: String::new(),
                backups: Vec::new(),
                mounts: mounts
                    .iter()
                    .map(|(mountpoint, root, sock, ship)| MountSpec {
                        mountpoint: mountpoint.clone(),
                        root: root.clone(),
                        sock: sock.clone(),
                        ship: ship.clone(),
                    })
                    .collect(),
            };
            let p = tmp("rt");
            save_at(&p, &c).unwrap();
            let back = load_at(&p);
            std::fs::remove_file(&p).ok();
            prop_assert_eq!(back.url, c.url);
            prop_assert_eq!(back.mounts.len(), c.mounts.len());
            for (b, a) in back.mounts.iter().zip(&c.mounts) {
                prop_assert_eq!(&b.mountpoint, &a.mountpoint);
                prop_assert_eq!(&b.root, &a.root);
                prop_assert_eq!(&b.sock, &a.sock);
                prop_assert_eq!(&b.ship, &a.ship);
            }
        }
    }
}
