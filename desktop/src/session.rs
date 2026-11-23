//! The ship session: which URLs a +code may be sent to, the login itself,
//! and where the session cookie is kept.
//!
//! The cookie is stored PER TARGET. Each ship origin gets its own file, and
//! the only way to put a cookie on a request is to look it up by that
//! request's own origin. So a ship switch cannot send the old ship's cookie
//! to the new URL, or the new cookie to the old one, whatever order the
//! config and the bridge happen to change in.

use std::path::PathBuf;

use lattice_fs::default_cookie_path;

/// The ship URL rule, lattice-fs's (+check_ship_url there), so the CLI and
/// the desktop refuse the same URLs. Returns the base with any trailing
/// slash removed.
pub fn check_ship_url(raw: &str) -> Result<String, String> {
    let base = raw.trim().trim_end_matches('/').to_string();
    lattice_fs::eyre::check_ship_url(&base)?;
    Ok(base)
}

/// A filename for an origin. Letters, digits, '.' and '-' stay as they are,
/// every other byte becomes _xx. That keeps the name readable and makes
/// distinct origins map to distinct files.
fn origin_file(origin: &str) -> String {
    let mut s = String::from("cookie-");
    for b in origin.bytes() {
        if b.is_ascii_alphanumeric() || b == b'.' || b == b'-' {
            s.push(b as char);
        } else {
            s.push_str(&format!("_{b:02x}"));
        }
    }
    s
}

/// scheme://host:port, the part of a URL a cookie belongs to.
fn origin(url: &str) -> Option<String> {
    let u = tauri::Url::parse(url).ok()?;
    let host = u.host_str()?;
    let port = u.port_or_known_default()?;
    Some(format!("{}://{}:{}", u.scheme(), host.to_ascii_lowercase(), port))
}

fn cookie_dir() -> PathBuf {
    let p = PathBuf::from(default_cookie_path());
    p.parent().map(|d| d.join("desktop")).unwrap_or_else(|| PathBuf::from("desktop"))
}

/// The directory this app keeps its secrets in (0700): the session
/// cookies, and the Mapbox token (tiles.rs).
pub fn secret_dir() -> PathBuf {
    cookie_dir()
}

/// Where the cookie for `url` lives. None for a URL the rule refuses, so a
/// config written before the rule existed cannot carry a cookie over plain
/// http to a public host either.
pub fn cookie_path_for(url: &str) -> Option<PathBuf> {
    check_ship_url(url).ok()?;
    Some(cookie_dir().join(origin_file(&origin(url)?)))
}

/// The session cookie for `url`'s origin, if there is one.
pub fn cookie_for(url: &str) -> Option<String> {
    crate::proxy::session_cookie(cookie_path_for(url)?.to_str()?)
}

/// urbauth-~zod=0v... gives ~zod. Requires a non-empty cookie value and
/// a valid Urbit @p ship name.
pub fn ship_of(cookie: &str) -> Option<String> {
    let (k, v) = cookie.split_once('=')?;
    if v.trim().is_empty() {
        return None;
    }
    let name = k.trim().strip_prefix("urbauth-")?;
    crate::urb::is_patp(name).then(|| name.to_string())
}

/// Find the first valid non-empty urbauth-<@p>=<value> cookie across all
/// Set-Cookie headers.
fn urbauth_from_headers<'a>(headers: impl IntoIterator<Item = &'a str>) -> Option<String> {
    headers.into_iter().find_map(|sc| {
        let ck = sc.split(';').next().unwrap_or("").trim();
        ship_of(ck).map(|_| ck.to_string())
    })
}

/// Write `cookie` as the session for `url`. Temp file and rename, so a
/// reader never sees half a cookie.
pub fn store(url: &str, cookie: &str) -> Result<PathBuf, String> {
    let path = cookie_path_for(url).ok_or_else(|| format!("no cookie slot for {url}"))?;
    write_private(&path, cookie.as_bytes())?;
    Ok(path)
}

/// Write `bytes` to `path` so nobody else can read or redirect it: a fresh
/// 0600 temp file opened with create_new (never through a planted symlink),
/// synced, then renamed over the target. A missing parent is made 0700.
/// The cookie file, backup archives and vault exports all go through here.
pub(crate) fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = path.parent().ok_or("no parent directory")?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let name = path.file_name().ok_or("no file name")?.to_string_lossy();
    static TMP_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.{}-{seq}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let res = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut f| f.write_all(bytes).and_then(|_| f.sync_all()))
        .and_then(|_| std::fs::rename(&tmp, path));
    res.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// POST the +code to `base`/~/login and return the urbauth cookie. Nothing
/// is stored here. The caller stores it only once the whole connect has
/// worked.
///
/// Redirects are never followed. The +code must reach the host the user
/// named and no other, and a cookie must come from that host too.
pub fn login(base: &str, code: &str) -> Result<String, String> {
    let base = check_ship_url(base)?;
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(std::time::Duration::from_secs(30))
        .build();
    let resp = agent
        .post(&format!("{base}/~/login"))
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(&format!("password={}", urlencode(code.trim())));
    let resp = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(_, _)) => return Err("login failed: wrong +code?".into()),
        Err(e) => return Err(format!("login error: {e}")),
    };
    let headers = resp.all("set-cookie");
    if headers.is_empty() {
        return Err("login: no Set-Cookie".into());
    }
    urbauth_from_headers(headers).ok_or_else(|| "login: no urbauth cookie".into())
}

/// One time, on launch: builds before per-target cookies kept the session
/// in the shared lattice-fs cookie file. Carry it over for the configured
/// URL so an upgrade does not log anyone out. Only when the cookie is for
/// the ship this config last connected to (or no ship was recorded), so a
/// cookie the CLI wrote for some other ship is not adopted.
pub fn migrate_legacy(cfg: &crate::config::Config) {
    if cfg.url.is_empty() || cookie_for(&cfg.url).is_some() {
        return;
    }
    let Some(old) = crate::proxy::session_cookie(&default_cookie_path()) else { return };
    let Some(ship) = ship_of(&old) else { return };
    if !cfg.ship.is_empty() && cfg.ship != ship {
        return;
    }
    if store(&cfg.url, &old).is_ok() {
        crate::commands::dlog(&format!("session: carried the cookie for {ship} over to {}", cfg.url));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_goes_anywhere() {
        assert!(check_ship_url("https://ship.example.com").is_ok());
        assert!(check_ship_url("https://8.8.8.8:8443/").is_ok());
        assert!(check_ship_url("HTTPS://Ship.Example.com").is_ok());
    }

    #[test]
    fn plain_http_goes_only_somewhere_local() {
        let ok = [
            "http://localhost:8080",
            "http://LOCALHOST",
            "http://ship.localhost",
            "http://127.0.0.1:8080",
            "http://127.9.9.9",
            "http://10.0.0.5",
            "http://172.16.0.1",
            "http://172.31.255.255",
            "http://192.168.1.20:8080/",
            "http://100.64.0.1",
            "http://100.127.255.255",
            "http://[::1]:8080",
            "http://[fc00::1]",
            "http://[FD12:3456::1]",
            "http://myship.local",
            "http://MyShip.Local:8080",
            "http://box.tail1234.ts.net",
        ];
        for u in ok {
            assert!(check_ship_url(u).is_ok(), "{u} should be allowed");
        }
        let bad = [
            "http://ship.example.com",
            "http://8.8.8.8",
            "http://172.15.0.1",
            "http://172.32.0.1",
            "http://192.169.0.1",
            "http://100.63.0.1",
            "http://100.128.0.1",
            "http://11.0.0.1",
            "http://[2001:db8::1]",
            "http://[fe80::1]",
            "http://[::ffff:127.0.0.1]",
            "http://localhost.example.com",
            "http://evil.com/.local",
            "http://local",
            "http://notts.net",
            "http://localhost@evil.com",
        ];
        for u in bad {
            let e = check_ship_url(u).unwrap_err();
            assert!(e.contains("loopback/LAN address") || e.contains("ship URL") || e.contains("scheme"), "{u}: {e}");
        }
    }

    #[test]
    fn junk_and_other_schemes_are_refused() {
        for u in ["", "ship.example.com", "localhost:8080", "ftp://localhost", "file:///etc"] {
            assert!(check_ship_url(u).is_err(), "{u} should be refused");
        }
    }

    #[test]
    fn the_base_loses_its_trailing_slash() {
        assert_eq!(check_ship_url(" http://localhost:8080/ ").unwrap(), "http://localhost:8080");
    }

    #[test]
    fn each_origin_gets_its_own_cookie_file() {
        let a = cookie_path_for("http://localhost:8080").unwrap();
        let b = cookie_path_for("http://localhost:8081").unwrap();
        let c = cookie_path_for("https://localhost:8080").unwrap();
        assert_ne!(a, b);
        assert_ne!(a, c);
        // the same origin, however it is spelled, is one file
        assert_eq!(a, cookie_path_for("http://LOCALHOST:8080/apps/lattice/x?y=1").unwrap());
        assert_eq!(
            cookie_path_for("https://ship.example.com").unwrap(),
            cookie_path_for("https://ship.example.com:443/").unwrap()
        );
        // no path separators sneak into the name
        let n = a.file_name().unwrap().to_str().unwrap();
        assert!(!n.contains('/'), "{n}");
        assert_ne!(origin_file("http://a-b:1"), origin_file("http://a_b:1"));
    }

    #[test]
    fn a_refused_url_has_no_cookie_slot() {
        assert!(cookie_path_for("http://ship.example.com").is_none());
    }

    #[test]
    fn the_ship_comes_from_the_cookie_name() {
        assert_eq!(ship_of("urbauth-~zod=0v1.abc").as_deref(), Some("~zod"));
        assert_eq!(ship_of("session=1"), None);
        assert_eq!(ship_of("urbauth-=1"), None);
        assert_eq!(ship_of("urbauth-~zod="), None, "empty value must be refused");
        assert_eq!(ship_of("urbauth-~zod"), None, "missing '=' must be refused");
        assert_eq!(ship_of("urbauth-notaship=0v1"), None, "non-@p must be refused");
        assert_eq!(ship_of("urbauth-~../evil=0v1"), None, "path chars must be refused");
    }

    #[test]
    fn login_scans_all_set_cookie_headers_for_valid_urbauth() {
        let headers = [
            "cf_clearance=abc; Path=/; HttpOnly",
            "urbauth-~zod=; Max-Age=0; Path=/",
            "urbauth-bad=123; Path=/",
            "urbauth-~sampel-palnet=0v1.xyz; Path=/; HttpOnly",
        ];
        assert_eq!(
            urbauth_from_headers(headers).as_deref(),
            Some("urbauth-~sampel-palnet=0v1.xyz")
        );
        assert_eq!(urbauth_from_headers(["session=1", "urbauth-~zod=; Max-Age=0"]), None);
    }

    #[test]
    fn concurrent_write_private_calls_do_not_collide() {
        let dir = std::env::temp_dir().join(format!("lattice-session-conc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("shared");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let p = path.clone();
                let b = barrier.clone();
                std::thread::spawn(move || {
                    b.wait();
                    for j in 0..20 {
                        write_private(&p, format!("t{i}-{j}").as_bytes()).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert!(path.exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no leftover tmp files");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cookie_is_written_owner_only_and_replaced_whole() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("lattice-session-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("sub").join("cookie-x");
        write_private(&p, b"urbauth-~zod=1").unwrap();
        write_private(&p, b"urbauth-~zod=2").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "urbauth-~zod=2");
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(
            std::fs::metadata(p.parent().unwrap()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        // no temp file left behind
        assert_eq!(std::fs::read_dir(p.parent().unwrap()).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_code_is_form_encoded() {
        assert_eq!(urlencode("lidlut-tabwed"), "lidlut-tabwed");
        assert_eq!(urlencode("a&b=c d"), "a%26b%3Dc%20d");
    }
}
