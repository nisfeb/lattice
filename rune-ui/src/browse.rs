//! The browser, as the web client has it (`ui-src/lattice/24-tools.js`,
//! `29-fhead.js`): a place to read what other ships publish, with Back,
//! Forward, an address field that completes from what was saved and
//! visited, and a star. Where a typed address goes and how the way back
//! is kept are worked out here.

/// Where what was typed into the address field goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// Nothing typed: the browser's own start.
    Home,
    /// A page, a folder or a forum on the network, by its whole address.
    Urb(String),
    /// A web page, for the system's browser.
    Web(String),
    /// Anything else is looked for among the reader's own pages.
    Search(String),
}

/// Where what was typed goes. `~ship/path` is an address with its `urb://` left off.
pub fn target(typed: &str) -> Target {
    let t = typed.trim();
    if t.is_empty() {
        return Target::Home;
    }
    if t.starts_with("https://") || t.starts_with("http://") {
        return Target::Web(t.to_owned());
    }
    match crate::api::urb_address(t) {
        Some(url) => Target::Urb(url),
        None => Target::Search(t.to_owned()),
    }
}

/// The way back and the way forward, as addresses. The start is the empty address.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Nav {
    back: Vec<String>,
    fwd: Vec<String>,
    cur: String,
}

impl Nav {
    /// The address showing: empty at the start.
    pub fn cur(&self) -> &str {
        &self.cur
    }

    pub fn can_back(&self) -> bool {
        !self.back.is_empty()
    }

    pub fn can_forward(&self) -> bool {
        !self.fwd.is_empty()
    }

    /// Goes to an address: what was ahead is dropped, as a browser drops it. Going where it already is, is no step.
    pub fn go(&mut self, to: &str) {
        if to == self.cur {
            return;
        }
        self.back.push(std::mem::replace(&mut self.cur, to.to_owned()));
        self.fwd.clear();
        // a long session's way back is bounded
        if self.back.len() > 200 {
            self.back.remove(0);
        }
    }

    /// Steps back, or forward: the address to show, or nothing when there is none that way.
    pub fn step(&mut self, back: bool) -> Option<&str> {
        let (from, to) = if back { (&mut self.back, &mut self.fwd) } else { (&mut self.fwd, &mut self.back) };
        let next = from.pop()?;
        to.push(std::mem::replace(&mut self.cur, next));
        Some(&self.cur)
    }
}

/// The word beside a suggestion: where it comes from.
pub fn source(source: &str) -> &'static str {
    if source == "bookmark" { "saved" } else { "visited" }
}

/// The row of the suggestions the arrows move to: down from the field to the first, up from the first back to the field.
pub fn moved(at: Option<usize>, n: usize, down: bool) -> Option<usize> {
    match (at, down) {
        _ if n == 0 => None,
        (None, true) => Some(0),
        (None, false) => None,
        (Some(i), true) => Some((i + 1).min(n - 1)),
        (Some(0), false) => None,
        (Some(i), false) => Some(i - 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_typed_is_an_address_a_web_page_or_a_search() {
        assert_eq!(target("  "), Target::Home);
        assert_eq!(target("urb://~sampel-palnet/notes"), Target::Urb("urb://~sampel-palnet/notes".into()));
        assert_eq!(target(" ~sampel-palnet/notes/plan "), Target::Urb("urb://~sampel-palnet/notes/plan".into()), "the urb:// may be left off");
        assert_eq!(target("https://example.com/a b"), Target::Web("https://example.com/a b".into()));
        assert_eq!(target("trip plans"), Target::Search("trip plans".into()));
        assert_eq!(target("~notaship!/x"), Target::Search("~notaship!/x".into()), "what names no ship is looked for");
    }

    #[test]
    fn the_way_back_and_forward_is_a_browsers() {
        let mut n = Nav::default();
        assert!(!n.can_back() && !n.can_forward() && n.cur().is_empty());
        n.go("urb://~bus/a");
        n.go("urb://~bus/b");
        n.go("urb://~bus/b");
        assert_eq!((n.cur(), n.can_back(), n.can_forward()), ("urb://~bus/b", true, false), "going where it is, is no step");
        assert_eq!(n.step(true), Some("urb://~bus/a"));
        assert_eq!(n.step(true), Some(""), "back to the start");
        assert_eq!(n.step(true), None);
        assert_eq!(n.step(false), Some("urb://~bus/a"));
        // a new address drops what was ahead
        n.go("urb://~bus/c");
        assert_eq!((n.can_forward(), n.step(false)), (false, None));
        assert_eq!(n.step(true), Some("urb://~bus/a"));
    }

    #[test]
    fn the_arrows_move_through_the_suggestions_and_back_to_the_field() {
        assert_eq!(moved(None, 3, true), Some(0));
        assert_eq!(moved(Some(0), 3, true), Some(1));
        assert_eq!(moved(Some(2), 3, true), Some(2), "the last stays");
        assert_eq!(moved(Some(1), 3, false), Some(0));
        assert_eq!(moved(Some(0), 3, false), None, "up from the first is the field again");
        assert_eq!((moved(None, 3, false), moved(None, 0, true), moved(Some(1), 0, false)), (None, None, None));
        assert_eq!((source("bookmark"), source("history")), ("saved", "visited"));
    }
}
