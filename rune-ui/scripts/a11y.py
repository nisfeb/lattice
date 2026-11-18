#!/usr/bin/env python3
"""Reads trees written by `lattice-rune --tree` and lists every control with no name.

A control is an element a person acts on: a button, a field, a switch, a link, a row of a tree, a tab.
Its name is what a screen reader says for it: its label, or failing that its own text.
Usage: scripts/a11y.py tree.json [tree.json ...]   Exits 1 when any control is unnamed.
"""
import json, sys

CONTROLS = {"button", "textbox", "text-input", "switch", "checkbox", "radio", "link", "slider", "combobox", "tab", "treeitem", "menuitem", "option", "searchbox", "spinbutton"}

HOLDERS = {"tree", "grid", "table", "list", "listbox", "menu", "tablist"}

def unnamed(path):
    tree = json.load(open(path))
    els = tree.get("elements", [])
    said = lambda e: (e.get("label") or e.get("name") or e.get("text") or "").strip()
    # what lies under each element, by its path: a button made of texts is named by them, as a reader names it,
    # and a field's frame holds the field itself, which carries the name
    named_under = set()
    for e in els:
        if said(e):
            parts = e["path"].split("/")
            for i in range(1, len(parts)):
                named_under.add("/".join(parts[:i]))
    out = []
    for e in els:
        # a control, or a tree, a grid or a dialog the focus can land on
        if e.get("inert") or not (e.get("role") in CONTROLS or (e.get("role") in HOLDERS and e.get("focusable")) or e.get("role") == "dialog"):
            continue
        if not said(e) and e["path"] not in named_under:
            out.append((e.get("role"), e.get("path")))
    return out, tree.get("warnings") or []

# the check checks itself: a button of only an icon is caught, one named by its text within is not
_els = [{"role": "button", "path": "a/x"}, {"role": "icon", "path": "a/x/i"}, {"role": "button", "path": "a/y"}, {"role": "text", "path": "a/y/t", "text": "Go"}, {"role": "textbox", "path": "a/f"}, {"role": "textbox", "path": "a/f/input", "label": "Name"}, {"role": "tree", "path": "a/t", "focusable": True}]
json.dump({"elements": _els}, open("/tmp/.a11y-self.json", "w"))
assert [w for _, w in unnamed("/tmp/.a11y-self.json")[0]] == ["a/x", "a/t"], unnamed("/tmp/.a11y-self.json")

bad = 0
for p in sys.argv[1:]:
    rows, warns = unnamed(p)
    for role, where in rows:
        print(f"{p}: unnamed {role}: {where}")
    for w in warns:
        print(f"{p}: rune warns: {w}")
    bad += len(rows)
print(f"{len(sys.argv) - 1} trees, {bad} unnamed controls")
sys.exit(1 if bad else 0)
