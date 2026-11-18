import json, struct, zlib, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
GEO = json.dumps({"type":"FeatureCollection","features":[
 {"type":"Feature","geometry":{"type":"Point","coordinates":[-73.9857,40.7484]},"properties":{"name":"Midtown"}},
 {"type":"Feature","geometry":{"type":"Point","coordinates":[-73.9442,40.6782]},"properties":{"name":"Brooklyn"}},
 {"type":"Feature","geometry":{"type":"LineString","coordinates":[[-73.9857,40.7484],[-73.97,40.72],[-73.9442,40.6782]]},"properties":{"name":"A walk"}}]})
# LR_GEO names a file to serve as the map page instead
import os
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
        if p == 'page-dump': return self.send(200, json.dumps({"nodes":[{"path":n,"page":True,"kind":v[1],"rev":v[2],"body":v[0]} for n, v in PAGES.items()],"since":"s1"}))
        if p == 'page-source':
            v = PAGES.get(q.get('name', [''])[0])
            if not v: return self.send(404, '{"error":"no such page"}')
            return self.send(200, json.dumps({"body":v[0],"kind":v[1],"rev":v[2],"mtime":"~2026.11.17"}))
        if p == 'tile-status': return self.send(200, json.dumps({"token":True,"orrery":False,"max":17,"styles":["streets","outdoors","satellite","dark"]}))
        if p.startswith('tile/'):
            _, style, z, x, y = p.split('/')
            return self.send(200, png(int(z), int(x), int(y)), 'image/png')
        if p == 'know-all': return self.send(200, json.dumps({"items":[{"key":k,"body":v,"tags":[],"updated":"~2026.11.17"} for k, v in KNOWS.items()]}))
        if p == 'shared-with-me': return self.send(200, '[]')
        if p == 'notify-count': return self.send(200, '{"held":0,"unread":0}')
        self.send(404, '{"error":"not in the stub"}')
# a save is taken and answered as the ship answers one, so a change made in the window lands
# LR_REV: the revision the page starts at, as when it was written elsewhere while this window was away
KNOWS = {'/rune/fact': 'a fact as the ship has it\n'}
PAGES = {'places': [GEO, KIND, int(os.environ.get('LR_REV', '1'))]}
def do_POST(self):
    u = urlparse(self.path); p = u.path.replace('/apps/lattice/', '', 1); q = parse_qs(u.query)
    body = self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()
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
    if p == 'page-save':
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
H.do_POST = do_POST
HTTPServer(('127.0.0.1', 8379), H).serve_forever()
