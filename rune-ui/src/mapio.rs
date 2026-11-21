//! Files in and out of a map page: a port of the web client's
//! `ui-src/map/io.js`. Import reads GeoJSON, GPX and KML into features,
//! the GPX and KML as `@tmcw/togeojson` reads them, and simplifies long
//! tracks. Of a KML file the placemarks are read. Its ground overlays
//! and network links, which togeojson turns into boxes, are not. Export
//! writes GPX. Nothing here touches a file: the caller reads and writes.

use serde_json::{Value, json};

use crate::map;

/// The most text an import reads, as on the web.
const MAX_TEXT: usize = 16 * 1024 * 1024;
/// A line of more positions than this is simplified until it fits.
const SIMPLIFY_TO: usize = 500;

/// The kind of a file, by its name: `geojson`, `gpx`, `kml` or nothing.
pub fn file_kind(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).as_deref() {
        Some("geojson" | "json") => "geojson",
        Some("gpx") => "gpx",
        Some("kml") => "kml",
        _ => "",
    }
}

/// How deep the elements of a file may stand one in another. A track
/// point of a GPX file is five deep and a KML placemark seldom ten, so
/// this refuses only a file made to be deep: the tree is walked by
/// functions that call themselves, and a deep one would run them out of
/// stack and stop the whole app.
const MAX_DEPTH: usize = 256;

/// An element of an XML file: its name as written, its attributes, the
/// elements in it, and the text that stands directly in it. The text is
/// kept once, where it stands: an element with a thousand over it does
/// not make a thousand copies.
#[derive(Debug, Default)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub kids: Vec<Node>,
    /// The text directly in it, every run of it joined.
    own: String,
    /// Where each run of text after an element starts: how many elements come before it, and where it starts in `own`.
    cuts: Vec<(usize, usize)>,
}

impl Node {
    /// Every element under this one with this name, in the file's order.
    /// One inside another of the same name is not looked for: no GPX or
    /// KML file nests them, and a file made to would have its points
    /// counted once for each one round them.
    pub fn all<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        for k in &self.kids {
            if k.name == name {
                out.push(k);
            } else {
                k.all(name, out);
            }
        }
    }

    /// All the text in it and under it, in the file's order.
    pub fn text(&self) -> std::borrow::Cow<'_, str> {
        if self.kids.is_empty() {
            return std::borrow::Cow::Borrowed(&self.own);
        }
        let mut out = String::new();
        self.gather(&mut out);
        std::borrow::Cow::Owned(out)
    }

    fn gather(&self, out: &mut String) {
        let (mut at, mut kid) = (0, 0);
        for &(kids, off) in self.cuts.iter().chain(std::iter::once(&(self.kids.len(), self.own.len()))) {
            out.push_str(&self.own[at..off]);
            self.kids[kid..kids].iter().for_each(|k| k.gather(out));
            (at, kid) = (off, kids);
        }
    }

    /// Adds a run of text where the file has it: after the elements read so far.
    fn say(&mut self, t: &str) {
        if t.is_empty() {
            return;
        }
        if self.cuts.last().map_or(0, |c| c.0) != self.kids.len() {
            self.cuts.push((self.kids.len(), self.own.len()));
        }
        self.own.push_str(t);
    }

    pub fn each(&self, name: &str) -> Vec<&Node> {
        let mut out = Vec::new();
        self.all(name, &mut out);
        out
    }

    /// The first element under this one with this name.
    pub fn first(&self, name: &str) -> Option<&Node> {
        self.kids.iter().find_map(|k| if k.name == name { Some(k) } else { k.first(name) })
    }

    pub fn attr(&self, name: &str) -> &str {
        self.attrs.iter().find(|(k, _)| k == name).map_or("", |(_, v)| v.as_str())
    }
}

/// Text with its character references read: the five named ones and the numbered.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // a reference is short: its end is looked for no further than the longest one reaches
        let end = rest.bytes().take(11).position(|c| c == b';');
        let ch = end.and_then(|e| match &rest[1..e] {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            n => n.strip_prefix("#x").or_else(|| n.strip_prefix("#X")).map_or_else(|| n.strip_prefix('#').and_then(|d| d.parse().ok()), |h| u32::from_str_radix(h, 16).ok()).and_then(char::from_u32),
        });
        match (ch, end) {
            (Some(c), Some(e)) => {
                out.push(c);
                rest = &rest[e + 1..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// An XML file as a tree, under a nameless root. Comments, processing
/// instructions and the doctype are passed over. The error says why a
/// file is not read: it is not well formed, or its elements stand
/// deeper one in another than `MAX_DEPTH`.
// ponytail: no namespaces, no DTD entities. GPX and KML need neither
pub fn xml(src: &str) -> Result<Node, String> {
    let bad = || "the file is not valid XML".to_owned();
    let mut stack = vec![Node::default()];
    let mut rest = src.trim_start_matches('\u{feff}');
    // text belongs to the element it stands in, and to no other
    let say = |stack: &mut Vec<Node>, t: &str| stack.last_mut().into_iter().for_each(|n| n.say(t));
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            say(&mut stack, &unescape(rest));
            break;
        };
        say(&mut stack, &unescape(&rest[..lt]));
        rest = &rest[lt..];
        if let Some(r) = rest.strip_prefix("<!--") {
            rest = &r[r.find("-->").ok_or_else(bad)? + 3..];
        } else if let Some(r) = rest.strip_prefix("<![CDATA[") {
            let end = r.find("]]>").ok_or_else(bad)?;
            say(&mut stack, &r[..end]);
            rest = &r[end + 3..];
        } else if let Some(r) = rest.strip_prefix("<?") {
            rest = &r[r.find("?>").ok_or_else(bad)? + 2..];
        } else if rest.starts_with("<!") {
            // a doctype, with whatever it holds in square brackets when it opens them before it ends
            let gt = rest.find('>').ok_or_else(bad)?;
            let end = match rest[..gt].find('[') {
                Some(open) => {
                    let close = open + rest[open..].find(']').ok_or_else(bad)?;
                    close + rest[close..].find('>').ok_or_else(bad)?
                }
                None => gt,
            };
            rest = &rest[end + 1..];
        } else if let Some(r) = rest.strip_prefix("</") {
            let end = r.find('>').ok_or_else(bad)?;
            let done = stack.pop().ok_or_else(bad)?;
            if done.name != r[..end].trim() || stack.is_empty() {
                return Err(bad());
            }
            stack.last_mut().ok_or_else(bad)?.kids.push(done);
            rest = &r[end + 1..];
        } else {
            // a tag ends at the first > outside a quoted value
            let mut quote = None;
            let end = rest
                .char_indices()
                .find(|(_, c)| match quote {
                    Some(q) => {
                        if *c == q {
                            quote = None;
                        }
                        false
                    }
                    None if *c == '"' || *c == '\'' => {
                        quote = Some(*c);
                        false
                    }
                    None => *c == '>',
                })
                .ok_or_else(bad)?
                .0;
            let tag = rest[1..end].trim_end();
            let (tag, empty) = tag.strip_suffix('/').map_or((tag, false), |t| (t, true));
            let name_end = tag.find(char::is_whitespace).unwrap_or(tag.len());
            let mut node = Node { name: tag[..name_end].to_owned(), ..Node::default() };
            if node.name.is_empty() {
                return Err(bad());
            }
            let mut a = tag[name_end..].trim_start();
            while !a.is_empty() {
                let (key, after) = a.split_once('=').ok_or_else(bad)?;
                let after = after.trim_start();
                let q = after.chars().next().filter(|c| *c == '"' || *c == '\'').ok_or_else(bad)?;
                let close = after[1..].find(q).ok_or_else(bad)?;
                node.attrs.push((key.trim().to_owned(), unescape(&after[1..1 + close])));
                a = after[close + 2..].trim_start();
            }
            if empty {
                stack.last_mut().ok_or_else(bad)?.kids.push(node);
            } else {
                // the root is on the stack too, and is no element of the file
                if stack.len() > MAX_DEPTH {
                    return Err("the file is nested too deeply".into());
                }
                stack.push(node);
            }
            rest = &rest[end + 1..];
        }
    }
    // everything opened was closed, and there was an element at all
    (stack.len() == 1).then(|| stack.pop()).flatten().filter(|root| !root.kids.is_empty()).ok_or_else(bad)
}

/// A number as JavaScript's `parseFloat` reads one: from the start of
/// the text, as far as it is a number.
///
/// How far it is one is found in a single pass, and that much is read
/// once, so a numeral of a million figures costs a million steps and not
/// a million times that.
fn parse_float(s: &str) -> Option<f64> {
    let s = s.trim_start();
    let b = s.as_bytes();
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut end = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let whole = digits(end);
    end += whole;
    let mut part = 0;
    if b.get(end) == Some(&b'.') {
        part = digits(end + 1);
        // a point with no figure on either side is no number
        if whole + part > 0 {
            end += 1 + part;
        }
    }
    if whole + part == 0 {
        return None;
    }
    if matches!(b.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(b.get(end + 1), Some(b'+' | b'-')));
        let power = digits(end + 1 + sign);
        // an exponent with no figures is not part of the number
        if power > 0 {
            end += 1 + sign + power;
        }
    }
    s[..end].parse::<f64>().ok().filter(|v| v.is_finite())
}

/// The text of the first element under `n` with this name, when it has any.
fn said<'a>(n: &'a Node, name: &str) -> Option<std::borrow::Cow<'a, str>> {
    n.first(name).map(Node::text).filter(|t| !t.is_empty())
}

/// A GPX point: its position, with its height when it has one, and its time.
fn gpx_point(n: &Node) -> Option<(Value, Option<std::borrow::Cow<'_, str>>)> {
    let (lon, lat) = (parse_float(n.attr("lon"))?, parse_float(n.attr("lat"))?);
    let mut c = vec![json!(lon), json!(lat)];
    c.extend(n.first("ele").and_then(|e| parse_float(&e.text())).map(Value::from));
    Some((Value::Array(c), said(n, "time")))
}

/// The points of a track segment or a route as a line, with the first
/// time among them. Fewer than two points is no line.
fn gpx_line<'a>(n: &'a Node, each: &str) -> Option<(Vec<Value>, Option<std::borrow::Cow<'a, str>>)> {
    let (mut line, mut time) = (Vec::new(), None);
    for (c, t) in n.each(each).into_iter().filter_map(gpx_point) {
        line.push(c);
        time = time.or(t);
    }
    (line.len() >= 2).then_some((line, time))
}

/// What lattice keeps of a GPX element: its name, its description as the
/// note, its time, and its type as the kind.
fn gpx_props(n: &Node, time: Option<std::borrow::Cow<'_, str>>) -> Value {
    let mut p = serde_json::Map::new();
    let mut put = |k: &str, v: Option<std::borrow::Cow<'_, str>>| drop(v.map(|v| p.insert(k.into(), v.into_owned().into())));
    put("name", said(n, "name"));
    put("note", said(n, "desc"));
    put("time", said(n, "time").or(time));
    put("kind", said(n, "type").filter(|t| t.encode_utf16().count() <= 40));
    Value::Object(p)
}

/// The features of a GPX file: its tracks, then its routes, then its waypoints.
fn gpx(root: &Node) -> Vec<Value> {
    let mut out = Vec::new();
    let feat = |geometry: Value, properties: Value| json!({"type": "Feature", "geometry": geometry, "properties": properties});
    for trk in root.each("trk") {
        let segs: Vec<_> = trk.each("trkseg").into_iter().filter_map(|s| gpx_line(s, "trkpt")).collect();
        let time = segs.iter().find_map(|(_, t)| t.clone());
        let mut lines: Vec<Value> = segs.into_iter().map(|(l, _)| Value::Array(l)).collect();
        let geometry = match lines.len() {
            0 => continue,
            1 => json!({"type": "LineString", "coordinates": lines.remove(0)}),
            _ => json!({"type": "MultiLineString", "coordinates": lines}),
        };
        out.push(feat(geometry, gpx_props(trk, time)));
    }
    for rte in root.each("rte") {
        if let Some((line, _)) = gpx_line(rte, "rtept") {
            out.push(feat(json!({"type": "LineString", "coordinates": line}), gpx_props(rte, None)));
        }
    }
    for wpt in root.each("wpt") {
        if let Some((c, _)) = gpx_point(wpt) {
            out.push(feat(json!({"type": "Point", "coordinates": c}), gpx_props(wpt, None)));
        }
    }
    out
}

/// A KML position, `lon,lat` or `lon,lat,height`: what of it is a number, three at most.
fn kml_pos(t: &str) -> Vec<Value> {
    let t: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    t.split(',').filter_map(parse_float).take(3).map(Value::from).collect()
}

/// The positions of a KML `coordinates` element, apart by white space.
fn kml_line(n: &Node) -> Vec<Value> {
    let text = n.first("coordinates").map_or("".into(), Node::text);
    text.split_whitespace().map(kml_pos).filter(|p| p.len() >= 2).map(Value::Array).collect()
}

/// The geometries directly in a placemark or a multi-geometry, and the
/// times of each track among them.
fn kml_geoms(n: &Node, out: &mut Vec<Value>, times: &mut Vec<Vec<String>>) {
    for k in &n.kids {
        match k.name.as_str() {
            "MultiGeometry" | "MultiTrack" | "gx:MultiTrack" => kml_geoms(k, out, times),
            "Point" => {
                let p = kml_pos(&k.first("coordinates").map_or("".into(), Node::text));
                if p.len() >= 2 {
                    out.push(json!({"type": "Point", "coordinates": p}));
                }
            }
            "LinearRing" | "LineString" => {
                let l = kml_line(k);
                if l.len() >= 2 {
                    out.push(json!({"type": "LineString", "coordinates": l}));
                }
            }
            "Polygon" => {
                let mut rings = Vec::new();
                for r in k.each("LinearRing") {
                    let mut ring = kml_line(r);
                    // a ring that does not end where it began is closed
                    if ring.first() != ring.last() {
                        ring.push(ring[0].clone());
                    }
                    if ring.len() >= 4 {
                        rings.push(Value::Array(ring));
                    }
                }
                if !rings.is_empty() {
                    out.push(json!({"type": "Polygon", "coordinates": rings}));
                }
            }
            "Track" | "gx:Track" => {
                let mut coords = k.each("coord");
                if coords.is_empty() {
                    coords = k.each("gx:coord");
                }
                // what is not a number stays as it is, and the check refuses the file for it
                let mut line: Vec<Value> = coords.iter().map(|c| c.text().split(' ').map(|v| parse_float(v).map_or(Value::Null, Value::from)).collect()).collect();
                match line.len() {
                    0 => continue,
                    1 => out.push(json!({"type": "Point", "coordinates": line.remove(0)})),
                    _ => out.push(json!({"type": "LineString", "coordinates": line})),
                }
                let when: Vec<String> = k.each("when").iter().map(|w| w.text().into_owned()).collect();
                if !when.is_empty() {
                    times.push(when);
                }
            }
            _ => {}
        }
    }
}

/// The features of a KML file: its placemarks that have a shape. Of each
/// lattice keeps the name, the description as the note, a lone track's
/// first time, and what its extended data says of those and of its type.
fn kml(root: &Node) -> Vec<Value> {
    // a schema's fields that are not text come out of togeojson as numbers, which lattice does not keep as a name or a note
    let typed: Vec<&str> = root.each("SimpleField").into_iter().filter(|f| matches!(f.attr("type"), "int" | "uint" | "short" | "ushort" | "float" | "double" | "bool")).map(|f| f.attr("name")).collect();
    let mut out = Vec::new();
    for pm in root.each("Placemark") {
        let (mut geoms, mut times) = (Vec::new(), Vec::new());
        kml_geoms(pm, &mut geoms, &mut times);
        let geometry = match geoms.len() {
            0 => continue,
            1 => geoms.remove(0),
            _ => json!({"type": "GeometryCollection", "geometries": geoms}),
        };
        // read in togeojson's order, a later one taking the place of an earlier
        let mut raw: Vec<(String, Option<String>)> = ["name", "description"].iter().filter_map(|k| said(pm, k).map(|v| ((*k).to_owned(), Some(v.into_owned())))).collect();
        if let Some(ext) = pm.first("ExtendedData") {
            for d in ext.each("Data") {
                raw.push((d.attr("name").to_owned(), Some(d.first("value").map_or(String::new(), |v| v.text().into_owned()))));
            }
            for d in ext.each("SimpleData") {
                raw.push((d.attr("name").to_owned(), (!typed.contains(&d.attr("name"))).then(|| d.text().into_owned())));
            }
        }
        let get = |k: &str| raw.iter().rev().find(|(n, _)| n == k).and_then(|(_, v)| v.as_deref());
        let mut p = serde_json::Map::new();
        let mut put = |k: &str, v: Option<&str>| drop(v.map(|v| p.insert(k.into(), v.into())));
        put("name", get("name"));
        put("note", get("desc").or(get("description")).filter(|d| !d.is_empty()));
        put("time", get("time").or(if times.len() == 1 { times[0].first().map(String::as_str) } else { None }));
        put("kind", get("type").filter(|t| t.encode_utf16().count() <= 40));
        out.push(json!({"type": "Feature", "geometry": geometry, "properties": p}));
    }
    out
}

fn xy(p: &Value) -> [f64; 2] {
    [p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)]
}

/// Each position nearer than `tol` to the last one kept is dropped, the
/// two ends always kept: one pass, so `dp` then works on far fewer.
/// Positions are named by where they are in the line.
fn radial(pts: &[[f64; 2]], tol: f64) -> Vec<usize> {
    let mut out = vec![0];
    let mut last = pts[0];
    for (i, q) in pts.iter().enumerate().take(pts.len() - 1).skip(1) {
        if (q[0] - last[0]).powi(2) + (q[1] - last[1]).powi(2) > tol * tol {
            out.push(i);
            last = *q;
        }
    }
    out.push(pts.len() - 1);
    out
}

/// How many positions the simplifying of one line may look at in all.
/// A line whose farthest position is always beside an end, as a tall
/// sawtooth's is, is looked through once for every position in it, and
/// again for every tolerance tried: 20,000 such positions were 34
/// seconds. A track from a real walk or drive needs a small part of
/// this, and gets exactly what it always got: so does a zigzag of up
/// to some 1,500 positions, the worst there is.
const MOST_LOOKS: usize = 20_000_000;

/// Douglas-Peucker over the positions named by `of`, without recursion
/// so a long track cannot overflow the stack. The first and last are
/// kept. Each position looked at is taken from `looks`, and when none
/// are left the answer is nothing: the line is not half simplified.
fn dp(pts: &[[f64; 2]], of: &[usize], tol: f64, looks: &mut usize) -> Option<Vec<usize>> {
    let n = of.len();
    if n < 3 {
        return Some(of.to_vec());
    }
    let mut keep = vec![false; n];
    (keep[0], keep[n - 1]) = (true, true);
    let mut stack = vec![(0, n - 1)];
    while let Some((a, b)) = stack.pop() {
        *looks = looks.checked_sub(b - a)?;
        let ([ax, ay], [bx, by]) = (pts[of[a]], pts[of[b]]);
        let (dx, dy) = (bx - ax, by - ay);
        let len = dx * dx + dy * dy;
        let (mut far, mut fd) = (None, tol * tol);
        for i in a + 1..b {
            let [px, py] = pts[of[i]];
            let u = if len == 0.0 { 0.0 } else { (((px - ax) * dx + (py - ay) * dy) / len).clamp(0.0, 1.0) };
            let d = (ax + u * dx - px).powi(2) + (ay + u * dy - py).powi(2);
            if d > fd {
                (fd, far) = (d, Some(i));
            }
        }
        if let Some(f) = far {
            keep[f] = true;
            stack.extend([(a, f), (f, b)]);
        }
    }
    Some(of.iter().zip(keep).filter(|(_, k)| *k).map(|(i, _)| *i).collect())
}

/// A line of more than `SIMPLIFY_TO` positions, simplified until it
/// fits. The tolerance starts at a ten-thousandth of the line's extent
/// and doubles. A line that would take more than `MOST_LOOKS` to
/// simplify is thinned evenly to `SIMPLIFY_TO` positions and not
/// simplified at all: it keeps its ends and its shape as far as that
/// many positions can, and is never drawn down to a straight line
/// because the work ran out.
fn simplify(line: &[Value]) -> Vec<Value> {
    if line.len() <= SIMPLIFY_TO {
        return line.to_vec();
    }
    // the positions as numbers, read once: every pass works on these
    let pts: Vec<[f64; 2]> = line.iter().map(xy).collect();
    let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
    for q in &pts {
        for i in 0..2 {
            (lo[i], hi[i]) = (lo[i].min(q[i]), hi[i].max(q[i]));
        }
    }
    let mut tol = ((hi[0] - lo[0]).hypot(hi[1] - lo[1]) * 1e-4).max(0.00001);
    let mut out: Vec<usize> = (0..pts.len()).collect();
    let mut looks = MOST_LOOKS;
    while out.len() > SIMPLIFY_TO && tol < 1.0 {
        let done = looks.checked_sub(pts.len()).and_then(|left| {
            looks = left;
            dp(&pts, &radial(&pts, tol), tol, &mut looks)
        });
        match done {
            Some(kept) => out = kept,
            None => {
                let last = pts.len() - 1;
                out = (0..SIMPLIFY_TO).map(|i| i * last / (SIMPLIFY_TO - 1)).collect();
                break;
            }
        }
        tol *= 2.0;
    }
    out.into_iter().map(|i| line[i].clone()).collect()
}

/// What an import read: the features, and the positions its long lines
/// had before and after they were simplified, both 0 when none was.
#[derive(Debug)]
pub struct Imported {
    pub features: Vec<Value>,
    pub before: usize,
    pub after: usize,
}

/// The features of a file of this kind, checked the way a page is, with
/// long lines simplified. The error says why a file was not read.
pub fn import(kind: &str, text: &str) -> Result<Imported, String> {
    if text.len() > MAX_TEXT {
        return Err("the file is too large".into());
    }
    let mut features = match kind {
        "geojson" => {
            if map::depth(text) > 64 {
                return Err("the file is nested too deeply".into());
            }
            let j: Value = serde_json::from_str(text).map_err(|_| "the file is not valid JSON")?;
            match j.get("type").and_then(Value::as_str) {
                Some("Feature") => vec![j],
                Some("FeatureCollection") => match j.get("features") {
                    Some(Value::Array(a)) => a.clone(),
                    _ => return Err("the collection has no features list".into()),
                },
                Some(_) => vec![json!({"type": "Feature", "geometry": j, "properties": {}})],
                None => return Err("the file is not GeoJSON".into()),
            }
        }
        "gpx" => gpx(&xml(text)?),
        "kml" => kml(&xml(text)?),
        _ => return Err("lattice reads .geojson, .json, .gpx and .kml files".into()),
    };
    let whole = |features: &[Value]| json!({"type": "FeatureCollection", "features": features});
    map::check(&whole(&features), usize::MAX).map_err(|why| why.replace("the page", "the file"))?;
    let (mut before, mut after) = (0, 0);
    for f in &mut features {
        let Some(g) = f.get_mut("geometry").filter(|g| g.is_object()) else { continue };
        let mut line = |c: &mut Value| {
            if let Value::Array(a) = c {
                before += a.len();
                *a = simplify(a);
                after += a.len();
            }
        };
        match g.get("type").and_then(Value::as_str) {
            Some("LineString") => line(&mut g["coordinates"]),
            Some("MultiLineString") => g["coordinates"].as_array_mut().into_iter().flatten().for_each(line),
            _ => {}
        }
    }
    map::check(&whole(&features), map::MAX_POSITIONS).map_err(|why| why.replace("the page", "the file"))?;
    let same = before == after;
    Ok(Imported { features, before: if same { 0 } else { before }, after: if same { 0 } else { after } })
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// A map page as GPX 1.1: its points as waypoints, its lines and the
/// outlines of its areas as tracks. A shape GPX cannot write is left out.
/// `None` when the page is not a map.
pub fn export_gpx(body: &str, name: &str) -> Option<String> {
    let doc: Value = serde_json::from_str(body).ok()?;
    let feats = doc.get("features")?.as_array()?;
    let n7 = |v: f64| format!("{}", (v * 1e7).round() / 1e7);
    let pos = |q: &Value| Some((q.get(0)?.as_f64()?, q.get(1)?.as_f64()?)).filter(|(x, y)| x.is_finite() && y.is_finite());
    let seg = |c: &Value| {
        let ps: Vec<String> = c.as_array().into_iter().flatten().filter_map(pos).map(|(x, y)| format!("<trkpt lat=\"{}\" lon=\"{}\"/>", n7(y), n7(x))).collect();
        if ps.is_empty() { String::new() } else { format!("<trkseg>{}</trkseg>", ps.concat()) }
    };
    let (mut wpt, mut trk) = (String::new(), String::new());
    fn one(g: &Value, meta: &str, time: &str, wpt: &mut String, trk: &mut String, pos: &dyn Fn(&Value) -> Option<(f64, f64)>, seg: &dyn Fn(&Value) -> String, n7: &dyn Fn(f64) -> String) {
        let c = &g["coordinates"];
        let list = |v: &Value| v.as_array().cloned().unwrap_or_default();
        let mut track = |s: String| {
            if !s.is_empty() {
                trk.push_str(&format!("<trk>{meta}{s}</trk>"));
            }
        };
        match g["type"].as_str() {
            Some("Point") => {
                if let Some((x, y)) = pos(c) {
                    wpt.push_str(&format!("<wpt lat=\"{}\" lon=\"{}\">{time}{meta}</wpt>", n7(y), n7(x)));
                }
            }
            Some("MultiPoint") => list(c).iter().for_each(|q| one(&json!({"type": "Point", "coordinates": q}), meta, time, wpt, trk, pos, seg, n7)),
            Some("LineString") => track(seg(c)),
            Some("MultiLineString") => track(list(c).iter().map(seg).collect()),
            Some("Polygon") => track(seg(&c[0])),
            Some("MultiPolygon") => list(c).iter().for_each(|q| one(&json!({"type": "Polygon", "coordinates": q}), meta, time, wpt, trk, pos, seg, n7)),
            Some("GeometryCollection") => list(&g["geometries"]).iter().for_each(|h| one(h, meta, time, wpt, trk, pos, seg, n7)),
            _ => {}
        }
    }
    for f in feats {
        let p = &f["properties"];
        let s = |k: &str, cap: usize| p.get(k).and_then(Value::as_str).map(|v| v.chars().take(cap).collect::<String>()).filter(|v| !v.is_empty());
        let meta = s("name", 300).map_or(String::new(), |n| format!("<name>{}</name>", esc(&n))) + &s("note", 100_000).map_or(String::new(), |n| format!("<desc>{}</desc>", esc(&n)));
        let time = s("time", 64).filter(|t| map::time_ok(t)).map_or(String::new(), |t| format!("<time>{}</time>", esc(&t)));
        one(&f["geometry"], &meta, &time, &mut wpt, &mut trk, &pos, &seg, &n7);
    }
    Some(format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<gpx version=\"1.1\" creator=\"lattice\" xmlns=\"http://www.topografix.com/GPX/1/1\"><metadata><name>{}</name></metadata>{wpt}{trk}</gpx>\n", esc(name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GPX: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!-- a walk -->
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>File name</name></metadata>
  <wpt lat="40.7484" lon="-73.9857"><ele>12.5</ele><time>2026-11-17T09:30:00Z</time><name>Mid &amp; town</name><desc><![CDATA[a <b>note</b>]]></desc><type>place</type></wpt>
  <wpt lat="nope" lon="1"><name>Lost</name></wpt>
  <rte><name>Route</name><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte>
  <trk><name>Walk</name><type>this type is far longer than the forty characters a kind may have</type>
    <trkseg><trkpt lat="40.1" lon="-73.1"><time>2026-11-17T10:00:00Z</time></trkpt><trkpt lat="40.2" lon="-73.2"><ele>5</ele></trkpt></trkseg>
    <trkseg><trkpt lat="40.3" lon="-73.3"/></trkseg>
    <trkseg><trkpt lat="41" lon="-74"/><trkpt lat="41.5" lon="-74.5"/></trkseg>
  </trk>
  <trk><name>Stub</name><trkseg><trkpt lat="1" lon="1"/></trkseg></trk>
</gpx>"#;

    #[test]
    fn a_gpx_file_is_read_as_the_web_client_reads_one() {
        let got = import("gpx", GPX).unwrap();
        // tracks, then routes, then waypoints. A segment of one point, a track of none and a point with no place are dropped
        assert_eq!(
            serde_json::to_string(&got.features).unwrap(),
            concat!(
                r#"[{"type":"Feature","geometry":{"type":"MultiLineString","coordinates":[[[-73.1,40.1],[-73.2,40.2,5.0]],[[-74.0,41.0],[-74.5,41.5]]]},"properties":{"name":"Walk","time":"2026-11-17T10:00:00Z"}},"#,
                r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[2.0,1.0],[4.0,3.0]]},"properties":{"name":"Route"}},"#,
                r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[-73.9857,40.7484,12.5]},"properties":{"name":"Mid & town","note":"a <b>note</b>","time":"2026-11-17T09:30:00Z","kind":"place"}}]"#
            )
        );
        assert_eq!((got.before, got.after), (0, 0));
        // it lands in a page as shapes lattice draws
        let page = map::append("{\"type\":\"FeatureCollection\",\"features\":[]}", got.features).unwrap();
        assert_eq!(map::parse(&page).unwrap().len(), 3);
    }

    #[test]
    fn what_is_not_a_file_lattice_reads_says_why() {
        assert_eq!(import("gpx", "<gpx><wpt></gpx>").unwrap_err(), "the file is not valid XML");
        assert_eq!(import("gpx", "not xml").unwrap_err(), "the file is not valid XML");
        assert_eq!(import("gpx", "<gpx/>").unwrap().features.len(), 0);
        assert_eq!(import("geojson", "{").unwrap_err(), "the file is not valid JSON");
        assert_eq!(import("geojson", "{\"a\":1}").unwrap_err(), "the file is not GeoJSON");
        assert_eq!(import("geojson", r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[1,2]]}}"#).unwrap_err(), "a line or ring has too few positions");
        assert_eq!(import("geojson", r#"{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[1,"x"]}}]}"#).unwrap_err(), "a coordinate is not a number");
        assert_eq!(import("geojson", &format!("{}1{}", "[".repeat(70), "]".repeat(70))).unwrap_err(), "the file is nested too deeply");
        assert_eq!(import("txt", "x").unwrap_err(), "lattice reads .geojson, .json, .gpx and .kml files");
        assert_eq!(import("kml", "<kml><Placemark></kml>").unwrap_err(), "the file is not valid XML");
        // a track position that is not a number refuses the file, as on the web
        assert_eq!(import("kml", "<kml xmlns:gx=\"http://www.google.com/kml/ext/2.2\"><Placemark><gx:Track><gx:coord>1 x</gx:coord><gx:coord>1 2</gx:coord></gx:Track></Placemark></kml>").unwrap_err(), "a coordinate is not a number");
        assert_eq!((file_kind("a/Walk.GPX"), file_kind("x.json"), file_kind("x.geojson"), file_kind("x.kml"), file_kind("x.txt"), file_kind("gpx")), ("gpx", "geojson", "geojson", "kml", "", ""));
    }

    const KML: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document><name>Doc name</name>
  <Schema name="s" id="s"><SimpleField type="int" name="count"/><SimpleField type="string" name="type"/></Schema>
  <Style id="a"><LineStyle><color>ff0000ff</color></LineStyle></Style>
  <Folder><name>Folder</name>
    <Placemark id="p1"><name>Spot</name><description><![CDATA[<p>hello</p>]]></description><styleUrl>#a</styleUrl>
      <Point><coordinates> -73.9857, 40.7484, 12 </coordinates></Point></Placemark>
    <Placemark><name>Line</name><ExtendedData><SchemaData schemaUrl="#s"><SimpleData name="type">route</SimpleData><SimpleData name="count">3</SimpleData></SchemaData></ExtendedData>
      <LineString><coordinates>1,2,0 3,4,0
        5,6</coordinates></LineString></Placemark>
    <Placemark><name>Area</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 0,1 1,1</coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>0.2,0.2 0.2,0.4 0.4,0.4 0.2,0.2</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
    <Placemark><name>Both</name><ExtendedData><Data name="name"><value>Renamed</value></Data><Data name="desc"><value>from data</value></Data></ExtendedData>
      <MultiGeometry><Point><coordinates>7,8</coordinates></Point><LineString><coordinates>7,8 9,10</coordinates></LineString></MultiGeometry></Placemark>
    <Placemark><name>Run</name><gx:Track><when>2026-11-17T09:00:00Z</when><when>2026-11-17T09:05:00Z</when><gx:coord>-73.1 40.1 5</gx:coord><gx:coord>-73.2 40.2 6</gx:coord></gx:Track></Placemark>
    <Placemark><name>Nowhere</name></Placemark>
    <Placemark><name>Short</name><LineString><coordinates>1,2</coordinates></LineString></Placemark>
  </Folder>
</Document></kml>"##;

    #[test]
    fn a_kml_file_is_read_as_the_web_client_reads_one() {
        let got = import("kml", KML).unwrap().features;
        let line = |i: usize| serde_json::to_string(&got[i]).unwrap();
        assert_eq!(got.len(), 5, "a placemark with no shape, or a line of one position, is left out");
        // the description's markup is kept as text, and the height stays with the position
        assert_eq!(line(0), r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[-73.9857,40.7484,12.0]},"properties":{"name":"Spot","note":"<p>hello</p>"}}"#);
        // positions are apart by any white space. The schema's text field is the kind, its number is not kept
        assert_eq!(line(1), r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[1.0,2.0,0.0],[3.0,4.0,0.0],[5.0,6.0]]},"properties":{"name":"Line","kind":"route"}}"#);
        // an open ring is closed, and a hole is a ring too
        assert_eq!(line(2), r#"{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0.0,0.0],[0.0,1.0],[1.0,1.0],[0.0,0.0]],[[0.2,0.2],[0.2,0.4],[0.4,0.4],[0.2,0.2]]]},"properties":{"name":"Area"}}"#);
        // two shapes are a collection, and extended data takes the place of the name and gives the note
        assert_eq!(line(3), r#"{"type":"Feature","geometry":{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[7.0,8.0]},{"type":"LineString","coordinates":[[7.0,8.0],[9.0,10.0]]}]},"properties":{"name":"Renamed","note":"from data"}}"#);
        // a track is a line, timed by its first position
        assert_eq!(line(4), r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[-73.1,40.1,5.0],[-73.2,40.2,6.0]]},"properties":{"name":"Run","time":"2026-11-17T09:00:00Z"}}"#);
        // it lands in a page as shapes lattice draws
        let page = map::append("{\"type\":\"FeatureCollection\",\"features\":[]}", got).unwrap();
        assert_eq!(map::parse(&page).unwrap().len(), 5);
    }

    #[test]
    fn geojson_comes_in_whole_as_a_feature_a_collection_or_a_bare_shape() {
        let one = import("geojson", r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"name":"A","zz":[1]}}"#).unwrap();
        assert_eq!(one.features[0]["properties"]["zz"][0], 1, "its properties are kept as they are");
        let bare = import("geojson", r#"{"type":"Point","coordinates":[1,2]}"#).unwrap();
        assert_eq!(bare.features[0]["geometry"]["type"], "Point");
        let many = import("geojson", r#"{"type":"FeatureCollection","features":[{"type":"Feature","geometry":null},{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]}}]}"#).unwrap();
        assert_eq!(many.features.len(), 2);
    }

    #[test]
    fn a_long_track_is_simplified_and_keeps_its_ends_and_its_turn() {
        // out along a line and back along another: 4001 positions with one sharp turn
        let pts: Vec<String> = (0..=4000).map(|i| if i <= 2000 { format!("[{},0]", i as f64 / 1000.0) } else { format!("[2,{}]", (i - 2000) as f64 / 1000.0) }).collect();
        let got = import("geojson", &format!(r#"{{"type":"LineString","coordinates":[{}]}}"#, pts.join(","))).unwrap();
        let line = got.features[0]["geometry"]["coordinates"].as_array().unwrap();
        assert_eq!(got.before, 4001);
        assert_eq!((got.after, line.len()), (3, 3), "two straight runs need three positions");
        assert_eq!((xy(&line[0]), xy(&line[1]), xy(&line[2])), ([0.0, 0.0], [2.0, 0.0], [2.0, 2.0]));
        // a short line is left alone
        let short = import("geojson", r#"{"type":"LineString","coordinates":[[0,0],[1,1],[2,0]]}"#).unwrap();
        assert_eq!((short.before, short.features[0]["geometry"]["coordinates"].as_array().unwrap().len()), (0, 3));
    }

    #[test]
    fn a_map_goes_out_as_gpx_and_comes_back_the_same_shapes() {
        let body = r#"{"type":"FeatureCollection","features":[
{"type":"Feature","geometry":{"type":"Point","coordinates":[-73.98570001,40.7484]},"properties":{"name":"A <b> & \"c\"","note":"n","time":"2026-11-17T09:30:00Z"}},
{"type":"Feature","geometry":{"type":"LineString","coordinates":[[1,2],[3,4]]},"properties":{"name":"L","time":"never"}},
{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[0,0]],[[9,9],[9,9],[9,9],[9,9]]]},"properties":{}},
{"type":"Feature","geometry":null,"properties":{"name":"none"}},
{"type":"Feature","geometry":{"type":"MultiPoint","coordinates":[[5,6],["x",1]]},"properties":{}}
]}"#;
        let out = export_gpx(body, "My <map>").unwrap();
        // what the web client's exportGpx writes for the same page
        assert_eq!(
            out,
            concat!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<gpx version=\"1.1\" creator=\"lattice\" xmlns=\"http://www.topografix.com/GPX/1/1\"><metadata><name>My &lt;map&gt;</name></metadata>",
                "<wpt lat=\"40.7484\" lon=\"-73.9857\"><time>2026-11-17T09:30:00Z</time><name>A &lt;b&gt; &amp; &quot;c&quot;</name><desc>n</desc></wpt>",
                "<wpt lat=\"6\" lon=\"5\"></wpt>",
                "<trk><name>L</name><trkseg><trkpt lat=\"2\" lon=\"1\"/><trkpt lat=\"4\" lon=\"3\"/></trkseg></trk>",
                "<trk><trkseg><trkpt lat=\"0\" lon=\"0\"/><trkpt lat=\"1\" lon=\"0\"/><trkpt lat=\"1\" lon=\"1\"/><trkpt lat=\"0\" lon=\"0\"/></trkseg></trk>",
                "</gpx>\n"
            )
        );
        let back = import("gpx", &out).unwrap().features;
        assert_eq!(back.len(), 4);
        assert_eq!(back[2]["properties"]["name"], "A <b> & \"c\"");
        assert_eq!(export_gpx("[]", "x"), None);
    }

    #[test]
    fn text_is_kept_once_and_read_in_the_files_order() {
        let root = xml("<a>one<b>two<c/>three</b>four<d>five</d>six</a>").unwrap();
        let a = &root.kids[0];
        assert_eq!((a.text().as_ref(), a.kids[0].text().as_ref(), a.kids[1].text().as_ref()), ("onetwothreefourfivesix", "twothree", "five"));
        assert_eq!(a.own, "onefoursix", "an element holds only the text that stands in it");
        assert_eq!(xml("<a> x &amp; <![CDATA[<y>]]> &#65;&bogus; &</a>").unwrap().kids[0].text(), " x & <y> A&bogus; &");
        // a doctype is passed over with what it holds, and does not take what follows it
        let doc = xml("<!DOCTYPE gpx [ <!ENTITY a \"b\"> ]><!DOCTYPE x><gpx><desc><![CDATA[[x]]]></desc></gpx>").unwrap();
        assert_eq!(doc.kids[0].text(), "[x]");
        // 80 KB of elements each inside the last, a word in each: once every word was copied into every element round it
        let nested = "<a>x".repeat(20_000);
        let t = std::time::Instant::now();
        assert_eq!(import("gpx", &nested).unwrap_err(), "the file is nested too deeply");
        // deep and closed, with a long name at the bottom: refused before it is built
        let deep = format!("{}<name>{}</name>{}", "<a>".repeat(500), "n".repeat(1_000_000), "</a>".repeat(500));
        assert_eq!(import("gpx", &deep).unwrap_err(), "the file is nested too deeply");
        // 200,000 deep, which once ran the walk out of stack
        let deeper = format!("{}{}", "<a>".repeat(200_000), "</a>".repeat(200_000));
        assert_eq!(import("kml", &deeper).unwrap_err(), "the file is nested too deeply");
        assert!(t.elapsed().as_millis() < 5000, "{:?}", t.elapsed());
        // as deep as is allowed is read, and one deeper is not
        let at = |n: usize| format!("{}<wpt lat=\"1\" lon=\"2\"/>{}", "<a>".repeat(n), "</a>".repeat(n));
        assert_eq!(import("gpx", &at(MAX_DEPTH - 1)).unwrap().features.len(), 1);
        assert_eq!(import("gpx", &at(MAX_DEPTH)).unwrap().features.len(), 1, "an element with nothing in it opens nothing");
        assert_eq!(import("gpx", &at(MAX_DEPTH + 1)).unwrap_err(), "the file is nested too deeply");
        // a long text with many references and many declarations is read once through
        let busy = format!("<a>{}{}</a>", "&".repeat(200_000), "<!x>".repeat(100_000));
        let t = std::time::Instant::now();
        assert_eq!(xml(&busy).unwrap().kids[0].text().len(), 200_000);
        assert!(t.elapsed().as_millis() < 5000, "{:?}", t.elapsed());
    }

    #[test]
    fn an_element_in_another_of_its_name_is_not_counted_again() {
        // tracks in tracks and segments in segments: each point is one point, not one for each element round it
        let pts = "<trkpt lat=\"1\" lon=\"2\"/><trkpt lat=\"3\" lon=\"4\"/>";
        let nested = format!("<gpx>{}{pts}{}</gpx>", "<trk><name>n</name><trkseg>".repeat(100), "</trkseg></trk>".repeat(100));
        let got = import("gpx", &nested).unwrap().features;
        assert_eq!(got.len(), 1);
        assert_eq!(serde_json::to_string(&got[0]["geometry"]).unwrap(), r#"{"type":"LineString","coordinates":[[2.0,1.0],[4.0,3.0]]}"#);
    }

    #[test]
    fn a_number_is_read_as_far_as_it_is_one_in_one_pass() {
        for (text, want) in [
            ("12", Some(12.0)), (" -1.5e2x", Some(-150.0)), ("+.5", Some(0.5)), ("5.", Some(5.0)), ("1e", Some(1.0)), ("1e+", Some(1.0)), ("1.2.3", Some(1.2)), ("1-2", Some(1.0)), ("1e5e6", Some(1e5)), ("1.e2", Some(100.0)),
            ("", None), ("x", None), (".", None), ("-", None), ("--1", None), (".e5", None), ("e5", None), ("1e999", None), ("+-1", None),
        ] {
            assert_eq!(parse_float(text), want, "{text:?}");
        }
        // a numeral of a million figures that is not a number until its last: once each shorter one was tried in turn
        let long = format!("{}e", "1".repeat(1_000_000));
        let t = std::time::Instant::now();
        assert_eq!(parse_float(&long), None, "too large to be a number lattice keeps");
        assert_eq!(parse_float(&format!("0.{}e", "1".repeat(1_000_000))).map(|v| (v * 1e6).round()), Some(111_111.0));
        assert_eq!(parse_float(&"-".repeat(1_000_000)), None);
        assert!(t.elapsed().as_millis() < 5000, "{:?}", t.elapsed());
    }

    #[test]
    fn a_sawtooth_track_is_thinned_in_bounded_work_and_never_drawn_down_to_a_line() {
        // 20,000 positions up and down: the farthest is always the next one, which once made every pass the line squared
        for teeth in [5.0, 0.01] {
            let saw: Vec<String> = (0..20_000).map(|i| format!("[{},{}]", i as f64 / 1000.0, (i % 2) as f64 * teeth)).collect();
            let t = std::time::Instant::now();
            let got = import("geojson", &format!(r#"{{"type":"LineString","coordinates":[{}]}}"#, saw.join(","))).unwrap();
            assert!(t.elapsed().as_millis() < 5000, "{:?}", t.elapsed());
            let line = got.features[0]["geometry"]["coordinates"].as_array().unwrap();
            assert_eq!((xy(&line[0]), xy(&line[line.len() - 1])), ([0.0, 0.0], [19.999, teeth]), "the ends are kept");
            // the work ran out: it is thinned evenly, with its teeth, and not made a line of two positions
            assert_eq!((got.before, got.after, line.len()), (20_000, SIMPLIFY_TO, SIMPLIFY_TO));
            assert!(line.iter().any(|p| xy(p)[1] == teeth) && line.iter().any(|p| xy(p)[1] == 0.0));
            assert!(line.windows(2).all(|w| xy(&w[0])[0] < xy(&w[1])[0]));
        }
    }

    /// Douglas-Peucker as it is written down: the farthest position from the line between two ends is kept, and each side of it done the same way.
    fn plain_dp(pts: &[[f64; 2]], of: &[usize], tol: f64, keep: &mut Vec<usize>) {
        let (a, b) = (pts[of[0]], pts[of[of.len() - 1]]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = dx * dx + dy * dy;
        let (mut far, mut fd) = (None, tol * tol);
        for (n, i) in of.iter().enumerate().take(of.len() - 1).skip(1) {
            let p = pts[*i];
            let u = if len == 0.0 { 0.0 } else { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len).clamp(0.0, 1.0) };
            let d = (a[0] + u * dx - p[0]).powi(2) + (a[1] + u * dy - p[1]).powi(2);
            if d > fd {
                (fd, far) = (d, Some(n));
            }
        }
        if let Some(f) = far {
            plain_dp(pts, &of[..=f], tol, keep);
            keep.push(of[f]);
            plain_dp(pts, &of[f..], tol, keep);
        }
    }

    /// A line simplified as it was before the work was bounded: the tolerance doubled until it fits.
    fn plain_simplify(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for q in pts {
            for i in 0..2 {
                (lo[i], hi[i]) = (lo[i].min(q[i]), hi[i].max(q[i]));
            }
        }
        let mut tol = ((hi[0] - lo[0]).hypot(hi[1] - lo[1]) * 1e-4).max(0.00001);
        let mut out: Vec<usize> = (0..pts.len()).collect();
        while out.len() > SIMPLIFY_TO && tol < 1.0 {
            // each position nearer than the tolerance to the last one kept is dropped first
            let (mut near, mut last) = (vec![0], pts[0]);
            for (i, q) in pts.iter().enumerate().take(pts.len() - 1).skip(1) {
                if (q[0] - last[0]).powi(2) + (q[1] - last[1]).powi(2) > tol * tol {
                    near.push(i);
                    last = *q;
                }
            }
            near.push(pts.len() - 1);
            out = vec![near[0]];
            if near.len() > 2 {
                plain_dp(pts, &near, tol, &mut out);
            }
            out.push(near[near.len() - 1]);
            tol *= 2.0;
        }
        out.into_iter().map(|i| pts[i]).collect()
    }

    #[test]
    fn a_track_is_simplified_just_as_douglas_peucker_simplifies_it() {
        let mut seed = 9u64;
        let mut rand = || {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut tracks: Vec<Vec<[f64; 2]>> = Vec::new();
        // the two a review found: 100 passes back and forth of 60 positions each, and a zigzag of 502
        tracks.push((0..6000).map(|i| [if (i / 60) % 2 == 0 { (i % 60) as f64 } else { 59.0 - (i % 60) as f64 } * 0.0005, (i / 60) as f64 * 0.0001]).collect());
        tracks.push((0..502).map(|i| [i as f64 * 0.001, (i % 2) as f64 * 0.01]).collect());
        // and some hundreds of made ones: wandering walks, walks with long straights, loops, and teeth of every height
        for n in 0..300 {
            // teeth cost the most to simplify, so those lines are shorter
            let kind = if n % 12 == 3 { 3 } else { n % 3 };
            let len = 501 + (rand() * if kind == 3 { 500.0 } else { 2500.0 }) as usize;
            let (mut at, mut turn, mut heading) = ([rand() * 10.0, rand() * 10.0], 0.0, rand() * 6.28);
            let (step, wobble, teeth) = (10f64.powf(-5.0 + rand() * 3.0), rand() * rand(), 10f64.powf(-4.0 + rand() * 4.0));
            tracks.push(
                (0..len)
                    .map(|i| {
                        match kind {
                            0 => heading += (rand() - 0.5) * wobble * 6.0,
                            1 if i % 97 == 0 => heading += (rand() - 0.5) * 3.0,
                            2 => {
                                turn += (rand() - 0.5) * 0.01;
                                heading += turn;
                            }
                            3 => return [i as f64 * step, if i % (2 + n % 5) == 0 { teeth } else { 0.0 } + rand() * step],
                            _ => {}
                        }
                        at = [at[0] + heading.cos() * step, at[1] + heading.sin() * step];
                        // a walk now and then stands still
                        if rand() < 0.02 { [at[0], at[1]] } else { [at[0] + rand() * step * 0.1, at[1]] }
                    })
                    .collect(),
            );
        }
        let (mut fewer, mut same_count) = (0, 0);
        for (n, pts) in tracks.iter().enumerate() {
            let line: Vec<Value> = pts.iter().map(|p| json!(p)).collect();
            let got: Vec<[f64; 2]> = simplify(&line).iter().map(xy).collect();
            let want = plain_simplify(pts);
            assert_eq!(got, want, "track {n} of {} positions", pts.len());
            fewer += usize::from(got.len() < pts.len());
            same_count += usize::from(got.len() <= SIMPLIFY_TO);
        }
        assert!(fewer > 250 && same_count > 100, "{fewer} simplified, {same_count} to fit");
        // the zigzag is left as it is but for what the first tolerance takes, and is not made a straight line
        let zigzag: Vec<Value> = tracks[1].iter().map(|p| json!(p)).collect();
        assert!(simplify(&zigzag).len() > 400);
    }
}
