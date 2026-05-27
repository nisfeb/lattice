#!/usr/bin/env python3
"""Register lattice's private-knowledge MCP tools into a running %mcp-server.

The %mcp server compiles each tool's `thread-builder` (a Hoon gate) in its own
context (subject: mcp, spider, strand, io=strandio, strand-fail, ..zuse), so
these tools need NO lattice-side dependency — they just scry lattice's
on-peek (/know/...) and poke its %lattice-know mark.

Usage:
    LATTICE_URL=http://localhost:8082 \\
    LATTICE_COOKIE='urbauth-~tyr=0v...' \\
    python3 scripts/setup-knowledge-mcp-tools.py

The cookie is the ship's authenticated session (same one your MCP client uses).
Re-run after upgrading lattice if a tool's behavior changes; add-mcp-tool
overwrites a tool of the same name.
"""
import json
import os
import sys
import urllib.request

URL = os.environ.get("LATTICE_URL", "http://localhost:8082").rstrip("/")
COOKIE = os.environ.get("LATTICE_COOKIE", "")

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
]

def mcp(name, arguments):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": arguments}}).encode()
    req = urllib.request.Request(f"{URL}/mcp", data=body, headers={
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
        sys.exit("set LATTICE_COOKIE (the ship's urbauth cookie)")
    for t in TOOLS:
        out = mcp("add-mcp-tool", {
            "name": t["name"], "desc": t["desc"],
            "parameters": t["parameters"], "required": t["required"],
            "thread-builder": t["tb"].strip()})
        print(f"{t['name']:18} -> {out[:90]}")

if __name__ == "__main__":
    main()
