# Vendored client dependencies for writer.js

`writer.js` is the only lattice client asset with third-party runtime code. The owner approved ProseMirror as that dependency on 2026-11-01 (spec `docs/superpowers/specs/2026-11-01-writer-wysiwyg-design.md`, Decisions 1). `app.js` stays dependency-free and never mentions ProseMirror.

The packages are pinned exact in `scripts/package.json` and locked in `scripts/package-lock.json`. Install them with `npm ci --prefix scripts --no-audit --no-fund --ignore-scripts`, so no install script ever runs. `scripts/build-writer.mjs` bundles them with esbuild into `code/nex/lattice/ui-app/writer.js` and writes `LICENSES` here from the packages that went into the bundle. The same notices head `writer.js`.

| Package | Version | Licence |
| --- | --- | --- |
| prosemirror-model | 1.25.12 | MIT |
| prosemirror-state | 1.4.4 | MIT |
| prosemirror-view | 1.42.9 | MIT |
| prosemirror-transform | 1.12.4 | MIT |
| prosemirror-commands | 1.7.2 | MIT |
| prosemirror-keymap | 1.2.3 | MIT |
| prosemirror-history | 1.5.1 | MIT |
| prosemirror-inputrules | 1.5.1 | MIT |
| prosemirror-schema-list | 1.6.0 | MIT |
| prosemirror-tables | 1.8.5 | MIT |
| prosemirror-dropcursor | 1.8.4 | MIT |
| prosemirror-gapcursor | 1.4.1 | MIT |
| orderedmap (via model) | 2.1.1 | MIT |
| rope-sequence (via history) | 1.3.4 | MIT |
| w3c-keyname (via keymap) | 2.2.8 | MIT |
| esbuild (build only, not bundled) | 0.28.2 | MIT |

`scripts/writer-licences.mjs` fails CI when any bundled package, or anything it depends on, declares a licence outside MIT, ISC, BSD-2-Clause and BSD-3-Clause, when a version is not pinned exact, when `LICENSES` is stale, or when `app.js` mentions ProseMirror.

To upgrade: change the exact versions in `scripts/package.json`, run `npm install --prefix scripts --ignore-scripts`, then `node scripts/build-writer.mjs` and `node scripts/writer-licences.mjs`, update the table above, and commit `package.json`, the lockfile, `LICENSES` and `writer.js` together.
