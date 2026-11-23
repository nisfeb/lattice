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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
    tauri::async_runtime::spawn_blocking(move || convert(&src))
        .await
        .map_err(|e| format!("pandoc task failed: {e}"))?
}

/// The pandoc the last conversion ran. The live preview converts on every
/// debounced keystroke, and without this each conversion first proved pandoc
/// ran with a `--version` spawn of its own.
///
/// ponytail: cleared when starting it fails, so an uninstalled or moved pandoc
/// costs that one conversion an error and the next one looks again.
static FOUND: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Cap concurrent conversions. convert_tex is granted to the ship page and the
/// live preview fires one per keystroke, so a burst of input must not spawn an
/// unbounded number of pandoc processes. The slot is released on drop, so every
/// return path (success, error, timeout) frees it.
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
struct ConvertSlot;
impl ConvertSlot {
    fn acquire() -> Result<Self, String> {
        const MAX: usize = 4;
        if IN_FLIGHT.fetch_add(1, Ordering::SeqCst) >= MAX {
            IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
            return Err("too many conversions in progress; try again".to_string());
        }
        Ok(ConvertSlot)
    }
}
impl Drop for ConvertSlot {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Output caps so a LaTeX macro expansion cannot OOM the desktop process.
const MAX_OUT: u64 = 16 << 20;
const MAX_ERR: u64 = 64 << 10;

/// Drive a spawned child with bounded stdout/stderr reader threads started
/// BEFORE writing stdin on its own thread, so inputs larger than the OS pipe
/// buffer (64 KiB) cannot deadlock and unbounded output cannot OOM.
fn run_child(
    mut child: std::process::Child,
    input: Vec<u8>,
    timeout: Duration,
    max_out: u64,
    max_err: u64,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>, std::io::Result<()>), String> {
    use std::io::{Read, Write};

    let cout = child.stdout.take().ok_or("could not read from pandoc")?;
    let cerr = child.stderr.take().ok_or("could not read from pandoc")?;
    let mut stdin = child.stdin.take().ok_or("could not write to pandoc")?;

    let out_h = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = cout.take(max_out.saturating_add(1)).read_to_end(&mut v);
        v
    });
    let err_h = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = cerr.take(max_err).read_to_end(&mut v);
        v
    });
    let in_h = std::thread::spawn(move || {
        let res = stdin.write_all(&input);
        drop(stdin);
        res
    });

    // bound the conversion: a hostile ship page can feed input that never
    // terminates, so kill pandoc past a deadline rather than park a worker and
    // a process forever.
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait().map_err(|e| format!("pandoc failed: {e}"))? {
            Some(s) => break s,
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = in_h.join();
                    let _ = out_h.join();
                    let _ = err_h.join();
                    return Err("pandoc timed out after 10s".to_string());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    };
    let write_res = in_h.join().unwrap_or(Ok(()));
    let stdout = out_h.join().unwrap_or_default();
    let stderr = err_h.join().unwrap_or_default();
    Ok((status, stdout, stderr, write_res))
}

/// The conversion's actual work, sync so the tests need no runtime.
fn convert(src: &str) -> Result<String, String> {
    use std::process::Stdio;

    // cap concurrent conversions before doing any work; freed on return
    let _slot = ConvertSlot::acquire()?;

    let cached = FOUND.lock().unwrap().clone();
    let exe = match cached {
        Some(p) => p,
        None => locate().map(|(p, _)| p).ok_or_else(|| {
            "pandoc not found. Install it from pandoc.org and try again.".to_string()
        })?,
    };

    // --sandbox: the tex comes from the ship, so a key or an edit-granted
    // peer may have written it. Without the flag, \input and
    // \lstinputlisting read any file this user can read into the page
    // (security audit run-1). pandoc older than 2.15 refuses the flag, and
    // failing then is right: never convert unsandboxed.
    let spawned = Command::new(&exe)
        .args(["-f", "latex", "-t", "html5", "--mathml", "--sandbox"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    *FOUND.lock().unwrap() = spawned.is_ok().then(|| exe.clone());
    let child = spawned.map_err(|e| format!("could not run pandoc: {e}"))?;

    let (status, stdout, stderr, write_res) = run_child(
        child,
        src.as_bytes().to_vec(),
        Duration::from_secs(10),
        MAX_OUT,
        MAX_ERR,
    )?;

    if !status.success() {
        //  pandoc's own message names the line and the construct it choked
        //  on, which is far more useful than an exit code.
        let err = String::from_utf8_lossy(&stderr);
        let msg = err.trim();
        if msg.contains("--sandbox") {
            return Err("pandoc 2.15 or later is needed to convert safely".to_string());
        }
        return Err(if msg.is_empty() {
            "pandoc could not convert this document".to_string()
        } else {
            msg.chars().take(400).collect()
        });
    }
    if let Err(e) = write_res {
        return Err(format!("could not write to pandoc: {e}"));
    }
    if stdout.len() as u64 > MAX_OUT {
        return Err("pandoc output exceeded size limit".to_string());
    }
    Ok(String::from_utf8_lossy(&stdout).to_string())
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

    //  The tex is written on the ship, possibly by an agent key or an
    //  edit-granted peer, so it must not be able to read this machine's files
    //  into the page. Without --sandbox, \input and \lstinputlisting did.
    #[test]
    fn tex_cannot_read_host_files() {
        if locate().is_none() {
            eprintln!("pandoc absent, skipping");
            return;
        }
        let marker = format!("hostsecret{}x", std::process::id());
        let p = std::env::temp_dir().join(format!("lattice-pandoc-{}.txt", std::process::id()));
        std::fs::write(&p, &marker).unwrap();
        let path = p.to_string_lossy();
        for src in [
            format!("\\documentclass{{article}}\\begin{{document}}\\input{{{path}}}\\end{{document}}"),
            format!("\\documentclass{{article}}\\usepackage{{listings}}\\begin{{document}}\\lstinputlisting{{{path}}}\\end{{document}}"),
        ] {
            if let Ok(html) = convert(&src) {
                assert!(!html.contains(&marker), "pandoc read a host file into the page: {html}");
            }
        }
        std::fs::remove_file(&p).ok();
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

    #[test]
    fn large_pipe_io_does_not_deadlock_and_output_is_bounded() {
        use std::process::Stdio;
        // 256 KiB exceeds the 64 KiB Linux pipe buffer: writing stdin synchronously
        // before spawning stdout readers would deadlock `cat`.
        let payload = vec![b'a'; 256 * 1024];
        let child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn cat");
        let (status, stdout, _stderr, write_res) =
            run_child(child, payload.clone(), Duration::from_secs(5), 512 * 1024, 1024)
                .expect("large pipe IO must complete without deadlock");
        assert!(status.success());
        assert!(write_res.is_ok());
        assert_eq!(stdout.len(), payload.len());

        // When output exceeds max_out, run_child caps it at max_out + 1 bytes.
        let child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn cat");
        let (_status, capped, _stderr, _write_res) =
            run_child(child, vec![b'b'; 8192], Duration::from_secs(5), 1024, 1024)
                .expect("bounded read finishes");
        assert_eq!(capped.len(), 1025, "stdout must be capped at max_out + 1");
    }
}
