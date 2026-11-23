//! The ships signed in on this computer. One file, `accounts.json`, beside
//! the app's others and readable by its owner alone, holds each ship's
//! address and session, and which of them is in front. A ship's access code
//! is never kept, only the session it gave.
//!
//! Before there were several, the one session was `session.json`. It is
//! read once into this file and then removed, so nobody is signed out by
//! the change.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// One ship signed in.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub struct Account {
    /// The ship's address, with no slash at its end. It is what tells one account from another.
    pub url: String,
    /// The session cookie, `urbauth-~ship=...`. Sent to `url` and nowhere else.
    pub cookie: String,
    /// When it was first signed in and when it was last in front, in seconds since 1970.
    #[serde(default)]
    pub added: u64,
    #[serde(default)]
    pub used: u64,
    /// What the owner calls it, and the colour given it, when they gave any.
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub colour: String,
    /// The ship no longer takes this session: its code is wanted again. Everything else about it is kept.
    #[serde(default)]
    pub expired: bool,
}

impl Account {
    /// The ship's name, which a session cookie carries.
    pub fn ship(&self) -> &str {
        self.cookie.split('=').next().and_then(|n| n.strip_prefix("urbauth-")).unwrap_or("ship")
    }

    /// What to call it in a list: the owner's label, or the ship's name.
    pub fn name(&self) -> &str {
        if self.label.trim().is_empty() { self.ship() } else { self.label.trim() }
    }
}

/// Every ship signed in, in the order they were added, and the one in front.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub struct Accounts {
    #[serde(default)]
    pub list: Vec<Account>,
    /// The address of the ship in front. None with no ship signed in, or after the last was signed out.
    #[serde(default)]
    pub front: Option<String>,
}

/// An address as accounts are told apart by: trimmed, with no slash at its end.
fn plain(url: &str) -> &str {
    url.trim().trim_end_matches('/')
}

impl Accounts {
    /// What the file holds. A file that cannot be read as one holds nothing, which is said nowhere:
    /// the worst of it is a sign-in asked for again.
    pub fn parse(text: &str) -> Accounts {
        let mut a: Accounts = serde_json::from_str(text).unwrap_or_default();
        // a session whose name is no ship's is not one: the name goes on to name files and a folder to mount at
        a.list.retain(|x| !x.url.is_empty() && crate::api::cookie_ship(&x.cookie).is_some());
        if a.front.as_deref().is_some_and(|f| a.get(f).is_none()) {
            a.front = None;
        }
        a
    }

    /// The one session of before, as the account it becomes.
    pub fn from_session(session: &str, now: u64) -> Option<Account> {
        let v: serde_json::Value = serde_json::from_str(session).ok()?;
        let (url, cookie) = (plain(v["url"].as_str()?), v["cookie"].as_str()?.trim());
        (!url.is_empty() && crate::api::cookie_ship(cookie).is_some()).then(|| Account { url: url.to_owned(), cookie: cookie.to_owned(), added: now, used: now, ..Account::default() })
    }

    pub fn get(&self, url: &str) -> Option<&Account> {
        self.list.iter().find(|a| a.url == plain(url))
    }

    /// The ship in front.
    pub fn front(&self) -> Option<&Account> {
        self.get(self.front.as_deref()?)
    }

    /// A ship signed in, or signed in again: its session is kept, it is no longer expired, and it
    /// comes to the front. A ship already here keeps its place, its label and its colour.
    pub fn put(&mut self, url: &str, cookie: &str, now: u64) {
        let url = plain(url).to_owned();
        match self.list.iter_mut().find(|a| a.url == url) {
            Some(a) => (a.cookie, a.expired, a.used) = (cookie.trim().to_owned(), false, now),
            None => self.list.push(Account { url: url.clone(), cookie: cookie.trim().to_owned(), added: now, used: now, ..Account::default() }),
        }
        self.front = Some(url);
    }

    /// Brings a ship to the front. False when it is not signed in here.
    pub fn bring(&mut self, url: &str, now: u64) -> bool {
        let url = plain(url).to_owned();
        let Some(a) = self.list.iter_mut().find(|a| a.url == url) else { return false };
        a.used = now;
        self.front = Some(url);
        true
    }

    /// Signs a ship out: its session is let go. When it was in front, the ship used most lately
    /// of those left comes to the front, and with none left there is none.
    pub fn remove(&mut self, url: &str) -> Option<Account> {
        let at = self.list.iter().position(|a| a.url == plain(url))?;
        let gone = self.list.remove(at);
        if self.front.as_deref() == Some(gone.url.as_str()) {
            self.front = self.list.iter().filter(|a| !a.expired).max_by_key(|a| a.used).map(|a| a.url.clone());
        }
        Some(gone)
    }

    /// What the owner calls a ship and the colour they give it. Either left empty is none.
    pub fn dress(&mut self, url: &str, label: &str, colour: &str) -> bool {
        let Some(a) = self.list.iter_mut().find(|a| a.url == plain(url)) else { return false };
        (a.label, a.colour) = (label.trim().chars().take(40).collect(), colour.trim().to_owned());
        true
    }

    /// Marks a session the ship turned away. The account stays, to be signed in again.
    pub fn expire(&mut self, url: &str) {
        if let Some(a) = self.list.iter_mut().find(|a| a.url == plain(url)) {
            a.expired = true;
        }
    }
}

/// Process and advisory file lock guarding read-modify-write updates to `accounts.json`.
#[cfg(not(target_arch = "wasm32"))]
fn accounts_lock(dir: &Path) -> (std::sync::MutexGuard<'static, ()>, Option<std::fs::File>) {
    static HERE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let here = HERE.lock().unwrap_or_else(|e| e.into_inner());
    let lock = crate::api::file_lock(&dir.join("accounts.lock"));
    (here, lock)
}

fn load_at_unlocked(dir: &Path, now: u64) -> Accounts {
    let file = dir.join("accounts.json");
    if let Ok(text) = std::fs::read_to_string(&file) {
        return Accounts::parse(&text);
    }
    let old = dir.join("session.json");
    let Some(first) = std::fs::read_to_string(&old).ok().and_then(|t| Accounts::from_session(&t, now)) else { return Accounts::default() };
    let all = Accounts { front: Some(first.url.clone()), list: vec![first] };
    if store_at(dir, &all).is_ok() {
        let _ = std::fs::remove_file(old);
    }
    all
}

/// The accounts kept in `dir`. With no accounts file yet, the one session of before is taken in:
/// it becomes the first account and the front, the new file is written, and only then is the old
/// one removed.
pub fn load_at(dir: &Path, now: u64) -> Accounts {
    let file = dir.join("accounts.json");
    if let Ok(text) = std::fs::read_to_string(&file) {
        return Accounts::parse(&text);
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _held = accounts_lock(dir);
    load_at_unlocked(dir, now)
}

/// Loads `accounts.json`, applies `change`, and writes it back if modified, under a process mutex
/// and advisory file lock so concurrent updates never clobber one another.
#[cfg(not(target_arch = "wasm32"))]
pub fn update_at<T>(dir: &Path, now: u64, change: impl FnOnce(&mut Accounts) -> (bool, T)) -> Result<T, String> {
    let _held = accounts_lock(dir);
    let mut all = load_at_unlocked(dir, now);
    let (dirty, out) = change(&mut all);
    if dirty {
        store_at(dir, &all)?;
    }
    Ok(out)
}

/// Keeps the accounts, in a file only its owner reads, written whole or not at all.
pub fn store_at(dir: &Path, all: &Accounts) -> Result<(), String> {
    crate::api::write_private(&dir.join("accounts.json"), &serde_json::to_vec_pretty(all).map_err(|e| e.to_string())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("lr-accounts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ships_are_signed_in_brought_forward_and_signed_out() {
        let mut a = Accounts::default();
        assert!(a.front().is_none());
        a.put("https://zod.test/", "urbauth-~zod=0v1", 10);
        a.put("https://bus.test", "urbauth-~bus=0v2", 20);
        assert_eq!(a.list.iter().map(Account::ship).collect::<Vec<_>>(), ["~zod", "~bus"], "in the order they were added");
        assert_eq!(a.front().map(Account::ship), Some("~bus"), "the ship just signed in is in front");
        // a ship is one account whatever slash its address was typed with
        assert_eq!(a.get("https://zod.test").map(|x| x.url.as_str()), Some("https://zod.test"));
        assert!(a.bring("https://zod.test/", 30) && !a.bring("https://nec.test", 31));
        assert_eq!(a.front().map(|x| (x.ship(), x.used)), Some(("~zod", 30)));
        // signed in again: the new session, the same place, the label kept
        a.list[0].label = "home".into();
        a.expire("https://zod.test");
        assert!(a.list[0].expired);
        a.put("https://zod.test", "urbauth-~zod=0v9", 40);
        assert_eq!((a.list.len(), a.list[0].cookie.as_str(), a.list[0].expired, a.list[0].name(), a.list[0].added), (2, "urbauth-~zod=0v9", false, "home", 10));
        // signing out of the ship in front brings the one used most lately forward
        assert_eq!(a.remove("https://zod.test").map(|x| x.cookie), Some("urbauth-~zod=0v9".into()));
        assert_eq!(a.front().map(Account::ship), Some("~bus"));
        a.remove("https://bus.test");
        assert!(a.front().is_none() && a.list.is_empty());
        assert!(a.remove("https://bus.test").is_none());
    }

    #[test]
    fn signing_out_of_a_ship_not_in_front_leaves_the_front_alone_and_an_expired_one_is_not_brought_forward() {
        let mut a = Accounts::default();
        a.put("https://zod.test", "urbauth-~zod=0v1", 10);
        a.put("https://bus.test", "urbauth-~bus=0v2", 20);
        a.put("https://nec.test", "urbauth-~nec=0v3", 30);
        a.remove("https://zod.test");
        assert_eq!(a.front().map(Account::ship), Some("~nec"));
        a.put("https://zod.test", "urbauth-~zod=0v1", 40);
        a.bring("https://nec.test", 50);
        a.expire("https://zod.test");
        a.remove("https://nec.test");
        assert_eq!(a.front().map(Account::ship), Some("~bus"), "the ship whose session ended is passed over");
    }

    #[test]
    fn a_ship_is_given_a_label_and_a_colour_and_they_are_taken_off_again() {
        let mut a = Accounts::default();
        a.put("https://zod.test", "urbauth-~zod=0v1", 1);
        assert!(a.dress("https://zod.test/", "  home  ", "#4A7C59") && !a.dress("https://nec.test", "x", ""));
        assert_eq!((a.list[0].name(), a.list[0].colour.as_str()), ("home", "#4A7C59"));
        a.dress("https://zod.test", "", "");
        assert_eq!((a.list[0].name(), a.list[0].colour.as_str()), ("~zod", ""), "with no label it goes by its name");
    }

    #[test]
    fn a_file_that_is_not_one_holds_nothing_and_a_bad_entry_is_left_out() {
        assert_eq!(Accounts::parse("not json"), Accounts::default());
        let a = Accounts::parse(r#"{"list":[{"url":"https://zod.test","cookie":"urbauth-~zod=0v1"},{"url":"","cookie":"urbauth-~bus=0v2"},{"url":"https://nec.test","cookie":"nothing"}],"front":"https://nec.test"}"#);
        assert_eq!(a.list.len(), 1);
        assert!(a.front.is_none(), "a front that names no account is none");
    }

    #[test]
    fn the_one_session_of_before_becomes_the_first_account_and_is_then_removed() {
        let d = temp("move");
        std::fs::write(d.join("session.json"), r#"{"url":"https://zod.test/","cookie":"urbauth-~zod=0v1"}"#).unwrap();
        let a = load_at(&d, 7);
        assert_eq!(a.front().map(|x| (x.url.as_str(), x.ship(), x.added)), Some(("https://zod.test", "~zod", 7)));
        assert!(d.join("accounts.json").exists() && !d.join("session.json").exists());
        // read again, it is what was written
        assert_eq!(load_at(&d, 99), a);
        // with neither file there is nobody
        let empty = temp("none");
        assert_eq!(load_at(&empty, 1), Accounts::default());
        assert!(!empty.join("accounts.json").exists(), "and nothing is written for nobody");
        for dir in [d, empty] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_its_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let d = temp("mode");
        let mut a = Accounts::default();
        a.put("https://zod.test", "urbauth-~zod=0v1", 1);
        store_at(&d, &a).unwrap();
        assert_eq!(std::fs::metadata(d.join("accounts.json")).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn concurrent_updates_do_not_lose_accounts() {
        let d = temp("concurrent");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let dir = d.clone();
                std::thread::spawn(move || {
                    let ship = format!("~ship-{}", (b'a' + i) as char);
                    let url = format!("https://s{i}.test");
                    let cookie = format!("urbauth-{ship}=0v{i}");
                    update_at(&dir, 100 + u64::from(i), |all| {
                        all.put(&url, &cookie, 100 + u64::from(i));
                        (true, ())
                    })
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let all = load_at(&d, 200);
        assert_eq!(all.list.len(), 8, "all 8 concurrent updates must be preserved");
        for i in 0..8 {
            assert!(all.get(&format!("https://s{i}.test")).is_some());
        }
        let _ = std::fs::remove_dir_all(d);
    }
}
