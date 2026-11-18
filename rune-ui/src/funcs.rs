//! The spreadsheet functions worked out here: a port of the web client's
//! `ui-src/sheet/funcs.js`, family by family. LibreOffice Calc is the
//! reference the web client was checked against.
//!
//! A function gets its arguments evaluated, except that a reference
//! arrives as a range, so SUM can walk it. The ones in `lazy` take their
//! arguments unevaluated, because they must not evaluate every branch.
//! A name not here is not worked out: the cell keeps what it had.

use std::collections::HashMap;

use crate::calc::{Ctx, Engine, Rg, Unsupported, V, compare, to_num, to_str};
use crate::formula::Node;

type R = Result<V, Unsupported>;

fn err(code: &str) -> V {
    V::Err(code.to_owned())
}

const VALUE: &str = "#VALUE!";
const DIV0: &str = "#DIV/0!";
const NA: &str = "#N/A";
/// Calc's own codes: a wrong count of arguments, and an argument out of range.
const ARG: &str = "Err:511";
const ILLEGAL: &str = "Err:502";

fn is_err(v: &V) -> bool {
    matches!(v, V::Err(_))
}

/// A value as a truth, or the error it is or makes. Text is no truth.
fn to_bool(v: &V) -> V {
    match v {
        V::Bool(_) | V::Err(_) => v.clone(),
        V::Num(n) => V::Bool(*n != 0.0),
        V::Blank | V::Missing => V::Bool(false),
        V::Str(_) | V::Range(_) => err(VALUE),
    }
}

/// One value from an argument: a one-cell range is its cell, a larger one has no single value.
fn scalar(e: &mut Engine, a: &V) -> V {
    match a {
        V::Range(g) if g.r1 == g.r2 && g.c1 == g.c2 => e.value((g.s, g.r1, g.c1)),
        V::Range(_) => err(VALUE),
        other => other.clone(),
    }
}

fn numeric(s: &str) -> Option<f64> {
    let t = s.trim();
    let shape = !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) && !t.starts_with(['e', 'E']) && t.bytes().any(|b| b.is_ascii_digit());
    t.parse::<f64>().ok().filter(|_| shape)
}

/// Every number in the arguments, as aggregates take them: cells that hold text or nothing
/// are skipped, a text given outright must be a number, and an error anywhere is the result.
fn numbers(e: &mut Engine, args: &[V], text_as_zero: bool) -> Result<Result<Vec<f64>, V>, Unsupported> {
    let mut out = Vec::new();
    for a in args {
        match a {
            V::Range(g) => {
                let mut bad = None;
                e.each(*g, &mut |v| {
                    if bad.is_some() {
                        return;
                    }
                    match v {
                        V::Err(_) => bad = Some(v),
                        V::Num(n) => out.push(n),
                        V::Bool(b) => out.push(f64::from(b)),
                        V::Str(_) if text_as_zero => out.push(0.0),
                        _ => {}
                    }
                })?;
                if let Some(b) = bad {
                    return Ok(Err(b));
                }
            }
            V::Missing => {}
            // a text argument is an error here, even "3": only cells are skipped
            V::Str(_) => return Ok(Err(err(VALUE))),
            other => match to_num(other) {
                V::Num(n) => out.push(n),
                bad => return Ok(Err(bad)),
            },
        }
    }
    Ok(Ok(out))
}

/// Every value in the arguments, empty cells left out.
fn values(e: &mut Engine, args: &[V]) -> Result<Vec<V>, Unsupported> {
    let mut out = Vec::new();
    for a in args {
        match a {
            V::Range(g) => e.each(*g, &mut |v| out.push(v))?,
            V::Missing | V::Blank => {}
            other => out.push(other.clone()),
        }
    }
    Ok(out)
}

fn stat(e: &mut Engine, args: &[V], f: impl FnOnce(Vec<f64>) -> V) -> R {
    Ok(match numbers(e, args, false)? {
        Ok(ns) => f(ns),
        Err(bad) => bad,
    })
}

/// A sum that does not drift: Neumaier's compensated summation, which keeps totals of cents exact.
pub fn ksum(ns: &[f64]) -> f64 {
    let (mut s, mut comp) = (0.0f64, 0.0f64);
    for n in ns {
        let t = s + n;
        comp += if s.abs() >= n.abs() { (s - t) + n } else { (n - t) + s };
        s = t;
    }
    s + comp
}

fn variance(ns: &[f64], pop: bool) -> Result<f64, V> {
    let n = ns.len();
    if n < if pop { 1 } else { 2 } {
        return Err(err(DIV0));
    }
    let mean = ns.iter().sum::<f64>() / n as f64;
    Ok(ns.iter().map(|b| (b - mean).powi(2)).sum::<f64>() / if pop { n as f64 } else { n as f64 - 1.0 })
}

/// A text against a pattern where `*` is any run and `?` any one character, without case.
fn wild(pat: &[char], text: &[char]) -> bool {
    match pat.split_first() {
        None => text.is_empty(),
        Some(('*', rest)) => (0..=text.len()).any(|i| wild(rest, &text[i..])),
        Some(('?', rest)) => !text.is_empty() && wild(rest, &text[1..]),
        Some((c, rest)) => text.first() == Some(c) && wild(rest, &text[1..]),
    }
}

/// A criterion as SUMIF and COUNTIF read it: ">3", "<>x", "abc", 4.
fn criterion(e: &mut Engine, c: &V) -> Box<dyn Fn(&V) -> bool> {
    let c = scalar(e, c);
    let text = match c {
        V::Err(_) => return Box::new(|_| false),
        V::Str(s) => s,
        other => return Box::new(move |v| !matches!(v, V::Blank | V::Missing | V::Str(_)) && compare(v, &other) == 0),
    };
    let (op, raw) = ["<>", "<=", ">=", "=", "<", ">"].into_iter().find_map(|op| text.strip_prefix(op).map(|r| (op, r.to_owned()))).unwrap_or(("=", text.clone()));
    let num = numeric(&raw);
    let equal = op == "=" || op == "<>";
    let pat: Option<Vec<char>> = (num.is_none() && raw.contains(['*', '?']) && equal).then(|| raw.to_lowercase().chars().collect());
    Box::new(move |v| {
        let v = match v {
            V::Err(_) => return false,
            V::Bool(b) => V::Num(f64::from(*b)),
            other => other.clone(),
        };
        if equal {
            let eq = match (&v, &pat, num) {
                (V::Blank | V::Missing, _, _) => raw.is_empty(),
                (V::Str(s), Some(p), _) => wild(p, &s.to_lowercase().chars().collect::<Vec<_>>()),
                (_, Some(_), _) => false,
                (V::Num(n), None, Some(want)) => *n == want,
                (_, None, Some(_)) => false,
                (V::Str(s), None, None) => s.to_lowercase() == raw.to_lowercase(),
                _ => false,
            };
            return (op == "=") == eq;
        }
        let want = match (&v, num) {
            (V::Num(_), Some(n)) => V::Num(n),
            (V::Str(_), None) => V::Str(raw.clone()),
            _ => return false,
        };
        let k = compare(&v, &want);
        match op {
            "<" => k < 0,
            ">" => k > 0,
            "<=" => k <= 0,
            _ => k >= 0,
        }
    })
}

/// The cells of a range and, beside each, the cell at the same place in another range.
/// The rectangle is walked whole, held to what the sheet has in it.
fn pairs(e: &mut Engine, test: Rg, other: Option<Rg>, f: &mut dyn FnMut(V, V)) {
    let (rows, cols) = e.used(test.s);
    let r2 = test.r2.min(rows.saturating_sub(1).max(test.r1));
    let c2 = test.c2.min(cols.saturating_sub(1).max(test.c1));
    for r in test.r1..=r2 {
        for c in test.c1..=c2 {
            let v = e.value((test.s, r, c));
            let w = match other {
                Some(o) => e.value((o.s, o.r1 + (r - test.r1), o.c1 + (c - test.c1))),
                None => v.clone(),
            };
            f(v, w);
        }
    }
}

/// SUMIFS and COUNTIFS: every row and column of the first test range where every test holds.
fn ifs(e: &mut Engine, sum: Option<&V>, tests: &[V], step: impl Fn(f64, &V) -> f64) -> V {
    let mut checks = Vec::new();
    for pair in tests.chunks(2) {
        let [V::Range(g), c] = pair else { return if pair.len() == 2 { err(VALUE) } else { break } };
        checks.push((*g, criterion(e, c)));
    }
    let Some((f, _)) = checks.first() else { return err(ARG) };
    let f = *f;
    let (rows, cols) = e.used(f.s);
    let mut acc = 0.0;
    for i in 0..f.rows().min(rows.saturating_sub(f.r1)) {
        for j in 0..f.cols().min(cols.saturating_sub(f.c1)) {
            let mut all = true;
            for (g, ok) in &checks {
                if !ok(&e.value((g.s, g.r1 + i, g.c1 + j))) {
                    all = false;
                    break;
                }
            }
            if all {
                let w = match sum {
                    Some(V::Range(g)) => e.value((g.s, g.r1 + i, g.c1 + j)),
                    _ => V::Blank,
                };
                acc = step(acc, &w);
            }
        }
    }
    V::Num(acc)
}

/// Rounded as Calc rounds: half away from nothing, with a hair's allowance for what a binary fraction cannot hold.
fn round(n: f64, d: f64, mode: u8) -> f64 {
    let f = 10f64.powf(d);
    let x = n * f;
    let y = match mode {
        b'u' if n < 0.0 => -(-x - 1e-9).ceil(),
        b'u' => (x - 1e-9).ceil(),
        b'd' if n < 0.0 => -(-x + 1e-9).floor(),
        b'd' => (x + 1e-9).floor(),
        _ if n < 0.0 => -js_round(-x + 1e-9),
        _ => js_round(x + 1e-9),
    };
    y / f
}

/// JavaScript's `Math.round`: a half goes up, toward the larger number.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn fin(n: f64) -> V {
    if n.is_finite() { V::Num(n) } else { err("#NUM!") }
}

/// A number that changes each time it is asked for.
fn random() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    // ponytail: the standard library's own seeded hasher, so no dependency for RAND
    let bits = std::collections::hash_map::RandomState::new().build_hasher().finish();
    (bits >> 11) as f64 / (1u64 << 53) as f64
}

/// Where a slice starts or ends, as JavaScript's `slice` reads an index: cut to a whole
/// number, counted from the end when it is below nothing, and held inside the length.
fn js_index(len: usize, i: f64) -> usize {
    let i = if i.is_nan() { 0.0 } else { i.trunc() };
    if i < 0.0 { (len as f64 + i).max(0.0) as usize } else { i.min(len as f64) as usize }
}

fn slice<T: Clone>(v: &[T], from: f64, to: f64) -> Vec<T> {
    let (a, b) = (js_index(v.len(), from), js_index(v.len(), to));
    if a < b { v[a..b].to_vec() } else { Vec::new() }
}

/// Where `needle` first is in `hay` at or after `from`, both in UTF-16 units as JavaScript counts a text.
fn index_of(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return (from <= hay.len()).then_some(from);
    }
    (from..=hay.len().checked_sub(needle.len())?).find(|i| hay[*i..].starts_with(needle))
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn text_of(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

/// The first of the values that is an error.
fn first_err(vs: &[&V]) -> Option<V> {
    vs.iter().find(|v| is_err(v)).map(|v| (*v).clone())
}

/// The functions that take their arguments unevaluated. `None` for a name that is not one of them.
pub fn lazy(e: &mut Engine, name: &str, n: &[Node], ctx: Ctx) -> Option<R> {
    Some((|| -> R {
        Ok(match name {
            "IF" => {
                if n.is_empty() || n.len() > 3 {
                    return Ok(err(ARG));
                }
                let c = e.ev(&n[0], ctx)?;
                let c = to_bool(&scalar(e, &c));
                let V::Bool(c) = c else { return Ok(c) };
                // a branch left empty is 0, and no else branch is FALSE
                let (at, none) = if c { (1, V::Bool(true)) } else { (2, V::Bool(false)) };
                match n.get(at) {
                    Some(Node::Missing) => V::Num(0.0),
                    Some(x) => e.ev(x, ctx)?,
                    None => none,
                }
            }
            "IFERROR" | "IFNA" => {
                let v = e.ev(n.first().ok_or(Unsupported)?, ctx)?;
                let v = scalar(e, &v);
                let caught = match &v {
                    V::Err(code) => name == "IFERROR" || code == NA,
                    _ => false,
                };
                match (caught, n.get(1)) {
                    (true, Some(x)) => e.ev(x, ctx)?,
                    (true, None) => V::Str(String::new()),
                    (false, _) => v,
                }
            }
            "IFS" => {
                for pair in n.chunks(2) {
                    let [test, then] = pair else { break };
                    let c = e.ev(test, ctx)?;
                    match to_bool(&scalar(e, &c)) {
                        V::Bool(true) => return e.ev(then, ctx),
                        V::Bool(false) => {}
                        bad => return Ok(bad),
                    }
                }
                err(NA)
            }
            "SWITCH" => {
                let v = e.ev(n.first().ok_or(Unsupported)?, ctx)?;
                let v = scalar(e, &v);
                if is_err(&v) {
                    return Ok(v);
                }
                let mut i = 1;
                while i + 1 < n.len() {
                    let w = e.ev(&n[i], ctx)?;
                    let w = scalar(e, &w);
                    if is_err(&w) {
                        return Ok(w);
                    }
                    if std::mem::discriminant(&w) == std::mem::discriminant(&v) && compare(&v, &w) == 0 {
                        return e.ev(&n[i + 1], ctx);
                    }
                    i += 2;
                }
                match n.get(i) {
                    Some(x) => e.ev(x, ctx)?,
                    None => err(NA),
                }
            }
            "AND" | "OR" | "XOR" => {
                let step = |acc: bool, b: bool| match name {
                    "AND" => acc && b,
                    "OR" => acc || b,
                    _ => acc != b,
                };
                let (mut acc, mut seen) = (name == "AND", 0usize);
                for node in n {
                    let mut bad = None;
                    match e.ev(node, ctx)? {
                        V::Range(g) => e.each(g, &mut |x| match x {
                            _ if bad.is_some() => {}
                            V::Err(_) => bad = Some(x),
                            V::Num(v) => {
                                acc = step(acc, v != 0.0);
                                seen += 1;
                            }
                            V::Bool(v) => {
                                acc = step(acc, v);
                                seen += 1;
                            }
                            _ => {}
                        })?,
                        v => match to_bool(&v) {
                            V::Bool(b) => {
                                acc = step(acc, b);
                                seen += 1;
                            }
                            other => bad = Some(other),
                        },
                    }
                    if let Some(b) = bad {
                        return Ok(b);
                    }
                }
                if seen > 0 { V::Bool(acc) } else { err(VALUE) }
            }
            _ => return Err(Unsupported),
        })
    })())
    .filter(|_| matches!(name, "IF" | "IFERROR" | "IFNA" | "IFS" | "SWITCH" | "AND" | "OR" | "XOR"))
}

/// A function of evaluated arguments. An argument left out is `V::Missing`.
pub fn call(e: &mut Engine, name: &str, a: &[V], _ctx: Ctx) -> R {
    let arg = |i: usize| a.get(i).cloned().unwrap_or(V::Missing);
    // an argument left out, or an empty cell handed on, takes the default
    let or = |i: usize, d: f64| match a.get(i) {
        None | Some(V::Missing | V::Blank) => V::Num(d),
        Some(v) => v.clone(),
    };
    macro_rules! num1 {
        ($f:expr) => {{
            let v = scalar(e, &arg(0));
            match to_num(&v) {
                V::Num(n) => {
                    let f: fn(f64) -> V = $f;
                    f(n)
                }
                bad => bad,
            }
        }};
    }
    macro_rules! num2 {
        ($y:expr, $f:expr) => {{
            let (x, y) = (scalar(e, &arg(0)), scalar(e, &$y));
            match (to_num(&x), to_num(&y)) {
                (V::Num(x), V::Num(y)) => {
                    let f: fn(f64, f64) -> V = $f;
                    f(x, y)
                }
                (V::Num(_), bad) | (bad, _) => bad,
            }
        }};
    }
    let n = V::Num;
    Ok(match name {
        // sums and statistics
        "SUM" => stat(e, a, |ns| n(ksum(&ns)))?,
        "PRODUCT" => stat(e, a, |ns| n(if ns.is_empty() { 0.0 } else { ns.iter().product() }))?,
        "AVERAGE" => stat(e, a, |ns| if ns.is_empty() { err(DIV0) } else { n(ksum(&ns) / ns.len() as f64) })?,
        "MIN" => stat(e, a, |ns| n(ns.iter().copied().reduce(f64::min).unwrap_or(0.0)))?,
        "MAX" => stat(e, a, |ns| n(ns.iter().copied().reduce(f64::max).unwrap_or(0.0)))?,
        "COUNT" => {
            let mut k = 0usize;
            for x in a {
                match x {
                    V::Range(g) => e.each(*g, &mut |v| k += usize::from(matches!(v, V::Num(_) | V::Bool(_))))?,
                    V::Num(_) | V::Bool(_) => k += 1,
                    V::Str(s) if numeric(s).is_some() => k += 1,
                    _ => {}
                }
            }
            n(k as f64)
        }
        "COUNTA" => n(values(e, a)?.len() as f64),
        "COUNTBLANK" => match a.first() {
            Some(V::Range(g)) => {
                let mut full = 0usize;
                e.each(*g, &mut |v| full += usize::from(v != V::Str(String::new())))?;
                n((g.rows() * g.cols() - full) as f64)
            }
            _ => err(VALUE),
        },
        "MEDIAN" => stat(e, a, |mut ns| {
            if ns.is_empty() {
                return err("#NUM!");
            }
            ns.sort_by(f64::total_cmp);
            let m = ns.len() / 2;
            n(if ns.len() % 2 == 1 { ns[m] } else { (ns[m - 1] + ns[m]) / 2.0 })
        })?,
        "MODE" => stat(e, a, |ns| {
            let mut seen: HashMap<u64, usize> = HashMap::new();
            let (mut best, mut top) = (None::<f64>, 1usize);
            for x in ns {
                let x = x + 0.0;
                let k = seen.entry(x.to_bits()).or_insert(0);
                *k += 1;
                let k = *k;
                let tie = k == top && k > 1 && best.is_some_and(|b| x < b && seen.get(&b.to_bits()) == Some(&k));
                if k > top || tie {
                    (top, best) = (k, Some(x));
                }
            }
            best.map_or(err(VALUE), n)
        })?,
        "VAR" | "VARP" | "STDEV" | "STDEVP" => stat(e, a, |ns| match variance(&ns, name.ends_with('P')) {
            Ok(v) => n(if name.starts_with('S') { v.sqrt() } else { v }),
            Err(bad) => bad,
        })?,
        "LARGE" | "SMALL" => {
            let k = to_num(&scalar(e, &arg(1)));
            stat(e, &a[..a.len().min(1)], |mut ns| match k {
                V::Num(k) if k < 1.0 || k > ns.len() as f64 => err(VALUE),
                V::Num(k) => {
                    ns.sort_by(f64::total_cmp);
                    if name == "LARGE" {
                        ns.reverse();
                    }
                    n(ns[k.floor() as usize - 1])
                }
                bad => bad,
            })?
        }
        "RANK" => {
            let V::Num(v) = to_num(&scalar(e, &arg(0))) else { return Ok(to_num(&scalar(e, &arg(0)))) };
            let asc = a.get(2).is_some_and(|x| *x != V::Missing) && to_num(&scalar(e, &arg(2))) != V::Num(0.0);
            stat(e, &a[1..a.len().min(2)], |ns| if ns.contains(&v) { n(1.0 + ns.iter().filter(|x| if asc { **x < v } else { **x > v }).count() as f64) } else { err(VALUE) })?
        }
        "SUMIF" | "COUNTIF" | "AVERAGEIF" => {
            let Some(V::Range(test)) = a.first() else { return Ok(err(VALUE)) };
            let ok = criterion(e, &arg(1));
            let other = match a.get(2) {
                Some(V::Range(g)) if name != "COUNTIF" => Some(*g),
                _ => None,
            };
            let (mut ns, mut hits, mut bad) = (Vec::new(), 0usize, None);
            pairs(e, *test, other, &mut |v, w| {
                if ok(&v) {
                    hits += 1;
                    match w {
                        V::Err(_) if name == "SUMIF" => bad = Some(w),
                        V::Num(x) => ns.push(x),
                        V::Bool(b) if name == "SUMIF" => ns.push(f64::from(b)),
                        _ => {}
                    }
                }
            });
            match name {
                "COUNTIF" => n(hits as f64),
                "SUMIF" => bad.unwrap_or_else(|| n(ksum(&ns))),
                _ if ns.is_empty() => err(DIV0),
                _ => n(ksum(&ns) / ns.len() as f64),
            }
        }
        "SUMIFS" => ifs(e, a.first(), a.get(1..).unwrap_or(&[]), |acc, w| if let V::Num(x) = w { acc + x } else { acc }),
        "COUNTIFS" => ifs(e, None, a, |acc, _| acc + 1.0),
        "SUMPRODUCT" => {
            let gs: Vec<Rg> = a.iter().filter_map(|x| if let V::Range(g) = x { Some(*g) } else { None }).collect();
            let Some(f) = gs.first().copied().filter(|_| gs.len() == a.len()) else { return Ok(err(VALUE)) };
            if gs.iter().any(|g| g.rows() != f.rows() || g.cols() != f.cols()) {
                return Ok(err(VALUE));
            }
            let (rows, cols) = e.used(f.s);
            let mut s = 0.0;
            for i in 0..f.rows().min(rows.saturating_sub(f.r1)) {
                for j in 0..f.cols().min(cols.saturating_sub(f.c1)) {
                    let mut p = 1.0;
                    for g in &gs {
                        match e.value((g.s, g.r1 + i, g.c1 + j)) {
                            V::Err(code) => return Ok(V::Err(code)),
                            V::Num(x) => p *= x,
                            V::Bool(b) => p *= f64::from(b),
                            _ => p = 0.0,
                        }
                    }
                    s += p;
                }
            }
            n(s)
        }

        // maths
        "ABS" => num1!(|x| V::Num(x.abs())),
        "SIGN" => num1!(|x| V::Num(if x > 0.0 { 1.0 } else if x < 0.0 { -1.0 } else { 0.0 })),
        "INT" => num1!(|x| V::Num(x.floor())),
        "TRUNC" | "ROUNDDOWN" => num2!(or(1, 0.0), |x, d| V::Num(round(x, d, b'd'))),
        "ROUND" => num2!(or(1, 0.0), |x, d| V::Num(round(x, d, b'r'))),
        "ROUNDUP" => num2!(or(1, 0.0), |x, d| V::Num(round(x, d, b'u'))),
        "MOD" => num2!(arg(1), |x, d| if d == 0.0 { err(DIV0) } else { V::Num(x - d * (x / d).floor()) }),
        "QUOTIENT" => num2!(arg(1), |x, d| if d == 0.0 { err(DIV0) } else { V::Num((x / d).trunc()) }),
        "POWER" => num2!(arg(1), crate::calc::power),
        "SQRT" => num1!(|x| if x < 0.0 { err(ILLEGAL) } else { V::Num(x.sqrt()) }),
        "EXP" => num1!(|x| fin(x.exp())),
        "LN" => num1!(|x| if x <= 0.0 { err(ILLEGAL) } else { V::Num(x.ln()) }),
        "LOG10" => num1!(|x| if x <= 0.0 { err(ILLEGAL) } else { V::Num(x.log10()) }),
        "LOG" => num2!(or(1, 10.0), |x, b| if x <= 0.0 || b <= 0.0 { err(ILLEGAL) } else { V::Num(x.ln() / b.ln()) }),
        "PI" => n(std::f64::consts::PI),
        "SIN" => num1!(|x| V::Num(x.sin())),
        "COS" => num1!(|x| V::Num(x.cos())),
        "TAN" => num1!(|x| V::Num(x.tan())),
        "ASIN" => num1!(|x| fin(x.asin())),
        "ACOS" => num1!(|x| fin(x.acos())),
        "ATAN" => num1!(|x| V::Num(x.atan())),
        "ATAN2" => num2!(arg(1), |x, y| V::Num(y.atan2(x))),
        "DEGREES" => num1!(|x| V::Num(x * 180.0 / std::f64::consts::PI)),
        "RADIANS" => num1!(|x| V::Num(x * std::f64::consts::PI / 180.0)),
        "EVEN" => num1!(|x| V::Num(x.signum() * 2.0 * (x.abs() / 2.0 - 1e-12).ceil() + 0.0)),
        "ODD" => num1!(|x| {
            let m = (x.abs() - 1e-12).ceil();
            V::Num(if x < 0.0 { -1.0 } else { 1.0 } * if m % 2.0 != 0.0 { m } else { m + 1.0 })
        }),
        "FACT" => num1!(|x| if x < 0.0 { err(ARG) } else { fin((2..=x.floor() as u64).fold(1.0, |f, i| f * i as f64)) }),
        "CEILING" => num2!(or(1, 1.0), |x, s| V::Num(if s == 0.0 { 0.0 } else if x < 0.0 && s < 0.0 { (x / s + 1e-12).floor() * s } else { (x / s - 1e-12).ceil() * s })),
        "FLOOR" => num2!(or(1, 1.0), |x, s| if s == 0.0 { err(DIV0) } else { V::Num(if x < 0.0 && s < 0.0 { (x / s - 1e-12).ceil() * s } else { (x / s + 1e-12).floor() * s }) }),
        "MROUND" => num2!(arg(1), |x, s| V::Num(if s == 0.0 { 0.0 } else { js_round(x / s) * s })),
        "GCD" => stat(e, a, |ns| {
            n(ns.iter().map(|x| x.abs().floor()).fold(0.0, |mut x, mut y| {
                while y != 0.0 {
                    (x, y) = (y, x % y);
                }
                x
            }))
        })?,
        "LCM" => stat(e, a, |ns| {
            n(ns.iter().map(|x| x.abs().floor()).fold(1.0, |x, y| {
                if x == 0.0 || y == 0.0 {
                    return 0.0;
                }
                let (mut g, mut h) = (x, y);
                while h != 0.0 {
                    (g, h) = (h, g % h);
                }
                x / g * y
            }))
        })?,
        "RAND" => n(random()),
        "RANDBETWEEN" => num2!(arg(1), |lo, hi| V::Num((lo + random() * (hi - lo + 1.0)).floor())),

        // logic
        "TRUE" => V::Bool(true),
        "FALSE" => V::Bool(false),
        "NOT" => match to_bool(&scalar(e, &arg(0))) {
            V::Bool(b) => V::Bool(!b),
            bad => bad,
        },
        "NA" => err(NA),
        "ISBLANK" => V::Bool(matches!(a.first(), Some(V::Range(g)) if g.r1 == g.r2 && g.c1 == g.c2 && e.value((g.s, g.r1, g.c1)) == V::Blank)),
        "ISNUMBER" => V::Bool(matches!(scalar(e, &arg(0)), V::Num(_) | V::Bool(_))),
        "ISTEXT" => V::Bool(matches!(scalar(e, &arg(0)), V::Str(_))),
        "ISNONTEXT" => V::Bool(!matches!(scalar(e, &arg(0)), V::Str(_))),
        "ISLOGICAL" => V::Bool(matches!(scalar(e, &arg(0)), V::Bool(_))),
        "ISERROR" => V::Bool(is_err(&scalar(e, &arg(0)))),
        "ISERR" => V::Bool(matches!(scalar(e, &arg(0)), V::Err(code) if code != NA)),
        "ISNA" => V::Bool(matches!(scalar(e, &arg(0)), V::Err(code) if code == NA)),
        "ISEVEN" => num1!(|x| V::Bool(x.trunc() % 2.0 == 0.0)),
        "ISODD" => num1!(|x| V::Bool(x.trunc() % 2.0 != 0.0)),
        "N" => match scalar(e, &arg(0)) {
            V::Err(code) => V::Err(code),
            V::Num(x) => n(x),
            V::Bool(b) => n(f64::from(b)),
            _ => n(0.0),
        },
        "T" => match scalar(e, &arg(0)) {
            v @ (V::Str(_) | V::Err(_)) => v,
            _ => V::Str(String::new()),
        },

        // text
        "LEN" | "UPPER" | "LOWER" | "PROPER" | "TRIM" | "CODE" => match scalar(e, &arg(0)) {
            V::Err(code) => V::Err(code),
            v => {
                let s = to_str(&v);
                match name {
                    "LEN" => n(s.chars().count() as f64),
                    "UPPER" => V::Str(s.to_uppercase()),
                    "LOWER" => V::Str(s.to_lowercase()),
                    "PROPER" => {
                        // a letter after the start, or after what is neither a letter nor a digit, is a capital
                        let mut up = true;
                        V::Str(s.to_lowercase().chars().flat_map(|c| {
                            let out: Vec<char> = if up && c.is_alphabetic() { c.to_uppercase().collect() } else { vec![c] };
                            up = !c.is_alphanumeric();
                            out
                        }).collect())
                    }
                    "TRIM" => {
                        // runs of spaces are one space, and one at each end goes
                        let mut t = String::new();
                        for c in s.chars() {
                            if !(c == ' ' && t.ends_with(' ')) {
                                t.push(c);
                            }
                        }
                        let t = t.strip_prefix(' ').unwrap_or(&t);
                        V::Str(t.strip_suffix(' ').unwrap_or(t).to_owned())
                    }
                    _ => units(&s).first().map_or(err(VALUE), |u| n(f64::from(*u))),
                }
            }
        },
        "LEFT" | "RIGHT" => {
            let s = scalar(e, &arg(0));
            let k = if a.get(1).is_none_or(|x| *x == V::Missing) { V::Num(1.0) } else { to_num(&scalar(e, &arg(1))) };
            match (first_err(&[&s, &k]), k) {
                (Some(bad), _) => bad,
                (None, V::Num(k)) if k < 0.0 => err(ARG),
                (None, V::Num(k)) => {
                    let ch: Vec<char> = to_str(&s).chars().collect();
                    let k = k.floor();
                    V::Str(if name == "LEFT" { slice(&ch, 0.0, k) } else if k == 0.0 { Vec::new() } else { slice(&ch, -k, f64::INFINITY) }.into_iter().collect())
                }
                _ => err(VALUE),
            }
        }
        "MID" => {
            let (s, st, k) = (scalar(e, &arg(0)), to_num(&scalar(e, &arg(1))), to_num(&scalar(e, &arg(2))));
            match (first_err(&[&s, &st, &k]), st, k) {
                (Some(bad), ..) => bad,
                (None, V::Num(st), V::Num(k)) if st < 1.0 || k < 0.0 => err(ARG),
                (None, V::Num(st), V::Num(k)) => {
                    let ch: Vec<char> = to_str(&s).chars().collect();
                    V::Str(slice(&ch, st.floor() - 1.0, st.floor() - 1.0 + k.floor()).into_iter().collect())
                }
                _ => err(VALUE),
            }
        }
        "CONCATENATE" | "CONCAT" => {
            let vs: Vec<V> = if name == "CONCAT" { values(e, a)? } else { a.iter().map(|x| scalar(e, x)).collect() };
            vs.iter().find(|v| is_err(v)).cloned().unwrap_or_else(|| V::Str(vs.iter().map(to_str).collect()))
        }
        "TEXTJOIN" => {
            let (d, skip) = (scalar(e, &arg(0)), to_bool(&scalar(e, &arg(1))));
            let V::Bool(skip) = skip else { return Ok(if is_err(&d) { d } else { skip }) };
            if is_err(&d) {
                return Ok(d);
            }
            let mut parts = Vec::new();
            for x in a.iter().skip(2) {
                match x {
                    V::Range(g) => {
                        let (rows, cols) = e.used(g.s);
                        for i in 0..g.rows().min(rows.saturating_sub(g.r1)) {
                            for j in 0..g.cols().min(cols.saturating_sub(g.c1)) {
                                parts.push(e.value((g.s, g.r1 + i, g.c1 + j)));
                            }
                        }
                    }
                    other => parts.push(other.clone()),
                }
            }
            parts.iter().find(|v| is_err(v)).cloned().unwrap_or_else(|| V::Str(parts.iter().map(to_str).filter(|s| !skip || !s.is_empty()).collect::<Vec<_>>().join(&to_str(&d))))
        }
        "REPT" => {
            let (s, k) = (scalar(e, &arg(0)), to_num(&scalar(e, &arg(1))));
            match (first_err(&[&s, &k]), k) {
                (Some(bad), _) => bad,
                (None, V::Num(k)) => {
                    let s = to_str(&s);
                    if k < 0.0 || k * units(&s).len() as f64 > 65_535.0 { err(VALUE) } else { V::Str(s.repeat(k.floor() as usize)) }
                }
                _ => err(VALUE),
            }
        }
        "EXACT" => {
            let (x, y) = (scalar(e, &arg(0)), scalar(e, &arg(1)));
            first_err(&[&x, &y]).unwrap_or_else(|| V::Bool(to_str(&x) == to_str(&y)))
        }
        "FIND" | "SEARCH" => {
            let (needle, hay) = (scalar(e, &arg(0)), scalar(e, &arg(1)));
            let st = if a.get(2).is_none_or(|x| *x == V::Missing) { V::Num(1.0) } else { to_num(&scalar(e, &arg(2))) };
            match (first_err(&[&needle, &hay, &st]), st) {
                (Some(bad), _) => bad,
                (None, V::Num(st)) if st < 1.0 => err(VALUE),
                (None, V::Num(st)) => {
                    let fold = |v: &V| if name == "SEARCH" { to_str(v).to_lowercase() } else { to_str(v) };
                    let (nd, hy) = (units(&fold(&needle)), units(&fold(&hay)));
                    index_of(&hy, &nd, js_index(hy.len(), st - 1.0)).map_or(err(VALUE), |at| n(at as f64 + 1.0))
                }
                _ => err(VALUE),
            }
        }
        "SUBSTITUTE" => {
            let (s, from, to) = (scalar(e, &arg(0)), scalar(e, &arg(1)), scalar(e, &arg(2)));
            if let Some(bad) = first_err(&[&s, &from, &to]) {
                return Ok(bad);
            }
            let (s, f, t) = (to_str(&s), to_str(&from), to_str(&to));
            if f.is_empty() {
                return Ok(V::Str(s));
            }
            if a.get(3).is_none_or(|x| *x == V::Missing) {
                return Ok(V::Str(s.replace(&f, &t)));
            }
            // the one named: the first, the second. As JavaScript counts, in UTF-16 units
            let k = match to_num(&scalar(e, &arg(3))) {
                V::Num(k) => k,
                bad => return Ok(bad),
            };
            let (su, fu) = (units(&s), units(&f));
            let mut at: f64 = -1.0;
            let mut i = 0.0;
            while i < k {
                match index_of(&su, &fu, (at + 1.0) as usize) {
                    Some(hit) => at = hit as f64,
                    None => return Ok(V::Str(s)),
                }
                i += 1.0;
            }
            V::Str(text_of(&slice(&su, 0.0, at)) + &t + &text_of(&slice(&su, at + fu.len() as f64, f64::INFINITY)))
        }
        "REPLACE" => {
            let (s, st, k, w) = (scalar(e, &arg(0)), to_num(&scalar(e, &arg(1))), to_num(&scalar(e, &arg(2))), scalar(e, &arg(3)));
            match (first_err(&[&s, &st, &k, &w]), st, k) {
                (Some(bad), ..) => bad,
                (None, V::Num(st), V::Num(k)) => {
                    let ch: Vec<char> = to_str(&s).chars().collect();
                    V::Str(slice(&ch, 0.0, st - 1.0).into_iter().collect::<String>() + &to_str(&w) + &slice(&ch, st - 1.0 + k, f64::INFINITY).into_iter().collect::<String>())
                }
                _ => err(VALUE),
            }
        }
        "VALUE" => {
            let v = scalar(e, &arg(0));
            let got = match &v {
                V::Str(s) => to_num(&V::Str(s.replace(',', ""))),
                other => to_num(other),
            };
            // text that is no number is Calc's own error for it
            if got == err(VALUE) { err(ILLEGAL) } else { got }
        }
        "CHAR" => num1!(|x| if !(1.0..=255.0).contains(&x) { err(ARG) } else { V::Str(char::from_u32(x as u32).map_or(String::new(), String::from)) }),
        _ => return Err(Unsupported),
    })
}
