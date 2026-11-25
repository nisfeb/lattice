//! Smart list continuation and Tab/Shift-Tab list indentation for the source editor,
//! ported from `ui-src/lattice/22-listedit.js`.

/// A single atomic text replacement (in UTF-8 byte offsets) returned by `list_enter` or `list_tab`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edit {
    pub from: usize,
    pub to: usize,
    pub text: String,
    pub caret: usize,
    pub caret_end: Option<usize>,
}

const TAB_WIDTH: usize = 4;

fn indent_width(s: &str) -> usize {
    s.bytes().map(|b| if b == b'\t' { TAB_WIDTH } else { 1 }).sum()
}

fn leading_ws_width(line: &str) -> usize {
    let ws_end = line.bytes().take_while(|b| *b == b' ' || *b == b'\t').count();
    indent_width(&line[..ws_end])
}

fn in_fence(prefix: &str) -> bool {
    let mut count = 0usize;
    for line in prefix.split('\n') {
        let trimmed = line.trim_start_matches([' ', '\t']);
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            count += 1;
        }
    }
    count % 2 == 1
}

#[derive(Clone, Debug)]
struct ParsedItem<'a> {
    len: usize,
    indent: &'a str,
    bullet: &'a str,
    num: Option<u64>,
    delim: &'a str,
    gap: &'a str,
    task: &'a str,
    w: usize,
}

fn parse_item(line: &str) -> Option<ParsedItem<'_>> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    let indent = &line[..i];
    let w = indent_width(indent);
    if i >= bytes.len() {
        return None;
    }
    let (bullet, num, delim) = if matches!(bytes[i], b'-' | b'*' | b'+') {
        let b = &line[i..i + 1];
        i += 1;
        (b, None, "")
    } else if bytes[i].is_ascii_digit() {
        let d_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i >= bytes.len() || !matches!(bytes[i], b'.' | b')') {
            return None;
        }
        let n = line[d_start..i].parse::<u64>().ok()?;
        let delim = &line[i..i + 1];
        i += 1;
        ("", Some(n), delim)
    } else {
        return None;
    };
    let gap_start = i;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i == gap_start {
        return None;
    }
    let gap = &line[gap_start..i];
    let mut task = "";
    if i + 3 < bytes.len()
        && bytes[i] == b'['
        && matches!(bytes[i + 1], b' ' | b'x' | b'X')
        && bytes[i + 2] == b']'
        && matches!(bytes[i + 3], b' ' | b'\t')
    {
        let t_start = i;
        i += 3;
        while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
            i += 1;
        }
        task = &line[t_start..i];
    }
    Some(ParsedItem { len: i, indent, bullet, num, delim, gap, task, w })
}

fn is_list_line(line: &str) -> bool {
    parse_item(line).is_some()
}

/// Computes the smart-list edit for Enter at `[sel_start, sel_end)` (UTF-8 byte offsets).
/// `flavor` is `"gmi"` for Gemtext or `"md"` for Markdown. Returns `None` when Enter
/// should behave normally.
pub fn list_enter(value: &str, sel_start: usize, sel_end: usize, flavor: &str) -> Option<Edit> {
    if sel_start > value.len() || sel_end > value.len() || sel_start > sel_end {
        return None;
    }
    if !value.is_char_boundary(sel_start) || !value.is_char_boundary(sel_end) {
        return None;
    }
    let before = &value[..sel_start];
    if in_fence(before) {
        return None;
    }
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let line_end = value[sel_end..].find('\n').map_or(value.len(), |i| sel_end + i);

    if flavor == "gmi" {
        let cur_line = &value[line_start..line_end];
        let rest = cur_line.strip_prefix('*')?;
        let spaces = rest.bytes().take_while(|b| *b == b' ').count();
        if spaces == 0 {
            return None;
        }
        let marker_len = 1 + spaces;
        if sel_start < line_start + marker_len {
            return None;
        }
        if cur_line[marker_len..].trim().is_empty() {
            return Some(Edit { from: line_start, to: line_end, text: String::new(), caret: line_start, caret_end: None });
        }
        let text = format!("\n{}", &cur_line[..marker_len]);
        let caret = sel_start + text.len();
        return Some(Edit { from: sel_start, to: sel_end, text, caret, caret_end: None });
    }

    let cur_line = &value[line_start..line_end];
    let cur = parse_item(cur_line)?;
    if sel_start < line_start + cur.len {
        return None;
    }

    let lines: Vec<&str> = value.split('\n').collect();
    let cur_idx = before.bytes().filter(|b| *b == b'\n').count();
    let mut last_idx = cur_idx;
    for (i, &ln) in lines.iter().enumerate().skip(cur_idx + 1) {
        if ln.trim().is_empty() {
            continue;
        }
        let p = parse_item(ln);
        let lead = leading_ws_width(ln);
        if p.is_none() && lead <= cur.w {
            break;
        }
        if let Some(pi) = p {
            if pi.w < cur.w {
                break;
            }
        }
        last_idx = i;
    }

    let content = &cur_line[cur.len..];
    if content.trim().is_empty() {
        if cur.w > 0 {
            for i in (0..cur_idx).rev() {
                if let Some(p) = parse_item(lines[i]) {
                    if p.w < cur.w {
                        let marker = if !p.bullet.is_empty() {
                            format!("{} ", p.bullet)
                        } else {
                            format!("{}{} ", p.num.unwrap_or(0).saturating_add(1), p.delim)
                        };
                        let text = format!("{}{}{}", p.indent, marker, if !p.task.is_empty() { "[ ] " } else { "" });
                        let caret = line_start + text.len();
                        return Some(Edit { from: line_start, to: line_end, text, caret, caret_end: None });
                    }
                }
            }
        }
        return Some(Edit { from: line_start, to: line_end, text: String::new(), caret: line_start, caret_end: None });
    }

    if !cur.bullet.is_empty() {
        let text = format!("\n{}{}{}{}", cur.indent, cur.bullet, cur.gap, if !cur.task.is_empty() { "[ ] " } else { "" });
        let caret = sel_start + text.len();
        return Some(Edit { from: sel_start, to: sel_end, text, caret, caret_end: None });
    }

    // Ordered list: detect lazy ("1. 1. 1.") numbering vs sequential numbering.
    let mut sibs: Vec<u64> = Vec::new();
    for i in (0..=cur_idx).rev() {
        match parse_item(lines[i]) {
            None => {
                if !lines[i].trim().is_empty() && leading_ws_width(lines[i]) <= cur.w {
                    break;
                }
            }
            Some(p) => {
                if p.w < cur.w {
                    break;
                }
                if p.w == cur.w {
                    let Some(n) = p.num else { break };
                    sibs.insert(0, n);
                }
            }
        }
    }
    for ln in lines.iter().take(last_idx + 1).skip(cur_idx + 1) {
        let Some(p) = parse_item(ln) else { continue };
        if p.w == cur.w {
            let Some(n) = p.num else { break };
            sibs.push(n);
        }
    }
    let lazy = sibs.len() > 1 && sibs.iter().all(|&n| n == sibs[0]);
    let cur_num = cur.num.unwrap_or(1);
    let next_num = if lazy { cur_num } else { cur_num.saturating_add(1) };
    let marker = format!("{}{}{}{}{}", cur.indent, next_num, cur.delim, cur.gap, if !cur.task.is_empty() { "[ ] " } else { "" });

    let block_byte_end: usize = lines.iter().take(last_idx + 1).map(|l| l.len()).sum::<usize>() + last_idx;
    let block_end = sel_end.max(block_byte_end);
    let mut tail: Vec<String> = value[sel_end..block_end].split('\n').map(str::to_owned).collect();
    if !lazy {
        let mut n = next_num;
        for row in tail.iter_mut().skip(1) {
            let Some(p) = parse_item(row) else { continue };
            if p.w < cur.w {
                break;
            }
            if p.w > cur.w {
                continue;
            }
            if p.num.is_none() {
                break;
            }
            n = n.saturating_add(1);
            let rest = row[p.len..].to_owned();
            *row = format!("{}{}{}{}{}{}", p.indent, n, p.delim, p.gap, p.task, rest);
        }
    }
    let text = format!("\n{marker}{}", tail.join("\n"));
    let caret = sel_start + 1 + marker.len();
    Some(Edit { from: sel_start, to: block_end, text, caret, caret_end: None })
}

/// Computes the Tab (`dir > 0`) or Shift-Tab (`dir < 0`) indent/outdent edit for Markdown list lines.
pub fn list_tab(value: &str, sel_start: usize, sel_end: usize, flavor: &str, dir: i32) -> Option<Edit> {
    if flavor == "gmi" || sel_start > value.len() || sel_end > value.len() || sel_start > sel_end {
        return None;
    }
    if !value.is_char_boundary(sel_start) || !value.is_char_boundary(sel_end) {
        return None;
    }
    let line_start = value[..sel_start].rfind('\n').map_or(0, |i| i + 1);
    if in_fence(&value[..line_start]) {
        return None;
    }
    let eff_end = if sel_end > sel_start && value.as_bytes()[sel_end - 1] == b'\n' {
        sel_end - 1
    } else {
        sel_end
    };
    let after_eff = eff_end.max(sel_start);
    let span_end = value[after_eff..].find('\n').map_or(value.len(), |i| after_eff + i);
    let orig = &value[line_start..span_end];
    let span: Vec<&str> = orig.split('\n').collect();
    if !span.iter().any(|ln| is_list_line(ln)) {
        return None;
    }
    let mut first_delta: isize = 0;
    let out: Vec<String> = span
        .iter()
        .enumerate()
        .map(|(i, &ln)| {
            if !is_list_line(ln) {
                return ln.to_owned();
            }
            if dir > 0 {
                if i == 0 {
                    first_delta = 2;
                }
                format!("  {ln}")
            } else {
                let cut = if ln.starts_with('\t') {
                    1
                } else {
                    ln.bytes().take_while(|b| *b == b' ').count().min(2)
                };
                if i == 0 {
                    first_delta = -(cut as isize);
                }
                ln[cut..].to_owned()
            }
        })
        .collect();
    let text = out.join("\n");
    if text == orig {
        return None;
    }
    if sel_start == sel_end {
        let caret = (sel_start as isize + first_delta).max(line_start as isize) as usize;
        Some(Edit { from: line_start, to: span_end, text, caret, caret_end: None })
    } else {
        let end = line_start + text.len();
        Some(Edit { from: line_start, to: span_end, text, caret: line_start, caret_end: Some(end) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(input: &str, want: &str, flavor: &str) {
        let at = input.find('|').expect("caret");
        let value = input.replacen('|', "", 1);
        let got = match list_enter(&value, at, at, flavor) {
            None => input.to_owned(),
            Some(r) => {
                let mut out = String::new();
                out.push_str(&value[..r.from]);
                out.push_str(&r.text);
                out.push_str(&value[r.to..]);
                format!("{}|{}", &out[..r.caret], &out[r.caret..])
            }
        };
        assert_eq!(got, want, "input={input:?} flavor={flavor}");
    }

    fn press_range(input: &str, want: &str) {
        let a = input.find('|').unwrap();
        let b = input[a + 1..].find('|').unwrap() + a;
        let value = input.replace('|', "");
        let got = match list_enter(&value, a, b, "md") {
            None => input.to_owned(),
            Some(r) => {
                let mut out = String::new();
                out.push_str(&value[..r.from]);
                out.push_str(&r.text);
                out.push_str(&value[r.to..]);
                format!("{}|{}", &out[..r.caret], &out[r.caret..])
            }
        };
        assert_eq!(got, want, "input={input:?}");
    }

    fn tab(input: &str, want: &str, dir: i32, flavor: &str) {
        let (value, a, b) = if let Some(at) = input.find('|') {
            (input.replacen('|', "", 1), at, at)
        } else {
            let a = input.find('[').unwrap();
            let b = input.find(']').unwrap() - 1;
            (input.replacen('[', "", 1).replacen(']', "", 1), a, b)
        };
        let got = match list_tab(&value, a, b, flavor, dir) {
            None => input.to_owned(),
            Some(r) => {
                let mut out = String::new();
                out.push_str(&value[..r.from]);
                out.push_str(&r.text);
                out.push_str(&value[r.to..]);
                match r.caret_end {
                    None => format!("{}|{}", &out[..r.caret], &out[r.caret..]),
                    Some(ce) => format!("{}[{}]{}", &out[..r.caret], &out[r.caret..ce], &out[ce..]),
                }
            }
        };
        assert_eq!(got, want, "input={input:?} dir={dir} flavor={flavor}");
    }

    #[test]
    fn markdown_list_enter_parity_with_web() {
        press("- one|", "- one\n- |", "md");
        press("* one|", "* one\n* |", "md");
        press("+ one|", "+ one\n+ |", "md");
        press("  - one|", "  - one\n  - |", "md");
        press("1. one|", "1. one\n2. |", "md");
        press("1) one|", "1) one\n2) |", "md");
        press("7. seven|", "7. seven\n8. |", "md");
        press("- one|two", "- one\n- |two", "md");
        press("1. one|two", "1. one\n2. |two", "md");
        press("- one\n- |", "- one\n|", "md");
        press("1. one\n2. |", "1. one\n|", "md");
        press("1. one\n   - a\n   - |", "1. one\n   - a\n2. |", "md");
        press("- one\n  1. a\n  1. |", "- one\n  1. a\n- |", "md");
        press("1. one|\n2. two\n3. three", "1. one\n2. |\n3. two\n4. three", "md");
        press("1. |one\n2. two", "1. \n2. |one\n3. two", "md");
        press("1. one|\n2. two\n   1. a\n   2. b", "1. one\n2. |\n3. two\n   1. a\n   2. b", "md");
        press("1. one|\n2. two\n\nA paragraph.\n\n1. other", "1. one\n2. |\n3. two\n\nA paragraph.\n\n1. other", "md");
        press("1. one|\n2. two\n- other", "1. one\n2. |\n3. two\n- other", "md");
        press("1. one|\n1. two\n1. three", "1. one\n1. |\n1. two\n1. three", "md");
        press("- [ ] one|", "- [ ] one\n- [ ] |", "md");
        press("- [x] one|", "- [x] one\n- [ ] |", "md");
        press("1. [X] one|", "1. [X] one\n2. [ ] |", "md");
        press("just a line|", "just a line|", "md");
        press("|", "|", "md");
        press("```\n- not a list|", "```\n- not a list|", "md");
        press("```\ncode\n```\n- one|", "```\ncode\n```\n- one\n- |", "md");
        press("|- one", "|- one", "md");
        press("1|. one", "1|. one", "md");
        press("1.| one", "1.| one", "md");
        press("- |one", "- \n- |one", "md");
        press("1.   one|", "1.   one\n2.   |", "md");
        press("1. one|\n\n2. two", "1. one\n2. |\n\n3. two", "md");
        press("- café|", "- café\n- |", "md");
        press_range("- one| tw|o", "- one\n- |o");
        press_range("1. one|\n2. two\n\nte|xt here", "1. one\n2. |xt here");
        press_range("1. one|\n2. t|wo\n3. three", "1. one\n2. |wo\n3. three");
    }

    #[test]
    fn gemtext_and_tab_indent_parity_with_web() {
        press("* one|", "* one\n* |", "gmi");
        press("*   one|", "*   one\n*   |", "gmi");
        press("* one\n* |", "* one\n|", "gmi");
        press("- one|", "- one|", "gmi");
        press("  * one|", "  * one|", "gmi");
        press("```\n* one|", "```\n* one|", "gmi");
        press("```\ncode\n```\n* one|", "```\ncode\n```\n* one\n* |", "gmi");

        tab("1. a\n2. b|", "1. a\n  2. b|", 1, "md");
        tab("- a\n- b|", "- a\n  - b|", 1, "md");
        tab("1. a\n2. b|cd", "1. a\n  2. b|cd", 1, "md");
        tab("1. a\n2|. b", "1. a\n  2|. b", 1, "md");
        tab("just text|", "just text|", 1, "md");
        tab("```\n- x|", "```\n- x|", 1, "md");
        tab("```\n~~~[1. \n- ]", "```\n~~~[1. \n- ]", 1, "md");
        tab("* one|", "* one|", 1, "gmi");
        tab("1. a\n  2. b|", "1. a\n2. b|", -1, "md");
        tab("1. a\n 2. b|", "1. a\n2. b|", -1, "md");
        tab("1. a\n\t2. b|", "1. a\n2. b|", -1, "md");
        tab("[- a\n- b]", "[  - a\n  - b]", 1, "md");
    }
}
