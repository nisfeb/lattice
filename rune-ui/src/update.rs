//! The app updates itself, as the desktop app does (`desktop/src/update.rs`):
//! it asks at startup and every few hours whether a newer release is out,
//! offers it with its notes, fetches it, checks its signature, puts it in
//! the place of the copy that is running, and starts again.
//!
//! What it reads is `latest-rune.json` on the newest published release,
//! which `release.yml` writes. The file it points at is signed with
//! minisign, by the key the desktop app's updates are signed with, and one
//! whose signature does not hold against the public key below is thrown
//! away. A release asset that was changed, or a download that was led
//! elsewhere, cannot install itself.
//!
//! Only an AppImage takes its own place. A deb belongs to the package
//! manager, and a program run from a folder may not be this user's to
//! write, so those are shown the release page.
//!
//! No answer from GitHub is nothing anyone needs to hear: the check is
//! made again next time.

use std::path::{Path, PathBuf};

/// Asked first this long after the window is up, in seconds.
pub const FIRST_CHECK: f64 = 20.0;
/// And then this often: the desktop app's own pace.
pub const PERIOD: f64 = 6.0 * 60.0 * 60.0;
pub const ENDPOINT: &str = "https://github.com/nisfeb/lattice/releases/latest/download/latest-rune.json";
pub const RELEASES_PAGE: &str = "https://github.com/nisfeb/lattice/releases/latest";
/// Where a file to install may come from. The manifest is not signed, only
/// the file is, so this is a second fence and not the first.
const DOWNLOADS: &str = "https://github.com/nisfeb/lattice/releases/download/";
/// The public half of the key the releases are signed with: the one in
/// `desktop/tauri.conf.json`, base64 of a minisign public key file.
pub const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ5QUNGREJEMDVDMjFBMjIKUldRaUdzSUZ2ZjJzU2NacDZmTEtkTVQzeFFkdXlTaUhQZEVFT3pYTlIya2VZakM2eGwzOVlHU3gK";
/// Notes past this many lines are cut: a banner is no place to read a log.
const NOTE_LINES: usize = 6;
/// No release file is near this size. More is not kept.
const MOST: u64 = 400 << 20;

/// This build's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How this copy can take an update.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Flavor {
    /// The AppImage at this path is swapped for the new one.
    AppImage(PathBuf),
    /// Put in by a package manager, or run from a folder: the release page is shown.
    ReleasePage,
}

/// From the program's own surroundings: the AppImage runtime sets
/// `APPIMAGE` to the file it was started from.
pub fn flavor(appimage: Option<&str>) -> Flavor {
    match appimage {
        Some(p) if !p.is_empty() => Flavor::AppImage(PathBuf::from(p)),
        _ => Flavor::ReleasePage,
    }
}

/// The name a release goes by in the manifest for this machine.
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        o => o,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// A version's numbers, then whether it is a pre-release, which comes
/// before the release of the same numbers. What follows a `+` is not read.
fn version_key(v: &str) -> Option<([u64; 3], bool)> {
    let v = v.trim().trim_start_matches('v');
    let v = v.split('+').next()?;
    let (nums, pre) = match v.split_once('-') {
        Some((n, p)) => (n, !p.is_empty()),
        None => (v, false),
    };
    let mut it = nums.split('.').map(|p| p.parse::<u64>().ok());
    let key = [it.next()??, it.next()??, it.next()??];
    if it.next().is_some() {
        return None;
    }
    Some((key, pre))
}

/// Whether `remote` comes after `current`. The manifest's version is not
/// signed, so one that names an older or the same version, or none that
/// can be read, is never offered.
pub fn newer(remote: &str, current: &str) -> bool {
    match (version_key(remote), version_key(current)) {
        (Some((r, rp)), Some((c, cp))) => r > c || (r == c && !rp && cp),
        _ => false,
    }
}

/// A newer release, and the file of it this copy can install, if there is one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub version: String,
    pub notes: String,
    /// Where the file is and its signature. None when this copy cannot take its own place.
    pub file: Option<(String, String)>,
}

/// Reads a manifest. None when what it names is not newer than `current`.
/// `anywhere` lets the file be fetched from any address, for a test.
pub fn offer(manifest: &str, current: &str, flavor: &Flavor, platform: &str, anywhere: bool) -> Result<Option<Offer>, String> {
    let v: serde_json::Value = serde_json::from_str(manifest).map_err(|e| format!("the update list could not be read: {e}"))?;
    let version = v["version"].as_str().unwrap_or_default().trim().trim_start_matches('v').to_owned();
    if !newer(&version, current) {
        return Ok(None);
    }
    let file = match flavor {
        Flavor::AppImage(_) => {
            let p = &v["platforms"][format!("{platform}-appimage")];
            match (p["url"].as_str(), p["signature"].as_str()) {
                (Some(url), Some(sig)) if anywhere || url.starts_with(DOWNLOADS) => Some((url.to_owned(), sig.to_owned())),
                _ => None,
            }
        }
        Flavor::ReleasePage => None,
    };
    Ok(Some(Offer { version, notes: v["notes"].as_str().unwrap_or_default().trim().to_owned(), file }))
}

/// What the offer says: what is new, what is here, then the notes, cut short.
pub fn offer_text(o: &Offer, current: &str) -> String {
    let mut s = format!("lattice-rune {} is available. You have {current}.", o.version);
    let lines: Vec<&str> = o.notes.lines().filter(|l| !l.trim().is_empty()).collect();
    if !lines.is_empty() {
        s.push('\n');
        s.push_str(&lines[..lines.len().min(NOTE_LINES)].join("\n"));
        if lines.len() > NOTE_LINES {
            s.push_str("\n\u{2026}");
        }
    }
    if o.file.is_none() {
        s.push_str("\nThis copy cannot put the new one in its own place, so it is installed from the release page.");
    }
    s
}

fn unbase64(what: &str, s: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|e| format!("{what} is not base64: {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{what} is not text"))
}

/// Whether `bytes` are what `signature` was made over, by the holder of
/// `pubkey`. Both are as Tauri writes them: base64 of minisign's own text.
pub fn verify(bytes: &[u8], signature: &str, pubkey: &str) -> Result<(), String> {
    let key = minisign_verify::PublicKey::decode(&unbase64("the key", pubkey)?).map_err(|e| format!("the key could not be read: {e}"))?;
    let sig = minisign_verify::Signature::decode(&unbase64("the signature", signature)?).map_err(|e| format!("the signature could not be read: {e}"))?;
    key.verify(bytes, &sig, true).map_err(|e| format!("the signature does not hold: {e}"))
}

/// Asks whether a newer release is out.
#[cfg(not(target_arch = "wasm32"))]
pub fn check(endpoint: &str, flavor: &Flavor, anywhere: bool) -> Result<Option<Offer>, String> {
    use std::io::Read;
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(30)).build();
    let res = agent.get(endpoint).call().map_err(|e| e.to_string())?;
    let mut text = String::new();
    res.into_reader().take(1 << 20).read_to_string(&mut text).map_err(|e| e.to_string())?;
    offer(&text, VERSION, flavor, &platform(), anywhere)
}

/// Fetches the offered file and checks its signature. `seen` is told how
/// far along it is, in hundredths. Nothing is written anywhere.
#[cfg(not(target_arch = "wasm32"))]
pub fn fetch(url: &str, signature: &str, pubkey: &str, seen: &dyn Fn(u8)) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let agent = ureq::AgentBuilder::new().timeout_connect(std::time::Duration::from_secs(30)).timeout_read(std::time::Duration::from_secs(60)).build();
    let res = agent.get(url).call().map_err(|e| e.to_string())?;
    let total = res.header("content-length").and_then(|l| l.parse::<u64>().ok()).filter(|t| *t > 0);
    if total.is_some_and(|t| t > MOST) {
        return Err("the file is larger than any release".into());
    }
    let mut reader = res.into_reader().take(MOST + 1);
    let (mut bytes, mut buf) = (Vec::with_capacity(total.unwrap_or(0) as usize), vec![0u8; 1 << 16]);
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        if let Some(t) = total {
            seen(((bytes.len() as u64 * 100) / t).min(99) as u8);
        }
    }
    if bytes.len() as u64 > MOST {
        return Err("the file is larger than any release".into());
    }
    if total.is_some_and(|t| t != bytes.len() as u64) {
        return Err("the download stopped short".into());
    }
    seen(100);
    verify(&bytes, signature, pubkey)?;
    Ok(bytes)
}

/// Puts the new AppImage in the old one's place: written beside it, made
/// runnable, then moved over it in one step, so there is never half a file
/// under the name. The copy that is running keeps running from the old one.
#[cfg(not(target_arch = "wasm32"))]
pub fn install(at: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = at.parent().ok_or("the AppImage has no folder")?;
    let name = at.file_name().and_then(|n| n.to_str()).ok_or("the AppImage has no name")?;
    let new = dir.join(format!(".{name}.new"));
    let put = || -> std::io::Result<()> {
        std::fs::write(&new, bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // as runnable as the one it replaces
            let mode = std::fs::metadata(at).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o755) | 0o100;
            std::fs::set_permissions(&new, std::fs::Permissions::from_mode(mode))?;
        }
        std::fs::rename(&new, at)
    };
    put().map_err(|e| {
        let _ = std::fs::remove_file(&new);
        format!("could not write {}: {e}", at.display())
    })
}

#[cfg(unix)]
unsafe extern "C" {
    // the C library std already links, declared here to save a dependency
    fn close(fd: i32) -> i32;
}

/// Starts `target` once this process is gone, and answers at once. The
/// waiter does not stand in this process's folder or hold what it has
/// open: inside an AppImage both belong to the old image's mount, and a
/// waiter that kept them would keep the old image mounted under the new app.
#[cfg(unix)]
pub fn restart_after_exit(target: &Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    let cwd = std::env::var_os("OWD").map(PathBuf::from).filter(|d| d.is_dir()).unwrap_or_else(|| PathBuf::from("/"));
    let mut cmd = std::process::Command::new("sh");
    // SAFETY: only close(2) runs between fork and exec, and close is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            for fd in 3..1024 {
                close(fd);
            }
            Ok(())
        });
    }
    cmd.current_dir(cwd)
        .arg("-c")
        .arg("while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec \"$2\"")
        .arg("lattice-rune-update-waiter")
        .arg(std::process::id().to_string())
        .arg(target)
        // the new copy is the real one: the old one's marks of being an AppImage would mislead it
        .env_remove("APPIMAGE")
        .env_remove("APPDIR")
        .env_remove("ARGV0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
}

#[cfg(not(unix))]
pub fn restart_after_exit(_: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("no AppImage here"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // a key made for this test alone, and a file signed with it by `tauri signer sign`
    const TEST_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEM3NEVDOTQyRkM2RkJCQkYKUldTL3UyLzhRc2xPeCtQOEpycjBmT1ZuVHFsdjY5T254NUk0WTg4cTIrUUtOTnovQ05xMkt4dkcK";
    const TEST_FILE: &[u8] = b"a small file that stands for an AppImage\n";
    const TEST_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTL3UyLzhRc2xPeDBlSG5zdUNndzJRVWZMcVlrZEF1VnE2d2VOUFBEYWNIRHV0T2s4eHhXdjl2dEFEWkpHRXZRclZTc3dkM1k5UEhDMGZEM1kzUG1uZElrM1RLUGVhS3c4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1MDUyNDE2CWZpbGU6YXBwLmJpbgozQW9VNFZxejdtbWVWT0hvS3RmcTN2Vy9XbUswUS9WOU1KbFlJWlVpSHBrSW1HS2M5Q0EvdWMvVUpMNFRRVkVXbDgraEZ1clNSazBDS0ZiVXVLclNEQT09Cg==";

    #[test]
    fn a_file_is_taken_only_with_its_own_signature_by_the_right_key() {
        assert_eq!(verify(TEST_FILE, TEST_SIG, TEST_KEY), Ok(()));
        let mut changed = TEST_FILE.to_vec();
        changed[3] ^= 1;
        assert!(verify(&changed, TEST_SIG, TEST_KEY).unwrap_err().contains("does not hold"));
        assert!(verify(TEST_FILE, TEST_SIG, PUBKEY).is_err(), "signed by another key than the releases'");
        assert!(verify(TEST_FILE, "not base64 !", TEST_KEY).is_err());
        assert!(verify(TEST_FILE, "", TEST_KEY).is_err());
        assert!(verify(TEST_FILE, TEST_KEY, TEST_KEY).is_err(), "a key is no signature");
    }

    #[test]
    fn the_releases_key_is_one_that_can_be_read() {
        assert!(minisign_verify::PublicKey::decode(&unbase64("the key", PUBKEY).unwrap()).is_ok());
    }

    #[test]
    fn only_a_later_version_is_newer() {
        assert!(newer("1.0.35", "1.0.34") && newer("v1.1.0", "1.0.99") && newer("2.0.0", "1.9.9"));
        assert!(!newer("1.0.34", "1.0.34") && !newer("1.0.33", "1.0.34"));
        assert!(newer("1.0.35", "1.0.35-rc.1") && !newer("1.0.35-rc.1", "1.0.35") && newer("1.0.36-rc.1", "1.0.35"));
        assert!(newer("1.0.35+build", "1.0.34"));
        assert!(!newer("", "1.0.34") && !newer("latest", "1.0.34") && !newer("1.0", "1.0.34") && !newer("1.0.0.1", "1.0.0"));
        assert!(!newer("1.0.35", "unknown"));
    }

    fn manifest(version: &str) -> String {
        format!(r#"{{"version":"{version}","notes":"- one\n- two","platforms":{{"linux-x86_64-appimage":{{"url":"https://github.com/nisfeb/lattice/releases/download/v{version}/lattice-rune-{version}-x86_64.AppImage","signature":"sig"}},"linux-x86_64":{{"url":"x","signature":"y"}}}}}}"#)
    }

    #[test]
    fn an_appimage_is_offered_its_file_and_another_copy_the_release_page() {
        let image = Flavor::AppImage("/a/lattice-rune.AppImage".into());
        let o = offer(&manifest("1.0.35"), "1.0.34", &image, "linux-x86_64", false).unwrap().unwrap();
        assert_eq!(o.version, "1.0.35");
        assert_eq!(o.file, Some(("https://github.com/nisfeb/lattice/releases/download/v1.0.35/lattice-rune-1.0.35-x86_64.AppImage".to_owned(), "sig".to_owned())));
        assert_eq!(offer_text(&o, "1.0.34"), "lattice-rune 1.0.35 is available. You have 1.0.34.\n- one\n- two");
        // a deb, or the program in a folder
        let o = offer(&manifest("1.0.35"), "1.0.34", &Flavor::ReleasePage, "linux-x86_64", false).unwrap().unwrap();
        assert_eq!(o.file, None);
        assert!(offer_text(&o, "1.0.34").ends_with("installed from the release page."));
        // a machine the release has no AppImage for
        assert_eq!(offer(&manifest("1.0.35"), "1.0.34", &image, "linux-aarch64", false).unwrap().unwrap().file, None);
        assert_eq!((flavor(Some("/x/a.AppImage")), flavor(Some("")), flavor(None)), (Flavor::AppImage("/x/a.AppImage".into()), Flavor::ReleasePage, Flavor::ReleasePage));
    }

    #[test]
    fn what_is_not_newer_or_not_from_the_releases_is_not_offered() {
        let image = Flavor::AppImage("/a".into());
        assert_eq!(offer(&manifest("1.0.34"), "1.0.34", &image, "linux-x86_64", false), Ok(None));
        assert_eq!(offer(&manifest("1.0.3"), "1.0.34", &image, "linux-x86_64", false), Ok(None));
        assert_eq!(offer("{}", "1.0.34", &image, "linux-x86_64", false), Ok(None));
        assert!(offer("<html>", "1.0.34", &image, "linux-x86_64", false).is_err());
        // a file named somewhere else is not fetched: the release page is shown
        let elsewhere = manifest("1.0.35").replace("https://github.com/nisfeb/lattice/releases/download/", "https://example.com/");
        assert_eq!(offer(&elsewhere, "1.0.34", &image, "linux-x86_64", false).unwrap().unwrap().file, None);
        assert!(offer(&elsewhere, "1.0.34", &image, "linux-x86_64", true).unwrap().unwrap().file.is_some());
    }

    #[test]
    fn long_notes_are_cut() {
        let o = Offer { version: "2.0.0".into(), notes: (1..=9).map(|i| format!("- {i}")).collect::<Vec<_>>().join("\n"), file: Some((String::new(), String::new())) };
        let said = offer_text(&o, "1.0.0");
        assert!(said.contains("- 6\n\u{2026}") && !said.contains("- 7"));
    }

    #[cfg(unix)]
    #[test]
    fn the_new_file_takes_the_old_ones_place_whole_and_runnable() {
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("lattice-rune-update-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let at = d.join("lattice-rune.AppImage");
        std::fs::write(&at, b"old").unwrap();
        std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o700)).unwrap();
        install(&at, b"new and longer").unwrap();
        assert_eq!(std::fs::read(&at).unwrap(), b"new and longer");
        assert_eq!(std::fs::metadata(&at).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "nothing is left beside it");
        // a folder that is gone: said, and nothing left behind
        assert!(install(&d.join("no/such/place.AppImage"), b"x").is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// A file of a published release and its `.sig`, named by `LATTICE_RUNE_SIGNED_FILE` and
    /// `LATTICE_RUNE_SIGNED_SIG`, against the key built in: `cargo test -- --ignored live_a_published`.
    #[test]
    #[ignore]
    fn live_a_published_file_holds_against_the_releases_key() {
        let file = std::fs::read(std::env::var("LATTICE_RUNE_SIGNED_FILE").unwrap()).unwrap();
        let sig = std::fs::read_to_string(std::env::var("LATTICE_RUNE_SIGNED_SIG").unwrap()).unwrap();
        assert_eq!(verify(&file, &sig, PUBKEY), Ok(()));
        assert!(verify(&file[1..], &sig, PUBKEY).is_err());
    }

    #[test]
    fn this_machine_has_a_name() {
        let p = platform();
        assert!(p.starts_with("linux-") || p.starts_with("darwin-") || p.starts_with("windows-"), "{p}");
    }
}
