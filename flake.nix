{
  description = "lattice — desktop client for the lattice nexus";

  # flake.lock pins the revision, so a build is reproducible; move it on
  # purpose with `nix flake update` (and let CI build the result).
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      # Hand-rolled rather than pulling in flake-utils: two lines, one fewer
      # input to keep pinned.
      linuxSystems = [ "x86_64-linux" "aarch64-linux" ];
      # No x86_64-darwin: nixpkgs 26.11 dropped it, and `nix flake check
      # --all-systems` evaluates every system listed, so naming it fails the
      # check outright. Intel macs take the .dmg from a release.
      allSystems = linuxSystems ++ [ "aarch64-darwin" ];
      forSystems = systems: f:
        nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));

      # Single source of truth for the version: the same file the release
      # workflow's tag guard reads, so a flake build and a tagged bundle can
      # never disagree about what they are.
      version = (builtins.fromJSON (builtins.readFile ./desktop/tauri.conf.json)).version;
    in
    {
      packages = forSystems linuxSystems (pkgs: rec {
        default = lattice-desktop;

        # urb-fetch, the urb engine's git source, with its libmesa submodule.
        # mesa-sys's build script reads libmesa from the checkout around the
        # crate (../../third_party/libmesa), which cargo's git checkout has
        # and nix's vendored copy of the one crate does not, so the build
        # links it in beside the vendor folder (preBuild, below).
        urb-fetch-src = pkgs.fetchgit {
          url = "https://github.com/nisfeb/urb-fetch.git";
          rev = "3f584bf3567dd8c8e80365197994b6330cb95338";
          fetchSubmodules = true;
          hash = pkgs.lib.fakeHash;
        };

        # The two C sources mesa-sys compiles into the urb engine, as
        # urb-fetch's core/mesa-sys/fetch-deps.sh fetches them (same URLs,
        # same SHA-256s), unpacked into the folder MESA_SYS_DEPS names.
        mesa-deps = pkgs.runCommand "mesa-sys-deps" {
          urcrypt = pkgs.fetchurl {
            url = "https://github.com/urbit/urcrypt/archive/a4c229e9380636ace36325b6c8fe04eaee32a2ef.tar.gz";
            sha256 = "a2a0cadf9b982a0e0aa12d22c27bdc76d8a25834f7f578b1f2b11c8b950e4ee5";
          };
          sqlite = pkgs.fetchurl {
            url = "https://www.sqlite.org/2024/sqlite-autoconf-3460100.tar.gz";
            sha256 = "67d3fe6d268e6eaddcae3727fce58fcc8e9c53869bdd07a0c61e38ddf2965071";
          };
        } ''
          mkdir -p $out/urcrypt $out/sqlite
          tar -xzf $urcrypt -C $out/urcrypt --strip-components=1
          tar -xzf $sqlite -C $out/sqlite --strip-components=1
        '';

        lattice-desktop = pkgs.rustPlatform.buildRustPackage {
          pname = "lattice-desktop";
          inherit version;

          # Only the two crates. `src = ./.` would drag in .git, node_modules
          # and target/, which is both slow and a rebuild trigger on every
          # unrelated file.
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./desktop ./lattice-fs-rs ];
          };

          # buildRustPackage looks for Cargo.lock at the SOURCE ROOT, and ours
          # lives in desktop/ (the two crates are separate, not a workspace).
          # Rooting at desktop/ finds it, and the ../lattice-fs-rs path
          # dependency still resolves because it is a sibling inside src.
          sourceRoot = "source/desktop";
          cargoLock = {
            lockFile = ./desktop/Cargo.lock;
            # urb-fetch, the urb engine's git source (all its crates are one
            # checkout). fetchgit brings the libmesa submodule with it.
            outputHashes = {
              "urb-0.0.1" = urb-fetch-src.outputHash;
            };
          };

          # the vendored mesa-sys is at $NIX_BUILD_TOP/cargo-vendor-dir/<crate>,
          # so ../.. is $NIX_BUILD_TOP
          preBuild = ''
            ln -sfn ${urb-fetch-src}/third_party "$NIX_BUILD_TOP/third_party"
            ln -sfn ${urb-fetch-src}/wasm "$NIX_BUILD_TOP/wasm"
          '';

          # libmesa is C23 and built by clang (mesa-sys asks for it when no
          # CC is named, but stdenv names gcc); bindgen reads its headers
          MESA_SYS_DEPS = mesa-deps;
          "CC_${builtins.replaceStrings [ "-" ] [ "_" ] pkgs.stdenv.hostPlatform.rust.rustcTarget}" = "clang";

          nativeBuildInputs = with pkgs; [
            pkg-config
            clang
            rustPlatform.bindgenHook
            # wraps the binary so webkit finds its GIO modules and GSettings
            # schemas at runtime. Without it the window comes up blank.
            wrapGAppsHook3
          ];

          buildInputs = with pkgs; [
            glib
            gtk3
            webkitgtk_4_1
            libsoup_3
            openssl
            librsvg
            libayatana-appindicator
          ];

          # NB: no fuse here. fuser is pulled in with default-features = false,
          # and on Linux that means no libfuse at build time. It shells out to
          # fusermount3 at RUNTIME instead. (macOS is the exception, which is
          # part of why this package is Linux-only.) fuse3 is a runtime
          # dependency for mounting, not a build one.

          # The bridge tests bind 127.0.0.1 on a fixed port. The nix sandbox
          # gives each build its own network namespace with loopback, so this
          # is safe and cannot collide with a concurrent build.
          doCheck = true;

          meta = with pkgs.lib; {
            description = "Desktop client for lattice: the web UI served live from your ship, plus FUSE mounts";
            homepage = "https://github.com/nisfeb/lattice";
            license = licenses.mit;
            mainProgram = "lattice-desktop";
            # Darwin is absent on purpose. Mounting needs macFUSE, a kernel
            # extension nixpkgs cannot ship. Use the .dmg from a release.
            platforms = platforms.linux;
          };
        };
      });

      devShells = forSystems allSystems (pkgs: {
        default = pkgs.mkShell {
          # Everything the desktop crate, the FUSE client and the test suites
          # need, so `nix develop` replaces the apt/brew preamble in the README.
          nativeBuildInputs = with pkgs; [
            pkg-config
            rustc
            cargo
            rustfmt
            clippy
            nodejs                 # build-ui.mjs + the puppeteer suites
            cargo-tauri            # `cargo tauri dev` / `build`
          ];
          buildInputs = with pkgs; [
            glib
            gtk3
            webkitgtk_4_1
            libsoup_3
            openssl
            librsvg
            libayatana-appindicator
            fuse3                  # runtime: mounting via fusermount3
          ];
        };
      });

      formatter = forSystems allSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
