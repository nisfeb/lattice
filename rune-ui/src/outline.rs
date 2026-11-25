//! The right pane's Outline tab, as the web client has it
//! (`ui-src/lattice/76-outline.js`): the headings of the page in front,
//! each a jump to its place. Which lines are headings is worked out here
//! by the web client's rules, and `lib.rs` draws the list.

/// One heading of a page.
#[derive(Clone, Debug, PartialEq)]
pub struct Heading {
    /// 1 for `#`, 2 for `##`, and so on.
    pub level: usize,
    pub text: String,
    /// The line it is on, from 1.
    pub line: usize,
    /// Where its line begins in the text, in bytes.
    pub at: usize,
    /// Where its words are in the text, in bytes: after the `#`s, without the space round them.
    pub words: std::ops::Range<usize>,
}

/// The headings of a page: Markdown's `#` to `######` with a space after,
/// gemtext's `#` to `###` with one, flat ODT (`fodt`) `<text:h>` headings,
/// and nothing inside a fence. Any other kind has none.
pub fn outline(body: &str, kind: &str) -> Vec<Heading> {
    if kind == "fodt" {
        return crate::writer::fodt_outline(body)
            .into_iter()
            .map(|(level, text, idx)| Heading { level, text, line: idx + 1, at: idx, words: 0..0 })
            .collect();
    }
    let gmi = kind == "gmi";
    if kind != "md" && !gmi {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut fence: Option<&str> = None;
    let mut at = 0;
    for (i, raw) in body.split('\n').enumerate() {
        let start = at;
        at += raw.len() + 1;
        let ln = raw.strip_suffix('\r').unwrap_or(raw);
        if gmi {
            if ln.trim_end() == "```" {
                fence = if fence.is_some() { None } else { Some("```") };
                continue;
            }
            if fence.is_some() {
                continue;
            }
        } else {
            if let Some(f) = fence {
                if ln.trim_start().starts_with(f) {
                    fence = None;
                }
                continue;
            }
            let lead = ln.trim_start();
            if let Some(f) = ["```", "~~~"].into_iter().find(|f| lead.starts_with(f)) {
                fence = Some(f);
                continue;
            }
        }
        let level = ln.len() - ln.trim_start_matches('#').len();
        let rest = &ln[level..];
        // gemtext wants one space after the marks and has three levels. Markdown wants some space and has six
        let fits = if gmi { (1..=3).contains(&level) && rest.starts_with(' ') } else { (1..=6).contains(&level) && rest.starts_with(char::is_whitespace) };
        if !fits {
            continue;
        }
        let text = rest.trim();
        let from = start + level + (rest.len() - rest.trim_start().len());
        out.push(Heading { level, text: text.to_owned(), line: i + 1, at: start, words: from..from + text.len() });
    }
    out
}

/// What a row shows: the heading's words, or a stand-in when it has none.
pub fn shown(h: &Heading) -> &str {
    if h.text.is_empty() { "(untitled)" } else { &h.text }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn got(body: &str, kind: &str) -> Vec<(usize, String, usize)> {
        outline(body, kind).into_iter().map(|h| (h.level, h.text, h.line)).collect()
    }

    fn h(level: usize, text: &str, line: usize) -> (usize, String, usize) {
        (level, text.to_owned(), line)
    }

    #[test]
    fn markdown_headings_by_level_and_line() {
        let body = "# One\n\ntext\n## Two  \n####### seven is none\n#none\n###### Six\n";
        assert_eq!(got(body, "md"), [h(1, "One", 1), h(2, "Two", 4), h(6, "Six", 7)]);
    }

    #[test]
    fn nothing_inside_a_fence() {
        let body = "# Top\n```\n# not one\n```\n~~~sh\n# nor this\n```\n## still fenced\n~~~\n## Out\n";
        assert_eq!(got(body, "md"), [h(1, "Top", 1), h(2, "Out", 10)]);
        // an indented fence is a fence too
        assert_eq!(got("  ```\n# in\n  ```\n# out", "md"), [h(1, "out", 4)]);
    }

    #[test]
    fn gemtext_has_three_levels_and_one_space() {
        let body = "# One\n## Two\n### Three\n#### four is none\n#  two spaces\n```\n# fenced\n```\n# After\n";
        assert_eq!(got(body, "gmi"), [h(1, "One", 1), h(2, "Two", 2), h(3, "Three", 3), h(1, "two spaces", 5), h(1, "After", 9)]);
    }

    #[test]
    fn other_kinds_have_no_outline() {
        assert!(outline("# looks like one", "html").is_empty());
        assert!(outline("# a comment", "hoon").is_empty());
        assert!(outline("", "md").is_empty());
    }

    #[test]
    fn where_a_heading_is_in_the_text() {
        let body = "intro é\n##  Naïve words  \nmore";
        let o = outline(body, "md");
        assert_eq!(o.len(), 1);
        assert_eq!(&body[o[0].at..o[0].at + 2], "##");
        assert_eq!(&body[o[0].words.clone()], "Naïve words");
        // carriage returns do not end up in the words
        let o = outline("# Win\r\ntext\r\n", "md");
        assert_eq!((o[0].text.as_str(), &"# Win\r\ntext\r\n"[o[0].words.clone()]), ("Win", "Win"));
    }

    #[test]
    fn a_heading_with_no_words_still_has_a_row() {
        let o = outline("#  \n", "md");
        assert_eq!(o.len(), 1);
        assert_eq!(shown(&o[0]), "(untitled)");
        assert_eq!(shown(&outline("# Named", "md")[0]), "Named");
    }
}
