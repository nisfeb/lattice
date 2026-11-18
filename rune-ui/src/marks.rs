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

/// Whether the filter keeps a bookmark: what is typed is in its title,
/// its address or its folder, in any case.
pub fn keeps(b: &Bookmark, q: &str) -> bool {
    let q = q.trim().to_lowercase();
    q.is_empty() || [&b.title, &b.url, &b.folder].iter().any(|x| x.to_lowercase().contains(&q))
}

/// The rows: folders first by name, then the bookmarks in no folder,
/// each group in the ship's order, which is newest first. A filter
/// shows every match, in a folded folder or not.
pub fn rows(marks: &[Bookmark], q: &str, folded: &[String]) -> Vec<Row> {
    let filtering = !q.trim().is_empty();
    let shown: Vec<usize> = (0..marks.len()).filter(|&i| keeps(&marks[i], q)).collect();
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

/// What is said when there are no rows.
pub fn none(q: &str) -> &'static str {
    if q.trim().is_empty() { "No bookmarks yet" } else { "No bookmark matches that" }
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn what_is_said_with_no_rows() {
        assert_eq!(none(""), "No bookmarks yet");
        assert_eq!(none(" x "), "No bookmark matches that");
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
