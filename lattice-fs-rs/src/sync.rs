//! One place to name the sync primitives the core's threads run on.
//!
//! Production is always `std`. The ONLY other case is the shuttle concurrency
//! harness (see the `shuttle_tests` module at the bottom of core.rs), which
//! needs its own `Mutex`/`thread` so its scheduler can see every lock and every
//! spawn and permute them.
//!
//! Why a re-export module rather than a pair of `use` lines at each call site:
//! the swap has to be all-or-nothing. A `Mutex` from `std` locked by a thread
//! from `shuttle` (or the reverse) either deadlocks the run or silently hides
//! the interleaving the test exists to find, and with per-file `use` lines that
//! mismatch is one forgotten import away. One module, one switch.
//!
//! Why `cfg(all(test, shuttle))` rather than a cargo feature: `shuttle` stays a
//! dev-dependency, so it cannot end up in a release build even by accident, and
//! the alias only ever moves in a `--test` compilation of the lib. Every other
//! build of this crate, including the one every integration test links against,
//! resolves these names to `std` exactly as before. `shuttle` is a custom cfg
//! set through RUSTFLAGS and declared in Cargo.toml's `[lints.rust]`.

#[cfg(all(test, shuttle))]
pub use shuttle::sync::{Arc, Mutex};
#[cfg(all(test, shuttle))]
pub use shuttle::thread;

#[cfg(not(all(test, shuttle)))]
pub use std::sync::{Arc, Mutex};
#[cfg(not(all(test, shuttle)))]
pub use std::thread;
