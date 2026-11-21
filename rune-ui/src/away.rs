//! Whether anyone is at the window. What is only worth a ship's while
//! when someone is looking is not asked of it while nobody is, so a
//! computer left on with the app open does not fill a ship's event log.

/// How long a window in the background counts as in use, and how long
/// one in front that nothing has touched, in seconds.
pub const BEHIND_FOR: f64 = 60.0;
pub const STILL_FOR: f64 = 300.0;

/// Whether the window has been left: in the background for a minute, or
/// in front with no key and no pointer moved for five. `touched` is when
/// one last was, `behind` since when the window has not been in front.
pub fn left(now: f64, touched: f64, behind: Option<f64>) -> bool {
    behind.is_some_and(|b| now - b >= BEHIND_FOR) || now - touched >= still_for()
}

/// How long until a window in use would count as left, if nothing more happens: when to look again.
pub fn left_in(now: f64, touched: f64, behind: Option<f64>) -> f64 {
    let still = touched + still_for() - now;
    behind.map_or(still, |b| still.min(b + BEHIND_FOR - now)).max(0.0)
}

/// `STILL_FOR`, or in a debug build the seconds `LATTICE_STILL_AFTER` names, so a check need not wait five minutes.
fn still_for() -> f64 {
    static ASKED: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    if cfg!(test) || !cfg!(debug_assertions) {
        return STILL_FOR;
    }
    *ASKED.get_or_init(|| std::env::var("LATTICE_STILL_AFTER").ok().and_then(|v| v.parse().ok()).unwrap_or(STILL_FOR))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_is_left_in_the_background_or_alone() {
        // in front and touched a moment ago
        assert!(!left(1000.0, 990.0, None));
        // in front, and nothing touched for five minutes
        assert!(!left(1000.0, 701.0, None) && left(1000.0, 700.0, None));
        // behind another window for a minute, however lately it was touched
        assert!(!left(1000.0, 999.0, Some(941.0)) && left(1000.0, 999.0, Some(940.0)));
        // when to look again: the sooner of the two
        assert_eq!(left_in(1000.0, 990.0, None), 290.0);
        assert_eq!(left_in(1000.0, 990.0, Some(970.0)), 30.0);
        assert_eq!(left_in(1000.0, 0.0, None), 0.0);
    }
}
