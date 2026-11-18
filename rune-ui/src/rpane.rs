//! The right pane's tabs, as the web client has them
//! (`PANES.r` in `ui-src/lattice/13-frame.js`): the page (who reads
//! it), outgoing links, backlinks, the outline, comments and history, each an icon. Which tabs there are
//! and which is in front is worked out here, and `lib.rs` draws them.

use crate::tabhead::{COMMENT, GEAR, HIST, OUT};
use rune::Icon;

crate::ribbon::line!(BACK, "lat-backlinks", "M17 7L7 17M16 17H7V8");
crate::ribbon::line!(LIST, "lat-list", "M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01");

/// What a tab of the right pane shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tab {
    /// The page itself: who reads it.
    Page,
    /// The pages this one links to.
    #[default]
    Out,
    /// The pages that link to this one.
    Back,
    /// The page's headings.
    Outline,
    Comments,
    Hist,
}

/// One icon in the pane's tab row.
#[derive(Debug)]
pub struct Cell {
    pub what: Tab,
    /// The key scripts press it by: the one its button in the header had, where it had one.
    pub key: &'static str,
    pub name: &'static str,
    pub icon: &'static Icon,
    pub on: bool,
}

/// The tab that shows for what is in front: a memory, and another
/// ship's page, have only their history, whatever was showing before.
pub fn front(asked: Tab, own_page: bool) -> Tab {
    if own_page { asked } else { Tab::Hist }
}

/// The pane's tabs, in the web client's order.
pub fn tabs(asked: Tab, own_page: bool) -> Vec<Cell> {
    let now = front(asked, own_page);
    let cell = |what, key, name, icon| Cell { what, key, name, icon, on: what == now };
    let hist = cell(Tab::Hist, "history-toggle", "History", &HIST);
    if !own_page {
        return vec![hist];
    }
    vec![cell(Tab::Page, "share", "Page", &GEAR), cell(Tab::Out, "links-toggle", "Outgoing links", &OUT), cell(Tab::Back, "backlinks-toggle", "Backlinks", &BACK), cell(Tab::Outline, "outline-toggle", "Outline", &LIST), cell(Tab::Comments, "comments-toggle-pane", "Comments", &COMMENT), hist]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_of_ones_own_has_all_six_in_the_web_clients_order() {
        let t = tabs(Tab::Comments, true);
        assert_eq!(t.iter().map(|c| c.what).collect::<Vec<_>>(), [Tab::Page, Tab::Out, Tab::Back, Tab::Outline, Tab::Comments, Tab::Hist]);
        assert_eq!(t.iter().map(|c| c.key).collect::<Vec<_>>(), ["share", "links-toggle", "backlinks-toggle", "outline-toggle", "comments-toggle-pane", "history-toggle"]);
        assert_eq!(t[0].name, "Page");
        assert_eq!(t.iter().filter(|c| c.on).map(|c| c.what).collect::<Vec<_>>(), [Tab::Comments]);
        assert!(t.iter().all(|c| !c.name.is_empty()));
    }

    #[test]
    fn a_memory_or_another_ships_page_has_only_its_history() {
        let t = tabs(Tab::Out, false);
        assert_eq!(t.iter().map(|c| (c.what, c.on)).collect::<Vec<_>>(), [(Tab::Hist, true)]);
        assert_eq!(front(Tab::Comments, false), Tab::Hist);
        assert_eq!(front(Tab::Page, false), Tab::Hist, "sharing is for a page of one's own");
        assert_eq!(front(Tab::Page, true), Tab::Page);
        assert_eq!(front(Tab::Comments, true), Tab::Comments);
    }

    #[test]
    fn outgoing_links_come_first_when_nothing_was_asked() {
        assert_eq!(front(Tab::default(), true), Tab::Out);
    }

    #[test]
    fn every_icon_has_a_name_of_its_own() {
        let mut names: Vec<_> = tabs(Tab::Out, true).iter().map(|c| c.icon.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 6);
    }
}
