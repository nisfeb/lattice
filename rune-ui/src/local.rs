//! Finding urbit piers on this machine (`desktop/src/local.rs`), so a
//! ship that runs here can be reached over lick, with no address and no
//! access code. It is all the filesystem:
//!
//!   <pier>/.urb/                          it is a pier
//!   <pier>/.urb/conn.sock                 its ship is running (it is unlinked on exit)
//!   <pier>/.urb/dev/grubbery/lattice/fs   lattice's lick port is bound
//!
//! Nothing in a pier is opened or read: a directory or a socket being
//! there is all that is asked.

use std::path::{Path, PathBuf};

/// Where lattice binds its lick port inside a pier.
const LICK_REL: &str = ".urb/dev/grubbery/lattice/fs";

/// A pier found here.
#[derive(Clone, Debug, PartialEq)]
pub struct LocalShip {
    pub pier: String,
    /// The ship's name as its pier's directory has it. Only ever shown.
    pub ship: String,
    pub running: bool,
    /// Lattice's lick socket is there: the ship can be reached with nothing more.
    pub lick: bool,
    /// That socket's path, empty when it is not there.
    pub sock: String,
}

impl LocalShip {
    /// What is said beside the ship: where it is, and why it cannot be reached when it cannot.
    pub fn says(&self) -> String {
        if self.lick {
            self.pier.clone()
        } else if self.running {
            format!("{}: lattice not running", self.pier)
        } else {
            format!("{}: stopped", self.pier)
        }
    }
}

/// Directories never gone into: large, never piers, and what makes a walk of a home slow.
const SKIP: &[&str] = &["node_modules", "target", "build", "dist", ".git", ".cache", ".cargo", ".rustup", ".npm", "Library", "Applications", ".local", ".steam"];

fn inspect(dir: &Path) -> LocalShip {
    let sock = dir.join(LICK_REL);
    let lick = sock.exists();
    // the pier's one true path, so the same pier reached two ways is one
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let sock = dir.join(LICK_REL);
    LocalShip {
        ship: format!("~{}", dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()),
        running: dir.join(".urb/conn.sock").exists(),
        lick,
        sock: if lick { sock.to_string_lossy().into_owned() } else { String::new() },
        pier: dir.to_string_lossy().into_owned(),
    }
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<LocalShip>) {
    if out.len() >= 24 {
        return;
    }
    if dir.join(".urb").is_dir() {
        out.push(inspect(dir));
        // a pier holds no piers
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        // a link is not followed: one back up the tree would go round, and a pier is a real directory
        if !e.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP.contains(&name.as_str()) {
            continue;
        }
        walk(&e.path(), depth - 1, out);
    }
}

/// The piers under a home: two levels under the places piers are kept
/// and under the home itself. Those that can be reached come first, then
/// those running, then by name.
pub fn discover(home: &Path) -> Vec<LocalShip> {
    let mut out = Vec::new();
    let mut roots: Vec<PathBuf> = ["urbit", "piers", "ships", "software", "Documents", "dev", "src"].iter().map(|s| home.join(s)).collect();
    roots.push(home.to_path_buf());
    for r in roots.iter().filter(|r| r.is_dir()) {
        walk(r, 2, &mut out);
    }
    // the same pier is found from more than one root: by path first, so the doubles sit together
    out.sort_by(|a, b| a.pier.cmp(&b.pier));
    out.dedup_by(|a, b| a.pier == b.pier);
    out.sort_by(|a, b| b.lick.cmp(&a.lick).then(b.running.cmp(&a.running)).then(a.ship.cmp(&b.ship)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn piers_are_found_by_what_is_in_them_and_said_as_they_stand() {
        let home = std::env::temp_dir().join(format!("lr-piers-{}", std::process::id()));
        let mk = |rel: &str| std::fs::create_dir_all(home.join(rel)).unwrap();
        // one stopped, one running without lattice, one that can be reached, and one too deep to be looked for
        mk("urbit/stopped/.urb");
        mk("software/nolat/.urb");
        std::fs::write(home.join("software/nolat/.urb/conn.sock"), b"").unwrap();
        mk("software/zod/.urb/dev/grubbery/lattice");
        std::fs::write(home.join("software/zod/.urb/conn.sock"), b"").unwrap();
        std::fs::write(home.join("software/zod").join(LICK_REL), b"").unwrap();
        mk("a/b/c/deep/.urb");
        // never gone into, and not piers
        mk("node_modules/x/.urb");
        mk(".hidden/y/.urb");
        mk("software/zod/inner/.urb");
        let found = discover(&home);
        assert_eq!(found.iter().map(|s| s.ship.as_str()).collect::<Vec<_>>(), ["~zod", "~nolat", "~stopped"], "{found:?}");
        assert!(found[0].lick && found[0].running && found[0].sock.ends_with(LICK_REL));
        assert_eq!(found[0].says(), found[0].pier);
        assert!(found[1].says().ends_with("nolat: lattice not running") && found[2].says().ends_with("stopped: stopped"));
        assert!(found[1].sock.is_empty());
        // a home with nothing in it, and one that is not there
        assert!(discover(&home.join("a/b")).iter().all(|s| s.ship == "~deep"));
        assert!(discover(&home.join("nowhere")).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    /// A real pier with its ship running: `LATTICE_PIERS` names the directory it is in. The lick socket is where this looks for it.
    #[test]
    #[ignore]
    fn live_local_pier() {
        let dir = std::env::var_os("LATTICE_PIERS").expect("LATTICE_PIERS");
        let found = discover(Path::new(&dir));
        eprintln!("{found:?}");
        assert!(found.iter().any(|s| s.running && s.lick && Path::new(&s.sock).exists()), "a running ship with lattice's lick port bound");
    }
}
