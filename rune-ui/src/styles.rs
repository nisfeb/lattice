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
/// spelling: 1.005 to two places is 1.01, as Calc shows it.
pub fn fixed(n: f64, places: usize, min_int: usize, group: bool) -> String {
    let f = 10f64.powi(places as i32);
    let a = ((n.abs() * f * (1.0 + 4.0 * f64::EPSILON)) + 0.5).floor() / f;
    let text = format!("{a:.*}", places.min(20));
    let (i, d) = text.split_once('.').unwrap_or((&text, ""));
    let mut i = format!("{i:0>min_int$}");
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
    format!("{}{i}{}", if n < 0.0 && a != 0.0 { "-" } else { "" }, if places > 0 { format!(".{d}") } else { String::new() })
}

/// One piece of a number format.
#[derive(Debug)]
enum Part {
    Text(String),
    Number { places: Option<usize>, min_int: usize, group: bool, factor: f64 },
    Year(bool),
    Month { textual: bool, long: bool },
    Day(bool),
    DayOfWeek(bool),
    Hours(bool),
    Minutes(bool),
    Seconds(bool),
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
            "number:seconds" => Part::Seconds(long),
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
    Some(Format { kind: el.name.clone(), am_pm: parts.iter().any(|p| matches!(p, Part::AmPm)), long_hours: attr(src, el, "number:truncate-on-overflow") == Some("false"), parts })
}

impl Format {
    fn text(&self, v: f64, null_date: f64) -> String {
        let timed = self.kind == "number:date-style" || self.kind == "number:time-style";
        let whole = (v + 1e-9).floor();
        let secs = if timed { ((v - whole) * 86_400.0 + 0.5).floor() as i64 } else { 0 };
        let (y, m, d) = sheet::civil_from_days(whole as i64 + null_date as i64 + i64::from(secs >= 86_400));
        // 1970 began on a Thursday
        let dow = (whole as i64 + null_date as i64 + i64::from(secs >= 86_400) + 4).rem_euclid(7) as usize;
        let sod = secs % 86_400;
        let (h, mi, s) = (sod / 3600 + if self.long_hours { whole as i64 * 24 } else { 0 }, sod / 60 % 60, sod % 60);
        let show = if self.kind == "number:percentage-style" { v * 100.0 } else { v };
        let two = |n: i64, long: bool| if long { format!("{n:02}") } else { n.to_string() };
        let mut out = String::new();
        for p in &self.parts {
            out.push_str(&match p {
                Part::Text(t) => t.clone(),
                Part::Number { places: None, factor, .. } => general(show / factor),
                Part::Number { places: Some(d), min_int, group, factor } => fixed(show / factor, *d, *min_int, *group),
                Part::Year(long) => if *long { y.to_string() } else { format!("{:02}", y.rem_euclid(100)) },
                Part::Month { textual: true, long } => if *long { MONTHS[m as usize - 1].to_owned() } else { MONTHS[m as usize - 1][..3].to_owned() },
                Part::Month { textual: false, long } => two(m, *long),
                Part::Day(long) => two(d, *long),
                Part::DayOfWeek(long) => if *long { DAYS[dow].to_owned() } else { DAYS[dow][..3].to_owned() },
                Part::Hours(long) => two(if self.am_pm { if h % 12 == 0 { 12 } else { h % 12 } } else { h }, *long),
                Part::Minutes(long) => two(mi, *long),
                Part::Seconds(long) => two(s, *long),
                Part::AmPm => if h < 12 { "AM" } else { "PM" }.to_owned(),
                Part::Boolean => if show != 0.0 { "TRUE" } else { "FALSE" }.to_owned(),
                Part::Content => sheet::num_attr(show).replace('E', "e"),
            });
        }
        out
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

    /// The text a number shows in a cell of this style and value type.
    pub fn text(&self, style: &str, v: f64, vt: &str) -> String {
        // money in the format lattice makes shows its sign before the symbol, as the web client writes it
        if v < 0.0 && self.data_of(style).is_some_and(|d| DATA.iter().any(|(k, xml)| *k == "currency" && d == format!("Ln{}", hash(xml)))) {
            return format!("-${}", fixed(v.abs(), 2, 1, true));
        }
        if let Some((_, Some(f))) = self.data_of(style).and_then(|d| self.data.get(d)) {
            return f.text(v, self.null_date);
        }
        // a format not read here: something sensible for the kind of value
        match vt {
            "percentage" => fixed(v * 100.0, 2, 1, false) + "%",
            "date" => {
                let (y, m, d) = sheet::civil_from_days((v + 1e-9).floor() as i64 + self.null_date as i64);
                format!("{y}-{m:02}-{d:02}")
            }
            "time" => {
                let s = ((v - v.floor()) * 86_400.0 + 0.5).floor() as i64;
                format!("{:02}:{:02}:{:02}", s / 3600 + v.floor() as i64 * 24, s / 60 % 60, s % 60)
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
    fn a_number_is_fixed_as_calc_fixes_it() {
        // what ui-src/sheet/styles.js fixed gives
        for (n, places, min_int, group, want) in [
            (1.005, 2, 1, false, "1.01"), (2.5, 0, 1, false, "3"), (-2.5, 0, 1, false, "-3"), (1234567.891, 2, 1, true, "1,234,567.89"), (0.5, 2, 0, false, ".50"), (0.0, 2, 0, false, ".00"),
            (-0.001, 2, 1, false, "0.00"), (7.0, 0, 3, false, "007"), (999.995, 2, 1, true, "1,000.00"), (123.0, 0, 1, true, "123"), (1234.0, 0, 1, true, "1,234"), (-1234.5, 1, 1, true, "-1,234.5"), (0.125, 2, 1, false, "0.13"),
        ] {
            assert_eq!(fixed(n, places, min_int, group), want, "{n} {places} {min_int} {group}");
        }
    }
}
