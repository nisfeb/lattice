# The toolchain for the web build: the wasm32 target, python (Rune's
# web-build.sh asks for it) and the wasm-bindgen CLI at the version of
# wasm-bindgen in this crate's Cargo.lock. The two must match.
FROM rust:1.98-slim-bookworm
ARG WASM_BINDGEN=0.2.130
RUN rustup target add wasm32-unknown-unknown \
 && apt-get update -qq && apt-get install -y -qq python3 >/dev/null \
 && cargo install wasm-bindgen-cli --version ${WASM_BINDGEN} --locked \
 && rm -rf /usr/local/cargo/registry /var/lib/apt/lists/*
