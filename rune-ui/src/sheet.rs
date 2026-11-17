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

/// The rows of a CSV, as the web client reads one (RFC 4180, forgiving):
/// quoted fields, doubled quotes, CR LF or LF. A semicolon or a tab is
/// the separator when the first line has more of them than commas.
pub fn parse_csv(src: &str) -> Vec<Vec<String>> {
    let text = src.strip_prefix('\u{feff}').unwrap_or(src);
    let first = text.split('\n').next().unwrap_or("");
    let count = |ch: char| first.matches(ch).count();
    let sep = if count('\t') > count(',') {
        '\t'
    } else if count(';') > count(',') {
        ';'
    } else {
        ','
    };
    let (mut rows, mut row, mut field, mut quoted) = (Vec::new(), Vec::new(), String::new(), false);
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            match ch {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                _ => field.push(ch),
            }
        } else if ch == '"' && field.is_empty() {
            quoted = true;
        } else if ch == sep {
            row.push(std::mem::take(&mut field));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(ch);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// The most cells a CSV may have to become a page, as on the web.
pub const CSV_MAX_CELLS: usize = 20_000;

/// Whether a field is a plain number: digits, with a sign and a decimal
/// part if it has them. A number with a leading zero, or too long to
/// hold exactly, stays the text it is (a code, a phone number).
fn plain_number(v: &str) -> Option<f64> {
    let digits = v.strip_prefix('-').unwrap_or(v);
    let (whole, part) = digits.split_once('.').unwrap_or((digits, "0"));
    let all = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let ok = all(whole) && all(part) && (whole == "0" || !whole.starts_with('0')) && digits.len() <= 15;
    ok.then(|| v.parse().ok()).flatten()
}

fn escape(s: &str, out: &mut String) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // what XML 1.0 cannot hold is dropped
            c if c < ' ' && c != '\t' && c != '\n' => {}
            c => out.push(c),
        }
    }
}

/// A new spreadsheet page holding a CSV's cells: the web client's blank
/// sheet with the rows in it. A plain number is a number cell and every
/// other field is text, so a field that starts with `=` never runs as a
/// formula.
// ponytail: the web client types each field into its grid, which also reads dates, percents and
// money. Here those stay text. Port its readTyped (ui-src/sheet/book.js) if that matters.
pub fn from_csv(src: &str) -> Result<String, String> {
    let rows = parse_csv(src);
    let cells: usize = rows.iter().map(Vec::len).sum();
    if cells > CSV_MAX_CELLS {
        return Err(format!("it has {cells} cells, and a spreadsheet page holds about {CSV_MAX_CELLS}"));
    }
    let blank = include_str!("../../ui-src/sheet/blank.fods");
    let empty = "    <table:table-row table:style-name=\"ro1\">\n     <table:table-cell/>\n    </table:table-row>\n";
    let at = blank.find(empty).ok_or("the blank sheet is not as expected")?;
    let mut out = String::with_capacity(blank.len() + src.len() * 3);
    out.push_str(&blank[..at]);
    for row in &rows {
        out.push_str("    <table:table-row table:style-name=\"ro1\">\n");
        for v in row {
            if v.is_empty() {
                out.push_str("     <table:table-cell/>\n");
            } else if let Some(n) = plain_number(v) {
                out.push_str(&format!("     <table:table-cell office:value-type=\"float\" office:value=\"{n}\" calcext:value-type=\"float\"><text:p>{n}</text:p></table:table-cell>\n"));
            } else {
                out.push_str("     <table:table-cell office:value-type=\"string\" calcext:value-type=\"string\">");
                for (i, line) in v.split('\n').enumerate() {
                    out.push_str(if i == 0 { "<text:p>" } else { "</text:p><text:p>" });
                    escape(line.trim_end_matches('\r'), &mut out);
                }
                out.push_str("</text:p></table:table-cell>\n");
            }
        }
        if row.is_empty() {
            out.push_str("     <table:table-cell/>\n");
        }
        out.push_str("    </table:table-row>\n");
    }
    if rows.is_empty() {
        out.push_str(empty);
    }
    out.push_str(&blank[at + empty.len()..]);
    Ok(out)
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
    fn a_csv_reads_as_rows_whatever_its_separator_and_quotes() {
        assert_eq!(parse_csv("a,b\r\n\"x, \"\"y\"\"\",2\n"), vec![vec!["a", "b"], vec!["x, \"y\"", "2"]]);
        assert_eq!(parse_csv("\u{feff}a;b;c\n1,5;2;3"), vec![vec!["a", "b", "c"], vec!["1,5", "2", "3"]]);
        assert_eq!(parse_csv("a\tb\n"), vec![vec!["a", "b"]]);
        assert_eq!(parse_csv("\"two\nlines\",x"), vec![vec!["two\nlines", "x"]]);
        assert_eq!(parse_csv("a,\n,\n"), vec![vec!["a", ""], vec!["", ""]]);
        assert!(parse_csv("").is_empty());
    }

    #[test]
    fn a_csv_becomes_a_sheet_this_client_reads_back_the_same() {
        let csv = "Item,Cost,Code,Note\nTea <green> & \"co\",4.50,007,=SUM(A1)\nMilk,-2,12345678901234567890,\"two\nlines\"\n,,,\nlast,1e5,3.,x\n";
        let fods = from_csv(csv).unwrap();
        // LATTICE_FODS_OUT=file keeps the document, to open in LibreOffice
        if let Ok(out) = std::env::var("LATTICE_FODS_OUT") {
            std::fs::write(out, &fods).unwrap();
        }
        let sheets = parse(&fods);
        assert_eq!(sheets.len(), 1);
        assert_eq!(
            sheets[0].rows,
            vec![
                vec!["Item", "Cost", "Code", "Note"],
                vec!["Tea <green> & \"co\"", "4.5", "007", "=SUM(A1)"],
                vec!["Milk", "-2", "12345678901234567890", "two\nlines"],
                vec![],
                vec!["last", "1e5", "3.", "x"],
            ]
        );
        // a number is a number cell, and what only looks like one is text: nothing typed runs as a formula
        assert_eq!(fods.matches("office:value-type=\"float\"").count(), 2);
        assert!(fods.contains("office:value=\"4.5\"") && fods.contains("office:value=\"-2\""));
        assert!(!fods.contains("table:formula"));
        assert!(fods.contains("<text:p>=SUM(A1)</text:p>"));
        // the rest of the document is the blank sheet's, untouched
        let blank = include_str!("../../ui-src/sheet/blank.fods");
        assert!(fods.starts_with(&blank[..2000]) && fods.ends_with(&blank[blank.len() - 100..]));
        // nothing in it is still an empty sheet, and too many cells is refused
        assert_eq!(from_csv("").unwrap(), blank);
        let big = "a,b\n".repeat(CSV_MAX_CELLS / 2 + 1);
        assert!(from_csv(&big).unwrap_err().contains("cells"));
    }

    #[test]
    fn columns_are_lettered_as_a_spreadsheet_letters_them() {
        let names: Vec<String> = [0, 1, 25, 26, 27, 51, 52, 701, 702].into_iter().map(column_name).collect();
        assert_eq!(names, ["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
    }
}
