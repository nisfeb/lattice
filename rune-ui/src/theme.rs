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

/// A colour as a stylesheet writes it: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
/// `rgb()`/`rgba()`, `hsl()`/`hsla()`, or a standard CSS named colour.
fn css_color(v: &str) -> Option<Color> {
    let s = v.trim().trim_end_matches("!important").trim();
    if let Some(h) = s.strip_prefix('#') {
        let b = h.as_bytes();
        if !b.iter().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let hex2 = |x: &str| u8::from_str_radix(x, 16).ok();
        let (r, g, bl, a) = match h.len() {
            3 => (hex2(&h[0..1])? * 17, hex2(&h[1..2])? * 17, hex2(&h[2..3])? * 17, 255),
            4 => (hex2(&h[0..1])? * 17, hex2(&h[1..2])? * 17, hex2(&h[2..3])? * 17, hex2(&h[3..4])? * 17),
            6 => (hex2(&h[0..2])?, hex2(&h[2..4])?, hex2(&h[4..6])?, 255),
            8 => (hex2(&h[0..2])?, hex2(&h[2..4])?, hex2(&h[4..6])?, hex2(&h[6..8])?),
            _ => return None,
        };
        return Some(rgb(r, g, bl).alpha(a as f32 / 255.0));
    }
    let lower = s.to_ascii_lowercase();
    if let Some(inner) = lower.strip_prefix("rgb(").or_else(|| lower.strip_prefix("rgba(")).and_then(|x| x.strip_suffix(')')) {
        let cleaned = inner.replace([',', '/'], " ");
        let p: Vec<&str> = cleaned.split_whitespace().collect();
        if p.len() == 3 || p.len() == 4 {
            let chan = |t: &str| -> Option<u8> {
                if let Some(pct) = t.strip_suffix('%') {
                    let f: f32 = pct.parse().ok()?;
                    Some((f.clamp(0.0, 100.0) * 2.55).round() as u8)
                } else {
                    let f: f32 = t.parse().ok()?;
                    Some(f.clamp(0.0, 255.0).round() as u8)
                }
            };
            let a = if p.len() == 4 {
                if let Some(pct) = p[3].strip_suffix('%') {
                    (pct.parse::<f32>().ok()? / 100.0).clamp(0.0, 1.0)
                } else {
                    p[3].parse::<f32>().ok()?.clamp(0.0, 1.0)
                }
            } else {
                1.0
            };
            return Some(rgb(chan(p[0])?, chan(p[1])?, chan(p[2])?).alpha(a));
        }
        return None;
    }
    if let Some(inner) = lower.strip_prefix("hsl(").or_else(|| lower.strip_prefix("hsla(")).and_then(|x| x.strip_suffix(')')) {
        let cleaned = inner.replace([',', '/'], " ");
        let p: Vec<&str> = cleaned.split_whitespace().collect();
        if p.len() == 3 || p.len() == 4 {
            let hue_s = p[0].trim_end_matches("deg");
            let h = hue_s.parse::<f32>().ok()?.rem_euclid(360.0);
            let sat = (p[1].strip_suffix('%')?.parse::<f32>().ok()? / 100.0).clamp(0.0, 1.0);
            let lit = (p[2].strip_suffix('%')?.parse::<f32>().ok()? / 100.0).clamp(0.0, 1.0);
            let a = if p.len() == 4 {
                if let Some(pct) = p[3].strip_suffix('%') {
                    (pct.parse::<f32>().ok()? / 100.0).clamp(0.0, 1.0)
                } else {
                    p[3].parse::<f32>().ok()?.clamp(0.0, 1.0)
                }
            } else {
                1.0
            };
            let c = (1.0 - (2.0 * lit - 1.0).abs()) * sat;
            let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
            let m = lit - c / 2.0;
            let (r1, g1, b1) = match h as u32 {
                0..=59 => (c, x, 0.0),
                60..=119 => (x, c, 0.0),
                120..=179 => (0.0, c, x),
                180..=239 => (0.0, x, c),
                240..=299 => (x, 0.0, c),
                _ => (c, 0.0, x),
            };
            let u = |v: f32| ((v + m).clamp(0.0, 1.0) * 255.0).round() as u8;
            return Some(rgb(u(r1), u(g1), u(b1)).alpha(a));
        }
        return None;
    }
    const NAMED: &[(&str, [u8; 3])] = &[
        ("aliceblue", [240, 248, 255]), ("antiquewhite", [250, 235, 215]), ("aqua", [0, 255, 255]),
        ("azure", [240, 255, 255]), ("beige", [245, 245, 220]), ("bisque", [255, 228, 196]),
        ("black", [0, 0, 0]), ("blue", [0, 0, 255]), ("blueviolet", [138, 43, 226]),
        ("brown", [165, 42, 42]), ("cadetblue", [95, 158, 160]), ("chocolate", [210, 105, 30]),
        ("coral", [255, 127, 80]), ("cornflowerblue", [100, 149, 237]), ("cornsilk", [255, 248, 220]),
        ("crimson", [220, 20, 60]), ("cyan", [0, 255, 255]), ("darkblue", [0, 0, 139]),
        ("darkcyan", [0, 139, 139]), ("darkgray", [169, 169, 169]), ("darkgreen", [0, 100, 0]),
        ("darkgrey", [169, 169, 169]), ("darkorange", [255, 140, 0]), ("darkred", [139, 0, 0]),
        ("darkslategray", [47, 79, 79]), ("darkslategrey", [47, 79, 79]), ("deepskyblue", [0, 191, 255]),
        ("dimgray", [105, 105, 105]), ("dimgrey", [105, 105, 105]), ("dodgerblue", [30, 144, 255]),
        ("firebrick", [178, 34, 34]), ("floralwhite", [255, 250, 240]), ("forestgreen", [34, 139, 34]),
        ("fuchsia", [255, 0, 255]), ("gainsboro", [220, 220, 220]), ("ghostwhite", [248, 248, 255]),
        ("gold", [255, 215, 0]), ("goldenrod", [218, 165, 32]), ("gray", [128, 128, 128]),
        ("green", [0, 128, 0]), ("grey", [128, 128, 128]), ("honeydew", [240, 255, 240]),
        ("hotpink", [255, 105, 180]), ("indianred", [205, 92, 92]), ("indigo", [75, 0, 130]),
        ("ivory", [255, 255, 240]), ("khaki", [240, 230, 140]), ("lavender", [230, 230, 250]),
        ("lightblue", [173, 216, 230]), ("lightgray", [211, 211, 211]), ("lightgrey", [211, 211, 211]),
        ("lime", [0, 255, 0]), ("linen", [250, 240, 230]), ("magenta", [255, 0, 255]),
        ("maroon", [128, 0, 0]), ("midnightblue", [25, 25, 112]), ("mintcream", [245, 255, 250]),
        ("navy", [0, 0, 128]), ("oldlace", [253, 245, 230]), ("olive", [128, 128, 0]),
        ("orange", [255, 165, 0]), ("orangered", [255, 69, 0]), ("orchid", [218, 112, 214]),
        ("peru", [205, 133, 63]), ("pink", [255, 192, 203]), ("plum", [221, 160, 221]),
        ("purple", [128, 0, 128]), ("rebeccapurple", [102, 51, 153]), ("red", [255, 0, 0]),
        ("royalblue", [65, 105, 225]), ("saddlebrown", [139, 69, 19]), ("salmon", [250, 128, 114]),
        ("seagreen", [46, 139, 87]), ("seashell", [255, 245, 238]), ("sienna", [160, 82, 45]),
        ("silver", [192, 192, 192]), ("skyblue", [135, 206, 235]), ("slateblue", [106, 90, 205]),
        ("slategray", [112, 128, 144]), ("slategrey", [112, 128, 144]), ("snow", [255, 250, 250]),
        ("steelblue", [70, 130, 180]), ("tan", [210, 180, 140]), ("teal", [0, 128, 128]),
        ("thistle", [216, 191, 216]), ("tomato", [255, 99, 71]), ("turquoise", [64, 224, 208]),
        ("violet", [238, 130, 238]), ("wheat", [245, 222, 179]), ("white", [255, 255, 255]),
        ("whitesmoke", [245, 245, 245]), ("yellow", [255, 255, 0]),
    ];
    if lower == "transparent" {
        return Some(Color::TRANSPARENT);
    }
    NAMED.binary_search_by_key(&lower.as_str(), |(n, _)| *n).ok().map(|i| {
        let [r, g, b] = NAMED[i].1;
        rgb(r, g, b)
    })
}

fn strip_css_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(i) = rest.find("/*") {
        out.push_str(&rest[..i]);
        rest = match rest[i + 2..].find("*/") {
            Some(j) => &rest[i + 2 + j + 2..],
            None => "",
        };
    }
    out.push_str(rest);
    out
}

fn resolve_css_var(raw: &str, vars: &std::collections::HashMap<String, String>, depth: usize) -> Option<Color> {
    if depth > 8 {
        return None;
    }
    let s = raw.trim().trim_end_matches("!important").trim();
    if let Some(inner) = s.strip_prefix("var(").and_then(|x| x.strip_suffix(')')) {
        let (target, fallback) = match inner.split_once(',') {
            Some((a, b)) => (a.trim(), Some(b.trim())),
            None => (inner.trim(), None),
        };
        if let Some(key) = target.strip_prefix("--").map(|k| k.trim().to_ascii_lowercase())
            && let Some(val) = vars.get(&key)
            && let Some(c) = resolve_css_var(val, vars, depth + 1)
        {
            return Some(c);
        }
        return fallback.and_then(|fb| resolve_css_var(fb, vars, depth + 1));
    }
    css_color(s)
}

/// The look a published folder's `theme` stylesheet gives, from the variables the forum's own
/// layout is drawn with (`code/lib/lattice-forum-render.hoon`): `--bg`, `--text`, `--muted`,
/// `--accent`, `--on-accent`, `--link`, `--border`, `--border-soft` and `--raised`. Supports hex,
/// `rgb()`/`rgba()`, `hsl()`/`hsla()`, named CSS colours, and `var(--other, fallback)` references.
/// A variable set inside `@media (prefers-color-scheme: dark)` counts when the window is dark,
/// and one inside any other `@` block never does. With no `--bg` and `--text` both, there is no
/// look: half a theme would be drawn on the wrong ground.
pub fn css_look(css: &str, dark: bool) -> Look {
    let clean = strip_css_comments(css);
    let mut raw_vars: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // which blocks the text is inside: true for one whose variables count
    let mut inside: Vec<bool> = Vec::new();
    let mut rest = clean.as_str();
    let mut head = String::new();
    while let Some(at) = rest.find(['{', '}', ';']) {
        let (before, mark) = (&rest[..at], rest.as_bytes()[at]);
        rest = &rest[at + 1..];
        match mark {
            b'{' => {
                head.push_str(before);
                let h = head.trim().to_lowercase();
                let counts = if h.starts_with('@') { h.starts_with("@media") && h.contains("prefers-color-scheme") && h.contains("dark") && dark } else { true };
                inside.push(counts);
                head.clear();
            }
            b'}' | b';' => {
                head.push_str(before);
                if !inside.is_empty() && inside.iter().all(|c| *c) {
                    if let Some((name, value)) = head.trim().strip_prefix("--").and_then(|d| d.split_once(':')) {
                        let v = value.trim().trim_end_matches("!important").trim();
                        if !v.is_empty() {
                            raw_vars.insert(name.trim().to_lowercase(), v.to_owned());
                        }
                    }
                }
                head.clear();
                if mark == b'}' {
                    inside.pop();
                }
            }
            _ => unreachable!(),
        }
    }
    let named = |k: &str| raw_vars.get(k).and_then(|v| resolve_css_var(v, &raw_vars, 0));
    let (Some(bg), Some(text)) = (named("bg"), named("text")) else { return Look::default() };
    let accent = named("accent");
    Look {
        dark: Some(bg.luminance() < 0.4),
        bg: Some(bg),
        text: Some(text),
        muted: Some(named("muted").unwrap_or_else(|| lerp(text, bg, 0.35))),
        border: Some(named("border").unwrap_or_else(|| lerp(bg, text, 0.4))),
        border_soft: Some(named("border-soft").unwrap_or_else(|| lerp(bg, text, 0.15))),
        link: named("link"),
        raised: named("raised"),
        error: None,
        selection: None,
        accent,
        on_accent: named("on-accent").or_else(|| accent.map(on)),
    }
}

/// Where a board's theme may be: the `theme` page at the board's folder, then at each folder
/// above it, nearest first, as `+find-theme` in `app.hoon` looks.
pub fn board_theme_names(board: &str) -> [String; 3] {
    [format!("forum/{board}/theme"), "forum/theme".to_owned(), "theme".to_owned()]
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

/// The six colours a theme may name in place of having them derived, in Talon's names.
pub const MORE: [&str; 6] = ["text", "muted", "raised", "error", "selection", "link"];

/// A theme being made or changed: what is typed, before it is a theme.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    pub id: String,
    pub name: String,
    pub dark: bool,
    /// Primary, secondary, tertiary, background and surface, as typed.
    pub five: [String; 5],
    /// The six more, as typed. Empty is derived.
    pub more: [String; 6],
}

impl Draft {
    /// A new theme, started from lattice's own colours on a light or a dark ground.
    pub fn new(id: String, dark: bool) -> Draft {
        let (bg, surface) = if dark { ("#1A1A1A", "#242424") } else { ("#FAFAFA", "#FFFFFF") };
        Draft { id, name: String::new(), dark, five: ["#4A7C59", "#7A5AF8", "#0A9A6A", bg, surface].map(str::to_owned), more: Default::default() }
    }

    /// A kept theme, to change.
    pub fn of(t: &Value) -> Draft {
        let s = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        Draft { id: s("id"), name: s("name"), dark: t.get("dark").and_then(Value::as_bool).unwrap_or(false), five: FIVE.map(s), more: MORE.map(s) }
    }

    /// Whether it can be kept: named, with its five colours.
    pub fn valid(&self) -> bool {
        !self.name.trim().is_empty() && !self.id.is_empty() && self.five.iter().all(|c| hex_of(c).is_some())
    }

    /// The theme as it is kept, in Talon's shape: every colour in capitals, and each of the six written, empty for derived.
    pub fn value(&self) -> Value {
        let mut t = serde_json::json!({ "id": self.id, "name": self.name.trim(), "dark": self.dark });
        for (k, c) in FIVE.iter().zip(&self.five) {
            t[*k] = Value::String(hex_of(c).unwrap_or_default());
        }
        for (k, c) in MORE.iter().zip(&self.more) {
            t[*k] = Value::String(hex_of(c).unwrap_or_default());
        }
        t
    }

    /// How it would look, to show while it is made. Nothing until its primary and surface are colours.
    pub fn look(&self) -> Look {
        theme_look(&self.value())
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

    /// The theme in use among lattice's own, to change.
    pub fn own_draft(&self) -> Option<Draft> {
        active(&self.mine).map(Draft::of)
    }

    /// Keeps a theme made or changed, in place of the one with its id, and wears it. The others are left as they are.
    pub fn save_theme(&mut self, d: &Draft) -> Put {
        let mut all: Vec<Value> = self.mine.get("themes").and_then(Value::as_array).cloned().unwrap_or_default();
        all.retain(|t| t.get("id").and_then(Value::as_str) != Some(d.id.as_str()));
        all.push(d.value());
        self.mine = serde_json::json!({ "themes": all, "activeId": d.id });
        Put { entry: "themes", value: self.mine.clone() }
    }

    /// Drops one of lattice's own themes. The built-in look is worn after it.
    pub fn delete_theme(&mut self, id: &str) -> Put {
        let mut all: Vec<Value> = self.mine.get("themes").and_then(Value::as_array).cloned().unwrap_or_default();
        all.retain(|t| t.get("id").and_then(Value::as_str) != Some(id));
        self.mine = serde_json::json!({ "themes": all, "activeId": null });
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

    /// The files of the font Talon sets its text in, when it is an
    /// installed family: the ids of that family's faces in grubbery's
    /// store (`talon/fonts/<id>.font`), each the sha256 of its file.
    /// One Talon removed, or with an id that is no hash, is left out.
    pub fn font_ids(&self) -> Vec<String> {
        let Some(Font::Named(_)) = self.font() else { return Vec::new() };
        let family = self.talon_fonts.get("family").and_then(Value::as_str).unwrap_or_default();
        let gone: Vec<&str> = self.talon_fonts.get("removed").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let faces = self.talon_fonts.get("fonts").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let mut ids: Vec<String> = faces
            .iter()
            .filter(|x| x.get("family").and_then(Value::as_str) == Some(family))
            .filter_map(|x| x.get("id").and_then(Value::as_str))
            .filter(|id| id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) && !gone.contains(id))
            .map(str::to_owned)
            .collect();
        ids.dedup();
        // a family is a handful of faces
        // ponytail: 24 faces at most. A larger family loses the rest without a word
        ids.truncate(24);
        ids
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

    #[test]
    fn a_theme_sheet_gives_the_forum_its_colours() {
        let css = ":root { --bg: #fdf6e3; --text:#073642; --muted: #657b83; --accent: #b58900; --link: #268bd2; --raised: #eee8d5; --pop: red; --border: rgb(1,2,3) }\n\
            body { color: var(--text) }\n\
            @media (prefers-color-scheme: dark) { :root { --bg: #002b36; --text: #eee; } }\n\
            @media print { :root { --bg: #ffffff; } }";
        let day = css_look(css, false);
        assert_eq!((hex(day.bg).as_str(), hex(day.text).as_str(), hex(day.muted).as_str()), ("#fdf6e3", "#073642", "#657b83"));
        assert_eq!((hex(day.accent).as_str(), hex(day.link).as_str(), hex(day.raised).as_str()), ("#b58900", "#268bd2", "#eee8d5"));
        assert_eq!(day.dark, Some(false));
        assert_eq!(hex(day.border), "#010203", "rgb() colours are parsed directly");
        assert!(day.on_accent.is_some(), "the ink on the accent is worked out when the sheet has none");
        let night = css_look(css, true);
        assert_eq!((hex(night.bg).as_str(), hex(night.text).as_str(), night.dark), ("#002b36", "#eeeeee", Some(true)));
        assert_eq!(hex(night.accent), "#b58900", "what the dark block leaves alone stays");
        // half a theme, or none, is no look
        assert_eq!(css_look(":root { --bg: #000 }", false), Look::default());
        assert_eq!(css_look("body { margin: 0 }", false), Look::default());
        assert_eq!(css_look("@media (prefers-color-scheme: dark) { :root { --bg:#000; --text:#fff } }", false), Look::default());
    }

    #[test]
    fn a_board_looks_for_its_theme_nearest_first() {
        assert_eq!(board_theme_names("tech"), ["forum/tech/theme", "forum/theme", "theme"]);
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
    fn the_files_of_talons_font_are_the_chosen_familys_faces() {
        let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
        let mut w = Worn::default();
        w.talon_fonts = json!({ "family": "Berkeley Mono", "removed": [c], "fonts": [
            { "id": a, "family": "Berkeley Mono", "weight": 400, "italic": false },
            { "id": b, "family": "Other", "weight": 400, "italic": false },
            { "id": c, "family": "Berkeley Mono", "weight": 700, "italic": false },
            { "id": "../../etc/passwd", "family": "Berkeley Mono" },
            { "id": "A".repeat(64), "family": "Berkeley Mono" },
        ] });
        assert_eq!(w.font_ids(), [a.clone()], "its family's, not removed, and named by a hash");
        w.own_font = true;
        assert!(w.font_ids().is_empty(), "Talon's font is not followed");
        w.own_font = false;
        w.talon_fonts["family"] = json!("serif");
        assert!(w.font_ids().is_empty(), "a generic family has no files");
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
    fn a_theme_is_made_changed_and_dropped() {
        let mut d = Draft::new("n1".into(), true);
        assert!(!d.valid(), "not until it is named");
        assert_eq!((d.five[3].as_str(), d.five[4].as_str()), ("#1A1A1A", "#242424"));
        assert_eq!(Draft::new("n2".into(), false).five[4], "#FFFFFF");
        d.name = " Dusk ".into();
        d.five[0] = "ffcc00".into();
        d.more[5] = "#0055aa".into();
        d.more[0] = "nope".into();
        assert!(d.valid());
        let v = d.value();
        assert_eq!((&v["name"], &v["primary"], &v["link"], &v["text"], &v["muted"]), (&json!("Dusk"), &json!("#FFCC00"), &json!("#0055AA"), &json!(""), &json!("")), "each of the six is written, empty for derived");
        assert_eq!((hex(d.look().accent), hex(d.look().bg), hex(d.look().link)), ("#ffcc00".to_owned(), "#242424".to_owned(), "#0055aa".to_owned()));
        d.five[4] = "#12".into();
        assert!(!d.valid() && d.look() == Look::default());
        d.five[4] = "#242424".into();
        // kept among the others, and worn
        let mut w = Worn { own: true, mine: json!({ "themes": [night()], "activeId": "a" }), ..Worn::default() };
        let put = w.save_theme(&d);
        assert_eq!((put.entry, w.own_active(), w.themes().len()), ("themes", Some("n1"), 2));
        // changed in place: the same id is one theme still
        let mut again = w.own_draft().unwrap();
        assert_eq!(again, Draft { name: "Dusk".into(), five: ["#FFCC00", "#7A5AF8", "#0A9A6A", "#1A1A1A", "#242424"].map(str::to_owned), more: ["", "", "", "", "", "#0055AA"].map(str::to_owned), ..d.clone() });
        again.name = "Dusk two".into();
        w.save_theme(&again);
        assert_eq!(w.themes(), [("a".to_owned(), "Night".to_owned()), ("n1".to_owned(), "Dusk two".to_owned())]);
        // dropped: the built-in look, and the other theme left
        let put = w.delete_theme("n1");
        assert_eq!((put.value["activeId"].clone(), w.themes(), w.own_active()), (Value::Null, vec![("a".to_owned(), "Night".to_owned())], None));
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

    #[test]
    fn css_look_parses_rgb_hsl_named_colours_and_var_references() {
        let css = r#"
            /* board theme with modern CSS colours and var() chains */
            :root {
                --base: rgb(250, 245, 235);
                --ink: hsl(220, 25%, 15%);
                --bg: var(--base);
                --text: var(--ink);
                --accent: rebeccapurple;
                --link: var(--missing, steelblue);
                --border: rgba(0 0 0 / 20%);
                --loop-a: var(--loop-b);
                --loop-b: var(--loop-a);
                --raised: var(--loop-a);
            }
        "#;
        let l = css_look(css, false);
        assert_eq!(l.dark, Some(false));
        assert_eq!(hex(l.bg), "#faf5eb");
        assert_eq!(hex(l.accent), "#663399");
        assert_eq!(hex(l.link), "#4682b4");
        assert!(l.text.is_some() && l.border.is_some());
        assert_eq!(l.raised, None, "cyclic var() terminates safely");
    }
}
