//! urb:// links handed to the app by the OS.
//!
//! Another app (Talon, a terminal, a browser) opens `urb://~ship/path`, and
//! the OS starts this binary with the link as its only argument. A running
//! instance gets it forwarded by the single-instance plugin instead of a
//! second window appearing (main.rs). Either way the link lands here.
//!
//! The link waits in the inbox until a ship page takes it. The page asks
//! with take_urb_links, at boot and whenever arrive() pokes it, and opens
//! each one in a new browser tab of the workspace. So a link that arrives
//! while the manager is showing, or before any ship is connected, or while
//! the ship page is still loading, is not lost. It opens once a workspace
//! is up.
//!
//! Everything from outside is validated here, strictly, before it is kept.
//! A link is text some other program chose, and the page will put it in a
//! reader URL, so only a plain `urb://~ship/path` gets through.

use std::ffi::OsStr;
use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

/// Links waiting for a ship page to open them.
pub struct Inbox(pub Mutex<Vec<String>>);

/// A burst of links (a script, a stuck key) is bounded. The oldest go first:
/// the link the user just clicked is the one they are waiting for.
const INBOX_MAX: usize = 32;

/// Longer than any real address, short enough that a link is never a payload.
const URL_MAX: usize = 2048;

const PREFIXES: &str = "\
dozmarbinwansamlitsighidfidlissogdirwacsabwissib\
rigsoldopmodfoglidhopdardorlorhodfolrintogsilmir\
holpaslacrovlivdalsatlibtabhanticpidtorbolfosdot\
losdilforpilramtirwintadbicdifrocwidbisdasmidlop\
rilnardapmolsanlocnovsitnidtipsicropwitnatpanmin\
ritpodmottamtolsavposnapnopsomfinfonbanmorworsip\
ronnorbotwicsocwatdolmagpicdavbidbaltimtasmallig\
sivtagpadsaldivdactansidfabtarmonranniswolmispal\
lasdismaprabtobrollatlonnodnavfignomnibpagsopral\
bilhaddocridmocpacravripfaltodtiltinhapmicfanpat\
taclabmogsimsonpinlomrictapfirhasbosbatpochactid\
havsaplindibhosdabbitbarracparloddosbortochilmac\
tomdigfilfasmithobharmighinradmashalraglagfadtop\
mophabnilnosmilfopfamdatnoldinhatnacrisfotribhoc\
nimlarfitwalrapsarnalmoslandondanladdovrivbacpol\
laptalpitnambonrostonfodponsovnocsorlavmatmipfip";

const SUFFIXES: &str = "\
zodnecbudwessevpersutletfulpensytdurwepserwylsun\
rypsyxdyrnuphebpeglupdepdysputlughecryttyvsydnex\
lunmeplutseppesdelsulpedtemledtulmetwenbynhexfeb\
pyldulhetmevruttylwydtepbesdexsefwycburderneppur\
rysrebdennutsubpetrulsynregtydsupsemwynrecmegnet\
secmulnymtevwebsummutnyxrextebfushepbenmuswyxsym\
selrucdecwexsyrwetdylmynmesdetbetbeltuxtugmyrpel\
syptermebsetdutdegtexsurfeltudnuxruxrenwytnubmed\
lytdusnebrumtynseglyxpunresredfunrevrefmectedrus\
bexlebduxrynnumpyxrygryxfeptyrtustyclegnemfermer\
tenlusnussyltecmexpubrymtucfyllepdebbermughuttun\
bylsudpemdevlurdefbusbeprunmelpexdytbyttyplevmyl\
wedducfurfexnulluclennerlexrupnedlecrydlydfenwel\
nydhusrelrudneshesfetdesretdunlernyrsebhulryllud\
remlysfynwerrycsugnysnyllyndyndemluxfedsedbecmun\
lyrtesmudnytbyrsenwegfyrmurtelreptegpecnelnevfes";

/// Is `s` one syllable of `table`? Syllables sit on three-letter boundaries,
/// so "odm" (straddling doz|mar) is not one.
fn syllable(table: &str, s: &str) -> bool {
    s.len() == 3 && table.as_bytes().chunks(3).any(|c| c == s.as_bytes())
}

/// A six-letter word: a prefix syllable, then a suffix syllable.
fn word(w: &str) -> bool {
    w.len() == 6
        && w.is_char_boundary(3)
        && syllable(PREFIXES, &w[..3])
        && syllable(SUFFIXES, &w[3..])
}

/// A ship name in @p's printed form, with its `~`: a galaxy (one suffix), a
/// star (one word), a planet (two), a moon (four) or a comet (eight, its two
/// halves joined by `--`). Lowercase only, as @p prints.
pub fn is_patp(p: &str) -> bool {
    let Some(name) = p.strip_prefix('~') else { return false };
    if syllable(SUFFIXES, name) {
        return true;
    }
    let words = |s: &str| -> Option<usize> {
        let ws: Vec<&str> = s.split('-').collect();
        ws.iter().all(|w| word(w)).then_some(ws.len())
    };
    match name.split_once("--") {
        Some((a, b)) => words(a) == Some(4) && words(b) == Some(4),
        None => matches!(words(name), Some(1 | 2 | 4)),
    }
}

/// One path character a link may carry: unreserved, or `/`. Anything that
/// could change what the reader URL means (`?`, `#`, `&`, `\`, quotes,
/// spaces, controls) is refused rather than escaped.
fn path_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/')
}

/// The link, if it is exactly `urb://~ship/path`: a valid @p and a non-empty
/// path of plain segments, an optional trailing `/` for a folder, and
/// percent-escapes only where they are well formed. No query, no fragment,
/// no user or port, no `.` or `..` segment, no empty segment.
pub fn parse(raw: &str) -> Option<String> {
    if raw.len() > URL_MAX {
        return None;
    }
    let rest = raw.strip_prefix("urb://")?;
    let (ship, path) = rest.split_once('/')?;
    if !is_patp(ship) || path.is_empty() {
        return None;
    }
    let b = path.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if !(i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit()) {
                return None;
            }
            i += 3;
            continue;
        }
        if !path_byte(b[i]) {
            return None;
        }
        i += 1;
    }
    let segs: Vec<&str> = path.strip_suffix('/').unwrap_or(path).split('/').collect();
    if segs.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return None;
    }
    Some(raw.to_string())
}

/// One spelling for each urb:// address, so the places the reader keys by
/// address (history, the outside-content choice, pending comments and
/// reply marks) see one page as one page: the scheme and ship lowercased,
/// the ship with exactly one `~`, percent-escapes of unreserved characters
/// decoded and the rest in uppercase hex, empty segments (a doubled or
/// trailing `/`) dropped, and a leading `/n/` dropped where the address
/// reads the same without it. A query or fragment is kept as it is, and
/// anything that is not an urb:// address comes back only trimmed.
#[cfg(feature = "urb-engine")]
pub fn canon(raw: &str) -> String {
    let t = raw.trim();
    let Some(rest) = t.get(..6).filter(|p| p.eq_ignore_ascii_case("urb://")).map(|_| &t[6..]) else {
        return t.to_string();
    };
    let (addr, tail) = rest.split_at(rest.find(['?', '#']).unwrap_or(rest.len()));
    let (ship, path) = addr.split_once('/').unwrap_or((addr, ""));
    let ship = ship.trim_start_matches('~').to_ascii_lowercase();
    if ship.is_empty() {
        return t.to_string();
    }
    let path = unescape_unreserved(path);
    let mut segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    // `/n/` is the default mount, unless what follows would read as a
    // mount of its own (one letter) or a forum board
    if segs.len() > 1 && segs[0] == "n" && segs[1].len() > 1 && segs[1] != "forum" {
        segs.remove(0);
    }
    let mut out = format!("urb://~{ship}");
    for s in segs {
        out.push('/');
        out.push_str(s);
    }
    out.push_str(tail);
    out
}

/// `%XX` decoded where it names an unreserved character, uppercased where
/// it does not; a `%` not followed by two hex digits is left alone.
#[cfg(feature = "urb-engine")]
fn unescape_unreserved(path: &str) -> String {
    let b = path.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
        if let (b'%', Some(h), Some(l)) = (b[i], b.get(i + 1).and_then(|&c| hex(c)), b.get(i + 2).and_then(|&c| hex(c))) {
            let v = h * 16 + l;
            if v.is_ascii_alphanumeric() || b"-._~".contains(&v) {
                out.push(v);
            } else {
                out.extend_from_slice(format!("%{v:02X}").as_bytes());
            }
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    // only ASCII was put in for ASCII taken out, so the text stays UTF-8
    String::from_utf8(out).unwrap_or_else(|_| path.to_string())
}

/// Keep the links that pass parse(), oldest dropped past INBOX_MAX. Answers
/// how many were kept.
fn enqueue<'a>(inbox: &mut Vec<String>, links: impl IntoIterator<Item = &'a str>) -> usize {
    let mut kept = 0;
    for raw in links {
        match parse(raw) {
            Some(u) => {
                inbox.push(u);
                kept += 1;
            }
            None => crate::commands::dlog(&format!("urb: refused {:?}", raw.chars().take(200).collect::<String>())),
        }
    }
    let over = inbox.len().saturating_sub(INBOX_MAX);
    inbox.drain(..over);
    kept
}

/// What the ship page is told when links arrive. A ship UI with the hook
/// (24-tools.js) takes them into new tabs. A ship UI older than the hook,
/// with its tab shell already up, cannot take them, so the window goes to
/// the reader for the newest one, which is how an urb:// navigation was
/// handled before (nav_decision in commands.rs). A page still booting has
/// neither yet and is left alone: it drains the inbox itself once up.
fn poke_js(newest: &str) -> String {
    let reader = serde_json::to_string(&reader_path(newest)).unwrap_or_else(|_| "\"\"".into());
    format!(
        "(function(){{if(window.latUrbArrived){{window.latUrbArrived();}}\
         else if(window.latTabs){{location.href={reader};}}}})()"
    )
}

/// The reader's address for a link, origin-relative, encoded exactly as
/// nav_decision (commands.rs) encodes the same route.
fn reader_path(link: &str) -> String {
    let mut t: tauri::Url = "http://127.0.0.1/apps/lattice".parse().expect("static url");
    t.query_pairs_mut().append_pair("url", link);
    format!("{}?{}", t.path(), t.query().unwrap_or(""))
}

/// Where a link from the OS goes.
#[derive(Debug, PartialEq, Eq)]
enum Route {
    /// no ship is configured: the shipless reader opens it at once
    Reader,
    /// the ship page takes it (or it waits in the inbox for one)
    Inbox,
}

fn route(no_ship: bool, engine: bool) -> Route {
    if no_ship && engine {
        Route::Reader
    } else {
        Route::Inbox
    }
}

/// Links from the OS: validate, keep, and bring the window forward. With no
/// ship configured the newest opens in the shipless reader at once, rather
/// than waiting for a ship that may never come (the inbox still keeps it,
/// for a ship connected later). If the workspace is on a ship page, tell
/// it. If it is on the manager the links wait for a workspace to open.
pub fn arrive<'a>(app: &AppHandle, links: impl IntoIterator<Item = &'a str>) {
    let newest = {
        let inbox = app.state::<Inbox>();
        let mut q = inbox.0.lock().unwrap();
        if enqueue(&mut q, links) == 0 {
            return;
        }
        q.last().cloned()
    };
    crate::commands::dlog(&format!("urb: queued {newest:?}"));
    let Some(newest) = newest else { return };
    let h = app.clone();
    if route(crate::config::load(app).url.is_empty(), cfg!(feature = "urb-engine")) == Route::Reader {
        app.run_on_main_thread(move || {
            if let Err(e) = crate::commands::open_reader(h.clone(), Some(newest)) {
                crate::commands::dlog(&format!("urb: the reader would not open it: {e}"));
            }
            if let Some(w) = h.get_webview_window("workspace") {
                w.unminimize().ok();
                w.show().ok();
                w.set_focus().ok();
            }
        })
        .ok();
        return;
    }
    // eval and focus belong on the main thread, and this can be called from
    // the single-instance plugin's D-Bus thread
    app.run_on_main_thread(move || {
        let Some(w) = h.get_webview_window("workspace") else { return };
        w.unminimize().ok();
        w.show().ok();
        w.set_focus().ok();
        if !crate::commands::on_shell_page(&w) {
            w.eval(poke_js(&newest)).ok();
        }
    })
    .ok();
}

/// The ship page takes every waiting link, in arrival order, and opens them.
/// It gets only what parse() let in, and taking them is all it can do.
#[tauri::command]
pub fn take_urb_links(app: AppHandle) -> Vec<String> {
    std::mem::take(&mut *app.state::<Inbox>().0.lock().unwrap())
}

/// The D-Bus name base the single-instance plugin claims on Linux, one per
/// config directory. The config dir holds the ship this copy is connected
/// to, so a copy started with its own XDG_CONFIG_HOME (a second ship's
/// workspace) is its own instance and is not folded into the first. The
/// default config dir keeps the bare identifier, which is the instance an
/// urb:// link from the desktop reaches, since the OS starts the handler
/// with the user's ordinary environment. Mirrors how Tauri's
/// app_config_dir reads the variables: a relative XDG_CONFIG_HOME is
/// ignored. FNV-1a, not DefaultHasher, so every build names a profile the
/// same way.
pub fn instance_id(identifier: &str, xdg_config: Option<&OsStr>, home: Option<&OsStr>) -> String {
    let default = home.map(|h| Path::new(h).join(".config"));
    let cfg = xdg_config
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .map(Path::to_path_buf)
        .or_else(|| default.clone());
    match cfg {
        Some(c) if Some(&c) != default.as_ref() => {
            let h = c.as_os_str().as_encoded_bytes().iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
                (h ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3)
            });
            format!("{identifier}.p{h:016x}")
        }
        _ => identifier.to_string(),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "urb-engine")]
    #[test]
    fn one_address_has_one_spelling() {
        use super::canon;
        for (raw, want) in [
            ("urb://~zod/a/b", "urb://~zod/a/b"),
            (" URB://~ZOD/a/b ", "urb://~zod/a/b"),
            ("urb://zod/a/b", "urb://~zod/a/b"),
            ("urb://~~zod/a/b", "urb://~zod/a/b"),
            ("urb://~zod//a///b/", "urb://~zod/a/b"),
            ("urb://~zod/", "urb://~zod"),
            ("urb://~zod/docs/", "urb://~zod/docs"),
            ("urb://~zod/%61%2d%7E/%2f%3f%e2%82%ac", "urb://~zod/a-~/%2F%3F%E2%82%AC"),
            ("urb://~zod/a%2", "urb://~zod/a%2"),
            ("urb://~zod/n/hello", "urb://~zod/hello"),
            ("urb://~zod/n/x", "urb://~zod/n/x"),
            ("urb://~zod/n/forum/b", "urb://~zod/n/forum/b"),
            ("urb://~zod/n", "urb://~zod/n"),
            ("urb://~zod/a//b?x=1//2#f", "urb://~zod/a/b?x=1//2#f"),
            ("https://example.com//x", "https://example.com//x"),
            ("urb://", "urb://"),
            ("ürb://x", "ürb://x"),
        ] {
            assert_eq!(canon(raw), want, "{raw}");
            assert_eq!(canon(want), want, "idempotent: {want}");
        }
    }

    #[test]
    fn with_no_ship_a_link_opens_in_the_reader() {
        use super::{route, Route};
        assert_eq!(route(true, true), Route::Reader);
        assert_eq!(route(false, true), Route::Inbox);
        // a build with no engine waits for a ship, as before
        assert_eq!(route(true, false), Route::Inbox);
    }

    use super::*;

    #[test]
    fn the_tables_are_whole() {
        assert_eq!(PREFIXES.len(), 256 * 3);
        assert_eq!(SUFFIXES.len(), 256 * 3);
    }

    #[test]
    fn every_ship_class_parses() {
        for p in [
            "~zod",
            "~nec",
            "~marzod",
            "~sampel-palnet",
            "~ricsul-bilwyt",
            "~mister-botter-dozzod-nisfeb",
            "~dasres-ragnep-lislyt-ritpub--hasbex-sibwyt-picsul-locmus",
        ] {
            assert!(is_patp(p), "{p}");
        }
    }

    #[test]
    fn things_that_are_not_ships_do_not() {
        for p in [
            "", "~", "zod", "~doz", "~ZOD", "~Zod", "~zodd", "~zo", "~marzo", "~zodmar",
            "~sampel-", "-sampel", "~sampel--palnet", "~sampel-palnet-",
            "~sampel-palnet-sampel", "~a-b", "~sampel_palnet", "~odmarz",
            "~dasres-ragnep-lislyt-ritpub-hasbex-sibwyt-picsul-locmus",
            "~dasres-ragnep-lislyt--hasbex-sibwyt-picsul-locmus",
            "~zod\u{0}", "~zöd",
        ] {
            assert!(!is_patp(p), "{p:?}");
        }
    }

    #[test]
    fn a_plain_link_is_kept_as_it_came() {
        for u in [
            "urb://~zod/x",
            "urb://~sampel-palnet/notes/2026/intro",
            "urb://~sampel-palnet/site/",
            "urb://~ricsul-bilwyt/p/counter",
            "urb://~zod/t/apps/lattice.lattice_app/page/a~b",
            "urb://~zod/notes/caf%C3%A9",
        ] {
            assert_eq!(parse(u).as_deref(), Some(u), "{u}");
        }
    }

    #[test]
    fn anything_else_is_refused() {
        let long = format!("urb://~zod/{}", "a".repeat(URL_MAX));
        for u in [
            "",
            "urb://~zod",
            "urb://~zod/",
            "urb://zod/x",
            "urb://~zodd/x",
            "URB://~zod/x",
            "urb:~zod/x",
            "urb:/~zod/x",
            "https://~zod/x",
            "http://example.com/",
            "javascript:alert(1)",
            "urb://~zod/x?y=1",
            "urb://~zod/x#frag",
            "urb://~zod/x&url=evil",
            "urb://user@~zod/x",
            "urb://~zod:8080/x",
            "urb://~zod/a//b",
            "urb://~zod/a/../b",
            "urb://~zod/./b",
            "urb://~zod/a b",
            "urb://~zod/a\nb",
            "urb://~zod/a\\b",
            "urb://~zod/a\"b",
            "urb://~zod/a%2",
            "urb://~zod/a%zz",
            "urb://~zod/%",
            "urb://~zod/caf\u{e9}",
            " urb://~zod/x",
            "urb://~zod/x ",
            long.as_str(),
        ] {
            assert_eq!(parse(u), None, "{u:?}");
        }
    }

    #[test]
    fn the_inbox_keeps_good_links_in_order_and_stays_bounded() {
        let mut q = Vec::new();
        assert_eq!(enqueue(&mut q, ["urb://~zod/a", "nope", "urb://~nec/b"]), 2);
        assert_eq!(q, ["urb://~zod/a", "urb://~nec/b"]);
        let many: Vec<String> = (0..INBOX_MAX + 5).map(|i| format!("urb://~zod/n{i}")).collect();
        enqueue(&mut q, many.iter().map(String::as_str));
        assert_eq!(q.len(), INBOX_MAX);
        assert_eq!(q.first().unwrap(), "urb://~zod/n5");
        assert_eq!(q.last().unwrap(), &format!("urb://~zod/n{}", INBOX_MAX + 4));
    }

    #[test]
    fn the_page_is_poked_and_an_old_shell_goes_to_the_reader() {
        let js = poke_js("urb://~zod/a/b");
        assert!(js.contains("if(window.latUrbArrived){window.latUrbArrived();}"));
        assert!(js.contains("else if(window.latTabs){location.href=\"/apps/lattice?url=urb%3A%2F%2F%7Ezod%2Fa%2Fb\";}"));
    }

    #[test]
    fn each_config_dir_is_its_own_instance() {
        let id = "org.lattice.desktop";
        let home = Some(OsStr::new("/home/u"));
        // the ordinary profile, however it is spelled, is the bare identifier
        assert_eq!(instance_id(id, None, home), id);
        assert_eq!(instance_id(id, Some(OsStr::new("/home/u/.config")), home), id);
        assert_eq!(instance_id(id, Some(OsStr::new("rel/cfg")), home), id);
        assert_eq!(instance_id(id, None, None), id);
        // another profile is another instance, the same one every time
        let a = instance_id(id, Some(OsStr::new("/home/u/ship-b")), home);
        let b = instance_id(id, Some(OsStr::new("/home/u/ship-c")), home);
        assert_ne!(a, id);
        assert_ne!(a, b);
        assert_eq!(a, instance_id(id, Some(OsStr::new("/home/u/ship-b")), home));
        // a well-formed D-Bus name element: starts with a letter, then hex
        let tail = a.strip_prefix("org.lattice.desktop.p").unwrap();
        assert_eq!(tail.len(), 16);
        assert!(tail.bytes().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn the_identifier_is_the_bundle_identifier() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], crate::IDENTIFIER);
    }
}
