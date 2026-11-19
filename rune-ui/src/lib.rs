//! lattice, drawn natively with Rune: an experiment beside the shipped desktop app.
//!
//! `LATTICE_URL=https://ship LATTICE_COOKIE=/path/to/cookie cargo run` opens a ship.
//! With neither set it opens on built-in sample pages, which is also what the
//! headless runs draw: `cargo run -- --snap out.png --scene reading`.

#[cfg(not(target_arch = "wasm32"))]
mod accounts;
mod api;
mod backups;
mod browse;
mod calc;
mod code;
mod fonts;
mod formula;
mod html;
mod local;
mod mounts;
mod funcs;
mod head;
mod linkedit;
mod map;
mod marks;
mod mapio;
mod md;
mod odf;
mod outline;
mod pdf;
mod pins;
mod ribbon;
mod rpane;
mod scad;
mod scadrun;
mod search;
mod sheet;
mod shift;
mod splits;
mod status;
mod swm;
mod styles;
mod tabhead;
mod tex;
mod theme;
mod topbar;
mod upload;
mod vault;
mod view3d;
#[cfg(not(target_arch = "wasm32"))]
mod htmlview;
#[cfg(not(target_arch = "wasm32"))]
mod update;
#[cfg(unix)]
mod engine;
#[cfg(unix)]
mod cometid;
mod vim;

use std::collections::HashMap;

use api::{Ask, Asks, Comment, Conn, Notice, Opens, Waiting, Dump, Group, Know, Level, Node, Page, Prefs, Rev, Shared};
use rune::{AppSpec, Block, LineCap, Phase, Shape, WheelEvent, canvas, Chrome, Cx, El, Key, KeyEvent, Latest, Mark, ScrollSpec, Span, TextEdit, Tx, Waker, col, el, row, text};
use rune_kit::shell::{self, PaneState, SplitView, Toolbar};
use rune_kit::syntax::{self, SyntaxTheme};
use rune_kit::{Cell, Table, TableColumn, TableState};
use rune_kit::Switch;
use rune_kit::{Menu, MenuItem};
use rune_kit::{Button, ButtonVariant, ControlSize, Dialog, IconButton, IconButtonVariant, Divider, FileNode, FileTree, Kit, Markdown, Spinner, TextArea, TextInput, Tree, TreeItem, TreeModel};

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

/// The settings on screen: the agent keys once read, and the key being
/// asked for. Its fields in order: the name, the name it writes as, the
/// page paths it reads and writes, a ship, and that ship's paths it
/// reads and writes.
struct Settings {
    keys: Option<Vec<api::AgentKey>>,
    f: Box<[TextEdit; 7]>,
    memory: &'static str,
    pages: &'static str,
    web: &'static str,
    skills: &'static str,
    sensitive: bool,
    /// The secret of the key just made, shown this once.
    token: Option<String>,
    sending: bool,
    /// The map token as the ship has it, the token typed to set, the ship's OpenSCAD runtime, and the openscad this computer draws with (read once: `Some(None)` when there is none).
    tiles: Option<api::TileStatus>,
    map_token: TextEdit,
    scad: Option<api::ScadStatus>,
    local_scad: Option<Option<String>>,
    /// When the runtime's state is read next, while an install runs.
    scad_next: f64,
    /// The Commons mirror's state, and how many more times the ship is asked whether %obelisk has arrived.
    obelisk: Option<api::Obelisk>,
    ob_tries: u32,
    ob_next: f64,
    /// The ship was asked to install %obelisk in this visit: what the state line says depends on it.
    ob_asked: bool,
    /// What the last rebuild of the search index came to.
    reindex: String,
    /// The form that connects is showing: to sign in again, or to another ship.
    connect: bool,
    /// The folder typed to mount a ship at. Empty is the ship's name under the home directory.
    mount_at: TextEdit,
    /// The folder a vault export is written to.
    vault_dir: TextEdit,
    /// The archive to restore from.
    vault_file: TextEdit,
    /// A backup schedule being typed: its name, folder, how many to keep, and its period in hours.
    bk_label: TextEdit,
    bk_dir: TextEdit,
    bk_keep: TextEdit,
    bk_every: u64,
    /// The part of the tree to mount of the ship signed in to. Empty is every page.
    mount_root: TextEdit,
    /// The piers found on this machine, once looked for.
    local: Option<Vec<local::LocalShip>>,
    /// What of lattice's software the ship has, once asked, and the ship to install %grubbery from.
    stack: Option<api::Stack>,
    dist: TextEdit,
}

impl Settings {
    fn new() -> Self {
        Settings { keys: None, f: Box::new(std::array::from_fn(|_| TextEdit::new(""))), memory: "write", pages: "read", web: "off", skills: "none", sensitive: false, token: None, sending: false, tiles: None, map_token: TextEdit::new(""), scad: None, local_scad: None, scad_next: 0.0, obelisk: None, ob_tries: 0, ob_next: 0.0, ob_asked: false, reindex: String::new(), connect: false, mount_at: TextEdit::new(""), vault_dir: TextEdit::new(""), vault_file: TextEdit::new(""), bk_label: TextEdit::new(""), bk_dir: TextEdit::new(""), bk_keep: TextEdit::new("7"), bk_every: 24, mount_root: TextEdit::new(""), local: None, stack: None, dist: TextEdit::new("~nisfeb") }
    }

    fn ask(&self) -> api::KeyAsk {
        let t = |i: usize| self.f[i].text.clone();
        api::KeyAsk { name: t(0), by: t(1), memory: self.memory.into(), pages: self.pages.into(), pages_read: t(2), pages_write: t(3), web: self.web.into(), web_ship: t(4), web_read: t(5), web_write: t(6), skills: self.skills.into(), sensitive: self.sensitive }
    }
}

/// The forum on screen: the boards once read, the board and the thread
/// showing when one is, and how the board's threads are ordered.
#[derive(Default)]
struct Forum {
    boards: Option<Vec<api::Board>>,
    board: Option<api::Board>,
    thread: Option<api::Thread>,
    sort: ForumSort,
    /// The tags the board's threads are shown by: those that carry every one.
    tags: Vec<String>,
    /// What is typed to find a tag among the board's.
    tag_find: TextEdit,
    /// The pictures asked to be shown: each a link's address, fetched from its site at that press.
    shown: Vec<String>,
    /// A board being made: its name, title and description, and what those with no role of their own may do.
    making: Option<(Box<[TextEdit; 3]>, &'static str)>,
    /// The board showing being changed: its title and description.
    editing: Option<Box<[TextEdit; 2]>>,
    /// The board showing being moderated.
    moding: Option<Moding>,
    /// The address typed of a board on another ship.
    address: TextEdit,
    /// The posts other ships refused, once read: why, and where and when. And whether they are what shows.
    notes: Option<Vec<(String, String)>>,
    notes_open: bool,
    /// A thread being written for the board showing: its title, link, text and tags.
    draft: Option<Box<[TextEdit; 4]>>,
    /// A comment being written on the thread showing, and the comment it answers when it answers one.
    comment: TextEdit,
    reply: Option<u64>,
    /// Something done to a thread from the board's list is on its way: the list's buttons wait, so
    /// a second press is not a second vote.
    acting: bool,
    /// What was written is on its way to the ship: it is kept until the ship has it.
    sending: bool,
}

/// A board's moderation as the ship gave it, and what is typed over it:
/// a ship to give a role, the sidebar, the least score and the days of
/// its pruning, and a ship to invite.
struct Moding {
    got: api::BoardMod,
    fields: Box<[TextEdit; 5]>,
    role: &'static str,
    prune: bool,
}

impl Moding {
    fn new(got: api::BoardMod) -> Self {
        let fields = Box::new([TextEdit::new(""), TextEdit::new(got.sidebar.as_str()), TextEdit::new(got.min_score.to_string().as_str()), TextEdit::new(got.after_days.to_string().as_str()), TextEdit::new("")]);
        Moding { prune: got.prune, got, fields, role: "reader" }
    }
}

/// What is done to the board being moderated.
enum ModAct {
    Open,
    /// The ship typed is given the role chosen.
    Role,
    Unrole(String),
    Sidebar,
    Prune,
    Comets,
    /// The ship typed is invited, or its invitation taken back.
    Invite(bool),
}

#[derive(Clone, Copy, Default, PartialEq)]
enum ForumSort {
    /// What is voted up and new, as the web's forum opens.
    #[default]
    Hot,
    New,
    Active,
    Top,
}

/// What a read of the forum gave.
enum ForumGot {
    Boards(Vec<api::Board>),
    Board(api::Board),
    /// A later hundred of the threads of the board showing.
    More(api::Board),
    Thread(api::Thread),
    Notes(Vec<(String, String)>),
    /// A board's moderation, and what to say of what was just done to it.
    Mod(api::BoardMod, String),
    /// The boards after one was made or deleted: what was being made, and the board that was showing, are let go.
    Changed(Vec<api::Board>),
}

/// How hot a thread is, as the ship scores one (`+hot-score` in `lattice-forum-rules.hoon`): its
/// votes up less its votes down, never under nothing, over the square of the whole hours since it
/// was made and two more. A pair to compare by multiplying across, as the ship does, never as a fraction.
fn hot_score(p: &api::ForumPost, now: i64) -> (u128, u128) {
    let made = api::da_secs(&p.created).unwrap_or(now);
    let hours = 2 + ((now - made).max(0) / 3600) as u128;
    (p.up.saturating_sub(p.down) as u128, hours * hours)
}

/// A board's threads as they are listed: the pinned ones first, then by the order asked for. `now`
/// is the moment, in seconds since 1970, that hot is reckoned at.
fn forum_sorted(posts: &[api::ForumPost], sort: ForumSort, now: i64) -> Vec<&api::ForumPost> {
    let mut v: Vec<&api::ForumPost> = posts.iter().collect();
    // by the moment a date names, and by its text only where it names none
    let at = |da: &str| (api::da_secs(da), da.to_owned());
    match sort {
        ForumSort::Hot => {
            // each scored once, then the higher first and the newer first of two the same, as `+hot-before`
            let mut scored: Vec<((u128, u128), (Option<i64>, String), &api::ForumPost)> = v.into_iter().map(|p| (hot_score(p, now), at(&p.created), p)).collect();
            scored.sort_by(|a, b| (b.0.0 * a.0.1).cmp(&(a.0.0 * b.0.1)).then_with(|| b.1.cmp(&a.1)));
            v = scored.into_iter().map(|x| x.2).collect();
        }
        ForumSort::New => v.sort_by_cached_key(|p| std::cmp::Reverse(at(&p.created))),
        ForumSort::Active => v.sort_by_cached_key(|p| std::cmp::Reverse(at(&p.active))),
        ForumSort::Top => v.sort_by_key(|p| std::cmp::Reverse(p.up as i64 - p.down as i64)),
    }
    v.sort_by_key(|p| !p.pinned);
    v
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
    /// The anonymous identity to be exported to this file: the passphrase, and the passphrase again.
    #[cfg(unix)]
    IdOut(std::path::PathBuf, Box<[TextEdit; 2]>),
    /// An identity file to open, and its passphrase.
    #[cfg(unix)]
    IdIn(std::path::PathBuf, TextEdit),
    /// An identity read from a file, to use in place of this computer's, which is named if there is one.
    #[cfg(unix)]
    IdUse(Box<cometid::Identity>, Option<String>),
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
    /// Signing out of the ship in front, or of every ship, while folders of theirs are mounted.
    ShipOut(bool),
    /// The kind of the page in front, to change: Markdown, gemtext, HTML and the rest.
    Kind(TextEdit),
    /// The tags of the forum thread showing, to set.
    ForumTags(TextEdit),
    /// A forum thread to delete, or one comment of the thread showing.
    ForumDelete(Option<u64>),
    /// Deleting a thread from its board's list: the board and the thread.
    ForumRowDelete(String, u64),
    /// Removing a comment from one of this ship's pages: the page and the comment.
    CommentRemove(String, String),
    /// A board to delete, with every thread on it.
    BoardDelete(String),
    /// An agent key to revoke: its id, and what it is called.
    KeyRevoke(String, String),
    /// A page or folder about to be made public in this mode, and whether not to ask again.
    Publish(&'static str, bool),
    /// An archive to put back, once the owner says so.
    Restore(Box<vault::Archive>),
    /// A value typed for an OpenSCAD parameter: its name, which part of a vector, and the text.
    Param(String, Option<usize>, TextEdit),
    /// A folder to make, empty.
    NewFolder(TextEdit),
    /// A folder for a bookmark: its address, and the folder typed.
    MarkMove(String, TextEdit),
    /// Where in the tree a page shared with this ship goes, as a link.
    LinkIn(Shared, TextEdit),
    /// A bookmark to remove: its address, and what it is shown as.
    MarkDrop(String, String),
    /// Taking a notice off shared with me, asked first.
    Forget(Shared),
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

/// A tab of the left pane that shows over the tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Over {
    Search,
    Marks,
}

/// A group of tabs that is not in front: its tabs, the one that shows,
/// and that tab's page as its kind is read (a sheet's grid, a map's
/// shapes), made once for each revision.
#[derive(Default)]
struct TabGroup {
    tabs: Vec<Tab>,
    at: usize,
    view: Option<(String, u64, Beside)>,
}

impl TabGroup {
    fn page(&self) -> Option<&str> {
        self.tabs.get(self.at).and_then(Tab::page)
    }
}

/// A change to the tree that landed on the ship.
enum Op {
    /// A core rule an agent key wrote was kept or untagged: what to say.
    Cored(String),
    /// An empty folder was made.
    FolderMade(String),
    /// The bookmarks were changed: what to say, and the list as it now stands.
    Marks(String, Vec<api::Bookmark>),
    /// A deleted memory was brought back from the trash.
    Restored(String),
    /// A memory's tag was put on or taken off: the memory, the tag, which.
    Tagged(String, String, bool),
    /// A notice was taken off shared with me: what to say.
    Forgot(String),
    /// A shared page was moved into the tree as a link: where, and whose it is. And a link moved back.
    Linked(String, String),
    Unlinked(String),
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
    /// The owner's own comment landed on a page of theirs: what to say, the page, and the text, which is let go only now.
    Posted(String, String, String),
    /// A comment went to another ship's page: the address, the text, and whether the host took it in the ship's five seconds.
    SentRemote(String, String, bool),
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
    /// The save now being sent was made by a press of Read, with the ship answering: it is said as "saved".
    read_save: bool,
    /// Using the app with no ship: other ships' published pages are read by the urb engine, as a comet.
    /// It stands on `sample` for everything a ship would be asked, with no pages of its own.
    anon: bool,
    /// The urb engine, made the first time the app is used with no ship.
    #[cfg(unix)]
    engine: Option<engine::Engine>,
    /// The address the engine is reading, and which asking of it this is. A read has a thread of its
    /// own: on the workers every request shares, four slow ones held them all and nothing else was answered.
    anon_reading: Option<String>,
    anon_seq: u64,
    /// When the engine's start is next looked at (app clock): one wake at a time.
    anon_tick: f64,
    anon_got: std::sync::Arc<std::sync::Mutex<Vec<(u64, Result<(String, api::Urb), String>)>>>,
    /// What a move of the anonymous identity came to. Sealing a file takes seconds and the engine
    /// closes for the copy, so each step has a thread of its own and an answer no other request drops.
    #[cfg(unix)]
    id_got: std::sync::Arc<std::sync::Mutex<Vec<IdDone>>>,
    /// What is being done to the identity now, in words, or nothing.
    #[cfg(unix)]
    id_busy: &'static str,
    /// The identity this computer has, and whether an export of it was made, as last read from its files.
    #[cfg(unix)]
    id_known: (Option<String>, bool),
    url: TextEdit,
    code: TextEdit,
    login_err: String,
    /// The ship answered a read as not signed in: the session lapsed.
    lapsed: bool,
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
    /// The ships signed in on this computer, as they were when the window's state was last built.
    ships: Vec<api::Ship>,
    /// The list of ships is showing, to go to another, add one or sign out.
    ships_open: bool,
    /// What the watcher last saw of each ship signed in that is not in front, by its address.
    seen: std::sync::Arc<std::sync::Mutex<HashMap<String, api::ShipSeen>>>,
    /// Stops the watcher of the ships not in front, when the ship in front changes.
    watch_stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Another ship is being signed in to, with the one in front left as it is until that is done.
    adding: bool,
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
    /// The right pane's tab that was asked for last.
    pane: rpane::Tab,
    /// The heading last jumped to from the outline while reading, marked in the page.
    outline_at: Option<usize>,
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
    comments_req: Latest<Result<(Vec<Comment>, u64), String>>,
    comments_on: HashMap<String, bool>,
    comments_on_req: Latest<Result<(String, bool), String>>,
    comment: TextEdit,
    /// How many comments the ship has in all: it sends the newest 200.
    comments_total: u64,
    /// A comment is on its way to the ship: Post waits, and the text stays until it is known to have landed.
    comment_sending: bool,
    /// A switch flipped here before the ship said yes, with what it was: put back if the ship refuses.
    comment_undo: Option<CommentUndo>,
    /// The comets' comments held on each page, as its Comments pane last read them.
    page_held: HashMap<String, Vec<Comment>>,
    /// The public thread of the page of another ship last read by address, oldest first.
    thread: Option<Thread>,
    thread_req: Latest<Result<(String, Vec<Comment>), String>>,
    /// A comment being posted. It has a request of its own: on the one the other actions share, any
    /// of them pressed meanwhile dropped the post's answer and left Post waiting for good.
    comment_req: Latest<Result<Op, String>>,
    /// A switch of the Comments pane being set, for the same reason: what it answers is what to say.
    switch_req: Latest<Result<String, String>>,
    /// Which page or thread the comment field's text is for, and what was typed for the others.
    comment_for: String,
    drafts: HashMap<String, String>,
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
    comets_req: Latest<Result<(String, (String, Vec<Comment>)), String>>,
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
    /// The address typed in Shared with me, what was read at one (the address, and what stands there), and the folder showing from it.
    urb: TextEdit,
    urb_req: Latest<Result<(String, api::Urb), String>>,
    urb_folder: Option<(String, Vec<(String, String, bool)>)>,
    /// The browser's way back and forward, what its address field offers and the row the arrows are on,
    /// and the addresses visited, as its start page lists them.
    nav: browse::Nav,
    sugg: Vec<api::Suggest>,
    sugg_at: Option<usize>,
    sugg_req: Latest<Result<Vec<api::Suggest>, String>>,
    visits: Vec<api::Visit>,
    visits_req: Latest<Result<Vec<api::Visit>, String>>,
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
    /// The core memories agent keys wrote, waiting for the owner to keep or untag each.
    core_agents: Vec<String>,
    core_req: Latest<Result<Vec<String>, String>>,
    /// The tag the memories are filtered by, when they are.
    know_tag: Option<String>,
    know_req: Latest<Result<Vec<Know>, String>>,
    /// The open page as the Markdown it is read as, when it is of a kind read that way and is not Markdown: its name, its revision, the text.
    read_as: Option<(String, u64, String)>,

    /// The forum, when it is what shows.
    forum: Option<Forum>,
    forum_req: Latest<Result<ForumGot, String>>,
    /// The board whose theme was looked for, and its stylesheet: empty when it has none.
    board_theme: Option<(String, String)>,
    board_theme_req: Latest<Result<(String, String), String>>,
    /// The settings showing, when they are.
    settings: Option<Settings>,
    /// The ship's change stream: what its listener heard since the last look, what the stamps stood at, and the flag that stops a listener whose session ended.
    beacon: std::sync::Arc<std::sync::Mutex<Vec<api::Beacon>>>,
    beacon_state: api::BeaconState,
    beacon_stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Vim's state between keys, for the source editor when vim mode is on.
    vim: vim::Vim,
    /// The agent keys as read, and the secret of one just made.
    keys_req: Latest<Result<(Vec<api::AgentKey>, Option<String>), String>>,
    /// The map token's state and the OpenSCAD runtime's as read, the openscad found here when it was looked for, and what to say of what was just done.
    set_req: Latest<Result<SetGot, String>>,
    stack_req: Latest<Result<api::Stack, String>>,
    local_req: Latest<Vec<local::LocalShip>>,
    /// The folders ships are mounted at, as kept between runs, and a mount or an unmount on its way: the list after it, and what to say.
    mounts: Vec<mounts::MountSpec>,
    /// The backup schedules, the one being written, what was last said of them, and when they are next looked at (app clock).
    backups: Vec<backups::Schedule>,
    bk_req: Latest<BkDone>,
    bk_said: String,
    bk_next: f64,
    mount_req: Latest<(Vec<mounts::MountSpec>, String)>,
    /// A vault export being written, and what was last said of one.
    /// With whether the tree is to be read again.
    vault_req: Latest<(String, bool)>,
    vault_said: String,
    /// The refusals, read beside the boards and after a clear.
    notes_req: Latest<Result<ForumGot, String>>,
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
    /// The groups of tabs, in the order they stand, when there is a split: two to four of them. The one at
    /// `front_at` is in front, and its tabs are `tabs`, so its place here is empty. No split is no groups.
    tgroups: Vec<TabGroup>,
    front_at: usize,
    /// Each group's share of the room along the split. They add up to 1.
    group_share: Vec<f32>,
    /// Where each group that is not in front stands in the window, as last laid out: for a tab dropped on one.
    group_rects: Vec<[f32; 4]>,
    /// Where each tab of each group's strip stands, by where the group stands: for a tab dropped among them.
    tab_rects: Vec<Vec<[f32; 4]>>,
    /// Where the group in front stands, for a tab of another group dropped on it.
    front_rect: [f32; 4],
    /// The tabs of each group that is not in front while one is pressed or dragged, by where the group stands.
    group_drag: [rune_kit::shell::TabDragState; splits::MOST],
    /// How tall the room the page's editor stands in is, as last laid out.
    edit_room: f32,
    /// The shares as they stood when a line between groups was pressed, while it is dragged.
    share_base: Option<Vec<f32>>,
    /// The groups are one above the other, not side by side.
    split_down: bool,
    /// The room the groups have, as last laid out: nothing until then.
    groups_room: (f32, f32),
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
    /// Pictures asked for that did not come.
    pics_failed: std::collections::HashSet<String>,
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
    /// The folders among the pages, those with no page in them too: the tree shows them all.
    dirs: Vec<String>,
    /// The quick switcher: its query while open, and the row the arrows are on.
    jump: Option<TextEdit>,
    jump_at: usize,
    /// The left pane's Search or Bookmarks tab, showing over whichever half of the tree is.
    over: Option<Over>,
    /// What is typed into it.
    squery: TextEdit,
    /// What it found, the most that are shown, and how many it found in all.
    shits: Vec<search::Hit>,
    sfound: usize,
    /// Pages whose text is not held, so not searched.
    sskipped: usize,
    /// The result the arrows are on.
    search_at: Option<usize>,
    /// The page menu in the tab header is open.
    page_menu: bool,
    /// The tree row a right-click landed on, and where: its menu shows there.
    tree_menu: Option<(String, rune::PointerPress)>,
    /// The top bar's tabs while one is pressed or dragged.
    tab_drag: rune_kit::shell::TabDragState,
    /// The bookmarks the reader keeps, once read.
    marks: Option<Vec<api::Bookmark>>,
    marks_req: Latest<Result<Vec<api::Bookmark>, String>>,
    /// The pages of each folder shared whole, by the folder's row in the tree, once read.
    folds: HashMap<String, Vec<api::FoldPage>>,
    folds_req: Latest<Vec<(String, Vec<api::FoldPage>)>>,
    /// The pages of the tree that are links to pages other ships shared, by name.
    links: HashMap<String, api::LinkTo>,
    /// The ship's word on themes, and when it is asked next.
    theme_req: Latest<Result<theme::Worn, String>>,
    next_theme: f64,
    /// A change to the theme on its way to the ship.
    theme_put: Latest<Result<(), String>>,
    /// Where an HTML page shown as a web page stands in the window, as last laid out.
    /// An HTML page drawn as a browser shows it: the thread that lays it out, and what it has sent.
    #[cfg(not(target_arch = "wasm32"))]
    web: WebShow,
    /// The app's own updates: what is asked, what was offered, and how far along it is.
    #[cfg(not(target_arch = "wasm32"))]
    upd: Updater,
    /// The link of the rich editor that is open to its Markdown, while the caret is in it.
    link_open: Option<linkedit::Open>,
    /// A theme being made or changed in the settings: its id, light or dark, and its name, five colours and six more as typed.
    theme_draft: Option<(String, bool, Box<[TextEdit; 12]>)>,
    /// The accent's colour as typed in the settings.
    accent_hex: TextEdit,
    /// The families the window's text was last set in, to set them again only when the theme's font changes.
    font_set: String,
    /// The last read of them failed.
    marks_bad: bool,
    /// What is typed into their filter.
    marks_q: TextEdit,
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
    /// The ship did not answer, and what shows is what was kept: how long ago it was kept.
    offline: Option<String>,
    /// The saves that could not reach the ship and wait to be sent, one for each page, as the file beside the session holds them.
    queue: api::Queue,
    /// The page a save on its way carries, and the revision it was written over: put by if the ship does not answer.
    save_sent: Option<(Page, u64, bool)>,
    /// The saves that waited, on their way to the ship: each as it was sent, and how it came out.
    drain_req: Latest<Drained>,
    /// The deletes and moves made with the ship away, waiting in the order they were made.
    ops: Vec<api::QueuedOp>,
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

/// Puts the tree in the order asked for: folders first, then by name, from the end when `desc`.
fn sort_files(m: &mut Files, desc: bool) {
    m.sort_by(|a, b| head::order((a.dir, head::sort_key(&a.path, &a.name)), (b.dir, head::sort_key(&b.path, &b.name)), desc));
}

/// The folders of shared with me as they stand now, each open or shut, to leave them so when the tree is made again.
fn shared_shut(s: &App) -> Vec<(String, bool)> {
    let mut ids = vec![swm::ROOT.to_owned()];
    for (h, entries) in swm::hosts(&s.shared) {
        ids.push(swm::host_id(h));
        ids.extend(entries.into_iter().filter(|sh| swm::is_dir(&sh.path)).map(swm::row_id));
    }
    ids.into_iter().filter(|id| s.files.contains(id)).map(|id| (s.files.is_expanded(&id), id)).map(|(open, id)| (id, open)).collect()
}

/// Puts shared with me at the foot of the pages' tree, as the web client
/// draws it: the folder, a folder for each ship, and each entry by its
/// name there. A folder shared whole unfolds to its pages, shut until
/// opened. It stands only while something is shared, and never among the memories.
fn graft_shared(s: &mut App, was: &[(String, bool)]) {
    if s.memory || s.files.contains(swm::ROOT) || s.shared.is_empty() {
        return;
    }
    let (list, folds, m) = (&s.shared, &s.folds, &mut s.files);
    let open = |id: &str, unless: bool| was.iter().find(|(x, _)| x == id).map_or(unless, |(_, o)| *o);
    let node = |name: &str, path: &str, dir: bool| FileNode { name: name.to_owned(), path: path.to_owned(), dir, data: None };
    m.insert(None, swm::ROOT, node(swm::LABEL, swm::ROOT, true));
    for (host, entries) in swm::hosts(list) {
        let hid = swm::host_id(host);
        m.insert(Some(swm::ROOT), hid.clone(), node(host, &hid, true));
        for sh in entries {
            let id = swm::row_id(sh);
            let dir = swm::is_dir(&sh.path);
            m.insert(Some(hid.as_str()), id.clone(), node(&swm::name(&sh.path), &id, dir));
            if dir {
                for p in folds.get(&id).map_or(&[][..], Vec::as_slice) {
                    let pid = swm::page_id(sh, &p.key);
                    m.insert(Some(id.as_str()), pid.clone(), node(&swm::page_label(&p.key, &p.title), &pid, false));
                }
                m.set_expanded(&id, open(&id, false));
            }
        }
        m.set_expanded(&hid, open(&hid, true));
    }
    m.set_expanded(swm::ROOT, open(swm::ROOT, true));
}

/// Reads the pages of each folder shared whole, one request after
/// another off the window's thread. A folder that does not read has no pages under it.
// ponytail: every folder is read when the list lands, a dozen at most. Read one when it is first opened if lists grow long
fn load_folds(s: &mut App) {
    let dirs: Vec<(String, String, String)> = s.shared.iter().filter_map(|sh| swm::folder(&sh.path).map(|f| (swm::row_id(sh), sh.host.clone(), f.to_owned()))).take(12).collect();
    let Some(c) = s.conn.clone().filter(|_| !dirs.is_empty()) else { return };
    s.folds_req.request((c, dirs), |(c, dirs)| dirs.into_iter().filter_map(|(id, host, folder)| c.folder_pages(&host, &folder).ok().map(|pages| (id, pages))).collect());
}

/// A row of shared with me, pressed: a page is read from its host, and a
/// folder, or a page of one, at its address. The folder itself and a ship's only fold.
fn open_shared(s: &mut App, id: &str) {
    let Some((sh, page)) = swm::at(&s.shared, id).map(|(sh, page)| (sh.clone(), page.map(str::to_owned))) else { return };
    match swm::row_address(&sh, page.as_deref()) {
        Some(url) => urb_go(s, Some(url)),
        None => open_remote(s, sh),
    }
}

/// Takes an entry off shared with me. Nothing is deleted: the page is its
/// host's, and the grant stands. It comes back if it is shared again.
fn forget_shared(s: &mut App, sh: Shared) {
    match s.conn.clone() {
        Some(c) => s.op_req.request((c, sh), |(c, sh)| {
            c.shared_forget(&sh)?;
            Ok(Op::Forgot(format!("removed {} from shared with me. Nothing was deleted: it is {}'s", swm::name(&sh.path), sh.host)))
        }),
        None => {
            s.shared.retain(|x| *x != sh);
            redraw_tree(s, false);
        }
    }
}

fn files_of(nodes: Vec<Node>, keep: &Files, desc: bool) -> Files {
    let shown: Vec<(String, String)> = nodes.iter().filter(|n| !n.dname.is_empty()).map(|n| (n.path.clone(), n.dname.clone())).collect();
    // a folder with no page in it is a row too
    let dirs: Vec<String> = nodes.iter().filter(|n| !n.page).map(|n| n.path.clone()).collect();
    let pages: Vec<Node> = nodes.into_iter().filter(|n| n.page).collect();
    // a refreshed tree keeps what was open and selected
    let open: Vec<String> = pages
        .iter()
        .flat_map(|n| n.path.match_indices('/').map(|(i, _)| n.path[..i].to_owned()))
        .filter(|d| keep.is_expanded(d))
        .collect();
    let mut m = FileTree::new().build(pages.into_iter().map(|n| (n.path.clone(), n)));
    let mut added = false;
    for dir in &dirs {
        let mut parent: Option<&str> = None;
        for path in head::chain(dir) {
            if !m.contains(path) {
                let name = path.rsplit('/').next().unwrap_or(path).to_owned();
                added |= m.insert(parent, path, FileNode { name, path: path.to_owned(), dir: true, data: None });
            }
            parent = Some(path);
        }
    }
    // the tree is built in name order, but a row put in by hand went last
    if added || desc {
        sort_files(&mut m, desc);
    }
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
        anon: false,
        read_save: false,
        #[cfg(unix)]
        engine: None,
        anon_reading: None,
        anon_seq: 0,
        anon_tick: 0.0,
        anon_got: Default::default(),
        #[cfg(unix)]
        id_got: Default::default(),
        #[cfg(unix)]
        id_busy: "",
        #[cfg(unix)]
        id_known: (None, false),
        url,
        code: TextEdit::new(""),
        login_err: String::new(),
        lapsed: false,
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
        // open from the start, as the web client's is
        inspector: PaneState::new(280.0).range(200.0, 420.0),
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
        prefs: Prefs::load_for(conn.as_ref().map_or("", |c| c.url.as_str())),
        ships: api::ships(),
        ships_open: false,
        seen: Default::default(),
        watch_stop: Default::default(),
        adding: false,
        restored: false,
        want: None,
        folder: None,
        dnames: HashMap::new(),
        shares: HashMap::new(),
        dshares: HashMap::new(),
        sharing: false,
        // the pane opens on the page's outgoing links, which cost no request
        pane: rpane::Tab::Out,
        outline_at: None,
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
        comments_total: 0,
        comment_sending: false,
        comment_undo: None,
        page_held: HashMap::new(),
        thread: None,
        thread_req: Latest::default(),
        comment_req: Latest::default(),
        switch_req: Latest::default(),
        comment_for: String::new(),
        drafts: HashMap::new(),
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
        urb: TextEdit::new(""),
        urb_req: Latest::default(),
        urb_folder: None,
        nav: browse::Nav::default(),
        sugg: Vec::new(),
        sugg_at: None,
        sugg_req: Latest::default(),
        visits: Vec::new(),
        visits_req: Latest::default(),
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
        core_agents: Vec::new(),
        core_req: Latest::default(),
        trash: None,
        trash_req: Latest::default(),
        know_req: Latest::default(),
        read_as: None,
        forum: None,
        settings: None,
        beacon: Default::default(),
        beacon_state: api::BeaconState::default(),
        beacon_stop: Default::default(),
        vim: vim::Vim::default(),
        keys_req: Latest::default(),
        set_req: Latest::default(),
        stack_req: Latest::default(),
        local_req: Latest::default(),
        mounts: Vec::new(),
        backups: Vec::new(),
        bk_req: Latest::default(),
        bk_said: String::new(),
        bk_next: 0.0,
        mount_req: Latest::default(),
        vault_req: Latest::default(),
        vault_said: String::new(),
        forum_req: Latest::default(),
        board_theme: None,
        board_theme_req: Latest::default(),
        notes_req: Latest::default(),

        sheet: None,
        map: None,
        trail: Vec::new(),
        trail_at: 0,
        tabs: vec![Tab::default()],
        tab: 0,
        tgroups: Vec::new(),
        front_at: 0,
        group_share: Vec::new(),
        group_rects: Vec::new(),
        tab_rects: Vec::new(),
        front_rect: [0.0; 4],
        group_drag: std::array::from_fn(|_| rune_kit::shell::TabDragState::new()),
        share_base: None,
        edit_room: 0.0,
        split_down: false,
        groups_room: (0.0, 0.0),
        resync: false,
        find: None,
        find_at: 0,
        image_cache: None,
        pics: HashMap::new(),
        pics_failed: std::collections::HashSet::new(),
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
        dirs: Vec::new(),
        over: None,
        squery: TextEdit::new(""),
        shits: Vec::new(),
        sfound: 0,
        sskipped: 0,
        search_at: None,
        page_menu: false,
        tree_menu: None,
        tab_drag: rune_kit::shell::TabDragState::new(),
        marks: None,
        marks_req: Latest::default(),
        links: HashMap::new(),
        folds: HashMap::new(),
        folds_req: Latest::default(),
        theme_req: Latest::default(),
        next_theme: 0.0,
        font_set: APP_FONT.to_owned(),
        theme_put: Latest::default(),
        accent_hex: TextEdit::new(""),
        theme_draft: None,
        link_open: None,
        #[cfg(not(target_arch = "wasm32"))]
        web: WebShow::default(),
        #[cfg(not(target_arch = "wasm32"))]
        upd: Updater::new(),
        marks_bad: false,
        marks_q: TextEdit::new(""),
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
        offline: None,
        queue: conn.as_ref().map(Conn::queue).unwrap_or_default(),
        save_sent: None,
        drain_req: Latest::default(),
        ops: conn.as_ref().map(Conn::ops).unwrap_or_default(),
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
        s.files = files_of(sample_nodes(), &Files::default(), s.prefs.sort_desc);
        s.files.expand_all();
        s.note = "sample pages, kept only while the window is open".into();
        // a page another ship shared, to open from the list
        s.shared = vec![Shared { host: "~sampel-palnet".into(), path: "/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app/page/plans/trip/code".into(), mode: "edit".into(), when: "~2026.11.16..18.5.0".into() }];
        // and one shared read-only, whose host can be asked for more
        s.shared.push(Shared { host: "~sampel-palnet".into(), path: "/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app/page/plans/budget/code".into(), mode: "read".into(), when: "~2026.11.16..8.0.0".into() });
        redraw_tree(s, true);
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
        s.other.0 = files_of(s.other.1.iter().map(|p| Node { path: p.clone(), page: true, kind: "md".into(), rev: 0, body: None, ..Node::default() }).collect(), &Files::default(), s.prefs.sort_desc);
        s.other.0.expand_all();
        s.know_meta.insert("feedback/short-answers".into(), (vec!["style".into()], "~2026.11.17..9.30.0".into()));
    }
}

/// Switches between pages and memories. Nothing is open after it, and the
/// trail of visits starts again: a name means one thing in each half.
fn flip(s: &mut App) {
    if !leave_edit(s) {
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
        s.know_req.request(c.clone(), |c| c.know_all());
        // and the core rules agent keys wrote, for the notice over the memories
        s.core_req.request(c, |c| c.know_core_agents());
    }
}

/// Whether the notice of core rules agent keys wrote is showing: there is one the owner has not dismissed it for.
fn core_notice(s: &App) -> bool {
    s.core_agents.iter().any(|k| !s.prefs.core_seen.contains(k))
}

/// Keeps a core rule an agent key wrote, as the owner's from now on, or takes its core tag off.
fn core_rule(s: &mut App, name: String, keep: bool) {
    let Some(c) = s.conn.clone() else { return };
    s.op_req.request((c, name), move |(c, name)| {
        let key = format!("/{name}");
        if keep { c.know_core_keep(&key)? } else { c.know_tag(&key, "core", false)? }
        Ok(Op::Cored(if keep { format!("kept {name} as your own rule") } else { format!("{name} is not a core rule any more") }))
    });
}

/// The memories just read, as the half that shows them.
fn take_knows(s: &mut App, knows: Vec<Know>) {
    // a memory with a save that waits shows that save
    let knows = api::knows_with(knows, &s.queue);
    let was = s.memory;
    if !was {
        flip_quiet(s);
    }
    let name = |k: &Know| k.key.trim_start_matches('/').to_owned();
    s.names = knows.iter().map(name).collect();
    s.know_meta = knows.iter().map(|k| (name(k), (k.tags.clone(), k.updated.clone()))).collect();
    s.cache = knows.iter().map(|k| (name(k), Page { name: name(k), body: k.body.clone(), kind: "md".into(), rev: 0 })).collect();
    let nodes = s.names.iter().map(|p| Node { path: p.clone(), page: true, kind: "md".into(), rev: 0, body: None, ..Node::default() }).collect();
    s.files = files_of(nodes, &s.files, s.prefs.sort_desc);
    if s.over == Some(Over::Search) {
        run_search(s);
    }
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

/// Watches the ships signed in that are not in front, on one thread of its own: once a minute each
/// is asked for its notices, which says whether it answers, how many are unread, and whether its
/// session stands. Nothing else is read of them, and nothing is written to them: what waits to be
/// sent to a ship goes when it is gone to, where a refusal can be shown and settled.
fn watch_ships(s: &mut App) {
    use std::sync::atomic::Ordering;
    s.watch_stop.store(true, Ordering::Relaxed);
    if cfg!(target_arch = "wasm32") || cfg!(test) {
        return;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let Some(waker) = s.waker.clone() else { return };
        let front = s.conn.as_ref().map(|c| c.url.clone());
        let others: Vec<(String, String)> = api::ship_sessions().into_iter().filter(|(u, _)| Some(u) != front.as_ref()).collect();
        if others.is_empty() {
            return;
        }
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        s.watch_stop = stop.clone();
        let seen = s.seen.clone();
        std::thread::spawn(move || loop {
            for (url, cookie) in &others {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let got = api::ship_look(url, cookie);
                let changed = seen.lock().map(|mut m| m.insert(url.clone(), got.clone()) != Some(got)).unwrap_or(false);
                if changed {
                    waker();
                }
            }
            // a minute between looks, let go of at once when the ship in front changes
            for _ in 0..60 {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        });
    }
}

/// What the watcher saw of a ship, in a few words for the list of ships. Nothing for a ship that
/// answers with nothing new.
fn ship_news(seen: Option<&api::ShipSeen>) -> String {
    let Some(x) = seen else { return String::new() };
    let mut out = Vec::new();
    if x.expired {
        out.push("sign in again".to_owned());
    } else if !x.up {
        out.push("not answering".to_owned());
    }
    if x.unread > 0 {
        out.push(format!("{} unread", x.unread));
    }
    if x.waiting > 0 {
        out.push(format!("{} waiting to be sent", x.waiting));
    }
    out.join(" \u{b7} ")
}

/// The folders mounted over HTTP with the session of the ship in front, or of any ship signed in.
/// A ship mounted by its own socket on this computer needs no session, and is not among them.
fn ship_mounts(s: &App, all: bool) -> Vec<mounts::MountSpec> {
    let front = s.conn.as_ref().map(|c| c.url.as_str());
    s.mounts.iter().filter(|m| !m.url.is_empty() && (all || Some(m.url.as_str()) == front)).cloned().collect()
}

/// Sign out, asked for: at once when nothing of the ship's is mounted, and after a question when
/// something is, since its folder goes with its session.
fn sign_out_asked(s: &mut App, all: bool) {
    s.ships_open = false;
    if ship_mounts(s, all).is_empty() {
        if all { sign_out_all(s) } else { sign_out(s) }
    } else {
        s.prompt = Some(Prompt::ShipOut(all));
    }
}

/// Signs out of the ship in front. Another ship signed in comes to the front in its place: the
/// one used most lately. With none, the window is at its sign-in.
fn sign_out(s: &mut App) {
    Conn::forget();
    reset(s, true);
}

/// Signs out of every ship.
fn sign_out_all(s: &mut App) {
    api::ships_forget();
    reset(s, false);
}

/// Goes to another ship signed in: its tree, its tabs and its last page, as they were left.
fn switch_ship(s: &mut App, url: &str) {
    if s.conn.as_ref().is_some_and(|c| c.url == url) {
        s.ships_open = false;
        return;
    }
    // what is being typed is saved or kept first, as before any other page is opened
    if !leave_edit(s) {
        return;
    }
    if !api::ship_bring(url) {
        s.note = "that ship is not signed in on this computer any more".into();
        return;
    }
    reset(s, true);
    if let Some(c) = &s.conn {
        s.note = format!("now on {}", c.ship());
    }
}

/// Builds the window's state again from what is kept: for the ship now in front when `signed`,
/// or for no ship. Everything the window held of the ship before is let go.
fn reset(s: &mut App, signed: bool) {
    let mut fresh = init();
    if !signed {
        fresh.conn = None;
        fresh.prefs = Prefs::load();
    }
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
    fresh.thread_req = std::mem::take(&mut s.thread_req);
    fresh.comment_req = std::mem::take(&mut s.comment_req);
    fresh.switch_req = std::mem::take(&mut s.switch_req);
    fresh.shared_req = std::mem::take(&mut s.shared_req);
    fresh.remote_req = std::mem::take(&mut s.remote_req);
    fresh.old_req = std::mem::take(&mut s.old_req);
    fresh.sidebar = s.sidebar.clone();
    // the reader's comet is this computer's, not a session's: its thread and its store stay as they are
    #[cfg(unix)]
    {
        fresh.engine = s.engine.take();
        (fresh.id_got, fresh.id_busy) = (s.id_got.clone(), s.id_busy);
    }
    // the listener of the session that ended stops, and every request this window keeps is woken as before
    s.beacon_stop.store(true, std::sync::atomic::Ordering::Relaxed);
    s.watch_stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let waker = s.waker.clone();
    *s = fresh;
    if let Some(w) = waker {
        setup(s, w);
    }
}

/// Asks the ship for the change the open prompt names.
fn confirm(s: &mut App) {
    let Some(p) = s.prompt.take() else { return };
    #[cfg(unix)]
    let p = match id_confirm(s, p) {
        Some(p) => p,
        None => return,
    };
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
    if let Prompt::ForumTags(t) = &p {
        match api::forum_tags(&t.text) {
            Ok(tags) => forum_act(s, ForumAct::Tags(tags)),
            Err(why) => {
                // what was typed stays, to be put right
                s.note = why;
                s.prompt = Some(p);
            }
        }
        return;
    }
    if let Prompt::Publish(mode, quiet) = &p {
        // only a publish that goes ahead puts the asking aside: ticking it and backing out must not make the next one silent
        if *quiet {
            s.prefs.pub_ok = true;
            s.prefs.save();
        }
        share_now(s, mode);
        open_share(s);
        return;
    }
    if let Prompt::LinkIn(sh, t) = &p {
        link_in(s, sh.clone(), t.text.trim().to_owned());
        return;
    }
    if let Prompt::MarkMove(url, t) = &p {
        mark_change(s, marks::Change::Move(url.clone(), t.text.trim().to_owned()));
        return;
    }
    if let Prompt::Forget(sh) = &p {
        forget_shared(s, sh.clone());
        return;
    }
    if let Prompt::MarkDrop(url, _) = &p {
        mark_change(s, marks::Change::Drop(url.clone()));
        return;
    }
    if let Prompt::KeyRevoke(id, _) = &p {
        keys_do(s, None, Some(id.clone()));
        return;
    }
    if let Prompt::Restore(a) = p {
        let Some(c) = s.conn.clone() else { return };
        s.vault_said = "restoring\u{2026}".into();
        s.vault_req.request((c, a), |(c, a)| (c.vault_restore(&a).0, true));
        return;
    }
    if let Prompt::BoardDelete(name) = &p {
        if let Some(c) = s.conn.clone() {
            s.forum_req.request((c, name.clone()), |(c, name)| {
                c.forum_board_delete(&name)?;
                c.forum_boards().map(ForumGot::Changed)
            });
        }
        return;
    }
    if let Prompt::ForumDelete(comment) = &p {
        forum_act(s, ForumAct::Delete(*comment));
        return;
    }
    if let Prompt::ForumRowDelete(board, post) = &p {
        forum_list_act(s, board.clone(), *post, ForumAct::Delete(None));
        return;
    }
    if let Prompt::CommentRemove(page, id) = &p {
        if let Some(c) = s.conn.clone() {
            s.op_req.request((c, page.clone(), id.clone()), |(c, page, id)| {
                c.comment_delete(&page, &id)?;
                Ok(Op::Commented(format!("removed a comment from {page}")))
            });
        }
        return;
    }
    if let Prompt::Kind(t) = &p {
        let kind = kind_typed(&t.text);
        let Some(open) = s.open.clone() else { return };
        match kind {
            None => {
                s.note = format!("a page is one of: {}", PAGE_KINDS.join(", "));
                s.prompt = Some(p);
            }
            Some(k) if k == open.kind => s.note = format!("{} is {} already", open.name, kind_said(k)),
            Some(k) => {
                // the same text, kept as another kind: the ship takes the kind a save names
                s.note = format!("{} is now {}", open.name, kind_said(k));
                let body = open.body.clone();
                save_body(s, Page { kind: k.to_owned(), ..open }, body);
            }
        }
        return;
    }
    if let Prompt::ShipOut(all) = &p {
        let all = *all;
        // the folders are let go of first, so the next start finds none to make again with a session that is gone
        let gone = ship_mounts(s, all);
        let rest: Vec<mounts::MountSpec> = s.mounts.iter().filter(|m| !gone.contains(m)).cloned().collect();
        let _ = mounts::save(&rest);
        spawn(move || {
            for m in gone {
                let _ = mounts::stop(&m);
            }
        });
        if all { sign_out_all(s) } else { sign_out(s) }
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
        Prompt::New(t) | Prompt::Rename(_, t) | Prompt::NewFolder(t) => Some(t.text.clone()),
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
        Prompt::NewFolder(_) if s.memory => return,
        Prompt::NewFolder(_) if s.offline.is_some() => {
            s.note = "a new folder needs the ship, which does not answer".into();
            return;
        }
        Prompt::NewFolder(_) if rn.name.is_empty() => return,
        Prompt::NewFolder(_) => Op::FolderMade(rn.name.clone()),
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
    // with the ship away a page's delete, move or making waits on this device, as a save does
    if s.offline.is_some() && !memory && matches!(op, Op::Created(_) | Op::Renamed(..) | Op::Deleted(_)) {
        let Some(c) = s.conn.clone() else { return };
        let (mut ops, mut saves) = (s.ops.clone(), s.queue.clone());
        match &op {
            Op::Created(n) if s.names.contains(n) => {
                s.note = "there is a page of that name".into();
                return;
            }
            // a page made away is a save that waits as a new page, with the heading a page starts with
            Op::Created(n) => {
                let made = Page { name: n.clone(), body: format!("# {}\n", if rn.dname.is_empty() { n.rsplit('/').next().unwrap_or(n) } else { rn.dname.as_str() }), kind: "md".into(), rev: 0 };
                api::enqueue(&mut saves, &made, 0, true, 0);
                s.cache.insert(n.clone(), made);
            }
            Op::Renamed(a, b) => api::enqueue_op(&mut ops, &mut saves, api::QueuedOp::Move { from: a.clone(), to: b.clone(), dname: rn.dname.clone(), dnames: rn.dnames.clone() }),
            Op::Deleted(n) => api::enqueue_op(&mut ops, &mut saves, api::QueuedOp::Del(n.clone())),
            _ => unreachable!("matched above"),
        }
        if let Err(e) = c.store_ops(&ops).and_then(|()| c.store_queue(&saves)) {
            s.note = format!("not done: the ship does not answer, and this could not be kept on this device to send later ({e})");
            return;
        }
        (s.ops, s.queue) = (ops, saves);
        applied(s, op);
        s.note = "done on this device, to send when the ship answers".into();
        return;
    }
    match s.conn.clone() {
        Some(c) => s.op_req.request((c, op), move |(c, op)| {
            match &op {
                Op::Created(n) if memory => c.know_save(&format!("/{n}"), &format!("{}\n", n.rsplit('/').next().unwrap_or(n)))?,
                Op::Deleted(n) if memory => c.know_delete(&format!("/{n}"))?,
                Op::Renamed(a, b) if memory => c.know_move(&format!("/{a}"), &format!("/{b}"))?,
                Op::Created(_) => c.create_as(&rn)?,
                Op::FolderMade(_) => c.folder_new(&rn)?,
                Op::Renamed(a, _) => c.rename_as(a, &rn)?,
                Op::Deleted(n) => c.delete(n)?,
                Op::Shared(n, mode) => c.share(n, mode)?,
                Op::Cored(..) | Op::Restored(..) | Op::Tagged(..) | Op::Granted(..) | Op::Ungranted(..) | Op::Grouped(..) | Op::SharedDir(..) | Op::Sensed(..) | Op::Commented(..) | Op::Posted(..) | Op::SentRemote(..) | Op::Asked(..) | Op::Templated(..) | Op::Uploaded(..) | Op::Said(..) | Op::Wrote(..) | Op::Tokened(..) | Op::MapIn(..) | Op::Marks(..) | Op::Linked(..) | Op::Unlinked(..) | Op::Forgot(..) => {}
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
        Op::Forgot(say) => {
            s.note = say;
            load_shared(s);
            return;
        }
        Op::Linked(to, host) => {
            // the page is the tree's now: it opens there once the tree is read, and the entry is gone from shared with me
            s.note = format!("moved into {to}, linked from {host}");
            s.remote = None;
            s.open = None;
            s.land = Some(to);
            load_shared(s);
        }
        Op::Unlinked(name) => {
            s.note = format!("moved {name} back to shared with me");
            s.names.retain(|n| *n != name);
            s.cache.remove(&name);
            s.links.remove(&name);
            if s.open.as_ref().is_some_and(|p| p.name == name) {
                s.open = None;
            }
            load_shared(s);
        }
        Op::Marks(say, list) => {
            (s.note, s.marks, s.marks_bad) = (say, Some(list), false);
            return;
        }
        Op::FolderMade(n) => {
            if !s.dirs.contains(&n) {
                s.dirs.push(n.clone());
            }
            // the folder is what shows, as when its row is pressed: a page can be made in it from there
            if !s.editing {
                (s.open, s.old, s.want, s.remote) = (None, None, None, None);
                s.folder = Some(n);
            }
            s.note = "folder created".into();
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
        Op::Cored(say) => {
            s.note = say;
            load_know(s);
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
        Op::Posted(say, page, body) => {
            s.note = say;
            // landed: only now is what was typed let go
            sent_draft(s, &page, &body);
            load_comments(s);
            return;
        }
        Op::SentRemote(url, body, told) => {
            sent_draft(s, &url, &body);
            let ours = s.conn.as_ref().map(|c| c.ship().to_owned()).unwrap_or_default();
            let Some(t) = s.thread.as_mut().filter(|t| t.url == url) else {
                s.note = "comment sent".into();
                return;
            };
            s.note = if told { format!("sent to {}", t.ship) } else { format!("{} has not said it took the comment yet", t.ship) };
            // how many like it were there already: it has shown when there is one more
            let had = like_ours(&t.list, &ours, &body);
            t.sent = Some((body, told, had));
            // the thread is read again, a moment after: the host writes the comment in a step of its own
            if let Some(c) = s.conn.clone() {
                s.thread_req.request((c, url), |(c, url)| {
                    api::pause(std::time::Duration::from_millis(2500));
                    thread_of(&c, &url).map(|l| (url, l))
                });
            }
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

/// Draws the tree again from what is held here, with no ship asked: the
/// pages and folders known, and shared with me at its foot. `all` opens
/// every folder, as a tree first drawn with no ship is. Otherwise each stays as it was.
fn redraw_tree(s: &mut App, all: bool) {
    let mut nodes: Vec<Node> = s.names.iter().map(|p| Node { path: p.clone(), page: true, kind: s.cache.get(p).map_or_else(|| "md".into(), |c| c.kind.clone()), rev: 1, dname: s.dnames.get(p).cloned().unwrap_or_default(), ..Node::default() }).collect();
    // the folders that were given a name to show
    nodes.extend(s.dnames.iter().filter(|(p, _)| !s.names.contains(p)).map(|(p, d)| Node { path: p.clone(), dname: d.clone(), ..Node::default() }));
    if !s.memory {
        nodes.extend(s.dirs.iter().filter(|d| !s.dnames.contains_key(*d)).map(|d| Node { path: d.clone(), ..Node::default() }));
    }
    let shut = shared_shut(s);
    s.files = files_of(nodes, &s.files, s.prefs.sort_desc);
    if s.over == Some(Over::Search) {
        run_search(s);
    }
    if all {
        s.files.expand_all();
    }
    graft_shared(s, &shut);
    if let Some(p) = &s.open {
        s.files.select(&p.name);
    }
    if !s.query.text.trim().is_empty() {
        refilter(s);
    }
}

/// Shows the tree as it now stands: read again from the ship, or built
/// from the names on sample pages.
fn refresh_tree(s: &mut App) {
    if s.conn.is_some() && s.memory {
        load_know(s);
    } else if s.conn.is_some() && s.offline.is_none() {
        load_tree(s);
    } else {
        // no ship to ask, or none that answers: the tree is drawn again from what is here.
        // Every folder is opened only when there was no tree yet: after that they are the reader's
        let none_yet = s.files.is_empty();
        redraw_tree(s, none_yet);
        // sample pages have no tree to wait for: what was just made is shown now
        if let Some(name) = s.land.take() {
            land_on(s, &name);
        }
    }
}

fn setup(s: &mut App, waker: Waker) {
    s.image_cache = Some(std::rc::Rc::new(rune::ImageCache::new(waker.clone())));
    #[cfg(not(target_arch = "wasm32"))]
    {
        s.web.html = Some(htmlview::Html::start(waker.clone()));
        s.upd.check_req.set_waker(waker.clone());
        s.upd.get_req.set_waker(waker.clone());
    }
    s.waker = Some(waker.clone());
    s.tree_req.set_waker(waker.clone());
    s.page_req.set_waker(waker.clone());
    s.save_req.set_waker(waker.clone());
    s.drain_req.set_waker(waker.clone());
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
    s.forum_req.set_waker(waker.clone());
    s.board_theme_req.set_waker(waker.clone());
    s.keys_req.set_waker(waker.clone());
    s.urb_req.set_waker(waker.clone());
    s.set_req.set_waker(waker.clone());
    s.stack_req.set_waker(waker.clone());
    s.local_req.set_waker(waker.clone());
    s.mount_req.set_waker(waker.clone());
    s.vault_req.set_waker(waker.clone());
    s.bk_req.set_waker(waker.clone());
    s.backups = backups::load();
    s.notes_req.set_waker(waker.clone());
    s.core_req.set_waker(waker.clone());
    s.trash_req.set_waker(waker.clone());
    s.tex_req.set_waker(waker.clone());
    s.scad_req.set_waker(waker.clone());
    s.part_req.set_waker(waker.clone());
    s.asks_req.set_waker(waker.clone());
    s.waiting_req.set_waker(waker.clone());
    s.comets_req.set_waker(waker.clone());
    s.thread_req.set_waker(waker.clone());
    s.comment_req.set_waker(waker.clone());
    s.switch_req.set_waker(waker.clone());
    s.shared_req.set_waker(waker.clone());
    s.marks_req.set_waker(waker.clone());
    s.theme_req.set_waker(waker.clone());
    s.folds_req.set_waker(waker.clone());
    s.sugg_req.set_waker(waker.clone());
    s.visits_req.set_waker(waker.clone());
    s.theme_put.set_waker(waker.clone());
    s.remote_req.set_waker(waker.clone());
    s.old_req.set_waker(waker.clone());
    s.op_req.set_waker(waker);
    load_tree(s);
    load_know(s);
    load_shared(s);
    listen(s);
    watch_ships(s);
    // the mounts kept from the run before: still there, or made again. Not on sample pages, which keep nothing
    let kept = mounts::load();
    if !kept.is_empty() && !s.sample {
        s.mount_req.request((kept, s.conn.clone()), |(kept, conn)| {
            let (mut list, mut said) = (Vec::new(), Vec::new());
            // a ship over HTTP is mounted again with its own session, whichever ship is in front: any
            // ship signed in on this computer, and the one this window was started on
            let signed = api::ship_sessions();
            let session = |url: &str| conn.as_ref().filter(|c| c.url == url).map(|c| c.cookie.clone()).or_else(|| signed.iter().find(|(u, _)| u == url).map(|(_, c)| c.clone()));
            for (m, r) in mounts::resume(kept, session) {
                if let Err(e) = r {
                    said.push(format!("{} was not mounted again: {e}", m.mountpoint));
                }
                list.push(m);
            }
            let _ = mounts::save(&list);
            (list, said.join(". "))
        });
    }
}

/// Starts listening to the ship's change stream, in place of asking it
/// every half minute (`ui-src/lattice/90-sync.js`). The stream ends about
/// every eighty seconds and is taken up again at once. One that does not
/// hold is tried again more slowly, up to thirty seconds apart. Each
/// event is left for the window to take, and the window is woken.
/// A job off the window's thread. A browser page has the one thread, so there it runs at once.
fn spawn(f: impl FnOnce() + Send + 'static) {
    #[cfg(target_arch = "wasm32")]
    f();
    #[cfg(not(target_arch = "wasm32"))]
    drop(std::thread::spawn(f));
}

fn listen(s: &mut App) {
    use std::sync::atomic::Ordering;
    // a browser page has one thread and no stream to wait on: the tree is read again on its timer
    if cfg!(target_arch = "wasm32") {
        return;
    }
    // a listener for a session before this one stops at its next event
    s.beacon_stop.store(true, Ordering::Relaxed);
    let (Some(c), Some(waker)) = (s.conn.clone(), s.waker.clone()) else { return };
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    s.beacon_stop = stop.clone();
    s.beacon_state = api::BeaconState::default();
    let heard = s.beacon.clone();
    std::thread::spawn(move || {
        let (mut fail, mut base) = (0u32, None::<String>);
        while !stop.load(Ordering::Relaxed) {
            let began = std::time::Instant::now();
            if base.is_none() {
                base = c.lat_base().ok();
            }
            let got = match &base {
                Some(b) => c.beacon_stream(b, |ev| {
                    heard.lock().unwrap().push(ev);
                    waker();
                    !stop.load(Ordering::Relaxed)
                }),
                None => Err("no base".into()),
            };
            // a stream refused may be an install that moved: where it lives is asked again
            if got.is_err() {
                base = None;
            }
            heard.lock().unwrap().push(api::Beacon::Down);
            waker();
            let (registered, bumped) = got.unwrap_or((false, false));
            fail = api::beacon_fail(fail, registered, began.elapsed().as_millis(), bumped);
            let jitter = f64::from(crate::api::since_epoch().map_or(0, |d| d.subsec_nanos())) / 1e9;
            let until = std::time::Instant::now() + std::time::Duration::from_millis(api::beacon_wait(fail, jitter));
            while std::time::Instant::now() < until && !stop.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
    });
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
    if !leave_edit(s) {
        return;
    }
    // the page to open again next run. Only a ship's: sample pages are not kept
    if !s.memory && s.prefs.recent.first().map(String::as_str) != Some(name) {
        s.prefs.last = name.to_owned();
        s.prefs.opened(name);
        save_prefs(s);
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
    if !leave_edit(s) {
        return;
    }
    s.trail_at = at;
    let name = s.trail[at].clone();
    // marked in the tree, with its folders left as the reader has them
    s.files.select(&name);
    show_page(s, &name);
}

/// Follows a link in a page: to a page of this ship, to a prompt that makes
/// the page when there is none yet, or to the web.
fn follow(s: &mut App, url: &str, tx: &mut Tx) {
    // an address on the network is read here, in the browser, not handed to the system
    let there = s.remote.as_ref().filter(|r| r.mode == "published").and_then(|sh| remote_link(&sh.host, sh.name(), url));
    let to = there.or_else(|| url.starts_with("urb://").then(|| url.to_owned()));
    if let Some(to) = to.filter(|_| s.conn.is_some() || s.anon) {
        return urb_go(s, Some(to));
    }
    match md::page_of(url) {
        Some(name) if s.names.contains(&name) => {
            s.files.reveal(&name, tx);
            // with Ctrl (Cmd on a Mac) the link opens in a new tab
            if tx.mods().cmd { tab_for(s, &name) } else { open_page(s, &name) }
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

/// Where a link in a page another ship publishes leads, as an address: a wiki link or a path of its
/// own is a page of that ship, and a name beside it is a page beside it. None for what is not the
/// network's (the web, mail, a place in the same page).
fn remote_link(host: &str, page: &str, url: &str) -> Option<String> {
    if url.starts_with("urb://") {
        return Some(url.to_owned());
    }
    if let Some(name) = md::page_of(url) {
        return Some(format!("urb://{host}/{name}"));
    }
    if url.is_empty() || url.starts_with('#') || url.contains(':') || url.starts_with("//") {
        return None;
    }
    // beside the page, or from the ship's top when it starts with a slash
    let mut at: Vec<&str> = if url.starts_with('/') { Vec::new() } else { page.split('/').collect::<Vec<_>>().split_last().map(|(_, dir)| dir.to_vec()).unwrap_or_default() };
    for seg in url.split(['#', '?']).next().unwrap_or_default().split('/') {
        match seg {
            "" | "." => {}
            ".." => drop(at.pop()),
            seg => at.push(seg),
        }
    }
    (!at.is_empty()).then(|| format!("urb://{host}/{}", at.join("/")))
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

/// Keeps each group that is not in front in step with the page it
/// shows: a sheet as its grid, a map as its shapes, an HTML or gemtext
/// page as it is read.
fn sync_beside(s: &mut App) {
    for d in 0..s.tgroups.len() {
        let page = s.tgroups[d].page().filter(|_| d != s.front_at).and_then(|n| s.cache.get(n));
        let Some(p) = page else {
            s.tgroups[d].view = None;
            continue;
        };
        if s.tgroups[d].view.as_ref().is_some_and(|(n, rev, _)| *n == p.name && *rev == p.rev) {
            continue;
        }
        // the sheet that was showing stays the one showing through a change
        let old = s.tgroups[d].view.take().filter(|(n, ..)| *n == p.name);
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
        s.tgroups[d].view = view.map(|v| (p.name.clone(), p.rev, v));
    }
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
        // its pin: the one chosen for it here, else its own, else its kind's. A point with one is larger, to hold it
        let pin = pins::icon(pins::worn(map::pin_of(f.icon), pin_key(f).and_then(|id| s.prefs.pins.get(id)).map(String::as_str)));
        let r = if pin.is_none() { 6.0 } else { 11.0 } + if on { 2.0 } else { 0.0 };
        view = view.child(
            el().key(format!("dot-{n}"))
                .absolute(x - r, y - r)
                .size(r * 2.0, r * 2.0)
                .radius(r)
                .center()
                .fill(rune::color::hex(&f.color).unwrap_or(ink))
                .children(pin.map(|i| rune::icon(i, 14.0).color(rune::Color::WHITE).inert()))
                .border(2.0, c.bg_base)
                .label(m.feats[i].name.clone())
                // its name is said under the pointer, and drawn only for the one picked: every name at once is a crowd
                .help(m.feats[i].name.clone())
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
        if on && !m.feats[i].name.is_empty() {
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
            for (name, _) in map::ICONS {
                let b = match pins::icon(name) {
                    Some(i) => IconButton::new(i).variant(IconButtonVariant::GhostMuted).help(name).on_press(set("icon", Some(name))).build(k),
                    None => small("•").help(name).on_press(set("icon", Some(name))).build(k),
                };
                icons = icons.child(b.key(format!("icon:{name}")));
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
        } else if let Some(id) = pin_key(f).filter(|_| f.geoms.iter().all(|g| matches!(g, map::Geom::Point(_)))).map(str::to_owned) {
            // a map that is not written to, as orrery's: the pin is chosen for this computer, by the body the point names
            let small = |label: &str| Button::new(label).control_size(ControlSize::Small).variant(ButtonVariant::Ghost);
            let mut icons = row().key("map-pins").w_full().gap(2.0).flex_wrap();
            for (name, _) in map::ICONS {
                let id = id.clone();
                let b = match pins::icon(name) {
                    Some(i) => IconButton::new(i).variant(IconButtonVariant::GhostMuted).help(name).on_press(move |s: &mut App| set_pin(s, &id, Some(name))).build(k),
                    None => small("\u{2022}").help(name).on_press(move |s: &mut App| set_pin(s, &id, Some(name))).build(k),
                };
                icons = icons.child(b.key(format!("pin:{name}")));
            }
            card = card
                .child(text("Its pin, kept on this computer. Orrery keeps this map, so the choice is not written to it.").font(k.ty.small).color(c.text_faint).wrap())
                .child(icons.child(small("Kind's pin").on_press(move |s: &mut App| set_pin(s, &id, None)).build(k).key("pin:none")));
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
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(p) = web_page(s) {
        return if s.web.laid.as_ref().is_some_and(|l| l.0.key.name == p.name) { s.web.held } else { 0 };
    }
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
        spawn(move || {
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

/// What a pin chosen here is kept by: the body a feature of orrery's map names.
fn pin_key(f: &map::Feature) -> Option<&str> {
    f.props.iter().find(|(k, _)| k == "orrery").map(|(_, v)| v.as_str()).filter(|v| !v.is_empty())
}

/// Chooses the pin a point wears on this computer, or, with none, gives it back its own.
fn set_pin(s: &mut App, id: &str, name: Option<&'static str>) {
    match name {
        Some(n) => drop(s.prefs.pins.insert(id.to_owned(), n.to_owned())),
        None => drop(s.prefs.pins.remove(id)),
    }
    save_prefs(s);
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
        spawn(move || {
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
            (Err(e), _) => {
                s.note = format!("an image did not load: {e}");
                s.pics_failed.insert(src);
            }
            _ => {}
        }
    }
    any
}

/// A Markdown page as the reader shows it: wiki links, ghost links, and
/// the pictures had so far.
fn reader(body: &str, s: &App, k: &Kit, found: bool) -> El {
    let pics = s.pics.clone();
    let src = md::wikilinks(&md::html_shown(body), &|n| ghost(s, n));
    // what find matches is marked, the current one apart from the rest
    let mut marks: Vec<(Vec<std::ops::Range<usize>>, rune_kit::Highlight)> = match s.find.as_ref().filter(|_| found) {
        Some(q) => find_in(&src, &q.text).into_iter().enumerate().map(|(i, m)| (m, if i == s.find_at { rune_kit::Highlight::current() } else { rune_kit::Highlight::new() })).collect(),
        None => Vec::new(),
    };
    // the heading the outline last went to, marked so it can be brought into view and seen
    if let Some(h) = s.outline_at.and_then(|i| outline::outline(&src, "md").into_iter().nth(i)).filter(|h| !h.words.is_empty()) {
        marks.push((vec![h.words], rune_kit::Highlight::new().key("md-outline")));
    }
    Markdown::new(src).selectable(true).on_link_tx(follow).images(move |src| pics.get(src).cloned()).highlights(marks).style(page_style(k)).build(k)
}

/// How a page's Markdown is set to be read. rune-kit's own style is a chat message's, with
/// headings of 17, 15 and 13 points beside text of 14, so a third-level heading is the text's
/// size and a page looks hardly marked up at all. A page is a document: its headings step down
/// from well above the text, as they do in the editor and on the web.
fn page_style(k: &Kit) -> rune_kit::MarkdownStyle {
    let body = rune::TextStyle { line_height: 22.4, ..k.ty.body };
    let heading = |size: f32, line: f32| rune::TextStyle { size, weight: 650.0, line_height: line, ..body };
    rune_kit::MarkdownStyle::from_kit(k).heading_font(1, heading(26.0, 34.0)).heading_font(2, heading(21.0, 28.0)).heading_font(3, heading(17.0, 24.0)).heading_font(4, heading(15.0, 22.0))
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
    // a page drawn as a web page is pictures: there are no words in it to mark
    #[cfg(not(target_arch = "wasm32"))]
    if web_page(s).is_some() {
        return FindIn::Nothing;
    }
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

/// Reads which pages link to the open one when the backlinks are showing.
/// The ship's index answers. Sample pages are read here.
fn load_links(s: &mut App) {
    let Some(p) = s.open.as_ref().filter(|_| s.inspector.is_open() && s.pane == rpane::Tab::Back && !s.memory && s.remote.is_none()) else { return };
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
fn links_view(s: &App, k: &Kit, back: bool) -> El {
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
    // one tab for the links that come here and one for those that go out, as on the web
    let list = if back {
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
        here
    } else {
        let mut out = col().key("links-out").w_full().gap(2.0).child(text("Links out").font(k.ty.small_medium).color(c.text_muted));
        let outs = if p.kind == "md" { md::links(&p.body) } else { Vec::new() };
        for n in &outs {
            out = out.child(line(n, format!("out-{n}"), ghost(s, n)));
        }
        if outs.is_empty() {
            out = out.child(text("No links to other pages.").font(k.ty.small).color(c.text_faint));
        }
        out
    };
    col().key("links").w_full().h_full().min_h(0.0).padding(12.0).gap(14.0).child(list).scroll(ScrollSpec { stick_bottom: false })
}

/// Shows one of the right pane's tabs, or closes the pane when that
/// tab is the one showing. The links command takes either list of links for its own.
fn show_pane(s: &mut App, tab: rpane::Tab) {
    use rpane::Tab;
    if s.inspector.is_open() && (s.pane == tab || (tab == Tab::Out && s.pane == Tab::Back)) {
        s.inspector.set_open(false);
        return;
    }
    pane_tab(s, tab);
}

/// Brings one of the right pane's tabs to the front, and reads what it shows.
fn pane_tab(s: &mut App, tab: rpane::Tab) {
    use rpane::Tab;
    s.inspector.set_open(true);
    s.pane = tab;
    s.old = None;
    if tab == Tab::Page {
        // who it is shared with, and the groups there are to share it with
        load_groups(s);
        load_sens(s);
    }
    load_history(s);
    load_comments(s);
    load_links(s);
}

/// The open page's headings: those of what is being typed while
/// editing, and of the page as it stands otherwise.
fn outline_of(s: &App) -> Vec<outline::Heading> {
    match &s.open {
        Some(p) if s.editing => outline::outline(&s.edit.text, &p.kind),
        Some(p) => outline::outline(&p.body, &p.kind),
        None => Vec::new(),
    }
}

/// Goes to a heading: the caret to its line while editing, and the
/// reader to it, marked, while reading.
fn go_heading(s: &mut App, i: usize, tx: &mut Tx) {
    let Some(h) = outline_of(s).into_iter().nth(i) else { return };
    if s.editing {
        // the caret on the heading's line is what the field keeps in view
        s.edit.set_selection(h.at, h.at);
        s.edit.focused = true;
        tx.focus_when_shown(FIELD, false);
    } else {
        s.outline_at = Some(i);
        tx.scroll_into_view("md-outline");
    }
}

/// The Outline tab: the page's headings, set in by their level.
fn outline_view(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let said = |t: &str| col().key("outline").w_full().padding(12.0).child(text(t.to_owned()).key("outline-none").font(k.ty.small).color(c.text_muted).wrap());
    let Some(p) = &s.open else { return said("Open a page to see its headings.") };
    if !matches!(p.kind.as_str(), "md" | "gmi") {
        return said("Nothing here for this kind of page.");
    }
    let heads = outline_of(s);
    if heads.is_empty() {
        return said("No headings");
    }
    let mut rows = col().key("outline-rows").w_full().gap(1.0);
    for (i, h) in heads.iter().enumerate() {
        let on = !s.editing && s.outline_at == Some(i);
        rows = rows.child(
            row()
                .key(format!("ol-{i}"))
                .role("button")
                .label(format!("{}, heading level {}", outline::shown(h), h.level))
                .w_full()
                .h(26.0)
                .pl(6.0 + 12.0 * (h.level as f32 - 1.0))
                .pr(6.0)
                .center_y()
                .radius(k.radius.sm)
                .fill(if on { k.selection() } else { rune::Color::TRANSPARENT })
                .on_press_tx(move |s: &mut App, tx| go_heading(s, i, tx))
                .child(text(outline::shown(h).to_owned()).font(if h.level == 1 { k.ty.small_medium } else { k.ty.small }).color(if h.text.is_empty() { c.text_faint } else { c.text_base }).truncate().grow(1.0).min_w(0.0)),
        );
    }
    col().key("outline").w_full().h_full().min_h(0.0).padding(8.0).child(rows).scroll(ScrollSpec { stick_bottom: false })
}

/// The line under the page's header that says something is on its way, as
/// the web client has it: two points tall, in the accent colour, sweeping.
/// It keeps its room when there is nothing to wait for, so the page does
/// not jump, and it waits a moment before it shows, so a quick answer
/// does not flash it.
fn wait_line(on: bool, k: &Kit) -> El {
    let track = row().key("wait-line").w_full().h(2.0).clip_soft(0.0).a11y_hidden();
    if !on {
        return track;
    }
    let sweep = rune::LoopSpec { delay: 0.18, ..rune::LoopSpec::slide(1.4, [-1.0, 0.0], [4.0, 0.0]) };
    track.child(el().key("wait-sweep").h_full().w_frac(0.25).radius(999.0).fill(k.c.text_accent).looping(sweep))
}

/// Whether the HTML page in front is still being laid out or painted.
fn web_waiting(s: &App) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(p) = web_page(s) {
        let laid = s.web.laid.as_ref().is_some_and(|l| l.0.key.name == p.name && l.0.key.rev == p.rev && s.web.asked.as_ref() == Some(&l.0));
        return !laid || s.web.painting;
    }
    let _ = s;
    false
}

/// The status bar along the bottom of the window: what was last said,
/// and, for as long as each holds, that the ship is away and how much
/// waits to be sent.
fn status_bar(s: &App, k: &Kit, busy: bool) -> El {
    let c = &k.c;
    let bar = status::bar(&s.note, s.offline.as_deref(), s.queue.len() + s.ops.len(), s.conn.as_ref().map(|c| c.url.as_str()));
    let badge = |b: status::Badge, key: &str| text(b.short).key(key.to_owned()).role("status").label(b.long.clone()).help(b.long).font(k.ty.text_xsmall_medium).color(c.text_base).px(6.0).radius(k.radius.sm).fill(c.layer_02);
    let mut out = row().key("statusbar").role("status").label("Status").w_full().h(24.0).px(10.0).gap(8.0).center_y();
    if busy {
        out = out.child(Spinner::new().build(k));
    }
    // said even when there is nothing: the bar keeps its height, and the page does not jump as notes come and go
    out = out.child(text(bar.said.unwrap_or_default()).key("note").font(k.ty.small).color(c.text_muted).truncate().grow(1.0).min_w(0.0));
    out.children(bar.offline.map(|b| badge(b, "offline"))).children(bar.waiting.map(|b| badge(b, "waiting-saves")))
}

/// The right pane: its tabs as icons, then what the one in front shows.
fn right_pane(s: &App, k: &Kit) -> El {
    let own = s.open.is_some() && !s.memory && s.remote.is_none();
    // a page of another ship read by address has its public thread as well
    let thread = thread_here(s).is_some();
    // a memory, and another ship's page, have only their history, whatever was showing before
    let now = if own || (thread && s.pane == rpane::Tab::Comments) { s.pane } else { rpane::Tab::Hist };
    let mut tabs = row().key("rtabs").role("tablist").label("Right pane").w_full().gap(4.0).px(8.0).pt(8.0);
    // the tabs in the web client's order, each by the key its button in the header had
    for (what, key, name, icon) in rpane::TABS.iter().copied().filter(|t| own || t.0 == rpane::Tab::Hist || (thread && t.0 == rpane::Tab::Comments)) {
        tabs = tabs.child(IconButton::new(icon).control_size(ControlSize::Large).variant(if what == now { IconButtonVariant::Neutral } else { IconButtonVariant::GhostMuted }).help(name).on_press(move |s: &mut App| pane_tab(s, what)).build(k).key(key));
    }
    let body = match now {
        rpane::Tab::Page => match share_body(s, k) {
            Some((_, body)) => col().key("page-tab").w_full().h_full().min_h(0.0).child(col().w_full().padding(12.0).child(body)).scroll(ScrollSpec { stick_bottom: false }),
            None => col().key("page-tab").w_full().padding(12.0).child(text("Open a page to share it.").font(k.ty.small).color(k.c.text_muted).wrap()),
        },
        rpane::Tab::Outline => outline_view(s, k),
        rpane::Tab::Out => links_view(s, k, false),
        rpane::Tab::Back => links_view(s, k, true),
        rpane::Tab::Comments => comments_view(s, k),
        rpane::Tab::Hist => history_view(s, k),
    };
    col().key("rpane").w_full().h_full().min_h(0.0).child(tabs).child(col().w_full().grow(1.0).min_h(0.0).child(body))
}

/// Reads the open page's revisions when the history pane is showing.
fn load_history(s: &mut App) {
    if s.pane != rpane::Tab::Hist {
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
    s.forum = None;
    s.access = false;
    s.settings = None;
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
    // a heading marked in the page before is not this page's
    s.outline_at = None;
    if s.pane == rpane::Tab::Page && s.inspector.is_open() {
        // the Page tab follows the page: whether this one is marked sensitive
        load_sens(s);
    }
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

/// The place in a text as a count of characters, from a count of bytes, and back.
fn char_at(text: &str, byte: usize) -> usize {
    text.char_indices().take_while(|(i, _)| *i < byte).count()
}

fn byte_at(text: &str, chars: usize) -> usize {
    text.char_indices().nth(chars).map_or(text.len(), |(i, _)| i)
}

/// The editor's text and selection as vim reads them.
fn vim_buf(e: &TextEdit) -> vim::Buf {
    let (a, b) = (e.anchor.min(e.focus), e.anchor.max(e.focus));
    vim::Buf { text: e.text.chars().collect(), a: char_at(&e.text, a), b: char_at(&e.text, b) }
}

/// Puts what vim made of the text into the editor: the part that changed
/// goes in as one typed edit, so the editor's own undo takes it back,
/// and the selection is set where vim left it.
fn vim_put(e: &mut TextEdit, b: &vim::Buf) {
    let new: String = b.text.iter().collect();
    if new != e.text {
        let pre = e.text.bytes().zip(new.bytes()).take_while(|(x, y)| x == y).count();
        // back to a character's start in both
        let pre = (0..=pre).rev().find(|&i| e.text.is_char_boundary(i) && new.is_char_boundary(i)).unwrap_or(0);
        let max = (e.text.len() - pre).min(new.len() - pre);
        let suf = e.text.bytes().rev().zip(new.bytes().rev()).take(max).take_while(|(x, y)| x == y).count();
        let suf = (0..=suf).rev().find(|&i| e.text.is_char_boundary(e.text.len() - i) && new.is_char_boundary(new.len() - i)).unwrap_or(0);
        (e.anchor, e.focus) = (pre, e.text.len() - suf);
        e.insert(&new[pre..new.len() - suf]);
    }
    (e.anchor, e.focus) = (byte_at(&e.text, b.a), byte_at(&e.text, b.b));
}

/// Starts vim on a text just put in the editor: in normal mode, at the top, as a page opens on the web.
fn vim_start(s: &mut App) {
    s.vim = vim::Vim::default();
    if s.prefs.vim {
        s.edit.set_caret(0);
        vim_settle(s);
    }
}

/// Keeps the cursor on a character, as normal mode has it.
fn vim_settle(s: &mut App) {
    let mut b = vim_buf(&s.edit);
    s.vim.settle(&mut b);
    vim_put(&mut s.edit, &b);
}

/// A key as vim names it, and whether Ctrl or Cmd is held.
fn vim_key(ev: &KeyEvent) -> (String, bool) {
    let held = ev.mods.cmd || ev.mods.ctrl;
    let name = match &ev.key {
        Key::Text(t) => t.clone(),
        Key::Command(c) => return (if ev.mods.shift { c.to_ascii_uppercase().to_string() } else { c.to_string() }, true),
        Key::Enter => "Enter".into(),
        Key::Backspace => "Backspace".into(),
        Key::Escape => "Escape".into(),
        Key::Tab => "Tab".into(),
        Key::Left => "ArrowLeft".into(),
        Key::Right => "ArrowRight".into(),
        Key::Up => "ArrowUp".into(),
        Key::Down => "ArrowDown".into(),
        Key::Delete => "Delete".into(),
        Key::Home => "Home".into(),
        Key::End => "End".into(),
        // a key vim has no name for: in normal mode it is swallowed like any other it does not bind
        _ => "Unidentified".into(),
    };
    (name, held)
}

/// Gives a key to vim. `true` when vim took it. What vim asks for beside the text (a save, an undo) is done here.
fn vim_take(s: &mut App, ev: &KeyEvent) -> bool {
    let (name, held) = vim_key(ev);
    let mut b = vim_buf(&s.edit);
    let out = s.vim.key(&mut b, &name, held);
    if !out.taken {
        return false;
    }
    vim_put(&mut s.edit, &b);
    if out.undo || out.redo {
        if out.undo {
            s.edit.undo();
        } else {
            s.edit.redo();
        }
        vim_settle(s);
    }
    if let Some(said) = out.said {
        s.note = said;
    }
    if out.save {
        // as autosave saves: the text goes to the ship and the editor stays
        s.autosaving = true;
        write(s);
    }
    true
}

fn editor_key(s: &mut App, ev: &KeyEvent, _: &mut Tx) -> bool {
    // vim reads the key first, as its listener on the web runs before any other
    if s.prefs.vim && !s.rich && vim_take(s, ev) {
        return true;
    }
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
    if no_node(s) {
        return;
    }
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
            // vim starts each edit in normal mode, on a character
            vim_start(s);
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
        vim_start(s);
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
    if no_node(s) || !leave_edit(s) {
        return;
    }
    if s.memory {
        flip(s);
    }
    let seed = crate::api::since_epoch().map_or(0, |d| u64::from(d.subsec_nanos()));
    let name = api::capture_name(&api::today(), seed, &|n| s.names.iter().any(|x| x == n));
    start_named(s, name);
    s.note = "a new page in the inbox, kept when you save".into();
}

/// Starts a page that is not written yet under a name it already has,
/// open in the editor. Its first save makes it.
fn start_named(s: &mut App, name: String) {
    if no_node(s) || !leave_edit(s) {
        return;
    }
    urb_cancel(s);
    if s.memory {
        flip(s);
    }
    // nothing is asked of the ship: the page is not there until it is saved
    (s.remote, s.folder, s.old, s.want) = (None, None, None, None);
    (s.shared_open, s.inbox, s.access, s.stale) = (false, false, false, false);
    s.forum = None;
    s.note = format!("{name} is not written yet. It is kept when you save");
    s.open = Some(Page { name, body: String::new(), kind: "md".into(), rev: 0 });
    s.capture = true;
    start_edit(s);
}

/// Today's journal page: the one there is, under any of its names, or a
/// new one started at the name the ship's journal pass uses.
fn open_today(s: &mut App) {
    if no_node(s) || !leave_edit(s) {
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

/// Leaves the editor so that something else can be gone to, keeping what
/// was typed: text that is as the page was read is let go, and text
/// that changed is saved as a save made with the ship away is, kept on
/// this device first and then sent, so nothing waits on the ship's
/// answer and a save the ship refuses is not lost. `false` when the
/// editor could not be left, with why said.
fn leave_edit(s: &mut App) -> bool {
    if !s.editing {
        return true;
    }
    let Some(mut p) = s.open.clone() else {
        s.editing = false;
        return true;
    };
    let body = edited(s);
    if p.body == body || (s.capture && body.trim().is_empty()) {
        cancel_edit(s);
        return true;
    }
    if s.conn.is_none() {
        // sample pages are kept at once
        s.autosaving = false;
        write(s);
        return !s.editing;
    }
    // another ship's page, and one that changed elsewhere, are saved on purpose only
    if s.remote.is_some() || s.stale {
        s.note = "Save or cancel this edit first: it is not saved by itself".into();
        return false;
    }
    // ponytail: a save on its way would land over this one's place in the list, so it is waited for. Carry the newer text behind it if this is met in use
    if s.save_req.is_pending() {
        s.note = "A save is on its way. Try again in a moment".into();
        return false;
    }
    let (base, memory) = (p.rev, s.memory);
    p.body = body;
    (s.autosaving, s.save_again) = (false, false);
    queue_save(s, p, base, memory);
    if s.editing {
        // it could not be kept on this device: the editor stays, and says so
        return false;
    }
    if s.offline.is_none() {
        drain(s);
    }
    true
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
/// Goes from the editor to the reading of the page at once, as the web
/// client does, where Read only hides the editor. The text is kept on this
/// device and sent behind the switch, so the reader does not wait for the
/// ship's answer, and text that was not changed is not sent at all. What
/// cannot be left that way is saved in the open, as before: another
/// ship's page, a page that changed elsewhere, and a save already on its way.
fn to_read(s: &mut App) {
    if s.remote.is_some() || s.stale || s.save_req.is_pending() {
        return save(s);
    }
    // Read is a save made on purpose: autosave that was waiting for one goes on again
    s.auto_held = false;
    let (before, name) = (s.drain_req.is_pending(), s.open.as_ref().map(|p| p.name.clone()).unwrap_or_default());
    // only when this press is what is being sent: text that was not changed sends nothing, and a sending
    // already out is another page's, which says what it says
    if leave_edit(s) && !before && s.drain_req.is_pending() && s.queue.contains_key(&name) {
        // said as a save, which is what it is to the one who pressed Read
        s.note = "saving\u{2026}".into();
        // a memory's save moves the memories' list, which is read again as before
        s.read_save = !s.memory;
    }
}

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
    // a page of this ship's can wait for it. A memory, or a page of another ship, cannot yet
    let own = remote.is_none() && s.conn.is_some();
    let waits_as = if memory { api::know_queue_name(&p.name) } else { p.name.clone() };
    // the ship is known not to answer: the save is not tried, as the web client does not try it.
    // And a page with a save still waiting, or on its way, goes behind it: sent straight, the older one could land after it
    if own && (s.offline.is_some() || s.queue.contains_key(&waits_as) || s.drain_req.is_pending()) {
        queue_save(s, p, base, memory);
        if s.offline.is_none() {
            drain(s);
        }
        return;
    }
    s.save_sent = own.then(|| (p.clone(), base, memory));
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

/// Sends the saves that wait, now that the ship answers: the pages made
/// here first, then the edits, one request each, stopping at the first
/// the ship does not take or refuse outright.
// ponytail: one request for each page. The ship's batch route is for when a queue of hundreds shows up
fn drain(s: &mut App) {
    if (s.queue.is_empty() && s.ops.is_empty()) || s.drain_req.is_pending() {
        return;
    }
    let Some(c) = s.conn.clone() else { return };
    s.note = format!("sending {} saved on this device\u{2026}", s.queue.len() + s.ops.len());
    s.drain_req.request((c, s.ops.clone(), s.queue.clone()), |(c, ops, q)| {
        // the deletes and moves first, in the order made: what they meant for the saves was settled when they were put by
        let mut did = Vec::new();
        for op in ops {
            let r = c.send_op(&op);
            // one the ship refuses for good no longer applies, and is passed. Anything else stops here, saves and all
            let stop = r.as_ref().is_err_and(|e| !api::replay_drop(e));
            did.push((op, r));
            if stop {
                return (did, Vec::new());
            }
        }
        let mut all: Vec<(String, api::Queued)> = q.into_iter().collect();
        all.sort_by_key(|(_, q)| !q.is_new);
        let mut out = Vec::new();
        for (name, q) in all {
            let sent = c.send_queued(&name, &q);
            let stop = matches!(sent, api::Sent::Stop(_));
            out.push((name, q, sent));
            if stop {
                break;
            }
        }
        (did, out)
    });
}

/// How sending what waited came out: each delete or move with the ship's answer, then each save as it was sent.
type Drained = (Vec<(api::QueuedOp, Result<(), String>)>, Vec<(String, api::Queued, api::Sent)>);

/// What sending the waiting saves came to: each one the ship has, or
/// that was kept aside, leaves the list, unless the page was saved again
/// meanwhile, and that newer save then goes. A conflict or a refusal is
/// said with the name its other text is kept under.
fn drained(s: &mut App, (did, out): Drained) {
    // taken whatever comes of it: it speaks for this sending and no later one
    let read_save = std::mem::take(&mut s.read_save);
    let mut hist = false;
    let (mut gone_to_ship, mut stopped, mut said) = (0, false, Vec::new());
    for (op, r) in did {
        let what = match &op {
            api::QueuedOp::Del(n) => format!("the delete of {n}"),
            api::QueuedOp::Move { from, to, .. } => format!("the move of {from} to {to}"),
        };
        match r {
            Err(e) if !api::replay_drop(&e) => {
                stopped = true;
                if api::gone(&e) {
                    s.offline.get_or_insert_with(String::new);
                } else {
                    said.push(format!("{what} is still waiting: {e}"));
                }
                break;
            }
            r => {
                // they were sent from the front, in order: the one done is the first that waits
                if s.ops.first() == Some(&op) {
                    s.ops.remove(0);
                }
                gone_to_ship += 1;
                if let Err(e) = r {
                    said.push(format!("{what} no longer applies ({e}) and was let go"));
                }
            }
        }
    }
    if let Some(Err(e)) = s.conn.as_ref().map(|c| c.store_ops(&s.ops)) {
        said.push(format!("the list of what waits could not be written: {e}"));
    }
    for (name, q, sent) in out {
        let same = s.queue.get(&name) == Some(&q);
        match sent {
            api::Sent::Stop(why) => {
                stopped = true;
                if api::gone(&why) {
                    s.offline.get_or_insert_with(String::new);
                } else {
                    said.push(format!("{name} is still waiting: {why}"));
                }
            }
            api::Sent::Done { rev, kept } => {
                gone_to_ship += 1;
                if same {
                    s.queue.remove(&name);
                } else if let Some(newer) = s.queue.get_mut(&name) {
                    // saved again meanwhile: that one is written over what was just sent
                    (newer.base, newer.is_new) = (rev, false);
                }
                if let Some(p) = s.cache.get_mut(&name) {
                    p.rev = rev;
                }
                if let Some(p) = s.open.as_mut().filter(|p| p.name == name) {
                    p.rev = rev;
                    // the ship has a new revision of the page in front: its history is read again
                    hist = true;
                }
                if let Some(kept) = kept {
                    said.push(format!("{name} had changed on the ship. Yours is the page now, and what it replaced is kept at {kept}"));
                }
            }
            api::Sent::Aside(alt, why) => {
                gone_to_ship += 1;
                if same {
                    s.queue.remove(&name);
                }
                said.push(format!("{name} was refused ({why}). Your text is kept at {alt}"));
            }
        }
    }
    if let Some(Err(e)) = s.conn.as_ref().map(|c| c.store_queue(&s.queue)) {
        said.push(format!("the list of what waits could not be written: {e}"));
    }
    if gone_to_ship > 0 {
        // one save sent behind a press of Read was never waiting for the ship: it is said as the save it is
        // and when the ship took it as it was, with nothing kept aside, the page's new revision is all that moved:
        // it is set above, and the tree and the memories are not read again for it
        let plain = read_save && gone_to_ship == 1 && said.is_empty() && !stopped;
        said.insert(0, if plain { "saved".to_owned() } else { format!("sent {gone_to_ship} saved on this device") });
        if !plain {
            // the memories too: one of them may have been among what went
            load_know(s);
            // the whole tree is read again: revisions moved, and a kept copy may have been made
            s.since.clear();
            load_tree(s);
        }
    }
    if hist {
        load_history(s);
    }
    s.note = said.join(". ");
    if !stopped {
        drain(s);
    }
}

/// Puts a save by for a ship that does not answer, in the file that
/// outlives this run, and shows it as the page's text from then on.
/// When the file cannot be written the save is nowhere, and that is
/// said in place of "saved": the editor stays open with the text.
fn queue_save(s: &mut App, mut p: Page, base: u64, memory: bool) {
    let Some(c) = s.conn.clone() else { return };
    let at = crate::api::since_epoch().map_or(0, |d| d.as_secs());
    let mut q = s.queue.clone();
    if memory {
        // under its own name in the list, with no revision: the last write of a memory wins
        api::enqueue(&mut q, &Page { name: api::know_queue_name(&p.name), ..p.clone() }, 0, false, at);
    } else {
        api::enqueue(&mut q, &p, base, !s.names.contains(&p.name), at);
    }
    if let Err(e) = c.store_queue(&q) {
        (s.save_again, s.autosaving, s.auto_held) = (false, false, true);
        s.note = format!("NOT SAVED. The ship does not answer and this change could not be kept on this device ({e}). Copy your text somewhere safe");
        return;
    }
    s.queue = q;
    p.rev = base;
    // the text is new and the revision is not yet: what was drawn from the old text is drawn again
    stale_views(s, &p.name);
    landed(s, p);
    s.note = "saved on this device, to send when the ship answers".into();
}

/// Marks every view drawn from a page's text as out of date, so the next
/// sync draws it from the text there is now. They are kept by name and
/// revision, and a save kept on this device has new text at the old
/// revision. Each keeps what it had of the reader's own (a map's camera,
/// a sheet's place), since it is still the same page.
fn stale_views(s: &mut App, name: &str) {
    const NEVER: u64 = u64::MAX;
    #[cfg(not(target_arch = "wasm32"))]
    {
        s.web.text += 1;
    }
    if let Some(m) = s.map.as_mut().filter(|m| m.name == name) {
        m.rev = NEVER;
    }
    if let Some(v) = s.sheet.as_mut().filter(|v| v.name == name) {
        v.rev = NEVER;
    }
    if let Some(r) = s.read_as.as_mut().filter(|r| r.0 == name) {
        r.1 = NEVER;
    }
    if let Some(t) = s.tex_for.as_mut().filter(|t| t.0 == name) {
        t.1 = NEVER;
    }
    if let Some(t) = s.scad_for.as_mut().filter(|t| t.0 == name) {
        t.1 = NEVER;
    }
    for g in &mut s.tgroups {
        if let Some(v) = g.view.as_mut().filter(|v| v.0 == name) {
            v.1 = NEVER;
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
    // the page was left while its save was on the way: it is kept, and what is in front stays as it is
    if !s.open.as_ref().is_some_and(|o| o.name == p.name) {
        (s.save_again, s.autosaving) = (false, false);
        s.note = format!("saved {}", p.name);
        return;
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
/// How often it is read while the change stream is registered: the stream tells of changes, so this only catches one it merged or missed.
const SYNC_LIVE: f64 = 300.0;

fn poll(s: &mut App, clock: f64, tx: &mut Tx) -> bool {
    let mut changed = false;
    changed |= sync_draft(s);
    #[cfg(not(target_arch = "wasm32"))]
    {
        changed |= sync_web(s, tx);
        changed |= sync_update(s, clock, tx);
    }
    // a link in the rich editor reads as its Markdown while the caret is in it, to be changed by typing,
    // and is a link again once the caret has left. The page's Markdown is the same either way
    if s.editing && s.rich {
        match s.link_open {
            Some(o) if linkedit::left(&s.edit, o) => {
                linkedit::close(&mut s.edit, o);
                s.link_open = None;
                changed = true;
            }
            Some(_) => {}
            None => {
                s.link_open = linkedit::open(&mut s.edit);
                changed |= s.link_open.is_some();
            }
        }
    } else {
        s.link_open = None;
    }
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
    // what the change stream said since the last look
    let heard = std::mem::take(&mut *s.beacon.lock().unwrap());
    for ev in heard {
        let down = ev == api::Beacon::Down;
        let w = s.beacon_state.take(ev);
        if w.tree {
            // a moment later, so changes that come together are read once
            s.next_sync = clock + 0.3;
            tx.wake_after(std::time::Duration::from_millis(300));
        }
        if w.know {
            load_know(s);
        }
        if w.shared {
            load_shared(s);
        }
        if let Some(c) = s.conn.clone().filter(|_| w.inbox) {
            s.waiting_req.request(c, |c| c.waiting());
        }
        if down && s.next_sync > clock + SYNC_EVERY {
            // nothing is listening: the ship is asked again as it was before there was a stream
            s.next_sync = clock + SYNC_EVERY;
            tx.wake_after(std::time::Duration::from_secs_f64(SYNC_EVERY));
        }
    }
    if s.conn.is_some() && clock >= s.next_sync {
        if s.next_sync > 0.0 {
            load_tree(s);
        }
        // ponytail: the themes are asked for with the tree, a minute apart at least, so one
        // changed in Talon shows within five minutes. Watch %settings if that is too slow.
        if let Some(c) = s.conn.clone().filter(|_| clock >= s.next_theme) {
            s.next_theme = clock + 60.0;
            let had = s.prefs.worn.clone();
            s.theme_req.request(c, move |c| c.worn(had));
        }
        // while the stream is registered it says when anything changes, and asking is only a floor
        let every = if s.beacon_state.live { SYNC_LIVE } else { SYNC_EVERY };
        s.next_sync = clock + every;
        tx.wake_after(std::time::Duration::from_secs_f64(every));
    }
    if let Some(r) = s.theme_put.take() {
        changed = true;
        match r {
            // read again, so what the ship holds is what is worn
            Ok(()) => s.next_theme = 0.0,
            Err(e) => s.note = format!("Could not reach your ship ({e}): the theme is changed on this computer only"),
        }
    }
    // the theme's font, behind the app's own text: set when it changes, and at the first look from what was kept
    let font = font_of(&s.prefs.worn);
    if s.font_set != font {
        tx.set_font_families(font.clone(), APP_FONT);
        s.font_set = font;
        changed = true;
    }
    // a ship that could not be asked leaves the look it had
    if let Some(Ok(worn)) = s.theme_req.take().filter(|r| r.as_ref().is_ok_and(|w| *w != s.prefs.worn)) {
        changed = true;
        s.prefs.worn = worn;
        save_prefs(s);
    }
    if let Some(r) = s.marks_req.take() {
        changed = true;
        match r {
            Ok(list) => (s.marks, s.marks_bad) = (Some(list), false),
            // what was read before stays on screen
            Err(_) => s.marks_bad = true,
        }
    }
    if let Some(r) = s.shared_req.take() {
        changed = true;
        match r {
            Ok(list) => {
                s.shared = list;
                redraw_tree(s, false);
                load_folds(s);
            }
            Err(e) => s.note = format!("shared with me: {e}"),
        }
    }
    if let Some(read) = s.folds_req.take() {
        changed = true;
        s.folds = read.into_iter().collect();
        redraw_tree(s, false);
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
            Ok((list, total)) => (s.comments, s.comments_total) = (list, total),
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
        if let Ok((n, (mode, pending))) = r {
            s.comets.insert(n.clone(), mode);
            s.page_held.insert(n, pending);
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
    if let Some(r) = s.notes_req.take() {
        changed = true;
        match (r, &mut s.forum) {
            (Ok(ForumGot::Notes(n)), Some(f)) => f.notes = Some(n),
            (Err(e), Some(_)) => s.note = format!("refusals: {e}"),
            _ => {}
        }
    }
    if let Some(r) = s.board_theme_req.take() {
        changed = true;
        // a sheet that could not be read leaves the board in the window's own look
        if let Ok((board, css)) = r {
            if s.board_theme.as_ref().is_some_and(|t| t.0 == board) {
                s.board_theme = Some((board, css));
            }
        }
    }
    board_theme_sync(s);
    if let Some(r) = s.forum_req.take() {
        changed = true;
        if let Some(f) = &mut s.forum {
            f.acting = false;
        }
        // an answer about a board on another ship may come with a refusal of what was just sent there
        let away = match &r {
            Ok(ForumGot::Board(b)) => b.board.starts_with('~'),
            Ok(ForumGot::Thread(t)) => t.board.starts_with('~'),
            _ => false,
        };
        if away && !s.notes_req.is_pending() {
            forum_notes(s);
        }
        // an answer that lands after the forum was left is dropped
        match (r, &mut s.forum) {
            (Ok(ForumGot::Boards(b)), Some(f)) => f.boards = Some(b),
            (Ok(ForumGot::More(more)), Some(f)) => {
                if let Some(b) = f.board.as_mut().filter(|b| b.board == more.board) {
                    b.posts = forum_joined(&b.posts, more.posts);
                    b.count = more.count;
                }
            }
            (Ok(ForumGot::Notes(n)), Some(f)) => f.notes = Some(n),
            (Ok(ForumGot::Changed(b)), Some(f)) => {
                (f.boards, f.board, f.thread, f.making, f.editing, f.sending) = (Some(b), None, None, None, None, false);
                f.moding = None;
                f.tags.clear();
            }
            (Ok(ForumGot::Board(b)), Some(f)) => {
                (f.board, f.thread) = (Some(b), None);
                if s.note.starts_with("reading ") {
                    s.note.clear();
                }
                // what was being sent landed: the thread written is let go
                if std::mem::take(&mut f.sending) {
                    // a thread written, or the board's own title and description changed
                    let away = f.board.as_ref().is_some_and(|b| b.board.starts_with('~'));
                    s.note = if f.editing.is_some() { "changed".into() } else if away { SENT_AWAY.into() } else { "posted".into() };
                    (f.draft, f.editing) = (None, None);
                }
            }
            (Ok(ForumGot::Mod(m, said)), Some(f)) => {
                // the text beside the threads is shown as it now is
                if let Some(b) = &mut f.board {
                    b.sidebar = m.sidebar.clone();
                }
                (f.moding, f.sending) = (Some(Moding::new(m)), false);
                if !said.is_empty() {
                    s.note = said;
                }
            }
            (Ok(ForumGot::Thread(th)), Some(f)) => {
                f.thread = Some(th);
                if std::mem::take(&mut f.sending) {
                    (f.comment, f.reply) = (TextEdit::new(""), None);
                    s.note = if f.thread.as_ref().is_some_and(|t| t.board.starts_with('~')) { SENT_AWAY.into() } else { "sent".into() };
                }
            }
            // what was written stays, to be sent again or changed
            (Err(e), Some(f)) => {
                f.sending = false;
                s.note = format!("forum: {e}");
            }
            _ => {}
        }
    }
    if let Some(r) = s.core_req.take() {
        changed = true;
        // a list that does not load leaves the notice as it was: it is asked again with the memories
        if let Ok(keys) = r {
            s.core_agents = keys.iter().map(|k| k.trim_start_matches('/').to_owned()).collect();
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
            // the ship does not answer and memories are not kept between runs: the ones written away are still listed
            Err(e) if api::gone(&e) && s.queue.keys().any(|n| api::queued_know(n).is_some()) => take_knows(s, Vec::new()),
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
        // a ship that does not answer before anything was read: what was kept of it is read in its place
        let was_kept = s.offline.is_some();
        let r = match r {
            Err(e) if s.names.is_empty() && api::gone(&e) => match s.conn.as_ref().and_then(api::Conn::kept_tree) {
                Some((d, age)) => {
                    s.offline = Some(api::ago(age));
                    // a page asked for before this was known failed the same way: once is enough to say it
                    if s.note.starts_with("page: ") {
                        s.note.clear();
                    }
                    Ok(d)
                }
                None => Err(e),
            },
            Err(e) if api::lapsed(&e) => {
                s.lapsed = true;
                Err(e)
            }
            Ok(d) => {
                (s.offline, s.lapsed) = (None, false);
                // the ship answers: what waited for it goes now
                drain(s);
                Ok(d)
            }
            e => e,
        };
        match r {
            Ok(Dump { nodes, since }) => {
                // the deletes and moves that wait are done to what was read, so the tree shows as it was left
                let mut nodes = api::ops_over(nodes, &s.ops);
                // a save that waits is the page's text, over whatever was read: it is newer than anything the ship has
                // ponytail: while anything waits this rewrites the kept file on every read. Skip unchanged ones if it shows up as disk churn
                for (name, q) in &s.queue {
                    match nodes.iter_mut().find(|n| n.page && n.path == *name) {
                        // with the revision it was written over, so a save made from it is still checked against that one
                        Some(n) => (n.body, n.kind, n.rev) = (Some(q.body.clone()), q.kind.clone(), q.base),
                        None => nodes.push(Node { path: name.clone(), page: true, kind: q.kind.clone(), rev: q.base, body: Some(q.body.clone()), ..Node::default() }),
                    }
                }
                // what the ship gave is kept for a run when it does not answer: whenever it carried a text, or pages came or went
                let news = nodes.iter().any(|n| n.body.is_some()) || nodes.iter().filter(|n| n.page).count() != s.names.len() || was_kept;
                let keep = (s.offline.is_none() && news).then(|| nodes.clone());
                s.since = since;
                s.shares = nodes.iter().filter(|n| n.page && !n.share.is_empty()).map(|n| (n.path.clone(), n.share.clone())).collect();
                s.dnames = nodes.iter().filter(|n| !n.dname.is_empty()).map(|n| (n.path.clone(), n.dname.clone())).collect();
                s.dshares = nodes.iter().filter(|n| !n.page && !n.dshare.is_empty()).map(|n| (n.path.clone(), n.dshare.clone())).collect();
                s.links = nodes.iter().filter_map(|n| n.link.clone().map(|l| (n.path.clone(), l))).collect();
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
                if let Some((c, mut all)) = s.conn.clone().zip(keep) {
                    // every page goes with its text as it now is, not only those this read carried
                    for n in all.iter_mut().filter(|n| n.page) {
                        n.body = s.cache.get(&n.path).map(|p| p.body.clone());
                    }
                    spawn(move || drop(c.keep_tree(all)));
                }
                let first = s.files.is_empty();
                s.names = nodes.iter().filter(|n| n.page).map(|n| n.path.clone()).collect();
                s.dirs = nodes.iter().filter(|n| !n.page).map(|n| n.path.clone()).collect();
                let shut = shared_shut(s);
                // whether the page in front had a row before this read: one just made or moved has none yet
                let had = s.open.as_ref().is_some_and(|p| s.files.contains(&p.name));
                s.files = files_of(nodes, &s.files, s.prefs.sort_desc);
                graft_shared(s, &shut);
                if s.over == Some(Over::Search) {
                    run_search(s);
                }
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
                    if s.names.contains(&s.prefs.split) && s.tgroups.is_empty() {
                        (s.tgroups, s.front_at) = (vec![TabGroup::default(), TabGroup { tabs: vec![Tab { trail: vec![s.prefs.split.clone()], at: 0 }], at: 0, view: None }], 0);
                        s.split_down = s.prefs.split_down;
                    }
                    let last = s.prefs.last.clone();
                    if s.open.is_none() && !restore_tabs(s) && s.names.contains(&last) {
                        open_page(s, &last);
                    }
                }
                // a page just made or moved is shown where it now is. One that was there already is
                // only marked: a folder the reader folded stays folded through every read of the tree
                if let Some(p) = s.open.as_ref().filter(|_| !away) {
                    if !had {
                        s.files.expand_to(&p.name);
                    }
                    s.files.select(&p.name);
                }
            }
            // a ship that stops answering while its pages show: said once, and saves wait from here on
            Err(e) if api::gone(&e) && (s.offline.is_some() || !s.names.is_empty()) => {
                s.offline.get_or_insert_with(String::new);
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
            // a page with a save that waits shows that save, not what the ship still has
            Ok(p) if s.queue.contains_key(&p.name) => {}
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
            // offline, the page shows as it was kept: that the ship still does not answer is already said
            Err(e) if s.offline.is_some() && api::gone(&e) => {}
            Err(e) => s.note = format!("page: {e}"),
        }
    }
    if let Some(r) = s.login_req.take() {
        changed = true;
        match r {
            Ok(c) => {
                // signed in again, or to another ship: what the window held of the one before is let go first.
                // The ship that was in front stays signed in, and can be gone back to
                if s.conn.is_some() || s.adding {
                    reset(s, false);
                }
                if let Err(e) = c.remember() {
                    s.note = format!("signed in, but the session was not kept: {e}");
                }
                s.prefs = Prefs::load_for(&c.url);
                s.ships = api::ships();
                s.code = TextEdit::new("");
                s.queue = c.queue();
                s.ops = c.ops();
                s.conn = Some(c);
                load_tree(s);
                load_know(s);
                load_shared(s);
                listen(s);
            }
            Err(e) => s.login_err = e,
        }
    }
    if let Some(r) = s.op_req.take() {
        changed = true;
        match r {
            Ok(op) => applied(s, op),
            // uploads, sharing, grants and the rest are not put by: a grant that seems to work and is refused an hour later is a surprise nobody wants
            Err(e) => not_done(s, &e),
        }
    }
    if let Some(r) = s.comment_req.take() {
        changed = true;
        commented(s, r);
    }
    if let Some(r) = s.switch_req.take() {
        changed = true;
        switched(s, r);
    }
    if let Some(r) = s.thread_req.take() {
        changed = true;
        match r {
            Ok((url, list)) => {
                let ours = s.conn.as_ref().map(|c| c.ship().to_owned()).unwrap_or_default();
                if let Some(t) = s.thread.as_mut().filter(|t| t.url == url) {
                    t.list = list;
                    settle_sent(t, &ours);
                }
            }
            Err(e) => s.note = format!("comments: {e}"),
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
    if let Some(r) = s.set_req.take() {
        changed = true;
        match (r, &mut s.settings) {
            (Ok((tiles, scad, local, said, ob)), Some(st)) => {
                (st.tiles, st.scad, st.obelisk) = (Some(tiles), Some(scad), Some(ob));
                if ob.installed {
                    st.ob_tries = 0;
                }
                st.ob_asked |= said.contains("%obelisk");
                let said = match said.strip_prefix("reindex: ") {
                    Some(how) => {
                        st.reindex = how.to_owned();
                        String::new()
                    }
                    None => said,
                };
                if local.is_some() {
                    st.local_scad = local;
                }
                if !said.is_empty() {
                    // a token saved is not kept on screen, and maps ask the ship again what it can give
                    st.map_token = TextEdit::new("");
                    (s.tile_status, s.tiles_off) = (None, None);
                    s.note = said;
                }
            }
            (Err(e), Some(_)) => s.note = format!("settings: {e}"),
            _ => {}
        }
    }
    // these come after the answer above is taken: asked before it, they would take its place and what it said would be lost
    // while the ship fetches the runtime, its state is read every two seconds, as its own page does
    if s.settings.as_ref().is_some_and(|st| st.scad.as_ref().is_some_and(|r| r.busy) && clock >= st.scad_next) && !s.set_req.is_pending() {
        if let Some(st) = &mut s.settings {
            st.scad_next = clock + 2.0;
        }
        tx.wake_after(std::time::Duration::from_secs(2));
        settings_do(s, SetAct::Read);
    }
    // and while %obelisk is on its way, every six seconds, forty times
    if s.settings.as_ref().is_some_and(|st| st.ob_tries > 0 && clock >= st.ob_next) && !s.set_req.is_pending() {
        if let Some(st) = &mut s.settings {
            (st.ob_tries, st.ob_next) = (st.ob_tries - 1, clock + 6.0);
        }
        tx.wake_after(std::time::Duration::from_secs(6));
        settings_do(s, SetAct::Read);
    }
    if let Some(done) = s.bk_req.take() {
        // only a whole archive counts as a run: an incomplete one leaves the schedule due
        if let Some(b) = s.backups.iter_mut().find(|b| b.id == done.id).filter(|_| done.complete) {
            b.last_run = done.at;
            if let Err(e) = backups::save(&s.backups) {
                s.note = format!("the backup's time was not kept: {e}");
            }
        }
        s.bk_said = done.said;
    }
    // the schedules are looked at once a minute, and at launch: one that came due while the app was closed runs then
    if clock >= s.bk_next {
        s.bk_next = clock + 60.0;
        if !s.backups.is_empty() {
            tx.wake_after(std::time::Duration::from_secs(60));
        }
        let now = backups::now();
        if let Some(id) = s.backups.iter().find(|b| backups::is_due(b, now)).map(|b| b.id.clone()).filter(|_| s.conn.is_some() && !s.bk_req.is_pending()) {
            backup_run(s, &id);
        }
    }
    if let Some((said, changed)) = s.vault_req.take() {
        s.note = said.clone();
        s.vault_said = said;
        if changed {
            refresh_tree(s);
        }
    }
    if let Some((list, said)) = s.mount_req.take() {
        changed = true;
        s.mounts = list;
        if !said.is_empty() {
            s.note = said;
        }
    }
    if let Some(found) = s.local_req.take() {
        changed = true;
        if let Some(st) = &mut s.settings {
            st.local = Some(found);
        }
    }
    if let Some(r) = s.stack_req.take() {
        changed = true;
        // a ship that could not be asked is not said to lack anything
        if let (Ok(stack), Some(st)) = (r, &mut s.settings) {
            st.stack = Some(stack);
        }
    }
    if let Some(r) = s.sugg_req.take() {
        changed = true;
        // offered only while the field is being typed into
        s.sugg = r.ok().filter(|_| s.urb.focused).unwrap_or_default();
        s.sugg_at = None;
    }
    if let Some(Ok(list)) = s.visits_req.take() {
        changed = true;
        s.visits = list;
    }
    if let Some(r) = s.urb_req.take() {
        changed = true;
        match r {
            Ok((url, got)) => urb_got(s, url, got),
            Err(e) => s.note = format!("address: {e}"),
        }
    }
    // the engine's reads, each from a thread of its own: only the one last asked for is wanted
    let read: Vec<_> = std::mem::take(&mut *s.anon_got.lock().unwrap_or_else(|e| e.into_inner()));
    for (seq, r) in read {
        if seq != s.anon_seq || s.anon_reading.is_none() {
            continue;
        }
        changed = true;
        s.anon_reading = None;
        match r {
            Ok((url, got)) => urb_got(s, url, got),
            // the reader's own words are whole sentences
            Err(e) => s.note = e,
        }
    }
    #[cfg(unix)]
    if id_drained(s) {
        changed = true;
    }
    // while the reader starts for a first read, what it is doing is said, and then that it reads
    #[cfg(unix)]
    if let Some(url) = &s.anon_reading {
        let step = s.engine.as_ref().map(engine::Engine::step).unwrap_or_default();
        let say = if step.is_empty() { format!("reading {url}\u{2026}") } else { format!("{step}\u{2026}") };
        if s.note != say {
            s.note = say;
            changed = true;
        }
        if clock >= s.anon_tick {
            s.anon_tick = clock + 0.3;
            tx.wake_after(std::time::Duration::from_millis(300));
        }
    }
    if let Some(r) = s.keys_req.take() {
        changed = true;
        match (r, &mut s.settings) {
            (Ok((keys, token)), Some(st)) => {
                if token.is_some() {
                    // made: the form is cleared for the next one, and the secret shows
                    *st = Settings { token, ..Settings::new() };
                    s.note = "the key is made".into();
                }
                st.keys = Some(keys);
                st.sending = false;
            }
            (Err(e), Some(st)) => {
                st.sending = false;
                s.note = format!("keys: {e}");
            }
            _ => {}
        }
    }
    if let Some(out) = s.drain_req.take() {
        changed = true;
        drained(s, out);
    }
    if let Some(r) = s.save_req.take() {
        changed = true;
        let sent = s.save_sent.take();
        match r {
            Ok(p) => {
                // the ship has this page's text now: an older save of it that waited is done with
                let waited_as = if sent.as_ref().is_some_and(|x| x.2) { api::know_queue_name(&p.name) } else { p.name.clone() };
                if s.queue.remove(&waited_as).is_some() {
                    if let Some(Err(e)) = s.conn.as_ref().map(|c| c.store_queue(&s.queue)) {
                        s.note = format!("saved, but the list of what waits could not be written: {e}");
                    }
                }
                landed(s, p);
            }
            // the ship did not answer: the save waits here for it
            Err(e) if api::gone(&e) && sent.is_some() => {
                let (p, base, memory) = sent.expect("just checked");
                s.offline.get_or_insert_with(String::new);
                queue_save(s, p, base, memory);
            }
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
    if !leave_edit(s) {
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
    if paths.is_empty() || !leave_edit(s) {
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
        s.forum = None;
        s.folder = Some(name.to_owned());
    }
}

/// Opens the template dialog, with the name seeded by where a new page would go.
fn ask_template(s: &mut App) {
    if !leave_edit(s) {
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

/// The page the first group that is not in front shows: what a split
/// of two holds beside.
fn split_page(s: &App) -> Option<&str> {
    s.tgroups.iter().enumerate().find(|(d, _)| *d != s.front_at).and_then(|(_, g)| g.page())
}

/// One more group, holding the page in front, placed after the group in
/// front, which gives it half its share of the room. The first one makes the split.
fn add_group(s: &mut App) {
    let Some(name) = s.open.as_ref().filter(|_| s.remote.is_none() && !s.capture && !s.memory).map(|p| p.name.clone()) else { return };
    let made = TabGroup { tabs: vec![Tab { trail: vec![name], at: 0 }], at: 0, view: None };
    if s.tgroups.is_empty() {
        // the group in front has a place among them, left empty: its tabs are the window's own
        (s.tgroups, s.front_at) = (vec![TabGroup::default(), made], 0);
    } else {
        fix_shares(s);
        s.group_share = splits::share_added(&s.group_share, s.front_at);
        s.tgroups.insert(s.front_at + 1, made);
    }
    sync_groups(s);
}

/// Holds the page in front beside whatever comes next, or, with a split, closes it.
fn toggle_split(s: &mut App) {
    if !leave_edit(s) {
        return;
    }
    if s.tgroups.is_empty() {
        s.split_down = false;
        add_group(s);
    } else {
        s.tgroups.clear();
        sync_groups(s);
    }
}

/// A press on a split button: across, or down. With no split it makes
/// one that way. With a split that way it adds a group to it. With a
/// split the other way it turns the groups round to stand that way. Each
/// is refused when a group would have less than its least room.
fn split_press(s: &mut App, down: bool) {
    if !leave_edit(s) {
        return;
    }
    let press = match split_plan(s, down) {
        Ok(press) => press,
        Err(why) => {
            s.note = why;
            return;
        }
    };
    s.split_down = down;
    if press != splits::Press::Turn {
        add_group(s);
    }
    if s.prefs.split_down != s.split_down {
        s.prefs.split_down = s.split_down;
        save_prefs(s);
    }
}

/// What a press on a split button would do now, or why it would be
/// refused: four groups is the most, what would be split, the room or
/// the group in front, must be room for two that way, and groups turned
/// round must each keep their least.
fn split_plan(s: &App, down: bool) -> Result<splits::Press, String> {
    let press = splits::press(!s.tgroups.is_empty(), s.split_down, down);
    if press == splits::Press::Add && s.tgroups.len() >= splits::MOST {
        return Err("Four groups is the most there can be".to_owned());
    }
    let room = if down { s.groups_room.1 } else { s.groups_room.0 };
    // the share of the room that way that what is split has now
    let share = match press {
        splits::Press::Make => 1.0,
        splits::Press::Add => s.group_share.get(s.front_at).copied().unwrap_or(1.0),
        // turned round, the smallest group must keep its least: asked as room for two of twice its share
        splits::Press::Turn => 2.0 * s.group_share.iter().copied().fold(1.0 / s.tgroups.len().max(1) as f32, f32::min),
    };
    splits::halves(room * share, down).map_or(Ok(press), Err)
}

/// Puts the groups in order after a change: a group that is not in
/// front and has no tab with a page is gone, and a split of one group
/// is no split.
fn sync_groups(s: &mut App) {
    let mut d = 0;
    while d < s.tgroups.len() {
        if d != s.front_at {
            let g = &mut s.tgroups[d];
            g.tabs.retain(|t| t.page().is_some());
            g.at = g.at.min(g.tabs.len().saturating_sub(1));
            if g.tabs.is_empty() {
                s.tgroups.remove(d);
                if s.group_share.len() == s.tgroups.len() + 1 {
                    s.group_share = splits::share_removed(&s.group_share, d);
                }
                if s.front_at > d {
                    s.front_at -= 1;
                }
                continue;
            }
        }
        d += 1;
    }
    // where a group stands is noted as it is laid out, and only when it moves: what is noted is kept, cut to the groups there are
    s.group_rects.truncate(s.tgroups.len());
    if s.tgroups.len() < 2 {
        s.tgroups.clear();
        s.front_at = 0;
    }
    fix_shares(s);
    keep_split(s);
}

/// Makes the shares fit the groups: equal ones when they do not, as
/// when a split is made or put back from the last run.
fn fix_shares(s: &mut App) {
    if s.group_share.len() != s.tgroups.len() {
        s.group_share = splits::even(s.tgroups.len());
    }
}

/// The line between the group standing at `i` and the next, dragged:
/// the room moves between the two, neither going under the least size.
/// A double press makes the two alike.
fn drag_line(s: &mut App, i: usize, d: &rune::Drag) {
    fix_shares(s);
    let down = s.split_down;
    let (room, least) = if down { (s.groups_room.1, splits::LEAST_H) } else { (s.groups_room.0, splits::LEAST_W) };
    if room <= 0.0 {
        return;
    }
    s.group_share = match d.phase {
        Phase::Down if d.clicks >= 2 => {
            s.share_base = None;
            splits::evened(&s.group_share, i)
        }
        Phase::Down => {
            s.share_base = Some(s.group_share.clone());
            return;
        }
        Phase::Move => match &s.share_base {
            Some(base) if base.len() == s.group_share.len() => splits::dragged(base, i, if down { d.dy } else { d.dx } / room, least / room),
            _ => return,
        },
        Phase::Up => {
            s.share_base = None;
            return;
        }
    };
}

/// Brings the group standing at `d` to the front, whole, on its tab
/// `i`. The group that was in front stays where it stands, with every
/// tab that holds a page.
fn focus_group(s: &mut App, d: usize, i: usize) {
    if s.memory || d == s.front_at || s.tgroups.get(d).is_none_or(|g| i >= g.tabs.len()) || !leave_edit(s) {
        return;
    }
    park_tab(s);
    let coming = std::mem::take(&mut s.tgroups[d]);
    let (was, was_at) = (std::mem::replace(&mut s.tabs, coming.tabs), s.tab);
    let mut going = TabGroup::default();
    for (j, tab) in was.into_iter().enumerate() {
        // an empty tab has nothing to show beside
        if tab.page().is_some() {
            if j == was_at {
                going.at = going.tabs.len();
            }
            going.tabs.push(tab);
        }
    }
    s.tgroups[s.front_at] = going;
    s.front_at = d;
    load_tab(s, i);
    sync_groups(s);
    keep_tabs(s);
}

/// Brings the next group to the front, or the one before, in the order they stand and round at the ends.
fn turn_group(s: &mut App, forward: bool) {
    // the next, or the one before, going round at the ends
    let n = s.tgroups.len().max(1);
    let d = (s.front_at + if forward { 1 } else { n - 1 }) % n;
    if let Some(at) = s.tgroups.get(d).filter(|_| d != s.front_at).map(|g| g.at) {
        focus_group(s, d, at);
    }
}

/// Closes one tab of a group that is not in front. Its last tab closed, the group is gone.
fn close_group_tab(s: &mut App, d: usize, i: usize) {
    let Some(g) = s.tgroups.get_mut(d).filter(|g| i < g.tabs.len()) else { return };
    if d == s.front_at {
        return;
    }
    g.tabs.remove(i);
    if g.at > i {
        g.at -= 1;
    }
    g.view = None;
    sync_groups(s);
}

/// Closes a whole group that is not in front.
fn close_group(s: &mut App, d: usize) {
    if d != s.front_at && d < s.tgroups.len() {
        s.tgroups[d].tabs.clear();
        sync_groups(s);
    }
}

/// Writes the preferences down. With no ship there is nothing to keep them for.
fn save_prefs(s: &App) {
    if s.conn.is_some() {
        s.prefs.save();
    }
}

/// Notes the page held beside in the preferences, to hold again next run.
fn keep_split(s: &mut App) {
    sync_beside(s);
    let held = split_page(s).unwrap_or_default().to_owned();
    if s.prefs.split != held {
        s.prefs.split = held;
        save_prefs(s);
    }
}

/// The sheet held beside, to be read: its cells as they read, a tab for
/// each sheet, and no cell bar. It is changed from the front.
fn beside_sheet(d: usize, sheets: &[sheet::Sheet], at: usize, s: &App, k: &Kit) -> El {
    let c = &k.c;
    fn grid_of(s: &App, d: usize) -> Option<&sheet::Sheet> {
        match s.tgroups.get(d).and_then(|g| g.view.as_ref()) {
            Some((_, _, Beside::Sheet(sheets, at, _))) => sheets.get(*at),
            _ => None,
        }
    }
    // rune-kit's table reaches its state by a plain function, which cannot be told which group it is for.
    // So there is one for each place a group can stand, picked here
    fn state<const D: usize>(s: &App) -> &TableState {
        match s.tgroups.get(D).and_then(|g| g.view.as_ref()) {
            Some((_, _, Beside::Sheet(_, _, table))) => table,
            _ => unreachable!("a sheet is held in this group"),
        }
    }
    fn state_mut<const D: usize>(s: &mut App) -> &mut TableState {
        match s.tgroups.get_mut(D).and_then(|g| g.view.as_mut()) {
            Some((_, _, Beside::Sheet(_, _, table))) => table,
            _ => unreachable!("a sheet is held in this group"),
        }
    }
    fn rows<const D: usize>(s: &App) -> usize {
        grid_of(s, D).map_or(0, |sh| sh.rows.len())
    }
    let (get, get_mut, len): (fn(&App) -> &TableState, fn(&mut App) -> &mut TableState, fn(&App) -> usize) = match d {
        0 => (state::<0>, state_mut::<0>, rows::<0>),
        1 => (state::<1>, state_mut::<1>, rows::<1>),
        2 => (state::<2>, state_mut::<2>, rows::<2>),
        _ => (state::<3>, state_mut::<3>, rows::<3>),
    };
    let mut table = Table::new(get, get_mut, len, |_: &App, i| std::borrow::Cow::Owned(i.to_string()))
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
            Cell::text(grid_of(s, d).and_then(|sh| sh.rows.get(i)).and_then(|r| r.get(at)).cloned().unwrap_or_default())
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
                    if let Some((_, _, Beside::Sheet(_, at, table))) = s.tgroups.get_mut(d).and_then(|g| g.view.as_mut()) {
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
fn split_view(d: usize, s: &App, k: &Kit) -> El {
    let c = &k.c;
    let Some(group) = s.tgroups.get(d) else { return el() };
    let name = group.page().unwrap_or("");
    // the group's own tabs, as rune-kit's strip: a press on one brings the group to the front on it, and a tab
    // is dragged along it, or off it to another group. Its drag state is reached by a plain function, so there
    // is one for each place a group can stand
    fn drag<const D: usize>(s: &mut App) -> &mut rune_kit::shell::TabDragState {
        &mut s.group_drag[D]
    }
    let access: fn(&mut App) -> &mut rune_kit::shell::TabDragState = match d {
        0 => drag::<0>,
        1 => drag::<1>,
        2 => drag::<2>,
        _ => drag::<3>,
    };
    let labels: Vec<String> = group.tabs.iter().map(|tab| tab.page().map_or(String::new(), |page| s.dnames.get(page).cloned().unwrap_or_else(|| page.rsplit('/').next().unwrap_or(page).to_owned()))).collect();
    let ids: Vec<String> = (0..group.tabs.len()).map(|i| format!("g{d}-{i}")).collect();
    let at_of = |id: &str| id.rsplit('-').next().and_then(|i| i.parse::<usize>().ok());
    let tabs = rune_kit::shell::TabStrip::new(format!("g{d}-tabs"), rune_kit::shell::TabOrientation::Horizontal)
        .tabs(labels.iter().zip(&ids).enumerate().map(|(i, (label, id))| rune_kit::shell::TabItem::new(id.as_str(), label.as_str()).closable(true).decorate(move |tab, _| tab.on_layout_tx(move |s: &mut App, r, tx| note_tab(s, d, i, r, tx)))))
        .active(ids.get(group.at).map(String::as_str))
        .select_on_drag_start(false)
        .drag_state(&s.group_drag[d.min(splits::MOST - 1)], access)
        .on_select(move |s: &mut App, id, _| {
            if let Some(i) = at_of(id) {
                focus_group(s, d, i);
            }
        })
        .on_close(move |s: &mut App, id, _| {
            if let Some(i) = at_of(id) {
                close_group_tab(s, d, i);
            }
        })
        .on_reorder(move |s: &mut App, r: rune_kit::shell::TabReorder, _| reorder_group_tab(s, d, r.from, r.to))
        .tear_out(Some(rune_kit::shell::TearOutSpec { lone: true, ..Default::default() }))
        .on_tear_out(move |s: &mut App, t: rune_kit::shell::TabTearOut, _| drop_group_tab(s, d, t.index, t.window_point))
        .build(k);
    let at = group.at;
    let head = row()
        .w_full()
        .gap(6.0)
        .center_y()
        .child(tabs)
        .child(Button::new("Swap").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Bring this group to the front").disabled(s.editing).on_press(move |s: &mut App| focus_group(s, d, at)).build(k).key(format!("g{d}-front")))
        .child(Button::new("×").control_size(ControlSize::Small).variant(ButtonVariant::GhostFaint).help("Close this group").on_press(move |s: &mut App| close_group(s, d)).build(k).key(format!("g{d}-close")));
    let beside = s.cache.get(name).and_then(|p| group.view.as_ref().filter(|(n, rev, _)| *n == p.name && *rev == p.rev)).map(|(_, _, v)| v);
    let shown = match (s.cache.get(name), beside) {
        (Some(p), _) if p.kind == "md" => reader(&p.body, s, k, false),
        (_, Some(Beside::Read(md))) => reader(md, s, k, false),
        (_, Some(Beside::Sheet(sheets, at, _))) => beside_sheet(d, sheets, *at, s, k),
        (_, Some(Beside::Map(feats))) => beside_map(feats, k),
        // any other kind is its source, coloured
        (Some(p), None) => {
            let shown = source_shown(&p.body);
            rune::rich(shown.to_owned(), code_spans(&p.kind, shown, k)).font(k.ty.mono).color(c.text_base).wrap().selectable(true)
        }
        (None, _) => text("This page is not here any more.").font(k.ty.small).color(c.text_muted),
    };
    col()
        .key(format!("group-{d}"))
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
        save_prefs(s);
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

/// A page asked for in a tab of its own, by Ctrl or a middle click: marked in the tree and opened
/// there. Memories have no tabs, so one opens where it is.
fn tab_for(s: &mut App, name: &str) {
    if s.memory {
        return open_page(s, name);
    }
    s.files.select(name);
    open_in_tab(s, name);
}

/// Opens a page in a new tab, in front.
fn open_in_tab(s: &mut App, name: &str) {
    if !leave_edit(s) {
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
    if to == s.tab || to >= s.tabs.len() || !leave_edit(s) {
        return;
    }
    if s.memory {
        flip(s);
    }
    park_tab(s);
    load_tab(s, to);
    keep_tabs(s);
}

/// Shows tab `to` of the group in front: its history, and the page it was on.
fn load_tab(s: &mut App, to: usize) {
    s.tab = to;
    let Tab { trail, at } = std::mem::take(&mut s.tabs[to]);
    (s.trail, s.trail_at) = (trail, at);
    (s.open, s.folder, s.remote, s.old, s.want) = (None, None, None, None, None);
    (s.access, s.shared_open, s.inbox) = (false, false, false);
    s.forum = None;
    match s.trail.get(s.trail_at).cloned() {
        Some(name) if s.names.contains(&name) => {
            s.files.select(&name);
            show_page(s, &name);
        }
        _ => {
            s.trail.clear();
            s.trail_at = 0;
        }
    }
}

/// A new, empty tab, in front.
fn new_tab(s: &mut App) {
    if !leave_edit(s) {
        return;
    }
    s.tabs.push(Tab::default());
    let to = s.tabs.len() - 1;
    switch_tab(s, to);
}

/// Closes a tab. The last one stays.
fn close_tab(s: &mut App, i: usize) {
    if s.tabs.len() < 2 || i >= s.tabs.len() || !leave_edit(s) {
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
    // the browser in front names its tab by the page it is on, as the web client's does
    if i == s.tab && browsing(s) {
        return match s.open.as_ref().filter(|_| s.remote.is_some() && !s.shared_open) {
            Some(p) => p.name.rsplit('/').next().unwrap_or(&p.name).to_owned(),
            None => "Browser".to_owned(),
        };
    }
    let name = if i == s.tab { s.open.as_ref().filter(|_| s.remote.is_none()).map(|p| p.name.as_str()) } else { s.tabs[i].page() };
    name.map_or("New tab".to_owned(), |n| s.dnames.get(n).cloned().unwrap_or_else(|| n.rsplit('/').next().unwrap_or(n).to_owned()))
}

/// The top bar's strip: the tabs, always shown, then new tab and split.
fn tab_strip(s: &App, k: &Kit) -> El {
    let labels: Vec<String> = (0..s.tabs.len()).map(|i| tab_label(s, i)).collect();
    let memory = s.memory.then(|| s.open.as_ref().map_or("", |p| p.name.as_str()));
    let can_new = !s.memory;
    let can_split = can_new && usable(s, "split");
    let button = |down: bool, icon: &'static rune::Icon, key: &str, keys: Option<&str>| {
        let split = !s.tgroups.is_empty();
        let on = split && s.split_down == down;
        // a split there is no room for is refused, and its button says why
        let plan = split_plan(s, down);
        let says = match (&plan, down) {
            (Err(why), _) => why.clone(),
            (Ok(splits::Press::Make), false) => "Split right: hold this page beside the next one you open".to_owned(),
            (Ok(splits::Press::Make), true) => "Split down: hold this page below the next one you open".to_owned(),
            (Ok(splits::Press::Add), false) => "Split right again: one more group".to_owned(),
            (Ok(splits::Press::Add), true) => "Split down again: one more group".to_owned(),
            (Ok(splits::Press::Turn), false) => "Stand the groups side by side".to_owned(),
            (Ok(splits::Press::Turn), true) => "Stand the groups one above the other".to_owned(),
        };
        let mut b = IconButton::new(icon).variant(if on { IconButtonVariant::Neutral } else { IconButtonVariant::GhostMuted }).help(says).disabled(!can_split || plan.is_err()).on_press(move |s: &mut App| split_press(s, down));
        if let Some(keys) = keys {
            b = b.shortcut(keys);
        }
        b.build(k).key(key.to_owned())
    };
    let tools = row().gap(2.0).center_y().child(IconButton::new(&head::PLUS).variant(IconButtonVariant::GhostMuted).help("New tab").disabled(!can_new).on_press(new_tab).build(k).key("tab-new")).child(button(false, &topbar::SPLIT, "split-toggle", Some("Ctrl+\\"))).child(button(true, &topbar::SPLIT_DOWN, "split-down", None));
    // rune-kit's strip: a tab is dragged along it to another place, and a strip too long for the bar scrolls
    // the pages have their tabs, the last one left with no cross. The memories have none: one cell names the memory in front
    let (cells, ids, front_i, closes): (Vec<String>, Vec<String>, usize, bool) = match memory {
        Some(name) => (vec![if name.is_empty() { "Knowledge".to_owned() } else { name.to_owned() }], vec!["memory".to_owned()], 0, false),
        None => (labels.clone(), (0..labels.len()).map(|i| i.to_string()).collect(), s.tab, labels.len() > 1),
    };
    let front = ids.get(front_i).map(String::as_str);
    let at = |id: &str| id.parse::<usize>().ok();
    rune_kit::shell::TabStrip::new("tabs", rune_kit::shell::TabOrientation::Horizontal)
        .tabs(cells.iter().zip(&ids).enumerate().map(|(i, (c, id))| {
            let d = s.front_at;
            // where each tab stands is noted, for a tab of another group let go among them
            rune_kit::shell::TabItem::new(id.as_str(), c.as_str()).closable(closes).decorate(move |tab, _| tab.on_layout_tx(move |s: &mut App, r, tx| note_tab(s, d, i, r, tx)))
        }))
        .active(front)
        .drag_state(&s.tab_drag, |s: &mut App| &mut s.tab_drag)
        .on_select(move |s: &mut App, id, _| {
            if let Some(i) = at(id) {
                switch_tab(s, i);
            }
        })
        .on_close(move |s: &mut App, id, _| {
            if let Some(i) = at(id) {
                close_tab(s, i);
            }
        })
        .on_reorder(|s: &mut App, r: rune_kit::shell::TabReorder, _| move_tab(s, r.from, r.to))
        // dragged off the strip, a tab is carried: let go over another group, it goes there
        .tear_out((!s.tgroups.is_empty()).then(rune_kit::shell::TearOutSpec::default))
        .on_tear_out(|s: &mut App, t: rune_kit::shell::TabTearOut, _| drop_tab(s, t.index, t.window_point))
        .trailing_action(tools)
        .build(k)
}

/// A tab of the group in front goes to the group standing at `d`, which
/// then shows it. The group in front is never left with no tab, and an
/// empty tab stays where it is.
fn move_tab_to_group(s: &mut App, i: usize, d: usize, at: Option<usize>) {
    if s.memory || s.tabs.len() < 2 || i >= s.tabs.len() || d == s.front_at || d >= s.tgroups.len() || !leave_edit(s) {
        return;
    }
    // the front tab's history is with the window: put it back in its tab before the tabs are moved
    park_tab(s);
    if s.tabs[i].page().is_none() {
        let front = s.tab;
        load_tab(s, front);
        return;
    }
    let tab = s.tabs.remove(i);
    // the one in front stays in front. When it is the one that went, its neighbour comes forward
    let front = if s.tab > i { s.tab - 1 } else { s.tab.min(s.tabs.len() - 1) };
    load_tab(s, front);
    let g = &mut s.tgroups[d];
    // between the tabs it was let go among, or at the end
    let pos = at.map_or(g.tabs.len(), |a| a.min(g.tabs.len()));
    g.tabs.insert(pos, tab);
    (g.at, g.view) = (pos, None);
    sync_groups(s);
    keep_tabs(s);
}

/// A tab of the group standing at `from`, not the one in front, goes to
/// the group standing at `to`: to `at` among its tabs, or to their end,
/// where it is the one shown. Going to the group in front, it comes to the front. A
/// group left with no tab is gone.
fn move_group_tab(s: &mut App, from: usize, i: usize, to: usize, at: Option<usize>) {
    if from == s.front_at {
        return move_tab_to_group(s, i, to, at);
    }
    if s.memory || from == to || to >= s.tgroups.len() || s.tgroups.get(from).is_none_or(|g| i >= g.tabs.len()) || !leave_edit(s) {
        return;
    }
    let g = &mut s.tgroups[from];
    let tab = g.tabs.remove(i);
    if g.at > i {
        g.at -= 1;
    }
    g.view = None;
    if to == s.front_at {
        park_tab(s);
        let pos = at.map_or(s.tabs.len(), |a| a.min(s.tabs.len()));
        s.tabs.insert(pos, tab);
        load_tab(s, pos);
    } else {
        let g = &mut s.tgroups[to];
        let pos = at.map_or(g.tabs.len(), |a| a.min(g.tabs.len()));
        g.tabs.insert(pos, tab);
        (g.at, g.view) = (pos, None);
    }
    sync_groups(s);
    keep_tabs(s);
}

/// A tab of a group that is not in front, dragged along its strip to another place. The one showing is followed.
fn reorder_group_tab(s: &mut App, d: usize, from: usize, to: usize) {
    if d == s.front_at {
        return move_tab(s, from, to);
    }
    let Some(g) = s.tgroups.get_mut(d).filter(|g| from < g.tabs.len()) else { return };
    topbar::move_in(&mut g.tabs, from, to);
    g.at = topbar::front_after(g.at, from, to.min(g.tabs.len() - 1));
}

/// A tab of a group that is not in front, dragged off its strip and let go: over another group, or the one in front, it goes there.
fn drop_group_tab(s: &mut App, d: usize, i: usize, at: Option<[f32; 2]>) {
    let over = at.and_then(|p| splits::hit(&s.group_rects, p).or_else(|| splits::hit(&[s.front_rect], p).map(|_| s.front_at)).map(|to| (to, drop_slot(s, to, p))));
    match over {
        Some((to, at)) => move_group_tab(s, d, i, to, at),
        None => s.note = "Drop a tab on another group to move it there".to_owned(),
    }
}

/// Where among the tabs of the group standing at `d` a tab let go at `p` goes, when it is let go on that strip.
fn drop_slot(s: &App, d: usize, p: [f32; 2]) -> Option<usize> {
    let n = if d == s.front_at { s.tabs.len() } else { s.tgroups.get(d).map_or(0, |g| g.tabs.len()) };
    let rects = s.tab_rects.get(d)?;
    splits::slot(&rects[..n.min(rects.len())], p)
}

/// Notes where tab `i` of the group standing at `d` is, as it is laid out.
fn note_tab(s: &mut App, d: usize, i: usize, r: [f32; 4], tx: &mut Tx) {
    // a drop reads it, the view does not
    tx.live_only();
    if s.tab_rects.len() <= d {
        s.tab_rects.resize(d + 1, Vec::new());
    }
    if s.tab_rects[d].len() <= i {
        s.tab_rects[d].resize(i + 1, [0.0; 4]);
    }
    s.tab_rects[d][i] = r;
}

/// A tab dragged off the strip and let go: over a group that is not in front, it goes to that group.
fn drop_tab(s: &mut App, i: usize, at: Option<[f32; 2]>) {
    match at.and_then(|p| splits::hit(&s.group_rects, p).map(|d| (d, drop_slot(s, d, p)))) {
        Some((d, at)) => move_tab_to_group(s, i, d, at),
        None => s.note = "Drop a tab on another group to move it there".to_owned(),
    }
}

/// A tab dragged along the strip to another place: the tabs make way, and the one in front stays the one in front.
fn move_tab(s: &mut App, from: usize, to: usize) {
    if s.memory || from >= s.tabs.len() {
        return;
    }
    topbar::move_in(&mut s.tabs, from, to);
    s.tab = topbar::front_after(s.tab, from, to.min(s.tabs.len() - 1));
    keep_tabs(s);
}

/// The right pane, shown or put away, with what it showed last.
fn toggle_right(s: &mut App) {
    s.inspector.toggle();
    if s.inspector.is_open() {
        s.old = None;
        load_history(s);
        load_comments(s);
        load_links(s);
    }
}

fn go_shared(s: &mut App) {
    // shared with me is a folder in the files tree, as on the web: the ribbon's icon goes to it there
    if s.memory && !leave_edit(s) {
        return;
    }
    if s.memory {
        flip(s);
    }
    s.sidebar.set_open(true);
    s.over = None;
    load_shared(s);
    if s.files.contains(swm::ROOT) {
        s.files.set_expanded(swm::ROOT, true);
        s.files.select(swm::ROOT);
    } else if s.conn.is_some() {
        s.note = "Nothing is shared with you yet. A page another ship shares shows in the files, under shared with me".into();
    }
}

/// The browser: its start page, or whatever it was last on, with the address field to type in.
fn go_browser(s: &mut App) {
    if !leave_edit(s) {
        return;
    }
    (s.forum, s.access, s.settings, s.inbox, s.folder) = (None, false, None, false, None);
    s.shared_open = true;
    s.urb.focused = true;
    browse_home(s);
}

/// Reads what the browser's start page lists: the bookmarks and the visits.
fn browse_home(s: &mut App) {
    if let Some(c) = s.conn.clone() {
        s.visits_req.request(c.clone(), |c| c.visits());
        if s.marks.is_none() {
            s.marks_req.request(c, |c| c.bookmarks());
        }
    }
}

/// Goes where the address field says, or to an address given: a page or folder on the network,
/// a web page in the system's browser, and anything else looked for among the reader's own pages.
fn browse_to(s: &mut App, to: Option<String>, tx: &mut Tx) {
    let typed = to.unwrap_or_else(|| s.urb.text.clone());
    (s.sugg, s.sugg_at) = (Vec::new(), None);
    s.urb.focused = false;
    match browse::target(&typed) {
        browse::Target::Home => {
            s.nav.go("");
            browse_show(s, "");
        }
        browse::Target::Urb(url) => {
            s.nav.go(&url);
            browse_show(s, &url);
        }
        browse::Target::Web(url) => {
            if let Err(e) = tx.open_url(&url) {
                s.note = format!("could not open {url}: {e}");
            }
        }
        browse::Target::Search(q) => {
            s.squery = TextEdit::new(q.as_str());
            open_search(s);
        }
    }
}

/// Back, or forward, in the browser.
fn browse_step(s: &mut App, back: bool) {
    if !leave_edit(s) {
        return;
    }
    if let Some(url) = s.nav.step(back).map(str::to_owned) {
        browse_show(s, &url);
    }
}

/// Shows an address in the browser without a step being taken: the start page for the empty one.
fn browse_show(s: &mut App, url: &str) {
    s.urb = TextEdit::new(url);
    if url.is_empty() {
        // a read still on its way is for an address left behind
        urb_cancel(s);
        (s.remote, s.open, s.urb_folder) = (None, None, None);
        s.shared_open = true;
        browse_home(s);
    } else {
        urb_go(s, Some(url.to_owned()));
    }
}

/// Whether the browser is what is in front: its start page or a folder, or a page read at an address.
fn browsing(s: &App) -> bool {
    s.shared_open || (s.remote.as_ref().is_some_and(|r| r.mode == "published") && s.open.is_some() && !s.access && !s.inbox && s.settings.is_none() && s.forum.is_none())
}

/// Asks what the address field offers for what is typed in it.
fn suggest(s: &mut App) {
    s.sugg_at = None;
    match s.conn.clone() {
        Some(c) => s.sugg_req.request((c, s.urb.text.trim().to_owned()), |(c, q)| c.omni_suggest(&q)),
        None => s.sugg.clear(),
    }
}

/// The browser's bar: Back, Forward, the address field with what it offers under it, and the star.
fn browser_bar(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let cur = s.nav.cur().to_owned();
    let nav = |key: &str, icon: &'static rune::Icon, name: &str, back: bool, on: bool| IconButton::new(icon).variant(IconButtonVariant::GhostMuted).help(name).disabled(!on).on_press(move |s: &mut App| browse_step(s, back)).build(k).key(key.to_owned());
    let field = TextInput::new(&s.urb)
        .label("Address")
        .placeholder("urb:// address or search your pages")
        .on_edit(|s: &mut App| &mut s.urb)
        .on_change(|s: &mut App, _| suggest(s))
        .on_submit(|s: &mut App, tx| {
            let picked = s.sugg_at.and_then(|i| s.sugg.get(i)).map(|x| x.url.clone());
            browse_to(s, picked, tx);
        })
        .on_key(|s: &mut App, ev, _| match ev.key {
            Key::Down | Key::Up if !s.sugg.is_empty() => {
                s.sugg_at = browse::moved(s.sugg_at, s.sugg.len(), ev.key == Key::Down);
                true
            }
            Key::Escape if !s.sugg.is_empty() => {
                (s.sugg, s.sugg_at) = (Vec::new(), None);
                true
            }
            _ => false,
        })
        .build(k)
        .grow(1.0)
        .min_w(0.0)
        .key("browser-address");
    let mut bar = row().w_full().gap(4.0).center_y()
        .child(nav("browser-back", &tabhead::LEFT, "Back", true, s.nav.can_back()))
        .child(nav("browser-forward", &tabhead::RIGHT, "Forward", false, s.nav.can_forward()))
        .child(field);
    // the star keeps the page at this address, or drops it
    if cur.starts_with("urb://") {
        let kept = s.marks.as_deref().is_some_and(|m| marks::has(m, &cur));
        let title = s.open.as_ref().filter(|_| s.remote.is_some()).map_or_else(|| cur.trim_start_matches("urb://").to_owned(), |p| p.name.clone());
        bar = bar.child(IconButton::new(&head::MARK).variant(if kept { IconButtonVariant::Neutral } else { IconButtonVariant::GhostMuted }).help(if kept { "Bookmarked. Press to drop it" } else { "Bookmark this page" }).on_press(move |s: &mut App| {
            let change = if s.marks.as_deref().is_some_and(|m| marks::has(m, &cur)) { marks::Change::Drop(cur.clone()) } else { marks::Change::Keep(cur.clone(), title.clone(), String::new()) };
            mark_change(s, change);
        }).build(k).key("browser-star"));
    }
    let mut out = col().key("browser-bar").w_full().px(8.0).pb(6.0).gap(2.0).child(bar);
    if s.urb.focused && !s.sugg.is_empty() {
        let mut list = col().key("browser-suggest").role("listbox").label("Suggestions").w_full().padding(4.0).radius(k.radius.md).fill(c.layer_01).border(1.0, c.border_weak);
        for (i, it) in s.sugg.iter().enumerate() {
            let to = it.url.clone();
            let on = s.sugg_at == Some(i);
            list = list.child(
                row().key(format!("suggest-{i}")).role("option").label(format!("{}, {}", if it.title.is_empty() { &it.url } else { &it.title }, browse::source(&it.source))).w_full().h(26.0).px(8.0).gap(8.0).center_y().radius(k.radius.sm)
                    .fill(if on { k.selection() } else { rune::Color::TRANSPARENT }).hover(c.hover)
                    .on_press_tx(move |s: &mut App, tx| browse_to(s, Some(to.clone()), tx))
                    .child(text(browse::source(&it.source)).font(k.ty.text_xsmall_medium).color(if it.source == "bookmark" { c.text_accent } else { c.text_faint }).w(48.0))
                    .child(text(if it.title.is_empty() { it.url.clone() } else { it.title.clone() }).font(k.ty.small_medium).color(c.text_base).truncate().min_w(0.0).shrink())
                    .child(text(it.url.clone()).font(k.ty.small).color(c.text_muted).truncate().grow(1.0).min_w(0.0)),
            );
        }
        out = out.child(list);
    }
    out
}

/// Shows the forum: this ship's boards, read as it opens. Where it
/// was left is where it opens again, until something else is shown.
fn go_forum(s: &mut App) {
    if !leave_edit(s) {
        return;
    }
    (s.inbox, s.access, s.shared_open) = (false, false, false);
    s.forum = Some(Forum::default());
    match s.conn.clone() {
        Some(c) => {
            s.forum_req.request(c.clone(), |c| c.forum_boards().map(ForumGot::Boards));
            // and what other ships refused, for the count on the way in
            s.notes_req.request(c, |c| c.forum_notes().map(ForumGot::Notes));
        }
        // ponytail: the sample pages have no forum. A sample board if the screens are to be shown without a ship
        None => s.forum.as_mut().expect("just made").boards = Some(Vec::new()),
    }
}

/// What is said of a thread or a comment sent to a board on another ship: that ship takes it or refuses it in its own time.
const SENT_AWAY: &str = "sent to the board's ship. It shows here once that ship has taken it, and under Refusals if it does not";

/// Opens the board whose address is typed, or the thread when the address names one.
fn forum_go(s: &mut App) {
    let Some((c, f)) = s.conn.as_ref().zip(s.forum.as_mut()) else { return };
    match api::board_key(&f.address.text, c.ship()) {
        Ok((board, post)) => {
            s.note = format!("reading {board}\u{2026}");
            forum_open(s, board, post);
        }
        Err(why) => s.note = why,
    }
}

/// Reads a board of the forum, or with a number one of its threads, and shows it when it lands.
fn forum_open(s: &mut App, board: String, post: Option<u64>) {
    let Some(c) = s.conn.clone() else { return };
    // what other ships refused is read with whatever of the forum is opened, however it was come to:
    // by an address or a notice the boards screen, which read it, is never passed
    forum_notes(s);
    s.forum_req.request((c, board, post), |(c, board, post)| match post {
        Some(id) => c.forum_thread(&board, id).map(ForumGot::Thread),
        None => c.forum_board(&board).map(ForumGot::Board),
    });
}

/// Reads what other ships' boards refused of this ship's, for the count the forum shows.
fn forum_notes(s: &mut App) {
    if let Some(c) = s.conn.clone() {
        s.notes_req.request(c, |c| c.forum_notes().map(ForumGot::Notes));
    }
}

/// What is done to the forum thread showing.
enum ForumAct {
    Vote,
    /// A point for one comment of the thread.
    VoteComment(u64),
    Pin(bool),
    Tags(Vec<String>),
    /// The thread, or with a number one comment of it.
    Delete(Option<u64>),
}

/// Does something to the thread showing, as the ship's own form for it
/// does, then reads the thread again, or its board when the thread is gone.
fn forum_act(s: &mut App, act: ForumAct) {
    let Some(th) = s.forum.as_ref().and_then(|f| f.thread.as_ref()) else { return };
    let Some(c) = s.conn.clone() else { return };
    let (board, post, before) = (th.board.clone(), th.post.id, (th.post.up, th.post.down));
    s.forum_req.request((c, board, act), move |(c, board, act)| {
        forum_send(&c, &board, post, &act)?;
        if let ForumAct::Delete(None) = act {
            let b = c.forum_board(&board)?;
            forum_taken(&board, forum_took(&act, before, b.posts.iter().find(|p| p.id == post), &[]))?;
            return Ok(ForumGot::Board(b));
        }
        let th = c.forum_thread(&board, post)?;
        let ids: Vec<u64> = th.comments.iter().map(|c| c.id).collect();
        forum_taken(&board, forum_took(&act, before, Some(&th.post), &ids))?;
        Ok(ForumGot::Thread(th))
    });
}

/// Reads the next hundred of the board's threads and puts them after those held.
fn forum_more(s: &mut App) {
    let Some(c) = s.conn.clone() else { return };
    let Some(f) = &mut s.forum else { return };
    let Some(b) = &f.board else { return };
    let (board, next) = (b.board.clone(), b.posts.len() as u64 / 100 + 1);
    f.acting = true;
    s.forum_req.request((c, board), move |(c, board)| c.forum_board_page(&board, next).map(ForumGot::More));
}

/// The threads held with a later page's put after them, each thread once.
fn forum_joined(held: &[api::ForumPost], more: Vec<api::ForumPost>) -> Vec<api::ForumPost> {
    let mut out = held.to_vec();
    for p in more {
        if !out.iter().any(|x| x.id == p.id) {
            out.push(p);
        }
    }
    out
}

/// Does to a thread from its board's list what the thread's own screen does, and reads the board again.
fn forum_list_act(s: &mut App, board: String, post: u64, act: ForumAct) {
    let Some(c) = s.conn.clone() else { return };
    let Some(f) = &mut s.forum else { return };
    f.acting = true;
    let before = f.board.as_ref().and_then(|b| b.posts.iter().find(|p| p.id == post)).map_or((0, 0), |p| (p.up, p.down));
    s.forum_req.request((c, board, act), move |(c, board, act)| {
        forum_send(&c, &board, post, &act)?;
        let b = c.forum_board(&board)?;
        forum_taken(&board, forum_took(&act, before, b.posts.iter().find(|p| p.id == post), &[]))?;
        Ok(ForumGot::Board(b))
    });
}

fn forum_send(c: &Conn, board: &str, post: u64, act: &ForumAct) -> Result<(), String> {
    match act {
        ForumAct::Vote => c.forum_vote(board, post),
        ForumAct::VoteComment(id) => c.forum_vote_comment(board, post, *id),
        ForumAct::Pin(on) => c.forum_pin(board, post, *on),
        ForumAct::Tags(tags) => c.forum_set_tags(board, post, tags),
        ForumAct::Delete(comment) => c.forum_delete(board, post, *comment),
    }
}

/// Whether the board did what was asked, by the thread as it was and as it is read back. The ship
/// answers a form it refuses as it answers one it takes: this is the only way to tell. `before` is
/// the thread's votes up and down, `after` the thread now (none when it is gone), `comments` its
/// comments' numbers now.
fn forum_took(act: &ForumAct, before: (u64, u64), after: Option<&api::ForumPost>, comments: &[u64]) -> bool {
    match act {
        ForumAct::Vote => after.is_some_and(|p| (p.up, p.down) != before),
        // a comment's points before are not kept to hold against: the thread read back shows them
        ForumAct::VoteComment(_) => true,
        ForumAct::Pin(on) => after.is_some_and(|p| p.pinned == *on),
        ForumAct::Tags(tags) => after.is_some_and(|p| {
            let (mut want, mut have) = (tags.clone(), p.tags.clone());
            want.sort();
            have.sort();
            want == have
        }),
        ForumAct::Delete(None) => after.is_none(),
        ForumAct::Delete(Some(id)) => !comments.contains(id),
    }
}

/// A board of this ship's that did not do what was asked says so. One on another ship takes what
/// it is sent in its own time, and says what it refused under Refusals: there, nothing is known yet.
fn forum_taken(board: &str, took: bool) -> Result<(), String> {
    if took || board.starts_with('~') { Ok(()) } else { Err("the board did not take that. It may not be yours to do there".into()) }
}

/// What this ship may do to a thread or a comment on a board, as the ship's own rules have it
/// (`lattice-forum-rules.hoon`): its author may delete it and set its tags, and a mod may do that
/// to anyone's and pin. The host of a board is a mod of it. `role` is this ship's own on the board
/// as the board's ship sends it (`+urb-forum-json`, from desk 140). A ship that does not send it
/// leaves only this to go by: a board of this ship's is its to moderate, and on another's only what
/// an author may is offered.
#[derive(Debug, PartialEq)]
struct ForumMay {
    pin: bool,
    /// Delete, and for a thread its tags.
    change: bool,
}

fn forum_may(board: &str, role: Option<&str>, ours: &str, author: &str) -> ForumMay {
    let moderates = role.map_or(!board.contains('/'), |r| r == "mod");
    ForumMay { pin: moderates, change: moderates || (!ours.is_empty() && author == ours) }
}

/// Shows or hides the picture a thread's link is. Showing it fetches it from its site, which then
/// learns the reader's address: the press is the yes, as it is on the web's forum, where a picture
/// sits folded until it is opened (`+image-preview`).
fn forum_image(s: &mut App, url: String) {
    let Some(f) = &mut s.forum else { return };
    if let Some(i) = f.shown.iter().position(|u| *u == url) {
        f.shown.remove(i);
        return;
    }
    f.shown.push(url.clone());
    // one that failed is tried again by asking again
    if s.pics_failed.remove(&url) {
        s.pics_asked.remove(&url);
    }
    if !s.pics_asked.insert(url.clone()) {
        return;
    }
    let (Some(waker), back) = (s.waker.clone(), s.pics_in.clone()) else { return };
    spawn(move || {
        let got = api::fetch_bytes(&url, None);
        if let Ok(mut list) = back.lock() {
            list.push((url, got));
        }
        waker();
    });
}

/// A thread's link when it is a picture: the way to show it, and the picture once asked for,
/// no wider than the page and no taller than a screen's better part.
fn forum_preview(f: &Forum, pics: &Pics, link: Option<&str>, id: u64, k: &Kit) -> Option<El> {
    let url = link.filter(|l| api::is_image_url(l))?.trim().to_owned();
    Some(picture_fold(f, pics, url, "post-image", &id.to_string(), k))
}

/// The pictures a post's or a comment's text names, each folded under the text as a thread's own
/// picture is: nothing is fetched until its Show image is pressed.
fn forum_text_previews(f: &Forum, pics: &Pics, text: &str, slot: &str, k: &Kit) -> Vec<El> {
    api::text_images(text).into_iter().enumerate().map(|(i, url)| picture_fold(f, pics, url, "text-image", &format!("{slot}-{i}"), k)).collect()
}

/// One picture, folded: the button that shows or hides it, and the picture when it is shown.
fn picture_fold(f: &Forum, pics: &Pics, url: String, base: &str, id: &str, k: &Kit) -> El {
    let on = f.shown.contains(&url);
    let u = url.clone();
    let mut out = col().key(format!("{base}-{id}")).px(8.0).gap(4.0).child(
        row().child(
            Button::new(if on { "Hide image" } else { "Show image" })
                .control_size(ControlSize::Small)
                .variant(ButtonVariant::GhostMuted)
                .help("Fetches the picture from its own site, which then learns your address")
                .on_press(move |s: &mut App| forum_image(s, u.clone()))
                .build(k)
                .key(format!("{base}-toggle-{id}")),
        ),
    );
    if on {
        out = out.child(match (pics.had.get(&url).filter(|p| p.is_ready()).and_then(|p| Some((p, p.size()?))), pics.failed.contains(&url)) {
            (Some((pic, [w, h])), _) => {
                let scale = (560.0 / w.max(1) as f32).min(420.0 / h.max(1) as f32).min(1.0);
                el().key(format!("{base}-pic-{id}")).size(w as f32 * scale, h as f32 * scale).radius(k.radius.sm).pixels(pic.pixels()).role("img").label("A picture this thread names")
            }
            (None, true) => text("The picture did not load.").font(k.ty.small).color(k.c.text_muted),
            (None, false) => text("Loading the picture\u{2026}").font(k.ty.small).color(k.c.text_muted),
        });
    }
    out
}

/// The pictures had and the ones that did not come, for a view that is given no more of the app.
struct Pics<'a> {
    had: &'a HashMap<String, rune::Image>,
    failed: &'a std::collections::HashSet<String>,
}

/// The link a thread is about, when it is one to follow: the web, or an address on the network. As
/// the web's forum keeps a title's link to what is safe to follow (`safe-href`), nothing else is.
fn forum_link(link: Option<&str>) -> Option<String> {
    let l = link?.trim();
    (l.starts_with("https://") || l.starts_with("http://") || l.starts_with("urb://")).then(|| l.to_owned())
}

/// The tags offered to show a board's threads by, as the web's filter has them
/// (`lattice-forum-render.hoon`): the thirty most used, or with something typed every tag that
/// holds it. A tag that is picked is always among them, so it can be let go.
fn forum_tags_shown(all: &[(String, usize)], find: &str, picked: &[String]) -> Vec<(String, usize)> {
    let q = find.trim().trim_start_matches('#').to_lowercase();
    let mut out: Vec<(String, usize)> = if q.is_empty() { all.iter().take(30).cloned().collect() } else { all.iter().filter(|(t, _)| t.contains(&q)).cloned().collect() };
    for t in picked {
        if !out.iter().any(|(x, _)| x == t) {
            out.push((t.clone(), all.iter().find(|(x, _)| x == t).map_or(0, |x| x.1)));
        }
    }
    out
}

/// The board's tags to offer while a thread's are typed, as the web's field suggests them: those
/// that hold the word being typed, most used first, without the ones typed already. Eight at most.
fn tag_suggest(all: &[(String, usize)], typed: &str) -> Vec<String> {
    let part = |c: char| c == ',' || c.is_whitespace();
    let last = if typed.ends_with(part) { "" } else { typed.rsplit(part).next().unwrap_or_default() }.trim_start_matches('#').to_lowercase();
    let have: Vec<&str> = typed.split(part).map(|t| t.trim_start_matches('#')).filter(|t| !t.is_empty() && *t != last).collect();
    if have.len() >= 5 {
        return Vec::new();
    }
    all.iter().map(|(t, _)| t).filter(|t| t.contains(&last) && **t != last && !have.contains(&t.as_str())).take(8).cloned().collect()
}

/// What is typed for a thread's tags with the word being typed made the tag picked.
fn tag_complete(typed: &str, tag: &str) -> String {
    let part = |c: char| c == ',' || c.is_whitespace();
    let kept = if typed.ends_with(part) { typed } else { &typed[..typed.rfind(part).map_or(0, |i| i + 1)] };
    format!("{kept}{tag} ")
}

/// The tags a board's threads carry, most used first, then by name.
fn forum_board_tags(posts: &[api::ForumPost]) -> Vec<(String, usize)> {
    let mut count: HashMap<&str, usize> = HashMap::new();
    for t in posts.iter().flat_map(|p| &p.tags) {
        *count.entry(t.as_str()).or_default() += 1;
    }
    let mut v: Vec<(String, usize)> = count.into_iter().map(|(t, n)| (t.to_owned(), n)).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v
}

/// Sends the thread written for the board showing. The ship answers a
/// form it refuses as it answers one it takes, so the board is read
/// again, and a board no longer than it was says the thread was not taken.
fn forum_submit(s: &mut App) {
    let Some(f) = s.forum.as_mut().filter(|f| !f.sending) else { return };
    let (Some(b), Some(d)) = (&f.board, &f.draft) else { return };
    let [title, link, body, tags] = [d[0].text.trim().to_owned(), d[1].text.trim().to_owned(), d[2].text.trim_end().to_owned(), d[3].text.clone()];
    if title.is_empty() {
        s.note = "a thread needs a title".into();
        return;
    }
    let tags = match api::forum_tags(&tags) {
        Ok(t) => t,
        Err(why) => {
            s.note = why;
            return;
        }
    };
    let Some(c) = s.conn.clone() else { return };
    f.sending = true;
    let (board, had) = (b.board.clone(), b.count);
    s.forum_req.request((c, board), move |(c, board)| {
        c.forum_submit(&board, &title, &link, &body, &tags)?;
        let now = c.forum_board(&board)?;
        // another ship takes a thread in its own time: it is not yet there to count
        if now.count <= had && !board.starts_with('~') { Err("the ship did not take that thread: its board may not let you post, or the thread is too long".into()) } else { Ok(ForumGot::Board(now)) }
    });
}

/// Sends the comment written on the thread showing, under the comment it answers when it answers one.
fn forum_comment(s: &mut App) {
    let Some(f) = s.forum.as_mut().filter(|f| !f.sending) else { return };
    let Some(th) = &f.thread else { return };
    let body = f.comment.text.trim_end().to_owned();
    if body.trim().is_empty() {
        s.note = "there is nothing written to send".into();
        return;
    }
    let Some(c) = s.conn.clone() else { return };
    f.sending = true;
    let (board, post, parent, had) = (th.board.clone(), th.post.id, f.reply, th.comments.len());
    s.forum_req.request((c, board), move |(c, board)| {
        c.forum_comment(&board, post, parent, &body)?;
        let now = c.forum_thread(&board, post)?;
        if now.comments.len() <= had && !board.starts_with('~') { Err("the ship did not take that comment: the board may not let you post, or it is too long".into()) } else { Ok(ForumGot::Thread(now)) }
    });
}

/// The field of the thread being written, by its place: title, link, text, tags.
fn draft_field(s: &mut App, i: usize) -> &mut TextEdit {
    &mut s.forum.as_mut().and_then(|f| f.draft.as_mut()).expect("a thread is being written")[i]
}

/// Makes the board being written, when its name is one a board may have and no board has yet.
fn forum_make(s: &mut App) {
    let Some(f) = s.forum.as_mut().filter(|f| !f.sending) else { return };
    let Some((d, role)) = &f.making else { return };
    let [name, title, description] = [d[0].text.trim().to_owned(), d[1].text.trim().to_owned(), d[2].text.trim().to_owned()];
    let term = name.starts_with(|c: char| c.is_ascii_lowercase()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let why = if !term {
        "a board's name is lowercase letters, digits and hyphens, starting with a letter"
    } else if title.is_empty() {
        "a board needs a title"
    } else if f.boards.as_ref().is_some_and(|b| b.iter().any(|b| b.board == name)) {
        "there is already a board by that name"
    } else {
        ""
    };
    if !why.is_empty() {
        s.note = why.into();
        return;
    }
    let (role, Some(c)) = (*role, s.conn.clone()) else { return };
    f.sending = true;
    s.forum_req.request((c, name), move |(c, name)| {
        c.forum_new(&name, &title, &description, role)?;
        let boards = c.forum_boards()?;
        if boards.iter().any(|b| b.board == name) { Ok(ForumGot::Changed(boards)) } else { Err("the ship did not make that board".into()) }
    });
}

/// Sends the board's title and description as changed, or flips it between public and private, then reads it again.
fn forum_change(s: &mut App, flip: bool) {
    let Some(f) = s.forum.as_mut().filter(|f| !f.sending) else { return };
    let Some(b) = &f.board else { return };
    let texts = f.editing.as_ref().map(|e| (e[0].text.trim().to_owned(), e[1].text.trim().to_owned()));
    if !flip && texts.as_ref().is_none_or(|(title, _)| title.is_empty()) {
        s.note = "a board needs a title".into();
        return;
    }
    let Some(c) = s.conn.clone() else { return };
    f.sending = !flip;
    if flip {
        // what the moderation showed of comets and invitations is no longer so
        f.moding = None;
    }
    s.forum_req.request((c, b.board.clone()), move |(c, board)| {
        match (&texts, flip) {
            (_, true) => c.forum_flip_public(&board)?,
            (Some((title, description)), false) => c.forum_edit(&board, title, description)?,
            (None, false) => {}
        }
        c.forum_board(&board).map(ForumGot::Board)
    });
}

/// Reads the moderation of the board showing, after doing to it what was asked.
/// What is typed is checked first, as the ship's own page would refuse it.
fn forum_mod(s: &mut App, act: ModAct) {
    enum Send {
        Open,
        Role(String, Option<&'static str>),
        Sidebar(String),
        Prune(Option<(u64, u64)>),
        Comets,
        Invite(String, bool),
    }
    let Some(f) = s.forum.as_mut().filter(|f| !f.sending) else { return };
    let Some(board) = f.board.as_ref().map(|b| b.board.clone()) else { return };
    let m = f.moding.as_ref();
    let field = |i: usize| m.map(|m| m.fields[i].text.trim().to_owned()).unwrap_or_default();
    let ship = |i: usize| api::ship_name(&field(i)).ok_or_else(|| "that is not a ship's name".to_owned());
    let send = match act {
        ModAct::Open => Ok(Send::Open),
        ModAct::Role => ship(0).map(|w| Send::Role(w, Some(m.map_or("reader", |m| m.role)))),
        ModAct::Unrole(w) => Ok(Send::Role(w, None)),
        ModAct::Sidebar => Ok(Send::Sidebar(m.map(|m| m.fields[1].text.clone()).unwrap_or_default())),
        ModAct::Prune if m.is_some_and(|m| m.prune) => api::prune_rule(&field(2), &field(3)).map(|r| Send::Prune(Some(r))),
        ModAct::Prune => Ok(Send::Prune(None)),
        ModAct::Comets => Ok(Send::Comets),
        ModAct::Invite(add) => ship(4).map(|w| Send::Invite(w, add)),
    };
    let send = match send {
        Ok(x) => x,
        Err(e) => {
            s.note = e;
            return;
        }
    };
    let Some(c) = s.conn.clone() else { return };
    f.sending = !matches!(send, Send::Open);
    s.forum_req.request((c, board), move |(c, board)| {
        let said = match &send {
            Send::Open => String::new(),
            Send::Role(w, Some(r)) => c.forum_role(&board, w, Some(r)).map(|()| format!("{w} has a role"))?,
            Send::Role(w, None) => c.forum_role(&board, w, None).map(|()| format!("{w} is back to the board's default"))?,
            Send::Sidebar(t) => c.forum_sidebar(&board, t).map(|()| "sidebar saved".to_owned())?,
            Send::Prune(r) => c.forum_prune(&board, *r).map(|()| "pruning saved".to_owned())?,
            Send::Comets => c.forum_comets(&board).map(|()| "changed".to_owned())?,
            Send::Invite(w, true) => {
                if c.forum_invite(&board, w, true)? {
                    format!("{w} is invited and was told")
                } else {
                    format!("{w} is invited. It could not be reached to be told")
                }
            }
            Send::Invite(w, false) => c.forum_invite(&board, w, false).map(|_| format!("{w} is no longer invited"))?,
        };
        c.forum_mod(&board).map(|m| ForumGot::Mod(m, said))
    });
}

fn moding_field(s: &mut App, i: usize) -> &mut TextEdit {
    &mut s.forum.as_mut().and_then(|f| f.moding.as_mut()).expect("a board is being moderated").fields[i]
}

/// The moderation of the board showing: who holds which role, the text beside its threads, its pruning, comets, and who is invited.
fn moding_view(m: &Moding, sending: bool, k: &Kit) -> El {
    let c = &k.c;
    let muted = |t: String| text(t).font(k.ty.small).color(c.text_muted).wrap();
    let head = |t: &str| text(t.to_owned()).font(k.ty.small_medium).color(c.text_base);
    let small = |label: &str, key: &str, act: fn() -> ModAct| Button::new(label.to_owned()).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(sending).on_press(move |s: &mut App| forum_mod(s, act())).build(k).key(key.to_owned());
    let mut roles = col().key("mod-roles").w_full().gap(4.0).child(head("Roles")).child(muted(format!("A ship with no role of its own is a {}.", m.got.default_role)));
    for (who, role) in &m.got.roles {
        let who2 = who.clone();
        roles = roles.child(
            row()
                .gap(8.0)
                .center_y()
                .child(text(format!("{who} \u{b7} {role}")).font(k.ty.ui).color(c.text_base))
                .child(Button::new("Remove").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help("Back to the board's default").disabled(sending).on_press(move |s: &mut App| forum_mod(s, ModAct::Unrole(who2.clone()))).build(k).key(format!("role-remove-{}", who.trim_start_matches('~')))),
        );
    }
    let pick = |label: &str, val: &'static str| {
        Button::new(label.to_owned()).control_size(ControlSize::Small).variant(if m.role == val { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| {
            if let Some(m) = s.forum.as_mut().and_then(|f| f.moding.as_mut()) {
                m.role = val;
            }
        }).build(k).key(format!("role-{val}"))
    };
    roles = roles
        .child(TextInput::new(&m.fields[0]).label("Ship").placeholder("~sampel-palnet").on_edit(|s: &mut App| moding_field(s, 0)).build(k).w_full().key("role-who"))
        .child(row().gap(4.0).child(pick("Reader", "reader")).child(pick("Poster", "poster")).child(pick("Moderator", "mod")).child(small("Set role", "role-set", || ModAct::Role)));
    let side = col()
        .key("mod-side")
        .w_full()
        .gap(4.0)
        .child(head("Sidebar"))
        .child(TextArea::new(&m.fields[1]).label("Shown beside the board's threads. Empty hides it").rows(4).on_edit(|s: &mut App| moding_field(s, 1)).build(k).w_full().key("mod-sidebar"))
        .child(row().child(small("Save sidebar", "sidebar-save", || ModAct::Sidebar)));
    let prune = col()
        .key("mod-prune")
        .w_full()
        .gap(4.0)
        .child(head("Pruning"))
        .child(Switch::new(m.prune).label("Delete old threads with a low score. A pinned thread is kept").on_toggle(|s: &mut App| {
            if let Some(m) = s.forum.as_mut().and_then(|f| f.moding.as_mut()) {
                m.prune = !m.prune;
            }
        }).build(k).key("prune-on"))
        .child(muted("Least score: a thread scoring under it is deleted".into()))
        .child(TextInput::new(&m.fields[2]).label("Least score").on_edit(|s: &mut App| moding_field(s, 2)).build(k).w_full().key("prune-score"))
        .child(muted("Once it is this many days old".into()))
        .child(TextInput::new(&m.fields[3]).label("After days").on_edit(|s: &mut App| moding_field(s, 3)).build(k).w_full().key("prune-days"))
        .child(row().child(small("Save pruning", "prune-save", || ModAct::Prune)));
    let comets = col().key("mod-comets").w_full().gap(4.0).child(head("Comets"));
    let comets = match m.got.comets {
        Some(on) => comets.child(muted(if on { "Comets may post on this board, ten an hour across it. They never vote.".into() } else { "Comets may not post on this board.".into() })).child(row().child(small(if on { "Turn comet posts off" } else { "Turn comet posts on" }, "comets-flip", || ModAct::Comets))),
        None => comets.child(muted("This board is private, so comets cannot post.".into())),
    };
    let invites = col().key("mod-invites").w_full().gap(4.0).child(head("Invitations"));
    let invites = if m.got.public {
        invites.child(muted("A public board is read by anyone, so it has nobody to invite.".into()))
    } else {
        invites
            .child(muted("Only the ships invited read this board and post on it. The ship keeps no list of them to show here.".into()))
            .child(TextInput::new(&m.fields[4]).label("Ship").placeholder("~sampel-palnet").on_edit(|s: &mut App| moding_field(s, 4)).build(k).w_full().key("invite-ship"))
            .child(row().gap(4.0).child(small("Invite", "invite-add", || ModAct::Invite(true))).child(small("Take back", "invite-revoke", || ModAct::Invite(false))))
    };
    col().key("board-moding").w_full().gap(12.0).padding(10.0).radius(k.radius.md).fill(c.layer_01).child(roles).child(side).child(prune).child(comets).child(invites).child(row().child(Button::new("Done").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
        if let Some(f) = &mut s.forum {
            f.moding = None;
        }
    }).build(k).key("mod-close")))
}

fn making_field(s: &mut App, i: usize) -> &mut TextEdit {
    &mut s.forum.as_mut().and_then(|f| f.making.as_mut()).expect("a board is being made").0[i]
}

fn editing_field(s: &mut App, i: usize) -> &mut TextEdit {
    &mut s.forum.as_mut().and_then(|f| f.editing.as_mut()).expect("a board is being changed")[i]
}

/// Clears every refusal note on the ship, and reads them again.
fn forum_notes_clear(s: &mut App) {
    let Some(c) = s.conn.clone() else { return };
    s.notes_req.request(c, |c| {
        c.forum_notes_clear()?;
        c.forum_notes().map(ForumGot::Notes)
    });
}

/// One step back in the forum: from a thread to its board, from a board to the boards.
fn forum_back(s: &mut App) {
    if let Some(f) = &mut s.forum {
        if std::mem::take(&mut f.notes_open) {
            return;
        }
        if f.thread.take().is_none() {
            (f.board, f.moding) = (None, None);
            f.tags.clear();
        }
        // back from a thread that was come to directly: the boards were never read
        if f.board.is_none() && f.boards.is_none() {
            if let Some(c) = s.conn.clone() {
                s.forum_req.request(c, |c| c.forum_boards().map(ForumGot::Boards));
            }
        }
    }
}

/// The way to what other ships refused, with how many there are. On the boards screen it is always
/// there. On a board or a thread it shows only when there is something to see, as the web's badge does.
fn refusals(f: &Forum, k: &Kit, always: bool) -> Option<El> {
    let refused = f.notes.as_ref().map_or(0, Vec::len);
    (always || refused > 0).then(|| {
        Button::new(if refused == 0 { "Refusals".to_owned() } else { format!("Refusals {refused}") })
            .control_size(ControlSize::Small)
            .variant(if refused == 0 { ButtonVariant::GhostMuted } else { ButtonVariant::Ghost })
            .help("Posts another ship's board did not take, and why")
            .on_press(|s: &mut App| {
                if let Some(f) = &mut s.forum {
                    f.notes_open = true;
                }
            })
            .build(k)
            .key("notes-open")
    })
}

/// The forum: the boards, a board's threads, or a thread with its comments under what they answer.
fn forum_view(f: &Forum, ours: &str, pics: &Pics, k: &Kit) -> El {
    let c = &k.c;
    let when = |da: &str| Rev { rev: 0, updated: da.to_owned() }.when();
    let muted = |t: String| text(t).font(k.ty.small).color(c.text_muted);
    let mut page = col().key("forum").w_full().max_w(760.0).padding(28.0).gap(10.0);
    // the posts other ships refused: this ship's own page of them, read
    if f.notes_open {
        let notes = f.notes.as_deref().unwrap_or_default();
        page = page.child(row().child(Button::new("\u{2039} Boards").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(forum_back).build(k).key("forum-back")));
        page = page.child(text("Refused posts").font(k.ty.body_medium).color(c.text_base));
        page = page.child(muted("What another ship's board did not take from this one, and why.".into()).wrap());
        if notes.is_empty() {
            return page.child(muted(if f.notes.is_some() { "No refusals.".into() } else { "reading\u{2026}".into() }));
        }
        page = page.child(row().child(Button::new("Clear").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Forget every refusal").on_press(forum_notes_clear).build(k).key("notes-clear")));
        for (i, (why, at)) in notes.iter().take(200).enumerate() {
            page = page.child(col().key(format!("note-{i}")).w_full().padding(8.0).gap(2.0).child(text(why.clone()).font(k.ty.ui).color(c.text_base).wrap().selectable(true)).child(muted(at.clone())));
        }
        return page;
    }
    // a thread come to by a notice or an address has no board behind it: the way back is to the boards
    if f.board.is_some() || f.thread.is_some() {
        let back = if f.thread.is_some() && f.board.is_some() { "\u{2039} Back to the board" } else { "\u{2039} Boards" };
        page = page.child(row().w_full().center_y().child(Button::new(back).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(forum_back).build(k).key("forum-back")).child(el().grow(1.0)).children(refusals(f, k, false)));
    }
    if let Some(th) = &f.thread {
        let p = &th.post;
        page = page.child(text(p.title.clone()).font(k.ty.body_medium).color(c.text_base).wrap());
        page = page.child(muted(format!("{} \u{b7} {} \u{b7} {} point{} \u{b7} on {}", p.author, when(&p.created), p.up as i64 - p.down as i64, if p.up as i64 - p.down as i64 == 1 { "" } else { "s" }, th.title)));
        if !p.tags.is_empty() {
            page = page.child(row().gap(4.0).flex_wrap().children(p.tags.iter().map(|t| row().px(6.0).py(1.0).radius(k.radius.sm).fill(c.layer_01).child(text(format!("#{t}")).font(k.ty.small).color(c.text_muted)))));
        }
        // what may be done to the thread. The ship holds the rule on who may: what it refuses leaves the thread as it was
        let act = |label: String, key: &str, help: &str| Button::new(label).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help(help.to_owned());
        let (pinned, tags) = (p.pinned, p.tags.join(" "));
        // only what this ship may do here is offered, as the web shows its buttons by role
        let may = forum_may(&th.board, th.role.as_deref(), ours, &p.author);
        let mut acts = row().key("forum-acts").gap(4.0).flex_wrap().child(act("\u{25b2} Point".into(), "forum-vote", "Give this thread your point").on_press(|s: &mut App| forum_act(s, ForumAct::Vote)).build(k).key("forum-vote"));
        if may.pin {
            acts = acts.child(act(if pinned { "Unpin".into() } else { "Pin".into() }, "forum-pin", "Keep this thread at the top of its board").on_press(move |s: &mut App| forum_act(s, ForumAct::Pin(!pinned))).build(k).key("forum-pin"));
        }
        if may.change {
            acts = acts
                .child(act("Tags".into(), "forum-tags", "Set this thread's tags").on_press(move |s: &mut App| {
                    let mut t = TextEdit::new(tags.as_str());
                    t.focused = true;
                    s.prompt = Some(Prompt::ForumTags(t));
                }).build(k).key("forum-tags"))
                .child(act("Delete".into(), "forum-delete", "Delete this thread").on_press(|s: &mut App| s.prompt = Some(Prompt::ForumDelete(None))).build(k).key("forum-delete"));
        }
        page = page.child(acts);
        // the link and the text are the poster's Markdown: read as a page is, with no picture fetched
        if let Some(link) = p.link.as_deref().filter(|l| !l.is_empty()) {
            page = page.child(Markdown::new(format!("<{link}>")).selectable(true).on_link_tx(follow).build(k).key("forum-link"));
            // and when the link is a picture, the way to see it here
            page = page.children(forum_preview(f, pics, Some(link), p.id, k));
        }
        if let Some(body) = p.body.as_deref().filter(|b| !b.trim().is_empty()) {
            page = page.child(Markdown::new(body.to_owned()).selectable(true).on_link_tx(follow).build(k).key("forum-body"));
            // the pictures the text names, folded under it as the web folds them
            page = page.children(forum_text_previews(f, pics, body, &format!("p{}", p.id), k));
        }
        page = page.child(Divider::horizontal().build(k)).child(muted(format!("{} comment{}", th.comments.len(), if th.comments.len() == 1 { "" } else { "s" })));
        for (depth, cm) in api::comment_order(&th.comments) {
            // a long chain of replies stops stepping in, so the last of them still has room to be read
            let indent = 18.0 * depth.min(8) as f32;
            page = page.child(
                col()
                    .key(format!("comment-{}", cm.id))
                    .w_full()
                    .pl(indent)
                    .gap(2.0)
                    .child({
                        let id = cm.id;
                        row().gap(6.0).center_y().child(muted(match cm.up {
                            // points as the web counts them: those given less those taken
                            Some(up) => {
                                let n = up as i64 - cm.down.unwrap_or(0) as i64;
                                format!("{} \u{b7} {} \u{b7} {n} point{}", cm.author, when(&cm.created), if n == 1 { "" } else { "s" })
                            }
                            None => format!("{} \u{b7} {}", cm.author, when(&cm.created)),
                        })).children(cm.up.is_some().then(|| Button::new("\u{25b2} Point").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help("Give this comment your point").on_press(move |s: &mut App| forum_act(s, ForumAct::VoteComment(id))).build(k).key(format!("cvote-{id}")))).child(Button::new("Reply").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help("Answer this comment").on_press(move |s: &mut App| {
                            if let Some(f) = &mut s.forum {
                                f.reply = Some(id);
                                f.comment.focused = true;
                            }
                        }).build(k).key(format!("reply-{id}"))).children(forum_may(&th.board, th.role.as_deref(), ours, &cm.author).change.then(|| Button::new("Delete").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help("Delete this comment").on_press(move |s: &mut App| s.prompt = Some(Prompt::ForumDelete(Some(id)))).build(k).key(format!("comment-delete-{id}"))))
                    })
                    .child(Markdown::new(cm.body.clone()).selectable(true).on_link_tx(follow).build(k))
                    .children(forum_text_previews(f, pics, &cm.body, &format!("c{}", cm.id), k)),
            );
        }
        // the comment box: what is written goes under the thread, or under the comment being answered
        let to = f.reply.and_then(|id| th.comments.iter().find(|c| c.id == id));
        let mut write = col().key("forum-write").w_full().gap(6.0).pt(8.0);
        if let Some(cm) = to {
            write = write.child(row().gap(6.0).center_y().child(muted(format!("Answering {}: {}", cm.author, cm.body.chars().take(60).collect::<String>()))).child(Button::new("Not an answer").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| {
                if let Some(f) = &mut s.forum {
                    f.reply = None;
                }
            }).build(k).key("reply-none")));
        }
        write = write
            .child(TextArea::new(&f.comment).label("Comment").placeholder("Write a comment, in Markdown").rows(4).on_edit(|s: &mut App| &mut s.forum.as_mut().expect("the forum is showing").comment).build(k).w_full().key("forum-comment"))
            .child(row().child(Button::new(if f.sending { "Sending\u{2026}" } else if to.is_some() { "Reply" } else { "Comment" }).control_size(ControlSize::Small).variant(ButtonVariant::Contrast).disabled(f.sending).on_press(forum_comment).build(k).key("forum-send")));
        return page.child(write);
    }
    if let Some(b) = &f.board {
        page = page.child(text(b.title.clone()).font(k.ty.body_medium).color(c.text_base).wrap());
        let said = [b.description.clone(), format!("{}, {}", b.board, if b.public { "public" } else { "private" }), format!("{} thread{}", b.count, if b.count == 1 { "" } else { "s" })];
        page = page.child(muted(said.into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" \u{b7} ")).wrap());
        if !b.sidebar.is_empty() {
            page = page.child(el().key("board-sidebar").w_full().padding(8.0).radius(k.radius.md).fill(c.layer_01).child(text(b.sidebar.clone()).font(k.ty.small).color(c.text_base).wrap()));
        }
        let sort = |label: &str, key: &str, to: ForumSort| {
            Button::new(label.to_owned()).control_size(ControlSize::Small).variant(if f.sort == to { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| {
                if let Some(f) = &mut s.forum {
                    f.sort = to;
                }
            }).build(k).key(key.to_owned())
        };
        page = page.child(row().key("forum-sort").gap(4.0).child(sort("Hot", "fsort-hot", ForumSort::Hot)).child(sort("New", "fsort-new", ForumSort::New)).child(sort("Active", "fsort-active", ForumSort::Active)).child(sort("Top", "fsort-top", ForumSort::Top)));
        // the board itself: its title and description changed, shown to all or to its members, or deleted
        let (title, description, public, name) = (b.title.clone(), b.description.clone(), b.public, b.board.clone());
        match &f.editing {
            // a board on another ship is its owner's to change
            None if name.starts_with('~') => {}
            None => {
                page = page.child(
                    row()
                        .key("board-acts")
                        .gap(4.0)
                        .flex_wrap()
                        .child(Button::new("Edit board").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help("Change its title and description").on_press(move |s: &mut App| {
                            if let Some(f) = &mut s.forum {
                                let mut e = Box::new([TextEdit::new(title.as_str()), TextEdit::new(description.as_str())]);
                                e[0].focused = true;
                                f.editing = Some(e);
                            }
                        }).build(k).key("board-edit"))
                        .child(Button::new(if public { "Make private" } else { "Make public" }).control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help(if public { "Only ships you invite read it and post" } else { "Anyone reads it" }).on_press(|s: &mut App| forum_change(s, true)).build(k).key("board-public"))
                        .child(Button::new("Moderate").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help("Roles, sidebar, pruning, comets and invitations").on_press(|s: &mut App| forum_mod(s, ModAct::Open)).build(k).key("board-mod"))
                        .child(Button::new("Delete board").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).on_press(move |s: &mut App| s.prompt = Some(Prompt::BoardDelete(name.clone()))).build(k).key("board-delete")),
                );
            }
            Some(e) => {
                page = page.child(
                    col()
                        .key("board-editing")
                        .w_full()
                        .gap(8.0)
                        .padding(10.0)
                        .radius(k.radius.md)
                        .fill(c.layer_01)
                        .child(TextInput::new(&e[0]).label("Title").on_edit(|s: &mut App| editing_field(s, 0)).build(k).w_full().key("board-title"))
                        .child(TextArea::new(&e[1]).label("Description").rows(3).on_edit(|s: &mut App| editing_field(s, 1)).build(k).w_full().key("board-description"))
                        .child(
                            row()
                                .gap(6.0)
                                .child(Button::new(if f.sending { "Saving\u{2026}" } else { "Save" }).control_size(ControlSize::Small).variant(ButtonVariant::Contrast).disabled(f.sending).on_press(|s: &mut App| forum_change(s, false)).build(k).key("board-save"))
                                .child(Button::new("Cancel").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
                                    if let Some(f) = &mut s.forum {
                                        f.editing = None;
                                    }
                                }).build(k).key("board-cancel")),
                        ),
                );
            }
        }
        if let Some(m) = &f.moding {
            page = page.child(moding_view(m, f.sending, k));
        }
        // the board's tags, most used first: pressed, only the threads that carry every one pressed are listed
        let board_tags = forum_board_tags(&b.posts);
        if !board_tags.is_empty() {
            // more tags than are shown: one can be looked for, as with the web's "find a tag"
            if board_tags.len() > 30 || !f.tag_find.text.is_empty() {
                page = page.child(
                    TextInput::new(&f.tag_find)
                        .placeholder(format!("Find a tag among {}", board_tags.len()))
                        .on_edit(|s: &mut App| &mut s.forum.as_mut().expect("the forum is showing").tag_find)
                        .build(k)
                        .w(240.0)
                        .label("Find a tag")
                        .key("ftag-find"),
                );
            }
            let mut chips = row().key("forum-tag-filter").gap(2.0).flex_wrap();
            for (tag, n) in &forum_tags_shown(&board_tags, &f.tag_find.text, &f.tags) {
                let (on, tag2) = (f.tags.contains(tag), tag.clone());
                chips = chips.child(Button::new(format!("#{tag} {n}")).control_size(ControlSize::Small).variant(if on { ButtonVariant::Contrast } else { ButtonVariant::GhostMuted }).on_press(move |s: &mut App| {
                    if let Some(f) = &mut s.forum {
                        match f.tags.iter().position(|t| *t == tag2) {
                            Some(i) => drop(f.tags.remove(i)),
                            // five at most, as the ship's own address keeps
                            None if f.tags.len() < 5 => f.tags.push(tag2.clone()),
                            None => {}
                        }
                    }
                }).build(k).key(format!("ftag-{tag}")));
            }
            if !f.tags.is_empty() {
                chips = chips.child(Button::new("Clear").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Show every thread again").on_press(|s: &mut App| {
                    if let Some(f) = &mut s.forum {
                        f.tags.clear();
                    }
                }).build(k).key("ftag-clear"));
            }
            page = page.child(chips);
        }
        // a thread is written here, under the board's heading, and sent from here
        match &f.draft {
            None => {
                page = page.child(row().child(Button::new("New thread").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
                    if let Some(f) = &mut s.forum {
                        let mut d = Box::new([TextEdit::new(""), TextEdit::new(""), TextEdit::new(""), TextEdit::new("")]);
                        d[0].focused = true;
                        f.draft = Some(d);
                    }
                }).build(k).key("forum-new")));
            }
            Some(d) => {
                let line = |i: usize, label: &str, hint: &str, key: &str| TextInput::new(&d[i]).label(label).placeholder(hint).on_edit(move |s: &mut App| draft_field(s, i)).build(k).w_full().key(key.to_owned());
                page = page.child(
                    col()
                        .key("forum-draft")
                        .w_full()
                        .gap(8.0)
                        .padding(10.0)
                        .radius(k.radius.md)
                        .fill(c.layer_01)
                        .child(line(0, "Title", "What the thread is about", "draft-title"))
                        .child(line(1, "Link", "A link, if it is about one", "draft-link"))
                        .child(TextArea::new(&d[2]).label("Text (Markdown)").placeholder("The text, if it has one").rows(5).on_edit(|s: &mut App| draft_field(s, 2)).build(k).w_full().key("draft-body"))
                        .child(line(3, "Tags", "Up to five: lowercase letters, digits and dashes", "draft-tags"))
                        // the board's own tags that hold what is being typed: pressed, the word becomes the tag
                        .child({
                            let mut offer = row().key("draft-tag-offer").gap(2.0).flex_wrap();
                            for tag in tag_suggest(&board_tags, &d[3].text) {
                                let t = tag.clone();
                                offer = offer.child(Button::new(format!("#{tag}")).control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help("Use this tag").on_press(move |s: &mut App| {
                                    if let Some(d) = s.forum.as_mut().and_then(|f| f.draft.as_mut()) {
                                        let now = tag_complete(&d[3].text, &t);
                                        d[3] = TextEdit::new(now.as_str());
                                        d[3].focused = true;
                                    }
                                }).build(k).key(format!("draft-tag-{tag}")));
                            }
                            offer
                        })
                        .child(
                            row()
                                .gap(6.0)
                                .child(Button::new(if f.sending { "Posting\u{2026}" } else { "Post" }).control_size(ControlSize::Small).variant(ButtonVariant::Contrast).disabled(f.sending).on_press(forum_submit).build(k).key("draft-post"))
                                .child(Button::new("Cancel").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
                                    if let Some(f) = &mut s.forum {
                                        f.draft = None;
                                    }
                                }).build(k).key("draft-cancel")),
                        ),
                );
            }
        }
        if b.posts.is_empty() {
            page = page.child(muted("No threads yet.".into()));
        }
        let shown: Vec<&api::ForumPost> = forum_sorted(&b.posts, f.sort, api::since_epoch().map_or(0, |d| d.as_secs() as i64)).into_iter().filter(|p| f.tags.iter().all(|t| p.tags.contains(t))).collect();
        if shown.is_empty() && !b.posts.is_empty() {
            page = page.child(muted("No thread carries every tag picked.".into()));
        }
        for p in shown {
            let (board, id) = (b.board.clone(), p.id);
            let points = p.up as i64 - p.down as i64;
            let to = board.clone();
            let mut line = col()
                .key(format!("post-{id}"))
                .w_full()
                .padding(8.0)
                .gap(2.0)
                .radius(k.radius.md)
                .hover(c.layer_01)
                .cursor(rune::Cursor::Pointer)
                .on_press(move |s: &mut App| forum_open(s, to.clone(), Some(id)))
                .label(format!("Open the thread {}", p.title));
            // a thread about a link: its title leads to the link, as on the web, and what is under it opens the thread
            let out = forum_link(p.link.as_deref());
            let title = text(if p.pinned { format!("\u{2022} {}", p.title) } else { p.title.clone() }).font(k.ty.ui_medium).wrap();
            let lead = out.map(|url| {
                row().px(8.0).pt(6.0).child(
                    title.clone().key(format!("post-link-{id}")).color(c.text_accent).cursor(rune::Cursor::Pointer).role("link").label(format!("{}, a link to {url}", p.title)).on_press_tx(move |s: &mut App, tx| follow(s, &url, tx)),
                )
            });
            line = if lead.is_none() { line.child(title.color(c.text_base)) } else { line.pt(2.0) };
            let host = p.link.as_deref().and_then(|l| l.split("://").nth(1)).and_then(|r| r.split('/').next()).map(|h| format!(" \u{b7} {h}")).unwrap_or_default();
            line = line.child(muted(format!("{} \u{b7} {} \u{b7} {points} point{} \u{b7} {} comment{}{host}{}", p.author, when(&p.created), if points == 1 { "" } else { "s" }, p.comments, if p.comments == 1 { "" } else { "s" }, if p.pinned { " \u{b7} pinned" } else { "" })));
            if !p.tags.is_empty() {
                line = line.child(muted(p.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ")));
            }
            // what the web's list has on each row: a vote, and for those who may, pin and delete. They sit
            // beside what opens the thread, not inside it, so a press on one does not open it too
            let small = |label: &str, help: &str| Button::new(label.to_owned()).control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help(help.to_owned()).disabled(f.acting);
            let (vb, pb, db, pinned) = (board.clone(), board.clone(), board.clone(), p.pinned);
            let may = forum_may(&board, b.role.as_deref(), ours, &p.author);
            let mut acts = row().px(4.0).gap(2.0).child(small("Vote", "Vote this thread up, or take the vote back").on_press(move |s: &mut App| forum_list_act(s, vb.clone(), id, ForumAct::Vote)).build(k).key(format!("row-vote-{id}")));
            if may.pin {
                acts = acts.child(small(if pinned { "Unpin" } else { "Pin" }, "Keep this thread at the top of the board, or let it go").on_press(move |s: &mut App| forum_list_act(s, pb.clone(), id, ForumAct::Pin(!pinned))).build(k).key(format!("row-pin-{id}")));
            }
            if may.change {
                acts = acts.child(small("Delete", "Delete this thread").on_press(move |s: &mut App| s.prompt = Some(Prompt::ForumRowDelete(db.clone(), id))).build(k).key(format!("row-delete-{id}")));
            }
            page = page.child(col().key(format!("post-row-{id}")).w_full().children(lead).child(line).children(forum_preview(f, pics, p.link.as_deref(), id, k)).child(acts));
        }
        // a board with more threads than are held gives the next hundred when asked, from a ship that pages
        if b.page.is_some() && (b.posts.len() as u64) < b.count {
            let left = b.count - b.posts.len() as u64;
            page = page.child(row().child(Button::new(format!("More threads ({left} older)")).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(f.acting).on_press(forum_more).build(k).key("forum-more")));
        }
        return page;
    }
    page = page.child(row().w_full().gap(8.0).center_y().child(text("Boards").font(k.ty.body_medium).color(c.text_base).grow(1.0)).children(refusals(f, k, true)));
    page = page.child(
        row()
            .key("board-away")
            .w_full()
            .gap(6.0)
            .center_y()
            .child(TextInput::new(&f.address).label("A board on another ship").placeholder("urb://~sampel-palnet/forum/board").on_edit(|s: &mut App| &mut s.forum.as_mut().expect("the forum is showing").address).on_submit(|s: &mut App, _| forum_go(s)).build(k).grow(1.0).key("board-address"))
            .child(Button::new("Open").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Read a board on another ship by its address").on_press(forum_go).build(k).key("board-go")),
    );
    match &f.making {
        None => {
            page = page.child(row().child(Button::new("New board").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
                if let Some(f) = &mut s.forum {
                    let mut d = Box::new([TextEdit::new(""), TextEdit::new(""), TextEdit::new("")]);
                    d[0].focused = true;
                    f.making = Some((d, "poster"));
                }
            }).build(k).key("board-new")));
        }
        Some((d, role)) => {
            let line = |i: usize, label: &str, hint: &str, key: &str| TextInput::new(&d[i]).label(label).placeholder(hint).on_edit(move |s: &mut App| making_field(s, i)).build(k).w_full().key(key.to_owned());
            let pick = |label: &str, val: &'static str| {
                Button::new(label.to_owned()).control_size(ControlSize::Small).variant(if *role == val { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| {
                    if let Some((_, r)) = s.forum.as_mut().and_then(|f| f.making.as_mut()) {
                        *r = val;
                    }
                }).build(k).key(format!("new-role-{val}"))
            };
            page = page.child(
                col()
                    .key("board-making")
                    .w_full()
                    .gap(8.0)
                    .padding(10.0)
                    .radius(k.radius.md)
                    .fill(c.layer_01)
                    .child(line(0, "Name", "lowercase letters, digits, hyphens", "new-name"))
                    .child(line(1, "Title", "What the board is called", "new-title"))
                    .child(TextArea::new(&d[2]).label("Description").rows(3).on_edit(|s: &mut App| making_field(s, 2)).build(k).w_full().key("new-description"))
                    .child(row().gap(4.0).center_y().child(muted("Those with no role of their own may".into())).child(pick("post", "poster")).child(pick("read", "reader")).child(pick("moderate", "mod")))
                    .child(
                        row()
                            .gap(6.0)
                            .child(Button::new(if f.sending { "Making\u{2026}" } else { "Create" }).control_size(ControlSize::Small).variant(ButtonVariant::Contrast).disabled(f.sending).on_press(forum_make).build(k).key("new-create"))
                            .child(Button::new("Cancel").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
                                if let Some(f) = &mut s.forum {
                                    f.making = None;
                                }
                            }).build(k).key("new-cancel")),
                    ),
            );
        }
    }
    match &f.boards {
        None => page = page.child(muted("reading the boards\u{2026}".into())),
        Some(b) if b.is_empty() => page = page.child(muted("There are no boards on this ship.".into())),
        Some(boards) => {
            for b in boards {
                let name = b.board.clone();
                page = page.child(
                    col()
                        .key(format!("board-{}", b.board))
                        .w_full()
                        .padding(8.0)
                        .gap(2.0)
                        .radius(k.radius.md)
                        .hover(c.layer_01)
                        .cursor(rune::Cursor::Pointer)
                        .on_press(move |s: &mut App| forum_open(s, name.clone(), None))
                        .label(format!("Open the board {}", b.title))
                        .child(text(b.title.clone()).font(k.ty.ui_medium).color(c.text_base))
                        .child(muted(format!("{}, {} \u{b7} {} thread{}", b.board, if b.public { "public" } else { "private" }, b.count, if b.count == 1 { "" } else { "s" })))
                        .children((!b.description.is_empty()).then(|| muted(b.description.clone()).wrap())),
                );
            }
        }
    }
    page
}

fn go_inbox(s: &mut App) {
    if !leave_edit(s) {
        return;
    }
    if !s.editing {
        s.forum = None;
        s.inbox = true;
        s.access = false;
    s.settings = None;
        s.shared_open = false;
        load_comments(s);
    }
}

fn go_access(s: &mut App) {
    if !leave_edit(s) {
        return;
    }
    if !s.editing {
        s.forum = None;
        s.settings = None;
        s.access = true;
        s.inbox = false;
        s.forum = None;
        load_groups(s);
    }
}

fn go_settings(s: &mut App) {
    if !leave_edit(s) {
        return;
    }
    if !s.editing {
        (s.forum, s.access, s.inbox, s.shared_open) = (None, false, false, false);
        s.settings = Some(Settings::new());
        keys_do(s, None, None);
        settings_do(s, SetAct::Read);
        stack_ask(s);
    }
}

type SetGot = (api::TileStatus, api::ScadStatus, Option<Option<String>>, String, api::Obelisk);

/// What is done from the settings, beside the keys.
enum SetAct {
    Read,
    /// The Mapbox token is set to what is typed, or cleared.
    Token(bool),
    /// The ship's OpenSCAD runtime is installed or updated, or dropped.
    Runtime(bool),
    /// The Commons mirror is turned on or off.
    Mirror(bool),
    /// The search index is rebuilt.
    Reindex,
    /// %obelisk is installed.
    Obelisk,
}

/// Reads the map token's state and the OpenSCAD runtime's, after doing what was asked.
fn settings_do(s: &mut App, act: SetAct) {
    let Some((c, st)) = s.conn.clone().zip(s.settings.as_mut()) else { return };
    let token = match act {
        SetAct::Token(true) if st.map_token.text.trim().is_empty() => {
            s.note = "paste a Mapbox token to save".into();
            return;
        }
        SetAct::Token(set) => Some(if set { st.map_token.text.trim().to_owned() } else { String::new() }),
        _ => None,
    };
    let runtime = if let SetAct::Runtime(install) = act { Some(install) } else { None };
    let mirror = if let SetAct::Mirror(on) = act { Some(on) } else { None };
    let obelisk = matches!(act, SetAct::Obelisk);
    let reindex = matches!(act, SetAct::Reindex);
    if reindex {
        st.reindex = "reindexing...".into();
    }
    if obelisk {
        // the ship is asked forty times, six seconds apart, as its own page asks
        st.ob_tries = 40;
    }
    // this computer's own openscad is looked for once: it is a few programs run
    let look = st.local_scad.is_none();
    s.set_req.request((c, token, runtime), move |(c, token, runtime)| {
        let mut said = String::new();
        if let Some(t) = &token {
            c.map_token(t)?;
            said = if t.is_empty() { "the Mapbox token is removed".into() } else { "the Mapbox token is saved".into() };
        }
        if let Some(install) = runtime {
            c.scad_runtime(install)?;
            said = if install { "the ship is fetching the runtime".into() } else { "the runtime is uninstalled".into() };
        }
        if let Some(on) = mirror {
            c.mirror(on)?;
            said = if on { "the Commons mirror is on".into() } else { "the Commons mirror is off, and its copy deleted".into() };
        }
        if reindex {
            // its own failure is said beside its button, and is no reason to lose the rest
            said = match c.reindex() {
                Ok(()) => "reindex: done - your pages and notes are searchable.".into(),
                Err(e) => format!("reindex: failed: {e}"),
            };
        }
        if obelisk {
            c.obelisk_install()?;
            said = "the ship is installing %obelisk".into();
        }
        let local = look.then(|| scadrun::locate().map(|p| p.display().to_string()));
        Ok((c.tile_status()?, c.scad_status()?, local, said, c.obelisk()?))
    });
}

/// The map tiles and OpenSCAD parts of the settings.
fn settings_more(st: &Settings, k: &Kit) -> El {
    let c = &k.c;
    let muted = |t: &str| text(t.to_owned()).font(k.ty.small).color(c.text_muted).wrap();
    let head = |t: &str| text(t.to_owned()).font(k.ty.body_medium).color(c.text_base);
    let small = |label: String, key: &str, act: fn() -> SetAct| Button::new(label).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| settings_do(s, act())).build(k).key(key.to_owned());
    let tiles = col()
        .key("set-tiles")
        .w_full()
        .gap(6.0)
        .child(head("Map tiles"))
        .child(muted("Map pages draw their features on Mapbox's base maps. Your ship fetches each tile with your own Mapbox token and passes it on without keeping it, so Mapbox sees your ship and not this computer. With no token here, the one set in orrery is used. With neither, maps draw on a plain grid."))
        .child(text(st.tiles.as_ref().map_or("Checking\u{2026}", api::tiles_say).to_owned()).key("tiles-state").font(k.ty.small).color(c.text_base).wrap())
        .child(TextInput::new(&st.map_token).label("Mapbox token").placeholder("pk\u{2026}").secure().on_edit(|s: &mut App| &mut s.settings.as_mut().expect("the settings are showing").map_token).build(k).w_full().key("tiles-token"))
        .child(row().gap(4.0).child(small("Save".into(), "tiles-save", || SetAct::Token(true))).child(small("Remove".into(), "tiles-remove", || SetAct::Token(false))));
    let mut scad = col().key("set-scad").w_full().gap(6.0).child(head("OpenSCAD pages")).child(muted("This app draws a scad page's part with the OpenSCAD on this computer."));
    scad = scad.child(
        text(match &st.local_scad {
            None => "Looking for it\u{2026}".to_owned(),
            Some(Some(path)) => format!("Found: {path}"),
            Some(None) => "None was found. Install OpenSCAD, or name one with LATTICE_OPENSCAD. Until then a scad page shows its source.".to_owned(),
        })
        .key("scad-local")
        .font(k.ty.small)
        .color(c.text_base)
        .wrap(),
    );
    scad = scad.child(muted("A browser draws with a runtime your ship keeps and never runs. It is optional: until it is installed, a scad page in a browser shows its source."));
    match &st.scad {
        None => scad = scad.child(muted("checking\u{2026}")),
        Some(rt) => {
            let (said, install, uninstall) = rt.says();
            scad = scad.child(text(said).key("scad-state").font(k.ty.small).color(c.text_base).wrap());
            let mut acts = row().gap(4.0);
            if let Some(label) = install {
                acts = acts.child(small(label, "scad-install", || SetAct::Runtime(true)));
            }
            if uninstall {
                acts = acts.child(small("Uninstall".into(), "scad-uninstall", || SetAct::Runtime(false)));
            }
            scad = scad.child(acts);
        }
    }
    let mut ob = col()
        .key("set-mirror")
        .w_full()
        .gap(6.0)
        .child(head("Commons mirror"))
        .child(muted("Mirrors your pages, notes, tags, follows and browsing history into the %obelisk database, where you (and your agents) can query across apps with urQL. Turning it off deletes that copy. Optional: without %obelisk everything else works unchanged."));
    match st.obelisk {
        None => ob = ob.child(muted("checking\u{2026}")),
        Some(o) if o.installed => {
            ob = ob.child(text("%obelisk is installed.").key("mirror-state").font(k.ty.small).color(c.text_base)).child(Switch::new(o.enabled).label("Mirror enabled").on_toggle(move |s: &mut App| settings_do(s, SetAct::Mirror(!o.enabled))).build(k).key("mirror-on"));
        }
        Some(_) => {
            let said = if st.ob_tries > 0 {
                "installing from ~dister-nomryg-nilref (this can take a while)..."
            } else if st.ob_asked {
                "still not installed - check your ship is connected and retry."
            } else {
                "%obelisk is not installed."
            };
            ob = ob.child(text(said).key("mirror-state").font(k.ty.small).color(c.text_base).wrap());
            if st.ob_tries == 0 {
                ob = ob.child(row().child(small("Install %obelisk".into(), "obelisk-install", || SetAct::Obelisk)));
            }
        }
    }
    let busy = st.reindex == "reindexing...";
    let search = col()
        .key("set-search")
        .w_full()
        .gap(6.0)
        .child(head("Search index"))
        .child(muted("Search covers your published pages, your private page sources and your memories. The ship's index is rebuilt on demand rather than continuously, so reindex after a batch of edits to make them findable."))
        .child(row().gap(8.0).center_y().child(Button::new("Reindex my content").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(busy).on_press(|s: &mut App| settings_do(s, SetAct::Reindex)).build(k).key("reindex")).child(text(st.reindex.clone()).key("reindex-state").font(k.ty.small).color(c.text_muted)));
    col().w_full().gap(20.0).child(tiles).child(scad).child(ob).child(search)
}

/// Reads the agent keys, after making one (`mint`) or revoking one (`revoke`, by its id) when asked.
fn keys_do(s: &mut App, mint: Option<serde_json::Value>, revoke: Option<String>) {
    let Some(c) = s.conn.clone() else { return };
    if let Some(st) = &mut s.settings {
        st.sending = mint.is_some();
    }
    s.keys_req.request((c, mint, revoke), |(c, mint, revoke)| {
        let token = match &mint {
            Some(ask) => Some(c.key_mint(ask)?),
            None => None,
        };
        if let Some(id) = &revoke {
            c.key_revoke(id)?;
        }
        Ok((c.keys()?, token))
    });
}

/// Makes the key asked for, once what is typed is what the ship takes.
fn key_make(s: &mut App) {
    let Some(st) = s.settings.as_ref().filter(|st| !st.sending) else { return };
    match api::key_request(&st.ask()) {
        Ok(ask) => keys_do(s, Some(ask), None),
        Err(why) => s.note = why,
    }
}

fn settings_field(s: &mut App, i: usize) -> &mut TextEdit {
    &mut s.settings.as_mut().expect("the settings are showing").f[i]
}

/// The fonts the source editor may be set in, as the web client's
/// settings offer them: what the preference says, and its name.
const EDITOR_FONTS: [(&str, &str); 4] = [("", "App's own"), ("mono", "Monospace"), ("serif", "Serif"), ("coding", "Coding (Iosevka, JetBrains Mono)")];

/// The family the source editor is drawn in for a preference. `None`
/// leaves it as the app draws it. A named list is tried in order, with
/// faces most systems have after the ones asked for.
fn editor_family(pref: &str) -> Option<rune::Family> {
    match pref {
        "mono" => Some(rune::Family::SystemMono),
        "serif" => Some(rune::Family::Named("Georgia, Times New Roman, Noto Serif, DejaVu Serif, Liberation Serif")),
        "coding" => Some(rune::Family::Named("Iosevka, JetBrains Mono, Fira Code, Cascadia Mono, Menlo, Consolas, DejaVu Sans Mono, Liberation Mono")),
        _ => None,
    }
}

/// The kit the source editor is built with: the app's, in the font chosen.
fn editor_kit(k: &Kit, pref: &str) -> Kit {
    let mut ek = k.clone();
    if let Some(family) = editor_family(pref) {
        ek.ty.ui.family = family;
    }
    ek
}

/// Looks for piers on this machine. Asked for, not done on opening the settings: it walks a few levels of the home directory.
fn local_look(s: &mut App) {
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else {
        s.note = "this computer names no home directory to look under".into();
        return;
    };
    s.local_req.request(home, |home| local::discover(&home));
}

/// Mounts the ship found at `i` at the folder typed, or under the home directory by its name.
fn mount_ship(s: &mut App, i: usize) {
    let Some(st) = &s.settings else { return };
    let Some(ship) = st.local.as_ref().and_then(|l| l.get(i)).filter(|x| x.lick).cloned() else { return };
    let home = std::env::var("HOME").unwrap_or_default();
    let typed = st.mount_at.text.trim();
    let named = mounts::default_mountpoint(&ship.ship);
    let at = mounts::expand(if typed.is_empty() { &named } else { typed }, &home);
    let spec = mounts::MountSpec { mountpoint: at, sock: ship.sock.clone(), ship: ship.ship.clone(), ..mounts::MountSpec::default() };
    mount_start(s, spec, None);
}

/// Mounts the ship this window is signed in to, over HTTP with its session: every page, or the part of the tree typed.
fn mount_conn(s: &mut App) {
    let Some((c, st)) = s.conn.clone().zip(s.settings.as_ref()) else { return };
    let home = std::env::var("HOME").unwrap_or_default();
    let (typed, ship) = (st.mount_at.text.trim(), if c.ship().is_empty() { "ship" } else { c.ship() });
    let named = mounts::default_mountpoint(ship);
    let at = mounts::expand(if typed.is_empty() { &named } else { typed }, &home);
    let spec = mounts::MountSpec { mountpoint: at, url: c.url.clone(), root: st.mount_root.text.trim().to_owned(), ship: c.ship().to_owned(), ..mounts::MountSpec::default() };
    mount_start(s, spec, Some(c.cookie.clone()));
}

fn mount_start(s: &mut App, spec: mounts::MountSpec, session: Option<String>) {
    s.note = format!("mounting {} at {}\u{2026}", if spec.ship.is_empty() { "the ship" } else { spec.ship.as_str() }, spec.mountpoint);
    s.mount_req.request((s.mounts.clone(), spec, session), |(mut list, mut spec, session)| match mounts::start(&spec, session.as_deref()) {
        Ok(pid) => {
            spec.pid = pid;
            let said = format!("{} is mounted at {}", spec.ship, spec.mountpoint);
            list.retain(|m| m.mountpoint != spec.mountpoint);
            list.push(spec);
            let kept = mounts::save(&list).err().map_or_else(String::new, |e| format!(". It was not kept for the next launch: {e}"));
            (list, format!("{said}{kept}"))
        }
        Err(e) => (list, format!("not mounted: {e}")),
    });
}

/// Unmounts the folder at `i` and lets go of it.
fn unmount(s: &mut App, i: usize) {
    let Some(spec) = s.mounts.get(i).cloned() else { return };
    s.note = format!("unmounting {}\u{2026}", spec.mountpoint);
    s.mount_req.request((s.mounts.clone(), spec), |(mut list, spec)| match mounts::stop(&spec) {
        Ok(()) => {
            list.retain(|m| m.mountpoint != spec.mountpoint);
            let _ = mounts::save(&list);
            (list, format!("{} is unmounted", spec.mountpoint))
        }
        Err(e) => (list, format!("not unmounted: {e}")),
    });
}

/// The ships on this machine: each with where its pier is, and why it cannot be reached when it cannot.
/// Writes the whole store as one tar into the folder typed, or the home
/// directory when none is.
fn vault_export(s: &mut App) {
    let Some((c, st)) = s.conn.clone().zip(s.settings.as_ref()) else {
        s.note = "an export reads the whole store, so it needs the ship".into();
        return;
    };
    let typed = st.vault_dir.text.trim();
    let dir = mounts::expand(if typed.is_empty() { "~" } else { typed }, &std::env::var("HOME").unwrap_or_default());
    s.vault_said = "reading the store\u{2026}".into();
    s.vault_req.request((c, dir), |(c, dir)| {
        let now = crate::api::since_epoch().map_or(0, |d| d.as_secs());
        let built = match c.vault(now) {
            Ok(b) => b,
            Err(e) => return (e, false),
        };
        let at = std::path::Path::new(&dir).join(vault::file_name(now));
        // the whole store in one file: only its owner may read it
        match std::fs::create_dir_all(&dir).map_err(|e| e.to_string()).and_then(|()| api::write_private(&at, &built.bytes)) {
            Ok(()) => (built.says(&at.display().to_string()), false),
            Err(e) => (format!("export failed: could not write {}: {e}", at.display()), false),
        }
    });
}

/// A backup written, or not: whose, when, whether it was whole, and what to say.
struct BkDone {
    id: String,
    at: u64,
    complete: bool,
    said: String,
}

/// Writes one schedule's archive now, whatever its period says.
fn backup_run(s: &mut App, id: &str) {
    let Some(b) = s.backups.iter().find(|b| b.id == id).cloned() else { return };
    let Some(c) = s.conn.clone() else {
        s.bk_said = "a backup reads the whole store, so it needs the ship".into();
        return;
    };
    if s.bk_req.is_pending() {
        s.bk_said = "a backup is being written. Try again when it is done".into();
        return;
    }
    s.bk_said = format!("{}: reading the store\u{2026}", b.label);
    s.bk_req.request((c, b), |(c, b)| {
        let at = backups::now();
        let done = |complete, said| BkDone { id: b.id.clone(), at, complete, said };
        let built = match c.vault(at) {
            Ok(v) => v,
            Err(e) => return done(false, format!("{}: {e}", b.label)),
        };
        let complete = built.missing.is_empty();
        match backups::write_archive(&b, &built.bytes, at, complete) {
            Ok(path) if complete => done(true, format!("{}: backed up {} page(s) to {}", b.label, built.pages, path.display())),
            Ok(path) => done(false, format!("{}: {}. The backup is INCOMPLETE", b.label, built.says(&path.display().to_string()))),
            Err(e) => done(false, format!("{}: the backup failed: {e}", b.label)),
        }
    });
}

enum BkAct {
    Add,
    Now(String),
    Verify(String),
    /// Paused, or going again.
    Pause(String),
    /// The schedule goes. The archives it wrote stay.
    Remove(String),
}

fn backup_do(s: &mut App, act: BkAct) {
    s.bk_said.clear();
    match act {
        BkAct::Now(id) => return backup_run(s, &id),
        BkAct::Verify(id) => {
            let Some(b) = s.backups.iter().find(|b| b.id == id) else { return };
            // read here, not on a thread: one file from this computer's disk
            s.bk_said = format!("{}: {}", b.label, backups::verify_newest(b).map_or_else(|e| e, |r| r.says()));
            return;
        }
        BkAct::Pause(id) => {
            if let Some(b) = s.backups.iter_mut().find(|b| b.id == id) {
                b.enabled = !b.enabled;
            }
        }
        BkAct::Remove(id) => s.backups.retain(|b| b.id != id),
        BkAct::Add => {
            let Some(st) = s.settings.as_mut() else { return };
            let dir = mounts::expand(&st.bk_dir.text, &std::env::var("HOME").unwrap_or_default());
            let id = format!("bk{:x}", crate::api::since_epoch().map_or(0, |d| d.as_nanos()));
            match backups::new_schedule(&s.backups, &st.bk_label.text, &dir, st.bk_every, &st.bk_keep.text, id) {
                Ok(b) => {
                    s.backups.push(b);
                    st.bk_label = TextEdit::new("");
                    // it is due at once: the next look is now
                    s.bk_next = 0.0;
                }
                Err(e) => {
                    s.bk_said = e;
                    return;
                }
            }
        }
    }
    if let Err(e) = backups::save(&s.backups) {
        s.bk_said = format!("the schedules were not kept: {e}");
    }
}

fn backups_view(st: &Settings, list: &[backups::Schedule], said: &str, busy: bool, k: &Kit) -> El {
    let c = &k.c;
    let muted = |t: String| text(t).font(k.ty.small).color(c.text_muted).wrap();
    let small = |label: &str, key: String, act: BkAct| {
        let act = std::cell::Cell::new(Some(act));
        Button::new(label.to_owned()).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
            if let Some(a) = act.take() {
                backup_do(s, a);
            }
        }).build(k).key(key)
    };
    let now = backups::now();
    let mut v = col().key("set-backups").w_full().gap(6.0).child(text("Automatic backups").font(k.ty.body_medium).color(c.text_base)).child(muted("Whole-store archives written to this computer on a schedule, the same tar as the export above. They run while this app is open. One that came due while it was closed runs shortly after it is next opened.".into()));
    if list.is_empty() {
        v = v.child(muted("No scheduled backups yet.".into()).key("bk-none"));
    }
    for (i, b) in list.iter().enumerate() {
        let late = backups::overdue(b, now);
        let keep = if b.keep == 0 { "keeping every one".to_owned() } else { format!("keeping {}", b.keep) };
        v = v.child(
            col()
                .key(format!("bk-{i}"))
                .w_full()
                .gap(2.0)
                .child(text(format!("{}: {}, {keep}{}", b.label, backups::period(b.every_hours), if b.enabled { "" } else { " (paused)" })).key(format!("bk-head-{i}")).font(k.ty.small).color(c.text_base).wrap())
                .child(text(format!("{} \u{b7} {}{}", b.dir, backups::ago(b.last_run, now), if late { ". The last run did not complete" } else { "" })).key(format!("bk-sub-{i}")).font(k.ty.small).color(if late { c.danger.icon } else { c.text_muted }).wrap())
                .child(
                    row()
                        .gap(4.0)
                        .flex_wrap()
                        .child(small(if busy { "Backing up\u{2026}" } else { "Back up now" }, format!("bk-now-{i}"), BkAct::Now(b.id.clone())))
                        .child(small("Verify latest", format!("bk-verify-{i}"), BkAct::Verify(b.id.clone())))
                        .child(small(if b.enabled { "Pause" } else { "Resume" }, format!("bk-pause-{i}"), BkAct::Pause(b.id.clone())))
                        .child(small("Remove", format!("bk-remove-{i}"), BkAct::Remove(b.id.clone()))),
                ),
        );
    }
    let field = |t: &TextEdit, label: &str, hint: &str, key: &str, which: fn(&mut Settings) -> &mut TextEdit| TextInput::new(t).label(label.to_owned()).placeholder(hint.to_owned()).on_edit(move |s: &mut App| which(s.settings.as_mut().expect("the settings are showing"))).build(k).w_full().key(key.to_owned());
    let mut every = row().gap(4.0).flex_wrap();
    for (hours, label) in [(24, "Every day"), (168, "Every week"), (720, "Every 30 days"), (1, "Every hour")] {
        every = every.child(Button::new(label).control_size(ControlSize::Small).variant(if st.bk_every == hours { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| {
            if let Some(st) = &mut s.settings {
                st.bk_every = hours;
            }
        }).build(k).key(format!("bk-every-{hours}")));
    }
    v.child(field(&st.bk_label, "Name", "daily", "bk-label", |st| &mut st.bk_label))
        .child(every)
        .child(field(&st.bk_keep, "How many to keep", "0 keeps every one", "bk-keep", |st| &mut st.bk_keep))
        .child(field(&st.bk_dir, "Folder on this computer", "~/backups", "bk-dir", |st| &mut st.bk_dir))
        .child(row().child(small("Add schedule", "bk-add".into(), BkAct::Add)))
        .child(text(said.to_owned()).key("bk-said").font(k.ty.small).color(c.text_base).wrap())
}

/// Reads the archive named and asks before putting it back. Nothing is
/// written until the answer.
fn vault_restore(s: &mut App) {
    let Some(st) = s.settings.as_ref() else { return };
    if s.conn.is_none() {
        s.vault_said = "a restore writes many pages, so it needs the ship".into();
        return;
    }
    let typed = st.vault_file.text.trim();
    if typed.is_empty() {
        s.vault_said = "name the archive to restore from".into();
        return;
    }
    let at = mounts::expand(typed, &std::env::var("HOME").unwrap_or_default());
    match std::fs::read(&at).map_err(|e| format!("could not read {at}: {e}")).and_then(|b| vault::read(&b)) {
        Ok(a) => {
            s.vault_said.clear();
            s.prompt = Some(Prompt::Restore(Box::new(a)));
        }
        Err(e) => s.vault_said = e,
    }
}

fn vault_view(st: &Settings, said: &str, busy: bool, k: &Kit) -> El {
    let c = &k.c;
    col()
        .key("set-vault")
        .w_full()
        .gap(6.0)
        .child(text("Backup").font(k.ty.body_medium).color(c.text_base))
        .child(text("Every page and memory as one tar. The archive is plain files, readable without lattice.").font(k.ty.small).color(c.text_muted).wrap())
        .child(TextInput::new(&st.vault_dir).label("Folder to export to").placeholder("your home directory when left empty").on_edit(|s: &mut App| &mut s.settings.as_mut().expect("the settings are showing").vault_dir).build(k).w_full().key("vault-dir"))
        .child(row().gap(8.0).child(Button::new(if busy { "Exporting\u{2026}" } else { "Export vault" }).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(busy).on_press(vault_export).build(k).key("vault-export")))
        .child(TextInput::new(&st.vault_file).label("Archive to restore from").placeholder("a lattice-vault tar on this computer").on_edit(|s: &mut App| &mut s.settings.as_mut().expect("the settings are showing").vault_file).build(k).w_full().key("vault-file"))
        .child(row().gap(8.0).child(Button::new("Restore vault\u{2026}").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(busy).on_press(vault_restore).build(k).key("vault-restore")))
        .child(text(said.to_owned()).key("vault-said").font(k.ty.small).color(c.text_base).wrap())
}

fn local_view(st: &Settings, held: &[mounts::MountSpec], signed_in: bool, busy: bool, looking: bool, k: &Kit) -> El {
    let c = &k.c;
    let muted = |t: &str| text(t.to_owned()).font(k.ty.small).color(c.text_muted).wrap();
    let mut v = col()
        .key("set-local")
        .w_full()
        .gap(6.0)
        .child(text("On this machine").font(k.ty.body_medium).color(c.text_base))
        .child(muted("Ships running here can be reached directly over lick, with no URL and no +code. The socket lives inside the pier, so being able to open it is the permission."));
    match &st.local {
        None => {}
        Some(found) if found.is_empty() => v = v.child(text("no piers found under your home directory.").key("local-none").font(k.ty.small).color(c.text_muted)),
        Some(found) => {
            for (i, ship) in found.iter().enumerate() {
                v = v.child(
                    row()
                        .key(format!("local-{i}"))
                        .gap(8.0)
                        .center_y()
                        .child(text(ship.ship.clone()).font(k.ty.mono).color(c.text_base))
                        .child(text(ship.says()).key(format!("local-says-{i}")).font(k.ty.small).color(c.text_muted).grow(1.0).min_w(0.0).truncate())
                        .children(ship.lick.then(|| text("over lick").font(k.ty.small_medium).color(c.success.icon)))
                        .children(ship.lick.then(|| Button::new("Mount").control_size(ControlSize::Small).variant(ButtonVariant::Contrast).disabled(busy).help("Its pages as a folder on this computer").on_press(move |s: &mut App| mount_ship(s, i)).build(k).key(format!("local-mount-{i}")))),
                );
            }
        }
    }
    if signed_in {
        // the ship this window is signed in to, wherever it runs: over HTTP, with this session
        v = v.child(muted("The ship you are signed in to can be mounted too, over HTTP with this session: every page, or one part of the tree.")).child(
            row()
                .gap(6.0)
                .center_y()
                .child(TextInput::new(&st.mount_root).label("Part of the tree").placeholder("a folder like notes, or empty for every page").on_edit(|s: &mut App| &mut s.settings.as_mut().expect("the settings are showing").mount_root).build(k).grow(1.0).key("mount-root"))
                .child(Button::new("Mount this ship").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(busy).on_press(mount_conn).build(k).key("mount-ship")),
        );
    }
    if signed_in || st.local.as_ref().is_some_and(|l| l.iter().any(|x| x.lick)) {
        v = v.child(TextInput::new(&st.mount_at).label("Folder to mount at").placeholder("~/ship-name when left empty").on_edit(|s: &mut App| &mut s.settings.as_mut().expect("the settings are showing").mount_at).build(k).w_full().key("mount-at"));
    }
    if !held.is_empty() {
        v = v.child(text("Mounts").font(k.ty.small_medium).color(c.text_base));
        for (i, m) in held.iter().enumerate() {
            v = v.child(
                row()
                    .key(format!("mount-{i}"))
                    .gap(8.0)
                    .center_y()
                    .child(text(m.mountpoint.clone()).key(format!("mount-at-{i}")).font(k.ty.mono).color(c.text_base).grow(1.0).min_w(0.0).truncate())
                    .child(text(format!("{} \u{b7} {}{}", if m.sock.is_empty() { "http" } else { "lick" }, if m.ship.is_empty() { "local" } else { m.ship.as_str() }, if m.root.is_empty() { String::new() } else { format!(" \u{b7} {}", m.root) })).key(format!("mount-how-{i}")).font(k.ty.small).color(c.text_muted))
                    .child(Button::new("Unmount").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(busy).on_press(move |s: &mut App| unmount(s, i)).build(k).key(format!("unmount-{i}"))),
            );
        }
    }
    v.child(row().child(Button::new(if looking { "Looking\u{2026}" } else if st.local.is_some() { "Look again" } else { "Look for ships" }).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(looking).help("Looks a few levels under your home directory for piers. Nothing in them is read").on_press(local_look).build(k).key("local-look")))
}

/// Asks the ship what it has of lattice's software.
fn stack_ask(s: &mut App) {
    if let Some(c) = s.conn.clone() {
        s.stack_req.request(c, |c| c.stack());
    }
}

/// Asks the ship to install %grubbery from the ship typed, through its %mcp.
fn grubbery_install(s: &mut App) {
    let Some((c, st)) = s.conn.clone().zip(s.settings.as_ref()) else { return };
    // the ship typed is the one asked: it is never swapped for another
    let Some(from) = api::ship_name(&st.dist.text).filter(|_| st.dist.text.trim().starts_with('~')) else {
        s.note = "that is not a ship's name: try ~nisfeb".into();
        return;
    };
    s.note = format!("asking {from} for %grubbery\u{2026}");
    s.op_req.request((c, from), |(c, from)| {
        c.install_grubbery(&from)?;
        Ok(Op::Said("the ship took the install. %grubbery comes over the network in a few minutes: check again then".into()))
    });
}

/// What the ship lacks of lattice's software, shown only when it lacks something, with what to do about it.
fn stack_view(st: &Settings, k: &Kit) -> Option<El> {
    let c = &k.c;
    let stack = st.stack.as_ref().filter(|x| x.missing())?;
    let muted = |t: &str| text(t.to_owned()).font(k.ty.small).color(c.text_muted).wrap();
    let mut v = col().key("set-stack").w_full().gap(6.0).child(text("Ship software").font(k.ty.body_medium).color(c.text_base));
    for (on, name, word) in stack.lines() {
        v = v.child(row().gap(8.0).center_y().child(text(if on { "\u{2713}" } else { "\u{25cb}" }).font(k.ty.ui).color(if on { c.success.icon } else { c.text_muted })).child(text(name).font(k.ty.mono).color(c.text_base)).child(text(word).key(format!("stack-{}", name.trim_start_matches('%'))).font(k.ty.small).color(c.text_muted)));
    }
    if stack.mcp.is_none() {
        v = v
            .child(text("%mcp is not installed on this ship.").font(k.ty.small).color(c.danger.icon))
            .child(muted("lattice installs the rest through %mcp, so it has to go on first, and it cannot install itself. From your ship's dojo:"))
            .child(text("|install ~nisfeb %mcp").key("stack-mcp-command").font(k.ty.mono).color(c.text_base).selectable(true))
            .child(muted("Then press check again."));
    } else if !stack.grubbery {
        // %grubbery needs %mcp to install it, so this is never offered first
        v = v
            .child(muted("%grubbery is missing. lattice runs as a nexus inside it, so it is installed first, over Ames from a publishing ship. This takes a few minutes: the whole desk transfers over Ames."))
            .child(row().gap(6.0).center_y().child(TextInput::new(&st.dist).label("Ship to install from").on_edit(|s: &mut App| &mut s.settings.as_mut().expect("the settings are showing").dist).build(k).grow(1.0).key("stack-dist")).child(Button::new("Install %grubbery").control_size(ControlSize::Small).variant(ButtonVariant::Contrast).on_press(grubbery_install).build(k).key("stack-install")));
    }
    Some(v.child(row().child(Button::new("Check again").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(stack_ask).build(k).key("stack-check"))))
}

/// Shows or hides the form that connects, with the ship's address in it to sign in again, or empty for another ship.
fn connect_form(s: &mut App, show: bool, another: bool) {
    if show && !leave_edit(s) {
        return;
    }
    let url = s.conn.as_ref().filter(|_| !another).map(|c| c.url.clone()).unwrap_or_default();
    (s.url, s.code) = (TextEdit::new(url.as_str()), TextEdit::new(""));
    s.url.focused = another;
    s.code.focused = !another;
    s.login_err.clear();
    if let Some(st) = &mut s.settings {
        st.connect = show;
    }
}

/// The ship this window is on, how the connection stands, and the way to sign in again or to another ship.
fn ship_view(s: &App, st: &Settings, k: &Kit) -> El {
    let c = &k.c;
    let mut v = col().key("set-ship").w_full().gap(6.0).child(text("Ship").font(k.ty.body_medium).color(c.text_base));
    let Some(conn) = &s.conn else {
        return v.child(text("Sample pages: no ship is connected.").key("ship-state").font(k.ty.small).color(c.text_muted));
    };
    let state = api::link(s.offline.is_some(), s.lapsed);
    let (dot, said) = match state {
        api::Link::Connected => (c.success.icon, format!("connected as {}", if conn.ship().is_empty() { "your ship" } else { conn.ship() })),
        api::Link::Unreachable => (c.danger.icon, "cannot reach this ship".to_owned()),
        api::Link::SignedOut => (c.text_muted, "signed out: enter your +code to reconnect".to_owned()),
    };
    v = v
        .child(row().gap(8.0).center_y().child(el().w(8.0).h(8.0).radius(4.0).fill(dot)).child(text(said).key("ship-state").font(k.ty.ui).color(c.text_base)))
        .child(text(conn.url.clone()).key("ship-url").font(k.ty.mono).color(c.text_muted).truncate());
    if !st.connect {
        let mut acts = row().gap(4.0);
        if state != api::Link::Connected {
            acts = acts.child(Button::new("Reconnect").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Sign in to this ship again").on_press(|s: &mut App| connect_form(s, true, false)).build(k).key("ship-reconnect"));
        }
        return v.child(acts.child(Button::new("Change ship").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Sign in to another ship").on_press(|s: &mut App| connect_form(s, true, true)).build(k).key("ship-change")));
    }
    let busy = s.login_req.is_pending();
    let mut form = col()
        .key("ship-connect")
        .w_full()
        .gap(6.0)
        .padding(10.0)
        .radius(k.radius.md)
        .fill(c.layer_01)
        .child(TextInput::new(&s.url).label("Ship address").placeholder("https://your-ship.example.com").on_edit(|s: &mut App| &mut s.url).build(k).w_full().key("ship-address"))
        .child(TextInput::new(&s.code).label("Access code").placeholder("+code").secure().on_edit(|s: &mut App| &mut s.code).on_submit(|s: &mut App, _| sign_in(s)).build(k).w_full().key("ship-code"))
        .child(
            row()
                .gap(6.0)
                .center_y()
                .child(Button::new(if busy { "Connecting\u{2026}" } else { "Connect" }).control_size(ControlSize::Small).variant(ButtonVariant::Contrast).disabled(busy).on_press(sign_in).build(k).key("ship-connect-go"))
                .child(Button::new("Cancel").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| connect_form(s, false, false)).build(k).key("ship-connect-cancel")),
        );
    if !s.login_err.is_empty() {
        form = form.child(text(s.login_err.clone()).key("ship-connect-error").font(k.ty.small).color(c.danger.icon).wrap());
    }
    v.child(form)
}

/// The settings: the agent keys, each with what it may touch and a Revoke, and the form that makes one.
fn settings_view(s: &App, st: &Settings, k: &Kit) -> El {
    let (pub_ok, font, vim_on) = (s.prefs.pub_ok, s.prefs.font.as_str(), s.prefs.vim);
    let c = &k.c;
    let ship = ship_view(s, st, k);
    let mut fonts = row().gap(4.0).flex_wrap();
    for (pref, name) in EDITOR_FONTS {
        fonts = fonts.child(Button::new(name).control_size(ControlSize::Small).variant(if font == pref { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| {
            s.prefs.font = pref.to_owned();
            save_prefs(s);
        }).build(k).key(format!("font-{}", if pref.is_empty() { "app" } else { pref })));
    }
    let sample = editor_kit(k, font).ty.ui;
    let editor = col()
        .key("set-editor")
        .w_full()
        .gap(6.0)
        .child(text("Editor").font(k.ty.body_medium).color(c.text_base))
        .child(text("The font a page's source is written in. Kept on this computer.").font(k.ty.small).color(c.text_muted).wrap())
        .child(fonts)
        .child(Switch::new(vim_on).label("Vim mode in the source editor").on_toggle(|s: &mut App| {
            s.prefs.vim = !s.prefs.vim;
            save_prefs(s);
        }).build(k).key("vim-on"))
        .child(text("Modal editing: Esc for normal, i to insert, :w to save.").font(k.ty.small).color(c.text_muted).wrap())
        .child(el().w_full().padding(10.0).radius(k.radius.md).fill(c.layer_01).child(text("The quick brown fox jumps over the lazy dog \u{b7} 0123456789 \u{b7} il1 O0 \u{b7} |= ^- @ud").key("font-sample").font(sample).color(c.text_base).wrap()));
    // what is worn is chosen here as on the web client's settings page. Themes themselves are made there or in Talon
    let worn = &s.prefs.worn;
    let themed = worn.look().bg.is_some();
    let pick = |label: String, on: bool| Button::new(label).control_size(ControlSize::Small).variant(if on { ButtonVariant::Contrast } else { ButtonVariant::Ghost });
    let mut theme = col().key("set-theme").w_full().gap(6.0).child(text("Theme").font(k.ty.body_medium).color(c.text_base));
    if s.conn.is_some() {
        let own = worn.own;
        theme = theme
            .child(Switch::new(own).label("Use a lattice-specific theme").on_toggle(move |s: &mut App| theme_change(s, |w| w.set_own(!own))).build(k).key("theme-own"))
            .child(text(worn.said()).key("theme-worn").font(k.ty.small).color(c.text_muted).wrap());
        if own {
            let active = worn.own_active().map(str::to_owned);
            let mut themes = row().key("theme-picks").gap(4.0).flex_wrap().child(pick("Built-in".into(), active.is_none()).on_press(|s: &mut App| theme_change(s, |w| w.set_active(None))).build(k).key("theme-pick:"));
            for (id, name) in worn.themes() {
                let on = active.as_deref() == Some(id.as_str());
                let key = format!("theme-pick:{id}");
                themes = themes.child(pick(name, on).on_press(move |s: &mut App| theme_change(s, |w| w.set_active(Some(&id)))).build(k).key(key));
            }
            let accent = worn.own_accent();
            let custom = matches!(accent, theme::Accent::Custom(_));
            let mut accents = row().key("theme-accent").gap(4.0).center_y().flex_wrap()
                .child(pick("Off".into(), accent == theme::Accent::Off).on_press(|s: &mut App| theme_change(s, |w| w.set_accent(theme::Accent::Off))).build(k).key("accent-off"))
                .child(pick("Profile colour".into(), accent == theme::Accent::Profile).on_press(|s: &mut App| theme_change(s, |w| w.set_accent(theme::Accent::Profile))).build(k).key("accent-profile"))
                .child(pick("Custom".into(), custom).on_press(|s: &mut App| {
                    // the colour it had, or lattice's own green to start from
                    let hex = match s.prefs.worn.own_accent() {
                        theme::Accent::Custom(h) if !h.is_empty() => h,
                        _ => s.prefs.worn.accent.get("customHex").and_then(|v| v.as_str()).and_then(theme::hex_of).unwrap_or_else(|| "#4A7C59".to_owned()),
                    };
                    s.accent_hex = TextEdit::new(hex.as_str());
                    theme_change(s, |w| w.set_accent(theme::Accent::Custom(hex)));
                }).build(k).key("accent-custom"));
            if custom {
                accents = accents.child(TextInput::new(&s.accent_hex).label("The accent's colour").placeholder("#RRGGBB, then Return").on_edit(|s: &mut App| &mut s.accent_hex).on_submit(|s: &mut App, _| match theme::hex_of(&s.accent_hex.text) {
                    Some(hex) => theme_change(s, |w| w.set_accent(theme::Accent::Custom(hex))),
                    None => s.note = "A colour is six hex figures, as #4A7C59".into(),
                }).build(k).w(170.0).key("accent-hex"));
            }
            // a new theme starts light or dark as the window is now
            let dark_now = k.c.text_base.luminance() > k.c.bg_base.luminance();
            let mut tools = row().key("theme-tools").gap(4.0).child(Button::new("New theme").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
                let id = format!("r{:x}", api::since_epoch().map_or(0, |d| d.as_nanos()));
                draft_open(s, theme::Draft::new(id, dark_now));
            }).build(k).key("theme-new"));
            if let Some(cur) = worn.own_draft() {
                let id = cur.id.clone();
                tools = tools
                    .child(Button::new("Edit").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| draft_open(s, cur.clone())).build(k).key("theme-edit"))
                    .child(Button::new("Delete").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(move |s: &mut App| {
                        s.theme_draft = None;
                        theme_change(s, |w| w.delete_theme(&id));
                    }).build(k).key("theme-delete"));
            }
            theme = theme
                .child(text("Your own themes: pick five colours and the rest is worked out. Saved to your ship, so they follow you to every device.").font(k.ty.small).color(c.text_muted).wrap())
                .child(themes)
                .child(tools)
                .children(draft_now(s).map(|d| draft_view(s, &d, k)))
                .child(text("An accent: one colour over whichever theme is in use, as in Talon.").font(k.ty.small).color(c.text_muted).wrap())
                .child(accents);
        }
        let own_font = worn.own_font;
        theme = theme
            .child(Switch::new(!own_font).label("Use Talon's font").on_toggle(move |s: &mut App| theme_change(s, |w| w.set_own_font(!own_font))).build(k).key("theme-font-on"))
            .child(text(worn.font_said()).key("theme-font").font(k.ty.small).color(c.text_muted).wrap());
    } else {
        theme = theme.child(text("The sample pages wear the built-in theme.").key("theme-worn").font(k.ty.small).color(c.text_muted).wrap());
    }
    let theme = theme.child(text(if themed { "A theme brings its own light or dark." } else { "Light, dark, or whatever the system is set to: the button at the foot of the left pane. Kept on this computer." }).font(k.ty.small).color(c.text_muted).wrap());
    // the way back from "do not ask again"
    let mut publishing = col()
        .key("set-publishing")
        .w_full()
        .gap(6.0)
        .child(text("Publishing").font(k.ty.body_medium).color(c.text_base))
        .child(text(if pub_ok { "Making a page public does not ask first on this computer." } else { "Making a page public asks first." }).key("publish-state").font(k.ty.small).color(c.text_muted).wrap());
    if pub_ok {
        publishing = publishing.child(row().child(Button::new("Ask before making a page public").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
            s.prefs.pub_ok = false;
            s.prefs.save();
        }).build(k).key("publish-ask")));
    }
    let muted = |t: &str| text(t.to_owned()).font(k.ty.small).color(c.text_muted).wrap();
    let mut page = col().key("settings").w_full().max_w(760.0).padding(28.0).gap(12.0).child(ship).children(stack_view(st, k)).child(local_view(st, &s.mounts, s.conn.is_some(), s.mount_req.is_pending(), s.local_req.is_pending(), k)).child(vault_view(st, &s.vault_said, s.vault_req.is_pending(), k)).child(backups_view(st, &s.backups, &s.bk_said, s.bk_req.is_pending(), k)).child(text("Agent keys").font(k.ty.body_medium).color(c.text_base)).child(muted(
        "A key lets an agent, such as the lattice plugin for Claude Code or Hermes, use your memory and pages without your login. Everything a key saves is signed with the name it writes as, and its scope says what it may touch. Publishing, sharing and settings stay yours whatever the scope.",
    ));
    if let Some(token) = &st.token {
        let copy = token.clone();
        page = page.child(
            col()
                .key("key-token")
                .w_full()
                .gap(6.0)
                .padding(10.0)
                .radius(k.radius.md)
                .fill(c.layer_01)
                .child(text("Copy this key now. It is not shown again.").font(k.ty.small_medium).color(c.text_base))
                .child(text(token.clone()).key("key-secret").font(k.ty.mono).color(c.text_base).wrap())
                .child(row().child(Button::new("Copy").control_size(ControlSize::Small).variant(ButtonVariant::Contrast).on_press_tx(move |s: &mut App, tx: &mut Tx| {
                    tx.copy(copy.clone());
                    s.note = "the key is copied".into();
                }).build(k).key("key-copy"))),
        );
    }
    match &st.keys {
        None => page = page.child(muted("reading the keys\u{2026}")),
        Some(keys) if keys.is_empty() => page = page.child(muted("No keys yet.")),
        Some(keys) => {
            for key in keys {
                let (id, title) = (key.id.clone(), key.title.clone());
                page = page.child(
                    col()
                        .key(format!("key-{}", key.id))
                        .w_full()
                        .gap(4.0)
                        .padding(10.0)
                        .radius(k.radius.md)
                        .fill(c.layer_01)
                        .child(text(key.title.clone()).font(k.ty.ui).color(c.text_base).wrap())
                        .child(muted(&key.detail))
                        .child(row().child(Button::new("Revoke").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help("It stops working at once").on_press(move |s: &mut App| s.prompt = Some(Prompt::KeyRevoke(id.clone(), title.clone()))).build(k).key(format!("key-revoke-{}", key.id)))),
                );
            }
        }
    }
    // one of a few: what the key may do with one thing
    let pick = |group: &'static str, now: &'static str, opts: &[(&'static str, &'static str)]| {
        let mut r = row().gap(4.0).flex_wrap();
        for &(val, label) in opts {
            r = r.child(Button::new(label.to_owned()).control_size(ControlSize::Small).variant(if now == val { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).on_press(move |s: &mut App| {
                if let Some(st) = &mut s.settings {
                    match group {
                        "memory" => st.memory = val,
                        "pages" => st.pages = val,
                        "web" => st.web = val,
                        _ => st.skills = val,
                    }
                }
            }).build(k).key(format!("k{group}-{val}")));
        }
        r
    };
    let line = |i: usize, label: &str, hint: &str, key: &str| col().w_full().gap(2.0).child(muted(label)).child(TextInput::new(&st.f[i]).label(label.to_owned()).placeholder(hint.to_owned()).on_edit(move |s: &mut App| settings_field(s, i)).build(k).w_full().key(key.to_owned()));
    let mut form = col()
        .key("key-form")
        .w_full()
        .gap(8.0)
        .padding(10.0)
        .radius(k.radius.md)
        .fill(c.layer_01)
        .child(text("Make a key").font(k.ty.small_medium).color(c.text_base))
        .child(line(0, "Name", "laptop Claude", "key-name"))
        .child(line(1, "Writes as", "claude-laptop", "key-by"))
        .child(muted("Memory"))
        .child(pick("memory", st.memory, &[("write", "Read and write"), ("read", "Read"), ("none", "None")]))
        .child(muted("Pages"))
        .child(pick("pages", st.pages, &[("read", "Read"), ("write", "Read, write private pages"), ("none", "None"), ("some", "Scoped to paths")]));
    if st.pages == "some" {
        form = form.child(line(2, "Pages read paths", "/notes, /projects", "key-pread")).child(line(3, "Pages write paths", "/notes/agent", "key-pwrite"));
    }
    form = form.child(muted("Other ships")).child(pick("web", st.web, &[("off", "None"), ("all", "Read all ships"), ("some", "Scoped to one ship")]));
    if st.web == "some" {
        form = form.child(line(4, "Ship", "~sampel-palnet", "key-wship")).child(line(5, "Its read paths", "/x", "key-wread")).child(line(6, "Its write paths", "/x/out", "key-wwrite"));
    }
    form = form
        .child(muted("Skills"))
        .child(pick("skills", st.skills, &[("none", "None"), ("read", "Read"), ("write", "Read and write")]))
        .child(Switch::new(st.sensitive).label("Read sensitive memories").on_toggle(|s: &mut App| {
            if let Some(st) = &mut s.settings {
                st.sensitive = !st.sensitive;
            }
        }).build(k).key("key-sensitive"))
        .child(muted("A memory with sensitive: yes in its front matter (health, money, family) is invisible to a key without this. A key with it can read them, but for 12 hours after reading one, everything it writes is marked sensitive too, so it cannot pass what it read to a key without clearance. Clearance is set here, when the key is made."))
        .child(row().child(Button::new(if st.sending { "Making\u{2026}" } else { "Make key" }).control_size(ControlSize::Small).variant(ButtonVariant::Contrast).disabled(st.sending).on_press(key_make).build(k).key("key-make")));
    col().key("settings-pane").w_full().h_full().min_h(0.0).child(col().w_full().items_center().child(page.child(form).child(settings_more(st, k)).child(publishing).child(theme).child(editor))).scroll(ScrollSpec { stick_bottom: false })
}

fn next_theme(s: &mut App) {
    s.prefs.theme = s.prefs.next_theme().to_owned();
    save_prefs(s);
}

fn open_share(s: &mut App) {
    // a page's sharing is the right pane's Page tab. A folder has no pane, so its sharing is a dialog
    if s.open.is_some() && !s.memory && s.remote.is_none() {
        s.sharing = false;
        pane_tab(s, rpane::Tab::Page);
        return;
    }
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
    ("search", "Search your pages and notes"),
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
    ("urb-open", "Browser"),
    ("link-in", "Move into my pages"),
    ("link-back", "Move back to shared with me"),
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
        // a link made from a page shared to read is read only
        "edit" => page && s.remote.as_ref().is_none_or(Shared::editable) && (s.memory || s.remote.is_some() || s.open.as_ref().and_then(|p| s.links.get(&p.name)).is_none_or(|l| l.mode != "read")),
        // a page open from shared with me goes into the tree as a link, and a link goes back
        "link-in" => page && !s.editing && s.remote.as_ref().is_some_and(|r| !swm::is_dir(&r.path) && s.shared.contains(r)),
        "link-back" => own && !s.memory && !s.editing && s.open.as_ref().is_some_and(|p| s.links.contains_key(&p.name)),
        "delete" => own,
        "download" | "copy-name" => page,
        "duplicate" | "copy-link" | "pdf" => own && !s.memory && !s.editing,
        "tex" => own && !s.memory && s.open.as_ref().is_some_and(|p| p.kind == "tex"),
        // a sheet, a document and a map are files of their own shape: their kind is not one to type over
        "kind" => own && !s.memory && !s.editing && s.open.as_ref().is_some_and(|p| PAGE_KINDS.contains(&p.kind.as_str()) && s.links.get(&p.name).is_none()),
        "rename" | "share" | "links" | "comments" | "history" => own && !s.memory,
        "find" => page && find_where(s) != FindIn::Nothing,
        "reload" | "map-token" => s.conn.is_some(),
        "map-base" => own && !s.editing && s.map.as_ref().is_some_and(|m| s.open.as_ref().is_some_and(|p| p.name == m.name)),
        "map-import" => map_changes(s),
        "map-gpx" => page && s.map.is_some(),
        "tab-close" => s.tabs.len() > 1,
        "tab-copy" => own && !s.memory,
        "split" => !s.tgroups.is_empty() || (own && !s.memory),
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
    save_prefs(s);
    match id {
        "new" => ask_new(s),
        "kind" => {
            if let Some(p) = &s.open {
                let mut t = TextEdit::new(p.kind.clone());
                t.focused = true;
                t.set_selection(0, p.kind.len());
                s.prompt = Some(Prompt::Kind(t));
            }
        }
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
        "search" => open_search(s),
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
        "links" => show_pane(s, rpane::Tab::Out),
        "comments" => show_pane(s, rpane::Tab::Comments),
        "history" => show_pane(s, rpane::Tab::Hist),
        "inbox" => go_inbox(s),
        "shared" => go_shared(s),
        "urb-open" => go_browser(s),
        "link-in" => ask_link_in(s),
        "link-back" => link_back(s),
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
    // the one other way in: no node, and other ships' published pages read by this computer itself
    #[cfg(unix)]
    {
        card = card
            .child(text("No node? You can use lattice anonymously. You can browse pages people publish, but you can't save or host pages without a node.").key("anon-said").font(k.ty.small).color(c.text_muted).wrap())
            .child(Button::new("Use anonymously").variant(ButtonVariant::Ghost).on_press(browse_anon).build(k).key("anon"));
    }
    // adding a ship beside the one in front: a way back to it
    if let (true, Some(now)) = (s.adding, &s.conn) {
        card = card.child(Button::new(format!("Back to {}", now.ship())).variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.adding = false).build(k).key("add-back"));
    }
    col().w_full().h_full().center().fill(c.bg_base).child(card)
}

/// The ships signed in on this computer: go to one, add one, or sign out.
fn ships_view(s: &App, k: &Kit, layer: &mut Vec<El>) {
    if !s.ships_open {
        return;
    }
    let c = &k.c;
    let mut list = col().key("ship-list").w_full().gap(4.0);
    for (i, sh) in s.ships.iter().enumerate() {
        let url = sh.url.clone();
        let host = sh.url.split("://").nth(1).unwrap_or(&sh.url).to_owned();
        let news = if sh.front { String::new() } else { ship_news(s.seen.lock().ok().and_then(|m| m.get(&sh.url).cloned()).as_ref()) };
        let said = if sh.front { format!("{host} \u{b7} in front") } else if !news.is_empty() { format!("{host} \u{b7} {news}") } else if sh.expired { format!("{host} \u{b7} sign in again") } else { host };
        list = list.child(
            row()
                .key(format!("ship-{i}"))
                .role("button")
                .label(format!("{}, {said}", sh.name))
                .w_full()
                .px(10.0)
                .py(6.0)
                .gap(8.0)
                .center_y()
                .radius(k.radius.sm)
                .fill(if sh.front { c.layer_01 } else { rune::Color::TRANSPARENT })
                .hover(c.hover)
                .on_press(move |s: &mut App| switch_ship(s, &url))
                .child(col().grow(1.0).min_w(0.0).gap(1.0).child(text(sh.name.clone()).font(k.ty.ui_medium).color(c.text_base).truncate()).child(text(said).font(k.ty.small).color(c.text_muted).truncate())),
        );
    }
    if s.ships.is_empty() {
        list = list.child(text("No ship is signed in on this computer.").font(k.ty.small).color(c.text_muted));
    }
    let front = s.conn.as_ref().map(|c| c.ship().to_owned());
    let mut acts = row().w_full().gap(8.0).flex_wrap().child(Button::new("Add a ship").variant(ButtonVariant::Contrast).help("Sign in to another ship. This one stays signed in").on_press(|s: &mut App| {
        if leave_edit(s) {
            (s.ships_open, s.adding) = (false, true);
            (s.url, s.code) = (TextEdit::new(""), TextEdit::new(""));
            s.url.focused = true;
            s.login_err.clear();
        }
    }).build(k).key("ship-add"));
    if let Some(name) = front {
        acts = acts.child(Button::new(format!("Sign out of {name}")).variant(ButtonVariant::Ghost).on_press(|s: &mut App| sign_out_asked(s, false)).build(k).key("ship-out"));
    }
    if s.ships.len() > 1 {
        acts = acts.child(Button::new("Sign out of every ship").variant(ButtonVariant::Ghost).on_press(|s: &mut App| sign_out_asked(s, true)).build(k).key("ship-out-all"));
    }
    Dialog::new("ships", "Ships")
        .open(true)
        .width(440.0)
        .fit()
        .on_close(|s: &mut App| s.ships_open = false)
        .child(col().w_full().gap(14.0).child(list).child(acts))
        .build(k, layer);
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
                Prompt::Kind(t) | Prompt::New(t) | Prompt::Rename(_, t) | Prompt::Link(t) | Prompt::Ask(_, t) | Prompt::Duplicate(_, t) | Prompt::Token(t) | Prompt::Param(_, _, t) | Prompt::Tag(t) | Prompt::ForumTags(t) | Prompt::MarkMove(_, t) | Prompt::LinkIn(_, t) | Prompt::NewFolder(t) => t,
                Prompt::Delete(_) | Prompt::ForumDelete(_) | Prompt::ForumRowDelete(..) | Prompt::CommentRemove(..) | Prompt::BoardDelete(_) | Prompt::KeyRevoke(..) | Prompt::MarkDrop(..) | Prompt::Forget(_) | Prompt::Publish(..) | Prompt::Restore(_) | Prompt::Feature(..) | Prompt::ShipOut(_) => unreachable!("it has no field of this kind"),
                #[cfg(unix)]
                Prompt::IdOut(..) | Prompt::IdIn(..) | Prompt::IdUse(..) => unreachable!("it has fields of its own"),
            })
            .on_submit(|s: &mut App, _| confirm(s))
            .build(k)
            .w_full()
            .key("prompt-field")
    };
    let (title, body, verb, variant) = match p {
        #[cfg(unix)]
        Prompt::IdOut(path, t) => {
            let line = |i: usize, label: &str, key: &str| TextInput::new(&t[i]).label(label).placeholder(label).secure().on_edit(move |s: &mut App| id_field(s, i)).on_submit(|s: &mut App, _| confirm(s)).build(k).w_full().key(key.to_owned());
            let body = col()
                .w_full()
                .gap(10.0)
                .child(text(format!("The file {} will hold the key to this identity, locked with a passphrase of {} characters or more. Without the passphrase the file cannot be opened, and lattice cannot bring it back.", path.display(), cometid::MIN_PASSPHRASE)).key("id-out-said").font(k.ty.ui).color(k.c.text_muted).wrap())
                .child(line(0, "Passphrase", "prompt-field"))
                .child(line(1, "Passphrase again", "id-pass-again"));
            ("Export your anonymous identity", body, "Export", ButtonVariant::Contrast)
        }
        #[cfg(unix)]
        Prompt::IdIn(path, t) => {
            let body = col()
                .w_full()
                .gap(10.0)
                .child(text(format!("{}", path.display())).key("id-in-said").font(k.ty.ui).color(k.c.text_muted).wrap())
                .child(TextInput::new(t).label("The file's passphrase").placeholder("The file's passphrase").secure().on_edit(|s: &mut App| id_field(s, 0)).on_submit(|s: &mut App, _| confirm(s)).build(k).w_full().key("prompt-field"));
            ("Use an existing anonymous identity", body, "Open", ButtonVariant::Contrast)
        }
        #[cfg(unix)]
        Prompt::IdUse(id, old) => {
            let mut body = col().key("id-use-ask").w_full().gap(10.0);
            for para in id_question(old.as_deref(), &id.ship) {
                body = body.child(text(para).font(k.ty.ui).color(k.c.text_muted).wrap());
            }
            ("Use this anonymous identity?", body, "Use it", ButtonVariant::Danger)
        }
        Prompt::New(t) => ("New page", field(t, "folder/name"), "Create", ButtonVariant::Contrast),
        Prompt::NewFolder(t) => ("New folder", field(t, "A folder's name, as notes or notes/sub"), "Create", ButtonVariant::Contrast),
        Prompt::Rename(_, t) => ("Rename or move", field(t, "folder/name"), "Rename", ButtonVariant::Contrast),
        Prompt::Link(t) => ("Link the selection to", field(t, "https://"), "Link", ButtonVariant::Contrast),
        Prompt::Ask(_, t) => ("Ask for edit access", field(t, "A short note, if you like"), "Ask", ButtonVariant::Contrast),
        Prompt::Duplicate(_, t) => ("Duplicate this page as", field(t, "folder/name"), "Duplicate", ButtonVariant::Contrast),
        // kept on the ship, which never shows it again. Typed in the clear here: it is pasted, not remembered
        Prompt::Publish(_, quiet) => (
            "Make this public?",
            col()
                .w_full()
                .gap(10.0)
                .child(text("Once published, deletion is not assured. Anyone who has read this page can keep a copy, and the network may go on serving it after you unpublish or delete it.").font(k.ty.ui).color(k.c.text_muted).wrap())
                .child(Switch::new(*quiet).label("Do not ask again").on_toggle(|s: &mut App| {
                    if let Some(Prompt::Publish(_, quiet)) = &mut s.prompt {
                        *quiet = !*quiet;
                    }
                }).build(k).key("publish-quiet")),
            "Publish",
            ButtonVariant::Danger,
        ),
        Prompt::Restore(a) => ("Restore this vault?", text(vault::question(a)).key("restore-ask").font(k.ty.ui).color(k.c.text_muted).wrap(), "Restore", ButtonVariant::Danger),
        Prompt::KeyRevoke(_, title) => ("Revoke this key?", text(format!("{title} stops working at once, and cannot be brought back.")).font(k.ty.ui).color(k.c.text_muted).wrap(), "Revoke", ButtonVariant::Danger),
        Prompt::BoardDelete(name) => ("Delete this board?", text(format!("{name} and every thread on it are gone for everyone who reads it.")).font(k.ty.ui).color(k.c.text_muted).wrap(), "Delete", ButtonVariant::Danger),
        Prompt::ForumTags(t) => ("This thread's tags", field(t, "Up to five: lowercase letters, digits and dashes. None clears them"), "Set", ButtonVariant::Contrast),
        Prompt::ForumDelete(comment) => (if comment.is_some() { "Delete this comment?" } else { "Delete this thread?" }, text(if comment.is_some() { "It is gone for everyone who reads the board." } else { "The thread and its comments are gone for everyone who reads the board." }).font(k.ty.ui).color(k.c.text_muted).wrap(), "Delete", ButtonVariant::Danger),
        Prompt::ForumRowDelete(..) => ("Delete this thread?", text("The thread and its comments are gone for everyone who reads the board.").font(k.ty.ui).color(k.c.text_muted).wrap(), "Delete", ButtonVariant::Danger),
        Prompt::CommentRemove(page, _) => ("Remove this comment?", text(format!("It is gone from {page} for everyone who reads it, and cannot be brought back.")).key("comment-remove-ask").font(k.ty.ui).color(k.c.text_muted).wrap(), "Remove", ButtonVariant::Danger),
        Prompt::Tag(t) => ("Tag this memory", field(t, "a tag"), "Tag", ButtonVariant::Contrast),
        Prompt::ShipOut(all) => {
            let held = ship_mounts(s, *all);
            let folders = held.iter().map(|m| m.mountpoint.clone()).collect::<Vec<_>>().join(", ");
            let said = format!("{} mounted with {} session: {folders}. Signing out unmounts {}. The pages stay on the ship.", if held.len() == 1 { "A folder is" } else { "Folders are" }, if *all { "these ships'" } else { "this ship's" }, if held.len() == 1 { "it" } else { "them" });
            (if *all { "Sign out of every ship?" } else { "Sign out of this ship?" }, text(said).key("ship-out-ask").font(k.ty.ui).color(k.c.text_muted).wrap(), "Unmount and sign out", ButtonVariant::Danger)
        }
        Prompt::Kind(t) => ("This page's kind", field(t, "md, gmi, html, text, js, css, tex, geojson or scad"), "Change", ButtonVariant::Contrast),
        Prompt::MarkMove(_, t) => ("Move this bookmark to a folder", field(t, "A folder, or nothing for none"), "Move", ButtonVariant::Contrast),
        Prompt::LinkIn(_, t) => ("Move into my pages as", field(t, "a name, as notes/plan"), "Move", ButtonVariant::Contrast),
        Prompt::Forget(sh) => ("Remove from shared with me?", text(format!("{} from {}. Nothing is deleted: it is {}'s, and their grant to you stays. It comes back here if they share it again.", swm::name(&sh.path), sh.host, sh.host)).key("swm-forget-ask").font(k.ty.ui).color(k.c.text_muted).wrap(), "Remove", ButtonVariant::Danger),
        Prompt::MarkDrop(_, shown) => ("Remove this bookmark?", text(shown.clone()).key("mark-drop-ask").font(k.ty.ui).color(k.c.text_muted).wrap(), "Remove", ButtonVariant::Danger),
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
    if !leave_edit(s) {
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
    // another ship's page is revision 0 each time it is read: its text may be new all the same
    stale_views(s, &p.name);
    // the star says whether this page is kept, so the bookmarks are read if they were not yet
    if let Some(c) = s.conn.clone().filter(|_| s.marks.is_none()) {
        s.marks_req.request(c, |c| c.bookmarks());
    }
    s.access = false;
    s.settings = None;
    s.shared_open = false;
    s.inbox = false;
    s.forum = None;
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

/// Asks where in the tree the shared page in front goes, seeded with its own name.
fn ask_link_in(s: &mut App) {
    let Some(sh) = s.remote.clone().filter(|_| usable(s, "link-in")) else { return };
    ask_link_for(s, sh);
}

/// Asks where in the tree a page shared with this ship goes.
fn ask_link_for(s: &mut App, sh: Shared) {
    if !leave_edit(s) {
        return;
    }
    let mut t = TextEdit::new(swm::leaf(&sh.path).as_str());
    t.focused = true;
    s.prompt = Some(Prompt::LinkIn(sh, t));
}

/// Moves a page shared with this ship into its tree as a link at `to`. It
/// has one home at a time: the entry leaves shared with me, and the
/// host's grant is not touched.
fn link_in(s: &mut App, sh: Shared, to: String) {
    if !api::valid_name(&to) {
        s.note = format!("{to} is not a name a page can have: small letters, digits, . _ ~ and -, with / between folders");
        return;
    }
    if s.names.contains(&to) {
        s.note = format!("there is a page named {to} already");
        return;
    }
    let Some(c) = s.conn.clone() else {
        s.note = "sample pages have no ship to keep a link".into();
        return;
    };
    s.note = format!("moving {} into {to}", swm::name(&sh.path));
    s.op_req.request((c, sh, to), |(c, sh, to)| c.link_make(&sh, &to).map(|()| Op::Linked(to, sh.host)));
}

/// Moves the link in front back to shared with me.
fn link_back(s: &mut App) {
    let Some(name) = s.open.as_ref().filter(|_| usable(s, "link-back")).map(|p| p.name.clone()) else { return };
    let Some(c) = s.conn.clone() else { return };
    s.note = format!("moving {name} back to shared with me");
    s.op_req.request((c, name), |(c, name)| c.link_unmake(&name).map(|()| Op::Unlinked(name)));
}

/// Enters the app with no ship: the browser, reading through the urb engine as a comet of this computer's.
#[cfg(unix)]
fn browse_anon(s: &mut App) {
    (s.sample, s.anon) = (true, true);
    // what was starred and what was read with no ship are kept on this computer
    s.marks = Some(anon_marks_load());
    s.visits = anon_visits_load();
    if s.engine.is_none() {
        let base = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")));
        s.engine = base.map(|b| engine::Engine::new(b.join("lattice-rune").join("urb")));
    }
    #[cfg(unix)]
    id_refresh(s);
    go_browser(s);
    s.note = "Reading anonymously. You can browse published pages. Saving and hosting need a node.".into();
}

/// Reads an address with no ship, through the urb engine. A forum's boards are not read this way yet.
#[cfg(unix)]
fn urb_go_anon(s: &mut App, to: Option<String>) {
    let Some(url) = to.or_else(|| api::urb_address(&s.urb.text)) else {
        s.note = "an address is urb://~ship/path".into();
        return;
    };
    if api::urb_is_forum(&url) {
        s.note = "A forum needs a node to read for now.".into();
        return;
    }
    let Some(e) = s.engine.clone() else {
        s.note = "the reader has nowhere to keep its files: no home folder".into();
        return;
    };
    s.note = format!("reading {url}\u{2026}");
    s.anon_seq += 1;
    s.anon_reading = Some(url.clone());
    let (seq, got, waker) = (s.anon_seq, s.anon_got.clone(), s.waker.clone());
    spawn(move || {
        let read = || {
            let (ship, path) = engine::place(&url).ok_or_else(|| "an address is urb://~ship/path".to_owned())?;
            let p = e.read(&url, engine::BUDGET).map_err(|e| e.words())?;
            Ok((url.clone(), api::Urb::Page { ship, path, kind: engine::kind_of(&p.mark).to_owned(), body: p.body, comments: Vec::new() }))
        };
        let r = read();
        got.lock().unwrap_or_else(|e| e.into_inner()).push((seq, r));
        if let Some(w) = waker {
            w();
        }
    });
}

/// What a step of moving the anonymous identity came to: the file an export was written to, an
/// identity read out of a file, or the name now in use and the folder the old one was moved to.
#[cfg(unix)]
enum IdDone {
    Out(Result<String, String>),
    Opened(Result<cometid::Identity, String>),
    In(Result<(String, Option<std::path::PathBuf>), String>),
}

/// A comet's name at a length a button and a file name can hold: its last two parts.
fn id_short(ship: &str) -> String {
    let s = ship.trim_start_matches('~');
    let tail: Vec<&str> = s.rsplit('-').filter(|w| !w.is_empty()).take(2).collect();
    if s.len() > 14 && tail.len() == 2 { format!("~{}-{}", tail[1], tail[0]) } else { format!("~{s}") }
}

/// Whether an export's passphrase will do: long enough, and typed the same twice.
fn id_pass_ok(pass: &str, again: &str, least: usize) -> Result<(), String> {
    if pass.chars().count() < least {
        return Err(format!("Pick a passphrase of at least {least} characters."));
    }
    if pass != again {
        return Err("The two passphrases are not the same.".into());
    }
    Ok(())
}

/// What is asked before an identity from a file is used, naming both: a paragraph each.
fn id_question(old: Option<&str>, new: &str) -> [String; 2] {
    let now = match old {
        Some(o) => format!("Replace this computer's anonymous identity {o} with {new}? {o} is set aside on this computer, not deleted, but lattice stops using it."),
        None => format!("Use {new} as this computer's anonymous identity?"),
    };
    [now, format!("Stop using {new} on the computer it came from. Two computers running one identity at once lose each other's messages. And import from a fresh export: an older file can make your next messages go missing.")]
}

/// Reads again which identity this computer has, and whether it was exported.
#[cfg(unix)]
fn id_refresh(s: &mut App) {
    s.id_known = s.engine.as_ref().map_or((None, false), |e| (e.identity(), e.exported()));
}

/// The field being typed in of the identity prompt that is open.
#[cfg(unix)]
fn id_field(s: &mut App, i: usize) -> &mut TextEdit {
    match s.prompt.as_mut().expect("a prompt is open") {
        Prompt::IdOut(_, t) => &mut t[i],
        Prompt::IdIn(_, t) => t,
        _ => unreachable!("an identity prompt is open"),
    }
}

/// Runs one step of an identity's move on a thread of its own, and wakes the window with its answer.
#[cfg(unix)]
fn id_run(s: &mut App, said: &'static str, f: impl FnOnce() -> IdDone + Send + 'static) {
    s.id_busy = said;
    s.note = format!("{said}\u{2026}");
    let (got, waker) = (s.id_got.clone(), s.waker.clone());
    spawn(move || {
        let r = f();
        got.lock().unwrap_or_else(|e| e.into_inner()).push(r);
        if let Some(w) = waker {
            w();
        }
    });
}

/// Export: the file is named first, in the save dialog, and then the passphrase is asked for.
#[cfg(unix)]
fn id_export_ask(s: &mut App, tx: &mut Tx) {
    if !s.id_busy.is_empty() {
        return;
    }
    id_refresh(s);
    let Some(ship) = s.id_known.0.clone() else {
        s.note = "There is no anonymous identity on this computer yet. Read an address once to make one.".into();
        return;
    };
    let options = rune::FileDialogOptions { title: "Export your anonymous identity".into(), file_name: Some(format!("lattice-identity-{}.{}", id_short(&ship).trim_start_matches('~'), cometid::EXTENSION)), ..Default::default() };
    tx.save_file(options.filter("lattice identity", &[cometid::EXTENSION]), |s: &mut App, result: rune::FileDialogResult, _: &mut Tx| match result {
        Ok(Some(path)) => {
            let mut t = [TextEdit::new(""), TextEdit::new("")];
            t[0].focused = true;
            s.prompt = Some(Prompt::IdOut(path, Box::new(t)));
        }
        Ok(None) => {}
        Err(e) => s.note = format!("no file dialog could open: {e}"),
    });
}

/// Import: the file is picked first, and then its passphrase is asked for.
#[cfg(unix)]
fn id_import_ask(s: &mut App, tx: &mut Tx) {
    if !s.id_busy.is_empty() {
        return;
    }
    let options = rune::FileDialogOptions { title: "Use an existing anonymous identity".into(), ..Default::default() };
    tx.open_file(options.filter("lattice identity", &[cometid::EXTENSION]), |s: &mut App, result: rune::FileDialogResult, _: &mut Tx| match result {
        Ok(Some(path)) => {
            let mut t = TextEdit::new("");
            t.focused = true;
            s.prompt = Some(Prompt::IdIn(path, t));
        }
        Ok(None) => {}
        Err(e) => s.note = format!("no file dialog could open: {e}"),
    });
}

/// An identity prompt said yes to. Any other prompt is handed back.
#[cfg(unix)]
fn id_confirm(s: &mut App, p: Prompt) -> Option<Prompt> {
    let Some(e) = s.engine.clone() else { return Some(p) };
    match p {
        Prompt::IdOut(path, t) => {
            if let Err(why) = id_pass_ok(&t[0].text, &t[1].text, cometid::MIN_PASSPHRASE) {
                s.note = why;
                s.prompt = Some(Prompt::IdOut(path, t));
                return None;
            }
            let pass = t[0].text.clone();
            id_run(s, "Exporting the identity", move || {
                IdDone::Out((|| {
                    let id = e.export_identity()?;
                    let file = cometid::seal(&id, &pass)?;
                    cometid::write_private(&path, &file).map_err(|e| format!("could not write {e}"))?;
                    cometid::mark_exported(e.dir())?;
                    Ok(path.display().to_string())
                })())
            });
            None
        }
        Prompt::IdIn(path, t) => {
            let pass = t.text.clone();
            id_run(s, "Opening the identity file", move || {
                IdDone::Opened((|| {
                    let size = std::fs::metadata(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?.len();
                    if size > cometid::MAX_FILE {
                        return Err(cometid::OpenError::NotIdentity.to_string());
                    }
                    let bytes = std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
                    cometid::open(&bytes, &pass).map_err(|e| e.to_string())
                })())
            });
            None
        }
        Prompt::IdUse(id, _) => {
            id_run(s, "Changing the identity", move || IdDone::In(e.import_identity(&id).map(|aside| (id.ship.clone(), aside))));
            None
        }
        p => Some(p),
    }
}

/// Takes what the identity's threads answered. True when something changed.
#[cfg(unix)]
fn id_drained(s: &mut App) -> bool {
    let got: Vec<_> = std::mem::take(&mut *s.id_got.lock().unwrap_or_else(|e| e.into_inner()));
    let any = !got.is_empty();
    for r in got {
        s.id_busy = "";
        match r {
            IdDone::Out(Ok(path)) => s.note = format!("The identity is exported to {path}. Keep the file and its passphrase: one is no use without the other."),
            IdDone::Opened(Ok(id)) => {
                id_refresh(s);
                let old = s.id_known.0.clone();
                if old.as_deref() == Some(id.ship.as_str()) {
                    s.note = format!("This computer already uses {}. Nothing changed.", id.ship);
                } else {
                    s.note.clear();
                    s.prompt = Some(Prompt::IdUse(Box::new(id), old));
                }
            }
            IdDone::In(Ok((ship, aside))) => {
                // what was being read was asked for as the old identity
                urb_cancel(s);
                s.note = match aside {
                    Some(a) => format!("This computer now reads as {ship}. The identity used before is kept in {}.", a.display()),
                    None => format!("This computer now reads as {ship}."),
                };
            }
            IdDone::Out(Err(e)) | IdDone::Opened(Err(e)) | IdDone::In(Err(e)) => s.note = e,
        }
    }
    if any {
        id_refresh(s);
    }
    any
}

/// The anonymous identity on the browser's start: its name, whether it has been exported, and the
/// two ways it moves between computers.
#[cfg(unix)]
fn id_section(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let ship = s.engine.as_ref().and_then(engine::Engine::our).or_else(|| s.id_known.0.clone());
    let busy = !s.id_busy.is_empty();
    let said = match (&ship, s.id_known.1) {
        _ if busy => format!("{}\u{2026}", s.id_busy),
        (None, _) => "None yet. One is made the first time you read an address, and other ships see it as the reader.".to_owned(),
        (Some(_), true) => "An export of it has been made. Export again after using it, so the file is fresh.".to_owned(),
        (Some(_), false) => "It lives on this computer only. Export it to keep it, or to use it on another computer.".to_owned(),
    };
    col()
        .key("anon-id")
        .w_full()
        .gap(6.0)
        .child(text("Anonymous identity").font(k.ty.body_medium).color(c.text_base))
        .children(ship.as_ref().map(|n| text(n.clone()).key("anon-id-name").font(k.ty.ui_medium).color(c.text_base).truncate()))
        .child(text(said).key("anon-id-said").font(k.ty.small).color(c.text_muted).wrap())
        .child(
            row()
                .gap(8.0)
                .child(Button::new("Export").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Save this identity to a file locked with a passphrase").disabled(busy || ship.is_none()).on_press_tx(id_export_ask).build(k).key("id-export"))
                .child(Button::new("Use an existing identity").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Open an identity file exported from another computer").disabled(busy).on_press_tx(id_import_ask).build(k).key("id-import")),
        )
}

/// Lets go of a read on its way: what it answers is not wanted any more.
fn urb_cancel(s: &mut App) {
    s.urb_req.cancel();
    s.anon_seq += 1;
    s.anon_reading = None;
}

/// How many addresses read with no ship are remembered.
const ANON_VISITS: usize = 200;

/// The visits with one more read noted: the address comes to the front with the moment and one more
/// to its count, as the ship's own history keeps a visit, and the oldest go past the limit.
fn visit_noted(list: &[api::Visit], url: &str, title: &str, when: &str) -> Vec<api::Visit> {
    let before = list.iter().find(|v| v.url == url);
    let mut out = vec![api::Visit { url: url.to_owned(), title: if title.is_empty() { before.map(|v| v.title.clone()).unwrap_or_default() } else { title.to_owned() }, last: when.to_owned(), hits: before.map_or(0, |v| v.hits) + 1 }];
    out.extend(list.iter().filter(|v| v.url != url).take(ANON_VISITS - 1).cloned());
    out
}

/// What a page read at an address is called in the list of visits: its first heading, or nothing.
fn visit_title(kind: &str, body: &str) -> String {
    if !matches!(kind, "md" | "gmi") {
        return String::new();
    }
    body.lines().take(40).find_map(|l| l.strip_prefix('#')).map(|h| h.trim_start_matches('#').trim().chars().take(80).collect()).unwrap_or_default()
}

fn anon_visits_path() -> Option<std::path::PathBuf> {
    Some(anon_marks_path()?.with_file_name("anon-history.json"))
}

/// The addresses read with no ship, kept on this computer and sent nowhere.
fn anon_visits_load() -> Vec<api::Visit> {
    anon_visits_path().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn anon_visits_store(list: &[api::Visit]) {
    // a test's visits are not this computer's
    if cfg!(test) {
        return;
    }
    let Some(p) = anon_visits_path() else { return };
    let _ = p.parent().map(std::fs::create_dir_all);
    // readable by its owner alone: it is where someone has been
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    if let (Ok(mut f), Ok(bytes)) = (open.open(&p), serde_json::to_vec(list)) {
        use std::io::Write;
        // one that was there already and looser is tightened
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        let _ = f.write_all(&bytes);
    }
}

fn anon_marks_path() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))?;
    Some(base.join("lattice-rune").join("anon-bookmarks.json"))
}

/// The bookmarks kept with no ship, on this computer.
fn anon_marks_load() -> Vec<api::Bookmark> {
    anon_marks_path().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn anon_marks_store(list: &[api::Bookmark]) -> Result<(), String> {
    let p = anon_marks_path().ok_or("no home folder")?;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::to_vec(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// With no ship there is nowhere to write a page: said, where a sample page would be kept for the session.
fn no_node(s: &mut App) -> bool {
    if s.anon {
        s.note = "Writing and hosting pages needs a node. Sign in to one to write.".into();
    }
    s.anon
}

/// Reads what stands at an address: the one typed, or one given (a folder's entry).
fn urb_go(s: &mut App, to: Option<String>) {
    #[cfg(unix)]
    if s.anon {
        return urb_go_anon(s, to);
    }
    let Some(c) = s.conn.clone() else {
        s.note = "sample pages have no other ships to read".into();
        return;
    };
    let Some(url) = to.or_else(|| api::urb_address(&s.urb.text)) else {
        s.note = "an address is urb://~ship/path".into();
        return;
    };
    // a board or a thread is the forum's to show
    if api::urb_is_forum(&url) {
        match api::board_key(&url, c.ship()) {
            Ok((board, post)) => {
                s.forum = Some(Forum::default());
                s.shared_open = false;
                s.note = format!("reading {board}\u{2026}");
                forum_open(s, board, post);
            }
            Err(why) => s.note = why,
        }
        return;
    }
    s.note = format!("reading {url}\u{2026}");
    s.urb_req.request((c, url), |(c, url)| c.urb_read(&url).map(|u| (url, u)));
}

/// What was read at an address is shown: a page as another ship's page, a folder as a list under the address.
fn urb_got(s: &mut App, url: String, got: api::Urb) {
    // an answer that comes late must not take the page from under an edit begun meanwhile
    if s.editing {
        s.note = format!("{url} was read, but an edit is open: go to it again when the edit is done");
        return;
    }
    s.note.clear();
    // the bar follows what is showing, however it was come to (a bookmark, a row of shared with me)
    s.nav.go(&url);
    s.urb = TextEdit::new(url.as_str());
    (s.sugg, s.sugg_at) = (Vec::new(), None);
    if let Some(c) = s.conn.clone().filter(|_| matches!(got, api::Urb::Page { .. } | api::Urb::Folder { .. })) {
        // noted among the visits, as the ship's own reader notes it
        let seen = url.clone();
        spawn(move || drop(c.visit(&seen)));
    }
    // with no ship the visits are this computer's own list
    if let (true, api::Urb::Page { kind, body, .. }) = (s.anon, &got) {
        let when = api::since_epoch().map_or(String::new(), |d| api::da_of_ms(d.as_millis() as i64));
        s.visits = visit_noted(&s.visits, &url, &visit_title(kind, body), &when);
        anon_visits_store(&s.visits);
    }
    match got {
        api::Urb::Page { ship, path, kind, body, comments } => {
            let name = format!("{ship}/{path}");
            if !comments.is_empty() {
                s.note = format!("{} comment{} on this page, in the Comments pane", comments.len(), if comments.len() == 1 { "" } else { "s" });
            }
            // the thread is kept for the pane, and what was sent to it from here stays said until the thread shows it
            let sent = s.thread.take().filter(|t| t.url == url).and_then(|t| t.sent);
            let mut thread = Thread { url: url.clone(), ship: ship.clone(), page: path.clone(), list: comments, all: false, sent };
            settle_sent(&mut thread, &s.conn.as_ref().map(|c| c.ship().to_owned()).unwrap_or_default());
            s.thread = Some(thread);
            let note = std::mem::take(&mut s.note);
            show_remote(s, Shared { host: ship, path, mode: "published".into(), when: String::new() }, Page { name, body, kind, rev: 0 });
            s.note = note;
        }
        api::Urb::Folder { path, entries } => {
            s.urb_folder = Some((path, entries));
            // a folder is the browser's own page
            if leave_edit(s) {
                (s.remote, s.open, s.forum, s.settings, s.access, s.inbox) = (None, None, None, None, false, false);
                s.shared_open = true;
            }
        }
        api::Urb::Forum => s.note = "that address is a forum's: open it from the Forum's boards".into(),
        api::Urb::Binary { kind, size } => s.note = format!("that address is a file, not a page: {kind}, {size} bytes"),
    }
}

/// The browser's page when no page of another ship is showing: the folder read at the address, or its
/// start, which lists what was saved and what was visited, as the ship's own reader does.
fn shared_view(s: &App, k: &Kit) -> El {
    let c = &k.c;
    let go = |label: String, to: String, key: String| Button::new(label).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press_tx(move |s: &mut App, tx| browse_to(s, Some(to.clone()), tx)).build(k).key(key);
    let mut page = col().w_full().max_w(760.0).padding(28.0).gap(16.0);
    if let Some((path, entries)) = &s.urb_folder {
        let mut rows = col().key("urb-folder").w_full().gap(2.0).child(text(format!("{path} \u{b7} {} in it", entries.len())).font(k.ty.small).color(c.text_muted));
        for (i, (name, url, folder)) in entries.iter().enumerate() {
            rows = rows.child(row().child(go(if *folder { format!("{name}/") } else { name.clone() }, url.clone(), format!("urb-entry-{i}"))));
        }
        if entries.is_empty() {
            rows = rows.child(text("Nothing is in it.").font(k.ty.small).color(c.text_faint));
        }
        page = page.child(rows);
    } else {
        let head = |t: &str| text(t.to_owned()).font(k.ty.body_medium).color(c.text_base);
        let line = |title: &str, url: &str| col().gap(1.0).grow(1.0).min_w(0.0).child(text(if title.is_empty() { url.to_owned() } else { title.to_owned() }).font(k.ty.ui_medium).color(c.text_base).truncate()).child(text(url.to_owned()).font(k.ty.small).color(c.text_muted).truncate());
        let mut saved = col().key("browser-saved").w_full().gap(4.0).child(head("Bookmarks"));
        match s.marks.as_deref() {
            Some([]) | None => saved = saved.child(text(if s.marks.is_some() { "Nothing is saved yet. The star in the bar above keeps the page showing." } else { "Reading the bookmarks" }).font(k.ty.small).color(c.text_faint).wrap()),
            Some(list) => {
                for (i, m) in list.iter().take(12).enumerate() {
                    let to = m.url.clone();
                    saved = saved.child(row().key(format!("saved-{i}")).role("button").label(marks::label(m)).w_full().px(8.0).py(4.0).radius(k.radius.sm).hover(c.hover).on_press_tx(move |s: &mut App, tx| browse_to(s, Some(to.clone()), tx)).child(line(&m.title, &m.url)));
                }
                if list.len() > 12 {
                    saved = saved.child(text(format!("and {} more, in the left pane's Bookmarks", list.len() - 12)).font(k.ty.small).color(c.text_faint));
                }
            }
        }
        let mut seen = col().key("browser-visited").w_full().gap(4.0).child(
            row().w_full().center_y().justify_between().child(head("Visited")).children((!s.visits.is_empty()).then(|| {
                Button::new("Clear").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Forget every address visited").on_press(|s: &mut App| forget_visit(s, None)).build(k).key("visited-clear")
            })),
        );
        if s.visits.is_empty() {
            seen = seen.child(text(if s.conn.is_some() { "No address has been visited yet." } else if s.anon { "No address has been read yet. What you read is listed here, on this computer only." } else { "Sample pages have no other ships to visit." }).font(k.ty.small).color(c.text_faint));
        }
        for (i, v) in s.visits.iter().take(30).enumerate() {
            let (to, gone) = (v.url.clone(), v.url.clone());
            seen = seen.child(
                row().key(format!("visited-{i}")).w_full().gap(6.0).center_y()
                    .child(row().role("button").label(if v.title.is_empty() { v.url.clone() } else { v.title.clone() }).grow(1.0).min_w(0.0).px(8.0).py(4.0).radius(k.radius.sm).hover(c.hover).on_press_tx(move |s: &mut App, tx| browse_to(s, Some(to.clone()), tx)).child(line(&v.title, &v.url)))
                    .child(IconButton::new(&head::X).control_size(ControlSize::Small).variant(IconButtonVariant::GhostMuted).label(format!("Forget the visit to {}", v.url)).help("Forget this visit").on_press(move |s: &mut App| forget_visit(s, Some(gone.clone()))).build(k).key(format!("visited-forget-{i}"))),
            );
        }
        page = page
            .child(text(if s.anon { "Type an address above, as urb://~sampel-palnet/notes, to read what a ship publishes." } else { "Type an address above, as urb://~sampel-palnet/notes, to read what another ship publishes or shares with you. Anything else is looked for among your own pages." }).font(k.ty.small).color(c.text_muted).wrap())
            .child(saved)
            .child(seen);
        #[cfg(unix)]
        if s.anon {
            page = page.child(id_section(s, k));
        }
    }
    col().key("shared").w_full().h_full().min_h(0.0).child(col().w_full().items_center().child(page)).scroll(ScrollSpec { stick_bottom: false })
}

/// Forgets one address visited, or all of them.
fn forget_visit(s: &mut App, url: Option<String>) {
    match &url {
        Some(u) => s.visits.retain(|v| v.url != *u),
        None => s.visits.clear(),
    }
    if s.anon {
        anon_visits_store(&s.visits);
    }
    if let Some(c) = s.conn.clone() {
        s.visits_req.request((c, url), |(c, url)| {
            c.history_forget(url.as_deref())?;
            c.visits()
        });
    }
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
    if s.inspector.is_open() && s.pane == rpane::Tab::Comments && !s.memory && s.remote.is_none() {
        s.comments_req.request(c.clone(), |c| c.comments());
        s.comments_on_req.request((c.clone(), p.name.clone()), |(c, n)| c.comments_on(&n).map(|on| (n, on)));
        s.comets_req.request((c, p.name.clone()), |(c, n)| c.comets(&n).map(|m| (n, m)));
    }
}

/// Another ship's page's public thread, read at its address.
fn thread_of(c: &Conn, url: &str) -> Result<Vec<Comment>, String> {
    match c.urb_read(url)? {
        api::Urb::Page { comments, .. } => Ok(comments),
        _ => Err("that address is no longer a page".into()),
    }
}

/// Sends the comment typed in the pane to the page of another ship in front, as this ship.
fn post_remote_comment(s: &mut App) {
    let (Some(c), Some(t)) = (s.conn.clone(), thread_here(s).cloned()) else { return };
    let body = s.comment.text.trim().to_owned();
    if body.is_empty() || s.comment_sending {
        return;
    }
    // the text stays in the field until the ship has answered
    s.comment_sending = true;
    s.note = format!("sending to {}\u{2026}", t.ship);
    s.comment_req.request((c, t, body), |(c, t, body)| {
        let told = c.comment_remote(&t.ship, &t.page, &body)?;
        Ok(Op::SentRemote(t.url, body, told))
    });
}

/// Posts the comment typed in the pane on the open page.
fn post_comment(s: &mut App) {
    let (Some(c), Some(p)) = (s.conn.clone(), &s.open) else {
        s.note = "sample pages take no comments".into();
        return;
    };
    let body = s.comment.text.trim().to_owned();
    if body.is_empty() || s.comment_sending {
        return;
    }
    // the text stays in the field until the ship has it: a post that fails loses nothing
    s.comment_sending = true;
    s.comment_req.request((c, p.name.clone(), body), |(c, page, body)| {
        c.comment(&page, &body)?;
        // the ship writes it in a step of its own behind the answer
        api::pause(std::time::Duration::from_millis(1500));
        Ok(Op::Posted(format!("comment posted on {page}"), page, body))
    });
}

/// One comment: who, when, what, and Remove. In the inbox it also names
/// its page, which opens when pressed.
fn comment_card(m: &Comment, k: &Kit, link: bool, held: bool, busy: bool) -> El {
    let c = &k.c;
    let (page, id, to) = (m.page.clone(), m.id.clone(), m.page.clone());
    let when = Rev { rev: 0, updated: m.when.clone() }.when();
    // a comet's name is long: it is cut to the room there is, and said whole on hover. What can be done
    // with the comment is on a row of its own, where a long name used to push it out of the pane
    let top = row().w_full().gap(6.0).center_y().child(text(m.author.clone()).help(m.author.clone()).font(k.ty.small_medium).color(c.text_base).truncate().grow(1.0).min_w(0.0)).child(text(when).font(k.ty.small).color(c.text_faint));
    let mut acts = row().w_full().gap(6.0).justify_end();
    if held {
        // a held comment is answered, not removed
        for approve in [true, false] {
            let (page, id) = (page.clone(), id.clone());
            let word = if approve { "approve" } else { "reject" };
            acts = acts.child(Button::new(if approve { "Approve" } else { "Reject" }).control_size(ControlSize::Small).variant(if approve { ButtonVariant::Contrast } else { ButtonVariant::GhostMuted }).disabled(busy).on_press(move |s: &mut App| {
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
    let mut card = col().key(format!("{}-{}", if held { "held" } else { "comment" }, m.id)).w_full().padding(8.0).gap(4.0).radius(k.radius.sm).fill(c.layer_01).child(top).child(if held { acts } else {
        acts
            // asked first, as the web client asks: a comment removed cannot be brought back
            .child(Button::new("Remove").control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).disabled(busy).on_press(move |s: &mut App| {
                if s.conn.is_some() {
                    s.prompt = Some(Prompt::CommentRemove(page.clone(), id.clone()));
                }
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
            s.forum = None;
            load_groups(s);
        }
        Opens::Thread(board, post) => {
            if s.conn.is_none() {
                s.note = "sample pages have no forum to open".into();
                return;
            }
            if !leave_edit(s) {
                return;
            }
            (s.inbox, s.access, s.shared_open, s.settings) = (false, false, false, None);
            s.forum = Some(Forum::default());
            s.note = format!("reading {board}\u{2026}");
            forum_open(s, board, post);
        }
        Opens::Address(url) => {
            if s.conn.is_none() {
                s.note = "sample pages have no other ships to read".into();
                return;
            }
            urb_go(s, Some(url));
        }
        Opens::Nothing => return,
    }
    if !n.read {
        match s.conn.clone() {
            // marked behind what was opened, and said by the mark going: its answer has nothing to add, and on the
            // request the other actions share it took the place of whatever the opening had to say
            Some(c) => {
                let id = n.id.clone();
                spawn(move || drop(c.notice_read(Some(&id))));
                for x in s.notices.iter_mut().filter(|x| x.id == n.id) {
                    x.read = true;
                }
                s.waiting.unread = s.waiting.unread.saturating_sub(1);
            }
            None => mark_read(s, Some(n.id.clone())),
        }
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
    // one answer at a time: a second press while the first is out would be a second request
    let busy = s.op_req.is_pending();
    let mut list = col().key("inbox-list").w_full().gap(8.0);
    for m in &s.comments {
        list = list.child(comment_card(m, k, true, false, busy));
    }
    if s.comments.is_empty() {
        list = list.child(text(if s.comments_req.is_pending() { "Reading the comments" } else { "No comments. They are off until switched on for a page, in its Comments pane." }).font(k.ty.small).color(c.text_muted).wrap());
    }
    // what waits for an answer comes first, and only when something does
    let mut waiting = col().key("held-list").w_full().gap(8.0);
    if !s.held.is_empty() {
        waiting = waiting.child(text(format!("Held for your yes: {}", s.held.len())).font(k.ty.ui_medium).color(c.text_base));
        for m in &s.held {
            waiting = waiting.child(comment_card(m, k, true, true, busy));
        }
    }
    let head = col()
        .gap(4.0)
        .child(text("Inbox").font(k.ty.body_medium).color(c.text_base))
        .child(text("What waits for your yes, what happened, and the comments on your pages, newest first.").font(k.ty.small).color(c.text_muted).wrap());
    // how many of how many, as the web client says it: the ship sends the newest 200
    let shown = s.comments.len() as u64;
    let count = if s.comments_total > shown { format!("Comments: the newest {shown} of {}", s.comments_total) } else { "Comments".to_owned() };
    let list = col().w_full().gap(8.0).child(text(count).key("inbox-count").font(k.ty.ui_medium).color(c.text_base)).child(list);
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
    if let Some(t) = thread_here(s) {
        return thread_view(t, s, k);
    }
    let busy = s.op_req.is_pending();
    // one switch at a time: the one out is the one whose refusal is put back
    let switching = s.switch_req.is_pending();
    let on = s.comments_on.get(&p.name).copied();
    let name = p.name.clone();
    let toggle = row()
        .key("comments-switch")
        .w_full()
        .gap(8.0)
        .center_y()
        // not to be pressed until the ship has said which way it stands: flipped blind it could go the wrong way
        .child(Switch::new(on.unwrap_or(false)).label("Comments on").disabled(on.is_none() || switching).on_toggle(move |s: &mut App| {
            let Some(c) = s.conn.clone() else { return };
            let Some(now) = s.comments_on.get(&name).copied() else { return };
            s.comments_on.insert(name.clone(), !now);
            s.comment_undo = Some(CommentUndo::On(name.clone(), now));
            s.switch_req.request((c, name.clone()), move |(c, n)| {
                c.set_comments(&n, !now)?;
                Ok(format!("comments are {} for {n}", if now { "off" } else { "on" }))
            });
        }).build(k).key("comments-toggle"));
    // comets cost nothing to make, so each page says what their comments do
    let mut comets = row().key("comets").w_full().gap(4.0).center_y();
    if on == Some(true) {
        let now = s.comets.get(&p.name).cloned().unwrap_or_default();
        comets = comets.child(text("Comets").font(k.ty.small).color(c.text_muted));
        for (mode, label) in [("open", "Open"), ("held", "Held"), ("off", "Off")] {
            let name = p.name.clone();
            comets = comets.child(Button::new(label).control_size(ControlSize::Small).variant(if now == mode { ButtonVariant::Contrast } else { ButtonVariant::Ghost }).disabled(switching).on_press(move |s: &mut App| {
                let Some(c) = s.conn.clone() else { return };
                let was = s.comets.insert(name.clone(), mode.to_owned()).unwrap_or_else(|| "open".to_owned());
                s.comment_undo = Some(CommentUndo::Comets(name.clone(), was));
                s.switch_req.request((c, name.clone()), move |(c, n)| {
                    c.set_comets(&n, mode)?;
                    Ok(format!("comets' comments are {mode} for {n}"))
                });
            }).build(k).key(format!("comets-{mode}")));
        }
    }
    let mine: Vec<&Comment> = s.comments.iter().filter(|m| m.page == p.name).collect();
    let mut list = col().key("comment-list").w_full().gap(8.0);
    for m in &mine {
        list = list.child(comment_card(m, k, false, false, busy));
    }
    if mine.is_empty() {
        list = list.child(text(if s.comments_req.is_pending() { "Reading the comments" } else { "No comments on this page." }).font(k.ty.small).color(c.text_muted));
    }
    // this page's comets' comments that wait for a yes, as the web client has them beside the page
    let held = s.page_held.get(&p.name).filter(|h| !h.is_empty());
    if let Some(held) = held {
        let mut waiting = col().key("page-held").w_full().gap(8.0).child(text(format!("Held for your yes: {}", held.len())).font(k.ty.small_medium).color(c.text_base));
        for m in held {
            waiting = waiting.child(comment_card(m, k, false, true, busy));
        }
        list = col().w_full().gap(8.0).child(waiting).child(list);
    }
    let mut write = col().key("comment-write").w_full().gap(6.0);
    match on {
        // the ship has not said yet: a comment posted on a page with comments off would be dropped and called posted
        None => write = write.child(text(if s.comments_on_req.is_pending() { "Reading whether comments are on" } else { "Whether comments are on is not known." }).font(k.ty.small).color(c.text_muted).wrap()),
        Some(false) => write = write.child(text("Comments are off for this page.").font(k.ty.small).color(c.text_muted).wrap()),
        Some(true) => {
            write = write
                .child(TextArea::new(&s.comment).label("Your comment").placeholder("Say something").rows(3).on_edit(|s: &mut App| &mut s.comment).build(k).w_full().key("comment-field"))
                .child(row().child(Button::new(if s.comment_sending { "Posting\u{2026}" } else { "Post" }).control_size(ControlSize::Small).variant(ButtonVariant::Contrast).disabled(s.comment_sending).on_press(post_comment).build(k).key("comment-post")));
        }
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

/// The Comments pane for a page of another ship read by address: its
/// public thread, oldest first as its own reader shows it, and a field to
/// send a comment as this ship. The host decides whether a comment lands.
fn thread_view(t: &Thread, s: &App, k: &Kit) -> El {
    let c = &k.c;
    let hidden = if t.all { 0 } else { t.list.len().saturating_sub(THREAD_SHOWN) };
    let mut list = col().key("thread-list").w_full().gap(8.0);
    if hidden > 0 {
        list = list.child(row().child(Button::new(format!("Show {hidden} older")).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| {
            if let Some(t) = &mut s.thread {
                t.all = true;
            }
        }).build(k).key("thread-older")));
    }
    for (i, m) in t.list.iter().enumerate().skip(hidden) {
        let when = Rev { rev: 0, updated: m.when.clone() }.when();
        list = list.child(
            col().key(format!("thread-{i}")).w_full().padding(8.0).gap(4.0).radius(k.radius.sm).fill(c.layer_01)
                .child(row().w_full().gap(6.0).center_y().child(text(m.author.clone()).font(k.ty.small_medium).color(c.text_base)).child(text(when).font(k.ty.small).color(c.text_faint)))
                .child(text(m.body.clone()).font(k.ty.ui).color(c.text_base).wrap().selectable(true)),
        );
    }
    if t.list.is_empty() && t.sent.is_none() {
        list = list.child(text("No comments on this page yet.").font(k.ty.small).color(c.text_muted));
    }
    // what was sent from here and is not in the thread yet, said as the ship's reader says it
    if let Some((body, told, _)) = &t.sent {
        let said = if *told { format!("Sent. It shows here once {} has it, or after its owner's yes if comments from you are held.", t.ship) } else { format!("{} did not say it took this within five seconds. It may still arrive.", t.ship) };
        list = list.child(
            col().key("thread-sent").w_full().padding(8.0).gap(4.0).radius(k.radius.sm).border(1.0, c.border_weak)
                .child(text(said).font(k.ty.small).color(c.text_muted).wrap())
                .child(text(body.clone()).font(k.ty.ui).color(c.text_muted).wrap()),
        );
    }
    let url = t.url.clone();
    let again = Button::new("Refresh").help("Read the thread again").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).disabled(s.thread_req.is_pending()).on_press(move |s: &mut App| {
        if let Some(c) = s.conn.clone() {
            s.thread_req.request((c, url.clone()), |(c, url)| thread_of(&c, &url).map(|l| (url, l)));
        }
    }).build(k).key("thread-again");
    let write = col().key("comment-write").w_full().gap(6.0)
        .child(TextArea::new(&s.comment).label(format!("Your comment to {}", t.ship)).placeholder("Say something").rows(3).on_edit(|s: &mut App| &mut s.comment).build(k).w_full().key("comment-field"))
        .child(text(format!("Sent as your ship. {} decides whether it shows: comments may be off there, or held.", t.ship)).font(k.ty.small).color(c.text_faint).wrap())
        .child(row().child(Button::new(if s.comment_sending { "Sending\u{2026}".to_owned() } else { format!("Send to {}", t.ship) }).control_size(ControlSize::Small).variant(ButtonVariant::Contrast).disabled(s.comment_sending).on_press(post_remote_comment).build(k).key("comment-send")));
    col()
        .key("comments")
        .w_full()
        .h_full()
        .min_h(0.0)
        .padding(12.0)
        .gap(10.0)
        .child(row().w_full().gap(8.0).center_y().child(text(format!("Comments on {}'s page", t.ship)).font(k.ty.ui_medium).color(c.text_base).truncate().grow(1.0).min_w(0.0)).child(again))
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

/// Shares the open page in `mode`, asking first when that makes it public and the asking was not put aside.
fn share_as(s: &mut App, mode: &'static str) {
    let was = share_target(s).and_then(|(name, folder)| if folder { &s.dshares } else { &s.shares }.get(&name).cloned()).unwrap_or_default();
    if s.conn.is_some() && !s.prefs.pub_ok && api::goes_public(&was, mode) {
        // one dialog at a time: the share dialog steps aside for the question, and comes back with the answer
        s.sharing = false;
        s.prompt = Some(Prompt::Publish(mode, false));
        return;
    }
    share_now(s, mode);
}

/// Asks the ship to share the open page in `mode`.
fn share_now(s: &mut App, mode: &'static str) {
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
/// The share dialog, for a folder: a page's sharing is in the right pane.
fn share_view(s: &App, k: &Kit, layer: &mut Vec<El>) {
    if !s.sharing {
        return;
    }
    if let Some((name, body)) = share_body(s, k) {
        Dialog::new("share", format!("Share {name}")).open(true).width(460.0).fit().on_close(|s: &mut App| s.sharing = false).child(body).build(k, layer);
    }
}

/// Who reads the open page or the folder showing, and the ways to change it: its name, and the controls.
fn share_body(s: &App, k: &Kit) -> Option<(String, El)> {
    let (name, folder) = share_target(s)?;
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
    Some((p.name.clone(), body))
}

fn ask_new(s: &mut App) {
    if no_node(s) {
        return;
    }
    // a new page starts in the folder showing, or beside the open page
    let dir = match (&s.folder, &s.open) {
        (Some(f), None) => format!("{f}/"),
        (_, p) => p.as_ref().and_then(|p| p.name.rsplit_once('/')).map_or(String::new(), |(d, _)| format!("{d}/")),
    };
    let mut t = TextEdit::new(dir);
    t.focused = true;
    s.prompt = Some(Prompt::New(t));
}

/// What a tree row's menu offers: its command and its words. A folder has no one file to download.
fn tree_menu_items(dir: bool) -> Vec<(&'static str, &'static str)> {
    let mut out = vec![("rename", "Rename"), ("move", "Move")];
    if !dir {
        out.push(("download", "Download"));
    }
    out.push(("delete", "Delete"));
    out
}

/// The name a rename or a move starts from, with the part to change marked so typing replaces it:
/// the last part for a rename, and the folder before it for a move.
fn tree_menu_edit(path: &str, mv: bool) -> TextEdit {
    let mut t = TextEdit::new(path);
    t.focused = true;
    let at = path.rfind('/').map_or(0, |i| i + 1);
    if mv { t.set_selection(0, at) } else { t.set_selection(at, path.len()) }
    t
}

/// Runs one command of a tree row's menu on that row, whether or not it is the page in front.
fn tree_menu_run(s: &mut App, path: &str, id: &str, tx: &mut Tx) {
    s.tree_menu = None;
    match id {
        "rename" | "move" => {
            if !no_node(s) {
                s.prompt = Some(Prompt::Rename(path.to_owned(), tree_menu_edit(path, id == "move")));
            }
        }
        "delete" => {
            if !no_node(s) {
                s.prompt = Some(Prompt::Delete(path.to_owned()));
            }
        }
        "download" => tree_download(s, path, tx),
        _ => {}
    }
}

/// Saves a page from the tree to a file on this machine. The page in front goes as it stands, with
/// what is being typed. Any other is saved from what is kept of it, or read from the ship first.
fn tree_download(s: &mut App, path: &str, tx: &mut Tx) {
    if s.open.as_ref().is_some_and(|p| p.name == path) {
        return ask_download(s, tx);
    }
    let kind = s.cache.get(path).map(|p| p.kind.clone()).or_else(|| s.files.get(path).and_then(|n| n.data.as_ref()).map(|n| n.kind.clone())).unwrap_or_default();
    let (kept, conn, name) = (s.cache.get(path).map(|p| p.body.clone()), s.conn.clone().filter(|_| !s.memory), path.to_owned());
    if kept.is_none() && conn.is_none() {
        s.note = format!("{path} has no text here to download");
        return;
    }
    let options = rune::FileDialogOptions { title: "Download this page".into(), file_name: Some(upload::download_name(path, &kind, s.memory)), ..Default::default() };
    tx.save_file(options, move |s: &mut App, result: rune::FileDialogResult, _: &mut Tx| match result {
        Ok(Some(to)) => match (conn.clone(), kept.clone()) {
            // the ship's copy is the newest
            (Some(c), _) => {
                s.note = format!("reading {name}");
                s.op_req.request((c, name.clone(), to), |(c, name, to)| {
                    let p = c.page(&name)?;
                    Ok(Op::Said(match std::fs::write(&to, p.body) {
                        Ok(()) => format!("saved to {}", to.display()),
                        Err(e) => format!("not saved to {}: {e}", to.display()),
                    }))
                });
            }
            (None, Some(body)) => write_file(s, to, body),
            (None, None) => {}
        },
        Ok(None) => {}
        Err(e) => s.note = format!("no file dialog could open: {e}"),
    });
}

/// The left pane with the menu of the tree row that was right-clicked, shown where the pointer was.
fn tree_menu_view(s: &App, k: &Kit, side: El, layer: &mut Vec<El>) -> El {
    let dir = s.tree_menu.as_ref().is_some_and(|(p, _)| s.files.get(p).is_none_or(|n| n.dir));
    let mut menu = rune_kit::context_menu("tree-menu", side, s.tree_menu.as_ref().map(|m| m.1)).on_close(|s: &mut App| s.tree_menu = None);
    for (id, label) in tree_menu_items(dir) {
        menu = menu.item(MenuItem::new(label).danger(id == "delete").on_select_tx(move |s: &mut App, tx| {
            if let Some((path, _)) = s.tree_menu.clone() {
                tree_menu_run(s, &path, id, tx);
            }
        }));
    }
    menu.build(k, layer)
}

/// The kinds a page of text can be changed between by typing one. Sheets, documents and maps are
/// not among them: each is a file of its own shape.
const PAGE_KINDS: [&str; 9] = ["md", "gmi", "html", "text", "js", "css", "tex", "geojson", "scad"];

/// The kind typed, as the ship names it: its own name, or a word people use for it.
fn kind_typed(typed: &str) -> Option<&'static str> {
    let t = typed.trim().trim_start_matches('.').to_lowercase();
    let k = match t.as_str() {
        "markdown" => "md",
        "gemtext" | "gemini" => "gmi",
        "htm" => "html",
        "txt" | "plain" => "text",
        "javascript" => "js",
        "latex" => "tex",
        "openscad" => "scad",
        other => other,
    };
    PAGE_KINDS.iter().copied().find(|p| *p == k)
}

/// A kind in words.
fn kind_said(kind: &str) -> &str {
    match kind {
        "md" => "Markdown",
        "gmi" => "gemtext",
        "html" => "HTML",
        "text" => "plain text",
        "js" => "JavaScript",
        "css" => "CSS",
        "tex" => "LaTeX",
        "geojson" => "a map",
        "scad" => "OpenSCAD",
        "fods" => "a sheet",
        "fodt" => "a document",
        other => other,
    }
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

/// Searches what is held for what is typed in the Search tab: every
/// page's text and every memory's, whichever half is showing.
fn run_search(s: &mut App) {
    s.search_at = None;
    s.shits.clear();
    (s.sfound, s.sskipped) = (0, 0);
    let Some(q) = search::query(&s.squery.text) else { return };
    let (pages, names, knows) = if s.memory { (&s.other.2, &s.other.1, &s.cache) } else { (&s.cache, &s.names, &s.other.2) };
    let mut out = Vec::new();
    for name in names {
        match pages.get(name) {
            Some(p) => out.extend(search::hit(name, &search::text_of(&p.kind, &p.body), &q, search::scope(s.shares.get(name).map(String::as_str)), false)),
            // its text was not carried: said, so no result is not read as no match
            None => s.sskipped += 1,
        }
    }
    for (name, p) in knows {
        out.extend(search::hit(name, &p.body, &q, "knowledge", true));
    }
    search::sort(&mut out);
    s.sfound = out.len();
    out.truncate(search::MOST);
    s.shits = out;
}

/// Shows the Search tab with its field ready to type in.
fn open_search(s: &mut App) {
    s.sidebar.set_open(true);
    s.over = Some(Over::Search);
    s.squery.focused = true;
    // what is held may have changed since it was last shown
    run_search(s);
}

/// Sample bookmarks, for looking at the tab with no ship.
const SAMPLE_MARKS: &[(&str, &str, &str)] = &[("urb://~sampel-palnet/notes", "Sampel's notes", ""), ("https://urbit.org/overview", "Urbit overview", "reading"), ("urb://~sampel-palnet/forum/chat", "", "boards"), ("https://example.com/a-long-read", "A long read", "reading")];

/// Shows the Bookmarks tab and reads the bookmarks again: the reader
/// keeps and drops them elsewhere, and this is one small request.
fn open_marks(s: &mut App) {
    s.sidebar.set_open(true);
    s.over = Some(Over::Marks);
    match s.conn.clone() {
        Some(c) => s.marks_req.request(c, |c| c.bookmarks()),
        None if s.anon => s.marks = Some(anon_marks_load()),
        None => s.marks = Some(SAMPLE_MARKS.iter().map(|(url, title, folder)| api::Bookmark { url: (*url).into(), title: (*title).into(), folder: (*folder).into() }).collect()),
    }
}

/// Makes a change to the bookmarks on the ship and reads them back, or,
/// with no ship, makes it to the sample ones as the ship would.
fn mark_change(s: &mut App, change: marks::Change) {
    match s.conn.clone() {
        Some(c) => s.op_req.request((c, change), |(c, change)| {
            match &change {
                marks::Change::Keep(url, title, folder) => c.bookmark(url, title, folder)?,
                marks::Change::Move(url, folder) => c.bookmark_move(url, folder)?,
                marks::Change::Drop(url) => c.unbookmark(url)?,
            }
            Ok(Op::Marks(marks::said(&change), c.bookmarks()?))
        }),
        None => {
            let list = marks::after(s.marks.as_deref().unwrap_or_default(), &change);
            // with no ship they are this computer's, and kept
            let kept = if s.anon { anon_marks_store(&list) } else { Ok(()) };
            applied(s, Op::Marks(marks::said(&change), list));
            if let Err(e) = kept {
                s.note = format!("kept until the app closes, but not written to this computer: {e}");
            }
        }
    }
}

/// The address another ship's page is kept under as a bookmark.
fn mark_url(sh: &Shared) -> String {
    format!("urb://{}/{}", sh.host, sh.name())
}

/// The star on another ship's page: keeps it as a bookmark, or drops the one there is.
fn star(s: &mut App) {
    let Some(sh) = s.remote.clone() else { return };
    let url = mark_url(&sh);
    if s.marks.as_deref().is_some_and(|m| marks::has(m, &url)) {
        mark_change(s, marks::Change::Drop(url));
    } else {
        mark_change(s, marks::Change::Keep(url, format!("{}/{}", sh.host, sh.name()), String::new()));
    }
}

/// Opens a bookmark: an address on the network is read by the ship,
/// as one typed into Shared with me is, and a web address goes to the
/// system's browser.
fn open_mark(s: &mut App, at: usize, tx: &mut Tx) {
    let Some(url) = s.marks.as_ref().and_then(|m| m.get(at)).map(|b| b.url.clone()) else { return };
    match marks::opens(&url) {
        marks::Opens::Urb if !leave_edit(s) => {}
        marks::Opens::Urb => urb_go(s, Some(url)),
        marks::Opens::Web => {
            if let Err(e) = tx.open_url(&url) {
                s.note = format!("could not open {url}: {e:?}");
            }
        }
        marks::Opens::Nowhere => s.note = format!("{url} is not an address this can open"),
    }
}

/// The Bookmarks tab: a filter, then the bookmarks under their folders.
fn marks_view(s: &App, k: &Kit) -> El {
    let field = TextInput::new(&s.marks_q).placeholder("Filter bookmarks").leading_icon(k.glyph.search).clear_button().on_edit(|s: &mut App| &mut s.marks_q).build(k).w_full().key("marks-filter");
    let mut out = col().key("marks").w_full().grow(1.0).min_h(0.0).gap(8.0).child(field);
    let said = |t: &str| text(t.to_owned()).key("marks-note").font(k.ty.small).color(k.c.text_muted).wrap();
    let Some(list) = &s.marks else {
        return out.child(said(if s.marks_bad { "Bookmarks did not load" } else { "Loading bookmarks\u{2026}" }));
    };
    if s.marks_bad {
        out = out.child(said("Bookmarks did not load again. These are the ones read before."));
    }
    let shown = marks::rows(list, &s.marks_q.text, &s.prefs.marks_folded);
    if shown.is_empty() {
        return out.child(said(if s.marks_q.text.trim().is_empty() { "No bookmarks yet" } else { "No bookmark matches that" }));
    }
    let mut rows = col().key("marks-rows").w_full().gap(2.0);
    for r in shown {
        rows = rows.child(match r {
            marks::Row::Folder { name, folded } => {
                let f = name.clone();
                row()
                    .key(format!("mf:{name}"))
                    .role("button")
                    .label(format!("{name}, folder, {}", if folded { "folded" } else { "open" }))
                    .w_full()
                    .h(26.0)
                    .px(6.0)
                    .gap(6.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .on_press(move |s: &mut App| {
                        match s.prefs.marks_folded.iter().position(|x| *x == f) {
                            Some(i) => drop(s.prefs.marks_folded.remove(i)),
                            None => s.prefs.marks_folded.push(f.clone()),
                        }
                        save_prefs(s);
                    })
                    .child(rune::icon(if folded { k.glyph.caret_right } else { k.glyph.chevron_down }, 16.0).color(k.c.icon_muted).a11y_hidden())
                    .child(text(name).font(k.ty.small_medium).color(k.c.text_base).truncate().grow(1.0).min_w(0.0))
            }
            marks::Row::Mark { at, under } => {
                let b = &list[at];
                row()
                    .w_full()
                    .h(26.0)
                    .pl(if under { 28.0 } else { 6.0 })
                    .pr(6.0)
                    .center_y()
                    .radius(k.radius.sm)
                    .gap(2.0)
                    .child(
                        row()
                            .key(format!("m:{}", b.url))
                            .role("button")
                            .label(marks::label(b).to_owned())
                            .help(b.url.clone())
                            .h_full()
                            .center_y()
                            .grow(1.0)
                            .min_w(0.0)
                            .on_press_tx(move |s: &mut App, tx| open_mark(s, at, tx))
                            .child(text(marks::label(b).to_owned()).font(k.ty.small).color(k.c.text_base).truncate().grow(1.0).min_w(0.0)),
                    )
                    .child({
                        let (url, folder) = (b.url.clone(), b.folder.clone());
                        IconButton::new(&head::FOLDER).control_size(ControlSize::Small).variant(IconButtonVariant::GhostMuted).label(format!("Move {} to a folder", marks::label(b))).help("Move to folder").on_press(move |s: &mut App| {
                            let mut t = TextEdit::new(folder.clone());
                            t.focused = true;
                            s.prompt = Some(Prompt::MarkMove(url.clone(), t));
                        }).build(k).key(format!("mv:{}", b.url))
                    })
                    .child({
                        let (url, shown) = (b.url.clone(), marks::label(b).to_owned());
                        IconButton::new(&head::X).control_size(ControlSize::Small).variant(IconButtonVariant::GhostMuted).label(format!("Remove the bookmark {}", marks::label(b))).help("Remove bookmark").on_press(move |s: &mut App| s.prompt = Some(Prompt::MarkDrop(url.clone(), shown.clone()))).build(k).key(format!("rm:{}", b.url))
                    })
            }
        });
    }
    out.child(col().w_full().grow(1.0).min_h(0.0).child(rows).scroll(ScrollSpec { stick_bottom: false }))
}

/// Opens a result: a page among the pages, a memory among the memories.
/// The results stay where they are for the next one.
fn open_hit(s: &mut App, i: usize, tab: bool) {
    let Some(h) = s.shits.get(i).cloned() else { return };
    if !leave_edit(s) {
        return;
    }
    s.search_at = Some(i);
    if h.know != s.memory {
        flip(s);
    }
    if tab && !h.know {
        open_in_tab(s, &h.key);
    } else {
        open_page(s, &h.key);
    }
}

/// The Search tab: the field, how many were found, and the results.
fn search_view(s: &App, k: &Kit) -> El {
    let field = TextInput::new(&s.squery)
        .placeholder("Search your pages and notes")
        .leading_icon(k.glyph.search)
        .clear_button()
        .on_edit(|s: &mut App| &mut s.squery)
        .on_change(|s: &mut App, _| run_search(s))
        .on_key(|s: &mut App, ev: &KeyEvent, _: &mut Tx| {
            let n = s.shits.len();
            match ev.key {
                Key::Down if n > 0 => s.search_at = Some(s.search_at.map_or(0, |i| (i + 1) % n)),
                Key::Up if n > 0 => s.search_at = Some(s.search_at.map_or(n - 1, |i| (i + n - 1) % n)),
                Key::Enter => match s.search_at {
                    Some(i) => open_hit(s, i, ev.mods.ctrl || ev.mods.cmd),
                    None => run_search(s),
                },
                _ => return false,
            }
            true
        })
        .build(k)
        .w_full()
        .key("search-field");
    let mut out = col().key("search").role("search").label("Search").w_full().grow(1.0).min_h(0.0).gap(8.0).child(field);
    let said = if search::query(&s.squery.text).is_none() {
        "Type at least two letters".to_owned()
    } else if s.shits.is_empty() && s.sskipped == 0 {
        "Nothing matches that".to_owned()
    } else if s.sfound > s.shits.len() {
        format!("{}, the first {} shown", search::summary(s.sfound, s.sskipped), s.shits.len())
    } else {
        search::summary(s.sfound, s.sskipped)
    };
    out = out.child(text(said).key("search-sum").font(k.ty.small).color(k.c.text_muted).wrap());
    let mut rows = col().key("search-rows").w_full().gap(2.0);
    for (i, h) in s.shits.iter().enumerate() {
        let mut r = col()
            .key(format!("{}:{}", if h.know { "qk" } else { "q" }, h.key))
            .role("button")
            .label(format!("{}, {}", h.key, h.scope))
            .w_full()
            .px(8.0)
            .py(5.0)
            .gap(2.0)
            .radius(k.radius.sm)
            .on_press(move |s: &mut App| open_hit(s, i, false))
            .on_middle_press(move |s: &mut App, _| open_hit(s, i, true))
            .child(
                row()
                    .w_full()
                    .gap(6.0)
                    .center_y()
                    // who reads it: a private page and a public one must not look alike in a list
                    .child(text(h.scope).font(k.ty.text_xsmall_medium).color(if h.scope == "clearweb" { k.c.warning.icon } else if h.scope == "urbit" { k.c.text_accent } else { k.c.text_muted }).px(4.0).radius(k.radius.sm).fill(k.c.layer_02))
                    .child(text(h.key.clone()).font(k.ty.small_medium).color(k.c.text_base).truncate().grow(1.0).min_w(0.0)),
            );
        if !h.snip.is_empty() {
            r = r.child(text(h.snip.clone()).font(k.ty.small).color(k.c.text_muted).wrap());
        }
        if s.search_at == Some(i) {
            r = r.fill(k.selection());
        }
        rows = rows.child(r);
    }
    out.child(col().w_full().grow(1.0).min_h(0.0).child(rows).scroll(ScrollSpec { stick_bottom: false }))
}

/// What a press on one of the tools over the tree does.
fn head_go(s: &mut App, act: head::Do, tx: &mut Tx) {
    use head::Do;
    match act {
        Do::Open => {
            let mut q = TextEdit::new("");
            q.focused = true;
            (s.jump, s.jump_at) = (Some(q), 0);
        }
        Do::New => ask_new(s),
        Do::NewFolder => {
            // it starts in the folder showing, as the web client's does
            let mut t = TextEdit::new(s.folder.as_ref().filter(|_| s.open.is_none()).map_or(String::new(), |f| format!("{f}/")));
            t.focused = true;
            s.prompt = Some(Prompt::NewFolder(t));
        }
        Do::Template => ask_template(s),
        Do::Upload => ask_upload(s, false, tx),
        Do::UploadFolder => ask_upload(s, true, tx),
        Do::Capture => {
            capture(s);
            tx.focus_when_shown(FIELD, false);
        }
        Do::Sort => {
            s.prefs.sort_desc ^= true;
            save_prefs(s);
            // both halves, so the one not showing is in the same order when it is turned to
            let desc = s.prefs.sort_desc;
            for m in [&mut s.files, &mut s.other.0] {
                sort_files(m, desc);
            }
        }
        Do::Fold => s.files.collapse_all(),
    }
}

/// What a press on one of the ribbon's icons does.
fn ribbon_go(s: &mut App, go: ribbon::Go, tx: &mut Tx) {
    use ribbon::Go;
    match go {
        Go::Today => {
            open_today(s);
            if s.editing {
                tx.focus_when_shown(FIELD, false);
            }
        }
        Go::Browser => go_browser(s),
        Go::Forum => go_forum(s),
        Go::Inbox => go_inbox(s),
        Go::Access => go_access(s),
        Go::Commands => {
            let mut q = TextEdit::new("");
            q.focused = true;
            (s.palette, s.palette_at) = (Some(q), 0);
        }
        Go::Settings => go_settings(s),
    }
}

/// The ribbon: icons down the window's left edge, as the web client has
/// them, with settings at its foot. `top` clears what the window draws
/// over its leading corner (a Mac's traffic lights).
fn ribbon_view(s: &App, k: &Kit, top: f32) -> El {
    let items = ribbon::items(ribbon::Showing {
        shared: s.shared_open,
        forum: s.forum.is_some(),
        inbox: s.inbox,
        access: s.access,
        settings: s.settings.is_some(),
        waiting: s.waiting.held + s.waiting.unread,
    });
    let one = |it: &ribbon::Item| {
        let go = it.go;
        let mut b = IconButton::new(it.icon).control_size(ControlSize::Large).variant(if it.on { IconButtonVariant::Neutral } else { IconButtonVariant::GhostMuted }).help(it.name);
        if it.count > 0 {
            // the number painted on it is said with its name
            b = b.label(it.said());
        }
        if let Some(keys) = it.keys {
            b = b.shortcut(keys);
        }
        let b = b.on_press_tx(move |s: &mut App, tx| ribbon_go(s, go, tx)).build(k).key(it.key);
        let mut cell = el().size(28.0, 28.0).child(b);
        if let Some(n) = it.badge() {
            cell = cell.child(text(n).key(format!("{}-count", it.key)).font(k.ty.text_xsmall_medium).color(k.c.text_base).fill(k.c.layer_02).radius(6.0).px(3.0).absolute(15.0, -3.0).inert().a11y_hidden());
        }
        cell
    };
    let mut head = col().gap(4.0).items_center().child(
        IconButton::new(&topbar::PANE_LEFT)
            .control_size(ControlSize::Large)
            .variant(if s.sidebar.is_open() { IconButtonVariant::Neutral } else { IconButtonVariant::GhostMuted })
            .help("Left pane")
            .on_press(|s: &mut App| s.sidebar.toggle())
            .build(k)
            .key("pane-left"),
    );
    let mut foot = col().gap(4.0).items_center();
    for it in &items {
        if it.foot {
            foot = foot.child(one(it));
        } else {
            head = head.child(one(it));
        }
    }
    col().key("ribbon").role("navigation").label("Ribbon").w(40.0).h_full().min_h(0.0).pt(8.0 + top).pb(8.0).items_center().justify_between().child(head).child(foot)
}

fn sidebar(s: &App, k: &Kit) -> El {
    let (pages, knows) = if s.memory { (s.other.1.len(), s.names.len()) } else { (s.names.len(), s.other.1.len()) };
    // the pane's head as the web client has it: icon tabs, then a toolbar of icons over the tree
    let mut halves = row().key("halves").role("tablist").label("Left pane").w_full().gap(4.0);
    let front = match s.over {
        Some(Over::Search) => head::Half::Search,
        Some(Over::Marks) => head::Half::Marks,
        None if s.memory => head::Half::Knowledge,
        None => head::Half::Files,
    };
    for tab in head::tabs(front, pages, knows) {
        let (on, what, memory) = (tab.on, tab.what, s.memory);
        let mut b = IconButton::new(tab.icon).control_size(ControlSize::Large).variant(if on { IconButtonVariant::Neutral } else { IconButtonVariant::GhostMuted }).label(tab.said).help(tab.name);
        if let Some(keys) = tab.keys {
            b = b.shortcut(keys);
        }
        halves = halves.child(b.on_press(move |s: &mut App| match what {
            head::Half::Search => open_search(s),
            head::Half::Marks => open_marks(s),
            // the half that is showing does nothing when pressed, but for leaving the search or the bookmarks
            _ => {
                s.over = None;
                if (what == head::Half::Knowledge) != memory {
                    flip(s);
                }
            }
        }).build(k).key(tab.key));
    }
    let who = s.conn.as_ref().map_or(if s.anon { "anonymous" } else { "sample pages" }.to_owned(), |c| c.ship().to_owned());
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
    let foot = row()
        .w_full()
        .center_y()
        .justify_between()
        .child(if s.conn.is_some() && !cfg!(target_arch = "wasm32") {
            // the ship in front, and the way to the others signed in
            let more = s.ships.len().saturating_sub(1);
            row().role("button").label(if more > 0 { format!("{who}, and {more} more signed in. Ships") } else { format!("{who}. Ships") }).help("Ships signed in: go to another, add one, or sign out").grow(1.0).min_w(0.0).px(4.0).py(2.0).radius(k.radius.sm).hover(k.c.hover).on_press(|s: &mut App| {
                s.ships = api::ships();
                s.ships_open = true;
            }).gap(6.0).center_y().child(text(who).key("ship").font(k.ty.small_medium).color(k.c.text_muted).truncate()).children({
                // what is unread on the ships not in front, so it is seen without going to them
                let unread: usize = s.seen.lock().map(|m| s.ships.iter().filter(|x| !x.front).filter_map(|x| m.get(&x.url)).map(|x| x.unread).sum()).unwrap_or(0);
                (unread > 0).then(|| text(format!("+{unread}")).key("ship-unread").label(format!("{unread} unread on your other ships")).font(k.ty.small_medium).color(k.c.text_accent))
            }).key("ship-switch")
        } else {
            row().grow(1.0).min_w(0.0).child(text(who).key("ship").font(k.ty.small_medium).color(k.c.text_muted).truncate())
        })
        .child(theme)
        .child(Button::new(if s.conn.is_some() { "Sign out" } else if s.anon { "Leave" } else { "Close" }).variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| sign_out_asked(s, false)).build(k).key("sign-out"));
    // rune-kit keeps a band over the sidebar for its own toggle, level with the top bar. The toggle is the
    // ribbon's here, so the pane's tabs go up into the band, beside the top bar, and nothing is left blank
    let side = col().key("pages").w_full().grow(1.0).min_h(0.0).mt(-rune_kit::shell::TOOLBAR_HEIGHT).padding(8.0).gap(8.0).child(halves);
    let raised = |side: El| col().w_full().h_full().min_h(0.0).child(side);
    // the search and the bookmarks show over the tree, so the tree is not built for them
    match s.over {
        Some(Over::Search) => return raised(side.child(search_view(s, k)).child(foot)),
        Some(Over::Marks) => return raised(side.child(marks_view(s, k)).child(foot)),
        None => {}
    }
    let q = s.query.text.trim().to_lowercase();
    let tree = Tree::new(|s: &App| &s.files, |s: &mut App| &mut s.files, |n: &FileNode<Node>| n.name.as_str())
        .name(if s.memory { "Memories" } else { "Pages" })
        .row({
            let (shared, links) = (s.shared.clone(), s.links.keys().cloned().collect::<std::collections::HashSet<String>>());
            let (muted, hover) = (k.c.text_muted, k.c.hover);
            move |n, r| {
                let item = TreeItem::file(n, r).highlight(q.clone());
                // the tree has no right-click of its own for a row, so a row of this ship's carries a clear
                // sheet over itself that takes one. It has no press, so a click still reaches the row
                let item = if swm::is_ours(&n.path) {
                    item
                } else {
                    let (at, mid, page) = (n.path.clone(), n.path.clone(), !n.dir);
                    let sheet = el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).on_secondary_press(move |s: &mut App, p, _| {
                        s.files.select(&at);
                        s.tree_menu = Some((at.clone(), p));
                    });
                    // a middle click on a page opens it in a new tab, as a browser opens a link
                    item.trailing(if page { sheet.on_middle_press(move |s: &mut App, _| tab_for(s, &mid)) } else { sheet })
                };
                if links.contains(&n.path) {
                    // a page that is another ship's, moved here as a link
                    return item.icon(&tabhead::OUT);
                }
                let Some((sh, None)) = swm::at(&shared, &n.path) else { return item };
                // what the host lets this ship do with it, then into my pages (a page only), and off the list
                let small = |glyph: &'static str, name: &str, key: String| text(glyph).key(key).role("button").label(name.to_owned()).help(name.to_owned()).color(muted).px(4.0).radius(4.0).hover(hover);
                let (a, b) = (sh.clone(), sh.clone());
                let item = item.badge(sh.mode.clone());
                let item = if swm::is_dir(&sh.path) { item } else { item.trailing(small("\u{2197}", "Move into my pages", format!("swm-move:{}", n.path)).on_press(move |s: &mut App| ask_link_for(s, a.clone()))) };
                item.trailing(small("\u{d7}", "Remove from this list. Their grant is untouched", format!("swm-forget:{}", n.path)).on_press(move |s: &mut App| s.prompt = Some(Prompt::Forget(b.clone()))))
            }
        })
        // one click opens a page, as the web client's tree does
        .on_select(|s: &mut App, id, tx| {
            // with Ctrl (Cmd on a Mac) a page opens in a new tab
            if tx.mods().cmd && !swm::is_ours(id) && s.files.get(id).is_some_and(|n| !n.dir) {
                return tab_for(s, id);
            }
            if swm::is_ours(id) {
                // a page or a folder another ship shared. The folder itself and a ship's only fold
                open_shared(s, id);
            } else if s.files.get(id).is_some_and(|n| !n.dir) {
                open_page(s, id);
            } else if leave_edit(s) {
                // a folder shows what it holds, and can be renamed, moved or deleted there
                s.access = false;
    s.settings = None;
                s.shared_open = false;
                s.inbox = false;
                s.forum = None;
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
        .w_full()
        .key("filter");
    let mut new = row().key("tree-tools").role("toolbar").label(if s.memory { "Knowledge" } else { "Files" }).w_full().gap(2.0).center_y();
    let mut gap = false;
    for tool in head::tools(s.memory, s.prefs.sort_desc) {
        if tool.end && !gap {
            new = new.child(el().grow(1.0));
            gap = true;
        }
        let act = tool.act;
        let mut b = IconButton::new(tool.icon).variant(IconButtonVariant::GhostMuted).help(tool.name);
        if let Some(keys) = tool.keys {
            b = b.shortcut(keys);
        }
        new = new.child(b.on_press_tx(move |s: &mut App, tx| head_go(s, act, tx)).build(k).key(tool.key));
    }
    let heading = text(if s.memory { "KNOWLEDGE" } else { "FILES" }).key("tree-sec").font(k.ty.text_xsmall_medium).color(k.c.text_muted).pl(4.0);
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
    // core rules agent keys wrote: every session loads core as rules, so each waits here to be kept or untagged
    let core = (s.memory && core_notice(s)).then(|| {
        let mut list = col().key("core-notice").w_full().gap(4.0).padding(8.0).radius(k.radius.md).fill(k.c.layer_01).child(
            row().w_full().gap(6.0).child(text("These core rules were added by agent keys. Every session loads core as rules: keep each one, or untag it.").font(k.ty.small).color(k.c.text_muted).wrap().grow(1.0).min_w(0.0)).child(
                Button::new("Dismiss")
                    .control_size(ControlSize::Small)
                    .variant(ButtonVariant::GhostMuted)
                    .help("Hide this until another one shows up")
                    .on_press(|s: &mut App| {
                        s.prefs.core_seen = s.core_agents.clone();
                        save_prefs(s);
                    })
                    .build(k)
                    .key("core-dismiss"),
            ),
        );
        for key in s.core_agents.iter().take(50) {
            let (open, keep, untag) = (key.clone(), key.clone(), key.clone());
            list = list.child(
                row()
                    .w_full()
                    .gap(4.0)
                    .center_y()
                    .child(Button::new(key.clone()).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Read this rule").on_press(move |s: &mut App| {
                        if s.names.contains(&open) {
                            s.files.select(&open);
                            open_page(s, &open);
                        }
                    }).build(k).key(format!("core-open-{key}")).grow(1.0).min_w(0.0))
                    .child(Button::new("Keep").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Vouch for it: it is your own rule from now on").on_press(move |s: &mut App| core_rule(s, keep.clone(), true)).build(k).key(format!("core-keep-{key}")))
                    .child(Button::new("Untag").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Take the core tag off: it is a memory, and no rule").on_press(move |s: &mut App| core_rule(s, untag.clone(), false)).build(k).key(format!("core-untag-{key}"))),
            );
        }
        list
    });
    // what is said, the offline state and what waits are the status bar's, along the bottom of the window
    raised(side.children(core).child(filter).child(new).children((!tags.is_empty()).then_some(chips)).child(heading).child(tree).children(trash).children(s.memory.then_some(row().child(trash_toggle))).child(foot))
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
        None => list = list.child(text(if s.conn.is_some() { "Reading the history" } else if s.anon { "A page read anonymously shows no history." } else { "Sample pages keep no history" }).font(k.ty.small).color(c.text_muted)),
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
        // an HTML page drawn as a web page names sheets and fonts as well as pictures
        #[cfg(not(target_arch = "wasm32"))]
        let web = web_page(s).is_some();
        #[cfg(target_arch = "wasm32")]
        let web = false;
        Some(banner(
            "outside",
            format!("{} from another site {} not loaded. Loading {} tells that site your address.", match (n, web) { (1, false) => "An image".to_owned(), (1, true) => "A file".to_owned(), (_, false) => format!("{n} images"), (_, true) => format!("{n} files") }, if n == 1 { "is" } else { "are" }, if n == 1 { "it" } else { "them" }),
            "Load outside content for this page",
            |s| {
                if let Some(name) = s.open.as_ref().map(|p| p.name.clone()) {
                    s.prefs.allow_outside(&name);
                    save_prefs(s);
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

/// A switch in the Comments pane as it was before it was flipped.
#[derive(Clone, Debug, PartialEq)]
enum CommentUndo {
    On(String, bool),
    Comets(String, String),
}

/// Another ship's page's public thread, and what this ship last sent to it.
#[derive(Clone, Debug, Default, PartialEq)]
struct Thread {
    /// The address it was read at, its host, and the page's name there.
    url: String,
    ship: String,
    page: String,
    list: Vec<Comment>,
    /// The older ones are shown too: fifty are until asked.
    all: bool,
    /// A comment sent from here that the thread does not show yet, whether the host took it, and how many like it the thread had.
    sent: Option<(String, bool, usize)>,
}

/// What is said when the ship did not do what was asked.
fn not_done(s: &mut App, e: &str) {
    if api::gone(e) {
        s.offline.get_or_insert_with(String::new);
        s.note = "not done: that needs the ship, and it does not answer".into();
    } else {
        s.note = format!("not done: {e}");
    }
}

/// A comment's post came back. One that did not go keeps its text.
fn commented(s: &mut App, r: Result<Op, String>) {
    s.comment_sending = false;
    match r {
        Ok(op) => applied(s, op),
        Err(e) => not_done(s, &e),
    }
}

/// A switch of the Comments pane came back. One the ship did not take goes back to where it was.
fn switched(s: &mut App, r: Result<String, String>) {
    let undo = s.comment_undo.take();
    match r {
        Ok(say) => {
            s.note = say;
            load_comments(s);
        }
        Err(e) => {
            match undo {
                Some(CommentUndo::On(n, was)) => drop(s.comments_on.insert(n, was)),
                Some(CommentUndo::Comets(n, was)) => drop(s.comets.insert(n, was)),
                None => {}
            }
            not_done(s, &e);
        }
    }
}

/// What the comment field's text is for: the thread of another ship's page in front, or this ship's page.
fn comment_key(s: &App) -> String {
    match (thread_here(s), &s.open) {
        (Some(t), _) => t.url.clone(),
        (None, Some(p)) if !s.memory && s.remote.is_none() => p.name.clone(),
        _ => String::new(),
    }
}

/// Keeps the comment field's text with what it was typed for: text begun on one page is put by when
/// another comes in front, and is there again on the way back. It was one text for every page, and
/// words typed on a private page stood ready to be sent to another ship's.
fn sync_draft(s: &mut App) -> bool {
    let key = comment_key(s);
    if key == s.comment_for {
        return false;
    }
    let old = std::mem::replace(&mut s.comment_for, key.clone());
    let typed = std::mem::take(&mut s.comment.text);
    if !old.is_empty() && !typed.trim().is_empty() {
        s.drafts.insert(old, typed);
    }
    s.comment = TextEdit::new(s.drafts.remove(&key).unwrap_or_default().as_str());
    true
}

/// A comment that went: its text is let go where it still stands as it was sent. What was typed
/// since is another comment, and stays.
fn sent_draft(s: &mut App, key: &str, body: &str) {
    if s.comment_for == key {
        if s.comment.text.trim() == body {
            s.comment = TextEdit::new("");
        }
    } else if s.drafts.get(key).is_some_and(|d| d.trim() == body) {
        s.drafts.remove(key);
    }
}

/// How many of a thread's comments are this ship's with this text. A host cuts a long one short.
fn like_ours(list: &[Comment], ours: &str, body: &str) -> usize {
    let body = body.trim();
    list.iter().filter(|m| m.author == ours && (m.body.trim() == body || (m.body.len() >= 4000 && body.starts_with(m.body.trim())))).count()
}

/// What was sent from here is no longer waiting to show once the thread has one more like it.
fn settle_sent(t: &mut Thread, ours: &str) {
    if t.sent.as_ref().is_some_and(|(body, _, had)| like_ours(&t.list, ours, body) > *had) {
        t.sent = None;
    }
}

/// How many of a thread's comments show until the rest are asked for, as in the ship's own reader.
const THREAD_SHOWN: usize = 50;

/// The thread that belongs to the page of another ship in front, when it was read by address.
fn thread_here(s: &App) -> Option<&Thread> {
    // with no ship there is no thread read and nobody to send as
    let sh = s.remote.as_ref().filter(|_| !s.anon)?;
    s.thread.as_ref().filter(|t| t.ship == sh.host && t.page == sh.path)
}

/// How far along an update is.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, PartialEq)]
enum UpdStage {
    Idle,
    Fetching,
    /// The new version is in the old one's place and starts next time.
    Installed(String),
    Failed(String),
}

/// The app's own updates (`update.rs`).
#[cfg(not(target_arch = "wasm32"))]
struct Updater {
    /// Whether this copy asks at all: a release build does, a build for working on does not.
    on: bool,
    flavor: update::Flavor,
    endpoint: String,
    key: String,
    /// A test's files may be fetched from anywhere.
    anywhere: bool,
    /// When it next asks (app clock), and whether a wake is set for then.
    next: f64,
    armed: bool,
    check_req: Latest<Result<Option<update::Offer>, String>>,
    get_req: Latest<Result<(), String>>,
    offer: Option<update::Offer>,
    /// Versions put off for this run. A newer one is offered again.
    later: Vec<String>,
    /// The version put in this copy's place in this run: not offered again, whatever its banner was answered.
    installed: Option<String>,
    /// When the download's count is next looked at (app clock): one wake at a time.
    tick: f64,
    stage: UpdStage,
    /// Hundredths of the file fetched so far.
    pct: std::sync::Arc<std::sync::atomic::AtomicU8>,
}

#[cfg(not(target_arch = "wasm32"))]
impl Updater {
    fn new() -> Updater {
        // a build for working on asks only when a test names where, and may then be given the test's own key.
        // A release build reads neither: what it trusts is built into it
        let test = if cfg!(debug_assertions) { std::env::var("LATTICE_RUNE_UPDATE_URL").ok().filter(|u| !u.is_empty()) } else { None };
        let flavor = update::flavor(std::env::var("APPIMAGE").ok().as_deref(), std::env::var("APPDIR").ok().as_deref(), std::env::current_exe().ok().as_deref(), test.is_some());
        // whoever would not have it ask says so
        let off = std::env::var_os("LATTICE_RUNE_NO_UPDATE").is_some_and(|v| !v.is_empty());
        let key = test.as_ref().and_then(|_| std::env::var("LATTICE_RUNE_UPDATE_KEY").ok()).unwrap_or_else(|| update::PUBKEY.to_owned());
        Updater {
            on: (!cfg!(debug_assertions) || test.is_some()) && !off,
            flavor,
            anywhere: test.is_some(),
            next: if test.is_some() { 1.0 } else { update::FIRST_CHECK },
            endpoint: test.unwrap_or_else(|| update::ENDPOINT.to_owned()),
            key,
            armed: false,
            check_req: Latest::default(),
            get_req: Latest::default(),
            offer: None,
            later: Vec::new(),
            installed: None,
            tick: 0.0,
            stage: UpdStage::Idle,
            pct: Default::default(),
        }
    }
}

/// Asks whether a newer release is out when it is time to, and takes the
/// answer and the fetched file as they come. Nothing here waits on the network.
#[cfg(not(target_arch = "wasm32"))]
fn sync_update(s: &mut App, clock: f64, tx: &mut Tx) -> bool {
    if !s.upd.on {
        return false;
    }
    let mut changed = false;
    if clock >= s.upd.next {
        s.upd.next = clock + update::PERIOD;
        s.upd.armed = false;
        let (endpoint, flavor, anywhere) = (s.upd.endpoint.clone(), s.upd.flavor.clone(), s.upd.anywhere);
        s.upd.check_req.request((endpoint, flavor), move |(e, f)| update::check(&e, &f, anywhere));
    }
    if !s.upd.armed {
        s.upd.armed = true;
        tx.wake_after(std::time::Duration::from_secs_f64((s.upd.next - clock).max(0.1)));
    }
    // offline, GitHub away, no release yet: asked again next time, and nothing said
    if let Some(Ok(Some(o))) = s.upd.check_req.take() {
        changed |= update_offered(&mut s.upd, o);
    }
    if let Some(got) = s.upd.get_req.take() {
        changed = true;
        update_fetched(&mut s.upd, got);
    }
    if s.upd.stage == UpdStage::Fetching && clock >= s.upd.tick {
        // the count moves as the file comes. One wake stands at a time: a wake set on every pass made a chain for each
        changed = true;
        s.upd.tick = clock + 0.25;
        tx.wake_after(std::time::Duration::from_millis(250));
    }
    changed
}

/// A newer release was found. It is offered when nothing else of the update is showing: not a version
/// put off or already put in place in this run, and not over a download, its failure, or what was installed.
#[cfg(not(target_arch = "wasm32"))]
fn update_offered(u: &mut Updater, o: update::Offer) -> bool {
    let known = u.later.contains(&o.version) || u.installed.as_deref() == Some(o.version.as_str());
    if known || u.stage != UpdStage::Idle || u.offer.as_ref() == Some(&o) {
        return false;
    }
    u.offer = Some(o);
    true
}

/// The download and the swap came back. A failure keeps the offer, to be tried again.
#[cfg(not(target_arch = "wasm32"))]
fn update_fetched(u: &mut Updater, got: Result<(), String>) {
    let version = u.offer.as_ref().map(|o| o.version.clone()).unwrap_or_default();
    u.stage = match got {
        Ok(()) => {
            (u.offer, u.installed) = (None, Some(version.clone()));
            UpdStage::Installed(version)
        }
        Err(e) => UpdStage::Failed(format!("Could not update to lattice-rune {version}: {e}. Nothing was changed.")),
    };
}

/// Fetches the offered file. It is checked against its signature before anything is written.
#[cfg(not(target_arch = "wasm32"))]
fn update_now(s: &mut App) {
    let Some((url, sig, named)) = s.upd.offer.as_ref().and_then(|o| o.file.clone()) else { return };
    let update::Flavor::AppImage(at) = s.upd.flavor.clone() else { return };
    let (key, pct) = (s.upd.key.clone(), s.upd.pct.clone());
    // how far is not known until the first of it comes
    pct.store(UNKNOWN, std::sync::atomic::Ordering::Relaxed);
    (s.upd.stage, s.upd.tick) = (UpdStage::Fetching, 0.0);
    // fetched, checked and written on the worker's thread: the window does not wait on the disk
    s.upd.get_req.request((url, sig, key, named, at), move |(url, sig, key, named, at)| {
        let bytes = update::fetch(&url, &sig, &key, named.as_deref(), &|p| pct.store(p, std::sync::atomic::Ordering::Relaxed))?;
        update::install(&at, &bytes)
    });
}

/// The download's count before anything of it has come.
#[cfg(not(target_arch = "wasm32"))]
const UNKNOWN: u8 = u8::MAX;

/// Puts the offer off for this run.
#[cfg(not(target_arch = "wasm32"))]
fn update_later(s: &mut App) {
    match s.upd.stage {
        // the new version still starts next time, and is not offered again. A failure put aside leaves its offer, to be tried again
        UpdStage::Installed(_) | UpdStage::Failed(_) => s.upd.stage = UpdStage::Idle,
        UpdStage::Idle => {
            if let Some(o) = s.upd.offer.take() {
                s.upd.later.push(o.version);
            }
        }
        UpdStage::Fetching => {}
    }
}

/// Starts the new version in this one's place, once what is being written has been sent.
#[cfg(not(target_arch = "wasm32"))]
fn update_restart(s: &mut App) {
    let update::Flavor::AppImage(at) = s.upd.flavor.clone() else { return };
    if !leave_edit(s) {
        return;
    }
    if s.save_req.is_pending() || s.drain_req.is_pending() {
        s.note = "Saving first. Press Restart again in a moment".into();
        return;
    }
    match update::restart_after_exit(&at) {
        Ok(()) => {
            // what a window closed by hand would do first
            closing(s);
            std::process::exit(0)
        }
        Err(e) => s.note = format!("could not restart: {e}. The new version starts the next time the app does"),
    }
}

/// What is done before the program goes, however it goes: the reader's engine closes its store, so
/// what libmesa holds is written.
fn closing(s: &mut App) {
    #[cfg(unix)]
    if let Some(e) = s.engine.take() {
        e.close();
    }
    let _ = s;
}

/// The update's own line across the top of the page area: the offer, how
/// far the file has come, that it is in, or what went wrong.
#[cfg(not(target_arch = "wasm32"))]
fn update_banner(s: &App, k: &Kit) -> Option<El> {
    let small = |label: &str| Button::new(label.to_owned()).control_size(ControlSize::Small);
    let later = |label: &str| small(label).variant(ButtonVariant::Ghost).on_press(update_later).build(k).key("update-later");
    let line = |say: String| row().key("update-banner").role("status").w_full().px(16.0).py(8.0).gap(12.0).center_y().fill(k.c.layer_01).child(text(say).key("update-said").font(k.ty.small).color(k.c.text_base).wrap().grow(1.0).min_w(0.0));
    match (&s.upd.stage, &s.upd.offer) {
        (UpdStage::Fetching, o) => {
            let pct = s.upd.pct.load(std::sync::atomic::Ordering::Relaxed);
            let v = o.as_ref().map(|o| o.version.as_str()).unwrap_or_default();
            Some(line(match pct {
                UNKNOWN => format!("Downloading lattice-rune {v}\u{2026}"),
                100.. => format!("Checking and installing lattice-rune {v}\u{2026}"),
                _ => format!("Downloading lattice-rune {v}\u{2026} {pct}%"),
            }))
        }
        (UpdStage::Installed(v), _) => Some(
            line(format!("lattice-rune {v} is installed and starts the next time the app does."))
                .child(small("Restart now").variant(ButtonVariant::Contrast).on_press(update_restart).build(k).key("update-restart"))
                .child(later("Later")),
        ),
        (UpdStage::Failed(e), _) => Some(line(e.clone()).child(small("Try again").variant(ButtonVariant::Contrast).on_press(update_now).build(k).key("update-again")).child(later("Dismiss"))),
        (UpdStage::Idle, Some(o)) => {
            let act = if o.file.is_some() {
                small("Update").variant(ButtonVariant::Contrast).on_press(update_now).build(k).key("update-now")
            } else {
                small("Open release page").variant(ButtonVariant::Contrast).on_press_tx(|s: &mut App, tx| {
                    if let Err(e) = tx.open_url(update::RELEASES_PAGE) {
                        s.note = format!("could not open {}: {e:?}", update::RELEASES_PAGE);
                    }
                    update_later(s);
                }).build(k).key("update-page")
            };
            Some(line(update::offer_text(o, update::VERSION)).child(act).child(later("Later")))
        }
        (UpdStage::Idle, None) => None,
    }
}

/// An HTML page drawn as a browser shows it.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Default)]
struct WebShow {
    html: Option<htmlview::Html>,
    /// The width there is for the page, in points.
    room: f32,
    /// Pixels to a point and whether the look is dark, as the view last saw them.
    env: std::cell::Cell<(f32, bool)>,
    /// What was last asked for.
    asked: Option<htmlview::Ask>,
    /// What is laid out: how, which turn of it, and its height in points.
    laid: Option<(htmlview::Ask, u64, f32)>,
    /// The bands of it had so far.
    bands: std::collections::BTreeMap<usize, rune::Image>,
    /// The bands of the turn before, shown until this turn's come: a page is not blank while it is laid out again.
    was: std::collections::BTreeMap<usize, rune::Image>,
    /// The pointer is over a link.
    hot: bool,
    /// How many things on the web the page named and was not let to fetch.
    held: usize,
    /// Bands for what is in view are still to come.
    painting: bool,
    /// Counted up when a page's text is new at the revision it had (`htmlview::Key::text`).
    text: u64,
    /// A page the engine failed on: it is read as a document.
    broken: Option<htmlview::Key>,
}

/// The HTML page to show as a web page, when one is in front to be read and that is how it is wanted.
#[cfg(not(target_arch = "wasm32"))]
fn web_page(s: &App) -> Option<&Page> {
    let screen = s.settings.is_some() || s.access || s.forum.is_some() || s.shared_open || s.inbox || s.folder.is_some();
    let broken = |p: &Page| s.web.broken.as_ref().is_some_and(|k| k.name == p.name && k.rev == p.rev && k.text == s.web.text);
    s.open.as_ref().filter(|p| p.kind == "html" && !s.prefs.html_plain && !s.editing && !s.memory && s.old.is_none() && !screen && !broken(p))
}

/// Keeps the drawn HTML page in step with what is in front: asks for it
/// at the room's width, and takes what its thread has sent.
#[cfg(not(target_arch = "wasm32"))]
fn sync_web(s: &mut App, tx: &mut Tx) -> bool {
    let mut changed = false;
    let (scale, dark) = s.web.env.get();
    let ask = web_page(s).filter(|_| s.web.room > 0.0).map(|p| htmlview::Ask { key: htmlview::Key { name: p.name.clone(), rev: p.rev, text: s.web.text }, width: htmlview::width_for(s.web.room), scale: scale.clamp(1.0, 3.0), dark, outside: s.prefs.outside.contains(&p.name) });
    if let (Some(ask), Some(html)) = (&ask, &s.web.html) {
        if s.web.asked.as_ref() != Some(ask) {
            // a page let to load outside content is read afresh: what it held back is fetched as it is parsed
            let new = s.web.asked.as_ref().is_none_or(|a| a.key != ask.key || a.outside != ask.outside);
            let body = new.then(|| s.open.as_ref().map(|p| p.body.clone())).flatten();
            if new {
                s.web.laid = None;
                s.web.bands.clear();
                s.web.was.clear();
                (s.web.hot, s.web.held) = (false, 0);
            }
            html.show(ask.clone(), body);
            s.web.asked = Some(ask.clone());
        }
    }
    // no HTML page is in front: the pictures of the last one are let go, not held under every other page
    if web_page(s).is_none() && s.web.asked.is_some() {
        (s.web.asked, s.web.laid, s.web.painting) = (None, None, false);
        s.web.bands.clear();
        s.web.was.clear();
    }
    let outs = s.web.html.as_ref().map(htmlview::Html::take).unwrap_or_default();
    let mut link = None;
    for o in outs {
        changed = true;
        match o {
            htmlview::Out::Laid { ask, turn, height, held } => {
                s.web.held = held;
                let old = std::mem::take(&mut s.web.bands);
                if !old.is_empty() {
                    s.web.was = old;
                }
                s.web.laid = Some((ask, turn, height));
            }
            htmlview::Out::Band { turn, index, w, h, px } => {
                if let (true, Some(cache)) = (s.web.laid.as_ref().is_some_and(|l| l.1 == turn), &s.image_cache) {
                    s.web.bands.insert(index, cache.rgba(w, h, px));
                }
            }
            htmlview::Out::Forget { turn, index } => {
                if s.web.laid.as_ref().is_some_and(|l| l.1 == turn) {
                    s.web.bands.remove(&index);
                }
            }
            htmlview::Out::Hot(on) => s.web.hot = on,
            htmlview::Out::Rest(rest) => {
                s.web.painting = !rest;
                if rest {
                    // the turn before's bands that this turn has no band for are of a page that was taller
                    let bands = &s.web.bands;
                    s.web.was.retain(|i, _| bands.contains_key(i));
                }
            }
            htmlview::Out::Failed => {
                // the engine could not draw it: it is read as a document, and said once
                s.web.broken = s.web.asked.take().map(|a| a.key);
                (s.web.laid, s.web.painting) = (None, false);
                s.web.bands.clear();
                s.web.was.clear();
                s.note = "This page could not be drawn as a web page. It is shown as a document.".into();
            }
            htmlview::Out::Link(href) => link = Some(href),
        }
    }
    // a band of the turn before stays until the one that takes its place can be shown
    if !s.web.was.is_empty() {
        let bands = &s.web.bands;
        s.web.was.retain(|i, _| !bands.get(i).is_some_and(|b| b.is_ready()));
    }
    // what was sent is for the page asked for: one left behind says nothing
    if s.web.laid.as_ref().is_some_and(|l| s.web.asked.as_ref().is_none_or(|a| a.key != l.0.key)) {
        s.web.laid = None;
        s.web.bands.clear();
        s.web.was.clear();
    }
    if let Some(href) = link.filter(|_| ask.is_some()) {
        follow(s, &href, tx);
    }
    changed
}

/// An HTML page as a browser shows it: Blitz's pictures of it, band under
/// band, in a scroll view. The room's width is noted as it is laid out,
/// and what is in view is told to the page's thread as it scrolls.
#[cfg(not(target_arch = "wasm32"))]
fn web_view(p: &Page, s: &App, k: &Kit) -> El {
    let room = el().key("web-room").w_full().h_full().min_h(0.0).on_layout(|s: &mut App, r| s.web.room = r[2]);
    let Some((ask, _, height)) = s.web.laid.as_ref().filter(|l| l.0.key.name == p.name && l.0.key.rev == p.rev) else {
        // the line under the header says it is on its way
        return room;
    };
    let (w, height) = (ask.width, *height);
    let ready = |i: &&rune::Image| i.is_ready() && i.error().is_none();
    let mut page = el().key("web-page").size(w, height).cursor(if s.web.hot { rune::Cursor::Pointer } else { rune::Cursor::Default }).label(format!("{}, drawn as a web page", p.name));
    for index in 0..htmlview::bands(height) {
        let top = index as f32 * htmlview::BAND;
        let tall = (height - top).min(htmlview::BAND);
        if let Some(pic) = s.web.bands.get(&index).filter(ready).or(s.web.was.get(&index).filter(ready)) {
            page = page.child(el().key(format!("web-band-{index}")).absolute(0.0, top).size(w, tall).pixels(pic.pixels()).a11y_hidden());
        }
    }
    let page = page
        .on_pointer_move_local(|s: &mut App, at, tx| {
            if let Some(h) = &s.web.html {
                h.point(at.x, at.y, false);
            }
            tx.live_only();
        })
        .on_drag(|s: &mut App, d, tx| {
            // a press let go where it began, not a drag
            if d.phase == Phase::Up && d.dx.abs() < 4.0 && d.dy.abs() < 4.0 {
                if let Some(h) = &s.web.html {
                    h.point(d.x, d.y, true);
                }
            }
            tx.live_only();
        });
    let mut scroll = col().key(format!("web-scroll-{}", p.name)).w_full().h_full().min_h(0.0).child(page).scroll(ScrollSpec { stick_bottom: false });
    if let Some(h) = &s.web.html {
        let see = h.seer();
        scroll = scroll.on_scroll_offset(move |at| see(at.offset[1], at.viewport[1]));
    }
    room.child(scroll)
}

/// The page's editor at the height there is for it: a page longer than
/// that scrolls inside the field, with the caret kept in view. rune-kit's
/// text area grows with its text unless it is told a height in points,
/// so the room it stands in is noted as it is laid out.
fn fill_editor(s: &App, area: TextArea, k: &Kit) -> El {
    // not laid out yet: a height to start from, put right in the next frame
    let room = if s.edit_room > 0.0 { s.edit_room } else { 400.0 };
    // more rows than fit, so the field is as tall as its room even when the page is short
    // a line with no place to break, as a long address, is broken where the room ends: it never runs out of sight
    let field = area.width(None).wrap_anywhere().rows(10_000).max_height(room).build(k).key(FIELD).w_full().min_w(0.0);
    col().key("edit-room").w_full().min_w(0.0).grow(1.0).min_h(0.0).on_layout(|s: &mut App, r| s.edit_room = r[3]).child(field)
}

fn page_body(s: &App, k: &Kit) -> El {
    if let Some(st) = s.settings.as_ref().filter(|_| !s.editing) {
        return settings_view(s, st, k);
    }
    if s.access && !s.editing {
        return access_view(s, k);
    }
    if let Some(f) = s.forum.as_ref().filter(|_| !s.editing) {
        // a board of this ship's wears its own theme, on its own ground, as its pages do on the web
        let own = board_kit(s, k);
        let (k, ground) = match &own {
            Some(bk) => (bk, bk.c.bg_base),
            None => (k, rune::Color::TRANSPARENT),
        };
        return col().key("forum-pane").w_full().h_full().min_h(0.0).fill(ground).child(col().w_full().items_center().child(forum_view(f, s.conn.as_ref().map_or("", |c| c.ship()), &Pics { had: &s.pics, failed: &s.pics_failed }, k))).scroll(ScrollSpec { stick_bottom: false });
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
            .on_key(editor_key);
        let field = fill_editor(s, field, k);
        return col()
            .key("editor")
            .w_full()
            .h_full()
            .min_h(0.0)
            .items_center()
            .child(col().w_full().min_w(0.0).max_w(820.0).h_full().min_h(0.0).padding(16.0).gap(8.0).child(format_bar(s, k)).child(Divider::horizontal().build(k)).child(field).child(offers_bar(s, k)));
    }
    if s.editing {
        // the source, coloured as Markdown: colour only, so nothing moves as it is typed
        let mut marks = code_spans(&p.kind, &s.edit.text, k);
        marks.extend(find_spans(s, k));
        // vim's block: the character under the cursor, or underlined while r waits for its character
        if let Some((at, under)) = s.prefs.vim.then(|| s.vim.block(&vim_buf(&s.edit))).flatten() {
            let from = byte_at(&s.edit.text, at);
            if let Some(ch) = s.edit.text[from..].chars().next().filter(|c| *c != '\n') {
                let span = Span::new(from, from + ch.len_utf8());
                marks.push(if under { span.underline(c.text_base) } else { span.bg(c.text_base, 0.0).color(c.bg_base) });
            }
        }
        // the font is the one chosen in settings: the text area takes its style from the kit it is built with
        let source = TextArea::new(&s.edit).label("Page source").decorations(marks).on_edit(|s: &mut App| &mut s.edit).on_key(editor_key);
        let source = fill_editor(s, source, &editor_kit(k, &s.prefs.font));
        let mut panes = row().key("editor").w_full().h_full().min_h(0.0).padding(16.0).gap(16.0).child(col().grow(1.0).min_w(0.0).h_full().min_h(0.0).child(source).child(offers_bar(s, k)));
        if s.preview && p.kind == "md" {
            let shown = col().key("preview-page").w_full().padding(12.0).child(Markdown::new(md::html_shown(&s.edit.text)).style(page_style(k)).build(k));
            panes = panes.child(col().key("preview").grow(1.0).min_w(0.0).h_full().min_h(0.0).child(shown).scroll(ScrollSpec { stick_bottom: false }));
        }
        return panes;
    }
    if let Some(v) = s.sheet.as_ref().filter(|v| v.name == p.name && v.rev == p.rev) {
        return sheet_view(v, s, k);
    }
    if let Some(m) = s.map.as_ref().filter(|m| m.name == p.name && m.rev == p.rev) {
        return map_view(m, s, k);
    }
    #[cfg(not(target_arch = "wasm32"))]
    if web_page(s).is_some_and(|w| w.name == p.name && w.rev == p.rev) {
        return web_view(p, s, k);
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

/// Opens the theme editor on a theme: a new one, or one kept.
fn draft_open(s: &mut App, d: theme::Draft) {
    let mut fields = Vec::with_capacity(12);
    fields.push(TextEdit::new(d.name.as_str()));
    fields.extend(d.five.iter().chain(&d.more).map(|c| TextEdit::new(c.as_str())));
    fields[0].focused = true;
    s.theme_draft = fields.try_into().ok().map(|f: [TextEdit; 12]| (d.id, d.dark, Box::new(f)));
}

/// The theme the editor holds, as typed.
fn draft_now(s: &App) -> Option<theme::Draft> {
    let (id, dark, f) = s.theme_draft.as_ref()?;
    let text = |i: usize| f[i].text.clone();
    Some(theme::Draft { id: id.clone(), name: text(0), dark: *dark, five: std::array::from_fn(|i| text(1 + i)), more: std::array::from_fn(|i| text(6 + i)) })
}

fn theme_field(s: &mut App, i: usize) -> &mut TextEdit {
    &mut s.theme_draft.as_mut().expect("the theme editor is open").2[i]
}

/// Keeps the theme in the editor and wears it.
fn draft_save(s: &mut App) {
    let Some(d) = draft_now(s).filter(theme::Draft::valid) else {
        s.note = "A theme needs a name and its five colours, each as six hex figures".into();
        return;
    };
    s.theme_draft = None;
    theme_change(s, |w| w.save_theme(&d));
}

/// The theme editor, as the web client's: a name, light or dark, five
/// colours, six more that are derived unless named, and how it would look.
fn draft_view(s: &App, d: &theme::Draft, k: &Kit) -> El {
    let c = &k.c;
    let pick = |label: &str, on: bool| Button::new(label).control_size(ControlSize::Small).variant(if on { ButtonVariant::Contrast } else { ButtonVariant::Ghost });
    let fields = &s.theme_draft.as_ref().expect("the theme editor is open").2;
    // a colour as typed, with what it is beside it
    let colour = |i: usize, label: &str, hint: &str| {
        let shown = theme::hex_of(&fields[i].text).and_then(|h| rune::color::hex(&h.to_lowercase()));
        row().gap(6.0).center_y()
            .child(el().size(18.0, 18.0).radius(4.0).fill(shown.unwrap_or(rune::Color::TRANSPARENT)).border(1.0, c.border_base).a11y_hidden())
            .child(TextInput::new(&fields[i]).label(label).placeholder(hint).on_edit(move |s: &mut App| theme_field(s, i)).build(k).w(120.0).key(format!("draft-{i}")))
            .child(text(label.to_owned()).font(k.ty.small).color(c.text_muted))
    };
    let mut five = row().key("draft-five").gap(12.0).flex_wrap();
    for (i, label) in ["Primary", "Secondary", "Tertiary", "Background", "Surface"].into_iter().enumerate() {
        five = five.child(colour(1 + i, label, "#RRGGBB"));
    }
    let mut more = row().key("draft-more").gap(12.0).flex_wrap();
    for (i, label) in ["Text", "Muted text", "Raised", "Error", "Selection", "Links"].into_iter().enumerate() {
        more = more.child(colour(6 + i, label, "Auto"));
    }
    // how it would look: the background, with a card of its surface on it, as Talon's editor shows
    let l = d.look();
    let bg = theme::hex_of(&d.five[3]).and_then(|h| rune::color::hex(&h.to_lowercase())).unwrap_or(c.bg_base);
    let ink = l.text.unwrap_or(c.text_base);
    let word = |t: &str, ink: rune::Color| text(t.to_owned()).font(k.ty.small_medium).color(ink);
    let demo = row().key("draft-demo").w_full().padding(12.0).gap(10.0).center_y().flex_wrap().radius(k.radius.md).fill(bg).border(1.0, c.border_base)
        .child(word("A menu on a surface.", ink).px(10.0).py(4.0).radius(6.0).fill(l.bg.unwrap_or(c.layer_01)).border(1.0, l.border_soft.unwrap_or(c.border_base)))
        .child(word("Primary", l.on_accent.unwrap_or(c.text_contrast)).px(10.0).py(4.0).radius(6.0).fill(l.accent.unwrap_or(c.bg_accent)))
        .child(word("Secondary", theme::hex_of(&d.five[1]).and_then(|h| rune::color::hex(&h.to_lowercase())).unwrap_or(ink)))
        .child(word("Tertiary", theme::hex_of(&d.five[2]).and_then(|h| rune::color::hex(&h.to_lowercase())).unwrap_or(ink)))
        .child(word("A link", l.link.unwrap_or(c.text_accent)))
        .child(word("An error", l.error.unwrap_or(c.danger.fg)))
        .child(word("Raised", ink).px(10.0).py(4.0).radius(6.0).fill(l.raised.unwrap_or(c.layer_02)))
        .child(word("Muted", l.muted.unwrap_or(c.text_muted)));
    col().key("theme-draft").w_full().gap(8.0).padding(12.0).radius(k.radius.md).border(1.0, c.border_base)
        .child(TextInput::new(&fields[0]).label("Theme name").placeholder("Theme name").on_edit(|s: &mut App| theme_field(s, 0)).on_submit(|s: &mut App, _| draft_save(s)).build(k).w(260.0).key("draft-name"))
        .child(row().gap(4.0)
            .child(pick("Light", !d.dark).on_press(|s: &mut App| if let Some(t) = &mut s.theme_draft { t.1 = false }).build(k).key("draft-light"))
            .child(pick("Dark", d.dark).on_press(|s: &mut App| if let Some(t) = &mut s.theme_draft { t.1 = true }).build(k).key("draft-dark")))
        .child(five)
        .child(text("More colours. Left empty, each is worked out from the five.").font(k.ty.small).color(c.text_muted).wrap())
        .child(more)
        .child(demo)
        .child(row().gap(6.0)
            .child(Button::new("Save and use").control_size(ControlSize::Small).variant(ButtonVariant::Contrast).disabled(!d.valid()).on_press(draft_save).build(k).key("draft-save"))
            .child(Button::new("Cancel").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).on_press(|s: &mut App| s.theme_draft = None).build(k).key("draft-cancel")))
}

/// Makes a change to what lattice wears: here at once, kept for the next
/// run, and written to the ship, where the web client and every other
/// window read it.
// ponytail: a read of the ship already on its way can put the old look back for a moment. Count the changes, as the web client does, if that is seen
fn theme_change(s: &mut App, change: impl FnOnce(&mut theme::Worn) -> theme::Put) {
    let put = change(&mut s.prefs.worn);
    save_prefs(s);
    if let Some(c) = s.conn.clone() {
        s.theme_put.request((c, put), |(c, put)| c.settings_put(&put));
    }
}

/// The family the app's text is set in when no theme names one: Rune's own.
const APP_FONT: &str = "Inter";

/// The families the window's text is set in, as a list tried in order:
/// the theme's font, then the app's own. A family Talon installed is used
/// when this computer has it too. ponytail: its files on the ship are not
/// fetched, since Rune takes font files only at launch. Ask Rune for a
/// call that registers a font while the app runs if that is wanted.
fn font_of(worn: &theme::Worn) -> String {
    match worn.font() {
        None => APP_FONT.to_owned(),
        Some(theme::Font::Serif) => format!("Georgia, Times New Roman, Noto Serif, DejaVu Serif, Liberation Serif, {APP_FONT}"),
        Some(theme::Font::Mono) => format!("ui-monospace, {APP_FONT}"),
        Some(theme::Font::Named(f)) => format!("\"{f}\", {APP_FONT}"),
    }
}

/// The board of this ship's that the forum is showing, a thread's board with it.
fn board_showing(s: &App) -> Option<&str> {
    let f = s.forum.as_ref()?;
    let name = f.thread.as_ref().map(|t| t.board.as_str()).or(f.board.as_ref().map(|b| b.board.as_str()))?;
    (!name.starts_with('~')).then_some(name)
}

/// Whether a page is published to the web, by its own setting or by the nearest folder's that has one.
fn on_clearweb(s: &App, name: &str) -> bool {
    if let Some(mode) = s.shares.get(name) {
        return mode == "clearweb";
    }
    let mut dir = name;
    while let Some((up, _)) = dir.rsplit_once('/') {
        if let Some(mode) = s.dshares.get(up) {
            return mode == "clearweb";
        }
        dir = up;
    }
    false
}

/// The page that dresses a board: the nearest `theme` at or above its folder that is a stylesheet
/// published to the web, as the ship picks it for the board's own pages.
fn board_theme_page(s: &App, board: &str) -> Option<String> {
    theme::board_theme_names(board).into_iter().find(|n| s.files.get(n).and_then(|f| f.data.as_ref()).is_some_and(|d| d.kind == "css") && on_clearweb(s, n))
}

/// Reads the theme of the board showing, once for each board. Another ship's board has none
/// that can be read here: its tree is not this ship's to look in.
fn board_theme_sync(s: &mut App) {
    let Some(board) = board_showing(s).map(str::to_owned) else { return };
    if s.board_theme.as_ref().is_some_and(|t| t.0 == board) {
        return;
    }
    s.board_theme = Some((board.clone(), String::new()));
    if let (Some(c), Some(page)) = (s.conn.clone(), board_theme_page(s, &board)) {
        s.board_theme_req.request((c, board, page), |(c, board, page)| c.page(&page).map(|p| (board, p.body)));
    }
}

/// The kit a board is drawn with: its own theme's, or the window's when it has none.
fn board_kit(s: &App, k: &Kit) -> Option<Kit> {
    let board = board_showing(s)?;
    let (_, css) = s.board_theme.as_ref().filter(|t| t.0 == board && !t.1.is_empty())?;
    let look = theme::css_look(css, k.dark);
    look.bg.is_some().then(|| kit_from(look, k.dark))
}

/// The kit the window is drawn with: the theme the ship says is worn,
/// and the accent over it, as the web client wears them. With no theme
/// it is the built-in look, light or dark as the mode picked says.
fn kit_of(prefs: &api::Prefs, system_dark: bool) -> Kit {
    kit_from(prefs.worn.look(), prefs.dark(system_dark))
}

/// A kit for a look. One that brings no ground of its own is the built-in look, dark or light as told.
fn kit_from(look: theme::Look, dark: bool) -> Kit {
    let mut k = match (look.bg, look.text) {
        // a theme brings its own light or dark: the mode picked is for the built-in look
        (Some(bg), Some(fg)) => Kit::from_palette(rune_kit::PaletteSeed { bg, fg, accent: look.accent.unwrap_or(fg) }),
        _ => Kit::neutral(dark),
    };
    let c = &mut k.c;
    if let Some(muted) = look.muted {
        (c.text_muted, c.icon_muted) = (muted, muted);
    }
    if let (Some(soft), Some(strong)) = (look.border_soft, look.border) {
        (c.border_muted, c.border_base, c.border_strong) = (soft, soft, strong);
    }
    if let Some(raised) = look.raised {
        (c.layer_01, c.bg_button_neutral, c.surface_raised, c.surface_raised_base) = (raised, raised, raised, raised);
    }
    if let Some(error) = look.error {
        (c.danger.fg, c.danger.icon) = (error, error);
    }
    if let (Some(a), Some(on)) = (look.accent, look.on_accent) {
        // the accent is the primary colour: what stands out is drawn in it, with its own ink
        (c.bg_accent, c.icon_accent, c.text_accent) = (a, a, a);
        (c.bg_contrast, c.bg_icon_button_contrast) = (a, a);
        (c.text_contrast, c.icon_contrast, c.submit_fg, c.submit_icon) = (on, on, on, on);
    }
    if let Some(link) = look.link {
        // links, and the selection the kit tints from them. A theme's own
        // selection colour is not worn: the kit has no place of its own for one.
        c.text_accent = link;
    }
    k
}

fn view(s: &App, cx: &mut Cx<App>) -> El {
    let k = kit_of(&s.prefs, cx.system_dark());
    #[cfg(not(target_arch = "wasm32"))]
    s.web.env.set((cx.env().scale, k.dark));
    if (s.conn.is_none() && !s.sample) || s.adding {
        return login_view(s, &k);
    }
    let path = s.open.as_ref().map(|p| p.name.as_str()).or(s.folder.as_deref());
    // the name it was given when there is one, with its path beside it
    let named = path.and_then(|p| s.dnames.get(p).filter(|_| !s.memory && s.remote.is_none()).map(|d| format!("{d}  ({p})")));
    let title = if s.settings.is_some() { "Settings" } else if s.forum.is_some() { "Forum" } else if s.inbox { "Inbox" } else if s.shared_open { "Browser" } else if s.access { "Access" } else { named.as_deref().or(path).unwrap_or("lattice") };
    let busy = s.tree_req.is_pending() || s.page_req.is_pending() || s.save_req.is_pending() || s.drain_req.is_pending();
    let mut layer = Vec::new();
    let page = s.open.is_some() && !s.access && !s.shared_open && !s.inbox;
    let remote = s.remote.as_ref().filter(|_| page);
    // the Edit and Read switch: a page shows it, a screen that is no page (the forum, the inbox, a folder) does not
    let (editing, can_edit) = (page && s.editing, remote.is_none_or(Shared::editable));
    let mut trailing = row().gap(6.0).center_y();
    // a page that is not Markdown says what it is, since it is read and edited by that kind's rules. Pressed, it asks for another
    if let Some(p) = s.open.as_ref().filter(|p| page && remote.is_none() && !s.memory && p.kind != "md" && s.old.is_none()) {
        let can = usable(s, "kind");
        trailing = trailing.child(Button::new(kind_said(&p.kind).to_owned()).control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help(if can { "This page's kind. Press to change it" } else { "This page's kind" }).disabled(!can).on_press_tx(|s: &mut App, tx| run_command(s, "kind", tx)).build(&k).key("page-kind"));
    }
    // an HTML page is shown as a web page, or read as a document: one press goes between them
    #[cfg(not(target_arch = "wasm32"))]
    if page && !s.editing && !s.memory && s.open.as_ref().is_some_and(|p| p.kind == "html") {
        let plain = s.prefs.html_plain;
        trailing = trailing.child(Button::new(if plain { "Web page" } else { "Document" }).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help(if plain { "Show this page as a browser would, with its own styles" } else { "Read this page as a document, without its styles" }).on_press(|s: &mut App| {
            s.prefs.html_plain ^= true;
            save_prefs(s);
        }).build(&k).key("html-mode"));
    }
    if s.editing {
        if s.prefs.vim && !s.rich {
            trailing = trailing.child(text(s.vim.indicator()).key("vim-mode").font(k.ty.small_medium).color(k.c.text_muted));
        }
        // rich text and the preview are Markdown's: a page of another kind is its source and nothing else
        let is_md = s.open.as_ref().is_some_and(|p| p.kind == "md");
        if is_md {
            trailing = trailing.child(Button::new(if s.rich { "Source" } else { "Rich text" }).control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).on_press_tx(|s: &mut App, tx| {
                flip_mode(s);
                tx.focus_when_shown(FIELD, false);
            }).build(&k).key("mode"));
        }
        if !s.rich && is_md {
            trailing = trailing.child(Button::new(if s.preview { "Hide preview" } else { "Preview" }).control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).on_press(|s: &mut App| s.preview ^= true).build(&k).key("preview-toggle"));
        }
        trailing = trailing
            .child(Switch::new(!s.prefs.no_autosave).label("Autosave").on_toggle(|s: &mut App| {
                s.prefs.no_autosave = !s.prefs.no_autosave;
                save_prefs(s);
            }).build(&k).key("autosave"));
    } else if let Some(sh) = remote {
        // another ship's page: read, and edited when that ship lets this one
        trailing = trailing.child(text(format!("from {}", sh.host)).font(k.ty.small).color(k.c.text_muted));
        // the reader's star: kept on the ship, and listed in the pane's Bookmarks tab
        let kept = s.marks.as_deref().is_some_and(|m| marks::has(m, &mark_url(sh)));
        trailing = trailing.child(Button::new(if kept { "Bookmarked" } else { "Bookmark" }).control_size(ControlSize::Small).variant(ButtonVariant::GhostMuted).help(if kept { "Drop the bookmark of this page" } else { "Keep this page as a bookmark" }).on_press(star).build(&k).key("star"));
        // a page read by its address was published, not shared with this ship: there is no edit to ask for
        if !sh.editable() && sh.mode != "published" {
            // read only: the host can be asked for more
            let (to, asked) = (sh.clone(), s.asks.sent.iter().any(|a| a.ship == sh.host && a.path == sh.path));
            trailing = trailing.child(Button::new(if asked { "Ask again" } else { "Ask to edit" }).control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help(if asked { "You asked already. Asking again replaces that request" } else { "Ask its ship to let you edit it" }).on_press(move |s: &mut App| {
                let mut t = TextEdit::new("");
                t.focused = true;
                s.prompt = Some(Prompt::Ask(to.clone(), t));
            }).build(&k).key("ask-edit"));
        }
    }
    if page && (can_edit || editing) {
        // Edit and Read, as one switch: Read from an edit saves what was typed, as Ctrl+E does
        let side = |label: &str, on: bool| Button::new(label).control_size(ControlSize::Small).variant(if on { ButtonVariant::Contrast } else { ButtonVariant::Ghost });
        trailing = trailing.child(
            row()
                .key("edit-read")
                .role("group")
                .label("Edit or Read")
                .gap(2.0)
                .padding(2.0)
                .radius(k.radius.md)
                .fill(k.c.layer_01)
                .child(side("Edit", editing).help("Edit / Read (Ctrl+E)").on_press_tx(|s: &mut App, tx| {
                    if !s.editing {
                        start_edit(s);
                        tx.focus_when_shown(FIELD, false);
                    }
                }).build(&k).key("edit"))
                .child(side("Read", !editing).help("Edit / Read (Ctrl+E)").on_press(|s: &mut App| {
                    if s.editing {
                        to_read(s);
                    }
                }).build(&k).key("read")),
        );
    }
    if s.editing {
        trailing = trailing
            .child(Button::new("Cancel").control_size(ControlSize::Small).variant(ButtonVariant::Ghost).help("Leave the edit and drop what was typed").on_press(cancel_edit).build(&k).key("cancel"))
            .child(IconButton::new(&tabhead::SAVE).variant(IconButtonVariant::Neutral).help("Save").shortcut("Ctrl+S").on_press(save).build(&k).key("save"));
    }
    // the page menu's rows, in the web client's order, for the commands that can run now
    let items: Vec<(&str, &str)> = tabhead::MENU.iter().copied().filter(|(id, _)| page && !s.editing && usable(s, id)).collect();
    if !items.is_empty() {
        let dots = IconButton::new(&tabhead::DOTS).variant(IconButtonVariant::GhostMuted).help("Page menu").expanded(s.page_menu).on_press(|s: &mut App| s.page_menu ^= true).build(&k).key("page-menu-open");
        let mut menu = Menu::new("page-menu").trigger(dots).open(s.page_menu).on_close(|s: &mut App| s.page_menu = false);
        for (id, label) in items {
            menu = menu.item(MenuItem::new(label).danger(id == "delete").on_select_tx(move |s: &mut App, tx| {
                s.page_menu = false;
                run_command(s, id, tx);
            }));
        }
        trailing = trailing.child(menu.build(&k, &mut layer));
    }
    switcher(s, &k, &mut layer);
    palette_view(s, &k, &mut layer);
    template_view(s, &k, &mut layer);
    prompt_view(s, &k, &mut layer);
    ships_view(s, &k, &mut layer);
    share_view(s, &k, &mut layer);
    let nav = |key: &str, icon: &'static rune::Icon, name: &str, by: isize, on: bool| IconButton::new(icon).variant(IconButtonVariant::GhostMuted).help(name).disabled(!on).on_press(move |s: &mut App| step(s, by)).build(&k).key(key.to_owned());
    let name = text(title.to_owned()).key("title").font(k.ty.ui_medium).color(k.c.text_base).truncate();
    // the name is the way to move or rename the page, as on the web
    let name = if page && remote.is_none() && !s.editing {
        row().key("rename").role("button").label(format!("{title}: move or rename")).help("Move or rename").min_w(0.0).shrink().px(6.0).h(24.0).center_y().radius(k.radius.sm).on_press(ask_rename).child(name.min_w(0.0).shrink())
    } else {
        // a long name gives way to what stands beside it, cut short with its whole self on hover
        row().min_w(0.0).shrink().px(6.0).center_y().child(name.min_w(0.0).shrink().help_when_truncated(title.to_owned()))
    };
    let leading = row()
        .gap(2.0)
        .center_y()
        .child(nav("back", &tabhead::LEFT, "Back", -1, s.trail_at > 0))
        .child(nav("forward", &tabhead::RIGHT, "Forward", 1, s.trail_at + 1 < s.trail.len()))
        .child(name);
    let main = body(s, &k);
    let main = if s.tgroups.is_empty() || s.memory {
        main
    } else {
        // every group stands where it stood, in one row or one column: the one in front is drawn in its own place among the rest
        let down = s.split_down;
        // the line between two neighbours: dragged, it moves room from one to the other
        let rule = |i: usize| {
            let line = el().key(format!("line-{i}")).label("Drag to give one group more room. Press twice to make the two alike").fill(k.c.border_weak).cursor(if down { rune::Cursor::ResizeRow } else { rune::Cursor::ResizeColumn }).on_drag(move |s: &mut App, d, _| drag_line(s, i, d));
            if down { line.w_full().h(4.0) } else { line.h_full().w(4.0) }
        };
        let n = s.tgroups.len();
        let mut main = Some(main);
        let mut all = if down { col() } else { row() }.w_full().h_full().min_h(0.0).min_w(0.0);
        for d in 0..n {
            if d > 0 {
                all = all.child(rule(d - 1));
            }
            let one = match main.take_if(|_| d == s.front_at) {
                Some(front) => col().key("group-front").on_layout_tx(|s: &mut App, r, tx| {
                    s.front_rect = r;
                    tx.live_only();
                }).child(front),
                // where it stands is noted, for a tab dropped on it
                None => col().on_layout_tx(move |s: &mut App, r, tx| {
                    if s.group_rects.len() <= d {
                        s.group_rects.resize(d + 1, [0.0; 4]);
                    }
                    s.group_rects[d] = r;
                    tx.live_only();
                }).child(split_view(d, s, &k)),
            };
            // each takes its share of the room: shares that add up to 1, as weights
            let share = s.group_share.get(d).copied().filter(|_| s.group_share.len() == n).unwrap_or(1.0 / n as f32);
            let one = one.grow((share * 100.0).max(1.0)).min_w(0.0).min_h(0.0);
            all = all.child(if down { one.w_full() } else { one.h_full() });
        }
        all
    };
    // under the top bar, the page's own bar: where it has been, its name, and what can be done with it
    // while editing the tools are many. In a narrow pane, as with the right pane open, they take a row of
    // their own under the name, where they drew over it
    let narrow = s.editing && s.groups_room.0 > 0.0 && s.groups_room.0 < 720.0;
    let head = if narrow {
        col().key("tab-head").w_full().px(8.0)
            .child(row().w_full().h(32.0).center_y().child(leading.grow(1.0).min_w(0.0)))
            // and wrap among themselves when even that row is too short for them
            .child(trailing.w_full().min_w(0.0).min_h(32.0).py(2.0).flex_wrap().justify_end())
    } else {
        row().key("tab-head").w_full().h(36.0).px(8.0).gap(8.0).center_y().justify_between().child(leading.grow(1.0).min_w(0.0)).child(trailing)
    };
    // the room the groups have is noted as it is laid out: a split is refused when it is too little for two
    // while browsing, the browser's bar is the header: its own Back and Forward, the address, and the star
    let head = if browsing(s) && !s.editing { browser_bar(s, &k).pt(6.0) } else { head };
    #[cfg(not(target_arch = "wasm32"))]
    let offer = update_banner(s, &k);
    #[cfg(target_arch = "wasm32")]
    let offer: Option<El> = None;
    let main = col().w_full().h_full().min_h(0.0).children(offer).child(head).child(wait_line(busy || web_waiting(s), &k)).child(col().key("groups").w_full().grow(1.0).min_h(0.0).on_layout(|s: &mut App, r| s.groups_room = (r[2], r[3])).child(main));
    let inset = cx.titlebar_inset();
    let right = IconButton::new(&topbar::PANE_RIGHT).variant(if s.inspector.is_open() { IconButtonVariant::Neutral } else { IconButtonVariant::GhostMuted }).help("Right pane").on_press(toggle_right).build(&k).key("pane-right");
    let shell = SplitView::new(main)
        .sidebar(&s.sidebar, |s: &mut App| &mut s.sidebar, tree_menu_view(s, &k, sidebar(s, &k), &mut layer))
        .inspector(&s.inspector, |s: &mut App| &mut s.inspector, right_pane(s, &k))
        .toolbar(Toolbar::new().leading(tab_strip(s, &k)).trailing(right))
        // the left pane's toggle is the ribbon's first icon, as on the web
        .hide_sidebar_toggle()
        // the ribbon stands where the window's own buttons would push the toolbar from
        .titlebar_inset((inset - 40.0).max(0.0))
        .frame_inset(8.0)
        .toolbar_in_panel()
        .reduced_motion(cx.is_reduced_motion())
        .build(&k);
    if s.dropping && !s.editing {
        // said in the middle of the window, over whatever is there
        layer.push(col().key("drop-hint").absolute(0.0, 0.0).w_full().h_full().center().child(text("Drop to upload as pages").font(k.ty.body_medium).color(k.c.text_base).padding(16.0).radius(k.radius.md).fill(k.c.layer_01)));
    }
    // files dropped anywhere on the window are uploaded, as on the web
    // a theme's ground goes behind the ribbon and the status bar too. The built-in look leaves the window's own there
    let ground = if s.prefs.worn.look().bg.is_some() { k.c.page } else { rune::Color::TRANSPARENT };
    let shell = row().w_full().h_full().min_h(0.0).fill(ground).child(ribbon_view(s, &k, if inset > 0.0 { 32.0 } else { 0.0 })).child(col().grow(1.0).min_w(0.0).h_full().min_h(0.0).child(el().w_full().grow(1.0).min_h(0.0).child(shell)).child(status_bar(s, &k, busy)));
    rune_kit::root(shell, layer).on_drop_files(|s: &mut App, files, _| upload(s, files.to_vec())).on_drop_hover(|s: &mut App, over, _| s.dropping = over)
}

/// A chord the web client binds (`ui-src/lattice`: 21-tabs, 23-tabhead,
/// 24-tools, 26-palette, 28-splits, 30-tree, 79-search), as what it does here.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Chord {
    /// Ctrl+K and Ctrl+P: the commands.
    Palette,
    /// Ctrl+O: the pages by name.
    Jump,
    /// Ctrl+Shift+F: the left pane's Search tab, as on the web.
    Search,
    /// Ctrl+,
    Settings,
    /// Ctrl+Tab and Ctrl+Shift+Tab: the next tab and the one before, around the ends.
    Tab(bool),
    /// Ctrl+E while editing: back to reading, with what was typed saved. Vim keeps the chord while its editor is on.
    Read,
    /// Ctrl+Shift+L: the pages' list, with its filter to type in.
    Files,
    /// Ctrl+\: split right.
    Split,
    /// Ctrl+Shift+\: split down.
    SplitDown,
    /// Ctrl+Shift+] and Ctrl+Shift+[: the next group to the front, and the one before, round at the ends.
    Group(bool),
    /// Delete, with nothing typed into: the page showing, asked first.
    Delete,
}

fn chord(s: &App, ev: &KeyEvent) -> Option<Chord> {
    let m = ev.mods;
    if ev.key == Key::Tab && m.ctrl && !m.alt {
        return (!s.editing && s.tabs.len() > 1).then_some(Chord::Tab(!m.shift));
    }
    if ev.key == Key::Delete && m == rune::Mods::default() {
        return (page_changes(s) && s.open.is_some() && s.prompt.is_none() && s.palette.is_none() && s.jump.is_none()).then_some(Chord::Delete);
    }
    if m.alt {
        return None;
    }
    if m.shift {
        return if ev.is_command('f') && !s.editing {
            Some(Chord::Search)
        } else if ev.is_command('l') {
            Some(Chord::Files)
        } else if (ev.is_command('\\') || ev.is_command('|')) && !s.editing {
            // a shifted key comes as either of its two characters, by the keyboard and the platform
            Some(Chord::SplitDown)
        } else if (ev.is_command(']') || ev.is_command('}')) && !s.editing {
            Some(Chord::Group(true))
        } else if (ev.is_command('[') || ev.is_command('{')) && !s.editing {
            Some(Chord::Group(false))
        } else {
            None
        };
    }
    if (ev.is_command('k') || ev.is_command('p')) && !s.editing {
        // with vim on, Ctrl+P in its editor is vim's own
        Some(Chord::Palette)
    } else if ev.is_command('o') && !s.editing {
        Some(Chord::Jump)
    } else if ev.is_command(',') && !s.editing {
        Some(Chord::Settings)
    } else if ev.is_command('e') && s.editing && !(s.prefs.vim && !s.rich) {
        Some(Chord::Read)
    } else if ev.is_command('\\') && !s.editing {
        Some(Chord::Split)
    } else {
        None
    }
}

fn on_key(s: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if s.conn.is_none() && !s.sample {
        return false;
    }
    if let Some(c) = chord(s, ev) {
        let ask = |s: &mut App, jump: bool| {
            let mut q = TextEdit::new("");
            q.focused = true;
            if jump {
                (s.jump, s.jump_at) = (Some(q), 0);
            } else {
                (s.palette, s.palette_at) = (Some(q), 0);
            }
        };
        match c {
            Chord::Palette => ask(s, false),
            Chord::Jump => ask(s, true),
            Chord::Search => open_search(s),
            Chord::Settings => go_settings(s),
            Chord::Tab(next) => {
                let n = s.tabs.len();
                switch_tab(s, if next { (s.tab + 1) % n } else { (s.tab + n - 1) % n });
            }
            Chord::Read => to_read(s),
            Chord::Files => {
                s.sidebar.set_open(true);
                tx.focus_when_shown("filter", false);
            }
            Chord::Split => split_press(s, false),
            Chord::SplitDown => split_press(s, true),
            Chord::Group(forward) => turn_group(s, forward),
            Chord::Delete => ask_delete(s),
        }
        return true;
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

/// The browser's way in: the page's script calls this once the wasm is loaded.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    run();
}

pub fn run() {
    let chrome = Chrome { full_size_content: true, traffic_lights: Some((16.0, 25.0)), drag_regions: true };
    // the theme's font as the last run knew it, read from this computer's own files and put right
    // where its tables are wrong, before Rune looks for the family itself. A font first worn in this
    // run is found by Rune, and is read this way from the next launch
    #[cfg(not(target_arch = "wasm32"))]
    let fonts: &'static [&'static [u8]] = match api::Prefs::load_for(Conn::load().as_ref().map_or("", |c| c.url.as_str())).worn.font() {
        Some(theme::Font::Named(f)) => Box::leak(fonts::of_family(&f).into_iter().map(|b| &*Box::leak(b.into_boxed_slice())).collect::<Vec<&'static [u8]>>().into_boxed_slice()),
        _ => &[],
    };
    #[cfg(target_arch = "wasm32")]
    let fonts: &'static [&'static [u8]] = &[];
    // the id the desktop matches to `lattice-rune.desktop`, which names the icon: the window wears lattice's logo by it
    rune::set_app_id("lattice-rune");
    let app = rune::App::new(AppSpec {
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
        fonts,
        ..AppSpec::new("lattice", (1120.0, 720.0), init, view)
    })
    .chrome(chrome)
    .on_close(|s: &mut App, _| closing(s));
    app.run();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tree_row_menu_fits_the_row_and_marks_the_part_to_change() {
        assert_eq!(tree_menu_items(false).iter().map(|i| i.0).collect::<Vec<_>>(), ["rename", "move", "download", "delete"]);
        assert_eq!(tree_menu_items(true).iter().map(|i| i.0).collect::<Vec<_>>(), ["rename", "move", "delete"]);
        assert_eq!(tree_menu_edit("notes/plans/today", false).selected(), "today");
        assert_eq!(tree_menu_edit("notes/plans/today", true).selected(), "notes/plans/");
        assert_eq!(tree_menu_edit("today", false).selected(), "today");
        assert_eq!(tree_menu_edit("today", true).selected(), "");
    }

    #[test]
    fn a_later_page_of_threads_goes_after_those_held_each_once() {
        let post = |id: u64| api::ForumPost { id, ..Default::default() };
        let joined = forum_joined(&[post(9), post(8)], vec![post(8), post(7), post(6)]);
        assert_eq!(joined.iter().map(|p| p.id).collect::<Vec<_>>(), [9, 8, 7, 6]);
    }

    /// What the reader draws for a Markdown text: every piece of text in order, and how many of each
    /// kind of block (heading, listitem, blockquote, image).
    fn drawn(src: &str) -> (String, std::collections::BTreeMap<&'static str, usize>) {
        struct Doc(String);
        fn view(d: &Doc, _: &mut Cx<Doc>) -> El {
            let k = Kit::neutral(true);
            col().w_full().child(Markdown::new(md::wikilinks(&md::html_shown(&d.0), &|_| false)).selectable(true).style(page_style(&k)).build(&k))
        }
        let mut rt = rune::Runtime::new(Doc(src.to_owned()), view, (800.0, 20000.0), rune::Env::new(true, 1.0));
        rt.frame(0.0);
        rt.frame(0.1);
        let mut text = String::new();
        let mut kinds = std::collections::BTreeMap::new();
        for e in rt.elements() {
            if let Some(t) = &e.text {
                text.push_str(t);
                text.push(' ');
            }
            if matches!(e.role, "heading" | "listitem" | "blockquote" | "image") {
                *kinds.entry(e.role).or_insert(0) += 1;
            }
        }
        (text, kinds)
    }

    /// The text of the HTML the CommonMark spec gives for an example, as a reader of the page would
    /// see it: tags gone, entities read.
    fn html_text(html: &str) -> String {
        let mut out = String::new();
        let mut rest = html;
        while let Some(a) = rest.find('<') {
            out.push_str(&rest[..a]);
            match rest[a..].find('>') {
                Some(z) => {
                    // an image is its alt words
                    let tag = &rest[a..a + z];
                    if let Some(alt) = tag.strip_prefix("<img").and_then(|t| t.split("alt=\"").nth(1)).and_then(|t| t.split('"').next()) {
                        out.push_str(alt);
                    }
                    rest = &rest[a + z + 1..];
                }
                None => {
                    rest = "";
                }
            }
        }
        out.push_str(rest);
        out.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&amp;", "&")
    }

    /// Letters and figures only, so spacing, bullets, list numbers and the pads round code do not count.
    fn letters(s: &str) -> String {
        s.chars().filter(|c| c.is_alphanumeric()).collect()
    }

    /// Runs every example of the CommonMark spec through the reader and says, by section, which
    /// lose text the spec's HTML shows, which show text it does not, and which have another
    /// number of headings, list items, quotes or images. `LATTICE_CM_SPEC` names the spec's
    /// `spec.json` (spec.commonmark.org). The parser is pulldown-cmark, which passes the spec:
    /// this holds what is drawn to what it parsed.
    #[test]
    #[ignore = "LATTICE_CM_SPEC names spec.json"]
    fn the_reader_against_the_commonmark_spec() {
        let Ok(path) = std::env::var("LATTICE_CM_SPEC") else { return };
        let spec: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let mut by: std::collections::BTreeMap<String, (usize, Vec<String>)> = std::collections::BTreeMap::new();
        for e in &spec {
            let (md, html, n, section) = (e["markdown"].as_str().unwrap(), e["html"].as_str().unwrap(), e["example"].as_u64().unwrap(), e["section"].as_str().unwrap());
            let (text, kinds) = drawn(md);
            let (want, got) = (letters(&html_text(html)), letters(&text));
            let count = |tag: &str| html.matches(tag).count();
            let mut wrong = Vec::new();
            // a numbered list draws its numbers, which the HTML leaves to the browser: figures more than
            // the HTML has are not a fault there
            let numbers_only = html.contains("<ol") && {
                let mut w = want.chars().peekable();
                got.chars().all(|c| if w.peek() == Some(&c) { w.next(); true } else { c.is_ascii_digit() }) && w.peek().is_none()
            };
            if want != got && !numbers_only {
                wrong.push(if got.len() < want.len() { "text lost" } else if got.len() > want.len() { "text added" } else { "text differs" });
                if std::env::var("LATTICE_CM_SHOW").is_ok() {
                    eprintln!("-- {n} {section}\n   md   {md:?}\n   want {want:?}\n   got  {got:?}");
                }
            }
            let heads = (1..=6).map(|l| count(&format!("<h{l}>")) + count(&format!("<h{l} "))).sum::<usize>();
            for (role, n) in [("heading", heads), ("listitem", count("<li>")), ("blockquote", count("<blockquote>")), ("image", count("<img "))] {
                if kinds.get(role).copied().unwrap_or(0) != n && std::env::var("LATTICE_CM_SHOW").is_ok() {
                    eprintln!("-- {n} {section}: {role} {} drawn, {n2} in the HTML\n   md   {md:?}", kinds.get(role).copied().unwrap_or(0), n2 = n);
                }
                if kinds.get(role).copied().unwrap_or(0) != n {
                    wrong.push(match role {
                        "heading" => "headings",
                        "listitem" => "list items",
                        "blockquote" => "quotes",
                        _ => "images",
                    });
                }
            }
            let entry = by.entry(section.to_owned()).or_default();
            entry.0 += 1;
            if !wrong.is_empty() {
                entry.1.push(format!("{n} ({})", wrong.join(", ")));
            }
        }
        let (mut all, mut bad) = (0, 0);
        for (section, (n, wrong)) in &by {
            all += n;
            bad += wrong.len();
            eprintln!("{section}: {} of {n} as the spec has them{}", n - wrong.len(), if wrong.is_empty() { String::new() } else { format!(". Not: {}", wrong.join("; ")) });
        }
        eprintln!("ALL: {} of {all}", all - bad);
    }

    #[test]
    fn a_page_kind_is_typed_by_its_name_or_a_word_for_it() {
        assert_eq!(kind_typed(" Markdown "), Some("md"));
        assert_eq!(kind_typed(".md"), Some("md"));
        assert_eq!(kind_typed("gemtext"), Some("gmi"));
        assert_eq!(kind_typed("txt"), Some("text"));
        assert_eq!(kind_typed("fods"), None, "a sheet is not typed into being");
        assert_eq!(kind_typed("nonsense"), None);
        assert_eq!((kind_said("gmi"), kind_said("md")), ("gemtext", "Markdown"));
    }

    #[test]
    fn a_page_changes_kind_and_keeps_its_text() {
        let mut s = sample("welcome");
        let before = s.open.clone().unwrap();
        assert_eq!(before.kind, "md");
        s.prompt = Some(Prompt::Kind(TextEdit::new("nonsense")));
        confirm(&mut s);
        assert!(matches!(s.prompt, Some(Prompt::Kind(_))) && s.note.contains("one of"), "a kind that is none is asked for again");
        s.prompt = Some(Prompt::Kind(TextEdit::new("gemtext")));
        confirm(&mut s);
        let after = s.open.clone().unwrap();
        assert_eq!((after.kind.as_str(), &after.body, after.rev), ("gmi", &before.body, before.rev + 1));
        assert!(s.prompt.is_none());
        s.prompt = Some(Prompt::Kind(TextEdit::new("md")));
        confirm(&mut s);
        assert_eq!(s.open.as_ref().unwrap().kind, "md");
    }

    #[test]
    fn a_ship_not_in_front_says_what_is_new_on_it() {
        let seen = |up, unread, waiting, expired| api::ShipSeen { up, unread, waiting, expired };
        assert_eq!(ship_news(None), "");
        assert_eq!(ship_news(Some(&seen(true, 0, 0, false))), "", "a ship that answers with nothing new says nothing");
        assert_eq!(ship_news(Some(&seen(true, 3, 0, false))), "3 unread");
        assert_eq!(ship_news(Some(&seen(false, 0, 2, false))), "not answering \u{b7} 2 waiting to be sent");
        assert_eq!(ship_news(Some(&seen(true, 0, 0, true))), "sign in again");
    }

    #[test]
    fn signing_out_asks_only_when_a_folder_is_mounted_with_the_session() {
        let mut s = sample("welcome");
        s.conn = Some(Conn { url: "https://zod.test".into(), cookie: "urbauth-~zod=0v1".into() });
        let at = |folder: &str, url: &str, sock: &str| mounts::MountSpec { mountpoint: folder.into(), url: url.into(), sock: sock.into(), ..mounts::MountSpec::default() };
        s.mounts = vec![at("/m/zod", "https://zod.test", ""), at("/m/bus", "https://bus.test", ""), at("/m/local", "", "/pier/.urb/dev/lattice")];
        assert_eq!(ship_mounts(&s, false).iter().map(|m| m.mountpoint.as_str()).collect::<Vec<_>>(), ["/m/zod"], "this ship's, and not one mounted by a socket");
        assert_eq!(ship_mounts(&s, true).len(), 2, "every ship's over HTTP");
        sign_out_asked(&mut s, false);
        assert!(matches!(s.prompt, Some(Prompt::ShipOut(false))) && s.conn.is_some(), "asked first, and still signed in");
        s.prompt = None;
        s.mounts.remove(0);
        sign_out_asked(&mut s, true);
        assert!(matches!(s.prompt, Some(Prompt::ShipOut(true))), "another ship's folder is asked about when every ship is signed out of");
    }

    #[test]
    fn an_export_passphrase_is_long_enough_and_typed_the_same_twice() {
        assert!(id_pass_ok("seven77", "seven77", 8).unwrap_err().contains("at least 8"));
        assert!(id_pass_ok("eight888", "eight889", 8).unwrap_err().contains("not the same"));
        assert_eq!(id_pass_ok("eight888", "eight888", 8), Ok(()));
        // letters are counted, not bytes
        assert_eq!(id_pass_ok("\u{e9}\u{e9}\u{e9}\u{e9}", "\u{e9}\u{e9}\u{e9}\u{e9}", 4), Ok(()));
    }

    #[test]
    fn a_comet_is_named_short_and_the_question_names_both() {
        assert_eq!(id_short("~sampel-palnet"), "~sampel-palnet");
        assert_eq!(id_short("~dozzod-dozzod-dozzod-dozzod--dozzod-dozzod-ricsul-bilwyt"), "~ricsul-bilwyt");
        let [first, second] = id_question(Some("~old"), "~new");
        assert!(first.contains("~old") && first.contains("~new") && first.contains("not deleted"));
        assert!(second.contains("Stop using ~new"));
        assert!(!id_question(None, "~new")[0].contains("Replace"));
    }

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
        // drawn as a web page unless asked otherwise: find has no words to mark there, and what is held back is what the page's thread counts
        assert!(web_page(&s).is_some());
        assert_eq!((find_where(&s), held_back(&s)), (FindIn::Nothing, 0));
        s.prefs.html_plain = true;
        assert!(web_page(&s).is_none());
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
        // a split of two, with the named page in the group that is not in front
        fn hold(s: &mut App, name: &str) {
            (s.tgroups, s.front_at) = (vec![TabGroup::default(), TabGroup { tabs: vec![Tab { trail: vec![name.to_owned()], at: 0 }], at: 0, view: None }], 0);
            sync_beside(s);
        }
        hold(&mut s, "budget");
        assert!(matches!(&s.tgroups[1].view, Some((n, 1, Beside::Sheet(sheets, 0, _))) if n == "budget" && sheets.len() == 2 && sheets[0].rows.len() == 4));
        // the sheet showing stays through a change to the page, and follows its text
        if let Some((_, _, Beside::Sheet(_, at, _))) = &mut s.tgroups[1].view {
            *at = 1;
        }
        let p = s.cache.get_mut("budget").unwrap();
        p.body = p.body.replace("Prices checked in November", "Checked again");
        p.rev = 2;
        sync_beside(&mut s);
        assert!(matches!(&s.tgroups[1].view, Some((_, 2, Beside::Sheet(sheets, 1, _))) if sheets[1].rows[0][0] == "Checked again"));
        // a map is its features, an HTML page is what it reads as, and Markdown needs nothing kept
        hold(&mut s, "places");
        assert!(matches!(&s.tgroups[1].view, Some((_, _, Beside::Map(feats))) if feats.len() == 4));
        s.cache.insert("page".into(), Page { name: "page".into(), body: "<h1>T</h1><script>x</script>".into(), kind: "html".into(), rev: 1 });
        hold(&mut s, "page");
        assert!(matches!(&s.tgroups[1].view, Some((_, _, Beside::Read(md))) if md == "# T\n"));
        hold(&mut s, "welcome");
        assert!(s.tgroups[1].view.is_none());
        // the group in front keeps none: its page is the window's own
        assert!(s.tgroups[0].view.is_none());
        // closing the split lets it all go
        hold(&mut s, "budget");
        toggle_split(&mut s);
        assert!(s.tgroups.is_empty());
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
    fn the_core_notice_shows_until_dismissed_and_again_for_a_new_rule() {
        let mut s = sample("welcome");
        assert!(!core_notice(&s));
        s.core_agents = vec!["rules/brief".into(), "rules/kind".into()];
        assert!(core_notice(&s));
        // dismissed for what is listed, it stays away while nothing new is
        s.prefs.core_seen = s.core_agents.clone();
        assert!(!core_notice(&s));
        s.core_agents.remove(0);
        assert!(!core_notice(&s));
        // another rule from a key brings it back, with every one listed
        s.core_agents.push("rules/new".into());
        assert!(core_notice(&s));
        // with no ship there is nothing to keep or untag
        core_rule(&mut s, "rules/new".into(), true);
        assert_eq!(s.core_agents.len(), 2);
    }

    #[test]
    fn a_boards_controls_are_what_this_ship_may_do_and_a_refusal_is_seen() {
        // on a board of one's own everything, as its host. On another ship's only what an author may
        assert_eq!(forum_may("chat", None, "~zod", "~bus"), ForumMay { pin: true, change: true });
        assert_eq!(forum_may("~nec/chat", None, "~zod", "~zod"), ForumMay { pin: false, change: true });
        assert_eq!(forum_may("~nec/chat", None, "~zod", "~bus"), ForumMay { pin: false, change: false });
        assert_eq!(forum_may("~nec/chat", None, "", ""), ForumMay { pin: false, change: false }, "no name known is no author");
        // the role the board's ship sends decides, wherever the board is
        assert_eq!(forum_may("~nec/chat", Some("mod"), "~zod", "~bus"), ForumMay { pin: true, change: true }, "a mod of another ship's board");
        assert_eq!(forum_may("~nec/chat", Some("poster"), "~zod", "~bus"), ForumMay { pin: false, change: false });
        assert_eq!(forum_may("~nec/chat", Some("reader"), "~zod", "~zod"), ForumMay { pin: false, change: true }, "an author still may");
        assert_eq!(forum_may("chat", Some("mod"), "~zod", "~bus"), ForumMay { pin: true, change: true });
        // whether the board did what was asked, read from the thread as it comes back
        let post = |up: u64, pinned: bool, tags: &[&str]| api::ForumPost { id: 1, up, pinned, tags: tags.iter().map(|t| (*t).to_owned()).collect(), ..api::ForumPost::default() };
        assert!(forum_took(&ForumAct::Vote, (2, 0), Some(&post(3, false, &[])), &[]) && !forum_took(&ForumAct::Vote, (2, 0), Some(&post(2, false, &[])), &[]));
        assert!(forum_took(&ForumAct::Pin(true), (0, 0), Some(&post(0, true, &[])), &[]) && !forum_took(&ForumAct::Pin(true), (0, 0), Some(&post(0, false, &[])), &[]));
        assert!(forum_took(&ForumAct::Tags(vec!["b".into(), "a".into()]), (0, 0), Some(&post(0, false, &["a", "b"])), &[]), "in whatever order the ship keeps them");
        assert!(!forum_took(&ForumAct::Tags(vec!["a".into()]), (0, 0), Some(&post(0, false, &[])), &[]));
        assert!(forum_took(&ForumAct::Delete(None), (0, 0), None, &[]) && !forum_took(&ForumAct::Delete(None), (0, 0), Some(&post(0, false, &[])), &[]));
        assert!(forum_took(&ForumAct::Delete(Some(4)), (0, 0), Some(&post(0, false, &[])), &[3, 5]) && !forum_took(&ForumAct::Delete(Some(4)), (0, 0), Some(&post(0, false, &[])), &[3, 4]));
        // a board of this ship's says so. One elsewhere is not yet known to have refused
        assert!(forum_taken("chat", false).unwrap_err().contains("did not take that"));
        assert_eq!((forum_taken("chat", true), forum_taken("~nec/chat", false)), (Ok(()), Ok(())));
    }

    #[test]
    fn a_threads_link_is_followed_only_when_it_is_one_to_follow() {
        assert_eq!(forum_link(Some(" https://example.com/x ")).as_deref(), Some("https://example.com/x"));
        assert_eq!(forum_link(Some("urb://~nec/notes")).as_deref(), Some("urb://~nec/notes"));
        for no in [None, Some(""), Some("javascript:alert(1)"), Some("file:///etc/passwd"), Some("example.com")] {
            assert_eq!(forum_link(no), None, "{no:?}");
        }
    }

    #[test]
    fn a_boards_tags_are_found_and_offered_as_a_threads_are_typed() {
        let all: Vec<(String, usize)> = (0..40).map(|i| (format!("tag{i:02}"), 100 - i)).chain([("bug-report".to_owned(), 2), ("debug".to_owned(), 1)]).collect();
        // thirty until one is looked for, then every tag that holds what is typed
        assert_eq!(forum_tags_shown(&all, "", &[]).len(), 30);
        assert_eq!(forum_tags_shown(&all, " #BUG ", &[]).iter().map(|t| t.0.as_str()).collect::<Vec<_>>(), ["bug-report", "debug"]);
        // one that is picked stays to be let go, though it is past the thirty or not what is looked for
        assert!(forum_tags_shown(&all, "", &["debug".into()]).contains(&("debug".to_owned(), 1)));
        assert_eq!(forum_tags_shown(&all, "bug-r", &["tag00".into()]).iter().map(|t| t.0.as_str()).collect::<Vec<_>>(), ["bug-report", "tag00"]);
        assert!(forum_tags_shown(&[], "x", &[]).is_empty());
        // while a thread's tags are typed: those that hold the word being typed, without the ones had
        assert_eq!(tag_suggest(&all, "bug"), ["bug-report", "debug"]);
        assert_eq!(tag_suggest(&all, "debug, bu"), ["bug-report"], "what is typed already is not offered again");
        assert_eq!(tag_suggest(&all, "").len(), 8, "the most used, before anything is typed");
        assert_eq!(tag_suggest(&all, "tag00 ")[0], "tag01", "after a space a new word begins");
        assert!(tag_suggest(&all, "a b c d e f").is_empty(), "five are all a thread carries");
        assert!(tag_suggest(&all, "debug").iter().all(|t| t != "debug"), "a tag typed whole needs no offer");
        assert_eq!(tag_complete("debug, bu", "bug-report"), "debug, bug-report ");
        assert_eq!(tag_complete("bu", "bug-report"), "bug-report ");
        assert_eq!(tag_complete("debug ", "ui"), "debug ui ");
        assert_eq!(tag_complete("", "ui"), "ui ");
    }

    #[test]
    fn the_forum_orders_threads_steps_back_and_gives_way_to_a_page() {
        let post = |id: u64, created: &str, active: &str, up: u64, pinned: bool| api::ForumPost { id, created: created.into(), active: active.into(), up, pinned, ..api::ForumPost::default() };
        let posts = [post(1, "~2026.11.1", "~2026.11.9", 5, false), post(2, "~2026.11.2", "~2026.11.2", 1, false), post(3, "~2026.10.1", "~2026.10.1", 0, true), post(4, "~2026.11.3", "~2026.11.3", 9, false)];
        let ids = |sort| forum_sorted(&posts, sort, 0).into_iter().map(|p| p.id).collect::<Vec<_>>();
        // the pinned thread is first whatever the order, then newest, latest spoken in, or most points
        assert_eq!(ids(ForumSort::New), [3, 4, 2, 1]);
        assert_eq!(ids(ForumSort::Active), [3, 1, 4, 2]);
        assert_eq!(ids(ForumSort::Top), [3, 4, 1, 2]);
        // dates are compared as moments: as text the 9th came after the 10th, and at 9 o'clock after 10
        let dated = [post(1, "~2026.11.9..9.0.0", "~2026.11.9..9.0.0", 0, false), post(2, "~2026.11.10..8.0.0", "~2026.11.9..10.0.0", 0, false)];
        let order = |sort| forum_sorted(&dated, sort, 0).into_iter().map(|p| p.id).collect::<Vec<_>>();
        assert_eq!((order(ForumSort::New), order(ForumSort::Active)), (vec![2, 1], vec![2, 1]));
        // hot, the order a board opens in: votes over the square of the hours since and two more
        assert!(ForumSort::default() == ForumSort::Hot);
        let now = api::da_secs("~2026.11.20..12.0.0").unwrap();
        let hot = [
            post(1, "~2026.11.20..11.0.0", "", 3, false),  // an hour old, 3 points: 3/9
            post(2, "~2026.11.19..12.0.0", "", 40, false), // a day old, 40 points: 40/676
            post(3, "~2026.11.20..2.0.0", "", 30, false),  // ten hours old, 30 points: 30/144
            post(4, "~2026.11.20..11.30.0", "", 0, false), // new, no points
            post(5, "~2026.11.20..10.0.0", "", 0, false),  // older, no points
            post(6, "~2026.11.1..0.0.0", "", 1, true),     // pinned
        ];
        assert_eq!(forum_sorted(&hot, ForumSort::Hot, now).into_iter().map(|p| p.id).collect::<Vec<_>>(), [6, 1, 3, 2, 4, 5]);
        let down = api::ForumPost { up: 1, down: 5, created: "~2026.11.20..11.0.0".into(), ..api::ForumPost::default() };
        assert_eq!(hot_score(&down, now), (0, 9), "voted under nothing counts as nothing, as on the ship");
        let mut s = sample("welcome");
        go_forum(&mut s);
        assert!(s.forum.as_ref().is_some_and(|f| f.boards.as_ref().is_some_and(Vec::is_empty)), "with no ship there are no boards, and it says so");
        // back from a thread is its board, back from a board is the boards
        let f = s.forum.as_mut().unwrap();
        f.board = Some(api::Board { board: "general".into(), ..api::Board::default() });
        f.thread = Some(api::Thread::default());
        forum_back(&mut s);
        assert!(s.forum.as_ref().is_some_and(|f| f.thread.is_none() && f.board.is_some()));
        forum_back(&mut s);
        assert!(s.forum.as_ref().is_some_and(|f| f.board.is_none()));
        // a page opened, or the inbox, takes the forum's place
        open_page(&mut s, "notes/today");
        assert!(s.forum.is_none());
        go_forum(&mut s);
        go_inbox(&mut s);
        assert!(s.forum.is_none() && s.inbox);
        go_forum(&mut s);
        assert!(s.forum.is_some() && !s.inbox);
    }

    #[test]
    fn a_thread_is_not_sent_without_a_title_or_with_what_is_not_a_tag() {
        let mut s = sample("welcome");
        go_forum(&mut s);
        let f = s.forum.as_mut().unwrap();
        f.board = Some(api::Board { board: "general".into(), ..api::Board::default() });
        f.draft = Some(Box::new([TextEdit::new(""), TextEdit::new(""), TextEdit::new(""), TextEdit::new("")]));
        draft_field(&mut s, 2).text = "some text".into();
        forum_submit(&mut s);
        assert_eq!(s.note, "a thread needs a title");
        draft_field(&mut s, 0).text = "A title".into();
        draft_field(&mut s, 3).text = "fine Not-Fine".into();
        forum_submit(&mut s);
        assert!(s.note.starts_with("Not-Fine is not a tag"), "{}", s.note);
        // what was written is still there to be put right, and nothing is on its way
        let f = s.forum.as_ref().unwrap();
        assert!(!f.sending && f.draft.as_ref().is_some_and(|d| d[2].text == "some text"));
        // a comment with nothing in it is not sent either
        s.forum.as_mut().unwrap().thread = Some(api::Thread { board: "general".into(), ..api::Thread::default() });
        s.forum.as_mut().unwrap().comment.text = "  \n".into();
        forum_comment(&mut s);
        assert_eq!(s.note, "there is nothing written to send");
    }

    #[test]
    fn a_boards_tags_are_counted_and_a_threads_tags_are_checked_before_they_are_sent() {
        let post = |id: u64, tags: &[&str]| api::ForumPost { id, tags: tags.iter().map(|t| (*t).to_owned()).collect(), ..api::ForumPost::default() };
        let posts = [post(1, &["bug", "ui"]), post(2, &["bug"]), post(3, &[]), post(4, &["idea", "bug"]), post(5, &["ui"])];
        // most used first, then by name
        assert_eq!(forum_board_tags(&posts), [("bug".to_owned(), 3), ("ui".to_owned(), 2), ("idea".to_owned(), 1)]);
        assert!(forum_board_tags(&[]).is_empty());
        let mut s = sample("welcome");
        go_forum(&mut s);
        s.forum.as_mut().unwrap().thread = Some(api::Thread { board: "general".into(), ..api::Thread::default() });
        // tags that are not tags are said, and the prompt stays open on what was typed
        let mut t = TextEdit::new("");
        t.text = "ok Not-Ok".into();
        s.prompt = Some(Prompt::ForumTags(t));
        confirm(&mut s);
        assert!(s.note.starts_with("Not-Ok is not a tag"));
        assert!(matches!(&s.prompt, Some(Prompt::ForumTags(t)) if t.text == "ok Not-Ok"));
        // leaving a board lets its tag filter go
        let f = s.forum.as_mut().unwrap();
        (f.thread, f.board, f.tags) = (None, Some(api::Board::default()), vec!["bug".into()]);
        forum_back(&mut s);
        assert!(s.forum.as_ref().unwrap().tags.is_empty());
    }

    #[test]
    fn the_refusals_open_from_the_boards_and_back_leaves_them() {
        let mut s = sample("welcome");
        go_forum(&mut s);
        let f = s.forum.as_mut().unwrap();
        f.notes = Some(vec![("your role on this board cannot post".into(), "~nec/general, 2 minutes ago".into())]);
        f.notes_open = true;
        // back from the refusals is the boards, with nothing else let go
        f.board = None;
        forum_back(&mut s);
        let f = s.forum.as_ref().unwrap();
        assert!(!f.notes_open && f.notes.as_ref().is_some_and(|n| n.len() == 1));
        // with no ship there is nothing to clear, and nothing is lost by asking
        forum_notes_clear(&mut s);
        assert!(s.forum.as_ref().unwrap().notes.is_some());
    }

    #[test]
    fn a_board_is_not_made_with_a_bad_name_no_title_or_a_name_taken() {
        let mut s = sample("welcome");
        go_forum(&mut s);
        let f = s.forum.as_mut().unwrap();
        f.boards = Some(vec![api::Board { board: "general".into(), ..api::Board::default() }]);
        f.making = Some((Box::new([TextEdit::new(""), TextEdit::new(""), TextEdit::new("")]), "poster"));
        for (name, title, why) in [("Bad Name", "T", "a board's name is lowercase letters, digits and hyphens, starting with a letter"), ("2x", "T", "a board's name is lowercase letters, digits and hyphens, starting with a letter"), ("fine", " ", "a board needs a title"), ("general", "T", "there is already a board by that name")] {
            making_field(&mut s, 0).text = name.into();
            making_field(&mut s, 1).text = title.into();
            forum_make(&mut s);
            assert_eq!(s.note, why, "{name}");
        }
        // what was written is still there, and nothing is on its way
        let f = s.forum.as_ref().unwrap();
        assert!(!f.sending && f.making.is_some());
        // a board's title is not saved empty
        let f = s.forum.as_mut().unwrap();
        f.board = Some(api::Board { board: "general".into(), title: "General".into(), ..api::Board::default() });
        f.editing = Some(Box::new([TextEdit::new(""), TextEdit::new("")]));
        s.note.clear();
        forum_change(&mut s, false);
        assert_eq!(s.note, "a board needs a title");
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
        // an edit does not hold the switch: it is left for it
        open_page(&mut s, "welcome");
        start_edit(&mut s);
        flip(&mut s);
        assert!(s.memory && !s.editing);
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
        // the pane is open from the start, on the links that go out
        assert!(s.inspector.is_open() && s.pane == rpane::Tab::Out);
        pane_tab(&mut s, rpane::Tab::Back);
        assert_eq!(s.pane, rpane::Tab::Back);
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
        // the links command, with the links showing, closes the pane
        show_pane(&mut s, rpane::Tab::Out);
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
    fn vim_keys_edit_the_source_and_the_editors_undo_takes_them_back() {
        let mut s = sample("welcome");
        s.prefs.vim = true;
        start_edit(&mut s);
        s.edit = TextEdit::new("one two\nthr\u{e9}e four\nfive\n");
        s.rich = false;
        vim_start(&mut s);
        let keys = |s: &mut App, typed: &str| {
            for ch in typed.chars() {
                let ev = KeyEvent { key: if ch == '\u{1b}' { Key::Escape } else { Key::Text(ch.to_string()) }, mods: rune::Mods::default() };
                // a key vim does not take is typed, as the editor types it
                if !vim_take(s, &ev) {
                    s.edit.insert(&ch.to_string());
                }
            }
        };
        // a line deleted, a word changed past a character of two bytes, and the cursor left on a character
        keys(&mut s, "jdd");
        assert_eq!(s.edit.text, "one two\nfive\n");
        keys(&mut s, "ggwcwdeux\u{1b}");
        assert_eq!((s.edit.text.as_str(), s.vim.indicator().as_str()), ("one deux\nfive\n", "-- NORMAL --"));
        assert_eq!((s.edit.anchor, s.edit.focus), (7, 7), "on the last character typed");
        // u is the editor's own undo and Ctrl-R its redo: an edit made in normal mode is one step
        keys(&mut s, "0x");
        assert_eq!(s.edit.text, "ne deux\nfive\n");
        keys(&mut s, "u");
        assert_eq!(s.edit.text, "one deux\nfive\n");
        assert!(vim_take(&mut s, &KeyEvent { key: Key::Command('r'), mods: rune::Mods { ctrl: true, ..rune::Mods::default() } }));
        assert_eq!(s.edit.text, "ne deux\nfive\n");
        keys(&mut s, "u");
        // visual selects through the character under the cursor
        keys(&mut s, "0ve");
        assert_eq!((s.vim.indicator().as_str(), s.edit.anchor.min(s.edit.focus), s.edit.anchor.max(s.edit.focus)), ("-- VISUAL --", 0, 3));
        // :w saves and the editor stays open
        keys(&mut s, "\u{1b}:w");
        assert!(vim_take(&mut s, &KeyEvent { key: Key::Enter, mods: rune::Mods::default() }));
        assert!(s.editing && s.cache["welcome"].body == "one deux\nfive\n", "{:?}", s.cache["welcome"].body);
        // with vim off the keys are the editor's
        s.prefs.vim = false;
        assert!(!editor_key_plain(&mut s, "j"));
    }

    /// Whether the editor's key handler took a typed character.
    fn editor_key_plain(s: &mut App, ch: &str) -> bool {
        s.prefs.vim && !s.rich && vim_take(s, &KeyEvent { key: Key::Text(ch.into()), mods: rune::Mods::default() })
    }

    #[test]
    fn the_web_clients_chords_are_read_as_what_they_do_here() {
        let mut s = sample("welcome");
        let m = rune::Mods::default();
        let cmd = |c: char, shift: bool| KeyEvent { key: Key::Command(c), mods: rune::Mods { cmd: true, ctrl: true, shift, ..m } };
        assert_eq!([chord(&s, &cmd('k', false)), chord(&s, &cmd('p', false))], [Some(Chord::Palette); 2]);
        assert_eq!([chord(&s, &cmd('o', false)), chord(&s, &cmd('f', true))], [Some(Chord::Jump), Some(Chord::Search)]);
        assert_eq!(chord(&s, &cmd('f', false)), None, "plain Ctrl+F is find in the page, handled as before");
        // the split's keys: down, and round the groups either way. A shifted key may come as either of its two characters
        assert_eq!([chord(&s, &cmd('\\', true)), chord(&s, &cmd('|', true))], [Some(Chord::SplitDown); 2]);
        assert_eq!([chord(&s, &cmd(']', true)), chord(&s, &cmd('}', true))], [Some(Chord::Group(true)); 2]);
        assert_eq!([chord(&s, &cmd('[', true)), chord(&s, &cmd('{', true))], [Some(Chord::Group(false)); 2]);
        assert_eq!(chord(&s, &cmd('[', false)), None, "unshifted, it is vim's own Escape and nothing here");
        assert_eq!((chord(&s, &cmd(',', false)), chord(&s, &cmd('l', true)), chord(&s, &cmd('\\', false))), (Some(Chord::Settings), Some(Chord::Files), Some(Chord::Split)));
        // Delete asks about the page showing, and only with nothing else open to type into
        let del = KeyEvent { key: Key::Delete, mods: m };
        assert_eq!(chord(&s, &del), Some(Chord::Delete));
        s.prompt = Some(Prompt::Delete("welcome".into()));
        assert_eq!(chord(&s, &del), None);
        s.prompt = None;
        // one tab: nothing to go round. Two: forward, and back with Shift
        let tab = |shift| KeyEvent { key: Key::Tab, mods: rune::Mods { ctrl: true, shift, ..m } };
        assert_eq!(chord(&s, &tab(false)), None);
        new_tab(&mut s);
        assert_eq!((chord(&s, &tab(false)), chord(&s, &tab(true))), (Some(Chord::Tab(true)), Some(Chord::Tab(false))));
        assert_eq!(chord(&s, &KeyEvent { key: Key::Tab, mods: m }), None, "a plain Tab is the focus's");
        // editing: the commands and the tabs wait, and Ctrl+E goes back to reading
        open_page(&mut s, "welcome");
        start_edit(&mut s);
        assert_eq!([chord(&s, &cmd('k', false)), chord(&s, &cmd('o', false)), chord(&s, &cmd(',', false)), chord(&s, &tab(false)), chord(&s, &del)], [None; 5]);
        assert_eq!(chord(&s, &cmd('e', false)), Some(Chord::Read));
        // with vim on, in its editor, the chord is vim's
        (s.prefs.vim, s.rich) = (true, false);
        assert_eq!(chord(&s, &cmd('e', false)), None);
    }

    #[test]
    fn the_editors_font_is_the_one_chosen_and_the_apps_own_otherwise() {
        let k = Kit::neutral(true);
        assert!(editor_family("").is_none() && editor_family("something else").is_none());
        assert!(matches!(editor_family("mono"), Some(rune::Family::SystemMono)));
        // every choice offered has a family, but the app's own
        for (pref, _) in EDITOR_FONTS.iter().skip(1) {
            assert!(editor_family(pref).is_some(), "{pref}");
        }
        assert!(matches!(editor_kit(&k, "serif").ty.ui.family, rune::Family::Named(n) if n.starts_with("Georgia")));
        // only the family changes: the size and the rest are the app's
        assert_eq!(editor_kit(&k, "serif").ty.ui.size, k.ty.ui.size);
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
        // switching while editing leaves the editor, with what was typed kept
        start_edit(&mut s);
        if s.rich {
            flip_mode(&mut s);
        }
        s.edit.text.push_str("\ntyped and left");
        switch_tab(&mut s, 0);
        assert_eq!((s.tab, s.editing, open(&s).as_deref()), (0, false, Some("welcome")));
        assert!(s.cache["notes/today"].body.ends_with("\ntyped and left"));
        switch_tab(&mut s, 1);
        assert!(s.open.as_ref().is_some_and(|p| p.body.ends_with("\ntyped and left")));
        assert_eq!((s.tab, s.tabs.len()), (1, 2));
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
    fn a_tab_goes_from_the_group_in_front_to_another_group() {
        let pages = |s: &App, d: usize| s.tgroups[d].tabs.iter().map(|t| t.page().unwrap_or("").to_owned()).collect::<Vec<_>>();
        let open = |s: &App| s.open.as_ref().map(|p| p.name.clone());
        let mut s = sample("welcome");
        new_tab(&mut s);
        open_page(&mut s, "budget");
        new_tab(&mut s);
        open_page(&mut s, "places");
        toggle_split(&mut s);
        assert_eq!((s.tabs.len(), s.tab, pages(&s, 1)), (3, 2, vec!["places".to_owned()]));
        // a tab that is not in front goes over: the front keeps its page, and the other group shows the one that came
        move_tab_to_group(&mut s, 0, 1, None);
        assert_eq!((s.tabs.len(), s.tab, open(&s)), (2, 1, Some("places".to_owned())));
        assert_eq!((pages(&s, 1), s.tgroups[1].at), (vec!["places".to_owned(), "welcome".to_owned()], 1));
        // the tab in front goes over: its neighbour comes to the front
        move_tab_to_group(&mut s, 1, 1, None);
        assert_eq!((s.tabs.len(), s.tab, open(&s)), (1, 0, Some("budget".to_owned())));
        assert_eq!((pages(&s, 1), s.tgroups[1].at), (vec!["places".to_owned(), "welcome".to_owned(), "places".to_owned()], 2));
        // the last tab stays: the group in front is never left with none
        move_tab_to_group(&mut s, 0, 1, None);
        assert_eq!((s.tabs.len(), open(&s)), (1, Some("budget".to_owned())));
        // nor does a tab go to the group it is in, or to one that is not there
        new_tab(&mut s);
        open_page(&mut s, "region");
        move_tab_to_group(&mut s, 0, 0, None);
        move_tab_to_group(&mut s, 0, 7, None);
        assert_eq!(s.tabs.len(), 2);
        // let go among the other group's tabs, it goes between them
        move_tab_to_group(&mut s, 0, 1, Some(1));
        assert_eq!((pages(&s, 1), s.tgroups[1].at), (vec!["places".to_owned(), "budget".to_owned(), "welcome".to_owned(), "places".to_owned()], 1));
        open_page(&mut s, "welcome");
        // an empty tab has nothing to show there, and stays
        new_tab(&mut s);
        let empty = s.tab;
        move_tab_to_group(&mut s, empty, 1, None);
        assert_eq!((s.tabs.len(), pages(&s, 1).len()), (2, 4));
    }

    #[test]
    fn a_tab_of_a_group_that_is_not_in_front_is_moved_too() {
        let pages = |s: &App, d: usize| s.tgroups[d].tabs.iter().map(|t| t.page().unwrap_or("").to_owned()).collect::<Vec<_>>();
        let front = |s: &App| (0..s.tabs.len()).map(|i| tab_label(s, i)).collect::<Vec<_>>();
        let mut s = sample("welcome");
        new_tab(&mut s);
        open_page(&mut s, "budget");
        // three groups: the front with two tabs, then one holding places, then one holding region
        open_page(&mut s, "region");
        split_press(&mut s, false);
        open_page(&mut s, "places");
        split_press(&mut s, false);
        open_page(&mut s, "budget");
        assert_eq!((front(&s), pages(&s, 1), pages(&s, 2)), (vec!["welcome".to_owned(), "budget".to_owned()], vec!["places".to_owned()], vec!["region".to_owned()]));
        // from one group to another: it goes to the end and is the one shown. A group left with none is gone
        move_group_tab(&mut s, 1, 0, 2, None);
        assert_eq!((s.tgroups.len(), pages(&s, 1), s.tgroups[1].at), (2, vec!["region".to_owned(), "places".to_owned()], 1));
        // along its own strip: the one showing is followed
        reorder_group_tab(&mut s, 1, 1, 0);
        assert_eq!((pages(&s, 1), s.tgroups[1].at), (vec!["places".to_owned(), "region".to_owned()], 0));
        // to the group in front, let go between its two tabs: it goes there and comes forward
        move_group_tab(&mut s, 1, 1, 0, Some(1));
        assert_eq!((front(&s), s.tab, s.open.as_ref().map(|p| p.name.clone())), (vec!["welcome".to_owned(), "region".to_owned(), "budget".to_owned()], 1, Some("region".to_owned())));
        assert_eq!(pages(&s, 1), ["places"]);
        // the last tab of the last other group going to the front ends the split
        move_group_tab(&mut s, 1, 0, 0, None);
        assert!(s.tgroups.is_empty());
        assert_eq!(front(&s), ["welcome", "region", "budget", "places"]);
        // not to where it is
        toggle_split(&mut s);
        move_group_tab(&mut s, 1, 0, 1, None);
        assert_eq!((s.tgroups.len(), s.tabs.len()), (2, 4));
    }

    #[test]
    fn the_keys_go_round_the_groups_and_split_down() {
        let open = |s: &App| s.open.as_ref().map(|p| p.name.clone()).unwrap_or_default();
        let mut s = sample("welcome");
        // with no split there is nowhere to go
        turn_group(&mut s, true);
        assert_eq!((open(&s), s.tgroups.len()), ("welcome".to_owned(), 0));
        split_press(&mut s, false);
        open_page(&mut s, "budget");
        split_press(&mut s, false);
        open_page(&mut s, "places");
        // three groups stand as places (in front), budget, welcome
        turn_group(&mut s, true);
        assert_eq!((open(&s), s.front_at), ("budget".to_owned(), 1));
        turn_group(&mut s, true);
        assert_eq!((open(&s), s.front_at), ("welcome".to_owned(), 2));
        turn_group(&mut s, true);
        assert_eq!((open(&s), s.front_at), ("places".to_owned(), 0), "round to the first");
        turn_group(&mut s, false);
        assert_eq!((open(&s), s.front_at), ("welcome".to_owned(), 2), "and back round the other way");
        // over an edit too: it is left
        start_edit(&mut s);
        turn_group(&mut s, false);
        assert_eq!((s.front_at, s.editing), (1, false));
    }

    #[test]
    fn a_split_made_again_adds_a_group_and_each_keeps_its_place() {
        // what each group shows, in the order they stand, with the one in front marked
        let stand = |s: &App| (0..s.tgroups.len()).map(|d| if d == s.front_at { format!("*{}", s.open.as_ref().map_or("", |p| p.name.as_str())) } else { s.tgroups[d].page().unwrap_or("").to_owned() }).collect::<Vec<_>>();
        let mut s = sample("welcome");
        split_press(&mut s, false);
        assert_eq!(stand(&s), ["*welcome", "welcome"]);
        open_page(&mut s, "budget");
        // the same button again adds a third group, beside the one in front
        split_press(&mut s, false);
        assert_eq!(stand(&s), ["*budget", "budget", "welcome"]);
        open_page(&mut s, "places");
        // the last group comes to the front where it stands, and the others stay where they are
        focus_group(&mut s, 2, 0);
        assert_eq!(stand(&s), ["places", "budget", "*welcome"]);
        // the middle one's sheet is read for it, and the first one's map, each kept with its own group
        assert!(matches!(&s.tgroups[1].view, Some((n, _, Beside::Sheet(..))) if n == "budget"));
        assert!(matches!(&s.tgroups[0].view, Some((n, _, Beside::Map(_))) if n == "places"));
        // a group whose last tab is closed is gone, and the rest close up
        close_group_tab(&mut s, 1, 0);
        assert_eq!(stand(&s), ["places", "*welcome"]);
        // the other button turns the groups round, and adds none
        split_press(&mut s, true);
        assert_eq!((stand(&s), s.split_down), (vec!["places".to_owned(), "*welcome".to_owned()], true));
        split_press(&mut s, false);
        assert_eq!((stand(&s).len(), s.split_down), (2, false));
        // each new group stands after the one in front, with half its share
        split_press(&mut s, false);
        split_press(&mut s, false);
        assert_eq!((stand(&s).len(), s.front_at), (4, 1));
        let want = [1.0 / 3.0, 1.0 / 6.0, 1.0 / 6.0, 1.0 / 3.0];
        assert!(s.group_share.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-5), "{:?}", s.group_share);
        // a fifth group is refused
        split_press(&mut s, false);
        assert_eq!((s.tgroups.len(), s.note.as_str()), (4, "Four groups is the most there can be"));
        // a group gone leaves its room to the rest
        close_group(&mut s, 3);
        close_group(&mut s, 2);
        assert_eq!((s.tgroups.len(), s.front_at), (2, 1));
        assert!((s.group_share[0] - 2.0 / 3.0).abs() < 1e-5 && (s.group_share[1] - 1.0 / 3.0).abs() < 1e-5, "{:?}", s.group_share);
        s.split_down = false;
        toggle_split(&mut s);
        assert!(s.tgroups.is_empty() && s.front_at == 0 && split_page(&s).is_none());
    }

    #[test]
    fn the_group_beside_keeps_its_own_tabs_and_comes_to_the_front_whole() {
        // the pages of the tabs of the group standing at `d`
        let pages = |s: &App, d: usize| s.tgroups[d].tabs.iter().map(|t| t.page().unwrap_or("").to_owned()).collect::<Vec<_>>();
        let open = |s: &App| s.open.as_ref().map(|p| p.name.clone());
        let mut s = sample("welcome");
        new_tab(&mut s);
        open_page(&mut s, "budget");
        // the front has two tabs. Splitting holds the page in front beside, as a group of one tab
        toggle_split(&mut s);
        assert_eq!((pages(&s, 1), s.front_at), (vec!["budget".to_owned()], 0));
        open_page(&mut s, "places");
        // the group beside comes to the front whole, and the one that was in front stays where it stood, with both its tabs
        turn_group(&mut s, true);
        assert_eq!((open(&s), s.tabs.len(), s.tab), (Some("budget".to_owned()), 1, 0));
        assert_eq!((pages(&s, 0), s.tgroups[0].at), (vec!["welcome".to_owned(), "places".to_owned()], 1));
        assert_eq!(split_page(&s), Some("places"), "its front tab is the page it shows");
        assert_eq!(s.front_at, 1, "each group stays in its place: the one in front is now the second");
        // a press on a tab of the other group brings that group to the front on that tab
        focus_group(&mut s, 0, 0);
        assert_eq!((open(&s), s.tabs.len(), s.tab), (Some("welcome".to_owned()), 2, 0));
        assert_eq!((pages(&s, 1), s.front_at), (vec!["budget".to_owned()], 0));
        // the tab that went beside in the middle of its history comes back with it
        switch_tab(&mut s, 1);
        assert_eq!(open(&s), Some("places".to_owned()));
        step(&mut s, -1);
        assert_eq!(open(&s), Some("budget".to_owned()), "back still goes to where that tab had been");
        // closing the last tab beside ends the split
        close_group_tab(&mut s, 1, 0);
        assert!(s.tgroups.is_empty() && s.front_at == 0 && split_page(&s).is_none());
        // an edit in front is left for the group pressed
        toggle_split(&mut s);
        start_edit(&mut s);
        focus_group(&mut s, 1, 0);
        assert_eq!((s.front_at, s.editing), (1, false));
    }

    #[test]
    fn a_page_is_held_beside_another_and_swapped_to_the_front() {
        let mut s = sample("welcome");
        toggle_split(&mut s);
        assert_eq!(split_page(&s), Some("welcome"));
        open_page(&mut s, "budget");
        assert_eq!(split_page(&s), Some("welcome"), "it stays while the front changes");
        turn_group(&mut s, true);
        assert_eq!((s.open.as_ref().map(|p| p.name.as_str()), split_page(&s)), (Some("welcome"), Some("budget")));
        // while editing too: an edit nothing was typed into is let go, and the other group comes forward
        start_edit(&mut s);
        turn_group(&mut s, true);
        assert_eq!((s.open.as_ref().map(|p| p.name.as_str()), s.editing), (Some("budget"), false));
        turn_group(&mut s, true);
        assert_eq!(s.prefs.split, "budget", "what is held is kept for the next run");
        // the same press lets go of it
        toggle_split(&mut s);
        assert_eq!((split_page(&s), s.prefs.split.as_str()), (None, ""));
        // nothing to hold with no page in front
        s.open = None;
        toggle_split(&mut s);
        assert_eq!(split_page(&s), None);
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
        // while a page is being edited too: the editor is left for it
        start_edit(&mut s);
        upload(&mut s, vec![root.join("Trip")]);
        assert!(!s.editing);
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

    #[test]
    fn the_window_wears_the_theme_the_ship_says_and_the_mode_only_without_one() {
        use serde_json::json;
        let hex = |c: rune::Color| c.hex()[..7].to_owned();
        let mut p = api::Prefs { theme: "light".into(), ..api::Prefs::default() };
        // no theme: the built-in look, as the mode picked says
        assert_eq!(hex(kit_of(&p, true).c.bg_base), hex(Kit::neutral(false).c.bg_base));
        let night = json!({ "id": "a", "name": "Night", "dark": true, "primary": "#8AB4F8", "secondary": "#C58AF9", "tertiary": "#78D9EC", "background": "#101418", "surface": "#1B2026", "link": "", "raised": "#2A3038", "error": "#FF6B6B" });
        p.worn.talon = json!({ "themes": [night], "activeId": "a" });
        let k = kit_of(&p, false);
        // the theme's own dark ground, though the mode says light
        assert_eq!([hex(k.c.bg_base), hex(k.c.bg_accent), hex(k.c.bg_contrast), hex(k.c.text_accent)], ["#1b2026", "#8ab4f8", "#8ab4f8", "#2962ff"]);
        assert_eq!([hex(k.c.layer_01), hex(k.c.danger.fg)], ["#2a3038", "#ff6b6b"]);
        assert_eq!(hex(k.c.text_contrast), "#1c1917", "ink on a light accent");
        // an accent alone is laid over the built-in look
        p.worn.talon = serde_json::Value::Null;
        p.worn.talon_accent = json!({ "enabled": true, "mode": "Custom", "customHex": "#5050FF" });
        let k = kit_of(&p, true);
        assert_eq!([hex(k.c.bg_base), hex(k.c.bg_contrast), hex(k.c.text_contrast)], [hex(Kit::neutral(false).c.bg_base), "#5050ff".into(), "#ffffff".into()]);
    }

    /// The sample pages with `name` open, and no ship.
    #[test]
    fn read_leaves_the_editor_at_once_and_sends_nothing_for_text_not_changed() {
        let mut s = sample("welcome");
        let (rev, body) = (s.open.as_ref().unwrap().rev, s.open.as_ref().unwrap().body.clone());
        start_edit(&mut s);
        assert!(s.editing);
        to_read(&mut s);
        assert!(!s.editing, "the reader is back with no wait");
        assert_eq!((s.open.as_ref().unwrap().rev, &s.open.as_ref().unwrap().body), (rev, &body), "and nothing was saved: the text is as it was");
        assert!(!s.save_req.is_pending() && !s.drain_req.is_pending() && !s.read_save);
        // text that changed is in the reader as soon as Read is pressed
        start_edit(&mut s);
        s.edit = TextEdit::new("changed text\n");
        to_read(&mut s);
        assert!(!s.editing);
        assert_eq!(s.open.as_ref().unwrap().body, "changed text\n");
    }

    #[test]
    fn a_comment_that_fails_keeps_its_text_and_a_refused_switch_goes_back() {
        let mut s = sample("welcome");
        // a post on its way: the text is there until the ship has it
        assert!(sync_draft(&mut s) && s.comment_for == "welcome");
        s.comment = TextEdit::new("my words");
        s.comment_sending = true;
        commented(&mut s, Err("500: no".into()));
        assert_eq!((s.comment.text.as_str(), s.comment_sending, s.note.as_str()), ("my words", false, "not done: 500: no"), "it did not go: the text stays and Post can be pressed again");
        s.comment_sending = true;
        commented(&mut s, Ok(Op::Posted("comment posted on welcome".into(), "welcome".into(), "my words".into())));
        assert_eq!((s.comment.text.as_str(), s.comment_sending), ("", false), "landed: only now is the field emptied");
        // what was typed while it was on its way is another comment, and stays
        s.comment = TextEdit::new("a second thought");
        commented(&mut s, Ok(Op::Posted("comment posted on welcome".into(), "welcome".into(), "my words".into())));
        assert_eq!(s.comment.text, "a second thought");
        // a switch the ship takes stands, and one it refuses goes back. Nothing else's failure touches it
        s.comments_on.insert("welcome".into(), false);
        s.comment_undo = Some(CommentUndo::On("welcome".into(), true));
        switched(&mut s, Ok("comments are off for welcome".into()));
        assert_eq!((s.comments_on.get("welcome"), &s.comment_undo), (Some(&false), &None));
        not_done(&mut s, "500: a rename refused");
        assert_eq!(s.comments_on.get("welcome"), Some(&false), "another action's failure is not this switch's");
        s.comments_on.insert("welcome".into(), true);
        s.comment_undo = Some(CommentUndo::On("welcome".into(), false));
        switched(&mut s, Err("500: no".into()));
        assert_eq!((s.comments_on.get("welcome"), &s.comment_undo), (Some(&false), &None));
    }

    #[test]
    fn a_comment_begun_on_one_page_is_not_in_the_field_of_another() {
        let mut s = sample("welcome");
        sync_draft(&mut s);
        s.comment = TextEdit::new("for my own page");
        open_page(&mut s, "notes/today");
        assert!(sync_draft(&mut s));
        assert_eq!((s.comment.text.as_str(), s.comment_for.as_str()), ("", "notes/today"));
        open_page(&mut s, "welcome");
        sync_draft(&mut s);
        assert_eq!(s.comment.text, "for my own page", "and it is there again on the way back");
        assert!(!sync_draft(&mut s), "nothing moves while the same page is in front");
    }

    #[test]
    fn another_ships_thread_belongs_to_the_page_it_was_read_with() {
        let mut s = sample("welcome");
        let m = |who: &str, body: &str| Comment { page: String::new(), id: String::new(), author: who.into(), when: "~2026.1.1".into(), body: body.into() };
        urb_got(&mut s, "urb://~nec/notes/a".into(), api::Urb::Page { ship: "~nec".into(), path: "notes/a".into(), kind: "md".into(), body: "# A\n".into(), comments: vec![m("~bus", "one"), m("~wex", "two")] });
        let t = thread_here(&s).expect("the page in front has its thread");
        assert_eq!((t.url.as_str(), t.ship.as_str(), t.page.as_str(), t.list.len(), t.all, &t.sent), ("urb://~nec/notes/a", "~nec", "notes/a", 2, false, &None));
        assert!(s.note.contains("2 comments"));
        // what was sent from here stays said across a read of the same address, and goes with another page
        s.thread.as_mut().unwrap().sent = Some(("mine".into(), true, 0));
        urb_got(&mut s, "urb://~nec/notes/a".into(), api::Urb::Page { ship: "~nec".into(), path: "notes/a".into(), kind: "md".into(), body: "# A\n".into(), comments: Vec::new() });
        assert_eq!(thread_here(&s).unwrap().sent, Some(("mine".into(), true, 0)));
        urb_got(&mut s, "urb://~nec/notes/b".into(), api::Urb::Page { ship: "~nec".into(), path: "notes/b".into(), kind: "md".into(), body: "# B\n".into(), comments: Vec::new() });
        assert_eq!(thread_here(&s).unwrap().sent, None);
        // one of this ship's own pages has no such thread
        open_page(&mut s, "welcome");
        assert!(thread_here(&s).is_none());
    }

    #[test]
    fn text_kept_at_the_old_revision_is_what_the_reader_draws() {
        let mut s = sample("welcome");
        s.open = Some(Page { name: "g".into(), body: "# Old\n".into(), kind: "gmi".into(), rev: 4 });
        sync_sheet(&mut s);
        assert!(read_md(&s, s.open.as_ref().unwrap()).unwrap().contains("Old"));
        // as a save kept on this device leaves it: new text, the revision the ship last gave
        s.open.as_mut().unwrap().body = "# New\n".into();
        sync_sheet(&mut s);
        assert!(read_md(&s, s.open.as_ref().unwrap()).unwrap().contains("Old"), "by revision alone it is not seen to have changed");
        let was = s.web.text;
        stale_views(&mut s, "g");
        sync_sheet(&mut s);
        assert!(read_md(&s, s.open.as_ref().unwrap()).unwrap().contains("New"));
        assert_eq!(s.web.text, was + 1, "and an HTML page is asked for again");
    }

    #[test]
    fn an_update_is_offered_once_tried_again_after_a_failure_and_not_offered_once_installed() {
        let offer = |v: &str| update::Offer { version: v.into(), notes: String::new(), file: Some(("u".into(), "s".into(), None)) };
        let mut s = sample("welcome");
        assert!(update_offered(&mut s.upd, offer("2.0.0")));
        assert!(!update_offered(&mut s.upd, offer("2.0.0")), "the same one again changes nothing");
        // a download that fails keeps the offer: Try again has something to try, and Dismiss does not put the version off
        s.upd.stage = UpdStage::Fetching;
        assert!(!update_offered(&mut s.upd, offer("2.0.1")), "not over a download");
        update_fetched(&mut s.upd, Err("the signature does not hold".into()));
        assert!(matches!(&s.upd.stage, UpdStage::Failed(e) if e.contains("2.0.0") && e.contains("does not hold")));
        assert_eq!(s.upd.offer, Some(offer("2.0.0")));
        update_later(&mut s);
        assert_eq!((&s.upd.stage, s.upd.offer.is_some(), s.upd.later.is_empty()), (&UpdStage::Idle, true, true));
        // installed: Later leaves it installed, and the next check does not offer it again
        s.upd.stage = UpdStage::Fetching;
        update_fetched(&mut s.upd, Ok(()));
        assert_eq!((&s.upd.stage, &s.upd.offer, s.upd.installed.as_deref()), (&UpdStage::Installed("2.0.0".into()), &None, Some("2.0.0")));
        assert!(!update_offered(&mut s.upd, offer("2.0.1")), "not over the word that one is installed");
        update_later(&mut s);
        assert_eq!(s.upd.stage, UpdStage::Idle);
        assert!(!update_offered(&mut s.upd, offer("2.0.0")), "what is installed is not offered");
        assert!(update_offered(&mut s.upd, offer("2.0.1")), "a later one is");
        // Later puts that version off for the run
        update_later(&mut s);
        assert!(!update_offered(&mut s.upd, offer("2.0.1")) && update_offered(&mut s.upd, offer("2.0.2")));
    }

    #[test]
    fn what_is_read_with_no_ship_is_listed_newest_first_and_counted() {
        let v = visit_noted(&[], "urb://~nec/a", "A", "~2026.11.19..1.0.0");
        let v = visit_noted(&v, "urb://~nec/b", "", "~2026.11.19..2.0.0");
        let v = visit_noted(&v, "urb://~nec/a", "", "~2026.11.19..3.0.0");
        assert_eq!(v.iter().map(|x| (x.url.as_str(), x.title.as_str(), x.hits)).collect::<Vec<_>>(), [("urb://~nec/a", "A", 2), ("urb://~nec/b", "", 1)], "read again it comes to the front, counted, and keeps the name it had");
        assert_eq!(v[0].last, "~2026.11.19..3.0.0");
        // the oldest go past the limit
        let mut many = Vec::new();
        for i in 0..ANON_VISITS + 20 {
            many = visit_noted(&many, &format!("urb://~nec/p{i}"), "", "");
        }
        assert_eq!((many.len(), many[0].url.as_str()), (ANON_VISITS, "urb://~nec/p219"));
        assert!(!many.iter().any(|x| x.url == "urb://~nec/p0"));
        // a page read with no ship is noted, and one read through a ship is not this list's
        let mut s = init();
        s.conn = None;
        (s.sample, s.anon) = (true, true);
        let page = |body: &str| api::Urb::Page { ship: "~nec".into(), path: "a".into(), kind: "md".into(), body: body.into(), comments: Vec::new() };
        urb_got(&mut s, "urb://~nec/a".into(), page("# Alpha\n"));
        urb_got(&mut s, "urb://~nec/a".into(), page("# Alpha\n"));
        assert_eq!(s.visits.iter().map(|x| (x.url.as_str(), x.title.as_str(), x.hits)).collect::<Vec<_>>(), [("urb://~nec/a", "Alpha", 2)]);
        assert!(s.visits[0].last.starts_with('~'));
        forget_visit(&mut s, Some("urb://~nec/a".into()));
        assert!(s.visits.is_empty());
        let mut signed = sample("welcome");
        urb_got(&mut signed, "urb://~nec/a".into(), page("# Alpha\n"));
        assert!(signed.visits.is_empty());
        // a page is called by its first heading
        assert_eq!(visit_title("md", "intro\n## The plan  \ntext"), "The plan");
        assert_eq!(visit_title("gmi", "# Gem\n=> x"), "Gem");
        assert_eq!((visit_title("md", "no heading"), visit_title("html", "# not a heading here")), (String::new(), String::new()));
    }

    #[test]
    fn a_link_in_another_ships_page_leads_to_an_address() {
        let to = |url: &str| remote_link("~nec", "notes/plan", url);
        assert_eq!(to("urb://~bud/x").as_deref(), Some("urb://~bud/x"));
        assert_eq!(to("trips").as_deref(), Some("urb://~nec/notes/trips"), "a name beside the page");
        assert_eq!(to("./trips/rome#food").as_deref(), Some("urb://~nec/notes/trips/rome"));
        assert_eq!(to("../index").as_deref(), Some("urb://~nec/index"));
        assert_eq!(to("/recipes/bread").as_deref(), Some("urb://~nec/recipes/bread"));
        assert_eq!(to("/apps/lattice/page/notes/other").as_deref(), Some("urb://~nec/notes/other"), "a link as lattice writes one to its own page");
        for web in ["https://example.com/x", "mailto:a@b.c", "#part", "", "//example.com/x"] {
            assert_eq!(to(web), None, "{web}");
        }
    }

    #[test]
    fn with_no_ship_nothing_pretends_to_be_written_and_a_late_read_is_not_shown() {
        let mut s = init();
        s.conn = None;
        (s.sample, s.anon) = (true, true);
        for write in [capture as fn(&mut App), open_today, ask_new, start_edit] {
            s.note.clear();
            write(&mut s);
            assert!(s.note.contains("needs a node") && s.open.is_none() && !s.editing && s.prompt.is_none());
        }
        // an answer for an asking that was let go is not shown
        s.anon_seq = 3;
        s.anon_reading = Some("urb://~nec/a".into());
        urb_cancel(&mut s);
        assert_eq!((s.anon_seq, &s.anon_reading), (4, &None));
        // and one that lands under an edit begun meanwhile leaves the edit alone
        let mut s = sample("welcome");
        start_edit(&mut s);
        urb_got(&mut s, "urb://~nec/a".into(), api::Urb::Page { ship: "~nec".into(), path: "a".into(), kind: "md".into(), body: "x".into(), comments: Vec::new() });
        assert!(s.editing && s.open.as_ref().unwrap().name == "welcome" && s.remote.is_none() && s.note.contains("an edit is open"));
    }

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
