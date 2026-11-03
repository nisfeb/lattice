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
//! navigation policy, commands.rs). Every ship action is shown and
//! disabled with its reason: the reader never acts as anyone.


use urb_render::gateway;

use crate::engine::{NativePage, ReadError};
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

/// Why the ship actions are disabled. One reason today: no ship is
/// configured. (Slice 2's "your ship isn't answering" is deferred.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Shipless,
}

/// The ship actions a reader page offers, each disabled, with its reason.
pub fn actions(mode: Mode) -> [(&'static str, &'static str); 3] {
    match mode {
        Mode::Shipless => [
            ("Bookmark", "Connect a ship to bookmark"),
            ("Comment", "Connect a ship to comment"),
            ("Follow", "Connect a ship to follow"),
        ],
    }
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

fn esc(s: &str) -> String {
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
fn main_of(doc: &[u8]) -> &[u8] {
    let start = find(doc, b"<main>").map_or(0, |n| n + 6);
    let end = doc.windows(7).rposition(|w| w == b"</main>").unwrap_or(doc.len());
    if start <= end {
        &doc[start..end]
    } else {
        doc
    }
}

/// The reader's document around `main`.
fn chrome(title: &str, url: &str, mode: Option<Mode>, main: &str, refresh: bool) -> String {
    let strip = mode.map_or(String::new(), |m| {
        let mut s = String::from("<div class=\"actions\" role=\"group\" aria-label=\"Ship actions\">");
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
<a class=\"home\" href=\"/\">Home</a></nav>\
<form class=\"addr\" action=\"/read\" method=\"get\"><input name=\"url\" value=\"{url}\" aria-label=\"Address\" \
placeholder=\"urb://~ship/page\" spellcheck=\"false\" autocomplete=\"off\"><button type=\"submit\">Open</button></form>\
<a class=\"connect\" href=\"/connect\">Connect a ship</a></header>{strip}<main class=\"page\">{main}</main></body></html>",
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
/// the frame's `/raw` request, when the page is a publisher's HTML.
pub fn page(url: &str, p: &NativePage, mode: Mode, raw_key: &str) -> Shown {
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
    let html = chrome(&title, url, Some(mode), &format!("<article class=\"{kind}\">{main}</article>"), false);
    Shown { csp, html, title }
}

fn lossy(b: &[u8]) -> String {
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
/// pages read recently, with Clear history.
pub fn home(live: Option<&NativePage>, recent: &[Entry]) -> Shown {
    let body = live.filter(|p| gateway::render_as(&p.mark, p.body.as_bytes()) == "gmi").map_or(START, |p| p.body.as_str());
    let start = lossy(main_of(&gateway::render_gemtext(body.as_bytes(), START_URL.as_bytes(), &link_for(START_URL))));
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
    Shown { csp: OWN, html: chrome("lattice reader", "", Some(Mode::Shipless), &main, false), title: "lattice reader".into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "urb://~zod/a/b";

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
        let s = page(PAGE, &native("# Hello\n=> urb://~nec/x there\n<script>x</script>", "gmi"), Mode::Shipless, "k");
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
        let s = page(PAGE, &native("# T\n<img src=x onerror=alert(1)>", "md"), Mode::Shipless, "k");
        assert!(!s.html.contains("<img"));
        let s = page(PAGE, &native("<b>x</b>", "text"), Mode::Shipless, "k");
        assert!(s.html.contains("&lt;b&gt;"));
        assert_eq!(s.title, PAGE);
    }

    #[test]
    fn a_publishers_html_only_ever_goes_in_the_sandboxed_frame() {
        for (body, mark) in [("<h1>x</h1><script>alert(1)</script>", "html"), ("  <p>looks like html", "gmi")] {
            let s = page(PAGE, &native(body, mark), Mode::Shipless, "key1");
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
    fn every_ship_action_is_shown_disabled_with_its_reason() {
        let s = page(PAGE, &native("x", "gmi"), Mode::Shipless, "k");
        for (label, why) in [
            ("Bookmark", "Connect a ship to bookmark"),
            ("Comment", "Connect a ship to comment"),
            ("Follow", "Connect a ship to follow"),
        ] {
            assert!(s.html.contains(&format!("disabled title=\"{why}\"")), "{label}");
            assert!(s.html.contains(&format!(">{label}</button>")));
            assert!(s.html.contains(&format!(">{why}</span>")));
        }
        assert_eq!(s.html.matches("<button type=\"button\" disabled").count(), 3);
        assert!(!s.html.contains("method=\"post\""));
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
        let s = home(None, &[]);
        assert!(s.html.contains("<h1>Start here</h1>"), "the compiled-in copy");
        assert!(s.html.contains("href=\"/read?url=urb%3A%2F%2F~nisfeb%2Fstart\""));
        assert!(s.html.contains("kept only on this computer") && !s.html.contains("Clear history"));
        let live = native("# Live list\n=> urb://~nec/x A page", "gmi");
        let recent = [Entry { url: "urb://~zod/a".into(), title: "A <page>".into(), at: 1 }];
        let s = home(Some(&live), &recent);
        assert!(s.html.contains("<h1>Live list</h1>") && !s.html.contains("Start here</h1>"));
        assert!(s.html.contains("<a href=\"/read?url=urb%3A%2F%2F~zod%2Fa\">A &lt;page&gt;</a>"));
        assert!(s.html.contains("action=\"/history/clear\""));
        // a start page that is not gemtext is not trusted into the home
        let s = home(Some(&native("<script>x</script>", "html")), &[]);
        assert!(s.html.contains("<h1>Start here</h1>") && !s.html.contains("<script>x"));
    }

    #[test]
    fn titles_come_from_the_first_heading() {
        assert_eq!(title_of(PAGE, "gmi", "intro\n## sub\n# Main\n# Second"), "Main");
        assert_eq!(title_of(PAGE, "md", "no heading"), PAGE);
        assert_eq!(title_of(PAGE, "html", "# not this"), PAGE);
    }
}
