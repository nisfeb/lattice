//! Persisted app config: the ship URL and the mounts to restore on launch.
//! Lives at <app_config_dir>/config.json.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Config {
    pub url: String,
    #[serde(default)]
    pub mounts: Vec<MountSpec>,
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

fn path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .expect("no config dir")
        .join("config.json")
}

pub fn load(app: &tauri::AppHandle) -> Config {
    load_at(&path(app))
}

pub fn save(app: &tauri::AppHandle, c: &Config) -> Result<(), String> {
    save_at(&path(app), c)
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
