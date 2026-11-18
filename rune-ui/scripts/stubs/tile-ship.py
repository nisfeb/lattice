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
        if p == 'page-dump': return self.send(200, json.dumps({"nodes":[{"path":"places","page":True,"kind":KIND,"rev":REV[0],"body":GEO}],"since":"s1"}))
        if p == 'page-source': return self.send(200, json.dumps({"body":GEO,"kind":KIND,"rev":REV[0],"mtime":"~2026.11.17"}))
        if p == 'tile-status': return self.send(200, json.dumps({"token":True,"orrery":False,"max":17,"styles":["streets","outdoors","satellite","dark"]}))
        if p.startswith('tile/'):
            _, style, z, x, y = p.split('/')
            return self.send(200, png(int(z), int(x), int(y)), 'image/png')
        if p == 'know-all': return self.send(200, '{"items":[]}')
        if p == 'shared-with-me': return self.send(200, '[]')
        if p == 'notify-count': return self.send(200, '{"held":0,"unread":0}')
        self.send(404, '{"error":"not in the stub"}')
# a save is taken and answered as the ship answers one, so a change made in the window lands
REV = [1]
def do_POST(self):
    global GEO
    u = urlparse(self.path); p = u.path.replace('/apps/lattice/', '', 1)
    body = self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()
    if p == 'page-save':
        # LR_SAVE_502: a save is answered as something in between answers when it cannot reach the ship
        if os.environ.get('LR_SAVE_502'): return self.send(502, 'bad gateway')
        GEO = body; REV[0] += 1
        return self.send(200, json.dumps({"rev": REV[0]}))
    self.send(404, '{"error":"not in the stub"}')
H.do_POST = do_POST
HTTPServer(('127.0.0.1', 8379), H).serve_forever()
