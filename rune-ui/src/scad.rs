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

/// Where an `include <...>` or `use <...>` that starts at `i` ends, and where its path lies.
fn include_at(src: &str, i: usize) -> Option<(&'static str, usize, usize)> {
    let kind = ["include", "use"].into_iter().find(|k| src[i..].starts_with(k))?;
    let rest = &src[i + kind.len()..];
    let open = i + kind.len() + (rest.len() - rest.trim_start().len());
    if !src[open..].starts_with('<') {
        return None;
    }
    let len = src[open + 1..].find(['>', '\n']).filter(|e| src.as_bytes()[open + 1 + e] == b'>')?;
    Some((kind, open + 1, open + 1 + len))
}

/// The source with its comments and strings blanked, lengths kept. An include's path is left whole, as OpenSCAD's lexer reads it, so a `//` inside one is part of the path.
fn bare(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let blank = |out: &mut String, s: &str| out.extend(s.chars().map(|c| if c == '\n' { "\n".to_owned() } else { " ".repeat(c.len_utf8()) }));
    let mut i = 0;
    while i < b.len() {
        let word_before = i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
        if let Some((_, _, end)) = include_at(src, i).filter(|_| !word_before) {
            out.push_str(&src[i..=end]);
            i = end + 1;
            continue;
        }
        let end = match (b[i], b.get(i + 1)) {
            (b'/', Some(b'*')) => src[i + 2..].find("*/").map(|e| i + 2 + e + 2),
            (b'/', Some(b'/')) => Some(src[i..].find('\n').map_or(b.len(), |e| i + e)),
            (b'"', _) => {
                // a string closes on its own line, or it is not one
                let mut j = i + 1;
                loop {
                    match b.get(j) {
                        Some(b'"') => break Some(j + 1),
                        Some(b'\\') if b.get(j + 1).is_some_and(|c| *c != b'\n') => j += 1 + src[j + 1..].chars().next().map_or(1, char::len_utf8),
                        Some(b'\n' | b'\\') | None => break None,
                        Some(_) => j += 1,
                    }
                }
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

/// Every include and use in a source.
pub fn scan_includes(src: &str) -> Vec<Include> {
    let b = bare(src);
    let bytes = b.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if !b.is_char_boundary(i) {
            i += 1;
            continue;
        }
        // at the start, or after a semicolon, a space or a closing brace
        let led = i == 0 || matches!(bytes[i - 1], b';' | b'}') || b[..i].chars().next_back().is_some_and(char::is_whitespace);
        match include_at(&b, i).filter(|_| led) {
            Some((kind, from, to)) => {
                out.push(Include { kind, path: src[from..to].to_owned(), line: b[..i].matches('\n').count() + 1 });
                i = to + 1;
            }
            None => i += 1,
        }
    }
    out
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
/// with its text, and notes on what was refused or capped. `read`
/// answers a page's text, or nothing when there is no such page: that
/// one is left out, and OpenSCAD says which include it could not open.
pub fn collect(name: &str, text: &str, mut read: impl FnMut(&str) -> Option<String>) -> (String, Vec<(String, String)>, Vec<String>) {
    let (max_depth, max_files, max_bytes) = CAPS;
    let main = format!("{ROOT}{name}.scad");
    let mut files: Vec<(String, String)> = vec![(main.clone(), text.to_owned())];
    let mut notes = Vec::new();
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
            files.push((file, body.clone()));
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
            let scanned: Vec<String> = scan_includes(pages[name].as_str().unwrap()).iter().map(|i| format!("{} {} {}", i.kind, i.line, i.path)).collect();
            let want: Vec<&str> = case["scan"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
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
}
