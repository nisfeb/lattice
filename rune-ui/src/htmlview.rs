//! An HTML page as a browser shows it, drawn inside the app. Blitz lays
//! the page out with its own styles (Stylo, Taffy, Parley) and paints it
//! on the processor, and the app shows the pictures in a scroll view. No
//! system web view and no GTK. Scripts do not run: Blitz has no JavaScript.
//!
//! The page lives on a thread of its own, since laying one out can take a
//! frame or several. The window asks it for the page at a width, tells it
//! what part is in view, and gets back bands of pixels for that part and
//! the parts beside it. A long page is never painted whole.
//!
//! The page has no session with the ship. What it carries in itself as
//! `data:` is read. What it names on the web is fetched, with no cookie,
//! only when the reader has let the page load outside content, since
//! that site then learns the reader's address. Until then it is counted.

use std::collections::BTreeSet;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use anyrender::ImageRenderer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_html::HtmlDocument;
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use blitz_traits::shell::{ColorScheme, Viewport};

/// How tall a band of the page is, in points.
pub const BAND: f32 = 512.0;
/// The widest and narrowest a page is laid out, in points.
const WIDTHS: (f32, f32) = (240.0, 4000.0);
/// The most a page may fetch, and the most one fetch may bring.
const FETCHES: usize = 96;
const FETCH_BYTES: usize = 12 << 20;

/// Which page, as the window knows it. A new revision is a new page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub name: String,
    pub rev: u64,
    /// Which text of that revision: a page of another ship is always revision 0, and a save kept on
    /// this device has new text at the old revision. The window counts up when the text is new.
    pub text: u64,
}

/// How a page is wanted.
#[derive(Clone, Debug, PartialEq)]
pub struct Ask {
    pub key: Key,
    /// Width in points.
    pub width: f32,
    /// Pixels to a point.
    pub scale: f32,
    pub dark: bool,
    /// The page may fetch what it names on the web.
    pub outside: bool,
}

enum Cmd {
    Show(Ask, Option<String>),
    /// The part in view: its top and its height, in points.
    See(f32, f32),
    /// The pointer at a point of the page, and whether it pressed there.
    Point(f32, f32, bool),
    /// Something the page asked for has come.
    Loaded,
    /// The window is done with the thread.
    Quit,
}

/// What the page's thread tells the window.
pub enum Out {
    /// The page is laid out: its height in points. Every band had before is void.
    /// `held` is how many things on the web it named and was not let to fetch.
    Laid { ask: Ask, turn: u64, height: f32, held: usize },
    /// One band's pixels, straight RGBA.
    Band { turn: u64, index: usize, w: u32, h: u32, px: Vec<u8> },
    /// A band far from view is let go.
    Forget { turn: u64, index: usize },
    /// Every band wanted for what is in view has been sent, or, with `false`, there are more to come.
    Rest(bool),
    /// Whether the pointer is over a link.
    Hot(bool),
    /// A link was pressed.
    Link(String),
    /// Laying out or painting the page failed inside the engine. The thread goes on without it, and
    /// the window reads the page another way.
    Failed,
}

/// The window's hold on the page's thread.
pub struct Html {
    tx: Sender<Cmd>,
    out: Arc<Mutex<Vec<Out>>>,
}

impl Html {
    /// Starts the thread. `wake` is called when there is something to take.
    pub fn start(wake: Arc<dyn Fn() + Send + Sync>) -> Html {
        let (tx, rx) = channel();
        let out = Arc::new(Mutex::new(Vec::new()));
        let (o, own) = (out.clone(), tx.clone());
        // style and layout go as deep as the page's markup does: a deep page gets the room
        let _ = std::thread::Builder::new().name("html".to_owned()).stack_size(64 << 20).spawn(move || run(rx, own, o, wake));
        Html { tx, out }
    }

    /// Asks for a page. `html` is given when the page itself is new, not only its width or look.
    pub fn show(&self, ask: Ask, html: Option<String>) {
        let _ = self.tx.send(Cmd::Show(ask, html.map(|h| crate::html::tamed(&h).into_owned())));
    }

    /// A way to say what is in view, for a handler that has no state.
    pub fn seer(&self) -> impl Fn(f32, f32) + 'static {
        let tx = self.tx.clone();
        move |top, height| {
            let _ = tx.send(Cmd::See(top, height));
        }
    }

    /// The pointer at a point of the page.
    pub fn point(&self, x: f32, y: f32, press: bool) {
        let _ = self.tx.send(Cmd::Point(x, y, press));
    }

    /// What has come since last asked.
    pub fn take(&self) -> Vec<Out> {
        std::mem::take(&mut *self.out.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

impl Drop for Html {
    fn drop(&mut self) {
        // the thread holds a sender of its own, so the channel closing would never end it
        let _ = self.tx.send(Cmd::Quit);
    }
}

/// The bands wanted for a view, nearest first, and the range kept: a
/// screen each side is painted ahead, and four each side are kept.
pub fn wanted(top: f32, view: f32, height: f32) -> (Vec<usize>, std::ops::Range<usize>) {
    let count = bands(height);
    let view = view.max(BAND);
    let span = |pad: f32| {
        let a = ((top - pad).max(0.0) / BAND).floor() as usize;
        let b = (((top + view + pad) / BAND).ceil() as usize).min(count);
        a.min(count)..b
    };
    let mid = (top + view / 2.0) / BAND - 0.5;
    let mut want: Vec<usize> = span(view).collect();
    want.sort_by(|a, b| (*a as f32 - mid).abs().total_cmp(&(*b as f32 - mid).abs()));
    (want, span(view * 4.0))
}

/// How many bands a page of a height has.
pub fn bands(height: f32) -> usize {
    // a page may say it is any height: no more of it is drawn than `TALLEST`, or the bands would be counted through for ever
    (height.clamp(1.0, TALLEST) / BAND).ceil() as usize
}

/// The most of a page's height that is drawn, in points: about 800 screens.
pub const TALLEST: f32 = 800_000.0;

/// The width a page is laid out at for a room of a width.
pub fn width_for(room: f32) -> f32 {
    room.clamp(WIDTHS.0, WIDTHS.1).floor()
}

/// Fetches what a page names, with no cookie: `data:`, and the web when let.
struct Net {
    tx: Mutex<Sender<Cmd>>,
    outside: bool,
    left: std::sync::atomic::AtomicUsize,
    held: std::sync::atomic::AtomicUsize,
}

impl NetProvider for Net {
    fn fetch(&self, _doc: usize, request: Request, handler: Box<dyn NetHandler>) {
        use std::sync::atomic::Ordering;
        let url = request.url;
        let tx = self.tx.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let done = move |bytes: Vec<u8>, url: String| {
            // a picture that says it is vast, or a drawing that would read a file, is not handed on
            if !crate::html::fetched_ok(&bytes) {
                return;
            }
            handler.bytes(url, Bytes::from(bytes));
            let _ = tx.send(Cmd::Loaded);
        };
        match url.scheme() {
            "data" => {
                if let Some(bytes) = data_url::DataUrl::process(url.as_str()).ok().and_then(|d| d.decode_to_vec().ok()) {
                    done(bytes.0, url.to_string());
                }
            }
            "http" | "https" => {
                if !self.outside {
                    self.held.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                if self.left.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1)).is_err() {
                    return;
                }
                let _ = std::thread::Builder::new().name("html-fetch".to_owned()).spawn(move || {
                    use std::io::Read;
                    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(15)).build();
                    let Ok(res) = agent.get(url.as_str()).call() else { return };
                    let mut bytes = Vec::new();
                    if res.into_reader().take(FETCH_BYTES as u64 + 1).read_to_end(&mut bytes).is_ok() && bytes.len() <= FETCH_BYTES {
                        done(bytes, url.to_string());
                    }
                });
            }
            _ => {}
        }
    }
}

struct Page {
    ask: Ask,
    doc: HtmlDocument,
    net: Arc<Net>,
    height: f32,
    have: BTreeSet<usize>,
    /// The height of the room it was laid out for.
    view: f32,
}

/// The deepest a page's elements may stand one in another, as the parser that draws it reads them, and be
/// drawn. Style, layout and paint go down a level at a time on the thread's own stack (64 MiB), and a table
/// or a list costs several times what a plain element does: 8,000 nested elements end the app in a debug build.
/// No page written by a person nests a tenth of this.
pub const DEEPEST: usize = 1024;

/// What a page nested past `DEEPEST` is drawn as.
const TOO_DEEP: &str = "<html><body><p>This page is nested too deeply to draw.</p></body></html>";

/// How deep the elements of a parsed page stand one in another, counted without recursion.
pub fn tree_depth(doc: &HtmlDocument) -> usize {
    let (mut most, mut left) = (0, vec![(doc.root_node().id, 0usize)]);
    while let Some((id, above)) = left.pop() {
        let Some(node) = doc.get_node(id) else { continue };
        let depth = above + usize::from(node.element_data().is_some());
        most = most.max(depth);
        left.extend(node.children.iter().map(|c| (*c, depth)));
    }
    most
}

/// A page parsed. The depth is that of the tree the parser made, so no spelling of nesting passes (a closing
/// tag that closes nothing, a table inside a cell, a list inside an item). One nested past `DEEPEST` is not
/// laid out: the page that says so is parsed in its place. `config` is asked for once for each parse.
fn document(html: &str, config: impl Fn() -> DocumentConfig) -> HtmlDocument {
    let doc = HtmlDocument::from_html(html, config());
    if tree_depth(&doc) <= DEEPEST {
        return doc;
    }
    drop(doc);
    HtmlDocument::from_html(TOO_DEEP, config())
}

fn viewport(ask: &Ask, view: f32) -> Viewport {
    let px = |v: f32| (v * ask.scale).round().max(1.0) as u32;
    Viewport::new(px(ask.width), px(view.max(BAND)), ask.scale, if ask.dark { ColorScheme::Dark } else { ColorScheme::Light })
}

fn lay(page: &mut Page) {
    page.doc.resolve(0.0);
    page.height = page.doc.try_root_element().map_or(1.0, |r| r.final_layout().size.height).max(1.0);
    page.have.clear();
}

/// The link at a point of the page, if one is there.
fn link_at(doc: &BaseDocument, x: f32, y: f32) -> Option<String> {
    let mut at = Some(doc.hit(x, y)?.node_id);
    while let Some(id) = at {
        let node = doc.get_node(id)?;
        if let Some(el) = node.element_data() {
            if &*el.name.local == "a" {
                let href = el.attrs().iter().find(|a| &*a.name.local == "href")?.value.trim();
                return (!href.is_empty()).then(|| href.to_owned());
            }
        }
        at = node.parent;
    }
    None
}

/// Paints one band. The renderer's pixels have their colour multiplied by
/// their cover, and a page with no ground of its own stands on white, as
/// in a browser, so each is laid over white.
fn paint(page: &mut Page, r: &mut Option<(u32, u32, VelloCpuImageRenderer)>, index: usize) -> (u32, u32, Vec<u8>) {
    let scale = page.ask.scale;
    let w = ((page.ask.width * scale).round() as u32).clamp(1, u16::MAX as u32);
    let full = (BAND * scale).round() as u32;
    let top = index as f32 * BAND;
    let h = (((page.height - top).min(BAND) * scale).ceil() as u32).clamp(1, full);
    if r.as_ref().is_none_or(|(rw, rh, _)| (*rw, *rh) != (w, full)) {
        *r = Some((w, full, VelloCpuImageRenderer::new(w, full)));
    }
    let renderer = &mut r.as_mut().unwrap().2;
    let mut px = vec![0u8; (w * full * 4) as usize];
    page.doc.set_viewport_scroll(blitz_dom::Point { x: 0.0, y: top as f64 });
    renderer.reset();
    renderer.render(|scene| blitz_paint::paint_scene(scene, &mut page.doc, scale as f64, w, full, 0, 0), &mut px);
    page.doc.set_viewport_scroll(blitz_dom::Point { x: 0.0, y: 0.0 });
    px.truncate((w * h * 4) as usize);
    for p in px.chunks_exact_mut(4) {
        let under = 255 - p[3];
        if under != 0 {
            p[0] = p[0].saturating_add(under);
            p[1] = p[1].saturating_add(under);
            p[2] = p[2].saturating_add(under);
            p[3] = 255;
        }
    }
    (w, h, px)
}

/// Runs the page's thread until the window is done with it. The engine is a beta: when it panics on
/// a page, that page is dropped and said to have failed, and the thread starts again for the next.
/// Without this a panic was silent and for good: no later page was ever drawn.
fn run(rx: Receiver<Cmd>, own: Sender<Cmd>, out: Arc<Mutex<Vec<Out>>>, wake: Arc<dyn Fn() + Send + Sync>) {
    loop {
        let turn = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| serve(&rx, &own, &out, &wake)));
        if turn.is_ok() {
            return;
        }
        out.lock().unwrap_or_else(|e| e.into_inner()).push(Out::Failed);
        wake();
    }
}

fn serve(rx: &Receiver<Cmd>, own: &Sender<Cmd>, out: &Arc<Mutex<Vec<Out>>>, wake: &Arc<dyn Fn() + Send + Sync>) {
    let tell = |o: Out| {
        out.lock().unwrap_or_else(|e| e.into_inner()).push(o);
        wake();
    };
    let mut page: Option<Page> = None;
    let mut renderer = None;
    let (mut turn, mut seen, mut hot, mut rest) = (0u64, (0.0f32, 900.0f32), false, true);
    loop {
        // everything waiting is taken at once, so only the newest of each kind is acted on
        let Ok(first) = rx.recv() else { return };
        let mut cmds = vec![first];
        cmds.extend(rx.try_iter());
        let (mut show, mut loaded, mut point) = (None, false, None);
        for c in cmds {
            match c {
                Cmd::Show(a, h) => show = Some(match (show.take(), h) {
                    // a width asked for after the page itself keeps the page's text
                    (Some((_, old @ Some(_))), None) => (a, old),
                    (_, h) => (a, h),
                }),
                Cmd::See(top, view) => seen = (top, view),
                Cmd::Loaded => loaded = true,
                Cmd::Quit => return,
                Cmd::Point(x, y, press) => point = Some(match point {
                    Some((_, _, true)) if !press => continue,
                    _ => (x, y, press),
                }),
            }
        }
        let mut laid = false;
        if let Some((ask, html)) = show {
            match (html, page.as_mut().filter(|p| p.ask.key == ask.key)) {
                (None, Some(p)) => {
                    if p.ask != ask {
                        p.ask = ask;
                        p.view = seen.1;
                        p.doc.set_viewport(viewport(&p.ask, seen.1));
                        lay(p);
                        laid = true;
                    }
                }
                (Some(html), _) => {
                    // a new page: nothing of it is under the pointer yet
                    (seen.0, hot) = (0.0, false);
                    let net = Arc::new(Net { tx: Mutex::new(own.clone()), outside: ask.outside, left: FETCHES.into(), held: 0.into() });
                    let doc = document(&html, || DocumentConfig { viewport: Some(viewport(&ask, seen.1)), net_provider: Some(net.clone()), ..Default::default() });
                    let mut p = Page { ask, doc, net, height: 1.0, have: BTreeSet::new(), view: seen.1 };
                    lay(&mut p);
                    page = Some(p);
                    laid = true;
                }
                // a width for a page not had: the window will ask again with its text
                (None, None) => {}
            }
        }
        let Some(p) = page.as_mut() else { continue };
        if loaded && !laid {
            p.doc.handle_messages();
            lay(p);
            laid = true;
        }
        // the room's height changed (the window was sized): what the page measures by it is measured again
        if !laid && (seen.1 - p.view).abs() > 1.0 {
            p.view = seen.1;
            p.doc.set_viewport(viewport(&p.ask, seen.1));
            lay(p);
            laid = true;
        }
        if laid {
            turn += 1;
            tell(Out::Laid { ask: p.ask.clone(), turn, height: p.height, held: p.net.held.load(std::sync::atomic::Ordering::Relaxed) });
        }
        if let Some((x, y, press)) = point {
            let link = link_at(&p.doc, x, y);
            if hot != link.is_some() {
                hot = link.is_some();
                tell(Out::Hot(hot));
            }
            if let (true, Some(href)) = (press, link) {
                tell(Out::Link(href));
            }
        }
        let (want, keep) = wanted(seen.0, seen.1, p.height);
        for gone in p.have.iter().copied().filter(|i| !keep.contains(i)).collect::<Vec<_>>() {
            p.have.remove(&gone);
            tell(Out::Forget { turn, index: gone });
        }
        // one band, then back to see what was asked meanwhile: a newer view or page goes first
        let next = want.into_iter().find(|i| !p.have.contains(i));
        if rest != next.is_none() {
            rest = next.is_none();
            tell(Out::Rest(rest));
        }
        if let Some(index) = next {
            let (w, h, px) = paint(p, &mut renderer, index);
            p.have.insert(index);
            tell(Out::Band { turn, index, w, h, px });
            let _ = own.send(Cmd::See(seen.0, seen.1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_nested_very_deep_is_laid_out_or_said_to_have_failed_and_the_next_is_drawn() {
        let h = Html::start(Arc::new(|| {}));
        let deep = format!("{}x{}", "<div>".repeat(20_000), "</div>".repeat(20_000));
        h.show(Ask { key: Key { name: "deep".into(), rev: 1, text: 0 }, width: 300.0, scale: 1.0, dark: false, outside: false }, Some(deep));
        h.show(Ask { key: Key { name: "next".into(), rev: 1, text: 0 }, width: 300.0, scale: 1.0, dark: false, outside: false }, Some("<p>after</p>".to_owned()));
        let end = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            if h.take().into_iter().any(|o| matches!(o, Out::Laid { ask, .. } if ask.key.name == "next")) {
                break;
            }
            assert!(std::time::Instant::now() < end, "the page after a hard one is still drawn");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn a_page_nested_past_the_limit_in_the_trees_own_count_is_not_laid_out() {
        let config = DocumentConfig::default;
        // what the old count of tags let through and overflowed the stack on: tables and lists, closing tags that close
        // nothing, and the plain nesting of elements. Each is measured on the tree, whatever way it is spelt
        let closex = format!("{}x", format!("{}{}", "<div>".repeat(4000), "</x>".repeat(4000)).repeat(2));
        let pages = [
            ("table", format!("{}x", "<table><tr><td>".repeat(2000))),
            ("list", format!("{}x", "<ul><li>".repeat(3000))),
            ("closex", closex),
            ("div", format!("{}x", "<div>".repeat(DEEPEST + 10))),
            ("svg", format!("<svg>{}</svg>", "<g>".repeat(DEEPEST + 10))),
            ("a stray end tag in a drawing", format!("<svg></x></svg><div>{}</div>", "<div>".repeat(DEEPEST))),
        ];
        for (what, page) in &pages {
            let seen = HtmlDocument::from_html(page, config());
            assert!(tree_depth(&seen) > DEEPEST, "{what}: the parser has it {} deep", tree_depth(&seen));
            let drawn = document(page, config);
            assert!(tree_depth(&drawn) <= 8, "{what}: laid out {} deep", tree_depth(&drawn));
        }
        // a page of the depth the limit lets by is drawn as it is
        for page in [format!("{}x", "<div>".repeat(DEEPEST - 10)), format!("{}x", "<ul><li>".repeat(100)), "<p>a</p>".repeat(100_000)] {
            let drawn = document(&page, config);
            assert_eq!(tree_depth(&drawn), tree_depth(&HtmlDocument::from_html(&page, config())));
            assert!(tree_depth(&drawn) > 2);
        }
        // pages that were wrongly refused as deep, harmless to the parser, are drawn: a script and a list of choices after a stray end tag in a drawing
        for page in [
            format!("<svg><path d='M0 0'/></path></svg><script>var e=0;{}</script><p>x</p>", "if(e<t)e++;".repeat(5000)),
            format!("<svg><g></g></g></svg><select>{}</select>", "<option>a".repeat(5000)),
            format!("<form><svg></x></svg>{}", "<input name=a>".repeat(5000)),
            format!("<svg></x></svg><style>{}</style>", "a<b{}".repeat(5000)),
        ] {
            let (drawn, parsed) = (document(&page, config), tree_depth(&HtmlDocument::from_html(&page, config())));
            assert_eq!(tree_depth(&drawn), parsed);
            assert!((3..10).contains(&parsed), "{parsed}");
        }
    }

    #[test]
    fn pages_that_overflowed_the_drawing_threads_stack_are_refused_before_they_are_laid_out() {
        // each was counted as shallow by the count of tags, and ended the app when laid out on this thread
        let h = Html::start(Arc::new(|| {}));
        let pages = [
            format!("{}x", "<table><tr><td>".repeat(2000)),
            format!("{}x", "<ul><li>".repeat(3000)),
            format!("{}x", format!("{}{}", "<div>".repeat(4000), "</x>".repeat(4000)).repeat(2)),
        ];
        for (n, page) in pages.into_iter().enumerate() {
            h.show(Ask { key: Key { name: format!("deep{n}"), rev: 1, text: 0 }, width: 300.0, scale: 1.0, dark: false, outside: false }, Some(page));
            let end = std::time::Instant::now() + std::time::Duration::from_secs(60);
            let height = loop {
                if let Some(Out::Laid { height, .. }) = h.take().into_iter().find(|o| matches!(o, Out::Laid { .. })) {
                    break height;
                }
                assert!(std::time::Instant::now() < end, "page {n} was not laid out");
                std::thread::sleep(std::time::Duration::from_millis(5));
            };
            // the line that says it is too deep, and not the page
            assert!(height < 400.0, "page {n} is {height} high");
        }
    }

    #[test]
    fn pages_as_deep_as_the_limit_allows_are_laid_out_and_painted_on_the_thread() {
        // the limit is only as high as the thread's stack lets any shape of element go: each of these is as deep as is
        // let by, and is laid out and painted (the stack is deeper-hungry in a debug build, so passing here holds in a release)
        let h = Html::start(Arc::new(|| {}));
        let room = DEEPEST - 8;
        let pages = [
            format!("{}x", "<div>".repeat(room)),
            format!("{}x", "<table><tr><td>".repeat(room / 4)),
            format!("{}x", "<ul><li>".repeat(room / 2)),
            format!("{}x", "<div style='display:flex'>".repeat(room)),
            format!("{}x", "<p><b><i>".repeat(room / 3)),
        ];
        for (n, page) in pages.into_iter().enumerate() {
            assert!(tree_depth(&HtmlDocument::from_html(&page, DocumentConfig::default())) <= DEEPEST, "shape {n} is let by");
            h.show(Ask { key: Key { name: format!("near{n}"), rev: 1, text: 0 }, width: 300.0, scale: 1.0, dark: false, outside: false }, Some(page));
            let end = std::time::Instant::now() + std::time::Duration::from_secs(120);
            let mut got = (false, false);
            while !(got.0 && got.1) {
                for o in h.take() {
                    match o {
                        Out::Laid { .. } => got.0 = true,
                        Out::Band { .. } => got.1 = true,
                        Out::Failed => panic!("shape {n} failed in the engine"),
                        _ => {}
                    }
                }
                assert!(std::time::Instant::now() < end, "shape {n} was not painted");
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }

    /// The pixel in the middle of a 100 by 100 band of a page, laid out and painted as the page's thread does.
    fn middle_of(html: &str) -> [u8; 4] {
        let (tx, _rx) = channel();
        let net = Arc::new(Net { tx: Mutex::new(tx), outside: false, left: FETCHES.into(), held: 0.into() });
        let ask = Ask { key: Key { name: "paint".into(), rev: 1, text: 0 }, width: 100.0, scale: 1.0, dark: false, outside: false };
        let doc = document(html, || DocumentConfig { viewport: Some(viewport(&ask, 100.0)), net_provider: Some(net.clone()), ..Default::default() });
        let mut p = Page { ask, doc, net, height: 1.0, have: BTreeSet::new(), view: 100.0 };
        lay(&mut p);
        // what a page names as `data:` has come, and is laid out again, once for what that names in turn
        for _ in 0..3 {
            p.doc.handle_messages();
            lay(&mut p);
        }
        let (w, h, px) = paint(&mut p, &mut None, 0);
        let at = ((h.min(100) / 2 * w + w / 2) * 4) as usize;
        [px[at], px[at + 1], px[at + 2], px[at + 3]]
    }

    #[test]
    fn a_drawing_in_an_html_page_that_names_a_file_does_not_read_it() {
        use base64::Engine as _;
        const SVG: &str = "http://www.w3.org/2000/svg";
        // a drawing in a file that would paint the page red if it were read
        let red = format!("<svg xmlns='{SVG}' width='100' height='100'><rect width='100' height='100' fill='#ff0000'/></svg>");
        let dir = std::env::temp_dir().join(format!("lattice-page-drawing-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("red.svg");
        std::fs::write(&file, &red).unwrap();
        let b64 = |t: &str| base64::engine::general_purpose::STANDARD.encode(t.as_bytes());
        let gz = |t: &str| {
            use std::io::Write;
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(t.as_bytes()).unwrap();
            e.finish().unwrap()
        };
        // the ways a page puts a drawing in: set in the page, as a picture, as a background, with the address spelt several ways
        let ways = |href: &str| {
            let prefixed = format!("<s:svg xmlns:s='{SVG}' width='100' height='100'><s:image href='{href}' width='100' height='100'/></s:svg>");
            let wrap = |body: &str| format!("<html><body style='margin:0'>{body}</body></html>");
            vec![
                ("set in the page", wrap(&format!("<svg width='100' height='100'><image href='{href}' width='100' height='100'/></svg>"))),
                ("set in the page, xlink", wrap(&format!("<svg width='100' height='100' xmlns:xlink='http://www.w3.org/1999/xlink'><image xlink:href='{href}' width='100' height='100'/></svg>"))),
                ("set in the page, with a prefix", wrap(&format!("<svg xmlns:x=\"{SVG}\" width=\"100\" height=\"100\"><x:image href=\"{href}\" width=\"100\" height=\"100\"></x:image></svg>"))),
                // the guard on what is fetched (`html::fetched_ok`) reads the text as it is plainly written, so a
                // picture is taken in the spellings it misses, and the drawing reader is what holds
                ("a picture, with a prefix", wrap(&format!("<img width='100' height='100' src='data:image/svg+xml;base64,{}'>", b64(&prefixed)))),
                ("a picture, gzip of a prefix", wrap(&format!("<img width='100' height='100' src='data:image/svg+xml;base64,{}'>", base64::engine::general_purpose::STANDARD.encode(gz(&prefixed))))),
                ("a background", wrap(&format!("<div style=\"width:100px;height:100px;background-image:url('data:image/svg+xml;base64,{}')\"></div>", b64(&prefixed)))),
            ]
        };
        let data = format!("data:image/svg+xml;base64,{}", b64(&red));
        let mut read = Vec::new();
        for ((how, named), (_, written)) in ways(file.to_str().unwrap()).into_iter().zip(ways(&data)) {
            // the control: the same page with the drawing written out is drawn, so a read of the file would be seen
            let control = middle_of(&written);
            assert!(control[0] > 200 && control[1] < 50, "{how}: the control paints {control:?}");
            let got = middle_of(&named);
            if got[0] > 200 && got[1] < 100 {
                read.push(format!("{how}: {got:?}"));
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(read.is_empty(), "painted from the file: {read:?}");
    }

    #[test]
    fn every_drawing_reader_the_build_links_that_a_page_reaches_reads_no_file() {
        // `[patch.crates-io]` replaces only the version it names. A usvg the build links from the registry is
        // stock, and reads any file a drawing names, so it must be one that no page's drawing reaches: the 0.45 that
        // Rune's picture cache draws icons with, which `html::drawing` keeps every page's drawing from. When
        // blitz-dom or anything else moves to a usvg of another version, the patch drops away and this stops the build
        let lock = include_str!("../Cargo.lock");
        let mut stock = Vec::new();
        for package in lock.split("[[package]]").skip(1) {
            let field = |k: &str| package.lines().find_map(|l| l.strip_prefix(k)?.strip_prefix(" = \"")?.strip_suffix('"'));
            if field("name") == Some("usvg") && field("source").is_some() {
                stock.push(field("version").unwrap_or("?").to_owned());
            }
        }
        assert!(stock.iter().all(|v| v.starts_with("0.45.")), "usvg from the registry, reading any file a drawing names: {stock:?}. Patch it in Cargo.toml (`vendor/usvg`) or draw with options that resolve no file");
        assert!(lock.contains("name = \"usvg\"\nversion = \"0.48.1\"\ndependencies"), "the usvg that Blitz draws with is the vendored copy");
    }

    #[test]
    fn the_bands_in_view_come_first_and_those_far_off_are_let_go() {
        // a page of ten bands, the view over the fourth and fifth
        let (want, keep) = wanted(BAND * 3.0, BAND * 2.0, BAND * 10.0);
        assert_eq!(&want[..2], [3, 4], "what is in view is painted first");
        let mut all = want.clone();
        all.sort_unstable();
        assert_eq!(all, [1, 2, 3, 4, 5, 6], "and a screen each side after it");
        assert_eq!(keep, 0..10);
        let (want, keep) = wanted(BAND * 40.0, BAND, BAND * 100.0);
        assert_eq!(want[0], 40);
        assert_eq!(keep, 36..45);
        assert!(want.iter().all(|i| keep.contains(i)));
    }

    #[test]
    fn a_short_page_is_one_band_and_a_view_past_the_end_wants_none() {
        assert_eq!((bands(0.0), bands(10.0), bands(BAND), bands(BAND + 1.0)), (1, 1, 1, 2));
        assert_eq!(wanted(0.0, 300.0, 10.0), (vec![0], 0..1));
        assert_eq!(wanted(BAND * 50.0, 300.0, BAND * 2.0).0, Vec::<usize>::new());
    }

    #[test]
    fn a_room_gives_a_whole_width_within_bounds() {
        assert_eq!((width_for(812.6), width_for(10.0), width_for(1e6)), (812.0, 240.0, 4000.0));
    }

    #[test]
    fn what_a_page_names_on_the_web_is_counted_and_not_fetched_until_let() {
        let h = Html::start(Arc::new(|| {}));
        // nothing listens there: were it asked, the test would still pass, so the count is what is checked
        let html = "<link rel='stylesheet' href='http://127.0.0.1:9/a.css'><img src='http://127.0.0.1:9/a.png'><img src='data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='>";
        h.show(Ask { key: Key { name: "o".into(), rev: 1, text: 0 }, width: 300.0, scale: 1.0, dark: false, outside: false }, Some(html.to_owned()));
        let end = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if let Some(Out::Laid { held, .. }) = h.take().into_iter().find(|o| matches!(o, Out::Laid { .. })) {
                assert_eq!(held, 2, "the sheet and the picture on the web, not the one the page carries");
                break;
            }
            assert!(std::time::Instant::now() < end);
            std::thread::yield_now();
        }
    }

    fn laid(h: &Html) -> (u64, f32) {
        let end = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            for o in h.take() {
                if let Out::Laid { turn, height, .. } = o {
                    return (turn, height);
                }
            }
            assert!(std::time::Instant::now() < end, "the page was never laid out");
            std::thread::yield_now();
        }
    }

    #[test]
    fn a_page_is_laid_out_painted_in_bands_and_its_link_found() {
        let h = Html::start(Arc::new(|| {}));
        let html = "<body style='margin:0;background:#102030'><div style='height:700px'><a href='https://example.com/x' style='display:block;width:200px;height:50px;background:#ff0000'>go</a></div></body>";
        let ask = Ask { key: Key { name: "p".into(), rev: 1, text: 0 }, width: 400.0, scale: 1.0, dark: false, outside: false };
        h.show(ask.clone(), Some(html.to_owned()));
        let (turn, height) = laid(&h);
        assert_eq!(height, 700.0);
        h.point(20.0, 20.0, true);
        let (mut bands, mut link, mut hot, mut rests) = (Vec::new(), None, Vec::new(), Vec::new());
        let end = std::time::Instant::now() + std::time::Duration::from_secs(20);
        // and it says when it has no more to send for what is in view
        while bands.len() < 2 || link.is_none() || hot.len() < 2 || !rests.contains(&true) {
            for o in h.take() {
                match o {
                    Out::Band { turn: t, index, w, h, px } => {
                        assert_eq!(t, turn);
                        bands.push((index, w, h, px));
                    }
                    Out::Link(l) => {
                        link = Some(l);
                        // off the link again, once the press is heard: a press waiting is not dropped for a move
                        h.point(20.0, 300.0, false);
                    }
                    Out::Hot(on) => hot.push(on),
                    Out::Rest(r) => rests.push(r),
                    _ => {}
                }
            }
            assert!(std::time::Instant::now() < end, "bands {} link {link:?} hot {hot:?} rests {rests:?}", bands.len());
            std::thread::yield_now();
        }
        assert_eq!(link.as_deref(), Some("https://example.com/x"));
        assert_eq!(hot, [true, false]);
        bands.sort_by_key(|b| b.0);
        let (_, w, bh, px) = &bands[0];
        assert_eq!((*w, *bh, px.len()), (400, 512, 400 * 512 * 4));
        assert_eq!(&px[..4], [255, 0, 0, 255], "the link's own ground");
        let below = (100 * 400 + 10) * 4;
        assert_eq!(&px[below..below + 4], [0x10, 0x20, 0x30, 255], "the page's ground");
        assert_eq!((bands[1].0, bands[1].2), (1, 188), "the last band is as tall as what is left");
        // the same page at another width is laid out again without its text
        h.show(Ask { width: 300.0, ..ask }, None);
        assert!(laid(&h).0 > turn);
    }

    #[test]
    fn a_page_with_no_ground_stands_on_white() {
        let h = Html::start(Arc::new(|| {}));
        h.show(Ask { key: Key { name: "w".into(), rev: 1, text: 0 }, width: 300.0, scale: 2.0, dark: false, outside: false }, Some("<p>hello</p>".to_owned()));
        laid(&h);
        let end = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if let Some(Out::Band { w, px, .. }) = h.take().into_iter().find(|o| matches!(o, Out::Band { .. })) {
                assert_eq!(w, 600, "two pixels to a point");
                assert_eq!(&px[..4], [255, 255, 255, 255]);
                assert!(px.chunks_exact(4).any(|p| p[0] < 80), "and its words are drawn");
                break;
            }
            assert!(std::time::Instant::now() < end);
            std::thread::yield_now();
        }
    }

    #[test]
    fn at_two_pixels_to_a_point_every_band_is_painted_to_its_foot() {
        let h = Html::start(Arc::new(|| {}));
        h.show(Ask { key: Key { name: "t".into(), rev: 1, text: 0 }, width: 300.0, scale: 2.0, dark: false, outside: false }, Some("<body style='margin:0'><div style='height:1300px;background:#102030'></div></body>".to_owned()));
        let (mut got, end) = (Vec::new(), std::time::Instant::now() + std::time::Duration::from_secs(20));
        while got.len() < 3 {
            for o in h.take() {
                if let Out::Band { index, w, h, px, .. } = o {
                    let last = px.len() - 4;
                    got.push((index, w, h, [px[0], px[1], px[2]], [px[last], px[last + 1], px[last + 2]]));
                }
            }
            assert!(std::time::Instant::now() < end, "{got:?}");
            std::thread::yield_now();
        }
        got.sort();
        let g = [0x10, 0x20, 0x30];
        assert_eq!(got, [(0, 600, 1024, g, g), (1, 600, 1024, g, g), (2, 600, 552, g, g)]);
    }
}
