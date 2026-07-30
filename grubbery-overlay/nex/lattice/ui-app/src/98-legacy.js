  // ── legacy agent import (one-time offer) ─────────────────────────────────
  // A ship upgraded from the pre-grubbery %lattice gall agent may still have
  // it installed with knowledge this store never saw. Ask once, in-app, then
  // never again: the server marker is authoritative (it survives a new
  // browser), and the localStorage flag keeps resolved installs from spending
  // a request on the check at all.
  async function legacyCheck() {
    if (localStorage.latLegacy === 'done') return;
    let d = null;
    try { d = await (await fetch(api + '/legacy-status')).json(); } catch { return; }
    if (!d) return;
    // ONLY the server's marker is permanent. 'absent' can mean the agent is
    // merely suspended (|revive brings it back), and caching that as done
    // would silently strand the user's data forever. Never infer permanence
    // from a negative or transient answer.
    if (d.reason === 'resolved') { localStorage.latLegacy = 'done'; return; }
    if (!d.prompt) return;
    // Quiet for the session only once the user has actually DECLINED. Setting
    // this merely because the dialog was shown meant dismissing it (Esc, click
    // outside, or a reload mid-dialog) locked the offer out of that tab
    // entirely, with no way back short of a new tab.
    if (sessionStorage.latLegacyAsked === '1') return;
    const choice = await askChoice(
      'An older lattice agent is still installed on this ship, from before ' +
      'this store existed. Import the memories it holds?\n\nAnything already ' +
      'here is left exactly as it is, and nothing is removed from the old agent.',
      ['import them now', 'not now', 'never ask again'], 'ok');
    if (choice === null) return;            // dismissed — offer again next load
    if (choice === 'not now') {             // explicitly declined — quiet until
      sessionStorage.latLegacyAsked = '1';  // the next browser session
      return;
    }
    if (choice === 'never ask again') {
      await mutate(api + '/legacy-dismiss');
      localStorage.latLegacy = 'done';
      st('legacy import dismissed');
      return;
    }
    stWork('importing from the old agent… this can take a few minutes');
    let r = null;
    try { r = await mutate(api + '/legacy-migrate'); } catch {}
    if (!r || !r.ok) {
      // the import can outlive the request (one serial writer poke per entry).
      // Ask the server what actually happened before reporting a failure.
      let after = null;
      try { after = await (await fetch(api + '/legacy-status')).json(); } catch {}
      if (after && after.reason === 'resolved') {
        localStorage.latLegacy = 'done';
        knowGen++;
        if (mode === 'know') loadKnow();
        st('legacy import completed');
        return;
      }
      // 504/502 is the reverse proxy giving up, not the ship failing: the
      // import keeps running server-side and is usually PARTLY done. Say what
      // landed, and name the cause, because the fix is a proxy setting.
      const cut = r && (r.status === 504 || r.status === 502);
      let listed = null;
      try { listed = await (await fetch(api + '/know-list')).json(); } catch {}
      const have = listed && listed.keys ? listed.keys.length : null;
      st((cut ? 'the connection timed out mid-import' : 'legacy import failed' + (r ? ' ' + r.status : '')) +
         (have !== null ? ' — ' + have + ' memories are here now' : '') +
         ' · nothing was removed from the old agent · run it again to finish', false);
      if (cut) {
        await askConfirm(
          'The request was cut off before it finished — the ship kept working, ' +
          'so some of it landed' + (have !== null ? ' (' + have + ' memories now here)' : '') +
          '.\n\nNothing was lost and nothing was removed from the old agent. ' +
          'Run the import again to finish; anything already here is skipped, ' +
          'so it cannot duplicate.\n\nIf this keeps happening, the reverse ' +
          'proxy in front of this ship is closing long requests — raise ' +
          'proxy_read_timeout for it (nginx defaults to 60s).',
          'got it');
        delete sessionStorage.latLegacyAsked;   // let it offer again immediately
      }
      return;
    }
    const res = await r.json();
    // only latch when the SERVER says it finished; a partial run deliberately
    // leaves its marker unwritten so the offer returns and can be retried
    if (res.complete) localStorage.latLegacy = 'done';
    else delete sessionStorage.latLegacyAsked;
    knowGen++;
    st('imported ' + res.imported + ' memories from the old agent');
    if (mode === 'know') loadKnow(); else loadTree();
    // NEVER advise retiring the old agent while it still holds pages: this
    // import moves knowledge only (the agent exposes no arm for page bodies),
    // so an uninstall on that advice would destroy them permanently.
    const kept = res.imported + ' ' + (res.imported === 1 ? 'memory' : 'memories') +
      (res.skipped ? ' (' + res.skipped + ' already here, left untouched)' : '');
    const got = res.pagesImported || 0;
    let msg = 'Imported ' + kept + (got ? ', and ' + got + ' ' + (got === 1 ? 'page' : 'pages') : '') + '.';
    // The agent is cleared for retirement ONLY when the server says the whole
    // migration completed. Never infer it from a count: an unreadable page
    // list reads as zero pages, and telling someone to uninstall on that
    // would destroy the only copy of them.
    if (!res.complete) {
      const left = [];
      if (!res.pagesKnown) left.push('its page list could not be read');
      else if ((res.pages || 0) > got + (res.pagesCollided || 0))
        left.push(((res.pages || 0) - got - (res.pagesCollided || 0)) + ' page(s) did not arrive in time');
      if (res.pagesCollided) left.push(res.pagesCollided + ' page(s) share a name with pages you already have, so they were left alone');
      msg += '\n\nNot everything moved: ' + left.join('; ') + '.' +
        '\n\nThe old agent still holds the only copy — do NOT run ' +
        '|uninstall %lattice. Reopen the editor to retry; you will be asked again.';
    } else {
      msg += '\n\nEverything it held is now here. Once you have checked your ' +
        'pages and memories, you can retire it from the dojo:\n\n    |uninstall %lattice';
    }
    await askConfirm(msg, 'got it');
    loadTree();
  }
