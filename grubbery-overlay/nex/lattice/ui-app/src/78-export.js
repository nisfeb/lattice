  // ── vault: scheduled-backup hook ───────────────────────────────────────────
  // The tar writer/reader and the whole export/restore path moved to the shared,
  // standalone ui-app/vault.js (loaded before this bundle), so the editor, the
  // settings page and a scheduled backup all build the SAME archive. The manual
  // "export vault" / "restore vault" buttons moved to Settings; see +settings-html
  // and vault.js's mountSettings.
  //
  // What stays here is only what is editor-specific: teach vault.js this page's
  // status line and offline state, then expose the hook the desktop scheduler
  // reaches in with (it evals window.__latticeBackup on whatever workspace page
  // is showing, which is usually this editor).
  if (window.LatticeVault) {
    LatticeVault.configure({
      status: (m, ok) => st(m, ok),
      isDegraded: () => degraded || !!offCount,
    });
    if (window.__TAURI__) {
      window.__latticeBackup = (id) => LatticeVault.exportVault(id);
      // "back up now" clicked while the manager page was showing: no workspace
      // page existed to receive the eval, so Rust navigates here with
      // ?backup=<id> and the boot runs it (3s: let the tree land first).
      const pend = new URLSearchParams(location.search).get('backup');
      if (pend) setTimeout(() => window.__latticeBackup(pend), 3000);
    }
  }
