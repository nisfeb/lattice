#!/usr/bin/env python3
"""Register lattice's private-knowledge MCP tools that drive the grubbery NEXUS
over its HTTP /know-* routes (not the retired %lattice agent's scry/poke).

This is the HTTP twin of setup-knowledge-mcp-tools.py. The old script's tools
scry `/know/...` on the %lattice gall agent and poke `%lattice-know`; those work
only in-process against that agent. The new nexus moved the knowledge store onto
grubbery and exposes it as owner-gated HTTP routes under /apps/lattice/know-*
(GET know-list/tags/read/all, POST know-save/delete/restore/tag/untag/move).
Each tool here is a khan thread that makes an authenticated HTTP request to those
routes and returns the nexus's JSON response verbatim.

AUTH / TOPOLOGY. The /know-* routes require the owner session, so each thread
sends a session cookie (obtained once at login and baked into the thread source).
The thread runs inside %mcp-server and reaches the nexus over the ship's own Eyre
(iris -> localhost), so this assumes the mcp-server and the lattice nexus live on
the SAME ship (the intended post-cutover state). If the nexus is elsewhere, set
LATTICE_NEXUS_URL to its base (e.g. http://host:port/apps/lattice). The baked
cookie eventually expires — re-run this script to refresh it (same caveat the
mcp-server README notes for its own hard-coded cookie).

    python3 scripts/setup-knowledge-mcp-tools-http.py            # the lone server, or
    python3 scripts/setup-knowledge-mcp-tools-http.py <server>   # a named mcpServers entry

The /mcp endpoint comes from the repo's shared .mcp.json (LATTICE_URL overrides).
The +code is read WITHOUT echo, used only for the login request, and dropped
immediately — never printed, logged, or stored. For unattended runs pass it via
LATTICE_CODE; an existing LATTICE_COOKIE skips the login prompt. The nexus base
defaults to <ship-eyre>/apps/lattice; override with LATTICE_NEXUS_URL.

NOTE: mcp-server stores tools in a *set*, with no overwrite or delete. Re-running
adds fresh copies rather than replacing, so before re-registering on a ship that
already has these tools, reset its state: `|nuke %mcp-server` then
`|revive %mcp-server`, then run this. Run once after each nexus upgrade that
changes a route's behavior, and whenever the baked cookie has expired.
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
    """Exchange the ship's +code for a session cookie. The code is read without
    echo and discarded as soon as the login request body is built — Python can't
    zero an immutable str, but we hold no extra reference to it."""
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
    # rstrip like the LATTICE_URL branch: a .mcp.json url written with a trailing
    # slash (…/mcp/) would otherwise skip the /mcp strip below and poison _base
    # (…/mcp//~/login, …/mcp//apps/lattice) — breaking login and every tool.
    ENDPOINT = _endpoint_from_mcp_json(_server).rstrip("/")

_base = ENDPOINT[:-len("/mcp")] if ENDPOINT.endswith("/mcp") else ENDPOINT
COOKIE = os.environ.get("LATTICE_COOKIE") or _login(_base)
# Where the threads reach the nexus. Defaults to this ship's own Eyre (same ship
# as %mcp-server); override when the nexus lives elsewhere.
NEXUS = (os.environ.get("LATTICE_NEXUS_URL") or (_base + "/apps/lattice")).rstrip("/")

# ── shared Hoon snippets ──────────────────────────────────────────────────
# The %mcp server compiles each thread-builder in its own context (subject: mcp,
# spider, strand, io=strandio, strand-fail, ..zuse). Every tool makes one HTTP
# request through iris (send-request/take-client-response/extract-body) and hands
# the nexus's JSON body straight back as the tool result. {req} carries the fully
# built [method url headers body] request; {prep} extracts+validates args first.
HTTP = """
|=  args=(map name:parameter:tool:mcp argument:tool:mcp)
^-  shed:khan
=/  m  (strand ,vase)
^-  form:m
{prep}=/  =request:http  {req}
;<  ~                         bind:m  (send-request:io request)
;<  rep=client-response:iris  bind:m  take-client-response:io
;<  raw=cord                  bind:m  (extract-body:io rep)
%-  pure:m
!>  ^-  json
(pairs:enjs:format ~[['type' s+'text'] ['text' s+raw]])
"""

# key/tag/to are know-key/tag-normalized (path-like, no &=? chars), so they are
# appended to the query string raw — no URL-encoding, matching the old tools
# which welded the key straight into a scry path.
KEY_PREP = ("=/  k=(unit argument:tool:mcp)  (~(get by args) 'key')\n"
            "?~  k  (strand-fail %missing-key ~)\n"
            "?>  ?=([%string @t] u.k)\n")


def get_tool(route, key=False):
    """A GET tool. With key=True it reads ?key=<key> from the 'key' arg."""
    if key:
        url = f'(crip (weld "{NEXUS}/{route}?key=" (trip p.u.k)))'
        prep = KEY_PREP
    else:
        url = f"'{NEXUS}/{route}'"
        prep = ""
    req = f"[%'GET' {url} ~[['cookie' '{COOKIE}']] ~]"
    return HTTP.format(prep=prep, req=req)


def post_tool(route, extra="", qs="", body="~"):
    """A POST tool keyed by 'key'. `extra` extracts more args; `qs` appends
    query params built from them; `body` is the (unit octs) request body."""
    url = f'(crip ;:(weld "{NEXUS}/{route}?key=" (trip p.u.k){qs}))'
    req = f"[%'POST' {url} ~[['cookie' '{COOKIE}']] {body}]"
    return HTTP.format(prep=KEY_PREP + extra, req=req)


# search / explore: fetch /know-all once and filter in-thread (no query params to
# encode). Same filtering as the scry tools; only the JSON source changed from a
# scry to an HTTP GET that is then parsed with de:json:html.
_FETCH_ALL = f"""=/  =request:http  [%'GET' '{NEXUS}/know-all' ~[['cookie' '{COOKIE}']] ~]
;<  ~                         bind:m  (send-request:io request)
;<  rep=client-response:iris  bind:m  take-client-response:io
;<  raw=cord                  bind:m  (extract-body:io rep)
=/  pj=(unit json)  (de:json:html raw)
?~  pj  (strand-fail %bad-json ~)
=/  jon=json  u.pj"""

SEARCH = """
|=  args=(map name:parameter:tool:mcp argument:tool:mcp)
^-  shed:khan
=/  m  (strand ,vase)
^-  form:m
=/  q=(unit argument:tool:mcp)  (~(get by args) 'query')
?~  q  (strand-fail %missing-query ~)
?>  ?=([%string @t] u.q)
""" + _FETCH_ALL + """
=/  items=(list json)
  ?.  ?=([%o *] jon)  ~
  =/  it  (~(get by p.jon) 'items')
  ?~(it ~ ?:(?=([%a *] u.it) p.u.it ~))
=/  ndl=tape  (cass (trip p.u.q))
=/  hits=(list json)
  %+  murn  items
  |=  item=json
  ^-  (unit json)
  ?.  ?=([%o *] item)  ~
  =/  kj  (~(get by p.item) 'key')
  =/  bj  (~(get by p.item) 'body')
  =/  kt=tape  ?~(kj "" ?:(?=([%s *] u.kj) (trip p.u.kj) ""))
  =/  bt=tape  ?~(bj "" ?:(?=([%s *] u.bj) (trip p.u.bj) ""))
  ?:  |(!=(~ (find ndl (cass kt))) !=(~ (find ndl (cass bt))))  `s+(crip kt)
  ~
%-  pure:m
!>  ^-  json
=/  out=json  (pairs:enjs:format ~[['count' (numb:enjs:format (lent hits))] ['matches' a+hits]])
(pairs:enjs:format ~[['type' s+'text'] ['text' s+(en:json:html out)]])
"""

EXPLORE = """
|=  args=(map name:parameter:tool:mcp argument:tool:mcp)
^-  shed:khan
=/  m  (strand ,vase)
^-  form:m
=/  tagu=(unit argument:tool:mcp)  (~(get by args) 'tag')
=/  qu=(unit argument:tool:mcp)    (~(get by args) 'query')
=/  ftag=tape  ?~(tagu "" ?:(?=([%string @t] u.tagu) (cass (trip p.u.tagu)) ""))
=/  ndl=tape   ?~(qu "" ?:(?=([%string @t] u.qu) (cass (trip p.u.qu)) ""))
""" + _FETCH_ALL + """
=/  items=(list json)
  ?.  ?=([%o *] jon)  ~
  =/  it  (~(get by p.jon) 'items')
  ?~(it ~ ?:(?=([%a *] u.it) p.u.it ~))
=/  hits=(list json)
  %+  murn  items
  |=  item=json
  ^-  (unit json)
  ?.  ?=([%o *] item)  ~
  =/  kj  (~(get by p.item) 'key')
  =/  bj  (~(get by p.item) 'body')
  =/  tj  (~(get by p.item) 'tags')
  =/  kt=tape  ?~(kj "" ?:(?=([%s *] u.kj) (trip p.u.kj) ""))
  =/  bt=tape  ?~(bj "" ?:(?=([%s *] u.bj) (trip p.u.bj) ""))
  =/  tags=(list tape)
    ?~  tj  ~
    ?.  ?=([%a *] u.tj)  ~
    %+  turn  p.u.tj
    |=(j=json ?:(?=([%s *] j) (cass (trip p.j)) ""))
  =/  tag-ok=?  ?|(=("" ftag) (lien tags |=(t=tape =(t ftag))))
  =/  q-ok=?    ?|(=("" ndl) |(!=(~ (find ndl (cass kt))) !=(~ (find ndl (cass bt)))))
  ?.  &(tag-ok q-ok)  ~
  `(pairs:enjs:format ~[['key' s+(crip kt)] ['tags' a+(turn tags |=(t=tape s+(crip t)))]])
%-  pure:m
!>  ^-  json
=/  out=json  (pairs:enjs:format ~[['count' (numb:enjs:format (lent hits))] ['matches' a+hits]])
(pairs:enjs:format ~[['type' s+'text'] ['text' s+(en:json:html out)]])
"""

TAG_EXTRA = ("=/  tg=(unit argument:tool:mcp)  (~(get by args) 'tag')\n"
             "?~  tg  (strand-fail %missing-tag ~)\n"
             "?>  ?=([%string @t] u.tg)\n")

TOOLS = [
    dict(name="lattice-save",
         desc="Store a knowledge item in lattice (private; not published). "
              "Creates or overwrites the item at `key`. Re-saving a deleted key restores it.",
         parameters={"key": {"type": "string",
                             "description": "Path-like key, e.g. 'projects/lattice/architecture'."},
                     "body": {"type": "string",
                              "description": "The content to store (plain text / gemtext)."}},
         required=["key", "body"],
         tb=post_tool("know-save",
                      extra="=/  b=(unit argument:tool:mcp)  (~(get by args) 'body')\n"
                            "?~  b  (strand-fail %missing-body ~)\n"
                            "?>  ?=([%string @t] u.b)\n",
                      body="`(as-octs:mimes:html p.u.b)")),
    dict(name="lattice-read",
         desc="Read one stored knowledge item from lattice by key.",
         parameters={"key": {"type": "string", "description": "The item's key, e.g. 'projects/lattice/architecture'."}},
         required=["key"],
         tb=get_tool("know-read", key=True)),
    dict(name="lattice-list",
         desc="List all stored knowledge items (keys + metadata, no bodies).",
         parameters={},
         required=[],
         tb=get_tool("know-list")),
    dict(name="lattice-search",
         desc="Search stored knowledge items for a substring (case-insensitive, "
              "across keys and bodies). Returns matching keys.",
         parameters={"query": {"type": "string", "description": "Substring to search for."}},
         required=["query"],
         tb=SEARCH),
    dict(name="lattice-explore",
         desc="Discover knowledge items by tag and/or substring. Give `tag` to "
              "find everything carrying that tag, `query` to match a substring of "
              "the key or body, or both to AND them. Returns matching keys + their "
              "tags. Use lattice-tags first to see the tag vocabulary.",
         parameters={"tag": {"type": "string", "description": "A tag to filter by (normalized lower-case)."},
                     "query": {"type": "string", "description": "Substring of the key or body."}},
         required=[],
         tb=EXPLORE),
    dict(name="lattice-delete",
         desc="Soft-delete a knowledge item (moves it to a recoverable trash; "
              "use lattice-restore to undo). Does not permanently destroy it.",
         parameters={"key": {"type": "string", "description": "The item's key."}},
         required=["key"],
         tb=post_tool("know-delete")),
    dict(name="lattice-restore",
         desc="Restore a soft-deleted knowledge item from trash back to live.",
         parameters={"key": {"type": "string", "description": "The item's key."}},
         required=["key"],
         tb=post_tool("know-restore")),
    dict(name="lattice-move",
         desc="Rename/move a knowledge item to a new key, preserving its body "
              "and tags. No-op if the source is absent or the target key already "
              "exists (delete the target first). Use to reorganize keys/paths.",
         parameters={"key": {"type": "string", "description": "The item's current key."},
                     "to": {"type": "string", "description": "The new key (path-like)."}},
         required=["key", "to"],
         tb=post_tool("know-move",
                      extra="=/  to=(unit argument:tool:mcp)  (~(get by args) 'to')\n"
                            "?~  to  (strand-fail %missing-to ~)\n"
                            "?>  ?=([%string @t] u.to)\n",
                      qs=' "&to=" (trip p.u.to)')),
    dict(name="lattice-tags",
         desc="List the existing tag vocabulary with counts. Call this BEFORE "
              "tagging so you reuse existing tags instead of creating near-duplicates.",
         parameters={},
         required=[],
         tb=get_tool("know-tags")),
    dict(name="lattice-tag",
         desc="Add a cross-cutting tag to a knowledge item (for discovery). Tags "
              "are normalized lower-case. Prefer reusing a tag from lattice-tags.",
         parameters={"key": {"type": "string", "description": "The item's key."},
                     "tag": {"type": "string", "description": "The tag to add."}},
         required=["key", "tag"],
         tb=post_tool("know-tag", extra=TAG_EXTRA, qs=' "&tag=" (trip p.u.tg)')),
    dict(name="lattice-untag",
         desc="Remove a tag from a knowledge item.",
         parameters={"key": {"type": "string", "description": "The item's key."},
                     "tag": {"type": "string", "description": "The tag to remove."}},
         required=["key", "tag"],
         tb=post_tool("know-untag", extra=TAG_EXTRA, qs=' "&tag=" (trip p.u.tg)')),
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
                return r.get("content", [{}])[0].get("text", json.dumps(d.get("error", r)))
            except Exception:
                pass
    return raw[:200]


def main():
    if not COOKIE:
        sys.exit("not authenticated (give a +code, or set LATTICE_COOKIE)")
    print(f"registering {len(TOOLS)} lattice tools -> {ENDPOINT}")
    print(f"  tool threads call the nexus at {NEXUS}/know-*")
    for t in TOOLS:
        out = mcp("add-mcp-tool", {
            "name": t["name"], "desc": t["desc"],
            "parameters": t["parameters"], "required": t["required"],
            "thread-builder": t["tb"].strip()})
        print(f"{t['name']:18} -> {out[:90]}")


if __name__ == "__main__":
    main()
