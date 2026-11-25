//! Followed folders, matching `ui-src/lattice/69x-follow.js`:
//! peer folders followed from their index (`urb://~host/<folder>/`),
//! shown under "following" in the files tree after "shared with me",
//! with new-page badges, open-index link, unfollow, and `/beacon/folds`
//! event parsing.

use serde::Deserialize;

/// Root tree id for the followed-folders section. Leading space cannot
/// collide with any real page or folder path.
pub const ROOT: &str = " following";

/// Visible label of the root row.
pub const LABEL: &str = "following";

/// One page listed inside a followed folder (`/folder-follows`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct FoldPage {
    pub key: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub new: bool,
}

/// One followed folder returned by `GET /apps/lattice/folder-follows`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Fold {
    pub host: String,
    pub path: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub new: u64,
    #[serde(default)]
    pub pages: Vec<FoldPage>,
}

/// Parsed payload from `/beacon/folds`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FoldEvent {
    Stale { host: String, path: String },
    New { host: String, path: String, new: u64 },
    Other,
}

/// Display name of a followed folder: `~host/path`.
pub fn fold_name(f: &Fold) -> String {
    format!("{}{}", f.host, f.path)
}

/// `urb://` address of a page or folder inside a followed host.
pub fn fold_url(host: &str, path: &str) -> String {
    let p = if path.starts_with('/') { path.to_owned() } else { format!("/{path}") };
    format!("urb://{host}{p}")
}

/// `urb://` address of a followed folder's index (trailing slash).
pub fn index_url(f: &Fold) -> String {
    let base = fold_url(&f.host, &f.path);
    if base.ends_with('/') { base } else { format!("{base}/") }
}

/// Tree row id for a followed folder.
pub fn dir_id(f: &Fold) -> String {
    format!("{ROOT}/{}", fold_name(f))
}

/// Tree row id for a page inside a followed folder.
pub fn page_id(f: &Fold, key: &str) -> String {
    format!("{} >{key}", dir_id(f))
}

/// Whether `id` belongs to the followed-folders subtree.
pub fn is_ours(id: &str) -> bool {
    id == ROOT || id.strip_prefix(ROOT).is_some_and(|r| r.starts_with('/'))
}

/// Resolves a tree row id into the followed folder and, for a page row,
/// the page entry inside it.
pub fn at<'a>(list: &'a [Fold], id: &str) -> Option<(&'a Fold, Option<&'a FoldPage>)> {
    let rest = id.strip_prefix(ROOT)?.strip_prefix('/')?;
    let (entry, page_key) = match rest.split_once(" >") {
        Some((e, k)) => (e, Some(k)),
        None => (rest, None),
    };
    let fold = list.iter().find(|f| fold_name(f) == entry)?;
    match page_key {
        None => Some((fold, None)),
        Some(key) => fold.pages.iter().find(|p| p.key == key).map(|p| (fold, Some(p))),
    }
}

/// Label shown for a page inside a followed folder.
pub fn page_label(f: &Fold, p: &FoldPage) -> String {
    let t = p.title.trim();
    if !t.is_empty() {
        return t.to_owned();
    }
    let prefix = format!("{}/", f.path.trim_end_matches('/'));
    if let Some(rest) = p.key.strip_prefix(&prefix) {
        if !rest.is_empty() {
            return rest.to_owned();
        }
    }
    p.key.trim_start_matches('/').to_owned()
}

/// Total unread/new pages across all reachable followed folders.
pub fn total_new(list: &[Fold]) -> u64 {
    list.iter().filter(|f| f.ok).map(|f| f.new).sum()
}

/// Folders sorted case-insensitively by `~host/path`.
pub fn sorted(list: &[Fold]) -> Vec<&Fold> {
    let mut out: Vec<&Fold> = list.iter().collect();
    out.sort_by(|a, b| fold_name(a).to_lowercase().cmp(&fold_name(b).to_lowercase()));
    out
}

/// Extracts `(host, /path)` from an `urb://~ship/folder/` address if it points
/// to a non-root folder on another ship (eligible for Follow/Unfollow).
pub fn folder_target(url: &str, our_ship: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("urb://")?;
    let (host, tail) = rest.split_once('/')?;
    if !host.starts_with('~') || host == our_ship {
        return None;
    }
    let clean = tail.trim_matches('/');
    if clean.is_empty() {
        return None;
    }
    Some((host.to_owned(), format!("/{clean}")))
}

/// Whether `list` already follows `(host, path)`.
pub fn is_following(list: &[Fold], host: &str, path: &str) -> bool {
    let norm = path.trim_end_matches('/');
    list.iter().any(|f| f.host == host && f.path.trim_end_matches('/') == norm)
}

/// Marks a page seen locally and returns true if it was previously new.
pub fn mark_seen_local(list: &mut [Fold], host: &str, path: &str, key: &str) -> bool {
    let Some(f) = list.iter_mut().find(|f| f.host == host && f.path == path) else {
        return false;
    };
    let Some(p) = f.pages.iter_mut().find(|p| p.key == key) else {
        return false;
    };
    if !p.new {
        return false;
    }
    p.new = false;
    f.new = f.new.saturating_sub(1);
    true
}

/// Parses a `/beacon/folds` JSON event payload.
pub fn parse_beacon(data: &str) -> FoldEvent {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return FoldEvent::Other;
    };
    let op = v.get("op").and_then(|x| x.as_str()).unwrap_or("");
    let host = v.get("host").and_then(|x| x.as_str()).unwrap_or("").to_owned();
    let path = v.get("path").and_then(|x| x.as_str()).unwrap_or("").to_owned();
    match op {
        "stale" if !host.is_empty() && !path.is_empty() => FoldEvent::Stale { host, path },
        "new" if !host.is_empty() && !path.is_empty() => FoldEvent::New {
            host,
            path,
            new: v.get("new").and_then(|x| x.as_u64()).unwrap_or(0),
        },
        _ => FoldEvent::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<Fold> {
        vec![
            Fold {
                host: "~bus".into(),
                path: "/notes".into(),
                ok: true,
                new: 1,
                pages: vec![
                    FoldPage { key: "/notes/plan".into(), title: "Plan".into(), new: true },
                    FoldPage { key: "/notes/sub/raw".into(), title: String::new(), new: false },
                ],
            },
            Fold { host: "~nec".into(), path: "/logs".into(), ok: false, new: 3, pages: vec![] },
        ]
    }

    #[test]
    fn tree_ids_lookup_and_counts() {
        let mut list = sample();
        assert_eq!(total_new(&list), 1, "unreachable folders do not count toward new");
        let did = dir_id(&list[0]);
        let pid = page_id(&list[0], "/notes/plan");
        assert!(is_ours(ROOT) && is_ours(&did) && is_ours(&pid) && !is_ours("notes/plan"));
        assert_eq!(at(&list, &did).map(|(f, p)| (f.host.as_str(), p.is_some())), Some(("~bus", false)));
        assert_eq!(at(&list, &pid).map(|(f, p)| (f.host.as_str(), p.unwrap().key.as_str())), Some(("~bus", "/notes/plan")));
        assert_eq!(page_label(&list[0], &list[0].pages[0]), "Plan");
        assert_eq!(page_label(&list[0], &list[0].pages[1]), "sub/raw");
        assert_eq!(index_url(&list[0]), "urb://~bus/notes/");
        assert!(mark_seen_local(&mut list, "~bus", "/notes", "/notes/plan"));
        assert!(!mark_seen_local(&mut list, "~bus", "/notes", "/notes/plan"));
        assert_eq!(total_new(&list), 0);
    }

    #[test]
    fn folder_target_and_beacon_parsing() {
        assert_eq!(folder_target("urb://~bus/notes/", "~zod"), Some(("~bus".into(), "/notes".into())));
        assert_eq!(folder_target("urb://~zod/notes/", "~zod"), None, "own ship cannot be followed");
        assert_eq!(folder_target("urb://~bus/", "~zod"), None, "root has no folder path");
        assert!(is_following(&sample(), "~bus", "/notes/"));
        assert_eq!(
            parse_beacon(r#"{"op":"stale","host":"~bus","path":"/notes"}"#),
            FoldEvent::Stale { host: "~bus".into(), path: "/notes".into() }
        );
        assert_eq!(
            parse_beacon(r#"{"op":"new","host":"~bus","path":"/notes","new":2}"#),
            FoldEvent::New { host: "~bus".into(), path: "/notes".into(), new: 2 }
        );
        assert_eq!(parse_beacon("123"), FoldEvent::Other);
    }
}
