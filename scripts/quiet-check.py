#!/usr/bin/env python3
"""Quiet check (docs/logging.md): the shipped code prints only through
+say, which carries a level, and debug output only under `~?  dbg`. Any
other ~&, ~?, slog or %slog fails, so a print added in review has to go
through the levels table.

Usage: scripts/quiet-check.py [code-dir]
"""
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'code')
# the vendored property-test library reports a refuted law by printing;
# only tests/ import it, and no nexus does (its header says why it stays)
SKIP = {'lib/lattice-quiz.hoon'}
PRINT = re.compile(r'~&|~\?|\bslog\b|%slog')
SAY = '~>  %slog.[pri i.tang]'          # the one print, inside +say

bad = []
for f in sorted(root.rglob('*.hoon')):
    rel = f.relative_to(root).as_posix()
    if rel in SKIP:
        continue
    for n, line in enumerate(f.read_text().splitlines(), 1):
        code = line.split('::', 1)[0]
        if not PRINT.search(code) or code.strip() == SAY:
            continue
        if re.search(r'~\?\s+dbg\b', code):
            continue
        bad.append(f'{rel}:{n}: {line.strip()}')

if bad:
    print('prints outside +say (docs/logging.md):')
    print('\n'.join('  ' + b for b in bad))
    sys.exit(1)
print('quiet: every print goes through +say')
