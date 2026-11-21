//! An HTML page as a document to read: its headings, text, lists,
//! links, tables, pictures and code, written as the Markdown the reader
//! already draws.
//!
//! This is not a browser. The page's own styles and scripts are not
//! run, a form is not a form, and what a script would have drawn is not
//! there. Nothing here loads anything: a picture is named, and the
//! reader's own rule decides whether it is fetched.

/// A piece of a page: text, or an element with its attributes and what it holds.
enum Node {
    Text(String),
    El(String, Vec<(String, String)>, Vec<Node>),
}

/// Elements that hold nothing.
const VOID: [&str; 14] = ["br", "hr", "img", "input", "meta", "link", "wbr", "col", "source", "area", "base", "embed", "param", "track"];
/// Elements whose text is not the page's: it is skipped to their end.
const SKIPPED: [&str; 9] = ["script", "style", "head", "template", "svg", "iframe", "object", "select", "textarea"];
/// Elements that stand as blocks of their own.
const BLOCKS: [&str; 39] = [
    "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "figure", "figcaption", "address", "details", "summary", "dl", "dt", "dd", "form", "fieldset", "center", "body", "html", "h1", "h2", "h3", "h4", "h5", "h6", "ul",
    "ol", "li", "blockquote", "pre", "table", "hr", "tr", "caption", "thead", "tbody",
];
/// How deep elements nest before the rest is read as flat. A page made to nest without end is not followed down.
const MAX_DEPTH: usize = 128;

/// A named character, or one given by number.
fn entity(name: &str) -> Option<String> {
    let named = match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "mdash" => "\u{2014}",
        "ndash" => "\u{2013}",
        "hellip" => "\u{2026}",
        "copy" => "\u{a9}",
        "reg" => "\u{ae}",
        "trade" => "\u{2122}",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        "laquo" => "\u{ab}",
        "raquo" => "\u{bb}",
        "times" => "\u{d7}",
        "middot" => "\u{b7}",
        "bull" => "\u{2022}",
        "deg" => "\u{b0}",
        "rarr" => "\u{2192}",
        "larr" => "\u{2190}",
        "euro" => "\u{20ac}",
        "pound" => "\u{a3}",
        _ => "",
    };
    if !named.is_empty() {
        return Some(named.to_owned());
    }
    let num = name.strip_prefix('#')?;
    let code = match num.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => num.parse().ok()?,
    };
    char::from_u32(code).filter(|c| *c != '\0').map(String::from)
}

/// Text with its character references read.
pub(crate) fn decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest[1..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '#')).map_or(rest.len(), |e| e + 1);
        match entity(&rest[1..end]) {
            Some(ch) => {
                out.push_str(&ch);
                rest = rest[end..].strip_prefix(';').unwrap_or(&rest[end..]);
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// A tag's name and attributes, from the text between its angle brackets.
fn tag(inner: &str) -> (String, Vec<(String, String)>) {
    let inner = inner.trim_end_matches('/').trim();
    let end = inner.find(|c: char| c.is_whitespace() || c == '/').unwrap_or(inner.len());
    let name = inner[..end].to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut rest = inner[end..].trim_start();
    while !rest.is_empty() {
        let k = rest.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(rest.len());
        let key = rest[..k].to_ascii_lowercase();
        rest = rest[k..].trim_start();
        let mut val = String::new();
        if let Some(after) = rest.strip_prefix('=') {
            let after = after.trim_start();
            let (v, tail) = match after.chars().next() {
                Some(q @ ('"' | '\'')) => after[1..].split_once(q).unwrap_or((&after[1..], "")),
                _ => after.split_at(after.find(char::is_whitespace).unwrap_or(after.len())),
            };
            val = decode(v);
            rest = tail.trim_start();
        }
        if key.is_empty() {
            // a stray character: step over it, or this never ends
            rest = rest.get(1..).unwrap_or("").trim_start();
            continue;
        }
        attrs.push((key, val));
    }
    (name, attrs)
}

/// The end of the tag that starts at `at`, past any `>` inside a quoted value.
fn tag_end(src: &str, at: usize) -> usize {
    let mut quote = None;
    for (i, ch) in src[at..].char_indices() {
        match (quote, ch) {
            (None, '"' | '\'') if i > 0 => quote = Some(ch),
            (Some(q), c) if c == q => quote = None,
            (None, '>') => return at + i,
            _ => {}
        }
    }
    src.len()
}

/// Closes open elements down to and with the nearest `name`, when there is one above `floor`.
fn close(stack: &mut Vec<(String, Vec<(String, String)>, Vec<Node>)>, names: &[&str], floors: &[&str]) {
    let Some(at) = stack.iter().rposition(|(n, ..)| names.contains(&n.as_str()) || floors.contains(&n.as_str())) else { return };
    // the root, whose name is empty, is never closed: a bare `</` names it
    if at == 0 || !names.contains(&stack[at].0.as_str()) {
        return;
    }
    while stack.len() > at {
        let (n, a, kids) = stack.pop().expect("the stack is longer than where it is cut");
        stack.last_mut().expect("the root is never closed").2.push(Node::El(n, a, kids));
    }
}

/// The page as a tree. Tags that are never closed, or closed out of order, are closed where a browser would.
fn parse(src: &str) -> Vec<Node> {
    let mut stack: Vec<(String, Vec<(String, String)>, Vec<Node>)> = vec![(String::new(), Vec::new(), Vec::new())];
    let mut i = 0;
    while i < src.len() {
        let Some(lt) = src[i..].find('<').map(|k| i + k) else {
            stack.last_mut().expect("root").2.push(Node::Text(decode(&src[i..])));
            break;
        };
        if lt > i {
            stack.last_mut().expect("root").2.push(Node::Text(decode(&src[i..lt])));
        }
        let rest = &src[lt..];
        if rest.starts_with("<!--") {
            i = rest.find("-->").map_or(src.len(), |e| lt + e + 3);
            continue;
        }
        let next = rest[1..].chars().next().unwrap_or(' ');
        if !(next.is_ascii_alphabetic() || next == '/' || next == '!' || next == '?') {
            // a lone angle bracket is text
            stack.last_mut().expect("root").2.push(Node::Text("<".into()));
            i = lt + 1;
            continue;
        }
        let gt = tag_end(src, lt);
        i = (gt + 1).min(src.len());
        if next == '!' || next == '?' {
            continue;
        }
        if next == '/' {
            let name = src[lt + 2..gt].trim().to_ascii_lowercase();
            close(&mut stack, &[name.as_str()], &[]);
            continue;
        }
        let (name, attrs) = tag(&src[lt + 1..gt]);
        if SKIPPED.contains(&name.as_str()) {
            if !src[lt..gt].ends_with('/') {
                let lower_end = format!("</{name}");
                // looked for as it stands, whatever its case: a copy of all the rest in small letters for each such element is the page read through once for each
                i = find_ci(&src[i..], &lower_end).map_or(src.len(), |e| tag_end(src, i + e) + 1).min(src.len());
            }
            continue;
        }
        // what a browser closes without being told
        match name.as_str() {
            "li" => close(&mut stack, &["li"], &["ul", "ol"]),
            "tr" => close(&mut stack, &["tr"], &["table"]),
            "td" | "th" => close(&mut stack, &["td", "th"], &["tr", "table"]),
            "dt" | "dd" => close(&mut stack, &["dt", "dd"], &["dl"]),
            "thead" | "tbody" | "tfoot" => close(&mut stack, &["thead", "tbody", "tfoot"], &["table"]),
            n if BLOCKS.contains(&n) => close(&mut stack, &["p"], &["li", "td", "th", "blockquote", "div", "table", "ul", "ol"]),
            _ => {}
        }
        if VOID.contains(&name.as_str()) || stack.len() > MAX_DEPTH {
            stack.last_mut().expect("root").2.push(Node::El(name, attrs, Vec::new()));
        } else {
            stack.push((name, attrs, Vec::new()));
        }
    }
    while stack.len() > 1 {
        let (n, a, kids) = stack.pop().expect("more than the root");
        stack.last_mut().expect("root").2.push(Node::El(n, a, kids));
    }
    stack.pop().map(|r| r.2).unwrap_or_default()
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// Text with every mark Markdown would read as its own written as plain.
fn escape(s: &str, out: &mut String) {
    for ch in s.chars() {
        if matches!(ch, '\\' | '*' | '_' | '[' | ']' | '`' | '<' | '>' | '~' | '&' | '|' | '#') {
            out.push('\\');
        }
        out.push(if ch.is_whitespace() && ch != '\u{a0}' { ' ' } else { ch });
    }
}

/// A link's or a picture's target, when it is one that only names a place: nothing that runs, and no file of this machine.
fn target(url: &str) -> Option<String> {
    let scheme: String = url.chars().filter(|c| !c.is_whitespace() && !c.is_control()).collect::<String>().to_ascii_lowercase();
    if url.trim().is_empty() || ["javascript:", "data:", "vbscript:", "file:"].iter().any(|bad| scheme.starts_with(bad)) {
        return None;
    }
    let u = url.trim().replace(' ', "%20").replace('<', "%3C").replace('>', "%3E");
    Some(if u.contains(['(', ')']) { format!("<{u}>") } else { u })
}

/// The plain text under some nodes, as it is, for code.
fn raw(nodes: &[Node], out: &mut String) {
    for n in nodes {
        match n {
            Node::Text(t) => out.push_str(t),
            Node::El(name, _, _) if name == "br" => out.push('\n'),
            Node::El(_, _, kids) => raw(kids, out),
        }
    }
}

/// Text as a span of code: a fence longer than any run of backticks inside, and a space where the text starts or ends with one.
fn code_span(t: &str, out: &mut String) {
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return;
    }
    let longest = t.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest + 1);
    let pad = if t.starts_with('`') || t.ends_with('`') { " " } else { "" };
    out.push_str(&format!("{fence}{pad}{t}{pad}{fence}"));
}

/// The TeX a piece of MathML says it was made from.
fn annotation(nodes: &[Node]) -> Option<&[Node]> {
    nodes.iter().find_map(|n| match n {
        Node::El(name, attrs, kids) if name == "annotation" && attr(attrs, "encoding") == Some("application/x-tex") => Some(kids.as_slice()),
        Node::El(_, _, kids) => annotation(kids),
        Node::Text(_) => None,
    })
}

/// Marks round what some nodes read as, with the spaces at its ends kept outside the marks.
fn wrap(kids: &[Node], mark: &str, out: &mut String) {
    let mut inner = String::new();
    inline(kids, &mut inner);
    let body = inner.trim();
    if body.is_empty() {
        out.push_str(&inner);
        return;
    }
    let lead = &inner[..inner.len() - inner.trim_start().len()];
    let trail = &inner[inner.trim_end().len()..];
    out.push_str(&format!("{lead}{mark}{body}{mark}{trail}"));
}

/// Nodes as one run of Markdown text.
fn inline(nodes: &[Node], out: &mut String) {
    for n in nodes {
        match n {
            Node::Text(t) => escape(t, out),
            Node::El(name, attrs, kids) => match name.as_str() {
                "strong" | "b" => wrap(kids, "**", out),
                "em" | "i" | "cite" | "dfn" | "var" => wrap(kids, "*", out),
                "del" | "s" | "strike" => wrap(kids, "~~", out),
                "code" | "kbd" | "samp" | "tt" => {
                    let mut t = String::new();
                    raw(kids, &mut t);
                    code_span(&t, out);
                }
                // mathematics is not set here: it reads as the TeX it was written in, when the page
                // carries that beside the MathML as pandoc's does, on a line of its own when displayed
                "math" => {
                    let mut t = String::new();
                    match annotation(kids) {
                        Some(tex) => raw(tex, &mut t),
                        None => raw(kids, &mut t),
                    }
                    let block = attr(attrs, "display") == Some("block");
                    if block {
                        out.push_str("\\\n");
                    }
                    code_span(&t, out);
                    if block {
                        out.push_str("\\\n");
                    }
                }
                "a" => {
                    let mut label = String::new();
                    inline(kids, &mut label);
                    match attr(attrs, "href").and_then(target).filter(|_| !label.trim().is_empty()) {
                        Some(href) => out.push_str(&format!("[{}]({href})", label.trim())),
                        None => out.push_str(&label),
                    }
                }
                "img" => {
                    let mut alt = String::new();
                    escape(attr(attrs, "alt").unwrap_or(""), &mut alt);
                    match attr(attrs, "src").and_then(target) {
                        Some(src) => out.push_str(&format!("![{alt}]({src})")),
                        None => out.push_str(&alt),
                    }
                }
                "br" => out.push_str("\\\n"),
                "input" | "button" => {}
                _ => {
                    // a block met inside a line reads as part of it, set off by a space
                    let block = BLOCKS.contains(&name.as_str()) || name == "td" || name == "th";
                    if block {
                        out.push(' ');
                    }
                    inline(kids, out);
                    if block {
                        out.push(' ');
                    }
                }
            },
        }
    }
}

/// A run of text as a paragraph's lines: spaces closed up, and a line that would read as a mark of Markdown's made plain.
fn tidy(run: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for line in run.split("\\\n") {
        let mut line = line.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
        let digits = line.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && matches!(line.as_bytes().get(digits), Some(b'.' | b')')) {
            line.insert(digits, '\\');
        } else if line.starts_with(['-', '+', '=']) {
            line.insert(0, '\\');
        }
        lines.push(line);
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    while lines.first().is_some_and(String::is_empty) {
        lines.remove(0);
    }
    let n = lines.len();
    lines.into_iter().enumerate().map(|(i, l)| if i + 1 < n { format!("{l}\\") } else { l }).collect()
}

/// The cells among some nodes, each as one line of text.
fn cells(nodes: &[Node]) -> Vec<String> {
    let cell = |c: &Node| match c {
        Node::El(n, _, kids) if n == "td" || n == "th" => {
            let mut t = String::new();
            inline(kids, &mut t);
            Some(t.replace("\\\n", " ").split_whitespace().collect::<Vec<_>>().join(" "))
        }
        _ => None,
    };
    nodes.iter().filter_map(cell).collect()
}

/// A table's rows, each a list of cells' text. Cells with no row of their own make one, as in a browser.
fn rows(nodes: &[Node], out: &mut Vec<Vec<String>>) {
    let loose = cells(nodes);
    if !loose.is_empty() {
        out.push(loose);
    }
    for n in nodes {
        if let Node::El(name, _, kids) = n {
            if name == "tr" {
                out.push(cells(kids));
            } else if matches!(name.as_str(), "thead" | "tbody" | "tfoot") {
                rows(kids, out);
            }
        }
    }
}

/// Nodes as blocks of Markdown: its lines, with an empty line between blocks.
fn blocks(nodes: &[Node], depth: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut run = String::new();
    fn push(out: &mut Vec<String>, block: Vec<String>) {
        if block.is_empty() {
            return;
        }
        if !out.is_empty() {
            out.push(String::new());
        }
        out.extend(block);
    }
    fn flush(out: &mut Vec<String>, run: &mut String) {
        push(out, tidy(run));
        run.clear();
    }
    for n in nodes {
        let Node::El(name, attrs, kids) = n else {
            inline(std::slice::from_ref(n), &mut run);
            continue;
        };
        let name = name.as_str();
        if !BLOCKS.contains(&name) || depth > MAX_DEPTH {
            inline(std::slice::from_ref(n), &mut run);
            continue;
        }
        flush(&mut out, &mut run);
        match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let mut t = String::new();
                inline(kids, &mut t);
                let t = t.replace("\\\n", " ").split_whitespace().collect::<Vec<_>>().join(" ");
                if !t.is_empty() {
                    push(&mut out, vec![format!("{} {t}", "#".repeat(usize::from(name.as_bytes()[1] - b'0')))]);
                }
            }
            "hr" => push(&mut out, vec!["---".into()]),
            "pre" => {
                let mut t = String::new();
                raw(kids, &mut t);
                let t = t.trim_matches('\n');
                // the language a highlighter was told, when the page says
                let class = kids.iter().find_map(|k| if let Node::El(n, a, _) = k { (n == "code").then(|| attr(a, "class")).flatten() } else { None }).or(attr(attrs, "class")).unwrap_or("");
                let lang = class.split_whitespace().find_map(|c| c.strip_prefix("language-").or(c.strip_prefix("lang-"))).filter(|l| l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '+')).unwrap_or("");
                let longest = t.lines().map(|l| l.trim_start().bytes().take_while(|b| *b == b'`').count()).max().unwrap_or(0);
                let fence = "`".repeat(longest.max(2) + 1);
                let mut block = vec![format!("{fence}{lang}")];
                block.extend(t.lines().map(str::to_owned));
                block.push(fence);
                push(&mut out, block);
            }
            "blockquote" => push(&mut out, blocks(kids, depth + 1).into_iter().map(|l| if l.is_empty() { ">".to_owned() } else { format!("> {l}") }).collect()),
            "ul" | "ol" => {
                let mut list = Vec::new();
                let mut at = attr(attrs, "start").and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
                for item in kids {
                    let Node::El(n, _, inner) = item else { continue };
                    if n != "li" {
                        continue;
                    }
                    let mark = if name == "ol" { format!("{at}. ") } else { "- ".to_owned() };
                    at += 1;
                    let pad = " ".repeat(mark.len());
                    let lines = blocks(inner, depth + 1);
                    if lines.is_empty() {
                        list.push(mark.trim_end().to_owned());
                    }
                    list.extend(lines.into_iter().enumerate().map(|(i, l)| if i == 0 { format!("{mark}{l}") } else if l.is_empty() { l } else { format!("{pad}{l}") }));
                }
                push(&mut out, list);
            }
            "table" => {
                let mut all = Vec::new();
                rows(kids, &mut all);
                let width = all.iter().map(Vec::len).max().unwrap_or(0);
                if width > 0 {
                    let line = |cells: &[String]| format!("| {} |", (0..width).map(|i| cells.get(i).map_or("", String::as_str)).collect::<Vec<_>>().join(" | "));
                    let mut block = vec![line(&all[0]), format!("| {} |", vec!["---"; width].join(" | "))];
                    block.extend(all[1..].iter().map(|r| line(r)));
                    // what the table is called goes above it
                    for k in kids {
                        if let Node::El(n, _, cap) = k {
                            if n == "caption" {
                                let mut t = String::new();
                                wrap(cap, "*", &mut t);
                                push(&mut out, tidy(&t));
                            }
                        }
                    }
                    push(&mut out, block);
                }
            }
            // a stray row or caption outside a table reads as text
            "tr" | "caption" | "thead" | "tbody" => {
                inline(kids, &mut run);
                flush(&mut out, &mut run);
            }
            _ => push(&mut out, blocks(kids, depth + 1)),
        }
    }
    flush(&mut out, &mut run);
    out
}

/// Where `needle`, given in small letters, first stands in `hay` in letters of either size.
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// The widest and tallest a picture may say it is and still be decoded.
const PICTURE_SIDE: u64 = 8192;

/// Whether bytes fetched for a page may be handed on to be decoded. A
/// picture says how large it is in its first bytes, and a few thousand
/// bytes can say gigabytes: one past `PICTURE_SIDE` either way is not
/// decoded. A drawing (SVG) that draws other files in is refused too,
/// since what draws it would read them from this computer's own disk.
/// What is not a picture this knows (a style sheet, a font) passes.
// ponytail: PNG, GIF, JPEG, WebP and BMP are measured. A bomb in another format the decoder knows is not caught here. A size limit in the decoder itself is the fix
pub fn fetched_ok(b: &[u8]) -> bool {
    let be = |at: usize, n: usize| b.get(at..at + n).map(|x| x.iter().fold(0u64, |a, c| a << 8 | u64::from(*c)));
    let le = |at: usize, n: usize| b.get(at..at + n).map(|x| x.iter().rev().fold(0u64, |a, c| a << 8 | u64::from(*c)));
    let fits = |w: Option<u64>, h: Option<u64>| matches!((w, h), (Some(w), Some(h)) if w <= PICTURE_SIDE && h <= PICTURE_SIDE);
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        return fits(be(16, 4), be(20, 4));
    }
    if b.starts_with(b"GIF8") {
        return fits(le(6, 2), le(8, 2));
    }
    if b.starts_with(b"BM") {
        return fits(le(18, 4).map(|w| w.min(u64::from(u32::MAX))), le(22, 4).map(|h| (h as u32 as i32).unsigned_abs().into()));
    }
    if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        return match b.get(12..16) {
            Some(b"VP8X") => fits(le(24, 3).map(|w| w + 1), le(27, 3).map(|h| h + 1)),
            Some(b"VP8 ") => fits(le(26, 2).map(|w| w & 0x3fff), le(28, 2).map(|h| h & 0x3fff)),
            Some(b"VP8L") => le(21, 4).is_some_and(|v| fits(Some((v & 0x3fff) + 1), Some(((v >> 14) & 0x3fff) + 1))),
            _ => false,
        };
    }
    if b.starts_with(&[0xff, 0xd8]) {
        // the frame header, among the segments before the picture's data
        let mut at = 2;
        while let (Some(0xff), Some(kind)) = (b.get(at).copied(), b.get(at + 1).copied()) {
            // a marker may be led by any number of fill bytes
            if kind == 0xff {
                at += 1;
                continue;
            }
            if matches!(kind, 0xc0..=0xcf) && !matches!(kind, 0xc4 | 0xc8 | 0xcc) {
                return fits(be(at + 7, 2), be(at + 5, 2));
            }
            let Some(len) = be(at + 2, 2) else { return false };
            at += 2 + len as usize;
        }
        return false;
    }
    // a drawing: its text is looked through for what would read a file
    let head = &b[..b.len().min(4096)];
    let text = String::from_utf8_lossy(head);
    if find_ci(&text, "<svg").is_some() {
        let all = String::from_utf8_lossy(b);
        return !draws_a_file(&all);
    }
    true
}

/// HTML as it is given to what draws it. A drawing set into the page
/// may name a file to draw in, and what draws it would read that file
/// from this computer's disk, the whole of it: such an element is made
/// one that means nothing. A page nested past what the drawing's stack
/// holds is put aside for a line that says so.
pub fn tamed(html: &str) -> std::borrow::Cow<'_, str> {
    if deeper_than(html, DEEPEST) {
        return std::borrow::Cow::Borrowed("<html><body><p>This page is nested too deeply to draw.</p></body></html>");
    }
    if !draws_a_file(html) {
        return std::borrow::Cow::Borrowed(html);
    }
    let mut out = String::with_capacity(html.len() + 16);
    let mut rest = html;
    while let Some((at, len)) = next_image(rest) {
        // only one that would read a file is unmade: a picture held in the drawing itself is kept
        if reads_a_file(&rest[at..at + len]) {
            out.push_str(&rest[..at + 1]);
            out.push_str("x-");
            rest = &rest[at + 1..];
        } else {
            out.push_str(&rest[..at + len]);
            rest = &rest[at + len..];
        }
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

/// The next element that draws a picture in, `image` or `feImage` and no other name that begins so: where its tag starts, and how long the tag is.
fn next_image(s: &str) -> Option<(usize, usize)> {
    let mut from = 0;
    loop {
        let at = from + [find_ci(&s[from..], "<image"), find_ci(&s[from..], "<feimage")].into_iter().flatten().min()?;
        let name_end = at + if s[at..].len() >= 8 && s[at..at + 8].eq_ignore_ascii_case("<feimage") { 8 } else { 6 };
        let whole = s[name_end..].chars().next().is_none_or(|c| c.is_whitespace() || c == '/' || c == '>');
        if whole {
            let len = s[at..].find('>').map_or(s.len() - at, |e| e + 1);
            return Some((at, len));
        }
        from = name_end;
    }
}

/// Whether a picture element's tag names anything but a picture written out in the tag itself. One with no address draws nothing and is let be.
fn reads_a_file(tag: &str) -> bool {
    let mut rest = tag;
    while let Some(at) = find_ci(rest, "href") {
        let after = rest[at + 4..].trim_start();
        let Some(value) = after.strip_prefix('=') else {
            rest = &rest[at + 4..];
            continue;
        };
        let value = value.trim_start().trim_start_matches(['"', '\'']).trim_start();
        let held = ["data:image/png", "data:image/jpeg", "data:image/jpg", "data:image/gif", "data:image/webp"].iter().any(|p| value.len() >= p.len() && value[..p.len()].eq_ignore_ascii_case(p));
        if !held && !value.starts_with('#') {
            return true;
        }
        rest = &rest[at + 4..];
    }
    false
}

/// Whether a drawing, or a page with drawings in it, has a picture element that would read a file.
fn draws_a_file(s: &str) -> bool {
    let mut rest = s;
    while let Some((at, len)) = next_image(rest) {
        if reads_a_file(&rest[at..at + len]) {
            return true;
        }
        rest = &rest[at + len..];
    }
    false
}

/// The deepest a page's elements may stand one inside another and be drawn.
pub const DEEPEST: usize = 4096;

/// Whether HTML has elements one inside another deeper than `most`.
/// Counted from its tags alone, so an element left open counts as one
/// that holds all that follows: the count errs towards deep.
pub fn deeper_than(src: &str, most: usize) -> bool {
    // elements with no inside, and those a browser closes by itself when the next of their kind opens: a list of five thousand items written with no closing tags is not five thousand deep
    const VOID: [&str; 28] = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "li", "p", "td", "th", "tr", "option", "dt", "dd", "thead", "tbody", "tfoot", "colgroup", "optgroup", "rp"];
    let (b, mut i, mut depth) = (src.as_bytes(), 0, 0usize);
    while let Some(lt) = b[i..].iter().position(|c| *c == b'<').map(|p| p + i) {
        i = lt + 1;
        let closing = b.get(i) == Some(&b'/');
        let from = if closing { i + 1 } else { i };
        let len = b[from.min(b.len())..].iter().take_while(|c| c.is_ascii_alphanumeric()).count();
        if len == 0 {
            continue;
        }
        let name = &src[from..from + len];
        // a script's or a style's inside is not markup: `i<n` there opens nothing
        if !closing && (name.eq_ignore_ascii_case("script") || name.eq_ignore_ascii_case("style")) {
            let end = format!("</{}", name.to_ascii_lowercase());
            i = find_ci(&src[i..], &end).map_or(src.len(), |e| i + e);
            continue;
        }
        if VOID.iter().any(|v| v.eq_ignore_ascii_case(name)) {
            continue;
        }
        if closing {
            depth = depth.saturating_sub(1);
        } else {
            depth += 1;
            if depth > most {
                return true;
            }
        }
    }
    false
}

/// An HTML page as Markdown to read. Never fails: what is not understood is read as text or left out.
pub fn to_markdown(html: &str) -> String {
    let mut out = blocks(&parse(html), 0).join("\n");
    out.push('\n');
    out
}

/// A gemtext page as Markdown to read, by the web client's rules
/// (`gmiToHtml`, which mirrors the ship's `render-gmi`): fenced text as
/// it is, `#` to `###` headings, `=>` links, `>` quotes, blank lines
/// dropped and every other line a paragraph. A link goes only to
/// `urb://` or the web. One to anywhere else reads as its words.
pub fn gemtext(src: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut pre: Option<Vec<&str>> = None;
    let line = |t: &str| {
        let mut e = String::new();
        escape(t, &mut e);
        tidy(&e).join(" ")
    };
    let fence = |lines: &[&str]| {
        let longest = lines.iter().map(|l| l.trim_start().bytes().take_while(|b| *b == b'`').count()).max().unwrap_or(0);
        let f = "`".repeat(longest.max(2) + 1);
        format!("{f}\n{}{}{f}", lines.join("\n"), if lines.is_empty() { "" } else { "\n" })
    };
    for ln in src.split('\n') {
        let ln = ln.strip_suffix('\r').unwrap_or(ln);
        if ln.trim_end() == "```" {
            match pre.take() {
                Some(lines) => out.push(fence(&lines)),
                None => pre = Some(Vec::new()),
            }
            continue;
        }
        if let Some(lines) = &mut pre {
            lines.push(ln);
            continue;
        }
        let level = ln.bytes().take_while(|b| *b == b'#').count();
        if (1..=3).contains(&level) && ln[level..].starts_with(' ') {
            out.push(format!("{} {}", "#".repeat(level), line(&ln[level + 1..])));
        } else if let Some(rest) = ln.strip_prefix("=> ") {
            let rest = rest.trim_start();
            let (raw, desc) = rest.split_once(' ').map_or((rest, rest), |(r, d)| (r, d.trim_start()));
            let (desc, low) = (line(desc), raw.to_ascii_lowercase());
            let goes = low.starts_with("urb://") || low.starts_with("http://") || low.starts_with("https://");
            match target(raw).filter(|_| goes && !desc.is_empty()) {
                Some(href) => out.push(format!("[{desc}]({href})")),
                None => out.push(desc),
            }
        } else if let Some(said) = ln.strip_prefix("> ") {
            out.push(format!("> {}", line(said)));
        } else if !ln.trim().is_empty() {
            out.push(line(ln));
        }
    }
    if let Some(lines) = pre {
        out.push(fence(&lines));
    }
    out.retain(|b| !b.is_empty());
    let mut text = out.join("\n\n");
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemtext_reads_by_the_web_clients_rules() {
        let page = "# Capsule\n## Two\n### Three\n#### not four\n#nor this\n\n\nA line with *stars* and <b>.\n=> https://urbit.org Urbit\n=>   urb://~zod/page   A page\n=> https://bare.example\n=> gemini://x.org Elsewhere\n=> javascript:alert(1) Run\n=>nospace\n> quoted _text_\n* an item\n1. numbered\n```\ncode *as is*\n  <kept>\n``` \nafter";
        let want = "# Capsule\n\n## Two\n\n### Three\n\n\\#\\#\\#\\# not four\n\n\\#nor this\n\nA line with \\*stars\\* and \\<b\\>.\n\n[Urbit](https://urbit.org)\n\n[A page](urb://~zod/page)\n\n[https://bare.example](https://bare.example)\n\nElsewhere\n\nRun\n\n\\=\\>nospace\n\n> quoted \\_text\\_\n\n\\* an item\n\n1\\. numbered\n\n```\ncode *as is*\n  <kept>\n```\n\nafter\n";
        assert_eq!(gemtext(page), want);
        // a fence never closed takes the rest, and one holding a fence gets a longer one
        assert_eq!(gemtext("```\nopen"), "```\nopen\n```\n");
        assert_eq!(gemtext("```\n````\n```"), "`````\n````\n`````\n");
        assert_eq!(gemtext(""), "\n");
        assert_eq!(gemtext("a\r\n\r\nb\r\n"), "a\n\nb\n");
    }

    fn md(html: &str) -> String {
        to_markdown(html).trim_end().to_owned()
    }

    #[test]
    fn a_page_reads_as_its_headings_text_lists_and_links() {
        assert_eq!(md("<!doctype html><html><head><title>T</title><style>p{color:red}</style></head><body><h1>Title</h1><p>One <b>bold</b> and <em>soft</em>.</p><h3>Sub</h3></body></html>"), "# Title\n\nOne **bold** and *soft*.\n\n### Sub");
        assert_eq!(md("<p>a<br>b</p><hr><p>c &amp; d &lt;e&gt; &#233; &#x263A; &nbsp;f &bogus; g</p>"), "a\\\nb\n\n---\n\nc \\& d \\<e\\> é ☺ \u{a0}f \\&bogus; g");
        assert_eq!(md("<ul><li>one<li>two <a href=\"https://x.org/a b\">link</a></li><li><p>three</p><ul><li>deep</li></ul></li></ul>"), "- one\n- two [link](https://x.org/a%20b)\n- three\n\n  - deep");
        assert_eq!(md("<ol start=3><li>c</li><li>d</li></ol>"), "3. c\n4. d");
        assert_eq!(md("<blockquote><p>said</p><p>twice</p></blockquote>"), "> said\n>\n> twice");
        assert_eq!(md("text <code>a*b `c`</code> and <del>gone</del><p>next"), "text `` a*b `c` `` and ~~gone~~\n\nnext");
        assert_eq!(md("<div>one<div>two</div>three</div>"), "one\n\ntwo\n\nthree");
        assert_eq!(md("<b> spaced </b>word <i></i>"), "**spaced** word");
    }

    #[test]
    fn code_tables_and_pictures_are_kept() {
        assert_eq!(md("<pre><code class=\"language-rust\">fn a() {\n    1 &lt; 2\n}\n</code></pre>"), "```rust\nfn a() {\n    1 < 2\n}\n```");
        assert_eq!(md("<pre>a\n```\nb</pre>"), "````\na\n```\nb\n````");
        assert_eq!(md("<table><caption>Costs</caption><thead><tr><th>Item<th>Cost</tr></thead><tbody><tr><td>a|b</td><td><b>3</b></td></tr><tr><td>only</td></tr></tbody></table>"), "*Costs*\n\n| Item | Cost |\n| --- | --- |\n| a\\|b | **3** |\n| only |  |");
        assert_eq!(md("<p><img src=\"fig/a.png\" alt=\"A [fig]\"> <img src=\"https://x.org/t.png\"></p>"), "![A \\[fig\\]](fig/a.png) ![](https://x.org/t.png)");
    }

    #[test]
    fn mathematics_reads_as_the_tex_it_was_written_in() {
        let inline = "<math display=\"inline\"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding=\"application/x-tex\">x^2 + y_1</annotation></semantics></math>";
        assert_eq!(md(&format!("<p>with {inline} inline</p>")), "with `x^2 + y_1` inline");
        let block = inline.replace("inline", "block");
        assert_eq!(md(&format!("<p>before {block} after</p>")), "before\\\n`x^2 + y_1`\\\nafter");
        // MathML with no TeX beside it reads as its symbols
        assert_eq!(md("<math><mi>a</mi><mo>+</mo><mi>b</mi></math>"), "`a+b`");
    }

    #[test]
    fn what_markdown_would_read_as_its_own_is_written_plain() {
        assert_eq!(md("<p>*not soft* _nor_ [[link]] `tick` # no ~~x~~</p>"), "\\*not soft\\* \\_nor\\_ \\[\\[link\\]\\] \\`tick\\` \\# no \\~\\~x\\~\\~");
        assert_eq!(md("<p>1. not a list</p><p>- nor this</p><p>+ nor</p><p>12) nor</p>"), "1\\. not a list\n\n\\- nor this\n\n\\+ nor\n\n12\\) nor");
    }

    #[test]
    fn nothing_that_runs_or_reaches_this_machine_gets_through() {
        assert_eq!(md("a<script>alert('</p>')</script>b<style>x{}</style>c<iframe src=x></iframe>d"), "abcd");
        assert_eq!(md("<a href=\"javascript:alert(1)\">x</a> <a href=\"java\tscript:alert(1)\">y</a> <a href=\" DATA:text/html,x\">z</a> <a href=\"file:///etc/passwd\">f</a>"), "x y z f");
        assert_eq!(md("<img src=\"javascript:x\" alt=\"pic\"><img src=\"file:///a.png\">"), "pic");
        assert_eq!(md("<p onclick=\"x()\">t</p><form><input value=secret><button>Go</button><textarea>typed</textarea></form>"), "t");
        assert_eq!(md("<a href=\"x)](javascript:y\">t</a>"), "[t](<x)](javascript:y>)");
    }

    #[test]
    fn a_picture_that_says_it_is_vast_is_not_decoded() {
        let png = |w: u32, h: u32| [b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".as_slice(), &w.to_be_bytes(), &h.to_be_bytes(), &[1, 0, 0, 0, 0]].concat();
        assert!(fetched_ok(&png(800, 600)));
        assert!(!fetched_ok(&png(22_000, 22_000)));
        assert!(!fetched_ok(b"\x89PNG\r\n\x1a\n"));
        let gif = |w: u16, h: u16| [b"GIF89a".as_slice(), &w.to_le_bytes(), &h.to_le_bytes()].concat();
        assert!(fetched_ok(&gif(100, 100)) && !fetched_ok(&gif(65_535, 65_535)));
        let jpeg = |w: u16, h: u16| [&[0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8][..], &h.to_be_bytes(), &w.to_be_bytes()].concat();
        assert!(fetched_ok(&jpeg(640, 480)) && !fetched_ok(&jpeg(65_000, 65_000)));
        // a style sheet and a font pass
        assert!(fetched_ok(b"body { color: red }") && fetched_ok(b"wOF2\0\x01\0\0"));
        // a drawing passes unless it draws a file in
        assert!(fetched_ok(b"<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>"));
        assert!(!fetched_ok(b"<svg xmlns='http://www.w3.org/2000/svg'><IMAGE href='/dev/zero'/></svg>"));
        assert!(!fetched_ok(b"<?xml version='1.0'?><svg><filter><feImage href='/etc/passwd'/></filter></svg>"));
    }

    #[test]
    fn a_page_is_tamed_before_it_is_drawn() {
        let plain = "<html><body><p>hi <img src='a.png'></p></body></html>";
        assert!(matches!(tamed(plain), std::borrow::Cow::Borrowed(p) if p == plain));
        assert_eq!(tamed("<svg><image href='/dev/zero'/><FEIMAGE href='x'/></svg>"), "<svg><x-image href='/dev/zero'/><x-FEIMAGE href='x'/></svg>");
        // a picture held in the drawing itself is kept, and so is an element whose name only begins the same
        let kept = "<svg><image href=\"data:image/png;base64,AAAA\"/><image-gallery>x</image-gallery></svg>";
        assert!(matches!(tamed(kept), std::borrow::Cow::Borrowed(_)));
        assert!(fetched_ok(kept.as_bytes()));
        assert_eq!(tamed("<svg><image xlink:href = '/etc/passwd'/></svg>"), "<svg><x-image xlink:href = '/etc/passwd'/></svg>");
        assert!(!fetched_ok(b"<svg><image href='data:image/svg+xml,%3Csvg%3E'/></svg>"), "a drawing inside a drawing may read a file in its turn");
        // a long list written with no closing tags is not deep, nor is a script that compares
        let list = format!("<html><body><ul>{}</ul></body></html>", "<li>item\n".repeat(30_000));
        assert!(!deeper_than(&list, DEEPEST));
        assert!(!deeper_than(&format!("<script>{}</script><p>x", "if(i<n){}".repeat(30_000)), DEEPEST));
        let deep = format!("<html><body>{}x</body></html>", "<span>".repeat(100_000));
        assert!(tamed(&deep).contains("too deeply"));
        assert!(!deeper_than(&format!("{}x{}", "<div>".repeat(100), "</div>".repeat(100)), 200));
        assert!(!deeper_than(&"<br><img><p>a</p>".repeat(50_000), 10));
        // many skipped elements are passed over in one reading
        let t = std::time::Instant::now();
        let _ = to_markdown(&"<svg></svg>".repeat(80_000));
        assert!(t.elapsed().as_secs() < 8);
    }

    #[test]
    fn broken_pages_do_not_panic_or_hang() {
        for bad in ["", "<", "<<<", "<a", "<a href=", "<a href=\"", "</", "</p>", "<p", "<!--", "<!-- x", "&", "&#", "&#x;", "&#99999999999;", "<p =>", "<p a=b =c>", "<table><td>x", "<li>x", "<ul><ul><ul>", "<pre>", "<script>", "é<é>é", "<a\u{0}b>"] {
            let _ = to_markdown(bad);
        }
        assert_eq!(md("<table><td>x"), "| x |\n| --- |");
        assert_eq!(md("a < b and c > d"), "a \\< b and c \\> d");
        // a page nested without end is read flat past a depth, in bounded time
        let deep = "<div>".repeat(50_000) + "x";
        assert!(to_markdown(&deep).contains('x'));
        let quotes = "<blockquote>".repeat(5_000) + "x";
        let _ = to_markdown(&quotes);
    }
}
