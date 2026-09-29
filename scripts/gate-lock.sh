#!/bin/sh
# The in-repo gate lock (plan D183, lane HX3-gate-in-repo). `yarn gate` takes it
# around the only two steps that must not run concurrently on one host —
# `test:cov` and `verify-manifests` — and its liveness is what makes a crashed
# holder self-healing instead of an orphan someone releases by hand.
#
#   gate-lock.sh acquire <lane>   take the lock; exit 75 means BUSY
#   gate-lock.sh release <lane>   drop it — only the lock's own owner and pid may
#   gate-lock.sh status           print who holds it and whether they look alive
#   gate-lock.sh heartbeat        refresh the beat — only on the caller's own lock
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
# for poking at the lock, not for holding it through a real gate. Release and
# heartbeat honour the same variable: they act only when the lock still names
# that owner and pid, so a holder whose lock was reclaimed can neither delete
# the replacement nor keep refreshing its beat.
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
# Residual races, named honestly: two acquirers that both judge the lock
# reclaimable are arbitrated by `mv` (only one wins the rename; the loser
# re-inspects and eventually exits 75), and creation is atomic (a fully
# written temp directory renamed onto the name), so no half-written lock can
# appear at the name for a contender to misjudge. A reclaimer that renamed a
# lock it did not inspect restores or leaves it rather than deleting it (see
# take_stale). A lock is dev-host machinery; nothing here assumes a filesystem
# more clever than rename.
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

# mkdir the lock and write it. Creation is atomic: the metadata is written
# into a temp directory first, and `mv` moves the FINISHED directory onto the
# lock name — the rename is the only moment the name exists. A lock without
# metadata can therefore only be one that was abandoned, never one still
# being written: the old mkdir-then-write ordering had exactly that window,
# and a contender that reclaimed the half-written name left its creator
# writing into a directory it no longer owned. A failed `mv` means the name
# is held (a directory rename onto a non-empty directory fails), i.e. busy.
# Returns 0 only if the lock is verifiably ours.
try_create() {
  cand="$LOCK.cand.$$"
  # Our own pid is unique among live processes, so a leftover cand dir with
  # this name can only be a dead attempt's (pids recycle); clear it first.
  rm -rf "$cand" 2>/dev/null
  mkdir "$cand" 2>/dev/null || return 1
  now=$(date +%s)
  printf '%s\n' "$1" > "$cand/owner" 2>/dev/null || { rm -rf "$cand"; return 1; }
  printf '%s\n' "$now" > "$cand/started" 2>/dev/null || { rm -rf "$cand"; return 1; }
  printf '%s\n' "$recorded_pid" > "$cand/pid" 2>/dev/null || { rm -rf "$cand"; return 1; }
  printf '%s\n' "$now" > "$cand/beat" 2>/dev/null || { rm -rf "$cand"; return 1; }
  # Test hook (CF_GATE_TEST_PAUSE_BEFORE_MV): a pause point between the fully
  # written temp directory and the rename, so a test can prove no partial
  # lock ever appears at the name and can race a contender in.
  if [ -n "${CF_GATE_TEST_PAUSE_BEFORE_MV:-}" ]; then
    touch "$CF_GATE_TEST_PAUSE_BEFORE_MV" 2>/dev/null
    while [ -f "$CF_GATE_TEST_PAUSE_BEFORE_MV" ]; do sleep 1; done
  fi
  if mv "$cand" "$LOCK" 2>/dev/null; then
    # Read-back: the name holds OUR metadata — a rename cannot have replaced
    # a non-empty directory, so nothing could have taken the name in between.
    [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$recorded_pid" ] || return 1
    return 0
  fi
  rm -rf "$cand"
  return 1
}

# Move a judged-stale lock aside and delete it — but only the lock that was
# judged. `mv` is the arbitration: two concurrent reclaimers cannot both win
# the rename, and an acquirer that recreated the name in between makes our mv
# fail — the loop re-inspects. The verification closes the subtler race: a
# fresh lock that replaced the stale one between the inspection (above) and
# this rename. After the move, the moved directory's owner, pid and beat must
# still be the ones that were judged stale; anything else is a lock that was
# never judged — a fresh holder's — and it is NEVER deleted: it is renamed
# back when the name is still free, and left aside when it is not (its
# holder's heartbeat then fails, and whoever now holds the name is
# re-inspected by the loop).
take_stale() {
  judged_owner="${1:-}"
  judged_pid="${2:-}"
  judged_beat="${3:-}"
  # The pass suffix keeps a copy left aside by an earlier pass from blocking
  # this pass's rename (a directory rename onto a non-empty name fails).
  aside="$LOCK.reclaim.$$.${4:-x}"
  if ! mv "$LOCK" "$aside" 2>/dev/null; then
    return 1
  fi
  moved_owner=$(cat "$aside/owner" 2>/dev/null)
  moved_pid=$(cat "$aside/pid" 2>/dev/null)
  moved_beat=$(cat "$aside/beat" 2>/dev/null)
  if [ "$moved_owner" = "$judged_owner" ] &&
    [ "$moved_pid" = "$judged_pid" ] &&
    [ "$moved_beat" = "$judged_beat" ]; then
    rm -rf "$aside"
    return 0
  fi
  # Test hook (CF_GATE_TEST_PAUSE_BEFORE_RESTORE): between the move-aside and
  # the restore attempt, for the test that takes the name in that window.
  if [ -n "${CF_GATE_TEST_PAUSE_BEFORE_RESTORE:-}" ]; then
    touch "$CF_GATE_TEST_PAUSE_BEFORE_RESTORE" 2>/dev/null
    while [ -f "$CF_GATE_TEST_PAUSE_BEFORE_RESTORE" ]; do sleep 1; done
  fi
  if [ ! -d "$LOCK" ] && mv "$aside" "$LOCK" 2>/dev/null; then
    printf '%s\n' "gate-lock: reclaim aborted — the renamed lock is not the one that was judged stale; restored it at $LOCK" >&2
    return 1
  fi
  printf '%s\n' "gate-lock: reclaim aborted — the renamed lock is not the one that was judged stale; the name is taken, the moved copy is left at $aside and never deleted" >&2
  return 1
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
    # Creation is atomic, so a lock without pid or beat cannot be mid-write —
    # it is abandoned (or the filesystem is failing). Re-read instead of
    # judging on the first pass anyway, bounded: an abandoned one is reclaimed
    # at pass 3. The second wait covers a pid present but beat missing — a
    # live holder always has a beat, so that too reads as abandoned.
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
    # Test hook (CF_GATE_TEST_PAUSE_AFTER_INSPECT): a pause between judging
    # the lock stale and moving it, so a test can replace the lock in that
    # window and prove the reclaimer never deletes a lock it did not judge.
    if [ -n "${CF_GATE_TEST_PAUSE_AFTER_INSPECT:-}" ]; then
      touch "$CF_GATE_TEST_PAUSE_AFTER_INSPECT" 2>/dev/null
      while [ -f "$CF_GATE_TEST_PAUSE_AFTER_INSPECT" ]; do sleep 1; done
    fi
    take_stale "$owner" "${pid:-}" "${beat:-}" "$pass"
  done
}

# Release the lock — but only the caller's own. After a reclaim, a stale
# holder's cleanup must not delete the lock that replaced it: the removal
# happens only when the lock still names this owner AND this caller's pid.
# Anything else warns and fails, and leaves the lock alone.
release() {
  if [ ! -d "$LOCK" ]; then
    printf '%s\n' "gate-lock: nothing to release — no lock at $LOCK"
    return 0
  fi
  owner=$(cat "$LOCK/owner" 2>/dev/null)
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  if [ "$owner" != "$1" ] || [ "$pid" != "$recorded_pid" ]; then
    printf '%s\n' "gate-lock: release refused — the lock at $LOCK names ${owner:-unknown} (pid ${pid:-?}), not $1 (pid $recorded_pid); it was left alone" >&2
    return 1
  fi
  rm -rf "$LOCK"
  printf '%s\n' "gate-lock: released by $1 (pid $recorded_pid)"
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

# Refresh the beat — only on the caller's own lock. A holder whose lock was
# reclaimed must not keep refreshing the lock that replaced it: the beat is
# written only when the lock still names this pid, and the refusal is what
# tells the holder's loop (and the gate, at its next step boundary) that the
# lock is lost.
heartbeat() {
  if [ ! -d "$LOCK" ]; then
    printf '%s\n' "gate-lock: heartbeat — no lock at $LOCK; nothing to refresh" >&2
    return 1
  fi
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  if [ "$pid" != "$recorded_pid" ]; then
    printf '%s\n' "gate-lock: heartbeat refused — the lock at $LOCK names pid ${pid:-?}, not this holder (pid $recorded_pid); the beat was not touched" >&2
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