//! The shipless reader's followed folders: shared folders whose pages it
//! checks for changes, kept in `<app_data_dir>/urb/follows.json` beside the
//! history and, like it, never sent anywhere. Following asks nothing of the
//! publisher: a check reads what the folder's index page reads, the
//! publisher's `/pub/titles` for a published folder or the folder's
//! `dir-index` for one granted to this reader, on launch, every
//! `EVERY` while the app is open, and when the folder's index is opened.
//!
//! A follow keeps the latest snapshot (each page's last change and title)
//! and the seen one (each page's time when it was last read here). A page
//! is new when the latest has it newer than seen, or seen lacks it. What a
//! folder holds when it is first followed counts as seen. A folder that
//! answers with nothing for us (unshared, or no longer granted) is
//! unavailable and stays listed; one that does not answer keeps what it
//! had.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::engine::{DirIndex, PageTitle, Reads};

/// How often each followed folder is checked while the app is open.
pub const EVERY: Duration = Duration::from_secs(30 * 60);
/// How soon a folder that did not answer is tried again.
pub const RETRY: Duration = Duration::from_secs(2 * 60);
/// How long one check may wait on the publisher for each source.
pub const BUDGET: Duration = Duration::from_secs(8);
/// Most follows kept.
pub const MAX: usize = 200;

/// A page as the latest check saw it: unix seconds and its title.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Latest {
    pub secs: i64,
    #[serde(default)]
    pub title: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Ok,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Follow {
    pub ship: String,
    /// `/<path>`, as a page key names it
    pub folder: String,
    /// by page key
    #[serde(default)]
    pub latest: BTreeMap<String, Latest>,
    /// by page key, the page's time when it was last read here
    #[serde(default)]
    pub seen: BTreeMap<String, i64>,
    #[serde(default)]
    pub status: Status,
    /// unix seconds of the last answer, 0 for none yet
    #[serde(default)]
    pub checked: u64,
    /// false until the first answer, whose pages count as seen
    #[serde(default)]
    pub primed: bool,
}

/// What one check of a folder found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Found {
    /// its pages, by key
    Pages(Vec<PageTitle>),
    /// an answer with nothing in the folder for us
    Gone,
    /// no answer
    Silent,
}

/// What the hook hears when a check finds more new pages than there were.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct NewPages {
    pub ship: String,
    pub folder: String,
    pub new: usize,
}

/// The event `NewPages` goes out as (main.rs).
pub const EVENT: &str = "follow-new";

/// The folder's rel, `/a/b` as `["a", "b"]`.
pub fn rel(folder: &str) -> Vec<String> {
    folder.split('/').filter(|s| !s.is_empty()).map(String::from).collect()
}

/// A folder's key, `["a", "b"]` as `/a/b`.
pub fn folder_key(rel: &[String]) -> String {
    format!("/{}", rel.join("/"))
}

/// Whether the page `key` is in `folder`, or a folder under it.
pub fn holds(folder: &str, key: &str) -> bool {
    let (f, k) = (rel(folder), rel(key));
    k.len() > f.len() && k.starts_with(&f)
}

/// The pages in `folder` among `titles`.
pub fn within(folder: &str, titles: &[PageTitle]) -> Vec<PageTitle> {
    titles.iter().filter(|t| holds(folder, &t.key)).cloned().collect()
}

/// What a folder holds, from what `/pub/titles` said (`None` for no
/// answer) and, when that has nothing in the folder, its `dir-index`. A
/// published folder is in `/pub/titles`; a granted one only in its index.
/// Gone takes an answer from one of them: a silent index after a silent
/// list is no answer at all.
pub fn found(folder: &str, titles: Option<&[PageTitle]>, dir: impl FnOnce() -> DirIndex) -> Found {
    let public = titles.map(|t| within(folder, t));
    if let Some(p) = &public {
        if !p.is_empty() {
            return Found::Pages(p.clone());
        }
    }
    match dir() {
        DirIndex::Got(t) => {
            let p = within(folder, &t);
            if p.is_empty() { Found::Gone } else { Found::Pages(p) }
        }
        DirIndex::Refused => Found::Gone,
        DirIndex::Silent if public.is_some() => Found::Gone,
        DirIndex::Silent => Found::Silent,
    }
}

/// Check `folder` of `ship` now, as `found` reads it.
pub fn check(reads: &dyn Reads, ship: &str, folder: &str) -> Found {
    let titles = reads.titles(ship, BUDGET);
    found(folder, titles.as_deref(), || reads.dir_index(ship, folder, BUDGET))
}

impl Follow {
    pub fn new(ship: &str, folder: &str) -> Follow {
        Follow {
            ship: ship.into(),
            folder: folder.into(),
            latest: BTreeMap::new(),
            seen: BTreeMap::new(),
            status: Status::Ok,
            checked: 0,
            primed: false,
        }
    }

    /// The pages new since they were last read here.
    pub fn new_keys(&self) -> Vec<&str> {
        self.latest
            .iter()
            .filter(|(k, l)| self.seen.get(*k).is_none_or(|s| l.secs > *s))
            .map(|(k, _)| k.as_str())
            .collect()
    }

    pub fn new_count(&self) -> usize {
        self.new_keys().len()
    }

    /// Take in what a check found at `now` (unix seconds). The first pages
    /// found count as seen; seen keeps only pages still there. Gone keeps
    /// the last pages, so the follow still lists them.
    pub fn merge(&mut self, found: &Found, now: u64) {
        match found {
            Found::Pages(pages) => {
                self.latest = pages
                    .iter()
                    .map(|t| (t.key.clone(), Latest { secs: t.secs, title: t.title.clone() }))
                    .collect();
                if !self.primed {
                    self.seen = self.latest.iter().map(|(k, l)| (k.clone(), l.secs)).collect();
                    self.primed = true;
                }
                let latest = &self.latest;
                self.seen.retain(|k, _| latest.contains_key(k));
                self.status = Status::Ok;
                self.checked = now;
            }
            Found::Gone => {
                self.status = Status::Unavailable;
                self.checked = now;
            }
            Found::Silent => {}
        }
    }

    /// The page `key` was read: it is not new until it changes again.
    pub fn saw(&mut self, key: &str) -> bool {
        match self.latest.get(key) {
            Some(l) if self.seen.get(key) != Some(&l.secs) => {
                self.seen.insert(key.into(), l.secs);
                true
            }
            _ => false,
        }
    }
}

type Hook = Box<dyn Fn(&NewPages) + Send + Sync>;

pub struct Follows {
    file: PathBuf,
    /// one writer at a time: a check and a click finishing together must
    /// not lose either
    lock: Mutex<()>,
    /// told when a check finds more new pages than there were
    hook: Option<Hook>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl Follows {
    pub fn open(dir: &Path) -> Follows {
        Follows { file: dir.join("follows.json"), lock: Mutex::new(()), hook: None }
    }

    /// The same, telling `hook` when a check finds more new pages.
    pub fn with_hook(dir: &Path, hook: impl Fn(&NewPages) + Send + Sync + 'static) -> Follows {
        Follows { hook: Some(Box::new(hook)), ..Follows::open(dir) }
    }

    /// In the order followed. A missing or unreadable file is none.
    pub fn list(&self) -> Vec<Follow> {
        std::fs::read(&self.file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn get(&self, ship: &str, folder: &str) -> Option<Follow> {
        self.list().into_iter().find(|f| f.ship == ship && f.folder == folder)
    }

    /// Follow `folder` of `ship`, taking in what was just found of it. A
    /// folder already followed stays as it is.
    pub fn follow(&self, ship: &str, folder: &str, found: &Found) -> Result<(), String> {
        self.change(|all| {
            if all.iter().any(|f| f.ship == ship && f.folder == folder) || all.len() >= MAX {
                return;
            }
            let mut f = Follow::new(ship, folder);
            f.merge(found, now_secs());
            all.push(f);
        })
    }

    pub fn unfollow(&self, ship: &str, folder: &str) -> Result<(), String> {
        self.change(|all| all.retain(|f| !(f.ship == ship && f.folder == folder)))
    }

    /// Take in a check of `folder` of `ship`, telling the hook when it
    /// found more new pages than there were.
    pub fn found(&self, ship: &str, folder: &str, found: &Found) -> Result<(), String> {
        self.found_at(ship, folder, found, now_secs())
    }

    fn found_at(&self, ship: &str, folder: &str, found: &Found, now: u64) -> Result<(), String> {
        let mut grew = None;
        self.change(|all| {
            if let Some(f) = all.iter_mut().find(|f| f.ship == ship && f.folder == folder) {
                let before = f.new_count();
                f.merge(found, now);
                let after = f.new_count();
                if after > before {
                    grew = Some(NewPages { ship: ship.into(), folder: folder.into(), new: after });
                }
            }
        })?;
        if let (Some(n), Some(hook)) = (grew, &self.hook) {
            hook(&n);
        }
        Ok(())
    }

    /// The page `key` of `ship` was read: each follow holding it has seen
    /// it. Writes only when that changes something.
    pub fn saw(&self, ship: &str, key: &str) -> Result<(), String> {
        let any = self.list().iter().any(|f| f.ship == ship && f.latest.contains_key(key));
        if !any {
            return Ok(());
        }
        self.change(|all| {
            for f in all.iter_mut().filter(|f| f.ship == ship) {
                f.saw(key);
            }
        })
    }

    /// The follows due a check at `now`: each not yet tried this launch,
    /// then each whose last answer is `EVERY` old. `tried` is when each was
    /// last tried this launch, so one that does not answer waits `RETRY`.
    pub fn due(&self, now: u64, tried: &std::collections::HashMap<(String, String), u64>) -> Vec<(String, String)> {
        self.list()
            .into_iter()
            .filter(|f| match tried.get(&(f.ship.clone(), f.folder.clone())) {
                None => true,
                Some(t) => f.checked + EVERY.as_secs() <= now && t + RETRY.as_secs() <= now,
            })
            .map(|f| (f.ship, f.folder))
            .collect()
    }

    fn change(&self, f: impl FnOnce(&mut Vec<Follow>)) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let mut all = self.list();
        f(&mut all);
        self.write(&all)
    }

    /// Whole or not at all, and private: write_private's temp file beside
    /// it, then a rename, in a folder made 0700 as the engine makes it.
    fn write(&self, all: &[Follow]) -> Result<(), String> {
        let body = serde_json::to_vec(all).map_err(|e| format!("follows: {e}"))?;
        crate::session::write_private(&self.file, &body).map_err(|e| format!("follows: {e}"))
    }
}

/// Check every follow that is due, on launch and then each minute, for as
/// long as the app runs.
pub fn watch(reads: Box<dyn Reads>, follows: std::sync::Arc<Follows>) {
    let spawned = std::thread::Builder::new().name("follows".into()).spawn(move || {
        let mut tried = std::collections::HashMap::new();
        loop {
            for (ship, folder) in follows.due(now_secs(), &tried) {
                let got = check(reads.as_ref(), &ship, &folder);
                tried.insert((ship.clone(), folder.clone()), now_secs());
                if let Err(e) = follows.found(&ship, &folder, &got) {
                    crate::commands::dlog(&format!("follows: {e}"));
                }
            }
            std::thread::sleep(Duration::from_secs(60));
        }
    });
    if let Err(e) = spawned {
        crate::commands::dlog(&format!("follows: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn t(key: &str, secs: i64) -> PageTitle {
        PageTitle { key: key.into(), secs, title: format!("T{key}") }
    }

    fn fresh(name: &str) -> (PathBuf, Follows) {
        let d = std::env::temp_dir().join(format!("follows-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let f = Follows::open(&d);
        (d, f)
    }

    #[test]
    fn what_is_there_at_first_follow_is_seen() {
        let mut f = Follow::new("~zod", "/docs");
        f.merge(&Found::Pages(vec![t("/docs/a", 1), t("/docs/b", 2)]), 10);
        assert_eq!(f.new_count(), 0);
        assert!(f.primed && f.checked == 10 && f.status == Status::Ok);
    }

    #[test]
    fn a_changed_or_added_page_is_new_until_read() {
        let mut f = Follow::new("~zod", "/docs");
        f.merge(&Found::Pages(vec![t("/docs/a", 1), t("/docs/b", 2)]), 10);
        f.merge(&Found::Pages(vec![t("/docs/a", 5), t("/docs/b", 2), t("/docs/sub/c", 3)]), 20);
        assert_eq!(f.new_keys(), ["/docs/a", "/docs/sub/c"]);
        assert!(f.saw("/docs/a"));
        assert!(!f.saw("/docs/a"), "once");
        assert!(!f.saw("/docs/none"));
        assert_eq!(f.new_keys(), ["/docs/sub/c"]);
        // an older time than seen is not new
        f.merge(&Found::Pages(vec![t("/docs/a", 4), t("/docs/sub/c", 3)]), 30);
        assert_eq!(f.new_keys(), ["/docs/sub/c"]);
        assert!(!f.seen.contains_key("/docs/b"), "seen keeps only what is there");
    }

    #[test]
    fn gone_is_unavailable_and_silent_changes_nothing() {
        let mut f = Follow::new("~zod", "/docs");
        f.merge(&Found::Pages(vec![t("/docs/a", 1)]), 10);
        let before = f.clone();
        f.merge(&Found::Silent, 20);
        assert_eq!(f, before);
        f.merge(&Found::Gone, 30);
        assert_eq!((f.status, f.checked), (Status::Unavailable, 30));
        assert_eq!(f.latest, before.latest, "still listed");
        f.merge(&Found::Pages(vec![t("/docs/a", 1)]), 40);
        assert_eq!(f.status, Status::Ok);
    }

    #[test]
    fn a_follow_with_no_answer_yet_primes_on_its_first() {
        let mut f = Follow::new("~zod", "/docs");
        f.merge(&Found::Silent, 10);
        f.merge(&Found::Gone, 11);
        assert!(!f.primed);
        f.merge(&Found::Pages(vec![t("/docs/a", 1)]), 12);
        assert_eq!(f.new_count(), 0);
    }

    #[test]
    fn found_reads_the_titles_then_the_index() {
        let titles = [t("/docs/a", 1), t("/docs2/x", 2), t("/other/b", 3), t("/docs", 4)];
        let idx = || DirIndex::Got(vec![t("/priv/p", 9)]);
        assert_eq!(found("/docs", Some(&titles), || panic!("not asked")), Found::Pages(vec![t("/docs/a", 1)]));
        assert_eq!(found("/priv", Some(&titles), idx), Found::Pages(vec![t("/priv/p", 9)]));
        assert_eq!(found("/priv", None, idx), Found::Pages(vec![t("/priv/p", 9)]));
        assert_eq!(found("/gone", Some(&titles), || DirIndex::Silent), Found::Gone);
        assert_eq!(found("/gone", Some(&titles), || DirIndex::Refused), Found::Gone);
        assert_eq!(found("/gone", None, || DirIndex::Refused), Found::Gone);
        assert_eq!(found("/gone", None, || DirIndex::Silent), Found::Silent);
        assert_eq!(found("/gone", None, || DirIndex::Got(vec![t("/else/x", 1)])), Found::Gone);
    }

    #[test]
    fn follows_round_trip_through_the_file() {
        let (d, fs) = fresh("trip");
        fs.follow("~zod", "/docs", &Found::Pages(vec![t("/docs/a", 1)])).unwrap();
        fs.follow("~zod", "/docs", &Found::Pages(vec![t("/docs/b", 1)])).unwrap();
        fs.follow("~nec", "/x", &Found::Silent).unwrap();
        let again = Follows::open(&d).list();
        assert_eq!(again, fs.list());
        assert_eq!(again.len(), 2, "followed once");
        assert_eq!(again[0].latest["/docs/a"], Latest { secs: 1, title: "T/docs/a".into() });
        assert!(!again[1].primed);
        fs.unfollow("~zod", "/docs").unwrap();
        assert_eq!(fs.list().iter().map(|f| f.ship.as_str()).collect::<Vec<_>>(), ["~nec"]);
        std::fs::write(d.join("follows.json"), b"{not json").unwrap();
        assert!(fs.list().is_empty());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn the_hook_hears_only_more_new_pages() {
        let d = std::env::temp_dir().join(format!("follows-hook-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let heard = Arc::new(Mutex::new(Vec::new()));
        let h = heard.clone();
        let fs = Follows::with_hook(&d, move |n| h.lock().unwrap().push(n.clone()));
        fs.follow("~zod", "/docs", &Found::Pages(vec![t("/docs/a", 1)])).unwrap();
        fs.found_at("~zod", "/docs", &Found::Pages(vec![t("/docs/a", 1)]), 5).unwrap();
        fs.found_at("~zod", "/docs", &Found::Pages(vec![t("/docs/a", 2)]), 6).unwrap();
        fs.found_at("~zod", "/docs", &Found::Pages(vec![t("/docs/a", 3)]), 7).unwrap();
        fs.found_at("~zod", "/docs", &Found::Pages(vec![t("/docs/a", 3), t("/docs/b", 1)]), 8).unwrap();
        let got = heard.lock().unwrap().clone();
        assert_eq!(got, [
            NewPages { ship: "~zod".into(), folder: "/docs".into(), new: 1 },
            NewPages { ship: "~zod".into(), folder: "/docs".into(), new: 2 },
        ]);
        fs.saw("~zod", "/docs/a").unwrap();
        assert_eq!(fs.get("~zod", "/docs").unwrap().new_keys(), ["/docs/b"]);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn due_waits_every_and_retries_sooner() {
        let (d, fs) = fresh("due");
        fs.follow("~zod", "/docs", &Found::Silent).unwrap();
        let mut tried = std::collections::HashMap::new();
        assert_eq!(fs.due(1_000_000, &tried).len(), 1, "not tried this launch");
        tried.insert(("~zod".to_string(), "/docs".to_string()), 1_000_000);
        assert!(fs.due(1_000_000 + 60, &tried).is_empty());
        assert_eq!(fs.due(1_000_000 + RETRY.as_secs(), &tried).len(), 1);
        fs.found_at("~zod", "/docs", &Found::Pages(vec![t("/docs/a", 1)]), 2_000_000).unwrap();
        assert!(fs.due(2_000_000 + EVERY.as_secs() - 1, &tried).is_empty());
        assert_eq!(fs.due(2_000_000 + EVERY.as_secs(), &tried).len(), 1);
        assert_eq!(fs.due(0, &Default::default()).len(), 1, "launch checks each");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn holds_is_by_whole_names() {
        assert!(holds("/docs", "/docs/a") && holds("/docs", "/docs/s/b"));
        assert!(!holds("/docs", "/docs") && !holds("/docs", "/docs2/a") && !holds("/a/b", "/a/c"));
        assert_eq!(folder_key(&rel("/a/b/")), "/a/b");
    }
}
