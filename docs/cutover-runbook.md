# Lattice cutover runbook — `%lattice` gall agent → grubbery nexus

Migrate the live lattice on **`~ricsul-bilwyt`** from the standalone `%lattice`
gall agent to the grubbery-native nexus. **Live-only** (trash dropped),
**hard cutover** (brief downtime), old agent kept for rollback.

Every step below was rehearsed on `~tyr`. Commands assume you run them from a
shell on the production host; set the two variables first.

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

- **P1. Grubbery ≥ `a8d7738`** installed on `~ricsul-bilwyt` (the floor from
  `grubbery-migration.md`: weir read-gating + hash-verified merges). Verify, or
  install grubbery first.
- **P2. Lattice desk deployed into grubbery** (the `grubbery-overlay/` tree
  synced into grubbery's `gub/`, same as the tyr harness).
- **P3.** The old `%lattice` still owns `/apps/lattice`. The nexus will use a
  **temp path** until cutover — grubbery's `bind-http` is additive and can't
  claim a path the old agent holds.

> **Binding note (shapes cutover *and* rollback).** grubbery's `%bind` emits an
> Eyre `%connect`, but its `%unbind` **does not** emit a matching `%disconnect`
> (verified in `grubbery.hoon`). So once `%grubbery` binds a path, Eyre routes it
> to `%grubbery` for as long as the agent is installed — `unbind-http` only drops
> grubbery's *internal* handler (the path then 404s), it does **not** hand the
> path back for another agent to claim. Consequences: (a) cutover requires the
> old agent to *first* release `/apps/lattice` (via `|suspend`/`|uninstall`)
> before grubbery can bind it; (b) rollback **cannot** hand `/apps/lattice` back
> to a revived old agent while `%grubbery` runs — see S6 for the two real
> rollback paths.

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

## S2 — Import into the nexus

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

## Divergences from the old agent (by design, not gaps)

- `sub`/`unsub` (ames page-subscriptions) → `follow`/`unfollow`/`follows`
  (crawler follows). Federation is a clean break.
- `*-where` / `*-cutover` / `*-rollback` / `*-migrate` / `*-verify` /
  `know-export-back` — the old in-agent dual-write migration scaffolding; gone.
- `contacts` returns an empty `{"ships":[]}` shell — grubbery has no gall
  **scry**, so the old `%contacts` book read has no native equivalent; crawler
  targets are explicit now via `/follow`.
