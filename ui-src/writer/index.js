//  writer.js entry. Built by scripts/build-writer.mjs into
//  code/nex/lattice/ui-app/writer.js, loaded lazily when a fodt page opens.
//  app.js never imports or waits on this file at boot.
//
//  Phase 1, Task 1: the build, the size budget and the licence gate. The
//  API is stubbed until the writer core (Task 8) and the view (Task 9) land.
//  The ProseMirror modules are bundled now so the budget measures them.

import * as model from 'prosemirror-model';
import * as state from 'prosemirror-state';
import * as view from 'prosemirror-view';
import * as transform from 'prosemirror-transform';
import * as commands from 'prosemirror-commands';
import * as keymap from 'prosemirror-keymap';
import * as history from 'prosemirror-history';
import * as inputrules from 'prosemirror-inputrules';
import * as schemaList from 'prosemirror-schema-list';
import * as tables from 'prosemirror-tables';
import * as dropcursor from 'prosemirror-dropcursor';
import * as gapcursor from 'prosemirror-gapcursor';

const pm = Object.freeze({
  model, state, view, transform, commands, keymap, history,
  inputrules, schemaList, tables, dropcursor, gapcursor,
});

const notYet = (what) => () => { throw new Error('LatWriter.' + what + ' is not built yet'); };

const LatWriter = {
  mount: notYet('mount'),
  render: notYet('render'),
  extract: notYet('extract'),
};
//  internal, not part of the API: the bundled ProseMirror modules, for the
//  writer's own suites. Non-enumerable so nothing iterates into it.
Object.defineProperty(LatWriter, 'pm', { value: pm });

window.LatWriter = LatWriter;
