//  scad.js: everything of OpenSCAD pages but the plain editor, loaded only
//  when a scad page shows (ui-src/lattice/26-scad.js). Nothing global but
//  window.LatScad. The runtime itself (openscad.js and openscad.wasm) is not
//  in here: the ship serves it, when the owner installed it.
import { mount } from './view.js';
import { shell } from './shell.js';
import { parseParams, rewriteLine, fmtValue, defineArg } from './customizer.js';
import { scanIncludes, resolveRef, collect } from './includes.js';
import { parseStl } from './stl.js';
//  a new scad page: a box with three customizer variables, the same text
//  as tests/scad/customizer/box.scad
import blank from './blank.scad';

window.LatScad = {
  mount,
  //  the scad page's place in the editor (26-scad.js hands it the shell)
  shell,
  blank,
  //  the pure parts, for the suites
  parseParams, rewriteLine, fmtValue, defineArg,
  scanIncludes, resolveRef, collect, parseStl,
};
