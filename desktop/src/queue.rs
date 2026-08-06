//! The offline edit queue, on disk, keyed by ship.
//!
//! It used to live only in the webview's IndexedDB. Web storage is keyed by
//! ORIGIN, and the origin here is `http://127.0.0.1:<bridge port>`. Anything
//! that moved that port moved the storage with it, so a relaunch that could
//! not get the canonical port came up unable to see the edits queued minutes
//! earlier. They were still on disk, under an origin nothing would ask for
//! again. Reported, correctly, as lost work.
//!
//! So the durable copy lives here instead, under the app's own data dir and
//! keyed by the ship the edits belong to. A port change cannot reach it, an
//! upgrade cannot reach it, and a second window on a different origin sees
//! the same queue rather than a fresh empty one.
//!
//! ## The key is chosen once and then never recomputed
//!
//! A ship's @p is the right identity: the same ship reached at a new URL is
//! the same ship. But the @p is only knowable while the ship answers, and the
//! queue matters precisely when it does not. So the key is resolved the first
//! time it is needed, written into the config, and reused verbatim from then
//! on. A key that improved itself later would rename the directory out from
//! under the queue it was meant to protect, which is the original bug wearing
//! a different hat.
//!
//! ## Layout
//!
//! ```text
//! <app_data_dir>/queue/<key>/saves/<hex(name)>.json   one file per page
//! <app_data_dir>/queue/<key>/ops.json                 the ordered op log
//! ```
//!
//! Saves get a file each because they are keyed by page name and coalesce
//! naturally, and because two windows editing different pages then cannot
//! clobber one another. The name is hex-encoded rather than sanitised: a
//! record name arrives from the webview, and encoding removes traversal as a
//! category instead of trying to filter it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::config;

/// One queued structural op, with the sequence the client deletes it by.
#[derive(Serialize, Deserialize, Clone)]
pub struct Op {
    /// assigned here, monotonic within a queue. The client carries it back as
    /// `_k`, which is the same contract the IndexedDB path already used.
    pub seq: u64,
    #[serde(flatten)]
    pub rest: Value,
}

fn hex(name: &str) -> String {
    let mut s = String::with_capacity(name.len() * 2);
    for b in name.as_bytes() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// A filesystem-safe, stable directory name for a ship key. The key is either
/// an @p or a URL, and a URL has slashes and colons in it.
fn key_dir_name(key: &str) -> String {
    hex(key)
}

/// The key decision, with no app handle and no filesystem, so the invariant
/// that matters can actually be tested: ONCE A KEY IS SET IT NEVER CHANGES.
///
/// Returns the key, and whether the config needs writing back. A key that
/// improved itself later (URL today, @p once the ship answered) would rename
/// the queue directory out from under the edits it exists to protect. That is
/// the original data-loss bug wearing a different hat, so the first branch
/// here is deliberately unconditional.
pub fn resolve_key(cfg: &config::Config) -> (String, bool) {
    if !cfg.queue_key.is_empty() {
        return (cfg.queue_key.clone(), false);
    }
    if !cfg.ship.is_empty() {
        return (cfg.ship.clone(), true);
    }
    if !cfg.url.is_empty() {
        return (cfg.url.clone(), true);
    }
    // Nothing configured yet. Use a placeholder but do NOT freeze it, which is
    // the second half of the write flag. Freezing it meant a queue op before
    // any connect pinned the key to "unconfigured" forever, and connecting
    // later to a DIFFERENT ship would then share that queue: one ship's edits
    // replaying into another, which is the isolation this module promises.
    //
    // Edits queued with no ship configured are orphaned by this. They had no
    // destination to replay to in the first place.
    ("unconfigured".to_string(), false)
}

/// Resolve the queue key once and remember it.
pub fn queue_key(app: &AppHandle) -> String {
    let mut cfg = config::load(app);
    let (chosen, needs_write) = resolve_key(&cfg);
    if needs_write {
        cfg.queue_key = chosen.clone();
        let _ = config::save(app, &cfg);
    }
    chosen
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    Ok(base.join("queue").join(key_dir_name(&queue_key(app))))
}

fn saves_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = root(app)?.join("saves");
    std::fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
    Ok(d)
}

fn ops_path(app: &AppHandle) -> Result<PathBuf, String> {
    let d = root(app)?;
    std::fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
    Ok(d.join("ops.json"))
}

/// Write via a temp file and rename. A half-written record is a corrupt
/// backup of somebody's only copy, and rename is the one cheap way to make a
/// reader see either all of it or none.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn list_saves_at(dir: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    //  stable order so the client sees the same queue twice running
    files.sort();
    for f in files {
        if f.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(s) = std::fs::read_to_string(&f) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                out.push(v);
            }
            //  an unparseable record is skipped, not fatal. One bad file must
            //  not make the whole queue unreadable.
        }
    }
    out
}

pub fn put_save_at(dir: &Path, rec: &Value) -> Result<(), String> {
    let name = rec
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "queued record has no name".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let p = dir.join(format!("{}.json", hex(name)));
    let body = serde_json::to_vec(rec).map_err(|e| e.to_string())?;
    write_atomic(&p, &body)
}

pub fn get_save_at(dir: &Path, name: &str) -> Option<Value> {
    let p = dir.join(format!("{}.json", hex(name)));
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
}

pub fn del_save_at(dir: &Path, name: &str) -> Result<(), String> {
    let p = dir.join(format!("{}.json", hex(name)));
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        //  already gone is the desired state, not a failure
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("{}: {e}", p.display())),
    }
}

pub fn read_ops_at(path: &Path) -> Vec<Op> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Op>>(&s).ok())
        .unwrap_or_default()
}

/// ponytail: the op log is one file rewritten whole. Ops are user-driven and
/// rare (a delete, a rename), so the cost is nothing and the ordering is free.
/// Two windows queueing ops in the same instant could lose one; per-op files
/// with a sequence allocator is the upgrade if that ever stops being theory.
pub fn push_op_at(path: &Path, rest: Value) -> Result<u64, String> {
    let mut ops = read_ops_at(path);
    let seq = ops.iter().map(|o| o.seq).max().map_or(1, |m| m + 1);
    ops.push(Op { seq, rest });
    let body = serde_json::to_vec(&ops).map_err(|e| e.to_string())?;
    write_atomic(path, &body)?;
    Ok(seq)
}

pub fn del_op_at(path: &Path, seq: u64) -> Result<(), String> {
    let mut ops = read_ops_at(path);
    ops.retain(|o| o.seq != seq);
    let body = serde_json::to_vec(&ops).map_err(|e| e.to_string())?;
    write_atomic(path, &body)
}

//  ── the webview's view of all that ───────────────────────────────────────

#[tauri::command]
pub fn queue_list(app: AppHandle) -> Result<Vec<Value>, String> {
    Ok(list_saves_at(&saves_dir(app_ref(&app))?))
}

/// One record by name. openPage consults the queue as its TOP READ TIER, on
/// every open, so routing that through queue_list meant a readdir plus a
/// deserialise of every queued body just to answer a question about one page.
#[tauri::command]
pub fn queue_get(app: AppHandle, name: String) -> Result<Option<Value>, String> {
    Ok(get_save_at(&saves_dir(app_ref(&app))?, &name))
}

#[tauri::command]
pub fn queue_put(app: AppHandle, rec: Value) -> Result<(), String> {
    put_save_at(&saves_dir(app_ref(&app))?, &rec)
}

#[tauri::command]
pub fn queue_del(app: AppHandle, name: String) -> Result<(), String> {
    del_save_at(&saves_dir(app_ref(&app))?, &name)
}

#[tauri::command]
pub fn queue_ops(app: AppHandle) -> Result<Vec<Value>, String> {
    //  flattened back into the shape the client already replays: the record's
    //  own fields plus `_k`, the handle it deletes by
    Ok(read_ops_at(&ops_path(app_ref(&app))?)
        .into_iter()
        .map(|o| {
            let mut v = o.rest;
            if let Some(m) = v.as_object_mut() {
                m.insert("_k".into(), Value::from(o.seq));
            }
            v
        })
        .collect())
}

#[tauri::command]
pub fn queue_op_put(app: AppHandle, rec: Value) -> Result<u64, String> {
    push_op_at(&ops_path(app_ref(&app))?, rec)
}

#[tauri::command]
pub fn queue_op_del(app: AppHandle, seq: u64) -> Result<(), String> {
    del_op_at(&ops_path(app_ref(&app))?, seq)
}

fn app_ref(app: &AppHandle) -> &AppHandle {
    app
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "lattice-queue-{}-{tag}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn a_save_round_trips_by_name() {
        let d = tmp("rt");
        put_save_at(&d, &json!({"name": "notes/todo", "kind": "md", "body": "# hi"})).unwrap();
        let got = list_saves_at(&d);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["name"], "notes/todo");
        assert_eq!(got[0]["body"], "# hi");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn re_queueing_a_page_replaces_it_rather_than_piling_up() {
        let d = tmp("coalesce");
        put_save_at(&d, &json!({"name": "a", "body": "one"})).unwrap();
        put_save_at(&d, &json!({"name": "a", "body": "two"})).unwrap();
        let got = list_saves_at(&d);
        assert_eq!(got.len(), 1, "same page must coalesce, as it does in idb");
        assert_eq!(got[0]["body"], "two", "the newest body wins");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_name_cannot_escape_the_queue_directory() {
        // the record name comes from the webview, which renders ship-served
        // content. Encoding the name means traversal is not a thing to filter
        let d = tmp("traversal");
        for evil in ["../../etc/passwd", "/etc/passwd", "..", "a/../../b"] {
            put_save_at(&d, &json!({"name": evil, "body": "x"})).unwrap();
        }
        let mut n = 0;
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            n += 1;
            let p = e.path();
            assert_eq!(p.parent().unwrap(), d, "every file stayed put: {p:?}");
        }
        assert_eq!(n, 4, "four distinct names, four files");
        assert_eq!(list_saves_at(&d).len(), 4);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn unicode_and_awkward_names_survive() {
        let d = tmp("unicode");
        for name in ["日本/メモ", "a b/c d", "emoji ⚡", "quote\"and\\slash"] {
            put_save_at(&d, &json!({"name": name, "body": name})).unwrap();
        }
        let got = list_saves_at(&d);
        assert_eq!(got.len(), 4);
        for v in got {
            assert_eq!(v["name"], v["body"], "name round-tripped intact");
        }
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn one_record_can_be_fetched_without_reading_the_rest() {
        let d = tmp("get");
        put_save_at(&d, &json!({"name": "a/one", "body": "first"})).unwrap();
        put_save_at(&d, &json!({"name": "b/two", "body": "second"})).unwrap();
        assert_eq!(get_save_at(&d, "b/two").unwrap()["body"], "second");
        assert_eq!(get_save_at(&d, "a/one").unwrap()["body"], "first");
        assert!(get_save_at(&d, "never queued").is_none(), "a miss is None, not an error");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn deleting_is_idempotent() {
        let d = tmp("del");
        put_save_at(&d, &json!({"name": "gone", "body": "x"})).unwrap();
        del_save_at(&d, "gone").unwrap();
        del_save_at(&d, "gone").expect("deleting twice is not an error");
        del_save_at(&d, "never existed").expect("nor is deleting nothing");
        assert!(list_saves_at(&d).is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn one_unreadable_record_does_not_hide_the_rest() {
        // a queue that refuses to load because of one bad file is a queue that
        // lost everything, which is the outcome this whole module exists to
        // prevent
        let d = tmp("corrupt");
        put_save_at(&d, &json!({"name": "good", "body": "x"})).unwrap();
        std::fs::write(d.join("deadbeef.json"), b"{not json").unwrap();
        let got = list_saves_at(&d);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["name"], "good");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn ops_keep_their_order_and_delete_by_sequence() {
        let d = tmp("ops");
        let p = d.join("ops.json");
        let a = push_op_at(&p, json!({"op": "del", "name": "one"})).unwrap();
        let b = push_op_at(&p, json!({"op": "move", "from": "x", "to": "y"})).unwrap();
        let c = push_op_at(&p, json!({"op": "del", "name": "three"})).unwrap();
        assert!(a < b && b < c, "sequences are monotonic");
        let ops = read_ops_at(&p);
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[0].rest["name"], "one", "order is queue order");
        assert_eq!(ops[1].rest["to"], "y");
        del_op_at(&p, b).unwrap();
        let ops = read_ops_at(&p);
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].rest["name"], "one");
        assert_eq!(ops[1].rest["name"], "three", "the rest keep their order");
        //  and a new op still sorts after everything, never reusing a seq
        let d2 = push_op_at(&p, json!({"op": "del", "name": "four"})).unwrap();
        assert!(d2 > c, "sequences never go backwards after a delete");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_missing_op_log_reads_as_empty_not_an_error() {
        let d = tmp("noops");
        assert!(read_ops_at(&d.join("ops.json")).is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn two_ships_do_not_share_a_queue() {
        // the whole point of keying by ship: one ship's queued edits must
        // never replay into another
        let a = tmp("ship-a");
        let b = tmp("ship-b");
        put_save_at(&a, &json!({"name": "page", "body": "from ship a"})).unwrap();
        put_save_at(&b, &json!({"name": "page", "body": "from ship b"})).unwrap();
        assert_eq!(list_saves_at(&a)[0]["body"], "from ship a");
        assert_eq!(list_saves_at(&b)[0]["body"], "from ship b");
        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    /// A relaunch, end to end, with nothing mocked but the passage of time.
    /// This is the failure that was reported: edits queued, app closed, app
    /// reopened, edits gone. Nothing in the desktop path tested that the
    /// second launch could still see the first launch's work.
    #[test]
    fn a_relaunch_still_sees_the_edits_the_last_launch_queued() {
        let data = tmp("relaunch");
        let mut cfg = config::Config {
            url: "http://localhost:8080".into(),
            ship: "~ricsul-bilwyt".into(),
            ..Default::default()
        };

        //  launch one: resolve a key, queue some work
        let (k1, wrote) = resolve_key(&cfg);
        assert!(wrote, "the first launch decides the key");
        cfg.queue_key = k1.clone();
        let dir1 = data.join(key_dir_name(&k1)).join("saves");
        put_save_at(&dir1, &json!({"name": "notes/draft", "body": "half a paragraph"})).unwrap();
        push_op_at(&data.join(key_dir_name(&k1)).join("ops.json"),
                   json!({"op": "del", "name": "notes/old"})).unwrap();

        //  launch two: the bridge came up on a different port, so the webview
        //  is on a different ORIGIN. That used to be the end of the queue.
        let (k2, wrote2) = resolve_key(&cfg);
        assert!(!wrote2, "the key is already decided, nothing to rewrite");
        assert_eq!(k1, k2, "the same install resolves the same key");
        let dir2 = data.join(key_dir_name(&k2)).join("saves");
        let back = list_saves_at(&dir2);
        assert_eq!(back.len(), 1, "the queued edit survived the relaunch");
        assert_eq!(back[0]["body"], "half a paragraph");
        let ops = read_ops_at(&data.join(key_dir_name(&k2)).join("ops.json"));
        assert_eq!(ops.len(), 1, "and so did the queued op");
        assert_eq!(ops[0].rest["name"], "notes/old");

        std::fs::remove_dir_all(&data).ok();
    }

    #[test]
    fn learning_the_ship_later_does_not_move_the_queue() {
        // The tempting bug: connect for the first time AFTER queueing, learn
        // the @p, and "upgrade" the key. That renames the directory out from
        // under the edits, which is the original failure with a nicer cause.
        let data = tmp("upgrade");
        let mut cfg = config::Config { url: "http://localhost:8080".into(), ..Default::default() };
        let (k1, _) = resolve_key(&cfg);
        cfg.queue_key = k1.clone();
        let dir = data.join(key_dir_name(&k1)).join("saves");
        put_save_at(&dir, &json!({"name": "p", "body": "written before connecting"})).unwrap();

        //  now we learn the ship's name
        cfg.ship = "~ricsul-bilwyt".into();
        let (k2, wrote) = resolve_key(&cfg);
        assert_eq!(k1, k2, "a known @p must NOT retarget an existing queue");
        assert!(!wrote);
        assert_eq!(
            list_saves_at(&data.join(key_dir_name(&k2)).join("saves"))[0]["body"],
            "written before connecting"
        );
        std::fs::remove_dir_all(&data).ok();
    }

    #[test]
    fn the_placeholder_key_is_never_frozen() {
        // With nothing configured there is no identity to key on. The
        // placeholder must NOT be written back, because freezing it pinned the
        // key to "unconfigured" forever: connect later to one ship, then to a
        // different one, and both would share that queue. One ship's edits
        // replaying into another is the exact isolation this module promises.
        //
        // The cost is that edits queued before any connect are orphaned. They
        // had no ship to replay to in the first place.
        let cfg = config::Config::default();
        let (k, wrote) = resolve_key(&cfg);
        assert_eq!(k, "unconfigured");
        assert!(!wrote, "the placeholder must not be persisted");

        //  and once a ship IS known, that is what gets frozen
        let cfg2 = config::Config { ship: "~zod".into(), ..Default::default() };
        let (k2, wrote2) = resolve_key(&cfg2);
        assert_eq!(k2, "~zod");
        assert!(wrote2, "a real identity is worth remembering");
    }

    #[test]
    fn two_ships_cannot_meet_through_the_placeholder() {
        //  the failure the fix above prevents, stated directly
        let a = config::Config { ship: "~zod".into(), ..Default::default() };
        let b = config::Config { ship: "~ricsul-bilwyt".into(), ..Default::default() };
        let (ka, _) = resolve_key(&a);
        let (kb, _) = resolve_key(&b);
        assert_ne!(ka, "unconfigured");
        assert_ne!(kb, "unconfigured");
        assert_ne!(key_dir_name(&ka), key_dir_name(&kb));
    }

    #[test]
    fn two_installs_pointed_at_different_ships_never_share_a_directory() {
        let a = config::Config { ship: "~zod".into(), ..Default::default() };
        let b = config::Config { ship: "~ricsul-bilwyt".into(), ..Default::default() };
        let (ka, _) = resolve_key(&a);
        let (kb, _) = resolve_key(&b);
        assert_ne!(key_dir_name(&ka), key_dir_name(&kb));
    }

    #[test]
    fn key_dir_names_are_distinct_and_filesystem_safe() {
        let urls = ["~zod", "~sampel-palnet", "http://localhost:8080", "http://localhost:8081"];
        let mut seen = std::collections::HashSet::new();
        for u in urls {
            let d = key_dir_name(u);
            assert!(seen.insert(d.clone()), "keys must not collide: {u}");
            assert!(
                d.chars().all(|c| c.is_ascii_hexdigit()),
                "a key directory must be safe to join: {d}"
            );
        }
    }
}
