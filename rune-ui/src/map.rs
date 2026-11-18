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
    /// What kind of thing it is, or nothing. A map is filtered by it.
    pub kind: String,
    /// Its colour as `#rgb` or `#rrggbb`: its own, else its kind's, else blue.
    pub color: String,
    /// The glyph a point shows, or nothing for a plain dot.
    pub icon: &'static str,
}

/// The icons a feature may name, each with its glyph, as on the web.
/// The pin alone differs: the web's U+2316 is in no font Rune falls back to
/// on Linux and drew as an empty box, so it is the circled plus here.
pub const ICONS: [(&str, &str); 16] = [
    ("dot", ""), ("pin", "⊕"), ("star", "★"), ("flag", "⚑"), ("home", "⌂"), ("camera", "◉"), ("alert", "⚠"), ("person", "☺"),
    ("car", "▣"), ("boat", "⛵"), ("plane", "✈"), ("fire", "♨"), ("water", "≈"), ("tent", "△"), ("cross", "✚"), ("question", "?"),
];
/// The icon a kind gets when the feature names none.
const KIND_ICON: [(&str, &str); 5] = [("place", "pin"), ("situation", "flag"), ("person", "person"), ("home", "home"), ("report", "alert")];
pub const KIND_COLORS: [&str; 8] = ["#c0392b", "#2e86c1", "#28a745", "#8e44ad", "#d68910", "#16a085", "#7f8c8d", "#e84393"];

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

/// Longitude and latitude to the unit square. The latitude is held inside
/// what Mercator can show.
pub fn mercator(lon: f64, lat: f64) -> P {
    let lat = lat.clamp(-85.0511, 85.0511).to_radians();
    [lon / 360.0 + 0.5, 0.5 - (std::f64::consts::FRAC_PI_4 + lat / 2.0).tan().ln() / std::f64::consts::TAU]
}

/// The longitude and latitude of a position on the unit square: what
/// `mercator` undoes. The longitude is held in -180 to 180.
pub fn lonlat(p: P) -> [f64; 2] {
    let lon = ((p[0] - 0.5) * 360.0 + 180.0).rem_euclid(360.0) - 180.0;
    [lon, (std::f64::consts::PI * (1.0 - 2.0 * p[1])).sinh().atan().to_degrees().clamp(-85.0511, 85.0511)]
}

fn pos(v: &Value) -> Option<P> {
    let a = v.as_array()?;
    Some(mercator(a.first()?.as_f64()?, a.get(1)?.as_f64()?))
}

fn ring(v: &Value) -> Vec<P> {
    v.as_array().map_or(Vec::new(), |a| a.iter().filter_map(pos).collect())
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

/// The features of a GeoJSON page that have something to draw. `None` when
/// the text is not a FeatureCollection.
pub fn parse(body: &str) -> Option<Vec<Feature>> {
    let v: Value = serde_json::from_str(body).ok()?;
    let feats = v["features"].as_array()?;
    let text = |v: &Value| match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    Some(
        feats
            .iter()
            .enumerate()
            .filter_map(|(at, f)| {
                let mut g = Vec::new();
                geoms(&f["geometry"], &mut g);
                let p = &f["properties"];
                let props = p.as_object().map_or(Vec::new(), |o| o.iter().map(|(k, v)| (k.clone(), text(v))).filter(|(_, v)| !v.is_empty()).collect());
                let (kind, color, icon) = look(p);
                (!g.is_empty()).then(|| Feature { name: text(&p["name"]), note: text(&p["note"]), props, geoms: g, at, kind, color, icon })
            })
            .collect(),
    )
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
        self.scale = (self.scale * factor).clamp(SCALE.0, SCALE.1);
        self.at = [under[0] - (x - w / 2.0) as f64 / self.scale, under[1] - (y - h / 2.0) as f64 / self.scale];
    }

    /// The camera `from` moved by a drag of (`dx`, `dy`) points.
    pub fn dragged(from: Camera, dx: f32, dy: f32) -> Camera {
        Camera { at: [from.at[0] - dx as f64 / from.scale, (from.at[1] - dy as f64 / from.scale).clamp(0.0, 1.0)], scale: from.scale }
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
    let z = (cam.scale / 512.0).log2().round().clamp(0.0, f64::from(max_z)) as u32;
    let n = f64::from(1u32 << z);
    let (a, b) = (cam.unproject(0.0, 0.0, w, h), cam.unproject(w, h, w, h));
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
pub fn set_props(body: &str, at: usize, props: &[(&str, Option<&str>)]) -> Option<String> {
    change(body, |d| {
        let f = d.get_mut("features")?.as_array_mut()?.get_mut(at)?.as_object_mut()?;
        if !f.get("properties").is_some_and(Value::is_object) {
            f.insert("properties".into(), Value::Object(Default::default()));
        }
        let p = f.get_mut("properties")?.as_object_mut()?;
        for (k, v) in props {
            match v {
                Some(v) => drop(p.insert((*k).into(), (*v).into())),
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

/// A map page with a new feature of this geometry and no properties,
/// after the others.
pub fn add(body: &str, geometry: Value) -> Option<String> {
    change(body, |d| {
        d.get_mut("features")?.as_array_mut()?.push(serde_json::json!({"type": "Feature", "geometry": geometry, "properties": {}}));
        Some(())
    })
}

/// A map page with its feature `at` moved by so many degrees, every
/// position of it. Anything a position has past its first two is kept.
pub fn shift(body: &str, at: usize, dlon: f64, dlat: f64) -> Option<String> {
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
                Geom::Point(p) => seg(cam.project(*p, w, h), cam.project(*p, w, h)),
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
        let out = set_props(body, 1, &[("name", Some("B")), ("kind", None), ("note", Some("two\nlines"))]).unwrap();
        assert!(out.contains(r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"name":"B","zz":[1],"note":"two\nlines"},"id":"x"}"#), "{out}");
        // a feature with no properties gets them, and the others are as they were
        let out = set_props(body, 2, &[("icon", Some("star"))]).unwrap();
        assert!(out.ends_with("{\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":[3,4]},\"properties\":{\"icon\":\"star\"}}\n]}\n"), "{out}");
        assert!(out.contains(r#""properties":{"name":"A","kind":"place","zz":[1]},"id":"x"}"#));
        // setting nothing writes the page in lattice's layout and loses nothing: what the web client gives
        assert_eq!(set_props(body, 1, &[]).unwrap(), body.replace(r#"[3,4]}}"#, r#"[3,4]},"properties":{}}"#));
        assert_eq!(set_props(body, 9, &[("name", Some("x"))]), None);
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
        let out = add(body, serde_json::json!({"type": "Point", "coordinates": [lon, lat]})).unwrap();
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
        assert_eq!(add("[]", Value::Null), None);
    }

    #[test]
    fn a_line_and_an_area_are_made_of_the_corners_drawn() {
        let v = [[1.0, 2.0], [3.0, 4.5], [5.0, 6.0]];
        assert_eq!(drawn(Draw::Line, &v[..1]), None);
        assert_eq!(drawn(Draw::Area, &v[..2]), None);
        assert_eq!(drawn(Draw::Point, &v), None);
        let blank = "{\"type\":\"FeatureCollection\",\"lattice\":{},\"features\":[\n]}\n";
        // what the web client writes for the same corners
        let line = add(blank, drawn(Draw::Line, &v[..2]).unwrap()).unwrap();
        assert_eq!(line, "{\"type\":\"FeatureCollection\",\"lattice\":{},\"features\":[\n{\"type\":\"Feature\",\"geometry\":{\"type\":\"LineString\",\"coordinates\":[[1,2],[3,4.5]]},\"properties\":{}}\n]}\n");
        let area = add(blank, drawn(Draw::Area, &v).unwrap()).unwrap();
        assert!(area.contains(r#"{"type":"Polygon","coordinates":[[[1,2],[3,4.5],[5,6],[1,2]]]}"#), "{area}");
        // both are shapes lattice draws
        assert!(matches!(parse(&line).unwrap()[0].geoms[0], Geom::Line(_)));
        assert!(matches!(parse(&area).unwrap()[0].geoms[0], Geom::Area(_)));
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
}
