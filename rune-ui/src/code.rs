//! Colour for the four kinds of page Rune's highlighter has no lexer
//! for: Hoon, OpenSCAD, LaTeX and gemtext. Each is a port of the grammar
//! the web client wrote for itself in `code/nex/lattice/prism.js`, read
//! the way Prism reads one: the rules in order, each over what the rules
//! before it left, so a comment or a string is never read as code.
//!
//! Every rule moves only forward, and only the first 128 KiB of a page
//! is coloured, as Rune's own lexers do.

use rune_kit::syntax::Syntax;
use std::ops::Range;

/// What a rule found: where, and its colour. No colour is text that is taken and left plain.
type Hit = (usize, usize, Option<Syntax>);
/// A rule: whether something starts at `i`, looking no further than `hi`. It may give parts, in order.
type Rule = fn(&[u8], usize, usize) -> Option<Vec<Hit>>;

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
fn quoted(b: &[u8], i: usize, hi: usize, q: u8, lines: bool) -> Option<usize> {
    if b[i] != q {
        return None;
    }
    let mut j = i + 1;
    while j < hi {
        match b[j] {
            c if c == q => return Some(j + 1),
            b'\\' if j + 1 < hi && (lines || b[j + 1] != b'\n') => j += 2,
            b'\\' => return None,
            b'\n' | b'\r' if !lines => return None,
            _ => j += 1,
        }
    }
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
    |b, i, hi| {
        if b[i..hi].starts_with(b"::") {
            return one(i, line_end(b, i, hi), Syntax::Comment);
        }
        quoted(b, i, hi, b'\'', true).or_else(|| quoted(b, i, hi, b'"', true)).and_then(|e| one(i, e, Syntax::String))
    },
    // an arm: ++ name, +$ name, +* name, first on its line
    |b, i, hi| {
        if !line_start(b, i) {
            return None;
        }
        let at = i + b[i..hi].iter().take_while(|c| c.is_ascii_whitespace()).count();
        if at + 2 > hi || b[at] != b'+' || !b"+$*".contains(&b[at + 1]) {
            return None;
        }
        let gap = b[at + 2..hi].iter().take_while(|c| c.is_ascii_whitespace()).count();
        let name = at + 2 + gap;
        if gap == 0 || name >= hi || !b[name].is_ascii_lowercase() {
            return None;
        }
        let end = name + b[name..hi].iter().take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || **c == b'-').count();
        Some(vec![(i, at, None), (at, at + 2, Some(Syntax::Keyword)), (at + 2, name, None), (name, end, Some(Syntax::Function))])
    },
    // a term: %foo %.y %.n %$ %| %&, or the bare sign
    |b, i, hi| {
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
    |b, i, hi| {
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
    |b, i, hi| {
        let before = line_start(b, i) || matches!(b[i - 1], b'(' | b'[' | b'{') || b[i - 1].is_ascii_whitespace();
        let two = i + 2 <= hi && RUNE.contains(&b[i]) && RUNE.contains(&b[i + 1]);
        let after = i + 2 >= b.len() || matches!(b[i + 2], b')' | b']' | b'}') || b[i + 2].is_ascii_whitespace();
        if before && two && after { one(i, i + 2, Syntax::Keyword) } else { None }
    },
    // 0x1f, 0b1, 0v1, 0w1 and plain numbers with their dots
    |b, i, hi| {
        if !b[i].is_ascii_digit() || (i > 0 && word(b[i - 1])) {
            return None;
        }
        if b[i] == b'0' && i + 2 < hi && b"xvbw".contains(&b[i + 1]) && (b[i + 2].is_ascii_alphanumeric() || b[i + 2] == b'.') {
            return one(i, i + 2 + b[i + 2..hi].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'.').count(), Syntax::Number);
        }
        let digits = |from: usize| b[from..hi].iter().take_while(|c| c.is_ascii_digit()).count();
        let mut j = i + digits(i);
        while j + 1 < hi && b[j] == b'.' && digits(j + 1) > 0 {
            j += 1 + digits(j + 1);
        }
        if j < hi && word(b[j]) { None } else { one(i, j, Syntax::Number) }
    },
    // & and | standing for yes and no
    |b, i, hi| {
        let free = |c: u8, more: &[u8]| !(word(c) || more.contains(&c));
        let ok = matches!(b[i], b'&' | b'|') && (i == 0 || free(b[i - 1], b"-")) && (i + 1 >= hi || free(b[i + 1], b"|&-"));
        if ok { one(i, i + 1, Syntax::Number) } else { None }
    },
    |b, i, _| punct(b, i, b"()[]{},"),
];

// ── OpenSCAD ─────────────────────────────────────────────────────────────

const SCAD_BUILTIN: &[&str] = &[
    "cube", "sphere", "cylinder", "polyhedron", "square", "circle", "polygon", "text", "import", "surface", "projection", "linear_extrude", "rotate_extrude", "union", "difference", "intersection", "hull", "minkowski", "offset", "translate",
    "rotate", "scale", "resize", "mirror", "multmatrix", "color", "render", "children", "abs", "sign", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "floor", "round", "ceil", "ln", "log", "pow", "sqrt", "exp", "len", "min", "max", "norm",
    "cross", "concat", "lookup", "str", "chr", "ord", "search", "rands", "is_undef", "is_bool", "is_num", "is_string", "is_list", "is_function", "version", "version_num", "parent_module",
];

const SCAD: &[Rule] = &[
    |b, i, hi| {
        if b[i..hi].starts_with(b"/*") {
            let end = b[i + 2..hi].windows(2).position(|w| w == b"*/")?;
            return one(i, i + 2 + end + 2, Syntax::Comment);
        }
        if b[i..hi].starts_with(b"//") {
            return one(i, line_end(b, i, hi), Syntax::Comment);
        }
        // strings in the same rule as comments, so whichever starts first holds the other
        quoted(b, i, hi, b'"', false).and_then(|e| one(i, e, Syntax::String))
    },
    // an include's path is one token, as OpenSCAD's lexer reads it
    |b, i, hi| {
        let end = ident(b, i, hi)?;
        if !matches!(&b[i..end], b"include" | b"use") {
            return None;
        }
        let open = end + b[end..hi].iter().take_while(|c| c.is_ascii_whitespace()).count();
        if open >= hi || b[open] != b'<' {
            return None;
        }
        let close = open + b[open..hi].iter().position(|c| matches!(c, b'>' | b'\n' | b'\r')).filter(|n| b[open + n] == b'>')?;
        Some(vec![(i, end, Some(Syntax::Keyword)), (end, open, None), (open, close + 1, Some(Syntax::String))])
    },
    |b, i, hi| one_of(b, i, hi, &["module", "function", "if", "else", "for", "intersection_for", "let", "each", "assert", "echo"], Syntax::Keyword),
    |b, i, hi| one_of(b, i, hi, &["true", "false", "undef"], Syntax::Number),
    |b, i, hi| one_of(b, i, hi, SCAD_BUILTIN, Syntax::Type),
    |b, i, hi| if b[i] == b'$' { one(i, i + 1 + b[i + 1..hi].iter().take_while(|c| word(**c)).count(), Syntax::Variable).filter(|h| h[0].1 > i + 1) } else { None },
    number,
    // a name before a bracket is a call
    |b, i, hi| {
        let end = ident(b, i, hi)?;
        let next = end + b[end..b.len()].iter().take_while(|c| c.is_ascii_whitespace()).count();
        (b.get(next) == Some(&b'(')).then(|| vec![(i, end, Some(Syntax::Function))])
    },
    |b, i, hi| {
        let two = i + 2 <= hi && (matches!(&b[i..i + 2], b"&&" | b"||") || (b"<>!=".contains(&b[i]) && b[i + 1] == b'='));
        if two {
            return one(i, i + 2, Syntax::Operator);
        }
        if b"<>!=-+*/%^?:#".contains(&b[i]) { one(i, i + 1, Syntax::Operator) } else { None }
    },
    |b, i, _| punct(b, i, b"{}[];(),."),
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
fn argument(b: &[u8], i: usize, hi: usize, names: &[&str], star: bool, kind: Syntax) -> Option<Vec<Hit>> {
    let mut j = command(b, i, hi, names)?;
    if star && j < hi && b[j] == b'*' {
        j += 1;
    }
    if j < hi && b[j] == b'[' {
        j += b[j..hi].iter().position(|c| *c == b']')? + 1;
    }
    if j >= hi || b[j] != b'{' {
        return None;
    }
    let close = j + 1 + b[j + 1..hi].iter().position(|c| *c == b'}')?;
    (close > j + 1).then(|| vec![(j + 1, close, Some(kind))])
}

/// What an environment at `i` holds, `\begin{name}` to its `\end{name}`, for the environments named.
fn environment(b: &[u8], i: usize, hi: usize, names: &[&str], kind: Option<Syntax>) -> Option<Vec<Hit>> {
    let rest = b[i..hi].strip_prefix(b"\\begin{")?;
    let len = rest.iter().position(|c| *c == b'}')?;
    let name = std::str::from_utf8(&rest[..len]).ok()?;
    let bare = name.strip_suffix('*').unwrap_or(name);
    if !names.contains(&bare) {
        return None;
    }
    let from = i + 7 + len + 1;
    let end = format!("\\end{{{bare}");
    let to = from + b[from..hi].windows(end.len()).position(|w| w == end.as_bytes())?;
    (to > from).then(|| vec![(from, to, kind)])
}

const TEX: &[Rule] = &[
    // what verbatim holds is not LaTeX and is not coloured as any, and a comment runs to the end of
    // its line, but \% is a percent sign. One rule, so a percent sign inside verbatim is not a comment
    |b, i, hi| {
        if b[i] == b'%' && (i == 0 || b[i - 1] != b'\\') {
            return one(i, line_end(b, i, hi), Syntax::Comment);
        }
        // the opening is left for the rules after: only what it holds is taken
        environment(b, i, hi, &["verbatim", "lstlisting"], None)
    },
    // mathematics, in its four spellings
    |b, i, hi| {
        let until = |from: usize, close: &[u8], escapes: bool| -> Option<usize> {
            let mut j = from;
            while j < hi {
                if b[j..hi].starts_with(close) {
                    return (j > from).then_some(j + close.len());
                }
                if escapes && b[j] == b'$' {
                    return None;
                }
                j += if escapes && b[j] == b'\\' { 2 } else { 1 };
            }
            None
        };
        let end = if b[i..hi].starts_with(b"$$") {
            until(i + 2, b"$$", true).or_else(|| until(i + 1, b"$", true))
        } else if b[i] == b'$' {
            until(i + 1, b"$", true)
        } else if b[i..hi].starts_with(b"\\(") {
            until(i + 2, b"\\)", false).or(b[i + 2..hi].starts_with(b"\\)").then_some(i + 4))
        } else if b[i..hi].starts_with(b"\\[") {
            until(i + 2, b"\\]", false).or(b[i + 2..hi].starts_with(b"\\]").then_some(i + 4))
        } else {
            None
        };
        one(i, end?, Syntax::String)
    },
    |b, i, hi| environment(b, i, hi, &["align", "alignat", "eqnarray", "equation", "gather", "math", "multline"], Some(Syntax::String)),
    // the argument of a structural command: the package, the label, the environment opened
    |b, i, hi| argument(b, i, hi, &["begin", "end", "cite", "documentclass", "label", "ref", "eqref", "usepackage", "input", "include", "bibliography"], false, Syntax::Keyword),
    |b, i, hi| argument(b, i, hi, &["url", "href"], false, Syntax::Link),
    // section titles read as headings
    |b, i, hi| argument(b, i, hi, &["chapter", "part", "section", "subsection", "subsubsection", "paragraph", "subparagraph", "title", "author", "frametitle"], true, Syntax::Heading),
    // any other control word
    |b, i, hi| {
        if b[i] != b'\\' {
            return None;
        }
        let end = i + 1 + b[i + 1..hi].iter().take_while(|c| c.is_ascii_alphabetic() || **c == b'@').count();
        if end == i + 1 {
            return None;
        }
        one(i, if end < hi && b[end] == b'*' { end + 1 } else { end }, Syntax::Function)
    },
    |b, i, _| punct(b, i, b"[]{}&~"),
];

// ── gemtext ──────────────────────────────────────────────────────────────

const GMI: &[Rule] = &[
    // fenced text, to the line that closes it or the end
    |b, i, hi| {
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
    |b, i, hi| if line_start(b, i) && b[i] == b'#' { one(i, line_end(b, i, hi), Syntax::Heading) } else { None },
    // a link: its sign, where it goes, and its words left plain
    |b, i, hi| {
        if !line_start(b, i) || !b[i..hi].starts_with(b"=>") {
            return None;
        }
        let end = line_end(b, i, hi);
        let url = i + 2 + b[i + 2..end].iter().take_while(|c| c.is_ascii_whitespace()).count();
        let url_end = url + b[url..end].iter().take_while(|c| !c.is_ascii_whitespace()).count();
        Some(vec![(i, i + 2, Some(Syntax::Punctuation)), (i + 2, url, None), (url, url_end, Some(Syntax::Link)), (url_end, end, None)])
    },
    |b, i, hi| if line_start(b, i) && b[i] == b'>' { one(i, line_end(b, i, hi), Syntax::Comment) } else { None },
    |b, i, hi| if line_start(b, i) && b[i..hi].starts_with(b"* ") { one(i, i + 2, Syntax::Keyword) } else { None },
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
        let mut next = Vec::with_capacity(free.len());
        for (lo, hi) in free {
            let (mut i, mut from) = (lo, lo);
            while i < hi {
                // only at the start of a character: the rules read bytes, and all their signs are ASCII
                match rule(b, i, hi).filter(|_| b[i] < 0x80) {
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
}
