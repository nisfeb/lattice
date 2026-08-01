{
  description = "lattice — desktop client for the lattice nexus";

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

          buildAndTestSubdir = "desktop";
          cargoLock.lockFile = ./desktop/Cargo.lock;

          nativeBuildInputs = with pkgs; [
            pkg-config
            # wraps the binary so webkit finds its GIO modules and GSettings
            # schemas at runtime; without it the window comes up blank.
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
          # and on Linux that means no libfuse at build time — it shells out to
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
            # Darwin is absent on purpose: mounting needs macFUSE, a kernel
            # extension nixpkgs cannot ship. Use the .dmg from a release.
            platforms = platforms.linux;
          };
        };
      });

      devShells = forSystems allSystems (pkgs: {
        default = pkgs.mkShell {
          # Everything the desktop crate, the FUSE client and the test suites
          # need — so `nix develop` replaces the apt/brew preamble in the README.
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
