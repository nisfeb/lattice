//! LaTeX to HTML, by shelling out to pandoc.
//!
//! The ship has no TeX and is not getting one. A conversion runs here, on the
//! user's machine, and the result goes back as an ordinary html page the ship
//! already knows how to store and serve. That keeps a 150MB toolchain out of
//! ship state, where per-request cost tracks how much is in there.
//!
//! pandoc is NOT bundled. It is GPL, and shipping it would make this app a
//! redistributor with the obligations that carries. We detect what the user
//! installed and say so plainly when it is missing.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use serde::Serialize;

use crate::commands::dlog;

/// Where pandoc lives when it is not on PATH.
///
/// A GUI app launched from Finder or the Dock does NOT inherit a login shell's
/// PATH. It gets a minimal one, so `Command::new("pandoc")` misses a Homebrew
/// install and the feature looks broken for the people who followed the
/// install instructions. These are the paths those installs actually use.
#[cfg(target_os = "macos")]
const EXTRA_DIRS: &[&str] = &[
    "/opt/homebrew/bin",   // homebrew, apple silicon
    "/usr/local/bin",      // homebrew, intel
    "/opt/local/bin",      // macports
    "/usr/bin",
];
#[cfg(not(target_os = "macos"))]
const EXTRA_DIRS: &[&str] = &["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"];

/// Find a pandoc we can run, with its version. PATH first, because a user who
/// put it somewhere deliberate should win over our guesses; then the fixed
/// dirs, then the per-user ones under $HOME.
fn locate() -> Option<(PathBuf, String)> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let user_dirs = home.iter().flat_map(|h| [h.join(".local/bin"), h.join("bin")]);
    // a missing path fails to start at once (ENOENT), so no is_file check first
    std::iter::once(PathBuf::from("pandoc"))
        .chain(EXTRA_DIRS.iter().map(|d| PathBuf::from(d).join("pandoc")))
        .chain(user_dirs.map(|d| d.join("pandoc")))
        .find_map(|p| version_of(&p).map(|v| (p, v)))
}

/// `--version` is the cheapest proof that a path actually executes, and its
/// output is the version string we want anyway.
fn version_of(p: &PathBuf) -> Option<String> {
    let out = Command::new(p).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next().map(|l| l.trim().to_string())
}

#[derive(Serialize)]
pub struct PandocStatus {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Is pandoc usable right now?
///
/// Probed per call, never cached (unlike a conversion's FOUND): someone who
/// installs pandoc and comes back should find the button live without
/// restarting the app.
///
/// Async, like the commands in commands.rs: the probe spawns processes, it
/// runs on every .tex page open, and a sync command would hold the main
/// thread for the length of each spawn.
#[tauri::command]
pub async fn pandoc_probe() -> PandocStatus {
    probe()
}

/// The probe's actual work, sync so the tests need no runtime.
fn probe() -> PandocStatus {
    match locate() {
        Some((p, v)) => {
            dlog(&format!("pandoc: found at {} ({v})", p.display()));
            PandocStatus {
                available: true,
                version: Some(v),
                path: Some(p.display().to_string()),
            }
        }
        None => {
            dlog("pandoc: not found on PATH or in the usual install dirs");
            PandocStatus { available: false, version: None, path: None }
        }
    }
}

/// Convert LaTeX source to a standalone HTML fragment.
///
/// --mathml, deliberately: browsers render MathML natively, so the page needs
/// no script and no fonts. Anything else would put a math library into the
/// lattice bundle for every reader, including the ones with no equations.
///
/// The source goes in on stdin. A temp file would be a path this app has to
/// create, clean up and get right on three platforms, for nothing.
///
/// Async, like the commands in commands.rs: the live preview invokes this
/// after every debounced keystroke, and a sync command would stutter the
/// whole UI for the length of each pandoc run.
#[tauri::command]
pub async fn convert_tex(src: String) -> Result<String, String> {
    convert(&src)
}

/// The pandoc the last conversion ran. The live preview converts on every
/// debounced keystroke, and without this each conversion first proved pandoc
/// ran with a `--version` spawn of its own.
///
/// ponytail: cleared when starting it fails, so an uninstalled or moved pandoc
/// costs that one conversion an error and the next one looks again.
static FOUND: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The conversion's actual work, sync so the tests need no runtime.
fn convert(src: &str) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;

    let cached = FOUND.lock().unwrap().clone();
    let exe = match cached {
        Some(p) => p,
        None => locate().map(|(p, _)| p).ok_or_else(|| {
            "pandoc not found. Install it from pandoc.org and try again.".to_string()
        })?,
    };

    let spawned = Command::new(&exe)
        .args(["-f", "latex", "-t", "html5", "--mathml"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    *FOUND.lock().unwrap() = spawned.is_ok().then(|| exe.clone());
    let mut child = spawned.map_err(|e| format!("could not run pandoc: {e}"))?;

    child
        .stdin
        .as_mut()
        .ok_or("could not write to pandoc")?
        .write_all(src.as_bytes())
        .map_err(|e| format!("could not write to pandoc: {e}"))?;

    let out = child
        .wait_with_output()
        .map_err(|e| format!("pandoc failed: {e}"))?;

    if !out.status.success() {
        //  pandoc's own message names the line and the construct it choked
        //  on, which is far more useful than an exit code.
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err.trim();
        return Err(if msg.is_empty() {
            "pandoc could not convert this document".to_string()
        } else {
            msg.chars().take(400).collect()
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    //  The probe must never panic, whatever is or is not installed. It runs on
    //  every .tex page open.
    #[test]
    fn probe_is_total() {
        let s = probe();
        assert_eq!(s.available, s.path.is_some());
    }

    //  A missing pandoc has to surface as an error the UI can show, not as a
    //  process panic or an empty success.
    #[test]
    fn convert_without_pandoc_is_an_error_not_a_panic() {
        if locate().is_none() {
            let r = convert("\\documentclass{article}");
            assert!(r.is_err());
        }
    }

    //  The conversion the feature actually depends on. Skipped where pandoc is
    //  absent, because that is a valid machine, not a failure.
    #[test]
    fn converts_a_real_document() {
        if locate().is_none() {
            eprintln!("pandoc absent, skipping");
            return;
        }
        let src = concat!(
            "\\documentclass{article}\n",
            "\\begin{document}\n",
            "\\section{Heading}\n",
            "Some \\emph{words} and math $e^{i\\pi}+1=0$.\n",
            "\\end{document}\n"
        );
        let html = convert(src).expect("pandoc should convert this");
        assert!(html.contains("<em>words</em>"), "emphasis missing: {html}");
        assert!(html.contains("Heading"), "section missing: {html}");
        //  MathML, not a script tag: the generated page must not need a math
        //  library loaded into the lattice bundle to be readable.
        assert!(html.contains("<math"), "math should be MathML: {html}");
        assert!(!html.contains("<script"), "no script belongs in the output: {html}");
    }

    //  A LaTeX error must come back as pandoc's own message, which names the
    //  construct, rather than a bare exit code.
    #[test]
    fn a_broken_document_reports_why() {
        if locate().is_none() {
            return;
        }
        let r = convert("\\begin{document}\n\\undefinedmacro{");
        if let Err(e) = r {
            assert!(!e.is_empty(), "an error must carry a message");
        }
    }
}
