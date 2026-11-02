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

/// Links from the OS: validate, keep, and bring the window forward. If the
/// workspace is on a ship page, tell it. If it is on the manager the links
/// wait for a workspace to open.
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

#[cfg(test)]
mod tests {
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
}
