//! Who else has a shared page open, and where in it. The ship keeps a
//! table for each page and streams it (`/presence-stream`). This is the
//! client's side of it: the table as it is read, the others in it, and
//! a name for the place a window is in that two windows agree on while
//! their texts differ by what one of them has typed.

use serde::Deserialize;

/// One window on the page.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Row {
    /// The ship and the window, as `~ship/window`.
    #[serde(default)]
    pub who: String,
    #[serde(default)]
    pub ship: String,
    /// Where it is, as `place` names it. Empty for a reader.
    #[serde(default)]
    pub block: String,
    /// `read` or `edit`.
    #[serde(default)]
    pub mode: String,
}

/// A page's table as the ship sends it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Table {
    #[serde(default)]
    pub page: String,
    /// A number that only goes up while the ship's presence runs.
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub here: Vec<Row>,
}

impl Row {
    pub fn editing(&self) -> bool {
        self.mode == "edit"
    }
}

/// A table from what a stream's `here` event carries.
pub fn table(data: &str) -> Option<Table> {
    serde_json::from_str(data).ok()
}

/// Whether a table is to be shown: newer than the last one shown on this
/// stream. One that arrives late, after a newer, is not.
pub fn takes(last: Option<u64>, seq: u64) -> bool {
    last.is_none_or(|l| seq > l)
}

/// The windows on the page other than this one, those editing first.
pub fn others(t: &Table, me: &str) -> Vec<Row> {
    let mut out: Vec<Row> = t.here.iter().filter(|r| r.who != me).cloned().collect();
    out.sort_by(|a, b| b.editing().cmp(&a.editing()).then(a.who.cmp(&b.who)));
    out
}

/// What is said of another window: its ship, or that it is another
/// window of this ship's, and whether it is editing.
pub fn said(r: &Row, our: &str) -> String {
    let who = if r.ship == our { "another window".to_owned() } else { r.ship.clone() };
    if r.editing() { format!("{who} \u{b7} editing") } else { who }
}

/// How long a window in the background stays on a page's table, and how
/// long one in front that nothing has touched, in seconds.
pub const AWAY_AFTER: f64 = 60.0;
pub const STILL_AFTER: f64 = 300.0;

/// Whether this window has gone quiet: in the background for a minute,
/// or untouched for five. A quiet window leaves the table and stops
/// asking the ship anything for it, so a computer left on with a shared
/// page open costs the ship nothing. `touched` is when a key or the
/// pointer last moved here, `behind` since when the window has not been
/// the one in front.
pub fn quiet(now: f64, touched: f64, behind: Option<f64>) -> bool {
    behind.is_some_and(|b| now - b >= AWAY_AFTER) || now - touched >= still_after()
}

/// `STILL_AFTER`, or in a debug build the seconds `LATTICE_STILL_AFTER` names, so a check need not wait five minutes.
fn still_after() -> f64 {
    if cfg!(debug_assertions) && !cfg!(test) {
        if let Some(s) = std::env::var("LATTICE_STILL_AFTER").ok().and_then(|v| v.parse::<f64>().ok()) {
            return s;
        }
    }
    STILL_AFTER
}

/// How long until a window that is not quiet would be, if nothing more happens: when to look again.
pub fn quiet_in(now: f64, touched: f64, behind: Option<f64>) -> f64 {
    let still = touched + still_after() - now;
    behind.map_or(still, |b| still.min(b + AWAY_AFTER - now)).max(0.0)
}

/// An id for this run of the app, to tell its window from another of the
/// same ship's: sixteen hex figures from the clock and the process.
pub fn client_id() -> String {
    let t = crate::api::since_epoch().map_or(0, |d| d.as_nanos());
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in t.to_le_bytes().into_iter().chain(std::process::id().to_le_bytes()) {
        h = (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The blocks of a page's text: Markdown's own top blocks, and for any
/// other kind each run of lines between blank lines.
pub fn blocks(kind: &str, text: &str) -> Vec<std::ops::Range<usize>> {
    if kind == "md" {
        return crate::scrub::blocks(text);
    }
    let (mut out, mut from, mut at) = (Vec::new(), None, 0);
    for line in text.split_inclusive('\n') {
        match (line.trim().is_empty(), from) {
            (true, Some(f)) => {
                out.push(f..at);
                from = None;
            }
            (false, None) => from = Some(at),
            _ => {}
        }
        at += line.len();
    }
    if let Some(f) = from {
        out.push(f..at);
    }
    out
}

/// A heading's words, as a place is named by them: no marks, lower case, 60 characters and 100 bytes at most.
fn heading(block: &str) -> Option<String> {
    let line = block.lines().next()?.trim_start();
    let marks = line.bytes().take_while(|b| *b == b'#').count();
    if !(1..=6).contains(&marks) || !line[marks..].starts_with([' ', '\t']) {
        return None;
    }
    // the ship keeps 128 bytes of a place: a heading is cut to 100, at a whole character
    let mut out = String::new();
    for ch in line[marks..].trim().trim_end_matches('#').trim().to_lowercase().chars().take(60) {
        if out.len() + ch.len_utf8() > 100 {
            break;
        }
        out.push(ch);
    }
    Some(out)
}

/// The place of each block: the heading it is under, and which block it
/// is after that heading, the heading itself being the first.
fn places(kind: &str, text: &str) -> Vec<(String, std::ops::Range<usize>)> {
    let (mut under, mut n) = (String::new(), 0usize);
    blocks(kind, text)
        .into_iter()
        .map(|r| {
            match heading(&text[r.clone()]).filter(|_| kind == "md") {
                Some(h) => (under, n) = (h, 0),
                None => n += 1,
            }
            (format!("{under}\u{1f}{n}"), r)
        })
        .collect()
}

/// The place the caret is in: the block it is in or just after. Named by
/// the heading above and the block's turn under it, so text typed in one
/// block, or a section added elsewhere, leaves every other place its
/// name. Empty when the page has no text.
pub fn place(kind: &str, text: &str, caret: usize) -> String {
    let all = places(kind, text);
    all.iter().rev().find(|(_, r)| r.start <= caret).or(all.first()).map(|(p, _)| p.clone()).unwrap_or_default()
}

/// Where a place lies in this text, when it has such a place.
pub fn place_range(kind: &str, text: &str, place: &str) -> Option<std::ops::Range<usize>> {
    if place.is_empty() {
        return None;
    }
    places(kind, text).into_iter().find(|(p, _)| p == place).map(|(_, r)| r.start..r.start + text[r.clone()].trim_end().len())
}

/// A line without the marks a list, a heading or a quote starts with, for
/// finding it again in the same page written another way.
fn bare(line: &str) -> &str {
    let l = line.trim().trim_start_matches(['#', '>', ' ']);
    let l = l.strip_prefix(['-', '*', '+', '\u{2022}']).map_or(l, str::trim_start);
    let digits = l.bytes().take_while(u8::is_ascii_digit).count();
    let l = if digits > 0 { l[digits..].strip_prefix(['.', ')']).map_or(l, str::trim_start) } else { l };
    l.strip_prefix("[ ]").or(l.strip_prefix("[x]")).map_or(l, str::trim_start)
}

/// Where the line at `at` in one text is in another text of the same
/// page: the start of the line there that reads the same, the nearest
/// to where it would be were the two alike. The editor shows a page as
/// rich text or as its source, and a place is named in the source.
pub fn across(from: &str, at: usize, to: &str) -> usize {
    let at = at.min(from.len());
    let start = from[..at].rfind('\n').map_or(0, |i| i + 1);
    let key = bare(from[start..].lines().next().unwrap_or(""));
    let guess = (at as f64 / from.len().max(1) as f64 * to.len() as f64) as usize;
    let mut best: Option<usize> = None;
    let mut pos: usize = 0;
    for line in to.split_inclusive('\n') {
        if !key.is_empty() && bare(line) == key && best.is_none_or(|b| pos.abs_diff(guess) < b.abs_diff(guess)) {
            best = Some(pos);
        }
        pos += line.len();
    }
    best.unwrap_or_else(|| {
        // no such line: the start of the line at the same share of the way through
        let g = (0..=guess.min(to.len())).rev().find(|i| to.is_char_boundary(*i)).unwrap_or(0);
        to[..g].rfind('\n').map_or(0, |i| i + 1)
    })
}

/// A range of whole lines in one text, as the lines that read the same in another.
pub fn across_range(from: &str, r: std::ops::Range<usize>, to: &str) -> std::ops::Range<usize> {
    let start = across(from, r.start, to);
    let last = across(from, r.end.saturating_sub(1).max(r.start), to);
    let end = last + to[last..].lines().next().map_or(0, str::len);
    start..end.max(start)
}

/// A place as people read it: the heading it is under, when it has one.
pub fn place_said(place: &str) -> String {
    match place.split('\u{1f}').next().filter(|h| !h.is_empty()) {
        Some(h) => format!("under \u{201c}{h}\u{201d}"),
        None => "at the top".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "# The shed\n\nA plan.\n\n## Site\n\nBehind the tree.\n\nOn the slab.\n\n## Cost\n\n- Timber\n";

    #[test]
    fn a_place_is_the_heading_above_and_the_blocks_turn_under_it() {
        let at = |needle: &str| PAGE.find(needle).unwrap() + 2;
        assert_eq!(place("md", PAGE, at("A plan")), "the shed\u{1f}1");
        assert_eq!(place("md", PAGE, at("## Site")), "site\u{1f}0");
        assert_eq!(place("md", PAGE, at("On the slab")), "site\u{1f}2");
        assert_eq!(place("md", PAGE, PAGE.len()), "cost\u{1f}1");
        assert_eq!(place("md", "", 0), "");
        // the blank line after a block is that block's
        assert_eq!(place("md", PAGE, PAGE.find("\n\n## Cost").unwrap() + 1), "site\u{1f}2");
        assert_eq!((place_said("site\u{1f}2"), place_said("\u{1f}1")), ("under \u{201c}site\u{201d}".to_owned(), "at the top".to_owned()));
    }

    #[test]
    fn a_place_keeps_its_name_while_another_window_types_elsewhere() {
        let theirs = PAGE.replace("A plan.", "A plan, with more words typed into it.").replace("## Cost", "## Paint\n\nGreen.\n\n## Cost");
        let mine = place("md", PAGE, PAGE.find("On the slab").unwrap());
        let r = place_range("md", &theirs, &mine).unwrap();
        assert_eq!(&theirs[r], "On the slab.");
        assert_eq!(place_range("md", &theirs, "gone\u{1f}3"), None);
        assert_eq!(place_range("md", &theirs, ""), None);
    }

    #[test]
    fn a_line_is_found_again_in_the_page_written_another_way() {
        // the rich editor's text: no blank lines between blocks, a bullet for a list's dash
        let rich = "# The shed\nA plan.\n## Site\nBehind the tree.\nOn the slab.\n## Cost\n\u{2022} Timber\n";
        let at = |s: &str, needle: &str| s.find(needle).unwrap();
        assert_eq!(across(rich, at(rich, "On the slab") + 4, PAGE), at(PAGE, "On the slab"));
        assert_eq!(across(rich, at(rich, "Timber") + 2, PAGE), at(PAGE, "- Timber"));
        assert_eq!(across(PAGE, at(PAGE, "## Site") + 3, rich), at(rich, "## Site"));
        // a place named in the source is the same place for a caret in the rich text
        assert_eq!(place("md", PAGE, across(rich, at(rich, "On the slab") + 4, PAGE)), "site\u{1f}2");
        // and a block's range in the source is whole lines of the rich text
        let r = place_range("md", PAGE, "site\u{1f}2").unwrap();
        assert_eq!(&rich[across_range(PAGE, r, rich)], "On the slab.");
        // a line that is not there lands on a line's start, never mid-character
        assert_eq!(across("zzz", 1, "caf\u{e9}\nb"), 0);
        assert_eq!(across("", 0, ""), 0);
    }

    #[test]
    fn a_window_goes_quiet_in_the_background_or_left_alone() {
        // in front and touched a moment ago
        assert!(!quiet(1000.0, 990.0, None));
        // in front, and nothing touched for five minutes
        assert!(!quiet(1000.0, 701.0, None) && quiet(1000.0, 700.0, None));
        // behind another window for a minute, however lately it was touched
        assert!(!quiet(1000.0, 999.0, Some(941.0)) && quiet(1000.0, 999.0, Some(940.0)));
        // when to look again: the sooner of the two
        assert_eq!(quiet_in(1000.0, 990.0, None), 290.0);
        assert_eq!(quiet_in(1000.0, 990.0, Some(970.0)), 30.0);
        assert_eq!(quiet_in(1000.0, 0.0, None), 0.0);
    }

    #[test]
    fn source_is_placed_by_its_runs_of_lines() {
        let src = "a = 1\nb = 2\n\n# not a heading here\nc = 3\n";
        assert_eq!(place("js", src, src.find("c = 3").unwrap()), "\u{1f}2");
        assert_eq!(&src[place_range("js", src, "\u{1f}1").unwrap()], "a = 1\nb = 2");
    }

    #[test]
    fn the_table_is_read_and_this_window_left_out() {
        let t = table(r#"{"here":[{"who":"~zod/a","mode":"read","ship":"~zod","block":""},{"who":"~nec/x","mode":"edit","ship":"~nec","block":"site\u001f2"},{"who":"~zod/b","mode":"read","ship":"~zod","block":""}],"seq":7,"page":"notes/plan"}"#).unwrap();
        assert_eq!((t.seq, t.page.as_str(), t.here.len()), (7, "notes/plan", 3));
        let o = others(&t, "~zod/a");
        assert_eq!(o.iter().map(|r| r.who.as_str()).collect::<Vec<_>>(), ["~nec/x", "~zod/b"], "the one editing first");
        assert_eq!([said(&o[0], "~zod"), said(&o[1], "~zod")], ["~nec \u{b7} editing", "another window"]);
        assert!(takes(None, 0) && takes(Some(6), 7) && !takes(Some(7), 7) && !takes(Some(8), 7));
        assert_eq!(table("not json"), None);
        assert_ne!(client_id(), "");
    }
}
