//! The shipless reader's pages: a page the engine read, rendered by
//! urb-render's gateway renderers inside the reader's own chrome, and the
//! reader's home and error pages.
//!
//! The rules are the gateway's. Gemtext, Markdown and text are rendered
//! here, escaped, under a policy with no script but the reader's own
//! (`OWN`). A publisher's HTML is never put in the reader's page: it goes in
//! a sandboxed frame whose `/raw` source is served under lattice's
//! `+sandbox-csp`, an opaque origin with no reach into the reader or the
//! app. Only `render_as`, by the published mark (`%gmi` sniffed for HTML),
//! decides which.
//!
//! Links are urb-render's `page_link`, with its hostile-input filtering,
//! then every urb:// target is pointed at `/read?url=...`, so links stay in
//! the app. http and https leave for the system browser (the app's
//! navigation policy, commands.rs). A published page gets a comment box,
//! which comments as the reader's own anonymous identity (the comet); every
//! action that needs a node of one's own (bookmarks, follows, hosting) is
//! shown and disabled with its reason.


use urb_render::gateway;

use crate::engine::{CometMode, NativePage, ReadError};
use crate::history::Entry;

/// The start list's address: a page the owner keeps, read live on the
/// reader's home, with a copy compiled in for the first run and for when
/// it cannot be read.
pub const START_URL: &str = "urb://~nisfeb/start";
/// The compiled-in copy of the start list.
pub const START: &str = include_str!("../ui-reader/start.gmi");

/// The policy for the reader's own pages: its stylesheet inline, its one
/// script file, nothing else, and never framed.
pub const OWN: &str =
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'";
/// The same, for the page around a publisher's HTML: it may frame `/raw`.
pub const FRAMED: &str = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; frame-src 'self'; \
     frame-ancestors 'none'; base-uri 'none'";
/// A publisher's HTML (`/raw`): lattice's `+sandbox-csp`.
pub const SANDBOX: &str = gateway::SANDBOX;
/// The frame's sandbox attribute: the same four allowances.
pub const FRAME_SANDBOX: &str =
    "allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation";

/// The reader's stylesheet and script, compiled in.
pub const CSS: &str = include_str!("../ui-reader/reader.css");
pub const JS: &str = include_str!("../ui-reader/reader.js");

/// The port page_link is given. Its gateway urls never leave this file:
/// each one is mapped back to the urb:// address it names.
const LINK_PORT: &str = "1";

/// Why the node actions are disabled. One reason today: the app is used
/// anonymously, with no node configured. (Slice 2's "your ship isn't
/// answering" is deferred.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Shipless,
}

/// The actions a reader page shows disabled, with their reasons: each
/// needs a node of one's own. Commenting is not one of them.
pub fn actions(mode: Mode) -> [(&'static str, &'static str); 3] {
    match mode {
        Mode::Shipless => [
            ("Bookmark", "Connect a node to bookmark"),
            ("Follow", "Connect a node to follow"),
            ("Host", "Hosting pages needs a node"),
        ],
    }
}

/// The longest comment lattice keeps (`max-body` in lattice-comment.hoon),
/// in bytes. A longer one is cut here, as lattice would cut it.
pub const COMMENT_MAX: usize = 4096;

/// What became of the comment just sent, shown once above the box.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Note {
    /// the publisher's ship took it in, and its page takes comments
    Posted,
    /// the publisher's ship took it in, and whether its page takes
    /// comments is not known (a lattice too old to say)
    Sent,
    /// the publisher's ship took it in, to review before it appears (the
    /// page holds comets' comments)
    Held,
    /// the page stopped taking comments; nothing was sent, the text is kept
    Closed { body: String },
    /// the page stopped taking comets' comments; nothing was sent, the
    /// text is kept
    CometsOff { body: String },
    /// the page is at its cap of comets' comments, for `mins` more
    /// minutes: nothing was sent, or what was sent was turned away; the
    /// text is kept
    Full { mins: u64, body: String },
    /// nothing was written
    Empty,
    /// the publisher's ship refused it, in its words; the text is kept
    Refused { words: String, body: String },
    /// no answer; the text is kept
    Unanswered { words: String, body: String },
    /// the reader could not send it; the text is kept
    Failed { words: String, body: String },
}

/// Does the page take comments, by its publisher's `/pub/comments`?
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Open {
    /// the publisher did not say (an older lattice, or no answer): the
    /// box is offered, and a comment is only "sent"
    #[default]
    Unknown,
    Yes,
    No,
}

/// The comment box on a page: who comments (the reader identity's name),
/// whether the page takes comments, and the note for the comment just sent.
/// The reader is always a comet, so the page's comet policy (`/pub/comets`)
/// always applies: its mode, and whether it is at its cap now.
#[derive(Clone, Copy, Debug, Default)]
pub struct Talk<'a> {
    pub our: Option<&'a str>,
    pub note: Option<&'a Note>,
    pub open: Open,
    pub comets: CometMode,
    /// the minutes until the page's cap of comets' comments frees, while
    /// it is at the cap
    pub full: Option<u64>,
}

/// The publisher a comment on `url` goes to: a published page's ship. A
/// know entry (`/k/`) or a file in someone's tree (`/t/`) takes none.
pub fn commentable(url: &str) -> Option<String> {
    let u = urb_engine::url::de_urb(url).ok()?;
    matches!(u.mount, urb_engine::url::Mount::N).then_some(u.ship)
}

/// `/comment`'s address for a page.
pub fn comment_href(urb: &str) -> String {
    format!("/comment?url={}", enc(urb))
}

/// What a page at its cap of comets' comments says, `mins` minutes
/// before the cap frees.
pub fn full_words(mins: u64) -> String {
    format!("Too many anonymous comments here right now, try again in {} min", mins.max(1))
}

/// The comment box, under the page.
fn talk_box(url: &str, ship: &str, talk: &Talk) -> String {
    let to = esc(ship);
    let (note, kept) = match talk.note {
        None => (String::new(), ""),
        Some(Note::Posted) => (format!("<p class=\"note ok\" role=\"status\">Posted to {to}.</p>"), ""),
        Some(Note::Held) => (format!("<p class=\"note ok\" role=\"status\">Sent to {to} for review.</p>"), ""),
        Some(Note::CometsOff { body }) => (
            format!(
                "<p class=\"note err\" role=\"alert\">{to} has turned anonymous comments off on this page, so it \
                 wasn't sent.</p>"
            ),
            body.as_str(),
        ),
        Some(Note::Full { mins, body }) => (
            format!(
                "<p class=\"note err\" role=\"alert\">{}. Your comment wasn't posted.</p>",
                full_words(*mins)
            ),
            body.as_str(),
        ),
        Some(Note::Closed { body }) => (
            format!("<p class=\"note err\" role=\"alert\">{to} has turned comments off on this page, so it wasn't sent.</p>"),
            body.as_str(),
        ),
        Some(Note::Sent) => (
            format!(
                "<p class=\"note ok\" role=\"status\">Sent to {to}. {to} decides whether it appears: it won't if they \
                 haven't turned on comments for this page.</p>"
            ),
            "",
        ),
        Some(Note::Empty) => ("<p class=\"note err\" role=\"alert\">Write something first.</p>".into(), ""),
        Some(Note::Refused { words, body }) => (
            format!(
                "<p class=\"note err\" role=\"alert\">{to} refused this comment, so it wasn't posted.</p>\
                 <p class=\"words\">{}</p>",
                esc(words)
            ),
            body.as_str(),
        ),
        Some(Note::Unanswered { words, body }) => (
            format!(
                "<p class=\"note err\" role=\"alert\">{to} didn't answer, so your comment may not have been sent. \
                 Try again.</p><p class=\"words\">{}</p>",
                esc(words)
            ),
            body.as_str(),
        ),
        Some(Note::Failed { words, body }) => (
            format!(
                "<p class=\"note err\" role=\"alert\">The reader couldn't send your comment.</p><p class=\"words\">{}</p>",
                esc(words)
            ),
            body.as_str(),
        ),
    };
    let off = if talk.open == Open::No {
        Some("Comments are off on this page.".to_string())
    } else if talk.comets == CometMode::Off {
        Some("Anonymous comments are off on this page.".to_string())
    } else {
        talk.full.map(|m| format!("{}.", full_words(m)))
    };
    if let Some(off) = off {
        // the note's text, when there is one, is kept for the reader to copy
        let kept = if kept.is_empty() {
            String::new()
        } else {
            format!("<textarea rows=\"3\" readonly aria-label=\"Your comment\">{}</textarea>", esc(kept))
        };
        return format!(
            "<section class=\"talk\" aria-labelledby=\"talk-h\"><h2 id=\"talk-h\">Comment</h2>{note}{kept}\
             <p class=\"words talk-off\">{off}</p></section>"
        );
    }
    let (verb, done, decide) = match (talk.open, talk.comets) {
        (_, CometMode::Held) => ("Send", "Sent", " Anonymous comments are reviewed before they appear."),
        (Open::Yes, _) => ("Post", "Posted", ""),
        _ => ("Send", "Sent", " They decide whether it appears."),
    };
    let who = match talk.our {
        Some(o) => format!("as <code class=\"who\">{}</code>, the name {to} sees as the author", esc(o)),
        None => format!("as this computer's anonymous reader identity, the name {to} sees as the author"),
    };
    format!(
        "<section class=\"talk\" aria-labelledby=\"talk-h\"><h2 id=\"talk-h\">Comment</h2>{note}\
         <form class=\"talk-form\" method=\"post\" action=\"{action}\">\
         <textarea name=\"body\" rows=\"3\" maxlength=\"{COMMENT_MAX}\" required aria-label=\"Your comment\" \
         placeholder=\"Say something to {to}\">{kept}</textarea>\
         <p><button type=\"submit\">{verb} to {to}</button></p></form>\
         <p class=\"words\">{done} anonymously from this computer {who}.{decide}</p></section>",
        action = esc(&comment_href(url)),
        kept = esc(kept),
    )
}

/// Percent-encode everything but RFC 3986's unreserved characters.
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Where the reader shows an urb:// address.
pub fn read_href(urb: &str) -> String {
    format!("/read?url={}", enc(urb))
}

pub(crate) fn esc(s: &str) -> String {
    String::from_utf8(gateway::html_escape(s.as_bytes())).unwrap_or_default()
}

/// The urb:// address a gateway url (as page_link writes it) names.
fn urb_of_gateway(href: &[u8]) -> Option<Vec<u8>> {
    let rest = href.strip_prefix(b"http://")?;
    let slash = rest.iter().position(|&b| b == b'/').unwrap_or(rest.len());
    let (authority, path) = rest.split_at(slash);
    let host = authority.strip_suffix(format!(":{LINK_PORT}").as_bytes())?;
    let path = if path.is_empty() { &b"/"[..] } else { path };
    gateway::urb_of_host(host, path)
}

/// Where a link on the page at `page` goes, as `(href, own)`: urb-render's
/// `page_link`, its urb:// targets (absolute or relative) pointed at the
/// reader, the web, gemini and mail kept as they are, anything else no
/// link at all (the text alone).
pub fn link_for(page: &str) -> impl Fn(&[u8]) -> (Vec<u8>, bool) + '_ {
    move |target| {
        let (href, own) = gateway::page_link(page.as_bytes(), LINK_PORT)(target);
        if !own {
            return (href, false);
        }
        match urb_of_gateway(&href) {
            Some(u) => (read_href(&String::from_utf8_lossy(&u)).into_bytes(), true),
            None => (Vec::new(), false),
        }
    }
}

/// n random hex digits, from the OS
fn nonce() -> String {
    use std::io::Read;
    let mut b = [0u8; 12];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .expect("no OS randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A publisher's HTML for the sandboxed frame: its urb:// links (as the
/// gateway rewrites them) pointed at the reader, and a `<base
/// target="_top">` so a click on one opens in the reader rather than inside
/// the frame. The gateway's rewrite is given a port no publisher can guess,
/// so only the links it rewrote carry it.
pub fn raw_html(body: &[u8]) -> Vec<u8> {
    let port = nonce();
    let out = gateway::rewrite_html(body, &port);
    let mark = format!("{}:{port}", gateway::HOST_SUFFIX);
    let mark = mark.as_bytes();
    let mut done = Vec::with_capacity(out.len() + 32);
    let mut last = 0;
    let mut i = 0;
    while let Some(at) = find(&out[i..], mark).map(|n| n + i) {
        // back over the ship's name to the http:// the rewrite wrote
        let mut s = at;
        while s > 0 && (out[s - 1].is_ascii_lowercase() || out[s - 1] == b'-') {
            s -= 1;
        }
        if s >= 7 && &out[s - 7..s] == b"http://" {
            done.extend_from_slice(&out[last..s - 7]);
            done.extend_from_slice(b"/read?url=urb://~");
            done.extend_from_slice(&out[s..at]);
            last = at + mark.len();
        }
        i = at + mark.len();
    }
    done.extend_from_slice(&out[last..]);
    with_base(&done)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// `<base target="_top">`, after a leading doctype so the document keeps
/// its mode
fn with_base(html: &[u8]) -> Vec<u8> {
    let base = b"<base target=\"_top\">";
    let lead = html.iter().take_while(|b| b.is_ascii_whitespace()).count();
    let at = if html[lead..].len() >= 9 && html[lead..lead + 9].eq_ignore_ascii_case(b"<!doctype") {
        html[lead..].iter().position(|&b| b == b'>').map_or(0, |n| lead + n + 1)
    } else {
        0
    };
    [&html[..at], base, &html[at..]].concat()
}

/// The page's title: its first `# ` heading in gemtext or Markdown, else
/// its address, as lattice's reader titles it.
pub fn title_of(url: &str, kind: &str, body: &str) -> String {
    if kind == "gmi" || kind == "md" {
        for line in body.lines() {
            if let Some(t) = line.strip_prefix("# ") {
                let t = t.trim();
                if !t.is_empty() {
                    return t.chars().take(crate::history::TITLE_MAX).collect();
                }
            }
        }
    }
    url.to_string()
}

/// What urb-render's page() put inside `<main>`.
pub(crate) fn main_of(doc: &[u8]) -> &[u8] {
    let start = find(doc, b"<main>").map_or(0, |n| n + 6);
    let end = doc.windows(7).rposition(|w| w == b"</main>").unwrap_or(doc.len());
    if start <= end {
        &doc[start..end]
    } else {
        doc
    }
}

/// The reader's document around `main`.
pub(crate) fn chrome(title: &str, url: &str, mode: Option<Mode>, main: &str, refresh: bool) -> String {
    let strip = mode.map_or(String::new(), |m| {
        let mut s = String::from("<div class=\"actions\" role=\"group\" aria-label=\"Actions that need a node\">");
        for (label, why) in actions(m) {
            s.push_str(&format!(
                "<span class=\"act\"><button type=\"button\" disabled title=\"{why}\" aria-describedby=\"why-{l}\">{label}</button>\
                 <span class=\"why\" id=\"why-{l}\">{why}</span></span>",
                l = label.to_ascii_lowercase()
            ));
        }
        s.push_str("</div>");
        s
    });
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">{refresh}<title>{title}</title>\
<style>{CSS}</style><script src=\"/assets/reader.js\" defer></script></head>\
<body><header class=\"bar\"><nav>\
<button type=\"button\" class=\"nav\" data-go=\"back\" title=\"Back\" aria-label=\"Back\">&#8249;</button>\
<button type=\"button\" class=\"nav\" data-go=\"forward\" title=\"Forward\" aria-label=\"Forward\">&#8250;</button>\
<button type=\"button\" class=\"nav\" data-go=\"reload\" title=\"Reload\" aria-label=\"Reload\">&#8635;</button>\
<a class=\"home\" href=\"/\">Home</a></nav>\
<form class=\"addr\" action=\"/read\" method=\"get\"><input name=\"url\" value=\"{url}\" aria-label=\"Address\" \
placeholder=\"urb://~ship/page\" spellcheck=\"false\" autocomplete=\"off\"><button type=\"submit\">Open</button></form>\
<a class=\"connect\" href=\"/connect\">Connect a node</a></header>{strip}<main class=\"page\">{main}</main></body></html>",
        refresh = if refresh { "<meta http-equiv=\"refresh\" content=\"1\">" } else { "" },
        title = esc(title),
        url = esc(url),
    )
}

/// A page the reader shows, with its policy.
pub struct Shown {
    pub csp: &'static str,
    pub html: String,
    pub title: String,
}

/// A page the engine read, in the reader. `raw_key` names this read for
/// the frame's `/raw` request, when the page is a publisher's HTML. A
/// published page gets the comment box, outside any frame.
pub fn page(url: &str, p: &NativePage, mode: Mode, raw_key: &str, talk: &Talk) -> Shown {
    let kind = gateway::render_as(&p.mark, p.body.as_bytes());
    let title = title_of(url, kind, &p.body);
    let link = link_for(url);
    let (csp, main) = match kind {
        "html" => (
            FRAMED,
            format!(
                "<iframe class=\"pub\" title=\"{t}\" sandbox=\"{FRAME_SANDBOX}\" src=\"/raw?url={u}&amp;key={k}\"></iframe>",
                t = esc(&title),
                u = enc(url),
                k = enc(raw_key),
            ),
        ),
        "md" => (OWN, lossy(main_of(&gateway::render_markdown(p.body.as_bytes(), url.as_bytes(), &link)))),
        "gmi" => (OWN, lossy(main_of(&gateway::render_gemtext(p.body.as_bytes(), url.as_bytes(), &link)))),
        _ => (OWN, lossy(main_of(&gateway::render_text(p.body.as_bytes(), url.as_bytes())))),
    };
    let talk = commentable(url).map_or(String::new(), |ship| talk_box(url, &ship, talk));
    let html = chrome(&title, url, Some(mode), &format!("<article class=\"{kind}\">{main}</article>{talk}"), false);
    Shown { csp, html, title }
}

pub(crate) fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// What a failed read says, in plain words, with the gateway's own words
/// beneath where they add something.
/// `step` says what a reader still setting up is doing.
pub fn error_page(url: &str, e: &ReadError, mode: Mode, step: &str) -> (u16, Shown) {
    let retry = "<p><button type=\"button\" data-go=\"retry\">Try again</button></p>";
    let (status, title, body, refresh) = match e {
        ReadError::NotPublished(w) => (
            404,
            "Not published",
            format!(
                "<p>This page isn't published, or it is private. If it was shared with you, connect the ship it was \
                 shared with.</p><p class=\"words\">{}</p>",
                esc(w)
            ),
            false,
        ),
        ReadError::Unreachable { words, .. } => (
            504,
            "No answer",
            format!(
                "<p>The publisher of this page didn't answer. Their ship may be offline. If no page opens at all, \
                 your network may block Urbit: some networks block it.</p><p class=\"words\">{}</p>{retry}",
                esc(words)
            ),
            false,
        ),
        ReadError::Busy => (
            503,
            "Reader in use",
            format!("<p>The reader is in use by another lattice window.</p>{retry}"),
            false,
        ),
        ReadError::Booting => (
            503,
            "Getting ready",
            format!(
                "<p>Getting ready to read. The first time takes about 10 seconds, and later starts take one or \
                 two.</p>{}<p class=\"words\">The page opens by itself when it is ready.</p>",
                if step.is_empty() { String::new() } else { format!("<p class=\"step\">{}\u{2026}</p>", esc(step)) }
            ),
            true,
        ),
        ReadError::Failed(w) => (
            502,
            "Couldn't open this page",
            format!("<p>The reader couldn't open this page.</p><p class=\"words\">{}</p>{retry}", esc(w)),
            false,
        ),
    };
    let main = format!("<section class=\"error\"><h1>{title}</h1>{body}</section>");
    (status, Shown { csp: OWN, html: chrome(title, url, Some(mode), &main, refresh), title: title.into() })
}

/// One line of a folder's index: a page directly in it, or a folder
/// below it, with when it (for a folder, its newest page) last changed, in
/// unix ms, where that is known, and a page's title, empty when it has
/// none (a folder's is always empty).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DirRow {
    pub name: String,
    pub page: bool,
    pub when: Option<i64>,
    pub title: String,
}

/// A published page for a folder's index: its key (`/<path>`, as the
/// revision list names it), its last change in unix ms where that is
/// known, and its title, empty when it has none.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Listed {
    pub key: String,
    pub when: Option<i64>,
    pub title: String,
}

/// A folder's index from the published pages `keys`, as lattice's
/// `+dir-rows` makes it. Folders first, then pages, each by name, as the
/// tree sorts; `by_date` lists everything oldest to newest instead, ties
/// by name, an unknown time before any known one. A name can be a page and
/// a folder both (a page with pages under it).
pub fn dir_rows(keys: &[Listed], dir: &[String], by_date: bool) -> Vec<DirRow> {
    use std::collections::BTreeMap;
    let mut pages: BTreeMap<String, (Option<i64>, String)> = BTreeMap::new();
    let mut dirs: BTreeMap<String, Option<i64>> = BTreeMap::new();
    for Listed { key, when, title } in keys {
        let r: Vec<&str> = key.split('/').filter(|s| !s.is_empty()).collect();
        if r.len() <= dir.len() || r.iter().zip(dir).any(|(a, b)| *a != b) {
            continue;
        }
        let name = r[dir.len()].to_string();
        if r.len() == dir.len() + 1 {
            pages.insert(name, (*when, title.clone()));
        } else {
            let had = dirs.entry(name).or_insert(None);
            *had = (*had).max(*when);
        }
    }
    let mut rows: Vec<DirRow> = dirs
        .into_iter()
        .map(|(name, when)| DirRow { name, page: false, when, title: String::new() })
        .chain(pages.into_iter().map(|(name, (when, title))| DirRow { name, page: true, when, title }))
        .collect();
    if by_date {
        rows.sort_by(|a, b| a.when.cmp(&b.when).then_with(|| a.name.cmp(&b.name)));
    }
    rows
}

/// A folder's address: `urb://~ship/<dir>/`, under `/n/` when its first
/// name would read as a mount.
pub fn folder_url(ship: &str, dir: &[String]) -> String {
    let n = if dir.first().is_some_and(|d| d.len() == 1) { "n/" } else { "" };
    format!("urb://{ship}/{n}{}/", dir.join("/"))
}

/// A folder's index in the reader: each row's name (a page's title, where
/// it has one), linking to the page or the folder, and its last change as yyyy-mm-dd, with a toggle
/// between the two orders.
pub fn folder_page(ship: &str, dir: &[String], rows: &[DirRow], by_date: bool) -> Shown {
    let url = folder_url(ship, dir);
    let title = format!("{ship}/{}/", dir.join("/"));
    let by_name = read_href(&url);
    let dated = format!("{by_name}&sort=date");
    let order = if by_date {
        format!("Oldest first. <a href=\"{}\">Folders first</a>", esc(&by_name))
    } else {
        format!("Folders first. <a href=\"{}\">Oldest first</a>", esc(&dated))
    };
    let mut s = format!(
        "<style>.dir{{list-style:none;padding:0}}.dir li{{display:flex;gap:1em;justify-content:space-between}}\
         .dir time{{opacity:.7}}</style><section class=\"folder\"><h1>{}</h1><p class=\"words\">{order}</p>\
         <ul class=\"dir\">",
        esc(&title)
    );
    for r in rows {
        let (to, shown) =
            if r.page {
                (format!("{url}{}", r.name), if r.title.is_empty() { r.name.clone() } else { r.title.clone() })
            } else {
                (format!("{url}{}/", r.name), format!("{}/", r.name))
            };
        let when = r.when.map_or(String::new(), |ms| urb_engine::js::iso(ms).chars().take(10).collect());
        s.push_str(&format!(
            "<li><a href=\"{}\">{}</a><time>{}</time></li>",
            esc(&read_href(&to)),
            esc(&shown),
            esc(&when)
        ));
    }
    s.push_str("</ul></section>");
    Shown { csp: OWN, html: chrome(&title, &url, Some(Mode::Shipless), &s, false), title }
}

/// An address the reader cannot read.
pub fn bad_address(given: &str) -> Shown {
    let main = format!(
        "<section class=\"error\"><h1>Not an address</h1><p>That isn't an urb:// address. Addresses look like \
         <code>urb://~sampel-palnet/page</code>.</p><p class=\"words\">{}</p></section>",
        esc(given)
    );
    Shown { csp: OWN, html: chrome("Not an address", given, None, &main, false), title: "Not an address".into() }
}

/// The reader's home: the address field (in the bar), the start list
/// (the live page when `live` has it, else the compiled-in copy), and the
/// pages read recently, with Clear history. A live start page in HTML is
/// framed from `/raw` under `raw_key`, as a published HTML page is.
pub fn home(live: Option<&NativePage>, raw_key: &str, recent: &[Entry]) -> Shown {
    let kind = live.map(|p| gateway::render_as(&p.mark, p.body.as_bytes()));
    let (csp, start) = if kind == Some("html") && !raw_key.is_empty() {
        (
            FRAMED,
            format!(
                "<iframe class=\"pub\" title=\"{t}\" sandbox=\"{FRAME_SANDBOX}\" src=\"/raw?url={u}&amp;key={k}\"></iframe>",
                t = esc(START_URL),
                u = enc(START_URL),
                k = enc(raw_key),
            ),
        )
    } else {
        let body = live.filter(|_| kind == Some("gmi")).map_or(START, |p| p.body.as_str());
        (OWN, lossy(main_of(&gateway::render_gemtext(body.as_bytes(), START_URL.as_bytes(), &link_for(START_URL)))))
    };
    let mut main = format!(
        "<section class=\"home-page\"><div class=\"start{}\">{start}</div>",
        if live.is_some() { " live" } else { "" }
    );
    main.push_str("<div class=\"recent-head\"><h2>Recently read</h2>");
    if !recent.is_empty() {
        main.push_str(
            "<form method=\"post\" action=\"/history/clear\"><button type=\"submit\">Clear history</button></form>",
        );
    }
    main.push_str("</div>");
    if recent.is_empty() {
        main.push_str("<p class=\"words\">Pages you read appear here. They are kept only on this computer.</p>");
    } else {
        main.push_str("<ul class=\"recent\">");
        for e in recent.iter().take(50) {
            main.push_str(&format!(
                "<li><a href=\"{}\">{}</a> <span class=\"when\">{}</span></li>",
                esc(&read_href(&e.url)),
                esc(&e.title),
                esc(&e.url)
            ));
        }
        main.push_str("</ul>");
    }
    main.push_str("</section>");
    Shown { csp, html: chrome("lattice reader", "", Some(Mode::Shipless), &main, false), title: "lattice reader".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "urb://~zod/a/b";
    /// a published page (`/a/` is a single-letter mount, which takes none)
    const TALK: &str = "urb://~zod/notes/b";

    fn href(t: &str) -> String {
        String::from_utf8(link_for(PAGE)(t.as_bytes()).0).unwrap()
    }

    fn native(body: &str, mark: &str) -> NativePage {
        NativePage { key: "/k".into(), body: body.into(), mark: mark.into(), how: "keen".into() }
    }

    #[test]
    fn links_stay_in_the_reader_or_leave_for_the_web() {
        assert_eq!(href("urb://~nec/x"), "/read?url=urb%3A%2F%2F~nec%2Fx");
        assert_eq!(href("urb://~nec"), "/read?url=urb%3A%2F%2F~nec%2F");
        assert_eq!(href("c"), "/read?url=urb%3A%2F%2F~zod%2Fa%2Fc");
        assert_eq!(href("../up"), "/read?url=urb%3A%2F%2F~zod%2Fup");
        assert_eq!(href("/top"), "/read?url=urb%3A%2F%2F~zod%2Ftop");
        assert_eq!(href("https://example.com/x"), "https://example.com/x");
        assert_eq!(href("mailto:a@b.c"), "mailto:a@b.c");
        assert_eq!(href("gemini://g.example/"), "gemini://g.example/");
        for bad in ["//evil.example/x", "javascript:alert(1)", "a\u{1}b", "data:text/html,x", "urb://~not a ship"] {
            assert_eq!(href(bad), "", "{bad:?}");
        }
        let long = format!("{}{}", "urb://~nec/", "a".repeat(600));
        let h = href(&long);
        assert!(h.is_empty() || h.starts_with("/read?url="), "{h}");
        let (_, own) = link_for(PAGE)(b"https://example.com");
        assert!(!own);
    }

    #[test]
    fn gemtext_is_rendered_here_under_the_readers_policy() {
        let s = page(PAGE, &native("# Hello\n=> urb://~nec/x there\n<script>x</script>", "gmi"), Mode::Shipless, "k", &Talk::default());
        assert_eq!(s.csp, OWN);
        assert!(s.csp.starts_with("default-src 'none'; style-src 'unsafe-inline'; script-src 'self'"));
        assert!(s.html.contains("<h1>Hello</h1>"));
        assert!(s.html.contains("<a href=\"/read?url=urb%3A%2F%2F~nec%2Fx\">there</a>"), "{}", s.html);
        assert!(!s.html.contains("<script>x"));
        assert!(!s.html.contains("<iframe"));
        assert_eq!(s.title, "Hello");
        assert!(s.html.contains("<title>Hello</title>"));
        assert!(s.html.contains("value=\"urb://~zod/a/b\""));
    }

    #[test]
    fn markdown_and_text_are_escaped() {
        let s = page(PAGE, &native("# T\n<img src=x onerror=alert(1)>", "md"), Mode::Shipless, "k", &Talk::default());
        assert!(!s.html.contains("<img"));
        let s = page(PAGE, &native("<b>x</b>", "text"), Mode::Shipless, "k", &Talk::default());
        assert!(s.html.contains("&lt;b&gt;"));
        assert_eq!(s.title, PAGE);
    }

    #[test]
    fn a_publishers_html_only_ever_goes_in_the_sandboxed_frame() {
        for (body, mark) in [("<h1>x</h1><script>alert(1)</script>", "html"), ("  <p>looks like html", "gmi")] {
            let s = page(PAGE, &native(body, mark), Mode::Shipless, "key1", &Talk::default());
            assert_eq!(s.csp, FRAMED);
            assert!(s.html.contains(&format!(
                "<iframe class=\"pub\" title=\"urb://~zod/a/b\" sandbox=\"{FRAME_SANDBOX}\" \
                 src=\"/raw?url=urb%3A%2F%2F~zod%2Fa%2Fb&amp;key=key1\">"
            )));
            assert!(!s.html.contains("alert(1)") && !s.html.contains("looks like html"));
        }
        assert_eq!(SANDBOX, "sandbox allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation");
    }

    #[test]
    fn raw_html_points_urb_links_at_the_reader_and_the_top() {
        let out = raw_html(b"<!DOCTYPE html><a href=\"urb://~nec/x?y\">a</a> <img src='urb://~bus'> urb://~zod plain");
        let out = String::from_utf8(out).unwrap();
        assert_eq!(
            out,
            "<!DOCTYPE html><base target=\"_top\"><a href=\"/read?url=urb://~nec/x?y\">a</a> \
             <img src='/read?url=urb://~bus'> urb://~zod plain"
        );
        // a publisher who writes the gateway's form by hand gets no rewrite
        let out = String::from_utf8(raw_html(b"<a href=\"http://nec.urb.localhost:1/x\">")).unwrap();
        assert_eq!(out, "<base target=\"_top\"><a href=\"http://nec.urb.localhost:1/x\">");
    }

    #[test]
    fn every_node_action_is_shown_disabled_with_its_reason() {
        let s = page(PAGE, &native("x", "gmi"), Mode::Shipless, "k", &Talk::default());
        for (label, why) in [
            ("Bookmark", "Connect a node to bookmark"),
            ("Follow", "Connect a node to follow"),
            ("Host", "Hosting pages needs a node"),
        ] {
            assert!(s.html.contains(&format!("disabled title=\"{why}\"")), "{label}");
            assert!(s.html.contains(&format!(">{label}</button>")));
            assert!(s.html.contains(&format!(">{why}</span>")));
        }
        assert_eq!(s.html.matches("<button type=\"button\" disabled").count(), 3);
        assert!(!s.html.contains("Connect a ship"));
    }

    #[test]
    fn a_published_page_takes_a_comment_as_the_reader_identity() {
        let talk = Talk { our: Some("~doznec-sampel-palnet"), ..Talk::default() };
        let s = page(TALK, &native("x", "gmi"), Mode::Shipless, "k", &talk);
        assert!(s.html.contains("<form class=\"talk-form\" method=\"post\" action=\"/comment?url=urb%3A%2F%2F~zod%2Fnotes%2Fb\">"), "{}", s.html);
        assert!(s.html.contains("<textarea name=\"body\""));
        assert!(s.html.contains(">Send to ~zod</button>"));
        assert!(s.html.contains("as <code class=\"who\">~doznec-sampel-palnet</code>, the name ~zod sees as the author"));
        assert_eq!(s.html.matches("method=\"post\"").count(), 1);
        // outside the frame on a publisher's HTML page
        let s = page(TALK, &native("<p>x", "html"), Mode::Shipless, "k", &talk);
        let frame_end = s.html.find("</iframe>").unwrap();
        assert!(s.html.find("class=\"talk-form\"").unwrap() > frame_end);
        // a know entry or a tree file takes none
        for u in ["urb://~zod/k/notes", "urb://~zod/t/a/b"] {
            assert!(!page(u, &native("x", "gmi"), Mode::Shipless, "k", &talk).html.contains("talk-form"), "{u}");
        }
        assert_eq!(commentable("urb://~zod/about").as_deref(), Some("~zod"));
        assert_eq!(commentable("urb://~zod").as_deref(), Some("~zod"));
        assert_eq!(commentable("not an address"), None);
    }

    #[test]
    fn what_became_of_a_comment_is_said_plainly() {
        let say = |n: Note| page(TALK, &native("x", "gmi"), Mode::Shipless, "k", &Talk { note: Some(&n), ..Talk::default() }).html;
        let h = say(Note::Sent);
        assert!(h.contains("Sent to ~zod. ~zod decides whether it appears"), "{h}");
        assert!(h.contains("placeholder=\"Say something to ~zod\"></textarea>"), "the box is empty again");
        let h = say(Note::Refused { words: "weir: <denied>".into(), body: "my <text>".into() });
        assert!(h.contains("~zod refused this comment, so it wasn't posted.") && h.contains("weir: &lt;denied&gt;"));
        assert!(h.contains(">my &lt;text&gt;</textarea>"), "the text is kept");
        let h = say(Note::Unanswered { words: "no answer within 20s".into(), body: "b".into() });
        assert!(h.contains("~zod didn't answer, so your comment may not have been sent."));
        let h = say(Note::Failed { words: "the reader stopped".into(), body: "b".into() });
        assert!(h.contains("The reader couldn't send your comment."));
        assert!(say(Note::Empty).contains("Write something first."));
        assert!(say(Note::Posted).contains("Posted to ~zod.</p>"));
        let h = say(Note::Closed { body: "b".into() });
        assert!(h.contains("~zod has turned comments off on this page, so it wasn't sent.") && h.contains(">b</textarea>"));
    }

    #[test]
    fn the_box_follows_whether_the_page_takes_comments() {
        let at = |open: Open| page(TALK, &native("x", "gmi"), Mode::Shipless, "k", &Talk { open, ..Talk::default() }).html;
        let h = at(Open::Yes);
        assert!(h.contains(">Post to ~zod</button>") && h.contains("Posted anonymously") && !h.contains("They decide"), "{h}");
        let h = at(Open::No);
        assert!(h.contains("Comments are off on this page.") && !h.contains("talk-form") && !h.contains("<textarea"), "{h}");
        let h = at(Open::Unknown);
        assert!(h.contains(">Send to ~zod</button>") && h.contains("They decide whether it appears."), "{h}");
    }

    #[test]
    fn the_box_follows_the_pages_comet_policy() {
        let at = |comets: CometMode, full: Option<u64>| {
            let talk = Talk { open: Open::Yes, comets, full, ..Talk::default() };
            page(TALK, &native("x", "gmi"), Mode::Shipless, "k", &talk).html
        };
        let h = at(CometMode::Held, None);
        assert!(h.contains("class=\"talk-form\"") && h.contains(">Send to ~zod</button>"), "{h}");
        assert!(h.contains("Anonymous comments are reviewed before they appear."), "{h}");
        let h = at(CometMode::Off, None);
        assert!(h.contains("Anonymous comments are off on this page.") && !h.contains("talk-form") && !h.contains("<textarea"), "{h}");
        let off_and_full = at(CometMode::Off, Some(5));
        assert!(off_and_full.contains("Anonymous comments are off") && !off_and_full.contains("Too many"), "off wins");
        for mode in [CometMode::Open, CometMode::Held] {
            let h = at(mode, Some(7));
            assert!(h.contains("Too many anonymous comments here right now, try again in 7 min."), "{h}");
            assert!(!h.contains("talk-form") && !h.contains("<textarea"), "{h}");
        }
        // never "in 0 min"
        assert!(at(CometMode::Open, Some(0)).contains("try again in 1 min."));
        let h = at(CometMode::Open, None);
        assert!(h.contains(">Post to ~zod</button>") && !h.contains("Anonymous comments"), "{h}");
        // what became of a comment the policy turned away: the text is kept
        let talk = |n: &Note, comets, full| {
            let t = Talk { open: Open::Yes, comets, full, note: Some(n), ..Talk::default() };
            page(TALK, &native("x", "gmi"), Mode::Shipless, "k", &t).html
        };
        let h = talk(&Note::CometsOff { body: "b".into() }, CometMode::Off, None);
        assert!(h.contains("turned anonymous comments off on this page, so it wasn't sent.") && h.contains(">b</textarea>"), "{h}");
        // a comment turned away at the cap says so, never "Posted"
        let h = talk(&Note::Full { mins: 12, body: "b".into() }, CometMode::Open, Some(12));
        assert!(h.contains("Too many anonymous comments here right now, try again in 12 min. Your comment wasn't posted."), "{h}");
        assert!(h.contains(">b</textarea>") && !h.contains("Posted to"), "{h}");
        let h = talk(&Note::Held, CometMode::Held, None);
        assert!(h.contains("Sent to ~zod for review.") && h.contains("talk-form"), "{h}");
    }

    #[test]
    fn errors_say_what_happened() {
        let (st, s) = error_page(PAGE, &ReadError::NotPublished("urb://~zod/a/b is not published".into()), Mode::Shipless, "");
        assert_eq!(st, 404);
        assert!(s.html.contains("connect the ship it was shared with"));
        let (st, s) =
            error_page(PAGE, &ReadError::Unreachable { later: true, words: "~zod did not answer".into() }, Mode::Shipless, "");
        assert_eq!(st, 504);
        assert!(s.html.contains("data-go=\"retry\"") && s.html.contains("some networks block it"));
        let (_, s) = error_page(PAGE, &ReadError::Busy, Mode::Shipless, "");
        assert!(s.html.contains("in use by another lattice window"));
        let (_, s) = error_page(PAGE, &ReadError::Booting, Mode::Shipless, "");
        assert!(s.html.contains("Getting ready to read. The first time takes about 10 seconds"));
        assert!(!s.html.contains("identity") && !s.html.contains("comet"));
        assert!(s.html.contains("http-equiv=\"refresh\""));
        let (_, s) = error_page(PAGE, &ReadError::Booting, Mode::Shipless, "Setting up this computer");
        assert!(s.html.contains("<p class=\"step\">Setting up this computer\u{2026}</p>"));
        let s = bad_address("http://x\"<");
        assert!(s.html.contains("That isn't an urb:// address") && s.html.contains("http://x&#34;&lt;"));
    }

    #[test]
    fn home_shows_the_start_list_and_recent_reads() {
        let s = home(None, "", &[]);
        assert!(s.html.contains("<h1>lattice</h1>"), "the compiled-in copy");
        assert!(s.html.contains("href=\"/read?url=urb%3A%2F%2F~nisfeb%2Fsite%2Flattice%2Flattice\""));
        assert!(s.html.contains("kept only on this computer") && !s.html.contains("Clear history"));
        let live = native("# Live list\n=> urb://~nec/x A page", "gmi");
        let recent = [Entry { url: "urb://~zod/a".into(), title: "A <page>".into(), at: 1 }];
        let s = home(Some(&live), "", &recent);
        assert!(s.html.contains("<h1>Live list</h1>") && !s.html.contains("<h1>lattice</h1>"));
        assert!(s.html.contains("<a href=\"/read?url=urb%3A%2F%2F~zod%2Fa\">A &lt;page&gt;</a>"));
        assert!(s.html.contains("action=\"/history/clear\""));
        // a start page that is not gemtext is not trusted into the home
        let s = home(Some(&native("<script>x</script>", "html")), "", &[]);
        assert!(s.html.contains("<h1>lattice</h1>") && !s.html.contains("<script>x"));
        // an HTML start page is framed from /raw, as a published HTML page is
        let s = home(Some(&native("<h1>Styled</h1><script>x</script>", "html")), "k1", &recent);
        assert_eq!(s.csp, FRAMED);
        assert!(s.html.contains(&format!(
            "<iframe class=\"pub\" title=\"urb://~nisfeb/start\" sandbox=\"{FRAME_SANDBOX}\" \
             src=\"/raw?url=urb%3A%2F%2F~nisfeb%2Fstart&amp;key=k1\"></iframe>"
        )));
        assert!(!s.html.contains("<h1>lattice</h1>") && !s.html.contains("Styled") && !s.html.contains("<script>x"));
        assert!(s.html.find("</iframe>").unwrap() < s.html.find("Recently read").unwrap());
        assert_eq!(home(Some(&live), "", &recent).csp, OWN);
    }

    #[test]
    fn the_bar_has_back_forward_and_reload() {
        for s in [home(None, "", &[]), page(PAGE, &native("# Hi", "gmi"), Mode::Shipless, "", &Talk::default()), bad_address("x")] {
            let nav = s.html.split("<nav>").nth(1).unwrap().split("</nav>").next().unwrap();
            let order: Vec<&str> = nav.match_indices("data-go=\"").map(|(i, _)| nav[i + 9..].split('"').next().unwrap()).collect();
            assert_eq!(order, ["back", "forward", "reload"]);
            assert!(nav.contains("aria-label=\"Reload\""));
        }
    }

    #[test]
    fn titles_come_from_the_first_heading() {
        assert_eq!(title_of(PAGE, "gmi", "intro\n## sub\n# Main\n# Second"), "Main");
        assert_eq!(title_of(PAGE, "md", "no heading"), PAGE);
        assert_eq!(title_of(PAGE, "html", "# not this"), PAGE);
    }

    fn keys(k: &[(&str, i64)]) -> Vec<Listed> {
        k.iter().map(|(p, t)| Listed { key: p.to_string(), when: Some(*t), title: String::new() }).collect()
    }

    fn dir(d: &str) -> Vec<String> {
        d.split('/').filter(|s| !s.is_empty()).map(String::from).collect()
    }

    fn row(name: &str, page: bool, when: i64) -> DirRow {
        DirRow { name: name.into(), page, when: Some(when), title: String::new() }
    }

    #[test]
    fn a_folder_lists_its_pages_and_subfolders() {
        let k = keys(&[
            ("/site/docs/one", 5),
            ("/site/docs/b/two", 3),
            ("/site/docs/b/deep/three", 9),
            ("/site/docs/a", 7),
            ("/site/docs/a/four", 2),
            ("/site/other/x", 1),
            ("/site/docsx/y", 1),
            ("/site/docs", 4),
            ("/top", 1),
        ]);
        // folders first, then pages, each by name; a folder's time is its newest page's
        assert_eq!(
            dir_rows(&k, &dir("site/docs"), false),
            vec![row("a", false, 2), row("b", false, 9), row("a", true, 7), row("one", true, 5)]
        );
        // by date: oldest to newest, ties by name
        let mut k2 = k.clone();
        k2.push(Listed { key: "/site/docs/c".into(), when: Some(5), title: String::new() });
        assert_eq!(
            dir_rows(&k2, &dir("site/docs"), true),
            vec![row("a", false, 2), row("c", true, 5), row("one", true, 5), row("a", true, 7), row("b", false, 9)]
        );
        // other folders, the folder's own page and pages above it are not in it
        assert!(dir_rows(&k, &dir("site/nothing"), false).is_empty());
        assert!(dir_rows(&[], &dir("site"), false).is_empty());
        assert_eq!(dir_rows(&k, &dir("site"), false).iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["docs", "docsx", "other", "docs"]);
    }

    #[test]
    fn unknown_times_sort_first_and_show_blank() {
        let l = |key: &str, when| Listed { key: key.into(), when, title: String::new() };
        let k = vec![l("/d/b", Some(1)), l("/d/a", None), l("/d/s/x", None)];
        assert_eq!(
            dir_rows(&k, &dir("d"), true),
            vec![
                DirRow { name: "a".into(), page: true, when: None, ..Default::default() },
                DirRow { name: "s".into(), page: false, when: None, ..Default::default() },
                row("b", true, 1)
            ]
        );
    }

    #[test]
    fn a_folder_index_escapes_names_and_links_each_row() {
        let rows = vec![
            DirRow { name: "<b>&\"x".into(), page: false, when: Some(1_700_000_000_000), ..Default::default() },
            DirRow { name: "p'<i>".into(), page: true, when: None, ..Default::default() },
        ];
        let s = folder_page("~zod", &dir("a<b>"), &rows, false);
        assert!(!s.html.contains("<b>&") && !s.html.contains("<i>") && !s.html.contains("a<b>"), "{}", s.html);
        assert!(s.html.contains("&lt;b&gt;&amp;&#34;x/"), "{}", s.html);
        assert!(s.html.contains("<time>2023-11-14</time>"));
        assert!(s.html.contains(&esc(&read_href("urb://~zod/a<b>/<b>&\"x/"))));
        assert!(s.html.contains(&esc(&read_href("urb://~zod/a<b>/p'<i>"))));
        assert!(s.html.contains(&esc(&format!("{}&sort=date", read_href("urb://~zod/a<b>/")))));
        // a one-letter first name would read as a mount
        assert_eq!(folder_url("~zod", &dir("k/x")), "urb://~zod/n/k/x/");
        assert!(folder_page("~zod", &dir("a"), &rows, true).html.contains("Oldest first."));
    }

    #[test]
    fn a_page_row_shows_its_title_and_a_folder_its_name() {
        let k = vec![
            Listed { key: "/d/a".into(), when: Some(2_000), title: "Alpha <one>".into() },
            Listed { key: "/d/b".into(), when: Some(1_000), title: String::new() },
            Listed { key: "/d/s/x".into(), when: Some(3_000), title: "Inside".into() },
        ];
        let rows = dir_rows(&k, &dir("d"), false);
        assert_eq!(rows[0], DirRow { name: "s".into(), page: false, when: Some(3_000), title: String::new() });
        assert_eq!(rows[1].title, "Alpha <one>");
        let s = folder_page("~zod", &dir("d"), &rows, false);
        assert!(s.html.contains(">Alpha &lt;one&gt;</a>") && !s.html.contains("<one>"), "{}", s.html);
        assert!(s.html.contains(">b</a>"), "an empty title falls back to the name: {}", s.html);
        assert!(s.html.contains(">s/</a>") && !s.html.contains("Inside"), "{}", s.html);
        assert!(s.html.contains("<time>1970-01-01</time>"));
    }
}
