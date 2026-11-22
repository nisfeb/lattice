//! How a cell's number is written: a port of the reading half of the web
//! client's `ui-src/sheet/styles.js`.
//!
//! Reads the document's cell styles and its number formats (data
//! styles), for the text kept in a cell that is typed into or worked
//! out again. LibreOffice rewrites that text from the value and the
//! style when it opens the page, so a format not known here only
//! degrades what lattice itself shows.

use std::collections::HashMap;

use crate::odf::{El, attrs, elements};
use crate::sheet::{self, general};

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// A number with fixed decimals, rounded half away from nothing on its decimal
/// spelling: 1.005 to two places is 1.01, as Calc shows it. The spelling is the
/// number's first fifteen figures, which is all Calc goes by, and the rounding is
/// done on those figures, so no number is pushed up by the sum that rounds it.
pub fn fixed(n: f64, places: usize, min_int: usize, group: bool) -> String {
    let places = places.min(20);
    let a = n.abs();
    // the figures before and after the point, rounded at `places`
    let text = if !a.is_finite() || a >= 1e15 || a == 0.0 {
        // nothing after the point is left to round in a number this large
        format!("{:.*}", places, if a.is_finite() { a } else { 0.0 })
    } else {
        let sci = format!("{a:.14e}");
        let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
        let exp: i32 = exp.parse().unwrap_or(0);
        let mut figures: Vec<u8> = mant.bytes().filter(u8::is_ascii_digit).map(|d| d - b'0').collect();
        // how many of the figures stand before the point, and how many are kept in all
        let mut whole = exp + 1;
        let keep = whole + places as i32;
        if keep < 0 {
            figures.clear();
        } else if (keep as usize) < figures.len() {
            let up = figures[keep as usize] >= 5;
            figures.truncate(keep as usize);
            if up {
                let mut at = figures.len();
                loop {
                    if at == 0 {
                        figures.insert(0, 1);
                        whole += 1;
                        break;
                    }
                    at -= 1;
                    if figures[at] < 9 {
                        figures[at] += 1;
                        break;
                    }
                    figures[at] = 0;
                }
            }
        }
        let at = |i: i32| char::from(b'0' + usize::try_from(i).ok().and_then(|i| figures.get(i)).copied().unwrap_or(0));
        let int: String = if whole > 0 { (0..whole).map(at).collect() } else { "0".to_owned() };
        format!("{int}.{}", (whole..whole + places as i32).map(at).collect::<String>())
    };
    let (i, d) = text.split_once('.').unwrap_or((&text, ""));
    let nought = !text.bytes().any(|c| (b'1'..=b'9').contains(&c));
    let mut i = format!("{i:0>w$}", w = min_int.min(64));
    if min_int == 0 && i == "0" {
        i.clear();
    }
    if group {
        let mut out = String::new();
        for (k, ch) in i.chars().enumerate() {
            if k > 0 && (i.len() - k) % 3 == 0 {
                out.push(',');
            }
            out.push(ch);
        }
        i = out;
    }
    format!("{}{i}{}", if n < 0.0 && !nought { "-" } else { "" }, if places > 0 { format!(".{d}") } else { String::new() })
}

/// One piece of a number format.
#[derive(Debug)]
enum Part {
    Text(String),
    /// `least` is how many of the decimal places are written even when they are noughts: `0.0##` has three places and one at least.
    Number { places: Option<usize>, least: usize, min_int: usize, group: bool, factor: f64 },
    Year(bool),
    Month { textual: bool, long: bool },
    Day(bool),
    DayOfWeek(bool),
    Hours(bool),
    Minutes(bool),
    /// Whether two figures at least, and how many decimals of a second.
    Seconds(bool, usize),
    AmPm,
    Boolean,
    Content,
}

/// A number format: what it is for, and its pieces in order.
#[derive(Debug)]
struct Format {
    /// The element's name: `number:date-style`, `number:percentage-style` and so on.
    kind: String,
    parts: Vec<Part>,
    am_pm: bool,
    /// Hours run past a day: 30:00:00 and not 06:00:00.
    long_hours: bool,
    /// It hands some numbers on to another format (`style:map`), as money does that writes
    /// what is owed in brackets: its own words are then for the numbers it keeps, the negative ones.
    mapped: bool,
    /// The formats it hands numbers on to, in order: which numbers, and the format's name.
    maps: Vec<(Cond, String)>,
}

/// Which numbers a format hands on to another: `value()>=0` and its like.
#[derive(Debug, Clone, Copy)]
struct Cond {
    op: &'static str,
    limit: f64,
}

impl Cond {
    fn read(text: &str) -> Option<Cond> {
        let rest = text.trim().strip_prefix("value()")?.trim_start();
        let op = [">=", "<=", "!=", ">", "<", "="].into_iter().find(|op| rest.starts_with(op))?;
        Some(Cond { op, limit: rest[op.len()..].trim().parse().ok()? })
    }

    fn holds(&self, v: f64) -> bool {
        match self.op {
            ">=" => v >= self.limit,
            "<=" => v <= self.limit,
            "!=" => v != self.limit,
            ">" => v > self.limit,
            "<" => v < self.limit,
            _ => v == self.limit,
        }
    }
}

fn attr<'a>(src: &'a str, el: &El, name: &str) -> Option<&'a str> {
    let tag = &src[el.start..el.open_end];
    attrs(tag).into_iter().find(|(k, _)| *k == name).map(|(_, at)| &tag[at])
}

fn kids(src: &str, el: &El) -> Vec<El> {
    let end = if src[el.start..el.open_end].ends_with("/>") { el.open_end } else { src[..el.end].rfind("</").unwrap_or(el.end) };
    elements(src, el.open_end, end).unwrap_or_default()
}

/// A number format's element as its pieces. `None` for one with a piece not known here.
fn compile(src: &str, el: &El) -> Option<Format> {
    let mut parts = Vec::new();
    let all = kids(src, el);
    let text = |k: &El| {
        let end = src[..k.end].rfind("</").unwrap_or(k.end);
        if k.open_end > end { String::new() } else { src[k.open_end..end].replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&") }
    };
    for k in &all {
        let long = attr(src, k, "number:style") == Some("long");
        parts.push(match k.name.as_str() {
            "number:text" | "number:currency-symbol" => Part::Text(text(k)),
            "number:number" => Part::Number {
                places: attr(src, k, "number:decimal-places").map(|d| d.parse().unwrap_or(0)),
                // with nothing said, every place is written
                least: attr(src, k, "number:min-decimal-places").map_or(usize::MAX, |d| d.parse().unwrap_or(0)),
                min_int: attr(src, k, "number:min-integer-digits").map_or(1, |d| d.parse().unwrap_or(1)),
                group: attr(src, k, "number:grouping") == Some("true"),
                factor: attr(src, k, "number:display-factor").and_then(|f| f.parse::<f64>().ok()).filter(|f| *f != 0.0).unwrap_or(1.0),
            },
            "number:year" => Part::Year(long),
            "number:month" => Part::Month { textual: attr(src, k, "number:textual") == Some("true"), long },
            "number:day" => Part::Day(long),
            "number:day-of-week" => Part::DayOfWeek(long),
            "number:hours" => Part::Hours(long),
            "number:minutes" => Part::Minutes(long),
            "number:seconds" => Part::Seconds(long, attr(src, k, "number:decimal-places").and_then(|d| d.parse().ok()).unwrap_or(0).min(9)),
            "number:am-pm" => Part::AmPm,
            "number:boolean" => Part::Boolean,
            "number:text-content" => Part::Content,
            "style:text-properties" | "style:map" => continue,
            _ => return None,
        });
    }
    if parts.is_empty() {
        return None;
    }
    // a map whose condition is not read hands nothing on, and the format is still known as one that maps
    let maps = all.iter().filter(|k| k.name == "style:map").filter_map(|k| Some((Cond::read(&attr(src, k, "style:condition")?.replace("&gt;", ">").replace("&lt;", "<"))?, attr(src, k, "style:apply-style-name")?.replace("&amp;", "&")))).collect();
    Some(Format { kind: el.name.clone(), am_pm: parts.iter().any(|p| matches!(p, Part::AmPm)), long_hours: attr(src, el, "number:truncate-on-overflow") == Some("false"), mapped: all.iter().any(|k| k.name == "style:map"), maps, parts })
}

/// A number of days as a whole number, held where the sums done on it cannot wrap: a number
/// past any calendar is the furthest day, not a near one.
fn day(n: f64) -> i64 {
    n.clamp(-1e15, 1e15) as i64
}

/// Digits at the start of a text, no more than `most`: the number, and the rest.
fn digits(t: &str, most: usize) -> Option<(i64, &str)> {
    let n = t.bytes().take(most).take_while(u8::is_ascii_digit).count();
    Some((t[..n].parse().ok()?, &t[n..]))
}

/// One of the names at the start of a text, whole or its first three letters, without
/// case: which it is, and the rest.
fn named<'a>(t: &'a str, names: &[&str], long: bool) -> Option<(usize, &'a str)> {
    names.iter().enumerate().find_map(|(i, name)| {
        let want = if long { name } else { &name[..3] };
        t.get(..want.len()).filter(|have| have.eq_ignore_ascii_case(want)).map(|_| (i, &t[want.len()..]))
    })
}

impl Format {
    /// The number a text is when it is written as this format writes one, or nothing when it
    /// is not: the other way round from `text`. Only whole dates, times, and plain numbers
    /// with the format's own words round them are read.
    fn read(&self, text: &str, null_date: f64) -> Option<f64> {
        let (mut y, mut mo, mut d, mut h, mut mi, mut s) = (None, None, None, None, None, None);
        let (mut num, mut pm, mut dow) = (None, None, None);
        let mut rest = text;
        for p in &self.parts {
            rest = match p {
                // the words between, a space of any kind standing for any other
                Part::Text(t) => {
                    let mut left = rest.chars();
                    let same = |a: char, b: char| a == b || (a.is_whitespace() && b.is_whitespace());
                    if !t.chars().all(|c| left.next().is_some_and(|x| same(c, x))) {
                        return None;
                    }
                    left.as_str()
                }
                Part::Number { group, factor, .. } => {
                    // the sign is written at the number, after any words before it: $-5.00
                    let (neg, body) = rest.strip_prefix('-').map_or((false, rest), |b| (true, b));
                    let b = body.as_bytes();
                    let mut n = 0;
                    while n < b.len() && (b[n].is_ascii_digit() || (*group && b[n] == b',')) {
                        n += 1;
                    }
                    // a comma is a group separator only where the format puts one: between groups of
                    // three, counted from the decimal point. 5,00 and 1,2,3 are not this format
                    let whole = &body[..n];
                    let mut groups = whole.split(',');
                    let lead = groups.next().is_some_and(|g| (1..=3).contains(&g.len()));
                    if whole.contains(',') && !(lead && groups.all(|g| g.len() == 3)) {
                        return None;
                    }
                    if b.get(n) == Some(&b'.') && b.get(n + 1).is_some_and(u8::is_ascii_digit) {
                        n += 1;
                        while n < b.len() && b[n].is_ascii_digit() {
                            n += 1;
                        }
                    }
                    let v: f64 = body[..n].replace(',', "").parse().ok()?;
                    num = Some(if neg { -v } else { v } * factor);
                    &body[n..]
                }
                Part::Year(long) => {
                    let (v, r) = digits(rest, 4)?;
                    // a year written in full is four digits. Where the pattern writes two, two are a year
                    // of the century round now, as Calc reads them: 30 to 99 in the 1900s
                    y = Some(match (rest.len() - r.len(), *long) {
                        (4, _) => v,
                        (2, false) => v + if v < 30 { 2000 } else { 1900 },
                        _ => return None,
                    });
                    r
                }
                Part::Month { textual: true, long } => {
                    let (i, r) = named(rest, &MONTHS, *long)?;
                    mo = Some(i as i64 + 1);
                    r
                }
                Part::Month { textual: false, .. } => {
                    let (v, r) = digits(rest, 2)?;
                    mo = Some(v);
                    r
                }
                Part::Day(_) => {
                    let (v, r) = digits(rest, 2)?;
                    d = Some(v);
                    r
                }
                // the day of the week is said by the date, and must be the date's own
                Part::DayOfWeek(long) => {
                    let (i, r) = named(rest, &DAYS, *long)?;
                    dow = Some(i as i64);
                    r
                }
                Part::Hours(_) => {
                    let (v, r) = digits(rest, if self.long_hours { 6 } else { 2 })?;
                    h = Some(v);
                    r
                }
                Part::Minutes(_) => {
                    let (v, r) = digits(rest, 2)?;
                    mi = Some(v);
                    r
                }
                Part::Seconds(..) => {
                    let (v, r) = digits(rest, 2)?;
                    s = Some(v);
                    r
                }
                Part::AmPm => {
                    let said = rest.get(..2)?;
                    pm = Some(if said.eq_ignore_ascii_case("PM") { true } else if said.eq_ignore_ascii_case("AM") { false } else { return None });
                    &rest[2..]
                }
                Part::Boolean | Part::Content => return None,
            };
        }
        if !rest.is_empty() {
            return None;
        }
        if let Some(n) = num {
            // a number with a date or a time beside it is no format read here
            let lone = y.is_none() && mo.is_none() && d.is_none() && h.is_none() && mi.is_none() && s.is_none();
            return lone.then_some(if self.kind == "number:percentage-style" { n / 100.0 } else { n });
        }
        let clock = match (h, mi, s) {
            (None, None, None) => None,
            (h, mi, s) => {
                let (mut h, mi, s) = (h.unwrap_or(0), mi.unwrap_or(0), s.unwrap_or(0));
                if mi > 59 || s > 59 || (!self.long_hours && h > 23) || (pm.is_some() && !(1..=12).contains(&h)) {
                    return None;
                }
                if let Some(pm) = pm {
                    h = h % 12 + if pm { 12 } else { 0 };
                }
                Some((h * 3600 + mi * 60 + s) as f64 / 86_400.0)
            }
        };
        match (y, mo, d) {
            (None, None, None) => clock.filter(|_| dow.is_none()),
            (Some(y), Some(mo), Some(d)) => {
                // a day the month has, in a year a page can hold, on the day of the week it was said to be.
                // 1970 began on a Thursday
                let days = sheet::days_from_civil(y, mo, d);
                let right_day = dow.is_none_or(|w| (days + 4).rem_euclid(7) == w);
                (sheet::civil_from_days(days) == (y, mo, d) && right_day).then(|| days as f64 - null_date + clock.unwrap_or(0.0))
            }
            // part of a date says no day
            _ => None,
        }
    }

    fn text(&self, v: f64, null_date: f64) -> String {
        let timed = self.kind == "number:date-style" || self.kind == "number:time-style";
        // a length of time that runs past a day is written by its size, with the sign before it: -9:36:00
        let span = self.kind == "number:time-style" && self.long_hours;
        let t = if span { v.abs() } else { v };
        // The seconds of the day, as LibreOffice reads them. A time of day is cut to the second it is in, never
        // rounded up to the next: 23:59:59.9 is 23:59:59 (`sheet::day_seconds`). A length of time is rounded
        // to the nearest second, or to the decimals of a second it shows
        let shown = self.parts.iter().find_map(|p| if let Part::Seconds(_, places) = p { Some(*places) } else { None }).unwrap_or(0);
        let (whole, secs) = if !timed {
            (t.floor(), 0.0)
        } else if span {
            let to = 10f64.powi(shown as i32);
            let secs = ((t - t.floor()) * 86_400.0 * to).round() / to;
            if secs >= 86_400.0 { (t.floor() + 1.0, secs - 86_400.0) } else { (t.floor(), secs) }
        } else {
            sheet::day_seconds(t)
        };
        let (y, m, d) = sheet::civil_from_days(day(whole) + null_date as i64);
        // 1970 began on a Thursday
        let dow = (day(whole) + null_date as i64 + 4).rem_euclid(7) as usize;
        let sod = secs.floor() as i64;
        // the first of hours, minutes and seconds that a length of time has takes all the days too
        let first = self.parts.iter().find(|p| matches!(p, Part::Hours(_) | Part::Minutes(_) | Part::Seconds(..))).filter(|_| self.long_hours);
        let days = day(whole);
        let (h, mi, sec) = match first {
            Some(Part::Hours(_)) => (sod / 3600 + days.saturating_mul(24), sod / 60 % 60, sod % 60),
            Some(Part::Minutes(_)) => (0, sod / 60 + days.saturating_mul(1440), sod % 60),
            Some(Part::Seconds(..)) => (0, 0, sod + days.saturating_mul(86_400)),
            _ => (sod / 3600, sod / 60 % 60, sod % 60),
        };
        let show = if self.kind == "number:percentage-style" { v * 100.0 } else { v };
        let two = |n: i64, long: bool| if long { format!("{n:02}") } else { n.to_string() };
        // a number is written by its size, and its sign goes before everything, the words and the symbol too: -$5.00
        let mut signed = span && v < 0.0 && (h, mi, sec) != (0, 0, 0);
        let mut number = |text: String| {
            signed |= text.starts_with('-');
            text.trim_start_matches('-').to_owned()
        };
        let mut out = String::new();
        for p in &self.parts {
            out.push_str(&match p {
                Part::Text(t) => t.clone(),
                Part::Number { places: None, factor, .. } => number(general(show / factor)),
                Part::Number { places: Some(d), least, min_int, group, factor } => {
                    let mut text = number(fixed(show / factor, *d, *min_int, *group));
                    // the decimal places that need not be written are not, when they are noughts
                    if least < d && text.contains('.') {
                        let cut = text.trim_end_matches('0').len().max(text.len().saturating_sub(d - least));
                        text.truncate(cut);
                        if text.ends_with('.') {
                            text.pop();
                        }
                    }
                    text
                }
                Part::Year(long) => if *long { y.to_string() } else { format!("{:02}", y.rem_euclid(100)) },
                Part::Month { textual: true, long } => if *long { MONTHS[m as usize - 1].to_owned() } else { MONTHS[m as usize - 1][..3].to_owned() },
                Part::Month { textual: false, long } => two(m, *long),
                Part::Day(long) => two(d, *long),
                Part::DayOfWeek(long) => if *long { DAYS[dow].to_owned() } else { DAYS[dow][..3].to_owned() },
                Part::Hours(long) => two(if self.am_pm { if h % 12 == 0 { 12 } else { h % 12 } } else { h }, *long),
                Part::Minutes(long) => two(mi, *long),
                // the decimals of a second are cut, as the second is
                Part::Seconds(long, 0) => two(sec, *long),
                Part::Seconds(long, places) => format!("{}.{:0>w$}", two(sec, *long), ((secs - secs.floor()) * 10f64.powi(*places as i32) + 1e-6).floor() as i64, w = *places),
                Part::AmPm => if h < 12 { "AM" } else { "PM" }.to_owned(),
                Part::Boolean => if show != 0.0 { "TRUE" } else { "FALSE" }.to_owned(),
                Part::Content => sheet::num_attr(show).replace('E', "e"),
            });
        }
        if signed { format!("-{out}") } else { out }
    }
}

/// A change to how a cell looks. A field left as `None` is not changed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Change {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    /// Left, centre or right, or `Some(None)` to take the alignment away.
    pub align: Option<Option<char>>,
    /// A number format by name, or `Some(None)` to take it away.
    pub data: Option<Option<String>>,
}

/// What a cell looks like, from its style.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Look {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    /// The text's colour and the cell's background, each as `#rrggbb`.
    pub color: Option<String>,
    pub bg: Option<String>,
    /// Left, centre, right or justified, when the style fixes it.
    pub align: Option<char>,
}

/// A length as the document writes one ("2.258cm") in points on screen.
fn px(len: &str) -> Option<f32> {
    let at = len.find(|c: char| c.is_ascii_alphabetic())?;
    let unit = match &len[at..] {
        "cm" => 37.795,
        "mm" => 3.7795,
        "in" => 96.0,
        "pt" => 1.3333,
        "pc" => 16.0,
        "px" => 1.0,
        _ => return None,
    };
    len[..at].parse::<f32>().ok().map(|n| n * unit)
}

/// A cell style's properties as written, each named by its element and attribute, and
/// anything else it holds, kept as text.
fn props_of(src: &str, k: &El) -> (Vec<(String, String)>, Vec<String>) {
    let (mut props, mut raws) = (Vec::new(), Vec::new());
    for p in kids(src, k) {
        if CELL_PROPS.contains(&p.name.as_str()) && kids(src, &p).is_empty() {
            let tag = &src[p.start..p.open_end];
            props.extend(attrs(tag).into_iter().map(|(a, at)| (format!("{}@{a}", p.name), tag[at].to_owned())));
        } else {
            raws.push(src[p.start..p.end].to_owned());
        }
    }
    (props, raws)
}

const CELL_PROPS: [&str; 3] = ["style:text-properties", "style:paragraph-properties", "style:table-cell-properties"];

/// The number formats lattice makes, one for each kind of value typed as such. The text is
/// the web client's own, so the name hashed from it is the same.
const DATA: [(&str, &str); 5] = [
    ("number", r#"<number:number-style style:name="NAME"><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>"#),
    ("percentage", r#"<number:percentage-style style:name="NAME"><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1"/><number:text>%</number:text></number:percentage-style>"#),
    ("currency", r#"<number:currency-style style:name="NAME"><number:currency-symbol number:language="en" number:country="US">$</number:currency-symbol><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:currency-style>"#),
    ("date", r#"<number:date-style style:name="NAME"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>"#),
    ("time", r#"<number:time-style style:name="NAME"><number:hours number:style="long"/><number:text>:</number:text><number:minutes number:style="long"/><number:text>:</number:text><number:seconds number:style="long"/></number:time-style>"#),
];

/// Eight hex digits of a text: FNV-1a over its UTF-16 units, as the web client hashes.
pub fn hash(s: &str) -> String {
    let h = s.encode_utf16().fold(0x811c_9dc5u32, |h, c| (h ^ u32::from(c)).wrapping_mul(0x0100_0193));
    format!("{h:08x}")
}

/// What a cell style says, in one text: its parent, its number format and every property,
/// sorted. Two styles with one key format alike.
fn key_of(parent: &str, data: &str, props: &[(String, String)], raws: &[String]) -> String {
    let mut parts = vec![format!("parent={parent}"), format!("data={data}")];
    parts.extend(props.iter().map(|(a, v)| format!("{a}={v}")));
    parts.extend(raws.iter().map(|r| format!("raw={r}")));
    parts.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    parts.join("\n")
}

/// A flat ODS document with new automatic styles at the end of the ones it has.
pub fn add_auto(src: &str, new: &[String]) -> Result<String, String> {
    if new.is_empty() {
        return Ok(src.to_owned());
    }
    let root = elements(src, 0, src.len())?.into_iter().find(|e| e.name == "office:document").ok_or("this is not a spreadsheet lattice can change")?;
    let all = kids(src, &root);
    let block = || format!("<office:automatic-styles>\n{} </office:automatic-styles>", new.iter().map(|s| format!("  {s}\n")).collect::<String>());
    Ok(match all.iter().find(|e| e.name == "office:automatic-styles") {
        Some(au) if !src[au.start..au.open_end].ends_with("/>") => {
            let at = src[..au.end].rfind("</").unwrap_or(au.end);
            format!("{}{}{}", &src[..at], new.iter().map(|s| format!(" {s}\n ")).collect::<String>(), &src[at..])
        }
        Some(au) => format!("{}{}{}", &src[..au.start], block(), &src[au.end..]),
        None => {
            let at = all.iter().find(|e| e.name == "office:body").ok_or("this is not a spreadsheet lattice can change")?.start;
            format!("{}{}\n {}", &src[..at], block(), &src[at..])
        }
    })
}

/// The cell styles and number formats of a spreadsheet page.
pub struct Styles {
    /// Each cell style's parent and its number format, when it names them.
    cell: HashMap<String, (Option<String>, Option<String>)>,
    /// Each automatic cell style as it is written: its properties, and what else it holds, kept as text.
    auto: HashMap<String, (Vec<(String, String)>, Vec<String>)>,
    /// Every cell style's properties as written, and the default style's under the empty name.
    props: HashMap<String, Vec<(String, String)>>,
    /// How wide each column style makes its columns, in points.
    widths: HashMap<String, f32>,
    /// Automatic cell styles by what they say: a new style that says the same is not made twice.
    by_key: HashMap<String, String>,
    /// The number format of cells with no style of their own, when the document sets one.
    default_data: Option<String>,
    /// Each number format: what it is for, and how it writes a number when lattice can read it.
    data: HashMap<String, (String, Option<Format>)>,
    null_date: f64,
}

impl Styles {
    /// The styles of a flat ODS document. One with none of its own gives every number its plain text.
    pub fn read(src: &str, null_date: f64) -> Styles {
        let mut s = Styles { cell: HashMap::new(), auto: HashMap::new(), props: HashMap::new(), widths: HashMap::new(), by_key: HashMap::new(), default_data: None, data: HashMap::new(), null_date };
        let Some(root) = elements(src, 0, src.len()).ok().and_then(|e| e.into_iter().find(|e| e.name == "office:document")) else { return s };
        for holder in kids(src, &root).iter().filter(|e| e.name == "office:styles" || e.name == "office:automatic-styles") {
            for k in kids(src, holder) {
                let own = |a: &str| attr(src, &k, a).map(|v| v.replace("&amp;", "&"));
                match k.name.as_str() {
                    "style:style" if attr(src, &k, "style:family") == Some("table-cell") => {
                        if let Some(name) = own("style:name") {
                            let (parent, data) = (own("style:parent-style-name"), own("style:data-style-name"));
                            let (props, raws) = props_of(src, &k);
                            s.props.insert(name.clone(), props.clone());
                            if holder.name == "office:automatic-styles" {
                                s.by_key.insert(key_of(parent.as_deref().unwrap_or(""), data.as_deref().unwrap_or(""), &props, &raws), name.clone());
                                s.auto.insert(name.clone(), (props, raws));
                            }
                            s.cell.insert(name, (parent, data));
                        }
                    }
                    "style:default-style" if attr(src, &k, "style:family") == Some("table-cell") => {
                        s.default_data = own("style:data-style-name");
                        s.props.insert(String::new(), props_of(src, &k).0);
                    }
                    "style:style" if attr(src, &k, "style:family") == Some("table-column") => {
                        let inner = kids(src, &k).into_iter().find(|p| p.name == "style:table-column-properties");
                        let wide = inner.as_ref().and_then(|p| attr(src, p, "style:column-width")).or_else(|| attr(src, &k, "style:column-width")).and_then(px);
                        if let (Some(name), Some(w)) = (own("style:name"), wide) {
                            s.widths.insert(name, w);
                        }
                    }
                    n if n.starts_with("number:") => {
                        if let Some(name) = own("style:name") {
                            s.data.insert(name, (k.name.clone(), compile(src, &k)));
                        }
                    }
                    _ => {}
                }
            }
        }
        s
    }

    /// The number format in force for a cell style, its parents followed.
    fn data_of(&self, style: &str) -> Option<&str> {
        let (mut name, mut hops) = (style, 0);
        while let Some((parent, data)) = self.cell.get(name) {
            if let Some(d) = data {
                return Some(d);
            }
            hops += 1;
            match parent {
                Some(p) if hops < 64 => name = p,
                _ => break,
            }
        }
        self.default_data.as_deref()
    }

    /// What a cell style looks like, its parents and the default style folded in.
    pub fn look(&self, style: &str) -> Look {
        let mut chain = Vec::new();
        let mut name = style;
        while let Some((parent, _)) = self.cell.get(name).filter(|_| chain.len() < 64) {
            chain.push(name);
            match parent {
                Some(p) => name = p,
                None => break,
            }
        }
        chain.push("");
        let mut out = Look::default();
        // the default first, the style itself last, so the nearer one has the last word
        for name in chain.into_iter().rev() {
            for (a, v) in self.props.get(name).into_iter().flatten() {
                let hex = v.len() == 7 && v.starts_with('#') && v[1..].bytes().all(|b| b.is_ascii_hexdigit());
                match a.as_str() {
                    "style:text-properties@fo:font-weight" => out.bold = v == "bold" || v.parse::<f64>().is_ok_and(|w| w >= 600.0),
                    "style:text-properties@fo:font-style" => out.italic = v == "italic" || v == "oblique",
                    "style:text-properties@style:text-underline-style" => out.underline = v != "none",
                    "style:text-properties@style:text-line-through-style" => out.strike = v != "none",
                    "style:text-properties@fo:color" if hex => out.color = Some(v.clone()),
                    "style:paragraph-properties@fo:text-align" => {
                        out.align = Some(match v.as_str() {
                            "end" | "right" => 'r',
                            "center" => 'c',
                            "justify" => 'j',
                            _ => 'l',
                        });
                    }
                    "style:table-cell-properties@fo:background-color" => out.bg = hex.then(|| v.clone()),
                    _ => {}
                }
            }
            // the cell's own kind of value says where it sits: a number to the right, text to the left
            if self.props.get(name).into_iter().flatten().any(|(a, v)| a == "style:table-cell-properties@style:text-align-source" && v == "value-type") {
                out.align = None;
            }
        }
        out
    }

    /// How wide a column style makes its columns, in points, when it says.
    pub fn col_width(&self, style: &str) -> Option<f32> {
        self.widths.get(style).copied()
    }

    /// The name of a number format of one of lattice's kinds (`number`, `percentage`,
    /// `currency`, `date`, `time`), and its text to add to the page when the page has none.
    /// A format is named by a hash of what it holds, as the web client names it.
    pub fn format_for(&self, kind: &str) -> Option<(String, Option<String>)> {
        let (_, xml) = DATA.iter().find(|(k, _)| *k == kind)?;
        let name = format!("Ln{}", hash(xml));
        let new = (!self.data.contains_key(&name)).then(|| xml.replace("NAME", &name));
        Some((name, new))
    }

    /// The name of a cell style that is `base` with a number format for `kind`, and the
    /// styles to add to the page for it: none when the page already has them.
    pub fn with_format(&self, base: &str, kind: &str) -> (String, Vec<String>) {
        let Some((data, new)) = self.format_for(kind) else { return (base.to_owned(), Vec::new()) };
        let (name, more) = self.restyle(base, &Change { data: Some(Some(data)), ..Change::default() });
        (name, new.into_iter().chain(more).collect())
    }

    /// The name of a cell style that is `base` with `change` applied, and its text to add to
    /// the page when the page has no style that says the same. A port of the web client's
    /// `restyle`: a named style becomes the parent of the new one, an automatic style is
    /// copied with its own parent, and the new style is named by a hash of what it holds.
    pub fn restyle(&self, base: &str, change: &Change) -> (String, Vec<String>) {
        // already so: the style it has, whatever attributes spell it
        let now = self.look(base);
        let same = change.bold.is_none_or(|b| b == now.bold)
            && change.italic.is_none_or(|b| b == now.italic)
            && change.underline.is_none_or(|b| b == now.underline)
            && change.align.is_none_or(|a| a == now.align)
            && change.data.as_ref().is_none_or(|d| d.as_deref() == self.data_of(base));
        if same {
            return (base.to_owned(), Vec::new());
        }
        let own = self.auto.get(base);
        let (parent, mut data, mut props, raws) = match (own, self.cell.get(base)) {
            (Some((props, raws)), Some((parent, data))) => (parent.clone().unwrap_or_else(|| "Default".to_owned()), data.clone(), props.clone(), raws.clone()),
            (None, Some(_)) => (base.to_owned(), None, Vec::new(), Vec::new()),
            _ => ("Default".to_owned(), None, Vec::new(), Vec::new()),
        };
        // a property set where it is, added after the others of its element, or taken away
        let mut set = |name: &str, val: Option<&str>| {
            let at = props.iter().position(|(a, _)| a == name);
            match (at, val) {
                (Some(i), Some(v)) => props[i].1 = v.to_owned(),
                (Some(i), None) => drop(props.remove(i)),
                (None, Some(v)) => props.push((name.to_owned(), v.to_owned())),
                (None, None) => {}
            }
        };
        const TP: &str = "style:text-properties@";
        if let Some(on) = change.bold {
            for a in ["fo:font-weight", "style:font-weight-asian", "style:font-weight-complex"] {
                set(&format!("{TP}{a}"), on.then_some("bold"));
            }
        }
        if let Some(on) = change.italic {
            for a in ["fo:font-style", "style:font-style-asian", "style:font-style-complex"] {
                set(&format!("{TP}{a}"), on.then_some("italic"));
            }
        }
        if let Some(on) = change.underline {
            for (a, v) in [("style:text-underline-style", "solid"), ("style:text-underline-width", "auto"), ("style:text-underline-color", "font-color")] {
                set(&format!("{TP}{a}"), on.then_some(v));
            }
        }
        if let Some(align) = change.align {
            let v = align.map(|a| match a {
                'r' => "end",
                'l' => "start",
                'c' => "center",
                _ => "justify",
            });
            set("style:paragraph-properties@fo:text-align", v);
            set("style:table-cell-properties@style:text-align-source", v.map(|_| "fix"));
            set("style:table-cell-properties@style:repeat-content", v.map(|_| "false"));
            if v.is_none() {
                set("style:paragraph-properties@fo:margin-left", None);
            }
        }
        if let Some(d) = &change.data {
            data = d.clone();
        }
        let mut body = String::new();
        for b in CELL_PROPS {
            let mine: Vec<String> = props.iter().filter_map(|(a, v)| a.strip_prefix(&format!("{b}@")).map(|a| format!(" {a}=\"{v}\""))).collect();
            if !mine.is_empty() {
                body.push_str(&format!("<{b}{}/>", mine.concat()));
            }
        }
        body.push_str(&raws.concat());
        // nothing left of it: the parent says it all
        if body.is_empty() && data.is_none() {
            return (parent, Vec::new());
        }
        let key = key_of(&parent, data.as_deref().unwrap_or(""), &props, &raws);
        // nothing changed: the style it already has, not a twin of it
        if let (Some((was, was_raws)), Some((was_parent, was_data))) = (own, self.cell.get(base)) {
            if key == key_of(was_parent.as_deref().unwrap_or(""), was_data.as_deref().unwrap_or(""), was, was_raws) {
                return (base.to_owned(), Vec::new());
            }
        }
        if let Some(have) = self.by_key.get(&key) {
            return (have.clone(), Vec::new());
        }
        let name = format!("Lce{}", hash(&key));
        let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;");
        let data = data.map_or(String::new(), |d| format!(" style:data-style-name=\"{}\"", esc(&d)));
        (name.clone(), vec![format!("<style:style style:name=\"{name}\" style:family=\"table-cell\" style:parent-style-name=\"{}\"{data}{}", esc(&parent), if body.is_empty() { "/>".to_owned() } else { format!(">{body}</style:style>") })])
    }

    /// Whether a cell style has a number format, its own or one it takes from a parent.
    pub fn formatted(&self, style: &str) -> bool {
        self.data_of(style).is_some()
    }

    /// What a cell style's number format is for: `percentage`, `currency`, `date` or
    /// `time`, as a cell's value type names them, or nothing for a plain number.
    pub fn kind(&self, style: &str) -> Option<&'static str> {
        match self.data.get(self.data_of(style)?)?.0.as_str() {
            "number:percentage-style" => Some("percentage"),
            "number:currency-style" => Some("currency"),
            "number:date-style" => Some("date"),
            "number:time-style" => Some("time"),
            _ => None,
        }
    }

    /// The number a text is when it is written as a cell style's number format writes one: a
    /// date in the format's own order, money with its symbol. Nothing when the style has no
    /// format read here, or the text is not written its way.
    pub fn read_as(&self, style: &str, text: &str) -> Option<f64> {
        let (_, Some(f)) = self.data.get(self.data_of(style)?)? else { return None };
        // which of its formats wrote a text is not followed here, and its brackets or its sign
        // would be taken for words: what is typed stays the text it is
        if f.mapped {
            return None;
        }
        // the sign goes before everything, the symbol too
        let (neg, body) = text.strip_prefix('-').map_or((false, text), |b| (true, b));
        let timed = f.kind == "number:date-style" || f.kind == "number:time-style";
        f.read(text, self.null_date).or_else(|| f.read(body, self.null_date).filter(|n| neg && !timed && *n >= 0.0).map(|n| -n))
    }

    /// A number as a format writes it, through the format it hands that number on to when
    /// it has such (`style:map`): the first whose condition holds, and else its own words.
    /// LibreOffice writes `0.00;(0.00)` as a format for the negative numbers, brackets and
    /// all, that hands the others on. The form that only negative numbers come to writes
    /// the number's size, its sign being in its words. Nothing when a format it names is
    /// not one read here.
    fn mapped(&self, f: &Format, v: f64) -> Option<String> {
        let Some((cond, name)) = f.maps.iter().find(|(c, _)| c.holds(v)) else {
            // its own words: for the negative numbers when the others are handed on
            let owed = f.maps.iter().any(|(c, _)| matches!(c.op, ">=" | ">") && c.limit == 0.0);
            return Some(f.text(if owed { v.abs() } else { v }, self.null_date));
        };
        let (_, Some(to)) = self.data.get(name)? else { return None };
        let owed = matches!((cond.op, cond.limit), ("<", l) if l <= 0.0) || matches!((cond.op, cond.limit), ("<=", l) if l < 0.0);
        Some(to.text(if owed { v.abs() } else { v }, self.null_date))
    }

    /// The text a number shows in a cell of this style and value type.
    pub fn text(&self, style: &str, v: f64, vt: &str) -> String {
        // a day number no calendar date stands for is shown as the number it is, not as a date made up for it
        let format = self.data_of(style).and_then(|d| self.data.get(d));
        if (vt == "date" || format.is_some_and(|(kind, _)| kind == "number:date-style")) && !sheet::dated(v, self.null_date) {
            return general(v);
        }
        // money in the format lattice makes shows its sign before the symbol, as the web client writes it
        if v < 0.0 && self.data_of(style).is_some_and(|d| DATA.iter().any(|(k, xml)| *k == "currency" && d == format!("Ln{}", hash(xml)))) {
            return format!("-${}", fixed(v.abs(), 2, 1, true));
        }
        if let Some(text) = self.data_of(style).and_then(|d| self.data.get(d)).and_then(|(_, f)| self.mapped(f.as_ref()?, v)) {
            return text;
        }
        // a format not read here: something sensible for the kind of value
        match vt {
            "percentage" => fixed(v * 100.0, 2, 1, false) + "%",
            "date" => {
                let (y, m, d) = sheet::civil_from_days(day((v + 1e-9).floor()) + self.null_date as i64);
                format!("{y}-{m:02}-{d:02}")
            }
            "time" => {
                let s = ((v - v.floor()) * 86_400.0 + 0.5).floor() as i64;
                format!("{:02}:{:02}:{:02}", s / 3600 + day(v.floor()) * 24, s / 60 % 60, s % 60)
            }
            "currency" => fixed(v, 2, 1, true),
            _ => general(v),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_style_looks_as_the_web_client_reads_it() {
        // each line is a style of the fixture and its look as ui-src/sheet/styles.js lookOf gives it, from node:
        // bold, italic, underline, struck, colour, background, alignment
        let src = include_str!("looks_fixture.fods");
        let s = Styles::read(src, -25_569.0);
        let got: Vec<String> = include_str!("looks_expected.txt").lines().map(|line| {
            let name = line.split(' ').next().unwrap();
            let l = s.look(name);
            format!("{name} {} {} {} {} {} {} {}", l.bold, l.italic, l.underline, l.strike, l.color.as_deref().unwrap_or("-"), l.bg.as_deref().unwrap_or("-"), l.align.map_or("-".to_owned(), String::from))
        }).collect();
        assert_eq!(got.join("\n"), include_str!("looks_expected.txt").trim_end());
        // a column is as wide as its style says: 5cm and 1.6cm at 96 to the inch
        assert!((s.col_width("co1").unwrap() - 188.98).abs() < 0.01 && (s.col_width("co2").unwrap() - 60.47).abs() < 0.01);
        assert_eq!(s.col_width("nope"), None);
        // a row is found by where its run starts, through repeats
        let book = crate::sheet::book(src).unwrap();
        assert_eq!((book.style_at(0, 3, 0), book.style_at(0, 12, 2), book.style_at(0, 99, 0)), ("ce21".to_owned(), "nope".to_owned(), "Default".to_owned()));
    }

    #[test]
    fn numbers_are_written_as_libreoffice_writes_them() {
        // a file LibreOffice wrote: 29 numbers down, a number format to each column, each cell with the text
        // LibreOffice showed for it. The formats, in the columns' order, by what they are in its own spelling
        const FORMATS: [&str; 37] = [
            "[$$-409]#,##0.00;[RED]-[$$-409]#,##0.00", "$#,##0.00;($#,##0.00)", "$#,##0.00", "#,##0.00 [$\u{20ac}-407]", "0.00%", "0%", "#,##0.00", "0", "0.0##", "0.##", "000", ".00", "#,##0.0,", "0.0\" kg\"", "0.00E+00", "# ?/?",
            "#,##0.00;[RED]-#,##0.00", "#,##0;(#,##0)", "0.0\" up\";0.0\" down\";\"zero\"", "YYYY-MM-DD", "MM/DD/YY", "M/D/YYYY", "DDDD, MMMM D, YYYY", "D MMM YY", "DDD DD", "QQ YYYY", "WW", "MM/DD/YYYY HH:MM:SS", "HH:MM:SS", "HH:MM AM/PM",
            "H:MM:SS AM/PM", "[H]:MM:SS", "MM:SS.00", "HH:MM", "[M]:SS", "BOOLEAN", "@",
        ];
        // a format with a piece not read here is not written its way: scientific, a fraction, the quarter, the week
        let unread = [14, 15, 25, 26];
        let src = include_str!("lo_formats.fods");
        let book = sheet::book(src).unwrap();
        let styles = Styles::read(src, book.null_date);
        let (mut same, mut wrong) = (0, Vec::new());
        for r in 0..40 {
            for (c, format) in FORMATS.iter().enumerate().filter(|(c, _)| !unread.contains(c)) {
                let Some((cell, v)) = book.at(0, r, c).and_then(|cell| if let Some(sheet::Val::Num(v)) = cell.v { Some((cell, v)) } else { None }) else { continue };
                // a day LibreOffice has no date for, which it says so of, and a number of days past what it reads a time of day from
                if cell.text == "#FMT" || v.abs() > 1e7 {
                    continue;
                }
                let style = book.style_at(0, r, c);
                let ours = styles.text(&style, v, &cell.vt);
                if ours == cell.text {
                    same += 1;
                } else {
                    wrong.push(format!("{v} as {format} is {:?} here and {:?} there", ours, cell.text));
                }
                // and the text, read back through the format, is a number that is written the same
                if let Some(back) = styles.read_as(&style, &cell.text) {
                    let again = styles.text(&style, back, &cell.vt);
                    if again != cell.text {
                        wrong.push(format!("{:?} as {format} is read as {back}, which is written {again:?}", cell.text));
                    }
                }
            }
        }
        assert!(wrong.is_empty(), "{} differ:\n{}", wrong.len(), wrong.join("\n"));
        assert!(same > 850, "only {same} cells were compared");
    }

    #[test]
    fn a_number_is_fixed_as_calc_fixes_it() {
        // what ui-src/sheet/styles.js fixed gives
        for (n, places, min_int, group, want) in [
            (1.005, 2, 1, false, "1.01"), (2.5, 0, 1, false, "3"), (-2.5, 0, 1, false, "-3"), (1234567.891, 2, 1, true, "1,234,567.89"), (0.5, 2, 0, false, ".50"), (0.0, 2, 0, false, ".00"),
            (-0.001, 2, 1, false, "0.00"), (7.0, 0, 3, false, "007"), (999.995, 2, 1, true, "1,000.00"), (123.0, 0, 1, true, "123"), (1234.0, 0, 1, true, "1,234"), (-1234.5, 1, 1, true, "-1,234.5"), (0.125, 2, 1, false, "0.13"),
        ] {
            assert_eq!(fixed(n, places, min_int, group), want, "{n} {places} {min_int} {group}");
        }
        // a large number gains nothing from the sum that rounds it, and a small one is not lost in it
        for (n, places, min_int, group, want) in [
            (1e15, 2, 1, true, "1,000,000,000,000,000.00"), (1e15, 0, 1, false, "1000000000000000"), (1e13, 2, 1, false, "10000000000000.00"), (999_999_999_999.994, 2, 1, false, "999999999999.99"), (123_456_789_012.2, 0, 1, false, "123456789012"),
            (-1e15, 1, 1, false, "-1000000000000000.0"), (1e21, 0, 1, false, "1000000000000000000000"),
            (2.675, 2, 1, false, "2.68"), (9.995, 2, 1, false, "10.00"), (99.5, 0, 1, false, "100"), (0.999, 2, 1, false, "1.00"), (0.994, 2, 1, false, "0.99"), (0.004, 2, 1, false, "0.00"), (0.005, 2, 1, false, "0.01"), (-0.005, 2, 1, false, "-0.01"), (-0.004, 2, 1, false, "0.00"),
            (1e-20, 2, 1, false, "0.00"), (0.5, 0, 1, false, "1"), (0.4999, 0, 1, false, "0"), (0.05, 0, 1, false, "0"), (0.0, 0, 1, false, "0"), (5e-324, 3, 0, false, ".000"), (1.0049, 2, 1, false, "1.00"), (1.00499999999, 2, 1, false, "1.00"), (12.0, 3, 1, false, "12.000"), (0.1 + 0.2, 20, 1, false, "0.30000000000000000000"),
            (f64::NAN, 2, 1, false, "0.00"), (f64::INFINITY, 1, 1, false, "0.0"),
        ] {
            assert_eq!(fixed(n, places, min_int, group), want, "{n} {places} {min_int} {group}");
        }
    }
}
