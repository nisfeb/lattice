//! Replies to the reader's own posts: what the shipless reader's comet
//! wrote on forum boards and under pages, kept in
//! `<app_data_dir>/urb/my-posts.json` and nowhere else, and the replies
//! others have made to it since.
//!
//! Nothing new is asked of a host. The reader reads the threads and pages
//! it posted to, as it reads any thread or page, and finds the replies in
//! them: on a forum thread, the comments whose parent is one of the
//! reader's own (or, on a post the reader started, the comments on the
//! post itself), by anyone else; under a page, the comments by others
//! after the reader's first one there. Each entry keeps the newest reply
//! time already seen, so a reply is new once.
//!
//! The threads are read again when a thread or page is visited, and in the
//! background on launch and every half hour (`watch`), for the count the
//! home shows. Nothing makes a sound or an OS notification.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::boards::{self, App, Board, Comment, Thread};
use crate::engine::{BoardAsk, PubComment};
use crate::reader::Ctx;

/// Most entries kept; the oldest go first.
pub const MAX: usize = 200;
/// Most entries read again in one background pass, the newest.
pub const REFRESH_MAX: usize = 50;
/// How long the background pass waits after launch, for the engine to
/// start, and then between passes.
const FIRST_WAIT: Duration = Duration::from_secs(60);
const EVERY: Duration = Duration::from_secs(30 * 60);
/// How long a pass waits for its reads.
const BUDGET: Duration = Duration::from_secs(20);

/// What the reader wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// a new post on a lattice forum board
    ForumPost,
    /// a reply in a lattice forum thread
    ForumComment,
    /// a comment under a published page
    PageComment,
}

/// One thing the reader wrote, and where.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Mine {
    pub kind: Kind,
    pub host: String,
    /// The thread's or page's address. A new post's thread is not known
    /// when it is sent: until it is found on its board, its board's address.
    pub url: String,
    /// a forum post's board
    #[serde(default)]
    pub board: Option<String>,
    /// a forum thread's post id, decimal, once known
    #[serde(default)]
    pub post: Option<String>,
    /// a page's key, as the publisher keeps it
    #[serde(default)]
    pub page: Option<String>,
    /// a new post's title, to find it on its board by
    #[serde(default)]
    pub title: Option<String>,
    /// when it was sent, ms since 1970 on this computer's clock
    pub at: i64,
    /// the newest reply already seen, ms since 1970 on the host's clock
    #[serde(default)]
    pub seen: i64,
}

impl Mine {
    /// Is the thread of a new post still to be found?
    pub fn unresolved(&self) -> bool {
        self.kind == Kind::ForumPost && self.post.is_none()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// A reply to the reader: its id (empty where the list gives none) and
/// when it was made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    pub id: String,
    pub at: i64,
}

/// The replies to `our` in a forum thread: comments by others whose parent
/// is one of `our`'s comments, and, when `our` started the thread, the
/// comments on the post itself. Oldest first, as the thread lists them.
pub fn forum_replies(our: &str, t: &Thread) -> Vec<Reply> {
    forum_replies_of(our, &t.post.author, &t.comments)
}

fn forum_replies_of(our: &str, post_author: &str, comments: &[Comment]) -> Vec<Reply> {
    let ours: HashSet<&str> = comments.iter().filter(|c| c.author == our).map(|c| c.id.as_str()).collect();
    let started = post_author == our;
    comments
        .iter()
        .filter(|c| c.author != our)
        .filter(|c| match &c.parent {
            Some(p) => ours.contains(p.as_str()),
            None => started,
        })
        .map(|c| Reply { id: c.id.clone(), at: c.created.unwrap_or(0) })
        .collect()
}

/// The replies to `our` under a page: the comments by others after `our`'s
/// first there. None until the list holds one of `our`'s.
pub fn page_replies(our: &str, comments: &[PubComment]) -> Vec<Reply> {
    let Some(first) = comments.iter().filter(|c| c.author == our).map(|c| c.when).min() else { return Vec::new() };
    comments
        .iter()
        .filter(|c| c.author != our && c.when > first)
        .map(|c| Reply { id: c.id.clone(), at: c.when })
        .collect()
}

/// The replies not seen yet: made after `seen`.
pub fn unseen(replies: &[Reply], seen: i64) -> Vec<&Reply> {
    replies.iter().filter(|r| r.at > seen).collect()
}

/// The seen marker once `replies` have been shown: the newest of them, or
/// `seen` if that is newer.
pub fn seen_after(replies: &[Reply], seen: i64) -> i64 {
    replies.iter().map(|r| r.at).max().map_or(seen, |m| m.max(seen))
}

/// Where a new post `m` landed on `b`: the newest post there by `our`
/// with its title.
pub fn find_post<'a>(our: &str, m: &Mine, b: &'a Board) -> Option<&'a boards::Post> {
    let title = m.title.as_deref()?;
    b.posts.iter().filter(|p| p.author == our && p.title.trim() == title.trim()).max_by_key(|p| p.created.unwrap_or(0))
}

/// The reader's own posts, on disk.
pub struct MyPosts {
    file: PathBuf,
    /// one writer at a time
    lock: Mutex<()>,
}

impl MyPosts {
    pub fn open(dir: &Path) -> MyPosts {
        MyPosts { file: dir.join("my-posts.json"), lock: Mutex::new(()) }
    }

    /// Newest first. A missing or unreadable file is an empty list.
    pub fn list(&self) -> Vec<Mine> {
        std::fs::read(&self.file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Record something the reader just wrote. Writing again where it
    /// already wrote moves that entry to the top, keeping what it has seen.
    pub fn record(&self, m: Mine) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let mut all = self.list();
        let same = |e: &Mine| e.url == m.url && (e.title == m.title || !(e.unresolved() || m.unresolved()));
        let kept = all.iter().position(same).map(|i| all.remove(i));
        let m = match kept {
            // a post the reader started stays one
            Some(k) => Mine { kind: if k.kind == Kind::ForumPost { k.kind } else { m.kind }, at: k.at.min(m.at), seen: k.seen, ..m },
            None => m,
        };
        all.insert(0, m);
        all.truncate(MAX);
        self.write(&all)
    }

    /// Change the list in place, and write it when `f` says it changed.
    pub fn update(&self, f: impl FnOnce(&mut Vec<Mine>) -> bool) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let mut all = self.list();
        if f(&mut all) {
            all.truncate(MAX);
            self.write(&all)
        } else {
            Ok(())
        }
    }

    /// Whole or not at all, and private: write_private's temp file beside
    /// it, then a rename, in a folder made 0700 as the engine makes it.
    fn write(&self, all: &[Mine]) -> Result<(), String> {
        let body = serde_json::to_vec(all).map_err(|e| format!("my posts: {e}"))?;
        crate::session::write_private(&self.file, &body).map_err(|e| format!("my posts: {e}"))
    }
}

/// An entry for a forum write just sent: a reply in the thread at
/// `thread_url` (post `post`), or a new post titled `title` on the board
/// at `board_url`.
pub fn forum_entry(p: &boards::Place, title: Option<&str>) -> Mine {
    let (kind, url, title) = match (&p.post, title) {
        (Some(id), _) => (Kind::ForumComment, p.thread_url(id), None),
        (None, t) => (Kind::ForumPost, p.board_url(), t.map(String::from)),
    };
    Mine {
        kind,
        host: p.host.clone(),
        url,
        board: Some(p.board.clone()),
        post: p.post.clone(),
        page: None,
        title,
        at: now_ms(),
        seen: 0,
    }
}

/// An entry for a comment just sent under the page at `url` (key `key`)
/// of `ship`.
pub fn page_entry(ship: &str, url: &str, key: &str) -> Mine {
    Mine {
        kind: Kind::PageComment,
        host: ship.to_string(),
        url: url.to_string(),
        board: None,
        post: None,
        page: Some(key.to_string()),
        title: None,
        at: now_ms(),
        seen: 0,
    }
}

/// What the home lists: a place with replies the reader has not seen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unseen {
    pub url: String,
    pub title: String,
    pub count: usize,
    /// a followed folder's new pages (`folder_news`), not replies
    pub folder: bool,
}

/// Each place's unseen replies as the last read of it found them, by
/// address.
#[derive(Default)]
pub struct Counts(Mutex<HashMap<String, Unseen>>);

impl Counts {
    pub fn set(&self, u: Unseen) {
        self.0.lock().unwrap().insert(u.url.clone(), u);
    }
    /// The followed folders' news, all of it replaced by `news`.
    pub fn set_folders(&self, news: Vec<Unseen>) {
        let mut g = self.0.lock().unwrap();
        g.retain(|_, u| !u.folder);
        for u in news {
            g.insert(u.url.clone(), u);
        }
    }
    /// The places with unseen replies, most first.
    pub fn list(&self) -> Vec<Unseen> {
        let mut l: Vec<Unseen> = self.0.lock().unwrap().values().filter(|u| u.count > 0).cloned().collect();
        l.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.url.cmp(&b.url)));
        l
    }
}

/// A forum thread visited at `url`: the ids of the replies to the reader
/// not seen before, which are marked new, and the seen marker moved past
/// them. Nothing when the reader has not posted there.
pub fn visit_thread(ctx: &Ctx, url: &str, t: &Thread) -> HashSet<String> {
    let Some(our) = ctx.reads.our() else { return HashSet::new() };
    let replies = forum_replies(&our, t);
    let mut fresh = HashSet::new();
    let mut found = false;
    let res = ctx.mine.update(|all| {
        let Some(m) = all.iter_mut().find(|m| m.url == url) else { return false };
        found = true;
        fresh = unseen(&replies, m.seen).into_iter().map(|r| r.id.clone()).collect();
        let next = seen_after(&replies, m.seen);
        let changed = next != m.seen;
        m.seen = next;
        changed
    });
    log(res);
    if found {
        ctx.counts.set(Unseen { url: url.to_string(), title: t.post.title.clone(), count: 0, folder: false });
    }
    fresh
}

/// A page visited at `url`, with its public comments: the time after
/// which a comment by someone else is a new reply, and the seen marker
/// moved past them. `None` when the reader has not commented there.
pub fn visit_page(ctx: &Ctx, url: &str, title: &str, comments: &[PubComment]) -> Option<i64> {
    let our = ctx.reads.our()?;
    let replies = page_replies(&our, comments);
    let first = comments.iter().filter(|c| c.author == our).map(|c| c.when).min();
    let mut after = None;
    let res = ctx.mine.update(|all| {
        let Some(m) = all.iter_mut().find(|m| m.url == url && m.kind == Kind::PageComment) else { return false };
        after = first.map(|f| f.max(m.seen));
        let next = seen_after(&replies, m.seen);
        let changed = next != m.seen;
        m.seen = next;
        changed
    });
    log(res);
    if after.is_some() {
        ctx.counts.set(Unseen { url: url.to_string(), title: title.to_string(), count: 0, folder: false });
    }
    after
}

/// A forum board visited: the reader's new posts on it, found, take
/// their threads' addresses.
pub fn visit_board(ctx: &Ctx, p: &boards::Place, b: &Board) {
    let Some(our) = ctx.reads.our() else { return };
    let board_url = p.board_url();
    log(ctx.mine.update(|all| resolve(&our, all, &board_url, p, b)));
}

/// The reader's unresolved posts on the board at `board_url` that `b`
/// lists, given their threads. Whether any was.
fn resolve(our: &str, all: &mut [Mine], board_url: &str, p: &boards::Place, b: &Board) -> bool {
    let mut changed = false;
    for m in all.iter_mut().filter(|m| m.unresolved() && m.url == board_url) {
        if let Some(post) = find_post(our, m, b) {
            m.post = Some(post.id.clone());
            m.url = p.thread_url(&post.id);
            changed = true;
        }
    }
    changed
}

fn log(r: Result<(), String>) {
    if let Err(e) = r {
        crate::commands::dlog(&format!("reader: {e}"));
    }
}

/// A followed folder's news, one entry per folder (by its address, so a
/// later count replaces an earlier one): "N new pages in <folder> from
/// ~ship".
pub fn folder_news(ship: &str, folder: &str, new: usize) -> Unseen {
    Unseen {
        url: crate::render::folder_url(ship, &crate::follows::rel(folder)),
        title: format!("{new} new {} in {folder} from {ship}", if new == 1 { "page" } else { "pages" }),
        count: new,
        folder: true,
    }
}

/// What a follow-new event tells the home: the folder's entry, at the new
/// count (`follows::NewPages`).
pub fn follow_new(counts: &Counts, n: &crate::follows::NewPages) {
    counts.set(folder_news(&n.ship, &n.folder, n.new));
}

/// The followed folders' news as the follows stand: one entry per folder
/// with new pages, so a folder whose new pages were all read, or one
/// unfollowed or unavailable, drops off the home.
pub fn followed_folder_events(ctx: &Ctx) -> Vec<Unseen> {
    ctx.follows
        .list()
        .iter()
        .filter(|f| f.status == crate::follows::Status::Ok)
        .map(|f| folder_news(&f.ship, &f.folder, f.new_count()))
        .filter(|u| u.count > 0)
        .collect()
}

/// The home's folder news again from the follows, after a read or an
/// unfollow lowers a count (a follow-new event only ever raises one).
pub fn folders_changed(ctx: &Ctx) {
    ctx.counts.set_folders(followed_folder_events(ctx));
}

/// Read again the newest REFRESH_MAX places the reader wrote, and count
/// the replies to it there not seen yet. A host that fails is skipped for
/// the rest of the pass.
pub fn refresh(ctx: &Ctx) {
    let Some(our) = ctx.reads.our() else { return };
    let all: Vec<Mine> = ctx.mine.list().into_iter().take(REFRESH_MAX).collect();
    let mut failed: HashSet<String> = HashSet::new();

    // the boards of posts still to be found, then every forum thread, in
    // one batch of reads
    let mut boards_to_read: Vec<boards::Place> = Vec::new();
    for m in all.iter().filter(|m| m.unresolved()) {
        if let Some(p) = boards::place(&m.url).filter(|p| p.app == App::Forum) {
            if !boards_to_read.contains(&p) {
                boards_to_read.push(p);
            }
        }
    }
    let asks = boards_to_read.iter().map(|p| BoardAsk::Forum { host: p.host.clone(), board: p.board.clone() }).collect();
    let got = if boards_to_read.is_empty() { Vec::new() } else { ctx.reads.boards(asks, BUDGET) };
    for (p, r) in boards_to_read.iter().zip(got) {
        match r {
            Ok(v) => {
                let b = boards::forum_board(&v);
                log(ctx.mine.update(|l| resolve(&our, l, &p.board_url(), p, &b)));
            }
            Err(_) => {
                failed.insert(p.host.clone());
            }
        }
    }
    let all: Vec<Mine> = ctx.mine.list().into_iter().take(REFRESH_MAX).collect();

    let threads: Vec<(&Mine, boards::Place, BoardAsk)> = all
        .iter()
        .filter(|m| matches!(m.kind, Kind::ForumPost | Kind::ForumComment) && !failed.contains(&m.host))
        .filter_map(|m| {
            let p = boards::place(&m.url).filter(|p| p.app == App::Forum)?;
            let post = boards::post_id(&p)?;
            let ask = BoardAsk::ForumThread { host: p.host.clone(), board: p.board.clone(), post };
            Some((m, p, ask))
        })
        .collect();
    let asks = threads.iter().map(|(_, _, a)| a.clone()).collect();
    let got = if threads.is_empty() { Vec::new() } else { ctx.reads.boards(asks, BUDGET) };
    for ((m, _, _), r) in threads.iter().zip(got) {
        match r.ok().and_then(|v| boards::forum_thread(&v)) {
            Some(t) => {
                let n = unseen(&forum_replies(&our, &t), m.seen).len();
                ctx.counts.set(Unseen { url: m.url.clone(), title: t.post.title.clone(), count: n, folder: false });
            }
            None => {
                failed.insert(m.host.clone());
            }
        }
    }

    let read = ctx.history.list();
    let title_of = |url: &str| read.iter().find(|e| e.url == url && !e.title.trim().is_empty()).map_or_else(|| url.to_string(), |e| e.title.clone());
    for m in all.iter().filter(|m| m.kind == Kind::PageComment) {
        let Some(key) = m.page.as_deref() else { continue };
        if failed.contains(&m.host) {
            continue;
        }
        match ctx.reads.thread(&m.host, key, BUDGET) {
            Some(cs) => {
                let n = unseen(&page_replies(&our, &cs), m.seen).len();
                ctx.counts.set(Unseen { url: m.url.clone(), title: title_of(&m.url), count: n, folder: false });
            }
            None => {
                failed.insert(m.host.clone());
            }
        }
    }

    folders_changed(ctx);
}

/// The background pass: once the engine has had a minute to start, then
/// every EVERY. A pass that finds the reader identity not running yet
/// tries again after FIRST_WAIT.
pub fn watch(ctx: Arc<Ctx>) {
    let spawned = std::thread::Builder::new().name("reader-replies".into()).spawn(move || loop {
        std::thread::sleep(FIRST_WAIT);
        if ctx.reads.our().is_none() {
            continue;
        }
        refresh(&ctx);
        std::thread::sleep(EVERY.saturating_sub(FIRST_WAIT));
    });
    if let Err(e) = spawned {
        crate::commands::dlog(&format!("reader: replies watch: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boards::Post;

    const US: &str = "~doznec-sampel-palnet";

    fn c(id: &str, parent: Option<&str>, author: &str, at: i64) -> Comment {
        Comment { id: id.into(), parent: parent.map(Into::into), author: author.into(), body: "x".into(), created: Some(at) }
    }

    fn pc(author: &str, when: i64) -> PubComment {
        PubComment { id: format!("{author}-{when}"), author: author.into(), when, body: "x".into() }
    }

    fn thread(author: &str, comments: Vec<Comment>) -> Thread {
        Thread { board: "b".into(), post: Post { id: "1".into(), author: author.into(), title: "T".into(), ..Post::default() }, comments }
    }

    fn ids(r: &[Reply]) -> Vec<&str> {
        r.iter().map(|r| r.id.as_str()).collect()
    }

    #[test]
    fn replies_to_our_comment_are_found_and_others_are_not() {
        let t = thread(
            "~zod",
            vec![
                c("1", None, "~bus", 10),
                c("2", None, US, 20),
                c("3", Some("2"), "~nec", 30),
                c("4", Some("1"), "~nec", 40),
                c("5", Some("2"), US, 50),
                c("6", None, "~wes", 60),
            ],
        );
        assert_eq!(ids(&forum_replies(US, &t)), ["3"]);
    }

    #[test]
    fn on_our_own_post_top_level_comments_are_replies() {
        let t = thread(US, vec![c("1", None, "~bus", 10), c("2", None, US, 20), c("3", Some("2"), "~nec", 30), c("4", Some("1"), "~nec", 40)]);
        assert_eq!(ids(&forum_replies(US, &t)), ["1", "3"]);
    }

    #[test]
    fn page_replies_come_after_our_first_comment() {
        let cs = vec![pc("~bus", 5), pc(US, 10), pc("~nec", 15), pc(US, 20), pc("~wes", 25)];
        assert_eq!(page_replies(US, &cs).iter().map(|r| r.at).collect::<Vec<_>>(), [15, 25]);
        assert!(page_replies(US, &[pc("~bus", 5)]).is_empty());
    }

    #[test]
    fn the_seen_marker_shows_a_reply_new_once() {
        let r = vec![Reply { id: "a".into(), at: 10 }, Reply { id: "b".into(), at: 30 }];
        assert_eq!(unseen(&r, 0).len(), 2);
        let s = seen_after(&r, 0);
        assert_eq!(s, 30);
        assert!(unseen(&r, s).is_empty());
        assert_eq!(seen_after(&[], 7), 7);
        assert_eq!(seen_after(&r, 99), 99);
        assert_eq!(ids(&unseen(&r, 10).into_iter().cloned().collect::<Vec<_>>()), ["b"]);
    }

    fn fresh(name: &str) -> (PathBuf, MyPosts) {
        let d = std::env::temp_dir().join(format!("my-posts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let m = MyPosts::open(&d);
        (d, m)
    }

    fn entry(url: &str, at: i64) -> Mine {
        Mine { at, ..page_entry("~zod", url, "/k") }
    }

    #[test]
    fn the_list_is_newest_first_and_capped() {
        let (d, m) = fresh("cap");
        for i in 0..(MAX + 5) {
            m.record(entry(&format!("urb://~zod/p{i}"), i as i64)).unwrap();
        }
        let l = m.list();
        assert_eq!(l.len(), MAX);
        assert_eq!(l[0].url, format!("urb://~zod/p{}", MAX + 4));
        assert_eq!(l[MAX - 1].url, "urb://~zod/p5");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn writing_again_keeps_what_was_seen() {
        let (d, m) = fresh("again");
        m.record(entry("urb://~zod/a", 1)).unwrap();
        m.record(entry("urb://~zod/b", 2)).unwrap();
        m.update(|l| {
            l.iter_mut().for_each(|e| e.seen = 50);
            true
        })
        .unwrap();
        m.record(entry("urb://~zod/a", 3)).unwrap();
        let l = m.list();
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].url.as_str(), l[0].at, l[0].seen), ("urb://~zod/a", 1, 50));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn the_list_round_trips_and_a_corrupt_file_reads_empty() {
        let (d, m) = fresh("trip");
        let p = boards::place("urb://~wep/forum/general/12").unwrap();
        let reply = forum_entry(&p, None);
        let post = forum_entry(&boards::place("urb://~wep/forum/general").unwrap(), Some("Hello"));
        m.record(reply.clone()).unwrap();
        m.record(post.clone()).unwrap();
        assert_eq!(MyPosts::open(&d).list(), vec![post.clone(), reply]);
        assert_eq!(post.kind, Kind::ForumPost);
        assert!(post.unresolved());
        std::fs::write(d.join("my-posts.json"), b"{nope").unwrap();
        assert!(m.list().is_empty());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn a_new_post_is_found_on_its_board() {
        let p = boards::place("urb://~wep/forum/general").unwrap();
        let mut all = vec![forum_entry(&p, Some("Hello"))];
        let post = |id: &str, author: &str, title: &str, at: i64| Post {
            id: id.into(),
            author: author.into(),
            title: title.into(),
            created: Some(at),
            ..Post::default()
        };
        let b = Board { posts: vec![post("9", "~bus", "Hello", 30), post("7", US, "Hello", 20), post("3", US, "Other", 25)], ..Board::default() };
        assert!(resolve(US, &mut all, &p.board_url(), &p, &b));
        assert_eq!((all[0].post.as_deref(), all[0].url.as_str()), (Some("7"), "urb://~wep/forum/general/7"));
        assert!(!resolve(US, &mut all, &p.board_url(), &p, &b));
    }

    #[test]
    fn follow_new_coalesces_per_folder_beside_the_replies() {
        let c = Counts::default();
        c.set(Unseen { url: "urb://~wep/forum/g/7".into(), title: "T".into(), count: 2, folder: false });
        let n = |new| crate::follows::NewPages { ship: "~zod".into(), folder: "/docs".into(), new };
        follow_new(&c, &n(1));
        follow_new(&c, &n(3));
        let folders: Vec<Unseen> = c.list().into_iter().filter(|u| u.folder).collect();
        assert_eq!(folders.len(), 1, "one entry per folder, not per page");
        assert_eq!((folders[0].count, folders[0].title.as_str()), (3, "3 new pages in /docs from ~zod"));
        assert_eq!(folders[0].url, "urb://~zod/docs/");
        assert_eq!(folder_news("~zod", "/a/b", 1).title, "1 new page in /a/b from ~zod");
        // the folder's pages read: it drops, and the replies stay
        c.set_folders(Vec::new());
        assert_eq!(c.list().iter().map(|u| (u.count, u.folder)).collect::<Vec<_>>(), [(2, false)]);
    }

    #[test]
    fn counts_list_only_unseen_places_most_first() {
        let c = Counts::default();
        c.set(Unseen { url: "a".into(), title: "A".into(), count: 1, folder: false });
        c.set(Unseen { url: "b".into(), title: "B".into(), count: 3, folder: false });
        c.set(Unseen { url: "z".into(), title: "Z".into(), count: 0, folder: false });
        assert_eq!(c.list().iter().map(|u| u.url.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        c.set(Unseen { url: "b".into(), title: "B".into(), count: 0, folder: false });
        assert_eq!(c.list().len(), 1);
    }
}
