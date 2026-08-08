//! Scheduled vault backups to the host machine.
//!
//! The archive itself is built by the web client, not here. `exportVault` in
//! 78-export.js already writes the ustar the restore path reads, including
//! share.json and the memories, and a second implementation in Rust would be
//! a second thing to keep in step with the reader. So the scheduler decides
//! WHEN, asks the page to build one, and owns only what happens to the bytes
//! afterwards: where they land, and which older archives go.
//!
//! Which means a backup needs the workspace page loaded. That is the normal
//! state of this app — it is a single window and the workspace is what is in
//! it — but while the manager page is showing there is nothing to export
//! from, so a due schedule waits and is picked up on the next tick.
//!
//! Nothing here runs while the app is closed. A backup that must happen
//! whether or not you launched today wants a systemd timer or launchd job
//! driving the CLI, not an app that has to be running to fire. What this does
//! instead is catch up: a schedule overdue at launch runs at launch.

use std::path::{Path, PathBuf};

use crate::config::BackupSchedule;

/// Unix seconds, now.
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Is this schedule due at `now`?
///
/// A never-run schedule (last_run 0) is due immediately: the first backup
/// should not wait a full period, or turning on "monthly" means nothing
/// happens for 30 days and the feature looks broken.
pub fn is_due(s: &BackupSchedule, now: u64) -> bool {
    if !s.enabled || s.every_hours == 0 {
        return false;
    }
    if s.last_run == 0 {
        return true;
    }
    // saturating: a last_run in the future (clock moved back, config hand
    // edited) must read as "not due", never as a huge overdue interval
    now.saturating_sub(s.last_run) >= s.every_hours.saturating_mul(3600)
}

/// Filename-safe form of a label, so a schedule called "weekly / offsite"
/// cannot write outside its directory or collide with the stamp parser.
pub fn slug(label: &str) -> String {
    let s: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    let s: String = s.chars().take(40).collect();
    if s.is_empty() { "backup".into() } else { s }
}

/// YYYYMMDD-HHMMSS from unix seconds, UTC.
///
/// Hand-rolled rather than pulling a date crate in for one format string. The
/// civil-from-days conversion is Howard Hinnant's, which is the standard one.
/// Fixed width and zero padded so the stamps sort lexically — the pruner
/// relies on that to find the oldest without parsing anything.
pub fn stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// The archive name for a schedule at a moment.
pub fn archive_name(s: &BackupSchedule, at: u64) -> String {
    format!("lattice-{}-{}.tar", slug(&s.label), stamp(at))
}

/// Does this filename belong to this schedule?
///
/// Deliberately strict, because the answer decides what gets DELETED. Only
/// `lattice-<slug>-<8 digits>-<6 digits>.tar` counts: not a rename, not a
/// copy, not another schedule whose slug happens to share a prefix, and not
/// anything the user put in the directory themselves. A backup directory is
/// somewhere people also keep things by hand.
pub fn is_ours(s: &BackupSchedule, fname: &str) -> bool {
    let prefix = format!("lattice-{}-", slug(&s.label));
    let Some(rest) = fname.strip_prefix(&prefix) else { return false };
    let Some(rest) = rest.strip_suffix(".tar") else { return false };
    let Some((d, t)) = rest.split_once('-') else { return false };
    d.len() == 8 && t.len() == 6 && d.bytes().all(|b| b.is_ascii_digit()) && t.bytes().all(|b| b.is_ascii_digit())
}

/// This schedule's archives in `dir`, oldest first.
pub fn existing(s: &BackupSchedule, dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| is_ours(s, n))
                    .unwrap_or(false)
        })
        .collect();
    // the stamp is fixed width, so the name sorts by age
    v.sort();
    v
}

/// Delete this schedule's oldest archives until `keep` remain.
///
/// keep == 0 means keep everything: a retention of "none" is far more likely
/// to be an unfilled form than a request to delete every backup, and the
/// destructive reading of an empty field is not the one to guess.
pub fn prune(s: &BackupSchedule, dir: &Path) -> Vec<PathBuf> {
    if s.keep == 0 {
        return Vec::new();
    }
    let have = existing(s, dir);
    let keep = s.keep as usize;
    if have.len() <= keep {
        return Vec::new();
    }
    let mut gone = Vec::new();
    for p in &have[..have.len() - keep] {
        if std::fs::remove_file(p).is_ok() {
            gone.push(p.clone());
        }
    }
    gone
}

/// Write one archive and prune, returning where it landed.
pub fn write_archive(s: &BackupSchedule, bytes: &[u8], at: u64) -> Result<PathBuf, String> {
    if s.dir.trim().is_empty() {
        return Err("this schedule has no directory set".into());
    }
    let dir = PathBuf::from(&s.dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(archive_name(s, at));
    // via a temp file in the same directory: a backup half written when the
    // power goes is worse than no backup, because it still looks like one.
    let tmp = dir.join(format!(".{}.part", archive_name(s, at)));
    std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })?;
    prune(s, &dir);
    Ok(path)
}


// ── the restore drill ─────────────────────────────────────────────────────
//
// Backups now happen on a schedule and nobody has ever restored one. Those are
// different claims, and the gap between them is where this whole feature fails
// silently: the desktop export path was dead for weeks and the symptom was
// nothing at all. 78-export.js says it plainly — a backup you believe is
// complete when it is not is the only outcome worse than no backup.
//
// So: read an archive back the way a restore would, and say what is in it.
// Reading a ustar is far less code than writing one, and every check here is
// one a restore would hit for real.

/// What one archive turned out to contain.
#[derive(serde::Serialize, Clone, Default, Debug)]
pub struct Report {
    pub archive: String,
    pub bytes: u64,
    pub entries: usize,
    pub pages: usize,
    pub has_readme: bool,
    pub has_share: bool,
    pub has_know: bool,
    /// empty means the archive read cleanly
    pub problems: Vec<String>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.problems.is_empty()
    }
}

fn octal(b: &[u8]) -> u64 {
    // ustar numeric fields are octal text, NUL or space padded either side
    let mut n: u64 = 0;
    for c in b {
        if c.is_ascii_digit() && *c < b'8' {
            n = n * 8 + (c - b'0') as u64;
        }
    }
    n
}

fn cstr(b: &[u8]) -> String {
    let end = b.iter().position(|c| *c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).into_owned()
}

/// The header checksum: every byte of the 512, with the checksum field itself
/// read as spaces. This is the check that catches a corrupt or truncated
/// archive rather than merely an unexpected one, so it is not optional.
fn checksum_ok(h: &[u8]) -> bool {
    let want = octal(&h[148..156]);
    let mut sum: u64 = 0;
    for (i, c) in h.iter().enumerate() {
        sum += if (148..156).contains(&i) { 32 } else { *c as u64 };
    }
    sum == want
}

/// Read an archive's entries the way a restore would.
pub fn verify_bytes(name: &str, data: &[u8]) -> Report {
    let mut r = Report {
        archive: name.into(),
        bytes: data.len() as u64,
        ..Default::default()
    };
    let mut names: Vec<String> = Vec::new();
    let mut pos = 0usize;
    let mut pending_long: Option<String> = None;
    let mut saw_end = false;

    while pos + 512 <= data.len() {
        let h = &data[pos..pos + 512];
        if h.iter().all(|c| *c == 0) {
            saw_end = true;
            break;
        }
        if !checksum_ok(h) {
            r.problems.push(format!(
                "header checksum is wrong at byte {pos} — the archive is corrupt, not merely odd"
            ));
            return r;
        }
        let size = octal(&h[124..136]) as usize;
        let typ = h[156];
        pos += 512;
        let body_end = pos + size;
        if body_end > data.len() {
            r.problems.push(format!(
                "the archive ends mid-file: {} needs {size} bytes and {} remain",
                cstr(&h[0..100]),
                data.len() - pos
            ));
            return r;
        }
        if typ == b'L' {
            // GNU @LongLink: this record's body IS the next entry's name
            pending_long = Some(cstr(&data[pos..body_end]));
        } else {
            let n = pending_long.take().unwrap_or_else(|| cstr(&h[0..100]));
            names.push(n);
        }
        pos = body_end + ((512 - (size % 512)) % 512);
    }

    if !saw_end {
        r.problems
            .push("no end-of-archive marker — the file was cut short".into());
    }
    r.entries = names.len();
    r.pages = names.iter().filter(|n| n.starts_with("pages/")).count();
    r.has_readme = names.iter().any(|n| n == "README.txt");
    r.has_share = names.iter().any(|n| n == "share.json");
    r.has_know = names.iter().any(|n| n == "know.json");

    // Missing manifests are not fatal to reading the tar, and that is exactly
    // why they are worth saying out loud: an archive without share.json
    // restores as a store with everything unpublished, which looks like a
    // successful restore right up until someone notices the site is gone.
    if r.pages == 0 {
        r.problems.push("no pages in the archive".into());
    }
    if !r.has_share {
        r.problems
            .push("no share.json — a restore would bring every page back private".into());
    }
    if !r.has_know {
        r.problems
            .push("no know.json — a restore would bring back no memories".into());
    }
    r
}

/// Verify a schedule's newest archive.
pub fn verify_newest(s: &BackupSchedule) -> Result<Report, String> {
    let dir = PathBuf::from(&s.dir);
    let have = existing(s, &dir);
    let Some(path) = have.last() else {
        return Err(format!("{} has not written an archive yet", s.label));
    };
    let data = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(verify_bytes(&path.display().to_string(), &data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sched(label: &str, hours: u64, keep: u32, dir: &str) -> BackupSchedule {
        BackupSchedule {
            id: "id".into(),
            label: label.into(),
            every_hours: hours,
            keep,
            dir: dir.into(),
            last_run: 0,
            enabled: true,
        }
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("lattice-bk-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn a_stamp_is_a_real_date_and_sorts_by_age() {
        // known epochs, checked against date(1)
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_000_000_000), "20010909-014640");
        assert_eq!(stamp(1_700_000_000), "20231114-221320");
        // leap day, the one the hand-rolled conversion would get wrong
        assert_eq!(stamp(1_709_164_800), "20240229-000000");
        // fixed width means lexical order IS chronological order, which the
        // pruner depends on to pick the oldest without parsing
        assert!(stamp(1_000_000_000) < stamp(1_700_000_000));
    }

    #[test]
    fn due_only_when_a_full_period_has_passed() {
        let mut s = sched("daily", 24, 7, "/tmp");
        // never run: due at once, or enabling "monthly" looks broken for 30 days
        assert!(is_due(&s, 1_000));
        s.last_run = 1_000_000;
        assert!(!is_due(&s, 1_000_000 + 23 * 3600), "23h into a 24h period");
        assert!(is_due(&s, 1_000_000 + 24 * 3600), "exactly one period");
        // a clock that moved backwards must not read as wildly overdue
        assert!(!is_due(&s, 999_000), "last_run in the future");
        s.enabled = false;
        assert!(!is_due(&s, 9_000_000), "a paused schedule never comes due");
        s.enabled = true;
        s.every_hours = 0;
        assert!(!is_due(&s, 9_000_000), "a zero period would fire every tick");
    }

    #[test]
    fn only_this_schedules_own_archives_are_ever_matched() {
        let s = sched("daily", 24, 7, "/tmp");
        assert!(is_ours(&s, "lattice-daily-20240229-000000.tar"));
        // things that must NOT be deletable
        assert!(!is_ours(&s, "lattice-daily-20240229-000000.tar.bak"), "a rename");
        assert!(!is_ours(&s, "copy-of-lattice-daily-20240229-000000.tar"), "a copy");
        assert!(!is_ours(&s, "lattice-weekly-20240229-000000.tar"), "another schedule");
        assert!(!is_ours(&s, "lattice-daily2-20240229-000000.tar"), "a longer slug");
        assert!(!is_ours(&s, "lattice-daily-2024022-000000.tar"), "short date");
        assert!(!is_ours(&s, "lattice-daily-abcdefgh-000000.tar"), "non-numeric");
        assert!(!is_ours(&s, "notes.tar"), "someone else's file");
        // a slug collision is the dangerous one: "daily" must not eat "daily-offsite"
        let other = sched("daily offsite", 24, 4, "/tmp");
        assert!(!is_ours(&s, &archive_name(&other, 1_700_000_000)));
        assert!(!is_ours(&other, &archive_name(&s, 1_700_000_000)));
    }

    #[test]
    fn retention_keeps_the_newest_and_deletes_only_its_own() {
        let dir = tmpdir("retention");
        let s = sched("daily", 24, 3, dir.to_str().unwrap());
        // ten archives, a day apart
        for i in 0..10u64 {
            std::fs::write(dir.join(archive_name(&s, 1_700_000_000 + i * 86_400)), b"x").unwrap();
        }
        // bystanders that must survive
        std::fs::write(dir.join("notes.tar"), b"x").unwrap();
        std::fs::write(dir.join("lattice-weekly-20240101-000000.tar"), b"x").unwrap();
        let gone = prune(&s, &dir);
        assert_eq!(gone.len(), 7, "ten minus keep=3");
        let left = existing(&s, &dir);
        assert_eq!(left.len(), 3);
        // the three NEWEST are the survivors
        assert_eq!(
            left.last().unwrap().file_name().unwrap().to_str().unwrap(),
            archive_name(&s, 1_700_000_000 + 9 * 86_400)
        );
        assert!(dir.join("notes.tar").exists(), "an unrelated file was deleted");
        assert!(dir.join("lattice-weekly-20240101-000000.tar").exists(), "another schedule was deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keep_zero_deletes_nothing() {
        let dir = tmpdir("keepzero");
        let s = sched("daily", 24, 0, dir.to_str().unwrap());
        for i in 0..5u64 {
            std::fs::write(dir.join(archive_name(&s, 1_700_000_000 + i * 86_400)), b"x").unwrap();
        }
        assert!(prune(&s, &dir).is_empty(), "an empty keep field is not a request to delete everything");
        assert_eq!(existing(&s, &dir).len(), 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writing_an_archive_lands_it_and_prunes_in_one_step() {
        let dir = tmpdir("write");
        let s = sched("daily", 24, 2, dir.to_str().unwrap());
        for i in 0..3u64 {
            write_archive(&s, format!("archive {i}").as_bytes(), 1_700_000_000 + i * 86_400).unwrap();
        }
        let left = existing(&s, &dir);
        assert_eq!(left.len(), 2, "keep=2 applied as they were written");
        assert_eq!(std::fs::read_to_string(left.last().unwrap()).unwrap(), "archive 2");
        // no .part left behind
        assert!(
            std::fs::read_dir(&dir).unwrap().flatten()
                .all(|e| !e.file_name().to_str().unwrap().ends_with(".part")),
            "a temp file survived"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_label_cannot_escape_its_directory() {
        let s = sched("../../etc/cron.d/evil", 24, 1, "/tmp");
        let n = archive_name(&s, 1_700_000_000);
        assert!(!n.contains('/'), "{n}");
        assert!(!n.contains(".."), "{n}");
        assert_eq!(slug(""), "backup", "an empty label still needs a filename");
    }

    // ── restore drill ─────────────────────────────────────────────────────
    // Fixtures are built here rather than shipped as blobs, so a test can bend
    // one byte and say exactly which failure that is. This is the only tar
    // WRITER in the tree outside the client, and it exists purely to give the
    // reader something to be wrong about.
    fn tar_entry(name: &str, body: &[u8]) -> Vec<u8> {
        let mut h = vec![0u8; 512];
        let nb = name.as_bytes();
        h[..nb.len().min(100)].copy_from_slice(&nb[..nb.len().min(100)]);
        h[100..108].copy_from_slice(b"0000644\0");
        h[108..116].copy_from_slice(b"0000000\0");
        h[116..124].copy_from_slice(b"0000000\0");
        let size = format!("{:011o}\0", body.len());
        h[124..136].copy_from_slice(size.as_bytes());
        h[136..148].copy_from_slice(b"00000000000\0");
        h[148..156].copy_from_slice(b"        ");
        h[156] = b'0';
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        let sum: u64 = h.iter().map(|c| *c as u64).sum();
        let ck = format!("{sum:06o}\0 ");
        h[148..156].copy_from_slice(ck.as_bytes());
        let mut out = h;
        out.extend_from_slice(body);
        out.extend(std::iter::repeat_n(0, (512 - (body.len() % 512)) % 512));
        out
    }

    fn tar_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut v = Vec::new();
        for (n, b) in files {
            v.extend(tar_entry(n, b));
        }
        v.extend(std::iter::repeat_n(0, 1024));
        v
    }

    fn full_archive() -> Vec<u8> {
        tar_of(&[
            ("pages/notes/todo.md", b"# todo\n"),
            ("pages/index.md", b"# hello\n"),
            ("share.json", b"{}"),
            ("know.json", b"{}"),
            ("README.txt", b"lattice vault export\n"),
        ])
    }

    #[test]
    fn a_good_archive_reads_clean() {
        let r = verify_bytes("t.tar", &full_archive());
        assert!(r.ok(), "{:?}", r.problems);
        assert_eq!(r.entries, 5);
        assert_eq!(r.pages, 2);
        assert!(r.has_share && r.has_know && r.has_readme);
    }

    #[test]
    fn a_truncated_archive_is_caught() {
        // the failure a half-written backup actually has: the tar simply stops
        let full = full_archive();
        let cut = &full[..full.len() - 2048];
        let r = verify_bytes("t.tar", cut);
        assert!(!r.ok(), "a cut-short archive must not read as fine");
        assert!(
            r.problems.iter().any(|p| p.contains("cut short") || p.contains("ends mid-file")),
            "{:?}",
            r.problems
        );
    }

    #[test]
    fn a_corrupt_header_is_caught_by_its_checksum() {
        let mut v = full_archive();
        // bend one byte of the first name: the checksum must notice
        v[5] ^= 0xff;
        let r = verify_bytes("t.tar", &v);
        assert!(!r.ok());
        assert!(r.problems.iter().any(|p| p.contains("checksum")), "{:?}", r.problems);
    }

    #[test]
    fn a_bent_body_byte_is_not_claimed_to_be_caught() {
        // Honest about the limit: ustar checksums cover the HEADER only, so a
        // flipped byte inside a page body reads clean. Pinned so nobody later
        // believes this drill proves content integrity — it proves structure.
        let mut v = full_archive();
        v[512] ^= 0xff;
        let r = verify_bytes("t.tar", &v);
        assert!(r.ok(), "a body-byte flip is outside what a tar checksum covers");
    }

    #[test]
    fn a_missing_manifest_is_reported_even_though_the_tar_reads() {
        // the dangerous case: it unpacks fine and restores a store with
        // everything unpublished and no memories
        let v = tar_of(&[("pages/a.md", b"x"), ("README.txt", b"r")]);
        let r = verify_bytes("t.tar", &v);
        assert!(!r.ok());
        assert!(r.problems.iter().any(|p| p.contains("share.json")), "{:?}", r.problems);
        assert!(r.problems.iter().any(|p| p.contains("know.json")), "{:?}", r.problems);
        assert_eq!(r.pages, 1, "and it still counts what IS there");
    }

    #[test]
    fn an_empty_archive_is_not_a_backup() {
        let r = verify_bytes("t.tar", &tar_of(&[]));
        assert!(!r.ok());
        assert!(r.problems.iter().any(|p| p.contains("no pages")), "{:?}", r.problems);
    }

    #[test]
    fn a_long_name_survives_its_longlink_record() {
        // page paths are user text and go well past 100 bytes; the name must
        // come from the @LongLink body, not the truncated header field
        let long = format!("pages/{}/deep.md", "a-rather-long-folder-name".repeat(5));
        let mut v = Vec::new();
        let nb = format!("{long}\0");
        let mut ll = tar_entry("././@LongLink", nb.as_bytes());
        ll[156] = b'L';
        let sum: u64 = ll[..512]
            .iter()
            .enumerate()
            .map(|(i, c)| if (148..156).contains(&i) { 32 } else { *c as u64 })
            .sum();
        let ck = format!("{sum:06o}\0 ");
        ll[148..156].copy_from_slice(ck.as_bytes());
        v.extend(ll);
        v.extend(tar_entry(&long[..100.min(long.len())], b"x"));
        v.extend(tar_entry("share.json", b"{}"));
        v.extend(tar_entry("know.json", b"{}"));
        v.extend(std::iter::repeat_n(0, 1024));
        let r = verify_bytes("t.tar", &v);
        assert_eq!(r.pages, 1, "{:?}", r.problems);
        assert!(r.ok(), "{:?}", r.problems);
    }
}
