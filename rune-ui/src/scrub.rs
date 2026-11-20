//! A page's history as a film: every revision a frame, and every block
//! of the page given a name that it keeps from frame to frame, so the
//! reader can move what stayed, bring in what was written and let go of
//! what was cut as the history is dragged through. Rune's Markdown does
//! the moving (`Markdown::block_keys`): this says which block is which.

use pulldown_cmark::{Event, Options, Parser};

/// One revision, as it is drawn.
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub rev: u64,
    pub when: String,
    /// The Markdown the reader is given.
    pub src: String,
    /// Each top-level block's name, by where its first line starts.
    pub keys: Vec<(usize, String)>,
    /// The blocks written or changed in this revision: where each lies in `src`.
    pub changed: Vec<std::ops::Range<usize>>,
    /// How many blocks this revision wrote or changed.
    pub touched: usize,
    /// How many blocks the revision before had that this one has not.
    pub cut: usize,
}

/// A page's revisions, oldest first.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Film {
    pub frames: Vec<Frame>,
    names: u32,
}

/// Where each top-level block of a Markdown text lies, from the start
/// of its first line to its end.
pub fn blocks(src: &str) -> Vec<std::ops::Range<usize>> {
    let opts = Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let (mut out, mut depth) = (Vec::new(), 0usize);
    let line_start = |at: usize| src[..at].rfind('\n').map_or(0, |i| i + 1);
    for (ev, at) in Parser::new_ext(src, opts).into_offset_iter() {
        match ev {
            Event::Start(_) => {
                if depth == 0 {
                    out.push(line_start(at.start)..at.end);
                }
                depth += 1;
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            // a rule stands alone, with no start and end of its own
            Event::Rule if depth == 0 => out.push(line_start(at.start)..at.end),
            _ => {}
        }
    }
    out
}

/// How alike two blocks are, from 0 to 1: the words they share over the
/// words of the longer.
fn alike(a: &str, b: &str) -> f32 {
    let words = |s: &str| -> Vec<String> { s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect() };
    let (wa, mut wb) = (words(a), words(b));
    let most = wa.len().max(wb.len());
    if most == 0 {
        return if a.trim() == b.trim() { 1.0 } else { 0.0 };
    }
    let mut shared = 0;
    for w in &wa {
        if let Some(i) = wb.iter().position(|x| x == w) {
            wb.swap_remove(i);
            shared += 1;
        }
    }
    shared as f32 / most as f32
}

/// The blocks that are the same text in both, in order: pairs of their places.
fn same(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let (n, m) = (a.len(), b.len());
    let mut len = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            len[i][j] = if a[i] == b[j] { len[i + 1][j + 1] + 1 } else { len[i + 1][j].max(len[i][j + 1]) };
        }
    }
    let (mut out, mut i, mut j) = (Vec::new(), 0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push((i, j));
            (i, j) = (i + 1, j + 1);
        } else if len[i + 1][j] >= len[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

/// What to mark of a block that was changed: the lines it did not have
/// before, and of a table's row only the cells that differ, each as
/// where it lies in the whole text (`base` is where the block starts).
fn marks_in(old: &str, new: &str, base: usize) -> Vec<std::ops::Range<usize>> {
    let was: Vec<&str> = old.lines().map(str::trim_end).collect();
    let cells = |line: &str| -> Vec<(usize, usize)> {
        // each cell of a table's row: where its text starts and ends in the line
        let mut out = Vec::new();
        let mut from = 0;
        for (i, ch) in line.char_indices() {
            if ch == '|' && !line[..i].ends_with('\\') {
                out.push((from, i));
                from = i + 1;
            }
        }
        out.push((from, line.len()));
        out.into_iter().map(|(a, b)| (a + (line[a..b].len() - line[a..b].trim_start().len()), a + line[a..b].trim_end().len())).collect()
    };
    let (mut out, mut at) = (Vec::new(), 0);
    for (i, raw) in new.split_inclusive('\n').enumerate() {
        let line = raw.trim_end();
        if !line.is_empty() && !was.contains(&line) {
            let lead = line.len() - line.trim_start().len();
            let before = was.get(i).filter(|w| w.trim_start().starts_with('|') && line.trim_start().starts_with('|')).map(|w| cells(w));
            let now = cells(line);
            match before.filter(|b| b.len() == now.len()) {
                Some(b) => {
                    let w = was[i];
                    out.extend(now.iter().zip(&b).filter(|((a0, a1), (b0, b1))| a1 > a0 && line[*a0..*a1] != w[*b0..*b1]).map(|((a0, a1), _)| base + at + a0..base + at + a1));
                }
                None => out.push(base + at + lead..base + at + line.len()),
            }
        }
        at += raw.len();
    }
    out
}

/// A text as Markdown shows it plainly: what would be read as its marks is escaped.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        if matches!(ch, '\\' | '*' | '_' | '`' | '[' | ']' | '<' | '|' | '#' | '~') {
            out.push('\\');
        }
        out.push(ch);
    }
    let t = out.trim();
    // a line that would start a list, a quote or a numbered item is said to be text
    let first = t.chars().next();
    let numbered = t.split_once(['.', ')']).is_some_and(|(n, _)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    if matches!(first, Some('-' | '+' | '>' | '=')) || numbered { format!("\\{t}") } else { t.to_owned() }
}

/// A spreadsheet's sheets as Markdown: a table for each, under its name
/// when there is more than one, with the columns' letters over it and
/// the rows' numbers beside it. The first 200 rows and 26 columns.
pub fn sheets_md(sheets: &[crate::sheet::Sheet]) -> String {
    let mut out = String::new();
    for sh in sheets {
        if sheets.len() > 1 {
            out.push_str(&format!("## {}\n\n", plain(&sh.name)));
        }
        let wide = sh.width().min(26);
        if wide == 0 {
            out.push_str("*An empty sheet*\n\n");
            continue;
        }
        let cols: Vec<String> = (0..wide).map(crate::sheet::column_name).collect();
        out.push_str(&format!("|   | {} |\n|---|{}\n", cols.join(" | "), "---|".repeat(wide)));
        for (r, row) in sh.rows.iter().take(200).enumerate() {
            let cells: Vec<String> = (0..wide).map(|c| row.get(c).map_or(String::new(), |v| plain(&v.replace(['\n', '\r'], " ")))).collect();
            out.push_str(&format!("| {} | {} |\n", r + 1, cells.join(" | ")));
        }
        out.push('\n');
    }
    out
}

/// A page of source as Markdown: each run of lines between blank lines
/// is a block of code of its own, so a part that stayed moves as one
/// and a part that was written comes in as one. `lang` names the
/// language for its colours, or is empty.
pub fn source_md(lang: &str, body: &str) -> String {
    let mut out = String::new();
    let mut part: Vec<&str> = Vec::new();
    let mut close = |part: &mut Vec<&str>, out: &mut String| {
        if part.is_empty() {
            return;
        }
        // a fence longer than any run of backticks inside, so nothing in the part ends it
        let longest = part.iter().flat_map(|l| l.split(|c| c != '`')).map(str::len).max().unwrap_or(0);
        let fence = "`".repeat(longest.max(2) + 1);
        out.push_str(&format!("{fence}{lang}\n{}\n{fence}\n\n", part.join("\n")));
        part.clear();
    };
    for line in body.lines() {
        if line.trim().is_empty() {
            close(&mut part, &mut out);
        } else {
            part.push(line);
        }
    }
    close(&mut part, &mut out);
    out
}

/// A map's features as Markdown: a table with a row for each, saying
/// its name, its kind, its shape and where it is, and its note. A
/// feature moved or redrawn is a row whose shape changed.
pub fn map_md(features: &[crate::map::Feature]) -> String {
    if features.is_empty() {
        return "*A map with nothing drawn on it*\n".to_owned();
    }
    let mut out = String::from("| # | Name | Kind | Shape | Note |\n|---|---|---|---|---|\n");
    for (i, f) in features.iter().take(500).enumerate() {
        let shapes: Vec<String> = f
            .geoms
            .iter()
            .map(|g| match g {
                crate::map::Geom::Point(p) => {
                    let [lon, lat] = crate::map::lonlat(*p);
                    format!("point at {lat:.5}, {lon:.5}")
                }
                crate::map::Geom::Line(ps) | crate::map::Geom::Area(ps) => {
                    // where it is, as the middle of its corners, so one that was moved reads as changed
                    let n = ps.len().max(1) as f64;
                    let (x, y) = ps.iter().fold((0.0, 0.0), |a, p| (a.0 + p[0] / n, a.1 + p[1] / n));
                    let [lon, lat] = crate::map::lonlat([x, y]);
                    format!("{} of {} corners round {lat:.5}, {lon:.5}", if matches!(g, crate::map::Geom::Line(_)) { "line" } else { "area" }, ps.len())
                }
            })
            .collect();
        let cell = |s: &str| plain(&s.replace(['\n', '\r'], " "));
        out.push_str(&format!("| {} | {} | {} | {} | {} |\n", i + 1, cell(&f.name), cell(&f.kind), shapes.join("; "), cell(&f.note)));
    }
    out
}

/// A document (flat ODT) as Markdown: its headings, paragraphs and list
/// items, in order, as plain text. What a document has beyond that
/// (type, tables' shape, pictures) is not shown.
pub fn doc_md(body: &str) -> String {
    let mut rest = body.split_once("<office:body>").map_or("", |(_, b)| b);
    let (mut out, mut text, mut lead, mut lists) = (String::new(), String::new(), String::new(), 0usize);
    let unescape = |s: &str| s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&");
    while let Some(lt) = rest.find('<') {
        text.push_str(&rest[..lt]);
        let Some(gt) = rest[lt..].find('>') else { break };
        let tag = &rest[lt + 1..lt + gt];
        rest = &rest[lt + gt + 1..];
        let (closing, alone) = (tag.starts_with('/'), tag.ends_with('/'));
        let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        match name {
            "text:list" if !alone => lists = if closing { lists.saturating_sub(1) } else { lists + 1 },
            "text:h" | "text:p" if !closing => {
                text.clear();
                lead = match name {
                    "text:h" => {
                        let level = tag.split_once("text:outline-level=\"").and_then(|(_, r)| r.split('"').next()?.parse::<usize>().ok()).unwrap_or(1);
                        format!("{} ", "#".repeat(level.clamp(1, 6)))
                    }
                    _ if lists > 0 => format!("{}- ", "  ".repeat(lists - 1)),
                    _ => String::new(),
                };
            }
            "text:h" | "text:p" => {
                let said = plain(&unescape(&text));
                if !said.is_empty() {
                    // the items of one list stand together, and anything else stands apart
                    let together = lead.trim_start().starts_with("- ") && out.lines().last().is_some_and(|l| l.trim_start().starts_with("- "));
                    if !out.is_empty() {
                        out.push_str(if together { "\n" } else { "\n\n" });
                    }
                    out.push_str(&lead);
                    out.push_str(&said);
                }
                text.clear();
            }
            "text:s" | "text:tab" | "text:line-break" => text.push(' '),
            _ => {}
        }
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

impl Film {
    /// Adds the next revision, newer than every one added before. A
    /// block that is the same text as one in the revision before keeps
    /// its name. Between two such, a block much like one that stood
    /// there keeps that one's name and is marked changed. Any other is
    /// new, and marked so.
    pub fn push(&mut self, rev: u64, when: String, src: String) {
        let at = blocks(&src);
        let text: Vec<&str> = at.iter().map(|r| src[r.clone()].trim_end()).collect();
        let mut fresh = || {
            self.names += 1;
            format!("s{}", self.names)
        };
        let (mut names, mut changed, mut cut, mut touched) = (vec![String::new(); at.len()], Vec::new(), 0, 0);
        match self.frames.last() {
            None => names.iter_mut().for_each(|n| *n = fresh()),
            Some(before) => {
                let was_at = blocks(&before.src);
                let was: Vec<&str> = was_at.iter().map(|r| before.src[r.clone()].trim_end()).collect();
                let was_name = |i: usize| before.keys.get(i).map(|k| k.1.clone());
                let mut kept = same(&was, &text);
                kept.push((was.len(), text.len()));
                let (mut i0, mut j0) = (0, 0);
                for (i1, j1) in kept {
                    // between two blocks that stayed: the ones much alike, in order, are one block changed
                    let mut i = i0;
                    for j in j0..j1 {
                        touched += 1;
                        match (i..i1).find(|&x| alike(was[x], text[j]) >= 0.5) {
                            Some(x) => {
                                cut += x - i;
                                names[j] = was_name(x).unwrap_or_else(&mut fresh);
                                i = x + 1;
                                // of a block changed, what is new in it
                                changed.extend(marks_in(was[x], text[j], at[j].start));
                            }
                            None => {
                                names[j] = fresh();
                                changed.push(at[j].start..at[j].start + text[j].len());
                            }
                        }
                    }
                    cut += i1 - i;
                    if j1 < text.len() {
                        names[j1] = was_name(i1).unwrap_or_else(&mut fresh);
                    }
                    (i0, j0) = (i1 + 1, j1 + 1);
                }
            }
        }
        let keys = at.iter().zip(names).map(|(r, n)| (r.start, n)).collect();
        self.frames.push(Frame { rev, when, src, keys, changed, touched, cut });
    }

    /// What a frame's revision did, in a few words.
    pub fn said(&self, i: usize) -> String {
        let Some(f) = self.frames.get(i) else { return String::new() };
        if i == 0 {
            return "the first kept".to_owned();
        }
        let part = |n: usize, what: &str| (n > 0).then(|| format!("{n} {what}"));
        let fresh = f.touched;
        let parts: Vec<String> = [part(fresh, if fresh == 1 { "block written or changed" } else { "blocks written or changed" }), part(f.cut, "cut")].into_iter().flatten().collect();
        if parts.is_empty() { "nothing a reader sees".to_owned() } else { parts.join(", ") }
    }
}

/// The frame a place along the track is nearest: `x` of `wide`, among `n` frames.
pub fn frame_at(x: f32, wide: f32, n: usize) -> usize {
    if n < 2 || wide <= 0.0 {
        return 0;
    }
    ((x / wide).clamp(0.0, 1.0) * (n - 1) as f32).round() as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(f: &Frame) -> Vec<&str> {
        f.keys.iter().map(|k| k.1.as_str()).collect()
    }

    #[test]
    fn a_page_is_split_where_its_top_blocks_start() {
        let src = "# A\n\nOne line\nand another.\n\n- a\n- b\n  - c\n\n---\n\n```\ncode\n\nmore\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
        let got: Vec<&str> = blocks(src).iter().map(|r| src[r.clone()].lines().next().unwrap()).collect();
        assert_eq!(got, ["# A", "One line", "- a", "---", "```", "| a | b |"]);
        assert!(blocks("").is_empty());
    }

    #[test]
    fn a_block_keeps_its_name_through_what_is_done_around_it_and_to_it() {
        let mut film = Film::default();
        film.push(1, String::new(), "# Plan\n\nBuy the timber for the shed.\n\nPaint it.\n".into());
        film.push(2, String::new(), "# Plan\n\nA note at the top.\n\nBuy the timber for the garden shed.\n\nPaint it.\n".into());
        film.push(3, String::new(), "# Plan\n\nBuy the timber for the garden shed.\n\nPaint it.\n\nDone by June.\n".into());
        film.push(4, String::new(), "# Plan\n\nPaint it.\n\nBuy the timber for the garden shed.\n".into());
        let f = &film.frames;
        assert_eq!(names(&f[0]), ["s1", "s2", "s3"]);
        // a block written above, and one changed a little: the changed one is still itself
        assert_eq!(names(&f[1]), ["s1", "s4", "s2", "s3"]);
        assert_eq!(f[1].changed.iter().map(|r| f[1].src[r.clone()].trim_end()).collect::<Vec<_>>(), ["A note at the top.", "Buy the timber for the garden shed."]);
        // one cut, one written at the end
        assert_eq!((names(&f[2]), f[2].cut), (vec!["s1", "s2", "s3", "s5"], 1));
        assert_eq!(film.said(2), "1 block written or changed, 1 cut");
        // no name is given twice in a frame, whatever was moved
        let mut n = names(&f[3]);
        n.sort();
        n.dedup();
        assert_eq!(n.len(), 3);
        assert_eq!(film.said(0), "the first kept");
    }

    #[test]
    fn a_revision_that_changes_nothing_drawn_marks_nothing() {
        let mut film = Film::default();
        film.push(1, String::new(), "One.\n\nTwo.\n".into());
        film.push(2, String::new(), "One.\n\nTwo.\n\n".into());
        assert_eq!((film.frames[1].touched, film.frames[1].cut, film.said(1).as_str()), (0, 0, "nothing a reader sees"));
        assert_eq!(names(&film.frames[0]), names(&film.frames[1]));
    }

    #[test]
    fn a_changed_sheet_marks_the_cells_that_changed() {
        let sheet = |rows: &[&[&str]]| vec![crate::sheet::Sheet { name: "Costs".into(), rows: rows.iter().map(|r| r.iter().map(|c| (*c).to_owned()).collect()).collect() }];
        let one = sheets_md(&sheet(&[&["Thing", "Cost"], &["Timber", "240"], &["Felt", "35"]]));
        assert_eq!(one, "|   | A | B |\n|---|---|---|\n| 1 | Thing | Cost |\n| 2 | Timber | 240 |\n| 3 | Felt | 35 |\n\n");
        let two = sheets_md(&sheet(&[&["Thing", "Cost"], &["Timber", "260"], &["Felt", "35"], &["Paint", "18"]]));
        let mut film = Film::default();
        film.push(1, String::new(), one);
        film.push(2, String::new(), two);
        let f = &film.frames[1];
        assert_eq!(f.keys.len(), 1, "one table, the same one");
        assert_eq!(f.keys[0].1, film.frames[0].keys[0].1);
        // the cell that changed, and the row that was written
        assert_eq!(f.changed.iter().map(|r| &f.src[r.clone()]).collect::<Vec<_>>(), ["260", "| 4 | Paint | 18 |"]);
        assert_eq!(film.said(1), "1 block written or changed");
        // a cell with a bar or a star in it stays one cell of text
        assert!(sheets_md(&sheet(&[&["a|b", "*c*"]])).contains("| 1 | a\\|b | \\*c\\* |"));
        assert_eq!(sheets_md(&[crate::sheet::Sheet { name: "S".into(), rows: Vec::new() }]), "*An empty sheet*\n\n");
    }

    #[test]
    fn source_is_a_block_of_code_for_each_part_between_blank_lines() {
        let src = "fn a() {\n    1\n}\n\n\n// ```\nfn b() {}\n";
        assert_eq!(source_md("rust", src), "```rust\nfn a() {\n    1\n}\n```\n\n````rust\n// ```\nfn b() {}\n````\n\n");
        assert_eq!(blocks(&source_md("rust", src)).len(), 2);
        assert_eq!((source_md("", "").as_str(), source_md("", "\n \n").as_str()), ("", ""));
        // a part changed keeps its name, and the line that changed is the one marked
        let mut film = Film::default();
        film.push(1, String::new(), source_md("", "a = 1\nb = 2\n\nc = 3\n"));
        film.push(2, String::new(), source_md("", "z = 0\n\na = 1\nb = 5\n\nc = 3\n"));
        let f = &film.frames[1];
        assert_eq!(f.keys.iter().map(|k| k.1.as_str()).collect::<Vec<_>>(), ["s3", "s1", "s2"]);
        assert_eq!(f.changed.iter().map(|r| &f.src[r.clone()]).collect::<Vec<_>>(), ["```\nz = 0\n```", "b = 5"]);
    }

    #[test]
    fn a_map_is_a_row_for_each_feature_and_a_moved_one_is_a_changed_row() {
        let map = |lon: f64| format!(r#"{{"type":"FeatureCollection","features":[{{"type":"Feature","properties":{{"name":"Shed","kind":"building","note":"the | old one"}},"geometry":{{"type":"Point","coordinates":[{lon},51.5]}}}},{{"type":"Feature","properties":{{"name":"Path"}},"geometry":{{"type":"LineString","coordinates":[[0,0],[2,2]]}}}}]}}"#);
        let one = map_md(&crate::map::parse(&map(-0.12)).unwrap());
        assert!(one.starts_with("| # | Name | Kind | Shape | Note |\n|---|---|---|---|---|\n| 1 | Shed | building | point at "), "{one}");
        assert!(one.contains("the \\| old one") && one.contains("| 1 | Shed | building | point at 51.50000, -0.12000 |") && one.contains("| 2 | Path |  | line of 2 corners round 1.000"), "{one}");
        let mut film = Film::default();
        film.push(1, String::new(), one);
        film.push(2, String::new(), map_md(&crate::map::parse(&map(-0.13)).unwrap()));
        let f = &film.frames[1];
        assert_eq!((f.changed.len(), f.touched), (1, 1));
        assert!(f.src[f.changed[0].clone()].starts_with("point at "));
        assert_eq!(map_md(&[]), "*A map with nothing drawn on it*\n");
    }

    #[test]
    fn a_document_is_read_as_its_headings_paragraphs_and_lists() {
        let doc = r#"<?xml version="1.0"?><office:document><office:styles><style:style style:name="x"/></office:styles><office:body><office:text>
            <text:h text:style-name="Heading_20_2" text:outline-level="2">The shed</text:h>
            <text:p text:style-name="P1">A plan, <text:span text:style-name="T1">to be done</text:span> by June &amp; no later.</text:p>
            <text:p/>
            <text:list><text:list-item><text:p>Timber</text:p></text:list-item><text:list-item><text:p>Screws<text:s/>*</text:p></text:list-item></text:list>
            <text:p>1. Not a list</text:p>
        </office:text></office:body></office:document>"#;
        assert_eq!(doc_md(doc), "## The shed\n\nA plan, to be done by June & no later.\n\n- Timber\n- Screws \\*\n\n\\1. Not a list\n");
        assert_eq!(blocks(&doc_md(doc)).len(), 4);
        assert_eq!(doc_md("not a document"), "");
    }

    #[test]
    fn a_place_on_the_track_is_its_nearest_frame() {
        assert_eq!([frame_at(0.0, 300.0, 4), frame_at(100.0, 300.0, 4), frame_at(160.0, 300.0, 4), frame_at(900.0, 300.0, 4), frame_at(-5.0, 300.0, 4)], [0, 1, 2, 3, 0]);
        assert_eq!((frame_at(50.0, 300.0, 1), frame_at(50.0, 0.0, 9)), (0, 0));
    }
}
