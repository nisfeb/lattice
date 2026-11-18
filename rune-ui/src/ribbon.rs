//! The ribbon: the icons down the window's left edge, as the web client
//! has them (`ui-src/lattice/13-frame.js`, `ribbonAdd` in `24-tools.js`).
//! What is in it and in which order is worked out here, and `lib.rs`
//! draws it. The icons are the web client's own line art
//! (`ui-src/lattice/10-shell.js`), on its 24 point grid.

use rune::Icon;

/// One of the web client's stroke icons: its path, drawn as `ico()` draws it.
macro_rules! line {
    ($id:ident, $name:literal, $d:literal) => {
        pub static $id: Icon = Icon {
            name: $name,
            view: 24.0,
            body: concat!(r#"<path d=""#, $d, r#"" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>"#),
        };
    };
}

pub(crate) use line;

line!(CAL, "lat-cal", "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 3v4M16 3v4M3 10h18");
line!(BACK, "lat-back", "M17 7L7 17M16 17H7V8");
line!(FORUM, "lat-forum", "M3 4h12v8H8l-3 3v-3H3zM18 9h3v8h-2v3l-3-3h-6v-2");
line!(INBOX, "lat-inbox", "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5");
line!(KEY, "lat-key", "M4 15a4 4 0 1 0 8 0a4 4 0 1 0-8 0M11 12l9-9M16 7l3 3M14 9l2 2");
line!(TERM, "lat-term", "M4 17l6-5-6-5M12 19h8");
line!(GEAR, "lat-gear", "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1");

/// What a press on an item does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Go {
    Today,
    Shared,
    Forum,
    Inbox,
    Access,
    Commands,
    Settings,
}

/// One icon in the ribbon.
#[derive(Debug)]
pub struct Item {
    pub go: Go,
    /// The key scripts press it by: the one its word button had.
    pub key: &'static str,
    /// Said on hover and to a screen reader.
    pub name: &'static str,
    /// The chord that does the same, shown beside the name on hover.
    pub keys: Option<&'static str>,
    pub icon: &'static Icon,
    /// Its screen is the one showing.
    pub on: bool,
    /// A number painted on it: nothing at 0.
    pub count: u32,
    /// In the lower group, at the ribbon's foot.
    pub foot: bool,
}

impl Item {
    /// The name with its count, for a screen reader: the number painted on
    /// the icon says nothing by itself.
    pub fn said(&self) -> String {
        match (self.go, self.count) {
            (_, 0) => self.name.to_owned(),
            (Go::Inbox, n) => format!("{}, {n} waiting", self.name),
            (_, n) => format!("{}, {n}", self.name),
        }
    }

    /// The count as painted: two figures at most.
    pub fn badge(&self) -> Option<String> {
        match self.count {
            0 => None,
            n @ 1..=99 => Some(n.to_string()),
            _ => Some("99+".to_owned()),
        }
    }
}

/// What the ribbon needs to know of the window.
#[derive(Clone, Copy, Debug, Default)]
pub struct Showing {
    pub shared: bool,
    pub forum: bool,
    pub inbox: bool,
    pub access: bool,
    pub settings: bool,
    /// Pages other ships share with this one.
    pub shared_n: u32,
    /// Held comments and unread notices together.
    pub waiting: u32,
}

/// The ribbon's items, top to bottom, with settings in the lower group.
pub fn items(w: Showing) -> Vec<Item> {
    let it = |go, key, name, icon| Item { go, key, name, keys: None, icon, on: false, count: 0, foot: false };
    vec![
        it(Go::Today, "today", "Today's page", &CAL),
        Item { on: w.shared, count: w.shared_n, ..it(Go::Shared, "shared-open", "Shared with me", &BACK) },
        Item { on: w.forum, ..it(Go::Forum, "forum-open", "Forum", &FORUM) },
        Item { on: w.inbox, count: w.waiting, ..it(Go::Inbox, "inbox-open", "Inbox", &INBOX) },
        Item { on: w.access, ..it(Go::Access, "access-open", "Access & groups", &KEY) },
        Item { keys: Some("Ctrl+K"), ..it(Go::Commands, "palette-open", "Command palette", &TERM) },
        Item { on: w.settings, keys: Some("Ctrl+,"), foot: true, ..it(Go::Settings, "settings-open", "Settings", &GEAR) },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_items_in_the_web_clients_order_with_settings_at_the_foot() {
        let it = items(Showing::default());
        let keys: Vec<_> = it.iter().map(|i| i.key).collect();
        assert_eq!(keys, ["today", "shared-open", "forum-open", "inbox-open", "access-open", "palette-open", "settings-open"]);
        let foot: Vec<_> = it.iter().filter(|i| i.foot).map(|i| i.go).collect();
        assert_eq!(foot, [Go::Settings]);
        assert!(it.iter().all(|i| !i.on && i.count == 0 && !i.name.is_empty()));
    }

    #[test]
    fn the_screen_showing_is_the_one_marked() {
        let it = items(Showing { forum: true, ..Default::default() });
        let on: Vec<_> = it.iter().filter(|i| i.on).map(|i| i.go).collect();
        assert_eq!(on, [Go::Forum]);
        let it = items(Showing { settings: true, ..Default::default() });
        assert_eq!(it.iter().filter(|i| i.on).map(|i| i.go).collect::<Vec<_>>(), [Go::Settings]);
    }

    #[test]
    fn counts_are_painted_and_said() {
        let it = items(Showing { shared_n: 3, waiting: 120, ..Default::default() });
        let by = |g| it.iter().find(|i| i.go == g).unwrap();
        assert_eq!(by(Go::Shared).badge().as_deref(), Some("3"));
        assert_eq!(by(Go::Shared).said(), "Shared with me, 3");
        assert_eq!(by(Go::Inbox).badge().as_deref(), Some("99+"));
        assert_eq!(by(Go::Inbox).said(), "Inbox, 120 waiting");
        assert_eq!(by(Go::Forum).badge(), None);
        assert_eq!(by(Go::Forum).said(), "Forum");
    }

    #[test]
    fn the_chords_the_app_binds_are_named() {
        let it = items(Showing::default());
        let by = |g| it.iter().find(|i| i.go == g).unwrap();
        assert_eq!(by(Go::Commands).keys, Some("Ctrl+K"));
        assert_eq!(by(Go::Settings).keys, Some("Ctrl+,"));
        assert_eq!(by(Go::Today).keys, None);
    }

    #[test]
    fn every_icon_has_a_name_of_its_own() {
        let it = items(Showing::default());
        let mut names: Vec<_> = it.iter().map(|i| i.icon.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), it.len());
    }
}
