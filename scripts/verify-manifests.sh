#!/bin/sh
# Replay every mutation manifest this change touches.
#
# A manifest records the mutations a lane claims its tests catch. Replaying it
# is what makes the claim evidence rather than a report: two seats stated
# verdicts they had never observed, one quoting failure messages from a suite
# whose own log showed it had not started.
#
# Only CHANGED manifests are replayed. Each mutation runs a real test command,
# so replaying all of them every time grows without bound as manifests
# accumulate. A claim is checked when it is made.
#
# EVERY failure here is loud. A gate that cannot work out what changed must say
# so and stop, never quietly report nothing to do: silence is indistinguishable
# from success, and that is how a gate stops being one.
#
# POSIX sh, and tested under dash — the runners' /bin/sh. In particular there is
# no `read -d`, which dash rejects outright ("Illegal option -d"). An earlier
# draft used it, and under dash the loop body never ran: the script replayed
# nothing and exited 0. That is the precise failure this file is written to
# avoid, so it is worth naming here.
set -eu

MANIFEST_DIR=".agents/manifests"

if [ ! -d "$MANIFEST_DIR" ]; then
  echo "verify-manifests: no $MANIFEST_DIR directory; nothing to replay"
  exit 0
fi

# The base to diff against, in order of how well it describes "what this change
# touched":
#   pull_request — the target branch.
#   push         — the commit that was there before. On a push to main,
#                  origin/main IS the pushed commit, so diffing against it is
#                  empty and every manifest would be skipped in silence.
#   otherwise    — the default branch, for a local run.
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  BASE="origin/${GITHUB_BASE_REF}"
elif [ -n "${MANIFEST_DIFF_BASE:-}" ] &&
     [ "${MANIFEST_DIFF_BASE}" != "0000000000000000000000000000000000000000" ]; then
  BASE="${MANIFEST_DIFF_BASE}"
else
  BASE="origin/main"
fi

# A base can be named and still be gone: `github.event.before` on a force-pushed
# branch points at a commit that no longer exists. That is a *stale* base, not a
# broken checkout, and falling back to the default branch still answers "what
# did this change touch" — so degrade, loudly, rather than failing the build for
# a rewritten history. Anything else that breaks `git diff` is still an error:
# reporting "no changes" because the diff failed is the fail-open case this
# script exists to avoid.
if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1; then
  echo "verify-manifests: base '$BASE' is unreachable (a force push rewrote it?); falling back to origin/main"
  BASE="origin/main"
  if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1; then
    echo "verify-manifests: origin/main is unreachable too — refusing to call that no changes" >&2
    exit 2
  fi
fi

CHANGED_LIST=$(mktemp)
trap 'rm -f "$CHANGED_LIST"' EXIT
if ! git diff --name-only --diff-filter=d "$BASE"...HEAD -- "$MANIFEST_DIR" > "$CHANGED_LIST" 2>/dev/null; then
  echo "verify-manifests: cannot diff against '$BASE' — refusing to call that no changes" >&2
  exit 2
fi

# One name per line, read with `IFS= read -r`: a name containing a space or a
# glob character must not be word-split or expanded. A name containing a newline
# is the one case this cannot carry; git quotes those, so they arrive visibly
# wrong rather than silently skipped.
STATUS=0
REPLAYED=0
while IFS= read -r manifest; do
  [ -n "$manifest" ] || continue
  [ -f "$manifest" ] || continue
  REPLAYED=$((REPLAYED + 1))
  echo "verify-manifests: replaying $manifest"
  if ! yarn mutate:verify "$manifest"; then
    echo "verify-manifests: $manifest did not reproduce" >&2
    STATUS=1
  fi
done < "$CHANGED_LIST"

[ "$REPLAYED" -eq 0 ] && echo "verify-manifests: no manifest changed against $BASE; nothing to replay"
exit "$STATUS"
