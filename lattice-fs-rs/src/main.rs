//! lattice-fs — mount the lattice page tree as a FUSE filesystem.
//!
//!   lattice-fs auth              log in once, store the session cookie
//!   lattice-fs mount <dir>       mount the page tree at <dir> (foreground)
//!   lattice-fs errors <page>     print a page's latest evaluator error
//!
//! Config (env): LATTICE_URL (default http://localhost:8080),
//!               LATTICE_CODE (+code for unattended auth),
//!               cookie at ~/.config/lattice-fs/cookie (mode 600).

#[path = "core.rs"]
mod vfs;
mod eyre;
mod lattice;
mod lick;
mod projection;
mod transport;

use std::sync::Arc;

use eyre::EyreTransport;
use lattice::LatticeProjection;
use lick::LickTransport;
use projection::Projection;
use transport::Transport;
use vfs::GrubberyFs;

/// Pick a transport: lick when LATTICE_SOCK is set (native local IPC, no cookie),
/// else Eyre HTTP. Both drive the same projection.
fn make_transport() -> Result<Box<dyn Transport>, String> {
    if let Ok(sock) = std::env::var("LATTICE_SOCK") {
        let ship = std::env::var("LATTICE_SHIP")
            .map_err(|_| "LATTICE_SOCK set but LATTICE_SHIP missing (e.g. ~tyr)".to_string())?;
        Ok(Box::new(LickTransport::new(&sock, &ship)))
    } else {
        Ok(Box::new(EyreTransport::new(&base_url(), &cookie_path())))
    }
}

fn cookie_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    format!("{home}/.config/lattice-fs/cookie")
}

fn base_url() -> String {
    std::env::var("LATTICE_URL").unwrap_or_else(|_| "http://localhost:8080".into())
}

/// Where to root the mounted tree. A value like `notes` or `page/notes` or the
/// full ball path `/apps/lattice.lattice_app/page/notes` mounts a lattice
/// sub-tree (keeps all page semantics). Any other absolute ball path
/// (`/apps/obelisk.obelisk_app`, …) is a generic tree — a different nexus.
enum Root {
    Lattice(String), // sub-root under /page ("" = whole tree)
    Generic(String), // full ball path
}

fn resolve_root(val: &str) -> Root {
    let v = val.trim();
    if v.is_empty() {
        return Root::Lattice(String::new());
    }
    if let Some(rest) = v.strip_prefix("/apps/lattice.lattice_app/page") {
        return Root::Lattice(rest.trim_matches('/').to_string());
    }
    if v.starts_with('/') {
        return Root::Generic(v.trim_matches('/').to_string());
    }
    let rel = v.trim_matches('/');
    Root::Lattice(rel.strip_prefix("page/").unwrap_or(rel).to_string())
}

fn make_projection(root: &str) -> Result<LatticeProjection, String> {
    match resolve_root(root) {
        Root::Lattice(sub) => {
            LatticeProjection::new(make_transport()?, &sub).map_err(|e| e.msg)
        }
        Root::Generic(path) => Err(format!(
            "generic (non-lattice) root '/{path}' isn't supported yet — \
             only lattice sub-trees for now (e.g. --root notes)"
        )),
    }
}

fn cmd_auth() -> Result<(), String> {
    let t = EyreTransport::new(&base_url(), &cookie_path());
    t.login(read_code()).map_err(|e| e.msg)?;
    println!("logged in as {}; cookie stored.", t.ship().map_err(|e| e.msg)?);
    Ok(())
}

fn cmd_errors(name: &str, root: &str) -> Result<(), String> {
    let proj = make_projection(root)?;
    let out = proj.errors(name).map_err(|e| e.msg)?;
    if !out.is_empty() {
        println!("{out}");
    }
    Ok(())
}

fn cmd_mount(mnt: &str, root: &str) -> Result<(), String> {
    let proj = make_projection(root)?;
    let ship = proj.ship().to_string();
    std::fs::create_dir_all(mnt).ok();
    // Config is #[non_exhaustive] -> build via default() + field assignment.
    let mut config = fuser::Config::default();
    config.mount_options = vec![
        fuser::MountOption::FSName("lattice".to_string()),
        // kernel enforces perms from the uid/gid/mode we report: files read as
        // owner-writable (rm/nvim don't prompt), 0444 index pages are write-denied.
        fuser::MountOption::DefaultPermissions,
    ];
    // Owner ACL: only the mounting user reaches the mount. (AutoUnmount would
    // require allow_other, which we don't want — a foreground mount unmounts on exit.)
    config.acl = fuser::SessionACL::Owner;
    println!("mounting lattice ({ship}) at {mnt} — Ctrl-C to unmount");
    fuser::mount(GrubberyFs::new(Arc::new(proj)), mnt, &config).map_err(|e| e.to_string())
}

/// Read a +code from the tty without echo. Returns None if LATTICE_CODE is set
/// (login() picks it up) or on read failure.
fn read_code() -> Option<String> {
    use std::io::{BufRead, Write};
    if std::env::var_os("LATTICE_CODE").is_some() {
        return None;
    }
    eprint!("ship +code (hidden): ");
    let _ = std::io::stderr().flush();
    let fd = 0;
    let mut term: libc::termios = unsafe { std::mem::zeroed() };
    let have_tty = unsafe { libc::tcgetattr(fd, &mut term) } == 0;
    let saved = term;
    if have_tty {
        term.c_lflag &= !libc::ECHO;
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &term) };
    }
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    if have_tty {
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &saved) };
        eprintln!();
    }
    let line = line.trim().to_string();
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // --root <val> may appear anywhere after the command; LATTICE_ROOT is the
    // env fallback. Everything else is positional (the mountpoint / page name).
    let mut root = std::env::var("LATTICE_ROOT").unwrap_or_default();
    let mut pos: Vec<String> = Vec::new();
    let mut i = 2;
    while i < args.len() {
        if args[i] == "--root" {
            match args.get(i + 1) {
                Some(v) => {
                    root = v.clone();
                    i += 2;
                    continue;
                }
                None => {
                    eprintln!("error: --root needs a value");
                    std::process::exit(2);
                }
            }
        }
        pos.push(args[i].clone());
        i += 1;
    }
    let r = match args.get(1).map(String::as_str) {
        Some("auth") => cmd_auth(),
        Some("mount") => match pos.first() {
            Some(m) => cmd_mount(m, &root),
            None => Err("usage: lattice-fs mount <dir> [--root <path>]".into()),
        },
        Some("errors") => match pos.first() {
            Some(n) => cmd_errors(n, &root),
            None => Err("usage: lattice-fs errors <page> [--root <path>]".into()),
        },
        _ => {
            eprintln!("usage: lattice-fs auth | mount <dir> [--root <path>] | errors <page>");
            std::process::exit(2);
        }
    };
    if let Err(e) = r {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
