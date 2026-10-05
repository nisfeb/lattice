//! The in-memory ship the mount tests flush to: every page, folder and
//! mutation, so a test can assert what actually reached the ship rather than
//! what the mount reported. Shared by mount.rs and fsx.rs.
#![allow(dead_code)] // each test binary uses its own subset

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use lattice_fs::projection::{Dump, Node, PErr, Projection};

/// The ship, in memory. Records every mutation so the test can assert what
/// actually reached it, not merely what the mount reported.
#[derive(Default)]
pub struct Ship {
    pub pages: Mutex<HashMap<String, (String, Vec<u8>)>>, // rel -> (kind, body)
    pub dirs: Mutex<Vec<String>>,
    pub log: Mutex<Vec<String>>,
    pub dumps: AtomicUsize,
}

impl Ship {
    pub fn with(pages: &[(&str, &str, &str)], dirs: &[&str]) -> Arc<Self> {
        let s = Ship::default();
        for (rel, kind, body) in pages {
            s.pages
                .lock()
                .unwrap()
                .insert(rel.to_string(), (kind.to_string(), body.as_bytes().to_vec()));
        }
        *s.dirs.lock().unwrap() = dirs.iter().map(|d| d.to_string()).collect();
        Arc::new(s)
    }
    pub fn body(&self, rel: &str) -> Option<Vec<u8>> {
        self.pages.lock().unwrap().get(rel).map(|(_, b)| b.clone())
    }
    pub fn has(&self, rel: &str) -> bool {
        self.pages.lock().unwrap().contains_key(rel)
    }
    pub fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
    pub fn note(&self, s: String) {
        self.log.lock().unwrap().push(s);
    }
}

impl Projection for Ship {
    fn ship(&self) -> String {
        "~test".into()
    }
    fn list(&self) -> Result<Vec<Node>, PErr> {
        Ok(self.dump()?.0)
    }
    fn read(&self, rel: &str) -> Result<Vec<u8>, PErr> {
        self.body(rel).ok_or_else(|| PErr::new(libc::ENOENT, "no such page"))
    }
    fn dump(&self) -> Result<Dump, PErr> {
        self.dumps.fetch_add(1, Ordering::SeqCst);
        let pages = self.pages.lock().unwrap();
        let mut nodes: Vec<Node> = self
            .dirs
            .lock()
            .unwrap()
            .iter()
            .map(|d| Node {
                rel: d.clone(),
                is_dir: true,
                is_page: false,
                kind: String::new(),
                size: 0,
                mtime: 1_780_000_000,
                readonly: false,
                rev: None,
            })
            .collect();
        let mut bodies = HashMap::new();
        for (rel, (kind, body)) in pages.iter() {
            nodes.push(Node {
                rel: rel.clone(),
                is_dir: false,
                is_page: true,
                kind: kind.clone(),
                size: body.len() as u64,
                mtime: 1_780_000_000,
                readonly: false,
                rev: None,
            });
            bodies.insert(rel.clone(), body.clone());
        }
        Ok((nodes, bodies))
    }
    fn errors(&self, _rel: &str) -> Result<String, PErr> {
        Ok(String::new())
    }
    fn write(&self, rel: &str, kind: &str, data: &[u8], create: bool) -> Result<(), PErr> {
        self.note(format!("write {rel} {kind} new={create} {}", data.len()));
        if create && self.has(rel) {
            return Err(PErr::new(libc::EEXIST, "page exists")); // page-save new=1 409s
        }
        self.pages
            .lock()
            .unwrap()
            .insert(rel.to_string(), (kind.to_string(), data.to_vec()));
        Ok(())
    }
    fn mkdir(&self, rel: &str) -> Result<(), PErr> {
        self.note(format!("mkdir {rel}"));
        self.dirs.lock().unwrap().push(rel.to_string());
        Ok(())
    }
    fn delete(&self, rel: &str) -> Result<(), PErr> {
        self.note(format!("delete {rel}"));
        self.pages.lock().unwrap().remove(rel);
        self.dirs.lock().unwrap().retain(|d| d != rel);
        Ok(())
    }
    fn mv(&self, src: &str, dst: &str) -> Result<(), PErr> {
        self.note(format!("mv {src} {dst}"));
        let v = self.pages.lock().unwrap().remove(src);
        if let Some(v) = v {
            self.pages.lock().unwrap().insert(dst.to_string(), v);
        }
        Ok(())
    }
    fn watch(&self, _on_event: &(dyn Fn(lattice_fs::transport::WatchEvent) + Send + Sync)) {}
}
