#!/usr/bin/env node
// Unit tests for smart list continuation (ui-app/src/22-listedit.js).
//
// That file is a single pure function with no DOM and no app state, so it can
// be evaluated straight out of the source and exercised here: no browser, no
// ship, milliseconds. The editor wiring around it is thin by design, which is
// what lets the fiddly part (nesting, mixed markers, renumbering) be tested
// this cheaply.
//
// Usage:  node scripts/ui-listedit.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, '../grubbery-overlay/nex/lattice/ui-app/src/22-listedit.js'), 'utf8');
const listEnter = new Function(`${src}\nreturn listEnter;`)();
const listTab = new Function(`${src}\nreturn listTab;`)();

let fails = 0;
const show = (s) => JSON.stringify(s);

// Drive it the way a keypress does: "|" marks the caret in the input, and the
// expected string carries "|" where the caret must land. Reading a case is
// then the same as reading what you would see on screen.
function press(name, input, want, flavor) {
  const at = input.indexOf('|');
  const value = input.replace('|', '');
  const r = listEnter(value, at, at, flavor);
  let got;
  if (!r) got = input;   // null means Enter does its ordinary thing
  else {
    const out = value.slice(0, r.from) + r.text + value.slice(r.to);
    got = out.slice(0, r.caret) + '|' + out.slice(r.caret);
  }
  if (got === want) console.log('  ok   - ' + name);
  else {
    console.log(`  FAIL - ${name}\n         want ${show(want)}\n         got  ${show(got)}`);
    fails++;
  }
}

console.log('unordered');
press('a dash continues', '- one|', '- one\n- |');
press('a star keeps its star', '* one|', '* one\n* |');
press('a plus keeps its plus', '+ one|', '+ one\n+ |');
press('the indent carries over', '  - one|', '  - one\n  - |');

console.log('\nordered');
press('numbering advances', '1. one|', '1. one\n2. |');
press('a paren delimiter survives', '1) one|', '1) one\n2) |');
press('it counts on from where it is', '7. seven|', '7. seven\n8. |');

console.log('\nsplitting a line');
press('text right of the caret moves down', '- one|two', '- one\n- |two');
press('and keeps its numbering', '1. one|two', '1. one\n2. |two');

console.log('\nleaving the list');
press('an empty item ends it', '- one\n- |', '- one\n|');
press('an empty numbered item ends it', '1. one\n2. |', '1. one\n|');
// stepping out of a nest lands back on the parent's own marker, which is the
// whole point of tracking the parent rather than just deleting the indent
press('an empty nested item steps out', '1. one\n   - a\n   - |', '1. one\n   - a\n2. |');
press('and steps out into a bullet parent', '- one\n  1. a\n  1. |', '- one\n  1. a\n- |');

console.log('\nnesting and mixed markers');
press('a nested bullet stays nested', '1. one\n   - a|', '1. one\n   - a\n   - |');
press('a nested number stays nested', '- one\n  1. a|', '- one\n  1. a\n  2. |');
press('the parent list is untouched by a child',
  '1. one\n   - a|\n2. two', '1. one\n   - a\n   - |\n2. two');

console.log('\nrenumbering');
press('inserting in the middle shifts the rest',
  '1. one|\n2. two\n3. three', '1. one\n2. |\n3. two\n4. three');
press('inserting at the top shifts everything',
  '1. |one\n2. two', '1. \n2. |one\n3. two');
press('a nested list is not renumbered by its parent',
  '1. one|\n2. two\n   1. a\n   2. b', '1. one\n2. |\n3. two\n   1. a\n   2. b');
press('renumbering stops where the list does',
  '1. one|\n2. two\n\nA paragraph.\n\n1. other', '1. one\n2. |\n3. two\n\nA paragraph.\n\n1. other');
press('a bullet at the same level ends the numbering run',
  '1. one|\n2. two\n- other', '1. one\n2. |\n3. two\n- other');

console.log('\nlazy numbering is left alone');
// "1. 1. 1." is valid markdown that renders 1, 2, 3. Rewriting it would be
// editing the document's style, not continuing the list.
press('all-ones stays all ones', '1. one|\n1. two\n1. three',
  '1. one\n1. |\n1. two\n1. three');
press('but a real sequence still renumbers', '1. one|\n2. two',
  '1. one\n2. |\n3. two');

console.log('\ntask lists');
press('a task item continues unchecked', '- [ ] one|', '- [ ] one\n- [ ] |');
press('a ticked item does not pass on its tick', '- [x] one|', '- [x] one\n- [ ] |');

console.log('\nwhen it should stay out of the way');
press('ordinary prose is untouched', 'just a line|', 'just a line|');
press('an empty document is untouched', '|', '|');
press('a heading is not a list', '# title|', '# title|');
press('a fenced block is literal text', '```\n- not a list|', '```\n- not a list|');
press('but a closed fence hands control back', '```\ncode\n```\n- one|', '```\ncode\n```\n- one\n- |');

console.log('\ncaret inside the marker');
// Enter here pushes the item down intact. Continuing would emit a second
// marker or split the marker in half, both of which this once did.
press('at the very start of a bullet line', '|- one', '|- one');
press('at the very start of a numbered line', '|1. one', '|1. one');
press('between the number and its dot', '1|. one', '1|. one');
press('between the dot and the text', '1.| one', '1.| one');
press('inside the leading indent', ' | - one', ' | - one');
press('just past the marker continues normally', '- |one', '- \n- |one');

console.log('\nindentation styles');
press('a tab indent is kept verbatim', '- one\n\t- a|', '- one\n\t- a\n\t- |');
press('four-space nesting', '- one\n    - a|', '- one\n    - a\n    - |');
press('three levels deep', '- a\n  - b\n    - c|', '- a\n  - b\n    - c\n    - |');
press('a wide gap after the marker is preserved', '1.   one|', '1.   one\n2.   |');

console.log('\nnumbering shapes');
press('double digits roll over', '9. nine|', '9. nine\n10. |');
press('crossing into three digits', '99. many|', '99. many\n100. |');
press('a list starting at zero', '0. zero|', '0. zero\n1. |');
press('renumbering repairs a broken sequence',
  '1. one|\n5. five\n9. nine', '1. one\n2. |\n3. five\n4. nine');

console.log('\nnesting interacts with renumbering');
press('a parent renumbers past a whole sub-list',
  '1. one|\n2. two\n   - a\n   - b\n3. three',
  '1. one\n2. |\n3. two\n   - a\n   - b\n4. three');
press('a sub-list keeps its own numbers while the parent shifts',
  '1. one|\n2. two\n   1. a\n   2. b\n3. three',
  '1. one\n2. |\n3. two\n   1. a\n   2. b\n4. three');
press('continuing inside a sub-list renumbers only that sub-list',
  '1. one\n   1. a|\n   2. b\n2. two',
  '1. one\n   1. a\n   2. |\n   3. b\n2. two');

console.log('\nloose lists (blank lines between items)');
press('a blank line does not end the list',
  '1. one|\n\n2. two', '1. one\n2. |\n\n3. two');
press('a bullet loose list continues', '- one|\n\n- two', '- one\n- |\n\n- two');

console.log('\nmixed markers at one level start a new list');
press('a dash after stars stops the run', '* one|\n* two\n- other',
  '* one\n* |\n* two\n- other');
press('numbering stops at a marker change', '1. one|\n2. two\n* other',
  '1. one\n2. |\n3. two\n* other');

console.log('\nordered task lists');
press('a numbered task continues unchecked', '1. [ ] one|', '1. [ ] one\n2. [ ] |');
press('a numbered ticked task resets the box', '1. [x] one|', '1. [x] one\n2. [ ] |');
press('an uppercase tick is still a task', '- [X] one|', '- [X] one\n- [ ] |');

console.log('\nthings that are not list items');
press('a blockquoted list is left alone', '> - one|', '> - one|');
press('an indented continuation paragraph is not an item',
  '- one\n  more text|', '- one\n  more text|');
press('a bare number with no delimiter', '1 one|', '1 one|');
press('a dash with no space is not a marker', '-one|', '-one|');
press('a horizontal rule is not a list', '---|', '---|');
press('a tilde fence also suppresses', '~~~\n- x|', '~~~\n- x|');

console.log('\nwhitespace-only items count as empty');
press('trailing spaces do not make an item non-empty', '- one\n-   |', '- one\n|');

console.log('\nend of document');
press('the last line with no trailing newline', '- one\n- two|', '- one\n- two\n- |');
press('a document that is only a marker', '- |', '|');

console.log('\nEnter over a selection replaces it');
// Two carets mark a selection. Enter must consume ALL of it: a range reaching
// past the last list item was once clamped to the block, so the tail of the
// selection survived being typed over.
function pressRange(name, input, want) {
  const a = input.indexOf('|');
  const b = input.indexOf('|', a + 1) - 1;
  const value = input.replace(/\|/g, '');
  const r = listEnter(value, a, b);
  let got;
  if (!r) got = input;
  else {
    const out = value.slice(0, r.from) + r.text + value.slice(r.to);
    got = out.slice(0, r.caret) + '|' + out.slice(r.caret);
  }
  if (got === want) console.log('  ok   - ' + name);
  else {
    console.log(`  FAIL - ${name}\n         want ${show(want)}\n         got  ${show(got)}`);
    fails++;
  }
}
pressRange('within one item', '- one| tw|o', '- one\n- |o');
pressRange('across two items', '- one|\n- tw|o', '- one\n- |o');
pressRange('reaching past the end of the list',
  '1. one|\n2. two\n\nte|xt here', '1. one\n2. |xt here');
pressRange('reaching past a bullet list', '- one|\n- two\naf|ter', '- one\n- |ter');
pressRange('a selection still renumbers what remains',
  '1. one|\n2. t|wo\n3. three', '1. one\n2. |wo\n3. three');

console.log('\ngemtext is a different grammar, not markdown-lite');
// Gemtext has exactly one list form: "* " at the very start of a line. No
// ordered lists, no nesting, and a leading space makes the line ordinary
// text. Continuing markdown markers here would write characters that gemtext
// renders literally.
const gmi = (n, i, w) => press(n, i, w, 'gmi');
gmi('a star list continues', '* one|', '* one\n* |');
gmi('the gap width is kept', '*   one|', '*   one\n*   |');
gmi('an empty item ends the list', '* one\n* |', '* one\n|');
gmi('text right of the caret moves down', '* one|two', '* one\n* |two');
gmi('a dash is not a gemtext list', '- one|', '- one|');
gmi('a plus is not a gemtext list', '+ one|', '+ one|');
gmi('a number is not a gemtext list', '1. one|', '1. one|');
gmi('an indented star is ordinary text', '  * one|', '  * one|');
gmi('there is no nesting to step out of', '* one\n  * a|', '* one\n  * a|');
gmi('the caret inside the marker defers', '*| one', '*| one');
gmi('a link line is not a list', '=> urb://~zod/x label|', '=> urb://~zod/x label|');
gmi('a heading is not a list', '## title|', '## title|');
gmi('a quote is not a list', '> quoted|', '> quoted|');
gmi('preformatted blocks are literal', '```\n* one|', '```\n* one|');
gmi('a closed preformatted block hands control back',
  '```\ncode\n```\n* one|', '```\ncode\n```\n* one\n* |');

console.log('\nthe same text under markdown rules');
// the contrast is the point: identical input, different grammar
press('a dash IS a markdown list', '- one|', '- one\n- |');
press('a star list also works in markdown', '* one|', '* one\n* |');

// ── Tab / Shift-Tab: indent and outdent ────────────────────────────────────
// Same caret convention as press(). dir +1 is Tab, -1 is Shift-Tab. A "["
// and "]" pair marks a selection instead of a caret.
function tab(name, input, want, dir, flavor = 'md') {
  let selA = input.indexOf('|'), selB = selA, value;
  if (selA === -1) {
    selA = input.indexOf('[');
    selB = input.indexOf(']') - 1;               // after removing "["
    value = input.replace('[', '').replace(']', '');
  } else value = input.replace('|', '');
  const r = listTab(value, selA, selB, flavor, dir);
  let got;
  if (!r) got = input;                           // null: not a list edit
  else {
    const out = value.slice(0, r.from) + r.text + value.slice(r.to);
    if (r.caretEnd == null) got = out.slice(0, r.caret) + '|' + out.slice(r.caret);
    else got = out.slice(0, r.caret) + '[' + out.slice(r.caret, r.caretEnd) + ']' + out.slice(r.caretEnd);
  }
  if (got === want) console.log('  ok   - ' + name);
  else {
    console.log(`  FAIL - ${name}\n         want ${show(want)}\n         got  ${show(got)}`);
    fails++;
  }
}

console.log('\ntab: indent');
tab('an ordered item steps in a level', '1. a\n2. b|', '1. a\n  2. b|', 1);
tab('a dash item steps in', '- a\n- b|', '- a\n  - b|', 1);
tab('caret position rides the shift', '1. a\n2. b|cd', '1. a\n  2. b|cd', 1);
tab('caret in the marker still indents the line', '1. a\n2|. b', '1. a\n  2|. b', 1);
tab('a plain paragraph is not a list edit', 'just text|', 'just text|', 1);
tab('inside a fence, tab stays ordinary', '```\n- x|', '```\n- x|', 1);
tab('a selection starting on a fence-marker line is not a list edit',
  '```\n~~~[1. \n- ]', '```\n~~~[1. \n- ]', 1);   // CI seed 1105911052
tab('gemtext has no nesting', '* one|', '* one|', 1, 'gmi');

console.log('\ntab: outdent');
tab('shift-tab steps back out', '1. a\n  2. b|', '1. a\n2. b|', -1);
tab('a single leading space still comes off', '1. a\n 2. b|', '1. a\n2. b|', -1);
tab('a leading tab is one level', '1. a\n\t2. b|', '1. a\n2. b|', -1);
tab('nothing to take out is not an edit', '1. a|', '1. a|', -1);
tab('caret clamps to the line start', '  - a\n|  - b', '  - a\n|- b', -1);

console.log('\ntab: selections');
tab('a selection indents every list line in it',
  '1. a\n[2. b\n3. c]', '1. a\n[  2. b\n  3. c]', 1);
tab('non-list lines inside the selection stay put',
  '[- a\ntext\n- b]', '[  - a\ntext\n  - b]', 1);
tab('a selection outdents together',
  '[  - a\n  - b]', '[- a\n- b]', -1);

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
