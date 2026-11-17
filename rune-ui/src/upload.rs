//! Files from this machine turned into pages: which kind an extension
//! is, the name a path becomes, and reading a file or a folder of them.
//! The web client's rules (`ui-src/lattice/30-tree.js`, `70-upload.js`).

use std::path::Path;

/// One page to make: its name, its kind and its text.
#[derive(Debug, PartialEq)]
pub struct Item {
    pub name: String,
    pub kind: &'static str,
    pub body: String,
}

/// What a pick came to: the pages to make, and the files left out with why.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub items: Vec<Item>,
    pub skipped: Vec<String>,
}

/// The most files taken from one folder, and the largest file read.
const MAX_FILES: usize = 2000;
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// The page kind a file's extension makes. `None` is a file that is not
/// uploaded: never guessed.
pub fn ext_kind(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "md" => "md",
        "gmi" => "gmi",
        "html" | "htm" => "html",
        "txt" | "text" => "text",
        "js" => "js",
        "css" => "css",
        "hoon" => "hoon",
        "tex" | "latex" => "tex",
        "fodt" => "fodt",
        "fods" => "fods",
        "geojson" => "geojson",
        "scad" => "scad",
        _ => return None,
    })
}

/// The page a file becomes: its path without the extension, each part
/// made a name a page can have, under `dir` when there is one.
pub fn page_name(rel: &str, dir: &str) -> Option<(String, &'static str)> {
    let (stem, ext) = rel.rsplit_once('.')?;
    // a .csv and an .ods come in as a spreadsheet page, an .odt as a document
    let kind = match ext.to_ascii_lowercase().as_str() {
        "csv" | "ods" => "fods",
        "odt" => "fodt",
        e => ext_kind(e)?,
    };
    let under = if dir.is_empty() { stem.to_owned() } else { format!("{}/{stem}", dir.trim_matches('/')) };
    Some((crate::api::real_name(&under)?.name, kind))
}

fn why_not(rel: &str) -> String {
    format!("{rel} (not a kind of page)")
}

/// Reads one file into the plan. A file too large, or not text, is left out.
fn take(plan: &mut Plan, path: &Path, rel: &str, dir: &str) {
    let Some((name, kind)) = page_name(rel, dir) else {
        plan.skipped.push(why_not(rel));
        return;
    };
    match std::fs::metadata(path) {
        Ok(m) if m.len() > MAX_BYTES => return plan.skipped.push(format!("{rel} (larger than 4 MB)")),
        Err(e) => return plan.skipped.push(format!("{rel} ({e})")),
        Ok(_) => {}
    }
    let ext = rel.rsplit_once('.').map_or("", |p| p.1).to_ascii_lowercase();
    // a package is unpacked into the one flat document a page holds
    if ext == "odt" || ext == "ods" {
        match std::fs::read(path).map_err(|e| e.to_string()).and_then(|b| crate::odf::import(&b, &ext)) {
            Ok(flat) => {
                if !flat.note.is_empty() {
                    plan.skipped.push(format!("{rel} came in, but {}", flat.note));
                }
                plan.items.push(Item { name, kind, body: flat.text });
            }
            Err(e) => plan.skipped.push(format!("{rel} ({e})")),
        }
        return;
    }
    let csv = ext == "csv";
    match std::fs::read_to_string(path) {
        Ok(text) if csv => match crate::sheet::from_csv(&text) {
            Ok(body) => plan.items.push(Item { name, kind, body }),
            Err(e) => plan.skipped.push(format!("{rel} ({e})")),
        },
        Ok(body) => plan.items.push(Item { name, kind, body: if body.is_empty() { "\n".into() } else { body } }),
        Err(_) => plan.skipped.push(format!("{rel} (not text)")),
    }
}

/// The pages a picked file or folder makes, under `dir`. A folder keeps
/// its own name as the first part, as a dropped folder does on the web.
/// Hidden files and folders are passed over.
pub fn read(path: &Path, dir: &str) -> Plan {
    let mut plan = Plan::default();
    let top = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !path.is_dir() {
        take(&mut plan, path, &top, dir);
        return plan;
    }
    let mut stack = vec![(path.to_path_buf(), top)];
    while let Some((at, rel)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&at) else { continue };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let rel = format!("{rel}/{name}");
            // a link is not followed: a loop would never end
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push((e.path(), rel)),
                Ok(t) if t.is_file() => {
                    if plan.items.len() + plan.skipped.len() >= MAX_FILES {
                        plan.skipped.push(format!("everything after the first {MAX_FILES} files"));
                        return plan;
                    }
                    take(&mut plan, &e.path(), &rel, dir);
                }
                _ => {}
            }
        }
    }
    plan.items.sort_by(|a, b| a.name.cmp(&b.name));
    plan
}

/// The file name a page is downloaded under: its last name and its
/// kind as an extension, as the web client names it. A memory is Markdown.
pub fn download_name(page: &str, kind: &str, memory: bool) -> String {
    let leaf = page.rsplit('/').next().unwrap_or(page);
    let ext = match (memory, kind) {
        (true, _) => "md",
        (_, "text") => "txt",
        (_, "") => "md",
        (_, k) => k,
    };
    format!("{leaf}.{ext}")
}

/// `read` for several picks at once, as a drop brings them.
pub fn read_all(paths: &[std::path::PathBuf], dir: &str) -> Plan {
    let mut all = Plan::default();
    for p in paths {
        let Plan { items, skipped } = read(p, dir);
        // two files that come to one name: the first is the page, the second is said
        for i in items {
            if all.items.iter().any(|x| x.name == i.name) {
                all.skipped.push(format!("{} (a second file for that page)", i.name));
            } else {
                all.items.push(i);
            }
        }
        all.skipped.extend(skipped);
    }
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_files_extension_says_its_kind_and_its_path_its_name() {
        assert_eq!(ext_kind("MD"), Some("md"));
        assert_eq!(ext_kind("htm"), Some("html"));
        assert_eq!(ext_kind("png"), None);
        assert_eq!(page_name("Trip Notes/Day 1.md", ""), crate::api::real_name("Trip Notes/Day 1").map(|r| (r.name, "md")));
        assert_eq!(page_name("a.b.txt", "notes").map(|p| p.1), Some("text"));
        assert!(page_name("day.md", "notes/").unwrap().0.starts_with("notes/"));
        assert_eq!(page_name("no-extension", ""), None);
        assert_eq!(page_name("photo.png", ""), None);
        assert_eq!(download_name("notes/ideas/maps", "md", false), "maps.md");
        assert_eq!(download_name("readme", "text", false), "readme.txt");
        assert_eq!(download_name("places", "geojson", false), "places.geojson");
        assert_eq!(download_name("feedback/short-answers", "md", true), "short-answers.md");
        assert_eq!(download_name("odd", "", false), "odd.md");
        assert_eq!(page_name("Report.ODT", "").map(|p| p.1), Some("fodt"));
        assert_eq!(page_name("costs.ods", "").map(|p| p.1), Some("fods"));
        assert_eq!(page_name(".md", ""), None, "nothing left for a name");
    }

    #[test]
    fn a_folder_reads_as_its_text_files_and_says_what_it_left_out() {
        let root = std::env::temp_dir().join(format!("lattice-rune-upload-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let top = root.join("Trip");
        std::fs::create_dir_all(top.join("days")).unwrap();
        std::fs::create_dir_all(top.join(".git")).unwrap();
        std::fs::write(top.join("plan.md"), "# plan\n").unwrap();
        std::fs::write(top.join("days/one.txt"), "").unwrap();
        std::fs::write(top.join("days/map.geojson"), "{}").unwrap();
        std::fs::write(top.join("photo.png"), [0x89, 0x50, 0xff, 0xfe]).unwrap();
        std::fs::write(top.join("costs.csv"), "a,b\n").unwrap();
        std::fs::write(top.join("bad.md"), [0xff, 0xfe, 0x00]).unwrap();
        std::fs::write(top.join(".git/config.md"), "hidden\n").unwrap();
        let plan = read(&top, "inbox");
        let names: Vec<(&str, &str, &str)> = plan.items.iter().map(|i| (i.name.as_str(), i.kind, i.body.as_str())).collect();
        assert_eq!(names[1..], [("inbox/trip/days/map", "geojson", "{}"), ("inbox/trip/days/one", "text", "\n"), ("inbox/trip/plan", "md", "# plan\n")]);
        // the csv came in as a spreadsheet page
        assert_eq!((names[0].0, names[0].1), ("inbox/trip/costs", "fods"));
        assert_eq!(crate::sheet::parse(names[0].2)[0].rows, vec![vec!["a", "b"]]);
        let mut skipped = plan.skipped.clone();
        skipped.sort();
        assert_eq!(skipped, ["Trip/bad.md (not text)", "Trip/photo.png (not a kind of page)"]);
        // a file called .odt that is no package says why and makes nothing
        std::fs::write(top.join("fake.odt"), "not a zip").unwrap();
        let fake = read(&top.join("fake.odt"), "");
        assert!(fake.items.is_empty());
        assert_eq!(fake.skipped, ["fake.odt (this is not a zip file)"]);
        // one file, with no folder to go under
        let one = read(&top.join("plan.md"), "");
        assert_eq!(one.items, [Item { name: "plan".into(), kind: "md", body: "# plan\n".into() }]);
        // several at once, and two that come to the same page
        let many = read_all(&[top.join("plan.md"), top.join("days"), top.join("plan.md")], "");
        let names: Vec<&str> = many.items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["plan", "days/map", "days/one"]);
        assert_eq!(many.skipped, ["plan (a second file for that page)"]);
        // a path that is not there says so and makes nothing
        let none = read(&top.join("gone.md"), "");
        assert!(none.items.is_empty() && none.skipped.len() == 1);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
