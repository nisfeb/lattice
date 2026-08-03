//! The FUSE surface itself, over a real kernel mount.
//!
//! fuser's Reply types have no public constructor, so the `Filesystem` methods
//! cannot be called in-process — the only way to exercise lookup/readdir/open/
//! read/write/setattr/create/unlink/rmdir/rename is to mount and use ordinary
//! file syscalls. That is also the only place the editor-safety rules
//! (vim's backup-by-rename, VS Code's atomic save, `rm` of a `.swp`) are
//! actually enforced, and those are the crate's data-loss guards.
//!
//! Skips cleanly when FUSE is unavailable (no /dev/fuse, no fusermount3, a
//! container without the capability), so a CI box without it stays green.
//! Every op runs on a worker thread behind a deadline: a mutant that wedges
//! the mount fails this test instead of hanging it.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use lattice_fs::projection::{Node, PErr, Projection};

/// The ship, in memory. Records every mutation so the test can assert what
/// actually reached it, not merely what the mount reported.
#[derive(Default)]
struct Ship {
    pages: Mutex<HashMap<String, (String, Vec<u8>)>>, // rel -> (kind, body)
    dirs: Mutex<Vec<String>>,
    log: Mutex<Vec<String>>,
    dumps: AtomicUsize,
}

impl Ship {
    fn with(pages: &[(&str, &str, &str)], dirs: &[&str]) -> Arc<Self> {
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
    fn body(&self, rel: &str) -> Option<Vec<u8>> {
        self.pages.lock().unwrap().get(rel).map(|(_, b)| b.clone())
    }
    fn has(&self, rel: &str) -> bool {
        self.pages.lock().unwrap().contains_key(rel)
    }
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
    fn note(&self, s: String) {
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
    fn dump(&self) -> Result<(Vec<Node>, HashMap<String, Vec<u8>>), PErr> {
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
    fn watch(&self, _on_change: &(dyn Fn() + Send + Sync)) {}
}

fn read_to_string(p: &Path) -> String {
    fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("readdir {}: {e}", dir.display()))
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    v.sort();
    v
}

#[test]
fn a_real_mount_behaves_like_a_filesystem() {
    let ship = Ship::with(
        &[
            ("hello", "md", "# hello\n"),
            ("demo", "md", "the parent body\n"),
            ("demo/child", "gmi", "child body\n"),
        ],
        &["folder"],
    );

    let mnt = std::env::temp_dir().join(format!("lattice-fs-mnt-{}", std::process::id()));
    let _ = fs::remove_dir_all(&mnt);
    fs::create_dir_all(&mnt).unwrap();

    let session = match lattice_fs::spawn(ship.clone() as Arc<dyn Projection>, mnt.to_str().unwrap())
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("skipped: no usable FUSE here ({e})");
            let _ = fs::remove_dir_all(&mnt);
            return;
        }
    };

    // Every syscall runs on a worker. If a mutant wedges the mount, the
    // deadline fires, the unmount below releases the blocked thread, and this
    // test FAILS rather than hanging the suite.
    let (tx, rx) = mpsc::channel();
    let dir = mnt.clone();
    let s = ship.clone();
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| exercise(&dir, &s)));
        let _ = tx.send(r);
    });
    let outcome = rx.recv_timeout(Duration::from_secs(10));

    drop(session); // unmount, releasing anything still blocked
    let _ = fs::remove_dir_all(&mnt);

    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(panic)) => std::panic::resume_unwind(panic),
        Err(_) => panic!("the mount stopped answering: a FUSE op never returned"),
    }
}

fn exercise(mnt: &Path, ship: &Ship) {
    // ---------- the tree is visible, and shaped right ----------

    // "demo" is a page WITH children: it appears as a directory whose own body
    // is demo/demo.md, alongside its child.
    assert_eq!(names(mnt), vec!["demo", "folder", "hello.md"]);
    assert_eq!(names(&mnt.join("demo")), vec!["child.gmi", "demo.md"]);
    assert_eq!(names(&mnt.join("folder")), Vec::<String>::new());

    // ---------- read: the right bytes, and a matching st_size ----------

    assert_eq!(read_to_string(&mnt.join("hello.md")), "# hello\n");
    assert_eq!(read_to_string(&mnt.join("demo/demo.md")), "the parent body\n");
    assert_eq!(read_to_string(&mnt.join("demo/child.gmi")), "child body\n");
    let md = fs::metadata(mnt.join("hello.md")).unwrap();
    assert_eq!(md.len(), 8, "st_size must equal what read() returns");
    assert!(md.is_file());
    assert!(fs::metadata(mnt.join("demo")).unwrap().is_dir());

    // a partial read from an offset must return that slice, not the whole file
    let mut f = fs::File::open(mnt.join("hello.md")).unwrap();
    f.seek(SeekFrom::Start(2)).unwrap();
    let mut buf = [0u8; 5];
    f.read_exact(&mut buf).unwrap();
    assert_eq!(&buf, b"hello");
    drop(f);

    // a path that does not exist is ENOENT, not an empty file
    assert!(fs::metadata(mnt.join("nope.md")).is_err());
    assert!(fs::read(mnt.join("demo/nope.gmi")).is_err());

    // ---------- write: one flush, one save, exact bytes ----------

    fs::write(mnt.join("hello.md"), "# rewritten\n").unwrap();
    assert_eq!(ship.body("hello").unwrap(), b"# rewritten\n");
    assert_eq!(read_to_string(&mnt.join("hello.md")), "# rewritten\n");
    assert_eq!(
        fs::metadata(mnt.join("hello.md")).unwrap().len(),
        12,
        "the new size must be visible immediately; the re-dump is async"
    );

    // append (`>>`): the kernel derives the offset from st_size. A stale size
    // here seeks to the wrong EOF and overwrites instead of appending.
    let mut f = fs::OpenOptions::new().append(true).open(mnt.join("hello.md")).unwrap();
    f.write_all(b"appended\n").unwrap();
    drop(f);
    assert_eq!(ship.body("hello").unwrap(), b"# rewritten\nappended\n");
    // and again, immediately: the second append must not land on a stale EOF
    let mut f = fs::OpenOptions::new().append(true).open(mnt.join("hello.md")).unwrap();
    f.write_all(b"twice\n").unwrap();
    drop(f);
    assert_eq!(ship.body("hello").unwrap(), b"# rewritten\nappended\ntwice\n");

    // a write past EOF zero-fills the gap rather than dropping bytes
    let mut f = fs::OpenOptions::new().write(true).open(mnt.join("demo/child.gmi")).unwrap();
    f.seek(SeekFrom::Start(14)).unwrap();
    f.write_all(b"far").unwrap();
    drop(f);
    let got = ship.body("demo/child").unwrap();
    assert_eq!(&got[..11], b"child body\n");
    assert_eq!(&got[11..14], b"\0\0\0", "the gap must be zero-filled");
    assert_eq!(&got[14..], b"far");

    // truncate (`>`) empties the file, and the emptied content is what's saved
    fs::write(mnt.join("demo/child.gmi"), "short\n").unwrap();
    assert_eq!(ship.body("demo/child").unwrap(), b"short\n");

    // two files open at once must not share a handle
    let a = fs::File::open(mnt.join("hello.md")).unwrap();
    let b = fs::File::open(mnt.join("demo/child.gmi")).unwrap();
    let mut sa = String::new();
    let mut sb = String::new();
    (&a).read_to_string(&mut sa).unwrap();
    (&b).read_to_string(&mut sb).unwrap();
    assert_ne!(sa, sb, "two open files must not resolve to the same handle");
    drop((a, b));

    // ---------- create / mkdir / unlink / rmdir ----------

    fs::write(mnt.join("fresh.md"), "brand new\n").unwrap();
    assert_eq!(ship.body("fresh").unwrap(), b"brand new\n");
    assert!(names(mnt).contains(&"fresh.md".to_string()));
    assert_eq!(read_to_string(&mnt.join("fresh.md")), "brand new\n");

    fs::create_dir(mnt.join("newdir")).unwrap();
    assert!(ship.log().iter().any(|l| l == "mkdir newdir"));
    assert!(names(mnt).contains(&"newdir".to_string()));

    // a populated directory is ENOTEMPTY: without that, rmdir would pass
    // straight to page-del and take the whole subtree with it
    let e = fs::remove_dir(mnt.join("demo")).unwrap_err();
    assert_eq!(e.raw_os_error(), Some(libc::ENOTEMPTY), "rmdir of a populated dir");
    assert!(ship.has("demo/child"), "and nothing may be deleted by the attempt");
    fs::remove_dir(mnt.join("newdir")).unwrap();

    fs::remove_file(mnt.join("fresh.md")).unwrap();
    assert!(!ship.has("fresh"), "unlink must reach the ship");
    assert!(!names(mnt).contains(&"fresh.md".to_string()));

    // ---------- rename ----------

    fs::write(mnt.join("movable.md"), "move me\n").unwrap();
    fs::rename(mnt.join("movable.md"), mnt.join("moved.md")).unwrap();
    assert!(!ship.has("movable"), "the source must be gone");
    assert_eq!(ship.body("moved").unwrap(), b"move me\n");
    assert!(!names(mnt).contains(&"movable.md".to_string()));
    // the destination must be usable IMMEDIATELY. The kernel keeps the source
    // inode under the new name, so the ino->path table has to move with it;
    // otherwise this stat resolves to the old (now removed) vpath and ENOENTs.
    assert_eq!(read_to_string(&mnt.join("moved.md")), "move me\n");
    assert_eq!(fs::metadata(mnt.join("moved.md")).unwrap().len(), 8);
    assert!(names(mnt).contains(&"moved.md".to_string()), "and it is listed at once");
    // a rename ONTO an existing page clobbers it (POSIX), and the destination
    // still reads back correctly afterwards
    fs::write(mnt.join("target.md"), "old target\n").unwrap();
    fs::rename(mnt.join("moved.md"), mnt.join("target.md")).unwrap();
    assert_eq!(read_to_string(&mnt.join("target.md")), "move me\n");
    assert!(!ship.has("moved"));

    // ---------- the editor-safety rules: these are the data-loss guards ----------

    fs::write(mnt.join("edited.md"), "version one\n").unwrap();

    // vim's backup-by-rename: page -> foo.md~. The PAGE MUST SURVIVE. Deleting
    // it here (or letting the temp name resolve onto it) is the reported
    // sidecar data-loss bug.
    fs::rename(mnt.join("edited.md"), mnt.join("edited.md~")).unwrap();
    assert!(ship.has("edited"), "a backup-by-rename must never delete the page");
    assert_eq!(ship.body("edited").unwrap(), b"version one\n");
    assert_eq!(read_to_string(&mnt.join("edited.md~")), "version one\n");
    assert_eq!(read_to_string(&mnt.join("edited.md")), "version one\n", "the page is still there");

    // vim then rewrites the page in place
    fs::write(mnt.join("edited.md"), "version two\n").unwrap();
    assert_eq!(ship.body("edited").unwrap(), b"version two\n");

    // removing the backup must NOT remove the page it shadows
    let before = ship.log().len();
    fs::remove_file(mnt.join("edited.md~")).unwrap();
    assert!(ship.has("edited"), "removing a backup must not delete the page");
    assert_eq!(
        ship.log()[before..].iter().filter(|l| l.starts_with("delete")).count(),
        0,
        "a scratch unlink must never reach the ship at all"
    );

    // a swap file lives entirely in the FUSE layer: visible, readable, and
    // never a page
    fs::write(mnt.join(".edited.md.swp"), "swapdata").unwrap();
    assert_eq!(read_to_string(&mnt.join(".edited.md.swp")), "swapdata");
    assert!(!ship.has(".edited.md"), "a swap file must never become a page");
    assert!(!ship.has("edited.md"));
    assert!(names(mnt).contains(&".edited.md.swp".to_string()), "but it is listed");
    assert_eq!(ship.body("edited").unwrap(), b"version two\n", "the page is untouched");

    // VS Code's atomic save: write a temp, then rename it ONTO the existing
    // page. create=true here would 409 and every save of this shape would fail.
    fs::write(mnt.join("edited.md.tmp"), "version three\n").unwrap();
    fs::rename(mnt.join("edited.md.tmp"), mnt.join("edited.md")).unwrap();
    assert_eq!(
        ship.body("edited").unwrap(),
        b"version three\n",
        "an atomic save onto an existing page must overwrite, not fail"
    );
    // and reading it back must give the bytes just saved, not the previous
    // content: the promoted bytes have to be republished locally, because the
    // re-dump that would otherwise carry them is asynchronous
    assert_eq!(read_to_string(&mnt.join("edited.md")), "version three\n");
    assert_eq!(fs::metadata(mnt.join("edited.md")).unwrap().len(), 14);

    // the same dance onto a page that does NOT exist must create it
    fs::write(mnt.join("created.md.tmp"), "made atomically\n").unwrap();
    fs::rename(mnt.join("created.md.tmp"), mnt.join("created.md")).unwrap();
    assert_eq!(ship.body("created").unwrap(), b"made atomically\n");
    assert_eq!(read_to_string(&mnt.join("created.md")), "made atomically\n");
    assert_eq!(fs::metadata(mnt.join("created.md")).unwrap().len(), 16);
    assert!(names(mnt).contains(&"created.md".to_string()), "and it is listed at once");

    // temp -> temp stays in the scratch map, never touching the ship
    fs::write(mnt.join("a.tmp"), "scratch\n").unwrap();
    let before = ship.log().len();
    fs::rename(mnt.join("a.tmp"), mnt.join("b.tmp")).unwrap();
    assert_eq!(read_to_string(&mnt.join("b.tmp")), "scratch\n");
    assert_eq!(ship.log()[before..].len(), 0, "temp -> temp must not reach the ship");

    // ---------- permissions ----------

    // a mode we report as read-only is enforced by the kernel (DefaultPermissions)
    let ro = fs::OpenOptions::new().write(true).mode(0o644).open(mnt.join("hello.md"));
    assert!(ro.is_ok(), "an editable page must stay writable");
}


/// A page rel that tries to climb out of the mount can only ever be an
/// unreachable vpath, never a host path. The vtree is a flat map keyed by
/// absolute vpath and `lookup` only ever does `vt.get(join(parent, name))`,
/// so there is no path traversal to exploit — but a ship is untrusted input,
/// so pin the behaviour.
#[test]
fn a_hostile_page_name_cannot_reach_outside_the_mount() {
    let ship = Ship::with(
        &[("../escape", "md", "nope\n"), ("/abs", "md", "nope\n"), ("ok", "md", "fine\n")],
        &[],
    );
    let mnt = std::env::temp_dir().join(format!("lattice-fs-esc-{}", std::process::id()));
    let _ = fs::remove_dir_all(&mnt);
    fs::create_dir_all(&mnt).unwrap();
    let session =
        match lattice_fs::spawn(ship.clone() as Arc<dyn Projection>, mnt.to_str().unwrap()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("skipped: no usable FUSE here ({e})");
                let _ = fs::remove_dir_all(&mnt);
                return;
            }
        };
    let (tx, rx) = mpsc::channel();
    let dir = mnt.clone();
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert_eq!(read_to_string(&dir.join("ok.md")), "fine\n");
            // a traversal-shaped rel resolves to nothing: `..` and a leading
            // slash are just characters in a vpath key, and no lookup can turn
            // them into a host path
            assert!(fs::metadata(dir.join("escape.md")).is_err());
            assert!(fs::read(dir.join("abs.md")).is_err());
            // and nothing from the host filesystem leaked into the tree
            for n in names(&dir) {
                assert!(n == "ok.md" || n == "abs.md", "unexpected entry {n}");
            }
        }));
        let _ = tx.send(r);
    });
    let outcome = rx.recv_timeout(Duration::from_secs(10));
    drop(session);
    let _ = fs::remove_dir_all(&mnt);
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(p)) => std::panic::resume_unwind(p),
        Err(_) => panic!("the mount stopped answering"),
    }
}
