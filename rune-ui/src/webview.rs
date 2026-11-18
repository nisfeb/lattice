//! An HTML page shown as a browser shows it, with its own styles, layout
//! and scripts, in the system's web view (WebKitGTK, through `wry`).
//!
//! Rune has no element that holds a web view, so the view is the
//! platform's own, kept over a hole in the page's place. On X11 it is a
//! child of the window and stands in the page's place. On Wayland a web
//! view can only live in a window GTK made, so there the page has a
//! window of its own, in a process of its own: GTK beside Rune in one
//! process on Wayland lost its connection to the display and took the
//! app down with it (seen on an NVIDIA card), and a helper that fails
//! takes only the page's window.
//!
//! The page is given to the view as text. It has no session with the
//! ship: its scripts run as a stranger's would, and cannot read or write
//! the owner's pages.

use std::cell::RefCell;

use gtk::prelude::*;
use wry::WebViewBuilderExtUnix;

enum Held {
    /// In the page's place, a child of the app's window.
    Child(wry::WebView),
    /// In a window of its own, in a helper process: this program again, run as `--web-view`.
    Own(std::process::Child),
}

#[derive(Default)]
struct State {
    window: Option<rune::WindowHandle>,
    /// GTK started, or could not and is not tried again.
    gtk: Option<bool>,
    /// The page showing: its name and revision, and the view.
    shown: Option<(String, u64, Held)>,
    /// A page whose own window the reader closed: not opened again until asked for.
    closed: Option<(String, u64)>,
    /// Where the child view was last put, and whether it shows.
    placed: ([f32; 4], bool),
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// Whether the app's window will be a Wayland one, as winit chooses it.
fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
}

/// Starts GTK before the app's own window is made, on X11 only. Started after the window, a web
/// view came up and drew nothing. On Wayland GTK is never started in this process.
pub fn start() {
    if !wayland() {
        STATE.with(|s| s.borrow_mut().gtk = Some(gtk::init().is_ok()));
    }
}

/// The helper: one window showing the HTML file named, until it is closed. Run as
/// `lattice-rune --web-view FILE TITLE`, and never returns.
pub fn helper(file: &str, title: &str) -> ! {
    let ok = (|| {
        let html = std::fs::read_to_string(file).ok()?;
        gtk::init().ok()?;
        let w = gtk::Window::new(gtk::WindowType::Toplevel);
        w.set_title(title);
        w.set_default_size(960, 720);
        let b = gtk::Box::new(gtk::Orientation::Vertical, 0);
        w.add(&b);
        let view = builder(&html).build_gtk(&b).ok()?;
        w.connect_delete_event(|_, _| {
            gtk::main_quit();
            gtk::glib::Propagation::Proceed
        });
        w.show_all();
        // the app gone, however it went, the page's window goes too
        let app = std::os::unix::process::parent_id();
        gtk::glib::timeout_add_seconds_local(1, move || {
            if std::os::unix::process::parent_id() != app {
                gtk::main_quit();
            }
            gtk::glib::ControlFlow::Continue
        });
        gtk::main();
        drop(view);
        Some(())
    })();
    std::process::exit(if ok.is_some() { 0 } else { 1 })
}

/// Starts the helper on a page: its text in a file only the owner reads, and what it says kept beside it.
fn spawn(name: &str, html: &str) -> Option<std::process::Child> {
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from).filter(|d| d.is_dir()).unwrap_or_else(std::env::temp_dir).join("lattice-rune");
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!("web-view-{}.html", std::process::id()));
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&file).ok()?;
        f.write_all(html.as_bytes()).ok()?;
    }
    let log = std::fs::File::create(dir.join("web-view.log")).ok();
    let mut cmd = std::process::Command::new(std::env::current_exe().ok()?);
    cmd.arg("--web-view").arg(&file).arg(format!("{name} \u{2013} lattice"));
    // WebKitGTK on an NVIDIA card under Wayland loses its connection to the display over
    // these two (the "Error 71" protocol error): both are turned off for the helper
    cmd.env("WEBKIT_DISABLE_DMABUF_RENDERER", "1").env("__NV_DISABLE_EXPLICIT_SYNC", "1");
    if let Some(log) = log {
        cmd.stderr(log);
    }
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).spawn().ok()
}

/// Notes the app's window when it is made, to hang a view on.
pub fn note_window(h: &rune::WindowHandle) {
    STATE.with(|s| s.borrow_mut().window = Some(h.clone()));
}

/// Whether a page can be shown this way at all: false once GTK has refused to start.
pub fn usable() -> bool {
    STATE.with(|s| s.borrow().gtk != Some(false))
}

/// Lets go of the page's own window, as when the app is closing.
pub fn stop() {
    STATE.with(|s| {
        if let Some((_, _, Held::Own(mut child))) = s.borrow_mut().shown.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    });
}

/// Whether the view stands in the page's place (X11), or has a window of its own (Wayland).
/// Nothing until the window is known.
pub fn inline() -> Option<bool> {
    STATE.with(|s| s.borrow().window.as_ref().map(on_x11))
}

/// Whether the app's window is an X11 one, which a web view can be a child of.
/// `LATTICE_RUNE_WEB_WINDOW` asks for the page's own window there too.
fn on_x11(w: &rune::WindowHandle) -> bool {
    std::env::var_os("LATTICE_RUNE_WEB_WINDOW").is_none()
        && w.with_raw_handle(|raw| matches!(raw.as_raw(), rune::raw_window_handle::RawWindowHandle::Xlib(_) | rune::raw_window_handle::RawWindowHandle::Xcb(_))).unwrap_or(false)
}

/// Whether a view is up, so GTK's loop is to be kept turning.
pub fn active() -> bool {
    STATE.with(|s| s.borrow().shown.is_some())
}

/// Whether the reader closed the page's own window.
pub fn closed() -> bool {
    STATE.with(|s| s.borrow().closed.is_some())
}

/// Opens the page's own window again after the reader closed it.
pub fn reopen() {
    STATE.with(|s| s.borrow_mut().closed = None);
}

fn bounds(r: [f32; 4]) -> wry::Rect {
    wry::Rect { position: wry::dpi::LogicalPosition::new(r[0] as f64, r[1] as f64).into(), size: wry::dpi::LogicalSize::new(r[2].max(1.0) as f64, r[3].max(1.0) as f64).into() }
}

/// A link pressed in the page goes to the system's browser. The page itself never leaves the view.
fn builder<'a>(html: &str) -> wry::WebViewBuilder<'a> {
    wry::WebViewBuilder::new().with_html(html).with_navigation_handler(|url: String| {
        if url.starts_with("about:") {
            return true;
        }
        if url.starts_with("https://") || url.starts_with("http://") {
            let _ = std::process::Command::new("xdg-open").arg(url).spawn();
        }
        false
    })
}

/// Keeps what is shown in step with the app, once a frame: the page
/// wanted (its name, revision and text) or none, where its place is, and
/// whether something of the app's is drawn over that place. A native view
/// stands over everything the app draws, so it is hidden while a dialog or a menu is up.
pub fn sync(want: Option<(&str, u64, &str)>, rect: [f32; 4], covered: bool) {
    STATE.with(|st| {
        let mut st = st.borrow_mut();
        let Some((name, rev, html)) = want else {
            if let Some((_, _, Held::Own(mut child))) = st.shown.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            st.closed = None;
            return;
        };
        if st.closed.as_ref().is_some_and(|(n, r)| n == name && *r == rev) {
            return;
        }
        st.closed = None;
        // the page's own window, closed by the reader: let go of, and not opened again by itself
        let gone = match &mut st.shown {
            Some((_, _, Held::Own(child))) => !matches!(child.try_wait(), Ok(None)),
            _ => false,
        };
        if gone {
            st.shown = None;
            st.closed = Some((name.to_owned(), rev));
            return;
        }
        match &mut st.shown {
            Some((n, r, held)) if n == name => {
                if *r != rev {
                    match held {
                        Held::Child(v) => drop(v.load_html(html)),
                        // the page changed: its window is started again on the new text
                        Held::Own(child) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            if let Some(c) = spawn(name, html) {
                                *child = c;
                            }
                        }
                    }
                    *r = rev;
                }
            }
            _ => {
                if let Some((_, _, Held::Own(mut child))) = st.shown.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                let Some(window) = st.window.clone() else { return };
                let own = !on_x11(&window);
                // a view in the page's place is made once that place is known, and where it is: made
                // elsewhere, hidden and shown again, it came up black
                if !own && (rect[2] <= 1.0 || rect[3] <= 1.0) {
                    return;
                }
                let held = if own {
                    spawn(name, html).map(Held::Own)
                } else if st.gtk == Some(true) {
                    match window.with_raw_handle(|raw| builder(html).with_bounds(bounds(rect)).build_as_child(&raw)) {
                        Ok(Ok(v)) => Some(Held::Child(v)),
                        _ => None,
                    }
                } else {
                    None
                };
                match held {
                    Some(h) => {
                        st.shown = Some((name.to_owned(), rev, h));
                        // made where it stands and showing: nothing more to tell it until that changes
                        st.placed = (rect, true);
                    }
                    // the view could not be made: the page is read as a document from here on
                    None => st.gtk = Some(false),
                }
            }
        }
        // out of the way, it is moved off the window and not hidden: a view hidden and shown again draws nothing
        let show = !covered && rect[2] > 1.0 && rect[3] > 1.0;
        if st.placed != (rect, show) {
            if let Some((_, _, Held::Child(v))) = &st.shown {
                let at = if show { rect } else { [-20_000.0, -20_000.0, rect[2].max(2.0), rect[3].max(2.0)] };
                let _ = v.set_bounds(bounds(at));
            }
            st.placed = (rect, show);
        }
    });
}

/// Turns GTK's own loop, from the app's frame hook.
pub fn pump() {
    if STATE.with(|s| s.borrow().gtk == Some(true)) {
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
    }
}
