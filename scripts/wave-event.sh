#!/bin/sh
# Append one wave-status event to <logdir>/events.jsonl (plan D103, §2.1).
#
#   wave-event.sh [<logdir>] <wave> <lane> <stage> <event> [--pr N] [--round N] [--detail '<json>']
#   wave-event.sh --logdir <dir> <wave> <lane> <stage> <event> [--pr N] [--round N] [--detail '<json>']
#
# When <logdir> is omitted, it defaults to $LOGDIR, or /tmp/wave-<wave> (or /tmp/<wave>).
# May be called standalone around direct lane dispatches without dispatch-lane.sh.
#
# Output is byte-identical to formatEvent in tools/wave-status/lib/emit.ts for
# the same input, so the two writers cannot drift apart. Two consequences for
# callers, both checked before any write: --detail must be a compact JSON object
# (no spaces), and <wave>/<lane> must match ^[A-Za-z0-9_-]+$.
#
# POSIX sh (not zsh): GitHub Linux runners do not ship zsh. Validate first,
# append last: an unknown stage or event, a non-token wave/lane, or a --detail
# that is not a JSON object exits 2 with the reason on stderr and nothing is
# written — a rejected event must never reach the log, not even as garbage a
# reader would have to reject later.
set -u

stages="dispatch implement gate review remediate sweep merge record"
kinds="started settled failed"

is_stage() {
  case " $stages " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

is_event() {
  case " $kinds " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

LOGDIR="${LOGDIR:-}"
if [ $# -ge 1 ] && [ "$1" = "--logdir" ]; then
  [ $# -ge 2 ] || { printf '%s\n' "missing value for --logdir" >&2; exit 2; }
  LOGDIR="$2"
  shift 2
fi

if [ $# -ge 5 ] && is_stage "$4" && is_event "$5"; then
  LOGDIR="$1"; WAVE="$2"; LANE="$3"; STAGE="$4"; EVENT="$5"; shift 5
elif [ $# -ge 4 ] && is_stage "$3" && is_event "$4"; then
  WAVE="$1"; LANE="$2"; STAGE="$3"; EVENT="$4"; shift 4
elif [ -n "$LOGDIR" ] && [ $# -ge 4 ]; then
  WAVE="$1"; LANE="$2"; STAGE="$3"; EVENT="$4"; shift 4
elif [ $# -ge 5 ]; then
  LOGDIR="$1"; WAVE="$2"; LANE="$3"; STAGE="$4"; EVENT="$5"; shift 5
elif [ $# -ge 4 ]; then
  WAVE="$1"; LANE="$2"; STAGE="$3"; EVENT="$4"; shift 4
else
  printf '%s\n' "usage: $0 [<logdir>] <wave> <lane> <stage> <event> [--pr N] [--round N] [--detail '<json>']" >&2
  exit 2
fi

if [ -z "$LOGDIR" ]; then
  root="${WAVE_LOG_ROOT:-/tmp}"
  if [ -d "$root/wave-$WAVE" ]; then
    LOGDIR="$root/wave-$WAVE"
  elif [ -d "$root/wave$WAVE" ]; then
    LOGDIR="$root/wave$WAVE"
  elif case "$WAVE" in wave*) [ -d "$root/$WAVE" ] ;; *) false ;; esac; then
    LOGDIR="$root/$WAVE"
  else
    case "$WAVE" in
      wave*) LOGDIR="$root/$WAVE" ;;
      *)     LOGDIR="$root/wave-$WAVE" ;;
    esac
  fi
fi

stage_ok=0
for s in dispatch implement gate review remediate sweep merge record; do
  if [ "$s" = "$STAGE" ]; then
    stage_ok=1
    break
  fi
done
[ "$stage_ok" -eq 1 ] || {
  printf '%s\n' "unknown stage: $STAGE — stage is one of: $stages; event is one of: $kinds" >&2
  exit 2
}

event_ok=0
for k in started settled failed; do
  if [ "$k" = "$EVENT" ]; then
    event_ok=1
    break
  fi
done
[ "$event_ok" -eq 1 ] || {
  printf '%s\n' "unknown event: $EVENT — stage is one of: $stages; event is one of: $kinds" >&2
  exit 2
}

pr="" round="" detail=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pr)
      [ $# -ge 2 ] || { printf '%s\n' "missing value for $1" >&2; exit 2; }
      pr="$2"
      shift 2
      ;;
    --round)
      [ $# -ge 2 ] || { printf '%s\n' "missing value for $1" >&2; exit 2; }
      round="$2"
      shift 2
      ;;
    --detail)
      [ $# -ge 2 ] || { printf '%s\n' "missing value for $1" >&2; exit 2; }
      detail="$2"
      shift 2
      ;;
    *)
      printf '%s\n' "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [ -n "$pr" ]; then
  case "$pr" in
    *[!0-9]*)
      printf '%s\n' "--pr must be a number: $pr" >&2
      exit 2
      ;;
  esac
fi
if [ -n "$round" ]; then
  case "$round" in
    *[!0-9]*)
      printf '%s\n' "--round must be a number: $round" >&2
      exit 2
      ;;
  esac
fi

token_re='^[A-Za-z0-9_-]+$'
case "$WAVE" in
  ''|*[!A-Za-z0-9_-]*)
    printf '%s\n' "invalid wave: $WAVE — must match $token_re" >&2
    exit 2
    ;;
esac
case "$LANE" in
  ''|*[!A-Za-z0-9_-]*)
    printf '%s\n' "invalid lane: $LANE — must match $token_re" >&2
    exit 2
    ;;
esac
if [ -n "$detail" ]; then
  if ! python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if isinstance(d, dict) else 1)' "$detail" 2>/dev/null; then
    printf '%s\n' "--detail must be a JSON object: $detail" >&2
    exit 2
  fi
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
line="{\"ts\":\"$ts\",\"wave\":\"$WAVE\",\"lane\":\"$LANE\",\"stage\":\"$STAGE\",\"event\":\"$EVENT\""
[ -z "$pr" ] || line="${line},\"pr\":$pr"
[ -z "$round" ] || line="${line},\"round\":$round"
[ -z "$detail" ] || line="${line},\"detail\":$detail"
line="${line}}"

mkdir -p "$LOGDIR"
printf '%s\n' "$line" >> "$LOGDIR/events.jsonl"
