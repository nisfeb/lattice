"""NexusClient: owner-gated HTTP to a grubbery nexus over an Eyre login cookie.

Reuses the +code -> cookie flow from scripts/setup-knowledge-mcp-tools.py:
read the +code without echo, POST /~/login, keep ONLY the derived cookie
(mode 600). Login lives here (not the projection) because /~/login is
Eyre-generic — grubbery-wide, not lattice-specific.
"""
import errno
import getpass
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .projection import ProjectionError


class AuthError(Exception):
    ...


class NotFound(Exception):
    ...


def _errno(code):
    return {401: errno.EACCES, 403: errno.EACCES, 404: errno.ENOENT,
            409: errno.EEXIST, 400: errno.EINVAL}.get(code, errno.EIO)


class NexusClient:
    def __init__(self, base_url, cookie_path):
        # BARE Eyre base — login is at /~/login, routes at /apps/<app>/...
        self.base = base_url.rstrip("/")
        self.cookie_path = cookie_path
        self._cookie = self._load()
        self._lock = threading.Lock()

    # ---------- cookie persistence ----------
    def _load(self):
        try:
            with open(self.cookie_path) as f:
                return f.read().strip() or None
        except FileNotFoundError:
            return None

    def _store(self, ck):
        os.makedirs(os.path.dirname(self.cookie_path), exist_ok=True)
        fd = os.open(self.cookie_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(ck)
        self._cookie = ck

    # ---------- login ----------
    def login(self, code=None):
        code = (code or os.environ.pop("LATTICE_CODE", None)
                or getpass.getpass("ship +code (hidden): "))
        body = urllib.parse.urlencode({"password": code.strip()}).encode()
        del code
        req = urllib.request.Request(
            self.base + "/~/login", data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                cookies = r.headers.get_all("Set-Cookie") or []
        except urllib.error.HTTPError as e:
            raise AuthError(f"login failed (HTTP {e.code}) — wrong +code?")
        for c in cookies:
            if c.startswith("urbauth-"):
                self._store(c.split(";", 1)[0])
                return
        raise AuthError("login returned no urbauth cookie")

    def connect(self):
        if not self._cookie:
            self.login()

    def ship(self):
        """Our @p, parsed from the auth cookie (urbauth-~ship=...)."""
        self.connect()
        name = self._cookie.split("=", 1)[0]         # urbauth-~tyr
        return name[len("urbauth-"):]                # ~tyr

    # ---------- requests ----------
    def _do(self, method, url, body, _retry):
        headers = {"Cookie": self._cookie or ""}
        if body:
            headers["Content-Type"] = "application/octet-stream"
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise NotFound(url)
            if e.code in (401, 403) and _retry:
                # cookie expired — re-auth once (needs a +code source: env or tty)
                with self._lock:
                    self.login()
                return self._do(method, url, body, False)
            raise ProjectionError(_errno(e.code),
                                  (e.read() or b"").decode("utf-8", "replace"))

    def get_json(self, route, params=None):
        return json.loads(self._do("GET", self._url(route, params), None, True))

    def get_raw(self, route, params=None):
        return self._do("GET", self._url(route, params), None, True)

    def post(self, route, params, body):
        return self._do("POST", self._url(route, params), body, True)

    def _url(self, route, params):
        q = "?" + urllib.parse.urlencode(params) if params else ""
        return self.base + route + q

    # ---------- keep-SSE (best-effort freshness) ----------
    def sse(self, route):
        """Yield (event, name) frames from a keep-SSE endpoint; reconnect on drop."""
        while True:
            try:
                req = urllib.request.Request(
                    self.base + route,
                    headers={"Cookie": self._cookie or "", "Accept": "text/event-stream"})
                with urllib.request.urlopen(req, timeout=None) as r:
                    for line in r:
                        if line.startswith(b"event: "):
                            parts = line[7:].decode().strip().split(" ", 1)
                            yield (parts[0], parts[1] if len(parts) > 1 else "")
            except Exception:
                time.sleep(3)
