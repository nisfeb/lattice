//! A spreadsheet page (flat ODS, as LibreOffice writes it) read into rows
//! of text for a native grid. Read-only: what each cell shows, not its
//! formula or style.

#[derive(Debug, PartialEq)]
pub struct Sheet {
    pub name: String,
    /// Rows of cells as shown. Trailing empty cells and rows are cut, so
    /// rows differ in length.
    pub rows: Vec<Vec<String>>,
}

impl Sheet {
    pub fn width(&self) -> usize {
        self.rows.iter().map(Vec::len).max().unwrap_or(0)
    }
}

/// The most rows and columns read. A sheet "filled" to its last row with
/// one repeated empty cell is common, and is not a million rows of text.
const MAX_ROWS: usize = 5000;
const MAX_COLS: usize = 256;

/// A column's letters: A to Z, then AA and on.
pub fn column_name(mut i: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (i % 26) as u8);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

fn unescape(s: &str, out: &mut String) {
    let mut rest = s;
    while let Some(a) = rest.find('&') {
        out.push_str(&rest[..a]);
        let end = rest[a..].find(';').filter(|&e| e <= 10);
        let name = end.map(|e| &rest[a + 1..a + e]);
        let ch = match name {
            Some("amp") => Some('&'),
            Some("lt") => Some('<'),
            Some("gt") => Some('>'),
            Some("quot") => Some('"'),
            Some("apos") => Some('\''),
            Some(n) => n.strip_prefix("#x").and_then(|h| u32::from_str_radix(h, 16).ok()).or_else(|| n.strip_prefix('#').and_then(|d| d.parse().ok())).and_then(char::from_u32),
            None => None,
        };
        match (ch, end) {
            (Some(c), Some(e)) => {
                out.push(c);
                rest = &rest[a + e + 1..];
            }
            _ => {
                out.push('&');
                rest = &rest[a + 1..];
            }
        }
    }
    out.push_str(rest);
}

/// An attribute's value in a tag's text, unescaped.
fn attr(tag: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = tag[from..].find(name) {
        let at = from + i;
        let after = &tag[at + name.len()..];
        // the name whole, not the tail of a longer one
        let whole = tag[..at].ends_with(char::is_whitespace) && after.starts_with("=\"");
        if whole {
            let v = &after[2..];
            let mut out = String::new();
            unescape(&v[..v.find('"')?], &mut out);
            return Some(out);
        }
        from = at + name.len();
    }
    None
}

fn repeat(tag: &str, name: &str) -> usize {
    attr(tag, name).and_then(|v| v.parse().ok()).unwrap_or(1).max(1)
}

/// The sheets of a flat ODS document. Empty when the text holds none.
pub fn parse(src: &str) -> Vec<Sheet> {
    let mut sheets: Vec<Sheet> = Vec::new();
    let mut row: Option<(Vec<String>, usize)> = None;
    let mut cell: Option<(String, usize)> = None;
    // inside a paragraph of the cell, and inside a note on it (not shown)
    let (mut para, mut note) = (false, 0usize);
    let mut i = 0;
    while let Some(lt) = src[i..].find('<') {
        let at = i + lt;
        if para && note == 0 {
            if let Some((text, _)) = &mut cell {
                unescape(&src[i..at], text);
            }
        }
        let Some(gt) = src[at..].find('>') else { break };
        let tag = &src[at + 1..at + gt];
        i = at + gt + 1;
        let closing = tag.starts_with('/');
        let empty = tag.ends_with('/');
        let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        match (name, closing) {
            ("table:table", false) => sheets.push(Sheet { name: attr(tag, "table:name").unwrap_or_default(), rows: Vec::new() }),
            ("table:table-row", false) => {
                row = Some((Vec::new(), repeat(tag, "table:number-rows-repeated")));
                if empty {
                    end_row(&mut sheets, &mut row);
                }
            }
            ("table:table-row", true) => end_row(&mut sheets, &mut row),
            ("table:table-cell" | "table:covered-table-cell", false) => {
                cell = Some((String::new(), repeat(tag, "table:number-columns-repeated")));
                if empty {
                    end_cell(&mut row, &mut cell);
                }
            }
            ("table:table-cell" | "table:covered-table-cell", true) => end_cell(&mut row, &mut cell),
            ("office:annotation", false) if !empty => note += 1,
            ("office:annotation", true) => note = note.saturating_sub(1),
            ("text:p", false) if note == 0 => {
                if let Some((text, _)) = &mut cell {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    para = !empty;
                }
            }
            ("text:p", true) => para = false,
            ("text:s", false) if para && note == 0 => {
                if let Some((text, _)) = &mut cell {
                    text.push_str(&" ".repeat(repeat(tag, "text:c").min(1000)));
                }
            }
            ("text:line-break", false) | ("text:tab", false) if para && note == 0 => {
                if let Some((text, _)) = &mut cell {
                    text.push(if name == "text:tab" { '\t' } else { '\n' });
                }
            }
            _ => {}
        }
    }
    for s in &mut sheets {
        while s.rows.last().is_some_and(Vec::is_empty) {
            s.rows.pop();
        }
    }
    sheets
}

/// What was typed into a cell, as the web client reads it.
#[derive(Debug, PartialEq)]
pub enum Typed {
    Empty,
    Text(String),
    Number(f64),
    Bool(bool),
}

/// Whether text is a plain number as the web client takes one: digits,
/// grouped by commas or not, a fraction, an exponent.
fn numeric(t: &str) -> bool {
    let t = t.strip_prefix(['+', '-']).unwrap_or(t);
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (mant, exp) = match t.find(['e', 'E']) {
        Some(i) => (&t[..i], Some(&t[i + 1..])),
        None => (t, None),
    };
    let (whole, frac) = match mant.find('.') {
        Some(i) => (&mant[..i], Some(&mant[i + 1..])),
        None => (mant, None),
    };
    let grouped = |s: &str| {
        let mut parts = s.split(',');
        parts.next().is_some_and(|p| digits(p) && p.len() <= 3) && parts.clone().count() > 0 && parts.all(|p| digits(p) && p.len() == 3)
    };
    (whole.is_empty() || digits(whole) || grouped(whole)) && frac.is_none_or(digits) && exp.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e))) && t.bytes().any(|b| b.is_ascii_digit())
}

/// What typed text becomes in a cell. A leading `'` keeps the rest as
/// text. A formula, a date, a time, a percentage and money are refused:
/// writing them needs the formula engine and the number formats, which
/// are not here yet.
pub fn typed(text: &str) -> Result<Typed, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(Typed::Empty);
    }
    if let Some(rest) = text.strip_prefix('\'') {
        return Ok(Typed::Text(rest.to_owned()));
    }
    if t.len() > 1 && t.starts_with('=') {
        return Err("formulas are not written here yet".into());
    }
    if numeric(t) {
        return t.replace(',', "").parse().map(Typed::Number).map_err(|_| "that number cannot be read".to_owned());
    }
    let parts = |sep: char, n: std::ops::RangeInclusive<usize>| {
        let p: Vec<&str> = t.split(sep).collect();
        n.contains(&p.len()) && p.iter().all(|x| !x.is_empty() && x.len() <= 4 && x.bytes().all(|b| b.is_ascii_digit()))
    };
    let special = t.strip_suffix('%').is_some_and(|n| numeric(n.trim_end())) || t.strip_prefix("-$").or(t.strip_prefix('$')).is_some_and(|n| numeric(n.trim_start())) || (parts('-', 3..=3) && t.len() >= 8) || parts(':', 2..=3);
    if special {
        return Err("dates, times, percentages and money are not written here yet. Start it with ' to keep it as text".into());
    }
    Ok(match t.to_ascii_lowercase().as_str() {
        "true" => Typed::Bool(true),
        "false" => Typed::Bool(false),
        _ => Typed::Text(text.to_owned()),
    })
}

/// A number as a cell shows it with no format of its own: fifteen
/// significant digits, as the web client and LibreOffice do.
pub fn general(n: f64) -> String {
    if !n.is_finite() {
        return "#NUM!".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let sci = format!("{n:.14e}");
    if n.abs() >= 1e16 || n.abs() < 1e-15 {
        let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
        let mant = if mant.contains('.') { mant.trim_end_matches('0').trim_end_matches('.') } else { mant };
        let (sign, digits) = exp.strip_prefix('-').map_or(("+", exp), |d| ("-", d));
        return format!("{mant}E{sign}{digits:0>3}");
    }
    format!("{}", sci.parse::<f64>().unwrap_or(n))
}

/// A number as the value attribute holds it: the shortest text that
/// reads back as the same number.
fn num_attr(n: f64) -> String {
    if !n.is_finite() {
        "0".into()
    } else if n != 0.0 && (n.abs() >= 1e21 || n.abs() < 1e-6) {
        format!("{n:E}")
    } else {
        format!("{n}")
    }
}

fn esc_text(s: &str) -> String {
    s.chars().filter(|c| matches!(*c, '\t' | '\n' | '\r') || *c >= ' ').collect::<String>().replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// A cell's text as paragraphs, as LibreOffice writes it: one to a
/// line, runs of spaces as `text:s`, tabs as `text:tab`.
fn paragraphs(t: &str) -> Vec<String> {
    if t.is_empty() {
        return Vec::new();
    }
    t.split('\n')
        .map(|line| {
            let (mut out, mut rest, mut first) = (String::new(), line, true);
            while let Some(ch) = rest.chars().next() {
                if ch == '\t' {
                    out.push_str("<text:tab/>");
                    rest = &rest[1..];
                } else if ch == ' ' {
                    let n = rest.len() - rest.trim_start_matches(' ').len();
                    // a lone space between words is a plain space. One at the start, and every space after the first, is text:s
                    let (plain, extra) = if first { (0, n) } else { (1, n - 1) };
                    out.push_str(&" ".repeat(plain));
                    match extra {
                        0 => {}
                        1 => out.push_str("<text:s/>"),
                        _ => out.push_str(&format!("<text:s text:c=\"{extra}\"/>")),
                    }
                    rest = &rest[n..];
                } else {
                    let end = rest.find([' ', '\t']).unwrap_or(rest.len());
                    out.push_str(&esc_text(&rest[..end]));
                    rest = &rest[end..];
                }
                first = false;
            }
            format!("<text:p>{out}</text:p>")
        })
        .collect()
}

use crate::odf::{El, attrs, elements};

/// The attributes of a cell that hold its value: a new value replaces them all.
const VALUE_ATTRS: [&str; 11] = [
    "table:style-name", "table:number-columns-repeated", "table:formula", "office:value-type", "office:value", "office:date-value", "office:time-value",
    "office:boolean-value", "office:string-value", "office:currency", "calcext:value-type",
];

/// Where an element's own content ends: at its closing tag, or at once for an empty one.
fn inner_end(src: &str, el: &El) -> usize {
    if src[el.start..el.open_end].ends_with("/>") { el.open_end } else { src[..el.end].rfind("</").unwrap_or(el.end) }
}

fn kids(src: &str, el: &El) -> Result<Vec<El>, String> {
    elements(src, el.open_end, inner_end(src, el))
}

/// An element's opening tag with one attribute set to a count, or
/// dropped when the count is one, and left open for content.
fn open_tag(src: &str, el: &El, count: &str, n: usize) -> String {
    let tag = &src[el.start..el.open_end];
    let mut out = format!("<{}", el.name);
    for (k, at) in attrs(tag).into_iter().filter(|(k, _)| *k != count) {
        let raw = &tag[at];
        let q = if raw.contains('"') { '\'' } else { '"' };
        out.push_str(&format!(" {k}={q}{raw}{q}"));
    }
    if n > 1 {
        out.push_str(&format!(" {count}=\"{n}\""));
    }
    out
}

/// An element again, standing for `n` of itself.
fn copy(src: &str, el: &El, count: &str, n: usize) -> String {
    let rest = &src[el.open_end..el.end];
    format!("{}{}{rest}", open_tag(src, el, count, n), if src[el.start..el.open_end].ends_with("/>") { "/>" } else { ">" })
}

fn count(src: &str, el: &El, name: &str) -> usize {
    let tag = &src[el.start..el.open_end];
    attrs(tag).into_iter().find(|(k, _)| *k == name).and_then(|(_, at)| tag[at].parse().ok()).unwrap_or(1).max(1)
}

/// The spaces an element is indented by when it starts its line, and
/// what goes between it and a sibling put beside it.
fn gap(src: &str, at: usize) -> String {
    let line = src[..at].rfind('\n').map_or(0, |i| i + 1);
    if src[line..at].bytes().all(|b| b == b' ') { format!("\n{}", &src[line..at]) } else { String::new() }
}

/// A cell holding `v`, keeping the style, the span and the notes of the cell it takes the place of.
fn cell_xml(src: &str, old: Option<&El>, pad: &str, v: &Typed, calcext: bool) -> Result<String, String> {
    let name = old.map_or("table:table-cell", |o| o.name.as_str());
    let tag = old.map_or("", |o| &src[o.start..o.open_end]);
    let had = attrs(tag);
    let raw = |k: &str| had.iter().find(|(n, _)| *n == k).map(|(_, at)| &tag[at.clone()]);
    let mut a = String::new();
    for k in ["table:style-name", "table:content-validation-name"] {
        if let Some(v) = raw(k) {
            a.push_str(&format!(" {k}=\"{v}\""));
        }
    }
    let (vt, value, text) = match v {
        Typed::Empty => ("", String::new(), String::new()),
        Typed::Text(t) => ("string", String::new(), t.clone()),
        Typed::Number(n) => ("float", format!(" office:value=\"{}\"", num_attr(*n)), general(*n)),
        Typed::Bool(b) => ("boolean", format!(" office:boolean-value=\"{b}\""), if *b { "TRUE" } else { "FALSE" }.to_owned()),
    };
    if !vt.is_empty() {
        a.push_str(&format!(" office:value-type=\"{vt}\"{value}"));
        // LibreOffice's own attribute, only where the document declares its namespace
        if calcext {
            a.push_str(&format!(" calcext:value-type=\"{vt}\""));
        }
    }
    for (k, at) in had.iter().filter(|(k, _)| !VALUE_ATTRS.contains(k) && *k != "table:content-validation-name") {
        a.push_str(&format!(" {k}=\"{}\"", &tag[at.clone()]));
    }
    // what the cell held that is not its text: a note, a picture
    let keep: String = match old {
        Some(o) => kids(src, o)?.iter().filter(|k| k.name != "text:p").map(|k| &src[k.start..k.end]).collect(),
        None => String::new(),
    };
    let ps = paragraphs(&text);
    if ps.is_empty() && keep.is_empty() {
        return Ok(format!("<{name}{a}/>"));
    }
    let inner = if pad.is_empty() { String::new() } else { format!("{pad} ") };
    let kept = if keep.is_empty() { String::new() } else { format!("{inner}{keep}") };
    Ok(format!("<{name}{a}>{kept}{}{pad}</{name}>", ps.iter().map(|p| format!("{inner}{p}")).collect::<String>()))
}

/// A flat ODS document with one cell holding what was typed, and every
/// byte that is not of that cell's row as it was. A repeated row or
/// cell is split so the one cell stands alone, and a cell past the end
/// of its row or its sheet is made, with the blanks before it.
///
/// A sheet with formulas is refused: nothing here works a formula out,
/// so the cells that depend on the one changed would be left stale.
pub fn set_cell(src: &str, sheet: usize, r: usize, c: usize, text: &str) -> Result<String, String> {
    let value = typed(text)?;
    if r >= MAX_ROWS || c >= MAX_COLS {
        return Err("that is outside the part of the sheet shown here".into());
    }
    if src.contains("table:formula=") {
        return Err("this spreadsheet has formulas, which are not worked out here yet, so it is not changed here".into());
    }
    let no = || "this is not a spreadsheet lattice can change".to_owned();
    let root = elements(src, 0, src.len())?.into_iter().find(|e| e.name == "office:document").ok_or_else(no)?;
    let calcext = src[root.start..root.open_end].contains("xmlns:calcext=");
    let mut at = root;
    for name in ["office:body", "office:spreadsheet"] {
        at = kids(src, &at)?.into_iter().find(|e| e.name == name).ok_or_else(no)?;
    }
    let table = kids(src, &at)?.into_iter().filter(|e| e.name == "table:table").nth(sheet).ok_or_else(no)?;
    // the rows, also those in a header or a group
    fn rows_of(src: &str, el: &El, out: &mut Vec<El>) -> Result<(), String> {
        for k in kids(src, el)? {
            match k.name.as_str() {
                "table:table-row" => out.push(k),
                "table:table-header-rows" | "table:table-row-group" | "table:table-rows" => rows_of(src, &k, out)?,
                _ => {}
            }
        }
        Ok(())
    }
    let mut rows = Vec::new();
    rows_of(src, &table, &mut rows)?;
    const ROWS: &str = "table:number-rows-repeated";
    const COLS: &str = "table:number-columns-repeated";
    // the row with the cell in it, standing alone
    let one_row = |row: Option<&El>, pad: &str| -> Result<String, String> {
        let cells: Vec<El> = match row {
            Some(row) => kids(src, row)?.into_iter().filter(|k| k.name == "table:table-cell" || k.name == "table:covered-table-cell").collect(),
            None => Vec::new(),
        };
        let inner_pad = if pad.is_empty() { String::new() } else { format!("{pad} ") };
        let mut seen = 0;
        let mut found = None;
        for cell in &cells {
            let n = count(src, cell, COLS);
            if c < seen + n {
                found = Some((cell, c - seen, n - (c - seen) - 1));
                break;
            }
            seen += n;
        }
        let (from, to, new) = match found {
            Some((cell, before, after)) => {
                if cell.name == "table:covered-table-cell" {
                    return Err("that cell is part of a merged cell".into());
                }
                let tag = &src[cell.start..cell.open_end];
                let held = attrs(tag).into_iter().find(|(k, _)| *k == "office:value-type").map(|(_, at)| &tag[at]);
                if held.is_some_and(|t| !matches!(t, "string" | "float" | "boolean")) {
                    return Err("that cell holds a date, a time, a percentage or money, which are not written here yet".into());
                }
                let sep = gap(src, cell.start);
                let mut parts = Vec::new();
                if before > 0 {
                    parts.push(copy(src, cell, COLS, before));
                }
                parts.push(cell_xml(src, Some(cell), &sep, &value, calcext)?);
                if after > 0 {
                    parts.push(copy(src, cell, COLS, after));
                }
                (cell.start, cell.end, parts.join(&sep))
            }
            None => {
                // past the row's last cell: the blanks between, then the cell
                let sep = cells.last().map_or(inner_pad.clone(), |l| gap(src, l.start));
                let mut new = String::new();
                if c > seen {
                    new.push_str(&format!("{sep}<table:table-cell{}/>", if c - seen > 1 { format!(" {COLS}=\"{}\"", c - seen) } else { String::new() }));
                }
                new.push_str(&format!("{sep}{}", cell_xml(src, None, &sep, &value, calcext)?));
                let end = cells.last().map_or_else(|| row.map_or(0, |r| if r.open_end == inner_end(src, r) { r.open_end } else { r.open_end }), |l| l.end);
                (end, end, new)
            }
        };
        Ok(match row {
            Some(row) => {
                let empty = src[row.start..row.open_end].ends_with("/>");
                let close = if empty { format!("{pad}</table:table-row>") } else { src[inner_end(src, row)..row.end].to_owned() };
                let body_start = row.open_end;
                let body_end = inner_end(src, row);
                let (from, to) = (from.max(body_start), to.max(body_start));
                format!("{}>{}{new}{}{close}", open_tag(src, row, ROWS, 1), &src[body_start..from], &src[to..body_end])
            }
            None => format!("<table:table-row>{new}{pad}</table:table-row>"),
        })
    };
    let mut seen = 0;
    for row in &rows {
        let n = count(src, row, ROWS);
        if r < seen + n {
            let (before, after) = (r - seen, n - (r - seen) - 1);
            let sep = gap(src, row.start);
            let mut parts = Vec::new();
            if before > 0 {
                parts.push(copy(src, row, ROWS, before));
            }
            parts.push(one_row(Some(row), &sep)?);
            if after > 0 {
                parts.push(copy(src, row, ROWS, after));
            }
            return Ok(format!("{}{}{}", &src[..row.start], parts.join(&sep), &src[row.end..]));
        }
        seen += n;
    }
    // past the sheet's last row: blank rows between, then the row. A new row takes its neighbour's style, so heights stay even
    let last = rows.last();
    let sep = last.map_or(String::new(), |l| gap(src, l.start));
    let style = last.and_then(|l| {
        let tag = &src[l.start..l.open_end];
        attrs(tag).into_iter().find(|(k, _)| *k == "table:style-name").map(|(_, at)| format!(" table:style-name=\"{}\"", &tag[at]))
    });
    let style = style.unwrap_or_default();
    let mut new = String::new();
    if r > seen {
        let inner = if sep.is_empty() { String::new() } else { format!("{sep} ") };
        new.push_str(&format!("{sep}<table:table-row{style}{}>{inner}<table:table-cell/>{sep}</table:table-row>", if r - seen > 1 { format!(" {ROWS}=\"{}\"", r - seen) } else { String::new() }));
    }
    new.push_str(&format!("{sep}{}", one_row(None, &sep)?.replacen("<table:table-row", &format!("<table:table-row{style}"), 1)));
    // a sheet written as an empty element is opened, so the row goes inside it
    if src[table.start..table.open_end].ends_with("/>") {
        return Ok(format!("{}>{new}</table:table>{}", &src[..table.open_end - 2], &src[table.open_end..]));
    }
    let end = last.map_or(inner_end(src, &table), |l| l.end);
    Ok(format!("{}{new}{}", &src[..end], &src[end..]))
}

/// The rows of a CSV, as the web client reads one (RFC 4180, forgiving):
/// quoted fields, doubled quotes, CR LF or LF. A semicolon or a tab is
/// the separator when the first line has more of them than commas.
pub fn parse_csv(src: &str) -> Vec<Vec<String>> {
    let text = src.strip_prefix('\u{feff}').unwrap_or(src);
    let first = text.split('\n').next().unwrap_or("");
    let count = |ch: char| first.matches(ch).count();
    let sep = if count('\t') > count(',') {
        '\t'
    } else if count(';') > count(',') {
        ';'
    } else {
        ','
    };
    let (mut rows, mut row, mut field, mut quoted) = (Vec::new(), Vec::new(), String::new(), false);
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            match ch {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                _ => field.push(ch),
            }
        } else if ch == '"' && field.is_empty() {
            quoted = true;
        } else if ch == sep {
            row.push(std::mem::take(&mut field));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(ch);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// The most cells a CSV may have to become a page, as on the web.
pub const CSV_MAX_CELLS: usize = 20_000;

/// Whether a field is a plain number: digits, with a sign and a decimal
/// part if it has them. A number with a leading zero, or too long to
/// hold exactly, stays the text it is (a code, a phone number).
fn plain_number(v: &str) -> Option<f64> {
    let digits = v.strip_prefix('-').unwrap_or(v);
    let (whole, part) = digits.split_once('.').unwrap_or((digits, "0"));
    let all = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let ok = all(whole) && all(part) && (whole == "0" || !whole.starts_with('0')) && digits.len() <= 15;
    ok.then(|| v.parse().ok()).flatten()
}

fn escape(s: &str, out: &mut String) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // what XML 1.0 cannot hold is dropped
            c if c < ' ' && c != '\t' && c != '\n' => {}
            c => out.push(c),
        }
    }
}

/// A new spreadsheet page holding a CSV's cells: the web client's blank
/// sheet with the rows in it. A plain number is a number cell and every
/// other field is text, so a field that starts with `=` never runs as a
/// formula.
// ponytail: the web client types each field into its grid, which also reads dates, percents and
// money. Here those stay text. Port its readTyped (ui-src/sheet/book.js) if that matters.
pub fn from_csv(src: &str) -> Result<String, String> {
    let rows = parse_csv(src);
    let cells: usize = rows.iter().map(Vec::len).sum();
    if cells > CSV_MAX_CELLS {
        return Err(format!("it has {cells} cells, and a spreadsheet page holds about {CSV_MAX_CELLS}"));
    }
    let blank = include_str!("../../ui-src/sheet/blank.fods");
    let empty = "    <table:table-row table:style-name=\"ro1\">\n     <table:table-cell/>\n    </table:table-row>\n";
    let at = blank.find(empty).ok_or("the blank sheet is not as expected")?;
    let mut out = String::with_capacity(blank.len() + src.len() * 3);
    out.push_str(&blank[..at]);
    for row in &rows {
        out.push_str("    <table:table-row table:style-name=\"ro1\">\n");
        for v in row {
            if v.is_empty() {
                out.push_str("     <table:table-cell/>\n");
            } else if let Some(n) = plain_number(v) {
                out.push_str(&format!("     <table:table-cell office:value-type=\"float\" office:value=\"{n}\" calcext:value-type=\"float\"><text:p>{n}</text:p></table:table-cell>\n"));
            } else {
                out.push_str("     <table:table-cell office:value-type=\"string\" calcext:value-type=\"string\">");
                for (i, line) in v.split('\n').enumerate() {
                    out.push_str(if i == 0 { "<text:p>" } else { "</text:p><text:p>" });
                    escape(line.trim_end_matches('\r'), &mut out);
                }
                out.push_str("</text:p></table:table-cell>\n");
            }
        }
        if row.is_empty() {
            out.push_str("     <table:table-cell/>\n");
        }
        out.push_str("    </table:table-row>\n");
    }
    if rows.is_empty() {
        out.push_str(empty);
    }
    out.push_str(&blank[at + empty.len()..]);
    Ok(out)
}

fn end_cell(row: &mut Option<(Vec<String>, usize)>, cell: &mut Option<(String, usize)>) {
    let (Some((cells, _)), Some((text, rep))) = (row.as_mut(), cell.take()) else { return };
    let n = rep;
    for _ in 0..n.min(MAX_COLS.saturating_sub(cells.len())) {
        cells.push(text.clone());
    }
}

fn end_row(sheets: &mut [Sheet], row: &mut Option<(Vec<String>, usize)>) {
    let (Some(sheet), Some((mut cells, rep))) = (sheets.last_mut(), row.take()) else { return };
    while cells.last().is_some_and(String::is_empty) {
        cells.pop();
    }
    // empty rows in the middle keep their place, and the tail of them is cut in +parse
    let n = rep;
    for _ in 0..n.min(MAX_ROWS.saturating_sub(sheet.rows.len())) {
        sheet.rows.push(cells.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOOK: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:o" xmlns:table="urn:t" xmlns:text="urn:x" xmlns:calcext="urn:c" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:body>
  <office:spreadsheet>
   <table:table table:name="One">
    <table:table-column table:number-columns-repeated="4"/>
    <table:table-row table:style-name="ro1">
     <table:table-cell office:value-type="string" calcext:value-type="string">
      <text:p>Item</text:p>
     </table:table-cell>
     <table:table-cell table:style-name="ce1" office:value-type="float" office:value="3" calcext:value-type="float" table:number-columns-spanned="2">
      <office:annotation><text:p>a note</text:p></office:annotation>
      <text:p>3</text:p>
     </table:table-cell>
     <table:covered-table-cell/>
     <table:table-cell office:value-type="date" office:date-value="2026-11-17"><text:p>17/11/26</text:p></table:table-cell>
    </table:table-row>
    <table:table-row table:style-name="ro2" table:number-rows-repeated="3">
     <table:table-cell table:style-name="ce2" table:number-columns-repeated="4"/>
    </table:table-row>
   </table:table>
   <table:table table:name="Two"/>
  </office:spreadsheet>
 </office:body>
</office:document>
"#;

    #[test]
    fn typed_text_is_read_as_the_web_client_reads_it() {
        // each answer is what ui-src/sheet/book.js readTyped gives, but for what is refused here
        assert_eq!(typed(""), Ok(Typed::Empty));
        assert_eq!(typed("  "), Ok(Typed::Empty));
        for (t, n) in [("12", 12.0), (" 1,234.50 ", 1234.5), ("-.5", -0.5), ("1e3", 1000.0), ("+7", 7.0), ("1,234,567", 1_234_567.0)] {
            assert_eq!(typed(t), Ok(Typed::Number(n)), "{t}");
        }
        for t in ["abc", "1,23", "1.2.3", ".", "12abc", "12,34"] {
            assert_eq!(typed(t), Ok(Typed::Text(t.into())), "{t}");
        }
        assert_eq!(typed("'12"), Ok(Typed::Text("12".into())));
        assert_eq!(typed("TRUE"), Ok(Typed::Bool(true)));
        assert_eq!(typed("false"), Ok(Typed::Bool(false)));
        for t in ["50%", "$1,200", "-$3", "2026-11-17", "9:30", "09:30:15"] {
            assert!(typed(t).unwrap_err().starts_with("dates, times"), "{t}");
        }
        assert_eq!(typed("=A1+1").unwrap_err(), "formulas are not written here yet");
        assert_eq!(typed("="), Ok(Typed::Text("=".into())));
    }

    #[test]
    fn a_number_shows_as_the_web_client_shows_it() {
        // what ui-src/sheet/funcs.js general gives
        for (n, t) in [(0.0, "0"), (27.5, "27.5"), (1.0 / 3.0, "0.333333333333333"), (1e16, "1E+016"), (123_456_789_012_345_678.0, "1.23456789012346E+017"), (1.5e-16, "1.5E-016"), (-2.5e20, "-2.5E+020"), (0.1 + 0.2, "0.3"), (100.0, "100"), (1e15, "1000000000000000"), (12_345.678_901_234_567, "12345.6789012346")] {
            assert_eq!(general(n), t);
        }
        assert_eq!(general(f64::NAN), "#NUM!");
        assert_eq!((num_attr(27.5), num_attr(1e23), num_attr(1.5e-7), num_attr(-3.0)), ("27.5".into(), "1E23".into(), "1.5E-7".into(), "-3".into()));
    }

    #[test]
    fn a_cell_is_set_and_everything_outside_its_row_is_as_it_was() {
        // the first cell of the first row: only that cell's lines change
        let out = set_cell(BOOK, 0, 0, 0, "Thing & <more>").unwrap();
        assert_eq!(out, BOOK.replace("<text:p>Item</text:p>", "<text:p>Thing &amp; &lt;more&gt;</text:p>"));
        // a number takes the cell's place, with the note, the style and the span it had
        let out = set_cell(BOOK, 0, 0, 1, "27.50").unwrap();
        let want = "<table:table-cell table:style-name=\"ce1\" office:value-type=\"float\" office:value=\"27.5\" calcext:value-type=\"float\" table:number-columns-spanned=\"2\">\n      <office:annotation><text:p>a note</text:p></office:annotation>\n      <text:p>27.5</text:p>\n     </table:table-cell>";
        assert!(out.contains(want), "{out}");
        assert_eq!(out.len(), BOOK.len() + 6, "the value and the text grew by three each and nothing else moved");
        // emptied, a cell keeps its style and its note
        let out = set_cell(BOOK, 0, 0, 1, "").unwrap();
        assert!(out.contains("<table:table-cell table:style-name=\"ce1\" table:number-columns-spanned=\"2\">\n      <office:annotation><text:p>a note</text:p></office:annotation>\n     </table:table-cell>"), "{out}");
        assert_eq!(parse(&out)[0].rows[0][1], "");
    }

    #[test]
    fn a_repeated_row_and_cell_are_split_round_the_one_cell() {
        let out = set_cell(BOOK, 0, 2, 1, "true").unwrap();
        let want = r#"    <table:table-row table:style-name="ro2">
     <table:table-cell table:style-name="ce2" table:number-columns-repeated="4"/>
    </table:table-row>
    <table:table-row table:style-name="ro2">
     <table:table-cell table:style-name="ce2"/>
     <table:table-cell table:style-name="ce2" office:value-type="boolean" office:boolean-value="true" calcext:value-type="boolean">
      <text:p>TRUE</text:p>
     </table:table-cell>
     <table:table-cell table:style-name="ce2" table:number-columns-repeated="2"/>
    </table:table-row>
    <table:table-row table:style-name="ro2">
     <table:table-cell table:style-name="ce2" table:number-columns-repeated="4"/>
    </table:table-row>
   </table:table>"#;
        assert!(out.contains(want), "{out}");
        // the head and the tail of the document are the same bytes
        let cut = BOOK.find("    <table:table-row table:style-name=\"ro2\"").unwrap();
        assert_eq!(&out[..cut], &BOOK[..cut]);
        assert!(out.ends_with(&BOOK[BOOK.find("   <table:table table:name=\"Two\"").unwrap()..]));
        // read back: the cell is where it was put and the sheet is as tall as it was
        let rows = &parse(&out)[0].rows;
        assert_eq!((rows.len(), rows[2][1].as_str()), (3, "TRUE"));
        // the last of a run and the first of a run split in two, not three
        let last = set_cell(BOOK, 0, 3, 3, "x").unwrap();
        assert_eq!(last.matches("<table:table-row").count(), 3);
        assert!(last.contains("table:number-rows-repeated=\"2\"") && last.contains("<table:table-cell table:style-name=\"ce2\" table:number-columns-repeated=\"3\"/>"));
        // set again where it was set: the document is the same again
        assert_eq!(set_cell(&last, 0, 3, 3, "x").unwrap(), last);
    }

    #[test]
    fn a_cell_past_the_end_of_its_row_or_its_sheet_is_made() {
        // past the last cell of a row: one blank, then the cell
        let out = set_cell(BOOK, 0, 0, 5, "far").unwrap();
        assert!(out.contains("<text:p>17/11/26</text:p></table:table-cell>\n     <table:table-cell/>\n     <table:table-cell office:value-type=\"string\" calcext:value-type=\"string\">\n      <text:p>far</text:p>\n     </table:table-cell>\n    </table:table-row>"), "{out}");
        assert_eq!(parse(&out)[0].rows[0][5], "far");
        // past the last row: the blank rows between, in the neighbour's style, then the row
        let out = set_cell(BOOK, 0, 6, 1, "deep").unwrap();
        assert!(out.contains("    <table:table-row table:style-name=\"ro2\" table:number-rows-repeated=\"2\">\n     <table:table-cell/>\n    </table:table-row>\n    <table:table-row table:style-name=\"ro2\">\n     <table:table-cell/>\n     <table:table-cell office:value-type=\"string\" calcext:value-type=\"string\">\n      <text:p>deep</text:p>\n     </table:table-cell>\n    </table:table-row>\n   </table:table>"), "{out}");
        assert_eq!(parse(&out)[0].rows[6][1], "deep");
        // a sheet with no rows at all gets its first
        let out = set_cell(BOOK, 1, 0, 0, "first").unwrap();
        assert_eq!(parse(&out)[1].rows[0][0], "first");
        assert!(out.contains("<table:table table:name=\"Two\"><table:table-row><table:table-cell office:value-type=\"string\" calcext:value-type=\"string\"><text:p>first</text:p></table:table-cell></table:table-row></table:table>"), "the row is inside its sheet: {out}");
        assert!(elements(&out, 0, out.len()).is_ok(), "it is still well formed");
    }

    /// Applies the edits in the file `LR_EDITS` (lines of `sheet,row,column,text`) to the
    /// spreadsheet in `LR_FODS` and writes it to `LR_OUT`, to compare with the web client.
    #[test]
    #[ignore]
    fn real_edit() {
        let (Ok(f), Ok(e), Ok(o)) = (std::env::var("LR_FODS"), std::env::var("LR_EDITS"), std::env::var("LR_OUT")) else { return };
        let mut doc = std::fs::read_to_string(f).unwrap();
        for line in std::fs::read_to_string(e).unwrap().lines() {
            let p: Vec<&str> = line.splitn(4, ',').collect();
            doc = set_cell(&doc, p[0].parse().unwrap(), p[1].parse().unwrap(), p[2].parse().unwrap(), p[3]).unwrap();
        }
        std::fs::write(o, doc).unwrap();
    }

    #[test]
    fn what_cannot_be_written_here_is_refused_and_says_why() {
        assert_eq!(set_cell(BOOK, 0, 0, 2, "x").unwrap_err(), "that cell is part of a merged cell");
        assert!(set_cell(BOOK, 0, 0, 3, "x").unwrap_err().starts_with("that cell holds a date"));
        assert_eq!(set_cell(BOOK, 0, 0, 0, "=1+1").unwrap_err(), "formulas are not written here yet");
        assert!(set_cell(&BOOK.replace("office:value=\"3\"", "table:formula=\"of:=1+2\" office:value=\"3\""), 0, 0, 0, "x").unwrap_err().starts_with("this spreadsheet has formulas"));
        assert_eq!(set_cell(BOOK, 5, 0, 0, "x").unwrap_err(), "this is not a spreadsheet lattice can change");
        assert_eq!(set_cell("<a/>", 0, 0, 0, "x").unwrap_err(), "this is not a spreadsheet lattice can change");
        assert_eq!(set_cell(BOOK, 0, 5000, 0, "x").unwrap_err(), "that is outside the part of the sheet shown here");
        // spaces and tabs are written as LibreOffice writes them
        assert_eq!(paragraphs(" a  b\tc\nd   "), ["<text:p><text:s/>a <text:s/>b<text:tab/>c</text:p>", "<text:p>d <text:s text:c=\"2\"/></text:p>"]);
    }

    const DOC: &str = r#"<?xml version="1.0"?><office:document><office:body><office:spreadsheet>
<table:table table:name="Costs &amp; plans" table:style-name="ta1">
 <table:table-column table:number-columns-repeated="3"/>
 <table:table-row><table:table-cell office:value-type="string"><text:p>Item</text:p></table:table-cell><table:table-cell><text:p>Cost</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1021"/></table:table-row>
 <table:table-row><table:table-cell><text:p>Tea &lt;green&gt;</text:p><text:p>two lines</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="4.5" table:formula="of:=SUM([.B3:.B4])"><text:p>4.50</text:p></table:table-cell></table:table-row>
 <table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell></table:table-row>
 <table:table-row><table:table-cell/><table:table-cell><office:annotation><text:p>a note</text:p></office:annotation><text:p>a<text:s text:c="3"/>b<text:span>c</text:span>&#233;</text:p></table:table-cell></table:table-row>
 <table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
</table:table>
<table:table table:name="Empty"><table:table-row><table:table-cell/></table:table-row></table:table>
</office:spreadsheet></office:body></office:document>"#;

    #[test]
    fn a_sheet_reads_as_the_text_its_cells_show() {
        let s = parse(DOC);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "Costs & plans");
        assert_eq!(
            s[0].rows,
            vec![
                vec!["Item".to_owned(), "Cost".into()],
                vec!["Tea <green>\ntwo lines".into(), "4.50".into()],
                vec!["x".into(), "x".into()],
                vec!["x".into(), "x".into()],
                vec![String::new(), "a   bcé".into()],
            ],
            "repeats expand, the empty tail is cut, a note is not the cell's text"
        );
        assert_eq!(s[0].width(), 2);
        assert_eq!((s[1].name.as_str(), s[1].rows.len()), ("Empty", 0));
    }

    #[test]
    fn what_is_not_a_sheet_reads_as_none_and_nothing_panics() {
        assert!(parse("").is_empty());
        assert!(parse("# just markdown <not a tag").is_empty());
        // cut off mid-document, a cell with a huge repeat: read what is there, bounded
        let cut = &DOC[..DOC.find("two lines").unwrap()];
        assert_eq!(parse(cut)[0].rows.len(), 1);
        let wide = r#"<table:table table:name="w"><table:table-row table:number-rows-repeated="99999999"><table:table-cell table:number-columns-repeated="99999999"><text:p>v</text:p></table:table-cell></table:table-row></table:table>"#;
        let s = parse(wide);
        assert_eq!((s[0].rows.len(), s[0].width()), (MAX_ROWS, MAX_COLS));
    }

    #[test]
    fn the_web_clients_blank_sheet_reads_as_one_empty_sheet() {
        // 250 lines of styles and settings around one empty cell, as LibreOffice writes it
        let s = parse(include_str!("../../ui-src/sheet/blank.fods"));
        assert_eq!(s, vec![Sheet { name: "Sheet1".into(), rows: vec![] }]);
    }

    #[test]
    fn a_csv_reads_as_rows_whatever_its_separator_and_quotes() {
        assert_eq!(parse_csv("a,b\r\n\"x, \"\"y\"\"\",2\n"), vec![vec!["a", "b"], vec!["x, \"y\"", "2"]]);
        assert_eq!(parse_csv("\u{feff}a;b;c\n1,5;2;3"), vec![vec!["a", "b", "c"], vec!["1,5", "2", "3"]]);
        assert_eq!(parse_csv("a\tb\n"), vec![vec!["a", "b"]]);
        assert_eq!(parse_csv("\"two\nlines\",x"), vec![vec!["two\nlines", "x"]]);
        assert_eq!(parse_csv("a,\n,\n"), vec![vec!["a", ""], vec!["", ""]]);
        assert!(parse_csv("").is_empty());
    }

    #[test]
    fn a_csv_becomes_a_sheet_this_client_reads_back_the_same() {
        let csv = "Item,Cost,Code,Note\nTea <green> & \"co\",4.50,007,=SUM(A1)\nMilk,-2,12345678901234567890,\"two\nlines\"\n,,,\nlast,1e5,3.,x\n";
        let fods = from_csv(csv).unwrap();
        // LATTICE_FODS_OUT=file keeps the document, to open in LibreOffice
        if let Ok(out) = std::env::var("LATTICE_FODS_OUT") {
            std::fs::write(out, &fods).unwrap();
        }
        let sheets = parse(&fods);
        assert_eq!(sheets.len(), 1);
        assert_eq!(
            sheets[0].rows,
            vec![
                vec!["Item", "Cost", "Code", "Note"],
                vec!["Tea <green> & \"co\"", "4.5", "007", "=SUM(A1)"],
                vec!["Milk", "-2", "12345678901234567890", "two\nlines"],
                vec![],
                vec!["last", "1e5", "3.", "x"],
            ]
        );
        // a number is a number cell, and what only looks like one is text: nothing typed runs as a formula
        assert_eq!(fods.matches("office:value-type=\"float\"").count(), 2);
        assert!(fods.contains("office:value=\"4.5\"") && fods.contains("office:value=\"-2\""));
        assert!(!fods.contains("table:formula"));
        assert!(fods.contains("<text:p>=SUM(A1)</text:p>"));
        // the rest of the document is the blank sheet's, untouched
        let blank = include_str!("../../ui-src/sheet/blank.fods");
        assert!(fods.starts_with(&blank[..2000]) && fods.ends_with(&blank[blank.len() - 100..]));
        // nothing in it is still an empty sheet, and too many cells is refused
        assert_eq!(from_csv("").unwrap(), blank);
        let big = "a,b\n".repeat(CSV_MAX_CELLS / 2 + 1);
        assert!(from_csv(&big).unwrap_err().contains("cells"));
    }

    #[test]
    fn columns_are_lettered_as_a_spreadsheet_letters_them() {
        let names: Vec<String> = [0, 1, 25, 26, 27, 51, 52, 701, 702].into_iter().map(column_name).collect();
        assert_eq!(names, ["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
    }
}
