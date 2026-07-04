# Lattice cutover runbook — `%lattice` gall agent → grubbery nexus

Migrate the live lattice on **`~ricsul-bilwyt`** from the standalone `%lattice`
gall agent to the grubbery-native nexus. **Live-only** (trash dropped),
**hard cutover** (brief downtime), old agent kept for rollback.

The clean-case steps below were rehearsed on `~tyr` and the full cutover was
**executed on `~ricsul-bilwyt` (2026-07)** — see **[Field notes](#field-notes--the-real-ricsul-bilwyt-cutover-2026-07)**
for how the real run diverged. Short version: a prior deploy had already left
grubbery holding `/apps/lattice`, so the old agent's HTTP was *shadowed* and the
export went over **scry**, not HTTP (see **S1-alt**). Commands assume you run
them from a shell on the production host; set the two variables first.

```sh
export SHIP=~ricsul-bilwyt               # exported: the S1 heredoc reads it in a child shell
CODE=<your +code for ~ricsul-bilwyt>     # `+code` in the ship's dojo
BASE=http://localhost:8080               # ricsul's Eyre (adjust port if needed)
CK=/tmp/ricsul-cookie.txt
WORK=/tmp/lattice-migrate; mkdir -p $WORK
# one cookie works for BOTH bindings (same ship):
curl -s -c $CK -X POST $BASE/~/login --data-urlencode "password=$CODE" -o /dev/null -w "login %{http_code}\n"
```

> **Fidelity note.** `know` entries carry `tags` + an original `updated`
> timestamp the memory store depends on. The export (`/know-all`) and the
> import (`/know-import`, backed by the nexus `%import` action) are lossless for
> `key`/`body`/`updated`. **Tags are normalized (lowercased) on import** —
> `import-item` runs each tag through `norm-tag` (`app.hoon`), so a stored `Rust`
> comes back as `rust`. This matches the nexus's own query/tag-cloud convention
> (all tag lookups fold case), so it is a normalization, not a loss — but the
> export is **not** byte-identical for mixed-case tags. `pub` page timestamps are
> informational and regenerated. The obelisk catalog is **derived** — rebuilt
> post-import, not migrated.

---

## Prerequisites

- **P0. Grubbery is healthy and lean.** Two grubbery-level hazards make a cutover
  install run for *hours* and must be cleared **before** anything else:
  - **`contacts` `sync-ames`.** If grubbery's `contacts` app is mounted in
    `lib/root.hoon`, its `/main.sig` runs `sync-ames` on every cold-start —
    scrying the whole ames peer table and writing **one clay grub per peer,
    serially** (~6.7k peers ≈ 2 h on `~ricsul-bilwyt`, re-run every reload).
    Remove the `contacts` row from `root.hoon` if you don't need it.
  - **`validate-marks` × grub count.** `+validate-marks` (grubbery `on-load`)
    re-walks *every* grub once per changed mark — O(marks × grubs). The contacts
    grubs bloat this to ~1 h per reload even after `contacts` is unmounted,
    because the already-written peer grubs persist. Evict them with a clean
    reinstall: `|nuke %grubbery` (clears state — the peer grubs go with it) → sync
    the trimmed desk → `|commit %grubbery` → `|revive %grubbery`. The nexus grubs
    you care about aren't installed yet, so nothing is lost. (Filed upstream:
    `gwbtc/grubbery#4` validate-marks, `#5` contacts.)
- **P1. Grubbery ≥ `a8d7738`** installed on `~ricsul-bilwyt` (the floor from
  `grubbery-migration.md`: weir read-gating + hash-verified merges). Verify, or
  install grubbery first.
- **P2. Lattice desk deployed into grubbery** (the `grubbery-overlay/` tree
  synced into grubbery's `gub/`, same as the tyr harness).
- **P3. Find out who actually owns `/apps/lattice`.** Two cases, and they change
  how you export (S1 vs S1-alt). Probe it unauthenticated:
  ```sh
  curl -s -o /dev/null -w "%{http_code}\n" $BASE/apps/lattice/list
  ```
  - **`403` → clean case.** The old `%lattice` owns the path and gates the
    request. Export over HTTP (**S1**). The nexus takes a **temp path**
    (`/apps/lattice-new`) until cutover.
  - **`404` → shadowed case** (what we hit on ricsul). A prior grubbery deploy
    already bound `/apps/lattice`; per the binding note below that Eyre route is
    stuck to `%grubbery` (no handler → 404), and the old agent **cannot serve
    there** even though it's installed and running. Its HTTP export is impossible
    → export over **scry (S1-alt)**. Upside: the S5 suspend-gate is moot — the
    old agent already lost the path, so the nexus just binds `/apps/lattice` and
    grubbery serves it (it already owns the route).

> **Binding note (shapes cutover *and* rollback).** grubbery's `%bind` emits an
> Eyre `%connect`, but its `%unbind` **does not** emit a matching `%disconnect`
> (verified in `grubbery.hoon`), and neither does `|nuke`/`|revive`. So once
> `%grubbery` binds a path, Eyre routes it to `%grubbery` for as long as the agent
> is installed — `unbind-http` only drops grubbery's *internal* handler (the path
> then 404s), it does **not** hand the path back for another agent to claim.
> Consequences: (a) in the **clean case**, cutover requires the old agent to
> *first* release `/apps/lattice` (via `|suspend`/`|uninstall`) before grubbery
> can bind it; in the **shadowed case** that release already happened, so you skip
> the S5 suspend/gate; (b) rollback **cannot** hand `/apps/lattice` back to a
> revived old agent while `%grubbery` runs — see S6 for the two real rollback
> paths.

---

## S0 — Stand up the nexus at a temp path

In `gub/nex/lattice/app.hoon`, the `/ui/main.sig` fiber binds the HTTP root.
Change it for the soak:

```hoon
;<  ~  bind:m  (bind-http:io [~ /apps/lattice-new])   :: was /apps/lattice
```

Commit the grubbery desk (recompiles). Confirm:

```sh
curl -s -o /dev/null -w "nexus base %{http_code} (want 403)\n" $BASE/apps/lattice-new
curl -s -b $CK $BASE/apps/lattice-new/know-all | python3 -c "import sys,json;print('nexus know count',len(json.load(sys.stdin)['items']))"  # want 0
curl -s -b $CK $BASE/apps/lattice-new/list                                                                                                # want {"files":[]}
```

The old `/apps/lattice` keeps serving throughout S0–S5. No downtime yet.

---

## S1 — Export from the old agent

**Clean case only** (P3 returned `403`). If P3 returned `404`, skip to **S1-alt**.

```sh
# private knowledge (LIVE only — key/body/updated verbatim; tags lowercased on re-import)
curl -s -b $CK "$BASE/apps/lattice/know-all" > $WORK/know.json
python3 -c "import json;print('know entries:',len(json.load(open('$WORK/know.json'))['items']))"

# published pages: list keys, fetch each body, assemble a {path:body} map
curl -s -b $CK "$BASE/apps/lattice/list" > $WORK/pub-list.json
python3 - "$BASE" "$CK" <<'PY' > $WORK/pub.json
import json,os,sys,subprocess
base,ck=sys.argv[1],sys.argv[2]
ship=os.environ["SHIP"]   # inherited from the exported shell var; KeyError if unset
files=json.load(open("/tmp/lattice-migrate/pub-list.json"))["files"]
out={}
for f in files:
    r=subprocess.run(["curl","-s","-b",ck,f"{base}/apps/lattice/fetch?url=urb://{ship}/{f}"],capture_output=True,text=True)
    out[f]=json.loads(r.stdout)["body"]
json.dump(out,open("/tmp/lattice-migrate/pub.json","w"))
print("pub pages:",len(out))
PY
```

---

## S1-alt — Export by scry (shadowed binding)

Use this when P3 returned **404** — the old agent's HTTP is shadowed by grubbery,
so `curl /apps/lattice/*` can't reach it. The agent's state is still readable by
local `%gx` scry while it's installed and running (even suspended? no — it must be
`running`; `|revive %lattice` first if it isn't).

**Knowledge (lossless).** The trailing `/json` is the mark — `%gx` strips it and
matches the `[%x %know %all ~]` peek arm; without it, `%gx` treats `all` as the
mark and the peek misses → `bail: 4`.

```
.^(json %gx /=lattice=/know/all/json)
```

The result is large; don't paste raw JSON (the terminal mangles newlines).
Base64 it and read it off the host — two capture routes:

```sh
# A) loopback lens (if %lens answers on the insecure loopback port):
curl -s -X POST http://127.0.0.1:<loopback-port> --data \
 '{"source":{"dojo":"(en:base64:mimes:html (as-octs:mimes:html (en:json:html .^(json %gx /=lattice=/know/all/json))))"},"sink":{"stdout":null}}'
# response is '<base64>' — strip the quotes, base64 -d -> the /know-all JSON.

# B) tmux pipe-pane (if lens is wedged): tap the dojo pane to a file, run the
#    base64 scry in it, then keep only [A-Za-z0-9+/=] from the capture and decode:
tmux pipe-pane -t <session>:<win> -o 'cat >> /tmp/cap.txt'   # run scry, then:
tmux pipe-pane -t <session>:<win>                            # toggle off
python3 -c "import re,base64;t=open('/tmp/cap.txt').read();b=re.sub(r'[^A-Za-z0-9+/=]','',t[t.index(chr(39))+1:]);open('know.json','wb').write(base64.b64decode(b))"
```

**Published pages** are `%grow`n/gained grubs with **no read-peek** on the old
agent. Add a temporary one (mirroring `[%x %published ~]`), commit, scry, revert:

```hoon
:: in the old agent's on-peek:
[%x %content ~]
  :^  ~  ~  %json  !>  ^-  json  :-  %o
  %-  ~(gas by *(map @t json))
  %+  turn  ~(tap by content.state)
  |=([p=^path b=@t] [(spat p) s+b])
```

`|commit %lattice`, then `.^(json %gx /=lattice=/content/json)` (same base64
capture) yields `{ "/pub/<rel>/gmi": "<body>", … }`. Strip `/pub`…`/gmi` to the
`<rel>` and feed it to the S2 `/save` loop. Then **revert the peek** (or just let
S7 retire the agent). The import side (S2) is identical — only the *export*
changed.

```sh
# knowledge: one lossless bulk POST (nexus parses the /know-all shape verbatim)
curl -s -b $CK -X POST "$BASE/apps/lattice-new/know-import" --data-binary @$WORK/know.json

# pages: one /save per page
python3 - "$BASE" "$CK" <<'PY'
import json,sys,subprocess,urllib.parse
base,ck=sys.argv[1],sys.argv[2]
pub=json.load(open("/tmp/lattice-migrate/pub.json"))
for path,body in pub.items():
    q=urllib.parse.quote(path)
    r=subprocess.run(["curl","-s","-b",ck,"-X","POST",f"{base}/apps/lattice-new/save?path={q}","--data-binary",body],capture_output=True,text=True)
    print(path, r.stdout)
PY
```

---

## S3 — Verify parity (must be identical before cutover)

```sh
curl -s -b $CK "$BASE/apps/lattice-new/know-all" > $WORK/know-new.json
python3 - <<'PY'
import json
# tags are lowercased on import (norm-tag), so fold case on BOTH sides or
# mixed-case source tags would falsely fail the gate.
norm=lambda p:{x['key']:(x['body'],x['updated'],tuple(sorted(t.lower() for t in x['tags']))) for x in json.load(open(p))['items']}
old,new=norm('/tmp/lattice-migrate/know.json'),norm('/tmp/lattice-migrate/know-new.json')
print('know counts',len(old),'->',len(new))
diffs=[k for k in old if old[k]!=new.get(k)]; missing=[k for k in old if k not in new]
print('KNOW IDENTICAL:', not diffs and not missing and len(old)==len(new))
print('  diffs',diffs[:10],'missing',missing[:10])
PY
# pub: key sets AND bodies match (fetch each new body, diff against the S1 export)
curl -s -b $CK "$BASE/apps/lattice-new/list" > $WORK/pub-list-new.json
python3 - "$BASE" "$CK" <<'PY'
import json,os,subprocess,sys
base,ck=sys.argv[1],sys.argv[2]; ship=os.environ["SHIP"]
a=set(json.load(open("/tmp/lattice-migrate/pub-list.json"))["files"])
b=set(json.load(open("/tmp/lattice-migrate/pub-list-new.json"))["files"])
old=json.load(open("/tmp/lattice-migrate/pub.json"))   # {path:body} from S1
new={}
for f in b:
    r=subprocess.run(["curl","-s","-b",ck,f"{base}/apps/lattice-new/fetch?url=urb://{ship}/{f}"],capture_output=True,text=True)
    new[f]=json.loads(r.stdout)["body"]
body_diffs=[f for f in a&b if old.get(f)!=new.get(f)]
print("PUB KEYS IDENTICAL:",a==b,"| only-old",a-b,"| only-new",b-a)
print("PUB BODIES IDENTICAL:",not body_diffs,"| body diffs",body_diffs[:10])
PY
```

**Do not proceed unless all three — `KNOW IDENTICAL`, `PUB KEYS IDENTICAL`,
`PUB BODIES IDENTICAL` — print `True`.**

---

## S3.5 — Restore the home page (required, or the app shows "page not found")

The app loads its home screen by fetching the **empty** path —
`GET /apps/lattice/fetch?url=urb://~ship/`. The old agent grew an authored home at
the empty spur (`+home-cards`); the nexus's `read-page-body` returns `~` for an
empty `rel` → **404**, so the app can't render its home. This bug is invisible to
S3 (which only checks named pages) and only surfaces when the real client hits it.
Two halves, both required:

1. **Store the authored home as an `index` page.** The old home lived at
   `/pub/index/gmi`. **Skip it in the S1/S2 pub loop** — the nexus *derives* its
   own structured `/pub/index` — and save the authored body explicitly:
   ```sh
   curl -s -b $CK -X POST "$BASE/apps/lattice/save?path=index" --data-binary @home-body.gmi
   ```
2. **Resolve the empty spur to it.** In `read-page-body` (`gub/nex/lattice/app.hoon`),
   map an empty `rel` to `/index` before the existing normalization:
   ```hoon
   =/  rel=path
     ?:  ?=(~ rel)  /index               :: empty (home) spur -> authored /index page
     ?.  ?&(=(%pub i.rel) =(%gmi (rear rel)))  rel
     (snip (strip-pub:lp rel))
   ```
   Dropping the old `?=(^ rel)` guard is **required**: the `?:` already narrows
   `rel` to non-null, so keeping it is a `mint-vain` that fails the whole nexus
   compile (every lattice fiber then BANGs on spawn). `|commit %grubbery`, confirm:
   ```sh
   curl -s -o /dev/null -w "home fetch %{http_code} (want 200)\n" \
     -b $CK "$BASE/apps/lattice/fetch?url=urb://~ship/"
   ```

---

## S4 — Rebuild the catalog (derived, not migrated)

```sh
curl -s -b $CK "$BASE/apps/lattice-new/catalog-init"            # GET route; creates the 8 tables (idempotent)
curl -s -b $CK -X POST "$BASE/apps/lattice-new/catalog-sweep"   # re-indexes own pages -> {"indexed":N}
curl -s -b $CK "$BASE/apps/lattice-new/catalog-list" | python3 -c "import sys,json;d=json.load(sys.stdin);r=[x for x in d if 'rows' in x];print('catalog rows',len(r[0]['rows']) if r else 0)"
```

(Requires `%obelisk` installed on `~ricsul-bilwyt`; if absent, install it — the
catalog is optional and the rest of lattice works without it.)

---

## S5 — Cutover (brief downtime)

The old agent must **release** `/apps/lattice` before the nexus can claim it
(additive binding — you can't double-bind). Run this in a maintenance window.

> **Not rehearsed on tyr.** tyr has no old `%lattice` agent, so the nexus side
> (temp-bind + swap-back) is proven but the *old-agent teardown* is not. Whether
> `|suspend` frees the Eyre binding is ship-behavior you must **verify at step 2**
> before committing the rebind. Do not skip that gate.

1. **Suspend the old `%lattice` agent** (state-preserving, so rollback is a
   one-liner). In the ship's dojo:
   ```
   |suspend %lattice
   ```
   `|suspend` archives the agent's state and is reversible with `|revive %lattice`.
   **Do NOT use `|nuke`** — it *clears* the agent's state and would destroy the
   old data you're keeping as a fallback.
2. **GATE — verify `/apps/lattice` is actually freed** before touching the nexus:
   ```sh
   curl -s -o /dev/null -w "old lattice after suspend: %{http_code} (want 404/503, NOT 200/403)\n" $BASE/apps/lattice/list
   ```
   - **Freed (404/503/000):** proceed to step 3.
   - **Still 200/403:** the binding survived suspend. `|revive %lattice` to get
     back to a known-good state, then free the binding a stronger way —
     `|uninstall %lattice` (removes the app; reinstall from the desk to roll
     back) — and re-run this gate before proceeding.
3. **Repoint the nexus bind** back to the real path and commit:
   ```hoon
   ;<  ~  bind:m  (bind-http:io [~ /apps/lattice])
   ```
4. **Drop the temp binding.** Add a one-shot `(unbind-http:io [~ /apps/lattice-new])`
   before the new bind. Note (per P3's binding note): this removes grubbery's
   *handler* for `/apps/lattice-new` — the path then returns 404 — but Eyre still
   routes it to `%grubbery`; the binding isn't truly released until `%grubbery` is
   uninstalled. Leaving it unbound (404) or leaving it bound (harmlessly serves
   the same nexus) are both fine; unbinding is cleaner.
5. Confirm the MCP contract is live on the real path:
   ```sh
   curl -s -o /dev/null -w "lattice base %{http_code} (want 403)\n" $BASE/apps/lattice
   curl -s -b $CK "$BASE/apps/lattice/know-all" | python3 -c "import sys,json;print('know',len(json.load(sys.stdin)['items']))"
   ```

Your `ricsul` MCP tools call `/apps/lattice/*` — **no MCP config change needed**;
they hit the nexus transparently. One behavioral change to expect: tag writes are
now case-folded (a `lattice-tag Rust` reads back as `rust`), consistent with the
nexus's case-insensitive tag/query model. Keys, bodies, and `updated` timestamps
are unchanged.

---

## S6 — Soak & rollback

- Soak: exercise the `ricsul` MCP tools (`lattice-list`, `-read`, `-save`,
  `-search`, `-explore`, `-tag`) end to end.

**Rollback.** Per P3's binding note, you **cannot** hand `/apps/lattice` back to a
revived old agent while `%grubbery` is running — grubbery's `unbind` never emits
an Eyre `%disconnect`, so Eyre keeps routing `/apps/lattice` to `%grubbery`. That
kills the "repoint the nexus and let the old agent rebind" move. There are two
real rollback paths; pick by what's actually broken:

- **A — Data rollback (default; nexus code is fine, data got corrupted).** Keep
  the nexus bound to `/apps/lattice` and restore the *data* by re-importing the
  pre-cutover export:
  ```sh
  curl -s -b $CK -X POST "$BASE/apps/lattice/know-import" --data-binary @$WORK/know.json
  # re-run the S2 pub /save loop against /apps/lattice, then S4 catalog rebuild
  ```
  Fast, no downtime, no Eyre surgery. This is the rollback you'll almost always
  want.
- **B — Full revert to the old agent (nexus is fundamentally unusable).** The only
  way to free `/apps/lattice` from grubbery at Eyre is to take `%grubbery` down:
  `|suspend %grubbery` (or `|uninstall`), which releases **all** grubbery Eyre
  bindings, then `|revive %lattice` so the old agent re-`%connect`s
  `/apps/lattice`. **This takes every other grubbery-hosted app offline** for the
  duration — heavy. Confirm on ricsul that suspending `%grubbery` actually frees
  the binding (same class of ship-behavior as the S5 gate) before relying on this.

- **Caveat — post-cutover writes are lost on either rollback.** Once the nexus is
  live (S5 done), every new write goes to the nexus; the old agent's suspended
  snapshot is frozen at cutover. Path B reverts to that frozen snapshot and drops
  anything written since. Path A only restores what's in `$WORK` (also the cutover
  snapshot). Either way: roll back early, or **re-export from the nexus first**
  (`/apps/lattice/know-all` + the S1 pub loop) if you must preserve recent writes.

---

## S7 — Retire

After a clean soak, delete the old `%lattice` desk and agent for good. The nexus
is now the sole lattice.

---

## Field notes — the real ~ricsul-bilwyt cutover (2026-07)

What actually happened, versus the clean tyr rehearsal:

- **Grubbery needed the P0 reinstall first.** `contacts` `sync-ames` + the bloated
  `validate-marks` made installs run for hours. `|nuke %grubbery` → trim
  `root.hoon` (drop `contacts`) → `|commit` → `|revive` cleared it; the nexus data
  wasn't in yet, so nothing was lost.
- **The old binding was already shadowed** (P3 → 404). A prior deploy had grubbery
  bind `/apps/lattice`; that Eyre route stuck to `%grubbery` (survived `|nuke`),
  so the old agent's HTTP was dead there and export went over **scry (S1-alt)**,
  captured as base64 through the loopback `%lens` (and, once `%lens` wedged mid-run,
  through `tmux pipe-pane`). The S5 suspend/gate was moot — the old agent had
  already lost the path — so cutover was just: repoint the nexus bind
  `/apps/lattice-new` → `/apps/lattice` and `|commit %grubbery`; grubbery already
  owned the route, so its fiber respawn picked up the bind and served it.
- **Result, verified byte-identical:** 135 `know` entries (337,537 bytes in ==
  out), 3 published pages (2,965 / 12,376 / 308,797 bytes). Tags case-folded as
  documented (S1 fidelity note); nothing else changed.
- **Two bugs the live app surfaced**, both fixed:
  1. The empty-path home fetch → **S3.5**.
  2. `crawler.sig` crashes on its sweep poke (`nest-fail -need.@p -have.[path]` —
     a one-element path used where a ship is needed). It **parks** (one-shot, no
     loop, no CPU) and only degrades cross-ship catalog **discovery**; on-demand
     `urb://` navigation is unaffected (App → `main.sig` → `read-page-body` →
     `peek-remote`, which never touches the crawler). Appears pre-existing — the
     `read-page-body` home fix returns a page body, never a ship — not a cutover
     regression. **TODO:** fix the crawler's ship-parse.

---

## Divergences from the old agent (by design, not gaps)

- `sub`/`unsub` (ames page-subscriptions) → `follow`/`unfollow`/`follows`
  (crawler follows). Federation is a clean break.
- `*-where` / `*-cutover` / `*-rollback` / `*-migrate` / `*-verify` /
  `know-export-back` — the old in-agent dual-write migration scaffolding; gone.
- `contacts` returns an empty `{"ships":[]}` shell — grubbery has no gall
  **scry**, so the old `%contacts` book read has no native equivalent; crawler
  targets are explicit now via `/follow`.
