//! The shipless reader's history: the pages read without a ship, newest
//! first, kept in `<app_data_dir>/urb/history.json` and nowhere else. It is
//! never sent anywhere, and with the followed folders beside it
//! (follows.rs) it is all the shipless reader keeps besides the engine's own
//! state: bookmarks and comments are ship actions and are not kept locally.


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
}

/// One writer at a time, across every History in the process: two reads
/// finishing together must not lose either entry. Process-wide, not per
/// instance, because clear_reader_history opens its own History on the same
/// file, and with a lock of its own a page read during the clear wrote back
/// the list it read before the clear, undoing it.
static LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl History {
    pub fn open(dir: &Path) -> History {
        History { file: dir.join("history.json") }
    }

    /// The folder the history is kept in.
    pub fn dir(&self) -> &Path {
        self.file.parent().unwrap_or(Path::new("."))
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
        let _g = self.guard();
        let mut all = self.list();
        all.retain(|e| e.url != url);
        all.insert(
            0,
            Entry { url: url.to_string(), title: title.chars().take(TITLE_MAX).collect(), at },
        );
        all.truncate(MAX);
        self.write(&all)
    }

    fn guard(&self) -> std::sync::MutexGuard<'static, ()> {
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn clear(&self) -> Result<(), String> {
        let _g = self.guard();
        self.write(&[])
    }

    /// Whole or not at all, and private: write_private's temp file beside
    /// it, then a rename, in a folder made 0700 as the engine makes it.
    fn write(&self, all: &[Entry]) -> Result<(), String> {
        let body = serde_json::to_vec(all).map_err(|e| format!("history: {e}"))?;
        crate::session::write_private(&self.file, &body).map_err(|e| format!("history: {e}"))
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
    fn a_second_history_on_the_same_file_waits_for_the_first() {
        // clear_reader_history opens its own History. While one writer is
        // mid load-modify-save, a write through the other must wait.
        let (d, h) = fresh("shared-lock");
        let other = History::open(&d);
        let g = h.guard();
        let t = std::thread::spawn(move || other.add_at("urb://~zod/x", "x", 1).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(h.list().is_empty(), "the other History wrote while this one held the lock");
        drop(g);
        t.join().unwrap();
        assert_eq!(h.list().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
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
