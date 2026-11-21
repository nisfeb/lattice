//! LaTeX to HTML, by running the pandoc on this machine, and the result
//! made safe to keep as a page of the owner's own. A port of the desktop
//! app's bridge (`desktop/src/pandoc.rs`) and the web client's cleaning
//! (`ui-src/lattice/71-latex.js`). pandoc is not bundled: it is found
//! where the user installed it.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::odf::{attrs, tag_end};

/// The name of the page a conversion writes: beside its source.
pub fn out_name(name: &str) -> String {
    format!("{name}-web")
}

/// A pandoc that runs: on the path, then where installs put it.
pub fn locate() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let fixed: &[&str] = if cfg!(target_os = "macos") { &["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"] } else { &["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"] };
    std::iter::once(PathBuf::from("pandoc"))
        .chain(fixed.iter().map(|d| PathBuf::from(d).join("pandoc")))
        .chain(home.iter().flat_map(|h| [h.join(".local/bin/pandoc"), h.join("bin/pandoc")]))
        .find(|p| Command::new(p).arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success()))
}

/// The most pandoc may write of a document, and of what it says went
/// wrong. A paper is some hundreds of kilobytes of HTML: a source made
/// to write without end would else be kept until memory ran out.
const MOST_OUT: usize = 8 * 1024 * 1024;
const MOST_ERR: usize = 1024 * 1024;

/// What a pipe gave, up to `most` bytes, or nothing when it gave more.
/// The rest is read and dropped, so the program at the other end is not
/// left waiting to be read.
fn read_most(mut r: impl Read, most: usize) -> Option<Vec<u8>> {
    let mut v = Vec::new();
    let _ = r.by_ref().take(most as u64 + 1).read_to_end(&mut v);
    let whole = v.len() <= most;
    let _ = std::io::copy(&mut r, &mut std::io::sink());
    whole.then_some(v)
}

/// LaTeX source as an HTML fragment, with MathML for the mathematics.
/// The source goes in on stdin. `--sandbox` keeps `\input` and its kin
/// from reading this machine's files into the page, and a pandoc too old
/// to have it is refused. Ten seconds at most, and `MOST_OUT` bytes.
pub fn convert(exe: &std::path::Path, src: &str) -> Result<String, String> {
    let mut child = Command::new(exe).args(["-f", "latex", "-t", "html5", "--mathml", "--sandbox"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("could not run pandoc: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("could not write to pandoc")?;
    let (cout, cerr) = (child.stdout.take().ok_or("could not read from pandoc")?, child.stderr.take().ok_or("could not read from pandoc")?);
    // each pipe on a thread of its own, so a full one cannot stop the others
    let src = src.to_owned();
    let feed = std::thread::spawn(move || {
        let _ = stdin.write_all(src.as_bytes());
    });
    let out = std::thread::spawn(move || read_most(cout, MOST_OUT));
    let err = std::thread::spawn(move || read_most(cerr, MOST_ERR));
    let until = Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait().map_err(|e| format!("pandoc failed: {e}"))? {
            Some(s) => break s,
            None if Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("pandoc took more than ten seconds".into());
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let _ = feed.join();
    let (stdout, stderr) = (out.join().ok().flatten(), err.join().ok().flatten().unwrap_or_default());
    let Some(stdout) = stdout else {
        return Err(format!("pandoc wrote more than {} MB, which is not kept", MOST_OUT >> 20));
    };
    if !status.success() {
        let msg = String::from_utf8_lossy(&stderr).trim().to_owned();
        return Err(if msg.contains("--sandbox") {
            "pandoc 2.15 or later is needed to convert safely".into()
        } else if msg.is_empty() {
            "pandoc could not convert this document".into()
        } else {
            msg.chars().take(400).collect()
        });
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// Elements that embed or run, dropped whole.
const DROP: &[&str] = &["script", "style", "iframe", "frame", "object", "embed", "video", "audio", "source", "track", "form", "base", "meta", "link", "svg"];
/// The ones among them with no closing tag.
const VOID: &[&str] = &["frame", "embed", "source", "track", "base", "meta", "link"];
/// Attributes that load something.
const LOADS: &[&str] = &["src", "srcset", "imagesrcset", "lowsrc", "dynsrc", "poster", "action", "formaction", "data", "background", "ping", "manifest", "codebase"];

/// What stands for a character reference this code does not know.
const UNKNOWN: char = '\u{ffff}';

/// A value with its character references read as HTML reads them in an
/// attribute: a numbered one with or without its semicolon (`&#58` is a
/// colon as `&#58;` is), and a named one with it. The names known here
/// are the ones that spell what an address is judged by. Any other name
/// with a semicolon may be one a browser knows, so it is read as
/// `UNKNOWN` and judged every way it could fall (`guesses`). A name with
/// no semicolon is only one of the old ones, none of which spells a
/// character that matters here, and is left as it is written.
fn read_refs(raw: &str) -> String {
    const NAMES: [(&str, char); 34] = [
        ("amp", '&'), ("lt", '<'), ("gt", '>'), ("quot", '"'), ("apos", '\''), ("colon", ':'), ("Tab", '\t'), ("NewLine", '\n'), ("sol", '/'), ("bsol", '\\'), ("lpar", '('), ("rpar", ')'),
        ("period", '.'), ("comma", ','), ("num", '#'), ("quest", '?'), ("excl", '!'), ("semi", ';'), ("equals", '='), ("percnt", '%'), ("plus", '+'), ("lowbar", '_'), ("commat", '@'), ("lbrack", '['),
        ("lsqb", '['), ("rbrack", ']'), ("rsqb", ']'), ("lbrace", '{'), ("lcub", '{'), ("rbrace", '}'), ("rcub", '}'), ("dollar", '$'), ("ast", '*'), ("nbsp", '\u{a0}'),
    ];
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i + 1..];
        let b = rest.as_bytes();
        let (ch, used) = if b.first() == Some(&b'#') {
            let hex = matches!(b.get(1), Some(b'x' | b'X'));
            let from = if hex { 2 } else { 1 };
            let len = b[from..].iter().take_while(|c| if hex { c.is_ascii_hexdigit() } else { c.is_ascii_digit() }).count();
            // a number too long to be a character is still a reference: HTML reads it as one that stands for nothing
            let ch = u32::from_str_radix(&rest[from..from + len], if hex { 16 } else { 10 }).ok().and_then(char::from_u32).filter(|c| *c != '\0').unwrap_or('\u{fffd}');
            if len == 0 { (None, 0) } else { (Some(ch), from + len) }
        } else {
            let len = b.iter().take_while(|c| c.is_ascii_alphanumeric()).count();
            match (len > 0 && b.get(len) == Some(&b';'), NAMES.iter().find(|(n, _)| *n == &rest[..len])) {
                (true, Some((_, ch))) => (Some(*ch), len),
                (true, None) => (Some(UNKNOWN), len),
                _ => (None, 0),
            }
        };
        match ch {
            Some(ch) => {
                out.push(ch);
                rest = &rest[used..];
                rest = rest.strip_prefix(';').unwrap_or(rest);
            }
            None => out.push('&'),
        }
    }
    out.push_str(rest);
    out
}

/// A value that was read, each way a reference this code does not know
/// could fall: as the colon of a scheme, as a slash, and as nothing at
/// all, which is what a tab or a line end is in an address. A value is
/// safe only when every one of them is.
fn guesses(read: &str) -> [String; 3] {
    [read.replace(UNKNOWN, ":"), read.replace(UNKNOWN, "/"), read.replace(UNKNOWN, "")]
}

/// Whether an address leads off the page's own site: it has a scheme, or starts with two slashes.
/// The scheme is given back too. `raw` is the value with its character references read.
fn leads_off(raw: &str) -> (bool, Option<String>) {
    // browsers drop these characters inside a scheme, and read a backslash as a slash
    let v: String = raw.chars().filter(|c| *c > ' ').map(|c| if c == '\\' { '/' } else { c }).collect();
    let scheme = v.split_once(':').map(|p| p.0.to_ascii_lowercase()).filter(|s| !s.is_empty() && s.bytes().enumerate().all(|(i, b)| b.is_ascii_alphabetic() || i > 0 && (b.is_ascii_digit() || b"+.-".contains(&b))));
    (scheme.is_some() || v.starts_with("//"), scheme)
}

/// pandoc's output made safe to keep as an html page of the owner's own,
/// which runs as the owner. The source may be a peer's, and pandoc copies
/// `\href` and `\includegraphics` targets through as written. Links keep
/// http, https, mailto and relative targets. Media keeps relative
/// sources only, so reading the page tells no other host. Anything that
/// embeds or runs is dropped, and so is every `on...` attribute. An
/// address is judged as a browser reads it, with its character
/// references read first (`jav&#x61;script:` is `javascript:`, and so is
/// `javascript&#58` with no semicolon). A reference this code does not
/// know is judged every way it could fall, so an ordinary address with
/// `&name;` in its query is kept and a scheme spelled with one is not.
/// A `srcset` is
/// dropped when any picture in it is on another site, and a `style`
/// when it could load anything: it may set sizes and nothing that calls
/// a function, since `url(...)` is one. A tag is
/// rebuilt from the attributes that were read and kept, so what this did
/// not understand does not pass.
pub fn clean(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    // the element being dropped, and how many of it are open
    let mut dropping: Option<(String, usize)> = None;
    while let Some(lt) = html[i..].find('<') {
        let at = i + lt;
        if dropping.is_none() {
            out.push_str(&html[i..at]);
        }
        let rest = &html[at..];
        // a comment can hide markup from a reader of the source: it goes
        if rest.starts_with("<!--") {
            i = rest.find("-->").map_or(html.len(), |e| at + e + 3);
            continue;
        }
        let Some(end) = tag_end(html, at) else {
            // an unfinished tag: nothing after it is kept
            return out;
        };
        let tag = &html[at..end];
        let closing = tag.starts_with("</");
        let name = tag[if closing { 2 } else { 1 }..].split(|c: char| c.is_whitespace() || c == '/' || c == '>').next().unwrap_or("").to_ascii_lowercase();
        i = end;
        if let Some((what, depth)) = &mut dropping {
            if name == *what {
                if closing {
                    *depth -= 1;
                } else if !tag.ends_with("/>") {
                    *depth += 1;
                }
                if *depth == 0 {
                    dropping = None;
                }
            }
            continue;
        }
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'-') {
            // a declaration, a processing instruction, or not a tag at all
            continue;
        }
        if DROP.contains(&name.as_str()) {
            if !closing && !tag.ends_with("/>") && !VOID.contains(&name.as_str()) {
                dropping = Some((name, 1));
            }
            continue;
        }
        if closing {
            out.push_str(&format!("</{name}>"));
            continue;
        }
        out.push('<');
        out.push_str(&name);
        for (a, range) in attrs(tag) {
            let n = a.to_ascii_lowercase();
            let raw = &tag[range];
            let read = read_refs(raw);
            let ways = guesses(&read);
            let link = n == "href" || n == "xlink:href";
            let loads = LOADS.contains(&n.as_str());
            let off = |v: &str| {
                let (absolute, scheme) = leads_off(v);
                absolute && !(link && matches!(scheme.as_deref(), Some("http" | "https" | "mailto")))
            };
            let bad = n.starts_with("on")
                || !n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'-')
                || (link || loads) && ways.iter().any(|v| off(v))
                // each picture of a set is an address of its own
                || n.ends_with("srcset") && ways.iter().any(|v| v.split(',').any(|one| leads_off(one.trim_start().split(char::is_whitespace).next().unwrap_or("")).0))
                || n == "style" && read.contains(['(', '\\', '@', UNKNOWN]);
            if !bad {
                out.push_str(&format!(" {n}=\"{}\"", raw.replace('"', "&quot;")));
            }
        }
        out.push_str(if tag.ends_with("/>") { "/>" } else { ">" });
    }
    if dropping.is_none() {
        out.push_str(&html[i..]);
    }
    out
}

/// The page a conversion writes: the cleaned HTML under a line that says
/// it is derived, since the next conversion writes over it.
pub fn page(source_name: &str, html: &str) -> String {
    format!("<!-- generated from {source_name}.tex by pandoc. Edits here are lost on the next convert. -->\n{}", clean(html))
}

/// A LaTeX page as Markdown to read: pandoc's HTML, cleaned as a
/// conversion is, then read as any HTML page is. An error says why:
/// no pandoc on this machine, or what pandoc said of the source.
pub fn read(src: &str) -> Result<String, String> {
    let exe = locate().ok_or("Shown as its source: reading LaTeX as a document needs pandoc, which is not installed on this machine. It is at pandoc.org")?;
    let html = convert(&exe, src).map_err(|e| format!("Shown as its source, since pandoc could not read it: {}", e.chars().take(300).collect::<String>()))?;
    Ok(crate::html::to_markdown(&clean(&html)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paper_reads_as_a_document_when_pandoc_is_here() {
        // with no pandoc on the machine there is nothing to check, and the page shows as its source
        if locate().is_none() {
            assert!(read("x").unwrap_err().contains("pandoc.org"));
            return;
        }
        let got = read("\\section{Intro}\nSome \\emph{soft} text with $x^2$ inline.\n\\begin{itemize}\\item one \\item two\\end{itemize}\n\\href{https://urbit.org}{link} \\href{javascript:alert(1)}{bad}\n\\begin{verbatim}\ncode here\n\\end{verbatim}\n").unwrap();
        assert_eq!(got, "# Intro\n\nSome *soft* text with `x^2` inline.\n\n- one\n- two\n\n[link](https://urbit.org) bad\n\n```\ncode here\n```\n");
        // a file of this machine is not read into the page
        let stolen = read("\\input{/etc/hostname}\nafter").unwrap_or_default();
        let host = std::fs::read_to_string("/etc/hostname").unwrap_or_default();
        assert!(host.trim().is_empty() || !stolen.contains(host.trim()));
    }

    #[test]
    fn what_embeds_or_runs_is_dropped_and_links_keep_only_safe_targets() {
        // kept as they are
        assert_eq!(clean("<h1 id=\"t\">Title</h1><p>a <em>b</em> &amp; c</p>"), "<h1 id=\"t\">Title</h1><p>a <em>b</em> &amp; c</p>");
        assert_eq!(clean("<a href=\"https://x.org/p?q=1\">x</a> <a href=\"mailto:a@b.c\">m</a> <a href=\"other/page\">r</a> <a href=\"#fn1\">f</a>"), "<a href=\"https://x.org/p?q=1\">x</a> <a href=\"mailto:a@b.c\">m</a> <a href=\"other/page\">r</a> <a href=\"#fn1\">f</a>");
        assert_eq!(clean("<math display=\"block\"><mi>x</mi></math>"), "<math display=\"block\"><mi>x</mi></math>");
        assert_eq!(clean("<img src=\"fig/a.png\" alt=\"a\" />"), "<img src=\"fig/a.png\" alt=\"a\"/>");
        // what runs
        assert_eq!(clean("a<script>alert(1)</script>b"), "ab");
        assert_eq!(clean("a<SCRIPT src=x></SCRIPT>b<style>p{}</style>c"), "abc");
        assert_eq!(clean("<p onclick=\"x()\" ONLOAD='y()' class=\"k\">t</p>"), "<p class=\"k\">t</p>");
        assert_eq!(clean("<a href=\"javascript:alert(1)\">x</a>"), "<a>x</a>");
        assert_eq!(clean("<a href=\"java\tscript:alert(1)\">x</a>"), "<a>x</a>", "a tab inside the scheme is how a browser is fooled");
        assert_eq!(clean("<a href=\" JavaScript:alert(1)\">x</a>"), "<a>x</a>");
        assert_eq!(clean("<a href=\"data:text/html,<script>1</script>\">x</a>"), "<a>x</a>");
        assert_eq!(clean("<a href=\"file:///etc/passwd\">x</a>"), "<a>x</a>");
        // what loads from elsewhere
        assert_eq!(clean("<img src=\"https://x.org/t.png\" alt=\"a\">"), "<img alt=\"a\">");
        assert_eq!(clean("<img src=\"//x.org/t.png\">"), "<img>");
        assert_eq!(clean("<img src=\"\\\\x.org\\t.png\">"), "<img>", "a backslash is read as a slash");
        assert_eq!(clean("a<iframe src=\"https://x.org\"></iframe>b<object data=\"x\"><p>in</p></object>c"), "abc");
        assert_eq!(clean("a<link rel=\"stylesheet\" href=\"https://x.org/s.css\">b<meta http-equiv=\"refresh\" content=\"0;url=//x\">c<base href=\"//x\">d"), "abcd");
        assert_eq!(clean("a<svg><script>1</script><svg></svg><a href=\"x\">in</a></svg>b"), "ab", "nested ones of the same name are counted");
        assert_eq!(clean("a<form action=\"https://x.org\"><input name=\"q\"></form>b"), "ab");
        // comments, and what is not understood, do not pass
        assert_eq!(clean("a<!-- <script>hidden</script> -->b"), "ab");
        assert_eq!(clean("<p a=b onclick=x() class=\"k\">t</p>"), "<p>t</p>", "an unquoted attribute ends what is read of the tag");
        assert_eq!(clean("a<p class=\"x"), "a", "an unfinished tag takes the rest with it");
        assert_eq!(clean("a<script>never closed"), "a");
        assert_eq!(clean("a<!DOCTYPE html><?php x ?>b"), "ab");
        assert_eq!(clean(""), "");
        assert_eq!(out_name("papers/thesis"), "papers/thesis-web");
        assert!(page("paper", "<p>x</p><script>1</script>").ends_with("-->\n<p>x</p>"));
    }

    /// With pandoc installed: a document converts, mathematics becomes MathML, and a file named in
    /// the source is not read.
    #[test]
    #[ignore]
    fn real_pandoc() {
        let exe = locate().expect("pandoc on this machine");
        let html = convert(&exe, "\\section{Results}\nThe value $x^2$ is \\emph{large}. See \\href{https://x.org}{here}.\n").unwrap();
        println!("{html}");
        assert!(html.contains("<h1") && html.contains("Results") && html.contains("<math") && html.contains("<em>large</em>"));
        let cleaned = clean(&html);
        assert!(cleaned.contains("<math") && cleaned.contains("href=\"https://x.org\""));
        // \input of a file on this machine reads nothing in
        let sneaky = convert(&exe, "before \\input{/etc/hostname} after\n").unwrap_or_default();
        let host = std::fs::read_to_string("/etc/hostname").unwrap_or_default();
        assert!(host.trim().is_empty() || !sneaky.contains(host.trim()), "{sneaky}");
    }

    #[test]
    fn what_loads_from_elsewhere_by_a_set_a_style_or_a_spelled_out_scheme_is_dropped() {
        // a set of pictures with one on another site, wherever in the set it stands
        assert_eq!(clean("<img srcset=\"a.png 1x, https://x.org/b.png 2x\" alt=\"a\">"), "<img alt=\"a\">");
        assert_eq!(clean("<img srcset=\"//x.org/b.png\">"), "<img>");
        assert_eq!(clean("<img srcset=\"a.png 1x,\n  HTTP://x.org/b.png 2x\">"), "<img>");
        assert_eq!(clean("<img srcset=\"a.png 1x, b.png 2x\">"), "<img srcset=\"a.png 1x, b.png 2x\">");
        // a style that could load, however it is spelled
        assert_eq!(clean("<p style=\"background:url(https://x.org/t.png)\">t</p>"), "<p>t</p>");
        assert_eq!(clean("<p style=\"background: URL( '//x.org/t.png' )\">t</p>"), "<p>t</p>");
        assert_eq!(clean("<p style=\"background:u\\72l(//x.org/t)\">t</p>"), "<p>t</p>");
        assert_eq!(clean("<p style=\"background:url&#40;//x.org/t&#41;\">t</p>"), "<p>t</p>");
        assert_eq!(clean("<p style=\"@import '//x.org/s.css'\">t</p>"), "<p>t</p>");
        // the styles pandoc writes are kept
        assert_eq!(clean("<col style=\"width: 50%\" /><td style=\"text-align: left;\">t</td>"), "<col style=\"width: 50%\"/><td style=\"text-align: left;\">t</td>");
        // a scheme spelled in character references is the scheme a browser reads
        assert_eq!(clean("<a href=\"jav&#x61;script:alert(1)\">x</a>"), "<a>x</a>");
        assert_eq!(clean("<a href=\"&#106;avascript:alert(1)\">x</a>"), "<a>x</a>");
        assert_eq!(clean("<a href=\"javascript&colon;alert(1)\">x</a>"), "<a>x</a>");
        assert_eq!(clean("<a href=\"java&Tab;script:alert(1)\">x</a>"), "<a>x</a>");
        assert_eq!(clean("<a href=\"data&#58;text/html,x\">x</a>"), "<a>x</a>");
        assert_eq!(clean("<img src=\"https&#58;//x.org/t.png\">"), "<img>");
        assert_eq!(clean("<img src=\"&#47;&#47;x.org/t.png\">"), "<img>");
        assert_eq!(clean("<a href=\"x&madeup;y\">x</a>"), "<a>x</a>", "a reference that is not known may be anything");
        assert_eq!(clean("<a ping=\"https://x.org/p\" href=\"a\">x</a>"), "<a href=\"a\">x</a>");
        // an ordinary address with a query is kept as it was written
        assert_eq!(clean("<a href=\"https://x.org/p?a=1&amp;b=2\">x</a>"), "<a href=\"https://x.org/p?a=1&amp;b=2\">x</a>");
        assert_eq!(clean("<a href=\"p?a=1&b=2\">x</a>"), "<a href=\"p?a=1&b=2\">x</a>");
    }

    #[test]
    fn what_pandoc_writes_is_read_only_so_far() {
        assert_eq!(read_most(&b"abc"[..], 3).as_deref(), Some(&b"abc"[..]));
        assert_eq!(read_most(&b"abcd"[..], 3), None);
        assert_eq!(read_most(std::io::repeat(b'x').take(50_000_000), MOST_OUT), None);
        assert_eq!(read_most(std::io::repeat(b'x').take(MOST_OUT as u64), MOST_OUT).map(|v| v.len()), Some(MOST_OUT));
        // a program that writes without end is not kept, and says so: beside the test's own program, where a file may be run
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::current_exe().unwrap().parent().unwrap().join(format!("lattice-tex-test-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let run = |name: &str, script: &str| {
                let exe = dir.join(name);
                std::fs::write(&exe, script).unwrap();
                std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
                convert(&exe, "x")
            };
            let t = std::time::Instant::now();
            assert_eq!(run("much", "#!/bin/sh\ncat > /dev/null\nhead -c 20000000 /dev/zero\n").unwrap_err(), "pandoc wrote more than 8 MB, which is not kept");
            assert_eq!(run("some", "#!/bin/sh\ncat > /dev/null\nprintf '<p>x</p>'\n").unwrap(), "<p>x</p>");
            assert!(t.elapsed().as_secs() < 8, "{:?}", t.elapsed());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_reference_with_no_semicolon_is_read_and_an_ordinary_address_is_kept() {
        // HTML reads a numbered reference without its semicolon: each of these is the scheme or the slashes it spells
        for bad in [
            "<a href=\"javascript&#58alert(1)\">x</a>",
            "<a href=\"&#106avascript:alert(1)\">x</a>",
            "<a href=\"java&#9script:alert(1)\">x</a>",
            "<a href=\"java&#x9script:alert(1)\">x</a>",
            "<a href=\"javascript&#x3A/alert(1)\">x</a>",
            "<a href=\"javascript&#0000058alert(1)\">x</a>",
        ] {
            assert_eq!(clean(bad), "<a>x</a>", "{bad}");
        }
        assert_eq!(clean("<img src=\"/&#47x.org/t.png\">"), "<img>");
        assert_eq!(clean("<img src=\"&#104ttps://x.org/t.png\">"), "<img>");
        assert_eq!(clean("<img srcset=\"a.png, /&#47x.org/t.png 2x\">"), "<img>");
        assert_eq!(clean("<p style=\"background:url&#40//x.org/t&#41\">t</p>"), "<p>t</p>");
        assert_eq!(clean("<p style=\"background:url&lpar;//x.org/t&rpar;\">t</p>"), "<p>t</p>");
        assert_eq!(clean("<p style=\"width&madeup;1\">t</p>"), "<p>t</p>");
        // an address is judged by its scheme: one with `&name;` in its query is an ordinary address
        for kept in [
            "<a href=\"https://example.org/?a=1&amp;b;c=2\">x</a>",
            "<a href=\"https://example.org/?a=1&b;c=2\">x</a>",
            "<a href=\"page?x=1&copy;2\">x</a>",
            "<a href=\"https://example.org/a&b=1&amp=2&#x26;c\">x</a>",
            "<a href=\"mailto:a@b.c?subject=x&body;y\">x</a>",
            "<img src=\"fig/a&b;c.png\">",
        ] {
            assert_eq!(clean(kept), kept, "{kept}");
        }
        // and one whose scheme could be spelled by a reference this does not know is not
        assert_eq!(clean("<a href=\"java&NewLine;script:alert(1)\">x</a>"), "<a>x</a>");
        assert_eq!(clean("<a href=\"javascript&unknown;alert(1)\">x</a>"), "<a>x</a>");
        assert_eq!(clean("<img src=\"&unknown;/x.org/t.png\">"), "<img>");
        assert_eq!(clean("<img src=\"/&unknown;x.org/t.png\">"), "<img>");
        assert_eq!(read_refs("a&#58b&#x3a;c&colon;d&amp;e&ampf&g;h&#;i&#xzz&"), format!("a:b:c:d&e&ampf{UNKNOWN}h&#;i&#xzz&"));
    }
}
