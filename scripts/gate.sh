#!/bin/sh
# The in-repo gate (plan D183, lane HX3-gate-in-repo):
# `yarn gate [--lane <id>] [--profile <name>] [--print-steps]`.
#
# Runs CI's gate steps in the foreground, one after another, and prints each
# step's real exit code, stopping at the first failure by name. The default
# step list mirrors .github/workflows/ci.yml:
#
#   check:env  build  typecheck  lint  format:check  lint:arch  sync:check
#   lint:bytes  plan:verify  arch:inventory  nitro-route-scan  test:cov
#   verify-manifests
#
# `yarn install --immutable` is the ONE CI step the gate does not run — the
# gate assumes dependencies are installed, and CI installs them immutably
# before anything else. `check:env` stays the conditional no-op CI has: with
# no check:env script in package.json it prints the skip line and passes.
#
# The lock covers ONLY `test:cov` and `verify-manifests` — the two steps that
# must not run concurrently on one host. It is taken just before the first
# locked step and released right after the last one; everything before —
# build, typecheck, lint, the arch checks — runs WITHOUT it. While it is
# held, a background heartbeat loop keeps the lock's `beat` fresh, and ONE
# trap (the EXIT trap; INT and TERM only turn the signal into an exit that
# falls through to it) releases the lock AND kills that loop, on failure and
# on signal alike. A release that fails or is refused is reported loudly, and
# a gate whose lock could not be released does not report green.
#
# At every locked-step boundary the gate also verifies the lock is still its
# own: the heartbeat loop is running (its failure marker catches the zombie a
# kill -0 cannot) and the lock still names this gate — either failing fails
# the gate as "lock lost", so a holder whose lock was reclaimed stops its
# protected steps instead of running them beside whoever holds the name. The
# between-steps window is testable via CF_GATE_TEST_PAUSE_BEFORE_STEP.
#
# The lock is one slot of a per-host semaphore: CF_GATE_SLOTS (default 1) says
# how many, and this gate takes the first free one, so two gates on one host no
# longer refuse each other when the host has room for both. CF_GATE_SLOTS is set
# HOST-WIDE and never per seat, and there is still ONE GATE PER WORKTREE: the
# slots are per host, and `verify-manifests` mutates the tree it verifies, so two
# gates in two worktrees would each be handed a slot and each would write
# manifests the other is reading.
#
# A coverage threshold failure fails the gate even when vitest exits 0: the
# test:cov step's output is captured, replayed for the human, and scanned for
# `ERROR: Coverage` — a piped read (M3) reported exit 0 while coverage failed,
# and the scan is what stops the same failure arriving through a pipe.
#
# `--profile <name>` is for a host whose tests cannot all be green (D187). It
# replaces ONE cell — the test:cov step's command — with a `yarn vitest run`
# that filters host-sensitive tests by tag and carries the timeout that host
# needs, and it keeps the step's NAME, so the lock still covers it and the
# coverage scan still wraps it. Nothing else moves: the arch checks, the guard
# and the manifest replay are the same commands in the same order. A profile
# does NOT enforce coverage, and says so on every run: a filtered suite cannot
# cover what it did not run, so a local number would be a number it did not
# earn — GitHub CI enforces 100% on the full run, with nothing filtered. The
# names of the excluded tests are printed just before the test step runs, so a
# green profiled gate can never read as "the whole suite passed" — and not
# before the run, so a gate that fails earlier never pays for the collection.
# That listing is filtered by the profile's OWN filter, negated as a group —
# `!(<filter>)`, its exact complement — never by a second list of tag names that
# can fall behind the one the test step runs: a banner that names tests the run
# did not skip is worse than no banner, because a reader trusts it.
# No profile at all means today's command, byte for byte.
#
# `--print-steps` prints the resolved step commands (`name<TAB>command`) and
# exits 0 without running a step, taking no lock and listing no tests: what to
# run is answerable without running it.
#
# For tests the step list is injectable: CF_GATE_STEPS overrides it, one
# `name<TAB>command` line per step, run in the given order — so a test runs
# fake steps (`true`, `sh -c "exit 3"`, a step that prints `ERROR: Coverage`
# and exits 0) instead of the real suite. The locking rules above apply to
# injected lists unchanged: a step NAMED test:cov or verify-manifests is
# locked, whichever command it carries. The nitro guard's prepare command and
# manifest path are injectable the same way (CF_GATE_NITRO_PREPARE,
# CF_GATE_NITRO_MANIFEST) so a test can fail preparation without touching the
# workspace, and CF_GATE_TEST_PRINT_LISTING makes the exclusion listing print
# the command it WOULD run instead of running it, so a test can read the
# profile's derived filter without collecting the suite to do it.
#
# POSIX sh (not zsh): GitHub Linux runners do not ship zsh. Like wave-event.sh
# and verify-manifests.sh, this file parses under the runners' /bin/sh —
# `sh -n` on it is part of its tests.
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOCK_SCRIPT="$HERE/gate-lock.sh"
TAB=$(printf '\t')

# The lock's busy contract: gate-lock.sh exits 75 when the holder is alive and
# fresh, and this script propagates that rather than burying it.
BUSY=75

# Steps that hold the lock — and nothing else.
LOCKED_STEPS=" test:cov verify-manifests "
is_locked_step() {
  case "$LOCKED_STEPS" in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# ci.yml runs `check:env` only if the script exists; the gate keeps exactly
# that conditional no-op. With no check:env script (today's package.json) this
# prints the skip line and passes; with one, it runs it.
gate_check_env() {
  if node -e "try { process.exit(require('./package.json').scripts?.['check:env'] ? 0 : 1) } catch { process.exit(1) }"; then
    yarn check:env
  else
    echo "no check:env script — skipping (env-setup not installed or package.json unreadable)"
  fi
}

# ci.yml's route-scan guard (its "Guard the API route scan against test files"
# step), verbatim: tests live in __tests__/ next to their modules, but Nitro
# scans apps/api/server/ recursively, and a *.test.ts landing there registers
# as a route and crashes `yarn dev` at boot — a runtime fault the build and
# coverage gate do not catch.
gate_nitro_guard() {
  MANIFEST="${CF_GATE_NITRO_MANIFEST:-apps/api/.nitro/types/nitro-routes.d.ts}"
  PREPARE="${CF_GATE_NITRO_PREPARE:-yarn workspace @campaignfoundry/api exec nitro prepare}"
  # A stale manifest must never be validated: remove it BEFORE preparing, so a
  # failed prepare cannot leave old routes behind for the scan to bless.
  rm -f "$MANIFEST"
  # Fail the step when preparation fails — CI's `bash -e` aborts the step on a
  # failed prepare; the gate (set -u, no -e) must check the status itself, and
  # it reports prepare's real status, not a generic 1.
  eval "$PREPARE"
  prepare_status=$?
  if [ "$prepare_status" -ne 0 ]; then
    echo "::error::nitro prepare failed (exit $prepare_status) — refusing to scan a route manifest that was not rebuilt"
    return "$prepare_status"
  fi
  # Fail closed: a missing manifest means the guard can't validate anything.
  if [ ! -f "$MANIFEST" ]; then
    echo "::error::Nitro route manifest not found at $MANIFEST"
    return 1
  fi
  # `\.test\b` is robust to Nitro's quoting/extension (matches .test', .test.ts, .test/, …).
  if grep -Eq '__tests__|\.test\b' "$MANIFEST"; then
    echo "::error::A test file was scanned as a Nitro route. Keep tests out of the server scan (see apps/api/nitro.config.ts \`ignore\`)."
    return 1
  fi
  echo "Nitro route manifest is free of test files."
}

# The profiles this gate knows, and what each one is for. A profile is a vitest
# tags filter plus the timeout that host needs; `midnight` is the owner's slow
# CPU with no AVX2, where the byte goldens hash different pixels and one test's
# own settle() deadline expires (both facts are declared in vitest.config.ts's
# `test.tags`, with the descriptions this filter names).
PROFILES=" midnight "
PROFILE=""
PROFILE_FILTER=""
PROFILE_TEST_TIMEOUT=""
PROFILE_EXCLUDED_FILTER=""
PRINT_STEPS=0
LANE=""

profile_filter() {
  case "$1" in
    midnight) printf '%s\n' '!golden-bytes && !cpu-bound' ;;
    *) return 1 ;;
  esac
}

profile_test_timeout() {
  case "$1" in
    midnight) printf '%s\n' '20000' ;;
    *) return 1 ;;
  esac
}

# The known list for a human. PROFILES is padded so the membership test below
# can match a WHOLE name; that padding is the test's business, not part of the
# answer the refusal prints.
known_profiles() {
  printf '%s' "$PROFILES" | sed 's/^ *//; s/ *$//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --lane)
      [ $# -ge 2 ] || { printf '%s\n' "gate: missing value for --lane" >&2; exit 2; }
      LANE="$2"
      shift 2
      ;;
    --profile)
      [ $# -ge 2 ] || { printf '%s\n' "gate: missing value for --profile" >&2; exit 2; }
      # An EMPTY value is refused here, at the flag, rather than downstream:
      # every check after this loop reads an empty PROFILE as "no profile was
      # asked for", so `--profile ''` would run the DEFAULT gate — filtering
      # nothing, enforcing coverage — under a flag that promised a profile. The
      # refusal is the same one an unnameable value gets, and says so.
      [ -n "$2" ] || { printf '%s\n' "gate: invalid profile name: (empty) — must match ^[A-Za-z0-9_-]+\$" >&2; exit 2; }
      PROFILE="$2"
      shift 2
      ;;
    --print-steps)
      PRINT_STEPS=1
      shift
      ;;
    *)
      printf '%s\n' "usage: yarn gate [--lane <id>] [--profile <name>] [--print-steps]" >&2
      exit 2
      ;;
  esac
done
# An unknown profile is refused rather than ignored: silently falling through to
# the default gate would hand back a run that filtered nothing, under a name
# that promised it had. The name is validated first, as the lane id below is —
# the `case` below matches it as a SHELL PATTERN, so a name carrying `*` would
# match any profile at all.
if [ -n "$PROFILE" ]; then
  case "$PROFILE" in
    *[!A-Za-z0-9_-]*)
      printf '%s\n' "gate: invalid profile name: $PROFILE — must match ^[A-Za-z0-9_-]+\$" >&2
      exit 2
      ;;
  esac
  case "$PROFILES" in
    *" $PROFILE "*)
      PROFILE_FILTER=$(profile_filter "$PROFILE")
      PROFILE_TEST_TIMEOUT=$(profile_test_timeout "$PROFILE")
      # What the run SKIPS is the filter the run uses, negated as a group — the
      # exact complement, so a profile that gains a tag (or a second profile
      # appears) cannot leave the exclusion banner naming a different set. A
      # hand-written second list of tags is a second thing to forget to update.
      # vitest's tag grammar takes a parenthesised group under `!`
      # (@vitest/runner: parseUnaryExpression -> parsePrimaryExpression).
      PROFILE_EXCLUDED_FILTER="!($PROFILE_FILTER)"
      ;;
    *)
      printf '%s\n' "gate: unknown profile: $PROFILE — known profiles: $(known_profiles)" >&2
      exit 2
      ;;
  esac
fi
[ -n "$LANE" ] || LANE="gate"
case "$LANE" in
  *[!A-Za-z0-9_-]*)
    printf '%s\n' "gate: invalid lane id: $LANE — must match ^[A-Za-z0-9_-]+\$" >&2
    exit 2
    ;;
esac

HB_SECONDS="${CF_GATE_HEARTBEAT_SECONDS:-60}"
case "$HB_SECONDS" in
  ''|*[!0-9]*)
    printf '%s\n' "gate: CF_GATE_HEARTBEAT_SECONDS must be a number of seconds: $HB_SECONDS" >&2
    exit 2
    ;;
esac

# The default list is the row's list in the row's order: the cheap local loop
# first, the arch checks in CI's relative order behind it, the guard, then the
# two locked steps last. `gate_check_env` and `gate_nitro_guard` are the
# functions above; every other cell is the yarn command CI runs for that step.
STEPS=""
add_step() {
  if [ -n "$STEPS" ]; then
    STEPS="$STEPS
"
  fi
  STEPS="${STEPS}${1}${TAB}${2}"
}
if [ "${CF_GATE_STEPS+set}" = "set" ]; then
  STEPS="$CF_GATE_STEPS"
else
  add_step "check:env" "gate_check_env"
  add_step "build" "yarn build"
  add_step "typecheck" "yarn typecheck"
  add_step "lint" "yarn lint"
  add_step "format:check" "yarn format:check"
  add_step "lint:arch" "yarn lint:arch"
  add_step "sync:check" "yarn sync:check"
  add_step "lint:bytes" "yarn lint:bytes"
  add_step "plan:verify" "yarn plan:verify"
  add_step "arch:inventory" "yarn arch:inventory"
  add_step "nitro-route-scan" "gate_nitro_guard"
  if [ -n "$PROFILE" ]; then
    # The step keeps its NAME, so the lock still covers it and run_test_cov
    # still wraps it. Only the command changes: no --coverage, because a
    # filtered suite cannot cover what it did not run, and a local threshold
    # would be a number this run did not earn.
    add_step "test:cov" "yarn vitest run --tagsFilter '$PROFILE_FILTER' --testTimeout $PROFILE_TEST_TIMEOUT"
  else
    add_step "test:cov" "yarn test:cov"
  fi
  add_step "verify-manifests" "sh \"\$HERE/verify-manifests.sh\""
fi

# Validate and count before running: a gate that silently runs nothing must
# not report green, and a malformed step line must refuse before step one.
total=0
last_locked=0
while IFS="$TAB" read -r name cmd; do
  [ -n "$name" ] || continue
  if [ -z "$cmd" ]; then
    printf '%s\n' "gate: step '$name' has no command — steps are name<TAB>command lines" >&2
    exit 2
  fi
  total=$((total + 1))
  if is_locked_step "$name"; then
    last_locked=$total
  fi
done <<EOF
$STEPS
EOF
if [ "$total" -eq 0 ]; then
  printf '%s\n' "gate: no steps to run — CF_GATE_STEPS, when set, must hold at least one name<TAB>command line" >&2
  exit 2
fi

# Answering what WOULD run, without running any of it: the resolved list is
# printed after it is validated (so a malformed or empty one is refused here
# too) and before the traps, the lock and the first step exist. It lists no
# tests either — a caller asking what runs must not pay for a collection.
if [ "$PRINT_STEPS" -eq 1 ]; then
  while IFS="$TAB" read -r name cmd; do
    [ -n "$name" ] || continue
    printf '%s\t%s\n' "$name" "$cmd"
  done <<EOF
$STEPS
EOF
  exit 0
fi

LOCK_HELD=0
# The caller's own stdout and stderr, saved ONCE and here — before the traps
# exist, and before any step can be signalled. The trap below can fire while a
# step's redirections are still in effect (a signal arriving during the test:cov
# step runs the trap inside run_test_cov's `> "$COVLOG" 2>&1`, under bash), and
# everything the gate then reports would land in that file — which cleanup
# deletes. These are what the release messages go to instead, so the report is
# on the caller's stdout whatever the interrupted command was doing with its own.
#
# The residual, accepted: every step's children now INHERIT fds 3 and 4, so a
# descendant of the test:cov step that outlives the gate can hold the caller's
# stdout open through fd 3 even where fd 1 was redirected into a file about to be
# deleted. For a step that captures nothing that is nothing new — those children
# already held the caller's stdout on fd 1 — and the heartbeat subshell gives
# both straight back as its first act. The alternative is worse, and not merely
# less tidy: closing 3 and 4 around run_test_cov's eval leaves them CLOSED when
# bash runs the deferred trap inside that redirect, and a failed `>&3` on
# `sh "$LOCK_SCRIPT" release …` is a shell redirection error, which skips the
# release command itself — so the fd that reports the release would become the
# reason the lock is never given back. Measured with them closed around the eval:
# exit 143, the lock left behind, no release line, and under bash not even the
# error naming the bad descriptors (it is captured along with everything else;
# dash prints both on stderr). Do not tidy this.
exec 3>&1 4>&2
HEARTBEAT_PID=""
HB_FAILED="${TMPDIR:-/tmp}/cf-gate.hbfailed.$$"
# The slot this gate holds, and the file its acquire recorded that slot in. Both
# are empty until the acquire succeeds; from then on every call below is PINNED to
# LOCK_SLOT_PATH rather than left to find the gate's own lock by searching for one
# carrying its pid — the lock parent may be 1777, and a directory planted there
# with this gate's pid in it can answer that search.
LOCK_SLOT_PATH=""
LOCK_SLOT_FILE=""
COVLOG=""
cov_failed=0
release_failed=0
release_attempted=0
# Set by run_test_cov only for the test:cov step: the captured output reports
# failed tests (`summary_kind=failed tests`) or vitest caught unhandled errors
# (`summary_kind=unhandled errors`) while the step itself exited 0. The scan
# can only turn a 0 exit into a failure (N1); it never moves a failed step's
# code. summary_reason holds the first matched log line.
summary_failed=0
summary_kind=""
summary_reason=""

release_lock() {
  # A release child has already been started, by the end-of-run release or by an
  # earlier signal: there is nothing left for a second caller to do. The flag is
  # READ here and SET immediately before the child below — see the comment there
  # for why it is not set on entry.
  if [ "$release_attempted" -eq 1 ]; then
    return 0
  fi
  # The acquire window: a lock this gate WON before it knew it held one. A signal
  # delivered while the acquire child runs is deferred by dash and by bash alike
  # until that child exits, and the child is not signalled — it completes its
  # rename and writes the slot it took into LOCK_SLOT_FILE. Only then does
  # `exit 143` run, with LOCK_HELD still 0 and the line that reads that file back
  # never reached, so there was nothing to give back and the lock sat there
  # naming a pid about to be gone: a leak until the next acquirer judged it
  # abandoned.
  #
  # The slot file's CONTENT is the exact shape of that window, and it is the only
  # evidence needed: gate-lock.sh's acquire writes it only after try_create has
  # WON, so a non-empty file names a slot this gate's own acquire took. It is
  # released PINNED to that path, and release re-reads owner and pid before it
  # removes anything, so no other gate's lock is reachable from here — an
  # EMPTY file (a busy or a refused acquire) leaves LOCK_HELD at 0 and prints
  # nothing, which is what keeps the busy exit's output exactly as it was.
  if [ "$LOCK_HELD" -eq 0 ]; then
    LOCK_SLOT_PATH=$(cat "$LOCK_SLOT_FILE" 2>/dev/null)
    [ -n "$LOCK_SLOT_PATH" ] || return 0
    LOCK_HELD=1
  fi
  if [ "$LOCK_HELD" -eq 1 ]; then
    if [ -n "$HEARTBEAT_PID" ]; then
      # Kill the heartbeat loop and reap it, so no heartbeat process survives
      # the gate by even a moment.
      kill "$HEARTBEAT_PID" 2>/dev/null
      wait "$HEARTBEAT_PID" 2>/dev/null
      HEARTBEAT_PID=""
    fi
    rm -f "$HB_FAILED"
    LOCK_HELD=0
    # At most ONE release child per gate — and the flag says exactly that, which
    # is why it is set HERE and not on entry. Two callers can reach this function
    # (the end-of-run release and cleanup's), and cleanup's must be a no-op once a
    # child has been started: a second one would find the slot file still naming
    # the slot the first already gave back, print a second "released", or — on a
    # host where another gate has since taken that name — report a REFUSAL for a
    # gate that did nothing wrong.
    #
    # It cannot be set on entry, because everything between here and this line can
    # be interrupted by a signal and re-entered through cleanup: `kill` and
    # `wait` above (wait is interruptible by a trapped signal in dash and in bash
    # alike — measured: the handler runs while the loop is still alive), and the
    # `rm`. A flag set there turns that re-entry into a silent no-op, and the gate
    # exits 143 with its lock still on disk naming a dead pid. Re-entry is safe
    # here instead: HEARTBEAT_PID is then either already cleared or names a loop
    # on its way out, so killing and waiting it again is harmless, and LOCK_SLOT_PATH
    # is the slot this gate took either way.
    #
    # The window this leaves is the gap between this assignment and the fork
    # below — a couple of microseconds, and not closable in sh without a subshell,
    # which would put the release one process further from the trap that has to
    # interrupt it.
    release_attempted=1
    # The release's status and diagnostics are not discarded: a release that
    # failed (or was refused — see gate-lock.sh) must be reported, never
    # announced as released. It is pinned to the slot this gate took, so a
    # release can only ever act on the lock this gate is actually holding. Its
    # stdio is the CALLER's, saved above: this can run inside a step's
    # redirections (see exec 3>&1 4>&2), and a line written to fd 1 there would
    # be captured — and, for the test:cov step, deleted — instead of reported.
    if CF_GATE_CALLER_PID=$$ CF_GATE_SLOT_PATH="$LOCK_SLOT_PATH" sh "$LOCK_SCRIPT" release "$LANE" >&3 2>&4; then
      # Byte-identical whether the lock was released after a step or recovered
      # from the acquire window: this is the gate's one line saying the lock is
      # gone and nothing of it is still running, and a reader must not have to
      # know which of the two paths produced it.
      printf '%s\n' "gate: lock released, heartbeat stopped" >&3
    else
      release_failed=1
      # This gate's OWN slot, which it is PINNED to rather than asked for: with
      # CF_GATE_SLOTS>1 the fixed cf-gate.lock path is a slot this gate may never
      # have held, and a failure message pointing at the wrong slot sends the
      # reader looking at an empty directory. Nothing here searches for it —
      # asking the lock script which slot this gate holds is the same scan, one
      # process further away, and the answer is a path this gate can lose.
      printf '%s\n' "gate: FAILED to release the lock — it may still be held at ${LOCK_SLOT_PATH:-${TMPDIR:-/tmp}/cf-gate.lock}" >&4
    fi
  fi
}

# The ONE trap that releases the lock and kills the heartbeat loop — on a
# failing step, on a signal, on any exit. It preserves the exit status that
# was pending when it fired (an INT arrives as `exit 130` from the trap below,
# not as $? mid-command, which could be 0 on a Ctrl-C between steps).
#
# Everything it reports goes out on the CALLER's saved stdout and stderr (see
# exec 3>&1 4>&2), never on fd 1 and fd 2 as they happen to be: this trap can
# fire inside an interrupted step's redirections, where fd 1 is a file cleanup is
# about to delete. release_lock is where the wording lives, and where the second
# signal's answer is produced.
cleanup() {
  status=$?
  # Ignore a second signal until the release has run, clearing the EXIT trap
  # first. The order is the fix: `trap - INT TERM EXIT` restored the DEFAULT
  # disposition, so a TERM arriving while the release was in flight killed this
  # gate outright — the release is a child that outlives it and removes the lock
  # anyway, which is why lock absence alone proves nothing here and why this line
  # prints nothing at all. Measured on main: exit 143, no "gate: lock released,
  # heartbeat stopped", under /bin/dash on the first attempt and under bash-as-sh
  # within two. Parking the heartbeat cannot pin that window open — this gate's
  # loop has TERM at default and dies at once — so the pause that holds it is
  # inside the release itself (CF_GATE_TEST_PAUSE_BEFORE_RELEASE).
  trap - EXIT
  trap '' INT TERM
  release_lock
  if [ -n "$COVLOG" ]; then
    rm -f "$COVLOG"
  fi
  rm -f "$HB_FAILED"
  # The file the acquire recorded this gate's slot in goes on every exit path,
  # the refused acquire included: it is this gate's own scratch file under
  # ${TMPDIR:-/tmp} (which may be a 1777 parent, so it is mktemp's name and never
  # a predictable one), and nothing else will ever clean it up.
  if [ -n "$LOCK_SLOT_FILE" ]; then
    rm -f "$LOCK_SLOT_FILE"
    LOCK_SLOT_FILE=""
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_heartbeat() {
  # The heartbeat is a background loop that refreshes the lock's beat; the
  # EXIT trap above kills it together with the lock it keeps fresh. Its own
  # traps are cleared inside: the loop must die quietly when killed, never
  # release the lock itself. Its stdio is detached from the caller's pipes —
  # killing the subshell orphans its in-flight `sleep`, which would otherwise
  # hold the caller's stdout open (a synchronously-run gate would hang on it
  # until the sleep expired); orphaned that way it holds nothing and expires
  # on its own within one interval, and the heartbeat pid itself — what the
  # tests check and what `wait` reaps — is the subshell's.
  (
    # First, and before anything else: give the caller's saved stdout and stderr
    # (fds 3 and 4) straight back. The orphaned `sleep` above would otherwise
    # keep them open for the rest of the interval — the same pipe hazard, one fd
    # wider, and it outlives the gate that already said it was gone.
    exec 3>&- 4>&-
    trap - INT TERM EXIT
    # Test hook (CF_GATE_TEST_PAUSE_BEFORE_HEARTBEAT_STOP): a pause in the loop's
    # own DEATH, which is the only way to make the release's `wait` for it a
    # window a test can signal into. The loop above dies at once, so that `wait` is
    # a few microseconds wide; a trapped signal is another matter, because a shell
    # defers its handler until the foreground command it is waiting for returns
    # (measured: 0.6s behind a `sleep 1`, and not at all behind a `sleep 60`
    # within ten), so with a handler installed here the loop survives the kill
    # until its own `sleep` ends, announces itself by touching
    # $CF_GATE_TEST_PAUSE_BEFORE_HEARTBEAT_STOP.in-handler — which is the test's
    # proof that the gate is inside that `wait` rather than merely about to be —
    # and does not die until the named file EXISTS.
    #
    # Waiting for the file to APPEAR rather than to disappear is what makes a
    # re-entry harmless: a gate whose release was interrupted sends a second TERM
    # while this handler is still running, the shell runs the handler again, and an
    # exit condition the test can take back would leave the loop spinning on a
    # marker that had just been put back (measured under dash: the gate never
    # finished). The handler ends by EXITING — a loop that merely ignored the kill
    # would never be reaped, and the release would wait on it forever.
    if [ -n "${CF_GATE_TEST_PAUSE_BEFORE_HEARTBEAT_STOP:-}" ]; then
      trap 'touch "$CF_GATE_TEST_PAUSE_BEFORE_HEARTBEAT_STOP.in-handler" 2>/dev/null; while [ ! -f "$CF_GATE_TEST_PAUSE_BEFORE_HEARTBEAT_STOP" ]; do sleep 1; done; exit 0' TERM
    fi
    while :; do
      sleep "$HB_SECONDS"
      # The heartbeat is ownership-checked on the lock side too: it refreshes
      # only a lock that still names THIS gate's pid ($$ is this shell's even
      # inside the subshell), so after a reclaim the loop fails and dies
      # instead of refreshing whoever replaced us. It is PINNED to the slot this
      # gate took as well, so the refresh cannot land on some other lock that
      # happens to carry this pid — at CF_GATE_SLOTS>1 a pid can appear in more
      # than one, and the lock parent may be 1777. Its failure is recorded in
      # a marker file the foreground gate checks at every locked-step boundary
      # — a dead loop is a zombie its parent's kill -0 cannot see.
      CF_GATE_CALLER_PID=$$ CF_GATE_SLOT_PATH="$LOCK_SLOT_PATH" \
        sh "$LOCK_SCRIPT" heartbeat >/dev/null 2>&1 || {
        printf '%s\n' "lost" > "$HB_FAILED" 2>/dev/null
        exit 1
      }
    done
  ) >/dev/null 2>&1 &
  HEARTBEAT_PID=$!
  printf '%s\n' "gate: heartbeat pid $HEARTBEAT_PID (every ${HB_SECONDS}s while the lock is held)"
}

# The foreground gate never waits on the heartbeat, so it would otherwise
# never learn that the loop died (a dead background child is a zombie its own
# parent's kill -0 reports as alive) or that the lock was reclaimed. At every
# locked-step boundary — before and after each locked step — it checks both:
# the loop is alive (and did not leave its failure marker), and the lock still
# names this gate. Either failure is "lock lost": the protected steps must not
# continue on a lock someone else holds or is about to.
check_lock_intact() {
  if [ -f "$HB_FAILED" ]; then
    return 1
  fi
  if [ -z "$HEARTBEAT_PID" ] || ! kill -0 "$HEARTBEAT_PID" 2>/dev/null; then
    return 1
  fi
  CF_GATE_CALLER_PID=$$ CF_GATE_SLOT_PATH="$LOCK_SLOT_PATH" sh "$LOCK_SCRIPT" verify "$LANE" >/dev/null 2>&1
}

# The test:cov step runs with its output captured, replayed for the human, and
# scanned for `ERROR: Coverage`: a threshold failure must fail the gate even
# when vitest itself exits 0. CI sets NODE_ENV=test on its Test step; the gate
# mirrors it. The command returns vitest's real exit code; cov_failed records
# the scan.
run_test_cov() {
  COVLOG=$(mktemp "${TMPDIR:-/tmp}/cf-gate.covlog.XXXXXX")
  eval "NODE_ENV=test $1" > "$COVLOG" 2>&1
  code=$?
  cat "$COVLOG"
  if grep -q "ERROR: Coverage" "$COVLOG"; then
    cov_failed=1
  fi
  # Scan the captured output for a test runner that reported failures while
  # exiting 0: a pipe can hide the failure code the same way coverage can
  # (M3). The scan only applies to test:cov and only matters for an exit 0 —
  # a step that already failed keeps today's path (N1). ANSI colour is stripped
  # first (POSIX sh has no $[..]) so the patterns anchor on vitest's own
  # summary lines / unhandled-error sentence at the start of a line.
  if [ "$code" -eq 0 ]; then
    ESC=$(printf '\033')
    CLEANED=$(sed "s/${ESC}\[[0-9;]*m//g" "$COVLOG")
    line=$(printf '%s\n' "$CLEANED" \
      | grep -E '^[[:space:]]*(Test Files|Tests)[[:space:]]+[1-9][0-9]* failed' \
      | head -n1)
    if [ -n "$line" ]; then
      summary_failed=1
      summary_kind="failed tests"
      summary_reason="$line"
    else
      line=$(printf '%s\n' "$CLEANED" \
        | grep -E '^[[:space:]]*Vitest caught [0-9][0-9]* unhandled error' \
        | head -n1)
      if [ -n "$line" ]; then
        summary_failed=1
        summary_kind="unhandled errors"
        summary_reason="$line"
      fi
    fi
  fi
  rm -f "$COVLOG"
  COVLOG=""
  return "$code"
}

# The tests a profiled run leaves OUT, named just before it starts. A green
# profiled gate that never said what it skipped is a green gate a reader cannot
# trust, and the filter's own names are not the names of the tests. The filter
# is the profile's own, negated as a group (PROFILE_EXCLUDED_FILTER) — derived
# where the profile is, so the banner and the run cannot name different tests.
# Injectable for the same reason the nitro guard is — collecting the suite is not
# free — and deliberately non-fatal: a listing that cannot run must not fail the
# test step it introduces, which would fail for the wrong reason.
gate_excluded_tests() {
  LIST="${CF_GATE_LIST_EXCLUDED:-yarn vitest list --tagsFilter '$PROFILE_EXCLUDED_FILTER'}"
  # Test hook: report the resolved command rather than running it, so what the
  # banner would filter on is readable without a collection.
  if [ -n "${CF_GATE_TEST_PRINT_LISTING:-}" ]; then
    printf '%s\n' "$LIST"
    return 0
  fi
  eval "$LIST" 2>&1 || printf '%s\n' "gate: could not list the tests this profile excludes (see above)"
}

printf '%s\n' "gate: lane $LANE, $total steps — 'yarn install --immutable' is the one CI step the gate does not run"
# CI's Test step sets TEST_DATABASE_URL (postgres service); the two
# real-Postgres concurrency suites skip themselves when it is absent, so a
# local gate — and a local test:cov — has not exercised them. Say so.
printf '%s\n' "gate: the two real-Postgres concurrency suites run only when TEST_DATABASE_URL is set — CI sets it; locally they skip themselves"

step_no=0
while IFS="$TAB" read -r name cmd; do
  [ -n "$name" ] || continue
  step_no=$((step_no + 1))
  printf '==> [%s/%s] %s\n' "$step_no" "$total" "$name"
  if is_locked_step "$name" && [ "$LOCK_HELD" -eq 0 ]; then
    # The caller's pid travels in CF_GATE_CALLER_PID: the lock must outlive
    # this acquire call, so it names this shell, not the gate-lock child.
    #
    # CF_GATE_SLOT_OUT is where the slot the acquire took is recorded, and this
    # gate is PINNED to it from here on — its heartbeat, its step-boundary
    # verifies and its release all name that one path, and none of them search
    # for a lock carrying this gate's pid. The file is mktemp's, not a name this
    # script invented: the lock parent is ${TMPDIR:-/tmp} and /tmp is 1777, so a
    # predictable `cf-gate.slot.$$` would be a file a second user could have
    # written before this gate got there. cleanup removes it on every exit.
    LOCK_SLOT_FILE=$(mktemp "${TMPDIR:-/tmp}/cf-gate.slot.XXXXXX")
    CF_GATE_SLOT_OUT="$LOCK_SLOT_FILE" CF_GATE_CALLER_PID=$$ sh "$LOCK_SCRIPT" acquire "$LANE"
    acq=$?
    if [ "$acq" -ne 0 ]; then
      # Nothing to release — LOCK_HELD is still 0 — and cleanup drops the file.
      printf '%s\n' "gate: could not acquire the gate lock (exit $acq) — 75 means busy: sleep and retry" >&2
      exit "$acq"
    fi
    LOCK_SLOT_PATH=$(cat "$LOCK_SLOT_FILE" 2>/dev/null)
    # Test hook (CF_GATE_TEST_NO_SLOT_RECORDED): act as though the acquire
    # recorded no slot, so a test can reach the refusal below and prove the lock
    # this gate took is still given back.
    if [ -n "${CF_GATE_TEST_NO_SLOT_RECORDED:-}" ]; then
      LOCK_SLOT_PATH=""
    fi
    # The gate holds a lock from the successful acquire onward, and it is marked
    # here — ABOVE the check for a recorded slot, deliberately. A lock the acquire
    # took and this gate cannot name is still a lock: with LOCK_HELD left 0 the
    # cleanup skips release_lock entirely, and the name then sits there until some
    # later acquire judges it abandoned — which is a reclaim, not a release.
    LOCK_HELD=1
    if [ -z "$LOCK_SLOT_PATH" ]; then
      # The acquire took a lock and did not say which one. Refused loudly rather
      # than unpinned: the cleanup's release then scans for this gate's own lock
      # (the only fallback left), which is right for a gate giving one back and
      # wrong for a gate carrying on without knowing what it holds.
      printf '%s\n' "gate: FAILED — the lock was acquired but no slot was recorded in $LOCK_SLOT_FILE; the gate cannot name the lock it holds, so it will not carry on holding it" >&2
      exit 1
    fi
    start_heartbeat
  fi
  if [ "$LOCK_HELD" -eq 1 ]; then
    # Test hook (CF_GATE_TEST_PAUSE_BEFORE_STEP): between locked steps, for
    # the test that removes or replaces the lock in exactly that window.
    if [ -n "${CF_GATE_TEST_PAUSE_BEFORE_STEP:-}" ]; then
      touch "$CF_GATE_TEST_PAUSE_BEFORE_STEP" 2>/dev/null
      while [ -f "$CF_GATE_TEST_PAUSE_BEFORE_STEP" ]; do sleep 1; done
    fi
    if ! check_lock_intact; then
      printf '%s\n' "gate: FAILED — lock lost before step '$name' (the heartbeat died or the lock no longer names this gate)" >&2
      exit 1
    fi
  fi
  cov_failed=0
  summary_failed=0
  summary_kind=""
  summary_reason=""
  case "$name" in
    test:cov)
      # The profile's two lines print HERE, immediately before the tests, and
      # not at the top of the run: naming the exclusions means collecting the
      # suite, and a gate that fails at `build` must not pay a full collection
      # (measured 18.5 s and about 10 cores on this host) for a test step it
      # never reaches. Still before the run it describes, which is all the
      # reader needs to know what this step is not running.
      if [ -n "$PROFILE" ]; then
        printf '%s\n' "gate: profile $PROFILE — coverage thresholds are not enforced under a profile; GitHub CI enforces 100% on the full run"
        printf '%s\n' "gate: the tests this profile EXCLUDES (it runs everything else):"
        gate_excluded_tests
      fi
      run_test_cov "$cmd"
      code=$?
      ;;
    *)
      eval "$cmd"
      code=$?
      ;;
  esac
  printf '<== %s: exit %s\n' "$name" "$code"
  # A step that exited 0 but whose output reports failed tests or unhandled
  # errors (a runner that lost its exit code down a pipe) fails the gate with
  # its own code 96. The scan can only turn a 0 into a failure (N1): a step
  # that already failed keeps today's path and exit code. When both the
  # failed-tests and coverage rules fire on the same exit-0 step, the stronger
  # fact is named first and coverage is still mentioned as today.
  if [ "$code" -eq 0 ] && [ "${summary_failed:-0}" -eq 1 ]; then
    printf '%s\n' "gate: FAILED — step 'test:cov' exited 0 but its output reports $summary_kind ($summary_reason)" >&2
    if [ "$cov_failed" -eq 1 ]; then
      printf '%s\n' "gate: FAILED — step 'test:cov' — a coverage threshold failure was reported (vitest exited $code)" >&2
    fi
    exit 96
  fi
  if [ "$cov_failed" -eq 1 ]; then
    printf '%s\n' "gate: FAILED at step 'test:cov' — a coverage threshold failure was reported (vitest exited $code)" >&2
    exit 1
  fi
  if [ "$code" -ne 0 ]; then
    printf '%s\n' "gate: FAILED at step '$name' (exit $code)" >&2
    exit "$code"
  fi
  if [ "$LOCK_HELD" -eq 1 ]; then
    if ! check_lock_intact; then
      printf '%s\n' "gate: FAILED — lock lost after step '$name' (the heartbeat died or the lock no longer names this gate)" >&2
      exit 1
    fi
  fi
  if [ "$LOCK_HELD" -eq 1 ] && [ "$step_no" -eq "$last_locked" ]; then
    release_lock
    if [ "$release_failed" -eq 1 ]; then
      printf '%s\n' "gate: FAILED — the lock could not be released; the gate cannot report green while it lingers" >&2
      exit 1
    fi
  fi
done <<EOF
$STEPS
EOF

printf '%s\n' "gate: $total/$total steps passed"
exit 0