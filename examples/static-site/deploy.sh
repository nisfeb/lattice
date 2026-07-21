#!/usr/bin/env bash
# Deploy the static-site example to a running lattice.
# Usage: ./deploy.sh <base-url> <cookie-file>
#   e.g. ./deploy.sh http://localhost:8080/apps/lattice ~/tyr-cookie.txt
set -euo pipefail

B="${1:?base url, e.g. http://localhost:8080/apps/lattice}"
CK="${2:?path to an authenticated session cookie file}"
D="$(cd "$(dirname "$0")" && pwd)"

post() { # name type file
  curl -s -b "$CK" -X POST "$B/page-save?name=$1&type=$2" \
    --data-binary @"$3" -o /dev/null -w "  $1 [%{http_code}]\n"
}

echo "content:"
for p in intro guide about; do post "content/$p" md "$D/content/$p.md"; done
echo "assets:"
post theme   css "$D/theme.css"
post site-js js  "$D/site.js"
echo "builder:"
# the builder is a hoon page (no type)
curl -s -b "$CK" -X POST "$B/page-save?name=site" \
  --data-binary @"$D/site.hoon" -o /dev/null -w "  site [%{http_code}]\n"

echo "done — open the 'site' page."
