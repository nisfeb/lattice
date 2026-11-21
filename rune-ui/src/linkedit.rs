//! A link in the rich editor, opened to its Markdown while the caret is
//! in it and closed to a link again when the caret leaves, so it is
//! changed by typing as any Markdown is. The page's text is the same
//! Markdown either way: an opened link is written out as it reads.

use rune::{Mark, TextEdit};

/// A link opened to its Markdown: where it starts, and how far its end is from the text's end.
/// What is typed inside it moves neither, so the two say where it is however it changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Open {
    pub start: usize,
    pub tail: usize,
    /// What its Markdown read as when it was opened, as a sum of it: whether it has been typed in since.
    opened: u64,
}

/// A sum of a text, to tell it from another.
fn sum(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3))
}

impl Open {
    /// Where it ends in a text of this length, or nothing when the text no longer holds it.
    fn end(&self, len: usize) -> Option<usize> {
        len.checked_sub(self.tail).filter(|e| *e >= self.start)
    }
}

/// The link the caret stands in, strictly: its range and where it goes. A caret at either edge is beside it.
fn link_at(e: &TextEdit) -> Option<(usize, usize, String)> {
    if e.anchor != e.focus {
        return None;
    }
    e.marks().iter().find_map(|m| match &m.mark {
        Mark::Link(url) if m.start < e.focus && e.focus < m.end => Some((m.start, m.end, url.clone())),
        _ => None,
    })
}

/// A link written as Markdown, `[label](address)`, and nothing else: how long its label is, and its address.
pub fn literal(lit: &str) -> Option<(usize, &str)> {
    let inner = lit.strip_prefix('[')?.strip_suffix(')')?;
    let at = inner.rfind("](")?;
    let (label, url) = (&inner[..at], &inner[at + 2..]);
    (!label.is_empty() && !url.is_empty() && !url.contains(char::is_whitespace) && !label.contains('\n')).then_some((label.len(), url))
}

/// Opens the link the caret is in to its Markdown, with the caret left on the same letter.
pub fn open(e: &mut TextEdit) -> Option<Open> {
    let (a, b, url) = link_at(e)?;
    let caret = e.focus;
    // one step of the history, so that leaving the link untouched can take the whole of it back (`close`)
    let b = e.undo_group(|e| {
        e.set_selection(a, b);
        e.set_link(None);
        // a bracket in the label that would end it early, or open a label of its own, is escaped as it is
        // when the page is written (`md::label_escapes`): open or shut, the page is the same text. Last
        // first, so each place is still where it was counted
        let escapes = crate::md::label_escapes(&e.text[a..b]);
        for at in escapes.iter().rev() {
            e.set_caret(a + at);
            e.insert("\\");
        }
        let (b, caret) = (b + escapes.len(), caret + escapes.iter().filter(|at| a + **at <= caret).count());
        e.set_caret(b);
        e.insert(&format!("]({url})"));
        e.set_caret(a);
        e.insert("[");
        e.set_caret(caret + 1);
        b
    });
    let tail = e.text.len() - (b + 1 + url.len() + 3);
    let end = e.text.len() - tail;
    Some(Open { start: a, tail, opened: e.text.get(a..end).map_or(0, sum) })
}

/// Whether the caret, or either end of a selection, has left an opened link.
pub fn left(e: &TextEdit, o: Open) -> bool {
    match o.end(e.text.len()) {
        Some(end) => [e.anchor, e.focus].iter().any(|c| *c < o.start || *c > end),
        None => true,
    }
}

/// Closes an opened link to a link again, when what stands there is still one written
/// as Markdown. What is not is left as the text it is. The caret stays where it was put.
pub fn close(e: &mut TextEdit, o: Open) {
    let Some(end) = o.end(e.text.len()).filter(|end| e.text.is_char_boundary(o.start) && e.text.is_char_boundary(*end)) else { return };
    let Some((label, url)) = literal(&e.text[o.start..end]).map(|(n, u)| (n, u.to_owned())) else { return };
    let (anchor, focus) = (e.anchor, e.focus);
    // a caret past the link moved back by what was taken out
    let gone = end - o.start - label;
    let moved = |c: usize| if c >= end { c - gone } else { c.min(o.start) };
    if sum(&e.text[o.start..end]) == o.opened {
        // nothing was typed in it: the opening is taken back, and the history is as it was before the caret came. Opened and closed as two edits, each pass of the caret left two steps to undo, and the first undo of them took the link's address away
        e.undo();
    } else {
        // what follows the label, then the bracket before it, then the link over what is left, as one step
        e.undo_group(|e| {
            e.set_selection(o.start + 1 + label, end);
            e.insert("");
            e.set_selection(o.start, o.start + 1);
            e.insert("");
            e.set_selection(o.start, o.start + label);
            e.set_link(Some(&url));
        });
    }
    e.set_selection(moved(anchor), moved(focus));
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::MarkRange;

    fn edit(text: &str, marks: Vec<MarkRange>, caret: usize) -> TextEdit {
        let mut e = TextEdit::from_parts(text, marks, Vec::new()).allow_marks([Mark::Bold, Mark::Link(String::new())]);
        e.set_caret(caret);
        e
    }

    fn links(e: &TextEdit) -> Vec<(usize, usize, String)> {
        e.marks().iter().filter_map(|m| match &m.mark {
            Mark::Link(u) => Some((m.start, m.end, u.clone())),
            _ => None,
        }).collect()
    }

    #[test]
    fn a_link_reads_as_markdown_only_when_it_is_whole() {
        assert_eq!(literal("[there](https://x.y/z)"), Some((5, "https://x.y/z")));
        assert_eq!(literal("[a [b] c](u)"), Some((7, "u")), "the last bracket pair is the address's");
        for bad in ["there", "[there]", "[there](", "[](u)", "[a]()", "[a](b c)", "[a](u) x", "x [a](u)"] {
            assert_eq!(literal(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_caret_in_a_link_opens_it_and_leaving_closes_it() {
        // "go there now", with "there" a link
        let mut e = edit("go there now", vec![MarkRange::new(3..8, Mark::Link("https://x.y".into()))], 5);
        let o = open(&mut e).expect("the caret is in the link");
        assert_eq!(e.text, "go [there](https://x.y) now");
        assert_eq!((links(&e), e.focus), (vec![], 6), "no link while it is open, and the caret on the same letter");
        assert!(!left(&e, o));
        // the address is changed by typing, as any text is
        e.set_caret(e.text.find(".y").unwrap() + 2);
        e.insert("/z");
        assert!(!left(&e, o), "typing inside does not leave it");
        e.set_caret(e.text.len());
        assert!(left(&e, o));
        close(&mut e, o);
        assert_eq!(e.text, "go there now");
        assert_eq!((links(&e), e.focus), (vec![(3, 8, "https://x.y/z".to_owned())], e.text.len()));
    }

    #[test]
    fn at_a_links_edge_it_stays_shut() {
        let marks = vec![MarkRange::new(3..8, Mark::Link("u".into()))];
        for caret in [0, 3, 8, 12] {
            assert_eq!(open(&mut edit("go there now", marks.clone(), caret)), None, "{caret}");
        }
        let mut sel = edit("go there now", marks, 4);
        sel.set_selection(4, 6);
        assert_eq!(open(&mut sel), None, "a selection is not a caret");
    }

    #[test]
    fn a_label_changed_and_a_caret_before_it_are_kept() {
        let mut e = edit("go there now", vec![MarkRange::new(3..8, Mark::Link("u".into()))], 4);
        let o = open(&mut e).unwrap();
        // "there" becomes "over there"
        e.set_caret(4);
        e.insert("over ");
        e.set_caret(1);
        assert!(left(&e, o));
        close(&mut e, o);
        assert_eq!((e.text.as_str(), links(&e), e.focus), ("go over there now", vec![(3, 13, "u".to_owned())], 1));
    }

    #[test]
    fn a_caret_passing_through_a_link_leaves_nothing_to_undo() {
        let mut e = edit("go there now", vec![MarkRange::new(3..8, Mark::Link("https://x.y".into()))], 0);
        // something typed first, that an undo should reach
        e.insert("WORD ");
        e.break_history_group();
        let before = e.history_len();
        for _ in 0..3 {
            e.set_caret(10);
            let o = open(&mut e).expect("the caret is in the link");
            e.set_caret(e.text.len());
            close(&mut e, o);
        }
        assert_eq!(e.text, "WORD go there now");
        assert_eq!(links(&e), vec![(8, 13, "https://x.y".to_owned())]);
        assert_eq!(e.history_len().0, before.0, "the passes left no step");
        assert_eq!(e.focus, e.text.len(), "the caret is where it was put");
        // one undo takes back what was typed, and the link is whole
        e.undo();
        assert_eq!(e.text, "go there now");
        assert_eq!(links(&e), vec![(3, 8, "https://x.y".to_owned())]);
    }

    #[test]
    fn what_is_no_longer_a_link_is_left_as_text() {
        let mut e = edit("go there now", vec![MarkRange::new(3..8, Mark::Link("u".into()))], 5);
        let o = open(&mut e).unwrap();
        // the closing bracket is rubbed out
        let at = e.text.find(')').unwrap();
        e.set_selection(at, at + 1);
        e.insert("");
        e.set_caret(0);
        close(&mut e, o);
        assert_eq!((e.text.as_str(), links(&e)), ("go [there](u now", vec![]));
        // and a range that no longer fits the text does nothing
        close(&mut e, Open { start: 40, tail: 0, opened: 0 });
        close(&mut e, Open { start: 0, tail: 400, opened: 0 });
        assert_eq!(e.text, "go [there](u now");
    }

    #[test]
    fn a_bracket_in_a_label_is_escaped_when_the_link_opens_so_the_page_is_the_same_open_or_shut() {
        use rune::Block::Paragraph as P;
        // "see a[b](c now", with "a[b](c" a link, and the caret before its "("
        let mut e = edit("see a[b](c now", vec![MarkRange::new(4..10, Mark::Link("http://u".into()))], 8);
        let shut = crate::md::emit(&e.text, e.marks(), &[P], &[]);
        assert_eq!(shut, "see [a\\[b\\](c](http://u) now\n");
        let o = open(&mut e).expect("the caret is in the link");
        assert_eq!((e.text.as_str(), &e.text[e.focus..e.focus + 1]), ("see [a\\[b\\](c](http://u) now", "("));
        assert_eq!(crate::md::emit(&e.text, e.marks(), &[P], &[]), shut, "written while open, it is the page it is when shut");
        // and that page reads back as the one link
        let d = crate::md::exact(&shut).expect("exact");
        assert_eq!(d.marks, vec![MarkRange::new(4..12, Mark::Link("http://u".into()))]);
        e.set_caret(0);
        close(&mut e, o);
        // left untouched, the opening is taken back whole: the text and the link are as they were
        assert_eq!((e.text.as_str(), links(&e)), ("see a[b](c now", vec![(4, 10, "http://u".to_owned())]));
        assert_eq!(crate::md::emit(&e.text, e.marks(), &[P], &[]), shut);
    }
}
