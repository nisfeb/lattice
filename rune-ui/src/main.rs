//! lattice, drawn natively with Rune: an experiment beside the shipped desktop app.
//!
//! `LATTICE_URL=https://ship LATTICE_COOKIE=/path/to/cookie cargo run` opens a ship.
//! With neither set it opens on built-in sample pages, which is also what the
//! headless runs draw: `cargo run -- --snap out.png --scene reading`.

mod api;
mod calc;
mod code;
mod formula;
mod html;
mod funcs;
mod map;
mod mapio;
mod md;
mod odf;
mod pdf;
mod scad;
mod scadrun;
mod sheet;
mod shift;
mod styles;
mod tex;
mod upload;
mod view3d;

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
    /// The base map its tiles are of.
    style: &'static str,
    /// The maps drawn under this one, dimmed and never written: each by
    /// name, with its features, or nothing when it could not be read.
    // ponytail: read when this map's text moves. A layer page changed
    // meanwhile shows when this map is opened again
    under: Vec<(String, Option<Vec<map::Feature>>)>,
    /// What a press on the ground draws, when a drawing tool is on.
    tool: Option<map::Draw>,
    /// The corners of the line or area being drawn, each a longitude and latitude.
    verts: Vec<[f64; 2]>,
    /// The picked point being dragged: which feature, and how far in points.
    moving: Option<(usize, f32, f32)>,
    /// The corner of the picked shape being dragged: which, and how far in points.
    grip: Option<(usize, f32, f32)>,
    /// Whether the feature a save adds is to be picked when it lands.
    pick_new: bool,
    /// The kinds not shown. Not kept: a map opens with every kind showing, as on the web.
    hidden: std::collections::HashSet<String>,
}

/// An OpenSCAD part on screen: the page it is of, its triangles, where
/// it is seen from, and the picture of that.
struct PartView {
    name: String,
    mesh: std::sync::Arc<scadrun::Mesh>,
    cam: view3d::Cam,
    /// The camera when the drag in hand began.
    grab: view3d::Cam,
    /// A drag slides the view, where it would turn it.
    pan: bool,
    /// The newest picture, and the one before it, shown until the newest is ready.
    pic: Option<rune::Image>,
    was: Option<rune::Image>,
}

/// How big the part's picture is on the page, in points. It is drawn at twice that.
// ponytail: one size, which fits the page's column in a window 930 points wide or more. Sized to the column if narrow windows matter
const PART_SIZE: (f32, f32) = (600.0, 360.0);

/// The page held beside, as what its kind is drawn from: read once for
/// each revision, and not on every frame.
enum Beside {
    /// A spreadsheet's sheets, the one showing, and its grid's state.
    Sheet(Vec<sheet::Sheet>, usize, TableState),
    Map(Vec<map::Feature>),
    /// An HTML or gemtext page as the Markdown it is read as.
    Read(String),
}

/// A spreadsheet page on screen: its sheets, the one showing, and the grid's state.
struct SheetView {
    name: String,
    rev: u64,
    sheets: Vec<sheet::Sheet>,
    at: usize,
    table: TableState,
    /// The sheets again with each cell's type and style, and the page's styles: how the cells look.
    looks: Option<(sheet::Book, styles::Styles)>,
    /// The sheet to show once the save in hand lands: one just added.
    want: Option<usize>,
    /// The picked cell is to be read again when the save in hand lands: its rows moved.
    repick: bool,
    /// The cell picked to be changed: its row and column.
    cursor: Option<(usize, usize)>,
    /// What is being typed into the picked cell.
    entry: TextEdit,
    /// What the bar held when the cell was picked: its text, or its formula as typed.
    entry_was: String,
    /// The formulas a change reached that could not be worked out here: sheet, row, column.
    /// They keep the values they had, until a later change works them out.
    stale: std::collections::BTreeSet<(usize, usize, usize)>,
}

/// A question the window is asking: a name for a new page, a new name for
/// the open one, or whether to delete it.
enum Prompt {
    New(TextEdit),
    Rename(String, TextEdit),
    Delete(String),
    /// The address for a link on the editor's selection.
    Link(TextEdit),
    /// A map feature's name, kind, note, time, source and ring radius: its place in the page, and the fields in that order.
    Feature(usize, Box<[TextEdit; 6]>),
    /// The ship's Mapbox token, to set or, left empty, to clear.
    Token(TextEdit),
    /// A name for a copy of a page: the page as it stood, and the name.
    Duplicate(Page, TextEdit),
    /// A note to go with an ask for edit on another ship's page.
    Ask(Shared, TextEdit),
    /// A tag to put on the memory in front.
    Tag(TextEdit),
    /// A value typed for an OpenSCAD parameter: its name, which part of a vector, and the text.
    Param(String, Option<usize>, TextEdit),
}

/// A tab that is not in front: the pages it went through, and which of
/// them it shows.
#[derive(Clone, Default)]
struct Tab {
    trail: Vec<String>,
    at: usize,
}

impl Tab {
    fn page(&self) -> Option<&str> {
        self.trail.get(self.at).map(String::as_str)
    }
}

/// A change to the tree that landed on the ship.
enum Op {
    /// A deleted memory was brought back from the trash.
    Restored(String),
    /// A memory's tag was put on or taken off: the memory, the tag, which.
    Tagged(String, String, bool),
    Created(String),
    Renamed(String, String),
    Deleted(String),
    /// A page's share mode was set, or a folder's.
    Shared(String, String),
    SharedDir(String, String),
    /// A page or folder was marked sensitive or unmarked, and whether its
    /// own share still stands.
    Sensed(String, bool, bool),
    /// Files were uploaded: the pages made, and the files left out with why.
    Uploaded(Vec<String>, Vec<String>),
    /// A page was written beside the one in front: its name, its text when
    /// there is no ship to read it from, and what to say.
    Wrote(String, Option<Page>, String),
    /// A file was read for the map in front: its features, and what to say of it.
    MapIn(Vec<serde_json::Value>, String),
    /// The ship's Mapbox token was set or cleared: what to say.
    Tokened(String),
    /// Something was done that changes nothing here: what to say.
    Said(String),
    /// A template made a page or a folder of pages at this name.
    Templated(String),
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
    /// Whether orrery keeps `orrery/map`, as the ship last said. Until it
    /// says, the map is taken as kept, as the web client takes it.
    kept: Option<bool>,
    kept_req: Latest<Result<Option<bool>, String>>,
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
    /// An OpenSCAD page being drawn by this machine's openscad: its name, its revision, and what came of it.
    scad_req: Latest<(String, u64, scadrun::Drawn)>,
    /// The OpenSCAD page last asked to be drawn, and what the open one came to.
    scad_for: Option<(String, u64)>,
    scad: Option<(String, u64, scadrun::Drawn)>,
    /// The part in 3D, and its picture being drawn: the page, the picture's size, its pixels.
    part: Option<PartView>,
    part_req: Latest<(String, u32, u32, Vec<u8>)>,
    /// A page of another ship that the reader said may be drawn here.
    scad_ok: Option<String>,
    /// A LaTeX page being read by pandoc: its name, its revision, and the Markdown or why there is none.
    tex_req: Latest<(String, u64, Result<String, String>)>,
    /// The LaTeX page pandoc was last asked to read, and why the open one shows as its source when it does.
    tex_for: Option<(String, u64)>,
    tex_why: Option<(String, u64, String)>,
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
    /// The deleted memories still in the trash, when the trash is showing: nothing yet while it is read.
    trash: Option<Option<Vec<String>>>,
    trash_req: Latest<Result<Vec<String>, String>>,
    /// The tag the memories are filtered by, when they are.
    know_tag: Option<String>,
    know_req: Latest<Result<Vec<Know>, String>>,
    /// The open page as the Markdown it is read as, when it is of a kind read that way and is not Markdown: its name, its revision, the text.
    read_as: Option<(String, u64, String)>,
    /// The page held beside, when its kind has a view of its own: its name, its revision, the view.
    beside: Option<(String, u64, Beside)>,
    /// The open page as a spreadsheet, when it is one.
    sheet: Option<SheetView>,
    /// The open page as a map, when it is one.
    map: Option<MapView>,
    /// The pages visited, oldest first, and where in them the window is.
    trail: Vec<String>,
    trail_at: usize,
    /// The tabs. Each keeps the pages it went through and where it is
    /// among them. The one in front lives in `trail` and `open` while it
    /// is there, and its slot here is filled when another comes forward.
    tabs: Vec<Tab>,
    tab: usize,
    /// The page held beside the one in front, to read while working on another.
    split: Option<String>,
    /// The tree is to be read once more a moment from now: the ship
    /// answers a batch before it has written all of it.
    resync: bool,
    /// Find in the page being read: what is typed, and which match is the current one.
    find: Option<TextEdit>,
    find_at: usize,
    /// Images in pages: the decoder, the pictures had so far by their
    /// source as written, the sources asked for (so none is asked twice),
    /// what the fetching threads bring back, and the page they are for.
    image_cache: Option<std::rc::Rc<rune::ImageCache>>,
    pics: HashMap<String, rune::Image>,
    pics_asked: std::collections::HashSet<String>,
    pics_in: std::sync::Arc<std::sync::Mutex<Vec<(String, Result<Vec<u8>, String>)>>>,
    pics_for: Option<(String, u64)>,
    /// How many of the pictures had were decoded at the last look.
    pics_ready: usize,
    /// Map tiles: what the ship says it can give, how many are on their
    /// way, and why none are coming when none are.
    tile_status: Option<api::TileStatus>,
    tile_status_req: Latest<Result<api::TileStatus, String>>,
    tiles_flying: usize,
    tiles_off: Option<String>,
    waker: Option<Waker>,
    /// Files from another app are being held over the window.
    dropping: bool,
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
    /// New from a template: the ship's templates, the dialog when open
    /// (the one chosen and the name typed), and what to show once the
    /// tree has what the template made.
    templates: Vec<String>,
    templates_req: Latest<Result<Vec<String>, String>>,
    tmpl: Option<(String, TextEdit)>,
    land: Option<String>,
    /// Wiki link completion in the editor: the row chosen, and where the
    /// link being typed starts when its offers were dismissed.
    ac_at: usize,
    ac_off: Option<usize>,
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
    ("region", r#"{"type":"FeatureCollection","lattice":{"layers":["places","nowhere"]},"features":[
]}
"#),
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
        kept: None,
        kept_req: Latest::default(),
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
        tex_req: Latest::default(),
        scad_req: Latest::default(),
        scad_for: None,
        scad: None,
        scad_ok: None,
        part: None,
        part_req: Latest::default(),
        tex_for: None,
        tex_why: None,
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
        know_tag: None,
        trash: None,
        trash_req: Latest::default(),
        know_req: Latest::default(),
        read_as: None,
        beside: None,
        sheet: None,
        map: None,
        trail: Vec::new(),
        trail_at: 0,
        tabs: vec![Tab::default()],
        tab: 0,
        split: None,
        resync: false,
        find: None,
        find_at: 0,
        image_cache: None,
        pics: HashMap::new(),
        pics_asked: std::collections::HashSet::new(),
        pics_in: Default::default(),
        pics_for: None,
        pics_ready: 0,
        tile_status: None,
        tile_status_req: Latest::default(),
        tiles_flying: 0,
        tiles_off: None,
        waker: None,
        dropping: false,
        cache: HashMap::new(),
        note: String::new(),
        names: Vec::new(),
        jump: None,
        jump_at: 0,
        palette: None,
        templates: Vec::new(),
        templates_req: Latest::default(),
        tmpl: None,
        land: None,
        ac_at: 0,
        ac_off: None,
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
    refilter(s);
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

/// Puts a tag on the memory in front, or takes one off.
fn set_tag(s: &mut App, tag: String, on: bool) {
    let Some(name) = s.open.as_ref().filter(|_| s.memory).map(|p| p.name.clone()) else { return };
    match s.conn.clone() {
        Some(c) => s.op_req.request((c, name, tag), move |(c, name, tag)| {
            c.know_tag(&format!("/{name}"), &tag, on)?;
            Ok(Op::Tagged(name, tag, on))
        }),
        None => applied(s, Op::Tagged(name, tag, on)),
    }
}

/// Every tag the memories carry, in order.
fn know_tags(s: &App) -> Vec<String> {
    let mut tags: Vec<String> = s.know_meta.values().flat_map(|m| m.0.iter().cloned()).collect();
    tags.sort();
    tags.dedup();
    tags
}

/// Shows the tree by what is typed in the filter and, for memories, by the tag picked.
fn refilter(s: &mut App) {
    let q = s.query.text.trim().to_lowercase();
    let tagged: Option<std::collections::HashSet<String>> = s.know_tag.as_ref().filter(|_| s.memory).map(|t| s.know_meta.iter().filter(|(_, m)| m.0.contains(t)).map(|(n, _)| n.clone()).collect());
    if q.is_empty() && tagged.is_none() {
        s.files.clear_filter();
    } else {
        s.files.filter(move |n| n.path.to_lowercase().contains(&q) && tagged.as_ref().is_none_or(|set| set.contains(&n.path)));
    }
}

/// Reads the trash again, when it is showing. With no ship there is none to read.
fn load_trash(s: &mut App) {
    if s.trash.is_none() {
        return;
    }
    match s.conn.clone() {
        Some(c) => s.trash_req.request(c, |c| c.know_trash()),
        None => s.trash = Some(Some(Vec::new())),
    }
}

/// Brings a deleted memory back.
fn restore_memory(s: &mut App, name: String) {
    if let Some(c) = s.conn.clone() {
        s.op_req.request((c, name), |(c, name)| {
            c.know_restore(&format!("/{name}"))?;
            Ok(Op::Restored(name))
        });
    }
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
    fresh.tile_status_req = std::mem::take(&mut s.tile_status_req);
    fresh.kept_req = std::mem::take(&mut s.kept_req);
    fresh.templates_req = std::mem::take(&mut s.templates_req);
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
    if let Prompt::Tag(t) = &p {
        // the ship folds tags to lower case, so this does too and the list here matches
        let tag = t.text.trim().trim_start_matches('#').to_lowercase();
        if !tag.is_empty() {
            set_tag(s, tag, true);
        }
        return;
    }
    if let Prompt::Param(name, part, t) = &p {
        let (name, part, typed) = (name.clone(), *part, t.text.clone());
        set_param(s, &name, |old| match (old, part) {
            (scad::Lit::Str(_), _) => Ok(scad::Lit::Str(typed.clone())),
            (scad::Lit::Num(_), _) => typed.trim().parse().map(scad::Lit::Num).map_err(|_| "that is not a number".to_owned()),
            (scad::Lit::Vector(v), Some(i)) if i < v.len() => {
                let mut v = v.clone();
                v[i] = typed.trim().parse().map_err(|_| "that is not a number".to_owned())?;
                Ok(scad::Lit::Vector(v))
            }
            _ => Err("that parameter is not typed".to_owned()),
        });
        return;
    }
    if let Prompt::Feature(at, t) = &p {
        let [name, kind, note, time, source, radius] = [t[0].text.trim(), t[1].text.trim(), t[2].text.as_str(), t[3].text.trim(), t[4].text.trim(), t[5].text.trim()];
        if !time.is_empty() && !map::time_ok(time) {
            s.note = "that time is not a date lattice can read. Write it as 2026-11-17T09:30:00Z".into();
            s.prompt = Some(p);
            return;
        }
        let some = |v: &str| Some(v).filter(|v| !v.is_empty()).map(serde_json::Value::from);
        // a ring is so many metres, or there is none
        let radius = radius.parse::<f64>().ok().filter(|r| *r > 0.0).map(|r| serde_json::Value::from(r.min(2e7)));
        let at = *at;
        write_map(s, |body| map::set_props(body, at, &[("name", some(name)), ("kind", some(kind)), ("note", some(note)), ("time", some(time)), ("source", some(source)), ("radius", radius)]));
        return;
    }
    if let Prompt::Token(t) = &p {
        let token = t.text.trim().to_owned();
        if let Some(c) = s.conn.clone() {
            s.op_req.request((c, token), |(c, token)| {
                c.map_token(&token)?;
                Ok(Op::Tokened(if token.is_empty() { "the Mapbox token is cleared".into() } else { "the Mapbox token is set".into() }))
            });
        }
        return;
    }
    if let Prompt::Duplicate(from, t) = &p {
        let Some(rn) = api::real_name(&t.text) else {
            s.note = "that name has nothing a path can keep".into();
            s.prompt = Some(p);
            return;
        };
        if s.names.contains(&rn.name) {
            s.note = format!("there is a page named {} already", rn.name);
            s.prompt = Some(p);
            return;
        }
        let copy = Page { name: rn.name.clone(), body: from.body.clone(), kind: from.kind.clone(), rev: 0 };
        s.dnames.extend(rn.shown());
        match s.conn.clone() {
            Some(c) => s.op_req.request((c, copy), |(c, copy)| {
                // made by its first save, with the kind and the text of the page it copies
                c.save(&copy, 0)?;
                Ok(Op::Created(copy.name))
            }),
            None => {
                let name = copy.name.clone();
                applied(s, Op::Created(name.clone()));
                s.cache.insert(name.clone(), Page { rev: 1, ..copy });
                s.open = None;
                open_page(s, &name);
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
                Op::Renamed(a, b) if memory => c.know_move(&format!("/{a}"), &format!("/{b}"))?,
                Op::Created(_) => c.create_as(&rn)?,
                Op::Renamed(a, _) => c.rename_as(a, &rn)?,
                Op::Deleted(n) => c.delete(n)?,
                Op::Shared(n, mode) => c.share(n, mode)?,
                Op::Restored(..) | Op::Tagged(..) | Op::Granted(..) | Op::Ungranted(..) | Op::Grouped(..) | Op::SharedDir(..) | Op::Sensed(..) | Op::Commented(..) | Op::Asked(..) | Op::Templated(..) | Op::Uploaded(..) | Op::Said(..) | Op::Wrote(..) | Op::Tokened(..) | Op::MapIn(..) => {}
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
                // a memory's tags and date go with it
                if let Some(meta) = s.know_meta.remove(&old).filter(|_| s.memory) {
                    s.know_meta.insert(new.clone(), meta);
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
        Op::Uploaded(made, skipped) => {
            s.note = upload_note(made.len(), &skipped);
            s.resync = true;
            // what was made is shown when the tree has it: the one page, or the folder they share
            s.land = match made.as_slice() {
                [] => None,
                [one] => Some(one.clone()),
                many => Some(common_folder(many)).filter(|f| !f.is_empty()),
            };
        }
        Op::Said(say) => {
            s.note = say;
            return;
        }
        Op::MapIn(feats, say) => {
            // the page may have moved on while the file was read: it is added to what is there now
            let n = feats.len();
            if n > 0 && write_map(s, |body| map::append(body, feats)) {
                // the view goes to what came in
                if let Some(m) = s.map.as_mut().filter(|m| m.feats.len() >= n) {
                    m.cam = map::Camera::fit(&m.feats[m.feats.len() - n..], m.size.0, m.size.1);
                }
                s.note = say;
            } else if n == 0 {
                s.note = say;
            }
            sync_tiles(s);
            return;
        }
        Op::Restored(name) => {
            s.note = format!("restored {name}");
            // both lists are read again: the memory is back in one and out of the other
            load_know(s);
            load_trash(s);
            load_history(s);
            return;
        }
        Op::Tagged(name, tag, on) => {
            // this client made the change: the list in hand is patched, as the web client patches its own
            let meta = s.know_meta.entry(name).or_default();
            meta.0.retain(|x| *x != tag);
            if on {
                meta.0.push(tag.clone());
            }
            s.note = if on { format!("tagged #{tag}") } else { format!("took off #{tag}") };
            // a tag nothing has any more is not one to filter by
            if s.know_tag.as_ref().is_some_and(|f| !s.know_meta.values().any(|m| m.0.contains(f))) {
                s.know_tag = None;
            }
            refilter(s);
            return;
        }
        Op::Tokened(say) => {
            s.note = say;
            // the ship is asked again what it can give, and tiles that failed may be tried again
            (s.tile_status, s.tiles_off) = (None, None);
            s.pics_asked.retain(|k| !k.starts_with("tile:"));
            sync_tiles(s);
            return;
        }
        Op::Wrote(name, page, say) => {
            s.note = say;
            // sample pages: kept here. A ship's: shown when the tree has it
            if let Some(p) = page {
                if !s.names.contains(&name) {
                    s.names.push(name.clone());
                }
                s.cache.insert(name.clone(), p);
            }
            s.land = Some(name);
            s.resync = true;
        }
        Op::Templated(name) => {
            s.tmpl = None;
            s.note = format!("made {name} from a template");
            // shown when the tree that has it arrives
            s.land = Some(name);
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
            // a deleted memory goes to the trash: the list of it, when showing, is read again
            if s.memory {
                load_trash(s);
            }
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
        // sample pages have no tree to wait for: what was just made is shown now
        if let Some(name) = s.land.take() {
            land_on(s, &name);
        }
    }
}

fn setup(s: &mut App, waker: Waker) {
    s.image_cache = Some(std::rc::Rc::new(rune::ImageCache::new(waker.clone())));
    s.waker = Some(waker.clone());
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
    s.tile_status_req.set_waker(waker.clone());
    s.kept_req.set_waker(waker.clone());
    s.templates_req.set_waker(waker.clone());
    s.back_req.set_waker(waker.clone());
    s.trash_req.set_waker(waker.clone());
    s.tex_req.set_waker(waker.clone());
    s.scad_req.set_waker(waker.clone());
    s.part_req.set_waker(waker.clone());
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
    keep_tabs(s);
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
        // a link to a page not written yet starts it, named, ready to type in
        Some(name) if api::valid_name(&name) => {
            start_named(s, name);
            tx.focus_when_shown(FIELD, false);
        }
        Some(name) => s.note = format!("{name} is not a name a page can have"),
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
    // a layer's own layers are not followed, so there is no cycle
    let under: Vec<_> = map::layers(&p.body).into_iter().map(|n| (n.clone(), s.cache.get(&n).filter(|l| l.kind == "geojson").and_then(|l| map::parse(&l.body)))).collect();
    s.map = map::parse(&p.body).map(|feats| {
        let cam = old.as_ref().map_or(map::Camera { at: [0.5, 0.5], scale: 800.0 }, |m| m.cam);
        let pick_new = old.as_ref().is_some_and(|m| m.pick_new);
        MapView { name: p.name.clone(), rev: p.rev, cam, grab: cam, tool: old.as_ref().and_then(|m| m.tool), verts: old.as_ref().map_or(Vec::new(), |m| m.verts.clone()), moving: None, grip: None, pick_new: false, style: map::base_style(&p.body), size: old.as_ref().map_or((800.0, 500.0), |m| m.size), fitted: old.as_ref().is_some_and(|m| m.fitted), picked: if pick_new { feats.len().checked_sub(1) } else { old.as_ref().and_then(|m| m.picked).filter(|i| *i < feats.len()) }, feats, hidden: old.map(|m| m.hidden).unwrap_or_default(), under }
    });
}

/// Keeps `s.read_as` in step with the open page: an HTML or a gemtext
/// page is read as a document, turned to Markdown once and not on every frame.
fn sync_read(s: &mut App) {
    // away from a LaTeX page and back, it is read again: what was read went with the page
    if !s.open.as_ref().is_some_and(|p| p.kind == "tex") {
        s.tex_for = None;
    }
    let Some(p) = s.open.as_ref().filter(|p| matches!(p.kind.as_str(), "html" | "gmi" | "tex")) else {
        s.read_as = None;
        return;
    };
    if p.kind == "tex" {
        // pandoc reads it on a thread of its own, once for each revision. Until it answers, and when
        // it cannot, the page shows as its source
        let now = (p.name.clone(), p.rev);
        if s.tex_for.as_ref() != Some(&now) {
            s.tex_for = Some(now.clone());
            s.tex_why = None;
            s.read_as = None;
            s.tex_req.request((now, p.body.clone()), |((name, rev), src)| (name, rev, tex::read(&src)));
        }
        return;
    }
    if !s.read_as.as_ref().is_some_and(|(n, rev, _)| *n == p.name && *rev == p.rev) {
        s.read_as = Some((p.name.clone(), p.rev, if p.kind == "gmi" { html::gemtext(&p.body) } else { html::to_markdown(&p.body) }));
    }
}

/// The page as the reader draws it: its own text when it is Markdown,
/// or what it was turned to. Nothing for a kind with a view of its own.
fn read_md<'a>(s: &'a App, p: &'a Page) -> Option<&'a str> {
    if p.kind == "md" {
        return Some(&p.body);
    }
    s.read_as.as_ref().filter(|(n, rev, _)| *n == p.name && *rev == p.rev).map(|(_, _, t)| t.as_str())
}

/// Saves the part in front as a file named in the save dialog: the STL
/// it was drawn from, a 3MF that openscad makes then, or a PNG of the
/// view as it is turned, at twice its size on the page.
fn export_part(s: &mut App, tx: &mut Tx, ext: &'static str) {
    let Some(p) = s.open.clone().filter(|p| p.kind == "scad") else { return };
    let leaf = p.name.rsplit('/').next().unwrap_or("part").to_owned();
    let options = rune::FileDialogOptions { title: format!("Download as {}", ext.to_uppercase()), file_name: Some(format!("{leaf}.{ext}")), ..Default::default() };
    tx.save_file(options, move |s: &mut App, result: rune::FileDialogResult, _: &mut Tx| {
        let path = match result {
            Ok(Some(path)) => path,
            Ok(None) => return,
            Err(e) => {
                s.note = format!("no file dialog could open: {e}");
                return;
            }
        };
        let now = |x: &(String, u64, scadrun::Drawn)| x.0 == p.name && x.1 == p.rev;
        match ext {
            "stl" => match s.scad.as_ref().filter(|x| now(x)).and_then(|x| x.2.stl.clone()) {
                Some(stl) => write_file(s, path, stl),
                None => s.note = "there is no part to save yet".into(),
            },
            "png" => {
                let Some(v) = s.part.as_ref().filter(|v| v.name == p.name) else {
                    s.note = "there is no part to save yet".into();
                    return;
                };
                let (w, h) = ((PART_SIZE.0 * 2.0) as u32, (PART_SIZE.1 * 2.0) as u32);
                s.op_req.request((path, v.mesh.clone(), v.cam), move |(path, mesh, cam)| {
                    let shot = scadrun::png(w, h, &view3d::render(&mesh, &cam, w as usize, h as usize)).ok_or("the picture could not be made")?;
                    Ok(Op::Said(match std::fs::write(&path, shot) {
                        Ok(()) => format!("saved to {}", path.display()),
                        Err(e) => format!("not saved to {}: {e}", path.display()),
                    }))
                });
            }
            _ => {
                // openscad runs again for this, with the pages it includes read as they were for the drawing
                s.note = format!("making the {}", ext.to_uppercase());
                let conn = s.conn.clone();
                let local: HashMap<String, String> = if conn.is_some() { HashMap::new() } else { s.cache.values().filter(|x| x.kind == "scad").map(|x| (x.name.clone(), x.body.clone())).collect() };
                s.op_req.request((path, p.clone(), conn, local), move |(path, p, conn, local)| {
                    let read = |page: &str| match &conn {
                        Some(c) => c.page(page).ok().filter(|p| p.kind == "scad").map(|p| p.body),
                        None => local.get(page).cloned(),
                    };
                    Ok(Op::Said(match scadrun::export(&p.name, &p.body, read, ext) {
                        Err(why) => why,
                        Ok(file) => match std::fs::write(&path, file) {
                            Ok(()) => format!("saved to {}", path.display()),
                            Err(e) => format!("not saved to {}: {e}", path.display()),
                        },
                    }))
                });
            }
        }
    });
}

/// Asks for the part's picture from where the camera now is. It is
/// drawn on a thread of its own, and only the newest asked for is kept.
fn draw_part(s: &mut App) {
    let Some(v) = &s.part else { return };
    let (w, h) = ((PART_SIZE.0 * 2.0) as u32, (PART_SIZE.1 * 2.0) as u32);
    s.part_req.request((v.name.clone(), v.mesh.clone(), v.cam), move |(name, mesh, cam)| {
        let px = view3d::render(&mesh, &cam, w as usize, h as usize);
        (name, w, h, px)
    });
}

/// Whether the open OpenSCAD page is drawn without being asked: one of
/// this ship's own. A page of another ship runs a program on this
/// machine over text someone else wrote, so it waits for a yes.
fn scad_draws(s: &App, p: &Page) -> bool {
    p.kind == "scad" && !s.memory && (s.remote.is_none() || s.scad_ok.as_deref() == Some(p.name.as_str()))
}

/// Keeps the drawn part in step with the open page: openscad runs on a
/// thread of its own, once for each revision. The pages it includes
/// are read from the ship there, or from the sample pages.
fn sync_scad(s: &mut App) {
    let Some(p) = s.open.as_ref().filter(|p| scad_draws(s, p)) else {
        if !s.open.as_ref().is_some_and(|p| p.kind == "scad") {
            (s.scad_for, s.scad, s.part) = (None, None, None);
        }
        return;
    };
    let now = (p.name.clone(), p.rev);
    if s.scad_for.as_ref() == Some(&now) {
        return;
    }
    s.scad_for = Some(now.clone());
    // with no ship the pages in hand are all there are: the OpenSCAD ones go with the request
    let conn = s.conn.clone();
    let local: HashMap<String, String> = if conn.is_some() { HashMap::new() } else { s.cache.values().filter(|x| x.kind == "scad").map(|x| (x.name.clone(), x.body.clone())).collect() };
    s.scad_req.request((now, p.body.clone(), conn, local), |((name, rev), text, conn, local)| {
        let read = |page: &str| match &conn {
            Some(c) => c.page(page).ok().filter(|p| p.kind == "scad").map(|p| p.body),
            None => local.get(page).cloned(),
        };
        let drawn = scadrun::draw(&name, &text, read);
        (name, rev, drawn)
    });
}

/// Keeps `s.beside` in step with the page held beside: a sheet as its
/// grid, a map as its shapes, an HTML or gemtext page as it is read.
fn sync_beside(s: &mut App) {
    let Some(p) = s.split.as_ref().and_then(|n| s.cache.get(n)) else {
        s.beside = None;
        return;
    };
    if s.beside.as_ref().is_some_and(|(n, rev, _)| *n == p.name && *rev == p.rev) {
        return;
    }
    // the sheet that was showing stays the one showing through a change
    let old = s.beside.take().filter(|(n, ..)| *n == p.name);
    let view = match p.kind.as_str() {
        "fods" => Some(sheet::parse(&p.body)).filter(|sheets| !sheets.is_empty()).map(|sheets| {
            let (at, table) = match old {
                Some((_, _, Beside::Sheet(_, at, table))) => (at.min(sheets.len() - 1), table),
                _ => (0, TableState::new()),
            };
            Beside::Sheet(sheets, at, table)
        }),
        "geojson" => map::parse(&p.body).map(Beside::Map),
        "html" => Some(Beside::Read(html::to_markdown(&p.body))),
        "gmi" => Some(Beside::Read(html::gemtext(&p.body))),
        _ => None,
    };
    s.beside = view.map(|v| (p.name.clone(), p.rev, v));
}

/// Keeps `s.sheet` in step with the open page, as +sync_map does for a map.
fn sync_sheet(s: &mut App) {
    sync_read(s);
    sync_scad(s);
    sync_beside(s);
    let Some(p) = s.open.as_ref().filter(|p| p.kind == "fods") else {
        s.sheet = None;
        return;
    };
    if s.sheet.as_ref().is_some_and(|v| v.name == p.name && v.rev == p.rev) {
        return;
    }
    let sheets = sheet::parse(&p.body);
    let old = s.sheet.take().filter(|v| v.name == p.name);
    if sheets.is_empty() {
        s.sheet = None;
        return;
    }
    // a sheet just added is the one shown, with no cell of the old one picked
    let want = old.as_ref().and_then(|v| v.want);
    let repick = old.as_ref().is_some_and(|v| v.repick);
    let (at, cursor) = (want.or(old.as_ref().map(|v| v.at)).unwrap_or(0).min(sheets.len() - 1), if want.is_some() { None } else { old.as_ref().and_then(|v| v.cursor) });
    let (entry_was, stale) = (old.as_ref().map_or(String::new(), |v| v.entry_was.clone()), old.as_ref().map_or_else(Default::default, |v| v.stale.clone()));
    // where the grid was scrolled to and how wide its columns were dragged stay through a change
    let (table, entry) = old.map_or_else(|| (TableState::new(), TextEdit::new("")), |v| if want.is_some() { (TableState::new(), TextEdit::new("")) } else { (v.table, v.entry) });
    let looks = sheet::book(&p.body).ok().map(|b| {
        let styles = styles::Styles::read(&p.body, b.null_date);
        (b, styles)
    });
    s.sheet = Some(SheetView { name: p.name.clone(), rev: p.rev, at, sheets, looks, want: None, repick: false, cursor, entry_was, stale, table, entry });
    if let (true, Some((r, c))) = (repick, cursor) {
        pick_cell(s, r, c);
    }
}

/// The widest a sheet's grid is drawn. More columns are in the page, not on screen.
const SHEET_COLS: usize = 52;
/// The empty rows shown under a sheet's last, to type into.
const SHEET_SPARE: usize = 20;

/// Whether the page in front may be changed where it is read: one of
/// the owner's own, not open in the editor, with no save on its way.
fn page_changes(s: &App) -> bool {
    usable(s, "delete") && !s.editing && !s.save_req.is_pending()
}

/// Picks a cell of the sheet showing, with its text ready to be typed over.
fn pick_cell(s: &mut App, r: usize, c: usize) {
    let Some(v) = &mut s.sheet else { return };
    v.cursor = Some((r, c));
    // a cell with a formula shows the formula, as it is typed, and not what it came to
    let formula = s.open.as_ref().and_then(|p| sheet::formula_at(&p.body, v.at, r, c)).map(|f| formula::to_user(&f));
    v.entry_was = formula.unwrap_or_else(|| v.sheets[v.at].rows.get(r).and_then(|row| row.get(c)).cloned().unwrap_or_default());
    v.entry = TextEdit::new(v.entry_was.as_str());
    v.entry.focused = true;
}

/// Puts what was typed into the picked cell and saves the page, then
/// picks the cell below, as a spreadsheet does.
fn commit_cell(s: &mut App) {
    let (Some(p), Some(v)) = (s.open.clone(), &s.sheet) else { return };
    let Some((r, c)) = v.cursor else { return };
    if !page_changes(s) || v.name != p.name {
        s.note = "this spreadsheet is not changed here".into();
        return;
    }
    // left as it was: nothing is written, and a formula is not typed over itself
    if v.entry.text == v.entry_was {
        pick_cell(s, r + 1, c);
        return;
    }
    // the value or the formula goes in, and every formula that reads the cell is worked out again
    match calc::enter(&p.body, v.at, r, c, &v.entry.text) {
        Err(why) => s.note = format!("not changed: {why}"),
        Ok(got) => {
            if let Some(v) = &mut s.sheet {
                v.stale.retain(|k| !got.done.contains(k));
                v.stale.extend(got.stale);
            }
            if got.body != p.body {
                save_body(s, p, got.body);
            }
            pick_cell(s, r + 1, c);
        }
    }
}

/// Changes how the picked cell looks, or how its number is written, and saves the page.
fn format_picked(s: &mut App, change: calc::Fmt) {
    let (Some(p), Some(v)) = (s.open.clone(), &s.sheet) else { return };
    let Some((r, c)) = v.cursor else { return };
    if !page_changes(s) || v.name != p.name {
        s.note = "this spreadsheet is not changed here".into();
        return;
    }
    match calc::format_cell(&p.body, v.at, r, c, &change) {
        Err(why) => s.note = format!("not changed: {why}"),
        Ok(body) if body == p.body => {}
        Ok(body) => save_body(s, p, body),
    }
}

/// Puts `n` rows in at the picked cell's row and `off` below it, or
/// takes `-n` out from there, and saves the page. Columns the same,
/// counted from the picked cell's column.
fn shift_picked(s: &mut App, rows: bool, off: usize, n: i64) {
    let (Some(p), Some(v)) = (s.open.clone(), &mut s.sheet) else { return };
    let Some((r, c)) = v.cursor else { return };
    if v.name != p.name {
        return;
    }
    match calc::shift(&p.body, v.at, rows, if rows { r } else { c } + off, n) {
        Err(why) => s.note = format!("not changed: {why}"),
        Ok(got) => {
            // the formulas moved with the rows, so what could not be worked out is counted afresh
            v.stale = got.stale.into_iter().collect();
            v.repick = true;
            if got.body != p.body {
                save_body(s, p, got.body);
            }
        }
    }
}

/// What drawing the open OpenSCAD page came to: a line that says so,
/// and the console under it when openscad said anything.
fn scad_view(s: &App, p: &Page, k: &Kit) -> El {
    let c = &k.c;
    let mut out = col().key("scad-part").w_full().gap(6.0);
    if !scad_draws(s, p) {
        let name = p.name.clone();
        return out.child(
            row().gap(10.0).center_y().child(text("This page is another ship's. Drawing it runs OpenSCAD on this machine over its text.").font(k.ty.small).color(c.text_muted).wrap().grow(1.0).min_w(0.0)).child(
                Button::new("Draw it")
                    .control_size(ControlSize::Small)
                    .on_press(move |s: &mut App| {
                        s.scad_ok = Some(name.clone());
                        sync_scad(s);
                    })
                    .build(k)
                    .key("scad-draw"),
            ),
        );
    }
    let Some((_, _, d)) = s.scad.as_ref().filter(|(n, rev, _)| *n == p.name && *rev == p.rev) else {
        return out.child(text("rendering\u{2026}").key("scad-status").font(k.ty.small).color(c.text_muted));
    };
    out = out.child(text(d.status.clone()).key("scad-status").font(k.ty.small).color(if d.bad { c.danger.icon } else { c.text_muted }).wrap());
    // the part in 3D: drag to turn it, or to slide it with Pan on, and the wheel steps nearer and further
    if let Some(v) = s.part.as_ref().filter(|v| v.name == p.name) {
        let ready = |i: &&rune::Image| i.is_ready() && i.error().is_none();
        let mut view = el()
            .key("scad-3d")
            .size(PART_SIZE.0, PART_SIZE.1)
            .radius(k.radius.md)
            .fill(c.layer_01)
            .label("The part in 3D. Drag to turn it")
            .on_drag(|s: &mut App, d, _| {
                let Some(v) = &mut s.part else { return };
                if d.phase == Phase::Down {
                    v.grab = v.cam;
                    return;
                }
                v.cam = v.grab;
                if v.pan { v.cam.pan(d.dx, d.dy) } else { v.cam.orbit(d.dx, d.dy) }
                draw_part(s);
            })
            .on_wheel(|s: &mut App, e: WheelEvent, _| {
                if let Some(v) = &mut s.part {
                    // wheel up steps nearer: a real wheel on Linux reports up as a positive dy
                    v.cam.zoom(-e.dy);
                }
                draw_part(s);
                true
            });
        if let Some(pic) = v.pic.as_ref().filter(ready).or(v.was.as_ref().filter(ready)) {
            view = view.child(el().key("scad-3d-pic").absolute(0.0, 0.0).size(PART_SIZE.0, PART_SIZE.1).pixels(pic.pixels()).a11y_hidden());
        }
        let pan = v.pan;
        out = out.child(view).child(
            row()
                .key("scad-3d-tools")
                .gap(4.0)
                .center_y()
                .child(Button::new("Fit").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("See the whole part").on_press(|s: &mut App| {
                    if let Some(v) = &mut s.part {
                        let mesh = v.mesh.clone();
                        v.cam.fit(&mesh);
                    }
                    draw_part(s);
                }).build(k).key("scad-fit"))
                .child(Button::new("Pan").control_size(ControlSize::Small).variant(if pan { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).help("A drag slides the view, where it would turn it").on_press(|s: &mut App| {
                    if let Some(v) = &mut s.part {
                        v.pan = !v.pan;
                    }
                }).build(k).key("scad-pan"))
                .child(Divider::vertical().build(k))
                .child(Button::new("STL").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Download the part as STL").on_press_tx(|s: &mut App, tx: &mut Tx| export_part(s, tx, "stl")).build(k).key("scad-stl"))
                .child(Button::new("3MF").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Download the part as 3MF").on_press_tx(|s: &mut App, tx: &mut Tx| export_part(s, tx, "3mf")).build(k).key("scad-3mf"))
                .child(Button::new("PNG").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Download a PNG of this view").on_press_tx(|s: &mut App, tx: &mut Tx| export_part(s, tx, "png")).build(k).key("scad-png")),
        );
    }
    if !d.lines.is_empty() {
        let mut con = col().key("scad-console").w_full().gap(1.0).padding(8.0).radius(k.radius.md).fill(c.layer_01).child(text(d.head.clone()).font(k.ty.small_medium).color(c.text_muted));
        // a model that echoes without end is not drawn to its last line
        for (level, line) in d.lines.iter().take(200) {
            let ink = match level {
                scadrun::Level::Error => c.danger.icon,
                scadrun::Level::Warning => c.warning.icon,
                scadrun::Level::Plain => c.text_base,
            };
            con = con.child(text(line.clone()).font(k.ty.mono).color(ink).wrap().selectable(true));
        }
        if d.lines.len() > 200 {
            con = con.child(text(format!("and {} more lines", d.lines.len() - 200)).font(k.ty.small).color(c.text_faint));
        }
        out = out.child(con);
    }
    out
}

/// Gives an OpenSCAD parameter of the open page a new value, worked
/// out from the one it has, and saves the page: its line is rewritten
/// and nothing else. A number is kept inside its range.
fn set_param(s: &mut App, name: &str, change: impl Fn(&scad::Lit) -> Result<scad::Lit, String>) {
    let Some(p) = s.open.clone().filter(|p| p.kind == "scad") else { return };
    if !page_changes(s) {
        s.note = "this page is not changed here".into();
        return;
    }
    let Some(param) = scad::parse_params(&p.body).into_iter().find(|x| x.name == name) else { return };
    let clamp = |n: f64| n.clamp(param.min.unwrap_or(f64::MIN), param.max.unwrap_or(f64::MAX).max(param.min.unwrap_or(f64::MIN)));
    let value = match change(&param.value) {
        Ok(scad::Lit::Num(n)) => scad::Lit::Num(clamp(n)),
        Ok(scad::Lit::Vector(v)) => scad::Lit::Vector(v.into_iter().map(clamp).collect()),
        // a string is no longer than its comment lets it be
        Ok(scad::Lit::Str(t)) => scad::Lit::Str(t.chars().take(param.max_length.map_or(usize::MAX, |m| m.max(0.0) as usize)).collect()),
        Ok(v) => v,
        Err(why) => {
            s.note = format!("not changed: {why}");
            return;
        }
    };
    match scad::set_param(&p.body, &param, &value) {
        None => s.note = "not changed: that line is not as it was read".into(),
        Some(body) if body == p.body => {}
        Some(body) => save_body(s, p, body),
    }
}

/// The parameters an OpenSCAD page's source declares, each with a
/// control for its kind, in their groups. A change is written into the
/// parameter's own line and saved.
fn params_view(params: &[scad::Param], k: &Kit) -> El {
    let c = &k.c;
    let small = |label: String, help: &str| Button::new(label).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help(help.to_owned());
    // a number: one step down, the value (press it to type one), one step up
    let stepper = |p: &scad::Param, part: Option<usize>, n: f64, key: String| {
        let step = p.step.filter(|s| *s > 0.0).unwrap_or(1.0);
        let nudge = move |by: f64| {
            move |old: &scad::Lit| match (old, part) {
                (scad::Lit::Num(n), _) => Ok(scad::Lit::Num(n + by)),
                (scad::Lit::Vector(v), Some(i)) if i < v.len() => {
                    let mut v = v.clone();
                    v[i] += by;
                    Ok(scad::Lit::Vector(v))
                }
                _ => Err("that parameter is not a number".to_owned()),
            }
        };
        let (down, up, typed) = (p.name.clone(), p.name.clone(), p.name.clone());
        let shown = scad::fmt_value(&scad::Lit::Num(n), p.step);
        let start = shown.clone();
        row()
            .gap(2.0)
            .center_y()
            .child(small("\u{2212}".into(), "One step down").on_press(move |s: &mut App| set_param(s, &down, nudge(-step))).build(k).key(format!("{key}-down")))
            .child(small(shown, "Type a value").on_press(move |s: &mut App| {
                let mut t = TextEdit::new(start.as_str());
                t.focused = true;
                s.prompt = Some(Prompt::Param(typed.clone(), part, t));
            }).build(k).key(format!("{key}-value")))
            .child(small("+".into(), "One step up").on_press(move |s: &mut App| set_param(s, &up, nudge(step))).build(k).key(format!("{key}-up")))
    };
    let mut out = col().key("scad-params").w_full().gap(6.0).padding(10.0).radius(k.radius.md).fill(c.layer_01);
    let mut group = "";
    for p in params {
        if p.group != group {
            group = &p.group;
            out = out.child(text(group.to_owned()).font(k.ty.small_medium).color(c.text_muted));
        }
        let key = format!("param-{}", p.name);
        let control = if !p.options.is_empty() {
            // a list: a button a choice, the one in the source marked
            let mut choices = row().gap(2.0).center_y().flex_wrap();
            for (i, (v, label)) in p.options.iter().enumerate() {
                let (name, v, on) = (p.name.clone(), v.clone(), *v == p.value);
                choices = choices.child(Button::new(label.clone()).control_size(ControlSize::Small).variant(if on { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| set_param(s, &name, |_| Ok(v.clone()))).build(k).key(format!("{key}-{i}")));
            }
            choices
        } else {
            match &p.value {
                scad::Lit::Bool(on) => {
                    let (name, on) = (p.name.clone(), *on);
                    row().child(Switch::new(on).on_toggle(move |s: &mut App| set_param(s, &name, |_| Ok(scad::Lit::Bool(!on)))).build(k).key(format!("{key}-switch")))
                }
                scad::Lit::Num(n) => stepper(p, None, *n, key.clone()),
                scad::Lit::Vector(v) => {
                    let mut parts = row().gap(8.0).center_y();
                    for (i, n) in v.iter().enumerate() {
                        parts = parts.child(stepper(p, Some(i), *n, format!("{key}-{i}")));
                    }
                    parts
                }
                scad::Lit::Str(t) => {
                    let (name, start) = (p.name.clone(), t.clone());
                    row().child(small(if t.is_empty() { "(empty)".into() } else { t.clone() }, "Type a value").on_press(move |s: &mut App| {
                        let mut e = TextEdit::new(start.as_str());
                        e.focused = true;
                        s.prompt = Some(Prompt::Param(name.clone(), None, e));
                    }).build(k).key(format!("{key}-value")))
                }
            }
        };
        let range = match (p.min, p.max) {
            (Some(lo), Some(hi)) => format!("{} to {}", scad::js_num(lo), scad::js_num(hi)),
            _ => String::new(),
        };
        let mut label = col().w(180.0).child(text(p.name.clone()).font(k.ty.ui).color(c.text_base).truncate());
        let said = [p.description.as_str(), range.as_str()].iter().filter(|x| !x.is_empty()).copied().collect::<Vec<_>>().join(" \u{b7} ");
        if !said.is_empty() {
            label = label.child(text(said).font(k.ty.small).color(c.text_faint).wrap());
        }
        out = out.child(row().key(key).w_full().gap(10.0).center_y().child(label).child(control));
    }
    out
}

/// Adds a sheet after the last, named as the web client names one, and shows it.
fn add_sheet(s: &mut App) {
    let (Some(p), Some(v)) = (s.open.clone(), &mut s.sheet) else { return };
    if v.name != p.name {
        return;
    }
    match sheet::add_sheet(&p.body, "") {
        Err(why) => s.note = format!("not changed: {why}"),
        Ok((body, at)) => {
            v.want = Some(at);
            save_body(s, p, body);
        }
    }
}

/// Saves the open page with a new text, made by a change where it is read.
fn save_body(s: &mut App, p: Page, body: String) {
    let base = p.rev;
    let page = Page { body, ..p };
    match s.conn.clone() {
        Some(c) => s.save_req.request((c, page), move |(c, mut p)| {
            p.rev = c.save(&p, base)?;
            Ok(p)
        }),
        None => landed(s, Page { rev: base + 1, ..page }),
    }
}

fn sheet_view(v: &SheetView, s: &App, k: &Kit) -> El {
    let c = &k.c;
    let sh = &v.sheets[v.at];
    let may = page_changes(s);
    // a sheet that can be changed has room to grow: empty rows under it and columns beside it
    let cols = if may { (sh.width() + 2).clamp(8, SHEET_COLS) } else { sh.width().clamp(1, SHEET_COLS) };
    let mut table = Table::new(
        |s: &App| &s.sheet.as_ref().expect("a sheet is showing").table,
        |s: &mut App| &mut s.sheet.as_mut().expect("a sheet is showing").table,
        |s: &App| s.sheet.as_ref().map_or(0, |v| v.sheets[v.at].rows.len() + if page_changes(s) { SHEET_SPARE } else { 0 }),
        |_: &App, i| std::borrow::Cow::Owned(i.to_string()),
    )
    .name("Sheet")
    .column(TableColumn::new("#", "").width(48.0).resizable(false));
    // a column is as wide as its style says, when it says
    let wide = |i: usize| {
        let (book, styles) = v.looks.as_ref()?;
        let mut seen = 0;
        let run = book.sheets.get(v.at)?.col_styles.iter().find(|(rep, _)| {
            seen += rep;
            i < seen
        })?;
        styles.col_width(run.1.as_deref()?)
    };
    for i in 0..cols {
        table = table.column(TableColumn::new(sheet::column_name(i), sheet::column_name(i)).width(wide(i).unwrap_or(120.0).clamp(48.0, 600.0)).min(48.0).max(600.0));
    }
    // found once a frame, not once a cell
    let hits: std::collections::HashSet<(usize, usize)> = sheet_matches(s).into_iter().collect();
    let (accent, ink, held, font, warn, ground) = (c.text_accent, c.text_base, c.layer_02, k.ty.ui, c.danger.icon, c.bg_base);
    let grid = table
        .cell(move |s: &App, i, col| {
            let Some(v) = &s.sheet else { return Cell::text("") };
            if col == "#" {
                return Cell::text((i + 1).to_string()).muted().mono();
            }
            // a column's letters back to its place
            let at = col.bytes().fold(0usize, |n, b| n * 26 + (b - b'A') as usize + 1) - 1;
            let said = v.sheets[v.at].rows.get(i).and_then(|r| r.get(at)).map_or("", String::as_str);
            // how its style has it look, and where its kind of value sits: a number to the right, a truth or an error in the middle
            let (look, kind) = match &v.looks {
                Some((book, styles)) => {
                    let cell = book.at(v.at, i, at);
                    let kind = cell.map_or(' ', |c| if c.err || c.vt == "boolean" { 'c' } else if c.vt.is_empty() || c.vt == "string" { ' ' } else { 'r' });
                    (styles.look(&book.style_at(v.at, i, at)), kind)
                }
                None => (styles::Look::default(), ' '),
            };
            // a cell find matches is in the accent colour, and the current one's row is the selected one
            // a formula not worked out since what it reads changed is marked: it shows what it showed before
            // the page's colours are for a white sheet. One that would not show on what is under it gives way:
            // text with no background of its own is the theme's when its colour is too near the theme's ground,
            // and text on a background of the page's is dark or light, whichever shows on it
            let light = |c: rune::Color| 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
            let (paper, pen) = (look.bg.as_deref().and_then(rune::color::hex), look.color.as_deref().and_then(rune::color::hex));
            let under = paper.unwrap_or(ground);
            let own = match pen {
                Some(p) if (light(p) - light(under)).abs() >= 0.12 => p,
                _ if paper.is_some() => if light(under) > 0.3 { rune::Color::BLACK } else { rune::Color::WHITE },
                _ => ink,
            };
            let color = if hits.contains(&(i, at)) { accent } else if v.stale.contains(&(v.at, i, at)) { warn } else { own };
            let face = rune::TextStyle { weight: if look.bold { 700.0 } else { font.weight }, italic: look.italic, ..font };
            let mut words = text(said.to_owned()).font(face).color(color).truncate().grow(1.0).min_w(0.0).inert().align(match look.align.unwrap_or(kind) {
                'r' => rune::Align::End,
                'c' => rune::Align::Center,
                _ => rune::Align::Start,
            });
            if look.underline {
                words = words.spans(vec![Span::new(0, said.len()).underline(color)]);
            }
            if look.strike {
                words = words.strike(0, said.len(), None);
            }
            let on = v.cursor == Some((i, at));
            let mut cell = row().key(format!("cell-{i}-{at}")).w_full().h_full().center_y().label(format!("{}{}", sheet::column_name(at), i + 1)).child(words);
            if let Some(bg) = look.bg.as_deref().and_then(rune::color::hex) {
                cell = cell.fill(bg);
            }
            // a press picks the cell, to type into it in the bar above
            if may {
                cell = cell.on_press(move |s: &mut App| pick_cell(s, i, at));
            }
            if on && may {
                cell = cell.fill(held).radius(3.0);
            }
            Cell::el(cell)
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
    if may {
        tabs = tabs.child(Button::new("+").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(add_sheet).build(k).key("sheet-add"));
    }
    let more = if sh.width() > SHEET_COLS { format!(", the first {SHEET_COLS} of {} columns", sh.width()) } else { String::new() };
    tabs = tabs.child(text(format!("{} rows{more}", sh.rows.len())).font(k.ty.small).color(c.text_muted).pl(8.0));
    if !v.stale.is_empty() {
        // said for as long as it holds: these show what they showed before the change
        let n = v.stale.len();
        tabs = tabs.child(text(format!("{n} formula{} not worked out here: {} the value {} had", if n == 1 { "" } else { "s" }, if n == 1 { "it keeps" } else { "they keep" }, if n == 1 { "it" } else { "they" })).key("sheet-stale").font(k.ty.small).color(c.danger.icon).pl(8.0));
    }
    let mut page = col().key("sheet").w_full().h_full().min_h(0.0).padding(12.0).gap(8.0);
    if may {
        let name = v.cursor.map_or("".to_owned(), |(r, col)| format!("{}{}", sheet::column_name(col), r + 1));
        let entry = TextInput::new(&v.entry)
            .placeholder(if v.cursor.is_some() { "Type text, a number, true or false, or a formula starting with =. Enter saves it" } else { "Press a cell to change it" })
            .on_edit(|s: &mut App| &mut s.sheet.as_mut().expect("a sheet is showing").entry)
            .on_submit(|s: &mut App, _| commit_cell(s))
            .build(k)
            .grow(1.0)
            .key("cell-entry");
        page = page.child(row().key("cell-bar").w_full().gap(8.0).center_y().child(text(name).key("cell-name").font(k.ty.ui_medium).color(c.text_muted).w(48.0)).child(entry));
        // how the picked cell looks and how its number is written: each press is a change, saved at once
        if let (Some((r, col)), Some((book, styles))) = (v.cursor, &v.looks) {
            let style = book.style_at(v.at, r, col);
            let look = styles.look(&style);
            let kind = styles.kind(&style);
            let plain = !styles.formatted(&style);
            let b = |key: &str, label: &str, on: bool, help: &str, change: calc::Fmt| {
                Button::new(label).control_size(ControlSize::Small).variant(if on { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).help(help).on_press(move |s: &mut App| format_picked(s, change.clone())).build(k).key(key.to_owned())
            };
            let shift = |key: &str, label: &str, help: &str, rows: bool, off: usize, n: i64| {
                Button::new(label).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help(help).on_press(move |s: &mut App| shift_picked(s, rows, off, n)).build(k).key(key.to_owned())
            };
            let align = |a: char| calc::Fmt::Align(Some(a).filter(|a| look.align != Some(*a)));
            let number = |n: &'static str, on: bool| calc::Fmt::Number(if on { "general" } else { n });
            page = page.child(
                row().key("cell-tools").w_full().gap(4.0).center_y().pl(56.0)
                    .child(b("fmt-bold", "B", look.bold, "Bold", calc::Fmt::Bold(!look.bold)))
                    .child(b("fmt-italic", "I", look.italic, "Italic", calc::Fmt::Italic(!look.italic)))
                    .child(b("fmt-underline", "U", look.underline, "Underline", calc::Fmt::Underline(!look.underline)))
                    .child(Divider::vertical().build(k))
                    .child(b("fmt-left", "Left", look.align == Some('l'), "Keep it to the left. Press again to let the value say", align('l')))
                    .child(b("fmt-centre", "Centre", look.align == Some('c'), "Keep it in the middle. Press again to let the value say", align('c')))
                    .child(b("fmt-right", "Right", look.align == Some('r'), "Keep it to the right. Press again to let the value say", align('r')))
                    .child(Divider::vertical().build(k))
                    .child(b("fmt-general", "General", plain, "No number format", calc::Fmt::Number("general")))
                    .child(b("fmt-number", "0.00", !plain && kind.is_none(), "Two decimals, grouped in thousands", number("number", false)))
                    .child(b("fmt-percent", "%", kind == Some("percentage"), "A percentage. Press again for no format", number("percentage", kind == Some("percentage"))))
                    .child(b("fmt-money", "$", kind == Some("currency"), "Money. Press again for no format", number("currency", kind == Some("currency"))))
                    .child(b("fmt-date", "Date", kind == Some("date"), "A date. Press again for no format", number("date", kind == Some("date"))))
                    .child(b("fmt-time", "Time", kind == Some("time"), "A time of day. Press again for no format", number("time", kind == Some("time")))),
            );
            // rows and columns put in beside the picked cell, or its own taken out: a line of their own, so none runs off a narrow window
            page = page.child(
                row().key("cell-shift").w_full().gap(4.0).center_y().pl(56.0)
                    .child(shift("row-above", "Row above", "Put a row in above this one", true, 0, 1))
                    .child(shift("row-below", "+ row", "Put a row in below this one", true, 1, 1))
                    .child(shift("row-del", "\u{2212} row", "Take this row out", true, 0, -1))
                    .child(Divider::vertical().build(k))
                    .child(shift("col-left", "Col left", "Put a column in left of this one", false, 0, 1))
                    .child(shift("col-right", "+ col", "Put a column in right of this one", false, 1, 1))
                    .child(shift("col-del", "\u{2212} col", "Take this column out", false, 0, -1)),
            );
        }
    }
    page.child(grid).child(tabs)
}

/// The most positions one line or area is drawn with.
const MAP_LINE: usize = 2000;
/// The most points drawn as pressable dots, and named.
const MAP_DOTS: usize = 400;
/// The most kinds the legend lists.
const MAP_KINDS: usize = 12;

fn map_view(m: &MapView, s: &App, k: &Kit) -> El {
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
    // the maps underneath come first, dimmed, and take no press
    let mut faint: Vec<(map::P, rune::Color)> = Vec::new();
    for f in m.under.iter().filter_map(|(_, f)| f.as_ref()).flatten() {
        let ink = rune::color::hex(&f.color).unwrap_or(c.text_accent).alpha(0.5);
        for g in &f.geoms {
            match g {
                map::Geom::Point(p) => faint.push((*p, ink)),
                map::Geom::Line(l) => shape = shape.stroke(map::thin(l, MAP_LINE).into_iter().map(to).collect::<Vec<_>>(), 2.5, ink),
                map::Geom::Area(l) => {
                    let ring: Vec<[f32; 2]> = map::thin(l, MAP_LINE).into_iter().map(to).collect();
                    shape = shape.fill(ring.clone(), ink.alpha(0.05)).stroke(ring, 1.5, ink);
                }
            }
        }
    }
    let mut dots: Vec<(usize, map::P)> = Vec::new();
    for (i, f) in m.feats.iter().enumerate().filter(|(_, f)| !m.hidden.contains(&f.kind)) {
        let ink = rune::color::hex(&f.color).unwrap_or(c.text_accent);
        // a line or area being dragged is drawn where it is held
        let (hx, hy) = m.moving.filter(|(at, ..)| *at == i).map_or((0.0, 0.0), |(_, dx, dy)| (dx, dy));
        let to = |p: map::P| {
            let [x, y] = to(p);
            [x + hx, y + hy]
        };
        for g in &f.geoms {
            match g {
                map::Geom::Point(p) => {
                    dots.push((i, *p));
                    // the ring round it, so many metres across the ground
                    if f.radius > 0.0 {
                        let ring: Vec<[f32; 2]> = map::circle(map::lonlat(*p), f.radius).into_iter().map(|p| m.cam.project(p, w, h)).collect();
                        shape = shape.fill(ring.clone(), ink.alpha(0.12)).stroke(ring, 1.5, ink);
                    }
                }
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
                    m.cam = fit_map(m);
                    m.fitted = true;
                }
            }
            sync_tiles(s);
        })
        .on_drag(|s: &mut App, d, _| {
            let (mut put, mut props) = (None, serde_json::json!({}));
            let (may, mut moved) = (map_changes(s), None);
            if let Some(m) = &mut s.map {
                // a press that hardly moved is a press, whatever it was on
                if d.phase == Phase::Up && d.dx.hypot(d.dy) < 5.0 {
                    m.moving = None;
                }
                match d.phase {
                    Phase::Down => {
                        m.grab = m.cam;
                        // a press on the picked line or area takes hold of it, to move it whole
                        let on = map::hit(m.feats.iter().enumerate().filter(|(_, f)| !m.hidden.contains(&f.kind)), &m.cam, m.size.0, m.size.1, d.x, d.y);
                        let shape = m.picked.filter(|i| on == Some(*i) && m.feats[*i].geoms.iter().any(|g| !matches!(g, map::Geom::Point(_))));
                        m.moving = shape.filter(|_| may && m.tool.is_none()).map(|i| (i, 0.0, 0.0));
                    }
                    Phase::Move if m.moving.is_some() => m.moving = m.moving.map(|(i, ..)| (i, d.dx, d.dy)),
                    // let go: it is saved where it was dragged to, by as far as the press moved over the ground
                    Phase::Up if m.moving.is_some() => {
                        let (i, ..) = m.moving.take().expect("a shape is held");
                        let at = |x: f32, y: f32| map::lonlat(m.cam.unproject(x, y, m.size.0, m.size.1));
                        moved = Some((m.feats[i].at, at(d.x - d.dx, d.y - d.dy), at(d.x, d.y)));
                    }
                    // with the point tool on, a press on the ground puts a point there
                    Phase::Up if d.dx.hypot(d.dy) < 5.0 && m.tool == Some(map::Draw::Point) => {
                        m.cam = m.grab;
                        put = Some(map::lonlat(m.cam.unproject(d.x, d.y, m.size.0, m.size.1)));
                    }
                    // a ring's second press is on its edge: the point goes at the centre, with the distance as its radius
                    Phase::Up if d.dx.hypot(d.dy) < 5.0 && m.tool == Some(map::Draw::Ring) && !m.verts.is_empty() => {
                        m.cam = m.grab;
                        let centre = m.verts.remove(0);
                        let radius = map::distance(centre, map::lonlat(m.cam.unproject(d.x, d.y, m.size.0, m.size.1))).round();
                        m.tool = None;
                        if radius > 0.0 {
                            (put, props) = (Some(centre), serde_json::json!({"radius": radius}));
                        }
                    }
                    // with the line or area tool on, each press is a corner. One on top of the last is dropped
                    Phase::Up if d.dx.hypot(d.dy) < 5.0 && m.tool.is_some() => {
                        m.cam = m.grab;
                        let last = m.verts.last().map(|v| m.cam.project(map::mercator(v[0], v[1]), m.size.0, m.size.1));
                        if last.is_none_or(|l| (l[0] - d.x).hypot(l[1] - d.y) >= 3.0) {
                            m.verts.push(map::lonlat(m.cam.unproject(d.x, d.y, m.size.0, m.size.1)));
                        }
                    }
                    // a press that hardly moved is a press on what is under it, or on nothing
                    Phase::Up if d.dx.hypot(d.dy) < 5.0 => {
                        m.cam = m.grab;
                        m.picked = map::hit(m.feats.iter().enumerate().filter(|(_, f)| !m.hidden.contains(&f.kind)), &m.cam, m.size.0, m.size.1, d.x, d.y);
                    }
                    _ => m.cam = map::Camera::dragged(m.grab, d.dx, d.dy),
                }
            }
            if let Some((at, from, to)) = moved {
                write_map(s, |body| map::shift(body, at, to[0] - from[0], to[1] - from[1]));
            }
            if let Some([lon, lat]) = put {
                if write_map(s, |body| map::add(body, serde_json::json!({"type": "Point", "coordinates": [lon, lat]}), props)) {
                    pick_added(s);
                }
            }
            sync_tiles(s);
        })
        .on_wheel(|s: &mut App, e: WheelEvent, _| {
            if let Some(m) = &mut s.map {
                // wheel up zooms in: a real wheel on Linux reports up as a positive dy (checked by the owner on beast)
                m.cam.zoom_at((e.dy as f64 / 200.0).exp(), e.x, e.y, m.size.0, m.size.1);
            }
            sync_tiles(s);
            true
        });
    // the base map's tiles go under the shapes: each tile had so far, where the camera puts it
    let mut tiled = 0;
    if m.fitted && s.tiles_off.is_none() {
        for t in map::tiles(&m.cam, w, h, s.tile_status.as_ref().map_or(17, |t| t.max)) {
            if let Some(pic) = s.pics.get(&tile_key(m.style, &t)).filter(|i| i.is_ready() && i.error().is_none()) {
                let [x, y, side] = map::tile_rect(&m.cam, &t, w, h);
                view = view.child(el().key(format!("tile-{}-{}-{}", t.z, t.x, t.y)).absolute(x, y).size(side, side).pixels(pic.pixels()).a11y_hidden());
                tiled += 1;
            }
        }
    }
    // the shape being drawn, in the web client's orange
    let pen = rune::color::hex("#e67e22").unwrap_or(c.text_accent);
    let mut corners: Vec<[f32; 2]> = m.verts.iter().map(|v| to(map::mercator(v[0], v[1]))).collect();
    if m.tool == Some(map::Draw::Area) && corners.len() > 2 {
        corners.push(corners[0]);
    }
    if corners.len() > 1 {
        shape = shape.stroke(corners.clone(), 2.0, pen);
    }
    let mut view = view.child(canvas(shape).key("map-shapes").absolute(0.0, 0.0).size(w, h));
    for (n, [x, y]) in corners.iter().take(m.verts.len()).enumerate() {
        view = view.child(el().key(format!("vert-{n}")).absolute(x - 4.0, y - 4.0).size(8.0, 8.0).radius(4.0).fill(pen).a11y_hidden().inert());
    }
    // until the first layout the size is a guess: draw the ground alone
    if !m.fitted {
        return view;
    }
    for (n, (p, ink)) in faint.iter().take(MAP_DOTS).enumerate() {
        let [x, y] = to(*p);
        if (-20.0..=w + 20.0).contains(&x) && (-20.0..=h + 20.0).contains(&y) {
            view = view.child(el().key(format!("under-{n}")).absolute(x - 5.0, y - 5.0).size(10.0, 10.0).radius(5.0).fill(*ink).a11y_hidden().inert());
        }
    }
    for (n, (i, p)) in dots.iter().take(MAP_DOTS).enumerate() {
        let [mut x, mut y] = to(*p);
        if !(-20.0..=w + 20.0).contains(&x) || !(-20.0..=h + 20.0).contains(&y) {
            continue;
        }
        let i = *i;
        // a point being dragged is drawn where it is held
        if let Some((_, dx, dy)) = m.moving.filter(|(at, ..)| *at == i) {
            (x, y) = (x + dx, y + dy);
        }
        let (was, scale) = (*p, m.cam.scale);
        let on = m.picked == Some(i);
        let f = &m.feats[i];
        // a point with a glyph is larger, to hold it. The sizes are the web client's
        let r = if f.icon.is_empty() { 6.0 } else { 10.0 } + if on { 2.0 } else { 0.0 };
        view = view.child(
            el().key(format!("dot-{n}"))
                .absolute(x - r, y - r)
                .size(r * 2.0, r * 2.0)
                .radius(r)
                .center()
                .fill(rune::color::hex(&f.color).unwrap_or(ink))
                .children((!f.icon.is_empty()).then(|| text(f.icon).font(k.ty.small_medium).color(rune::Color::WHITE).inert()))
                .border(2.0, c.bg_base)
                .label(m.feats[i].name.clone())
                .on_drag(move |s: &mut App, d, _| {
                    let may = map_changes(s);
                    let Some(m) = &mut s.map else { return };
                    match d.phase {
                        Phase::Down => {}
                        // a press picks it, or lets it go
                        Phase::Up if m.moving.is_none() => {
                            if d.dx.hypot(d.dy) < 5.0 {
                                m.picked = if m.picked == Some(i) { None } else { Some(i) };
                            }
                        }
                        // the picked point goes where it is dragged, and is saved there when let go
                        Phase::Move if m.picked == Some(i) && may && (m.moving.is_some() || d.dx.hypot(d.dy) >= 5.0) => m.moving = Some((i, d.dx, d.dy)),
                        Phase::Move => {}
                        Phase::Up => {
                            m.moving = None;
                            let Some(at) = m.feats.get(i).map(|f| f.at) else { return };
                            let (from, to) = (map::lonlat(was), map::lonlat([was[0] + d.dx as f64 / scale, was[1] + d.dy as f64 / scale]));
                            write_map(s, |body| map::shift(body, at, to[0] - from[0], to[1] - from[1]));
                        }
                    }
                }),
        );
        if !m.feats[i].name.is_empty() {
            view = view.child(text(m.feats[i].name.clone()).key(format!("name-{n}")).absolute(x + r + 4.0, y - 9.0).font(k.ty.small_medium).color(c.text_base).inert());
        }
    }
    // the picked shape's corners, each to be dragged somewhere else
    if let Some((i, f)) = m.picked.and_then(|i| Some((i, m.feats.get(i)?))).filter(|_| m.tool.is_none() && m.moving.is_none() && map_changes(s)) {
        let scale = m.cam.scale;
        for (n, (path, p)) in f.corners.iter().enumerate() {
            let [mut x, mut y] = to(*p);
            if !(-20.0..=w + 20.0).contains(&x) || !(-20.0..=h + 20.0).contains(&y) {
                continue;
            }
            if let Some((_, dx, dy)) = m.grip.filter(|(at, ..)| *at == n) {
                (x, y) = (x + dx, y + dy);
            }
            let (path, was, at) = (path.clone(), *p, f.at);
            view = view.child(el().key(format!("grip-{n}")).absolute(x - 6.0, y - 6.0).size(12.0, 12.0).radius(6.0).fill(rune::Color::WHITE).border(1.5, c.bg_base).label(format!("Corner {} of the picked shape", n + 1)).on_drag(move |s: &mut App, d, _| {
                let Some(m) = &mut s.map else { return };
                match d.phase {
                    Phase::Down => {}
                    Phase::Move => m.grip = Some((n, d.dx, d.dy)),
                    Phase::Up => {
                        if m.grip.take().is_some() && d.dx.hypot(d.dy) >= 5.0 && m.picked == Some(i) {
                            let [lon, lat] = map::lonlat([was[0] + d.dx as f64 / scale, was[1] + d.dy as f64 / scale]);
                            write_map(s, |body| map::set_corner(body, at, &path, lon, lat));
                        }
                    }
                }
            }));
        }
    }
    // the picked point's details
    if let Some(f) = m.picked.and_then(|i| m.feats.get(i)) {
        let mut card = col().key("map-detail").absolute(12.0, 12.0).w(290.0).padding(12.0).gap(6.0).radius(k.radius.md).fill(c.layer_01).border(1.0, c.border_weak);
        let what = match f.geoms.first() {
            Some(map::Geom::Line(_)) => "A line",
            Some(map::Geom::Area(_)) => "An area",
            _ => "A point",
        };
        card = card.child(text(if f.name.is_empty() { what.to_owned() } else { f.name.clone() }).font(k.ty.ui_medium).color(c.text_base));
        if !f.note.is_empty() {
            card = card.child(text(f.note.clone()).font(k.ty.small).color(c.text_muted).wrap());
        }
        let prop = |key: &str| f.props.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
        // orrery's body id shows as its link, not as a loose property
        let orrery = prop("orrery").and_then(map::orrery_link);
        for (key, v) in f.props.iter().filter(|(key, _)| key != "name" && key != "note" && !(key == "orrery" && orrery.is_some())).take(8) {
            card = card.child(row().gap(6.0).child(text(key.clone()).font(k.ty.small).color(c.text_faint)).child(text(v.clone()).font(k.ty.small).color(c.text_base).truncate().grow(1.0).min_w(0.0)));
        }
        let mut leads = row().key("map-leads").gap(6.0);
        if let Some(path) = orrery {
            leads = leads.child(Button::new("Open in orrery").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("This feature's body, in orrery on the ship").on_press_tx(move |s: &mut App, tx| {
                // orrery is another app on the ship: it opens in the browser
                let Some(c) = &s.conn else {
                    s.note = "sample pages have no ship to open orrery on".into();
                    return;
                };
                let url = format!("{}{path}", c.url.trim_end_matches('/'));
                s.note = match tx.open_url(&url) {
                    Ok(()) => format!("opening {url}"),
                    Err(e) => format!("could not open {url}: {e:?}"),
                };
            }).build(k).key("feature-orrery"));
        }
        match prop("source").and_then(map::source_link) {
            Some(map::Source::Url(url)) => {
                leads = leads.child(Button::new("Open source").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help(url.clone()).on_press_tx(move |s: &mut App, tx| {
                    s.note = match tx.open_url(&url) {
                        Ok(()) => format!("opening {url}"),
                        Err(e) => format!("could not open {url}: {e:?}"),
                    };
                }).build(k).key("feature-source-open"));
            }
            Some(map::Source::Page(page)) => {
                leads = leads.child(Button::new("Open source").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help(format!("The page {page}")).on_press(move |s: &mut App| go(s, &page)).build(k).key("feature-source-open"));
            }
            None => {}
        }
        if orrery_or_source(f) {
            card = card.child(leads);
        }
        if map_changes(s) {
            let at = f.at;
            let small = |label: &str| Button::new(label).control_size(ControlSize::Small).variant(ButtonVariant::Ghost);
            // each press here is a change to the page, saved at once, as on the web
            let set = move |key: &'static str, v: Option<&'static str>| move |s: &mut App| drop(write_map(s, |body| map::set_props(body, at, &[(key, v.map(serde_json::Value::from))])));
            let mut icons = row().key("map-icons").w_full().gap(2.0).flex_wrap();
            for (name, glyph) in map::ICONS {
                icons = icons.child(small(if glyph.is_empty() { "•" } else { glyph }).help(name).on_press(set("icon", Some(name))).build(k).key(format!("icon:{name}")));
            }
            let mut inks = row().key("map-colours").w_full().gap(6.0).center_y();
            for ink in map::KIND_COLORS {
                inks = inks.child(el().key(format!("colour:{ink}")).size(16.0, 16.0).radius(8.0).fill(rune::color::hex(ink).unwrap_or(c.text_accent)).label(format!("Colour {ink}")).on_press(set("color", Some(ink))));
            }
            card = card
                .child(icons.child(small("No icon").on_press(set("icon", None)).build(k).key("icon:none")))
                .child(inks.child(small("Kind's colour").on_press(set("color", None)).build(k).key("colour:none")))
                .child(
                    row().gap(6.0)
                        .child(Button::new("Edit").control_size(ControlSize::Small).help("Its name, kind and note").on_press(move |s: &mut App| ask_feature(s, at)).build(k).key("feature-edit"))
                        .child(Button::new("Delete").control_size(ControlSize::Small).variant(ButtonVariant::Danger).on_press(move |s: &mut App| {
                            if write_map(s, |body| map::remove(body, at)) {
                                if let Some(m) = &mut s.map {
                                    m.picked = None;
                                }
                            }
                        }).build(k).key("feature-delete")),
                );
        }
        view = view.child(card);
    }
    // the kinds, each with its colour and count: press one to hide or show its features
    let kinds = map::kinds(&m.feats);
    if kinds.len() > 1 || kinds.iter().any(|(kind, _)| !kind.is_empty()) || !m.under.is_empty() {
        let mut legend = col().key("map-legend").absolute(w - 192.0, 12.0).w(180.0).padding(6.0).gap(2.0).radius(k.radius.md).fill(c.layer_01).border(1.0, c.border_weak);
        for (kind, n) in kinds.into_iter().take(MAP_KINDS) {
            let off = m.hidden.contains(&kind);
            let swatch = if kind.is_empty() { "#2e86c1" } else { map::kind_color(&kind) };
            let label = format!("{} ({n})", if kind.is_empty() { "no kind" } else { &kind });
            legend = legend.child(
                row().key(format!("kind:{kind}"))
                    .h(24.0)
                    .px(6.0)
                    .gap(8.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .label(format!("{label}, {}", if off { "hidden" } else { "shown" }))
                    .on_press(move |s: &mut App| {
                        if let Some(m) = &mut s.map {
                            if !m.hidden.remove(&kind) {
                                m.hidden.insert(kind.clone());
                            }
                            // a hidden feature is not left picked
                            if m.picked.and_then(|i| m.feats.get(i)).is_some_and(|f| m.hidden.contains(&f.kind)) {
                                m.picked = None;
                            }
                        }
                    })
                    .child(el().size(10.0, 10.0).radius(5.0).fill(rune::color::hex(swatch).unwrap_or(ink).alpha(if off { 0.3 } else { 1.0 })))
                    .child(text(label).font(k.ty.small).color(if off { c.text_faint } else { c.text_base }).truncate().grow(1.0).min_w(0.0)),
            );
        }
        for (name, feats) in &m.under {
            let say = feats.as_ref().map_or(format!("Layer {name} could not be read."), |f| format!("Layer: {name} ({})", f.len()));
            legend = legend.child(text(say).font(k.ty.small).color(c.text_muted).wrap());
        }
        view = view.child(legend);
    }
    let zoom = |key: &str, label: &str, f: f64| {
        Button::new(label)
            .control_size(ControlSize::Small)
            .on_press(move |s: &mut App| {
                if let Some(m) = &mut s.map {
                    let (w, h) = m.size;
                    if f == 0.0 { m.cam = fit_map(m) } else { m.cam.zoom_at(f, w / 2.0, h / 2.0, w, h) }
                }
                sync_tiles(s);
            })
            .build(k)
            .key(key.to_owned())
    };
    // what the ground is: the base map with whom it is owed to, or why there is none
    let ground = match (&s.tiles_off, tiled) {
        (Some(why), _) if s.conn.is_some() => format!("   no base map: {why}"),
        (None, n) if n > 0 => format!("   {}  © Mapbox © OpenStreetMap", m.style),
        _ => String::new(),
    };
    let showing = m.feats.iter().filter(|f| !m.hidden.contains(&f.kind)).count();
    let count = text(if showing == m.feats.len() { format!("{showing} shapes{ground}") } else { format!("{showing} of {} shapes{ground}", m.feats.len()) }).font(k.ty.small).color(c.text_muted);
    let mut draw = Vec::new();
    if map_changes(s) {
        for (tool, label, key, help) in [
            (map::Draw::Point, "Point", "map-point", "Put a point where the map is pressed next. Press again to stop"),
            (map::Draw::Line, "Line", "map-line", "Draw a line: press for each corner, then Done"),
            (map::Draw::Area, "Area", "map-area", "Draw an area: press for each corner, then Done"),
            (map::Draw::Ring, "Ring", "map-ring", "Draw a ring: press its centre, then its edge"),
        ] {
            draw.push(Button::new(label).control_size(ControlSize::Small).variant(if m.tool == Some(tool) { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).help(help).on_press(move |s: &mut App| {
                if let Some(m) = &mut s.map {
                    // another tool, or the same one again to stop: what was being drawn is dropped
                    m.tool = Some(tool).filter(|t| m.tool != Some(*t));
                    m.verts.clear();
                }
            }).build(k).key(key));
        }
        if !m.verts.is_empty() && m.tool != Some(map::Draw::Ring) {
            draw.push(Button::new("Done").control_size(ControlSize::Small).help("Finish the shape").on_press(finish_shape).build(k).key("map-done"));
        }
    }
    if map_changes(s) {
        draw.push(Button::new("Import").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Add the features of a GPX, KML or GeoJSON file").on_press_tx(ask_map_import).build(k).key("map-import"));
    }
    draw.push(Button::new("GPX").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Download this map as GPX").on_press_tx(ask_gpx).build(k).key("map-gpx"));
    let base = Button::new(format!("Base: {}", m.style)).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("The next base map: streets, outdoors, satellite, dark. It is kept in the page").on_press(next_base).build(k).key("map-base");
    let token = (s.conn.is_some() && s.tile_status.as_ref().is_some_and(|t| !t.token)).then(|| Button::new("Set Mapbox token").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(ask_token).build(k).key("map-token"));
    view.child(row().key("map-tools").absolute(12.0, h - 40.0).gap(6.0).center_y().child(zoom("zoom-in", "+", 2.0)).child(zoom("zoom-out", "−", 0.5)).child(zoom("zoom-fit", "Fit", 0.0)).children(draw).child(base).children(token).child(count))
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

/// Whether the open page may load what it has from other sites.
fn outside_ok(s: &App) -> bool {
    s.open.as_ref().is_some_and(|p| s.prefs.outside.contains(&p.name))
}

/// The open page's images from other sites that are held back.
fn held_back(s: &App) -> usize {
    match s.open.as_ref().filter(|_| !s.memory && !s.editing).and_then(|p| read_md(s, p)) {
        Some(body) if !outside_ok(s) => md::images(body).iter().filter(|u| md::remote(u)).count(),
        _ => 0,
    }
}

/// Fetches the open page's images, each on a thread of its own, twenty
/// at most. One from another site is fetched only when the page has been
/// let to load outside content, since that site then learns the reader's
/// address. One on the ship is fetched with the session, and nowhere else is.
fn sync_pics(s: &mut App) {
    let Some(p) = s.open.as_ref().filter(|p| !s.memory && read_md(s, p).is_some()) else { return };
    let now = (p.name.clone(), p.rev);
    let ok = outside_ok(s);
    if s.pics_for.as_ref() == Some(&now) && !ok {
        return;
    }
    s.pics_for = Some(now);
    let Some(waker) = s.waker.clone() else { return };
    for src in md::images(read_md(s, p).unwrap_or_default()).into_iter().take(20) {
        let (url, cookie) = if md::remote(&src) {
            if !ok {
                continue;
            }
            (if src.starts_with("//") { format!("https:{src}") } else { src.clone() }, None)
        } else {
            match (&s.conn, &s.remote) {
                (Some(c), None) => (c.image_url(&src), Some(c.cookie().to_owned())),
                _ => continue,
            }
        };
        if !s.pics_asked.insert(src.clone()) {
            continue;
        }
        let (back, waker) = (s.pics_in.clone(), waker.clone());
        std::thread::spawn(move || {
            let got = api::fetch_bytes(&url, cookie.as_deref());
            if let Ok(mut list) = back.lock() {
                list.push((src, got));
            }
            waker();
        });
    }
}

/// The camera that shows the whole map. A map with nothing of its own
/// is fitted to what lies under it, not to the world.
fn fit_map(m: &MapView) -> map::Camera {
    let (w, h) = m.size;
    if m.feats.is_empty() { map::Camera::fit(m.under.iter().filter_map(|(_, f)| f.as_ref()).flatten(), w, h) } else { map::Camera::fit(&m.feats, w, h) }
}

/// Sets the base map of the map in front to the next one and saves the
/// page, in the layout the web client writes a map in.
fn next_base(s: &mut App) {
    let Some(m) = &s.map else { return };
    let at = map::STYLES.iter().position(|x| *x == m.style).unwrap_or(0);
    let style = map::STYLES[(at + 1) % map::STYLES.len()];
    write_map(s, |body| map::with_base(body, style));
}

/// Makes the line or area being drawn a feature of the page and picks
/// it. With too few corners for the tool, what was drawn is dropped.
fn finish_shape(s: &mut App) {
    let Some(m) = &mut s.map else { return };
    let (Some(tool), verts) = (m.tool, std::mem::take(&mut m.verts)) else { return };
    let Some(geometry) = map::drawn(tool, &verts) else {
        s.note = "that is too few corners: a line takes two and an area three".into();
        return;
    };
    m.tool = None;
    if write_map(s, |body| map::add(body, geometry, serde_json::json!({}))) {
        pick_added(s);
    }
}

/// Picks the feature just added: now, or when the page comes back from the ship with it.
fn pick_added(s: &mut App) {
    let coming = s.save_req.is_pending();
    if let Some(m) = &mut s.map {
        if coming { m.pick_new = true } else { m.picked = m.feats.len().checked_sub(1) }
    }
}

/// Asks for a GPX, KML or GeoJSON file and adds its features to the map in
/// front. The file is read and checked off the window's thread.
fn ask_map_import(s: &mut App, tx: &mut Tx) {
    if !map_changes(s) {
        s.note = "this map is not changed here, so nothing was imported".into();
        return;
    }
    let options = rune::FileDialogOptions { title: "Import into this map".into(), ..Default::default() };
    tx.open_file(options.filter("Maps", &["gpx", "kml", "geojson", "json"]), |s: &mut App, result: rune::FileDialogResult, _: &mut Tx| match result {
        Ok(Some(path)) => map_import(s, path),
        Ok(None) => {}
        Err(e) => s.note = format!("no file dialog could open: {e}"),
    });
}

fn map_import(s: &mut App, path: std::path::PathBuf) {
    s.note = "reading the file".into();
    s.op_req.request(path, |path| {
        let name = path.file_name().map_or(String::new(), |n| n.to_string_lossy().into_owned());
        let read = match mapio::file_kind(&name) {
            "" => Err("lattice reads .geojson, .json, .gpx and .kml files".to_owned()),
            kind => std::fs::read_to_string(&path).map_err(|_| "the file cannot be read".to_owned()).and_then(|text| mapio::import(kind, &text)),
        };
        Ok(match read {
            Ok(got) => {
                let simplified = if got.before > 0 { format!(", tracks simplified from {} to {} points", got.before, got.after) } else { String::new() };
                let say = format!("imported {name}: {} features{simplified}", got.features.len());
                Op::MapIn(got.features, say)
            }
            Err(why) => Op::Said(format!("{name}: {why}")),
        })
    });
}

/// Saves the map in front as a GPX file named in the save dialog.
fn ask_gpx(s: &mut App, tx: &mut Tx) {
    let Some(p) = &s.open else { return };
    let title = p.name.rsplit('/').next().unwrap_or("map").to_owned();
    let Some(gpx) = mapio::export_gpx(&p.body, &title) else {
        s.note = "this page is not a map".into();
        return;
    };
    let options = rune::FileDialogOptions { title: "Download as GPX".into(), file_name: Some(format!("{title}.gpx")), ..Default::default() };
    tx.save_file(options, move |s: &mut App, result: rune::FileDialogResult, _: &mut Tx| match result {
        Ok(Some(path)) => write_file(s, path, gpx.clone()),
        Ok(None) => {}
        Err(e) => s.note = format!("no file dialog could open: {e}"),
    });
}

/// Whether a feature's card has somewhere to lead: its orrery body or its source.
fn orrery_or_source(f: &map::Feature) -> bool {
    let prop = |key: &str| f.props.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    prop("orrery").and_then(map::orrery_link).is_some() || prop("source").and_then(map::source_link).is_some()
}

/// Whether the map in front may be changed here: one of the owner's own
/// pages, being read, and not the map orrery keeps.
fn map_changes(s: &App) -> bool {
    usable(s, "map-base") && !kept_by_orrery(s) && !s.save_req.is_pending()
}

/// Asks for the name, kind and note of the feature at `at` in the page.
fn ask_feature(s: &mut App, at: usize) {
    let Some(f) = s.map.as_ref().and_then(|m| m.feats.iter().find(|f| f.at == at)) else { return };
    let was = |key: &str| TextEdit::new(f.props.iter().find(|(k, _)| k == key).map_or("", |(_, v)| v.as_str()));
    let mut t = [TextEdit::new(f.name.as_str()), TextEdit::new(f.kind.as_str()), TextEdit::new(f.note.as_str()), was("time"), was("source"), was("radius")];
    t[0].focused = true;
    s.prompt = Some(Prompt::Feature(at, Box::new(t)));
}

/// Changes the map in front and saves the page, in the layout the web
/// client writes a map in. Every change to a map goes through here.
/// `false` when nothing was changed.
fn write_map(s: &mut App, change: impl FnOnce(&str) -> Option<String>) -> bool {
    let Some(p) = s.open.clone() else { return false };
    if !map_changes(s) {
        s.note = "this map is not changed here".into();
        return false;
    }
    let Some(body) = change(&p.body) else {
        s.note = "that change was not made: the map is too large, or is not one lattice writes".into();
        return false;
    };
    save_body(s, p, body);
    true
}

/// Asks for the ship's Mapbox token.
fn ask_token(s: &mut App) {
    if s.conn.is_none() {
        s.note = "sample pages have no ship to keep a token".into();
        return;
    }
    let mut t = TextEdit::new("");
    t.focused = true;
    s.prompt = Some(Prompt::Token(t));
}

/// The name a tile's picture is kept under, beside the pages' images.
fn tile_key(style: &str, t: &map::Tile) -> String {
    format!("tile:{style}/{}/{}/{}", t.z, t.x, t.y)
}

/// Asks the ship for the tiles the map showing needs and does not have,
/// eight at a time, and lets go of tiles that are no longer in view once
/// there are many. The ship fetches each from Mapbox with the owner's
/// token, so nothing is asked of a ship that has none.
fn sync_tiles(s: &mut App) {
    let (Some(c), Some(m)) = (s.conn.clone(), &s.map) else { return };
    if !s.open.as_ref().is_some_and(|p| p.name == m.name) || s.editing {
        return;
    }
    let Some(status) = &s.tile_status else {
        // asked once: the answer brings the first tiles
        if !s.tile_status_req.is_pending() && s.tiles_off.is_none() {
            s.tile_status_req.request(c, |c| c.tile_status());
        }
        return;
    };
    if s.tiles_off.is_some() || !m.fitted {
        return;
    }
    let Some(waker) = s.waker.clone() else { return };
    let want = map::tiles(&m.cam, m.size.0, m.size.1, status.max);
    let keys: std::collections::HashSet<String> = want.iter().map(|t| tile_key(m.style, t)).collect();
    if s.pics.len() > 160 {
        s.pics.retain(|k, _| !k.starts_with("tile:") || keys.contains(k));
        s.pics_asked.retain(|k| !k.starts_with("tile:") || keys.contains(k));
    }
    for t in want {
        if s.tiles_flying >= 8 {
            break;
        }
        let key = tile_key(m.style, &t);
        if !s.pics_asked.insert(key.clone()) {
            continue;
        }
        s.tiles_flying += 1;
        let (url, cookie, back, waker) = (c.tile_url(m.style, t.z, t.x, t.y), c.cookie().to_owned(), s.pics_in.clone(), waker.clone());
        std::thread::spawn(move || {
            let got = api::fetch_bytes(&url, Some(&cookie));
            if let Ok(mut list) = back.lock() {
                list.push((key, got));
            }
            waker();
        });
    }
}

/// Takes in what the fetching threads brought back. `true` when something came.
fn take_pics(s: &mut App) -> bool {
    let got: Vec<_> = s.pics_in.lock().map(|mut l| std::mem::take(&mut *l)).unwrap_or_default();
    let mut any = !got.is_empty();
    // a picture's decode ends on another thread and wakes the app: it is drawn at the next look
    let ready = s.pics.values().filter(|i| i.is_ready()).count();
    any |= std::mem::replace(&mut s.pics_ready, ready) != ready;
    for (src, res) in got {
        if src.starts_with("tile:") {
            s.tiles_flying = s.tiles_flying.saturating_sub(1);
            // a tile that failed is not asked for again, and the first failure says why once
            if let Err(e) = &res {
                if s.tiles_off.is_none() && (e == "503" || e == "502" || e == "403") {
                    s.tiles_off = Some(match e.as_str() {
                        "503" => "no Mapbox token is set on the ship".to_owned(),
                        "403" => "the ship refused the tile".to_owned(),
                        _ => "the tile server failed or refused the token".to_owned(),
                    });
                }
                continue;
            }
        }
        match (res, &s.image_cache) {
            (Ok(bytes), Some(cache)) => {
                s.pics.insert(src, cache.load(bytes));
            }
            (Err(e), _) => s.note = format!("an image did not load: {e}"),
            _ => {}
        }
    }
    any
}

/// A Markdown page as the reader shows it: wiki links, ghost links, and
/// the pictures had so far.
fn reader(body: &str, s: &App, k: &Kit, found: bool) -> El {
    let pics = s.pics.clone();
    let src = md::wikilinks(body, &|n| ghost(s, n));
    // what find matches is marked, the current one apart from the rest
    let marks: Vec<(Vec<std::ops::Range<usize>>, rune_kit::Highlight)> = match s.find.as_ref().filter(|_| found) {
        Some(q) => find_in(&src, &q.text).into_iter().enumerate().map(|(i, m)| (m, if i == s.find_at { rune_kit::Highlight::current() } else { rune_kit::Highlight::new() })).collect(),
        None => Vec::new(),
    };
    Markdown::new(src).selectable(true).on_link_tx(follow).images(move |src| pics.get(src).cloned()).highlights(marks).build(k)
}

/// The colours of a page's source, by its kind: Rune's own lexers for
/// the kinds they know, and the web client's own grammars, ported in
/// `code.rs`, for Hoon, OpenSCAD, LaTeX and gemtext. Colour only, so
/// nothing moves as it is typed. Plain text has none.
fn code_spans(kind: &str, text: &str, k: &Kit) -> Vec<Span> {
    let theme = SyntaxTheme::from_kit(k);
    if !code::knows(kind) {
        let lang = match kind {
            "md" => Some("markdown"),
            "geojson" => Some("json"),
            "html" | "fods" | "fodt" | "svg" => Some("html"),
            "text" => None,
            other => Some(other),
        };
        return theme.spans(&syntax::highlight(lang, text), 0);
    }
    // the last page coloured is kept, so a frame that changes nothing reads nothing again
    thread_local! {
        static LAST: std::cell::RefCell<(String, String, Vec<syntax::Highlight>)> = const { std::cell::RefCell::new((String::new(), String::new(), Vec::new())) };
    }
    LAST.with_borrow_mut(|last| {
        if last.0 != kind || last.1 != text {
            *last = (kind.to_owned(), text.to_owned(), code::highlight(kind, text).into_iter().map(|(r, s)| (r, syntax::Paint::Kind(s))).collect());
        }
        theme.spans(&last.2, 0)
    })
}

/// Where `query` is found in a page's text as it is read: any case,
/// with or without accents, never inside the Markdown's own marks.
fn find_in(src: &str, query: &str) -> Vec<Vec<std::ops::Range<usize>>> {
    rune_kit::markdown::find(src, query.trim(), rune_kit::Case::Folded(rune_kit::search::Fold::default()))
}

/// Where find's query is in the text being edited, as it is typed there.
fn edit_matches(s: &App) -> Vec<std::ops::Range<usize>> {
    match s.find.as_ref().filter(|_| s.editing) {
        Some(q) => rune_kit::search::Fold::default().find(&s.edit.text, q.text.trim()),
        None => Vec::new(),
    }
}

/// The editor's marks for what find matches: a wash behind each, and a
/// stronger one behind the current. Paint only, so nothing moves.
fn find_spans(s: &App, k: &Kit) -> Vec<Span> {
    edit_matches(s).into_iter().enumerate().map(|(i, r)| Span::new(r.start, r.end).bg(k.c.text_accent.alpha(if i == s.find_at { 0.55 } else { 0.22 }), 1.0)).collect()
}

/// What find looks through: the text being edited, a Markdown page as
/// read, a sheet's cells, or a page's source. A map has nothing to find in.
#[derive(Debug, PartialEq)]
enum FindIn {
    Editor,
    Reader,
    Sheet,
    Source,
    Nothing,
}

fn find_where(s: &App) -> FindIn {
    let Some(p) = &s.open else { return FindIn::Nothing };
    if s.editing {
        FindIn::Editor
    } else if read_md(s, p).is_some() {
        FindIn::Reader
    } else if s.sheet.as_ref().is_some_and(|v| v.name == p.name && v.rev == p.rev) {
        FindIn::Sheet
    } else if s.map.as_ref().is_some_and(|m| m.name == p.name && m.rev == p.rev) {
        FindIn::Nothing
    } else {
        FindIn::Source
    }
}

/// The cells of the sheet showing that hold find's query, by row then column.
fn sheet_matches(s: &App) -> Vec<(usize, usize)> {
    let (Some(q), Some(v)) = (s.find.as_ref().map(|q| q.text.trim()).filter(|q| !q.is_empty()), &s.sheet) else { return Vec::new() };
    let fold = rune_kit::search::Fold::default();
    let mut out = Vec::new();
    for (r, row) in v.sheets[v.at].rows.iter().enumerate() {
        for (c, cell) in row.iter().enumerate().take(SHEET_COLS) {
            if fold.contains(cell, q) {
                out.push((r, c));
            }
        }
    }
    out
}

/// The part of a page's source that is drawn: its start, since a
/// spreadsheet's XML can run to megabytes.
fn source_shown(body: &str) -> &str {
    let cut = (0..=body.len().min(200_000)).rev().find(|&i| body.is_char_boundary(i)).unwrap_or(0);
    &body[..cut]
}

/// Where find's query is in the source that is drawn.
fn source_matches(s: &App) -> Vec<std::ops::Range<usize>> {
    match (&s.find, &s.open) {
        (Some(q), Some(p)) => rune_kit::search::Fold::default().find(source_shown(&p.body), q.text.trim()),
        _ => Vec::new(),
    }
}

/// How many matches find has in the open page.
fn find_count(s: &App) -> usize {
    match (find_where(s), &s.find, &s.open) {
        (FindIn::Editor, ..) => edit_matches(s).len(),
        (FindIn::Reader, Some(q), Some(p)) => find_in(&md::wikilinks(read_md(s, p).unwrap_or_default(), &|n| ghost(s, n)), &q.text).len(),
        (FindIn::Sheet, ..) => sheet_matches(s).len(),
        (FindIn::Source, ..) => source_matches(s).len(),
        _ => 0,
    }
}

/// Opens find for the page being read. Only a Markdown page has it.
fn open_find(s: &mut App) {
    if find_where(s) == FindIn::Nothing {
        s.note = "there is nothing here to find in".into();
        return;
    }
    s.find_at = 0;
    let mut q = s.find.take().unwrap_or_else(|| TextEdit::new(""));
    q.focused = true;
    s.find = Some(q);
}

/// Moves to the next match, or the one before, round the ends, and brings it into view.
fn find_step(s: &mut App, by: isize, tx: &mut Tx) {
    let n = find_count(s);
    if n == 0 {
        return;
    }
    s.find_at = (s.find_at.min(n - 1) as isize + by).rem_euclid(n as isize) as usize;
    match find_where(s) {
        // the match is selected, which is what the field keeps in view
        FindIn::Editor => {
            if let Some(r) = edit_matches(s).get(s.find_at).cloned() {
                s.edit.set_selection(r.start, r.end);
            }
        }
        FindIn::Reader => tx.scroll_into_view(Markdown::highlight_key(s.find_at)),
        // the row of the cell is selected and brought into view
        FindIn::Sheet => {
            if let (Some(&(row, _)), Some(v)) = (sheet_matches(s).get(s.find_at), &mut s.sheet) {
                v.table.select(row.to_string());
                v.table.reveal(row.to_string(), tx);
            }
        }
        // ponytail: a source page's match is marked but not scrolled to. The text is one element,
        // and Rune brings elements into view, not places in a text
        FindIn::Source | FindIn::Nothing => {}
    }
}

/// The find bar: the field, where the current match stands among them, and the way round.
fn find_bar(q: &TextEdit, s: &App, k: &Kit) -> El {
    let n = find_count(s);
    let says = match (q.text.trim().is_empty(), n) {
        (true, _) => String::new(),
        (false, 0) => "no match".to_owned(),
        (false, n) => format!("{} of {n}", s.find_at.min(n - 1) + 1),
    };
    let field = TextInput::new(q)
        .placeholder("Find in this page")
        .leading_icon(k.glyph.search)
        .on_edit(|s: &mut App| s.find.as_mut().expect("find is open"))
        .on_change(|s: &mut App, tx| {
            s.find_at = 0;
            tx.scroll_into_view(Markdown::highlight_key(0));
        })
        .on_key(|s: &mut App, ev: &KeyEvent, tx: &mut Tx| match ev.key {
            Key::Enter => {
                find_step(s, if ev.mods.shift { -1 } else { 1 }, tx);
                true
            }
            Key::Escape => {
                s.find = None;
                // back to the text, where the match found is selected
                if s.editing {
                    tx.focus_when_shown(FIELD, false);
                }
                true
            }
            _ => false,
        })
        .build(k)
        .key("find-field")
        .w(280.0);
    row()
        .key("find-bar")
        .w_full()
        .px(16.0)
        .py(6.0)
        .gap(8.0)
        .center_y()
        .fill(k.c.layer_01)
        .child(field)
        .child(text(says).key("find-count").font(k.ty.small).color(k.c.text_muted).grow(1.0))
        .child(Button::new("Previous").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(n == 0).on_press_tx(|s: &mut App, tx| find_step(s, -1, tx)).build(k).key("find-prev"))
        .child(Button::new("Next").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(n == 0).on_press_tx(|s: &mut App, tx| find_step(s, 1, tx)).build(k).key("find-next"))
        .child(Button::new("×").control_size(ControlSize::Small).variant(ButtonVariant::GhostFaint).help("Close find").on_press(|s: &mut App| s.find = None).build(k).key("find-close"))
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
    } else if api::valid_name(name) {
        start_named(s, name.to_owned());
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
        row().w_full().child(Button::new(if ghost { format!("{name}  (not written)") } else { name.to_owned() }).control_size(ControlSize::Small).variant(if ghost { ButtonVariant::GhostFaint } else { ButtonVariant::Ghost }).on_press_tx(move |s: &mut App, tx| {
            go(s, &to);
            if s.editing {
                tx.focus_when_shown(FIELD, false);
            }
        }).build(k).key(key))
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
    if s.pane_comments || s.pane_links {
        return;
    }
    let (Some(c), Some(p)) = (s.conn.clone(), &s.open) else { return };
    if s.inspector.is_open() {
        let memory = s.memory;
        s.hist_req.request((c, p.name.clone()), move |(c, n)| if memory { c.know_history(&format!("/{n}")) } else { c.history(&n) }.map(|r| (n, r)));
    }
}

/// Shows the open page as it was at `rev`, read-only.
fn view_rev(s: &mut App, rev: u64) {
    let (Some(c), Some(p)) = (s.conn.clone(), &s.open) else { return };
    // a memory in hand has no number of its own: its newest revision is the one showing
    let newest = if s.memory { s.revs.as_ref().filter(|(n, _)| *n == p.name).and_then(|(_, r)| r.iter().map(|r| r.rev).max()) } else { Some(p.rev) };
    if newest == Some(rev) {
        s.old = None;
        return;
    }
    let memory = s.memory;
    s.old_req.request((c, p.name.clone()), move |(c, n)| {
        if !memory {
            return c.page_at(&n, rev);
        }
        let body = c.know_at(&format!("/{n}"), rev)?;
        Ok(Page { name: n, body, kind: "md".into(), rev })
    });
}

/// Saves the old revision on screen as the page's newest. Nothing is
/// lost: what it replaces stays in the history.
fn restore(s: &mut App) {
    let (Some(c), Some(old), Some(cur)) = (s.conn.clone(), s.old.take(), &s.open) else { return };
    if s.memory {
        // the ship makes the old revision the newest itself, with its tags, and the lists are read again
        s.op_req.request((c, old.name, old.rev), |(c, name, rev)| {
            c.know_restore_rev(&format!("/{name}"), rev)?;
            Ok(Op::Restored(name))
        });
        return;
    }
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
        if name == ORRERY_MAP {
            s.kept = None;
            s.kept_req.request(c.clone(), |c| c.kept(ORRERY_MAP));
        }
        s.page_req.request((c, name.to_owned()), |(c, n)| c.page(&n));
    }
    sync_map(s);
    sync_sheet(s);
    load_history(s);
    load_comments(s);
    load_links(s);
    sync_pics(s);
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
/// The pages offered for the wiki link being typed at the caret, and
/// where what is typed of it starts. A whole date offers that day's
/// journal page first, written or not.
fn link_offers(s: &App) -> Option<(usize, Vec<String>)> {
    if !s.editing || s.memory || s.edit.anchor != s.edit.focus {
        return None;
    }
    let (start, q) = md::link_query(&s.edit.text, s.edit.focus)?;
    if s.ac_off == Some(start) {
        return None;
    }
    let mut offers: Vec<String> = md::journal_day(q).into_iter().collect();
    offers.extend(matches(&s.names, q).into_iter().map(str::to_owned).filter(|n| !offers.contains(n)).take(8 - offers.len()).collect::<Vec<_>>());
    (!offers.is_empty()).then_some((start, offers))
}

/// Puts an offered page in place of what was typed, and closes the link.
fn accept_link(s: &mut App, start: usize, name: &str) {
    let caret = s.edit.focus;
    let closed = s.edit.text[caret..].starts_with("]]");
    s.edit.set_selection(start, caret);
    s.edit.insert(&if closed { name.to_owned() } else { format!("{name}]]") });
    s.ac_at = 0;
}

fn editor_key(s: &mut App, ev: &KeyEvent, _: &mut Tx) -> bool {
    let plain = ev.mods == rune::Mods::default();
    if let Some((start, offers)) = link_offers(s).filter(|_| plain) {
        let at = s.ac_at.min(offers.len() - 1);
        match ev.key {
            Key::Tab => {
                accept_link(s, start, &offers[at]);
                return true;
            }
            Key::Down | Key::Up => {
                s.ac_at = if ev.key == Key::Down { (at + 1) % offers.len() } else { (at + offers.len() - 1) % offers.len() };
                return true;
            }
            Key::Escape => {
                s.ac_off = Some(start);
                return true;
            }
            _ => {}
        }
    }
    if ev.key == Key::Enter && plain && s.edit.current_block() == Block::Paragraph {
        s.edit.insert("\n");
        return true;
    }
    false
}

const KEPT_AS_SOURCE: &str = "this page has Markdown the rich editor would rewrite, so it is edited as source";

/// The one page orrery can keep: its map. The ship refuses saves to a
/// kept map, so it opens read-only.
const ORRERY_MAP: &str = "orrery/map";

fn kept_by_orrery(s: &App) -> bool {
    s.open.as_ref().is_some_and(|p| p.name == ORRERY_MAP && p.kind == "geojson") && !s.memory && s.remote.is_none() && s.kept != Some(false)
}

fn start_edit(s: &mut App) {
    s.old = None;
    if kept_by_orrery(s) {
        s.note = "orrery keeps this map, so it is read-only here. Draw on orrery/map-notes".into();
        return;
    }
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
    start_named(s, name);
    s.note = "a new page in the inbox, kept when you save".into();
}

/// Starts a page that is not written yet under a name it already has,
/// open in the editor. Its first save makes it.
fn start_named(s: &mut App, name: String) {
    if s.editing {
        return;
    }
    if s.memory {
        flip(s);
    }
    // nothing is asked of the ship: the page is not there until it is saved
    (s.remote, s.folder, s.old, s.want) = (None, None, None, None);
    (s.shared_open, s.inbox, s.access, s.stale) = (false, false, false, false);
    s.note = format!("{name} is not written yet. It is kept when you save");
    s.open = Some(Page { name, body: String::new(), kind: "md".into(), rev: 0 });
    s.capture = true;
    start_edit(s);
}

/// Today's journal page: the one there is, under any of its names, or a
/// new one started at the name the ship's journal pass uses.
fn open_today(s: &mut App) {
    if s.editing {
        return;
    }
    if s.memory {
        flip(s);
    }
    let forms = api::journal_forms(&api::today());
    match forms.iter().find(|f| s.names.contains(f)) {
        Some(name) => {
            let name = name.clone();
            s.files.select(&name);
            open_page(s, &name);
        }
        None => start_named(s, forms[0].clone()),
    }
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
    if std::mem::take(&mut s.resync) && s.conn.is_some() {
        s.next_sync = clock + 2.0;
        tx.wake_after(std::time::Duration::from_secs(2));
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
    if let Some(r) = s.templates_req.take() {
        changed = true;
        match r {
            Ok(list) => {
                // the first one is chosen until another is
                if let Some((chosen, name)) = s.tmpl.as_mut().filter(|t| t.0.is_empty()) {
                    *chosen = list.first().cloned().unwrap_or_default();
                    if name.text.is_empty() || name.text.ends_with('/') {
                        let seeded = format!("{}{chosen}", name.text);
                        *name = TextEdit::new(seeded);
                        name.focused = true;
                    }
                }
                s.templates = list;
            }
            Err(e) => s.note = format!("templates: {e}"),
        }
    }
    if let Some(Ok(k)) = s.kept_req.take() {
        changed = true;
        s.kept = k;
    }
    if let Some(r) = s.tile_status_req.take() {
        changed = true;
        match r {
            Ok(t) => {
                s.tiles_off = (!t.token).then(|| "no Mapbox token is set on the ship".to_owned());
                s.tile_status = Some(t);
            }
            Err(e) => s.tiles_off = Some(e),
        }
    }
    if let Some(mut drawn) = s.scad_req.take() {
        changed = true;
        // the part goes to the 3D view, seen from where the last one was when it is the same page's
        if let Some(mesh) = drawn.2.mesh.take() {
            let old = s.part.take().filter(|v| v.name == drawn.0);
            let cam = old.as_ref().map_or_else(|| {
                let mut c = view3d::Cam::default();
                c.fit(&mesh);
                c
            }, |v| v.cam);
            s.part = Some(PartView { name: drawn.0.clone(), mesh: std::sync::Arc::new(mesh), cam, grab: cam, pan: old.as_ref().is_some_and(|v| v.pan), pic: None, was: old.and_then(|v| v.pic.or(v.was)) });
            draw_part(s);
        } else {
            s.part = None;
        }
        s.scad = Some(drawn);
    }
    if let Some((name, w, h, px)) = s.part_req.take() {
        changed = true;
        if let (Some(v), Some(cache)) = (s.part.as_mut().filter(|v| v.name == name), &s.image_cache) {
            // the one showing stays until the new one can be shown
            if let Some(ready) = v.pic.take().filter(|i| i.is_ready() && i.error().is_none()) {
                v.was = Some(ready);
            }
            v.pic = Some(cache.rgba(w, h, px));
        }
    }
    if let Some((name, rev, got)) = s.tex_req.take() {
        changed = true;
        match got {
            Ok(md) => s.read_as = Some((name, rev, md)),
            Err(why) => s.tex_why = Some((name, rev, why)),
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
    if let Some(r) = s.trash_req.take() {
        changed = true;
        match r {
            Ok(keys) if s.trash.is_some() => s.trash = Some(Some(keys.iter().map(|k| k.trim_start_matches('/').to_owned()).collect())),
            Ok(_) => {}
            Err(e) => s.note = format!("the trash did not load: {e}"),
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
                if !away {
                    if let Some(name) = s.land.take() {
                        land_on(s, &name);
                    }
                }
                // the page that was open last run opens again, once
                if !s.restored && !away {
                    s.restored = true;
                    // the page held beside last run is held again, if it is still there
                    if s.names.contains(&s.prefs.split) {
                        s.split = Some(s.prefs.split.clone());
                    }
                    let last = s.prefs.last.clone();
                    if s.open.is_none() && !restore_tabs(s) && s.names.contains(&last) {
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
    changed |= take_pics(s);
    if changed {
        sync_map(s);
        sync_sheet(s);
        sync_pics(s);
        sync_tiles(s);
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
                // Ctrl-Return opens the page chosen in a new tab
                Key::Enter if ev.mods.cmd => {
                    if let Some(name) = hits.get(s.jump_at).map(|n| n.0.clone()) {
                        s.jump = None;
                        s.files.reveal(&name, tx);
                        open_in_tab(s, &name);
                    }
                }
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
            .on_middle_press({
                let pick = name.clone();
                move |s: &mut App, tx| {
                    s.jump = None;
                    s.files.reveal(&pick, tx);
                    open_in_tab(s, &pick);
                }
            })
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

/// What to say after an upload: how many pages, and the first few files left out.
fn upload_note(made: usize, skipped: &[String]) -> String {
    let pages = match made {
        0 => "nothing was uploaded".to_owned(),
        1 => "uploaded 1 page".to_owned(),
        n => format!("uploaded {n} pages"),
    };
    if skipped.is_empty() {
        return pages;
    }
    let shown = skipped.iter().take(4).cloned().collect::<Vec<_>>().join(", ");
    let more = if skipped.len() > 4 { format!(", and {} more", skipped.len() - 4) } else { String::new() };
    format!("{pages}. Left out {}: {shown}{more}", skipped.len())
}

/// The folder every one of these pages is under, or nothing.
fn common_folder(names: &[String]) -> String {
    let mut parts: Vec<&str> = names[0].split('/').collect();
    parts.pop();
    for n in &names[1..] {
        let other: Vec<&str> = n.split('/').collect();
        let same = parts.iter().zip(&other[..other.len() - 1]).take_while(|(a, b)| a == b).count();
        parts.truncate(same);
    }
    parts.join("/")
}

/// Saves the page in front to a file on this machine: its source as it
/// stands, with what is being typed if it is being edited.
fn ask_download(s: &mut App, tx: &mut Tx) {
    let Some(p) = &s.open else { return };
    let body = if s.editing { edited(s) } else { p.body.clone() };
    let name = upload::download_name(&p.name, &p.kind, s.memory);
    let options = rune::FileDialogOptions { title: "Download this page".into(), file_name: Some(name), ..Default::default() };
    tx.save_file(options, move |s: &mut App, result: rune::FileDialogResult, _: &mut Tx| match result {
        Ok(Some(path)) => write_file(s, path, body),
        Ok(None) => {}
        Err(e) => s.note = format!("no file dialog could open: {e}"),
    });
}

/// Exports the page in front as a PDF, as the ship renders it. The file
/// is named in the save dialog, and a headless Chromium or Chrome prints it.
fn ask_pdf(s: &mut App, tx: &mut Tx) {
    let (Some(p), Some(c)) = (s.open.clone(), s.conn.clone()) else {
        s.note = "PDF export prints the page as the ship renders it, so it needs a ship".into();
        return;
    };
    let Some(browser) = pdf::browser() else {
        s.note = "PDF export needs Chromium or Chrome installed: this app cannot print by itself".into();
        return;
    };
    let leaf = p.name.rsplit('/').next().unwrap_or(&p.name).to_owned();
    let title = s.dnames.get(&p.name).cloned().unwrap_or_else(|| leaf.clone());
    let options = rune::FileDialogOptions { title: "Export PDF".into(), file_name: Some(format!("{leaf}.pdf")), ..Default::default() }.filter("PDF", &["pdf"]);
    tx.save_file(options, move |s: &mut App, result: rune::FileDialogResult, _: &mut Tx| match result {
        Ok(Some(path)) => {
            s.note = format!("printing {} to {}", p.name, path.display());
            s.op_req.request((c, p, browser, title, path), |(c, p, browser, title, path)| {
                // what the ship's preview shows, or the source for a kind it does not render
                let html = c.rendered(&p.name).unwrap_or_default();
                let body = if html.trim().is_empty() { pdf::source(&p.body) } else { html };
                Ok(Op::Said(match pdf::print(&browser, &pdf::document(&title, &body), &path) {
                    Ok(()) => format!("exported to {}", path.display()),
                    Err(e) => format!("not exported: {e}"),
                }))
            });
        }
        Ok(None) => {}
        Err(e) => s.note = format!("no file dialog could open: {e}"),
    });
}

/// Converts the LaTeX page in front to an html page beside it, with the
/// pandoc on this machine. The output is cleaned before it is kept, and
/// writes over the last conversion.
fn convert_tex(s: &mut App) {
    let Some(p) = s.open.clone().filter(|p| p.kind == "tex") else {
        s.note = "only a LaTeX page converts".into();
        return;
    };
    let src = if s.editing { edited(s) } else { p.body.clone() };
    let conn = s.conn.clone();
    s.note = "converting with pandoc".into();
    s.op_req.request((conn, p.name, src), |(conn, name, src)| {
        let Some(exe) = tex::locate() else {
            return Ok(Op::Said("converting LaTeX needs pandoc, which is not installed on this machine. It is at pandoc.org".into()));
        };
        let html = match tex::convert(&exe, &src) {
            Ok(h) => h,
            Err(e) => return Ok(Op::Said(format!("pandoc: {}", e.chars().take(160).collect::<String>()))),
        };
        let out = Page { name: tex::out_name(&name), body: tex::page(&name, &html), kind: "html".into(), rev: 1 };
        let say = format!("wrote {}", out.name);
        match conn {
            Some(c) => {
                // a base of 0 makes it or writes over it: a conversion replaces the last one
                c.save(&out, 0)?;
                Ok(Op::Wrote(out.name, None, say))
            }
            None => Ok(Op::Wrote(out.name.clone(), Some(out), say)),
        }
    });
}

/// Writes a file off the window's thread and says how it went.
fn write_file(s: &mut App, path: std::path::PathBuf, body: impl Into<Vec<u8>>) {
    s.op_req.request((path, body.into()), |(path, body)| {
        Ok(Op::Said(match std::fs::write(&path, body) {
            Ok(()) => format!("saved to {}", path.display()),
            Err(e) => format!("not saved to {}: {e}", path.display()),
        }))
    });
}

/// Where an upload lands: the folder showing, or the top.
fn upload_dir(s: &App) -> String {
    match (&s.folder, &s.open) {
        (Some(f), None) => f.clone(),
        _ => String::new(),
    }
}

/// Asks for a file or a folder and uploads the text files in it as pages.
fn ask_upload(s: &mut App, folder: bool, tx: &mut Tx) {
    if s.editing {
        return;
    }
    if s.memory {
        flip(s);
    }
    let options = rune::FileDialogOptions { title: if folder { "Upload a folder" } else { "Upload a file" }.into(), ..Default::default() };
    let answer = |s: &mut App, result: rune::FileDialogResult, _: &mut Tx| match result {
        Ok(Some(path)) => upload(s, vec![path]),
        Ok(None) => {}
        Err(e) => s.note = format!("no file dialog could open: {e}"),
    };
    if folder {
        tx.open_folder(options, answer);
    } else {
        tx.open_file(options.filter("Pages", &["md", "gmi", "html", "htm", "txt", "text", "js", "css", "hoon", "tex", "latex", "fodt", "fods", "geojson", "scad", "csv", "odt", "ods"]), answer);
    }
}

/// Reads the picked file or folder and saves its pages, off the window's thread.
fn upload(s: &mut App, paths: Vec<std::path::PathBuf>) {
    if s.editing || paths.is_empty() {
        return;
    }
    if s.memory {
        flip(s);
    }
    let dir = upload_dir(s);
    s.dropping = false;
    s.note = match paths.as_slice() {
        [one] => format!("reading {}", one.display()),
        many => format!("reading {} files", many.len()),
    };
    match s.conn.clone() {
        Some(c) => s.op_req.request((c, paths, dir), |(c, paths, dir)| {
            let plan = upload::read_all(&paths, &dir);
            let made: Vec<String> = plan.items.iter().map(|i| i.name.clone()).collect();
            let items: Vec<(String, &str, String)> = plan.items.into_iter().map(|i| (i.name, i.kind, i.body)).collect();
            // fifty to a request, as the web client sends them: each is all or nothing
            for part in items.chunks(50) {
                c.save_batch(part)?;
            }
            Ok(Op::Uploaded(made, plan.skipped))
        }),
        // sample pages: kept for the session
        None => {
            let plan = upload::read_all(&paths, &dir);
            let made: Vec<String> = plan.items.iter().map(|i| i.name.clone()).collect();
            for i in plan.items {
                if !s.names.contains(&i.name) {
                    s.names.push(i.name.clone());
                }
                s.cache.insert(i.name.clone(), Page { name: i.name, body: i.body, kind: i.kind.into(), rev: 1 });
            }
            applied(s, Op::Uploaded(made, plan.skipped));
            if let Some(name) = s.land.take() {
                land_on(s, &name);
            }
        }
    }
}

/// Shows what a template made: the page of that name, or the index of
/// the folder it made, or the folder.
fn land_on(s: &mut App, name: &str) {
    let index = format!("{name}/index");
    if s.names.iter().any(|n| n == name) {
        s.files.select(name);
        open_page(s, name);
    } else if s.names.contains(&index) {
        s.files.select(&index);
        open_page(s, &index);
    } else if !under(&s.names, name).is_empty() {
        (s.open, s.remote, s.access, s.shared_open, s.inbox) = (None, None, false, false, false);
        s.folder = Some(name.to_owned());
    }
}

/// Opens the template dialog, with the name seeded by where a new page would go.
fn ask_template(s: &mut App) {
    if s.editing {
        return;
    }
    if s.memory {
        flip(s);
    }
    let dir = match (&s.folder, &s.open) {
        (Some(f), None) => format!("{f}/"),
        _ => String::new(),
    };
    let chosen = s.templates.first().cloned().unwrap_or_default();
    let mut name = TextEdit::new(format!("{dir}{chosen}"));
    name.focused = true;
    s.tmpl = Some((chosen, name));
    match s.conn.clone() {
        Some(c) => s.templates_req.request(c, |c| c.templates()),
        // sample pages: two to choose from, each a single page
        None if s.templates.is_empty() => {
            s.templates = vec!["note".into(), "site".into()];
            s.tmpl = Some(("note".into(), TextEdit::new(format!("{dir}note"))));
        }
        None => {}
    }
}

/// Makes what the template dialog describes.
fn make_from_template(s: &mut App) {
    let Some((chosen, name)) = &s.tmpl else { return };
    if chosen.is_empty() {
        s.note = "there is no template to start from".into();
        return;
    }
    let Some(rn) = api::real_name(&name.text) else {
        s.note = "that name has nothing a path can keep".into();
        return;
    };
    if s.names.contains(&rn.name) {
        s.note = "a page by that name exists".into();
        return;
    }
    let chosen = chosen.clone();
    s.dnames.extend(rn.shown());
    match s.conn.clone() {
        Some(c) => {
            s.note = format!("making {} from {chosen}, one save for each page", rn.name);
            s.op_req.request((c, chosen, rn), |(c, t, rn)| {
                c.template_new(&t, &rn)?;
                Ok(Op::Templated(rn.name))
            });
        }
        None => {
            s.tmpl = None;
            applied(s, Op::Created(rn.name));
        }
    }
}

fn template_view(s: &App, k: &Kit, layer: &mut Vec<El>) {
    let Some((chosen, name)) = &s.tmpl else { return };
    let mut pick = row().key("tmpl-list").w_full().gap(4.0).wrap();
    for t in &s.templates {
        let to = t.clone();
        pick = pick.child(Button::new(t.clone()).control_size(ControlSize::Small).variant(if t == chosen { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| {
            if let Some((chosen, name)) = s.tmpl.as_mut() {
                // a name still as it was seeded follows the template chosen
                if name.text.rsplit('/').next() == Some(chosen.as_str()) {
                    let dir = name.text[..name.text.len() - chosen.len()].to_owned();
                    *name = TextEdit::new(format!("{dir}{to}"));
                    name.focused = true;
                }
                *chosen = to.clone();
            }
        }).build(k).key(format!("tmpl-{t}")));
    }
    if s.templates.is_empty() {
        pick = pick.child(text(if s.templates_req.is_pending() { "Reading the templates" } else { "The ship has no templates." }).font(k.ty.small).color(k.c.text_muted));
    }
    let field = TextInput::new(name).label("Name").placeholder("folder/name").on_edit(|s: &mut App| &mut s.tmpl.as_mut().expect("the template dialog is open").1).on_submit(|s: &mut App, _| make_from_template(s)).build(k).w_full().key("tmpl-name");
    let busy = s.op_req.is_pending();
    let buttons = row()
        .w_full()
        .gap(8.0)
        .justify_end()
        .child(Button::new("Cancel").variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.tmpl = None).build(k).key("tmpl-cancel"))
        .child(Button::new(if busy { "Making" } else { "Create" }).variant(ButtonVariant::Contrast).disabled(busy || chosen.is_empty()).on_press(make_from_template).build(k).key("tmpl-ok"));
    Dialog::new("template", "New from a template")
        .open(true)
        .width(460.0)
        .fit()
        .on_close(|s: &mut App| s.tmpl = None)
        .child(col().w_full().gap(14.0).child(pick).child(field).child(text("A template can make several pages, with one save for each, so it takes a moment.").font(k.ty.small).color(k.c.text_muted).wrap()).child(buttons))
        .build(k, layer);
}

/// Holds the page in front beside whatever comes next, or lets go of
/// the one held.
fn toggle_split(s: &mut App) {
    s.split = match (&s.split, s.open.as_ref().filter(|_| s.remote.is_none() && !s.capture && !s.memory)) {
        (None, Some(p)) => Some(p.name.clone()),
        _ => None,
    };
    keep_split(s);
}

/// Notes the page held beside in the preferences, to hold again next run.
fn keep_split(s: &mut App) {
    sync_beside(s);
    let held = s.split.clone().unwrap_or_default();
    if s.prefs.split != held {
        s.prefs.split = held;
        if s.conn.is_some() {
            s.prefs.save();
        }
    }
}

/// Brings the page held beside to the front, and holds the one that was there.
fn swap_split(s: &mut App) {
    if s.editing {
        return;
    }
    let Some(name) = s.split.take() else { return };
    s.split = s.open.as_ref().filter(|p| s.remote.is_none() && p.name != name).map(|p| p.name.clone());
    if s.names.contains(&name) {
        s.files.select(&name);
        open_page(s, &name);
    }
    keep_split(s);
}

/// The sheet held beside, to be read: its cells as they read, a tab for
/// each sheet, and no cell bar. It is changed from the front.
fn beside_sheet(sheets: &[sheet::Sheet], at: usize, s: &App, k: &Kit) -> El {
    let c = &k.c;
    fn grid_of(s: &App) -> Option<&sheet::Sheet> {
        match &s.beside {
            Some((_, _, Beside::Sheet(sheets, at, _))) => sheets.get(*at),
            _ => None,
        }
    }
    let mut table = Table::new(
        |s: &App| match &s.beside {
            Some((_, _, Beside::Sheet(_, _, table))) => table,
            _ => unreachable!("a sheet is held beside"),
        },
        |s: &mut App| match &mut s.beside {
            Some((_, _, Beside::Sheet(_, _, table))) => table,
            _ => unreachable!("a sheet is held beside"),
        },
        |s: &App| grid_of(s).map_or(0, |sh| sh.rows.len()),
        |_: &App, i| std::borrow::Cow::Owned(i.to_string()),
    )
    .name("The sheet held beside")
    .column(TableColumn::new("#", "").width(48.0).resizable(false));
    for i in 0..sheets[at].width().clamp(1, SHEET_COLS) {
        table = table.column(TableColumn::new(sheet::column_name(i), sheet::column_name(i)).width(110.0).min(48.0).max(600.0));
    }
    let grid = table
        .cell(move |s: &App, i, col| {
            if col == "#" {
                return Cell::text((i + 1).to_string()).muted().mono();
            }
            let at = col.bytes().fold(0usize, |n, b| n * 26 + (b - b'A') as usize + 1) - 1;
            Cell::text(grid_of(s).and_then(|sh| sh.rows.get(i)).and_then(|r| r.get(at)).cloned().unwrap_or_default())
        })
        .zebra(true)
        .build(s, k)
        .key("split-sheet")
        .w_full()
        .h(420.0);
    let mut tabs = row().key("split-sheet-tabs").gap(4.0).center_y();
    for (i, sh) in sheets.iter().enumerate() {
        tabs = tabs.child(
            Button::new(if sh.name.is_empty() { format!("Sheet {}", i + 1) } else { sh.name.clone() })
                .control_size(ControlSize::Small)
                .variant(if i == at { ButtonVariant::Contrast } else { ButtonVariant::Ghost })
                .on_press(move |s: &mut App| {
                    if let Some((_, _, Beside::Sheet(_, at, table))) = &mut s.beside {
                        (*at, *table) = (i, TableState::new());
                    }
                })
                .build(k)
                .key(format!("split-sheet-{i}")),
        );
    }
    col().key("split-sheet-view").w_full().gap(8.0).child(grid).child(tabs.child(text(format!("{} rows", sheets[at].rows.len())).font(k.ty.small).color(c.text_muted).pl(8.0)))
}

/// The map held beside, to be read: every feature, fitted to the
/// picture, in its own colour. It is moved and changed from the front.
fn beside_map(feats: &[map::Feature], k: &Kit) -> El {
    let c = &k.c;
    let (w, h) = (520.0f32, 340.0f32);
    let cam = map::Camera::fit(feats.iter(), w, h);
    let to = |p: map::P| cam.project(p, w, h);
    let mut shape = Shape::new();
    let mut dots = Vec::new();
    for f in feats {
        let ink = rune::color::hex(&f.color).unwrap_or(c.text_accent);
        for g in &f.geoms {
            match g {
                map::Geom::Point(p) => dots.push((to(*p), ink)),
                map::Geom::Line(l) => shape = shape.stroke(map::thin(l, MAP_LINE).into_iter().map(to).collect::<Vec<_>>(), 2.5, ink),
                map::Geom::Area(l) => {
                    let ring: Vec<[f32; 2]> = map::thin(l, MAP_LINE).into_iter().map(to).collect();
                    shape = shape.fill(ring.clone(), ink.alpha(0.12)).stroke(ring, 2.0, ink);
                }
            }
        }
    }
    // points over the lines and areas, each a small round mark
    for ([x, y], ink) in dots {
        let ring: Vec<[f32; 2]> = (0..16).map(|i| (i as f32) * std::f32::consts::TAU / 16.0).map(|a| [x + 5.0 * a.cos(), y + 5.0 * a.sin()]).collect();
        shape = shape.fill(ring.clone(), ink).stroke(ring, 1.0, c.bg_base);
    }
    let said = format!("{} feature{}", feats.len(), if feats.len() == 1 { "" } else { "s" });
    col()
        .key("split-map-view")
        .gap(6.0)
        .child(el().size(w, h).radius(k.radius.md).fill(c.layer_01).child(canvas(shape).key("split-map").absolute(0.0, 0.0).size(w, h)))
        .child(text(said).font(k.ty.small).color(c.text_muted))
}

/// The page held beside: read-only. A sheet shows as its grid, a map as
/// its shapes, an HTML or gemtext page as it is read, and any other
/// kind as its source, coloured.
fn split_view(name: &str, s: &App, k: &Kit) -> El {
    let c = &k.c;
    let title = s.dnames.get(name).cloned().unwrap_or_else(|| name.to_owned());
    let head = row()
        .w_full()
        .gap(6.0)
        .center_y()
        .child(text(title).font(k.ty.small_medium).color(c.text_muted).grow(1.0).min_w(0.0).truncate())
        .child(Button::new("Swap").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Bring this page to the front").disabled(s.editing).on_press(swap_split).build(k).key("split-swap"))
        .child(Button::new("×").control_size(ControlSize::Small).variant(ButtonVariant::GhostFaint).help("Close the split").on_press(|s: &mut App| {
            s.split = None;
            keep_split(s);
        }).build(k).key("split-close"));
    let beside = s.cache.get(name).and_then(|p| s.beside.as_ref().filter(|(n, rev, _)| *n == p.name && *rev == p.rev)).map(|(_, _, v)| v);
    let shown = match (s.cache.get(name), beside) {
        (Some(p), _) if p.kind == "md" => reader(&p.body, s, k, false),
        (_, Some(Beside::Read(md))) => reader(md, s, k, false),
        (_, Some(Beside::Sheet(sheets, at, _))) => beside_sheet(sheets, *at, s, k),
        (_, Some(Beside::Map(feats))) => beside_map(feats, k),
        // any other kind is its source, coloured
        (Some(p), None) => {
            let shown = source_shown(&p.body);
            rune::rich(shown.to_owned(), code_spans(&p.kind, shown, k)).font(k.ty.mono).color(c.text_base).wrap().selectable(true)
        }
        (None, _) => text("This page is not here any more.").font(k.ty.small).color(c.text_muted),
    };
    col()
        .key("split")
        .w_full()
        .h_full()
        .min_h(0.0)
        .child(col().w_full().px(16.0).pt(8.0).child(head))
        .child(col().w_full().grow(1.0).min_h(0.0).child(col().w_full().padding(16.0).child(shown)).scroll(ScrollSpec { stick_bottom: false }))
}

/// Notes the tabs' pages in the preferences, to open again next run.
fn keep_tabs(s: &mut App) {
    let front = s.open.as_ref().filter(|_| s.remote.is_none() && !s.capture && !s.memory).map(|p| p.name.clone());
    let pages: Vec<String> = (0..s.tabs.len()).map(|i| if i == s.tab { front.clone() } else { s.tabs[i].page().map(str::to_owned) }.unwrap_or_default()).collect();
    if s.prefs.tabs != pages || s.prefs.tab != s.tab {
        (s.prefs.tabs, s.prefs.tab) = (pages, s.tab);
        if s.conn.is_some() {
            s.prefs.save();
        }
    }
}

/// Opens the tabs kept from the last run, each on its page if the page
/// is still there. `false` when there was one tab or none, which the
/// page opened last covers.
fn restore_tabs(s: &mut App) -> bool {
    if s.prefs.tabs.len() < 2 {
        return false;
    }
    s.tabs = s.prefs.tabs.iter().map(|n| if s.names.contains(n) { Tab { trail: vec![n.clone()], at: 0 } } else { Tab::default() }).collect();
    s.tab = s.prefs.tab.min(s.tabs.len() - 1);
    let Tab { trail, at } = std::mem::take(&mut s.tabs[s.tab]);
    (s.trail, s.trail_at) = (trail, at);
    if let Some(name) = s.trail.first().cloned() {
        s.files.expand_to(&name);
        s.files.select(&name);
        show_page(s, &name);
    }
    true
}

/// Opens a page in a new tab, in front.
fn open_in_tab(s: &mut App, name: &str) {
    if s.editing {
        return;
    }
    new_tab(s);
    open_page(s, name);
}

/// Puts the tab in front away, as it stands.
fn park_tab(s: &mut App) {
    // a tab on a folder or a screen has no page of its own to come back to
    let on_page = s.open.is_some() && s.remote.is_none() && !s.capture;
    s.tabs[s.tab] = if on_page { Tab { trail: std::mem::take(&mut s.trail), at: s.trail_at } } else { Tab::default() };
}

/// Brings a tab forward. A page it held that is gone leaves it empty.
fn switch_tab(s: &mut App, to: usize) {
    if s.editing || to == s.tab || to >= s.tabs.len() {
        return;
    }
    if s.memory {
        flip(s);
    }
    park_tab(s);
    s.tab = to;
    let Tab { trail, at } = std::mem::take(&mut s.tabs[to]);
    (s.trail, s.trail_at) = (trail, at);
    (s.open, s.folder, s.remote, s.old, s.want) = (None, None, None, None, None);
    (s.access, s.shared_open, s.inbox) = (false, false, false);
    match s.trail.get(s.trail_at).cloned() {
        Some(name) if s.names.contains(&name) => {
            s.files.expand_to(&name);
            s.files.select(&name);
            show_page(s, &name);
        }
        _ => {
            s.trail.clear();
            s.trail_at = 0;
        }
    }
    keep_tabs(s);
}

/// A new, empty tab, in front.
fn new_tab(s: &mut App) {
    if s.editing {
        return;
    }
    s.tabs.push(Tab::default());
    let to = s.tabs.len() - 1;
    switch_tab(s, to);
}

/// Closes a tab. The last one stays.
fn close_tab(s: &mut App, i: usize) {
    if s.editing || s.tabs.len() < 2 || i >= s.tabs.len() {
        return;
    }
    if i == s.tab {
        // its neighbour comes forward first
        switch_tab(s, if i + 1 < s.tabs.len() { i + 1 } else { i - 1 });
    }
    s.tabs.remove(i);
    if s.tab > i {
        s.tab -= 1;
    }
    keep_tabs(s);
}

/// What a tab is called: its page's last name, or that it is empty.
fn tab_label(s: &App, i: usize) -> String {
    let name = if i == s.tab { s.open.as_ref().filter(|_| s.remote.is_none()).map(|p| p.name.as_str()) } else { s.tabs[i].page() };
    name.map_or("New tab".to_owned(), |n| s.dnames.get(n).cloned().unwrap_or_else(|| n.rsplit('/').next().unwrap_or(n).to_owned()))
}

/// The tabs, shown once there is more than one.
fn tab_strip(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let mut strip = row().key("tabs").w_full().gap(2.0).px(8.0).pt(4.0).center_y();
    for i in 0..s.tabs.len() {
        let front = i == s.tab;
        strip = strip.child(
            row()
                .key(format!("tab-{i}"))
                .center_y()
                .radius(k.radius.sm)
                .fill(if front { c.layer_01 } else { rune::Color::TRANSPARENT })
                .child(Button::new(tab_label(s, i)).control_size(ControlSize::Small).variant(if front { ButtonVariant::Ghost } else { ButtonVariant::GhostMuted }).on_press(move |s: &mut App| switch_tab(s, i)).build(k).key(format!("tab-open-{i}")).max_w(180.0))
                .child(Button::new("×").control_size(ControlSize::Small).variant(ButtonVariant::GhostFaint).help("Close this tab").on_press(move |s: &mut App| close_tab(s, i)).build(k).key(format!("tab-close-{i}"))),
        );
    }
    strip
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
    ("template", "New from a template"),
    ("upload", "Upload a file as a page"),
    ("upload-folder", "Upload a folder of files as pages"),
    ("capture", "Capture a page to the inbox"),
    ("today", "Today's journal page"),
    ("open", "Open a page"),
    ("tab", "New tab"),
    ("tab-copy", "Open this page in a new tab"),
    ("tab-close", "Close this tab"),
    ("split", "Split: hold this page beside, or close the split"),
    ("edit", "Edit"),
    ("rename", "Rename or move"),
    ("delete", "Delete"),
    ("share", "Share"),
    ("duplicate", "Duplicate this page"),
    ("copy-link", "Copy a link to this page"),
    ("copy-name", "Copy this page's name"),
    ("download", "Download this page as a file"),
    ("pdf", "Export this page as PDF"),
    ("tex", "Convert this LaTeX page to HTML"),
    ("map-base", "Map: next base map"),
    ("map-token", "Map: set the ship's Mapbox token"),
    ("map-import", "Map: import a GPX, KML or GeoJSON file"),
    ("map-gpx", "Map: download as GPX"),
    ("find", "Find in this page"),
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
        "download" | "copy-name" => page,
        "duplicate" | "copy-link" | "pdf" => own && !s.memory && !s.editing,
        "tex" => own && !s.memory && s.open.as_ref().is_some_and(|p| p.kind == "tex"),
        "rename" | "share" | "links" | "comments" | "history" => own && !s.memory,
        "find" => page && find_where(s) != FindIn::Nothing,
        "reload" | "map-token" => s.conn.is_some(),
        "map-base" => own && !s.editing && s.map.as_ref().is_some_and(|m| s.open.as_ref().is_some_and(|p| p.name == m.name)),
        "map-import" => map_changes(s),
        "map-gpx" => page && s.map.is_some(),
        "tab-close" => s.tabs.len() > 1,
        "tab-copy" => own && !s.memory,
        "split" => s.split.is_some() || (own && !s.memory),
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
        "template" => ask_template(s),
        "upload" => ask_upload(s, false, tx),
        "upload-folder" => ask_upload(s, true, tx),
        "capture" => {
            capture(s);
            tx.focus_when_shown(FIELD, false);
        }
        "today" => {
            open_today(s);
            if s.editing {
                tx.focus_when_shown(FIELD, false);
            }
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
        "tab" => new_tab(s),
        "split" => toggle_split(s),
        "tab-copy" => {
            if let Some(name) = s.open.as_ref().map(|p| p.name.clone()) {
                open_in_tab(s, &name);
            }
        }
        "tab-close" => close_tab(s, s.tab),
        "rename" => ask_rename(s),
        "delete" => ask_delete(s),
        "share" => open_share(s),
        "download" => ask_download(s, tx),
        "pdf" => ask_pdf(s, tx),
        "tex" => convert_tex(s),
        "duplicate" => ask_duplicate(s),
        "copy-link" => {
            if let Some(link) = page_link(s) {
                tx.copy(link.clone());
                s.note = format!("link copied: {link}");
            }
        }
        "copy-name" => {
            if let Some(name) = s.open.as_ref().map(|p| p.name.clone()) {
                tx.copy(name.clone());
                s.note = format!("name copied: {name}");
            }
        }
        "map-base" => next_base(s),
        "map-token" => ask_token(s),
        "map-import" => ask_map_import(s, tx),
        "map-gpx" => ask_gpx(s, tx),
        "find" => open_find(s),
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

/// The line under the editor: the pages offered for a wiki link being
/// typed. It is always there, so nothing moves when offers come and go.
fn offers_bar(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let mut bar = row().key("link-offers").w_full().h(28.0).gap(4.0).center_y();
    let Some((start, offers)) = link_offers(s) else { return bar };
    let at = s.ac_at.min(offers.len() - 1);
    for (i, name) in offers.iter().enumerate() {
        let pick = name.clone();
        let label = if ghost(s, name) { format!("{name}  (not written)") } else { name.clone() };
        bar = bar.child(Button::new(label).control_size(ControlSize::Small).variant(if i == at { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press_tx(move |s: &mut App, tx| {
            accept_link(s, start, &pick);
            tx.focus_when_shown(FIELD, false);
        }).build(k).key(format!("offer-{i}")));
    }
    bar.child(text("Tab to complete, arrows to choose, Esc to dismiss").font(k.ty.small).color(c.text_faint).grow(1.0).min_w(0.0).truncate())
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

/// One of the open feature prompt's fields: its name, kind or note.
fn feature_field(s: &mut App, i: usize) -> &mut TextEdit {
    match s.prompt.as_mut().expect("a prompt is open") {
        Prompt::Feature(_, t) => &mut t[i],
        _ => unreachable!("the feature prompt is open"),
    }
}

fn prompt_view(s: &App, k: &Kit, layer: &mut Vec<El>) {
    let Some(p) = &s.prompt else { return };
    let field = |t: &TextEdit, hint: &str| {
        TextInput::new(t)
            .placeholder(hint)
            .on_edit(|s: &mut App| match s.prompt.as_mut().expect("a prompt is open") {
                Prompt::New(t) | Prompt::Rename(_, t) | Prompt::Link(t) | Prompt::Ask(_, t) | Prompt::Duplicate(_, t) | Prompt::Token(t) | Prompt::Param(_, _, t) | Prompt::Tag(t) => t,
                Prompt::Delete(_) | Prompt::Feature(..) => unreachable!("it has no field of this kind"),
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
        Prompt::Duplicate(_, t) => ("Duplicate this page as", field(t, "folder/name"), "Duplicate", ButtonVariant::Contrast),
        // kept on the ship, which never shows it again. Typed in the clear here: it is pasted, not remembered
        Prompt::Tag(t) => ("Tag this memory", field(t, "a tag"), "Tag", ButtonVariant::Contrast),
        Prompt::Param(_, _, t) => ("Set this parameter", field(t, "A value"), "Set", ButtonVariant::Contrast),
        Prompt::Token(t) => ("The ship's Mapbox token", field(t, "pk... to set it, or nothing to clear it"), "Set", ButtonVariant::Contrast),
        Prompt::Feature(at, t) => {
            // only a point has a ring round it
            let point = s.map.as_ref().and_then(|m| m.feats.iter().find(|f| f.at == *at)).is_some_and(|f| f.geoms.iter().all(|g| matches!(g, map::Geom::Point(_))));
            let line = |i: usize, label: &str, hint: &str, key: &str| TextInput::new(&t[i]).label(label).placeholder(hint).on_edit(move |s: &mut App| feature_field(s, i)).on_submit(|s: &mut App, _| confirm(s)).build(k).w_full().key(key.to_owned());
            let body = col()
                .w_full()
                .gap(10.0)
                .child(TextInput::new(&t[0]).label("Name").placeholder("Name").on_edit(|s: &mut App| feature_field(s, 0)).on_submit(|s: &mut App, _| confirm(s)).build(k).w_full().key("prompt-field"))
                .child(TextInput::new(&t[1]).label("Kind").placeholder("place, report, person...").on_edit(|s: &mut App| feature_field(s, 1)).on_submit(|s: &mut App, _| confirm(s)).build(k).w_full().key("feature-kind"))
                .child(TextArea::new(&t[2]).label("Note (markdown)").placeholder("A note, in markdown").rows(4).on_edit(|s: &mut App| feature_field(s, 2)).build(k).w_full().key("feature-note"))
                .child(line(3, "Time", "Time, as 2026-11-17T09:30:00Z", "feature-time"))
                .child(line(4, "Source", "Source: a URL or a page", "feature-source"))
                .children(point.then(|| line(5, "Ring radius, metres", "Ring radius, in metres", "feature-radius")));
            ("This feature", body, "Save", ButtonVariant::Contrast)
        }
        Prompt::Delete(n) => {
            let held = under(&s.names, n).len();
            let (ask, says) = if s.names.contains(n) { ("Delete this page?", n.clone()) } else { ("Delete this folder?", format!("{n} and the {held} pages in it")) };
            (ask, text(says).font(k.ty.ui).color(k.c.text_muted).wrap(), "Delete", ButtonVariant::Danger)
        }
    };
    let mut buttons = row().w_full().gap(8.0).justify_end();
    if matches!(p, Prompt::New(_)) && !s.memory {
        buttons = buttons.child(Button::new("Upload").variant(ButtonVariant::Ghost).help("Make pages from a file on this machine").on_press_tx(|s: &mut App, tx| {
            s.prompt = None;
            ask_upload(s, false, tx);
        }).build(k).key("prompt-upload"));
        buttons = buttons.child(Button::new("From a template").variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
            s.prompt = None;
            ask_template(s);
        }).build(k).key("prompt-template"));
    }
    let buttons = buttons
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

/// Asks for a name for a copy of the page in front: the same kind and
/// text, with what is being typed if it is being edited.
fn ask_duplicate(s: &mut App) {
    let Some(p) = &s.open else { return };
    let body = if s.editing { edited(s) } else { p.body.clone() };
    let mut t = TextEdit::new(format!("{}-copy", p.name));
    t.focused = true;
    s.prompt = Some(Prompt::Duplicate(Page { body, ..p.clone() }, t));
}

/// The link to a page of this ship that another ship follows, and its name.
fn page_link(s: &App) -> Option<String> {
    let p = s.open.as_ref()?;
    let ship = s.conn.as_ref().map_or("~sampel-palnet".to_owned(), |c| c.ship().to_owned());
    Some(format!("urb://{ship}/{}", p.name))
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
        .on_change(|s: &mut App, _| refilter(s))
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
    }).build(k).key("capture")).child(Button::new("Today").variant(ButtonVariant::Ghost).help("Today's journal page").on_press_tx(|s: &mut App, tx| {
        open_today(s);
        if s.editing {
            tx.focus_when_shown(FIELD, false);
        }
    }).build(k).key("today")).child(new);
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
    // the memories' tags, to show only those that carry one: said even when folded away, as on the web
    let mut chips = row().key("know-tags").w_full().gap(2.0).flex_wrap();
    let tags = if s.memory { know_tags(s) } else { Vec::new() };
    if !tags.is_empty() {
        let chip = |label: String, val: Option<String>, key: String| {
            let on = s.know_tag == val;
            Button::new(label).control_size(ControlSize::Small).variant(if on { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| {
                s.know_tag = val.clone();
                refilter(s);
            }).build(k).key(key)
        };
        chips = chips.child(chip("all".into(), None, "ktag-all".into()));
        for t in &tags {
            chips = chips.child(chip(format!("#{t}"), Some(t.clone()), format!("ktag-{t}")));
        }
    }
    // the trash: the deleted memories the ship still holds, each to be brought back
    let trash_toggle = Button::new("Trash").control_size(ControlSize::Small).variant(if s.trash.is_some() { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).help("Deleted memories, to bring back").on_press(|s: &mut App| {
        s.trash = if s.trash.is_some() { None } else { Some(None) };
        load_trash(s);
    }).build(k).key("trash-toggle");
    let trash = s.trash.as_ref().filter(|_| s.memory).map(|held| {
        let mut list = col().key("trash").w_full().gap(2.0).padding(6.0).radius(k.radius.md).fill(k.c.layer_01);
        match held {
            None => list = list.child(text("loading trash\u{2026}").font(k.ty.small).color(k.c.text_muted)),
            Some(keys) => {
                list = list.child(text(format!("trash \u{b7} {}", keys.len())).font(k.ty.small_medium).color(k.c.text_muted));
                if keys.is_empty() {
                    list = list.child(text("nothing in the trash").font(k.ty.small).color(k.c.text_muted));
                }
                // a long trash is not drawn to its end
                for key in keys.iter().take(200) {
                    let name = key.clone();
                    list = list.child(row().w_full().gap(6.0).center_y().child(text(key.clone()).font(k.ty.small).color(k.c.text_base).grow(1.0).min_w(0.0).truncate()).child(Button::new("Restore").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| restore_memory(s, name.clone())).build(k).key(format!("restore-{key}"))));
                }
            }
        }
        list
    });
    let mut side = col().key("pages").w_full().h_full().min_h(0.0).padding(8.0).gap(8.0).child(halves).child(filter).children((!tags.is_empty()).then_some(chips)).child(new).child(tree).children(trash).children(s.memory.then_some(row().child(trash_toggle))).child(row().gap(4.0).child(with_me).child(inbox)).child(foot);
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
            let newest = if s.memory { revs.iter().map(|r| r.rev).max().unwrap_or(0) } else { s.open.as_ref().map_or(0, |p| p.rev) };
            let shown = s.old.as_ref().map_or(newest, |o| o.rev);
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
                .child(text(format!("Reading revision {}, not the {} as it is now", o.rev, if s.memory { "memory" } else { "page" })).font(k.ty.small).color(k.c.text_base).grow(1.0))
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
    } else if let Some(q) = s.find.as_ref().filter(|_| !s.access && !s.shared_open && !s.inbox && s.folder.is_none() && find_where(s) != FindIn::Nothing) {
        Some(find_bar(q, s, k))
    } else if held_back(s) > 0 && !s.access && !s.shared_open && !s.inbox && s.folder.is_none() {
        let n = held_back(s);
        Some(banner(
            "outside",
            format!("{} from another site {} not loaded. Loading {} tells that site your address.", if n == 1 { "An image".to_owned() } else { format!("{n} images") }, if n == 1 { "is" } else { "are" }, if n == 1 { "it" } else { "them" }),
            "Load outside content for this page",
            |s| {
                if let Some(name) = s.open.as_ref().map(|p| p.name.clone()) {
                    s.prefs.allow_outside(&name);
                    if s.conn.is_some() {
                        s.prefs.save();
                    }
                    sync_pics(s);
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
            .decorations({
                let mut spans = rich_spans(&s.edit, k);
                spans.extend(find_spans(s, k));
                spans
            })
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
            .child(col().w_full().max_w(820.0).h_full().min_h(0.0).padding(16.0).gap(8.0).child(format_bar(s, k)).child(Divider::horizontal().build(k)).child(field).child(offers_bar(s, k)));
    }
    if s.editing {
        // the source, coloured as Markdown: colour only, so nothing moves as it is typed
        let mut marks = code_spans(&p.kind, &s.edit.text, k);
        marks.extend(find_spans(s, k));
        let source = TextArea::new(&s.edit).label("Page source").decorations(marks).on_edit(|s: &mut App| &mut s.edit).on_key(editor_key).build(k).key(FIELD).w_full().h_full().min_h(0.0);
        let mut panes = row().key("editor").w_full().h_full().min_h(0.0).padding(16.0).gap(16.0).child(col().grow(1.0).h_full().min_h(0.0).child(source).child(offers_bar(s, k)));
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
        return map_view(m, s, k);
    }
    let shown = if let Some(body) = read_md(s, p) {
        reader(body, s, k, true)
    } else {
        // other kinds draw as their source, coloured, until each has a native view
        let shown = source_shown(&p.body);
        let mut spans = code_spans(&p.kind, shown, k);
        if s.find.is_some() && !s.memory {
            spans.extend(source_matches(s).into_iter().enumerate().map(|(i, r)| Span::new(r.start, r.end).bg(k.c.text_accent.alpha(if i == s.find_at { 0.55 } else { 0.22 }), 1.0)));
        }
        rune::rich(shown.to_owned(), spans).font(k.ty.mono).color(c.text_base).wrap().selectable(true)
    };
    let mut page = col().w_full().max_w(760.0).padding(28.0).gap(12.0);
    if let Some((tags, updated)) = s.know_meta.get(&p.name).filter(|_| s.memory) {
        let when = Rev { rev: 0, updated: updated.clone() }.when();
        let mut meta = row().key("know-meta").gap(6.0).center_y().child(text(when).font(k.ty.small).color(c.text_faint));
        let mut sorted = tags.clone();
        sorted.sort();
        // a tag is pressed to take it off, and one is added from the button after them
        for t in sorted {
            let tag = t.clone();
            meta = meta.child(Button::new(format!("#{t} \u{d7}")).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Take this tag off").on_press(move |s: &mut App| set_tag(s, tag.clone(), false)).build(k).key(format!("tag-{t}")));
        }
        meta = meta.child(Button::new("+ tag").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help("Put a tag on this memory").on_press(|s: &mut App| {
            let mut t = TextEdit::new("");
            t.focused = true;
            s.prompt = Some(Prompt::Tag(t));
        }).build(k).key("tag-add"));
        page = page.child(meta.flex_wrap());
    }
    // an OpenSCAD page's parameters stand over its source, to be changed where the page is read
    if p.kind == "scad" && !s.memory && p.body.len() <= 512 * 1024 {
        let params = scad::parse_params(&p.body);
        if !params.is_empty() && page_changes(s) {
            page = page.child(params_view(&params, k));
        }
    }
    if p.kind == "scad" && !s.memory {
        page = page.child(scad_view(s, p, k));
    }
    if let Some((_, _, why)) = s.tex_why.as_ref().filter(|(n, rev, _)| *n == p.name && *rev == p.rev) {
        page = page.child(text(why.clone()).key("tex-why").font(k.ty.small).color(c.text_muted).wrap());
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
            trailing = trailing.child(Button::new(if s.split.is_some() { "Unsplit" } else { "Split" }).variant(ButtonVariant::GhostMuted).help("Hold this page beside the next one you open").on_press(toggle_split).build(&k).key("split-toggle"));
            trailing = trailing.child(Button::new("Links").variant(ButtonVariant::GhostMuted).help("Pages that link here, and pages this links to").on_press(|s: &mut App| show_pane(s, false, true)).build(&k).key("links-toggle"));
            trailing = trailing.child(Button::new("Comments").variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| show_pane(s, true, false)).build(&k).key("comments-toggle-pane"));
        }
        trailing = trailing.child(Button::new("History").variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| show_pane(s, false, false)).build(&k).key("history-toggle"));
        trailing = trailing.child(Button::new("Delete").variant(ButtonVariant::GhostMuted).on_press(ask_delete).build(&k).key("delete"));
        trailing = trailing.child(Button::new("Rename").variant(ButtonVariant::GhostMuted).on_press(ask_rename).build(&k).key("rename"));
        trailing = trailing
            .child(Button::new("Edit").variant(ButtonVariant::Ghost).on_press_tx(|s: &mut App, tx| {
                start_edit(s);
                tx.focus_when_shown(FIELD, false);
            }).build(&k).key("edit"));
    }
    let mut layer = Vec::new();
    switcher(s, &k, &mut layer);
    palette_view(s, &k, &mut layer);
    template_view(s, &k, &mut layer);
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
        .child(Button::new("+").variant(ButtonVariant::GhostMuted).help("New tab").disabled(s.editing).on_press(new_tab).build(&k).key("tab-new"))
        // the title sits beside them, not centred: a centred one ran under the buttons in a narrow window
        .child(text(title.to_owned()).key("title").font(k.ty.ui_medium).color(k.c.text_base).truncate().pl(6.0));
    let main = if s.tabs.len() > 1 && !s.memory { col().w_full().h_full().min_h(0.0).child(tab_strip(s, &k)).child(col().w_full().grow(1.0).min_h(0.0).child(body(s, &k))) } else { body(s, &k) };
    let main = match s.split.as_ref().filter(|_| !s.memory) {
        Some(name) => row().w_full().h_full().min_h(0.0).child(col().grow(1.0).min_w(0.0).h_full().min_h(0.0).child(main)).child(Divider::vertical().build(&k)).child(col().grow(1.0).min_w(0.0).h_full().min_h(0.0).child(split_view(name, s, &k))),
        None => main,
    };
    let shell = SplitView::new(main)
        .sidebar(&s.sidebar, |s: &mut App| &mut s.sidebar, sidebar(s, &k))
        .inspector(&s.inspector, |s: &mut App| &mut s.inspector, if s.pane_links { links_view(s, &k) } else if s.pane_comments { comments_view(s, &k) } else { history_view(s, &k) })
        .toolbar(Toolbar::new().leading(leading).trailing(trailing))
        .titlebar_inset(cx.titlebar_inset())
        .frame_inset(8.0)
        .toolbar_in_panel()
        .reduced_motion(cx.is_reduced_motion())
        .build(&k);
    if s.dropping && !s.editing {
        // said in the middle of the window, over whatever is there
        layer.push(col().key("drop-hint").absolute(0.0, 0.0).w_full().h_full().center().child(text("Drop to upload as pages").font(k.ty.body_medium).color(k.c.text_base).padding(16.0).radius(k.radius.md).fill(k.c.layer_01)));
    }
    // files dropped anywhere on the window are uploaded, as on the web
    rune_kit::root(shell, layer).on_drop_files(|s: &mut App, files, _| upload(s, files.to_vec())).on_drop_hover(|s: &mut App, over, _| s.dropping = over)
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
    if ev.is_command('f') {
        open_find(s);
        return true;
    }
    if ev.is_command('t') && !s.editing {
        new_tab(s);
        return true;
    }
    if ev.is_command('w') && !s.editing && s.tabs.len() > 1 {
        close_tab(s, s.tab);
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
    fn an_html_page_is_read_as_a_document_and_its_text_is_left_alone() {
        let mut s = sample("welcome");
        let body = "<h1>Notes</h1><script>x()</script><p>Find <b>this</b> word. <img src=\"https://x.org/a.png\" alt=\"a\"></p>";
        s.open = Some(Page { name: "welcome".into(), body: body.into(), kind: "html".into(), rev: 9 });
        sync_sheet(&mut s);
        let p = s.open.clone().unwrap();
        assert_eq!(read_md(&s, &p), Some("# Notes\n\nFind **this** word. ![a](https://x.org/a.png)\n"));
        // find looks through what is read, and a picture from another site waits for a yes as on a Markdown page
        assert_eq!(find_where(&s), FindIn::Reader);
        assert_eq!(held_back(&s), 1);
        // the page's own text is what is edited and kept: reading it changes nothing
        assert_eq!(s.open.as_ref().unwrap().body, body);
        // a new revision is read again, and a page of another kind is not read this way
        let p2 = s.open.as_mut().unwrap();
        p2.body = "<p>Second</p>".into();
        p2.rev = 10;
        sync_sheet(&mut s);
        assert_eq!(read_md(&s, &s.open.clone().unwrap()), Some("Second\n"));
        s.open.as_mut().unwrap().kind = "css".into();
        sync_sheet(&mut s);
        assert_eq!(read_md(&s, &s.open.clone().unwrap()), None);
    }

    #[test]
    fn an_openscad_parameter_is_changed_in_its_own_line_and_kept_in_range() {
        let mut s = sample("welcome");
        let body = "// wall\nwall = 2; // [1:5]\nlabel = \"abc\"; // 4\nsize = [10, 20]; // [0:50]\ncube(size);\n";
        s.open = Some(Page { name: "welcome".into(), body: body.into(), kind: "scad".into(), rev: 1 });
        let text = |s: &App| s.open.as_ref().unwrap().body.clone();
        set_param(&mut s, "wall", |v| if let scad::Lit::Num(n) = v { Ok(scad::Lit::Num(n + 1.0)) } else { unreachable!() });
        assert_eq!(text(&s), body.replace("wall = 2;", "wall = 3;"));
        // past the end of its range it stops there
        set_param(&mut s, "wall", |_| Ok(scad::Lit::Num(99.0)));
        assert!(text(&s).contains("wall = 5; // [1:5]"));
        // a typed value goes through the prompt: a string no longer than its comment lets it be
        let mut t = TextEdit::new("");
        t.text = "abcdefgh".into();
        s.prompt = Some(Prompt::Param("label".into(), None, t));
        confirm(&mut s);
        assert!(text(&s).contains("label = \"abcd\"; // 4"), "{}", text(&s));
        // one part of a vector, typed, and what is not a number changes nothing
        let mut t = TextEdit::new("");
        t.text = "7.5".into();
        s.prompt = Some(Prompt::Param("size".into(), Some(1), t));
        confirm(&mut s);
        assert!(text(&s).contains("size = [10, 7.5]; // [0:50]"));
        let before = text(&s);
        let mut t = TextEdit::new("");
        t.text = "wide".into();
        s.prompt = Some(Prompt::Param("wall".into(), None, t));
        confirm(&mut s);
        assert_eq!((text(&s), s.note.as_str()), (before, "not changed: that is not a number"));
        // nothing but the values moved
        assert_eq!(text(&s), "// wall\nwall = 5; // [1:5]\nlabel = \"abcd\"; // 4\nsize = [10, 7.5]; // [0:50]\ncube(size);\n");
    }

    #[test]
    fn a_page_held_beside_is_read_as_its_kind_once_for_each_revision() {
        let mut s = sample("welcome");
        s.split = Some("budget".into());
        sync_beside(&mut s);
        assert!(matches!(&s.beside, Some((n, 1, Beside::Sheet(sheets, 0, _))) if n == "budget" && sheets.len() == 2 && sheets[0].rows.len() == 4));
        // the sheet showing stays through a change to the page, and follows its text
        if let Some((_, _, Beside::Sheet(_, at, _))) = &mut s.beside {
            *at = 1;
        }
        let p = s.cache.get_mut("budget").unwrap();
        p.body = p.body.replace("Prices checked in November", "Checked again");
        p.rev = 2;
        sync_beside(&mut s);
        assert!(matches!(&s.beside, Some((_, 2, Beside::Sheet(sheets, 1, _))) if sheets[1].rows[0][0] == "Checked again"));
        // a map is its features, an HTML page is what it reads as, and Markdown needs nothing kept
        s.split = Some("places".into());
        sync_beside(&mut s);
        assert!(matches!(&s.beside, Some((_, _, Beside::Map(feats))) if feats.len() == 4));
        s.cache.insert("page".into(), Page { name: "page".into(), body: "<h1>T</h1><script>x</script>".into(), kind: "html".into(), rev: 1 });
        s.split = Some("page".into());
        sync_beside(&mut s);
        assert!(matches!(&s.beside, Some((_, _, Beside::Read(md))) if md == "# T\n"));
        s.split = Some("welcome".into());
        sync_beside(&mut s);
        assert!(s.beside.is_none());
        // closing the split lets it go
        s.split = Some("budget".into());
        sync_beside(&mut s);
        s.split = None;
        keep_split(&mut s);
        assert!(s.beside.is_none());
    }

    #[test]
    fn a_memory_is_renamed_with_its_text_and_its_tags() {
        let mut s = sample("welcome");
        flip(&mut s);
        open_page(&mut s, "feedback/short-answers");
        let body = s.open.as_ref().unwrap().body.clone();
        s.know_meta.insert("feedback/short-answers".into(), (vec!["style".into()], "~2026.11.17".into()));
        ask_rename(&mut s);
        let Some(Prompt::Rename(_, t)) = &mut s.prompt else { panic!("the rename prompt opens for a memory") };
        t.text = "feedback/writing/short answers".into();
        confirm(&mut s);
        assert_eq!(s.names, ["project/lattice/rune", "feedback/writing/short-answers"]);
        let p = s.open.as_ref().unwrap();
        assert_eq!((p.name.as_str(), p.body.as_str()), ("feedback/writing/short-answers", body.as_str()));
        assert_eq!(s.know_meta.get("feedback/writing/short-answers").map(|m| m.0.clone()), Some(vec!["style".to_owned()]));
        assert!(!s.know_meta.contains_key("feedback/short-answers") && !s.cache.contains_key("feedback/short-answers"));
        // the pages are not touched by it
        flip(&mut s);
        assert!(s.names.contains(&"welcome".to_owned()) && !s.names.iter().any(|n| n.starts_with("feedback")));
    }

    #[test]
    fn a_memory_is_tagged_untagged_and_the_tree_filtered_by_a_tag() {
        let mut s = sample("welcome");
        flip(&mut s);
        open_page(&mut s, "project/lattice/rune");
        // typed with a hash and capitals, it is kept as the ship keeps it
        let mut t = TextEdit::new("");
        t.text = " #Native ".into();
        s.prompt = Some(Prompt::Tag(t));
        confirm(&mut s);
        assert_eq!(s.know_meta["project/lattice/rune"].0, ["native"]);
        assert_eq!(know_tags(&s), ["native", "style"]);
        // put on twice, it is there once
        set_tag(&mut s, "native".into(), true);
        assert_eq!(s.know_meta["project/lattice/rune"].0, ["native"]);
        // filtered by a tag, the filter and the tag both hold
        s.know_tag = Some("style".into());
        refilter(&mut s);
        s.query.text = "rune".into();
        refilter(&mut s);
        s.query.text = String::new();
        // the last memory with the tag loses it: there is nothing to filter by, and the filter goes
        open_page(&mut s, "feedback/short-answers");
        set_tag(&mut s, "style".into(), false);
        assert!(s.know_meta["feedback/short-answers"].0.is_empty());
        assert_eq!((s.know_tag.clone(), know_tags(&s)), (None, vec!["native".to_owned()]));
        // a page has no tags
        flip(&mut s);
        open_page(&mut s, "welcome");
        set_tag(&mut s, "x".into(), true);
        assert!(!s.know_meta.contains_key("welcome"));
    }

    #[test]
    fn the_trash_opens_reads_and_closes() {
        let mut s = sample("welcome");
        flip(&mut s);
        // closed, nothing is read
        load_trash(&mut s);
        assert!(s.trash.is_none());
        // opened with no ship, it is empty and says so
        s.trash = Some(None);
        load_trash(&mut s);
        assert_eq!(s.trash, Some(Some(Vec::new())));
        // closed again, it is gone
        s.trash = None;
        load_trash(&mut s);
        assert!(s.trash.is_none());
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
        assert!(s.editing && s.capture && s.prompt.is_none());
        assert_eq!(s.open.as_ref().map(|p| p.name.as_str()), Some("not/written"));
        cancel_edit(&mut s);
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
        assert_eq!(ids(&s, "")[..3], ["new", "template", "upload"]);
        assert!(!ids(&s, "").contains(&"reload"));
        // run two: the last is first, the one before it second, the rest as they were
        s.prefs.used = vec!["rename".into(), "theme".into()];
        assert_eq!(ids(&s, "")[..4], ["rename", "theme", "new", "template"]);
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
    fn a_wiki_link_being_typed_offers_pages_and_tab_completes_it() {
        let mut s = sample("welcome");
        start_edit(&mut s);
        s.rich = false;
        s.edit = TextEdit::new("see [[tod");
        s.edit.set_caret(9);
        let (start, offers) = link_offers(&s).unwrap();
        assert_eq!((start, offers[0].as_str()), (6, "notes/today"));
        accept_link(&mut s, start, "notes/today");
        assert_eq!((s.edit.text.as_str(), s.edit.focus), ("see [[notes/today]]", 19));
        assert!(link_offers(&s).is_none(), "a closed link offers nothing");
        // a link that is closed already keeps its one pair of brackets
        s.edit = TextEdit::new("[[bud]] x");
        s.edit.set_caret(5);
        let (start, _) = link_offers(&s).unwrap();
        accept_link(&mut s, start, "budget");
        assert_eq!(s.edit.text, "[[budget]] x");
        // a whole date offers that day's journal page first, written or not
        s.edit = TextEdit::new("[[2031-01-02");
        s.edit.set_caret(12);
        let (_, offers) = link_offers(&s).unwrap();
        assert_eq!(offers[0], "journal/2031-01-02");
        assert!(ghost(&s, &offers[0]));
        // dismissed, it stays away for that link and comes back for the next
        s.ac_off = Some(2);
        assert!(link_offers(&s).is_none());
        s.edit = TextEdit::new("[[2031-01-02]] and [[bud");
        s.edit.set_caret(24);
        assert!(link_offers(&s).is_some());
        // nothing is offered outside the editor
        s.editing = false;
        assert!(link_offers(&s).is_none());
    }

    #[test]
    fn today_opens_the_days_journal_page_or_starts_it_named() {
        let mut s = sample("welcome");
        let forms = api::journal_forms(&api::today());
        s.names.retain(|n| !forms.contains(n));
        // not written: started under the dashed name, and made by its save
        open_today(&mut s);
        assert_eq!(s.open.as_ref().map(|p| p.name.clone()), Some(forms[0].clone()));
        assert!(s.editing && s.capture && !s.names.contains(&forms[0]));
        s.edit = TextEdit::new("today I\n");
        s.rich = false;
        save(&mut s);
        assert!(s.names.contains(&forms[0]) && !s.editing);
        // written: opened, not started again
        open_page(&mut s, "welcome");
        open_today(&mut s);
        assert!(!s.editing && !s.capture);
        assert_eq!(s.cache[&forms[0]].body, "today I\n");
        // an older page under a dotted name is the one opened
        s.names.retain(|n| *n != forms[0]);
        s.names.push(forms[2].clone());
        s.cache.insert(forms[2].clone(), Page { name: forms[2].clone(), body: "old\n".into(), kind: "md".into(), rev: 1 });
        open_today(&mut s);
        assert_eq!(s.open.as_ref().map(|p| p.name.clone()), Some(forms[2].clone()));
    }

    #[test]
    fn what_a_template_made_is_shown_as_a_page_an_index_or_a_folder() {
        let mut s = sample("welcome");
        // a single page
        land_on(&mut s, "budget");
        assert_eq!(s.open.as_ref().map(|p| p.name.as_str()), Some("budget"));
        // a folder with an index opens the index
        for n in ["site/index", "site/about"] {
            s.names.push(n.into());
            s.cache.insert(n.into(), Page { name: n.into(), body: "x\n".into(), kind: "md".into(), rev: 1 });
        }
        land_on(&mut s, "site");
        assert_eq!(s.open.as_ref().map(|p| p.name.as_str()), Some("site/index"));
        // a folder without one shows the folder
        land_on(&mut s, "notes");
        assert_eq!((s.open.is_none(), s.folder.as_deref()), (true, Some("notes")));
        // nothing made: nothing changes
        land_on(&mut s, "nowhere");
        assert_eq!(s.folder.as_deref(), Some("notes"));
        // the dialog: seeded in the folder showing, a name in use refused, a new one made
        ask_template(&mut s);
        assert_eq!(s.tmpl.as_ref().map(|t| (t.0.as_str(), t.1.text.as_str())), Some(("note", "notes/note")));
        s.tmpl.as_mut().unwrap().1 = TextEdit::new("budget");
        make_from_template(&mut s);
        assert!(s.tmpl.is_some() && s.note == "a page by that name exists");
        s.tmpl.as_mut().unwrap().1 = TextEdit::new("notes/From Template");
        make_from_template(&mut s);
        let made = api::real_name("notes/From Template").unwrap().name;
        assert!(s.tmpl.is_none() && s.names.contains(&made));
    }

    #[test]
    fn a_map_orrery_keeps_is_not_edited_and_any_other_page_is() {
        let mut s = sample("welcome");
        let map = Page { name: ORRERY_MAP.into(), body: "{}".into(), kind: "geojson".into(), rev: 1 };
        s.names.push(ORRERY_MAP.into());
        s.cache.insert(ORRERY_MAP.into(), map);
        open_page(&mut s, ORRERY_MAP);
        // not yet said either way: taken as kept
        start_edit(&mut s);
        assert!(!s.editing && s.note.starts_with("orrery keeps this map"));
        s.kept = Some(true);
        start_edit(&mut s);
        assert!(!s.editing);
        // the ship says orrery does not keep it: an ordinary page
        s.kept = Some(false);
        start_edit(&mut s);
        assert!(s.editing);
        cancel_edit(&mut s);
        // the flag is about that one page only
        s.kept = Some(true);
        open_page(&mut s, "welcome");
        start_edit(&mut s);
        assert!(s.editing);
    }

    #[test]
    fn tabs_each_keep_their_page_and_their_way_back() {
        let mut s = sample("welcome");
        open_page(&mut s, "budget");
        let open = |s: &App| s.open.as_ref().map(|p| p.name.clone());
        // a new tab is empty and in front, and the first keeps its page
        new_tab(&mut s);
        assert_eq!((s.tabs.len(), s.tab, open(&s)), (2, 1, None));
        assert_eq!((tab_label(&s, 0), tab_label(&s, 1)), ("budget".to_owned(), "New tab".to_owned()));
        open_page(&mut s, "notes/today");
        // back in the first: its page, and its own way back
        switch_tab(&mut s, 0);
        assert_eq!(open(&s).as_deref(), Some("budget"));
        step(&mut s, -1);
        assert_eq!(open(&s).as_deref(), Some("welcome"));
        switch_tab(&mut s, 1);
        assert_eq!((open(&s).as_deref(), s.trail.len()), (Some("notes/today"), 1));
        // no switching, opening or closing while editing
        start_edit(&mut s);
        switch_tab(&mut s, 0);
        new_tab(&mut s);
        close_tab(&mut s, 1);
        assert_eq!((s.tab, s.tabs.len()), (1, 2));
        cancel_edit(&mut s);
        // a page that is gone leaves its tab empty
        s.names.retain(|n| n != "welcome");
        switch_tab(&mut s, 0);
        assert_eq!((open(&s), tab_label(&s, 0)), (None, "New tab".to_owned()));
        // closing the one in front brings its neighbour forward, and the last one stays
        close_tab(&mut s, 0);
        assert_eq!((s.tabs.len(), s.tab, open(&s).as_deref()), (1, 0, Some("notes/today")));
        close_tab(&mut s, 0);
        assert_eq!(s.tabs.len(), 1);
        // closing one behind keeps the one in front where it is
        new_tab(&mut s);
        new_tab(&mut s);
        open_page(&mut s, "budget");
        close_tab(&mut s, 0);
        assert_eq!((s.tabs.len(), s.tab, open(&s).as_deref()), (2, 1, Some("budget")));
    }

    #[test]
    fn tabs_are_kept_and_open_again_on_their_pages() {
        let mut s = sample("welcome");
        open_in_tab(&mut s, "budget");
        new_tab(&mut s);
        open_in_tab(&mut s, "notes/today");
        switch_tab(&mut s, 1);
        assert_eq!((s.prefs.tabs.clone(), s.prefs.tab), (vec!["welcome".to_owned(), "budget".into(), String::new(), "notes/today".into()], 1));
        // the next run: the same tabs, the same one in front, and a page since deleted leaves its tab empty
        let mut next = sample("welcome");
        next.open = None;
        next.trail.clear();
        next.prefs.tabs = s.prefs.tabs.clone();
        next.prefs.tab = 1;
        next.names.retain(|n| n != "notes/today");
        assert!(restore_tabs(&mut next));
        assert_eq!((next.tabs.len(), next.tab, next.open.as_ref().map(|p| p.name.as_str())), (4, 1, Some("budget")));
        assert_eq!((tab_label(&next, 0), tab_label(&next, 2), tab_label(&next, 3)), ("welcome".to_owned(), "New tab".to_owned(), "New tab".to_owned()));
        switch_tab(&mut next, 0);
        assert_eq!(next.open.as_ref().map(|p| p.name.as_str()), Some("welcome"));
        // one tab is not worth restoring: the page opened last covers it
        let mut one = sample("welcome");
        one.prefs.tabs = vec!["budget".into()];
        assert!(!restore_tabs(&mut one));
        // a front tab kept past the end comes back as the last
        one.prefs.tabs = vec!["budget".into(), "welcome".into()];
        one.prefs.tab = 9;
        assert!(restore_tabs(&mut one) && one.tab == 1);
    }

    #[test]
    fn a_page_is_held_beside_another_and_swapped_to_the_front() {
        let mut s = sample("welcome");
        toggle_split(&mut s);
        assert_eq!(s.split.as_deref(), Some("welcome"));
        open_page(&mut s, "budget");
        assert_eq!(s.split.as_deref(), Some("welcome"), "it stays while the front changes");
        swap_split(&mut s);
        assert_eq!((s.open.as_ref().map(|p| p.name.as_str()), s.split.as_deref()), (Some("welcome"), Some("budget")));
        // not while editing: the page in front is not left behind
        start_edit(&mut s);
        swap_split(&mut s);
        assert_eq!(s.open.as_ref().map(|p| p.name.as_str()), Some("welcome"));
        cancel_edit(&mut s);
        assert_eq!(s.prefs.split, "budget", "what is held is kept for the next run");
        // the same press lets go of it
        toggle_split(&mut s);
        assert_eq!((s.split.clone(), s.prefs.split.as_str()), (None, ""));
        // nothing to hold with no page in front
        s.open = None;
        toggle_split(&mut s);
        assert_eq!(s.split, None);
    }

    #[test]
    fn an_upload_makes_pages_says_what_it_left_out_and_shows_what_it_made() {
        let root = std::env::temp_dir().join(format!("lattice-rune-up-main-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Trip/days")).unwrap();
        std::fs::write(root.join("Trip/plan.md"), "# plan\n").unwrap();
        std::fs::write(root.join("Trip/days/one.md"), "one\n").unwrap();
        std::fs::write(root.join("Trip/photo.png"), [1u8, 2, 3]).unwrap();
        let mut s = sample("welcome");
        upload(&mut s, vec![root.join("Trip")]);
        assert!(s.names.contains(&"trip/plan".to_owned()) && s.cache["trip/days/one"].body == "one\n");
        assert_eq!(s.note, "uploaded 2 pages. Left out 1: Trip/photo.png (not a kind of page)");
        assert_eq!((s.open.is_none(), s.folder.as_deref()), (true, Some("trip")), "the folder they share is shown");
        // one file, into the folder showing: it is opened
        upload(&mut s, vec![root.join("Trip/plan.md")]);
        assert_eq!(s.open.as_ref().map(|p| p.name.as_str()), Some("trip/plan"));
        assert_eq!(s.note, "uploaded 1 page");
        // nothing usable
        upload(&mut s, vec![root.join("Trip/photo.png")]);
        assert!(s.note.starts_with("nothing was uploaded. Left out 1"));
        // nothing while a page is being edited: the editor is not left
        start_edit(&mut s);
        let pages = s.names.len();
        upload(&mut s, vec![root.join("Trip")]);
        assert!(s.editing && s.names.len() == pages);
        cancel_edit(&mut s);
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(common_folder(&["a/b/c".into(), "a/b/d/e".into(), "a/x".into()]), "a");
        assert_eq!(common_folder(&["a".into(), "b".into()]), "");
        assert_eq!(upload_note(3, &(0..6).map(|i| format!("f{i}")).collect::<Vec<_>>()), "uploaded 3 pages. Left out 6: f0, f1, f2, f3, and 2 more");
    }

    #[test]
    fn images_from_other_sites_wait_for_the_pages_own_yes() {
        let mut s = sample("welcome");
        let body = "![cat](https://x.invalid/cat.png) ![dog](//y.invalid/dog.png) ![here](/apps/lattice/f/a.png)\n";
        s.names.push("pics".into());
        s.cache.insert("pics".into(), Page { name: "pics".into(), body: body.into(), kind: "md".into(), rev: 1 });
        open_page(&mut s, "pics");
        // two are from other sites: held back, counted, and nothing was asked of anyone
        assert_eq!(held_back(&s), 2);
        assert!(s.pics_asked.is_empty(), "no waker and no yes: nothing is fetched");
        // the yes is the page's own, and is kept
        s.prefs.allow_outside("pics");
        assert_eq!(held_back(&s), 0);
        open_page(&mut s, "welcome");
        assert_eq!(held_back(&s), 0, "a page with no images holds none back");
        s.prefs.allow_outside("welcome");
        assert_eq!(s.prefs.outside, ["welcome", "pics"]);
        // an image's address on the ship: from its root, or beside the page
        assert_eq!(api::fetch_bytes("file:///etc/passwd", None).unwrap_err(), "not a web address");
        assert_eq!(api::fetch_bytes("data:image/png;base64,AA", None).unwrap_err(), "not a web address");
    }

    #[test]
    fn find_counts_what_is_read_not_the_markdown_around_it() {
        let mut s = sample("welcome");
        let body = "# Café notes\n\nThe **cafe** on [the corner](https://cafe.example/cafe) sells CAFÉ au lait.\n\n```\ncafe = 1\n```\n";
        s.names.push("find-me".into());
        s.cache.insert("find-me".into(), Page { name: "find-me".into(), body: body.into(), kind: "md".into(), rev: 1 });
        open_page(&mut s, "find-me");
        open_find(&mut s);
        assert!(s.find.is_some());
        // any case, with or without the accent, and not the link's address
        s.find = Some(TextEdit::new("cafe"));
        assert_eq!(find_count(&s), 4, "the heading, the bold word, the last word, the code. Not the address");
        // an accent typed is an accent meant
        s.find = Some(TextEdit::new("café"));
        assert_eq!(find_count(&s), 2);
        s.find = Some(TextEdit::new("  "));
        assert_eq!(find_count(&s), 0);
        s.find = Some(TextEdit::new("nowhere to be found"));
        assert_eq!(find_count(&s), 0);
        // in the editor it finds in the text as typed, and selects the match it stands on
        s.find = None;
        start_edit(&mut s);
        s.rich = false;
        s.edit = TextEdit::new(body);
        open_find(&mut s);
        s.find = Some(TextEdit::new("cafe"));
        let found = edit_matches(&s);
        assert_eq!(found.len(), 6, "the address counts here: it is in the text");
        assert_eq!(&body[found[0].clone()], "Café");
        assert_eq!(find_count(&s), 6);
        // a sheet: the cells that hold it, by row then column, whatever the case
        cancel_edit(&mut s);
        s.find = None;
        open_page(&mut s, "budget");
        assert_eq!(find_where(&s), FindIn::Sheet);
        open_find(&mut s);
        s.find = Some(TextEdit::new("HOSTING"));
        assert_eq!(sheet_matches(&s), [(1, 0)]);
        s.find = Some(TextEdit::new("0"));
        assert!(find_count(&s) > 2);
        // a map has nothing to find in
        s.find = None;
        open_page(&mut s, "places");
        assert_eq!(find_where(&s), FindIn::Nothing);
        open_find(&mut s);
        assert!(s.find.is_none() && s.note == "there is nothing here to find in");
        // a page shown as its source: found in what is drawn
        s.names.push("style".into());
        s.cache.insert("style".into(), Page { name: "style".into(), body: "body { color: red }\n.Body { color: blue }\n".into(), kind: "css".into(), rev: 1 });
        open_page(&mut s, "style");
        assert_eq!(find_where(&s), FindIn::Source);
        s.find = Some(TextEdit::new("body"));
        assert_eq!(find_count(&s), 2);
        assert_eq!(source_shown("héllo"), "héllo");
    }

    #[test]
    fn a_duplicate_has_the_pages_kind_and_text_under_a_name_of_its_own() {
        let mut s = sample("budget");
        let (kind, body) = (s.open.as_ref().unwrap().kind.clone(), s.open.as_ref().unwrap().body.clone());
        ask_duplicate(&mut s);
        assert!(matches!(&s.prompt, Some(Prompt::Duplicate(_, t)) if t.text == "budget-copy"));
        // a name in use is refused, and the question stays
        if let Some(Prompt::Duplicate(_, t)) = &mut s.prompt {
            *t = TextEdit::new("welcome");
        }
        confirm(&mut s);
        assert!(s.prompt.is_some() && s.note == "there is a page named welcome already");
        if let Some(Prompt::Duplicate(_, t)) = &mut s.prompt {
            *t = TextEdit::new("money/Budget 2027");
        }
        confirm(&mut s);
        let name = api::real_name("money/Budget 2027").unwrap().name;
        let copy = s.open.clone().unwrap();
        assert_eq!((copy.name.as_str(), copy.kind.as_str(), copy.body == body), (name.as_str(), kind.as_str(), true));
        assert!(s.prompt.is_none() && s.names.contains(&name));
        assert_eq!(s.cache["budget"].body, body, "the page copied is as it was");
        assert_eq!(page_link(&s).as_deref(), Some(format!("urb://~sampel-palnet/{name}").as_str()));
    }

    #[test]
    fn a_conversion_lands_as_an_html_page_beside_its_source() {
        let mut s = sample("welcome");
        // only offered for a LaTeX page
        assert!(!usable(&s, "tex"));
        convert_tex(&mut s);
        assert_eq!(s.note, "only a LaTeX page converts");
        s.names.push("paper".into());
        s.cache.insert("paper".into(), Page { name: "paper".into(), body: "\\section{A}\n".into(), kind: "tex".into(), rev: 1 });
        open_page(&mut s, "paper");
        assert!(usable(&s, "tex"));
        // what the worker hands back: kept, said, and waiting to be shown
        let out = Page { name: tex::out_name("paper"), body: tex::page("paper", "<h1>A</h1>"), kind: "html".into(), rev: 1 };
        applied(&mut s, Op::Wrote(out.name.clone(), Some(out), "wrote paper-web".into()));
        assert!(s.names.contains(&"paper-web".to_owned()));
        assert_eq!((s.cache["paper-web"].kind.as_str(), s.note.as_str()), ("html", "wrote paper-web"));
        assert!(s.cache["paper-web"].body.starts_with("<!-- generated from paper.tex by pandoc."));
        // a second conversion writes over the first and adds no second name
        let again = Page { name: "paper-web".into(), body: tex::page("paper", "<h1>B</h1>"), kind: "html".into(), rev: 1 };
        applied(&mut s, Op::Wrote("paper-web".into(), Some(again), "wrote paper-web".into()));
        assert_eq!(s.names.iter().filter(|n| *n == "paper-web").count(), 1);
        assert!(s.cache["paper-web"].body.ends_with("<h1>B</h1>"));
    }

    #[test]
    fn a_maps_hidden_kinds_outlast_a_save_of_the_same_page() {
        let mut s = sample("places");
        s.map.as_mut().unwrap().hidden.insert("place".into());
        next_base(&mut s);
        assert!(s.map.as_ref().unwrap().hidden.contains("place"), "the page was written again and the kind is still hidden");
        open_page(&mut s, "welcome");
        open_page(&mut s, "places");
        assert!(s.map.as_ref().unwrap().hidden.is_empty(), "opened afresh, every kind shows");
    }

    #[test]
    fn a_map_draws_the_maps_it_names_under_it_and_fits_to_them() {
        let s = sample("region");
        let m = s.map.as_ref().unwrap();
        assert!(m.feats.is_empty());
        assert_eq!(m.under.iter().map(|(n, f)| (n.as_str(), f.as_ref().map(Vec::len))).collect::<Vec<_>>(), [("places", Some(4)), ("nowhere", None)]);
        // with nothing of its own it looks at what is under it, where a bare map looks at the world
        let cam = fit_map(m);
        assert!(cam.scale > 10_000.0 && (cam.at[0] - map::mercator(-73.96, 40.74)[0]).abs() < 0.001, "{cam:?}");
        // the layers are only shown: the page is as it was
        assert_eq!(s.open.as_ref().unwrap().body, SAMPLE.iter().find(|(n, _)| *n == "region").unwrap().1);
    }

    #[test]
    fn a_map_feature_is_edited_and_deleted_and_the_rest_is_kept() {
        let mut s = sample("places");
        let shapes = s.map.as_ref().unwrap().feats.len();
        s.map.as_mut().unwrap().picked = Some(2);
        // the line's name, kind and note, through the prompt
        ask_feature(&mut s, 2);
        let Some(Prompt::Feature(2, t)) = &mut s.prompt else { panic!("the feature prompt opens") };
        assert_eq!(t[0].text, "A walk");
        (t[0].text, t[1].text, t[2].text) = (" The walk ".into(), "route".into(), "by the river\nthen back".into());
        confirm(&mut s);
        let m = s.map.as_ref().unwrap();
        assert_eq!((m.feats[2].name.as_str(), m.feats[2].kind.as_str(), m.feats[2].note.as_str()), ("The walk", "route", "by the river\nthen back"));
        assert_eq!((m.picked, m.feats.len()), (Some(2), shapes), "it stays picked and nothing else moved");
        assert_eq!(m.feats[0].name, "Midtown");
        // emptied fields take the properties away
        ask_feature(&mut s, 2);
        let Some(Prompt::Feature(_, t)) = &mut s.prompt else { panic!() };
        (t[1].text, t[2].text) = (" ".into(), String::new());
        confirm(&mut s);
        assert!(!s.open.as_ref().unwrap().body.contains("route") && !s.open.as_ref().unwrap().body.contains("river"));
        // deleted: the others are there, in order
        assert!(write_map(&mut s, |b| map::remove(b, 2)));
        assert_eq!(s.map.as_ref().unwrap().feats.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["Midtown", "Brooklyn", "The park"]);
        // while the page is being edited as source the map is not changed under it
        s.editing = true;
        assert!(!write_map(&mut s, |b| map::remove(b, 0)));
        assert_eq!(s.map.as_ref().unwrap().feats.len(), 3);
    }

    #[test]
    fn a_drawn_line_becomes_a_feature_and_too_few_corners_do_not() {
        let mut s = sample("places");
        let shapes = s.map.as_ref().unwrap().feats.len();
        let m = s.map.as_mut().unwrap();
        (m.tool, m.verts) = (Some(map::Draw::Area), vec![[-73.9, 40.7], [-73.8, 40.7]]);
        finish_shape(&mut s);
        let m = s.map.as_mut().unwrap();
        assert_eq!((m.feats.len(), m.verts.len(), m.tool), (shapes, 0, Some(map::Draw::Area)), "two corners are no area: nothing is made and the tool stays");
        (m.tool, m.verts) = (Some(map::Draw::Line), vec![[-73.9, 40.7], [-73.8, 40.7]]);
        finish_shape(&mut s);
        let m = s.map.as_ref().unwrap();
        assert_eq!((m.feats.len(), m.picked, m.tool), (shapes + 1, Some(shapes), None), "the line is there and picked, and the tool is put down");
        assert!(matches!(m.feats[shapes].geoms[0], map::Geom::Line(_)));
    }

    #[test]
    fn a_cell_typed_into_is_saved_and_the_cell_below_is_picked() {
        let mut s = sample("budget");
        let before = s.open.clone().unwrap();
        pick_cell(&mut s, 1, 0);
        assert_eq!(s.sheet.as_ref().unwrap().entry.text, s.sheet.as_ref().unwrap().sheets[0].rows[1][0]);
        s.sheet.as_mut().unwrap().entry.text = "Oat milk".into();
        commit_cell(&mut s);
        let v = s.sheet.as_ref().unwrap();
        assert_eq!((v.sheets[0].rows[1][0].as_str(), v.cursor), ("Oat milk", Some((2, 0))));
        assert_eq!(s.open.as_ref().unwrap().rev, before.rev + 1);
        // typed as it already is: nothing is saved
        pick_cell(&mut s, 1, 0);
        commit_cell(&mut s);
        assert_eq!(s.open.as_ref().unwrap().rev, before.rev + 1);
        // what cannot be written says why and leaves the page alone
        pick_cell(&mut s, 1, 0);
        s.sheet.as_mut().unwrap().entry.text = "=A1+".into();
        commit_cell(&mut s);
        assert_eq!(s.note, "not changed: that formula cannot be read: the formula ends too soon");
        assert_eq!(s.sheet.as_ref().unwrap().sheets[0].rows[1][0], "Oat milk");
        // a formula is worked out and shown, and picked again it shows as it was typed
        pick_cell(&mut s, 5, 0);
        s.sheet.as_mut().unwrap().entry.text = "=A2&\"!\"".into();
        commit_cell(&mut s);
        assert_eq!(s.sheet.as_ref().unwrap().sheets[0].rows[5][0], "Oat milk!");
        pick_cell(&mut s, 5, 0);
        assert_eq!(s.sheet.as_ref().unwrap().entry.text, "=A2&\"!\"");
        // what it reads changes, and it follows
        pick_cell(&mut s, 1, 0);
        s.sheet.as_mut().unwrap().entry.text = "Soy".into();
        commit_cell(&mut s);
        assert_eq!(s.sheet.as_ref().unwrap().sheets[0].rows[5][0], "Soy!");
        // a function is worked out. The sample sheet is written by hand and its own text cells say no
        // type, so they are nothing to a formula, as on the web: the two counted are the two typed here
        pick_cell(&mut s, 7, 0);
        s.sheet.as_mut().unwrap().entry.text = "=COUNTA(A1:A6)&\" items\"".into();
        commit_cell(&mut s);
        assert_eq!(s.sheet.as_ref().unwrap().sheets[0].rows[7][0], "2 items");
        assert!(s.sheet.as_ref().unwrap().stale.is_empty());
        // one that is not known here is stored, counted, and shows nothing until it is
        pick_cell(&mut s, 6, 0);
        s.sheet.as_mut().unwrap().entry.text = "=NOPE(B2:B3)".into();
        commit_cell(&mut s);
        assert_eq!(s.sheet.as_ref().unwrap().stale.iter().copied().collect::<Vec<_>>(), [(0, 6, 0)]);
        assert!(s.open.as_ref().unwrap().body.contains("table:formula=\"of:=NOPE([.B2:.B3])\""));
        // another change elsewhere does not forget it
        pick_cell(&mut s, 8, 3);
        s.sheet.as_mut().unwrap().entry.text = "x".into();
        commit_cell(&mut s);
        assert_eq!(s.sheet.as_ref().unwrap().stale.len(), 1);
    }

    #[test]
    fn a_maps_base_goes_round_and_is_kept_in_the_page() {
        let mut s = sample("places");
        let (rev, shapes) = (s.open.as_ref().unwrap().rev, s.map.as_ref().unwrap().feats.len());
        assert_eq!(s.map.as_ref().unwrap().style, "streets");
        next_base(&mut s);
        let p = s.open.clone().unwrap();
        assert_eq!((p.rev, map::base_style(&p.body)), (rev + 1, "outdoors"));
        assert_eq!((s.map.as_ref().unwrap().style, s.map.as_ref().unwrap().feats.len()), ("outdoors", shapes), "the shapes are the ones it had");
        for want in ["satellite", "dark", "streets"] {
            next_base(&mut s);
            assert_eq!(s.map.as_ref().unwrap().style, want);
        }
        // not a map, or being edited: nothing is changed
        open_page(&mut s, "welcome");
        let before = s.cache["welcome"].body.clone();
        next_base(&mut s);
        assert_eq!(s.cache["welcome"].body, before);
        // sample pages have no ship to keep a token
        ask_token(&mut s);
        assert!(s.prompt.is_none());
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
