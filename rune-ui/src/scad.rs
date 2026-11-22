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
/// lexer takes the longest word it can, so `xinclude`, `_use` and
/// `q1use` are names. After figures alone it cannot be told here, since
/// `1.5include` is a number and then the keyword, so that is not called
/// a name: see `after_figures`.
fn joined(b: &[u8], i: usize) -> bool {
    let name = |c: u8| c.is_ascii_alphabetic() || matches!(c, b'_' | b'$');
    if i == 0 || !(name(b[i - 1]) || b[i - 1].is_ascii_digit()) {
        return false;
    }
    // back over the figures, and no further than a name is ever long: what stands before them says which it is
    let figures = b[..i].iter().rev().take(JOIN_MOST).take_while(|c| c.is_ascii_digit()).count();
    if figures == JOIN_MOST || figures == i {
        return false;
    }
    let at = i - figures;
    // an exponent's letter belongs to a number: `1.5e3`
    if figures > 0 && matches!(b[at - 1], b'e' | b'E') && at >= 2 && (b[at - 2].is_ascii_digit() || b[at - 2] == b'.') {
        return false;
    }
    name(b[at - 1])
}

/// The most figures looked back over to find the name they end.
const JOIN_MOST: usize = 64;

/// Whether what stands at `i` comes straight after a figure. An include
/// there may be the keyword or part of a name, so it is checked as the
/// keyword and what follows it is read as code all the same.
fn after_figures(b: &[u8], i: usize) -> bool {
    i > 0 && b[i - 1].is_ascii_digit()
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
/// page pulls in other lattice pages and nothing else.
///
/// Every `include` and `use` that does not stand (`stands`) is taken
/// out: one `resolve_ref` refuses, one whose page is not among the
/// files written for the run (`has` says which are), and one OpenSCAD
/// would not find there by the path as written. OpenSCAD looks for an
/// include it does not find beside the file among its own libraries,
/// by the path as written, and a `..` in it climbs from there to any
/// file of this machine. So nothing is left for the libraries to find.
/// Its keyword becomes a `;`, an empty statement, and the rest of it
/// spaces. Spaces alone would not do: a bare `use` before it would then
/// reach over them to a `<` after, and be a use of whatever stands
/// there. One whose path does not end on its line, or has a tab or a
/// `<` in it, has only its opening taken out, since OpenSCAD reads such
/// a path in pieces and opens the last. Lines keep their numbers.
///
/// An include is looked for everywhere, in comments and strings too,
/// in case this code and OpenSCAD disagree on where one ends. Inside a
/// comment or a string nothing past its own end is touched.
///
/// A string that names the file to `import`, `surface` and their kin
/// (`READS`) is emptied when it could lead out of the page's folder
/// (`leaves`): an argument with no name, wherever it stands, since
/// OpenSCAD gives it to the first argument not named, or the one named
/// `file` or, as it once was, `filename`. An argument of any other
/// name is left as it is. `dir` is the folder of the page the
/// source is. Each note is the line of a string that was emptied, and
/// what to say of it.
///
/// What comes back is tame already: taming it again changes nothing.
///
/// THIS DOES NOT CATCH a file's name that is put together as the
/// program runs: `import(str(chr(47), "etc/x.stl"))`, or a name passed
/// through a variable or a module's argument. No reading of the source
/// can. Only a sandbox round the `openscad` program closes that.
// ponytail: a name built at run time is not caught. Running openscad in a sandbox of its own is the whole answer
pub fn tame_among(dir: &str, src: &str, has: &dyn Fn(&str) -> bool) -> (String, Vec<(usize, String)>) {
    // taking one thing out can leave another standing that was read as part of it, so it is done until nothing changes
    let (mut text, mut notes) = tame_once(dir, src, has);
    for _ in 0..TAME_MOST {
        let (next, more) = tame_once(dir, &text, has);
        if next == text {
            return (text, notes);
        }
        notes.extend(more.into_iter().filter(|n| !notes.contains(n)).collect::<Vec<_>>());
        text = next;
    }
    // it did not settle: nothing of it is run
    notes.push((1, "this model could not be checked, so it was not built".to_string()));
    (text.bytes().map(|c| if matches!(c, b'\n' | b'\r') { c as char } else { ' ' }).collect(), notes)
}

/// The most times a model is gone over before it is given up.
const TAME_MOST: usize = 8;

/// `tame_among` with every page taken to be there.
#[cfg(test)]
fn tame(dir: &str, src: &str) -> (String, Vec<(usize, String)>) {
    tame_among(dir, src, &|_| true)
}

/// Whether an include's path is written as OpenSCAD finds a page's file
/// by, beside the file that includes it. A `..` after a folder's name
/// needs that folder to be there, which it need not be among the pages
/// and may be among OpenSCAD's libraries. A `/` at the end names a
/// folder. Spaces at either end are part of the name to OpenSCAD and
/// are not to `resolve_ref`.
fn plain(path: &str) -> bool {
    let mut named = false;
    path == path.trim() && !path.ends_with('/') && path.split('/').all(|p| {
        named |= !matches!(p, "" | "." | "..");
        !(named && p == "..")
    })
}

/// Whether an include in a file in `dir` is let stand: it names a page,
/// that page's file is written for the run, and OpenSCAD finds it there.
fn stands(dir: &str, path: &str, has: &dyn Fn(&str) -> bool) -> bool {
    plain(path) && resolve_ref(dir, path).is_ok_and(|(_, file)| has(&file))
}

/// What is said of an include whose page is not there, and of one not written plainly.
const NO_PAGE: &str = "no such page among yours, so nothing is included";
const NOT_PLAIN: &str = "write the path plainly, with any `..` first and no space or `/` at its end, or OpenSCAD would look for it outside your pages. It is not included";

fn tame_once(dir: &str, src: &str, has: &dyn Fn(&str) -> bool) -> (String, Vec<(usize, String)>) {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let mut notes = Vec::new();
    // an empty statement, then spaces: line ends are kept
    let stop = |out: &mut Vec<u8>, from: usize, to: usize| {
        for (n, c) in out[from..to].iter_mut().enumerate() {
            match *c {
                _ if n == 0 => *c = b';',
                b'\n' | b'\r' => {}
                _ => *c = b' ',
            }
        }
    };
    // whether an include or a use opens at `p`, as OpenSCAD's lexer or any reading of the text could take it
    let opens = |p: usize| if matches!(b[p], b'i' | b'u') && !joined(b, p) { opener(src, p).map(|o| o.1) } else { None };
    let mut ends = Seek::default();
    // The include that opens at `p` with its path from `from`, in a stretch that ends at `bound`: taken
    // out when it is refused, and where the reading goes on. It goes on past the path of one let stand.
    // Whether the stretch being read is a string. OpenSCAD reads no include in one, and a string is words the
    // model shows, so a plain path there is let be though no page answers it. One that climbs is not
    let quoted = std::cell::Cell::new(false);
    let mut include = |out: &mut Vec<u8>, p: usize, from: usize, bound: usize| -> usize {
        let end = ends.at(src, from, |t| t.find(['>', '\n', '\r', '\t', '<'])).filter(|e| b[*e] == b'>');
        let has = |file: &str| has(file) || (quoted.get() && end.is_some_and(|e| !src[from..e].split('/').any(|p| p == "..")));
        match end {
            // one that may be a name after all is not read past: a reader of files may stand in what looked like its path
            Some(e) if stands(dir, &src[from..e], &has) => if after_figures(b, p) { from } else { e + 1 },
            // and one that may be a name, with what would be a page's path were it there: only its opening is
            // taken out, and what follows is read as the code it may be
            Some(e) if after_figures(b, p) && resolve_ref(dir, &src[from..e]).is_ok() => {
                stop(out, p, from.min(bound));
                from
            }
            Some(e) if e < bound => {
                stop(out, p, e + 1);
                e + 1
            }
            _ => {
                stop(out, p, from.min(bound));
                from
            }
        }
    };
    // every include inside a comment or a string, none of it touched past `to`
    let inside = |out: &mut Vec<u8>, include: &mut dyn FnMut(&mut Vec<u8>, usize, usize, usize) -> usize, from: usize, to: usize| {
        let mut p = from;
        while p < to {
            p = match opens(p) {
                Some(path) => include(out, p, path, to).max(p + 1),
                None => p + 1,
            };
        }
    };
    let word = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'$');
    // the brackets open: whether a reader of files opened each, and whether the argument being read in it is the file's name
    let mut open: Vec<(bool, bool)> = Vec::new();
    // how many of them are at the file's name, whether the last word was a reader's name, and the line
    let (mut paths, mut named, mut line) = (0usize, false, 1usize);
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\n' => (i, line) = (i + 1, line + 1),
            c if c.is_ascii_whitespace() => i += 1,
            b'/' if b.get(i + 1) == Some(&b'/') => {
                let end = src[i..].find('\n').map_or(b.len(), |e| i + e);
                inside(&mut out, &mut include, i + 2, end);
                i = end;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let close = src[i + 2..].find("*/").map_or(b.len(), |e| i + 2 + e);
                inside(&mut out, &mut include, i + 2, close);
                let end = (close + 2).min(b.len());
                line += src[i..end].matches('\n').count();
                i = end;
            }
            b'"' => {
                // to the next quote no backslash stands before, over line ends, as OpenSCAD reads one
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' {
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
                let j = j.min(b.len());
                quoted.set(true);
                inside(&mut out, &mut include, i + 1, j);
                quoted.set(false);
                if paths > 0 && leaves(&src[i + 1..j]) {
                    notes.push((line, format!("{}: only files in your pages can be read, by a path that stays in the page's folder", src[i + 1..j].trim().chars().take(80).collect::<String>())));
                    out[i + 1..j].iter_mut().filter(|c| !matches!(**c, b'\n' | b'\r')).for_each(|c| *c = b' ');
                }
                line += src[i..j].matches('\n').count();
                (i, named) = ((j + 1).min(b.len()), false);
            }
            _ if opens(i).is_some() => {
                let end = include(&mut out, i, opens(i).unwrap_or(i + 1), b.len());
                line += src[i..end].matches('\n').count();
                (i, named) = (end, false);
            }
            c if word(c) || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_digit)) => {
                // a word runs as far as its letters and figures do, or to an include that opens after a figure
                let mut end = i + usize::from(c != b'.');
                while end < b.len() && word(b[end]) && opens(end).is_none() {
                    end += 1;
                }
                let figures = i + b[i..end].iter().take_while(|c| c.is_ascii_digit()).count();
                if figures == end && b.get(end) == Some(&b'.') {
                    // a number with a point: what follows its figures is a word of its own
                    let mut j = end + 1 + b[end + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
                    let sign = usize::from(matches!(b.get(j), Some(b'e' | b'E'))) + usize::from(matches!(b.get(j), Some(b'e' | b'E')) && matches!(b.get(j + 1), Some(b'+' | b'-')));
                    let power = b.get(j + sign..).map_or(0, |r| r.iter().take_while(|c| c.is_ascii_digit()).count());
                    if sign > 0 && power > 0 {
                        j += sign + power;
                    }
                    (i, named) = (j, false);
                } else {
                    let name = &src[i..end];
                    // a name with `=` after it, right in a reader's brackets, says which argument this is
                    let after = end + b[end..].iter().take_while(|c| c.is_ascii_whitespace()).count();
                    let names = b.get(after) == Some(&b'=') && b.get(after + 1) != Some(&b'=');
                    if let Some(top) = open.last_mut().filter(|top| top.0 && names) {
                        let file = matches!(name, "file" | "filename");
                        paths = paths + usize::from(file) - usize::from(top.1);
                        top.1 = file;
                    }
                    named = READS.contains(&name);
                    i = end.max(i + 1);
                }
            }
            b'(' | b'[' => {
                let reader = named && b[i] == b'(';
                open.push((reader, reader));
                paths += usize::from(reader);
                (i, named) = (i + 1, false);
            }
            b')' | b']' => {
                paths -= usize::from(open.pop().is_some_and(|top| top.0 && top.1));
                (i, named) = (i + 1, false);
            }
            b',' => {
                // the next argument may be the file's name until a name of its own says it is not: one with no name is the file's when the arguments before it were all named
                if let Some(top) = open.last_mut().filter(|top| top.0 && !top.1) {
                    top.1 = true;
                    paths += 1;
                }
                (i, named) = (i + 1, false);
            }
            _ => (i, named) = (i + 1, false),
        }
    }
    // only whole characters were made spaces, so this is still text
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
/// with its text made safe to run (`tame_among`), and notes on what was
/// refused or capped. `read`
/// answers a page's text, or nothing when there is no such page: that
/// one is left out, and its include is taken out of the text and noted,
/// so that OpenSCAD does not go looking for it among its own libraries.
pub fn collect(name: &str, text: &str, mut read: impl FnMut(&str) -> Option<String>) -> (String, Vec<(String, String)>, Vec<String>) {
    let (max_depth, max_files, max_bytes) = CAPS;
    let main = format!("{ROOT}{name}.scad");
    // every file as it was read, with the page it is. Each is tamed once all are known: an include stands only when its file is one of these
    let mut found: Vec<(String, String, String)> = vec![(main.clone(), name.to_owned(), text.to_owned())];
    // what is to be said, in order: a note, or the notes of taming the file at a place in `found`
    let mut said: Vec<Result<String, usize>> = vec![Err(0)];
    let mut bytes = text.len();
    let mut queue: std::collections::VecDeque<(String, String, usize)> = [(name.to_owned(), text.to_owned(), 0)].into();
    let mut asked: std::collections::HashMap<String, Option<String>> = Default::default();
    'all: while let Some((page, t, depth)) = queue.pop_front() {
        let dir = page.rsplit_once('/').map_or("", |(d, _)| d);
        for inc in scan_includes(&t) {
            let (p, file) = match resolve_ref(dir, &inc.path) {
                Ok(r) => r,
                Err(why) => {
                    said.push(Ok(format!("line {} of {page}: {why}", inc.line)));
                    continue;
                }
            };
            if !plain(&inc.path) {
                said.push(Ok(format!("line {} of {page}: {}: {NOT_PLAIN}", inc.line, inc.path.trim())));
            }
            if found.iter().any(|(f, ..)| *f == file) {
                continue;
            }
            if depth + 1 > max_depth {
                said.push(Ok(format!("{p}: includes nest deeper than {max_depth}, not read")));
                continue;
            }
            if found.len() >= max_files {
                said.push(Ok(format!("more than {max_files} included files, the rest not read")));
                break 'all;
            }
            let Some(body) = asked.entry(p.clone()).or_insert_with(|| read(&p)).clone() else {
                if plain(&inc.path) {
                    said.push(Ok(format!("line {} of {page}: {}: {NO_PAGE}", inc.line, inc.path)));
                }
                continue;
            };
            if bytes + body.len() > max_bytes {
                said.push(Ok(format!("{p}: the included files pass {} MB, not read", max_bytes >> 20)));
                continue;
            }
            bytes += body.len();
            said.push(Err(found.len()));
            found.push((file, p.clone(), body.clone()));
            queue.push_back((p, body, depth + 1));
        }
    }
    // every file is handed on tamed: what it may not open, and what is not among these files, is taken out of it
    let written: std::collections::HashSet<&str> = found.iter().map(|(f, ..)| f.as_str()).collect();
    let mut tamed: Vec<Option<(String, Vec<(usize, String)>)>> = found.iter().map(|(_, page, text)| Some(tame_among(page.rsplit_once('/').map_or("", |(d, _)| d), text, &|f| written.contains(f)))).collect();
    let mut notes = Vec::new();
    for n in said {
        match n {
            Ok(note) => notes.push(note),
            Err(at) => notes.extend(tamed[at].as_ref().map_or(&[][..], |t| &t.1[..]).iter().map(|(line, why)| format!("line {line} of {}: {why}", found[at].1))),
        }
    }
    let files = found.iter().zip(&mut tamed).map(|((file, ..), t)| (file.clone(), t.take().map_or(String::new(), |t| t.0))).collect();
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
            // the web client runs OpenSCAD with no libraries and no disk, and leaves an include of no page for it to
            // say. Here such an include is taken out and said, and so is one OpenSCAD would not find as written
            let notes: Vec<String> = notes.into_iter().filter(|n| !n.ends_with(NO_PAGE) && !n.ends_with(NOT_PLAIN)).collect();
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
        let run = |src: &str| collect("parts/box", src, |p| (p == "parts/lib" || p == "shared/util").then(|| "cube(1);".to_owned()));
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
            "import(\"~/home/u/x.stl\", \"a.stl\");",
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
        assert_eq!((files[0].1.as_str(), notes.len()), (comment.replace("use </etc/x>", &format!(";{}", " ".repeat(11))).replace("use <", ";    ").as_str(), 0));
        // an included page is tamed as the page is
        let (_, files, _) = collect("a", "include <b>", |_| Some("include </home/u/x.scad>\ncube(1);".to_owned()));
        assert_eq!(files[1].1, format!(";{}\ncube(1);", " ".repeat(23)));
        for bad in ["", "import(", "import(\"", "import(\"\\", ")", "import(é\"é", "1.", ".5e", "include <", "use <\n>", "$", "import((((", "\"\\"] {
            let _ = tame("", bad);
        }
    }

    #[test]
    fn a_files_name_is_checked_wherever_it_stands_among_the_arguments() {
        let tamed = |src: &str| tame("parts", src);
        // OpenSCAD gives a string with no name to the first argument not named, wherever it stands
        for src in [
            "import(convexity=2, \"/etc/passwd.stl\");",
            "surface(center=true, \"/etc/x.png\");",
            "x = import(center = true, \"../../secret.json\");",
            "import(convexity = 2, center = true, \"/etc/passwd.stl\");",
            "import(layer = \"a\", \"/etc/passwd.stl\", convexity = 2);",
            "import(convexity = [1, 2], \"/etc/passwd.stl\");",
            "import(convexity = f(1, 2), \"C:/secret.stl\");",
            "import(convexity=2,\n\t\"~/secret.stl\");",
            "import(convexity=2, /* file */ \"/etc/passwd.stl\");",
            "import(convexity=2, str(\"/etc\", \"/passwd.stl\"));",
            "import(\"a.stl\", \"/etc/passwd.stl\");",
            "import(convexity=2, id = \"x\", \"a.stl\", \"/etc/passwd.stl\");",
            "linear_extrude(height = 2, \"/etc/x.dxf\") square(1);",
            "x = dxf_cross(layer = \"l\", \"/etc/x.dxf\");",
            // the old name of the argument names the file too
            "import(filename = \"/etc/passwd.stl\");",
            "import(convexity = 2, filename=\"../../secret.stl\");",
            "import(file = \"a.stl\", filename = \"/etc/passwd.stl\");",
        ] {
            let (safe, notes) = tamed(src);
            assert!(!safe.contains("etc") && !safe.contains("secret") && !notes.is_empty(), "{src:?} is handed on as {safe:?}");
            assert_eq!((safe.len(), safe.matches('\n').count()), (src.len(), src.matches('\n').count()), "{src:?}");
            assert_eq!(tamed(&safe).0, safe, "what is tamed is tame");
        }
        // a named argument that is not the file's name is still left as it is, before a string with no name and after one
        for kept in ["import(convexity = 2, \"a.stl\", id = \"/top\");", "import(id = \"../b\", \"sub/a.stl\");", "import(layer = \"/x\", convexity = 2, file = \"a.stl\");", "import(convexity=2, \"a.stl\"); echo(\"/b\", \"/c\");"] {
            assert_eq!(tamed(kept), (kept.to_owned(), Vec::new()), "{kept}");
        }
    }

    #[test]
    fn an_include_is_let_stand_only_when_openscad_finds_it_among_the_pages() {
        // OpenSCAD looks for a path it does not find beside the file among its own libraries, with the path as
        // written: `..` there climbs out of the library's folder to any file of this machine
        let pages = |p: &str| ["a/b/c/d/lib", "a/b/x", "a/top", "etc/passwd", "MCAD/shapes", "a/b/c/d/sub/y"].contains(&p).then(|| "cube(1);".to_owned());
        let run = |src: &str| collect("a/b/c/d/page", src, pages);
        let gone = |src: &str| {
            let (_, files, notes) = run(src);
            let safe = &files[0].1;
            assert!(!safe.contains("include") && !safe.contains("use") && !safe.contains('<'), "{src:?} is handed on as {safe:?}");
            assert_eq!((safe.len(), safe.matches('\n').count()), (src.len(), src.matches('\n').count()), "{src:?}");
            assert_eq!(notes.len(), 1, "{src:?}: {notes:?}");
            notes[0].clone()
        };
        // no such page: nothing is left for the libraries to answer
        for src in ["include <../../../../home/u/x.scad>", "use <../../../../etc/shadow>", "include <MCAD/gears.scad>", "use <missing.scad>", "include <../missing>", "x = 1;include <../../../../etc/shadow>"] {
            assert!(gone(src).contains("no such page"), "{src}");
        }
        // a page that is there, by a path OpenSCAD would not find it by beside the file: a `..` after a folder's
        // name needs that folder to be there, a `/` at the end names a folder, and spaces are part of a name
        for src in ["include <sub/../../../../../etc/shadow>", "include <MCAD/../../../../../etc/passwd>", "use <nowhere/../lib>", "include <./nowhere/../lib.scad>", "use <sub/../lib>", "include <../d/../d/lib>", "include <lib/>", "include <lib.scad//>", "use < lib>", "include <lib >", "use <../../x/./..//x>"] {
            assert!(gone(src).contains("plainly"), "{src}");
        }
        // what is refused outright is still refused, and said as it was
        assert!(gone("include </etc/passwd>").contains("only lattice pages"));
        assert!(gone("include <../../../../../etc/passwd>").contains("above the top"));
        // a page that is there, by a plain path, stands as it was written
        for src in ["include <lib>", "include <lib.scad>", "use <./lib.scad>", "use <../../x>", "include <../../../top.scad>", "use <../../../../etc/passwd>", "include <../../../../MCAD/shapes.scad>", "use <sub/y>", "use <sub//y>", "include <./../../x>", "use <page.scad>"] {
            let (_, files, notes) = run(src);
            assert_eq!((files[0].1.as_str(), notes.len()), (src, 0), "{src}: {notes:?}");
            assert_eq!(files.len(), if src.contains("page.scad") { 1 } else { 2 }, "{src}");
        }
        // a page left out because the run is full is not left to the libraries either
        let chain = |p: &str| p.strip_prefix('d').and_then(|n| n.parse::<usize>().ok()).map(|n| format!("include <d{}>", n + 1));
        let (_, files, _) = collect("d0", "include <d1>", chain);
        assert_eq!(files.len(), CAPS.0 + 1);
        assert!(!files.last().unwrap().1.contains("include"), "the deepest file read still includes one that was not: {:?}", files.last());
        assert!(files[..files.len() - 1].iter().all(|(_, text)| text.contains("include")));
        // in a string, which is words the model shows, a plain path is let be and one that climbs is not
        let (_, files, _) = run("echo(\"use <b> or include <sub/c.scad>\"); t = \"use <../../../../etc/shadow>\"; u = \"use <MCAD/../x>\";");
        assert_eq!(files[0].1, format!("echo(\"use <b> or include <sub/c.scad>\"); t = \";{}\"; u = \";{}\";", " ".repeat(27), " ".repeat(14)));
        // an include that only a looser reading finds is not gathered, and so is taken out
        let (_, files, _) = collect("p", "// use <q>\ncube(1);", |p| (p == "q").then(|| "cube(2);".to_owned()));
        assert_eq!(files, [("/w/p.scad".to_owned(), "// ;      \ncube(1);".to_owned())]);
    }

    /// The includes and uses OpenSCAD's own lexer acts on in a source, each with the path it would open: a
    /// model of its rules (`lexer.l`: the opener against a number or a name by the longest match, the path
    /// read to its `>` with tabs and line ends passed over, strings and comments).
    fn lexed(src: &str) -> Vec<String> {
        let b = src.as_bytes();
        let digits = |from: usize| b[from.min(b.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
        let power = |j: usize| {
            let sign = usize::from(matches!(b.get(j + 1), Some(b'+' | b'-')));
            if matches!(b.get(j), Some(b'e' | b'E')) && digits(j + 1 + sign) > 0 { 1 + sign + digits(j + 1 + sign) } else { 0 }
        };
        let number = |i: usize| {
            let whole = digits(i);
            let mut best = if whole > 0 { whole + power(i + whole) } else { 0 };
            if b.get(i + whole) == Some(&b'.') {
                let part = digits(i + whole + 1);
                if part > 0 || whole > 0 {
                    best = best.max(whole + 1 + part + power(i + whole + 1 + part));
                }
            }
            best
        };
        let (mut out, mut i) = (Vec::new(), 0);
        while i < b.len() {
            let opener = ["include", "use"].into_iter().find_map(|kw| {
                let after = i + kw.len() + b.get(i + kw.len()..)?.iter().take_while(|c| matches!(c, b' ' | b'\t' | b'\r' | b'\n')).count();
                (src[i..].starts_with(kw) && b.get(after) == Some(&b'<')).then_some(after + 1)
            });
            let from = i + usize::from(b[i] == b'$');
            let name = b[from..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'_').count();
            let other = if name > 0 { from + name - i } else { 0 }.max(number(i));
            if let Some(after) = opener.filter(|after| *after - i >= other) {
                // the last piece of the path, between tabs and line ends, is the one opened
                let (mut j, mut path, mut closed) = (after, String::new(), false);
                while j < b.len() && !closed {
                    match b[j] {
                        b'>' => closed = true,
                        b'\t' | b'\r' | b'\n' => {}
                        _ => {
                            let end = j + b[j..].iter().position(|c| matches!(c, b'\t' | b'\r' | b'\n' | b'>')).unwrap_or(b.len() - j);
                            path = src[j..end].to_owned();
                            j = end - 1;
                        }
                    }
                    j += 1;
                }
                if closed {
                    out.push(path);
                }
                i = j;
            } else if other > 0 {
                i += other;
            } else {
                i = match b[i] {
                    b'"' => {
                        let mut j = i + 1;
                        while j < b.len() && b[j] != b'"' {
                            j += if b[j] == b'\\' && matches!(b.get(j + 1), Some(b'\\' | b'"')) { 2 } else { 1 };
                        }
                        (j + 1).min(b.len())
                    }
                    b'/' if b.get(i + 1) == Some(&b'/') => src[i..].find('\n').map_or(b.len(), |e| i + e + 1),
                    b'/' if b.get(i + 1) == Some(&b'*') => src[i + 2..].find("*/").map_or(b.len(), |e| i + e + 4),
                    _ => i + src[i..].chars().next().map_or(1, char::len_utf8),
                };
            }
        }
        out
    }

    #[test]
    fn every_include_openscad_would_act_on_is_a_page_written_for_the_run() {
        assert_eq!(lexed("include <a.scad>\nuse<b/c> x = \"use <d>\"; // use <e>\n/* include <f> */ 1.5use <g> q1use <h> use <i\n\tj>"), ["a.scad", "b/c", "g", "j"]);
        let pieces = [
            "use", "include", "use ", "include ", "use<", "include<", "use <", "include <", "<", ">", "\"", "/", "//", "/*", "*/", "\\", "\\\"", "\\\\", "\n", "\r", "\t", " ", ";", "=", "(", ")", ",", "{", "}", ".", "1", "9", "e", "+", "a", "_", "$", "q1", "1e3", "1.5", "1.", ".5", "1.5e+3",
            "/etc/passwd", "../../../etc/passwd", "../x.scad", "../a.scad", "lib/a.scad", "a.scad", "a.scad", "C:/x", "file:///x", "~/x", "a/../../b", "lib/../a.scad", "..", "./", "a b", " a.scad", "a.scad ", "a.scad/", "MCAD/a.scad", "é", "import(", "file=", "u", "i", "se", "clude", "é<",
            "include <a.scad>", "use <../a.scad>", "use <lib/a.scad>", "include <./a.scad>", "include <../../../etc/passwd>", "use <MCAD/a.scad>", "include <lib/../a.scad>", "use < a.scad>", "include <a.scad/>", "use </etc/passwd>", "include <b.scad>", "use <../../../../../a.scad>",
        ];
        // the pages written for the run: every `a.scad`, in any folder but MCAD
        let has = |file: &str| file.ends_with("/a.scad") && !file.contains("MCAD");
        let mut seed = 11u64;
        let mut below = |n: usize| {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            (seed >> 33) as usize % n
        };
        let (mut acted, mut stood) = (0, 0);
        for round in 0..120_000 {
            let src: String = (0..1 + below(14)).map(|_| pieces[below(pieces.len())]).collect();
            let dir = ["", "a", "a/b", "a/b/c/d/e"][below(4)];
            let (safe, _) = tame_among(dir, &src, &has);
            assert_eq!((safe.len(), safe.matches('\n').count()), (src.len(), src.matches('\n').count()), "{round} {src:?}");
            assert_eq!(tame_among(dir, &safe, &has).0, safe, "{round}: {src:?} in {dir:?} tamed twice");
            acted += lexed(&src).len();
            for path in lexed(&safe) {
                stood += 1;
                assert!(stands(dir, &path, &has), "{round}: {src:?} in {dir:?} is handed on as {safe:?}, and OpenSCAD would open {path:?}");
            }
        }
        assert!(acted > 20_000 && stood > 5_000, "{acted} includes to act on and {stood} let stand: the check checks little");
    }

    #[test]
    fn a_name_that_ends_in_a_figure_is_a_name_and_hides_no_file() {
        // `q1use <` is a name and a comparison: the file read on the same line is still refused
        for src in ["q1use = 1;\nt = q1use < 2; import(\"/etc/passwd.stl\"); u = 3 > 2;", "d = v1use<echo(import(\"/home/u/secret.json\"))>0;", "t = 2use < 2; import(\"/etc/passwd.stl\"); u = 3 > 2;", "t = 1.5e3use <a> + import(\"/etc/passwd.stl\"); u = 3 > 2;"] {
            let (safe, notes) = tame("", src);
            assert!(!safe.contains("etc") && !safe.contains("secret") && !notes.is_empty(), "{src:?} is handed on as {safe:?}");
        }
        // and a name is not cut in two
        for src in ["ok = p2use < 5 ? 1 : 2;", "if (n1include < 3) cube(1);", "a_1use < b; c > d;", "x9_include <y> z;"] {
            assert_eq!(tame("", src), (src.to_owned(), vec![]));
        }
        // after a number it is still the keyword
        assert!(!tame("", "x=1.5include </home/u/x.scad>").0.contains("home"));
        assert!(!tame("", "x=1.5e3include </home/u/x.scad>").0.contains("home"));
        // one pass can leave what the next takes out: it is done until it settles
        let (once, _) = tame("", "import(str(\"use<\", \">/..\"));");
        assert_eq!(tame("", &once).0, once);
    }

    /// Whether a text holds an include or a use, read as loosely as any reader could, whose path would be refused.
    fn opens_outside(dir: &str, text: &str) -> bool {
        let b = text.as_bytes();
        (0..b.len()).any(|p| {
            let Some((_, from)) = (matches!(b[p], b'i' | b'u') && !joined(b, p)).then(|| opener(text, p)).flatten() else { return false };
            match text[from..].find(['>', '\n', '\r', '\t', '<']).map(|e| from + e).filter(|e| b[*e] == b'>') {
                Some(e) => resolve_ref(dir, &text[from..e]).is_err(),
                None => true,
            }
        })
    }

    #[test]
    fn what_is_tamed_is_tame_and_no_refused_include_is_left_or_made() {
        // a bare keyword before a refused include once reached over the spaces left of it to the path after
        for (src, want) in [
            ("use use </a> </outside/x.scad>", format!("use ;{} </outside/x.scad>", " ".repeat(7))),
            ("include include </a> </outside/x.scad>", format!("include ;{} </outside/x.scad>", " ".repeat(11))),
            ("use\ninclude </a>\n</outside/x.scad>", format!("use\n;{}\n</outside/x.scad>", " ".repeat(11))),
        ] {
            let (safe, _) = tame("", src);
            assert_eq!(safe, want);
            assert!(!opens_outside("", &safe));
        }
        // sequences of the pieces an include is made of, and of what could hide or split one
        let pieces = ["use", "include", "<", ">", "a.scad", "/bad", "../up", " ", " ", "\n", "\t", "// c", "/* c */", "/*", "*/", "\"", "\\", "x", "1.5", "7", ";", "(", ")", ",", "import", "file=", "é"];
        let mut seed = 3u64;
        let mut below = |n: usize| {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            (seed >> 33) as usize % n
        };
        for round in 0..60_000 {
            let src: String = (0..1 + below(12)).map(|_| pieces[below(pieces.len())]).collect();
            let (once, _) = tame("d", &src);
            assert_eq!((once.len(), once.matches('\n').count()), (src.len(), src.matches('\n').count()), "{round} {src:?}");
            assert!(!opens_outside("d", &once), "{round}: {src:?} is handed on as {once:?}");
            assert_eq!(tame("d", &once).0, once, "{round}: {src:?} tamed twice");
        }
    }

    #[test]
    fn taming_touches_nothing_past_a_strings_end_and_only_the_files_name() {
        let tamed = |src: &str| tame("parts", src);
        // an include opened in a string, with its end far off in the code after: the code is left
        assert_eq!(tamed("t = \"use </\"; if (a > b) cube(1);").0, "t = \";    /\"; if (a > b) cube(1);");
        assert_eq!(tamed("// include </x\nif (a > b) cube(1);").0, "// ;        /x\nif (a > b) cube(1);");
        assert_eq!(tamed("/* use </x */ if (a > b) cube(1);").0, "/* ;    /x */ if (a > b) cube(1);");
        assert_eq!(tamed("t = \"see use </x> here\"; cube(1);").0, format!("t = \"see ;{} here\"; cube(1);", " ".repeat(7)));
        // only the file's name is a path: the first argument, or the one named file
        for kept in [
            "import(\"drawing.svg\", id=\"layer:top\");",
            "import(\"drawing.svg\", layer = \"/top\", convexity = 3);",
            "import(file = \"a.stl\", id = \"../b\");",
            "surface(center = true, invert = \"/x\", file = \"h.dat\");",
            "x = dxf_dim(file=\"d.dxf\", name=\"/w\", layer=\"..\");",
            "import(\"a.stl\"); echo(\"/b\");",
            "import(\"a.stl\") cube([1, \"/x\" == \"/x\" ? 1 : 2, 3]);",
        ] {
            assert_eq!(tamed(kept), (kept.to_owned(), Vec::new()), "{kept}");
        }
        for (src, want) in [
            ("import(\"/a.stl\", id=\"/top\");", "import(\"      \", id=\"/top\");"),
            ("import(id=\"/top\", file=\"/a.stl\");", "import(id=\"/top\", file=\"      \");"),
            ("import(convexity = 3, file = str(\"/a\", \"b\"), id = \"/c\");", "import(convexity = 3, file = str(\"  \", \"b\"), id = \"/c\");"),
            ("surface(\"../h.dat\", center = \"/x\");", "surface(\"        \", center = \"/x\");"),
        ] {
            let (safe, notes) = tamed(src);
            assert_eq!((safe.as_str(), notes.len()), (want, 1), "{src}");
        }
    }
}
