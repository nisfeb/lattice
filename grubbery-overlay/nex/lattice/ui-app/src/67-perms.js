  // ── usergroups: the shared data layer ────────────────────────────────────
  // No UI of its own any more. The busy chip editor that used to live in the
  // editor's narrow right column moved to the full-window ACL pane (72-acl.js);
  // the right column now only SETS existing groups on the open file (66-share).
  // Both surfaces read permGroups and write through permSave, so they cannot
  // disagree about what is in force.
  //
  // Backed by grubbery usergroups via /share-groups. The vocabulary is read
  // (= weir peek) and edit (= weir make); poke grants and non-directory rules
  // are real but dojo territory — the server preserves them verbatim on every
  // save, and the ACL pane reports how many exist.
  let permGroups = [];
  // "no groups yet" and "not loaded yet" are different claims, and the group
  // list is deferred off boot's critical path — so without this the panel
  // asserts you have no groups for the second or two before the answer lands.
  let permsLoaded = false;
  async function loadPerms() {
    let r = null;
    try { r = await fetch(api + '/share-groups'); } catch {}
    if (!r || !r.ok) {
      st('could not load groups (' + (r ? r.status : 'network') + ')', false);
      return;
    }
    permGroups = await r.json();
    permsLoaded = true;
    // every surface that renders groups repaints from this one load
    if (typeof renderAcl === 'function') renderAcl();
    if (typeof renderGroupAccess === 'function') renderGroupAccess();
  }
  async function permSave(g) {
    const r = await fetch(api + '/share-group-save?name=' + encodeURIComponent(g.name), {
      method: 'POST',
      body: JSON.stringify({ ships: g.ships, peek: g.peek, make: g.make }),
    }).catch(() => null);
    if (!r || !r.ok) {
      let msg = r ? r.status : 'network';
      if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
      st('permissions: ' + msg, false);
    }
    // re-read either way: the server is the authority, and a failed save must
    // snap the panels back to what is actually in force rather than show the
    // grant the user believes they made.
    loadPerms();
  }
