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
MODEL="${MODEL:-opencode/big-pickle}"
VARIANT="${VARIANT:-high}"
# Rule 7 (references/cast.md): every delegated run reports its own cost, because there is
# no retroactive accounting — nothing on disk keeps a per-conversation token record, so a
# run launched without this can never be costed. `--format json` makes opencode emit raw
# JSON events; the wrapper's `EXIT n` marker is appended by the shell and is unaffected.
# Set USAGE_FLAGS="" to opt out for a run you deliberately do not want measured.
USAGE_FLAGS="${USAGE_FLAGS---format json}"
STAGGER="${STAGGER:-45}"

[ $# -ge 2 ] || { print -u2 "usage: $0 <logdir> <lane>:<worktree>:<brief> ..."; exit 2; }
LOGDIR="$1"; shift; mkdir -p "$LOGDIR"

# Wave-status events (D103): emitting is part of the stage, not a courtesy. WAVE is
# overridable so tests can pin it; it defaults to the log dir's own name.
WAVE="${WAVE:-${LOGDIR:t}}"
WAVE_EVENT="${0:A:h}/../../../../scripts/wave-event.sh"
emit_event() {
  if [[ -x "$WAVE_EVENT" ]]; then
    "$WAVE_EVENT" "$LOGDIR" "$WAVE" "$@"
  else
    print -u2 "warning: $WAVE_EVENT not found — event not emitted: $*"
  fi
}
# Test hook: the command run inside the worktree, overridable so a fake lane can be
# `true`/`false`. The default is the real implementer invocation, unchanged.
LANE_CMD="${LANE_CMD:-}"

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
  emit_event "$lane" dispatch started
  [ $first -eq 1 ] || sleep "$STAGGER"
  first=0
  if [[ -n "$LANE_CMD" ]]; then
    nohup zsh -c "cd ${(q)wt} && ${LANE_CMD} > ${(q)log} 2>&1; echo \"EXIT \$?\" >> ${(q)log}" >/dev/null 2>&1 & disown
  else
    nohup zsh -c "cd ${(q)wt} && opencode run ${=USAGE_FLAGS} --auto --model ${(q)MODEL} --variant ${(q)VARIANT} \"\$(cat ${(q)brief})\" > ${(q)log} 2>&1; echo \"EXIT \$?\" >> ${(q)log}" >/dev/null 2>&1 & disown
  fi
  print "dispatched $lane -> $log"
done

# A lane killed by the OS (or a harness) never writes its marker, so an unbounded
# wait hangs the orchestrator forever. Bound it, emit implement failed for every
# still-pending lane, and say which lanes are missing.
: ${WAIT_TIMEOUT:=5400}
# Poll cadence; overridable so tests with instant fake lanes do not wait a full 30s.
POLL="${POLL:-30}"
# Terminal implement events fire the first time a lane's marker is seen — a fast
# lane must not read as in-flight until the slowest sibling finishes. Timeout
# (no marker) is implement failed with reason timeout. The post-wait loop only
# accounts for exit codes.
typeset -A emitted
print "waiting for ${#lanes[@]} lane(s), up to ${WAIT_TIMEOUT}s…"
started=$SECONDS
while :; do
  done_count=0; pending=()
  for lane in "${lanes[@]}"; do
    marker=$(grep -E '^EXIT [0-9]+$' "$LOGDIR/$lane.log" 2>/dev/null | tail -1)
    if [[ -n "$marker" ]]; then
      if (( ! ${+emitted[$lane]} )); then
        if [[ "$marker" == "EXIT 0" ]]; then
          emit_event "$lane" implement settled
        else
          emit_event "$lane" implement failed
        fi
        emitted[$lane]=1
      fi
      (( done_count++ ))
    else
      pending+=("$lane")
    fi
  done
  (( done_count == ${#lanes[@]} )) && break
  if (( SECONDS - started > WAIT_TIMEOUT )); then
    print -u2 "TIMEOUT after ${WAIT_TIMEOUT}s — still pending: ${pending[*]}"
    print -u2 "Derive their real state before believing anything: gh pr list --head <branch>."
    for lane in "${pending[@]}"; do
      emit_event "$lane" implement failed --detail '{"reason":"timeout"}'
    done
    break
  fi
  sleep "$POLL"
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
