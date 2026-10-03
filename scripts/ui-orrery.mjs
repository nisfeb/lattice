#!/usr/bin/env node
// Unit tests for ui-app/orrery.js, "Send to orrery": the links it reports,
// that it shows nothing without orrery, that re-opening a page costs no
// request, the badge in each state, and what it sends. orrery.js runs as-is
// in a vm with a stub document and a fake orrery behind fetch.
import { readFileSync } from 'fs';
import vm from 'vm';

const src = readFileSync(new URL('../code/nex/lattice/ui-app/orrery.js', import.meta.url), 'utf8');
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  ' + detail));
  if (!ok) fails++;
};

function El(tag) { this.tag = tag; this.kids = []; this.own = ''; this.hidden = false; this.classList = { add() {} }; }
Object.defineProperty(El.prototype, 'textContent', {
  get() { return [this.own, ...this.kids.map((k) => k.textContent)].filter(Boolean).join(' | '); },
  set(v) { this.own = v; this.kids = []; },
});
El.prototype.append = function (...k) { this.kids.push(...k); };
const find = (el, tag) => (el.tag === tag ? el : el.kids.reduce((f, k) => f || find(k, tag), null));
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 40; i++) await tick(); };

// orrery: { up, states: path -> [status, ...] (each GET takes the next, the
// last repeats), post: (body) -> [code, json] }. session: a shared store, so
// two boots can share one browser session.
function boot(orrery, session = {}) {
  const asked = [], posted = [], delays = [];
  const reply = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => '' });
  const fetch = async (url, opt = {}) => {
    asked.push((opt.method || 'GET') + ' ' + url);
    if (url === '/apps/orrery/api/version') return reply(orrery.up ? 200 : 404, {});
    const m = /^\/apps\/orrery\/api\/follow\?path=(.*)$/.exec(url);
    if (m) {
      // a slow answer, so an earlier page's status can land after a later one's
      if ((orrery.slow || []).includes(decodeURIComponent(m[1]))) await new Promise((r) => setTimeout(r, 30));
      const q = orrery.states[decodeURIComponent(m[1])] || ['none'];
      const s = q.length > 1 ? q.shift() : q[0];
      return reply(200, typeof s === 'string' ? { status: s } : s);
    }
    if (url === '/apps/orrery/api/follow' && opt.method === 'POST') {
      const body = JSON.parse(opt.body);
      posted.push(body);
      const [code, json] = orrery.post ? orrery.post(body) : [202, { ok: true, status: 'queued' }];
      return reply(code, json);
    }
    return reply(404, {});
  };
  const sessionStorage = session;
  const window = {};
  vm.runInNewContext(src, {
    window, sessionStorage, localStorage: {}, fetch,
    setTimeout: (f, ms) => { delays.push(ms); return Promise.resolve().then(f); },
    document: { getElementById: () => null, createElement: (t) => new El(t), head: { append() {} } },
  });
  return { api: window.LatticeOrrery, asked, posted, delays };
}
const page = (text) => async () => ({ title: 'Trip to Lisbon', text });

{
  const { api } = boot({ up: true, states: {} });
  const got = api.links('see [[trips/lisbon]] and [[people/ana|Ana]], [x](/apps/lattice/app?name=notes%2Fpacking)'
    + ' ![t](/apps/lattice/f/files/ticket.pdf) [[trips/lisbon]] [[/trip]] [[trip]]', 'trip');
  check('links: wikilinks, page links and uploads, in order, once each, not the page itself',
    JSON.stringify(got) === JSON.stringify(['trips/lisbon', 'people/ana', 'notes/packing', 'files/ticket.pdf']), JSON.stringify(got));
}
{
  const { api, asked } = boot({ up: false, states: {} });
  const el = new El('div'), box = new El('div');
  await api.mount(el, 'trip', page(''), box);
  check('orrery not installed: the section stays hidden and no follow is asked',
    box.hidden && !asked.some((u) => u.includes('/follow')), asked.join());
}
{
  const session = {};
  const a = boot({ up: true, states: { trip: ['none'] } }, session);
  const el = new El('div');
  await a.api.mount(el, 'trip', page(''));
  await settle();
  const b = find(el, 'button');
  check('none: the button "Send to orrery", saying the text goes to orrery\'s model',
    b && b.textContent === 'Send to orrery' && /leaves your ship for the model/.test(b.title), el.textContent);
  const b2 = boot({ up: true, states: { trip: ['none'] } }, session);
  await b2.api.mount(new El('div'), 'trip', page(''));
  await settle();
  check('re-opening the page in the same session costs no request', b2.asked.length === 0, b2.asked.join());
}
{
  const followed = { status: 'following', situation: 'situation/lisbon', title: 'Lisbon trip', open: 3 };
  const { api, posted } = boot({ up: true, states: { trip: ['none', 'queued', 'queued', followed] } });
  const el = new El('div');
  await api.mount(el, 'trip', page('# Lisbon\n\nflights in [[trips/flights]]'));
  await settle();
  find(el, 'button').onclick();
  await settle();
  const sent = posted[0] || {};
  check('send posts path, title, text and links',
    sent.path === 'trip' && sent.title === 'Trip to Lisbon' && sent.text.startsWith('# Lisbon')
      && JSON.stringify(sent.links) === '["trips/flights"]', JSON.stringify(sent));
  const a = find(el, 'a');
  check('after reading: followed by orrery, linking to the situation, with send again',
    a && a.textContent === 'followed by orrery · Lisbon trip · 3 open' && a.href === '/apps/orrery/#body/situation/lisbon'
      && find(el, 'button').textContent === 'send again', el.textContent);
}
{
  const { api } = boot({ up: true, states: { trip: [{ status: 'resolved', outcome: 'trip taken' }] } });
  const el = new El('div');
  await api.mount(el, 'trip', page(''));
  await settle();
  check('resolved: the outcome, and send again', el.textContent === 'resolved by orrery: trip taken | send again', el.textContent);
}
{
  const { api } = boot({ up: true, states: { trip: [{ status: 'failed', note: 'the model refused' }] } });
  const el = new El('div');
  await api.mount(el, 'trip', page(''));
  await settle();
  check('failed: the note, and send again', el.textContent === 'the model refused | send again', el.textContent);
}
{
  const { api } = boot({ up: true, states: { trip: ['none'] }, post: () => [400, { error: 'path is not a page' }] });
  const el = new El('div');
  await api.mount(el, 'trip', page('x'));
  await settle();
  find(el, 'button').onclick();
  await settle();
  check("a refused send says orrery's reason", el.textContent === 'path is not a page | send again', el.textContent);
}
{
  const { api } = boot({ up: true, slow: ['a'], states: { a: [{ status: 'resolved', outcome: 'old page' }], b: ['none'] } });
  const el = new El('div');
  const first = api.mount(el, 'a', page(''));
  const second = api.mount(el, 'b', page(''));
  await Promise.all([first, second]);
  await settle();
  check('a later mount on the same place wins: the page opened last is the one shown',
    el.textContent === 'Send to orrery', el.textContent);
}
{
  // a read that never finishes: 3 s for a minute, then 30 s, half an hour in all
  const { api, delays } = boot({ up: true, states: { trip: ['queued'] } });
  await api.mount(new El('div'), 'trip', page(''));
  for (let n = -1; n !== delays.length;) { n = delays.length; for (let i = 0; i < 50; i++) await tick(); }
  const total = delays.reduce((a, b) => a + b, 0);
  check('a slow read is asked after every 3 s for a minute, then every 30 s, and given up after half an hour',
    delays.slice(0, 20).every((d) => d === 3000) && delays.slice(20).every((d) => d === 30000)
      && total >= 29 * 60000 && total <= 31 * 60000, delays.length + ' polls, ' + total / 60000 + ' min');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
