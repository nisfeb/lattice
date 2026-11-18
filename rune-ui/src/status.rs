//! The status bar along the bottom of the window, as the web client has
//! it (`<lat-statusbar>` in `ui-src/lattice/13-frame.js`): what was last
//! said, and, for as long as each holds, that the ship is away and how
//! much waits to be sent. What it says is worked out here.

/// Something the bar shows for as long as it holds: a few words, and
/// the whole of it for a hover and a screen reader.
#[derive(Clone, Debug, PartialEq)]
pub struct Badge {
    pub short: String,
    pub long: String,
}

/// What the bar holds.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Bar {
    /// What was last said, when there is something to say.
    pub said: Option<String>,
    /// The ship does not answer.
    pub offline: Option<Badge>,
    /// Changes kept on this device to send.
    pub waiting: Option<Badge>,
}

/// The bar for the window as it stands. `offline` is when the tree
/// showing was kept, empty when that is not known. `ship` is the ship's
/// address: offline, a read that failed because the ship is away is not
/// said again, and such an error starts with it.
pub fn bar(note: &str, offline: Option<&str>, waiting: usize, ship: Option<&str>) -> Bar {
    let offline_badge = offline.map(|when| {
        let (short, said) = if when.is_empty() { ("Offline".to_owned(), "Offline. The ship does not answer.".to_owned()) } else { (format!("Offline, kept {when}"), format!("Offline. The ship does not answer, so this is what was kept {when}.")) };
        Badge { short, long: format!("{said} A save, a new page, a delete or a move made now waits on this device. Anything else needs the ship.") }
    });
    let waiting_badge = (waiting > 0).then(|| Badge { short: format!("{waiting} waiting"), long: format!("{waiting} change{} saved on this device, waiting to be sent.", if waiting == 1 { "" } else { "s" }) });
    let again = offline.is_some() && ship.is_some_and(|url| note.split_once(": ").is_some_and(|(_, e)| e.starts_with(url)));
    Bar { said: (!note.is_empty() && !again).then(|| note.to_owned()), offline: offline_badge, waiting: waiting_badge }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_to_say_is_an_empty_bar() {
        assert_eq!(bar("", None, 0, Some("http://ship")), Bar::default());
    }

    #[test]
    fn what_was_last_said_is_shown() {
        assert_eq!(bar("saved", None, 0, None).said.as_deref(), Some("saved"));
    }

    #[test]
    fn offline_is_a_badge_that_says_how_old_the_tree_is() {
        let b = bar("", Some("2 hours ago"), 0, Some("http://ship")).offline.unwrap();
        assert_eq!(b.short, "Offline, kept 2 hours ago");
        assert!(b.long.starts_with("Offline. The ship does not answer, so this is what was kept 2 hours ago.") && b.long.contains("waits on this device"), "{}", b.long);
        let b = bar("", Some(""), 0, None).offline.unwrap();
        assert_eq!(b.short, "Offline");
        assert!(b.long.starts_with("Offline. The ship does not answer. "), "{}", b.long);
    }

    #[test]
    fn what_waits_is_counted() {
        let one = bar("", None, 1, None).waiting.unwrap();
        assert_eq!((one.short.as_str(), one.long.as_str()), ("1 waiting", "1 change saved on this device, waiting to be sent."));
        let many = bar("", Some(""), 3, None).waiting.unwrap();
        assert_eq!((many.short.as_str(), many.long.as_str()), ("3 waiting", "3 changes saved on this device, waiting to be sent."));
        assert_eq!(bar("", None, 0, None).waiting, None);
    }

    #[test]
    fn offline_a_failed_read_of_the_ship_is_not_said_again() {
        let err = "tree: http://ship:8080/apps/lattice/page-dump: connection refused";
        assert_eq!(bar(err, Some(""), 0, Some("http://ship:8080")).said, None);
        // online it is the news
        assert_eq!(bar(err, None, 0, Some("http://ship:8080")).said.as_deref(), Some(err));
        // and anything else said offline still shows
        assert_eq!(bar("done on this device, to send when the ship answers", Some(""), 1, Some("http://ship:8080")).said.as_deref(), Some("done on this device, to send when the ship answers"));
    }
}
