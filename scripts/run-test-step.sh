#!/bin/sh
# Run a test command, stream its merged output live, then scan the captured log
# for vitest failure summaries the exit status alone would miss. Wrapper for the
# CI test steps so a command that exits 0 but reports failures still fails the job.
#
# Usage: sh scripts/run-test-step.sh <command> [args...]
#
# The command's stdout+stderr stream to this script's stdout as produced and are
# tee'd to a temp log; the command's own exit status wins (no pipefail — POSIX sh
# has neither). The scan only runs when the command exited 0 and may fail the step
# with code 96; a scan that cannot run fails the step with code 2, never 0/96.
#
# POSIX sh, and tested under dash — the runners' /bin/sh.

if [ "$#" -lt 1 ]; then
  printf 'usage: sh scripts/run-test-step.sh <command> [args...]\n' >&2
  exit 2
fi

here=${0%/*}
case "$here" in
  ''|"$0") here= ;;
esac
scan=${here:+$here/}test-output-scan.sh

status_file=$(mktemp "${TMPDIR:-/tmp}/rt-step.XXXXXX") || exit 2
log=$(mktemp "${TMPDIR:-/tmp}/rt-step-log.XXXXXX") || { rm -f "$status_file"; exit 2; }
# A signal ends the step with the conventional code (the EXIT trap still cleans
# up); a trap that only removed the files would let a cancelled step run on.
trap 'rm -f "$status_file" "$log"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

( "$@" 2>&1; echo $? >"$status_file" ) | tee "$log"

status=$(cat "$status_file" 2>/dev/null)
if [ -z "$status" ]; then
  printf 'run-test-step: FAILED — the command did not write an exit status\n' >&2
  exit 2
fi

if [ "$status" -ne 0 ]; then
  exit "$status"
fi

if [ ! -r "$scan" ]; then
  printf 'run-test-step: FAILED — the test output scan could not run (exit 127)\n' >&2
  exit 2
fi

scan_out=$(sh "$scan" "$log")
scan_status=$?

case "$scan_status" in
  0) exit 0 ;;
  96)
    kind=${scan_out%%: *}
    matched=${scan_out#*: }
    msg="run-test-step: FAILED — the command exited 0 but its output reports $kind ($matched)"
    printf '%s\n' "$msg" >&2
    if [ "$GITHUB_ACTIONS" = "true" ]; then
      printf '::error::%s\n' "$msg"
    fi
    exit 96
    ;;
  *)
    printf 'run-test-step: FAILED — the test output scan could not run (exit %s)\n' "$scan_status" >&2
    exit 2
    ;;
esac
