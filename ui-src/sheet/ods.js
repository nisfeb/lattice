//  ods.js: spreadsheets in and out of lattice as files.
//
//  .ods is the same zip package as .odt with another mimetype, so the
//  Writer core's packer does it (ui-src/writer/odt.js). .csv is read into
//  a blank spreadsheet through the Book, so a value typed in a CSV lands
//  as the same cell it would if typed into the grid, and written from the
//  cells' shown text.

import { importPackage, exportPackage, ODS } from '../writer/odt.js';
import { Book } from './book.js';
import blank from './blank.fods';

export const importOds = (buf) => importPackage(buf, ODS);
export const exportOds = (text) => exportPackage(text, ODS);

//  RFC 4180, forgiving: quoted fields, doubled quotes, CR LF or LF. A
//  semicolon or a tab is taken as the separator when the first line has
//  more of them than commas.
export function parseCsv(src) {
  const text = String(src ?? '').replace(/^﻿/, '');
  const first = text.split('\n', 1)[0];
  const count = (ch) => first.split(ch).length - 1;
  const sep = count('\t') > count(',') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  const L = text.length;
  while (i < L) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === sep) { row.push(field); field = ''; i++; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export const CSV_MAX_CELLS = 20000;

//  importCsv(string) -> { text, note } | { error }: a new spreadsheet
//  holding the CSV's cells. A field that starts with = is kept as text:
//  a file from somewhere else does not get to run formulas here.
export function importCsv(src) {
  const rows = parseCsv(src);
  const cells = rows.reduce((n, r) => n + r.length, 0);
  if (cells > CSV_MAX_CELLS) {
    return { error: `This CSV has ${cells} cells. A spreadsheet page holds about ${CSV_MAX_CELLS} before it is too large to edit here, so it was not imported.` };
  }
  const book = new Book(blank);
  if (book.error) return { error: 'This CSV cannot be imported.' };
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v !== '') book.enter(0, r, c, v[0] === '=' || v[0] === "'" ? "'" + v : v);
  }));
  return { text: book.text(), note: '' };
}

const q = (s) => (/[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
//  exportCsv(fods text, sheet index) -> { text } | { error }: the sheet's
//  cells as shown. A text cell that begins with = + - or @ gets a leading
//  apostrophe, so a spreadsheet program opening the CSV does not run it.
export function exportCsv(text, sheet = 0) {
  const book = new Book(String(text ?? ''));
  if (book.error) return { error: 'This spreadsheet cannot be exported: ' + book.error + '.' };
  const s = Math.max(0, Math.min(sheet, book.sheets.length - 1));
  const [rows, cols] = book.extent(s);
  const out = [];
  for (let r = 0; r < rows; r++) {
    const line = [];
    for (let c = 0; c < cols; c++) {
      const cell = book.cell(s, r, c);
      let t = cell.covered ? '' : cell.text;
      if (cell.vt === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
      line.push(q(t));
    }
    out.push(line.join(','));
  }
  return { text: out.join('\r\n') + (out.length ? '\r\n' : '') };
}
