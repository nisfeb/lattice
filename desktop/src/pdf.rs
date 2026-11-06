//! Export PDF: a page, as the editor renders it, written to a file the user
//! picks.
//!
//! The page arrives as one self-contained document (ui-app/pdf.js inlines
//! the ship's images and stylesheets). It is loaded into a hidden window
//! with JavaScript off and printed there by the platform's own print
//! operation, set to write a PDF and show no dialog:
//!   - Linux: a WebKitGTK print operation on GTK's "Print to File" printer;
//!   - macOS: an NSPrintOperation from the WKWebView, as a save job.
//!
//! The print window is not the workspace: the document is a page's own
//! markup, which may be a peer's or a clipped web page, and the workspace
//! window holds the bridge and every granted command. The hidden window has
//! no capability, runs no script and loads from a private temp file, so it
//! has no origin worth having either.
//!
//! Nor does it load anything but the document (`sealed`). A file: URL in a
//! page would print the user's own files into a PDF they may share, and an
//! http one would show its host the user's address. Both are refused by a
//! CSP put first in the document, which leaves only data: URLs (pdf.js
//! inlines the ship's images and stylesheets as those), and the window
//! goes nowhere but the document.
//!
//! WebKitGTK takes the paper and the margins from the job, not from CSS
//! @page, so the page passes them in (pdf.js, pageOf): a Writer document's
//! own page, else the system's default paper and pdf.js's margins.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

use crate::commands::dlog;

/// The largest document taken, images inlined: past this the page is not a
/// page anyone prints, and a data: URL that size is a cost for nothing.
const MAX_HTML: usize = 64 << 20;
/// How long one export may take, load and print together.
const DEADLINE: Duration = Duration::from_secs(90);

/// The page to print on, in millimetres. No width or height: the system's
/// default paper.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Page {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl Page {
    /// The page within bounds a printer can take: paper from 50 mm to 2 m a
    /// side, margins from 0 to a third of it. Anything else from the page
    /// falls back rather than failing the export.
    fn sane(self) -> Page {
        let side = |v: Option<f64>| v.filter(|x| x.is_finite() && (50.0..=2000.0).contains(x));
        let (width, height) = match (side(self.width), side(self.height)) {
            (Some(w), Some(h)) => (Some(w), Some(h)),
            _ => (None, None),
        };
        let lim = width.zip(height).map_or(100.0, |(w, h)| w.min(h) / 3.0);
        let m = |v: f64| if v.is_finite() && (0.0..=lim).contains(&v) { v } else { 18.0_f64.min(lim) };
        Page { width, height, top: m(self.top), right: m(self.right), bottom: m(self.bottom), left: m(self.left) }
    }
}

/// `name` with a .pdf extension and nothing that would leave the folder the
/// dialog opens in.
fn file_name(name: &str) -> String {
    let base: String = name
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { ' ' } else { c })
        .collect();
    let base = base.trim().trim_start_matches('.').trim();
    let base = if base.is_empty() { "page" } else { base };
    if base.to_lowercase().ends_with(".pdf") {
        base.to_string()
    } else {
        format!("{base}.pdf")
    }
}

/// Write the page to a PDF the user picks. Answers the path written, or ""
/// when the dialog was dismissed.
///
/// Async, like save_vault: the dialog blocks, and the print is waited on.
#[tauri::command]
pub async fn export_pdf(app: AppHandle, html: String, name: String, page: Page) -> Result<String, String> {
    if html.len() > MAX_HTML {
        return Err("this page is too large to export".into());
    }
    let Some(path) = target(&app, &name)? else {
        return Ok(String::new());
    };
    let path = if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) {
        path
    } else {
        path.with_extension("pdf")
    };
    let out = path.clone();
    // the print is waited on; a blocking thread, not an async worker
    tauri::async_runtime::spawn_blocking(move || print_to(&app, &html, &out, page.sane()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(path.display().to_string())
}

/// Where to write: the save dialog, or LATTICE_PDF_TO in a debug build, so
/// scripts/desktop-matrix.sh can export with no one to click.
fn target(app: &AppHandle, name: &str) -> Result<Option<PathBuf>, String> {
    if cfg!(debug_assertions) {
        if let Ok(p) = std::env::var("LATTICE_PDF_TO") {
            return Ok(Some(PathBuf::from(p)));
        }
    }
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app
        .dialog()
        .file()
        .set_file_name(file_name(name))
        .add_filter("PDF", &["pdf"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    picked.into_path().map(Some).map_err(|e| e.to_string())
}

type Done = Arc<Mutex<Option<mpsc::Sender<Result<(), String>>>>>;
/// the first answer wins: a finished print, a failure, the deadline
fn finish(d: &Done, r: Result<(), String>) {
    if let Some(tx) = d.lock().unwrap().take() {
        tx.send(r).ok();
    }
}

static SEQ: AtomicUsize = AtomicUsize::new(0);

/// What the print window may load besides the document: data: URLs and
/// the document's own inline styles. No file:, no http, no frames.
const SEAL: &str = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; \
     img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:\">";

/// `html` with SEAL ahead of everything it holds, so the policy is in
/// force before the first load. After a doctype, so the page stays in
/// standards mode; the parser opens the head for the meta, and the
/// page's own <html> and <head> tags then join that.
fn sealed(html: &str) -> String {
    let t = html.trim_start_matches('\u{feff}').trim_start();
    let doctype = t.get(..9).is_some_and(|p| p.eq_ignore_ascii_case("<!doctype"));
    let rest = match t.find('>') {
        Some(i) if doctype => &t[i + 1..],
        _ => t,
    };
    format!("<!doctype html>{SEAL}{rest}")
}

/// Load the document into a hidden window, print it to `path` and close
/// the window again.
fn print_to(app: &AppHandle, html: &str, path: &Path, page: Page) -> Result<(), String> {
    use tauri::Manager as _;
    // the old file goes first: the dialog already asked about replacing
    // it, and a file left from before must not read as this export (macOS
    // waits for the file to appear)
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("could not replace {}: {e}", path.display())),
    }
    // a file of its own, not a data: URL, which tauri refuses without a
    // feature for it. Private, and gone again once printed.
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    let doc = dir.join(format!("pdf-{}-{seq}.html", std::process::id()));
    crate::session::write_private(&doc, sealed(html).as_bytes())?;
    let r = print_doc(app, &doc, path, page, seq);
    std::fs::remove_file(&doc).ok();
    r
}

fn print_doc(app: &AppHandle, doc: &Path, path: &Path, page: Page, seq: usize) -> Result<(), String> {
    let url = tauri::Url::from_file_path(doc).map_err(|()| "not a file path".to_string())?;
    let (tx, rx) = mpsc::channel();
    let done: Done = Arc::new(Mutex::new(Some(tx)));
    let started = Arc::new(AtomicBool::new(false));
    let label = format!("pdf-{seq}");
    let (d, out) = (done.clone(), path.to_path_buf());
    let home = url.clone();
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("lattice PDF export")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(816.0, 1056.0)
        .disable_javascript()
        // the document only: no refresh or link takes the window elsewhere
        .on_navigation(move |u| *u == home)
        .on_page_load(move |w, p| {
            if p.event() != tauri::webview::PageLoadEvent::Finished || started.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Err(e) = native::print(&w, &out, page, d.clone()) {
                finish(&d, Err(e));
            }
        })
        .build()
        .map_err(|e| format!("could not open the print window: {e}"))?;
    let r = rx
        .recv_timeout(DEADLINE)
        .unwrap_or_else(|_| Err("the PDF took too long to print".into()))
        .and_then(|()| native::written(path));
    win.destroy().ok();
    if r.is_err() {
        std::fs::remove_file(path).ok();
    }
    dlog(&format!("export_pdf {}: {r:?}", path.display()));
    r
}

/// A PDF is there and complete: the operation's "finished" can come before
/// the last write lands, and macOS has no finished at all here.
fn complete(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let Ok(len) = f.seek(SeekFrom::End(0)) else { return false };
    if len < 64 || f.seek(SeekFrom::End(-32)).is_err() {
        return false;
    }
    let mut tail = Vec::new();
    f.read_to_end(&mut tail).is_ok() && tail.windows(5).any(|w| w == b"%%EOF")
}

/// Wait for `path` to hold a complete PDF.
fn wait_written(path: &Path, limit: Duration) -> Result<(), String> {
    let t = Instant::now();
    while t.elapsed() < limit {
        if complete(path) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("the PDF was not written".into())
}

#[cfg(target_os = "linux")]
mod native {
    use super::{finish, Done, Page};
    use std::path::Path;
    use std::time::Duration;

    /// GTK's file printer, by the name GTK gives it, which is translated
    /// (gtkprintbackendfile.c names it _("Print to File") in GTK's domain).
    fn file_printer() -> String {
        gtk::glib::dgettext(Some("gtk30"), "Print to File").to_string()
    }

    pub fn print(w: &tauri::WebviewWindow, path: &Path, page: Page, done: Done) -> Result<(), String> {
        let path = path.to_path_buf();
        w.with_webview(move |pw| {
            if let Err(e) = print_view(&pw.inner(), &path, page, done.clone()) {
                finish(&done, Err(e));
            }
        })
        .map_err(|e| e.to_string())
    }

    /// Print what `view` shows to a PDF at `path`, on GTK's main thread.
    pub fn print_view(view: &webkit2gtk::WebView, path: &Path, page: Page, done: Done) -> Result<(), String> {
        let uri = tauri::Url::from_file_path(path).map_err(|()| "not a file path".to_string())?;
        {
            use webkit2gtk::PrintOperationExt;
            let op = webkit2gtk::PrintOperation::new(view);
            let s = gtk::PrintSettings::new();
            s.set_printer(&file_printer());
            s.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
            s.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(uri.as_str()));
            op.set_print_settings(&s);
            let ps = gtk::PageSetup::new();
            if let (Some(wd), Some(ht)) = (page.width, page.height) {
                ps.set_paper_size(&gtk::PaperSize::new_custom("lattice", "lattice", wd, ht, gtk::Unit::Mm));
            }
            ps.set_top_margin(page.top, gtk::Unit::Mm);
            ps.set_right_margin(page.right, gtk::Unit::Mm);
            ps.set_bottom_margin(page.bottom, gtk::Unit::Mm);
            ps.set_left_margin(page.left, gtk::Unit::Mm);
            op.set_page_setup(&ps);
            let d = done.clone();
            op.connect_finished(move |_| finish(&d, Ok(())));
            let d = done.clone();
            op.connect_failed(move |_, e| finish(&d, Err(format!("printing failed: {e}"))));
            op.print();
        }
        Ok(())
    }

    /// "finished" means the job is spooled; the file printer writes it out
    /// a moment later
    pub fn written(path: &Path) -> Result<(), String> {
        super::wait_written(path, Duration::from_secs(10))
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::{finish, Done, Page};
    use std::path::Path;
    use std::time::Duration;

    const PT_PER_MM: f64 = 72.0 / 25.4;

    pub fn print(w: &tauri::WebviewWindow, path: &Path, page: Page, done: Done) -> Result<(), String> {
        let path = path.to_string_lossy().into_owned();
        w.with_webview(move |pw| {
            use objc2::runtime::AnyObject;
            use objc2_app_kit::{
                NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode, NSWindow,
            };
            use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL};
            use objc2_web_kit::WKWebView;
            // SAFETY: tauri hands over the window's live WKWebView and
            // NSWindow, on the main thread, for the length of this closure
            let (wv, win) = unsafe {
                (&*(pw.inner() as *const WKWebView), &*(pw.ns_window() as *const NSWindow))
            };
            let info = NSPrintInfo::new();
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
            let url: &AnyObject = &url;
            // SAFETY: the job's saving URL is an NSURL, as AppKit documents
            unsafe {
                info.setJobDisposition(NSPrintSaveJob);
                info.dictionary().insert(NSPrintJobSavingURL, url);
            }
            if let (Some(wd), Some(ht)) = (page.width, page.height) {
                info.setPaperSize(NSSize::new(wd * PT_PER_MM, ht * PT_PER_MM));
            }
            info.setTopMargin(page.top * PT_PER_MM);
            info.setRightMargin(page.right * PT_PER_MM);
            info.setBottomMargin(page.bottom * PT_PER_MM);
            info.setLeftMargin(page.left * PT_PER_MM);
            info.setHorizontalPagination(NSPrintingPaginationMode::Automatic);
            info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
            info.setVerticallyCentered(false);
            info.setHorizontallyCentered(false);
            // SAFETY: a print operation from the view it prints, run modal
            // for that view's window, with no delegate to call back
            unsafe {
                let op = wv.printOperationWithPrintInfo(&info);
                op.setShowsPrintPanel(false);
                op.setShowsProgressPanel(false);
                // WKWebView prints blank pages from a view with no frame
                if let Some(v) = op.view() {
                    let s = info.paperSize();
                    v.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), s));
                }
                op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                    win,
                    None,
                    None,
                    std::ptr::null_mut(),
                );
            }
            // the save job has no callback without a delegate: written()
            // waits for the file instead
            finish(&done, Ok(()));
        })
        .map_err(|e| e.to_string())
    }

    pub fn written(path: &Path) -> Result<(), String> {
        super::wait_written(path, Duration::from_secs(60))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod native {
    use super::{Done, Page};
    use std::path::Path;

    pub fn print(_: &tauri::WebviewWindow, _: &Path, _: Page, _: Done) -> Result<(), String> {
        Err("PDF export is not supported on this platform".into())
    }

    pub fn written(_: &Path) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(w: Option<f64>, h: Option<f64>, m: f64) -> Page {
        Page { width: w, height: h, top: m, right: m, bottom: m, left: m }
    }

    #[test]
    fn a_sane_page_is_kept() {
        let p = page(Some(210.0), Some(297.0), 20.0);
        assert_eq!(p.sane(), p);
        assert_eq!(page(None, None, 18.0).sane(), page(None, None, 18.0));
    }

    #[test]
    fn a_bad_page_falls_back() {
        // one side only, or out of range: the default paper
        assert_eq!(page(Some(210.0), None, 10.0).sane().width, None);
        assert_eq!(page(Some(1.0), Some(297.0), 10.0).sane().height, None);
        assert_eq!(page(Some(f64::NAN), Some(297.0), 10.0).sane().width, None);
        // margins: negative, not a number, or past a third of the paper
        assert_eq!(page(None, None, -1.0).sane().top, 18.0);
        assert_eq!(page(None, None, f64::INFINITY).sane().left, 18.0);
        assert_eq!(page(Some(60.0), Some(60.0), 30.0).sane().right, 18.0);
        assert_eq!(page(Some(50.0), Some(50.0), 40.0).sane().right, 50.0 / 3.0);
    }

    #[test]
    fn file_names_stay_in_the_folder() {
        assert_eq!(file_name("notes"), "notes.pdf");
        assert_eq!(file_name("Report.PDF"), "Report.PDF");
        // no separator survives, so the name cannot leave the folder
        assert_eq!(file_name("../../etc/passwd"), ".. etc passwd.pdf");
        assert_eq!(file_name("a/b\\c:d"), "a b c d.pdf");
        assert_eq!(file_name(""), "page.pdf");
        assert_eq!(file_name("..."), "page.pdf");
        assert_eq!(file_name("x\u{0}y"), "x y.pdf");
    }

    #[test]
    fn the_seal_comes_first_and_keeps_standards_mode() {
        let s = sealed("\u{feff}  <!DOCTYPE html><html lang=en><head><title>t</title></head><body>x</body></html>");
        assert!(s.starts_with(&format!("<!doctype html>{SEAL}<html lang=en>")), "{s}");
        assert_eq!(s.matches("<!doctype").count() + s.matches("<!DOCTYPE").count(), 1);
        // no doctype, or a fragment: the seal still leads
        assert_eq!(sealed("<p>x"), format!("<!doctype html>{SEAL}<p>x"));
        assert_eq!(sealed(""), format!("<!doctype html>{SEAL}"));
        assert!(SEAL.contains("default-src 'none'"));
    }

    /// In WebKitGTK, the engine the print window is on Linux: a page that
    /// points an image, a stylesheet, a CSS url(), an iframe and an object
    /// at local files, and the same at an http host, loads none of them
    /// once sealed, and its PDF holds no local file's text. Unsealed, the
    /// same page loads them and prints the file, which is what this guards.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs a display (xvfb-run) and pdftotext"]
    fn webkit_prints_no_local_file_and_loads_no_outside_content() {
        use std::cell::RefCell;
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;
        use std::rc::Rc;
        use gtk::prelude::*;
        use webkit2gtk::{glib, SettingsExt, URIRequestExt, WebViewExt};
        let dir = std::env::temp_dir().join(format!("lattice-pdf-seal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mark = format!("LOCALSECRET{}", std::process::id());
        std::fs::write(dir.join("secret.txt"), format!("{mark}\n")).unwrap();
        std::fs::write(dir.join("secret.css"), "h1{color:red}").unwrap();
        // the outside host, counting what reaches it
        let out = TcpListener::bind(("127.0.0.2", 0)).unwrap();
        let http = format!("http://127.0.0.2:{}", out.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            for c in out.incoming().flatten() {
                let mut line = String::new();
                if BufReader::new(&c).read_line(&mut line).is_ok() {
                    s2.lock().unwrap().push(line.split(' ').nth(1).unwrap_or("").to_string());
                }
                let _ = (&c).write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
        });
        let f = |n: &str| format!("file://{}/{n}", dir.display());
        let html = format!(
            "<!doctype html><html><head><title>t</title>\
             <link rel=stylesheet href=\"{css}\"><link rel=stylesheet href=\"{http}/r.css\">\
             <style>body{{background:url('{bg}')}}h1{{background:url('{http}/bg.png')}}</style></head>\
             <body><h1>doc</h1><p>own text</p>\
             <img src=\"{txt}\"><img src=\"file:///etc/hostname\"><img src=\"{http}/img.png\">\
             <iframe src=\"{txt}\"></iframe><object data=\"{txt}\" type=\"text/plain\"></object>\
             <iframe src=\"{http}/frame\"></iframe>\
             <img src=\"data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=\"></body></html>",
            css = f("secret.css"), bg = f("bg.png"), txt = f("secret.txt"),
        );
        gtk::init().expect("a display");
        let wv = webkit2gtk::WebView::new();
        if let Some(s) = WebViewExt::settings(&wv) {
            s.set_enable_javascript(false);
        }
        let win = gtk::Window::new(gtk::WindowType::Toplevel);
        win.add(&wv);
        win.set_default_size(816, 1056);
        win.show_all();
        let loads = Rc::new(RefCell::new(Vec::<String>::new()));
        let l2 = loads.clone();
        wv.connect_resource_load_started(move |_, _, req| {
            if let Some(u) = req.uri() {
                l2.borrow_mut().push(u.to_string());
            }
        });
        let pump = |ms: u64| {
            let until = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < until {
                glib::MainContext::default().iteration(false);
                std::thread::sleep(Duration::from_millis(5));
            }
        };
        // load `doc` as the print window would, print it, and answer what
        // it loaded besides itself and the PDF's text
        let run = |name: &str, doc: String| -> (Vec<String>, String) {
            let file = dir.join(format!("{name}.html"));
            std::fs::write(&file, doc).unwrap();
            let me = tauri::Url::from_file_path(&file).unwrap().to_string();
            loads.borrow_mut().clear();
            seen.lock().unwrap().clear();
            wv.load_uri(&me);
            pump(2500);
            let pdf = dir.join(format!("{name}.pdf"));
            let (tx, rx) = mpsc::channel();
            let done: Done = Arc::new(Mutex::new(Some(tx)));
            native::print_view(&wv, &pdf, Page { width: None, height: None, top: 18.0, right: 18.0, bottom: 18.0, left: 18.0 }, done).unwrap();
            let until = Instant::now() + Duration::from_secs(30);
            let mut r = None;
            while r.is_none() && Instant::now() < until {
                glib::MainContext::default().iteration(false);
                r = rx.try_recv().ok();
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(matches!(r, Some(Ok(()))), "printed: {r:?}");
            native::written(&pdf).unwrap();
            pump(1000);
            let text = std::process::Command::new("pdftotext").arg(&pdf).arg("-").output().expect("pdftotext");
            let mut got: Vec<String> = loads.borrow().iter().filter(|u| **u != me).cloned().collect();
            got.extend(seen.lock().unwrap().iter().map(|p| format!("{http}{p}")));
            (got, String::from_utf8_lossy(&text.stdout).into_owned())
        };
        // the control: unsealed, the local file is loaded and printed
        let (got, text) = run("open", html.clone());
        assert!(got.iter().any(|u| u.starts_with("file://")), "unsealed loads: {got:?}");
        assert!(got.iter().any(|u| u.starts_with(&http)), "and reaches the outside host: {got:?}");
        assert!(text.contains(&mark), "unsealed, the file's text is in the PDF: {text}");
        // sealed: nothing but the document and its data: image
        let (got, text) = run("sealed", sealed(&html));
        let other: Vec<&String> = got.iter().filter(|u| !u.starts_with("data:")).collect();
        assert!(other.is_empty(), "sealed loads: {other:?}");
        assert!(text.contains("own text"), "the page itself still prints: {text}");
        assert!(!text.contains(&mark), "and no local file: {text}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_a_whole_pdf_counts_as_written() {
        let dir = std::env::temp_dir().join(format!("lattice-pdf-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.pdf");
        assert!(!complete(&p));
        std::fs::write(&p, b"%PDF-1.5\n").unwrap();
        assert!(!complete(&p));
        let mut body = b"%PDF-1.5\n".to_vec();
        body.extend(std::iter::repeat_n(b' ', 100));
        body.extend(b"\n%%EOF\n");
        std::fs::write(&p, &body).unwrap();
        assert!(complete(&p));
        std::fs::remove_dir_all(&dir).ok();
    }
}
