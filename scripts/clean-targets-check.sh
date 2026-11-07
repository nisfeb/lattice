#!/usr/bin/env bash
# clean-targets-check.sh: clean-targets.sh, dry run and --yes, in a scratch
# repo. Only a worktree whose branch has commits merged into origin/main,
# with no target dir touched in the last 2 hours and no process working in
# it, loses its target. A fresh worktree with no commits once lost its
# target while in use.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/clean-targets-check.XXXXXX")
sleeper=
cleanup() { [ -n "$sleeper" ] && kill "$sleeper" 2>/dev/null; rm -rf "$tmp"; }
trap cleanup EXIT
fails=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1${2:+: $2}"; fails=$((fails+1)); }
g() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }

# an origin with main, and a clone whose origin/main has merged branch done
g init -q -b main "$tmp/origin"
g -C "$tmp/origin" commit -q --allow-empty -m base
g clone -q "$tmp/origin" "$tmp/repo" 2>/dev/null
mkdir -p "$tmp/repo/scripts"; cp "$here/clean-targets.sh" "$tmp/repo/scripts/"
R="$tmp/repo"
mkwt() { g -C "$R" worktree add -q -b "$1" "$tmp/$1" "${2:-origin/main}" 2>/dev/null; }
mktarget() { mkdir -p "$tmp/$1/desktop/target/debug"; : >"$tmp/$1/desktop/target/CACHEDIR.TAG"
  echo x >"$tmp/$1/desktop/target/debug/blob"; }
old() { find "$tmp/$1/desktop/target" -exec touch -d '3 hours ago' {} +; }

# done: a branch with a commit, merged into main with a merge commit
for b in done recent busy; do
  mkwt "$b"; g -C "$tmp/$b" commit -q --allow-empty -m "work on $b"
done
for b in done recent busy; do
  g -C "$tmp/origin" fetch -q "$tmp/$b" "$b:$b"
  g -C "$tmp/origin" merge -q --no-ff "$b" -m "merge $b"
done
g -C "$R" fetch -q origin
mkwt fresh                       # no commits of its own, on main's tip
mkwt unmerged; g -C "$tmp/unmerged" commit -q --allow-empty -m wip
for b in done recent busy fresh unmerged; do mktarget "$b"; done
for b in done busy fresh unmerged; do old "$b"; done
(cd "$tmp/busy" && exec sleep 300) & sleeper=$!
sleep 0.2

out=$("$R/scripts/clean-targets.sh")
grep -q " MB  $tmp/done/desktop/target " <<<"$out" && ok "dry run lists the done worktree" || fail "dry run lists the done worktree" "$out"
for b in fresh recent busy unmerged; do
  grep -q " MB  $tmp/$b/" <<<"$out" && fail "dry run keeps $b" "$out" || ok "dry run keeps $b"
done
grep -q "keep  $tmp/fresh (no commits of its own)" <<<"$out" && ok "fresh is kept for having no commits" || fail "fresh is kept for having no commits" "$out"
grep -q "keep  $tmp/recent (.*touched" <<<"$out" && ok "recent is kept for its fresh target" || fail "recent is kept for its fresh target" "$out"
grep -q "keep  $tmp/busy (a process works in it)" <<<"$out" && ok "busy is kept for its process" || fail "busy is kept for its process" "$out"
[ -d "$tmp/done/desktop/target" ] && ok "a dry run deletes nothing" || fail "a dry run deletes nothing"

"$R/scripts/clean-targets.sh" --yes >/dev/null
[ ! -d "$tmp/done/desktop/target" ] && ok "--yes deletes the done target" || fail "--yes deletes the done target"
for b in fresh recent busy unmerged; do
  [ -d "$tmp/$b/desktop/target" ] && ok "--yes keeps $b's target" || fail "--yes keeps $b's target"
done

[ "$fails" = 0 ] && echo "PASS clean-targets-check" || echo "FAIL clean-targets-check ($fails)"
exit $((fails > 0))
