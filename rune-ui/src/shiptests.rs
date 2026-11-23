//! Saving and syncing, run against a stand-in ship on this computer.
//!
//! The stand-in answers the few routes these tests use, and answers a save as
//! `code/nex/lattice/app.hoon` does (`+handle-page-save`, `+link-write`,
//! `+move-guard`): a claimed base that is not the page's revision is refused
//! with `cas` and applied with the old text kept aside without it, a link
//! shared to read is a 403, a link whose host does not answer is a 504, and a
//! page that moved away is not written again at its old name.
//!
//! Every test here holds one lock. Rune runs each `Latest` on four workers the
//! whole process shares, and the senders of waiting saves hold one lock, so two
//! of these side by side would change the order of each other's answers.

use super::*;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

static ONE: Mutex<()> = Mutex::new(());

fn one() -> MutexGuard<'static, ()> {
    ONE.lock().unwrap_or_else(|e| e.into_inner())
}

/// A save as the stand-in was sent it.
#[derive(Clone, Debug)]
struct Save {
    name: String,
    base: Option<String>,
    body: String,
}

#[derive(Default)]
struct Stub {
    /// Each page's text, kind and revision.
    pages: BTreeMap<String, (String, String, u64)>,
    /// Each link's mode (`read` or `edit`), text and revision.
    links: BTreeMap<String, (String, String, u64)>,
    knows: BTreeMap<String, String>,
    /// Where each page that was moved went.
    moved: BTreeMap<String, String>,
    saves: Vec<Save>,
    /// Seconds a save of a page takes to be answered.
    slow: f64,
    /// Seconds a read of the tree takes, and whether the tree is read before that wait or after it.
    dump_slow: f64,
    dump_early: bool,
    /// Seconds a read of an address takes.
    urb_slow: f64,
    /// A status every save and every read of the tree is answered with, as when nothing reaches the ship.
    fail: u16,
    /// A status every save of a page is answered with, the ship answering all else.
    save_fail: u16,
    /// A status a save through a link is answered with, as when the link's host is away.
    link_fail: u16,
    /// A status a save of a memory is answered with.
    know_fail: u16,
    /// A status every delete and move is answered with, the ship answering all else.
    op_fail: u16,
    /// Names whose page a page-only delete took, with pages left under them (`page-gone` on the ship).
    gone: Vec<String>,
    /// The access list: each group's ships, peek lines and make lines, as the ship keeps them.
    groups: BTreeMap<String, (Vec<String>, Vec<String>, Vec<String>)>,
    /// Whether the ship speaks the save protocol where a save's list is authoritative (`"v": 2`).
    groups_v2: bool,
    /// A status a read of one page is answered with (`page-source`).
    source_fail: u16,
    /// The last body a group was saved with.
    group_saves: Vec<serde_json::Value>,
}

struct Ship {
    st: Arc<Mutex<Stub>>,
    port: u16,
}

fn unpct(s: &str) -> String {
    let b = s.as_bytes();
    let (mut out, mut i) = (Vec::new(), 0);
    while i < b.len() {
        match (b[i], s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(x)) => {
                out.push(x);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn wait(secs: f64) {
    if secs > 0.0 {
        std::thread::sleep(Duration::from_secs_f64(secs));
    }
}

/// One request answered: the status and the text.
fn answer(st: &Mutex<Stub>, method: &str, route: &str, q: &BTreeMap<String, String>, body: String) -> (u16, String) {
    use serde_json::json;
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let lock = || st.lock().unwrap_or_else(|e| e.into_inner());
    let missing = (404, json!({"error": "not in the stub"}).to_string());
    let ok = (200, json!({"ok": true}).to_string());
    match (method, route) {
        ("GET", "page-dump") => {
            let (fail, slow, early) = {
                let s = lock();
                (s.fail, s.dump_slow, s.dump_early)
            };
            if fail > 0 {
                return (fail, "bad gateway".into());
            }
            let read = || {
                let s = lock();
                let mut nodes: Vec<serde_json::Value> = s.pages.iter().map(|(n, v)| json!({"path": n, "page": true, "kind": v.1, "rev": v.2, "body": v.0})).collect();
                // a link is in the tree with no text, as the ship sends one
                nodes.extend(s.links.iter().map(|(n, l)| json!({"path": n, "page": true, "kind": "md", "rev": l.2, "link": {"host": "~sampel-palnet", "path": format!("/{n}"), "mode": l.0}})));
                json!({"nodes": nodes, "since": "s1"}).to_string()
            };
            if early {
                let text = read();
                wait(slow);
                (200, text)
            } else {
                wait(slow);
                (200, read())
            }
        }
        ("GET", "page-source") => {
            let s = lock();
            if s.source_fail > 0 {
                return (s.source_fail, "bad gateway".into());
            }
            match (s.links.get(&get("name")), s.pages.get(&get("name"))) {
                (Some(l), _) => (200, json!({"body": l.1, "kind": "md", "rev": l.2}).to_string()),
                (_, Some(v)) => (200, json!({"body": v.0, "kind": v.1, "rev": v.2}).to_string()),
                _ => (404, json!({"error": "no such page"}).to_string()),
            }
        }
        ("GET", "share-groups") => {
            let s = lock();
            let list: Vec<serde_json::Value> = s.groups.iter().map(|(n, g)| json!({"name": n, "ships": g.0, "peek": g.1, "make": g.2})).collect();
            (200, if s.groups_v2 { json!({"v": 2, "groups": list}) } else { json!(list) }.to_string())
        }
        ("POST", "share-group-save") => {
            let mut s = lock();
            let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            s.group_saves.push(v.clone());
            let lines = |k: &str| v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect::<Vec<_>>()).unwrap_or_default();
            let (ships, peek, make) = (lines("ships"), lines("peek"), lines("make"));
            let old = s.groups.get(&get("name")).cloned().unwrap_or_default();
            // a save marked `v: 2` is the whole list. Without it a folder is kept whose lines are both left out (`+share-group-save`)
            let (peek, make) = if v["v"] == 2 {
                (peek, make)
            } else {
                let keep = |old: &[String], new: Vec<String>| {
                    let mut out = new.clone();
                    for line in old {
                        let folder = old.contains(&format!("{line}/dir-index"));
                        if folder && !new.contains(line) && !new.contains(&format!("{line}/dir-index")) {
                            out.push(line.clone());
                            out.push(format!("{line}/dir-index"));
                        }
                    }
                    out
                };
                (keep(&old.1, peek), keep(&old.2, make))
            };
            s.groups.insert(get("name"), (ships, peek, make));
            ok
        }
        ("GET", "know-all") => {
            let s = lock();
            (200, json!({"items": s.knows.iter().map(|(k, v)| json!({"key": k, "body": v})).collect::<Vec<_>>()}).to_string())
        }
        ("GET", "urb-read") => {
            let slow = lock().urb_slow;
            wait(slow);
            (200, json!({"kind": "page", "ship": "~sampel-palnet", "path": "/notes/plan", "mode": "md", "body": "# The plan\n", "comments": []}).to_string())
        }
        ("POST", "know-save") => {
            let mut s = lock();
            if s.know_fail > 0 {
                return (s.know_fail, "bad gateway".into());
            }
            s.knows.insert(get("key"), body);
            ok
        }
        ("POST", "page-move") | ("POST", "page-del") => {
            let mut s = lock();
            if s.op_fail > 0 {
                return (s.op_fail, "the ship says no".into());
            }
            let at = get(if route == "page-del" { "name" } else { "from" });
            let mut hit: Vec<String> = s.pages.keys().filter(|n| is_under(n, &at)).cloned().collect();
            if route == "page-del" {
                // `tree` is 1 or true for yes, absent, 0 or false for no, and a 400 for anything else (`arg-flag`)
                let tree = match q.get("tree").map(String::as_str) {
                    None | Some("0") | Some("false") => false,
                    Some("1") | Some("true") => true,
                    Some(_) => return (400, "tree: 1 or 0".into()),
                };
                if !tree {
                    // a repeat page-only delete of a name whose page is gone, with pages still under it, is refused (`+page-del-run`)
                    if !s.pages.contains_key(&at) && s.gone.contains(&at) && !hit.is_empty() {
                        return (409, format!("{at} is a folder: its page was deleted on its own, and the pages under it stay. tree=1 deletes them too"));
                    }
                    // a page is deleted alone and what is under it stays. A name with no page is a folder, and all of it goes
                    if s.pages.contains_key(&at) {
                        if hit.len() > 1 {
                            s.gone.push(at.clone());
                        }
                        hit = vec![at.clone()];
                    }
                }
            }
            // a delete of nothing is answered as done, a move of nothing is refused
            if hit.is_empty() && route == "page-move" {
                return (404, json!({"error": "no such page or folder"}).to_string());
            }
            for n in hit {
                let v = s.pages.remove(&n).expect("just listed");
                if route == "page-move" {
                    // the ship makes the moved page anew: its revision there is not the one it had
                    let to = format!("{}{}", get("to"), &n[at.len()..]);
                    s.pages.insert(to.clone(), (v.0, v.1, 1));
                    s.moved.insert(n, to);
                }
            }
            ok
        }
        ("POST", "page-save") => {
            let name = get("name");
            let base = q.get("base").cloned();
            {
                let mut s = lock();
                s.saves.push(Save { name: name.clone(), base: base.clone(), body: body.clone() });
                if let Some(l) = s.links.get(&name).cloned() {
                    if l.0 == "read" {
                        return (403, "this page is shared with you read-only".into());
                    }
                    if s.link_fail > 0 {
                        return (s.link_fail, "~sampel-palnet is unreachable or no longer shares this page".into());
                    }
                    s.links.insert(name, (l.0, body, l.2 + 1));
                    return (200, json!({"ok": true, "rev": l.2 + 1, "conflicted": false, "kept": ""}).to_string());
                }
            }
            let slow = lock().slow;
            wait(slow);
            let mut s = lock();
            if s.fail > 0 {
                return (s.fail, "bad gateway".into());
            }
            if s.save_fail > 0 {
                return (s.save_fail, "the ship says no".into());
            }
            let old = s.pages.get(&name).cloned();
            let new = q.contains_key("new");
            if new && old.is_some() {
                return (409, "page exists".into());
            }
            if let (None, false, Some(to)) = (&old, new, s.moved.get(&name).filter(|to| s.pages.contains_key(*to))) {
                return (409, format!("{name} moved to {to}: save it there"));
            }
            let prev = old.as_ref().map_or(0, |o| o.2);
            // any base is a claim, 0 included, and a save that claims nothing sends none
            let stale = base.as_ref().is_some_and(|b| b.parse() != Ok(prev));
            let differs = old.as_ref().is_none_or(|o| o.0 != body);
            if q.contains_key("cas") && stale && differs {
                return (409, format!("stale: the page is at rev {prev}"));
            }
            let mut kept = String::new();
            if let Some(o) = old.as_ref().filter(|_| stale && differs) {
                kept = format!("conflicts/{}-rev{}", name.replace('/', "-"), o.2);
                s.pages.entry(kept.clone()).or_insert((o.0.clone(), o.1.clone(), 1));
            }
            s.pages.insert(name, (body, get("type"), prev + 1));
            (200, json!({"rev": prev + 1, "conflicted": !kept.is_empty(), "kept": kept}).to_string())
        }
        _ => missing,
    }
}

fn serve(st: &Mutex<Stub>, stream: std::net::TcpStream) -> Option<()> {
    let mut r = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next()?.to_owned(), parts.next()?.to_owned());
    let mut len = 0;
    loop {
        let mut h = String::new();
        r.read_line(&mut h).ok()?;
        if h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().ok()?;
            }
        }
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body).ok()?;
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let q: BTreeMap<String, String> = query.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').unwrap_or((p, ""))).map(|(k, v)| (unpct(k), unpct(v))).collect();
    let (code, text) = answer(st, &method, path.trim_start_matches("/apps/lattice/"), &q, String::from_utf8_lossy(&body).into_owned());
    let mut out = stream;
    out.write_all(format!("HTTP/1.1 {code} stub\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len()).as_bytes()).ok()
}

impl Ship {
    fn start() -> Ship {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port on this computer");
        let port = listener.local_addr().expect("its address").port();
        let st = Arc::new(Mutex::new(Stub::default()));
        st.lock().unwrap().knows.insert("/rune/fact".into(), "a fact as the ship has it\n".into());
        let theirs = st.clone();
        // it listens for as long as the test run lasts: nothing asks it anything once its test is over
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let st = theirs.clone();
                std::thread::spawn(move || serve(&st, stream));
            }
        });
        let ship = Ship { st, port };
        // what is kept for this address is kept in a folder of the test's own, which starts empty: an earlier run given the same port left nothing in it
        let dir = ship.dir();
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the test's own folder can be made");
        api::TEST_SHIP_DIRS.lock().unwrap_or_else(|e| e.into_inner()).insert(ship.conn().url, dir);
        ship
    }

    fn conn(&self) -> Conn {
        Conn { url: format!("http://127.0.0.1:{}", self.port), cookie: "urbauth-~zod=x".into() }
    }

    /// The folder what the window keeps for this ship is kept in.
    fn dir(&self) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("lattice-rune-ship-{}-{}", std::process::id(), self.port))
    }

    fn st(&self) -> MutexGuard<'_, Stub> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Writes a page as another window would: its revision goes up by one.
    fn write(&self, name: &str, kind: &str, body: &str) {
        let mut s = self.st();
        let rev = s.pages.get(name).map_or(1, |p| p.2 + 1);
        s.pages.insert(name.into(), (body.into(), kind.into(), rev));
    }

    fn link(&self, name: &str, mode: &str, body: &str) {
        self.st().links.insert(name.into(), (mode.into(), body.into(), 4));
    }

    fn body(&self, name: &str) -> String {
        self.st().pages.get(name).map_or_else(|| "<none>".into(), |p| p.0.clone())
    }

    fn saves(&self) -> Vec<Save> {
        self.st().saves.clone()
    }

    fn saves_of(&self, name: &str) -> Vec<Save> {
        self.saves().into_iter().filter(|s| s.name == name).collect()
    }
}

impl Drop for Ship {
    /// What the window kept for this address goes with it, folder and all. The address stays tied
    /// to the folder: a write the window set going a moment before (the kept tree is written off its
    /// thread) lands there, and not among the files every test reads. No other test is given the
    /// port, since the stand-in listens for as long as the run lasts.
    fn drop(&mut self) {
        let dir = self.dir();
        // a test that made it read-only gives it back first
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// A window on the stand-in ship, with its tree read.
struct Run {
    s: App,
    t0: Instant,
}

impl Run {
    fn new(ship: &Ship) -> Run {
        let mut s = init();
        let c = ship.conn();
        s.queue = c.queue();
        s.ops = c.ops();
        // this address's own preferences, as after a sign-in: the computer's are read by other tests, and are left as they are
        s.prefs = api::Prefs::load_for(&c.url, c.ship());
        s.conn = Some(c);
        // autosave looks only when a test asks it to
        s.next_auto = f64::INFINITY;
        load_tree(&mut s);
        let mut r = Run { s, t0: Instant::now() };
        r.until("the tree", |s| !s.names.is_empty() && !s.tree_req.is_pending());
        r
    }

    fn clock(&self) -> f64 {
        1000.0 + self.t0.elapsed().as_secs_f64()
    }

    /// One look, with someone at the window.
    fn tick(&mut self) {
        let c = self.clock();
        self.s.global.touched = true;
        poll(&mut self.s, c, &mut Tx::default());
    }

    fn until(&mut self, what: &str, f: impl Fn(&App) -> bool) {
        let t = Instant::now();
        loop {
            self.tick();
            if f(&self.s) {
                return;
            }
            assert!(t.elapsed() < Duration::from_secs(20), "timed out waiting for {what}. The note is {:?}", self.s.note);
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn secs(&mut self, n: f64) {
        let t = Instant::now();
        while t.elapsed().as_secs_f64() < n {
            self.tick();
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Looks until nothing is on its way to the ship or back.
    fn settle(&mut self) {
        self.until("every answer", |s| !s.save_req.is_pending() && !s.drain_req.is_pending() && !s.tree_req.is_pending() && !s.page_req.is_pending() && !s.op_req.is_pending());
        self.tick();
    }

    fn open(&mut self, name: &str) {
        open_page(&mut self.s, name);
        let n = name.to_owned();
        self.until("the page", move |s| !s.page_req.is_pending() && s.open.as_ref().is_some_and(|p| p.name == n));
        self.tick();
    }

    fn typ(&mut self, text: &str) {
        let at = self.s.edit.text.len();
        self.s.edit.set_caret(at);
        self.s.edit.insert(text);
    }

    /// Reads the tree again and waits for what that sets going.
    fn sync(&mut self) {
        load_tree(&mut self.s);
        self.tick();
        self.settle();
    }

    /// Lets autosave see the text as it is, twice, as when it has rested, and waits for the save it starts.
    fn autosave(&mut self) {
        for _ in 0..2 {
            self.s.next_auto = 0.0;
            self.tick();
        }
        self.s.next_auto = f64::INFINITY;
        self.until("the autosave", |s| !s.save_req.is_pending());
        self.tick();
    }
}

fn budget() -> String {
    SAMPLE.iter().find(|(n, _)| *n == "budget").expect("the sample sheet").1.to_owned()
}

fn rename(r: &mut Run, from: &str, to: &str) {
    r.s.prompt = Some(Prompt::Rename(from.to_owned(), TextEdit::new(to)));
    confirm(&mut r.s);
}

fn type_cell(r: &mut Run, text: &str) {
    pick_cell(&mut r.s, 1, 0);
    r.s.sheet.as_mut().expect("the sheet shows").entry.text = text.into();
    commit_cell(&mut r.s);
}

fn ctrl_e(r: &mut Run) {
    on_key(&mut r.s, &KeyEvent { key: Key::Command('e'), mods: Default::default() }, &mut Tx::default());
}

#[test]
fn edit_pressed_while_a_cell_is_being_saved_does_not_write_the_old_text_back() {
    let _one = one();
    let ship = Ship::start();
    ship.write("budget", "fods", &budget());
    let mut r = Run::new(&ship);
    r.open("budget");
    ship.st().slow = 0.5;
    type_cell(&mut r, "Oat milk");
    assert!(r.s.save_req.is_pending(), "the cell's save is on its way");
    // Ctrl+E, with nothing typed after it
    ctrl_e(&mut r);
    r.settle();
    // autosave has every chance to take the editor's text for a change
    r.autosave();
    r.autosave();
    assert!(ship.body("budget").contains("Oat milk"), "the cell was written over by an editor nobody typed in: {:?}", ship.saves().iter().map(|s| (s.base.clone(), s.body.contains("Oat milk"))).collect::<Vec<_>>());
    // once the save is answered the editor opens, on the page with the cell in it
    if !r.s.editing {
        ctrl_e(&mut r);
    }
    assert!(r.s.editing && r.s.edit.text.contains("Oat milk"), "the editor opens on the page as saved. The note is {:?}", r.s.note);
}

#[test]
fn edit_pressed_while_a_cell_is_being_saved_and_then_left_keeps_the_cell() {
    let _one = one();
    let ship = Ship::start();
    ship.write("budget", "fods", &budget());
    ship.write("other", "md", "other\n");
    let mut r = Run::new(&ship);
    r.open("budget");
    ship.st().slow = 0.5;
    type_cell(&mut r, "Oat milk");
    ctrl_e(&mut r);
    r.settle();
    open_page(&mut r.s, "other");
    r.settle();
    assert!(ship.body("budget").contains("Oat milk"), "leaving the editor sent the text from before the cell");
}

#[test]
fn closing_while_a_renamed_page_waits_for_its_revision_keeps_what_was_typed() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    let mut r = Run::new(&ship);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("typed and precious");
    // the read of the tree that follows the rename is slow to be answered
    ship.st().dump_slow = 3.0;
    rename(&mut r, "notes/a", "notes/b");
    r.until("the rename", |s| s.moved_wait.is_some());
    closing(&mut r.s);
    let kept = ship.conn().queue();
    let q = kept.get("notes/b").expect("what was typed waits under the page's new name");
    assert!(q.body.contains("precious"));
    assert_eq!((q.base, q.is_new), (None, false), "it claims no revision: the moved page's is not known");
    assert!(!kept.contains_key("notes/a"));
}

#[test]
fn a_renamed_page_edited_on_is_saved_under_its_new_name_once_its_revision_is_read() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    let mut r = Run::new(&ship);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("one");
    rename(&mut r, "notes/a", "notes/b");
    r.until("the rename", |s| s.open.as_ref().is_some_and(|p| p.name == "notes/b"));
    r.typ(" two");
    // Save pressed while the revision is not known yet waits for it, and is made then
    save(&mut r.s);
    r.until("the save", |s| !s.editing);
    r.settle();
    assert!(ship.body("notes/b").contains("one two") && !r.s.stale && ship.body("notes/a") == "<none>");
    assert!(ship.conn().queue().is_empty(), "nothing is left waiting");
}

#[test]
fn read_then_sign_out_sends_the_save_once() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    let mut r = Run::new(&ship);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("more");
    ship.st().slow = 0.6;
    to_read(&mut r.s);
    assert!(r.s.drain_req.is_pending(), "the sending is on its way");
    r.secs(0.2);
    let c = ship.conn();
    sign_out_asked(&mut r.s, false);
    // what the signing out does before it ends the session (`api::end_session`, which a test does not run)
    c.send_waiting(&std::sync::atomic::AtomicBool::new(false));
    assert_eq!(ship.saves_of("notes/a").len(), 1, "the one edit was sent more than once");
    assert!(ship.body("notes/a").contains("more") && c.queue().is_empty());
}

#[test]
fn a_change_where_a_page_is_read_waits_for_the_save_before_it() {
    let _one = one();
    let ship = Ship::start();
    ship.write("budget", "fods", &budget());
    let mut r = Run::new(&ship);
    r.open("budget");
    ship.st().slow = 0.5;
    type_cell(&mut r, "Oat milk");
    assert!(r.s.save_req.is_pending());
    // a row put in, a sheet added, the page's kind changed and an old revision restored, each before the cell's save is answered
    shift_picked(&mut r.s, true, 0, 1);
    assert!(r.s.note.contains("not changed here"), "the row is refused, and that is said: {:?}", r.s.note);
    add_sheet(&mut r.s);
    r.s.prompt = Some(Prompt::Kind(TextEdit::new("text")));
    confirm(&mut r.s);
    r.s.old = Some(Page { name: "budget".into(), body: "old".into(), kind: "fods".into(), rev: 1 });
    restore(&mut r.s);
    assert!(r.s.old.is_some(), "the old revision stays on screen to be restored in a moment");
    r.s.old = None;
    r.settle();
    assert_eq!(ship.saves_of("budget").len(), 1, "only the cell's save was sent");
    assert!(ship.body("budget").contains("Oat milk"));
    let open = r.s.open.clone().expect("the sheet is open");
    assert!(open.rev == 2 && open.body.contains("Oat milk"), "and its answer was taken: the window holds the page as saved");
    // with the save answered the row goes in, over the cell
    pick_cell(&mut r.s, 1, 0);
    shift_picked(&mut r.s, true, 0, 1);
    r.settle();
    assert_eq!(ship.saves_of("budget").len(), 2);
    assert!(ship.body("budget").contains("Oat milk") && r.s.open.as_ref().is_some_and(|p| p.rev == 3));
}

#[test]
fn autosave_goes_on_after_a_refusal_once_theirs_is_merged_in() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "# One\n\nfirst\n\n# Two\n\nsecond\n");
    let mut r = Run::new(&ship);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("mine");
    ship.write("notes/a", "md", "# One\n\nfirst theirs\n\n# Two\n\nsecond\n");
    r.autosave();
    assert!(r.s.auto_held && r.s.note.contains("not saved: 409"), "the autosave is refused: {:?}", r.s.note);
    r.sync();
    assert!(r.s.stale);
    merge_theirs(&mut r.s);
    r.typ(" and more typed after the merge");
    r.autosave();
    assert!(ship.body("notes/a").contains("after the merge") && ship.body("notes/a").contains("first theirs"), "what is typed after the merge is autosaved: {:?}", r.s.note);
}

#[test]
fn autosave_refused_on_one_page_is_not_held_on_the_next() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    ship.write("other", "md", "other\n");
    let mut r = Run::new(&ship);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("mine");
    ship.write("notes/a", "md", "theirs\n");
    r.autosave();
    assert!(r.s.auto_held);
    cancel_edit(&mut r.s);
    r.open("other");
    start_edit(&mut r.s);
    r.typ("typed on another page");
    r.autosave();
    assert!(ship.body("other").contains("typed on another page"), "the other page is autosaved. The note is {:?}", r.s.note);
    // and a refusal still holds autosave for the edit it was of
    ship.write("other", "md", "theirs\n");
    r.typ(" again");
    r.autosave();
    let sent = ship.saves_of("other").len();
    r.typ(" and again");
    r.autosave();
    assert!(r.s.auto_held && ship.saves_of("other").len() == sent, "a refused autosave is not tried again by itself");
}

#[test]
fn a_waiting_save_goes_with_its_page_when_the_page_is_renamed() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    ship.write("gone/x", "md", "x\n");
    let mut r = Run::new(&ship);
    // the ship takes no save for now, and answers all else
    ship.st().save_fail = 503;
    for (name, text) in [("notes/a", "more"), ("gone/x", "lost")] {
        r.open(name);
        start_edit(&mut r.s);
        r.typ(text);
        to_read(&mut r.s);
        r.settle();
    }
    assert!(r.s.offline.is_none() && r.s.queue.contains_key("notes/a") && r.s.queue.contains_key("gone/x"), "both wait, with the ship not away: {:?}", r.s.note);
    // a folder above the one is renamed, and the other is deleted
    rename(&mut r, "notes", "kept");
    r.until("the rename", |s| !s.op_req.is_pending());
    r.settle();
    r.s.prompt = Some(Prompt::Delete("gone/x".into()));
    confirm(&mut r.s);
    r.settle();
    assert_eq!(ship.conn().queue().keys().collect::<Vec<_>>(), ["kept/a"], "the one waits under its new name, and the other waits no more");
    assert_eq!(ship.conn().queue()["kept/a"].base, None, "it claims no revision: the moved page's is not the one it had");
    // the ship takes saves again
    ship.st().save_fail = 0;
    r.sync();
    assert!(ship.body("kept/a").contains("more"), "the edit reached the page under its new name: {:?}", r.s.note);
    assert!(r.s.cache.get("kept/a").is_some_and(|p| p.body.contains("more")), "and the window shows it");
    let pages: Vec<String> = ship.st().pages.keys().cloned().collect();
    assert_eq!(pages, ["kept/a"], "nothing was kept aside, and the deleted page's save went with it");
    assert!(ship.conn().queue().is_empty() && r.s.queue.is_empty());
}

#[test]
fn an_answer_to_an_older_read_of_the_tree_does_not_put_back_the_text_before_a_save() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    let mut r = Run::new(&ship);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("more");
    // the ship reads its tree before the save and answers after it
    (ship.st().dump_early, ship.st().dump_slow) = (true, 0.6);
    load_tree(&mut r.s);
    std::thread::sleep(Duration::from_millis(200));
    save(&mut r.s);
    r.until("the save", |s| !s.save_req.is_pending() && !s.editing);
    assert!(r.s.tree_req.is_pending(), "the older read is still on its way");
    r.settle();
    let held = |r: &Run| r.s.cache.get("notes/a").map(|p| (p.rev, p.body.clone()));
    assert_eq!(held(&r), Some((2, "firstmore\n".to_owned())), "the kept copy is the page as saved");
    // a page whose revision went back with no save of this window's in between was made again elsewhere: that is taken
    (ship.st().dump_early, ship.st().dump_slow) = (false, 0.0);
    ship.st().pages.insert("notes/a".into(), ("made again\n".into(), "md".into(), 1));
    r.sync();
    assert_eq!(held(&r), Some((1, "made again\n".to_owned())));
}

#[test]
fn a_save_answered_after_going_to_the_memories_is_kept_among_the_pages() {
    let _one = one();
    let ship = Ship::start();
    ship.write("budget", "fods", &budget());
    ship.write("notes/a", "md", "first\n");
    let mut r = Run::new(&ship);
    r.open("budget");
    ship.st().slow = 0.4;
    type_cell(&mut r, "Oat milk");
    flip(&mut r.s);
    assert!(r.s.memory);
    r.settle();
    assert!(!r.s.cache.contains_key("budget") && !r.s.names.iter().any(|n| n == "budget"), "the page is not filed among the memories");
    assert!(r.s.other.2.get("budget").is_some_and(|p| p.rev == 2 && p.body.contains("Oat milk")), "the pages hold it as saved");
    // the same for a save sent behind a press of Read
    flip(&mut r.s);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("more");
    to_read(&mut r.s);
    flip(&mut r.s);
    r.settle();
    assert!(r.s.memory && r.s.other.2.get("notes/a").is_some_and(|p| p.rev == 2 && p.body == "firstmore\n"), "its new revision is the page's, not a memory's");
    // and back among the pages the next change is taken
    flip(&mut r.s);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ(" again");
    save(&mut r.s);
    r.settle();
    assert_eq!(ship.body("notes/a"), "firstmore again\n", "{:?}", r.s.note);
}

#[test]
fn a_late_answer_to_an_address_does_not_take_the_page_opened_since() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    let mut r = Run::new(&ship);
    ship.st().urb_slow = 0.5;
    urb_go(&mut r.s, Some("urb://~sampel-palnet/notes/plan".to_owned()));
    r.secs(0.1);
    r.open("notes/a");
    r.secs(1.0);
    assert_eq!((r.s.open.as_ref().map(|p| p.name.as_str()), r.s.remote.is_some()), (Some("notes/a"), false), "the page gone to was taken away by the answer to an older request");
    // an address asked for and waited on is still shown
    urb_go(&mut r.s, Some("urb://~sampel-palnet/notes/plan".to_owned()));
    r.until("the address", |s| s.remote.is_some());
    assert_eq!(r.s.open.as_ref().map(|p| p.name.as_str()), Some("~sampel-palnet/notes/plan"));
}

#[test]
fn a_save_answered_and_not_yet_looked_at_is_still_a_save_on_its_way() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    let mut r = Run::new(&ship);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("one");
    ship.st().slow = 0.3;
    for _ in 0..2 {
        r.s.next_auto = 0.0;
        r.tick();
    }
    assert!(r.s.save_req.is_pending(), "the autosave is on its way");
    r.typ(" two");
    // one look that sees the new text, so the next finds it rested
    r.s.next_auto = 0.0;
    r.tick();
    // the answer lands with nobody looking, and the next look is also when autosave is due
    std::thread::sleep(Duration::from_millis(800));
    assert!(!r.s.save_req.is_pending(), "the answer is in and not taken");
    ship.st().slow = 0.0;
    r.s.next_auto = 0.0;
    r.tick();
    r.settle();
    r.autosave();
    r.sync();
    assert!(!r.s.stale && !r.s.auto_held, "the window's own save was taken for a change made elsewhere: {:?}", r.s.note);
    assert_eq!(ship.body("notes/a"), "firstone two\n");
}

#[test]
fn a_save_the_ship_will_never_take_does_not_stand_in_the_way_of_the_rest() {
    let _one = one();
    let ship = Ship::start();
    ship.write("z-last", "md", "z\n");
    ship.link("m-ro", "read", "theirs\n");
    let mut r = Run::new(&ship);
    r.open("m-ro");
    // Ctrl+E does not open an editor where Edit is not offered
    assert!(!usable(&r.s, "edit"));
    ctrl_e(&mut r);
    assert!(!r.s.editing, "Ctrl+E opened an editor on a link shared to read");
    // a save of it that waits all the same, as when the link was made read-only after the edit
    start_edit(&mut r.s);
    r.typ("mine");
    to_read(&mut r.s);
    r.settle();
    r.open("z-last");
    start_edit(&mut r.s);
    r.typ(" more z");
    to_read(&mut r.s);
    r.settle();
    r.sync();
    assert!(ship.body("z-last").contains("more z"), "the save behind it was sent: {:?}", r.s.note);
    // the refused text is kept as a page of its own and waits no longer
    assert_eq!(ship.saves_of("m-ro").len(), 1, "it is not sent again and again");
    assert!(ship.st().pages.iter().any(|(n, p)| n.starts_with("conflicts/offline-edit-m~dro-") && p.0.contains("mine")), "{:?}", ship.st().pages.keys().collect::<Vec<_>>());
    assert!(r.s.queue.is_empty() && ship.conn().queue().is_empty());
}

#[test]
fn a_save_the_ship_refuses_for_now_lets_the_ones_after_it_go() {
    let _one = one();
    let ship = Ship::start();
    ship.write("a-first", "md", "a\n");
    ship.write("z-last", "md", "z\n");
    ship.link("m-link", "edit", "theirs\n");
    let mut r = Run::new(&ship);
    // the link's host is away: the ship says 504 for that page alone
    ship.st().link_fail = 504;
    r.open("m-link");
    start_edit(&mut r.s);
    r.typ("mine");
    save(&mut r.s);
    r.settle();
    assert!(r.s.offline.is_none(), "the ship is not taken to be away: {:?}", r.s.note);
    assert!(r.s.queue.contains_key("m-link") && !r.s.editing, "the link's save waits for its host");
    for (name, text) in [("a-first", " more a"), ("z-last", " more z")] {
        r.open(name);
        start_edit(&mut r.s);
        r.typ(text);
        to_read(&mut r.s);
        r.settle();
        assert!(r.s.offline.is_none(), "{:?}", r.s.note);
    }
    assert!(ship.body("a-first").contains("more a") && ship.body("z-last").contains("more z"), "this ship's own pages are saved all along: {:?}", r.s.note);
    // the host is back: the link's save goes at the next read of the tree
    ship.st().link_fail = 0;
    r.sync();
    assert_eq!(ship.st().links["m-link"].1, "theirsmine\n");
    assert!(r.s.queue.is_empty());
}

#[test]
fn a_ship_that_does_not_answer_a_save_is_still_taken_to_be_away() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    ship.link("m-link", "edit", "theirs\n");
    let mut r = Run::new(&ship);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("more");
    // nothing reaches the ship: what is in between answers 504 for every page
    ship.st().fail = 504;
    save(&mut r.s);
    r.settle();
    assert!(r.s.offline.is_some() && r.s.queue.contains_key("notes/a"), "{:?}", r.s.note);
    ship.st().fail = 0;
    r.sync();
    assert!(r.s.offline.is_none() && ship.body("notes/a") == "firstmore\n" && r.s.queue.is_empty(), "{:?}", r.s.note);
}

#[test]
fn two_windows_on_one_ship_keep_each_others_waiting_saves() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "a\n");
    ship.write("notes/b", "md", "b\n");
    let mut w1 = Run::new(&ship);
    let mut w2 = Run::new(&ship);
    w1.open("notes/a");
    w2.open("notes/b");
    ship.st().fail = 502;
    start_edit(&mut w1.s);
    w1.typ("from window one");
    save(&mut w1.s);
    w1.settle();
    start_edit(&mut w2.s);
    w2.typ("from window two");
    save(&mut w2.s);
    w2.settle();
    let c = ship.conn();
    assert_eq!(c.queue().keys().collect::<Vec<_>>(), ["notes/a", "notes/b"], "each window's save is in the file");
    // the first window is closed, with nothing being typed in it
    closing(&mut w1.s);
    drop(w1);
    assert!(c.queue().contains_key("notes/a"), "what window one put by is still kept");
    // the ship comes back: the window left sends what waits, the closed window's too
    let before = ship.saves().len();
    ship.st().fail = 0;
    w2.sync();
    w2.sync();
    assert!(ship.body("notes/a").contains("window one") && ship.body("notes/b").contains("window two"), "{:?}", w2.s.note);
    assert!(c.queue().is_empty() && w2.s.queue.is_empty());
    assert_eq!(ship.saves().len() - before, 2, "each was sent once");
}

#[test]
fn a_memory_that_waits_to_be_sent_is_not_listed_among_the_pages() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "a\n");
    let mut r = Run::new(&ship);
    load_know(&mut r.s);
    r.until("the memories", |s| !s.know_req.is_pending() && !s.other.1.is_empty());
    flip(&mut r.s);
    open_page(&mut r.s, "rune/fact");
    r.tick();
    start_edit(&mut r.s);
    r.typ("more");
    ship.st().know_fail = 502;
    save(&mut r.s);
    r.settle();
    assert!(r.s.queue.contains_key("know:rune/fact"), "the memory's save waits: {:?}", r.s.note);
    flip(&mut r.s);
    r.sync();
    assert_eq!(r.s.names, ["notes/a"], "a memory that waits to be sent is listed among the pages");
    assert!(!r.s.cache.contains_key("know:rune/fact"));
    // and it is still a memory, with its waiting text
    flip(&mut r.s);
    assert!(r.s.cache.get("rune/fact").is_some_and(|p| p.body.contains("more")));
}

#[test]
fn a_links_host_away_does_not_end_the_sending_for_a_ship_not_in_front() {
    let _one = one();
    let ship = Ship::start();
    ship.write("z-last", "md", "z\n");
    ship.link("m-link", "edit", "theirs\n");
    ship.st().link_fail = 504;
    let c = ship.conn();
    // the tree as it was last kept says which pages are links
    let link = api::LinkTo { host: "~sampel-palnet".into(), path: "/m-link".into(), mode: "edit".into() };
    c.keep_tree(vec![Node { path: "m-link".into(), page: true, link: Some(link), ..Node::default() }, Node { path: "z-last".into(), page: true, ..Node::default() }]).expect("kept");
    let page = |name: &str, body: &str| Page { name: name.into(), body: body.into(), kind: "md".into(), rev: 0 };
    c.change_waiting(|_, q| {
        api::enqueue(q, &page("m-link", "theirs mine\n"), Some(4), false, 0);
        api::enqueue(q, &page("z-last", "z more\n"), Some(1), false, 0);
    })
    .expect("put by");
    let go = std::sync::atomic::AtomicBool::new(false);
    c.send_waiting(&go);
    assert_eq!(ship.body("z-last"), "z more\n", "the save after the link's was sent");
    assert_eq!(c.queue().keys().collect::<Vec<_>>(), ["m-link"], "and the link's waits for its host");
    ship.st().link_fail = 0;
    c.send_waiting(&go);
    assert!(c.queue().is_empty() && ship.st().links["m-link"].1 == "theirs mine\n");
    // a 504 for a page that is no link is still the ship not answering: nothing after it is tried
    ship.write("a-first", "md", "a\n");
    c.change_waiting(|_, q| {
        api::enqueue(q, &page("a-first", "a more\n"), Some(1), false, 0);
        api::enqueue(q, &page("z-last", "z again\n"), Some(2), false, 0);
    })
    .expect("put by");
    ship.st().fail = 504;
    let before = ship.saves().len();
    c.send_waiting(&go);
    assert_eq!((ship.saves().len() - before, c.queue().len()), (1, 2), "the first is tried, and both still wait");
}

#[test]
fn a_change_to_what_waits_is_made_to_what_the_file_holds_now() {
    let _one = one();
    let ship = Ship::start();
    let c = ship.conn();
    let page = |name: String| Page { name, body: "text\n".into(), kind: "md".into(), rev: 0 };
    // many at once, each from what it read a moment before: none writes over another's
    std::thread::scope(|sc| {
        for t in 0..8 {
            let c = c.clone();
            sc.spawn(move || {
                for i in 0..10 {
                    c.change_waiting(|_, q| api::enqueue(q, &page(format!("notes/{t}-{i}")), Some(1), false, 0)).expect("put by");
                }
            });
        }
    });
    assert_eq!(c.queue().len(), 80);
    // one taken out leaves the rest, and what is answered is what the file holds
    let sent = c.queue()["notes/0-0"].clone();
    let (ops, q) = c.change_waiting(|_, q| api::drop_sent(q, "notes/0-0", &sent)).expect("taken out");
    assert!(ops.is_empty() && q.len() == 79 && q == c.queue());
    // a save put by again since it was sent is not taken out with the one that was sent
    let newer = api::Queued { body: "newer\n".into(), ..sent.clone() };
    c.change_waiting(|_, q| drop(q.insert("notes/0-1".into(), newer.clone()))).expect("put by");
    let (_, q) = c.change_waiting(|_, q| api::drop_sent(q, "notes/0-1", &sent)).expect("left");
    assert_eq!(q.get("notes/0-1"), Some(&newer));
    // a delete or a move goes in with what it means for the saves, and comes out only from the front
    let del = api::QueuedOp::Del("notes/1-1".into());
    let (ops, q) = c.change_waiting(|ops, q| api::enqueue_op(ops, q, del.clone())).expect("put by");
    assert!(ops == [del.clone()] && !q.contains_key("notes/1-1") && c.ops() == ops);
    let (ops, _) = c.change_waiting(|ops, _| api::drop_first(ops, &api::QueuedOp::Del("another".into()))).expect("left");
    assert_eq!(ops, [del.clone()]);
    let (ops, _) = c.change_waiting(|ops, _| api::drop_first(ops, &del)).expect("taken out");
    assert!(ops.is_empty() && c.ops().is_empty());
}

#[test]
fn a_ship_test_leaves_nothing_for_a_later_one_given_its_address() {
    let _one = one();
    let ship = Ship::start();
    let c = ship.conn();
    let mine = format!("127.0.0.1%3A{}.", ship.port);
    let shared = || -> Vec<String> { api::config_dir().and_then(|d| std::fs::read_dir(d).ok()).into_iter().flatten().flatten().map(|f| f.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(&mine)).collect() };
    let before = shared();
    // what a window keeps for its ship as it runs: the tree, what waits, and the locks beside them
    c.keep_tree(vec![Node { path: "left-behind".into(), page: true, ..Node::default() }]).expect("kept");
    c.change_waiting(|_, q| api::enqueue(q, &Page { name: "left-behind".into(), body: "x\n".into(), kind: "md".into(), rev: 1 }, Some(1), false, 0)).expect("put by");
    drop(c.sending_lock());
    let dir = ship.dir();
    assert!(dir.join("waiting-~zod+http%3A%2F%2F127.0.0.1%3A".to_owned() + &format!("{}.json", ship.port)).exists(), "what waits is kept in the test's own folder");
    drop(ship);
    // a test later given the same port reads nothing of this one's
    assert!(!dir.exists(), "the test's folder is left");
    assert_eq!(shared(), before, "this test's files were kept among everyone's");
    assert!(c.kept_tree().is_none_or(|(d, _)| !d.nodes.iter().any(|n| n.path == "left-behind")) && !c.queue().contains_key("left-behind"));
}

#[test]
fn a_delete_the_ship_refuses_for_now_holds_back_only_what_is_under_it() {
    let _one = one();
    let ship = Ship::start();
    ship.write("gone", "md", "x\n");
    ship.write("z-last", "md", "z\n");
    let c = ship.conn();
    let page = |name: &str, body: &str| Page { name: name.into(), body: body.into(), kind: "md".into(), rev: 1 };
    c.change_waiting(|ops, q| {
        api::enqueue_op(ops, q, api::QueuedOp::Del("gone".into()));
        // a page made under the deleted one since: it waits for the delete
        api::enqueue(q, &page("gone/new", "made after\n"), None, true, 0);
        api::enqueue(q, &page("z-last", "z more\n"), Some(1), false, 0);
    })
    .unwrap();
    ship.st().op_fail = 500;
    let mut r = Run::new(&ship);
    for _ in 0..3 {
        r.sync();
        drain(&mut r.s);
        r.settle();
    }
    assert_eq!(ship.body("z-last"), "z more\n", "a save of another page waits behind a refused delete");
    assert!(ship.saves_of("gone/new").is_empty(), "one under the delete's path went before it");
    assert_eq!(c.ops(), [api::QueuedOp::Del("gone".into())]);
    assert_eq!(c.queue().keys().collect::<Vec<_>>(), ["gone/new"]);
    assert!(r.s.note.contains("the delete of gone is still waiting"), "and it is said: {:?}", r.s.note);
    // the ship takes it: the delete goes first, then what waited under it
    ship.st().op_fail = 0;
    r.sync();
    r.sync();
    assert_eq!((ship.body("gone"), ship.body("gone/new")), ("<none>".to_owned(), "made after\n".to_owned()));
    assert!(c.ops().is_empty() && c.queue().is_empty());
}

#[test]
fn a_move_the_ship_refuses_for_now_holds_back_only_what_is_under_it_for_the_watcher_too() {
    let _one = one();
    let ship = Ship::start();
    ship.write("a/one", "md", "a\n");
    ship.write("z-last", "md", "z\n");
    let c = ship.conn();
    let page = |name: &str, body: &str| Page { name: name.into(), body: body.into(), kind: "md".into(), rev: 1 };
    c.change_waiting(|ops, q| {
        api::enqueue(q, &page("a/one", "a more\n"), Some(1), false, 0);
        api::enqueue_op(ops, q, api::QueuedOp::Move { from: "a".into(), to: "b".into(), dname: String::new(), dnames: String::new() });
        api::enqueue(q, &page("z-last", "z more\n"), Some(1), false, 0);
    })
    .unwrap();
    ship.st().op_fail = 500;
    let go = std::sync::atomic::AtomicBool::new(false);
    c.send_waiting(&go);
    assert_eq!(ship.body("z-last"), "z more\n", "the watcher sent the save of another page");
    assert!(ship.saves_of("b/one").is_empty() && ship.body("a/one") == "a\n", "and kept the one the move carried");
    assert_eq!(c.queue().keys().collect::<Vec<_>>(), ["b/one"]);
    ship.st().op_fail = 0;
    c.send_waiting(&go);
    assert_eq!(ship.body("b/one"), "a more\n");
    assert!(c.ops().is_empty() && c.queue().is_empty());
    let _ = api::bg_sent(&c.url, c.ship(), true);
}

#[test]
fn a_waiting_list_that_cannot_be_written_stops_the_sending_and_is_said() {
    use std::os::unix::fs::PermissionsExt;
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "one\n");
    let mut r = Run::new(&ship);
    r.settle();
    let c = ship.conn();
    c.change_waiting(|_, q| api::enqueue(q, &Page { name: "notes/a".into(), body: "two\n".into(), kind: "md".into(), rev: 1 }, Some(1), false, 0)).unwrap();
    let before = ship.saves_of("notes/a").len();
    // the folder the list is kept in cannot be written, as on a full disk
    std::fs::set_permissions(ship.dir(), std::fs::Permissions::from_mode(0o555)).unwrap();
    drain(&mut r.s);
    r.secs(3.0);
    let sent = ship.saves_of("notes/a").len() - before;
    assert_eq!(sent, 1, "the same save was sent {sent} times");
    assert!(r.s.note.contains("could not be written"), "and it is said: {:?}", r.s.note);
    // a later look at what waits sends it no more while the file cannot be written
    drain(&mut r.s);
    r.settle();
    r.sync();
    assert_eq!(ship.saves_of("notes/a").len() - before, 1, "the ship has it: it is not sent again");
    assert!(r.s.note.contains("could not be written"), "{:?}", r.s.note);
    // the folder can be written again: what the ship took is taken out of the list, and not sent again
    std::fs::set_permissions(ship.dir(), std::fs::Permissions::from_mode(0o755)).unwrap();
    drain(&mut r.s);
    r.settle();
    assert_eq!(ship.saves_of("notes/a").len() - before, 1);
    assert!(c.queue().is_empty() && r.s.queue.is_empty(), "{:?}", r.s.note);
    assert_eq!(ship.body("notes/a"), "two\n");
    // a delete the ship did that cannot be taken out of the file is not sent again: a page made at that name since would go with it
    ship.write("gone", "md", "x\n");
    c.change_waiting(|ops, q| api::enqueue_op(ops, q, api::QueuedOp::Del("gone".into()))).unwrap();
    std::fs::set_permissions(ship.dir(), std::fs::Permissions::from_mode(0o555)).unwrap();
    drain(&mut r.s);
    r.settle();
    assert_eq!(ship.body("gone"), "<none>");
    assert!(r.s.note.contains("could not be written"), "{:?}", r.s.note);
    ship.write("gone", "md", "made again\n");
    drain(&mut r.s);
    r.settle();
    r.sync();
    assert_eq!(ship.body("gone"), "made again\n", "the delete was sent again");
    std::fs::set_permissions(ship.dir(), std::fs::Permissions::from_mode(0o755)).unwrap();
    drain(&mut r.s);
    r.settle();
    assert!(c.ops().is_empty() && ship.body("gone") == "made again\n");
}

#[test]
fn a_save_landing_in_one_window_keeps_another_windows_later_save_of_the_page() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/p", "md", "one\n");
    ship.write("a-other", "md", "x\n");
    let mut w1 = Run::new(&ship);
    let mut w2 = Run::new(&ship);
    w1.open("notes/p");
    w2.open("notes/p");
    ship.st().slow = 1.0;
    // window one saves the page straight to the ship: on its way for a second
    start_edit(&mut w1.s);
    w1.typ(" and from window one");
    save(&mut w1.s);
    assert!(saving(&w1.s));
    // window two took the ship to be away a moment ago: its edit of the same page, and one of another page, wait in the file
    w2.s.offline = Some(String::new());
    start_edit(&mut w2.s);
    w2.typ(" and from window two");
    save(&mut w2.s);
    w2.tick();
    open_page(&mut w2.s, "a-other");
    w2.tick();
    start_edit(&mut w2.s);
    w2.typ(" more");
    save(&mut w2.s);
    w2.tick();
    let c = ship.conn();
    assert!(c.queue().get("notes/p").is_some_and(|q| q.body.contains("window two")));
    // window two sends what waits, the other page first, slowly
    w2.s.offline = None;
    drain(&mut w2.s);
    std::thread::sleep(Duration::from_millis(100));
    // window one's next look at what waits reads the file, which holds window two's edit of the page
    drain(&mut w1.s);
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(6) {
        w1.tick();
        w2.tick();
        std::thread::sleep(Duration::from_millis(10));
    }
    w1.settle();
    w2.settle();
    let sent: Vec<String> = ship.saves_of("notes/p").into_iter().map(|s| s.body).collect();
    let waits = c.queue().get("notes/p").map(|q| q.body.clone());
    assert!(sent.iter().any(|b| b.contains("window two")) || waits.as_deref().is_some_and(|b| b.contains("window two")), "window two's edit is neither on the ship nor waiting: sent {sent:?}, waiting {waits:?}");
    assert!(sent.iter().any(|b| b.contains("window one")), "and window one's went: {sent:?}");
}

#[test]
fn a_save_landing_keeps_the_later_save_of_the_page_put_by_while_it_was_out() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/p", "md", "one\n");
    let mut r = Run::new(&ship);
    r.open("notes/p");
    ship.st().slow = 1.0;
    start_edit(&mut r.s);
    r.typ(" first");
    save(&mut r.s);
    assert!(saving(&r.s) && r.s.editing, "Save pressed: on its way, the editor open until it lands");
    // a read of the tree failed meanwhile: the window takes the ship to be away
    r.s.offline = Some(String::new());
    r.typ(" second");
    save(&mut r.s);
    r.tick();
    let c = ship.conn();
    assert!(c.queue().get("notes/p").is_some_and(|q| q.body == "one first second\n") && !r.s.editing, "{:?}", r.s.note);
    // the first save's answer lands
    r.until("the first answer", |s| !saving(s));
    r.tick();
    assert_eq!(ship.body("notes/p"), "one first\n");
    let w = c.queue().get("notes/p").cloned();
    assert!(w.as_ref().is_some_and(|q| q.body == "one first second\n" && q.base == Some(2)), "the later text still waits, over the revision the first landed at: {w:?}");
    assert!(r.s.open.as_ref().is_some_and(|p| p.body == "one first second\n"), "and the page shows it, not the text before it: {:?}", r.s.open.as_ref().map(|p| p.body.clone()));
    // a near neighbour: the same text put by again is done with once it lands
    let mut q = api::Queue::new();
    api::enqueue(&mut q, &Page { name: "n".into(), body: "same\n".into(), kind: "md".into(), rev: 1 }, Some(1), false, 5);
    api::landed_over(&mut q, "n", "same\n", 9, 2);
    assert!(q.is_empty());
    // and one put by before the save was sent, which this window never held, keeps its claim: when it goes the ship keeps aside what it replaces
    api::enqueue(&mut q, &Page { name: "n".into(), body: "older\n".into(), kind: "md".into(), rev: 1 }, Some(1), false, 5);
    api::landed_over(&mut q, "n", "newer\n", 9, 2);
    assert_eq!(q["n"].base, Some(1));
    r.s.offline = None;
    r.sync();
    r.sync();
    assert_eq!(ship.body("notes/p"), "one first second\n");
    assert!(!ship.st().pages.keys().any(|n| n.starts_with("conflicts/")), "the window's own earlier text is not kept as a conflict");
    assert!(c.queue().is_empty());
}

/// A page edited and then renamed on a ship whose tree answers slowly: `notes/a` becomes `notes/b`, saved by the edit's text.
fn renamed_while_edited(ship: &Ship) -> Run {
    ship.write("notes/a", "md", "first\n");
    let mut r = Run::new(ship);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("typed after");
    ship.st().dump_slow = 3.0;
    rename(&mut r, "notes/a", "notes/b");
    r.until("the rename", |s| s.moved_wait.is_some());
    r.tick();
    save(&mut r.s);
    assert!(r.s.moved_save && r.s.editing);
    r
}

#[test]
fn a_save_made_when_the_moved_pages_revision_is_not_read_in_time_claims_the_revision_the_ship_says() {
    let _one = one();
    let ship = Ship::start();
    let mut r = renamed_while_edited(&ship);
    // twenty seconds pass with the tree not read: the page itself is read for its revision
    let c = r.clock() + 30.0;
    poll(&mut r.s, c, &mut Tx::default());
    r.until("the save answered", |s| s.moved_wait.is_none() && !saving(s) && !s.rev_req.is_pending() && !s.editing);
    r.tick();
    let saves: Vec<Option<String>> = ship.saves_of("notes/b").into_iter().map(|s| s.base).collect();
    assert_eq!(saves, [Some("1".to_owned())], "the save claims the revision the ship has the moved page at");
    assert_eq!(ship.body("notes/b"), "firsttyped after\n");
    // the next save is over the revision that one landed at
    ship.st().dump_slow = 0.0;
    r.settle();
    start_edit(&mut r.s);
    r.typ(" again");
    save(&mut r.s);
    r.settle();
    assert_eq!(ship.saves_of("notes/b").last().and_then(|s| s.base.clone()).as_deref(), Some("2"));
    assert!(!ship.st().pages.keys().any(|n| n.starts_with("conflicts/")), "{:?}", ship.st().pages.keys().collect::<Vec<_>>());
}

#[test]
fn a_save_waits_and_says_so_while_the_moved_pages_revision_cannot_be_read() {
    let _one = one();
    let ship = Ship::start();
    let mut r = renamed_while_edited(&ship);
    // the ship does not answer the read of the page
    ship.st().source_fail = 502;
    let mut c = r.clock() + 30.0;
    poll(&mut r.s, c, &mut Tx::default());
    r.until("the read answered", |s| s.note.contains("could not be read"));
    assert!(ship.saves_of("notes/b").is_empty(), "a save with no claim was sent: {:?}", ship.saves());
    assert!(r.s.moved_wait.is_some() && r.s.editing && r.s.moved_save, "the edit waits");
    assert!(ship.conn().queue().is_empty(), "and is not put by with no claim");
    // asked again, and the ship answers
    ship.st().source_fail = 0;
    c += 30.0;
    poll(&mut r.s, c, &mut Tx::default());
    r.until("the save answered", |s| s.moved_wait.is_none() && !saving(s) && !s.rev_req.is_pending() && !s.editing);
    r.tick();
    let saves: Vec<Option<String>> = ship.saves_of("notes/b").into_iter().map(|s| s.base).collect();
    assert_eq!(saves, [Some("1".to_owned())]);
    assert_eq!(ship.body("notes/b"), "firsttyped after\n");
}

#[test]
fn a_write_by_someone_else_to_the_moved_page_is_not_replaced_by_a_save_made_after_the_wait() {
    let _one = one();
    let ship = Ship::start();
    let mut r = renamed_while_edited(&ship);
    ship.write("notes/b", "md", "someone else wrote this\n");
    let c = r.clock() + 30.0;
    poll(&mut r.s, c, &mut Tx::default());
    r.until("the read answered", |s| s.moved_wait.is_none() && !s.rev_req.is_pending());
    r.tick();
    assert!(ship.saves_of("notes/b").is_empty(), "the other write was replaced: {:?}", ship.saves());
    assert!(r.s.stale && r.s.editing, "the change is said and the edit is kept: {:?}", r.s.note);
    assert_eq!(ship.body("notes/b"), "someone else wrote this\n");
}

#[test]
fn a_page_edited_after_a_move_the_ship_refused_for_now_is_put_by_behind_it() {
    let _one = one();
    let ship = Ship::start();
    ship.write("a/one", "md", "one\n");
    ship.write("a/two", "md", "two\n");
    let c = ship.conn();
    c.change_waiting(|ops, q| api::enqueue_op(ops, q, api::QueuedOp::Move { from: "a".into(), to: "b".into(), dname: String::new(), dnames: String::new() })).unwrap();
    ship.st().op_fail = 500;
    let mut r = Run::new(&ship);
    r.sync();
    r.s.open = Some(Page { name: "b/one".into(), body: "one\n".into(), kind: "md".into(), rev: 1 });
    start_edit(&mut r.s);
    r.typ("typed");
    save(&mut r.s);
    r.settle();
    assert!(ship.saves_of("b/one").is_empty(), "sent straight, it made the page at the new name: {:?}", ship.saves());
    assert_eq!(c.queue().get("b/one").map(|q| q.body.as_str()), Some("onetyped\n"));
    // the ship takes the move: it goes first, and the save after it, onto the moved page
    ship.st().op_fail = 0;
    r.sync();
    r.sync();
    assert_eq!(ship.body("b/one"), "onetyped\n", "{:?}", r.s.note);
    assert_eq!(ship.body("a/one"), "<none>");
    assert!(c.queue().is_empty() && c.ops().is_empty());
}

#[test]
fn a_page_renamed_with_the_ship_away_while_edited_is_saved_claiming_no_revision() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    let mut r = Run::new(&ship);
    r.open("notes/a");
    start_edit(&mut r.s);
    r.typ("typed after");
    ship.st().fail = 502;
    r.s.offline = Some(String::new());
    rename(&mut r, "notes/a", "notes/b");
    r.tick();
    save(&mut r.s);
    r.tick();
    assert_eq!(ship.conn().queue().get("notes/b").map(|q| q.base), Some(None), "{:?}", r.s.note);
    ship.st().fail = 0;
    r.sync();
    r.sync();
    assert_eq!(ship.body("notes/b"), "firsttyped after\n");
    assert!(!ship.st().pages.keys().any(|n| n.starts_with("conflicts/")) && !r.s.note.contains("had changed on the ship"), "{:?}", r.s.note);
}

#[test]
fn a_late_answer_to_an_address_does_not_take_the_screen_gone_to_since() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "first\n");
    let mut r = Run::new(&ship);
    ship.st().urb_slow = 0.6;
    let screens: [(&str, fn(&mut App), fn(&App) -> bool); 4] = [
        ("the forum", go_forum, |s| s.forum.as_ref().is_some_and(|f| f.draft.as_ref().is_some_and(|d| d[2].text == "three paragraphs typed"))),
        ("the settings", go_settings, |s| s.settings.as_ref().is_some_and(|st| st.bk_label.text == "typed into a field")),
        ("the inbox", go_inbox, |s| s.inbox),
        ("access", go_access, |s| s.access),
    ];
    for (what, go, there) in screens {
        r.open("notes/a");
        urb_go(&mut r.s, Some("urb://~sampel-palnet/notes/plan".to_owned()));
        r.secs(0.1);
        go(&mut r.s);
        // what is typed there
        if let Some(f) = r.s.forum.as_mut() {
            f.draft = Some(Box::new([TextEdit::new("My long thread"), TextEdit::new(""), TextEdit::new("three paragraphs typed"), TextEdit::new("")]));
        }
        if let Some(st) = r.s.settings.as_mut() {
            st.bk_label = TextEdit::new("typed into a field");
        }
        r.secs(1.2);
        assert!(there(&r.s) && r.s.remote.is_none(), "a late answer to an address took {what}, and what was typed there");
    }
    // the screen it was asked from takes it
    urb_go(&mut r.s, Some("urb://~sampel-palnet/notes/plan".to_owned()));
    r.until("the address", |s| s.remote.is_some());
}

#[test]
fn a_schedule_from_before_is_not_given_a_ship_another_schedule_names_its_archives_for() {
    let _one = one();
    let ship = Ship::start();
    ship.write("notes/a", "md", "a\n");
    let mut r = Run::new(&ship);
    let c = ship.conn();
    let dir = ship.dir().display().to_string();
    let sched = |id: &str, ship: &str, url: &str| backups::Schedule { id: id.into(), label: "daily".into(), every_hours: 24, keep: 1, dir: dir.clone(), last_run: 0, enabled: true, ship: ship.into(), url: url.into() };
    r.s.global.backups = vec![sched("new", c.ship(), &c.url), sched("old", "", "")];
    backup_run(&mut r.s, "old");
    assert!(r.s.global.backups[1].ship.is_empty() && !r.s.global.bk_req.is_pending(), "it was given the ship, and its run would prune the other's archives");
    assert!(r.s.global.bk_said.contains("daily"), "and that is said: {:?}", r.s.global.bk_said);
}

#[test]
fn a_page_deleted_keeps_the_waiting_saves_of_the_pages_under_it_and_a_folder_does_not() {
    let _one = one();
    let ship = Ship::start();
    for (name, body) in [("p", "parent\n"), ("p/k", "kid\n"), ("q", "parent\n"), ("q/k", "kid\n"), ("f/x", "in a folder\n")] {
        ship.write(name, "md", body);
    }
    let c = ship.conn();
    let page = |name: &str, body: &str| Page { name: name.into(), body: body.into(), kind: "md".into(), rev: 1 };
    c.change_waiting(|_, q| {
        for (name, body) in [("p/k", "kid edited\n"), ("q/k", "kid edited\n"), ("f/x", "x edited\n")] {
            api::enqueue(q, &page(name, body), Some(1), false, 0);
        }
    })
    .unwrap();
    // the ship takes no save for now and answers all else: the saves wait
    ship.st().save_fail = 503;
    let mut r = Run::new(&ship);
    r.settle();
    // a page deleted with the ship answering: the ship deletes it alone, and what waits under it is still for a page that is there
    r.s.prompt = Some(Prompt::Delete("q".into()));
    confirm(&mut r.s);
    r.settle();
    assert_eq!(ship.body("q"), "<none>");
    assert!(c.queue().contains_key("q/k"), "the waiting edit of a page under the deleted one was dropped: {:?}", c.queue().keys().collect::<Vec<_>>());
    // the same with the ship away: the delete waits, and the edits of the pages under the page stay. A folder's delete takes what waits in it
    ship.st().fail = 502;
    r.s.offline = Some(String::new());
    r.s.prompt = Some(Prompt::Delete("p".into()));
    confirm(&mut r.s);
    r.s.prompt = Some(Prompt::Delete("f".into()));
    confirm(&mut r.s);
    assert_eq!(c.ops().len(), 2, "{:?}", r.s.note);
    assert_eq!(c.queue().keys().collect::<Vec<_>>(), ["p/k", "q/k"]);
    assert!(r.s.names.iter().any(|n| n == "p/k"), "and the page under it is still listed");
    (ship.st().fail, ship.st().save_fail) = (0, 0);
    r.sync();
    r.sync();
    assert_eq!((ship.body("p"), ship.body("p/k"), ship.body("q/k"), ship.body("f/x")), ("<none>".into(), "kid edited\n".into(), "kid edited\n".into(), "<none>".into()));
    assert!(c.queue().is_empty() && c.ops().is_empty(), "{:?}", r.s.note);
}

#[test]
fn a_folder_left_by_a_page_only_delete_is_deleted_with_tree_live_and_from_the_queue() {
    let _one = one();
    let ship = Ship::start();
    for (name, body) in [("d", "page\n"), ("d/k", "kid\n"), ("e", "page\n"), ("e/k", "kid\n"), ("keep", "k\n")] {
        ship.write(name, "md", body);
    }
    let c = ship.conn();
    let mut r = Run::new(&ship);
    r.settle();
    // a page's Delete is page-only: the pages under it stay, and its name is left a folder
    for n in ["d", "e"] {
        r.s.prompt = Some(Prompt::Delete(n.into()));
        confirm(&mut r.s);
        r.settle();
        assert_eq!(ship.body(n), "<none>");
    }
    assert_eq!((ship.body("d/k"), ship.body("e/k")), ("kid\n".to_owned(), "kid\n".to_owned()));
    // the folder is not a page now. Its delete takes all in it, and a repeat page-only delete would be a 409
    r.s.prompt = Some(Prompt::Delete("d".into()));
    confirm(&mut r.s);
    r.settle();
    assert_eq!((ship.body("d/k"), ship.body("keep")), ("<none>".to_owned(), "k\n".to_owned()), "{:?}", r.s.note);
    // the same folder's delete waiting in the queue (a delete put by as a folder's, or before a page went alone)
    c.change_waiting(|ops, q| api::enqueue_op(ops, q, api::QueuedOp::Del("e".into()))).unwrap();
    r.sync();
    r.sync();
    assert_eq!((ship.body("e/k"), ship.body("keep")), ("<none>".to_owned(), "k\n".to_owned()), "{:?}", r.s.note);
    assert!(c.ops().is_empty(), "{:?}", c.ops());
    // a page deleted by name alone goes alone
    c.delete("keep").unwrap();
    assert_eq!(ship.body("keep"), "<none>");
}

#[test]
fn a_group_is_saved_with_every_line_it_keeps_and_the_ship_that_says_so_takes_the_list_whole() {
    let _one = one();
    let ship = Ship::start();
    let c = ship.conn();
    let base = "/apps/x/lattice";
    let line = |p: &str| format!("{base}/page/{p}");
    let seed = || {
        let mut s = ship.st();
        s.groups_v2 = true;
        s.groups.insert("team".into(), (vec!["~nec".into()], vec![line("trip"), line("trip/dir-index"), line("sail"), line("sail/dir-index"), line("one/code")], vec![]));
    };
    let held = |n: &str| ship.st().groups.get(n).map(|g| g.1.clone()).unwrap_or_default();
    let team = || c.groups().unwrap().into_iter().find(|g| g.name == "team").unwrap();
    // keep everything: a ship that took the list whole keeps both lines of each folder
    seed();
    let g = team();
    assert_eq!(g.v, 2);
    c.group_save(&g).unwrap();
    assert_eq!(ship.st().group_saves.last().unwrap()["v"], 2);
    assert_eq!(held("team"), g.peek);
    // a page toggled on and off at a folder's own path leaves the folder's lines as they were
    c.group_save(&g.with_level(base, "trip", Level::Edit).with_level(base, "trip", Level::None)).unwrap();
    assert_eq!(held("team"), g.peek, "{:?}", held("team"));
    // remove one folder: both its lines left out
    let one = Group { peek: g.peek.iter().filter(|p| !p.starts_with(&line("trip"))).cloned().collect(), ..g.clone() };
    c.group_save(&one).unwrap();
    assert_eq!(held("team"), vec![line("sail"), line("sail/dir-index"), line("one/code")]);
    // remove everything: the group holds nothing
    seed();
    c.group_save(&Group { peek: vec![], make: vec![], ..team() }).unwrap();
    assert!(held("team").is_empty(), "{:?}", held("team"));
    // a ship that does not say it takes the list whole is not told to: the save carries no version, and its own rule stands
    ship.st().groups_v2 = false;
    seed();
    ship.st().groups_v2 = false;
    let old = team();
    assert_eq!(old.v, 0);
    c.group_save(&Group { peek: vec![], make: vec![], ..old }).unwrap();
    assert!(ship.st().group_saves.last().unwrap().get("v").is_none());
    assert_eq!(held("team").len(), 4, "the ship keeps the folders an old client leaves out");
}
