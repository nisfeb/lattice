#!/usr/bin/env python3
"""Register STUB catalog MCP tools on a lattice ship.

These tools define the contract for the federated content catalog described
in /docs/catalog.md. Each tool's thread-builder returns canned JSON with
`stub: true` so MCP clients can exercise the parameter shapes and response
shapes end-to-end BEFORE the catalog has any data — useful for client
development, contract tests, and as locked-in design documentation.

A follow-up PR (the crawler) will swap each stub for a real implementation
that scrys obelisk catalog paths (see /desk/lib/catalog.hoon for the schema)
and pokes the lattice agent to mutate the queue.

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

# ── stub thread-builder template ────────────────────────────────────────────
# Returns canned JSON (with `stub: true`) so MCP clients can exercise the
# response shape now. No bowl bind — stubs don't read any agent state.
STUB = """
|=  args=(map name:parameter:tool:mcp argument:tool:mcp)
^-  shed:khan
=/  m  (strand ,vase)
^-  form:m
=/  payload=json
  {payload}
%-  pure:m
!>  ^-  json
(pairs:enjs:format ~[['type' s+'text'] ['text' s+(en:json:html payload)]])
"""

# ── per-tool canned payloads ───────────────────────────────────────────────
# Each payload is built with pairs:enjs:format — same idiom as the knowledge
# tools' scry responses, so the payload shape doubles as the live-impl target.
PAYLOAD_PENDING = (
    "(pairs:enjs:format ~["
    "['stub' b+&] "
    "['count' (numb:enjs:format 0)] "
    "['pages' a+~] "
    "['vocab' (pairs:enjs:format ~[['categories' a+~] ['tags' a+~]])]"
    "])"
)
PAYLOAD_VOCAB = (
    "(pairs:enjs:format ~["
    "['stub' b+&] "
    "['categories' a+~] "
    "['tags' a+~]"
    "])"
)
PAYLOAD_OK = (
    "(pairs:enjs:format ~["
    "['stub' b+&] "
    "['ok' b+&]"
    "])"
)

# ── tool definitions ───────────────────────────────────────────────────────
# Naming convention: lattice-catalog-<verb>. Distinct from the existing
# lattice-* (knowledge-store) tools — catalog is a different data domain.
# NOTE: catalog READS are NOT MCP tools. The catalog lives in %obelisk,
# which has no scry — and an MCP thread-builder is synchronous, so it
# can't bridge obelisk's async poke+fact query. Reads are authenticated
# HTTP endpoints on the lattice agent instead:
#   GET /apps/lattice/catalog-list
#   GET /apps/lattice/catalog-explore?category=&publisher=&source=
#   GET /apps/lattice/catalog-fetch?url=
#   GET /apps/lattice/catalog-by-tag?tag=
# (see /docs/catalog.md "Read surface" and +catalog-*-urql in /lib/catalog).
# Free-text substring search is client-side over catalog-list (obelisk has
# no LIKE). The tools below are WRITES (pokes) + the pending/vocab reads,
# which the classifier PR will implement; pokes work fine from a strand.
TOOLS = [
    # ── Classifier pipeline ────────────────────────────────────────────────
    dict(name="lattice-catalog-pending",
         desc="Next N catalog entries awaiting classification, with title, "
              "body, url, and the current vocabulary (categories + tags) "
              "for reuse-biased classification. Vocab is bootstrapped from "
              "zero — early calls see empty arrays.",
         parameters={"limit": {"type": "number",
                               "description": "Max pages. Defaults to 10."}},
         required=[],
         tb=STUB.format(payload=PAYLOAD_PENDING)),
    dict(name="lattice-catalog-classify",
         desc="Submit a classification for one catalog entry. Novel "
              "`category` or `tags` enter a pending-review queue before "
              "joining the live vocabulary (the user is the curator).",
         parameters={"url":        {"type": "string",
                                    "description": "The urb:// URL of the entry."},
                     "category":   {"type": "string",
                                    "description": "Primary category."},
                     "tags":       {"type": "array", "items": {"type": "string"},
                                    "description": "Cross-cutting tags."},
                     "confidence": {"type": "number",
                                    "description": "Classifier confidence, 0.0-1.0."},
                     "reasoning":  {"type": "string",
                                    "description": "Optional human-readable rationale."}},
         required=["url", "category", "tags", "confidence"],
         tb=STUB.format(payload=PAYLOAD_OK)),
    dict(name="lattice-catalog-vocab",
         desc="Read the current vocabulary (categories + tags + counts) "
              "without taking from the pending queue. Use to refresh the "
              "classifier's view between batches.",
         parameters={},
         required=[],
         tb=STUB.format(payload=PAYLOAD_VOCAB)),
    dict(name="lattice-catalog-reclassify",
         desc="Re-queue one catalog entry for classification — useful if "
              "the body changed, the classifier disagreed, or the user "
              "rejected a previous category.",
         parameters={"url":    {"type": "string",
                                "description": "The urb:// URL of the entry."},
                     "reason": {"type": "string",
                                "description": "Why re-queue (default: 'requested')."}},
         required=["url"],
         tb=STUB.format(payload=PAYLOAD_OK)),
    # ── Maintenance ────────────────────────────────────────────────────────
    dict(name="lattice-catalog-delete",
         desc="Soft-delete one catalog entry (recoverable via "
              "lattice-catalog-restore). Does not affect the published "
              "page itself — only this catalog's index of it.",
         parameters={"url": {"type": "string",
                             "description": "The urb:// URL of the entry."}},
         required=["url"],
         tb=STUB.format(payload=PAYLOAD_OK)),
    dict(name="lattice-catalog-restore",
         desc="Undo a soft-delete on one catalog entry.",
         parameters={"url": {"type": "string",
                             "description": "The urb:// URL of the entry."}},
         required=["url"],
         tb=STUB.format(payload=PAYLOAD_OK)),
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
    print(f"registering {len(TOOLS)} catalog stub tools -> {ENDPOINT}")
    for t in TOOLS:
        out = mcp("add-mcp-tool", {
            "name": t["name"], "desc": t["desc"],
            "parameters": t["parameters"], "required": t["required"],
            "thread-builder": t["tb"].strip()})
        print(f"{t['name']:30} -> {out[:90]}")


if __name__ == "__main__":
    main()
