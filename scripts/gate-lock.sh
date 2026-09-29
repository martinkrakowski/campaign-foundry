#!/bin/sh
# The in-repo gate lock (plan D183, lane HX3-gate-in-repo). `yarn gate` takes it
# around the only two steps that must not run concurrently on one host —
# `test:cov` and `verify-manifests` — and its liveness is what makes a crashed
# holder self-healing instead of an orphan someone releases by hand.
#
#   gate-lock.sh acquire <lane>   take the lock; exit 75 means BUSY
#   gate-lock.sh release <lane>   drop it (the holder's trap, or a human by hand)
#   gate-lock.sh status           print who holds it and whether they look alive
#   gate-lock.sh heartbeat        refresh the beat (the holder's loop calls this)
#
# The lock is a directory at ${TMPDIR:-/tmp}/cf-gate.lock — mkdir is the
# atomic test-and-set, there is nothing else in POSIX sh — holding four files:
#   owner    the lane id that took it
#   pid      the CALLER's pid (the shell that runs the locked steps)
#   started  epoch second of acquisition
#   beat     epoch second of the last heartbeat
# The pid is the caller's, not this script's: `sh gate-lock.sh acquire` is a
# child that exits the moment acquire returns, and a lock naming a pid that is
# already gone would be reclaimed instantly and never block anyone. gate.sh
# passes its own pid in CF_GATE_CALLER_PID; a direct invocation falls back to
# this process, which makes such a lock trivially reclaimable — direct use is
# for poking at the lock, not for holding it through a real gate.
#
# acquire judges a held lock in this order, and says so on stdout before it
# reclaims:
#   1. the recorded pid is not alive (`kill -0`)  -> reclaimed;
#   2. the beat is older than 10 minutes          -> reclaimed
#      (CF_GATE_STALE_SECONDS overrides the threshold; the default stays 600);
#   3. otherwise the holder is alive and fresh    -> exit 75.
# A pid can be recycled after a crash, which is exactly why the heartbeat
# exists: a live-looking pid with a stale beat is still reclaimed.
#
# Exit 75 means BUSY, and this script defines that contract: the holder named
# in the lock is alive and its beat is fresh. Sleep and retry; do not remove
# the lock by hand while its holder may still be running.
#
# POSIX sh (not zsh): GitHub Linux runners do not ship zsh, and any test that
# spawns zsh fails in CI. For the same reason there is no $PPID (dash does not
# set it) and no fractional sleep assumption beyond what BSD and GNU sleep both
# accept — the waits below use whole seconds.
#
# Residual race, named honestly: two acquirers that both judge the lock
# reclaimable are arbitrated by `mv` (only one wins the rename; the loser
# re-inspects and eventually exits 75). A fresh acquirer whose half-written
# lock is read in the microseconds between its file writes is protected by
# ordered writes (pid before beat) plus bounded re-reads, not eliminated; a
# lock is dev-host machinery, and the cost of a full retry loop is minutes.
set -u

LOCK="${TMPDIR:-/tmp}/cf-gate.lock"
BUSY=75

STALE_SECONDS="${CF_GATE_STALE_SECONDS:-600}"
case "$STALE_SECONDS" in
  ''|*[!0-9]*)
    printf '%s\n' "gate-lock: CF_GATE_STALE_SECONDS must be a number of seconds: $STALE_SECONDS" >&2
    exit 2
    ;;
esac

# The pid recorded in the lock: the caller's when it says so (gate.sh does),
# otherwise this process — which is gone as soon as this script returns, and
# therefore always reclaimable.
recorded_pid="${CF_GATE_CALLER_PID:-$$}"

usage() {
  printf '%s\n' "usage: $0 acquire <lane> | release <lane> | status | heartbeat" >&2
  exit 2
}

pid_alive() {
  case "$1" in
    ''|0|*[!0-9]*)
      # Empty, zero (kill -0 0 would signal the whole process group) or not a
      # number: not a pid we can vouch for.
      return 1
      ;;
  esac
  kill -0 "$1" 2>/dev/null
}

beat_is_stale() {
  case "$1" in
    ''|*[!0-9]*)
      # A beat that cannot be read is as good as stale: the holder writes it
      # during acquire, so its absence past the read-waits means the lock was
      # abandoned mid-write or corrupted.
      return 0
      ;;
  esac
  now=$(date +%s)
  # A future beat (clock stepped between holders) is not stale.
  [ $((now - $1)) -ge "$STALE_SECONDS" ]
}

# mkdir the lock and write it. The pid file is written BEFORE the beat on
# purpose: every half-written state then either waits (both files missing, or
# the beat trailing the pid — both handled in acquire) or reads as dead, and
# the read-back below catches the name having been taken over between mkdir
# and the pid write. Returns 0 only if the lock is verifiably ours.
try_create() {
  mkdir "$LOCK" 2>/dev/null || return 1
  now=$(date +%s)
  printf '%s\n' "$1" > "$LOCK/owner" 2>/dev/null || return 1
  printf '%s\n' "$now" > "$LOCK/started" 2>/dev/null || return 1
  printf '%s\n' "$recorded_pid" > "$LOCK/pid" 2>/dev/null || return 1
  printf '%s\n' "$now" > "$LOCK/beat" 2>/dev/null || return 1
  [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$recorded_pid" ] || return 1
  return 0
}

# Move a judged-stale lock aside and delete it. `mv` is the arbitration: two
# concurrent reclaimers cannot both win the rename, and an acquirer that
# recreated the name in between makes our mv fail — the loop re-inspects.
take_stale() {
  if mv "$LOCK" "$LOCK.reclaim.$$" 2>/dev/null; then
    rm -rf "$LOCK.reclaim.$$"
  fi
}

busy_exit() {
  printf '%s\n' "gate-lock: busy — held by ${1:-unknown} (pid ${2:-?}, beat ${3:-?}); 75 means busy: sleep and retry, never remove the lock by hand" >&2
  exit $BUSY
}

acquire() {
  lane=$1
  pass=0
  while :; do
    pass=$((pass + 1))
    if try_create "$lane"; then
      printf '%s\n' "gate-lock: acquired by $lane (pid $recorded_pid)"
      return 0
    fi
    pid=$(cat "$LOCK/pid" 2>/dev/null)
    beat=$(cat "$LOCK/beat" 2>/dev/null)
    owner=$(cat "$LOCK/owner" 2>/dev/null)
    # A writer may sit between mkdir and its first writes; re-read instead of
    # judging a half-written lock (bounded — an abandoned one is reclaimed at
    # pass 3). The second wait covers the pid-before-beat write order.
    if [ -z "$pid" ] && [ -z "$beat" ] && [ "$pass" -lt 3 ]; then
      sleep 1
      continue
    fi
    if [ -n "$pid" ] && pid_alive "$pid" && [ -z "$beat" ] && [ "$pass" -lt 3 ]; then
      sleep 1
      continue
    fi
    if [ -n "$pid" ] && pid_alive "$pid" && ! beat_is_stale "$beat"; then
      busy_exit "$owner" "$pid" "$beat"
    fi
    if [ "$pass" -ge 5 ]; then
      # Five passes without winning the name: someone else is reclaiming it.
      busy_exit "$owner" "${pid:-none}" "${beat:-none}"
    fi
    if [ -n "$pid" ] && pid_alive "$pid"; then
      printf '%s\n' "gate-lock: reclaiming — owner ${owner:-unknown} (pid $pid) has a stale or missing heartbeat (beat ${beat:-missing}, threshold ${STALE_SECONDS}s)"
    else
      printf '%s\n' "gate-lock: reclaiming — owner ${owner:-unknown} (pid ${pid:-none}) is not alive"
    fi
    take_stale
  done
}

release() {
  if [ ! -d "$LOCK" ]; then
    printf '%s\n' "gate-lock: nothing to release — no lock at $LOCK"
    return 0
  fi
  owner=$(cat "$LOCK/owner" 2>/dev/null)
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  rm -rf "$LOCK"
  printf '%s\n' "gate-lock: released by $1 (was held by ${owner:-unknown}, pid ${pid:-?})"
  return 0
}

status() {
  if [ ! -d "$LOCK" ]; then
    printf '%s\n' "gate-lock: free (no lock at $LOCK)"
    return 0
  fi
  owner=$(cat "$LOCK/owner" 2>/dev/null)
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  started=$(cat "$LOCK/started" 2>/dev/null)
  beat=$(cat "$LOCK/beat" 2>/dev/null)
  if pid_alive "$pid"; then
    life="pid $pid alive"
  else
    life="pid ${pid:-none} not alive"
  fi
  if beat_is_stale "$beat"; then
    heart="heartbeat stale or missing (threshold ${STALE_SECONDS}s)"
  else
    heart="heartbeat fresh (beat $beat)"
  fi
  printf '%s\n' "gate-lock: held by ${owner:-unknown} (started ${started:-?}, $life, $heart)"
  return 0
}

heartbeat() {
  if [ ! -d "$LOCK" ]; then
    printf '%s\n' "gate-lock: heartbeat — no lock at $LOCK; nothing to refresh" >&2
    return 1
  fi
  if ! printf '%s\n' "$(date +%s)" > "$LOCK/beat" 2>/dev/null; then
    printf '%s\n' "gate-lock: heartbeat — cannot write $LOCK/beat" >&2
    return 1
  fi
  return 0
}

case "${1:-}" in
  acquire)
    [ $# -ge 2 ] || usage
    acquire "$2"
    ;;
  release)
    [ $# -ge 2 ] || usage
    release "$2"
    ;;
  status)
    [ $# -eq 1 ] || usage
    status
    ;;
  heartbeat)
    [ $# -eq 1 ] || usage
    heartbeat
    ;;
  *)
    usage
    ;;
esac