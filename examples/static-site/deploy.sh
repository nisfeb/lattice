#!/usr/bin/env bash
# Deploy AND publish the static-site example to a running lattice.
# Usage: ./deploy.sh <base-url> <cookie-file>
#   e.g. ./deploy.sh http://localhost:8080/apps/lattice ~/tyr-cookie.txt
#
# Everything is created under the /site folder, then published to the clear web
# with a SINGLE %share-tree action. Tear it down with:
#   curl -b <cookie> -X POST '<base>/page-share-tree?name=site&mode=private'
set -euo pipefail

B="${1:?base url, e.g. http://localhost:8080/apps/lattice}"
CK="${2:?path to an authenticated session cookie file}"
D="$(cd "$(dirname "$0")" && pwd)"

post() { # name type file
  curl -s -b "$CK" -X POST "$B/page-save?name=$1&type=$2" \
    --data-binary @"$3" -o /dev/null -w "  $1 [%{http_code}]\n"
}

echo "content (markdown):"
for p in intro guide about; do post "site/content/$p" md "$D/content/$p.md"; done
echo "assets:"
post site/theme css "$D/theme.css"
post site/app   js  "$D/site.js"
echo "builder (hoon, no type):"
curl -s -b "$CK" -X POST "$B/page-save?name=site/index" \
  --data-binary @"$D/site.hoon" -o /dev/null -w "  site/index [%{http_code}]\n"

echo "publish the whole /site folder to the clear web (one action):"
curl -s -b "$CK" -X POST "$B/page-share-tree?name=site&mode=clearweb" \
  -w "  share-tree [%{http_code}]\n" -o /dev/null

echo "done — the public site is at ${B%/apps/lattice}/apps/lattice/c/site/index"
