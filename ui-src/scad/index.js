//  scad.js: everything of OpenSCAD pages but the plain editor, loaded only
//  when a scad page shows (ui-src/lattice/26-scad.js). Nothing global but
//  window.LatScad. The runtime itself (openscad.js and openscad.wasm) is not
//  in here: the ship serves it, when the owner installed it.
import { makeRunner } from './runner.js';
import { scanIncludes, resolveRef, collect } from './includes.js';
import { parseStl } from './stl.js';
import { makeViewer } from './viewer.js';
import { parseParams, rewriteLine, fmtValue, defineArg } from './customizer.js';

window.LatScad = {
  //  the worker driver and the include resolver
  makeRunner, scanIncludes, resolveRef, collect,
  //  the STL reader and the WebGL viewer
  parseStl, makeViewer,
  //  the customizer
  parseParams, rewriteLine, fmtValue, defineArg,
};
