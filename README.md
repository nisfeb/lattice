# OpenSCAD runtime for lattice, 2026.11.10

These are the files a lattice ship fetches when its owner installs OpenSCAD for scad pages. They are the same seven files as the release `openscad-2026.11.10` of this repository, byte for byte. Lattice checks each against a SHA-256 pinned in its code before it keeps it.

They are kept on this branch, apart from lattice's own history, because a ship fetches them by a plain address at a fixed commit. A release file's address redirects to a signed one that a ship's HTTP client cannot follow.

- `openscad.wasm.gz` and `openscad.js`: the official OpenSCAD snapshot 2026.11.10, WebAssembly web build. OpenSCAD is under the GNU GPL version 2 or later, with the CGAL exception in `openscad-COPYING.txt`. Its source is at https://github.com/openscad/openscad.
- `LiberationSans-Regular.ttf.gz`, `LiberationSans-Bold.ttf.gz`, `LiberationMono-Regular.ttf.gz`: Liberation Fonts 2.1.5, under the SIL Open Font License 1.1 in `liberation-fonts-LICENSE.txt`.

Do not change a file here. A new runtime is a new branch and a new pin in lattice.
