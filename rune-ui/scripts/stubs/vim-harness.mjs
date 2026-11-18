// Runs ui-src/lattice/27-vim.js against a stand-in textarea, and writes what each key sequence comes to.
import fs from 'node:fs';
let src = fs.readFileSync(process.argv[2], 'utf8');
// VIM_AS_IS=1 runs the module untouched. Otherwise one line of it is mended first: asked for the start of
// the line at place 0, it answers 1 when the text begins with a newline (lastIndexOf from -1 looks at 0)
if (!process.env.VIM_AS_IS) {
  const was = 'function lineStart(p){ var v = val();';
  if (!src.includes(was)) throw new Error('lineStart is not where it was');
  src = src.replace(was, 'function lineStart(p){ if(p <= 0) return 0; var v = val();');
}
function make() {
  const el = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, appendChild() {}, insertBefore() {}, addEventListener() {}, textContent: '', hidden: false, parentNode: null });
  const listeners = {};
  const ta = Object.assign(el(), {
    value: '', selectionStart: 0, selectionEnd: 0, readOnly: false,
    focus() {}, dispatchEvent() {},
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    setRangeText(text, a, b) { this.value = this.value.slice(0, a) + text + this.value.slice(b); this.selectionStart = this.selectionEnd = a + text.length; },
  });
  ta.parentNode = el();
  const status = el(); status.parentNode = el();
  const save = el(); let saves = 0; save.onclick = () => { saves++; };
  let ind = null;
  const document = {
    activeElement: null,
    getElementById: (id) => id === 'src' ? ta : id === 'status' ? status : id === 'save' ? save : null,
    createElement: () => { const e = el(); if (!ind) ind = e; return e; },
    execCommand: () => false, addEventListener() {}, body: el(), fonts: null,
  };
  const window = { addEventListener() {} };
  const localStorage = { getItem: () => '1' };
  const fn = new Function('document', 'window', 'localStorage', 'requestAnimationFrame', 'getComputedStyle', 'Event',
    'var hl = null, hlPainted = null, pkind = { value: "md" }, isRich = () => false;\n' + src);
  fn(document, window, localStorage, () => 0, () => ({}), function () {});
  return { ta, key: listeners.keydown[0], ind: () => ind.textContent, status: () => status.textContent, saves: () => saves };
}
// a key as the corpus writes it: a character, a name, or C-x for Ctrl
function ev(k) {
  const ctrl = k.startsWith('C-') && k.length > 2;
  return { key: ctrl ? k.slice(2) : k, ctrlKey: ctrl, metaKey: false, altKey: false, dp: false, preventDefault() { this.dp = true; }, stopImmediatePropagation() {} };
}
function run(text, pos, keys) {
  const m = make();
  m.ta.value = text; m.ta.selectionStart = m.ta.selectionEnd = pos;
  for (const k of keys) {
    const e = ev(k);
    m.key(e);
    if (e.dp) continue;
    // not taken: the textarea's own typing, as a browser does it
    const t = m.ta, a = t.selectionStart, b = t.selectionEnd;
    const put = (s) => { t.value = t.value.slice(0, a) + s + t.value.slice(b); t.selectionStart = t.selectionEnd = a + s.length; };
    if (e.ctrlKey) continue;
    if (e.key.length === 1) put(e.key);
    else if (e.key === 'Enter') put('\n');
    else if (e.key === 'Backspace') { if (a !== b) put(''); else if (a > 0) { t.value = t.value.slice(0, a - 1) + t.value.slice(a); t.selectionStart = t.selectionEnd = a - 1; } }
  }
  return { text, pos, keys, out: m.ta.value, s: m.ta.selectionStart, e: m.ta.selectionEnd, ind: m.ind(), saves: m.saves(), status: m.status() };
}
const cases = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
fs.writeFileSync(process.argv[4], cases.map(([t, p, k]) => JSON.stringify(run(t, p, k))).join('\n') + '\n');
console.log(cases.length, 'cases');
