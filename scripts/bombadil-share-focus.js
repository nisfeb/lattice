// Focused verification: NO default actions, so the fuzzer cannot navigate
// away mid-grant. Boot straight onto an open page, drive only the share
// flow, and let each grant actually resolve, which is the only way the
// success message renders and grantNamesItsPage stops passing vacuously.
import { extract, always, now, eventually, actions } from "@antithesishq/bombadil";

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
const shresText = extract(
  (state) => state.document.getElementById("shres")?.textContent ?? "",
);
const openTarget = extract(
  (state) => state.document.getElementById("pname")?.value ?? "",
);

// Non-vacuous by construction: this run has no navigation, so every grant
// resolves and the consequent is exercised on the success path.
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

// The whole point of the fix: a resolved grant must never say "this page".
export const grantNeverSaysThisPage = always(
  () => !shresText.current.includes("this page"),
);

export const shareOnly = actions(() => {
  const ui = shareUi.current;
  if (!ui || !ui.input) return ["Wait"];
  const v = ui.value.trim();
  if (v === GRANTEE) {
    const out = [];
    if (ui.read) out.push({ Click: { name: "share-read", point: ui.read } });
    if (ui.edit) out.push({ Click: { name: "share-edit", point: ui.edit } });
    return out.length ? out : ["Wait"];
  }
  if (ui.focused && v === "") return [{ TypeText: { text: GRANTEE, delayMillis: 20 } }];
  if (v !== "") return ["Wait"];
  return [{ Click: { name: "share-with-input", point: ui.input } }];
});
