//! Backups on a schedule: when one is due, where its archive lands, which
//! older ones go, and reading the newest back. A port of the desktop app's
//! `desktop/src/backup.rs`. The archive is `vault.rs`'s.
//!
//! Nothing runs while the app is closed. A schedule overdue at launch runs
//! at launch.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One recurring backup: how often, where, and how many to keep. Several
/// may share a folder: each prunes only its own archives.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Schedule {
    pub id: String,
    /// The owner's name for it, and the archive's: `lattice-<label>-<stamp>.tar`.
    pub label: String,
    /// 24 daily, 168 weekly, 720 every thirty days.
    pub every_hours: u64,
    /// How many of its own archives to keep. 0 keeps every one.
    pub keep: u32,
    pub dir: String,
    /// When it last wrote a whole archive, in seconds since 1970. 0 is never.
    #[serde(default)]
    pub last_run: u64,
    #[serde(default)]
    pub enabled: bool,
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// A schedule never run is due at once. One whose last run is in the
/// future (the clock moved back) is not due.
pub fn is_due(s: &Schedule, now: u64) -> bool {
    s.enabled && s.every_hours > 0 && (s.last_run == 0 || now.saturating_sub(s.last_run) >= s.every_hours.saturating_mul(3600))
}

/// One firing missed and an hour over. A schedule never run is not late.
pub fn overdue(s: &Schedule, now: u64) -> bool {
    s.enabled && s.last_run > 0 && now.saturating_sub(s.last_run) > (s.every_hours + 1) * 3600
}

pub fn period(hours: u64) -> String {
    match hours {
        1 => "hourly".into(),
        24 => "daily".into(),
        168 => "weekly".into(),
        720 => "every 30 days".into(),
        h => format!("every {h}h"),
    }
}

pub fn ago(last: u64, now: u64) -> String {
    let s = now.saturating_sub(last);
    match last {
        0 => "never run".into(),
        _ if s < 3600 => format!("last run {}m ago", s / 60),
        _ if s < 86400 => format!("last run {}h ago", s / 3600),
        _ => format!("last run {}d ago", s / 86400),
    }
}

/// A label as part of a file name: it cannot leave its folder.
pub fn slug(label: &str) -> String {
    let s: String = label.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let s: String = s.trim_matches('-').chars().take(40).collect();
    if s.is_empty() { "backup".into() } else { s }
}

/// `YYYYMMDD-HHMMSS` in UTC: fixed width, so names sort by age.
pub fn stamp(secs: u64) -> String {
    let (y, m, d) = crate::sheet::civil_from_days((secs / 86400) as i64);
    let r = secs % 86400;
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", r / 3600, r % 3600 / 60, r % 60)
}

pub fn archive_name(s: &Schedule, at: u64, complete: bool) -> String {
    // an incomplete one's name is never `is_ours`: it is not counted, pruned or verified as a good backup
    format!("lattice-{}-{}{}.tar", slug(&s.label), stamp(at), if complete { "" } else { "-INCOMPLETE" })
}

/// Strict, because the answer decides what is deleted: only
/// `lattice-<slug>-<8 digits>-<6 digits>.tar`.
pub fn is_ours(s: &Schedule, fname: &str) -> bool {
    let digits = |t: &str, n: usize| t.len() == n && t.bytes().all(|b| b.is_ascii_digit());
    fname.strip_prefix(&format!("lattice-{}-", slug(&s.label))).and_then(|r| r.strip_suffix(".tar")).and_then(|r| r.split_once('-')).is_some_and(|(d, t)| digits(d, 8) && digits(t, 6))
}

unsafe extern "C" {
    // ponytail: the C library std already links, declared here to save a dependency
    safe fn geteuid() -> u32;
}

/// This schedule's archives in `dir`, oldest first. The name is not enough:
/// a folder others can write to can be planted in. So each must be a plain
/// file of this user's, with one link, stamped no later than tomorrow.
pub fn existing(s: &Schedule, dir: &Path) -> Vec<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let latest = archive_name(s, now() + 86400, true);
    let mut v: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| {
            let Some(n) = e.file_name().to_str().map(str::to_owned) else { return false };
            let Ok(m) = std::fs::symlink_metadata(e.path()) else { return false };
            is_ours(s, &n) && n <= latest && m.file_type().is_file() && m.uid() == geteuid() && m.nlink() == 1
        })
        .map(|e| e.path())
        .collect();
    v.sort();
    v
}

/// Deletes this schedule's oldest archives until `keep` are left. Keeping 0
/// keeps every one: an empty field is not an ask to delete every backup.
pub fn prune(s: &Schedule, dir: &Path) -> Vec<PathBuf> {
    let have = existing(s, dir);
    let over = if s.keep == 0 { 0 } else { have.len().saturating_sub(s.keep as usize) };
    have.into_iter().take(over).filter(|p| std::fs::remove_file(p).is_ok()).collect()
}

/// Writes one archive, readable by its owner only, and prunes. An
/// incomplete one is still written, under its own name, and prunes nothing.
pub fn write_archive(s: &Schedule, bytes: &[u8], at: u64, complete: bool) -> Result<PathBuf, String> {
    if s.dir.trim().is_empty() {
        return Err("this schedule has no folder set".into());
    }
    let dir = PathBuf::from(&s.dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(archive_name(s, at, complete));
    crate::api::write_private(&path, bytes)?;
    if complete {
        prune(s, &dir);
    }
    Ok(path)
}

/// What an archive turned out to hold, read as a restore would read it.
#[derive(Clone, Default, Debug, PartialEq)]
pub struct Report {
    pub bytes: usize,
    pub pages: usize,
    pub has_share: bool,
    pub has_know: bool,
    /// Empty when the archive reads clean.
    pub problems: Vec<String>,
}

impl Report {
    pub fn says(&self) -> String {
        let bits = format!("{} page(s), {}, {} \u{b7} {} KB", self.pages, if self.has_share { "share modes" } else { "NO share.json" }, if self.has_know { "memories" } else { "NO know.json" }, (self.bytes + 512) / 1024);
        if self.problems.is_empty() { format!("\u{2713} {bits}. Reads clean") } else { format!("\u{2717} {bits}. {}", self.problems.join(". ")) }
    }
}

pub fn verify_bytes(data: &[u8]) -> Report {
    let mut r = Report { bytes: data.len(), ..Default::default() };
    let (files, end) = match crate::vault::untar_end(data) {
        Ok(x) => x,
        Err(e) => {
            r.problems.push(format!("the archive is corrupt: {e}"));
            return r;
        }
    };
    if !end {
        r.problems.push("no end-of-archive marker: the file was cut short".into());
    }
    let has = |n: &str| files.iter().any(|(name, _)| name == n);
    r.pages = files.iter().filter(|(n, _)| n.starts_with("pages/")).count();
    (r.has_share, r.has_know) = (has("share.json"), has("know.json"));
    // the tar can read clean and still be short: only the manifest knows what was meant
    if let Some((_, raw)) = files.iter().find(|(n, _)| n == "manifest.json") {
        match serde_json::from_str::<serde_json::Value>(raw) {
            Err(_) => r.problems.push("manifest.json is unreadable".into()),
            Ok(m) => {
                match m["pages"].as_u64() {
                    Some(want) if want != r.pages as u64 => r.problems.push(format!("the manifest expects {want} page(s) but the archive holds {}", r.pages)),
                    Some(_) => {}
                    None => r.problems.push("manifest.json has no page count".into()),
                }
                if let Some(miss) = m["missing"].as_array().filter(|a| !a.is_empty()) {
                    r.problems.push(format!("the export could not read {} item(s): {}", miss.len(), miss.iter().take(5).map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).collect::<Vec<_>>().join(", ")));
                }
            }
        }
    }
    if r.pages == 0 {
        r.problems.push("no pages in the archive".into());
    }
    if !r.has_share {
        r.problems.push("no share.json: a restore would bring every page back private".into());
    }
    if !r.has_know {
        r.problems.push("no know.json: a restore would bring back no memories".into());
    }
    r
}

pub fn verify_newest(s: &Schedule) -> Result<Report, String> {
    let have = existing(s, Path::new(&s.dir));
    let path = have.last().ok_or_else(|| format!("{} has not written an archive yet", s.label))?;
    Ok(verify_bytes(&std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?))
}

/// A schedule from what was typed, or why not.
pub fn new_schedule(list: &[Schedule], label: &str, dir: &str, every_hours: u64, keep: &str, id: String) -> Result<Schedule, String> {
    let (label, dir) = (label.trim(), dir.trim());
    if label.is_empty() || dir.is_empty() {
        return Err("a name and a folder are both needed".into());
    }
    // two with one slug would prune each other's archives
    if list.iter().any(|b| slug(&b.label) == slug(label)) {
        return Err(format!("there is already a schedule called {label}"));
    }
    Ok(Schedule { id, label: label.to_owned(), every_hours, keep: keep.trim().parse().unwrap_or(0).min(999), dir: dir.to_owned(), last_run: 0, enabled: true })
}

fn list_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("lattice-rune").join("backups.json"))
}

pub fn load() -> Vec<Schedule> {
    list_path().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(list: &[Schedule]) -> Result<(), String> {
    crate::api::write_private(&list_path().ok_or("no home directory")?, &serde_json::to_vec(list).map_err(|e| e.to_string())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{File, tar};

    fn sched(label: &str, hours: u64, keep: u32, dir: &Path) -> Schedule {
        Schedule { id: label.into(), label: label.into(), every_hours: hours, keep, dir: dir.display().to_string(), last_run: 0, enabled: true }
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lr-backups-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn due_only_when_a_whole_period_has_passed() {
        let mut s = sched("daily", 24, 7, Path::new("/tmp"));
        assert!(is_due(&s, 1_000_000), "never run is due at once");
        s.last_run = 1_000_000;
        assert!(!is_due(&s, 1_000_000 + 86_399));
        assert!(is_due(&s, 1_000_000 + 86_400));
        assert!(!is_due(&s, 500), "a last run in the future is not due");
        assert!(!overdue(&s, 1_000_000 + 86_400 + 3600) && overdue(&s, 1_000_000 + 86_400 + 3601));
        s.enabled = false;
        assert!(!is_due(&s, u64::MAX) && !overdue(&s, u64::MAX));
        s = sched("x", 0, 0, Path::new("/tmp"));
        assert!(!is_due(&s, 5));
        assert!(!overdue(&s, 99_999_999), "never run is not late");
        assert_eq!((period(24), period(168), period(720), period(1), period(5)), ("daily".into(), "weekly".into(), "every 30 days".into(), "hourly".into(), "every 5h".into()));
        assert_eq!((ago(0, 9), ago(100, 100 + 600), ago(100, 100 + 7200), ago(100, 100 + 200_000)), ("never run".into(), "last run 10m ago".into(), "last run 2h ago".into(), "last run 2d ago".into()));
    }

    #[test]
    fn names_are_strict_and_a_label_cannot_leave_its_folder() {
        let s = sched("Weekly / Off-site", 168, 4, Path::new("/tmp"));
        assert_eq!(slug("../../etc/passwd"), "etc-passwd");
        assert_eq!(slug("///"), "backup");
        assert_eq!(stamp(1_794_947_795), "20261117-203635");
        let name = archive_name(&s, 1_794_947_795, true);
        assert_eq!(name, "lattice-weekly---off-site-20261117-203635.tar");
        assert!(is_ours(&s, &name));
        assert!(!is_ours(&s, &archive_name(&s, 1_794_947_795, false)), "an incomplete one is never ours");
        assert!(!is_ours(&s, "lattice-weekly---off-site-20261117-203635.tar.bak"));
        assert!(!is_ours(&s, "lattice-weekly---off-site-2-20261117-203635.tar"));
        assert!(!is_ours(&sched("week", 1, 1, Path::new("/tmp")), "lattice-weekly-20261117-203635.tar"));
    }

    #[test]
    fn writing_prunes_only_its_own_and_planted_files_do_not_count() {
        let d = tmpdir("prune");
        let (daily, weekly) = (sched("daily", 24, 2, &d), sched("weekly", 168, 0, &d));
        let t0 = now() - 10 * 86400;
        for i in 0..4 {
            write_archive(&daily, b"x", t0 + i * 86400, true).unwrap();
            write_archive(&weekly, b"x", t0 + i * 86400, true).unwrap();
        }
        std::fs::write(d.join("notes.txt"), "mine").unwrap();
        assert_eq!(existing(&daily, &d).len(), 2, "the two newest are kept");
        assert!(existing(&daily, &d)[1].ends_with(archive_name(&daily, t0 + 3 * 86400, true)));
        assert_eq!(existing(&weekly, &d).len(), 4, "keeping 0 keeps every one, and another schedule's are not touched");
        assert!(d.join("notes.txt").exists());
        // an incomplete archive is written, is not ours, and pushes nothing out
        let inc = write_archive(&daily, b"x", t0 + 5 * 86400, false).unwrap();
        assert!(inc.to_string_lossy().ends_with("-INCOMPLETE.tar") && inc.exists());
        assert_eq!(existing(&daily, &d).len(), 2);
        // planted: stamped far ahead, a symlink, a second link to a real one
        std::fs::write(d.join(archive_name(&daily, now() + 400 * 86400, true)), "x").unwrap();
        std::os::unix::fs::symlink(d.join("notes.txt"), d.join(archive_name(&daily, t0 + 6 * 86400, true))).unwrap();
        std::fs::hard_link(d.join("notes.txt"), d.join(archive_name(&daily, t0 + 7 * 86400, true))).unwrap();
        assert_eq!(existing(&daily, &d).len(), 2, "none of the planted ones count");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&existing(&daily, &d)[0]).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(write_archive(&sched("x", 1, 1, Path::new(" ")), b"x", 1, true).is_err());
        std::fs::remove_dir_all(&d).unwrap();
    }

    fn archive(files: &[(&str, &str)]) -> Vec<u8> {
        tar(&files.iter().map(|(n, b)| File { name: (*n).into(), body: (*b).into(), mtime: 1 }).collect::<Vec<_>>())
    }

    #[test]
    fn the_newest_archive_is_read_back_as_a_restore_would() {
        let good = archive(&[("pages/a.md", "# a"), ("know.json", "{}"), ("share.json", "{}"), ("manifest.json", "{\"pages\":1,\"memories\":0,\"missing\":[]}"), ("README.txt", "hi")]);
        let r = verify_bytes(&good);
        assert_eq!(r, Report { bytes: good.len(), pages: 1, has_share: true, has_know: true, problems: vec![] });
        assert_eq!(r.says(), format!("\u{2713} 1 page(s), share modes, memories \u{b7} {} KB. Reads clean", (good.len() + 512) / 1024));
        // cut on a file's edge: every header reads, the end marker is gone
        assert_eq!(verify_bytes(&good[..good.len() - 1024]).problems, ["no end-of-archive marker: the file was cut short"]);
        assert!(verify_bytes(&good[..514]).problems[0].contains("truncated"));
        let mut bent = good.clone();
        bent[5] ^= 1;
        assert!(verify_bytes(&bent).problems[0].contains("checksum"));
        let short = verify_bytes(&archive(&[("pages/a.md", "x"), ("manifest.json", "{\"pages\":3,\"missing\":[\"gone\",\"the memories\"]}")]));
        assert_eq!(short.problems, ["the manifest expects 3 page(s) but the archive holds 1", "the export could not read 2 item(s): gone, the memories", "no share.json: a restore would bring every page back private", "no know.json: a restore would bring back no memories"]);
        assert!(short.says().starts_with("\u{2717} 1 page(s), NO share.json, NO know.json"));
        assert!(verify_bytes(&archive(&[("README.txt", "hi")])).problems.contains(&"no pages in the archive".to_owned()));

        let d = tmpdir("verify");
        let s = sched("daily", 24, 7, &d);
        assert_eq!(verify_newest(&s).unwrap_err(), "daily has not written an archive yet");
        write_archive(&s, b"junk", now() - 500, true).unwrap();
        write_archive(&s, &good, now() - 100, true).unwrap();
        assert!(verify_newest(&s).unwrap().problems.is_empty(), "the newest is the one read");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_schedule_is_made_from_what_was_typed() {
        let one = new_schedule(&[], " Daily ", " /tmp/b ", 24, "7", "a".into()).unwrap();
        assert_eq!(one, Schedule { id: "a".into(), label: "Daily".into(), every_hours: 24, keep: 7, dir: "/tmp/b".into(), last_run: 0, enabled: true });
        assert_eq!(new_schedule(&[], "", "/tmp", 24, "7", "b".into()).unwrap_err(), "a name and a folder are both needed");
        assert_eq!(new_schedule(&[one.clone()], "daily", "/x", 24, "7", "b".into()).unwrap_err(), "there is already a schedule called daily");
        assert_eq!(new_schedule(&[one], "weekly", "/x", 168, "lots", "b".into()).unwrap().keep, 0);
    }
}
