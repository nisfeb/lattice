//  stub-ship.mjs: an in-memory stand-in for the lattice routes the editor
//  uses, so a suite can drive the real app.js in a browser with no ship.
//
//  It serves code/nex/lattice/ui-app/ at /apps/lattice/app and keeps pages
//  with the ship's rules for a claimed rev: a page's first rev is 1 here,
//  a save with cas=1 on another rev is a 409 "stale", a save or batch item
//  with a base that is not the page's rev lands and keeps the old text
//  under conflicts/, and no base (null in a batch) is no claim.
//
//  A suite forces an order of answers with `S.hook`, which may hold one
//  back or answer it itself, and takes the ship away with `S.down` (the
//  desktop bridge's 502). `S.log` is every request, with its answer.
import http from 'http';
import { existsSync, readFileSync } from 'fs';

const UI = new URL('../../code/nex/lattice/ui-app/', import.meta.url).pathname;

export function stubShip(seed = {}) {
  const S = { pages: new Map(), log: [], delay: 20, hook: null, down: false, hist: new Map() };
  S.put = (name, body, kind = 'md') => {
    const p = S.pages.get(name) || { rev: 0, kind, share: 'private' };
    p.rev += 1; p.body = body || '\n'; p.kind = kind || p.kind;
    S.pages.set(name, p);
    if (!S.hist.has(name)) S.hist.set(name, []);
    S.hist.get(name).push({ rev: p.rev, body: p.body });
    return p;
  };
  //  a seed is a body, or [body, kind] for a page that is not markdown
  for (const [n, b] of Object.entries(seed)) S.put(n, ...[].concat(b));
  S.saves = () => S.log.filter((e) => /^page-save/.test(e.path));
  const dump = () => {
    const nodes = [], dirs = new Set();
    for (const [name, p] of S.pages) {
      const segs = name.split('/');
      for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
      nodes.push({ path: name, page: true, kind: p.kind, share: p.share, rev: p.rev, size: p.body.length, body: p.body });
    }
    for (const d of dirs) nodes.push({ path: d, page: false });
    return { nodes, since: String(Date.now()) };
  };
  const claimed = (b) => b !== null && b !== undefined && b !== '';
  //  a write that claims a rev the page has moved past: the old text is kept
  const landed = (name, body, kind, base) => {
    const p = S.pages.get(name);
    const conflicted = !!(p && claimed(base) && Number(base) !== p.rev);
    const kept = conflicted ? 'conflicts/' + name.replace(/\//g, '-') + '-' + p.rev : undefined;
    if (conflicted) S.put(kept, p.body, p.kind);
    return { rev: S.put(name, body, kind).rev, conflicted, kept };
  };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const send = (code, obj, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
    };
    const path = u.pathname, q = Object.fromEntries(u.searchParams);
    if (path === '/apps/lattice/app') return send(200, readFileSync(UI + 'index.html'), 'text/html');
    if (path.startsWith('/apps/lattice/app/')) {
      const f = UI + path.slice('/apps/lattice/app/'.length).replace(/[^\w.-]/g, '');
      return existsSync(f) ? send(200, readFileSync(f), 'text/javascript') : send(404, {});
    }
    if (!path.startsWith('/apps/lattice/') || /\/(sw|prism)\.js$/.test(path)) return send(404, '', 'text/javascript');
    const ev = { m: req.method, path: path.replace('/apps/lattice/', ''), q, body };
    S.log.push(ev);
    await new Promise((r) => setTimeout(r, S.delay));
    const fin = (code, obj) => { ev.res = { code, obj }; return send(code, obj); };
    const h = S.hook && await S.hook(ev, S);
    if (h) return fin(h.code, h.body);
    if (S.down) return fin(502, { error: 'bridge' });
    const p = S.pages.get(q.name);
    switch (ev.path) {
      case 'page-dump': return fin(200, dump());
      case 'page-source':
        return p ? fin(200, { body: p.body, kind: p.kind, rev: p.rev, share: p.share, comments: false })
          : fin(404, { error: 'no such page' });
      case 'page-source-at': {
        const at = (S.hist.get(q.name) || []).find((x) => String(x.rev) === q.rev);
        return at ? fin(200, { body: at.body, rev: at.rev }) : fin(404, { error: 'no rev' });
      }
      case 'page-save':
        if (q.new && p) return fin(409, { error: 'page exists' });
        if (q.cas && p && Number(q.base) !== p.rev) return fin(409, { error: 'stale: page is at rev ' + p.rev });
        return fin(200, landed(q.name, body, q.type, q.base));
      case 'page-save-batch':
        return fin(200, { items: JSON.parse(body).map((it) => ({ name: it.name, ...landed(it.name, it.body, it.type, it.base) })) });
      case 'tree-job': return fin(200, { job: null });
      //  the live stream never answers: the editor falls back to its poll.
      //  A suite that needs the install path sets S.base, and it is answered
      case 'streams': return S.base ? fin(200, { base: S.base }) : undefined;
      //  the permission editor's groups, as the ship lists them: S.groups
      case 'legacy-groups': return fin(200, []);
      case 'share-groups': return fin(200, S.groups || []);
      case 'share-group-save': {
        const g = (S.groups || []).find((x) => x.name === q.name);
        if (!g) return fin(404, { error: 'no such group' });
        Object.assign(g, JSON.parse(body));
        return fin(200, {});
      }
      default: return /stream|beacon/.test(ev.path) ? undefined : fin(200, {});
    }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    S, url: 'http://127.0.0.1:' + srv.address().port + '/apps/lattice/app',
    close: () => { srv.closeAllConnections(); srv.close(); },
  })));
}
