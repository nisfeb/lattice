//! A spreadsheet page (flat ODS, as LibreOffice writes it) read into rows
//! of text for a native grid. Read-only: what each cell shows, not its
//! formula or style.

#[derive(Debug, PartialEq)]
pub struct Sheet {
    pub name: String,
    /// Rows of cells as shown. Trailing empty cells and rows are cut, so
    /// rows differ in length.
    pub rows: Vec<Vec<String>>,
}

impl Sheet {
    pub fn width(&self) -> usize {
        self.rows.iter().map(Vec::len).max().unwrap_or(0)
    }
}

/// The most rows and columns read. A sheet "filled" to its last row with
/// one repeated empty cell is common, and is not a million rows of text.
const MAX_ROWS: usize = 5000;
const MAX_COLS: usize = 256;

/// A column's letters: A to Z, then AA and on.
pub fn column_name(mut i: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (i % 26) as u8);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

fn unescape(s: &str, out: &mut String) {
    let mut rest = s;
    while let Some(a) = rest.find('&') {
        out.push_str(&rest[..a]);
        let end = rest[a..].find(';').filter(|&e| e <= 10);
        let name = end.map(|e| &rest[a + 1..a + e]);
        let ch = match name {
            Some("amp") => Some('&'),
            Some("lt") => Some('<'),
            Some("gt") => Some('>'),
            Some("quot") => Some('"'),
            Some("apos") => Some('\''),
            Some(n) => n.strip_prefix("#x").and_then(|h| u32::from_str_radix(h, 16).ok()).or_else(|| n.strip_prefix('#').and_then(|d| d.parse().ok())).and_then(char::from_u32),
            None => None,
        };
        match (ch, end) {
            (Some(c), Some(e)) => {
                out.push(c);
                rest = &rest[a + e + 1..];
            }
            _ => {
                out.push('&');
                rest = &rest[a + 1..];
            }
        }
    }
    out.push_str(rest);
}

/// An attribute's value in a tag's text, unescaped.
fn attr(tag: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(i) = tag[from..].find(name) {
        let at = from + i;
        let after = &tag[at + name.len()..];
        // the name whole, not the tail of a longer one
        let whole = tag[..at].ends_with(char::is_whitespace) && after.starts_with("=\"");
        if whole {
            let v = &after[2..];
            let mut out = String::new();
            unescape(&v[..v.find('"')?], &mut out);
            return Some(out);
        }
        from = at + name.len();
    }
    None
}

fn repeat(tag: &str, name: &str) -> usize {
    attr(tag, name).and_then(|v| v.parse().ok()).unwrap_or(1).max(1)
}

/// The sheets of a flat ODS document. Empty when the text holds none.
pub fn parse(src: &str) -> Vec<Sheet> {
    let mut sheets: Vec<Sheet> = Vec::new();
    let mut row: Option<(Vec<String>, usize)> = None;
    let mut cell: Option<(String, usize)> = None;
    // inside a paragraph of the cell, and inside a note on it (not shown)
    let (mut para, mut note) = (false, 0usize);
    let mut i = 0;
    while let Some(lt) = src[i..].find('<') {
        let at = i + lt;
        if para && note == 0 {
            if let Some((text, _)) = &mut cell {
                unescape(&src[i..at], text);
            }
        }
        let Some(gt) = src[at..].find('>') else { break };
        let tag = &src[at + 1..at + gt];
        i = at + gt + 1;
        let closing = tag.starts_with('/');
        let empty = tag.ends_with('/');
        let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        match (name, closing) {
            ("table:table", false) => sheets.push(Sheet { name: attr(tag, "table:name").unwrap_or_default(), rows: Vec::new() }),
            ("table:table-row", false) => {
                row = Some((Vec::new(), repeat(tag, "table:number-rows-repeated")));
                if empty {
                    end_row(&mut sheets, &mut row);
                }
            }
            ("table:table-row", true) => end_row(&mut sheets, &mut row),
            ("table:table-cell" | "table:covered-table-cell", false) => {
                cell = Some((String::new(), repeat(tag, "table:number-columns-repeated")));
                if empty {
                    end_cell(&mut row, &mut cell);
                }
            }
            ("table:table-cell" | "table:covered-table-cell", true) => end_cell(&mut row, &mut cell),
            ("office:annotation", false) if !empty => note += 1,
            ("office:annotation", true) => note = note.saturating_sub(1),
            ("text:p", false) if note == 0 => {
                if let Some((text, _)) = &mut cell {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    para = !empty;
                }
            }
            ("text:p", true) => para = false,
            ("text:s", false) if para && note == 0 => {
                if let Some((text, _)) = &mut cell {
                    text.push_str(&" ".repeat(repeat(tag, "text:c").min(1000)));
                }
            }
            ("text:line-break", false) | ("text:tab", false) if para && note == 0 => {
                if let Some((text, _)) = &mut cell {
                    text.push(if name == "text:tab" { '\t' } else { '\n' });
                }
            }
            _ => {}
        }
    }
    for s in &mut sheets {
        while s.rows.last().is_some_and(Vec::is_empty) {
            s.rows.pop();
        }
    }
    sheets
}

fn end_cell(row: &mut Option<(Vec<String>, usize)>, cell: &mut Option<(String, usize)>) {
    let (Some((cells, _)), Some((text, rep))) = (row.as_mut(), cell.take()) else { return };
    let n = rep;
    for _ in 0..n.min(MAX_COLS.saturating_sub(cells.len())) {
        cells.push(text.clone());
    }
}

fn end_row(sheets: &mut [Sheet], row: &mut Option<(Vec<String>, usize)>) {
    let (Some(sheet), Some((mut cells, rep))) = (sheets.last_mut(), row.take()) else { return };
    while cells.last().is_some_and(String::is_empty) {
        cells.pop();
    }
    // empty rows in the middle keep their place, and the tail of them is cut in +parse
    let n = rep;
    for _ in 0..n.min(MAX_ROWS.saturating_sub(sheet.rows.len())) {
        sheet.rows.push(cells.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"<?xml version="1.0"?><office:document><office:body><office:spreadsheet>
<table:table table:name="Costs &amp; plans" table:style-name="ta1">
 <table:table-column table:number-columns-repeated="3"/>
 <table:table-row><table:table-cell office:value-type="string"><text:p>Item</text:p></table:table-cell><table:table-cell><text:p>Cost</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1021"/></table:table-row>
 <table:table-row><table:table-cell><text:p>Tea &lt;green&gt;</text:p><text:p>two lines</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="4.5" table:formula="of:=SUM([.B3:.B4])"><text:p>4.50</text:p></table:table-cell></table:table-row>
 <table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell></table:table-row>
 <table:table-row><table:table-cell/><table:table-cell><office:annotation><text:p>a note</text:p></office:annotation><text:p>a<text:s text:c="3"/>b<text:span>c</text:span>&#233;</text:p></table:table-cell></table:table-row>
 <table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
</table:table>
<table:table table:name="Empty"><table:table-row><table:table-cell/></table:table-row></table:table>
</office:spreadsheet></office:body></office:document>"#;

    #[test]
    fn a_sheet_reads_as_the_text_its_cells_show() {
        let s = parse(DOC);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "Costs & plans");
        assert_eq!(
            s[0].rows,
            vec![
                vec!["Item".to_owned(), "Cost".into()],
                vec!["Tea <green>\ntwo lines".into(), "4.50".into()],
                vec!["x".into(), "x".into()],
                vec!["x".into(), "x".into()],
                vec![String::new(), "a   bcé".into()],
            ],
            "repeats expand, the empty tail is cut, a note is not the cell's text"
        );
        assert_eq!(s[0].width(), 2);
        assert_eq!((s[1].name.as_str(), s[1].rows.len()), ("Empty", 0));
    }

    #[test]
    fn what_is_not_a_sheet_reads_as_none_and_nothing_panics() {
        assert!(parse("").is_empty());
        assert!(parse("# just markdown <not a tag").is_empty());
        // cut off mid-document, a cell with a huge repeat: read what is there, bounded
        let cut = &DOC[..DOC.find("two lines").unwrap()];
        assert_eq!(parse(cut)[0].rows.len(), 1);
        let wide = r#"<table:table table:name="w"><table:table-row table:number-rows-repeated="99999999"><table:table-cell table:number-columns-repeated="99999999"><text:p>v</text:p></table:table-cell></table:table-row></table:table>"#;
        let s = parse(wide);
        assert_eq!((s[0].rows.len(), s[0].width()), (MAX_ROWS, MAX_COLS));
    }

    #[test]
    fn the_web_clients_blank_sheet_reads_as_one_empty_sheet() {
        // 250 lines of styles and settings around one empty cell, as LibreOffice writes it
        let s = parse(include_str!("../../ui-src/sheet/blank.fods"));
        assert_eq!(s, vec![Sheet { name: "Sheet1".into(), rows: vec![] }]);
    }

    #[test]
    fn columns_are_lettered_as_a_spreadsheet_letters_them() {
        let names: Vec<String> = [0, 1, 25, 26, 27, 51, 52, 701, 702].into_iter().map(column_name).collect();
        assert_eq!(names, ["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
    }
}
