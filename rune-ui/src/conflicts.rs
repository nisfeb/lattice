//! Sync conflict inbox helpers, ported from `ui-src/lattice/80-conflicts.js`.
//! Conflicts are regular pages under `conflicts/` created when a concurrent or
//! offline save loses a race.

/// All conflict page paths from the ship's page list, sorted.
pub fn list(pages: &[String]) -> Vec<String> {
    let mut out: Vec<String> = pages
        .iter()
        .filter(|p| p.starts_with("conflicts/"))
        .cloned()
        .collect();
    out.sort();
    out
}

/// Best-effort inverse of the ship's `conflict-name` (`conflicts/<name-with-dashes>-rev<N>`).
/// Strips `conflicts/` and trailing `-rev<digits>`, then replaces `-` with `/`.
pub fn original(path: &str) -> Option<String> {
    let rest = path.strip_prefix("conflicts/")?;
    let (stem, rev) = rest.rsplit_once("-rev")?;
    if stem.is_empty() || rev.is_empty() || !rev.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(stem.replace('-', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_and_resolves_conflict_origins() {
        let pages = vec![
            "welcome".into(),
            "conflicts/notes-plan-rev4".into(),
            "conflicts/a-rev1".into(),
            "conflicts/offline-edit-notes-20261125".into(),
        ];
        assert_eq!(
            list(&pages),
            vec!["conflicts/a-rev1", "conflicts/notes-plan-rev4", "conflicts/offline-edit-notes-20261125"]
        );
        assert_eq!(original("conflicts/notes-plan-rev4").as_deref(), Some("notes/plan"));
        assert_eq!(original("conflicts/a-rev1").as_deref(), Some("a"));
        assert_eq!(original("conflicts/offline-edit-notes-20261125"), None);
        assert_eq!(original("conflicts/-rev1"), None);
        assert_eq!(original("notes/plan"), None);
    }
}
