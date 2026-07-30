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
        let dir = std::env::temp_dir().join("lattice-desktop-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("config.json");
        let c = Config {
            url: "http://localhost:8080".into(),
            mounts: vec![MountSpec { mountpoint: "/tmp/l".into(), root: "notes".into() }],
        };
        save_at(&p, &c).unwrap();
        let back = load_at(&p);
        assert_eq!(back.url, c.url);
        assert_eq!(back.mounts.len(), 1);
        assert_eq!(back.mounts[0].root, "notes");
        std::fs::remove_file(&p).ok();
    }
}
