//  sheet.js entry. Built by scripts/build-sheet.mjs into
//  code/nex/lattice/ui-app/sheet.js, loaded lazily when a fods page
//  opens. app.js never imports or waits on this file at boot.
//
//  The shell (ui-src/lattice/26-writer.js) mounts it over the editor when
//  a spreadsheet page is open, the same way it mounts the Writer editor.
//  The grid, the flat ODS model and the formula engine are lattice's own.
//  The one third-party package is tiny-inflate, for reading .ods files.

import { mount, render, fodsText, fodsOutline } from './view.js';
import { Book } from './book.js';
import { parseFods, serializeFods } from './model.js';
import { toUser, toOf } from './formula.js';
import { importOds, exportOds, importCsv, exportCsv } from './ods.js';
//  a new spreadsheet: LibreOffice's own empty document, saved by
//  LibreOffice, with its default styles defined
import blank from './blank.fods';

const NOSHOW = 'This spreadsheet cannot be shown here.';

if (typeof customElements !== 'undefined' && !customElements.get('lat-sheet')) {
  customElements.define('lat-sheet', class extends HTMLElement {});
}

const LatSheet = {
  //  mount(host, opts) -> controller | { error }, view.js
  mount,
  //  render(text) -> an HTML document string | null
  render,
  //  show(text) -> render's document, or one saying it cannot be shown
  show: (t) => { try { return render(t) || NOSHOW; } catch { return NOSHOW; } },
  blank,
  //  importOds(ArrayBuffer) -> Promise<{ text } | { error }>,
  //  exportOds(text) -> { blob } | { error }, importCsv(string) -> { text },
  //  exportCsv(text, sheetIndex) -> { text } | { error }, ods.js
  importOds, exportOds, importCsv, exportCsv,
  //  the words and the sheet names of a body (search, outline). A
  //  spreadsheet has no outgoing links lattice lists.
  extract: Object.freeze({ text: fodsText, outline: fodsOutline, links: () => [], out: () => [] }),
};
//  internal, not part of the API: the core, for the view's suites
Object.defineProperty(LatSheet, 'core', { value: Object.freeze({ Book, parseFods, serializeFods, toUser, toOf }) });

window.LatSheet = LatSheet;
