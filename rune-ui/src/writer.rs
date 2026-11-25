//! Native Writer (`.fodt` / `.odt`) parser, style resolver, minimal-diff
//! serializer, HTML/PDF renderer, and `.odt` package exporter.
//!
//! A native Rust port of `ui-src/writer/` (`xml.js`, `styles.js`, `parse.js`,
//! `serialize.js`, `odt.js`, `print.js`, `view.js`). Untouched blocks copy
//! verbatim from their original source byte spans, automatic styles are
//! deduplicated by canonical key with the exact same `L<F><hash8>` FNV-1a
//! names as the web client, and paired LibreOffice markers (bookmarks,
//! reference marks, tracked changes, annotations) are guarded against
//! half-deletion.

use std::collections::{BTreeMap, HashMap, HashSet};

/// The blank LibreOffice Writer flat ODT template used when creating a new Writer document.
pub const BLANK_FODT: &str = include_str!("../../ui-src/writer/blank.fodt");

/// Tokenizer safety limits, matching `ui-src/writer/xml.js`.
pub const LIMIT_SIZE: usize = 8 * 1024 * 1024;
pub const LIMIT_DEPTH: usize = 256;
pub const LIMIT_ELEMENTS: usize = 200_000;
/// Maximum spaces `<text:s>` may expand to in one document (`parse.js::SPACES`).
pub const LIMIT_SPACES: usize = 1_000_000;

// ---------------------------------------------------------------- xml.js

#[derive(Clone, Debug)]
pub struct XmlEl {
    pub name: String,
    /// `(name, raw_double_quoted_value)` in source order.
    pub attrs: Vec<(String, String)>,
    pub start: usize,
    pub end: usize,
    pub open_end: usize,
    pub close_start: usize,
    pub kids: Vec<XmlNode>,
    pub empty: bool,
}

#[derive(Clone, Debug)]
pub enum XmlNode {
    El(XmlEl),
    Text { start: usize, end: usize, cdata: bool },
    Pi { start: usize, end: usize },
    Comment { start: usize, end: usize },
    Doctype { start: usize, end: usize },
}

impl XmlEl {
    pub fn attr(&self, name: &str) -> Option<String> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| decode(v))
    }

    pub fn elements(&self) -> impl Iterator<Item = &XmlEl> {
        self.kids.iter().filter_map(|k| match k {
            XmlNode::El(e) => Some(e),
            _ => None,
        })
    }

    pub fn child(&self, name: &str) -> Option<&XmlEl> {
        self.elements().find(|e| e.name == name)
    }
}

/// Decode the five XML entities and decimal/hex character references.
/// Unknown named entities stay untouched (no DTD expansion).
pub fn decode(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(rel) = s[i + 1..].find(';') {
                let ent = &s[i + 1..i + 1 + rel];
                let decoded = if let Some(rest) = ent.strip_prefix("#x") {
                    if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_hexdigit()) {
                        u32::from_str_radix(rest, 16).ok().filter(|&n| n > 0 && n <= 0x10_ffff && !(0xd800..=0xdfff).contains(&n)).and_then(char::from_u32)
                    } else {
                        None
                    }
                } else if let Some(rest) = ent.strip_prefix('#') {
                    if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) {
                        rest.parse::<u32>().ok().filter(|&n| n > 0 && n <= 0x10_ffff && !(0xd800..=0xdfff).contains(&n)).and_then(char::from_u32)
                    } else {
                        None
                    }
                } else {
                    match ent {
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "amp" => Some('&'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => None,
                    }
                };
                if let Some(ch) = decoded {
                    out.push(ch);
                    i += rel + 2;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn strip_not_xml(s: &str) -> String {
    s.chars()
        .filter(|&c| {
            let n = c as u32;
            !matches!(n, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0xfffe | 0xffff)
        })
        .collect()
}

/// Escape XML text content (`&`, `<`, `>`), stripping characters illegal in XML 1.0.
pub fn esc_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let n = c as u32;
        if matches!(n, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0xfffe | 0xffff) {
            continue;
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// Escape an XML double-quoted attribute value (`&`, `<`, `>`, `"`, `'`).
pub fn esc_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let n = c as u32;
        if matches!(n, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0xfffe | 0xffff) {
            continue;
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn is_name_byte(b: u8) -> bool {
    b > 32 && !matches!(b, b'=' | b'>' | b'/' | b'"' | b'\'')
}

fn is_ws_byte(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// Non-validating span-preserving XML tokenizer matching `ui-src/writer/xml.js`.
pub fn parse_xml(s: &str) -> Result<XmlEl, String> {
    if s.len() > LIMIT_SIZE {
        return Err("too large".into());
    }
    let bytes = s.as_bytes();
    let len = bytes.len();
    let mut stack: Vec<XmlEl> = vec![XmlEl {
        name: "#root".into(),
        attrs: Vec::new(),
        start: 0,
        end: len,
        open_end: 0,
        close_start: len,
        kids: Vec::new(),
        empty: false,
    }];
    let mut elem_count = 0usize;
    let mut i = 0usize;
    while i < len {
        let Some(rel_lt) = s[i..].find('<') else {
            stack.last_mut().unwrap().kids.push(XmlNode::Text { start: i, end: len, cdata: false });
            break;
        };
        let lt = i + rel_lt;
        if lt > i {
            stack.last_mut().unwrap().kids.push(XmlNode::Text { start: i, end: lt, cdata: false });
        }
        if lt + 1 >= len {
            return Err("not well-formed".into());
        }
        match bytes[lt + 1] {
            b'?' => {
                let Some(rel_end) = s[lt + 2..].find("?>") else { return Err("not well-formed".into()) };
                let e = lt + 2 + rel_end;
                stack.last_mut().unwrap().kids.push(XmlNode::Pi { start: lt, end: e + 2 });
                i = e + 2;
            }
            b'!' => {
                let after = &s[lt + 2..];
                if after.starts_with("--") {
                    let Some(rel_end) = s[lt + 4..].find("-->") else { return Err("not well-formed".into()) };
                    let e = lt + 4 + rel_end;
                    stack.last_mut().unwrap().kids.push(XmlNode::Comment { start: lt, end: e + 3 });
                    i = e + 3;
                } else if after.starts_with("[CDATA[") {
                    let Some(rel_end) = s[lt + 9..].find("]]>") else { return Err("not well-formed".into()) };
                    let e = lt + 9 + rel_end;
                    stack.last_mut().unwrap().kids.push(XmlNode::Text { start: lt, end: e + 3, cdata: true });
                    i = e + 3;
                } else if after.starts_with("DOCTYPE") {
                    let Some(rel_end) = s[lt + 9..].find('>') else { return Err("not well-formed".into()) };
                    let e = lt + 9 + rel_end;
                    if s[lt..e].contains('[') {
                        return Err("a DOCTYPE with an internal subset".into());
                    }
                    stack.last_mut().unwrap().kids.push(XmlNode::Doctype { start: lt, end: e + 1 });
                    i = e + 1;
                } else if after.starts_with("ENTITY") {
                    return Err("an entity declaration".into());
                } else {
                    return Err("a markup declaration".into());
                }
            }
            b'/' => {
                let Some(rel_end) = s[lt + 2..].find('>') else { return Err("not well-formed".into()) };
                let e = lt + 2 + rel_end;
                let name = s[lt + 2..e].trim();
                if stack.len() < 2 || stack.last().unwrap().name != name {
                    return Err("mismatched end tag".into());
                }
                let mut closed = stack.pop().unwrap();
                closed.close_start = lt;
                closed.end = e + 1;
                stack.last_mut().unwrap().kids.push(XmlNode::El(closed));
                i = e + 1;
            }
            _ => {
                let mut j = lt + 1;
                while j < len && is_name_byte(bytes[j]) {
                    j += 1;
                }
                let name = s[lt + 1..j].to_owned();
                if name.is_empty() {
                    return Err("not well-formed".into());
                }
                let mut attrs = Vec::new();
                loop {
                    while j < len && is_ws_byte(bytes[j]) {
                        j += 1;
                    }
                    if j >= len {
                        return Err("not well-formed".into());
                    }
                    if bytes[j] == b'>' || bytes[j] == b'/' {
                        break;
                    }
                    let a0 = j;
                    while j < len && is_name_byte(bytes[j]) {
                        j += 1;
                    }
                    let an = s[a0..j].to_owned();
                    if an.is_empty() {
                        return Err("not well-formed".into());
                    }
                    while j < len && is_ws_byte(bytes[j]) {
                        j += 1;
                    }
                    if j >= len || bytes[j] != b'=' {
                        return Err("not well-formed".into());
                    }
                    j += 1;
                    while j < len && is_ws_byte(bytes[j]) {
                        j += 1;
                    }
                    if j >= len || (bytes[j] != b'"' && bytes[j] != b'\'') {
                        return Err("not well-formed".into());
                    }
                    let q = bytes[j];
                    let qch = if q == b'"' { '"' } else { '\'' };
                    let Some(rel_q) = s[j + 1..].find(qch) else { return Err("not well-formed".into()) };
                    let e = j + 1 + rel_q;
                    let raw_slice = &s[j + 1..e];
                    if raw_slice.contains('<') {
                        return Err("not well-formed".into());
                    }
                    let raw = if q == b'\'' { raw_slice.replace('"', "&quot;") } else { raw_slice.to_owned() };
                    attrs.push((an, raw));
                    j = e + 1;
                }
                elem_count += 1;
                if elem_count > LIMIT_ELEMENTS {
                    return Err("too many elements".into());
                }
                let empty = bytes[j] == b'/';
                if empty && (j + 1 >= len || bytes[j + 1] != b'>') {
                    return Err("not well-formed".into());
                }
                let open_end = if empty { j + 2 } else { j + 1 };
                let el = XmlEl {
                    name,
                    attrs,
                    start: lt,
                    end: open_end,
                    open_end,
                    close_start: open_end,
                    kids: Vec::new(),
                    empty,
                };
                if empty {
                    stack.last_mut().unwrap().kids.push(XmlNode::El(el));
                } else {
                    if stack.len() > LIMIT_DEPTH {
                        return Err("nested too deep".into());
                    }
                    stack.push(el);
                }
                i = open_end;
            }
        }
    }
    if stack.len() > 1 {
        return Err("not well-formed".into());
    }
    Ok(stack.pop().unwrap())
}

pub fn text_of(src: &str, el: &XmlEl) -> String {
    fn walk(src: &str, el: &XmlEl, out: &mut String) {
        for k in &el.kids {
            match k {
                XmlNode::El(e) => walk(src, e, out),
                XmlNode::Text { start, end, cdata } => {
                    if *cdata {
                        out.push_str(&src[*start + 9..*end - 3]);
                    } else {
                        out.push_str(&decode(&src[*start..*end]));
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = String::new();
    walk(src, el, &mut out);
    out
}

// ---------------------------------------------------------------- styles.js

#[derive(Clone, Debug, Default)]
pub struct FontDecl {
    pub family: Option<String>,
    pub generic: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct StyleRaw {
    pub inner: BTreeMap<String, String>,
    pub other: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct StyleEntry {
    pub name: String,
    pub family: String,
    pub parent: Option<String>,
    pub auto: bool,
    pub display: String,
    pub extra: Vec<(String, String)>,
    pub props: BTreeMap<String, BTreeMap<String, String>>,
    pub opaque: String,
    pub raw: StyleRaw,
    pub key: String,
}

#[derive(Clone, Debug, Default)]
pub struct PageLayout {
    pub width: Option<String>,
    pub height: Option<String>,
    pub margin_top: Option<String>,
    pub margin_bottom: Option<String>,
    pub margin_left: Option<String>,
    pub margin_right: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct StyleTable {
    pub styles: HashMap<(String, String), StyleEntry>,
    pub defaults: HashMap<String, StyleEntry>,
    pub fonts: HashMap<String, FontDecl>,
    pub lists: HashMap<String, &'static str>, // name -> "bullet" | "number"
    pub layouts: HashMap<String, BTreeMap<String, String>>,
    pub masters: Vec<(String, Option<String>)>,
    pub auto_keys: HashMap<String, String>,
    pub auto_names: HashSet<(String, String)>,
    pub auto_close: Option<usize>,
    pub auto_empty: Option<(usize, usize)>,
    pub auto_missing: bool,
    pub opaque_raw: HashMap<(String, String), StyleRaw>,
}

fn is_id_attr(k: &str) -> bool {
    matches!(k, "style:name" | "style:family" | "style:parent-style-name" | "style:display-name")
}

fn is_props_el(name: &str) -> bool {
    name.starts_with("style:")
        && name.ends_with("-properties")
        && name.len() > "style:-properties".len()
        && name["style:".len()..name.len() - "-properties".len()].bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
}

fn props_map(el: &XmlEl) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    for (k, v) in &el.attrs {
        m.insert(k.clone(), decode(v));
    }
    m
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

pub fn canonical_key(
    family: &str,
    parent: Option<&str>,
    extra: &[(String, String)],
    props: &BTreeMap<String, BTreeMap<String, String>>,
    opaque: &str,
) -> String {
    let mut ex: Vec<(&str, &str)> = extra.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    ex.sort_by(|a, b| a.0.cmp(b.0));
    let pe: Vec<(&str, Vec<(&str, &str)>)> = props
        .iter()
        .filter(|(_, m)| !m.is_empty())
        .map(|(k, m)| (k.as_str(), m.iter().map(|(ak, av)| (ak.as_str(), av.as_str())).collect()))
        .collect();
    serde_json::to_string(&(family, parent.unwrap_or(""), ex, pe, opaque)).unwrap_or_default()
}

/// FNV-1a 32-bit hash over UTF-16 code units, matching `ui-src/writer/styles.js::hash8`.
pub fn hash8(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for cu in s.encode_utf16() {
        h ^= u32::from(cu);
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

fn read_style_entry(src: &str, e: &XmlEl, auto: bool) -> StyleEntry {
    let family = e.attr("style:family").unwrap_or_default();
    let name = e.attr("style:name").unwrap_or_default();
    let parent = e.attr("style:parent-style-name").filter(|s| !s.is_empty());
    let display = e.attr("style:display-name").filter(|s| !s.is_empty()).unwrap_or_else(|| name.clone());
    let mut extra = Vec::new();
    for (k, v) in &e.attrs {
        if !is_id_attr(k) {
            extra.push((k.clone(), decode(v)));
        }
    }
    let mut pr = BTreeMap::new();
    let mut opaque = String::new();
    let mut raw = StyleRaw::default();
    for k in e.elements() {
        if is_props_el(&k.name) {
            pr.insert(k.name.clone(), props_map(k));
            if k.elements().next().is_some() {
                let inner = &src[k.open_end..k.close_start];
                opaque.push_str(&collapse_ws(inner));
                raw.inner.insert(k.name.clone(), inner.to_owned());
            }
        } else {
            let slice = &src[k.start..k.end];
            opaque.push_str(&collapse_ws(slice));
            raw.other.push(slice.to_owned());
        }
    }
    let key = canonical_key(&family, parent.as_deref(), &extra, &pr, &opaque);
    StyleEntry { name, family, parent, auto, display, extra, props: pr, opaque, raw, key }
}

pub fn read_styles(src: &str, doc: &XmlEl) -> StyleTable {
    let mut st = StyleTable { auto_missing: true, ..Default::default() };
    for sec in doc.elements() {
        match sec.name.as_str() {
            "office:font-face-decls" => {
                for f in sec.elements() {
                    if f.name == "style:font-face" {
                        if let Some(name) = f.attr("style:name") {
                            st.fonts.insert(name, FontDecl { family: f.attr("svg:font-family"), generic: f.attr("style:font-family-generic") });
                        }
                    }
                }
            }
            "office:styles" | "office:automatic-styles" => {
                let auto = sec.name == "office:automatic-styles";
                if auto {
                    st.auto_missing = false;
                    if sec.empty {
                        st.auto_empty = Some((sec.start, sec.end));
                    } else {
                        st.auto_close = Some(sec.close_start);
                    }
                }
                for e in sec.elements() {
                    match e.name.as_str() {
                        "style:style" => {
                            let entry = read_style_entry(src, e, auto);
                            if !entry.opaque.is_empty() {
                                st.opaque_raw.entry((entry.family.clone(), entry.opaque.clone())).or_insert_with(|| entry.raw.clone());
                            }
                            if auto {
                                st.auto_names.insert((entry.family.clone(), entry.name.clone()));
                                st.auto_keys.entry(entry.key.clone()).or_insert_with(|| entry.name.clone());
                            }
                            st.styles.insert((entry.family.clone(), entry.name.clone()), entry);
                        }
                        "style:default-style" => {
                            let entry = read_style_entry(src, e, false);
                            st.defaults.insert(entry.family.clone(), entry);
                        }
                        "text:list-style" => {
                            if let Some(name) = e.attr("style:name") {
                                if let Some(first) = e.elements().next() {
                                    if first.name == "text:list-level-style-number" {
                                        st.lists.insert(name, "number");
                                    } else if first.name == "text:list-level-style-bullet" {
                                        st.lists.insert(name, "bullet");
                                    }
                                }
                            }
                        }
                        "style:page-layout" => {
                            if let Some(name) = e.attr("style:name") {
                                let pr = e.child("style:page-layout-properties").map(props_map).unwrap_or_default();
                                st.layouts.insert(name, pr);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "office:master-styles" => {
                for m in sec.elements() {
                    if m.name == "style:master-page" {
                        st.masters.push((m.attr("style:name").unwrap_or_default(), m.attr("style:page-layout-name")));
                    }
                }
            }
            _ => {}
        }
    }
    st
}

impl StyleTable {
    pub fn lookup(&self, family: &str, name: &str) -> Option<&StyleEntry> {
        self.styles.get(&(family.to_owned(), name.to_owned()))
    }

    #[allow(dead_code)]
    pub fn is_auto(&self, family: &str, name: &str) -> bool {
        self.auto_names.contains(&(family.to_owned(), name.to_owned()))
    }

    pub fn resolve(&self, family: &str, name: Option<&str>, prop_el: &str) -> BTreeMap<String, String> {
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut cur = name.and_then(|n| self.lookup(family, n));
        while let Some(s) = cur {
            if !seen.insert(s.name.as_str()) || chain.len() >= 64 {
                break;
            }
            chain.push(s);
            cur = s.parent.as_deref().and_then(|p| self.lookup(family, p));
        }
        let mut out = BTreeMap::new();
        if let Some(d) = self.defaults.get(family) {
            if let Some(m) = d.props.get(prop_el) {
                for (k, v) in m {
                    out.insert(k.clone(), v.clone());
                }
            }
        }
        for s in chain.into_iter().rev() {
            if let Some(m) = s.props.get(prop_el) {
                for (k, v) in m {
                    out.insert(k.clone(), v.clone());
                }
            }
        }
        out
    }

    pub fn is_quote(&self, name: Option<&str>) -> bool {
        let Some(name) = name else { return false };
        let mut seen = HashSet::new();
        let mut cur = self.lookup("paragraph", name);
        while let Some(s) = cur {
            if s.name == "Quotations" {
                return true;
            }
            if !seen.insert(s.name.as_str()) {
                break;
            }
            cur = s.parent.as_deref().and_then(|p| self.lookup("paragraph", p));
        }
        name == "Quotations"
    }

    pub fn breaks_page(&self, name: Option<&str>) -> bool {
        name.is_some_and(|n| self.resolve("paragraph", Some(n), "style:paragraph-properties").get("fo:break-before").map(String::as_str) == Some("page"))
    }

    pub fn list_kind(&self, name: &str) -> Option<&'static str> {
        self.lists.get(name).copied()
    }

    pub fn named_styles(&self, family: &str) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .styles
            .values()
            .filter(|s| !s.auto && s.family == family)
            .map(|s| (s.name.clone(), s.display.clone()))
            .collect();
        out.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()).then(a.0.cmp(&b.0)));
        out
    }

    pub fn body_style(&self) -> Option<String> {
        if self.lookup("paragraph", "Text_20_body").is_some() {
            Some("Text_20_body".into())
        } else if self.lookup("paragraph", "Standard").is_some() {
            Some("Standard".into())
        } else {
            None
        }
    }

    pub fn heading_style(&self, level: u8) -> Option<String> {
        let n = format!("Heading_20_{level}");
        self.lookup("paragraph", &n).map(|_| n)
    }

    pub fn first_list_style(&self, kind: &str) -> Option<String> {
        let mut matches: Vec<&String> = self.lists.iter().filter(|(_, k)| **k == kind).map(|(n, _)| n).collect();
        matches.sort();
        matches.first().map(|s| (*s).clone())
    }

    pub fn page_layout(&self) -> PageLayout {
        let p = self
            .masters
            .first()
            .and_then(|(_, lay)| lay.as_deref())
            .and_then(|n| self.layouts.get(n));
        let len = |k: &str| p.and_then(|m| m.get(k)).and_then(|v| css_length(v, false, false));
        PageLayout {
            width: len("fo:page-width"),
            height: len("fo:page-height"),
            margin_top: len("fo:margin-top"),
            margin_bottom: len("fo:margin-bottom"),
            margin_left: len("fo:margin-left"),
            margin_right: len("fo:margin-right"),
        }
    }
}

struct StyleSpec<'a> {
    family: &'a str,
    parent: Option<&'a str>,
    extra: &'a [(String, String)],
    props: &'a BTreeMap<String, BTreeMap<String, String>>,
    opaque: &'a str,
}

struct AutoRegistry<'a> {
    st: &'a StyleTable,
    added: Vec<String>,
    added_keys: HashMap<String, String>,
    taken: HashSet<(String, String)>,
}

impl<'a> AutoRegistry<'a> {
    fn new(st: &'a StyleTable) -> Self {
        let taken = st.styles.keys().cloned().collect();
        AutoRegistry { st, added: Vec::new(), added_keys: HashMap::new(), taken }
    }

    fn ensure(&mut self, want: &StyleSpec<'_>, hint: Option<&str>) -> String {
        let key = canonical_key(want.family, want.parent, want.extra, want.props, want.opaque);
        if let Some(hname) = hint {
            if let Some(h) = self.st.lookup(want.family, hname) {
                if h.auto && h.key == key {
                    return hname.to_owned();
                }
            }
        }
        if let Some(have) = self.st.auto_keys.get(&key).or_else(|| self.added_keys.get(&key)) {
            return have.clone();
        }
        let letter = want.family.chars().next().unwrap_or('X').to_ascii_uppercase();
        let h8 = hash8(&key);
        let mut name = format!("L{letter}{h8}");
        let mut n = 2usize;
        while self.taken.contains(&(want.family.to_owned(), name.clone())) {
            name = format!("L{letter}{h8}-{n}");
            n += 1;
        }
        self.taken.insert((want.family.to_owned(), name.clone()));
        self.added_keys.insert(key, name.clone());
        let raw = if !want.opaque.is_empty() {
            self.st.opaque_raw.get(&(want.family.to_owned(), want.opaque.to_owned()))
        } else {
            None
        };
        self.added.push(auto_style_xml(&name, want, raw));
        name
    }
}

fn auto_style_xml(name: &str, want: &StyleSpec<'_>, raw: Option<&StyleRaw>) -> String {
    let mut at: Vec<(String, String)> = vec![("style:name".into(), name.into()), ("style:family".into(), want.family.into())];
    if let Some(p) = want.parent {
        if !p.is_empty() {
            at.push(("style:parent-style-name".into(), p.into()));
        }
    }
    let mut extra: Vec<(String, String)> = want.extra.to_vec();
    extra.sort_by(|a, b| a.0.cmp(&b.0));
    at.extend(extra);
    let mut open = String::from("<style:style");
    for (k, v) in &at {
        open.push(' ');
        open.push_str(k);
        open.push_str("=\"");
        open.push_str(&esc_attr(v));
        open.push('"');
    }
    let mut all_prop_keys: Vec<String> = want.props.keys().cloned().collect();
    if let Some(r) = raw {
        for k in r.inner.keys() {
            if !all_prop_keys.contains(k) {
                all_prop_keys.push(k.clone());
            }
        }
    }
    all_prop_keys.sort();
    let mut kids = Vec::new();
    for k in &all_prop_keys {
        let map = want.props.get(k);
        let inner = raw.and_then(|r| r.inner.get(k));
        if map.is_none_or(BTreeMap::is_empty) && inner.is_none() {
            continue;
        }
        let mut tag = format!("   <{k}");
        if let Some(m) = map {
            for (ak, av) in m {
                tag.push(' ');
                tag.push_str(ak);
                tag.push_str("=\"");
                tag.push_str(&esc_attr(av));
                tag.push('"');
            }
        }
        if let Some(inn) = inner {
            tag.push('>');
            tag.push_str(inn);
            tag.push_str("</");
            tag.push_str(k);
            tag.push('>');
        } else {
            tag.push_str("/>");
        }
        kids.push(tag);
    }
    if let Some(r) = raw {
        for o in &r.other {
            kids.push(format!("   {o}"));
        }
    }
    if kids.is_empty() {
        format!("  {open}/>\n")
    } else {
        format!("  {open}>\n{}\n  </style:style>\n", kids.join("\n"))
    }
}

// ---------------------------------------------------------------- whitelisted CSS

pub fn css_length(v: &str, pct: bool, neg: bool) -> Option<String> {
    let s = v.trim();
    let (sign, rest) = if let Some(r) = s.strip_prefix('-') {
        if !neg {
            return None;
        }
        ("-", r)
    } else {
        ("", s)
    };
    let unit = ["cm", "mm", "in", "pt", "pc", "px", "%"].iter().copied().find(|u| rest.ends_with(u))?;
    if unit == "%" && !pct {
        return None;
    }
    let num = &rest[..rest.len() - unit.len()];
    if num.is_empty() {
        return None;
    }
    let valid_num = if let Some((a, b)) = num.split_once('.') {
        !b.is_empty() && a.len() <= 6 && b.len() <= 6 && a.bytes().all(|x| x.is_ascii_digit()) && b.bytes().all(|x| x.is_ascii_digit())
    } else {
        num.len() <= 6 && num.bytes().all(|x| x.is_ascii_digit())
    };
    valid_num.then(|| format!("{sign}{num}{unit}"))
}

pub fn css_color(v: &str) -> Option<String> {
    let s = v.trim();
    if s == "transparent" {
        return Some("transparent".into());
    }
    if s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(s.to_ascii_lowercase());
    }
    None
}

fn font_name_safe(v: &str) -> Option<String> {
    let mut s = v.trim();
    if (s.starts_with('\'') && s.ends_with('\'') || s.starts_with('"') && s.ends_with('"')) && s.len() >= 2 {
        s = &s[1..s.len() - 1];
    }
    (!s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'-')).then(|| s.to_owned())
}

fn font_stack(st: &StyleTable, p: &BTreeMap<String, String>) -> Option<String> {
    let mut fam: Option<String> = None;
    let mut generic: Option<&'static str> = None;
    if let Some(fn_name) = p.get("style:font-name") {
        if let Some(f) = st.fonts.get(fn_name) {
            fam = f.family.as_deref().and_then(font_name_safe).or_else(|| font_name_safe(fn_name));
            generic = f.generic.as_deref().and_then(|g| match g {
                "roman" => Some("serif"),
                "swiss" | "system" => Some("sans-serif"),
                "modern" => Some("monospace"),
                "script" => Some("cursive"),
                "decorative" => Some("fantasy"),
                _ => None,
            });
        } else {
            fam = font_name_safe(fn_name);
        }
    }
    if fam.is_none() {
        fam = p.get("fo:font-family").and_then(|s| font_name_safe(s));
    }
    let fam = fam?;
    match fam.as_str() {
        "Liberation Serif" => Some("\"Liberation Serif\", \"Times New Roman\", Times, serif".into()),
        "Liberation Sans" => Some("\"Liberation Sans\", Arial, Helvetica, sans-serif".into()),
        "Liberation Mono" => Some("\"Liberation Mono\", \"Courier New\", Courier, monospace".into()),
        _ => Some(format!("\"{fam}\", {}", generic.unwrap_or("serif"))),
    }
}

pub fn css_from_props(st: &StyleTable, p: &BTreeMap<String, String>) -> String {
    let mut out = Vec::new();
    let mut put = |k: &str, v: Option<String>| {
        if let Some(val) = v {
            out.push(format!("{k}:{val}"));
        }
    };
    put("font-family", font_stack(st, p));
    put("font-size", p.get("fo:font-size").and_then(|v| css_length(v, true, false)));
    put("font-weight", p.get("fo:font-weight").filter(|v| matches!(v.as_str(), "normal" | "bold" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900")).cloned());
    put("font-style", p.get("fo:font-style").filter(|v| matches!(v.as_str(), "normal" | "italic" | "oblique")).cloned());
    put("color", p.get("fo:color").and_then(|v| css_color(v)));
    put("background-color", p.get("fo:background-color").and_then(|v| css_color(v)));
    for side in ["top", "bottom", "left", "right"] {
        let key = format!("fo:margin-{side}");
        put(&format!("margin-{side}"), p.get(&key).and_then(|v| css_length(v, true, true)));
    }
    put("text-indent", p.get("fo:text-indent").and_then(|v| css_length(v, true, true)));
    if let Some(lh) = p.get("fo:line-height") {
        put("line-height", if lh == "normal" { Some("normal".into()) } else { css_length(lh, true, false) });
    }
    if let Some(ta) = p.get("fo:text-align") {
        let mapped = match ta.as_str() {
            "start" => Some("left"),
            "end" => Some("right"),
            "left" | "right" | "center" | "justify" => Some(ta.as_str()),
            _ => None,
        };
        put("text-align", mapped.map(String::from));
    }
    let mut deco = Vec::new();
    if let Some(ul) = p.get("style:text-underline-style") {
        if !ul.is_empty() && ul != "none" && ul.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
            deco.push("underline");
        }
    }
    if let Some(lt) = p.get("style:text-line-through-style") {
        if !lt.is_empty() && lt != "none" && lt.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
            deco.push("line-through");
        }
    }
    if !deco.is_empty() {
        put("text-decoration", Some(deco.join(" ")));
    }
    put("text-transform", p.get("fo:text-transform").filter(|v| matches!(v.as_str(), "none" | "uppercase" | "lowercase" | "capitalize")).cloned());
    put("font-variant", p.get("fo:font-variant").filter(|v| matches!(v.as_str(), "normal" | "small-caps")).cloned());
    if let Some(ls) = p.get("fo:letter-spacing") {
        put("letter-spacing", if ls == "normal" { Some("normal".into()) } else { css_length(ls, false, true) });
    }
    out.join(";")
}

pub fn style_css(st: &StyleTable, family: &str, name: &str) -> String {
    let mut p = st.resolve(family, Some(name), "style:text-properties");
    if family == "paragraph" {
        for (k, v) in st.resolve(family, Some(name), "style:paragraph-properties") {
            p.insert(k, v);
        }
    }
    css_from_props(st, &p)
}

pub fn print_css(l: &PageLayout) -> String {
    fn m(v: &Option<String>) -> &str {
        v.as_deref().unwrap_or("2cm")
    }
    let size = match (&l.width, &l.height) {
        (Some(w), Some(h)) => format!("{w} {h}"),
        _ => "letter".into(),
    };
    format!(
        "@page{{size:{size};margin:{} {} {} {}}}\
         @media print{{html,body{{background:none}}.lw-sheet{{max-width:none!important;padding:0!important;box-shadow:none}}\
         .lw-doc .lw-pb{{break-before:page;border:0;margin:0;padding:0}}.lw-doc .lw-pb::before,.lw-doc .fodt-op::before{{display:none}}\
         .lw-doc .fodt-op{{border:0;background:none;padding:0}}}}",
        m(&l.margin_top),
        m(&l.margin_right),
        m(&l.margin_bottom),
        m(&l.margin_left),
    )
}

// ---------------------------------------------------------------- AST & parse.js

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkMark {
    pub href: String,
    pub xattrs: Vec<(String, String)>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpanStyleMark {
    pub name: Option<String>,
    pub rest: Vec<(String, String)>,
    pub xattrs: Vec<(String, String)>,
    pub extra: Vec<(String, String)>,
    pub other: BTreeMap<String, BTreeMap<String, String>>,
    pub opaque: String,
    pub unknown: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Marks {
    pub link: Option<LinkMark>,
    pub char_style: Option<String>,
    pub span_style: Option<SpanStyleMark>,
    pub strong: Option<Vec<(String, String)>>,
    pub em: Option<Vec<(String, String)>>,
    pub underline: Option<Vec<(String, String)>>,
    pub strike: Option<Vec<(String, String)>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Inline {
    Text { text: String, marks: Marks },
    HardBreak { src: Option<(usize, usize)>, marks: Marks },
    OpaqueInline { src: Option<(usize, usize)>, raw: String, name: String, label: String, marks: Marks },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListItem {
    pub src: Option<(usize, usize)>,
    pub xattrs: Vec<(String, String)>,
    pub header: bool,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TablePre {
    pub text: String,
    pub end: usize,
    pub cols: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableHdr {
    pub start: usize,
    pub end: usize,
    pub open_end: usize,
    pub tag: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableCell {
    pub src: Option<(usize, usize)>,
    pub xattrs: Vec<(String, String)>,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableRow {
    pub src: Option<(usize, usize)>,
    pub xattrs: Vec<(String, String)>,
    pub header: bool,
    pub cells: Vec<TableCell>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    Paragraph {
        src: Option<(usize, usize)>,
        xattrs: Vec<(String, String)>,
        style: Option<String>,
        page_break: bool,
        quote: bool,
        placeholder: bool,
        inlines: Vec<Inline>,
    },
    Heading {
        src: Option<(usize, usize)>,
        xattrs: Vec<(String, String)>,
        style: Option<String>,
        page_break: bool,
        quote: bool,
        level: u8,
        inlines: Vec<Inline>,
    },
    List {
        src: Option<(usize, usize)>,
        xattrs: Vec<(String, String)>,
        items: Vec<ListItem>,
    },
    Table {
        src: Option<(usize, usize)>,
        xattrs: Vec<(String, String)>,
        pre: Option<TablePre>,
        hdr: Option<TableHdr>,
        rows: Vec<TableRow>,
    },
    Section {
        src: Option<(usize, usize)>,
        xattrs: Vec<(String, String)>,
        blocks: Vec<Block>,
    },
    OpaqueBlock {
        src: Option<(usize, usize)>,
        raw: String,
        name: String,
        label: String,
    },
}

#[derive(Clone, Debug)]
struct Gap {
    gap: String,
    prev_end: usize,
}

#[derive(Clone, Debug)]
pub struct BaseDoc {
    pub src: String,
    pub head: String,
    pub tail: String,
    pub styles: StyleTable,
    pub text_start: usize,
    pub text_open_end: usize,
    orig_blocks: HashMap<usize, Block>,
    orig_items: HashMap<usize, ListItem>,
    orig_rows: HashMap<usize, TableRow>,
    orig_cells: HashMap<usize, TableCell>,
    gaps: HashMap<usize, Gap>,
    tails: HashMap<usize, Gap>,
    opens: HashMap<usize, usize>,
    orig_unbalanced: HashSet<String>,
}

#[derive(Clone, Debug)]
pub struct Doc {
    pub blocks: Vec<Block>,
    pub styles: StyleTable,
    pub layout: PageLayout,
    pub tracking: bool,
    pub macros: bool,
    pub base: BaseDoc,
}

fn is_zero_width(name: &str) -> bool {
    name == "#"
        || name.starts_with("text:bookmark")
        || name.starts_with("text:reference-mark")
        || name.starts_with("text:change")
        || name.starts_with("office:annotation")
        || name == "text:soft-page-break"
}

fn is_ws_only(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
}

fn has_macros(el: Option<&XmlEl>) -> bool {
    fn walk(e: &XmlEl) -> bool {
        for k in e.elements() {
            if k.name.starts_with("ooo:library-")
                || k.name.starts_with("ooo:module")
                || k.name.starts_with("script:event-listener")
                || k.name.starts_with("office:event-listener")
                || k.name.starts_with("presentation:event-listener")
            {
                return true;
            }
            if walk(k) {
                return true;
            }
        }
        false
    }
    el.is_some_and(walk)
}

fn opaque_label(src: &str, el: &XmlEl) -> String {
    let n = el.name.as_str();
    if n == "text:note" {
        return el.child("text:note-citation").map(|c| text_of(src, c)).unwrap_or_default();
    }
    if n.starts_with("office:annotation")
        || n.starts_with("text:bookmark")
        || n.starts_with("text:reference-mark")
        || n.starts_with("text:change")
        || n.starts_with("text:soft-page-break")
        || n.starts_with("draw:")
        || n.starts_with("office:")
        || matches!(n, "text:tracked-changes" | "text:sequence-decls" | "text:user-field-decls" | "text:variable-decls" | "text:dde-connection-decls")
    {
        return String::new();
    }
    let t = collapse_ws(&text_of(src, el)).trim().to_owned();
    if t.chars().count() > 4000 {
        let mut s: String = t.chars().take(4000).collect();
        s.push('\u{2026}');
        s
    } else {
        t
    }
}

struct Parser<'a> {
    src: &'a str,
    st: &'a StyleTable,
    orig_blocks: HashMap<usize, Block>,
    orig_items: HashMap<usize, ListItem>,
    orig_rows: HashMap<usize, TableRow>,
    orig_cells: HashMap<usize, TableCell>,
    gaps: HashMap<usize, Gap>,
    tails: HashMap<usize, Gap>,
    opens: HashMap<usize, usize>,
    spaces: usize,
}

impl<'a> Parser<'a> {
    fn new(src: &'a str, st: &'a StyleTable) -> Self {
        Self {
            src,
            st,
            orig_blocks: HashMap::new(),
            orig_items: HashMap::new(),
            orig_rows: HashMap::new(),
            orig_cells: HashMap::new(),
            gaps: HashMap::new(),
            tails: HashMap::new(),
            opens: HashMap::new(),
            spaces: 0,
        }
    }

    fn mixed(&self, el: &XmlEl) -> bool {
        el.kids.iter().any(|k| match k {
            XmlNode::Text { start, end, .. } => !is_ws_only(&self.src[*start..*end]),
            XmlNode::Pi { .. } | XmlNode::Comment { .. } => true,
            _ => false,
        })
    }

    fn blocks(&mut self, el: &XmlEl) -> Result<Vec<Block>, String> {
        self.opens.insert(el.start, el.open_end);
        let mut out = Vec::new();
        let mut prev_end = el.open_end;
        for k in &el.kids {
            let XmlNode::El(e) = k else { continue };
            let b = self.block(e)?;
            self.gaps.insert(e.start, Gap { gap: self.src[prev_end..e.start].to_owned(), prev_end });
            out.push(b);
            prev_end = e.end;
        }
        self.tails.insert(el.start, Gap { gap: self.src[prev_end..el.close_start].to_owned(), prev_end });
        Ok(out)
    }

    fn opaque_block(&mut self, el: &XmlEl) -> Block {
        let b = Block::OpaqueBlock {
            src: Some((el.start, el.end)),
            raw: self.src[el.start..el.end].to_owned(),
            name: el.name.clone(),
            label: opaque_label(self.src, el),
        };
        self.orig_blocks.insert(el.start, b.clone());
        b
    }

    fn block(&mut self, el: &XmlEl) -> Result<Block, String> {
        match el.name.as_str() {
            "text:p" | "text:h" => self.text_block(el),
            "text:list" => match self.list(el)? {
                Some(b) => Ok(b),
                None => Ok(self.opaque_block(el)),
            },
            "table:table" => match self.table(el)? {
                Some(b) => Ok(b),
                None => Ok(self.opaque_block(el)),
            },
            "text:section" => match self.section(el)? {
                Some(b) => Ok(b),
                None => Ok(self.opaque_block(el)),
            },
            _ => Ok(self.opaque_block(el)),
        }
    }

    fn text_block(&mut self, el: &XmlEl) -> Result<Block, String> {
        let style = el.attr("text:style-name");
        let page_break = self.st.breaks_page(style.as_deref());
        let quote = self.st.is_quote(style.as_deref());
        let inlines = self.inlines(el)?;
        let b = if el.name == "text:h" {
            let lv = el.attr("text:outline-level").and_then(|s| s.parse::<u8>().ok()).filter(|&n| n > 0).unwrap_or(1).min(6);
            Block::Heading { src: Some((el.start, el.end)), xattrs: el.attrs.clone(), style, page_break, quote, level: lv, inlines }
        } else {
            Block::Paragraph { src: Some((el.start, el.end)), xattrs: el.attrs.clone(), style, page_break, quote, placeholder: false, inlines }
        };
        self.orig_blocks.insert(el.start, b.clone());
        Ok(b)
    }

    fn list(&mut self, el: &XmlEl) -> Result<Option<Block>, String> {
        if self.mixed(el) {
            return Ok(None);
        }
        self.opens.insert(el.start, el.open_end);
        let mut items = Vec::new();
        let mut prev_end = el.open_end;
        for k in &el.kids {
            let XmlNode::El(e) = k else { continue };
            if e.name != "text:list-item" && e.name != "text:list-header" {
                return Ok(None);
            }
            if self.mixed(e) {
                return Ok(None);
            }
            let kids = self.blocks(e)?;
            if kids.is_empty() {
                return Ok(None);
            }
            self.gaps.insert(e.start, Gap { gap: self.src[prev_end..e.start].to_owned(), prev_end });
            let item = ListItem { src: Some((e.start, e.end)), xattrs: e.attrs.clone(), header: e.name == "text:list-header", blocks: kids };
            self.orig_items.insert(e.start, item.clone());
            items.push(item);
            prev_end = e.end;
        }
        if items.is_empty() {
            return Ok(None);
        }
        self.tails.insert(el.start, Gap { gap: self.src[prev_end..el.close_start].to_owned(), prev_end });
        let b = Block::List { src: Some((el.start, el.end)), xattrs: el.attrs.clone(), items };
        self.orig_blocks.insert(el.start, b.clone());
        Ok(Some(b))
    }

    fn section(&mut self, el: &XmlEl) -> Result<Option<Block>, String> {
        if self.mixed(el) {
            return Ok(None);
        }
        if el.elements().any(|k| k.name == "text:section-source" || k.name == "office:dde-source") {
            return Ok(None);
        }
        let kids = self.blocks(el)?;
        if kids.is_empty() {
            return Ok(None);
        }
        let b = Block::Section { src: Some((el.start, el.end)), xattrs: el.attrs.clone(), blocks: kids };
        self.orig_blocks.insert(el.start, b.clone());
        Ok(Some(b))
    }

    fn table_row(&mut self, r: &XmlEl, header: bool, prev: usize) -> Result<Option<TableRow>, String> {
        if r.name != "table:table-row" || self.mixed(r) || r.attr("table:number-rows-repeated").is_some() {
            return Ok(None);
        }
        self.opens.insert(r.start, r.open_end);
        let mut cells = Vec::new();
        let mut pe = r.open_end;
        for k in &r.kids {
            let XmlNode::El(c) = k else { continue };
            if c.name != "table:table-cell" || self.mixed(c) {
                return Ok(None);
            }
            if ["table:number-columns-spanned", "table:number-rows-spanned", "table:number-columns-repeated"].iter().any(|a| c.attr(a).is_some()) {
                return Ok(None);
            }
            let kids = self.blocks(c)?;
            if kids.is_empty() {
                return Ok(None);
            }
            self.gaps.insert(c.start, Gap { gap: self.src[pe..c.start].to_owned(), prev_end: pe });
            let cell = TableCell { src: Some((c.start, c.end)), xattrs: c.attrs.clone(), blocks: kids };
            self.orig_cells.insert(c.start, cell.clone());
            cells.push(cell);
            pe = c.end;
        }
        if cells.is_empty() {
            return Ok(None);
        }
        self.tails.insert(r.start, Gap { gap: self.src[pe..r.close_start].to_owned(), prev_end: pe });
        self.gaps.insert(r.start, Gap { gap: self.src[prev..r.start].to_owned(), prev_end: prev });
        let row = TableRow { src: Some((r.start, r.end)), xattrs: r.attrs.clone(), header, cells };
        self.orig_rows.insert(r.start, row.clone());
        Ok(Some(row))
    }

    fn table(&mut self, el: &XmlEl) -> Result<Option<Block>, String> {
        if self.mixed(el) {
            return Ok(None);
        }
        let ks: Vec<&XmlEl> = el.elements().collect();
        let mut idx = 0;
        while idx < ks.len() && ks[idx].name == "table:table-column" {
            idx += 1;
        }
        let pre_end = if idx > 0 { ks[idx - 1].end } else { el.open_end };
        let mut hdr = None;
        let mut rows = Vec::new();
        let mut prev_end = pre_end;
        while idx < ks.len() {
            let k = ks[idx];
            idx += 1;
            if k.name == "table:table-header-rows" {
                if hdr.is_some() || !rows.is_empty() || self.mixed(k) {
                    return Ok(None);
                }
                let mut pe = k.open_end;
                for r in k.elements() {
                    let Some(row) = self.table_row(r, true, pe)? else { return Ok(None) };
                    rows.push(row);
                    pe = r.end;
                }
                if rows.is_empty() {
                    return Ok(None);
                }
                self.tails.insert(k.start, Gap { gap: self.src[pe..k.close_start].to_owned(), prev_end: pe });
                self.gaps.insert(k.start, Gap { gap: self.src[prev_end..k.start].to_owned(), prev_end });
                hdr = Some(TableHdr { start: k.start, end: k.end, open_end: k.open_end, tag: self.src[k.start..k.open_end].to_owned() });
                prev_end = k.end;
                continue;
            }
            let Some(row) = self.table_row(k, false, prev_end)? else { return Ok(None) };
            rows.push(row);
            prev_end = k.end;
        }
        if rows.is_empty() {
            return Ok(None);
        }
        self.tails.insert(el.start, Gap { gap: self.src[prev_end..el.close_start].to_owned(), prev_end });
        let width = rows[0].cells.len();
        if rows.iter().any(|r| r.cells.len() != width) {
            return Ok(None);
        }
        let b = Block::Table {
            src: Some((el.start, el.end)),
            xattrs: el.attrs.clone(),
            pre: Some(TablePre { text: self.src[el.open_end..pre_end].to_owned(), end: pre_end, cols: width }),
            hdr,
            rows,
        };
        self.orig_blocks.insert(el.start, b.clone());
        Ok(Some(b))
    }

    fn inlines(&mut self, el: &XmlEl) -> Result<Vec<Inline>, String> {
        let mut out = Vec::new();
        let mut prev_space = false;
        let mut at_start = true;
        self.inlines_into(el, &Marks::default(), &mut out, &mut prev_space, &mut at_start)?;
        Ok(out)
    }

    fn push_text(out: &mut Vec<Inline>, text: String, marks: &Marks) {
        if text.is_empty() {
            return;
        }
        if let Some(Inline::Text { text: prev, marks: pm }) = out.last_mut() {
            if pm == marks {
                prev.push_str(&text);
                return;
            }
        }
        out.push(Inline::Text { text, marks: marks.clone() });
    }

    fn inlines_into(&mut self, el: &XmlEl, marks: &Marks, out: &mut Vec<Inline>, prev_space: &mut bool, at_start: &mut bool) -> Result<(), String> {
        for k in &el.kids {
            match k {
                XmlNode::Text { start, end, cdata } => {
                    let raw = if *cdata { self.src[*start + 9..*end - 3].to_owned() } else { decode(&self.src[*start..*end]) };
                    let mut collapsed = String::with_capacity(raw.len());
                    let mut in_ws = false;
                    for c in raw.chars() {
                        if matches!(c, ' ' | '\t' | '\r' | '\n') {
                            if !in_ws {
                                collapsed.push(' ');
                                in_ws = true;
                            }
                        } else {
                            collapsed.push(c);
                            in_ws = false;
                        }
                    }
                    let slice = if collapsed.starts_with(' ') && (*prev_space || *at_start) { &collapsed[1..] } else { &collapsed[..] };
                    if slice.is_empty() {
                        continue;
                    }
                    *prev_space = slice.ends_with(' ');
                    *at_start = false;
                    Self::push_text(out, slice.to_owned(), marks);
                }
                XmlNode::Pi { start, end } | XmlNode::Comment { start, end } | XmlNode::Doctype { start, end } => {
                    out.push(Inline::OpaqueInline {
                        src: Some((*start, *end)),
                        raw: self.src[*start..*end].to_owned(),
                        name: "#".into(),
                        label: String::new(),
                        marks: marks.clone(),
                    });
                }
                XmlNode::El(e) => {
                    let plain = e.attrs.is_empty();
                    if e.name == "text:s" && (plain || (e.attrs.len() == 1 && e.attrs[0].0 == "text:c")) {
                        let c = e.attr("text:c").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).clamp(1, 100_000);
                        self.spaces += c;
                        if self.spaces > LIMIT_SPACES {
                            return Err("it spells out more than a million spaces".into());
                        }
                        Self::push_text(out, " ".repeat(c), marks);
                        *prev_space = false;
                        *at_start = false;
                    } else if e.name == "text:tab" && plain {
                        Self::push_text(out, "\t".into(), marks);
                        *prev_space = false;
                        *at_start = false;
                    } else if e.name == "text:line-break" && plain {
                        out.push(Inline::HardBreak { src: Some((e.start, e.end)), marks: marks.clone() });
                        *prev_space = false;
                        *at_start = false;
                    } else if e.name == "text:span" && !Self::mixed_block(e) {
                        let next_marks = self.span_marks(e, marks);
                        self.inlines_into(e, &next_marks, out, prev_space, at_start)?;
                    } else if e.name == "text:a" && !Self::mixed_block(e) {
                        let mut next_marks = marks.clone();
                        next_marks.link = Some(LinkMark { href: e.attr("xlink:href").unwrap_or_default(), xattrs: e.attrs.clone() });
                        self.inlines_into(e, &next_marks, out, prev_space, at_start)?;
                    } else {
                        out.push(Inline::OpaqueInline {
                            src: Some((e.start, e.end)),
                            raw: self.src[e.start..e.end].to_owned(),
                            name: e.name.clone(),
                            label: opaque_label(self.src, e),
                            marks: marks.clone(),
                        });
                        if !is_zero_width(&e.name) {
                            *prev_space = false;
                            *at_start = false;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn mixed_block(el: &XmlEl) -> bool {
        el.elements().any(|k| matches!(k.name.as_str(), "text:p" | "text:h" | "text:list"))
    }

    fn span_marks(&self, el: &XmlEl, outer: &Marks) -> Marks {
        let name = el.attr("text:style-name");
        let xattrs: Vec<(String, String)> = el.attrs.iter().filter(|(k, _)| k != "text:style-name").cloned().collect();
        let mut marks = outer.clone();
        let s = name.as_deref().and_then(|n| self.st.lookup("text", n));
        let Some(s) = s else {
            marks.span_style = Some(SpanStyleMark { name, xattrs, unknown: true, ..Default::default() });
            return marks;
        };
        if !s.auto {
            marks.char_style = Some(s.name.clone());
            if !xattrs.is_empty() || outer.span_style.is_some() {
                marks.span_style = Some(SpanStyleMark {
                    name: None,
                    rest: outer.span_style.as_ref().map(|ss| ss.rest.clone()).unwrap_or_default(),
                    xattrs,
                    ..Default::default()
                });
            }
            return marks;
        }
        if let Some(p) = &s.parent {
            marks.char_style = Some(p.clone());
        }
        let tp = s.props.get("style:text-properties");
        let mut rest: BTreeMap<String, String> = outer.span_style.as_ref().map(|ss| ss.rest.iter().cloned().collect()).unwrap_or_default();
        let on_strong = tp.and_then(|m| m.get("fo:font-weight")).is_some_and(|v| matches!(v.as_str(), "bold" | "600" | "700" | "800" | "900"));
        let on_em = tp.and_then(|m| m.get("fo:font-style")).is_some_and(|v| matches!(v.as_str(), "italic" | "oblique"));
        let on_ul = tp.and_then(|m| m.get("style:text-underline-style")).is_some_and(|v| v != "none");
        let on_st = tp.and_then(|m| m.get("style:text-line-through-style")).is_some_and(|v| v != "none");
        let (mut g_strong, mut g_em, mut g_ul, mut g_st) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let (mut has_strong_k, mut has_em_k, mut has_ul_k, mut has_st_k) = (false, false, false, false);
        if let Some(m) = tp {
            for (k, v) in m {
                if k.contains("font-weight") {
                    has_strong_k = true;
                    if on_strong { g_strong.push((k.clone(), v.clone())); } else { rest.insert(k.clone(), v.clone()); }
                } else if k.contains("font-style") {
                    has_em_k = true;
                    if on_em { g_em.push((k.clone(), v.clone())); } else { rest.insert(k.clone(), v.clone()); }
                } else if k.starts_with("style:text-underline-") {
                    has_ul_k = true;
                    if on_ul { g_ul.push((k.clone(), v.clone())); } else { rest.insert(k.clone(), v.clone()); }
                } else if k.starts_with("style:text-line-through-") {
                    has_st_k = true;
                    if on_st { g_st.push((k.clone(), v.clone())); } else { rest.insert(k.clone(), v.clone()); }
                } else {
                    rest.insert(k.clone(), v.clone());
                }
            }
        }
        if on_strong { marks.strong = Some(g_strong); } else if has_strong_k { marks.strong = None; }
        if on_em { marks.em = Some(g_em); } else if has_em_k { marks.em = None; }
        if on_ul { marks.underline = Some(g_ul); } else if has_ul_k { marks.underline = None; }
        if on_st { marks.strike = Some(g_st); } else if has_st_k { marks.strike = None; }
        let mut other = BTreeMap::new();
        for (k, v) in &s.props {
            if k != "style:text-properties" {
                other.insert(k.clone(), v.clone());
            }
        }
        marks.span_style = Some(SpanStyleMark {
            name: Some(s.name.clone()),
            rest: rest.into_iter().collect(),
            xattrs,
            extra: s.extra.clone(),
            other,
            opaque: s.opaque.clone(),
            unknown: false,
        });
        marks
    }
}

/// Parse flat ODT XML into an editable `Doc`.
pub fn parse_fodt(text: &str) -> Result<Doc, String> {
    let root = parse_xml(text)?;
    let doc = root.elements().find(|e| e.name == "office:document").ok_or_else(|| "not a flat ODT document (no office:document)".to_owned())?;
    let body = doc.child("office:body");
    let otext = body.and_then(|b| b.child("office:text")).filter(|t| !t.empty).ok_or_else(|| "not a text document (no office:text)".to_owned())?;
    let st = read_styles(text, doc);
    let mut parser = Parser::new(text, &st);
    let mut blocks = parser.blocks(otext)?;
    if blocks.is_empty() {
        blocks.push(Block::Paragraph {
            src: None,
            xattrs: Vec::new(),
            style: None,
            page_break: false,
            quote: false,
            placeholder: true,
            inlines: Vec::new(),
        });
    }
    let tracking = otext.child("text:tracked-changes").is_some_and(|tc| tc.attr("text:track-changes").as_deref() != Some("false"));
    let macros = has_macros(doc.child("office:scripts"));
    let head = text[..otext.open_end].to_owned();
    let tail = text[otext.close_start..].to_owned();
    let layout = st.page_layout();
    let orig_unbalanced = unbalanced(&blocks);
    let base = BaseDoc {
        src: text.to_owned(),
        head,
        tail,
        styles: st.clone(),
        text_start: otext.start,
        text_open_end: otext.open_end,
        orig_blocks: parser.orig_blocks,
        orig_items: parser.orig_items,
        orig_rows: parser.orig_rows,
        orig_cells: parser.orig_cells,
        gaps: parser.gaps,
        tails: parser.tails,
        opens: parser.opens,
        orig_unbalanced,
    };
    Ok(Doc { blocks, styles: st, layout, tracking, macros, base })
}

// ---------------------------------------------------------------- paired markers & serialize.js

const PAIR_TAGS: &[&str] = &[
    "text:bookmark-start",
    "text:bookmark-end",
    "text:reference-mark-start",
    "text:reference-mark-end",
    "text:change-start",
    "text:change-end",
    "office:annotation-end",
    "office:annotation",
];

fn scan_pairs(raw: &str, count: &mut HashMap<String, i64>) {
    let mut i = 0;
    while let Some(rel) = raw[i..].find('<') {
        let start = i + rel + 1;
        let rest = &raw[start..];
        let matched = PAIR_TAGS.iter().copied().find(|tag| {
            rest.starts_with(tag)
                && rest.as_bytes().get(tag.len()).is_some_and(|&b| is_ws_byte(b) || b == b'>' || b == b'/')
        });
        if let Some(el) = matched {
            if let Some(gt) = rest.find('>') {
                let attrs_part = &rest[el.len()..gt];
                let an = match el {
                    "text:change-start" | "text:change-end" => "text:change-id",
                    "office:annotation" | "office:annotation-end" => "office:name",
                    _ => "text:name",
                };
                if let Some(val) = extract_attr_from_tag(attrs_part, an) {
                    let kind = el.strip_suffix("-start").or_else(|| el.strip_suffix("-end")).unwrap_or(el);
                    let key = format!("{kind} \"{val}\"");
                    let delta = if el.ends_with("-end") { -1 } else { 1 };
                    *count.entry(key).or_insert(0) += delta;
                }
                i = start + gt + 1;
                continue;
            }
        }
        i = start;
    }
}

fn extract_attr_from_tag(tag_rest: &str, attr_name: &str) -> Option<String> {
    let bytes = tag_rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && is_ws_byte(bytes[i]) {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b'/' || bytes[i] == b'>' {
            break;
        }
        let a0 = i;
        while i < bytes.len() && is_name_byte(bytes[i]) {
            i += 1;
        }
        let name = &tag_rest[a0..i];
        while i < bytes.len() && is_ws_byte(bytes[i]) {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            break;
        }
        i += 1;
        while i < bytes.len() && is_ws_byte(bytes[i]) {
            i += 1;
        }
        if i >= bytes.len() || (bytes[i] != b'"' && bytes[i] != b'\'') {
            break;
        }
        let q = bytes[i] as char;
        let v0 = i + 1;
        let rel = tag_rest[v0..].find(q)?;
        let val = &tag_rest[v0..v0 + rel];
        if name == attr_name {
            return Some(decode(val));
        }
        i = v0 + rel + 1;
    }
    None
}

fn walk_pairs(blocks: &[Block], count: &mut HashMap<String, i64>) {
    for b in blocks {
        match b {
            Block::OpaqueBlock { raw, .. } => scan_pairs(raw, count),
            Block::Paragraph { inlines, .. } | Block::Heading { inlines, .. } => {
                for inl in inlines {
                    if let Inline::OpaqueInline { raw, .. } = inl {
                        scan_pairs(raw, count);
                    }
                }
            }
            Block::List { items, .. } => {
                for it in items {
                    walk_pairs(&it.blocks, count);
                }
            }
            Block::Table { rows, .. } => {
                for r in rows {
                    for c in &r.cells {
                        walk_pairs(&c.blocks, count);
                    }
                }
            }
            Block::Section { blocks, .. } => walk_pairs(blocks, count),
        }
    }
}

pub fn unbalanced(blocks: &[Block]) -> HashSet<String> {
    let mut count = HashMap::new();
    walk_pairs(blocks, &mut count);
    count.into_iter().filter(|(_, c)| *c != 0).map(|(k, _)| k).collect()
}

/// Minimal-diff serializer: copies untouched spans verbatim, appends new automatic
/// styles to `<office:automatic-styles>`, and refuses newly unbalanced paired markers.
pub fn serialize_fodt(doc: &Doc) -> Result<String, String> {
    for k in unbalanced(&doc.blocks) {
        if !doc.base.orig_unbalanced.contains(&k) {
            let short = k.strip_prefix("text:").or_else(|| k.strip_prefix("office:")).unwrap_or(&k);
            return Err(format!("refused: it would leave {short} without its other half"));
        }
    }
    let mut w = FodtWriter { o: &doc.base, reg: AutoRegistry::new(&doc.base.styles) };
    let indent = w.indent_of(doc.base.text_start) + 1;
    let body = w.children_blocks(&doc.blocks, Some(doc.base.text_start), indent, Some(doc.base.text_open_end));
    Ok(format!("{}{}{}", w.head(), body, doc.base.tail))
}

struct FodtWriter<'a> {
    o: &'a BaseDoc,
    reg: AutoRegistry<'a>,
}

impl<'a> FodtWriter<'a> {
    fn indent_of(&self, start: usize) -> usize {
        let before = &self.o.src[..start];
        let nl = before.rfind('\n').map_or(0, |p| p + 1);
        let lead = &self.o.src[nl..start];
        if lead.bytes().all(|b| b == b' ') { lead.len() } else { 0 }
    }

    fn head(&self) -> String {
        let h = &self.o.head;
        if self.reg.added.is_empty() {
            return h.clone();
        }
        let add: String = self.reg.added.concat();
        let st = &self.o.styles;
        if let Some(close) = st.auto_close {
            let ls = h[..close].rfind('\n').map_or(0, |p| p + 1);
            let at = if h[ls..close].bytes().all(|b| b == b' ' || b == b'\t') { ls } else { close };
            return format!("{}{}{}{}", &h[..at], if at == ls { "" } else { "\n" }, add, &h[at..]);
        }
        if let Some((start, end)) = st.auto_empty {
            return format!("{}<office:automatic-styles>\n{} </office:automatic-styles>{}", &h[..start], add, &h[end..]);
        }
        let insert_at = h.find("<office:master-styles").or_else(|| h.find("<office:body")).map(|p| {
            let ls = h[..p].rfind('\n').unwrap_or(p);
            if h[ls..p].bytes().all(|b| matches!(b, b'\n' | b' ' | b'\t')) { ls } else { p }
        }).unwrap_or(h.len());
        format!("{}\n <office:automatic-styles>\n{} </office:automatic-styles>{}", &h[..insert_at], add, &h[insert_at..])
    }

    fn sep(&self, src: Option<(usize, usize)>, prev: Option<usize>, indent: usize) -> String {
        if let (Some((s, _)), Some(p)) = (src, prev) {
            if let Some(g) = self.o.gaps.get(&s) {
                if g.prev_end == p {
                    return g.gap.clone();
                }
            }
        }
        format!("\n{}", " ".repeat(indent))
    }

    fn tail(&self, start: Option<usize>, prev: Option<usize>, indent: usize) -> String {
        if let (Some(s), Some(p)) = (start, prev) {
            if let Some(t) = self.o.tails.get(&s) {
                if t.prev_end == p {
                    return t.gap.clone();
                }
            }
        }
        format!("\n{}", " ".repeat(indent.saturating_sub(1)))
    }

    fn open_end(&self, src: Option<(usize, usize)>) -> Option<usize> {
        src.and_then(|(s, _)| self.o.opens.get(&s).copied())
    }

    fn block_src(b: &Block) -> Option<(usize, usize)> {
        match b {
            Block::Paragraph { src, .. }
            | Block::Heading { src, .. }
            | Block::List { src, .. }
            | Block::Table { src, .. }
            | Block::Section { src, .. }
            | Block::OpaqueBlock { src, .. } => *src,
        }
    }

    fn same_block(&self, b: &Block) -> bool {
        let Some((s, _)) = Self::block_src(b) else { return false };
        self.o.orig_blocks.get(&s) == Some(b)
    }

    fn children_blocks(&mut self, blocks: &[Block], cont_start: Option<usize>, indent: usize, mut prev: Option<usize>) -> String {
        let mut out = String::new();
        for b in blocks {
            if matches!(b, Block::Paragraph { placeholder: true, inlines, .. } if inlines.is_empty()) {
                continue;
            }
            let src = Self::block_src(b);
            out.push_str(&self.sep(src, prev, indent));
            out.push_str(&self.write_block(b, indent));
            prev = src.map(|(_, e)| e);
        }
        out.push_str(&self.tail(cont_start, prev, indent));
        out
    }

    fn write_block(&mut self, b: &Block, indent: usize) -> String {
        if let Block::OpaqueBlock { raw, .. } = b {
            return raw.clone();
        }
        if self.same_block(b) {
            let (s, e) = Self::block_src(b).unwrap();
            return self.o.src[s..e].to_owned();
        }
        match b {
            Block::Paragraph { xattrs, style, page_break, inlines, .. } => self.write_text_block("text:p", xattrs, style.as_deref(), *page_break, None, inlines),
            Block::Heading { xattrs, style, page_break, level, inlines, .. } => self.write_text_block("text:h", xattrs, style.as_deref(), *page_break, Some(*level), inlines),
            Block::List { src, xattrs, items } => {
                let mut out = open_tag("text:list", xattrs, false);
                let mut prev = self.open_end(*src);
                for it in items {
                    out.push_str(&self.sep(it.src, prev, indent + 1));
                    if it.src.and_then(|(s, _)| self.o.orig_items.get(&s)) == Some(it) {
                        let (s, e) = it.src.unwrap();
                        out.push_str(&self.o.src[s..e]);
                    } else {
                        let tag = if it.header { "text:list-header" } else { "text:list-item" };
                        out.push_str(&open_tag(tag, &it.xattrs, false));
                        out.push_str(&self.children_blocks(&it.blocks, it.src.map(|(s, _)| s), indent + 2, self.open_end(it.src)));
                        out.push_str(&format!("</{tag}>"));
                    }
                    prev = it.src.map(|(_, e)| e);
                }
                out.push_str(&self.tail(src.map(|(s, _)| s), prev, indent + 1));
                out.push_str("</text:list>");
                out
            }
            Block::Section { src, xattrs, blocks } => {
                let mut out = open_tag("text:section", xattrs, false);
                out.push_str(&self.children_blocks(blocks, src.map(|(s, _)| s), indent + 1, self.open_end(*src)));
                out.push_str("</text:section>");
                out
            }
            Block::Table { src, xattrs, pre, hdr, rows } => self.write_table(*src, xattrs, pre.as_ref(), hdr.as_ref(), rows, indent),
            Block::OpaqueBlock { raw, .. } => raw.clone(),
        }
    }

    fn write_table(&mut self, src: Option<(usize, usize)>, xattrs: &[(String, String)], pre: Option<&TablePre>, hdr: Option<&TableHdr>, rows: &[TableRow], indent: usize) -> String {
        let start = src.map(|(s, _)| s);
        let mut out = open_tag("table:table", xattrs, false);
        let w = rows.first().map_or(1, |r| r.cells.len().max(1));
        let mut prev = if let Some(p) = pre.filter(|p| p.cols == w) {
            out.push_str(&p.text);
            Some(p.end)
        } else {
            out.push('\n');
            out.push_str(&" ".repeat(indent + 1));
            if w > 1 {
                out.push_str(&format!("<table:table-column table:number-columns-repeated=\"{w}\"/>"));
            } else {
                out.push_str("<table:table-column/>");
            }
            None
        };
        let has_hdr = rows.first().is_some_and(|r| r.header);
        let mut body_start_idx = 0usize;
        if has_hdr {
            out.push_str(&self.sep(hdr.map(|h| (h.start, h.end)), prev, indent + 1));
            out.push_str(hdr.map_or("<table:table-header-rows>", |h| h.tag.as_str()));
            let mut hp = hdr.map(|h| h.open_end);
            for r in rows {
                if !r.header {
                    break;
                }
                body_start_idx += 1;
                out.push_str(&self.sep(r.src, hp, indent + 2));
                out.push_str(&self.write_table_row(r, indent + 2));
                hp = r.src.map(|(_, e)| e);
            }
            out.push_str(&self.tail(hdr.map(|h| h.start), hp, indent + 2));
            out.push_str("</table:table-header-rows>");
            prev = hdr.map(|h| h.end);
            if let Some(h) = hdr {
                if self.o.tails.get(&h.start).map(|t| t.prev_end) != hp {
                    prev = None;
                }
            }
        }
        for r in &rows[body_start_idx..] {
            out.push_str(&self.sep(r.src, prev, indent + 1));
            out.push_str(&self.write_table_row(r, indent + 1));
            prev = r.src.map(|(_, e)| e);
        }
        out.push_str(&self.tail(start, prev, indent + 1));
        out.push_str("</table:table>");
        out
    }

    fn write_table_row(&mut self, r: &TableRow, indent: usize) -> String {
        if r.src.and_then(|(s, _)| self.o.orig_rows.get(&s)) == Some(r) {
            let (s, e) = r.src.unwrap();
            return self.o.src[s..e].to_owned();
        }
        let mut out = open_tag("table:table-row", &r.xattrs, false);
        let mut prev = self.open_end(r.src);
        for c in &r.cells {
            out.push_str(&self.sep(c.src, prev, indent + 1));
            if c.src.and_then(|(s, _)| self.o.orig_cells.get(&s)) == Some(c) {
                let (s, e) = c.src.unwrap();
                out.push_str(&self.o.src[s..e]);
            } else {
                let xa: Vec<(String, String)> = if c.src.is_some() || !c.xattrs.is_empty() {
                    c.xattrs.clone()
                } else {
                    vec![("office:value-type".into(), "string".into())]
                };
                out.push_str(&open_tag("table:table-cell", &xa, false));
                out.push_str(&self.children_blocks(&c.blocks, c.src.map(|(s, _)| s), indent + 2, self.open_end(c.src)));
                out.push_str("</table:table-cell>");
            }
            prev = c.src.map(|(_, e)| e);
        }
        out.push_str(&self.tail(r.src.map(|(s, _)| s), prev, indent + 1));
        out.push_str("</table:table-row>");
        out
    }

    fn write_text_block(&mut self, tag: &str, xattrs: &[(String, String)], style: Option<&str>, page_break: bool, level: Option<u8>, inlines: &[Inline]) -> String {
        let mut xa: Vec<(String, String)> = xattrs.iter().filter(|(k, _)| tag == "text:h" || k != "text:outline-level").cloned().collect();
        let mut st_name = style.map(String::from);
        if let Some(sn) = style {
            if page_break != self.o.styles.breaks_page(Some(sn)) {
                st_name = Some(self.break_style(Some(sn), page_break));
            }
        } else if page_break {
            st_name = Some(self.break_style(None, true));
        }
        set_attr(&mut xa, "text:style-name", st_name.as_deref(), 0);
        if let Some(lv) = level {
            let s = lv.to_string();
            set_attr(&mut xa, "text:outline-level", Some(&s), 1);
        }
        let body = self.write_inlines(inlines);
        if body.is_empty() {
            open_tag(tag, &xa, true)
        } else {
            format!("{}{body}</{tag}>", open_tag(tag, &xa, false))
        }
    }

    fn break_style(&mut self, style: Option<&str>, on: bool) -> String {
        let base = style.and_then(|s| self.o.styles.lookup("paragraph", s));
        let auto = base.is_some_and(|b| b.auto);
        let parent = if auto { base.and_then(|b| b.parent.as_deref()) } else { style };
        let mut props: BTreeMap<String, BTreeMap<String, String>> = if auto { base.unwrap().props.clone() } else { BTreeMap::new() };
        let pp = props.entry("style:paragraph-properties".into()).or_default();
        if on {
            pp.insert("fo:break-before".into(), "page".into());
        } else if parent.is_some_and(|p| self.o.styles.breaks_page(Some(p))) {
            pp.insert("fo:break-before".into(), "auto".into());
        } else {
            pp.remove("fo:break-before");
        }
        let extra = if auto { base.unwrap().extra.as_slice() } else { &[] };
        let opaque = if auto { base.unwrap().opaque.as_str() } else { "" };
        if !props.values().any(|m| !m.is_empty()) && extra.is_empty() {
            if let Some(p) = parent {
                return p.to_owned();
            }
        }
        self.reg.ensure(&StyleSpec { family: "paragraph", parent, extra, props: &props, opaque }, None)
    }

    fn write_inlines(&mut self, inlines: &[Inline]) -> String {
        let mut out = String::new();
        let mut prev_space = false;
        let mut at_start = true;
        let mut open_link: Option<LinkMark> = None;
        let mut open_span: Option<String> = None;
        let close_span = |out: &mut String, open_span: &mut Option<String>| {
            if open_span.take().is_some() {
                out.push_str("</text:span>");
            }
        };
        let close_link = |out: &mut String, open_span: &mut Option<String>, open_link: &mut Option<LinkMark>| {
            close_span(out, open_span);
            if open_link.take().is_some() {
                out.push_str("</text:a>");
            }
        };
        for c in inlines {
            let marks = match c {
                Inline::Text { marks, .. } | Inline::HardBreak { marks, .. } | Inline::OpaqueInline { marks, .. } => marks,
            };
            if marks.link != open_link {
                close_link(&mut out, &mut open_span, &mut open_link);
                if let Some(lm) = &marks.link {
                    out.push_str(&link_tag(lm));
                    open_link = Some(lm.clone());
                }
            }
            let st = self.span_tag(marks);
            if st != open_span {
                close_span(&mut out, &mut open_span);
                if let Some(tag) = st {
                    out.push_str(&tag);
                    open_span = Some(tag);
                }
            }
            match c {
                Inline::Text { text, .. } => write_odf_text(text, &mut prev_space, &mut at_start, &mut out),
                Inline::HardBreak { .. } => {
                    out.push_str("<text:line-break/>");
                    prev_space = false;
                    at_start = false;
                }
                Inline::OpaqueInline { raw, .. } => out.push_str(raw),
            }
        }
        close_link(&mut out, &mut open_span, &mut open_link);
        out
    }

    fn span_tag(&mut self, marks: &Marks) -> Option<String> {
        let cs = marks.char_style.as_deref();
        let ss = marks.span_style.as_ref();
        let mut tp: BTreeMap<String, String> = BTreeMap::new();
        let mut fmt = false;
        for group in [&marks.strong, &marks.em, &marks.underline, &marks.strike] {
            if let Some(pairs) = group {
                fmt = true;
                for (k, v) in pairs {
                    tp.insert(k.clone(), v.clone());
                }
            }
        }
        if let Some(ss) = ss {
            for (k, v) in &ss.rest {
                tp.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        let has_other = ss.is_some_and(|s| !s.other.is_empty());
        let has_extra = ss.is_some_and(|s| !s.extra.is_empty());
        let has_opaque = ss.is_some_and(|s| !s.opaque.is_empty());
        let plain = !fmt && !ss.is_some_and(|s| !s.rest.is_empty()) && !has_other && !has_extra && !has_opaque;
        let name: Option<String> = if ss.is_some_and(|s| s.unknown) && !fmt && cs.is_none() {
            ss.and_then(|s| s.name.clone())
        } else if plain && cs.is_some() {
            let cs_name = cs.unwrap();
            let h = ss.and_then(|s| s.name.as_deref()).and_then(|n| self.o.styles.lookup("text", n));
            if h.is_some_and(|h| h.auto && h.parent.as_deref() == Some(cs_name) && h.props.is_empty() && h.extra.is_empty()) {
                ss.and_then(|s| s.name.clone())
            } else {
                Some(cs_name.to_owned())
            }
        } else if !plain {
            let mut props = ss.map(|s| s.other.clone()).unwrap_or_default();
            props.insert("style:text-properties".into(), tp);
            let extra = ss.map(|s| s.extra.as_slice()).unwrap_or(&[]);
            let opaque = ss.map(|s| s.opaque.as_str()).unwrap_or("");
            let hint = ss.and_then(|s| s.name.as_deref());
            Some(self.reg.ensure(&StyleSpec { family: "text", parent: cs, extra, props: &props, opaque }, hint))
        } else {
            None
        };
        let mut xa = ss.map(|s| s.xattrs.clone()).unwrap_or_default();
        if name.is_none() && xa.is_empty() {
            return None;
        }
        if let Some(n) = name {
            xa.insert(0, ("text:style-name".into(), esc_attr(&n)));
        }
        Some(open_tag("text:span", &xa, false))
    }
}

fn open_tag(tag: &str, xa: &[(String, String)], empty: bool) -> String {
    let mut out = format!("<{tag}");
    for (k, v) in xa {
        out.push(' ');
        out.push_str(k);
        out.push_str("=\"");
        out.push_str(v);
        out.push('"');
    }
    if empty { out.push_str("/>"); } else { out.push('>'); }
    out
}

fn set_attr(xa: &mut Vec<(String, String)>, name: &str, value: Option<&str>, at: usize) {
    let pos = xa.iter().position(|(k, _)| k == name);
    let Some(val) = value else {
        if let Some(i) = pos {
            xa.remove(i);
        }
        return;
    };
    let raw = esc_attr(val);
    if let Some(i) = pos {
        if decode(&xa[i].1) != val {
            xa[i] = (name.to_owned(), raw);
        }
    } else {
        xa.insert(at.min(xa.len()), (name.to_owned(), raw));
    }
}

fn link_tag(m: &LinkMark) -> String {
    let mut xa = m.xattrs.clone();
    match xa.iter().position(|(k, _)| k == "xlink:href") {
        None => {
            if !xa.iter().any(|(k, _)| k == "xlink:type") {
                xa.push(("xlink:type".into(), "simple".into()));
            }
            xa.push(("xlink:href".into(), esc_attr(&m.href)));
        }
        Some(i) => {
            if decode(&xa[i].1) != m.href {
                xa[i] = ("xlink:href".into(), esc_attr(&m.href));
            }
        }
    }
    open_tag("text:a", &xa, false)
}

fn write_odf_text(t: &str, prev_space: &mut bool, at_start: &mut bool, out: &mut String) {
    let bytes = t.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b' ' => {
                let mut j = i;
                while j < bytes.len() && bytes[j] == b' ' {
                    j += 1;
                }
                let mut n = j - i;
                if !(*at_start || *prev_space) {
                    out.push(' ');
                    n -= 1;
                }
                if n == 1 {
                    out.push_str("<text:s/>");
                } else if n > 1 {
                    out.push_str(&format!("<text:s text:c=\"{n}\"/>"));
                }
                *prev_space = true;
                *at_start = false;
                i = j;
            }
            b'\t' => {
                out.push_str("<text:tab/>");
                *prev_space = false;
                *at_start = false;
                i += 1;
            }
            b'\n' | b'\r' | 0x0b => {
                out.push_str("<text:line-break/>");
                *prev_space = false;
                *at_start = false;
                i += 1;
            }
            _ => {
                let mut j = i;
                while j < bytes.len() && !matches!(bytes[j], b' ' | b'\t' | b'\n' | b'\r' | 0x0b) {
                    j += 1;
                }
                let e = esc_text(&t[i..j]);
                if !e.is_empty() {
                    out.push_str(&e);
                    *prev_space = false;
                    *at_start = false;
                }
                i = j;
            }
        }
    }
}

// ---------------------------------------------------------------- extractors (text, outline, links, markdown, HTML/PDF)

/// Plain text of a block's inlines.
pub fn inlines_text(inlines: &[Inline]) -> String {
    let mut out = String::new();
    for inl in inlines {
        match inl {
            Inline::Text { text, .. } => out.push_str(text),
            Inline::HardBreak { .. } => out.push('\n'),
            Inline::OpaqueInline { label, .. } if !label.is_empty() => out.push_str(label),
            _ => {}
        }
    }
    out
}

/// Plain text of a flat ODT document (`parse.js::fodtText`), for search.
pub fn fodt_text(src: &str) -> String {
    let Ok(root) = parse_xml(src) else { return String::new() };
    let Some(doc) = root.elements().find(|e| e.name == "office:document") else { return String::new() };
    let Some(otext) = doc.child("office:body").and_then(|b| b.child("office:text")) else { return String::new() };
    fn walk(src: &str, el: &XmlEl, out: &mut String, spaces: &mut usize) {
        for k in &el.kids {
            match k {
                XmlNode::Text { start, end, cdata } => {
                    let s = if *cdata { src[*start + 9..*end - 3].to_owned() } else { decode(&src[*start..*end]) };
                    out.push_str(&collapse_ws(&s));
                }
                XmlNode::El(e) => {
                    if matches!(e.name.as_str(), "text:tracked-changes" | "office:annotation" | "text:sequence-decls") {
                        continue;
                    }
                    if e.name == "text:s" {
                        let c = e.attr("text:c").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).min(1000).min(LIMIT_SPACES.saturating_sub(*spaces));
                        if c > 0 {
                            for _ in 0..c {
                                out.push(' ');
                            }
                            *spaces += c;
                        }
                        continue;
                    }
                    if e.name == "text:tab" {
                        out.push('\t');
                        continue;
                    }
                    if e.name == "text:line-break" {
                        out.push('\n');
                        continue;
                    }
                    let blk = matches!(e.name.as_str(), "text:p" | "text:h");
                    walk(src, e, out, spaces);
                    if blk {
                        out.push('\n');
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = String::new();
    let mut spaces = 0;
    walk(src, otext, &mut out, &mut spaces);
    let trimmed: Vec<&str> = out.split('\n').map(|l| l.trim_matches(' ')).collect();
    let joined = trimmed.join("\n");
    let mut clean = String::with_capacity(joined.len());
    let mut nls = 0;
    for c in joined.chars() {
        if c == '\n' {
            nls += 1;
            if nls <= 2 {
                clean.push('\n');
            }
        } else {
            nls = 0;
            clean.push(c);
        }
    }
    clean.trim().to_owned()
}

/// Document headings `(level, text, heading_index)` matching `parse.js::fodtOutline`.
pub fn fodt_outline(src: &str) -> Vec<(usize, String, usize)> {
    let Ok(doc) = parse_fodt(src) else { return Vec::new() };
    doc_outline(&doc)
}

pub fn doc_outline(doc: &Doc) -> Vec<(usize, String, usize)> {
    fn walk(blocks: &[Block], out: &mut Vec<(usize, String, usize)>) {
        for b in blocks {
            match b {
                Block::Heading { level, inlines, .. } => {
                    let idx = out.len();
                    out.push((*level as usize, inlines_text(inlines).trim().to_owned(), idx));
                }
                Block::List { items, .. } => {
                    for it in items {
                        walk(&it.blocks, out);
                    }
                }
                Block::Table { rows, .. } => {
                    for r in rows {
                        for c in &r.cells {
                            walk(&c.blocks, out);
                        }
                    }
                }
                Block::Section { blocks, .. } => walk(blocks, out),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(&doc.blocks, &mut out);
    out
}

/// All decoded `xlink:href` link targets from `<text:a>` elements (`parse.js::fodtLinks`).
pub fn fodt_links(src: &str) -> Vec<String> {
    let Ok(root) = parse_xml(src) else { return Vec::new() };
    fn walk(el: &XmlEl, out: &mut Vec<String>) {
        for e in el.elements() {
            if e.name == "text:a" {
                if let Some(h) = e.attr("xlink:href") {
                    out.push(h);
                }
            }
            walk(e, out);
        }
    }
    let mut out = Vec::new();
    walk(&root, &mut out);
    out
}

/// Safe link check matching `ui-src/writer/schema.js::safeHref`.
pub fn safe_href(href: &str) -> bool {
    let h = href.trim();
    if h.is_empty() {
        return false;
    }
    if h.starts_with('#') {
        return true;
    }
    let lower = h.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:") || lower.starts_with("urb://") {
        return true;
    }
    // Reject any other scheme (javascript:, data:, file:, vnd.sun.star.script:, macro:, etc.)
    if let Some(colon) = h.find(':') {
        let before = &h[..colon];
        if !before.contains('/') && !before.contains('?') && !before.contains('#') {
            return false;
        }
    }
    !h.starts_with("//")
}

/// Render a flat ODT document as clean Markdown for split-view preview.
pub fn to_markdown(src: &str) -> String {
    let Ok(doc) = parse_fodt(src) else { return fodt_text(src) };
    fn render_inlines(inlines: &[Inline]) -> String {
        let mut s = String::new();
        for inl in inlines {
            match inl {
                Inline::Text { text, marks } => {
                    let mut piece = text.clone();
                    if marks.strong.is_some() { piece = format!("**{piece}**"); }
                    if marks.em.is_some() { piece = format!("*{piece}*"); }
                    if marks.strike.is_some() { piece = format!("~~{piece}~~"); }
                    if let Some(lm) = &marks.link {
                        if safe_href(&lm.href) {
                            piece = format!("[{piece}]({})", lm.href);
                        }
                    }
                    s.push_str(&piece);
                }
                Inline::HardBreak { .. } => s.push_str("  \n"),
                Inline::OpaqueInline { label, .. } if !label.is_empty() => s.push_str(label),
                _ => {}
            }
        }
        s
    }
    fn walk(doc: &Doc, blocks: &[Block], depth: usize, out: &mut String) {
        for b in blocks {
            match b {
                Block::Heading { level, inlines, .. } => {
                    out.push_str(&"#".repeat((*level as usize).clamp(1, 6)));
                    out.push(' ');
                    out.push_str(&render_inlines(inlines));
                    out.push_str("\n\n");
                }
                Block::Paragraph { quote, page_break, inlines, .. } => {
                    if *page_break {
                        out.push_str("---\n\n");
                    }
                    let txt = render_inlines(inlines);
                    if !txt.trim().is_empty() {
                        if *quote {
                            out.push_str("> ");
                        }
                        out.push_str(&txt);
                        out.push_str("\n\n");
                    }
                }
                Block::List { xattrs, items, .. } => {
                    let kind = xattrs.iter().find(|(k, _)| k == "text:style-name").and_then(|(_, v)| doc.styles.list_kind(&decode(v))).unwrap_or("bullet");
                    for (idx, it) in items.iter().enumerate() {
                        let indent = "  ".repeat(depth);
                        let marker = if kind == "number" { format!("{}. ", idx + 1) } else { "- ".into() };
                        if let Some(first) = it.blocks.first() {
                            match first {
                                Block::Paragraph { inlines, .. } | Block::Heading { inlines, .. } => {
                                    out.push_str(&format!("{indent}{marker}{}\n", render_inlines(inlines)));
                                }
                                _ => walk(doc, std::slice::from_ref(first), depth + 1, out),
                            }
                            if it.blocks.len() > 1 {
                                walk(doc, &it.blocks[1..], depth + 1, out);
                            }
                        }
                    }
                    if depth == 0 {
                        out.push('\n');
                    }
                }
                Block::Table { rows, .. } => {
                    for (ri, r) in rows.iter().enumerate() {
                        out.push('|');
                        for c in &r.cells {
                            let cell_txt: Vec<String> = c.blocks.iter().map(|cb| match cb {
                                Block::Paragraph { inlines, .. } | Block::Heading { inlines, .. } => render_inlines(inlines).replace('|', "\\|"),
                                _ => String::new(),
                            }).collect();
                            out.push(' ');
                            out.push_str(&cell_txt.join(" "));
                            out.push_str(" |");
                        }
                        out.push('\n');
                        if ri == 0 {
                            out.push('|');
                            for _ in &r.cells {
                                out.push_str(" --- |");
                            }
                            out.push('\n');
                        }
                    }
                    out.push('\n');
                }
                Block::Section { blocks, .. } => walk(doc, blocks, depth, out),
                Block::OpaqueBlock { label, .. } if !label.is_empty() => {
                    out.push_str(label);
                    out.push_str("\n\n");
                }
                _ => {}
            }
        }
    }
    let mut out = String::new();
    walk(&doc, &doc.blocks, 0, &mut out);
    out
}

/// Self-contained sealed HTML rendering of a flat ODT document for PDF export
/// (`ui-src/writer/view.js::render` + `print.js::printCss`), using only
/// whitelisted CSS and safe links.
pub fn render_html(src: &str, title: &str, for_print: bool) -> Option<String> {
    let doc = parse_fodt(src).ok()?;
    let mut body = String::new();
    render_blocks_html(&doc, &doc.blocks, &mut body);
    let mut css = String::from(
        "body{margin:0;background:#fff;color:#111;font:12pt/1.45 \"Liberation Serif\",Georgia,serif}\
         .lw-sheet{max-width:816px;margin:0 auto;padding:72px}\
         .lw-doc h1,.lw-doc h2,.lw-doc h3,.lw-doc h4,.lw-doc h5,.lw-doc h6{line-height:1.25;break-after:avoid}\
         .lw-doc blockquote,.lw-doc .lw-quote{margin-left:1.5em;padding-left:0.9em;border-left:2px solid #999;color:#333}\
         .lw-doc table{border-collapse:collapse;width:100%;margin:0.8em 0}\
         .lw-doc th,.lw-doc td{border:0.5pt solid #888;padding:4pt 6pt;vertical-align:top;text-align:left}\
         .lw-doc th{background:#f2f2f2;font-weight:600}\
         .lw-doc .lw-pb{border-top:1px dashed #aaa;margin:1em 0;padding-top:0.5em}\
         .lw-doc .fodt-op{font-size:0.85em;color:#555;background:#f5f5f5;padding:1px 4px;border-radius:3px}\
         .lw-doc a{color:#1a5fb4;text-decoration:underline}\n",
    );
    for s in doc.styles.styles.values() {
        if s.family == "paragraph" || s.family == "text" {
            let decl = style_css(&doc.styles, &s.family, &s.name);
            if !decl.is_empty() {
                let cls = css_style_class(&s.family, &s.name);
                css.push_str(&format!(".lw-doc .{cls}{{{decl}}}\n"));
            }
        }
    }
    if for_print {
        css.push_str(&print_css(&doc.layout));
    }
    Some(format!(
        "<!doctype html>\n<html><head>\
         <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">\
         <meta charset=\"utf-8\"><title>{}</title>\
         <style>{css}</style></head>\
         <body><div class=\"lw-sheet\"><div class=\"lw-doc\">{body}</div></div></body></html>\n",
        esc_text(title),
    ))
}

fn css_style_class(family: &str, name: &str) -> String {
    format!("s-{}-{}", &family[..1.min(family.len())], hash8(&format!("{family}\0{name}")))
}

fn render_inlines_html(doc: &Doc, inlines: &[Inline], out: &mut String) {
    for inl in inlines {
        match inl {
            Inline::Text { text, marks } => {
                let mut piece = esc_text(text);
                if marks.strike.is_some() { piece = format!("<s>{piece}</s>"); }
                if marks.underline.is_some() { piece = format!("<u>{piece}</u>"); }
                if marks.em.is_some() { piece = format!("<em>{piece}</em>"); }
                if marks.strong.is_some() { piece = format!("<strong>{piece}</strong>"); }
                let mut classes = Vec::new();
                if let Some(cs) = &marks.char_style {
                    classes.push(css_style_class("text", cs));
                }
                if let Some(ss) = &marks.span_style {
                    if let Some(n) = &ss.name {
                        classes.push(css_style_class("text", n));
                    }
                }
                if !classes.is_empty() {
                    piece = format!("<span class=\"{}\">{piece}</span>", classes.join(" "));
                }
                if let Some(lm) = &marks.link {
                    if safe_href(&lm.href) {
                        piece = format!("<a href=\"{}\">{piece}</a>", esc_attr(&lm.href));
                    }
                }
                out.push_str(&piece);
            }
            Inline::HardBreak { .. } => out.push_str("<br>"),
            Inline::OpaqueInline { label, .. } if !label.is_empty() => {
                out.push_str(&format!("<span class=\"fodt-op\">{}</span>", esc_text(label)));
            }
            _ => {}
        }
    }
    let _ = doc;
}

fn render_blocks_html(doc: &Doc, blocks: &[Block], out: &mut String) {
    for b in blocks {
        match b {
            Block::Paragraph { style, page_break, quote, inlines, .. } => {
                let mut classes = Vec::new();
                if let Some(s) = style {
                    classes.push(css_style_class("paragraph", s));
                }
                if *quote {
                    classes.push("lw-quote".into());
                }
                if *page_break {
                    classes.push("lw-pb".into());
                }
                let cls = if classes.is_empty() { String::new() } else { format!(" class=\"{}\"", classes.join(" ")) };
                out.push_str(&format!("<p{cls}>"));
                if inlines.is_empty() {
                    out.push_str("<br>");
                } else {
                    render_inlines_html(doc, inlines, out);
                }
                out.push_str("</p>\n");
            }
            Block::Heading { style, page_break, level, inlines, .. } => {
                let lv = (*level).clamp(1, 6);
                let mut classes = Vec::new();
                if let Some(s) = style {
                    classes.push(css_style_class("paragraph", s));
                }
                if *page_break {
                    classes.push("lw-pb".into());
                }
                let cls = if classes.is_empty() { String::new() } else { format!(" class=\"{}\"", classes.join(" ")) };
                out.push_str(&format!("<h{lv}{cls}>"));
                render_inlines_html(doc, inlines, out);
                out.push_str(&format!("</h{lv}>\n"));
            }
            Block::List { xattrs, items, .. } => {
                let kind = xattrs.iter().find(|(k, _)| k == "text:style-name").and_then(|(_, v)| doc.styles.list_kind(&decode(v))).unwrap_or("bullet");
                let tag = if kind == "number" { "ol" } else { "ul" };
                out.push_str(&format!("<{tag}>\n"));
                for it in items {
                    out.push_str("<li>");
                    render_blocks_html(doc, &it.blocks, out);
                    out.push_str("</li>\n");
                }
                out.push_str(&format!("</{tag}>\n"));
            }
            Block::Table { rows, .. } => {
                out.push_str("<table>\n");
                for r in rows {
                    out.push_str("<tr>");
                    let ctag = if r.header { "th" } else { "td" };
                    for c in &r.cells {
                        out.push_str(&format!("<{ctag}>"));
                        render_blocks_html(doc, &c.blocks, out);
                        out.push_str(&format!("</{ctag}>"));
                    }
                    out.push_str("</tr>\n");
                }
                out.push_str("</table>\n");
            }
            Block::Section { blocks, .. } => {
                out.push_str("<section>\n");
                render_blocks_html(doc, blocks, out);
                out.push_str("</section>\n");
            }
            Block::OpaqueBlock { label, .. } if !label.is_empty() => {
                out.push_str(&format!("<div class=\"fodt-op\">{}</div>\n", esc_text(label)));
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------- .odt export (odt.js)

const ODT_MIME: &str = "application/vnd.oasis.opendocument.text";

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc: u32 = 0xffff_ffff;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
        }
    }
    crc ^ 0xffff_ffff
}

fn zip_stored(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut locals = Vec::new();
    let mut cents = Vec::new();
    let (time, date): (u16, u16) = (0, (46 << 9) | (1 << 5) | 1); // 2026-01-01 00:00:00
    for &(name, data) in files {
        let nm = name.as_bytes();
        let off = locals.len() as u32;
        let crc = crc32(data);
        let len = data.len() as u32;
        // Local file header
        locals.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        locals.extend_from_slice(&10u16.to_le_bytes()); // version needed
        locals.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 flag
        locals.extend_from_slice(&0u16.to_le_bytes()); // STORED
        locals.extend_from_slice(&time.to_le_bytes());
        locals.extend_from_slice(&date.to_le_bytes());
        locals.extend_from_slice(&crc.to_le_bytes());
        locals.extend_from_slice(&len.to_le_bytes());
        locals.extend_from_slice(&len.to_le_bytes());
        locals.extend_from_slice(&(nm.len() as u16).to_le_bytes());
        locals.extend_from_slice(&0u16.to_le_bytes()); // extra len
        locals.extend_from_slice(nm);
        locals.extend_from_slice(data);
        // Central directory header
        cents.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        cents.extend_from_slice(&20u16.to_le_bytes());
        cents.extend_from_slice(&10u16.to_le_bytes());
        cents.extend_from_slice(&0x0800u16.to_le_bytes());
        cents.extend_from_slice(&0u16.to_le_bytes());
        cents.extend_from_slice(&time.to_le_bytes());
        cents.extend_from_slice(&date.to_le_bytes());
        cents.extend_from_slice(&crc.to_le_bytes());
        cents.extend_from_slice(&len.to_le_bytes());
        cents.extend_from_slice(&len.to_le_bytes());
        cents.extend_from_slice(&(nm.len() as u16).to_le_bytes());
        cents.extend_from_slice(&0u16.to_le_bytes()); // extra
        cents.extend_from_slice(&0u16.to_le_bytes()); // comment
        cents.extend_from_slice(&0u16.to_le_bytes()); // disk
        cents.extend_from_slice(&0u16.to_le_bytes()); // int attr
        cents.extend_from_slice(&0u32.to_le_bytes()); // ext attr
        cents.extend_from_slice(&off.to_le_bytes());
        cents.extend_from_slice(nm);
    }
    let cd_off = locals.len() as u32;
    let cd_size = cents.len() as u32;
    let mut out = Vec::with_capacity(locals.len() + cents.len() + 22);
    out.extend_from_slice(&locals);
    out.extend_from_slice(&cents);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_off.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// Adjust relative `xlink:href="..."` links one `../` deeper when moving from flat `.fodt` into `.odt` (`odt.js::linksOut`).
fn links_out(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut i = 0;
    while let Some(rel_lt) = xml[i..].find('<') {
        let lt = i + rel_lt;
        out.push_str(&xml[i..lt]);
        let Some(rel_gt) = xml[lt..].find('>') else {
            out.push_str(&xml[lt..]);
            return out;
        };
        let tag = &xml[lt..=lt + rel_gt];
        out.push_str(&rewrite_tag_links_out(tag));
        i = lt + rel_gt + 1;
    }
    out.push_str(&xml[i..]);
    out
}

fn rewrite_tag_links_out(tag: &str) -> String {
    let needle = "xlink:href=\"";
    if !tag.contains(needle) {
        return tag.to_owned();
    }
    let mut out = String::with_capacity(tag.len() + 8);
    let mut rest = tag;
    while let Some(pos) = rest.find(needle) {
        let before = &rest[..pos];
        let is_attr = before.chars().last().is_some_and(char::is_whitespace);
        out.push_str(&rest[..pos + needle.len()]);
        rest = &rest[pos + needle.len()..];
        if !is_attr {
            continue;
        }
        let Some(q) = rest.find('"') else { break };
        let val = &rest[..q];
        let is_relative = !val.is_empty()
            && !val.starts_with('/')
            && !val.starts_with('#')
            && !val.find(':').is_some_and(|c| c > 0 && val.as_bytes()[0].is_ascii_alphabetic() && val[..c].bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.')));
        if is_relative {
            out.push_str("../");
        }
        out.push_str(val);
        rest = &rest[q..];
    }
    out.push_str(rest);
    out
}

fn collect_style_refs(xml: &str, out: &mut Vec<String>) {
    let bytes = xml.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if is_ws_byte(bytes[i]) {
            let mut j = i + 1;
            while j < bytes.len() && is_name_byte(bytes[j]) {
                j += 1;
            }
            let name = &xml[i + 1..j];
            if (name.contains(':') && name.ends_with("style-name")) || name == "style:page-layout-name" {
                let mut k = j;
                while k < bytes.len() && is_ws_byte(bytes[k]) { k += 1; }
                if k < bytes.len() && bytes[k] == b'=' {
                    k += 1;
                    while k < bytes.len() && is_ws_byte(bytes[k]) { k += 1; }
                    if k < bytes.len() && (bytes[k] == b'"' || bytes[k] == b'\'') {
                        let q = bytes[k] as char;
                        if let Some(rel) = xml[k + 1..].find(q) {
                            out.push(decode(&xml[k + 1..k + 1 + rel]));
                            i = k + 1 + rel + 1;
                            continue;
                        }
                    }
                }
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
}

/// Export flat ODT text as a valid `.odt` zip package (`ui-src/writer/odt.js::exportOdt`).
pub fn export_odt(text: &str) -> Result<Vec<u8>, String> {
    let root = parse_xml(text).map_err(|e| format!("This document cannot be exported: {e}."))?;
    let doc = root.elements().find(|e| e.name == "office:document").ok_or_else(|| "This document cannot be exported: it is not flat ODT.".to_owned())?;
    let get = |name: &str| -> String { doc.child(name).map(|k| links_out(&text[k.start..k.end])).unwrap_or_default() };
    let ver = esc_attr(doc.attr("office:version").as_deref().unwrap_or("1.3"));
    let mut at = String::new();
    for (k, v) in &doc.attrs {
        if k != "office:mimetype" {
            at.push(' ');
            at.push_str(k);
            at.push_str("=\"");
            at.push_str(v);
            at.push('"');
        }
    }
    let autos: Vec<(Option<String>, String, String)> = doc
        .child("office:automatic-styles")
        .map(|auto_el| auto_el.elements().map(|e| (e.attr("style:name"), e.name.clone(), links_out(&text[e.start..e.end]))).collect())
        .unwrap_or_default();
    let mut want: HashSet<String> = HashSet::new();
    let mut queue = Vec::new();
    collect_style_refs(&get("office:master-styles"), &mut queue);
    while let Some(n) = queue.pop() {
        if want.insert(n.clone()) {
            if let Some((_, _, raw)) = autos.iter().find(|(nm, _, _)| nm.as_deref() == Some(n.as_str())) {
                collect_style_refs(raw, &mut queue);
            }
        }
    }
    let s_auto: String = format!(
        "<office:automatic-styles>{}</office:automatic-styles>",
        autos.iter().filter(|(nm, el, _)| el == "style:page-layout" || nm.as_deref().is_some_and(|n| want.contains(n))).map(|(_, _, r)| r.as_str()).collect::<String>()
    );
    let c_auto: String = format!(
        "<office:automatic-styles>{}</office:automatic-styles>",
        autos.iter().filter(|(_, el, _)| el != "style:page-layout").map(|(_, _, r)| r.as_str()).collect::<String>()
    );
    let part = |root_tag: &str, names: &[&str]| -> String {
        let mut inner = String::new();
        for &n in names {
            if n == "office:automatic-styles" {
                inner.push_str(if root_tag == "office:document-styles" { &s_auto } else { &c_auto });
            } else {
                inner.push_str(&get(n));
            }
        }
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<{root_tag}{at}>{inner}</{root_tag}>")
    };
    let content_xml = part("office:document-content", &["office:scripts", "office:font-face-decls", "office:automatic-styles", "office:body"]);
    let styles_xml = part("office:document-styles", &["office:font-face-decls", "office:styles", "office:automatic-styles", "office:master-styles"]);
    let meta_xml = part("office:document-meta", &["office:meta"]);
    let settings_xml = part("office:document-settings", &["office:settings"]);
    let manifest_xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"{ver}\">\
         <manifest:file-entry manifest:full-path=\"/\" manifest:version=\"{ver}\" manifest:media-type=\"{ODT_MIME}\"/>\
         <manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/>\
         <manifest:file-entry manifest:full-path=\"styles.xml\" manifest:media-type=\"text/xml\"/>\
         <manifest:file-entry manifest:full-path=\"meta.xml\" manifest:media-type=\"text/xml\"/>\
         <manifest:file-entry manifest:full-path=\"settings.xml\" manifest:media-type=\"text/xml\"/>\
         </manifest:manifest>"
    );
    Ok(zip_stored(&[
        ("mimetype", ODT_MIME.as_bytes()),
        ("content.xml", content_xml.as_bytes()),
        ("styles.xml", styles_xml.as_bytes()),
        ("meta.xml", meta_xml.as_bytes()),
        ("settings.xml", settings_xml.as_bytes()),
        ("META-INF/manifest.xml", manifest_xml.as_bytes()),
    ]))
}

// ---------------------------------------------------------------- Native editor operations on Doc

/// Address of an editable text block anywhere inside `Doc`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum BlockPath {
    Top(usize),
    ListItem { path: Box<BlockPath>, item: usize, block: usize },
    TableCell { path: Box<BlockPath>, row: usize, col: usize, block: usize },
    Section { path: Box<BlockPath>, block: usize },
}

/// Inline format flag toggled by toolbar / keyboard shortcuts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InlineFmt {
    Strong,
    Em,
    Underline,
    Strike,
}

fn default_fmt_props(fmt: InlineFmt) -> Vec<(String, String)> {
    match fmt {
        InlineFmt::Strong => vec![("fo:font-weight".into(), "bold".into()), ("style:font-weight-asian".into(), "bold".into()), ("style:font-weight-complex".into(), "bold".into())],
        InlineFmt::Em => vec![("fo:font-style".into(), "italic".into()), ("style:font-style-asian".into(), "italic".into()), ("style:font-style-complex".into(), "italic".into())],
        InlineFmt::Underline => vec![("style:text-underline-color".into(), "font-color".into()), ("style:text-underline-style".into(), "solid".into()), ("style:text-underline-width".into(), "auto".into())],
        InlineFmt::Strike => vec![("style:text-line-through-style".into(), "solid".into()), ("style:text-line-through-type".into(), "single".into())],
    }
}

/// Apply plain-text edits to an inline run list while preserving marks on
/// unchanged prefix/suffix and keeping any opaque inline nodes intact.
pub fn replace_inlines_text(inlines: &mut Vec<Inline>, new_text: &str) {
    let old_text = inlines_text(inlines);
    if old_text == new_text {
        return;
    }
    // Preserve any zero-width / opaque inlines so paired markers (bookmarks, annotations) are never dropped.
    let opaques: Vec<Inline> = inlines.iter().filter(|i| matches!(i, Inline::OpaqueInline { .. })).cloned().collect();
    if new_text.is_empty() {
        *inlines = opaques;
        return;
    }
    // If the entire block had one uniform mark set (common case), keep those marks!
    let uniform_marks = inlines
        .iter()
        .find_map(|i| match i {
            Inline::Text { marks, .. } => Some(marks.clone()),
            _ => None,
        })
        .unwrap_or_default();
    let all_same_marks = inlines.iter().all(|i| match i {
        Inline::Text { marks, .. } => *marks == uniform_marks,
        _ => true,
    });
    if all_same_marks {
        let mut next = Vec::new();
        for (li, line) in new_text.split('\n').enumerate() {
            if li > 0 {
                next.push(Inline::HardBreak { src: None, marks: uniform_marks.clone() });
            }
            if !line.is_empty() {
                next.push(Inline::Text { text: strip_not_xml(line), marks: uniform_marks.clone() });
            }
        }
        next.extend(opaques);
        *inlines = next;
        return;
    }
    // Mixed marks: diff common prefix and suffix on char boundaries so untouched formatted spans stay formatted!
    let old_bytes = old_text.as_bytes();
    let new_bytes = new_text.as_bytes();
    let mut pre = 0;
    while pre < old_bytes.len() && pre < new_bytes.len() && old_bytes[pre] == new_bytes[pre] {
        pre += 1;
    }
    while pre > 0 && (!old_text.is_char_boundary(pre) || !new_text.is_char_boundary(pre)) {
        pre -= 1;
    }
    let mut old_suf = old_bytes.len();
    let mut new_suf = new_bytes.len();
    while old_suf > pre && new_suf > pre && old_bytes[old_suf - 1] == new_bytes[new_suf - 1] {
        old_suf -= 1;
        new_suf -= 1;
    }
    while old_suf < old_bytes.len() && (!old_text.is_char_boundary(old_suf) || !new_text.is_char_boundary(new_suf)) {
        old_suf += 1;
        new_suf += 1;
    }
    let inserted = &new_text[pre..new_suf];
    let mut out = Vec::new();
    let mut off = 0usize;
    let mut inserted_done = false;
    let mut carry_marks = uniform_marks;
    for inl in inlines.drain(..) {
        match inl {
            Inline::Text { text, marks } => {
                let end = off + text.len();
                if end <= pre {
                    carry_marks = marks.clone();
                    Parser::push_text(&mut out, text, &marks);
                } else if off >= old_suf {
                    if !inserted_done {
                        if !inserted.is_empty() {
                            Parser::push_text(&mut out, strip_not_xml(inserted), &carry_marks);
                        }
                        inserted_done = true;
                    }
                    Parser::push_text(&mut out, text, &marks);
                } else {
                    if off < pre {
                        carry_marks = marks.clone();
                        Parser::push_text(&mut out, text[..pre - off].to_owned(), &marks);
                    }
                    if !inserted_done {
                        if !inserted.is_empty() {
                            Parser::push_text(&mut out, strip_not_xml(inserted), &carry_marks);
                        }
                        inserted_done = true;
                    }
                    if end > old_suf {
                        Parser::push_text(&mut out, text[old_suf - off..].to_owned(), &marks);
                    }
                }
                off = end;
            }
            Inline::HardBreak { src, marks } => {
                let end = off + 1;
                if end <= pre || off >= old_suf {
                    if off >= old_suf && !inserted_done {
                        if !inserted.is_empty() {
                            Parser::push_text(&mut out, strip_not_xml(inserted), &carry_marks);
                        }
                        inserted_done = true;
                    }
                    out.push(Inline::HardBreak { src, marks });
                }
                off = end;
            }
            Inline::OpaqueInline { src, raw, name, label, marks } => {
                let len = label.len();
                out.push(Inline::OpaqueInline { src, raw, name, label, marks });
                off += len;
            }
        }
    }
    if !inserted_done && !inserted.is_empty() {
        Parser::push_text(&mut out, strip_not_xml(inserted), &carry_marks);
    }
    *inlines = out;
}

/// Apply a transform to the marks of every text character in byte range `from..to`
/// (or the entire block if `from >= to`).
pub fn map_range_marks(inlines: &mut Vec<Inline>, from: usize, to: usize, mut f: impl FnMut(&mut Marks)) {
    let total = inlines_text(inlines).len();
    let (a, b) = if from < to && to <= total { (from, to) } else { (0, total) };
    let mut out = Vec::new();
    let mut off = 0usize;
    for inl in inlines.drain(..) {
        match inl {
            Inline::Text { text, marks } => {
                let end = off + text.len();
                if end <= a || off >= b {
                    Parser::push_text(&mut out, text, &marks);
                } else {
                    let s0 = a.saturating_sub(off);
                    let s1 = b.min(end) - off;
                    let s0 = clamp_char_boundary(&text, s0);
                    let s1 = clamp_char_boundary(&text, s1);
                    if s0 > 0 {
                        Parser::push_text(&mut out, text[..s0].to_owned(), &marks);
                    }
                    if s1 > s0 {
                        let mut m = marks.clone();
                        f(&mut m);
                        Parser::push_text(&mut out, text[s0..s1].to_owned(), &m);
                    }
                    if s1 < text.len() {
                        Parser::push_text(&mut out, text[s1..].to_owned(), &marks);
                    }
                }
                off = end;
            }
            Inline::HardBreak { src, mut marks } => {
                if off >= a && off < b {
                    f(&mut marks);
                }
                out.push(Inline::HardBreak { src, marks });
                off += 1;
            }
            Inline::OpaqueInline { src, raw, name, label, marks } => {
                let len = label.len();
                out.push(Inline::OpaqueInline { src, raw, name, label, marks });
                off += len;
            }
        }
    }
    *inlines = out;
}

fn clamp_char_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

impl Doc {
    pub fn first_editable_path(&self) -> Option<BlockPath> {
        fn find(blocks: &[Block], mk: &dyn Fn(usize) -> BlockPath) -> Option<BlockPath> {
            for (i, b) in blocks.iter().enumerate() {
                match b {
                    Block::Paragraph { .. } | Block::Heading { .. } => return Some(mk(i)),
                    Block::Section { blocks: sub, .. } => {
                        let p = mk(i);
                        if let Some(found) = find(sub, &move |bi| BlockPath::Section { path: Box::new(p.clone()), block: bi }) {
                            return Some(found);
                        }
                    }
                    Block::List { items, .. } => {
                        let p = mk(i);
                        for (ii, it) in items.iter().enumerate() {
                            let p2 = p.clone();
                            if let Some(found) = find(&it.blocks, &move |bi| BlockPath::ListItem { path: Box::new(p2.clone()), item: ii, block: bi }) {
                                return Some(found);
                            }
                        }
                    }
                    Block::Table { rows, .. } => {
                        let p = mk(i);
                        for (ri, r) in rows.iter().enumerate() {
                            for (ci, cell) in r.cells.iter().enumerate() {
                                let p2 = p.clone();
                                if let Some(found) = find(&cell.blocks, &move |bi| BlockPath::TableCell { path: Box::new(p2.clone()), row: ri, col: ci, block: bi }) {
                                    return Some(found);
                                }
                            }
                        }
                    }
                    Block::OpaqueBlock { .. } => {}
                }
            }
            None
        }
        find(&self.blocks, &BlockPath::Top)
    }

    pub fn block_at(&self, path: &BlockPath) -> Option<&Block> {
        match path {
            BlockPath::Top(i) => self.blocks.get(*i),
            BlockPath::ListItem { path, item, block } => match self.block_at(path)? {
                Block::List { items, .. } => items.get(*item)?.blocks.get(*block),
                _ => None,
            },
            BlockPath::TableCell { path, row, col, block } => match self.block_at(path)? {
                Block::Table { rows, .. } => rows.get(*row)?.cells.get(*col)?.blocks.get(*block),
                _ => None,
            },
            BlockPath::Section { path, block } => match self.block_at(path)? {
                Block::Section { blocks, .. } => blocks.get(*block),
                _ => None,
            },
        }
    }

    /// Mutably borrow the block at `path`, invalidating `src` spans on the path
    /// so `serialize_fodt` rewrites only the modified block and its direct container chain.
    pub fn block_at_mut(&mut self, path: &BlockPath) -> Option<&mut Block> {
        fn clear_src(b: &mut Block) {
            match b {
                Block::Paragraph { src, .. }
                | Block::Heading { src, .. }
                | Block::List { src, .. }
                | Block::Table { src, .. }
                | Block::Section { src, .. }
                | Block::OpaqueBlock { src, .. } => *src = None,
            }
        }
        match path {
            BlockPath::Top(i) => self.blocks.get_mut(*i),
            BlockPath::ListItem { path, item, block } => {
                let parent = self.block_at_mut(path)?;
                clear_src(parent);
                match parent {
                    Block::List { items, .. } => {
                        let it = items.get_mut(*item)?;
                        it.src = None;
                        it.blocks.get_mut(*block)
                    }
                    _ => None,
                }
            }
            BlockPath::TableCell { path, row, col, block } => {
                let parent = self.block_at_mut(path)?;
                clear_src(parent);
                match parent {
                    Block::Table { rows, .. } => {
                        let r = rows.get_mut(*row)?;
                        r.src = None;
                        let c = r.cells.get_mut(*col)?;
                        c.src = None;
                        c.blocks.get_mut(*block)
                    }
                    _ => None,
                }
            }
            BlockPath::Section { path, block } => {
                let parent = self.block_at_mut(path)?;
                clear_src(parent);
                match parent {
                    Block::Section { blocks, .. } => blocks.get_mut(*block),
                    _ => None,
                }
            }
        }
    }

    pub fn set_block_text(&mut self, path: &BlockPath, text: &str) -> bool {
        let Some(b) = self.block_at_mut(path) else { return false };
        match b {
            Block::Paragraph { src, inlines, placeholder, .. } => {
                if inlines_text(inlines) == text {
                    return false;
                }
                *src = None;
                *placeholder = false;
                replace_inlines_text(inlines, text);
                true
            }
            Block::Heading { src, inlines, .. } => {
                if inlines_text(inlines) == text {
                    return false;
                }
                *src = None;
                replace_inlines_text(inlines, text);
                true
            }
            _ => false,
        }
    }

    pub fn toggle_inline_fmt(&mut self, path: &BlockPath, from: usize, to: usize, fmt: InlineFmt) -> bool {
        let Some(b) = self.block_at_mut(path) else { return false };
        let (Block::Paragraph { src, inlines, .. } | Block::Heading { src, inlines, .. }) = b else { return false };
        let total = inlines_text(inlines).len();
        let (a, z) = if from < to && to <= total { (from, to) } else { (0, total) };
        let has_on = |m: &Marks| match fmt {
            InlineFmt::Strong => m.strong.is_some(),
            InlineFmt::Em => m.em.is_some(),
            InlineFmt::Underline => m.underline.is_some(),
            InlineFmt::Strike => m.strike.is_some(),
        };
        let mut all_on = false;
        let mut saw_any = false;
        let mut off = 0;
        for inl in inlines.iter() {
            if let Inline::Text { text, marks } = inl {
                let end = off + text.len();
                if end > a && off < z {
                    if !saw_any {
                        all_on = has_on(marks);
                        saw_any = true;
                    } else {
                        all_on &= has_on(marks);
                    }
                }
                off = end;
            } else if let Inline::HardBreak { .. } = inl {
                off += 1;
            } else if let Inline::OpaqueInline { label, .. } = inl {
                off += label.len();
            }
        }
        let turn_on = !all_on;
        *src = None;
        map_range_marks(inlines, a, z, |m| {
            let slot = match fmt {
                InlineFmt::Strong => &mut m.strong,
                InlineFmt::Em => &mut m.em,
                InlineFmt::Underline => &mut m.underline,
                InlineFmt::Strike => &mut m.strike,
            };
            if turn_on {
                *slot = Some(default_fmt_props(fmt));
            } else {
                *slot = None;
            }
        });
        true
    }

    #[allow(dead_code)]
    pub fn set_char_style(&mut self, path: &BlockPath, from: usize, to: usize, style: Option<String>) -> bool {
        let Some(b) = self.block_at_mut(path) else { return false };
        let (Block::Paragraph { src, inlines, .. } | Block::Heading { src, inlines, .. }) = b else { return false };
        *src = None;
        map_range_marks(inlines, from, to, |m| {
            m.char_style = style.clone();
        });
        true
    }

    pub fn set_link(&mut self, path: &BlockPath, from: usize, to: usize, href: Option<String>) -> bool {
        let Some(b) = self.block_at_mut(path) else { return false };
        let (Block::Paragraph { src, inlines, .. } | Block::Heading { src, inlines, .. }) = b else { return false };
        *src = None;
        map_range_marks(inlines, from, to, |m| {
            m.link = href.as_ref().filter(|h| !h.trim().is_empty()).map(|h| LinkMark { href: h.trim().to_owned(), xattrs: Vec::new() });
        });
        true
    }

    pub fn set_block_kind(&mut self, path: &BlockPath, level: Option<u8>, style: Option<String>) -> bool {
        let is_quote = self.styles.is_quote(style.as_deref());
        let Some(b) = self.block_at_mut(path) else { return false };
        let (xattrs, page_break, inlines) = match std::mem::replace(
            b,
            Block::OpaqueBlock { src: None, raw: String::new(), name: String::new(), label: String::new() },
        ) {
            Block::Paragraph { xattrs, page_break, inlines, .. } => (xattrs, page_break, inlines),
            Block::Heading { xattrs, page_break, inlines, .. } => (xattrs, page_break, inlines),
            other => {
                *b = other;
                return false;
            }
        };
        *b = match level {
            Some(lv) => Block::Heading { src: None, xattrs, style, page_break, quote: is_quote, level: lv.clamp(1, 6), inlines },
            None => Block::Paragraph { src: None, xattrs, style, page_break, quote: is_quote, placeholder: false, inlines },
        };
        true
    }

    pub fn toggle_page_break(&mut self, path: &BlockPath) -> bool {
        let Some(b) = self.block_at_mut(path) else { return false };
        match b {
            Block::Paragraph { src, page_break, .. } | Block::Heading { src, page_break, .. } => {
                *src = None;
                *page_break = !*page_break;
                true
            }
            _ => false,
        }
    }

    pub fn toggle_quote(&mut self, path: &BlockPath) -> bool {
        let body = self.styles.body_style();
        let Some(b) = self.block_at(path) else { return false };
        let was_quote = matches!(b, Block::Paragraph { quote: true, .. } | Block::Heading { quote: true, .. });
        let next_style = if was_quote { body } else { Some("Quotations".into()) };
        self.set_block_kind(path, None, next_style)
    }

    pub fn insert_paragraph_after(&mut self, top_idx: usize) -> BlockPath {
        let style = self.styles.body_style();
        let at = (top_idx + 1).min(self.blocks.len());
        self.blocks.insert(
            at,
            Block::Paragraph { src: None, xattrs: Vec::new(), style, page_break: false, quote: false, placeholder: false, inlines: Vec::new() },
        );
        BlockPath::Top(at)
    }

    pub fn toggle_top_list(&mut self, top_idx: usize, kind: &str) -> Option<BlockPath> {
        let cur = self.blocks.get(top_idx)?;
        match cur {
            Block::List { items, .. } => {
                let lifted: Vec<Block> = items.iter().flat_map(|it| it.blocks.clone()).collect();
                if lifted.is_empty() {
                    return None;
                }
                self.blocks.splice(top_idx..=top_idx, lifted);
                Some(BlockPath::Top(top_idx))
            }
            Block::Paragraph { .. } | Block::Heading { .. } => {
                let b = self.blocks.remove(top_idx);
                let mut xattrs = Vec::new();
                if let Some(st) = self.styles.first_list_style(kind) {
                    xattrs.push(("text:style-name".into(), esc_attr(&st)));
                }
                self.blocks.insert(
                    top_idx,
                    Block::List { src: None, xattrs, items: vec![ListItem { src: None, xattrs: Vec::new(), header: false, blocks: vec![b] }] },
                );
                Some(BlockPath::ListItem { path: Box::new(BlockPath::Top(top_idx)), item: 0, block: 0 })
            }
            _ => None,
        }
    }

    pub fn add_list_item(&mut self, list_top: usize, after_item: usize) -> Option<BlockPath> {
        let style = self.styles.body_style();
        let Block::List { src, items, .. } = self.blocks.get_mut(list_top)? else { return None };
        *src = None;
        let at = (after_item + 1).min(items.len());
        items.insert(
            at,
            ListItem {
                src: None,
                xattrs: Vec::new(),
                header: false,
                blocks: vec![Block::Paragraph { src: None, xattrs: Vec::new(), style, page_break: false, quote: false, placeholder: false, inlines: Vec::new() }],
            },
        );
        Some(BlockPath::ListItem { path: Box::new(BlockPath::Top(list_top)), item: at, block: 0 })
    }

    pub fn insert_table_after(&mut self, top_idx: usize, cols: usize, rows_count: usize) -> BlockPath {
        let cols = cols.clamp(1, 10);
        let rows_count = rows_count.clamp(1, 20);
        let style = self.styles.body_style();
        let make_cell = || TableCell {
            src: None,
            xattrs: vec![("office:value-type".into(), "string".into())],
            blocks: vec![Block::Paragraph { src: None, xattrs: Vec::new(), style: style.clone(), page_break: false, quote: false, placeholder: false, inlines: Vec::new() }],
        };
        let rows: Vec<TableRow> = (0..rows_count)
            .map(|r| TableRow { src: None, xattrs: Vec::new(), header: r == 0, cells: (0..cols).map(|_| make_cell()).collect() })
            .collect();
        let at = (top_idx + 1).min(self.blocks.len());
        self.blocks.insert(at, Block::Table { src: None, xattrs: Vec::new(), pre: None, hdr: None, rows });
        BlockPath::TableCell { path: Box::new(BlockPath::Top(at)), row: 0, col: 0, block: 0 }
    }

    pub fn table_add_row(&mut self, table_top: usize, after_row: usize) -> Option<BlockPath> {
        let style = self.styles.body_style();
        let Block::Table { src, rows, .. } = self.blocks.get_mut(table_top)? else { return None };
        *src = None;
        let cols = rows.first().map_or(2, |r| r.cells.len().max(1));
        let cells: Vec<TableCell> = (0..cols)
            .map(|_| TableCell {
                src: None,
                xattrs: vec![("office:value-type".into(), "string".into())],
                blocks: vec![Block::Paragraph { src: None, xattrs: Vec::new(), style: style.clone(), page_break: false, quote: false, placeholder: false, inlines: Vec::new() }],
            })
            .collect();
        let at = (after_row + 1).min(rows.len());
        rows.insert(at, TableRow { src: None, xattrs: Vec::new(), header: false, cells });
        Some(BlockPath::TableCell { path: Box::new(BlockPath::Top(table_top)), row: at, col: 0, block: 0 })
    }

    pub fn table_del_row(&mut self, table_top: usize, row_idx: usize) -> bool {
        let Some(Block::Table { src, rows, .. }) = self.blocks.get_mut(table_top) else { return false };
        if rows.len() <= 1 || row_idx >= rows.len() {
            return false;
        }
        *src = None;
        rows.remove(row_idx);
        true
    }

    pub fn delete_top_block(&mut self, top_idx: usize) -> bool {
        if self.blocks.len() <= 1 || top_idx >= self.blocks.len() {
            return false;
        }
        self.blocks.remove(top_idx);
        true
    }
}

/// Top-level block index for any `BlockPath`.
pub fn top_index(p: &BlockPath) -> usize {
    match p {
        BlockPath::Top(i) => *i,
        BlockPath::ListItem { path, .. } | BlockPath::TableCell { path, .. } | BlockPath::Section { path, .. } => top_index(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_fodt_parses_and_round_trips_byte_for_byte() {
        let doc = parse_fodt(BLANK_FODT).expect("blank.fodt parses");
        assert!(!doc.tracking);
        assert!(!doc.macros);
        let out = serialize_fodt(&doc).expect("blank.fodt serializes");
        assert_eq!(out, BLANK_FODT, "no-edit round-trip must be byte-identical");
    }

    #[test]
    fn all_libreoffice_corpus_files_round_trip_byte_for_byte() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/writer/corpus");
        if !dir.exists() {
            return;
        }
        let mut checked = 0usize;
        let mut entries: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("fodt") {
                continue;
            }
            let src = std::fs::read_to_string(&path).unwrap();
            let doc = parse_fodt(&src).unwrap_or_else(|e| panic!("{} failed to parse: {e}", path.display()));
            let out = serialize_fodt(&doc).unwrap_or_else(|e| panic!("{} failed to serialize: {e}", path.display()));
            assert_eq!(out, src, "{} did not round-trip byte-for-byte", path.display());
            checked += 1;
        }
        assert!(checked >= 14, "expected all 14 corpus files, checked {checked}");
    }

    #[test]
    fn hostile_files_are_refused_or_sanitized() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/writer/corpus/hostile");
        if !dir.exists() {
            return;
        }
        for name in ["doctype-entity.fodt", "billion-laughs.fodt", "external-entity.fodt", "deep-nesting.fodt", "space-bomb.fodt"] {
            let src = std::fs::read_to_string(dir.join(name)).unwrap();
            assert!(parse_fodt(&src).is_err(), "{name} must be refused");
        }
        // Style injection and bad links must never produce unsafe CSS or javascript: hrefs in rendered HTML.
        let style_inj = std::fs::read_to_string(dir.join("style-injection.fodt")).unwrap();
        let html = render_html(&style_inj, "test", true).unwrap();
        assert!(
            !html.contains("evil.example")
                && !html.contains("expression(")
                && !html.contains("window.__PWNED")
                && !html.contains("x.htc")
                && !html.contains("javascript:")
                && !html.contains("<script")
                && !html.contains("onerror="),
            "CSS injection leaked: {html}"
        );
        // Verify no inline style attribute contains url( either (body text itself mentions "url(").
        for part in html.split("style=\"").skip(1) {
            let val = part.split('"').next().unwrap_or("");
            assert!(!val.contains("url("), "url( leaked into style attr: {val}");
        }

        let bad_links = std::fs::read_to_string(dir.join("bad-links.fodt")).unwrap();
        let html = render_html(&bad_links, "test", false).unwrap();
        assert!(!html.contains("javascript:") && !html.contains("file:///") && !html.contains("vnd.sun.star.script:"), "unsafe link leaked");

        let script_iframe = std::fs::read_to_string(dir.join("script-iframe.fodt")).unwrap();
        let html = render_html(&script_iframe, "test", false).unwrap();
        assert!(!html.contains("<script") && !html.contains("<iframe"), "raw script/iframe leaked");
    }

    #[test]
    fn minimal_diff_edit_and_bold_auto_style_generation() {
        let mut doc = parse_fodt(BLANK_FODT).unwrap();
        let p0 = doc.first_editable_path().expect("blank.fodt has a paragraph");
        assert!(doc.set_block_text(&p0, "Hello Writer world"));
        assert!(doc.toggle_inline_fmt(&p0, 6, 12, InlineFmt::Strong));
        let saved = serialize_fodt(&doc).unwrap();
        assert!(saved.contains("Hello <text:span text:style-name=\"LT"), "expected LT<hash8> automatic style: {saved}");
        assert!(saved.contains(">Writer</text:span> world"));
        assert!(saved.contains("fo:font-weight=\"bold\""));
        // Re-parsing preserves the bold run and round-trips cleanly.
        let again = parse_fodt(&saved).unwrap();
        assert_eq!(serialize_fodt(&again).unwrap(), saved);
    }

    #[test]
    fn paired_marker_half_deletion_is_refused() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/writer/corpus/10-unknown.fodt");
        if !dir.exists() {
            return;
        }
        let src = std::fs::read_to_string(dir).unwrap();
        let mut doc = parse_fodt(&src).unwrap();
        assert!(doc.tracking, "10-unknown.fodt has tracked changes");
        assert!(doc.macros, "10-unknown.fodt has embedded macros");
        // Drop a block containing a bookmark-start / change-start without its matching end.
        let idx = doc.blocks.iter().position(|b| match b {
            Block::Paragraph { inlines, .. } => inlines.iter().any(|i| matches!(i, Inline::OpaqueInline { raw, .. } if raw.contains("bookmark-start"))),
            _ => false,
        });
        if let Some(i) = idx {
            doc.blocks.remove(i);
            let err = serialize_fodt(&doc).unwrap_err();
            assert!(err.contains("refused"), "{err}");
        }
    }

    #[test]
    fn outline_links_and_odt_export_round_trip() {
        let mut doc = parse_fodt(BLANK_FODT).unwrap();
        let p0 = doc.first_editable_path().expect("blank.fodt has a paragraph");
        assert!(doc.set_block_text(&p0, "Intro"));
        assert!(doc.set_block_kind(&p0, Some(1), doc.styles.heading_style(1)));
        let p2 = doc.insert_paragraph_after(top_index(&p0));
        assert!(doc.set_block_text(&p2, "Visit example"));
        assert!(doc.set_link(&p2, 6, 13, Some("https://example.org".into())));
        let saved = serialize_fodt(&doc).unwrap();
        assert_eq!(fodt_outline(&saved), vec![(1, "Intro".into(), 0)]);
        assert_eq!(fodt_links(&saved), vec!["https://example.org".to_owned()]);
        // Export to .odt zip and re-import through crate::odf::import!
        let odt = export_odt(&saved).unwrap();
        assert!(odt.starts_with(b"PK\x03\x04"));
        let re = crate::odf::import(&odt, "odt").expect("exported .odt re-imports cleanly");
        assert_eq!(re.kind, "fodt");
        assert!(fodt_text(&re.text).contains("Intro"));
        assert!(fodt_text(&re.text).contains("Visit example"));
    }
}
