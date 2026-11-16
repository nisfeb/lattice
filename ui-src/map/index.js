//  map.js entry. Built by scripts/build-map.mjs into
//  code/nex/lattice/ui-app/map.js, loaded lazily when a geojson page
//  opens. app.js never imports or waits on this file at boot.
//
//  The shell (ui-src/lattice/26-writer.js) mounts it over the editor when
//  a map page is open, the same way it mounts the grid. The drawing tools
//  and the page format are lattice's own. The third-party packages are
//  Leaflet, mgrs (the MGRS readout) and @tmcw/togeojson (GPX and KML).

import { mount } from './view.js';
import { parse, serialize, props, view, title, text, outline, render, simplify, dp, sourceLink, BLANK } from './core.js';
import { importText, exportGpx, fileKind } from './io.js';

const NOSHOW = '<!doctype html><html><head><meta charset="utf-8"></head><body><p>This map cannot be shown.</p></body></html>';

if (typeof customElements !== 'undefined' && !customElements.get('lat-map')) {
  customElements.define('lat-map', class extends HTMLElement {});
}

const LatMap = {
  //  mount(host, opts) -> controller | { error }, view.js
  mount,
  //  render(text) -> an HTML document string (no tiles) | null
  render,
  //  show(text) -> render's document, or one saying it cannot be shown
  show: (t) => { try { return render(t) || NOSHOW; } catch { return NOSHOW; } },
  blank: BLANK,
  //  the words and the feature names of a body (search, outline). A map
  //  has no outgoing links lattice lists.
  extract: Object.freeze({ text, outline, links: () => [], out: () => [] }),
};
//  internal, not part of the API: the core, for the suites
Object.defineProperty(LatMap, 'core', {
  value: Object.freeze({ parse, serialize, props, view, title, simplify, dp, sourceLink, importText, exportGpx, fileKind }),
});

window.LatMap = LatMap;
