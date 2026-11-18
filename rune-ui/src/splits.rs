//! Splits, by the web client's rules (`ui-src/lattice/28-splits.js`):
//! groups side by side or one above the other, and the least room a
//! group needs, under which a split is refused. What a press on a split
//! button does is worked out here.

/// The least a group may be, in points: across for a split across, down for a split down.
pub const LEAST_W: f32 = 360.0;
pub const LEAST_H: f32 = 200.0;

/// The most groups there can be. The web client has no such number, only
/// the least size. Here a group's sheet is held in one of a fixed few
/// places, since rune-kit's table reaches its state by a plain function.
pub const MOST: usize = 4;

/// Why the room cannot be split into `n` groups that way, or nothing
/// when it can. Room not yet measured refuses nothing.
pub fn refused(room: (f32, f32), down: bool, n: usize) -> Option<String> {
    if n > MOST {
        return Some("Four groups is the most there can be".to_owned());
    }
    if room.0 <= 0.0 || room.1 <= 0.0 {
        return None;
    }
    let n = n as f32;
    if !down && room.0 < n * LEAST_W {
        return Some(format!("Not enough room: each group needs at least {LEAST_W} points across"));
    }
    if down && room.1 < n * LEAST_H {
        return Some(format!("Not enough room: each group needs at least {LEAST_H} points of height"));
    }
    None
}

/// What a press on a split button does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Press {
    /// No split yet: make one that way.
    Make,
    /// Split the other way: turn the two groups round to this way.
    Turn,
    /// Split this way already: one more group.
    Add,
}

/// A press on the button for a split across (`down` false) or down, given
/// whether there is a split and which way it runs.
pub fn press(split: bool, is_down: bool, down: bool) -> Press {
    match (split, is_down == down) {
        (false, _) => Press::Make,
        (true, true) => Press::Add,
        (true, false) => Press::Turn,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_group_needs_its_least_room() {
        assert_eq!(refused((720.0, 300.0), false, 2), None);
        assert_eq!(refused((719.0, 900.0), false, 2).as_deref(), Some("Not enough room: each group needs at least 360 points across"));
        assert_eq!(refused((300.0, 400.0), true, 2), None);
        assert_eq!(refused((900.0, 399.0), true, 2).as_deref(), Some("Not enough room: each group needs at least 200 points of height"));
        // a third group needs room for three
        assert_eq!(refused((1080.0, 300.0), false, 3), None);
        assert!(refused((1079.0, 300.0), false, 3).is_some());
        assert_eq!(refused((300.0, 600.0), true, 3), None);
        assert!(refused((300.0, 599.0), true, 3).is_some());
    }

    #[test]
    fn room_not_measured_yet_refuses_nothing() {
        assert_eq!(refused((0.0, 0.0), false, 2), None);
        assert_eq!(refused((0.0, 0.0), true, 4), None);
    }

    #[test]
    fn there_are_never_more_than_four_groups() {
        assert_eq!(refused((5000.0, 5000.0), false, 4), None);
        assert_eq!(refused((5000.0, 5000.0), false, 5).as_deref(), Some("Four groups is the most there can be"));
    }

    #[test]
    fn a_press_makes_adds_or_turns() {
        assert_eq!(press(false, false, false), Press::Make);
        assert_eq!(press(false, true, true), Press::Make, "which way an old split ran does not matter once it is gone");
        assert_eq!(press(true, false, false), Press::Add);
        assert_eq!(press(true, true, true), Press::Add);
        assert_eq!(press(true, false, true), Press::Turn);
        assert_eq!(press(true, true, false), Press::Turn);
    }
}
