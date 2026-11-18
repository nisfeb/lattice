//! The native program. The app itself is the library, which the web build
//! also starts (`start`, in `lib.rs`).

fn main() {
    // answered before any window is asked for, so a build can be tried where there is no display
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("lattice-rune {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    lattice_rune::run();
}
