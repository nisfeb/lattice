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
                let Some(z) = rest[a + 2..].find("]]") else { break };
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
            blanks = blanks.saturating_add(1);
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

/// Appends `s` to `out` without its inline markers, recording each as a mark.
fn inline(s: &str, out: &mut String, marks: &mut Vec<MarkRange>) {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let rest = &s[i..];
        match b[i] {
            b'\\' if b.get(i + 1).is_some_and(u8::is_ascii_punctuation) => {
                out.push_str(&s[i..i + 2]);
                i += 2;
            }
            b'`' => {
                let run = rest.len() - rest.trim_start_matches('`').len();
                let close = (run == 1).then(|| rest[1..].find('`')).flatten().filter(|&j| j > 0);
                match close {
                    Some(j) => {
                        let at = out.len();
                        out.push_str(&rest[1..1 + j]);
                        mark(marks, at, out.len(), Mark::Code);
                        i += j + 2;
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
                let link = rest.find("](").and_then(|j| {
                    let k = rest[j + 2..].find(')')?;
                    let (label, url) = (&rest[1..j], &rest[j + 2..j + 2 + k]);
                    let ok = !label.is_empty() && !label.contains('[') && !url.is_empty() && !url.contains(char::is_whitespace) && !url.contains('(');
                    ok.then_some((label, url, j + 3 + k))
                });
                match link {
                    Some((label, url, len)) => {
                        let at = out.len();
                        inline(label, out, marks);
                        mark(marks, at, out.len(), Mark::Link(url.to_owned()));
                        i += len;
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

fn close(m: &Mark, out: &mut String) {
    match m {
        Mark::Link(url) => {
            out.push_str("](");
            out.push_str(url);
            out.push(')');
        }
        m => out.push_str(open(m)),
    }
}

/// Writes one line's text with its marks as Markdown. `at` is where the line
/// starts in the document, which is what the marks' offsets count from.
fn emit_inline(line: &str, at: usize, marks: &[MarkRange], out: &mut String) {
    // the marks on this line, outermost first, each once
    let mut kinds: Vec<&Mark> = Vec::new();
    for m in marks.iter().filter(|m| m.start < at + line.len() && m.end > at && rank(&m.mark).is_some()) {
        if !kinds.contains(&&m.mark) {
            kinds.push(&m.mark);
        }
    }
    if kinds.is_empty() {
        out.push_str(line);
        return;
    }
    kinds.sort_by_key(|m| rank(m));
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    // which marks each character carries
    let mut on: Vec<Vec<bool>> = kinds
        .iter()
        .map(|k| chars.iter().map(|&(i, _)| marks.iter().any(|m| &m.mark == *k && m.start <= at + i && at + i < m.end)).collect())
        .collect();
    let code = kinds.iter().position(|k| **k == Mark::Code);
    for k in 0..kinds.len() {
        if Some(k) == code {
            continue;
        }
        let mut i = 0;
        while i < chars.len() {
            // one stretch of code: another mark covers all of it or none
            if let Some(c) = code.filter(|&c| on[c][i]) {
                let mut j = i;
                while j < chars.len() && on[c][j] {
                    j += 1;
                }
                if !(i..j).all(|x| on[k][x]) {
                    (i..j).for_each(|x| on[k][x] = false);
                }
                i = j;
            } else {
                i += 1;
            }
        }
        // a marker beside a space is not a marker in Markdown: pull each
        // stretch in to its first and last character that is not one
        let mut i = 0;
        while i < chars.len() {
            if !on[k][i] {
                i += 1;
                continue;
            }
            let mut j = i;
            while j < chars.len() && on[k][j] {
                j += 1;
            }
            let (mut a, mut z) = (i, j);
            while a < z && chars[a].1.is_whitespace() {
                on[k][a] = false;
                a += 1;
            }
            while z > a && chars[z - 1].1.is_whitespace() {
                on[k][z - 1] = false;
                z -= 1;
            }
            i = j;
        }
    }
    let mut stack: Vec<usize> = Vec::new();
    for x in 0..=chars.len() {
        let want: Vec<usize> = (0..kinds.len()).filter(|&k| x < chars.len() && on[k][x]).collect();
        if let Some(cut) = stack.iter().position(|k| !want.contains(k)) {
            for k in stack.drain(cut..).rev().collect::<Vec<_>>() {
                close(kinds[k], out);
            }
        }
        for k in want {
            if !stack.contains(&k) {
                out.push_str(open(kinds[k]));
                stack.push(k);
            }
        }
        if let Some(&(_, ch)) = chars.get(x) {
            out.push(ch);
        }
    }
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
            emit_inline(line, start, marks, &mut s);
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
}
