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

use std::collections::{HashMap, HashSet};
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
}

fn err(code: &str) -> V {
    V::Err(code.to_owned())
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
    /// Those worked out.
    done: Vec<Key>,
    depth: usize,
}

impl<'a> Engine<'a> {
    pub fn new(book: &'a Book, styles: &'a Styles) -> Engine<'a> {
        let mut e = Engine { book, styles, over: HashMap::new(), formulas: Vec::new(), pending: HashMap::new(), busy: HashSet::new(), stale: HashSet::new(), changed: Vec::new(), extents: HashMap::new(), steps: 0, done: Vec::new(), depth: 0 };
        for (s, sh) in book.sheets.iter().enumerate() {
            let mut r = 0;
            for row in &sh.rows {
                if row.cells.iter().any(|c| c.f.is_some()) {
                    // a run of the same formula a million rows long is not followed all the way down
                    for i in 0..row.rep.min(2048) {
                        let mut c = 0;
                        for cell in &row.cells {
                            if let Some(f) = &cell.f {
                                for j in 0..cell.rep.min(256) {
                                    let entry = e.entry((s, r + i, c + j), f);
                                    e.formulas.push(entry);
                                }
                            }
                            c += cell.rep;
                        }
                    }
                }
                r += row.rep;
            }
        }
        e
    }

    fn entry(&self, at: Key, f: &str) -> Entry {
        let ast = formula::body_of(f).and_then(|b| formula::parse(b, Mode::Of).ok()).map(Rc::new);
        let (mut deps, mut wild) = (Vec::new(), false);
        if let Some(ast) = &ast {
            self.deps_of(ast, at.0, &mut deps, &mut wild);
        }
        Entry { at, f: f.to_owned(), ast, deps, wild }
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
            Node::Call(_, args) => args.iter().for_each(|a| self.deps_of(a, home, out, wild)),
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
            Some(p) => Some(MCell { rep: 1, vt: p.vt.clone(), v: (!p.vt.is_empty()).then(|| p.v.clone()), f: p.f.clone(), text: p.text.clone(), err: p.err, st: None }),
            None => self.book.at(at.0, at.1, at.2).cloned(),
        }
    }

    /// The value at a cell, worked out first when it is waiting to be.
    pub fn value(&mut self, at: Key) -> V {
        match self.pending.get(&at).copied() {
            Some(i) => self.compute(i),
            None if at.0 < self.book.sheets.len() => cell_value(self.stored(at).as_ref()),
            None => err("#REF!"),
        }
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
        let (mut rows, mut cols, mut at) = (0, 0, 0);
        for row in self.book.sheets.get(s).map_or(&[][..], |sh| &sh.rows) {
            let (mut c, mut last) = (0, 0);
            for cell in &row.cells {
                if !cell.vt.is_empty() || cell.f.is_some() || !cell.text.is_empty() {
                    last = c + cell.rep;
                }
                c += cell.rep;
            }
            if last > 0 {
                // a repeated row with content is real data only when the run is short
                rows = at + row.rep.min(4096);
                cols = cols.max(last);
            }
            at += row.rep;
        }
        let u = (rows, cols.min(16_384));
        self.extents.insert(s, u);
        u
    }

    /// Calls `f` with the value of every cell of the rectangle that holds something, in row order.
    pub fn each(&mut self, g: Rg, f: &mut dyn FnMut(V)) -> Result<(), Unsupported> {
        let book = self.book;
        let Some(sheet) = book.sheets.get(g.s) else { return Ok(()) };
        let mut r = 0;
        for row in &sheet.rows {
            let (top, bot) = (r, r + row.rep - 1);
            r += row.rep;
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
                let mut c = 0;
                for cell in &row.cells {
                    let (left, right) = (c, c + cell.rep - 1);
                    c += cell.rep;
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
                        self.steps += 1;
                        if self.steps > 5_000_000 {
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
            Node::Num(v) => V::Num(*v),
            Node::Str(v) => V::Str(v.clone()),
            Node::Bool(v) => V::Bool(*v),
            Node::Err(v) => err(v),
            Node::Missing => V::Missing,
            Node::Ref(r) => self.range(r, ctx.s)?,
            Node::Paren(x) => self.ev(x, ctx)?,
            Node::Un(op, x) => {
                let v = self.ev(x, ctx)?;
                match to_num(&self.one(v, ctx)) {
                    V::Num(v) => V::Num(if *op == '-' { -v } else { v }),
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
        // the budget of cells walked is one outermost formula's, with whatever it pulls in
        if self.busy.is_empty() {
            self.steps = 0;
        }
        self.busy.insert(at);
        self.depth += 1;
        // too deep a chain of formulas is left as it was, and to LibreOffice
        let got = match self.formulas[i].ast.clone() {
            Some(ast) if self.depth <= 400 => self.evaluate(&ast, at),
            _ => Err(Unsupported),
        };
        self.depth -= 1;
        self.busy.remove(&at);
        self.pending.remove(&at);
        match got {
            Err(Unsupported) => {
                self.stale.insert(at);
                cell_value(self.stored(at).as_ref())
            }
            Ok(v) => {
                self.stale.remove(&at);
                self.done.push(at);
                let f = self.formulas[i].f.clone();
                self.store(at, f, v.clone());
                v
            }
        }
    }

    /// Keeps a result for a cell: the type, the value and the text it shows. A numeric
    /// result keeps the cell's numeric type (percentage, money, date, time), since that is its format's.
    fn store(&mut self, at: Key, f: String, v: V) {
        let was = self.stored(at).unwrap_or_default();
        let blank = matches!(v, V::Blank | V::Missing);
        let v = if blank { V::Num(0.0) } else { v };
        let plain_number = !was.vt.is_empty() && was.vt != "boolean" && was.vt != "string";
        let mut val = match &v {
            V::Err(code) => Put { f: Some(f.clone()), vt: "string".into(), v: Val::Str(code.clone()), text: code.clone(), err: true },
            V::Str(t) => Put { f: Some(f.clone()), vt: "string".into(), v: Val::Str(t.clone()), text: t.clone(), err: false },
            V::Bool(b) if !plain_number => Put { f: Some(f.clone()), vt: "boolean".into(), v: Val::Bool(*b), text: if *b { "TRUE" } else { "FALSE" }.into(), err: false },
            other => {
                // a logical result in a cell Calc keeps as a plain number stays one
                let n = match other {
                    V::Bool(b) => f64::from(*b),
                    V::Num(n) => *n,
                    _ => 0.0,
                };
                let keep = matches!(was.vt.as_str(), "percentage" | "currency" | "date" | "time");
                Put { f: Some(f.clone()), vt: if keep { was.vt.clone() } else { "float".into() }, v: Val::Num(n), text: String::new(), err: false }
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
        self.changed.clear();
        let mut hit: Vec<usize> = self.formulas.iter().enumerate().filter(|(_, e)| Some(e.at) == also).map(|(i, _)| i).collect();
        let mut seen: HashSet<Key> = hit.iter().map(|i| self.formulas[*i].at).collect();
        let mut front: Vec<Key> = edited.to_vec();
        let mut guard = 0;
        while !front.is_empty() && guard < 10_000 {
            guard += 1;
            let mut next = Vec::new();
            for (i, e) in self.formulas.iter().enumerate() {
                if seen.contains(&e.at) {
                    continue;
                }
                let reads = e.wild || e.deps.iter().any(|d| front.iter().any(|(s, r, c)| *s == d[0] && (d[1]..=d[3]).contains(r) && (d[2]..=d[4]).contains(c)));
                if reads {
                    seen.insert(e.at);
                    hit.push(i);
                    next.push(e.at);
                }
            }
            front = next;
        }
        self.pending = hit.iter().map(|i| (self.formulas[*i].at, *i)).collect();
        for i in hit {
            if self.pending.contains_key(&self.formulas[i].at) {
                self.compute(i);
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
    let formula = typed.len() > 1 && typed.starts_with('=');
    let styles = Styles::read(src, sheet::book(src)?.null_date);
    let mut body = if formula {
        let f = formula::to_of(typed).map_err(|e| format!("that formula cannot be read: {e}"))?;
        // until it is worked out the cell holds no value: if it cannot be here, LibreOffice will when it opens the page
        sheet::put_cell(src, s, r, c, &Put { f: Some(f), vt: String::new(), v: Val::Blank, text: String::new(), err: false }, Care::Formula)?
    } else {
        // a number typed into a formatted cell takes the format's type, and shows as the format writes it
        let before = sheet::book(src)?;
        let style = before.style_at(s, r, c);
        let mut put: Put = sheet::typed(typed)?.into();
        if let (Val::Num(n), Typed::Number(_)) = (put.v.clone(), sheet::typed(typed)?) {
            let kind = styles.kind(&style);
            let n = if kind == Some("percentage") { n / 100.0 } else { n };
            put = Put { vt: kind.unwrap_or("float").to_owned(), v: Val::Num(n), text: styles.text(&style, n, kind.unwrap_or("float")), ..put };
        }
        sheet::put_cell(src, s, r, c, &put, Care::Typed)?
    };
    let book = sheet::book(&body)?;
    let mut eng = Engine::new(&book, &styles);
    let results = eng.recalc(&[(s, r, c)], formula.then_some((s, r, c)));
    // each sheet's results are written in one pass over the page
    let mut by_sheet: std::collections::BTreeMap<usize, std::collections::BTreeMap<usize, Vec<(usize, Put)>>> = Default::default();
    for ((s2, r2, c2), put) in results {
        by_sheet.entry(s2).or_default().entry(r2).or_default().push((c2, put));
    }
    for (s2, rows) in &by_sheet {
        body = sheet::put_cells(&body, *s2, rows, Care::Result)?;
    }
    let mut stale: Vec<Key> = eng.stale.iter().copied().collect();
    stale.sort_unstable();
    Ok(Entered { body, stale, done: eng.done })
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

    /// Types the lines of the file `LR_EDITS` (`sheet,row,column,text`) into the spreadsheet in
    /// `LR_FODS` and writes it to `LR_OUT`, to compare with LibreOffice and the web client.
    #[test]
    #[ignore]
    fn real_enter() {
        let (Ok(f), Ok(e), Ok(o)) = (std::env::var("LR_FODS"), std::env::var("LR_EDITS"), std::env::var("LR_OUT")) else { return };
        let mut doc = std::fs::read_to_string(f).unwrap();
        for line in std::fs::read_to_string(e).unwrap().lines() {
            let p: Vec<&str> = line.splitn(4, ',').collect();
            let got = enter(&doc, p[0].parse().unwrap(), p[1].parse().unwrap(), p[2].parse().unwrap(), p[3]).unwrap();
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

    /// Checks formulas against the web client's answers. Each line of a corpus is a formula and what
    /// the web client's engine shows for it in G8 of the sheet, from ui-src/sheet/book.js run under
    /// node. STALE is a formula it does not work out either.
    fn corpus(sheet: &[&[&str]], lines: &str, count: usize) {
        let src = doc(sheet);
        let (mut n, mut wrong) = (0, Vec::new());
        for line in lines.lines() {
            let (f, want) = line.split_once('\t').unwrap();
            let (f, want): (String, String) = (serde_json::from_str(f).unwrap(), serde_json::from_str(want).unwrap());
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
        // Book gives for the same sheet and the same typing, from node: each cell's text and type
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
    fn what_cannot_be_worked_out_keeps_what_it_had_and_is_counted() {
        // a function not known here: its cached 5 stays, and what reads it still follows the 5
        let src = doc(&[&["2", "=NOPE(A1:A1)+3|5", "=B1*2|10"]]);
        let got = enter(&src, 0, 0, 0, "100").unwrap();
        assert_eq!((grid(&got.body)[0].clone(), got.stale, got.done), (vec!["100".to_owned(), "5".into(), "10".into()], vec![(0, 0, 1)], vec![(0, 0, 2)]));
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
