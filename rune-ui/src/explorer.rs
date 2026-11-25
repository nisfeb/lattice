//! Native tree explorer for `/apps/lattice/x/<ship>/<path>`, parsing
//! the ship's `+explore` HTML responses (`+explore-dir-html`,
//! `+explore-file-html`, `+explore-refused`) into structured views:
//! breadcrumbs, directory entries, file previews, raw `?data` downloads,
//! and canonical `urb://` links.

/// One segment in the explorer's breadcrumb bar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Crumb {
    pub label: String,
    /// Full `/apps/lattice/x/...` path for navigating to this segment.
    pub href: String,
}

/// One row of a directory listing (`+explore-dir-html`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub mark: String,
    /// Resolved `/apps/lattice/x/...` path to open.
    pub href: String,
}

/// Structured content of an explorer response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum View {
    Dir {
        x_path: String,
        canon: String,
        crumbs: Vec<Crumb>,
        entries: Vec<DirEntry>,
        truncated: bool,
    },
    File {
        x_path: String,
        canon: String,
        crumbs: Vec<Crumb>,
        body: String,
        /// Rendered markdown/document fallback when the file is HTML/gemtext or a live page view.
        is_doc: bool,
        note: String,
        has_raw: bool,
    },
    Refused {
        x_path: String,
        canon: String,
        crumbs: Vec<Crumb>,
        pages_href: String,
    },
}

impl View {
    pub fn x_path(&self) -> &str {
        match self {
            View::Dir { x_path, .. } | View::File { x_path, .. } | View::Refused { x_path, .. } => x_path,
        }
    }

    pub fn canon(&self) -> &str {
        match self {
            View::Dir { canon, .. } | View::File { canon, .. } | View::Refused { canon, .. } => canon,
        }
    }

    pub fn crumbs(&self) -> &[Crumb] {
        match self {
            View::Dir { crumbs, .. } | View::File { crumbs, .. } | View::Refused { crumbs, .. } => crumbs,
        }
    }

    /// Short title for the tab strip.
    pub fn title(&self) -> String {
        let p = self.x_path().trim_end_matches('/');
        let rest = p.strip_prefix("/apps/lattice/x/").unwrap_or(p);
        let leaf = rest.rsplit('/').next().unwrap_or("");
        if leaf.is_empty() { "Explorer".into() } else { format!("x: {leaf}") }
    }
}

/// Normalizes a typed explorer path into `/apps/lattice/x...`.
pub fn normalize_path(typed: &str) -> String {
    let t = typed.trim();
    if t.is_empty() || t == "/x" || t == "/apps/lattice/x" || t == "/apps/lattice/x/" {
        return "/apps/lattice/x".into();
    }
    if t.starts_with("/apps/lattice/x/") {
        return t.to_owned();
    }
    if let Some(rest) = t.strip_prefix("/x/") {
        return format!("/apps/lattice/x/{rest}");
    }
    if t.starts_with('~') {
        return format!("/apps/lattice/x/{t}");
    }
    format!("/apps/lattice/x/{}", t.trim_start_matches('/'))
}

/// Builds clickable breadcrumbs from an `/apps/lattice/x/<ship>/<seg1>/<seg2>...` path.
pub fn crumbs_of(x_path: &str) -> Vec<Crumb> {
    let clean = x_path.split('?').next().unwrap_or(x_path);
    let Some(rest) = clean.strip_prefix("/apps/lattice/x/") else {
        return Vec::new();
    };
    let segs: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    let mut out = Vec::with_capacity(segs.len());
    let mut acc = String::from("/apps/lattice/x");
    for (i, seg) in segs.iter().enumerate() {
        acc.push('/');
        acc.push_str(seg);
        let is_last = i + 1 == segs.len();
        let href = if is_last && !clean.ends_with('/') { acc.clone() } else { format!("{acc}/") };
        out.push(Crumb { label: (*seg).to_owned(), href });
    }
    out
}

/// Resolves a relative href inside a directory path `/apps/lattice/x/.../`.
pub fn resolve_href(dir_path: &str, href: &str) -> String {
    if href.starts_with("/apps/lattice/x") {
        return href.to_owned();
    }
    if let Some(rest) = href.strip_prefix('/') {
        return format!("/{rest}");
    }
    let clean = dir_path.split('?').next().unwrap_or(dir_path);
    let base = if clean.ends_with('/') {
        clean.to_owned()
    } else {
        match clean.rfind('/') {
            Some(i) => clean[..=i].to_owned(),
            None => "/apps/lattice/x/".to_owned(),
        }
    };
    format!("{base}{href}")
}

fn unescape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 1..];
        if let Some(semi) = tail.find(';') {
            let ent = &tail[..semi];
            let rep = match ent {
                "amp" => Some("&".to_owned()),
                "lt" => Some("<".to_owned()),
                "gt" => Some(">".to_owned()),
                "quot" => Some("\"".to_owned()),
                "apos" | "#39" | "#x27" => Some("'".to_owned()),
                "middot" => Some("\u{b7}".to_owned()),
                "mdash" => Some(" - ".to_owned()),
                "nbsp" => Some(" ".to_owned()),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32).map(|c| c.to_string()),
                _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32).map(|c| c.to_string()),
                _ => None,
            };
            if let Some(r) = rep {
                out.push_str(&r);
                rest = &tail[semi + 1..];
                continue;
            }
        }
        out.push('&');
        rest = tail;
    }
    out.push_str(rest);
    out
}

fn attr_value<'a>(tag: &'a str, name: &str) -> Option<String> {
    let pat = format!("{name}=\"");
    let start = tag.find(&pat)? + pat.len();
    let end = tag[start..].find('"')?;
    Some(unescape_html(&tag[start..start + end]))
}

/// Extracts the canonical `urb://` address embedded in the explorer's top bar input (`name="url"`).
fn extract_canon(html: &str) -> String {
    let mut rest = html;
    while let Some(i) = rest.find("<input") {
        let tail = &rest[i..];
        let Some(end) = tail.find('>') else { break };
        let tag = &tail[..=end];
        if tag.contains("name=\"url\"") {
            if let Some(v) = attr_value(tag, "value") {
                return v;
            }
        }
        rest = &tail[end + 1..];
    }
    String::new()
}

/// Extracts inner HTML of the first `<pre>...</pre>` block, decoded.
fn extract_pre(html: &str) -> Option<String> {
    let start = html.find("<pre")?;
    let after_open = html[start..].find('>')? + start + 1;
    let end = html[after_open..].find("</pre>")? + after_open;
    Some(unescape_html(&html[after_open..end]))
}

/// Extracts directory rows from `<ul class="tree">...</ul>`.
fn extract_tree(dir_path: &str, html: &str) -> Option<Vec<DirEntry>> {
    let start = html.find("<ul class=\"tree\">")?;
    let body_start = start + "<ul class=\"tree\">".len();
    let end = html[body_start..].find("</ul>")? + body_start;
    let list_html = &html[body_start..end];
    let mut entries = Vec::new();
    let mut rest = list_html;
    while let Some(li) = rest.find("<li>") {
        let after = &rest[li + 4..];
        let Some(li_end) = after.find("</li>") else { break };
        let item = &after[..li_end];
        if let Some(a_pos) = item.find("<a ") {
            let a_tail = &item[a_pos..];
            if let Some(gt) = a_tail.find('>') {
                let tag = &a_tail[..=gt];
                let href_raw = attr_value(tag, "href").unwrap_or_default();
                let label_tail = &a_tail[gt + 1..];
                let label = label_tail.find("</a>").map(|e| unescape_html(&label_tail[..e])).unwrap_or_default();
                let mark = item
                    .find("<span class=\"mark\">")
                    .and_then(|ms| {
                        let mt = &item[ms + "<span class=\"mark\">".len()..];
                        mt.find("</span>").map(|me| unescape_html(&mt[..me]))
                    })
                    .unwrap_or_default();
                let is_dir = href_raw.ends_with('/') || label.ends_with('/');
                let name = label.trim_end_matches('/').to_owned();
                let href = resolve_href(dir_path, &href_raw);
                entries.push(DirEntry { name, is_dir, mark, href });
            }
        }
        rest = &after[li_end + 5..];
    }
    Some(entries)
}

/// Parses an HTTP response from `GET /apps/lattice/x/...` into a native `View`.
pub fn parse_response(x_path: &str, status: u16, html: &str) -> View {
    let x_path = x_path.split('?').next().unwrap_or(x_path).to_owned();
    let canon = extract_canon(html);
    let crumbs = crumbs_of(&x_path);
    if status == 403 {
        let pages_href = html
            .find(">your pages</a>")
            .and_then(|pos| html[..pos].rfind("<a "))
            .and_then(|a| attr_value(&html[a..], "href"))
            .unwrap_or_else(|| "/apps/lattice/x".into());
        return View::Refused { x_path, canon, crumbs, pages_href };
    }
    if let Some(entries) = extract_tree(&x_path, html) {
        let truncated = html.contains("listing truncated");
        return View::Dir { x_path, canon, crumbs, entries, truncated };
    }
    let has_raw = html.contains("href=\"?data\"") || html.contains("src=\"?data\"");
    if let Some(pre) = extract_pre(html) {
        return View::File {
            x_path,
            canon,
            crumbs,
            body: pre,
            is_doc: false,
            note: String::new(),
            has_raw,
        };
    }
    // Strip the explorer's outer chrome (<main>...</main> if present) and render as document markdown.
    let main_html = html
        .find("<main")
        .and_then(|s| {
            let open_end = html[s..].find('>')? + s + 1;
            let close = html[open_end..].find("</main>")? + open_end;
            Some(&html[open_end..close])
        })
        .unwrap_or(html);
    let md = crate::html::to_markdown(main_html);
    let note = if html.contains("file too large to preview") {
        "File too large to preview. Use Download raw to save it.".into()
    } else if html.contains("binary grub") {
        "Binary grub. Use Download raw to save it.".into()
    } else {
        String::new()
    };
    View::File {
        x_path,
        canon,
        crumbs,
        body: md,
        is_doc: true,
        note,
        has_raw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_and_crumbs() {
        assert_eq!(normalize_path(""), "/apps/lattice/x");
        assert_eq!(normalize_path("/x/~zod/page/"), "/apps/lattice/x/~zod/page/");
        assert_eq!(normalize_path("~zod/page/hello"), "/apps/lattice/x/~zod/page/hello");
        let cs = crumbs_of("/apps/lattice/x/~zod/apps/lattice/page/");
        assert_eq!(cs.len(), 4);
        assert_eq!(cs[0], Crumb { label: "~zod".into(), href: "/apps/lattice/x/~zod/".into() });
        assert_eq!(cs[3], Crumb { label: "page".into(), href: "/apps/lattice/x/~zod/apps/lattice/page/".into() });
    }

    #[test]
    fn parses_dir_listing_and_refused_and_file() {
        let dir_html = r#"<html><body><div class="bar"><input name="url" value="urb://~zod/p/"></div>
            <ul class="tree"><li><a href="notes/">notes/</a></li><li><a href="meta">meta</a> <span class="mark">json</span></li></ul></body></html>"#;
        let v = parse_response("/apps/lattice/x/~zod/page/", 200, dir_html);
        match v {
            View::Dir { canon, entries, truncated, .. } => {
                assert_eq!(canon, "urb://~zod/p/");
                assert!(!truncated);
                assert_eq!(entries.len(), 2);
                assert_eq!(entries[0], DirEntry { name: "notes".into(), is_dir: true, mark: String::new(), href: "/apps/lattice/x/~zod/page/notes/".into() });
                assert_eq!(entries[1], DirEntry { name: "meta".into(), is_dir: false, mark: "json".into(), href: "/apps/lattice/x/~zod/page/meta".into() });
            }
            other => panic!("expected Dir, got {other:?}"),
        }

        let file_html = r#"<input name="url" value="urb://~zod/t/a"><pre>{"a":1 &amp; 2}</pre><a href="?data">view raw</a>"#;
        match parse_response("/apps/lattice/x/~zod/page/meta", 200, file_html) {
            View::File { body, has_raw, is_doc, .. } => {
                assert_eq!(body, "{\"a\":1 & 2}");
                assert!(has_raw && !is_doc);
            }
            other => panic!("expected File, got {other:?}"),
        }

        let ref_html = r#"<p class="err">denied</p><p><a href="/apps/lattice/x/~zod/apps/page/">your pages</a></p>"#;
        match parse_response("/apps/lattice/x/~zod/", 403, ref_html) {
            View::Refused { pages_href, .. } => assert_eq!(pages_href, "/apps/lattice/x/~zod/apps/page/"),
            other => panic!("expected Refused, got {other:?}"),
        }
    }
}
