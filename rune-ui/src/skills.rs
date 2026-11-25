//! Skills store model, validation, and helpers, ported from
//! `code/nex/lattice/ui-app/skills.js`.

/// One row from `GET /skills`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SkillRow {
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub updated: String,
    pub author: String,
    pub sensitive: bool,
    pub superseded_by: Option<String>,
    pub files: usize,
}

/// One attached file listed by `GET /skill`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SkillFile {
    pub path: String,
    pub bytes: usize,
}

/// Full skill payload from `GET /skill?name=...`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SkillDetail {
    pub name: String,
    pub description: String,
    pub body: String,
    pub tags: Vec<String>,
    pub updated: String,
    pub author: String,
    pub sensitive: bool,
    pub superseded_by: Option<String>,
    pub files: Vec<SkillFile>,
}

/// One revision entry from `GET /skill-history`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SkillRev {
    pub rev: u64,
    pub updated: String,
}

/// One deleted skill entry from `GET /skill-trash`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SkillTrashRow {
    pub name: String,
    pub updated: String,
}

/// Validates a skill name: 1..=64 lowercase ASCII letters, digits, and single internal hyphens.
pub fn valid_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let bytes = name.as_bytes();
    if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
        return false;
    }
    let mut prev_hyphen = false;
    for &b in bytes {
        if b == b'-' {
            if prev_hyphen {
                return false;
            }
            prev_hyphen = true;
        } else if b.is_ascii_lowercase() || b.is_ascii_digit() {
            prev_hyphen = false;
        } else {
            return false;
        }
    }
    true
}

/// Validates a skill file path: slash-separated segments of `[A-Za-z0-9._-]`,
/// no `.` or `..` segments, ending in `.md`, `.txt`, `.json`, `.yaml`, or `.yml`.
pub fn valid_path(path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.ends_with('/') {
        return false;
    }
    for seg in path.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return false;
        }
        if !seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
            return false;
        }
    }
    let low = path.to_ascii_lowercase();
    [".md", ".txt", ".json", ".yaml", ".yml"].iter().any(|ext| low.ends_with(ext))
}

/// Splits leading YAML front matter (`---\n...\n---\n`) from a Markdown skill body.
pub fn split_front_matter(text: &str) -> (&str, &str) {
    let rest = if let Some(r) = text.strip_prefix("---\r\n") {
        r
    } else if let Some(r) = text.strip_prefix("---\n") {
        r
    } else {
        return ("", text);
    };
    let mut pos = 0;
    for line in rest.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if bare == "---" {
            let fm = rest[..pos].trim_end_matches(['\r', '\n']);
            let body = &rest[pos + line.len()..];
            return (fm, body);
        }
        pos += line.len();
    }
    ("", text)
}

/// Starter `SKILL.md` template for a newly created skill.
pub fn new_skill_template(name: &str) -> String {
    format!("---\nname: {name}\ndescription: What this skill does, and when an agent should use it.\n---\n\n# {name}\n\n")
}

/// Starter body for a newly created auxiliary file inside a skill.
pub fn new_file_template(path: &str) -> String {
    if path.to_ascii_lowercase().ends_with(".md") {
        let leaf = path.rsplit('/').next().unwrap_or(path);
        let stem = leaf.strip_suffix(".md").or_else(|| leaf.strip_suffix(".MD")).unwrap_or(leaf);
        format!("# {stem}\n")
    } else {
        "\n".to_owned()
    }
}

/// Sorted unique tags present across all loaded skills.
pub fn all_tags(list: &[SkillRow]) -> Vec<String> {
    let mut set: Vec<String> = list.iter().flat_map(|s| s.tags.iter().cloned()).collect();
    set.sort();
    set.dedup();
    set
}

/// Filters skills by selected tag and case-insensitive substring match over name and description.
pub fn filter_skills<'a>(list: &'a [SkillRow], query: &str, tag: &str) -> Vec<&'a SkillRow> {
    let q = query.trim().to_lowercase();
    list.iter()
        .filter(|s| {
            (tag.is_empty() || s.tags.iter().any(|t| t == tag))
                && (q.is_empty() || s.name.contains(&q) || s.description.to_lowercase().contains(&q))
        })
        .collect()
}

/// Validates a local ball grub path for `/grub-source` and `/grub-save`.
pub fn valid_grub_path(path: &str) -> bool {
    let t = path.trim();
    if !t.starts_with('/') || t.len() <= 1 || t.bytes().any(|b| b <= 0x20 || b == 0x7f || b == b'\\') {
        return false;
    }
    !t.split('/').any(|seg| seg == "." || seg == "..")
}

/// Infers a syntax-highlighting kind from a grub's blot/mark or path extension.
pub fn grub_kind(blot: &str, path: &str) -> String {
    let tail = blot.rsplit('/').next().unwrap_or("");
    let from_ext = |s: &str| match s.to_ascii_lowercase().as_str() {
        "md" | "markdown" => Some("md"),
        "hoon" => Some("hoon"),
        "js" | "mjs" | "cjs" => Some("js"),
        "css" => Some("css"),
        "html" | "htm" => Some("html"),
        "json" => Some("json"),
        "tex" | "latex" => Some("tex"),
        "gmi" | "gemtext" => Some("gmi"),
        "scad" => Some("scad"),
        "txt" | "text" => Some("txt"),
        _ => None,
    };
    if let Some(k) = from_ext(tail) {
        return k.to_owned();
    }
    if let Some((_, ext)) = path.rsplit('/').next().unwrap_or("").rsplit_once('.') {
        if let Some(k) = from_ext(ext) {
            return k.to_owned();
        }
    }
    "hoon".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_skill_names_and_paths() {
        assert!(valid_name("release-notes"));
        assert!(valid_name("a"));
        assert!(valid_name("deploy-2026"));
        assert!(!valid_name(""));
        assert!(!valid_name("-lead"));
        assert!(!valid_name("trail-"));
        assert!(!valid_name("double--dash"));
        assert!(!valid_name("Upper"));
        assert!(!valid_name(&"a".repeat(65)));

        assert!(valid_path("reference/notes.md"));
        assert!(valid_path("config.yaml"));
        assert!(!valid_path(""));
        assert!(!valid_path("/abs.md"));
        assert!(!valid_path("../escape.md"));
        assert!(!valid_path("a/./b.md"));
        assert!(!valid_path("script.sh"));
    }

    #[test]
    fn splits_front_matter_and_filters() {
        let (fm, rest) = split_front_matter("---\nname: demo\ndescription: hi\n---\n\n# Demo\n");
        assert_eq!(fm, "name: demo\ndescription: hi");
        assert_eq!(rest, "\n# Demo\n");
        assert_eq!(split_front_matter("# No fm\n"), ("", "# No fm\n"));

        let list = vec![
            SkillRow { name: "deploy".into(), description: "Ship release".into(), tags: vec!["core".into(), "ops".into()], ..Default::default() },
            SkillRow { name: "review".into(), description: "PR checklist".into(), tags: vec!["dev".into()], ..Default::default() },
        ];
        assert_eq!(all_tags(&list), vec!["core", "dev", "ops"]);
        assert_eq!(filter_skills(&list, "release", "").len(), 1);
        assert_eq!(filter_skills(&list, "", "dev")[0].name, "review");
    }

    #[test]
    fn validates_grub_paths_and_kinds() {
        assert!(valid_grub_path("/apps/lattice/app/index.html"));
        assert!(!valid_grub_path("relative/path"));
        assert!(!valid_grub_path("/apps/../secret"));
        assert!(!valid_grub_path("/apps/\\bad"));
        assert_eq!(grub_kind("/js", "/apps/x/foo"), "js");
        assert_eq!(grub_kind("/mime", "/apps/x/style.css"), "css");
        assert_eq!(grub_kind("/unknown", "/apps/x/thing"), "hoon");
    }
}
