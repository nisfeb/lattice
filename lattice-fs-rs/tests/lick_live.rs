//! Live lick round-trip against a real pier. This is the only check that
//! proves jam/cue still speak to vere, because the unit tests use synthetic
//! vectors of our own making. It is opt-in: without LATTICE_SOCK the test
//! skips, so CI (which has no pier) stays green.
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
