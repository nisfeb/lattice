//! A page as a PDF. Rune neither prints nor writes PDF, so the page as
//! the ship renders it is made into one sealed document and printed to a
//! file by a headless Chromium or Chrome, when one is installed.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The largest document printed: past this it is not a page anyone prints.
const MAX_HTML: usize = 64 << 20;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The document that is printed. A policy comes first in it, so nothing
/// but the document is loaded: no script runs, and an image on another
/// site (which would learn the reader's address) or in the reader's own
/// files (which would be printed into a PDF they may share) is not
/// fetched. Only images carried in the page as `data:` show.
pub fn document(title: &str, html: &str) -> String {
    format!(
        "<!doctype html>\n<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">\n<meta charset=\"utf-8\"><title>{}</title>\n<style>\n@page {{ margin: 18mm 16mm; }}\nbody {{ font: 11pt/1.5 system-ui, sans-serif; color: #111; max-width: 46em; margin: 0 auto; }}\nh1, h2, h3 {{ line-height: 1.2; break-after: avoid; }}\npre, code {{ font: 9.5pt/1.4 ui-monospace, monospace; }}\npre {{ background: #f4f4f4; padding: 8pt; border-radius: 4pt; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }}\ntable {{ border-collapse: collapse; }}\nth, td {{ border: 0.5pt solid #999; padding: 3pt 6pt; text-align: left; }}\nimg {{ max-width: 100%; }}\na {{ color: inherit; }}\nblockquote {{ margin-left: 0; padding-left: 10pt; border-left: 2pt solid #bbb; color: #444; }}\n</style></head>\n<body>\n{html}\n</body></html>\n",
        esc(title)
    )
}

/// A page with no rendering of its own, as its source.
pub fn source(body: &str) -> String {
    format!("<pre>{}</pre>", esc(body))
}

/// A browser that prints to PDF, found on the path.
pub fn browser() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"].iter().find_map(|name| std::env::split_paths(&path).map(|d| d.join(name)).find(|p| p.is_file()))
}

/// Prints `html` to `out`. The document and the browser's profile go in a
/// folder of their own that is removed after, and the browser is given a
/// minute.
pub fn print(browser: &Path, html: &str, out: &Path) -> Result<(), String> {
    if html.len() > MAX_HTML {
        return Err("the page is too large to print".into());
    }
    let dir = std::env::temp_dir().join(format!("lattice-rune-pdf-{}-{}", std::process::id(), crate::api::since_epoch().map_or(0, |d| d.subsec_nanos())));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let res = (|| {
        let page = dir.join("page.html");
        std::fs::write(&page, html).map_err(|e| e.to_string())?;
        let made = dir.join("page.pdf");
        let mut child = Command::new(browser)
            .args(["--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--no-first-run", "--disable-extensions"])
            .arg(format!("--user-data-dir={}", dir.join("profile").display()))
            .arg(format!("--print-to-pdf={}", made.display()))
            .arg(format!("file://{}", page.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("the browser did not start: {e}"))?;
        let until = Instant::now() + Duration::from_secs(60);
        loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(_) => break,
                None if Instant::now() > until => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("the browser took more than a minute".into());
                }
                None => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        let pdf = std::fs::read(&made).map_err(|_| "the browser wrote no PDF".to_owned())?;
        if !pdf.starts_with(b"%PDF") {
            return Err("the browser wrote no PDF".into());
        }
        std::fs::write(out, pdf).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_dir_all(&dir);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_document_is_sealed_before_anything_in_it_is_read() {
        let d = document("A <b>title</b> & \"more\"", "<p>hello</p><img src=\"https://x.org/a.png\"><script>alert(1)</script>");
        let policy = d.find("Content-Security-Policy").unwrap();
        // the policy is ahead of the title, the style and the page: nothing is read before it
        assert!(policy < d.find("<title>").unwrap() && policy < d.find("<style>").unwrap() && policy < d.find("<p>hello</p>").unwrap());
        assert!(d.contains("default-src 'none'; img-src data:;"));
        assert!(d.contains("<title>A &lt;b&gt;title&lt;/b&gt; &amp; &quot;more&quot;</title>"));
        assert_eq!(source("a < b && c > \"d\""), "<pre>a &lt; b &amp;&amp; c &gt; &quot;d&quot;</pre>");
    }

    /// With a browser installed: a document prints, and what it points at outside is not fetched.
    #[test]
    #[ignore]
    fn real_print() {
        let b = browser().expect("a Chromium or Chrome on the path");
        let out = std::env::temp_dir().join(format!("lattice-rune-print-{}.pdf", std::process::id()));
        // LATTICE_PDF_PROBE=http://127.0.0.1:port: a server to point at, whose log must stay empty
        let probe = std::env::var("LATTICE_PDF_PROBE").unwrap_or_else(|_| "http://127.0.0.1:9".into());
        let body = format!("<h1>Print test</h1><p>One paragraph, with <code>code</code>.</p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table><img src=\"{probe}/image.png\"><link rel=\"stylesheet\" href=\"{probe}/style.css\"><script>fetch('{probe}/script')</script><script src=\"{probe}/script.js\"></script><iframe src=\"{probe}/frame\"></iframe><img src=\"file:///etc/hostname\">");
        let html = document("Print test", &body);
        print(&b, &html, &out).unwrap();
        let pdf = std::fs::read(&out).unwrap();
        println!("{} wrote {} bytes to {}", b.display(), pdf.len(), out.display());
        assert!(pdf.starts_with(b"%PDF") && pdf.len() > 1000);
        if std::env::var_os("LATTICE_KEEP_PDF").is_none() {
            std::fs::remove_file(&out).unwrap();
        }
    }
}
