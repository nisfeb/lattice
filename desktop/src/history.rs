//! The shipless reader's history: the pages read without a ship, newest
//! first, kept in `<app_data_dir>/urb/history.json` and nowhere else. It is
//! never sent anywhere, and it is the only thing the shipless reader keeps
//! besides the engine's own state: bookmarks, follows and comments are ship
//! actions and are not kept locally.

// nothing reads it until the reader does
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Most entries kept; the oldest go first.
pub const MAX: usize = 500;
/// Longest title kept, in characters.
pub const TITLE_MAX: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Entry {
    pub url: String,
    pub title: String,
    /// ms since 1970
    pub at: u64,
}

pub struct History {
    file: PathBuf,
    /// one writer at a time: two reads finishing together must not lose
    /// either entry
    lock: Mutex<()>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl History {
    pub fn open(dir: &Path) -> History {
        History { file: dir.join("history.json"), lock: Mutex::new(()) }
    }

    /// Newest first. A missing or unreadable file is an empty history.
    pub fn list(&self) -> Vec<Entry> {
        std::fs::read(&self.file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Record a read: a page read again moves to the top.
    pub fn add(&self, url: &str, title: &str) -> Result<(), String> {
        self.add_at(url, title, now_ms())
    }

    fn add_at(&self, url: &str, title: &str, at: u64) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let mut all = self.list();
        all.retain(|e| e.url != url);
        all.insert(
            0,
            Entry { url: url.to_string(), title: title.chars().take(TITLE_MAX).collect(), at },
        );
        all.truncate(MAX);
        self.write(&all)
    }

    pub fn clear(&self) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        self.write(&[])
    }

    /// Whole or not at all: a temp file beside it, then a rename.
    fn write(&self, all: &[Entry]) -> Result<(), String> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let dir = self.file.parent().ok_or("history: no folder")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("history: {e}"))?;
        let tmp = dir.join(".history.json.tmp");
        let body = serde_json::to_vec(all).map_err(|e| format!("history: {e}"))?;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("history: {e}"))?;
        f.write_all(&body).and_then(|_| f.sync_all()).map_err(|e| format!("history: {e}"))?;
        std::fs::rename(&tmp, &self.file).map_err(|e| format!("history: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(name: &str) -> (PathBuf, History) {
        let d = std::env::temp_dir().join(format!("history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let h = History::open(&d);
        (d, h)
    }

    #[test]
    fn newest_first_and_capped_at_five_hundred() {
        let (d, h) = fresh("cap");
        for i in 0..(MAX + 3) {
            h.add_at(&format!("urb://~zod/p{i}"), "t", i as u64).unwrap();
        }
        let l = h.list();
        assert_eq!(l.len(), MAX);
        assert_eq!(l[0].url, format!("urb://~zod/p{}", MAX + 2));
        assert_eq!(l[MAX - 1].url, "urb://~zod/p3");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_page_read_again_moves_to_the_top_once() {
        let (d, h) = fresh("dedupe");
        h.add_at("urb://~zod/a", "A", 1).unwrap();
        h.add_at("urb://~zod/b", "B", 2).unwrap();
        h.add_at("urb://~zod/a", "A again", 3).unwrap();
        let l = h.list();
        assert_eq!(l.iter().map(|e| e.url.as_str()).collect::<Vec<_>>(), ["urb://~zod/a", "urb://~zod/b"]);
        assert_eq!((l[0].title.as_str(), l[0].at), ("A again", 3));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn clear_empties_it() {
        let (d, h) = fresh("clear");
        h.add("urb://~zod/a", "A").unwrap();
        h.clear().unwrap();
        assert!(h.list().is_empty());
        assert_eq!(std::fs::read_to_string(d.join("history.json")).unwrap(), "[]");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_corrupt_file_reads_empty_and_is_replaced() {
        let (d, h) = fresh("corrupt");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("history.json"), b"{not json").unwrap();
        assert!(h.list().is_empty());
        h.add("urb://~zod/a", "A").unwrap();
        assert_eq!(h.list().len(), 1);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn long_titles_are_cut() {
        let (d, h) = fresh("title");
        h.add("urb://~zod/a", &"é".repeat(400)).unwrap();
        assert_eq!(h.list()[0].title.chars().count(), TITLE_MAX);
        std::fs::remove_dir_all(d).unwrap();
    }
}
