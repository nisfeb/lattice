  // ── shares and edit access ──────────────────────────────────────────────
  // The lattice wiki's specs/2026-11-08-share-notify-and-access-requests.
  // A share notice files an inbox line on the ship (lib/lattice-notify:
  // %share badged, %reshare and %unshare quiet), and a new one is an OS
  // notification here when this computer may show one. A page or folder
  // shared read-only can be asked about: the host's /access.sig takes the
  // ask, and its owner approves or denies it in the inbox or the Access
  // tab. The ship keeps both lists (GET /access-requests): the asks
  // waiting on us, and the asks we have out.
  const ASK_MAX = 280;                 // bytes of a note a host keeps
  const SHARE_KINDS = new Set(['share', 'reshare', 'unshare', 'asked']);
  let askPend = [];
  let askSent = [];
  async function loadAsks() {
    try {
      const r = await bgFetch(api + '/access-requests');
      if (!r.ok) return false;
      const d = await r.json();
      askPend = d.pending || [];
      askSent = d.sent || [];
      return true;
    } catch { return false; }
  }
  // a note clipped to whole characters within the host's byte bound
  function clipNote(s) {
    const enc = new TextEncoder();
    if (enc.encode(s).length <= ASK_MAX) return s;
    let out = '';
    for (const ch of s) {
      if (enc.encode(out + ch).length > ASK_MAX) break;
      out += ch;
    }
    return out;
  }

  // ── asking ───────────────────────────────────────────────────────────────
  // May we ask `host` for edit on `path` (a page's code grub or a folder's
  // dir-index, as its share notice named it)? Yes when shared with me
  // lists it read-only, by its own entry or a folder entry above it. Its
  // own entry wins: a page shared for edit in a folder shared for read
  // has nothing to ask.
  function askable(host, path) {
    if (!host || !path) return false;
    const mine = sharedWithMe.filter((s) => s.host === host);
    const own = mine.find((s) => s.path === path);
    if (own) return own.mode === 'read';
    const at = path.replace(/\/(code|dir-index)$/, '');
    let mode = null;
    for (const s of mine) {
      if (!swmDir(s.path)) continue;
      const d = s.path.replace(/\/dir-index$/, '');
      if (at.startsWith(d + '/')) mode = mode === 'edit' ? mode : s.mode;
    }
    return mode === 'read';
  }
  const askedAlready = (host, path) => askSent.some((a) => a.host === host && a.path === path);
  // what the page menu may ask about: a page open from shared with me, or
  // a link of ours with a read grant
  function askHere() {
    if (grubPath && grubShip && /\/page\/.+\/code$/.test(grubPath))
      return askable(grubShip, grubPath) ? { host: grubShip, path: grubPath } : null;
    if (grubPath || curFolder !== null || mode === 'know' || !current) return null;
    const lk = linkOf(current);
    return lk && lk.mode === 'read' ? { host: lk.host, path: lk.path } : null;
  }
  // Ask, with an optional note. The ship pokes the host and reads the
  // host's /pub/access: an older lattice drops the poke, and says so by
  // having no /pub/access (409 too-old).
  async function askEdit(host, path) {
    const name = sharedName(path);
    const again = askedAlready(host, path) ? ' You asked already; asking again replaces that request.' : '';
    const raw = await ask('Ask ' + host + ' for edit access to ' + name + '? A short note is optional.' + again, '', 'ask');
    if (raw === null) return false;
    st('asking ' + host + '…');
    const note = clipNote(raw.trim());
    const r = await mutate(api + '/access-request?host=' + encodeURIComponent(host)
      + '&path=' + encodeURIComponent(path), { method: 'POST', body: note });
    if (r && r.ok) {
      askSent = [{ host, path, name, note, when: Date.now() },
        ...askSent.filter((a) => !(a.host === host && a.path === path))];
      st('asked ' + host + ' for edit access to ' + name);
      return true;
    }
    let err = '';
    try { err = (await r.json()).error || ''; } catch {}
    st(err === 'too-old' ? "this host's lattice is too old to take requests"
      : r && r.status === 504 ? host + ' did not answer, so nothing was asked'
      : 'asking failed' + (err ? ': ' + err : r ? ' ' + r.status : ''), false);
    return false;
  }

  // ── answering ────────────────────────────────────────────────────────────
  // Approve shares the page or folder with that ship for edit, by hand
  // (its group grants keep their modes); deny tells it, and it may not
  // ask for that path again for a day.
  async function answerAsk(a, ok) {
    const r = await mutate(api + '/access-answer?ship=' + encodeURIComponent(a.ship)
      + '&path=' + encodeURIComponent(a.path) + '&do=' + (ok ? 'approve' : 'deny'));
    if (!r || !r.ok) { st((ok ? 'approve' : 'deny') + ' failed' + await errText(r), false); return false; }
    askPend = askPend.filter((x) => !(x.ship === a.ship && x.path === a.path));
    st(ok ? a.ship + ' may now edit ' + a.name : 'declined ' + a.ship + "'s request for " + a.name);
    renderAsks();
    refreshInboxBadge(true);
    return true;
  }
  const askOf = (ship, path) => askPend.find((x) => x.ship === ship && x.path === path) || null;
  // approve and deny on a card, while its ask waits. `after` runs once
  // the answer landed (the inbox reloads its list).
  function askButtons(card, a, after) {
    for (const [label, ok] of [['approve', true], ['deny', false]]) {
      ibButton(card, label, async () => { if ((await answerAsk(a, ok)) && after) await after(); });
    }
  }
  // the Access tab's Requests section (72-acl.js), one card per ask
  function renderAsks() {
    const host = $('reqlist');
    if (!host) return;
    host.textContent = '';
    const sum = $('aclreqn');
    if (sum) sum.textContent = askPend.length ? String(askPend.length) : '';
    if (!askPend.length) {
      const p = document.createElement('p');
      p.className = 'aclnote';
      p.textContent = 'No requests waiting.';
      host.appendChild(p);
      return;
    }
    for (const a of askPend) {
      const card = ibCard(a.ship, a.name, (e) => openOwn(a.path, e), a.note || '(no note)', a.when);
      askButtons(card, a);
      host.appendChild(card);
    }
  }
  // one of our pages or folders, by the path an ask names
  function openOwn(path, e) {
    const m = /\/page\/(.+)\/(code|dir-index)$/.exec(path);
    if (!m) return null;
    return m[2] === 'code' ? openIn('page', m[1], { ev: e }) : pickFolder(m[1]);
  }

  // ── the inbox's share lines ──────────────────────────────────────────────
  // label and open for an Activity item about a share (73-comments.js):
  // the page or folder by its name, opened on its host, as shared with me
  // opens it. A revoked one opens nothing. An ask opens the Access tab.
  const shareLabel = (a) => (a.kind === 'ask' ? 'asks to edit ' + a.title : sharedName(a.where));
  function shareOpen(a, e) {
    if (a.kind === 'ask') return toolOpen('access');
    if (a.kind === 'unshare') return null;
    if (swmDir(a.where)) return browseIn(swmRead(a.host, swmRel(a.where) + '/'));
    return openIn('grub', a.where, { ev: e, ship: a.host });
  }

  // ── OS notifications ─────────────────────────────────────────────────────
  // A new share (the share beacon's 'add', 69-shared.js) is a system
  // notification: in the desktop app always (its notify_share command),
  // in a browser only once Settings' "Notify me" is ticked and the browser
  // allowed it. Nothing here asks for permission. The beacon stamp is in
  // the key, kept a while in localStorage, so two open tabs notify once
  // and a folder share, one notice, is one notification.
  const NOTE_SEEN = 'latNoteSeen';
  function noteOnce(key) {
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(NOTE_SEEN) || '[]'); } catch {}
    if (!Array.isArray(seen)) seen = [];
    if (seen.includes(key)) return false;
    seen.push(key);
    try { localStorage.setItem(NOTE_SEEN, JSON.stringify(seen.slice(-50))); } catch {}
    return true;
  }
  function shareNotify(j) {
    const title = j.host + ' shared ' + sharedName(j.path) + ' with you';
    const body = swmDir(j.path) ? 'A folder, in shared with me' : 'A page, in shared with me';
    const key = j.host + ' ' + j.path + ' ' + (j.t || '');
    const desk = window.__TAURI__ && window.__TAURI__.core;
    if (desk) {
      if (noteOnce(key)) desk.invoke('notify_share', { title, body }).catch(() => {});
      return;
    }
    let on = false;
    try { on = localStorage.getItem('latNotify') === '1'; } catch {}
    const N = window.Notification;
    if (!on || !N || N.permission !== 'granted' || !noteOnce(key)) return;
    try {
      const n = new N(title, { body, tag: key });
      n.onclick = () => { window.focus(); shareOpen({ kind: 'share', host: j.host, where: j.path }); };
    } catch {}
  }
