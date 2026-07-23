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

fn make_projection() -> Result<LatticeProjection, String> {
    LatticeProjection::new(make_transport()?).map_err(|e| e.msg)
}

fn cmd_auth() -> Result<(), String> {
    let t = EyreTransport::new(&base_url(), &cookie_path());
    t.login(read_code()).map_err(|e| e.msg)?;
    println!("logged in as {}; cookie stored.", t.ship().map_err(|e| e.msg)?);
    Ok(())
}

fn cmd_errors(name: &str) -> Result<(), String> {
    let proj = make_projection()?;
    let out = proj.errors(name).map_err(|e| e.msg)?;
    if !out.is_empty() {
        println!("{out}");
    }
    Ok(())
}

fn cmd_mount(mnt: &str) -> Result<(), String> {
    let proj = make_projection()?;
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
    let r = match args.get(1).map(String::as_str) {
        Some("auth") => cmd_auth(),
        Some("mount") => match args.get(2) {
            Some(m) => cmd_mount(m),
            None => Err("usage: lattice-fs mount <dir>".into()),
        },
        Some("errors") => match args.get(2) {
            Some(n) => cmd_errors(n),
            None => Err("usage: lattice-fs errors <page>".into()),
        },
        _ => {
            eprintln!("usage: lattice-fs auth | mount <dir> | errors <page>");
            std::process::exit(2);
        }
    };
    if let Err(e) = r {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
