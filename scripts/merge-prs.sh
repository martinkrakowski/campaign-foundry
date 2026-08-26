#!/usr/bin/env zsh
#
# merge-prs.sh — sequentially refresh, verify and squash-merge a set of PRs.
#
# Usage:
#   scripts/merge-prs.sh "<pr>|<worktree-or-empty>|<branch>" ...
#
# Example:
#   scripts/merge-prs.sh "41|../cf-wt-seeded-random|feat/seeded-random" "42||fix/typo"
#
# For each PR, in order:
#   1. Fetch origin/main and merge it into the PR branch (in its worktree, when given).
#      Conflicts are auto-resolved ONLY in append-only files (see APPEND_ONLY below) by
#      keeping both sides; any other conflict aborts the merge and exits 1 so a human
#      (or the orchestrator) resolves it deliberately.
#   2. Push the refreshed branch.
#   3. Wait for CI on the new head (`gh pr checks --watch --fail-fast`).
#   4. Squash-merge.
# Then remove the worktrees and delete the merged branches, and fast-forward main.
#
# Why sequential: each merge changes main, so every later PR must be re-verified
# against it. Why not `gh pr merge --auto`: repos without auto-merge enabled reject it.
# Why no `--delete-branch` on merge: git refuses to delete a branch that a worktree
# holds; branches are deleted after the worktrees are removed.
set -u -o pipefail

REPO=$(git rev-parse --show-toplevel) || exit 1
MAIN=${MAIN_BRANCH:-main}

# Files where two branches legitimately append and both sides must survive.
# Extend for your repo (a session log, a hand-maintained barrel, a changelog).
APPEND_ONLY=${APPEND_ONLY:-'^(\.agents/session-log\.md|CHANGELOG\.md|packages/[^/]+/src/application/ports/out/index\.ts)$'}

KEEP_BOTH='
import re, sys
path = sys.argv[1]
text = open(path).read()
text = re.sub(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n",
              lambda m: m.group(1) + m.group(2), text, flags=re.S)
open(path, "w").write(text)
'

typeset -a WORKTREES BRANCHES
for spec in "$@"; do
  pr=${spec%%|*}; rest=${spec#*|}; worktree=${rest%%|*}; branch=${rest#*|}
  WORKTREES+=("$worktree"); BRANCHES+=("$branch")
  echo "=== PR #$pr ($branch)"

  cd "$REPO" && git fetch -q origin "$MAIN"

  if [[ -n "$worktree" && -d "$worktree" ]]; then
    cd "$worktree"
    if ! git merge -q --no-edit "origin/$MAIN" 2>&1; then
      conflicts=$(git diff --name-only --diff-filter=U)
      if [[ -n "$conflicts" ]] && ! echo "$conflicts" | grep -qvE "$APPEND_ONLY"; then
        for file in ${(f)conflicts}; do
          python3 -c "$KEEP_BOTH" "$file" && git add "$file"
        done
        git commit -q --no-edit && echo "resolved append-only conflicts: ${conflicts//$'\n'/ }"
      else
        echo "UNEXPECTED CONFLICT in: ${conflicts//$'\n'/ }"
        git merge --abort
        exit 1
      fi
    fi
    git push -q origin "$branch" || exit 1
    cd "$REPO"
  fi

  sleep 15  # let the forge register checks for the new head before watching
  gh pr checks "$pr" --watch --fail-fast 2>&1 | tail -2 \
    || { echo "CHECKS FAILED for #$pr"; gh pr checks "$pr"; exit 1; }
  gh pr merge "$pr" --squash || exit 1
  echo "merged #$pr"
done

cd "$REPO"
for worktree in $WORKTREES; do
  [[ -n "$worktree" && -d "$worktree" ]] && git worktree remove --force "$worktree" \
    && echo "removed $worktree"
done
git worktree prune
for branch in $BRANCHES; do
  git branch -D "$branch" 2>/dev/null
  git push -q origin --delete "$branch" 2>/dev/null && echo "deleted origin/$branch"
done
git checkout -q "$MAIN" && git pull -q --ff-only origin "$MAIN" && git log --oneline -8
echo "ALL DONE"
