/* The Skills tool tab: the ship's skills store (SKILL.md in the Agent Skills
 * format, plus optional files), over the /apps/lattice/skill* routes.
 *
 * Served standalone at /apps/lattice/app/skills.js?h=H and loaded by the
 * editor the first time the tab opens (ui-src/lattice/95s-skills.js), so
 * app.js carries only the hook. Hand-written, not built. It draws into the
 * tab's wrap (#skwrap) and reaches the editor only through the ctx the hook
 * passes: api, st (the status line), ask, askConfirm, askDanger (the shell
 * dialog) and md (the local markdown renderer, which escapes everything).
 *
 * The editor is the owner's, so every route is open to it: edit and save,
 * tag and untag (core too), mark or clear sensitive, delete and restore from
 * the trash, files, and history with any old revision. */
(function () {
  'use strict';
  let ctx = null, wrap = null;
  let list = [], loadedAt = 0, loading = null;
  let tagF = '', query = '';
  // the skill open on the right: its GET skill answer, the file in view and
  // that file's text and updated, whether it is being edited, and an old
  // revision when one is shown instead
  let cur = null;
  const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
  const EXT = /\.(md|txt|json|yaml|yml)$/;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const btn = (text, id, on) => {
    const b = el('button', 'skb', text);
    b.type = 'button';
    if (id) b.id = id;
    if (on) b.onclick = on;
    return b;
  };
  const q = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  // ~2026.11.5..14.3.22..abcd -> 2026-11-05 14:03 UTC
  const pad = (n) => ('0' + n).slice(-2);
  const day = (da) => {
    if (!da || da[0] !== '~') return da || '';
    const p = da.slice(1).split('..'), d = p[0].split('.'), t = (p[1] || '').split('.');
    return d[0] + '-' + pad(d[1]) + '-' + pad(d[2]) + (p[1] ? ' ' + pad(t[0]) + ':' + pad(t[1] || 0) + ' UTC' : '');
  };
  const validName = (n) => n.length >= 1 && n.length <= 64 && NAME.test(n);
  const validPath = (p) => PATH.test(p) && !p.split('/').some((s) => s === '.' || s === '..') && EXT.test(p);

  async function err(r) {
    let m = r ? ' ' + r.status : ' (offline)';
    if (r) { try { const j = await r.json(); if (j && j.error) m = ': ' + j.error; } catch {} }
    return m;
  }
  async function get(path) {
    let r = null;
    try { r = await fetch(ctx.api + path); } catch {}
    if (!r || !r.ok) return { fail: await err(r), status: r ? r.status : 0 };
    return { d: await r.json() };
  }
  async function post(path, body) {
    let r = null;
    try {
      r = await fetch(ctx.api + path, { method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' }, body: body === undefined ? '' : body });
    } catch {}
    if (!r || !r.ok) return { fail: await err(r) };
    let d = {};
    try { d = await r.json(); } catch {}
    return { d };
  }

  const CSS = `
#skwrap .skgrid { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(240px, 340px) 1fr; }
#skwrap .skside { border-right: 1px solid var(--border-soft); overflow: auto; padding: 10px; }
#skwrap .skmain { overflow: auto; padding: 14px 18px; min-width: 0; }
#skwrap .skb { font: inherit; font-size: .8rem; padding: 4px 10px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--surface); color: inherit; cursor: pointer; }
#skwrap .skb:hover:not(:disabled) { border-color: var(--green); }
#skwrap .skb:disabled { opacity: .5; cursor: default; }
#skwrap .skb.on { border-color: var(--green); color: var(--green); }
#skwrap .skb.pri { background: var(--green); border-color: var(--green-deep); color: var(--on-accent, #fff); }
#skwrap .skb.danger { color: var(--err); border-color: var(--err-soft); }
#skwrap input.skin { font: inherit; font-size: .85rem; width: 100%; box-sizing: border-box; padding: 5px 8px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: inherit; }
#skwrap .sksec { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 10px 4px 4px; }
#skwrap .skrow { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none;
  border: 0; border-radius: 6px; padding: 6px 8px; cursor: pointer; }
#skwrap .skrow:hover { background: var(--surface); }
#skwrap .skrow.cur { background: var(--accent-tint, #4a7c5922); }
#skwrap .skrow.cur .skn { color: var(--green); }
#skwrap .skn { font-weight: 600; }
#skwrap .skd { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  font-size: .82rem; margin: 2px 0; }
#skwrap .skm, #skwrap .skmeta { font-size: .74rem; color: var(--muted); }
#skwrap .skpill { display: inline-block; font-size: .7rem; padding: 0 6px; margin-left: 6px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--muted); font-weight: normal; vertical-align: 1px; }
#skwrap .skpill.sens { border-color: #b8860b; color: #b8860b; }
#skwrap .skpill.core { border-color: var(--green); color: var(--green); }
#skwrap .skhead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
#skwrap .skhead h3 { margin: 0; font-size: 1.15rem; }
#skwrap .skacts, #skwrap .skfiles, #skwrap .sktags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 10px 0; }
#skwrap .sktags a { padding: 2px 9px; border: 1px solid var(--border); border-radius: 999px; font-size: .76rem;
  cursor: pointer; background: var(--surface); }
#skwrap .sktags a:hover { border-color: var(--err); color: var(--err); }
#skwrap .sktags input.skin { width: 9rem; }
#skwrap .skfiles .skb.on { font-weight: 600; }
#skwrap .skpanel { border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
  padding: 8px 10px; margin: 8px 0; font-size: .82rem; }
#skwrap .skpanel .skr { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
#skwrap .skpanel .skr span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
#skwrap .skrev { border-color: #b8860b; }
#skwrap .skfm { font-family: var(--ed-font, ui-monospace, monospace); font-size: .78rem; color: var(--muted);
  white-space: pre-wrap; margin: 0 0 10px; padding: 8px 10px; border-left: 3px solid var(--border); }
#skwrap .sksrc { font-family: var(--ed-font, ui-monospace, monospace); font-size: .85rem; white-space: pre-wrap;
  overflow-wrap: anywhere; margin: 0; }
#skwrap textarea.sktext { width: 100%; box-sizing: border-box; min-height: 60vh; resize: vertical;
  font-family: var(--ed-font, ui-monospace, monospace); font-size: var(--ed-size, 13px); padding: 10px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: inherit; }
#skwrap textarea.sktext:focus { outline: none; border-color: var(--green); }
#skwrap .skerr { color: var(--err); font-size: .82rem; white-space: pre-wrap; }
#skwrap .skrend { max-width: 80ch; }
@media (max-width: 820px) {
  #skwrap .skgrid { grid-template-columns: 1fr; grid-auto-rows: max-content; overflow: auto; }
  #skwrap .skside { border-right: 0; border-bottom: 1px solid var(--border-soft); max-height: 40vh; }
  #skwrap input.skin { font-size: 16px; }
}`;

  function build() {
    if (!q('skstyle')) {
      const s = el('style');
      s.id = 'skstyle';
      s.textContent = CSS;
      document.head.append(s);
    }
    wrap.textContent = '';
    const bar = el('div', 'aclbar');
    bar.append(el('h2', '', 'Skills'), Object.assign(el('span', 'muted'), { id: 'sksum' }), el('span', 'grow'),
      btn('New skill', 'sknew', newSkill), btn('Trash', 'sktrash', toggleTrash),
      btn('Refresh', 'skrefresh', () => loadList(true)));
    const grid = el('div', 'skgrid');
    const side = el('aside', 'skside');
    const qi = el('input', 'skin');
    qi.id = 'skq';
    qi.type = 'search';
    qi.placeholder = 'filter skills';
    qi.setAttribute('aria-label', 'filter skills');
    qi.oninput = () => { query = qi.value.trim().toLowerCase(); renderList(); };
    const trash = el('div', 'skpanel');
    trash.id = 'sktrashlist';
    trash.hidden = true;
    const chips = el('div', 'chips');
    chips.id = 'skchips';
    const lst = el('div');
    lst.id = 'sklist';
    lst.append(el('div', 'muted', 'loading skills…'));
    side.append(qi, trash, chips, el('div', 'sksec', 'skills'), lst);
    const main = el('div', 'skmain');
    main.id = 'skmain';
    main.append(el('p', 'muted', 'Pick a skill to read it, or make a new one. A skill is a SKILL.md, with a name and a description in its front matter, and any files it needs.'));
    grid.append(side, main);
    wrap.append(bar, grid);
  }

  function show(w, c) {
    ctx = c;
    if (wrap !== w || !q('sklist')) { wrap = w; build(); renderList(); }
    if (!loadedAt || Date.now() - loadedAt > 60000) loadList();
  }

  // ── the list ────────────────────────────────────────────────────────────
  function loadList(force) {
    if (loading && !force) return loading;
    loading = (async () => {
      const g = await get('/skills');
      loading = null;
      if (g.fail) {
        ctx.st('skills failed' + g.fail, false);
        const l = q('sklist');
        if (l && !list.length) l.replaceChildren(el('div', 'skerr', 'the skills did not load' + g.fail));
        return;
      }
      list = g.d.skills || [];
      loadedAt = Date.now();
      renderList();
    })();
    return loading;
  }
  const pills = (s, into) => {
    if ((s.tags || []).includes('core')) into.append(el('span', 'skpill core', 'core'));
    if (s.sensitive) into.append(el('span', 'skpill sens', 'sensitive'));
    if (s.superseded_by) into.append(el('span', 'skpill', 'superseded'));
  };
  function renderList() {
    const l = q('sklist'), chips = q('skchips'), sum = q('sksum');
    if (!l) return;
    const tags = [...new Set(list.flatMap((s) => s.tags || []))].sort();
    if (tagF && !tags.includes(tagF)) tagF = '';
    chips.textContent = '';
    if (tags.length) {
      for (const [label, v] of [['all', ''], ...tags.map((t) => ['#' + t, t])]) {
        const a = el('a', tagF === v ? 'on' : '', label);
        a.onclick = () => { tagF = v; renderList(); };
        chips.append(a);
      }
    }
    const shown = list.filter((s) => (!tagF || (s.tags || []).includes(tagF))
      && (!query || s.name.includes(query) || String(s.description || '').toLowerCase().includes(query)));
    sum.textContent = loadedAt ? list.length + (list.length === 1 ? ' skill' : ' skills') : '';
    l.textContent = '';
    if (!shown.length) {
      l.append(el('div', 'muted', loadedAt ? (list.length ? 'no skill matches' : 'no skills yet. New skill starts one.') : 'loading skills…'));
      return;
    }
    for (const s of shown) {
      const r = el('button', 'skrow' + (cur && cur.name === s.name ? ' cur' : ''));
      r.type = 'button';
      r.dataset.skill = s.name;
      const n = el('div', 'skn', s.name);
      pills(s, n);
      const m = [s.author ? 'by ' + s.author : 'by you', day(s.updated)];
      if (s.files) m.push(s.files + (s.files === 1 ? ' file' : ' files'));
      const ot = (s.tags || []).filter((t) => t !== 'core');
      if (ot.length) m.push(ot.map((t) => '#' + t).join(' '));
      r.append(n, el('div', 'skd', s.description || ''), el('div', 'skm', m.join(' · ')));
      r.onclick = () => openSkill(s.name);
      l.append(r);
    }
  }

  // ── trash ───────────────────────────────────────────────────────────────
  function toggleTrash() {
    const t = q('sktrashlist'), b = q('sktrash');
    t.hidden = !t.hidden;
    b.classList.toggle('on', !t.hidden);
    if (!t.hidden) loadTrash();
  }
  async function loadTrash() {
    const t = q('sktrashlist');
    t.replaceChildren(el('div', 'muted', 'loading trash…'));
    const g = await get('/skill-trash');
    if (t.hidden) return;
    if (g.fail) { t.replaceChildren(el('div', 'skerr', 'the trash did not load' + g.fail)); return; }
    const ss = (g.d.skills || []).slice().sort((a, b) => (a.name < b.name ? -1 : 1));
    t.replaceChildren(el('div', 'sksec', 'trash · ' + ss.length));
    if (!ss.length) { t.append(el('div', 'muted', 'nothing in the trash')); return; }
    for (const s of ss) {
      const r = el('div', 'skr');
      r.dataset.skill = s.name;
      const b = btn('restore', '', async () => {
        b.disabled = true;
        const p = await post('/skill-restore?name=' + enc(s.name));
        if (p.fail) { b.disabled = false; ctx.st('restore failed' + p.fail, false); return; }
        ctx.st('restored ' + s.name);
        loadTrash();
        loadList(true);
      });
      r.append(el('span', '', s.name + (s.updated ? '  (' + day(s.updated) + ')' : '')), b);
      t.append(r);
    }
  }

  // ── a skill ─────────────────────────────────────────────────────────────
  const editing = () => !!(cur && cur.edit);
  const unsaved = () => editing() && q('sktext') && q('sktext').value !== cur.text;
  async function leaveOk() {
    if (!unsaved()) return true;
    return ctx.askConfirm('Discard your unsaved edits to ' + cur.name + ' ' + cur.path + '?', 'discard');
  }
  async function openSkill(name, path, opts = {}) {
    if (!opts.force && !(await leaveOk())) return false;
    const g = await get('/skill?name=' + enc(name));
    if (g.fail) {
      ctx.st('open failed' + g.fail, false);
      if (g.status === 404) loadList(true);
      return false;
    }
    cur = { name, d: g.d, path: 'SKILL.md', text: g.d.body, updated: g.d.updated, edit: false, rev: null, hist: null };
    if (path && path !== 'SKILL.md') {
      if (!(await loadFile(path))) path = 'SKILL.md';
    }
    if (opts.edit) cur.edit = true;
    // the list carries what GET skill says, so a stale row mends itself
    const i = list.findIndex((s) => s.name === name);
    const row = { name, description: g.d.description, tags: g.d.tags || [], updated: g.d.updated,
      author: g.d.author || '', sensitive: !!g.d.sensitive, superseded_by: g.d.superseded_by || null,
      files: (g.d.files || []).filter((f) => f.path !== 'SKILL.md').length };
    if (i >= 0) Object.assign(list[i], row);
    else {
      list.push(row);
      list.sort((a, b) => (a.name < b.name ? -1 : 1));
    }
    renderList();
    renderSkill();
    return true;
  }
  async function loadFile(path) {
    const g = await get('/skill-file?name=' + enc(cur.name) + '&path=' + enc(path));
    if (g.fail) { ctx.st('could not read ' + path + g.fail, false); return false; }
    cur.path = path;
    cur.text = g.d.body;
    cur.updated = g.d.updated;
    return true;
  }
  async function pickFile(path) {
    if (!(await leaveOk())) return;
    cur.edit = false;
    cur.rev = null;
    if (path === 'SKILL.md') { cur.path = path; cur.text = cur.d.body; cur.updated = cur.d.updated; }
    else if (!(await loadFile(path))) return;
    renderSkill();
  }
  // front matter apart from the markdown under it, for the rendered view
  const splitFm = (t) => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(t);
    return m ? [m[1], t.slice(m[0].length)] : ['', t];
  };

  function renderSkill() {
    const main = q('skmain');
    if (!main) return;
    main.textContent = '';
    if (!cur) {
      main.append(el('p', 'muted', 'Pick a skill to read it, or make a new one.'));
      return;
    }
    const d = cur.rev ? cur.rev.d : cur.d;
    const head = el('div', 'skhead');
    const h = el('h3', '', cur.name);
    h.id = 'skname';
    head.append(h);
    pills(cur.d, head);
    main.append(head);
    if (d.description) main.append(el('p', '', d.description));
    const meta = [cur.d.author ? 'by ' + cur.d.author : 'by you', 'updated ' + day(cur.d.updated)];
    if (cur.d.superseded_by) meta.push('superseded by ' + cur.d.superseded_by);
    const mt = el('div', 'skmeta', meta.join(' · '));
    mt.id = 'skmeta';
    main.append(mt);

    // tags: core is a toggle of its own below; the rest are chips here
    const tg = el('div', 'sktags');
    tg.id = 'sktags';
    for (const t of (cur.d.tags || []).slice().sort()) {
      if (t === 'core') continue;
      const a = el('a', '', '#' + t + ' ×');
      a.title = 'remove #' + t;
      a.onclick = () => setTag(t, false);
      tg.append(a);
    }
    const ti = el('input', 'skin');
    ti.id = 'sktagin';
    ti.placeholder = 'tag';
    ti.setAttribute('aria-label', 'add a tag');
    const tb = btn('add tag', 'sktagadd', () => {
      const t = ti.value.trim().toLowerCase();
      if (t) setTag(t, true);
    });
    ti.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); tb.click(); } };
    tg.append(ti, tb);
    main.append(tg);

    const acts = el('div', 'skacts');
    const ro = !!cur.rev;
    if (cur.edit) {
      const sv = btn('Save', 'sksave', save);
      sv.classList.add('pri');
      acts.append(sv, btn('Cancel', 'skcancel', async () => {
        if (!(await leaveOk())) return;
        cur.edit = false;
        renderSkill();
      }));
    } else {
      const e = btn('Edit', 'skedit', () => { cur.edit = true; renderSkill(); const ta = q('sktext'); if (ta) ta.focus(); });
      e.disabled = ro;
      acts.append(e);
    }
    const isCore = (cur.d.tags || []).includes('core');
    const cb = btn(isCore ? 'Core: on' : 'Core: off', 'skcore', () => setTag('core', !isCore));
    cb.classList.toggle('on', isCore);
    cb.title = 'core skills are the ones an agent loads first';
    cb.setAttribute('aria-pressed', isCore ? 'true' : 'false');
    const sb = btn(cur.d.sensitive ? 'Sensitive: on' : 'Sensitive: off', 'sksens', () => setSensitive(!cur.d.sensitive));
    sb.classList.toggle('on', !!cur.d.sensitive);
    sb.title = 'a sensitive skill is hidden from agent keys without clearance';
    sb.setAttribute('aria-pressed', cur.d.sensitive ? 'true' : 'false');
    const hb = btn('History', 'skhist', toggleHist);
    hb.classList.toggle('on', !!cur.hist);
    const del = btn('Delete', 'skdel', delSkill);
    del.classList.add('danger');
    for (const b of [cb, sb]) b.disabled = cur.edit || ro;
    del.disabled = cur.edit;
    acts.append(cb, sb, hb, del);
    main.append(acts);

    if (cur.hist) main.append(histPanel());
    if (cur.rev) {
      const rv = el('div', 'skpanel skrev');
      rv.id = 'skrevbar';
      rv.append(el('div', '', 'Revision ' + cur.rev.rev + ' of SKILL.md, from ' + day(cur.rev.d.updated) + '. Read only.'));
      const row = el('div', 'skacts');
      const back = btn('Back to current', 'skrevback', () => { cur.rev = null; renderSkill(); });
      const rs = btn('Restore this revision', 'skrevrestore', restoreRev);
      row.append(back, rs);
      rv.append(row);
      main.append(rv);
    }

    // files: SKILL.md first, then the rest by path
    const fl = el('div', 'skfiles');
    fl.id = 'skfiles';
    const paths = ['SKILL.md', ...(cur.d.files || []).map((f) => f.path).filter((p) => p !== 'SKILL.md').sort()];
    for (const p of paths) {
      const f = (cur.d.files || []).find((x) => x.path === p);
      const b = btn(p, '', () => pickFile(p));
      b.dataset.path = p;
      if (f && f.bytes !== undefined) b.title = f.bytes + ' bytes';
      b.classList.toggle('on', !cur.rev && cur.path === p);
      b.disabled = ro;
      fl.append(b);
    }
    const af = btn('+ file', 'skaddfile', addFile);
    af.disabled = cur.edit || ro;
    fl.append(af);
    if (!ro && cur.path !== 'SKILL.md') {
      const df = btn('delete ' + cur.path, 'skdelfile', delFile);
      df.classList.add('danger');
      df.disabled = cur.edit;
      fl.append(df);
    }
    main.append(fl);

    const er = el('div', 'skerr');
    er.id = 'skerr';
    main.append(er);
    const text = cur.rev ? cur.rev.d.body : cur.text;
    if (cur.edit && !ro) {
      const ta = el('textarea', 'sktext');
      ta.id = 'sktext';
      ta.spellcheck = false;
      ta.value = cur.text;
      ta.setAttribute('aria-label', cur.name + ' ' + cur.path);
      // Ctrl+S here saves this file; the editor's own Ctrl+S (45-templates.js)
      // never sees it
      ta.onkeydown = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); e.stopPropagation(); save(); }
      };
      main.append(ta);
    } else {
      const view = el('div', 'skrend');
      view.id = 'skview';
      const path = cur.rev ? 'SKILL.md' : cur.path;
      if (/\.md$/.test(path) && ctx.md) {
        const [fm, rest] = splitFm(text);
        if (fm) view.append(el('pre', 'skfm', fm));
        const r = el('div', 'md');
        r.innerHTML = ctx.md(rest);      // mdToHtml (59-md.js) escapes all text
        view.append(r);
      } else view.append(el('pre', 'sksrc', text));
      main.append(view);
    }
  }

  // ── writes ──────────────────────────────────────────────────────────────
  const showErr = (m) => { const e = q('skerr'); if (e) e.textContent = m; ctx.st(m, false); };
  async function save() {
    const ta = q('sktext');
    if (!ta || !cur) return;
    const b = q('sksave');
    if (b) b.disabled = true;
    const body = ta.value;
    const p = await post('/skill-save?name=' + enc(cur.name) + '&path=' + enc(cur.path)
      + (cur.updated ? '&expected_updated=' + enc(cur.updated) : ''), body);
    if (p.fail) { if (b) b.disabled = false; showErr('save failed' + p.fail); return; }
    ctx.st(p.d.conflicted
      ? 'saved ' + cur.name + ', over a change made elsewhere since you opened it (the one it replaced is in History)'
      : 'saved ' + cur.name + ' ' + cur.path, !p.d.conflicted);
    await openSkill(cur.name, cur.path, { force: true });
  }
  async function setTag(t, on) {
    if (!cur) return;
    const p = await post('/skill-' + (on ? 'tag' : 'untag') + '?name=' + enc(cur.name) + '&tag=' + enc(t));
    if (p.fail) { showErr((on ? 'tag' : 'untag') + ' failed' + p.fail); return; }
    ctx.st((on ? 'tagged ' : 'untagged ') + cur.name + ' #' + t);
    await openSkill(cur.name, cur.path, { force: true });
  }
  // the sensitive mark rides on a save of SKILL.md as it stands
  async function setSensitive(on) {
    if (!cur) return;
    const p = await post('/skill-save?name=' + enc(cur.name) + '&path=SKILL.md&sensitive=' + (on ? '1' : '0')
      + '&expected_updated=' + enc(cur.d.updated), cur.d.body);
    if (p.fail) { showErr('could not ' + (on ? 'mark' : 'clear') + ' sensitive' + p.fail); return; }
    ctx.st(cur.name + (on ? ' is marked sensitive' : ' is no longer sensitive'));
    await openSkill(cur.name, cur.path, { force: true });
  }
  async function delSkill() {
    if (!cur) return;
    const name = cur.name;
    if (!(await ctx.askDanger('Move the skill ' + name + ' to the trash? Agents stop seeing it. You can restore it from Trash.', 'delete'))) return;
    const p = await post('/skill-delete?name=' + enc(name));
    if (p.fail) { showErr('delete failed' + p.fail); return; }
    ctx.st('moved ' + name + ' to the trash');
    cur = null;
    list = list.filter((s) => s.name !== name);
    renderList();
    renderSkill();
    loadList(true);
    if (!q('sktrashlist').hidden) loadTrash();
  }
  async function addFile() {
    if (!cur) return;
    let seed = '', note = '';
    let path = '';
    for (;;) {
      const v = await ctx.ask(note + 'new file in ' + cur.name + ' (e.g. reference/notes.md)', seed, 'create');
      if (v === null || v === undefined) return;
      path = String(v).trim();
      if (validPath(path) && path !== 'SKILL.md') break;
      seed = path;
      note = 'a path is letters, digits and . _ - in / separated parts, ending .md .txt .json .yaml or .yml. ';
    }
    if ((cur.d.files || []).some((f) => f.path === path)) { pickFile(path); return; }
    const p = await post('/skill-save?name=' + enc(cur.name) + '&path=' + enc(path),
      /\.md$/.test(path) ? '# ' + path.split('/').pop().replace(/\.md$/, '') + '\n' : '\n');
    if (p.fail) { showErr('could not make ' + path + p.fail); return; }
    await openSkill(cur.name, path, { force: true, edit: true });
  }
  async function delFile() {
    if (!cur || cur.path === 'SKILL.md') return;
    const path = cur.path;
    if (!(await ctx.askDanger('Delete ' + path + ' from ' + cur.name + '?', 'delete'))) return;
    const p = await post('/skill-file-delete?name=' + enc(cur.name) + '&path=' + enc(path));
    if (p.fail) { showErr('could not delete ' + path + p.fail); return; }
    ctx.st('deleted ' + path);
    await openSkill(cur.name, 'SKILL.md', { force: true });
  }
  async function newSkill() {
    if (!(await leaveOk())) return;
    let seed = '', note = '', name = '';
    for (;;) {
      const v = await ctx.ask(note + 'new skill name (e.g. release-notes)', seed, 'create');
      if (v === null || v === undefined) return;
      name = String(v).trim().toLowerCase();
      if (validName(name)) break;
      seed = name;
      note = 'a name is 1 to 64 lowercase letters, digits and single hyphens, with no hyphen at either end. ';
    }
    // one that exists opens instead: skill-save would write over it
    const g = await get('/skill?name=' + enc(name));
    if (!g.fail) { ctx.st(name + ' already exists, so it is open instead'); await openSkill(name, null, { force: true }); return; }
    if (g.status !== 404) { ctx.st('could not check whether ' + name + ' exists' + g.fail + ', so nothing was made', false); return; }
    const body = '---\nname: ' + name + '\ndescription: What this skill does, and when an agent should use it.\n---\n\n# '
      + name + '\n\n';
    const p = await post('/skill-save?name=' + enc(name) + '&path=SKILL.md', body);
    if (p.fail) { ctx.st('could not make ' + name + p.fail, false); return; }
    ctx.st('made ' + name);
    await openSkill(name, null, { force: true, edit: true });
    loadList(true);
    const ta = q('sktext');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  // ── history ─────────────────────────────────────────────────────────────
  async function toggleHist() {
    if (!cur) return;
    if (cur.hist) { cur.hist = null; cur.rev = null; renderSkill(); return; }
    const name = cur.name;
    const g = await get('/skill-history?name=' + enc(name));
    if (!cur || cur.name !== name) return;
    if (g.fail) { showErr('history failed' + g.fail); return; }
    cur.hist = (g.d.revisions || []).slice().sort((a, b) => b.rev - a.rev);
    renderSkill();
  }
  function histPanel() {
    const p = el('div', 'skpanel');
    p.id = 'skhistlist';
    p.append(el('div', 'sksec', 'history · ' + cur.hist.length));
    if (!cur.hist.length) p.append(el('div', 'muted', 'no earlier revisions'));
    for (const r of cur.hist) {
      const row = el('div', 'skr');
      row.dataset.rev = r.rev;
      row.append(el('span', '', 'revision ' + r.rev + ' · ' + day(r.updated)));
      const b = btn(cur.rev && cur.rev.rev === r.rev ? 'showing' : 'view', '', () => viewRev(r.rev));
      b.classList.toggle('on', !!(cur.rev && cur.rev.rev === r.rev));
      row.append(b);
      p.append(row);
    }
    return p;
  }
  async function viewRev(rev) {
    if (!(await leaveOk())) return;
    const name = cur.name;
    const g = await get('/skill-read-at?name=' + enc(name) + '&rev=' + enc(rev));
    if (!cur || cur.name !== name) return;
    if (g.fail) { showErr('could not read revision ' + rev + g.fail); return; }
    cur.edit = false;
    cur.rev = { rev, d: g.d };
    renderSkill();
  }
  // an old SKILL.md becomes the current one, as a new save (so it is itself
  // in history, and what it replaced stays there too)
  async function restoreRev() {
    if (!cur || !cur.rev) return;
    const rev = cur.rev;
    if (!(await ctx.askConfirm('Make revision ' + rev.rev + ' the current SKILL.md of ' + cur.name + '?', 'restore'))) return;
    const p = await post('/skill-save?name=' + enc(cur.name) + '&path=SKILL.md&expected_updated=' + enc(cur.d.updated),
      rev.d.body);
    if (p.fail) { showErr('restore failed' + p.fail); return; }
    ctx.st('revision ' + rev.rev + ' of ' + cur.name + ' is current again');
    await openSkill(cur.name, 'SKILL.md', { force: true });
  }

  //  unsaved: read by the app's guards (beforeunload, the service worker's
  //  reload and closing the tab), which cannot see into this file
  window.LatSkills = { show, open: (n) => openSkill(n), unsaved: () => !!unsaved() };
})();
