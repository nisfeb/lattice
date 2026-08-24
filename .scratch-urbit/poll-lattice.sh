#!/usr/bin/env bash
# Poll the tyr lattice endpoint until it answers 200 (rebuild done) or 20 tries.
for i in $(seq 1 20); do
  code=$(curl -s -m 45 -H "Cookie: $(cat /home/sneagan/.config/lattice-fs/cookie)" http://localhost:8081/apps/lattice -o /dev/null -w '%{http_code}')
  echo "attempt $i: $code"
  if [ "$code" = "200" ]; then exit 0; fi
  sleep 30
done
exit 1
