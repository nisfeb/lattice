import json, struct, zlib, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
GEO = json.dumps({"type":"FeatureCollection","features":[
 {"type":"Feature","geometry":{"type":"Point","coordinates":[-73.9857,40.7484]},"properties":{"name":"Midtown"}},
 {"type":"Feature","geometry":{"type":"Point","coordinates":[-73.9442,40.6782]},"properties":{"name":"Brooklyn"}},
 {"type":"Feature","geometry":{"type":"LineString","coordinates":[[-73.9857,40.7484],[-73.97,40.72],[-73.9442,40.6782]]},"properties":{"name":"A walk"}}]})
# LR_GEO names a file to serve as the map page instead
import os, time
if os.environ.get('LR_GEO'): GEO = open(os.environ['LR_GEO']).read()
# LR_KIND is the kind of that page, a map unless said
KIND = os.environ.get('LR_KIND', 'geojson')
def png(z, x, y):
    w = 512; rows = []
    base = (70, 110, 150) if (x + y) % 2 == 0 else (150, 110, 70)
    for j in range(w):
        row = bytearray([0])
        for i in range(w):
            edge = i < 3 or j < 3 or i > w - 4 or j > w - 4
            # a mark that says which way up and which corner: the top left is light
            mark = i < 60 and j < 60
            c = (20, 20, 20) if edge else (235, 235, 235) if mark else base
            row += bytes(c)
        rows.append(bytes(row))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, w, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 1)) + chunk(b'IEND', b'')
class H(BaseHTTPRequestHandler):
    def log_message(self, f, *a): sys.stderr.write("%s\n" % (f % a))
    def send(self, code, body, ct='application/json'):
        if isinstance(body, str): body = body.encode()
        self.send_response(code); self.send_header('content-type', ct); self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        u = urlparse(self.path); p = u.path.replace('/apps/lattice/', '', 1); q = parse_qs(u.query)
        # LR_WEB names a built web folder (target/web), served under /rune/ as a ship serves its own files.
        # LR_SIGNED=0 answers as to a browser that is not signed in.
        signed = os.environ.get('LR_SIGNED', '1') == '1'
        if u.path.startswith('/rune/') and os.environ.get('LR_WEB'):
            rel = u.path[len('/rune/'):] or 'index.html'
            f = os.path.realpath(os.path.join(os.environ['LR_WEB'], rel))
            if not f.startswith(os.path.realpath(os.environ['LR_WEB']) + os.sep) or not os.path.isfile(f): return self.send(404, 'not found', 'text/plain')
            ct = {'.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.ttf': 'font/ttf'}.get(os.path.splitext(f)[1], 'application/octet-stream')
            return self.send(200, open(f, 'rb').read(), ct)
        if u.path == '/~/login': return self.send(200, '<title>login</title><p id=login>the ship asks for its code, to go back to ' + q.get('redirect', [''])[0], 'text/html')
        # %settings, as eyre answers a scry of a bucket: each entry is text that holds JSON, and a bucket never written is a 404
        if u.path.startswith('/~/scry/settings/bucket/'):
            desk = u.path.split('/')[5]
            if desk not in SETTINGS: return self.send(404, 'not found', 'text/plain')
            return self.send(200, json.dumps({"bucket": SETTINGS[desk]}))
        if u.path.startswith('/~/channel/'): return self.send(200, 'id: 0\ndata: {"ok":"ok","id":1,"response":"poke"}\n\n', 'text/event-stream')
        if u.path == '/~/name': return self.send(200, '~zod' if signed else '~bosdev-dozzod-marnus-fopfed', 'text/plain')
        if not signed:
            self.send_response(302); self.send_header('location', '/~/login?redirect=' + u.path); self.send_header('content-length', '0'); self.end_headers(); return
        if p == 'streams': return self.send(200, json.dumps({"base": "/stub", "streams": {}}))
        if p == 'page-dump':
            nodes = [{"path":n,"page":True,"kind":v[1],"rev":v[2],"body":v[0]} for n, v in PAGES.items()]
            # a link is in the tree with no text, as the ship sends one
            nodes += [{"path":n,"page":True,"kind":"md","rev":l["rev"],"readonly":l["mode"]=="read","link":{"host":l["host"],"path":l["path"],"mode":l["mode"],"kind":"md"}} for n, l in LINKS.items()]
            return self.send(200, json.dumps({"nodes":nodes,"since":"s1"}))
        if p == 'page-source':
            l = LINKS.get(q.get('name', [''])[0])
            if l: return self.send(200, json.dumps({"body":l["body"],"kind":"md","rev":l["rev"],"mtime":"~2026.11.17"}))
            v = PAGES.get(q.get('name', [''])[0])
            if not v: return self.send(404, '{"error":"no such page"}')
            return self.send(200, json.dumps({"body":v[0],"kind":v[1],"rev":v[2],"mtime":"~2026.11.17","comments":COMMENTS_ON.get(q.get('name', [''])[0], os.environ.get('LR_COMMENTS', '1') == '1')}))
        # comments: this ship's own pages' (the newest of a total), what waits for a yes on one page, and nothing held elsewhere
        if p == 'comments-inbox': return self.send(200, json.dumps({"items": COMMENTS, "total": len(COMMENTS) + int(os.environ.get('LR_MORE', '0'))}))
        if p == 'held-comments': return self.send(200, json.dumps({"items": []}))
        if p == 'page-comets': return self.send(200, json.dumps({"mode": "held", "pending": PENDING}))
        # a picture on "another site", for a forum thread that links to one
        if u.path == '/pic.png':
            sys.stderr.write("picture fetched\n")
            return self.send(200, png(3, 1, 2), 'image/png')
        if p == 'tile-status': return self.send(200, json.dumps({"token":True,"orrery":False,"max":17,"styles":["streets","outdoors","satellite","dark"]}))
        if p.startswith('tile/'):
            _, style, z, x, y = p.split('/')
            return self.send(200, png(int(z), int(x), int(y)), 'image/png')
        if p == 'know-all': return self.send(200, json.dumps({"items":[{"key":k,"body":v,"tags":[],"updated":"~2026.11.17"} for k, v in KNOWS.items()]}))
        # the browser: what stands at an address, what the address field offers, and what was visited
        if u.path == '/apps/lattice' and 'url' in q:
            url = q['url'][0]
            HISTORY[:] = [v for v in HISTORY if v["url"] != url]
            HISTORY.insert(0, {"url": url, "title": url.rsplit('/', 1)[-1] or url, "last": "~2026.11.18", "hits": 1})
            sys.stderr.write("visited %s\n" % url)
            return self.send(200, '<title>reader</title>', 'text/html')
        if p == 'urb-read':
            url = q.get('url', [''])[0]
            if url.rstrip('/') == 'urb://~sampel-palnet/notes':
                return self.send(200, json.dumps({"kind":"folder","path":"/notes","entries":[{"name":"plan","url":"urb://~sampel-palnet/notes/plan","folder":False},{"name":"trips","url":"urb://~sampel-palnet/notes/trips/","folder":True}]}))
            # a board of four threads, made at hours before now so the hot order can be seen
            # (another ship's board has the same threads, the first of them by someone else)
            if url.rstrip('/').endswith('/forum/chat') or url.rstrip('/').endswith('/forum/tech'):
                away = '~zod' not in url
                def da(hours_ago):
                    t = time.gmtime(time.time() - hours_ago * 3600)
                    return "~%d.%d.%d..%d.%d.%d" % (t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec)
                posts = [{"id":t["id"],"title":t["title"],"author":"~bus" if away and t["id"] == 1 else "~zod","created":da(t["ago"]),"active":da(t["ago"]),"body":"","up":t["up"],"down":0,"comments":0,"pinned":t["pinned"],"tags":t.get("tags", []),"link":t.get("link")} for t in THREADS]
                return self.send(200, json.dumps({"kind":"board","board":"tech" if away else "chat","title":"Tech" if away else "Chat","description":"","public":True,"count":len(posts),"posts":posts}))
            # a forum thread, as the ship answers one: enough of it to be shown
            if '/forum/' in url and url.rsplit('/', 1)[-1].isdigit():
                n = int(url.rsplit('/', 1)[-1])
                return self.send(200, json.dumps({"kind":"thread","board":url.split('/forum/')[1].split('/')[0],"title":"Thread %d" % n,"post":{"id":n,"title":"Thread %d" % n,"author":"~sampel-palnet","created":"~2026.11.17..9.0.0","active":"~2026.11.18..9.0.0","body":"The thread a notice led to.","up":2,"down":0,"comments":1,"pinned":False,"tags":[]},"comments":[{"id":1,"author":"~bus","created":"~2026.11.18..9.0.0","body":"A reply.","parent":0}]}))
            if url == 'urb://~sampel-palnet/notes/plan':
                return self.send(200, json.dumps({"comments":THREAD,"kind":"page","ship":"~sampel-palnet","path":"/notes/plan","mode":"md","body":"# The plan\n\nPublished by ~sampel-palnet. See [the trips](urb://~sampel-palnet/notes/trips/).\n"}))
            return self.send(404, 'nothing is published there')
        if p == 'omni-suggest':
            needle = q.get('q', [''])[0].lower()
            rows = [dict(b, source='bookmark') for b in MARKS] + [dict(v, source='history') for v in HISTORY if v["url"] not in [b["url"] for b in MARKS]]
            return self.send(200, json.dumps({"ok": True, "items": [{"url": r["url"], "title": r["title"], "source": r["source"], "hits": r.get("hits", 0)} for r in rows if needle in (r["url"] + r["title"]).lower()][:12]}))
        if p == 'history': return self.send(200, json.dumps({"ok": True, "items": HISTORY}))
        if p == 'bookmarks-json': return self.send(200, json.dumps([{"url": b["url"], "title": b["title"], "folder": b.get("folder", "")} for b in MARKS]))
        if p == 'shared-with-me': return self.send(200, json.dumps([{"host":e["host"],"path":e["path"],"mode":e["mode"],"when":"~2026.11.18"} for e in SHARED]))
        if p == 'folder-pages':
            if not any(e["host"] == q.get('host', [''])[0] and e["path"].endswith(q.get('path', [''])[0] + '/dir-index') for e in SHARED): return self.send(404, 'the folder does not read')
            return self.send(200, json.dumps([{"key": q['path'][0] + "/bread", "title": "Bread", "when": 1}, {"key": q['path'][0] + "/soup", "title": "", "when": 2}]))
        if p == 'browse-file':
            e = next((e for e in SHARED if e["host"] == q.get('ship', [''])[0] and e["path"] == q.get('path', [''])[0]), None)
            if not e or e["path"].endswith('/dir-index'): return self.send(404, 'not a file')
            return self.send(200, json.dumps({"body":e["body"],"mark":"page","builder":"md","editable":True,"rev":e["rev"]}))
        # activity: a reply on another ship's board, one on a board of this ship's, and a followed folder's news
        # the forum: the index page the boards are read from, and no notes of refusal
        if p == 'forum': return self.send(200, '<a href="/apps/lattice/forum/chat">chat</a>', 'text/html')
        if p == 'forum-notes': return self.send(200, os.environ.get('LR_NOTES_HTML', ''), 'text/html')
        if p == 'notify': return self.send(200, json.dumps({"unread": sum(1 for n in NOTICES if not n["read"]), "items": NOTICES}))
        if p == 'notify-count': return self.send(200, '{"held":0,"unread":0}')
        self.send(404, '{"error":"not in the stub"}')
# a save is taken and answered as the ship answers one, so a change made in the window lands
# LR_REV: the revision the page starts at, as when it was written elsewhere while this window was away
KNOWS = {'/rune/fact': 'a fact as the ship has it\n'}
# LR_NAME: the page's name, as orrery/map for the map orrery keeps
PAGES = {os.environ.get('LR_NAME', 'places'): [GEO, KIND, int(os.environ.get('LR_REV', '1'))]}
# LR_SHARED=1: three notices from other ships, as shared with me holds them: a page to edit, a page to read, and a folder
BASE = '/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app/page/'
SHARED = [] if os.environ.get('LR_SHARED') != '1' else [
    {"host":"~sampel-palnet","path":BASE+"plans/trip/code","mode":"edit","body":"# The trip\n\nShared by ~sampel-palnet.\n","rev":4},
    {"host":"~sampel-palnet","path":BASE+"recipes/dir-index","mode":"read","body":"","rev":1},
    {"host":"~bus","path":BASE+"minutes/code","mode":"read","body":"# Minutes\n\nTo read only.\n","rev":2}]
LINKS = {}
MARKS = [{"url": "urb://~sampel-palnet/notes", "title": "Sampel's notes", "folder": ""}]
HISTORY = []
THREADS = [{"id":1,"title":"DayOldForty","ago":24,"up":40,"pinned":False}, {"id":2,"title":"HourOldThree","ago":1,"up":3,"pinned":False}, {"id":3,"title":"NewNone","ago":0.2,"up":0,"pinned":False}, {"id":4,"title":"TenHoursThirty","ago":10,"up":30,"pinned":False}, {"id":5,"title":"AboutALink","ago":2,"up":1,"pinned":False,"link":"urb://~sampel-palnet/notes/plan"}, {"id":6,"title":"APicture","ago":3,"up":0,"pinned":False,"link":"http://127.0.0.1:8379/pic.png"}]
# LR_MANY_TAGS: twelve more threads with four tags each, so a board has more tags than its filter shows
if os.environ.get('LR_MANY_TAGS'):
    THREADS += [{"id":10+i,"title":"Tagged %d" % i,"ago":30+i,"up":0,"pinned":False,"tags":["g%d-%s" % (i, w) for w in ("alpha", "beta", "gamma", "delta")]} for i in range(12)]
NOTICES = [
    {"id":"0v1.n","kind":"remote","when":1795000000000,"who":"~bus","host":"~sampel-palnet","where":"tech","post":7,"title":"Rune","body":"I think so too.","read":False},
    {"id":"0v2.n","kind":"reply","when":1794990000000,"who":"~bus","host":"~zod","where":"chat","post":3,"title":"Hello","body":"Welcome.","read":False},
    {"id":"0v3.n","kind":"folder","when":1794980000000,"who":"~sampel-palnet","host":"~sampel-palnet","where":"/notes","post":0,"title":"2 new pages in notes from ~sampel-palnet","body":"","read":False}]
COMMENTS = [{"page": os.environ.get('LR_NAME', 'places'), "id": "0v1.a", "author": "~sampel-palnet", "when": "~2026.11.17..9.30.0", "body": "A first comment."}]
COMMENTS_ON = {}
PENDING = [{"id": "0v9.held", "author": "~doznec-salfun-naptul-habrys--todlux-mosmep-linsub-binzod", "when": 1795000000000, "body": "A comet's comment, held."}]
THREAD = [{"author": "~bus", "when": "~2026.11.%d..8.0.0" % (1 + i % 20), "body": "Thread comment %d" % i} for i in range(int(os.environ.get('LR_THREAD', '2')))]
def redirect(self, to):
    self.send_response(303); self.send_header('location', to); self.send_header('content-length', '0'); self.end_headers()
def do_POST(self):
    u = urlparse(self.path); p = u.path.replace('/apps/lattice/', '', 1); q = parse_qs(u.query)
    body = self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()
    # comments, as the ship answers each. LR_COMMENT_FAIL refuses a post and a switch, to see that nothing typed is lost
    if p in ('comment', 'page-comments', 'comment-remote') and os.environ.get('LR_COMMENT_FAIL'): return self.send(500, 'the ship could not do that')
    # the forum's forms on the board chat, each answered as the ship answers a form: by sending the reader back
    if p.startswith('forum/chat/'):
        rest = p.split('/')[2:]
        form = parse_qs(body)
        # LR_FORUM_REFUSE: the board answers as ever and does nothing, as a ship does for one with no right to it
        if os.environ.get('LR_FORUM_REFUSE'): rest = ['refused'] + rest
        if rest == ['vote']:
            n = int(form['target'][0].split('-')[1])
            for t in THREADS:
                if t["id"] == n: t["up"] += 1
        elif len(rest) == 2 and rest[1] == 'pin':
            for t in THREADS:
                if t["id"] == int(rest[0]): t["pinned"] = form['pinned'][0] == 'true'
        elif len(rest) == 2 and rest[1] == 'delete':
            THREADS[:] = [t for t in THREADS if t["id"] != int(rest[0])]
        sys.stderr.write("forum %s %s\n" % ('/'.join(rest), body))
        return redirect(self, '/apps/lattice/forum/chat')
    if p == 'notify-read':
        for n in NOTICES:
            if 'id' not in q or n["id"] == q['id'][0]: n["read"] = True
        sys.stderr.write("notice read %s\n" % q.get('id', ['all'])[0])
        return self.send(200, '{"ok":true}')
    if p == 'comment':
        COMMENTS.insert(0, {"page": q['page'][0], "id": "0v2.%d" % len(COMMENTS), "author": "~zod", "when": "~2026.11.18..10.0.0", "body": parse_qs(body).get('body', [''])[0]})
        sys.stderr.write("comment on %s\n" % q['page'][0])
        return redirect(self, '/apps/lattice?name=' + q['page'][0])
    if p == 'page-comments':
        COMMENTS_ON[q['name'][0]] = q['on'][0] == '1'
        return self.send(200, '{"ok":true}')
    if p == 'comment-del':
        COMMENTS[:] = [c for c in COMMENTS if c["id"] != q['id'][0]]
        sys.stderr.write("comment removed %s\n" % q['id'][0])
        return self.send(200, '{"ok":true}')
    if p == 'comet-pending':
        PENDING[:] = [c for c in PENDING if c["id"] != q['id'][0]]
        sys.stderr.write("held %s %s\n" % (q['do'][0], q['id'][0]))
        return self.send(200, '{"ok":true}')
    if p == 'comment-remote':
        said = parse_qs(body).get('body', [''])[0]
        # LR_REMOTE_QUIET: the host does not answer the poke in time, so nothing says it was taken and nothing lands
        quiet = os.environ.get('LR_REMOTE_QUIET')
        if not quiet: THREAD.append({"author": "~zod", "when": "~2026.11.18..11.0.0", "body": said})
        sys.stderr.write("remote comment to %s on %s: %r\n" % (q['ship'][0], q['page'][0], said))
        return redirect(self, '/apps/lattice?url=urb://%s/%s' % (q['ship'][0], q['page'][0]) + ('' if quiet else '&sent=x'))
    if p == 'page-del' or p == 'page-move':
        if os.environ.get('LR_SAVE_502'): return self.send(502, 'bad gateway')
        at = q['name' if p == 'page-del' else 'from'][0]
        hit = [n for n in PAGES if n == at or n.startswith(at + '/')]
        # as the ship: a delete of nothing is answered as done, a move of nothing is refused
        if not hit: return self.send(200, '{"ok":true}') if p == 'page-del' else self.send(404, '{"error":"no such page or folder"}')
        for n in hit:
            v = PAGES.pop(n)
            if p == 'page-move': PAGES[q['to'][0] + n[len(at):]] = v
        sys.stderr.write("%s %s %s\n" % (p, at, q.get('to', [''])[0]))
        return self.send(200, '{"ok":true}')
    if p == 'know-save':
        if os.environ.get('LR_SAVE_502'): return self.send(502, 'bad gateway')
        KNOWS[q['key'][0]] = body
        sys.stderr.write("memory %s %r\n" % (q['key'][0], body[:60]))
        return self.send(200, '{"ok":true}')
    if p == 'link-make':
        e = next((e for e in SHARED if e["host"] == q['host'][0] and e["path"] == q['path'][0]), None)
        if not e: return self.send(404, 'not shared with you')
        to = q['to'][0]
        if to in PAGES or to in LINKS: return self.send(409, 'destination exists')
        SHARED.remove(e); LINKS[to] = dict(e)
        sys.stderr.write("linked %s to %s %s\n" % (to, e["host"], e["path"]))
        return self.send(200, json.dumps({"path":to,"page":True,"kind":"md","rev":e["rev"]}))
    if p == 'link-unmake':
        l = LINKS.pop(q['name'][0], None)
        if not l: return self.send(404, 'no such link')
        SHARED.append(l)
        sys.stderr.write("unlinked %s\n" % q['name'][0])
        return self.send(200, '{"ok":true}')
    if p == 'bookmark':
        MARKS[:] = [b for b in MARKS if b["url"] != q['url'][0]]
        MARKS.insert(0, {"url": q['url'][0], "title": q.get('title', q['url'])[0], "folder": q.get('folder', [''])[0]})
        sys.stderr.write("bookmarked %s\n" % q['url'][0])
        return self.send(200, '{"ok":true}')
    if p == 'unbookmark':
        MARKS[:] = [b for b in MARKS if b["url"] != q['url'][0]]
        return self.send(200, '{"ok":true}')
    if p == 'history-forget':
        HISTORY[:] = [v for v in HISTORY if v["url"] != q['url'][0]]
        return self.send(200, '{"ok":true}')
    if p == 'history-clear':
        HISTORY.clear()
        return self.send(200, '{"ok":true}')
    if p == 'shared-with-me-del':
        e = next((e for e in SHARED if e["host"] == q['host'][0] and e["path"] == q['path'][0]), None)
        if e: SHARED.remove(e)
        sys.stderr.write("forgot %s %s\n" % (q['host'][0], q['path'][0]))
        return self.send(200, '{"ok":true}')
    if p == 'page-save' and q['name'][0] in LINKS:
        l = LINKS[q['name'][0]]
        if l["mode"] == 'read': return self.send(403, 'the link is read only')
        l["body"] = body; l["rev"] += 1
        sys.stderr.write("saved through link %s rev %d %r\n" % (q['name'][0], l["rev"], body[:60]))
        return self.send(200, json.dumps({"rev": l["rev"], "conflicted": False, "kept": ""}))
    if p == 'page-save':
        # LR_SLOW: seconds a save takes to be answered, as a ship far away or busy
        if os.environ.get('LR_SLOW'): time.sleep(float(os.environ['LR_SLOW']))
        # LR_SAVE_502: a save is answered as something in between answers when it cannot reach the ship
        if os.environ.get('LR_SAVE_502'): return self.send(502, 'bad gateway')
        name = q['name'][0]; kind = q.get('type', ['md'])[0]; old = PAGES.get(name)
        # as the ship's page-save: new=1 refuses a name taken, cas refuses a stale base, and a stale base without cas is applied with what it replaced kept
        if 'new' in q and old: return self.send(409, 'page exists')
        # a base of 0 names no revision, and the same text is never a conflict
        stale = old and int(q.get('base', ['0'])[0]) not in (0, old[2]) and old[0] != body
        if stale and 'cas' in q: return self.send(409, 'stale: the page is at rev %d' % old[2])
        kept = ''
        if stale:
            kept = 'conflicts/%s-rev%d' % (name.replace('~', '~~').replace('-', '~d').replace('/', '-'), old[2])
            PAGES.setdefault(kept, [old[0], old[1], 1])
        PAGES[name] = [body, kind, old[2] + 1 if old else 0]
        sys.stderr.write("saved %s rev %d %r\n" % (name, PAGES[name][2], body[:60]))
        return self.send(200, json.dumps({"rev": PAGES[name][2], "conflicted": bool(stale), "kept": kept}))
    self.send(404, '{"error":"not in the stub"}')
# a poke of %settings on a channel, as the theme controls send one
SETTINGS = {}
def do_PUT(self):
    body = self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()
    for act in json.loads(body or '[]'):
        e = act.get('json', {}).get('put-entry')
        if act.get('action') == 'poke' and act.get('app') == 'settings' and e:
            SETTINGS.setdefault(e['desk'], {})[e['entry-key']] = e['value']
            sys.stderr.write("settings %s %s %s\n" % (e['desk'], e['entry-key'], e['value'][:300]))
    self.send(204, '')
H.do_PUT = do_PUT
H.do_POST = do_POST
HTTPServer(('127.0.0.1', 8379), H).serve_forever()
