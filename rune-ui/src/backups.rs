//! Backups on a schedule: when one is due, where its archive lands, which
//! older ones go, and reading the newest back. A port of the desktop app's
//! `desktop/src/backup.rs`. The archive is `vault.rs`'s.
//!
//! Nothing runs while the app is closed. A schedule overdue at launch runs
//! at launch.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One recurring backup of one ship: how often, where, and how many to
/// keep. Several may share a folder: each prunes only its own archives.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Schedule {
    pub id: String,
    /// The owner's name for it, and the archive's: `lattice-<label>-<ship>-<stamp>.tar`.
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
    /// The ship it backs up: its name and its address. It runs against that ship alone, and its
    /// archives carry the ship's name, so two ships signed in never share a run of archives.
    /// Empty in a schedule made before schedules named a ship, until it is given one (`runs_for`).
    #[serde(default)]
    pub ship: String,
    #[serde(default)]
    pub url: String,
}

pub fn now() -> u64 {
    crate::api::since_epoch().map_or(0, |d| d.as_secs())
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

/// What every archive of a schedule is named before its stamp: its label, then its ship's name.
/// A schedule from before schedules named a ship has the label alone, as its archives on disk do.
/// A ship's name is letters and dashes and a stamp starts with eight digits, so one schedule's
/// archives are never read as another's whose name begins the same.
fn prefix(s: &Schedule) -> String {
    let ship: String = s.ship.trim_start_matches('~').chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    if ship.is_empty() { format!("lattice-{}-", slug(&s.label)) } else { format!("lattice-{}-{ship}-", slug(&s.label)) }
}

pub fn archive_name(s: &Schedule, at: u64, complete: bool) -> String {
    // an incomplete one's name is never `is_ours`: it is not counted, pruned or verified as a good backup
    format!("{}{}{}.tar", prefix(s), stamp(at), if complete { "" } else { "-INCOMPLETE" })
}

/// Whether a schedule is to run against the ship in front, named `ship` at `url`. Its own ship
/// alone. One that names no ship yet, from before schedules did, runs unasked only when `alone`
/// says one ship is signed in: with several, which of them it was meant for cannot be told.
pub fn runs_for(s: &Schedule, url: &str, ship: &str, alone: bool) -> bool {
    if s.ship.is_empty() { alone } else { s.ship == ship && s.url == url }
}

/// Strict, because the answer decides what is deleted: only
/// `lattice-<slug>-<ship>-<8 digits>-<6 digits>.tar`, with no ship's name
/// for a schedule that names none.
pub fn is_ours(s: &Schedule, fname: &str) -> bool {
    let digits = |t: &str, n: usize| t.len() == n && t.bytes().all(|b| b.is_ascii_digit());
    fname.strip_prefix(&prefix(s)).and_then(|r| r.strip_suffix(".tar")).and_then(|r| r.split_once('-')).is_some_and(|(d, t)| digits(d, 8) && digits(t, 6))
}

#[cfg(unix)]
unsafe extern "C" {
    // ponytail: the C library std already links, declared here to save a dependency
    safe fn geteuid() -> u32;
}

/// This schedule's archives in `dir`, oldest first. The name is not enough:
/// a folder others can write to can be planted in. So each must be a plain
/// file of this user's, with one link, stamped no later than tomorrow.
pub fn existing(s: &Schedule, dir: &Path) -> Vec<PathBuf> {
    // a browser has no folder to keep archives in
    #[cfg(target_arch = "wasm32")]
    return {
        let _ = (s, dir);
        Vec::new()
    };
    #[cfg(not(target_arch = "wasm32"))]
    {
        // a file of ours alone: not another user's, and with no second name elsewhere. Windows has neither to ask of
        #[cfg(unix)]
        let own = |m: &std::fs::Metadata| {
            use std::os::unix::fs::MetadataExt;
            m.uid() == geteuid() && m.nlink() == 1
        };
        #[cfg(not(unix))]
        let own = |_: &std::fs::Metadata| true;
        let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
        let latest = archive_name(s, now() + 86400, true);
        let mut v: Vec<PathBuf> = rd
            .flatten()
            .filter(|e| {
                let Some(n) = e.file_name().to_str().map(str::to_owned) else { return false };
                let Ok(m) = std::fs::symlink_metadata(e.path()) else { return false };
                is_ours(s, &n) && n <= latest && m.file_type().is_file() && own(&m)
            })
            .map(|e| e.path())
            .collect();
        v.sort();
        v
    }
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
    } else {
        // only the newest incomplete one is kept: each is the whole store, and a page that cannot be read makes one at every try
        let mine = prefix(s);
        for old in std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()) {
            let name = old.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
            // this schedule's own, by the date that follows its name: another schedule's name may begin with this one's
            let dated = name.strip_prefix(&mine).is_some_and(|r| r.len() > 9 && r.as_bytes()[..8].iter().all(u8::is_ascii_digit) && r.as_bytes()[8] == b'-');
            if old != path && dated && name.ends_with("-INCOMPLETE.tar") {
                let _ = std::fs::remove_file(&old);
            }
        }
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
    // read as a restore reads it: a file under pages/ that it would leave out is not a page that reads clean
    if let Ok(a) = crate::vault::read(data) {
        if a.skip_ext > 0 {
            r.problems.push(format!("a restore would leave out {} file(s) of a kind that is no page's", a.skip_ext));
        }
        if a.skip_name > 0 {
            r.problems.push(format!("a restore would leave out {} page(s) whose name the ship does not take", a.skip_name));
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

/// A schedule from what was typed, for the ship named `ship` at `url`, or why not.
pub fn new_schedule(list: &[Schedule], label: &str, dir: &str, every_hours: u64, keep: &str, id: String, ship: &str, url: &str) -> Result<Schedule, String> {
    let (label, dir) = (label.trim(), dir.trim());
    if label.is_empty() || dir.is_empty() {
        return Err("a name and a folder are both needed".into());
    }
    let new = Schedule { id, label: label.to_owned(), every_hours, keep: keep.trim().parse().unwrap_or(0).min(999), dir: dir.to_owned(), last_run: 0, enabled: true, ship: ship.to_owned(), url: url.to_owned() };
    // two whose archives are named alike would prune each other's. The same label for another ship is another run of names
    if list.iter().any(|b| prefix(b) == prefix(&new)) {
        return Err(format!("there is already a schedule called {label}{}", if ship.is_empty() { String::new() } else { format!(" for {ship}") }));
    }
    Ok(new)
}

fn list_path() -> Option<PathBuf> {
    Some(crate::api::config_dir()?.join("backups.json"))
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
        Schedule { id: label.into(), label: label.into(), every_hours: hours, keep, dir: dir.display().to_string(), last_run: 0, enabled: true, ..Schedule::default() }
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

    #[test]
    fn a_schedule_writes_and_prunes_one_ships_archives_and_no_others() {
        let d = tmpdir("ships");
        let of = |ship: &str, url: &str| Schedule { ship: ship.into(), url: url.into(), ..sched("daily", 24, 2, &d) };
        let (zod, bus, before) = (of("~zod", "http://a"), of("~bus", "http://b"), sched("daily", 24, 2, &d));
        let t0 = now() - 10 * 86400;
        // archives written before schedules named a ship are on disk
        let old: Vec<PathBuf> = (0..2).map(|i| write_archive(&before, b"of whichever ship was in front", t0 + i * 3600, true).unwrap()).collect();
        // one run for ~zod, then more for ~bus than are kept
        let first = write_archive(&zod, b"the pages of ~zod", t0 + 86400, true).unwrap();
        for i in 2..6 {
            write_archive(&bus, b"the pages of ~bus", t0 + i * 86400, true).unwrap();
        }
        assert_eq!(first.file_name().unwrap().to_string_lossy(), format!("lattice-daily-zod-{}.tar", stamp(t0 + 86400)), "the name says whose it is");
        assert!(first.exists(), "~zod's archive is not pruned by ~bus's runs");
        assert_eq!((existing(&zod, &d), existing(&bus, &d).len()), (vec![first.clone()], 2));
        assert!(existing(&bus, &d).iter().all(|p| std::fs::read(p).unwrap() == b"the pages of ~bus"));
        // and none of those from before is counted, verified or deleted as either ship's
        assert!(old.iter().all(|p| p.exists()) && existing(&before, &d) == old);
        assert!(!is_ours(&zod, &archive_name(&before, t0, true)) && !is_ours(&before, &archive_name(&zod, t0, true)) && !is_ours(&zod, &archive_name(&bus, t0, true)));
        // an incomplete one of one ship does not take another ship's incomplete one away
        let (iz, ib) = (write_archive(&zod, b"x", t0 + 7 * 86400, false).unwrap(), write_archive(&bus, b"x", t0 + 7 * 86400, false).unwrap());
        let ib2 = write_archive(&bus, b"x", t0 + 8 * 86400, false).unwrap();
        assert!(iz.exists() && !ib.exists() && ib2.exists());
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
        // every kind of page an export writes is one a restore puts back, and is counted clean
        let kinds = archive(&[("pages/a.md", "a"), ("pages/s.fods", "<s/>"), ("pages/d.fodt", "<d/>"), ("pages/m.geojson", "{}"), ("pages/c.scad", "cube();"), ("know.json", "{}"), ("share.json", "{}"), ("manifest.json", "{\"pages\":5,\"missing\":[]}")]);
        assert_eq!(verify_bytes(&kinds).problems, Vec::<String>::new());
        assert_eq!(crate::vault::read(&kinds).unwrap().pages.iter().map(|p| format!("{}:{}", p.name, p.kind)).collect::<Vec<_>>(), ["a:md", "s:fods", "d:fodt", "m:geojson", "c:scad"]);
        // a file a restore would leave out is said, not counted as a page that reads clean
        let odd = verify_bytes(&archive(&[("pages/a.md", "a"), ("pages/pic.svg", "<svg/>"), ("pages/Bad Name.md", "x"), ("know.json", "{}"), ("share.json", "{}"), ("manifest.json", "{\"pages\":3,\"missing\":[]}")]));
        assert_eq!(odd.problems, ["a restore would leave out 1 file(s) of a kind that is no page's", "a restore would leave out 1 page(s) whose name the ship does not take"]);

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
        let one = new_schedule(&[], " Daily ", " /tmp/b ", 24, "7", "a".into(), "~zod", "http://a").unwrap();
        assert_eq!(one, Schedule { id: "a".into(), label: "Daily".into(), every_hours: 24, keep: 7, dir: "/tmp/b".into(), last_run: 0, enabled: true, ship: "~zod".into(), url: "http://a".into() });
        assert_eq!(new_schedule(&[], "", "/tmp", 24, "7", "b".into(), "~zod", "http://a").unwrap_err(), "a name and a folder are both needed");
        assert_eq!(new_schedule(&[one.clone()], "daily", "/x", 24, "7", "b".into(), "~zod", "http://a").unwrap_err(), "there is already a schedule called daily for ~zod");
        assert_eq!(new_schedule(&[one.clone()], "weekly", "/x", 168, "lots", "b".into(), "~zod", "http://a").unwrap().keep, 0);
        // the same label for another ship is its own run of archives. The same ship at another address is not: its archives would be named alike
        assert!(new_schedule(&[one.clone()], "daily", "/x", 24, "7", "b".into(), "~bus", "http://a").is_ok());
        assert!(new_schedule(&[one.clone()], "daily", "/x", 24, "7", "b".into(), "~zod", "http://elsewhere").is_err());
        // nor may a label be made to look like another schedule's label and ship
        assert!(new_schedule(&[one.clone()], "daily-zod", "/x", 24, "7", "b".into(), "", "").is_err());
        assert!(new_schedule(&[one.clone()], "daily", "/x", 24, "7", "b".into(), "", "").is_ok());
        // a schedule runs against its own ship at its own address, whichever is in front
        assert!(runs_for(&one, "http://a", "~zod", false) && !runs_for(&one, "http://a", "~bus", true) && !runs_for(&one, "http://b", "~zod", true));
        // one from before schedules named a ship reads with none, and is given the ship in front only when that is the only ship
        let before: Schedule = serde_json::from_str(r#"{"id":"x","label":"daily","every_hours":24,"keep":2,"dir":"/b","last_run":5,"enabled":true}"#).unwrap();
        assert_eq!((before.ship.as_str(), before.url.as_str()), ("", ""));
        assert!(runs_for(&before, "http://a", "~zod", true) && !runs_for(&before, "http://a", "~zod", false));
    }
}
