#!/usr/bin/env python3
"""Register lattice's private-knowledge MCP tools into a running %mcp-server.

The %mcp server compiles each tool's `thread-builder` (a Hoon gate) in its own
context (subject: mcp, spider, strand, io=strandio, strand-fail, ..zuse), so
these tools need NO lattice-side dependency — they just scry lattice's
on-peek (/know/...) and poke its %lattice-know mark.

The /mcp endpoint comes from the repo's shared `.mcp.json` (the same file your
MCP client uses). For auth you give the ship's web login code (`+code` in the
dojo) and the script exchanges it for a session itself — you never fetch or
paste a session cookie:

    python3 scripts/setup-knowledge-mcp-tools.py            # the lone server, or
    python3 scripts/setup-knowledge-mcp-tools.py <server>   # a named mcpServers entry

The code is read WITHOUT echo (a hidden prompt), used only for the login request,
and dropped immediately — it is never printed, logged, or stored. For unattended
runs pass it via LATTICE_CODE (popped from the env at startup). LATTICE_URL
overrides the endpoint; an existing LATTICE_COOKIE skips login entirely.

NOTE: mcp-server stores tools in a *set*, with no overwrite or delete. Re-running
adds fresh copies rather than replacing, so before re-registering on a ship that
already has these tools, reset its state: `|nuke %mcp-server` then
`|revive %mcp-server` (reloads the default tools via on-init), then run this.
Run this once after each lattice upgrade that changes a tool's behavior.
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
    ENDPOINT = _endpoint_from_mcp_json(_server)

_base = ENDPOINT[:-len("/mcp")] if ENDPOINT.endswith("/mcp") else ENDPOINT
COOKIE = os.environ.get("LATTICE_COOKIE") or _login(_base)

# ── shared Hoon snippets ──────────────────────────────────────────────────
# A read tool: scry lattice at PATH (must end /json) and return the JSON text.
SCRY = """
|=  args=(map name:parameter:tool:mcp argument:tool:mcp)
^-  shed:khan
=/  m  (strand ,vase)
^-  form:m
{prep};<  =bowl:spider  bind:m  get-bowl:io
=/  res
  %-  mule
  |.  ^-  json
  {scry}
?.  ?=(%& -.res)  (strand-fail %lattice-scry-failed p.res)
%-  pure:m
!>  ^-  json
(pairs:enjs:format ~[['type' s+'text'] ['text' s+(en:json:html p.res)]])
"""

# A write tool: poke %lattice-know with [%ACTION ...] and confirm.
POKE = """
|=  args=(map name:parameter:tool:mcp argument:tool:mcp)
^-  shed:khan
=/  m  (strand ,vase)
^-  form:m
=/  k=(unit argument:tool:mcp)  (~(get by args) 'key')
?~  k  (strand-fail %missing-key ~)
?>  ?=([%string @t] u.k)
{extra};<  ~  bind:m  (poke-our:io %lattice %lattice-know !>({action}))
%-  pure:m
!>  ^-  json
(pairs:enjs:format ~[['type' s+'text'] ['text' s+(crip "{msg}")]])
"""

# key → scry path /know/read/<segments>/json, built inside the mule so a bad
# key surfaces as a scry failure rather than crashing the tool.
READ_SCRY = """=/  kp=path  (stab (crip (weld "/" (trip p.u.k))))
  .^(json %gx (welp /(scot %p our.bowl)/lattice/(scot %da now.bowl) :(welp /know/read kp /json)))"""

SEARCH = """
|=  args=(map name:parameter:tool:mcp argument:tool:mcp)
^-  shed:khan
=/  m  (strand ,vase)
^-  form:m
=/  q=(unit argument:tool:mcp)  (~(get by args) 'query')
?~  q  (strand-fail %missing-query ~)
?>  ?=([%string @t] u.q)
;<  =bowl:spider  bind:m  get-bowl:io
=/  res
  %-  mule
  |.  ^-  json
  .^(json %gx (welp /(scot %p our.bowl)/lattice/(scot %da now.bowl) /know/all/json))
?.  ?=(%& -.res)  (strand-fail %lattice-scry-failed p.res)
=/  jon=json  p.res
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

def scry_tool(path):
    scry = (".^(json %gx (welp /(scot %p our.bowl)/lattice/(scot %da now.bowl) "
            f"{path}))")
    return SCRY.format(prep="", scry=scry)

TOOLS = [
    dict(name="lattice-save",
         desc="Store a knowledge item in lattice (private; not published). "
              "Creates or overwrites the item at `key`. Re-saving a deleted key restores it.",
         parameters={"key": {"type": "string",
                             "description": "Path-like key, e.g. 'projects/lattice/architecture'."},
                     "body": {"type": "string",
                              "description": "The content to store (plain text / gemtext)."}},
         required=["key", "body"],
         tb=POKE.format(extra="=/  b=(unit argument:tool:mcp)  (~(get by args) 'body')\n"
                              "?~  b  (strand-fail %missing-body ~)\n"
                              "?>  ?=([%string @t] u.b)\n",
                        action="[%save p.u.k p.u.b]",
                        msg="Saved {<(trip p.u.k)>} to lattice.")),
    dict(name="lattice-read",
         desc="Read one stored knowledge item from lattice by key.",
         parameters={"key": {"type": "string", "description": "The item's key, e.g. 'projects/lattice/architecture'."}},
         required=["key"],
         tb=SCRY.format(prep="=/  k=(unit argument:tool:mcp)  (~(get by args) 'key')\n"
                             "?~  k  (strand-fail %missing-key ~)\n"
                             "?>  ?=([%string @t] u.k)\n",
                        scry=READ_SCRY)),
    dict(name="lattice-list",
         desc="List all stored knowledge items (keys + metadata, no bodies).",
         parameters={},
         required=[],
         tb=scry_tool("/know/list/json")),
    dict(name="lattice-search",
         desc="Search stored knowledge items for a substring (case-insensitive, "
              "across keys and bodies). Returns matching keys.",
         parameters={"query": {"type": "string", "description": "Substring to search for."}},
         required=["query"],
         tb=SEARCH),
    dict(name="lattice-delete",
         desc="Soft-delete a knowledge item (moves it to a recoverable trash; "
              "use lattice-restore to undo). Does not permanently destroy it.",
         parameters={"key": {"type": "string", "description": "The item's key."}},
         required=["key"],
         tb=POKE.format(extra="", action="[%del p.u.k]",
                        msg="Moved {<(trip p.u.k)>} to trash (recoverable via lattice-restore).")),
    dict(name="lattice-restore",
         desc="Restore a soft-deleted knowledge item from trash back to live.",
         parameters={"key": {"type": "string", "description": "The item's key."}},
         required=["key"],
         tb=POKE.format(extra="", action="[%restore p.u.k]",
                        msg="Restored {<(trip p.u.k)>} from trash.")),
    dict(name="lattice-tags",
         desc="List the existing tag vocabulary with counts. Call this BEFORE "
              "tagging so you reuse existing tags instead of creating near-duplicates.",
         parameters={},
         required=[],
         tb=scry_tool("/know/tags/json")),
    dict(name="lattice-tag",
         desc="Add a cross-cutting tag to a knowledge item (for discovery). Tags "
              "are normalized lower-case. Prefer reusing a tag from lattice-tags.",
         parameters={"key": {"type": "string", "description": "The item's key."},
                     "tag": {"type": "string", "description": "The tag to add."}},
         required=["key", "tag"],
         tb=POKE.format(extra="=/  tg=(unit argument:tool:mcp)  (~(get by args) 'tag')\n"
                              "?~  tg  (strand-fail %missing-tag ~)\n"
                              "?>  ?=([%string @t] u.tg)\n",
                        action="[%tag p.u.k p.u.tg]",
                        msg="Tagged {<(trip p.u.k)>}.")),
    dict(name="lattice-untag",
         desc="Remove a tag from a knowledge item.",
         parameters={"key": {"type": "string", "description": "The item's key."},
                     "tag": {"type": "string", "description": "The tag to remove."}},
         required=["key", "tag"],
         tb=POKE.format(extra="=/  tg=(unit argument:tool:mcp)  (~(get by args) 'tag')\n"
                              "?~  tg  (strand-fail %missing-tag ~)\n"
                              "?>  ?=([%string @t] u.tg)\n",
                        action="[%untag p.u.k p.u.tg]",
                        msg="Untagged {<(trip p.u.k)>}.")),
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
    for t in TOOLS:
        out = mcp("add-mcp-tool", {
            "name": t["name"], "desc": t["desc"],
            "parameters": t["parameters"], "required": t["required"],
            "thread-builder": t["tb"].strip()})
        print(f"{t['name']:18} -> {out[:90]}")

if __name__ == "__main__":
    main()
