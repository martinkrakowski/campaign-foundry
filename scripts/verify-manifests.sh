#!/bin/sh
# Replay every mutation manifest this change touches.
#
# A manifest records the mutations a lane claims its tests catch. Replaying it
# is what makes the claim evidence rather than a report: two seats this week
# stated verdicts they had never observed, one quoting failure messages from a
# suite whose own log showed it had not started.
#
# Only CHANGED manifests are replayed, deliberately. Each mutation runs a real
# test command, so replaying every manifest on every push would grow without
# bound as manifests accumulate and turn a two-minute build into one nobody
# waits for. A claim is checked when it is made, which is when it can still be
# wrong for the first time.
#
# POSIX sh: the runners have no zsh.
set -eu

MANIFEST_DIR=".agents/manifests"

# The base to diff against. On a pull request GitHub names the target branch;
# on a push it does not, so fall back to the default branch, and to replaying
# everything when even that is unavailable (a shallow clone with no main).
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  BASE="origin/${GITHUB_BASE_REF}"
elif git rev-parse --verify --quiet origin/main >/dev/null; then
  BASE="origin/main"
else
  BASE=""
fi

if [ -n "$BASE" ]; then
  CHANGED=$(git diff --name-only --diff-filter=d "$BASE"...HEAD -- "$MANIFEST_DIR" || true)
else
  echo "verify-manifests: no base ref to diff against; replaying every manifest"
  CHANGED=$(ls "$MANIFEST_DIR"/*.json 2>/dev/null || true)
fi

if [ -z "$CHANGED" ]; then
  echo "verify-manifests: no manifest changed in this diff; nothing to replay"
  exit 0
fi

STATUS=0
for manifest in $CHANGED; do
  [ -f "$manifest" ] || continue
  echo "verify-manifests: replaying $manifest"
  if ! yarn mutate:verify "$manifest"; then
    echo "verify-manifests: $manifest did not reproduce"
    STATUS=1
  fi
done
exit "$STATUS"
