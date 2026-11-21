//! Markdown to Rune's rich text model and back, for the rich editor.
//!
//! The model has inline marks (bold, italic, strike, code, link) and one
//! block per line (paragraph, bullet, numbered, quote, code). Markdown has
//! more than that, so what the model cannot hold stays as the text the page
//! wrote: a heading keeps its `#`, a table its pipes, a fence its backticks.
//!
//! The rule that keeps pages safe is [`exact`]: a page opens in the rich
//! editor only when parsing it and writing it back gives the same text.
//! Anything else opens as source, so the rich editor never rewrites a page
//! the owner did not edit.

use rune::{Block, Mark, MarkRange};

#[derive(Debug, Default, PartialEq)]
pub struct Doc {
    pub text: String,
    pub marks: Vec<MarkRange>,
    /// One per `\n`-separated line of `text`.
    pub blocks: Vec<Block>,
    /// Lines that continue the one above (a line break inside a paragraph).
    pub soft: Vec<u32>,
    /// The spacing the page wrote between its lines.
    pub seps: Seps,
}

/// The page as a rich document, when the rich editor can hold it without
/// changing it. A missing final newline is the one difference allowed.
pub fn exact(src: &str) -> Option<Doc> {
    // a text field may not keep a carriage return as it is
    if src.contains('\r') {
        return None;
    }
    let d = parse(src);
    let out = emit_with(&d.text, &d.marks, &d.blocks, &d.soft, &d.seps);
    (out == src || out.strip_suffix('\n') == Some(src)).then_some(d)
}

/// The scheme a wiki link is given so the reader can tell it from a web one.
pub const WIKI: &str = "lattice:";

/// A page's Markdown with its raw HTML made into what the reader can draw. The reader draws
/// Markdown natively and has nothing to draw HTML with, so what CommonMark passes through to a
/// browser would be left out: a `<div>` and all the text in it, a table written in HTML, a
/// `<br>`. Here a block of HTML is read as the document it is and written as Markdown
/// (`html::to_markdown`), a `<br>` is a line break, and the few inline tags that have a Markdown
/// of their own become it. Any other inline tag is still left out, with the words inside it kept.
/// HTML inside a list item or a quote is left as it was: its lines carry the marks of what holds it.
pub fn html_shown(src: &str) -> String {
    if !src.contains('<') {
        return src.to_owned();
    }
    // the last page read is kept: a view is built every frame, and the page is parsed once
    thread_local! {
        static LAST: std::cell::RefCell<(String, String)> = const { std::cell::RefCell::new((String::new(), String::new())) };
    }
    LAST.with_borrow_mut(|last| {
        if last.0 != src {
            *last = (src.to_owned(), html_made(src));
        }
        last.1.clone()
    })
}

pub fn html_made(src: &str) -> String {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
    // the options rune-kit parses with, so the places agree
    let opts = Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let mut swaps: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    let (mut held, mut cell) = (0usize, 0usize);
    // the paired tags met in the block being read: (where, the tag's name, whether it closes, what it becomes)
    let mut pairs: Vec<(std::ops::Range<usize>, String, bool, &'static str)> = Vec::new();
    for (ev, range) in Parser::new_ext(src, opts).into_offset_iter() {
        match ev {
            Event::Start(Tag::BlockQuote(_) | Tag::Item) => held += 1,
            Event::End(TagEnd::BlockQuote(_)) => held = held.saturating_sub(1),
            Event::Start(Tag::TableCell) => cell += 1,
            // a tag left open, or closed and never opened, is not made into a mark with no partner
            Event::End(TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::TableCell | TagEnd::Item) => {
                // each name's openings less its closings, counted once: a paragraph of many tags is not counted through for each of them
                let mut open: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
                for p in &pairs {
                    *open.entry(p.1.as_str()).or_default() += if p.2 { -1 } else { 1 };
                }
                for (range, name, _, with) in &pairs {
                    if open.get(name.as_str()) == Some(&0) {
                        swaps.push((range.clone(), (*with).to_owned()));
                    }
                }
                pairs.clear();
                match ev {
                    Event::End(TagEnd::Item) => held = held.saturating_sub(1),
                    Event::End(TagEnd::TableCell) => cell = cell.saturating_sub(1),
                    _ => {}
                }
            }
            // at the start of its line, with at most the spaces Markdown allows before a block
            Event::Start(Tag::HtmlBlock) if held == 0 && src[..range.start].rsplit('\n').next().is_some_and(|lead| lead.chars().all(|c| c == ' ')) => {
                let mut as_md = crate::html::to_markdown(&src[range.clone()]);
                as_md.truncate(as_md.trim_end().len());
                // a block of its own, whatever stood round it
                swaps.push((range, if as_md.is_empty() { String::new() } else { format!("\n{as_md}\n\n") }));
            }
            Event::InlineHtml(tag) => {
                let name: String = tag.trim_start_matches('<').trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
                let closes = tag.starts_with("</");
                match name.as_str() {
                    // a cell of a table is one line: a break there is a space
                    "br" => swaps.push((range, if cell > 0 { " " } else { "\\\n" }.to_owned())),
                    "b" | "strong" => pairs.push((range, "b".into(), closes, "**")),
                    "i" | "em" => pairs.push((range, "i".into(), closes, "*")),
                    "s" | "del" | "strike" => pairs.push((range, "s".into(), closes, "~~")),
                    "kbd" | "code" | "samp" | "tt" => pairs.push((range, "code".into(), closes, "`")),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    if swaps.is_empty() {
        return src.to_owned();
    }
    swaps.sort_by_key(|s| s.0.start);
    let mut out = String::with_capacity(src.len());
    let mut at = 0;
    for (range, with) in swaps {
        // an HTML block's own lines come as events inside it: what is already replaced is passed over
        if range.start < at {
            continue;
        }
        out.push_str(&src[at..range.start]);
        out.push_str(&with);
        at = range.end;
    }
    out.push_str(&src[at..]);
    out
}

/// The longest a wiki link's inside may be, in bytes.
const WIKI_MOST: usize = 512;

/// The most blocks, quotes and lists, that may stand one inside another
/// in what is drawn.
pub const NEST_MOST: usize = 8;

/// A page for display with no line nested deeper than `NEST_MOST`: the
/// drawing of quotes and lists doubles in cost with each one inside
/// another, so forty `>` on a line would hold the window for ever. The
/// markers past the eighth are dropped and deep indents drawn in, which
/// leaves the words. Fenced code is left as it is. Only what is read is
/// passed through this, never what is edited or saved.
pub fn shallow(src: &str) -> std::borrow::Cow<'_, str> {
    // how many block markers a line opens with, where the last one allowed ends, and where the last of all ends.
    // The line is read through once, however many markers it has
    fn lead(line: &str) -> (usize, usize, usize, usize) {
        let (b, mut i, mut n, mut indent, mut cut, mut last) = (line.as_bytes(), 0, 0, 0, 0, 0);
        while i < b.len() {
            match b[i] {
                b' ' | b'\t' if n == 0 => (i, indent) = (i + 1, indent + if b[i] == b'\t' { 4 } else { 1 }),
                b' ' | b'\t' => i += 1,
                b'>' => (i, n, last) = (i + 1, n + 1, i + 1),
                b'-' | b'*' | b'+' if b.get(i + 1).is_some_and(|c| *c == b' ' || *c == b'\t') => (i, n, last) = (i + 2, n + 1, i + 2),
                b'0'..=b'9' => {
                    // a list's number has nine figures at most: no more of a longer run is read
                    let d = b[i..].iter().take(10).take_while(|c| c.is_ascii_digit()).count();
                    if d > 9 || !matches!(b.get(i + d), Some(b'.' | b')')) || !matches!(b.get(i + d + 1), Some(b' ' | b'\t')) {
                        break;
                    }
                    (i, n, last) = (i + d + 2, n + 1, i + d + 2);
                }
                _ => break,
            }
            if n == NEST_MOST && cut == 0 {
                cut = i;
            }
        }
        (n, indent, cut, last)
    }
    let deep = |line: &str| {
        let (n, indent, _, _) = lead(line);
        n > NEST_MOST || indent > NEST_MOST * 4
    };
    if !src.lines().any(deep) {
        return std::borrow::Cow::Borrowed(src);
    }
    let (mut out, mut fenced) = (String::with_capacity(src.len()), false);
    for line in src.split_inclusive('\n') {
        if fence(line) {
            fenced = !fenced;
        }
        if fenced || !deep(line) {
            out.push_str(line);
            continue;
        }
        let (n, indent, cut, last) = lead(line);
        if indent > NEST_MOST * 4 {
            // a deep indent is drawn in to the deepest one allowed
            out.push_str(&" ".repeat(NEST_MOST * 4));
            out.push_str(line.trim_start_matches([' ', '\t']));
        } else if n > NEST_MOST {
            // the markers past the last allowed are dropped, and what they led to kept
            out.push_str(&line[..cut]);
            out.push_str(&line[last..]);
        }
    }
    std::borrow::Cow::Owned(out)
}

/// The page for display: each wiki link, `[[name]]` or `[[name|label]]`,
/// becomes a Markdown link to `lattice:name`. Fenced code and inline code
/// are left as they are. Only the reader uses this, never the editor.
/// A link to a page `ghost` says is not written yet shows in italics.
pub fn wikilinks(src: &str, ghost: &dyn Fn(&str) -> bool) -> String {
    let mut out = String::with_capacity(src.len());
    let mut fenced = false;
    for line in src.split_inclusive('\n') {
        if fence(line) {
            fenced = !fenced;
        }
        if fenced || !line.contains("[[") {
            out.push_str(line);
            continue;
        }
        // every other piece between backticks is code
        for (i, piece) in line.split('`').enumerate() {
            if i > 0 {
                out.push('`');
            }
            if i % 2 == 1 {
                out.push_str(piece);
                continue;
            }
            let mut rest = piece;
            while let Some(a) = rest.find("[[") {
                // a link's end is looked for near its start only: a line of many openings would else be read through once for each
                let mut near = (a + 2 + WIKI_MOST).min(rest.len());
                while !rest.is_char_boundary(near) {
                    near -= 1;
                }
                let Some(z) = rest[a + 2..near].find("]]") else {
                    out.push_str(&rest[..a + 2]);
                    rest = &rest[a + 2..];
                    continue;
                };
                let inner = &rest[a + 2..a + 2 + z];
                let (name, label) = inner.split_once('|').unwrap_or((inner, inner));
                let (name, label) = (name.trim(), label.trim());
                if name.is_empty() || label.is_empty() || inner.contains('[') {
                    out.push_str(&rest[..a + 2]);
                    rest = &rest[a + 2..];
                    continue;
                }
                out.push_str(&rest[..a]);
                let label = if ghost(name) { format!("*{label}*") } else { label.to_owned() };
                out.push_str(&format!("[{label}]({WIKI}{})", crate::api::enc(name).replace("%2F", "/")));
                rest = &rest[a + 4 + z..];
            }
            out.push_str(rest);
        }
    }
    out
}

/// The sources of a page's images, `![alt](src)`, each once, in order.
/// Fenced code is passed over.
pub fn images(src: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut fenced = false;
    for line in src.lines() {
        if fence(line) {
            fenced = !fenced;
        }
        if fenced {
            continue;
        }
        let mut rest = line;
        while let Some(a) = rest.find("![") {
            rest = &rest[a + 2..];
            let Some(z) = rest.find("](") else { break };
            let after = &rest[z + 2..];
            let end = after.find(|c: char| c == ')' || c.is_whitespace()).unwrap_or(after.len());
            let url = &after[..end];
            if !url.is_empty() && !rest[..z].contains(']') && !out.iter().any(|u| u == url) {
                out.push(url.to_owned());
            }
            rest = after;
        }
    }
    out
}

/// Whether an image's source is on another site: `http://`, `https://`
/// or `//host`. Showing one tells that site the reader's address.
pub fn remote(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("http://") || u.starts_with("https://") || u.starts_with("//")
}

/// What is typed of a wiki link at the caret: where it starts and its
/// text, when the caret sits in an unclosed `[[` on its own line and
/// what follows is the start of a page's name.
pub fn link_query(text: &str, caret: usize) -> Option<(usize, &str)> {
    let upto = text.get(..caret)?;
    let line = &upto[upto.rfind('\n').map_or(0, |i| i + 1)..];
    let q = &line[line.rfind("[[")? + 2..];
    let ok = q.chars().all(|c| c.is_ascii_alphanumeric() || "/._~-".contains(c));
    ok.then_some((caret - q.len(), q))
}

/// The journal page for a whole date, `YYYY-MM-DD`.
pub fn journal_day(q: &str) -> Option<String> {
    let b = q.as_bytes();
    let date = b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    date.then(|| format!("journal/{q}"))
}

/// The pages a page links to, each once, in the order they come: wiki
/// links and Markdown links into this app.
// ponytail: a Markdown link written inside code counts too. A real parse if that shows.
pub fn links(src: &str) -> Vec<String> {
    let shown = wikilinks(src, &|_| false);
    let mut out: Vec<String> = Vec::new();
    let mut rest = shown.as_str();
    while let Some(a) = rest.find("](") {
        rest = &rest[a + 2..];
        let Some(z) = rest.find(')') else { break };
        if let Some(name) = page_of(&rest[..z]).filter(|n| !out.contains(n)) {
            out.push(name);
        }
    }
    out
}

/// The page a link names, when it is one of ours: a wiki link's target, or
/// a path into this app. `None` for a link to the web.
pub fn page_of(url: &str) -> Option<String> {
    let path = url.strip_prefix(WIKI).or_else(|| url.strip_prefix("/apps/lattice/page/"))?;
    let path = path.split(['#', '?']).next().unwrap_or(path);
    // undo the percent-encoding a link needs
    let mut bytes = Vec::with_capacity(path.len());
    let b = path.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%').then(|| path.get(i + 1..i + 3)).flatten().and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(v) => {
                bytes.push(v);
                i += 3;
            }
            None => {
                bytes.push(b[i]);
                i += 1;
            }
        }
    }
    let name = String::from_utf8(bytes).ok()?;
    let name = name.trim_matches('/');
    (!name.is_empty()).then(|| name.to_owned())
}

fn is_list(b: Block) -> bool {
    matches!(b, Block::Bullet(_) | Block::Numbered(_))
}

/// Whether list line `b` sits right under list line `a`: a nested line
/// always does, a top one only under its own kind of list.
fn same_list(a: Block, b: Block) -> bool {
    !matches!(b, Block::Bullet(0) | Block::Numbered(0)) || std::mem::discriminant(&a) == std::mem::discriminant(&b)
}

fn fence(line: &str) -> bool {
    line.starts_with("```")
}

/// A line's block and the text after its marker, `None` for plain text.
fn classify(line: &str) -> Option<(Block, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    let rest = &line[indent..];
    if let Some(t) = rest.strip_prefix("- ") {
        return (indent % 2 == 0 && indent / 2 <= 3 && !t.is_empty()).then_some((Block::Bullet((indent / 2) as u8), t));
    }
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits > 0 {
        if let Some(t) = rest[digits..].strip_prefix(". ") {
            return (indent % 3 == 0 && indent / 3 <= 3 && !t.is_empty()).then_some((Block::Numbered((indent / 3) as u8), t));
        }
    }
    if indent == 0 {
        if let Some(t) = line.strip_prefix("> ") {
            return Some((Block::Quote, t));
        }
    }
    None
}

pub fn parse(src: &str) -> Doc {
    let mut d = Doc::default();
    let mut lines: Vec<&str> = src.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let (mut gap, mut fenced, mut first) = (true, false, true);
    // the line above as written, and the blank lines since it
    let (mut above, mut blanks): (Option<&str>, u8) = (None, 0);
    let push = |d: &mut Doc, block: Block, soft: bool, text: &str, first: &mut bool| {
        if !*first {
            d.text.push('\n');
        }
        *first = false;
        if soft {
            d.soft.push(d.blocks.len() as u32);
        }
        d.blocks.push(block);
        if block == Block::Code {
            d.text.push_str(text);
        } else {
            inline(text, &mut d.text, &mut d.marks);
        }
    };
    for line in lines {
        if !fenced && line.is_empty() {
            // one less than a byte holds, so the count with the line's own end added still fits
            blanks = blanks.saturating_add(1).min(u8::MAX - 1);
        } else {
            if let Some(a) = above {
                d.seps.entry((a.to_owned(), line.to_owned())).or_insert(1 + blanks);
            }
            (above, blanks) = (Some(line), 0);
        }
        if fenced {
            push(&mut d, Block::Code, false, line, &mut first);
            fenced = !fence(line);
            gap = false;
        } else if fence(line) {
            push(&mut d, Block::Code, false, line, &mut first);
            fenced = true;
            gap = false;
        } else if line.is_empty() {
            gap = true;
        } else {
            match (classify(line), d.blocks.last().copied()) {
                (Some((b, t)), _) => push(&mut d, b, false, t, &mut first),
                // a line right under another continues it
                (None, Some(prev)) if !gap && prev != Block::Code => push(&mut d, prev, true, line, &mut first),
                (None, _) => push(&mut d, Block::Paragraph, false, line, &mut first),
            }
            gap = false;
        }
    }
    d
}

fn mark(marks: &mut Vec<MarkRange>, start: usize, end: usize, mark: Mark) {
    if end > start {
        marks.push(MarkRange { start, end, mark });
    }
}

fn edge_ok(inner: &str) -> bool {
    !inner.is_empty() && !inner.starts_with(char::is_whitespace) && !inner.ends_with(char::is_whitespace)
}

/// Where a `**` run closes in `s`, the text after the opening one. A closing
/// run of three with an italic still open inside belongs one star later.
fn close_double(s: &str, d: &str) -> Option<usize> {
    let j = s.find(d)?;
    if d == "**" && s[j..].starts_with("***") && s[..j].matches('*').count() % 2 == 1 {
        return Some(j + 1);
    }
    Some(j)
}

/// Where a single `*` closes in `s`, the text after the opening one: the
/// first star that is not part of a `**` pair.
fn close_single(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut j = 0;
    while j < b.len() {
        if b[j] == b'*' {
            if b.get(j + 1) == Some(&b'*') {
                j += 2;
                continue;
            }
            return Some(j);
        }
        j += 1;
    }
    None
}

/// Where something next stands in a line, at or after a place. The last
/// answer is kept, so asking from places further and further along reads
/// the line through once and not once for each asking.
#[derive(Default)]
struct Seek {
    from: usize,
    found: Option<usize>,
    asked: bool,
}

impl Seek {
    fn at(&mut self, s: &str, from: usize, find: impl Fn(&str) -> Option<usize>) -> Option<usize> {
        let kept = self.asked && from >= self.from && self.found.is_none_or(|f| f >= from);
        if !kept {
            (self.from, self.asked) = (from, true);
            self.found = s.get(from..).and_then(find).map(|j| j + from);
        }
        self.found
    }
}

/// Where the label of a link that opens at `i` closes: the first `](`
/// that no backslash escapes. A label with a `[` of its own that is not
/// escaped is not a label. The walk stops at that `[`, which is the next
/// link's opening, so a line of many openings is read once in all.
fn label_end(b: &[u8], i: usize) -> Option<usize> {
    let mut p = i + 1;
    while p < b.len() {
        match b[p] {
            b'\\' if b.get(p + 1).is_some_and(u8::is_ascii_punctuation) => p += 2,
            b'[' => return None,
            b']' if b.get(p + 1) == Some(&b'(') => return Some(p),
            _ => p += 1,
        }
    }
    None
}

/// How code is fenced when it is written: how many backticks, and whether
/// a space stands inside each fence. Code with no backtick takes one and
/// no space. Code with one takes a fence longer than its longest run of
/// them, as CommonMark asks, and the spaces when it starts or ends with a
/// backtick, or starts and ends with a space that would else be taken off.
fn code_fence(code: &str) -> (usize, bool) {
    let longest = code.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    if longest == 0 {
        return (1, false);
    }
    (longest + 1, code.starts_with('`') || code.ends_with('`') || (code.starts_with(' ') && code.ends_with(' ')))
}

/// The runs of backticks in a line: where each starts and how long it
/// is, and for each length the last run of it. A fence is closed by the
/// next run of its own length, and looking for that run by run, with a
/// length that has no later run answered at once, reads a line of many
/// fences once and not once for each.
struct Ticks {
    runs: Vec<(usize, usize)>,
    last: std::collections::HashMap<usize, usize>,
}

impl Ticks {
    fn of(s: &str) -> Ticks {
        let b = s.as_bytes();
        let (mut runs, mut last, mut i) = (Vec::new(), std::collections::HashMap::new(), 0);
        while i < b.len() {
            if b[i] != b'`' {
                i += 1;
                continue;
            }
            let n = b[i..].iter().take_while(|c| **c == b'`').count();
            last.insert(n, runs.len());
            runs.push((i, n));
            i += n;
        }
        Ticks { runs, last }
    }

    /// The code that the fence at `i` holds, and where its closing fence
    /// ends, when it is written just as `code_fence` writes it. Any other
    /// is left as the text it is, so it is written back unchanged. The
    /// fence is a whole run: backticks left over from a longer run, some
    /// of which closed something else, open nothing.
    fn code<'a>(&self, s: &'a str, i: usize) -> Option<(&'a str, usize)> {
        let at = self.runs.binary_search_by_key(&i, |r| r.0).ok()?;
        let run = self.runs[at].1;
        if self.last.get(&run).is_none_or(|l| *l <= at) {
            return None;
        }
        // the closing fence is the next run of exactly as many, and the longest run before it is the code's own
        let mut longest = 0;
        let close = self.runs[at + 1..].iter().find(|r| {
            longest = longest.max(if r.1 == run { 0 } else { r.1 });
            r.1 == run
        })?;
        let raw = &s[i + run..close.0];
        let padded = raw.len() >= 2 && raw.starts_with(' ') && raw.ends_with(' ');
        let code = if padded { &raw[1..raw.len() - 1] } else { raw };
        let pads = code.starts_with('`') || code.ends_with('`') || (code.starts_with(' ') && code.ends_with(' '));
        (!code.is_empty() && longest + 1 == run && pads == padded).then_some((code, close.0 + run))
    }
}

/// Appends `s` to `out` without its inline markers, recording each as a mark.
fn inline(s: &str, out: &mut String, marks: &mut Vec<MarkRange>) {
    let b = s.as_bytes();
    let mut i = 0;
    // what ends a link's address, looked for from one link's label to the next
    let (mut paren, mut space, mut opening) = (Seek::default(), Seek::default(), Seek::default());
    // the line's runs of backticks, counted when a fence of more than one is first met
    let mut ticks: Option<Ticks> = None;
    while i < b.len() {
        let rest = &s[i..];
        match b[i] {
            b'\\' if b.get(i + 1).is_some_and(u8::is_ascii_punctuation) => {
                out.push_str(&s[i..i + 2]);
                i += 2;
            }
            b'`' => {
                let run = rest.len() - rest.trim_start_matches('`').len();
                let close = if run == 1 { rest[1..].find('`').filter(|&j| j > 0).map(|j| (&rest[1..1 + j], j + 2)) } else { ticks.get_or_insert_with(|| Ticks::of(s)).code(s, i).map(|(code, end)| (code, end - i)) };
                match close {
                    Some((code, len)) => {
                        let at = out.len();
                        out.push_str(code);
                        mark(marks, at, out.len(), Mark::Code);
                        i += len;
                    }
                    None => {
                        out.push_str(&rest[..run]);
                        i += run;
                    }
                }
            }
            b'*' | b'~' if rest.starts_with("**") || rest.starts_with("~~") => {
                let d = &rest[..2];
                match close_double(&rest[2..], d).filter(|&j| edge_ok(&rest[2..2 + j])) {
                    Some(j) => {
                        let at = out.len();
                        inline(&rest[2..2 + j], out, marks);
                        mark(marks, at, out.len(), if d == "**" { Mark::Bold } else { Mark::Strike });
                        i += j + 4;
                    }
                    None => {
                        out.push_str(d);
                        i += 2;
                    }
                }
            }
            b'*' => match close_single(&rest[1..]).filter(|&j| edge_ok(&rest[1..1 + j])) {
                Some(j) => {
                    let at = out.len();
                    inline(&rest[1..1 + j], out, marks);
                    mark(marks, at, out.len(), Mark::Italic);
                    i += j + 2;
                }
                None => {
                    out.push('*');
                    i += 1;
                }
            },
            b'[' if i == 0 || b[i - 1] != b'!' => {
                let link = label_end(b, i).and_then(|j| {
                    let k = paren.at(s, j + 2, |t| t.find(')'))?;
                    // the address is all of one piece: no space in it, and no bracket opened
                    let whole = space.at(s, j + 2, |t| t.find(char::is_whitespace)).is_none_or(|w| w > k) && opening.at(s, j + 2, |t| t.find('(')).is_none_or(|w| w > k);
                    (j > i + 1 && k > j + 2 && whole).then_some((&s[i + 1..j], &s[j + 2..k], k + 1))
                });
                match link {
                    Some((label, url, end)) => {
                        let at = out.len();
                        inline(label, out, marks);
                        mark(marks, at, out.len(), Mark::Link(url.to_owned()));
                        i = end;
                    }
                    None => {
                        out.push('[');
                        i += 1;
                    }
                }
            }
            _ => {
                let n = rest.chars().next().map_or(1, char::len_utf8);
                out.push_str(&rest[..n]);
                i += n;
            }
        }
    }
}

/// A mark's place in the nesting, outermost first. `None` for marks Markdown
/// has no way to write.
fn rank(m: &Mark) -> Option<u8> {
    match m {
        Mark::Link(_) => Some(0),
        Mark::Bold => Some(1),
        Mark::Italic => Some(2),
        Mark::Strike => Some(3),
        Mark::Code => Some(4),
        _ => None,
    }
}

fn open(m: &Mark) -> &str {
    match m {
        Mark::Link(_) => "[",
        Mark::Bold => "**",
        Mark::Italic => "*",
        Mark::Strike => "~~",
        _ => "`",
    }
}

/// Where a backslash goes into a link's text so that it reads back as
/// the link: before a `[`, which would open a label of its own, before a
/// `]` that a `(` follows, which would end this one early, and at the
/// end after a backslash left alone, which would escape the bracket
/// that closes it. What the text escapes already is left as it is. The
/// places are in order, each counted in the text as it was given.
pub fn label_escapes(text: &str) -> Vec<usize> {
    let b = text.as_bytes();
    let (mut out, mut run) = (Vec::new(), 0usize);
    for p in 0..b.len() {
        if b[p] == b'\\' {
            run += 1;
            continue;
        }
        if (b[p] == b'[' || (b[p] == b']' && b.get(p + 1) == Some(&b'('))) && run % 2 == 0 {
            out.push(p);
        }
        run = 0;
    }
    if run % 2 == 1 {
        out.push(b.len());
    }
    out
}

/// The marks of a document, for finding those on each of its lines in
/// turn: they are put in order once, and a line is given only its own.
struct Marked<'a> {
    /// Each mark Markdown can write, with its place in the document's list, by where it starts.
    all: Vec<(usize, &'a MarkRange)>,
    next: usize,
    /// The marks that began before the line now asked for and have not ended.
    open: Vec<(usize, &'a MarkRange)>,
}

impl<'a> Marked<'a> {
    fn new(marks: &'a [MarkRange]) -> Self {
        let mut all: Vec<(usize, &MarkRange)> = marks.iter().enumerate().filter(|(_, m)| rank(&m.mark).is_some()).collect();
        all.sort_by_key(|(_, m)| m.start);
        Marked { all, next: 0, open: Vec::new() }
    }

    /// The marks on the line from `start` to `end`, in the document's own order. Lines are asked for in order.
    fn on(&mut self, start: usize, end: usize) -> Vec<&'a MarkRange> {
        self.open.retain(|(_, m)| m.end > start);
        while let Some(&(n, m)) = self.all.get(self.next).filter(|(_, m)| m.start < end) {
            if m.end > start {
                self.open.push((n, m));
            }
            self.next += 1;
        }
        let mut on = self.open.clone();
        on.sort_by_key(|(n, _)| *n);
        on.into_iter().map(|(_, m)| m).collect()
    }
}

/// A piece of a line as it is written: a mark opened, a mark closed, or text.
enum Piece {
    Open(usize),
    Close(usize),
    Text(usize, usize),
}

/// Writes one line's text with its marks as Markdown. `at` is where the line
/// starts in the document, which is what the marks' offsets count from, and
/// `marks` are the marks on this line. The work is by the marks on the line
/// and its length, not the one times the other.
fn emit_inline(line: &str, at: usize, marks: &[&MarkRange], out: &mut String) {
    // the kinds of mark on this line, each once, and where each lies on it
    let mut kinds: Vec<&Mark> = Vec::new();
    let mut spans: Vec<Vec<(usize, usize)>> = Vec::new();
    let mut known: std::collections::HashMap<(u8, &str), usize> = std::collections::HashMap::new();
    // a character carries a mark when its first byte is inside it
    let snap = |p: usize| {
        let mut p = p.min(line.len());
        while !line.is_char_boundary(p) {
            p += 1;
        }
        p
    };
    for m in marks.iter().filter(|m| m.start < at + line.len() && m.end > at) {
        let Some(r) = rank(&m.mark) else { continue };
        let url = if let Mark::Link(u) = &m.mark { u.as_str() } else { "" };
        let k = *known.entry((r, url)).or_insert_with(|| {
            kinds.push(&m.mark);
            spans.push(Vec::new());
            kinds.len() - 1
        });
        let (a, z) = (snap(m.start.saturating_sub(at)), snap(m.end.saturating_sub(at)));
        if z > a {
            spans[k].push((a, z));
        }
    }
    if kinds.is_empty() {
        out.push_str(line);
        return;
    }
    // outermost first, and marks of one rank in the order they came
    let mut order: Vec<usize> = (0..kinds.len()).collect();
    order.sort_by_key(|&k| rank(kinds[k]));
    let kinds: Vec<&Mark> = order.iter().map(|&k| kinds[k]).collect();
    let mut spans: Vec<Vec<(usize, usize)>> = order.iter().map(|&k| std::mem::take(&mut spans[k])).collect();
    // each kind's stretches, in order, with those that touch made one
    for sp in &mut spans {
        sp.sort_unstable();
        let mut joined: Vec<(usize, usize)> = Vec::with_capacity(sp.len());
        for &(a, z) in sp.iter() {
            match joined.last_mut() {
                Some(last) if a <= last.1 => last.1 = last.1.max(z),
                _ => joined.push((a, z)),
            }
        }
        *sp = joined;
    }
    let code = kinds.iter().position(|k| **k == Mark::Code);
    let coded: Vec<(usize, usize)> = code.map_or(Vec::new(), |c| spans[c].clone());
    // the stretch of code that `p` is strictly inside
    let inside = |p: usize| {
        let n = coded.partition_point(|c| c.0 < p);
        n.checked_sub(1).map(|n| coded[n]).filter(|c| c.1 > p)
    };
    for (k, sp) in spans.iter_mut().enumerate() {
        if Some(k) == code {
            continue;
        }
        sp.retain_mut(|(a, z)| {
            // one stretch of code: another mark covers all of it or none
            if let Some(c) = inside(*a) {
                *a = c.1;
            }
            if let Some(c) = inside(*z).filter(|_| *z > *a) {
                *z = c.0;
            }
            if *z <= *a {
                return false;
            }
            // a marker beside a space is not a marker in Markdown: pull each
            // stretch in to its first and last character that is not one
            let text = &line[*a..*z];
            *a += text.len() - text.trim_start().len();
            *z = *a + line[*a..*z].trim_end().len();
            *z > *a
        });
    }
    // where a mark starts or ends: nothing changes between two such places
    let mut edges: Vec<(usize, bool, usize)> = Vec::new();
    for (k, sp) in spans.iter().enumerate() {
        for &(a, z) in sp {
            edges.push((a, true, k));
            edges.push((z, false, k));
        }
    }
    edges.sort_unstable();
    let mut pieces: Vec<Piece> = Vec::new();
    let mut want: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    let (mut stack, mut held): (Vec<usize>, Vec<bool>) = (Vec::new(), vec![false; kinds.len()]);
    let (mut e, mut from) = (0, 0);
    while e < edges.len() {
        let x = edges[e].0;
        if x > from {
            pieces.push(Piece::Text(from, x));
            from = x;
        }
        while let Some(&(_, starts, k)) = edges.get(e).filter(|edge| edge.0 == x) {
            if starts {
                want.insert(k);
            } else {
                want.remove(&k);
            }
            e += 1;
        }
        // marks that cross are closed and opened again, never interleaved
        if let Some(cut) = stack.iter().position(|k| !want.contains(k)) {
            for k in stack.drain(cut..).rev() {
                held[k] = false;
                pieces.push(Piece::Close(k));
            }
        }
        for &k in &want {
            if !held[k] {
                held[k] = true;
                stack.push(k);
                pieces.push(Piece::Open(k));
            }
        }
    }
    if from < line.len() {
        pieces.push(Piece::Text(from, line.len()));
    }
    // how code is written: fenced as `code_fence` says, or between single backticks as it was before
    // fences were, or as plain text with no mark
    #[derive(Clone, Copy, PartialEq)]
    enum Code {
        Fenced,
        Single,
        Plain,
    }
    let write = |how: Code| {
        let mut out = String::with_capacity(line.len() + 8 * pieces.len());
        // how many links are open, and the fence of the code that is
        let (mut links, mut fence) = (0usize, (1usize, false));
        for (n, piece) in pieces.iter().enumerate() {
            match *piece {
                Piece::Open(k) => match kinds[k] {
                    Mark::Code if how == Code::Plain => {}
                    Mark::Code => {
                        // the fence is longer than any run of backticks in the code it holds
                        let held: String = pieces[n + 1..].iter().take_while(|p| !matches!(p, Piece::Close(c) if *c == k)).filter_map(|p| if let Piece::Text(a, z) = *p { Some(&line[a..z]) } else { None }).collect();
                        fence = if how == Code::Fenced { code_fence(&held) } else { (1, false) };
                        out.push_str(&"`".repeat(fence.0));
                        out.push_str(if fence.1 { " " } else { "" });
                    }
                    Mark::Link(_) => {
                        links += 1;
                        out.push('[');
                    }
                    m => out.push_str(open(m)),
                },
                Piece::Close(k) => match kinds[k] {
                    Mark::Code if how == Code::Plain => {}
                    Mark::Code => {
                        out.push_str(if fence.1 { " " } else { "" });
                        out.push_str(&"`".repeat(fence.0));
                    }
                    Mark::Link(url) => {
                        links -= 1;
                        // a backslash left alone before the closing bracket would escape it
                        if let Some(Piece::Text(a, z)) = n.checked_sub(1).map(|n| &pieces[n]) {
                            if label_escapes(&line[*a..*z]).last() == Some(&(*z - *a)) {
                                out.push('\\');
                            }
                        }
                        out.push_str("](");
                        out.push_str(url);
                        out.push(')');
                    }
                    m => out.push_str(open(m)),
                },
                Piece::Text(a, z) if links == 0 => out.push_str(&line[a..z]),
                Piece::Text(a, z) => {
                    // in a link's text a bracket that would open a label or close this one is escaped,
                    // unless the text escapes it already
                    let mut done = a;
                    for p in label_escapes(&line[a..z]).into_iter().filter(|p| *p < z - a) {
                        out.push_str(&line[done..a + p]);
                        out.push('\\');
                        done = a + p;
                    }
                    out.push_str(&line[done..z]);
                }
            }
        }
        out
    };
    if code.is_none() {
        out.push_str(&write(Code::Fenced));
        return;
    }
    // A fence stands beside whatever the text has round it: a backtick just outside the code joins it,
    // and a backslash before it escapes its first backtick. So what was written is read back, and it
    // is kept only if it reads as the same text. Fenced first, which also reads back as the same
    // marks wherever anything does. Then single backticks, which is how code was always written. And
    // if neither keeps the text, the text is written with no code mark: a mark may be lost, a
    // character of the page may not
    let reads = |written: &str| {
        let (mut text, mut got) = (String::new(), Vec::new());
        inline(written, &mut text, &mut got);
        // the marks read, each kind's stretches joined as the ones written were
        let same = text == line && {
            let mut read: Vec<Vec<(usize, usize)>> = vec![Vec::new(); kinds.len()];
            let known = got.iter().all(|m| match kinds.iter().position(|k| **k == m.mark) {
                Some(k) => {
                    read[k].push((m.start, m.end));
                    true
                }
                None => false,
            });
            known
                && read.iter_mut().zip(&spans).all(|(r, want)| {
                    r.sort_unstable();
                    let mut joined: Vec<(usize, usize)> = Vec::new();
                    for &(a, z) in r.iter() {
                        match joined.last_mut() {
                            Some(last) if a <= last.1 => last.1 = last.1.max(z),
                            _ => joined.push((a, z)),
                        }
                    }
                    joined == *want
                })
        };
        // three backticks at the start of a line open a block of code, and the line is then read as it is written
        let block = fence(written) && written != line;
        (text == line && !block, same && !block)
    };
    let mut kept: Option<String> = None;
    let mut first = None;
    for how in [Code::Fenced, Code::Single, Code::Plain] {
        let written = write(how);
        let (text, marks) = reads(&written);
        if marks {
            kept = Some(written);
            break;
        }
        if text && kept.is_none() {
            kept = Some(written);
        } else if first.is_none() {
            first = Some(written);
        }
    }
    // nothing keeps the text when the text itself reads as Markdown: it is written as it always was
    out.push_str(&kept.or(first).unwrap_or_default());
}

/// How many newlines the page wrote between two lines, keyed by the two
/// lines as written. Markdown lets a list sit right under a paragraph or
/// leaves a blank line between items, and the model has no place for that,
/// so the page's own choices are kept here and used again for every pair of
/// lines the owner has not changed. A changed pair gets the usual spacing.
pub type Seps = std::collections::HashMap<(String, String), u8>;

/// One written line, and what the spacing rule needs to know about it.
struct Line {
    s: String,
    block: Block,
    soft: bool,
    /// A code line that closed its fence: what follows is a new block.
    closes: bool,
}

/// The usual number of newlines between two lines.
fn usual(prev: &Line, l: &Line) -> u8 {
    let (p, b) = (prev.block, l.block);
    let tight = l.soft || (!prev.closes && ((p == Block::Code && b == Block::Code) || (is_list(p) && is_list(b) && same_list(p, b)) || (p == Block::Quote && b == Block::Quote)));
    if tight { 1 } else { 2 }
}

/// The document as Markdown, ending in a newline when it has any text.
pub fn emit(text: &str, marks: &[MarkRange], blocks: &[Block], soft: &[u32]) -> String {
    emit_with(text, marks, blocks, soft, &Seps::default())
}

/// [`emit`], spaced as the page it was read from was (`seps`).
pub fn emit_with(text: &str, marks: &[MarkRange], blocks: &[Block], soft: &[u32], seps: &Seps) -> String {
    let mut lines: Vec<Line> = Vec::new();
    let mut at = 0;
    let mut counts = [0u32; 4];
    // whether a fence is open, and whether it is one the editor wrote itself
    let (mut fenced, mut made) = (false, false);
    let ticks = |closes| Line { s: "```".into(), block: Block::Code, soft: false, closes };
    let soft: std::collections::HashSet<u32> = soft.iter().copied().collect();
    let mut marked = Marked::new(marks);
    for (n, line) in text.split('\n').enumerate() {
        let block = blocks.get(n).copied().unwrap_or_default();
        let is_soft = n > 0 && soft.contains(&(n as u32)) && block != Block::Code;
        let start = at;
        at += line.len() + 1;
        // a paragraph the editor left empty is not written
        if block == Block::Paragraph && line.is_empty() {
            continue;
        }
        if made && block != Block::Code {
            lines.push(ticks(true));
            made = false;
        }
        if !is_list(block) {
            counts = [0; 4];
        }
        let mut s = String::new();
        let mut closes = false;
        if block == Block::Code {
            if fenced {
                fenced = !fence(line);
                closes = !fenced;
            } else if fence(line) {
                fenced = true;
            } else if !made {
                lines.push(ticks(false));
                made = true;
            }
            s.push_str(line);
        } else {
            if !is_soft {
                match block {
                    Block::Bullet(l) => {
                        let l = (l as usize).min(3);
                        counts[l + 1..].fill(0);
                        s.push_str(&"  ".repeat(l));
                        s.push_str("- ");
                    }
                    Block::Numbered(l) => {
                        let l = (l as usize).min(3);
                        counts[l] += 1;
                        counts[l + 1..].fill(0);
                        s.push_str(&"   ".repeat(l));
                        s.push_str(&format!("{}. ", counts[l]));
                    }
                    Block::Quote => s.push_str("> "),
                    _ => {}
                }
            }
            emit_inline(line, start, &marked.on(start, start + line.len()), &mut s);
        }
        lines.push(Line { s, block, soft: is_soft, closes });
    }
    if made {
        lines.push(ticks(true));
    }
    let mut out = String::new();
    for (i, l) in lines.iter().enumerate() {
        if i > 0 {
            let prev = &lines[i - 1];
            // a pair of lines the owner changed gets the usual spacing and no other: a line that was a
            // paragraph of its own keeps its blank line, whatever stands round it. Nothing is drawn up
            // under the line above because it looks like a table's row or a line of front matter
            let n = if l.soft { 1 } else { seps.get(&(prev.s.clone(), l.s.clone())).copied().unwrap_or_else(|| usual(prev, l)) };
            out.push_str(&"\n".repeat(n as usize));
        }
        out.push_str(&l.s);
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_html_in_a_page_is_made_into_what_the_reader_draws() {
        // nothing to do is nothing done, byte for byte
        for same in ["plain *text*\n", "a < b and `<br>` in code\n", "```\n<div>x</div>\n```\n"] {
            assert_eq!(html_shown(same), same);
        }
        assert_eq!(html_shown("one<br>two<br/>three\n"), "one\\\ntwo\\\nthree\n");
        assert_eq!(html_shown("press <kbd>Ctrl</kbd> and <b>hold</b>, <em>then</em> <del>not</del>\n"), "press `Ctrl` and **hold**, *then* ~~not~~\n");
        // a tag with no partner is left alone, so no mark is opened that nothing closes
        assert_eq!(html_shown("a <b>bold and no end\n"), "a <b>bold and no end\n");
        assert_eq!(html_shown("[a](<b>c)\n"), "[a](<b>c)\n");
        // an HTML block set in by a space or two is still one
        assert!(html_shown(" <div>\n  *hello*\n </div>\n").contains("hello"));
        // a tag with no Markdown of its own is left for the reader to leave out
        assert_eq!(html_shown("H<sub>2</sub>O\n"), "H<sub>2</sub>O\n");
        // a block of HTML is read as a document: its words are kept, where the reader would have dropped them
        let div = html_shown("before\n\n<div>\n<em>Emphasized</em> text.\n</div>\n\nafter\n");
        assert!(div.contains("Emphasized") && div.contains("text.") && !div.contains("<div>"), "{div}");
        assert!(div.starts_with("before\n") && div.trim_end().ends_with("after"));
        let table = html_shown("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>\n");
        assert!(table.contains('|') && table.contains('A') && table.contains('2'), "{table}");
        // a comment is nothing, and HTML held by a list is left as it was
        assert_eq!(html_shown("<!-- note -->\n\ntext\n").trim(), "text");
        assert_eq!(html_shown("- item\n\n  <div>x</div>\n"), "- item\n\n  <div>x</div>\n");
        // a break in a table's cell is a space, since a cell is one line
        assert_eq!(html_shown("| a |\n|---|\n| x<br>y |\n"), "| a |\n|---|\n| x y |\n");
    }

    fn m(start: usize, end: usize, mark: Mark) -> MarkRange {
        MarkRange { start, end, mark }
    }

    /// How many pages of a real tree the rich editor would open, and why the
    /// rest are refused: `LATTICE_DUMP=page-dump.json cargo test -- --ignored corpus --nocapture`.
    #[test]
    #[ignore]
    fn corpus() {
        let raw = std::fs::read_to_string(std::env::var("LATTICE_DUMP").unwrap()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let (mut ok, mut all) = (0, 0);
        let mut why: std::collections::BTreeMap<&str, u32> = Default::default();
        for n in v["nodes"].as_array().unwrap() {
            let (Some("md"), Some(body)) = (n["kind"].as_str(), n["body"].as_str()) else { continue };
            all += 1;
            if exact(body).is_some() {
                ok += 1;
                continue;
            }
            let d = parse(body);
            let out = emit_with(&d.text, &d.marks, &d.blocks, &d.soft, &d.seps);
            // the first line that differs says what kind of page this is
            let (a, b) = body.lines().zip(out.lines()).find(|(a, b)| a != b).unwrap_or(("<length>", ""));
            let kind = if body.contains('\r') { "carriage returns" }
                else if a.is_empty() && !b.is_empty() { "blank line the editor would drop" }
                else if b.is_empty() && !a.is_empty() { "blank line the editor would add" }
                else if a.trim_start().starts_with(|c: char| c.is_ascii_digit()) { "numbering" }
                else if a.starts_with(' ') || a.starts_with('\t') { "indentation" }
                else if a == "<length>" { "trailing lines" }
                else { "inline" };
            *why.entry(kind).or_default() += 1;
            if kind == "inline" && why[kind] <= 6 {
                eprintln!("inline: {a:?}\n     -> {b:?}");
            }
        }
        eprintln!("{ok} of {all} Markdown pages open rich. Refused: {why:?}");
    }

    #[test]
    fn inline_markers_become_marks_and_leave_the_text() {
        let d = parse("a **bold** and *it* and ~~gone~~ and `code` and [site](https://x.y/z)\n");
        assert_eq!(d.text, "a bold and it and gone and code and site");
        assert_eq!(
            d.marks,
            vec![m(2, 6, Mark::Bold), m(11, 13, Mark::Italic), m(18, 22, Mark::Strike), m(27, 31, Mark::Code), m(36, 40, Mark::Link("https://x.y/z".into()))]
        );
    }

    #[test]
    fn blocks_follow_their_markers_and_a_line_below_continues() {
        let d = parse("# Title\n\ntext\nmore\n\n- one\n  - two\n1. first\n2. second\n\n> said\n\n```rust\nlet a = *b;\n```\n");
        assert_eq!(d.text, "# Title\ntext\nmore\none\ntwo\nfirst\nsecond\nsaid\n```rust\nlet a = *b;\n```");
        use Block::*;
        assert_eq!(d.blocks, vec![Paragraph, Paragraph, Paragraph, Bullet(0), Bullet(1), Numbered(0), Numbered(0), Quote, Code, Code, Code]);
        assert_eq!(d.soft, vec![2]);
        assert!(d.marks.is_empty(), "nothing inside a fence is a mark");
    }

    #[test]
    fn pages_the_model_holds_come_back_byte_for_byte() {
        for src in [
            "# Title\n\nA **bold** move, *really*, with `code` and a [link](https://a.b).\n",
            "- one\n- two\n  - nested **deep**\n- three\n\n1. first\n2. second\n",
            "> quoted\n> again\n\nafter\n",
            "```rust\nfn main() {\n\n    let x = \"**not bold**\";\n}\n```\n\ntext\n\n```\nsecond\n```\n",
            "| a | b |\n| --- | --- |\n| **1** | 2 |\n",
            "line one\nline two\n\n---\n\n![pic](a.png) and snake_case_name and 2 * 3 * 4\n",
            "***both*** and **a *b*** and *a **b*** and **a***b*\n",
            "- [ ] task\n- [x] done\n",
            // not a list the model knows: kept as the text it is
            "* star bullets\n* here\n",
            // spacing the model has no place for is kept beside it
            "- loose\n\n- list\n",
            "a\n\n\nb\n",
            "text:\n- list right under\n- two\nand text right under\n",
            "> a\n\n> b\n",
            "no final newline",
            "",
        ] {
            assert!(exact(src).is_some(), "not exact: {src:?} became {:?}", {
                let d = parse(src);
                emit_with(&d.text, &d.marks, &d.blocks, &d.soft, &d.seps)
            });
        }
    }

    #[test]
    fn pages_it_would_change_are_refused() {
        for src in ["1. one\n1. one again\n", "\r\nwindows\r\n", "\nleading blank\n", "same\nsame\n\nsame\n\n\nsame\n"] {
            assert!(exact(src).is_none(), "should be refused: {src:?}");
        }
    }

    #[test]
    fn nested_marks_parse_as_they_were_written() {
        let d = parse("***both*** **a *b*** *a **b***");
        assert_eq!(d.text, "both a b a b");
        assert_eq!(
            d.marks,
            vec![m(0, 4, Mark::Italic), m(0, 4, Mark::Bold), m(7, 8, Mark::Italic), m(5, 8, Mark::Bold), m(11, 12, Mark::Bold), m(9, 12, Mark::Italic)]
        );
    }

    #[test]
    fn edited_marks_are_written_as_valid_markdown() {
        use Block::Paragraph as P;
        // a mark that ends in a space closes before it
        assert_eq!(emit("make this bold now", &[m(5, 15, Mark::Bold)], &[P], &[]), "make **this bold** now\n");
        // marks that cross are closed and opened again, never interleaved
        assert_eq!(emit("abcdef", &[m(0, 4, Mark::Bold), m(2, 6, Mark::Italic)], &[P], &[]), "**ab*cd****ef*\n");
        assert_eq!(parse("**ab*cd****ef*").marks, vec![m(2, 4, Mark::Italic), m(0, 4, Mark::Bold), m(4, 6, Mark::Italic)]);
        // a mark that cuts into code is dropped from the code
        assert_eq!(emit("see code here", &[m(4, 8, Mark::Code), m(0, 6, Mark::Bold)], &[P], &[]), "**see** `code` here\n");
        // and one that covers it wraps it
        assert_eq!(emit("see code", &[m(4, 8, Mark::Code), m(0, 8, Mark::Bold)], &[P], &[]), "**see `code`**\n");
        // underline has no Markdown, a mark over only spaces is nothing
        assert_eq!(emit("a   b", &[m(0, 5, Mark::Underline), m(1, 4, Mark::Bold)], &[P], &[]), "a   b\n");
        assert_eq!(emit("go there", &[m(3, 8, Mark::Link("u".into())), m(3, 8, Mark::Bold)], &[P], &[]), "go [**there**](u)\n");
    }

    #[test]
    fn edited_blocks_are_written_as_valid_markdown() {
        use Block::*;
        // a code block made in the editor gets its fence, lists count, empty paragraphs go
        assert_eq!(emit("intro\n\nlet a;\nlet b;\nend", &[], &[Paragraph, Paragraph, Code, Code, Paragraph], &[]), "intro\n\n```\nlet a;\nlet b;\n```\n\nend\n");
        assert_eq!(emit("a\nb\nc\nd", &[], &[Numbered(0), Numbered(1), Numbered(1), Numbered(0)], &[]), "1. a\n   1. b\n   2. c\n2. d\n");
        assert_eq!(emit("one\nmore\ntwo", &[], &[Bullet(0), Bullet(0), Bullet(0)], &[1]), "- one\nmore\n- two\n");
        assert_eq!(emit("code", &[], &[Code], &[]), "```\ncode\n```\n");
    }

    #[test]
    fn what_the_editor_writes_reads_back_the_same() {
        use Block::*;
        let out = emit("see this and that\nitem", &[m(4, 8, Mark::Bold), m(4, 8, Mark::Italic), m(13, 17, Mark::Strike)], &[Paragraph, Bullet(0)], &[]);
        assert_eq!(out, "see ***this*** and ~~that~~\n\n- item\n");
        let d = exact(&out).expect("its own output is exact");
        assert_eq!(d.text, "see this and that\nitem");
        assert_eq!(d.blocks, vec![Paragraph, Bullet(0)]);
    }

    #[test]
    fn wiki_links_become_links_the_reader_can_follow() {
        let wikilinks = |s: &str| wikilinks(s, &|_| false);
        assert_eq!(wikilinks("see [[notes/today]] and [[My Page|that one]]\n"), "see [notes/today](lattice:notes/today) and [that one](lattice:My%20Page)\n");
        // code is left alone, and so is what is not a link
        let kept = "`[[not]]` and [[ ]] and [[open\n```\n[[in a fence]]\n```\n";
        assert_eq!(wikilinks(kept), kept);
        assert_eq!(page_of("lattice:My%20Page").as_deref(), Some("My Page"));
        assert_eq!(page_of("/apps/lattice/page/notes/today#top").as_deref(), Some("notes/today"));
        assert_eq!(page_of("https://urbit.org"), None);
        assert_eq!(page_of("lattice:"), None);
    }

    #[test]
    fn a_pages_images_are_listed_and_the_ones_from_other_sites_told_apart() {
        let src = "![a](https://x.org/a.png) and ![b](/apps/lattice/f/b.png \"title\")\n![a again](https://x.org/a.png)\n```\n![in code](http://no.org/c.png)\n```\n![rel](pics/d.jpg) ![]() ![open](\n";
        assert_eq!(images(src), ["https://x.org/a.png", "/apps/lattice/f/b.png", "pics/d.jpg"]);
        assert!(images("no images, only a [link](https://x.org)").is_empty());
        assert!(remote("https://x.org/a.png") && remote("HTTP://x.org") && remote("//cdn.x.org/a.png"));
        assert!(!remote("/apps/lattice/f/b.png") && !remote("pics/d.jpg") && !remote("data:image/png;base64,AAAA"));
    }

    #[test]
    fn a_wiki_link_being_typed_is_found_at_the_caret() {
        let t = "one [[a]] two\nsee [[notes/to";
        assert_eq!(link_query(t, t.len()), Some((t.len() - 8, "notes/to")));
        assert_eq!(link_query("[[", 2), Some((2, "")));
        // closed, on another line, not a name, or no link at all
        assert_eq!(link_query("[[a]] b", 7), None);
        assert_eq!(link_query("[[a\nb", 5), None);
        assert_eq!(link_query("[[a b", 5), None);
        assert_eq!(link_query("[[a|label", 9), None);
        assert_eq!(link_query("plain", 5), None);
        // the caret mid-text sees only what is before it
        assert_eq!(link_query("[[abc]]", 4), Some((2, "ab")));
        assert_eq!(journal_day("2026-11-17").as_deref(), Some("journal/2026-11-17"));
        assert_eq!(journal_day("2026-11-1"), None);
        assert_eq!(journal_day("2026/11/17"), None);
        // a wiki link typed in the rich editor is written as it was typed
        let src = "see [[notes/today]] and [[2026-11-17]]\n";
        let d = exact(src).expect("a page with wiki links opens rich");
        assert_eq!(emit(&d.text, &d.marks, &d.blocks, &d.soft), src);
    }

    #[test]
    fn a_pages_links_out_are_listed_once_and_a_ghost_shows_in_italics() {
        let src = "[[a]] then [[b/c|label]], [[a]] again, [web](https://x.org), [in](/apps/lattice/page/d) and `[[code]]`\n";
        assert_eq!(links(src), ["a", "b/c", "d"]);
        assert!(links("no links here").is_empty());
        assert_eq!(super::wikilinks("[[a]] [[b|B]]", &|n| n == "b"), "[a](lattice:a) [*B*](lattice:b)");
    }

    #[test]
    fn deep_nesting_is_drawn_in() {
        // what is not deep is not touched, and not copied
        assert!(matches!(shallow("> a\n\n- one\n  - two\n"), std::borrow::Cow::Borrowed(_)));
        let plain = "> a\n\n```\n>>>>>>>>>>>>>>>>>>>> kept\n```\n";
        assert_eq!(shallow(plain), plain);
        // forty quotes become eight, and the word stays
        let deep = format!("{} x\n", ">".repeat(40));
        assert_eq!(shallow(&deep), format!("{} x\n", ">".repeat(NEST_MOST)));
        let lists = format!("{}x\n", "- ".repeat(30));
        assert_eq!(shallow(&lists), format!("{}x\n", "- ".repeat(NEST_MOST)));
        let mixed = format!("{}word\n", "> - 1. ".repeat(10));
        let out = shallow(&mixed).into_owned();
        assert!(out.ends_with("word\n") && out.matches('>').count() + out.matches("- ").count() + out.matches("1. ").count() == NEST_MOST, "{out}");
        // a deep indent is drawn in
        assert_eq!(shallow(&format!("{}- x\n", " ".repeat(200))), format!("{}- x\n", " ".repeat(NEST_MOST * 4)));
        // code in a fence is left alone beside a deep line
        let both = format!("```\n{} code\n```\n{} x\n", ">".repeat(40), ">".repeat(40));
        assert!(shallow(&both).starts_with(&format!("```\n{} code\n```\n", ">".repeat(40))));
        // multibyte text after the markers is not cut inside a character
        let wide = format!("{}é☃\n", "> ".repeat(20));
        assert!(shallow(&wide).ends_with("é☃\n"));
    }

    #[test]
    fn a_line_of_many_openings_is_read_once() {
        let line = format!("{}]]\n", "[[".repeat(50_000));
        let t = std::time::Instant::now();
        let _ = wikilinks(&line, &|_| false);
        assert!(t.elapsed().as_secs() < 8);
        assert_eq!(wikilinks("see [[a|b]] and [[c]]", &|_| false), "see [b](lattice:a) and [c](lattice:c)");
    }

    #[test]
    fn spacing_is_kept_for_lines_left_alone_and_usual_for_changed_ones() {
        use Block::*;
        let src = "intro:\n- one\n\n- two\n";
        let d = exact(src).unwrap();
        // the second item is edited: its pair is new, so it gets a list's usual spacing
        let text = d.text.replace("two", "2");
        assert_eq!(emit_with(&text, &d.marks, &d.blocks, &d.soft, &d.seps), "intro:\n- one\n- 2\n");
        // a line added between keeps the spacing above it and below it is usual
        assert_eq!(emit_with("intro:\none\nnew\ntwo", &[], &[Paragraph, Bullet(0), Bullet(0), Bullet(0)], &[], &d.seps), "intro:\n- one\n- new\n- two\n");
    }

    /// Numbers that are the same on every run.
    struct Rng(u64);

    impl Rng {
        fn below(&mut self, n: usize) -> usize {
            self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 33) as usize % n
        }

        fn pick<'a>(&mut self, of: &[&'a str]) -> &'a str {
            of[self.below(of.len())]
        }
    }

    /// One line of text, of pieces that are or look like inline Markdown.
    fn some_line(r: &mut Rng) -> String {
        const PIECES: [&str; 44] = [
            "word", "two words", "é☃", "日本語", "snake_case_name", "2 * 3 * 4", "**bold**", "*it*", "~~gone~~", "`code`", "``a`b``", "`` `t ``", "`` a`b ``", "```x``y```", "``plain``", "[link](https://a.b/c)",
            "[a\\[b](http://u)", "[a\\](b](u)", "[a]b](u)", "[**b** and *i*](u)", "[[wiki]]", "[[a|b]]", "\\*", "\\[", "\\\\", "![pic](a.png)", "***both***", "**a *b***", "*a **b***", "[^1]", "a]b", "(x)", "`", "*", "**", "[",
            "](", "~~", "<b>", "a\\", "[x](a b)", "[x]()", "[é](é)", "**é☃**",
        ];
        let n = 1 + r.below(5);
        let mut out = String::new();
        for i in 0..n {
            if i > 0 && r.below(4) > 0 {
                out.push(' ');
            }
            out.push_str(r.pick(&PIECES));
        }
        out
    }

    /// A page of blocks of every kind the model knows and some it does not.
    fn some_page(r: &mut Rng) -> String {
        let mut out = String::new();
        for _ in 0..1 + r.below(7) {
            match r.below(11) {
                0 => out.push_str(&format!("{} {}\n", r.pick(&["#", "##", "###"]), some_line(r))),
                1 => {
                    // a paragraph, its lines broken softly or hard
                    for _ in 0..1 + r.below(3) {
                        out.push_str(&format!("{}{}\n", some_line(r), r.pick(&["", "", "\\", "  "])));
                    }
                }
                2 => {
                    for i in 0..1 + r.below(4) {
                        out.push_str(&format!("{}- {}\n", "  ".repeat(r.below(3).min(i)), some_line(r)));
                    }
                }
                3 => {
                    for i in 0..1 + r.below(3) {
                        out.push_str(&format!("{}. {}\n", i + 1, some_line(r)));
                        if r.below(3) == 0 {
                            out.push_str(&format!("   1. {}\n", some_line(r)));
                        }
                    }
                }
                4 => out.push_str(&format!("> {}\n> {}\n", some_line(r), some_line(r))),
                5 => out.push_str(&format!("| a | {} |\n| --- | --- |\n| {} | 2 |\n", some_line(r), some_line(r))),
                6 => out.push_str(&format!("```rust\n{}\n\n    let x = 1;\n```\n", some_line(r))),
                7 => out.push_str("---\n"),
                8 => out.push_str(&format!("- [ ] {}\n- [x] done\n", some_line(r))),
                9 => out.push_str(&format!("* {}\n+ other\n", some_line(r))),
                _ => out.push_str(&format!("{}\n", some_line(r))),
            }
            out.push_str(r.pick(&["\n", "\n", "\n", "", "\n\n"]));
        }
        if r.below(5) == 0 {
            out.truncate(out.trim_end_matches('\n').len());
        }
        out
    }

    #[test]
    fn generated_pages_open_rich_only_when_they_come_back_byte_for_byte() {
        let mut r = Rng(11);
        let mut rich = 0;
        for _ in 0..600 {
            let src = some_page(&mut r);
            let Some(d) = exact(&src) else { continue };
            rich += 1;
            let out = emit_with(&d.text, &d.marks, &d.blocks, &d.soft, &d.seps);
            assert!(out == src || out.strip_suffix('\n') == Some(src.as_str()), "opening {src:?} would write {out:?}");
            // and what was written reads as the same document, so a second save changes nothing either
            let again = parse(&out);
            assert_eq!((&again.text, &again.marks, &again.blocks, &again.soft), (&d.text, &d.marks, &d.blocks, &d.soft), "{src:?}");
            assert_eq!(emit_with(&again.text, &again.marks, &again.blocks, &again.soft, &again.seps), out);
        }
        assert!(rich > 150, "only {rich} of 600 generated pages open rich");
    }

    #[test]
    fn a_long_line_of_openings_of_any_kind_is_read_in_time() {
        // each of these, repeated on one line, once made the reading take a second for every few thousand
        let pieces = [
            "[a][b]", "[^1] ", "[[a|b]] ", "- [ ] ", "[", "[a](", "[a](b ", "[a](b(", "[a](b) ", "[a\\](", "\\[", "![", "*", "**", "***", "*a ", "**a ", "* ", "~~", "~~a ", "`", "``", "`` ` ", "```a`` ", "`a", "[**a](", "*[a", "[a]](u",
        ];
        for piece in pieces {
            let line = piece.repeat(140_000 / piece.len());
            let t = std::time::Instant::now();
            let d = parse(&line);
            let _ = emit_with(&d.text, &d.marks, &d.blocks, &d.soft, &d.seps);
            assert!(t.elapsed().as_millis() < 5000, "{piece:?} took {:?}", t.elapsed());
            // and on many lines
            let page = format!("{}\n", piece.repeat(20)).repeat(7000 / piece.len());
            let t = std::time::Instant::now();
            let _ = exact(&page);
            assert!(t.elapsed().as_millis() < 5000, "{piece:?} by lines took {:?}", t.elapsed());
        }
        // the page that was measured: 96 KB of labels with no address
        let t = std::time::Instant::now();
        assert!(exact(&"[a][b]".repeat(16_000)).is_some());
        assert!(t.elapsed().as_millis() < 5000, "{:?}", t.elapsed());
        // links are still links, an address with a space or a bracket in it is not one, and an image is left alone
        let d = parse("[a](u) [b](v w) [c](x(y) ![d](e) [f](g)");
        assert_eq!(d.text, "a [b](v w) [c](x(y) ![d](e) f");
        assert_eq!(d.marks, vec![m(0, 1, Mark::Link("u".into())), m(28, 29, Mark::Link("g".into()))]);
    }

    #[test]
    fn a_page_of_many_marks_is_written_by_the_marks_on_each_line() {
        // 6,000 marks on 1,500 lines, then the same on one line, then a line of links that each go somewhere else
        let lines = "**bold** and *it* and `code` and [site](https://x.y/z) end\n".repeat(1500);
        let one = lines.replace('\n', " ");
        let links: String = (0..3000).map(|i| format!("[l{i}](https://x.y/{i}) ")).collect();
        for src in [lines, one, links] {
            let d = parse(&src);
            assert!(d.marks.len() >= 3000);
            let t = std::time::Instant::now();
            let out = emit_with(&d.text, &d.marks, &d.blocks, &d.soft, &d.seps);
            assert!(t.elapsed().as_millis() < 5000, "{} marks took {:?}", d.marks.len(), t.elapsed());
            assert_eq!(out.trim_end(), src.trim_end());
        }
        // marks given out of order, and one over several lines, are still each on its own line
        use Block::Paragraph as P;
        assert_eq!(emit("ab\ncd\nef", &[m(6, 8, Mark::Italic), m(1, 7, Mark::Bold), m(0, 1, Mark::Strike)], &[P, P, P], &[]), "~~a~~**b**\n\n**cd**\n\n***e****f*\n");
    }

    #[test]
    fn code_with_a_backtick_in_it_is_fenced_so_it_reads_back_as_code() {
        use Block::Paragraph as P;
        for (text, a, z, want) in [
            ("say a`b now", 4, 7, "say ``a`b`` now\n"),
            ("say `a now", 4, 6, "say `` `a `` now\n"),
            ("say a` now", 4, 6, "say `` a` `` now\n"),
            ("say a``b`c now", 4, 10, "say ```a``b`c``` now\n"),
            ("say  a`b  now", 4, 9, "say ``  a`b  `` now\n"),
            ("say ` now", 4, 5, "say `` ` `` now\n"),
            // code with no backtick is written as it always was
            ("say  a  now", 4, 7, "say ` a ` now\n"),
        ] {
            let out = emit(text, &[m(a, z, Mark::Code)], &[P], &[]);
            assert_eq!(out, want);
            let d = exact(&out).expect("its own output is exact");
            assert_eq!((d.text.as_str(), &d.marks), (text, &vec![m(a, z, Mark::Code)]), "{out:?}");
        }
        // a fence the editor would not write is kept as the text it is, so the page is not rewritten
        for kept in ["a ``code`` b\n", "a `` x`y `` b\n", "a ```x`y``` b\n", "a ``x`y b\n"] {
            let d = exact(kept).expect("still opens rich");
            assert!(d.marks.iter().all(|k| d.text[k.start..k.end] != *"x`y" && d.text[k.start..k.end] != *"code"), "{kept:?} {:?}", d.marks);
        }
    }

    #[test]
    fn a_bracket_in_a_links_text_is_escaped_so_it_reads_back_as_the_link() {
        use Block::Paragraph as P;
        let link = || Mark::Link("http://u".into());
        for (text, want) in [("a[b", "[a\\[b](http://u)\n"), ("a](b", "[a\\](b](http://u)\n"), ("[", "[\\[](http://u)\n"), ("a\\", "[a\\\\](http://u)\n"), ("a]b]", "[a]b]](http://u)\n"), ("a\\[b", "[a\\[b](http://u)\n")] {
            let out = emit(text, &[m(0, text.len(), link())], &[P], &[]);
            assert_eq!(out, want);
            // read back, all of it is the link and nothing else is, and written again it is the same
            let d = exact(&out).unwrap_or_else(|| panic!("{out:?} is not exact"));
            assert_eq!(d.marks, vec![m(0, d.text.len(), link())], "{out:?}");
            assert_eq!(emit(&d.text, &d.marks, &d.blocks, &d.soft), out);
        }
        // a bracket outside a link is left as it was typed
        assert_eq!(emit("x[y go", &[m(4, 6, link())], &[P], &[]), "x[y [go](http://u)\n");
    }

    #[test]
    fn a_changed_line_beside_a_table_or_a_rule_keeps_its_blank_line() {
        // each page, what is changed in it, and to what: the page written is the page with that change and no other
        for (src, was, now) in [
            // a table's last row, and the first line of the paragraph after it
            ("| a | b |\n|---|---|\n| 1 | 2 |\n\nfirst line\nsecond line\n", "2", "3"),
            ("| a | b |\n|---|---|\n| 1 | 2 |\n\nfirst line\nsecond line\n", "first", "First"),
            ("| a | b |\n|---|---|\n| 1 | 2 |\n\n# Heading\nunder heading\n", "Heading", "Head"),
            ("a | b\n--|--\n1 | 2\n\nfirst line\nsecond line\n", "first", "First"),
            ("| a | b |\n|---|---|\n| 1 | 2 |\n\n| not a row\nsecond line\n", "not", "NOT"),
            ("| a |\n| --- |\n| 1 |\n\n| b |\n| --- |\n| 2 |\n", "| b |", "| c |"),
            // a rule that opens the page, and a line with a rule right under it later on
            ("---\n\nintro para\n\nnext para\nits second line\n---\n\nrest\n", "next", "Next"),
            ("---\n\na\n---\n", "a", "xa"),
            ("---\ntitle: x\n---\n\n# T\n\ntext\nmore\n", "text", "Text"),
            ("---\n\npara\nmore\n\n---\n", "para", "PARA"),
        ] {
            let d = exact(src).unwrap_or_else(|| panic!("{src:?} opens rich"));
            assert!(d.text.contains(was), "{src:?}");
            let out = emit_with(&d.text.replacen(was, now, 1), &d.marks, &d.blocks, &d.soft, &d.seps);
            assert_eq!(out, src.replacen(was, now, 1), "{src:?} with {was:?} made {now:?}");
        }
        // a line entered as a paragraph of its own is written as one, in a table too: the editor made it one
        let table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
        let d = exact(table).unwrap();
        let mut lines: Vec<&str> = d.text.split('\n').collect();
        lines.insert(3, "| x | y |");
        let mut blocks = d.blocks.clone();
        blocks.insert(3, Block::Paragraph);
        let soft: Vec<u32> = d.soft.iter().map(|n| if *n >= 3 { n + 1 } else { *n }).collect();
        assert_eq!(emit_with(&lines.join("\n"), &d.marks, &blocks, &soft, &d.seps), "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| x | y |\n| 3 | 4 |\n");
    }

    #[test]
    fn code_beside_a_backtick_or_a_backslash_never_changes_the_text() {
        use Block::Paragraph as P;
        // the cases a review found: each was written so that it read back as other text
        for (text, a, z) in [("!``", 0, 2), ("\\`a", 1, 3), ("``*a`", 3, 4), ("`a", 0, 2), ("a``", 0, 2), ("\\a`b", 1, 4)] {
            let out = emit(text, &[m(a, z, Mark::Code)], &[P], &[]);
            assert_eq!(parse(&out).text, text, "{text:?} with code over {a}..{z} was written {out:?}");
        }
        // every text of up to five of these characters, with code over every stretch of it
        let alphabet = ['`', '\\', ' ', '*', 'a'];
        let (mut all, mut whole, mut plain_kept) = (0, 0, 0);
        for len in 1..=5u32 {
            for n in 0..alphabet.len().pow(len) {
                let text: String = (0..len).map(|i| alphabet[n / alphabet.len().pow(i) % alphabet.len()]).collect();
                // a text that is not itself when written with no mark at all is Markdown the owner typed
                let plain = parse(&emit(&text, &[], &[P], &[])).text == text;
                for a in 0..text.len() {
                    for z in a + 1..=text.len() {
                        let out = emit(&text, &[m(a, z, Mark::Code)], &[P], &[]);
                        let back = parse(&out);
                        all += 1;
                        if plain {
                            plain_kept += 1;
                            assert_eq!(back.text, text, "{text:?} with code over {a}..{z} was written {out:?}");
                        }
                        // and written again it is the same line: nothing drifts from save to save
                        if back.text == text {
                            assert_eq!(emit_with(&back.text, &back.marks, &back.blocks, &back.soft, &back.seps), out, "{text:?} {a}..{z}");
                        }
                        whole += usize::from(back.text == text && back.marks == vec![m(a, z, Mark::Code)]);
                    }
                }
            }
        }
        // most of them keep the mark too, just where it was put
        assert!(plain_kept > all / 2 && whole > all / 4, "{whole} whole and {plain_kept} plain of {all}");
    }

    #[test]
    fn a_line_of_fences_that_run_together_is_read_once() {
        // two backticks, a space, one, a space, two, over and over: the closing two of one and the opening two
        // of the next are a run of four, so every fence looked to the end of the line for its own length
        for piece in ["`` ` ``", "``` `` ` ", "`` a ``` b ````", "` `` ``` ```` "] {
            let line = piece.repeat(199_000 / piece.len());
            let t = std::time::Instant::now();
            let d = parse(&line);
            let _ = emit_with(&d.text, &d.marks, &d.blocks, &d.soft, &d.seps);
            assert!(t.elapsed().as_millis() < 5000, "{piece:?} took {:?}", t.elapsed());
        }
        // fences that are whole are still read: one beside another, and one inside a longer one
        let d = parse("a ``x`y`` b ```p``q``` c");
        assert_eq!((d.text.as_str(), d.marks), ("a x`y b p``q c", vec![m(2, 5, Mark::Code), m(8, 12, Mark::Code)]));
    }

    #[test]
    fn hundreds_of_blank_lines_do_not_overflow_the_count() {
        for blanks in [200usize, 253, 254, 255, 256, 300, 1000] {
            let src = format!("a{}b\n", "\n".repeat(blanks + 1));
            let d = parse(&src);
            assert_eq!(d.text, "a\nb");
            // the count fits a byte up to 254 blank lines, and past that the page is edited as source
            assert_eq!(exact(&src).is_some(), blanks <= 254, "{blanks}");
        }
    }

    #[test]
    fn a_line_of_thousands_of_markers_is_drawn_in_in_one_pass() {
        for (piece, markers) in [("> - ", 2), ("> ", 1), ("- ", 1), ("1. ", 1), (">", 1), ("12) ", 1)] {
            let line = format!("{}word\n", piece.repeat(40_000 / piece.len()));
            let t = std::time::Instant::now();
            let out = shallow(&line).into_owned();
            assert!(t.elapsed().as_millis() < 5000, "{piece:?} took {:?}", t.elapsed());
            // the first eight markers and the word are what is left
            assert_eq!(out.trim_end_matches('\n').trim_end_matches("word").trim_end(), piece.repeat(NEST_MOST / markers).trim_end(), "{piece:?}");
            assert!(out.ends_with("word\n"));
        }
    }
}
