// Lattice bombadil specification (see scripts/bombadil.sh for the harness).
//
// Two jobs on top of bombadil's defaults:
//  1. STEERING. Random typing never produces a valid ~ship, so without help
//     the share-file path gets zero coverage (run 2: 134 events, not one on
//     the grant buttons). shareFlow walks the real flow: focus #shwith, type
//     a live dev ship, click read/edit.
//  2. ORACLES the defaults can't express: shared-with-me rows stay deduped
//     on [host path], and busy states ("saving…", "granting…") resolve.
//     A stall past 30s is the pier's queueing collapse showing up as a
//     recorded property violation instead of run 1's hard abort.
//
// Extractor thunks run INSIDE the browser. No closing over spec-level
// helpers. Define everything you need inside the function.
import {
  extract,
  always,
  now,
  eventually,
  actions,
  weighted,
} from "@antithesishq/bombadil";
export * from "@antithesishq/bombadil/browser/defaults";

// ponytail: grantee hardcoded to ~nec (the second dev ship). Parameterize
// via a fixtures import if we ever fuzz a different pair.
const GRANTEE = "~nec";

const shareUi = extract((state) => {
  const d = state.document;
  const c = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const w = d.getElementById("shwith");
  if (!w) return null;
  return {
    input: c(w),
    focused: d.activeElement === w,
    value: w.value || "",
    read: c(d.getElementById("shread")),
    edit: c(d.getElementById("shedit")),
  };
});

// Peers panel: per-group ship inputs ('~ship' placeholder, sibling "add
// ship" button). Also path inputs ('/apps/…' placeholder, sibling
// +read/+edit). Capped at 4 groups to bound the snapshot.
const permsUi = extract((state) => {
  const d = state.document;
  const c = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const list = d.getElementById("permlist");
  if (!list) return null;
  const grps = Array.from(list.querySelectorAll(".grp")).slice(0, 4);
  const ships = [];
  const paths = [];
  for (const g of grps) {
    // quarantine: the public group's opaque weir rules (incl. the shares
    // inbox poke road) are not re-creatable by any fuzz action. Deleting
    // that group would silently disable the sharing subsystem for the rest
    // of the run. Every other group stays fair game (the fuzzer deleted
    // collab once and the drift oracle caught it, working as intended).
    if (g.querySelector("b")?.textContent === "public") {
      const del = g.querySelector('button.ico[title="delete group"]');
      if (del) del.disabled = true;
    }
    const si = g.querySelector('input[placeholder="~ship"]');
    if (si) {
      ships.push({
        input: c(si),
        focused: d.activeElement === si,
        value: si.value || "",
        add: c(si.parentElement?.querySelector("button")),
      });
    }
    const pi = g.querySelector('input[placeholder^="/apps"]');
    if (pi) {
      const btns = Array.from(pi.parentElement?.querySelectorAll("button") ?? []);
      paths.push({
        input: c(pi),
        focused: d.activeElement === pi,
        value: pi.value || "",
        read: c(btns.find((b) => b.textContent === "+read")),
        edit: c(btns.find((b) => b.textContent === "+edit")),
      });
    }
  }
  return { ships, paths };
});

const statusText = extract(
  (state) => state.document.getElementById("status")?.textContent ?? "",
);
const shresText = extract(
  (state) => state.document.getElementById("shres")?.textContent ?? "",
);
// Entry links only: the remove "×" anchor has no href.
const swmRows = extract((state) => {
  const host = state.document.getElementById("swmlist");
  if (!host) return [];
  return Array.from(host.querySelectorAll(".chips a[href]")).map(
    (a) => a.textContent ?? "",
  );
});

// The peers/shared-with-me boot fetches starve behind the fuzz storm. The
// browser caps 6 connections per host, the keep-SSE beacon holds one
// forever, the pier serves ~1.3s/request serially, and constant clicking
// injects new requests ahead of the two tail-end fetches. Screenshots show
// "loading…" for entire runs. Offer Wait while they're pending so the queue
// can drain. That's a patient user, and without it permsFlow never has a
// rendered panel to steer. (The app-side fix, timeout/retry on those
// fetches, is a separate finding.)
const panelsLoading = extract((state) => {
  const d = state.document;
  const busy = (el) => !!el && (el.textContent || "").includes("loading");
  return busy(d.getElementById("permlist")) || busy(d.getElementById("swmlist"));
});
export const letPanelsLoad = weighted([
  [4, actions(() => (panelsLoading.current ? ["Wait"] : []))],
]);

// ── properties ─────────────────────────────────────────────────────────────

// put-entry dedupes on [host pax]. A re-share updates in place. Rows read
// "host path (mode)". Strip the mode so a read→edit upgrade isn't a dupe.
export const sharedWithMeNoDupes = always(() => {
  const keys = swmRows.current.map((t) => t.replace(/ \([a-z]+\)$/, ""));
  return new Set(keys).size === keys.length;
});

export const savingResolves = always(
  now(() => statusText.current.startsWith("saving")).implies(
    eventually(() => !statusText.current.startsWith("saving")).within(
      30,
      "seconds",
    ),
  ),
);

// A grant result must NAME the page it granted, never describe "this page".
// Two fuzz runs drove this. First the message survived tree clicks (fixed
// by clearing it in showShare). Then it survived the pages/knowledge
// toggle, because the editor's target changes from eleven places and only
// four route through showShare. So the invariant is not "clear it in time",
// it is "the claim must be self-describing". Whatever a grant resolves to
// must contain the page that was open when it was requested, or be cleared.
const openTarget = extract(
  (state) => state.document.getElementById("pname")?.value ?? "",
);
export const grantNamesItsPage = always(() => {
  const page = openTarget.current;
  return now(() => shresText.current.startsWith("granting")).implies(
    eventually(
      () =>
        shresText.current === "" ||
        (page !== "" && shresText.current.includes(page)),
    ).within(30, "seconds"),
  );
});

export const grantingResolves = always(
  now(() => shresText.current.startsWith("granting")).implies(
    eventually(() => !shresText.current.startsWith("granting")).within(
      30,
      "seconds",
    ),
  ),
);

// ── steering ───────────────────────────────────────────────────────────────

export const shareFlow = actions(() => {
  const ui = shareUi.current;
  if (!ui || !ui.input) return [];
  const v = ui.value.trim();
  if (v === GRANTEE) {
    const out = [];
    if (ui.read) out.push({ Click: { name: "share-read", point: ui.read } });
    if (ui.edit) out.push({ Click: { name: "share-edit", point: ui.edit } });
    return out;
  }
  if (ui.focused && v === "") {
    return [{ TypeText: { text: GRANTEE, delayMillis: 20 } }];
  }
  // junk in the input (defaults typed into it): nothing useful to offer.
  // Clicking grant with a bad ship is the server's problem to 4xx, and the
  // defaults' HTTP property will catch that on its own.
  if (v !== "") return [];
  return [{ Click: { name: "share-with-input", point: ui.input } }];
});

// Peers panel: every save round-trips the whole weir through
// share-group-save, so this is the surface most worth hammering with VALID
// input. Random typing never yields a ship or a path, so without steering
// the fuzzer only ever makes junk-named empty groups.
// ponytail: path hardcoded to a page known to exist on tyr. Parameterize
// with GRANTEE if we ever fuzz a different pair.
const GRANT_PATH = "/apps/lattice.lattice_app/page/yo";
export const permsFlow = actions(() => {
  const ui = permsUi.current;
  if (!ui) return [];
  const out = [];
  for (const s of ui.ships) {
    if (!s.input) continue;
    const v = s.value.trim();
    if (v === GRANTEE && s.add) out.push({ Click: { name: "perms-add-ship", point: s.add } });
    else if (s.focused && v === "") out.push({ TypeText: { text: GRANTEE, delayMillis: 20 } });
    else if (v === "") out.push({ Click: { name: "perms-ship-input", point: s.input } });
  }
  for (const p of ui.paths) {
    if (!p.input) continue;
    const v = p.value.trim();
    if (v === GRANT_PATH) {
      if (p.read) out.push({ Click: { name: "perms-grant-read", point: p.read } });
      if (p.edit) out.push({ Click: { name: "perms-grant-edit", point: p.edit } });
    } else if (p.focused && v === "") {
      out.push({ TypeText: { text: GRANT_PATH, delayMillis: 20 } });
    } else if (v === "") {
      out.push({ Click: { name: "perms-path-input", point: p.input } });
    }
  }
  return out;
});
