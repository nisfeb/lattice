//! The tab header, as the web client has it
//! (`ui-src/lattice/23-tabhead.js`): back and forward, the page's name,
//! an Edit and Read switch, and the page menu. What the switch shows and
//! what the menu holds is worked out here, and `lib.rs` draws it.

use crate::ribbon::line;
use rune::Icon;

line!(LEFT, "lat-left", "M15 6l-6 6 6 6");
line!(RIGHT, "lat-right", "M9 6l6 6-6 6");
line!(DOTS, "lat-dots", "M12 5h.01M12 12h.01M12 19h.01");
line!(SAVE, "lat-save", "M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 3v5h7V3M7 21v-7h10v7");
line!(OUT, "lat-out", "M7 17L17 7M8 7h9v9");
line!(COMMENT, "lat-comment", "M4 5h16v11H9l-5 4z");
line!(HIST, "lat-hist", "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3");

/// The page menu's rows, in the web client's order: the command each
/// runs (`COMMANDS` in `lib.rs`) and what it says. Delete is last.
pub const MENU: [(&str, &str); 10] = [("copy-link", "Copy link"), ("copy-name", "Copy name"), ("duplicate", "Duplicate"), ("kind", "Change kind"), ("download", "Download"), ("pdf", "Export PDF"), ("tex", "Convert to HTML"), ("link-in", "Move into my pages"), ("link-back", "Move back to shared with me"), ("delete", "Delete")];
