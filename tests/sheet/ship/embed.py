#!/usr/bin/env python3
"""Write the files of tests/sheet/ship into tests/lib/lattice-fods.hoon.

The Hoon suite cannot read a file from the test desk without a mark for
it, so each fixture is kept there as a cord in an arm of its own, after
the line that names this script. Run it after changing a fixture:

    python3 tests/sheet/ship/embed.py

01-budget.fods was written by LibreOffice 26.8 (soffice --headless
--convert-to fods) from a hand-made flat ODS. 02-hostile.fods is
hand-made.
"""
import os

here = os.path.dirname(os.path.abspath(__file__))
suite = os.path.join(here, '..', '..', 'lib', 'lattice-fods.hoon')
MARK = '::  the files of tests/sheet/ship, as cords (embed.py)\n::\n'
ARMS = [('f-budget', '01-budget.fods'), ('f-hostile', '02-hostile.fods')]


def cord(text):
    out = []
    for ch in text:
        if ch == '\\':
            out.append('\\\\')
        elif ch == "'":
            out.append("\\'")
        elif ch == '\n':
            out.append('\\0a')
        elif ord(ch) < 32 or ord(ch) == 127:
            out.append('\\%02x' % ord(ch))
        else:
            out.append(ch)
    return "'" + ''.join(out) + "'"


src = open(suite, encoding='utf-8').read()
head = src[:src.index(MARK) + len(MARK)]
arms = []
for arm, name in ARMS:
    text = open(os.path.join(here, name), encoding='utf-8').read()
    arms.append('++  %s\n  %s\n' % (arm, cord(text)))
open(suite, 'w', encoding='utf-8').write(head + ''.join(arms) + '--\n')
print('embedded', ', '.join(n for _, n in ARMS))
