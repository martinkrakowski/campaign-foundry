#!/usr/bin/env zsh
#
# merge-prs.sh — sequentially refresh, verify and squash-merge a set of PRs.
#
# Usage:
#   scripts/merge-prs.sh [--logdir <dir>] [--continue] "<pr>|<worktree-or-empty>|<branch>|<lane-or-empty>|<wave-or-empty>" ...
#
# Example:
#   scripts/merge-prs.sh "41|../cf-wt-seeded-random|feat/seeded-random" "42||fix/typo"
#   scripts/merge-prs.sh "43|../cf-wt-hx1|feat/reserved-ids|HX1-route-segments-reserved|wave-hardening-w06"
#
# PASS EVERY PR TO ONE RUN. Do not chain runs — "wait for the previous one to
# finish, then start the next" — and above all do not chain them by matching
# process command lines: `pgrep -f` answers a matcher with the matcher's OWN
# command line, so those loops waited for each other for hours and merged
# nothing. The run lock below is what makes a single run the safe shape: a
# second run that starts while the first holds the lock exits 75 and says so,
# instead of merging beside it.
#
# --continue: a PR refused at ANY step — D184's gate, a conflict, failed or
# pending checks, an unresolved review thread, a head that moved — is reported
# and SKIPPED, and the PRs after it still run. A refused PR's worktree and
# branch are NOT removed, so the next run can pick it up and a refusal costs
# nothing but the one PR. The closing summary lists every PR as merged or
# refused with its reason, and the run exits 1 if any PR was refused. WITHOUT
# the flag this script stops at the first refusal, exactly as it always has.
#
# ONE RUN AT A TIME. At start the run takes ${TMPDIR:-/tmp}/cf-merge-prs.lock by
# renaming a fully written candidate directory onto that name — the rename is
# the only moment the name exists, so no run ever sees a lock with no pid in it.
# A live holder makes a second run exit 75 with `merge-prs: another run holds
# the lock (pid N)`; a dead holder's lock is reclaimed, and only after the lock
# that was moved aside is confirmed to be the one that was judged dead; and the
# lock is released on EXIT, INT and TERM. 75 means busy, exactly as it means
# busy in scripts/gate-lock.sh: sleep and retry, never remove the lock by hand.
#
# Two things about that lock worth knowing before concluding it is stuck. A pid
# can be RECYCLED: a lock whose holder died still names a pid, and if the kernel
# has since handed that number to something else the holder reads as alive
# forever. So before removing a lock by hand, look at what the pid is —
# `ps -p <pid> -o command=` — and remove it only if that is not a merge-prs run.
# And the lock's parent is ${TMPDIR:-/tmp}, which on macOS is private to one
# login session: two runs from different sessions do not see each other's lock
# at all, and the single-run rule is only as good as the session it is run in.
#
# For each PR, in order:
#   0. D184's pre-PR-review gate, ONLY when the spec names a lane: refuse this
#      PR before touching git or the forge at all — a refused lane costs no
#      fetch, no push and no CI run — unless `yarn plan:review
#      pre-pr-check <lane> --wave <wave> [--logdir <dir>]` exits 0. A refusal
#      here ends the WHOLE run, exactly as it always has, unless --continue was
#      given; then it costs that one PR. An empty
#      lane field is today's behaviour exactly: no lane, no gate, no wave
#      required. A lane given with an empty wave is a malformed spec, and it
#      refuses that PR — which without --continue is the end of the run, and
#      with it is one more skipped PR, since the gate cannot be asked anything
#      without a wave.
#   1. Refresh the branch from origin/<main>. Conflicts are auto-resolved ONLY for
#      ordinary text conflicts in append-only files (see APPEND_ONLY) by keeping both
#      sides; anything else — a different path, a modify/delete, a binary conflict, a
#      failed resolution — aborts the merge and exits non-zero.
#   2. Push the refreshed branch.
#   3. Wait for CI on the new head — poll until checks are REGISTERED, then watch
#      (`gh pr checks --watch --fail-fast`). A fixed sleep races the forge; see #206.
#   4. Wait a bounded settle period for review bots (a wait, not proof any bot ran),
#      then ask the merge condition of `yarn sweep gate`:
#      zero unresolved review threads on the final head, and a head unchanged since
#      its check-runs were read. Both are decided in TypeScript (tools/sweep).
#   5. Squash-merge.
# Then remove the worktrees and delete the merged branches, and fast-forward main —
# for the PRs that MERGED and no others. A PR this run refused is left exactly as
# it was found: its worktree and its branch are the only copy of that work, and
# the epilogue is the one place in this script that destroys things.
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

die() { echo "ERROR: $*" >&2; exit 1 }

# Leading flags, parsed in a loop so their order is not a rule a caller has to
# know: `--logdir X --continue` and `--continue --logdir X` are the same run.
# The first argument that is not a flag is a spec, and everything from there on
# belongs to the loop.
#
# --logdir names the wave log directory outright, for every spec in this run
# that carries a lane. Omitted, `pre-pr-check` resolves it itself — the same
# resolution wave-event.sh uses — so this script never invents a default of its
# own to drift from that one.
LOGDIR_OVERRIDE=""
# With --continue, a refused PR is one line in the closing summary instead of
# the end of the run. Empty means "stop at the first refusal", which is what
# every caller that does not ask for it gets.
CONTINUE=""
while [[ $# -ge 1 ]]; do
  case "$1" in
    --logdir)
      [[ $# -ge 2 ]] || die "--logdir requires a directory"
      LOGDIR_OVERRIDE="$2"
      shift 2
      ;;
    --continue)
      CONTINUE=1
      shift
      ;;
    *)
      break
      ;;
  esac
done

# ONE RUN AT A TIME. The lock is a directory at ${TMPDIR:-/tmp}/cf-merge-prs.lock
# holding one file, `pid`, and it is taken by a CANDIDATE DIRECTORY renamed onto
# that name — the metadata is written first and the rename is the only moment
# the name exists, so no other run can ever see a lock without a pid in it.
#
# A holder is alive if `ps -p <pid>` succeeds. NEVER `pgrep`: it matches process
# command lines, so it matches the very caller waiting on it — that is what
# deadlocked the orchestrator's chained runs for hours. `kill -0` is no better
# here, because it answers EPERM as a line of locale-dependent text to parse,
# and a process this user may not signal is alive.
LOCK_DIR="${TMPDIR:-/tmp}/cf-merge-prs.lock"
# 75 is BUSY, the same contract scripts/gate-lock.sh defines: this run is not
# wrong and the host is not broken, there is simply another run in the way.
BUSY=75

# The pid the lock at the name names, or empty when there is none to read.
# `cat` and not `$(<file)`: zsh's own "no such file" diagnostic for `$(<…)` is
# NOT covered by a redirection inside the substitution, so a lock with no pid in
# it printed that error to stderr on every run that looked at it.
lock_holder_pid() {
  cat "$LOCK_DIR/pid" 2>/dev/null
}

# Is that pid a live process?
pid_alive() {
  ps -p "$1" >/dev/null 2>&1
}

# A lock directory with no pid in it, and old enough that nobody is mid-write in
# it. The candidate-and-rename acquire makes this state impossible for a lock
# this script took, so this is the escape for the ones that exist anyway: a
# SIGKILL inside the old mkdir-then-write ordering, or a lock somebody removed
# the pid file from. Sixty seconds is not a tuned number — the window between one
# holder creating the name and writing its pid is sub-millisecond, and a
# pid-less lock a minute old can only be a crashed holder's.
#
# Judged by find's OUTPUT, never its exit status: find exits 0 whether or not it
# matched anything, so a test written on the exit code would call every fresh
# pid-less lock old and hand the host to whichever run asked first.
lock_is_pidless_and_old() {
  [[ -f "$LOCK_DIR/pid" ]] && return 1
  [[ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +1 2>/dev/null)" ]]
}

# Move the lock aside and delete it — but ONLY the lock that was judged dead.
#
# The `mv` is the arbitration between two reclaimers: only one rename lands, so
# two runs that both read the same dead pid cannot both decide the stale lock
# was theirs. The verification is what closes the race the rename alone does
# not: a run that replaced the name with a LIVE lock between our `ps` and our
# `mv` would otherwise have that lock renamed aside and deleted, and both runs
# would then merge at once — the exact failure this lock exists to prevent. So
# the aside's pid must be the one that was judged. Anything else is a lock this
# run never judged, and it is NEVER deleted: put it back when the name is free,
# leave it aside when it is not, and report the abort either way.
reclaim_lock() {
  local judged="$1" aside moved
  aside="$LOCK_DIR.stale.$$"
  # This aside is named for our own pid, so anything already at that name is a
  # dead earlier attempt of this same pid. Clearing it first matters: `mv` into
  # an EXISTING directory succeeds by nesting the source inside it, so a
  # leftover aside would quietly swallow the lock instead of being renamed.
  rm -rf "$aside" 2>/dev/null
  mv "$LOCK_DIR" "$aside" 2>/dev/null || return 1
  moved=$(cat "$aside/pid" 2>/dev/null)
  if [[ "$moved" == "$judged" ]]; then
    rm -rf "$aside"
    return 0
  fi
  if [[ ! -d "$LOCK_DIR" ]] && mv "$aside" "$LOCK_DIR" 2>/dev/null; then
    echo "merge-prs: reclaim of the lock at $LOCK_DIR aborted — the lock at that name is not the one that was judged dead, so it was put back" >&2
  else
    echo "merge-prs: reclaim of the lock at $LOCK_DIR aborted — the name is taken, and the copy that was not ours is left at $aside and never deleted" >&2
  fi
  return 1
}

# Answer 75, naming the holder this run can see. Never returns.
busy_exit() {
  local holder
  holder=$(lock_holder_pid)
  [[ "$holder" == <-> ]] || holder="unknown"
  echo "merge-prs: another run holds the lock (pid $holder)" >&2
  exit $BUSY
}

# Take the lock, or answer 75 and do nothing else. Never `pgrep` (see above).
# It installs NO trap: see the call site below for why that is not an oversight.
acquire_lock() {
  local cand holder
  # Judge what is at the name BEFORE this run touches it, and that order is not
  # cosmetic. Creating the candidate below moves a directory INTO the name when
  # the name is already taken, and creating or removing anything inside a
  # directory updates that directory's mtime — so an attempt made first would
  # reset the very mtime lock_is_pidless_and_old measures, and a crashed
  # holder's pid-less lock would read as young again on the next attempt and the
  # one after. Judge, then act. The cost is that a lock released microseconds
  # after the read is answered busy rather than taken, which is what 75 means
  # and what the caller already does about it.
  holder=$(lock_holder_pid)
  if [[ "$holder" == <-> ]] && ! pid_alive "$holder"; then
    # A readable pid whose process is gone: a crashed holder. Move its lock
    # aside — but only ever THAT lock, see reclaim_lock — and then take the
    # name the move leaves free.
    #
    # Test hook (MERGE_PRS_TEST_PAUSE_AFTER_LIVENESS): between judging the
    # holder dead and moving the lock aside, so a test can put a LIVE lock at
    # the name in exactly that window and prove the reclaim refuses it.
    if [[ -n "${MERGE_PRS_TEST_PAUSE_AFTER_LIVENESS:-}" ]]; then
      touch "$MERGE_PRS_TEST_PAUSE_AFTER_LIVENESS" 2>/dev/null
      while [[ -f "$MERGE_PRS_TEST_PAUSE_AFTER_LIVENESS" ]]; do sleep 1; done
    fi
    # Judged with the pid that was read, so reclaim_lock can insist the lock it
    # moved aside is that one and not a replacement.
    reclaim_lock "$holder" || busy_exit
  elif lock_is_pidless_and_old; then
    # No pid at all, and old enough that nobody is mid-write in it. Judged as
    # the empty string, so the aside's pid is compared against the absence that
    # was judged: a lock that grew a pid in the meantime is a different lock.
    reclaim_lock "" || busy_exit
  elif [[ "$holder" == <-> ]] || [[ -d "$LOCK_DIR" ]]; then
    # Somebody else's, and not provably abandoned: a live pid, or a pid-less
    # directory young enough to be a holder microseconds into its own acquire.
    # Neither is this run's to take on a guess.
    busy_exit
  fi

  # The name is free, or was just freed by a verified reclaim. The candidate is
  # complete before the name exists, and the rename is the only moment the name
  # exists — a bare `mkdir` then `echo > pid` has a window in between that every
  # other run reads as a lock with no pid in it, and that is not a harmless
  # reading: it is a lock nobody can reclaim, because there is no pid to judge.
  cand="$LOCK_DIR.cand.$$"
  rm -rf "$cand" 2>/dev/null
  if mkdir "$cand" 2>/dev/null && echo "$$" >"$cand/pid" 2>/dev/null \
    && mv "$cand" "$LOCK_DIR" 2>/dev/null; then
    # `mv` onto an EXISTING directory does not rename over it: it moves the
    # candidate INTO that directory and exits 0, empty target or not. That is
    # the busy answer, and the nesting is the only way to tell it apart from a
    # win — so our own candidate, which can only be this run's, is taken back
    # out of the holder's lock rather than left in it.
    if [[ -d "${LOCK_DIR:?}/${cand##*/}" ]]; then
      rm -rf "${LOCK_DIR:?}/${cand##*/}" 2>/dev/null
    elif [[ "$(lock_holder_pid)" == "$$" ]]; then
      # Read-back: the name holds OUR pid. A rename cannot have replaced a
      # non-empty directory, so nothing could have taken the name in between.
      return 0
    fi
  fi
  # Lost the name to a run that took it between the judgement above and this
  # rename. That is a busy host, not a broken one.
  rm -rf "$cand" 2>/dev/null
  busy_exit
}

# Drop the lock, and this run's scratch with it. On every exit: the end of the
# loop, a refusal, a signal, a failed `mktemp` — a lock that only the happy path
# releases is a lock the next run has to reclaim.
#
# The pid check is the guard that matters: this only ever removes a lock that
# still names THIS process, so a run that was refused the lock (exit 75, someone
# else's lock at the name) cannot delete the holder that is still working, and a
# holder whose lock was reclaimed underneath it cannot delete its replacement.
# The INT and TERM traps below end in `exit`, which runs this again — hence the
# no-op when the lock is already gone.
release_lock() {
  local pid
  if [[ -f "$LOCK_DIR/pid" ]]; then
    pid=$(cat "$LOCK_DIR/pid" 2>/dev/null)
    if [[ "$pid" == "$$" ]]; then
      rm -rf "$LOCK_DIR"
    fi
  fi
  if [[ -n "$RUN_TMP" ]]; then
    rm -rf "$RUN_TMP"
  fi
}

# One stderr capture and one marker file, reused by every PR in the run. Named
# before the lock is taken so the EXIT trap can always read it.
RUN_TMP=""
# The traps go on HERE, at the top level of the script, and never inside
# acquire_lock — because in zsh a trap set in a function belongs to that
# function: it FIRES when the function returns, and is gone afterwards.
# Measured here on zsh 5.9, an EXIT trap installed inside a function ran the
# moment that function returned (with every variable the run had not yet
# assigned still empty) and left no trap behind, so the lock was taken and
# released again before the first PR and the whole run was unprotected — with
# no symptom except that nothing was ever locked. A lock that does not survive
# its own acquire is worse than no lock, because every caller now believes
# there is one.
#
# Before the acquire rather than after it, so the window between holding a lock
# and being ready to give it back is not a signal-shaped hole. A run refused the
# lock (exit 75) runs this trap on its way out too, and the `$$` check in
# release_lock is what stops it deleting the live holder's lock.
trap 'release_lock' EXIT
# The pid of the PR in flight, or empty when there is none. Forward_signal reads
# it; the loop clears it the moment the body is reaped, so a signal that arrives
# between two PRs cannot signal a pid the kernel has since handed to somebody
# else.
pr_child=""
# Hand the signal on to the PR in flight before giving the lock back. zsh
# DEFERS a trap while a foreground child runs, so the body is backgrounded and
# waited on (see the loop): signalled at the parent alone, a foreground body
# would have gone on to `gh pr merge` and been reaped by no epilogue at all.
#
# TERM, never INT, and to the body's own pid: see the note at the loop for what
# this does and does not reach.
forward_signal() {
  trap '' INT TERM
  if [[ -n "$pr_child" ]]; then
    kill -TERM "$pr_child" 2>/dev/null
    wait "$pr_child" 2>/dev/null
    pr_child=""
  fi
  release_lock
  exit "$1"
}
trap 'forward_signal 130' INT
trap 'forward_signal 143' TERM
acquire_lock
RUN_TMP=$(mktemp -d "${TMPDIR:-/tmp}/merge-prs-run-XXXXXX") || die "mktemp failed"
MARK_FILE="$RUN_TMP/marker"
ERR_FILE="$RUN_TMP/stderr"

# Files where two branches legitimately append and both sides must survive.
# Extend for your repo (a session log, a hand-maintained barrel, a changelog).
# Files that concurrent lanes routinely append to, where keeping BOTH sides of a
# conflict hunk is the correct resolution. The web barrel and the message catalogue
# earned their place the hard way: every wave with two parallel lanes touches them,
# and without them the second merge of each wave aborts. Only ever add a file whose
# lanes append at the END — the resolver preserves order, not intent.
# The check whose conclusion gates a merge (regex over check-run names). A run that
# registers instantly — a review bot — must never satisfy the wait on its own.
REQUIRED_CHECK=${REQUIRED_CHECK:-'^Build'}
# How long the review bots get to post on the refreshed head before the merge
# condition is asked about. Bounded: a bot that has not run yet is invisible to
# a check-run read, so this waits, but a wave must not be able to stall here.
REVIEW_SETTLE_SECONDS=${REVIEW_SETTLE_SECONDS:-120}
APPEND_ONLY=${APPEND_ONLY:-'^(\.agents/session-log\.md|CHANGELOG\.md|packages/[^/]+/src/application/ports/out/index\.ts|apps/web/src/components/ui/index\.ts|apps/web/src/components/campaign/messages\.ts)$'}

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

# Merge ONE PR, or refuse it. Every refusal in this file is a `die` or an
# `exit 1`, and every one of them is inside here — which is the point: run as a
# subshell, a refusal ends this PR and nothing else, with the same message and
# the same exit code it has always had, and the `cd`s it does along the way die
# with it instead of being left behind for the next PR.
#
# The five spec fields arrive already split. The caller parses them once,
# because it needs the PR number for its own summary either way, and passing
# them in keeps the split from being written down twice.
pr_body() {
  local pr="$1" worktree="$2" branch="$3" lane="$4" wave="$5"

  # D184's merge gate — before ANY of this PR's own work, so a refusal costs
  # no fetch, no push and no CI run. An empty lane is today's behaviour
  # exactly: no gate, no wave required. `pre-pr-check` itself decides risk
  # (a `normal` row always passes) — this script never reads the plan.
  if [[ -n "$lane" ]]; then
    [[ -n "$wave" ]] || die "PR #$pr: a lane ($lane) was given with no wave — the pre-PR-review gate needs both"
    typeset -a preprcheck_args
    preprcheck_args=(pre-pr-check "$lane" --wave "$wave")
    [[ -z "$LOGDIR_OVERRIDE" ]] || preprcheck_args+=(--logdir "$LOGDIR_OVERRIDE")
    ( cd "$REPO" && yarn plan:review "${preprcheck_args[@]}" )
    preprcheck_status=$?
    # Distinguish a REFUSAL (exit 1, the gate ran and said no) from every
    # other non-zero exit (2 is pre-pr-check's own usage error; anything
    # else is `yarn` or the process itself failing to run at all) — a
    # refusal and a broken gate are different problems, and the message
    # must say which one this is.
    if [[ "$preprcheck_status" -eq 1 ]]; then
      die "PR #$pr ($lane): D184's pre-PR-review gate refused the merge — see above"
    elif [[ "$preprcheck_status" -ne 0 ]]; then
      die "PR #$pr ($lane): D184's pre-PR-review gate could not run (exit $preprcheck_status) — see above"
    fi
  fi

  echo "=== PR #$pr ($branch)"

  cd "$REPO" || die "cannot cd to $REPO"
  git fetch -q origin "$MAIN" || die "git fetch origin $MAIN failed — refusing to merge against a stale ref"

  if [[ -n "$worktree" && -d "$worktree" ]]; then
    cd "$worktree" || die "cannot cd to $worktree"
    refresh_here
    git push -q origin "$branch" || die "push failed for $branch"
    pushed_sha=$(git rev-parse HEAD)
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
    pushed_sha=$(git -C "$tmp" rev-parse HEAD)
    git worktree remove --force "$tmp" || die "cannot remove temp worktree $tmp"
  fi

  # Wait for the forge to REGISTER checks on the new head before watching them.
  # A fixed sleep is a race: when the refresh push outruns registration, `gh pr checks`
  # reports "no checks reported", `--fail-fast` treats that as a failure, and the merge
  # aborts on a PR that is perfectly healthy. Observed on #206. Poll for checks to
  # exist, then watch; a PR that genuinely has no checks configured still errors out,
  # but only after we have given the forge a fair chance to say so.
  # Poll the NEW HEAD's check-runs, not the PR's check list. `gh pr checks --json name`
  # answers at PR level and is satisfied by a check that registered instantly (a review
  # bot) or by one carried from the pre-refresh head — so it returns >0 while the head
  # that `--watch` resolves still has none, and the watch reports "no checks reported"
  # anyway. That is how the first version of this guard still lost the race, twice.
  # Re-read the head each pass rather than pinning it once: `--watch` resolves the PR's
  # head independently, so a push landing mid-poll would leave the guard asking about a
  # commit the watch has already moved past — the same guard-and-watch-disagree shape as
  # the bug this whole block exists to fix. An empty answer counts as not-yet-registered
  # rather than aborting, because a transient API hiccup is not a verdict.
  # Ask about the commit THIS script just pushed, never about whatever `gh` says the head
  # is. Observed on #224: after the refresh push, `gh pr view --json headRefOid` still
  # answered the previous SHA for a while; that SHA's runs had just been CANCELLED by the
  # new push, so "not success" read as a failed PR while the real head's checks were
  # pending. If the forge later reports a head that is not ours, someone else pushed —
  # stop rather than verify a commit we did not refresh.
  head_sha=$pushed_sha
  registered=0
  for _ in $(seq 1 40); do            # up to ~10 minutes at 15s
    forge_head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid 2>/dev/null || true)
    if [ -n "$forge_head" ] && [ "$forge_head" != "$head_sha" ] && [ "$(git merge-base --is-ancestor "$head_sha" "$forge_head" 2>/dev/null; echo $?)" = "0" ]; then
      die "PR #$pr head moved to $forge_head after our push of $head_sha — someone else pushed; not merging"
    fi
    if [ -n "$head_sha" ]; then
      n=$(gh api "repos/{owner}/{repo}/commits/$head_sha/check-runs" \
        --jq "[.check_runs[] | select(.name | test(\"$REQUIRED_CHECK\"))] | length" 2>/dev/null || echo 0)
      if [ "${n:-0}" -gt 0 ]; then registered=1; break; fi
    fi
    sleep 15
  done
  [ "$registered" -eq 1 ] \
    || { echo "NO CHECKS REGISTERED for #$pr after ~10m — not merging"; exit 1 }
  # Do NOT use `gh pr checks --watch` here. Observed on #217: the check-runs API for the
  # head reported 2 runs registered, and `--watch` on the same PR still said "no checks
  # reported" — the two resolve the head differently for a window after a push, and
  # `--fail-fast` turns that window into an aborted merge on a healthy PR. Poll the same
  # API the registration guard used, until every run has concluded.
  # Both loops key on REQUIRED_CHECK, not on "whatever has registered": observed on #222
  # and #219, a review bot's run registers and concludes within seconds of the push, so
  # "the list is non-empty and every run is completed" was true before the build workflow
  # had registered at all, and the script declared green beside a `pending` line. The
  # question is never "has everything so far finished" — it is "has the check that gates
  # this repo finished".
  echo "waiting for checks on $head_sha …"
  concluded=0
  for _ in $(seq 1 120); do          # up to ~30 minutes at 15s
    runs=$(gh api "repos/{owner}/{repo}/commits/$head_sha/check-runs" \
      --jq '[.check_runs[] | {n:.name, s:.status, c:.conclusion}]' 2>/dev/null || echo '[]')
    pending=$(printf '%s' "$runs" | python3 -c 'import json,sys;r=json.load(sys.stdin);print(sum(1 for x in r if x["s"]!="completed"))')
    required=$(printf '%s' "$runs" | python3 -c 'import json,sys,re;r=json.load(sys.stdin);print(sum(1 for x in r if re.search(sys.argv[1],x["n"])))' "$REQUIRED_CHECK")
    if [ "${pending:-1}" -eq 0 ] && [ "${required:-0}" -gt 0 ]; then
      concluded=1; break
    fi
    sleep 15
  done
  [ "$concluded" -eq 1 ] || { echo "CHECKS STILL PENDING for #$pr after ~30m — not merging"; exit 1 }
  bad=$(printf '%s' "$runs" | python3 -c 'import json,sys;r=json.load(sys.stdin);print(",".join(x["n"] for x in r if x["c"] not in ("success","neutral","skipped")))')
  [ -z "$bad" ] || { echo "CHECKS FAILED for #$pr: $bad"; gh pr checks "$pr"; exit 1 }
  echo "checks green on $head_sha"; gh pr checks "$pr" 2>&1 | tail -3

  # Give the review bots a bounded window to post on THIS head. A check-run
  # conclusion says nothing about a bot that has not run yet, and the whole
  # point of the merge condition is the finding that lands after CI is green.
  # This is a wait, not a proof: only bots that re-run on push (Qodo,
  # CodeRabbit) can post on a refreshed head at all — the PR-Agent workflows
  # trigger on opened/reopened/ready_for_review only — and nothing here checks
  # that any bot actually ran. What IS enforced is below: zero unresolved
  # threads, and a head unchanged since its checks were read.
  # nounset and pipefail are on but errexit is not, so a bad duration must be
  # refused here: `sleep` failing would otherwise skip the wait silently.
  [[ "$REVIEW_SETTLE_SECONDS" == <-> ]] \
    || die "REVIEW_SETTLE_SECONDS must be a whole number of seconds (got '$REVIEW_SETTLE_SECONDS')"
  echo "settling ${REVIEW_SETTLE_SECONDS}s for review bots on $head_sha …"
  sleep "$REVIEW_SETTLE_SECONDS" || die "the review-bot settle wait failed — not merging #$pr"

  # The merge condition itself, decided in TypeScript (`tools/sweep`, `yarn sweep gate`):
  # zero unresolved review threads on every page, and a head that is still the
  # SHA whose check-runs were just read. Why not here: the runners have no zsh,
  # so a condition written in this file is one the gate can never test — which
  # is how a script ends up enforcing less than the stage it implements (X13).
  # 0 = merge, 1 = refused (every reason printed, including the offending
  # thread's author), 2 = the call itself was wrong. Only 0 merges.
  yarn sweep gate --pr "$pr" --sha "$head_sha" \
    || die "merge condition unmet for #$pr — not merging"

  gh pr merge "$pr" --squash || die "squash-merge failed for #$pr"
  echo "merged #$pr"

  # Announce the merge BY PATH, for the caller to find. Not on an inherited fd:
  # every child this body starts inherits that fd, so any tool that writes to it
  # — or closes it — takes the marker with it, and the PR that merged is then a
  # PR whose worktree and branch are never cleaned up. MARK_FILE lives under
  # this run's own RUN_TMP, whose name no child knows.
  #
  # ONLY the PR number. Not the worktree and not the branch: the caller split
  # those out of the spec itself and still has them, and a worktree path may
  # contain a space — which `read -r` split, so a merged PR's worktree was left
  # behind and `git branch -D` was handed whatever survived the split. A marker
  # that cannot be misparsed is worth more than one that repeats what the caller
  # already knows.
  print -r -- "MERGED $pr" >>"$MARK_FILE"
  # Explicitly zero, because the marker is bookkeeping: a failed write to it
  # must not turn a merge that happened into a refusal.
  return 0
}

# The run. Each PR is a subshell so a refusal costs that PR and no other, and
# the epilogue below sees only the PRs that announced a merge.
typeset -a WORKTREES BRANCHES
# One line per PR for the closing summary, and the two counts it ends with.
typeset -a RESULTS
merged_count=0
refused_count=0
# `pr_status`, never `status`: zsh's `status` is a read-only special parameter
# (it is `?` under its other name), and assigning to it fails the whole script
# with "read-only variable: status" — mid-run, on the first PR, with the lock
# held and the message naming a line that looks like an ordinary assignment.
for spec in "$@"; do
  # Array-split on "|", not the old ${%%|*}/${#*|} chain: that chain reused
  # trailing text for a field a shorter spec never gave it, once a fourth and
  # fifth field existed to fall into. An out-of-range element is a parameter
  # not set under `set -u`, so every field defaults explicitly instead.
  typeset -a fields
  fields=("${(@s:|:)spec}")
  pr="${fields[1]:-}"; worktree="${fields[2]:-}"; branch="${fields[3]:-}"
  lane="${fields[4]:-}"; wave="${fields[5]:-}"

  : >"$MARK_FILE"
  if [[ -n "$CONTINUE" ]]; then
    # --continue has to be able to say WHY a PR was refused, and the reason is
    # the last thing that PR wrote to stderr — so this PR's stderr is captured
    # and replayed at the end of it. Per PR, not for the run: the next PR's
    # output can never land between one PR's message and the PR it belongs to.
    ( pr_body "$pr" "$worktree" "$branch" "$lane" "$wave" 2>"$ERR_FILE" ) &
    pr_child=$!
  else
    # Without --continue, stderr is not captured at all and the body writes
    # straight through to the terminal, in the order it wrote it. Today's
    # output, byte for byte, on the path that did not ask to change.
    ( pr_body "$pr" "$worktree" "$branch" "$lane" "$wave" ) &
    pr_child=$!
  fi
  # Backgrounded and WAITED ON, not run in the foreground: zsh defers this
  # shell's own INT and TERM traps until a foreground child is gone, so a
  # foreground body would swallow the signal, carry on to `gh pr merge`, and be
  # reaped by no epilogue at all. `wait` is what makes the trap prompt, and it
  # leaves the exit status the body's own.
  #
  # What the trap's forwarded TERM reaches, measured: the body's own subshell
  # dies at once, so the loop never returns to this PR and the merge is not
  # attempted — that is the half that matters. What it does NOT reach is a `gh`
  # already exec'd, which is a process of its own below the body: killing the
  # body leaves it running, and it is the one thing here that could still land a
  # merge after this run has released the lock. It cannot be closed from here
  # without a process group of its own for the body, and the window is a single
  # in-flight `gh pr merge` — named here rather than left to be discovered.
  wait $pr_child
  pr_status=$?
  # Cleared before anything else can signal it: from here on this pid is a
  # process that no longer exists, and a signal sent to it would land on whatever
  # the kernel has since made of the number.
  pr_child=""
  [[ -z "$CONTINUE" ]] || cat "$ERR_FILE" >&2

  # Stop at the first refusal, as this script always has, and before the
  # epilogue below can remove anything: a run that ended at a refusal has
  # appended nothing, so there is nothing for it to clean up either way.
  if [[ -z "$CONTINUE" && $pr_status -ne 0 ]]; then
    exit $pr_status
  fi

  # What the epilogue may touch. A PR that announced a merge is the only kind
  # that goes in, whatever it exited with — and the fields appended are THIS
  # spec's own, already split above, never anything read back out of the marker.
  # A refused PR is in neither list, so the epilogue canNOT remove its worktree
  # or delete its branch on the forge: that is the one thing which must not
  # happen to the only copy of the work.
  #
  # `grep -qx` and not `read`: the test is for one whole line ANYWHERE in the
  # file, so anything written to the marker path ahead of the merge cannot hide
  # the real line by being the first one.
  if grep -qx "MERGED $pr" "$MARK_FILE" 2>/dev/null; then
    [[ -n "$worktree" ]] && WORKTREES+=("$worktree")
    [[ -n "$branch" ]] && BRANCHES+=("$branch")
    merged=1
  else
    merged=0
  fi

  if [[ -n "$CONTINUE" ]]; then
    if [[ "$merged" -eq 1 ]]; then
      merged_count=$((merged_count + 1))
      RESULTS+=("#$pr ($branch): merged")
    else
      refused_count=$((refused_count + 1))
      # The last non-blank line this PR wrote to stderr is its reason. The
      # three refusals that report on stdout rather than stderr (no checks
      # registered, checks still pending, checks failed) have already said
      # theirs above, so the summary falls back to the exit code rather than
      # printing a blank where the reason should be.
      reason=$(grep -v '^[[:space:]]*$' "$ERR_FILE" | tail -1)
      [[ -n "$reason" ]] || reason="exited $pr_status after saying nothing on stderr"
      RESULTS+=("#$pr ($branch): REFUSED — $reason")
      echo "=== PR #$pr REFUSED — $reason" >&2
    fi
  fi
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

# The closing summary, and only with --continue. Without the flag this run never
# got past a refusal, so the epilogue above never ran and there is nothing to
# report. It is printed AFTER the epilogue on purpose: "2 of 3 merged" is a claim
# about what was just cleaned up, and a reader who has seen the cleanup should
# not have to scroll back for the verdict.
if [[ -n "$CONTINUE" ]]; then
  echo "=== summary"
  for line in "${(@)RESULTS}"; do
    echo "  $line"
  done
  echo "=== $merged_count merged, $refused_count refused"
  # 1, and only here: after the epilogue, so a refused PR has kept its worktree
  # and its branch for whoever picks it up next, and never on the path that
  # merged everything. ALL DONE is not printed when a PR was refused — the run
  # is not done, and saying so is the one lie this summary exists to prevent.
  [[ "$refused_count" -eq 0 ]] || exit 1
fi
echo "ALL DONE"
