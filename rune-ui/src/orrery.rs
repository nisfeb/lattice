//! Orrery integration, matching `code/nex/lattice/ui-app/orrery.js`:
//! checks whether `/apps/orrery` is installed on this ship, queries or
//! sends a page to `/apps/orrery/api/follow`, extracts lattice-internal
//! links from page text, and parses `/apps/orrery/api/body/<kind>/<slug>`
//! facts for the reader banner.

use serde_json::Value;

/// Privacy disclosure shown on hover over "Send to orrery" / "Send again".
pub const TIP: &str = "Orrery reads this page with its model: the text leaves your ship for the model orrery is configured with, and for nothing else.";

/// Status of a page in orrery (`GET /apps/orrery/api/follow?path=...`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Status {
    #[default]
    None,
    Queued,
    Following {
        situation: String,
        title: String,
        open: u64,
    },
    Resolved {
        outcome: String,
    },
    Failed {
        note: String,
    },
}

impl Status {
    pub fn is_queued(&self) -> bool {
        matches!(self, Status::Queued)
    }

    /// Relative URL on the ship for a followed situation, if any.
    pub fn situation_href(&self) -> Option<String> {
        match self {
            Status::Following { situation, .. } => Some(format!("/apps/orrery/#body/{situation}")),
            _ => None,
        }
    }

    /// Human-readable status line matching `orrery.js` `draw()`.
    pub fn summary(&self) -> Option<String> {
        match self {
            Status::None => None,
            Status::Queued => Some("orrery is reading\u{2026}".into()),
            Status::Following { title, open, .. } => {
                let t = if title.is_empty() { "untitled" } else { title.as_str() };
                Some(format!("followed by orrery \u{b7} {t} \u{b7} {open} open"))
            }
            Status::Resolved { outcome } => Some(format!("resolved by orrery: {outcome}")),
            Status::Failed { note } => {
                let n = if note.is_empty() { "orrery could not read it" } else { note.as_str() };
                Some(n.to_owned())
            }
        }
    }
}

/// Live body facts returned by `GET /apps/orrery/api/body/<kind>/<slug>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BodyFacts {
    pub name: String,
    pub rows: Vec<String>,
    pub actions: Vec<String>,
}

/// Parses the JSON answered by `GET /apps/orrery/api/follow?path=...`.
pub fn parse_status(v: &Value) -> Status {
    match v.get("status").and_then(Value::as_str).unwrap_or("none") {
        "queued" => Status::Queued,
        "following" => Status::Following {
            situation: v.get("situation").and_then(Value::as_str).unwrap_or("").to_owned(),
            title: v.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
            open: v.get("open").and_then(Value::as_u64).unwrap_or(0),
        },
        "resolved" => Status::Resolved {
            outcome: v.get("outcome").and_then(Value::as_str).unwrap_or("").to_owned(),
        },
        "failed" => Status::Failed {
            note: v.get("note").and_then(Value::as_str).unwrap_or("").to_owned(),
        },
        _ => Status::None,
    }
}

/// Whether `path` has the `<kind>/<slug>` two-segment shape of an orrery body.
pub fn is_body_path(path: &str) -> bool {
    let mut parts = path.split('/');
    let (Some(a), Some(b), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !a.is_empty() && !b.is_empty()
}

fn val_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Parses `GET /apps/orrery/api/body/<kind>/<slug>` JSON into a compact banner,
/// matching `orrery.js` `facts()` (up to 5 attr rows, up to 5 open actions).
pub fn parse_facts(v: &Value) -> Option<BodyFacts> {
    let obj = v.as_object()?;
    let name = obj.get("name").filter(|x| !x.is_null()).map(val_text).unwrap_or_default();
    let mut rows = Vec::new();
    if let Some(at) = obj.get("attrs").and_then(Value::as_object) {
        for (k, raw) in at {
            let items: Vec<&Value> = match raw {
                Value::Array(arr) => arr.iter().collect(),
                other => vec![other],
            };
            let mut vals = Vec::new();
            for item in items {
                let inner = item.as_object().and_then(|o| o.get("value")).unwrap_or(item);
                if inner.is_null() {
                    continue;
                }
                let s = val_text(inner);
                if !s.is_empty() {
                    vals.push(s);
                }
            }
            if !vals.is_empty() {
                rows.push(format!("{k}: {}", vals.join(", ")));
            }
            if rows.len() >= 5 {
                break;
            }
        }
    }
    let mut actions = Vec::new();
    if let Some(acts) = obj.get("actions").and_then(Value::as_array) {
        for a in acts {
            let status = a.get("status").and_then(Value::as_str).unwrap_or("");
            if !matches!(status, "proposed" | "approved" | "claimed") {
                continue;
            }
            if let Some(title) = a.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                actions.push(title.to_owned());
                if actions.len() >= 5 {
                    break;
                }
            }
        }
    }
    if name.is_empty() && rows.is_empty() && actions.is_empty() {
        return None;
    }
    Some(BodyFacts { name, rows, actions })
}

/// Next poll delay in seconds while status is `Queued`: every 3 s for a minute
/// (20 polls), then every 30 s for half an hour (up to 78 polls total).
pub fn poll_delay_secs(polls: u32) -> Option<u64> {
    if polls < 20 {
        Some(3)
    } else if polls < 78 {
        Some(30)
    } else {
        None
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push(((hi << 4) | lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn push_link(out: &mut Vec<String>, raw: &str, self_path: &str) {
    let p = raw.trim().trim_start_matches('/');
    if !p.is_empty() && p != self_path && !out.iter().any(|x| x == p) {
        out.push(p.to_owned());
    }
}

/// Extracts lattice-internal links from page text in order, deduplicated,
/// matching `orrery.js` `links(text, self)`:
/// - `[[name]]` and `[[name|label]]`
/// - `/apps/lattice/app?...name=<path>`
/// - `/apps/lattice/f/<path>`
pub fn links(text: &str, self_path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut i = 0;
    let is_url_stop = |c: u8| matches!(c, b'"' | b'\'' | b')' | b'<' | b'>' | b'#' | b' ' | b'\t' | b'\n' | b'\r');
    while i < b.len() {
        if text[i..].starts_with("[[") {
            let start = i + 2;
            if let Some(rel_end) = text[start..].find("]]") {
                let inner = &text[start..start + rel_end];
                if !inner.contains('[') && !inner.contains(']') {
                    let target = inner.split('|').next().unwrap_or("");
                    push_link(&mut out, target, self_path);
                    i = start + rel_end + 2;
                    continue;
                }
            }
            i += 2;
            continue;
        }
        if text[i..].starts_with("/apps/lattice/app?") {
            let start = i + "/apps/lattice/app?".len();
            let mut end = start;
            while end < b.len() && !is_url_stop(b[end]) {
                end += 1;
            }
            let query = &text[start..end];
            for part in query.split('&') {
                if let Some(val) = part.strip_prefix("name=") {
                    if let Some(dec) = percent_decode(val) {
                        push_link(&mut out, &dec, self_path);
                    }
                    break;
                }
            }
            i = end;
            continue;
        }
        if text[i..].starts_with("/apps/lattice/f/") {
            let start = i + "/apps/lattice/f/".len();
            let mut end = start;
            while end < b.len() && !is_url_stop(b[end]) && b[end] != b'?' {
                end += 1;
            }
            if let Some(dec) = percent_decode(&text[start..end]) {
                push_link(&mut out, &dec, self_path);
            }
            i = end;
            continue;
        }
        i += 1;
        while i < b.len() && !text.is_char_boundary(i) {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn links_match_web_orrery_rules() {
        let md = "See [[notes/plan]] and [[notes/plan|the plan]] and [[self]] and [[ /leading/slash ]].\n\
                  Also [app](/apps/lattice/app?foo=1&name=dir%2Fsub&bar=2) and ![img](/apps/lattice/f/assets/pic%201.png?v=1).\n\
                  Bad pct: /apps/lattice/f/bad%ZZ.png";
        assert_eq!(links(md, "self"), vec!["notes/plan", "leading/slash", "dir/sub", "assets/pic 1.png"]);
    }

    #[test]
    fn parse_status_variants_and_summaries() {
        assert_eq!(parse_status(&json!({"status": "none"})), Status::None);
        assert_eq!(parse_status(&json!({"status": "queued"})).summary().as_deref(), Some("orrery is reading\u{2026}"));
        let f = parse_status(&json!({"status": "following", "situation": "sit/trip", "title": "Trip", "open": 2}));
        assert_eq!(f.situation_href().as_deref(), Some("/apps/orrery/#body/sit/trip"));
        assert_eq!(f.summary().as_deref(), Some("followed by orrery \u{b7} Trip \u{b7} 2 open"));
        assert_eq!(parse_status(&json!({"status": "resolved", "outcome": "booked"})).summary().as_deref(), Some("resolved by orrery: booked"));
        assert_eq!(parse_status(&json!({"status": "failed", "note": "model down"})).summary().as_deref(), Some("model down"));
    }

    #[test]
    fn parse_facts_extracts_name_attrs_and_open_actions() {
        let v = json!({
            "name": "Alice",
            "attrs": {
                "city": {"value": "Boston"},
                "tags": [{"value": "friend"}, {"value": "builder"}],
                "empty": ""
            },
            "actions": [
                {"title": "Call back", "status": "proposed"},
                {"title": "Already done", "status": "done"},
                {"title": "Send invite", "status": "approved"}
            ]
        });
        let f = parse_facts(&v).unwrap();
        assert_eq!(f.name, "Alice");
        assert!(f.rows.contains(&"city: Boston".to_owned()));
        assert!(f.rows.contains(&"tags: friend, builder".to_owned()));
        assert_eq!(f.actions, vec!["Call back", "Send invite"]);
        assert!(is_body_path("person/alice"));
        assert!(!is_body_path("justone"));
        assert!(!is_body_path("a/b/c"));
        assert!(!is_body_path("/a"));
    }

    #[test]
    fn poll_schedule_matches_web() {
        assert_eq!(poll_delay_secs(0), Some(3));
        assert_eq!(poll_delay_secs(19), Some(3));
        assert_eq!(poll_delay_secs(20), Some(30));
        assert_eq!(poll_delay_secs(77), Some(30));
        assert_eq!(poll_delay_secs(78), None);
    }
}
