//! Boards in the shipless reader: lattice forums and furum boards, read
//! through the engine (`Reads::boards`, read calls only) and shown in the
//! reader's chrome, read only.
//!
//! Addresses:
//!
//! - `urb://~host/forum/<board>[/<post>]`, lattice's forum address (the
//!   engine's `de_urb` names it `Mount::Forum`);
//! - `urb://~host/furum/<board>[/<post>]`, the reader's own address for a
//!   furum board, which has no urb:// form of its own.
//!
//! A board is its threads, newest first, each with its title, author, time
//! and reply count. A thread is its post and then its comments, oldest
//! first. Every title, name and body is the publisher's, so each is
//! escaped, and bodies go through urb-render's Markdown renderer with the
//! reader's link mapping, as a Markdown page does.
//!
//! On a lattice forum board the host lists in its `/pub/forum-comets`
//! (public, and its owner left comet posting on), the reader starts posts
//! and replies as its own identity (`POST /forum`, reader.rs). Anywhere
//! else, posting and replying need a node of one's own, and are shown and
//! disabled. Voting is disabled everywhere: a reader identity is free to
//! make, so its vote would count for nothing, and the host refuses one.

use std::time::Duration;

use urb_engine::js::{self, Js};
use urb_engine::url::{de_urb, Mount};
use urb_engine::Int;
use urb_render::gateway;

use crate::engine::{BoardAsk, ReadError};
use crate::reader::Ctx;
use crate::render::{self, chrome, enc, esc, lossy, main_of, read_href, Note, Shown, OWN};

/// How long a board read waits: the first contact with a ship can be slow.
const BUDGET: Duration = Duration::from_secs(20);
/// The most furum posts whose comments are counted for a board's list.
const COUNTED: usize = 50;
/// The most threads a board shows.
const LISTED: usize = 200;
/// Why every write on a board is disabled.
pub const WHY: &str = "Connect a node to post";
/// Why a forum board that says it takes no comet posts is read only.
pub const CLOSED: &str = "This board takes no posts from readers without a node";
/// Why voting is disabled on a forum board.
pub const NO_VOTE: &str = "Readers without a node can't vote: their identity is free to make, so a vote would count for nothing";
/// lattice's caps for a forum post's title and link (`sane-post`), in
/// bytes. A post's text and a reply are cut at `TEXT_MAX`, under the
/// host's 40,000 and 10,000.
pub const TITLE_MAX: usize = 300;
pub const LINK_MAX: usize = 2048;
pub const TEXT_MAX: usize = 10_000;

/// Whether a forum board takes writes from the reader, and what became of
/// the last one. `open` is the host's word (`/pub/forum-comets`): `None`
/// when it did not say, as an older lattice does not.
#[derive(Clone, Copy, Debug, Default)]
pub struct Write<'a> {
    pub open: Option<bool>,
    pub our: Option<&'a str>,
    pub note: Option<&'a Note>,
}

const CSS: &str = "\
.board, .thread { max-width: 46rem; width: 100%; margin: 0 auto; padding: 1.25rem 1.5rem 3rem; }\
.crumbs { font-size: .9rem; margin: 0 0 .75rem; color: var(--muted); }\
.board h1, .thread h1 { margin: .2rem 0 .3rem; font-size: 1.5rem; line-height: 1.25; overflow-wrap: anywhere; }\
.meta { color: var(--muted); font-size: .85rem; overflow-wrap: anywhere; }\
.who { font-family: ui-monospace, monospace; font-size: .85em; }\
ol.threads, ol.comments { list-style: none; padding: 0; margin: 1rem 0; }\
ol.threads li { padding: .6rem 0; border-bottom: 1px solid var(--line); }\
ol.threads .t { font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }\
ol.threads .t:hover { text-decoration: underline; }\
ol.comments li { padding: .6rem 0 .6rem .75rem; border-left: 3px solid var(--line); margin: .6rem 0; }\
.thread .post { border-bottom: 1px solid var(--line); padding-bottom: .75rem; }\
.thread .body { overflow-wrap: anywhere; }\
.thread .body > :first-child { margin-top: .4rem; }\
.thread h2 { font-size: 1rem; margin: 1.25rem 0 .25rem; }\
.reply textarea { width: 100%; font: inherit; padding: .5rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--muted); resize: none; }\
.reply button { font: inherit; font-size: .9rem; padding: .3rem .7rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--muted); cursor: not-allowed; }\
.write { margin: 1rem 0; }\
.write input, .write textarea { display: block; width: 100%; box-sizing: border-box; font: inherit; padding: .5rem; margin: 0 0 .5rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }\
.write textarea { resize: vertical; }\
.write button { font: inherit; font-size: .9rem; padding: .3rem .7rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }\
.note.ok { color: var(--ok, inherit); } .note.err { color: var(--err, inherit); }\
";

/// Which app keeps the board.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum App {
    Forum,
    Furum,
}

/// A board or thread address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub app: App,
    pub host: String,
    pub board: String,
    /// the post, as its decimal id
    pub post: Option<String>,
}

impl Place {
    fn prefix(&self) -> &'static str {
        match self.app {
            App::Forum => "forum",
            App::Furum => "furum",
        }
    }
    /// the board's address
    pub fn board_url(&self) -> String {
        format!("urb://{}/{}/{}", self.host, self.prefix(), self.board)
    }
    /// a thread's address on this board. A lattice forum's post is an
    /// @ud, dotted in threes (`1.000`), as its address takes it.
    pub fn thread_url(&self, id: &str) -> String {
        match self.app {
            App::Forum => format!("{}/{}", self.board_url(), dotted(id)),
            App::Furum => format!("{}/{id}", self.board_url()),
        }
    }
}

/// decimal digits as an @ud prints them: `1234567` is `1.234.567`
fn dotted(id: &str) -> String {
    let mut out = String::with_capacity(id.len() + id.len() / 3);
    for (i, c) in id.chars().enumerate() {
        if i > 0 && (id.len() - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(c);
    }
    out
}

/// a furum board name or id segment: lowercase, digits, `-`
fn seg(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The board or thread `url` names, if it names one.
pub fn place(url: &str) -> Option<Place> {
    let u = de_urb(url).ok()?;
    match (&u.mount, u.rel.as_slice()) {
        (Mount::Forum { post }, [board]) => Some(Place {
            app: App::Forum,
            host: u.ship.clone(),
            board: board.clone(),
            post: post.as_ref().map(|i: &Int| i.decimal()),
        }),
        (Mount::N, [furum, board]) if furum == "furum" && seg(board) => {
            Some(Place { app: App::Furum, host: u.ship, board: board.clone(), post: None })
        }
        (Mount::N, [furum, board, id]) if furum == "furum" && seg(board) => {
            // furum's ids are JS numbers: exact up to 2^53
            let n = id.parse::<u64>().ok().filter(|n: &u64| *n < (1 << 53) && *id == n.to_string())?;
            Some(Place { app: App::Furum, host: u.ship, board: board.clone(), post: Some(n.to_string()) })
        }
        _ => None,
    }
}

/// A post, as a board lists it or a thread heads it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Post {
    pub id: String,
    pub title: String,
    pub author: String,
    /// ms since 1970
    pub created: Option<i64>,
    pub url: Option<String>,
    pub body: Option<String>,
    /// replies, when known
    pub replies: Option<usize>,
    /// up less down, for a lattice forum
    pub score: Option<i64>,
}

/// A comment in a thread.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Comment {
    pub id: String,
    pub parent: Option<String>,
    pub author: String,
    pub body: String,
    pub created: Option<i64>,
}

/// A board: its title and description, and its threads, newest first.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Board {
    pub title: String,
    pub description: String,
    pub posts: Vec<Post>,
}

/// A thread: its board's title, its post and the comments, oldest first.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Thread {
    pub board: String,
    pub post: Post,
    pub comments: Vec<Comment>,
}

// ------------------------------------------------------------ the engine's values

fn get<'a>(x: &'a Js, k: &str) -> Option<&'a Js> {
    match x {
        Js::Obj(o) => o.get(k),
        _ => None,
    }
}

fn text(x: Option<&Js>) -> Option<String> {
    match x {
        Some(Js::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

fn id_text(x: Option<&Js>) -> Option<String> {
    match x {
        Some(Js::Num(n)) if n.fract() == 0.0 && *n >= 0.0 => Some(js::number_text(*n)),
        Some(Js::Big(i)) => Some(i.decimal()),
        Some(Js::Str(s)) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => Some(s.clone()),
        _ => None,
    }
}

fn date(x: Option<&Js>) -> Option<i64> {
    match x {
        Some(Js::Date(d)) => *d,
        _ => None,
    }
}

fn arr(x: Option<&Js>) -> &[Js] {
    match x {
        Some(Js::Arr(a)) => a,
        _ => &[],
    }
}

fn count(x: Option<&Js>) -> Option<usize> {
    match x {
        Some(Js::Num(n)) if *n >= 0.0 && n.fract() == 0.0 => Some(*n as usize),
        _ => None,
    }
}

fn post_of(p: &Js) -> Option<Post> {
    let id = id_text(get(p, "id"))?;
    let (up, down) = (get(p, "up"), get(p, "down"));
    Some(Post {
        id,
        title: text(get(p, "title")).unwrap_or_default(),
        author: text(get(p, "author")).unwrap_or_default(),
        created: date(get(p, "created")),
        url: text(get(p, "url")).filter(|u| !u.is_empty()),
        body: text(get(p, "body")).filter(|b| !b.trim().is_empty()),
        replies: count(get(p, "comments")),
        score: (up.is_some() || down.is_some()).then(|| arr(up).len() as i64 - arr(down).len() as i64),
    })
}

fn comment_of(c: &Js) -> Option<Comment> {
    Some(Comment {
        id: id_text(get(c, "id"))?,
        parent: id_text(get(c, "parent")),
        author: text(get(c, "author")).unwrap_or_default(),
        body: text(get(c, "body")).unwrap_or_default(),
        created: date(get(c, "created")),
    })
}

/// lattice forum.mjs's board(): `{info, posts, ...}`
pub fn forum_board(b: &Js) -> Board {
    let info = get(b, "info");
    Board {
        title: info.and_then(|i| text(get(i, "title"))).unwrap_or_default(),
        description: info.and_then(|i| text(get(i, "description"))).unwrap_or_default(),
        posts: arr(get(b, "posts")).iter().filter_map(post_of).collect(),
    }
}

/// lattice forum.mjs's thread(): `{info, post, comments}`
pub fn forum_thread(t: &Js) -> Option<Thread> {
    Some(Thread {
        board: get(t, "info").and_then(|i| text(get(i, "title"))).unwrap_or_default(),
        post: post_of(get(t, "post")?)?,
        comments: arr(get(t, "comments")).iter().filter_map(comment_of).collect(),
    })
}

/// furum.mjs's posts(): its posts, newest first
pub fn furum_posts(p: &Js) -> Vec<Post> {
    arr(Some(p)).iter().filter_map(post_of).collect()
}

/// furum.mjs's comments(): a post's comments, oldest first
pub fn furum_comments(c: &Js) -> Vec<Comment> {
    arr(Some(c)).iter().filter_map(comment_of).collect()
}

// ------------------------------------------------------------ rendering

/// A time as `2026-11-03 14:05 UTC`.
fn when(ms: Option<i64>) -> String {
    match ms {
        Some(ms) => {
            let iso = js::iso(ms);
            format!("{} UTC", iso.get(..16).unwrap_or(&iso).replace('T', " "))
        }
        None => "no date".into(),
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The strip of writes a board would take, each disabled with its reason.
fn strip(labels: &[(&str, &str)]) -> String {
    if labels.is_empty() {
        return String::new();
    }
    let mut s = String::from("<div class=\"actions\" role=\"group\" aria-label=\"Actions that need a node\">");
    for (l, why) in labels {
        let id = l.to_ascii_lowercase().replace(' ', "-");
        s.push_str(&format!(
            "<span class=\"act\"><button type=\"button\" disabled title=\"{why}\" aria-describedby=\"why-{id}\">{l}</button>\
             <span class=\"why\" id=\"why-{id}\">{why}</span></span>"
        ));
    }
    s.push_str("</div>");
    s
}

/// The reason the reader cannot post on `p`, or `None` when it can.
fn closed_why(p: &Place, w: &Write) -> Option<&'static str> {
    match (p.app, w.open) {
        (App::Forum, Some(true)) => None,
        (App::Forum, Some(false)) => Some(CLOSED),
        _ => Some(WHY),
    }
}

/// The disabled writes on `p`: posting (`write`, "New post" or "Reply")
/// when the reader cannot, and voting on a forum.
fn disabled<'a>(p: &Place, w: &Write, write: &'a str, vote: bool) -> Vec<(&'a str, &'static str)> {
    let mut out = Vec::new();
    if let Some(why) = closed_why(p, w) {
        out.push((write, why));
    }
    if vote {
        out.push(("Vote", if p.app == App::Forum { NO_VOTE } else { WHY }));
    }
    out
}

/// `/forum`'s address for a board or thread.
pub fn write_href(urb: &str) -> String {
    format!("/forum?url={}", enc(urb))
}

/// What became of the last post or reply, above the form, and the text it
/// keeps for another try.
fn note_of<'a>(host: &str, w: &Write<'a>) -> (String, &'a str) {
    let to = esc(host);
    match w.note {
        None => (String::new(), ""),
        Some(Note::Posted | Note::Sent | Note::Held) => (
            format!(
                "<p class=\"note ok\" role=\"status\">Sent to {to}. It shows here once {to} takes it in: reload if \
                 it isn't here yet.</p>"
            ),
            "",
        ),
        Some(Note::Closed { body } | Note::CometsOff { body } | Note::Full { body, .. }) => (
            format!("<p class=\"note err\" role=\"alert\">{to} takes no posts from readers without a node on this board, so it wasn't sent.</p>"),
            body.as_str(),
        ),
        Some(Note::Empty) => ("<p class=\"note err\" role=\"alert\">Write something first.</p>".into(), ""),
        Some(Note::Refused { words, body }) => (
            format!("<p class=\"note err\" role=\"alert\">{to} refused this, so it wasn't posted.</p><p class=\"words\">{}</p>", esc(words)),
            body.as_str(),
        ),
        Some(Note::Unanswered { words, body }) => (
            format!(
                "<p class=\"note err\" role=\"alert\">{to} didn't answer, so it may not have been sent. Try again.</p>\
                 <p class=\"words\">{}</p>",
                esc(words)
            ),
            body.as_str(),
        ),
        Some(Note::Failed { words, body }) => (
            format!("<p class=\"note err\" role=\"alert\">The reader couldn't send it.</p><p class=\"words\">{}</p>", esc(words)),
            body.as_str(),
        ),
    }
}

/// Who a post or reply is from, as the host will see it.
fn as_whom(host: &str, w: &Write) -> String {
    let to = esc(host);
    let who = match w.our {
        Some(o) => format!("as <code class=\"who\">{}</code>, the name {to} shows as the author", esc(o)),
        None => format!("as this computer's anonymous reader identity, the name {to} shows as the author"),
    };
    format!("<p class=\"words\">Posted anonymously from this computer {who}. A board takes ten posts and replies an hour from readers without a node.</p>")
}

/// The new post form, on a board that takes them.
fn post_form(p: &Place, w: &Write) -> String {
    let (note, kept) = note_of(&p.host, w);
    format!(
        "<section class=\"write\" aria-labelledby=\"write-h\"><h2 id=\"write-h\">New post</h2>{note}\
         <form class=\"write-form\" method=\"post\" action=\"{action}\">\
         <input name=\"title\" maxlength=\"{TITLE_MAX}\" required aria-label=\"Title\" placeholder=\"Title\">\
         <input name=\"link\" type=\"url\" maxlength=\"{LINK_MAX}\" aria-label=\"Link (optional)\" placeholder=\"Link (optional)\">\
         <textarea name=\"body\" rows=\"4\" maxlength=\"{TEXT_MAX}\" aria-label=\"Text (optional)\" placeholder=\"Text (optional)\">{kept}</textarea>\
         <p><button type=\"submit\">Post to {to}</button></p></form>{whom}</section>",
        action = esc(&write_href(&p.board_url())),
        kept = esc(kept),
        to = esc(&p.host),
        whom = as_whom(&p.host, w),
    )
}

/// The reply form, under a thread on a board that takes replies.
fn reply_form(p: &Place, url: &str, w: &Write) -> String {
    let (note, kept) = note_of(&p.host, w);
    format!(
        "<section class=\"write\" aria-labelledby=\"write-h\"><h2 id=\"write-h\">Reply</h2>{note}\
         <form class=\"write-form\" method=\"post\" action=\"{action}\">\
         <textarea name=\"body\" rows=\"3\" maxlength=\"{TEXT_MAX}\" required aria-label=\"Your reply\" \
         placeholder=\"Reply to this thread\">{kept}</textarea>\
         <p><button type=\"submit\">Reply on {to}</button></p></form>{whom}</section>",
        action = esc(&write_href(url)),
        kept = esc(kept),
        to = esc(&p.host),
        whom = as_whom(&p.host, w),
    )
}

/// A publisher's body, as Markdown, escaped, links mapped into the reader.
fn body_html(body: &str, at: &str) -> String {
    let link = render::link_for(at);
    lossy(main_of(&gateway::render_markdown(body.as_bytes(), at.as_bytes(), &link)))
}

/// The link a link post points at, through the reader's link mapping: an
/// urb:// target opens in the reader, the web in the system browser, and
/// anything else is shown as text only.
fn post_link(url: &str, at: &str) -> String {
    let (href, _) = render::link_for(at)(url.as_bytes());
    if href.is_empty() {
        format!("<p class=\"meta\">{}</p>", esc(url))
    } else {
        format!(
            "<p><a href=\"{}\">{}</a></p>",
            esc(&String::from_utf8_lossy(&href)),
            esc(url)
        )
    }
}

fn who(s: &str) -> String {
    format!("<span class=\"who\">{}</span>", esc(s))
}

fn crumbs(p: &Place) -> String {
    format!(
        "<p class=\"crumbs\"><a href=\"{}\">{}</a> / {}</p>",
        esc(&read_href(&format!("urb://{}", p.host))),
        esc(&p.host),
        p.prefix()
    )
}

fn page(title: &str, url: &str, labels: &[(&str, &str)], inner: &str) -> Shown {
    let main = format!("<style>{CSS}</style>{}{inner}", strip(labels));
    Shown { csp: OWN, html: chrome(title, url, None, &main, false), title: title.chars().take(crate::history::TITLE_MAX).collect() }
}

/// A board, as a list of its threads.
pub fn board_page(p: &Place, b: &Board, w: &Write) -> Shown {
    let url = p.board_url();
    let title = if b.title.trim().is_empty() { p.board.clone() } else { b.title.clone() };
    let mut s = format!("<section class=\"board\">{}<h1>{}</h1>", crumbs(p), esc(&title));
    if !b.description.trim().is_empty() {
        s.push_str(&format!("<p class=\"words\">{}</p>", esc(&b.description)));
    }
    if closed_why(p, w).is_none() {
        s.push_str(&post_form(p, w));
    } else {
        s.push_str(&note_of(&p.host, w).0);
    }
    if b.posts.is_empty() {
        s.push_str("<p class=\"words\">No posts yet.</p>");
    } else {
        s.push_str("<ol class=\"threads\">");
        for post in b.posts.iter().take(LISTED) {
            let t = if post.title.trim().is_empty() { "(untitled)" } else { post.title.as_str() };
            let mut meta = format!("by {} · <time>{}</time>", who(&post.author), when(post.created));
            if let Some(n) = post.replies {
                meta.push_str(&format!(" · {}", plural(n, "reply", "replies")));
            }
            if let Some(n) = post.score {
                meta.push_str(&format!(" · {}", if n.abs() == 1 { format!("{n} point") } else { format!("{n} points") }));
            }
            s.push_str(&format!(
                "<li><a class=\"t\" href=\"{}\">{}</a><div class=\"meta\">{meta}</div></li>",
                esc(&read_href(&p.thread_url(&post.id))),
                esc(t)
            ));
        }
        s.push_str("</ol>");
        if b.posts.len() > LISTED {
            s.push_str(&format!("<p class=\"words\">Showing the newest {LISTED} of {}.</p>", b.posts.len()));
        }
    }
    s.push_str("</section>");
    page(&title, &url, &disabled(p, w, "New post", false), &s)
}

/// A thread: its post, then its comments in order.
pub fn thread_page(p: &Place, t: &Thread, w: &Write) -> Shown {
    let url = p.thread_url(&t.post.id);
    let title = if t.post.title.trim().is_empty() { "(untitled)".to_string() } else { t.post.title.clone() };
    let back = if t.board.trim().is_empty() { p.board.clone() } else { t.board.clone() };
    let mut s = format!(
        "<section class=\"thread\"><p class=\"crumbs\"><a href=\"{}\">&#8249; {}</a></p><div class=\"post\"><h1>{}</h1>\
         <div class=\"meta\">by {} · <time>{}</time>{}</div>",
        esc(&read_href(&p.board_url())),
        esc(&back),
        esc(&title),
        who(&t.post.author),
        when(t.post.created),
        t.post.score.map_or(String::new(), |n| format!(" · {n} points")),
    );
    if let Some(u) = &t.post.url {
        s.push_str(&post_link(u, &url));
    }
    if let Some(b) = &t.post.body {
        s.push_str(&format!("<div class=\"body\">{}</div>", body_html(b, &url)));
    }
    s.push_str("</div>");
    s.push_str(&format!("<h2>{}</h2>", plural(t.comments.len(), "reply", "replies")));
    if !t.comments.is_empty() {
        s.push_str("<ol class=\"comments\">");
        for c in &t.comments {
            let to = match &c.parent {
                Some(par) => format!(" · in reply to <a href=\"#c{0}\">#{0}</a>", esc(par)),
                None => String::new(),
            };
            s.push_str(&format!(
                "<li id=\"c{}\"><div class=\"meta\">{} · <time>{}</time>{to}</div><div class=\"body\">{}</div></li>",
                esc(&c.id),
                who(&c.author),
                when(c.created),
                body_html(&c.body, &url)
            ));
        }
        s.push_str("</ol>");
    }
    match closed_why(p, w) {
        None => s.push_str(&reply_form(p, &url, w)),
        Some(why) => s.push_str(&format!(
            "{}<form class=\"reply\" aria-label=\"Reply\"><textarea rows=\"2\" disabled aria-label=\"Reply\" \
             placeholder=\"{why}\"></textarea><p><button type=\"button\" disabled title=\"{why}\">Reply</button></p></form>",
            note_of(&p.host, w).0
        )),
    }
    s.push_str("</section>");
    page(&title, &url, &disabled(p, w, "Reply", true), &s)
}

/// What a failed board read says. A board that isn't there says so in a
/// board's words; the rest are the reader's words for a page.
pub fn error_page(url: &str, p: &Place, e: &ReadError, step: &str) -> (u16, Shown) {
    match e {
        ReadError::NotPublished(w) => {
            let what = if p.post.is_some() { "post" } else { "board" };
            let main = format!(
                "<section class=\"error\"><h1>No such {what}</h1><p>{} has no {what} here, or it is private. A private \
                 board is read by its members, from a node of their own.</p><p class=\"words\">{}</p></section>",
                esc(&p.host),
                esc(w)
            );
            let title = format!("No such {what}");
            (404, Shown { csp: OWN, html: chrome(&title, url, None, &main, false), title })
        }
        e => render::error_page(url, e, render::Mode::Shipless, step),
    }
}

// ------------------------------------------------------------ reading

/// A forum thread's post id, as its address names it.
pub fn post_id(p: &Place) -> Option<Int> {
    let id = p.post.as_ref().filter(|_| p.app == App::Forum)?;
    match de_urb(&p.thread_url(id)).map(|u| u.mount) {
        Ok(Mount::Forum { post }) => post,
        _ => None,
    }
}

/// The asks that read `p`.
fn asks(p: &Place) -> Vec<BoardAsk> {
    let (host, board) = (p.host.clone(), p.board.clone());
    match (p.app, &p.post) {
        (App::Forum, None) => vec![BoardAsk::Forum { host, board }],
        (App::Forum, Some(id)) => match de_urb(&p.thread_url(id)).map(|u| u.mount) {
            Ok(Mount::Forum { post: Some(post) }) => vec![BoardAsk::ForumThread { host, board, post }],
            _ => Vec::new(),
        },
        (App::Furum, None) => vec![BoardAsk::FurumPosts { host, board }],
        (App::Furum, Some(id)) => vec![
            BoardAsk::FurumPosts { host: host.clone(), board: board.clone() },
            BoardAsk::FurumComments { host, board, post: id.parse().unwrap_or(0) },
        ],
    }
}

/// Read and show `p` (at `url`): the page, or why not.
pub fn read(ctx: &Ctx, url: &str, p: &Place) -> (u16, Shown) {
    let mut got = ctx.reads.boards(asks(p), BUDGET).into_iter();
    // a forum board says whether it takes the reader's posts; a furum
    // board is read only
    let open = match p.app {
        App::Forum => ctx.forum_open(&p.host, &p.board, false),
        App::Furum => None,
    };
    let our = ctx.reads.our();
    let note = ctx.take_note(url);
    let w = Write { open, our: our.as_deref(), note: note.as_ref() };
    let first = match got.next().unwrap_or_else(|| Err(ReadError::Failed("no answer".into()))) {
        // forum.mjs's words for a thread the board lacks
        Err(ReadError::Failed(w)) if w.contains("no post ") => Err(ReadError::NotPublished(w)),
        r => r,
    };
    let shown = first.and_then(|v| match (p.app, &p.post) {
        (App::Forum, None) => Ok(board_page(p, &forum_board(&v), &w)),
        (App::Forum, Some(_)) => forum_thread(&v)
            .map(|t| thread_page(p, &t, &w))
            .ok_or_else(|| ReadError::Failed("the thread couldn't be read".into())),
        (App::Furum, None) => {
            let mut posts = furum_posts(&v);
            let counted: Vec<BoardAsk> = posts
                .iter()
                .take(COUNTED)
                .filter_map(|q| q.id.parse().ok())
                .map(|id| BoardAsk::FurumComments { host: p.host.clone(), board: p.board.clone(), post: id })
                .collect();
            for (q, c) in posts.iter_mut().zip(ctx.reads.boards(counted, BUDGET)) {
                q.replies = c.ok().map(|c| furum_comments(&c).len());
            }
            Ok(board_page(p, &Board { title: p.board.clone(), description: String::new(), posts }, &w))
        }
        (App::Furum, Some(id)) => {
            let post = furum_posts(&v).into_iter().find(|q| &q.id == id).ok_or_else(|| {
                ReadError::NotPublished(format!("no post {id} on {}'s board {}", p.host, p.board))
            })?;
            let comments = got.next().unwrap_or_else(|| Err(ReadError::Failed("no answer".into())))?;
            Ok(thread_page(p, &Thread { board: p.board.clone(), post, comments: furum_comments(&comments) }, &w))
        }
    });
    match shown {
        Ok(s) => {
            if let Err(e) = ctx.history.add(url, &s.title) {
                crate::commands::dlog(&format!("reader: {e}"));
            }
            (200, s)
        }
        Err(e) => {
            crate::commands::dlog(&format!("reader: {url}: {e:?}"));
            error_page(url, p, &e, ctx.reads.step())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place_of(u: &str) -> Place {
        place(u).unwrap_or_else(|| panic!("{u}"))
    }

    fn hostile() -> &'static str {
        "<script>alert(1)</script><img src=x onerror=alert(2)> [x](javascript:alert(3)) \"'&"
    }

    #[test]
    fn board_and_thread_addresses_are_told_apart() {
        let b = place_of("urb://~wep/forum/general");
        assert_eq!((b.app, b.host.as_str(), b.board.as_str(), b.post.clone()), (App::Forum, "~wep", "general", None));
        assert_eq!(place_of("urb://~wep/forum/general/12").post.as_deref(), Some("12"));
        assert_eq!(place_of("urb://~wep/forum/general/1.000").post.as_deref(), Some("1000"));
        let f = place_of("urb://~rup/furum/m1c/3");
        assert_eq!((f.app, f.board.as_str(), f.post.as_deref()), (App::Furum, "m1c", Some("3")));
        assert_eq!(place_of("urb://~rup/furum/m1c").post, None);
        for no in [
            "urb://~wep/forum",
            "urb://~wep/page",
            "urb://~wep/furum",
            "urb://~rup/furum/m1c/03",
            "urb://~rup/furum/m1c/x",
            "urb://~rup/furum/m1c/9007199254740993",
            "urb://~rup/furum/m1c/1/2",
            "https://example.com/forum/x",
        ] {
            assert_eq!(place(no), None, "{no}");
        }
        assert_eq!(b.thread_url("7"), "urb://~wep/forum/general/7");
        assert_eq!(b.thread_url("1000"), "urb://~wep/forum/general/1.000");
        assert_eq!(b.thread_url("1234567"), "urb://~wep/forum/general/1.234.567");
        assert_eq!(place_of(&b.thread_url("1234567")).post.as_deref(), Some("1234567"));
        assert_eq!(f.thread_url("1000"), "urb://~rup/furum/m1c/1000");
        assert_eq!(f.board_url(), "urb://~rup/furum/m1c");
    }

    fn forum_js() -> Js {
        let post = |id: f64, title: &str, body: Option<&str>, n: f64| {
            Js::obj([
                ("id", Js::Num(id)),
                ("author", Js::Str("~sampel-palnet".into())),
                ("title", Js::Str(title.into())),
                ("url", Js::Null),
                ("body", Js::text(body.map(Into::into))),
                ("created", Js::Date(Some(1_762_178_700_000))),
                ("up", Js::Arr(vec![Js::Str("~zod".into()), Js::Str("~bus".into())])),
                ("down", Js::Arr(vec![])),
                ("comments", Js::Num(n)),
            ])
        };
        Js::obj([
            ("info", Js::obj([("title", Js::Str("General <b>talk</b>".into())), ("description", Js::Str("All & sundry".into()))])),
            ("posts", Js::Arr(vec![post(2.0, hostile(), None, 1.0), post(1.0, "Hello", Some("hi"), 0.0)])),
        ])
    }

    #[test]
    fn a_board_lists_its_threads_escaped_with_their_details() {
        let p = place_of("urb://~wep/forum/general");
        let b = forum_board(&forum_js());
        assert_eq!(b.posts.len(), 2);
        assert_eq!((b.posts[0].replies, b.posts[0].score), (Some(1), Some(2)));
        let s = board_page(&p, &b, &Write::default());
        assert_eq!(s.csp, OWN);
        assert_eq!(s.title, "General <b>talk</b>");
        let h = &s.html;
        assert!(h.contains("<h1>General &lt;b&gt;talk&lt;/b&gt;</h1>"), "{h}");
        assert!(h.contains("All &amp; sundry"));
        assert!(h.contains("href=\"/read?url=urb%3A%2F%2F~wep%2Fforum%2Fgeneral%2F2\""), "{h}");
        assert!(h.contains("href=\"/read?url=urb%3A%2F%2F~wep%2Fforum%2Fgeneral%2F1\""));
        assert!(h.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(!h.contains("<script>alert") && !h.contains("<img"), "{h}");
        assert!(h.contains("by <span class=\"who\">~sampel-palnet</span> · <time>2025-11-03 14:05 UTC</time> · 1 reply · 2 points"), "{h}");
        assert!(h.contains("0 replies"));
        assert!(h.contains("<button type=\"button\" disabled title=\"Connect a node to post\""));
        assert!(h.contains(">New post</button>"));
        assert!(!h.contains("<form method=\"post\""), "no write form");
    }

    #[test]
    fn a_board_that_takes_comet_posts_offers_the_forms_but_never_a_vote() {
        let open = Write { open: Some(true), our: Some("~doznec-sampel-palnet"), note: None };
        let p = place_of("urb://~wep/forum/general");
        let h = board_page(&p, &forum_board(&forum_js()), &open).html;
        assert!(h.contains("<form class=\"write-form\" method=\"post\" action=\"/forum?url=urb%3A%2F%2F~wep%2Fforum%2Fgeneral\">"), "{h}");
        assert!(h.contains("name=\"title\"") && h.contains("name=\"link\"") && h.contains(">Post to ~wep</button>"), "{h}");
        assert!(h.contains("<code class=\"who\">~doznec-sampel-palnet</code>, the name ~wep shows as the author"), "{h}");
        assert!(!h.contains(">New post</button>"), "no disabled New post");
        let t = place_of("urb://~wep/forum/general/4");
        let h = thread_page(&t, &thread_with("x", "y", None), &open).html;
        assert!(h.contains("action=\"/forum?url=urb%3A%2F%2F~wep%2Fforum%2Fgeneral%2F4\"") && h.contains(">Reply on ~wep</button>"), "{h}");
        assert!(!h.contains("<textarea rows=\"2\" disabled"), "{h}");
        assert!(h.contains(&format!("disabled title=\"{NO_VOTE}\"")) && h.contains(">Vote</button>"), "{h}");
        // what became of the last one, and its text kept on a refusal
        let n = Note::Refused { words: "<no>".into(), body: "my <text>".into() };
        let h = thread_page(&t, &thread_with("x", "y", None), &Write { note: Some(&n), ..open }).html;
        assert!(h.contains("~wep refused this") && h.contains("&lt;no&gt;") && h.contains(">my &lt;text&gt;</textarea>"), "{h}");
        let h = board_page(&p, &Board::default(), &Write { note: Some(&Note::Sent), ..open }).html;
        assert!(h.contains("Sent to ~wep."), "{h}");
    }

    #[test]
    fn a_board_closed_to_comets_or_silent_or_furum_stays_read_only() {
        let p = place_of("urb://~wep/forum/general/4");
        let closed = Write { open: Some(false), ..Write::default() };
        let h = thread_page(&p, &thread_with("x", "y", None), &closed).html;
        assert!(h.contains(&format!("disabled title=\"{CLOSED}\">Reply</button>")) && !h.contains("write-form"), "{h}");
        let h = thread_page(&p, &thread_with("x", "y", None), &Write::default()).html;
        assert!(h.contains(&format!("disabled title=\"{WHY}\">Reply</button>")) && !h.contains("write-form"), "{h}");
        assert!(h.contains(&format!("disabled title=\"{NO_VOTE}\"")), "{h}");
        // a furum board takes no writes, whatever it is told
        let f = place_of("urb://~rup/furum/m1c/4");
        let h = thread_page(&f, &thread_with("x", "y", None), &Write { open: Some(true), ..Write::default() }).html;
        assert!(!h.contains("write-form") && h.contains(&format!("disabled title=\"{WHY}\" aria-describedby=\"why-vote\">Vote</button>")), "{h}");
        assert_eq!(post_id(&place_of("urb://~wep/forum/general/1.000")).map(|i| i.decimal()), Some("1000".into()));
        assert_eq!(post_id(&f), None);
    }

    #[test]
    fn an_empty_board_says_so() {
        let p = place_of("urb://~rup/furum/m1c");
        let s = board_page(&p, &Board { title: "m1c".into(), ..Board::default() }, &Write::default());
        assert!(s.html.contains("No posts yet."));
        assert!(s.html.contains("<h1>m1c</h1>"));
    }

    fn thread_with(body: &str, comment: &str, url: Option<&str>) -> Thread {
        Thread {
            board: "General".into(),
            post: Post {
                id: "4".into(),
                title: "A <i>thread</i>".into(),
                author: "~zod\"><x>".into(),
                created: Some(0),
                url: url.map(Into::into),
                body: Some(body.into()),
                replies: Some(2),
                score: Some(-1),
            },
            comments: vec![
                Comment { id: "0".into(), parent: None, author: "~bus".into(), body: "first".into(), created: Some(1000) },
                Comment { id: "1".into(), parent: Some("0".into()), author: "~nec".into(), body: comment.into(), created: None },
            ],
        }
    }

    #[test]
    fn a_thread_shows_its_post_then_its_comments_in_order() {
        let p = place_of("urb://~wep/forum/general/4");
        let s = thread_page(&p, &thread_with("**bold** and [a page](urb://~wep/other)", "second", None), &Write::default());
        let h = &s.html;
        assert_eq!(s.title, "A <i>thread</i>");
        assert!(h.contains("<h1>A &lt;i&gt;thread&lt;/i&gt;</h1>"));
        assert!(h.contains("<strong>bold</strong>"), "{h}");
        assert!(h.contains("href=\"/read?url=urb%3A%2F%2F~wep%2Fother\""), "{h}");
        assert!(h.contains("&lt;x&gt;") && !h.contains("<x>"));
        let (first, second) = (h.find("first").unwrap(), h.find("second").unwrap());
        assert!(first < second, "oldest first");
        assert!(h.contains("in reply to <a href=\"#c0\">#0</a>"));
        assert!(h.contains("<time>1970-01-01 00:00 UTC</time>"));
        assert!(h.contains("<time>no date</time>"));
        assert!(h.contains("2 replies"));
        // back to the board, in the reader
        assert!(h.contains("href=\"/read?url=urb%3A%2F%2F~wep%2Fforum%2Fgeneral\">&#8249; General</a>"), "{h}");
        assert!(h.contains(">Reply</button>") && h.contains(">Vote</button>"));
        assert!(h.contains("<textarea rows=\"2\" disabled"));
        assert!(!h.contains("method=\"post\""));
    }

    #[test]
    fn hostile_bodies_and_links_are_escaped() {
        let p = place_of("urb://~rup/furum/m1c/4");
        for url in ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "https://example.com/\"><script>"] {
            let s = thread_page(&p, &thread_with(hostile(), hostile(), Some(url)), &Write::default());
            let h = &s.html;
            let main = &h[h.find("<main").unwrap()..];
            assert!(!main.contains("<script"), "{url}: {main}");
            assert!(!main.contains("<img"), "{url}: {main}");
            assert!(!main.contains("href=\"javascript:"), "{url}: {main}");
            assert!(!main.contains("href=\"data:"), "{url}: {main}");
            assert!(main.contains("&lt;img src=x onerror=alert(2)&gt;"), "{url}: {main}");
        }
        let s = thread_page(&p, &thread_with("x", "y", Some("https://example.com/a")), &Write::default());
        assert!(s.html.contains("<a href=\"https://example.com/a\">https://example.com/a</a>"), "{}", s.html);
        let s = thread_page(&p, &thread_with("x", "y", Some("urb://~rup/notes")), &Write::default());
        assert!(s.html.contains("href=\"/read?url=urb%3A%2F%2F~rup%2Fnotes\""), "{}", s.html);
    }

    #[test]
    fn furum_values_read_as_posts_and_comments() {
        let posts = Js::Arr(vec![
            Js::obj([
                ("id", Js::Num(1.0)),
                ("author", Js::Str("~hus".into())),
                ("title", Js::Str("t".into())),
                ("url", Js::Null),
                ("body", Js::Null),
                ("created", Js::Date(None)),
            ]),
            Js::obj([("title", Js::Str("no id".into()))]),
            Js::Str("junk".into()),
        ]);
        let ps = furum_posts(&posts);
        assert_eq!(ps.len(), 1);
        assert_eq!((ps[0].id.as_str(), ps[0].replies, ps[0].score, ps[0].created), ("1", None, None, None));
        let cs = furum_comments(&Js::Arr(vec![Js::obj([
            ("id", Js::Num(0.0)),
            ("parent", Js::Null),
            ("author", Js::Str("~rup".into())),
            ("body", Js::Str("c".into())),
            ("created", Js::Date(Some(5))),
        ])]));
        assert_eq!(cs, vec![Comment { id: "0".into(), parent: None, author: "~rup".into(), body: "c".into(), created: Some(5) }]);
        assert!(furum_comments(&Js::Null).is_empty());
        assert!(forum_thread(&Js::Null).is_none());
    }

    /// Real reads on the fleet, as a fake moon: run by
    /// scripts/desktop-forum-fleet.sh on the furum set's m1c-traces
    /// snapshot, a furum board on ~rup and a lattice forum on ~hus. Each
    /// board (`FLEET_BOARDS`, `url|text` with text the board's first
    /// thread shows) is read, then that thread. Plain `cargo test` skips
    /// it as ignored.
    #[test]
    #[ignore = "needs a fleet ship: scripts/desktop-forum-fleet.sh"]
    fn the_reader_reads_fleet_boards() {
        if std::env::var("LATTICE_FLEET").as_deref() != Ok("1") {
            eprintln!("skipped: LATTICE_FLEET=1 is not set (run scripts/desktop-forum-fleet.sh)");
            return;
        }
        let boards = std::env::var("FLEET_BOARDS").expect("FLEET_BOARDS");
        let parent = std::env::var("FLEET_PARENT").expect("FLEET_PARENT");
        let tmp = std::env::temp_dir().join(format!("forum-fleet-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let engine = crate::engine::Engine::fake(tmp.join("urb"), &format!("new-moon-of:{parent}"));
        let ctx = Ctx::new(Box::new(engine.clone()), crate::history::History::open(&tmp), 1);
        for spec in boards.split_whitespace() {
            let (url, want) = spec.split_once('|').expect("url|text");
            let want = want.replace('+', " ");
            let p = place(url).expect("a board address");
            let t = std::time::Instant::now();
            let (mut status, mut s) = read(&ctx, url, &p);
            // the first read waits out the engine's start and first contact
            while (status == 503 || status == 504) && t.elapsed() < Duration::from_secs(180) {
                std::thread::sleep(Duration::from_secs(2));
                (status, s) = read(&ctx, url, &p);
            }
            eprintln!("{url}: {status} \"{}\" in {:?} as {:?}", s.title, t.elapsed(), crate::engine::Reads::our(&engine));
            assert_eq!(status, 200, "{}", s.html);
            assert!(s.html.contains("<ol class=\"threads\">"), "{}", s.html);
            assert!(s.html.contains(">New post</button>"));
            // the first thread's link, as the board gives it
            let mark = format!("href=\"{}%2F", read_href(&p.board_url()));
            let at = s.html.find(&mark).expect("a thread link") + mark.len();
            let id: String = s.html[at..].chars().take_while(char::is_ascii_digit).collect();
            let thread = p.thread_url(&id);
            let t = std::time::Instant::now();
            let (status, s) = read(&ctx, &thread, &place(&thread).unwrap());
            eprintln!("{thread}: {status} \"{}\" in {:?}", s.title, t.elapsed());
            assert_eq!(status, 200, "{}", s.html);
            assert!(s.html.contains(&want), "{want}: {}", s.html);
            assert!(s.html.contains(&read_href(&p.board_url())), "back to the board");
            assert!(s.html.contains(">Reply</button>"));
            let missing = p.thread_url("99999");
            assert!(place(&missing).is_some(), "{missing}");
            let (status, s) = read(&ctx, &missing, &place(&missing).unwrap());
            eprintln!("{missing}: {status} \"{}\"", s.title);
            assert_ne!(status, 200);
            let recent: Vec<String> = ctx.history.list().into_iter().map(|e| e.url).collect();
            assert!(recent.iter().any(|u| u == url) && recent.contains(&thread), "{recent:?}");
        }
        engine.close();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A real post and reply on the fleet, as a comet on the fake network:
    /// `FLEET_AS` names the comet, `FLEET_FORUM` a public lattice forum
    /// board whose host lists it in `/pub/forum-comets`. The comet starts
    /// a post, then replies in its thread, and both are read back from the
    /// host with the comet as their author. Plain `cargo test` skips it.
    #[test]
    #[ignore = "needs a fleet ship running this branch"]
    fn a_comet_posts_and_replies_on_a_fleet_board() {
        use crate::engine::{ForumWrite, Reads};
        if std::env::var("LATTICE_FLEET").as_deref() != Ok("1") {
            eprintln!("skipped: LATTICE_FLEET=1 is not set");
            return;
        }
        // `new-comet`: a comet no run has used, as the fake network takes
        // any name
        let who = match std::env::var("FLEET_AS").expect("FLEET_AS") {
            w if w == "new-comet" => {
                let r = urb_engine::host::net::random(16);
                let half = |b: &[u8]| u64::from_le_bytes(b.try_into().unwrap());
                urb_engine::engine::ship_text((half(&r[..8]), half(&r[8..]).max(1)))
            }
            w => w,
        };
        let url = std::env::var("FLEET_FORUM").expect("FLEET_FORUM");
        let p = place(&url).expect("a board address");
        let tmp = std::env::temp_dir().join(format!("forum-post-fleet-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let engine = crate::engine::Engine::fake(tmp.join("urb"), &who);
        let ctx = Ctx::new(Box::new(engine.clone()), crate::history::History::open(&tmp), 1);
        let t = std::time::Instant::now();
        let (mut status, mut s) = read(&ctx, &url, &p);
        while status != 200 && t.elapsed() < Duration::from_secs(180) {
            std::thread::sleep(Duration::from_secs(2));
            (status, s) = read(&ctx, &url, &p);
        }
        let our = engine.our().expect("running");
        eprintln!("{url}: {status} as {our} in {:?}", t.elapsed());
        assert_eq!(status, 200, "{}", s.html);
        assert_eq!(ctx.forum_open(&p.host, &p.board, true), Some(true), "the host lists the board");
        let (_, s) = read(&ctx, &url, &p);
        assert!(s.html.contains("write-form"), "{}", s.html);
        let title = format!("comet post {}", std::process::id());
        let w = ForumWrite::Post { board: p.board.clone(), title: title.clone(), url: None, body: Some("from a comet".into()) };
        engine.forum_write(&p.host, w, Duration::from_secs(30)).expect("the post was taken in");
        // the post lands, by the comet
        let t = std::time::Instant::now();
        let post = loop {
            let b = ctx.reads.boards(vec![BoardAsk::Forum { host: p.host.clone(), board: p.board.clone() }], BUDGET);
            if let Some(Ok(v)) = b.first() {
                if let Some(q) = forum_board(v).posts.into_iter().find(|q| q.title == title) {
                    break q;
                }
            }
            assert!(t.elapsed() < Duration::from_secs(60), "the post never landed");
            std::thread::sleep(Duration::from_secs(2));
        };
        eprintln!("post {} by {} in {:?}", post.id, post.author, t.elapsed());
        assert_eq!(post.author, our);
        // a ship that is not a comet meets the host's per-ship cooldown
        // (ten seconds after its last write); a comet meets the board's gate
        if !our.contains("--") {
            std::thread::sleep(Duration::from_secs(12));
        }
        let thread = p.thread_url(&post.id);
        let tp = place(&thread).unwrap();
        let w = ForumWrite::Reply { board: p.board.clone(), post: post_id(&tp).unwrap(), parent: None, body: "a comet reply".into() };
        engine.forum_write(&p.host, w, Duration::from_secs(30)).expect("the reply was taken in");
        let t = std::time::Instant::now();
        loop {
            let (status, s) = read(&ctx, &thread, &tp);
            if status == 200 && s.html.contains("a comet reply") {
                assert!(s.html.contains(&format!("<span class=\"who\">{our}</span>")), "{}", s.html);
                assert!(s.html.contains(&format!("disabled title=\"{NO_VOTE}\"")));
                break;
            }
            assert!(t.elapsed() < Duration::from_secs(60), "the reply never landed: {}", s.html);
            std::thread::sleep(Duration::from_secs(2));
        }
        eprintln!("reply landed in {:?}", t.elapsed());
        engine.close();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_missing_board_or_post_says_so_plainly() {
        let p = place_of("urb://~wep/forum/gone");
        let (status, s) = error_page(&p.board_url(), &p, &ReadError::NotPublished("<b>no</b>".into()), "");
        assert_eq!(status, 404);
        assert!(s.html.contains("<h1>No such board</h1>"));
        assert!(s.html.contains("&lt;b&gt;no&lt;/b&gt;"));
        let p = place_of("urb://~wep/forum/gone/3");
        let (_, s) = error_page("urb://~wep/forum/gone/3", &p, &ReadError::NotPublished("x".into()), "");
        assert!(s.html.contains("No such post"));
        let (status, s) = error_page("u", &p, &ReadError::Unreachable { later: true, words: "w".into() }, "");
        assert_eq!(status, 504);
        assert!(s.html.contains("didn't answer"));
    }
}
