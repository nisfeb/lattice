#!/usr/bin/env python3
"""bill-check.py <code-dir> — is bill.json something desk.hoon can read?

Grubbery's +apply-bill reads the bill like this:

    =/  entries=(list [@t @t])
      (turn ~(tap by p.u.bill) |=([k=@t v=json] [k (so:dejs:format v)]))

so:dejs demands a STRING for every value in the object. A value of any other
shape crashes the gate, and the crash takes the ENTIRE bill with it - every
valid entry included. A crashed fiber rolls its event back, so the install
simply stops: no instance, no consent ask, manifest.json frozen at version 0,
and nothing in the log to say why.

That cost a full end-to-end run. bill.json still carried an "adopt" object
from a design that had been reverted; the migration had moved into app.hoon
and the block was debris on the other side of the boundary.

Two checks, both about what the ship will do with this file:

  1. every value is a string             (else +apply-bill crashes)
  2. every value names a nexus that is actually in code/
                                         (else the instance is made against
                                          a neck with nothing behind it)

Exit 1 if either fails.
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip())
        return 1
    code = sys.argv[1].rstrip("/")
    path = os.path.join(code, "bill.json")

    try:
        with open(path) as fh:
            bill = json.load(fh)
    except FileNotFoundError:
        print(f"  MISSING  {path}")
        return 1
    except json.JSONDecodeError as exc:
        print(f"  UNPARSEABLE  {path}: {exc}")
        return 1

    if not isinstance(bill, dict):
        print(f"  NOT AN OBJECT  {path} is {type(bill).__name__}")
        return 1

    bad = 0
    for name, value in sorted(bill.items()):
        if not isinstance(value, str):
            kind = type(value).__name__
            print(f"  CRASHES  '{name}' is {kind}, not a string")
            print("           so:dejs bails and the whole bill is lost")
            bad += 1
            continue
        # "/lattice/app" -> code/nex/lattice/app.hoon
        rel = value.lstrip("/")
        src = os.path.join(code, "nex", rel + ".hoon")
        if not os.path.exists(src):
            print(f"  NO NEXUS  '{name}' -> {value}, but {src} is absent")
            bad += 1
            continue
        print(f"  ok       {name:<24} -> {value}")

    print(f"{bad} unreadable entr{'y' if bad == 1 else 'ies'} in bill.json")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
