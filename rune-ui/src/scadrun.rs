//! An OpenSCAD part made by the openscad on this machine, as LaTeX is
//! read by its pandoc. The web client runs OpenSCAD as wasm under its
//! script engine. There is none here, so the program itself is run:
//! the page and what it includes are written to a folder of their own,
//! openscad writes the part beside them, and the folder is removed.
//!
//! The STL reader and the console's rules are ports of the web client's
//! `ui-src/scad/stl.js` and of `showLog` in `ui-src/scad/view.js`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long a render may run, as on the web.
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// Past this many triangles a part is not drawn, as on the web.
pub const MAX_TRIS: usize = 1_000_000;
/// Maximum size in bytes of an exported STL or 3MF file read back from OpenSCAD.
const MAX_OUT: u64 = 64 << 20;

/// An openscad that runs: the one `LATTICE_OPENSCAD` names, then on the path, then where installs put it.
pub fn locate() -> Option<PathBuf> {
    let named = std::env::var_os("LATTICE_OPENSCAD").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let fixed: &[&str] = if cfg!(target_os = "macos") { &["/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD", "/opt/homebrew/bin/openscad", "/usr/local/bin/openscad"] } else { &["/usr/local/bin/openscad", "/usr/bin/openscad", "/snap/bin/openscad", "/var/lib/flatpak/exports/bin/org.openscad.OpenSCAD"] };
    named
        .into_iter()
        .chain(std::iter::once(PathBuf::from("openscad")))
        .chain(fixed.iter().map(PathBuf::from))
        .chain(home.iter().flat_map(|h| [h.join(".local/bin/openscad"), h.join("bin/openscad")]))
        .find(|p| Command::new(p).arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success()))
}

/// What a run of openscad gave: what it said, the file it wrote when it wrote one, and how long it took.
pub struct Ran {
    pub log: Vec<String>,
    pub data: Option<Vec<u8>>,
    pub ms: u128,
    pub timed_out: bool,
    pub ok: bool,
}

/// A folder of this run's own, removed when the run is over.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Runs openscad over a page and its includes. `files` are named as
/// `scad::collect` names them, from `/w/`, and `main` is the page's own.
/// `defs` are `name=value` for `-D`, and `ext` is `stl` or `3mf`.
pub fn run(exe: &Path, files: &[(String, String)], main: &str, defs: &[String], ext: &str, timeout: Duration) -> Ran {
    let t0 = Instant::now();
    let fail = |why: String| Ran { log: vec![format!("ERROR: {why}")], data: None, ms: t0.elapsed().as_millis(), timed_out: false, ok: false };
    let dir = match crate::api::make_temp_dir("lattice-scad") {
        Ok(d) => Scratch(d),
        Err(e) => return fail(format!("could not make a temporary folder: {e}")),
    };
    for (name, text) in files {
        // a name is one this code made, from /w/ down: anything else is not written
        let rel = name.trim_start_matches('/');
        if !name.starts_with(crate::scad::ROOT) || rel.split('/').any(|p| p == ".." || p.is_empty()) {
            continue;
        }
        let at = dir.0.join(rel);
        if let Err(e) = at.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&at, text)) {
            return fail(format!("could not write the part's files: {e}"));
        }
    }
    let out = dir.0.join(format!("out.{ext}"));
    let mut cmd = Command::new(exe);
    cmd.arg(dir.0.join(main.trim_start_matches('/'))).arg("-o").arg(&out).args(["--export-format", if ext == "stl" { "binstl" } else { ext }]);
    for d in defs {
        cmd.args(["-D", d]);
    }
    let mut child = match cmd.current_dir(&dir.0).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("could not run openscad: {e}")),
    };
    // each pipe on a thread of its own, so a full one cannot stop the other. What is said is kept to a megabyte
    let pipe = |mut r: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = r.by_ref().take(1 << 20).read_to_end(&mut v);
            let _ = std::io::copy(&mut r, &mut std::io::sink());
            v
        })
    };
    let (so, se) = (child.stdout.take().map(|p| pipe(Box::new(p))), child.stderr.take().map(|p| pipe(Box::new(p))));
    let until = t0 + timeout;
    let (mut timed_out, mut ok) = (false, false);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                ok = status.success();
                break;
            }
            Ok(None) if Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(_) => break,
        }
    }
    let said: Vec<u8> = [so, se].into_iter().flatten().flat_map(|t| t.join().unwrap_or_default()).collect();
    // the folder is this run's own: a line that names a file reads from /w/, as on the web
    let here = dir.0.to_string_lossy().into_owned();
    let mut log: Vec<String> = String::from_utf8_lossy(&said).lines().map(|l| l.replace(&here, "")).collect();
    if timed_out {
        log.push(format!("stopped after {} s", timeout.as_secs()));
    }
    let data = if ok && !timed_out {
        match std::fs::metadata(&out) {
            Ok(m) if m.len() > MAX_OUT => {
                log.push(format!("ERROR: the part file is over {} MB and was not read", MAX_OUT >> 20));
                ok = false;
                None
            }
            Ok(_) => std::fs::read(&out).ok(),
            Err(_) => None,
        }
    } else {
        None
    };
    Ran { log, data, ms: t0.elapsed().as_millis(), timed_out, ok }
}

/// A part as triangles: nine numbers a triangle, and the box it fills.
#[derive(Clone, Debug, PartialEq)]
pub struct Mesh {
    pub tris: usize,
    pub pos: Vec<f32>,
    pub min: [f32; 3],
    pub max: [f32; 3],
}

/// A number with its thousands apart, as the web client writes a count.
pub fn grouped(n: usize) -> String {
    let s = n.to_string();
    s.as_bytes().rchunks(3).rev().map(|c| std::str::from_utf8(c).unwrap_or("")).collect::<Vec<_>>().join(",")
}

/// OpenSCAD's binary STL: an 80 byte header, a count, then 50 bytes a
/// triangle. The normal in the file is not read: a zero one is legal.
pub fn parse_stl(b: &[u8]) -> Result<Mesh, String> {
    if b.len() < 84 {
        return Err("the STL is too short".into());
    }
    let n = u32::from_le_bytes([b[80], b[81], b[82], b[83]]) as usize;
    if n > MAX_TRIS {
        return Err(format!("the part has {} triangles, more than the viewer draws ({})", grouped(n), grouped(MAX_TRIS)));
    }
    if 84 + n * 50 > b.len() {
        return Err("the STL is cut short".into());
    }
    let mut pos = Vec::with_capacity(n * 9);
    let (mut min, mut max, mut wild) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3], false);
    for t in 0..n {
        let o = 84 + t * 50 + 12;
        for k in 0..9 {
            let v = f32::from_le_bytes([b[o + k * 4], b[o + k * 4 + 1], b[o + k * 4 + 2], b[o + k * 4 + 3]]);
            // a corner past any size a part is made at is as wild as one that is no number: its span would overflow
            wild |= !v.is_finite() || v.abs() > 1e12;
            min[k % 3] = min[k % 3].min(v);
            max[k % 3] = max[k % 3].max(v);
            pos.push(v);
        }
    }
    // cube(1e39) is past what these numbers hold: a part with no bounds is not drawn
    if wild {
        return Err("the part has no size the viewer can draw: a corner is not a finite number".into());
    }
    if n == 0 {
        return Ok(Mesh { tris: 0, pos, min: [0.0; 3], max: [0.0; 3] });
    }
    Ok(Mesh { tris: n, pos, min, max })
}

/// A length in millimetres as the web client writes it: one decimal from a hundred up, two below, with no trailing zeros.
pub fn mm(v: f32) -> String {
    let s = if v.abs() >= 100.0 { format!("{v:.1}") } else { format!("{v:.2}") };
    s.trim_end_matches('0').trim_end_matches('.').to_owned()
}

/// How big a part is and how many triangles it has, as the web client says it.
pub fn dims(m: &Mesh) -> String {
    if m.tris == 0 {
        return "empty".into();
    }
    format!("{} \u{d7} {} \u{d7} {} mm \u{b7} {} triangles", mm(m.max[0] - m.min[0]), mm(m.max[1] - m.min[1]), mm(m.max[2] - m.min[2]), grouped(m.tris))
}

/// How a line of the console reads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Level {
    Plain,
    Warning,
    Error,
}

/// The console's lines: the resolver's notes as warnings, then what
/// openscad said, each marked an error or a warning by how it starts.
/// The second answer is the console's heading, with its count.
pub fn console(log: &[String], notes: &[String]) -> (Vec<(Level, String)>, String) {
    let lines: Vec<(Level, String)> = notes
        .iter()
        .map(|n| format!("WARNING: {n}"))
        .chain(log.iter().cloned())
        .filter(|s| !s.starts_with("Could not initialize localization"))
        .map(|s| (if s.starts_with("ERROR") { Level::Error } else if s.starts_with("WARNING") { Level::Warning } else { Level::Plain }, s))
        .collect();
    let count = |l: Level| lines.iter().filter(|(x, _)| *x == l).count();
    let (errs, warns) = (count(Level::Error), count(Level::Warning));
    let head = match (errs, warns) {
        (0, 0) => "Console".to_owned(),
        (0, w) => format!("Console ({w} warning{})", if w > 1 { "s" } else { "" }),
        (e, _) => format!("Console ({e} error{})", if e > 1 { "s" } else { "" }),
    };
    (lines, head)
}

/// Extracts a 1-based line number in `main_file` from an OpenSCAD console line
/// (mirroring `ui-src/scad/view.js::showLog`). Returns `None` when the message
/// names a different included file or holds no line number.
pub fn console_line(line: &str, main_file: &str) -> Option<usize> {
    let parse_num = |s: &str| -> Option<usize> {
        let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        let rest = &s[digits.len()..];
        if !rest.is_empty() && rest.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            return None;
        }
        digits.parse::<usize>().ok().filter(|&n| n >= 1)
    };
    if let Some(pos) = line.find("in file ") {
        let after = &line[pos + "in file ".len()..];
        let (file_raw, rest) = after.split_once(", line ")?;
        let file = file_raw.trim().trim_matches('"');
        let main_rel = main_file.strip_prefix(crate::scad::ROOT).unwrap_or(main_file.trim_start_matches('/'));
        let file_rel = file.strip_prefix(crate::scad::ROOT).unwrap_or(file.trim_start_matches('/'));
        let matches_main = file == main_file
            || file_rel == main_rel
            || main_file.rsplit('/').next().is_some_and(|base| !base.is_empty() && file == base);
        return matches_main.then(|| parse_num(rest)).flatten();
    }
    let mut rest = line;
    while let Some(pos) = rest.find("line ") {
        let ok_before = pos == 0 || rest[..pos].chars().next_back().is_some_and(|c| !c.is_ascii_alphanumeric() && c != '_');
        let after = &rest[pos + "line ".len()..];
        if ok_before {
            if let Some(n) = parse_num(after) {
                return Some(n);
            }
        }
        rest = after;
    }
    None
}

/// A page drawn: what the status line says and whether that is bad
/// news, the console, and the part when there is one, with its STL.
pub struct Drawn {
    pub status: String,
    pub bad: bool,
    pub lines: Vec<(Level, String)>,
    pub head: String,
    pub mesh: Option<Mesh>,
    pub stl: Option<Vec<u8>>,
}

/// Draws a page: its includes gathered, openscad run, the STL read. `read` answers an included page's text.
pub fn draw(name: &str, text: &str, read: impl FnMut(&str) -> Option<String>) -> Drawn {
    let none = |status: String, bad: bool, lines, head| Drawn { status, bad, lines, head, mesh: None, stl: None };
    let Some(exe) = locate() else {
        return none("Drawing a part needs OpenSCAD, which is not installed on this machine. It is at openscad.org".into(), false, Vec::new(), "Console".into());
    };
    let (main, files, notes) = crate::scad::collect(name, text, read);
    let ran = run(&exe, &files, &main, &[], "stl", TIMEOUT);
    let (lines, head) = console(&ran.log, &notes);
    let errs = lines.iter().any(|(l, _)| *l == Level::Error);
    if ran.timed_out {
        return none(format!("stopped: the render ran past {} s", TIMEOUT.as_secs()), true, lines, head);
    }
    let Some(data) = ran.data.filter(|_| ran.ok) else {
        return none(if errs { "OpenSCAD reported an error, see the console".into() } else { "no part: the model made nothing to draw".into() }, true, lines, head);
    };
    match parse_stl(&data) {
        Err(why) => none(why, true, lines, head),
        Ok(mesh) => Drawn { status: format!("rendered in {:.1} s \u{b7} {}", ran.ms as f64 / 1000.0, dims(&mesh)), bad: false, lines, head, mesh: Some(mesh), stl: Some(data) },
    }
}

/// A page's part as a file of another kind, `3mf` or `stl`, made by openscad. An error says why there is none.
pub fn export(name: &str, text: &str, read: impl FnMut(&str) -> Option<String>, ext: &str) -> Result<Vec<u8>, String> {
    let exe = locate().ok_or("making this file needs OpenSCAD, which is not installed on this machine. It is at openscad.org")?;
    let (main, files, notes) = crate::scad::collect(name, text, read);
    let ran = run(&exe, &files, &main, &[], ext, TIMEOUT);
    let (lines, _) = console(&ran.log, &notes);
    let why = lines.iter().find(|(l, _)| *l == Level::Error).map_or(String::new(), |(_, s)| format!(": {s}"));
    ran.data.filter(|d| ran.ok && !d.is_empty()).ok_or_else(|| format!("could not make the {}{why}", ext.to_uppercase()))
}

/// A picture as a PNG file's bytes, from straight RGBA.
pub fn png(w: u32, h: u32, px: &[u8]) -> Option<Vec<u8>> {
    rune::DragImage::rgba(w, h, px).map(|d| d.png_data().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_part_is_exported_as_3mf_when_openscad_is_here() {
        if locate().is_none() {
            assert!(export("a", "cube(1);", |_| None, "3mf").unwrap_err().contains("openscad.org"));
            return;
        }
        // a 3MF is a zip, which starts PK, and holds the model
        let file = export("a", "cube([3, 4, 5]);", |_| None, "3mf").unwrap();
        assert_eq!(&file[..2], b"PK");
        assert!(file.len() > 200);
        let why = export("b", "cube(;", |_| None, "3mf").unwrap_err();
        assert!(why.starts_with("could not make the 3MF: ERROR"), "{why}");
        // a picture is a PNG of its own size
        let shot = png(2, 1, &[255, 0, 0, 255, 0, 0, 0, 0]).unwrap();
        assert_eq!(&shot[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!((&shot[16..20], &shot[20..24]), (&2u32.to_be_bytes()[..], &1u32.to_be_bytes()[..]));
        assert!(png(2, 2, &[0; 3]).is_none());
    }

    /// A binary STL of `n` triangles from corner numbers.
    fn stl(tris: &[[f32; 9]]) -> Vec<u8> {
        let mut b = vec![0u8; 80];
        b.extend((tris.len() as u32).to_le_bytes());
        for t in tris {
            b.extend([0u8; 12]);
            b.extend(t.iter().flat_map(|v| v.to_le_bytes()));
            b.extend([0u8; 2]);
        }
        b
    }

    #[test]
    fn an_stl_is_read_with_its_bounds_and_bad_ones_say_why() {
        let m = parse_stl(&stl(&[[0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 250.5, 0.0], [0.0, 0.0, -1.25, 1.0, 1.0, 1.0, 2.0, 2.0, 2.0]])).unwrap();
        assert_eq!((m.tris, m.pos.len(), m.min, m.max), (2, 18, [0.0, 0.0, -1.25], [10.0, 250.5, 2.0]));
        assert_eq!(dims(&m), "10 \u{d7} 250.5 \u{d7} 3.25 mm \u{b7} 2 triangles");
        assert_eq!(dims(&parse_stl(&stl(&[])).unwrap()), "empty");
        assert_eq!(parse_stl(&[0; 20]).unwrap_err(), "the STL is too short");
        let mut cut = stl(&[[0.0; 9]]);
        cut.truncate(100);
        assert_eq!(parse_stl(&cut).unwrap_err(), "the STL is cut short");
        let mut many = vec![0u8; 84];
        many[80..84].copy_from_slice(&2_000_000u32.to_le_bytes());
        assert_eq!(parse_stl(&many).unwrap_err(), "the part has 2,000,000 triangles, more than the viewer draws (1,000,000)");
        assert_eq!(parse_stl(&stl(&[[f32::INFINITY, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]])).unwrap_err(), "the part has no size the viewer can draw: a corner is not a finite number");
        assert_eq!((grouped(0), grouped(999), grouped(1000), grouped(1_234_567)), ("0".into(), "999".into(), "1,000".into(), "1,234,567".into()));
        assert_eq!((mm(100.0), mm(99.999), mm(0.5), mm(123.45)), ("100".into(), "100".into(), "0.5".into(), "123.4".into()));
    }

    #[test]
    fn the_console_marks_errors_and_warnings_and_counts_them() {
        let log: Vec<String> = ["Could not initialize localization (application path is '/').", "ECHO: 3", "WARNING: Ignoring unknown variable 'q'", "ERROR: Parser error: syntax error in file a.scad, line 2"].map(String::from).into();
        let (lines, head) = console(&log, &["line 1 of a: /etc/passwd: only lattice pages can be included, by a relative path".into()]);
        assert_eq!(lines.iter().map(|(l, _)| *l).collect::<Vec<_>>(), [Level::Warning, Level::Plain, Level::Warning, Level::Error]);
        assert_eq!(head, "Console (1 error)");
        assert_eq!(console(&log[..3], &[]).1, "Console (1 warning)");
        assert_eq!(console(&log[..3], &["x".into()]).1, "Console (2 warnings)");
        assert_eq!(console(&log[..2], &[]).1, "Console");
    }

    /// With an openscad on this machine, or one named by `LATTICE_OPENSCAD`: a part is made, an
    /// include is read from its page, a file outside lattice is not, and a broken source says so.
    #[test]
    fn a_page_is_drawn_when_openscad_is_here() {
        if locate().is_none() {
            assert!(draw("a", "cube(1);", |_| None).status.contains("openscad.org"));
            return;
        }
        let mut asked = Vec::new();
        let d = draw("parts/a", "include <lib.scad>\ninclude </etc/hostname>\ncube([10, 20, w]);\necho(\"w is\", w);\n", |p| {
            asked.push(p.to_owned());
            (p == "parts/lib").then(|| "w = 5;".to_owned())
        });
        assert_eq!(asked, ["parts/lib"]);
        assert!(!d.bad, "{} {:?}", d.status, d.lines);
        let m = d.mesh.unwrap();
        assert_eq!((m.tris, m.min, m.max), (12, [0.0, 0.0, 0.0], [10.0, 20.0, 5.0]));
        assert!(d.status.ends_with("10 \u{d7} 20 \u{d7} 5 mm \u{b7} 12 triangles"), "{}", d.status);
        assert!(d.lines.iter().any(|(l, s)| *l == Level::Plain && s == "ECHO: \"w is\", 5"), "{:?}", d.lines);
        assert!(d.lines.iter().any(|(l, s)| *l == Level::Warning && s.contains("only lattice pages can be included")));
        assert!(d.lines.iter().all(|(_, s)| !s.contains("lattice-scad-")), "the run's own folder is not named: {:?}", d.lines);
        assert_eq!(d.stl.map(|b| b.len()), Some(84 + 12 * 50));
        let broken = draw("b", "cube(;\n", |_| None);
        assert!(broken.bad && broken.mesh.is_none());
        assert_eq!(broken.status, "OpenSCAD reported an error, see the console");
        assert!(broken.head.starts_with("Console (") && broken.lines.iter().any(|(l, _)| *l == Level::Error), "{:?}", broken.lines);
        let nothing = draw("c", "x = 1;\n", |_| None);
        assert!(nothing.bad && nothing.mesh.is_none(), "{}", nothing.status);
        // nothing is left behind
        let left = std::fs::read_dir(std::env::temp_dir()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(&format!("lattice-scad-{}-", std::process::id()))).count();
        assert_eq!(left, 0);
    }

    #[cfg(unix)]
    #[test]
    fn run_uses_private_temp_dir_and_caps_output_size() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = crate::api::make_temp_dir("lattice-scad-test").unwrap();
        assert_eq!(std::fs::metadata(&tmp).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(&tmp);
        // Put the fake executable beside the test binary so it runs even if TMPDIR is noexec.
        let dir = std::env::current_exe().unwrap().parent().unwrap().join(format!("lattice-scad-exe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("fake-openscad");
        std::fs::write(
            &exe,
            "#!/bin/sh\nperm=$(stat -c '%a' . 2>/dev/null || stat -f '%Lp' .)\n[ \"$perm\" = \"700\" ] || { echo \"ERROR: bad perm $perm\"; exit 1; }\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = \"-o\" ]; then out=\"$2\"; shift 2; else shift; fi\ndone\ndd if=/dev/zero of=\"$out\" bs=1 count=1 seek=68000000 2>/dev/null\n",
        )
        .unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let ran = run(&exe, &[("/w/a.scad".into(), "cube(1);".into())], "/w/a.scad", &[], "stl", Duration::from_secs(10));
        assert!(!ran.ok && ran.data.is_none(), "output over 64 MiB must be refused: {:?}", ran.log);
        assert!(ran.log.iter().any(|l| l.contains("over 64 MB")), "{:?}", ran.log);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn console_line_parses_main_file_and_ignores_other_files() {
        let main = "/w/parts/box.scad";
        assert_eq!(console_line("ERROR: Parser error: syntax error in file /w/parts/box.scad, line 12", main), Some(12));
        assert_eq!(console_line("WARNING: Ignoring unknown variable 'x' in file \"parts/box.scad\", line 4", main), Some(4));
        assert_eq!(console_line("ERROR: syntax error in file box.scad, line 9", main), Some(9));
        // An error inside an included file must not jump to a line in the main file.
        assert_eq!(console_line("ERROR: syntax error in file /w/parts/lib.scad, line 3", main), None);
        // Standalone line reference with no file clause still parses.
        assert_eq!(console_line("ERROR: Parser error in line 7: unexpected token", main), Some(7));
        assert_eq!(console_line("ECHO: \"online 3 items\"", main), None);
        assert_eq!(console_line("WARNING: something on line 0", main), None);
    }
}
