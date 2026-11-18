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
    e.set_selection(a, b);
    e.set_link(None);
    e.set_caret(b);
    e.insert(&format!("]({url})"));
    e.set_caret(a);
    e.insert("[");
    e.set_caret(caret + 1);
    Some(Open { start: a, tail: e.text.len() - (b + 1 + url.len() + 3) })
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
    // what follows the label, then the bracket before it, then the link over what is left
    e.set_selection(o.start + 1 + label, end);
    e.insert("");
    e.set_selection(o.start, o.start + 1);
    e.insert("");
    e.set_selection(o.start, o.start + label);
    e.set_link(Some(&url));
    // a caret past the link moved back by what was taken out
    let gone = end - o.start - label;
    let moved = |c: usize| if c >= end { c - gone } else { c.min(o.start) };
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
        close(&mut e, Open { start: 40, tail: 0 });
        close(&mut e, Open { start: 0, tail: 400 });
        assert_eq!(e.text, "go [there](u now");
    }
}
