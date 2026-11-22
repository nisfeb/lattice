//! Mounting a ship's pages as a folder, through `lattice-fs`, the
//! mounter this repository builds (`lattice-fs-rs`). It is run as a
//! program of its own for each mount, so this app links no FUSE code:
//! `lattice-fs mount <folder>` with the ship's lick socket in
//! `LATTICE_SOCK`. The mounter holds the mount until it is sent
//! SIGTERM, on which it lets the socket drain before it unmounts. It is
//! never killed outright: a lick socket dropped mid-write crashes the
//! ship (`lattice-fs-rs/src/main.rs`, `cmd_mount`). What it says on
//! stderr goes to `mounter.log` beside the list, never to a pipe.
//!
//! A mount outlives this app's window, and is found again at the next
//! launch by the folder still being a mount, with the mounter's process
//! id kept in a file beside the list.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A mount to keep: where, of which ship, and by which socket.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct MountSpec {
    pub mountpoint: String,
    /// The lick socket inside the ship's pier. Empty for a ship reached over HTTP, at `url`.
    #[serde(default)]
    pub sock: String,
    #[serde(default)]
    pub url: String,
    /// The part of the tree mounted, like `notes`. Empty is every page.
    #[serde(default)]
    pub root: String,
    /// The ship's name, for show.
    #[serde(default)]
    pub ship: String,
    /// The mounter's process, while it is known to be this mount's.
    #[serde(default)]
    pub pid: u32,
}

/// The mounter: the one `LATTICE_FS` names, then beside this program, then on the path.
pub fn locate() -> Option<PathBuf> {
    let named = std::env::var_os("LATTICE_FS").map(PathBuf::from);
    let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("lattice-fs")));
    named.into_iter().chain(beside).find(|p| p.is_file()).or_else(|| {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path).map(|d| d.join("lattice-fs")).find(|p| p.is_file())
    })
}

/// A folder as typed, with `~` as the home directory.
pub fn expand(typed: &str, home: &str) -> String {
    let t = typed.trim();
    match t.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
        _ => t.to_owned(),
    }
}

/// Where a ship is mounted when no folder is typed: its name under the home directory.
pub fn default_mountpoint(ship: &str) -> String {
    format!("~/{}", ship.trim_start_matches('~'))
}

/// A folder as the system's list writes it, read back: a space, a tab, a newline and a backslash are each written as a backslash and three digits in base eight.
fn unescaped(m: &str) -> String {
    let (b, mut out, mut i) = (m.as_bytes(), Vec::with_capacity(m.len()), 0);
    while i < b.len() {
        let digits = b.get(i + 1..i + 4).filter(|d| b[i] == b'\\' && d[0] <= b'3' && d.iter().all(|c| (b'0'..=b'7').contains(c)));
        match digits {
            Some(d) => {
                out.push((d[0] - b'0') * 64 + (d[1] - b'0') * 8 + (d[2] - b'0'));
                i += 4;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether a folder is a mount, from the system's list of them (`/proc/self/mounts`: device, folder, kind, and more). `folder` is spelled as the system spells it (`resolved`).
pub fn in_mounts(list: &str, folder: &str) -> bool {
    let want = folder.trim_end_matches('/');
    list.lines().filter_map(|l| l.split(' ').nth(1)).any(|m| unescaped(m).trim_end_matches('/') == want)
}

/// A folder as the system spells it in its list of mounts: with no link on the way to it, no
/// doubled slash and no `.`. The folder itself is never looked into, only read as a link and its
/// parent resolved: it may be a mount whose mounter does not answer, and asking after it would
/// wait on that. A folder not there yet, under a parent not there yet, stays as typed.
fn resolved(folder: &str) -> String {
    // a slash at the end would have a link followed where it is only to be read
    let mut p = PathBuf::from(match folder.trim_end_matches('/') {
        "" => "/",
        f => f,
    });
    // the folder itself a link, or a short run of them
    for _ in 0..8 {
        match std::fs::read_link(&p) {
            Ok(to) => p = p.parent().unwrap_or(Path::new("/")).join(to),
            Err(_) => break,
        }
    }
    let whole = match (p.parent(), p.file_name()) {
        (Some(dir), Some(name)) => std::fs::canonicalize(dir).map(|d| d.join(name)),
        // the root, or a path that ends in `..`: nothing of a mount's own is asked by these
        _ => std::fs::canonicalize(&p),
    };
    whole.map_or_else(|_| folder.to_owned(), |w| w.to_string_lossy().into_owned())
}

pub fn mounted(folder: &str) -> bool {
    // ponytail: Linux's list. A Mac has none at this path and would say no: its `mount` is asked when a Mac is where this runs
    std::fs::read_to_string("/proc/self/mounts").is_ok_and(|l| in_mounts(&l, &resolved(folder)))
}

/// Why a folder cannot be mounted on, if it cannot: it is a mount already, a file, or has things in it.
pub fn refusal(folder: &str) -> Option<String> {
    let p = Path::new(folder);
    if !p.is_absolute() {
        return Some("a folder to mount at is a whole path, or starts with ~".into());
    }
    if mounted(folder) {
        return Some(format!("{folder} is a mount already"));
    }
    if p.is_file() {
        return Some(format!("{folder} is a file"));
    }
    if std::fs::read_dir(p).is_ok_and(|mut d| d.next().is_some()) {
        return Some(format!("{folder} has things in it: a mount would hide them"));
    }
    None
}

/// The name of the file the mounter reads a ship's session from: `cookie-<scheme>-<host>-<port>`, as `lattice-fs-rs/src/eyre.rs` names it (`origin_of`, `cookie_file_name`). The port is the scheme's own when the address names none.
pub fn cookie_file_name(url: &str) -> Result<String, String> {
    let (scheme, rest) = url.trim().split_once("://").ok_or_else(|| format!("{url} is not a ship's address"))?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "https" => "443",
        "http" => "80",
        _ => return Err(format!("{url}: the scheme must be http or https")),
    };
    let authority = rest.split(['/', '?', '#', '\\']).next().unwrap_or("");
    let (host, port) = match authority.strip_prefix('[').and_then(|v6| v6.split_once(']')) {
        Some((h, after)) => (h, after.strip_prefix(':')),
        None => match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        },
    };
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    let port = port.filter(|p| !p.is_empty()).unwrap_or(default_port);
    if host.is_empty() || port.parse::<u16>().is_err() {
        return Err(format!("{url} is not a ship's address"));
    }
    Ok(format!("cookie-{scheme}-{host}-{port}").chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect())
}

/// Puts the session where the mounter will read it: a home of its own under this app's files, so the mounter's own files in the owner's home are never touched. Answers that home.
pub(crate) fn hand_session(url: &str, cookie: &str) -> Result<PathBuf, String> {
    // nothing is mounted from a browser
    #[cfg(target_arch = "wasm32")]
    return {
        let _ = (url, cookie);
        Err("not in the browser build".into())
    };
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::io::Write;
        #[cfg(unix)]
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let home = list_path().ok_or("no home directory")?.with_file_name("fs-home");
        let dir = home.join(".config").join("lattice-fs");
        // the folder and the file are their owner's alone, where the system has such a thing to say
        let (mut mk, mut open) = (std::fs::DirBuilder::new(), std::fs::OpenOptions::new());
        mk.recursive(true);
        open.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            mk.mode(0o700);
            open.mode(0o600);
        }
        mk.create(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(cookie_file_name(url)?);
        open.open(&file).and_then(|mut f| f.write_all(cookie.as_bytes())).map_err(|e| e.to_string())?;
        Ok(home)
    }
}

/// Takes away the session handed to a mounter for the ship at `url`, when it is signed out of.
pub fn forget_session(url: &str) {
    if let (Some(home), Ok(name)) = (list_path().map(|p| p.with_file_name("fs-home")), cookie_file_name(url)) {
        let _ = std::fs::remove_file(home.join(".config").join("lattice-fs").join(name));
    }
}

/// Mounts a ship at a folder and answers the mounter's process, once the folder is a mount. A ship reached over HTTP is mounted with the session given.
pub fn start(spec: &MountSpec, session: Option<&str>) -> Result<u32, String> {
    let fs = locate().ok_or("the lattice-fs mounter was not found: build it from lattice-fs-rs, and put it on the path or name it in LATTICE_FS")?;
    let lick = !spec.sock.is_empty();
    if lick && !Path::new(&spec.sock).exists() {
        return Err(format!("{} is gone: that ship is not running, or its lattice is not up", spec.sock));
    }
    let mut cmd = Command::new(fs);
    cmd.args(["mount", &spec.mountpoint]).env_remove("LATTICE_ROOT").env_remove("LATTICE_CODE");
    if !spec.root.trim().is_empty() {
        cmd.args(["--root", spec.root.trim()]);
    }
    if lick {
        cmd.env("LATTICE_SOCK", &spec.sock).env("LATTICE_SHIP", &spec.ship).env_remove("LATTICE_URL");
    } else {
        let session = session.ok_or_else(|| format!("sign in to {} to mount it", spec.url))?;
        cmd.env("HOME", hand_session(&spec.url, session)?).env("LATTICE_URL", &spec.url).env_remove("LATTICE_SOCK");
    }
    if let Some(why) = refusal(&spec.mountpoint) {
        return Err(why);
    }
    std::fs::create_dir_all(&spec.mountpoint).map_err(|e| format!("{}: {e}", spec.mountpoint))?;
    let log = log_path();
    let (mut child, from) = spawn_mounter(&mut cmd, log.as_deref())?;
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        if mounted(&spec.mountpoint) {
            // the mounter mounts whatever the ship says of the session: a folder that cannot be listed is one the ship refused, and is taken down again
            if let Err(e) = std::fs::read_dir(&spec.mountpoint) {
                term(child.id());
                let until = Instant::now() + Duration::from_secs(10);
                while mounted(&spec.mountpoint) && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(100));
                }
                return Err(format!("the ship did not let the folder be read ({e}): sign in again"));
            }
            return Ok(child.id());
        }
        if let Ok(Some(_)) = child.try_wait() {
            let said = log.as_deref().map(|l| said_since(l, from)).unwrap_or_default();
            return Err(format!("the mounter stopped: {}", said.trim().trim_start_matches("error: ")));
        }
        if Instant::now() > until {
            // asked to stop the way it stops cleanly, never killed
            term(child.id());
            return Err("the folder did not become a mount in twenty seconds".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Where the mounters say what they have to say: one file beside the list, for them all.
fn log_path() -> Option<PathBuf> {
    Some(list_path()?.with_file_name("mounter.log"))
}

/// Starts a mounter with its stderr added to the end of `log`, and answers it with where in the
/// log its own words begin. Never a pipe: a mounter outlives the call that started it, and the
/// window, and a pipe nobody reads fails its next word on stderr. That word is said on its way
/// out, before it drains the lick socket, so failing there is what must not happen. With no log
/// to write to, what it says is dropped.
fn spawn_mounter(cmd: &mut Command, log: Option<&Path>) -> Result<(std::process::Child, u64), String> {
    let open = |p: &Path| -> std::io::Result<(std::fs::File, u64)> {
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut o = std::fs::OpenOptions::new();
        o.append(true).create(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
        let f = o.open(p)?;
        // a few lines a mount, and it starts again when it has grown large. Those still writing add at its end, wherever that is
        if f.metadata()?.len() > 1024 * 1024 {
            f.set_len(0)?;
        }
        let from = f.metadata()?.len();
        Ok((f, from))
    };
    let (err, from) = match log.map(open) {
        Some(Ok((f, from))) => (Stdio::from(f), from),
        _ => (Stdio::null(), 0),
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(err).spawn().map(|c| (c, from)).map_err(|e| format!("the mounter did not start: {e}"))
}

/// What was added to the log from `from` on: what a mounter that stopped said of why.
fn said_since(log: &Path, from: u64) -> String {
    let all = std::fs::read(log).unwrap_or_default();
    String::from_utf8_lossy(all.get(from as usize..).unwrap_or_default()).into_owned()
}

fn term(pid: u32) {
    let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Whether a process is a lattice-fs mounter of this folder: asked before it is signalled, since a number kept from a run before may be another program's now.
fn is_mounter(pid: u32, folder: &str) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|c| {
        let args: Vec<String> = c.split(|b| *b == 0).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
        args.first().is_some_and(|a| a.ends_with("lattice-fs")) && args.iter().any(|a| a == folder)
    })
}

/// Unmounts: the mounter is asked to stop, which drains the socket first, and the folder is waited on.
pub fn stop(spec: &MountSpec) -> Result<(), String> {
    if !mounted(&spec.mountpoint) {
        return Ok(());
    }
    if spec.pid == 0 || !is_mounter(spec.pid, &spec.mountpoint) {
        return Err(format!("{} is mounted, and not by a mounter this app knows: unmount it with fusermount3 -u", spec.mountpoint));
    }
    term(spec.pid);
    let until = Instant::now() + Duration::from_secs(10);
    while mounted(&spec.mountpoint) {
        if Instant::now() > until {
            return Err(format!("{} was asked to unmount and has not yet: something may have it open", spec.mountpoint));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn list_path() -> Option<PathBuf> {
    Some(crate::api::config_dir()?.join("mounts.json"))
}

fn load_at(p: &Path) -> Vec<MountSpec> {
    std::fs::read(p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// The mounts kept from the runs before.
pub fn load() -> Vec<MountSpec> {
    list_path().map(|p| load_at(&p)).unwrap_or_default()
}

pub fn save(list: &[MountSpec]) -> Result<(), String> {
    let p = list_path().ok_or("no home directory")?;
    std::fs::create_dir_all(p.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
    std::fs::write(&p, serde_json::to_vec(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Each kept mount as it stands at launch: still mounted, mounted again now, or why not. `session` gives the session for a ship's address, when this window is signed in to it.
pub fn resume(list: Vec<MountSpec>, session: impl Fn(&str) -> Option<String>) -> Vec<(MountSpec, Result<(), String>)> {
    list.into_iter()
        .map(|mut m| {
            if mounted(&m.mountpoint) {
                return (m, Ok(()));
            }
            let r = start(&m, session(&m.url).as_deref()).map(|pid| m.pid = pid);
            (m, r)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn a_mounter_let_go_of_can_still_say_things_and_what_it_said_is_read_from_its_log() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("lr-mnt-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (log, mark) = (dir.join("deeper/mounter.log"), dir.join("mark"));
        // a stand-in that says a word on stderr well after it was started, as the mounter does when it is told to unmount, and only then does its work
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 0.3; echo late >&2 && echo fine > \"$0\"", &mark.to_string_lossy()]);
        let (child, from) = spawn_mounter(&mut cmd, Some(&log)).unwrap();
        // as `start` does once the folder is a mount: the process is let go of
        drop(child);
        let until = Instant::now() + Duration::from_secs(10);
        while !mark.exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(std::fs::read_to_string(&mark).unwrap_or_default().trim(), "fine", "the word on stderr did not end it");
        assert_eq!((from, said_since(&log, from).as_str()), (0, "late\n"));
        assert_eq!(std::fs::metadata(&log).unwrap().permissions().mode() & 0o777, 0o600);
        // the next one's words follow in the same file, and only its own are read as why it stopped
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "echo 'error: no such ship' >&2; exit 3"]);
        let (mut child, from) = spawn_mounter(&mut cmd, Some(&log)).unwrap();
        assert_eq!((child.wait().unwrap().code(), from, said_since(&log, from).as_str()), (Some(3), 5, "error: no such ship\n"));
        // with nowhere to keep a log it still starts, and still outlives its words
        let _ = std::fs::remove_file(&mark);
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 0.3; echo late >&2 && echo fine > \"$0\"", &mark.to_string_lossy()]);
        drop(spawn_mounter(&mut cmd, None).unwrap());
        let until = Instant::now() + Duration::from_secs(10);
        while !mark.exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(std::fs::read_to_string(&mark).unwrap_or_default().trim(), "fine");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The real mounter, started and stopped as the app does it, at a folder reached through a
    /// link. Run with `LATTICE_FS` naming a built `lattice-fs`, where FUSE can be used.
    #[test]
    #[ignore = "needs FUSE, and LATTICE_FS naming a built lattice-fs"]
    fn a_real_mounter_is_started_at_a_linked_folder_and_stopped_cleanly() {
        use std::io::{Read, Write};
        let dir = std::env::temp_dir().join(format!("lr-mnt-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("real")).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
        crate::api::TEST_CONFIG.with(|t| *t.borrow_mut() = Some(dir.join("config/lattice-rune")));
        // a ship that answers every read with an empty tree
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                std::thread::spawn(move || {
                    let mut b = [0u8; 8192];
                    let _ = s.read(&mut b);
                    let body = r#"{"nodes":[],"since":"s"}"#;
                    let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                });
            }
        });
        let mut spec = MountSpec { mountpoint: format!("{}//link/mnt", dir.display()), url, ship: "~zod".into(), ..MountSpec::default() };
        spec.pid = start(&spec, Some("urbauth-~zod=0v1.x")).expect("the folder is seen to become a mount, though the system spells it another way");
        assert!(mounted(&spec.mountpoint) && mounted(&dir.join("real/mnt").to_string_lossy()));
        assert!(refusal(&spec.mountpoint).unwrap().ends_with("is a mount already"));
        stop(&spec).unwrap();
        assert!(!mounted(&spec.mountpoint));
        // it said its word on the way out and went on to unmount: its stderr is a file, not a pipe let go of
        let until = Instant::now() + Duration::from_secs(10);
        while std::path::Path::new(&format!("/proc/{}/cmdline", spec.pid)).exists() && !std::fs::read_to_string(format!("/proc/{}/stat", spec.pid)).is_ok_and(|t| t.contains(") Z ")) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        let said = said_since(&log_path().unwrap(), 0);
        assert!(said.contains("unmounting") && !said.contains("panicked"), "{said}");
        crate::api::TEST_CONFIG.with(|t| *t.borrow_mut() = None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(unix)]
    fn a_mount_is_seen_however_its_folder_is_spelled() {
        let dir = std::env::temp_dir().join(format!("lr-mnt-spell-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("real/plain")).unwrap();
        // through a link, as a home directory under a linked /home is
        std::os::unix::fs::symlink("/proc", dir.join("link")).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("to-real")).unwrap();
        let at = |n: &str| dir.join(n).to_string_lossy().into_owned();
        assert!(mounted("/proc") && mounted(&at("link")) && mounted(&format!("{}/", at("link"))), "the folder itself a link");
        assert!(mounted("//proc") && mounted("/proc/.") && mounted("/proc/"));
        assert!(refusal(&at("link")).unwrap().ends_with("is a mount already"));
        // a folder that is no mount is not one by any spelling, there or not
        assert!(!mounted(&at("real/plain")) && !mounted(&at("to-real/plain")) && !mounted(&at("to-real/not-there-yet")) && !mounted(&at("real/../real/plain")));
        assert_eq!(refusal(&at("to-real/plain")), None);
        // every character the system writes its own way is read back: a tab, a backslash, a letter of more than one byte
        let list = "lattice /home/x/my\\011ship fuse rw 0 0\nlattice /home/x/caf\\303\\251 fuse rw 0 0\nlattice /home/x/back\\134slash fuse rw 0 0\nlattice /home/x/odd\\9 fuse rw 0 0\n";
        assert!(in_mounts(list, "/home/x/my\tship") && in_mounts(list, "/home/x/caf\u{e9}") && in_mounts(list, "/home/x/back\\slash"));
        assert!(!in_mounts(list, "/home/x/back\\134slash"), "a name is not read through the system's way of writing another");
        assert!(in_mounts(list, "/home/x/odd\\9"), "a backslash that starts no number is itself");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_is_read_as_typed_and_told_from_a_mount() {
        assert_eq!([expand("~/zod", "/home/x"), expand(" ~ ", "/home/x"), expand("/mnt/a", "/home/x"), expand("~zod", "/home/x")], ["/home/x/zod", "/home/x", "/mnt/a", "~zod"]);
        assert_eq!(default_mountpoint("~sampel-palnet"), "~/sampel-palnet");
        let list = "sysfs /sys sysfs rw 0 0\nlattice /home/x/zod fuse rw,nosuid 0 0\nlattice /home/x/my\\040ship fuse rw 0 0\n";
        assert!(in_mounts(list, "/home/x/zod") && in_mounts(list, "/home/x/zod/") && in_mounts(list, "/home/x/my ship"));
        assert!(!in_mounts(list, "/home/x") && !in_mounts(list, "/home/x/zo") && !in_mounts("", "/a"));
        // a folder is refused when mounting there would hide something, or is not a place
        let dir = std::env::temp_dir().join(format!("lr-mnt-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("full")).unwrap();
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        std::fs::write(dir.join("full/x"), b"").unwrap();
        let at = |n: &str| dir.join(n).to_string_lossy().into_owned();
        assert!(refusal(&at("full")).unwrap().contains("has things in it"));
        assert!(refusal(&at("full/x")).unwrap().ends_with("is a file"));
        assert_eq!((refusal(&at("empty")), refusal(&at("not-there-yet"))), (None, None));
        assert!(refusal("relative/path").is_some() && refusal("/proc").unwrap().ends_with("is a mount already"));
        // the list is kept and read back, and a file that is not one reads as none
        let file = dir.join("mounts.json");
        let spec = MountSpec { mountpoint: at("empty"), sock: "/p/.urb/dev/grubbery/lattice/fs".into(), ship: "~zod".into(), pid: 7, ..MountSpec::default() };
        // a list kept before mounts could be over HTTP still reads
        assert_eq!(serde_json::from_str::<Vec<MountSpec>>(r#"[{"mountpoint":"/a","sock":"/s","ship":"~zod","pid":3}]"#).unwrap()[0].url, "");
        // the session's file is named as the mounter names it
        assert_eq!(cookie_file_name("http://localhost:8222").unwrap(), "cookie-http-localhost-8222");
        assert_eq!(cookie_file_name("https://Ship.Example.com./apps").unwrap(), "cookie-https-ship.example.com-443");
        assert_eq!(cookie_file_name("http://[::1]:8080").unwrap(), "cookie-http-__1-8080");
        assert!(cookie_file_name("ftp://x").is_err() && cookie_file_name("localhost:80").is_err() && cookie_file_name("http://").is_err());
        std::fs::write(&file, serde_json::to_vec(&[spec.clone()]).unwrap()).unwrap();
        assert_eq!(load_at(&file), [spec.clone()]);
        std::fs::write(&file, b"nonsense").unwrap();
        assert!(load_at(&file).is_empty());
        // a ship whose socket is gone is said so, before anything is run
        assert!(start(&MountSpec { sock: at("no-socket"), ..spec.clone() }, None).unwrap_err().contains("is gone") || locate().is_none());
        // a ship over HTTP is not mounted without a session for it
        assert!(start(&MountSpec { sock: String::new(), url: "http://localhost:1".into(), ..spec.clone() }, None).unwrap_err().starts_with("sign in to") || locate().is_none());
        // a process that is not a mounter of the folder is never signalled
        assert!(!is_mounter(std::process::id(), &spec.mountpoint) && !is_mounter(0, "/"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A fake ship's pier mounted over lick, read, and unmounted: `LATTICE_PIERS` names the directory its pier is in, `LATTICE_FS` the mounter.
    #[test]
    #[ignore]
    fn live_mount() {
        let piers = std::env::var_os("LATTICE_PIERS").expect("LATTICE_PIERS");
        let ship = crate::local::discover(Path::new(&piers)).into_iter().find(|s| s.lick).expect("a running ship with lattice's lick port");
        let at = std::env::temp_dir().join(format!("lr-live-mount-{}", std::process::id())).to_string_lossy().into_owned();
        let mut spec = MountSpec { mountpoint: at.clone(), sock: ship.sock, ship: ship.ship, ..MountSpec::default() };
        spec.pid = start(&spec, None).unwrap();
        assert!(mounted(&at) && is_mounter(spec.pid, &at));
        let names: Vec<String> = std::fs::read_dir(&at).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        eprintln!("in the mount: {names:?}");
        // mounting there again is refused, and the kept mount is found as it stands
        assert!(start(&spec, None).unwrap_err().ends_with("is a mount already"));
        assert!(matches!(resume(vec![spec.clone()], |_| None).as_slice(), [(_, Ok(()))]));
        stop(&spec).unwrap();
        assert!(!mounted(&at));
        let _ = std::fs::remove_dir(&at);
    }

    /// A ship mounted over HTTP with a session, whole and by a part of its tree: `LATTICE_URL` and `LATTICE_COOKIE` as the other live tests take them, `LATTICE_FS` the mounter. The ship has pages `mnt/in` and `out`.
    #[test]
    #[ignore]
    fn live_mount_http() {
        let c = crate::api::Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let base = std::env::temp_dir().join(format!("lr-live-http-{}", std::process::id()));
        let names = |at: &str| {
            let mut n: Vec<String> = std::fs::read_dir(at).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            n.sort();
            n
        };
        let mut whole = MountSpec { mountpoint: base.join("whole").to_string_lossy().into_owned(), url: c.url.clone(), ship: c.ship().to_owned(), ..MountSpec::default() };
        whole.pid = start(&whole, Some(c.cookie.as_str())).unwrap();
        eprintln!("the whole tree: {:?}", names(&whole.mountpoint));
        assert!(names(&whole.mountpoint).contains(&"out.md".to_owned()) && names(&whole.mountpoint).contains(&"mnt".to_owned()));
        let mut part = MountSpec { mountpoint: base.join("part").to_string_lossy().into_owned(), root: "mnt".into(), ..whole.clone() };
        part.pid = start(&part, Some(c.cookie.as_str())).unwrap();
        assert_eq!(names(&part.mountpoint), ["in.md"], "only what is under the part");
        assert_eq!(std::fs::read_to_string(base.join("part/in.md")).unwrap().trim(), "# inside");
        stop(&part).unwrap();
        stop(&whole).unwrap();
        assert!(!mounted(&whole.mountpoint) && !mounted(&part.mountpoint));
        // a session the ship does not take is said, and nothing is left mounted
        let bad = start(&whole, Some("urbauth-~zod=0v0"));
        eprintln!("a session not taken: {bad:?}");
        assert!(bad.is_err() && !mounted(&whole.mountpoint));
        let _ = std::fs::remove_dir_all(base);
    }
}
