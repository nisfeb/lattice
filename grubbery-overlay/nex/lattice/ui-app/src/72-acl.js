  // ── access control pane: <lat-acl>, the peers panel with room to work ────
  // Same data and same endpoints as the narrow editor panel (67-perms.js).
  // This is a full-window overlay for organising it. Deliberately NOT a third
  // setMode branch. setMode is wired into the tree/editor lifecycle and access
  // control has nothing to do with either (same reasoning as 40-grub.js).
  //
  // Costs no boot requests. It renders permGroups, which boot already loads
  // off the critical path, and only fetches if the pane is opened before that
  // landed. Every mutation goes through permSave, so the narrow panel and this
  // one can never disagree.
  //
  // POKE GRANTS ARE READ-ONLY HERE, deliberately. The server preserves them
  // verbatim on save and refuses to set them from the editor ("the editor has
  // no business granting eval power"). A grant of eval capability stays a
  // dojo-level act. They are shown so this pane never hides live rules.
  customElements.define('lat-acl', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="aclwrap" hidden role="dialog" aria-modal="true" aria-label="access control">
  <div class="aclbar">
    <h2>Access control</h2>
    <span class="muted" id="aclsum"></span>
    <span class="grow"></span>
    <button id="aclreload" class="ico" title="reload from ship">&#8635;</button>
    <button id="aclclose">close</button>
  </div>
  <div class="aclbody">
    <div class="row">
      <input id="aclnew" placeholder="new group name (e.g. friends)" autocomplete="off">
      <button id="aclnewbtn">create group</button>
    </div>
    <div id="aclgrid" class="aclgrid"></div>
    <div class="aclban">
      <h4>banned ships</h4>
      <p class="aclnote">A banned ship cannot share anything with you and
      cannot be granted access — banning revokes what it already had. It does
      NOT hide pages you have published: those are readable by anyone, so
      unpublish to stop a read.</p>
      <div class="row">
        <input id="banship" placeholder="~ship" autocomplete="off" spellcheck="false">
        <button id="banadd">ban</button>
      </div>
      <div id="banlist" class="chips"></div>
    </div>
  </div>
  <datalist id="aclpaths"></datalist>
</div>`;
    }
  });

  const aclOpen = () => {
    $('aclwrap').hidden = false;
    aclPathOptions();
    // permGroups is populated by boot's deferred load. Only pay a request if
    // the pane was opened before that landed.
    if (!permGroups.length) loadPerms(); else renderAcl();
    loadBans();
  };
  const aclClose = () => { $('aclwrap').hidden = true; };

  // suggest the grantable paths this client already knows about, so a grant is
  // a pick rather than a hand-typed ball path. Built from the tree we have.
  function aclPathOptions() {
    const dl = $('aclpaths');
    if (!dl) return;
    dl.textContent = '';
    const base = '/apps/lattice.lattice_app';
    const seen = new Set([base + '/pub', base + '/page']);
    for (const n of nodes) seen.add(base + '/page/' + n.path);
    for (const p of seen) {
      const o = document.createElement('option');
      o.value = p;
      dl.appendChild(o);
    }
  }

  function aclChips(host, items, onDel, label) {
    const row = document.createElement('div');
    row.className = 'chips';
    if (!items.length) {
      const e = document.createElement('span');
      e.className = 'aclnote';
      e.textContent = 'none';
      row.appendChild(e);
    }
    for (const it of items) {
      const a = document.createElement('a');
      a.textContent = (label ? label(it) : it) + ' ×';
      a.title = 'remove ' + it;
      a.onclick = () => onDel(it);
      row.appendChild(a);
    }
    host.appendChild(row);
  }

  function aclSection(card, label, items, onDel, disp) {
    const h = document.createElement('h4');
    h.textContent = label;
    card.appendChild(h);
    aclChips(card, items, onDel, disp);
  }

  // the card's title bar: the group's name, and the button that removes it
  function aclHead(g) {
    const head = document.createElement('header');
    const b = document.createElement('b');
    b.textContent = g.name;
    const del = document.createElement('button');
    del.textContent = 'delete';
    del.className = 'acl-del';
    del.onclick = async () => {
      if (!(await askConfirm('delete group ' + g.name + ' and every grant it carries?', 'delete'))) return;
      const r = await fetch(api + '/share-group-del?name=' + encodeURIComponent(g.name),
        { method: 'POST' }).catch(() => null);
      // loadPerms repaints from the ship either way, so a delete that failed
      // and a group that came back on its own look identical. Say which it
      // was, the rule permSave and the ban handler already follow.
      if (!r || !r.ok) st('could not delete ' + g.name + await errText(r), false);
      loadPerms();
    };
    head.appendChild(b); head.appendChild(del);
    return head;
  }

  // who is in the group: the chips, and the row that adds one more
  function aclShips(card, g) {
    aclSection(card, 'ships', g.ships, (v) => {
      g.ships = g.ships.filter((x) => x !== v); permSave(g);
    });
    const srow = document.createElement('div');
    srow.className = 'row';
    const sin = document.createElement('input');
    sin.placeholder = '~ship';
    sin.autocomplete = 'off';
    const sadd = document.createElement('button');
    sadd.textContent = 'add ship';
    const addShip = () => {
      const v = sin.value.trim();
      if (!v) return;
      if (!g.ships.includes(v)) { g.ships.push(v); permSave(g); }
      sin.value = '';
    };
    sadd.onclick = addShip;
    sin.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addShip(); } };
    srow.appendChild(sin); srow.appendChild(sadd);
    card.appendChild(srow);
  }

  // granting a path: one input, and the two buttons that say how far it goes
  function aclPathRow(card, g) {
    const prow = document.createElement('div');
    prow.className = 'row';
    const pin = document.createElement('input');
    pin.placeholder = '/apps/lattice.lattice_app/pub';
    pin.setAttribute('list', 'aclpaths');
    pin.autocomplete = 'off';
    const radd = document.createElement('button');
    radd.textContent = '+read';
    const eadd = document.createElement('button');
    eadd.textContent = '+edit';
    const addPath = (edit) => {
      const v = pin.value.trim();
      if (!v) { st('enter a path to grant', false); return; }
      if (!g.peek.includes(v)) g.peek.push(v);           // edit implies read
      if (edit && !g.make.includes(v)) g.make.push(v);
      permSave(g);
      pin.value = '';
    };
    radd.onclick = () => addPath(false);
    eadd.onclick = () => addPath(true);
    prow.appendChild(pin); prow.appendChild(radd); prow.appendChild(eadd);
    card.appendChild(prow);
  }

  // the grants this pane carries but will not let you edit
  function aclReadOnlyNote(card, g) {
    if (!(g.poke && g.poke.length) && !g.opaque) return;
    const h = document.createElement('h4');
    h.textContent = 'not editable here';
    card.appendChild(h);
    const m = document.createElement('div');
    m.className = 'aclnote';
    const parts = [];
    if (g.poke && g.poke.length) parts.push(g.poke.length + ' poke grant(s)');
    if (g.opaque) parts.push(g.opaque + ' advanced rule(s)');
    m.textContent = parts.join(' + ') +
      ' — preserved exactly as they are on every save. Poke grants eval' +
      ' power, so they stay a dojo-level act.';
    card.appendChild(m);
    if (g.poke && g.poke.length) {
      const l = document.createElement('div');
      l.className = 'aclnote';
      l.textContent = g.poke.join(', ');
      card.appendChild(l);
    }
  }

  // one card, one group. `disp` shortens a path against the whole pane.
  function aclCard(g, disp) {
    const card = document.createElement('div');
    card.className = 'aclcard';
    card.appendChild(aclHead(g));
    aclShips(card, g);
    aclSection(card, 'read', g.peek, (v) => {
      // dropping read must drop edit too. Edit without read is a grant that
      // cannot be exercised, and it would silently reappear as "read" on the
      // next save because addPath re-adds it.
      g.peek = g.peek.filter((x) => x !== v);
      g.make = g.make.filter((x) => x !== v);
      permSave(g);
    }, disp);
    aclSection(card, 'edit', g.make, (v) => {
      g.make = g.make.filter((x) => x !== v); permSave(g);
    }, disp);
    aclPathRow(card, g);
    aclReadOnlyNote(card, g);
    return card;
  }

  function renderAcl() {
    const grid = $('aclgrid');
    if (!grid) return;
    grid.textContent = '';
    $('aclsum').textContent = permGroups.length
      ? permGroups.length + ' group' + (permGroups.length === 1 ? '' : 's')
      : '';
    if (!permGroups.length) {
      const e = document.createElement('div');
      e.className = 'aclempty';
      e.textContent = 'No groups yet. A group names ships and what they may read or edit.';
      grid.appendChild(e);
      return;
    }
    // one disambiguation scope for the whole pane, so the same page shows
    // the same short name in every card
    const allPaths = permGroups.flatMap((x) => [...x.peek, ...x.make]);
    const disp = (v) => shortPath(v, allPaths);
    for (const g of permGroups) grid.appendChild(aclCard(g, disp));
  }

  // ── banlist ──────────────────────────────────────────────────────────────
  // Deny is not something a weir can say, so it is the app's own list. Banning
  // revokes group membership server-side. The response says how many groups
  // changed, because "banned" with grants still live would be a lie.
  let banned = [];
  async function loadBans() {
    try {
      const r = await fetch(api + '/banlist');
      if (!r.ok) return;
      banned = await r.json();
    } catch { return; }
    renderBans();
  }
  function renderBans() {
    const host = $('banlist');
    if (!host) return;
    host.textContent = '';
    if (!banned.length) {
      const e = document.createElement('span');
      e.className = 'aclnote';
      e.textContent = 'nobody is banned.';
      host.appendChild(e);
      return;
    }
    for (const w of banned) {
      const a = document.createElement('a');
      a.textContent = w + ' ×';
      a.title = 'unban ' + w;
      a.onclick = async () => {
        const r = await fetch(api + '/unban?ship=' + encodeURIComponent(w), { method: 'POST' })
          .catch(() => null);
        // announce the unban only once the ship has agreed to it
        if (!r || !r.ok) st('could not unban ' + w + await errText(r), false);
        else st('unbanned ' + w + ' — it holds no access until you grant it again');
        loadBans();
      };
      host.appendChild(a);
    }
  }
  $('banadd').onclick = async () => {
    const w = $('banship').value.trim();
    if (!w) return;
    // banning revokes every grant the ship holds right now, and unban does
    // not bring them back (the nexus is explicit about that) — a mistyped
    // ship name is a permanent loss with no online undo, so ask first the
    // way delete already does.
    if (!(await askConfirm('ban ' + w + '? this revokes every grant it holds, and unban will not restore them', 'ban'))) return;
    const r = await fetch(api + '/ban?ship=' + encodeURIComponent(w), { method: 'POST' })
      .catch(() => null);
    if (!r || !r.ok) { st('could not ban ' + w + await errText(r), false); return; }
    const j = await r.json().catch(() => ({}));
    st('banned ' + w + (j.revoked ? ' — revoked from ' + j.revoked + ' group(s)' : ''));
    $('banship').value = '';
    loadBans();
    loadPerms();          // membership changed server-side. Repaint the groups
  };
  $('banship').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('banadd').click(); }
  };

  $('aclclose').onclick = aclClose;
  $('aclreload').onclick = () => { loadPerms(); loadBans(); };
  $('aclnewbtn').onclick = async () => {
    const v = $('aclnew').value.trim();
    if (!v) return;
    await permSave({ name: v, ships: [], peek: [], make: [] });
    $('aclnew').value = '';
  };
  $('aclnew').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('aclnewbtn').click(); }
  };
  $('aclt').onclick = aclOpen;
  // Escape closes, matching the in-app dialog's behaviour
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('aclwrap').hidden) aclClose();
  });
