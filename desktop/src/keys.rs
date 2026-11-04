//! The window's keyboard shortcuts, now that there is no menubar to carry
//! them.
//!
//! The ship UI owns most keys itself (ctrl-S, ctrl-K, ctrl-E, ctrl-W, the
//! vim chords). What is left here is what the page cannot do, or what the
//! old File and View menus gave a key:
//!
//!   ctrl-N, ctrl-shift-N        new page, new folder (the sidebar buttons)
//!   ctrl-1, ctrl-3              Edit and Read for the open tab
//!   ctrl-B, ctrl-shift-B        the tree and controls panes
//!   ctrl-= ctrl-- ctrl-0        zoom in, out, back to 100%
//!   F5, ctrl-shift-R            reload (ctrl-R is vim's redo)
//!   ctrl-shift-I                the inspector, debug builds only
//!   ctrl-Q                      quit
//!
//! On Linux they are caught on the GTK window, before WebKit sees them, so
//! they also work with focus in a frame. macOS keeps a small menu instead
//! (main.rs), because WKWebView only gets copy and paste through its Edit
//! items; the shell items there call `run` with the same ids.

use crate::commands;
use tauri::{AppHandle, Manager};

/// The id a chord stands for. Pure, so the table is testable. `key` is the
/// character the key types, lowercased, or the key's name for one that types
/// nothing ("F5").
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn chord(ctrl: bool, shift: bool, key: &str) -> Option<&'static str> {
    if !ctrl {
        return match key {
            "F5" if !shift => Some("reload"),
            _ => None,
        };
    }
    Some(match (shift, key) {
        (false, "n") => "file-new",
        (true, "n") => "file-new-folder",
        (false, "1") => "view-editor",
        (false, "3") => "view-preview",
        (false, "b") => "view-tree",
        (true, "b") => "view-controls",
        (_, "=") | (_, "+") => "zoom-in",
        (_, "-") | (_, "_") => "zoom-out",
        (false, "0") => "zoom-reset",
        (true, "r") => "reload",
        (true, "i") if cfg!(debug_assertions) => "devtools",
        (false, "q") => "quit",
        _ => return None,
    })
}

/// The zoom a step lands on, kept between 30% and 300%.
pub fn zoom_step(now: f64, id: &str) -> f64 {
    let next = match id {
        "zoom-in" => now + 0.1,
        "zoom-out" => now - 0.1,
        _ => 1.0,
    };
    (next.clamp(0.3, 3.0) * 10.0).round() / 10.0
}

/// The window's zoom, which WebKit does not report back.
static ZOOM: std::sync::Mutex<f64> = std::sync::Mutex::new(1.0);

/// Run one shortcut. Unknown ids do nothing.
pub fn run(app: &AppHandle, id: &str) {
    if id == "quit" {
        app.exit(0);
        return;
    }
    let Some(w) = app.get_webview_window("workspace") else { return };
    match id {
        "reload" => {
            let _ = w.reload();
        }
        "zoom-in" | "zoom-out" | "zoom-reset" => {
            let mut z = ZOOM.lock().unwrap();
            *z = zoom_step(*z, id);
            let _ = w.set_zoom(*z);
        }
        #[cfg(debug_assertions)]
        "devtools" => w.open_devtools(),
        _ => {
            // The page commands drive the ship UI's OWN controls instead of
            // reimplementing them: a click on the real button, or the tab
            // header's latSetRead. One code path, and nothing here to drift
            // from the page. A missing element is a no-op, not an error: a
            // key can arrive before the page has booted, and on the manager
            // page, which has none of these.
            if commands::on_shell_page(&w) {
                return;
            }
            let read = match id {
                "view-editor" => Some("latSetRead(false)"),
                "view-preview" => Some("latSetRead(true)"),
                _ => None,
            };
            if let Some(call) = read {
                let _ = w.eval(format!("if(window.latSetRead){call}"));
                return;
            }
            let btn = match id {
                "file-new" => "newfile",
                "file-new-folder" => "newfolder",
                "view-tree" => "treet",
                "view-controls" => "ctlt",
                _ => return,
            };
            let _ = w.eval(format!(
                "(function(){{var b=document.getElementById('{btn}');if(b)b.click();}})()"
            ));
        }
    }
}

/// Catch the shortcuts on the workspace's GTK window. A handler connected
/// to key-press-event runs before the window's own, which is what hands
/// the key to WebKit, so a shortcut that matches never reaches the page.
#[cfg(target_os = "linux")]
pub fn attach(w: &tauri::WebviewWindow) {
    use gtk::prelude::*;
    let Ok(gw) = w.gtk_window() else { return };
    let app = w.app_handle().clone();
    gw.connect_key_press_event(move |_, ev| {
        let m = ev.state();
        if m.contains(gtk::gdk::ModifierType::MOD1_MASK) || m.contains(gtk::gdk::ModifierType::SUPER_MASK) {
            return gtk::glib::Propagation::Proceed;
        }
        let kv = ev.keyval();
        let key = match kv.to_unicode() {
            Some(c) if !c.is_control() => c.to_lowercase().to_string(),
            _ => kv.name().map(|n| n.to_string()).unwrap_or_default(),
        };
        let ctrl = m.contains(gtk::gdk::ModifierType::CONTROL_MASK);
        let shift = m.contains(gtk::gdk::ModifierType::SHIFT_MASK);
        match chord(ctrl, shift, &key) {
            Some(id) => {
                run(&app, id);
                gtk::glib::Propagation::Stop
            }
            None => gtk::glib::Propagation::Proceed,
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub fn attach(_w: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::{chord, zoom_step};

    #[test]
    fn chords_name_their_commands() {
        assert_eq!(chord(true, false, "n"), Some("file-new"));
        assert_eq!(chord(true, true, "n"), Some("file-new-folder"));
        assert_eq!(chord(true, false, "1"), Some("view-editor"));
        assert_eq!(chord(true, false, "3"), Some("view-preview"));
        assert_eq!(chord(true, false, "b"), Some("view-tree"));
        assert_eq!(chord(true, true, "b"), Some("view-controls"));
        assert_eq!(chord(true, false, "="), Some("zoom-in"));
        assert_eq!(chord(true, true, "+"), Some("zoom-in"));
        assert_eq!(chord(true, false, "-"), Some("zoom-out"));
        assert_eq!(chord(true, false, "0"), Some("zoom-reset"));
        assert_eq!(chord(false, false, "F5"), Some("reload"));
        assert_eq!(chord(true, true, "r"), Some("reload"));
        assert_eq!(chord(true, false, "q"), Some("quit"));
        assert_eq!(chord(true, true, "i"), cfg!(debug_assertions).then_some("devtools"));
    }

    #[test]
    fn the_page_keeps_its_own_keys() {
        // copy, paste, cut, select all, undo, redo, save, palette, Edit and
        // Read, close tab, vim's redo: none of them are taken here
        for k in ["c", "v", "x", "a", "z", "s", "k", "p", "e", "w", "r", "["] {
            assert_eq!(chord(true, false, k), None, "ctrl-{k}");
        }
        assert_eq!(chord(true, true, "z"), None);
        assert_eq!(chord(false, false, "n"), None);
    }

    #[test]
    fn zoom_stays_in_bounds() {
        assert_eq!(zoom_step(1.0, "zoom-in"), 1.1);
        assert_eq!(zoom_step(1.0, "zoom-out"), 0.9);
        assert_eq!(zoom_step(2.0, "zoom-reset"), 1.0);
        assert_eq!(zoom_step(3.0, "zoom-in"), 3.0);
        assert_eq!(zoom_step(0.3, "zoom-out"), 0.3);
    }
}
