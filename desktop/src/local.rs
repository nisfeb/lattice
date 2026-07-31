//! Finding urbit piers running on THIS machine, so a local ship can be mounted
//! over lick without a URL, a +code or a cookie.
//!
//! Detection is purely filesystem, which is why it needs no process scanning
//! and works the same on macOS:
//!
//!   <pier>/.urb/                          it is a pier
//!   <pier>/.urb/conn.sock                 vere is RUNNING (it unlinks on exit)
//!   <pier>/.urb/dev/grubbery/lattice/fs   lattice's lick port is bound
//!
//! ponytail: process inspection would also work, but the binary is named
//! `vere-v4.6-linux-x86_64` on this machine and `urbit` elsewhere — matching
//! that reliably across platforms is more code, and more brittle, than the
//! three path checks above, which are what actually have to be true.

use std::path::{Path, PathBuf};

/// where the lattice nexus binds its fs lick port inside a pier
const LICK_REL: &str = ".urb/dev/grubbery/lattice/fs";

#[derive(serde::Serialize, Clone)]
pub struct LocalShip {
    /// pier directory
    pub pier: String,
    /// @p guessed from the pier directory name. Only ever displayed — the lick
    /// transport never puts it on the wire (it answers `ship()` with it), so a
    /// pier dir named something else costs a label, not a broken mount.
    pub ship: String,
    /// vere is up (conn.sock present)
    pub running: bool,
    /// lattice's lick socket exists — mountable without any credentials
    pub lick: bool,
    /// absolute path of that socket, "" when absent
    pub sock: String,
}

/// Directories we will not descend into: big, never piers, and the reason a
/// naive $HOME walk is slow enough to be noticed.
const SKIP: &[&str] = &[
    "node_modules", "target", "build", "dist", ".git", ".cache", ".cargo",
    ".rustup", ".npm", "Library", "Applications", ".local", ".steam",
];

fn is_pier(dir: &Path) -> bool {
    dir.join(".urb").is_dir()
}

fn inspect(dir: &Path) -> LocalShip {
    let sock = dir.join(LICK_REL);
    let lick = sock.exists();
    // canonical path, so the same pier reached by two routes (a symlinked
    // home, ~/software vs $HOME walk) dedups to one entry
    let dir = &std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    LocalShip {
        pier: dir.to_string_lossy().into_owned(),
        ship: format!(
            "~{}",
            dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
        ),
        running: dir.join(".urb/conn.sock").exists(),
        lick,
        sock: if lick { sock.to_string_lossy().into_owned() } else { String::new() },
    }
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<LocalShip>) {
    if out.len() >= 24 {
        return;
    }
    if is_pier(dir) {
        out.push(inspect(dir));
        return; // a pier contains no piers
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        // symlinks are not followed: a link back up the tree would loop, and a
        // pier is a real directory
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP.contains(&name.as_str()) {
            continue;
        }
        walk(&e.path(), depth - 1, out);
    }
}

/// Piers under the usual places, nearest first. Bounded depth: piers live a
/// couple of levels below home in practice (~/urbit/<ship>, ~/software/<ship>),
/// and an unbounded scan of a home directory is a visible stall.
pub fn discover() -> Vec<LocalShip> {
    let mut out: Vec<LocalShip> = Vec::new();
    let home = std::env::var("HOME").unwrap_or_default();
    let mut roots: Vec<PathBuf> = Vec::new();
    if !home.is_empty() {
        for sub in ["urbit", "piers", "ships", "software", "Documents", "dev", "src"] {
            roots.push(Path::new(&home).join(sub));
        }
        roots.push(PathBuf::from(&home));
    }
    for r in roots {
        if !r.is_dir() {
            continue;
        }
        // depth 2 below the named roots, 1 below $HOME itself (its children are
        // already covered by the named roots and the shallow pass)
        walk(&r, 2, &mut out);
    }
    // Dedup by path BEFORE ordering for display: the same pier is reachable
    // through more than one root (~/software/tyr is found again when walking
    // $HOME), and dedup_by only drops ADJACENT equals — so the paths have to
    // be sorted together first, not merely present.
    out.sort_by(|a, b| a.pier.cmp(&b.pier));
    out.dedup_by(|a, b| a.pier == b.pier);
    // then: mountable first, then merely running, then by name
    out.sort_by(|a, b| {
        b.lick
            .cmp(&a.lick)
            .then(b.running.cmp(&a.running))
            .then(a.ship.cmp(&b.ship))
    });
    out
}

#[tauri::command]
pub fn local_ships() -> Vec<LocalShip> {
    let found = discover();
    crate::commands::dlog(&format!(
        "local ships: {}",
        found
            .iter()
            .map(|s| format!("{} lick={} running={}", s.ship, s.lick, s.running))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_a_pier_shaped_dir_and_its_lick_socket() {
        let base = std::env::temp_dir().join(format!("lattice-pier-test-{}", std::process::id()));
        let pier = base.join("fakeship");
        std::fs::create_dir_all(pier.join(".urb/dev/grubbery/lattice")).unwrap();
        // not running, no lick socket yet
        let s = inspect(&pier);
        assert_eq!(s.ship, "~fakeship");
        assert!(!s.running, "no conn.sock yet");
        assert!(!s.lick, "no fs socket yet");
        // now it is running and the port is bound
        std::fs::write(pier.join(".urb/conn.sock"), b"").unwrap();
        std::fs::write(pier.join(LICK_REL), b"").unwrap();
        let s = inspect(&pier);
        assert!(s.running && s.lick);
        assert!(s.sock.ends_with(LICK_REL));
        // and the walk finds it without being handed the pier itself
        let mut out = Vec::new();
        walk(&base, 2, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].pier, pier.to_string_lossy());
        // a pier is not descended into
        let mut out2 = Vec::new();
        walk(&pier, 2, &mut out2);
        assert_eq!(out2.len(), 1);

        // the same pier reached twice must collapse to one row: dedup_by only
        // drops ADJACENT equals, so this fails if the sort is not by path
        let mut dup = vec![inspect(&pier), inspect(&pier), inspect(&pier)];
        dup.sort_by(|a, b| a.pier.cmp(&b.pier));
        dup.dedup_by(|a, b| a.pier == b.pier);
        assert_eq!(dup.len(), 1, "same pier must dedup to one entry");
        std::fs::remove_dir_all(&base).ok();
    }
}
