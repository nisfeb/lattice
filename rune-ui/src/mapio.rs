//! Files in and out of a map page: a port of the web client's
//! `ui-src/map/io.js`. Import reads GeoJSON and GPX into features, the
//! GPX as `@tmcw/togeojson` reads it, and simplifies long tracks. Export
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

/// An element of an XML file: its name as written, its attributes, the
/// elements in it, and all the text in it and under it.
#[derive(Debug, Default)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub kids: Vec<Node>,
    pub text: String,
}

impl Node {
    /// Every element under this one with this name, in the file's order.
    pub fn all<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        for k in &self.kids {
            if k.name == name {
                out.push(k);
            }
            k.all(name, out);
        }
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
        let end = rest.find(';').filter(|e| *e <= 10);
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
/// instructions and the doctype are passed over. `None` for a file that
/// is not well formed.
// ponytail: no namespaces, no DTD entities. GPX and KML need neither
pub fn xml(src: &str) -> Option<Node> {
    let mut stack = vec![Node::default()];
    let mut rest = src.trim_start_matches('\u{feff}');
    let say = |stack: &mut Vec<Node>, t: &str| stack.iter_mut().for_each(|n| n.text.push_str(t));
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            say(&mut stack, &unescape(rest));
            break;
        };
        say(&mut stack, &unescape(&rest[..lt]));
        rest = &rest[lt..];
        if let Some(r) = rest.strip_prefix("<!--") {
            rest = &r[r.find("-->")? + 3..];
        } else if let Some(r) = rest.strip_prefix("<![CDATA[") {
            let end = r.find("]]>")?;
            say(&mut stack, &r[..end]);
            rest = &r[end + 3..];
        } else if let Some(r) = rest.strip_prefix("<?") {
            rest = &r[r.find("?>")? + 2..];
        } else if rest.starts_with("<!") {
            // a doctype, with whatever it holds in square brackets
            let end = rest.find(']').filter(|b| rest[..*b].contains('[')).map_or(0, |b| b);
            rest = &rest[end + rest[end..].find('>')? + 1..];
        } else if let Some(r) = rest.strip_prefix("</") {
            let end = r.find('>')?;
            let done = stack.pop()?;
            if done.name != r[..end].trim() || stack.is_empty() {
                return None;
            }
            stack.last_mut()?.kids.push(done);
            rest = &r[end + 1..];
        } else {
            // a tag ends at the first > outside a quoted value
            let mut quote = None;
            let end = rest.char_indices().find(|(_, c)| match quote {
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
            })?.0;
            let tag = rest[1..end].trim_end();
            let (tag, empty) = tag.strip_suffix('/').map_or((tag, false), |t| (t, true));
            let name_end = tag.find(char::is_whitespace).unwrap_or(tag.len());
            let mut node = Node { name: tag[..name_end].to_owned(), ..Node::default() };
            if node.name.is_empty() {
                return None;
            }
            let mut a = tag[name_end..].trim_start();
            while !a.is_empty() {
                let (key, after) = a.split_once('=')?;
                let after = after.trim_start();
                let q = after.chars().next().filter(|c| *c == '"' || *c == '\'')?;
                let close = after[1..].find(q)?;
                node.attrs.push((key.trim().to_owned(), unescape(&after[1..1 + close])));
                a = after[close + 2..].trim_start();
            }
            if empty {
                stack.last_mut()?.kids.push(node);
            } else {
                stack.push(node);
            }
            rest = &rest[end + 1..];
        }
    }
    // everything opened was closed, and there was an element at all
    (stack.len() == 1).then(|| stack.pop()).flatten().filter(|root| !root.kids.is_empty())
}

/// A number as JavaScript's `parseFloat` reads one: from the start of
/// the text, as far as it is a number.
fn parse_float(s: &str) -> Option<f64> {
    let s = s.trim_start();
    let run = s.find(|c: char| !(c.is_ascii_digit() || "+-.eE".contains(c))).unwrap_or(s.len());
    (1..=run).rev().find_map(|end| s[..end].parse::<f64>().ok()).filter(|v| v.is_finite())
}

/// The text of the first element under `n` with this name, when it has any.
fn said<'a>(n: &'a Node, name: &str) -> Option<&'a str> {
    n.first(name).map(|e| e.text.as_str()).filter(|t| !t.is_empty())
}

/// A GPX point: its position, with its height when it has one, and its time.
fn gpx_point(n: &Node) -> Option<(Value, Option<&str>)> {
    let (lon, lat) = (parse_float(n.attr("lon"))?, parse_float(n.attr("lat"))?);
    let mut c = vec![json!(lon), json!(lat)];
    c.extend(n.first("ele").and_then(|e| parse_float(&e.text)).map(Value::from));
    Some((Value::Array(c), n.first("time").map(|t| t.text.as_str()).filter(|t| !t.is_empty())))
}

/// The points of a track segment or a route as a line, with the first
/// time among them. Fewer than two points is no line.
fn gpx_line<'a>(n: &'a Node, each: &str) -> Option<(Vec<Value>, Option<&'a str>)> {
    let pts: Vec<_> = n.each(each).into_iter().filter_map(gpx_point).collect();
    (pts.len() >= 2).then(|| (pts.iter().map(|(c, _)| c.clone()).collect(), pts.iter().find_map(|(_, t)| *t)))
}

/// What lattice keeps of a GPX element: its name, its description as the
/// note, its time, and its type as the kind.
fn gpx_props(n: &Node, time: Option<&str>) -> Value {
    let mut p = serde_json::Map::new();
    let mut put = |k: &str, v: Option<&str>| drop(v.map(|v| p.insert(k.into(), v.into())));
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
        let time = segs.iter().find_map(|(_, t)| *t);
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

fn xy(p: &Value) -> [f64; 2] {
    [p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)]
}

/// Each position nearer than `tol` to the last one kept is dropped, the
/// two ends always kept: one pass, so `dp` then works on far fewer.
fn radial(pts: &[Value], tol: f64) -> Vec<Value> {
    let mut out = vec![pts[0].clone()];
    let mut last = xy(&pts[0]);
    for p in &pts[1..pts.len() - 1] {
        let q = xy(p);
        if (q[0] - last[0]).powi(2) + (q[1] - last[1]).powi(2) > tol * tol {
            out.push(p.clone());
            last = q;
        }
    }
    out.push(pts[pts.len() - 1].clone());
    out
}

/// Douglas-Peucker, without recursion so a long track cannot overflow
/// the stack. The first and last positions are kept.
fn dp(pts: &[Value], tol: f64) -> Vec<Value> {
    let n = pts.len();
    if n < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; n];
    (keep[0], keep[n - 1]) = (true, true);
    let mut stack = vec![(0, n - 1)];
    while let Some((a, b)) = stack.pop() {
        let ([ax, ay], [bx, by]) = (xy(&pts[a]), xy(&pts[b]));
        let (dx, dy) = (bx - ax, by - ay);
        let len = dx * dx + dy * dy;
        let (mut far, mut fd) = (None, tol * tol);
        for (i, p) in pts.iter().enumerate().take(b).skip(a + 1) {
            let [px, py] = xy(p);
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
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| p.clone()).collect()
}

/// A line of more than `SIMPLIFY_TO` positions, simplified until it
/// fits. The tolerance starts at a ten-thousandth of the line's extent
/// and doubles.
fn simplify(pts: &[Value]) -> Vec<Value> {
    if pts.len() <= SIMPLIFY_TO {
        return pts.to_vec();
    }
    let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
    for p in pts {
        let q = xy(p);
        for i in 0..2 {
            (lo[i], hi[i]) = (lo[i].min(q[i]), hi[i].max(q[i]));
        }
    }
    let mut tol = ((hi[0] - lo[0]).hypot(hi[1] - lo[1]) * 1e-4).max(0.00001);
    let mut out = pts.to_vec();
    while out.len() > SIMPLIFY_TO && tol < 1.0 {
        out = dp(&radial(pts, tol), tol);
        tol *= 2.0;
    }
    out
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
        "gpx" => gpx(&xml(text).ok_or("the file is not valid XML")?),
        _ => return Err("lattice reads .geojson, .json and .gpx files here".into()),
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
        assert_eq!(import("kml", "<kml/>").unwrap_err(), "lattice reads .geojson, .json and .gpx files here");
        assert_eq!((file_kind("a/Walk.GPX"), file_kind("x.json"), file_kind("x.geojson"), file_kind("x.kml"), file_kind("x.txt"), file_kind("gpx")), ("gpx", "geojson", "geojson", "kml", "", ""));
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
}
