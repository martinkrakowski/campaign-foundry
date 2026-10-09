#!/bin/sh
# Scan a captured test:cov step log for vitest summary lines that report a
# failure while the step itself exited 0 — a pipe can hide the failure code the
# same way coverage can. Moved out of scripts/gate.sh (lane FU-ci-output-scan)
# so the scan lives in exactly one POSIX script the gate calls.
#
# Usage: sh scripts/test-output-scan.sh <log file>
#
# Exit 96 with ONE line on stdout (`<kind>: <matched line>`) when the log holds
# a failed-tests summary (`Test Files <n> failed` or `Tests <n> failed`, n>0)
# or vitest's unhandled-error sentence (`Vitest caught <n> unhandled error`) —
# failed tests wins when both are present. Exit 0 (printing nothing) on a clean
# log. Exit 2 with a usage line on stderr for a missing argument or an
# unreadable file, never 0 and never 96.
#
# POSIX sh, and tested under dash — the runners' /bin/sh.

log=${1:-}
if [ -z "$log" ] || [ ! -r "$log" ]; then
  printf 'usage: sh scripts/test-output-scan.sh <log file>\n' >&2
  exit 2
fi

ESC=$(printf '\033')
CLEANED=$(sed "s/${ESC}\[[0-9;]*m//g" "$log")

line=$(printf '%s\n' "$CLEANED" \
  | grep -E '^[[:space:]]*(Test Files|Tests)[[:space:]]+[1-9][0-9]* failed' \
  | head -n1)
if [ -n "$line" ]; then
  printf 'failed tests: %s\n' "$line"
  exit 96
fi

line=$(printf '%s\n' "$CLEANED" \
  | grep -E '^[[:space:]]*Vitest caught [0-9][0-9]* unhandled error' \
  | head -n1)
if [ -n "$line" ]; then
  printf 'unhandled errors: %s\n' "$line"
  exit 96
fi

exit 0
