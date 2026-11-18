//! The left pane's Search tab, as the web client has it
//! (`ui-src/lattice/79-search.js`): a scan of the text already held, not
//! an index. It finds parts of words, it knows a page written a minute
//! ago, and a keystroke costs no request. What is found and how it is
//! ordered is worked out here, and `lib.rs` draws it.

/// The fewest letters that are searched for.
pub const LEAST: usize = 2;
/// The most results shown.
pub const MOST: usize = 100;

/// One page or memory that answers the query.
#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub key: String,
    /// Who reads it: `private`, `urbit`, `clearweb` or, for a memory, `knowledge`.
    pub scope: &'static str,
    /// The query is in its name.
    pub in_path: bool,
    pub know: bool,
    /// How many times its text holds the query.
    pub hits: usize,
    /// The text around the first one, or nothing when only the name matched.
    pub snip: String,
}

/// The word shown for how a page is shared, from the tree's own word for it.
pub fn scope(share: Option<&str>) -> &'static str {
    match share {
        Some("clearweb") => "clearweb",
        Some("shared") => "urbit",
        _ => "private",
    }
}

/// What is searched of a page: its text, without the markup of a kind
/// that is all markup (flat OpenDocument).
pub fn text_of<'a>(kind: &str, body: &'a str) -> std::borrow::Cow<'a, str> {
    if !matches!(kind, "fods" | "fodt") {
        return std::borrow::Cow::Borrowed(body);
    }
    let mut rest = body.split_once("<office:body>").map_or("", |(_, b)| b);
    let mut out = String::with_capacity(rest.len() / 2);
    while let Some(lt) = rest.find('<') {
        out.push_str(&rest[..lt]);
        let Some(gt) = rest[lt..].find('>') else {
            rest = "";
            break;
        };
        let tag = &rest[lt + 1..lt + gt];
        let name = tag.split(|c: char| c.is_whitespace() || c == '/').find(|p| !p.is_empty()).unwrap_or("");
        // the end of a paragraph or heading, and the marks for a space, a tab and a line break, are a space
        if (tag.starts_with('/') && matches!(name, "text:p" | "text:h")) || (!tag.starts_with('/') && matches!(name, "text:s" | "text:tab" | "text:line-break")) {
            out.push(' ');
        }
        rest = &rest[lt + gt + 1..];
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out.replace("&amp;", "&"))
}

/// The text around a match: forty letters either side, on one line.
pub fn snip(body: &str, at: usize, len: usize) -> String {
    let from = at.saturating_sub(40);
    let mut out = String::new();
    if from > 0 {
        out.push('…');
    }
    let mut gap = false;
    let mut more = false;
    for (i, c) in body.chars().enumerate().skip(from) {
        if i >= at + len + 40 {
            more = true;
            break;
        }
        // a run of spaces and line ends is one space
        if c.is_whitespace() {
            if !gap {
                out.push(' ');
            }
            gap = true;
        } else {
            out.push(c);
            gap = false;
        }
    }
    if more {
        out.push('…');
    }
    out
}

/// Whether `q`, in small letters already, is in this one's name or text.
pub fn hit(key: &str, body: &str, q: &str, scope: &'static str, know: bool) -> Option<Hit> {
    let hay = body.to_lowercase();
    let at = hay.find(q);
    let in_path = key.to_lowercase().contains(q);
    if at.is_none() && !in_path {
        return None;
    }
    // where it is, counted in letters: a letter's small form can be longer than it, so bytes would not do
    let found = at.map(|at| (hay.matches(q).count(), snip(body, hay[..at].chars().count(), q.chars().count())));
    let (hits, snip) = found.unwrap_or_default();
    Some(Hit { key: key.to_owned(), scope, in_path, know, hits, snip })
}

/// The query as it is searched for, or nothing when it is too short.
pub fn query(raw: &str) -> Option<String> {
    let q = raw.trim().to_lowercase();
    (q.chars().count() >= LEAST).then_some(q)
}

/// The results in order: a name that matches first, then the most
/// matches, then by name.
pub fn sort(out: &mut [Hit]) {
    out.sort_by(|a, b| b.in_path.cmp(&a.in_path).then(b.hits.cmp(&a.hits)).then_with(|| a.key.cmp(&b.key)));
}

/// The line over the results.
pub fn summary(found: usize, skipped: usize) -> String {
    let mut parts = Vec::new();
    if found > 0 {
        parts.push(format!("{found} result{}", if found == 1 { "" } else { "s" }));
    }
    if skipped > 0 {
        parts.push(format!("{skipped} page{} not scanned", if skipped == 1 { "" } else { "s" }));
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_is_trimmed_lowered_and_at_least_two_letters() {
        assert_eq!(query("  Zaphod "), Some("zaphod".to_owned()));
        assert_eq!(query("a"), None);
        assert_eq!(query(" a "), None);
        assert_eq!(query("ab"), Some("ab".to_owned()));
        assert_eq!(query("é"), None, "letters are counted, not bytes");
    }

    #[test]
    fn a_part_of_a_word_is_found_in_any_case() {
        let h = hit("notes/guide", "Ask Zaphodbeeblebrox. zaphod again.", "zaphod", "private", false).unwrap();
        assert_eq!((h.hits, h.in_path, h.know), (2, false, false));
        assert_eq!(h.snip, "Ask Zaphodbeeblebrox. zaphod again.");
        assert_eq!(hit("notes/guide", "nothing here", "zaphod", "private", false), None);
    }

    #[test]
    fn a_name_alone_is_a_hit_with_no_snippet() {
        let h = hit("People/Zaphod", "president", "zaphod", "urbit", false).unwrap();
        assert_eq!((h.hits, h.in_path, h.snip.as_str(), h.scope), (0, true, "", "urbit"));
    }

    #[test]
    fn the_snippet_is_forty_letters_either_side_on_one_line() {
        let body = format!("{}\nfind  me\t{}", "a".repeat(60), "b".repeat(60));
        let at = body.chars().position(|c| c == 'f').unwrap();
        let s = snip(&body, at, 4);
        assert_eq!(s, format!("…{} find me {}…", "a".repeat(39), "b".repeat(35)));
        assert_eq!(snip("short find", 6, 4), "short find");
    }

    #[test]
    fn letters_outside_ascii_do_not_break_the_snippet() {
        let body = "İstanbul’da çay — naïve café ☕ zaphod ünïcödé text";
        let h = hit("k", body, "zaphod", "private", false).unwrap();
        assert_eq!(h.hits, 1);
        assert!(h.snip.contains("zaphod"), "{}", h.snip);
    }

    #[test]
    fn names_first_then_most_matches_then_by_name() {
        let h = |key: &str, in_path, hits| Hit { key: key.into(), scope: "private", in_path, know: false, hits, snip: String::new() };
        let mut out = vec![h("b", false, 1), h("z", true, 0), h("a", false, 1), h("c", false, 5)];
        sort(&mut out);
        assert_eq!(out.iter().map(|h| h.key.as_str()).collect::<Vec<_>>(), ["z", "c", "a", "b"]);
    }

    #[test]
    fn the_scope_is_the_web_clients_word() {
        assert_eq!(scope(None), "private");
        assert_eq!(scope(Some("")), "private");
        assert_eq!(scope(Some("private")), "private");
        assert_eq!(scope(Some("shared")), "urbit");
        assert_eq!(scope(Some("clearweb")), "clearweb");
    }

    #[test]
    fn a_flat_opendocument_is_searched_as_its_text() {
        let body = r#"<office:document><office:meta>secretmeta</office:meta><office:body><text:p text:style-name="P1">Tea &amp; cake</text:p><text:p>second<text:s/>line</text:p></office:body></office:document>"#;
        let t = text_of("fodt", body);
        assert!(t.contains("Tea & cake"), "{t}");
        assert!(t.contains("second line"), "{t}");
        assert!(!t.contains("secretmeta") && !t.contains("style-name"), "{t}");
        assert_eq!(text_of("md", "<b>kept</b>"), "<b>kept</b>");
    }

    #[test]
    fn the_summary_counts_results_and_pages_not_read() {
        assert_eq!(summary(0, 0), "");
        assert_eq!(summary(1, 0), "1 result");
        assert_eq!(summary(3, 2), "3 results · 2 pages not scanned");
        assert_eq!(summary(0, 1), "1 page not scanned");
    }
}
