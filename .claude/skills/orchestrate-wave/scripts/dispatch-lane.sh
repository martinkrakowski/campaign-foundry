#!/usr/bin/env zsh
# Dispatch one or more lanes detached, staggered, and wait for their EXIT markers.
#
#   dispatch-lane.sh <logdir> <lane>:<worktree>:<brief> [<lane>:<worktree>:<brief> ...]
#
# Why staggered: two `opencode run` invocations started in the same instant contend on
# opencode's SQLite store and the second dies instantly with "database is locked" + EXIT 1.
# 45s apart is enough; both then run concurrently.
#
# Why the marker: a lane that dies at startup writes EXIT immediately, so a marker-only
# wait returns at once. This script prints each log's failure lines at the end — always
# read the body, never just the marker.
set -u
MODEL="${MODEL:-openrouter/z-ai/glm-5.3-flash}"
VARIANT="${VARIANT:-high}"
STAGGER="${STAGGER:-45}"

[ $# -ge 2 ] || { print -u2 "usage: $0 <logdir> <lane>:<worktree>:<brief> ..."; exit 2; }
LOGDIR="$1"; shift; mkdir -p "$LOGDIR"

lanes=()
first=1
for spec in "$@"; do
  lane="${spec%%:*}"; rest="${spec#*:}"; wt="${rest%%:*}"; brief="${rest#*:}"
  # Two lanes sharing a name would truncate and interleave one log, and the wait
  # below would count one marker as two.
  if (( ${lanes[(Ie)$lane]} )); then print -u2 "duplicate lane name: $lane"; exit 2; fi
  [ -d "$wt" ]    || { print -u2 "no worktree: $wt";   exit 2; }
  [ -f "$brief" ] || { print -u2 "no brief: $brief";   exit 2; }
  [ -d "$wt/node_modules" ] || print -u2 "warning: $wt has no node_modules — run yarn install first"
  log="$LOGDIR/$lane.log"; : > "$log"; lanes+=("$lane")
  [ $first -eq 1 ] || sleep "$STAGGER"
  first=0
  nohup zsh -c "cd ${(q)wt} && opencode run --auto --model ${(q)MODEL} --variant ${(q)VARIANT} \"\$(cat ${(q)brief})\" > ${(q)log} 2>&1; echo \"EXIT \$?\" >> ${(q)log}" >/dev/null 2>&1 & disown
  print "dispatched $lane -> $log"
done

# A lane killed by the OS (or a harness) never writes its marker, so an unbounded
# wait hangs the orchestrator forever. Bound it, and say which lanes are missing.
: ${WAIT_TIMEOUT:=5400}
print "waiting for ${#lanes[@]} lane(s), up to ${WAIT_TIMEOUT}s…"
started=$SECONDS
while :; do
  done_count=0; pending=()
  for lane in "${lanes[@]}"; do
    if grep -qE '^EXIT [0-9]+$' "$LOGDIR/$lane.log" 2>/dev/null; then
      (( done_count++ ))
    else
      pending+=("$lane")
    fi
  done
  (( done_count == ${#lanes[@]} )) && break
  if (( SECONDS - started > WAIT_TIMEOUT )); then
    print -u2 "TIMEOUT after ${WAIT_TIMEOUT}s — still pending: ${pending[*]}"
    print -u2 "Derive their real state before believing anything: gh pr list --head <branch>."
    break
  fi
  sleep 30
done

print "\n=== derived outcome (read the body, not just the marker) ==="
failed=0
for lane in "${lanes[@]}"; do
  log="$LOGDIR/$lane.log"
  marker=$(grep -E '^EXIT [0-9]+$' "$log" | tail -1)
  [[ "$marker" == "EXIT 0" ]] || (( failed++ ))
  print "$lane: ${marker:-<no marker>}, $(wc -c < "$log" | tr -d ' ') bytes"
  sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -iE 'insufficient balance|database is locked|^Error:' | head -3 | sed 's/^/    /'
done
print "\nNow derive each lane's real status: gh pr list --head <branch>; the gate in the worktree; git diff --stat (read deletions)."
# Exit non-zero when any lane failed or never reported, so a caller can gate on it.
# A zero exit here still means only "every lane reported EXIT 0" — never that a lane
# produced a usable PR. That remains a derived question, not this script's to answer.
(( failed == 0 )) || { print -u2 "$failed lane(s) did not report EXIT 0"; exit 1; }
