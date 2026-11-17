//! lattice, drawn natively with Rune: an experiment beside the shipped desktop app.
//!
//! `LATTICE_URL=https://ship LATTICE_COOKIE=/path/to/cookie cargo run` opens a ship.
//! With neither set it opens on built-in sample pages, which is also what the
//! headless runs draw: `cargo run -- --snap out.png --scene reading`.

mod api;

use std::collections::HashMap;

use api::{Conn, Node, Page};
use rune::{AppSpec, Chrome, Cx, El, Key, KeyEvent, Latest, ScrollSpec, TextEdit, Tx, Waker, col, row, text};
use rune_kit::shell::{self, PaneState, SplitView, Toolbar};
use rune_kit::{Button, ButtonVariant, Dialog, FileNode, FileTree, Kit, Markdown, Spinner, TextArea, TextInput, Tree, TreeItem, TreeModel};

type Files = TreeModel<FileNode<Node>>;

struct App {
    conn: Option<Conn>,
    sidebar: PaneState,
    files: Files,
    query: TextEdit,
    /// The page on screen, and the text being edited when `editing`.
    open: Option<Page>,
    editing: bool,
    edit: TextEdit,
    /// Pages already read this session, so a second visit draws at once.
    cache: HashMap<String, Page>,
    note: String,
    /// Every page's name, for the switcher.
    names: Vec<String>,
    /// The quick switcher: its query while open, and the row the arrows are on.
    jump: Option<TextEdit>,
    jump_at: usize,
    tree_req: Latest<Result<Vec<Node>, String>>,
    page_req: Latest<Result<Page, String>>,
    save_req: Latest<Result<Page, String>>,
}

const SAMPLE: &[(&str, &str)] = &[
    ("welcome", "# lattice, natively\n\nThis window is drawn by **Rune**: its own renderer, text and layout, with no webview.\n\n- Pick a page on the left.\n- Press `Edit` to change it.\n- Set `LATTICE_URL` and `LATTICE_COOKIE` to open a ship.\n\n```rust\nfn main() {\n    println!(\"hello, ship\");\n}\n```\n\n| Page kind | Here |\n| --- | --- |\n| Markdown | rendered |\n| Others | as source |\n"),
    ("notes/today", "# Today\n\nA short note with a [link](https://urbit.org).\n"),
    ("notes/ideas/maps", "# Maps\n\n```mermaid\nflowchart LR\n  orrery --> lattice --> map\n```\n"),
    ("journal/2026-11-17", "# Tuesday\n\nReviewed three rounds of fixes.\n"),
];

fn sample_nodes() -> Vec<Node> {
    SAMPLE.iter().map(|(p, _)| Node { path: (*p).into(), page: true, kind: "md".into(), rev: 1 }).collect()
}

fn files_of(nodes: Vec<Node>, keep: &Files) -> Files {
    let pages: Vec<Node> = nodes.into_iter().filter(|n| n.page).collect();
    // a refreshed tree keeps what was open and selected
    let open: Vec<String> = pages
        .iter()
        .flat_map(|n| n.path.match_indices('/').map(|(i, _)| n.path[..i].to_owned()))
        .filter(|d| keep.is_expanded(d))
        .collect();
    let mut m = FileTree::new().build(pages.into_iter().map(|n| (n.path.clone(), n)));
    for id in open {
        m.set_expanded(&id, true);
    }
    if let Some(c) = keep.cursor() {
        m.select(c);
    }
    m
}

fn init() -> App {
    let conn = Conn::from_env();
    let mut s = App {
        sidebar: PaneState::new(264.0).range(160.0, 520.0),
        files: Files::default(),
        query: TextEdit::new(""),
        open: None,
        editing: false,
        edit: TextEdit::new(""),
        cache: HashMap::new(),
        note: String::new(),
        names: Vec::new(),
        jump: None,
        jump_at: 0,
        tree_req: Latest::default(),
        page_req: Latest::default(),
        save_req: Latest::default(),
        conn,
    };
    if s.conn.is_none() {
        s.cache = SAMPLE.iter().map(|(p, b)| ((*p).to_owned(), Page { name: (*p).into(), body: (*b).into(), kind: "md".into(), rev: 1 })).collect();
        s.names = SAMPLE.iter().map(|(p, _)| (*p).to_owned()).collect();
        s.files = files_of(sample_nodes(), &Files::default());
        s.files.expand_all();
        s.note = "sample pages: set LATTICE_URL and LATTICE_COOKIE to open a ship".into();
    }
    s
}

fn setup(s: &mut App, waker: Waker) {
    s.tree_req.set_waker(waker.clone());
    s.page_req.set_waker(waker.clone());
    s.save_req.set_waker(waker);
    load_tree(s);
}

fn load_tree(s: &mut App) {
    if let Some(c) = s.conn.clone() {
        s.tree_req.request(c, |c| c.tree());
    }
}

/// Shows a page: from the cache at once when it is there, and from the ship
/// when one is connected, so the cached text is corrected a moment later.
fn open_page(s: &mut App, name: &str) {
    if s.editing {
        return;
    }
    if let Some(p) = s.cache.get(name) {
        s.open = Some(p.clone());
    }
    if let Some(c) = s.conn.clone() {
        s.page_req.request((c, name.to_owned()), |(c, n)| c.page(&n));
    }
}

fn start_edit(s: &mut App) {
    if let Some(p) = &s.open {
        s.edit = TextEdit::new(p.body.clone());
        s.edit.focused = true;
        s.editing = true;
        s.note.clear();
    }
}

fn save(s: &mut App) {
    let Some(mut p) = s.open.clone() else { return };
    let base = p.rev;
    p.body = s.edit.text.clone();
    match s.conn.clone() {
        Some(c) => s.save_req.request((c, p), move |(c, mut p)| {
            p.rev = c.save(&p, base)?;
            Ok(p)
        }),
        // sample pages: kept for the session
        None => landed(s, p),
    }
}

fn landed(s: &mut App, p: Page) {
    s.cache.insert(p.name.clone(), p.clone());
    s.open = Some(p);
    s.editing = false;
    s.note = "saved".into();
}

fn poll(s: &mut App, _: f64, _: &mut Tx) -> bool {
    let mut changed = false;
    if let Some(r) = s.tree_req.take() {
        changed = true;
        match r {
            Ok(nodes) => {
                let first = s.files.is_empty();
                s.names = nodes.iter().filter(|n| n.page).map(|n| n.path.clone()).collect();
                s.files = files_of(nodes, &s.files);
                if first {
                    s.files.expand_all();
                }
            }
            Err(e) => s.note = format!("tree: {e}"),
        }
    }
    if let Some(r) = s.page_req.take() {
        changed = true;
        match r {
            Ok(p) => {
                s.cache.insert(p.name.clone(), p.clone());
                if !s.editing {
                    s.open = Some(p);
                }
            }
            Err(e) => s.note = format!("page: {e}"),
        }
    }
    if let Some(r) = s.save_req.take() {
        changed = true;
        match r {
            Ok(p) => landed(s, p),
            Err(e) => s.note = format!("not saved: {e}"),
        }
    }
    changed
}

/// How well `name` answers `query`: every query character in order, fewer
/// gaps and an earlier start first. `None` when it does not match.
fn score(name: &str, query: &str) -> Option<usize> {
    let (name, mut at, mut cost) = (name.to_lowercase(), 0, 0);
    for ch in query.to_lowercase().chars().filter(|c| !c.is_whitespace()) {
        let i = name[at..].find(ch)?;
        cost += i;
        at += i + ch.len_utf8();
    }
    Some(cost)
}

/// The switcher's rows for a query: the best ten matches, best first.
fn matches<'a>(names: &'a [String], query: &str) -> Vec<&'a str> {
    let mut hits: Vec<(usize, &str)> = names.iter().filter_map(|n| Some((score(n, query)?, n.as_str()))).collect();
    hits.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.len().cmp(&b.1.len())).then(a.1.cmp(b.1)));
    hits.into_iter().take(10).map(|h| h.1).collect()
}

fn jump_to(s: &mut App, name: &str, tx: &mut Tx) {
    s.jump = None;
    s.files.reveal(name, tx);
    open_page(s, name);
}

fn switcher(s: &App, k: &Kit, layer: &mut Vec<El>) {
    let Some(q) = &s.jump else { return };
    let hits = matches(&s.names, &q.text);
    let field = TextInput::new(q)
        .placeholder("Jump to a page")
        .leading_icon(k.glyph.search)
        .on_edit(|s: &mut App| s.jump.as_mut().expect("the switcher is open"))
        .on_change(|s: &mut App, _| s.jump_at = 0)
        .on_key(|s: &mut App, ev: &KeyEvent, tx: &mut Tx| {
            let Some(q) = &s.jump else { return false };
            let hits = matches(&s.names, &q.text);
            match ev.key {
                Key::Down => s.jump_at = (s.jump_at + 1).min(hits.len().saturating_sub(1)),
                Key::Up => s.jump_at = s.jump_at.saturating_sub(1),
                Key::Enter => {
                    if let Some(name) = hits.get(s.jump_at).map(|n| (*n).to_owned()) {
                        jump_to(s, &name, tx);
                    }
                }
                _ => return false,
            }
            true
        })
        .build(k)
        .w_full();
    let mut rows = col().key("jump-rows").w_full().gap(2.0);
    for (i, name) in hits.iter().enumerate() {
        let (dir, leaf) = name.rsplit_once('/').map_or(("", *name), |(d, l)| (d, l));
        let pick = (*name).to_owned();
        let mut r = row()
            .key(format!("jump:{name}"))
            .w_full()
            .h(30.0)
            .px(10.0)
            .gap(8.0)
            .center_y()
            .radius(k.radius.sm)
            .on_press_tx(move |s: &mut App, tx| jump_to(s, &pick, tx))
            .child(text(leaf.to_owned()).font(k.ty.ui).color(k.c.text_base))
            .child(text(dir.to_owned()).font(k.ty.small).color(k.c.text_faint));
        if i == s.jump_at {
            r = r.fill(k.selection());
        }
        rows = rows.child(r);
    }
    if hits.is_empty() {
        rows = rows.child(text("No page matches").font(k.ty.ui).color(k.c.text_muted));
    }
    Dialog::new("jump", "Jump to a page")
        .open(true)
        .width(520.0)
        .fit()
        .on_close(|s: &mut App| s.jump = None)
        .child(col().w_full().gap(8.0).child(field).child(rows))
        .build(k, layer);
}

fn sidebar(s: &App, k: &Kit) -> El {
    let q = s.query.text.trim().to_lowercase();
    let tree = Tree::new(|s: &App| &s.files, |s: &mut App| &mut s.files, |n: &FileNode<Node>| n.name.as_str())
        .name("Pages")
        .row(move |n, r| TreeItem::file(n, r).highlight(q.clone()))
        // one click opens a page, as the web client's tree does
        .on_select(|s: &mut App, id, _| {
            if s.files.get(id).is_some_and(|n| !n.dir) {
                open_page(s, id);
            }
        })
        .build(s, k)
        .grow(1.0)
        .min_h(0.0);
    let filter = TextInput::new(&s.query)
        .placeholder("Filter pages")
        .leading_icon(k.glyph.search)
        .clear_button()
        .on_edit(|s: &mut App| &mut s.query)
        .on_change(|s: &mut App, _| {
            let q = s.query.text.trim().to_lowercase();
            if q.is_empty() { s.files.clear_filter() } else { s.files.filter(|n| n.path.to_lowercase().contains(&q)) }
        })
        .build(k)
        .w_full();
    let mut side = col().key("pages").w_full().h_full().min_h(0.0).padding(8.0).gap(8.0).child(filter).child(tree);
    if !s.note.is_empty() {
        side = side.child(text(s.note.clone()).key("note").font(k.ty.small).color(k.c.text_muted).wrap());
    }
    side
}

fn body(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let Some(p) = &s.open else {
        return col().w_full().h_full().center().child(text("Pick a page").font(k.ty.ui).color(c.text_muted));
    };
    if s.editing {
        return col().key("editor").w_full().h_full().min_h(0.0).padding(16.0).child(
            TextArea::new(&s.edit).label("Page source").on_edit(|s: &mut App| &mut s.edit).build(k).w_full().grow(1.0).min_h(0.0),
        );
    }
    let shown = if p.kind == "md" {
        Markdown::new(p.body.clone()).selectable(true).build(k)
    } else {
        // other kinds draw as their source until each has a native view
        text(p.body.clone()).font(k.ty.mono).color(c.text_base).wrap().selectable(true)
    };
    col()
        .key("reader")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(col().key(format!("page:{}", p.name)).w_full().items_center().child(col().w_full().max_w(760.0).padding(28.0).child(shown)))
        .scroll(ScrollSpec { stick_bottom: false })
}

fn view(s: &App, cx: &mut Cx<App>) -> El {
    let k = Kit::neutral(cx.system_dark());
    let title = s.open.as_ref().map_or("lattice", |p| p.name.as_str());
    let busy = s.tree_req.is_pending() || s.page_req.is_pending() || s.save_req.is_pending();
    let mut trailing = row().gap(8.0).center_y();
    if busy {
        trailing = trailing.child(Spinner::new().build(&k));
    }
    if s.editing {
        trailing = trailing
            .child(Button::new("Cancel").variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.editing = false).build(&k).key("cancel"))
            .child(Button::new("Save").variant(ButtonVariant::Contrast).on_press(save).build(&k).key("save"));
    } else if s.open.is_some() {
        trailing = trailing.child(Button::new("Edit").variant(ButtonVariant::Ghost).on_press(start_edit).build(&k).key("edit"));
    }
    let mut layer = Vec::new();
    switcher(s, &k, &mut layer);
    let shell = SplitView::new(body(s, &k))
        .sidebar(&s.sidebar, |s: &mut App| &mut s.sidebar, sidebar(s, &k))
        .toolbar(Toolbar::new().title(title).trailing(trailing))
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
        .reduced_motion(cx.is_reduced_motion())
        .build(&k);
    rune_kit::root(shell, layer)
}

fn on_key(s: &mut App, ev: &KeyEvent, _: &mut Tx) -> bool {
    if shell::is_sidebar_toggle(ev) {
        s.sidebar.toggle();
        return true;
    }
    if ev.is_command('k') && !s.editing {
        let mut q = TextEdit::new("");
        q.focused = true;
        s.jump = Some(q);
        s.jump_at = 0;
        return true;
    }
    if ev.is_command('s') && s.editing {
        save(s);
        return true;
    }
    if ev.is_command('e') && !s.editing {
        start_edit(s);
        return true;
    }
    if ev.is_command('r') {
        load_tree(s);
        return true;
    }
    false
}

fn main() {
    let chrome = Chrome { full_size_content: true, traffic_lights: Some((16.0, 25.0)), drag_regions: true };
    rune::App::new(AppSpec {
        setup: Some(setup),
        poll: Some(poll),
        on_key: Some(on_key),
        min_size: Some((640.0, 400.0)),
        scenes: &[("reading", |s| open_page(s, "welcome")), ("jump", |s| {
            open_page(s, "welcome");
            let mut q = TextEdit::new("no");
            q.focused = true;
            s.jump = Some(q);
        }), ("editing", |s| {
            open_page(s, "welcome");
            start_edit(s);
        })],
        ..AppSpec::new("lattice", (1120.0, 720.0), init, view)
    })
    .chrome(chrome)
    .run();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switcher_ranks_tight_early_matches_first_and_drops_misses() {
        let names: Vec<String> = ["notes/today", "journal/2026-11-17", "notes/ideas/maps", "welcome"].map(String::from).to_vec();
        assert_eq!(matches(&names, "maps"), ["notes/ideas/maps"]);
        assert_eq!(matches(&names, "nt"), ["notes/today", "notes/ideas/maps"]);
        assert_eq!(matches(&names, "zz"), Vec::<&str>::new());
        assert_eq!(matches(&names, "").len(), 4);
        assert_eq!(score("Welcome", "WEL"), Some(0));
    }
}
