// Lattice bombadil specification (see scripts/bombadil.sh for the harness).
//
// Two jobs on top of bombadil's defaults:
//  1. STEERING. Random typing never produces a valid ~ship, so without help
//     the share-file path gets zero coverage (run 2: 134 events, not one on
//     the grant buttons). shareFlow walks the real flow: focus #shwith, type
//     a live dev ship, click read/edit.
//  2. ORACLES the defaults can't express: busy states ("saving…",
//     "granting…") resolve. A stall past 30s is the pier's queueing collapse
//     showing up as a recorded property violation instead of run 1's hard
//     abort.
//
// Extractor thunks run INSIDE the browser. No closing over spec-level
// helpers. Define everything you need inside the function.
import {
  extract,
  always,
  now,
  eventually,
  actions,
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

const statusText = extract(
  (state) => state.document.getElementById("status")?.textContent ?? "",
);
const shresText = extract(
  (state) => state.document.getElementById("shres")?.textContent ?? "",
);

// ── properties ─────────────────────────────────────────────────────────────

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

// ── mobile: full-screen editing ────────────────────────────────────────────
//
// Only reachable with LATTICE_MOBILE=1 (the control is display:none above
// 820px). At desktop width these read vacuously true, which is correct: there
// is nothing to trap you in when every pane is visible at once.
//
// The failure this exists for is not cosmetic. Full screen hides the bar AND
// the tab strip, so if the way out ever goes with them, the phone is stuck
// on one pane with no route to the tree, no save button, and no exit — a
// reload is the only escape. A fuzzer that clicks everything is exactly the
// adversary that finds that, which is why it belongs here and not only in
// the matrix, where the toggle is driven in a known order.
const fullState = extract((state) => {
  const d = state.document;
  const ws = d.getElementById("ws");
  const vis = (el) => {
    if (!el) return false;
    const st = d.defaultView.getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden";
  };
  return {
    full: !!ws && ws.classList.contains("full"),
    mv: ws ? ws.dataset.mv || "" : "",
    exit: vis(d.getElementById("fullt")),
    tabs: vis(d.querySelector(".mtabs")),
    bar: vis(d.querySelector(".bar")),
    editor: vis(d.getElementById("src")),
  };
});

// The one that matters: in full screen there is ALWAYS a way back.
export const fullScreenHasAnExit = always(() => {
  const f = fullState.current;
  if (!f.full || f.mv !== "code") return true;
  return f.exit;
});

// ...and full screen never costs you the editor it exists to enlarge.
export const fullScreenKeepsTheEditor = always(() => {
  const f = fullState.current;
  if (!f.full || f.mv !== "code") return true;
  return f.editor;
});

// Leaving it restores the chrome. Guards a half-exit that clears the class
// but leaves the bar hidden, which looks identical to being stuck.
export const leavingFullScreenRestoresChrome = always(() => {
  const f = fullState.current;
  if (f.full || f.mv !== "code") return true;
  return f.tabs && f.bar;
});

// ── conflicts ──────────────────────────────────────────────────────────────
//
// A conflicts/ page is a save that replaced someone else's edit; the badge is
// the only thing that says so. If the badge is showing it must carry a count,
// and if it claims a count there must be pages behind it — a badge that lies
// in either direction is worse than no badge, because the whole point is
// noticing something you did not know to look for.
const conflictState = extract((state) => {
  const d = state.document;
  const b = d.getElementById("cflt");
  if (!b) return { present: false, shown: false, text: "" };
  const st = d.defaultView.getComputedStyle(b);
  return {
    present: true,
    shown: !b.hidden && st.display !== "none",
    text: (b.textContent || "").trim(),
  };
});
export const conflictBadgeCountsSomething = always(() => {
  const c = conflictState.current;
  if (!c.present || !c.shown) return true;
  return /\d/.test(c.text);
});
