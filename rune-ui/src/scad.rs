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

#[cfg(test)]
mod tests {
    use super::*;

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
