//! A page changed in two places at once, put together by its blocks.
//! When a page was saved somewhere else while it was being edited here,
//! there are three texts: the one both started from, this window's, and
//! the other's. A block only one of them changed is taken from the one
//! that changed it. A block both changed is a conflict: this window's is
//! kept and the other's is handed back beside it, to be chosen between.

/// A part both changed.
#[derive(Clone, Debug, PartialEq)]
pub struct Conflict {
    /// Where it is, as `here::place` names it in the merged text.
    pub place: String,
    /// This window's text of it, which is what the merged text holds.
    pub mine: String,
    /// The other's text of it.
    pub theirs: String,
}

/// The three texts merged.
#[derive(Clone, Debug, PartialEq)]
pub struct Merged {
    pub text: String,
    pub conflicts: Vec<Conflict>,
    /// How many parts were taken from the other's text.
    pub taken: usize,
}

/// A text as its blocks, each with the blank lines after it, and what stands before the first.
fn parts<'a>(kind: &str, text: &'a str) -> (&'a str, Vec<&'a str>) {
    let at = crate::here::blocks(kind, text);
    let Some(first) = at.first() else { return (text, Vec::new()) };
    let starts: Vec<usize> = at.iter().map(|r| r.start).chain([text.len()]).collect();
    (&text[..first.start], starts.windows(2).map(|w| &text[w[0]..w[1]]).collect())
}

/// The blocks that are the same in both, in order: pairs of their places.
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

/// What one side did to the base, block by block: which of the base's
/// blocks it no longer has, what it wrote before each (a block it
/// changed is one it no longer has, with its new text written in its
/// place), and its own copy of each block it kept.
struct Side<'a> {
    gone: Vec<bool>,
    wrote: Vec<Vec<usize>>,
    kept: Vec<Option<usize>>,
    blocks: Vec<&'a str>,
    text: Vec<String>,
}

fn side<'a>(base: &[String], blocks: Vec<&'a str>) -> Side<'a> {
    let text: Vec<String> = blocks.iter().map(|s| s.trim_end().to_owned()).collect();
    fn refs(v: &[String]) -> Vec<&str> {
        v.iter().map(String::as_str).collect()
    }
    let pairs = same(&refs(base), &refs(&text));
    let n = base.len();
    let (mut gone, mut wrote, mut kept) = (vec![true; n], vec![Vec::new(); n + 1], vec![None; n]);
    let (mut b0, mut s0) = (0, 0);
    for (bi, si) in pairs.into_iter().chain([(n, text.len())]) {
        // what this side has between two blocks it kept stands where the base's blocks between them stood
        wrote[b0].extend(s0..si);
        if bi < n {
            (gone[bi], kept[bi]) = (false, Some(si));
        }
        (b0, s0) = (bi + 1, si + 1);
    }
    Side { gone, wrote, kept, blocks, text }
}

/// Merges this window's text and the other's, both made from `base`.
pub fn merge3(kind: &str, base: &str, mine: &str, theirs: &str) -> Merged {
    let ((_, b), (lead, m), (their_lead, t)) = (parts(kind, base), parts(kind, mine), parts(kind, theirs));
    let bt: Vec<String> = b.iter().map(|s| s.trim_end().to_owned()).collect();
    let (me, they) = (side(&bt, m), side(&bt, t));
    // each block put out, with the side and place it came from: two that stood together in one text keep what was between them
    let mut out: Vec<(bool, usize)> = Vec::new();
    let (mut marks, mut taken) = (Vec::new(), 0);
    let words = |s: &Side, at: &[usize]| at.iter().map(|i| s.text[*i].as_str()).collect::<Vec<_>>().join("\n\n");
    for p in 0..=bt.len() {
        let (mi, ti) = (&me.wrote[p], &they.wrote[p]);
        let (mw, tw) = (words(&me, mi), words(&they, ti));
        let (m_gone, t_gone) = (me.gone.get(p).copied().unwrap_or(false), they.gone.get(p).copied().unwrap_or(false));
        if mw == tw || ti.is_empty() {
            // a block changed here that the other cut is not settled by taking either
            if !mi.is_empty() && ti.is_empty() && m_gone && t_gone {
                marks.push((out.len(), mw.clone(), String::new()));
            }
            out.extend(mi.iter().map(|i| (true, *i)));
        } else if mi.is_empty() {
            if m_gone && t_gone {
                // changed there and cut here: this window's cut stands, and theirs is handed back
                marks.push((out.len(), String::new(), tw.clone()));
            } else {
                out.extend(ti.iter().map(|i| (false, *i)));
                taken += ti.len();
            }
        } else {
            marks.push((out.len(), mw.clone(), tw.clone()));
            out.extend(mi.iter().map(|i| (true, *i)));
        }
        if p < bt.len() {
            match (me.kept[p], they.gone[p]) {
                (Some(i), false) => out.push((true, i)),
                (Some(_), true) => taken += 1,
                (None, _) => {}
            }
        }
    }
    let mut text = String::from(if me.blocks.is_empty() && !they.blocks.is_empty() { their_lead } else { lead });
    let mut starts = Vec::with_capacity(out.len());
    for (n, (mine_one, i)) in out.iter().enumerate() {
        starts.push(text.len());
        let block = if *mine_one { me.blocks[*i] } else { they.blocks[*i] };
        // two blocks that did not stand together where they came from get a blank line between them
        let together = out.get(n + 1).is_none_or(|(next_mine, j)| next_mine == mine_one && *j == i + 1);
        if together {
            text.push_str(block);
        } else {
            text.push_str(block.trim_end());
            text.push_str("\n\n");
        }
    }
    // the text ends as this window's did, when the last block is not this window's last
    if out.last().is_some_and(|(mine_one, i)| !(*mine_one && *i + 1 == me.blocks.len())) {
        let cut = text.trim_end().len();
        text.truncate(cut);
        if mine.ends_with('\n') || (me.blocks.is_empty() && theirs.ends_with('\n')) {
            text.push('\n');
        }
    }
    let conflicts = marks
        .into_iter()
        .map(|(at, mine, theirs)| {
            let place = starts.get(at).or(starts.last()).map_or(String::new(), |s| crate::here::place(kind, &text, *s));
            Conflict { place, mine, theirs }
        })
        .collect();
    Merged { text, conflicts, taken }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "# The shed\n\nA plan.\n\n## Site\n\nBehind the tree.\n\n## Cost\n\n- Timber\n";

    #[test]
    fn what_each_changed_alone_is_kept_from_both() {
        let mine = BASE.replace("A plan.", "A plan, done by June.");
        let theirs = BASE.replace("- Timber", "- Timber\n- Felt").replace("## Cost", "## Paint\n\nGreen.\n\n## Cost");
        let got = merge3("md", BASE, &mine, &theirs);
        assert_eq!(got.text, "# The shed\n\nA plan, done by June.\n\n## Site\n\nBehind the tree.\n\n## Paint\n\nGreen.\n\n## Cost\n\n- Timber\n- Felt\n");
        assert!(got.conflicts.is_empty());
        assert!(got.taken > 0);
        // and the same the other way round
        assert_eq!(merge3("md", BASE, &theirs, &mine).text, got.text);
    }

    #[test]
    fn nothing_changed_on_one_side_is_the_other_side_whole() {
        let theirs = BASE.replace("Behind the tree.", "Behind the apple tree.");
        assert_eq!(merge3("md", BASE, BASE, &theirs).text, theirs);
        assert_eq!(merge3("md", BASE, &theirs, BASE), Merged { text: theirs.clone(), conflicts: Vec::new(), taken: 0 });
        assert_eq!(merge3("md", BASE, &theirs, &theirs).conflicts, []);
        assert_eq!(merge3("md", BASE, &theirs, &theirs).text, theirs);
        // typed here, in a text nobody else touched: not a letter is moved
        let mine = "# The shed\nA plan.\n\n\n\n## Site\nBehind the tree.\n## Cost\n- Timber";
        assert_eq!(merge3("md", mine, mine, mine).text, mine);
    }

    #[test]
    fn a_block_both_changed_keeps_this_windows_and_hands_back_the_others() {
        let mine = BASE.replace("Behind the tree.", "Behind the apple tree.").replace("- Timber", "- Timber\n- Screws");
        let theirs = BASE.replace("Behind the tree.", "Beside the wall.");
        let got = merge3("md", BASE, &mine, &theirs);
        assert_eq!(got.text, mine, "this window's text stands where both wrote");
        assert_eq!(got.conflicts, [Conflict { place: "site\u{1f}1".into(), mine: "Behind the apple tree.".into(), theirs: "Beside the wall.".into() }]);
    }

    #[test]
    fn a_block_cut_by_one_and_left_by_the_other_is_cut() {
        let theirs = BASE.replace("## Site\n\nBehind the tree.\n\n", "");
        let mine = BASE.replace("A plan.", "A better plan.");
        let got = merge3("md", BASE, &mine, &theirs);
        assert_eq!(got.text, "# The shed\n\nA better plan.\n\n## Cost\n\n- Timber\n");
        assert!(got.conflicts.is_empty());
        // one adds at the end where the base had no blank line after its last block
        let (base, mine, theirs) = ("One.", "One.\n\nTwo.", "Zero.\n\nOne.");
        assert_eq!(merge3("md", base, mine, theirs).text, "Zero.\n\nOne.\n\nTwo.");
    }

    #[test]
    fn a_block_changed_by_one_and_cut_by_the_other_is_said() {
        let mine = BASE.replace("Behind the tree.", "Behind the apple tree.");
        let theirs = BASE.replace("Behind the tree.\n\n", "");
        let got = merge3("md", BASE, &mine, &theirs);
        assert_eq!(got.text, mine);
        assert_eq!(got.conflicts, [Conflict { place: "site\u{1f}1".into(), mine: "Behind the apple tree.".into(), theirs: String::new() }]);
        // and cut here, changed there: the cut stands and theirs is handed back
        let got = merge3("md", BASE, &theirs, &mine);
        assert_eq!(got.text, theirs);
        assert_eq!((got.conflicts.len(), got.conflicts[0].theirs.as_str(), got.conflicts[0].mine.as_str()), (1, "Behind the apple tree.", ""));
    }

    #[test]
    fn source_is_merged_by_its_runs_of_lines() {
        let base = "a = 1\n\nb = 2\n\nc = 3\n";
        let got = merge3("js", base, &base.replace("a = 1", "a = 10"), &base.replace("c = 3", "c = 30"));
        assert_eq!((got.text.as_str(), got.conflicts.len()), ("a = 10\n\nb = 2\n\nc = 30\n", 0));
        assert_eq!(merge3("js", "", "", "x = 1\n").text, "x = 1\n");
    }
}
