//! Live lick round-trip against a real pier. This is the only check that
//! proves jam/cue still speak to vere, because the unit tests use synthetic
//! vectors of our own making. It is opt-in: without LATTICE_SOCK the test
//! skips, so CI (which has no pier) stays green. REQUIRE_LICK=1 makes the
//! skip a failure.
//!
//!   LATTICE_SOCK=<pier>/.urb/dev/grubbery/lattice/fs LATTICE_SHIP='~nec' \
//!     cargo test --test lick_live -- --nocapture
use lattice_fs::lick::LickTransport;
use lattice_fs::transport::Transport;

#[test]
fn lick_round_trips_against_a_real_pier() {
    let (Ok(sock), Ok(ship)) = (
        std::env::var("LATTICE_SOCK"),
        std::env::var("LATTICE_SHIP"),
    ) else {
        // REQUIRE_LICK=1 turns the skip into a failure, for a run that means
        // to test against a pier and must not go green without one.
        if std::env::var("REQUIRE_LICK").as_deref() == Ok("1") {
            panic!("REQUIRE_LICK=1 but LATTICE_SOCK / LATTICE_SHIP are not set");
        }
        eprintln!("skipped: set LATTICE_SOCK and LATTICE_SHIP to run");
        return;
    };
    let t = LickTransport::new(&sock, &ship);

    // ship() exercises the smallest complete cycle: jam a request, frame it,
    // read the reply frame, cue it back to a noun.
    let who = t.ship().expect("ship() over lick");
    assert_eq!(who, ship, "pier reported a different @p");

    // a real payload: the page dump is the largest routine response, so it
    // covers deep cells and long atoms rather than just a short reply.
    let body = t
        .get_bytes("/apps/lattice/page-dump", &[])
        .expect("page-dump over lick");
    let text = String::from_utf8(body).expect("dump is utf8");
    assert!(
        text.contains("\"nodes\""),
        "dump lacks nodes: {}",
        &text[..text.len().min(120)]
    );
    eprintln!("lick ok: {} bytes of page-dump decoded", text.len());
}

/// One page-source read over lick, timed, for scripts/two-ship-links.sh: a
/// link's read must answer from its cache even with the host offline. Opt-in
/// like the test above: it runs only when LICK_SOURCE names a page, and
/// prints `LICK_MS=<n>` and `LICK_BODY=<json>` lines for the script to read.
/// With LICK_SAVE set it saves that body to the page first (`LICK_SAVED=`,
/// `LICK_SAVE_MS=`).
///
///   LATTICE_SOCK=<pier>/.urb/dev/grubbery/lattice/fs LATTICE_SHIP='~mec' \
///     LICK_SOURCE=notes/doc cargo test --test lick_live lick_source -- --nocapture
#[test]
fn lick_source() {
    let (Ok(sock), Ok(ship), Ok(name)) = (
        std::env::var("LATTICE_SOCK"),
        std::env::var("LATTICE_SHIP"),
        std::env::var("LICK_SOURCE"),
    ) else {
        eprintln!("skipped: set LATTICE_SOCK, LATTICE_SHIP and LICK_SOURCE to run");
        return;
    };
    let t = LickTransport::new(&sock, &ship);
    // LICK_SAVE=<body>: save that body first, as the mount does on a flush
    if let Ok(body) = std::env::var("LICK_SAVE") {
        let q = [("name", name.as_str()), ("type", "md")];
        let at = std::time::Instant::now();
        let r = t.post("/apps/lattice/page-save", &q, body.as_bytes());
        println!("LICK_SAVE_MS={}", at.elapsed().as_millis());
        match r {
            Ok(_) => println!("LICK_SAVED=ok"),
            Err(e) => println!("LICK_SAVED={} {}", e.code, e.msg),
        }
    }
    let at = std::time::Instant::now();
    let r = t.get_bytes("/apps/lattice/page-source", &[("name", name.as_str())]);
    println!("LICK_MS={}", at.elapsed().as_millis());
    match r {
        Ok(b) => println!("LICK_BODY={}", String::from_utf8_lossy(&b)),
        Err(e) => println!("LICK_ERR={} {}", e.code, e.msg),
    }
}

/// The mount's stale save, for scripts/two-ship-links.sh: the projection
/// reads LICK_STALE over lick, LICK_BETWEEN runs (the script has the host
/// edit the page and waits for this ship's cache to take it), then the
/// projection saves LICK_SAVE, the text it read before. It must claim the
/// rev it read, so the host's newer text survives. Prints `LICK_READ=` and
/// `LICK_STALE_SAVED=ok` or `LICK_STALE_SAVED=<errno> <msg>`. Opt-in like
/// the tests above.
#[test]
fn lick_stale_save() {
    use lattice_fs::lattice::LatticeProjection;
    use lattice_fs::projection::Projection;
    let (Ok(sock), Ok(ship), Ok(name), Ok(body)) = (
        std::env::var("LATTICE_SOCK"),
        std::env::var("LATTICE_SHIP"),
        std::env::var("LICK_STALE"),
        std::env::var("LICK_SAVE"),
    ) else {
        eprintln!("skipped: set LATTICE_SOCK, LATTICE_SHIP, LICK_STALE and LICK_SAVE to run");
        return;
    };
    let p = LatticeProjection::new(Box::new(LickTransport::new(&sock, &ship)), "")
        .expect("projection over lick");
    let got = p.read(&name).expect("read through the link");
    println!("LICK_READ={}", String::from_utf8_lossy(&got));
    if let Ok(cmd) = std::env::var("LICK_BETWEEN") {
        let st = std::process::Command::new("sh").arg("-c").arg(&cmd).status();
        println!("LICK_BETWEEN={}", st.map(|s| s.success()).unwrap_or(false));
    }
    match p.write(&name, "md", body.as_bytes(), false) {
        Ok(()) => println!("LICK_STALE_SAVED=ok"),
        Err(e) => println!("LICK_STALE_SAVED={} {}", e.errno, e.msg),
    }
}
