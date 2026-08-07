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
}
