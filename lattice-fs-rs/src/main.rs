//! lattice-fs: mount the lattice page tree as a FUSE filesystem.
//!
//!   lattice-fs auth              log in once, store the session cookie
//!   lattice-fs mount <dir>       mount the page tree at <dir> (foreground)
//!   lattice-fs errors <page>     print a page's latest evaluator error
//!
//! Config (env): LATTICE_URL (default http://localhost:8080),
//!               LATTICE_CODE (+code for unattended auth),
//!               cookie at ~/.config/lattice-fs/cookie (mode 600).
//!
//! The projections, transports, and mount helpers live in the lattice_fs
//! library (src/lib.rs). This binary is CLI parsing plus the lick branch.

use std::sync::Arc;

use lattice_fs::eyre::EyreTransport;
use lattice_fs::projection::Projection;
use lattice_fs::transport::Transport;
use lattice_fs::vfs::GrubberyFs;
use lattice_fs::{
    default_cookie_path as cookie_path, mount_config, projection_http, projection_lick,
    resolve_root, Root,
};

fn base_url() -> String {
    std::env::var("LATTICE_URL").unwrap_or_else(|_| "http://localhost:8080".into())
}

/// lick when LATTICE_SOCK is set (native local IPC, no cookie), else Eyre
/// HTTP. The generic ball API is HTTP-only, so a generic root takes HTTP
/// whatever LATTICE_SOCK says.
fn make_projection(root: &str) -> Result<Arc<dyn Projection>, String> {
    match (std::env::var("LATTICE_SOCK"), resolve_root(root)) {
        (Ok(sock), Root::Lattice(_)) => {
            let ship = std::env::var("LATTICE_SHIP")
                .map_err(|_| "LATTICE_SOCK set but LATTICE_SHIP missing (e.g. ~tyr)".to_string())?;
            projection_lick(&sock, &ship, root)
        }
        _ => projection_http(&base_url(), &cookie_path(), root),
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
    let ship = proj.ship();
    std::fs::create_dir_all(mnt).ok();
    let config = mount_config();
    println!("mounting lattice ({ship}) at {mnt} — Ctrl-C to unmount");
    fuser::mount(GrubberyFs::new(proj), mnt, &config).map_err(|e| e.to_string())
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
    // --root <val> may appear anywhere after the command. LATTICE_ROOT is the
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
