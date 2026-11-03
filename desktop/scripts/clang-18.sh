#!/bin/sh
# Installs clang 18 and its libclang on an Ubuntu CI runner for the urb
# engine (libmesa is C23, which ubuntu-22.04's clang 14 cannot compile),
# and points the build at them through $GITHUB_ENV. From apt.llvm.org
# when it answers; when it does not (GitHub's runners could not reach it
# on 2026-11-03), from LLVM's own release on GitHub, checked by SHA-256.
set -eu
env_out=${GITHUB_ENV:?GITHUB_ENV is not set: this is for CI}
if wget -q --tries=3 --timeout=30 https://apt.llvm.org/llvm.sh && sudo bash llvm.sh 18; then
  sudo apt-get install -y libclang-18-dev
  echo "CC_x86_64_unknown_linux_gnu=clang-18" >> "$env_out"
  echo "LIBCLANG_PATH=/usr/lib/llvm-18/lib" >> "$env_out"
  exit 0
fi
echo "apt.llvm.org did not answer: LLVM 18.1.8 from its GitHub release"
name=clang+llvm-18.1.8-x86_64-linux-gnu-ubuntu-18.04
sum=54ec30358afcc9fb8aa74307db3046f5187f9fb89fb37064cdde906e062ebf36
dir=${RUNNER_TEMP:-/tmp}/llvm-18
mkdir -p "$dir"
curl -fsSL --retry 3 -o "$dir/llvm.tar.xz" \
  "https://github.com/llvm/llvm-project/releases/download/llvmorg-18.1.8/clang%2Bllvm-18.1.8-x86_64-linux-gnu-ubuntu-18.04.tar.xz"
echo "$sum  $dir/llvm.tar.xz" | sha256sum -c -
# the release was built on 18.04, against ncurses 5
sudo apt-get install -y libtinfo5 || true
tar -xJf "$dir/llvm.tar.xz" -C "$dir" "$name/bin" "$name/lib" "$name/include"
rm "$dir/llvm.tar.xz"
"$dir/$name/bin/clang" --version
echo "CC_x86_64_unknown_linux_gnu=$dir/$name/bin/clang" >> "$env_out"
echo "LIBCLANG_PATH=$dir/$name/lib" >> "$env_out"
