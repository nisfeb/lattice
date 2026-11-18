//! The top bar, as the web client has it (`ui-src/lattice/13-frame.js`,
//! `21-tabs.js`): the tab strip with new tab and split, between the two
//! panes' toggles. Its icons are here, and how a moved tab is followed.

use crate::ribbon::line;
use rune::Icon;

line!(PANE_LEFT, "lat-pl", "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 4v16");
line!(PANE_RIGHT, "lat-pr", "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM15 4v16");
line!(SPLIT_DOWN, "lat-splitd", "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 12h18");
line!(SPLIT, "lat-splitr", "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 4v16");

/// Moves what stands at `from` to stand at `to`, the rest closing up
/// and making way. A place that is not there moves nothing.
pub fn move_in<T>(v: &mut Vec<T>, from: usize, to: usize) {
    if from < v.len() {
        let one = v.remove(from);
        v.insert(to.min(v.len()), one);
    }
}

/// Where the tab in front stands once the tab at `from` is moved to `to`.
pub fn front_after(front: usize, from: usize, to: usize) -> usize {
    if front == from {
        to
    } else if from < front && front <= to {
        front - 1
    } else if to <= front && front < from {
        front + 1
    } else {
        front
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tab_moved_makes_the_rest_close_up_and_make_way() {
        let moved = |from, to| {
            let mut v = vec!['a', 'b', 'c', 'd'];
            move_in(&mut v, from, to);
            v.into_iter().collect::<String>()
        };
        assert_eq!(moved(0, 2), "bcad");
        assert_eq!(moved(3, 0), "dabc");
        assert_eq!(moved(1, 1), "abcd");
        assert_eq!(moved(0, 9), "bcda", "past the end is the end");
        assert_eq!(moved(9, 0), "abcd", "nothing stands there");
    }

    #[test]
    fn the_tab_in_front_is_followed_through_a_move() {
        // the one in front is the one moved
        assert_eq!(front_after(0, 0, 2), 2);
        // one moved from before it to after it: it steps back
        assert_eq!(front_after(2, 0, 3), 1);
        // one moved from after it to before it: it steps on
        assert_eq!(front_after(1, 3, 0), 2);
        // a move wholly to one side leaves it
        assert_eq!(front_after(0, 2, 3), 0);
        assert_eq!(front_after(3, 0, 1), 3);
        assert_eq!(front_after(1, 1, 1), 1);
    }

    fn labels(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| (*s).to_owned()).collect()
    }
}
