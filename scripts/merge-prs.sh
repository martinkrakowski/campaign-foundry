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
# SIGNALS, and one dependency they need. Each PR runs as a process in a process
# group of its own, so `kill -TERM` on this script stops that PR — its `gh`, its
# `yarn`, everything under it — and then releases the lock and exits 143 (130 for
# INT). Making that group costs one `perl -MPOSIX -e 'POSIX::setpgid(0,0)'` per
# PR, because zsh will not give a backgrounded subshell a group of its own
# (`setopt monitor` is refused in a non-interactive script), and a run without
# that group can only be taken down by walking process ids, which misses anything
# that is no longer somebody's child. perl ships with macOS and ubuntu-latest; if
# it is missing this script says so and stops, rather than taking a lock it then
# cannot defend.
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

# This script's own path, captured HERE at the top level and used to re-enter it
# (launch_pr_body). It cannot be read as `$0` from inside a function: zsh sets
# $0 there to the FUNCTION's name — the first version passed "launch_pr_body" as
# the script to run, and every PR body died with "can't open input file:
# launch_pr_body" before printing a byte. At the top level $0 is the path this
# script was invoked with, which is what the body has to be given.
MERGE_PRS_SELF="$0"

# The hidden entry point this script re-enters through to run ONE PR's body in a
# process group of its own (see launch_pr_body). `__pr_body` is not a user flag and
# is not in the usage above: the parent run passes it so the body can be a separate
# process, and a separate process is the only thing that can be signalled as a
# group. Everything above this line is definitions; the body is dispatched near the
# bottom, once pr_body exists, and it never touches the lock.
PR_BODY_MODE=""
if [[ "${1:-}" == "__pr_body" ]]; then
  PR_BODY_MODE=1
  shift
  # Only a run that launched this body sets MERGE_PRS_PARENT, to its own pid, and
  # it is what makes this entry point safe to expose at all. Without it, anyone who
  # can type the word runs one PR's body directly: no lock, so two such bodies and
  # a real run would merge at once, and no epilogue, so nothing is ever cleaned up.
  # A caller is not a parent; exit 2 is the usage error this is, and it is not the
  # 1 a refusal uses, so a caller can tell "you may not do that" from "the gate
  # said no" without reading this file.
  [[ -n "${MERGE_PRS_PARENT:-}" ]] \
    || {
      echo "merge-prs: __pr_body is internal and is refused without MERGE_PRS_PARENT" >&2
      exit 2
    }
fi

# Leading flags, parsed in a loop so their order is not a rule a caller has to
# know: `--logdir X --continue` and `--continue --logdir X` are the same run.
# The first argument that is not a flag is a spec, and everything from there on
# belongs to the loop.
#
# --logdir names the wave log directory outright, for every spec in this run
# that carries a lane. Omitted, `pre-pr-check` resolves it itself — the same
# resolution wave-event.sh uses — so this script never invents a default of its
# own to drift from that one.
# With --continue, a refused PR is one line in the closing summary instead of
# the end of the run. Empty means "stop at the first refusal", which is what
# every caller that does not ask for it gets.
#
# SKIPPED ENTIRELY for a body. A body inherits both from the environment, and
# re-initialising them here reset the inherited values to empty — which is how
# `--logdir` stopped reaching `pre-pr-check` for every lane and nothing said so:
# the body ran, the gate ran, and the log directory was simply not the one the
# caller asked for. A body's configuration is what the parent exported, and
# nothing in here may overwrite it.
if [[ -z "$PR_BODY_MODE" ]]; then
  LOGDIR_OVERRIDE=""
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
fi

# perl is here for exactly one line — the `setpgid` in launch_pr_body — and that one
# line is what lets a signal reach a `gh` the body has already exec'd, which is the
# difference between stopping a run and leaving it to finish merging. perl ships
# with macOS and with ubuntu-latest, so this is a check rather than a dependency;
# the message says what is missing and what it is needed for, because the failure
# mode without it is not a crash here but a signal this script silently cannot
# deliver later, when a merge is already in flight. The POSIX module is checked too,
# since a perl without it cannot setpgid at all (see launch_pr_body).
perl -MPOSIX -e 1 >/dev/null 2>&1 \
  || die "merge-prs: perl with the POSIX module is required — each PR body is launched through 'perl -MPOSIX -e setpgid' so a signal can reach the whole process group, and this perl cannot load POSIX"

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

# The token in the lock at the name, or empty when there is none to read: a
# `<pid> <nonce>` pair. `cat` and not `$(<file)`: zsh's own "no such file"
# diagnostic for `$(<…)` is NOT covered by a redirection inside the substitution,
# so a lock with no token in it printed that error to stderr on every run that
# looked at it.
lock_token() {
  cat "$LOCK_DIR/pid" 2>/dev/null
}

# The pid half of it, and the ONLY part liveness is judged by — a pid on its own
# cannot tell a stale lock from a fresh holder that was handed the same recycled
# number, which is what the nonce exists for. A lock written by an older build
# holds a bare pid, and `%% *` leaves that answer unchanged.
lock_holder_pid() {
  print -r -- "${$(lock_token)%% *}"
}

# This acquisition's own token, as `<pid> <nonce>` — and the SPACE is load-bearing,
# not formatting. lock_holder_pid and acquire_lock both read the pid half with
# `${token%% *}`, so a token written without one is returned whole: `1234-1234-99-
# 1699…` is not `<->`, the liveness test never runs, and a crashed holder's lock
# cannot be judged dead by anyone, ever. Every test in the file plants a lock in
# the documented format and so agreed with that; the only thing that catches it is
# a lock this script produced itself, which is why one of them now SIGKILLs a real
# run instead of writing the file.
#
# The nonce only has to differ between two acquisitions racing for one name — it
# is not a secret and nothing is authenticated with it — so pid, $RANDOM and the
# clock together are more than enough, and `date +%s%N` is not portable to every
# macOS, hence the fallback.
new_lock_token() {
  print -r -- "$$ $$-$RANDOM-$(date +%s%N 2>/dev/null || date +%s)"
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
# would then merge at once — the exact failure this lock exists to prevent.
#
# What is compared is the whole TOKEN, not the pid. A replacement whose live
# holder was handed the same recycled pid carries a different nonce, so equal
# pid text — which is all a stale lock and its replacement can be relied on to
# agree about — no longer passes for proof of anything. Anything else is a lock
# this run never judged, and it is NEVER deleted: put it back when the name is
# free, leave it aside when it is not, and report the abort either way.
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
# Sets LOCK_TOKEN to the token this run installed, which is what release_lock
# insists on before it removes anything.
acquire_lock() {
  local cand token holder
  # Judge what is at the name BEFORE this run touches it, and that order is not
  # cosmetic. Creating the candidate below moves a directory INTO the name when
  # the name is already taken, and creating or removing anything inside a
  # directory updates that directory's mtime — so an attempt made first would
  # reset the very mtime lock_is_pidless_and_old measures, and a crashed
  # holder's pid-less lock would read as young again on the next attempt and the
  # one after. Judge, then act. The cost is that a lock released microseconds
  # after the read is answered busy rather than taken, which is what 75 means
  # and what the caller already does about it.
  token=$(lock_token)
  holder="${token%% *}"
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
    # Judged with the whole token that was read, so reclaim_lock can insist the
    # lock it moved aside is that one and not a replacement — not even one whose
    # holder was handed the same recycled pid.
    reclaim_lock "$token" || busy_exit
  elif lock_is_pidless_and_old; then
    # No token at all, and old enough that nobody is mid-write in it. Judged as
    # the empty string, so the aside's token is compared against the absence
    # that was judged: a lock that grew a token in the meantime is a different
    # lock.
    reclaim_lock "" || busy_exit
  elif [[ "$holder" == <-> ]] || [[ -d "$LOCK_DIR" ]]; then
    # Somebody else's, and not provably abandoned: a live pid, or a token-less
    # directory young enough to be a holder microseconds into its own acquire.
    # Neither is this run's to take on a guess.
    busy_exit
  fi

  # The name is free, or was just freed by a verified reclaim. The candidate is
  # complete before the name exists, and the rename is the only moment the name
  # exists — a bare `mkdir` then a write has a window in between that every
  # other run reads as a lock with no token in it, and that is not a harmless
  # reading: it is a lock nobody can reclaim, because there is nothing to judge.
  LOCK_TOKEN=$(new_lock_token)
  cand="$LOCK_DIR.cand.$$"
  rm -rf "$cand" 2>/dev/null
  if mkdir "$cand" 2>/dev/null && echo "$LOCK_TOKEN" >"$cand/pid" 2>/dev/null \
    && mv "$cand" "$LOCK_DIR" 2>/dev/null; then
    # `mv` onto an EXISTING directory does not rename over it: it moves the
    # candidate INTO that directory and exits 0, empty target or not. That is
    # the busy answer, and the nesting is the only way to tell it apart from a
    # win — so our own candidate, which can only be this run's, is taken back
    # out of the holder's lock rather than left in it.
    if [[ -d "${LOCK_DIR:?}/${cand##*/}" ]]; then
      rm -rf "${LOCK_DIR:?}/${cand##*/}" 2>/dev/null
    elif [[ "$(lock_token)" == "$LOCK_TOKEN" ]]; then
      # Read-back: the name holds OUR token. A rename cannot have replaced a
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
# The token check is the guard that matters: this only ever removes a lock that
# still carries THIS acquisition's token, so a run that was refused the lock
# (exit 75, someone else's lock at the name) cannot delete the holder that is
# still working, and a holder whose lock was reclaimed underneath it cannot
# delete its replacement — not even one whose holder was handed this run's own
# recycled pid, which is what the pid-only version of this check would have
# done. The INT and TERM traps below end in `exit`, which runs this again — hence
# the no-op when the lock is already gone.
release_lock() {
  if [[ -f "$LOCK_DIR/pid" ]]; then
    if [[ "$(lock_token)" == "$LOCK_TOKEN" ]]; then
      rm -rf "$LOCK_DIR"
    fi
  fi
  if [[ -n "$RUN_TMP" ]]; then
    rm -rf "$RUN_TMP"
  fi
}

# The trap and acquire block, and launch_pr_body, live BELOW pr_body: a body runs in
# its own process and must not take a lock this run already holds. See the internal
# entry point, and the note on zsh's function-scoped traps where the traps go on.

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
  #
  # The write is CHECKED, because past this point the merge is a fact on the
  # forge and a silent failure here would report it as a refusal — sending the
  # caller after a gate that passed, and leaving the only copy of the branch
  # behind. So a marker that cannot be written is its own outcome, named as
  # such and never counted as a refusal; the exit code it carries makes the run
  # fail even with --continue.
  if ! print -r -- "MERGED $pr" >>"$MARK_FILE"; then
    echo "merge-prs: #$pr MERGED but its marker could not be written — clean up ${worktree:-its worktree}/${branch:-its branch} by hand" >&2
    return $EXIT_MERGED_UNRECORDED
  fi
  # Explicitly zero, because the marker is bookkeeping: a failed write to it
  # must not turn a merge that happened into a refusal.
  return 0
}

# 3, not 1: the body exits 3 when `gh pr merge` SUCCEEDED and only the marker
# could not be written. It is not a refusal and must never be counted as one —
# the merge is on the forge — but the run still has to end non-zero, so this
# code is what tells the two apart without a second channel to write on (the
# channel is exactly what failed). Declared before the entry point below, which
# is the first thing that can run a body.
EXIT_MERGED_UNRECORDED=3

# THE INTERNAL ENTRY POINT. Everything above is definitions; this is the only
# path that runs a body, and it exists because the body has to be a separate
# process: zsh will not put a backgrounded subshell in a process group of its
# own, so a signal could not be aimed at one PR's `gh` without hitting this run.
# The exit status is the body's own, which is what the parent's `wait` reads.
#
# It deliberately does NOT touch the lock, and it is reached BEFORE the traps and
# the acquire below: a body that could take or release the lock would be a body
# that could end the run, and this one is supposed to be told what to do and
# nothing more. Its environment is its configuration — see the exports below.
if [[ -n "$PR_BODY_MODE" ]]; then
  # Exactly the five spec fields, because pr_body reads them as $1..$5 under
  # `set -u` and a short call would die on a parameter-not-set error that names
  # nothing useful. This entry point is not for callers; the message says so.
  [[ $# -eq 5 ]] \
    || die "merge-prs: __pr_body is an internal entry point and takes exactly the five spec fields (got $#). Run scripts/merge-prs.sh with PR specs instead."
  pr_body "$@"
  exit $?
fi

# One stderr capture and one marker file, reused by every PR in the run. Named
# before the lock is taken so the EXIT trap can always read it.
RUN_TMP=""
# The token this run installed, or empty when it never took the lock. Empty is
# also what a run refused the lock carries out to its exit, and it matches no
# lock's token, which is what keeps that run from deleting the holder's.
LOCK_TOKEN=""
# The pid of the PR in flight, or empty when there is none — and that pid is also
# the body's PROCESS GROUP, because launch_pr_body gives it one. forward_signal
# reads it; the loop clears it the moment the body is reaped, so a signal that
# arrives between two PRs cannot aim at a group the kernel has since handed to
# somebody else.
pr_child=""
# Hand the signal to the PR in flight, then give the lock back.
#
# The GROUP is the point, and it is atomic in a way a walk of the process tree is
# not. `kill -TERM -- -$pr_child` names every process in that group at the instant
# it is delivered — the body, a `gh` it exec'd a moment ago, a `yarn` under that,
# anything any of them started since — with no read-then-act window in which a new
# child can appear unmissed, and no pid that can be recycled between reading it
# and signalling it. The walk this replaces (`ps -A -o ppid=` recursion, deepest
# first, which is what round 2 shipped) had neither property: it missed a child
# spawned after its own pass, and it missed every descendant that had been
# re-parented away, because such a process is no longer anybody's child while
# still being in this group. `wait` reaps the body, and the group is gone by then
# or the run has said so loudly enough.
forward_signal() {
  trap '' INT TERM
  local group sweep
  if [[ -n "$pr_child" ]]; then
    group="$pr_child"
    # The global is cleared HERE, before the sweep and not after it: a second
    # signal must not re-aim at a group this call is already tearing down, and by
    # now the body itself is reaped.
    pr_child=""
    kill -TERM -- "-$group" 2>/dev/null
    # The group's LEADER'S PID as well, and the window is why. `&` returns as soon
    # as the fork is done, and the child is not in a group of its own until perl
    # has run setpgid — so a TERM that lands in that window finds no group with
    # that id, the group kill fails silently, and `wait` below then blocks for the
    # whole PR: the signal is answered only once the merge it was meant to stop
    # has finished, and the lock is released after it.
    #
    # Signalling the pid closes that window from both sides and is safe on both:
    # before setpgid it kills perl, whose TERM disposition is still the default
    # (nothing has trapped it yet — the exec that installs zsh's has not run); after
    # setpgid it kills the body, which the group kill is also doing to the children
    # it cannot reach any other way. And this pid cannot be recycled: it is an
    # unreaped child of this shell, so the kernel still has its entry.
    kill -TERM "$group" 2>/dev/null
    wait "$group" 2>/dev/null
    # AND THEN SWEEP, because one TERM is not the end of a group. A fork
    # INHERITS its parent's process group, so the group outlives the body, and a
    # process that was in the middle of handling the TERM when it arrived can
    # fork on its way out — after the signal was delivered, which means it was not
    # in the group the signal named. Measured here before this loop existed: a
    # `gh` stub whose TERM handler forked a 300s sleeper left that sleeper running
    # to the end of its sleep, under a lock this run had already released and told
    # the next run was free.
    #
    # SIGKILL to the GROUP, not to the body: the body is already gone and the
    # sleeper is not under it any more. `kill -0 -- -PGID` is the test for "is it
    # over", because a process group exists exactly as long as it has a member —
    # measured: 0 with a member, non-zero once the group is empty, non-zero for a
    # pgid that never existed.
    #
    # Twenty passes at 0.1s is two seconds, which is what init needs to reap a
    # killed descendant; a group that is still answering after SIGKILL is not
    # going to be talked down, so the run names it and hands the lock back rather
    # than leaving the next run to meet it. That is also the one thing here that
    # can be wrong in the unsafe direction: once the group is empty its id is
    # free, and a new process group can be given that number — so a straggler
    # check that runs late enough could aim at a stranger. The window is the
    # sleep below and the group is empty within a pass or two of the KILL, which
    # is why the loop stops the moment the group stops answering.
    for sweep in {1..20}; do
      kill -0 -- "-$group" 2>/dev/null || break
      kill -KILL -- "-$group" 2>/dev/null
      sleep 0.1
    done
    if kill -0 -- "-$group" 2>/dev/null; then
      echo "merge-prs: process group $group survived SIGKILL; check it before re-running" >&2
    fi
  fi
  release_lock
  exit "$1"
}
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
# lock (exit 75) runs this trap on its way out too, and the token check in
# release_lock is what stops it deleting the live holder's lock.
trap 'release_lock' EXIT
trap 'forward_signal 130' INT
trap 'forward_signal 143' TERM
# HUP too, and 129 is its number. A run that is left behind by a closing terminal
# gets SIGHUP, and a run that ignored it would go on merging with a lock nobody
# is watching: the terminal is gone, so nobody is reading the run, and the PRs it
# merges are merged with no one to answer a prompt. The same teardown as INT and
# TERM, in the same order — group, then pid, then the sweep, then the lock.
trap 'forward_signal 129' HUP
acquire_lock
# Test hook (MERGE_PRS_TEST_RUN_TMP): replace the mktemp with a directory the
# test chose, so it can make the marker file's directory unwritable and prove
# what a merge does when it cannot be recorded. Unset in every real run.
RUN_TMP="${MERGE_PRS_TEST_RUN_TMP:-}"
[[ -n "$RUN_TMP" ]] || RUN_TMP=$(mktemp -d "${TMPDIR:-/tmp}/merge-prs-run-XXXXXX") || die "mktemp failed"
MARK_FILE="$RUN_TMP/marker"
ERR_FILE="$RUN_TMP/stderr"

# Everything a body READS has to be in the environment rather than in a variable
# of this shell, because the body is a different process. Exported once, here, and
# deliberately not by blanket: the lock's own state — LOCK_TOKEN, LOCK_DIR,
# pr_child — must NOT travel, or a body would be holding the name and the token
# that make it look like the holder. Nothing exported here is secret; the nonce in
# the lock token is not even exported.
export REPO MAIN REQUIRED_CHECK REVIEW_SETTLE_SECONDS APPEND_ONLY
export LOGDIR_OVERRIDE CONTINUE MARK_FILE ERR_FILE RUN_TMP
# The body runs with no terminal to answer, so neither of these may ever ask.
# GIT_TERMINAL_PROMPT=0 is git's own switch for refusing a credential prompt, and
# GH_PROMPT_DISABLED=1 is gh's; without them a body that reaches for a credential
# blocks on a read from /dev/null (or worse, from a tty this run inherited) rather
# than failing, so a missing token looks like a hang instead of like an error.
export GIT_TERMINAL_PROMPT=0 GH_PROMPT_DISABLED=1
# The pid of the run that launched this body, and the only thing that makes the
# __pr_body entry point above usable. It is exported rather than passed so it
# cannot be forged by putting it in a spec: a spec is data, the environment is
# this run's own.
export MERGE_PRS_PARENT=$$

# Start one PR's body in a process group of its own, and set pr_child to its pid —
# which is also that group's id, because the group is made before the exec.
#
# `setpgid(0,0)` makes the perl process a group leader and `exec` then replaces it
# with zsh WITHOUT changing pid, so the group survives the handover and holds
# nothing but this body and whatever it starts. zsh cannot do this itself:
# `setopt monitor` is refused outright in a non-interactive script ("can't change
# option: monitor", measured on zsh 5.9), so without job control a backgrounded
# subshell stays in its PARENT's group — measured here, parent and child both at
# pgid 4136593 — and there would be no group of the body's own to signal without
# signalling this run along with it.
#
# `POSIX::setpgid` and not a bare `setpgid`: perl has no such builtin, and the
# bare spelling dies with "Undefined subroutine &main::setpgid" before the `or
# die` beside it can run — so the failure is a compile-time death in the child,
# not a diagnosable one here. setsid(1) would do the same job and is NOT the
# choice: it is util-linux, and this script has to work on macOS, whose perl does
# carry POSIX::setpgid.
#
# "$MERGE_PRS_SELF" is this script, re-entered at the internal entry point, and the
# parent's cwd does not change inside the loop, so a relative path still resolves
# for the body.
launch_pr_body() {
  # MERGE_PRS_TEST_PRE_SETPGID_SLEEP widens the window between the fork and the
  # setpgid, so a test can land a signal inside it on purpose. Unset in every real
  # run, and the sleep is the only thing this one-liner reads from the
  # environment: a body configurable by whoever launched the run would be a body
  # whose behaviour the run does not control.
  #
  # `</dev/null` because this body runs unattended and must never wait for a
  # person. It inherits this run's stdin, which on a terminal is a tty, and the
  # first thing that reads it — a git credential prompt, a `gh` auth question, a
  # pager — blocks on a human who is not there, holding the lock, with the run
  # looking exactly like a slow test. Refusing to answer is the point; the
  # environment below says the same thing to git and gh in words.
  perl -MPOSIX -e 'sleep $ENV{MERGE_PRS_TEST_PRE_SETPGID_SLEEP} // 0; POSIX::setpgid(0,0) or die "setpgid: $!"; exec @ARGV' \
    zsh "$MERGE_PRS_SELF" __pr_body "$@" < /dev/null &
  pr_child=$!
}

# The run. Each PR is a subshell so a refusal costs that PR and no other, and
# the epilogue below sees only the PRs that announced a merge.
typeset -a WORKTREES BRANCHES
# One line per PR for the closing summary, and the two counts it ends with.
typeset -a RESULTS
merged_count=0
refused_count=0
# Merges that happened and could not be written down. Counted apart from both
# the merged and the refused tallies, because it is neither: the merge is real
# and the run is still a failure.
unrecorded_count=0
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
    launch_pr_body "$pr" "$worktree" "$branch" "$lane" "$wave" 2>"$ERR_FILE"
  else
    # Without --continue, stderr is not captured at all and the body writes
    # straight through to the terminal, in the order it wrote it. Today's
    # output, byte for byte, on the path that did not ask to change.
    launch_pr_body "$pr" "$worktree" "$branch" "$lane" "$wave"
  fi
  # Backgrounded and WAITED ON, not run in the foreground: zsh defers this
  # shell's own INT and TERM traps until a foreground child is gone, so a
  # foreground body would swallow the signal, carry on to `gh pr merge`, and be
  # reaped by no epilogue at all. `wait` is what makes the trap prompt, and it
  # leaves the exit status the body's own. A signal that does arrive mid-body is
  # forward_signal's: the whole group, then a sweep until it is empty, then the
  # lock — in that order, so nothing is ever left running under a lock this run
  # has already given back.
  wait $pr_child
  pr_status=$?
  # Cleared before anything else can signal it: from here on this group is gone,
  # and a signal aimed at that number would land on whatever the kernel has since
  # made of it.
  pr_child=""
  [[ -z "$CONTINUE" ]] || cat "$ERR_FILE" >&2

  # Stop at the first refusal, as this script always has, and before the
  # epilogue below can remove anything: a run that ended at a refusal has
  # appended nothing, so there is nothing for it to clean up either way.
  #
  # A merge that could not be MARKED is not a refusal and does not stop the run:
  # the merge already happened, stopping here would abandon the PRs after it for
  # a bookkeeping failure, and this outcome is carried to the end of the run by
  # unrecorded_count instead.
  if [[ -z "$CONTINUE" && $pr_status -ne 0 && $pr_status -ne $EXIT_MERGED_UNRECORDED ]]; then
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
  elif [[ $pr_status -eq $EXIT_MERGED_UNRECORDED ]]; then
    # Merged, and the marker says so by its absence — the only way it can.
    # Deliberately NOT appended to either list: the epilogue is the one place
    # that destroys things, and this is the path where this run's own record of
    # what it did is known to be incomplete. The worktree and the branch are
    # named for the operator instead.
    merged=0
    unrecorded_count=$((unrecorded_count + 1))
    RESULTS+=("#$pr ($branch): merged, but NOT recorded — its marker could not be written")
    echo "=== PR #$pr merged but NOT recorded" >&2
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
# A PR that merged and could not be recorded fails the run in BOTH modes, and
# it is checked outside the --continue block on purpose: without the flag there
# is no summary, and a run whose only failure was a merge it could not write
# down must still end non-zero rather than printing ALL DONE over a branch
# somebody has to go and clean up by hand.
[[ "$unrecorded_count" -eq 0 ]] || exit 1
echo "ALL DONE"
