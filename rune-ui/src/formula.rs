//! OpenFormula as a flat ODS stores it, and as a person types it: a port
//! of the web client's `ui-src/sheet/formula.js`.
//!
//! A cell's formula is stored as  `of:=SUM([.A1:.A3];[$'My Sheet'.B2])`
//! and shown and typed as         `=SUM(A1:A3,'My Sheet'.B2)`.
//!
//! One tokenizer reads both spellings, one parser builds the tree, and
//! one printer writes it back in either.

pub const ERRORS: [&str; 7] = ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#NULL!"];

/// Functions newer than ODF 1.2 are stored under a vendor prefix.
const OF_NAME: [(&str, &str); 10] = [
    ("IFS", "COM.MICROSOFT.IFS"), ("SWITCH", "COM.MICROSOFT.SWITCH"), ("TEXTJOIN", "COM.MICROSOFT.TEXTJOIN"), ("CONCAT", "COM.MICROSOFT.CONCAT"), ("MAXIFS", "COM.MICROSOFT.MAXIFS"),
    ("MINIFS", "COM.MICROSOFT.MINIFS"), ("STDEV.S", "COM.MICROSOFT.STDEV.S"), ("STDEV.P", "COM.MICROSOFT.STDEV.P"), ("VAR.S", "COM.MICROSOFT.VAR.S"), ("VAR.P", "COM.MICROSOFT.VAR.P"),
];

const MAX_COL: u32 = 16_384;
const MAX_ROW: u32 = 1_048_576;

/// Which spelling: as stored, or as typed.
#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Of,
    User,
}

/// One end of a reference.
#[derive(Clone, Debug, PartialEq)]
pub struct End {
    pub sheet: Option<String>,
    pub sheet_abs: bool,
    pub c: u32,
    pub c_abs: bool,
    pub r: u32,
    pub r_abs: bool,
}

/// A reference: to a cell, a range, whole columns or rows, cells that
/// were deleted, or one lattice does not read and keeps as written.
#[derive(Clone, Debug, PartialEq)]
pub enum Ref {
    Cells { a: End, b: Option<End>, full: Option<char> },
    Bad,
    Unknown(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Num(f64),
    Str(String),
    Bool(bool),
    Err(&'static str),
    Ref(Ref),
    Name(String),
    Missing,
    Paren(Box<Node>),
    Un(char, Box<Node>),
    Pct(Box<Node>),
    Bin(&'static str, Box<Node>, Box<Node>),
    Call(String, Vec<Node>),
}

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Err(&'static str),
    Ref(Ref),
    Name(String),
    Open,
    Close,
    Sep,
    Op(&'static str),
}

pub fn col_name(c: u32) -> String {
    let (mut s, mut n) = (Vec::new(), c + 1);
    while n > 0 {
        s.push(b'A' + ((n - 1) % 26) as u8);
        n = (n - 1) / 26;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

fn name_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c >= 'À'
}

fn name_char(c: char) -> bool {
    name_start(c) || c.is_ascii_digit()
}

fn quote_sheet(n: &str) -> String {
    let plain = n.chars().next().is_some_and(name_start) && n.chars().all(name_char);
    if plain { n.to_owned() } else { format!("'{}'", n.replace('\'', "''")) }
}

fn at(s: &[char], i: usize) -> char {
    s.get(i).copied().unwrap_or('\0')
}

/// An optional `$` and a sheet name, quoted or plain: the name, whether it is held, and where it ends.
fn read_sheet(s: &[char], i: usize) -> Option<(String, bool, usize)> {
    let mut j = i;
    let abs = at(s, j) == '$';
    if abs {
        j += 1;
    }
    let mut name = String::new();
    if at(s, j) == '\'' {
        let mut k = j + 1;
        loop {
            if k >= s.len() {
                return None;
            }
            if s[k] == '\'' {
                if at(s, k + 1) == '\'' {
                    name.push('\'');
                    k += 2;
                    continue;
                }
                break;
            }
            name.push(s[k]);
            k += 1;
        }
        j = k + 1;
    } else {
        if !name_start(at(s, j)) {
            return None;
        }
        while j < s.len() && name_char(s[j]) {
            name.push(s[j]);
            j += 1;
        }
    }
    Some((name, abs, j))
}

/// A cell's address, `$A$1` with either `$` or neither: column, held, row, held, and where it ends.
fn read_cell(s: &[char], i: usize) -> Option<(u32, bool, u32, bool, usize)> {
    let mut j = i;
    let c_abs = at(s, j) == '$';
    if c_abs {
        j += 1;
    }
    let letters = (0..3).take_while(|k| at(s, j + k).is_ascii_alphabetic()).count();
    if letters == 0 {
        return None;
    }
    let c = s[j..j + letters].iter().fold(0u32, |n, ch| n * 26 + (*ch as u32 & 31)) - 1;
    j += letters;
    let r_abs = at(s, j) == '$';
    if r_abs {
        j += 1;
    }
    let digits = (0..7).take_while(|k| at(s, j + k).is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    let row: u32 = s[j..j + digits].iter().collect::<String>().parse().ok()?;
    let r = row.checked_sub(1)?;
    (c < MAX_COL && r < MAX_ROW).then_some((c, c_abs, r, r_abs, j + digits))
}

/// An end as stored (`.A1`, `$Sheet.A1`) or as typed (`A1`, `Sheet.A1`, `'My Sheet'!A1`).
fn read_end(s: &[char], i: usize, mode: Mode) -> Option<(End, usize)> {
    let (mut sheet, mut sheet_abs, mut j) = (None, false, i);
    if mode == Mode::Of {
        if at(s, j) != '.' {
            let (name, abs, end) = read_sheet(s, j)?;
            if at(s, end) != '.' {
                return None;
            }
            (sheet, sheet_abs, j) = (Some(name), abs, end);
        }
        j += 1;
    } else if let Some((name, abs, end)) = read_sheet(s, j) {
        if matches!(at(s, end), '.' | '!') && read_cell(s, end + 1).is_some() {
            (sheet, sheet_abs, j) = (Some(name), abs, end + 1);
        }
    }
    let (c, c_abs, r, r_abs, end) = read_cell(s, j)?;
    Some((End { sheet, sheet_abs, c, c_abs, r, r_abs }, end))
}

fn print_end(e: &End, mode: Mode) -> String {
    let sheet = match &e.sheet {
        Some(n) => format!("{}{}.", if e.sheet_abs { "$" } else { "" }, quote_sheet(n)),
        None if mode == Mode::Of => ".".to_owned(),
        None => String::new(),
    };
    format!("{sheet}{}{}{}{}", if e.c_abs { "$" } else { "" }, col_name(e.c), if e.r_abs { "$" } else { "" }, e.r + 1)
}

pub fn print_ref(r: &Ref, mode: Mode) -> String {
    match r {
        // a reference to deleted cells is the bare error, as LibreOffice saves it
        Ref::Bad => "#REF!".into(),
        // one lattice could not read is written back exactly as it came
        Ref::Unknown(raw) => raw.clone(),
        Ref::Cells { a, b: Some(b), full: Some(full) } => {
            let end = |e: &End| if *full == 'c' { format!("{}{}", if e.c_abs { "$" } else { "" }, col_name(e.c)) } else { format!("{}{}", if e.r_abs { "$" } else { "" }, e.r + 1) };
            let sh = a.sheet.as_ref().map_or(String::new(), |n| format!("{}{}", if a.sheet_abs { "$" } else { "" }, quote_sheet(n)));
            match mode {
                Mode::Of => format!("[{sh}.{}:.{}]", end(a), end(b)),
                Mode::User => format!("{}{}:{}", if sh.is_empty() { String::new() } else { format!("{sh}.") }, end(a), end(b)),
            }
        }
        Ref::Cells { a, b, .. } => {
            let body = format!("{}{}", print_end(a, mode), b.as_ref().map_or(String::new(), |b| format!(":{}", print_end(b, mode))));
            if mode == Mode::Of { format!("[{body}]") } else { body }
        }
    }
}

/// Whole columns or rows, `[.A:.C]` or `[.2:.5]` as stored and `A:C` or
/// `2:5` as typed, perhaps naming a sheet. The whole of `body` must be one.
fn full_ref(body: &[char], mode: Mode) -> Option<Ref> {
    let (mut sheet, mut sheet_abs, mut rest) = (None, false, body);
    if mode == Mode::User || at(body, 0) != '.' {
        match read_sheet(body, 0) {
            Some((name, abs, end)) if at(body, end) == '.' || (mode == Mode::User && at(body, end) == '!') => {
                (sheet, sheet_abs) = (Some(name), abs);
                rest = &body[if mode == Mode::Of { end } else { end + 1 }..];
            }
            _ if mode == Mode::Of => return None,
            _ => {}
        }
    }
    // one side: the dot the stored spelling has, a `$` or not, then letters or digits
    let side = |s: &[char], i: usize, letters: bool| -> Option<(bool, String, usize)> {
        let mut j = i;
        if mode == Mode::Of {
            if at(s, j) != '.' {
                return None;
            }
            j += 1;
        }
        let abs = at(s, j) == '$';
        if abs {
            j += 1;
        }
        let ok = |c: char| if letters { c.is_ascii_alphabetic() } else { c.is_ascii_digit() };
        let n = (0..if letters { 3 } else { 7 }).take_while(|k| ok(at(s, j + k))).count();
        (n > 0).then(|| (abs, s[j..j + n].iter().collect(), j + n))
    };
    for letters in [true, false] {
        let Some((abs1, v1, e1)) = side(rest, 0, letters) else { continue };
        if at(rest, e1) != ':' {
            continue;
        }
        let Some((abs2, v2, e2)) = side(rest, e1 + 1, letters) else { continue };
        if e2 != rest.len() {
            continue;
        }
        let none = |c: u32, c_abs: bool, r: u32, r_abs: bool| End { sheet: None, sheet_abs: false, c, c_abs, r, r_abs };
        if letters {
            let col = |v: &str| v.chars().fold(0u32, |n, ch| n * 26 + (ch as u32 & 31)) - 1;
            let (c1, c2) = (col(&v1), col(&v2));
            if c1 >= MAX_COL || c2 >= MAX_COL {
                return None;
            }
            return Some(Ref::Cells { a: End { sheet, sheet_abs, ..none(c1, abs1, 0, false) }, b: Some(none(c2, abs2, MAX_ROW - 1, false)), full: Some('c') });
        }
        let (r1, r2) = (v1.parse::<u32>().ok()?.checked_sub(1)?, v2.parse::<u32>().ok()?.checked_sub(1)?);
        if r1 >= MAX_ROW || r2 >= MAX_ROW {
            return None;
        }
        return Some(Ref::Cells { a: End { sheet, sheet_abs, ..none(0, false, r1, abs1) }, b: Some(none(MAX_COL - 1, false, r2, abs2)), full: Some('r') });
    }
    None
}

/// A typed whole-column or whole-row reference starting at `s[i]`, and where it ends.
fn user_full(s: &[char], i: usize) -> Option<(Ref, usize)> {
    let mut j = i;
    if let Some((_, _, end)) = read_sheet(s, i) {
        if matches!(at(s, end), '.' | '!') {
            j = end + 1;
        }
    }
    let lim = (j + 20).min(s.len());
    let w = &s[j..lim];
    let run = |from: usize, letters: bool| {
        let mut k = from;
        if at(w, k) == '$' {
            k += 1;
        }
        let ok = |c: char| if letters { c.is_ascii_alphabetic() } else { c.is_ascii_digit() };
        let n = (0..if letters { 3 } else { 7 }).take_while(|x| ok(at(w, k + x))).count();
        (n > 0).then_some(k + n)
    };
    let len = [true, false].into_iter().find_map(|letters| {
        let a = run(0, letters)?;
        if at(w, a) != ':' {
            return None;
        }
        let b = run(a + 1, letters)?;
        // not the start of something longer: a name, a number, a call, another range
        let next = at(w, b);
        (!(next.is_ascii_alphanumeric() || matches!(next, '_' | '.' | '(' | ':'))).then_some(b)
    })?;
    let end = j + len;
    full_ref(&s[i..end], Mode::User).map(|r| (r, end))
}

/// The tokens of a formula's body, with no leading `=` or `of:=`.
fn tokenize(text: &str, mode: Mode) -> Result<Vec<Tok>, String> {
    let s: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < s.len() {
        let ch = s[i];
        if matches!(ch, ' ' | '\t' | '\n' | '\r') {
            i += 1;
            continue;
        }
        if ch == '"' {
            let mut v = String::new();
            i += 1;
            loop {
                if i >= s.len() {
                    return Err("a text that is not closed".into());
                }
                if s[i] == '"' {
                    if at(&s, i + 1) == '"' {
                        v.push('"');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                v.push(s[i]);
                i += 1;
            }
            out.push(Tok::Str(v));
            continue;
        }
        if mode == Mode::Of && ch == '[' {
            let close = (i..s.len()).find(|k| s[*k] == ']').ok_or("a reference that is not closed")?;
            let mut r = full_ref(&s[i + 1..close], Mode::Of);
            if let Some((a, end)) = read_end(&s, i + 1, Mode::Of) {
                if end == close {
                    r = Some(Ref::Cells { a, b: None, full: None });
                } else if s[end] == ':' {
                    if let Some((b, e2)) = read_end(&s, end + 1, Mode::Of).filter(|(_, e2)| *e2 == close) {
                        let _ = e2;
                        r = Some(Ref::Cells { a, b: Some(b), full: None });
                    }
                }
            }
            // what is left is a reference to deleted cells, which is the error it says it is, or one
            // lattice does not read. The second is no error: it is kept as written and never guessed at
            let r = r.unwrap_or_else(|| {
                let inner: String = s[i + 1..close].iter().collect();
                if inner.contains("#REF!") { Ref::Bad } else { Ref::Unknown(s[i..=close].iter().collect()) }
            });
            i = close + 1;
            out.push(Tok::Ref(r));
            continue;
        }
        if mode == Mode::User {
            // whole columns or rows come before the number, or 2:5 reads as the number 2 and a stray colon
            if let Some((r, end)) = user_full(&s, i) {
                i = end;
                out.push(Tok::Ref(r));
                continue;
            }
        }
        if ch.is_ascii_digit() || (ch == '.' && at(&s, i + 1).is_ascii_digit()) {
            let mut j = i;
            while at(&s, j).is_ascii_digit() {
                j += 1;
            }
            if at(&s, j) == '.' && (j > i || at(&s, j + 1).is_ascii_digit()) {
                j += 1;
                while at(&s, j).is_ascii_digit() {
                    j += 1;
                }
            }
            if matches!(at(&s, j), 'e' | 'E') {
                let mut k = j + 1;
                if matches!(at(&s, k), '+' | '-') {
                    k += 1;
                }
                if at(&s, k).is_ascii_digit() {
                    while at(&s, k).is_ascii_digit() {
                        k += 1;
                    }
                    j = k;
                }
            }
            let lit: String = s[i..j].iter().collect();
            out.push(Tok::Num(lit.parse().unwrap_or(0.0)));
            i = j;
            continue;
        }
        if ch == '#' {
            let rest: String = s[i..].iter().take(8).collect();
            let hit = ERRORS.iter().find(|e| rest.starts_with(**e)).ok_or("an unknown error value")?;
            i += hit.len();
            out.push(Tok::Err(hit));
            continue;
        }
        if mode == Mode::User {
            // a reference, unless it is a function's name, as LOG10 before a bracket is
            let more = |c: char, dot: bool| c.is_ascii_alphanumeric() || c == '_' || c == '(' || (dot && c == '.');
            if let Some((a, end)) = read_end(&s, i, Mode::User).filter(|(_, end)| !more(at(&s, *end), true)) {
                i = end;
                let mut b = None;
                if at(&s, i) == ':' {
                    if let Some((e, e2)) = read_end(&s, i + 1, Mode::User).filter(|(_, e2)| !more(at(&s, *e2), false)) {
                        (b, i) = (Some(e), e2);
                    }
                }
                // A1:A1048576 is the whole column, and is stored as one
                let full = match &b {
                    Some(q) if a.sheet.is_none() && q.sheet.is_none() => {
                        if a.r == 0 && q.r == MAX_ROW - 1 && !a.r_abs && !q.r_abs {
                            Some('c')
                        } else if a.c == 0 && q.c == MAX_COL - 1 && !a.c_abs && !q.c_abs {
                            Some('r')
                        } else {
                            None
                        }
                    }
                    _ => None,
                };
                out.push(Tok::Ref(Ref::Cells { a, b, full }));
                continue;
            }
        }
        if name_start(ch) {
            let mut j = i;
            while j < s.len() && (name_char(s[j]) || s[j] == '.') {
                j += 1;
            }
            out.push(Tok::Name(s[i..j].iter().collect()));
            i = j;
            continue;
        }
        i += 1;
        match ch {
            '(' => out.push(Tok::Open),
            ')' => out.push(Tok::Close),
            ';' => out.push(Tok::Sep),
            ',' if mode == Mode::User => out.push(Tok::Sep),
            '{' | '}' | '|' | '~' | '!' => return Err("arrays and range operators are not supported here".into()),
            _ => {
                let two: String = [ch, at(&s, i)].iter().collect();
                if let Some(op) = ["<>", "<=", ">="].into_iter().find(|o| *o == two) {
                    i += 1;
                    out.push(Tok::Op(op));
                } else if let Some(op) = ["+", "-", "*", "/", "^", "&", "=", "<", ">", "%"].into_iter().find(|o| o.starts_with(ch)) {
                    out.push(Tok::Op(op));
                } else {
                    return Err(format!("an unexpected character: {ch}"));
                }
            }
        }
    }
    Ok(out)
}

/// What a token is called when it turns up where it should not, in the web client's words.
fn said(t: &Tok) -> String {
    match t {
        Tok::Num(v) if *v != 0.0 => crate::sheet::num_attr(*v).replace('E', "e"),
        Tok::Num(_) => "num".into(),
        Tok::Str(v) if !v.is_empty() => v.clone(),
        Tok::Str(_) => "str".into(),
        Tok::Err(v) => (*v).into(),
        Tok::Ref(_) => "ref".into(),
        Tok::Name(v) => v.clone(),
        Tok::Open => "(".into(),
        Tok::Close => ")".into(),
        Tok::Sep => ";".into(),
        Tok::Op(v) => (*v).into(),
    }
}

/// Precedence, loosest first: comparison, `&`, `+ -`, `* /`, `^`. Then unary, then `%`.
const LEVELS: [&[&str]; 5] = [&["=", "<>", "<", ">", "<=", ">="], &["&"], &["+", "-"], &["*", "/"], &["^"]];

struct Parser {
    toks: Vec<Tok>,
    p: usize,
    depth: usize,
}

impl Parser {
    fn op(&self, any: &[&str]) -> Option<&'static str> {
        match self.toks.get(self.p) {
            Some(Tok::Op(v)) if any.contains(v) => Some(v),
            _ => None,
        }
    }

    fn level(&mut self, n: usize) -> Result<Node, String> {
        if n == LEVELS.len() {
            return self.unary();
        }
        let mut l = self.level(n + 1)?;
        while let Some(op) = self.op(LEVELS[n]) {
            self.p += 1;
            l = Node::Bin(op, Box::new(l), Box::new(self.level(n + 1)?));
        }
        Ok(l)
    }

    fn unary(&mut self) -> Result<Node, String> {
        if let Some(op) = self.op(&["-", "+"]) {
            self.p += 1;
            // a run of signs is a loop here, so a long one cannot overflow the stack
            self.depth += 1;
            if self.depth > 64 {
                return Err("nested too deep".into());
            }
            let x = self.unary()?;
            self.depth -= 1;
            return Ok(Node::Un(op.chars().next().unwrap_or('-'), Box::new(x)));
        }
        let mut x = self.primary()?;
        while self.op(&["%"]).is_some() {
            self.p += 1;
            x = Node::Pct(Box::new(x));
        }
        Ok(x)
    }

    fn primary(&mut self) -> Result<Node, String> {
        let k = self.toks.get(self.p).cloned().ok_or("the formula ends too soon")?;
        self.p += 1;
        let deeper = |d: &mut usize| {
            *d += 1;
            if *d > 64 { Err("nested too deep".to_owned()) } else { Ok(()) }
        };
        Ok(match k {
            Tok::Num(v) => Node::Num(v),
            Tok::Str(v) => Node::Str(v),
            Tok::Err(v) => Node::Err(v),
            Tok::Ref(r) => Node::Ref(r),
            Tok::Open => {
                deeper(&mut self.depth)?;
                let x = self.level(0)?;
                self.depth -= 1;
                if self.toks.get(self.p) != Some(&Tok::Close) {
                    return Err("a bracket that is not closed".into());
                }
                self.p += 1;
                Node::Paren(Box::new(x))
            }
            Tok::Name(name) => {
                if self.toks.get(self.p) == Some(&Tok::Open) {
                    self.p += 1;
                    deeper(&mut self.depth)?;
                    let mut args = Vec::new();
                    if self.toks.get(self.p) == Some(&Tok::Close) {
                        self.p += 1;
                    } else {
                        loop {
                            if matches!(self.toks.get(self.p), Some(Tok::Sep | Tok::Close)) {
                                args.push(Node::Missing);
                            } else {
                                args.push(self.level(0)?);
                            }
                            let n = self.toks.get(self.p).cloned().ok_or("a bracket that is not closed")?;
                            self.p += 1;
                            match n {
                                Tok::Close => break,
                                Tok::Sep => {}
                                _ => return Err("expected a separator".into()),
                            }
                            if self.toks.get(self.p) == Some(&Tok::Close) {
                                args.push(Node::Missing);
                                self.p += 1;
                                break;
                            }
                        }
                    }
                    self.depth -= 1;
                    let up = name.to_uppercase();
                    let user = OF_NAME.iter().find(|(_, of)| *of == up).map(|(u, _)| (*u).to_owned());
                    Node::Call(user.unwrap_or(up), args)
                } else {
                    match name.to_uppercase().as_str() {
                        "TRUE" => Node::Bool(true),
                        "FALSE" => Node::Bool(false),
                        _ => Node::Name(name),
                    }
                }
            }
            other => return Err(format!("unexpected {}", said(&other))),
        })
    }
}

/// The tree of a formula's body.
pub fn parse(text: &str, mode: Mode) -> Result<Node, String> {
    let mut p = Parser { toks: tokenize(text, mode)?, p: 0, depth: 0 };
    let tree = p.level(0)?;
    match p.toks.get(p.p) {
        Some(t) => Err(format!("unexpected {}", said(t))),
        None => Ok(tree),
    }
}

/// A tree as text, in either spelling.
pub fn print(n: &Node, mode: Mode) -> String {
    match n {
        Node::Num(v) => crate::sheet::num_attr(*v),
        Node::Str(v) => format!("\"{}\"", v.replace('"', "\"\"")),
        Node::Bool(v) => if *v { "TRUE()" } else { "FALSE()" }.into(),
        Node::Err(v) => (*v).into(),
        Node::Ref(r) => print_ref(r, mode),
        Node::Name(v) => v.clone(),
        Node::Missing => String::new(),
        Node::Paren(x) => format!("({})", print(x, mode)),
        Node::Un(op, x) => format!("{op}{}", print(x, mode)),
        Node::Pct(x) => format!("{}%", print(x, mode)),
        Node::Bin(op, l, r) => format!("{}{op}{}", print(l, mode), print(r, mode)),
        Node::Call(name, args) => {
            let name = if mode == Mode::Of { OF_NAME.iter().find(|(u, _)| u == name).map_or(name.as_str(), |(_, of)| of) } else { name.as_str() };
            format!("{name}({})", args.iter().map(|a| print(a, mode)).collect::<Vec<_>>().join(if mode == Mode::Of { ";" } else { "," }))
        }
    }
}

/// The body of a stored formula, without `of:=`, or `=`, an old spelling.
pub fn body_of(stored: &str) -> Option<&str> {
    if let Some(b) = stored.strip_prefix("of:=").or_else(|| stored.strip_prefix('=')) {
        return Some(b);
    }
    let (prefix, body) = stored.split_once(":=")?;
    (!prefix.is_empty() && prefix.bytes().all(|b| b.is_ascii_lowercase())).then_some(body)
}

/// A stored formula as the bar shows it. One lattice cannot read is shown as stored.
pub fn to_user(stored: &str) -> String {
    match body_of(stored) {
        None => stored.to_owned(),
        Some(body) => format!("={}", parse(body, Mode::Of).map_or(body.to_owned(), |t| print(&t, Mode::User))),
    }
}

/// What was typed as the stored formula, or why it cannot be read.
pub fn to_of(typed: &str) -> Result<String, String> {
    let t = typed.trim();
    let body = t.strip_prefix('=').ok_or("a formula starts with =")?;
    Ok(format!("of:={}", print(&parse(body, Mode::User)?, Mode::Of)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every line of the corpus is a formula and what `ui-src/sheet/formula.js`
    /// makes of it: `U` lines through `toUser`, `O` lines through `toOf`.
    #[test]
    fn formulas_read_and_print_as_the_web_client_does() {
        let corpus = include_str!("formula_corpus.tsv");
        let mut n = 0;
        for line in corpus.lines() {
            let p: Vec<&str> = line.split('\t').collect();
            let (input, want): (String, String) = (serde_json::from_str(p[1]).unwrap(), serde_json::from_str(p[2]).unwrap());
            let got = match p[0] {
                "U" => to_user(&input),
                _ => to_of(&input).unwrap_or_else(|e| format!("ERR {e}")),
            };
            assert_eq!(got, want, "{} {input}", p[0]);
            n += 1;
        }
        assert_eq!(n, 90);
    }

    #[test]
    fn what_is_typed_and_stored_again_is_the_same_formula() {
        for typed in ["=SUM(A1:A3,'My Sheet'.B2)*2", "=IF(A1>=10,\"a\"\"b\",-B2%)", "=$A$1:B$2", "=Data.A:A", "=2:5"] {
            let stored = to_of(typed).unwrap();
            assert_eq!(to_of(&to_user(&stored)).unwrap(), stored, "{typed}");
        }
        // deep nesting is refused, not overflowed
        assert_eq!(to_of(&format!("={}1{}", "(".repeat(70), ")".repeat(70))).unwrap_err(), "nested too deep");
        assert!(to_of(&format!("={}1", "-".repeat(5000))).is_err());
        assert_eq!((col_name(0), col_name(25), col_name(26), col_name(16_383)), ("A".into(), "Z".into(), "AA".into(), "XFD".into()));
    }
}
