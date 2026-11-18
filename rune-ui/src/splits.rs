//! Splits, by the web client's rules (`ui-src/lattice/28-splits.js`):
//! groups side by side or one above the other, a split inside a split,
//! and the least room a group needs, under which a split is refused.
//!
//! The groups stand in a list. The split's own way (across, or down) is
//! its outer way, and the list is cut into runs: each run is one place
//! in the outer split, and a run of more than one group is split the
//! other way inside that place. So `[1, 2]` across is a group, then a
//! column of two.

/// The least a group may be, in points: across, and down.
pub const LEAST_W: f32 = 360.0;
pub const LEAST_H: f32 = 200.0;

/// The most groups there can be. The web client has no such number, only
/// the least size. Here a group's sheet is held in one of a fixed few
/// places, since rune-kit's table reaches its state by a plain function.
pub const MOST: usize = 4;

/// Why what is split cannot be halved that way, or nothing when it can:
/// `extent` is how much room it has that way, and each half must keep a
/// group's least. This is the web client's rule: it is the group being
/// split that is measured, not the whole room. Room not yet measured
/// refuses nothing.
pub fn halves(extent: f32, down: bool) -> Option<String> {
    if extent <= 0.0 {
        return None;
    }
    if !down && extent < 2.0 * LEAST_W {
        return Some(format!("Not enough room: each group needs at least {LEAST_W} points across"));
    }
    if down && extent < 2.0 * LEAST_H {
        return Some(format!("Not enough room: each group needs at least {LEAST_H} points of height"));
    }
    None
}

/// What a press on a split button does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Press {
    /// No split yet: make one that way.
    Make,
    /// The split's own way: one more place in it, after the group in front's.
    Outer,
    /// The other way: the group in front is split by itself, inside its place.
    Inner,
}

/// A press on the button for a split across (`down` false) or down, given
/// whether there is a split and which way it runs.
pub fn press(split: bool, is_down: bool, down: bool) -> Press {
    match (split, is_down == down) {
        (false, _) => Press::Make,
        (true, true) => Press::Outer,
        (true, false) => Press::Inner,
    }
}

/// The run the group standing at `d` is in.
pub fn run_of(runs: &[usize], d: usize) -> Option<usize> {
    let mut end = 0;
    runs.iter().position(|n| {
        end += n;
        d < end
    })
}

/// The runs once a group is added after the one standing at `front`:
/// in a place of its own after that group's run, or, `inner`, in the
/// same run. The second number is where the new group stands.
pub fn added(runs: &[usize], front: usize, inner: bool) -> (Vec<usize>, usize) {
    let mut out = runs.to_vec();
    let Some(r) = run_of(runs, front) else { return (out, front) };
    if inner {
        out[r] += 1;
        (out, front + 1)
    } else {
        out.insert(r + 1, 1);
        (out, runs[..=r].iter().sum())
    }
}

/// The runs once the group standing at `d` is gone. A run left empty is gone too.
pub fn removed(runs: &[usize], d: usize) -> Vec<usize> {
    let mut out = runs.to_vec();
    if let Some(r) = run_of(runs, d) {
        out[r] -= 1;
        out.retain(|n| *n > 0);
    }
    out
}

/// Equal shares of the room for `n` standing side by side.
pub fn even(n: usize) -> Vec<f32> {
    vec![1.0 / n.max(1) as f32; n]
}

/// The shares once one more stands after `i`: it takes half of what `i` had, as on the web.
pub fn share_added(shares: &[f32], i: usize) -> Vec<f32> {
    let mut out = shares.to_vec();
    if let Some(had) = out.get(i).copied() {
        out[i] = had / 2.0;
        out.insert(i + 1, had / 2.0);
    }
    out
}

/// The shares once `i` is gone: the rest take up its room in proportion.
pub fn share_removed(shares: &[f32], i: usize) -> Vec<f32> {
    let mut out = shares.to_vec();
    if i < out.len() {
        out.remove(i);
        let left: f32 = out.iter().sum();
        if left > 0.0 {
            out.iter_mut().for_each(|x| *x /= left);
        } else {
            out = even(out.len());
        }
    }
    out
}

/// The shares once the line between `i` and the next is moved by `by`,
/// a part of the whole room: what one gains the other loses, and
/// neither goes under `least`. Two that are both at their least stay.
pub fn dragged(shares: &[f32], i: usize, by: f32, least: f32) -> Vec<f32> {
    let mut out = shares.to_vec();
    if i + 1 >= out.len() {
        return out;
    }
    let both = out[i] + out[i + 1];
    if both < 2.0 * least {
        return out;
    }
    let first = (out[i] + by).clamp(least, both - least);
    (out[i], out[i + 1]) = (first, both - first);
    out
}

/// The shares once `i` and the next are made alike: a double press on the line between them.
pub fn evened(shares: &[f32], i: usize) -> Vec<f32> {
    let mut out = shares.to_vec();
    if i + 1 < out.len() {
        let half = (out[i] + out[i + 1]) / 2.0;
        (out[i], out[i + 1]) = (half, half);
    }
    out
}

/// Which of these places a point is in: each is `[x, y, width, height]`.
/// A place with no size, as one not laid out yet or the group in front's, holds nothing.
pub fn hit(rects: &[[f32; 4]], p: [f32; 2]) -> Option<usize> {
    rects.iter().position(|r| r[2] > 0.0 && r[3] > 0.0 && p[0] >= r[0] && p[0] < r[0] + r[2] && p[1] >= r[1] && p[1] < r[1] + r[3])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_point_is_in_the_place_that_holds_it() {
        let rects = [[0.0, 0.0, 0.0, 0.0], [100.0, 50.0, 200.0, 300.0], [300.0, 50.0, 200.0, 300.0]];
        assert_eq!(hit(&rects, [150.0, 60.0]), Some(1));
        assert_eq!(hit(&rects, [301.0, 349.0]), Some(2));
        assert_eq!(hit(&rects, [99.0, 60.0]), None);
        assert_eq!(hit(&rects, [150.0, 351.0]), None);
        assert_eq!(hit(&rects, [0.0, 0.0]), None, "a place with no size holds nothing");
        assert_eq!(hit(&[], [1.0, 1.0]), None);
    }

    fn near(a: &[f32], b: &[f32]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-4)
    }

    #[test]
    fn shares_start_even_and_always_make_the_whole() {
        assert!(near(&even(2), &[0.5, 0.5]));
        assert!(near(&even(4), &[0.25; 4]));
        assert!(even(0).is_empty());
    }

    #[test]
    fn one_more_takes_half_of_the_one_it_stands_after() {
        assert!(near(&share_added(&[0.5, 0.5], 0), &[0.25, 0.25, 0.5]));
        assert!(near(&share_added(&[0.7, 0.3], 1), &[0.7, 0.15, 0.15]));
        assert!(near(&share_added(&[1.0], 0), &[0.5, 0.5]));
    }

    #[test]
    fn one_gone_leaves_its_room_to_the_rest_in_proportion() {
        assert!(near(&share_removed(&[0.5, 0.25, 0.25], 0), &[0.5, 0.5]));
        assert!(near(&share_removed(&[0.6, 0.3, 0.1], 2), &[0.6 / 0.9, 0.3 / 0.9]));
        assert!(near(&share_removed(&[0.5, 0.5], 7), &[0.5, 0.5]), "nothing stands there");
    }

    #[test]
    fn a_line_dragged_moves_room_between_its_two_neighbours() {
        assert!(near(&dragged(&[0.5, 0.5], 0, 0.1, 0.2), &[0.6, 0.4]));
        assert!(near(&dragged(&[0.25, 0.25, 0.5], 1, -0.05, 0.1), &[0.25, 0.2, 0.55]), "the others are left alone");
        // neither goes under its least
        assert!(near(&dragged(&[0.5, 0.5], 0, 0.45, 0.2), &[0.8, 0.2]));
        assert!(near(&dragged(&[0.5, 0.5], 0, -0.9, 0.2), &[0.2, 0.8]));
        // two already at their least stay as they are
        assert!(near(&dragged(&[0.2, 0.2, 0.6], 0, 0.1, 0.2), &[0.2, 0.2, 0.6]));
        // a line that is not there moves nothing
        assert!(near(&dragged(&[0.5, 0.5], 1, 0.1, 0.2), &[0.5, 0.5]));
    }

    #[test]
    fn a_double_press_makes_two_neighbours_alike() {
        assert!(near(&evened(&[0.7, 0.1, 0.2], 0), &[0.4, 0.4, 0.2]));
        assert!(near(&evened(&[0.7, 0.1, 0.2], 1), &[0.7, 0.15, 0.15]));
        assert!(near(&evened(&[0.7, 0.3], 1), &[0.7, 0.3]));
    }

    #[test]
    fn what_is_split_must_be_room_for_two() {
        assert_eq!(halves(720.0, false), None);
        assert_eq!(halves(719.0, false).as_deref(), Some("Not enough room: each group needs at least 360 points across"));
        assert_eq!(halves(400.0, true), None);
        assert_eq!(halves(399.0, true).as_deref(), Some("Not enough room: each group needs at least 200 points of height"));
        assert_eq!(halves(0.0, false), None, "not measured yet");
    }

    #[test]
    fn a_press_makes_adds_a_place_or_splits_inside() {
        assert_eq!(press(false, false, false), Press::Make);
        assert_eq!(press(false, true, true), Press::Make, "which way an old split ran does not matter once it is gone");
        assert_eq!(press(true, false, false), Press::Outer);
        assert_eq!(press(true, true, true), Press::Outer);
        assert_eq!(press(true, false, true), Press::Inner);
        assert_eq!(press(true, true, false), Press::Inner);
    }

    #[test]
    fn which_run_a_group_is_in() {
        let runs = [1, 2, 1];
        assert_eq!((0..5).map(|d| run_of(&runs, d)).collect::<Vec<_>>(), [Some(0), Some(1), Some(1), Some(2), None]);
    }

    #[test]
    fn a_group_added_goes_after_the_one_in_front() {
        // a place of its own, after the whole run the front is in
        assert_eq!(added(&[1, 1], 0, false), (vec![1, 1, 1], 1));
        assert_eq!(added(&[2, 1], 0, false), (vec![2, 1, 1], 2), "after the run, not inside it");
        assert_eq!(added(&[2, 1], 2, false), (vec![2, 1, 1], 3));
        // inside the front's own run, right after it
        assert_eq!(added(&[1, 1], 0, true), (vec![2, 1], 1));
        assert_eq!(added(&[1, 2], 1, true), (vec![1, 3], 2));
        assert_eq!(added(&[1, 1], 1, true), (vec![1, 2], 2));
    }

    #[test]
    fn a_group_gone_shrinks_its_run_and_an_empty_run_goes() {
        assert_eq!(removed(&[1, 2, 1], 1), [1, 1, 1]);
        assert_eq!(removed(&[1, 2, 1], 0), [2, 1]);
        assert_eq!(removed(&[1, 2, 1], 3), [1, 2]);
        assert_eq!(removed(&[1, 1], 9), [1, 1], "nothing stands there");
    }
}
