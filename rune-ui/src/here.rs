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
fn blocks(kind: &str, text: &str) -> Vec<std::ops::Range<usize>> {
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
