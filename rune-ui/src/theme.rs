//! The look the window wears, on Talon's model, as the web client works
//! it out (`code/nex/lattice/ui-app/theme.js`): themes the user made, five
//! colours picked and the rest derived, kept in the ship's %settings, an
//! accent laid over whichever theme is in use, and "use Talon's theme",
//! on unless turned off, which wears what Talon wears. What the ship said
//! is kept here as it said it, and the colours are worked out from that.

use rune::Color;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What the ship last said of themes, kept between runs so the first
/// frame is drawn in them. The shapes are Talon's own: `ThemeSettings`
/// (`{ themes, activeId }`) and `AccentSettings` (`{ enabled, mode, customHex }`).
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Worn {
    /// Lattice's own themes and accent, worn only when `own` is set.
    #[serde(default)]
    pub mine: Value,
    #[serde(default)]
    pub accent: Value,
    /// "Use a lattice-specific theme": Talon is not followed.
    #[serde(default)]
    pub own: bool,
    #[serde(default)]
    pub talon: Value,
    #[serde(default)]
    pub talon_accent: Value,
    /// The %contacts profile colour, when an accent asked for it.
    #[serde(default)]
    pub profile: Option<String>,
    /// Talon's fonts, its `FontSettings` (`{ fonts, family, removed }`), and
    /// "use Talon's font" turned off, which is apart from the theme's switch.
    #[serde(default)]
    pub talon_fonts: Value,
    #[serde(default)]
    pub own_font: bool,
}

/// The font the window's text is set in, when Talon names one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Font {
    Serif,
    Mono,
    /// A family by name: one Talon has installed.
    Named(String),
}

/// The colours a look sets. One left unset is the built-in look's own.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Look {
    /// A theme brings its own light or dark. With none, the mode picked decides.
    pub dark: Option<bool>,
    pub bg: Option<Color>,
    pub text: Option<Color>,
    pub muted: Option<Color>,
    pub border: Option<Color>,
    pub border_soft: Option<Color>,
    pub link: Option<Color>,
    pub raised: Option<Color>,
    pub error: Option<Color>,
    pub selection: Option<Color>,
    pub accent: Option<Color>,
    pub on_accent: Option<Color>,
}

/// A colour as a theme writes it: six hex figures, with or without the `#`.
fn hex6(v: &Value) -> Option<Color> {
    let s = v.as_str()?.trim();
    let h = s.strip_prefix('#').unwrap_or(s);
    (h.len() == 6 && h.bytes().all(|b| b.is_ascii_hexdigit())).then(|| rune::color::hex(&format!("#{h}"))).flatten()
}

/// Part of the way from one colour to another in Oklab, as Compose's
/// `lerp` goes, so the derived shades come out as Talon's do.
fn lerp(a: Color, b: Color, t: f32) -> Color {
    let (x, y) = (a.to_oklab(), b.to_oklab());
    Color::from_oklab([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t, 1.0])
}

fn rgb(r: u8, g: u8, b: u8) -> Color {
    rune::color::hex(&format!("#{r:02x}{g:02x}{b:02x}")).unwrap_or(Color::BLACK)
}

/// The ink or the paper, whichever reads on a colour.
fn on(c: Color) -> Color {
    if c.luminance() > 0.4 { rgb(0x1c, 0x19, 0x17) } else { rgb(0xfa, 0xfa, 0xf9) }
}

const FIVE: [&str; 5] = ["primary", "secondary", "tertiary", "background", "surface"];

/// The theme in use among those kept, when it is whole: named, with its five colours.
fn active(settings: &Value) -> Option<&Value> {
    let id = settings.get("activeId").filter(|id| !id.is_null())?;
    settings.get("themes")?.as_array()?.iter().find(|t| {
        t.get("id") == Some(id) && t.get("name").and_then(Value::as_str).is_some_and(|n| !n.trim().is_empty()) && FIVE.iter().all(|k| t.get(*k).and_then(hex6).is_some())
    })
}

/// A theme's colours. The ground is its surface, as Talon draws its screens in.
fn theme_look(t: &Value) -> Look {
    let named = |k: &str| t.get(k).and_then(hex6);
    let (Some(p), Some(sf)) = (named("primary"), named("surface")) else { return Look::default() };
    let text = named("text").unwrap_or_else(|| on(sf));
    Look {
        dark: Some(t.get("dark").and_then(Value::as_bool).unwrap_or(false)),
        bg: Some(sf),
        text: Some(text),
        muted: Some(named("muted").unwrap_or_else(|| lerp(text, sf, 0.35))),
        border: Some(lerp(sf, text, 0.4)),
        border_soft: Some(lerp(sf, text, 0.15)),
        // Talon's link blue, unless the theme says
        link: Some(named("link").unwrap_or(rgb(0x29, 0x62, 0xff))),
        raised: named("raised"),
        error: named("error"),
        selection: named("selection"),
        accent: Some(p),
        on_accent: Some(on(p)),
    }
}

/// An accent's colour, when it is on and has one. Unset reads as off, and
/// a mode that is not known reads as the profile's colour, as Talon reads them.
fn accent_of(a: &Value, profile: Option<&str>) -> Option<Color> {
    let mode = a.get("mode").and_then(Value::as_str);
    if a.get("enabled") != Some(&Value::Bool(true)) || mode == Some("Brand") {
        return None;
    }
    match mode {
        Some("Custom") => a.get("customHex").and_then(hex6),
        _ => hex6(&Value::String(profile?.to_owned())),
    }
}

/// A value of a %settings bucket: text that holds JSON, or the JSON itself.
fn unwrap(v: Option<&Value>) -> Value {
    match v {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        None => Value::Null,
    }
}

/// How an accent is set, as the settings offer it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Accent {
    Off,
    Profile,
    /// Any colour, as six hex figures.
    Custom(String),
}

/// A change to what lattice wears, as it is written to the ship: the
/// entry of lattice's %settings bucket, and its value. Each is in the
/// shape the web client and Talon write, so they read one another's.
#[derive(Clone, Debug, PartialEq)]
pub struct Put {
    pub entry: &'static str,
    pub value: Value,
}

/// Six hex figures as they are written, in capitals with their `#`, or nothing for what is no colour.
pub fn hex_of(typed: &str) -> Option<String> {
    let v = Value::String(typed.to_owned());
    hex6(&v)?;
    Some(format!("#{}", typed.trim().trim_start_matches('#').to_uppercase()))
}

impl Worn {
    /// Lattice's own themes that are whole, as id and name, in the order kept.
    pub fn themes(&self) -> Vec<(String, String)> {
        let one = |t: &Value| Some((t.get("id")?.as_str()?.to_owned(), t.get("name")?.as_str()?.trim().to_owned()));
        self.mine.get("themes").and_then(Value::as_array).map(|a| a.iter().filter(|t| FIVE.iter().all(|k| t.get(*k).and_then(hex6).is_some())).filter_map(one).filter(|(_, n)| !n.is_empty()).collect()).unwrap_or_default()
    }

    /// The id of lattice's own theme in use, or nothing for the built-in look.
    pub fn own_active(&self) -> Option<&str> {
        active(&self.mine)?.get("id")?.as_str()
    }

    /// How lattice's own accent is set.
    pub fn own_accent(&self) -> Accent {
        let mode = self.accent.get("mode").and_then(Value::as_str);
        if self.accent.get("enabled") != Some(&Value::Bool(true)) || mode == Some("Brand") {
            Accent::Off
        } else if mode == Some("Custom") {
            Accent::Custom(self.accent.get("customHex").and_then(Value::as_str).and_then(hex_of).unwrap_or_default())
        } else {
            Accent::Profile
        }
    }

    /// Follows Talon's theme, or wears lattice's own. Stored as Talon's switch, the other way round.
    pub fn set_own(&mut self, own: bool) -> Put {
        self.own = own;
        Put { entry: "use-talon-theme", value: serde_json::json!({ "enabled": !own }) }
    }

    /// Wears Talon's font, or does not.
    pub fn set_own_font(&mut self, own: bool) -> Put {
        self.own_font = own;
        Put { entry: "use-talon-font", value: serde_json::json!({ "enabled": !own }) }
    }

    /// Wears one of lattice's own themes, or, with none, the built-in look. The themes themselves are left as they are.
    pub fn set_active(&mut self, id: Option<&str>) -> Put {
        if !self.mine.is_object() {
            self.mine = serde_json::json!({ "themes": [] });
        }
        self.mine["activeId"] = id.map_or(Value::Null, |i| Value::String(i.to_owned()));
        Put { entry: "themes", value: self.mine.clone() }
    }

    /// Sets lattice's own accent. Turning it off keeps the mode and the colour it had, as Talon does.
    pub fn set_accent(&mut self, how: Accent) -> Put {
        let hex = self.accent.get("customHex").cloned().unwrap_or(Value::Null);
        self.accent = match how {
            Accent::Off => serde_json::json!({ "enabled": false, "mode": self.accent.get("mode").and_then(Value::as_str).unwrap_or("Profile"), "customHex": hex }),
            Accent::Profile => serde_json::json!({ "enabled": true, "mode": "Profile", "customHex": hex }),
            Accent::Custom(h) => serde_json::json!({ "enabled": true, "mode": "Custom", "customHex": h }),
        };
        Put { entry: "accent", value: self.accent.clone() }
    }

    /// Takes what lattice's own bucket says (`settings/bucket/lattice/ui-prefs`), or nothing when the ship has none.
    pub fn lattice(&mut self, answer: Option<&Value>) {
        let b = answer.and_then(|a| a.get("bucket"));
        let entry = |k: &str| unwrap(b.and_then(|b| b.get(k)));
        self.mine = entry("themes");
        self.accent = entry("accent");
        // followed unless the switch says otherwise
        self.own = entry("use-talon-theme").get("enabled") == Some(&Value::Bool(false));
        self.own_font = entry("use-talon-font").get("enabled") == Some(&Value::Bool(false));
    }

    /// Takes what Talon's bucket says (`settings/bucket/talon/ui-prefs`).
    pub fn talon(&mut self, answer: Option<&Value>) {
        let b = answer.and_then(|a| a.get("bucket"));
        self.talon = unwrap(b.and_then(|b| b.get("themes")));
        self.talon_accent = unwrap(b.and_then(|b| b.get("accent")));
        self.talon_fonts = unwrap(b.and_then(|b| b.get("fonts")));
    }

    /// Takes the %contacts profile (`contacts/v1/self`): `{ color: { value: "ff.5050" } }`, or the colour itself.
    pub fn contacts(&mut self, answer: Option<&Value>) {
        let c = answer.and_then(|a| a.get("color"));
        let raw = c.and_then(|c| c.get("value")).or(c).and_then(Value::as_str).unwrap_or("");
        let h: String = raw.trim_start_matches("0x").trim_start_matches('#').chars().filter(|c| *c != '.').collect();
        self.profile = (!h.is_empty() && h.len() <= 6 && h.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("#{h:0>6}"));
    }

    /// Whether Talon's theme is followed.
    pub fn follows(&self) -> bool {
        !self.own
    }

    /// Whether Talon's bucket is to be read: for its theme, or for its font.
    pub fn reads_talon(&self) -> bool {
        !self.own || !self.own_font
    }

    /// The font Talon sets its text in, when it is followed and names one. None is the app's own.
    pub fn font(&self) -> Option<Font> {
        let family = self.talon_fonts.get("family").and_then(Value::as_str).map(str::trim).filter(|f| !f.is_empty() && !self.own_font)?;
        Some(match family {
            "serif" => Font::Serif,
            "monospace" => Font::Mono,
            f => Font::Named(f.chars().filter(|c| !matches!(c, '"' | '\\' | ',')).collect()),
        })
    }

    /// What is said of the font, as the web client's settings page says it.
    pub fn font_said(&self) -> String {
        match self.font() {
            _ if self.own_font => "Talon\u{2019}s font is ignored here.".to_owned(),
            None => "Talon uses the system\u{2019}s font, and lattice uses its own.".to_owned(),
            Some(Font::Serif) => "Talon sets its text in a serif, so lattice does too.".to_owned(),
            Some(Font::Mono) => "Talon sets its text in monospace, so lattice does too.".to_owned(),
            Some(Font::Named(f)) => format!("Talon sets its text in {f}, so lattice does too, when {f} is installed on this computer."),
        }
    }

    /// Whether the accent in use wants the profile's colour.
    pub fn wants_profile(&self) -> bool {
        let a = if self.own { &self.accent } else { &self.talon_accent };
        let mode = a.get("mode").and_then(Value::as_str);
        a.get("enabled") == Some(&Value::Bool(true)) && mode != Some("Custom") && mode != Some("Brand")
    }

    /// The name of the theme worn, or nothing for the built-in look.
    pub fn name(&self) -> Option<&str> {
        active(if self.own { &self.mine } else { &self.talon })?.get("name")?.as_str()
    }

    /// Which theme is worn, as the web client's settings page says it.
    pub fn said(&self) -> String {
        match (self.own, self.name()) {
            (false, Some(n)) => format!("Lattice follows Talon, which is using \u{201c}{n}\u{201d}."),
            (false, None) => "Lattice follows Talon, which is on its built-in theme.".to_owned(),
            (true, Some(n)) => format!("Lattice uses its own theme, \u{201c}{n}\u{201d}, whatever Talon uses."),
            (true, None) => "Lattice uses its own built-in theme, whatever Talon uses.".to_owned(),
        }
    }

    /// The colours to draw in: the theme in use, with the accent in use over it.
    pub fn look(&self) -> Look {
        let (themes, accent) = if self.own { (&self.mine, &self.accent) } else { (&self.talon, &self.talon_accent) };
        let mut look = active(themes).map(theme_look).unwrap_or_default();
        if let Some(a) = accent_of(accent, self.profile.as_deref()) {
            look.accent = Some(a);
            // Talon's accent has its own threshold, and white for its paper
            look.on_accent = Some(if a.luminance() > 0.5 { rgb(0x1c, 0x19, 0x17) } else { Color::WHITE });
        }
        look
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A colour as `#rrggbb`, to set beside what the web client's own code gives.
    fn hex(c: Option<Color>) -> String {
        c.map(|c| c.hex()[..7].to_owned()).unwrap_or_default()
    }

    /// Two colours alike but for the last figure of a channel: the web client works in doubles.
    fn near(got: Option<Color>, want: &str) -> bool {
        let got = hex(got);
        let ch = |s: &str, i: usize| i64::from_str_radix(&s[i..i + 2], 16).unwrap();
        got.len() == 7 && [1, 3, 5].iter().all(|&i| (ch(&got, i) - ch(want, i)).abs() <= 1)
    }

    fn night() -> Value {
        json!({ "id": "a", "name": "Night", "dark": true, "primary": "#8AB4F8", "secondary": "#C58AF9", "tertiary": "#78D9EC", "background": "#101418", "surface": "#1B2026", "text": "", "muted": "", "raised": "", "error": "", "selection": "", "link": "" })
    }

    fn day() -> Value {
        json!({ "id": "b", "name": "Day", "dark": false, "primary": "#4A7C59", "secondary": "#7A5AF8", "tertiary": "#0A9A6A", "background": "#FAFAFA", "surface": "#FFFFFF", "text": "#222222", "muted": "#667788", "raised": "#EEEEEE", "error": "#B00020", "selection": "#CCDDEE", "link": "#0055AA" })
    }

    fn talon(active: &str, accent: Value) -> Worn {
        Worn { talon: json!({ "themes": [night(), day()], "activeId": active }), talon_accent: accent, ..Worn::default() }
    }

    #[test]
    fn five_colours_give_the_rest_as_the_web_client_derives_them() {
        let l = talon("a", Value::Null).look();
        assert_eq!(l.dark, Some(true));
        assert_eq!((hex(l.bg), hex(l.accent), hex(l.link)), ("#1b2026".into(), "#8ab4f8".into(), "#2962ff".into()));
        assert!(near(l.text, "#fafaf9") && near(l.muted, "#a4a6a8"), "{} {}", hex(l.text), hex(l.muted));
        assert!(near(l.border, "#6b6f73") && near(l.border_soft, "#373c41"), "{} {}", hex(l.border), hex(l.border_soft));
        assert!(near(l.on_accent, "#1c1917"));
        assert_eq!((l.raised, l.error, l.selection), (None, None, None), "unset, each is the built-in look's own");
    }

    #[test]
    fn the_six_a_theme_names_are_taken_as_named() {
        let l = talon("b", Value::Null).look();
        assert_eq!(l.dark, Some(false));
        assert_eq!([hex(l.bg), hex(l.text), hex(l.muted), hex(l.link)], ["#ffffff", "#222222", "#667788", "#0055aa"]);
        assert_eq!([hex(l.raised), hex(l.error), hex(l.selection)], ["#eeeeee", "#b00020", "#ccddee"]);
        assert!(near(l.border, "#9e9e9e") && near(l.border_soft, "#dadada"), "{} {}", hex(l.border), hex(l.border_soft));
        assert!(near(l.on_accent, "#fafaf9"));
    }

    #[test]
    fn with_no_theme_in_use_the_look_is_the_built_in_one() {
        assert_eq!(Worn::default().look(), Look::default());
        assert_eq!(talon("gone", Value::Null).look(), Look::default());
        // a theme with a colour missing is not whole, so it is not worn
        let mut w = talon("a", Value::Null);
        w.talon["themes"][0]["surface"] = json!("blue");
        assert_eq!((w.look(), w.name()), (Look::default(), None));
    }

    #[test]
    fn an_accent_is_laid_over_the_theme_or_over_the_built_in_look() {
        let custom = json!({ "enabled": true, "mode": "Custom", "customHex": "FFCC00" });
        let l = talon("a", custom.clone()).look();
        assert_eq!((hex(l.accent), hex(l.on_accent), hex(l.bg)), ("#ffcc00".into(), "#1c1917".into(), "#1b2026".into()));
        let l = talon("gone", json!({ "enabled": true, "mode": "Custom", "customHex": "#5050FF" })).look();
        assert_eq!((hex(l.accent), hex(l.on_accent), l.bg, l.dark), ("#5050ff".into(), "#ffffff".into(), None, None));
        // off, unset and Talon's own brand are no accent
        for a in [json!({ "enabled": false, "mode": "Custom", "customHex": "FFCC00" }), json!({ "mode": "Custom", "customHex": "FFCC00" }), json!({ "enabled": true, "mode": "Brand" })] {
            assert_eq!(hex(talon("a", a).look().accent), "#8ab4f8");
        }
    }

    #[test]
    fn the_profile_colour_is_the_accent_when_the_accent_asks_for_it() {
        let mut w = talon("a", json!({ "enabled": true, "mode": "Profile" }));
        assert!(w.wants_profile());
        assert_eq!(hex(w.look().accent), "#8ab4f8", "not read yet");
        w.contacts(Some(&json!({ "color": { "type": "tint", "value": "ff.5050" } })));
        assert_eq!((w.profile.as_deref(), hex(w.look().accent)), (Some("#ff5050"), "#ff5050".into()));
        w.contacts(Some(&json!({ "color": "0x50.50ff" })));
        assert_eq!(w.profile.as_deref(), Some("#5050ff"));
        w.contacts(Some(&json!({ "color": { "value": "ff" } })));
        assert_eq!(w.profile.as_deref(), Some("#0000ff"));
        w.contacts(None);
        assert_eq!(w.profile, None);
        assert!(!talon("a", json!({ "enabled": true, "mode": "Custom" })).wants_profile());
    }

    #[test]
    fn talon_is_followed_until_the_switch_says_otherwise() {
        let themes = json!({ "themes": [day()], "activeId": "b" }).to_string();
        let mut w = talon("a", Value::Null);
        // the bucket's values are text that holds JSON, as Talon writes them
        w.lattice(Some(&json!({ "bucket": { "themes": themes, "accent": "{\"enabled\":true,\"mode\":\"Custom\",\"customHex\":\"#112233\"}" } })));
        assert!(w.follows());
        assert_eq!((w.name(), hex(w.look().accent)), (Some("Night"), "#8ab4f8".into()), "lattice's own are kept but not worn");
        w.lattice(Some(&json!({ "bucket": { "themes": themes, "accent": { "enabled": true, "mode": "Custom", "customHex": "#112233" }, "use-talon-theme": "{\"enabled\":false}" } })));
        assert!(!w.follows());
        assert_eq!((w.name(), hex(w.look().accent), hex(w.look().bg)), (Some("Day"), "#112233".into(), "#ffffff".into()));
        // a ship with no bucket follows Talon, with nothing of its own
        w.lattice(None);
        assert!(w.follows() && w.mine.is_null());
        w.talon(Some(&json!({ "bucket": { "themes": json!({ "themes": [day()], "activeId": "b" }).to_string() } })));
        assert_eq!(w.name(), Some("Day"));
    }

    #[test]
    fn talons_font_is_worn_unless_its_switch_is_off() {
        let mut w = Worn::default();
        assert_eq!(w.font(), None);
        w.talon(Some(&json!({ "bucket": { "fonts": json!({ "fonts": [{ "id": "ab", "family": "Berkeley Mono", "weight": 400, "italic": false }], "family": "Berkeley Mono", "removed": [] }).to_string() } })));
        assert_eq!(w.font(), Some(Font::Named("Berkeley Mono".into())));
        assert_eq!(w.font_said(), "Talon sets its text in Berkeley Mono, so lattice does too, when Berkeley Mono is installed on this computer.");
        for (family, font) in [("serif", Some(Font::Serif)), ("monospace", Some(Font::Mono)), ("", None), ("  ", None), ("A \"B\", C", Some(Font::Named("A B C".into())))] {
            w.talon_fonts = json!({ "family": family });
            assert_eq!(w.font(), font, "{family}");
        }
        // null is the system's font
        w.talon_fonts = json!({ "family": null });
        assert_eq!(w.font(), None);
        // its own switch, apart from the theme's: the bucket is still read for the font when the theme is lattice's own
        w.talon_fonts = json!({ "family": "serif" });
        w.lattice(Some(&json!({ "bucket": { "use-talon-theme": { "enabled": false } } })));
        assert!(!w.follows() && w.reads_talon() && w.font() == Some(Font::Serif));
        w.lattice(Some(&json!({ "bucket": { "use-talon-font": "{\"enabled\":false}" } })));
        assert!(w.follows() && w.reads_talon() && w.own_font);
        assert_eq!((w.font(), w.font_said()), (None, "Talon\u{2019}s font is ignored here.".to_owned()));
        w.lattice(Some(&json!({ "bucket": { "use-talon-font": { "enabled": false }, "use-talon-theme": { "enabled": false } } })));
        assert!(!w.reads_talon());
    }

    #[test]
    fn the_switches_are_written_as_talons_the_other_way_round() {
        let mut w = Worn::default();
        assert_eq!(w.set_own(true), Put { entry: "use-talon-theme", value: json!({ "enabled": false }) });
        assert!(w.own && !w.follows());
        assert_eq!(w.set_own(false).value, json!({ "enabled": true }));
        assert_eq!(w.set_own_font(true), Put { entry: "use-talon-font", value: json!({ "enabled": false }) });
        assert!(w.own_font);
        // what is written reads back as it was set
        let mut back = Worn::default();
        back.lattice(Some(&json!({ "bucket": { "use-talon-theme": w.clone().set_own(true).value.to_string(), "use-talon-font": w.set_own_font(true).value.to_string() } })));
        assert!(back.own && back.own_font);
    }

    #[test]
    fn one_of_lattices_own_themes_is_picked_and_the_rest_left_alone() {
        let mut w = Worn { own: true, mine: json!({ "themes": [night(), day(), { "id": "broken", "name": "Half" }], "activeId": "a" }), ..Worn::default() };
        assert_eq!(w.themes(), [("a".to_owned(), "Night".to_owned()), ("b".to_owned(), "Day".to_owned())], "a theme that is not whole is not offered");
        assert_eq!(w.own_active(), Some("a"));
        let put = w.set_active(Some("b"));
        assert_eq!((put.entry, &put.value["activeId"], put.value["themes"].as_array().map(Vec::len)), ("themes", &json!("b"), Some(3)));
        assert_eq!((w.own_active(), w.name()), (Some("b"), Some("Day")));
        assert_eq!(w.set_active(None).value["activeId"], Value::Null);
        assert_eq!((w.own_active(), w.look().bg), (None, None), "the built-in look");
        // with nothing kept yet there is still something to write
        assert_eq!(Worn::default().set_active(None).value, json!({ "themes": [], "activeId": null }));
    }

    #[test]
    fn the_accent_is_off_the_profiles_or_a_colour() {
        let mut w = Worn { own: true, ..Worn::default() };
        assert_eq!(w.own_accent(), Accent::Off);
        assert_eq!(w.set_accent(Accent::Custom("#FFCC00".into())).value, json!({ "enabled": true, "mode": "Custom", "customHex": "#FFCC00" }));
        assert_eq!((w.own_accent(), hex(w.look().accent)), (Accent::Custom("#FFCC00".into()), "#ffcc00".to_owned()));
        // off keeps the mode and the colour, to come back to
        assert_eq!(w.set_accent(Accent::Off).value, json!({ "enabled": false, "mode": "Custom", "customHex": "#FFCC00" }));
        assert_eq!((w.own_accent(), w.look().accent), (Accent::Off, None));
        assert_eq!(w.set_accent(Accent::Profile).value, json!({ "enabled": true, "mode": "Profile", "customHex": "#FFCC00" }));
        assert!(w.own_accent() == Accent::Profile && w.wants_profile());
        assert_eq!([hex_of("ffcc00"), hex_of(" #AbCdEf "), hex_of("red"), hex_of("#fff")], [Some("#FFCC00".to_owned()), Some("#ABCDEF".to_owned()), None, None]);
    }

    #[test]
    fn the_theme_worn_is_said() {
        assert_eq!(talon("a", Value::Null).said(), "Lattice follows Talon, which is using \u{201c}Night\u{201d}.");
        assert_eq!(Worn::default().said(), "Lattice follows Talon, which is on its built-in theme.");
        let own = Worn { own: true, mine: json!({ "themes": [day()], "activeId": "b" }), ..Worn::default() };
        assert_eq!(own.said(), "Lattice uses its own theme, \u{201c}Day\u{201d}, whatever Talon uses.");
        assert_eq!(Worn { own: true, ..Worn::default() }.said(), "Lattice uses its own built-in theme, whatever Talon uses.");
    }

    #[test]
    fn what_the_ship_said_is_kept_between_runs() {
        let w = Worn { profile: Some("#ff5050".into()), own: true, ..talon("a", json!({ "enabled": true })) };
        let back: Worn = serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
        assert_eq!(back, w);
        assert_eq!(serde_json::from_str::<Worn>("{}").unwrap(), Worn::default());
    }
}
