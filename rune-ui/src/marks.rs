//! The left pane's Bookmarks tab, as the web client has it
//! (`ui-src/lattice/31-marks.js`): the bookmarks the reader keeps on the
//! ship, grouped by folder, with a filter. Which rows show and in which
//! order is worked out here, and `lib.rs` draws them.

use crate::api::Bookmark;

/// One row of the list.
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    /// A folder's heading, and whether what it holds is folded away.
    Folder { name: String, folded: bool },
    /// The bookmark at this place in the ship's list, under a folder or not.
    Mark { at: usize, under: bool },
}

/// What a bookmark is shown as: its title, or its address when it has none.
pub fn label(b: &Bookmark) -> &str {
    if b.title.is_empty() { &b.url } else { &b.title }
}

/// Whether the filter keeps a bookmark: the query, trimmed and in small
/// letters, is in its title, its address or its folder, in any case.
fn keeps(b: &Bookmark, q: &str) -> bool {
    q.is_empty() || [&b.title, &b.url, &b.folder].iter().any(|x| x.to_lowercase().contains(q))
}

/// The rows: folders first by name, then the bookmarks in no folder,
/// each group in the ship's order, which is newest first. A filter
/// shows every match, in a folded folder or not.
pub fn rows(marks: &[Bookmark], q: &str, folded: &[String]) -> Vec<Row> {
    let filtering = !q.trim().is_empty();
    let low = q.trim().to_lowercase();
    let shown: Vec<usize> = (0..marks.len()).filter(|&i| keeps(&marks[i], &low)).collect();
    let mut folders: Vec<&str> = shown.iter().map(|&i| marks[i].folder.as_str()).filter(|f| !f.is_empty()).collect();
    // by name whatever the case, and two that differ only in case told apart by their letters
    folders.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(b)));
    folders.dedup();
    let mut out = Vec::new();
    for f in folders {
        let away = !filtering && folded.iter().any(|x| x == f);
        out.push(Row::Folder { name: f.to_owned(), folded: away });
        if !away {
            out.extend(shown.iter().filter(|&&i| marks[i].folder == f).map(|&at| Row::Mark { at, under: true }));
        }
    }
    out.extend(shown.iter().filter(|&&i| marks[i].folder.is_empty()).map(|&at| Row::Mark { at, under: false }));
    out
}

/// Where a bookmark opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Opens {
    /// An address on the network, read by the ship.
    Urb,
    /// A web address, for the system's browser.
    Web,
    /// Neither: nothing here opens it.
    Nowhere,
}

pub fn opens(url: &str) -> Opens {
    if url.starts_with("urb://") {
        Opens::Urb
    } else if url.starts_with("https://") || url.starts_with("http://") {
        Opens::Web
    } else {
        Opens::Nowhere
    }
}

/// A change to the bookmarks, as the ship makes it (`apply-bookmark`).
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    /// Kept: the address, the title, and the folder.
    Keep(String, String, String),
    /// Moved to a folder, or out of one with none named.
    Move(String, String),
    Drop(String),
}

/// The list after a change, as the ship would have it: a bookmark kept
/// goes to the front and replaces one of the same address, a move
/// leaves the order alone, and a drop takes it out.
pub fn after(list: &[Bookmark], change: &Change) -> Vec<Bookmark> {
    match change {
        Change::Keep(url, title, folder) => {
            let mut out = vec![Bookmark { url: url.clone(), title: title.clone(), folder: folder.clone() }];
            out.extend(list.iter().filter(|b| b.url != *url).cloned());
            out
        }
        Change::Move(url, folder) => list.iter().cloned().map(|b| if b.url == *url { Bookmark { folder: folder.clone(), ..b } } else { b }).collect(),
        Change::Drop(url) => list.iter().filter(|b| b.url != *url).cloned().collect(),
    }
}

/// What is said once a change is made.
pub fn said(change: &Change) -> String {
    match change {
        Change::Keep(..) => "Bookmark kept".to_owned(),
        Change::Move(_, f) if f.is_empty() => "Moved out of its folder".to_owned(),
        Change::Move(_, f) => format!("Moved to {f}"),
        Change::Drop(_) => "Bookmark removed".to_owned(),
    }
}

/// Whether an address is among the bookmarks.
pub fn has(list: &[Bookmark], url: &str) -> bool {
    list.iter().any(|b| b.url == url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bookmark_kept_goes_to_the_front_and_replaces_its_like() {
        let got = after(&list(), &Change::Keep("urb://~nec/x".into(), "Nec".into(), "".into()));
        assert_eq!(got.len(), 5);
        assert_eq!(got[0], b("urb://~nec/x", "Nec", ""));
        assert_eq!(got[1], list()[0]);
        let got = after(&list(), &Change::Keep("urb://~new/y".into(), "".into(), "f".into()));
        assert_eq!((got.len(), &got[0]), (6, &b("urb://~new/y", "", "f")));
    }

    #[test]
    fn a_move_changes_the_folder_and_nothing_else() {
        let got = after(&list(), &Change::Move("https://example.com/a".into(), "".into()));
        assert_eq!(got[1], b("https://example.com/a", "", ""));
        assert_eq!([&got[0], &got[2], &got[3], &got[4]], [&list()[0], &list()[2], &list()[3], &list()[4]]);
        assert_eq!(after(&list(), &Change::Move("not there".into(), "f".into())), list());
    }

    #[test]
    fn a_drop_takes_one_out() {
        let got = after(&list(), &Change::Drop("urb://~bus/forum/chat".into()));
        assert_eq!(got.len(), 4);
        assert!(!has(&got, "urb://~bus/forum/chat") && has(&got, "urb://~zod/notes"));
    }

    #[test]
    fn what_is_said_of_each_change() {
        assert_eq!(said(&Change::Keep("u".into(), "".into(), "".into())), "Bookmark kept");
        assert_eq!(said(&Change::Move("u".into(), "reading".into())), "Moved to reading");
        assert_eq!(said(&Change::Move("u".into(), "".into())), "Moved out of its folder");
        assert_eq!(said(&Change::Drop("u".into())), "Bookmark removed");
    }

    fn b(url: &str, title: &str, folder: &str) -> Bookmark {
        Bookmark { url: url.into(), title: title.into(), folder: folder.into() }
    }

    fn list() -> Vec<Bookmark> {
        vec![b("urb://~zod/notes", "Zod's notes", ""), b("https://example.com/a", "", "web"), b("urb://~bus/forum/chat", "Chat", "Boards"), b("https://example.com/b", "B page", "web"), b("urb://~nec/x", "", "")]
    }

    #[test]
    fn a_bookmark_with_no_title_shows_its_address() {
        assert_eq!(label(&b("urb://~zod/a", "A", "")), "A");
        assert_eq!(label(&b("urb://~zod/a", "", "")), "urb://~zod/a");
    }

    #[test]
    fn folders_first_by_name_then_the_unfiled_in_the_ships_order() {
        let f = |name: &str| Row::Folder { name: name.into(), folded: false };
        let m = |at, under| Row::Mark { at, under };
        assert_eq!(rows(&list(), "", &[]), [f("Boards"), m(2, true), f("web"), m(1, true), m(3, true), m(0, false), m(4, false)]);
    }

    #[test]
    fn a_folded_folder_keeps_its_heading_and_hides_what_it_holds() {
        let got = rows(&list(), "", &["web".to_owned()]);
        assert!(got.contains(&Row::Folder { name: "web".into(), folded: true }));
        assert!(!got.contains(&Row::Mark { at: 1, under: true }) && !got.contains(&Row::Mark { at: 3, under: true }));
        assert!(got.contains(&Row::Mark { at: 2, under: true }));
    }

    #[test]
    fn a_filter_reads_title_address_and_folder_and_opens_folded_folders() {
        let folded = ["web".to_owned()];
        // by address, inside a folded folder
        assert_eq!(rows(&list(), "EXAMPLE.com/a", &folded), [Row::Folder { name: "web".into(), folded: false }, Row::Mark { at: 1, under: true }]);
        // by title
        assert_eq!(rows(&list(), " zod's ", &[]), [Row::Mark { at: 0, under: false }]);
        // by folder
        assert_eq!(rows(&list(), "boards", &[]), [Row::Folder { name: "Boards".into(), folded: false }, Row::Mark { at: 2, under: true }]);
        assert_eq!(rows(&list(), "nothing like it", &[]), []);
    }

    #[test]
    fn where_a_bookmark_opens() {
        assert_eq!(opens("urb://~zod/notes"), Opens::Urb);
        assert_eq!(opens("https://example.com"), Opens::Web);
        assert_eq!(opens("http://example.com"), Opens::Web);
        assert_eq!(opens("javascript:alert(1)"), Opens::Nowhere);
        assert_eq!(opens("file:///etc/passwd"), Opens::Nowhere);
        assert_eq!(opens(""), Opens::Nowhere);
    }
}
