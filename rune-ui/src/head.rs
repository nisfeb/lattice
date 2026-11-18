//! The head of the left pane, as the web client has it
//! (`ui-src/lattice/13-frame.js` for the tabs, `30-tree.js` for the
//! toolbar): icon tabs for files and knowledge, a toolbar of icons over
//! the tree, and the order the tree is sorted in. What is in each is
//! worked out here, and `lib.rs` draws it.

use std::cmp::Ordering;

use crate::ribbon::line;
use rune::Icon;

line!(DOC, "lat-doc", "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5");
line!(KNOW, "lat-know", "M12 3l8 9-8 9-8-9z");
line!(SEARCH, "lat-search", "M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0M16 16l5 5");
line!(QOPEN, "lat-qopen", "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4M14 3l5 5v3M14 3v5h5M13 16a3 3 0 1 0 6 0a3 3 0 1 0-6 0M18.2 18.2L21 21");
line!(PLUS, "lat-plus", "M12 5v14M5 12h14");
line!(TPL, "lat-tpl", "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM3 9h18M9 9v12");
line!(UPLOAD, "lat-upload", "M12 16V4M7 9l5-5 5 5M4 20h16");
line!(UPDIR, "lat-updir", "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 16v-6M9 13l3-3 3 3");
line!(PEN, "lat-pen", "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z");
line!(SORT, "lat-sort", "M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4");
line!(FOLD, "lat-fold", "M7 15l5 5 5-5M7 9l5-5 5 5");

/// What a tab shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Half {
    Files,
    Knowledge,
    Search,
}

/// One of the pane's tabs.
#[derive(Debug)]
pub struct Tab {
    pub what: Half,
    /// The key scripts press it by: the one its word button had.
    pub key: &'static str,
    pub name: &'static str,
    pub keys: Option<&'static str>,
    pub icon: &'static Icon,
    pub on: bool,
    /// The name with how many it holds, for a screen reader.
    pub said: String,
}

/// The tabs: files, knowledge, then search. `memory` is which half of
/// the tree is showing, and `searching` that the search is over it.
pub fn tabs(memory: bool, searching: bool, pages: usize, knows: usize) -> [Tab; 3] {
    let n = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    [
        Tab { what: Half::Files, key: "half-pages", name: "Files", keys: Some("Ctrl+Shift+L"), icon: &DOC, on: !memory && !searching, said: format!("Files, {}", n(pages, "page", "pages")) },
        Tab { what: Half::Knowledge, key: "half-memory", name: "Knowledge", keys: None, icon: &KNOW, on: memory && !searching, said: format!("Knowledge, {}", n(knows, "memory", "memories")) },
        Tab { what: Half::Search, key: "half-search", name: "Search", keys: Some("Ctrl+Shift+F"), icon: &SEARCH, on: searching, said: "Search".to_owned() },
    ]
}

/// What a press on a tool does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Do {
    Open,
    New,
    Template,
    Upload,
    UploadFolder,
    Capture,
    Sort,
    Fold,
}

/// One icon in the toolbar over the tree.
#[derive(Debug)]
pub struct Tool {
    pub act: Do,
    pub key: &'static str,
    pub name: &'static str,
    pub keys: Option<&'static str>,
    pub icon: &'static Icon,
    /// After the gap, at the toolbar's far end: what changes how the tree shows.
    pub end: bool,
}

/// The toolbar's tools, in the web client's order. The memories have
/// no templates, uploads or inbox, so their toolbar is shorter.
pub fn tools(memory: bool, desc: bool) -> Vec<Tool> {
    let t = |act, key, name, icon| Tool { act, key, name, keys: None, icon, end: false };
    let mut out = Vec::new();
    if memory {
        out.push(t(Do::New, "new", "New memory", &PLUS));
    } else {
        out.push(Tool { keys: Some("Ctrl+O"), ..t(Do::Open, "jump-open", "Open a page", &QOPEN) });
        out.push(t(Do::New, "new", "New page", &PLUS));
        out.push(t(Do::Template, "new-template", "New from template", &TPL));
        out.push(t(Do::Upload, "upload-files", "Upload files", &UPLOAD));
        out.push(t(Do::UploadFolder, "upload-folder", "Upload a folder", &UPDIR));
        out.push(t(Do::Capture, "capture", "Capture a page to the inbox", &PEN));
    }
    out.push(Tool { end: true, ..t(Do::Sort, "tree-sort", if desc { "Sort: name, descending" } else { "Sort: name" }, &SORT) });
    out.push(Tool { end: true, ..t(Do::Fold, "tree-fold", "Collapse all", &FOLD) });
    out
}

/// The heading over the tree.
pub fn heading(memory: bool) -> &'static str {
    if memory { "KNOWLEDGE" } else { "FILES" }
}

/// What a row is sorted by: its own part of the path, or the whole of
/// its name when the row stands for several folders at once (`a/b/c`).
/// A name given to a page is not what it is sorted by, as on the web.
pub fn sort_key<'a>(path: &'a str, name: &'a str) -> &'a str {
    if name.contains('/') && path.ends_with(name) { name } else { path.rsplit('/').next().unwrap_or(path) }
}

/// The tree's order among the rows of one folder: folders first either
/// way, then by name in natural order, turned round when `desc`. Two
/// names that order calls equal are told apart by their bytes.
pub fn order(a: (bool, &str), b: (bool, &str), desc: bool) -> Ordering {
    if a.0 != b.0 {
        return if a.0 { Ordering::Less } else { Ordering::Greater };
    }
    let by = rune_kit::natural_cmp(a.1, b.1).then_with(|| a.1.cmp(b.1));
    if desc { by.reverse() } else { by }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tabs_keep_their_keys_and_say_their_counts() {
        let t = tabs(false, false, 7, 1);
        assert_eq!([t[0].key, t[1].key, t[2].key], ["half-pages", "half-memory", "half-search"]);
        assert!(t[0].on && !t[1].on);
        assert_eq!(t[0].said, "Files, 7 pages");
        assert_eq!(t[1].said, "Knowledge, 1 memory");
        let t = tabs(true, false, 1, 0);
        assert!(!t[0].on && t[1].on && !t[2].on);
        assert_eq!(t[0].said, "Files, 1 page");
        assert_eq!(t[1].said, "Knowledge, 0 memories");
    }

    #[test]
    fn searching_is_the_only_tab_marked_whichever_half_is_under_it() {
        for memory in [false, true] {
            let t = tabs(memory, true, 0, 0);
            assert_eq!(t.iter().filter(|t| t.on).map(|t| t.what).collect::<Vec<_>>(), [Half::Search]);
        }
        assert_eq!(tabs(false, true, 0, 0)[2].keys, Some("Ctrl+Shift+F"));
    }

    #[test]
    fn the_tools_in_the_web_clients_order() {
        let t = tools(false, false);
        let keys: Vec<_> = t.iter().map(|t| t.key).collect();
        assert_eq!(keys, ["jump-open", "new", "new-template", "upload-files", "upload-folder", "capture", "tree-sort", "tree-fold"]);
        let end: Vec<_> = t.iter().filter(|t| t.end).map(|t| t.act).collect();
        assert_eq!(end, [Do::Sort, Do::Fold]);
        assert_eq!(t[0].keys, Some("Ctrl+O"));
        assert_eq!(t[1].name, "New page");
    }

    #[test]
    fn the_memories_toolbar_is_shorter() {
        let t = tools(true, false);
        let acts: Vec<_> = t.iter().map(|t| t.act).collect();
        assert_eq!(acts, [Do::New, Do::Sort, Do::Fold]);
        assert_eq!(t[0].name, "New memory");
        assert_eq!(t[0].key, "new");
    }

    #[test]
    fn the_sort_tool_says_which_way() {
        let name = |desc| tools(false, desc).into_iter().find(|t| t.act == Do::Sort).unwrap().name;
        assert_eq!(name(false), "Sort: name");
        assert_eq!(name(true), "Sort: name, descending");
    }

    #[test]
    fn the_heading_names_the_half() {
        assert_eq!(heading(false), "FILES");
        assert_eq!(heading(true), "KNOWLEDGE");
    }

    #[test]
    fn folders_stay_first_and_names_turn_round() {
        let mut rows = vec![(false, "b"), (true, "z"), (false, "a10"), (false, "a2"), (true, "m")];
        rows.sort_by(|a, b| order(*a, *b, false));
        assert_eq!(rows, [(true, "m"), (true, "z"), (false, "a2"), (false, "a10"), (false, "b")]);
        rows.sort_by(|a, b| order(*a, *b, true));
        assert_eq!(rows, [(true, "z"), (true, "m"), (false, "b"), (false, "a10"), (false, "a2")]);
    }

    #[test]
    fn a_row_is_sorted_by_its_path_and_not_its_given_name() {
        assert_eq!(sort_key("notes/today", "Today's Notes"), "today");
        assert_eq!(sort_key("top", "top"), "top");
        // a row standing for several folders keeps all of them
        assert_eq!(sort_key("docs/guide/intro", "guide/intro"), "guide/intro");
        // a given name with a slash in it is still not the key
        assert_eq!(sort_key("a/b", "either/or"), "b");
    }

    #[test]
    fn every_icon_has_a_name_of_its_own() {
        let mut names: Vec<_> = tools(false, false).iter().map(|t| t.icon.name).chain(tabs(false, false, 0, 0).iter().map(|t| t.icon.name)).collect();
        let n = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), n);
    }
}
