//! An `.odt` or `.ods` package folded into the one flat document
//! LibreOffice writes as flat ODT or flat ODS, which is what a `fodt` or
//! `fods` page holds. A port of the web client's importer
//! (`ui-src/writer/odt.js`): the roots' namespaces, then meta, settings,
//! font faces merged by name, styles, automatic styles, master styles and
//! the body. Pictures, embedded objects and macros are left out, and the
//! note says so.

use std::collections::{HashMap, HashSet};
use std::io::Read;

/// What one entry may inflate to, and what the whole document may come to.
const ENTRY_MAX: usize = 16 * 1024 * 1024;
const SIZE_MAX: usize = 8 * 1024 * 1024;

pub struct Flat {
    /// `fodt` or `fods`.
    pub kind: &'static str,
    pub text: String,
    /// What was left behind, or empty.
    pub note: String,
}

struct Entry {
    flags: u16,
    method: u16,
    csize: usize,
    size: usize,
    local: usize,
}

fn u16_at(b: &[u8], i: usize) -> Option<usize> {
    Some(usize::from(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?)))
}

fn u32_at(b: &[u8], i: usize) -> Option<usize> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?) as usize)
}

/// The entries of a zip, from its central directory, in its order.
fn entries(b: &[u8]) -> Result<Vec<(String, Entry)>, String> {
    let from = b.len().checked_sub(22).ok_or("this is not a zip file")?;
    let eocd = (from.saturating_sub(65_535)..=from).rev().find(|&i| u32_at(b, i) == Some(0x0605_4b50)).ok_or("this is not a zip file")?;
    let damaged = || "its zip directory is damaged".to_owned();
    let n = u16_at(b, eocd + 10).ok_or_else(damaged)?;
    let mut p = u32_at(b, eocd + 16).ok_or_else(damaged)?;
    let mut out = Vec::new();
    for _ in 0..n {
        if u32_at(b, p) != Some(0x0201_4b50) {
            return Err(damaged());
        }
        let field = |at: usize| u16_at(b, p + at).ok_or_else(damaged);
        let (nl, xl, cl) = (field(28)?, field(30)?, field(32)?);
        let e = Entry { flags: field(8)? as u16, method: field(10)? as u16, csize: u32_at(b, p + 20).ok_or_else(damaged)?, size: u32_at(b, p + 24).ok_or_else(damaged)?, local: u32_at(b, p + 42).ok_or_else(damaged)? };
        let name = String::from_utf8_lossy(b.get(p + 46..p + 46 + nl).ok_or_else(damaged)?).into_owned();
        out.push((name, e));
        p += 46 + nl + xl + cl;
    }
    Ok(out)
}

/// An entry's bytes, inflated, never past its stated size or `ENTRY_MAX`.
fn bytes(b: &[u8], e: &Entry) -> Result<Vec<u8>, String> {
    if e.flags & 1 != 0 {
        return Err("it is password protected".into());
    }
    if e.csize == 0xffff_ffff || e.size == 0xffff_ffff {
        return Err("it is a zip64 file".into());
    }
    if e.size > ENTRY_MAX {
        return Err("it is too large to import".into());
    }
    let damaged = || "its zip entries are damaged".to_owned();
    if u32_at(b, e.local) != Some(0x0403_4b50) {
        return Err(damaged());
    }
    let at = e.local + 30 + u16_at(b, e.local + 26).ok_or_else(damaged)? + u16_at(b, e.local + 28).ok_or_else(damaged)?;
    let raw = b.get(at..at + e.csize).ok_or("it is cut short")?;
    match e.method {
        0 => Ok(raw.to_vec()),
        8 => {
            let mut out = Vec::with_capacity(e.size);
            // one byte more than stated shows an entry that inflates past it
            flate2::read::DeflateDecoder::new(raw).take(e.size as u64 + 1).read_to_end(&mut out).map_err(|_| "its zip entries are damaged".to_owned())?;
            if out.len() > e.size {
                return Err("it inflates past its stated size".into());
            }
            Ok(out)
        }
        _ => Err("it uses a compression lattice cannot read".into()),
    }
}

/// An element: its name and where it sits in its source.
#[derive(Clone, Debug)]
pub(crate) struct El {
    pub(crate) name: String,
    pub(crate) start: usize,
    /// The end of its opening tag.
    pub(crate) open_end: usize,
    pub(crate) end: usize,
}

/// The end of the tag that starts at `at`, past any `>` inside a quoted value.
pub(crate) fn tag_end(src: &str, at: usize) -> Option<usize> {
    let mut quote = None;
    for (i, ch) in src[at..].char_indices() {
        match (quote, ch) {
            (None, '"' | '\'') => quote = Some(ch),
            (Some(q), c) if c == q => quote = None,
            (None, '>') => return Some(at + i + 1),
            _ => {}
        }
    }
    None
}

/// The elements directly inside `src[from..to]`.
pub(crate) fn elements(src: &str, from: usize, to: usize) -> Result<Vec<El>, String> {
    let bad = || "it is not well-formed XML".to_owned();
    let (mut out, mut open): (Vec<El>, Option<El>) = (Vec::new(), None);
    let (mut depth, mut i) = (0usize, from);
    while let Some(lt) = src[i..to].find('<') {
        let at = i + lt;
        let rest = &src[at..to];
        let skip = |end: &str| rest.find(end).map(|e| at + e + end.len()).ok_or_else(bad);
        if rest.starts_with("<!--") {
            i = skip("-->")?;
        } else if rest.starts_with("<?") {
            i = skip("?>")?;
        } else if rest.starts_with("<![CDATA[") {
            i = skip("]]>")?;
        } else if rest.starts_with("<!") {
            // a DOCTYPE can define entities, and nothing LibreOffice writes has one
            return Err("it has a DOCTYPE".into());
        } else if rest.starts_with("</") {
            let end = tag_end(src, at).filter(|&e| e <= to).ok_or_else(bad)?;
            depth = depth.checked_sub(1).ok_or_else(bad)?;
            if depth == 0 {
                let mut el = open.take().ok_or_else(bad)?;
                el.end = end;
                out.push(el);
            }
            i = end;
        } else {
            let end = tag_end(src, at).filter(|&e| e <= to).ok_or_else(bad)?;
            let empty = src[at..end].ends_with("/>");
            if depth == 0 {
                let name = src[at + 1..end].split(|c: char| c.is_whitespace() || c == '/' || c == '>').next().unwrap_or("").to_owned();
                let el = El { name, start: at, open_end: end, end };
                if empty {
                    out.push(el);
                } else {
                    open = Some(el);
                }
            }
            if !empty {
                depth += 1;
                if depth > 256 {
                    return Err("it is nested too deeply".into());
                }
            }
            i = end;
        }
    }
    if depth != 0 {
        return Err(bad());
    }
    Ok(out)
}

/// A tag's attributes, one after another: each name, and where its
/// value sits in the tag, between quotes of either kind. Every reader
/// of an attribute goes through this, so that a tag is read one way.
pub(crate) fn each_attr(tag: &str) -> impl Iterator<Item = (&str, std::ops::Range<usize>)> + '_ {
    let b = tag.as_bytes();
    let mut i = tag.find(|c: char| c.is_whitespace()).unwrap_or(tag.len());
    std::iter::from_fn(move || {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/' || b[i] == b'>') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i] != b'=' && !b[i].is_ascii_whitespace() {
            i += 1;
        }
        let name = &tag[start..i];
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'=') {
            i += 1;
        }
        let Some(&q) = b.get(i).filter(|q| **q == b'"' || **q == b'\'') else {
            // nothing more is read of a tag that is not well formed
            i = b.len();
            return None;
        };
        let from = i + 1;
        let Some(len) = tag[from..].find(q as char) else {
            i = b.len();
            return None;
        };
        i = from + len + 1;
        Some((name, from..from + len))
    })
}

/// A tag's attributes: each name, and where its value sits in the tag.
pub(crate) fn attrs(tag: &str) -> Vec<(&str, std::ops::Range<usize>)> {
    each_attr(tag).collect()
}

fn attr<'a>(src: &'a str, el: &El, name: &str) -> Option<&'a str> {
    let tag = &src[el.start..el.open_end];
    attrs(tag).into_iter().find(|a| a.0 == name).map(|a| &tag[a.1])
}

/// `xml` with each attribute's value passed through `f`, which answers a
/// new value or leaves it. Only tags are looked at, never text.
fn rewrite(xml: &str, f: &dyn Fn(&str, &str) -> Option<String>) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut i = 0;
    while let Some(lt) = xml[i..].find('<') {
        let at = i + lt;
        out.push_str(&xml[i..at]);
        let end = tag_end(xml, at).unwrap_or(xml.len());
        let tag = &xml[at..end];
        let mut done = 0;
        if !tag.starts_with("</") && !tag.starts_with("<!") && !tag.starts_with("<?") {
            for (name, range) in attrs(tag) {
                if let Some(new) = f(name, &tag[range.clone()]) {
                    out.push_str(&tag[done..range.start]);
                    out.push_str(&new);
                    done = range.end;
                }
            }
        }
        out.push_str(&tag[done..]);
        i = end;
    }
    out.push_str(&xml[i..]);
    out
}

/// What is inside an element's text: without its own tags, or nothing
/// for one that closes itself.
fn inner(xml: &str) -> &str {
    if xml.is_empty() || xml.ends_with("/>") && tag_end(xml, 0) == Some(xml.len()) {
        return "";
    }
    let from = tag_end(xml, 0).unwrap_or(0);
    let to = xml.rfind("</").unwrap_or(xml.len());
    xml.get(from..to).unwrap_or("")
}

/// One of the package's four XML parts: its text, its root, and the
/// elements directly inside the root.
struct Part {
    src: String,
    root: El,
    kids: Vec<El>,
}

impl Part {
    fn read(name: &str, want: &str, src: String) -> Result<Part, String> {
        let root = elements(&src, 0, src.len()).map_err(|e| format!("{name}: {e}"))?.into_iter().next().filter(|r| r.name == want).ok_or(format!("{name} is not {want}"))?;
        let kids = if root.open_end == root.end { Vec::new() } else { elements(&src, root.open_end, src[..root.end].rfind("</").unwrap_or(root.end)).map_err(|e| format!("{name}: {e}"))? };
        Ok(Part { src, root, kids })
    }

    fn child(&self, name: &str) -> Option<&El> {
        self.kids.iter().find(|k| k.name == name)
    }

    /// A child's whole text, or nothing.
    fn get(&self, name: &str) -> &str {
        self.child(name).map_or("", |k| &self.src[k.start..k.end])
    }

    /// The elements inside a child, each with its `style:name`.
    fn named(&self, name: &str) -> Vec<(String, &str)> {
        let Some(k) = self.child(name).filter(|k| k.open_end != k.end) else { return Vec::new() };
        let to = self.src[..k.end].rfind("</").unwrap_or(k.end);
        elements(&self.src, k.open_end, to).unwrap_or_default().iter().map(|e| (attr(&self.src, e, "style:name").unwrap_or("").to_owned(), &self.src[e.start..e.end])).collect()
    }
}

/// The flat document a package folds into. `ext` is the file's
/// extension, which must agree with what the package says it is.
pub fn import(b: &[u8], ext: &str) -> Result<Flat, String> {
    let (mime, kind, name) = match ext.to_ascii_lowercase().as_str() {
        "odt" => ("application/vnd.oasis.opendocument.text", "fodt", "a Writer document"),
        "ods" => ("application/vnd.oasis.opendocument.spreadsheet", "fods", "a spreadsheet"),
        _ => return Err("it is not an .odt or an .ods".into()),
    };
    let ents = entries(b)?;
    let find = |n: &str| ents.iter().find(|e| e.0 == n).map(|e| &e.1);
    let mut total = 0;
    let mut take = |e: &Entry| -> Result<String, String> {
        let raw = bytes(b, e)?;
        total += raw.len();
        if total > SIZE_MAX {
            return Err("it is too large to import".into());
        }
        String::from_utf8(raw).map_err(|_| "it is not text".to_owned())
    };
    let says = find("mimetype").map(&mut take).transpose()?;
    if says.as_deref().map(str::trim) != Some(mime) {
        return Err(format!("it is not {name}"));
    }
    let mut part = |file: &str, root: &str| -> Result<Option<Part>, String> { find(file).map(|e| Part::read(file, root, take(e)?)).transpose() };
    let c = part("content.xml", "office:document-content")?.ok_or("it has no content.xml")?;
    let s = part("styles.xml", "office:document-styles")?;
    let m = part("meta.xml", "office:document-meta")?;
    let g = part("settings.xml", "office:document-settings")?;

    // the root: every namespace any part declares, then version and mimetype
    let mut head = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\n<office:document");
    let mut seen = HashSet::new();
    for p in [Some(&c), s.as_ref(), m.as_ref(), g.as_ref()].into_iter().flatten() {
        let tag = &p.src[p.root.start..p.root.open_end];
        for (k, v) in attrs(tag) {
            if k.starts_with("xmlns:") && seen.insert(k.to_owned()) {
                head.push_str(&format!(" {k}=\"{}\"", &tag[v]));
            }
        }
    }
    if let Some(ver) = attr(&c.src, &c.root, "office:version") {
        head.push_str(&format!(" office:version=\"{ver}\""));
    }
    head.push_str(&format!(" office:mimetype=\"{mime}\">\n "));

    // styles.xml and content.xml keep their automatic styles in separate name
    // scopes, so a styles.xml name that content.xml also uses gets a new one
    let (mut s_auto, mut s_master) = s.as_ref().map_or((String::new(), String::new()), |s| (s.get("office:automatic-styles").to_owned(), s.get("office:master-styles").to_owned()));
    if let Some(s) = &s {
        let taken: HashSet<String> = c.named("office:automatic-styles").into_iter().map(|n| n.0).collect();
        let mine: HashSet<String> = s.named("office:automatic-styles").into_iter().map(|n| n.0).collect();
        let mut ren: HashMap<&str, String> = HashMap::new();
        for n in mine.iter().filter(|n| !n.is_empty() && taken.contains(*n)) {
            let mut k = 1;
            while taken.contains(&format!("M{n}_{k}")) || mine.contains(&format!("M{n}_{k}")) {
                k += 1;
            }
            ren.insert(n, format!("M{n}_{k}"));
        }
        if !ren.is_empty() {
            // every attribute that names a style, the page layout, and the style's own name
            let fix = |name: &str, v: &str| {
                let names_style = name == "style:name" || name == "style:page-layout-name" || name.contains(':') && name.ends_with("style-name");
                ren.get(v).filter(|_| names_style).cloned()
            };
            s_auto = rewrite(&s_auto, &fix);
            s_master = rewrite(&s_master, &fix);
        }
    }
    // font faces: styles.xml's, then content.xml's not already there
    let mut faces = String::new();
    let mut have = HashSet::new();
    for p in [s.as_ref(), Some(&c)].into_iter().flatten() {
        for (n, text) in p.named("office:font-face-decls") {
            if have.insert(n) {
                faces.push_str(text);
            }
        }
    }
    let c_auto = c.get("office:automatic-styles");
    let auto = if s_auto.is_empty() && c_auto.is_empty() { String::new() } else { format!("<office:automatic-styles>{}{}</office:automatic-styles>", inner(&s_auto), inner(c_auto)) };
    let faces = if faces.is_empty() { String::new() } else { format!("<office:font-face-decls>{faces}</office:font-face-decls>") };
    let body: Vec<&str> = [
        m.as_ref().map_or("", |m| m.get("office:meta")),
        g.as_ref().map_or("", |g| g.get("office:settings")),
        c.get("office:scripts"),
        &faces,
        s.as_ref().map_or("", |s| s.get("office:styles")),
        &auto,
        &s_master,
        c.get("office:body"),
    ]
    .into_iter()
    .filter(|p| !p.is_empty())
    .collect();
    // LibreOffice reads a relative link in a package from inside it and in a
    // flat file from beside it, so the same target is one ../ nearer here
    let body = rewrite(&body.join("\n "), &|name, v| v.strip_prefix("../").filter(|_| name == "xlink:href").map(str::to_owned));
    let text = format!("{head}{body}\n</office:document>\n");
    // what was put together must itself be one well-formed document
    if elements(&text, 0, text.len())?.len() != 1 {
        return Err("it did not fold into one document".into());
    }

    // what stays behind: pictures, embedded objects, macros
    let kept = |n: &str| matches!(n, "mimetype" | "content.xml" | "styles.xml" | "meta.xml" | "settings.xml" | "manifest.rdf" | "layout-cache") || n.ends_with('/') || ["META-INF/", "Thumbnails/", "Configurations2/"].iter().any(|d| n.starts_with(d));
    let dropped: Vec<&str> = ents.iter().map(|e| e.0.as_str()).filter(|n| !kept(n)).collect();
    let pics = dropped.iter().filter(|n| n.starts_with("Pictures/")).count();
    let macros = dropped.iter().filter(|n| n.starts_with("Basic/")).count();
    let other = dropped.len() - pics - macros;
    let mut left = Vec::new();
    for (n, one, many) in [(pics, "picture", "pictures"), (macros, "macro file", "macro files"), (other, "other file", "other files")] {
        if n > 0 {
            left.push(format!("{n} {}", if n == 1 { one } else { many }));
        }
    }
    let note = if left.is_empty() { String::new() } else { format!("left out {}", left.join(", ")) };
    Ok(Flat { kind, text, note })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A zip of these files: stored, or deflated when `deflate`.
    fn zip(files: &[(&str, &str)], deflate: bool) -> Vec<u8> {
        let (mut out, mut dir) = (Vec::new(), Vec::new());
        for (name, text) in files {
            let data = if deflate {
                let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(text.as_bytes()).unwrap();
                e.finish().unwrap()
            } else {
                text.as_bytes().to_vec()
            };
            let at = out.len() as u32;
            let method: u16 = if deflate { 8 } else { 0 };
            let head = |sig: u32, extra: &[u8]| {
                let mut h = sig.to_le_bytes().to_vec();
                h.extend_from_slice(extra);
                h.extend_from_slice(&[20, 0, 0, 0]);
                h.extend_from_slice(&method.to_le_bytes());
                h.extend_from_slice(&[0; 8]);
                h.extend_from_slice(&(data.len() as u32).to_le_bytes());
                h.extend_from_slice(&(text.len() as u32).to_le_bytes());
                h.extend_from_slice(&(name.len() as u16).to_le_bytes());
                h.extend_from_slice(&[0, 0]);
                h
            };
            out.extend(head(0x0403_4b50, &[]));
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&data);
            dir.extend(head(0x0201_4b50, &[20, 0]));
            dir.extend_from_slice(&[0; 10]);
            dir.extend_from_slice(&at.to_le_bytes());
            dir.extend_from_slice(name.as_bytes());
        }
        let at = out.len() as u32;
        let n = files.len() as u16;
        out.extend_from_slice(&dir);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&(dir.len() as u32).to_le_bytes());
        out.extend_from_slice(&at.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    const ODT: &str = "application/vnd.oasis.opendocument.text";
    const CONTENT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:o" xmlns:style="urn:s" xmlns:text="urn:t" xmlns:xlink="urn:x" office:version="1.3"><office:scripts/><office:font-face-decls><style:font-face style:name="Sans"/><style:font-face style:name="Mono"/></office:font-face-decls><office:automatic-styles><style:style style:name="P1" style:family="paragraph"/></office:automatic-styles><office:body><office:text><text:p text:style-name="P1">Hello <!-- a > b --> &amp; <text:a xlink:href="../other.odt">link</text:a></text:p></office:text></office:body></office:document-content>"#;
    const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:o" xmlns:style="urn:s" xmlns:fo="urn:fo"><office:font-face-decls><style:font-face style:name="Sans"/><style:font-face style:name="Serif"/></office:font-face-decls><office:styles><style:style style:name="Standard"/></office:styles><office:automatic-styles><style:style style:name="P1" style:family="paragraph"/><style:page-layout style:name="Mpm1"/></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="Mpm1"><style:header><text:p text:style-name="P1">head</text:p></style:header></style:master-page></office:master-styles></office:document-styles>"#;

    #[test]
    fn a_package_folds_into_one_flat_document() {
        for deflate in [false, true] {
            let z = zip(&[("mimetype", ODT), ("content.xml", CONTENT), ("styles.xml", STYLES), ("Pictures/a.png", "x"), ("Pictures/b.png", "y"), ("Basic/script-lc.xml", "<x/>"), ("META-INF/manifest.xml", "<m/>")], deflate);
            let f = import(&z, "odt").unwrap();
            assert_eq!(f.kind, "fodt");
            assert_eq!(f.note, "left out 2 pictures, 1 macro file");
            let t = &f.text;
            // one root with every namespace once, the version and the mimetype
            assert!(t.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\n<office:document xmlns:office=\"urn:o\" xmlns:style=\"urn:s\" xmlns:text=\"urn:t\" xmlns:xlink=\"urn:x\" xmlns:fo=\"urn:fo\" office:version=\"1.3\" office:mimetype=\"application/vnd.oasis.opendocument.text\">"), "{t}");
            assert!(t.ends_with("\n</office:document>\n"));
            // font faces by name, styles.xml's first
            assert!(t.contains(r#"<office:font-face-decls><style:font-face style:name="Sans"/><style:font-face style:name="Serif"/><style:font-face style:name="Mono"/></office:font-face-decls>"#));
            // the automatic style both parts call P1: the one from styles.xml is renamed, with its use in the header
            assert!(t.contains(r#"<office:automatic-styles><style:style style:name="MP1_1" style:family="paragraph"/><style:page-layout style:name="Mpm1"/><style:style style:name="P1" style:family="paragraph"/></office:automatic-styles>"#), "{t}");
            assert!(t.contains(r#"<style:header><text:p text:style-name="MP1_1">head</text:p>"#));
            assert!(t.contains(r#"style:page-layout-name="Mpm1""#));
            // the body is as it was, but for a relative link, which is one step nearer
            assert!(t.contains(r#"<text:p text:style-name="P1">Hello <!-- a > b --> &amp; <text:a xlink:href="other.odt">link</text:a></text:p>"#));
            // in the flat file's order
            let at = |s: &str| t.find(s).unwrap_or_else(|| panic!("no {s}"));
            assert!(at("<office:scripts/>") < at("<office:font-face-decls>") && at("<office:styles>") < at("<office:automatic-styles>") && at("<office:master-styles>") < at("<office:body>"));
        }
    }

    #[test]
    fn what_is_not_a_package_is_refused_with_why() {
        let err = |b: &[u8], ext: &str| import(b, ext).err().unwrap();
        assert_eq!(err(b"not a zip at all, just some text", "odt"), "this is not a zip file");
        assert_eq!(err(b"", "odt"), "this is not a zip file");
        let ok = zip(&[("mimetype", ODT), ("content.xml", CONTENT)], false);
        assert!(import(&ok, "odt").unwrap().note.is_empty(), "styles.xml is not needed");
        assert_eq!(err(&ok, "ods"), "it is not a spreadsheet");
        assert_eq!(err(&ok, "docx"), "it is not an .odt or an .ods");
        assert_eq!(err(&zip(&[("mimetype", ODT)], false), "odt"), "it has no content.xml");
        assert_eq!(err(&zip(&[("mimetype", ODT), ("content.xml", "<office:document-styles/>")], false), "odt"), "content.xml is not office:document-content");
        assert_eq!(err(&zip(&[("mimetype", ODT), ("content.xml", "<!DOCTYPE x><office:document-content/>")], false), "odt"), "content.xml: it has a DOCTYPE");
        assert_eq!(err(&zip(&[("mimetype", ODT), ("content.xml", "<office:document-content><a></office:document-content>")], false), "odt"), "content.xml: it is not well-formed XML");
        // cut short, and a damaged directory: an error, never a panic
        for cut in [ok.len() - 1, ok.len() - 30, 40, 5] {
            assert!(import(&ok[..cut], "odt").is_err());
        }
        // an entry that inflates past its stated size
        let mut bomb = zip(&[("mimetype", ODT), ("content.xml", CONTENT)], true);
        let dir = bomb.windows(4).rposition(|w| w == 0x0201_4b50u32.to_le_bytes()).unwrap();
        bomb[dir + 24..dir + 28].copy_from_slice(&10u32.to_le_bytes());
        assert_eq!(err(&bomb, "odt"), "it inflates past its stated size");
    }

    /// A real file, to check against LibreOffice by hand:
    /// `LATTICE_ODF_IN=a.odt LATTICE_ODF_OUT=a.fodt cargo test -- --ignored real_package`.
    #[test]
    #[ignore]
    fn real_package() {
        let from = std::env::var("LATTICE_ODF_IN").unwrap();
        let ext = from.rsplit('.').next().unwrap().to_owned();
        let flat = import(&std::fs::read(&from).unwrap(), &ext).unwrap();
        println!("kind {} note {:?} bytes {}", flat.kind, flat.note, flat.text.len());
        std::fs::write(std::env::var("LATTICE_ODF_OUT").unwrap(), flat.text).unwrap();
    }

    #[test]
    fn tags_are_read_past_quotes_and_only_tags_are_rewritten() {
        assert_eq!(tag_end(r#"<a b="x>y" c='>'>rest"#, 0), Some(17));
        let tag = r#"<a:b  one="1" two = '2' three="">"#;
        let got: Vec<(&str, &str)> = attrs(tag).into_iter().map(|(n, r)| (n, &tag[r])).collect();
        assert_eq!(got, [("one", "1"), ("two", "2"), ("three", "")]);
        let xml = r#"<p n="a">n="a" <q n="b"/></p>"#;
        assert_eq!(rewrite(xml, &|_, v| (v == "a").then(|| "z".to_owned())), r#"<p n="z">n="a" <q n="b"/></p>"#);
        assert_eq!(inner("<a x=\"1\"><b/>t</a>"), "<b/>t");
        assert_eq!(inner("<a/>"), "");
        assert_eq!(inner(""), "");
    }
}
