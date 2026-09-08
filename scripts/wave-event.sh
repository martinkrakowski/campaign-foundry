#!/usr/bin/env zsh
# Append one wave-status event to <logdir>/events.jsonl (plan D103, §2.1).
#
#   wave-event.sh <logdir> <wave> <lane> <stage> <event> [--pr N] [--round N] [--detail '<json>']
#
# Output is byte-identical to formatEvent in tools/wave-status/lib/emit.ts for
# the same input, so the two writers cannot drift apart. Two consequences for
# callers, both checked before any write: --detail must be a compact JSON object
# (no spaces), and <wave>/<lane> must match ^[A-Za-z0-9_-]+$.
#
# Validate first, append last: an unknown stage or event, a non-token wave/lane,
# or a --detail that is not a JSON object exits 2 with the reason on stderr and
# nothing is written — a rejected event must never reach the log, not even as
# garbage a reader would have to reject later.
set -u

[ $# -ge 5 ] || {
  print -u2 "usage: $0 <logdir> <wave> <lane> <stage> <event> [--pr N] [--round N] [--detail '<json>']"
  exit 2
}
LOGDIR="$1"; WAVE="$2"; LANE="$3"; STAGE="$4"; EVENT="$5"; shift 5

stages="dispatch implement gate review remediate sweep merge record"
kinds="started settled failed"
(( ${stages[(Ie)$STAGE]} )) || {
  print -u2 "unknown stage: $STAGE — stage is one of: $stages; event is one of: $kinds"
  exit 2
}
(( ${kinds[(Ie)$EVENT]} )) || {
  print -u2 "unknown event: $EVENT — stage is one of: $stages; event is one of: $kinds"
  exit 2
}

pr="" round="" detail=""
while (( $# )); do
  case "$1" in
    --pr)     (( $# >= 2 )) || { print -u2 "missing value for $1"; exit 2; }; pr="$2";     shift 2 ;;
    --round)  (( $# >= 2 )) || { print -u2 "missing value for $1"; exit 2; }; round="$2";  shift 2 ;;
    --detail) (( $# >= 2 )) || { print -u2 "missing value for $1"; exit 2; }; detail="$2"; shift 2 ;;
    *) print -u2 "unknown option: $1"; exit 2 ;;
  esac
done

[[ -z "$pr" || "$pr" =~ ^[0-9]+$ ]] || { print -u2 -- "--pr must be a number: $pr"; exit 2; }
[[ -z "$round" || "$round" =~ ^[0-9]+$ ]] || { print -u2 -- "--round must be a number: $round"; exit 2; }

token_re='^[A-Za-z0-9_-]+$'
[[ "$WAVE" =~ $token_re ]] || { print -u2 "invalid wave: $WAVE — must match $token_re"; exit 2; }
[[ "$LANE" =~ $token_re ]] || { print -u2 "invalid lane: $LANE — must match $token_re"; exit 2; }
if [[ -n "$detail" ]]; then
  if ! python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if isinstance(d, dict) else 1)' "$detail" 2>/dev/null; then
    print -u2 -- "--detail must be a JSON object: $detail"
    exit 2
  fi
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
line="{\"ts\":\"$ts\",\"wave\":\"$WAVE\",\"lane\":\"$LANE\",\"stage\":\"$STAGE\",\"event\":\"$EVENT\""
[[ -z "$pr" ]] || line+=",\"pr\":$pr"
[[ -z "$round" ]] || line+=",\"round\":$round"
[[ -z "$detail" ]] || line+=",\"detail\":$detail"
line+="}"

mkdir -p "$LOGDIR"
print -r -- "$line" >> "$LOGDIR/events.jsonl"
