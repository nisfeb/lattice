//! Works spreadsheet formulas out over a sheet's typed model, and
//! recalculates what an edit makes stale: a port of the web client's
//! `ui-src/sheet/engine.js` and of the value rules in `funcs.js`.
//!
//! Recalculation is narrow on purpose. Opening a sheet computes nothing,
//! so a page that was only looked at is never rewritten. An edit
//! recomputes the cells that depend on it, directly or through other
//! formulas, and nothing else. A formula that cannot be worked out here
//! (a function not known yet, a name, a reference across sheets) keeps
//! the result it had and is counted as stale, never guessed.

use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use crate::formula::{self, Mode, Node, Ref};
use crate::sheet::{self, Book, Care, MCell, Put, Typed, Val};
use crate::styles::Styles;

/// A value in the middle of a formula.
#[derive(Clone, Debug, PartialEq)]
pub enum V {
    /// An empty cell.
    Blank,
    /// An argument left out.
    Missing,
    Num(f64),
    Str(String),
    Bool(bool),
    Err(String),
    Range(Rg),
}

/// A rectangle of cells on one sheet.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rg {
    pub s: usize,
    pub r1: usize,
    pub c1: usize,
    pub r2: usize,
    pub c2: usize,
}

/// Something this engine does not work out: the cell keeps what it had.
pub struct Unsupported;

type Key = (usize, usize, usize);

/// Where a formula is being worked out.
#[derive(Clone, Copy)]
pub struct Ctx {
    pub s: usize,
    pub r: usize,
    pub c: usize,
}

impl Rg {
    pub fn rows(&self) -> usize {
        self.r2 - self.r1 + 1
    }

    pub fn cols(&self) -> usize {
        self.c2 - self.c1 + 1
    }
}

struct Entry {
    at: Key,
    f: String,
    ast: Option<Rc<Node>>,
    /// The rectangles it reads: sheet, then first and last row and column.
    deps: Vec<[usize; 5]>,
    /// It may read anything: a reference or a name this engine does not follow.
    wild: bool,
    /// How far an array formula's results spread from its cell: rows, then columns.
    spill: (usize, usize),
}

/// The most cells one array formula's results are followed over, each by itself.
const SPILL_MOST: usize = 10_000;

fn err(code: &str) -> V {
    V::Err(code.to_owned())
}

/// How many formulas deep one is worked out inside another before the deepest is put first.
/// A chain of any length is then worked out a stretch at a time, and the stack stays shallow.
const DEEP: usize = 64;

/// The most cells a grid of values may hold: see `Engine::grid`.
const GRID_MOST: usize = 200_000;
/// The most cells one formula may read, with whatever it pulls in.
const WALK_ONE: usize = 5_000_000;
/// The most cells one change to a sheet may read, in all the formulas it reaches. The work is done where the
/// typing is, so this is what keeps a small hostile page from holding the window. It is well above what the
/// 5,000 rows the sheet shows can make of an ordinary sheet: a share of the total, a rank and a running total
/// down every row read about 25 million cells each.
const WALK_ALL: usize = 100_000_000;

/// Spans along one column or one row, each with the formula that reads it, kept so that
/// the spans over one place are found without looking at the rest.
#[derive(Default)]
struct Stab {
    /// First, last, formula. In order of the first once built.
    iv: Vec<(usize, usize, usize)>,
    /// For the span in the middle of each stretch, the furthest any span of the stretch goes.
    top: Vec<usize>,
}

impl Stab {
    fn build(&mut self) {
        self.iv.sort_unstable();
        self.top = vec![0; self.iv.len()];
        self.fill(0, self.iv.len());
    }

    fn fill(&mut self, lo: usize, hi: usize) -> usize {
        if lo >= hi {
            return 0;
        }
        let mid = lo + (hi - lo) / 2;
        let m = self.iv[mid].1.max(self.fill(lo, mid)).max(self.fill(mid + 1, hi));
        self.top[mid] = m;
        m
    }

    /// The formulas whose span holds `x`.
    fn over(&self, x: usize, out: &mut Vec<usize>) {
        self.find(0, self.iv.len(), x, out);
    }

    fn find(&self, lo: usize, hi: usize, x: usize, out: &mut Vec<usize>) {
        if lo >= hi {
            return;
        }
        let mid = lo + (hi - lo) / 2;
        if self.top[mid] < x {
            return;
        }
        self.find(lo, mid, x, out);
        if self.iv[mid].0 <= x {
            if self.iv[mid].1 >= x {
                out.push(self.iv[mid].2);
            }
            self.find(mid + 1, hi, x, out);
        }
    }
}

/// Which formulas read each cell: the other way round from what each formula reads.
#[derive(Default)]
struct Readers {
    /// Those that name the one cell.
    one: HashMap<Key, Vec<usize>>,
    /// Narrow ranges, by sheet and column, as spans of rows.
    cols: HashMap<(usize, usize), Stab>,
    /// Flat ranges, by sheet and row, as spans of columns.
    rows: HashMap<(usize, usize), Stab>,
    /// Ranges both wide and tall.
    blocks: Vec<([usize; 5], usize)>,
}

impl Readers {
    fn new(formulas: &[Entry]) -> Readers {
        let mut r = Readers::default();
        for (i, e) in formulas.iter().enumerate() {
            for d in &e.deps {
                let (tall, wide) = (d[3] - d[1] + 1, d[4] - d[2] + 1);
                if tall == 1 && wide == 1 {
                    r.one.entry((d[0], d[1], d[2])).or_default().push(i);
                } else if wide <= 16 {
                    (d[2]..=d[4]).for_each(|c| r.cols.entry((d[0], c)).or_default().iv.push((d[1], d[3], i)));
                } else if tall <= 16 {
                    (d[1]..=d[3]).for_each(|row| r.rows.entry((d[0], row)).or_default().iv.push((d[2], d[4], i)));
                } else {
                    r.blocks.push((*d, i));
                }
            }
        }
        r.cols.values_mut().chain(r.rows.values_mut()).for_each(Stab::build);
        r
    }
}

/// A grid of values: what a range or an expression over ranges comes to, cell by cell.
struct Grid {
    rows: usize,
    cols: usize,
    v: Vec<V>,
}

/// A node with the brackets round it taken off.
fn bare(mut n: &Node) -> &Node {
    while let Node::Paren(x) = n {
        n = x;
    }
    n
}

/// Whether an expression names a range of more than one cell anywhere in it.
fn ranged(n: &Node) -> bool {
    match n {
        Node::Ref(Ref::Cells { a, b: Some(b), .. }) => a.r != b.r || a.c != b.c,
        Node::Paren(x) | Node::Un(_, x) | Node::Pct(x) => ranged(x),
        Node::Bin(_, l, r) => ranged(l) || ranged(r),
        Node::Call(_, args) => args.iter().any(ranged),
        _ => false,
    }
}

/// Whether an expression calls one of the functions named, anywhere in it.
fn calls(n: &Node, names: &[&str]) -> bool {
    match n {
        Node::Paren(x) | Node::Un(_, x) | Node::Pct(x) => calls(x, names),
        Node::Bin(_, l, r) => calls(l, names) || calls(r, names),
        Node::Call(name, args) => names.contains(&name.as_str()) || args.iter().any(|a| calls(a, names)),
        _ => false,
    }
}

/// Whether a function takes its argument at `i` as a range whole, to give one value, so is
/// the same inside an expression worked out cell by cell as outside one. A range anywhere
/// else would be one value for each of its cells, which is not worked out here.
fn whole_at(name: &str, i: usize) -> bool {
    match name {
        "SUM" | "PRODUCT" | "AVERAGE" | "MIN" | "MAX" | "COUNT" | "COUNTA" | "MEDIAN" | "MODE" | "VAR" | "VARP" | "STDEV" | "STDEVP" | "SUMPRODUCT" => true,
        "COUNTBLANK" | "ROWS" | "COLUMNS" | "LARGE" | "SMALL" | "COUNTIF" | "INDEX" => i == 0,
        "RANK" | "VLOOKUP" | "HLOOKUP" | "MATCH" => i == 1,
        "SUMIF" | "AVERAGEIF" => i == 0 || i == 2,
        "SUMIFS" => i == 0 || i % 2 == 1,
        "COUNTIFS" => i % 2 == 0,
        "TEXTJOIN" => i >= 2,
        _ => false,
    }
}

/// A cell's value, as formulas see it.
fn cell_value(cell: Option<&MCell>) -> V {
    let Some(cell) = cell else { return V::Blank };
    if cell.err {
        return V::Err(if cell.text.is_empty() { "#VALUE!".into() } else { cell.text.clone() });
    }
    match &cell.v {
        // a formula with no cached type gave an empty text
        None if cell.f.is_some() => V::Str(String::new()),
        None | Some(Val::Blank) => V::Blank,
        Some(Val::Str(s)) => V::Str(s.clone()),
        Some(Val::Bool(b)) => V::Bool(*b),
        Some(Val::Num(n)) => V::Num(*n),
    }
}

/// Text Calc reads as a number without asking: a plain number, an ISO date, a time of day.
fn text_num(v: &str) -> V {
    let t = v.trim();
    let plain = !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) && t.bytes().any(|b| b.is_ascii_digit()) && !t.starts_with(['e', 'E']);
    if let Some(n) = t.parse::<f64>().ok().filter(|_| plain) {
        return V::Num(n);
    }
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    // a date, with a time after a T or a space
    let (day, clock) = t.split_once(['T', ' ']).map_or((t, None), |(d, c)| (d, Some(c)));
    let p: Vec<&str> = day.split('-').collect();
    let clock_of = |c: &str, wide: bool| -> Option<f64> {
        let q: Vec<&str> = c.split(':').collect();
        let hours_ok = if wide { !q[0].is_empty() && q[0].bytes().all(|b| b.is_ascii_digit()) } else { digits(q[0], 2) };
        if !(2..=3).contains(&q.len()) || !hours_ok || !digits(q[1], 2) {
            return None;
        }
        let secs = match q.get(2) {
            Some(s) => s.parse::<f64>().ok().filter(|_| s.len() >= 2 && s.as_bytes()[0].is_ascii_digit() && s.as_bytes()[1].is_ascii_digit())?,
            None => 0.0,
        };
        Some((q[0].parse::<f64>().ok()? * 3600.0 + q[1].parse::<f64>().ok()? * 60.0 + secs) / 86_400.0)
    };
    if p.len() == 3 && digits(p[0], 4) && digits(p[1], 2) && digits(p[2], 2) {
        if let Some(days) = sheet::date_serial(day, -25_569.0) {
            match clock.map(|c| clock_of(c, false)) {
                None => return V::Num(days),
                Some(Some(frac)) => return V::Num(days + frac),
                Some(None) => {}
            }
        }
    }
    clock_of(t, true).map_or(err("#VALUE!"), V::Num)
}

/// A value as a number, or the error it is or makes.
pub fn to_num(v: &V) -> V {
    match v {
        V::Num(n) => V::Num(*n),
        V::Bool(b) => V::Num(f64::from(*b)),
        V::Blank | V::Missing => V::Num(0.0),
        V::Err(_) => v.clone(),
        V::Str(s) => text_num(s),
        V::Range(_) => err("#VALUE!"),
    }
}

/// A value as text, as `&` joins it. A logical value is a number to Calc.
pub fn to_str(v: &V) -> String {
    match v {
        V::Str(s) => s.clone(),
        V::Num(n) => sheet::general(*n),
        V::Bool(b) => if *b { "1" } else { "0" }.into(),
        V::Err(e) => e.clone(),
        V::Blank | V::Missing | V::Range(_) => String::new(),
    }
}

/// Whether two numbers are one number to Calc: the same, or apart by no more than what
/// binary arithmetic leaves, about one part in 2^48 of their size. 0.1+0.2 is 0.3 so. A
/// nought is only itself, and two whole numbers that differ are two numbers.
pub fn approx_eq(a: f64, b: f64) -> bool {
    const E48: f64 = 1.0 / (16_777_216.0 * 16_777_216.0);
    if a == b {
        return true;
    }
    let d = (a - b).abs();
    if a == 0.0 || b == 0.0 || !d.is_finite() || (d >= 1.0 && d < 9_007_199_254_740_992.0 && a.fract() == 0.0 && b.fract() == 0.0) {
        return false;
    }
    d < a.abs() * E48 && d < b.abs() * E48
}

/// A number as Calc's INT, ROUND and ROUNDDOWN see it: rounded to fifteen figures, so that what binary
/// arithmetic leaves of 0.29*100 (28.999999999999996) is 29, and 5.99999999999999, which has fifteen figures
/// of its own, is not 6. A positive number past 2^41 is left as it is.
pub fn approx_value(x: f64) -> f64 {
    if x == 0.0 || !x.is_finite() || x > 2_199_023_255_552.0 {
        return x;
    }
    let v = x.abs();
    // Calc keeps 999999999999.999 as it is, so a big number is read to three decimals at most
    let scale = 10f64.powi((14 - v.log10().floor() as i32).max(3));
    let scaled = v * scale;
    if !scaled.is_finite() {
        return x;
    }
    let back = (scaled + 0.5).floor() / scale;
    if x < 0.0 { -back } else { back }
}

/// The whole number at or below a number, as Calc takes it: see `approx_value`.
pub fn approx_floor(x: f64) -> f64 {
    approx_value(x).floor()
}

/// Numbers sort before text, and text compares without case.
pub fn compare(a: &V, b: &V) -> i32 {
    let fill = |v: &V, other: &V| match v {
        V::Blank | V::Missing => if matches!(other, V::Str(_)) { V::Str(String::new()) } else { V::Num(0.0) },
        V::Bool(x) => V::Num(f64::from(*x)),
        other => other.clone(),
    };
    let (a, b) = (fill(a, b), fill(b, a));
    let (a, b) = (fill(&a, &b), fill(&b, &a));
    let sign = |o: std::cmp::Ordering| o as i32;
    match (&a, &b) {
        (V::Num(x), V::Num(y)) if approx_eq(*x, *y) => 0,
        (V::Num(x), V::Num(y)) => x.partial_cmp(y).map_or(0, sign),
        (V::Str(x), V::Str(y)) => sign(x.to_lowercase().cmp(&y.to_lowercase())),
        (V::Num(_), _) => -1,
        _ => 1,
    }
}

/// The comparison operators: as `compare`, but text differs by case.
// ponytail: the web orders text by the browser's English collation. This orders it without case first, then a small letter before its capital, which agrees for plain letters and digits
fn compare_op(a: &V, b: &V) -> i32 {
    if let (V::Str(x), V::Str(y)) = (a, b) {
        if x == y {
            return 0;
        }
        let k = x.to_lowercase().cmp(&y.to_lowercase());
        let k = if k.is_eq() { y.cmp(x) } else { k };
        return k as i32;
    }
    compare(a, b)
}

/// A power as Calc takes it: an odd root of a negative number is real.
pub fn power(a: f64, b: f64) -> V {
    if a == 0.0 && b < 0.0 {
        return err("#DIV/0!");
    }
    if a < 0.0 && b.fract() != 0.0 {
        let inv = 1.0 / b;
        if (inv - inv.round()).abs() < 1e-9 && inv.round().abs() % 2.0 == 1.0 {
            return V::Num(-(-a).powf(b));
        }
        return err("#NUM!");
    }
    let v = a.powf(b);
    if v.is_finite() { V::Num(v) } else { err("#NUM!") }
}

pub struct Engine<'a> {
    book: &'a Book,
    styles: &'a Styles,
    /// What formulas were worked out to, over what the book holds.
    over: HashMap<Key, Put>,
    formulas: Vec<Entry>,
    /// The formulas waiting to be worked out, by where they are.
    pending: HashMap<Key, usize>,
    /// Those being worked out now: one met again is a cycle.
    busy: HashSet<Key>,
    /// Those that could not be worked out here.
    pub stale: HashSet<Key>,
    changed: Vec<Key>,
    /// How much of each sheet holds anything: rows, then columns.
    extents: HashMap<usize, (usize, usize)>,
    /// The cells walked for the formula being worked out: a hostile run of them is not walked to its end.
    steps: usize,
    /// The cells walked in all since the engine was made, by every formula: one change to a sheet is not
    /// let walk more than `WALK_ALL`, however many formulas it reaches. What is left is left stale.
    walked: usize,
    /// The most it may walk so: `WALK_ALL`, but where a test sets less.
    walk_all: usize,
    /// Whether a formula was left because the walk of a cell budget ran out: what it still holds is old.
    ran_out: std::cell::Cell<bool>,
    /// Those worked out.
    done: Vec<Key>,
    depth: usize,
    /// A formula met too deep inside others, to be worked out before them. While it is set
    /// nothing more is worked out, and what was begun is left waiting.
    first: Option<usize>,
    /// The cells whose value cannot be trusted: a formula that could not be worked out, the
    /// cells an array formula's results spread over, and whatever read one of these.
    unsure: HashSet<Key>,
    /// Rectangles of such cells, under array results spread too far to list cell by cell.
    wide: Vec<[usize; 5]>,
    /// The formula being worked out read such a cell, so what it comes to cannot be trusted either.
    tainted: bool,
}

impl<'a> Engine<'a> {
    pub fn new(book: &'a Book, styles: &'a Styles) -> Engine<'a> {
        let mut e = Engine { book, styles, over: HashMap::new(), formulas: Vec::new(), pending: HashMap::new(), busy: HashSet::new(), stale: HashSet::new(), changed: Vec::new(), extents: HashMap::new(), steps: 0, walked: 0, walk_all: WALK_ALL, ran_out: Default::default(), done: Vec::new(), depth: 0, first: None, unsure: HashSet::new(), wide: Vec::new(), tainted: false };
        for (s, sh) in book.sheets.iter().enumerate() {
            let mut r = 0usize;
            for row in &sh.rows {
                if row.cells.iter().any(|c| c.f.is_some()) {
                    // a run of the same formula a million rows long is not followed all the way down
                    for i in 0..row.rep.min(2048) {
                        let mut c = 0usize;
                        for cell in &row.cells {
                            if let Some(f) = &cell.f {
                                for j in 0..cell.rep.min(256) {
                                    // no more than a sheet of formulas in all: forty rows that each say half a million would be twenty million read
                                    if e.formulas.len() >= 200_000 {
                                        break;
                                    }
                                    let entry = e.entry((s, r + i, c + j), f, cell.array);
                                    let entry = Entry { spill: if cell.array { cell.spill } else { (1, 1) }, ..entry };
                                    e.formulas.push(entry);
                                }
                            }
                            c = c.saturating_add(cell.rep);
                        }
                    }
                }
                r = r.saturating_add(row.rep);
            }
        }
        e
    }

    /// A formula and what it reads. One entered as an array is worked out cell by cell over
    /// its ranges, which is not done here: what it reads is still followed, so it is counted
    /// stale when that changes, and it keeps what it had.
    fn entry(&self, at: Key, f: &str, array: bool) -> Entry {
        let ast = formula::body_of(f).and_then(|b| formula::parse(b, Mode::Of).ok()).map(Rc::new);
        let (mut deps, mut wild) = (Vec::new(), false);
        if let Some(ast) = &ast {
            self.deps_of(ast, at.0, &mut deps, &mut wild);
        }
        Entry { at, f: f.to_owned(), ast: ast.filter(|_| !array), deps, wild, spill: (1, 1) }
    }

    fn sheet_index(&self, name: &str) -> Option<usize> {
        let n = name.to_lowercase();
        self.book.sheets.iter().position(|s| s.name.to_lowercase() == n)
    }

    fn deps_of(&self, n: &Node, home: usize, out: &mut Vec<[usize; 5]>, wild: &mut bool) {
        match n {
            Node::Ref(r) => match self.range(r, home) {
                Ok(V::Range(g)) => out.push([g.s, g.r1, g.c1, g.r2, g.c2]),
                Ok(_) => {}
                Err(Unsupported) => *wild = true,
            },
            // named ranges are not read here: a formula with a name may read anything
            Node::Name(_) => *wild = true,
            Node::Paren(x) | Node::Un(_, x) | Node::Pct(x) => self.deps_of(x, home, out, wild),
            Node::Bin(_, l, r) => {
                self.deps_of(l, home, out, wild);
                self.deps_of(r, home, out, wild);
            }
            Node::Call(name, args) => {
                args.iter().for_each(|a| self.deps_of(a, home, out, wild));
                // these read one range by the shape of another, so past what the formula names:
                // SUMIF(A1:A3,">0",B1) adds up B1:B3
                let rect = |n: &Node| match bare(n) {
                    Node::Ref(r) => match self.range(r, home) {
                        Ok(V::Range(g)) => Some(g),
                        _ => None,
                    },
                    _ => None,
                };
                // the range whose shape is used, and which arguments are read by it
                let (shape, read): (Option<&Node>, Vec<usize>) = match name.as_str() {
                    "SUMIF" | "AVERAGEIF" => (args.first(), vec![2]),
                    "SUMIFS" => (args.get(1), std::iter::once(0).chain((1..args.len()).step_by(2)).collect()),
                    "COUNTIFS" => (args.first(), (0..args.len()).step_by(2).collect()),
                    _ => (None, Vec::new()),
                };
                if let Some(t) = shape.and_then(rect) {
                    for o in read.into_iter().filter_map(|i| args.get(i).and_then(rect)) {
                        out.push([o.s, o.r1, o.c1, o.r2.max(o.r1.saturating_add(t.rows() - 1)), o.c2.max(o.c1.saturating_add(t.cols() - 1))]);
                    }
                }
            }
            _ => {}
        }
    }

    fn range(&self, r: &Ref, home: usize) -> Result<V, Unsupported> {
        match r {
            Ref::Unknown(_) => Err(Unsupported),
            Ref::Bad => Ok(err("#REF!")),
            Ref::Cells { a, b, .. } => {
                let s1 = match &a.sheet {
                    None => home,
                    Some(n) => match self.sheet_index(n) {
                        Some(s) => s,
                        None => return Ok(err("#REF!")),
                    },
                };
                let e = b.as_ref().unwrap_or(a);
                // a range from one sheet to another is not read here
                if let Some(n) = b.as_ref().and_then(|b| b.sheet.as_ref()) {
                    if self.sheet_index(n) != Some(s1) {
                        return Err(Unsupported);
                    }
                }
                let (r1, r2, c1, c2) = (a.r.min(e.r), a.r.max(e.r), a.c.min(e.c), a.c.max(e.c));
                Ok(V::Range(Rg { s: s1, r1: r1 as usize, c1: c1 as usize, r2: r2 as usize, c2: c2 as usize }))
            }
        }
    }

    /// The cell as it stands: what was worked out for it, else what the book holds.
    fn stored(&self, at: Key) -> Option<MCell> {
        match self.over.get(&at) {
            Some(p) => Some(MCell { rep: 1, vt: p.vt.clone(), v: (!p.vt.is_empty()).then(|| p.v.clone()), f: p.f.clone(), text: p.text.clone(), err: p.err, st: None, covered: false, array: false, spill: (1, 1) }),
            None => self.book.at(at.0, at.1, at.2).cloned(),
        }
    }

    /// The value at a cell, worked out first when it is waiting to be.
    pub fn value(&mut self, at: Key) -> V {
        // every cell read is counted, here where every reading comes through
        self.steps = self.steps.saturating_add(1);
        self.walked = self.walked.saturating_add(1);
        // what is being worked out is being left, or has read all it may: nothing more is begun
        if self.first.is_some() || self.over() {
            return V::Blank;
        }
        match self.pending.get(&at).copied() {
            Some(i) => self.compute(i),
            None if at.0 < self.book.sheets.len() => {
                if (!self.unsure.is_empty() && self.unsure.contains(&at)) || self.wide.iter().any(|d| d[0] == at.0 && (d[1]..=d[3]).contains(&at.1) && (d[2]..=d[4]).contains(&at.2)) {
                    self.tainted = true;
                }
                cell_value(self.stored(at).as_ref())
            }
            None => err("#REF!"),
        }
    }

    /// Whether what is being worked out is being left, for now or for good, so a long walk may stop.
    pub fn leaving(&self) -> bool {
        self.first.is_some() || self.over()
    }

    /// Whether the formula being worked out has read more cells than one may, or all the formulas of this change
    /// more than they may together. It is then left stale, and so is every formula after it.
    fn over(&self) -> bool {
        let over = self.steps > WALK_ONE || self.walked > self.walk_all;
        if over {
            self.ran_out.set(true);
        }
        over
    }

    /// Counts work that reads no cell: an operator over a grid of values.
    fn count(&mut self, n: usize) -> Result<(), Unsupported> {
        self.steps = self.steps.saturating_add(n);
        self.walked = self.walked.saturating_add(n);
        if self.over() { Err(Unsupported) } else { Ok(()) }
    }

    /// The day the document counts its dates from, in days since 1970.
    pub fn null_date(&self) -> f64 {
        self.book.null_date
    }

    /// How much of a sheet holds anything: a value, a formula or a text. Trailing empty runs do not count.
    pub fn used(&mut self, s: usize) -> (usize, usize) {
        if let Some(u) = self.extents.get(&s) {
            return *u;
        }
        let (mut rows, mut cols, mut at) = (0usize, 0usize, 0usize);
        for row in self.book.sheets.get(s).map_or(&[][..], |sh| &sh.rows) {
            let (mut c, mut last) = (0usize, 0usize);
            for cell in &row.cells {
                if !cell.vt.is_empty() || cell.f.is_some() || !cell.text.is_empty() {
                    last = c.saturating_add(cell.rep);
                }
                c = c.saturating_add(cell.rep);
            }
            if last > 0 {
                // a repeated row with content is real data only when the run is short
                rows = at.saturating_add(row.rep.min(4096));
                cols = cols.max(last);
            }
            at = at.saturating_add(row.rep);
        }
        let u = (rows, cols.min(16_384));
        self.extents.insert(s, u);
        u
    }

    /// Calls `f` with the value of every cell of the rectangle that holds something, in row order.
    pub fn each(&mut self, g: Rg, f: &mut dyn FnMut(V)) -> Result<(), Unsupported> {
        let book = self.book;
        let Some(sheet) = book.sheets.get(g.s) else { return Ok(()) };
        let mut r = 0usize;
        for row in &sheet.rows {
            let (top, bot) = (r, r.saturating_add(row.rep - 1));
            r = r.saturating_add(row.rep);
            if bot < g.r1 {
                continue;
            }
            if top > g.r2 {
                break;
            }
            if !row.cells.iter().any(|c| !c.vt.is_empty() || c.f.is_some()) {
                continue;
            }
            for rr in top.max(g.r1)..=bot.min(g.r2) {
                let mut c = 0usize;
                for cell in &row.cells {
                    let (left, right) = (c, c.saturating_add(cell.rep - 1));
                    c = c.saturating_add(cell.rep);
                    if right < g.c1 {
                        continue;
                    }
                    if left > g.c2 {
                        break;
                    }
                    if cell.vt.is_empty() && cell.f.is_none() {
                        continue;
                    }
                    for cc in left.max(g.c1)..=right.min(g.c2) {
                        // a million rows of sixteen thousand cells are not walked: the formula keeps what it had
                        if self.leaving() {
                            return Err(Unsupported);
                        }
                        let v = self.value((g.s, rr, cc));
                        if v != V::Blank {
                            f(v);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// One value from what an expression gave: a one-cell range is its cell, and a column
    /// or a row is the cell on the formula's own row or column.
    fn one(&mut self, v: V, ctx: Ctx) -> V {
        let V::Range(g) = v else { return v };
        if g.r1 == g.r2 && g.c1 == g.c2 {
            return self.value((g.s, g.r1, g.c1));
        }
        if g.c1 == g.c2 && ctx.s == g.s && (g.r1..=g.r2).contains(&ctx.r) {
            return self.value((g.s, ctx.r, g.c1));
        }
        if g.r1 == g.r2 && ctx.s == g.s && (g.c1..=g.c2).contains(&ctx.c) {
            return self.value((g.s, g.r1, ctx.c));
        }
        err("#VALUE!")
    }

    pub fn ev(&mut self, n: &Node, ctx: Ctx) -> Result<V, Unsupported> {
        Ok(match n {
            // a number written past what one can hold
            Node::Num(v) if !v.is_finite() => err("#NUM!"),
            Node::Num(v) => V::Num(*v),
            Node::Str(v) => V::Str(v.clone()),
            Node::Bool(v) => V::Bool(*v),
            Node::Err(v) => err(v),
            Node::Missing => V::Missing,
            Node::Ref(r) => self.range(r, ctx.s)?,
            Node::Paren(x) => self.ev(x, ctx)?,
            Node::Un(op, x) => {
                let v = self.ev(x, ctx)?;
                let v = self.one(v, ctx);
                // a plus before a value leaves text and numbers as they are: `=+B1` is what B1 holds. A
                // logical read from a cell is its number, and one that is the result of an expression or a
                // function stays a logical
                if *op != '-' {
                    let mut inner = &**x;
                    while let Node::Paren(i) = inner {
                        inner = i;
                    }
                    return Ok(match v {
                        V::Bool(b) if matches!(inner, Node::Ref(_)) => V::Num(f64::from(b)),
                        v => v,
                    });
                }
                match to_num(&v) {
                    V::Num(v) => V::Num(-v),
                    e => e,
                }
            }
            Node::Pct(x) => {
                let v = self.ev(x, ctx)?;
                match to_num(&self.one(v, ctx)) {
                    V::Num(v) => V::Num(v / 100.0),
                    e => e,
                }
            }
            Node::Bin(op, l, r) => {
                let l = self.ev(l, ctx)?;
                let l = self.one(l, ctx);
                let r = self.ev(r, ctx)?;
                let r = self.one(r, ctx);
                bin(op, l, r)
            }
            // SUMPRODUCT of an expression over ranges works the expression out cell by cell
            Node::Call(name, nodes) if name == "SUMPRODUCT" && nodes.iter().any(|a| !matches!(bare(a), Node::Ref(_)) && ranged(a)) => self.sum_product(nodes, ctx)?,
            Node::Call(name, nodes) => {
                if let Some(got) = crate::funcs::lazy(self, name, nodes, ctx) {
                    return got;
                }
                let mut args = Vec::with_capacity(nodes.len());
                for a in nodes {
                    args.push(self.ev(a, ctx)?);
                }
                // an argument left out at the end is no argument
                while args.last() == Some(&V::Missing) {
                    args.pop();
                }
                match crate::funcs::call(self, name, &args, ctx)? {
                    V::Num(n) if !n.is_finite() => err("#NUM!"),
                    v => v,
                }
            }
            // named ranges and expressions are not read here yet
            Node::Name(_) => return Err(Unsupported),
        })
    }

    /// What an expression comes to cell by cell: a range is its cells, a value is one cell,
    /// and an operator works on each cell of its sides, one value on a side going with every
    /// cell of the other. What cannot be worked out this way is not guessed at.
    fn grid(&mut self, n: &Node, ctx: Ctx) -> Result<Grid, Unsupported> {
        let one = |v: V| Grid { rows: 1, cols: 1, v: vec![v] };
        Ok(match n {
            Node::Paren(x) => self.grid(x, ctx)?,
            Node::Ref(r) => match self.range(r, ctx.s)? {
                V::Range(g) => {
                    if g.rows().saturating_mul(g.cols()) > GRID_MOST {
                        return Err(Unsupported);
                    }
                    let mut v = Vec::with_capacity(g.rows() * g.cols());
                    for r in g.r1..=g.r2 {
                        for c in g.c1..=g.c2 {
                            if self.leaving() {
                                return Err(Unsupported);
                            }
                            v.push(self.value((g.s, r, c)));
                        }
                    }
                    Grid { rows: g.rows(), cols: g.cols(), v }
                }
                v => one(v),
            },
            Node::Un(op, x) => {
                let mut g = self.grid(x, ctx)?;
                for v in &mut g.v {
                    *v = match to_num(v) {
                        V::Num(x) => V::Num(if *op == '-' { -x } else { x }),
                        e => e,
                    };
                }
                g
            }
            Node::Pct(x) => {
                let mut g = self.grid(x, ctx)?;
                for v in &mut g.v {
                    *v = match to_num(v) {
                        V::Num(x) => V::Num(x / 100.0),
                        e => e,
                    };
                }
                g
            }
            Node::Bin(op, l, r) => {
                let (l, r) = (self.grid(l, ctx)?, self.grid(r, ctx)?);
                let (rows, cols) = match ((l.rows, l.cols), (r.rows, r.cols)) {
                    (a, b) if a == b => a,
                    ((1, 1), b) => b,
                    (a, (1, 1)) => a,
                    // a row against a column, or two sizes that do not match
                    _ => return Err(Unsupported),
                };
                let at = |g: &Grid, i: usize| g.v[if g.v.len() == 1 { 0 } else { i }].clone();
                self.count(rows * cols)?;
                Grid { rows, cols, v: (0..rows * cols).map(|i| bin(op, at(&l, i), at(&r, i))).collect() }
            }
            // a function over ranges is one value only when it takes its ranges whole
            // and only where it takes them whole: the criterion of COUNTIF given a range is one test for each cell of it
            Node::Call(name, args) if ranged(n) && !args.iter().enumerate().all(|(i, a)| !ranged(a) || (matches!(bare(a), Node::Ref(_)) && whole_at(name, i))) => return Err(Unsupported),
            _ => {
                let v = self.ev(n, ctx)?;
                one(self.one(v, ctx))
            }
        })
    }

    /// SUMPRODUCT over expressions: each argument cell by cell, the products added up.
    /// A cell that holds text or nothing counts as nothing, as it does for plain ranges.
    fn sum_product(&mut self, nodes: &[Node], ctx: Ctx) -> Result<V, Unsupported> {
        let mut grids = Vec::with_capacity(nodes.len());
        for a in nodes {
            grids.push(self.grid(a, ctx)?);
        }
        let Some((rows, cols)) = grids.first().map(|g| (g.rows, g.cols)) else { return Ok(err("#VALUE!")) };
        if grids.iter().any(|g| g.rows != rows || g.cols != cols) {
            return Ok(err("#VALUE!"));
        }
        let mut terms = Vec::with_capacity(rows * cols);
        for i in 0..rows * cols {
            let mut p = 1.0;
            for g in &grids {
                match &g.v[i] {
                    V::Err(code) => return Ok(V::Err(code.clone())),
                    V::Num(x) => p *= x,
                    V::Bool(b) => p *= f64::from(*b),
                    _ => p = 0.0,
                }
            }
            terms.push(p);
        }
        let s: f64 = terms.iter().sum();
        Ok(if s.is_finite() { V::Num(s) } else { err("#NUM!") })
    }

    /// A formula's value for the cell it is in.
    fn evaluate(&mut self, ast: &Node, at: Key) -> Result<V, Unsupported> {
        let ctx = Ctx { s: at.0, r: at.1, c: at.2 };
        let v = self.ev(ast, ctx)?;
        let v = self.one(v, ctx);
        // a reference to an empty cell shows 0. A function that hands back an empty cell is blank here
        Ok(match v {
            V::Blank | V::Missing => {
                let mut top = ast;
                while let Node::Paren(x) = top {
                    top = x;
                }
                if matches!(top, Node::Call(..)) { V::Blank } else { V::Num(0.0) }
            }
            v => v,
        })
    }

    fn compute(&mut self, i: usize) -> V {
        let at = self.formulas[i].at;
        if self.busy.contains(&at) {
            return err("Err:522");
        }
        // too deep inside other formulas: this one is to be worked out first, and they after it
        if self.depth >= DEEP {
            self.first = Some(i);
            return V::Blank;
        }
        // the budget of cells walked is one outermost formula's, with whatever it pulls in
        if self.busy.is_empty() {
            self.steps = 0;
        }
        self.busy.insert(at);
        self.depth += 1;
        let outer = std::mem::replace(&mut self.tainted, false);
        // once the change has read all it may, nothing more is worked out: this formula keeps what it had
        let got = match self.formulas[i].ast.clone() {
            Some(ast) if self.walked <= self.walk_all => self.evaluate(&ast, at),
            _ => Err(Unsupported),
        };
        // and one that ran out part way came to nothing that can be kept
        let got = if self.over() { Err(Unsupported) } else { got };
        self.depth -= 1;
        self.busy.remove(&at);
        let read_unsure = std::mem::replace(&mut self.tainted, outer);
        // left for now: it stays waiting, and nothing is kept of what it came to
        if self.first.is_some() {
            return V::Blank;
        }
        self.pending.remove(&at);
        match got {
            Ok(v) if !read_unsure => {
                self.unsure.remove(&at);
                self.stale.remove(&at);
                self.done.push(at);
                let f = self.formulas[i].f.clone();
                self.store(at, f, v.clone());
                v
            }
            // not worked out, or worked out from a value that cannot be trusted: it keeps what it
            // had, it is counted stale, and so is whatever reads it
            _ => {
                self.stale.insert(at);
                self.unsure.insert(at);
                self.tainted = true;
                cell_value(self.stored(at).as_ref())
            }
        }
    }

    /// Takes cells as not to be trusted from the start: the formulas an earlier change left
    /// stale. One of them worked out now is trusted again, and what reads the others is stale.
    pub fn distrust(&mut self, cells: &[Key]) {
        self.unsure.extend(cells.iter().copied());
    }

    /// Keeps a result for a cell: the type, the value and the text it shows. A numeric
    /// result keeps the cell's numeric type (percentage, money, date, time), since that is its format's.
    fn store(&mut self, at: Key, f: String, v: V) {
        let was = self.stored(at).unwrap_or_default();
        let blank = matches!(v, V::Blank | V::Missing);
        let v = match v {
            _ if blank => V::Num(0.0),
            // more than a number can hold is an error, never a nought
            V::Num(n) if !n.is_finite() => err("#NUM!"),
            v => v,
        };
        let plain_number = !was.vt.is_empty() && was.vt != "boolean" && was.vt != "string";
        let mut val = match &v {
            V::Err(code) => Put { f: Some(f.clone()), vt: "string".into(), v: Val::Str(code.clone()), text: code.clone(), err: true, st: None },
            V::Str(t) => Put { f: Some(f.clone()), vt: "string".into(), v: Val::Str(t.clone()), text: t.clone(), err: false, st: None },
            V::Bool(b) if !plain_number => Put { f: Some(f.clone()), vt: "boolean".into(), v: Val::Bool(*b), text: if *b { "TRUE" } else { "FALSE" }.into(), err: false, st: None },
            other => {
                // a logical result in a cell Calc keeps as a plain number stays one
                let n = match other {
                    V::Bool(b) => f64::from(*b),
                    V::Num(n) => *n,
                    _ => 0.0,
                };
                let keep = matches!(was.vt.as_str(), "percentage" | "currency" | "date" | "time");
                Put { f: Some(f.clone()), vt: if keep { was.vt.clone() } else { "float".into() }, v: Val::Num(n), text: String::new(), err: false, st: None }
            }
        };
        let same = was.vt == val.vt && was.err == val.err && was.f.as_deref() == Some(f.as_str()) && if val.err { was.text == val.text } else { was.v.as_ref() == Some(&val.v) };
        if same && !blank {
            return;
        }
        if let (true, Val::Num(n), false) = (val.text.is_empty(), &val.v, blank) {
            // shown as the cell's own number format writes it
            val.text = self.styles.text(&self.book.style_at(at.0, at.1, at.2), *n, &val.vt);
        }
        if blank && same && was.text.is_empty() {
            return;
        }
        self.over.insert(at, val);
        self.changed.push(at);
    }

    /// After the cells in `edited` changed, works out again every formula that reads them,
    /// however indirectly, and the formula at `also` itself. Gives the cells whose stored value changed.
    pub fn recalc(&mut self, edited: &[Key], also: Option<Key>) -> Vec<(Key, Put)> {
        self.recalc_with(edited, &also.into_iter().collect())
    }

    /// The same, with any number of formulas worked out again whatever they read.
    fn recalc_with(&mut self, edited: &[Key], also: &HashSet<Key>) -> Vec<(Key, Put)> {
        self.changed.clear();
        let mut hit: Vec<usize> = self.formulas.iter().enumerate().filter(|(_, e)| also.contains(&e.at)).map(|(i, _)| i).collect();
        let mut seen = vec![false; self.formulas.len()];
        hit.iter().for_each(|i| seen[*i] = true);
        // a formula that may read anything reads what changed
        if !edited.is_empty() {
            for (i, e) in self.formulas.iter().enumerate() {
                if e.wild && !seen[i] {
                    seen[i] = true;
                    hit.push(i);
                }
            }
        }
        // from each cell that changed to the formulas that read it, and on from each of those
        let readers = Readers::new(&self.formulas);
        let mut front: VecDeque<Key> = edited.iter().copied().chain(hit.iter().map(|i| self.formulas[*i].at)).collect();
        // an array formula reached is not worked out, so the cells its results spread over are
        // as stale as it is: what reads them is reached too, and finds them not to be trusted
        let mut spread: Vec<Key> = Vec::new();
        let mut all = false;
        let spill = |e: &Entry, spread: &mut Vec<Key>, all: &mut bool| {
            let (rows, cols) = e.spill;
            if rows.saturating_mul(cols) > SPILL_MOST {
                *all = true;
            } else if rows * cols > 1 {
                spread.extend((0..rows).flat_map(|i| (0..cols).map(move |j| (e.at.0, e.at.1 + i, e.at.2 + j))).skip(1));
            }
        };
        hit.iter().for_each(|i| spill(&self.formulas[*i], &mut spread, &mut all));
        front.extend(spread.iter().copied());
        let (mut found, mut looked) = (Vec::new(), 0usize);
        while let Some((s, r, c)) = front.pop_front() {
            found.clear();
            if let Some(list) = readers.one.get(&(s, r, c)) {
                found.extend(list);
            }
            if let Some(t) = readers.cols.get(&(s, c)) {
                t.over(r, &mut found);
            }
            if let Some(t) = readers.rows.get(&(s, r)) {
                t.over(c, &mut found);
            }
            looked = looked.saturating_add(readers.blocks.len());
            // too many large ranges to look through for every cell: every formula is worked out again, so none is missed
            if looked > 50_000_000 || all {
                (0..self.formulas.len()).filter(|i| !std::mem::replace(&mut seen[*i], true)).for_each(|i| hit.push(i));
                break;
            }
            found.extend(readers.blocks.iter().filter(|(d, i)| !seen[*i] && d[0] == s && (d[1]..=d[3]).contains(&r) && (d[2]..=d[4]).contains(&c)).map(|(_, i)| *i));
            for i in found.drain(..) {
                if !std::mem::replace(&mut seen[i], true) {
                    hit.push(i);
                    front.push_back(self.formulas[i].at);
                    let from = spread.len();
                    spill(&self.formulas[i], &mut spread, &mut all);
                    front.extend(spread[from..].iter().copied());
                }
            }
        }
        // results spread too far to follow: every formula is worked out again, so none is missed
        if all {
            (0..self.formulas.len()).filter(|i| !std::mem::replace(&mut seen[*i], true)).for_each(|i| hit.push(i));
        }
        self.pending = hit.iter().map(|i| (self.formulas[*i].at, *i)).collect();
        // a formula that sits in such a cell is worked out for itself, and is what it comes to
        spread.retain(|k| !self.pending.contains_key(k));
        self.stale.extend(spread.iter().copied());
        self.unsure.extend(spread);
        // results spread too far to follow cell by cell: every cell under them is not to be trusted
        if all {
            for i in 0..self.formulas.len() {
                let (e, (rows, cols)) = (&self.formulas[i], self.formulas[i].spill);
                if rows.saturating_mul(cols) > SPILL_MOST {
                    self.wide.push([e.at.0, e.at.1, e.at.2, e.at.1.saturating_add(rows - 1), e.at.2.saturating_add(cols - 1)]);
                }
            }
        }
        // each is worked out with what it reads worked out first. One met too deep inside
        // others is put on top of them here, so the stack that grows is this one
        for i in hit {
            let mut stack = vec![i];
            let mut on: HashSet<usize> = HashSet::from([i]);
            while let Some(&top) = stack.last() {
                if self.pending.contains_key(&self.formulas[top].at) {
                    self.first = None;
                    self.compute(top);
                    match self.first.take() {
                        None => {}
                        Some(k) if on.insert(k) => {
                            stack.push(k);
                            continue;
                        }
                        // one that waits on itself through a ring longer than the depth: Calc's error for a ring
                        Some(k) => {
                            let at = self.formulas[k].at;
                            self.pending.remove(&at);
                            self.stale.remove(&at);
                            self.done.push(at);
                            let f = self.formulas[k].f.clone();
                            self.store(at, f, err("Err:522"));
                            continue;
                        }
                    }
                }
                stack.pop();
                on.remove(&top);
            }
        }
        self.pending.clear();
        let changed = std::mem::take(&mut self.changed);
        // a cell worked out twice is written once, as it ended
        let mut once = HashSet::new();
        changed.into_iter().filter(|k| once.insert(*k)).filter_map(|k| Some((k, self.over.get(&k)?.clone()))).collect()
    }
}

fn bin(op: &str, l: V, r: V) -> V {
    if op == "&" || matches!(op, "=" | "<>" | "<" | ">" | "<=" | ">=") {
        for side in [&l, &r] {
            if matches!(side, V::Err(_)) {
                return side.clone();
            }
        }
        if op == "&" {
            return V::Str(to_str(&l) + &to_str(&r));
        }
        let k = compare_op(&l, &r);
        return V::Bool(match op {
            "=" => k == 0,
            "<>" => k != 0,
            "<" => k < 0,
            ">" => k > 0,
            "<=" => k <= 0,
            _ => k >= 0,
        });
    }
    let (V::Num(a), b) = (to_num(&l), to_num(&r)) else { return to_num(&l) };
    let V::Num(b) = b else { return b };
    let v = match op {
        "+" => a + b,
        "-" => a - b,
        "*" => a * b,
        "/" if b == 0.0 => return err("#DIV/0!"),
        "/" => a / b,
        _ => return power(a, b),
    };
    if v.is_finite() { V::Num(v) } else { err("#NUM!") }
}

/// A change to how a cell looks or how its number is written.
#[derive(Clone, Debug, PartialEq)]
pub enum Fmt {
    Bold(bool),
    Italic(bool),
    Underline(bool),
    /// Left, centre or right, or nothing to let the value's kind say.
    Align(Option<char>),
    /// `general`, `number`, `percentage`, `currency`, `date` or `time`.
    Number(&'static str),
}

/// A flat ODS document with one cell's look or number format changed: a port of the web
/// client's `Book.format` for one cell. The cell takes a style that is its own with the
/// change, made when the page has none that says the same. A number given a format takes
/// the format's type and is shown as it writes it. No value changes, so nothing is worked out.
pub fn format_cell(src: &str, s: usize, r: usize, c: usize, change: &Fmt) -> Result<String, String> {
    let book = sheet::book(src)?;
    let styles = Styles::read(src, book.null_date);
    let cell = book.at(s, r, c).cloned().unwrap_or_default();
    if cell.covered {
        return Err("that cell is part of a merged cell".into());
    }
    let base = book.style_at(s, r, c);
    let mut new = Vec::new();
    let ch = match change {
        Fmt::Bold(on) => crate::styles::Change { bold: Some(*on), ..Default::default() },
        Fmt::Italic(on) => crate::styles::Change { italic: Some(*on), ..Default::default() },
        Fmt::Underline(on) => crate::styles::Change { underline: Some(*on), ..Default::default() },
        Fmt::Align(a) => crate::styles::Change { align: Some(*a), ..Default::default() },
        Fmt::Number(kind) => {
            let data = styles.format_for(kind).map(|(name, xml)| {
                new.extend(xml);
                name
            });
            crate::styles::Change { data: Some(data), ..Default::default() }
        }
    };
    let (name, more) = styles.restyle(&base, &ch);
    new.extend(more);
    let page = crate::styles::add_auto(src, &new)?;
    let mut put = Put { f: cell.f.clone(), vt: cell.vt.clone(), v: cell.v.clone().unwrap_or(Val::Blank), text: cell.text.clone(), err: cell.err, st: Some(name.clone()) };
    // a number given a format is of the format's type, and shows as the format writes it
    if let (Fmt::Number(kind), Val::Num(n)) = (change, &put.v) {
        if !put.vt.is_empty() && put.vt != "string" && put.vt != "boolean" {
            put.vt = if matches!(*kind, "percentage" | "currency" | "date" | "time") { (*kind).to_owned() } else { "float".to_owned() };
            put.text = Styles::read(&page, book.null_date).text(&name, *n, &put.vt);
        }
    }
    if name == base && put.vt == cell.vt && new.is_empty() {
        return Ok(src.to_owned());
    }
    sheet::put_cell(&page, s, r, c, &put, Care::Result)
}

/// A page after something was typed into a cell, and how many formulas
/// in it could not be worked out here.
#[derive(Debug)]
pub struct Entered {
    pub body: String,
    /// The formulas this change reached that could not be worked out here: sheet, row, column.
    pub stale: Vec<(usize, usize, usize)>,
    /// The formulas it reached that were.
    pub done: Vec<(usize, usize, usize)>,
}

/// Puts what was typed into a cell of a flat ODS document: a value, or
/// a formula when it starts with `=`. Then every formula that reads the
/// cell, however indirectly, is worked out again and its result written.
// ponytail: this runs where it is called. A worker if a large sheet stalls the window
pub fn enter(src: &str, s: usize, r: usize, c: usize, typed: &str) -> Result<Entered, String> {
    enter_knowing(src, s, r, c, typed, &[])
}

/// The same, told which formulas an earlier change left stale. A formula worked out now
/// from one of those is stale too, and is not among the done: without this, a formula
/// that reads a stale one is worked out from its old value the next time something else
/// it reads changes.
pub fn enter_knowing(src: &str, s: usize, r: usize, c: usize, typed: &str, stale: &[(usize, usize, usize)]) -> Result<Entered, String> {
    let formula = typed.len() > 1 && typed.starts_with('=');
    // the page is read once here: a large one takes long enough to read
    let before = sheet::book(src)?;
    let mut styles = Styles::read(src, before.null_date);
    let mut body = if formula {
        let f = formula::to_of(typed).map_err(|e| format!("that formula cannot be read: {e}"))?;
        // until it is worked out the cell holds no value: if it cannot be here, LibreOffice will when it opens the page
        sheet::put_cell(src, s, r, c, &Put { f: Some(f), vt: String::new(), v: Val::Blank, text: String::new(), err: false, st: None }, Care::Formula)?
    } else {
        // a number typed into a formatted cell takes the format's type, and shows as the format writes it
        let style = before.style_at(s, r, c);
        let what = sheet::typed_on(typed, before.null_date)?;
        let mut put: Put = what.clone().into();
        let has = styles.kind(&style);
        let mut page = src.to_owned();
        // what the cell shows, typed again as its own format writes it, is a value of the cell's
        // kind and not a text: a date in the cell's pattern, money with the cell's symbol
        let own = match &what {
            Typed::Text(_) if !typed.starts_with('\'') => styles.read_as(&style, typed.trim()),
            _ => None,
        };
        match what {
            Typed::Text(_) if own.is_some() => {
                let (n, vt) = (own.unwrap_or(0.0), has.unwrap_or("float"));
                put = Put { vt: vt.to_owned(), v: Val::Num(n), text: styles.text(&style, n, vt), ..put };
            }
            Typed::Number(n) => {
                let n = if has == Some("percentage") { n / 100.0 } else { n };
                put = Put { vt: has.unwrap_or("float").to_owned(), v: Val::Num(n), text: styles.text(&style, n, has.unwrap_or("float")), ..put };
            }
            // a date, a time, a percentage or money typed as one: its cell takes a format for it, made when the page has none
            Typed::Special(vt, n) => {
                let mut st = style;
                if has != Some(vt) {
                    let (name, new) = styles.with_format(&st, vt);
                    page = crate::styles::add_auto(&page, &new)?;
                    styles = Styles::read(&page, before.null_date);
                    put.st = Some(name.clone());
                    st = name;
                }
                put.text = styles.text(&st, n, vt);
            }
            _ => {}
        }
        sheet::put_cell(&page, s, r, c, &put, Care::Typed)?
    };
    let book = sheet::book(&body)?;
    let mut eng = Engine::new(&book, &styles);
    // the cell typed into is what was typed, whatever it was before
    let (was_stale, stale_was) = (stale.contains(&(s, r, c)), stale);
    // an array formula typed over spreads no more. The cells its results lay in are plain cells
    // now, holding what they held: they are stale no longer, and what reads them is worked out again
    let freed: HashSet<Key> = before
        .at(s, r, c)
        .filter(|cell| cell.array && cell.f.is_some() && cell.spill.0.saturating_mul(cell.spill.1) <= SPILL_MOST)
        .map(|cell| (0..cell.spill.0).flat_map(|i| (0..cell.spill.1).map(move |j| (s, r + i, c + j))).filter(|k| *k != (s, r, c)).collect())
        .unwrap_or_default();
    let known: Vec<Key> = stale.iter().copied().filter(|k| *k != (s, r, c) && !freed.contains(k)).collect();
    eng.distrust(&known);
    let mut edited = vec![(s, r, c)];
    edited.extend(freed.iter().copied());
    let mut results = eng.recalc(&edited, formula.then_some((s, r, c)));
    let stale: Vec<Key> = {
        let mut v: Vec<Key> = eng.stale.iter().copied().collect();
        v.sort_unstable();
        v
    };
    let mut done = std::mem::take(&mut eng.done);
    // a value typed over a formula that was stale is stale no more
    if !formula && was_stale {
        done.push((s, r, c));
    }
    done.extend(stale_was.iter().copied().filter(|k| freed.contains(k)));
    // a formula that makes a date or a time, in a cell with no number format of its own, gets one:
    // =DATE(2026,11,10) shows as a date and not as the day number, as it does in Calc
    if formula {
        let made = formula::to_of(typed).ok().and_then(|f| formula::parse(formula::body_of(&f)?, Mode::Of).ok()).and_then(|mut top| {
            while let Node::Paren(x) = top {
                top = *x;
            }
            match top {
                Node::Call(name, _) => match name.as_str() {
                    "DATE" | "TODAY" | "EDATE" | "EOMONTH" | "NOW" => Some("date"),
                    "TIME" => Some("time"),
                    _ => None,
                },
                _ => None,
            }
        });
        let style = book.style_at(s, r, c);
        if let (Some(vt), Some((_, put))) = (made.filter(|_| !styles.formatted(&style)), results.iter_mut().find(|(k, p)| *k == (s, r, c) && p.vt == "float")) {
            let (name, new) = styles.with_format(&style, vt);
            body = crate::styles::add_auto(&body, &new)?;
            let styles = Styles::read(&body, book.null_date);
            if let Val::Num(n) = put.v {
                *put = Put { vt: vt.to_owned(), text: styles.text(&name, n, vt), st: Some(name), ..put.clone() };
            }
        }
    }
    let results = if eng.ran_out.get() { with_blanks(&book, results, &stale) } else { results };
    Ok(Entered { body: write(body, results)?, stale, done })
}

/// The results of a change, and with them a blank for each formula that was left stale for want of a budget of
/// cells to read: it still says what it worked out to before the change, and saved with that value it would read
/// as current. With none, LibreOffice works it out when the page is opened, as it does for a formula typed in
/// here that cannot be worked out. A formula left stale for a function not known here keeps its value, as it
/// does in the web client, whose pages this one is held to.
fn with_blanks(book: &Book, mut results: Vec<(Key, Put)>, stale: &[Key]) -> Vec<(Key, Put)> {
    let done: HashSet<Key> = results.iter().map(|(k, _)| *k).collect();
    for &k in stale.iter().filter(|k| !done.contains(k)) {
        if let Some(cell) = book.at(k.0, k.1, k.2).filter(|c| c.f.is_some() && !c.array && !c.covered) {
            results.push((k, Put { f: cell.f.clone(), vt: String::new(), v: Val::Blank, text: String::new(), err: false, st: None }));
        }
    }
    results
}

/// The page with each sheet's results written, in one pass over the page for each sheet.
fn write(mut body: String, results: Vec<(Key, Put)>) -> Result<String, String> {
    let mut by_sheet: std::collections::BTreeMap<usize, std::collections::BTreeMap<usize, Vec<(usize, Put)>>> = Default::default();
    for ((s2, r2, c2), put) in results {
        by_sheet.entry(s2).or_default().entry(r2).or_default().push((c2, put));
    }
    for (s2, rows) in &by_sheet {
        body = sheet::put_cells(&body, *s2, rows, Care::Result)?;
    }
    Ok(body)
}

/// Puts rows into a sheet before row `at` (`n` above nothing), or takes
/// `-n` rows out from `at`. Every reference follows, and the formulas
/// the change reached are worked out again: all of them when rows went,
/// since a range may have lost values. When rows came, those now pointing
/// at nothing, those that ask where a cell is (ROW, COLUMN), those with a
/// range the new rows are in, since it grew, and whatever reads these.
pub fn shift(src: &str, s: usize, rows: bool, at: usize, n: i64) -> Result<Entered, String> {
    shift_knowing(src, s, rows, at, n, &[])
}

/// The same, told which formulas an earlier change left stale. Rows put in work out only
/// what they reached, so the rest of those are stale still, where they moved to, and are
/// among the stale that come back. Rows taken out have every formula worked out afresh.
pub fn shift_knowing(src: &str, s: usize, rows: bool, at: usize, n: i64, stale: &[(usize, usize, usize)]) -> Result<Entered, String> {
    let body = crate::shift::shift(src, s, rows, at as i64, n)?;
    let book = sheet::book(&body)?;
    let styles = Styles::read(&body, book.null_date);
    let mut eng = Engine::new(&book, &styles);
    let (lo, hi) = (at, at.saturating_add(n.unsigned_abs() as usize - 1));
    let grew = |d: &[usize; 5]| d[0] == s && if rows { d[1] <= hi && d[3] >= lo } else { d[2] <= hi && d[4] >= lo };
    let placed = |e: &Entry| e.wild || e.deps.iter().any(grew) || e.ast.as_ref().is_some_and(|a| calls(a, &["ROW", "COLUMN"]));
    let again: Vec<Key> = eng.formulas.iter().filter(|e| n < 0 || e.f.contains("#REF!") || placed(e)).map(|e| e.at).collect();
    let by = n.unsigned_abs() as usize;
    let known: Vec<Key> = stale
        .iter()
        .filter(|_| n > 0)
        .map(|&(ks, kr, kc)| match (ks == s, rows) {
            (true, true) if kr >= at => (ks, kr.saturating_add(by), kc),
            (true, false) if kc >= at => (ks, kr, kc.saturating_add(by)),
            _ => (ks, kr, kc),
        })
        .collect();
    eng.distrust(&known);
    let results = if again.is_empty() { Vec::new() } else { eng.recalc_with(&again, &again.iter().copied().collect()) };
    let done = std::mem::take(&mut eng.done);
    let worked: HashSet<Key> = done.iter().copied().collect();
    let mut stale: Vec<Key> = eng.stale.iter().copied().chain(known.into_iter().filter(|k| !worked.contains(k))).collect();
    stale.sort_unstable();
    stale.dedup();
    Ok(Entered { body: write(body, results)?, stale, done })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sheet as LibreOffice writes one, from rows of cells: text, a number, or a formula with its cached result.
    fn doc(rows: &[&[&str]]) -> String {
        let mut out = String::from("<?xml version=\"1.0\"?>\n<office:document xmlns:calcext=\"urn:c\">\n <office:body>\n  <office:spreadsheet>\n   <table:table table:name=\"One\">\n");
        for row in rows {
            out.push_str("    <table:table-row>\n");
            for cell in *row {
                let x = if cell.is_empty() {
                    "<table:table-cell/>".to_owned()
                } else if let Some((f, was)) = cell.strip_prefix('=').and_then(|c| c.split_once('|')) {
                    let f = formula::to_of(&format!("={f}")).unwrap().replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;");
                    format!("<table:table-cell table:formula=\"{f}\" office:value-type=\"float\" office:value=\"{was}\" calcext:value-type=\"float\">\n      <text:p>{was}</text:p>\n     </table:table-cell>")
                } else if cell.parse::<f64>().is_ok() {
                    format!("<table:table-cell office:value-type=\"float\" office:value=\"{cell}\" calcext:value-type=\"float\">\n      <text:p>{cell}</text:p>\n     </table:table-cell>")
                } else {
                    format!("<table:table-cell office:value-type=\"string\" calcext:value-type=\"string\">\n      <text:p>{cell}</text:p>\n     </table:table-cell>")
                };
                out.push_str(&format!("     {x}\n"));
            }
            out.push_str("    </table:table-row>\n");
        }
        out + "   </table:table>\n  </office:spreadsheet>\n </office:body>\n</office:document>\n"
    }

    fn grid(body: &str) -> Vec<Vec<String>> {
        sheet::parse(body)[0].rows.clone()
    }

    /// A change of style from its spelling in an edits file: `bold=1`, `align=c`, `align=-`, `number=percentage`.
    fn fmt_of(op: &str) -> Fmt {
        let (k, v) = op.split_once('=').unwrap();
        match k {
            "bold" => Fmt::Bold(v == "1"),
            "italic" => Fmt::Italic(v == "1"),
            "underline" => Fmt::Underline(v == "1"),
            "align" => Fmt::Align(v.chars().next().filter(|c| *c != '-')),
            _ => Fmt::Number(["general", "number", "percentage", "currency", "date", "time"].into_iter().find(|n| *n == v).unwrap()),
        }
    }

    /// Types the lines of the file `LR_EDITS` (`sheet,row,column,text`) into the spreadsheet in
    /// `LR_FODS` and writes it to `LR_OUT`, to compare with LibreOffice and the web client.
    #[test]
    #[ignore]
    fn real_enter() {
        let (Ok(f), Ok(e), Ok(o)) = (std::env::var("LR_FODS"), std::env::var("LR_EDITS"), std::env::var("LR_OUT")) else { return };
        let mut doc = std::fs::read_to_string(f).unwrap();
        for line in std::fs::read_to_string(e).unwrap().lines() {
            let p: Vec<&str> = line.splitn(4, ',').collect();
            let at = (p[0].parse().unwrap(), p[1].parse().unwrap(), p[2].parse().unwrap());
            // a line whose text starts with ! is a change of style: !bold=1, !align=c, !number=percentage
            if let Some(n) = p[3].strip_prefix("!cols=") {
                doc = shift(&doc, at.0, false, at.2, n.parse().unwrap()).map_or_else(|why| { println!("{line}: {why}"); doc.clone() }, |g| g.body);
                continue;
            }
            if let Some(n) = p[3].strip_prefix("!rows=") {
                doc = shift(&doc, at.0, true, at.1, n.parse().unwrap()).map_or_else(|why| { println!("{line}: {why}"); doc.clone() }, |g| g.body);
                continue;
            }
            if let Some(op) = p[3].strip_prefix('!') {
                doc = format_cell(&doc, at.0, at.1, at.2, &fmt_of(op)).unwrap();
                continue;
            }
            let got = enter(&doc, at.0, at.1, at.2, p[3]).unwrap();
            println!("{line}: {} stale", got.stale.len());
            doc = got.body;
        }
        std::fs::write(o, doc).unwrap();
    }

    #[test]
    fn an_edit_works_out_again_what_reads_it_and_nothing_else() {
        // B1 reads A1, C1 reads B1, D1 reads nothing that changes, A2 reads the column A is in
        let src = doc(&[&["2", "=A1*10|20", "=B1+1|21", "=7-2|999"], &["=A1&\"x\"|0"]]);
        let got = enter(&src, 0, 0, 0, "5").unwrap();
        assert_eq!(grid(&got.body), [vec!["5", "50", "51", "999"], vec!["5x"]], "the chain is followed, and a formula that reads nothing changed keeps even a wrong cached value");
        assert!(got.stale.is_empty());
        // the results are stored as LibreOffice stores them: the formula kept, the value beside it
        assert!(got.body.contains("<table:table-cell table:formula=\"of:=[.A1]*10\" office:value-type=\"float\" office:value=\"50\" calcext:value-type=\"float\">\n      <text:p>50</text:p>\n     </table:table-cell>"), "{}", got.body);
        assert!(got.body.contains("table:formula=\"of:=[.A1]&amp;&quot;x&quot;\" office:value-type=\"string\" office:string-value=\"5x\" calcext:value-type=\"string\""), "{}", got.body);
        // an edit nothing reads changes that cell alone
        let lone = enter(&src, 0, 3, 3, "note").unwrap();
        assert_eq!(grid(&lone.body)[0], ["2", "20", "21", "999"]);
    }

    #[test]
    fn a_typed_formula_is_stored_and_worked_out() {
        let src = doc(&[&["2", "3"], &["4"]]);
        let got = enter(&src, 0, 1, 1, "=(a1+B1)*A2^2").unwrap();
        assert_eq!(grid(&got.body)[1], ["4", "80"]);
        assert!(got.body.contains("table:formula=\"of:=([.A1]+[.B1])*[.A2]^2\" office:value-type=\"float\" office:value=\"80\""));
        // what reads the new formula follows it, and typing a value over a formula takes the formula away
        let more = enter(&got.body, 0, 2, 0, "=B2/8").unwrap();
        assert_eq!(grid(&more.body)[2], ["10"]);
        let over = enter(&more.body, 0, 1, 1, "16").unwrap();
        assert_eq!((grid(&over.body)[1][1].as_str(), grid(&over.body)[2][0].as_str()), ("16", "2"));
        assert!(!over.body.contains("[.A2]^2"));
        // a formula that cannot be read says why, and the page is left alone
        assert_eq!(enter(&src, 0, 0, 0, "=1+").unwrap_err(), "that formula cannot be read: the formula ends too soon");
    }

    #[test]
    fn values_follow_calcs_rules() {
        let v = |f: &str| {
            let src = doc(&[&["2", "abc", "", "TRUE", "3.5"], &["0"]]);
            let got = enter(&src, 0, 5, 0, &format!("={f}")).unwrap();
            grid(&got.body).get(5).and_then(|r| r.first().cloned()).unwrap_or_else(|| format!("nothing: {}", &got.body[got.body.len().saturating_sub(700)..]))
        };
        // each line is a formula and what the web client's engine shows for it on the same sheet,
        // from ui-src/sheet/book.js run under node
        let mut n = 0;
        for line in include_str!("calc_corpus.tsv").lines() {
            let (f, want) = line.split_once('\t').unwrap();
            let (f, want): (String, String) = (serde_json::from_str(f).unwrap(), serde_json::from_str(want).unwrap());
            assert_eq!(v(&f), want, "={f}");
            n += 1;
        }
        assert_eq!(n, 59);
    }

    /// The formulas of the web client's corpora that LibreOffice answers otherwise, with its answer, which
    /// is the one held here: a year of two figures under 30 is in the 2000s, the hour and the minute of a
    /// time are those it is in, a criterion of "TRUE" finds the truth and the text, a number and a step
    /// of unlike signs are refused, and a step of nought gives nought.
    const LIBREOFFICE: [(&str, &str); 19] = [
        ("DATE(0,1,1)+0", "36526"), ("HOUR(0.999999)", "23"), ("MINUTE(0.999999)", "59"), ("HOUR(B2)", "23"), ("MINUTE(B2)", "59"), ("COUNTIF(A1:E4,\"TRUE\")", "2"), ("CEILING(-2.1,0.5)", "Err:502"), ("FLOOR(2,0)", "0"),
        // a capital after a figure, nothing found when there is nothing to look for, `*` for any run in SEARCH, and no
        // occurrence, start or count below what there can be
        ("PROPER(\"hello wORLD-foo 2nd o'brien\")", "Hello World-Foo 2Nd O'Brien"), ("FIND(\"\",\"hello\")", "#VALUE!"), ("FIND(\"\",\"hello\",9)", "#VALUE!"), ("SEARCH(\"*\",\"a*b\")", "1"),
        ("SUBSTITUTE(\"a-b-c\",\"-\",\"+\",0)", "Err:502"), ("SUBSTITUTE(\"a-b-c\",\"-\",\"+\",1.5)", "a+b-c"), ("SUBSTITUTE(\"abcd\",\"bc\",\"X\",0)", "Err:502"), ("SUBSTITUTE(\"a-b\",\"-\",\"+\",-1)", "Err:502"),
        ("REPLACE(\"hello\",0,1,\"X\")", "Err:502"), ("REPLACE(\"hello\",2,-1,\"X\")", "Err:502"), ("REPLACE(\"hello\",2.5,1.5,\"X\")", "hXllo"),
    ];

    /// Checks formulas against the web client's answers. Each line of a corpus is a formula and what
    /// the web client's engine shows for it in G8 of the sheet, from ui-src/sheet/book.js run under
    /// node. STALE is a formula it does not work out either. Where LibreOffice answers otherwise
    /// (`LIBREOFFICE`), its answer is the one checked.
    fn corpus(sheet: &[&[&str]], lines: &str, count: usize) {
        let src = doc(sheet);
        let (mut n, mut wrong) = (0, Vec::new());
        for line in lines.lines() {
            let (f, want) = line.split_once('\t').unwrap();
            let (f, want): (String, String) = (serde_json::from_str(f).unwrap(), serde_json::from_str(want).unwrap());
            let want = LIBREOFFICE.iter().find(|(g, _)| *g == f).map_or(want, |(_, lo)| (*lo).to_owned());
            let got = enter(&src, 0, 7, 6, &format!("={f}")).unwrap();
            let shown = if got.stale.contains(&(0, 7, 6)) { "STALE".to_owned() } else { grid(&got.body).get(7).and_then(|r| r.get(6).cloned()).unwrap_or_default() };
            if shown != want {
                wrong.push(format!("={f} gave {shown}, the web gives {want}"));
            }
            n += 1;
        }
        assert!(wrong.is_empty(), "{} of {n} differ:\n{}", wrong.len(), wrong.join("\n"));
        assert_eq!(n, count);
    }

    #[test]
    fn functions_give_what_the_web_client_gives() {
        let sheet: &[&[&str]] = &[&["2", "abc", "", "TRUE", "3.5"], &["0", "-4", "10", "x", "7"], &["5", "5", "2.5", "apple", "1"], &["", "12", "Banana", "3", "-1"]];
        corpus(sheet, include_str!("funcs_corpus.tsv"), 266);
        corpus(sheet, include_str!("funcs_text_corpus.tsv"), 127);
    }

    #[test]
    fn lookups_give_what_the_web_client_gives() {
        let sheet: &[&[&str]] = &[&["1", "apple", "10", "x", "3.5"], &["3", "banana", "20", "y", "7"], &["5", "cherry", "30", "apple", "1"], &["7", "date", "40", "3", "-1"], &["", "egg", "50", "", ""]];
        corpus(sheet, include_str!("funcs_lookup_corpus.tsv"), 107);
    }

    #[test]
    fn dates_and_times_give_what_the_web_client_gives() {
        let sheet: &[&[&str]] = &[&["46343", "46343.75", "0.5", "abc", "-3"], &["2026-11-17", "45000.999999", "60", "", ""]];
        corpus(sheet, include_str!("funcs_date_corpus.tsv"), 133);
    }

    #[test]
    fn numbers_are_shown_by_their_cells_format_as_on_the_web() {
        // a sheet with eleven number formats, typed into. The expected grid is what the web client's
        // Book gives for the same sheet and the same typing, from node: each cell's text and type.
        // But for money that is owed, in a format with no form of its own for it: the web client writes
        // $-1,234.50, and here it is -$1,234.50, as LibreOffice writes it
        let mut body = include_str!("formats_fixture.fods").to_owned();
        for line in include_str!("formats_edits.txt").lines() {
            let p: Vec<&str> = line.splitn(4, ',').collect();
            body = enter(&body, p[0].parse().unwrap(), p[1].parse().unwrap(), p[2].parse().unwrap(), p[3]).unwrap().body;
        }
        let book = sheet::book(&body).unwrap();
        let got: Vec<String> = (0..13).map(|r| (0..3).map(|c| book.at(0, r, c).map_or(String::new(), |x| if c == 0 { x.text.clone() } else { format!("{}[{}]", x.text, x.vt) })).collect::<Vec<_>>().join(" | ")).collect();
        assert_eq!(got.join("\n"), include_str!("formats_expected.txt").trim_end());
        // a percentage typed as 75 is stored as three quarters, and money keeps its currency
        assert!(body.contains("office:value-type=\"percentage\" office:value=\"0.75\""));
        assert!(body.contains("office:value-type=\"currency\" office:currency=\"USD\" office:value=\"-1234.5\""));
        assert!(body.contains("office:value-type=\"date\" office:date-value=\"2025-12-09\""));
    }

    #[test]
    fn typed_dates_and_money_write_the_page_the_web_client_writes() {
        // a sheet LibreOffice made, with a percentage, money, a date, a time and date formulas typed
        // into it. The expected page is the web client's Book given the same typing, from node:
        // the same bytes, the new styles and their hashed names included
        let mut body = include_str!("typed_fixture.fods").to_owned();
        for line in include_str!("typed_edits.txt").lines() {
            let p: Vec<&str> = line.splitn(4, ',').collect();
            body = enter(&body, p[0].parse().unwrap(), p[1].parse().unwrap(), p[2].parse().unwrap(), p[3]).unwrap().body;
        }
        assert!(body == include_str!("typed_expected.fods"), "the page differs from the web client's");
        // typed again into a cell that has the format, no style is made twice
        let again = enter(&body, 0, 1, 1, "10%").unwrap().body;
        assert_eq!(again.matches("<number:percentage-style").count(), body.matches("<number:percentage-style").count());
        assert_eq!(again.matches("<style:style").count(), body.matches("<style:style").count());
        assert_eq!(crate::styles::hash("lattice"), format!("{:08x}", "lattice".bytes().fold(0x811c_9dc5u32, |h, c| (h ^ u32::from(c)).wrapping_mul(0x0100_0193))));
    }

    #[test]
    fn rows_are_put_in_and_taken_out_as_the_web_client_does_it() {
        // a two-sheet page LibreOffice made, with formulas across the sheets, a named range, a print
        // range, a merged cell and a run of blank rows. Rows go in and come out of both sheets, with
        // typing between. The expected page is the web client's Book given the same, from node
        let fixture = include_str!("rows_fixture.fods");
        let mut body = fixture.to_owned();
        for line in include_str!("rows_edits.txt").lines() {
            let p: Vec<&str> = line.splitn(4, ',').collect();
            let at = (p[0].parse().unwrap(), p[1].parse().unwrap(), p[2].parse().unwrap());
            body = match p[3].strip_prefix("!rows=") {
                Some(n) => shift(&body, at.0, true, at.1, n.parse().unwrap()).unwrap().body,
                None => enter(&body, at.0, at.1, at.2, p[3]).unwrap().body,
            };
        }
        assert!(body == include_str!("rows_expected.fods"), "the page differs from the web client's");
        // a row put in above the costs: the formulas, the named range and the print range all follow
        let down = shift(fixture, 0, true, 1, 1).unwrap().body;
        assert!(down.contains("table:formula=\"of:=SUM([.B3:.B5])\"") && down.contains("table:cell-range-address=\"$One.$B$3:.$B$5\"") && down.contains("table:print-ranges=\"One.A1:One.C8\""));
        assert!(down.contains("table:formula=\"of:=[.B$3]+[.$B4]\"") && down.contains("of:=SUM([.3:.5])") && down.contains("of:=COUNTA([.A:.A])"));
        // the other sheet's reference into this one follows too, and its own cells stay
        assert!(down.contains("of:=SUM([.B2:.B3])+[One.B7]") && down.contains("of:=[$One.$C$3]"));
        // the rows a formula read taken out: it says so, and so does what reads it
        let gone = shift(fixture, 0, true, 1, -3).unwrap().body;
        let book = sheet::book(&gone).unwrap();
        assert_eq!(book.at(0, 2, 1).map(|c| (c.f.clone().unwrap(), c.text.clone())), Some(("of:=SUM(#REF!)".to_owned(), "#REF!".to_owned())));
        assert!(!gone.contains("table:cell-range-address=\"$One.$B$2"), "a named range whose cells all went keeps no address");
        // refused whole, with the page as it was: a merged cell cut, the edge of the sheet, a chart
        assert_eq!(shift(fixture, 0, true, 13, 1).unwrap_err(), "that would cut through a merged cell");
        assert_eq!(shift(fixture, 0, true, 12, -1).unwrap_err(), "that would cut through a merged cell");
        assert_eq!(shift(fixture, 0, true, 1_048_575, 2).unwrap_err(), "that is past the edge of the sheet");
        assert_eq!(shift(fixture, 5, true, 0, 1).unwrap_err(), "nothing to do");
        let chart = fixture.replacen("<table:table-row ", "<table:shapes><draw:frame><draw:object/></draw:frame></table:shapes><table:table-row ", 1);
        assert_eq!(shift(&chart, 0, true, 0, 1).unwrap_err(), "this spreadsheet has a chart or an embedded object, which lattice cannot keep in step");
        let filter = fixture.replacen("<table:named-expressions>", "<table:database-ranges><table:database-range table:target-range-address=\"One.A1:One.C4\"><table:filter table:condition-source-range-address=\"One.A1:One.A2\"/></table:database-range></table:database-ranges><table:named-expressions>", 1);
        assert_eq!(shift(&filter, 0, true, 0, 1).unwrap_err(), "this spreadsheet has a filter lattice cannot keep in step");
        // below everything stored, nothing in the page moves
        assert_eq!(shift(fixture, 1, true, 500, 3).unwrap().body, fixture);
    }

    #[test]
    fn columns_are_put_in_and_taken_out_as_the_web_client_does_it() {
        // the same two-sheet page, with columns going in and coming out of both sheets, a row put in
        // and typing between. The expected page is the web client's Book given the same, from node
        let fixture = include_str!("rows_fixture.fods");
        let mut body = fixture.to_owned();
        for line in include_str!("cols_edits.txt").lines() {
            let p: Vec<&str> = line.splitn(4, ',').collect();
            let at: (usize, usize, usize) = (p[0].parse().unwrap(), p[1].parse().unwrap(), p[2].parse().unwrap());
            body = match (p[3].strip_prefix("!cols="), p[3].strip_prefix("!rows=")) {
                (Some(n), _) => shift(&body, at.0, false, at.2, n.parse().unwrap()).unwrap().body,
                (_, Some(n)) => shift(&body, at.0, true, at.1, n.parse().unwrap()).unwrap().body,
                _ => enter(&body, at.0, at.1, at.2, p[3]).unwrap().body,
            };
        }
        assert!(body == include_str!("cols_expected.fods"), "the page differs from the web client's");
        // a column put in before the costs: formulas, the named range and the print range follow, and the
        // column elements gain one made like its neighbour
        let right = shift(fixture, 0, false, 0, 1).unwrap().body;
        assert!(right.contains("table:formula=\"of:=SUM([.C2:.C4])\"") && right.contains("table:cell-range-address=\"$One.$C$2:.$C$4\"") && right.contains("table:print-ranges=\"One.B1:One.D7\""));
        assert!(right.contains("of:=COUNTA([.B:.B])") && right.contains("of:=SUM([.2:.4])"), "whole columns move, whole rows do not");
        let cols = |page: &str| sheet::book(page).unwrap().sheets[0].cols.iter().map(|c| c.0).sum::<usize>();
        assert_eq!(cols(&right), cols(fixture) + 1);
        // the column a formula read taken out
        let gone = shift(fixture, 0, false, 2, -1).unwrap().body;
        assert_eq!(sheet::book(&gone).unwrap().at(0, 6, 1).map(|c| c.text.clone()).as_deref(), Some("#REF!"));
        // a merged cell is not cut, and the last column is the edge
        assert_eq!(shift(fixture, 0, false, 1, 1).unwrap_err(), "that would cut through a merged cell");
        assert_eq!(shift(fixture, 0, false, 16_383, 2).unwrap_err(), "that is past the edge of the sheet");
        // right of everything stored, nothing in the page moves
        assert_eq!(shift(fixture, 1, false, 500, 3).unwrap().body, fixture);
    }

    #[test]
    fn a_cells_style_is_set_as_the_web_client_sets_it() {
        // the LibreOffice-made sheet with bold, italic, underline, alignment and number formats put on
        // and taken off, and values typed between. The expected page is the web client's Book given the
        // same, from node: the same bytes
        let mut body = include_str!("typed_fixture.fods").to_owned();
        for line in include_str!("style_edits.txt").lines() {
            let p: Vec<&str> = line.splitn(4, ',').collect();
            let at = (p[0].parse().unwrap(), p[1].parse().unwrap(), p[2].parse().unwrap());
            body = match p[3].strip_prefix('!') {
                Some(op) => format_cell(&body, at.0, at.1, at.2, &fmt_of(op)).unwrap(),
                None => enter(&body, at.0, at.1, at.2, p[3]).unwrap().body,
            };
        }
        assert!(body == include_str!("style_expected.fods"), "the page differs from the web client's");
        // set as it already is, the page is not touched
        assert_eq!(format_cell(&body, 0, 0, 1, &Fmt::Bold(true)).unwrap(), body);
        // a merged-over cell is refused
        let merged = body.replacen("<table:table-cell/>", "<table:covered-table-cell/>", 1);
        if merged != body {
            let book = sheet::book(&merged).unwrap();
            let at = (0..20).flat_map(|r| (0..10).map(move |c| (r, c))).find(|(r, c)| book.at(0, *r, *c).is_some_and(|x| x.covered));
            if let Some((r, c)) = at {
                assert_eq!(format_cell(&merged, 0, r, c, &Fmt::Bold(true)).unwrap_err(), "that cell is part of a merged cell");
            }
        }
    }

    #[test]
    fn what_ended_or_held_the_app_is_refused_or_quick() {
        let sheet = doc(&[&["1", "2"], &["3", "4"]]);
        let t = std::time::Instant::now();
        // no arguments, a count past any number, a pattern of many stars, a row of twenty thousand terms
        for typed in ["=RANK()", "=FACT(1E+15)", "=FACT(3000000000)", "=COUNTIF(A1:A1,\"*a*a*a*a*a*a*a*a*a*a*a*a*a*ab\")"] {
            let _ = enter(&sheet, 0, 1, 1, typed);
        }
        let seeded = enter(&sheet, 0, 0, 0, &"a".repeat(40)).map(|e| e.body).unwrap_or(sheet.clone());
        let _ = enter(&seeded, 0, 1, 1, "=COUNTIF(A1:A1,\"*a*a*a*a*a*a*a*a*a*a*a*a*a*ab\")");
        let long = format!("=1{}", "+1".repeat(20_000));
        assert!(enter(&sheet, 0, 2, 2, &long).is_err());
        assert!(enter(&sheet, 0, 2, 2, &format!("=1{}", "+1".repeat(500))).is_ok());
        assert!(t.elapsed().as_secs() < 5, "{:?}", t.elapsed());
    }

    /// A column of formulas as rows of one cell each, for `doc`.
    fn rows_of(cells: &[String]) -> String {
        let rows: Vec<Vec<&str>> = cells.iter().map(|c| c.split('\t').collect()).collect();
        let rows: Vec<&[&str]> = rows.iter().map(Vec::as_slice).collect();
        doc(&rows)
    }

    #[test]
    fn an_array_formula_keeps_what_it_had_and_sumproduct_goes_cell_by_cell() {
        let plain = doc(&[&["1", "4", "=SUM(A1:A3*B1:B3)|32", "=SUMPRODUCT(A1:A3*B1:B3)|32", "=SUMPRODUCT((A1:A3>1)*B1:B3)|11", "=SUMPRODUCT(A1:A3,B1:B3+1)|38"], &["2", "5"], &["3", "6"]]);
        // LibreOffice marks an array formula with how far its results spread
        let src = plain.replacen("table:formula=\"of:=SUM(", "table:number-matrix-columns-spanned=\"1\" table:number-matrix-rows-spanned=\"1\" table:formula=\"of:=SUM(", 1);
        assert_ne!(src, plain);
        let got = enter(&src, 0, 0, 0, "10").unwrap();
        // the array formula is not worked out as if it were a plain one, which would give 40: it keeps its 32 and is counted
        assert_eq!(grid(&got.body)[0], ["10", "4", "32", "68", "15", "83"]);
        assert_eq!(got.stale, [(0, 0, 2)]);
        // typed over, the cell is no array formula any more
        let over = enter(&src, 0, 0, 2, "=A1+1").unwrap();
        assert!(!over.body.contains("number-matrix"), "{}", over.body);
        assert_eq!((grid(&over.body)[0][2].as_str(), over.stale.len()), ("2", 0));
        // ranges that do not match in size, and a function that would need each cell in turn
        let v = |f: &str| {
            let got = enter(&src, 0, 4, 0, f).unwrap();
            (grid(&got.body).get(4).and_then(|r| r.first().cloned()).unwrap_or_default(), got.stale.contains(&(0, 4, 0)))
        };
        assert_eq!(v("=SUMPRODUCT(A1:A3*B1:B2)"), (String::new(), true));
        assert_eq!(v("=SUMPRODUCT(IF(A1:A3>1,B1:B3,0)*1)"), (String::new(), true));
        assert_eq!(v("=SUMPRODUCT(A1:A3*2,B1:B2)"), ("#VALUE!".to_owned(), false));
        assert_eq!(v("=SUMPRODUCT(-A1:A3,B1:B3%)"), ("-0.32".to_owned(), false));
    }

    #[test]
    fn a_formula_far_down_a_chain_is_worked_out_before_what_reads_it() {
        // B1 reads the end of a chain of five thousand, and is met first: the chain is worked out under it
        let mut cells = vec!["1\t=A5000+A1|5001".to_owned()];
        cells.extend((1..5000).map(|i| format!("=A{i}+1|{}", i + 1)));
        let got = enter(&rows_of(&cells), 0, 0, 0, "1000").unwrap();
        let g = grid(&got.body);
        assert_eq!((g[0][1].as_str(), g[4999][0].as_str(), g[400][0].as_str(), g[401][0].as_str()), ("6999", "5999", "1400", "1401"));
        assert!((1..5000).all(|i| g[i][0] == (1000 + i).to_string()));
        assert_eq!((got.stale.len(), got.done.len()), (0, 5000));
        // a ring longer than formulas are followed into one another is Calc's error for a ring, in every cell of it
        let mut ring = vec!["1".to_owned()];
        ring.extend((1..200).map(|i| format!("=A{i}+1|{}", i + 1)));
        let got = enter(&rows_of(&ring), 0, 0, 0, "=A200+1").unwrap();
        let g = grid(&got.body);
        assert!((0..200).all(|i| g[i][0] == "Err:522"), "{:?}", &g[..3]);
        assert!(got.stale.is_empty());
    }

    #[test]
    fn a_running_total_of_twenty_thousand_rows_is_worked_out_once_through() {
        let mut cells = vec!["1\t=A1|1".to_owned()];
        cells.extend((2..=20_000).map(|i| format!("1\t=B{}+A{i}|{i}", i - 1)));
        // the first cell typed over, as `enter` does it, and then the working out alone: reading the
        // page and writing it are not what is timed here
        let src = sheet::put_cell(&rows_of(&cells), 0, 0, 0, &Typed::Number(5.0).into(), Care::Typed).unwrap();
        let book = sheet::book(&src).unwrap();
        let styles = Styles::read(&src, book.null_date);
        let t = std::time::Instant::now();
        let mut eng = Engine::new(&book, &styles);
        let results = eng.recalc(&[(0, 0, 0)], None);
        let took = t.elapsed();
        // every total changed, each to the right number, and none is left to be called stale
        let right = results.iter().filter(|((s, r, c), put)| *s == 0 && *c == 1 && put.v == Val::Num((*r + 5) as f64) && put.text == (*r + 5).to_string()).count();
        assert_eq!((results.len(), right, eng.stale.len(), eng.done.len()), (20_000, 20_000, 0, 20_000));
        assert!(took.as_secs() < 5, "{took:?}");
        // the same sheet with each total reading the one below it, so the first met is the deepest
        let mut cells: Vec<String> = (1..20_000).map(|i| format!("1\t=B{}+A{i}|{}", i + 1, 20_001 - i)).collect();
        cells.push("1\t=A20000|1".to_owned());
        let src = sheet::put_cell(&rows_of(&cells), 0, 19_999, 0, &Typed::Number(5.0).into(), Care::Result).unwrap();
        let book = sheet::book(&src).unwrap();
        let t = std::time::Instant::now();
        let mut eng = Engine::new(&book, &styles);
        // worked out from the top, as when every formula is asked for at once
        let all: Vec<Key> = (0..20_000).map(|r| (0, r, 1)).collect();
        let results = eng.recalc_with(&[(0, 19_999, 0)], &all.iter().copied().collect());
        let took = t.elapsed();
        let right = results.iter().filter(|((_, r, _), put)| put.v == Val::Num((20_004 - *r) as f64)).count();
        assert_eq!((results.len(), right, eng.stale.len()), (20_000, 20_000, 0));
        assert!(took.as_secs() < 5, "{took:?}");
    }

    #[test]
    fn rows_and_columns_put_in_work_out_again_what_depends_on_where_things_are() {
        let src = doc(&[&["1", "=COUNTBLANK(A1:A3)|0", "=ROWS(A1:A3)|3", "=ROW(A3)*100|300", "=B1+1|1"], &["2", "=ROW()|2", "=COLUMN()|3", "=COLUMNS(A1:C1)|3"], &["3", "=SUM(A2:A3)|5"]]);
        let got = shift(&src, 0, true, 1, 1).unwrap();
        let g = grid(&got.body);
        // the ranges grew by the new row, ROW(A3) is ROW(A4), and what reads a result follows it
        assert_eq!(g[0], ["1", "1", "4", "400", "2"]);
        assert_eq!(g[2], ["2", "3", "3", "3"]);
        assert!(got.stale.is_empty());
        // a sum of rows that only moved is not worked out again
        assert!(!got.done.contains(&(0, 3, 1)) && got.done.contains(&(0, 2, 1)), "{:?}", got.done);
        assert_eq!(sheet::formula_at(&got.body, 0, 3, 1).as_deref(), Some("of:=SUM([.A3:.A4])"));
        let got = shift(&src, 0, false, 0, 1).unwrap();
        let g = grid(&got.body);
        assert_eq!((g[1][2].as_str(), g[1][3].as_str(), g[1][4].as_str()), ("2", "4", "3"));
        let got = shift(&src, 0, false, 1, 1).unwrap();
        assert_eq!(grid(&got.body)[1][4], "4", "COLUMNS(A1:C1) is COLUMNS(A1:D1)");
    }

    #[test]
    fn what_a_function_reads_past_the_range_it_names_is_followed() {
        // SUMIF adds up B1:B3 from B1 alone, by the shape of A1:A3, and SUMIFS does the same
        let src = doc(&[&["1", "10", "=SUMIF(A1:A3,\">0\",B1)|60", "=SUMIFS(B1,A1:A3,\">0\")|60", "=AVERAGEIF(A1:A3,\">0\",B1)|20", "=COUNTIFS(A1:A3,\">0\",B1,\">10\")|2"], &["2", "20"], &["3", "30"]]);
        let got = enter(&src, 0, 1, 1, "5").unwrap();
        assert_eq!(grid(&got.body)[0], ["1", "10", "45", "45", "15", "1"]);
        assert_eq!(got.done.len(), 4);
        let got = enter(&src, 0, 2, 1, "60").unwrap();
        assert_eq!(grid(&got.body)[0], ["1", "10", "90", "90", "30", "2"]);
    }

    /// A page with a date cell shown month first, a cell of euros, and a time cell with AM and PM.
    const FORMATTED: &str = r#"<?xml version="1.0"?>
<office:document xmlns:calcext="urn:c">
 <office:automatic-styles>
  <number:date-style style:name="N1"><number:month number:style="long"/><number:text>/</number:text><number:day number:style="long"/><number:text>/</number:text><number:year/></number:date-style>
  <number:currency-style style:name="N2"><number:number number:decimal-places="0" number:min-integer-digits="1" number:grouping="true"/><number:text> </number:text><number:currency-symbol number:language="de" number:country="DE">€</number:currency-symbol></number:currency-style>
  <number:time-style style:name="N3"><number:hours/><number:text>:</number:text><number:minutes number:style="long"/><number:text> </number:text><number:am-pm/></number:time-style>
  <style:style style:name="ce1" style:family="table-cell" style:data-style-name="N1"/>
  <style:style style:name="ce2" style:family="table-cell" style:data-style-name="N2"/>
  <number:date-style style:name="N4"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>
  <number:date-style style:name="N5"><number:day-of-week/><number:text>, </number:text><number:day/><number:text> </number:text><number:month number:textual="true"/><number:text> </number:text><number:year number:style="long"/></number:date-style>
  <number:currency-style style:name="N6"><number:currency-symbol number:language="en" number:country="US">$</number:currency-symbol><number:number number:decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:currency-style>
  <style:style style:name="ce3" style:family="table-cell" style:data-style-name="N3"/>
  <style:style style:name="ce4" style:family="table-cell" style:data-style-name="N4"/>
  <style:style style:name="ce5" style:family="table-cell" style:data-style-name="N5"/>
  <style:style style:name="ce6" style:family="table-cell" style:data-style-name="N6"/>
 </office:automatic-styles>
 <office:body>
  <office:spreadsheet>
   <table:table table:name="One">
    <table:table-row>
     <table:table-cell table:style-name="ce1" office:value-type="date" office:date-value="2024-02-29" calcext:value-type="date"><text:p>02/29/24</text:p></table:table-cell>
     <table:table-cell table:style-name="ce2" office:value-type="currency" office:currency="EUR" office:value="5" calcext:value-type="currency"><text:p>5 €</text:p></table:table-cell>
     <table:table-cell table:style-name="ce3" office:value-type="time" office:time-value="PT09H15M00S" calcext:value-type="time"><text:p>9:15 AM</text:p></table:table-cell>
     <table:table-cell table:style-name="ce4" office:value-type="date" office:date-value="2026-11-21" calcext:value-type="date"><text:p>2026-11-21</text:p></table:table-cell>
     <table:table-cell table:style-name="ce5" office:value-type="date" office:date-value="2026-11-21" calcext:value-type="date"><text:p>Sat, 21 Nov 2026</text:p></table:table-cell>
     <table:table-cell table:style-name="ce6" office:value-type="currency" office:currency="USD" office:value="5" calcext:value-type="currency"><text:p>$5.00</text:p></table:table-cell>
    </table:table-row>
   </table:table>
  </office:spreadsheet>
 </office:body>
</office:document>
"#;

    #[test]
    fn what_a_cell_shows_typed_again_in_its_own_format_keeps_its_kind() {
        let cell = |body: &str, c: usize| sheet::book(body).unwrap().at(0, 0, c).map(|x| (x.vt.clone(), x.text.clone())).unwrap();
        // a date as the cell's pattern writes one, month first with two digits of the year
        let got = enter(FORMATTED, 0, 0, 0, "03/05/24").unwrap().body;
        assert_eq!(cell(&got, 0), ("date".to_owned(), "03/05/24".to_owned()));
        assert!(got.contains("office:value-type=\"date\" office:date-value=\"2024-03-05\""), "{got}");
        assert_eq!(cell(&enter(FORMATTED, 0, 0, 0, "3/5/98").unwrap().body, 0), ("date".to_owned(), "03/05/98".to_owned()));
        assert!(enter(FORMATTED, 0, 0, 0, "3/5/98").unwrap().body.contains("office:date-value=\"1998-03-05\""));
        // money with the cell's own symbol stays money in the cell's own currency
        let got = enter(FORMATTED, 0, 0, 1, "1,206 €").unwrap().body;
        assert_eq!(cell(&got, 1), ("currency".to_owned(), "1,206 €".to_owned()));
        assert!(got.contains("office:value-type=\"currency\" office:currency=\"EUR\" office:value=\"1206\""), "{got}");
        assert_eq!(cell(&enter(FORMATTED, 0, 0, 1, "-6 €").unwrap().body, 1), ("currency".to_owned(), "-6 €".to_owned()));
        // a time of day with its half of the day
        let got = enter(FORMATTED, 0, 0, 2, "1:30 pm").unwrap().body;
        assert_eq!(cell(&got, 2), ("time".to_owned(), "1:30 PM".to_owned()));
        assert!(got.contains("office:time-value=\"PT13H30M00S\""), "{got}");
        // what is not written the cell's way is the text it is: no such day, another symbol, a leading apostrophe
        for (c, typed) in [(0, "02/30/24"), (0, "13/01/24"), (0, "03/05"), (0, "03/05/24x"), (1, "6 $"), (1, "6€"), (2, "13:30 PM"), (0, "'03/05/24")] {
            assert_eq!(cell(&enter(FORMATTED, 0, 0, c, typed).unwrap().body, c).0, "string", "{typed}");
        }
        // a comma is a group separator only between groups of three: anything else is not the cell's format
        for (c, typed) in [(1, "5,00 €"), (1, "1,2,3 €"), (1, "12,06 €"), (1, ",206 €"), (1, "1,206, €"), (5, "$5,00"), (5, "$1,2,3.00")] {
            assert_eq!(cell(&enter(FORMATTED, 0, 0, c, typed).unwrap().body, c), ("string".to_owned(), typed.to_owned()), "{typed}");
        }
        assert_eq!(cell(&enter(FORMATTED, 0, 0, 1, "1,234,567 €").unwrap().body, 1), ("currency".to_owned(), "1,234,567 €".to_owned()));
        // a year written in full takes four digits, and a pattern of two takes two or four
        for typed in ["03-02-01", "3-02-01", "026-11-21", "20261-11-21"] {
            assert_eq!(cell(&enter(FORMATTED, 0, 0, 3, typed).unwrap().body, 3), ("string".to_owned(), typed.to_owned()), "{typed}");
        }
        assert!(enter(FORMATTED, 0, 0, 0, "03/05/2031").unwrap().body.contains("office:date-value=\"2031-03-05\""));
        assert_eq!(cell(&enter(FORMATTED, 0, 0, 0, "03/05/203").unwrap().body, 0).0, "string");
        // a day of the week in what is typed must be the date's own
        let got = enter(FORMATTED, 0, 0, 4, "Tue, 24 Nov 2026").unwrap().body;
        assert_eq!(cell(&got, 4), ("date".to_owned(), "Tue, 24 Nov 2026".to_owned()));
        assert!(got.contains("office:date-value=\"2026-11-24\""), "{got}");
        for typed in ["Mon, 21 Nov 2026", "Sun, 24 Nov 2026"] {
            assert_eq!(cell(&enter(FORMATTED, 0, 0, 4, typed).unwrap().body, 4), ("string".to_owned(), typed.to_owned()), "{typed}");
        }
        // a negative number is read with its sign before the symbol, as the format writes it, or at the number,
        // and is written the first way, as LibreOffice writes it
        for typed in ["$-5.00", "-$5.00", "$-1,234.50"] {
            let got = enter(FORMATTED, 0, 0, 5, typed).unwrap().body;
            let (vt, text) = cell(&got, 5);
            assert_eq!((vt.as_str(), text.starts_with("-$")), ("currency", true), "{typed}: {text}");
        }
        assert!(enter(FORMATTED, 0, 0, 5, "$-1,234.50").unwrap().body.contains("office:currency=\"USD\" office:value=\"-1234.5\""));
        assert_eq!(cell(&enter(FORMATTED, 0, 0, 5, "-$-5.00").unwrap().body, 5).0, "string");
        // money that writes what is owed in brackets: the brackets are not words round a 6, so it stays what was typed
        let owed = FORMATTED.replace("<number:currency-style style:name=\"N6\"><number:currency-symbol number:language=\"en\" number:country=\"US\">$</number:currency-symbol>", "<number:currency-style style:name=\"N6\"><number:text>(</number:text><number:currency-symbol number:language=\"en\" number:country=\"US\">$</number:currency-symbol>").replace("number:grouping=\"true\"/></number:currency-style>\n  <style:style style:name=\"ce3\"", "number:grouping=\"true\"/><number:text>)</number:text><style:map style:condition=\"value()&gt;=0\" style:apply-style-name=\"N6P0\"/></number:currency-style>\n  <style:style style:name=\"ce3\"");
        assert!(owed.contains("style:map"));
        for typed in ["($6.00)", "-($6.00)"] {
            assert_eq!(cell(&enter(&owed, 0, 0, 5, typed).unwrap().body, 5), ("string".to_owned(), typed.to_owned()));
        }
    }

    #[test]
    fn a_number_typed_into_a_cell_whose_format_has_a_form_for_negatives_shows_as_libreoffice_shows_it() {
        // a file LibreOffice wrote, one number format to a column. Its toolbar's money format, `[$$-409]#,##0.00;[RED]-[$$-409]#,##0.00`,
        // is written as a format for the negative numbers that hands the others on to a second format
        let src = include_str!("lo_formats.fods");
        let typed = |column: usize, text: &str| {
            let b = sheet::book(&enter(src, 0, 1, column, text).unwrap().body).unwrap();
            let c = b.at(0, 1, column).cloned().unwrap();
            (c.vt, c.text)
        };
        let money = |text: &str| ("currency".to_owned(), text.to_owned());
        let number = |text: &str| ("float".to_owned(), text.to_owned());
        // money with the negative in red, and money with it in brackets
        assert_eq!((typed(0, "7"), typed(0, "-7"), typed(0, "0")), (money("$7.00"), money("-$7.00"), money("$0.00")));
        assert_eq!((typed(1, "7"), typed(1, "-7"), typed(1, "1234.5")), (money("$7.00"), money("($7.00)"), money("$1,234.50")));
        // and what a formula there comes to
        assert_eq!((typed(0, "=3+4").1, typed(0, "=3-10").1, typed(1, "=3-10").1, typed(1, "=3+4").1), ("$7.00".to_owned(), "-$7.00".to_owned(), "($7.00)".to_owned(), "$7.00".to_owned()));
        // a number with the negative in red, one with it in brackets, and one with a form each for more, less and nought
        assert_eq!((typed(16, "7"), typed(16, "-7")), (number("7.00"), number("-7.00")));
        assert_eq!((typed(17, "7"), typed(17, "-7"), typed(17, "-1234.567")), (number("7"), number("(7)"), number("(1,235)")));
        assert_eq!((typed(18, "7"), typed(18, "-7"), typed(18, "0")), (number("7.0 up"), number("7.0 down"), number("zero")));
        // money with no form of its own for what is owed: the sign goes before the symbol
        assert_eq!((typed(2, "7"), typed(2, "-7")), (money("$7.00"), money("-$7.00")));
    }

    /// What a formula typed into A3 of a small sheet shows.
    fn shown(f: &str) -> String {
        let sheet = doc(&[&["46343", "2"]]);
        grid(&enter(&sheet, 0, 2, 0, f).unwrap().body).get(2).and_then(|r| r.first().cloned()).unwrap_or_default()
    }

    #[test]
    fn a_number_too_large_to_hold_is_an_error_and_not_a_nought() {
        let sheet = doc(&[&["46343", "2"]]);
        let v = shown;
        // more than a number can hold is an error, and is stored so that it reads back the same
        let big = enter(&sheet, 0, 2, 0, "=1e999").unwrap();
        assert_eq!(grid(&big.body)[2][0], "#NUM!");
        assert!(big.body.contains("table:formula=\"of:=1E999\"") && !big.body.contains("office:value=\"0\""), "{}", big.body);
        assert_eq!(v("=1e999*0+1"), "#NUM!");
    }

    #[test]
    fn a_count_of_places_to_round_to_is_a_whole_number_of_any_size() {
        let v = shown;
        // a count of places is cut to a whole number, and one past any number changes nothing
        assert_eq!((v("=ROUND(1.23456,2.9)"), v("=ROUND(1.5,400)"), v("=ROUND(1234.5,-2.9)"), v("=ROUND(15,-400)")), ("1.23".into(), "1.5".into(), "1200".into(), "0".into()));
    }

    #[test]
    fn a_weekday_counts_from_the_day_its_mode_names() {
        let v = shown;
        // the first day of the week by its number: 17 November 2026 is a Tuesday
        let days: Vec<String> = [11, 12, 13, 14, 15, 16, 17, 1, 2, 3].iter().map(|m| v(&format!("=WEEKDAY(A1,{m})"))).collect();
        assert_eq!(days, ["2", "1", "7", "6", "5", "4", "3", "3", "2", "1"]);
    }

    #[test]
    fn ifna_under_a_vendors_name_is_worked_out() {
        let sheet = doc(&[&["46343", "=IFNA(A1,0)|46343"]]);
        // IFNA under the name another program stores it by is worked out
        let stored = sheet.replacen("of:=IFNA(", "of:=COM.MICROSOFT.IFNA(", 1);
        assert_ne!(stored, sheet);
        let got = enter(&stored, 0, 0, 0, "7").unwrap();
        assert_eq!((grid(&got.body)[0][1].as_str(), got.stale.len()), ("7", 0));
    }

    #[test]
    fn a_date_past_any_calendar_is_an_error() {
        let v = shown;
        for f in ["=DATE(1E+300,1,1)", "=DATE(2026,1E+300,1)", "=DATE(2026,1,1E+300)", "=DATE(-1E+300,1,1)", "=YEAR(1E+300)", "=MONTH(-1E+300)", "=DAY(1E+18)", "=EDATE(1E+300,1)", "=EDATE(1,1E+300)", "=EOMONTH(-1E+300,1)"] {
            assert_eq!(v(f), "#NUM!", "{f}");
        }
        assert_eq!((v("=YEAR(DATE(9999,12,31))"), v("=WEEKDAY(1E+300)>0"), v("=COUNTBLANK(A:XFD)>0")), ("9999".into(), "TRUE".into(), "TRUE".into()));
    }

    #[test]
    fn a_stored_date_of_a_year_past_any_calendar_is_a_far_day() {
        let sheet = doc(&[&["1", "2"]]);
        // a date of a year past any calendar is read as a far day, not as a sum that wrapped
        let far = sheet.replacen("office:value-type=\"float\" office:value=\"1\"", "office:value-type=\"date\" office:date-value=\"999999999999999999-01-01\"", 1);
        assert_ne!(far, sheet);
        assert!(matches!(sheet::book(&far).unwrap().at(0, 0, 0).and_then(|c| c.v.clone()), Some(Val::Num(n)) if n > 1e12));
        assert!(enter(&far, 0, 2, 0, "=YEAR(A1)").is_ok() && enter(&far, 0, 0, 0, "3").is_ok());
    }

    #[test]
    fn a_count_of_repeats_past_any_number_does_not_wrap() {
        let sheet = doc(&[&["1", "2"]]);
        // rows and cells said to repeat more often than any count can hold
        for n in ["18446744073709551615", "9223372036854775807", "4294967295"] {
            let wide = sheet.replacen("<table:table-row>", &format!("<table:table-row table:number-rows-repeated=\"{n}\">"), 1).replacen("<table:table-cell office:value-type=\"float\" office:value=\"2\"", &format!("<table:table-cell table:number-columns-repeated=\"{n}\" office:value-type=\"float\" office:value=\"2\""), 1);
            assert!(wide.contains("rows-repeated") && wide.contains("columns-repeated"));
            let book = sheet::book(&wide).unwrap();
            assert_eq!((book.at(0, 5, 5).map(|c| c.text.clone()).as_deref(), book.style_at(0, 9, 9).as_str()), (Some("2"), "Default"));
            let _ = enter(&wide, 0, 3, 3, "=SUM(A1:C3)+COUNTA(A:A)");
            let _ = enter(&wide, 0, 0, 0, "7");
            let _ = shift(&wide, 0, true, 1, 1);
            let _ = shift(&wide, 0, false, 1, -1);
            let _ = crate::shift::blocked(&wide, 0, true, 0, 1);
        }
    }

    #[test]
    fn a_number_no_date_stands_for_in_a_date_cell_is_kept_as_the_number() {
        // typed or worked out
        for typed in ["-1e30", "=(-1e30)", "=1E+30"] {
            let got = enter(FORMATTED, 0, 0, 0, typed).unwrap().body;
            let n = if typed.contains('-') { "-1E30" } else { "1E30" };
            assert!(got.contains(&format!("office:value-type=\"float\" office:value=\"{n}\"")), "{typed}: {got}");
            assert_eq!(sheet::book(&got).unwrap().at(0, 0, 0).map(|c| c.vt.clone()).as_deref(), Some("float"), "{typed}");
            assert_eq!(sheet::book(&got).unwrap().at(0, 0, 0).map(|c| c.text.clone()).as_deref(), Some(if typed.contains('-') { "-1E+030" } else { "1E+030" }));
        }
        // and in a time cell, which has no day to be wrong about
        assert!(enter(FORMATTED, 0, 0, 2, "=1E+300").is_ok() && enter(FORMATTED, 0, 0, 2, "=(-1E+300)").is_ok());
    }

    #[test]
    fn what_reads_a_stale_cell_is_stale_too_and_keeps_what_it_had() {
        // C1 is an array formula. D1 and E1 read it, F1 reads D1, and G1 reads only A1
        let plain = doc(&[&["1", "1", "=SUM(A1:A3*B1:B3)|14", "=C1+1|15", "=SUM(C1:C3)|14", "=D1*2|30", "=A1+1|2"], &["2", "2"], &["3", "3"]]);
        let src = plain.replacen("table:formula=\"of:=SUM(", "table:number-matrix-columns-spanned=\"1\" table:number-matrix-rows-spanned=\"1\" table:formula=\"of:=SUM(", 1);
        assert_ne!(src, plain);
        let got = enter(&src, 0, 0, 0, "10").unwrap();
        assert_eq!(grid(&got.body)[0], ["10", "1", "14", "15", "14", "30", "11"]);
        assert_eq!((got.stale, got.done), (vec![(0, 0, 2), (0, 0, 3), (0, 0, 4), (0, 0, 5)], vec![(0, 0, 6)]));
        // an array formula whose results spread over C1:C3: the cells under it are stale with it, and so is what reads them
        let plain = doc(&[&["1", "1", "=A1:A3*B1:B3|1", "=C2+1|5", "=SUM(C1:C3)|14", "=C3|9", "=D1+E1|19"], &["2", "2", "4"], &["3", "3", "9"]]);
        let src = plain.replacen("table:formula=\"of:=[.A1:.A3]", "table:number-matrix-columns-spanned=\"1\" table:number-matrix-rows-spanned=\"3\" table:formula=\"of:=[.A1:.A3]", 1);
        assert_ne!(src, plain);
        let got = enter(&src, 0, 1, 0, "10").unwrap();
        let g = grid(&got.body);
        assert_eq!((g[0].clone(), g[1][2].as_str(), g[2][2].as_str()), (vec!["1".to_owned(), "1".into(), "1".into(), "5".into(), "14".into(), "9".into(), "19".into()], "4", "9"));
        assert_eq!((got.stale, got.done), (vec![(0, 0, 2), (0, 0, 3), (0, 0, 4), (0, 0, 5), (0, 0, 6), (0, 1, 2), (0, 2, 2)], vec![]));
        // a formula left stale by an earlier change: told of it, what reads it is not worked out from its old value
        let src = doc(&[&["2", "=NOPE(A1:A1)+3|5", "=B1+D1|6", "1", "=D1*2|2"]]);
        let blind = enter(&src, 0, 0, 3, "2").unwrap();
        assert_eq!((grid(&blind.body)[0][2].as_str(), blind.stale.len()), ("7", 0));
        let got = enter_knowing(&src, 0, 0, 3, "2", &[(0, 0, 1)]).unwrap();
        assert_eq!((grid(&got.body)[0].clone(), got.stale, got.done), (vec!["2".to_owned(), "5".into(), "6".into(), "2".into(), "4".into()], vec![(0, 0, 2)], vec![(0, 0, 4)]));
        // typed over, the stale formula is a value, and what reads it is worked out
        let got = enter_knowing(&src, 0, 0, 1, "8", &[(0, 0, 1)]).unwrap();
        assert_eq!((grid(&got.body)[0][2].as_str(), got.stale.len(), got.done), ("9", 0, vec![(0, 0, 2), (0, 0, 1)]));
    }

    #[test]
    fn nothing_is_put_in_taken_out_or_typed_through_the_cells_an_array_formula_spreads_over() {
        let array = |src: String, from: &str, rows: usize, cols: usize| {
            let out = src.replacen(&format!("table:formula=\"of:={from}"), &format!("table:number-matrix-columns-spanned=\"{cols}\" table:number-matrix-rows-spanned=\"{rows}\" table:formula=\"of:={from}"), 1);
            assert_ne!(out, src);
            out
        };
        const WHY: &str = "that would cut through an array formula";
        // B2 is an array formula over B2:B3, with a cell above it, below it and beside it
        let tall = array(doc(&[&["0", "top"], &["1", "=A2:A3*3|3", "x"], &["2", "6", "y"], &["5", "keep", "z"]]), "[.A2:.A3]", 2, 1);
        // a row put in between its two cells, or a row of its two taken out and not the other
        for (at, n) in [(2, 1), (2, 3), (2, -1), (1, -1), (2, -2), (0, -2)] {
            assert_eq!(shift(&tall, 0, true, at, n).map(|e| e.body).unwrap_err(), WHY, "rows at {at}: {n}");
        }
        // above it, below it, and with the whole of it: those are no cut
        for (at, n) in [(0, 1), (1, 1), (3, 1), (4, 2), (0, -1), (3, -1), (1, -2), (1, -3), (0, -4)] {
            assert!(shift(&tall, 0, true, at, n).is_ok(), "rows at {at}: {n}");
        }
        // columns do not cut one that is a single column wide, wherever they go
        for (at, n) in [(0, 1), (1, 1), (2, 1), (1, -1), (0, -2), (2, -1)] {
            assert!(shift(&tall, 0, false, at, n).is_ok(), "columns at {at}: {n}");
        }
        // what is below it moves and it stays whole
        let down = shift(&tall, 0, true, 1, 1).unwrap().body;
        assert_eq!(grid(&down), [vec!["0", "top"], vec![], vec!["1", "3", "x"], vec!["2", "6", "y"], vec!["5", "keep", "z"]]);
        assert_eq!(sheet::book(&down).unwrap().at(0, 2, 1).map(|c| (c.array, c.spill)), Some((true, (2, 1))));
        // B2 over B2:C2, the same with columns
        let wide = array(doc(&[&["0", "1", "2", "5"], &["top", "=B1:C1*3|3", "6", "keep"], &["", "x", "y", "z"]]), "[.B1:.C1]", 1, 2);
        for (at, n) in [(2, 1), (2, 3), (2, -1), (1, -1), (2, -2), (0, -2)] {
            assert_eq!(shift(&wide, 0, false, at, n).map(|e| e.body).unwrap_err(), WHY, "columns at {at}: {n}");
        }
        for (at, n) in [(0, 1), (1, 1), (3, 1), (0, -1), (3, -1), (1, -2), (1, -3)] {
            assert!(shift(&wide, 0, false, at, n).is_ok(), "columns at {at}: {n}");
        }
        for (at, n) in [(0, 1), (1, 1), (2, 1), (1, -1), (0, -2)] {
            assert!(shift(&wide, 0, true, at, n).is_ok(), "rows at {at}: {n}");
        }
        // an array on another sheet is not in the way, and a merged cell still says it is one
        let merged = tall.replace("table:number-matrix-columns-spanned=\"1\" table:number-matrix-rows-spanned=\"2\"", "table:number-columns-spanned=\"1\" table:number-rows-spanned=\"2\"");
        assert_eq!(shift(&merged, 0, true, 2, 1).map(|e| e.body).unwrap_err(), "that would cut through a merged cell");
        // typing into a cell it spreads over is refused, a value or a formula, and the page is as it was
        for typed in ["99", "text", "=A1+1", ""] {
            assert_eq!(enter(&tall, 0, 2, 1, typed).map(|e| e.body).unwrap_err(), "that cell is part of an array formula", "{typed:?}");
            assert_eq!(enter(&wide, 0, 1, 2, typed).map(|e| e.body).unwrap_err(), "that cell is part of an array formula", "{typed:?}");
        }
        assert_eq!(sheet::set_cell(&tall, 0, 2, 1, "99").unwrap_err(), "that cell is part of an array formula");
        // the cells round it, and its own first cell, are typed into as any cell is
        for (r, c) in [(0, 1), (3, 1), (1, 0), (2, 0), (1, 2), (2, 2), (1, 1), (4, 1), (2, 5)] {
            assert!(enter(&tall, 0, r, c, "7").is_ok(), "row {r} column {c}");
        }
        // typed over, the array spreads no more, and the cell that was under it can be typed into
        let over = enter(&tall, 0, 1, 1, "7").unwrap().body;
        assert_eq!(grid(&enter(&over, 0, 2, 1, "99").unwrap().body)[2][1], "99");
    }

    /// A page of a few kilobytes that says it is full: one row said 1,048,576 times, of one number said 16,384 times, and a second sheet of `n` cells with one formula each.
    fn full(n: usize, formula: &str) -> String {
        let cell = format!("<table:table-cell table:formula=\"of:={}\" office:value-type=\"float\" office:value=\"0\" calcext:value-type=\"float\"><text:p>0</text:p></table:table-cell>", formula.replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;"));
        format!("<?xml version=\"1.0\"?>\n<office:document xmlns:calcext=\"urn:c\">\n <office:body>\n  <office:spreadsheet>\n   <table:table table:name=\"One\"><table:table-row table:number-rows-repeated=\"1048576\"><table:table-cell table:number-columns-repeated=\"16384\" office:value-type=\"float\" office:value=\"1\" calcext:value-type=\"float\"><text:p>1</text:p></table:table-cell></table:table-row></table:table>\n   <table:table table:name=\"Two\"><table:table-row>{}</table:table-row></table:table>\n  </office:spreadsheet>\n </office:body>\n</office:document>\n", cell.repeat(n))
    }

    #[test]
    fn one_change_walks_no_more_than_a_set_number_of_cells_however_many_formulas_it_reaches() {
        // each of these reads far more cells than a formula may walk. The work is counted in cells read, by every
        // formula together, and what the count does not reach is left stale and keeps what it had
        for formula in [
            "SUM([$One.A1:.XFD1048576])",
            "COUNTIF([$One.A1:.XFD1048576];\">0\")",
            "SUMIFS([$One.A1:.A1048576];[$One.B1:.B1048576];\">0\";[$One.C1:.C1048576];1)",
            "SUMPRODUCT([$One.A1:.A200000]*[$One.A1:.A200000]*[$One.A1:.A200000]*[$One.A1:.A200000]*[$One.A1:.A200000]*[$One.A1:.A200000]*[$One.A1:.A200000]*[$One.A1:.A200000])",
            "SUMPRODUCT([$One.A1:.XFD1048576];[$One.A1:.XFD1048576])",
            "VLOOKUP(-1;[$One.A1:.B1048576];2;0)",
            "MATCH(-1;[$One.A1:.A1048576];0)",
            "TEXTJOIN(\"\";1;[$One.A1:.XFD1048576])",
            "AVERAGE([$One.A1:.XFD1048576])+COUNT([$One.A1:.XFD1048576])",
        ] {
            for (n, most) in [(20, 300_000), (80, 300_000), (320, 300_000), (80, 1), (80, 0)] {
                let page = sheet::put_cell(&full(n, formula), 0, 0, 0, &Typed::Number(2.0).into(), Care::Typed).unwrap();
                let book = sheet::book(&page).unwrap();
                let styles = Styles::read(&page, book.null_date);
                let mut eng = Engine::new(&book, &styles);
                eng.walk_all = most;
                assert_eq!(eng.formulas.len(), n, "{formula}");
                eng.recalc(&[(0, 0, 0)], None);
                // every formula is either worked out or said to be stale, and no more is read than the bound, with one cell
                // more for the reading that passed it and one for each formula left
                assert_eq!(eng.done.len() + eng.stale.len(), n, "{formula}");
                assert!(eng.walked <= most + 1 + n, "{n} of {formula} with {most} allowed: {} cells read", eng.walked);
                // and a formula that was not worked out keeps what it had, and is not written
                assert!(eng.stale.len() >= n - 1 || most > 1, "{formula}");
            }
        }
        // with the bound as it is set: a formula may read five million cells, and a change a hundred million (the
        // formulas that go past their own five are what is left stale)
        let page = sheet::put_cell(&full(3, "SUM([$One.A1:.XFD1048576])"), 0, 0, 0, &Typed::Number(2.0).into(), Care::Typed).unwrap();
        let book = sheet::book(&page).unwrap();
        let styles = Styles::read(&page, book.null_date);
        let mut eng = Engine::new(&book, &styles);
        let changed = eng.recalc(&[(0, 0, 0)], None);
        assert!(eng.walked <= WALK_ALL + 21 && eng.walked > WALK_ONE, "{} cells read", eng.walked);
        assert_eq!((eng.stale.len(), eng.done.len(), changed.len()), (3, 0, 0));
        // a sheet of many light formulas is worked out whole
        let light = doc(&[&["1"; 1], &["=A1+1|2"; 200]]);
        let book = sheet::book(&light).unwrap();
        let styles = Styles::read(&light, book.null_date);
        let mut eng = Engine::new(&book, &styles);
        eng.recalc(&[(0, 0, 0)], None);
        assert_eq!((eng.done.len(), eng.stale.len()), (200, 0));
    }

    #[test]
    fn a_formula_left_for_want_of_cells_to_read_is_not_saved_with_the_value_it_had() {
        // two formulas that each read more than a formula may: they keep nothing that passes for what they work out to
        let got = enter(&full(2, "SUM([$One.A1:.XFD1048576])"), 0, 0, 0, "2").unwrap();
        assert_eq!((got.stale.len(), got.done.len()), (2, 0));
        let book = sheet::book(&got.body).unwrap();
        for c in 0..2 {
            let cell = book.at(1, 0, c).unwrap();
            assert!(cell.f.is_some() && cell.vt.is_empty(), "{cell:?}");
        }
        // one that was left stale for a function not known here keeps its value, as it does in the web client
        let got = enter(&doc(&[&["2", "=NOPE(A1:A1)+3|5"]]), 0, 0, 0, "100").unwrap();
        assert_eq!((grid(&got.body)[0][1].as_str(), got.stale), ("5", vec![(0, 0, 1)]));
    }

    #[test]
    fn an_ordinary_sheet_of_five_thousand_rows_is_worked_out_whole() {
        // a share of the total down 4,600 rows reads the whole column in every row: 21 million cells, which a
        // bound of 20 million once left stale, and saved with the numbers it had before
        let rows = 4_600;
        let cells: String = (1..=rows).map(|i| format!("<table:table-row><table:table-cell office:value-type=\"float\" office:value=\"{i}\"><text:p>{i}</text:p></table:table-cell><table:table-cell table:formula=\"of:=[.A{i}]/SUM([.A$1:.A${rows}])\" office:value-type=\"float\" office:value=\"0\"><text:p>0</text:p></table:table-cell></table:table-row>")).collect();
        let src = format!("<?xml version=\"1.0\"?>\n<office:document xmlns:calcext=\"urn:c\">\n <office:body>\n  <office:spreadsheet>\n   <table:table table:name=\"One\">{cells}</table:table>\n  </office:spreadsheet>\n </office:body>\n</office:document>\n");
        let got = enter(&src, 0, 0, 0, "100").unwrap();
        assert_eq!((got.stale.len(), got.done.len()), (0, rows));
        // the shares come to the whole
        let total: f64 = grid(&got.body).iter().map(|r| r[1].parse::<f64>().unwrap()).sum();
        assert!((total - 1.0).abs() < 1e-3, "{total}");
    }

    #[test]
    fn rows_put_in_do_not_forget_what_was_stale_and_an_array_typed_over_frees_its_cells() {
        let array = |src: String, from: &str, rows: usize| {
            let out = src.replacen(&format!("table:formula=\"of:={from}"), &format!("table:number-matrix-columns-spanned=\"1\" table:number-matrix-rows-spanned=\"{rows}\" table:formula=\"of:={from}"), 1);
            assert_ne!(out, src);
            out
        };
        // B1 is an array formula, C1 reads it and A2
        let src = array(doc(&[&["1", "=A1*10|10", "=B1+A2|10"], &["0"]]), "[.A1]", 1);
        let got = enter(&src, 0, 0, 0, "5").unwrap();
        assert_eq!(got.stale, [(0, 0, 1), (0, 0, 2)]);
        // a row far below, a column to the right: nothing moved, nothing forgotten
        for (rows, at) in [(true, 10), (false, 7)] {
            let put = shift_knowing(&got.body, 0, rows, at, 1, &got.stale).unwrap();
            assert_eq!(put.stale, got.stale);
        }
        // a row above: the stale cells are where they moved to, and what reads one is not worked out from its old value
        let put = shift_knowing(&got.body, 0, true, 0, 1, &got.stale).unwrap();
        assert_eq!(put.stale, [(0, 1, 1), (0, 1, 2)]);
        let next = enter_knowing(&put.body, 0, 2, 0, "1", &put.stale).unwrap();
        assert_eq!((grid(&next.body)[1][2].as_str(), next.stale.contains(&(0, 1, 2)), next.done.contains(&(0, 1, 2))), ("10", true, false));
        // a column before them
        assert_eq!(shift_knowing(&got.body, 0, false, 1, 2, &got.stale).unwrap().stale, [(0, 0, 3), (0, 0, 4)]);
        // rows taken out work everything out again
        assert_eq!(shift_knowing(&got.body, 0, true, 5, -1, &got.stale).unwrap().stale, [(0, 0, 1), (0, 0, 2)]);

        // A3 is an array formula over A3:A4, and B1 reads A4
        let src = array(doc(&[&["1", "=A4+C1|6"], &["2"], &["=A1:A2*3|3"], &["6"]]), "[.A1:.A2]", 2);
        let got = enter(&src, 0, 0, 0, "4").unwrap();
        assert_eq!(got.stale, [(0, 0, 1), (0, 2, 0), (0, 3, 0)]);
        // typed over, it spreads no more: A4 is the 6 it held, and B1 is worked out from it
        let over = enter_knowing(&got.body, 0, 2, 0, "12", &got.stale).unwrap();
        let mut left: Vec<Key> = got.stale.iter().copied().filter(|k| !over.done.contains(k)).chain(over.stale.iter().copied()).collect();
        left.sort_unstable();
        assert_eq!(left, []);
        let last = enter_knowing(&over.body, 0, 0, 2, "200", &left).unwrap();
        assert_eq!((grid(&last.body)[0][1].as_str(), last.stale.len()), ("206", 0));
    }

    #[test]
    fn a_criterion_given_as_a_range_inside_sumproduct_is_not_guessed_at() {
        let src = doc(&[&["1", "3", "10"], &["2", "1", "20"], &["3", "2", "30"]]);
        let v = |f: &str| {
            let got = enter(&src, 0, 4, 0, f).unwrap();
            (grid(&got.body).get(4).and_then(|r| r.first().cloned()).unwrap_or_default(), got.stale.contains(&(0, 4, 0)))
        };
        // each would need the test made once for every cell of the criterion: 6, 60 and 3 in Calc
        for f in ["=SUMPRODUCT(A1:A3*COUNTIF(B1:B3,A1:A3))", "=SUMPRODUCT(SUMIF(B1:B3,A1:A3,C1:C3))", "=SUMPRODUCT(1/COUNTIF(A1:A3,A1:A3))", "=SUMPRODUCT(A1:A3*MATCH(A1:A3,B1:B3,0))", "=SUMPRODUCT(A1:A3*LARGE(C1:C3,A1:A3))"] {
            assert_eq!(v(f), (String::new(), true), "{f}");
        }
        // a criterion that is one value is one test, and the range is taken whole
        assert_eq!(v("=SUMPRODUCT(A1:A3*COUNTIF(B1:B3,\">1\"))"), ("12".to_owned(), false));
        assert_eq!(v("=SUMPRODUCT(A1:A3*SUMIF(B1:B3,A1,C1:C3))"), ("120".to_owned(), false));
    }

    #[test]
    fn two_numbers_a_hair_apart_through_binary_arithmetic_are_one_number_as_in_calc() {
        let v = shown;
        // the web client compares them exactly: 0.1+0.2=0.3 is false there. A sum is still exact here
        assert_eq!((v("=0.1*3>0.3"), v("=1e16-9999999999999998"), v("=0.1+0.2=0.3"), v("=0.1+0.2-0.3")), ("FALSE".into(), "2".into(), "TRUE".into(), "5.55111512312578E-017".into()));
        for (a, b, same) in [(0.1 + 0.2, 0.3, true), (1.0, 1.000000000000001, true), (1.0, 1.0000000000001, false), (0.0, 1e-300, false), (0.0, 0.0, true), (1e300, 1.0000000000000002e300, true), (5.0, 6.0, false), (1e15, 1e15 + 1.0, false), (-0.3, -(0.1 + 0.2), true), (0.3, -0.3, false), (f64::NAN, f64::NAN, false), (f64::INFINITY, f64::INFINITY, true), (f64::INFINITY, 1e308, false)] {
            assert_eq!((approx_eq(a, b), approx_eq(b, a)), (same, same), "{a} {b}");
        }
        for (x, want) in [(28.999999999999996, 29.0), (-28.999999999999996, -29.0), (2.5, 2.0), (-2.5, -3.0), (0.9999999999999999, 1.0), (-1e-16, -1.0), (1e15 + 0.5, 1e15), (0.0, 0.0), (-0.0, 0.0), (7.0, 7.0), (1e300, 1e300)] {
            assert_eq!(approx_floor(x), want, "{x}");
        }
    }

    #[test]
    fn every_answer_held_against_the_web_clients_is_of_a_formula_its_corpora_have() {
        let all = [include_str!("funcs_corpus.tsv"), include_str!("funcs_text_corpus.tsv"), include_str!("funcs_date_corpus.tsv"), include_str!("funcs_lookup_corpus.tsv"), include_str!("calc_corpus.tsv")].concat();
        for (f, lo) in LIBREOFFICE {
            let line = all.lines().find(|l| l.split_once('\t').is_some_and(|(g, _)| serde_json::from_str::<String>(g).is_ok_and(|g| g == f)));
            let web: Option<String> = line.and_then(|l| serde_json::from_str(l.split_once('\t')?.1).ok());
            assert!(web.as_deref().is_some_and(|w| w != lo), "{f}: the corpora have {web:?}");
        }
    }

    #[test]
    fn formulas_give_what_libreoffice_gives() {
        // Each line is a formula and what LibreOffice shows for it, worked out by LibreOffice itself from a page
        // with no results in it, over a small sheet of numbers, texts, a truth, a date, a time, a percentage and
        // money, with `*` and `?` standing for other characters as they do for COUNTIF here
        let src = include_str!("lo_funcs_sheet.fods");
        let (mut n, mut wrong) = (0, Vec::new());
        for line in include_str!("lo_funcs_corpus.tsv").lines() {
            let (f, want) = line.split_once('\t').unwrap();
            let (f, want): (String, String) = (serde_json::from_str(f).unwrap(), serde_json::from_str(want).unwrap());
            let got = enter(src, 0, 20, 4, &format!("={f}")).unwrap();
            let shown = if got.stale.contains(&(0, 20, 4)) { "STALE".to_owned() } else { sheet::book(&got.body).unwrap().at(0, 20, 4).map_or(String::new(), |c| c.text.clone()) };
            if shown != want {
                wrong.push(format!("={f} gave {shown}, LibreOffice gives {want}"));
            }
            n += 1;
        }
        assert!(wrong.is_empty(), "{} of {n} differ:\n{}", wrong.len(), wrong.join("\n"));
        assert_eq!(n, 372);
    }

    #[test]
    fn what_cannot_be_worked_out_keeps_what_it_had_and_is_counted() {
        // a function not known here: its cached 5 stays. What reads it cannot be worked out either,
        // so it keeps its 10, is counted with it, and is not among the done
        let src = doc(&[&["2", "=NOPE(A1:A1)+3|5", "=B1*2|10", "=C1+A1|12", "=A1*3|6"]]);
        let got = enter(&src, 0, 0, 0, "100").unwrap();
        assert_eq!((grid(&got.body)[0].clone(), got.stale, got.done), (vec!["100".to_owned(), "5".into(), "10".into(), "12".into(), "300".into()], vec![(0, 0, 1), (0, 0, 2), (0, 0, 3)], vec![(0, 0, 4)]));
        // a branch not taken is not read, so a stale cell in it spoils nothing
        let pick = doc(&[&["2", "=NOPE(A1:A1)|5", "=IF(A1>50,A1,B1)|5"]]);
        let got = enter(&pick, 0, 0, 0, "100").unwrap();
        assert_eq!((grid(&got.body)[0][2].as_str(), got.stale, got.done), ("100", vec![(0, 0, 1)], vec![(0, 0, 2)]));
        // a cycle is Calc's own error for one, in every cell of it
        let ring = doc(&[&["1", "=A1+1|2"]]);
        let got = enter(&ring, 0, 0, 0, "=B1+1").unwrap();
        assert_eq!(grid(&got.body)[0], ["Err:522", "Err:522"]);
        // a long chain is worked out without running out of stack
        let chain: Vec<String> = std::iter::once("1".to_owned()).chain((1..3000).map(|i| format!("=A{i}+1|{}", i + 1))).collect();
        let rows: Vec<Vec<&str>> = chain.iter().map(|c| vec![c.as_str()]).collect();
        let rows: Vec<&[&str]> = rows.iter().map(Vec::as_slice).collect();
        let got = enter(&doc(&rows), 0, 0, 0, "10").unwrap();
        assert_eq!((grid(&got.body)[2999][0].as_str(), got.stale.len(), got.done.len()), ("3009", 0, 2999));
    }
}
