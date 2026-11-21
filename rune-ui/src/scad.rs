//! OpenSCAD's customizer parameters, read from a page's source, and the
//! one-line rewrite a change makes: a port of the web client's
//! `ui-src/scad/customizer.js`, which follows OpenSCAD's own parser.
//!
//! - A parameter is a top-level assignment of a literal: a number, a
//!   string, true or false, or a vector of up to four numbers.
//! - Parameters stop at the first module or function.
//! - `/* [Name] */` starts a group, and `[Hidden]` hides what follows.
//! - The comment on the same line says the widget: `// [10:100]` a
//!   range, `// [0:5:100]` one with a step, `// [a, b, c]` a list,
//!   `// [10:Small, 20:Large]` a labelled list, `// 2` a step, and for a
//!   string `// 12` its longest length.
//! - A `//` comment on the line just above is the description.
//!
//! Each parameter keeps where its value sits on its line, so a change
//! rewrites only those characters, and only while the line still holds
//! the value the parameter was read from.

/// A literal's value.
#[derive(Clone, Debug, PartialEq)]
pub enum Lit {
    Num(f64),
    Bool(bool),
    Str(String),
    Vector(Vec<f64>),
}

/// One parameter: its name, the line it is on, where its value sits on
/// that line in bytes, the value's text as written, and its widget.
#[derive(Clone, Debug, PartialEq)]
pub struct Param {
    pub name: String,
    pub line: usize,
    pub vs: usize,
    pub ve: usize,
    pub raw: String,
    pub value: Lit,
    pub group: String,
    pub description: String,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    /// The choices of a list: each value and the name shown for it.
    pub options: Vec<(Lit, String)>,
    pub max_length: Option<f64>,
}

/// Whether text is a number as OpenSCAD writes one: digits, a point, an exponent.
fn is_num(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = usize::from(b.first() == Some(&b'-'));
    let digits = |i: &mut usize| {
        let from = *i;
        while b.get(*i).is_some_and(u8::is_ascii_digit) {
            *i += 1;
        }
        *i - from
    };
    let whole = digits(&mut i);
    if whole > 0 {
        if b.get(i) == Some(&b'.') {
            i += 1;
            digits(&mut i);
        }
    } else {
        if b.get(i) != Some(&b'.') {
            return false;
        }
        i += 1;
        if digits(&mut i) == 0 {
            return false;
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

fn num(t: &str) -> Option<f64> {
    let t = t.trim();
    is_num(t).then(|| t.parse().ok()).flatten()
}

fn is_ident(t: &str) -> bool {
    let mut c = t.chars();
    c.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$') && c.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// The end of the string literal that opens at `i`: past its closing quote, or the end of the line.
fn string_end(b: &[u8], mut i: usize) -> usize {
    i += 1;
    while i < b.len() && b[i] != b'"' {
        i += if b[i] == b'\\' { 2 } else { 1 };
    }
    (i + 1).min(b.len())
}

/// The code of a line with its comments taken out and its strings emptied. `block` carries a block comment over lines.
fn code_of(line: &str, block: &mut bool) -> String {
    let b = line.as_bytes();
    let (mut out, mut i) = (Vec::new(), 0);
    while i < b.len() {
        if *block {
            match line[i..].find("*/") {
                Some(e) => {
                    *block = false;
                    i += e + 2;
                    continue;
                }
                None => break,
            }
        }
        match (b[i], b.get(i + 1)) {
            (b'/', Some(b'/')) => break,
            (b'/', Some(b'*')) => {
                *block = true;
                i += 2;
            }
            (b'"', _) => {
                i = string_end(b, i);
                out.extend(b"\"\"");
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A string literal's text, with OpenSCAD's escapes. Any other backslash stays as written.
fn unquote(t: &str) -> String {
    let inner: Vec<char> = t[1..t.len() - 1].chars().collect();
    let (mut out, mut i) = (String::new(), 0);
    while i < inner.len() {
        if inner[i] != '\\' || i + 1 >= inner.len() {
            out.push(inner[i]);
            i += 1;
            continue;
        }
        let hex = |n: usize| -> Option<char> {
            let h: String = inner.get(i + 2..i + 2 + n)?.iter().collect();
            (h.len() == n && h.chars().all(|c| c.is_ascii_hexdigit())).then(|| u32::from_str_radix(&h, 16).ok().and_then(char::from_u32)).flatten()
        };
        let (ch, used) = match inner[i + 1] {
            'n' => (Some('\n'), 2),
            't' => (Some('\t'), 2),
            'r' => (Some('\r'), 2),
            '"' => (Some('"'), 2),
            '\\' => (Some('\\'), 2),
            'x' if hex(2).is_some() => (hex(2), 4),
            'u' if hex(4).is_some() => (hex(4), 6),
            _ => (None, 2),
        };
        match ch {
            Some(c) => out.push(c),
            None => out.extend(&inner[i..i + 2]),
        }
        i += used;
    }
    out
}

/// A literal's value, or nothing. Vectors are numbers only, four at most.
pub fn parse_literal(t: &str) -> Option<Lit> {
    let t = t.trim();
    if is_num(t) {
        return t.parse().ok().map(Lit::Num);
    }
    match t {
        "true" => return Some(Lit::Bool(true)),
        "false" => return Some(Lit::Bool(false)),
        _ => {}
    }
    if is_whole_string(t) {
        return Some(Lit::Str(unquote(t)));
    }
    let inner = t.strip_prefix('[')?.strip_suffix(']')?;
    if inner.trim().is_empty() {
        return None;
    }
    let parts: Vec<&str> = inner.split(',').map(str::trim).collect();
    if parts.len() > 4 || !parts.iter().all(|p| is_num(p)) {
        return None;
    }
    Some(Lit::Vector(parts.iter().filter_map(|p| p.parse().ok()).collect()))
}

/// Whether text is one string literal and nothing else: a quote, then characters or escaped pairs, then the closing quote.
fn is_whole_string(t: &str) -> bool {
    let c: Vec<char> = t.chars().collect();
    if c.len() < 2 || c[0] != '"' {
        return false;
    }
    let mut i = 1;
    while i < c.len() - 1 {
        match c[i] {
            '"' => return false,
            '\\' if i + 1 < c.len() - 1 && c[i + 1] != '\n' => i += 2,
            '\\' => return false,
            _ => i += 1,
        }
    }
    i == c.len() - 1 && c[i] == '"'
}

struct Assign {
    name: String,
    vs: usize,
    ve: usize,
}

/// A top-level line's assignments, its trailing comment, and whether nothing else follows them.
fn assignments(line: &str) -> (Vec<Assign>, Option<&str>) {
    let b = line.as_bytes();
    let (mut out, mut i, n) = (Vec::new(), 0, b.len());
    loop {
        let rest = &line[i..];
        let start = i + (rest.len() - rest.trim_start().len());
        let name_len = line[start..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')).unwrap_or(n - start);
        let name = &line[start..start + name_len];
        if !is_ident(name) {
            i = start;
            break;
        }
        let after = line[start + name_len..].trim_start();
        let Some(value) = after.strip_prefix('=') else {
            i = start;
            break;
        };
        let vs = n - value.trim_start().len();
        // the value runs to the first ; outside a string or brackets
        let (mut j, mut depth) = (vs, 0i32);
        while j < n {
            match b[j] {
                b'"' => {
                    // an unclosed string runs off the line, as it does in the web client
                    j += 1;
                    while j < n && b[j] != b'"' {
                        j += if b[j] == b'\\' { 2 } else { 1 };
                    }
                    j += 1;
                    continue;
                }
                b'[' | b'(' => depth += 1,
                b']' | b')' => depth -= 1,
                b';' if depth == 0 => break,
                _ => {}
            }
            j += 1;
        }
        if j >= n {
            i = start;
            break;
        }
        let ve = vs + line[vs..j].trim_end().len();
        out.push(Assign { name: name.to_owned(), vs, ve });
        i = j + 1;
    }
    let comment = line.get(i..).and_then(|rest| rest.trim_start().strip_prefix("//"));
    (out, comment)
}

/// A number as JavaScript writes one, which is how the web client names a choice and writes a value.
pub fn js_num(v: f64) -> String {
    if !v.is_finite() {
        return if v.is_nan() { "NaN".into() } else if v > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if v == 0.0 {
        return "0".into();
    }
    let a = v.abs();
    if (1e-6..1e21).contains(&a) {
        return format!("{v}");
    }
    let s = format!("{v:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

fn lit_name(v: &Lit) -> String {
    match v {
        Lit::Num(n) => js_num(*n),
        Lit::Str(s) => s.clone(),
        Lit::Bool(b) => b.to_string(),
        Lit::Vector(v) => v.iter().map(|n| js_num(*n)).collect::<Vec<_>>().join(","),
    }
}

/// The widget a comment names for a value: its range, step, choices or longest length.
fn widget(p: &mut Param, comment: Option<&str>) {
    let Some(c) = comment.map(str::trim) else { return };
    let Some(body) = c.strip_prefix('[').and_then(|x| x.strip_suffix(']')).filter(|x| !x.contains(']')) else {
        // a bare number: a number's step, a string's longest length
        if let Some(n) = is_num(c).then(|| c.parse::<f64>().ok()).flatten() {
            match p.value {
                Lit::Num(_) => p.step = Some(n),
                Lit::Str(_) => p.max_length = Some(n),
                _ => {}
            }
        }
        return;
    };
    // a range: [max], [min:max] or [min:step:max], numbers only
    let parts: Vec<Option<f64>> = body.split(':').map(num).collect();
    let numeric = matches!(p.value, Lit::Num(_) | Lit::Vector(_));
    if numeric && !body.contains(',') && parts.iter().all(Option::is_some) {
        let v: Vec<f64> = parts.into_iter().flatten().collect();
        match v.as_slice() {
            [max] => (p.min, p.max, p.step) = (Some(0.0), Some(*max), Some(1.0)),
            [min, max] => (p.min, p.max, p.step) = (Some(*min), Some(*max), Some(1.0)),
            [min, step, max] => (p.min, p.max, p.step) = (Some(*min), Some(*max), Some(*step)),
            _ => {}
        }
        if v.len() <= 3 {
            return;
        }
    }
    // a list: [a, b, c] or [value:label, ...]
    if !matches!(p.value, Lit::Num(_) | Lit::Str(_)) {
        return;
    }
    let mut opts = Vec::new();
    for it in body.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        // a quoted choice is its text
        let uq = |x: &str| if x.len() >= 2 && x.starts_with('"') && x.ends_with('"') { x[1..x.len() - 1].to_owned() } else { x.to_owned() };
        let (v, label, labelled) = match it.split_once(':') {
            Some((v, l)) => (uq(v.trim()), uq(l.trim()), true),
            None => (uq(it), uq(it), false),
        };
        match num(&v) {
            Some(n) => opts.push((Lit::Num(n), if labelled { label } else { js_num(n) })),
            // a number's choices are numbers, or it has none
            None if matches!(p.value, Lit::Num(_)) => return,
            None => opts.push((Lit::Str(v), label)),
        }
    }
    if opts.is_empty() {
        return;
    }
    // the value in the source is always one of the choices, first if it is not in the list
    if !opts.iter().any(|(v, _)| *v == p.value) {
        opts.insert(0, (p.value.clone(), lit_name(&p.value)));
    }
    p.options = opts;
}

/// Every parameter in a source, in order, with its group. Hidden ones are left out.
pub fn parse_params(src: &str) -> Vec<Param> {
    let mut block = false;
    let mut out: Vec<Param> = Vec::new();
    let (mut group, mut depth, mut desc) = ("Parameters".to_owned(), 0usize, None::<String>);
    for (ln, line) in src.split('\n').enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let was_block = block;
        let code = code_of(line, &mut block);
        let named = line.trim().strip_prefix("/*").and_then(|x| x.strip_suffix("*/")).map(str::trim).and_then(|x| x.strip_prefix('[')).and_then(|x| x.strip_suffix(']')).filter(|x| !x.contains(']'));
        if let (false, Some(g), 0) = (was_block, named, depth) {
            group = g.trim().to_owned();
            desc = None;
            continue;
        }
        if depth == 0 && !was_block {
            let word = code.trim_start();
            if ["module", "function"].iter().any(|w| word.strip_prefix(w).is_some_and(|r| !r.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))) {
                break;
            }
            if let Some(d) = line.trim_start().strip_prefix("//") {
                desc = Some(d.trim().to_owned());
                continue;
            }
            let (list, comment) = assignments(line);
            let alone = list.len() == 1;
            for (k, a) in list.iter().enumerate() {
                let raw = &line[a.vs..a.ve];
                let Some(value) = parse_literal(raw) else { continue };
                if group.eq_ignore_ascii_case("hidden") {
                    continue;
                }
                let mut p = Param { name: a.name.clone(), line: ln, vs: a.vs, ve: a.ve, raw: raw.to_owned(), value, group: group.clone(), description: if k == 0 { desc.clone().unwrap_or_default() } else { String::new() }, min: None, max: None, step: None, options: Vec::new(), max_length: None };
                // only a line with one assignment takes the comment's widget
                if alone {
                    widget(&mut p, comment);
                }
                if matches!(p.value, Lit::Num(_)) && p.options.is_empty() && p.min.is_none() && p.step.is_none() {
                    p.step = Some(1.0);
                }
                out.push(p);
            }
            desc = None;
        }
        for c in code.chars() {
            match c {
                '{' => depth += 1,
                '}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    // a name assigned twice keeps its last line, as OpenSCAD's value is
    let last: std::collections::HashMap<String, usize> = out.iter().enumerate().map(|(i, p)| (p.name.clone(), i)).collect();
    out.into_iter().enumerate().filter(|(i, p)| last.get(&p.name) == Some(i)).map(|(_, p)| p).collect()
}

/// A value as OpenSCAD source. A number is written with as many decimals as its step has, so a 0.1 step writes 2.3 and not 2.3000000000000003.
pub fn fmt_value(v: &Lit, step: Option<f64>) -> String {
    match v {
        Lit::Bool(b) => b.to_string(),
        Lit::Str(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")),
        Lit::Vector(v) => format!("[{}]", v.iter().map(|x| fmt_value(&Lit::Num(*x), step)).collect::<Vec<_>>().join(", ")),
        Lit::Num(n) if !n.is_finite() => "0".into(),
        Lit::Num(n) => {
            let decimals = step.filter(|s| s.fract() != 0.0).map_or(0, |s| js_num(s).split_once('.').map_or(0, |(_, d)| d.len()).min(10));
            let r: f64 = if decimals > 0 {
                format!("{n:.decimals$}").parse().unwrap_or(*n)
            } else if n.fract() == 0.0 {
                *n
            } else {
                format!("{n:.11e}").parse().unwrap_or(*n)
            };
            js_num(r)
        }
    }
}

/// The line with a parameter's value replaced, or nothing when the line no longer holds the value the parameter was read from.
pub fn rewrite_line(line: &str, p: &Param, v: &Lit) -> Option<String> {
    (line.get(p.vs..p.ve) == Some(p.raw.as_str())).then(|| format!("{}{}{}", &line[..p.vs], fmt_value(v, p.step), &line[p.ve..]))
}

/// The page with one parameter given a new value: its line rewritten and nothing else touched.
pub fn set_param(src: &str, p: &Param, v: &Lit) -> Option<String> {
    let mut at = 0;
    for (ln, line) in src.split('\n').enumerate() {
        if ln == p.line {
            let new = rewrite_line(line, p, v)?;
            return Some(format!("{}{new}{}", &src[..at], &src[at + line.len()..]));
        }
        at += line.len() + 1;
    }
    None
}

// ── include and use ──────────────────────────────────────────────────────
//
// A port of the web client's `ui-src/scad/includes.js`. A page
// `parts/box` is the file `/w/parts/box.scad`, and `include
// <lib/screws.scad>` in it names the page `parts/lib/screws`. Paths stay
// inside lattice: an absolute path, a URL and a `..` above the top are
// refused, and depth, file count and size are capped.

/// Where the pages stand as files when OpenSCAD reads them.
pub const ROOT: &str = "/w/";
/// How deep includes nest, how many files, and how many bytes in all.
pub const CAPS: (usize, usize, usize) = (8, 64, 4 * 1024 * 1024);

/// An `include` or `use` in a source: which, the path as written, and its line, counted from one.
#[derive(Clone, Debug, PartialEq)]
pub struct Include {
    pub kind: &'static str,
    pub path: String,
    pub line: usize,
}

/// Where something next stands in a source, at or after a place. The
/// last answer is kept, so asking from places further and further along
/// reads the source through once and not once for each asking.
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

/// Whether what stands at `i` runs on from a name before it. OpenSCAD's
/// lexer takes the longest word it can, so `xinclude` and `_use` are
/// names, and an `include` after anything else is the keyword: after a
/// brace, a bracket, a comma, or the figures of a number.
fn joined(b: &[u8], i: usize) -> bool {
    i > 0 && (b[i - 1].is_ascii_alphabetic() || matches!(b[i - 1], b'_' | b'$'))
}

/// Where the path of an `include <` or `use <` that starts at `i` starts: just past its `<`.
fn opener(src: &str, i: usize) -> Option<(&'static str, usize)> {
    let kind = ["include", "use"].into_iter().find(|k| src[i..].starts_with(k))?;
    let rest = &src[i + kind.len()..];
    let open = i + kind.len() + (rest.len() - rest.trim_start().len());
    src[open..].starts_with('<').then_some((kind, open + 1))
}

/// Where an `include <...>` or `use <...>` that starts at `i` ends, and where its path lies. `ends` keeps where a path was last found to end.
fn include_at(src: &str, i: usize, ends: &mut Seek) -> Option<(&'static str, usize, usize)> {
    let (kind, from) = opener(src, i)?;
    let end = ends.at(src, from, |t| t.find(['>', '\n'])).filter(|e| src.as_bytes()[*e] == b'>')?;
    Some((kind, from, end))
}

/// The source with its comments and strings blanked, lengths kept. An include's path is left whole, as OpenSCAD's lexer reads it, so a `//` inside one is part of the path.
fn bare(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let blank = |out: &mut String, s: &str| out.extend(s.chars().map(|c| if c == '\n' { "\n".to_owned() } else { " ".repeat(c.len_utf8()) }));
    // where a path ends and where a block comment does, each looked for once, and the stretch of
    // a string that was read through and never closed: a quote inside it is one a backslash escaped
    let (mut ends, mut comment, mut open_string) = (Seek::default(), Seek::default(), 0..0);
    let mut i = 0;
    while i < b.len() {
        if let Some((_, _, end)) = include_at(src, i, &mut ends).filter(|_| !joined(b, i)) {
            out.push_str(&src[i..=end]);
            i = end + 1;
            continue;
        }
        let end = match (b[i], b.get(i + 1)) {
            (b'/', Some(b'*')) => comment.at(src, i + 2, |t| t.find("*/")).map(|e| e + 2),
            (b'/', Some(b'/')) => Some(src[i..].find('\n').map_or(b.len(), |e| i + e)),
            (b'"', _) if open_string.contains(&i) => None,
            (b'"', _) => {
                // a string closes on its own line, or it is not one
                let mut j = i + 1;
                let end = loop {
                    match b.get(j) {
                        Some(b'"') => break Some(j + 1),
                        Some(b'\\') if b.get(j + 1).is_some_and(|c| *c != b'\n') => j += 1 + src[j + 1..].chars().next().map_or(1, char::len_utf8),
                        Some(b'\n' | b'\\') | None => break None,
                        Some(_) => j += 1,
                    }
                };
                if end.is_none() {
                    open_string = i..j;
                }
                end
            }
            _ => None,
        };
        match end {
            Some(e) => {
                blank(&mut out, &src[i..e]);
                i = e;
            }
            None => {
                let n = src[i..].chars().next().map_or(1, char::len_utf8);
                out.push_str(&src[i..i + n]);
                i += n;
            }
        }
    }
    out
}

/// Every include and use in a source, wherever it stands outside a
/// comment and a string: at the start of a line, inside a module's
/// braces, after a bracket or a comma. OpenSCAD's lexer takes the
/// keyword in all of those places, so each is one to answer for.
pub fn scan_includes(src: &str) -> Vec<Include> {
    let b = bare(src);
    let bytes = b.as_bytes();
    let mut out = Vec::new();
    let mut ends = Seek::default();
    // the line being read, counted as it is passed
    let (mut i, mut line) = (0, 1);
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            line += 1;
        }
        if !b.is_char_boundary(i) {
            i += 1;
            continue;
        }
        match include_at(&b, i, &mut ends).filter(|_| !joined(bytes, i)) {
            Some((kind, from, to)) => {
                out.push(Include { kind, path: src[from..to].to_owned(), line });
                // a keyword and its path may stand on two lines
                line += b[i..to].matches('\n').count();
                i = to + 1;
            }
            None => i += 1,
        }
    }
    out
}

/// The modules and functions of OpenSCAD that read a file it is given the name of.
const READS: [&str; 11] = ["import", "surface", "import_stl", "import_off", "import_dxf", "dxf_linear_extrude", "dxf_rotate_extrude", "linear_extrude", "rotate_extrude", "dxf_dim", "dxf_cross"];

/// Whether a file's name, as a string in a source, could lead out of the
/// page's own folder: an absolute path, a drive or a scheme, a `..`, or
/// a backslash, which is how a string spells a character it does not show.
fn leaves(path: &str) -> bool {
    let t = path.trim();
    let scheme = t.split_once(':').is_some_and(|(s, _)| s.starts_with(|c: char| c.is_ascii_alphabetic()) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')));
    scheme || t.starts_with('/') || t.starts_with('~') || t.contains('\\') || t.split('/').any(|p| p.trim() == "..")
}

/// A source made safe to hand to the real `openscad` program, which
/// opens whatever path it is given on this machine: the rule is that a
/// page pulls in other lattice pages and nothing else. Every `include`
/// and `use` that `resolve_ref` refuses is blanked, and so is the
/// opening of one whose path does not end on its line or has a tab in
/// it, since OpenSCAD reads such a path in pieces and opens the last.
/// Every string that names a file to `import`, `surface` and their kin
/// is emptied when it could lead out of the page's folder (`leaves`).
/// What is blanked becomes spaces, so every line keeps its number.
/// `dir` is the folder of the page the source is. Each note is the
/// line of a string that was emptied, and what to say of it.
///
/// An include is looked for everywhere, in comments and strings too:
/// a path this code took to be in a comment and OpenSCAD did not would
/// else be opened. A file's name that is worked out when the model runs
/// (`import(str(a, b))` with `a` set elsewhere) cannot be seen here.
// ponytail: a name built at run time is not caught. Running openscad in a sandbox of its own is the whole answer
pub fn tame(dir: &str, src: &str) -> (String, Vec<(usize, String)>) {
    let mut out = src.as_bytes().to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| out[from..to].iter_mut().filter(|c| !matches!(**c, b'\n' | b'\r')).for_each(|c| *c = b' ');
    let b = src.as_bytes();
    let mut ends = Seek::default();
    let mut i = 0;
    while i < b.len() {
        let Some((_, from)) = (matches!(b[i], b'i' | b'u') && !joined(b, i)).then(|| opener(src, i)).flatten() else {
            i += 1;
            continue;
        };
        match ends.at(src, from, |t| t.find(['>', '\n', '\r', '\t'])).filter(|e| b[*e] == b'>') {
            Some(end) if resolve_ref(dir, &src[from..end]).is_err() => blank(&mut out, i, end + 1),
            Some(_) => {}
            None => blank(&mut out, i, from),
        }
        i = from;
    }
    // only whole characters were made spaces, so this is still text
    let text = String::from_utf8(out).unwrap_or_default();
    let b = text.as_bytes();
    let mut out = b.to_vec();
    let mut notes = Vec::new();
    // the brackets open, each with whether a reader of files opened it, and how many of those there are
    let (mut open, mut reading, mut named, mut line) = (Vec::new(), 0usize, false, 1usize);
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\n' => (i, line) = (i + 1, line + 1),
            c if c.is_ascii_whitespace() => i += 1,
            b'/' if b.get(i + 1) == Some(&b'/') => i = text[i..].find('\n').map_or(b.len(), |e| i + e),
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let end = text[i + 2..].find("*/").map_or(b.len(), |e| i + 2 + e + 2);
                line += text[i..end].matches('\n').count();
                i = end;
            }
            b'"' => {
                // to the next quote no backslash stands before, over line ends, as OpenSCAD reads one
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' {
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
                let j = j.min(b.len());
                if reading > 0 && leaves(&text[i + 1..j]) {
                    notes.push((line, format!("{}: only files in your pages can be read, by a path that stays in the page's folder", text[i + 1..j].trim().chars().take(80).collect::<String>())));
                    blank(&mut out, i + 1, j);
                }
                line += text[i..j].matches('\n').count();
                (i, named) = ((j + 1).min(b.len()), false);
            }
            c if c.is_ascii_alphanumeric() || matches!(c, b'_' | b'$') || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_digit)) => {
                let word = i + b[i..].iter().take_while(|c| c.is_ascii_alphanumeric() || matches!(**c, b'_' | b'$')).count();
                let figures = i + b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
                if let Some((_, from)) = opener(&text, i).filter(|_| c != b'.') {
                    // an include that was let stand: its path is no code
                    let end = text[from..].find('>').map_or(b.len(), |e| from + e + 1);
                    line += text[i..end].matches('\n').count();
                    (i, named) = (end, false);
                } else if figures == word && b.get(word) == Some(&b'.') {
                    // a number with a point: what follows its figures is a word of its own
                    let mut j = word + 1 + b[word + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
                    let sign = usize::from(matches!(b.get(j), Some(b'e' | b'E'))) + usize::from(matches!(b.get(j), Some(b'e' | b'E')) && matches!(b.get(j + 1), Some(b'+' | b'-')));
                    let power = b.get(j + sign..).map_or(0, |r| r.iter().take_while(|c| c.is_ascii_digit()).count());
                    if sign > 0 && power > 0 {
                        j += sign + power;
                    }
                    (i, named) = (j, false);
                } else {
                    named = READS.contains(&&text[i..word]);
                    i = word.max(i + 1);
                }
            }
            b'(' => {
                open.push(named);
                reading += usize::from(named);
                (i, named) = (i + 1, false);
            }
            b')' => {
                reading -= usize::from(open.pop().unwrap_or(false));
                (i, named) = (i + 1, false);
            }
            _ => (i, named) = (i + 1, false),
        }
    }
    (String::from_utf8(out).unwrap_or_default(), notes)
}

/// A path written in a file in `dir` (a page folder, empty at the top), as the page it names and the file it becomes. An error says why it is refused.
pub fn resolve_ref(dir: &str, path: &str) -> Result<(String, String), String> {
    let r = path.trim();
    if r.is_empty() {
        return Err("an empty include".into());
    }
    let scheme = r.split_once(':').is_some_and(|(s, _)| s.starts_with(|c: char| c.is_ascii_alphabetic()) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')));
    if scheme || r.starts_with('/') || r.contains('\\') {
        return Err(format!("{r}: only lattice pages can be included, by a relative path"));
    }
    let mut out: Vec<&str> = Vec::new();
    for p in dir.split('/').filter(|_| !dir.is_empty()).chain(r.split('/')) {
        match p {
            "" | "." => {}
            ".." => {
                if out.pop().is_none() {
                    return Err(format!("{r}: reaches above the top of your pages"));
                }
            }
            p => out.push(p),
        }
    }
    if out.is_empty() {
        return Err(format!("{r}: names no page"));
    }
    let file = out.join("/");
    let page = if file.len() >= 5 && file.is_char_boundary(file.len() - 5) && file[file.len() - 5..].eq_ignore_ascii_case(".scad") { file[..file.len() - 5].to_owned() } else { file.clone() };
    Ok((page, format!("{ROOT}{file}")))
}

/// A page and everything it includes: its own file's name, every file
/// with its text made safe to run (`tame`), and notes on what was
/// refused or capped. `read`
/// answers a page's text, or nothing when there is no such page: that
/// one is left out, and OpenSCAD says which include it could not open.
pub fn collect(name: &str, text: &str, mut read: impl FnMut(&str) -> Option<String>) -> (String, Vec<(String, String)>, Vec<String>) {
    let (max_depth, max_files, max_bytes) = CAPS;
    let main = format!("{ROOT}{name}.scad");
    // every file is handed on tamed: what it may not open is taken out of it (`tame`)
    let mut notes = Vec::new();
    let tamed = |page: &str, text: &str, notes: &mut Vec<String>| {
        let (safe, said) = tame(page.rsplit_once('/').map_or("", |(d, _)| d), text);
        notes.extend(said.into_iter().map(|(line, why)| format!("line {line} of {page}: {why}")));
        safe
    };
    let mut files: Vec<(String, String)> = vec![(main.clone(), tamed(name, text, &mut notes))];
    let mut bytes = text.len();
    let mut queue: std::collections::VecDeque<(String, String, usize)> = [(name.to_owned(), text.to_owned(), 0)].into();
    let mut asked: std::collections::HashMap<String, Option<String>> = Default::default();
    'all: while let Some((page, t, depth)) = queue.pop_front() {
        let dir = page.rsplit_once('/').map_or("", |(d, _)| d);
        for inc in scan_includes(&t) {
            let (p, file) = match resolve_ref(dir, &inc.path) {
                Ok(r) => r,
                Err(why) => {
                    notes.push(format!("line {} of {page}: {why}", inc.line));
                    continue;
                }
            };
            if files.iter().any(|(f, _)| *f == file) {
                continue;
            }
            if depth + 1 > max_depth {
                notes.push(format!("{p}: includes nest deeper than {max_depth}, not read"));
                continue;
            }
            if files.len() >= max_files {
                notes.push(format!("more than {max_files} included files, the rest not read"));
                break 'all;
            }
            let Some(body) = asked.entry(p.clone()).or_insert_with(|| read(&p)).clone() else { continue };
            if bytes + body.len() > max_bytes {
                notes.push(format!("{p}: the included files pass {} MB, not read", max_bytes >> 20));
                continue;
            }
            bytes += body.len();
            files.push((file, tamed(&p, &body, &mut notes)));
            queue.push_back((p, body, depth + 1));
        }
    }
    (main, files, notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_are_found_and_resolved_as_the_web_client_does() {
        // sets of pages, and for each the main page's files and notes from the web client's collect under node
        let cases: serde_json::Value = serde_json::from_str(include_str!("scad_includes.json")).unwrap();
        let mut n = 0;
        for case in cases.as_array().unwrap() {
            let pages = case["pages"].as_object().unwrap();
            let name = case["name"].as_str().unwrap();
            // a very long page is kept in the corpus as one character and a count
            let text = |v: &str| match v.strip_prefix("@repeat:").and_then(|r| r.split_once(':')) {
                Some((ch, n)) => ch.repeat(n.parse().unwrap()),
                None => v.to_owned(),
            };
            let (main, files, notes) = collect(name, pages[name].as_str().unwrap(), |p| pages.get(p).and_then(|v| v.as_str()).map(text));
            assert_eq!(main, case["main"].as_str().unwrap());
            let got: Vec<&str> = files.iter().map(|(f, _)| f.as_str()).collect();
            let want: Vec<&str> = case["files"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
            assert_eq!(got, want, "{name}");
            let want: Vec<&str> = case["notes"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
            assert_eq!(notes, want, "{name}");
            let mut scanned: Vec<String> = scan_includes(pages[name].as_str().unwrap()).iter().map(|i| format!("{} {} {}", i.kind, i.line, i.path)).collect();
            let want: Vec<&str> = case["scan"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
            // the web client takes an include only after a space, a semicolon or a closing brace. OpenSCAD
            // itself takes one after a comma too, and this answers for what OpenSCAD will open
            if name == "c" {
                assert_eq!(scanned.iter().filter(|s| *s == "include 9 no6").count(), 1);
                scanned.retain(|s| s != "include 9 no6");
            }
            assert_eq!(scanned, want, "{name}");
            n += 1;
        }
        assert!(n >= 10, "{n}");
        // a file's text is what the page holds, and the main page comes first
        let (_, files, _) = collect("a", "use <b>", |p| (p == "b").then(|| "cube(1);".to_owned()));
        assert_eq!(files, [("/w/a.scad".to_owned(), "use <b>".to_owned()), ("/w/b".to_owned(), "cube(1);".to_owned())]);
        for bad in ["", "include <", "use <\n>", "include<é", "\"é\\", "/* é", "é include <é>", "include <a>\u{0}use <b>"] {
            let _ = scan_includes(bad);
        }
    }

    fn lit_json(v: &Lit) -> String {
        match v {
            Lit::Num(n) => js_num(*n),
            Lit::Bool(b) => b.to_string(),
            Lit::Str(s) => js(s),
            Lit::Vector(v) => format!("[{}]", v.iter().map(|n| js_num(*n)).collect::<Vec<_>>().join(",")),
        }
    }

    /// Text as JSON writes it, which is how the corpus holds it.
    fn js(s: &str) -> String {
        serde_json::to_string(s).unwrap()
    }

    /// One line a parameter, as the node script beside the corpus writes the web client's.
    fn dump(src: &str) -> String {
        let lines: Vec<&str> = src.split('\n').collect();
        let utf16 = |line: usize, at: usize| lines[line][..at].encode_utf16().count();
        let o = |v: Option<f64>| v.map_or("-".to_owned(), js_num);
        parse_params(src)
            .iter()
            .map(|p| {
                let opts = p.options.iter().map(|(v, n)| format!("{}={}", lit_json(v), js(n))).collect::<Vec<_>>().join(";");
                format!("{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}", p.name, p.line, utf16(p.line, p.vs), utf16(p.line, p.ve), js(&p.raw), lit_json(&p.value), js(&p.group), js(&p.description), o(p.min), o(p.max), o(p.step), opts, o(p.max_length))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn parameters_are_read_as_the_web_client_reads_them() {
        // each source, then what the web client's parseParams gave for it under node
        let corpus = include_str!("scad_corpus.txt");
        let mut n = 0;
        for case in corpus.split("\n=====\n") {
            let Some((src, want)) = case.split_once("\n-----\n") else { continue };
            assert_eq!(dump(src), want.trim_end_matches('\n'), "source:\n{src}");
            n += 1;
        }
        assert!(n >= 12, "{n} cases");
    }

    #[test]
    fn a_change_rewrites_only_the_value() {
        let src = "// how wide\nwidth = 20; // [10:100]\nname = \"box\";\nsize = [1, 2.5, 3];\non = true;\nfine = 2.3; // [0:0.1:5]\n";
        let ps = parse_params(src);
        assert_eq!(set_param(src, &ps[0], &Lit::Num(45.0)).unwrap(), src.replace("width = 20;", "width = 45;"));
        assert_eq!(set_param(src, &ps[1], &Lit::Str("a \"b\" \\c".into())).unwrap(), src.replace("\"box\"", "\"a \\\"b\\\" \\\\c\""));
        assert_eq!(set_param(src, &ps[2], &Lit::Vector(vec![4.0, 5.0, 6.5])).unwrap(), src.replace("[1, 2.5, 3]", "[4, 5, 6.5]"));
        assert_eq!(set_param(src, &ps[3], &Lit::Bool(false)).unwrap(), src.replace("on = true", "on = false"));
        // a 0.1 step writes one decimal, not the sum's last bits
        assert_eq!(set_param(src, &ps[4], &Lit::Num(2.3 + 0.1 + 0.1)).unwrap(), src.replace("fine = 2.3;", "fine = 2.5;"));
        // the line changed since it was read: nothing is written
        let moved = src.replace("width = 20;", "width = 21;");
        assert_eq!(set_param(&moved, &ps[0], &Lit::Num(45.0)), None);
        // set to what it holds, the page is as it was
        assert_eq!(set_param(src, &ps[0], &Lit::Num(20.0)).unwrap(), src);
        for (v, want) in [(1e21, "1e+21"), (1e-7, "1e-7"), (0.1, "0.1"), (-3.0, "-3"), (123456.789, "123456.789"), (0.0, "0")] {
            assert_eq!(js_num(v), want);
        }
    }

    #[test]
    fn broken_sources_do_not_panic() {
        for bad in ["", "=", "a=", "a=\"", "a=\"\\", "a=[", "a=[1,2", "/*", "/* [", "é=1;", "a = 1; é", "a=1;b=\"é\";// é", "x = \"é\\", "module", "a = 1 // no semicolon", "\"", "a=\"\\x\";", "a=\"\\u12\";"] {
            let _ = parse_params(bad);
        }
    }

    #[test]
    fn an_include_is_found_wherever_openscad_would_take_it() {
        let found = |src: &str| scan_includes(src).iter().map(|i| format!("{} {} {}", i.kind, i.line, i.path)).collect::<Vec<_>>();
        assert_eq!(found("module m(){include </home/u/x.scad>}"), ["include 1 /home/u/x.scad"]);
        assert_eq!(found("if(true)include </home/u/x.scad>"), ["include 1 /home/u/x.scad"]);
        assert_eq!(found("a=[1,use <b>\n];x=1.5include<c>\n\nfoo()use\n<d>"), ["use 1 b", "include 2 c", "use 4 d"]);
        // a name that ends in the keyword is a name, and a comment and a string hold none
        assert!(found("xinclude <a> _use <b> $use <c> reuse <d> // use <e>\n/* use <f> */ \"use <g>\"").is_empty());
        // many openings with no end, of a path, a comment and a string: each once read the rest of the page
        for piece in ["use <", "include <a ", "/* ", "\"\\\"", "\"a ", "use <a>\n"] {
            let src = piece.repeat(40_000 / piece.len());
            let t = std::time::Instant::now();
            let (_, files, _) = collect("a", &src, |_| None);
            assert!(t.elapsed().as_millis() < 5000, "{piece:?} took {:?}", t.elapsed());
            assert_eq!(files[0].1.len(), src.len());
        }
    }

    #[test]
    fn what_is_handed_to_openscad_opens_nothing_outside_the_pages() {
        let run = |src: &str| collect("parts/box", src, |p| (p == "parts/lib").then(|| "cube(1);".to_owned()));
        // each of these names a file of this machine in a way OpenSCAD would open
        for src in [
            "module m(){include </home/u/x.scad>}",
            "if(true)include </home/u/x.scad>",
            "include </home/u/x.scad>",
            "use <../../home/u/x.scad>",
            "x=1.5include </home/u/x.scad>",
            "a=[1,include </home/u/x.scad>];",
            "include <\n/home/u/x.scad>",
            "include <a\t/home/u/x.scad>",
            "use <a\r/home/u/x.scad>",
            "s = \"a\n\"; include </home/u/x.scad> ; t = \"b\";",
            "/* \"*/ include </home/u/x.scad> /*\" */",
            "import(\"/home/u/x.stl\");",
            "import (file = \"/home/u/x.stl\", convexity = 3);",
            "translate([1,0,0]) surface(file=\"../../../home/u/x.png\", center=true);",
            "import(str(\"/home/u\", \"/x.stl\"));",
            "import(\"\\x2fhome\\x2fu\\x2fx.stl\");",
            "x = dxf_dim(file=\"C:/home/u/x.dxf\", name=\"w\");",
            "linear_extrude(file = \"/home/u/x.dxf\") square(1);",
            "import(/* \" */ \"/home/u/x.stl\");",
            "import(\"a.stl\", \"~/home/u/x.stl\");",
        ] {
            let (_, files, _) = run(src);
            let safe = &files[0].1;
            // a path that does not end on its line, or has a tab in it, has its opening taken away: what
            // is left of it is no include, and OpenSCAD reads it as code that means nothing
            let split = src.contains("<\n") || src.contains("\t") || src.contains("\r");
            assert!(if split { !safe.contains("include") && !safe.contains("use") } else { !safe.contains("home") && !safe.contains("x2f") }, "{src:?} is handed on as {safe:?}");
            assert_eq!(tame("parts", safe).0, *safe, "what is tamed is tame");
            assert_eq!((safe.len(), safe.matches('\n').count()), (src.len(), src.matches('\n').count()), "lengths and lines are kept: {src:?}");
        }
        // a refused include is noted as it was, and a refused file is noted too
        let (_, _, notes) = run("include </home/u/x.scad>\nimport(\"/home/u/x.stl\");");
        assert_eq!(notes, ["line 2 of parts/box: /home/u/x.stl: only files in your pages can be read, by a path that stays in the page's folder", "line 1 of parts/box: /home/u/x.scad: only lattice pages can be included, by a relative path"]);
        // what stays inside the pages is handed on as it was written, to the byte
        for src in [
            "include <lib.scad>\nuse <../shared/util>\nimport(\"part.stl\");\nsurface(file = \"sub/height.dat\");\ntext(\"/a/b ../c\");\necho(\"use <b> and <i>\");\n",
            "x = \"import(\\\"/etc/x\\\")\"; s = \"../up\"; linear_extrude(height = 2) text(\"1/2\");\n",
            "é = \"é\"; module import_all() { cube(1); } import_all();\n",
        ] {
            let (_, files, notes) = run(src);
            assert_eq!((files[0].1.as_str(), notes.len()), (src, 0));
        }
        // an include in a comment that would be refused is blanked there too, and so is the opening of one
        // that does not end on its line. The code after it is left, and a file named in a comment is no file
        let comment = "// use </etc/x> and use <no end, and we use <= here, and import(\"/etc/y\")\nif (a > b) cube(1);\n";
        let (_, files, notes) = run(comment);
        assert_eq!((files[0].1.as_str(), notes.len()), (comment.replace("use </etc/x>", &" ".repeat(12)).replace("use <", "     ").as_str(), 0));
        // an included page is tamed as the page is
        let (_, files, _) = collect("a", "include <b>", |_| Some("include </home/u/x.scad>\ncube(1);".to_owned()));
        assert_eq!(files[1].1, format!("{}\ncube(1);", " ".repeat(24)));
        for bad in ["", "import(", "import(\"", "import(\"\\", ")", "import(é\"é", "1.", ".5e", "include <", "use <\n>", "$", "import((((", "\"\\"] {
            let _ = tame("", bad);
        }
    }
}
