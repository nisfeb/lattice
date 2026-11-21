//! Colour for the four kinds of page Rune's highlighter has no lexer
//! for: Hoon, OpenSCAD, LaTeX and gemtext. Each is a port of the grammar
//! the web client wrote for itself in `code/nex/lattice/prism.js`, read
//! the way Prism reads one: the rules in order, each over what the rules
//! before it left, so a comment or a string is never read as code.
//!
//! Every rule moves only forward, and only the first 128 KiB of a page
//! is coloured, as Rune's own lexers do. A rule that looks ahead for
//! what closes it keeps what it found (`Memo`), so a page of openings
//! that nothing closes is read through once and not once for each.

use rune_kit::syntax::Syntax;
use std::ops::Range;

/// What a rule found: where, and its colour. No colour is text that is taken and left plain.
type Hit = (usize, usize, Option<Syntax>);
/// A rule: whether something starts at `i`, looking no further than `hi`. It may give parts, in order.
type Rule = fn(&[u8], usize, usize, &mut Memo) -> Option<Vec<Hit>>;

/// Where something first stands at or after `from` and before `hi`, kept
/// from one asking to the next. A rule asks from places further and
/// further along, so the text is read through once for each thing asked.
#[derive(Clone, Copy, Default)]
struct Next {
    from: usize,
    hi: usize,
    at: Option<usize>,
    set: bool,
}

impl Next {
    /// `len` is how long the thing is: it has to end by `hi`. `search` looks from `from` and says where it starts in the text.
    fn find(&mut self, from: usize, hi: usize, len: usize, search: impl FnOnce() -> Option<usize>) -> Option<usize> {
        let kept = self.set && from >= self.from && hi <= self.hi && self.at.is_none_or(|q| q >= from);
        if !kept {
            *self = Next { from, hi, at: search(), set: true };
        }
        self.at.filter(|q| q + len <= hi)
    }
}

/// A stretch that was read through and held nothing that closes: a reading
/// that starts inside it, and stops no later than it did, finds nothing either.
#[derive(Clone, Copy, Default)]
struct Dead {
    from: usize,
    to: usize,
    hi: usize,
    /// It stopped at a line's end, which stops any reading, wherever that one may go to.
    hard: bool,
    set: bool,
}

impl Dead {
    fn holds(&self, from: usize, hi: usize) -> bool {
        self.set && self.from <= from && from <= self.to && (self.hard || hi <= self.hi)
    }
}

/// What the rules of one pass over a page have found so far.
#[derive(Default)]
struct Memo {
    /// The end of a block comment, of an include's path, of each spelling of mathematics, and of a braced or bracketed argument.
    comment: Next,
    path: Next,
    round: Next,
    square: Next,
    brace: Next,
    bracket: Next,
    /// The end of each environment that was looked for, by its name.
    ends: Vec<(String, Next)>,
    /// A quote left open, for each of the two quotes, and a dollar sign left open.
    quotes: [Dead; 2],
    dollar: Dead,
    /// Runs of white space before an arm and inside one, and a number a word ran into.
    blank: [Dead; 2],
    number: Dead,
}

impl Memo {
    /// Where the white space that starts at `i` ends.
    fn blank_end(&mut self, slot: usize, b: &[u8], i: usize, hi: usize) -> usize {
        let d = &mut self.blank[slot];
        if !(d.set && d.from <= i && i <= d.to && d.hi == hi) {
            *d = Dead { from: i, to: i + b[i..hi].iter().take_while(|c| c.is_ascii_whitespace()).count(), hi, hard: false, set: true };
        }
        d.to
    }
}

/// Where `needle` first stands in `b[from..hi]`, counted from the start of the text.
fn seek(b: &[u8], from: usize, hi: usize, needle: &[u8]) -> Option<usize> {
    b[from..hi].windows(needle.len()).position(|w| w == needle).map(|n| from + n)
}

const LIMIT: usize = 128 * 1024;

fn word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn line_start(b: &[u8], i: usize) -> bool {
    i == 0 || b[i - 1] == b'\n'
}

fn line_end(b: &[u8], i: usize, hi: usize) -> usize {
    b[i..hi].iter().position(|c| *c == b'\n').map_or(hi, |n| i + n)
}

fn one(start: usize, end: usize, kind: Syntax) -> Option<Vec<Hit>> {
    (end > start).then(|| vec![(start, end, Some(kind))])
}

/// A quoted run from `i` to its closing quote, with backslash pairs stepped over. `lines` lets it run over line ends.
fn quoted(b: &[u8], i: usize, hi: usize, q: u8, lines: bool, m: &mut Memo) -> Option<usize> {
    if b[i] != q {
        return None;
    }
    // a quote inside a stretch already read with no closing quote is one a backslash escaped there:
    // the reading from it would go the same way to the same end
    let slot = usize::from(q == b'"');
    if m.quotes[slot].holds(i + 1, hi) {
        return None;
    }
    let mut j = i + 1;
    let mut hard = false;
    while j < hi {
        match b[j] {
            c if c == q => return Some(j + 1),
            b'\\' if j + 1 < hi && (lines || b[j + 1] != b'\n') => j += 2,
            b'\\' => {
                hard = j + 1 < hi;
                break;
            }
            b'\n' | b'\r' if !lines => {
                hard = true;
                break;
            }
            _ => j += 1,
        }
    }
    m.quotes[slot] = Dead { from: i + 1, to: j.min(hi), hi, hard, set: true };
    None
}

/// The identifier that starts at `i`, when a word does not run into it from before.
fn ident(b: &[u8], i: usize, hi: usize) -> Option<usize> {
    if !(b[i].is_ascii_alphabetic() || b[i] == b'_') || (i > 0 && word(b[i - 1])) {
        return None;
    }
    Some(i + b[i..hi].iter().take_while(|c| word(**c)).count())
}

fn one_of(b: &[u8], i: usize, hi: usize, list: &[&str], kind: Syntax) -> Option<Vec<Hit>> {
    let end = ident(b, i, hi)?;
    list.contains(&std::str::from_utf8(&b[i..end]).ok()?).then(|| vec![(i, end, Some(kind))])
}

fn punct(b: &[u8], i: usize, set: &[u8]) -> Option<Vec<Hit>> {
    set.contains(&b[i]).then(|| vec![(i, i + 1, Some(Syntax::Punctuation))])
}

/// A number as OpenSCAD and most languages write one, not run into by a word.
fn number(b: &[u8], i: usize, hi: usize) -> Option<Vec<Hit>> {
    let digits = |from: usize| from + b[from..hi].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut j = if b[i].is_ascii_digit() && !(i > 0 && word(b[i - 1])) {
        let j = digits(i);
        if j < hi && b[j] == b'.' { digits(j + 1) } else { j }
    } else if b[i] == b'.' && i + 1 < hi && b[i + 1].is_ascii_digit() && (i == 0 || !word(b[i - 1])) {
        digits(i + 1)
    } else {
        return None;
    };
    if j < hi && matches!(b[j], b'e' | b'E') {
        let k = if j + 1 < hi && matches!(b[j + 1], b'+' | b'-') { j + 2 } else { j + 1 };
        if k < hi && b[k].is_ascii_digit() {
            j = digits(k);
        }
    }
    (j >= hi || !word(b[j])).then(|| vec![(i, j, Some(Syntax::Number))])
}

// ── Hoon ─────────────────────────────────────────────────────────────────

const RUNE: &[u8] = b"|$%:.=?!+;~^&_*<>#-";

const HOON: &[Rule] = &[
    // a comment, to the end of its line, and cords and tapes. One rule, so whichever starts first
    // holds the other: a `::` in a tape is text, and a quote in a comment opens nothing
    |b, i, hi, m| {
        if b[i..hi].starts_with(b"::") {
            return one(i, line_end(b, i, hi), Syntax::Comment);
        }
        quoted(b, i, hi, b'\'', true, m).or_else(|| quoted(b, i, hi, b'"', true, m)).and_then(|e| one(i, e, Syntax::String))
    },
    // an arm: ++ name, +$ name, +* name, first on its line
    |b, i, hi, m| {
        if !line_start(b, i) {
            return None;
        }
        let at = m.blank_end(0, b, i, hi);
        if at + 2 > hi || b[at] != b'+' || !b"+$*".contains(&b[at + 1]) {
            return None;
        }
        let gap = m.blank_end(1, b, at + 2, hi) - (at + 2);
        let name = at + 2 + gap;
        if gap == 0 || name >= hi || !b[name].is_ascii_lowercase() {
            return None;
        }
        let end = name + b[name..hi].iter().take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || **c == b'-').count();
        Some(vec![(i, at, None), (at, at + 2, Some(Syntax::Keyword)), (at + 2, name, None), (name, end, Some(Syntax::Function))])
    },
    // a term: %foo %.y %.n %$ %| %&, or the bare sign
    |b, i, hi, _| {
        if b[i] != b'%' {
            return None;
        }
        let rest = &b[i + 1..hi];
        let len = match rest.first() {
            Some(c) if c.is_ascii_lowercase() => rest.iter().take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || **c == b'-').count(),
            Some(b'.') if matches!(rest.get(1), Some(b'y' | b'n')) => 2,
            Some(b'|' | b'&' | b'$' | b'~') => 1,
            _ => 0,
        };
        one(i, i + 1 + len, Syntax::Property)
    },
    // an aura's value: ~ship, ~2026.7.27, ~s5
    |b, i, hi, _| {
        if b[i] != b'~' {
            return None;
        }
        let run = |from: usize| b[from..hi].iter().take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).count();
        let mut j = i + 1 + run(i + 1);
        if j == i + 1 {
            return None;
        }
        while j + 1 < hi && matches!(b[j], b'.' | b'-') && run(j + 1) > 0 {
            j += 1 + run(j + 1);
        }
        one(i, j, Syntax::Type)
    },
    // a rune: two of its signs, standing free
    |b, i, hi, _| {
        let before = line_start(b, i) || matches!(b[i - 1], b'(' | b'[' | b'{') || b[i - 1].is_ascii_whitespace();
        let two = i + 2 <= hi && RUNE.contains(&b[i]) && RUNE.contains(&b[i + 1]);
        let after = i + 2 >= b.len() || matches!(b[i + 2], b')' | b']' | b'}') || b[i + 2].is_ascii_whitespace();
        if before && two && after { one(i, i + 2, Syntax::Keyword) } else { None }
    },
    // 0x1f, 0b1, 0v1, 0w1 and plain numbers with their dots
    |b, i, hi, m| {
        if !b[i].is_ascii_digit() || (i > 0 && word(b[i - 1])) {
            return None;
        }
        if b[i] == b'0' && i + 2 < hi && b"xvbw".contains(&b[i + 1]) && (b[i + 2].is_ascii_alphanumeric() || b[i + 2] == b'.') {
            return one(i, i + 2 + b[i + 2..hi].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'.').count(), Syntax::Number);
        }
        // figures after a point of a number a word ran into end where that number did, in the same word
        if m.number.set && m.number.from < i && i < m.number.to && m.number.hi == hi {
            return None;
        }
        let digits = |from: usize| b[from..hi].iter().take_while(|c| c.is_ascii_digit()).count();
        let mut j = i + digits(i);
        while j + 1 < hi && b[j] == b'.' && digits(j + 1) > 0 {
            j += 1 + digits(j + 1);
        }
        if j < hi && word(b[j]) {
            m.number = Dead { from: i, to: j, hi, hard: false, set: true };
            None
        } else {
            one(i, j, Syntax::Number)
        }
    },
    // & and | standing for yes and no
    |b, i, hi, _| {
        let free = |c: u8, more: &[u8]| !(word(c) || more.contains(&c));
        let ok = matches!(b[i], b'&' | b'|') && (i == 0 || free(b[i - 1], b"-")) && (i + 1 >= hi || free(b[i + 1], b"|&-"));
        if ok { one(i, i + 1, Syntax::Number) } else { None }
    },
    |b, i, _, _| punct(b, i, b"()[]{},"),
];

// ── OpenSCAD ─────────────────────────────────────────────────────────────

const SCAD_BUILTIN: &[&str] = &[
    "cube", "sphere", "cylinder", "polyhedron", "square", "circle", "polygon", "text", "import", "surface", "projection", "linear_extrude", "rotate_extrude", "union", "difference", "intersection", "hull", "minkowski", "offset", "translate",
    "rotate", "scale", "resize", "mirror", "multmatrix", "color", "render", "children", "abs", "sign", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "floor", "round", "ceil", "ln", "log", "pow", "sqrt", "exp", "len", "min", "max", "norm",
    "cross", "concat", "lookup", "str", "chr", "ord", "search", "rands", "is_undef", "is_bool", "is_num", "is_string", "is_list", "is_function", "version", "version_num", "parent_module",
];

const SCAD: &[Rule] = &[
    |b, i, hi, m| {
        if b[i..hi].starts_with(b"/*") {
            let end = m.comment.find(i + 2, hi, 2, || seek(b, i + 2, hi, b"*/"))?;
            return one(i, end + 2, Syntax::Comment);
        }
        if b[i..hi].starts_with(b"//") {
            return one(i, line_end(b, i, hi), Syntax::Comment);
        }
        // strings in the same rule as comments, so whichever starts first holds the other
        quoted(b, i, hi, b'"', false, m).and_then(|e| one(i, e, Syntax::String))
    },
    // an include's path is one token, as OpenSCAD's lexer reads it
    |b, i, hi, m| {
        let end = ident(b, i, hi)?;
        if !matches!(&b[i..end], b"include" | b"use") {
            return None;
        }
        let open = end + b[end..hi].iter().take_while(|c| c.is_ascii_whitespace()).count();
        if open >= hi || b[open] != b'<' {
            return None;
        }
        // the path ends at the first > on its line
        let close = m.path.find(open, hi, 1, || b[open..hi].iter().position(|c| matches!(c, b'>' | b'\n' | b'\r')).map(|n| open + n)).filter(|n| b[*n] == b'>')?;
        Some(vec![(i, end, Some(Syntax::Keyword)), (end, open, None), (open, close + 1, Some(Syntax::String))])
    },
    |b, i, hi, _| one_of(b, i, hi, &["module", "function", "if", "else", "for", "intersection_for", "let", "each", "assert", "echo"], Syntax::Keyword),
    |b, i, hi, _| one_of(b, i, hi, &["true", "false", "undef"], Syntax::Number),
    |b, i, hi, _| one_of(b, i, hi, SCAD_BUILTIN, Syntax::Type),
    |b, i, hi, _| if b[i] == b'$' { one(i, i + 1 + b[i + 1..hi].iter().take_while(|c| word(**c)).count(), Syntax::Variable).filter(|h| h[0].1 > i + 1) } else { None },
    |b, i, hi, _| number(b, i, hi),
    // a name before a bracket is a call
    |b, i, hi, _| {
        let end = ident(b, i, hi)?;
        let next = end + b[end..b.len()].iter().take_while(|c| c.is_ascii_whitespace()).count();
        (b.get(next) == Some(&b'(')).then(|| vec![(i, end, Some(Syntax::Function))])
    },
    |b, i, hi, _| {
        let two = i + 2 <= hi && (matches!(&b[i..i + 2], b"&&" | b"||") || (b"<>!=".contains(&b[i]) && b[i + 1] == b'='));
        if two {
            return one(i, i + 2, Syntax::Operator);
        }
        if b"<>!=-+*/%^?:#".contains(&b[i]) { one(i, i + 1, Syntax::Operator) } else { None }
    },
    |b, i, _, _| punct(b, i, b"{}[];(),."),
];

// ── LaTeX ────────────────────────────────────────────────────────────────

/// A control word at `i`, `\name`, when it is one of `names`: where it ends.
fn command(b: &[u8], i: usize, hi: usize, names: &[&str]) -> Option<usize> {
    if b[i] != b'\\' {
        return None;
    }
    let end = i + 1 + b[i + 1..hi].iter().take_while(|c| c.is_ascii_alphabetic()).count();
    names.contains(&std::str::from_utf8(&b[i + 1..end]).ok()?).then_some(end)
}

/// What stands in the braces after a command at `i`: the command and its optional argument are left for later rules.
fn argument(b: &[u8], i: usize, hi: usize, names: &[&str], star: bool, kind: Syntax, m: &mut Memo) -> Option<Vec<Hit>> {
    let mut j = command(b, i, hi, names)?;
    if star && j < hi && b[j] == b'*' {
        j += 1;
    }
    if j < hi && b[j] == b'[' {
        j = m.bracket.find(j, hi, 1, || seek(b, j, hi, b"]"))? + 1;
    }
    if j >= hi || b[j] != b'{' {
        return None;
    }
    let close = m.brace.find(j + 1, hi, 1, || seek(b, j + 1, hi, b"}"))?;
    (close > j + 1).then(|| vec![(j + 1, close, Some(kind))])
}

/// What an environment at `i` holds, `\begin{name}` to its `\end{name}`, for the environments named.
fn environment(b: &[u8], i: usize, hi: usize, names: &[&str], kind: Option<Syntax>, m: &mut Memo) -> Option<Vec<Hit>> {
    b[i..hi].strip_prefix(b"\\begin{")?;
    let len = m.brace.find(i + 7, hi, 1, || seek(b, i + 7, hi, b"}"))? - (i + 7);
    let name = std::str::from_utf8(&b[i + 7..i + 7 + len]).ok()?;
    let bare = name.strip_suffix('*').unwrap_or(name);
    if !names.contains(&bare) {
        return None;
    }
    let from = i + 7 + len + 1;
    let end = format!("\\end{{{bare}");
    let slot = match m.ends.iter().position(|(n, _)| n == bare) {
        Some(slot) => slot,
        None => {
            m.ends.push((bare.to_owned(), Next::default()));
            m.ends.len() - 1
        }
    };
    let to = m.ends[slot].1.find(from, hi, end.len(), || seek(b, from, hi, end.as_bytes()))?;
    (to > from).then(|| vec![(from, to, kind)])
}

const TEX: &[Rule] = &[
    // what verbatim holds is not LaTeX and is not coloured as any, and a comment runs to the end of
    // its line, but \% is a percent sign. One rule, so a percent sign inside verbatim is not a comment
    |b, i, hi, m| {
        if b[i] == b'%' && (i == 0 || b[i - 1] != b'\\') {
            return one(i, line_end(b, i, hi), Syntax::Comment);
        }
        // the opening is left for the rules after: only what it holds is taken
        environment(b, i, hi, &["verbatim", "lstlisting"], None, m)
    },
    // mathematics, in its four spellings
    |b, i, hi, m| {
        // to the dollar signs that close, with a backslash and what it escapes stepped over. Another
        // dollar sign first is no close. A reading that met neither is kept, and one from inside it,
        // which starts at a dollar sign that one stepped over, is not made again
        let mut until = |from: usize, close: &[u8]| -> Option<usize> {
            if m.dollar.holds(from, hi) {
                return None;
            }
            let mut j = from;
            while j < hi {
                if b[j..hi].starts_with(close) {
                    return (j > from).then_some(j + close.len());
                }
                if b[j] == b'$' {
                    return None;
                }
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            m.dollar = Dead { from, to: hi, hi, hard: false, set: true };
            None
        };
        let end = if b[i..hi].starts_with(b"$$") {
            until(i + 2, b"$$").or_else(|| until(i + 1, b"$"))
        } else if b[i] == b'$' {
            until(i + 1, b"$")
        } else if b[i..hi].starts_with(b"\\(") {
            // nothing between the two is no mathematics, but the two with only themselves between are taken
            m.round.find(i + 2, hi, 2, || seek(b, i + 2, hi, b"\\)")).map(|j| if j > i + 2 { j + 2 } else { i + 4 })
        } else if b[i..hi].starts_with(b"\\[") {
            m.square.find(i + 2, hi, 2, || seek(b, i + 2, hi, b"\\]")).map(|j| if j > i + 2 { j + 2 } else { i + 4 })
        } else {
            None
        };
        one(i, end?, Syntax::String)
    },
    |b, i, hi, m| environment(b, i, hi, &["align", "alignat", "eqnarray", "equation", "gather", "math", "multline"], Some(Syntax::String), m),
    // the argument of a structural command: the package, the label, the environment opened
    |b, i, hi, m| argument(b, i, hi, &["begin", "end", "cite", "documentclass", "label", "ref", "eqref", "usepackage", "input", "include", "bibliography"], false, Syntax::Keyword, m),
    |b, i, hi, m| argument(b, i, hi, &["url", "href"], false, Syntax::Link, m),
    // section titles read as headings
    |b, i, hi, m| argument(b, i, hi, &["chapter", "part", "section", "subsection", "subsubsection", "paragraph", "subparagraph", "title", "author", "frametitle"], true, Syntax::Heading, m),
    // any other control word
    |b, i, hi, _| {
        if b[i] != b'\\' {
            return None;
        }
        let end = i + 1 + b[i + 1..hi].iter().take_while(|c| c.is_ascii_alphabetic() || **c == b'@').count();
        if end == i + 1 {
            return None;
        }
        one(i, if end < hi && b[end] == b'*' { end + 1 } else { end }, Syntax::Function)
    },
    |b, i, _, _| punct(b, i, b"[]{}&~"),
];

// ── gemtext ──────────────────────────────────────────────────────────────

const GMI: &[Rule] = &[
    // fenced text, to the line that closes it or the end
    |b, i, hi, _| {
        if !line_start(b, i) || !b[i..hi].starts_with(b"```") {
            return None;
        }
        let mut at = line_end(b, i, hi);
        while at < hi {
            let next = at + 1;
            if b[next..hi].starts_with(b"```") {
                return one(i, line_end(b, next, hi), Syntax::Comment);
            }
            at = line_end(b, next, hi);
        }
        one(i, hi, Syntax::Comment)
    },
    |b, i, hi, _| if line_start(b, i) && b[i] == b'#' { one(i, line_end(b, i, hi), Syntax::Heading) } else { None },
    // a link: its sign, where it goes, and its words left plain
    |b, i, hi, _| {
        if !line_start(b, i) || !b[i..hi].starts_with(b"=>") {
            return None;
        }
        let end = line_end(b, i, hi);
        let url = i + 2 + b[i + 2..end].iter().take_while(|c| c.is_ascii_whitespace()).count();
        let url_end = url + b[url..end].iter().take_while(|c| !c.is_ascii_whitespace()).count();
        Some(vec![(i, i + 2, Some(Syntax::Punctuation)), (i + 2, url, None), (url, url_end, Some(Syntax::Link)), (url_end, end, None)])
    },
    |b, i, hi, _| if line_start(b, i) && b[i] == b'>' { one(i, line_end(b, i, hi), Syntax::Comment) } else { None },
    |b, i, hi, _| if line_start(b, i) && b[i..hi].starts_with(b"* ") { one(i, i + 2, Syntax::Keyword) } else { None },
];

/// Whether a page kind is coloured here and not by Rune's own lexers.
pub fn knows(kind: &str) -> bool {
    matches!(kind, "hoon" | "scad" | "tex" | "gmi")
}

/// The coloured ranges of a page of one of the four kinds, in order and not overlapping. None for any other kind.
pub fn highlight(kind: &str, text: &str) -> Vec<(Range<usize>, Syntax)> {
    let rules = match kind {
        "hoon" => HOON,
        "scad" => SCAD,
        "tex" => TEX,
        "gmi" => GMI,
        _ => return Vec::new(),
    };
    let mut end = text.len().min(LIMIT);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let b = &text.as_bytes()[..end];
    // what no rule has taken yet, in order
    let mut free: Vec<(usize, usize)> = vec![(0, end)];
    let mut out: Vec<(Range<usize>, Syntax)> = Vec::new();
    for rule in rules {
        let mut memo = Memo::default();
        let mut next = Vec::with_capacity(free.len());
        for (lo, hi) in free {
            let (mut i, mut from) = (lo, lo);
            while i < hi {
                // only at the start of a character: the rules read bytes, and all their signs are ASCII
                match rule(b, i, hi, &mut memo).filter(|_| b[i] < 0x80) {
                    Some(hits) if hits.last().is_some_and(|h| h.1 > i && h.1 <= hi) => {
                        let taken = hits.first().map_or(i, |h| h.0).max(i);
                        if taken > from {
                            next.push((from, taken));
                        }
                        out.extend(hits.iter().filter(|h| h.1 > h.0).filter_map(|(s, e, k)| k.map(|k| (*s..*e, k))));
                        i = hits.last().map_or(i + 1, |h| h.1);
                        from = i;
                    }
                    _ => i += 1,
                }
            }
            if from < hi {
                next.push((from, hi));
            }
        }
        free = next;
    }
    out.sort_by_key(|(r, _)| r.start);
    // a range never ends inside a character
    out.retain(|(r, _)| text.is_char_boundary(r.start) && text.is_char_boundary(r.end));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use Syntax::*;

    /// Each coloured piece as its text and its colour.
    fn read<'a>(kind: &str, text: &'a str) -> Vec<(&'a str, Syntax)> {
        highlight(kind, text).into_iter().map(|(r, k)| (&text[r], k)).collect()
    }

    #[test]
    fn hoon_reads_arms_runes_terms_and_auras() {
        // `=/` is not coloured: the web client's set of rune signs has no `/` in it, and this follows it
        let src = "::  a door\n++  add-one\n  |=  a=@ud\n  ^-  @ud\n  ?:  =(a 0x1f)  %.y\n  (add a 1)  :: done\n+$  card  [%give ~zod 'it''s' \"t:: no\"]\n=/  ok  &\n";
        assert_eq!(
            read("hoon", src),
            [
                ("::  a door", Comment), ("++", Keyword), ("add-one", Function), ("|=", Keyword), ("^-", Keyword), ("?:", Keyword), ("(", Punctuation), ("0x1f", Number), (")", Punctuation), ("%.y", Property), ("(", Punctuation), ("1", Number),
                (")", Punctuation), (":: done", Comment), ("+$", Keyword), ("card", Function), ("[", Punctuation), ("%give", Property), ("~zod", Type), ("'it'", String), ("'s'", String), ("\"t:: no\"", String), ("]", Punctuation),
                ("&", Number),
            ]
        );
    }

    #[test]
    fn openscad_reads_comments_includes_calls_and_numbers() {
        let src = "// box\ninclude <lib/screws.scad>\n$fn = 64;\nmodule box(w = 2.5e1) {\n  if (w >= 10 && true) cube([w, .5, 3]); /* \"no\" */\n  echo(\"a // b\", my_fn(w));\n}\n";
        assert_eq!(
            read("scad", src),
            [
                ("// box", Comment), ("include", Keyword), ("<lib/screws.scad>", String), ("$fn", Variable), ("=", Operator), ("64", Number), (";", Punctuation), ("module", Keyword), ("box", Function), ("(", Punctuation), ("=", Operator),
                ("2.5e1", Number), (")", Punctuation), ("{", Punctuation), ("if", Keyword), ("(", Punctuation), (">=", Operator), ("10", Number), ("&&", Operator), ("true", Number), (")", Punctuation), ("cube", Type), ("(", Punctuation),
                ("[", Punctuation), (",", Punctuation), (".5", Number), (",", Punctuation), ("3", Number), ("]", Punctuation), (")", Punctuation), (";", Punctuation), ("/* \"no\" */", Comment), ("echo", Keyword), ("(", Punctuation),
                ("\"a // b\"", String), (",", Punctuation), ("my_fn", Function), ("(", Punctuation), (")", Punctuation), (")", Punctuation), (";", Punctuation), ("}", Punctuation),
            ]
        );
    }

    #[test]
    fn latex_reads_comments_mathematics_headings_and_commands() {
        let src = "% note\n\\documentclass[a4]{article}\n\\section*{Intro}\nCost is 5\\% of $x^2$ and \\[ y \\].\n\\begin{verbatim}\n\\not $code$ % here\n\\end{verbatim}\n\\href{https://urbit.org}{link} \\emph{x}\n";
        assert_eq!(
            read("tex", src),
            [
                ("% note", Comment), ("\\documentclass", Function), ("[", Punctuation), ("]", Punctuation), ("{", Punctuation), ("article", Keyword), ("}", Punctuation), ("\\section*", Function), ("{", Punctuation), ("Intro", Heading),
                ("}", Punctuation), ("$x^2$", String), ("\\[ y \\]", String), ("\\begin", Function), ("{", Punctuation), ("verbatim", Keyword), ("}", Punctuation), ("\\end", Function), ("{", Punctuation), ("verbatim", Keyword),
                ("}", Punctuation), ("\\href", Function), ("{", Punctuation), ("https://urbit.org", Link), ("}", Punctuation), ("{", Punctuation), ("}", Punctuation), ("\\emph", Function), ("{", Punctuation), ("}", Punctuation),
            ]
        );
    }

    #[test]
    fn gemtext_reads_headings_links_quotes_and_fences() {
        let src = "# Title\ntext * not a list\n=> urb://~zod/page A page\n> said\n* item\n```\n# not a title\n=> no\n```\nafter\n```\nopen to the end";
        assert_eq!(
            read("gmi", src),
            [("# Title", Heading), ("=>", Punctuation), ("urb://~zod/page", Link), ("> said", Comment), ("* ", Keyword), ("```\n# not a title\n=> no\n```", Comment), ("```\nopen to the end", Comment)]
        );
    }

    #[test]
    fn ranges_are_in_order_apart_and_whole_characters_whatever_the_text() {
        let odd = ["", "é", "::é", "'é", "\"é\\", "+", "++", "++ ", "%", "~", "0x", "$", "$$", "\\", "\\(", "\\begin{", "\\begin{verbatim}", "\\section{", "```", "=>", "=> é", "/*", "include <", "é ++ é :: é", "\\é{é}%é$é$", "1e", ".", "é.5e+"];
        for kind in ["hoon", "scad", "tex", "gmi", "md"] {
            for text in odd {
                let got = highlight(kind, text);
                let mut at = 0;
                for (r, _) in &got {
                    assert!(r.start >= at && r.end > r.start && r.end <= text.len(), "{kind} {text:?} {got:?}");
                    assert!(text.is_char_boundary(r.start) && text.is_char_boundary(r.end));
                    at = r.end;
                }
            }
        }
        assert!(highlight("md", "# x").is_empty() && !knows("md") && knows("hoon"));
        // a long run of what could each start a rule is read in bounded time, and only so much of a page is coloured
        let hostile = "\"".repeat(40_000) + &"/*".repeat(40_000) + &"<".repeat(40_000);
        let t0 = std::time::Instant::now();
        let got = highlight("scad", &hostile);
        assert!(got.iter().all(|(r, _)| r.end <= LIMIT));
        assert!(t0.elapsed().as_secs() < 20);
    }

    #[test]
    fn a_page_of_openings_that_nothing_closes_is_read_once() {
        // each of these, repeated to fill the part of a page that is coloured, once took seconds
        let cases: [(&str, &[&str]); 3] = [
            ("tex", &["\\(", "\\[", "\\begin{align}", "\\begin{verbatim}", "\\begin{", "\\cite[", "\\cite{", "\\cite[a", "\\section*{", "\\$", "$$\\$", "\\(\\[\\cite[\\begin{align}"]),
            ("scad", &["/* ", "include <", "use <a ", "\"\\\"", "\"a", "/*\"", "include </*"]),
            ("hoon", &["\n", " \n", "'\\'", "\"\\\"", "1.", "++ \n", "\n++", "'\\'\"\\\""]),
        ];
        for (kind, pieces) in cases {
            for piece in pieces {
                for tail in ["", "x"] {
                    let text = piece.repeat(LIMIT / piece.len()) + tail;
                    let t0 = std::time::Instant::now();
                    let got = highlight(kind, &text);
                    assert!(t0.elapsed().as_millis() < 5000, "{kind} {piece:?} took {:?}", t0.elapsed());
                    let mut at = 0;
                    for (r, _) in &got {
                        assert!(r.start >= at && r.end > r.start && r.end <= text.len(), "{kind} {piece:?}");
                        at = r.end;
                    }
                }
            }
        }
        // what closes far away is still found, each by its own opening
        assert_eq!(read("scad", "/* a */ x /* b */"), [("/* a */", Comment), ("/* b */", Comment)]);
        assert_eq!(read("tex", "\\(a\\) \\(\\) \\( b"), [("\\(a\\)", String), ("\\(\\)", String)]);
        assert_eq!(read("tex", "\\cite[a]{k} \\cite[b] \\cite{m}"), [("\\cite", Function), ("[", Punctuation), ("]", Punctuation), ("{", Punctuation), ("k", Keyword), ("}", Punctuation), ("\\cite", Function), ("[", Punctuation), ("]", Punctuation), ("\\cite", Function), ("{", Punctuation), ("m", Keyword), ("}", Punctuation)]);
        assert_eq!(read("hoon", "'a\\'b' 'c'"), [("'a\\'b'", String), ("'c'", String)]);
        assert_eq!(read("hoon", "1.000.000 1.5x 2"), [("1.000.000", Number), ("2", Number)]);
    }
}
