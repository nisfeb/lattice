//! Rows put into a sheet and taken out of it: a port of the web
//! client's `shift` in `ui-src/sheet/book.js`.
//!
//! The rows move in the page's text, every reference that pointed past
//! them is spelled again, in formulas and in the attributes that hold
//! addresses, and a page holding something lattice cannot keep in step
//! is refused whole.

use crate::formula::{self, Op};
use crate::odf::{attrs, El};
use crate::sheet::{self, attr, copy, count, esc_attr, kids, Put, Val, COLS, ROWS};
use std::collections::BTreeMap;

const MAX_ROWS: i64 = 1_048_576;
const MAX_COLS: i64 = 16_384;

/// The attributes holding addresses that are rewritten: element, then
/// each attribute and whether it is a formula and not an address list.
const MOVES: [(&str, &[(&str, bool)]); 8] = [
    ("table:named-range", &[("table:cell-range-address", false), ("table:base-cell-address", false)]),
    ("table:named-expression", &[("table:base-cell-address", false), ("table:expression", true)]),
    ("table:database-range", &[("table:target-range-address", false)]),
    ("table:table", &[("table:print-ranges", false)]),
    ("calcext:conditional-format", &[("calcext:target-range-address", false)]),
    ("calcext:condition", &[("calcext:base-cell-address", false), ("calcext:value", true)]),
    ("calcext:color-scale-entry", &[("calcext:value", true)]),
    ("table:content-validation", &[("table:base-cell-address", false), ("table:condition", true)]),
];

/// Elements that hold ranges lattice does not rewrite. With one of
/// these in the page, rows and columns cannot move.
const BLOCKS: [(&str, &str); 9] = [
    ("table:data-pilot-table", "a pivot table"),
    ("draw:object", "a chart or an embedded object"),
    ("table:scenario", "a scenario"),
    ("table:tracked-changes", "recorded changes"),
    ("table:detective", "a detective trace"),
    ("table:consolidation", "a consolidation"),
    ("table:cell-range-source", "a linked range"),
    ("table:table-source", "a linked sheet"),
    ("chart:chart", "a chart"),
];

fn moves(name: &str) -> &'static [(&'static str, bool)] {
    MOVES.iter().find(|(n, _)| *n == name).map_or(&[], |(_, list)| list)
}

/// Whether an attribute's name says it holds cell addresses.
fn rangeish(name: &str) -> bool {
    let local = name.rsplit(':').next().unwrap_or(name);
    let plain = local.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
    matches!(local, "print-ranges" | "notify-on-update-of-ranges" | "cell-ranges" | "buttons") || (plain && (local.contains("cell-range-address") || local.ends_with("range-address") || local.ends_with("cell-address")))
}

fn tag<'a>(src: &'a str, el: &El) -> &'a str {
    &src[el.start..el.open_end]
}

/// Refuses an element that holds ranges lattice does not rewrite, and looks through what it holds.
fn check(src: &str, k: &El) -> Result<(), String> {
    if let Some((_, what)) = BLOCKS.iter().find(|(n, _)| *n == k.name) {
        return Err(format!("this spreadsheet has {what}, which lattice cannot keep in step"));
    }
    let known = moves(&k.name);
    for (a, _) in attrs(tag(src, k)) {
        if rangeish(a) && !known.iter().any(|(x, _)| *x == a) && a != "table:end-cell-address" {
            let local = k.name.split_once(':').map_or(k.name.as_str(), |(_, l)| l);
            return Err(format!("this spreadsheet has a {} lattice cannot keep in step", local.replace('-', " ")));
        }
    }
    if k.name != "table:table-row" {
        return walk(src, k);
    }
    // inside rows only shapes carry addresses
    for cell in kids(src, k)? {
        for x in kids(src, &cell)?.iter().filter(|x| x.name.starts_with("draw:")) {
            check(src, x)?;
        }
    }
    Ok(())
}

fn walk(src: &str, el: &El) -> Result<(), String> {
    kids(src, el)?.iter().try_for_each(|k| check(src, k))
}

fn body(src: &str) -> Result<El, String> {
    let root = crate::odf::elements(src, 0, src.len())?.into_iter().find(|e| e.name == "office:document").ok_or("this is not a spreadsheet lattice can change")?;
    kids(src, &root)?.into_iter().find(|e| e.name == "office:body").ok_or_else(|| "this is not a spreadsheet lattice can change".to_owned())
}

/// Why rows (or columns) cannot be put in (`n` above nothing) or taken
/// out (`n` below it) at `at` on a sheet. Nothing is wrong when they can.
pub fn blocked(src: &str, s: usize, rows: bool, at: i64, n: i64) -> Result<(), String> {
    let book = sheet::book(src)?;
    let cnt = n.abs();
    let Some(sh) = book.sheets.get(s) else { return Err("nothing to do".into()) };
    if cnt < 1 || at < 0 {
        return Err("nothing to do".into());
    }
    if at + cnt > if rows { MAX_ROWS } else { MAX_COLS } {
        return Err("that is past the edge of the sheet".into());
    }
    walk(src, &body(src)?)?;
    // a merged cell the change would cut through
    let (_, els, _) = sheet::sheet_rows(src, s)?;
    let mut r = 0;
    for row in &els {
        let rep = count(src, row, ROWS) as i64;
        let mut c = 0;
        for cell in kids(src, row)? {
            let (cs, rs) = (count(src, &cell, "table:number-columns-spanned") as i64, count(src, &cell, "table:number-rows-spanned") as i64);
            if cs > 1 || rs > 1 {
                for i in 0..rep.min(1024) {
                    let (lo, span) = if rows { (r + i, rs) } else { (c, cs) };
                    let hi = lo + span - 1;
                    let cut = (lo < at && hi >= at) || (n < 0 && lo >= at && lo < at + cnt && hi >= at + cnt);
                    if cut {
                        return Err("that would cut through a merged cell".into());
                    }
                }
            }
            c += count(src, &cell, COLS) as i64;
        }
        r += rep;
    }
    // every formula must be one lattice can move
    let op = Op { sheet: &sh.name, rows, at, n };
    for other in &book.sheets {
        for f in other.rows.iter().flat_map(|row| &row.cells).filter_map(|c| c.f.as_ref()) {
            if formula::body_of(f).is_some() && formula::move_formula(f, &other.name, &op).is_none() {
                return Err("a formula here is one lattice cannot read, so it cannot be moved safely".into());
            }
        }
    }
    Ok(())
}

/// The spaces before an element that starts its line, and none when it does not.
fn indent(src: &str, at: usize) -> usize {
    let b = src.as_bytes();
    let mut i = at;
    while i > 0 && b[i - 1] == b' ' {
        i -= 1;
    }
    if i > 0 && b[i - 1] != b'\n' { 0 } else { at - i }
}

/// The address attributes outside the cells, spelled again after the change.
fn fix(src: &str, el: &El, in_table: Option<&str>, op: &Op, out: &mut Vec<(usize, usize, String)>) -> Result<(), String> {
    // a reference with no sheet of its own, on no sheet lattice can name, is left alone
    const NOWHERE: &str = "\0";
    for k in kids(src, el)? {
        let t = tag(src, &k);
        let named = attr(&t[1..], "table:name");
        let table: Option<&str> = if k.name == "table:table" { Some(named.as_deref().unwrap_or(NOWHERE)) } else { in_table };
        let based = table.is_none().then(|| {
            let base = attr(&t[1..], "table:base-cell-address").filter(|b| !b.is_empty()).or_else(|| attr(&t[1..], "calcext:base-cell-address")).unwrap_or_default();
            match formula::parse_addrs(&base).and_then(|l| l.into_iter().next()) {
                Some(formula::Ref::Cells { a, .. }) => a.sheet,
                _ => None,
            }
        });
        let home = table.or(based.as_ref().and_then(|b| b.as_deref())).unwrap_or(NOWHERE);
        let had = attrs(t);
        let mut list = moves(&k.name).to_vec();
        if had.iter().any(|(a, _)| *a == "table:end-cell-address") {
            list.push(("table:end-cell-address", false));
        }
        for (a, expr) in list {
            let Some((_, at)) = had.iter().find(|(x, _)| *x == a) else { continue };
            let Some(val) = attr(&t[1..], a) else { continue };
            let next = if !expr {
                formula::move_addrs(&val, op, home)
            } else if !val.contains('[') {
                None
            } else {
                let head = if formula::body_of(&val).is_none() { "of:=" } else { "" };
                formula::move_formula(&format!("{head}{val}"), home, op).map(|m| m[head.len()..].to_owned())
            };
            if let Some(next) = next.filter(|n| *n != val) {
                out.push((k.start + at.start, k.start + at.end, esc_attr(&next)));
            }
        }
        if k.name != "table:table-row" {
            fix(src, &k, table, op, out)?;
        }
    }
    Ok(())
}

/// What a row of the sheet is after the change: the row the page had,
/// a copy of one that was split, or a new one.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Source,
    Clone,
    New,
}

/// The rows themselves, as changes to the page's text.
fn shift_rows(src: &str, s: usize, at: i64, n: i64, out: &mut Vec<(usize, usize, String)>) -> Result<(), String> {
    let (table, rows, _) = sheet::sheet_rows(src, s)?;
    let reps: Vec<i64> = rows.iter().map(|r| count(src, r, ROWS) as i64).collect();
    let (cnt, end) = (n.abs(), at + n.abs());
    // which source row, and how many rows it stands for
    let mut items: Vec<(Kind, usize, i64)> = Vec::new();
    let mut r = 0;
    for (k, rep) in reps.iter().enumerate() {
        let e = r + rep;
        if n > 0 {
            if at == r {
                items.extend([(Kind::New, k, cnt), (Kind::Source, k, *rep)]);
            } else if r < at && at < e {
                items.extend([(Kind::Source, k, at - r), (Kind::New, k, cnt), (Kind::Clone, k, e - at)]);
            } else {
                items.push((Kind::Source, k, *rep));
            }
        } else {
            if r < at {
                items.push((Kind::Source, k, e.min(at) - r));
            }
            if r >= end {
                items.push((Kind::Source, k, *rep));
            } else if e > end {
                items.push((Kind::Clone, k, e - end));
            }
        }
        r = e;
    }
    if n > 0 {
        // rows pushed past the last one fall off, as in LibreOffice
        let mut over = items.iter().map(|i| i.2).sum::<i64>() - MAX_ROWS;
        while over > 0 {
            let Some(last) = items.last_mut() else { break };
            if last.2 > over {
                last.2 -= over;
                over = 0;
            } else {
                over -= last.2;
                items.pop();
            }
        }
    }
    // a new row takes the row style of the one before it, else of the one after
    let style = |i: usize| {
        let like = if i > 0 { items.get(i - 1) } else { items.get(1) };
        like.and_then(|(_, k, _)| {
            let t = tag(src, &rows[*k]);
            attrs(t).into_iter().find(|(a, _)| *a == "table:style-name").map(|(_, at)| format!(" table:style-name=\"{}\"", &t[at]))
        })
    };
    let xml = |i: usize, ind: usize| -> String {
        let (kind, k, rep) = items[i];
        if kind != Kind::New {
            return copy(src, &rows[k], ROWS, rep as usize);
        }
        let sp = " ".repeat(ind);
        format!("<table:table-row{}{}>\n{sp} <table:table-cell/>\n{sp}</table:table-row>", style(i).unwrap_or_default(), if rep > 1 { format!(" {ROWS}=\"{rep}\"") } else { String::new() })
    };
    // a row that is gone goes with the line break and indent before it
    for (k, row) in rows.iter().enumerate() {
        if !items.iter().any(|(kind, x, _)| *kind == Kind::Source && *x == k) {
            let b = row.start - indent(src, row.start);
            out.push((if b > 0 && src.as_bytes()[b - 1] == b'\n' { b - 1 } else { b }, row.end, String::new()));
        }
    }
    let mut last: Option<usize> = None;
    let mut pend: Vec<usize> = Vec::new();
    for (i, (kind, k, rep)) in items.iter().enumerate() {
        if *kind == Kind::Source {
            let row = &rows[*k];
            let ind = indent(src, row.start);
            if !pend.is_empty() {
                out.push((row.start, row.start, pend.drain(..).map(|p| format!("{}\n{}", xml(p, ind), " ".repeat(ind))).collect()));
            }
            if *rep != reps[*k] {
                out.push((row.start, row.end, xml(i, ind)));
            }
            last = Some(*k);
        } else if let Some(l) = last {
            let ind = indent(src, rows[l].start);
            out.push((rows[l].end, rows[l].end, format!("\n{}{}", " ".repeat(ind), xml(i, ind))));
        } else {
            pend.push(i);
        }
    }
    // every row went: the sheet keeps one blank row, just inside the table
    if rows.iter().len() > 0 && items.is_empty() {
        let ind = indent(src, table.start);
        let sp = " ".repeat(ind);
        let close = src[..table.end].rfind("</").unwrap_or(table.end);
        out.push((close, close, format!(" <table:table-row>\n{sp}  <table:table-cell/>\n{sp} </table:table-row>\n{sp}")));
    } else if !pend.is_empty() {
        let ind = indent(src, table.start);
        let close = src[..table.end].rfind("</").unwrap_or(table.end);
        out.push((close, close, pend.iter().map(|p| format!(" {}\n{}", xml(*p, ind + 1), " ".repeat(ind))).collect()));
    }
    Ok(())
}

/// The page with every change made, each given by where it starts and ends in the page as it was.
fn apply(src: &str, mut splices: Vec<(usize, usize, String)>) -> String {
    // stable by position: what is put in at one point keeps its order
    splices.sort_by_key(|(s, e, _)| (*s, *e));
    let (mut out, mut pos) = (String::with_capacity(src.len() + 256), 0);
    for (s, e, t) in splices {
        if s < pos {
            // a change inside a span already replaced or removed: the outer one won
            if e > pos {
                out.push_str(&t);
                pos = e;
            }
            continue;
        }
        out.push_str(&src[pos..s]);
        out.push_str(&t);
        pos = e;
    }
    out.push_str(&src[pos..]);
    out
}

/// The page with rows put into a sheet before row `at` (`n` above
/// nothing) or `-n` rows taken out from `at`, and every reference in
/// step. The formulas still hold what they came to before: see `calc::shift`.
pub fn shift(src: &str, s: usize, rows: bool, at: i64, n: i64) -> Result<String, String> {
    blocked(src, s, rows, at, n)?;
    if !rows {
        return Err("columns are not moved here yet".into());
    }
    let name = sheet::book(src)?.sheets[s].name.clone();
    let op = Op { sheet: &name, rows, at, n };
    let mut splices = Vec::new();
    fix(src, &body(src)?, None, &op, &mut splices)?;
    shift_rows(src, s, at, n, &mut splices)?;
    let mut page = apply(src, splices);
    // the formulas, where they now are
    let book = sheet::book(&page)?;
    for (si, sh) in book.sheets.iter().enumerate() {
        let mut edits: BTreeMap<usize, Vec<(usize, Put)>> = BTreeMap::new();
        let mut r = 0;
        for row in &sh.rows {
            let mut c = 0;
            for cell in &row.cells {
                if let Some(new) = cell.f.as_ref().and_then(|f| formula::move_formula(f, &sh.name, &op).filter(|m| m != f)) {
                    // ponytail: a run of one formula is written out cell by cell. Kept as a run if a page ever has a long one
                    if row.rep.saturating_mul(cell.rep) > 4096 {
                        return Err("a formula here is repeated too many times to move".into());
                    }
                    for i in 0..row.rep {
                        for j in 0..cell.rep {
                            edits.entry(r + i).or_default().push((c + j, Put { f: Some(new.clone()), vt: cell.vt.clone(), v: cell.v.clone().unwrap_or(Val::Blank), text: cell.text.clone(), err: cell.err, st: None }));
                        }
                    }
                }
                c += cell.rep;
            }
            r += row.rep;
        }
        if !edits.is_empty() {
            page = sheet::put_cells(&page, si, &edits, sheet::Care::Result)?;
        }
    }
    Ok(page)
}
