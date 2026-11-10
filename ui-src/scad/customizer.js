//  customizer.js: OpenSCAD's customizer parameters, read from the source in
//  JS, and the one-line rewrite a change makes.
//
//  The rules follow OpenSCAD's own parser, and scripts/scad-unit.mjs checks
//  them against what OpenSCAD itself exports (--export-format param) for
//  the fixtures in tests/scad/customizer. In short:
//
//    - a parameter is a top-level assignment of a literal: a number, a
//      string, true or false, or a vector of up to four numbers. Anything
//      computed is not one.
//    - parameters stop at the first module or function definition.
//    - `/* [Name] */` starts a group. [Hidden] hides what follows, and
//      [Global] is shown with every group.
//    - the comment on the same line says the widget: `// [10:100]` a
//      slider, `// [0:5:100]` one with a step, `// [a, b, c]` a list,
//      `// [10:Small, 20:Large]` a labelled list, `// 2` a step, and for a
//      string `// 12` its longest length.
//    - a `//` comment on the line just above is the description.
//
//  Each parameter keeps where its value sits on its line, so a change
//  rewrites only those characters. Before writing, the caller checks the
//  line still reads as it did (lineSame), as task boxes do.

const NUM = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

//  the code of a line with its comments and strings blanked, for brace
//  counting and the module test. `st` carries a block comment over lines.
function codeOf(line, st) {
  let out = '', i = 0;
  while (i < line.length) {
    if (st.block) {
      const e = line.indexOf('*/', i);
      if (e < 0) return out;
      st.block = false; i = e + 2; continue;
    }
    const c = line[i];
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '/' && line[i + 1] === '*') { st.block = true; i += 2; continue; }
    if (c === '"') {
      i++;
      while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
      i++; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}

//  a string literal's text, with OpenSCAD's escapes: \\ \" \n \t \r
//  \xNN and \uNNNN. Any other backslash stays as written.
function unquote(t) {
  return t.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (m, e) => {
    if (e === 'n') return '\n';
    if (e === 't') return '\t';
    if (e === 'r') return '\r';
    if (e === '"' || e === '\\') return e;
    if (e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    return m;
  });
}

//  a literal's value, or undefined. Vectors are numbers only, at most four.
export function parseLiteral(t) {
  t = t.trim();
  if (NUM.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return unquote(t);
  const v = /^\[(.*)\]$/.exec(t);
  if (v) {
    const parts = v[1].trim() === '' ? [] : v[1].split(',').map((s) => s.trim());
    if (!parts.length || parts.length > 4 || !parts.every((p) => NUM.test(p))) return undefined;
    return parts.map(Number);
  }
  return undefined;
}

//  split a top-level line into its assignments: name, the value's text and
//  where it sits, and the trailing comment
function assignments(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    while (i < n && /\s/.test(line[i])) i++;
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*/u.exec(line.slice(i));
    if (!m) break;
    const vs = i + m[0].length;
    //  the value runs to the first ; outside a string or brackets
    let j = vs, depth = 0;
    while (j < n) {
      const c = line[j];
      if (c === '"') { j++; while (j < n && line[j] !== '"') j += line[j] === '\\' ? 2 : 1; j++; continue; }
      if (c === '[' || c === '(') depth++;
      else if (c === ']' || c === ')') depth--;
      else if (c === ';' && depth === 0) break;
      j++;
    }
    if (j >= n) break;
    let ve = j;
    while (ve > vs && /\s/.test(line[ve - 1])) ve--;
    out.push({ name: m[1], vs, ve, text: line.slice(vs, ve) });
    i = j + 1;
  }
  const rest = line.slice(i);
  const cm = /^\s*\/\/(.*)$/.exec(rest);
  return { list: out, comment: cm ? cm[1] : null, clean: !rest.trim() || !!cm };
}

//  a number OpenSCAD reads from a widget comment
const num = (s) => (NUM.test(s.trim()) ? Number(s.trim()) : NaN);

//  the widget a comment names for a value
function widget(val, comment) {
  const w = {};
  if (comment === null) return w;
  const c = comment.trim();
  const br = /^\[([^\]]*)\]$/.exec(c);
  if (!br) {
    //  a bare number: a number's step, a string's longest length
    if (NUM.test(c)) {
      if (typeof val === 'number') w.step = Number(c);
      else if (typeof val === 'string') w.maxLength = Number(c);
    }
    return w;
  }
  const body = br[1];
  //  a slider: [max], [min:max] or [min:step:max], numbers only
  const parts = body.split(':');
  const isNum = typeof val === 'number' || Array.isArray(val);
  if (isNum && !body.includes(',') && parts.every((p) => !Number.isNaN(num(p)))) {
    if (parts.length === 1) { w.min = 0; w.max = num(parts[0]); w.step = 1; return w; }
    if (parts.length === 2) { w.min = num(parts[0]); w.max = num(parts[1]); w.step = 1; return w; }
    if (parts.length === 3) { w.min = num(parts[0]); w.step = num(parts[1]); w.max = num(parts[2]); return w; }
  }
  //  a list: [a, b, c] or [value:label, ...]
  if (typeof val === 'number' || typeof val === 'string') {
    const items = body.split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (!items.length) return w;
    const opts = [];
    for (const it of items) {
      const k = it.indexOf(':');
      //  a quoted choice is its text
      const uq = (x) => (/^".*"$/.test(x) ? x.slice(1, -1) : x);
      const v = uq(k < 0 ? it : it.slice(0, k).trim());
      const label = uq(k < 0 ? it : it.slice(k + 1).trim());
      const nv = num(v);
      //  a number's choices are numbers, or it has none
      if (typeof val === 'number' && Number.isNaN(nv)) return w;
      opts.push({ value: Number.isNaN(nv) ? v : nv, name: Number.isNaN(nv) || k >= 0 ? label : String(nv) });
    }
    //  the value in the source is always one of the choices, first if it
    //  is not in the list
    if (!opts.some((o) => o.value === val)) opts.unshift({ value: val, name: String(val) });
    w.options = opts;
  }
  return w;
}

//  every parameter in `src`, in order, with groups. Hidden ones are left
//  out. Each: { name, line, vs, ve, value, type, group, description,
//  min, max, step, options, maxLength, raw }
export function parseParams(src) {
  const lines = String(src).split('\n');
  const st = { block: false };
  const out = [];
  let group = 'Parameters', depth = 0, desc = null;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].replace(/\r$/, '');
    const wasBlock = st.block;
    const code = codeOf(line, st);
    const g = /^\s*\/\*\s*\[([^\]]*)\]\s*\*\/\s*$/.exec(line);
    if (!wasBlock && g && depth === 0) { group = g[1].trim(); desc = null; continue; }
    if (depth === 0 && !wasBlock && /^\s*(module|function)\b/.test(code)) break;
    if (depth === 0 && !wasBlock) {
      const dm = /^\s*\/\/(.*)$/.exec(line);
      if (dm) { desc = dm[1].trim(); continue; }
      const a = assignments(line);
      if (a.list.length) {
        a.list.forEach((x, k) => {
          const value = parseLiteral(x.text);
          if (value === undefined || !IDENT.test(x.name)) return;
          if (group.toLowerCase() === 'hidden') return;
          const last = k === a.list.length - 1;
          const p = { name: x.name, line: ln, vs: x.vs, ve: x.ve, raw: x.text, value,
            type: typeof value === 'boolean' ? 'boolean' : typeof value === 'string' ? 'string' : 'number',
            group, description: k === 0 ? desc || '' : '' };
          //  only a line with one assignment takes the comment's widget
          Object.assign(p, last && a.list.length === 1 ? widget(value, a.comment) : {});
          if (p.type === 'number' && !Array.isArray(value) && !p.options && p.min === undefined && p.step === undefined) p.step = 1;
          out.push(p);
        });
      }
      desc = line.trim() === '' ? desc : null;
      if (line.trim() === '') desc = null;
    }
    for (const c of code) { if (c === '{') depth++; else if (c === '}') depth = Math.max(0, depth - 1); }
  }
  //  a name assigned twice keeps its last line, as OpenSCAD's value is
  const last = new Map();
  for (const p of out) last.set(p.name, p);
  return out.filter((p) => last.get(p.name) === p);
}

//  a value as OpenSCAD source
export function fmtValue(v, step) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  if (Array.isArray(v)) return '[' + v.map((x) => fmtValue(x, step)).join(', ') + ']';
  if (!Number.isFinite(v)) return '0';
  //  as many decimals as the step has, so a 0.1 slider writes 2.3, not
  //  2.3000000000000003
  const d = step && !Number.isInteger(step) ? Math.min(10, (String(step).split('.')[1] || '').length) : 0;
  const r = d ? Number(v.toFixed(d)) : (Number.isInteger(v) ? v : Number(v.toPrecision(12)));
  return String(r);
}

//  the line with this parameter's value replaced, or null when the line no
//  longer holds the value the parameter was read from
export function rewriteLine(line, p, v) {
  if (line.slice(p.vs, p.ve) !== p.raw) return null;
  return line.slice(0, p.vs) + fmtValue(v, p.step) + line.slice(p.ve);
}

//  OpenSCAD's -D argument for a value
export const defineArg = (p, v) => p.name + '=' + fmtValue(v, p.step);
