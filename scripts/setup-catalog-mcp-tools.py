#!/usr/bin/env python3
"""Register the catalog classifier MCP tool on a lattice ship.

This registers `lattice-catalog-classify` — the one catalog operation an MCP
client (an LLM classifier) drives via a poke. It is REAL, not a stub: it pokes
the lattice agent with `%lattice-catalog [%classify ...]`, which runs an
obelisk UPDATE setting the page's category/cat-source/confidence (see
+catalog-classify-cards / +catalog-classify-urql and /docs/catalog.md).

The catalog's READS are NOT MCP tools — the catalog lives in %obelisk, which
has no scry, and an MCP thread-builder is synchronous so it can't bridge
obelisk's async poke+fact query. The classifier reads its worklist + the
live taxonomy over authenticated HTTP on the lattice agent instead:
  GET /apps/lattice/catalog-pending   — pages with category='' (the worklist)
  GET /apps/lattice/catalog-vocab     — existing categories (caller dedupes)
  GET /apps/lattice/catalog-list      — every page, newest first
  GET /apps/lattice/catalog-explore?category=&publisher=&source=
  GET /apps/lattice/catalog-fetch?url=
  GET /apps/lattice/catalog-by-tag?tag=
So the classifier loop is: GET /catalog-pending + /catalog-vocab over HTTP,
decide a category per page, then call this MCP tool (or POST /catalog-classify)
to write each one back. Free-text search is client-side over /catalog-list
(obelisk has no LIKE).

NOTE: mcp-server stores tools in a *set*, with no overwrite or delete.
Re-running adds duplicates rather than replacing, so before re-registering
on a ship that already has these tools, reset its state:
  |nuke %mcp-server  →  |revive %mcp-server  →  python3 scripts/setup-knowledge-mcp-tools.py
  →  python3 scripts/setup-catalog-mcp-tools.py
(The knowledge tools come first since obelisk + knowledge land before
catalog in the install order.)

USAGE: same env-var contract as setup-knowledge-mcp-tools.py — give the
ship's web login code via hidden prompt (the script exchanges it for a
session itself, never echoes it), or set LATTICE_COOKIE/LATTICE_URL to skip
the login entirely. The /mcp endpoint resolves from .mcp.json by default.

    python3 scripts/setup-catalog-mcp-tools.py            # the lone server, or
    python3 scripts/setup-catalog-mcp-tools.py <server>   # a named entry
"""
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def _endpoint_from_mcp_json(server):
    """Resolve the /mcp endpoint URL from the nearest .mcp.json, walking up from here."""
    d = os.path.dirname(os.path.abspath(__file__))
    while True:
        path = os.path.join(d, ".mcp.json")
        if os.path.isfile(path):
            servers = json.load(open(path)).get("mcpServers", {})
            if not servers:
                sys.exit(f"no mcpServers in {path}")
            name = server or (next(iter(servers)) if len(servers) == 1 else None)
            if name is None:
                sys.exit(f"multiple servers in {path}; pass one of: {', '.join(servers)}")
            s = servers.get(name)
            if s is None:
                sys.exit(f"server {name!r} not in {path}; have: {', '.join(servers)}")
            return s.get("url", "")
        parent = os.path.dirname(d)
        if parent == d:
            sys.exit("no .mcp.json found (set LATTICE_URL or LATTICE_COOKIE)")
        d = parent


def _login(base):
    """Exchange the ship's +code for a session cookie. Hidden prompt, dropped
    immediately after the login body is built (Python can't zero an immutable
    str, but we hold no extra reference)."""
    code = os.environ.pop("LATTICE_CODE", None) or getpass.getpass("ship +code (hidden): ")
    body = urllib.parse.urlencode({"password": code.strip()}).encode()
    del code
    req = urllib.request.Request(
        base + "/~/login", data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            cookies = resp.headers.get_all("Set-Cookie") or []
    except urllib.error.HTTPError as e:
        sys.exit(f"login failed (HTTP {e.code}) — wrong +code?")
    finally:
        del body
    for c in cookies:
        if c.startswith("urbauth-"):
            return c.split(";", 1)[0]
    sys.exit("login succeeded but returned no urbauth cookie")


_server = sys.argv[1] if len(sys.argv) > 1 else None
if os.environ.get("LATTICE_URL"):
    ENDPOINT = os.environ["LATTICE_URL"].rstrip("/")
    if not ENDPOINT.endswith("/mcp"):
        ENDPOINT += "/mcp"
else:
    ENDPOINT = _endpoint_from_mcp_json(_server)

_base = ENDPOINT[:-len("/mcp")] if ENDPOINT.endswith("/mcp") else ENDPOINT
COOKIE = os.environ.get("LATTICE_COOKIE") or _login(_base)

# ── real classify thread-builder ────────────────────────────────────────────
# Pokes the lattice agent with %lattice-catalog [%classify url category
# cat-source confidence], which runs the obelisk UPDATE (see
# +catalog-classify-cards in /app/lattice). url + category are required;
# cat-source defaults to 'llm'; confidence accepts "0.85" or Hoon's ".85"
# (normalized + slaw %rs, unparseable → .0). Mirrors POST /catalog-classify.
POKE_CLASSIFY = r"""
|=  args=(map name:parameter:tool:mcp argument:tool:mcp)
^-  shed:khan
=/  m  (strand ,vase)
^-  form:m
=/  u=(unit argument:tool:mcp)  (~(get by args) 'url')
?~  u  (strand-fail %missing-url ~)
?>  ?=([%string @t] u.u)
=/  c=(unit argument:tool:mcp)  (~(get by args) 'category')
?~  c  (strand-fail %missing-category ~)
?>  ?=([%string @t] u.c)
=/  cs=@t
  =/  s=(unit argument:tool:mcp)  (~(get by args) 'cat-source')
  ?~  s  'llm'
  ?:(?=([%string @t] u.s) p.u.s 'llm')
=/  conf=@rs
  =/  f=(unit argument:tool:mcp)  (~(get by args) 'confidence')
  ?~  f  .0
  ?.  ?=([%string @t] u.f)  .0
  =/  ct=tape  (trip p.u.f)
  =/  norm=tape  ?:(=("0." (scag 2 ct)) (slag 1 ct) ct)
  ?~(r=(slaw %rs (crip norm)) .0 u.r)
;<  ~  bind:m  (poke-our:io %lattice %lattice-catalog !>([%classify p.u.u p.u.c cs conf]))
%-  pure:m
!>  ^-  json
(pairs:enjs:format ~[['type' s+'text'] ['text' s+(crip "classified")]])
"""

# ── tool definitions ───────────────────────────────────────────────────────
# Just the one real WRITE. catalog READS are NOT MCP tools: the catalog lives
# in %obelisk, which has no scry, and an MCP thread-builder is synchronous so
# it can't bridge obelisk's async poke+fact query. The classifier reads its
# worklist + taxonomy over authenticated HTTP on the lattice agent:
#   GET /apps/lattice/catalog-pending   (pages with category='' — the worklist)
#   GET /apps/lattice/catalog-vocab     (existing categories; caller dedupes)
#   GET /apps/lattice/catalog-list / -explore / -fetch / -by-tag
# (see /docs/catalog.md "Read surface" and +catalog-*-urql in /lib/catalog).
# Free-text substring search is client-side over catalog-list (obelisk has
# no LIKE). Re-queue / soft-delete of catalog rows are future work — v1
# classification is a direct category set, preserved across re-sweeps by the
# two-poke upsert (+catalog-page-ensure-urql / -refresh-urql).
TOOLS = [
    dict(name="lattice-catalog-classify",
         desc="Set the category of one catalog page (the catalog's index of a "
              "published gemtext page). Reads come from GET /catalog-pending "
              "(the unclassified worklist) + GET /catalog-vocab (reuse "
              "existing categories rather than coining near-duplicates). "
              "Categories are free-form — bootstrap your own taxonomy.",
         parameters={"url":        {"type": "string",
                                    "description":
                                    "The urb://~publisher/path URL of the page."},
                     "category":   {"type": "string",
                                    "description":
                                    "The category to assign (free-form)."},
                     "cat-source": {"type": "string",
                                    "description":
                                    "Provenance: 'llm' (default), 'rule', 'manual'."},
                     "confidence": {"type": "string",
                                    "description":
                                    "Confidence 0.0-1.0 (e.g. \"0.85\"). Optional."}},
         required=["url", "category"],
         tb=POKE_CLASSIFY),
]


def mcp(name, arguments):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": arguments}}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Cookie": COOKIE})
    raw = urllib.request.urlopen(req, timeout=60).read().decode()
    for ln in raw.splitlines():
        ln = ln.strip()
        if ln.startswith("data:"):
            ln = ln[5:].strip()
        if ln.startswith("{"):
            try:
                d = json.loads(ln)
                r = d.get("result", {})
                return r.get("content", [{}])[0].get("text",
                                                     json.dumps(d.get("error", r)))
            except Exception:
                pass
    return raw[:200]


def main():
    if not COOKIE:
        sys.exit("not authenticated (give a +code, or set LATTICE_COOKIE)")
    print(f"registering {len(TOOLS)} catalog tool(s) -> {ENDPOINT}")
    for t in TOOLS:
        out = mcp("add-mcp-tool", {
            "name": t["name"], "desc": t["desc"],
            "parameters": t["parameters"], "required": t["required"],
            "thread-builder": t["tb"].strip()})
        print(f"{t['name']:30} -> {out[:90]}")


if __name__ == "__main__":
    main()
