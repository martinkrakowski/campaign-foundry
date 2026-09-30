#!/bin/sh
# lane-usage.sh — a lane's wall time and tokens, read from opencode's own database.
#
#   sh scripts/lane-usage.sh [--host <ssh-host>] [--json] <worktree-dir>…
#   (--json takes exactly one directory, so its output is one JSON document)
#
# One row per worktree directory: every opencode session whose directory is
# exactly that path (a lane's worktree names its sessions). Columns:
#   directory sessions agents models secs tokens_in tokens_out tokens_reasoning
#   cache_read cache_write cost
# `secs` runs from the first session's creation to the last session's latest
# update. opencode writes those times when a tool call RETURNS, so for a live
# lane inside a long call (a gate, a test run) `secs` stops at the last step
# that finished, not at now. `cost` is what opencode recorded;
# a free seat records 0, so compare seats on tokens and time, not cost.
#
# --host runs the query over ssh on the host whose `opencode serve` ran the
# lane (tools execute on the server, so its database holds the session).
# LANE_USAGE_REMOTE_PATH is prepended to PATH there (default
# $HOME/.opencode/bin, which a non-interactive ssh shell does not have).
#
# READ-ONLY. The database is opencode's internal, migration-managed schema:
# it can change with any opencode upgrade, so a failed query is reported as
# "unknown" (exit 3) rather than guessed around. It also stores full prompts,
# code and tool output; never serve it, or this script's input, beyond the
# host that owns it.
#
# Exit: 0 rows printed · 1 no session for a directory · 2 usage · 3 query failed.

set -u
# Byte-exact character ranges in the checks below, whatever the caller's locale.
LC_ALL=C
export LC_ALL

usage() {
  echo "usage: sh scripts/lane-usage.sh [--host <ssh-host>] [--json] <worktree-dir>…" >&2
  exit 2
}

host=""
format="tsv"
while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      # An empty host would silently query the LOCAL database instead.
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      host="$2"
      shift 2
      ;;
    --json)
      format="json"
      shift
      ;;
    --)
      shift
      break
      ;;
    -*) usage ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || usage
# One JSON document per directory would not parse as one; ask one at a time.
if [ "$format" = "json" ] && [ $# -gt 1 ]; then
  echo "lane-usage: --json takes one directory (several would print several JSON arrays)" >&2
  exit 2
fi

# The directory is interpolated into SQL and the host into an ssh argv, so
# both are held to a character set with no quote, space or shell meaning.
if [ -n "$host" ]; then
  case "$host" in
    -* | *[!A-Za-z0-9._-]*)
      printf '%s\n' "lane-usage: refusing host '$host' (allowed: A-Z a-z 0-9 . _ -)" >&2
      exit 2
      ;;
  esac
  # Expanded by the REMOTE shell. `$` is allowed so `$HOME` works; with no
  # `(`, backtick, brace, quote or space, it can expand a variable, never run
  # a command.
  case "${LANE_USAGE_REMOTE_PATH:-}" in
    *[!A-Za-z0-9._/:\$-]*)
      echo "lane-usage: refusing LANE_USAGE_REMOTE_PATH (allowed: A-Z a-z 0-9 . _ - / : \$)" >&2
      exit 2
      ;;
  esac
fi
for dir in "$@"; do
  case "$dir" in
    /*) ;;
    *)
      printf '%s\n' "lane-usage: refusing '$dir': the directory must be absolute" >&2
      exit 2
      ;;
  esac
  case "$dir" in
    *[!A-Za-z0-9._/-]*)
      printf '%s\n' "lane-usage: refusing '$dir' (allowed: A-Z a-z 0-9 . _ - /)" >&2
      exit 2
      ;;
  esac
done

status=0
header_done=0
for dir in "$@"; do
  # A trailing slash would never match opencode's stored directory.
  while [ "$dir" != "/" ] && [ "${dir%/}" != "$dir" ]; do dir="${dir%/}"; done
  sql="SELECT directory, count(*) AS sessions,
 group_concat(DISTINCT agent) AS agents,
 group_concat(DISTINCT json_extract(model, '\$.id')) AS models,
 (max(time_updated) - min(time_created)) / 1000 AS secs,
 sum(tokens_input) AS tokens_in, sum(tokens_output) AS tokens_out,
 sum(tokens_reasoning) AS tokens_reasoning,
 sum(tokens_cache_read) AS cache_read, sum(tokens_cache_write) AS cache_write,
 round(sum(cost), 4) AS cost
 FROM session WHERE directory = '$dir' GROUP BY directory"
  if [ -n "$host" ]; then
    remote_path="${LANE_USAGE_REMOTE_PATH:-\$HOME/.opencode/bin}"
    # -n: never read the caller's stdin; BatchMode: fail rather than prompt.
    out=$(ssh -n -o BatchMode=yes "$host" "PATH=$remote_path:\$PATH opencode db \"$sql\" --format $format")
  else
    out=$(opencode db "$sql" --format "$format")
  fi
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "lane-usage: unknown — ${host:+ssh/}opencode db exited $rc for '$dir' (schema changed, or opencode missing?)" >&2
    exit 3
  fi
  if [ -z "$out" ] || [ "$out" = "[]" ]; then
    echo "lane-usage: no opencode session for '$dir'${host:+ on $host}" >&2
    status=1
    continue
  fi
  # One TSV header for the whole report, however many directories.
  if [ "$format" = "tsv" ] && [ "$header_done" -eq 1 ]; then
    out=$(printf '%s\n' "$out" | sed 1d)
  fi
  header_done=1
  printf '%s\n' "$out"
done
exit "$status"
