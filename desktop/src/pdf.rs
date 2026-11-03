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
    crate::session::write_private(&doc, html.as_bytes())?;
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
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("lattice PDF export")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .inner_size(816.0, 1056.0)
        .disable_javascript()
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
        let uri = tauri::Url::from_file_path(path).map_err(|()| "not a file path".to_string())?;
        w.with_webview(move |pw| {
            use webkit2gtk::PrintOperationExt;
            let op = webkit2gtk::PrintOperation::new(&pw.inner());
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
        })
        .map_err(|e| e.to_string())
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
