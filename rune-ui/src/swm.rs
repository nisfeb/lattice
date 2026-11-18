//! Shared with me, as a folder in the files tree, the way the web client
//! has it (`ui-src/lattice/69-shared.js`): "shared with me", a folder for
//! each ship, and under it each page that ship shared, by its own name
//! there. A folder shared whole is one entry, which reads as `folder/`.
//! What the rows are and what each stands for is worked out here.

use crate::api::Shared;

/// The folder's place in the tree. A leading space is in no page's name,
/// so no page can stand where these rows do.
pub const ROOT: &str = " shared";

/// The folder's name as shown.
pub const LABEL: &str = "shared with me";

/// Whether an entry is a folder shared whole: it names the folder's index.
pub fn is_dir(path: &str) -> bool {
    dir_rel(path).is_some()
}

/// A shared folder's path on its host, with its leading slash.
fn dir_rel(path: &str) -> Option<&str> {
    let rest = path.split_once("/page/")?.1.strip_suffix("/dir-index")?;
    (!rest.is_empty()).then(|| &path[path.len() - "/dir-index".len() - rest.len() - 1..path.len() - "/dir-index".len()])
}

/// An entry's name on its host: a page's own, or a folder's with a slash after it.
pub fn name(path: &str) -> String {
    if let Some(rel) = dir_rel(path) {
        return format!("{}/", &rel[1..]);
    }
    match path.split_once("/page/").and_then(|(_, r)| r.strip_suffix("/code")) {
        Some(n) => n.to_owned(),
        None => path.trim_start_matches('/').to_owned(),
    }
}

/// The last part of a page's name: what a link to it is called when moved into the tree.
pub fn leaf(path: &str) -> String {
    let n = name(path);
    n.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_owned()
}

/// The address a shared folder is read at.
pub fn address(host: &str, path: &str) -> Option<String> {
    dir_rel(path).map(|rel| format!("urb://{host}{rel}/"))
}

/// A ship's folder in the tree.
pub fn host_id(host: &str) -> String {
    format!("{ROOT}/{host}")
}

/// An entry's row in the tree.
pub fn row_id(sh: &Shared) -> String {
    format!("{ROOT}/{}/{}", sh.host, sh.path)
}

/// Whether a row of the tree is this folder's, or one under it.
pub fn is_ours(id: &str) -> bool {
    id == ROOT || id.strip_prefix(ROOT).is_some_and(|r| r.starts_with('/'))
}

/// The entry a row of the tree stands for.
pub fn at<'a>(list: &'a [Shared], id: &str) -> Option<&'a Shared> {
    let rest = id.strip_prefix(ROOT)?.strip_prefix('/')?;
    list.iter().find(|sh| rest.strip_prefix(sh.host.as_str()).and_then(|r| r.strip_prefix('/')) == Some(sh.path.as_str()))
}

/// The ships that shared something, in order, each with its entries by name.
pub fn hosts(list: &[Shared]) -> Vec<(&str, Vec<&Shared>)> {
    let mut hosts: Vec<&str> = list.iter().map(|s| s.host.as_str()).collect();
    hosts.sort_unstable();
    hosts.dedup();
    hosts
        .into_iter()
        .map(|h| {
            let mut mine: Vec<&Shared> = list.iter().filter(|s| s.host == h).collect();
            mine.sort_by_key(|s| name(&s.path));
            (h, mine)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(host: &str, path: &str) -> Shared {
        Shared { host: host.into(), path: path.into(), mode: "read".into(), when: String::new() }
    }

    #[test]
    fn a_page_reads_by_its_own_name_and_a_folder_with_a_slash() {
        assert_eq!(name("/apps/lattice/page/notes/plan/code"), "notes/plan");
        assert_eq!(name("/x/page/trip/dir-index"), "trip/");
        assert_eq!(name("/x/page/a/b/dir-index"), "a/b/");
        assert_eq!(name("/odd/path"), "odd/path", "a path with no such part is shown whole");
        assert!(is_dir("/x/page/trip/dir-index") && !is_dir("/x/page/trip/code") && !is_dir("/x/page/dir-index"));
        assert_eq!((leaf("/x/page/notes/plan/code"), leaf("/x/page/a/b/dir-index")), ("plan".to_owned(), "b".to_owned()));
    }

    #[test]
    fn a_shared_folder_is_read_at_its_address() {
        assert_eq!(address("~sampel-palnet", "/x/page/trip/dir-index").as_deref(), Some("urb://~sampel-palnet/trip/"));
        assert_eq!(address("~bus", "/x/page/a/b/dir-index").as_deref(), Some("urb://~bus/a/b/"));
        assert_eq!(address("~bus", "/x/page/a/code"), None);
    }

    #[test]
    fn ships_in_order_each_with_its_entries_by_name() {
        let list = [sh("~wex", "/x/page/b/code"), sh("~bus", "/x/page/z/code"), sh("~wex", "/x/page/a/dir-index"), sh("~bus", "/x/page/c/d/code")];
        let got: Vec<(&str, Vec<String>)> = hosts(&list).into_iter().map(|(h, e)| (h, e.into_iter().map(|s| name(&s.path)).collect())).collect();
        assert_eq!(got, [("~bus", vec!["c/d".to_owned(), "z".to_owned()]), ("~wex", vec!["a/".to_owned(), "b".to_owned()])]);
    }

    #[test]
    fn a_row_of_the_tree_finds_its_entry_and_no_page_stands_there() {
        let list = [sh("~bus", "/x/page/z/code"), sh("~bus-two", "/x/page/z/code")];
        assert_eq!(row_id(&list[0]), " shared/~bus//x/page/z/code");
        assert_eq!(at(&list, &row_id(&list[0])), Some(&list[0]));
        assert_eq!(at(&list, &row_id(&list[1])), Some(&list[1]), "one ship's name at the start of another's");
        assert_eq!(at(&list, &host_id("~bus")), None);
        assert_eq!(at(&list, "notes/plan"), None);
        assert!(is_ours(ROOT) && is_ours(&host_id("~bus")) && is_ours(&row_id(&list[0])));
        assert!(!is_ours("shared") && !is_ours(" sharedx") && !is_ours("notes/ shared"));
        assert!(!crate::api::valid_name(ROOT), "no page can be named as the folder is");
    }
}
