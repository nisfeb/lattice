//! The right pane's tabs, as the web client has them
//! (`PANES.r` in `ui-src/lattice/13-frame.js`): the page (who reads
//! it), outgoing links, backlinks, the outline, comments and history, each an icon.

use crate::ribbon::{BACK, GEAR};
use crate::tabhead::{COMMENT, HIST, OUT};
use rune::Icon;

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

/// The pane's tabs, in the web client's order: what each shows, the key
/// scripts press it by (the one its button in the header had, where it
/// had one), its name and its icon.
pub const TABS: [(Tab, &str, &str, &Icon); 6] = [
    (Tab::Page, "share", "Page", &GEAR),
    (Tab::Out, "links-toggle", "Outgoing links", &OUT),
    (Tab::Back, "backlinks-toggle", "Backlinks", &BACK),
    (Tab::Outline, "outline-toggle", "Outline", &LIST),
    (Tab::Comments, "comments-toggle-pane", "Comments", &COMMENT),
    (Tab::Hist, "history-toggle", "History", &HIST),
];
