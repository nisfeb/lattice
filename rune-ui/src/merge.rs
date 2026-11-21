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
}

/// A text as its blocks, each with the blank lines after it. What
/// stands before the first block is a block of its own, the first, so
/// it is merged as any other is: it may be empty.
fn parts<'a>(kind: &str, text: &'a str) -> Vec<&'a str> {
    let at = crate::here::blocks(kind, text);
    let first = at.first().map_or(text.len(), |r| r.start);
    let starts: Vec<usize> = at.iter().map(|r| r.start).chain([text.len()]).collect();
    std::iter::once(&text[..first]).chain(starts.windows(2).map(|w| &text[w[0]..w[1]])).collect()
}

/// A run of the base's blocks that one side replaced with a run of its
/// own. Either run may be empty: blocks written in, or blocks cut.
#[derive(Clone, Copy, Debug)]
struct Hunk {
    base: (usize, usize),
    side: (usize, usize),
}

impl Hunk {
    /// Whether two sides' changes cannot both be made: they replace some
    /// of the same blocks, or one writes inside what the other replaced,
    /// or both write at the same point. Changes that only touch do not.
    fn meets(&self, from: usize, to: usize) -> bool {
        let (a, b) = self.base;
        (a < to && from < b) || (a == b && from == to && a == from)
    }
}

/// What a side changed of the base, in order. Blocks are the same when
/// their text is, whatever blank lines follow.
fn hunks(base: &[&str], side: &[&str]) -> Vec<Hunk> {
    let (mut out, mut b0, mut s0) = (Vec::new(), 0, 0);
    for (b1, s1) in crate::scrub::same(base, side).into_iter().chain([(base.len(), side.len())]) {
        if b1 > b0 || s1 > s0 {
            out.push(Hunk { base: (b0, b1), side: (s0, s1) });
        }
        (b0, s0) = (b1 + 1, s1 + 1);
    }
    out
}

/// Merges this window's text and the other's, both made from `base`.
///
/// Each side's changes are runs of blocks it replaced. A run only one
/// side changed is taken from that side. Where the two sides' runs
/// meet, this window's blocks stand for the whole of it, and the
/// other's are handed back as a conflict: nothing either side wrote is
/// dropped without being said. Every block of the base that neither
/// side changed is kept, as this window has it.
// ponytail: blocks are alike only when their text is the same, and a block one side moved is a cut and a write. Two sides that move the same block to different places leave it twice. A merge that knows a move is the fix
/// The merge, or nothing when it cannot be trusted: a block was moved, or
/// a text stands more than once, in a way the merge would lose or double.
/// Then the owner chooses between the two whole, as before there was a merge.
pub fn safe(kind: &str, base: &str, mine: &str, theirs: &str) -> Option<Merged> {
    Some(walk(kind, base, mine, theirs)).filter(|w| w.1).map(|w| w.0)
}

/// The merge whether it can be trusted or not.
#[cfg(test)]
fn merge3(kind: &str, base: &str, mine: &str, theirs: &str) -> Merged {
    walk(kind, base, mine, theirs).0
}

/// The merge, and whether every text of the base stands in it as often as it should.
fn walk(kind: &str, base: &str, mine: &str, theirs: &str) -> (Merged, bool) {
    let (b, m, t) = (parts(kind, base), parts(kind, mine), parts(kind, theirs));
    let trim = |v: &[&'_ str]| -> Vec<String> { v.iter().map(|s| s.trim_end().to_owned()).collect() };
    let (bt, mt, tt) = (trim(&b), trim(&m), trim(&t));
    fn refs(v: &[String]) -> Vec<&str> {
        v.iter().map(String::as_str).collect()
    }
    let (hm, ht) = (hunks(&refs(&bt), &refs(&mt)), hunks(&refs(&bt), &refs(&tt)));
    // each block put out, with the side and place it came from
    let mut out: Vec<(bool, usize)> = Vec::new();
    let mut marks = Vec::new();
    // where the walk stands in the base, and in each side, and the next change of each
    let (mut i, mut mp, mut tp, mut im, mut it) = (0usize, 0usize, 0usize, 0usize, 0usize);
    loop {
        // the next change of either side, a write at a point before a replacement from it
        let next = [hm.get(im), ht.get(it)].into_iter().flatten().map(|h| h.base).min();
        let Some((g0, first_end)) = next else {
            out.extend((mp..m.len()).map(|x| (true, x)));
            break;
        };
        // what stands unchanged before it, as this window has it
        out.extend((mp..mp + (g0 - i)).map(|x| (true, x)));
        (mp, tp) = (mp + (g0 - i), tp + (g0 - i));
        // the change, and every change of either side that meets it
        let (mut g1, mut mine_in, mut theirs_in) = (first_end, Vec::new(), Vec::new());
        // it starts with one side's change, this window's when both have the same one
        if hm.get(im).is_some_and(|h| h.base == (g0, first_end)) {
            mine_in.push(hm[im]);
            im += 1;
        } else {
            theirs_in.push(ht[it]);
            it += 1;
        }
        loop {
            let before = mine_in.len() + theirs_in.len();
            while let Some(h) = hm.get(im).filter(|h| h.meets(g0, g1)) {
                mine_in.push(*h);
                (g1, im) = (g1.max(h.base.1), im + 1);
            }
            while let Some(h) = ht.get(it).filter(|h| h.meets(g0, g1)) {
                theirs_in.push(*h);
                (g1, it) = (g1.max(h.base.1), it + 1);
            }
            if mine_in.len() + theirs_in.len() == before {
                break;
            }
        }
        // each side's blocks for the whole of it: its own where it changed, the base's between
        let end = |taken: &[Hunk], at: usize| taken.last().map_or(at + (g1 - g0), |h| h.side.1 + (g1 - h.base.1));
        let (m1, t1) = (end(&mine_in, mp), end(&theirs_in, tp));
        match (mine_in.is_empty(), theirs_in.is_empty()) {
            (false, true) => out.extend((mp..m1).map(|x| (true, x))),
            (true, false) => out.extend((tp..t1).map(|x| (false, x))),
            _ => {
                if mt[mp..m1] != tt[tp..t1] {
                    marks.push((out.len(), mt[mp..m1].join("\n\n"), tt[tp..t1].join("\n\n")));
                }
                out.extend((mp..m1).map(|x| (true, x)));
            }
        }
        (i, mp, tp) = (g1, m1, t1);
    }
    // The walk knows a block by where it stands, so a block one side
    // moved, or a text that stands more than once, can come out a time
    // too many or too few. Each text of the base is counted in all four.
    // What neither side changed the count of stands as often as it did,
    // and what one side alone changed the count of stands as often as
    // that side has it. Where both wrote, this window's stays, so only
    // its count is held to then.
    // ponytail: a merge that fails this is not mended, it is not made. A diff that knows a move is the fix
    fn counts<'a>(v: impl Iterator<Item = &'a str>) -> std::collections::HashMap<&'a str, usize> {
        let mut n = std::collections::HashMap::new();
        for x in v {
            *n.entry(x).or_default() += 1;
        }
        n
    }
    let (cm, ct) = (counts(mt.iter().map(String::as_str)), counts(tt.iter().map(String::as_str)));
    let co = counts(out.iter().map(|o| if o.0 { mt[o.1].as_str() } else { tt[o.1].as_str() }));
    let sound = counts(bt.iter().map(String::as_str)).into_iter().filter(|(x, _)| !x.is_empty()).all(|(x, b)| {
        let at = |c: &std::collections::HashMap<&str, usize>| c.get(x).copied().unwrap_or(0);
        let (m, t, o) = (at(&cm), at(&ct), at(&co));
        if t == b {
            o == m
        } else if m == b {
            // theirs, or as far towards this window's as what was kept over theirs goes
            o == t || (!marks.is_empty() && o >= m.min(t) && o <= m.max(t))
        } else {
            // both changed how often it stands: no more than either has it, and no fewer, unless this window's was kept over theirs
            (m > b || t > b || o <= m.max(t)) && (o >= m.min(t) || !marks.is_empty())
        }
    });
    let mut text = String::new();
    let mut starts = Vec::with_capacity(out.len());
    for (n, (mine_one, x)) in out.iter().enumerate() {
        starts.push(text.len());
        let block = if *mine_one { m[*x] } else { t[*x] };
        // two blocks that did not stand together where they came from get a blank line between them, unless the first ends in one
        let together = out.get(n + 1).is_none_or(|(next_mine, y)| next_mine == mine_one && *y == x + 1);
        if together || block.ends_with("\n\n") || block.trim().is_empty() {
            text.push_str(block);
        } else {
            text.push_str(block.trim_end());
            text.push_str("\n\n");
        }
    }
    // the text ends as this window's did, when the last block is not this window's last
    if out.last().is_some_and(|(mine_one, x)| !(*mine_one && *x + 1 == m.len())) {
        let cut = text.trim_end().len();
        text.truncate(cut);
        if mine.ends_with('\n') || (mine.is_empty() && theirs.ends_with('\n')) {
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
    (Merged { text, conflicts }, sound)
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
        // and the same the other way round
        assert_eq!(merge3("md", BASE, &theirs, &mine).text, got.text);
    }

    #[test]
    fn nothing_changed_on_one_side_is_the_other_side_whole() {
        let theirs = BASE.replace("Behind the tree.", "Behind the apple tree.");
        assert_eq!(merge3("md", BASE, BASE, &theirs).text, theirs);
        assert_eq!(merge3("md", BASE, &theirs, BASE), Merged { text: theirs.clone(), conflicts: Vec::new() });
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

    /// Every block of every text, for saying nothing was lost.
    fn has_all(text: &str, blocks: &[&str]) -> bool {
        blocks.iter().all(|b| text.contains(b))
    }

    #[test]
    fn a_block_written_beside_one_the_other_changed_loses_neither() {
        // found by a review on 2026-11-20: the paragraph B went, and its change with it
        let (base, mine, theirs) = ("A.\n\nB.\n\nC.\n", "A.\n\nX.\n\nB.\n\nC.\n", "A.\n\nB changed.\n\nC.\n");
        let got = merge3("md", base, mine, theirs);
        assert_eq!(got.text, "A.\n\nX.\n\nB changed.\n\nC.\n");
        assert!(got.conflicts.is_empty());
        // and the other way round
        assert_eq!(merge3("md", base, theirs, mine).text, got.text);
        // edits to blocks next to each other are both kept
        let got = merge3("md", base, "A mine.\n\nB.\n\nC.\n", "A.\n\nB theirs.\n\nC.\n");
        assert_eq!((got.text.as_str(), got.conflicts.len()), ("A mine.\n\nB theirs.\n\nC.\n", 0));
    }

    #[test]
    fn where_changes_meet_nothing_is_put_twice_and_the_other_side_is_said() {
        let base = "A.\n\nB.\n\nC.\n";
        // this window changed B, they changed A and B
        let got = merge3("md", base, "A.\n\nB mine.\n\nC.\n", "A theirs.\n\nB theirs.\n\nC.\n");
        assert_eq!(got.text, "A.\n\nB mine.\n\nC.\n");
        assert_eq!(got.conflicts, [Conflict { place: "\u{1f}1".into(), mine: "A.\n\nB mine.".into(), theirs: "A theirs.\n\nB theirs.".into() }]);
        // this window cut B, they changed A and B: the cut stands, and what they wrote is handed back
        let got = merge3("md", base, "A.\n\nC.\n", "A theirs.\n\nB theirs.\n\nC.\n");
        assert_eq!((got.text.as_str(), got.conflicts.len()), ("A.\n\nC.\n", 1));
        assert_eq!(got.conflicts[0].theirs, "A theirs.\n\nB theirs.");
        // this window changed A and B, they cut B
        let got = merge3("md", base, "A mine.\n\nB mine.\n\nC.\n", "A.\n\nC.\n");
        assert_eq!((got.text.as_str(), got.conflicts.len()), ("A mine.\n\nB mine.\n\nC.\n", 1));
        // both wrote at the same point
        let got = merge3("md", base, "A.\n\nX.\n\nB.\n\nC.\n", "A.\n\nY.\n\nB.\n\nC.\n");
        assert_eq!((got.text.as_str(), got.conflicts.len(), got.conflicts[0].theirs.as_str()), ("A.\n\nX.\n\nB.\n\nC.\n", 1, "Y."));
    }

    #[test]
    fn nothing_either_side_wrote_goes_without_a_word() {
        // every pair of small edits to a four block page: what is not in the text is in a conflict
        let base = ["A.", "B.", "C.", "D."];
        let edits: Vec<Vec<&str>> = vec![
            vec!["A.", "B.", "C.", "D."],
            vec!["A1.", "B.", "C.", "D."],
            vec!["A.", "B1.", "C.", "D."],
            vec!["A.", "C.", "D."],
            vec!["A.", "B.", "D."],
            vec!["N.", "A.", "B.", "C.", "D."],
            vec!["A.", "N.", "B.", "C.", "D."],
            vec!["A.", "B.", "C.", "D.", "N."],
            vec!["A.", "B1.", "C1.", "D."],
            vec!["B.", "C.", "D."],
            vec![],
        ];
        let join = |v: &[&str]| if v.is_empty() { String::new() } else { format!("{}\n", v.join("\n\n")) };
        for mine in &edits {
            for theirs in &edits {
                let got = merge3("md", &join(&base), &join(mine), &join(theirs));
                let said: String = got.conflicts.iter().map(|c| format!("{}\n{}\n", c.mine, c.theirs)).collect();
                for wrote in mine.iter().chain(theirs.iter()).filter(|b| !base.contains(b)) {
                    assert!(got.text.contains(wrote) || said.contains(wrote), "{wrote} lost: {mine:?} with {theirs:?} gave {:?}", got.text);
                }
                // a block of the base that neither side changed or cut is still there, once
                for kept in base.iter().filter(|b| mine.contains(b) && theirs.contains(b)) {
                    assert_eq!(got.text.matches(kept).count(), 1, "{kept}: {mine:?} with {theirs:?} gave {:?}", got.text);
                }
                // and this window's text is what stands wherever there is a conflict
                assert!(has_all(&got.text, &got.conflicts.iter().flat_map(|c| c.mine.split("\n\n")).filter(|s| !s.is_empty()).collect::<Vec<_>>()));
            }
        }
    }

    #[test]
    fn what_stands_before_the_first_block_is_merged_too() {
        // a link's address, written before any block, changed by them while this window wrote at the end
        let base = "[a]: http://x\n\nA [a].\n";
        let got = merge3("md", base, "[a]: http://x\n\nA [a].\n\nMore.\n", "[a]: http://y\n\nA [a].\n");
        assert!(got.text.contains("http://y") && got.text.contains("More."), "{:?}", got.text);
        // blank lines this window keeps between its blocks stay as they are
        let got = merge3("js", "a = 1\n\n\nb = 2\n\nc = 3\n", "a = 1\n\n\nb = 2\n\nc = 3\n", "a = 1\n\n\nb = 2\n\nc = 30\n");
        assert_eq!(got.text, "a = 1\n\n\nb = 2\n\nc = 30\n");
    }

    #[test]
    fn a_merge_that_would_double_or_lose_a_block_is_not_made() {
        // both moved a block alike, which the walk would put twice
        assert_eq!(safe("md", "C.\n\nD.\n\nE.", "D.\n\nC.", "D.\n\nC.\n\nE."), None);
        // this window cut a block and they moved it: it would come back
        assert_eq!(safe("md", "A.\n\nB.\n", "B.\n", "B.\n\nA.\n"), None);
        // this window moved a block and they cut it: it would stay without a word
        assert_eq!(safe("md", "x\n\ny\n", "y\n\nx\n", "y\n"), None);
        // a text that stands twice, and one of the two would go
        assert_eq!(safe("md", "x\n\nx\n\ny\n", "x\n\ny\n\nx\n", "y\n\nx\n\ny\n\nx\n"), None);
        assert_eq!(safe("md", "A.\n\nx\n\nx\n", "M.\n\nx\n\nE1.\n", "A.\n\nx\n\nE2.\n"), None);
        // a block neither touched that would be left only in what is handed back
        assert_eq!(safe("md", "A.\n\nB.\n\nC.\n", "A.\n", "B.\n\nA.\n"), None);
    }

    #[test]
    fn a_plain_merge_is_made() {
        let m = safe("md", "A.\n\nB.\n\nC.\n", "A mine.\n\nB.\n\nC.\n", "A.\n\nB.\n\nC theirs.\n").unwrap();
        assert_eq!((m.text.as_str(), m.conflicts.len()), ("A mine.\n\nB.\n\nC theirs.\n", 0));
        // a rule each side wrote beside its own writing: all three stay
        let m = safe("md", "Intro.\n\n---\n\nEnd.\n", "Intro.\n\n---\n\nEnd.\n\n---\n\nMine.\n", "Theirs.\n\n---\n\nIntro.\n\n---\n\nEnd.\n").unwrap();
        assert_eq!(m.text.matches("---").count(), 3, "{}", m.text);
        // both wrote in one block: this window's stays and theirs is handed back
        let m = safe("md", "A.\n\nB.\n", "A mine.\n\nB.\n", "A theirs.\n\nB.\n").unwrap();
        assert_eq!((m.text.as_str(), m.conflicts.len()), ("A mine.\n\nB.\n", 1));
        // one cut a block the other left, beside a block both wrote
        assert!(safe("md", "Base0.\n\nBase1.", "Base1.", "").is_some());
    }

    /// Every page of up to `most` blocks from `of`, as texts.
    fn pages(of: &[&str], most: usize) -> Vec<String> {
        let mut all = vec![Vec::<&str>::new()];
        let mut from = 0;
        for _ in 0..most {
            let upto = all.len();
            for i in from..upto {
                for w in of {
                    let mut next = all[i].clone();
                    next.push(w);
                    all.push(next);
                }
            }
            from = upto;
        }
        all.into_iter().map(|p| p.join("\n\n")).collect()
    }

    #[test]
    fn a_merge_that_is_made_holds_every_block_as_often_as_it_should() {
        let count = |text: &str, w: &str| text.split("\n\n").filter(|b| b.trim() == w).count();
        let (mut made, mut not) = (0, 0);
        for base in pages(&["x", "y"], 3) {
            for mine in pages(&["x", "y", "z"], 3) {
                for theirs in pages(&["x", "y", "z"], 3) {
                    let Some(m) = safe("txt", &base, &mine, &theirs) else {
                        not += 1;
                        continue;
                    };
                    made += 1;
                    let case = format!("{base:?} {mine:?} {theirs:?} -> {:?}", m.text);
                    for w in ["x", "y", "z"] {
                        let (b, mi, th, o) = (count(&base, w), count(&mine, w), count(&theirs, w), count(&m.text, w));
                        let handed = m.conflicts.iter().any(|c| count(&c.theirs, w) > 0);
                        // what either wrote is in the text or handed back
                        assert!(o > 0 || handed || (mi == 0 && th == 0) || b > 0, "lost {w}: {case}");
                        if th == b {
                            assert_eq!(o, mi, "this window's {w}: {case}");
                        } else if mi == b && m.conflicts.is_empty() {
                            assert_eq!(o, th, "their {w}: {case}");
                        }
                        if b > 0 && mi <= b && th <= b {
                            assert!(o <= mi.max(th), "a {w} too many: {case}");
                        }
                    }
                    if mine == base {
                        assert_eq!(m.text.trim_end(), theirs.trim_end(), "{case}");
                    }
                    if theirs == base {
                        assert_eq!(m.text, mine, "{case}");
                    }
                }
            }
        }
        // most are made: the refusals are the moves and the repeats
        assert!(made > not * 3, "{made} made, {not} not");
    }

    #[test]
    fn edits_cuts_and_writes_of_blocks_that_stand_once_are_always_merged() {
        let base = ["A.", "B.", "C.", "D.", "E."];
        // each side does one thing to each block: 0 leaves it, 1 edits it, 2 cuts it, 3 writes a block after it
        let side = |ops: usize, tag: &str| -> String {
            let mut out = Vec::new();
            for (i, b) in base.iter().enumerate() {
                match (ops >> (2 * i)) & 3 {
                    1 => out.push(format!("{b} {tag}{i}")),
                    2 => {}
                    3 => out.extend([(*b).to_owned(), format!("new {tag}{i}")]),
                    _ => out.push((*b).to_owned()),
                }
            }
            out.join("\n\n")
        };
        for a in 0..1024 {
            for b in (0..1024).step_by(7) {
                assert!(safe("md", &base.join("\n\n"), &side(a, "m"), &side(b, "t")).is_some(), "{a} {b}");
            }
        }
    }

    #[test]
    fn source_is_merged_by_its_runs_of_lines() {
        let base = "a = 1\n\nb = 2\n\nc = 3\n";
        let got = merge3("js", base, &base.replace("a = 1", "a = 10"), &base.replace("c = 3", "c = 30"));
        assert_eq!((got.text.as_str(), got.conflicts.len()), ("a = 10\n\nb = 2\n\nc = 30\n", 0));
        assert_eq!(merge3("js", "", "", "x = 1\n").text, "x = 1\n");
    }
}
