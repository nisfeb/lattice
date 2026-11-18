//! The top bar, as the web client has it (`ui-src/lattice/13-frame.js`,
//! `21-tabs.js`): the tab strip with new tab and split, between the two
//! panes' toggles. What the strip holds is worked out here, and `lib.rs`
//! draws it.

use crate::ribbon::line;
use rune::Icon;

line!(PANE_LEFT, "lat-pl", "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 4v16");
line!(PANE_RIGHT, "lat-pr", "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM15 4v16");
line!(SPLIT, "lat-splitr", "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 4v16");

/// One tab in the strip.
#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    pub label: String,
    pub front: bool,
    /// It has a cross: the last tab left has none.
    pub closes: bool,
    /// Its place among the tabs, or nothing for the one cell the memories have.
    pub at: Option<usize>,
}

/// The strip's cells. The pages have their tabs, always shown, one or
/// many. The memories have no tabs: one cell names the memory in front.
pub fn strip(labels: &[String], front: usize, memory: Option<&str>) -> Vec<Cell> {
    if let Some(name) = memory {
        return vec![Cell { label: if name.is_empty() { "Knowledge".to_owned() } else { name.to_owned() }, front: true, closes: false, at: None }];
    }
    let closes = labels.len() > 1;
    labels.iter().enumerate().map(|(i, l)| Cell { label: l.clone(), front: i == front, closes, at: Some(i) }).collect()
}

/// Which of the strip's two buttons can be pressed: new tab and split.
pub fn tools(editing: bool, memory: bool, can_split: bool) -> (bool, bool) {
    let free = !editing && !memory;
    (free, free && can_split)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn one_tab_is_shown_and_has_no_cross() {
        assert_eq!(strip(&labels(&["welcome"]), 0, None), [Cell { label: "welcome".into(), front: true, closes: false, at: Some(0) }]);
    }

    #[test]
    fn many_tabs_each_close_and_one_is_in_front() {
        let got = strip(&labels(&["a", "New tab", "c"]), 1, None);
        assert_eq!(got.iter().map(|c| (c.label.as_str(), c.front, c.closes, c.at)).collect::<Vec<_>>(), [("a", false, true, Some(0)), ("New tab", true, true, Some(1)), ("c", false, true, Some(2))]);
    }

    #[test]
    fn the_memories_have_one_cell_and_no_tabs() {
        assert_eq!(strip(&labels(&["a", "b"]), 0, Some("project/rune")), [Cell { label: "project/rune".into(), front: true, closes: false, at: None }]);
        assert_eq!(strip(&labels(&["a"]), 0, Some(""))[0].label, "Knowledge");
    }

    #[test]
    fn new_tab_and_split_when_they_can_be() {
        assert_eq!(tools(false, false, true), (true, true));
        assert_eq!(tools(false, false, false), (true, false));
        assert_eq!(tools(true, false, true), (false, false), "not over an edit");
        assert_eq!(tools(false, true, true), (false, false), "the memories have neither");
    }
}
