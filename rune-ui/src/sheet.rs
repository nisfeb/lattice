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

/// An attribute's value in a tag's text, unescaped. `tag` starts at the element's name.
pub(crate) fn attr(tag: &str, name: &str) -> Option<String> {
    let at = crate::odf::each_attr(tag).find(|a| a.0 == name)?.1;
    let mut out = String::new();
    unescape(&tag[at], &mut out);
    Some(out)
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
        // a comment is not shown, and a CDATA section is text as it stands: neither is a tag, whatever is inside it
        if src[at..].starts_with("<!--") {
            let Some(end) = src[at..].find("-->") else { break };
            i = at + end + 3;
            continue;
        }
        if let Some(raw) = src[at..].strip_prefix("<![CDATA[") {
            let Some(end) = raw.find("]]>") else { break };
            if para && note == 0 {
                if let Some((text, _)) = &mut cell {
                    text.push_str(&raw[..end]);
                }
            }
            i = at + 9 + end + 3;
            continue;
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
#[derive(Clone, Debug, PartialEq)]
pub enum Typed {
    Empty,
    Text(String),
    Number(f64),
    Bool(bool),
    /// A percentage, money, a date or a time, typed as one: the type its cell takes, and the number it is.
    Special(&'static str, f64),
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
    // a figure before the exponent: `e4` is a word, however many figures follow its `e`
    (whole.is_empty() || digits(whole) || grouped(whole)) && frac.is_none_or(digits) && exp.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e))) && mant.bytes().any(|b| b.is_ascii_digit())
}

/// What typed text becomes in a cell, with dates counted from the usual null date. See `typed_on`.
pub fn typed(text: &str) -> Result<Typed, String> {
    typed_on(text, -25_569.0)
}

/// What typed text becomes in a cell, as the web client reads it: a
/// number, a percentage (50%), money ($1,200), true or false, a date
/// (2026-11-17), a time of day (9:30), or text. A leading `'` keeps the
/// rest as text. A formula is not for here: `calc::enter` takes those.
pub fn typed_on(text: &str, null_date: f64) -> Result<Typed, String> {
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
    // what does not read as a number after all is not refused: it is the text that was typed
    if let Some(n) = numeric(t).then(|| t.replace(',', "").parse::<f64>().ok()).flatten() {
        // more than a number can hold is kept as the text it was typed as, never as a nought
        return Ok(if n.is_finite() { Typed::Number(n) } else { Typed::Text(text.to_owned()) });
    }
    let digits = |s: &str, lo: usize, hi: usize| (lo..=hi).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    // a plain number, with no grouping and no exponent, as a percentage's is
    let plain = |s: &str| {
        let s = s.strip_prefix(['+', '-']).unwrap_or(s);
        let (w, f) = s.split_once('.').map_or((s, None), |(w, f)| (w, Some(f)));
        if w.is_empty() { f.is_some_and(|f| digits(f, 1, 400)) } else { digits(w, 1, 400) && f.is_none_or(|f| f.is_empty() || digits(f, 1, 400)) }
    };
    if let Some(n) = t.strip_suffix('%').map(str::trim_end).filter(|n| plain(n)) {
        return Ok(Typed::Special("percentage", n.parse::<f64>().map_err(|_| "that number cannot be read")? / 100.0));
    }
    if let Some((neg, n)) = t.strip_prefix("-$").map(|n| (true, n)).or_else(|| t.strip_prefix('$').map(|n| (false, n))) {
        let n = n.trim_start();
        let (w, f) = n.split_once('.').map_or((n, None), |(w, f)| (w, Some(f)));
        let mut groups = w.split(',');
        let grouped = groups.next().is_some_and(|g| digits(g, 1, 3)) && groups.clone().count() > 0 && groups.all(|g| digits(g, 3, 3));
        if (digits(w, 1, 400) || grouped) && f.is_none_or(|f| digits(f, 1, 400)) {
            let v: f64 = n.replace(',', "").parse().map_err(|_| "that number cannot be read")?;
            return Ok(Typed::Special("currency", if neg { -v } else { v }));
        }
    }
    match t.to_ascii_lowercase().as_str() {
        "true" => return Ok(Typed::Bool(true)),
        "false" => return Ok(Typed::Bool(false)),
        _ => {}
    }
    let d: Vec<&str> = t.split('-').collect();
    if d.len() == 3 && digits(d[0], 4, 4) && digits(d[1], 1, 2) && digits(d[2], 1, 2) {
        let (y, m, day): (i64, i64, i64) = (d[0].parse().unwrap_or(0), d[1].parse().unwrap_or(0), d[2].parse().unwrap_or(0));
        // only a day the calendar has: the 30th of February would run on into March, and is the text that was typed
        if (1..=12).contains(&m) && day >= 1 && civil_from_days(days_from_civil(y, m, day)) == (y, m, day) {
            if let Some(v) = date_serial(&format!("{}-{m:02}-{day:02}", d[0]), null_date) {
                return Ok(Typed::Special("date", v));
            }
        }
    }
    let c: Vec<&str> = t.split(':').collect();
    if (2..=3).contains(&c.len()) && digits(c[0], 1, 2) && digits(c[1], 2, 2) && c.get(2).is_none_or(|s| digits(s, 2, 2)) {
        let n = |s: &str| s.parse::<f64>().unwrap_or(0.0);
        let (m, s) = (n(c[1]), c.get(2).map_or(0.0, |s| n(s)));
        if m < 60.0 && s < 60.0 {
            return Ok(Typed::Special("time", (n(c[0]) * 3600.0 + m * 60.0 + s) / 86_400.0));
        }
    }
    Ok(Typed::Text(text.to_owned()))
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
    // a whole number that a double holds exactly is written in full, all sixteen figures of a card's number
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        return format!("{n:.0}");
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
pub(crate) fn num_attr(n: f64) -> String {
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

/// The attributes that make a cell's formula an array formula. They go when a person types
/// over the cell, or what was typed would be an array formula too.
const MATRIX_ATTRS: [&str; 2] = ["table:number-matrix-columns-spanned", "table:number-matrix-rows-spanned"];

/// Where an element's own content ends: at its closing tag, or at once for an empty one.
pub(crate) fn inner_end(src: &str, el: &El) -> usize {
    if src[el.start..el.open_end].ends_with("/>") { el.open_end } else { src[..el.end].rfind("</").unwrap_or(el.end) }
}

pub(crate) fn kids(src: &str, el: &El) -> Result<Vec<El>, String> {
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
pub(crate) fn copy(src: &str, el: &El, count: &str, n: usize) -> String {
    let rest = &src[el.open_end..el.end];
    format!("{}{}{rest}", open_tag(src, el, count, n), if src[el.start..el.open_end].ends_with("/>") { "/>" } else { ">" })
}

pub(crate) fn count(src: &str, el: &El, name: &str) -> usize {
    let tag = &src[el.start..el.open_end];
    // no more than a sheet has rows: a count of two to the sixty-fourth would wrap every sum it is added to
    attrs(tag).into_iter().find(|(k, _)| *k == name).and_then(|(_, at)| tag[at].parse().ok()).unwrap_or(1).clamp(1, COUNT_MOST)
}

/// The most a row, a cell or a span may be said to repeat: the rows of a whole sheet.
const COUNT_MOST: usize = 1_048_576;

/// The spaces an element is indented by when it starts its line, and
/// what goes between it and a sibling put beside it.
pub(crate) fn gap(src: &str, at: usize) -> String {
    let line = src[..at].rfind('\n').map_or(0, |i| i + 1);
    if src[line..at].bytes().all(|b| b == b' ') { format!("\n{}", &src[line..at]) } else { String::new() }
}

/// What a cell holds, as a formula sees it and as the page stores it.
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Blank,
    Num(f64),
    Str(String),
    Bool(bool),
}

/// What is put into a cell: its formula as stored, the type of its
/// value, the value, the text it shows, and whether it is an error.
#[derive(Clone, Debug, PartialEq)]
pub struct Put {
    pub f: Option<String>,
    /// `string`, `float`, `boolean`, `date`, `time`, `percentage`, `currency`, or nothing.
    pub vt: String,
    pub v: Val,
    pub text: String,
    pub err: bool,
    /// The cell style it takes, when the write gives it a new one.
    pub st: Option<String>,
}

impl From<Typed> for Put {
    fn from(t: Typed) -> Put {
        let (vt, v, text) = match t {
            Typed::Empty => ("", Val::Blank, String::new()),
            Typed::Text(t) => ("string", Val::Str(t.clone()), t),
            Typed::Number(n) => ("float", Val::Num(n), general(n)),
            Typed::Bool(b) => ("boolean", Val::Bool(b), if b { "TRUE" } else { "FALSE" }.to_owned()),
            Typed::Special(vt, n) => (vt, Val::Num(n), general(n)),
        };
        Put { f: None, vt: vt.into(), v, text, err: false, st: None }
    }
}

pub(crate) fn esc_attr(s: &str) -> String {
    esc_text(s).replace('"', "&quot;").replace('\'', "&apos;")
}

/// The furthest year, and the furthest day from 1970, the calendar sums below are done for.
/// Past them a date is held at the edge: a year of a billion billions is a far day, not a
/// sum that wrapped round to a near one.
const FAR_YEAR: i64 = 1_000_000_000_000;
const FAR_DAY: i64 = FAR_YEAR * 366;

/// Whether a day number, counted from the null date, is a day of the years 9999 before to
/// 9999 after: the dates a page can hold and a person can mean.
pub(crate) fn dated(n: f64, null_date: f64) -> bool {
    (n + null_date).abs() <= 4_400_000.0
}

/// A day number as its whole days and the seconds of the day past them, as LibreOffice
/// reads a time of day from one. The seconds are rounded to as many decimals as the day
/// number leaves room for, so that 09:30:15 held as a fraction of a day is not a hair
/// under it, and no further: 23:59:59.9 stays under midnight.
pub(crate) fn day_seconds(t: f64) -> (f64, f64) {
    let whole = t.floor();
    let room = if t.abs() >= 1.0 { (10 - t.abs().log10().ceil() as i32).clamp(2, 9) } else { 9 };
    let to = 10f64.powi(room);
    let secs = ((t - whole) * 86_400.0 * to).round() / to;
    if secs >= 86_400.0 { (whole + 1.0, secs - 86_400.0) } else { (whole, secs) }
}

/// Days from 1970-01-01 to a day of the calendar, and back.
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let (y, m, d) = (y.clamp(-FAR_YEAR, FAR_YEAR), m.clamp(-FAR_YEAR, FAR_YEAR), d.clamp(-FAR_DAY, FAR_DAY));
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z.clamp(-FAR_DAY, FAR_DAY) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// An ISO date or date and time as a spreadsheet's day number, counted from its null date.
pub fn date_serial(iso: &str, null_date: f64) -> Option<f64> {
    let (day, clock) = iso.split_once('T').map_or((iso, None), |(d, c)| (d, Some(c)));
    let neg = day.starts_with('-');
    let p: Vec<&str> = day.trim_start_matches('-').split('-').collect();
    let n = |s: &str| s.parse::<i64>().ok().filter(|_| s.bytes().all(|b| b.is_ascii_digit()));
    if p.len() != 3 || p[0].len() < 4 || p[1].len() != 2 || p[2].len() != 2 {
        return None;
    }
    let y = n(p[0])? * if neg { -1 } else { 1 };
    // a day past its month's end runs on into the next, as JavaScript's Date.UTC has it
    let days = days_from_civil(y, n(p[1])?, 1) + n(p[2])? - 1;
    let frac = clock.and_then(|c| {
        let t: Vec<&str> = c.splitn(3, ':').collect();
        let secs: String = t.get(2)?.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        Some((n(t[0])? as f64 * 3600.0 + n(t[1])? as f64 * 60.0 + secs.parse::<f64>().ok()?) / 86_400.0)
    });
    Some(days as f64 - null_date + frac.unwrap_or(0.0))
}

/// A duration, `PT13H37M05S`, as a fraction of a day.
pub fn time_serial(dur: &str) -> Option<f64> {
    let (neg, rest) = dur.strip_prefix('-').map_or((false, dur), |r| (true, r));
    let mut rest = rest.strip_prefix("PT")?;
    let mut secs = 0.0;
    for (unit, by) in [('H', 3600.0), ('M', 60.0), ('S', 1.0)] {
        if let Some(i) = rest.find(unit) {
            secs += rest[..i].parse::<f64>().ok()? * by;
            rest = &rest[i + 1..];
        }
    }
    rest.is_empty().then_some(if neg { -secs } else { secs } / 86_400.0)
}

/// A day number as the ISO date the page stores, with its time when it has one.
fn serial_date(n: f64, null_date: f64) -> String {
    // in whole seconds first, so a time half a second short of midnight is the next day's start
    let total = (n * 86_400.0).round() as i64;
    let (whole, secs) = (total.div_euclid(86_400), total.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(whole + null_date as i64);
    let clock = if secs > 0 { format!("T{:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60) } else { String::new() };
    format!("{y:04}-{m:02}-{d:02}{clock}")
}

fn serial_time(n: f64) -> String {
    let secs = (n.abs() * 86_400.0).round() as i64;
    format!("{}PT{:02}H{:02}M{:02}S", if n < 0.0 { "-" } else { "" }, secs / 3600, secs / 60 % 60, secs % 60)
}

/// A cell holding `v`, keeping the style, the span and the notes of the cell it takes the place of.
fn cell_xml(src: &str, old: Option<&El>, pad: &str, v: &Put, care: Care, calcext: bool, null_date: f64) -> Result<String, String> {
    let name = old.map_or("table:table-cell", |o| o.name.as_str());
    let tag = old.map_or("", |o| &src[o.start..o.open_end]);
    let had = attrs(tag);
    let raw = |k: &str| had.iter().find(|(n, _)| *n == k).map(|(_, at)| &tag[at.clone()]);
    let mut a = String::new();
    // the style the write gives it, else the one it had
    if let Some(st) = v.st.as_deref().or(raw("table:style-name")) {
        a.push_str(&format!(" table:style-name=\"{st}\""));
    }
    if let Some(val) = raw("table:content-validation-name") {
        a.push_str(&format!(" table:content-validation-name=\"{val}\""));
    }
    if let Some(f) = &v.f {
        a.push_str(&format!(" table:formula=\"{}\"", esc_attr(f)));
    }
    if !v.vt.is_empty() {
        let n = match &v.v {
            Val::Num(n) => *n,
            Val::Bool(b) => f64::from(*b),
            _ => 0.0,
        };
        // a day number no calendar date stands for is kept as the number it is, not as a date made up for it
        let vt = if v.vt == "date" && !dated(n, null_date) { "float" } else { v.vt.as_str() };
        a.push_str(&format!(" office:value-type=\"{vt}\""));
        match (vt, &v.v) {
            // a formula's text is kept beside it, so a reader need not work the formula out
            ("string", Val::Str(t)) if v.f.is_some() => a.push_str(&format!(" office:string-value=\"{}\"", esc_attr(if v.err { "" } else { t }))),
            ("string", _) => {}
            ("boolean", _) => a.push_str(&format!(" office:boolean-value=\"{}\"", n != 0.0)),
            ("date", _) => a.push_str(&format!(" office:date-value=\"{}\"", serial_date(n, null_date))),
            ("time", _) => a.push_str(&format!(" office:time-value=\"{}\"", serial_time(n))),
            (vt, _) => {
                // money is in the currency the cell had, or dollars
                if vt == "currency" {
                    a.push_str(&format!(" office:currency=\"{}\"", raw("office:currency").unwrap_or("USD")));
                }
                a.push_str(&format!(" office:value=\"{}\"", num_attr(n)));
            }
        }
        // LibreOffice's own attribute, only where the document declares its namespace
        if calcext {
            a.push_str(&format!(" calcext:value-type=\"{}\"", if v.err { "error" } else { vt }));
        }
    }
    for (k, at) in had.iter().filter(|(k, _)| !VALUE_ATTRS.contains(k) && *k != "table:content-validation-name" && (care == Care::Result || !MATRIX_ATTRS.contains(k))) {
        a.push_str(&format!(" {k}=\"{}\"", &tag[at.clone()]));
    }
    // what the cell held that is not its text: a note, a picture
    let keep: String = match old {
        Some(o) => kids(src, o)?.iter().filter(|k| k.name != "text:p").map(|k| &src[k.start..k.end]).collect(),
        None => String::new(),
    };
    let ps = paragraphs(&v.text);
    if ps.is_empty() && keep.is_empty() {
        return Ok(format!("<{name}{a}/>"));
    }
    let inner = if pad.is_empty() { String::new() } else { format!("{pad} ") };
    let kept = if keep.is_empty() { String::new() } else { format!("{inner}{keep}") };
    Ok(format!("<{name}{a}>{kept}{}{pad}</{name}>", ps.iter().map(|p| format!("{inner}{p}")).collect::<String>()))
}

pub(crate) const ROWS: &str = "table:number-rows-repeated";
pub(crate) const COLS: &str = "table:number-columns-repeated";

/// A sheet of a flat ODS document: its table, its rows, also those in a
/// header or a group, and whether the document declares LibreOffice's
/// own namespace.
pub(crate) fn sheet_rows(src: &str, sheet: usize) -> Result<(El, Vec<El>, bool), String> {
    let (ss, calcext) = spreadsheet(src)?;
    let table = kids(src, &ss)?.into_iter().filter(|e| e.name == "table:table").nth(sheet).ok_or("this is not a spreadsheet lattice can change")?;
    let mut rows = Vec::new();
    rows_of(src, &table, &mut rows)?;
    Ok((table, rows, calcext))
}

/// The spreadsheet element of a flat ODS document, and whether the
/// document declares LibreOffice's own namespace.
pub(crate) fn spreadsheet(src: &str) -> Result<(El, bool), String> {
    let no = || "this is not a spreadsheet lattice can change".to_owned();
    let root = elements(src, 0, src.len())?.into_iter().find(|e| e.name == "office:document").ok_or_else(no)?;
    let calcext = src[root.start..root.open_end].contains("xmlns:calcext=");
    let mut at = root;
    for name in ["office:body", "office:spreadsheet"] {
        at = kids(src, &at)?.into_iter().find(|e| e.name == name).ok_or_else(no)?;
    }
    Ok((at, calcext))
}

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

/// The day the document counts dates from, in days since 1970: 30 December 1899 unless it says otherwise.
fn null_date(src: &str, ss: &El) -> f64 {
    let said = kids(src, ss).ok().and_then(|k| k.into_iter().find(|e| e.name == "table:calculation-settings")).and_then(|calc| kids(src, &calc).ok()?.into_iter().find(|e| e.name == "table:null-date")).and_then(|nd| attr(&src[nd.start + 1..nd.open_end], "table:date-value"));
    said.and_then(|iso| date_serial(&iso, 0.0)).map_or(-25_569.0, f64::trunc)
}

/// A cell, or a run of the same cell, as formulas read it.
#[derive(Clone, Debug, Default)]
pub struct MCell {
    pub rep: usize,
    pub vt: String,
    pub v: Option<Val>,
    pub f: Option<String>,
    pub text: String,
    pub err: bool,
    /// The cell style it names, when it names one.
    pub st: Option<String>,
    /// It lies under a merged cell.
    pub covered: bool,
    /// Its formula was entered as an array formula, worked out cell by cell over its ranges.
    pub array: bool,
    /// How far an array formula's results spread from the cell: rows, then columns.
    pub spill: (usize, usize),
}

pub struct MRow {
    pub rep: usize,
    pub cells: Vec<MCell>,
}

pub struct MSheet {
    pub name: String,
    pub rows: Vec<MRow>,
    /// The columns, in runs: how many, and the style their cells take when they name none.
    pub cols: Vec<(usize, Option<String>)>,
    /// Each run of columns' own style, which says how wide they are.
    pub col_styles: Vec<(usize, Option<String>)>,
    /// The row each run of rows starts at, for finding a row without walking them all.
    starts: Vec<usize>,
}

/// A spreadsheet's sheets with every cell's type, value and formula.
pub struct Book {
    pub sheets: Vec<MSheet>,
    pub null_date: f64,
}

impl Book {
    /// The style in force at a cell: its own, else its column's, else the default.
    pub fn style_at(&self, s: usize, r: usize, c: usize) -> String {
        if let Some(st) = self.at(s, r, c).and_then(|cell| cell.st.clone()) {
            return st;
        }
        let mut seen = 0usize;
        let col = self.sheets.get(s).and_then(|sh| {
            sh.cols.iter().find(|(rep, _)| {
                seen = seen.saturating_add(*rep);
                c < seen
            })
        });
        col.and_then(|(_, st)| st.clone()).unwrap_or_else(|| "Default".to_owned())
    }

    /// The cell at a place, or nothing past the stored rows and cells.
    pub fn at(&self, s: usize, r: usize, c: usize) -> Option<&MCell> {
        let sh = self.sheets.get(s)?;
        // the last run that starts at or before the row
        let row = sh.rows.get(sh.starts.partition_point(|at| *at <= r).checked_sub(1)?).filter(|row| r < sh.starts[sh.starts.partition_point(|at| *at <= r) - 1].saturating_add(row.rep))?;
        let mut seen = 0usize;
        row.cells.iter().find(|cell| {
            seen = seen.saturating_add(cell.rep);
            c < seen
        })
    }
}

/// The typed model of a flat ODS document.
pub fn book(src: &str) -> Result<Book, String> {
    let (ss, _) = spreadsheet(src)?;
    let null_date = null_date(src, &ss);
    let mut sheets = Vec::new();
    for table in kids(src, &ss)?.into_iter().filter(|e| e.name == "table:table") {
        let mut rows = Vec::new();
        rows_of(src, &table, &mut rows)?;
        let mut out = Vec::new();
        for row in &rows {
            let mut cells = Vec::new();
            for cell in kids(src, row)?.iter().filter(|k| k.name == "table:table-cell" || k.name == "table:covered-table-cell") {
                let tag = &src[cell.start + 1..cell.open_end];
                let get = |k: &str| attr(tag, k);
                let vt = get("office:value-type").unwrap_or_default();
                let err = get("calcext:value-type").as_deref() == Some("error");
                // ponytail: a cell's text is read by the grid's own reader, one cell at a time. A reader of its own if a large sheet is slow to change
                let text = if cell.open_end == cell.end { String::new() } else { parse(&format!("<table:table><table:table-row><table:table-cell>{}</table:table-row></table:table>", &src[cell.open_end..cell.end])).first().and_then(|s| s.rows.first()?.first().cloned()).unwrap_or_default() };
                let num = |k: &str| get(k).and_then(|v| v.trim().parse::<f64>().ok()).filter(|n| !n.is_nan());
                let v = match vt.as_str() {
                    "" => None,
                    "string" => Some(Val::Str(get("office:string-value").filter(|_| !err).unwrap_or_else(|| text.clone()))),
                    "boolean" => Some(Val::Bool(get("office:boolean-value").as_deref() == Some("true"))),
                    "date" => Some(Val::Num(get("office:date-value").and_then(|d| date_serial(&d, null_date)).unwrap_or(0.0))),
                    "time" => Some(Val::Num(get("office:time-value").and_then(|d| time_serial(&d)).unwrap_or(0.0))),
                    _ => Some(Val::Num(num("office:value").unwrap_or(0.0))),
                };
                cells.push(MCell { rep: count(src, cell, COLS), vt, v, f: get("table:formula"), text, err, st: get("table:style-name"), covered: cell.name == "table:covered-table-cell", array: get("table:number-matrix-columns-spanned").is_some() || get("table:number-matrix-rows-spanned").is_some(), spill: (count(src, cell, "table:number-matrix-rows-spanned"), count(src, cell, "table:number-matrix-columns-spanned")) });
            }
            out.push(MRow { rep: count(src, row, ROWS), cells });
        }
        // the columns, also those in a header or a group
        fn cols_of(src: &str, el: &El, out: &mut Vec<(usize, Option<String>)>) -> Result<(), String> {
            for k in kids(src, el)? {
                match k.name.as_str() {
                    "table:table-column" => out.push((count(src, &k, COLS), attr(&src[k.start + 1..k.open_end], "table:default-cell-style-name"))),
                    "table:table-header-columns" | "table:table-column-group" | "table:table-columns" => cols_of(src, &k, out)?,
                    _ => {}
                }
            }
            Ok(())
        }
        let mut cols = Vec::new();
        cols_of(src, &table, &mut cols)?;
        // the same columns again, by the style of the column itself
        fn col_styles_of(src: &str, el: &El, out: &mut Vec<(usize, Option<String>)>) -> Result<(), String> {
            for k in kids(src, el)? {
                match k.name.as_str() {
                    "table:table-column" => out.push((count(src, &k, COLS), attr(&src[k.start + 1..k.open_end], "table:style-name"))),
                    "table:table-header-columns" | "table:table-column-group" | "table:table-columns" => col_styles_of(src, &k, out)?,
                    _ => {}
                }
            }
            Ok(())
        }
        let mut col_styles = Vec::new();
        col_styles_of(src, &table, &mut col_styles)?;
        let mut starts = Vec::with_capacity(out.len());
        let mut at = 0usize;
        for row in &out {
            starts.push(at);
            at = at.saturating_add(row.rep);
        }
        sheets.push(MSheet { name: attr(&src[table.start + 1..table.open_end], "table:name").unwrap_or_default(), rows: out, cols, col_styles, starts });
    }
    Ok(Book { sheets, null_date })
}

/// The formula a cell holds, as it is stored, or nothing.
pub fn formula_at(src: &str, sheet: usize, r: usize, c: usize) -> Option<String> {
    let (_, rows, _) = sheet_rows(src, sheet).ok()?;
    let mut seen = 0usize;
    let row = rows.iter().find(|row| {
        seen = seen.saturating_add(count(src, row, ROWS));
        r < seen
    })?;
    let mut seen = 0usize;
    let cells = kids(src, row).ok()?;
    let cell = cells.iter().filter(|k| k.name == "table:table-cell" || k.name == "table:covered-table-cell").find(|cell| {
        seen = seen.saturating_add(count(src, cell, COLS));
        c < seen
    })?;
    attr(&src[cell.start + 1..cell.open_end], "table:formula")
}

/// A flat ODS document with one cell holding what was typed, and every
/// byte that is not of that cell's row as it was. A repeated row or
/// cell is split so the one cell stands alone, and a cell past the end
/// of its row or its sheet is made, with the blanks before it.
///
/// Nothing is worked out here: `calc::enter` does that, and is what a
/// person's typing goes through.
pub fn set_cell(src: &str, sheet: usize, r: usize, c: usize, text: &str) -> Result<String, String> {
    put_cell(src, sheet, r, c, &typed(text)?.into(), Care::Typed)
}

/// How careful a write is. A person's typing is refused where it would
/// lose something. A formula's result goes wherever the formula is.
#[derive(Clone, Copy, PartialEq)]
pub enum Care {
    /// A value typed by a person.
    Typed,
    /// A formula typed by a person.
    Formula,
    /// A result worked out for a formula already there.
    Result,
}

/// A flat ODS document with one cell holding `value`. See `set_cell`.
pub fn put_cell(src: &str, sheet: usize, r: usize, c: usize, value: &Put, care: Care) -> Result<String, String> {
    put_cells(src, sheet, &std::collections::BTreeMap::from([(r, vec![(c, value.clone())])]), care)
}

/// The row with one cell of it holding `value`, standing alone: a run of one.
#[allow(clippy::too_many_arguments)]
fn row_with(src: &str, row: Option<&El>, pad: &str, c: usize, value: &Put, care: Care, calcext: bool, null_date: f64) -> Result<String, String> {
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
            if cell.name == "table:covered-table-cell" && care != Care::Result {
                return Err("that cell is part of a merged cell".into());
            }
            let sep = gap(src, cell.start);
            let mut parts = Vec::new();
            if before > 0 {
                parts.push(copy(src, cell, COLS, before));
            }
            parts.push(cell_xml(src, Some(cell), &sep, value, care, calcext, null_date)?);
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
            new.push_str(&format!("{sep}{}", cell_xml(src, None, &sep, value, care, calcext, null_date)?));
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
}

/// A flat ODS document with cells of one sheet holding new values: for
/// each row, the cells to set. The page is read once and written once,
/// however many cells there are.
pub fn put_cells(src: &str, sheet: usize, edits: &std::collections::BTreeMap<usize, Vec<(usize, Put)>>, care: Care) -> Result<String, String> {
    if care != Care::Result && edits.iter().any(|(r, cells)| *r >= MAX_ROWS || cells.iter().any(|(c, _)| *c >= MAX_COLS)) {
        return Err("that is outside the part of the sheet shown here".into());
    }
    let (table, rows, calcext) = sheet_rows(src, sheet)?;
    let null_date = null_date(src, &spreadsheet(src)?.0);
    // A cell that an array formula spreads a result over is not typed into: the formula would still say it reaches
    // that far, and LibreOffice puts its own result back over what was typed. The formula's own cell is another matter
    if care != Care::Result && src[table.start..table.end].contains("number-matrix-") {
        let mut top = 0usize;
        for row in &rows {
            let rep = count(src, row, ROWS);
            let mut left = 0usize;
            // only a row that has such a formula is read cell by cell
            let cells = if src[row.start..row.end].contains("number-matrix-") { kids(src, row)? } else { Vec::new() };
            for cell in &cells {
                let (tall, wide) = (count(src, cell, MATRIX_ATTRS[1]), count(src, cell, MATRIX_ATTRS[0]));
                if tall > 1 || wide > 1 {
                    for at in top..top.saturating_add(rep.min(1024)) {
                        let under = |(r, cells): (&usize, &Vec<(usize, Put)>)| cells.iter().any(|(c, _)| (left..left.saturating_add(wide)).contains(c) && (*r, *c) != (at, left));
                        if edits.range(at..at.saturating_add(tall)).any(under) {
                            return Err("that cell is part of an array formula".into());
                        }
                    }
                }
                left = left.saturating_add(count(src, cell, COLS));
            }
            top = top.saturating_add(rep);
        }
    }
    // a row with every one of its cells set, one after another, each on the row the one before made
    let row_of = |row: Option<&El>, pad: &str, cells: &[(usize, Put)]| -> Result<String, String> {
        let mut text: Option<String> = None;
        for (c, value) in cells {
            text = Some(match &text {
                None => row_with(src, row, pad, *c, value, care, calcext, null_date)?,
                Some(t) => {
                    let el = elements(t, 0, t.len())?.into_iter().next().ok_or("a row was lost")?;
                    row_with(t, Some(&el), pad, *c, value, care, calcext, null_date)?
                }
            });
        }
        text.ok_or_else(|| "a row with nothing to set".to_owned())
    };
    // what takes the place of what, in the page's order
    let mut swaps: Vec<(usize, usize, String)> = Vec::new();
    let mut todo = edits.iter().peekable();
    let mut seen = 0;
    for row in &rows {
        let n = count(src, row, ROWS);
        let (mut at, sep, mut parts) = (seen, gap(src, row.start), Vec::new());
        // a repeated row is split round each of its rows that is set
        while let Some((r, cells)) = todo.next_if(|(r, _)| **r < seen + n) {
            if *r > at {
                parts.push(copy(src, row, ROWS, r - at));
            }
            parts.push(row_of(Some(row), &sep, cells)?);
            at = r + 1;
        }
        if !parts.is_empty() {
            if seen + n > at {
                parts.push(copy(src, row, ROWS, seen + n - at));
            }
            swaps.push((row.start, row.end, parts.join(&sep)));
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
    for (r, cells) in todo {
        if *r > seen {
            let inner = if sep.is_empty() { String::new() } else { format!("{sep} ") };
            new.push_str(&format!("{sep}<table:table-row{style}{}>{inner}<table:table-cell/>{sep}</table:table-row>", if r - seen > 1 { format!(" {ROWS}=\"{}\"", r - seen) } else { String::new() }));
        }
        new.push_str(&format!("{sep}{}", row_of(None, &sep, cells)?.replacen("<table:table-row", &format!("<table:table-row{style}"), 1)));
        seen = r + 1;
    }
    if !new.is_empty() {
        // a sheet written as an empty element is opened, so the row goes inside it
        if src[table.start..table.open_end].ends_with("/>") {
            swaps.push((table.open_end - 2, table.open_end, format!(">{new}</table:table>")));
        } else {
            let end = last.map_or(inner_end(src, &table), |l| l.end);
            swaps.push((end, end, new));
        }
    }
    let mut out = String::with_capacity(src.len() + swaps.iter().map(|s| s.2.len()).sum::<usize>());
    let mut at = 0;
    for (from, to, with) in &swaps {
        out.push_str(&src[at..*from]);
        out.push_str(with);
        at = *to;
    }
    out.push_str(&src[at..]);
    Ok(out)
}

/// Why a sheet cannot have this name, by the web client's rules, or nothing when it can.
pub fn bad_sheet_name(name: &str, have: &[String]) -> Option<&'static str> {
    if name.is_empty() {
        return Some("a sheet needs a name");
    }
    if name.encode_utf16().count() > 100 || name.contains(['[', ']', '*', '?', ':', '/', '\\']) || name.starts_with('\'') || name.ends_with('\'') {
        return Some("a sheet name cannot hold [ ] * ? : / \\ or start or end with an apostrophe");
    }
    let low = name.to_lowercase();
    have.iter().any(|h| h.to_lowercase() == low).then_some("there is already a sheet with that name")
}

/// The page with one more sheet after its last, and which sheet that
/// is. An empty name gets the first `SheetN` not taken. The new sheet
/// is written as the web client writes it: one blank row, and the
/// first sheet's table style.
pub fn add_sheet(src: &str, name: &str) -> Result<(String, usize), String> {
    let (ss, _) = spreadsheet(src)?;
    if src[ss.start..ss.open_end].ends_with("/>") {
        return Err("this is not a spreadsheet lattice can change".into());
    }
    let tables: Vec<El> = kids(src, &ss)?.into_iter().filter(|e| e.name == "table:table").collect();
    let tag = |e: &El| &src[e.start + 1..e.open_end];
    let have: Vec<String> = tables.iter().map(|e| attr(tag(e), "table:name").unwrap_or_default()).collect();
    let mut name = name.trim().to_owned();
    if name.is_empty() {
        let mut i = have.len() + 1;
        loop {
            name = format!("Sheet{i}");
            i += 1;
            if !have.iter().any(|h| h.to_lowercase() == name.to_lowercase()) {
                break;
            }
        }
    }
    if let Some(why) = bad_sheet_name(&name, &have) {
        return Err(why.into());
    }
    // beside the last sheet, indented as it is: three spaces when the page has none
    let (at, ind) = match tables.last() {
        Some(last) => (last.end, gap(src, last.start).len().saturating_sub(1)),
        None => (ss.open_end, 3),
    };
    let sp = " ".repeat(ind);
    let style = tables.first().and_then(|e| attr(tag(e), "table:style-name")).map_or(String::new(), |s| format!(" table:style-name=\"{}\"", esc_attr(&s)));
    let xml = format!("\n{sp}<table:table table:name=\"{}\"{style}>\n{sp} <table:table-row>\n{sp}  <table:table-cell/>\n{sp} </table:table-row>\n{sp}</table:table>", esc_attr(&name));
    Ok((format!("{}{xml}{}", &src[..at], &src[at..]), tables.len()))
}

/// The rows of a CSV, as the web client reads one (RFC 4180, forgiving):
/// quoted fields, doubled quotes, CR LF or LF. A semicolon or a tab is
/// the separator when the first line has more of them than commas.
pub fn parse_csv(src: &str) -> Vec<Vec<String>> {
    let text = src.strip_prefix('\u{feff}').unwrap_or(src);
    // the separators of the first line, counted as the reader below would meet them with each
    // as the separator: a quote opens a quoted field only at the start of a field, and a
    // quoted field may hold any of them and a line break too
    let count = |sep: char| {
        let (mut n, mut len, mut quoted) = (0usize, 0usize, false);
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            if quoted {
                if ch == '"' && chars.peek() != Some(&'"') {
                    quoted = false;
                } else {
                    len += 1;
                    if ch == '"' {
                        chars.next();
                    }
                }
            } else if ch == '"' && len == 0 {
                quoted = true;
            } else if ch == sep {
                (n, len) = (n + 1, 0);
            } else if ch == '\n' || ch == '\r' {
                break;
            } else {
                len += 1;
            }
        }
        n
    };
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

/// The most text one cell's repeats may come to, in bytes. A row's repeats may come to sixteen times it.
const REPEAT_BYTES: usize = 4 << 20;

fn end_cell(row: &mut Option<(Vec<String>, usize)>, cell: &mut Option<(String, usize)>) {
    let (Some((cells, _)), Some((text, rep))) = (row.as_mut(), cell.take()) else { return };
    // a cell said to stand many times over is copied only as far as `REPEAT_BYTES` of text goes: a long one said a billion times would else be gigabytes
    let n = rep.min(REPEAT_BYTES / text.len().max(1)).max(1);
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
    let size: usize = cells.iter().map(|c| c.len() + 24).sum();
    let n = rep.min(REPEAT_BYTES * 16 / size.max(1)).max(1);
    for _ in 0..n.min(MAX_ROWS.saturating_sub(sheet.rows.len())) {
        sheet.rows.push(cells.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sheet_is_added_as_the_web_client_adds_one() {
        let mut body = include_str!("typed_fixture.fods").to_owned();
        for (name, at) in [("", 1), ("A & \"B\" <c>", 2), ("Bob's", 3), ("  ", 4)] {
            let (next, got) = add_sheet(&body, name).unwrap();
            assert_eq!(got, at);
            body = next;
        }
        assert!(body == include_str!("sheets_expected.fods"), "the page differs from the web client's");
        let names: Vec<String> = parse(&body).into_iter().map(|s| s.name).collect();
        assert_eq!(names[1..], ["Sheet2", "A & \"B\" <c>", "Bob's", "Sheet5"]);
        // the names the web client refuses
        assert_eq!(add_sheet(&body, "sheet2").unwrap_err(), "there is already a sheet with that name");
        for bad in ["a:b", "a/b", "[x]", "'x", "x'", "what?", "a*b", "a\\b"] {
            assert!(add_sheet(&body, bad).unwrap_err().starts_with("a sheet name cannot hold"), "{bad}");
        }
        assert!(add_sheet(&body, &"x".repeat(101)).is_err());
        assert!(add_sheet(&body, &"x".repeat(100)).is_ok());
        assert!(add_sheet("not a sheet", "").is_err());
    }

    #[test]
    fn an_attribute_in_single_quotes_is_read_the_same_by_the_grid_and_the_model() {
        // XML takes either quote. LibreOffice writes double ones, and other writers need not
        let doc = r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:o" xmlns:table="urn:t" xmlns:text="urn:x" xmlns:calcext="urn:c" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:body><office:spreadsheet><table:table table:name='A "quoted" &amp; one'>
  <table:table-row table:number-rows-repeated='2'>
   <table:table-cell table:number-columns-repeated='3' office:value-type='float' office:value='1'><text:p>1</text:p></table:table-cell>
   <table:table-cell office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell>
   <table:table-cell office:value-type='string' table:note="it's"><text:p>three</text:p></table:table-cell>
  </table:table-row>
  <table:table-row>
   <table:table-cell table:formula='of:=[.A1]+1' office:value-type='float' office:value='2' office:lookalike="table:formula='of:=9'"><text:p>2</text:p></table:table-cell>
   <table:table-cell office:value-type = 'float'  office:value
     ='7'><text:p>7</text:p></table:table-cell>
  </table:table-row>
 </table:table></office:spreadsheet></office:body>
</office:document>"#;
        let shown = parse(doc);
        assert_eq!(shown[0].name, "A \"quoted\" & one");
        let want = ["1", "1", "1", "2", "three"];
        assert_eq!(shown[0].rows, [want.map(str::to_owned).to_vec(), want.map(str::to_owned).to_vec(), vec!["2".to_owned(), "7".to_owned()]]);
        // the model holds the same cells at the same places, with their kinds and values
        let model = book(doc).unwrap();
        for (r, row) in shown[0].rows.iter().enumerate() {
            for (c, text) in row.iter().enumerate() {
                assert_eq!(&model.at(0, r, c).unwrap().text, text, "row {r} column {c}");
            }
        }
        assert_eq!(model.sheets[0].name, shown[0].name);
        // a formula in single quotes is a formula, and one that only stands in another attribute's value is not
        assert_eq!(formula_at(doc, 0, 2, 0).as_deref(), Some("of:=[.A1]+1"));
        assert_eq!(formula_at(doc, 0, 2, 1), None);
        assert_eq!(attr("table:table-cell a='1' b=\"x a='2'\" c = '3'", "a").as_deref(), Some("1"));
        assert_eq!(attr("table:table-cell b=\"x a='2'\" c = '3' d=\"&lt;'&quot;\"", "a"), None);
        assert_eq!(attr("table:table-cell b=\"x a='2'\" c = '3' d=\"&lt;'&quot;\"", "c").as_deref(), Some("3"));
        assert_eq!(attr("table:table-cell b=\"x a='2'\" c = '3' d=\"&lt;'&quot;\"/", "d").as_deref(), Some("<'\""));
        assert_eq!(attr("table:table-cell xa='1' a.b='2'", "a"), None);
        // typing where the grid shows a cell changes that cell
        let typed = set_cell(doc, 0, 0, 4, "X").unwrap();
        let after = parse(&typed);
        assert_eq!(after[0].rows[0], ["1", "1", "1", "2", "X"]);
        assert_eq!(after[0].rows[1], want);
        // and typing over a cell written with single quotes, in a run of cells in a run of rows, changes it alone
        let typed = set_cell(doc, 0, 1, 1, "5").unwrap();
        let after = parse(&typed);
        assert_eq!((after[0].rows[0].clone(), after[0].rows[1].clone(), after[0].rows[2].clone()), (want.map(str::to_owned).to_vec(), ["1", "5", "1", "2", "three"].map(str::to_owned).to_vec(), vec!["2".to_owned(), "7".to_owned()]));
        assert_eq!(book(&typed).unwrap().at(0, 1, 1).map(|c| c.text.clone()).as_deref(), Some("5"));
    }

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
        // a percentage, money, a date and a time are the numbers the web client makes of them
        for (t, vt, n) in [("50%", "percentage", 0.5), ("$1,200", "currency", 1200.0), ("-$3", "currency", -3.0), ("2026-11-17", "date", 46343.0), ("9:30", "time", 0.3958333333333333), ("09:30:15", "time", 0.39600694444444445), (".5 %", "percentage", 0.005), ("$ 2.50", "currency", 2.5), ("2026-1-5", "date", 46027.0), ("99:00", "time", 4.125)] {
            assert_eq!(typed(t), Ok(Typed::Special(vt, n)), "{t}");
        }
        // and what only looks like one is text
        for t in ["1,000%", "1e2%", "$1,23", "$", "2026-13-01", "2026-11-32", "26-11-17", "9:60", "9:5", "100:00", "1:2:3:4", "$-3"] {
            assert_eq!(typed(t), Ok(Typed::Text(t.into())), "{t}");
        }
        assert_eq!(typed("=A1+1").unwrap_err(), "formulas are not written here yet");
        assert_eq!(typed("="), Ok(Typed::Text("=".into())));
    }

    #[test]
    fn letters_and_figures_that_are_no_number_are_text_and_never_refused() {
        // a chess move, a seat, a part number: an `e` with figures after it and none before is no number
        for t in ["e4", "E5", "E100", "-e5", "+E3", "e-5", "e+5", ".e5", "-.e3", "e", "E", "1e", "ee5", "e4 e5", "1e+", ".", "-", "+", "1.2.3", "1,00", ",5", "1e5e5"] {
            assert_eq!(typed(t), Ok(Typed::Text(t.into())), "{t}");
        }
        // and what is a number still is
        for (t, n) in [("1e4", 1e4), ("1E-2", 0.01), (".5e1", 5.0), ("-.5", -0.5), ("+1,000.5e1", 10005.0), ("0e0", 0.0), ("5.0", 5.0)] {
            assert_eq!(typed(t), Ok(Typed::Number(n)), "{t}");
        }
        // typed into a sheet, it is stored as the text it is
        let after = crate::calc::enter(BOOK, 0, 5, 0, "e4").unwrap().body;
        assert_eq!(book(&after).unwrap().at(0, 5, 0).map(|c| (c.vt.as_str(), c.text.as_str())), Some(("string", "e4")));
    }

    #[test]
    fn a_typed_date_that_does_not_exist_is_text() {
        for t in ["2024-02-30", "2023-02-29", "2024-04-31", "2024-2-30", "2024-06-31", "1900-02-29", "2024-00-10", "2024-13-01", "2024-01-00", "2024-01-32"] {
            assert_eq!(typed(t), Ok(Typed::Text(t.into())), "{t}");
        }
        for t in ["2024-02-29", "2023-02-28", "2024-04-30", "2024-2-9", "2024-12-31", "2000-02-29", "2024-01-01"] {
            assert!(matches!(typed(t), Ok(Typed::Special("date", _))), "{t}");
        }
        assert_eq!(typed("2024-02-29"), Ok(Typed::Special("date", 45351.0)));
    }

    #[test]
    fn a_typed_number_too_large_to_hold_is_text() {
        assert_eq!(typed("1e999"), Ok(Typed::Text("1e999".into())));
        assert_eq!(typed("-1e999"), Ok(Typed::Text("-1e999".into())));
        assert_eq!(typed("1e308"), Ok(Typed::Number(1e308)));
        // and the page holds the text, with no value of nought beside it
        let out = set_cell(BOOK, 0, 0, 0, "1e999").unwrap();
        assert!(out.contains("<text:p>1e999</text:p>") && !out.contains("office:value=\"0\""), "{out}");
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
        assert_eq!(set_cell(BOOK, 0, 0, 0, "=1+1").unwrap_err(), "formulas are not written here yet");
        assert_eq!(set_cell(BOOK, 5, 0, 0, "x").unwrap_err(), "this is not a spreadsheet lattice can change");
        assert_eq!(set_cell("<a/>", 0, 0, 0, "x").unwrap_err(), "this is not a spreadsheet lattice can change");
        assert_eq!(set_cell(BOOK, 0, 5000, 0, "x").unwrap_err(), "that is outside the part of the sheet shown here");
        // a cell's formula is found where the cell is, through repeats, with its escapes read
        let f = BOOK.replace("<table:table-cell table:style-name=\"ce2\" table:number-columns-repeated=\"4\"/>", "<table:table-cell table:number-columns-repeated=\"2\"/><table:table-cell table:formula=\"of:=IF([.A1]&gt;1;&quot;y&quot;;0)\" office:value-type=\"float\" office:value=\"0\"/>");
        assert_eq!(formula_at(&f, 0, 3, 2).as_deref(), Some("of:=IF([.A1]>1;\"y\";0)"));
        assert_eq!(formula_at(&f, 0, 1, 2).as_deref(), Some("of:=IF([.A1]>1;\"y\";0)"), "each row of the run has it");
        assert_eq!((formula_at(&f, 0, 3, 1), formula_at(&f, 0, 0, 0), formula_at(&f, 0, 9, 9), formula_at(&f, 7, 0, 0)), (None, None, None, None));
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
    fn a_csvs_separator_is_counted_outside_its_quoted_fields() {
        // the commas inside quotes are text, so the semicolon is the separator
        assert_eq!(parse_csv("\"a,b\";c\n1;2\n"), vec![vec!["a,b", "c"], vec!["1", "2"]]);
        assert_eq!(parse_csv("\"x;y;z\",2\n"), vec![vec!["x;y;z", "2"]]);
        // a quote that is not at the start of a field is a character of it, and opens nothing
        assert_eq!(parse_csv("size 5\";name;price\n1;2;3\n"), vec![vec!["size 5\"", "name", "price"], vec!["1", "2", "3"]]);
        assert_eq!(parse_csv("a\"b,c\"\td\te\n"), vec![vec!["a\"b,c\"", "d", "e"]]);
        assert_eq!(parse_csv("\"a,\nb,c\"\td\n"), vec![vec!["a,\nb,c", "d"]], "a quoted line break does not end the first line");
        assert_eq!(parse_csv("\"say \"\"a,b,c\"\"\";2;3\n"), vec![vec!["say \"a,b,c\"", "2", "3"]]);
    }

    #[test]
    fn a_cdata_section_and_a_comment_are_read_as_what_they_are() {
        let page = |inner: &str| format!("<table:table table:name=\"s\"><table:table-row><table:table-cell><text:p>{inner}</text:p></table:table-cell></table:table-row></table:table>");
        let shown = |inner: &str| parse(&page(inner))[0].rows[0][0].clone();
        assert_eq!(shown("A<![CDATA[<raw> & ]]>B"), "A<raw> & B");
        assert_eq!(shown("A<!-- a > b -->B"), "AB");
        assert_eq!(shown("A<![CDATA[]]>"), "A");
        // cut off inside one, what came before is still read
        assert!(parse("<table:table table:name=\"s\"><table:table-row><table:table-cell><text:p>A<![CDATA[x").len() == 1);
        // and in the typed model, which reads a cell's text the same way
        let doc = format!("<office:document><office:body><office:spreadsheet>{}</office:spreadsheet></office:body></office:document>", page("A<![CDATA[<raw>]]>").replace("<table:table-cell>", "<table:table-cell office:value-type=\"string\">"));
        assert_eq!(book(&doc).unwrap().at(0, 0, 0).map(|c| c.text.clone()).as_deref(), Some("A<raw>"));
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
