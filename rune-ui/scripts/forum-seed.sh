#!/bin/sh
# Puts a small forum on a fake ship, for the live forum test and the forum scripts:
# a board `general` with a pinned, tagged thread, a link thread and three comments, and a board `quiet`.
#   LATTICE_URL=http://localhost:8222 LATTICE_COOKIE=<cookie file> scripts/forum-seed.sh
set -u
B="${LATTICE_URL%/}/apps/lattice/forum"
CK="Cookie: $(cat "$LATTICE_COOKIE")"
P() { curl -s -o /dev/null -w "$1 %{http_code}\n" -H "$CK" -H "Origin: ${LATTICE_URL%/}" -X POST "$B/$1" --data "$2"; }
P _new "name=general&title=General+talk&description=Anything+goes&role=poster"
P general/submit "title=First+thread&body=The+**body**+of+the+first+thread.%0A%0A-+one%0A-+two&t1=intro&t2=meta"
P general/submit "title=A+link&url=https://urbit.org"
P general/1/comment "body=A+first+comment."
P general/1/comment "body=Another+top+comment."
P general/1/comment "body=A+reply+to+it.&parent=0"
P general/vote "target=post-1"
P general/1/pin "pinned=true"
P _new "name=quiet&title=Quiet+room&role=reader"
