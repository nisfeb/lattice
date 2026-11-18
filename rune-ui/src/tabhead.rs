//! The tab header, as the web client has it
//! (`ui-src/lattice/23-tabhead.js`): back and forward, the page's name,
//! an Edit and Read switch, and the page menu. What the switch shows and
//! what the menu holds is worked out here, and `lib.rs` draws it.

use crate::ribbon::line;
use rune::Icon;

line!(LEFT, "lat-left", "M15 6l-6 6 6 6");
line!(RIGHT, "lat-right", "M9 6l6 6-6 6");
line!(DOTS, "lat-dots", "M12 5h.01M12 12h.01M12 19h.01");
line!(EYE, "lat-eye", "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0");
line!(SAVE, "lat-save", "M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 3v5h7V3M7 21v-7h10v7");
line!(GEAR, "lat-page", "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1");
line!(OUT, "lat-out", "M7 17L17 7M8 7h9v9");
line!(COMMENT, "lat-comment", "M4 5h16v11H9l-5 4z");
line!(HIST, "lat-hist", "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3");

/// The Edit and Read switch: whether it shows at all, which side is on,
/// and whether Edit can be pressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Switch {
    pub shown: bool,
    pub editing: bool,
    pub can_edit: bool,
}

/// The switch for what is in front: a page shows it, a screen that is
/// no page (the forum, the inbox, a folder) does not.
pub fn switch(page: bool, editing: bool, can_edit: bool) -> Switch {
    Switch { shown: page, editing: page && editing, can_edit }
}

/// One row of the page menu: the command it runs (`COMMANDS` in
/// `lib.rs`), what it says, and whether it is the dangerous kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: &'static str,
    pub label: &'static str,
    pub danger: bool,
}

/// The page menu's rows, in the web client's order, for the commands
/// that can run now. Delete is last.
pub fn menu(usable: impl Fn(&str) -> bool) -> Vec<Item> {
    const ALL: &[(&str, &str)] = &[("copy-link", "Copy link"), ("copy-name", "Copy name"), ("duplicate", "Duplicate"), ("download", "Download"), ("pdf", "Export PDF"), ("tex", "Convert to HTML"), ("delete", "Delete")];
    ALL.iter().filter(|(id, _)| usable(id)).map(|&(id, label)| Item { id, label, danger: id == "delete" }).collect()
}

/// The key a script presses a menu row by: rune-kit keys rows by their place.
pub fn menu_key(items: &[Item], id: &str) -> Option<String> {
    items.iter().position(|i| i.id == id).map(|at| format!("page-menu-item{at}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switch_shows_for_a_page_and_says_which_side() {
        assert_eq!(switch(true, false, true), Switch { shown: true, editing: false, can_edit: true });
        assert_eq!(switch(true, true, true), Switch { shown: true, editing: true, can_edit: true });
        assert!(!switch(false, false, true).shown, "a screen that is no page has none");
        let read_only = switch(true, false, false);
        assert!(read_only.shown && !read_only.can_edit, "a page that cannot be edited still says it is being read");
    }

    #[test]
    fn the_menu_in_the_web_clients_order_with_delete_last() {
        let all = menu(|_| true);
        assert_eq!(all.iter().map(|i| i.id).collect::<Vec<_>>(), ["copy-link", "copy-name", "duplicate", "download", "pdf", "tex", "delete"]);
        assert_eq!(all.iter().filter(|i| i.danger).map(|i| i.id).collect::<Vec<_>>(), ["delete"]);
        assert!(all.iter().all(|i| !i.label.is_empty()));
    }

    #[test]
    fn only_what_can_run_is_listed() {
        let some = menu(|id| matches!(id, "copy-name" | "download" | "delete"));
        assert_eq!(some.iter().map(|i| i.id).collect::<Vec<_>>(), ["copy-name", "download", "delete"]);
        assert!(menu(|_| false).is_empty());
    }

    #[test]
    fn a_row_is_pressed_by_its_place() {
        let some = menu(|id| matches!(id, "copy-name" | "download" | "delete"));
        assert_eq!(menu_key(&some, "delete").as_deref(), Some("page-menu-item2"));
        assert_eq!(menu_key(&some, "copy-name").as_deref(), Some("page-menu-item0"));
        assert_eq!(menu_key(&some, "pdf"), None);
    }
}
