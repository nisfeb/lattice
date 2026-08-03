#!/bin/sh
# Fetch, build and run fsx against a real mount of this filesystem.
#
#   tests/fsx.sh            # fetch + build fsx if needed, then run the test
#   FSX_SRC=/path/fsx.c tests/fsx.sh   # build from a local copy instead
#
# fsx is one GPL-2.0 C file from the Linux Test Project. It is fetched rather
# than vendored so this repo does not carry someone else's licensed source.
# The test itself (tests/fsx.rs) SKIPS when the binary is absent, so a plain
# `cargo test` never needs the network or a C compiler.
#
# Why the pinned tag: LTP's fsx-linux.c was rewritten in 2023 against LTP's own
# harness (tst_test.h) and no longer builds standalone. The 20230127 tag is the
# last self-contained revision, and it is the classic NeXT/Apple fsx.
#
# Exits 0 and prints a reason when it cannot run (no cc, no network, no FUSE),
# so it stays usable as a CI step on a box that lacks any of those.

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$here")
bin=$root/target/fsx
src=${FSX_SRC:-$root/target/fsx.c}
url=https://raw.githubusercontent.com/linux-test-project/ltp/20230127/testcases/kernel/fs/fsx-linux/fsx-linux.c

mkdir -p "$root/target"

if [ ! -x "$bin" ]; then
	command -v cc >/dev/null 2>&1 || { echo "skipped: no cc to build fsx"; exit 0; }
	if [ ! -f "$src" ]; then
		echo "fetching fsx from LTP 20230127..."
		curl -fsSL -o "$src.tmp" "$url" || {
			rm -f "$src.tmp"
			echo "skipped: could not fetch fsx (no network?)"
			exit 0
		}
		mv "$src.tmp" "$src"
	fi
	# -include libgen.h: the 2023 source calls basename() without including it,
	# which is a hard error under a C99-or-later default (clang 15+, gcc 14+).
	cc -O1 -w -include libgen.h -o "$bin" "$src" || {
		echo "skipped: fsx did not compile here"
		exit 0
	}
fi

echo "using fsx at $bin"
cd "$root"
FSX_BIN=$bin exec cargo test --test fsx -- --nocapture
