#!/usr/bin/env bash
# TICKET-116 cold-run harness. ONE definition of "cold", used for every run in
# the campaign so the numbers are comparable: no build artefacts, no reused
# server, no leftover results.
#   cold-run.sh <label> <repo-root> <port> <workers|-> <run-number>
set -uo pipefail
LABEL="$1"; ROOT="$2"; PORT="$3"; WORKERS="$4"; N="$5"
OUT="/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t116-e2e-built-server/work/measurements/ticket-116/runs"
mkdir -p "$OUT"
F="$OUT/${LABEL}-run${N}.txt"

cd "$ROOT" || exit 9
# cold: drop BOTH build dirs (main builds into .next via next dev; the branch
# builds into .next-e2e) plus prior results.
rm -rf .next-e2e .next test-results playwright-report

{
  echo "=== TICKET-116 cold run: ${LABEL} #${N} ==="
  echo "root:      $ROOT"
  echo "head:      $(git -C "$ROOT" rev-parse --short HEAD)"
  echo "port:      $PORT"
  echo "workers:   ${WORKERS}"
  echo "started:   $(date -u +%FT%TZ)"
  echo "loadavg:   $(sysctl -n vm.loadavg)"
  echo "---"
  START=$(date +%s)
  if [ "$WORKERS" = "-" ]; then
    PORT="$PORT" CI=1 npx playwright test --reporter=line 2>&1
  else
    PORT="$PORT" CI=1 npx playwright test --workers="$WORKERS" --reporter=line 2>&1
  fi
  RC=$?
  END=$(date +%s)
  echo "---"
  echo "exit-code: $RC"
  echo "wall-clock-seconds: $((END-START))"
  echo "finished:  $(date -u +%FT%TZ)"
  echo "loadavg-end: $(sysctl -n vm.loadavg)"
  echo "# --- END OF RUN ---"
} 2>&1 | tee "$F"

tail -1 "$F" | /usr/bin/grep -q -- "--- END OF RUN ---" || echo "TRUNCATED: $F -- do not cite"
