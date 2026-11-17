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

use api::{Ask, Asks, Comment, Conn, Notice, Opens, Waiting, Dump, Group, Know, Level, Node, Page, Prefs, Rev, Shared};
use rune::{AppSpec, Block, LineCap, Phase, Shape, WheelEvent, canvas, Chrome, Cx, El, Key, KeyEvent, Latest, Mark, ScrollSpec, Span, TextEdit, Tx, Waker, col, el, row, text};
use rune_kit::shell::{self, PaneState, SplitView, Toolbar};
use rune_kit::syntax::{self, SyntaxTheme};
use rune_kit::{Cell, Table, TableColumn, TableState};
use rune_kit::Switch;
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
    /// A note to go with an ask for edit on another ship's page.
    Ask(Shared, TextEdit),
}

/// A change to the tree that landed on the ship.
enum Op {
    Created(String),
    Renamed(String, String),
    Deleted(String),
    /// A page's share mode was set, or a folder's.
    Shared(String, String),
    SharedDir(String, String),
    /// A page or folder was marked sensitive or unmarked, and whether its
    /// own share still stands.
    Sensed(String, bool, bool),
    /// An ask was sent or answered: what to say.
    Asked(String),
    /// Something about comments changed on the ship: what to say.
    Commented(String),
    /// A ship was let in to a page (edit or read, and whether it was told),
    /// or put out again.
    Granted(String, String, bool, bool),
    Ungranted(String, String),
    /// A group was written or deleted: what to say about it.
    Grouped(String),
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
    /// The open page is a capture not saved yet: it has a name in the
    /// inbox and no page on the ship until its first save.
    capture: bool,
    /// Autosave: when the text is next looked at, what it was at the last
    /// look, whether the save on the wire is one of its own (the editor
    /// stays open), whether a Save was pressed while one was on the wire,
    /// and whether it stands down after a refusal until a Save on purpose.
    next_auto: f64,
    auto_seen: Option<String>,
    autosaving: bool,
    save_again: bool,
    auto_held: bool,
    /// What is kept between runs, and whether the last page was opened again.
    prefs: Prefs,
    restored: bool,
    /// The page asked for whose text has not come yet: a page just made,
    /// or one opened before the first tree arrived. Its answer is shown.
    want: Option<String>,
    /// The folder picked in the tree, shown in place of a page.
    folder: Option<String>,
    /// The name to show for a page or folder, where it was given one.
    dnames: HashMap<String, String>,
    /// Each page's share mode, as the last dump said, and whether the
    /// share dialog is open.
    shares: HashMap<String, String>,
    /// Each folder's own share setting.
    dshares: HashMap<String, String>,
    sharing: bool,
    /// The side pane shows comments, not history. The newest comments
    /// across the ship, whether comments are on for each page asked
    /// about, and the comment being typed.
    pane_comments: bool,
    /// The side pane shows links: the pages that link to the one named,
    /// as the ship last said.
    pane_links: bool,
    back: Option<(String, Vec<String>)>,
    back_req: Latest<Result<(String, Vec<String>), String>>,
    comments: Vec<Comment>,
    comments_req: Latest<Result<Vec<Comment>, String>>,
    comments_on: HashMap<String, bool>,
    comments_on_req: Latest<Result<(String, bool), String>>,
    comment: TextEdit,
    /// Comet comments waiting for a yes, and what each page asked about
    /// does with comets' comments (`open`, `held`, `off`).
    /// The activity notices, and how much waits (for the button's count).
    /// Asks for edit: the ones waiting on this ship and the ones it sent.
    asks: Asks,
    asks_req: Latest<Result<Asks, String>>,
    notices: Vec<Notice>,
    notices_req: Latest<Result<Vec<Notice>, String>>,
    waiting: Waiting,
    waiting_req: Latest<Result<Waiting, String>>,
    held: Vec<Comment>,
    held_req: Latest<Result<Vec<Comment>, String>>,
    comets: HashMap<String, String>,
    comets_req: Latest<Result<(String, String), String>>,
    /// The sensitive mark of each page and folder asked about so far.
    sens: HashMap<String, bool>,
    sens_req: Latest<Result<(String, bool), String>>,
    /// The ship's access list, read when the share dialog opens, and the
    /// ship being typed there.
    groups: Vec<Group>,
    groups_req: Latest<Result<Vec<Group>, String>>,
    grant_to: TextEdit,
    /// Where the lattice lives on the ship (the start of grant paths), the
    /// access screen in place of a page, and the new group being typed.
    base: String,
    base_req: Latest<Result<String, String>>,
    access: bool,
    group_name: TextEdit,
    group_ships: TextEdit,
    /// What other ships shared with this one, the list on screen in place
    /// of a page, and the shared page that is open (its notice).
    shared: Vec<Shared>,
    shared_req: Latest<Result<Vec<Shared>, String>>,
    shared_open: bool,
    /// The comments of every page show in place of a page.
    inbox: bool,
    remote: Option<Shared>,
    remote_req: Latest<Result<(Shared, Page), String>>,
    /// The banned ships, and the one being typed to ban.
    bans: Vec<String>,
    bans_req: Latest<Result<Vec<String>, String>>,
    ban_who: TextEdit,
    /// The group whose ships are being changed, and the ships as typed.
    group_edit: Option<(String, TextEdit)>,
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
    /// The command palette, when open: what is typed and the row chosen.
    palette: Option<TextEdit>,
    palette_at: usize,
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
    let shown: Vec<(String, String)> = nodes.iter().filter(|n| !n.dname.is_empty()).map(|n| (n.path.clone(), n.dname.clone())).collect();
    let pages: Vec<Node> = nodes.into_iter().filter(|n| n.page).collect();
    // a refreshed tree keeps what was open and selected
    let open: Vec<String> = pages
        .iter()
        .flat_map(|n| n.path.match_indices('/').map(|(i, _)| n.path[..i].to_owned()))
        .filter(|d| keep.is_expanded(d))
        .collect();
    let mut m = FileTree::new().build(pages.into_iter().map(|n| (n.path.clone(), n)));
    // a row shows the name its page or folder was given. A row that stands
    // for several folders at once (a/b/c) keeps its path.
    for (path, name) in shown {
        if let Some(n) = m.get_mut(&path).filter(|n| !n.name.contains('/')) {
            n.name = name;
        }
    }
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
        capture: false,
        next_auto: 0.0,
        auto_seen: None,
        autosaving: false,
        save_again: false,
        auto_held: false,
        prefs: Prefs::load(),
        restored: false,
        want: None,
        folder: None,
        dnames: HashMap::new(),
        shares: HashMap::new(),
        dshares: HashMap::new(),
        sharing: false,
        pane_comments: false,
        pane_links: false,
        back: None,
        back_req: Latest::default(),
        comments: Vec::new(),
        comments_req: Latest::default(),
        comments_on: HashMap::new(),
        comments_on_req: Latest::default(),
        comment: TextEdit::new(""),
        asks: Asks::default(),
        asks_req: Latest::default(),
        notices: Vec::new(),
        notices_req: Latest::default(),
        waiting: Waiting::default(),
        waiting_req: Latest::default(),
        held: Vec::new(),
        held_req: Latest::default(),
        comets: HashMap::new(),
        comets_req: Latest::default(),
        sens: HashMap::new(),
        sens_req: Latest::default(),
        groups: Vec::new(),
        groups_req: Latest::default(),
        grant_to: TextEdit::new(""),
        base: String::new(),
        base_req: Latest::default(),
        access: false,
        group_name: TextEdit::new(""),
        group_ships: TextEdit::new(""),
        shared: Vec::new(),
        shared_req: Latest::default(),
        shared_open: false,
        inbox: false,
        remote: None,
        remote_req: Latest::default(),
        bans: Vec::new(),
        bans_req: Latest::default(),
        ban_who: TextEdit::new(""),
        group_edit: None,
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
        palette: None,
        palette_at: 0,
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
        // a page another ship shared, to open from the list
        s.shared = vec![Shared { host: "~sampel-palnet".into(), path: "/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app/page/plans/trip/code".into(), mode: "edit".into(), when: "~2026.11.16..18.5.0".into() }];
        // and one shared read-only, whose host can be asked for more
        s.shared.push(Shared { host: "~sampel-palnet".into(), path: "/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app/page/plans/budget/code".into(), mode: "read".into(), when: "~2026.11.16..8.0.0".into() });
        s.held = vec![Comment { page: "welcome".into(), id: "0v1.sample".into(), author: "~doznec-salfun-naptul-habrys--todlux-mosmep-linsub-binzod".into(), when: "~2026.11.17..9.30.0".into(), body: "Held until you say yes.".into() }];
        s.notices = vec![
            Notice { id: "0v1.note".into(), kind: "comment".into(), when: "~2026.11.17..9.31.0".into(), who: "~sampel-palnet".into(), host: "~zod".into(), place: "notes/today".into(), body: "A good day by the sound of it.".into(), ..Notice::default() },
            Notice { id: "0v2.note".into(), kind: "reply".into(), when: "~2026.11.16..18.0.0".into(), who: "~sampel-palnet".into(), host: "~zod".into(), place: "tech".into(), title: "Rune".into(), read: true, ..Notice::default() },
        ];
        s.waiting = Waiting { held: 1, unread: 1 };
        s.asks.pending = vec![Ask { ship: "~sampel-palnet".into(), path: "/x/page/notes/today/code".into(), name: "notes/today".into(), note: "I have a few fixes.".into(), when: "~2026.11.17..9.40.0".into() }];
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
    s.want = None;
    s.old = None;
    s.trail.clear();
    s.trail_at = 0;
    s.folder = None;
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
    fresh.groups_req = std::mem::take(&mut s.groups_req);
    fresh.base_req = std::mem::take(&mut s.base_req);
    fresh.bans_req = std::mem::take(&mut s.bans_req);
    fresh.sens_req = std::mem::take(&mut s.sens_req);
    fresh.comments_req = std::mem::take(&mut s.comments_req);
    fresh.comments_on_req = std::mem::take(&mut s.comments_on_req);
    fresh.held_req = std::mem::take(&mut s.held_req);
    fresh.notices_req = std::mem::take(&mut s.notices_req);
    fresh.back_req = std::mem::take(&mut s.back_req);
    fresh.asks_req = std::mem::take(&mut s.asks_req);
    fresh.waiting_req = std::mem::take(&mut s.waiting_req);
    fresh.comets_req = std::mem::take(&mut s.comets_req);
    fresh.shared_req = std::mem::take(&mut s.shared_req);
    fresh.remote_req = std::mem::take(&mut s.remote_req);
    fresh.old_req = std::mem::take(&mut s.old_req);
    fresh.sidebar = s.sidebar.clone();
    *s = fresh;
}

/// Asks the ship for the change the open prompt names.
fn confirm(s: &mut App) {
    let Some(p) = s.prompt.take() else { return };
    if let Prompt::Ask(sh, t) = &p {
        let (sh, note) = (sh.clone(), t.text.clone());
        match s.conn.clone() {
            Some(c) => {
                s.note = format!("asking {}", sh.host);
                s.op_req.request((c, sh, note), |(c, sh, note)| {
                    c.ask_edit(&sh.host, &sh.path, &note)?;
                    Ok(Op::Asked(format!("asked {} for edit access to {}", sh.host, sh.name())))
                });
            }
            None => {
                s.note = format!("asked {} for edit access to {}", sh.host, sh.name());
                s.asks.sent.push(Ask { ship: sh.host.clone(), path: sh.path.clone(), name: sh.name().to_owned(), note: api::clip_note(note.trim()).to_owned(), when: String::new() });
            }
        }
        return;
    }
    if let Prompt::Link(t) = &p {
        let url = t.text.trim();
        if !url.is_empty() && !url.contains(char::is_whitespace) {
            s.edit.set_link(Some(url));
        }
        s.edit.focused = true;
        return;
    }
    // a typed name becomes a path and the names to show (api::real_name)
    let typed = match &p {
        Prompt::New(t) | Prompt::Rename(_, t) => Some(t.text.clone()),
        _ => None,
    };
    let rn = match typed.as_deref().map(api::real_name) {
        Some(None) => {
            s.note = "that name has nothing a path can keep".into();
            return;
        }
        Some(Some(rn)) => rn,
        None => api::RealName { name: String::new(), dname: String::new(), dnames: String::new() },
    };
    let op = match p {
        Prompt::New(_) => Op::Created(rn.name.clone()),
        Prompt::Rename(from, _) if rn.name != from || !rn.dnames.is_empty() => Op::Renamed(from, rn.name.clone()),
        Prompt::Delete(name) => Op::Deleted(name),
        _ => return,
    };
    // the names show at once, and the next dump says what the ship kept
    if !s.memory {
        if let Op::Renamed(from, _) = &op {
            s.dnames.remove(from);
        }
        s.dnames.extend(rn.shown());
    }
    let memory = s.memory;
    match s.conn.clone() {
        Some(c) => s.op_req.request((c, op), move |(c, op)| {
            match &op {
                Op::Created(n) if memory => c.know_save(&format!("/{n}"), &format!("{}\n", n.rsplit('/').next().unwrap_or(n)))?,
                Op::Deleted(n) if memory => c.know_delete(&format!("/{n}"))?,
                Op::Renamed(..) if memory => return Err("a memory is not renamed here".into()),
                Op::Created(_) => c.create_as(&rn)?,
                Op::Renamed(a, _) => c.rename_as(a, &rn)?,
                Op::Deleted(n) => c.delete(n)?,
                Op::Shared(n, mode) => c.share(n, mode)?,
                Op::Granted(..) | Op::Ungranted(..) | Op::Grouped(..) | Op::SharedDir(..) | Op::Sensed(..) | Op::Commented(..) | Op::Asked(..) => {}
            }
            Ok(op)
        }),
        None => applied(s, op),
    }
}

/// The names at `path` or under it: a page's own, or a folder's pages.
fn under(names: &[String], path: &str) -> Vec<String> {
    names.iter().filter(|n| n.as_str() == path || n.strip_prefix(path).is_some_and(|r| r.starts_with('/'))).cloned().collect()
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
            // a page, or a folder and every page under it
            let was_folder = !s.names.contains(&a);
            for old in under(&s.names, &a) {
                let new = format!("{b}{}", &old[a.len()..]);
                if let Some(mut p) = s.cache.remove(&old) {
                    p.name = new.clone();
                    s.cache.insert(new.clone(), p);
                }
                s.names.retain(|x| *x != old);
                s.names.push(new);
            }
            s.open = None;
            if was_folder {
                s.folder = Some(b);
            } else {
                open_page(s, &b);
            }
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
        Op::Granted(n, ship, edit, told) => {
            // the message names its page: the open one may have changed since
            let can = if edit { "edit" } else { "read" };
            s.note = format!("{ship} can now {can} {n}{}", if told { "" } else { ", and was not reached to be told" });
            load_groups(s);
            return;
        }
        Op::Asked(say) => {
            s.note = say;
            if let Some(c) = s.conn.clone() {
                s.asks_req.request(c, |c| c.asks());
            }
            if s.access {
                load_groups(s);
            }
            return;
        }
        Op::Commented(say) => {
            s.note = say;
            load_comments(s);
            return;
        }
        Op::Sensed(n, on, shared) => {
            s.note = match (on, shared) {
                (true, true) => format!("{n} is sensitive, and its own share still stands: set it private to stop that"),
                (true, false) => format!("{n} is sensitive: folders and groups no longer share it, and a key needs clearance to read it"),
                (false, _) => format!("{n} is no longer marked sensitive"),
            };
            s.sens.insert(n, on);
            // what folders and groups share may have changed with it
            load_groups(s);
            load_tree(s);
            return;
        }
        Op::SharedDir(n, mode) => {
            s.note = match mode.as_str() {
                "clearweb" => format!("every page in {n} can be read by anyone with the link"),
                "shared" => format!("every page in {n} is shared over Urbit"),
                _ => format!("{n} shares nothing of its own now"),
            };
            if mode == "private" {
                s.dshares.remove(&n);
            } else {
                s.dshares.insert(n, mode);
            }
            // which pages took it is the ship's to say
            load_tree(s);
            return;
        }
        Op::Grouped(say) => {
            s.note = say;
            load_groups(s);
            load_shared(s);
            return;
        }
        Op::Ungranted(n, ship) => {
            s.note = format!("{ship} no longer reads {n}");
            load_groups(s);
            return;
        }
        Op::Deleted(n) => {
            for old in under(&s.names, &n) {
                s.cache.remove(&old);
                s.names.retain(|x| *x != old);
            }
            s.open = None;
            s.folder = None;
            s.note = "deleted".into();
        }
    }
    refresh_tree(s);
}

/// Shows the tree as it now stands: read again from the ship, or built
/// from the names on sample pages.
fn refresh_tree(s: &mut App) {
    if s.conn.is_some() && s.memory {
        load_know(s);
    } else if s.conn.is_some() {
        load_tree(s);
    } else {
        let mut nodes: Vec<Node> = s.names.iter().map(|p| Node { path: p.clone(), page: true, kind: "md".into(), rev: 1, dname: s.dnames.get(p).cloned().unwrap_or_default(), ..Node::default() }).collect();
        // the folders that were given a name to show
        nodes.extend(s.dnames.iter().filter(|(p, _)| !s.names.contains(p)).map(|(p, d)| Node { path: p.clone(), dname: d.clone(), ..Node::default() }));
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
    s.groups_req.set_waker(waker.clone());
    s.base_req.set_waker(waker.clone());
    s.bans_req.set_waker(waker.clone());
    s.sens_req.set_waker(waker.clone());
    s.comments_req.set_waker(waker.clone());
    s.comments_on_req.set_waker(waker.clone());
    s.held_req.set_waker(waker.clone());
    s.notices_req.set_waker(waker.clone());
    s.back_req.set_waker(waker.clone());
    s.asks_req.set_waker(waker.clone());
    s.waiting_req.set_waker(waker.clone());
    s.comets_req.set_waker(waker.clone());
    s.shared_req.set_waker(waker.clone());
    s.remote_req.set_waker(waker.clone());
    s.old_req.set_waker(waker.clone());
    s.op_req.set_waker(waker);
    load_tree(s);
    load_know(s);
    load_shared(s);
}

fn load_tree(s: &mut App) {
    if let Some(c) = s.conn.clone() {
        s.tree_req.request((c.clone(), s.since.clone()), |(c, since)| c.dump(&since));
        // the inbox's count rides along with every sync: it is cheap on the ship
        s.waiting_req.request(c, |c| c.waiting());
    }
}

/// Shows a page: from the cache at once when it is there, and from the ship
/// when one is connected, so the cached text is corrected a moment later.
fn open_page(s: &mut App, name: &str) {
    if s.editing {
        return;
    }
    // the page to open again next run. Only a ship's: sample pages are not kept
    if !s.memory && s.prefs.recent.first().map(String::as_str) != Some(name) {
        s.prefs.last = name.to_owned();
        s.prefs.opened(name);
        if s.conn.is_some() {
            s.prefs.save();
        }
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
                // wheel up zooms in: a real wheel on Linux reports up as a positive dy (checked by the owner on beast)
                m.cam.zoom_at((e.dy as f64 / 200.0).exp(), e.x, e.y, m.size.0, m.size.1);
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

/// Whether a wiki link's target is a page not written yet: no page and
/// no memory has the name.
fn ghost(s: &App, name: &str) -> bool {
    !s.names.iter().any(|n| n == name) && !s.other.1.iter().any(|n| n == name)
}

/// The pages among `cache` whose text links to `name`.
fn linked_from(cache: &HashMap<String, Page>, name: &str) -> Vec<String> {
    let mut from: Vec<String> = cache.values().filter(|p| p.kind == "md" && p.name != name && md::links(&p.body).iter().any(|l| l == name)).map(|p| p.name.clone()).collect();
    from.sort();
    from
}

/// Reads which pages link to the open one when the links pane is showing.
/// The ship's index answers. Sample pages are read here.
fn load_links(s: &mut App) {
    let Some(p) = s.open.as_ref().filter(|_| s.inspector.is_open() && s.pane_links && !s.memory && s.remote.is_none()) else { return };
    match s.conn.clone() {
        Some(c) => s.back_req.request((c, p.name.clone()), |(c, n)| c.backlinks(&n).map(|b| (n, b))),
        None => s.back = Some((p.name.clone(), linked_from(&s.cache, &p.name))),
    }
}

/// Opens a page by name, or offers to make it when it is not written yet.
fn go(s: &mut App, name: &str) {
    if s.names.iter().any(|n| n == name) {
        open_page(s, name);
    } else {
        let mut t = TextEdit::new(name);
        t.focused = true;
        s.prompt = Some(Prompt::New(t));
    }
}

/// The links pane: the pages that link here, and the pages this one links to.
fn links_view(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let Some(p) = &s.open else {
        return col().key("links").w_full().padding(12.0).child(text("Open a page to see its links.").font(k.ty.small).color(c.text_muted).wrap());
    };
    let line = |name: &str, key: String, ghost: bool| {
        let to = name.to_owned();
        row().w_full().child(Button::new(if ghost { format!("{name}  (not written)") } else { name.to_owned() }).control_size(ControlSize::Small).variant(if ghost { ButtonVariant::GhostFaint } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| go(s, &to)).build(k).key(key))
    };
    let mut here = col().key("links-here").w_full().gap(2.0).child(text("Links here").font(k.ty.small_medium).color(c.text_muted));
    match s.back.as_ref().filter(|(n, _)| *n == p.name) {
        Some((_, list)) if list.is_empty() => here = here.child(text("Nothing links here yet.").font(k.ty.small).color(c.text_faint)),
        Some((_, list)) => {
            for n in list {
                here = here.child(line(n, format!("back-{n}"), false));
            }
        }
        None => here = here.child(text("Reading the links").font(k.ty.small).color(c.text_faint)),
    }
    let mut out = col().key("links-out").w_full().gap(2.0).child(text("Links out").font(k.ty.small_medium).color(c.text_muted));
    let outs = if p.kind == "md" { md::links(&p.body) } else { Vec::new() };
    for n in &outs {
        out = out.child(line(n, format!("out-{n}"), ghost(s, n)));
    }
    if outs.is_empty() {
        out = out.child(text("No links to other pages.").font(k.ty.small).color(c.text_faint));
    }
    col().key("links").w_full().h_full().min_h(0.0).padding(12.0).gap(14.0).child(text("Links").font(k.ty.ui_medium).color(c.text_base)).child(here).child(out).scroll(ScrollSpec { stick_bottom: false })
}

/// Shows one of the side pane's three views, or closes the pane when
/// that view is the one showing.
fn show_pane(s: &mut App, comments: bool, links: bool) {
    if s.inspector.is_open() && s.pane_comments == comments && s.pane_links == links {
        s.inspector.toggle();
        return;
    }
    if !s.inspector.is_open() {
        s.inspector.toggle();
    }
    (s.pane_comments, s.pane_links) = (comments, links);
    s.old = None;
    load_history(s);
    load_comments(s);
    load_links(s);
}

/// Reads the open page's revisions when the history pane is showing.
fn load_history(s: &mut App) {
    if s.memory || s.pane_comments || s.pane_links {
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
    s.remote = None;
    s.shared_open = false;
    s.inbox = false;
    s.access = false;
    s.folder = None;
    s.old = None;
    s.stale = false;
    if let Some(p) = s.cache.get(name) {
        s.open = Some(p.clone());
    }
    // the page to show when its text arrives, if it is not kept yet
    s.want = (!s.cache.contains_key(name)).then(|| name.to_owned());
    // a memory's text came with the list: only a page is read again
    if let Some(c) = s.conn.clone().filter(|_| !s.memory) {
        s.page_req.request((c, name.to_owned()), |(c, n)| c.page(&n));
    }
    sync_map(s);
    sync_sheet(s);
    load_history(s);
    load_comments(s);
    load_links(s);
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

/// Starts a page with no question asked: named in the inbox by the
/// date, open in the editor, and kept by its first save.
fn capture(s: &mut App) {
    if s.editing {
        return;
    }
    if s.memory {
        flip(s);
    }
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| u64::from(d.subsec_nanos()));
    let name = api::capture_name(&api::today(), seed, &|n| s.names.iter().any(|x| x == n));
    // nothing is asked of the ship: the page is not there until it is saved
    (s.remote, s.folder, s.old, s.want) = (None, None, None, None);
    (s.shared_open, s.inbox, s.access, s.stale) = (false, false, false, false);
    s.open = Some(Page { name, body: String::new(), kind: "md".into(), rev: 0 });
    s.capture = true;
    start_edit(s);
    s.note = "a new page in the inbox, kept when you save".into();
}

/// Leaves the editor without saving. A capture never saved is dropped.
fn cancel_edit(s: &mut App) {
    s.editing = false;
    if s.capture {
        s.capture = false;
        s.open = None;
        s.note.clear();
    }
}

/// How long the text must rest before it is saved by itself, as in the
/// web client.
const AUTOSAVE_AFTER: f64 = 2.0;

/// Looks at the text being edited every `AUTOSAVE_AFTER` seconds and
/// saves it when it has changed and then rested for one look. Text that
/// is as the page was read is never written. `true` when a save started.
fn autosave_tick(s: &mut App, clock: f64) -> bool {
    if !s.editing {
        s.auto_seen = None;
        return false;
    }
    if clock < s.next_auto {
        return false;
    }
    s.next_auto = clock + AUTOSAVE_AFTER;
    // another ship's page saves on purpose only, and so does a page that changed elsewhere
    if s.prefs.no_autosave || s.auto_held || s.stale || s.remote.is_some() {
        return false;
    }
    let body = edited(s);
    let rested = s.auto_seen.as_deref() == Some(body.as_str());
    let same = s.open.as_ref().is_none_or(|p| p.body == body);
    let empty = s.capture && body.trim().is_empty();
    s.auto_seen = Some(body);
    if !rested || same || empty || s.save_req.is_pending() {
        return false;
    }
    s.autosaving = true;
    write(s);
    true
}

/// Save, pressed. It closes the editor, and autosave may run again.
fn save(s: &mut App) {
    s.auto_held = false;
    // a save of autosave's is on the wire: this one follows it, on its rev
    if s.autosaving && s.save_req.is_pending() {
        s.save_again = true;
        return;
    }
    s.autosaving = false;
    write(s);
}

fn write(s: &mut App) {
    let Some(mut p) = s.open.clone() else { return };
    let base = p.rev;
    p.body = edited(s);
    if s.capture && p.body.trim().is_empty() {
        s.note = "nothing to keep yet".into();
        return;
    }
    let memory = s.memory;
    let remote = s.remote.clone();
    match s.conn.clone() {
        Some(c) => s.save_req.request((c, p), move |(c, mut p)| {
            if let Some(sh) = &remote {
                // an unconfirmed write keeps the rev it was based on
                p.rev = c.remote_save(sh, &p.body, base)?.unwrap_or(base);
            } else if memory {
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
    // a page of another ship is not one of this ship's kept texts
    if s.remote.is_none() {
        // a capture's first save is what makes the page
        let made = !s.memory && !s.names.contains(&p.name);
        if made {
            s.names.push(p.name.clone());
        }
        s.cache.insert(p.name.clone(), p.clone());
        if made {
            s.open = Some(p.clone());
            refresh_tree(s);
        }
    }
    s.capture = false;
    s.open = Some(p);
    s.stale = false;
    s.note = "saved".into();
    if std::mem::take(&mut s.save_again) {
        // Save was pressed meanwhile: what was typed since goes too, and the editor closes
        s.autosaving = false;
        write(s);
        return;
    }
    // autosave leaves the editor as it is
    if std::mem::take(&mut s.autosaving) {
        return;
    }
    s.editing = false;
    sync_map(s);
    sync_sheet(s);
    load_history(s);
}

/// How often the tree is read again, to see what other windows wrote. Each
/// read after the first carries only the bodies written since (`since`).
const SYNC_EVERY: f64 = 30.0;

fn poll(s: &mut App, clock: f64, tx: &mut Tx) -> bool {
    let mut changed = false;
    if s.editing {
        if clock >= s.next_auto {
            tx.wake_after(std::time::Duration::from_secs_f64(AUTOSAVE_AFTER));
        }
        changed |= autosave_tick(s, clock);
    }
    if s.conn.is_some() && clock >= s.next_sync {
        if s.next_sync > 0.0 {
            load_tree(s);
        }
        s.next_sync = clock + SYNC_EVERY;
        tx.wake_after(std::time::Duration::from_secs_f64(SYNC_EVERY));
    }
    if let Some(r) = s.shared_req.take() {
        changed = true;
        match r {
            Ok(list) => s.shared = list,
            Err(e) => s.note = format!("shared with me: {e}"),
        }
    }
    if let Some(r) = s.remote_req.take() {
        changed = true;
        match r {
            Ok((sh, p)) if !s.editing => show_remote(s, sh, p),
            Ok(_) => {}
            Err(e) => s.note = format!("could not read it: {e}"),
        }
    }
    if let Some(r) = s.comments_req.take() {
        changed = true;
        match r {
            Ok(list) => s.comments = list,
            Err(e) => s.note = format!("comments: {e}"),
        }
    }
    if let Some(r) = s.back_req.take() {
        changed = true;
        if let Ok(b) = r {
            s.back = Some(b);
        }
    }
    if let Some(r) = s.asks_req.take() {
        changed = true;
        match r {
            Ok(a) => s.asks = a,
            Err(e) => s.note = format!("requests: {e}"),
        }
    }
    if let Some(r) = s.notices_req.take() {
        changed = true;
        match r {
            Ok(list) => {
                s.waiting.unread = list.iter().filter(|n| !n.read).count() as u32;
                s.notices = list;
            }
            Err(e) => s.note = format!("activity: {e}"),
        }
    }
    if let Some(Ok(w)) = s.waiting_req.take() {
        changed = true;
        s.waiting = w;
    }
    if let Some(r) = s.held_req.take() {
        changed = true;
        match r {
            Ok(list) => {
                s.waiting.held = list.len() as u32;
                s.held = list;
            }
            Err(e) => s.note = format!("held comments: {e}"),
        }
    }
    if let Some(r) = s.comets_req.take() {
        changed = true;
        if let Ok((n, m)) = r {
            s.comets.insert(n, m);
        }
    }
    if let Some(r) = s.comments_on_req.take() {
        changed = true;
        if let Ok((n, on)) = r {
            s.comments_on.insert(n, on);
        }
    }
    if let Some(r) = s.sens_req.take() {
        changed = true;
        match r {
            Ok((n, on)) => {
                s.sens.insert(n, on);
            }
            Err(e) => s.note = format!("sensitive: {e}"),
        }
    }
    if let Some(r) = s.bans_req.take() {
        changed = true;
        match r {
            Ok(b) => s.bans = b,
            Err(e) => s.note = format!("bans: {e}"),
        }
    }
    if let Some(r) = s.base_req.take() {
        changed = true;
        match r {
            Ok(b) => s.base = b,
            Err(e) => s.note = format!("access: {e}"),
        }
    }
    if let Some(r) = s.groups_req.take() {
        changed = true;
        match r {
            Ok(g) => s.groups = g,
            Err(e) => s.note = format!("access list: {e}"),
        }
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
                s.dnames = nodes.iter().filter(|n| !n.dname.is_empty()).map(|n| (n.path.clone(), n.dname.clone())).collect();
                s.dshares = nodes.iter().filter(|n| !n.page && !n.dshare.is_empty()).map(|n| (n.path.clone(), n.dshare.clone())).collect();
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
                // the page that was open last run opens again, once
                if !s.restored && !away {
                    s.restored = true;
                    let last = s.prefs.last.clone();
                    if s.open.is_none() && s.names.contains(&last) {
                        open_page(s, &last);
                    }
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
                // shown when it is the page on screen, or the one waited for
                let waited = s.want.as_deref() == Some(p.name.as_str());
                if !s.editing && (waited || s.open.as_ref().is_some_and(|o| o.name == p.name)) && s.remote.is_none() {
                    if waited {
                        s.files.expand_to(&p.name);
                        s.files.select(&p.name);
                    }
                    s.want = None;
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
                load_shared(s);
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
            Err(e) => {
                s.save_again = false;
                if std::mem::take(&mut s.autosaving) {
                    s.auto_held = true;
                    s.note = format!("not saved: {e}. Autosave waits until you press Save");
                } else {
                    s.note = format!("not saved: {e}");
                }
            }
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
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        // nothing typed: the pages opened last, newest first, without the one in front
        let open = s.open.as_ref().map(|p| p.name.as_str());
        return s.prefs.recent.iter().filter(|n| Some(n.as_str()) != open && s.names.contains(n)).map(|n| (n.clone(), None)).collect();
    }
    let mut rows: Vec<(String, Option<String>)> = matches(&s.names, query).into_iter().take(8).map(|n| (n.to_owned(), None)).collect();
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

/// The page the switcher offers to make: what is typed, as a path, when
/// no page has exactly that name.
fn creatable(s: &App, query: &str) -> Option<String> {
    let rn = api::real_name(query.trim())?;
    (!s.names.contains(&rn.name)).then_some(rn.name)
}

/// Makes the page typed into the switcher, as New page would.
fn jump_create(s: &mut App) {
    let Some(q) = s.jump.take() else { return };
    s.prompt = Some(Prompt::New(TextEdit::new(q.text.trim())));
    confirm(s);
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
        .placeholder("Jump to a page, search their text, or name a new one")
        .leading_icon(k.glyph.search)
        .on_edit(|s: &mut App| s.jump.as_mut().expect("the switcher is open"))
        .on_change(|s: &mut App, _| s.jump_at = 0)
        .on_key(|s: &mut App, ev: &KeyEvent, tx: &mut Tx| {
            let Some(q) = &s.jump else { return false };
            let hits = found(s, &q.text);
            // the Create row is one more row, after the pages found
            let make = creatable(s, &q.text).is_some();
            let last = (hits.len() + usize::from(make)).saturating_sub(1);
            match ev.key {
                Key::Down => s.jump_at = (s.jump_at + 1).min(last),
                Key::Up => s.jump_at = s.jump_at.saturating_sub(1),
                // Shift-Return makes the typed name whatever was found
                Key::Enter if make && (ev.mods.shift || s.jump_at >= hits.len()) => jump_create(s),
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
    let make = creatable(s, &q.text);
    if let Some(name) = &make {
        let mut r = row().key("jump-create").w_full().h(30.0).px(10.0).gap(8.0).center_y().radius(k.radius.sm).on_press(jump_create).child(text(format!("Create {name}")).font(k.ty.ui).color(k.c.text_base)).child(text("Shift-Return").font(k.ty.small).color(k.c.text_faint));
        if s.jump_at >= hits.len() {
            r = r.fill(k.selection());
        }
        rows = rows.child(r);
    }
    if hits.is_empty() && make.is_none() {
        rows = rows.child(text(if q.text.trim().is_empty() { "Pages you open will list here" } else { "No page matches" }).font(k.ty.ui).color(k.c.text_muted));
    }
    Dialog::new("jump", "Jump to a page")
        .open(true)
        .width(520.0)
        .fit()
        .on_close(|s: &mut App| s.jump = None)
        .child(col().w_full().gap(8.0).child(field).child(rows))
        .build(k, layer);
}

fn go_shared(s: &mut App) {
    if !s.editing {
        s.shared_open = true;
        s.access = false;
        s.inbox = false;
        load_shared(s);
    }
}

fn go_inbox(s: &mut App) {
    if !s.editing {
        s.inbox = true;
        s.access = false;
        s.shared_open = false;
        load_comments(s);
    }
}

fn go_access(s: &mut App) {
    if !s.editing {
        s.access = true;
        s.inbox = false;
        load_groups(s);
    }
}

fn next_theme(s: &mut App) {
    s.prefs.theme = s.prefs.next_theme().to_owned();
    if s.conn.is_some() {
        s.prefs.save();
    }
}

fn open_share(s: &mut App) {
    s.sharing = true;
    load_groups(s);
    load_sens(s);
}

/// The palette's commands: a name to keep and the words shown. Each has
/// a button on screen too.
const COMMANDS: &[(&str, &str)] = &[
    ("new", "New page or memory"),
    ("capture", "Capture a page to the inbox"),
    ("open", "Open a page"),
    ("edit", "Edit"),
    ("rename", "Rename or move"),
    ("delete", "Delete"),
    ("share", "Share"),
    ("links", "Links"),
    ("comments", "Comments on this page"),
    ("history", "History"),
    ("inbox", "Inbox"),
    ("shared", "Shared with me"),
    ("access", "Access"),
    ("half", "Switch between pages and memory"),
    ("theme", "Next theme"),
    ("sidebar", "Show or hide the tree"),
    ("reload", "Read again from the ship"),
    ("signout", "Sign out or close"),
];

/// Whether a command can run now: the ones about a page need one open.
fn usable(s: &App, id: &str) -> bool {
    let page = s.open.is_some() && !s.access && !s.shared_open && !s.inbox;
    let own = page && s.remote.is_none();
    match id {
        "edit" => page && s.remote.as_ref().is_none_or(Shared::editable),
        "delete" => own,
        "rename" | "share" | "links" | "comments" | "history" => own && !s.memory,
        "reload" => s.conn.is_some(),
        _ => true,
    }
}

/// The palette's rows: the commands that can run, the ones run last
/// first and the rest in their own order. Typing narrows them, best
/// match first.
fn commands(s: &App, query: &str) -> Vec<(&'static str, &'static str)> {
    let used = |id: &str| s.prefs.used.iter().position(|u| u == id).unwrap_or(usize::MAX);
    let mut rows: Vec<(usize, usize, &'static str, &'static str)> =
        COMMANDS.iter().filter(|c| usable(s, c.0)).filter_map(|&(id, label)| Some((if query.trim().is_empty() { 0 } else { score(label, query)? }, used(id), id, label))).collect();
    // a stable sort: commands never run keep the table's order
    rows.sort_by_key(|r| (r.0, r.1));
    rows.into_iter().map(|r| (r.2, r.3)).collect()
}

/// Runs a command and notes it as the one run last.
fn run_command(s: &mut App, id: &str, tx: &mut Tx) {
    s.palette = None;
    if !usable(s, id) {
        return;
    }
    s.prefs.used.retain(|u| u != id);
    s.prefs.used.insert(0, id.to_owned());
    if s.conn.is_some() {
        s.prefs.save();
    }
    match id {
        "new" => ask_new(s),
        "capture" => {
            capture(s);
            tx.focus_when_shown(FIELD, false);
        }
        "open" => {
            let mut q = TextEdit::new("");
            q.focused = true;
            s.jump = Some(q);
            s.jump_at = 0;
        }
        "edit" => {
            start_edit(s);
            tx.focus_when_shown(FIELD, false);
        }
        "rename" => ask_rename(s),
        "delete" => ask_delete(s),
        "share" => open_share(s),
        "links" => show_pane(s, false, true),
        "comments" => show_pane(s, true, false),
        "history" => show_pane(s, false, false),
        "inbox" => go_inbox(s),
        "shared" => go_shared(s),
        "access" => go_access(s),
        "half" => flip(s),
        "theme" => next_theme(s),
        "sidebar" => s.sidebar.toggle(),
        "reload" => {
            load_know(s);
            load_tree(s);
        }
        "signout" => sign_out(s),
        _ => {}
    }
}

fn palette_view(s: &App, k: &Kit, layer: &mut Vec<El>) {
    let Some(q) = &s.palette else { return };
    let hits = commands(s, &q.text);
    let field = TextInput::new(q)
        .placeholder("Run a command")
        .on_edit(|s: &mut App| s.palette.as_mut().expect("the palette is open"))
        .on_change(|s: &mut App, _| s.palette_at = 0)
        .on_key(|s: &mut App, ev: &KeyEvent, tx: &mut Tx| {
            let Some(q) = &s.palette else { return false };
            let hits = commands(s, &q.text);
            match ev.key {
                Key::Down => s.palette_at = (s.palette_at + 1).min(hits.len().saturating_sub(1)),
                Key::Up => s.palette_at = s.palette_at.saturating_sub(1),
                Key::Enter => {
                    if let Some(&(id, _)) = hits.get(s.palette_at) {
                        run_command(s, id, tx);
                    }
                }
                _ => return false,
            }
            true
        })
        .build(k)
        .w_full();
    let mut rows = col().key("palette-rows").w_full().gap(2.0);
    for (i, &(id, label)) in hits.iter().enumerate() {
        let mut r = row().key(format!("cmd:{id}")).w_full().h(30.0).px(10.0).center_y().radius(k.radius.sm).on_press_tx(move |s: &mut App, tx| run_command(s, id, tx)).child(text(label).font(k.ty.ui).color(k.c.text_base));
        if i == s.palette_at {
            r = r.fill(k.selection());
        }
        rows = rows.child(r);
    }
    if hits.is_empty() {
        rows = rows.child(text("No command matches").font(k.ty.ui).color(k.c.text_muted));
    }
    Dialog::new("palette", "Commands")
        .open(true)
        .width(460.0)
        .fit()
        .on_close(|s: &mut App| s.palette = None)
        .child(col().w_full().gap(8.0).child(field).child(col().w_full().max_h(420.0).child(rows).scroll(ScrollSpec { stick_bottom: false })))
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
                Prompt::New(t) | Prompt::Rename(_, t) | Prompt::Link(t) | Prompt::Ask(_, t) => t,
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
        Prompt::Ask(_, t) => ("Ask for edit access", field(t, "A short note, if you like"), "Ask", ButtonVariant::Contrast),
        Prompt::Delete(n) => {
            let held = under(&s.names, n).len();
            let (ask, says) = if s.names.contains(n) { ("Delete this page?", n.clone()) } else { ("Delete this folder?", format!("{n} and the {held} pages in it")) };
            (ask, text(says).font(k.ty.ui).color(k.c.text_muted).wrap(), "Delete", ButtonVariant::Danger)
        }
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

fn load_shared(s: &mut App) {
    if let Some(c) = s.conn.clone() {
        s.shared_req.request(c, |c| c.shared());
    }
}

/// Opens a page another ship shared, read from that ship.
fn open_remote(s: &mut App, sh: Shared) {
    if s.editing {
        return;
    }
    match s.conn.clone() {
        Some(c) => {
            s.note = format!("reading {} from {}", sh.name(), sh.host);
            s.remote_req.request((c, sh), |(c, sh)| c.browse(&sh).map(|p| (sh, p)));
        }
        // sample pages: a page as its host would answer
        None => {
            let p = Page { name: format!("{}/{}", sh.host, sh.name()), body: format!("# {}\n\nA page {} shared with you.\n", sh.name(), sh.host), kind: "md".into(), rev: 3 };
            show_remote(s, sh, p);
        }
    }
}

/// A shared page arrived: it shows in place of a page of this ship.
fn show_remote(s: &mut App, sh: Shared, p: Page) {
    s.access = false;
    s.shared_open = false;
    s.inbox = false;
    s.folder = None;
    s.old = None;
    s.stale = false;
    s.note.clear();
    s.want = None;
    s.remote = Some(sh);
    s.open = Some(p);
    sync_map(s);
    sync_sheet(s);
}

/// The list of what other ships shared with this one.
fn shared_view(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let mut list = col().key("shared-list").w_full().gap(6.0);
    for (i, sh) in s.shared.iter().enumerate() {
        let (open, forget) = (sh.clone(), sh.clone());
        let when = Rev { rev: 0, updated: sh.when.clone() }.when();
        list = list.child(
            row()
                .key(format!("shared-{i}"))
                .w_full()
                .px(12.0)
                .py(8.0)
                .gap(10.0)
                .center_y()
                .radius(k.radius.md)
                .border(1.0, c.border_weak)
                .child(
                    col()
                        .gap(2.0)
                        .grow(1.0)
                        .min_w(0.0)
                        .child(text(sh.name().to_owned()).font(k.ty.ui_medium).color(c.text_base).truncate())
                        .child(text(format!("{} lets you {} it  {when}", sh.host, if sh.editable() { "edit" } else { "read" })).font(k.ty.small).color(c.text_muted).truncate()),
                )
                .child(Button::new("Open").control_size(ControlSize::Small).on_press(move |s: &mut App| open_remote(s, open.clone())).build(k).key(format!("shared-open-{i}")))
                .child(Button::new("Forget").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
                    let sh = forget.clone();
                    match s.conn.clone() {
                        Some(c) => s.op_req.request((c, sh), |(c, sh)| {
                            c.shared_forget(&sh)?;
                            Ok(Op::Grouped(format!("forgot {} from {}", sh.name(), sh.host)))
                        }),
                        None => s.shared.retain(|x| *x != sh),
                    }
                }).build(k).key(format!("shared-forget-{i}"))),
        );
    }
    if s.shared.is_empty() {
        list = list.child(text("No ship has shared a page with you.").font(k.ty.small).color(c.text_muted));
    }
    let head = col()
        .gap(4.0)
        .child(text("Shared with me").font(k.ty.body_medium).color(c.text_base))
        .child(text("Pages other ships said they shared. Opening one reads it from that ship, which shows whether it still lets you.").font(k.ty.small).color(c.text_muted).wrap());
    col()
        .key("shared")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(col().w_full().items_center().child(col().w_full().max_w(760.0).padding(28.0).gap(16.0).child(head).child(list)))
        .scroll(ScrollSpec { stick_bottom: false })
}

/// Reads the comments, and whether they are on for the open page, when
/// the comments pane is showing.
fn load_comments(s: &mut App) {
    let Some(c) = s.conn.clone() else { return };
    if s.inbox {
        s.comments_req.request(c.clone(), |c| c.comments());
        s.held_req.request(c.clone(), |c| c.held());
        s.notices_req.request(c.clone(), |c| c.notices());
    }
    let Some(p) = &s.open else { return };
    if s.inspector.is_open() && s.pane_comments && !s.pane_links && !s.memory && s.remote.is_none() {
        s.comments_req.request(c.clone(), |c| c.comments());
        s.comments_on_req.request((c.clone(), p.name.clone()), |(c, n)| c.comments_on(&n).map(|on| (n, on)));
        s.comets_req.request((c, p.name.clone()), |(c, n)| c.comets(&n).map(|m| (n, m)));
    }
}

/// Posts the comment typed in the pane on the open page.
fn post_comment(s: &mut App) {
    let (Some(c), Some(p)) = (s.conn.clone(), &s.open) else {
        s.note = "sample pages take no comments".into();
        return;
    };
    let body = s.comment.text.trim().to_owned();
    if body.is_empty() {
        return;
    }
    s.comment = TextEdit::new("");
    s.op_req.request((c, p.name.clone(), body), |(c, page, body)| {
        c.comment(&page, &body)?;
        // the ship writes it in a step of its own behind the answer
        std::thread::sleep(std::time::Duration::from_millis(1500));
        Ok(Op::Commented(format!("comment posted on {page}")))
    });
}

/// One comment: who, when, what, and Remove. In the inbox it also names
/// its page, which opens when pressed.
fn comment_card(m: &Comment, k: &Kit, link: bool, held: bool) -> El {
    let c = &k.c;
    let (page, id, to) = (m.page.clone(), m.id.clone(), m.page.clone());
    let when = Rev { rev: 0, updated: m.when.clone() }.when();
    let mut top = row().w_full().gap(6.0).center_y().child(text(m.author.clone()).font(k.ty.small_medium).color(c.text_base)).child(text(when).font(k.ty.small).color(c.text_faint).grow(1.0));
    if held {
        // a held comment is answered, not removed
        for approve in [true, false] {
            let (page, id) = (page.clone(), id.clone());
            let word = if approve { "approve" } else { "reject" };
            top = top.child(Button::new(if approve { "Approve" } else { "Reject" }).control_size(ControlSize::Small).variant(if approve { ButtonVariant::Contrast } else { ButtonVariant::GhostMuted }).on_press(move |s: &mut App| {
                match s.conn.clone() {
                    Some(c) => s.op_req.request((c, page.clone(), id.clone()), move |(c, page, id)| {
                        c.held_answer(&page, &id, approve)?;
                        Ok(Op::Commented(format!("comment {}", if approve { "approved" } else { "rejected" })))
                    }),
                    None => s.held.retain(|h| h.id != id),
                }
            }).build(k).key(format!("held-{word}-{}", m.id)));
        }
    }
    let mut card = col().key(format!("{}-{}", if held { "held" } else { "comment" }, m.id)).w_full().padding(8.0).gap(4.0).radius(k.radius.sm).fill(c.layer_01).child(if held { top } else {
        top
            .child(Button::new("Remove").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).on_press(move |s: &mut App| {
                let Some(c) = s.conn.clone() else { return };
                s.op_req.request((c, page.clone(), id.clone()), |(c, page, id)| {
                    c.comment_delete(&page, &id)?;
                    Ok(Op::Commented(format!("removed a comment from {page}")))
                });
            }).build(k).key(format!("comment-del-{}", m.id)))
    });
    if link {
        card = card.child(row().child(Button::new(m.page.clone()).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| open_comment_page(s, &to)).build(k).key(format!("comment-page-{}", m.id))));
    }
    card.child(text(m.body.clone()).font(k.ty.ui).color(c.text_base).wrap().selectable(true))
}

/// Opens the page a comment in the inbox is on, from either half.
fn open_comment_page(s: &mut App, name: &str) {
    if s.memory {
        flip(s);
    }
    if s.names.iter().any(|n| n == name) {
        open_page(s, name);
    } else {
        s.note = format!("{name} is no longer a page");
    }
}

/// Marks one notice read, or all with no id. On sample pages, in place.
fn mark_read(s: &mut App, id: Option<String>) {
    match s.conn.clone() {
        Some(c) => s.op_req.request((c, id), |(c, id)| {
            c.notice_read(id.as_deref())?;
            Ok(Op::Commented(if id.is_some() { "marked read".into() } else { "all activity marked read".into() }))
        }),
        None => {
            for n in s.notices.iter_mut().filter(|n| id.as_ref().is_none_or(|i| *i == n.id)) {
                n.read = true;
            }
            s.waiting.unread = s.notices.iter().filter(|n| !n.read).count() as u32;
        }
    }
}

/// Opens what a notice is about, and marks it read.
fn open_notice(s: &mut App, n: &Notice) {
    match n.opens() {
        Opens::Page(p) => open_comment_page(s, &p),
        Opens::Shared(sh) => open_remote(s, sh),
        Opens::Access => {
            s.access = true;
            s.inbox = false;
            load_groups(s);
        }
        Opens::Nothing => return,
    }
    if !n.read {
        mark_read(s, Some(n.id.clone()));
    }
}

/// The activity notices: who, what about, when, and the start of what was said.
fn activity_view(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let unread = s.notices.iter().filter(|n| !n.read).count();
    let mut head = row().w_full().center_y().gap(8.0).child(text(if unread > 0 { format!("Activity, {unread} unread") } else { "Activity".to_owned() }).font(k.ty.ui_medium).color(c.text_base).grow(1.0));
    if unread > 0 {
        head = head.child(Button::new("Mark all read").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| mark_read(s, None)).build(k).key("notice-read-all"));
    }
    let mut list = col().key("notice-list").w_full().gap(8.0).child(head);
    for n in &s.notices {
        let when = Rev { rev: 0, updated: n.when.clone() }.when();
        let mut top = row()
            .w_full()
            .gap(6.0)
            .center_y()
            .child(text(if n.read { "" } else { "new" }).font(k.ty.small_medium).color(c.text_accent))
            .child(text(n.who.clone()).font(k.ty.small_medium).color(c.text_base))
            .child(text(n.label()).font(k.ty.small).color(c.text_muted).grow(1.0).min_w(0.0).truncate())
            .child(text(when).font(k.ty.small).color(c.text_faint));
        if !n.read {
            let id = n.id.clone();
            top = top.child(Button::new("Mark read").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).on_press(move |s: &mut App| mark_read(s, Some(id.clone()))).build(k).key(format!("notice-read-{}", n.id)));
        }
        if n.opens() != Opens::Nothing {
            let to = n.clone();
            top = top.child(Button::new("Open").control_size(ControlSize::Small).on_press(move |s: &mut App| open_notice(s, &to)).build(k).key(format!("notice-open-{}", n.id)));
        }
        let mut card = col().key(format!("notice-{}", n.id)).w_full().padding(8.0).gap(4.0).radius(k.radius.sm).fill(c.layer_01).child(top);
        if !n.body.is_empty() {
            card = card.child(text(n.body.clone()).font(k.ty.ui).color(c.text_base).wrap().selectable(true));
        }
        list = list.child(card);
    }
    if s.notices.is_empty() {
        list = list.child(text(if s.notices_req.is_pending() { "Reading the activity" } else { "No activity yet. Comments from other ships, forum replies, shares and asks to edit show here." }).font(k.ty.small).color(c.text_muted).wrap());
    }
    list
}

/// Every page's comments, newest first, as the ship gives them.
fn inbox_view(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let mut list = col().key("inbox-list").w_full().gap(8.0);
    for m in &s.comments {
        list = list.child(comment_card(m, k, true, false));
    }
    if s.comments.is_empty() {
        list = list.child(text(if s.comments_req.is_pending() { "Reading the comments" } else { "No comments. They are off until switched on for a page, in its Comments pane." }).font(k.ty.small).color(c.text_muted).wrap());
    }
    // what waits for an answer comes first, and only when something does
    let mut waiting = col().key("held-list").w_full().gap(8.0);
    if !s.held.is_empty() {
        waiting = waiting.child(text(format!("Held for your yes: {}", s.held.len())).font(k.ty.ui_medium).color(c.text_base));
        for m in &s.held {
            waiting = waiting.child(comment_card(m, k, true, true));
        }
    }
    let head = col()
        .gap(4.0)
        .child(text("Inbox").font(k.ty.body_medium).color(c.text_base))
        .child(text("What waits for your yes, what happened, and every comment on your pages, newest first. The ship gives the newest 200 comments.").font(k.ty.small).color(c.text_muted).wrap());
    let list = col().w_full().gap(8.0).child(text("Comments").font(k.ty.ui_medium).color(c.text_base)).child(list);
    col()
        .key("inbox")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(col().w_full().items_center().child(col().w_full().max_w(760.0).padding(28.0).gap(16.0).child(head).child(waiting).child(activity_view(s, k)).child(list)))
        .scroll(ScrollSpec { stick_bottom: false })
}

/// The comments pane: whether comments are on, the page's comments
/// newest first, and a field for the owner's own.
fn comments_view(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let Some(p) = &s.open else {
        return col().key("comments").w_full().padding(12.0).child(text("Open a page to see its comments.").font(k.ty.small).color(c.text_muted).wrap());
    };
    let on = s.comments_on.get(&p.name).copied();
    let name = p.name.clone();
    let toggle = row()
        .key("comments-switch")
        .w_full()
        .gap(8.0)
        .center_y()
        .child(Switch::new(on.unwrap_or(false)).label("Comments on").on_toggle(move |s: &mut App| {
            let Some(c) = s.conn.clone() else { return };
            let now = s.comments_on.get(&name).copied().unwrap_or(false);
            s.comments_on.insert(name.clone(), !now);
            s.op_req.request((c, name.clone()), move |(c, n)| {
                c.set_comments(&n, !now)?;
                Ok(Op::Commented(format!("comments are {} for {n}", if now { "off" } else { "on" })))
            });
        }).build(k).key("comments-toggle"));
    // comets cost nothing to make, so each page says what their comments do
    let mut comets = row().key("comets").w_full().gap(4.0).center_y();
    if on == Some(true) {
        let now = s.comets.get(&p.name).cloned().unwrap_or_default();
        comets = comets.child(text("Comets").font(k.ty.small).color(c.text_muted));
        for (mode, label) in [("open", "Open"), ("held", "Held"), ("off", "Off")] {
            let name = p.name.clone();
            comets = comets.child(Button::new(label).control_size(ControlSize::Small).variant(if now == mode { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| {
                let Some(c) = s.conn.clone() else { return };
                s.comets.insert(name.clone(), mode.to_owned());
                s.op_req.request((c, name.clone()), move |(c, n)| {
                    c.set_comets(&n, mode)?;
                    Ok(Op::Commented(format!("comets' comments are {mode} for {n}")))
                });
            }).build(k).key(format!("comets-{mode}")));
        }
    }
    let mine: Vec<&Comment> = s.comments.iter().filter(|m| m.page == p.name).collect();
    let mut list = col().key("comment-list").w_full().gap(8.0);
    for m in &mine {
        list = list.child(comment_card(m, k, false, false));
    }
    if mine.is_empty() {
        list = list.child(text(if s.comments_req.is_pending() { "Reading the comments" } else { "No comments on this page." }).font(k.ty.small).color(c.text_muted));
    }
    let off = on == Some(false);
    let mut write = col().key("comment-write").w_full().gap(6.0);
    if off {
        write = write.child(text("Comments are off for this page.").font(k.ty.small).color(c.text_muted).wrap());
    } else {
        write = write
            .child(TextArea::new(&s.comment).label("Your comment").placeholder("Say something").rows(3).on_edit(|s: &mut App| &mut s.comment).build(k).w_full().key("comment-field"))
            .child(row().child(Button::new("Post").control_size(ControlSize::Small).variant(ButtonVariant::Contrast).on_press(post_comment).build(k).key("comment-post")));
    }
    col()
        .key("comments")
        .w_full()
        .h_full()
        .min_h(0.0)
        .padding(12.0)
        .gap(10.0)
        .child(text("Comments").font(k.ty.ui_medium).color(c.text_base))
        .child(toggle)
        .child(comets)
        .child(col().w_full().grow(1.0).min_h(0.0).child(list).scroll(ScrollSpec { stick_bottom: false }))
        .child(write)
}

/// Asks whether what the share dialog is about is marked sensitive.
fn load_sens(s: &mut App) {
    if let (Some(c), Some((name, _))) = (s.conn.clone(), share_target(s)) {
        s.sens_req.request((c, name), |(c, n)| c.sensitive(&n).map(|on| (n, on)));
    }
}

/// Marks what the share dialog is about sensitive, or clears the mark.
fn flip_sens(s: &mut App) {
    let Some((name, _)) = share_target(s) else { return };
    let on = !s.sens.get(&name).copied().unwrap_or(false);
    match s.conn.clone() {
        Some(c) => s.op_req.request((c, name), move |(c, n)| {
            let shared = c.set_sensitive(&n, on)?;
            Ok(Op::Sensed(n, on, shared))
        }),
        // sample pages: kept for the session
        None => applied(s, Op::Sensed(name, on, false)),
    }
}

fn load_groups(s: &mut App) {
    if let Some(c) = s.conn.clone() {
        s.groups_req.request(c.clone(), |c| c.groups());
        // a ban takes ships out of groups, so the two are read together
        s.bans_req.request(c.clone(), |c| c.bans());
        s.asks_req.request(c.clone(), |c| c.asks());
        if s.base.is_empty() {
            s.base_req.request(c, |c| c.base());
        }
    }
}

/// Writes `g` to the ship, then says `say`.
fn save_group(s: &mut App, g: Group, say: String) {
    let Some(c) = s.conn.clone() else { return };
    s.op_req.request((c, g), move |(c, g)| {
        c.group_save(&g)?;
        Ok(Op::Grouped(say))
    });
}

/// Writes the ships typed for the group being changed.
fn save_ships(s: &mut App) {
    let Some((name, typed)) = s.group_edit.take() else { return };
    let Some(g) = s.groups.iter().find(|g| g.name == name) else { return };
    match g.with_ships(&typed.text) {
        Ok(next) => save_group(s, next, format!("changed the ships of {name}")),
        Err(e) => {
            s.note = e;
            s.group_edit = Some((name, typed));
        }
    }
}

/// Bans the ship typed on the access screen.
fn ban(s: &mut App) {
    let Some(who) = api::ban_target(&s.ban_who.text) else {
        s.note = "enter a ship's name, or comets for every comet".into();
        return;
    };
    let Some(c) = s.conn.clone() else { return };
    s.ban_who = TextEdit::new("");
    s.op_req.request((c, who), |(c, who)| {
        c.ban(&who)?;
        Ok(Op::Grouped(format!("banned {who}: it is out of every group and cannot be granted anything")))
    });
}

/// Makes the group typed on the access screen.
fn new_group(s: &mut App) {
    let name = s.group_name.text.trim().to_owned();
    if !api::group_name_ok(&name) {
        s.note = "a group's name is lowercase letters, digits and hyphens".into();
        return;
    }
    if s.groups.iter().any(|g| g.name == name) {
        s.note = format!("there is a group named {name} already");
        return;
    }
    match api::ship_list(&s.group_ships.text) {
        Ok(ships) => {
            s.group_name = TextEdit::new("");
            s.group_ships = TextEdit::new("");
            let say = format!("made the group {name}");
            save_group(s, Group { name, ships, ..Group::default() }, say);
        }
        Err(e) => s.note = e,
    }
}

/// The access screen: every group, its ships and how many pages it reads,
/// and a form for a new one. A group's pages are set from a page's share dialog.
fn access_view(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let mut list = col().key("groups").w_full().gap(6.0);
    for g in s.groups.iter().filter(|g| g.name != "public") {
        let name = g.name.clone();
        let ships = if g.ships.is_empty() { "no ships".to_owned() } else { g.ships.join(" ") };
        // the group whose ships are being changed shows a field in place of them
        if let Some((_, typed)) = s.group_edit.as_ref().filter(|(n, _)| *n == g.name) {
            list = list.child(
                col()
                    .key(format!("group-{}", g.name))
                    .w_full()
                    .px(12.0)
                    .py(8.0)
                    .gap(8.0)
                    .radius(k.radius.md)
                    .border(1.0, c.text_accent)
                    .child(text(g.name.clone()).font(k.ty.ui_medium).color(c.text_base))
                    .child(TextInput::new(typed).label("Ships").placeholder("~sampel-palnet ~zod").on_edit(|s: &mut App| &mut s.group_edit.as_mut().expect("a group is being changed").1).on_submit(|s: &mut App, _| save_ships(s)).build(k).w_full().key("group-edit-ships"))
                    .child(
                        row()
                            .gap(8.0)
                            .child(Button::new("Save ships").control_size(ControlSize::Small).variant(ButtonVariant::Contrast).on_press(save_ships).build(k).key("group-edit-save"))
                            .child(Button::new("Cancel").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.group_edit = None).build(k).key("group-edit-cancel")),
                    ),
            );
            continue;
        }
        let (edit_name, edit_ships) = (g.name.clone(), g.ships.join(" "));
        list = list.child(
            row()
                .key(format!("group-{}", g.name))
                .w_full()
                .px(12.0)
                .py(8.0)
                .gap(10.0)
                .center_y()
                .radius(k.radius.md)
                .border(1.0, c.border_weak)
                .child(
                    col()
                        .gap(2.0)
                        .grow(1.0)
                        .min_w(0.0)
                        .child(text(g.name.clone()).font(k.ty.ui_medium).color(c.text_base))
                        .child(text(ships).font(k.ty.mono).color(c.text_muted).truncate())
                        .child(text(format!("reads {} paths, edits {}", g.peek.len(), g.make.len())).font(k.ty.small).color(c.text_faint)),
                )
                .child(Button::new("Ships").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
                    let mut t = TextEdit::new(edit_ships.clone());
                    t.focused = true;
                    s.group_edit = Some((edit_name.clone(), t));
                }).build(k).key(format!("group-ships-{}", g.name)))
                .child(Button::new("Delete").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
                    let Some(c) = s.conn.clone() else { return };
                    s.op_req.request((c, name.clone()), |(c, n)| {
                        c.group_delete(&n)?;
                        Ok(Op::Grouped(format!("deleted the group {n}")))
                    });
                }).build(k).key(format!("group-del-{}", g.name))),
        );
    }
    if s.groups.iter().all(|g| g.name == "public") {
        list = list.child(text(if s.conn.is_some() { "No groups yet." } else { "Sample pages have no groups." }).font(k.ty.small).color(c.text_muted));
    }
    let form = col()
        .key("group-form")
        .w_full()
        .gap(8.0)
        .child(text("New group").font(k.ty.ui_medium).color(c.text_base))
        .child(TextInput::new(&s.group_name).label("Group name").placeholder("team").on_edit(|s: &mut App| &mut s.group_name).build(k).w_full().key("group-name"))
        .child(TextInput::new(&s.group_ships).label("Ships").placeholder("~sampel-palnet ~zod").on_edit(|s: &mut App| &mut s.group_ships).on_submit(|s: &mut App, _| new_group(s)).build(k).w_full().key("group-ships"))
        .child(row().child(Button::new("Make group").variant(ButtonVariant::Contrast).on_press(new_group).build(k).key("group-make")));
    let mut banned = col().key("bans").w_full().gap(6.0).child(text("Banned ships").font(k.ty.ui_medium).color(c.text_base));
    for who in &s.bans {
        let w = who.clone();
        banned = banned.child(
            row()
                .key(format!("ban-{who}"))
                .w_full()
                .gap(8.0)
                .center_y()
                .child(text(who.clone()).font(k.ty.mono).color(c.text_base).grow(1.0).min_w(0.0).truncate())
                .child(Button::new("Unban").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
                    let Some(c) = s.conn.clone() else { return };
                    s.op_req.request((c, w.clone()), |(c, who)| {
                        c.unban(&who)?;
                        Ok(Op::Grouped(format!("unbanned {who}: nothing it had is given back")))
                    });
                }).build(k).key(format!("unban-{who}"))),
        );
    }
    if s.bans.is_empty() {
        banned = banned.child(text("No ship is banned.").font(k.ty.small).color(c.text_muted));
    }
    banned = banned.child(
        row()
            .w_full()
            .gap(6.0)
            .center_y()
            .child(TextInput::new(&s.ban_who).label("Ship to ban").placeholder("~sampel-palnet, or comets").on_edit(|s: &mut App| &mut s.ban_who).on_submit(|s: &mut App, _| ban(s)).build(k).grow(1.0).min_w(0.0).key("ban-who"))
            .child(Button::new("Ban").control_size(ControlSize::Small).variant(ButtonVariant::Danger).on_press(ban).build(k).key("ban-go")),
    );
    // asks for edit that wait for an answer, when there are any
    let mut asks = col().key("asks").w_full().gap(6.0);
    if !s.asks.pending.is_empty() {
        asks = asks.child(text(format!("Requests to edit: {}", s.asks.pending.len())).font(k.ty.ui_medium).color(c.text_base));
    }
    for (i, a) in s.asks.pending.iter().enumerate() {
        let when = Rev { rev: 0, updated: a.when.clone() }.when();
        let mut top = row().w_full().gap(6.0).center_y().child(text(a.ship.clone()).font(k.ty.small_medium).color(c.text_base)).child(text(format!("asks to edit {}", a.name)).font(k.ty.small).color(c.text_muted).grow(1.0).min_w(0.0).truncate()).child(text(when).font(k.ty.small).color(c.text_faint));
        for approve in [true, false] {
            let ask = a.clone();
            top = top.child(Button::new(if approve { "Approve" } else { "Deny" }).control_size(ControlSize::Small).variant(if approve { ButtonVariant::Contrast } else { ButtonVariant::GhostMuted }).on_press(move |s: &mut App| {
                let a = ask.clone();
                let say = if approve { format!("{} may now edit {}", a.ship, a.name) } else { format!("declined {}'s request for {}", a.ship, a.name) };
                match s.conn.clone() {
                    Some(c) => s.op_req.request((c, a), move |(c, a)| {
                        c.ask_answer(&a.ship, &a.path, approve)?;
                        Ok(Op::Asked(say))
                    }),
                    None => {
                        s.asks.pending.retain(|x| *x != a);
                        s.note = say;
                    }
                }
            }).build(k).key(format!("ask-{}-{i}", if approve { "approve" } else { "deny" })));
        }
        asks = asks.child(col().key(format!("ask-{i}")).w_full().padding(8.0).gap(4.0).radius(k.radius.sm).fill(c.layer_01).child(top).child(text(if a.note.is_empty() { "(no note)".to_owned() } else { a.note.clone() }).font(k.ty.ui).color(c.text_base).wrap()));
    }
    let head = col()
        .gap(4.0)
        .child(text("Access").font(k.ty.body_medium).color(c.text_base))
        .child(text("Groups of ships. Give a group a page from the page's Share dialog.").font(k.ty.small).color(c.text_muted).wrap());
    col()
        .key("access")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(col().w_full().items_center().child(col().w_full().max_w(760.0).padding(28.0).gap(16.0).child(head).child(asks).child(list).child(Divider::horizontal().build(k)).child(form).child(Divider::horizontal().build(k)).child(banned)))
        .scroll(ScrollSpec { stick_bottom: false })
}

/// What the share dialog is about: the open page, or the folder showing
/// in its place (the flag says which).
fn share_target(s: &App) -> Option<(String, bool)> {
    match (&s.open, &s.folder) {
        (Some(p), _) => Some((p.name.clone(), false)),
        (None, Some(f)) => Some((f.clone(), true)),
        _ => None,
    }
}

/// Lets the ship typed in the share dialog read or edit the page or folder.
fn grant(s: &mut App, edit: bool) {
    let (Some(c), Some((name, _))) = (s.conn.clone(), share_target(s)) else {
        s.note = "sample pages cannot be shared".into();
        return;
    };
    let p = Page { name, ..Page::default() };
    let Some(ship) = api::ship_name(&s.grant_to.text) else {
        s.note = "enter a ship's name, like ~sampel-palnet".into();
        return;
    };
    s.grant_to = TextEdit::new("");
    s.op_req.request((c, p.name.clone(), ship), move |(c, n, ship)| {
        let told = c.grant(&n, &ship, edit)?;
        Ok(Op::Granted(n, ship, edit, told))
    });
}

/// Asks the ship to share the open page in `mode`.
fn share_as(s: &mut App, mode: &'static str) {
    let (Some(c), Some((name, folder))) = (s.conn.clone(), share_target(s)) else {
        s.note = "sample pages cannot be shared".into();
        return;
    };
    let op = if folder { Op::SharedDir(name, mode.to_owned()) } else { Op::Shared(name, mode.to_owned()) };
    s.op_req.request((c, op), |(c, op)| {
        match &op {
            Op::Shared(n, mode) => c.share(n, mode)?,
            Op::SharedDir(n, mode) => c.share_dir(n, mode)?,
            _ => {}
        }
        Ok(op)
    });
}

/// The share dialog: who may read the open page, and where from.
fn share_view(s: &App, k: &Kit, layer: &mut Vec<El>) {
    let (true, Some((name, folder))) = (s.sharing, share_target(s)) else { return };
    let p = &Page { name, ..Page::default() };
    let c = &k.c;
    let now = if folder { &s.dshares } else { &s.shares }.get(&p.name).map_or("private", String::as_str);
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
        .child(choice("private", "Private", if folder { "The folder shares nothing of its own. A page in it keeps its own setting." } else { "Only you, signed in to your ship." }))
        .child(choice("shared", "Over Urbit", if folder { "Every page in it, and pages added later, for the ships and groups you grant." } else { "Ships and groups you grant, at a urb:// address." }))
        .child(choice("clearweb", "On the web", if folder { "Every page in it, and pages added later, for anyone with the link." } else { "Anyone with the link, with no sign-in." }));
    // the sensitive mark, known once the ship has answered
    let marked = s.sens.get(&p.name).copied();
    body = body.child(
        row()
            .key("share-sensitive")
            .w_full()
            .gap(10.0)
            .center_y()
            .child(Switch::new(marked.unwrap_or(false)).label("Sensitive").on_toggle(flip_sens).build(k).key("sens-toggle"))
            .child(text(match marked {
                Some(true) => "Folders and groups do not share it, and an agent key needs clearance to read it.",
                Some(false) => "Mark it to keep it from agent keys without clearance and from folder and group shares.",
                None => "Asking the ship.",
            }).font(k.ty.small).color(c.text_muted).wrap().grow(1.0).min_w(0.0)),
    );
    // the ships let in by name: this works on a private page too
    // a folder's readers are not listed: the access list names a folder's pages one by one
    let who = if folder { Vec::new() } else { api::readers(&s.groups, &p.name) };
    let mut ships = col().key("share-ships").w_full().gap(4.0).child(text("Ships").font(k.ty.small_medium).color(c.text_muted));
    for r in &who {
        let (page, ship) = (p.name.clone(), r.ship.clone());
        let how = match (&r.via, r.edit) {
            (Some(dir), true) => format!("can edit, through the folder {dir}"),
            (Some(dir), false) => format!("can read, through the folder {dir}"),
            (None, true) => "can edit".to_owned(),
            (None, false) => "can read".to_owned(),
        };
        let mut line = row()
            .key(format!("reader-{}", r.ship))
            .w_full()
            .gap(8.0)
            .center_y()
            .child(text(r.ship.clone()).font(k.ty.mono).color(c.text_base))
            .child(text(how).font(k.ty.small).color(c.text_muted).grow(1.0).min_w(0.0).truncate());
        // a folder's grant is taken back on the folder, not here
        if r.via.is_none() {
            line = line.child(Button::new("Remove").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
                let Some(c) = s.conn.clone() else { return };
                s.op_req.request((c, page.clone(), ship.clone()), |(c, n, ship)| {
                    c.ungrant(&n, &ship)?;
                    Ok(Op::Ungranted(n, ship))
                });
            }).build(k).key(format!("ungrant-{}", r.ship)));
        }
        ships = ships.child(line);
    }
    if who.is_empty() {
        ships = ships.child(text(if folder { "Let a ship into every page in this folder." } else { "No ship is let in by name." }).font(k.ty.small).color(c.text_faint));
    }
    ships = ships.child(
        row()
            .w_full()
            .gap(6.0)
            .center_y()
            .child(TextInput::new(&s.grant_to).placeholder("~sampel-palnet").on_edit(|s: &mut App| &mut s.grant_to).on_submit(|s: &mut App, _| grant(s, false)).build(k).grow(1.0).min_w(0.0).key("grant-ship"))
            .child(Button::new("Can read").control_size(ControlSize::Small).on_press(|s: &mut App| grant(s, false)).build(k).key("grant-read"))
            .child(Button::new("Can edit").control_size(ControlSize::Small).on_press(|s: &mut App| grant(s, true)).build(k).key("grant-edit")),
    );
    body = body.child(Divider::horizontal().build(k)).child(ships);
    // each group, and what it may do with this page
    let groups: Vec<&Group> = s.groups.iter().filter(|g| g.name != "public").collect();
    if !groups.is_empty() && !s.base.is_empty() && !folder {
        let mut rows = col().key("share-groups").w_full().gap(4.0).child(text("Groups").font(k.ty.small_medium).color(c.text_muted));
        for g in groups {
            let now = g.level(&s.base, &p.name);
            let mut line = row().key(format!("grp-{}", g.name)).w_full().gap(6.0).center_y().child(text(g.name.clone()).font(k.ty.ui).color(c.text_base).grow(1.0).min_w(0.0).truncate());
            for (label, level) in [("None", Level::None), ("Read", Level::Read), ("Edit", Level::Edit)] {
                let (g, page) = (g.clone(), p.name.clone());
                let key = format!("grp-{}-{}", g.name, label.to_lowercase());
                line = line.child(
                    Button::new(label)
                        .control_size(ControlSize::Small)
                        .variant(if now == level { ButtonVariant::Contrast } else { ButtonVariant::Ghost })
                        .on_press(move |s: &mut App| {
                            let say = match level {
                                Level::None => format!("{} no longer reads {page}", g.name),
                                Level::Read => format!("{} can now read {page}", g.name),
                                Level::Edit => format!("{} can now edit {page}", g.name),
                            };
                            let next = g.with_level(&s.base, &page, level);
                            save_group(s, next, say);
                        })
                        .build(k)
                        .key(key),
                );
            }
            rows = rows.child(line);
        }
        body = body.child(rows);
    }
    if let Some(addr) = s.conn.as_ref().and_then(|c| if folder { c.dir_address(&p.name, now) } else { c.address(&p.name, now) }) {
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
    // a new page starts in the folder showing, or beside the open page
    let dir = match (&s.folder, &s.open) {
        (Some(f), None) => format!("{f}/"),
        (_, p) => p.as_ref().and_then(|p| p.name.rsplit_once('/')).map_or(String::new(), |(d, _)| format!("{d}/")),
    };
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
            } else if !s.editing {
                // a folder shows what it holds, and can be renamed, moved or deleted there
                s.access = false;
                s.shared_open = false;
                s.inbox = false;
                s.remote = None;
                s.want = None;
                s.folder = Some(id.to_owned());
                s.open = None;
                s.old = None;
                sync_map(s);
                sync_sheet(s);
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
    let with_me = Button::new(format!("Shared with me {}", s.shared.len())).control_size(ControlSize::Small).variant(if s.shared_open { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(go_shared).build(k).key("shared-open");
    let inbox = Button::new(match s.waiting.held + s.waiting.unread { 0 => "Inbox".to_owned(), n => format!("Inbox {n}") }).control_size(ControlSize::Small).variant(if s.inbox { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).help("Held comments, activity, and comments on every page").on_press(go_inbox).build(k).key("inbox-open");
    let halves = row().key("halves").w_full().gap(4.0).child(half("half-pages", format!("Pages {pages}"), !s.memory)).child(half("half-memory", format!("Memory {knows}"), s.memory));
    let new = Button::new(if s.memory { "New memory" } else { "New page" }).variant(ButtonVariant::Ghost).help("Asks for a name and a place").on_press(ask_new).build(k).key("new");
    let new = row().w_full().gap(4.0).child(Button::new("Capture").variant(ButtonVariant::Ghost).help("A new page in the inbox, with nothing asked").on_press_tx(|s: &mut App, tx| {
        capture(s);
        tx.focus_when_shown(FIELD, false);
    }).build(k).key("capture")).child(new);
    let who = s.conn.as_ref().map_or("sample pages".to_owned(), |c| c.ship().to_owned());
    let theme = Button::new(match s.prefs.theme.as_str() {
        "dark" => "Dark",
        "light" => "Light",
        _ => "Auto",
    })
    .variant(ButtonVariant::GhostMuted)
    .help("Theme: the system's, dark, or light")
    .on_press(next_theme)
    .build(k)
    .key("theme");
    let access = Button::new("Access").variant(ButtonVariant::GhostMuted).help("Groups of ships and what they read").on_press(go_access).build(k).key("access-open");
    let foot = row()
        .w_full()
        .center_y()
        .justify_between()
        .child(text(who).key("ship").font(k.ty.small_medium).color(k.c.text_muted).grow(1.0).min_w(0.0).truncate())
        .child(access)
        .child(theme)
        .child(Button::new(if s.conn.is_some() { "Sign out" } else { "Close" }).variant(ButtonVariant::GhostMuted).on_press(sign_out).build(k).key("sign-out"));
    let mut side = col().key("pages").w_full().h_full().min_h(0.0).padding(8.0).gap(8.0).child(halves).child(filter).child(new).child(tree).child(row().gap(4.0).child(with_me).child(inbox)).child(foot);
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

/// A folder in place of a page: what it holds, and what can be done to it.
fn folder_view(dir: &str, s: &App, k: &Kit) -> El {
    let c = &k.c;
    let pages = under(&s.names, dir);
    let mut list = col().key("folder-pages").w_full().gap(2.0);
    for name in pages.iter().take(500) {
        let pick = name.clone();
        list = list.child(
            row()
                .key(format!("in:{name}"))
                .w_full()
                .h(30.0)
                .px(8.0)
                .center_y()
                .radius(k.radius.sm)
                .on_press_tx(move |s: &mut App, tx| jump_to(s, &pick, tx))
                .child(text(name[dir.len() + 1..].to_owned()).font(k.ty.ui).color(c.text_base).truncate()),
        );
    }
    let mut acts = row().gap(8.0).center_y().child(Button::new(if s.memory { "New memory here" } else { "New page here" }).on_press(ask_new).build(k).key("folder-new"));
    if !s.memory {
        let shared = s.dshares.get(dir).is_some();
        acts = acts.child(Button::new(if shared { "Shared" } else { "Share" }).variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
            s.sharing = true;
            load_groups(s);
            load_sens(s);
        }).build(k).key("folder-share"));
    }
    // a memory is its own key: there is no folder on the ship to move or delete
    if !s.memory {
        let (a, b) = (dir.to_owned(), dir.to_owned());
        acts = acts
            .child(Button::new("Rename or move").variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
                let mut t = TextEdit::new(a.clone());
                t.focused = true;
                s.prompt = Some(Prompt::Rename(a.clone(), t));
            }).build(k).key("folder-rename"))
            .child(Button::new("Delete").variant(ButtonVariant::Ghost).on_press(move |s: &mut App| s.prompt = Some(Prompt::Delete(b.clone()))).build(k).key("folder-delete"));
    }
    let head = col()
        .gap(4.0)
        .child(text(dir.to_owned()).font(k.ty.body_medium).color(c.text_base))
        .child(text(format!("{} {}", pages.len(), if s.memory { "memories" } else { "pages" })).font(k.ty.small).color(c.text_muted));
    col()
        .key("folder")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(col().w_full().items_center().child(col().w_full().max_w(760.0).padding(28.0).gap(16.0).child(head).child(acts).child(list)))
        .scroll(ScrollSpec { stick_bottom: false })
}

fn page_body(s: &App, k: &Kit) -> El {
    if s.access && !s.editing {
        return access_view(s, k);
    }
    if s.shared_open && !s.editing {
        return shared_view(s, k);
    }
    if s.inbox && !s.editing {
        return inbox_view(s, k);
    }
    if let Some(dir) = s.folder.as_ref().filter(|_| s.open.is_none()) {
        return folder_view(dir, s, k);
    }
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
        Markdown::new(md::wikilinks(&p.body, &|n| ghost(s, n))).selectable(true).on_link_tx(follow).build(k)
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
    let k = Kit::neutral(s.prefs.dark(cx.system_dark()));
    if s.conn.is_none() && !s.sample {
        return login_view(s, &k);
    }
    let path = s.open.as_ref().map(|p| p.name.as_str()).or(s.folder.as_deref());
    // the name it was given when there is one, with its path beside it
    let named = path.and_then(|p| s.dnames.get(p).filter(|_| !s.memory && s.remote.is_none()).map(|d| format!("{d}  ({p})")));
    let title = if s.inbox { "Inbox" } else if s.shared_open { "Shared with me" } else if s.access { "Access" } else { named.as_deref().or(path).unwrap_or("lattice") };
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
            .child(Switch::new(!s.prefs.no_autosave).label("Autosave").on_toggle(|s: &mut App| {
                s.prefs.no_autosave = !s.prefs.no_autosave;
                if s.conn.is_some() {
                    s.prefs.save();
                }
            }).build(&k).key("autosave"))
            .child(Button::new("Cancel").variant(ButtonVariant::Ghost).on_press(cancel_edit).build(&k).key("cancel"))
            .child(Button::new("Save").variant(ButtonVariant::Contrast).on_press(save).build(&k).key("save"));
    } else if let Some(sh) = s.remote.as_ref().filter(|_| s.open.is_some() && !s.access && !s.shared_open && !s.inbox) {
        // another ship's page: read, and edited when that ship lets this one
        trailing = trailing.child(text(format!("from {}", sh.host)).font(k.ty.small).color(k.c.text_muted));
        if !sh.editable() {
            // read only: the host can be asked for more
            let (to, asked) = (sh.clone(), s.asks.sent.iter().any(|a| a.ship == sh.host && a.path == sh.path));
            trailing = trailing.child(Button::new(if asked { "Ask again" } else { "Ask to edit" }).variant(ButtonVariant::Ghost).help(if asked { "You asked already. Asking again replaces that request" } else { "Ask its ship to let you edit it" }).on_press(move |s: &mut App| {
                let mut t = TextEdit::new("");
                t.focused = true;
                s.prompt = Some(Prompt::Ask(to.clone(), t));
            }).build(&k).key("ask-edit"));
        }
        if sh.editable() {
            trailing = trailing.child(Button::new("Edit").variant(ButtonVariant::Ghost).on_press_tx(|s: &mut App, tx| {
                start_edit(s);
                tx.focus_when_shown(FIELD, false);
            }).build(&k).key("edit"));
        }
    } else if s.open.is_some() && !s.access && !s.shared_open && !s.inbox {
        // a memory has no sharing, history pane or rename here
        if !s.memory {
            let shared = s.open.as_ref().and_then(|p| s.shares.get(&p.name)).is_some_and(|m| m != "private");
            trailing = trailing.child(Button::new(if shared { "Shared" } else { "Share" }).variant(ButtonVariant::GhostMuted).on_press(open_share).build(&k).key("share"));
        }
        if !s.memory {
            // one side pane, three things in it: pressing the one showing closes it
            trailing = trailing.child(Button::new("Links").variant(ButtonVariant::GhostMuted).help("Pages that link here, and pages this links to").on_press(|s: &mut App| show_pane(s, false, true)).build(&k).key("links-toggle"));
            trailing = trailing.child(Button::new("Comments").variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| show_pane(s, true, false)).build(&k).key("comments-toggle-pane"));
            trailing = trailing.child(Button::new("History").variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| show_pane(s, false, false)).build(&k).key("history-toggle"));
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
    palette_view(s, &k, &mut layer);
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
        .inspector(&s.inspector, |s: &mut App| &mut s.inspector, if s.pane_links { links_view(s, &k) } else if s.pane_comments { comments_view(s, &k) } else { history_view(s, &k) })
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
    if ev.is_command('p') && !s.editing {
        let mut q = TextEdit::new("");
        q.focused = true;
        s.palette = Some(q);
        s.palette_at = 0;
        return true;
    }
    if (ev.is_command('k') || ev.is_command('o')) && !s.editing {
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
    if ev.is_command('e') && !s.editing && s.remote.as_ref().is_none_or(Shared::editable) {
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
    fn a_folder_is_renamed_and_deleted_with_every_page_in_it() {
        let mut s = sample("welcome");
        assert_eq!(under(&s.names, "notes"), ["notes/today", "notes/ideas/maps"]);
        assert!(under(&s.names, "note").is_empty(), "a name that only starts the same is not under it");
        // rename the folder: its pages move with their texts, and the folder stays picked
        s.open = None;
        s.folder = Some("notes".into());
        let mut t = TextEdit::new("archive/notes");
        t.focused = true;
        s.prompt = Some(Prompt::Rename("notes".into(), t));
        confirm(&mut s);
        assert_eq!(s.folder.as_deref(), Some("archive/notes"));
        assert!(s.cache["archive/notes/today"].body.starts_with("# Today") && !s.cache.contains_key("notes/today"));
        assert_eq!(under(&s.names, "archive/notes").len(), 2);
        // a new page from the folder starts inside it
        ask_new(&mut s);
        assert!(matches!(&s.prompt, Some(Prompt::New(t)) if t.text == "archive/notes/"));
        // delete it: both pages go, the others stay
        s.prompt = Some(Prompt::Delete("archive/notes".into()));
        confirm(&mut s);
        assert!(under(&s.names, "archive").is_empty() && s.folder.is_none());
        assert!(s.names.contains(&"welcome".to_owned()) && s.cache.contains_key("welcome"));
    }

    #[test]
    fn a_groups_ships_are_changed_only_by_a_list_that_reads() {
        let mut s = sample("welcome");
        s.groups = vec![Group { name: "team".into(), ships: vec!["~nec".into()], peek: vec!["/x/page/a/code".into()], make: vec![] }];
        // a list that does not read keeps the field open and says why
        s.group_edit = Some(("team".into(), TextEdit::new("~nec Bad")));
        save_ships(&mut s);
        assert_eq!(s.note, "Bad is not a ship's name");
        assert!(matches!(&s.group_edit, Some((n, t)) if n == "team" && t.text == "~nec Bad"));
        // one that reads closes it (with no ship to write to here, nothing more happens)
        s.group_edit = Some(("team".into(), TextEdit::new("~nec ~wes")));
        save_ships(&mut s);
        assert!(s.group_edit.is_none());
        // a group that went away meanwhile is not written
        s.group_edit = Some(("gone".into(), TextEdit::new("~nec")));
        save_ships(&mut s);
        assert!(s.group_edit.is_none());
    }

    #[test]
    fn the_share_dialog_is_about_the_open_page_or_the_folder_showing() {
        let mut s = sample("welcome");
        assert_eq!(share_target(&s), Some(("welcome".to_owned(), false)));
        s.open = None;
        assert_eq!(share_target(&s), None);
        s.folder = Some("notes".into());
        assert_eq!(share_target(&s), Some(("notes".to_owned(), true)));
        // a page opened from the folder takes over
        open_page(&mut s, "notes/today");
        assert_eq!(share_target(&s), Some(("notes/today".to_owned(), false)));
    }

    #[test]
    fn an_ask_for_edit_is_noted_as_sent_with_its_note_cut() {
        let mut s = sample("welcome");
        let sh = Shared { host: "~bus".into(), path: "/x/page/plans/code".into(), mode: "read".into(), when: String::new() };
        s.prompt = Some(Prompt::Ask(sh, TextEdit::new(format!("  {}  ", "n".repeat(300)))));
        confirm(&mut s);
        assert!(s.prompt.is_none());
        assert_eq!((s.asks.sent[0].ship.as_str(), s.asks.sent[0].name.as_str(), s.asks.sent[0].note.len()), ("~bus", "plans", 280));
        assert_eq!(s.note, "asked ~bus for edit access to plans");
    }

    #[test]
    fn the_links_pane_knows_what_links_here_and_which_links_are_ghosts() {
        let mut s = sample("notes/today");
        show_pane(&mut s, false, true);
        assert_eq!(s.back, Some(("notes/today".to_owned(), vec!["welcome".to_owned()])));
        assert!(ghost(&s, "not/written") && !ghost(&s, "welcome"));
        // a memory by that name is not a ghost either
        let key = s.other.1[0].clone();
        assert!(!ghost(&s, &key));
        // a ghost offers to make the page, a real one opens
        go(&mut s, "not/written");
        assert!(matches!(&s.prompt, Some(Prompt::New(t)) if t.text == "not/written"));
        s.prompt = None;
        go(&mut s, "welcome");
        assert_eq!(s.open.as_ref().map(|p| p.name.as_str()), Some("welcome"));
        // the same button closes the pane
        show_pane(&mut s, false, true);
        assert!(!s.inspector.is_open());
    }

    #[test]
    fn a_capture_is_kept_by_its_first_save_and_dropped_when_empty_or_cancelled() {
        let mut s = sample("welcome");
        let pages = s.names.len();
        capture(&mut s);
        let name = s.open.as_ref().unwrap().name.clone();
        assert!(name.starts_with("inbox/20") && s.editing && s.capture && !s.names.contains(&name));
        // nothing typed: nothing is saved, and cancel leaves no page behind
        save(&mut s);
        assert!(s.editing && s.note == "nothing to keep yet" && s.names.len() == pages);
        cancel_edit(&mut s);
        assert!(s.open.is_none() && !s.capture && !s.editing && !s.cache.contains_key(&name));
        // typed and saved: it is a page like any other
        capture(&mut s);
        let name = s.open.as_ref().unwrap().name.clone();
        s.edit = TextEdit::new("an idea\n");
        s.rich = false;
        save(&mut s);
        assert!(!s.capture && !s.editing && s.names.contains(&name));
        assert_eq!(s.cache[&name].body, "an idea\n");
        // a later edit cancelled keeps the page
        start_edit(&mut s);
        cancel_edit(&mut s);
        assert_eq!(s.open.as_ref().map(|p| p.name.clone()), Some(name));
        // from the memory half it lands among the pages
        flip(&mut s);
        capture(&mut s);
        assert!(!s.memory && s.capture);
    }

    #[test]
    fn autosave_keeps_rested_text_and_never_writes_a_page_as_it_was_read() {
        let mut s = sample("welcome");
        let rev = s.open.as_ref().unwrap().rev;
        start_edit(&mut s);
        // untouched, however long it rests: nothing is written
        for t in [0.0, 2.0, 4.0, 6.0] {
            assert!(!autosave_tick(&mut s, t));
        }
        assert_eq!(s.open.as_ref().unwrap().rev, rev);
        // typed: not at the first look, which may be mid-word, but at the next
        s.edit = TextEdit::new("# changed\n");
        s.rich = false;
        assert!(!autosave_tick(&mut s, 8.0));
        assert!(!autosave_tick(&mut s, 9.0), "a look comes every two seconds, not sooner");
        assert!(autosave_tick(&mut s, 10.0));
        let p = s.open.clone().unwrap();
        assert_eq!((p.body.as_str(), p.rev, s.editing), ("# changed\n", rev + 1, true), "saved, and still in the editor");
        assert!(!autosave_tick(&mut s, 12.0), "nothing new, nothing written");
        // switched off, it waits for Save, which closes the editor
        s.prefs.no_autosave = true;
        s.edit = TextEdit::new("# again\n");
        assert!(!autosave_tick(&mut s, 14.0) && !autosave_tick(&mut s, 16.0));
        save(&mut s);
        assert_eq!((s.open.as_ref().unwrap().rev, s.editing), (rev + 2, false));
        // a capture with no text is never saved, and one with text is made
        s.prefs.no_autosave = false;
        capture(&mut s);
        assert!(!autosave_tick(&mut s, 20.0) && !autosave_tick(&mut s, 22.0));
        s.edit = TextEdit::new("kept\n");
        s.rich = false;
        assert!(!autosave_tick(&mut s, 24.0));
        assert!(autosave_tick(&mut s, 26.0));
        let name = s.open.as_ref().unwrap().name.clone();
        assert!(s.names.contains(&name) && !s.capture && s.editing);
        // a page that changed elsewhere is left for the person to settle
        s.stale = true;
        s.edit = TextEdit::new("mine\n");
        assert!(!autosave_tick(&mut s, 28.0) && !autosave_tick(&mut s, 30.0));
    }

    #[test]
    fn the_switcher_lists_recent_pages_first_and_offers_to_make_a_new_name() {
        let mut s = sample("welcome");
        s.prefs.recent.clear();
        for n in ["notes/today", "budget", "welcome", "notes/today", "places"] {
            open_page(&mut s, n);
        }
        // newest first, each once, without the one in front, and none that is gone
        s.prefs.recent.push("deleted/long-ago".into());
        let names: Vec<String> = found(&s, "  ").into_iter().map(|r| r.0).collect();
        assert_eq!(names, ["notes/today", "welcome", "budget"]);
        for i in 0..20 {
            s.prefs.opened(&format!("p{i}"));
        }
        assert_eq!(s.prefs.recent.len(), 10);
        // a name no page has can be made, an exact one cannot, and a typed name becomes a path
        assert_eq!(creatable(&s, "budget"), None);
        assert_eq!(creatable(&s, "budge").as_deref(), Some("budge"));
        assert_eq!(creatable(&s, " Plans/Next Week ").as_deref(), api::real_name("Plans/Next Week").map(|r| r.name).as_deref());
        assert_eq!(creatable(&s, "   "), None);
        let pages = s.names.len();
        s.jump = Some(TextEdit::new("plans/next"));
        jump_create(&mut s);
        assert!(s.jump.is_none() && s.names.len() == pages + 1);
        assert_eq!(s.open.as_ref().map(|p| p.name.as_str()), Some("plans/next"));
    }

    #[test]
    fn the_palette_puts_the_commands_run_last_first_and_hides_what_cannot_run() {
        let mut s = sample("welcome");
        s.prefs.used.clear();
        let ids = |s: &App, q: &str| commands(s, q).into_iter().map(|c| c.0).collect::<Vec<_>>();
        // nothing run yet: the table's order, without what needs a ship
        assert_eq!(ids(&s, "")[..3], ["new", "capture", "open"]);
        assert!(!ids(&s, "").contains(&"reload"));
        // run two: the last is first, the one before it second, the rest as they were
        s.prefs.used = vec!["rename".into(), "theme".into()];
        assert_eq!(ids(&s, "")[..4], ["rename", "theme", "new", "capture"]);
        // typing narrows, and among equal matches the one run last leads
        assert_eq!(ids(&s, "rename"), ["rename"]);
        assert!(ids(&s, "zzzz").is_empty());
        // with no page in front, the commands about a page are not offered
        s.open = None;
        let none = ids(&s, "");
        assert!(["edit", "rename", "delete", "share", "links", "history"].iter().all(|c| !none.contains(c)), "{none:?}");
        assert!(none.contains(&"inbox") && none.contains(&"new"));
        // every command has a name of its own
        let mut names: Vec<&str> = COMMANDS.iter().map(|c| c.0).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), COMMANDS.len());
    }

    #[test]
    fn opening_a_notice_shows_what_it_is_about_and_marks_it_read() {
        let mut s = sample("welcome");
        s.inbox = true;
        let n = s.notices[0].clone();
        assert_eq!((n.read, s.waiting.unread), (false, 1));
        open_notice(&mut s, &n);
        assert_eq!((s.open.as_ref().map(|p| p.name.as_str()), s.inbox), (Some("notes/today"), false));
        assert_eq!((s.notices[0].read, s.waiting.unread), (true, 0));
        // a notice with nowhere to open here is left as it was
        let mut forum = s.notices[1].clone();
        forum.read = false;
        s.notices[1].read = false;
        open_notice(&mut s, &forum);
        assert!(!s.notices[1].read);
        mark_read(&mut s, None);
        assert!(s.notices.iter().all(|n| n.read));
    }

    #[test]
    fn a_comment_in_the_inbox_opens_its_page_from_either_half() {
        let mut s = sample("welcome");
        s.inbox = true;
        flip(&mut s);
        open_comment_page(&mut s, "welcome");
        assert_eq!((s.open.as_ref().map(|p| p.name.as_str()), s.inbox, s.memory), (Some("welcome"), false, false));
        // a comment on a page since deleted says so and opens nothing else
        s.inbox = true;
        open_comment_page(&mut s, "gone");
        assert_eq!((s.open.as_ref().map(|p| p.name.as_str()), s.inbox), (Some("welcome"), true));
        assert_eq!(s.note, "gone is no longer a page");
    }

    #[test]
    fn a_shared_page_opens_in_place_of_a_page_and_is_not_kept_as_one() {
        let mut s = sample("welcome");
        let kept = s.cache.len();
        let sh = s.shared[0].clone();
        s.shared_open = true;
        open_remote(&mut s, sh.clone());
        let p = s.open.clone().unwrap();
        assert_eq!((p.name.as_str(), s.remote.as_ref(), s.shared_open), ("~sampel-palnet/plans/trip", Some(&sh), false));
        // an edit and a save: the text shows, and it is not among this ship's pages
        start_edit(&mut s);
        s.edit = TextEdit::new("# trip\n\nchanged\n");
        s.rich = false;
        save(&mut s);
        assert_eq!(s.open.as_ref().unwrap().body, "# trip\n\nchanged\n");
        assert_eq!(s.cache.len(), kept);
        assert!(!s.names.iter().any(|n| n.contains("plans/trip")));
        // opening a page of this ship leaves the shared one
        open_page(&mut s, "welcome");
        assert!(s.remote.is_none());
    }

    #[test]
    fn a_page_named_with_capitals_gets_a_path_and_shows_its_name() {
        let mut s = sample("welcome");
        s.prompt = Some(Prompt::New(TextEdit::new("Trips/Barcelona & Back")));
        confirm(&mut s);
        let p = s.open.as_ref().expect("the new page opens");
        assert_eq!(p.name, "trips/barcelona-back");
        assert_eq!((s.dnames["trips"].as_str(), s.dnames["trips/barcelona-back"].as_str()), ("Trips", "Barcelona & Back"));
        // the tree's rows carry the names
        assert_eq!((s.files.get("trips").unwrap().name.as_str(), s.files.get("trips/barcelona-back").unwrap().name.as_str()), ("Trips", "Barcelona & Back"));
        // a rename to a plain path shows the path again
        s.prompt = Some(Prompt::Rename("trips/barcelona-back".into(), TextEdit::new("trips/spain")));
        confirm(&mut s);
        assert!(!s.dnames.contains_key("trips/barcelona-back") && !s.dnames.contains_key("trips/spain"));
        assert_eq!(s.files.get("trips/spain").unwrap().name, "spain");
        // a name with nothing to keep is refused, and says so
        s.prompt = Some(Prompt::New(TextEdit::new("!!!")));
        confirm(&mut s);
        assert_eq!(s.note, "that name has nothing a path can keep");
    }

    #[test]
    fn a_page_asked_for_before_its_text_is_kept_is_waited_for() {
        let mut s = sample("welcome");
        // as on a ship: the page was just made and its text is not kept yet
        s.open = None;
        show_page(&mut s, "fresh/page");
        assert_eq!((s.open.is_none(), s.want.as_deref()), (true, Some("fresh/page")));
        // picking something else stops the wait
        show_page(&mut s, "welcome");
        assert_eq!((s.want.as_deref(), s.open.as_ref().map(|p| p.name.as_str())), (None, Some("welcome")));
    }

    #[test]
    fn the_sensitive_mark_flips_for_what_the_dialog_is_about() {
        let mut s = sample("welcome");
        flip_sens(&mut s);
        assert_eq!(s.sens.get("welcome"), Some(&true));
        assert!(s.note.starts_with("welcome is sensitive:"));
        flip_sens(&mut s);
        assert_eq!((s.sens.get("welcome"), s.note.as_str()), (Some(&false), "welcome is no longer marked sensitive"));
        // a folder showing is marked by its own name, and the page stays as it was
        s.open = None;
        s.folder = Some("notes".into());
        flip_sens(&mut s);
        assert_eq!((s.sens.get("notes"), s.sens.get("welcome")), (Some(&true), Some(&false)));
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
