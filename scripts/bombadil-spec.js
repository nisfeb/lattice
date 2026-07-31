// Lattice bombadil specification (see scripts/bombadil.sh for the harness).
//
// Two jobs on top of bombadil's defaults:
//  1. STEERING. Random typing never produces a valid ~ship, so without help
//     the share-file path gets zero coverage (run 2: 134 events, not one on
//     the grant buttons). shareFlow walks the real flow: focus #shwith, type
//     a live dev ship, click read/edit.
//  2. ORACLES the defaults can't express: shared-with-me rows stay deduped
//     on [host path], and busy states ("saving…", "granting…") resolve —
//     a stall past 30s is the pier's queueing collapse showing up as a
//     recorded property violation instead of run 1's hard abort.
//
// Extractor thunks run INSIDE the browser: no closing over spec-level
// helpers, define everything you need inside the function.
import { extract, always, now, eventually, actions } from "@antithesishq/bombadil";
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

// ── properties ─────────────────────────────────────────────────────────────

// put-entry dedupes on [host pax]; a re-share updates in place. Rows read
// "host path (mode)" — strip the mode so a read→edit upgrade isn't a dupe.
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
  // junk in the input (defaults typed into it): nothing useful to offer —
  // clicking grant with a bad ship is the server's problem to 4xx, and the
  // defaults' HTTP property will catch that on its own.
  if (v !== "") return [];
  return [{ Click: { name: "share-with-input", point: ui.input } }];
});
