  // ── permission editor: <lat-perms> — who can read/edit which files ───────
  // Backed by grubbery usergroups via /share-groups. The vocabulary here is
  // read (= weir peek) and edit (= weir make); poke grants and non-directory
  // rules are real but dojo territory — the server preserves them verbatim on
  // every save, and this panel only says how many exist.
  customElements.define('lat-perms', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="permsec">
<h3>peers</h3>
<div id="permlist" class="muted">loading…</div>
<div class="row"><input id="permname" placeholder="new group (e.g. friends)" autocomplete="off"><button id="permadd">group</button></div>
</div>`;
    }
  });
  let permGroups = [];
  async function loadPerms() {
    let r = null;
    try { r = await fetch(api + '/share-groups'); } catch {}
    if (!r || !r.ok) { $('permlist').textContent = 'could not load groups (' + (r ? r.status : 'network') + ')'; return; }
    permGroups = await r.json();
    renderPerms();
    // the full pane (72-acl.js) renders the same permGroups — repaint it from
    // the same load so the two surfaces can never show different ACLs
    if (typeof renderAcl === 'function') renderAcl();
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
    // snap the panel back to what is actually in force rather than show the
    // grant the user believes they made.
    loadPerms();
  }
  function chipRow(host, items, label, onDel) {
    const row = document.createElement('div');
    row.className = 'chips';
    if (label) {
      const l = document.createElement('span');
      l.className = 'muted';
      l.textContent = label;
      row.appendChild(l);
    }
    for (const it of items) {
      const a = document.createElement('a');
      a.textContent = it + ' ×';
      a.title = 'remove';
      a.onclick = () => onDel(it);
      row.appendChild(a);
    }
    host.appendChild(row);
    return row;
  }
  function renderPerms() {
    const host = $('permlist');
    host.textContent = '';
    host.className = '';
    if (!permGroups.length) {
      host.className = 'muted';
      host.textContent = 'no groups yet — a group names ships and what they may read or edit.';
      return;
    }
    for (const g of permGroups) {
      const box = document.createElement('div');
      box.className = 'grp';
      const h = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = g.name;
      const del = document.createElement('button');
      del.textContent = '×';
      del.className = 'ico';
      del.title = 'delete group';
      del.onclick = async () => {
        if (!(await askConfirm('delete group ' + g.name + ' and every grant it carries?', 'delete'))) return;
        await fetch(api + '/share-group-del?name=' + encodeURIComponent(g.name), { method: 'POST' }).catch(() => null);
        loadPerms();
      };
      h.appendChild(b); h.appendChild(del);
      box.appendChild(h);
      chipRow(box, g.ships, 'ships', (v) => { g.ships = g.ships.filter((x) => x !== v); permSave(g); });
      const srow = document.createElement('div');
      srow.className = 'row';
      const sin = document.createElement('input');
      sin.placeholder = '~ship';
      const sadd = document.createElement('button');
      sadd.textContent = 'add ship';
      sadd.onclick = () => {
        const v = sin.value.trim();
        if (!v) return;
        if (!g.ships.includes(v)) { g.ships.push(v); permSave(g); }
        sin.value = '';
      };
      srow.appendChild(sin); srow.appendChild(sadd);
      box.appendChild(srow);
      chipRow(box, g.peek, 'read', (v) => { g.peek = g.peek.filter((x) => x !== v); permSave(g); });
      chipRow(box, g.make, 'edit', (v) => { g.make = g.make.filter((x) => x !== v); permSave(g); });
      const prow = document.createElement('div');
      prow.className = 'row';
      const pin = document.createElement('input');
      pin.placeholder = '/apps/lattice.lattice_app/pub';
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
      box.appendChild(prow);
      if ((g.poke && g.poke.length) || g.opaque) {
        const m = document.createElement('div');
        m.className = 'muted';
        const parts = [];
        if (g.poke && g.poke.length) parts.push(g.poke.length + ' poke');
        if (g.opaque) parts.push(g.opaque + ' advanced');
        m.textContent = parts.join(' + ') + ' rule(s) managed outside this panel — preserved on save.';
        box.appendChild(m);
      }
      host.appendChild(box);
    }
  }
  $('permadd').onclick = async () => {
    const v = $('permname').value.trim();
    if (!v) return;
    await permSave({ name: v, ships: [], peek: [], make: [] });
    $('permname').value = '';
  };
  // NOT called here: at parse time this put a pier round-trip AHEAD of the
  // tree and the open page, and the pier serializes — nothing about reading or
  // editing needs the group list. Boot calls it once the editor is usable.
