//! The spreadsheet functions worked out here: a port of the web client's
//! `ui-src/sheet/funcs.js`, family by family. LibreOffice Calc is the
//! reference the web client was checked against.
//!
//! A function gets its arguments evaluated, except that a reference
//! arrives as a range, so SUM can walk it. The ones in `lazy` take their
//! arguments unevaluated, because they must not evaluate every branch.
//! A name not here is not worked out: the cell keeps what it had.

use std::collections::HashMap;

use crate::calc::{Ctx, Engine, Rg, Unsupported, V, approx_floor, compare, to_num, to_str};
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
/// A `~` before one of the two, or before itself, makes it the character it is.
fn wild(pat: &[char], text: &[char]) -> bool {
    let plain = |p: usize| matches!((pat.get(p), pat.get(p + 1)), (Some('~'), Some('*' | '?' | '~')));
    // one place to go back to, the last star: a pattern of many stars is not tried every way it could be cut
    let (mut p, mut t, mut star, mut held) = (0, 0, None, 0);
    while t < text.len() {
        match pat.get(p) {
            Some(_) if plain(p) && pat[p + 1] == text[t] => (p, t) = (p + 2, t + 1),
            Some('*') if !plain(p) => (star, held, p) = (Some(p), t, p + 1),
            Some(c) if !plain(p) && (*c == '?' || *c == text[t]) => (p, t) = (p + 1, t + 1),
            _ => match star {
                Some(s) => (p, held, t) = (s + 1, held + 1, held + 1),
                None => return false,
            },
        }
    }
    pat[p..].iter().all(|c| *c == '*')
}

/// Whether a text to look for has a `*` or a `?` that stands for others.
fn wildcards(raw: &str) -> bool {
    raw.contains(['*', '?'])
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
    // a number, or what is typed into a cell as one: a date, a time of day, a percentage, money, true or false
    let num = numeric(&raw).or_else(|| match crate::sheet::typed_on(&raw, e.null_date()) {
        Ok(crate::sheet::Typed::Number(n) | crate::sheet::Typed::Special(_, n)) => Some(n),
        Ok(crate::sheet::Typed::Bool(b)) => Some(f64::from(b)),
        _ => None,
    });
    let equal = op == "=" || op == "<>";
    let pat: Option<Vec<char>> = (num.is_none() && wildcards(&raw) && equal).then(|| raw.to_lowercase().chars().collect());
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
                (V::Num(n), None, Some(want)) => crate::calc::approx_eq(*n, want),
                // a cell of text that spells the number as the criterion spells it
                (V::Str(s), None, Some(_)) => s.to_lowercase() == raw.to_lowercase(),
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
fn pairs(e: &mut Engine, test: Rg, other: Option<Rg>, f: &mut dyn FnMut(V, V)) -> Result<(), Unsupported> {
    let (rows, cols) = e.used(test.s);
    let r2 = test.r2.min(rows.saturating_sub(1).max(test.r1));
    let c2 = test.c2.min(cols.saturating_sub(1).max(test.c1));
    // as a range is walked elsewhere: more cells than a formula may walk, and it keeps what it had
    if (r2 - test.r1 + 1).saturating_mul(c2 - test.c1 + 1) > WALK_MOST {
        return Err(Unsupported);
    }
    for r in test.r1..=r2 {
        for c in test.c1..=c2 {
            if e.leaving() {
                return Err(Unsupported);
            }
            let v = e.value((test.s, r, c));
            let w = match other {
                Some(o) => e.value((o.s, o.r1 + (r - test.r1), o.c1 + (c - test.c1))),
                None => v.clone(),
            };
            f(v, w);
        }
    }
    Ok(())
}

/// The most cells one test of a range may walk.
const WALK_MOST: usize = 5_000_000;

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
    if f.rows().min(rows.saturating_sub(f.r1)).saturating_mul(f.cols().min(cols.saturating_sub(f.c1))) > WALK_MOST {
        return err(ILLEGAL);
    }
    for i in 0..f.rows().min(rows.saturating_sub(f.r1)) {
        for j in 0..f.cols().min(cols.saturating_sub(f.c1)) {
            // read all it may: the formula is left stale, whatever is handed back
            if e.leaving() {
                return err(ILLEGAL);
            }
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

/// Rounded as Calc rounds: half away from nothing (`r`), away from it (`u`) or towards it
/// (`d`). The scaled number is taken as Calc takes it, so 0.29*100 is 29 and 8.2-8, which is
/// under 0.2 by more than a hair, is not 0.2. Down and half-up read it to fifteen figures
/// (`approx_value`). Up forgives only what is within a few parts in 10^12 of a whole number:
/// 5.00000000000001 stays 5 and 5.00000000001 goes up to 6, as in Calc.
fn round(n: f64, d: f64, mode: u8) -> f64 {
    // the count of places is a whole number: 2.9 places are 2
    let places = d.trunc();
    let f = 10f64.powf(places.abs());
    let scale = |v: f64, forward: bool| if (places >= 0.0) == forward { v * f } else { v / f };
    let x = scale(n.abs(), true);
    // fewer places than a number has digits leave nothing, and more than it can have leave it as it is
    if places < 0.0 && f.is_infinite() {
        return 0.0;
    }
    if !f.is_finite() || !x.is_finite() {
        return n;
    }
    // too large to have a fraction at this place
    if x >= 4_503_599_627_370_496.0 {
        return n;
    }
    let y = match mode {
        b'u' => {
            let m = x.floor();
            // the allowance goes with the number's first figure, and never past binary noise: a number
            // that is plainly a fraction goes up, and one just under a whole number goes up to it
            let hair = if x < 2_199_023_255_552.0 { (7.5e-12 * 10f64.powi(x.log10().floor() as i32)).min(1e-3) } else { (4.0 * f64::EPSILON * x).min(0.25) };
            if x - m <= hair { m } else { x.ceil() }
        }
        b'd' => crate::calc::approx_value(x).floor(),
        _ => js_round(crate::calc::approx_value(x)),
    };
    let out = scale(y, false);
    if n < 0.0 { -out } else { out }
}

/// JavaScript's `Math.round`: a half goes up, toward the larger number.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// The hour, the minute and the second of a day number, as Calc's HOUR, MINUTE and SECOND
/// give them: the hour and the minute are those the time is in, and the second is the
/// nearest, so 23:59:59.9 is hour 23, minute 59, second 0.
fn clock(x: f64) -> (f64, f64, f64) {
    let secs = crate::sheet::day_seconds(x).1;
    ((secs / 3600.0).floor() % 24.0, (secs / 60.0).floor() % 60.0, (secs + 0.5).floor() % 60.0)
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

/// What sort of value it is, as a lookup tells them apart: a number, a text, a truth, or neither.
fn kind(v: &V) -> u8 {
    match v {
        V::Num(_) => 1,
        V::Str(_) => 2,
        V::Bool(_) => 3,
        _ => 0,
    }
}

/// Where `needle` is in a column or a row of values: the entry that equals it, or, in a
/// sorted one, the last entry not greater than it.
fn lookup(e: &mut Engine, needle: &V, vec: &[V], exact: bool) -> Result<usize, V> {
    let needle = scalar(e, needle);
    if is_err(&needle) {
        return Err(needle);
    }
    if exact {
        // a text looked for with a `*` or a `?` in it is a pattern, as it is for COUNTIF
        if let V::Str(want) = &needle {
            if wildcards(want) {
                let pat: Vec<char> = want.to_lowercase().chars().collect();
                let hit = vec.iter().position(|v| matches!(v, V::Str(s) if wild(&pat, &s.to_lowercase().chars().collect::<Vec<_>>())));
                return hit.ok_or_else(|| err(NA));
            }
        }
        let hit = vec.iter().position(|v| (kind(v) != 0 && kind(v) == kind(&needle) && compare(v, &needle) == 0) || matches!((v, &needle), (V::Bool(b), V::Num(x)) if f64::from(*b) == *x));
        return hit.ok_or_else(|| err(NA));
    }
    let mut hit = None;
    for (i, v) in vec.iter().enumerate() {
        if kind(v) == 0 || kind(v) != kind(&needle) {
            continue;
        }
        if compare(v, &needle) <= 0 { hit = Some(i) } else { break }
    }
    hit.ok_or_else(|| err(NA))
}

/// The cells of one column of a range, or of one row, as far as the sheet holds anything.
fn line(e: &mut Engine, g: Rg, down: bool) -> Vec<V> {
    let (rows, cols) = e.used(g.s);
    // no further than the formula may read: it is left stale then, whatever is made of the part read
    if down {
        (0..g.rows().min(rows.saturating_sub(g.r1))).map_while(|i| (!e.leaving()).then(|| e.value((g.s, g.r1 + i, g.c1)))).collect()
    } else {
        (0..g.cols().min(cols.saturating_sub(g.c1))).map_while(|j| (!e.leaving()).then(|| e.value((g.s, g.r1, g.c1 + j)))).collect()
    }
}

/// Days since 1970 to a year, a month counted from nothing, and a day, as JavaScript's
/// `Date.UTC` takes them: a month or a day outside its range runs on into the next or the
/// one before, and a year from 0 to 99 is in the 1900s.
fn utc_days(y: f64, m0: f64, d: f64) -> f64 {
    // two figures of a year are a year of the century round now, as Calc reads them and as a date typed is read: under 30 in the 2000s
    let y = if (0.0..30.0).contains(&y) { y + 2000.0 } else if (30.0..=99.0).contains(&y) { y + 1900.0 } else { y };
    let (y, m) = (y + (m0 / 12.0).floor(), m0.rem_euclid(12.0));
    crate::sheet::days_from_civil(y as i64, m as i64 + 1, 1) as f64 + d - 1.0
}

/// A day number as its year, month (from one) and day, on the document's null date.
fn date_of(e: &Engine, n: f64) -> (i64, i64, i64) {
    crate::sheet::civil_from_days(((n + 1e-9).floor() + e.null_date()) as i64)
}

/// The furthest day from 1970 a date can be: a hundred million days, as JavaScript's `Date`
/// has it. A day number past it is no date.
const DAYS_MOST: f64 = 1e8;

/// Whether a day number, on the document's null date, is a day a date can be.
fn is_day(e: &Engine, n: f64) -> bool {
    (n + e.null_date()).abs() <= DAYS_MOST
}

/// The seconds this machine's clock is ahead of UTC.
// ponytail: asked of the `date` command once, since the standard library knows no time zones. UTC where there is no such command
pub(crate) fn zone_secs() -> f64 {
    static ZONE: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *ZONE.get_or_init(|| {
        let out = std::process::Command::new("date").arg("+%z").output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default();
        let t = out.trim();
        let digits = t.trim_start_matches(['+', '-']);
        match (digits.get(..2).and_then(|h| h.parse::<f64>().ok()), digits.get(2..4).and_then(|m| m.parse::<f64>().ok())) {
            (Some(h), Some(m)) => (h * 3600.0 + m * 60.0) * if t.starts_with('-') { -1.0 } else { 1.0 },
            _ => 0.0,
        }
    })
}

/// Now, by this machine's clock, as a day number with the time of day as its fraction.
fn now(e: &Engine) -> f64 {
    let secs = crate::api::since_epoch().map_or(0.0, |d| d.as_secs() as f64) + zone_secs();
    secs / 86_400.0 - e.null_date()
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
                    // an empty cell and an empty text are the same to it
                    let empty = |x: &V| matches!(x, V::Blank | V::Missing) || *x == V::Str(String::new());
                    if (std::mem::discriminant(&w) == std::mem::discriminant(&v) && compare(&v, &w) == 0) || (empty(&v) && empty(&w)) {
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
pub fn call(e: &mut Engine, name: &str, a: &[V], ctx: Ctx) -> R {
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
                n(g.rows() as f64 * g.cols() as f64 - full as f64)
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
            let large = name == "LARGE";
            stat(e, &a[..a.len().min(1)], |mut ns| match k {
                V::Num(k) => {
                    // the place counted from the smallest, cut to a whole number: the 1.5th largest of seven is the
                    // 6.5th smallest, which is the 6th, as Calc has it
                    let at = if large { ns.len() as f64 - k + 1.0 } else { k }.floor();
                    if !(at >= 1.0 && at <= ns.len() as f64) {
                        return err(VALUE);
                    }
                    ns.sort_by(f64::total_cmp);
                    V::Num(ns[at as usize - 1])
                }
                bad => bad,
            })?
        }
        "RANK" => {
            let V::Num(v) = to_num(&scalar(e, &arg(0))) else { return Ok(to_num(&scalar(e, &arg(0)))) };
            let asc = a.get(2).is_some_and(|x| *x != V::Missing) && to_num(&scalar(e, &arg(2))) != V::Num(0.0);
            stat(e, a.get(1..a.len().min(2)).unwrap_or(&[]), |ns| if ns.contains(&v) { n(1.0 + ns.iter().filter(|x| if asc { **x < v } else { **x > v }).count() as f64) } else { err(VALUE) })?
        }
        "SUMIF" | "COUNTIF" | "AVERAGEIF" => {
            let Some(V::Range(test)) = a.first() else { return Ok(err(VALUE)) };
            let ok = criterion(e, &arg(1));
            let other = match a.get(2) {
                Some(V::Range(g)) if name != "COUNTIF" => Some(*g),
                _ => None,
            };
            let (mut ns, mut hits, mut bad) = (Vec::new(), 0usize, None);
            let walked = pairs(e, *test, other, &mut |v, w| {
                if ok(&v) {
                    hits += 1;
                    match w {
                        V::Err(_) if name == "SUMIF" => bad = Some(w),
                        V::Num(x) => ns.push(x),
                        V::Bool(b) => ns.push(f64::from(b)),
                        _ => {}
                    }
                }
            });
            walked?;
            match name {
                "COUNTIF" => n(hits as f64),
                "SUMIF" => bad.unwrap_or_else(|| n(ksum(&ns))),
                _ if ns.is_empty() => err(DIV0),
                _ => n(ksum(&ns) / ns.len() as f64),
            }
        }
        "SUMIFS" => ifs(e, a.first(), a.get(1..).unwrap_or(&[]), |acc, w| match w {
            V::Num(x) => acc + x,
            V::Bool(b) => acc + f64::from(*b),
            _ => acc,
        }),
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
                    if e.leaving() {
                        return Err(Unsupported);
                    }
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
        "INT" => num1!(|x| V::Num(approx_floor(x))),
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
        // past 170 it is more than a number can hold, and is not counted up to
        "FACT" => num1!(|x| if x < 0.0 { err(ARG) } else if x > 170.0 { fin(f64::INFINITY) } else { fin((2..=x.floor() as u64).fold(1.0, |f, i| f * i as f64)) }),
        "CEILING" | "FLOOR" => {
            // a third argument that is not nought rounds a negative number by its size: away from nought for CEILING
            let by_size = a.get(2).is_some_and(|x| !matches!(x, V::Missing | V::Blank)) && to_num(&scalar(e, &arg(2))) != V::Num(0.0);
            let x = to_num(&scalar(e, &arg(0)));
            // with no step given it is one, of the number's own sign
            let s = to_num(&scalar(e, &or(1, if matches!(x, V::Num(x) if x < 0.0) { -1.0 } else { 1.0 })));
            match (x, s) {
                (V::Num(x), V::Num(s)) if x == 0.0 || s == 0.0 => V::Num(0.0),
                // a number and a step of unlike signs: Calc's error for an argument it cannot take
                (V::Num(x), V::Num(s)) if (x < 0.0) != (s < 0.0) => err(ILLEGAL),
                (V::Num(x), V::Num(s)) => {
                    // the quotient is above nought. It is rounded up for CEILING of a number above nought, and for one
                    // below it the other way, so that the answer is the larger number, unless it is rounded by size
                    let up = (name == "CEILING") == (x > 0.0 || by_size);
                    V::Num(if up { (x / s - 1e-12).ceil() * s } else { (x / s + 1e-12).floor() * s })
                }
                (V::Num(_), bad) | (bad, _) => bad,
            }
        }
        "MROUND" => num2!(arg(1), |x, s| V::Num(if s == 0.0 { 0.0 } else { round(x / s, 0.0, b'r') * s })),
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
                        // a letter after the start, or after what is not a letter, a figure too, is a capital: 3Rd, A1B2C
                        let mut up = true;
                        V::Str(s.to_lowercase().chars().flat_map(|c| {
                            let out: Vec<char> = if up && c.is_alphabetic() { c.to_uppercase().collect() } else { vec![c] };
                            up = !c.is_alphabetic();
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
                                if e.leaving() {
                                    return Err(Unsupported);
                                }
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
                // nothing to look for is not found
                (None, V::Num(_)) if to_str(&needle).is_empty() => err(VALUE),
                // SEARCH takes `*` and `?` for others: the first place from which the text goes on as the pattern says
                (None, V::Num(st)) if name == "SEARCH" && wildcards(&to_str(&needle)) => {
                    let (mut pat, hy): (Vec<char>, Vec<char>) = (to_str(&needle).to_lowercase().chars().collect(), to_str(&hay).to_lowercase().chars().collect());
                    pat.push('*');
                    // places are counted in UTF-16 units, as the plain search counts them
                    let (mut at, mut found) = (0usize, None);
                    for (i, c) in hy.iter().enumerate() {
                        if at as f64 >= st.floor() - 1.0 && wild(&pat, &hy[i..]) {
                            found = Some(at);
                            break;
                        }
                        at += c.len_utf16();
                    }
                    found.map_or(err(VALUE), |at| n(at as f64 + 1.0))
                }
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
            // the one named: the first, the second. The first is 1, and a fraction is cut off: there is none before the first
            let k = if a.get(3).is_none_or(|x| *x == V::Missing) {
                None
            } else {
                match to_num(&scalar(e, &arg(3))) {
                    V::Num(k) if k < 1.0 => return Ok(err(ILLEGAL)),
                    V::Num(k) => Some(k.floor()),
                    bad => return Ok(bad),
                }
            };
            if f.is_empty() {
                return Ok(V::Str(s));
            }
            // counted as JavaScript counts, in UTF-16 units
            let Some(k) = k else { return Ok(V::Str(s.replace(&f, &t))) };
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
                // the first character is 1, and a count is not below nought
                (None, V::Num(st), V::Num(k)) if st < 1.0 || k < 0.0 => err(ILLEGAL),
                (None, V::Num(st), V::Num(k)) => {
                    let (st, k) = (st.floor(), k.floor());
                    let ch: Vec<char> = to_str(&s).chars().collect();
                    V::Str(slice(&ch, 0.0, st - 1.0).into_iter().collect::<String>() + &to_str(&w) + &slice(&ch, st - 1.0 + k, f64::INFINITY).into_iter().collect::<String>())
                }
                _ => err(VALUE),
            }
        }
        "VALUE" => {
            let v = scalar(e, &arg(0));
            let got = match &v {
                // a comma groups the figures before the point in threes, the first group of any length: 1234,567
                // is 1234567, and 1,5 is not 15
                V::Str(s) => {
                    let t = s.trim();
                    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
                    let whole = &body[..body.find(['.', 'e', 'E']).unwrap_or(body.len())];
                    let mut groups = whole.split(',');
                    let grouped = groups.next().is_some_and(|g| !g.is_empty() && g.bytes().all(|b| b.is_ascii_digit())) && groups.all(|g| g.len() == 3);
                    if (whole.contains(',') && !grouped) || body[whole.len()..].contains(',') { err(VALUE) } else { to_num(&V::Str(s.replace(',', ""))) }
                }
                other => to_num(other),
            };
            // text that is no number is Calc's own error for it
            if got == err(VALUE) { err(ILLEGAL) } else { got }
        }
        "CHAR" => num1!(|x| if !(1.0..=255.0).contains(&x) { err(ARG) } else { V::Str(char::from_u32(x as u32).map_or(String::new(), String::from)) }),

        // lookup
        "VLOOKUP" | "HLOOKUP" => {
            let Some(V::Range(g)) = a.get(1).copied_range() else { return Ok(err(VALUE)) };
            let down = name == "VLOOKUP";
            let V::Num(at) = to_num(&scalar(e, &arg(2))) else { return Ok(to_num(&scalar(e, &arg(2)))) };
            if at < 1.0 || at > if down { g.cols() } else { g.rows() } as f64 {
                return Ok(err(ILLEGAL));
            }
            let exact = a.get(3).is_some_and(|x| *x != V::Missing) && to_num(&scalar(e, &arg(3))) == V::Num(0.0);
            let vec = line(e, g, down);
            match lookup(e, &arg(0), &vec, exact) {
                Err(bad) => bad,
                Ok(i) if down => e.value((g.s, g.r1 + i, g.c1 + at.floor() as usize - 1)),
                Ok(j) => e.value((g.s, g.r1 + at.floor() as usize - 1, g.c1 + j)),
            }
        }
        "MATCH" => {
            let Some(V::Range(g)) = a.get(1).copied_range().filter(|g| matches!(g, V::Range(g) if g.rows() == 1 || g.cols() == 1)) else { return Ok(err(NA)) };
            let how = if a.get(2).is_none_or(|x| *x == V::Missing) { V::Num(1.0) } else { to_num(&scalar(e, &arg(2))) };
            let V::Num(how) = how else { return Ok(how) };
            let vec = line(e, g, g.cols() == 1);
            if how < 0.0 {
                // sorted downwards: the last entry not less than what is looked for
                let needle = scalar(e, &arg(0));
                let hit = vec.iter().take_while(|v| kind(v) != 0 && kind(v) == kind(&needle) && compare(v, &needle) >= 0).count();
                return Ok(if hit == 0 { err(NA) } else { n(hit as f64) });
            }
            match lookup(e, &arg(0), &vec, how == 0.0) {
                Ok(i) => n(i as f64 + 1.0),
                Err(bad) => bad,
            }
        }
        "INDEX" => {
            let Some(V::Range(g)) = a.first().copied_range() else { return Ok(err(VALUE)) };
            let given = |i: usize| a.get(i).is_some_and(|x| *x != V::Missing);
            let r = if given(1) { to_num(&scalar(e, &arg(1))) } else { V::Num(0.0) };
            let c = if given(2) { to_num(&scalar(e, &arg(2))) } else { V::Num(0.0) };
            let (V::Num(mut r), V::Num(mut c)) = (r.clone(), c.clone()) else { return Ok(if is_err(&r) { r } else { c }) };
            // one number into a single row is a column of it
            if g.rows() == 1 && !given(2) && r > 0.0 {
                (c, r) = (r, 1.0);
            }
            if r == 0.0 && g.rows() == 1 {
                r = 1.0;
            }
            if c == 0.0 && g.cols() == 1 {
                c = 1.0;
            }
            if r < 0.0 || c < 0.0 || r >= g.rows() as f64 + 1.0 || c >= g.cols() as f64 + 1.0 {
                return Ok(err("#REF!"));
            }
            // nought for the row or the column is all of them: a whole column, a whole row, or the range itself
            if r < 1.0 || c < 1.0 {
                let (r, c) = (r.floor() as usize, c.floor() as usize);
                let (r1, r2) = if r == 0 { (g.r1, g.r2) } else { (g.r1 + r - 1, g.r1 + r - 1) };
                let (c1, c2) = if c == 0 { (g.c1, g.c2) } else { (g.c1 + c - 1, g.c1 + c - 1) };
                return Ok(V::Range(Rg { r1, r2, c1, c2, ..g }));
            }
            e.value((g.s, g.r1 + r.floor() as usize - 1, g.c1 + c.floor() as usize - 1))
        }
        "CHOOSE" => match to_num(&scalar(e, &arg(0))) {
            V::Num(k) if k < 1.0 || k >= a.len() as f64 => err(ILLEGAL),
            // a range chosen is handed on whole, for a function round this one to take
            V::Num(k) => match arg(k.floor() as usize) {
                V::Range(g) if g.r1 != g.r2 || g.c1 != g.c2 => V::Range(g),
                one => scalar(e, &one),
            },
            bad => bad,
        },
        "ROW" | "COLUMN" => match a.first() {
            Some(V::Range(g)) => n(if name == "ROW" { g.r1 } else { g.c1 } as f64 + 1.0),
            Some(_) => err(VALUE),
            None => n(if name == "ROW" { ctx.r } else { ctx.c } as f64 + 1.0),
        },
        "ROWS" | "COLUMNS" => match a.first() {
            Some(V::Range(g)) => n(if name == "ROWS" { g.rows() } else { g.cols() } as f64),
            _ => n(1.0),
        },

        // dates and times
        // with one of the three left off the end there is no date to make, as on the web
        "DATE" | "TIME" if a.len() < 3 => a.iter().map(|x| to_num(&scalar(e, x))).find(is_err).unwrap_or_else(|| err("#NUM!")),
        "DATE" | "TIME" => {
            let v: Vec<V> = (0..3).map(|i| to_num(&scalar(e, &arg(i)))).collect();
            match (&v[0], &v[1], &v[2]) {
                (V::Num(x), V::Num(y), V::Num(z)) if name == "DATE" => {
                    // a year, a month or a day past any calendar makes no date
                    let days = utc_days(x.floor(), y.floor() - 1.0, z.floor());
                    if x.abs() <= 1e9 && y.abs() <= 1e9 && days.abs() <= DAYS_MOST { n(days - e.null_date()) } else { err("#NUM!") }
                }
                (V::Num(h), V::Num(m), V::Num(s)) => {
                    let t = (h * 3600.0 + m * 60.0 + s) / 86_400.0;
                    n(t - t.floor())
                }
                _ => v.into_iter().find(is_err).unwrap_or_else(|| err(VALUE)),
            }
        }
        "YEAR" | "MONTH" | "DAY" => match to_num(&scalar(e, &arg(0))) {
            V::Num(x) if !is_day(e, x) => err("#NUM!"),
            V::Num(x) => {
                let (y, m, d) = date_of(e, x);
                n(match name {
                    "YEAR" => y,
                    "MONTH" => m,
                    _ => d,
                } as f64)
            }
            bad => bad,
        },
        "HOUR" => num1!(|x| V::Num(clock(x).0)),
        "MINUTE" => num1!(|x| V::Num(clock(x).1)),
        "SECOND" => num1!(|x| V::Num(clock(x).2)),
        "WEEKDAY" => {
            let (x, how) = (to_num(&scalar(e, &arg(0))), if a.get(1).is_none_or(|v| *v == V::Missing) { V::Num(1.0) } else { to_num(&scalar(e, &arg(1))) });
            match (x, how) {
                (V::Num(x), V::Num(how)) => {
                    // 0 is Sunday. The first day of 1970 was a Thursday
                    let d = (((x + 1e-9).floor() + e.null_date()) + 4.0).rem_euclid(7.0);
                    // 11 to 17 count from 1 on a Monday, a Tuesday and so on to a Sunday
                    let from = how.trunc() - 11.0;
                    n(if how == 2.0 {
                        (d + 6.0) % 7.0 + 1.0
                    } else if how == 3.0 {
                        (d + 6.0) % 7.0
                    } else if (0.0..=6.0).contains(&from) {
                        (d - 1.0 - from).rem_euclid(7.0) + 1.0
                    } else {
                        d + 1.0
                    })
                }
                (V::Num(_), bad) | (bad, _) => bad,
            }
        }
        "DAYS" => num2!(arg(1), |end, start| V::Num(end - start)),
        "EDATE" | "EOMONTH" => {
            let (x, m) = (to_num(&scalar(e, &arg(0))), to_num(&scalar(e, &arg(1))));
            match (x, m) {
                (V::Num(x), V::Num(m)) if !is_day(e, x) || m.abs() > 1e9 => err("#NUM!"),
                (V::Num(x), V::Num(m)) => {
                    let (y, mo, d) = date_of(e, x);
                    let mo = (mo - 1) as f64 + m.trunc();
                    // the last day of the month it lands in: the day before the next month's first
                    let last = crate::sheet::civil_from_days(utc_days(y as f64, mo + 1.0, 0.0) as i64).2 as f64;
                    n(if name == "EDATE" { utc_days(y as f64, mo, (d as f64).min(last)) } else { utc_days(y as f64, mo + 1.0, 0.0) } - e.null_date())
                }
                (V::Num(_), bad) | (bad, _) => bad,
            }
        }
        "TODAY" => n(now(e).floor()),
        "NOW" => n((now(e) * 86_400.0).floor() / 86_400.0),
        _ => return Err(Unsupported),
    })
}

/// An argument as a range, when it is one.
trait AsRange {
    fn copied_range(self) -> Option<V>;
}

impl AsRange for Option<&V> {
    fn copied_range(self) -> Option<V> {
        self.filter(|v| matches!(v, V::Range(_))).cloned()
    }
}
