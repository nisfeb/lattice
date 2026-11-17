//! lattice, drawn natively with Rune: an experiment beside the shipped desktop app.
//!
//! `LATTICE_URL=https://ship LATTICE_COOKIE=/path/to/cookie cargo run` opens a ship.
//! With neither set it opens on built-in sample pages, which is also what the
//! headless runs draw: `cargo run -- --snap out.png --scene reading`.

mod api;
mod map;
mod md;
mod sheet;

use std::collections::HashMap;

use api::{Conn, Dump, Know, Node, Page, Rev};
use rune::{AppSpec, Block, LineCap, Phase, Shape, WheelEvent, canvas, Chrome, Cx, El, Key, KeyEvent, Latest, Mark, ScrollSpec, Span, TextEdit, Tx, Waker, col, el, row, text};
use rune_kit::shell::{self, PaneState, SplitView, Toolbar};
use rune_kit::syntax::{self, SyntaxTheme};
use rune_kit::{Cell, Table, TableColumn, TableState};
use rune_kit::{Button, ButtonVariant, ControlSize, Dialog, Divider, FileNode, FileTree, Kit, Markdown, Spinner, TextArea, TextInput, Tree, TreeItem, TreeModel};

type Files = TreeModel<FileNode<Node>>;

/// A map page on screen: its shapes, where the camera is, and the point picked.
struct MapView {
    name: String,
    rev: u64,
    feats: Vec<map::Feature>,
    cam: map::Camera,
    /// The camera when the drag in progress began.
    grab: map::Camera,
    /// The view's size, once laid out. The camera is fitted to it once.
    size: (f32, f32),
    fitted: bool,
    picked: Option<usize>,
}

/// A spreadsheet page on screen: its sheets, the one showing, and the grid's state.
struct SheetView {
    name: String,
    rev: u64,
    sheets: Vec<sheet::Sheet>,
    at: usize,
    table: TableState,
}

/// A question the window is asking: a name for a new page, a new name for
/// the open one, or whether to delete it.
enum Prompt {
    New(TextEdit),
    Rename(String, TextEdit),
    Delete(String),
    /// The address for a link on the editor's selection.
    Link(TextEdit),
}

/// A change to the tree that landed on the ship.
enum Op {
    Created(String),
    Renamed(String, String),
    Deleted(String),
    /// A page's share mode was set.
    Shared(String, String),
}

struct App {
    conn: Option<Conn>,
    /// Browsing the built-in pages with no ship.
    sample: bool,
    url: TextEdit,
    code: TextEdit,
    login_err: String,
    login_req: Latest<Result<Conn, String>>,
    prompt: Option<Prompt>,
    op_req: Latest<Result<Op, String>>,
    /// The rendered page beside the source while editing.
    preview: bool,
    sidebar: PaneState,
    files: Files,
    query: TextEdit,
    /// The page on screen, and the text being edited when `editing`.
    open: Option<Page>,
    editing: bool,
    edit: TextEdit,
    /// Editing as rich text, not as Markdown source.
    rich: bool,
    /// The line spacing of the page the rich editor was opened on (md::Seps).
    seps: md::Seps,
    /// The history pane: the revisions of the page named, and the old
    /// revision on screen in place of the page while one is being read.
    inspector: PaneState,
    revs: Option<(String, Vec<Rev>)>,
    old: Option<Page>,
    hist_req: Latest<Result<(String, Vec<Rev>), String>>,
    old_req: Latest<Result<Page, String>>,
    /// The page being edited was written elsewhere since it was opened.
    stale: bool,
    /// Each page's share mode, as the last dump said, and whether the
    /// share dialog is open.
    shares: HashMap<String, String>,
    sharing: bool,
    /// Showing memories, not pages. The tree, the names and the kept texts
    /// are those of what is showing, and `other` holds the same three for
    /// what is not (+flip swaps them).
    memory: bool,
    other: (Files, Vec<String>, HashMap<String, Page>),
    /// Each memory's tags and date, by its name in the tree.
    know_meta: HashMap<String, (Vec<String>, String)>,
    know_req: Latest<Result<Vec<Know>, String>>,
    /// The open page as a spreadsheet, when it is one.
    sheet: Option<SheetView>,
    /// The open page as a map, when it is one.
    map: Option<MapView>,
    /// The pages visited, oldest first, and where in them the window is.
    trail: Vec<String>,
    trail_at: usize,
    /// Pages already read this session, so a second visit draws at once.
    cache: HashMap<String, Page>,
    note: String,
    /// Every page's name, for the switcher.
    names: Vec<String>,
    /// The quick switcher: its query while open, and the row the arrows are on.
    jump: Option<TextEdit>,
    jump_at: usize,
    tree_req: Latest<Result<Dump, String>>,
    /// The last dump's token, and when the next one is due (app clock).
    since: String,
    next_sync: f64,
    page_req: Latest<Result<Page, String>>,
    save_req: Latest<Result<Page, String>>,
}

const SAMPLE: &[(&str, &str)] = &[
    ("welcome", "# lattice, natively\n\nThis window is drawn by **Rune**: its own renderer, text and layout, with no webview.\n\n- Pick a page on the left, or follow [[notes/today]].\n- A link to [[plans/next|a page not made yet]] offers to make it.\n- Press `Edit` to change it.\n- Set `LATTICE_URL` and `LATTICE_COOKIE` to open a ship.\n\n```rust\nfn main() {\n    println!(\"hello, ship\");\n}\n```\n\n| Page kind | Here |\n| --- | --- |\n| Markdown | rendered |\n| Others | as source |\n"),
    ("notes/today", "# Today\n\nA short note with a [link](https://urbit.org).\n"),
    ("notes/ideas/maps", "# Maps\n\n```mermaid\nflowchart LR\n  orrery --> lattice --> map\n```\n"),
    ("journal/2026-11-17", "# Tuesday\n\nReviewed three rounds of fixes.\n"),
    ("budget", r#"<?xml version="1.0"?><office:document><office:body><office:spreadsheet><table:table table:name="2026">
<table:table-row><table:table-cell><text:p>Item</text:p></table:table-cell><table:table-cell><text:p>Monthly</text:p></table:table-cell><table:table-cell><text:p>Yearly</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell><text:p>Hosting</text:p></table:table-cell><table:table-cell><text:p>24.00</text:p></table:table-cell><table:table-cell><text:p>288.00</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell><text:p>Domains</text:p></table:table-cell><table:table-cell><text:p>3.50</text:p></table:table-cell><table:table-cell><text:p>42.00</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell><text:p>Total</text:p></table:table-cell><table:table-cell><text:p>27.50</text:p></table:table-cell><table:table-cell><text:p>330.00</text:p></table:table-cell></table:table-row>
</table:table><table:table table:name="Notes"><table:table-row><table:table-cell><text:p>Prices checked in November</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document>"#),
    ("places", r#"{"type":"FeatureCollection","features":[
{"type":"Feature","geometry":{"type":"Point","coordinates":[-73.9857,40.7484]},"properties":{"name":"Midtown","note":"A point with a note.","kind":"place"}},
{"type":"Feature","geometry":{"type":"Point","coordinates":[-73.9442,40.6782]},"properties":{"name":"Brooklyn"}},
{"type":"Feature","geometry":{"type":"LineString","coordinates":[[-73.9857,40.7484],[-73.97,40.72],[-73.9442,40.6782]]},"properties":{"name":"A walk"}},
{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[-73.981,40.768],[-73.958,40.8],[-73.949,40.797],[-73.973,40.764],[-73.981,40.768]]]},"properties":{"name":"The park"}}
]}"#),
];

fn sample_nodes() -> Vec<Node> {
    SAMPLE.iter().map(|(p, _)| Node { path: (*p).into(), page: true, kind: "md".into(), rev: 1, body: None, ..Node::default() }).collect()
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
    let conn = Conn::load();
    let mut url = TextEdit::new("");
    url.focused = true;
    App {
        sample: false,
        url,
        code: TextEdit::new(""),
        login_err: String::new(),
        login_req: Latest::default(),
        prompt: None,
        op_req: Latest::default(),
        preview: true,
        sidebar: PaneState::new(264.0).range(160.0, 520.0),
        files: Files::default(),
        query: TextEdit::new(""),
        open: None,
        editing: false,
        edit: TextEdit::new(""),
        rich: false,
        seps: md::Seps::default(),
        inspector: PaneState::new(240.0).range(200.0, 360.0).collapsed(),
        revs: None,
        old: None,
        hist_req: Latest::default(),
        old_req: Latest::default(),
        stale: false,
        shares: HashMap::new(),
        sharing: false,
        memory: false,
        other: Default::default(),
        know_meta: HashMap::new(),
        know_req: Latest::default(),
        sheet: None,
        map: None,
        trail: Vec::new(),
        trail_at: 0,
        cache: HashMap::new(),
        note: String::new(),
        names: Vec::new(),
        jump: None,
        jump_at: 0,
        tree_req: Latest::default(),
        since: String::new(),
        next_sync: 0.0,
        page_req: Latest::default(),
        save_req: Latest::default(),
        conn,
    }
}

/// Opens the built-in pages, with no ship.
fn browse_sample(s: &mut App) {
    {
        s.sample = true;
        // a sample page that starts as JSON is the map
        let kind = |b: &str| if b.starts_with('{') { "geojson" } else if b.starts_with("<?xml") { "fods" } else { "md" };
        s.cache = SAMPLE.iter().map(|(p, b)| ((*p).to_owned(), Page { name: (*p).into(), body: (*b).into(), kind: kind(b).into(), rev: 1 })).collect();
        s.names = SAMPLE.iter().map(|(p, _)| (*p).to_owned()).collect();
        s.files = files_of(sample_nodes(), &Files::default());
        s.files.expand_all();
        s.note = "sample pages, kept only while the window is open".into();
        // and two memories, in the other half
        let knows = [("feedback/short-answers", "Keep answers short.\n\n**Why:** long ones are not read.\n"), ("project/lattice/rune", "An experimental native client, drawn with Rune.\n")];
        s.other.1 = knows.iter().map(|(k, _)| (*k).to_owned()).collect();
        s.other.2 = knows.iter().map(|(k, b)| ((*k).to_owned(), Page { name: (*k).into(), body: (*b).into(), kind: "md".into(), rev: 0 })).collect();
        s.other.0 = files_of(s.other.1.iter().map(|p| Node { path: p.clone(), page: true, kind: "md".into(), rev: 0, body: None, ..Node::default() }).collect(), &Files::default());
        s.other.0.expand_all();
        s.know_meta.insert("feedback/short-answers".into(), (vec!["style".into()], "~2026.11.17..9.30.0".into()));
    }
}

/// Switches between pages and memories. Nothing is open after it, and the
/// trail of visits starts again: a name means one thing in each half.
fn flip(s: &mut App) {
    if s.editing {
        return;
    }
    flip_quiet(s);
    s.open = None;
    s.old = None;
    s.trail.clear();
    s.trail_at = 0;
    s.query = TextEdit::new("");
    s.files.clear_filter();
    s.inspector = s.inspector.clone().collapsed();
    sync_map(s);
    sync_sheet(s);
}

/// The swap alone, for work on the half that is not showing.
fn flip_quiet(s: &mut App) {
    std::mem::swap(&mut s.files, &mut s.other.0);
    std::mem::swap(&mut s.names, &mut s.other.1);
    std::mem::swap(&mut s.cache, &mut s.other.2);
    s.memory = !s.memory;
}

fn load_know(s: &mut App) {
    if let Some(c) = s.conn.clone() {
        s.know_req.request(c, |c| c.know_all());
    }
}

/// The memories just read, as the half that shows them.
fn take_knows(s: &mut App, knows: Vec<Know>) {
    let was = s.memory;
    if !was {
        flip_quiet(s);
    }
    let name = |k: &Know| k.key.trim_start_matches('/').to_owned();
    s.names = knows.iter().map(name).collect();
    s.know_meta = knows.iter().map(|k| (name(k), (k.tags.clone(), k.updated.clone()))).collect();
    s.cache = knows.iter().map(|k| (name(k), Page { name: name(k), body: k.body.clone(), kind: "md".into(), rev: 0 })).collect();
    let nodes = s.names.iter().map(|p| Node { path: p.clone(), page: true, kind: "md".into(), rev: 0, body: None, ..Node::default() }).collect();
    s.files = files_of(nodes, &s.files);
    if !was {
        flip_quiet(s);
    } else if !s.editing {
        // the open memory follows what was read
        if let Some(fresh) = s.open.as_ref().and_then(|p| s.cache.get(&p.name)) {
            s.open = Some(fresh.clone());
        }
    }
}

fn sign_in(s: &mut App) {
    if s.url.text.trim().is_empty() || s.code.text.trim().is_empty() {
        s.login_err = "enter the ship's address and its access code".into();
        return;
    }
    s.login_err.clear();
    s.login_req.request((s.url.text.clone(), s.code.text.clone()), |(u, c)| Conn::login(&u, &c));
}

fn sign_out(s: &mut App) {
    Conn::forget();
    let mut fresh = init();
    fresh.conn = None;
    // the wakers were set once, on the requests this window keeps
    fresh.tree_req = std::mem::take(&mut s.tree_req);
    fresh.page_req = std::mem::take(&mut s.page_req);
    fresh.save_req = std::mem::take(&mut s.save_req);
    fresh.login_req = std::mem::take(&mut s.login_req);
    fresh.op_req = std::mem::take(&mut s.op_req);
    fresh.hist_req = std::mem::take(&mut s.hist_req);
    fresh.know_req = std::mem::take(&mut s.know_req);
    fresh.old_req = std::mem::take(&mut s.old_req);
    fresh.sidebar = s.sidebar.clone();
    *s = fresh;
}

/// Asks the ship for the change the open prompt names.
fn confirm(s: &mut App) {
    let Some(p) = s.prompt.take() else { return };
    if let Prompt::Link(t) = &p {
        let url = t.text.trim();
        if !url.is_empty() && !url.contains(char::is_whitespace) {
            s.edit.set_link(Some(url));
        }
        s.edit.focused = true;
        return;
    }
    let clean = |t: &TextEdit| t.text.trim().trim_matches('/').to_owned();
    let op = match p {
        Prompt::New(t) if !clean(&t).is_empty() => Op::Created(clean(&t)),
        Prompt::Rename(from, t) if !clean(&t).is_empty() && clean(&t) != from => Op::Renamed(from, clean(&t)),
        Prompt::Delete(name) => Op::Deleted(name),
        _ => return,
    };
    let memory = s.memory;
    match s.conn.clone() {
        Some(c) => s.op_req.request((c, op), move |(c, op)| {
            match &op {
                Op::Created(n) if memory => c.know_save(&format!("/{n}"), &format!("{}\n", n.rsplit('/').next().unwrap_or(n)))?,
                Op::Deleted(n) if memory => c.know_delete(&format!("/{n}"))?,
                Op::Renamed(..) if memory => return Err("a memory is not renamed here".into()),
                Op::Created(n) => c.create(n)?,
                Op::Renamed(a, b) => c.rename(a, b)?,
                Op::Deleted(n) => c.delete(n)?,
                Op::Shared(n, mode) => c.share(n, mode)?,
            }
            Ok(op)
        }),
        None => applied(s, op),
    }
}

/// A change landed: follow it here, then read the tree again.
fn applied(s: &mut App, op: Op) {
    match op {
        Op::Created(n) => {
            if s.conn.is_none() || s.memory {
                let title = n.rsplit('/').next().unwrap_or(&n).to_owned();
                s.cache.insert(n.clone(), Page { name: n.clone(), body: format!("# {title}\n"), kind: "md".into(), rev: 1 });
            }
            s.names.push(n.clone());
            s.files.select(&n);
            s.open = None;
            open_page(s, &n);
            s.note = "created".into();
        }
        Op::Renamed(a, b) => {
            if let Some(mut p) = s.cache.remove(&a) {
                p.name = b.clone();
                s.cache.insert(b.clone(), p);
            }
            s.names.retain(|x| *x != a);
            s.names.push(b.clone());
            s.open = None;
            open_page(s, &b);
            s.note = "renamed".into();
        }
        Op::Shared(n, mode) => {
            s.note = match mode.as_str() {
                "clearweb" => "anyone with the link can read it".into(),
                "shared" => "ships you grant can read it over Urbit".into(),
                _ => "private again".into(),
            };
            s.shares.insert(n, mode);
        }
        Op::Deleted(n) => {
            s.cache.remove(&n);
            s.names.retain(|x| *x != n);
            s.open = None;
            s.note = "deleted".into();
        }
    }
    if s.conn.is_some() && s.memory {
        load_know(s);
    } else if s.conn.is_some() {
        load_tree(s);
    } else {
        let nodes = s.names.iter().map(|p| Node { path: p.clone(), page: true, kind: "md".into(), rev: 1, body: None, ..Node::default() }).collect();
        s.files = files_of(nodes, &s.files);
        s.files.expand_all();
        if let Some(p) = &s.open {
            s.files.select(&p.name);
        }
    }
}

fn setup(s: &mut App, waker: Waker) {
    s.tree_req.set_waker(waker.clone());
    s.page_req.set_waker(waker.clone());
    s.save_req.set_waker(waker.clone());
    s.login_req.set_waker(waker.clone());
    s.hist_req.set_waker(waker.clone());
    s.know_req.set_waker(waker.clone());
    s.old_req.set_waker(waker.clone());
    s.op_req.set_waker(waker);
    load_tree(s);
    load_know(s);
}

fn load_tree(s: &mut App) {
    if let Some(c) = s.conn.clone() {
        s.tree_req.request((c, s.since.clone()), |(c, since)| c.dump(&since));
    }
}

/// Shows a page: from the cache at once when it is there, and from the ship
/// when one is connected, so the cached text is corrected a moment later.
fn open_page(s: &mut App, name: &str) {
    if s.editing {
        return;
    }
    // a new visit drops what was ahead of it, as a browser does
    if s.trail.get(s.trail_at).map(String::as_str) != Some(name) {
        s.trail.truncate(s.trail_at + 1);
        s.trail.push(name.to_owned());
        s.trail_at = s.trail.len() - 1;
    }
    show_page(s, name);
}

/// Steps back (`-1`) or forward (`1`) through the pages visited.
fn step(s: &mut App, by: isize) {
    let Some(at) = s.trail_at.checked_add_signed(by).filter(|&i| i < s.trail.len()) else { return };
    if s.editing {
        return;
    }
    s.trail_at = at;
    let name = s.trail[at].clone();
    s.files.expand_to(&name);
    s.files.select(&name);
    show_page(s, &name);
}

/// Follows a link in a page: to a page of this ship, to a prompt that makes
/// the page when there is none yet, or to the web.
fn follow(s: &mut App, url: &str, tx: &mut Tx) {
    match md::page_of(url) {
        Some(name) if s.names.contains(&name) => {
            s.files.reveal(&name, tx);
            open_page(s, &name);
        }
        Some(name) => {
            let mut t = TextEdit::new(name);
            t.focused = true;
            s.prompt = Some(Prompt::New(t));
        }
        None => {
            if let Err(e) = tx.open_url(url) {
                s.note = format!("could not open {url}: {e:?}");
            }
        }
    }
}

/// Keeps `s.map` in step with the open page: built when a map page opens
/// or its text moves, dropped for any other page. The camera is kept
/// across a new revision of the same page.
fn sync_map(s: &mut App) {
    let Some(p) = s.open.as_ref().filter(|p| p.kind == "geojson") else {
        s.map = None;
        return;
    };
    if s.map.as_ref().is_some_and(|m| m.name == p.name && m.rev == p.rev) {
        return;
    }
    let old = s.map.take().filter(|m| m.name == p.name);
    s.map = map::parse(&p.body).map(|feats| {
        let cam = old.as_ref().map_or(map::Camera { at: [0.5, 0.5], scale: 800.0 }, |m| m.cam);
        MapView { name: p.name.clone(), rev: p.rev, feats, cam, grab: cam, size: old.as_ref().map_or((800.0, 500.0), |m| m.size), fitted: old.is_some_and(|m| m.fitted), picked: None }
    });
}

/// Keeps `s.sheet` in step with the open page, as +sync_map does for a map.
fn sync_sheet(s: &mut App) {
    let Some(p) = s.open.as_ref().filter(|p| p.kind == "fods") else {
        s.sheet = None;
        return;
    };
    if s.sheet.as_ref().is_some_and(|v| v.name == p.name && v.rev == p.rev) {
        return;
    }
    let sheets = sheet::parse(&p.body);
    let old = s.sheet.take().filter(|v| v.name == p.name);
    s.sheet = (!sheets.is_empty()).then(|| SheetView {
        name: p.name.clone(),
        rev: p.rev,
        at: old.as_ref().map_or(0, |v| v.at).min(sheets.len() - 1),
        sheets,
        table: TableState::new(),
    });
}

/// The widest a sheet's grid is drawn. More columns are in the page, not on screen.
const SHEET_COLS: usize = 52;

fn sheet_view(v: &SheetView, s: &App, k: &Kit) -> El {
    let c = &k.c;
    let sh = &v.sheets[v.at];
    let cols = sh.width().clamp(1, SHEET_COLS);
    let mut table = Table::new(
        |s: &App| &s.sheet.as_ref().expect("a sheet is showing").table,
        |s: &mut App| &mut s.sheet.as_mut().expect("a sheet is showing").table,
        |s: &App| s.sheet.as_ref().map_or(0, |v| v.sheets[v.at].rows.len()),
        |_: &App, i| std::borrow::Cow::Owned(i.to_string()),
    )
    .name("Sheet")
    .column(TableColumn::new("#", "").width(48.0).resizable(false));
    for i in 0..cols {
        table = table.column(TableColumn::new(sheet::column_name(i), sheet::column_name(i)).width(120.0).min(48.0).max(600.0));
    }
    let grid = table
        .cell(|s: &App, i, col| {
            let Some(v) = &s.sheet else { return Cell::text("") };
            if col == "#" {
                return Cell::text((i + 1).to_string()).muted().mono();
            }
            // a column's letters back to its place
            let at = col.bytes().fold(0usize, |n, b| n * 26 + (b - b'A') as usize + 1) - 1;
            Cell::text(v.sheets[v.at].rows.get(i).and_then(|r| r.get(at)).map_or("", String::as_str))
        })
        .zebra(true)
        .build(s, k)
        .grow(1.0)
        .min_h(0.0);
    let mut tabs = row().key("sheet-tabs").gap(4.0).center_y();
    for (i, sh) in v.sheets.iter().enumerate() {
        tabs = tabs.child(
            Button::new(if sh.name.is_empty() { format!("Sheet {}", i + 1) } else { sh.name.clone() })
                .control_size(ControlSize::Small)
                .variant(if i == v.at { ButtonVariant::Contrast } else { ButtonVariant::Ghost })
                .on_press(move |s: &mut App| {
                    if let Some(v) = &mut s.sheet {
                        v.at = i;
                        v.table = TableState::new();
                    }
                })
                .build(k)
                .key(format!("sheet-{i}")),
        );
    }
    let more = if sh.width() > SHEET_COLS { format!(", the first {SHEET_COLS} of {} columns", sh.width()) } else { String::new() };
    tabs = tabs.child(text(format!("{} rows{more}", sh.rows.len())).font(k.ty.small).color(c.text_muted).pl(8.0));
    col().key("sheet").w_full().h_full().min_h(0.0).padding(12.0).gap(8.0).child(grid).child(tabs)
}

/// The most positions one line or area is drawn with.
const MAP_LINE: usize = 2000;
/// The most points drawn as pressable dots, and named.
const MAP_DOTS: usize = 400;

fn map_view(m: &MapView, k: &Kit) -> El {
    let c = &k.c;
    let (w, h) = m.size;
    let ink = c.text_accent;
    let to = |p: map::P| m.cam.project(p, w, h);
    // the graticule: lines of longitude and latitude a few across the view
    let step = m.cam.grid_step(w);
    let (a, z) = (m.cam.unproject(0.0, 0.0, w, h), m.cam.unproject(w, h, w, h));
    let mut shape = Shape::new();
    let lon0 = ((a[0] - 0.5) * 360.0 / step).floor() as i64;
    let lon1 = ((z[0] - 0.5) * 360.0 / step).ceil() as i64;
    for i in lon0..=lon1.min(lon0 + 60) {
        let x = to(map::mercator(i as f64 * step, 0.0))[0];
        shape = shape.line([x, 0.0], [x, h], 1.0, LineCap::Butt, c.border_weak);
    }
    let mut lat = (-85.0 / step).ceil() * step;
    let mut drawn = 0;
    while lat <= 85.0 && drawn < 60 {
        let y = to(map::mercator(0.0, lat))[1];
        if (0.0..=h).contains(&y) {
            shape = shape.line([0.0, y], [w, y], 1.0, LineCap::Butt, c.border_weak);
            drawn += 1;
        }
        lat += step;
    }
    let mut dots: Vec<(usize, map::P)> = Vec::new();
    for (i, f) in m.feats.iter().enumerate() {
        for g in &f.geoms {
            match g {
                map::Geom::Point(p) => dots.push((i, *p)),
                map::Geom::Line(l) => shape = shape.stroke(map::thin(l, MAP_LINE).into_iter().map(to).collect::<Vec<_>>(), 2.5, ink),
                map::Geom::Area(l) => {
                    let ring: Vec<[f32; 2]> = map::thin(l, MAP_LINE).into_iter().map(to).collect();
                    shape = shape.fill(ring.clone(), ink.alpha(0.18)).stroke(ring, 1.5, ink);
                }
            }
        }
    }
    let mut view = el()
        .key("map")
        .w_full()
        .h_full()
        .fill(c.bg_base)
        .clip_rounded(0.0)
        .on_layout(|s: &mut App, r| {
            if let Some(m) = &mut s.map {
                m.size = (r[2].max(1.0), r[3].max(1.0));
                if !m.fitted {
                    m.cam = map::Camera::fit(&m.feats, m.size.0, m.size.1);
                    m.fitted = true;
                }
            }
        })
        .on_drag(|s: &mut App, d, _| {
            if let Some(m) = &mut s.map {
                match d.phase {
                    Phase::Down => m.grab = m.cam,
                    _ => m.cam = map::Camera::dragged(m.grab, d.dx, d.dy),
                }
            }
        })
        .on_wheel(|s: &mut App, e: WheelEvent, _| {
            if let Some(m) = &mut s.map {
                // ponytail: the wheel's sign is taken as Rune's pinch mapping has it, unchecked on a real wheel
                m.cam.zoom_at((-e.dy as f64 / 200.0).exp(), e.x, e.y, m.size.0, m.size.1);
            }
            true
        })
        .child(canvas(shape).key("map-shapes").absolute(0.0, 0.0).size(w, h));
    // until the first layout the size is a guess: draw the ground alone
    if !m.fitted {
        return view;
    }
    for (n, (i, p)) in dots.iter().take(MAP_DOTS).enumerate() {
        let [x, y] = to(*p);
        if !(-20.0..=w + 20.0).contains(&x) || !(-20.0..=h + 20.0).contains(&y) {
            continue;
        }
        let i = *i;
        let on = m.picked == Some(i);
        let r = if on { 8.0 } else { 6.0 };
        view = view.child(
            el().key(format!("dot-{n}"))
                .absolute(x - r, y - r)
                .size(r * 2.0, r * 2.0)
                .radius(r)
                .fill(ink)
                .border(2.0, c.bg_base)
                .label(m.feats[i].name.clone())
                .on_press(move |s: &mut App| {
                    if let Some(m) = &mut s.map {
                        m.picked = if m.picked == Some(i) { None } else { Some(i) };
                    }
                }),
        );
        if !m.feats[i].name.is_empty() {
            view = view.child(text(m.feats[i].name.clone()).key(format!("name-{n}")).absolute(x + r + 4.0, y - 9.0).font(k.ty.small_medium).color(c.text_base).inert());
        }
    }
    // the picked point's details
    if let Some(f) = m.picked.and_then(|i| m.feats.get(i)) {
        let mut card = col().key("map-detail").absolute(12.0, 12.0).w(260.0).padding(12.0).gap(6.0).radius(k.radius.md).fill(c.layer_01).border(1.0, c.border_weak);
        card = card.child(text(if f.name.is_empty() { "A point".to_owned() } else { f.name.clone() }).font(k.ty.ui_medium).color(c.text_base));
        if !f.note.is_empty() {
            card = card.child(text(f.note.clone()).font(k.ty.small).color(c.text_muted).wrap());
        }
        for (key, v) in f.props.iter().filter(|(key, _)| key != "name" && key != "note").take(8) {
            card = card.child(row().gap(6.0).child(text(key.clone()).font(k.ty.small).color(c.text_faint)).child(text(v.clone()).font(k.ty.small).color(c.text_base).truncate().grow(1.0).min_w(0.0)));
        }
        view = view.child(card);
    }
    let zoom = |key: &str, label: &str, f: f64| {
        Button::new(label)
            .control_size(ControlSize::Small)
            .on_press(move |s: &mut App| {
                if let Some(m) = &mut s.map {
                    let (w, h) = m.size;
                    if f == 0.0 { m.cam = map::Camera::fit(&m.feats, w, h) } else { m.cam.zoom_at(f, w / 2.0, h / 2.0, w, h) }
                }
            })
            .build(k)
            .key(key.to_owned())
    };
    let count = text(format!("{} shapes", m.feats.len())).font(k.ty.small).color(c.text_muted);
    view.child(row().key("map-tools").absolute(12.0, h - 40.0).gap(6.0).center_y().child(zoom("zoom-in", "+", 2.0)).child(zoom("zoom-out", "−", 0.5)).child(zoom("zoom-fit", "Fit", 0.0)).child(count))
}

/// Reads the open page's revisions when the history pane is showing.
fn load_history(s: &mut App) {
    if s.memory {
        return;
    }
    let (Some(c), Some(p)) = (s.conn.clone(), &s.open) else { return };
    if s.inspector.is_open() {
        s.hist_req.request((c, p.name.clone()), |(c, n)| c.history(&n).map(|r| (n, r)));
    }
}

/// Shows the open page as it was at `rev`, read-only.
fn view_rev(s: &mut App, rev: u64) {
    let (Some(c), Some(p)) = (s.conn.clone(), &s.open) else { return };
    if p.rev == rev {
        s.old = None;
        return;
    }
    s.old_req.request((c, p.name.clone()), move |(c, n)| c.page_at(&n, rev));
}

/// Saves the old revision on screen as the page's newest. Nothing is
/// lost: what it replaces stays in the history.
fn restore(s: &mut App) {
    let (Some(c), Some(old), Some(cur)) = (s.conn.clone(), s.old.take(), &s.open) else { return };
    let base = cur.rev;
    let p = Page { name: old.name, body: old.body, kind: cur.kind.clone(), rev: base };
    s.save_req.request((c, p), move |(c, mut p)| {
        p.rev = c.save(&p, base)?;
        Ok(p)
    });
}

fn show_page(s: &mut App, name: &str) {
    s.old = None;
    s.stale = false;
    if let Some(p) = s.cache.get(name) {
        s.open = Some(p.clone());
    }
    // a memory's text came with the list: only a page is read again
    if let Some(c) = s.conn.clone().filter(|_| !s.memory) {
        s.page_req.request((c, name.to_owned()), |(c, n)| c.page(&n));
    }
    sync_map(s);
    sync_sheet(s);
    load_history(s);
}

/// A rich field for `d`, kept to what Markdown can write.
fn rich_edit(d: md::Doc, seps: &mut md::Seps) -> TextEdit {
    *seps = d.seps;
    let mut e = TextEdit::from_parts(d.text, d.marks, d.blocks)
        .with_soft_breaks(d.soft)
        .allow_marks([Mark::Bold, Mark::Italic, Mark::Strike, Mark::Code, Mark::Link(String::new())]);
    e.clear_history();
    e.focused = true;
    e
}

/// The Markdown the editor holds, whichever way it is being edited.
fn edited(s: &App) -> String {
    if s.rich { md::emit_with(&s.edit.text, s.edit.marks(), s.edit.blocks(), s.edit.soft_breaks(), &s.seps) } else { s.edit.text.clone() }
}

/// The editor field's key. Focus is asked for by it: the page tree keeps the
/// window's focus after a click, and Return would go to its row.
const FIELD: &str = "page-field";

/// Return in the editor. Rune's field is a composer's: Return in a plain
/// paragraph submits, and only Shift-Return breaks the line. A page is a
/// document, so Return starts a new line there. Lists, quotes and code keep
/// Rune's own Return, which continues or leaves them.
fn editor_key(s: &mut App, ev: &KeyEvent, _: &mut Tx) -> bool {
    let plain = ev.mods == rune::Mods::default();
    if ev.key == Key::Enter && plain && s.edit.current_block() == Block::Paragraph {
        s.edit.insert("\n");
        return true;
    }
    false
}

const KEPT_AS_SOURCE: &str = "this page has Markdown the rich editor would rewrite, so it is edited as source";

fn start_edit(s: &mut App) {
    s.old = None;
    let Some(p) = &s.open else { return };
    s.note.clear();
    // rich only when the page comes back from it unchanged (md::exact)
    match (p.kind == "md").then(|| md::exact(&p.body)).flatten() {
        Some(d) => {
            s.edit = rich_edit(d, &mut s.seps);
            s.rich = true;
        }
        None => {
            s.edit = TextEdit::new(p.body.clone());
            s.edit.focused = true;
            s.rich = false;
            if p.kind == "md" {
                s.note = KEPT_AS_SOURCE.into();
            }
        }
    }
    s.editing = true;
}

/// Switches between rich text and source, keeping what was typed.
fn flip_mode(s: &mut App) {
    let body = edited(s);
    if s.rich {
        s.edit = TextEdit::new(body);
        s.edit.focused = true;
        s.rich = false;
        s.note.clear();
    } else {
        match md::exact(&body) {
            Some(d) => {
                s.edit = rich_edit(d, &mut s.seps);
                s.rich = true;
                s.note.clear();
            }
            None => s.note = KEPT_AS_SOURCE.into(),
        }
    }
}

/// Makes the caret's line a heading of `level`, or plain again when it is one.
fn heading(e: &mut TextEdit, level: usize) {
    let caret = e.range().0;
    let Some(line) = e.paragraphs().into_iter().find(|p| p.range.start <= caret && caret <= p.range.end) else { return };
    if line.block != Block::Paragraph {
        return;
    }
    let text = &e.text[line.range.clone()];
    let hashes = text.len() - text.trim_start_matches('#').len();
    let old = if hashes > 0 && text[hashes..].starts_with(' ') { hashes + 1 } else { 0 };
    let new = if old == level + 1 { String::new() } else { format!("{} ", "#".repeat(level)) };
    let end = line.range.end + new.len() - old;
    e.undo_group(|e| {
        e.set_selection(line.range.start, line.range.start + old);
        e.insert(&new);
    });
    e.set_caret(end);
}

/// How the rich field draws what stays as text: headings larger with their
/// `#` dimmed, and fenced code coloured by its language.
fn rich_spans(e: &TextEdit, k: &Kit) -> Vec<Span> {
    let theme = SyntaxTheme::from_kit(k);
    let mut out = Vec::new();
    let paras = e.paragraphs();
    let mut i = 0;
    while i < paras.len() {
        let p = &paras[i];
        let text = &e.text[p.range.clone()];
        if p.block == Block::Code {
            // a fence names its language on its first line
            let lang = text.strip_prefix("```").map(str::trim).filter(|l| !l.is_empty());
            let start = if text.starts_with("```") { p.range.end + 1 } else { p.range.start };
            let mut end = p.range.end;
            while i + 1 < paras.len() && paras[i + 1].block == Block::Code && !e.text[paras[i + 1].range.clone()].starts_with("```") {
                i += 1;
                end = paras[i].range.end;
            }
            if let Some(code) = e.text.get(start.min(end)..end) {
                out.extend(theme.spans(&syntax::highlight(lang, code), start.min(end)));
            }
        } else if p.block == Block::Paragraph {
            let hashes = text.len() - text.trim_start_matches('#').len();
            if (1..=3).contains(&hashes) && text[hashes..].starts_with(' ') {
                let size = [22.0, 18.0, 15.0][hashes - 1];
                out.push(Span::new(p.range.start, p.range.start + hashes).size(size).color(k.c.text_faint));
                out.push(Span::new(p.range.start + hashes, p.range.end).size(size).weight(600.0));
            }
        }
        i += 1;
    }
    out
}

/// The rich editor's formatting bar.
fn format_bar(s: &App, k: &Kit) -> El {
    let e = &s.edit;
    let b = |key: &str, label: &str, on: bool, f: fn(&mut App)| {
        Button::new(label)
            .control_size(ControlSize::Small)
            .variant(if on { ButtonVariant::Contrast } else { ButtonVariant::Ghost })
            // a press takes focus from the field: hand it back, so typing goes on
            .on_press_tx(move |s: &mut App, tx| {
                f(s);
                if s.prompt.is_none() {
                    s.edit.focused = true;
                    tx.focus_when_shown(FIELD, false);
                }
            })
            .build(k)
            .key(format!("fmt-{key}"))
    };
    let blk = e.current_block();
    row()
        .key("format")
        .w_full()
        .gap(4.0)
        .center_y()
        .child(b("bold", "B", e.has_mark(&Mark::Bold), |s| s.edit.toggle_mark(Mark::Bold)))
        .child(b("italic", "I", e.has_mark(&Mark::Italic), |s| s.edit.toggle_mark(Mark::Italic)))
        .child(b("strike", "S", e.has_mark(&Mark::Strike), |s| s.edit.toggle_mark(Mark::Strike)))
        .child(b("code", "<>", e.has_mark(&Mark::Code), |s| s.edit.toggle_mark(Mark::Code)))
        .child(b("link", "Link", e.active_link().is_some(), |s| {
            if s.edit.active_link().is_some() {
                s.edit.set_link(None);
            } else {
                let mut t = TextEdit::new("https://");
                t.focused = true;
                s.prompt = Some(Prompt::Link(t));
            }
        }))
        .child(el().w(8.0))
        .child(b("h1", "H1", false, |s| heading(&mut s.edit, 1)))
        .child(b("h2", "H2", false, |s| heading(&mut s.edit, 2)))
        .child(b("h3", "H3", false, |s| heading(&mut s.edit, 3)))
        .child(el().w(8.0))
        .child(b("bullet", "• List", matches!(blk, Block::Bullet(_)), |s| s.edit.toggle_block(Block::Bullet(0))))
        .child(b("numbered", "1. List", matches!(blk, Block::Numbered(_)), |s| s.edit.toggle_block(Block::Numbered(0))))
        .child(b("quote", "Quote", blk == Block::Quote, |s| s.edit.toggle_block(Block::Quote)))
        .child(b("codeblock", "Code", blk == Block::Code, |s| s.edit.toggle_block(Block::Code)))
}

fn save(s: &mut App) {
    let Some(mut p) = s.open.clone() else { return };
    let base = p.rev;
    p.body = edited(s);
    let memory = s.memory;
    match s.conn.clone() {
        Some(c) => s.save_req.request((c, p), move |(c, mut p)| {
            if memory {
                c.know_save(&format!("/{}", p.name), &p.body)?;
            } else {
                p.rev = c.save(&p, base)?;
            }
            Ok(p)
        }),
        // sample pages: kept for the session, each save a new rev as on a ship
        None => {
            p.rev += 1;
            landed(s, p)
        }
    }
}

fn landed(s: &mut App, p: Page) {
    s.cache.insert(p.name.clone(), p.clone());
    s.open = Some(p);
    s.editing = false;
    s.stale = false;
    s.note = "saved".into();
    sync_map(s);
    sync_sheet(s);
    load_history(s);
}

/// How often the tree is read again, to see what other windows wrote. Each
/// read after the first carries only the bodies written since (`since`).
const SYNC_EVERY: f64 = 30.0;

fn poll(s: &mut App, clock: f64, tx: &mut Tx) -> bool {
    let mut changed = false;
    if s.conn.is_some() && clock >= s.next_sync {
        if s.next_sync > 0.0 {
            load_tree(s);
        }
        s.next_sync = clock + SYNC_EVERY;
        tx.wake_after(std::time::Duration::from_secs_f64(SYNC_EVERY));
    }
    if let Some(r) = s.know_req.take() {
        changed = true;
        match r {
            Ok(knows) => take_knows(s, knows),
            Err(e) => s.note = format!("memory: {e}"),
        }
    }
    if let Some(r) = s.tree_req.take() {
        changed = true;
        // the dump is the pages': while memories show, it lands on the other half
        let away = s.memory;
        if away {
            flip_quiet(s);
        }
        match r {
            Ok(Dump { nodes, since }) => {
                s.since = since;
                s.shares = nodes.iter().filter(|n| n.page && !n.share.is_empty()).map(|n| (n.path.clone(), n.share.clone())).collect();
                // bodies the dump carried replace the kept ones, and pages gone from it go
                let live: std::collections::HashSet<&str> = nodes.iter().filter(|n| n.page).map(|n| n.path.as_str()).collect();
                s.cache.retain(|name, _| live.contains(name.as_str()));
                for n in nodes.iter().filter(|n| n.page) {
                    if let Some(body) = &n.body {
                        s.cache.insert(n.path.clone(), Page { name: n.path.clone(), body: body.clone(), kind: n.kind.clone(), rev: n.rev });
                    }
                }
                // a page being edited that was written elsewhere: say so, since its save would be refused
                if s.editing && !away {
                    s.stale = s.open.as_ref().is_some_and(|p| s.cache.get(&p.name).is_some_and(|c| c.rev > p.rev));
                }
                // the open page follows a write made elsewhere, unless it is being edited
                if !s.editing && !away {
                    if let Some(fresh) = s.open.as_ref().and_then(|p| s.cache.get(&p.name)).filter(|c| s.open.as_ref().is_some_and(|p| c.rev > p.rev)) {
                        s.open = Some(fresh.clone());
                    }
                }
                let first = s.files.is_empty();
                s.names = nodes.iter().filter(|n| n.page).map(|n| n.path.clone()).collect();
                s.files = files_of(nodes, &s.files);
                if first {
                    s.files.expand_all();
                }
                // a page just made or moved is shown where it now is
                if let Some(p) = s.open.as_ref().filter(|_| !away) {
                    s.files.expand_to(&p.name);
                    s.files.select(&p.name);
                }
            }
            Err(e) => s.note = format!("tree: {e}"),
        }
        if away {
            flip_quiet(s);
        }
    }
    if let Some(r) = s.page_req.take() {
        changed = true;
        match r {
            // an answer that lands after a switch to memories is the pages'
            Ok(p) if s.memory => {
                s.other.2.insert(p.name.clone(), p);
            }
            Ok(p) => {
                s.cache.insert(p.name.clone(), p.clone());
                if !s.editing && s.open.as_ref().is_some_and(|o| o.name == p.name) {
                    s.open = Some(p);
                }
            }
            Err(e) => s.note = format!("page: {e}"),
        }
    }
    if let Some(r) = s.login_req.take() {
        changed = true;
        match r {
            Ok(c) => {
                if let Err(e) = c.remember() {
                    s.note = format!("signed in, but the session was not kept: {e}");
                }
                s.code = TextEdit::new("");
                s.conn = Some(c);
                load_tree(s);
                load_know(s);
            }
            Err(e) => s.login_err = e,
        }
    }
    if let Some(r) = s.op_req.take() {
        changed = true;
        match r {
            Ok(op) => applied(s, op),
            Err(e) => s.note = format!("not done: {e}"),
        }
    }
    if let Some(r) = s.hist_req.take() {
        changed = true;
        match r {
            Ok(h) => s.revs = Some(h),
            Err(e) => s.note = format!("history: {e}"),
        }
    }
    if let Some(r) = s.old_req.take() {
        changed = true;
        match r {
            // an answer for a page since left is dropped
            Ok(p) if s.open.as_ref().is_some_and(|o| o.name == p.name) && !s.editing => s.old = Some(p),
            Ok(_) => {}
            Err(e) => s.note = format!("revision: {e}"),
        }
    }
    if let Some(r) = s.save_req.take() {
        changed = true;
        match r {
            Ok(p) => landed(s, p),
            Err(e) => s.note = format!("not saved: {e}"),
        }
    }
    if changed {
        sync_map(s);
        sync_sheet(s);
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

/// The switcher's rows: pages whose name answers the query, then pages
/// whose text holds it, each with the line it was found on.
fn found(s: &App, query: &str) -> Vec<(String, Option<String>)> {
    let mut rows: Vec<(String, Option<String>)> = matches(&s.names, query).into_iter().take(8).map(|n| (n.to_owned(), None)).collect();
    let q = query.trim().to_lowercase();
    if q.chars().count() >= 3 {
        let mut names: Vec<&String> = s.cache.keys().collect();
        names.sort();
        for name in names {
            if rows.len() >= 14 {
                break;
            }
            if rows.iter().any(|r| r.0 == *name) {
                continue;
            }
            if let Some(line) = s.cache[name].body.lines().find(|l| l.to_lowercase().contains(&q)) {
                let line = line.trim();
                let cut = line.char_indices().nth(90).map_or(line.len(), |(i, _)| i);
                rows.push((name.clone(), Some(line[..cut].to_owned())));
            }
        }
    }
    rows
}

fn jump_to(s: &mut App, name: &str, tx: &mut Tx) {
    s.jump = None;
    s.files.reveal(name, tx);
    open_page(s, name);
}

fn switcher(s: &App, k: &Kit, layer: &mut Vec<El>) {
    let Some(q) = &s.jump else { return };
    let hits = found(s, &q.text);
    let field = TextInput::new(q)
        .placeholder("Jump to a page, or search their text")
        .leading_icon(k.glyph.search)
        .on_edit(|s: &mut App| s.jump.as_mut().expect("the switcher is open"))
        .on_change(|s: &mut App, _| s.jump_at = 0)
        .on_key(|s: &mut App, ev: &KeyEvent, tx: &mut Tx| {
            let Some(q) = &s.jump else { return false };
            let hits = found(s, &q.text);
            match ev.key {
                Key::Down => s.jump_at = (s.jump_at + 1).min(hits.len().saturating_sub(1)),
                Key::Up => s.jump_at = s.jump_at.saturating_sub(1),
                Key::Enter => {
                    if let Some(name) = hits.get(s.jump_at).map(|n| n.0.clone()) {
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
    for (i, (name, line)) in hits.iter().enumerate() {
        let (dir, leaf) = name.rsplit_once('/').map_or(("", name.as_str()), |(d, l)| (d, l));
        let pick = name.clone();
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
        if let Some(line) = line {
            r = r.child(text(line.clone()).font(k.ty.small).color(k.c.text_muted).truncate().grow(1.0).min_w(0.0));
        }
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

fn login_view(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let busy = s.login_req.is_pending();
    let mut card = col()
        .key("login")
        .w(380.0)
        .padding(28.0)
        .gap(14.0)
        .radius(k.radius.lg)
        .fill(c.layer_01)
        .border(1.0, c.border_weak)
        .child(text("lattice").font(k.ty.body_medium).color(c.text_base))
        .child(text("Sign in to your ship").font(k.ty.small).color(c.text_muted))
        .child(TextInput::new(&s.url).label("Ship address").placeholder("ship.example.com").on_edit(|s: &mut App| &mut s.url).on_submit(|s: &mut App, _| sign_in(s)).build(k).w_full().key("url"))
        .child(TextInput::new(&s.code).label("Access code").placeholder("+code").secure().on_edit(|s: &mut App| &mut s.code).on_submit(|s: &mut App, _| sign_in(s)).build(k).w_full().key("code"));
    if !s.login_err.is_empty() {
        card = card.child(text(s.login_err.clone()).key("login-error").font(k.ty.small).color(c.danger.icon).wrap());
    }
    let mut go = row().gap(8.0).center_y().child(Button::new("Sign in").variant(ButtonVariant::Contrast).disabled(busy).on_press(sign_in).build(k).key("sign-in"));
    if busy {
        go = go.child(Spinner::new().build(k));
    }
    card = card
        .child(go)
        .child(Button::new("Browse sample pages").variant(ButtonVariant::Ghost).on_press(browse_sample).build(k).key("sample"));
    col().w_full().h_full().center().fill(c.bg_base).child(card)
}

fn prompt_view(s: &App, k: &Kit, layer: &mut Vec<El>) {
    let Some(p) = &s.prompt else { return };
    let field = |t: &TextEdit, hint: &str| {
        TextInput::new(t)
            .placeholder(hint)
            .on_edit(|s: &mut App| match s.prompt.as_mut().expect("a prompt is open") {
                Prompt::New(t) | Prompt::Rename(_, t) | Prompt::Link(t) => t,
                Prompt::Delete(_) => unreachable!("a delete has no field"),
            })
            .on_submit(|s: &mut App, _| confirm(s))
            .build(k)
            .w_full()
            .key("prompt-field")
    };
    let (title, body, verb, variant) = match p {
        Prompt::New(t) => ("New page", field(t, "folder/name"), "Create", ButtonVariant::Contrast),
        Prompt::Rename(_, t) => ("Rename or move", field(t, "folder/name"), "Rename", ButtonVariant::Contrast),
        Prompt::Link(t) => ("Link the selection to", field(t, "https://"), "Link", ButtonVariant::Contrast),
        Prompt::Delete(n) => ("Delete this page?", text(n.clone()).font(k.ty.ui).color(k.c.text_muted).wrap(), "Delete", ButtonVariant::Danger),
    };
    let buttons = row()
        .w_full()
        .gap(8.0)
        .justify_end()
        .child(Button::new("Cancel").variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.prompt = None).build(k).key("prompt-cancel"))
        .child(Button::new(verb).variant(variant).on_press(confirm).build(k).key("prompt-ok"));
    Dialog::new("prompt", title)
        .open(true)
        .width(440.0)
        .fit()
        .on_close(|s: &mut App| s.prompt = None)
        .child(col().w_full().gap(14.0).child(body).child(buttons))
        .build(k, layer);
}

/// Asks the ship to share the open page in `mode`.
fn share_as(s: &mut App, mode: &'static str) {
    let (Some(c), Some(p)) = (s.conn.clone(), &s.open) else {
        s.note = "sample pages cannot be shared".into();
        return;
    };
    let op = Op::Shared(p.name.clone(), mode.to_owned());
    s.op_req.request((c, op), |(c, op)| {
        if let Op::Shared(n, mode) = &op {
            c.share(n, mode)?;
        }
        Ok(op)
    });
}

/// The share dialog: who may read the open page, and where from.
fn share_view(s: &App, k: &Kit, layer: &mut Vec<El>) {
    let (true, Some(p)) = (s.sharing, &s.open) else { return };
    let c = &k.c;
    let now = s.shares.get(&p.name).map_or("private", String::as_str);
    let choice = |mode: &'static str, title: &str, says: &str| {
        let mut r = row()
            .key(format!("share-{mode}"))
            .w_full()
            .px(12.0)
            .py(8.0)
            .gap(10.0)
            .center_y()
            .radius(k.radius.md)
            .border(1.0, if mode == now { c.text_accent } else { c.border_weak })
            .on_press(move |s: &mut App| share_as(s, mode))
            .child(col().gap(2.0).grow(1.0).min_w(0.0).child(text(title.to_owned()).font(k.ty.ui_medium).color(c.text_base)).child(text(says.to_owned()).font(k.ty.small).color(c.text_muted).wrap()));
        if mode == now {
            r = r.child(text("now").font(k.ty.small_medium).color(c.text_accent));
        }
        r
    };
    let mut body = col()
        .w_full()
        .gap(8.0)
        .child(choice("private", "Private", "Only you, signed in to your ship."))
        .child(choice("shared", "Over Urbit", "Ships and groups you grant, at a urb:// address."))
        .child(choice("clearweb", "On the web", "Anyone with the link, with no sign-in."));
    if let Some(addr) = s.conn.as_ref().and_then(|c| c.address(&p.name, now)) {
        let copy = addr.clone();
        body = body.child(
            row()
                .key("share-address")
                .w_full()
                .gap(8.0)
                .center_y()
                .child(text(addr).font(k.ty.mono).color(c.text_base).truncate().grow(1.0).min_w(0.0).selectable(true))
                .child(Button::new("Copy").control_size(ControlSize::Small).on_press_tx(move |s: &mut App, tx| {
                    tx.copy(copy.clone());
                    s.note = "address copied".into();
                }).build(k).key("share-copy")),
        );
    }
    if s.op_req.is_pending() {
        body = body.child(Spinner::new().build(k));
    }
    Dialog::new("share", format!("Share {}", p.name)).open(true).width(460.0).fit().on_close(|s: &mut App| s.sharing = false).child(body).build(k, layer);
}

fn ask_new(s: &mut App) {
    // a new page starts beside the open one
    let dir = s.open.as_ref().and_then(|p| p.name.rsplit_once('/')).map_or(String::new(), |(d, _)| format!("{d}/"));
    let mut t = TextEdit::new(dir);
    t.focused = true;
    s.prompt = Some(Prompt::New(t));
}

fn ask_rename(s: &mut App) {
    if let Some(p) = &s.open {
        let mut t = TextEdit::new(p.name.clone());
        t.focused = true;
        s.prompt = Some(Prompt::Rename(p.name.clone(), t));
    }
}

fn ask_delete(s: &mut App) {
    if let Some(p) = &s.open {
        s.prompt = Some(Prompt::Delete(p.name.clone()));
    }
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
        .placeholder(if s.memory { "Filter memories" } else { "Filter pages" })
        .leading_icon(k.glyph.search)
        .clear_button()
        .on_edit(|s: &mut App| &mut s.query)
        .on_change(|s: &mut App, _| {
            let q = s.query.text.trim().to_lowercase();
            if q.is_empty() { s.files.clear_filter() } else { s.files.filter(|n| n.path.to_lowercase().contains(&q)) }
        })
        .build(k)
        .w_full();
    let half = |key: &str, label: String, on: bool| {
        Button::new(label)
            .control_size(ControlSize::Small)
            .variant(if on { ButtonVariant::Contrast } else { ButtonVariant::Ghost })
            .on_press(move |s: &mut App| {
                // the half that is showing does nothing when pressed
                if !on {
                    flip(s);
                }
            })
            .build(k)
            .key(key.to_owned())
    };
    let (pages, knows) = if s.memory { (s.other.1.len(), s.names.len()) } else { (s.names.len(), s.other.1.len()) };
    let halves = row().key("halves").w_full().gap(4.0).child(half("half-pages", format!("Pages {pages}"), !s.memory)).child(half("half-memory", format!("Memory {knows}"), s.memory));
    let new = Button::new(if s.memory { "New memory" } else { "New page" }).variant(ButtonVariant::Ghost).on_press(ask_new).build(k).key("new");
    let who = s.conn.as_ref().map_or("sample pages".to_owned(), |c| c.ship().to_owned());
    let foot = row()
        .w_full()
        .center_y()
        .justify_between()
        .child(text(who).key("ship").font(k.ty.small_medium).color(k.c.text_muted))
        .child(Button::new(if s.conn.is_some() { "Sign out" } else { "Close" }).variant(ButtonVariant::GhostMuted).on_press(sign_out).build(k).key("sign-out"));
    let mut side = col().key("pages").w_full().h_full().min_h(0.0).padding(8.0).gap(8.0).child(halves).child(filter).child(new).child(tree).child(foot);
    if !s.note.is_empty() {
        side = side.child(text(s.note.clone()).key("note").font(k.ty.small).color(k.c.text_muted).wrap());
    }
    side
}

/// The history pane: the open page's revisions, newest first.
fn history_view(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let mut list = col().key("revs").w_full().gap(2.0);
    let name = s.open.as_ref().map(|p| p.name.as_str());
    match s.revs.as_ref().filter(|(n, _)| Some(n.as_str()) == name) {
        Some((_, revs)) => {
            let shown = s.old.as_ref().map_or(s.open.as_ref().map_or(0, |p| p.rev), |o| o.rev);
            for r in revs {
                let rev = r.rev;
                let mut line = row()
                    .key(format!("rev-{rev}"))
                    .w_full()
                    .h(30.0)
                    .px(8.0)
                    .gap(8.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .on_press(move |s: &mut App| view_rev(s, rev))
                    .child(text(r.when()).font(k.ty.small).color(c.text_base).grow(1.0))
                    .child(text(format!("rev {rev}")).font(k.ty.small).color(c.text_faint));
                if rev == shown {
                    line = line.fill(k.selection());
                }
                list = list.child(line);
            }
        }
        None => list = list.child(text(if s.conn.is_some() { "Reading the history" } else { "Sample pages keep no history" }).font(k.ty.small).color(c.text_muted)),
    }
    col()
        .key("history")
        .w_full()
        .h_full()
        .min_h(0.0)
        .padding(12.0)
        .gap(8.0)
        .child(text("History").font(k.ty.ui_medium).color(c.text_base))
        .child(col().w_full().grow(1.0).min_h(0.0).child(list).scroll(ScrollSpec { stick_bottom: false }))
}

/// A line across the top of the page that says something and offers one way out.
fn banner(key: &str, say: String, verb: &str, act: fn(&mut App), k: &Kit) -> El {
    row()
        .key(key.to_owned())
        .w_full()
        .px(16.0)
        .py(8.0)
        .gap(12.0)
        .center_y()
        .fill(k.c.layer_01)
        .child(text(say).font(k.ty.small).color(k.c.text_base).wrap().grow(1.0).min_w(0.0))
        .child(Button::new(verb).control_size(ControlSize::Small).on_press(act).build(k).key(format!("{key}-act")))
}

fn body(s: &App, k: &Kit) -> El {
    let inner = page_body(s, k);
    let top = if let Some(o) = s.old.as_ref().filter(|_| !s.editing) {
        // an old revision can be read, restored, or left
        Some(
            row()
                .key("old-banner")
                .w_full()
                .px(16.0)
                .py(8.0)
                .gap(8.0)
                .center_y()
                .fill(k.c.layer_01)
                .child(text(format!("Reading revision {}, not the page as it is now", o.rev)).font(k.ty.small).color(k.c.text_base).grow(1.0))
                .child(Button::new("Restore this").control_size(ControlSize::Small).variant(ButtonVariant::Contrast).on_press(restore).build(k).key("restore"))
                .child(Button::new("Back to now").control_size(ControlSize::Small).on_press(|s: &mut App| s.old = None).build(k).key("leave-old")),
        )
    } else if s.editing && s.stale {
        Some(banner(
            "stale",
            "This page was changed somewhere else while you were editing. Saving now would be refused.".into(),
            "Save over theirs",
            |s| {
                // the owner's choice: take the newest rev as the base, so the save lands
                if let Some(newest) = s.open.as_ref().and_then(|p| s.cache.get(&p.name)).map(|c| c.rev) {
                    if let Some(p) = &mut s.open {
                        p.rev = newest;
                    }
                    s.stale = false;
                    save(s);
                }
            },
            k,
        ))
    } else {
        None
    };
    match top {
        Some(t) => col().w_full().h_full().min_h(0.0).child(t).child(col().w_full().grow(1.0).min_h(0.0).child(inner)),
        None => inner,
    }
}

fn page_body(s: &App, k: &Kit) -> El {
    let c = &k.c;
    // an old revision is read in the open page's place
    let Some(p) = s.old.as_ref().filter(|_| !s.editing).or(s.open.as_ref()) else {
        return col().w_full().h_full().center().child(text("Pick a page").font(k.ty.ui).color(c.text_muted));
    };
    if s.editing && s.rich {
        let field = TextArea::new(&s.edit)
            .label("Page")
            .width(None)
            .decorations(rich_spans(&s.edit, k))
            .on_edit(|s: &mut App| &mut s.edit)
            .on_key(editor_key)
            .build(k)
            .key(FIELD)
            .w_full()
            .grow(1.0)
            .min_h(0.0);
        return col()
            .key("editor")
            .w_full()
            .h_full()
            .min_h(0.0)
            .items_center()
            .child(col().w_full().max_w(820.0).h_full().min_h(0.0).padding(16.0).gap(8.0).child(format_bar(s, k)).child(Divider::horizontal().build(k)).child(field));
    }
    if s.editing {
        // the source, coloured as Markdown: colour only, so nothing moves as it is typed
        let marks = SyntaxTheme::from_kit(k).spans(&syntax::highlight(Some("markdown"), &s.edit.text), 0);
        let source = TextArea::new(&s.edit).label("Page source").decorations(marks).on_edit(|s: &mut App| &mut s.edit).on_key(editor_key).build(k).key(FIELD).w_full().h_full().min_h(0.0);
        let mut panes = row().key("editor").w_full().h_full().min_h(0.0).padding(16.0).gap(16.0).child(col().grow(1.0).h_full().min_h(0.0).child(source));
        if s.preview && p.kind == "md" {
            let shown = col().key("preview-page").w_full().padding(12.0).child(Markdown::new(s.edit.text.clone()).build(k));
            panes = panes.child(col().key("preview").grow(1.0).h_full().min_h(0.0).child(shown).scroll(ScrollSpec { stick_bottom: false }));
        }
        return panes;
    }
    if let Some(v) = s.sheet.as_ref().filter(|v| v.name == p.name && v.rev == p.rev) {
        return sheet_view(v, s, k);
    }
    if let Some(m) = s.map.as_ref().filter(|m| m.name == p.name && m.rev == p.rev) {
        return map_view(m, k);
    }
    let shown = if p.kind == "md" {
        Markdown::new(md::wikilinks(&p.body)).selectable(true).on_link_tx(follow).build(k)
    } else {
        // other kinds draw as their source, coloured, until each has a native view
        let lang = match p.kind.as_str() {
            "geojson" => Some("json"),
            "html" | "fods" | "svg" => Some("html"),
            "hoon" | "scad" | "tex" | "gmi" | "text" => None,
            other => Some(other),
        };
        // a spreadsheet's XML can run to megabytes: draw the start of it
        let cut = (0..=p.body.len().min(200_000)).rev().find(|&i| p.body.is_char_boundary(i)).unwrap_or(0);
        let shown = &p.body[..cut];
        let spans = SyntaxTheme::from_kit(k).spans(&syntax::highlight(lang, shown), 0);
        rune::rich(shown.to_owned(), spans).font(k.ty.mono).color(c.text_base).wrap().selectable(true)
    };
    let mut page = col().w_full().max_w(760.0).padding(28.0).gap(12.0);
    if let Some((tags, updated)) = s.know_meta.get(&p.name).filter(|_| s.memory) {
        let when = Rev { rev: 0, updated: updated.clone() }.when();
        let mut meta = row().key("know-meta").gap(6.0).center_y().child(text(when).font(k.ty.small).color(c.text_faint));
        for t in tags {
            meta = meta.child(row().px(6.0).py(1.0).radius(k.radius.sm).fill(c.layer_01).child(text(t.clone()).font(k.ty.small).color(c.text_muted)));
        }
        page = page.child(meta);
    }
    col()
        .key("reader")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(col().key(format!("page:{}", p.name)).w_full().items_center().child(page.child(shown)))
        .scroll(ScrollSpec { stick_bottom: false })
}

fn view(s: &App, cx: &mut Cx<App>) -> El {
    let k = Kit::neutral(cx.system_dark());
    if s.conn.is_none() && !s.sample {
        return login_view(s, &k);
    }
    let title = s.open.as_ref().map_or("lattice", |p| p.name.as_str());
    let busy = s.tree_req.is_pending() || s.page_req.is_pending() || s.save_req.is_pending();
    let mut trailing = row().gap(8.0).center_y();
    if busy {
        trailing = trailing.child(Spinner::new().build(&k));
    }
    if s.editing {
        trailing = trailing
            .child(Button::new(if s.rich { "Source" } else { "Rich text" }).variant(ButtonVariant::GhostMuted).on_press_tx(|s: &mut App, tx| {
                flip_mode(s);
                tx.focus_when_shown(FIELD, false);
            }).build(&k).key("mode"));
        if !s.rich {
            trailing = trailing.child(Button::new(if s.preview { "Hide preview" } else { "Preview" }).variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| s.preview ^= true).build(&k).key("preview-toggle"));
        }
        trailing = trailing
            .child(Button::new("Cancel").variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.editing = false).build(&k).key("cancel"))
            .child(Button::new("Save").variant(ButtonVariant::Contrast).on_press(save).build(&k).key("save"));
    } else if s.open.is_some() {
        // a memory has no sharing, history pane or rename here
        if !s.memory {
            let shared = s.open.as_ref().and_then(|p| s.shares.get(&p.name)).is_some_and(|m| m != "private");
            trailing = trailing.child(Button::new(if shared { "Shared" } else { "Share" }).variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| s.sharing = true).build(&k).key("share"));
        }
        if !s.memory {
            trailing = trailing.child(Button::new("History").variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| {
                s.inspector.toggle();
                s.old = None;
                load_history(s);
            }).build(&k).key("history-toggle"));
        }
        trailing = trailing.child(Button::new("Delete").variant(ButtonVariant::GhostMuted).on_press(ask_delete).build(&k).key("delete"));
        if !s.memory {
            trailing = trailing.child(Button::new("Rename").variant(ButtonVariant::GhostMuted).on_press(ask_rename).build(&k).key("rename"));
        }
        trailing = trailing
            .child(Button::new("Edit").variant(ButtonVariant::Ghost).on_press_tx(|s: &mut App, tx| {
                start_edit(s);
                tx.focus_when_shown(FIELD, false);
            }).build(&k).key("edit"));
    }
    let mut layer = Vec::new();
    switcher(s, &k, &mut layer);
    prompt_view(s, &k, &mut layer);
    share_view(s, &k, &mut layer);
    let nav = |key: &str, label: &str, by: isize, on: bool| {
        Button::new(label).variant(ButtonVariant::GhostMuted).disabled(!on).on_press(move |s: &mut App| step(s, by)).build(&k).key(key.to_owned())
    };
    let leading = row()
        .gap(2.0)
        .center_y()
        .child(nav("back", "‹", -1, s.trail_at > 0 && !s.editing))
        .child(nav("forward", "›", 1, s.trail_at + 1 < s.trail.len() && !s.editing))
        // the title sits beside them, not centred: a centred one ran under the buttons in a narrow window
        .child(text(title.to_owned()).key("title").font(k.ty.ui_medium).color(k.c.text_base).truncate().pl(6.0));
    let shell = SplitView::new(body(s, &k))
        .sidebar(&s.sidebar, |s: &mut App| &mut s.sidebar, sidebar(s, &k))
        .inspector(&s.inspector, |s: &mut App| &mut s.inspector, history_view(s, &k))
        .toolbar(Toolbar::new().leading(leading).trailing(trailing))
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
        .reduced_motion(cx.is_reduced_motion())
        .build(&k);
    rune_kit::root(shell, layer)
}

fn on_key(s: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if s.conn.is_none() && !s.sample {
        return false;
    }
    if ev.mods.alt && matches!(ev.key, Key::Left | Key::Right) {
        step(s, if ev.key == Key::Left { -1 } else { 1 });
        return true;
    }
    if ev.is_command('n') && !s.editing {
        ask_new(s);
        return true;
    }
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
        tx.focus_when_shown(FIELD, false);
        return true;
    }
    if ev.is_command('r') {
        load_know(s);
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
        scenes: &[("login", |s| s.login_err = "that access code was refused".into()), ("reading", |s| {
            browse_sample(s);
            open_page(s, "welcome");
        }), ("memory", |s| {
            browse_sample(s);
            flip(s);
            open_page(s, "feedback/short-answers");
        }), ("sheet", |s| {
            browse_sample(s);
            open_page(s, "budget");
        }), ("map", |s| {
            browse_sample(s);
            open_page(s, "places");
            if let Some(m) = &mut s.map {
                m.picked = Some(0);
            }
        }), ("rename", |s| {
            browse_sample(s);
            open_page(s, "notes/today");
            ask_rename(s);
        }), ("jump", |s| {
            browse_sample(s);
            open_page(s, "welcome");
            let mut q = TextEdit::new("no");
            q.focused = true;
            s.jump = Some(q);
        }), ("rich", |s| {
            browse_sample(s);
            open_page(s, "welcome");
            start_edit(s);
            s.edit.set_selection(42, 46);
        }), ("editing", |s| {
            browse_sample(s);
            open_page(s, "welcome");
            start_edit(s);
            if s.rich {
                flip_mode(s);
            }
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

    #[test]
    fn a_map_page_opens_as_a_map_and_keeps_its_camera_across_a_save() {
        let mut s = sample("places");
        let m = s.map.as_ref().expect("the sample map parses");
        assert_eq!((m.feats.len(), m.fitted), (4, false));
        // the view lays out, the owner zooms, then edits the source and saves
        let m = s.map.as_mut().unwrap();
        m.cam = map::Camera::fit(&m.feats, 800.0, 500.0);
        m.fitted = true;
        m.cam.zoom_at(2.0, 400.0, 250.0, 800.0, 500.0);
        let cam = m.cam;
        start_edit(&mut s);
        assert!(!s.rich, "a map is edited as source");
        let body = s.edit.text.replace("Brooklyn", "Kings County");
        s.edit = TextEdit::new(body);
        save(&mut s);
        let m = s.map.as_ref().unwrap();
        assert_eq!((m.cam, m.fitted), (cam, true), "the camera stays where it was");
        assert!(m.feats.iter().any(|f| f.name == "Kings County"));
        // another kind of page has no map, and a broken map shows as source
        open_page(&mut s, "welcome");
        assert!(s.map.is_none());
        s.cache.get_mut("places").unwrap().body = "{ not json".into();
        open_page(&mut s, "places");
        assert!(s.map.is_none());
    }

    #[test]
    fn a_spreadsheet_page_opens_as_a_grid_and_follows_its_text() {
        let mut s = sample("budget");
        let v = s.sheet.as_ref().expect("the sample sheet parses");
        assert_eq!((v.sheets.len(), v.sheets[0].rows.len(), v.sheets[0].width()), (2, 4, 3));
        s.sheet.as_mut().unwrap().at = 1;
        // a new revision of the same page keeps the sheet that was showing
        let p = s.open.as_mut().unwrap();
        p.body = p.body.replace("Hosting", "Servers");
        p.rev += 1;
        sync_sheet(&mut s);
        let v = s.sheet.as_ref().unwrap();
        assert_eq!((v.at, v.sheets[0].rows[1][0].as_str()), (1, "Servers"));
        open_page(&mut s, "welcome");
        assert!(s.sheet.is_none());
    }

    #[test]
    fn memories_are_a_second_half_with_their_own_tree_and_texts() {
        let mut s = sample("welcome");
        let pages = s.names.len();
        flip(&mut s);
        assert!(s.memory && s.open.is_none() && s.trail.is_empty());
        assert_eq!(s.names, ["feedback/short-answers", "project/lattice/rune"]);
        open_page(&mut s, "feedback/short-answers");
        assert!(s.open.as_ref().unwrap().body.starts_with("Keep answers short."));
        // an edit there is kept there, and the switcher searches memories
        start_edit(&mut s);
        s.edit = TextEdit::new("Keep answers very short.\n");
        s.rich = false;
        save(&mut s);
        assert_eq!(s.cache["feedback/short-answers"].body, "Keep answers very short.\n");
        assert_eq!(found(&s, "native client")[0].0, "project/lattice/rune");
        // a list read from the ship while pages show lands on the memory half
        flip(&mut s);
        assert_eq!((s.memory, s.names.len()), (false, pages));
        take_knows(&mut s, vec![Know { key: "/a/b".into(), body: "fact".into(), tags: vec!["t".into()], updated: String::new() }]);
        assert_eq!((s.names.len(), s.other.1.clone(), s.other.2["a/b"].body.as_str()), (pages, vec!["a/b".to_owned()], "fact"));
        assert!(s.cache.contains_key("welcome") && !s.cache.contains_key("a/b"), "and not among the pages");
        // editing holds the switch
        open_page(&mut s, "welcome");
        start_edit(&mut s);
        flip(&mut s);
        assert!(!s.memory);
    }

    #[test]
    fn back_and_forward_walk_the_pages_visited() {
        let mut s = sample("welcome");
        open_page(&mut s, "notes/today");
        open_page(&mut s, "notes/ideas/maps");
        let at = |s: &App| s.open.as_ref().unwrap().name.clone();
        step(&mut s, -1);
        assert_eq!(at(&s), "notes/today");
        step(&mut s, -1);
        step(&mut s, -1);
        assert_eq!(at(&s), "welcome", "back stops at the first page");
        step(&mut s, 1);
        assert_eq!(at(&s), "notes/today");
        // a new visit from the middle drops what was ahead
        open_page(&mut s, "journal/2026-11-17");
        step(&mut s, 1);
        assert_eq!((at(&s), s.trail.len()), ("journal/2026-11-17".to_owned(), 3));
    }

    #[test]
    fn the_switcher_also_finds_pages_by_their_text() {
        let s = sample("welcome");
        // "mermaid" is in no name, and in the text of one page
        assert_eq!(found(&s, "mermaid"), [("notes/ideas/maps".to_owned(), Some("```mermaid".to_owned()))]);
        // a name match comes first and is not listed twice
        let rows = found(&s, "today");
        assert_eq!(rows[0], ("notes/today".to_owned(), None));
        assert_eq!(rows.iter().filter(|r| r.0 == "notes/today").count(), 1);
        assert!(found(&s, "zq").is_empty(), "two letters search names only");
    }

    /// The sample pages with `name` open, and no ship.
    fn sample(name: &str) -> App {
        let mut s = init();
        s.conn = None;
        browse_sample(&mut s);
        open_page(&mut s, name);
        s
    }

    #[test]
    fn a_page_opened_rich_and_saved_untouched_is_unchanged() {
        let mut s = sample("welcome");
        let before = s.open.as_ref().unwrap().body.clone();
        start_edit(&mut s);
        assert!(s.rich, "the sample page is one the rich editor holds");
        assert_eq!(edited(&s), before);
        save(&mut s);
        assert_eq!(s.cache["welcome"].body, before);
        assert!(!s.editing);
    }

    #[test]
    fn formatting_in_the_rich_editor_is_saved_as_markdown() {
        let mut s = sample("notes/today");
        start_edit(&mut s);
        assert_eq!(s.edit.text, "# Today\nA short note with a link.");
        let at = s.edit.text.find("short").unwrap();
        s.edit.set_selection(at, at + 5);
        s.edit.toggle_mark(Mark::Bold);
        s.edit.set_caret(s.edit.text.len());
        heading(&mut s.edit, 2);
        assert_eq!(edited(&s), "# Today\n\n## A **short** note with a [link](https://urbit.org).\n");
        heading(&mut s.edit, 2);
        s.edit.set_caret(s.edit.text.len());
        s.edit.toggle_block(Block::Bullet(0));
        save(&mut s);
        assert_eq!(s.cache["notes/today"].body, "# Today\n\n- A **short** note with a [link](https://urbit.org).\n");
    }

    #[test]
    fn switching_between_rich_and_source_keeps_the_text() {
        let mut s = sample("welcome");
        let before = s.open.as_ref().unwrap().body.clone();
        start_edit(&mut s);
        flip_mode(&mut s);
        assert!(!s.rich);
        assert_eq!(s.edit.text, before);
        flip_mode(&mut s);
        assert!(s.rich);
        assert_eq!(edited(&s), before);
    }

    #[test]
    fn a_page_the_rich_editor_would_rewrite_opens_as_source() {
        let mut s = sample("welcome");
        let odd = "1. one\n1. numbered by hand\n";
        s.open.as_mut().unwrap().body = odd.into();
        start_edit(&mut s);
        assert!(!s.rich);
        assert_eq!((s.edit.text.as_str(), s.note.as_str()), (odd, KEPT_AS_SOURCE));
        flip_mode(&mut s);
        assert!(!s.rich, "and stays source when asked to go rich");
        assert_eq!(edited(&s), odd);
    }
}
