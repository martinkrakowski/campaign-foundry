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
# opencode v2 (2.x) has no `db` subcommand. When `opencode --version`
# reports a major version of 2 or more, the same query runs through python3's
# sqlite3 module instead — against session_v2, opened READ-ONLY — locally,
# and inside the same single ssh call a --host query already made. There is
# no sqlite3 binary on the hosts; python3 is there.
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

# opencode v2 (2.x) shipped no `db` subcommand, so on a v2 install every
# `opencode db` call fails. The database itself is unchanged; the major
# version of `opencode --version` decides which path runs. A failed or
# unparseable version call keeps today's v1 path, exactly as before.
# For --host this check is NOT run locally: the remote command below runs
# it itself, because the host's opencode may be a different install.
v2=0
if [ -z "$host" ]; then
  ver=$(opencode --version 2>/dev/null) || ver=
  case "$ver" in
    "opencode "*) ver="${ver#opencode }" ;;
  esac
  case "$ver" in
    v*) ver="${ver#v}" ;;
  esac
  major="${ver%%.*}"
  case "$major" in
    '' | *[!0-9]*) ;;
    *) [ "$major" -ge 2 ] && v2=1 ;;
  esac
fi

# The v2 report: the same query and the same two formats `opencode db`
# printed, from the same SQLite database under
# ${XDG_DATA_HOME:-$HOME/.local/share}. The directory is already held to
# A-Za-z0-9._/- above and arrives as an argv item — never spliced into the
# program text or the SQL. session_v2 is v2's table; `session` is the
# fallback for a v2 database that still carries the v1 name. The schema is
# opencode's own, migration-managed, and the file also stores full prompts,
# code and tool output, so it is opened READ-ONLY (mode=ro) and never
# written, and never served beyond the host that owns it.
PY=$(cat <<'LANE_USAGE_PY'
import json
import os
import sqlite3
import sys

worktree, out_format = sys.argv[1], sys.argv[2]
data_home = os.environ.get("XDG_DATA_HOME") or os.path.join(
    os.path.expanduser("~"), ".local", "share"
)
db_path = os.path.join(data_home, "opencode", "opencode.db")

sql = """SELECT directory, count(*) AS sessions,
 group_concat(DISTINCT agent) AS agents,
 group_concat(DISTINCT json_extract(model, '$.id')) AS models,
 (max(time_updated) - min(time_created)) / 1000 AS secs,
 sum(tokens_input) AS tokens_in, sum(tokens_output) AS tokens_out,
 sum(tokens_reasoning) AS tokens_reasoning,
 sum(tokens_cache_read) AS cache_read, sum(tokens_cache_write) AS cache_write,
 round(sum(cost), 4) AS cost
 FROM {table} WHERE directory = ? GROUP BY directory"""

columns = [
    "directory", "sessions", "agents", "models", "secs",
    "tokens_in", "tokens_out", "tokens_reasoning",
    "cache_read", "cache_write", "cost",
]


def fail(message):
    # Any non-zero exit becomes the shell's "unknown" (exit 3) report —
    # the contract a failed `opencode db` had.
    sys.stderr.write("lane-usage: unknown — %s\n" % message)
    sys.exit(1)


def normalize(value):
    # Whole numbers (secs, token sums, a free seat's rounded cost of 0) go
    # out as integers, matching what opencode db printed.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


try:
    con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
except sqlite3.Error:
    fail("cannot open %s (opencode missing?)" % db_path)

table = None
for candidate in ("session_v2", "session"):
    row = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (candidate,),
    ).fetchone()
    if row is not None:
        table = candidate
        break
if table is None:
    fail("no session_v2 or session table in %s (schema changed?)" % db_path)

try:
    rows = con.execute(sql.format(table=table), (worktree,)).fetchall()
except sqlite3.Error:
    fail("query failed on %s (schema changed?)" % db_path)

# No rows: print nothing (or [] for --json) and exit 0, so the shell's own
# "no opencode session" branch reports it — exit 1, as `opencode db` did.
if not rows:
    if out_format == "json":
        sys.stdout.write("[]\n")
    sys.exit(0)
records = [dict((column, normalize(v)) for column, v in zip(columns, row)) for row in rows]
if out_format == "json":
    # Compact, like `opencode db --format json` printed it.
    sys.stdout.write(json.dumps(records, separators=(",", ":")) + "\n")
else:
    sys.stdout.write("\t".join(columns) + "\n")
    for record in records:
        sys.stdout.write("\t".join(str(record[column]) for column in columns) + "\n")
LANE_USAGE_PY
)

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
    # The version check runs in the REMOTE shell: the host's opencode may be
    # a different install than the local one, so the remote picks the path.
    # v1 keeps today's `opencode db` invocation, verbatim, in the else.
    remote_cmd="ver=\$(PATH=$remote_path:\$PATH opencode --version 2>/dev/null) || ver=
case \"\$ver\" in \"opencode \"*) ver=\${ver#opencode };; esac
case \"\$ver\" in v*) ver=\${ver#v};; esac
major=\${ver%%.*}
case \"\$major\" in ''|*[!0-9]*) major=0;; esac
if [ \"\$major\" -ge 2 ]; then
PATH=$remote_path:\$PATH python3 - \"$dir\" \"$format\" <<'LANE_USAGE_PY'
$PY
LANE_USAGE_PY
else
PATH=$remote_path:\$PATH opencode db \"$sql\" --format $format
fi"
    out=$(ssh -n -o BatchMode=yes "$host" "$remote_cmd")
  elif [ "$v2" -eq 1 ]; then
    # v2 has no `db` subcommand: the same report from the same database,
    # read-only, via python3's sqlite3 (no sqlite3 binary on the hosts).
    out=$(printf '%s\n' "$PY" | python3 - "$dir" "$format")
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
