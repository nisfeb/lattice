//! The pins a map's points wear: one drawn icon for each icon name a
//! feature may carry (`map::ICONS`), in place of the web client's
//! glyphs, which are whatever the system's fonts make of them and do not
//! read at a pin's size. Each is on a 24 point grid, with a heavier line
//! than the window's other icons, since a pin draws them small.

use rune::Icon;

macro_rules! pin {
    ($id:ident, $name:literal, $d:literal) => {
        static $id: Icon = Icon {
            name: $name,
            view: 24.0,
            body: concat!(r#"<path d=""#, $d, r#"" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>"#),
        };
    };
}

pin!(PIN, "pin-pin", "M12 21l-5-7.5a6 6 0 1 1 10 0zM11 10a1 1 0 1 0 2 0a1 1 0 1 0-2 0");
pin!(STAR, "pin-star", "M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1L3.2 9.4l6.1-.8z");
pin!(FLAG, "pin-flag", "M6 21V4M6 4h12l-3 4 3 4H6");
pin!(HOME, "pin-home", "M3 11l9-8 9 8M6 9v11h12V9");
pin!(CAMERA, "pin-camera", "M3 8h4l2-3h6l2 3h4v11H3zM9 13a3 3 0 1 0 6 0a3 3 0 1 0-6 0");
pin!(ALERT, "pin-alert", "M12 3l10 18H2zM12 10v4M12 17.5v.01");
pin!(PERSON, "pin-person", "M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0");
pin!(CAR, "pin-car", "M3 17v-5l2-5h14l2 5v5zM3 12h18M7 17v2M17 17v2");
pin!(BOAT, "pin-boat", "M3 15h18l-3 5H6zM12 15V3l6 9h-6");
pin!(PLANE, "pin-plane", "M12 2v20M12 8l9 6v2l-9-3M12 8l-9 6v2l9-3M9 22h6");
pin!(FIRE, "pin-fire", "M12 2l4 7a6 6 0 1 1-8 0l2 2z");
pin!(WATER, "pin-water", "M3 9l3-2 3 2 3-2 3 2 3-2 3 2M3 16l3-2 3 2 3-2 3 2 3-2 3 2");
pin!(TENT, "pin-tent", "M2 20L12 4l10 16zM12 20v-7");
pin!(CROSS, "pin-cross", "M12 4v16M4 12h16");
pin!(QUESTION, "pin-question", "M8 9a4 4 0 1 1 6 3.4L12 14v1M12 19v.01");

/// The drawn icon for an icon name, or nothing for a plain dot and for a name that is not one.
pub fn icon(name: &str) -> Option<&'static Icon> {
    Some(match name {
        "pin" => &PIN,
        "star" => &STAR,
        "flag" => &FLAG,
        "home" => &HOME,
        "camera" => &CAMERA,
        "alert" => &ALERT,
        "person" => &PERSON,
        "car" => &CAR,
        "boat" => &BOAT,
        "plane" => &PLANE,
        "fire" => &FIRE,
        "water" => &WATER,
        "tent" => &TENT,
        "cross" => &CROSS,
        "question" => &QUESTION,
        _ => return None,
    })
}

/// The pin a point wears: the one chosen for it on this computer, when
/// that is a name there is, and its own otherwise. `dot` is a plain dot.
pub fn worn<'a>(own: &'a str, chosen: Option<&'a str>) -> &'a str {
    chosen.filter(|c| *c == "dot" || icon(c).is_some()).unwrap_or(own)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_a_feature_may_name_is_drawn_and_each_differs() {
        let mut seen = Vec::new();
        for (name, _) in crate::map::ICONS {
            match icon(name) {
                Some(i) => seen.push(i.body),
                None => assert_eq!(name, "dot", "only the dot has no drawing"),
            }
        }
        let n = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!((n, seen.len()), (15, 15));
        assert!(icon("nope").is_none());
    }

    #[test]
    fn a_pin_chosen_here_is_worn_over_the_points_own() {
        assert_eq!(worn("pin", None), "pin");
        assert_eq!(worn("pin", Some("person")), "person");
        assert_eq!(worn("pin", Some("dot")), "dot", "a plain dot can be chosen too");
        assert_eq!(worn("flag", Some("nope")), "flag", "a name that is no icon changes nothing");
        assert_eq!(worn("", Some("star")), "star");
    }
}
