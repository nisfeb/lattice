//! Vim keys for the source editor: the web client's own subset, read
//! key by key as `ui-src/lattice/27-vim.js` reads them, so the same keys
//! come to the same text and the same place in both. Normal, insert and
//! visual, motions with counts, `d` `c` `y` with a motion or doubled,
//! one unnamed register, and the `:` line, which only saves.
//!
//! The text is a row of characters and every place in it a count of
//! them, as the web's are counts into its textarea. Nothing here knows
//! the editor: it is given the text and the selection, changes them,
//! and says what else is asked for (a save, an undo).

/// Which keys mean what.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Mode {
    #[default]
    Normal,
    Insert,
    Visual,
}

/// The text and its selection, from `a` up to `b`. They are the same place when nothing is selected.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Buf {
    pub text: Vec<char>,
    pub a: usize,
    pub b: usize,
}

/// What a key came to, beside what it did to the text.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Out {
    /// The key was vim's. When it was not, the editor types it as it would with vim off.
    pub taken: bool,
    /// `:w` and its like: save the page.
    pub save: bool,
    /// `u`, and Ctrl-R: the editor's own undo and redo, which this does not keep.
    pub undo: bool,
    pub redo: bool,
    /// Something to say: a `:` line that is no command.
    pub said: Option<String>,
}

/// The state between keys.
#[derive(Clone, Debug, Default)]
pub struct Vim {
    pub mode: Mode,
    /// An operator or a prefix waiting for what follows: `d c y g r f F t T`.
    pending: Option<char>,
    /// The count typed so far, as its digits.
    count: String,
    reg: Vec<char>,
    reg_linewise: bool,
    vis_anchor: i64,
    vis_caret: i64,
    /// The `:` line being typed, without its colon.
    cmd: Option<String>,
}

fn clamp(n: i64, lo: i64, hi: i64) -> i64 {
    if n < lo {
        lo
    } else if n > hi {
        hi
    } else {
        n
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Class {
    Nl,
    Sp,
    Word,
    Punct,
}

/// What an operator's motion covers.
enum Span {
    Chars(i64),
    Lines(i64, i64),
}

impl Buf {
    pub fn new(text: &str, at: usize) -> Buf {
        Buf { text: text.chars().collect(), a: at, b: at }
    }

    pub fn string(&self) -> String {
        self.text.iter().collect()
    }

    fn len(&self) -> i64 {
        self.text.len() as i64
    }

    fn at(&self, i: i64) -> Option<char> {
        usize::try_from(i).ok().and_then(|i| self.text.get(i).copied())
    }

    fn pos(&self) -> i64 {
        self.a as i64
    }

    fn set_pos(&mut self, p: i64) {
        let p = clamp(p, 0, self.len()) as usize;
        (self.a, self.b) = (p, p);
    }

    fn set_sel(&mut self, a: i64, b: i64) {
        (self.a, self.b) = (clamp(a, 0, self.len()) as usize, clamp(b, 0, self.len()) as usize);
    }

    fn line_start(&self, p: i64) -> i64 {
        let mut i = p.min(self.len());
        while i > 0 && self.at(i - 1) != Some('\n') {
            i -= 1;
        }
        i.max(0)
    }

    fn line_end(&self, p: i64) -> i64 {
        let mut i = p.max(0);
        while i < self.len() && self.at(i) != Some('\n') {
            i += 1;
        }
        i.min(self.len())
    }

    fn col(&self, p: i64) -> i64 {
        p - self.line_start(p)
    }

    /// In normal mode the cursor rests on a character, so the last place on a line is its last character, or its start when it is empty.
    fn line_last_col(&self, p: i64) -> i64 {
        let (s, e) = (self.line_start(p), self.line_end(p));
        if e > s {
            e - 1
        } else {
            s
        }
    }

    fn norm_clamp(&self, p: i64) -> i64 {
        let (ls, le) = (self.line_start(p), self.line_end(p));
        if le == ls {
            ls
        } else {
            clamp(p, ls, le - 1)
        }
    }

    fn first_non_blank(&self, p: i64) -> i64 {
        let (ls, le) = (self.line_start(p), self.line_end(p));
        let mut i = ls;
        while i < le && matches!(self.at(i), Some(' ' | '\t')) {
            i += 1;
        }
        if i < le {
            i
        } else {
            ls
        }
    }

    /// Puts `text` in place of what lies between two places, and the cursor at `caret`.
    fn replace(&mut self, a: i64, b: i64, text: &[char], caret: i64) {
        let (mut a, mut b) = (clamp(a, 0, self.len()), clamp(b, 0, self.len()));
        if a > b {
            std::mem::swap(&mut a, &mut b);
        }
        self.text.splice(a as usize..b as usize, text.iter().copied());
        self.set_pos(caret);
    }

    fn insert_at(&mut self, p: i64, text: &[char]) {
        self.replace(p, p, text, p + text.len() as i64);
    }

    fn delete(&mut self, a: i64, b: i64, caret: i64) {
        self.replace(a, b, &[], caret);
    }

    fn class(&self, i: i64) -> Class {
        match self.at(i) {
            None | Some('\n') => Class::Nl,
            Some(' ' | '\t') => Class::Sp,
            Some(c) if c.is_ascii_alphanumeric() || c == '_' => Class::Word,
            Some(_) => Class::Punct,
        }
    }

    fn blank(&self, i: i64) -> bool {
        matches!(self.class(i), Class::Sp | Class::Nl)
    }

    fn word_fwd(&self, mut p: i64, n: i64) -> i64 {
        let len = self.len();
        for _ in 0..n {
            if p >= len {
                break;
            }
            let cls = self.class(p);
            if !self.blank(p) {
                while p < len && self.class(p) == cls {
                    p += 1;
                }
            }
            while p < len && self.blank(p) {
                p += 1;
            }
        }
        clamp(p, 0, len)
    }

    fn word_back(&self, mut p: i64, n: i64) -> i64 {
        for _ in 0..n {
            if p <= 0 {
                break;
            }
            p -= 1;
            while p > 0 && self.blank(p) {
                p -= 1;
            }
            if p <= 0 {
                p = 0;
                break;
            }
            let cls = self.class(p);
            while p > 0 && self.class(p - 1) == cls {
                p -= 1;
            }
        }
        clamp(p, 0, self.len())
    }

    fn word_end(&self, mut p: i64, n: i64) -> i64 {
        let len = self.len();
        for _ in 0..n {
            if p >= len - 1 {
                p = (len - 1).max(0);
                break;
            }
            p += 1;
            while p < len && self.blank(p) {
                p += 1;
            }
            if p >= len {
                p = len - 1;
                break;
            }
            let cls = self.class(p);
            while p + 1 < len && self.class(p + 1) == cls {
                p += 1;
            }
        }
        clamp(p, 0, len)
    }

    /// `cw` is `ce`: to the end of the word, leaving the space after it.
    fn change_word_end(&self, p: i64, n: i64) -> i64 {
        if self.blank(p) {
            self.word_fwd(p, n)
        } else {
            clamp(self.word_end(p, n) + 1, p, self.len())
        }
    }

    /// Up or down by lines, keeping the column. In visual the place past a line's last character can be stood on.
    fn vertical(&self, p: i64, delta: i64, visual: bool) -> i64 {
        let (c, mut cur) = (self.col(p), p);
        if delta > 0 {
            for _ in 0..delta {
                let e = self.line_end(cur);
                if e >= self.len() {
                    break;
                }
                cur = e + 1;
            }
        } else {
            for _ in 0..-delta {
                let s = self.line_start(cur);
                if s == 0 {
                    break;
                }
                cur = self.line_start(s - 1);
            }
        }
        let ns = self.line_start(cur);
        let maxc = if visual { self.line_end(cur) } else { self.line_last_col(cur) };
        clamp(ns + c, ns, maxc)
    }

    fn para_fwd(&self, p: i64, n: i64) -> i64 {
        let (len, mut i) = (self.len(), p);
        for _ in 0..n {
            let e = self.line_end(i);
            i = if e >= len { len } else { e + 1 };
            while i < len {
                let (ls, le) = (self.line_start(i), self.line_end(i));
                if le == ls {
                    break;
                }
                i = if le >= len { len } else { le + 1 };
            }
        }
        clamp(i, 0, len)
    }

    fn para_back(&self, p: i64, n: i64) -> i64 {
        let mut i = p;
        for _ in 0..n {
            let s = self.line_start(i);
            i = if s > 0 { s - 1 } else { 0 };
            i = self.line_start(i);
            while i > 0 {
                let (ls, le) = (self.line_start(i), self.line_end(i));
                if le == ls {
                    break;
                }
                i = self.line_start(i - 1);
            }
        }
        clamp(i, 0, self.len())
    }

    /// `f F t T`, within the line.
    fn find_char(&self, p: i64, ch: char, forward: bool, till: bool) -> Option<i64> {
        let (ls, le) = (self.line_start(p), self.line_end(p));
        if forward {
            (p + 1..le).find(|&i| self.at(i) == Some(ch)).map(|i| if till { i - 1 } else { i })
        } else {
            (ls..p).rev().find(|&j| self.at(j) == Some(ch)).map(|j| if till { j + 1 } else { j })
        }
    }

    fn last_line_start(&self) -> i64 {
        self.line_start(self.len())
    }

    /// The first character that is not a blank on a line, counted from one.
    fn goto_line(&self, line_no: i64) -> i64 {
        if line_no <= 1 {
            return self.first_non_blank(0);
        }
        let (mut idx, mut cur) = (0, 1);
        while cur < line_no {
            let nl = self.line_end(idx);
            if nl >= self.len() {
                return self.first_non_blank(self.line_start(self.len()));
            }
            idx = nl + 1;
            cur += 1;
        }
        self.first_non_blank(idx)
    }

    /// From the start of the line `p` is on, over `cnt` whole lines, the last one's newline with them when it has one.
    fn line_span(&self, p: i64, cnt: i64) -> (i64, i64) {
        let start = self.line_start(p);
        let mut end = start;
        for _ in 0..cnt {
            let le = self.line_end(end);
            if le < self.len() {
                end = le + 1;
            } else {
                end = le;
                break;
            }
        }
        (start, end)
    }

    fn count_lines(&self, a: i64, b: i64) -> i64 {
        (a.min(b)..a.max(b)).filter(|&i| self.at(i) == Some('\n')).count() as i64
    }
}

impl Vim {
    /// What shows of the state: the mode, with the count and the operator waiting, or the `:` line.
    pub fn indicator(&self) -> String {
        if let Some(c) = &self.cmd {
            return format!(":{c}");
        }
        let mut label = match self.mode {
            Mode::Insert => "-- INSERT --",
            Mode::Visual => "-- VISUAL --",
            Mode::Normal => "-- NORMAL --",
        }
        .to_owned();
        if self.pending.is_some() || !self.count.is_empty() {
            label.push(' ');
            label.push_str(&self.count);
            label.extend(self.pending);
        }
        label
    }

    /// Where the block is drawn: the character under the cursor, in normal and visual. `None` in insert, where the editor's own bar shows. And whether it is the underline of an `r` waiting for its character.
    pub fn block(&self, b: &Buf) -> Option<(usize, bool)> {
        match self.mode {
            Mode::Insert => None,
            Mode::Visual => Some((self.vis_caret.max(0) as usize, false)),
            Mode::Normal => Some((b.a, self.pending == Some('r'))),
        }
    }

    /// Keeps the cursor where the mode lets it be: when vim is turned on, and when the editor is entered.
    pub fn settle(&mut self, b: &mut Buf) {
        self.fix_caret(b);
    }

    fn eff(&self) -> i64 {
        // no more than a million: a count is how many times a thing is done, and past the end of the text more does nothing but hold the window, or overflow
        self.count.parse::<i64>().unwrap_or(if self.count.is_empty() { 1 } else { 1_000_000 }).clamp(1, 1_000_000)
    }

    fn reset(&mut self) {
        self.pending = None;
        self.count.clear();
    }

    fn fix_caret(&self, b: &mut Buf) {
        if self.mode == Mode::Insert {
            return;
        }
        let last = b.line_last_col(b.pos());
        if b.pos() > last {
            b.set_pos(last);
        }
    }

    fn yank(&mut self, b: &Buf, a: i64, e: i64, linewise: bool) {
        let (mut a, mut e) = (clamp(a, 0, b.len()), clamp(e, 0, b.len()));
        if a > e {
            std::mem::swap(&mut a, &mut e);
        }
        let mut text = b.text[a as usize..e as usize].to_vec();
        if linewise && text.last() != Some(&'\n') {
            text.push('\n');
        }
        (self.reg, self.reg_linewise) = (text, linewise);
    }

    fn to_insert(&mut self) {
        self.mode = Mode::Insert;
        self.reset();
    }

    fn to_normal(&mut self, b: &mut Buf) {
        if self.mode == Mode::Insert {
            // leaving insert steps back one, as vim does
            let p = b.pos();
            if p > b.line_start(p) {
                b.set_pos(p - 1);
            }
        }
        self.mode = Mode::Normal;
        self.reset();
        self.fix_caret(b);
    }

    fn vis_range(&self, b: &Buf) -> (i64, i64) {
        let (lo, hi) = (self.vis_anchor.min(self.vis_caret), self.vis_anchor.max(self.vis_caret) + 1);
        (lo, clamp(hi, 0, b.len()))
    }

    fn vis_sync(&self, b: &mut Buf) {
        if self.mode == Mode::Visual {
            let (lo, hi) = self.vis_range(b);
            b.set_sel(lo, hi);
        }
    }

    fn linewise_delete(&mut self, b: &mut Buf, p: i64, cnt: i64) {
        let (mut a, e) = b.line_span(p, cnt);
        self.yank(b, a, e, true);
        // the last line: the newline before it goes too, so no empty line is left
        if e >= b.len() && a > 0 && b.at(a - 1) == Some('\n') {
            a -= 1;
        }
        b.delete(a, e, 0);
        b.set_pos(b.first_non_blank(clamp(a, 0, b.len())));
    }

    fn linewise_change(&mut self, b: &mut Buf, p: i64, cnt: i64) {
        let (a, e) = b.line_span(p, cnt);
        self.yank(b, a, e, true);
        // one line is kept, empty
        let to = if e > a && b.at(e - 1) == Some('\n') { e - 1 } else { e };
        b.delete(a, to, a);
        b.set_pos(a);
        self.to_insert();
    }

    fn paste(&mut self, b: &mut Buf, after: bool) {
        if self.reg.is_empty() {
            return;
        }
        let p = b.pos();
        if self.reg_linewise {
            let mut text = self.reg.clone();
            if text.last() != Some(&'\n') {
                text.push('\n');
            }
            if after {
                let le = b.line_end(p);
                if le >= b.len() {
                    // the last line, with no newline of its own: one goes before, and the register's own is left off
                    text.pop();
                    text.insert(0, '\n');
                    b.insert_at(b.len(), &text);
                    b.set_pos(b.first_non_blank(b.line_start(b.len())));
                } else {
                    b.insert_at(le + 1, &text);
                    b.set_pos(b.first_non_blank(le + 1));
                }
            } else {
                let ls = b.line_start(p);
                b.insert_at(ls, &text);
                b.set_pos(b.first_non_blank(ls));
            }
        } else {
            let at = if after { if b.len() == 0 || b.at(p) == Some('\n') { p } else { p + 1 } } else { p };
            let reg = self.reg.clone();
            b.insert_at(at, &reg);
            b.set_pos(b.norm_clamp(at + reg.len() as i64 - 1));
        }
    }

    fn operator_motion(&self, b: &Buf, op: char, key: &str, n: i64) -> Option<Span> {
        let p = b.pos();
        Some(match key {
            "w" => Span::Chars(if op == 'c' { b.change_word_end(p, n) } else { b.word_fwd(p, n) }),
            "b" => Span::Chars(b.word_back(p, n)),
            "e" => Span::Chars(b.word_end(p, n) + 1),
            "h" => Span::Chars(b.line_start(p).max(p - n)),
            "l" | " " => Span::Chars(b.line_end(p).min(p + n)),
            "0" => Span::Chars(b.line_start(p)),
            "^" => Span::Chars(b.first_non_blank(p)),
            "$" => Span::Chars(b.line_end(b.vertical(p, n - 1, self.mode == Mode::Visual))),
            "j" => Span::Lines(p, n + 1),
            "k" => {
                let mut top = p;
                for _ in 0..n {
                    let ls = b.line_start(top);
                    if ls == 0 {
                        break;
                    }
                    top = b.line_start(ls - 1);
                }
                Span::Lines(top, b.count_lines(top, p) + 1)
            }
            "G" => {
                let dest = if self.count.is_empty() { b.last_line_start() } else { b.line_start(b.goto_line(self.eff())) };
                let lo = p.min(dest);
                Span::Lines(lo, b.count_lines(lo, p.max(dest)) + 1)
            }
            _ => return None,
        })
    }

    fn apply_char_op(&mut self, b: &mut Buf, op: char, a: i64, e: i64) {
        let (a, e) = (a.min(e), a.max(e));
        self.yank(b, a, e, false);
        if op == 'y' {
            b.set_pos(b.norm_clamp(a));
            return;
        }
        b.delete(a, e, a);
        if op == 'c' {
            b.set_pos(a);
            self.to_insert();
        } else {
            self.fix_caret(b);
        }
    }

    fn apply_linewise_op(&mut self, b: &mut Buf, op: char, from: i64, cnt: i64) {
        match op {
            'y' => {
                let (a, e) = b.line_span(from, cnt);
                self.yank(b, a, e, true);
                b.set_pos(b.first_non_blank(b.line_start(from)));
            }
            'c' => {
                b.set_pos(from);
                self.linewise_change(b, from, cnt);
            }
            _ => self.linewise_delete(b, from, cnt),
        }
    }

    fn run_cmd(raw: &str, out: &mut Out) {
        let c = raw.trim();
        let c = c.strip_suffix('!').unwrap_or(c);
        match c {
            "w" | "wa" | "waq" | "wq" | "x" => out.save = true,
            "" => {}
            _ => out.said = Some(format!("not an editor command: :{c}")),
        }
    }

    fn cmd_key(&mut self, k: &str, ctrl: bool, out: &mut Out) {
        let Some(buf) = &mut self.cmd else { return };
        if k == "Escape" || (ctrl && k == "[") {
            self.cmd = None;
        } else if k == "Enter" {
            let c = self.cmd.take().unwrap_or_default();
            Self::run_cmd(&c, out);
        } else if k == "Backspace" {
            // a backspace past the colon leaves the line
            if buf.pop().is_none() {
                self.cmd = None;
            }
        } else if k.chars().count() == 1 && !ctrl {
            buf.push_str(k);
        }
    }

    /// One key. `k` is a character, or a key's name as a browser gives it
    /// (`Escape`, `Enter`, `Backspace`, `ArrowLeft`), and `ctrl` whether
    /// Ctrl or Cmd is held.
    pub fn key(&mut self, b: &mut Buf, k: &str, ctrl: bool) -> Out {
        let mut out = Out::default();
        // the app's own chords are never vim's: save, and the palette
        if ctrl && matches!(k, "s" | "S" | "k" | "K") {
            return out;
        }
        if self.mode == Mode::Insert {
            if k == "Escape" || (ctrl && k == "[") {
                self.to_normal(b);
                out.taken = true;
            }
            return out;
        }
        out.taken = true;
        if self.cmd.is_some() {
            self.cmd_key(k, ctrl, &mut out);
            return out;
        }
        // a chord vim does not bind is the app's
        if ctrl && !matches!(k, "r" | "R" | "[") {
            out.taken = false;
            return out;
        }
        self.handle(b, k, ctrl, &mut out);
        out
    }

    fn handle(&mut self, b: &mut Buf, k: &str, ctrl: bool, out: &mut Out) {
        let one = {
            let mut cs = k.chars();
            match (cs.next(), cs.next()) {
                (Some(c), None) => Some(c),
                _ => None,
            }
        };
        if k == "Escape" || (ctrl && k == "[") {
            if self.mode == Mode::Visual {
                self.mode = Mode::Normal;
                b.set_pos(b.norm_clamp(b.pos()));
            }
            self.reset();
            return;
        }
        if ctrl && matches!(k, "r" | "R") {
            out.redo = true;
            self.reset();
            self.fix_caret(b);
            return;
        }
        // one character is waited for: r, and f F t T
        if self.pending == Some('r') {
            let n = self.eff();
            self.pending = None;
            if let Some(c) = one {
                let p = b.pos();
                if p + n <= b.line_end(p) {
                    b.replace(p, p + n, &vec![c; n as usize], p + n - 1);
                }
            }
            self.count.clear();
            return;
        }
        if let Some(pend @ ('f' | 'F' | 't' | 'T')) = self.pending {
            let (fwd, till, n) = (matches!(pend, 'f' | 't'), matches!(pend, 't' | 'T'), self.eff());
            self.pending = None;
            if let Some(c) = one {
                let base = if self.mode == Mode::Visual { self.vis_caret } else { b.pos() };
                let mut target = base;
                for _ in 0..n {
                    match b.find_char(target, c, fwd, till) {
                        Some(r) => target = r,
                        None => {
                            target = base;
                            break;
                        }
                    }
                }
                if target != base {
                    if self.mode == Mode::Visual {
                        self.vis_caret = target;
                        self.vis_sync(b);
                    } else {
                        b.set_pos(target);
                        self.fix_caret(b);
                    }
                }
            }
            self.count.clear();
            return;
        }
        if self.pending == Some('g') {
            self.pending = None;
            if k == "g" {
                let dest = if self.count.is_empty() { b.first_non_blank(0) } else { b.goto_line(self.eff()) };
                if self.mode == Mode::Visual {
                    self.vis_caret = dest;
                    self.vis_sync(b);
                } else {
                    b.set_pos(dest);
                    self.fix_caret(b);
                }
            }
            self.count.clear();
            return;
        }
        // digits make the count. A 0 with none begun is the motion
        if let Some(d) = one.filter(|c| c.is_ascii_digit()) {
            if !(d == '0' && self.count.is_empty()) {
                self.count.push(d);
                return;
            }
        }
        let n = self.eff();
        if let Some(op @ ('d' | 'c' | 'y')) = self.pending {
            // doubled, it is the line
            if one == Some(op) {
                self.reset();
                self.apply_linewise_op(b, op, b.pos(), n);
                return;
            }
            let mv = self.operator_motion(b, op, k, n);
            self.reset();
            match mv {
                None => {}
                Some(Span::Lines(from, cnt)) => self.apply_linewise_op(b, op, from, cnt),
                Some(Span::Chars(end)) => self.apply_char_op(b, op, b.pos(), end),
            }
            return;
        }
        if self.mode == Mode::Visual {
            self.visual(b, k, n);
            return;
        }
        self.normal(b, k, n, out);
    }

    fn visual(&mut self, b: &mut Buf, k: &str, n: i64) {
        let (vc, len) = (self.vis_caret, b.len());
        let moved = match k {
            "h" | "ArrowLeft" => Some(clamp(vc - n, 0, len)),
            "l" | "ArrowRight" | " " => Some(clamp(vc + n, 0, len)),
            "j" | "ArrowDown" => Some(b.vertical(vc, n, true)),
            "k" | "ArrowUp" => Some(b.vertical(vc, -n, true)),
            "w" => Some(b.word_fwd(vc, n)),
            "b" => Some(b.word_back(vc, n)),
            "e" => Some(b.word_end(vc, n)),
            "0" => Some(b.line_start(vc)),
            "^" => Some(b.first_non_blank(vc)),
            // on the last character, not the newline, so v$d keeps the line's break
            "$" => Some(b.line_last_col(vc)),
            "{" => Some(b.para_back(vc, n)),
            "}" => Some(b.para_fwd(vc, n)),
            "G" => Some(if self.count.is_empty() { b.first_non_blank(b.last_line_start()) } else { b.goto_line(n) }),
            "g" | "f" | "F" | "t" | "T" => {
                self.pending = k.chars().next();
                return;
            }
            _ => None,
        };
        if let Some(m) = moved {
            self.vis_caret = clamp(m, 0, len);
            self.vis_sync(b);
            self.reset();
            return;
        }
        let (a, e) = self.vis_range(b);
        match k {
            "d" | "x" => {
                self.yank(b, a, e, false);
                b.delete(a, e, a);
                self.mode = Mode::Normal;
                b.set_pos(b.norm_clamp(a));
                self.reset();
            }
            "c" | "s" => {
                self.yank(b, a, e, false);
                b.delete(a, e, a);
                self.mode = Mode::Normal;
                b.set_pos(a);
                self.to_insert();
            }
            "y" => {
                self.yank(b, a, e, false);
                self.mode = Mode::Normal;
                b.set_pos(b.norm_clamp(a));
                self.reset();
            }
            "p" => {
                // over the selection: the register is what it was before the delete
                b.delete(a, e, a);
                self.mode = Mode::Normal;
                if self.reg_linewise {
                    b.set_pos(if a > 0 { a - 1 } else { a });
                    self.paste(b, true);
                } else {
                    let reg = self.reg.clone();
                    b.insert_at(a, &reg);
                    b.set_pos(b.norm_clamp(a + reg.len() as i64 - 1));
                }
                self.reset();
            }
            "v" => {
                self.mode = Mode::Normal;
                b.set_pos(b.norm_clamp(self.vis_caret));
                self.reset();
            }
            _ => self.reset(),
        }
    }

    fn normal(&mut self, b: &mut Buf, k: &str, n: i64, out: &mut Out) {
        let p = b.pos();
        match k {
            "h" | "ArrowLeft" => {
                b.set_pos(clamp(p - n, b.line_start(p), p));
                self.fix_caret(b);
            }
            "l" | "ArrowRight" | " " => b.set_pos(clamp(p + n, p, b.line_last_col(p))),
            "j" | "ArrowDown" => b.set_pos(b.vertical(p, n, false)),
            "k" | "ArrowUp" => b.set_pos(b.vertical(p, -n, false)),
            "w" => b.set_pos(b.norm_clamp(b.word_fwd(p, n))),
            "b" => b.set_pos(b.norm_clamp(b.word_back(p, n))),
            "e" => b.set_pos(b.norm_clamp(b.word_end(p, n))),
            "0" => b.set_pos(b.line_start(p)),
            "^" => b.set_pos(b.first_non_blank(p)),
            "$" => b.set_pos(b.line_last_col(b.vertical(p, n - 1, false))),
            "{" => b.set_pos(b.norm_clamp(b.para_back(p, n))),
            "}" => b.set_pos(b.norm_clamp(b.para_fwd(p, n))),
            "G" => b.set_pos(if self.count.is_empty() { b.first_non_blank(b.last_line_start()) } else { b.goto_line(n) }),
            "g" | "f" | "F" | "t" | "T" | "d" | "c" | "y" | "r" => {
                self.pending = k.chars().next();
                return;
            }
            "i" => self.to_insert(),
            "a" => {
                if b.line_end(p) > b.line_start(p) {
                    b.set_pos(p + 1);
                }
                self.to_insert();
            }
            "I" => {
                b.set_pos(b.first_non_blank(p));
                self.to_insert();
            }
            "A" => {
                b.set_pos(b.line_end(p));
                self.to_insert();
            }
            "o" => {
                let le = b.line_end(p);
                b.insert_at(le, &['\n']);
                b.set_pos(le + 1);
                self.to_insert();
            }
            "O" => {
                let ls = b.line_start(p);
                b.insert_at(ls, &['\n']);
                b.set_pos(ls);
                self.to_insert();
            }
            "D" | "C" => {
                let le = b.line_end(p);
                self.yank(b, p, le, false);
                b.delete(p, le, p);
                if k == "C" {
                    b.set_pos(p);
                    self.to_insert();
                } else {
                    self.fix_caret(b);
                }
            }
            "s" => {
                let end = clamp(p + n, p, b.line_end(p));
                if end > p {
                    self.yank(b, p, end, false);
                }
                b.delete(p, end, p);
                b.set_pos(p);
                self.to_insert();
            }
            "S" => self.linewise_change(b, p, n),
            "x" => {
                let end = clamp(p + n, p, b.line_end(p));
                if end > p {
                    self.yank(b, p, end, false);
                    b.delete(p, end, p);
                    self.fix_caret(b);
                }
            }
            "X" => {
                let start = clamp(p - n, b.line_start(p), p);
                if start < p {
                    self.yank(b, start, p, false);
                    b.delete(start, p, start);
                }
            }
            "p" => self.paste(b, true),
            "P" => self.paste(b, false),
            "v" => {
                self.mode = Mode::Visual;
                (self.vis_anchor, self.vis_caret) = (p, p);
                self.reset();
                self.vis_sync(b);
                return;
            }
            ":" => {
                self.cmd = Some(String::new());
                self.reset();
                return;
            }
            "u" => {
                out.undo = true;
                self.fix_caret(b);
            }
            // any other key is swallowed: it never types into the text
            _ => {}
        }
        self.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plays keys as the corpus writes them: a character, a key's name, or `C-x` for Ctrl. A key vim does not take is typed as the editor would type it.
    fn play(text: &str, pos: usize, keys: &[String]) -> (Buf, Vim, usize, Option<String>) {
        let (mut b, mut v, mut saves, mut said) = (Buf::new(text, pos), Vim::default(), 0, None);
        for k in keys {
            let (key, ctrl) = match k.strip_prefix("C-").filter(|r| !r.is_empty()) {
                Some(rest) => (rest, true),
                None => (k.as_str(), false),
            };
            let out = v.key(&mut b, key, ctrl);
            saves += usize::from(out.save);
            if out.said.is_some() {
                said = out.said;
            }
            if out.taken || ctrl {
                continue;
            }
            let (a, e) = (b.a.min(b.b), b.a.max(b.b));
            let mut cs = key.chars();
            let typed: Option<Vec<char>> = match (cs.next(), cs.next()) {
                (Some(c), None) => Some(vec![c]),
                _ if key == "Enter" => Some(vec!['\n']),
                _ if key == "Backspace" && a == e && a > 0 => {
                    b.text.remove(a - 1);
                    (b.a, b.b) = (a - 1, a - 1);
                    None
                }
                _ if key == "Backspace" && a != e => Some(Vec::new()),
                _ => None,
            };
            if let Some(t) = typed {
                b.text.splice(a..e, t.iter().copied());
                (b.a, b.b) = (a + t.len(), a + t.len());
            }
        }
        (b, v, saves, said)
    }

    #[test]
    fn the_keys_come_to_what_the_web_clients_come_to() {
        // every line is a run of the web's own module (scripts/stubs/vim-harness.mjs): a text, a place, keys, and what they came to
        let (mut n, mut wrong) = (0, Vec::new());
        for line in include_str!("vim_corpus.jsonl").lines() {
            let c: serde_json::Value = serde_json::from_str(line).unwrap();
            let keys: Vec<String> = c["keys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_owned()).collect();
            let (b, v, saves, said) = play(c["text"].as_str().unwrap(), c["pos"].as_u64().unwrap() as usize, &keys);
            let got = (b.string(), b.a as u64, b.b as u64, v.indicator(), saves as u64, said.unwrap_or_default());
            let want = (c["out"].as_str().unwrap().to_owned(), c["s"].as_u64().unwrap(), c["e"].as_u64().unwrap(), c["ind"].as_str().unwrap().to_owned(), c["saves"].as_u64().unwrap(), c["status"].as_str().unwrap().to_owned());
            n += 1;
            if got != want && wrong.len() < 5 {
                wrong.push(format!("{line}\n  got {got:?}"));
            }
        }
        assert!(n > 3000, "the corpus is read: {n}");
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[test]
    fn the_block_and_the_colon_line_show_as_they_stand() {
        let (mut b, mut v) = (Buf::new("one two\nthree", 0), Vim::default());
        assert_eq!((v.indicator().as_str(), v.block(&b)), ("-- NORMAL --", Some((0, false))));
        v.key(&mut b, "3", false);
        v.key(&mut b, "d", false);
        assert_eq!(v.indicator(), "-- NORMAL -- 3d");
        v.key(&mut b, "Escape", false);
        v.key(&mut b, "r", false);
        assert_eq!(v.block(&b), Some((0, true)), "an r waiting is the underline");
        v.key(&mut b, "Escape", false);
        v.key(&mut b, "v", false);
        v.key(&mut b, "e", false);
        assert_eq!((v.indicator().as_str(), v.block(&b), b.a, b.b), ("-- VISUAL --", Some((2, false)), 0, 3));
        v.key(&mut b, "Escape", false);
        v.key(&mut b, "i", false);
        assert_eq!((v.indicator().as_str(), v.block(&b)), ("-- INSERT --", None));
        v.key(&mut b, "Escape", false);
        for k in [":", "w", "q"] {
            v.key(&mut b, k, false);
        }
        assert_eq!(v.indicator(), ":wq");
        assert!(v.key(&mut b, "Enter", false).save);
        // the app's own chords pass, in any mode
        assert!(!v.key(&mut b, "s", true).taken && !v.key(&mut b, "k", true).taken && !v.key(&mut b, "c", true).taken);
        assert!(v.key(&mut b, "u", false).undo && v.key(&mut b, "r", true).redo);
    }
}
