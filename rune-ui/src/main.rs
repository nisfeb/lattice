//! lattice, drawn natively with Rune: an experiment beside the shipped desktop app.
//!
//! `LATTICE_URL=https://ship LATTICE_COOKIE=/path/to/cookie cargo run` opens a ship.
//! With neither set it opens on built-in sample pages, which is also what the
//! headless runs draw: `cargo run -- --snap out.png --scene reading`.

mod api;
mod md;

use std::collections::HashMap;

use api::{Conn, Node, Page};
use rune::{AppSpec, Block, Chrome, Cx, El, Key, KeyEvent, Latest, Mark, ScrollSpec, Span, TextEdit, Tx, Waker, col, el, row, text};
use rune_kit::shell::{self, PaneState, SplitView, Toolbar};
use rune_kit::syntax::{self, SyntaxTheme};
use rune_kit::{Button, ButtonVariant, ControlSize, Dialog, Divider, FileNode, FileTree, Kit, Markdown, Spinner, TextArea, TextInput, Tree, TreeItem, TreeModel};

type Files = TreeModel<FileNode<Node>>;

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
        cache: HashMap::new(),
        note: String::new(),
        names: Vec::new(),
        jump: None,
        jump_at: 0,
        tree_req: Latest::default(),
        page_req: Latest::default(),
        save_req: Latest::default(),
        conn,
    }
}

/// Opens the built-in pages, with no ship.
fn browse_sample(s: &mut App) {
    {
        s.sample = true;
        s.cache = SAMPLE.iter().map(|(p, b)| ((*p).to_owned(), Page { name: (*p).into(), body: (*b).into(), kind: "md".into(), rev: 1 })).collect();
        s.names = SAMPLE.iter().map(|(p, _)| (*p).to_owned()).collect();
        s.files = files_of(sample_nodes(), &Files::default());
        s.files.expand_all();
        s.note = "sample pages, kept only while the window is open".into();
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
    match s.conn.clone() {
        Some(c) => s.op_req.request((c, op), |(c, op)| {
            match &op {
                Op::Created(n) => c.create(n)?,
                Op::Renamed(a, b) => c.rename(a, b)?,
                Op::Deleted(n) => c.delete(n)?,
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
            if s.conn.is_none() {
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
        Op::Deleted(n) => {
            s.cache.remove(&n);
            s.names.retain(|x| *x != n);
            s.open = None;
            s.note = "deleted".into();
        }
    }
    if s.conn.is_some() {
        load_tree(s);
    } else {
        let nodes = s.names.iter().map(|p| Node { path: p.clone(), page: true, kind: "md".into(), rev: 1 }).collect();
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
    s.op_req.set_waker(waker);
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

/// A rich field for `d`, kept to what Markdown can write.
fn rich_edit(d: md::Doc) -> TextEdit {
    let mut e = TextEdit::from_parts(d.text, d.marks, d.blocks)
        .with_soft_breaks(d.soft)
        .allow_marks([Mark::Bold, Mark::Italic, Mark::Strike, Mark::Code, Mark::Link(String::new())]);
    e.clear_history();
    e.focused = true;
    e
}

/// The Markdown the editor holds, whichever way it is being edited.
fn edited(s: &App) -> String {
    if s.rich { md::emit(&s.edit.text, s.edit.marks(), s.edit.blocks(), s.edit.soft_breaks()) } else { s.edit.text.clone() }
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
    let Some(p) = &s.open else { return };
    s.note.clear();
    // rich only when the page comes back from it unchanged (md::exact)
    match (p.kind == "md").then(|| md::exact(&p.body)).flatten() {
        Some(d) => {
            s.edit = rich_edit(d);
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
                s.edit = rich_edit(d);
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
                // a page just made or moved is shown where it now is
                if let Some(p) = &s.open {
                    s.files.expand_to(&p.name);
                    s.files.select(&p.name);
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
    let new = Button::new("New page").variant(ButtonVariant::Ghost).on_press(ask_new).build(k).key("new");
    let who = s.conn.as_ref().map_or("sample pages".to_owned(), |c| c.ship().to_owned());
    let foot = row()
        .w_full()
        .center_y()
        .justify_between()
        .child(text(who).key("ship").font(k.ty.small_medium).color(k.c.text_muted))
        .child(Button::new(if s.conn.is_some() { "Sign out" } else { "Close" }).variant(ButtonVariant::GhostMuted).on_press(sign_out).build(k).key("sign-out"));
    let mut side = col().key("pages").w_full().h_full().min_h(0.0).padding(8.0).gap(8.0).child(filter).child(new).child(tree).child(foot);
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
        trailing = trailing
            .child(Button::new("Delete").variant(ButtonVariant::GhostMuted).on_press(ask_delete).build(&k).key("delete"))
            .child(Button::new("Rename").variant(ButtonVariant::GhostMuted).on_press(ask_rename).build(&k).key("rename"))
            .child(Button::new("Edit").variant(ButtonVariant::Ghost).on_press_tx(|s: &mut App, tx| {
                start_edit(s);
                tx.focus_when_shown(FIELD, false);
            }).build(&k).key("edit"));
    }
    let mut layer = Vec::new();
    switcher(s, &k, &mut layer);
    prompt_view(s, &k, &mut layer);
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

fn on_key(s: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if s.conn.is_none() && !s.sample {
        return false;
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
        let odd = "- loose\n\n- list\n\n\nand gaps\n";
        s.open.as_mut().unwrap().body = odd.into();
        start_edit(&mut s);
        assert!(!s.rich);
        assert_eq!((s.edit.text.as_str(), s.note.as_str()), (odd, KEPT_AS_SOURCE));
        flip_mode(&mut s);
        assert!(!s.rich, "and stays source when asked to go rich");
        assert_eq!(edited(&s), odd);
    }
}
