# bridge-stub.py: a stand-in ship for scripts/desktop-bridge-check.sh. It
# records, per request, whether the desktop bridge attached the session.
import http.server, json, sys, time, threading
LOG = sys.argv[2]
lock = threading.Lock()
def note(path, cookie):
    with lock, open(LOG, "a") as f:
        f.write(json.dumps({"path": path, "session": "urbauth-~zod=test" in (cookie or "")}) + "\n")
APP = b"""<!doctype html><html><body><div id=treelist></div><script>
fetch('/apps/lattice/owner?via=page');
var es = new EventSource('/apps/lattice/beacon?via=sse');
setTimeout(function(){ var i=document.createElement('img'); i.src='/apps/lattice/owner?via=img'; document.body.appendChild(i); }, 300);
var f=document.createElement('iframe'); f.setAttribute('sandbox','allow-scripts');
f.srcdoc="<script>fetch('/apps/lattice/owner?via=sandboxed-frame')<\\/script><img src='/apps/lattice/owner?via=sandboxed-img'>";
document.body.appendChild(f);
if (navigator.serviceWorker) {
  navigator.serviceWorker.register('/apps/lattice/sw.js', {scope: '/apps/lattice/'})
    .then(function(){ return navigator.serviceWorker.ready; })
    .then(function(){
      if (navigator.serviceWorker.controller) fetch('/apps/lattice/owner?via=sw-controlled-fetch');
      else if (!sessionStorage.reloaded) { sessionStorage.reloaded = 1; location.reload(); }
    }, function(e){ fetch('/apps/lattice/owner?via=sw-register-failed'); });
} else fetch('/apps/lattice/owner?via=no-sw-support');
</script></body></html>"""
SW = b"""self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e){
  var u = new URL(e.request.url);
  if (u.pathname === '/apps/lattice/owner') { e.respondWith(fetch(e.request.url.replace('via=', 'via=sw-')) ); return; }
  e.respondWith(fetch(e.request));
});"""
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        ck = self.headers.get("Cookie")
        note(self.path, ck)
        p = self.path.split("?")[0]
        if p == "/apps/lattice/legacy-status":
            code = 200 if "urbauth-~zod=test" in (ck or "") else 403
            self.send_response(code); self.send_header("Content-Length", "0"); self.end_headers(); return
        if p in ("/apps/lattice/app", "/apps/lattice/app/"):
            body, ct = APP, "text/html"
        elif p == "/apps/lattice/sw.js":
            body, ct = SW, "application/javascript"
        elif p == "/apps/lattice/beacon":
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            try:
                for _ in range(3):
                    self.wfile.write(b"data: hi\n\n"); self.wfile.flush(); time.sleep(1)
            except Exception: pass
            return
        else:
            body, ct = b"ok", "text/plain"
        self.send_response(200); self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
