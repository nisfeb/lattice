# Grubbery ops: deploying the lattice nexus to ~tyr

Hard-won operational reference. Every item here cost real debugging time. Read this
before touching a grubbery deploy again.

---

## 1. A route binds where its nexus's `bind-http` says. For apps that is `/apps/<name>`

**An app binds where its own `ui/main.sig` calls `bind-http:io`.** Lattice calls
`(bind-http:io [~ /apps/lattice])`, so its routes serve under **`/apps/lattice`**
(`/apps/lattice/page-dump` → 200, verified).

Do not assume `/grubbery/<name>`. That prefix is used by grubbery's **own internal
nexuses**, which are a different thing from installed apps:

```
grubbery internals:  /grubbery/api  /grubbery/ball  /grubbery/mcp  /grubbery/contacts …
installed apps:      /apps/<name>   (whatever the app's bind-http declares)
grubbery's own ui:   /apps/grubbery
```

So a lattice route is `/apps/lattice/page-tree`. Testing `/grubbery/lattice/…` returns
a `307 → /apps/landscape/` forever and looks exactly like "the app isn't installed",
which is the wrong diagnosis. This cost real time, and an earlier draft of this doc had
the rule backwards.

To find the truth without guessing: grep the nexus source for `bind-http`, or watch the
reload. Grubbery prints `eyre: replacing existing binding at <path>` for each bind.

## 1b. Installing a nexus = creating its app folder in the ball

**Committing the nexus source to clay does NOT install it.** `gub/nex/lattice/app.hoon`
being in the desk only makes it *compilable*. Grubbery never auto-instantiates a nexus.

An installed app is a **directory grub in the ball** at:

```
/apps/<instance-name>.<blot>          with its neck (nexus) set
```

The **blot name is the nexus path with `/` replaced by `_`**:

| Nexus source file | Nexus path | Ball folder |
|---|---|---|
| `gub/nex/counter.hoon` | `/counter` | `/apps/counter.counter` |
| `gub/nex/mcp.hoon` | `/mcp` | `/apps/mcp.mcp` |
| `gub/nex/obelisk/app.hoon` | `/obelisk/app` | `/apps/obelisk.obelisk_app` |
| `gub/nex/lattice/app.hoon` | `/lattice/app` | `/apps/lattice.lattice_app` |

So there is **no hand-written `mar/lattice/app.hoon`**. `lattice_app` is a derived blot
name, not a mark file. Looking for a missing mark is a dead end.

Install it with the MCP `create_folder` tool:

```json
create_folder {"path":"/apps","name":"lattice.lattice_app","nexus":"/lattice/app"}
```

> **The `nexus` param is NOT optional here, and it is a leading-slash path.** The
> folder *name* does not encode the nexus. Omitting `nexus` creates a plain folder
> (`neck: null` in `/grubbery/api/tree`, no on-load, routes 404). `delete_folder`
> it and recreate with `nexus` set. The tool description's `"claw.app"`-style
> examples are stale. The value is parsed with `stab`, so use `"/lattice/app"`.

Verify with `browse {"path":"/apps/lattice.lattice_app"}`. It prints
`Nexus: /lattice/app` and, once `on-load` has run, the laid-down tree (`ui/`, `man/`,
`manifest.json`, …). A folder that shows the nexus line but **no children** means
`on-load` has not run yet, so poke the reload (§8b).

`browse {"path":"/apps"}` is the definitive "what is installed" check. This is what
"lattice isn't laid down" means: no `/apps/lattice.lattice_app` folder in the ball.

## 2. Telling "not bound" from "bound but erroring"

Eyre's status codes mean specific things here:

| Response | Meaning |
|---|---|
| `307` → `location: /apps/landscape/` | **Not bound.** Eyre's fallback redirect for an unknown authed path. |
| `404 Not Found` (bare) | Not bound / no binding. |
| `401 bad session auth` | Bound, but your cookie is stale. |
| `400 Missing body` | Bound. The endpoint wants a POST body (e.g. the MCP endpoint). |
| `200` | Bound and serving. |

A `307` to landscape is *not* success. It is the "this path doesn't exist" signal.

## 3. MCP endpoint + config

The tyr MCP is served at **`/grubbery/mcp`** (it is a grubbery nexus,
`gub/nex/mcp.hoon`). There is no `/apps/mcp-server/api` on this build.

Working `.mcp.json` entry:

```json
"tyr": {
  "type": "http",
  "url": "http://localhost:8080/grubbery/mcp",
  "headers": { "Cookie": "urbauth-~tyr=0v..." }
}
```

Verify by hand before trusting it:

```bash
curl -s -X POST -H "Cookie: $(cat ~/.config/lattice-fs/cookie)" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}' \
  http://localhost:8080/grubbery/mcp
# -> {"result":{"serverInfo":{"name":"urbit-grubbery",...}}}
```

**The cookie is baked into `.mcp.json`.** A ship restart invalidates it, every MCP tool
starts returning `401 bad session auth`, and the config must be updated **and the MCP
reconnected**. Editing the file alone does nothing, because the client caches it at
startup.

## 4. Refreshing the session cookie

Ship restarts kill the cookie. Refresh without echoing the `+code`:

```bash
ck=$(curl -s -D - -o /dev/null --data-urlencode "password=$CODE" \
      http://localhost:8080/~/login | grep -i '^set-cookie:' \
      | grep -o 'urbauth-[^;]*' | head -1)
printf '%s' "$ck" > ~/.config/lattice-fs/cookie && chmod 600 ~/.config/lattice-fs/cookie
```

Store only the derived cookie. Never persist the `+code`.

## 5. Deploy flow

```
scripts/sync-overlay.sh <pier>/grubbery   # overlay -> gub/lib, gub/nex/lattice, gub/mar/lattice
|mount %grubbery                          # desk must be mounted for commit to see disk
|commit %grubbery                         # clay commit -> grubbery on-clay-writ -> sync-gub
```

`sync-gub` then runs: `validate-marks` → `build-code` → `reload-changed-nexuses`.

> **After ANY grubbery core update, re-run `sync-overlay.sh` BEFORE the
> commit.** Grubbery updates and the lattice overlay write into the same
> desk, and a fresh grubbery sync does not carry the overlay. Committing
> without re-laying it culls every lattice file from clay. The bins vanish,
> all lattice fibers die, and every route hangs until the proxy 504s. This
> took production down once (2026-07-28). Data in the ball is unaffected.
> Recovery is re-sync + `|commit`.

The nexus layout that works (it matches obelisk/indexer/git) is a directory with
`app.hoon`, i.e. `gub/nex/lattice/app.hoon`. No companion `.hoon` file is required.

## 6. Gotcha: the clay mount silently desyncs

Symptom: `|commit %grubbery` runs and appears to succeed, **but clay never changes**,
for any file, even a 3-line test file. Clay's mim cache believes disk already matches
the desk, so it stages nothing.

Fix:

```
|unmount %grubbery
|mount %grubbery      # re-syncs clay -> disk, rebuilding the cache
```

Then re-apply your edits (the remount reverts them) and commit. Verify a commit
actually landed by looking for `+ /~tyr/grubbery/N/<path>` lines in the dojo, or read
the file back out of clay.

## 7. Gotcha: comment-only edits do NOT trigger a reload

`reload-changed-nexuses` keys off the **compiled** build result. Editing only a comment
produces identical compiled output, so grubbery correctly does nothing. Touching the
file or bumping a marker comment to force a redeploy **does not work**. Make a real
semantic change, or use a different trigger.

## 8. Grubbery state versioning: `%0` only, no migrations

`app/grubbery.hoon` `on-load` accepts state version `%0` and nothing else. Its own
comment:

> `::  No migrations: breaking state changes mean nuke + fresh %0.`

If the persisted state is any other version you get, at install/reload time:

```
%load-failed
nest-fail
-have.%4  -need.%0
/app/grubbery/hoon:<[108 12].[108 41]>
```

`on-load` crashes **before binding a single app**, so every app silently serves
nothing.

Recovery is `|nuke %grubbery` then `|install our %grubbery` (a fresh `on-init` starts
at `%0`). Two traps:

- **A ship restart replays the checkpoint and restores the old state**, undoing the
  nuke. Do not restart between the nuke and the reinstall.
- The MCP's `nuke-agent` does not fully remove the agent the way the dojo `|nuke`
  does, so the reinstall runs `on-load` (which fails) instead of `on-init`.

## 8b. Triggering a reload

`app/grubbery.hoon` `on-poke` takes a bare `%noun` poke (must be from `our`):

```
:grubbery &noun %reload       :: -> cold-start: sync-gub + reload-nexus-at / root
:grubbery &noun %revalidate   :: -> revalidate-all
```

`%reload` is what makes a newly-created app folder actually run its nexus `on-load`.

## 8c. Drive the ship over HTTP, no MCP client needed

The MCP endpoint is plain JSON-RPC over HTTP, so a stale or disconnected MCP *client*
never blocks you. `POST /grubbery/mcp` with the session cookie:

```bash
curl -s -X POST -H "Cookie: $(cat ~/.config/lattice-fs/cookie)" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"browse","arguments":{"path":"/apps"}}}' \
  http://localhost:8080/grubbery/mcp
```

`tools/list` returns only 3 tools (`call_tool`, `echo`, `list_tools`). That is a
cache, not the real set. Call the **`list_tools` tool** to get the live registry
(**102 tools** here). The load-bearing ones:

| Tool | Use |
|---|---|
| `browse` / `read_grub` | inspect the ball: what's installed, what a nexus laid down |
| `create_folder` | **install an app** (see §1b) |
| `run_dojo` | run any dojo command, returns terminal output + logs |
| `list_clay_files` / `get_clay_file` | confirm what actually landed in clay |
| `commit` / `install_app` / `mount_desk` | desk lifecycle |
| `scry` / `poke_agent` / `poke_grub` | direct vane/agent/fiber access |

A working helper is at `scripts/mcp.sh`-style form. The only gotcha is bash brace
expansion: `args="${1:-{}}"` silently appends a stray `}`. Use
`args="$1"; [ -z "$args" ] && args='{}'`.

## 8d. You cannot see slogs, and that is why debugging felt blind

Every diagnostic grubbery emits (`BANG nexus …`, `WARNING … did not compile`,
`%grubbery-reload`, all `~&`/`slog` output) is written by the **runtime to the pier's
stdout**, which is the terminal the ship was launched in (`/proc/<king-pid>/fd/1` →
`/dev/pts/N`). It is **not** stored as a dill blit.

Consequences, all verified:

- `read_terminal` replays *blit history* and therefore **never shows slogs**. Proof:
  `run_dojo` on `~&(> %slog-capture-test ~)` renders only the result `~`. The slog is
  absent.
- `run_dojo` returns the command's **result** and an empty `--- logs ---` section. A
  poke that slogs pages of output shows as just `>=`.
- So "no BANG appeared" is **never** evidence that nothing banged. It usually means
  you simply cannot see it. Do not conclude success from silence.

**The channel that does work:** the `commit` tool returns a `Logs (N):` section, and a
commit triggers `sync-gub` → `build-code` → `reload-changed-nexuses`. Make a **real
compiled change** (see §7, since a comment will not do it), commit, and read those
logs. That is the reliable way to see compile warnings and BANGs without the user
relaying their terminal.

`dojo` results are visible, so scries are also usable for diagnostics:
`run_dojo {"command":".^(* %gx /=grubbery=/peek/kids/apps)"}`. Dojo's `/=desk=/` sugar
and `our`/`now` are only available there, not in the `eval` tool, whose subject is
bare `..zuse`, so `.^` with `/=…=/` paths is a syntax error there.

## 9. Reading grubbery's reload output

| Line | Meaning |
|---|---|
| `WARNING /path.hoon did not compile` | Compile failure. The file is broken. |
| `BANG nexus /apps/x` + `dep failed in ...` | It compiled, but a **dependency** is missing/broken. |
| `[%spawn-skip-banged ...]` | Files skipped because their nexus banged. |
| `reload-changed-nexuses: reloading /x/app at ...` | The nexus is actually being (re)started. |
| `sync-gub: build-code done` | Compilation phase finished. |

If your nexus appears in **none** of these, grubbery never even considered it. That is
a different problem from a BANG.

Known-broken on this build (pre-existing, unrelated to lattice): `obelisk` and
`guestbook` BANG on a missing `/lib/nex/obelisk-db.hoon`, and `/nex/groundwire.hoon`
and the `/lib/obelisk/*` libs do not compile. Lattice does **not** depend on any of
them.

## 10. This pier is slow. Budget for it

Desk builds take **10–20+ minutes**. MCP calls (`commit-desk`, `install-app`) time out
client-side while the build continues server-side, so a timeout is not a failure. The
serf sits at a *lifetime-average* ~30–60% CPU, so `ps %cpu` is useless for "is it
working". Sample real work instead:

```bash
j1=$(awk '{print $14+$15}' /proc/$SERF/stat); sleep 3
j2=$(awk '{print $14+$15}' /proc/$SERF/stat); echo $((j2-j1))   # >0 = building
```

## 11. Framework drift: `seen` became `view` (the real blocker)

**Correction: an earlier version of this doc claimed the nexus was
framework-compatible. It is not.** The lattice nexus was written against an older
grubbery. On this build it does not compile at all, which is why creating
`/apps/lattice.lattice_app` laid down an empty folder. `build-nexus` fails, the app
bangs, and nothing is ever served.

The breaking change: **`peek:io` used to return `seen = (each view tang)` and now
returns `view` directly**, with the old error side folded in as extra cases.

```hoon
:: lib/nexus.hoon on this build. note there is no +$ seen at all
+$  view
  $%  [%ball =wave ball=ball:tarball]
      [%file =cass:clay =sang:tarball]
      [%none ~]  [%miss ~]  [%veto ~]  [%tomb ~]
  ==
```

Migration, all mechanical (counts from the lattice nexus):

| Old | New | Sites |
|---|---|---|
| `seen:nexus` | `view:nexus` | 68 |
| `?=([%& %ball *] x)` | `?=([%ball *] x)` | 21 |
| `?=([%& %file *] x)` | `?=([%file *] x)` | 42 |
| `sang.p.x` / `ball.p.x` / `wave.p.x` / `cass.p.x` | drop the `.p` | 79 |

Three traps in that rewrite:

- **`;<  =seen:nexus` binds the face `seen`.** Renaming the type to `view:nexus`
  silently rebinds the face to `view` while every body reference still says `seen`.
  16 sites needed `seen=view:nexus` to keep the face. A blind type rename compiles
  into a wall of `-find`.
- **Do not touch `[%& %| …]` / `[%& %& …]`.** That `%&` is a *road* (rail-vs-fold), a
  different type entirely. Only `[%& %ball` and `[%& %file` are peek results.
  Likewise leave `name.p.sang`, `wake.p.res`, `dat.p.res` alone. Restrict the `.p`
  rule to the four field names above.
- **The `%peek` sign field renamed too.** A fiber that resolves on an incoming peek
  response reads the payload off the sign. The branch is `[~ %peek * *]` and the old
  field was `seen.u.in`, now `view.u.in` (the sign is `[%peek =wire =view]` in
  `lib/nexus.hoon`). This is separate from the `peek:io` return type, and the regex
  above won't catch it. Grep `seen\.` for field-style accesses after the bulk rename.

The sequence that worked: bulk-rename, then `check_bin`, then fix the one `-find` it
reports, then repeat. Each `-find.<name>` points at exactly the next unmigrated
reference. Three passes total here: `seen:nexus` bindings, then `-find.seen`, then
`-find.seen.u.in`.

### 11a. Second drift: `loader`'s versioning API

`lib/loader.hoon` also changed. The old nexus had a **read-side version gate** in
`on-load`:

```hoon
=/  =ver:loader  (get-ver:loader ball)     :: <- ver / get-ver / ver-row all GONE
?+  ver  !!
    ?(~ [~ %0])
  %+  spin:loader  ball
  :~  (ver-row:loader 0)
      … rows …
```

This build's `loader` has **no `ver`, `get-ver`, or `ver-row`**. Versioning is
write-only via `manifest:loader`, and there is no gate. Match the working nexuses
(obelisk):

```hoon
%+  spin:loader  ball
:~  (manifest:loader 0)
    … rows …
==
```

That is, delete the `=/ =ver` line and the whole `?+ ver … ==` wrapper (mind the
now-orphaned `==`), and swap `ver-row:loader 0` for `manifest:loader 0`.
`spin:loader` and `empty-dir:loader` are unchanged. Behaviour is preserved, since the
old gate only ever accepted `~`/`%0` anyway.

The moral for both drifts: a nexus carried from an older grubbery must be
**recompiled against the target build's `lib/nexus.hoon`, `lib/tarball.hoon`, and
`lib/loader.hoon`**, not assumed compatible. `check_bin` walks you through it one
`-find` at a time.

`canonical:` the ground truth for these types is `lib/nexus.hoon` and
`lib/tarball.hoon` in the **grubbery desk itself**. Read them there, and do not trust
this file's copies.

## 11b. `check_bin` is the fastest truth about compilation

Do not infer compile status from slogs (§8d) or from an empty app folder. Ask
directly:

```json
check_bin {"path":"/nex/lattice","name":"app"}
```

It returns `FAILED: /nex/lattice/app` plus the **error tang with line/column**, or
confirms success. This one call would have replaced most of the guesswork in this
whole effort.

`write_code` compiles immediately into the code namespace: a fast edit/compile loop
that avoids the 10–20 minute commit-and-wait cycle. Two naming quirks:

- `name` is the grub stem **as it appears in `/code`**, including the extension
  segment. For a nexus the compiled bin is `app` but the source grub is `app.hoon`,
  so use `write_code {"path":"/nex/lattice","name":"app.hoon","content":…}`.
  `name:"app"` returns `code: app not found`. (Confusingly, `check_bin` wants
  `name:"app"`, the *bin*, not the source grub. It now also accepts the `.hoon`
  form.)
- Writing `name:"app.hoon"` compiles into a **scratch grub**
  `/code/nex/lattice/app.hoon`, not the real nexus bin `app`. A clean compile there
  proves the *source is valid against the framework*, but it does not install
  anything. To actually update the running nexus you still commit the synced desk to
  clay, and sync-gub rebuilds the real `app` bin and reloads.

**Read write_code's exact message. Two OKs are not the same:**

| Message | Meaning |
|---|---|
| `OK: … compiled successfully` | Real success. The nexus vase built. |
| `OK: … non-vase artifact` | **Failure in disguise.** The nexus compile failed, so it stored the source as a raw (non-vase) grub. Treat as "did not compile." |
| `ERROR: … -find.<name>` | Compile error. `<name>` is the next unmigrated reference. |

So the reliable fast loop is: `write_code`, look for `compiled successfully` (not
just `OK:`), then commit + `check_bin` for the authoritative bin. `check_bin` remains
ground truth because write_code and the real build can resolve `/lib` imports from
different snapshots.

## 11c. Deploy status on ~tyr (2026-07-24): FULLY WORKING

After fixing **three** framework drifts (§11, §11a, §11d), lattice is fully
functional on ~tyr:

- The nexus **compiles** (`check_bin /nex/lattice app` → OK).
- `create_folder /apps name=lattice.lattice_app nexus=/lattice/app` + `%reload` lays
  down the **full `on-load` tree** (`pub/ know/ ui/ cat/ sub/ page/ comments/
  template/`, the `main.sig`/`crawler.sig`/`fs.sig` fibers, `bookmarks`,
  `manifest.json`).
- Reads serve under **`/apps/lattice`** (§1): `page-dump` / `page-tree` → 200.
- **Writes work**: `page-save` (200/2.1s), `save`+gain (200/1.1s), `bookmark`
  (200/0.8s). Pages persist and appear in `page-tree`/`page-dump`.
- **Benchmark** (§12): page-dump 0.53s vs the old page-tree+N×page-source ≈ 12.3s on
  21 pages. That is **23× faster**, constant-time.

The write path was blocked by the third drift below. The story of finding it is worth
keeping, because the technique generalizes.

**Narrowed by runtime diagnostics**: temporary `GET /apps/lattice/diag-*` routes that
run one operation from a request fiber and return the result as text. This is the
technique that finally gave visibility.

- `make-soft:io` of a dir grub, a `%page` grub, an `%eval-cmd` grub, and an
  `%eval-deps` grub all **succeed** (`ok-all-four-wrote`). The write primitives are
  fine.
- `gain:io` on a grub **returns in 0.5s**, so publishing is NOT the wedge.
- Deep `peek:io` over `/page` works (`page-tree`/`page-dump` serve 200 with nodes).
- Yet **every poke to the `main.sig` writer hangs at 000 with the serf idle**:
  `page-save`, `%save`, and even a trivial `bookmark` (`apply-bookmark` = read + one
  put-file, no gain).

### 11d. Third drift: the bowl server moved to `/sys/bowl.sig`

**Root cause found: the bowl server moved to `/sys/bowl.sig`.** The hunt:

1. `diag-pubweir` / `diag-heal` / `diag-tmpl` all returned fast, so no startup step
   wedges.
2. Instrumented the writer itself with marker grubs after each startup line
   (`make:io … diag-wN`). **All five markers appeared, including the one right before
   `take-poke`**, so the writer completes startup and *reaches the poke loop*. It is
   not wedged in startup at all.
3. That flipped the question to poke *delivery/processing*. `%pack` is what
   `poke:io` waits for. It is sent only when the poked fiber's turn **completes**
   (`give-poke-sign`), so a hung poke means the writer's turn never finishes. Since
   bookmark, page-save, AND %save all hang, three different `apply-*` arms, the
   failure is in the **shared prelude** of the loop: `take-poke:io` then `bowl-now`
   (line 116), which runs before any action dispatch.
4. `bowl-now`/`bowl-our` are lattice's *custom* time/our readers, used instead of
   `get-time:io`/`get-our:io` because those steal a queued poke in a busy fiber. They
   `poke:io &+&+[/sys/bowl %'main.sig']` and wait for the reply. **But this build
   serves the bowl at `/sys/bowl.sig`.** `get-time:io` pokes
   `&+&+[/sys %'bowl.sig']`, and `handle-bowl-req`'s rail is `[/sys %'bowl.sig']`. So
   `bowl-now` pokes a dead path (`/sys/bowl/main.sig`), never gets a reply, and
   **wedges the writer on every mutation** immediately after it consumes the poke.

Fix: point `bowl-now`/`bowl-our` at `&+&+[/sys %'bowl.sig']`. The response shape is
unchanged (`handle-bowl-req` replies `%poke [/ %time]`/`[/ %ship]`), so only the poke
target moves.

### The general lesson

Three independent framework drifts, none caught by `check_bin` (all compile), each
found a different way:

| Drift | Symptom | How found |
|---|---|---|
| `peek` returns `view` not `seen`, plus the `%peek` sign field | did not compile | `check_bin` `-find` loop |
| `loader` `ver`→`manifest` | did not compile | `check_bin` `-find` loop |
| bowl server `/sys/bowl`→`/sys/bowl.sig` | compiles, writer wedges at runtime | marker-grub instrumentation |
| usergroup dirs gained a `.grp` suffix | compiles, runs, **silently does nothing** | adversarial code review |

The fourth is the nastiest shape of all. Grubbery stores usergroups at
`/sys/ames/usergroups/<name>.grp` (`+grp-storage-path`), and lattice granted
share weirs at `/sys/ames/usergroups/public`. That directory does not exist, so
the `peek-exists` guard in `+share-weir` / `+ensure-pub-weir` failed and every
grant returned early **as a no-op**. Nothing logged, nothing crashed, sharing
appeared to work. But no foreign ship could read a shared page. Clearweb (plain
HTTP) was unaffected, which is why it survived so long.

The lesson to carry: a drift that fails to compile costs an afternoon. A drift
that turns a security-relevant write into a silent no-op can hide for months.
When a framework call is *supposed* to change permissions, assert the change
afterwards (read the weir back) rather than trusting the write.

A nexus carried across grubbery versions needs **all three** checked: recompile
against the target libs (compile drifts), then **exercise every runtime path**. A
request-response to a `/sys/*` grub can move without any compile error. When a fiber
wedges, instrument it with marker grubs (`make:io` writes a grub you can `browse`)
after each step. The last marker present is the last line that ran.

For the benchmark none of this mattered. A `diag-bulk` route writes N `/page` grubs
via `make:io` directly, bypassing the writer, enough to time page-dump vs page-tree.
See §12.

Static analysis: all passed, and none was the compile-blocking cause. The wedge was
a *runtime* path drift, found by instrumentation, not by any of these.

- All 29 `:io` calls the nexus makes exist in this build's `lib/fiberio.hoon`.
- Every `mar/lattice/*` mark compiles (`check_bin /mar/lattice/page` → OK).
- `make:io`'s call shape is byte-identical to the working `mcp.hoon` /
  `logbook.hoon`.
- The `%page` mark stores `page:lp` which is `@t`. The page's hoon source is `@t`, so
  `grab %noun` cannot nest-fail on it.

### §1 correction: apps bind under `/apps/<name>`, not `/grubbery/<name>`

The lattice `ui/main.sig` calls `bind-http:io [~ /apps/lattice]`, and the routes
serve there (`/apps/lattice/page-dump` → 200). The `/grubbery/<name>` list in §1 is
grubbery's **own internal nexuses** (api, ball, mcp, …). An installed app's front-end
binds where its `bind-http` says, and for lattice that is `/apps/lattice`.
`/grubbery/lattice/*` 307s to landscape precisely because nothing binds it.

## 12. What page-dump is, and the measured win

`GET /apps/lattice/page-dump` returns the whole page tree **with every page body
inline** from a **single deep peek**, instead of `page-tree` + N× `page-source`. It
lets the FUSE client warm its entire read-cache in one round-trip at mount and then
serve `rg`/`cat` from RAM.

**Measured on ~tyr, 21 pages** (populated via the `diag-bulk` route):

| Path | Time | Notes |
|---|---|---|
| `page-tree` (shape only) | ~1.08s | one deep peek, no bodies |
| per `page-source` | ~0.54s | one peek per body |
| **old cold-mount** = tree + 21×source | **~12.3s** | scales linearly with page count |
| **`page-dump`** (tree + all bodies) | **~0.53s** | one deep peek, constant-time |

That is **23× faster on 21 pages, and the gap widens with every page**, since
page-dump is flat and the old path is linear. On the loaded ~ricsul pier where a
per-page peek measured ~1.8s, the old 33-page cold mount took ~60s. page-dump makes
it one round-trip there too.

Code: `grubbery-overlay/nex/lattice/app.hoon` (`+fs-dump-json`, `+dump-walk`, the
`[%'GET' %page-dump]` route, and the `%page-dump` arm in `+fs-op`).
Client: `lattice-fs-rs/src/{projection,lattice,core}.rs` (`Projection::dump`,
warm-on-mount, non-blocking `ensure_fresh`, `write_gen` stale-swap guard).
