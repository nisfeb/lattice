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

/// LaTeX source as an HTML fragment, with MathML for the mathematics.
/// The source goes in on stdin. `--sandbox` keeps `\input` and its kin
/// from reading this machine's files into the page, and a pandoc too old
/// to have it is refused. Ten seconds at most.
pub fn convert(exe: &std::path::Path, src: &str) -> Result<String, String> {
    let mut child = Command::new(exe).args(["-f", "latex", "-t", "html5", "--mathml", "--sandbox"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("could not run pandoc: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("could not write to pandoc")?;
    let (mut cout, mut cerr) = (child.stdout.take().ok_or("could not read from pandoc")?, child.stderr.take().ok_or("could not read from pandoc")?);
    // each pipe on a thread of its own, so a full one cannot stop the others
    let src = src.to_owned();
    let feed = std::thread::spawn(move || {
        let _ = stdin.write_all(src.as_bytes());
    });
    let out = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = cout.read_to_end(&mut v);
        v
    });
    let err = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = cerr.read_to_end(&mut v);
        v
    });
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
    let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
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
const LOADS: &[&str] = &["src", "srcset", "poster", "action", "formaction", "data", "background"];

/// pandoc's output made safe to keep as an html page of the owner's own,
/// which runs as the owner. The source may be a peer's, and pandoc copies
/// `\href` and `\includegraphics` targets through as written. Links keep
/// http, https, mailto and relative targets. Media keeps relative
/// sources only, so reading the page tells no other host. Anything that
/// embeds or runs is dropped, and so is every `on...` attribute. A tag is
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
            // browsers drop these characters inside a scheme, and read a backslash as a slash
            let v: String = raw.chars().filter(|c| *c > ' ').map(|c| if c == '\\' { '/' } else { c }).collect();
            let scheme = v.split_once(':').map(|p| p.0.to_ascii_lowercase()).filter(|s| !s.is_empty() && s.bytes().enumerate().all(|(i, b)| b.is_ascii_alphabetic() || i > 0 && (b.is_ascii_digit() || b"+.-".contains(&b))));
            let absolute = scheme.is_some() || v.starts_with("//");
            let bad = n.starts_with("on")
                || !n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'-')
                || (n == "href" || n == "xlink:href") && absolute && !matches!(scheme.as_deref(), Some("http" | "https" | "mailto"))
                || LOADS.contains(&n.as_str()) && absolute;
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
