//! Moving the anonymous identity (the reader's comet, engine.rs) to
//! another computer: an identity file, sealed with a passphrase the user
//! picks, that a fresh install imports to run as the same @p.
//!
//! What a comet needs to resume elsewhere: its keyfile (`comet.key`: the
//! ship, its life and rift, and its secret keys) and its store (`<name>.db`
//! and its WAL, libmesa's SQLite rows). The keyfile alone would open, since
//! libmesa lets a comet start from an empty store, but every flow to a
//! publisher would start again at message 1, and a publisher that has heard
//! from the comet before acks those numbers as duplicates and drops them:
//! comments would report success and never arrive. The store carries the
//! flows' sequence numbers on, so the file holds both. A comet's
//! attestation is not kept anywhere to move: a peer asks the comet itself
//! for it (`+peek-pawn`), and libmesa signs it with the keys in the keyfile,
//! so the imported comet attests as it did before. Its sponsor (the star it
//! was mined under, and that star's galaxy) is fixed by its name.
//!
//! The file, all integers big-endian:
//!
//! ```text
//! magic  "LATCOMET"   8 bytes
//! version            1 byte   (1)
//! kdf                1 byte   (1: PBKDF2-HMAC-SHA256)
//! iterations         4 bytes
//! salt              16 bytes
//! nonce             12 bytes
//! sealed            the rest: ChaCha20-Poly1305 of the payload, with
//!                   every byte above as associated data
//! ```
//!
//! The payload is a 4-byte length, that many bytes of JSON (`Meta`), the
//! store's bytes and then the WAL's. Both primitives come from ring, which
//! rustls already brings into the tree, so the file costs no new crate.
//! The header is authenticated, so a version or iteration count changed by
//! hand fails as a damaged file does.

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

pub const MAGIC: &[u8; 8] = b"LATCOMET";
/// The file format this build writes and reads.
pub const VERSION: u8 = 1;
const KDF_PBKDF2_SHA256: u8 = 1;
/// OWASP's 2023 figure for PBKDF2-HMAC-SHA256.
pub const ITERATIONS: u32 = 600_000;
/// Fewer is refused on read, so a file cannot be made to skip the work.
const MIN_ITERATIONS: u32 = 100_000;
/// More is refused on read, so a hostile file cannot hang the app.
const MAX_ITERATIONS: u32 = 10_000_000;
pub const MIN_PASSPHRASE: usize = 8;
const SALT_LEN: usize = 16;
const HEADER_LEN: usize = 8 + 1 + 1 + 4 + SALT_LEN + NONCE_LEN;
/// A file larger than this is not read.
pub const MAX_FILE: u64 = 512 * 1024 * 1024;
/// The extension the save dialog offers.
pub const EXTENSION: &str = "latticeid";
/// Beside an identity that was exported: when, in unix seconds. The
/// settings card warns from it that the identity may now run elsewhere.
pub const EXPORTED: &str = "exported";

/// An identity, as the file carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    /// `~name`
    pub ship: String,
    /// the keyfile's text, trimmed
    pub keyfile: String,
    /// `<name>.db`
    pub db: Vec<u8>,
    /// `<name>.db-wal`, empty when there is none
    pub wal: Vec<u8>,
    /// unix seconds
    pub exported: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Meta {
    ship: String,
    keyfile: String,
    db_len: u64,
    wal_len: u64,
    exported: u64,
}

/// Why a file did not open, in words for the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    NotIdentity,
    Newer(u8),
    Damaged,
    /// AEAD cannot tell a wrong passphrase from a damaged sealed part
    WrongPassphrase,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::NotIdentity => write!(f, "That file isn't a lattice identity file."),
            OpenError::Newer(v) => write!(
                f,
                "That identity file is format {v}, newer than this lattice reads (format {VERSION}). Update lattice and try again."
            ),
            OpenError::Damaged => write!(f, "That identity file is damaged."),
            OpenError::WrongPassphrase => {
                write!(f, "Wrong passphrase, or the identity file is damaged. Nothing changed.")
            }
        }
    }
}

fn key_of(pass: &str, salt: &[u8], iterations: u32) -> LessSafeKey {
    let mut k = [0u8; 32];
    let n = NonZeroU32::new(iterations).expect("iterations checked above zero");
    ring::pbkdf2::derive(ring::pbkdf2::PBKDF2_HMAC_SHA256, n, salt, pass.as_bytes(), &mut k);
    let key = LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, &k).expect("32-byte key"));
    k.fill(0);
    key
}

/// The identity, sealed with `pass`.
pub fn seal(id: &Identity, pass: &str) -> Result<Vec<u8>, String> {
    seal_with(id, pass, ITERATIONS)
}

fn seal_with(id: &Identity, pass: &str, iterations: u32) -> Result<Vec<u8>, String> {
    if pass.chars().count() < MIN_PASSPHRASE {
        return Err(format!("Pick a passphrase of at least {MIN_PASSPHRASE} characters."));
    }
    let rng = SystemRandom::new();
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut salt).map_err(|_| "no randomness from the system")?;
    rng.fill(&mut nonce).map_err(|_| "no randomness from the system")?;
    let mut out = Vec::with_capacity(HEADER_LEN + id.db.len() + id.wal.len() + 1024);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.push(KDF_PBKDF2_SHA256);
    out.extend_from_slice(&iterations.to_be_bytes());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    let meta = serde_json::to_vec(&Meta {
        ship: id.ship.clone(),
        keyfile: id.keyfile.clone(),
        db_len: id.db.len() as u64,
        wal_len: id.wal.len() as u64,
        exported: id.exported,
    })
    .map_err(|e| e.to_string())?;
    let mut body = Vec::with_capacity(4 + meta.len() + id.db.len() + id.wal.len() + 16);
    body.extend_from_slice(&(meta.len() as u32).to_be_bytes());
    body.extend_from_slice(&meta);
    body.extend_from_slice(&id.db);
    body.extend_from_slice(&id.wal);
    key_of(pass, &salt, iterations)
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(&out[..HEADER_LEN]), &mut body)
        .map_err(|_| "sealing failed")?;
    out.extend_from_slice(&body);
    Ok(out)
}

/// The identity in `file`, unsealed with `pass`.
pub fn open(file: &[u8], pass: &str) -> Result<Identity, OpenError> {
    if file.len() < 10 || &file[..8] != MAGIC {
        return Err(OpenError::NotIdentity);
    }
    if file[8] != VERSION {
        return Err(if file[8] > VERSION { OpenError::Newer(file[8]) } else { OpenError::Damaged });
    }
    if file.len() < HEADER_LEN + 16 || file[9] != KDF_PBKDF2_SHA256 {
        return Err(OpenError::Damaged);
    }
    let iterations = u32::from_be_bytes(file[10..14].try_into().expect("4 bytes"));
    if !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&iterations) {
        return Err(OpenError::Damaged);
    }
    let salt = &file[14..14 + SALT_LEN];
    let nonce: [u8; NONCE_LEN] = file[14 + SALT_LEN..HEADER_LEN].try_into().expect("nonce");
    let mut body = file[HEADER_LEN..].to_vec();
    let plain = key_of(pass, salt, iterations)
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(&file[..HEADER_LEN]), &mut body)
        .map_err(|_| OpenError::WrongPassphrase)?;
    // authenticated from here: what fails below was sealed that way
    if plain.len() < 4 {
        return Err(OpenError::Damaged);
    }
    let n = u32::from_be_bytes(plain[..4].try_into().expect("4 bytes")) as usize;
    let rest = &plain[4..];
    if n > rest.len() {
        return Err(OpenError::Damaged);
    }
    let meta: Meta = serde_json::from_slice(&rest[..n]).map_err(|_| OpenError::Damaged)?;
    let rest = &rest[n..];
    let (db_len, wal_len) = (meta.db_len as usize, meta.wal_len as usize);
    if db_len.checked_add(wal_len) != Some(rest.len()) || !meta.ship.starts_with('~') || meta.keyfile.is_empty() {
        return Err(OpenError::Damaged);
    }
    Ok(Identity {
        ship: meta.ship,
        keyfile: meta.keyfile,
        db: rest[..db_len].to_vec(),
        wal: rest[db_len..].to_vec(),
        exported: meta.exported,
    })
}

/// The store's file base for `ship`, as urb_gateway::state names it.
fn base(ship: &str) -> &str {
    ship.trim_start_matches('~')
}

/// The identity in the engine's state folder `dir`, which must not be in
/// use (the engine closed). `ship_of` names the keyfile's ship, or `None`
/// when it is not a keyfile.
pub fn read_dir(dir: &Path, ship_of: impl Fn(&str) -> Option<String>) -> Result<Identity, String> {
    let key = dir.join("comet.key");
    let text = match std::fs::read_to_string(&key) {
        Ok(t) => t.trim().to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("There is no anonymous identity on this computer yet. Use lattice anonymously once to make one.".into())
        }
        Err(e) => return Err(format!("{}: {e}", key.display())),
    };
    let ship = ship_of(&text).ok_or("The anonymous identity's keyfile is damaged.")?;
    let read = |suffix: &str, need: bool| -> Result<Vec<u8>, String> {
        let p = dir.join(format!("{}{suffix}", base(&ship)));
        match std::fs::read(&p) {
            Ok(b) => Ok(b),
            Err(e) if !need && e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(format!("{}: {e}", p.display())),
        }
    };
    let db = read(".db", true)?;
    let wal = read(".db-wal", false)?;
    Ok(Identity { ship, keyfile: text, db, wal, exported: now() })
}

/// Make `id` the identity in `dir` (the engine closed). Whatever identity
/// was there is moved, never deleted, into `replaced-<ms>/`, which is
/// returned when there was one. The reading history stays.
pub fn install(dir: &Path, id: &Identity) -> Result<Option<PathBuf>, String> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let names: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_identity_file(n))
        .collect();
    let aside = if names.is_empty() {
        None
    } else {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let a = dir.join(format!("replaced-{stamp}"));
        std::fs::DirBuilder::new().mode(0o700).create(&a).map_err(|e| format!("{}: {e}", a.display()))?;
        for n in &names {
            std::fs::rename(dir.join(n), a.join(n)).map_err(|e| format!("{n}: {e}"))?;
        }
        Some(a)
    };
    let b = base(&id.ship);
    // the store first and the keyfile last: a crash part way leaves no
    // keyfile, so the next start mines a new comet rather than open this
    // one on half a store
    crate::session::write_private(&dir.join(format!("{b}.db")), &id.db)?;
    if !id.wal.is_empty() {
        crate::session::write_private(&dir.join(format!("{b}.db-wal")), &id.wal)?;
    }
    crate::session::write_private(&dir.join("comet.key"), format!("{}\n", id.keyfile).as_bytes())?;
    Ok(aside)
}

/// One of an identity's own files: its keyfile, its store, the store's
/// SQLite side files, its kept port, and the markers beside it.
fn is_identity_file(n: &str) -> bool {
    n == "comet.key"
        || n == "unclaimed"
        || n == EXPORTED
        || [".db", ".db-wal", ".db-shm", ".db-journal", ".db.lock", ".db.port"].iter().any(|x| n.ends_with(x))
}

/// When the identity in `dir` was last exported, if it was.
pub fn exported_at(dir: &Path) -> Option<u64> {
    std::fs::read_to_string(dir.join(EXPORTED)).ok()?.trim().parse().ok()
}

/// Note that the identity in `dir` was exported now.
pub fn mark_exported(dir: &Path) -> Result<(), String> {
    crate::session::write_private(&dir.join(EXPORTED), format!("{}\n", now()).as_bytes())
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// fast for tests; the floor on read is MIN_ITERATIONS
    const T: u32 = MIN_ITERATIONS;

    fn id() -> Identity {
        Identity {
            ship: "~dalnel-ralnyd-lagbyr-libsep--dozmer-dacnyx-dirzod-macpet".into(),
            keyfile: "0w1.abcd".into(),
            db: (0..5000u32).map(|i| (i * 7) as u8).collect(),
            wal: b"wal bytes".to_vec(),
            exported: 1_762_300_000,
        }
    }

    #[test]
    fn round_trip() {
        let f = seal_with(&id(), "correct horse", T).unwrap();
        assert_eq!(&f[..8], MAGIC);
        assert_eq!(f[8], VERSION);
        assert_eq!(open(&f, "correct horse").unwrap(), id());
        let mut no_wal = id();
        no_wal.wal.clear();
        assert_eq!(open(&seal_with(&no_wal, "correct horse", T).unwrap(), "correct horse").unwrap(), no_wal);
    }

    #[test]
    fn the_key_material_is_not_in_the_clear() {
        let f = seal_with(&id(), "correct horse", T).unwrap();
        assert!(!f.windows(8).any(|w| w == b"0w1.abcd"));
        assert!(!f.windows(6).any(|w| w == b"dalnel"));
    }

    #[test]
    fn two_seals_differ() {
        assert_ne!(seal_with(&id(), "correct horse", T).unwrap(), seal_with(&id(), "correct horse", T).unwrap());
    }

    #[test]
    fn exports_use_at_least_the_owasp_count_in_the_header() {
        assert!(ITERATIONS >= 600_000);
        let f = seal(&id(), "correct horse").unwrap();
        assert_eq!(u32::from_be_bytes(f[10..14].try_into().unwrap()), ITERATIONS);
    }

    #[test]
    fn a_file_with_a_higher_count_still_opens() {
        let f = seal_with(&id(), "correct horse", ITERATIONS * 2).unwrap();
        assert_eq!(u32::from_be_bytes(f[10..14].try_into().unwrap()), ITERATIONS * 2);
        assert_eq!(open(&f, "correct horse").unwrap(), id());
    }

    #[test]
    fn a_wrong_passphrase_is_refused() {
        let f = seal_with(&id(), "correct horse", T).unwrap();
        assert_eq!(open(&f, "correct hors"), Err(OpenError::WrongPassphrase));
        assert_eq!(open(&f, ""), Err(OpenError::WrongPassphrase));
    }

    #[test]
    fn a_short_passphrase_is_refused_on_export() {
        assert!(seal_with(&id(), "short", T).is_err());
    }

    #[test]
    fn a_corrupt_file_is_refused() {
        let f = seal_with(&id(), "correct horse", T).unwrap();
        // any flipped byte in the sealed part, or a cut
        for i in [HEADER_LEN, HEADER_LEN + 40, f.len() - 1] {
            let mut g = f.clone();
            g[i] ^= 1;
            assert_eq!(open(&g, "correct horse"), Err(OpenError::WrongPassphrase), "byte {i}");
        }
        assert_eq!(open(&f[..f.len() - 3], "correct horse"), Err(OpenError::WrongPassphrase));
        assert_eq!(open(&f[..HEADER_LEN], "correct horse"), Err(OpenError::Damaged));
        // the header is authenticated: salt and nonce changes fail too
        let mut g = f.clone();
        g[20] ^= 1;
        assert_eq!(open(&g, "correct horse"), Err(OpenError::WrongPassphrase));
        // a changed iteration count, within bounds, fails; out of bounds is damage
        let mut g = f.clone();
        g[13] ^= 1;
        assert_eq!(open(&g, "correct horse"), Err(OpenError::WrongPassphrase));
        let mut g = f.clone();
        g[10..14].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(open(&g, "correct horse"), Err(OpenError::Damaged));
        let mut g = f.clone();
        g[9] = 7;
        assert_eq!(open(&g, "correct horse"), Err(OpenError::Damaged));
    }

    #[test]
    fn other_files_are_not_identity_files() {
        assert_eq!(open(b"", "x"), Err(OpenError::NotIdentity));
        assert_eq!(open(b"PK\x03\x04 a zip, say", "x"), Err(OpenError::NotIdentity));
        assert_eq!(open(b"LATCOMET", "x"), Err(OpenError::NotIdentity));
    }

    #[test]
    fn the_version_field_is_checked() {
        let f = seal_with(&id(), "correct horse", T).unwrap();
        let mut g = f.clone();
        g[8] = VERSION + 1;
        assert_eq!(open(&g, "correct horse"), Err(OpenError::Newer(VERSION + 1)));
        assert!(OpenError::Newer(2).to_string().contains("Update lattice"));
        g[8] = 0;
        assert_eq!(open(&g, "correct horse"), Err(OpenError::Damaged));
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lattice-{tag}-{}-{}", std::process::id(), now_nanos()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn now_nanos() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    fn ship_of(t: &str) -> Option<String> {
        (t == "0w1.abcd").then(|| id().ship)
    }

    #[test]
    fn read_and_install_move_an_identity_between_folders() {
        let a = tmpdir("cometid-a");
        let b = tmpdir("cometid-b");
        assert!(read_dir(&a, ship_of).unwrap_err().contains("no anonymous identity"));
        let i = id();
        assert_eq!(install(&a, &i).unwrap(), None);
        let got = read_dir(&a, ship_of).unwrap();
        assert_eq!((got.ship.as_str(), got.keyfile.as_str(), &got.db, &got.wal), (i.ship.as_str(), i.keyfile.as_str(), &i.db, &i.wal));
        // b has its own comet, its port, an unclaimed marker and history
        let old = "~sampel-palnet";
        for (n, body) in [("comet.key", "0wold\n"), ("sampel-palnet.db", "old"), ("sampel-palnet.db.port", "4000\n"), ("unclaimed", ""), ("history.json", "[]")] {
            std::fs::write(b.join(n), body).unwrap();
        }
        let file = seal_with(&got, "correct horse", T).unwrap();
        let aside = install(&b, &open(&file, "correct horse").unwrap()).unwrap().expect("set aside");
        assert_eq!(std::fs::read_to_string(aside.join("comet.key")).unwrap(), "0wold\n");
        assert!(aside.join(format!("{}.db", old.trim_start_matches('~'))).exists());
        assert!(aside.join("unclaimed").exists() && !b.join("unclaimed").exists());
        assert!(b.join("history.json").exists(), "history stays");
        assert_eq!(read_dir(&b, ship_of).unwrap().db, i.db);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(b.join("comet.key")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn the_export_mark_reads_back() {
        let a = tmpdir("cometid-mark");
        assert_eq!(exported_at(&a), None);
        mark_exported(&a).unwrap();
        assert!(exported_at(&a).unwrap() >= now() - 5);
    }
}
