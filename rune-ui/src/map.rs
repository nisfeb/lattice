//! A map page (GeoJSON) drawn natively: points, lines and areas on a plain
//! ground with a graticule, panned by a drag and zoomed by the wheel. No
//! tiles: the shapes are the page's own, in Web Mercator.

use serde_json::Value;

/// A position in the unit square of Web Mercator: x east, y south, 0 to 1.
pub type P = [f64; 2];

#[derive(Debug, PartialEq)]
pub enum Geom {
    Point(P),
    Line(Vec<P>),
    /// The outer ring. Holes are not drawn.
    Area(Vec<P>),
}

#[derive(Debug, PartialEq)]
pub struct Feature {
    pub name: String,
    pub note: String,
    /// The properties, in the page's order, as text.
    pub props: Vec<(String, String)>,
    pub geoms: Vec<Geom>,
    /// Where it is among the page's features, counting those with nothing to draw.
    pub at: usize,
    /// The corners of its lines and areas that can be moved: where each
    /// is in the geometry's coordinates, and where it is on the map.
    /// Empty for a shape with more than a thousand, as on the web.
    pub corners: Vec<(Vec<usize>, P)>,
    /// The radius in metres of the ring round a point, or 0 for none.
    pub radius: f64,
    /// What kind of thing it is, or nothing. A map is filtered by it.
    pub kind: String,
    /// Its colour as `#rgb` or `#rrggbb`: its own, else its kind's, else blue.
    pub color: String,
    /// The glyph a point shows, or nothing for a plain dot.
    pub icon: &'static str,
    /// Parsed Unix timestamp (seconds) from `properties.time`, when valid.
    pub time_epoch: Option<i64>,
}

/// The icons a feature may name, each with its glyph, as on the web.
/// The pin alone differs: the web's U+2316 is in no font Rune falls back to
/// on Linux and drew as an empty box, so it is the circled plus here.
pub const ICONS: [(&str, &str); 16] = [
    ("dot", ""), ("pin", "⊕"), ("star", "★"), ("flag", "⚑"), ("home", "⌂"), ("camera", "◉"), ("alert", "⚠"), ("person", "☺"),
    ("car", "▣"), ("boat", "⛵"), ("plane", "✈"), ("fire", "♨"), ("water", "≈"), ("tent", "△"), ("cross", "✚"), ("question", "?"),
];
/// The name of the icon a glyph stands for, or nothing for a plain dot.
pub fn pin_of(glyph: &str) -> &'static str {
    ICONS.iter().find(|(_, g)| !g.is_empty() && *g == glyph).map_or("", |(n, _)| *n)
}

/// The icon a kind gets when the feature names none.
const KIND_ICON: [(&str, &str); 5] = [("place", "pin"), ("situation", "flag"), ("person", "person"), ("home", "home"), ("report", "alert")];
pub const KIND_COLORS: [&str; 8] = ["#c0392b", "#2e86c1", "#28a745", "#8e44ad", "#d68910", "#16a085", "#7f8c8d", "#e84393"];

/// Where on the ship a feature of orrery's map leads: its body's page.
/// The property names the body as `kind/name`. `None` for anything else.
pub fn orrery_link(v: &str) -> Option<String> {
    let (kind, name) = v.split_once('/')?;
    let kind_ok = kind.starts_with(|c: char| c.is_ascii_lowercase()) && kind.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let name_ok = !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"~._-".contains(&b));
    (v.len() <= 200 && kind_ok && name_ok).then(|| format!("/apps/orrery#body/{v}"))
}

/// What a feature's source leads to.
#[derive(Debug, PartialEq)]
pub enum Source {
    /// An address on the web.
    Url(String),
    /// A page of this lattice.
    Page(String),
}

/// A source as something to follow: an http or https address, a page's
/// name, bare or as a wiki link, or nothing. Another scheme is never a link.
pub fn source_link(s: &str) -> Option<Source> {
    let v = s.trim();
    let scheme = v.split_once(':').map(|(a, _)| a).filter(|a| a.starts_with(|c: char| c.is_ascii_alphabetic()) && a.bytes().all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b)));
    if let Some(scheme) = scheme {
        let web = matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") && v[scheme.len()..].starts_with("://") && v.len() > scheme.len() + 3 && !v.contains(char::is_whitespace);
        return web.then(|| Source::Url(v.to_owned()));
    }
    let page = v.strip_prefix("[[").unwrap_or(v);
    let page = page.strip_suffix("]]").unwrap_or(page).trim_start_matches('/');
    let ok = !page.is_empty() && page.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"~._-".contains(&b)));
    ok.then(|| Source::Page(page.to_owned()))
}

/// The colour a kind is drawn in: the web client's own choice, so a map
/// looks the same in both.
pub fn kind_color(kind: &str) -> &'static str {
    let h = kind.encode_utf16().fold(0i32, |h, c| h.wrapping_mul(31).wrapping_add(c as i32));
    KIND_COLORS[h.unsigned_abs() as usize % KIND_COLORS.len()]
}

/// A feature's kind, colour and glyph from its properties, each checked.
fn look(p: &Value) -> (String, String, &'static str) {
    let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("");
    let kind: String = s("kind").chars().take(40).collect::<String>().trim().to_owned();
    let own = s("color");
    let hex = own.strip_prefix('#').is_some_and(|h| matches!(h.len(), 3 | 6) && h.bytes().all(|b| b.is_ascii_hexdigit()));
    let color = if hex { own.to_owned() } else if kind.is_empty() { "#2e86c1".to_owned() } else { kind_color(&kind).to_owned() };
    let named = Some(s("icon")).filter(|i| ICONS.iter().any(|(n, _)| n == i)).or_else(|| KIND_ICON.iter().find(|(k, _)| *k == kind).map(|(_, i)| *i));
    let icon = named.and_then(|i| ICONS.iter().find(|(n, _)| *n == i)).map_or("", |(_, g)| *g);
    (kind, color, icon)
}

/// The kinds a map's features have, in order, each with how many. A
/// feature with none counts under the empty kind.
pub fn kinds(feats: &[Feature]) -> Vec<(String, usize)> {
    let mut m = std::collections::BTreeMap::new();
    for f in feats {
        *m.entry(f.kind.clone()).or_insert(0) += 1;
    }
    m.into_iter().collect()
}

/// The furthest east or west a longitude is taken to be: two turns of
/// the world. A page may go past 180 to cross the date line, but a
/// longitude of 1e300 is no place, and drawn it would be no number.
const LON_MOST: f64 = 720.0;

/// Longitude and latitude to the unit square. The latitude is held inside
/// what Mercator can show, and the longitude inside `LON_MOST`, so the
/// answer is always a number whatever is asked: what is not a number at
/// all is taken as nought.
pub fn mercator(lon: f64, lat: f64) -> P {
    let lon = if lon.is_nan() { 0.0 } else { lon.clamp(-LON_MOST, LON_MOST) };
    let lat = if lat.is_nan() { 0.0 } else { lat.clamp(-85.0511, 85.0511) }.to_radians();
    [lon / 360.0 + 0.5, 0.5 - (std::f64::consts::FRAC_PI_4 + lat / 2.0).tan().ln() / std::f64::consts::TAU]
}

/// The longitude and latitude of a position on the unit square: what
/// `mercator` undoes. The longitude is held in -180 to 180. A position
/// that is not a number is the middle of the map.
pub fn lonlat(p: P) -> [f64; 2] {
    let p = [if p[0].is_finite() { p[0] } else { 0.5 }, if p[1].is_nan() { 0.5 } else { p[1] }];
    let lon = ((p[0] - 0.5) * 360.0 + 180.0).rem_euclid(360.0) - 180.0;
    [lon, (std::f64::consts::PI * (1.0 - 2.0 * p[1])).sinh().atan().to_degrees().clamp(-85.0511, 85.0511)]
}

/// A position of the page on the map. One that is not two numbers is no
/// position, and is left out.
fn pos(v: &Value) -> Option<P> {
    let a = v.as_array()?;
    let (lon, lat) = (a.first()?.as_f64()?, a.get(1)?.as_f64()?);
    (lon.is_finite() && lat.is_finite()).then(|| mercator(lon, lat))
}

fn ring(v: &Value) -> Vec<P> {
    v.as_array().map_or(Vec::new(), |a| a.iter().filter_map(pos).collect())
}

/// The corners of a line or an area, each with its path into the
/// coordinates. An area's closing position is its first again, so it is
/// not a corner of its own.
fn corners(g: &Value) -> Vec<(Vec<usize>, P)> {
    fn walk(c: &Value, depth: usize, closed: bool, path: &mut Vec<usize>, out: &mut Vec<(Vec<usize>, P)>) {
        let Some(a) = c.as_array() else { return };
        let n = if depth == 0 && closed { a.len().saturating_sub(1) } else { a.len() };
        for (i, x) in a.iter().take(n).enumerate() {
            path.push(i);
            match depth {
                0 => out.extend(pos(x).map(|p| (path.clone(), p))),
                _ => walk(x, depth - 1, closed, path, out),
            }
            path.pop();
        }
    }
    let (depth, closed) = match g["type"].as_str() {
        Some("LineString") => (0, false),
        Some("MultiLineString") => (1, false),
        Some("Polygon") => (1, true),
        Some("MultiPolygon") => (2, true),
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    walk(&g["coordinates"], depth, closed, &mut Vec::new(), &mut out);
    if out.len() > 1000 { Vec::new() } else { out }
}

fn geoms(g: &Value, out: &mut Vec<Geom>) {
    let c = &g["coordinates"];
    let each = |f: &mut dyn FnMut(&Value)| c.as_array().into_iter().flatten().for_each(f);
    match g["type"].as_str() {
        Some("Point") => out.extend(pos(c).map(Geom::Point)),
        Some("MultiPoint") => each(&mut |p| out.extend(pos(p).map(Geom::Point))),
        Some("LineString") => out.push(Geom::Line(ring(c))),
        Some("MultiLineString") => each(&mut |l| out.push(Geom::Line(ring(l)))),
        Some("Polygon") => out.push(Geom::Area(ring(&c[0]))),
        Some("MultiPolygon") => each(&mut |p| out.push(Geom::Area(ring(&p[0])))),
        Some("GeometryCollection") => g["geometries"].as_array().into_iter().flatten().for_each(|x| geoms(x, out)),
        _ => {}
    }
    // a shape with too few positions to draw is no shape
    out.retain(|g| match g {
        Geom::Point(_) => true,
        Geom::Line(l) => l.len() >= 2,
        Geom::Area(a) => a.len() >= 3,
    });
}

/// The most features of a page that are drawn, and the most positions
/// in all. The view builds every shape again for each frame, so a page
/// of 200,000 positions held the window for seconds at a time. A page
/// may hold more (`MAX_FEATURES`, `MAX_POSITIONS`): the rest is kept in
/// the page and not drawn.
pub const SHOWN_FEATURES: usize = 5_000;
pub const SHOWN_POINTS: usize = 20_000;

/// What of a page was not drawn as it is written.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Cut {
    /// How many features with a shape are left out.
    pub features: usize,
    /// Whether lines and areas are drawn with fewer positions than they have.
    pub thinned: bool,
}

impl Cut {
    /// A line to tell the reader, or nothing when the whole map is drawn.
    // for the map's view to show: until it does, only the tests ask
    #[allow(dead_code)]
    pub fn notice(&self) -> Option<String> {
        match (self.features, self.thinned) {
            (0, false) => None,
            (0, true) => Some("This map is too large to draw in full: its lines are drawn roughly.".into()),
            (n, false) => Some(format!("This map is too large to draw in full: {n} of its shapes are not shown.")),
            (n, true) => Some(format!("This map is too large to draw in full: {n} of its shapes are not shown, and its lines are drawn roughly.")),
        }
    }
}

/// The features of a GeoJSON page that have something to draw. `None` when
/// the text is not a FeatureCollection.
///
/// No more than `SHOWN_FEATURES` features and `SHOWN_POINTS` positions
/// come back: see `parse_cut`, which also says whether the page was cut
/// short. This keeps the answer it always had, so a caller that does not
/// ask is still safe from a page too large to draw.
pub fn parse(body: &str) -> Option<Vec<Feature>> {
    parse_cut(body).map(|(feats, _)| feats)
}

/// The features of a GeoJSON page that have something to draw, and what
/// of the page was left out to keep the drawing quick. Past
/// `SHOWN_FEATURES` features the rest are left out. Past `SHOWN_POINTS`
/// positions, lines and areas are thinned evenly, each keeping its ends,
/// and if that is not enough the shapes past the limit are left out.
/// Each feature keeps its place in the page (`at`), and its corners are
/// those of the page, so what is drawn can still be edited.
pub fn parse_cut(body: &str) -> Option<(Vec<Feature>, Cut)> {
    let v: Value = serde_json::from_str(body).ok()?;
    let feats = v["features"].as_array()?;
    let text = |v: &Value| match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    let mut cut = Cut::default();
    let mut out: Vec<Feature> = Vec::new();
    for (at, f) in feats.iter().enumerate() {
        let mut g = Vec::new();
        geoms(&f["geometry"], &mut g);
        if g.is_empty() {
            continue;
        }
        if out.len() >= SHOWN_FEATURES {
            cut.features += 1;
            continue;
        }
        let p = &f["properties"];
        let props = p.as_object().map_or(Vec::new(), |o| o.iter().map(|(k, v)| (k.clone(), text(v))).filter(|(_, v)| !v.is_empty()).collect());
        let (kind, color, icon) = look(p);
        let time_epoch = p.get("time").and_then(Value::as_str).and_then(parse_time_epoch);
        out.push(Feature { name: text(&p["name"]), note: text(&p["note"]), props, geoms: g, at, corners: corners(&f["geometry"]), radius: p["radius"].as_f64().filter(|r| r.is_finite() && *r > 0.0 && *r <= 2e7).unwrap_or(0.0), kind, color, icon, time_epoch });
    }
    let count = |g: &Geom| match g {
        Geom::Point(_) => 1,
        Geom::Line(l) | Geom::Area(l) => l.len(),
    };
    let all: usize = out.iter().flat_map(|f| &f.geoms).map(count).sum();
    if all > SHOWN_POINTS {
        // every line and area gives up the same share of its positions, down to the fewest that still draw it
        let points = out.iter().flat_map(|f| &f.geoms).filter(|g| matches!(g, Geom::Point(_))).count();
        let share = SHOWN_POINTS.saturating_sub(points) as f64 / (all - points).max(1) as f64;
        let mut left = SHOWN_POINTS;
        for f in &mut out {
            for g in &mut f.geoms {
                if let Geom::Line(l) | Geom::Area(l) = g {
                    let most = ((l.len() as f64 * share) as usize).max(4);
                    if l.len() > most {
                        *l = thin(l, most);
                        cut.thinned = true;
                    }
                }
            }
            // and what is still past the limit is left out
            f.geoms.retain(|g| {
                let n = count(g);
                let fits = n <= left;
                left -= if fits { n } else { 0 };
                fits
            });
        }
        cut.features += out.iter().filter(|f| f.geoms.is_empty()).count();
        out.retain(|f| !f.geoms.is_empty());
    }
    Some((out, cut))
}

/// Where the map is looking: the world position at the view's centre, and
/// how many points one world unit (the whole Earth's width) spans.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub at: P,
    pub scale: f64,
}

/// One world unit is never smaller than a small window or larger than a
/// street: about zoom 0 to zoom 20 on a tiled map.
const SCALE: (f64, f64) = (200.0, 256.0 * 1_048_576.0);

/// How far east or west of the map the camera may look: as far as a
/// longitude may be (`LON_MOST`), and a world more.
const AT: (f64, f64) = (-2.5, 3.5);

impl Camera {
    /// The camera that shows every feature inside a `w` by `h` view with a
    /// margin, or the whole world when there is nothing to show.
    pub fn fit<'a>(feats: impl IntoIterator<Item = &'a Feature>, w: f32, h: f32) -> Camera {
        let pts = feats.into_iter().flat_map(|f| &f.geoms).flat_map(|g| match g {
            Geom::Point(p) => std::slice::from_ref(p),
            Geom::Line(l) | Geom::Area(l) => l.as_slice(),
        });
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for p in pts {
            for i in 0..2 {
                lo[i] = lo[i].min(p[i]);
                hi[i] = hi[i].max(p[i]);
            }
        }
        if lo[0] > hi[0] {
            return Camera { at: [0.5, 0.5], scale: (w as f64).max(SCALE.0) };
        }
        let (w, h) = ((w as f64 - 80.0).max(40.0), (h as f64 - 80.0).max(40.0));
        // one point alone gets a town's worth of ground around it
        let span = [(hi[0] - lo[0]).max(1e-5), (hi[1] - lo[1]).max(1e-5)];
        let scale = (w / span[0]).min(h / span[1]).clamp(SCALE.0, SCALE.1);
        Camera { at: [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0], scale }
    }

    /// A world position in the view's own points.
    pub fn project(&self, p: P, w: f32, h: f32) -> [f32; 2] {
        [((p[0] - self.at[0]) * self.scale) as f32 + w / 2.0, ((p[1] - self.at[1]) * self.scale) as f32 + h / 2.0]
    }

    /// The world position under a point of the view.
    pub fn unproject(&self, x: f32, y: f32, w: f32, h: f32) -> P {
        [self.at[0] + (x - w / 2.0) as f64 / self.scale, self.at[1] + (y - h / 2.0) as f64 / self.scale]
    }

    /// Zooms by `factor` keeping the world position under (`x`, `y`) there.
    pub fn zoom_at(&mut self, factor: f64, x: f32, y: f32, w: f32, h: f32) {
        let under = self.unproject(x, y, w, h);
        let scale = (self.scale * factor).clamp(SCALE.0, SCALE.1);
        let at = [under[0] - (x - w / 2.0) as f64 / scale, under[1] - (y - h / 2.0) as f64 / scale];
        // a step that is not a number moves nothing
        if scale.is_finite() && at[0].is_finite() && at[1].is_finite() {
            (self.scale, self.at) = (scale, [at[0].clamp(AT.0, AT.1), at[1]]);
        }
    }

    /// The camera `from` moved by a drag of (`dx`, `dy`) points. It stays
    /// within a few worlds of the map, so nothing worked out from where
    /// it looks can run past what a number holds.
    pub fn dragged(from: Camera, dx: f32, dy: f32) -> Camera {
        let at = [from.at[0] - dx as f64 / from.scale, from.at[1] - dy as f64 / from.scale];
        if !(at[0].is_finite() && at[1].is_finite()) {
            return from;
        }
        Camera { at: [at[0].clamp(AT.0, AT.1), at[1].clamp(0.0, 1.0)], scale: from.scale }
    }

    /// The step in degrees between graticule lines, so that a few cross the view.
    pub fn grid_step(&self, w: f32) -> f64 {
        let across = w as f64 / self.scale * 360.0;
        [90.0, 45.0, 30.0, 10.0, 5.0, 2.0, 1.0, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001]
            .into_iter()
            .find(|s| across / s >= 3.0)
            .unwrap_or(0.001)
    }
}

/// A line thinned to at most `max` positions, its ends kept.
/// One map tile: its zoom and its place in that zoom's grid. A tile at
/// zoom `z` covers a `2^z`th of the world each way.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Tile {
    pub z: u32,
    pub x: u32,
    pub y: u32,
}

/// The most tiles asked for at once: a view never needs more, and the
/// ship fetches a bounded number a minute.
pub const MAX_TILES: usize = 24;

/// The tiles that cover a `w` by `h` view, nearest the middle first. The
/// zoom is the one whose tiles draw nearest 512 points across, which is
/// the size they are made at, and no deeper than `max_z`.
pub fn tiles(cam: &Camera, w: f32, h: f32, max_z: u32) -> Vec<Tile> {
    // no deeper than a tile's place can be counted in
    let z = (cam.scale / 512.0).log2().round().clamp(0.0, f64::from(max_z.min(30))) as u32;
    let n = f64::from(1u32 << z);
    let (a, b) = (cam.unproject(0.0, 0.0, w, h), cam.unproject(w, h, w, h));
    // a view that is nowhere has no tiles, and a view of more tiles than could be asked for is not counted through
    if !a.iter().chain(&b).all(|v| v.is_finite()) || (b[0] - a[0]) * n * (b[1] - a[1]) * n > 1e6 {
        return Vec::new();
    }
    // the world does not wrap here: what is past its edge has no tile
    let span = |lo: f64, hi: f64| ((lo * n).floor().max(0.0) as u32, ((hi * n).ceil() - 1.0).min(n - 1.0).max(-1.0));
    let ((x0, x1), (y0, y1)) = (span(a[0], b[0]), span(a[1], b[1]));
    let mut out = Vec::new();
    if x1 < 0.0 || y1 < 0.0 {
        return out;
    }
    for y in y0..=y1 as u32 {
        for x in x0..=x1 as u32 {
            out.push(Tile { z, x, y });
        }
    }
    let mid = [cam.at[0] * n - 0.5, cam.at[1] * n - 0.5];
    out.sort_by(|p, q| {
        let d = |t: &Tile| (f64::from(t.x) - mid[0]).powi(2) + (f64::from(t.y) - mid[1]).powi(2);
        d(p).total_cmp(&d(q))
    });
    out.truncate(MAX_TILES);
    out
}

/// Where a tile draws in the view: its left, its top and its side.
pub fn tile_rect(cam: &Camera, t: &Tile, w: f32, h: f32) -> [f32; 3] {
    let n = f64::from(1u32 << t.z);
    let at = cam.project([f64::from(t.x) / n, f64::from(t.y) / n], w, h);
    [at[0], at[1], (cam.scale / n) as f32]
}

/// The base maps a page may name, in the order they are offered.
pub const STYLES: [&str; 4] = ["streets", "outdoors", "satellite", "dark"];

/// Over this many bytes a map is shown and never rewritten, as on the web.
const BIG: usize = 4 * 1024 * 1024;

/// A JSON value as JavaScript's `JSON.stringify` writes it: a number
/// that is whole has no `.0`, which is where serde's own writer differs.
fn js(v: &Value, out: &mut String) {
    match v {
        Value::Number(n) if n.is_f64() => out.push_str(&n.as_f64().map_or("null".to_owned(), |f| if f.is_finite() { format!("{f}") } else { "null".into() })),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                js(x, out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// A geometry with every coordinate rounded to seven places, about a centimetre.
fn round_geom(g: &Value) -> Value {
    fn deep(c: &Value) -> Value {
        match c {
            Value::Array(a) if a.first().is_some_and(Value::is_number) => Value::Array(a.iter().map(|n| n.as_f64().filter(|f| f.is_finite()).and_then(|f| serde_json::Number::from_f64((f * 1e7).round() / 1e7)).map_or(n.clone(), Value::Number)).collect()),
            Value::Array(a) => Value::Array(a.iter().map(deep).collect()),
            other => other.clone(),
        }
    }
    let Value::Object(o) = g else { return g.clone() };
    Value::Object(
        o.iter()
            .map(|(k, v)| {
                let v = match (k.as_str(), v) {
                    ("coordinates", c) => deep(c),
                    ("geometries", Value::Array(a)) => Value::Array(a.iter().map(round_geom).collect()),
                    (_, v) => v.clone(),
                };
                (k.clone(), v)
            })
            .collect(),
    )
}

/// A map page in lattice's own layout, as the web client writes one:
/// the view first, then whatever else the collection held, then one
/// feature to a line with its type, geometry, properties and id first.
/// `None` for what is not a map, or one too large to rewrite.
pub fn serialize(doc: &Value) -> Option<String> {
    let o = doc.as_object().filter(|o| o.get("type").and_then(Value::as_str) == Some("FeatureCollection"))?;
    let feats = o.get("features")?.as_array()?;
    let mut s = String::from("{\"type\":\"FeatureCollection\",\"lattice\":");
    js(o.get("lattice").filter(|l| l.is_object()).unwrap_or(&Value::Object(Default::default())), &mut s);
    for (k, v) in o.iter().filter(|(k, _)| !matches!(k.as_str(), "type" | "lattice" | "features")) {
        s.push(',');
        s.push_str(&Value::String(k.clone()).to_string());
        s.push(':');
        js(v, &mut s);
    }
    s.push_str(",\"features\":[\n");
    for (i, f) in feats.iter().enumerate() {
        let f = f.as_object()?;
        let mut line = serde_json::Map::new();
        line.insert("type".into(), "Feature".into());
        line.insert("geometry".into(), round_geom(f.get("geometry").unwrap_or(&Value::Null)));
        line.insert("properties".into(), f.get("properties").cloned().unwrap_or_else(|| Value::Object(Default::default())));
        if let Some(id) = f.get("id") {
            line.insert("id".into(), id.clone());
        }
        for (k, v) in f.iter().filter(|(k, _)| !matches!(k.as_str(), "type" | "geometry" | "properties" | "id")) {
            line.insert(k.clone(), v.clone());
        }
        js(&Value::Object(line), &mut s);
        s.push_str(if i + 1 < feats.len() { ",\n" } else { "\n" });
    }
    s.push_str("]}\n");
    Some(s)
}

/// A map page with its base map set, in lattice's layout. `None` for a
/// page that is not a map, a base that is not one of `STYLES`, or a map
/// too large to rewrite.
pub fn with_base(body: &str, style: &str) -> Option<String> {
    if !STYLES.contains(&style) {
        return None;
    }
    change(body, |o| {
        if !o.get("lattice").is_some_and(Value::is_object) {
            o.insert("lattice".into(), Value::Object(Default::default()));
        }
        o.get_mut("lattice")?.as_object_mut()?.insert("base".into(), style.into());
        Some(())
    })
}

/// A map page after `f` changed it, in lattice's layout. `None` when the
/// page is not a map, `f` refuses, or the map is or would be too large.
fn change(body: &str, f: impl FnOnce(&mut serde_json::Map<String, Value>) -> Option<()>) -> Option<String> {
    if body.len() > BIG {
        return None;
    }
    let mut doc: Value = serde_json::from_str(body).ok()?;
    f(doc.as_object_mut()?)?;
    serialize(&doc).filter(|s| s.len() <= BIG)
}

/// A map page with properties of its feature `at` set, or with `None`
/// taken away. The others keep their order, and a new one goes last.
pub fn set_props(body: &str, at: usize, props: &[(&str, Option<Value>)]) -> Option<String> {
    change(body, |d| {
        let f = d.get_mut("features")?.as_array_mut()?.get_mut(at)?.as_object_mut()?;
        if !f.get("properties").is_some_and(Value::is_object) {
            f.insert("properties".into(), Value::Object(Default::default()));
        }
        let p = f.get_mut("properties")?.as_object_mut()?;
        for (k, v) in props {
            match v {
                Some(v) => drop(p.insert((*k).into(), v.clone())),
                None => drop(p.shift_remove(*k)),
            }
        }
        Some(())
    })
}

/// A map page without its feature `at`.
pub fn remove(body: &str, at: usize) -> Option<String> {
    change(body, |d| {
        let a = d.get_mut("features")?.as_array_mut()?;
        (at < a.len()).then(|| drop(a.remove(at)))
    })
}

/// What a press on the map draws.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Draw {
    Point,
    Line,
    Area,
    /// A point with a ring round it: its centre, then somewhere on its edge.
    Ring,
}

/// How far apart two places are over the ground, in metres. Each is a
/// longitude and latitude. The Earth is taken as a sphere, as Leaflet does.
pub fn distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (la, lb) = (a[1].to_radians(), b[1].to_radians());
    let h = ((lb - la) / 2.0).sin().powi(2) + la.cos() * lb.cos() * ((b[0] - a[0]).to_radians() / 2.0).sin().powi(2);
    2.0 * 6_371_000.0 * h.sqrt().min(1.0).asin()
}

/// The ring `radius` metres round a place, as positions on the map, the
/// last the first again.
pub fn circle(centre: [f64; 2], radius: f64) -> Vec<P> {
    let per_degree = 6_371_000.0 * std::f64::consts::PI / 180.0;
    (0..=48)
        .map(|i| {
            let a = i as f64 / 48.0 * std::f64::consts::TAU;
            mercator(centre[0] + radius * a.sin() / (per_degree * centre[1].to_radians().cos().max(1e-6)), centre[1] + radius * a.cos() / per_degree)
        })
        .collect()
}

/// Whether a feature's time is a strict ISO-8601 date/time (`2026-11-17T09:30:00Z`).
pub fn time_ok(t: &str) -> bool {
    let num = |s: &str, n: usize, lo: u32, hi: u32| s.len() == n && s.bytes().all(|b| b.is_ascii_digit()) && s.parse::<u32>().is_ok_and(|v| (lo..=hi).contains(&v));
    let (day, rest) = t.split_at(t.find('T').unwrap_or(t.len()));
    let d: Vec<&str> = day.split('-').collect();
    if d.len() != 3 || !num(d[0], 4, 0, 9999) || !num(d[1], 2, 1, 12) || !num(d[2], 2, 1, 31) {
        return false;
    }
    let Some(clock) = rest.strip_prefix('T') else { return rest.is_empty() };
    let (clock, zone) = match clock.find(['Z', '+', '-']) {
        Some(i) => clock.split_at(i),
        None => (clock, ""),
    };
    let zone_ok = zone.is_empty() || zone == "Z" || zone[1..].split_once(':').is_some_and(|(h, m)| num(h, 2, 0, 23) && num(m, 2, 0, 59));
    let c: Vec<&str> = clock.split(':').collect();
    let secs = |s: &str| s.split_once('.').map_or(num(s, 2, 0, 59), |(a, f)| num(a, 2, 0, 59) && !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()));
    zone_ok && matches!(c.len(), 2 | 3) && num(c[0], 2, 0, 23) && num(c[1], 2, 0, 59) && c.get(2).is_none_or(|s| secs(s))
}

/// Whether `s` is a valid `#rgb` or `#rrggbb` hex color.
pub fn hex_color_ok(s: &str) -> bool {
    s.strip_prefix('#').is_some_and(|h| matches!(h.len(), 3 | 6) && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = crate::sheet::civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem / 60) % 60, rem % 60)
}

/// Flexible date/time parser normalizing ISO, space-separated (`2026-11-17 09:30`),
/// slash-separated (`2026/11/17`), and English month forms (`Nov 17, 2026`, `17 Nov 2026`)
/// into canonical ISO-8601 (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`).
pub fn parse_time(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if t.eq_ignore_ascii_case("now") {
        return Some(now_iso());
    }
    if time_ok(t) {
        return Some(t.to_owned());
    }
    // Space-separated or slash-separated YYYY-MM-DD [HH:MM[:SS]][Z|+-HH:MM]
    let (date_part, time_part) = match t.split_once(['T', 't', ' ']) {
        Some((d, rest)) if !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit() || b == b'-' || b == b'/') => (d, Some(rest.trim())),
        _ => (t, None),
    };
    let valid_ymd = |y: i64, m: i64, d: i64| -> bool {
        (0..=9999).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d) && crate::sheet::civil_from_days(crate::sheet::days_from_civil(y, m, d)) == (y, m, d)
    };
    let norm_clock = |clock_raw: &str| -> Option<String> {
        let c = clock_raw.trim();
        let (hm, zone) = match c.find(['Z', 'z', '+', '-']) {
            Some(i) => (&c[..i], &c[i..]),
            None => (c, ""),
        };
        let zone = if zone.eq_ignore_ascii_case("z") {
            "Z".to_owned()
        } else if zone.is_empty() {
            "Z".to_owned()
        } else {
            let (sign, rest) = zone.split_at(1);
            let (zh, zm) = rest.split_once(':')?;
            let (h, m): (u32, u32) = (zh.parse().ok()?, zm.parse().ok()?);
            if h > 23 || m > 59 {
                return None;
            }
            format!("{sign}{h:02}:{m:02}")
        };
        let parts: Vec<&str> = hm.trim().split(':').collect();
        if !(2..=3).contains(&parts.len()) {
            return None;
        }
        let h: u32 = parts[0].parse().ok()?;
        let m: u32 = parts[1].parse().ok()?;
        let s: u32 = parts.get(2).map_or(Some(0), |s| s.split('.').next()?.parse().ok())?;
        if h > 23 || m > 59 || s > 59 {
            return None;
        }
        Some(format!("T{h:02}:{m:02}:{s:02}{zone}"))
    };
    let sep = if date_part.contains('-') { '-' } else if date_part.contains('/') { '/' } else { '\0' };
    if sep != '\0' {
        let p: Vec<&str> = date_part.split(sep).collect();
        if p.len() == 3 && p.iter().all(|x| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit())) {
            let (y, m, d) = if p[0].len() == 4 {
                (p[0].parse::<i64>().ok()?, p[1].parse::<i64>().ok()?, p[2].parse::<i64>().ok()?)
            } else if p[2].len() == 4 && sep == '/' {
                // MM/DD/YYYY
                (p[2].parse::<i64>().ok()?, p[0].parse::<i64>().ok()?, p[1].parse::<i64>().ok()?)
            } else {
                return None;
            };
            if valid_ymd(y, m, d) {
                let tail = match time_part {
                    Some(c) if !c.is_empty() => norm_clock(c)?,
                    _ => String::new(),
                };
                return Some(format!("{y:04}-{m:02}-{d:02}{tail}"));
            }
        }
    }
    // Month-name dates: "Nov 17, 2026" or "17 Nov 2026" (optional trailing HH:MM[:SS])
    let month_of = |w: &str| -> Option<i64> {
        let low = w.to_ascii_lowercase();
        let low = low.trim_end_matches('.');
        match low {
            "jan" | "january" => Some(1),
            "feb" | "february" => Some(2),
            "mar" | "march" => Some(3),
            "apr" | "april" => Some(4),
            "may" => Some(5),
            "jun" | "june" => Some(6),
            "jul" | "july" => Some(7),
            "aug" | "august" => Some(8),
            "sep" | "sept" | "september" => Some(9),
            "oct" | "october" => Some(10),
            "nov" | "november" => Some(11),
            "dec" | "december" => Some(12),
            _ => None,
        }
    };
    let words: Vec<&str> = t.split_whitespace().map(|w| w.trim_matches(',')).filter(|w| !w.is_empty()).collect();
    if words.len() >= 3 {
        let parsed = if let Some(m) = month_of(words[0]) {
            words[1].parse::<i64>().ok().zip(words[2].parse::<i64>().ok()).map(|(d, y)| (y, m, d))
        } else if let Some(m) = month_of(words[1]) {
            words[0].parse::<i64>().ok().zip(words[2].parse::<i64>().ok()).map(|(d, y)| (y, m, d))
        } else {
            None
        };
        if let Some((y, m, d)) = parsed {
            if valid_ymd(y, m, d) {
                let tail = if words.len() > 3 { norm_clock(&words[3..].join(" "))? } else { String::new() };
                return Some(format!("{y:04}-{m:02}-{d:02}{tail}"));
            }
        }
    }
    None
}

/// Parses a feature's `time` string into Unix epoch seconds for age filtering.
pub fn parse_time_epoch(raw: &str) -> Option<i64> {
    let iso = parse_time(raw)?;
    let (day, rest) = iso.split_once('T').map_or((iso.as_str(), ""), |(d, r)| (d, r));
    let mut parts = day.split('-');
    let (y, m, d): (i64, i64, i64) = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    let mut secs = crate::sheet::days_from_civil(y, m, d).checked_mul(86_400)?;
    if !rest.is_empty() {
        let (clock, zone) = match rest.find(['Z', '+', '-']) {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        let c: Vec<&str> = clock.split(':').collect();
        let h: i64 = c.first()?.parse().ok()?;
        let mi: i64 = c.get(1)?.parse().ok()?;
        let s: i64 = c.get(2).and_then(|s| s.split('.').next()?.parse().ok()).unwrap_or(0);
        secs += h * 3600 + mi * 60 + s;
        if zone.is_empty() {
            secs -= crate::funcs::zone_secs() as i64;
        } else if let Some(z) = zone.strip_prefix('+').or_else(|| zone.strip_prefix('-')) {
            if let Some((zh, zm)) = z.split_once(':') {
                let off = zh.parse::<i64>().ok()? * 3600 + zm.parse::<i64>().ok()? * 60;
                if zone.starts_with('+') {
                    secs -= off;
                } else {
                    secs += off;
                }
            }
        }
    }
    Some(secs)
}

/// Whether a feature with `epoch` passes the active age filter `max_age_secs` relative to `now_secs`.
/// Undated features stay visible, matching the web client.
pub fn matches_age(epoch: Option<i64>, max_age_secs: Option<u64>, now_secs: i64) -> bool {
    let Some(limit) = max_age_secs else { return true };
    let Some(ep) = epoch else { return true };
    now_secs.saturating_sub(ep) <= limit as i64
}

/// The geometry of a shape drawn with these corners, each a longitude
/// and latitude: a line of two or more, an area of three or more with
/// its ring closed. `None` for too few, and for the point tool, whose
/// point is made where it is pressed.
pub fn drawn(tool: Draw, verts: &[[f64; 2]]) -> Option<Value> {
    match tool {
        Draw::Line if verts.len() >= 2 => Some(serde_json::json!({"type": "LineString", "coordinates": verts})),
        Draw::Area if verts.len() >= 3 => {
            let ring: Vec<_> = verts.iter().chain(verts.first()).collect();
            Some(serde_json::json!({"type": "Polygon", "coordinates": [ring]}))
        }
        _ => None,
    }
}

/// The most positions a map page may hold, and the most features. The web client's.
pub const MAX_POSITIONS: usize = 500_000;
const MAX_FEATURES: usize = 20_000;

/// How deep the brackets of a JSON text go, those in strings not counted.
pub fn depth(t: &str) -> usize {
    let (mut d, mut max, mut quoted, mut escaped) = (0usize, 0, false, false);
    for b in t.bytes() {
        match b {
            _ if escaped => escaped = false,
            b'\\' if quoted => escaped = true,
            b'"' => quoted = !quoted,
            b'[' | b'{' if !quoted => {
                d += 1;
                max = max.max(d);
            }
            b']' | b'}' if !quoted => d = d.saturating_sub(1),
            _ => {}
        }
    }
    max
}

/// Why a parsed text is not a map page's, in the web client's words, so
/// nothing is written that the web client or the ship would refuse.
pub fn check(j: &Value, max_pos: usize) -> Result<(), String> {
    fn position(p: &Value, n: &mut usize, max: usize) -> Result<(), String> {
        let a = p.as_array().filter(|a| (2..=4).contains(&a.len())).ok_or("a position is not [lon, lat]")?;
        if !a.iter().all(|v| v.as_f64().is_some_and(f64::is_finite)) {
            return Err("a coordinate is not a number".into());
        }
        *n += 1;
        if *n > max { Err(format!("more than {max} positions")) } else { Ok(()) }
    }
    fn positions(a: &Value, n: &mut usize, max: usize, min: usize) -> Result<(), String> {
        let a = a.as_array().ok_or("coordinates are not a list")?;
        if a.len() > max {
            return Err(format!("more than {max} positions"));
        }
        if a.len() < min {
            return Err("a line or ring has too few positions".into());
        }
        a.iter().try_for_each(|p| position(p, n, max))
    }
    fn lists(a: &Value, n: &mut usize, max: usize, min: usize) -> Result<(), String> {
        a.as_array().ok_or("coordinates are not a list")?.iter().try_for_each(|r| positions(r, n, max, min))
    }
    fn geometry(g: &Value, n: &mut usize, max: usize, inner: bool) -> Result<(), String> {
        if g.is_null() {
            return Ok(());
        }
        if !g.is_object() {
            return Err("a geometry is not an object".into());
        }
        let c = &g["coordinates"];
        match g["type"].as_str() {
            Some("Point") => position(c, n, max),
            Some("MultiPoint") => positions(c, n, max, 0),
            Some("LineString") => positions(c, n, max, 2),
            Some("MultiLineString") => lists(c, n, max, 2),
            Some("Polygon") => lists(c, n, max, 4),
            Some("MultiPolygon") => c.as_array().ok_or("coordinates are not a list")?.iter().try_for_each(|p| lists(p, n, max, 4)),
            Some("GeometryCollection") if inner => Err("a geometry collection inside another".into()),
            Some("GeometryCollection") => g["geometries"].as_array().ok_or("a geometry collection has no geometries")?.iter().try_for_each(|h| if h.is_null() { Err("a null geometry in a collection".to_owned()) } else { geometry(h, n, max, true) }),
            _ => Err("an unknown geometry type".into()),
        }
    }
    if !j.is_object() || j["type"] != "FeatureCollection" {
        return Err("the page is not a GeoJSON FeatureCollection".into());
    }
    let feats = j["features"].as_array().ok_or("the collection has no features list")?;
    if feats.len() > MAX_FEATURES {
        return Err(format!("more than {MAX_FEATURES} features"));
    }
    let mut n = 0;
    for f in feats {
        if !f.is_object() || f["type"] != "Feature" {
            return Err("a feature is not a Feature".into());
        }
        geometry(&f["geometry"], &mut n, max_pos, false)?;
        if f.get("properties").is_some_and(|p| !p.is_null() && !p.is_object()) {
            return Err("a feature's properties are not an object".into());
        }
    }
    if j.get("lattice").is_some_and(|l| !l.is_object()) {
        return Err("the lattice member is not an object".into());
    }
    Ok(())
}

/// A map page with these features after its own. `None` when that
/// would be more features or positions than a map page may hold.
pub fn append(body: &str, feats: Vec<Value>) -> Option<String> {
    change(body, |d| {
        d.get_mut("features")?.as_array_mut()?.extend(feats);
        check(&Value::Object(d.clone()), MAX_POSITIONS).ok()
    })
}

/// A map page with a new feature of this geometry and these
/// properties, after the others.
pub fn add(body: &str, geometry: Value, properties: Value) -> Option<String> {
    change(body, |d| {
        d.get_mut("features")?.as_array_mut()?.push(serde_json::json!({"type": "Feature", "geometry": geometry, "properties": properties}));
        Some(())
    })
}

/// A map page with its feature `at` moved by so many degrees, every
/// position of it. Anything a position has past its first two is kept.
pub fn shift(body: &str, at: usize, dlon: f64, dlat: f64) -> Option<String> {
    // a move that is not a number would write positions that are not numbers
    if !(dlon.is_finite() && dlat.is_finite()) {
        return None;
    }
    fn walk(c: &mut Value, dlon: f64, dlat: f64) {
        let Value::Array(a) = c else { return };
        if let [Value::Number(x), Value::Number(y), ..] = a.as_slice() {
            let (lon, lat) = ((x.as_f64().unwrap_or(0.0) + dlon + 180.0).rem_euclid(360.0) - 180.0, (y.as_f64().unwrap_or(0.0) + dlat).clamp(-89.999_999_9, 89.999_999_9));
            (a[0], a[1]) = (lon.into(), lat.into());
        } else {
            a.iter_mut().for_each(|x| walk(x, dlon, dlat));
        }
    }
    fn geom(g: &mut Value, dlon: f64, dlat: f64) {
        if let Some(Value::Array(a)) = g.get_mut("geometries") {
            a.iter_mut().for_each(|h| geom(h, dlon, dlat));
        }
        if let Some(c) = g.get_mut("coordinates") {
            walk(c, dlon, dlat);
        }
    }
    change(body, |d| {
        let g = d.get_mut("features")?.as_array_mut()?.get_mut(at)?.get_mut("geometry").filter(|g| g.is_object())?;
        geom(g, dlon, dlat);
        Some(())
    })
}

/// A map page with one corner of its feature `at` put somewhere else.
/// `path` is the corner's place in the coordinates. The first corner
/// of an area's ring takes the closing position with it.
pub fn set_corner(body: &str, at: usize, path: &[usize], lon: f64, lat: f64) -> Option<String> {
    if !(lon.is_finite() && lat.is_finite()) {
        return None;
    }
    change(body, |d| {
        let g = d.get_mut("features")?.as_array_mut()?.get_mut(at)?.get_mut("geometry")?;
        let closed = matches!(g.get("type")?.as_str()?, "Polygon" | "MultiPolygon");
        let (last, up) = path.split_last()?;
        let mut ring = g.get_mut("coordinates")?;
        for i in up {
            ring = ring.get_mut(*i)?;
        }
        let ring = ring.as_array_mut()?;
        let to = serde_json::json!([lon, lat.clamp(-89.999_999_9, 89.999_999_9)]);
        *ring.get_mut(*last)? = to.clone();
        if closed && *last == 0 {
            *ring.last_mut()? = to;
        }
        Some(())
    })
}

/// How near a press must be to a shape to pick it, in points. The web client's.
const TOL: f32 = 10.0;

/// The feature under a press at `x`, `y` in the view: the nearest within
/// reach, the later drawn of two as near. Inside an area counts as on it.
pub fn hit<'a>(feats: impl IntoIterator<Item = (usize, &'a Feature)>, cam: &Camera, w: f32, h: f32, x: f32, y: f32) -> Option<usize> {
    let seg = |a: [f32; 2], b: [f32; 2]| {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = dx * dx + dy * dy;
        let u = if len > 0.0 { (((x - a[0]) * dx + (y - a[1]) * dy) / len).clamp(0.0, 1.0) } else { 0.0 };
        (a[0] + u * dx - x).hypot(a[1] + u * dy - y)
    };
    let path = |l: &[P]| {
        let pts: Vec<[f32; 2]> = l.iter().map(|p| cam.project(*p, w, h)).collect();
        let near = pts.windows(2).map(|s| seg(s[0], s[1])).fold(f32::MAX, f32::min);
        (pts, near)
    };
    let mut best = None;
    for (i, f) in feats {
        for g in &f.geoms {
            let d = match g {
                Geom::Point(p) => {
                    let pt_d = seg(cam.project(*p, w, h), cam.project(*p, w, h));
                    if f.radius > 0.0 {
                        let ring_d = path(&circle(lonlat(*p), f.radius)).1;
                        pt_d.min(ring_d)
                    } else {
                        pt_d
                    }
                }
                Geom::Line(l) => path(l).1,
                Geom::Area(l) => {
                    let (r, near) = path(l);
                    let mut inside = false;
                    for (a, b) in r.iter().zip(r.iter().cycle().skip(r.len().saturating_sub(1))) {
                        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
                            inside = !inside;
                        }
                    }
                    if inside { 0.0 } else { near }
                }
            };
            if d <= TOL && best.is_none_or(|(_, was)| d <= was) {
                best = Some((i, d));
            }
        }
    }
    best.map(|(i, _)| i)
}

/// The other map pages a map asks to have drawn under it
/// (`lattice.layers`), checked as the web client checks them.
pub fn layers(body: &str) -> Vec<String> {
    let v: Option<Value> = serde_json::from_str(body).ok();
    let named = v.as_ref().and_then(|v| v.get("lattice")?.get("layers")?.as_array());
    named.map_or(Vec::new(), |a| a.iter().filter_map(Value::as_str).filter(|s| !s.is_empty() && s.encode_utf16().count() < 400).take(20).map(str::to_owned).collect())
}

/// The base map a page asks for (`lattice.base`), or streets.
pub fn base_style(body: &str) -> &'static str {
    let named = serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("lattice")?.get("base")?.as_str().map(str::to_owned));
    STYLES.into_iter().find(|s| Some(*s) == named.as_deref()).unwrap_or("streets")
}

pub fn thin(line: &[P], max: usize) -> Vec<P> {
    if line.len() <= max.max(2) {
        return line.to_vec();
    }
    let step = line.len().div_ceil(max.max(2) - 1);
    let mut out: Vec<P> = line.iter().step_by(step).copied().collect();
    if out.last() != line.last() {
        out.extend(line.last());
    }
    out
}

/// Renders a GeoJSON map page to a self-contained HTML fragment with an inline
/// SVG vector map, legend, and feature summary table for PDF export.
pub fn render_html(body: &str, title: &str) -> Result<String, String> {
    let feats = parse(body).ok_or_else(|| "this page is not a map".to_owned())?;
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let (w, h) = (760.0f32, 480.0f32);
    let cam = Camera::fit(&feats, w, h);
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" style=\"width:100%;height:auto;border:1px solid #ccc;border-radius:4pt;background:#f8f9fa\">\n"
    );
    // Graticule
    let step = cam.grid_step(w);
    let (a, z) = (cam.unproject(0.0, 0.0, w, h), cam.unproject(w, h, w, h));
    let lon0 = ((a[0] - 0.5) * 360.0 / step).floor() as i64;
    let lon1 = ((z[0] - 0.5) * 360.0 / step).ceil() as i64;
    for i in lon0..=lon1.min(lon0.saturating_add(40)) {
        let x = cam.project(mercator(i as f64 * step, 0.0), w, h)[0];
        if (0.0..=w).contains(&x) {
            svg.push_str(&format!("<line x1=\"{x:.1}\" y1=\"0\" x2=\"{x:.1}\" y2=\"{h}\" stroke=\"#e2e6ea\" stroke-width=\"1\"/>\n"));
        }
    }
    let mut lat = (-85.0 / step).ceil() * step;
    let mut lines = 0;
    while lat <= 85.0 && lines < 40 {
        let y = cam.project(mercator(0.0, lat), w, h)[1];
        if (0.0..=h).contains(&y) {
            svg.push_str(&format!("<line x1=\"0\" y1=\"{y:.1}\" x2=\"{w}\" y2=\"{y:.1}\" stroke=\"#e2e6ea\" stroke-width=\"1\"/>\n"));
            lines += 1;
        }
        lat += step;
    }
    for f in &feats {
        let col = if hex_color_ok(&f.color) { f.color.as_str() } else { "#2e86c1" };
        for g in &f.geoms {
            match g {
                Geom::Area(l) => {
                    let pts: String = thin(l, 500)
                        .into_iter()
                        .map(|p| {
                            let [x, y] = cam.project(p, w, h);
                            format!("{x:.1},{y:.1}")
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    svg.push_str(&format!("<polygon points=\"{pts}\" fill=\"{col}\" fill-opacity=\"0.18\" stroke=\"{col}\" stroke-width=\"1.5\"/>\n"));
                }
                Geom::Line(l) => {
                    let pts: String = thin(l, 500)
                        .into_iter()
                        .map(|p| {
                            let [x, y] = cam.project(p, w, h);
                            format!("{x:.1},{y:.1}")
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    svg.push_str(&format!("<polyline points=\"{pts}\" fill=\"none\" stroke=\"{col}\" stroke-width=\"2.2\"/>\n"));
                }
                Geom::Point(p) => {
                    if f.radius > 0.0 {
                        let pts: String = circle(lonlat(*p), f.radius)
                            .into_iter()
                            .map(|q| {
                                let [x, y] = cam.project(q, w, h);
                                format!("{x:.1},{y:.1}")
                            })
                            .collect::<Vec<_>>()
                            .join(" ");
                        svg.push_str(&format!("<polygon points=\"{pts}\" fill=\"{col}\" fill-opacity=\"0.12\" stroke=\"{col}\" stroke-width=\"1.2\"/>\n"));
                    }
                    let [x, y] = cam.project(*p, w, h);
                    svg.push_str(&format!("<circle cx=\"{x:.1}\" cy=\"{y:.1}\" r=\"5\" fill=\"{col}\" stroke=\"#fff\" stroke-width=\"1.5\"/>\n"));
                    if !f.name.is_empty() {
                        svg.push_str(&format!(
                            "<text x=\"{:.1}\" y=\"{:.1}\" font-size=\"10\" font-family=\"system-ui,sans-serif\" fill=\"#222\">{}</text>\n",
                            x + 8.0,
                            y + 3.5,
                            esc(&f.name)
                        ));
                    }
                }
            }
        }
    }
    svg.push_str("</svg>\n");
    let mut out = format!("<h1>{}</h1>\n{svg}", esc(title));
    let ks = kinds(&feats);
    if !ks.is_empty() {
        out.push_str("<p style=\"font-size:9.5pt;color:#444;margin-top:8pt\">");
        for (idx, (k, n)) in ks.iter().enumerate() {
            if idx > 0 {
                out.push_str(" &middot; ");
            }
            let col = if k.is_empty() { "#2e86c1" } else { kind_color(k) };
            let label = if k.is_empty() { "Unclassified" } else { k.as_str() };
            out.push_str(&format!("<span style=\"display:inline-block;width:8pt;height:8pt;border-radius:4pt;background:{col};margin-right:3pt\"></span>{} ({n})", esc(label)));
        }
        out.push_str("</p>\n");
    }
    if !feats.is_empty() {
        out.push_str("<table style=\"width:100%;font-size:9pt;margin-top:10pt\"><thead><tr><th>Name</th><th>Kind</th><th>Time</th><th>Note</th></tr></thead><tbody>\n");
        for f in feats.iter().take(250) {
            let time = f.props.iter().find(|(k, _)| k == "time").map_or("", |(_, v)| v.as_str());
            out.push_str(&format!(
                "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>\n",
                esc(&f.name),
                esc(&f.kind),
                esc(time),
                esc(&f.note)
            ));
        }
        out.push_str("</tbody></table>\n");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"{"type":"FeatureCollection","lattice":{"title":"T"},"features":[
      {"type":"Feature","geometry":{"type":"Point","coordinates":[-73.98,40.75]},"properties":{"name":"Home","note":"where","kind":"place","n":3}},
      {"type":"Feature","geometry":{"type":"LineString","coordinates":[[0,0],[10,10]]},"properties":{}},
      {"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":[[[[0,0],[1,0],[1,1],[0,0]]],[[[5,5],[6,5]]]]},"properties":null},
      {"type":"Feature","geometry":{"type":"GeometryCollection","geometries":[{"type":"MultiPoint","coordinates":[[1,2],[3,4]]}]},"properties":{"name":"two"}},
      {"type":"Feature","geometry":null,"properties":{"name":"nowhere"}},
      {"type":"Feature","geometry":{"type":"Point","coordinates":["x"]},"properties":{}}
    ]}"#;

    #[test]
    fn a_page_gives_its_drawable_features() {
        let f = parse(PAGE).unwrap();
        assert_eq!(f.len(), 4, "a feature with no shape is left out");
        assert_eq!((f[0].name.as_str(), f[0].note.as_str()), ("Home", "where"));
        assert!(f[0].props.contains(&("n".to_owned(), "3".to_owned())));
        assert!(matches!(f[1].geoms[..], [Geom::Line(ref l)] if l.len() == 2));
        assert!(matches!(f[2].geoms[..], [Geom::Area(ref a)] if a.len() == 4), "a ring too short to fill is dropped");
        assert_eq!(f[3].geoms.len(), 2);
        assert_eq!(parse("not json"), None);
        assert_eq!(parse(r#"{"type":"Feature"}"#), None);
    }

    #[test]
    fn mercator_puts_the_world_in_the_unit_square() {
        let near = |a: P, b: P| (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9;
        assert!(near(mercator(0.0, 0.0), [0.5, 0.5]));
        assert!(near(mercator(-180.0, 0.0), [0.0, 0.5]));
        assert!(mercator(0.0, 60.0)[1] < 0.5, "north is up");
        assert!(mercator(0.0, 90.0)[1] >= 0.0 && mercator(0.0, -90.0)[1] <= 1.0, "the poles are held in");
    }

    #[test]
    fn the_camera_fits_zooms_about_a_point_and_drags() {
        let f = parse(PAGE).unwrap();
        let (w, h) = (800.0, 600.0);
        let cam = Camera::fit(&f, w, h);
        for g in f.iter().flat_map(|f| &f.geoms) {
            let pts: &[P] = match g {
                Geom::Point(p) => std::slice::from_ref(p),
                Geom::Line(l) | Geom::Area(l) => l,
            };
            for p in pts {
                let [x, y] = cam.project(*p, w, h);
                assert!((39.0..=761.0).contains(&x) && (39.0..=561.0).contains(&y), "inside the margin: {x},{y}");
            }
        }
        // the world position under the pointer stays under it through a zoom
        let mut z = cam;
        let before = z.unproject(200.0, 150.0, w, h);
        z.zoom_at(2.0, 200.0, 150.0, w, h);
        let after = z.unproject(200.0, 150.0, w, h);
        assert!((before[0] - after[0]).abs() < 1e-9 && (before[1] - after[1]).abs() < 1e-9);
        assert_eq!(z.scale, cam.scale * 2.0);
        // a drag right moves the ground right: what was at the centre is 50 points over
        let d = Camera::dragged(cam, 50.0, 0.0);
        assert!((d.project(cam.at, w, h)[0] - (w / 2.0 + 50.0)).abs() < 1e-3);
        // nothing to show, or one point: a sane view, not a division by zero
        assert_eq!(Camera::fit(&[], w, h), Camera { at: [0.5, 0.5], scale: 800.0 });
        let one = Camera::fit(&f[..1], w, h);
        assert!(one.scale.is_finite() && one.scale <= SCALE.1);
        z.zoom_at(1e30, 0.0, 0.0, w, h);
        assert_eq!(z.scale, SCALE.1, "the zoom stops at a street");
    }

    #[test]
    fn the_grid_keeps_a_few_lines_across_and_a_long_line_is_thinned() {
        let world = Camera { at: [0.5, 0.5], scale: 800.0 };
        assert_eq!(world.grid_step(800.0), 90.0);
        let town = Camera { at: [0.5, 0.5], scale: 800.0 * 4096.0 };
        assert!(town.grid_step(800.0) <= 0.05);
        let line: Vec<P> = (0..10_000).map(|i| [i as f64, 0.0]).collect();
        let t = thin(&line, 500);
        assert!(t.len() <= 501 && t[0] == line[0] && t.last() == line.last());
        assert_eq!(thin(&line[..3], 500).len(), 3);
    }

    #[test]
    fn the_tiles_that_cover_a_view_are_found_nearest_the_middle_first() {
        // the whole world in a 512 point view: the one tile of zoom 0
        let world = Camera { at: [0.5, 0.5], scale: 512.0 };
        assert_eq!(tiles(&world, 512.0, 512.0, 17), [Tile { z: 0, x: 0, y: 0 }]);
        assert_eq!(tile_rect(&world, &Tile { z: 0, x: 0, y: 0 }, 512.0, 512.0), [0.0, 0.0, 512.0]);
        // twice as close, on the middle: the four tiles of zoom 1, each 512 across
        let closer = Camera { at: [0.5, 0.5], scale: 1024.0 };
        let four = tiles(&closer, 1024.0, 1024.0, 17);
        assert_eq!(four.len(), 4);
        assert!(four.iter().all(|t| t.z == 1 && t.x < 2 && t.y < 2));
        assert_eq!(tile_rect(&closer, &Tile { z: 1, x: 1, y: 1 }, 1024.0, 1024.0), [512.0, 512.0, 512.0]);
        // a small view deep in: few tiles, the one under the middle first, all inside the grid
        let deep = Camera { at: mercator(-73.98, 40.75), scale: 512.0 * 4096.0 };
        let near = tiles(&deep, 800.0, 500.0, 17);
        assert!((2..=9).contains(&near.len()), "{}", near.len());
        assert_eq!(near[0], Tile { z: 12, x: (deep.at[0] * 4096.0) as u32, y: (deep.at[1] * 4096.0) as u32 });
        assert!(near.iter().all(|t| t.z == 12 && t.x < 4096 && t.y < 4096));
        // no deeper than the ship gives, and tiles then draw larger
        let past = Camera { at: [0.5, 0.5], scale: 512.0 * f64::from(1u32 << 20) };
        let top = tiles(&past, 800.0, 500.0, 17);
        assert!(top.iter().all(|t| t.z == 17));
        assert_eq!(tile_rect(&past, &top[0], 800.0, 500.0)[2], 4096.0);
        // a view of nothing but what is past the world's edge has no tiles, and a huge one is capped
        let off = Camera { at: [3.0, 0.5], scale: 512.0 };
        assert!(tiles(&off, 400.0, 400.0, 17).is_empty());
        let wide = Camera { at: [0.5, 0.5], scale: 512.0 * 64.0 };
        assert_eq!(tiles(&wide, 8000.0, 8000.0, 17).len(), MAX_TILES);
    }

    #[test]
    fn a_map_is_written_in_lattices_layout_with_nothing_lost() {
        let body = r#"{ "features": [ {"properties": {"name": "A", "n": 1.0}, "geometry": {"type": "Point", "coordinates": [-73.98570001234, 40.0]}, "type": "Feature", "zz": [1, 2.5], "id": 7},
            {"type": "Feature", "geometry": null} ], "bbox": [0, 1.50, 2, 3], "type": "FeatureCollection", "lattice": {"title": "T", "zoom": 9} }"#;
        let out = with_base(body, "satellite").unwrap();
        // the web client's own writer gives exactly this for the same document
        assert_eq!(
            out,
            "{\"type\":\"FeatureCollection\",\"lattice\":{\"title\":\"T\",\"zoom\":9,\"base\":\"satellite\"},\"bbox\":[0,1.5,2,3],\"features\":[\n{\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":[-73.9857,40]},\"properties\":{\"name\":\"A\",\"n\":1},\"id\":7,\"zz\":[1,2.5]},\n{\"type\":\"Feature\",\"geometry\":null,\"properties\":{}}\n]}\n"
        );
        assert_eq!(base_style(&out), "satellite");
        // written again it is the same, and the shapes read from it are the ones read before
        assert_eq!(with_base(&out, "satellite").unwrap(), out);
        assert_eq!(parse(&out).map(|f| f.len()), parse(body).map(|f| f.len()));
        // a map with no view member gets one, and an empty one stays a map
        let bare = with_base(r#"{"type":"FeatureCollection","features":[]}"#, "dark").unwrap();
        assert_eq!(bare, "{\"type\":\"FeatureCollection\",\"lattice\":{\"base\":\"dark\"},\"features\":[\n]}\n");
        // what is not a map, or not a base, is left alone
        assert_eq!(with_base("{\"type\":\"Feature\"}", "dark"), None);
        assert_eq!(with_base("not json", "dark"), None);
        assert_eq!(with_base(body, "sepia"), None);
    }

    #[test]
    fn a_feature_gets_its_kind_colour_and_glyph_as_on_the_web() {
        // every value here is what ui-src/map/core.js gives for the same input
        for (k, c) in [("place", "#e84393"), ("situation", "#28a745"), ("person", "#8e44ad"), ("report", "#d68910"), ("café", "#2e86c1"), ("a much longer kind name here", "#d68910"), ("😀x", "#16a085")] {
            assert_eq!(kind_color(k), c, "{k}");
        }
        let of = |p: &str| look(&serde_json::from_str(p).unwrap());
        assert_eq!(of(r#"{"kind":" place "}"#), ("place".into(), "#e84393".into(), "⊕"));
        assert_eq!(of(r##"{"kind":"x","icon":"star","color":"#ABC"}"##), ("x".into(), "#ABC".into(), "★"));
        assert_eq!(of(r#"{"icon":"nope","color":"red"}"#), (String::new(), "#2e86c1".into(), ""));
        assert_eq!(of(r#"{"kind":7}"#), (String::new(), "#2e86c1".into(), ""));
        assert_eq!(of(r#"{"kind":"home","icon":"dot"}"#), ("home".into(), "#e84393".into(), ""), "a dot named outright stays a dot");
        assert_eq!(of("null"), (String::new(), "#2e86c1".into(), ""));
        let feats = parse(r#"{"type":"FeatureCollection","features":[
            {"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"kind":"place"}},
            {"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{}},
            {"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"kind":"place"}},
            {"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"kind":"alpha"}}]}"#).unwrap();
        assert_eq!(kinds(&feats), [(String::new(), 1), ("alpha".into(), 1), ("place".into(), 2)]);
    }

    #[test]
    fn a_map_names_the_maps_drawn_under_it() {
        assert_eq!(layers(r#"{"type":"FeatureCollection","lattice":{"layers":["a/b", 7, "", "c"]},"features":[]}"#), ["a/b", "c"]);
        assert!(layers(r#"{"type":"FeatureCollection","lattice":{"layers":"a"},"features":[]}"#).is_empty());
        assert!(layers(r#"{"type":"FeatureCollection","features":[]}"#).is_empty());
        assert!(layers("nope").is_empty());
        let many: Vec<String> = (0..30).map(|i| format!("\"m{i}\"")).collect();
        assert_eq!(layers(&format!(r#"{{"lattice":{{"layers":[{}]}}}}"#, many.join(","))).len(), 20);
        assert!(layers(&format!(r#"{{"lattice":{{"layers":["{}"]}}}}"#, "x".repeat(400))).is_empty());
    }

    #[test]
    fn a_features_properties_are_set_and_a_feature_removed() {
        let body = r#"{"type":"FeatureCollection","lattice":{"title":"T"},"features":[
{"type":"Feature","geometry":null,"properties":{"name":"ghost"}},
{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"name":"A","kind":"place","zz":[1]},"id":"x"},
{"type":"Feature","geometry":{"type":"Point","coordinates":[3,4]}}
]}
"#;
        // the feature drawn first is the page's second: a shapeless one comes before it
        let feats = parse(body).unwrap();
        assert_eq!(feats.iter().map(|f| f.at).collect::<Vec<_>>(), [1, 2]);
        // a property set keeps its place, a new one goes last, one taken away leaves the rest in order
        let out = set_props(body, 1, &[("name", Some("B".into())), ("kind", None), ("note", Some("two\nlines".into()))]).unwrap();
        assert!(out.contains(r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"name":"B","zz":[1],"note":"two\nlines"},"id":"x"}"#), "{out}");
        // a feature with no properties gets them, and the others are as they were
        let out = set_props(body, 2, &[("icon", Some("star".into()))]).unwrap();
        assert!(out.ends_with("{\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":[3,4]},\"properties\":{\"icon\":\"star\"}}\n]}\n"), "{out}");
        assert!(out.contains(r#""properties":{"name":"A","kind":"place","zz":[1]},"id":"x"}"#));
        // setting nothing writes the page in lattice's layout and loses nothing: what the web client gives
        assert_eq!(set_props(body, 1, &[]).unwrap(), body.replace(r#"[3,4]}}"#, r#"[3,4]},"properties":{}}"#));
        assert_eq!(set_props(body, 9, &[("name", Some("x".into()))]), None);
        // removed by its place in the page
        let out = remove(body, 1).unwrap();
        assert_eq!(parse(&out).unwrap().iter().map(|f| f.at).collect::<Vec<_>>(), [1]);
        assert!(out.contains("ghost") && !out.contains("\"A\""));
        assert_eq!(remove(body, 3), None);
        assert_eq!(remove("{}", 0), None);
    }

    #[test]
    fn a_point_is_added_where_it_was_put_and_a_feature_moved() {
        // a place on the map and back again is the same place
        for (lon, lat) in [(-73.9857, 40.7484), (151.2, -33.87), (0.0, 0.0), (-179.5, 84.0)] {
            let [a, b] = lonlat(mercator(lon, lat));
            assert!((a - lon).abs() < 1e-9 && (b - lat).abs() < 1e-9, "{lon} {lat} gave {a} {b}");
        }
        let body = "{\"type\":\"FeatureCollection\",\"lattice\":{},\"features\":[\n{\"type\":\"Feature\",\"geometry\":{\"type\":\"LineString\",\"coordinates\":[[1,2,30],[3,4]]},\"properties\":{\"name\":\"L\"}}\n]}\n";
        let [lon, lat] = lonlat(mercator(-73.98570001, 40.5));
        let out = add(body, serde_json::json!({"type": "Point", "coordinates": [lon, lat]}), serde_json::json!({})).unwrap();
        // the web client writes a new point this way: after the others, with empty properties, rounded
        assert_eq!(out, body.replace("}}\n]}", "}},\n{\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":[-73.9857,40.5]},\"properties\":{}}\n]}"));
        // moved: every position, the height of one kept, the name kept
        let out = shift(&out, 0, 0.5, -0.25).unwrap();
        assert!(out.contains(r#"{"type":"LineString","coordinates":[[1.5,1.75,30],[3.5,3.75]]},"properties":{"name":"L"}}"#), "{out}");
        assert!(out.contains("[-73.9857,40.5]"), "the other feature stays");
        // over the date line it comes round, and it stops short of the pole
        let out = shift(&out, 1, 260.0, 80.0).unwrap();
        assert!(out.contains("[-173.9857,89.9999999]"), "{out}");
        assert_eq!(shift(body, 5, 1.0, 1.0), None);
        assert_eq!(add("[]", Value::Null, Value::Null), None);
    }

    #[test]
    fn a_line_and_an_area_are_made_of_the_corners_drawn() {
        let v = [[1.0, 2.0], [3.0, 4.5], [5.0, 6.0]];
        assert_eq!(drawn(Draw::Line, &v[..1]), None);
        assert_eq!(drawn(Draw::Area, &v[..2]), None);
        assert_eq!(drawn(Draw::Point, &v), None);
        let blank = "{\"type\":\"FeatureCollection\",\"lattice\":{},\"features\":[\n]}\n";
        // what the web client writes for the same corners
        let line = add(blank, drawn(Draw::Line, &v[..2]).unwrap(), serde_json::json!({})).unwrap();
        assert_eq!(line, "{\"type\":\"FeatureCollection\",\"lattice\":{},\"features\":[\n{\"type\":\"Feature\",\"geometry\":{\"type\":\"LineString\",\"coordinates\":[[1,2],[3,4.5]]},\"properties\":{}}\n]}\n");
        let area = add(blank, drawn(Draw::Area, &v).unwrap(), serde_json::json!({})).unwrap();
        assert!(area.contains(r#"{"type":"Polygon","coordinates":[[[1,2],[3,4.5],[5,6],[1,2]]]}"#), "{area}");
        // both are shapes lattice draws
        assert!(matches!(parse(&line).unwrap()[0].geoms[0], Geom::Line(_)));
        assert!(matches!(parse(&area).unwrap()[0].geoms[0], Geom::Area(_)));
    }

    #[test]
    fn a_ring_is_so_many_metres_round_its_point() {
        // Leaflet's map.distance gives these for the same places
        assert!((distance([0.0, 0.0], [1.0, 0.0]) - 111_194.93).abs() < 0.5);
        assert!((distance([-73.9857, 40.7484], [-73.9442, 40.6782]) - 8_552.0).abs() < 60.0);
        assert_eq!(distance([10.0, 20.0], [10.0, 20.0]), 0.0);
        // every place on the ring is the radius away, near enough, and it closes
        let c = [-73.9857, 40.7484];
        let r = circle(c, 2_000.0);
        assert_eq!((r.len(), r[0]), (49, r[48]));
        for p in &r {
            assert!((distance(c, lonlat(*p)) - 2_000.0).abs() < 5.0, "{}", distance(c, lonlat(*p)));
        }
        // a radius is read when it is a number lattice shows, and written as one
        let body = add("{\"type\":\"FeatureCollection\",\"features\":[]}", serde_json::json!({"type": "Point", "coordinates": c}), serde_json::json!({"radius": 250})).unwrap();
        assert!(body.contains(r#""properties":{"radius":250}}"#), "{body}");
        assert_eq!(parse(&body).unwrap()[0].radius, 250.0);
        for bad in ["-1", "0", "\"250\"", "3e7"] {
            assert_eq!(parse(&body.replace("250", bad)).unwrap()[0].radius, 0.0, "{bad}");
        }
        assert_eq!(drawn(Draw::Ring, &[c, c, c]), None, "a ring is a point, made where its edge is pressed");
    }

    #[test]
    fn a_time_is_a_date_or_is_refused() {
        for ok in ["2026-11-17", "2026-11-17T09:30", "2026-11-17T09:30:00Z", "2026-11-17T09:30:00.250Z", "2026-11-17T09:30:00+02:00", "2026-11-17T09:30-05:00"] {
            assert!(time_ok(ok), "{ok}");
        }
        for bad in ["", "yesterday", "2026-13-01", "2026-11-32", "17-11-2026", "2026-11-17T25:00", "2026-11-17T09", "2026-11-17T09:30:00X", "2026-11-17T09:30:00+2", "2026-11-17 09:30"] {
            assert!(!time_ok(bad), "{bad}");
        }
    }

    #[test]
    fn a_shapes_corners_are_found_and_one_is_moved() {
        let body = r#"{"type":"FeatureCollection","lattice":{},"features":[
{"type":"Feature","geometry":{"type":"LineString","coordinates":[[1,2],[3,4],[5,6]]},"properties":{"name":"L"}},
{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[0,0]],[[0.2,0.2],[0.2,0.4],[0.4,0.4],[0.2,0.2]]]},"properties":{}},
{"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":[[[[10,10],[10,11],[11,11],[10,10]]]]},"properties":{}},
{"type":"Feature","geometry":{"type":"Point","coordinates":[7,7]},"properties":{}}
]}
"#;
        let f = parse(body).unwrap();
        let paths = |i: usize| f[i].corners.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>();
        assert_eq!(paths(0), [vec![0], vec![1], vec![2]]);
        // an area's closing position is not a corner, and a hole has corners too
        assert_eq!(paths(1), [vec![0, 0], vec![0, 1], vec![0, 2], vec![1, 0], vec![1, 1], vec![1, 2]]);
        assert_eq!(paths(2), [vec![0, 0, 0], vec![0, 0, 1], vec![0, 0, 2]]);
        assert!(paths(3).is_empty());
        assert_eq!(f[0].corners[1].1, mercator(3.0, 4.0));
        // a line's corner moves alone
        let out = set_corner(body, 0, &[1], 3.5, 4.25).unwrap();
        assert!(out.contains(r#""coordinates":[[1,2],[3.5,4.25],[5,6]]},"properties":{"name":"L"}"#), "{out}");
        // an area's first corner takes the closing position with it, another does not
        let out = set_corner(body, 1, &[0, 0], -0.5, -0.5).unwrap();
        assert!(out.contains("[[[-0.5,-0.5],[0,1],[1,1],[-0.5,-0.5]],[[0.2,0.2]"), "{out}");
        let out = set_corner(body, 1, &[1, 2], 0.5, 0.5).unwrap();
        assert!(out.contains("[[0.2,0.2],[0.2,0.4],[0.5,0.5],[0.2,0.2]]]"), "{out}");
        let out = set_corner(body, 2, &[0, 0, 0], 9.0, 9.0).unwrap();
        assert!(out.contains("[[[[9,9],[10,11],[11,11],[9,9]]]]"), "{out}");
        // a path that is not there changes nothing
        assert_eq!(set_corner(body, 0, &[7], 0.0, 0.0), None);
        assert_eq!(set_corner(body, 0, &[], 0.0, 0.0), None);
        assert_eq!(set_corner(body, 3, &[0, 0], 0.0, 0.0), None);
        // too many corners to handle: none are offered
        let long: Vec<String> = (0..1001).map(|i| format!("[{},1]", i as f64 / 100.0)).collect();
        let big = format!(r#"{{"type":"FeatureCollection","features":[{{"type":"Feature","geometry":{{"type":"LineString","coordinates":[{}]}},"properties":{{}}}}]}}"#, long.join(","));
        assert!(parse(&big).unwrap()[0].corners.is_empty());
    }

    #[test]
    fn a_glyph_names_its_icon() {
        assert_eq!((pin_of("★"), pin_of("⊕"), pin_of(""), pin_of("x")), ("star", "pin", "", ""));
    }

    #[test]
    fn a_feature_leads_to_its_orrery_body_and_its_source() {
        // each answer here is what ui-src/map/core.js gives for the same text
        assert_eq!(orrery_link("person/~sampel-palnet").as_deref(), Some("/apps/orrery#body/person/~sampel-palnet"));
        assert_eq!(orrery_link("place/the_park.2").as_deref(), Some("/apps/orrery#body/place/the_park.2"));
        for bad in ["", "person", "person/", "/x", "Person/x", "1a/x", "a/b/c", "a/b c", "a/b#c", "javascript:alert(1)/x"] {
            assert_eq!(orrery_link(bad), None, "{bad}");
        }
        assert_eq!(orrery_link(&format!("a/{}", "b".repeat(199))), None);
        assert_eq!(source_link(" https://example.com/a?b=1 "), Some(Source::Url("https://example.com/a?b=1".into())));
        assert_eq!(source_link("HTTP://example.com"), Some(Source::Url("HTTP://example.com".into())));
        assert_eq!(source_link("notes/today"), Some(Source::Page("notes/today".into())));
        assert_eq!(source_link("[[notes/today]]"), Some(Source::Page("notes/today".into())));
        assert_eq!(source_link("/notes/today"), Some(Source::Page("notes/today".into())));
        for bad in ["", "  ", "javascript:alert(1)", "file:///etc/passwd", "mailto:a@b.c", "https://", "https://a b", "a page with spaces", "notes/../secret", "notes//x", "a/./b"] {
            assert_eq!(source_link(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_press_picks_the_shape_under_it() {
        let feats = parse(r#"{"type":"FeatureCollection","features":[
            {"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[1,0],[0,0]]]},"properties":{}},
            {"type":"Feature","geometry":{"type":"LineString","coordinates":[[0,2],[1,2]]},"properties":{}},
            {"type":"Feature","geometry":{"type":"Point","coordinates":[0.5,0.5]},"properties":{}}]}"#).unwrap();
        let (w, h) = (800.0, 600.0);
        let cam = Camera::fit(&feats, w, h);
        let at = |lon: f64, lat: f64| cam.project(mercator(lon, lat), w, h);
        let pick = |[x, y]: [f32; 2]| hit(feats.iter().enumerate(), &cam, w, h, x, y);
        // inside the area, away from the point in it
        assert_eq!(pick(at(0.1, 0.1)), Some(0));
        // the point, drawn over the area, wins where both are under the press
        assert_eq!(pick(at(0.5, 0.5)), Some(2));
        // near the line but not on it, and then out of reach
        let [x, y] = at(0.5, 2.0);
        assert_eq!(pick([x, y + 8.0]), Some(1));
        assert_eq!(pick([x, y + 40.0]), None);
        // just outside the area's edge still picks it, well outside does not
        let [x, y] = at(1.0, 0.5);
        assert_eq!(pick([x + 6.0, y]), Some(0));
        assert_eq!(pick([x + 60.0, y]), None);
        // a hidden feature is not offered, so it is not picked
        assert_eq!(hit(feats.iter().enumerate().filter(|(i, _)| *i != 2), &cam, w, h, at(0.5, 0.5)[0], at(0.5, 0.5)[1]), Some(0));
    }

    #[test]
    fn a_map_names_its_base_or_gets_streets() {
        assert_eq!(base_style(r#"{"type":"FeatureCollection","features":[],"lattice":{"base":"satellite"}}"#), "satellite");
        assert_eq!(base_style(r#"{"type":"FeatureCollection","features":[],"lattice":{"base":"nonsense"}}"#), "streets");
        assert_eq!(base_style(r#"{"type":"FeatureCollection","features":[]}"#), "streets");
        assert_eq!(base_style("not json"), "streets");
    }

    /// How many positions the shapes of these features have in all.
    fn positions(feats: &[Feature]) -> usize {
        feats.iter().flat_map(|f| &f.geoms).map(|g| match g {
            Geom::Point(_) => 1,
            Geom::Line(l) | Geom::Area(l) => l.len(),
        }).sum()
    }

    #[test]
    fn a_page_too_large_to_draw_is_cut_short_and_says_so() {
        let page = |feats: &[String]| format!(r#"{{"type":"FeatureCollection","features":[{}]}}"#, feats.join(","));
        let line = |n: usize, at: usize| {
            let pts: Vec<String> = (0..n).map(|i| format!("[{},{}]", i as f64 / 1000.0, at)).collect();
            format!(r#"{{"type":"Feature","geometry":{{"type":"LineString","coordinates":[{}]}},"properties":{{"name":"L{at}"}}}}"#, pts.join(","))
        };
        // 200,000 positions in 40 lines: every line is still there, each with fewer positions and its own ends
        let big = page(&(0..40).map(|i| line(5000, i)).collect::<Vec<_>>());
        let t = std::time::Instant::now();
        let (feats, cut) = parse_cut(&big).unwrap();
        assert!(t.elapsed().as_millis() < 5000, "{:?}", t.elapsed());
        assert_eq!((feats.len(), cut), (40, Cut { features: 0, thinned: true }));
        assert!(positions(&feats) <= SHOWN_POINTS && positions(&feats) > SHOWN_POINTS / 2, "{}", positions(&feats));
        assert!(feats.iter().all(|f| matches!(&f.geoms[..], [Geom::Line(l)] if l[0] == mercator(0.0, f.at as f64) && l[l.len() - 1] == mercator(4.999, f.at as f64))));
        assert!(cut.notice().unwrap().contains("drawn roughly"));
        assert_eq!(parse(&big).unwrap().len(), 40, "the plain answer is cut the same way");
        // more features than are drawn: the first are, each in its place in the page, and the rest are counted
        let point = |i: usize| format!(r#"{{"type":"Feature","geometry":{{"type":"Point","coordinates":[{},1]}},"properties":{{}}}}"#, i as f64 / 1000.0);
        let many = page(&(0..SHOWN_FEATURES + 700).map(point).collect::<Vec<_>>());
        let (feats, cut) = parse_cut(&many).unwrap();
        assert_eq!((feats.len(), feats[feats.len() - 1].at, cut), (SHOWN_FEATURES, SHOWN_FEATURES - 1, Cut { features: 700, thinned: false }));
        assert!(cut.notice().unwrap().contains("700 of its shapes are not shown"));
        // one feature of more points than are drawn, and lines too many to thin enough: what is past the limit is left out
        let multi: Vec<String> = (0..SHOWN_POINTS + 50).map(|i| format!("[{},2]", i as f64 / 1000.0)).collect();
        let crowd = page(&[format!(r#"{{"type":"Feature","geometry":{{"type":"MultiPoint","coordinates":[{}]}},"properties":{{}}}}"#, multi.join(",")), line(10, 0)]);
        let (feats, cut) = parse_cut(&crowd).unwrap();
        assert_eq!((positions(&feats), feats.len(), cut.features), (SHOWN_POINTS, 1, 1));
        // a page that fits is whole, and nothing is said of it
        let (feats, cut) = parse_cut(PAGE).unwrap();
        assert_eq!((feats.len(), cut, cut.notice()), (4, Cut::default(), None));
    }

    #[test]
    fn no_position_that_is_not_a_number_reaches_the_drawing() {
        let body = r#"{"type":"FeatureCollection","features":[
            {"type":"Feature","geometry":{"type":"Point","coordinates":[1e300,95]},"properties":{}},
            {"type":"Feature","geometry":{"type":"LineString","coordinates":[[-1e300,-95],[1e308,1e308],[0,0]]},"properties":{}}]}"#;
        let feats = parse(body).unwrap();
        let cam = Camera::fit(&feats, 800.0, 600.0);
        assert!(cam.at.iter().all(|v| v.is_finite()) && cam.scale.is_finite());
        for g in feats.iter().flat_map(|f| &f.geoms) {
            let pts: &[P] = match g {
                Geom::Point(p) => std::slice::from_ref(p),
                Geom::Line(l) | Geom::Area(l) => l,
            };
            for p in pts {
                assert!((-1.5..=2.5).contains(&p[0]) && (0.0..=1.0).contains(&p[1]), "{p:?}");
                assert!(cam.project(*p, 800.0, 600.0).iter().all(|v| v.is_finite()));
            }
        }
        // asked for what is no place, the answer is still a number
        for (lon, lat) in [(f64::NAN, f64::NAN), (f64::INFINITY, f64::NEG_INFINITY), (1e300, 95.0)] {
            assert!(mercator(lon, lat).iter().all(|v| v.is_finite()), "{lon} {lat}");
        }
        for p in [[f64::NAN, f64::NAN], [f64::INFINITY, f64::NEG_INFINITY], [1e300, -1e300]] {
            assert!(lonlat(p).iter().all(|v| v.is_finite()), "{p:?}");
        }
        // the camera stays a number and near the map whatever moves it
        let start = Camera { at: [0.5, 0.5], scale: 800.0 };
        assert_eq!(Camera::dragged(start, f32::NAN, 0.0), start);
        assert_eq!(Camera::dragged(start, f32::INFINITY, f32::NEG_INFINITY), start);
        let mut far = start;
        for _ in 0..100 {
            far = Camera::dragged(far, -3.0e38, 0.0);
        }
        assert_eq!(far.at, [3.5, 0.5]);
        let mut z = start;
        z.zoom_at(f64::NAN, 10.0, 10.0, 800.0, 600.0);
        z.zoom_at(1.0, f32::NAN, 10.0, 800.0, 600.0);
        assert_eq!(z, start);
        // the lines of longitude the view counts from where it looks fit a whole number with room to count on
        let edge = far.unproject(0.0, 0.0, 800.0, 600.0);
        assert!(((edge[0] - 0.5) * 360.0 / 0.001).abs() < 1e12);
        // a camera that is nowhere asks for no tiles, at once, and a zoom deeper than can be counted is held
        let t = std::time::Instant::now();
        assert!(tiles(&Camera { at: [f64::NAN, 0.5], scale: 512.0 * 131_072.0 }, 800.0, 600.0, 17).is_empty());
        assert!(tiles(&Camera { at: [0.5, 0.5], scale: f64::INFINITY }, 800.0, 600.0, 40).len() <= MAX_TILES);
        assert!(t.elapsed().as_millis() < 5000);
        // a move or a corner that is not a number writes nothing
        assert_eq!(shift(PAGE, 0, f64::NAN, 0.0), None);
        assert_eq!(shift(PAGE, 0, 0.0, f64::INFINITY), None);
        assert_eq!(set_corner(PAGE, 1, &[0], f64::NAN, 0.0), None);
    }

    #[test]
    fn flexible_times_age_filter_ring_edge_hit_and_svg_pdf_work() {
        assert_eq!(parse_time("2026-11-17 09:30").as_deref(), Some("2026-11-17T09:30:00Z"));
        assert_eq!(parse_time("2026/11/17").as_deref(), Some("2026-11-17"));
        assert_eq!(parse_time("Nov 17, 2026").as_deref(), Some("2026-11-17"));
        assert_eq!(parse_time("17 Nov 2026 14:15").as_deref(), Some("2026-11-17T14:15:00Z"));
        assert!(parse_time("now").is_some_and(|s| time_ok(&s)));
        assert_eq!(parse_time("not a date"), None);
        let ep = parse_time_epoch("2026-11-17T12:00:00Z").unwrap();
        assert!(matches_age(Some(ep), Some(3600), ep + 1800));
        assert!(!matches_age(Some(ep), Some(3600), ep + 7200));
        assert!(matches_age(None, Some(3600), ep), "undated features stay visible under an age filter");
        assert!(matches_age(None, None, ep));
        let local_ep = parse_time_epoch("2026-11-17T12:00").unwrap();
        assert_eq!(ep - local_ep, crate::funcs::zone_secs() as i64, "zoneless timestamp uses local offset");
        // Ring edge hit selects the point whose ring passes under the click.
        let ring_doc = r#"{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"name":"Beacon","radius":50000,"time":"2026-11-17T12:00:00Z"}}]}"#;
        let feats = parse(ring_doc).unwrap();
        let (w, h) = (800.0, 600.0);
        let cam = Camera { at: mercator(0.0, 0.0), scale: 80_000.0 };
        let edge = circle([0.0, 0.0], 50_000.0)[0];
        let [ex, ey] = cam.project(edge, w, h);
        let [cx, cy] = cam.project(mercator(0.0, 0.0), w, h);
        assert!((ex - cx).hypot(ey - cy) > 25.0, "ring edge is well away from center dot");
        assert_eq!(hit(feats.iter().enumerate(), &cam, w, h, ex, ey), Some(0));
        // SVG HTML rendering for PDF export.
        let html = render_html(ring_doc, "My Map").unwrap();
        assert!(html.contains("<svg ") && html.contains("Beacon") && html.contains("<h1>My Map</h1>"));
    }
}
