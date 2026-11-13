//! Map tiles from the desktop itself. A map page asks for
//! /apps/lattice/tile/<style>/<z>/<x>/<y>. In a browser the ship passes
//! each one through from Mapbox, and that costs the ship time. Here the
//! bridge answers it instead, from Mapbox, with a token this computer
//! holds, so the ship never sees a tile request from the desktop app.
//!
//! The same rules as the ship's route (+tile-at in app.hoon): the style is
//! one of four names mapped here to a Mapbox style id, and z, x and y are
//! numbers checked against each other (x and y below 2^z, z at most 17).
//! The URL is built from MAPBOX and those alone, so a request cannot make
//! this app fetch anything else. The answer says private for 30 days, as
//! the ship's does, so the webview's service worker keeps it the same way.
//! Nothing is kept on disk here: this is the device that asked for the
//! tile, and its worker cache is the one Mapbox's terms allow.
//!
//! The token is this computer's, set in Settings (Map tiles) and kept in a
//! 0600 file beside the session cookies. No command returns it, and it is
//! never logged. Without one, a tile request goes to the ship as before.

use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;

/// Mapbox's styles API. A test build points it at a stub (`set_base`).
const MAPBOX: &str = "https://api.mapbox.com/styles/v1/";
/// The zoom ceiling, as the ship's +tile-max-z.
pub const MAX_Z: u32 = 17;
/// The styles a map may ask for, and their Mapbox ids, as +tile-styles.
const STYLES: &[(&str, &str)] = &[
    ("streets", "mapbox/streets-v12"),
    ("outdoors", "mapbox/outdoors-v12"),
    ("satellite", "mapbox/satellite-streets-v12"),
    ("dark", "mapbox/dark-v11"),
];
const PREFIX: &str = "/apps/lattice/tile/";

#[cfg(test)]
static TEST_BASE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
#[cfg(test)]
static TEST_TOKEN_FILE: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Point the tile fetches at a stub server. Tests only.
#[cfg(test)]
pub fn set_base(b: Option<String>) {
    *TEST_BASE.lock().unwrap() = b;
}
/// Keep the token in this file instead of the real one. Tests only.
#[cfg(test)]
pub fn set_token_file(p: Option<PathBuf>) {
    *TEST_TOKEN_FILE.lock().unwrap() = p;
}

fn base() -> String {
    #[cfg(test)]
    if let Some(b) = TEST_BASE.lock().unwrap().clone() {
        return b;
    }
    MAPBOX.to_string()
}

fn token_file() -> PathBuf {
    #[cfg(test)]
    if let Some(p) = TEST_TOKEN_FILE.lock().unwrap().clone() {
        return p;
    }
    crate::session::secret_dir().join("mapbox-token")
}

/// A token's shape: up to 512 bytes of letters, digits and . _ -, as the
/// ship's +token-ok.
pub fn token_ok(t: &str) -> bool {
    !t.is_empty() && t.len() <= 512 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// The token, read fresh each time, so a change applies at once.
pub fn token() -> Option<String> {
    let t = std::fs::read_to_string(token_file()).ok()?;
    let t = t.trim().to_string();
    token_ok(&t).then_some(t)
}

/// Set the token, or clear it with an empty one.
pub fn set_token(t: &str) -> Result<(), String> {
    let t = t.trim();
    let f = token_file();
    if t.is_empty() {
        return match std::fs::remove_file(&f) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    if !token_ok(t) {
        return Err("that does not look like a Mapbox token".into());
    }
    crate::session::write_private(&f, t.as_bytes())
}

/// Is `target` a tile request? Then [style id, z, x, y], or None when it
/// names no tile. A query (the ?r= of "Refresh this area") is ignored.
pub fn is_tile(target: &str) -> bool {
    target.starts_with(PREFIX)
}

pub fn tile_at(target: &str) -> Option<(&'static str, u32, u32, u32)> {
    let path = target.strip_prefix(PREFIX)?.split(['?', '#']).next()?;
    let p: Vec<&str> = path.split('/').collect();
    let [style, z, x, y] = p.as_slice() else { return None };
    let sid = STYLES.iter().find(|(n, _)| n == style)?.1;
    let num = |s: &str| -> Option<u32> {
        (!s.is_empty() && s.len() <= 7 && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
    };
    let (z, x, y) = (num(z)?, num(x)?, num(y)?);
    if z > MAX_Z || x >= 1 << z || y >= 1 << z {
        return None;
    }
    Some((sid, z, x, y))
}

/// The agent for Mapbox: its own pool, and timeouts, since nothing here
/// streams.
fn agent() -> &'static ureq::Agent {
    static A: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    A.get_or_init(|| {
        ureq::AgentBuilder::new()
            .redirects(0)
            .max_idle_connections_per_host(6)
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
    })
}

fn answer(c: &mut TcpStream, status: &str, ctype: &str, cache: &str, body: &[u8]) -> std::io::Result<()> {
    write!(
        c,
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nCache-Control: {cache}\r\n\
         X-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    c.write_all(body)
}

/// Answer one tile request with this token. Only a GET for a tile path
/// comes here (proxy.rs).
pub fn serve(c: &mut TcpStream, target: &str, token: &str) -> std::io::Result<()> {
    let Some((sid, z, x, y)) = tile_at(target) else {
        return answer(c, "404 Not Found", "text/plain", "no-store", b"no such tile");
    };
    let url = format!("{}{sid}/tiles/512/{z}/{x}/{y}?access_token={token}", base());
    let fail = |c: &mut TcpStream, why: &str| answer(c, "502 Bad Gateway", "text/plain", "no-store", why.as_bytes());
    let resp = match agent().get(&url).set("User-Agent", "lattice-maps").call() {
        Ok(r) => r,
        Err(ureq::Error::Status(404, _)) => return answer(c, "404 Not Found", "text/plain", "no-store", b"no such tile"),
        Err(ureq::Error::Status(401 | 403, _)) => return fail(c, "Mapbox refused this computer's token"),
        Err(ureq::Error::Status(_, _)) => return fail(c, "the tile server failed"),
        Err(_) => return fail(c, "the tile server could not be reached"),
    };
    let ct = resp.content_type().to_ascii_lowercase();
    if !ct.starts_with("image/") {
        return fail(c, "the tile server sent no image");
    }
    let ctype = if ct.starts_with("image/jpeg") { "image/jpeg" } else if ct.starts_with("image/webp") { "image/webp" } else { "image/png" };
    let mut body = Vec::new();
    use std::io::Read;
    if resp.into_reader().take(8 << 20).read_to_end(&mut body).is_err() {
        return fail(c, "the tile fetch did not complete");
    }
    // none of Mapbox's own headers come through
    answer(c, "200 OK", ctype, "private, max-age=2592000", &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tile_path_is_a_fixed_style_and_numbers_in_range() {
        assert_eq!(tile_at("/apps/lattice/tile/streets/0/0/0"), Some(("mapbox/streets-v12", 0, 0, 0)));
        assert_eq!(tile_at("/apps/lattice/tile/dark/17/131071/5?r=99"), Some(("mapbox/dark-v11", 17, 131071, 5)));
        assert_eq!(tile_at("/apps/lattice/tile/satellite/1/1/1"), Some(("mapbox/satellite-streets-v12", 1, 1, 1)));
        for bad in [
            "/apps/lattice/tile/streets/1/2/0", "/apps/lattice/tile/streets/1/0/2",
            "/apps/lattice/tile/streets/18/0/0", "/apps/lattice/tile/streets/17/131072/0",
            "/apps/lattice/tile/nope/1/0/0", "/apps/lattice/tile/Streets/1/0/0",
            "/apps/lattice/tile/streets/a/0/0", "/apps/lattice/tile/streets/-1/0/0",
            "/apps/lattice/tile/streets/1/0", "/apps/lattice/tile/streets/1/0/0/0",
            "/apps/lattice/tile/streets/1/0/0.png", "/apps/lattice/tile/streets/%31/0/0",
            "/apps/lattice/tile/streets/99999999/0/0", "/apps/lattice/tile/../1/0/0",
            "/apps/lattice/tile/http:%2f%2fevil.example/1/0/0", "/apps/lattice/tile/streets//0/0",
        ] {
            assert_eq!(tile_at(bad), None, "{bad} names no tile");
        }
    }

    #[test]
    fn a_token_has_a_tokens_shape() {
        assert!(token_ok("pk.eyJ1IjoibWUifQ.abc_DEF-123"));
        assert!(!token_ok(""));
        assert!(!token_ok("pk.a b"));
        assert!(!token_ok("pk.a\"&x=1"));
        assert!(!token_ok(&"a".repeat(513)));
    }
}
