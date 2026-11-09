#!/usr/bin/env node
// Unit tests for share notifications and edit access requests in the
// client (ui-src/lattice/73r-access.js, lattice wiki
// specs/2026-11-08-share-notify-and-access-requests): which shares may be
// asked about, the ask and its answers from the host, the Access tab's
// Requests section, the inbox's share lines and approve/deny on an ask,
// and the OS notification's opt-in and dedupe. 73r-access.js runs as-is
// in a vm with a stub DOM, so this needs no browser and no ship.
//
// Usage:  node scripts/ui-access.mjs
import vm from 'vm';
import { makeCheck, read, cut } from './lib/check.mjs';

const L = 'ui-src/lattice/';
const src = cut(L + '69-shared.js', /const swmDir = [\s\S]*?\n {2}const swmRead = .*/, 'swm helpers') + '\n'
  + cut(L + '73-comments.js', /function ibCard\([\s\S]*?\n {2}\}/, 'ibCard') + '\n'
  + cut(L + '73-comments.js', /const ibButton = [\s\S]*?\n {2}\};/, 'ibButton') + '\n'
  + cut(L + '73-comments.js', /const actLabel = [\s\S]*?\n {2}\};/, 'actLabel') + '\n'
  + cut(L + '73-comments.js', /const actOpen = [\s\S]*?\n {2}\};/, 'actOpen') + '\n'
  + read(L + '73r-access.js')
  + '\n;this.T = { askable, askEdit, askHere, loadAsks, renderAsks, answerAsk, askButtons, askOf,'
  + ' shareLabel, shareOpen, shareNotify, actLabel, actOpen, clipNote,'
  + ' get pend() { return askPend; }, get sent() { return askSent; } };';
const check = makeCheck();

function El(tag) {
  this.tagName = tag.toUpperCase(); this.kids = []; this.style = {}; this.className = '';
  this.text = ''; this.dataset = {}; this.attrs = {};
  const cls = new Set();
  this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c),
    toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) };
}
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
Object.defineProperty(El.prototype, 'textContent', {
  get() { return this.text + this.kids.map((k) => k.textContent).join(''); },
  set(v) { this.text = v; this.kids = []; },
});
El.prototype.append = function (...k) { this.kids.push(...k); };
El.prototype.appendChild = function (k) { this.kids.push(k); return k; };
El.prototype.remove = function () {};
El.prototype.all = function (tag) {
  const out = [];
  for (const k of this.kids) {
    if (!(k instanceof El)) continue;
    if (k.tagName === tag.toUpperCase()) out.push(k);
    out.push(...k.all(tag));
  }
  return out;
};
El.prototype.querySelector = function (tag) { return this.all(tag)[0] || null; };

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this; } });

function boot(o = {}) {
  const els = { reqlist: new El('div'), aclreqn: new El('span') };
  const calls = { mutate: [], st: [], open: [], invoke: [], notes: [], tool: [], badge: 0 };
  const store = new Map(Object.entries(o.store || {}));
  const ctx = {
    api: '/apps/lattice',
    sharedWithMe: o.swm || [],
    grubPath: o.grubPath || null, grubShip: o.grubShip || null, curFolder: null,
    mode: 'pages', current: o.current || null,
    linkOf: (n) => (o.links || {})[n] || null,
    $: (id) => els[id] || null,
    document: { createElement: (t) => new El(t) },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    TextEncoder,
    st: (m, good = true) => calls.st.push([m, good]),
    ask: async () => (o.answer === undefined ? 'a note' : o.answer),
    mutate: async (url, opts) => { calls.mutate.push([url, opts]); return (o.reply || (() => json(200, { ok: true })))(url); },
    bgFetch: async () => json(200, o.asks || { pending: [], sent: [] }),
    errText: async (r) => (r ? ' ' + r.status : ''),
    refreshInboxBadge: () => { calls.badge++; },
    openIn: (kind, p, x) => calls.open.push(['open', kind, p, x && x.ship]),
    browseIn: (u) => calls.open.push(['browse', u]),
    pickFolder: (p) => calls.open.push(['folder', p]),
    toolOpen: (t) => calls.tool.push(t),
    window: {
      focus() {},
      __TAURI__: o.tauri ? { core: { invoke: async (c, a) => { calls.invoke.push([c, a]); } } } : undefined,
      Notification: o.perm ? Object.assign(function (t, opt) { calls.notes.push([t, opt]); }, { permission: o.perm }) : undefined,
    },
    ago: (ms) => String(ms),
  };
  vm.runInNewContext(src, ctx);
  return { T: ctx.T, els, calls, store };
}
const texts = (el) => el.all('button').map((b) => b.textContent);

const H = '~nec';
const P = '/apps/x/page/notes/a/code';
const F = '/apps/x/page/docs/dir-index';

// ── which shares may be asked about ───────────────────────────────────────
{
  const { T } = boot({ swm: [
    { host: H, path: P, mode: 'read' },
    { host: H, path: '/apps/x/page/notes/b/code', mode: 'edit' },
    { host: H, path: F, mode: 'read' },
    { host: H, path: '/apps/x/page/docs/w/code', mode: 'edit' },
    { host: H, path: '/apps/x/page/team/dir-index', mode: 'edit' },
  ] });
  check('a page shared for read may be asked about', T.askable(H, P));
  check('one shared for edit may not', !T.askable(H, '/apps/x/page/notes/b/code'));
  check('a folder shared for read may', T.askable(H, F));
  check('a page under a folder shared for read may', T.askable(H, '/apps/x/page/docs/p/code'));
  check("a page's own edit entry beats its folder's read", !T.askable(H, '/apps/x/page/docs/w/code'));
  check('a page under a folder shared for edit may not', !T.askable(H, '/apps/x/page/team/p/code'));
  check('nor one from another host', !T.askable('~bus', P));
  check('nor a page nothing lists', !T.askable(H, '/apps/x/page/other/code'));
}
{
  const swm = [{ host: H, path: P, mode: 'read' }];
  check('the page menu offers it for a page open from shared with me',
    JSON.stringify(boot({ swm, grubPath: P, grubShip: H }).T.askHere()) === JSON.stringify({ host: H, path: P }));
  check('and for a read link', boot({ current: 'mine/a', links: { 'mine/a': { host: H, path: P, mode: 'read' } } })
    .T.askHere().path === P);
  check('not for an edit link', boot({ current: 'mine/a', links: { 'mine/a': { host: H, path: P, mode: 'edit' } } })
    .T.askHere() === null);
  check('not for a page of ours', boot({ current: 'mine/a' }).T.askHere() === null);
}

// ── asking ────────────────────────────────────────────────────────────────
{
  const { T, calls } = boot();
  await T.askEdit(H, P);
  const [url, opts] = calls.mutate[0];
  check('the ask goes to /access-request with host and path',
    url === '/apps/lattice/access-request?host=' + encodeURIComponent(H) + '&path=' + encodeURIComponent(P), url);
  check('the note is the body', opts.body === 'a note', opts.body);
  check('the status says it was asked', /^asked ~nec for edit access to notes\/a/.test(calls.st.at(-1)[0]), calls.st.at(-1)[0]);
  check('and it lists as sent', T.sent.length === 1 && T.sent[0].path === P);
}
{
  const { calls, T } = boot({ reply: () => json(409, { error: 'too-old' }) });
  await T.askEdit(H, P);
  check('an older host is named as one', calls.st.at(-1)[0] === "this host's lattice is too old to take requests"
    && calls.st.at(-1)[1] === false, calls.st.at(-1)[0]);
  check('and nothing lists as sent', T.sent.length === 0);
}
{
  const { calls, T } = boot({ reply: () => json(504, { error: 'the host did not answer' }) });
  await T.askEdit(H, P);
  check('a host that never answered is named as one', /did not answer, so nothing was asked/.test(calls.st.at(-1)[0]));
}
{
  const { calls, T } = boot({ answer: null });
  check('cancel asks nothing', (await T.askEdit(H, P)) === false && calls.mutate.length === 0);
}
check('a long note is clipped to whole characters within 280 bytes', (() => {
  const { T } = boot();
  const c = T.clipNote('é'.repeat(200));
  return new TextEncoder().encode(c).length <= 280 && c === 'é'.repeat(140);
})());

// ── the host's Requests section ───────────────────────────────────────────
{
  const asks = { pending: [{ ship: '~bus', path: P, name: 'notes/a', note: 'fix typos', when: 1 },
    { ship: '~wes', path: F, name: 'docs/', note: '', when: 2 }], sent: [] };
  const { T, els, calls } = boot({ asks });
  await T.loadAsks();
  T.renderAsks();
  const cards = els.reqlist.kids;
  check('one card per request', cards.length === 2, cards.length);
  check('naming the ship', cards[0].querySelector('b').textContent === '~bus');
  check('the page', cards[0].querySelector('a').textContent === 'notes/a');
  check('and the note', cards[0].textContent.includes('fix typos'));
  check('an empty note says so', cards[1].textContent.includes('(no note)'));
  check('with approve and deny', JSON.stringify(texts(cards[0])) === '["approve","deny"]', texts(cards[0]));
  check('the count shows', els.aclreqn.textContent === '2');
  cards[0].querySelector('a').onclick({});
  check("its name opens our page", JSON.stringify(calls.open[0]) === JSON.stringify(['open', 'page', 'notes/a', null]));
  cards[1].querySelector('a').onclick({});
  check('a folder opens as a folder', JSON.stringify(calls.open[1]) === JSON.stringify(['folder', 'docs']));
  await cards[0].all('button')[0].onclick();
  check('approve posts do=approve for that ship and path', calls.mutate[0][0]
    === '/apps/lattice/access-answer?ship=~bus&path=' + encodeURIComponent(P) + '&do=approve', calls.mutate[0][0]);
  check('and the card goes', els.reqlist.kids.length === 1);
  check('and the badge is recounted', calls.badge === 1);
  await els.reqlist.kids[0].all('button')[1].onclick();
  check('deny posts do=deny', /&do=deny$/.test(calls.mutate[1][0]));
  check('none left says so', els.reqlist.textContent === 'No requests waiting.');
  check('and the count clears', els.aclreqn.textContent === '');
}
{
  const asks = { pending: [{ ship: '~bus', path: P, name: 'notes/a', note: '', when: 1 }], sent: [] };
  const { T, els, calls } = boot({ asks, reply: () => json(403, { error: 'banned' }) });
  await T.loadAsks();
  T.renderAsks();
  await els.reqlist.kids[0].all('button')[0].onclick();
  check('a refused approve keeps the card', els.reqlist.kids.length === 1);
  check('and says why', /^approve failed/.test(calls.st.at(-1)[0]));
}

// ── the inbox's lines ─────────────────────────────────────────────────────
{
  const asks = { pending: [{ ship: '~bus', path: P, name: 'notes/a', note: '', when: 1 }], sent: [] };
  const { T, calls } = boot({ asks });
  await T.loadAsks();
  const share = { kind: 'share', host: H, who: H, where: P, title: 'notes/a' };
  check('a share line is labelled by the page', T.actLabel(share) === 'notes/a');
  check('a folder by its name and a slash', T.actLabel({ ...share, where: F }) === 'docs/');
  check('an answer by the page', T.actLabel({ kind: 'asked', host: H, where: P, title: 'yes' }) === 'notes/a');
  check('an ask says what it asks', T.actLabel({ kind: 'ask', who: '~bus', where: P, title: 'notes/a' }) === 'asks to edit notes/a');
  T.actOpen(share, {});
  check('a share opens the page on its host', JSON.stringify(calls.open[0]) === JSON.stringify(['open', 'grub', P, H]));
  T.actOpen({ ...share, where: F }, {});
  check('a folder share opens its index in the reader', calls.open[1][0] === 'browse'
    && calls.open[1][1].includes(encodeURIComponent('urb://~nec/docs/')), calls.open[1][1]);
  T.actOpen({ kind: 'unshare', host: H, where: P }, {});
  check('a revoke opens nothing', calls.open.length === 2);
  T.actOpen({ kind: 'ask', who: '~bus', where: P }, {});
  check('an ask opens the Access tab', calls.tool[0] === 'access');
  check('a waiting ask is found for its card', T.askOf('~bus', P) !== null);
  check('an answered one is not', T.askOf('~bus', F) === null);
  check('the other kinds are as before', T.actLabel({ kind: 'comment', where: 'a/b' }) === 'comment on a/b');
}

// ── OS notifications ──────────────────────────────────────────────────────
{
  const j = { op: 'add', host: H, path: P, t: '~2026.11.8' };
  const off = boot({ perm: 'granted' });
  off.T.shareNotify(j);
  check('no browser notification unless opted in', off.calls.notes.length === 0);
  const denied = boot({ perm: 'default', store: { latNotify: '1' } });
  denied.T.shareNotify(j);
  check('nor while the browser has not allowed it', denied.calls.notes.length === 0);
  const on = boot({ perm: 'granted', store: { latNotify: '1' } });
  on.T.shareNotify(j);
  check('opted in and allowed: one notification', on.calls.notes.length === 1);
  check('it names the host and the page', on.calls.notes[0][0] === '~nec shared notes/a with you', on.calls.notes[0][0]);
  on.T.shareNotify(j);
  check('the same notice again notifies nothing', on.calls.notes.length === 1);
  const other = boot({ perm: 'granted', store: { latNotify: '1', latNoteSeen: on.store.get('latNoteSeen') } });
  other.T.shareNotify(j);
  check('nor does a second tab', other.calls.notes.length === 0);
  on.T.shareNotify({ ...j, t: '~2026.11.9' });
  check('a later share of it does', on.calls.notes.length === 2);
  const desk = boot({ tauri: true });
  desk.T.shareNotify({ ...j, path: F });
  check('the desktop app notifies through notify_share', desk.calls.invoke.length === 1
    && desk.calls.invoke[0][0] === 'notify_share' && desk.calls.invoke[0][1].title === '~nec shared docs/ with you');
  desk.T.shareNotify({ ...j, path: F });
  check('once', desk.calls.invoke.length === 1);
}

check.done();
