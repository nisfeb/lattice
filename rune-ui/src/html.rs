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
fn decode(s: &str) -> String {
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
                i = src[i..].to_ascii_lowercase().find(&lower_end).map_or(src.len(), |e| tag_end(src, i + e) + 1).min(src.len());
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
                    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
                    if !t.is_empty() {
                        // a fence longer than any run of backticks inside, and a space where the text starts or ends with one
                        let longest = t.split(|c| c != '`').map(str::len).max().unwrap_or(0);
                        let fence = "`".repeat(longest + 1);
                        let pad = if t.starts_with('`') || t.ends_with('`') { " " } else { "" };
                        out.push_str(&format!("{fence}{pad}{t}{pad}{fence}"));
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

/// An HTML page as Markdown to read. Never fails: what is not understood is read as text or left out.
pub fn to_markdown(html: &str) -> String {
    let mut out = blocks(&parse(html), 0).join("\n");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
