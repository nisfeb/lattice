//! Self-update, modelled on Talon's desktop updater: check at startup and
//! every few hours, offer the new version with its notes, show progress
//! while it downloads, then restart into it.
//!
//! The manifest is `latest.json` on the newest published GitHub release,
//! which release.yml builds. Every artifact it points at is minisign-signed,
//! and tauri-plugin-updater refuses one whose signature does not verify
//! against the public key in tauri.conf.json, so a tampered release asset
//! or a hijacked download cannot install itself.
//!
//! Only the AppImage and the macOS app replace themselves. A .deb belongs
//! to the package manager, so it gets the release page instead.
//!
//! Offline is not an error anyone needs to hear about: a check that cannot
//! reach GitHub is logged (LATTICE_LOG) and tried again next period.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::commands::dlog;

/// Long enough for the window to come up and the bridge to settle, so the
/// first offer does not land on a half-drawn window.
const FIRST_CHECK: Duration = Duration::from_secs(20);
/// Talon's cadence (UPDATE_MIN_INTERVAL_MS).
const PERIOD: Duration = Duration::from_secs(6 * 60 * 60);
const RELEASES_PAGE: &str = "https://github.com/nisfeb/lattice/releases/latest";
/// Notes beyond this many lines are cut: a dialog is not a changelog viewer.
const NOTE_LINES: usize = 12;

/// How this copy can take an update.
#[derive(Debug, PartialEq)]
pub enum Flavor {
    /// Swap the AppImage at this path for the new one.
    AppImage(PathBuf),
    /// Swap the .app bundle (macOS).
    App,
    /// Installed by a package manager (the .deb), or run from a bare
    /// binary: show the release page and let the user install it.
    ReleasePage,
}

/// From the process's own environment, as Talon does: the AppImage runtime
/// sets APPIMAGE to the file it was started from.
pub fn flavor(appimage: Option<&str>, macos: bool) -> Flavor {
    match appimage {
        Some(p) if !p.is_empty() => Flavor::AppImage(PathBuf::from(p)),
        _ if macos => Flavor::App,
        _ => Flavor::ReleasePage,
    }
}

/// The offer's text: what is new, what is installed, then the notes.
pub fn offer_text(version: &str, current: &str, notes: Option<&str>, flavor: &Flavor) -> String {
    let mut s = format!("lattice {version} is available. You have {current}.");
    let notes = notes.map(str::trim).unwrap_or("");
    if !notes.is_empty() {
        let lines: Vec<&str> = notes.lines().collect();
        s.push_str("\n\n");
        s.push_str(&lines[..lines.len().min(NOTE_LINES)].join("\n"));
        if lines.len() > NOTE_LINES {
            s.push_str("\n…");
        }
    }
    if *flavor == Flavor::ReleasePage {
        s.push_str("\n\nThis install is managed by your package manager, so the \
                    new version has to be installed from the release page.");
    }
    s
}

/// JS that draws (or updates, or with None removes) the download banner in
/// whatever page the window shows. It only ever builds DOM from our own
/// strings via textContent, and creates the element when missing, so a page
/// that navigated mid-download gets it back on the next tick.
pub fn banner_js(text: Option<&str>, pct: Option<u8>) -> String {
    let Some(text) = text else {
        return "(function(){var b=document.getElementById('lat-update-banner');if(b)b.remove();})()".into();
    };
    let text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let pct = pct.map(|p| p.min(100)).unwrap_or(0);
    format!(
        "(function(){{var b=document.getElementById('lat-update-banner');\
         if(!b){{b=document.createElement('div');b.id='lat-update-banner';\
         b.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647;\
         min-width:240px;padding:10px 12px;border-radius:10px;font:13px system-ui,sans-serif;\
         background:#24324a;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none';\
         var t=document.createElement('div');t.className='t';b.appendChild(t);\
         var r=document.createElement('div');r.style.cssText='margin-top:6px;height:4px;\
         border-radius:2px;background:rgba(255,255,255,.25)';var f=document.createElement('div');\
         f.className='f';f.style.cssText='height:100%;width:0;border-radius:2px;background:#fff';\
         r.appendChild(f);b.appendChild(r);(document.body||document.documentElement).appendChild(b);}}\
         b.querySelector('.t').textContent={text};b.querySelector('.f').style.width='{pct}%';}})()"
    )
}

/// What the restart runs once this process is gone. The waiter is needed
/// for the same reason Talon has one: the bridge's fixed port and the mounts
/// belong to this process until it exits, and a new copy started alongside
/// would land on another port, which is another origin and an empty cache.
fn relaunch_cmd(flavor: &Flavor) -> Option<(String, PathBuf)> {
    match flavor {
        Flavor::AppImage(p) => Some(("exec \"$2\"".into(), p.clone())),
        Flavor::App => {
            let exe = std::env::current_exe().ok()?;
            let app = exe.ancestors().find(|a| a.extension().is_some_and(|e| e == "app"))?;
            Some(("exec open -n \"$2\"".into(), app.to_path_buf()))
        }
        Flavor::ReleasePage => None,
    }
}

fn spawn_restart_after_exit(script: &str, target: &Path) -> std::io::Result<()> {
    let pid = std::process::id().to_string();
    let body = format!("while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; {script}");
    // Not in this process's working directory: inside an AppImage that is
    // the old image's mount, and a waiter (then the new app) sitting in it
    // keeps the old image mounted after it is gone. OWD is where the
    // AppImage runtime was started from, so the new copy starts there too.
    let cwd = std::env::var_os("OWD")
        .map(PathBuf::from)
        .filter(|d| d.is_dir())
        .unwrap_or_else(|| PathBuf::from("/"));
    let mut cmd = std::process::Command::new("sh");
    // The AppImage runtime hands the app an open descriptor on its mount
    // (fd 1023), without close-on-exec. Inherited by the waiter, then by
    // the new copy, it pinned the old image's mount and its runtime for
    // the life of the new app: one stale mount per update. Nothing the
    // waiter needs is above stderr, so close all of it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: only close(2) runs between fork and exec, and close is
        // async-signal-safe.
        unsafe {
            cmd.pre_exec(|| {
                let max = libc::sysconf(libc::_SC_OPEN_MAX);
                let max = if max <= 0 { 1024 } else { max.min(65536) as libc::c_int };
                for fd in 3..max {
                    libc::close(fd);
                }
                Ok(())
            });
        }
    }
    cmd.current_dir(cwd)
        .arg("-c")
        .arg(body)
        .arg("lattice-update-waiter")
        .arg(pid)
        .arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
}

fn ask(h: &AppHandle, title: &str, text: String, ok: &str, cancel: &str) -> bool {
    h.dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()))
        .blocking_show()
}

fn banner(h: &AppHandle, text: Option<&str>, pct: Option<u8>) {
    if let Some(w) = h.get_webview_window("workspace") {
        let _ = w.eval(banner_js(text, pct));
    }
}

/// What the loop remembers between checks. "Later" holds for that version
/// for the rest of this run; a newer one is offered again.
#[derive(Default)]
struct Seen {
    later: Vec<String>,
    installed: Option<String>,
}

fn check_once(h: &AppHandle, flavor: &Flavor, seen: &mut Seen) {
    let mut b = h.updater_builder();
    if let Flavor::AppImage(p) = flavor {
        b = b.executable_path(p);
    }
    let updater = match b.build() {
        Ok(u) => u,
        Err(e) => return dlog(&format!("update: no updater: {e}")),
    };
    let update = match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(u)) => u,
        Ok(None) => return dlog("update: up to date"),
        // offline, GitHub down, no release yet: try again next period
        Err(e) => return dlog(&format!("update: check failed: {e}")),
    };
    let v = update.version.clone();
    if seen.later.contains(&v) || seen.installed.as_deref() == Some(v.as_str()) {
        return;
    }
    let text = offer_text(&v, &update.current_version, update.body.as_deref(), flavor);
    if *flavor == Flavor::ReleasePage {
        if ask(h, "Update available", text, "Open release page", "Later") {
            if let Err(e) = crate::commands::open_external(RELEASES_PAGE) {
                dlog(&format!("update: {e}"));
            }
        }
        seen.later.push(v);
        return;
    }
    if !ask(h, "Update available", text, "Update", "Later") {
        seen.later.push(v);
        return;
    }

    let label = format!("Downloading lattice {v}…");
    banner(h, Some(&label), Some(0));
    let mut got: u64 = 0;
    let mut shown: Option<u8> = None;
    let res = tauri::async_runtime::block_on(update.download_and_install(
        |n, total| {
            got += n as u64;
            if let Some(t) = total.filter(|t| *t > 0) {
                let pct = ((got * 100) / t).min(99) as u8;
                if shown != Some(pct) {
                    shown = Some(pct);
                    banner(h, Some(&format!("{label} {pct}%")), Some(pct));
                }
            }
        },
        || banner(h, Some(&format!("Checking the signature of {v}…")), Some(100)),
    ));
    banner(h, None, None);
    if let Err(e) = res {
        dlog(&format!("update: install failed: {e}"));
        h.dialog()
            .message(format!(
                "Couldn't update to lattice {v}: {e}\n\nNothing was changed. \
                 It will be offered again later."
            ))
            .title("Update failed")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        return;
    }
    dlog(&format!("update: {v} installed"));
    seen.installed = Some(v.clone());
    let restart = ask(
        h,
        "Update installed",
        format!(
            "lattice {v} is installed and starts the next time lattice does.\n\n\
             Restart now? Save any open edits first."
        ),
        "Restart now",
        "Later",
    );
    if !restart {
        return;
    }
    match relaunch_cmd(flavor) {
        Some((script, target)) => match spawn_restart_after_exit(&script, &target) {
            Ok(()) => h.exit(0),
            Err(e) => dlog(&format!("update: could not restart: {e}")),
        },
        None => dlog("update: no way to restart this install"),
    }
}

/// The background checker. Release builds only: a dev build is never what
/// a release would replace.
pub fn spawn(h: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let appimage = std::env::var("APPIMAGE").ok();
    let flavor = flavor(appimage.as_deref(), cfg!(target_os = "macos"));
    dlog(&format!("update: this install is {flavor:?}"));
    std::thread::spawn(move || {
        let mut seen = Seen::default();
        std::thread::sleep(FIRST_CHECK);
        loop {
            check_once(&h, &flavor, &mut seen);
            std::thread::sleep(PERIOD);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appimage_env_means_appimage() {
        assert_eq!(flavor(Some("/home/x/lattice.AppImage"), false),
                   Flavor::AppImage(PathBuf::from("/home/x/lattice.AppImage")));
        assert_eq!(flavor(Some(""), false), Flavor::ReleasePage);
        assert_eq!(flavor(None, false), Flavor::ReleasePage);
        assert_eq!(flavor(None, true), Flavor::App);
    }

    #[test]
    fn offer_names_both_versions_and_cuts_long_notes() {
        let notes: String = (0..20).map(|i| format!("- change {i}\n")).collect();
        let s = offer_text("1.0.15", "1.0.14", Some(&notes), &Flavor::App);
        assert!(s.starts_with("lattice 1.0.15 is available. You have 1.0.14."));
        assert!(s.contains("- change 11") && !s.contains("- change 12"));
        assert!(s.ends_with('…'));
        assert!(!s.contains("package manager"));
    }

    #[test]
    fn deb_offer_explains_the_release_page() {
        let s = offer_text("1.0.15", "1.0.14", None, &Flavor::ReleasePage);
        assert!(s.contains("release page"));
        assert!(!s.contains("\n\n\n"));
    }

    #[test]
    fn banner_text_is_json_quoted_not_spliced() {
        let js = banner_js(Some("a'\"</script>"), Some(150));
        assert!(js.contains(r#"textContent="a'\"</script>""#));
        assert!(js.contains("width='100%'"));
        assert!(banner_js(None, None).contains("remove()"));
    }
}
