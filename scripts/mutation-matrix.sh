#!/bin/sh
# stdin: changed manifests, one path per line. env MAX_LEGS (default 6).
# stdout: the matrix as one line of JSON; never an empty include list.
set -eu
MAX="${MAX_LEGS:-6}"
case "$MAX"
 in
  '' | *[!0-9]* | 0) echo "mutation-matrix: MAX_LEGS must be a positive integer, got '$MAX'" >&2; exit 2 ;;
esac
WORK=$(mktemp)
trap 'rm -f "$WORK"' EXIT
TAB=$(printf '\t')
N=0
while IFS= read -r m; do
  [ -n "$m" ] || continue
  w=$(jq -r '[.mutations[]? | select(.retired == null)] | length' "$m" 2>/dev/null) || w=1
  case "$w" in '' | *[!0-9]*) w=1 ;; esac
  [ "$w" -ge 1 ] || w=1
  printf '%s\t%s\n' "$w" "$m" >> "$WORK"
  N=$((N + 1))
done
if [ "$N" -eq 0 ]; then
  printf '%s\n' '{"include":[{"name":"none","manifests":""}]}'
  exit 0
fi
if [ "$N" -le "$MAX" ]; then SINGLE=true; else SINGLE=false; fi
# Longest-processing-time first: heaviest manifest to the least-loaded leg.
sort -t "$TAB" -k1,1nr -k2,2 "$WORK" |
  awk -F '\t' -v max="$MAX" '
    { n++; w[n] = $1; p[n] = $2 }
    END {
      legs = (n < max) ? n : max
      for (i = 1; i <= legs; i++) load[i] = 0
      for (k = 1; k <= n; k++) {
        best = 1
        for (i = 2; i <= legs; i++) if (load[i] < load[best]) best = i
        load[best] += w[k]
        printf "%d\t%s\n", best, p[k]
      }
    }' |
  jq -R -s -c --argjson single "$SINGLE" '
    split("\n") | map(select(. != "") | split("\t") | {leg: (.[0] | tonumber), path: .[1]})
    | group_by(.leg)
    | map({
        name: (if $single then (.[0].path | split("/") | last | sub("\\.json$"; "")) else "group-\(.[0].leg)" end),
        manifests: (map(.path) | sort | join("\n"))
      })
    | {include: .}'
