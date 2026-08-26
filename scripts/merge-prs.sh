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
#   1. Refresh the branch from origin/<main>. Conflicts are auto-resolved ONLY for
#      ordinary text conflicts in append-only files (see APPEND_ONLY) by keeping both
#      sides; anything else — a different path, a modify/delete, a binary conflict, a
#      failed resolution — aborts the merge and exits non-zero.
#   2. Push the refreshed branch.
#   3. Wait for CI on the new head (`gh pr checks --watch --fail-fast`).
#   4. Squash-merge.
# Then remove the worktrees and delete the merged branches, and fast-forward main.
#
# When the worktree field is empty a temporary worktree is created for the refresh and
# removed afterwards, so EVERY pr is refreshed and re-verified — never merged stale.
#
# Why sequential: each merge changes main, so every later PR must be re-verified against
# it. Why not `gh pr merge --auto`: repos without auto-merge enabled reject it. Why no
# `--delete-branch` on merge: git refuses to delete a branch that a worktree holds, so
# branches are deleted after the worktrees are removed.
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
merged = re.sub(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n",
                lambda m: m.group(1) + m.group(2), text, flags=re.S)
if merged == text or "<<<<<<<" in merged:
    sys.exit("keep-both resolver made no progress on " + path)
open(path, "w").write(merged)
'

die() { echo "ERROR: $*" >&2; exit 1 }

# Auto-resolve the current merge, or fail. Only ordinary text conflicts (index stages
# 1+2+3, regular file, conflict markers present) in APPEND_ONLY paths are eligible.
resolve_append_only_or_die() {
  # NB: never name a local `path` in zsh — it is tied to $PATH and shadowing it
  # empties PATH inside the function (every git/awk/sort call then fails).
  local conflicts file stages
  # `git ls-files -u` is the canonical unmerged listing; `git diff --diff-filter=U`
  # carries diff exit-code semantics that vary with config.
  conflicts=$(git ls-files -u | awk '{print $4}' | sort -u)
  [[ -n "$conflicts" ]] || die "merge failed with no conflicted paths (check the working tree)"

  for file in ${(f)conflicts}; do
    echo "$file" | grep -qE "$APPEND_ONLY" \
      || { git merge --abort; die "UNEXPECTED CONFLICT in: ${conflicts//$'\n'/ }" }
    # 1=base 2=ours 3=theirs. Anything else is modify/delete or add/add of a special file.
    stages=$(git ls-files -u -- "$file" | awk '{print $3}' | sort -u | tr '\n' ',')
    [[ "$stages" == "1,2,3," ]] \
      || { git merge --abort; die "non-content conflict (stages $stages) in $file — resolve by hand" }
    git ls-files -u -- "$file" | awk '{print $1}' | grep -qv '^100644$' \
      && { git merge --abort; die "non-regular-file conflict in $file — resolve by hand" }
    grep -q '^<<<<<<< ' "$file" \
      || { git merge --abort; die "no conflict markers in $file (binary or already resolved) — resolve by hand" }
  done

  for file in ${(f)conflicts}; do
    python3 -c "$KEEP_BOTH" "$file" || { git merge --abort; die "keep-both failed on $file" }
    git add -- "$file" || { git merge --abort; die "git add failed for $file" }
  done

  [[ -z "$(git ls-files -u)" ]] \
    || { git merge --abort; die "unmerged entries remain after resolution" }
  git commit -q --no-edit || die "merge commit failed after resolution"
  echo "resolved append-only conflicts: ${conflicts//$'\n'/ }"
}

# Merge origin/$MAIN into the checked-out branch here, resolving only append-only files.
refresh_here() {
  git merge -q --no-edit "origin/$MAIN" || resolve_append_only_or_die
}

typeset -a WORKTREES BRANCHES
for spec in "$@"; do
  pr=${spec%%|*}; rest=${spec#*|}; worktree=${rest%%|*}; branch=${rest#*|}
  WORKTREES+=("$worktree"); BRANCHES+=("$branch")
  echo "=== PR #$pr ($branch)"

  cd "$REPO" || die "cannot cd to $REPO"
  git fetch -q origin "$MAIN" || die "git fetch origin $MAIN failed — refusing to merge against a stale ref"

  if [[ -n "$worktree" && -d "$worktree" ]]; then
    cd "$worktree" || die "cannot cd to $worktree"
    refresh_here
    git push -q origin "$branch" || die "push failed for $branch"
    cd "$REPO" || die "cannot cd back to $REPO"
  else
    # No worktree supplied: refresh in a throwaway one so this PR is not merged stale.
    # Detached at origin/<branch>, then push HEAD to the branch ref: `git worktree add`
    # refuses a branch that is already checked out somewhere else, which is the common
    # case (the main checkout, or another lane's worktree).
    git fetch -q origin "$branch" || die "cannot fetch $branch"
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/merge-prs-XXXXXX") || die "mktemp failed"
    git worktree add -q --detach "$tmp" "origin/$branch" \
      || { rm -rf "$tmp"; die "cannot create temp worktree for $branch" }
    ( cd "$tmp" && refresh_here && git push -q origin "HEAD:refs/heads/$branch" ) \
      || { git worktree remove --force "$tmp"; die "refresh/push failed for $branch" }
    git worktree remove --force "$tmp" || die "cannot remove temp worktree $tmp"
  fi

  sleep 15  # let the forge register checks for the new head before watching
  gh pr checks "$pr" --watch --fail-fast 2>&1 | tail -2 \
    || { echo "CHECKS FAILED for #$pr"; gh pr checks "$pr"; exit 1 }
  gh pr merge "$pr" --squash || die "squash-merge failed for #$pr"
  echo "merged #$pr"
done

cd "$REPO" || die "cannot cd to $REPO"
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
