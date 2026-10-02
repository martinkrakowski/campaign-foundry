#!/bin/sh
# The in-repo gate lock (plan D183, lane HX3-gate-in-repo). `yarn gate` takes it
# around the only two steps that must not run concurrently on one host —
# `test:cov` and `verify-manifests` — and its liveness is what makes a crashed
# holder self-healing instead of an orphan someone releases by hand.
#
#   gate-lock.sh run <lane> -- <command…>
#                                  hold the lock around one command — what a
#                                  lane uses; the holder is `run` itself
#   gate-lock.sh acquire <lane>   take the lock; exit 75 means BUSY. Needs a
#                                  caller pid in CF_GATE_CALLER_PID
#   gate-lock.sh release <lane>   drop it — only the lock's own owner and pid may
#   gate-lock.sh verify <lane>    exit 0 only while the lock still names this holder
#   gate-lock.sh status           print who holds each slot and whether they look
#                                 alive
#   gate-lock.sh heartbeat        refresh the beat — only on the caller's own lock
#
# There is one host-wide lock per SLOT, and CF_GATE_SLOTS says how many there are
# (default 1, which is every behaviour below as it was before slots existed) —
# unless GATE_LOCK_DIR is set, in which case the count is the POOL's:
# GATE_HOST_SLOTS, else the one derived from GATE_HOST_WORKERS, and a
# CF_GATE_SLOTS that disagrees with it is refused. See the pool below; everything
# in this paragraph describes the pool-less host, which is what CI and the Mac
# run and what the paragraph has always described.
# Slot 0 keeps the unsuffixed name and slots 1..N-1 are `cf-gate.lock.<n>`, so at
# SLOTS=1 the lock is byte-identical to the one every caller, message and test
# already names, and a slot's transients (`cf-gate.lock.<n>.cand.<pid>`,
# `cf-gate.lock.<n>.reclaim.<pid>.<x>`, `cf-gate.lock.<n>.beatnew.<pid>`) are
# derived from that slot's own path and are never slots themselves.
#
# CF_GATE_SLOTS SAYS HOW MANY GATES MAY RUN AT ONCE, and CF_TEST_MAX_WORKERS
# SAYS HOW MANY WORKERS ONE OF THEM MAY SPAWN — so the two are one decision,
# made once, for the host: CF_GATE_SLOTS × CF_TEST_MAX_WORKERS ≤ the host's
# threads. Vitest's default is availableParallelism() − 1 per run (~23 on
# midnight's 24 threads), so without the second variable three slots already
# ask for ~69 workers and seven would ask for ~160: tens of gigabytes against
# ~40 free, and false timeouts on the CPU-bound tests, which fail on their own
# internal deadlines and cannot be saved by a bigger --testTimeout.
# CF_TEST_MAX_WORKERS is read by `vitest.config.ts` (the parse is
# tools/gate/lib/max-workers.ts; a value that is not a positive whole number at
# or below availableParallelism() throws at config load, naming the variable).
# Unset means unset: CI and the Mac get vitest's own default, unchanged. On
# midnight that is 6 × 4 or 7 × 3. Do not also set VITEST_MAX_WORKERS: vitest
# applies it OVER test.maxWorkers after the config is resolved, and it does so
# unvalidated (a bare parseInt), so it silently wins and the validated number
# beside it becomes the one that is ignored.
#
# BOTH ARE SET HOST-WIDE, AND ONLY HOST-WIDE — /etc/environment on the
# midnight host, never in one seat's environment, at any moment and whatever that
# seat is holding. The number of slots is a property of the host, and the reason
# does not depend on what any one seat is doing: a caller that believes in one
# slot takes slot 0 while the others are busy, and the holder it cannot see is
# the one it just ran beside. That is equally true of a seat holding nothing —
# a seat's own view of the host is the thing that is wrong, and holding less is
# not a reason to hold a different opinion of it. So the way to change the count
# is to change the host's, for every seat at once. A seat that capped its own
# workers below the host's cap does not get a quieter machine; it gets a lane
# whose timeout budget nobody else is running under, and a slot it believes is
# cheaper than it is.
#
# ── THE HOST-WIDE POOL, AND ITS FORMAT ─────────────────────────────────────
# Everything above decides how many gates THIS project may run. The block below
# decides where they live, so that two projects on one host draw from ONE pool
# and spend the thread budget once between them — which is the whole reason
# GATE_LOCK_DIR exists: today every project has its own lock directory
# (${TMPDIR:-/tmp}/cf-gate.lock) and its own count, so two pools never see each
# other and the budget is oversubscribed as soon as both run. On midnight:
#
#   GATE_LOCK_DIR=/run/user/1000/gate-lock   the pool: local tmpfs, 0700, and
#                                            it survives logout under linger
#   GATE_HOST_WORKERS=4                      workers ONE vitest run may spawn
#   GATE_HOST_SLOTS=6                        optional — the count is otherwise
#                                            derived: max(1, nproc / workers)
#
# SET, every slot lives in that directory as `gate.lock` and `gate.lock.<n>`,
# with its transients derived from its own path as they always were. UNSET —
# the default, and what CI and the Mac run — and nothing changes: the lock is
# ${TMPDIR:-/tmp}/cf-gate.lock, named byte for byte as it has always been. An
# EMPTY value counts as unset for all three variables, so a wrapper that always
# exports them is not a broken host.
#
# GIVEN BOTH host counts, they must multiply out to the host's processors — 24 =
# 6 × 4 on midnight, and `GATE_HOST_SLOTS=7` with `GATE_HOST_WORKERS=4` on a
# 24-thread host is refused by name, because seven gates of four workers is 28
# runnable workers asked of 24 threads and the failure is not a message but tens
# of gigabytes of RSS and false timeouts on tests that fail on their own internal
# deadlines. A `GATE_HOST_SLOTS` on its OWN stays allowed, as the row has it, and
# leaves vitest's worker count uncapped: that is a host which has decided its own
# default is the cap, and this check has no second number to check it against.
#
# THE DIRECTORY IS JUDGED, NOT ASSUMED, and refused by name (exit 2) when it is
# not: it must be absolute; it is created 0700 if missing (its parent must
# exist, and this script does not create parents); it must not be a symlink; it
# must be owned by this uid; and it must not be group- or world-writable. That
# last one is not tidiness — every lock decision here is a rename into that
# directory, and in a directory another user can write, another user can be the
# one holding the slot.
#
# AND THE PARENT IS PART OF THE SAME CLAIM, and is judged before anything is
# created under it: the leaf's own 0700 protects the NAMES inside it and nothing
# about the name itself, and the name is a directory entry in the parent. A parent
# another user can write lets that user rename the pool away between one
# acquirer's mkdir and the next one's rename — onto a directory they own, holding
# a `.format` they wrote and slots they seeded — and there is nothing the leaf can
# say about it afterwards, because by then the leaf has moved. So the pool's
# parent must be owned by this uid and must not be group- or world-writable, and
# midnight's /run/user/1000 is exactly that: a per-user tmpfs the user owns,
# created by the session's own runtime directory. A pool at a shared, writable
# parent (/tmp, a group-writable spool) is refused by the operator's judgement
# even though the leaf check would pass it, and the fix is a parent under
# $XDG_RUNTIME_DIR or a home directory, not a mode on the pool.
#
# Trailing slashes are reduced away before either is judged, and `/` is refused.
# A slash is not a spelling here: every test that walks to a path ending in `/`
# resolves a symlink first, so `[ -L "$d/link/" ]` is false for a link to a
# directory and `find "$d/link/"` descends through it — the pool is then judged
# through its target and a symlinked pool is accepted.
#
# `.format` in it holds the number this script speaks — 1 — written as a temp
# file and `ln`ed onto the name, because link(2) refuses to replace and that is
# the portable atomic no-replace (`mv -n` is not atomic on macOS, so a `mv`
# would let two acquirers each believe they published it). It is then READ BACK
# and compared, because `ln` failing on an existing file is the other acquirer's
# success, not an error. A pool holding any other value is refused: two projects
# on different lock semantics must never share one pool, and a project that
# vendors this script has to declare which format it speaks before it may take a
# slot in one.
#
# FORMAT 1 IS FROZEN. Changing any line of this list bumps the number:
#   slots         gate.lock and gate.lock.1 .. .63
#   transients    .cand.<pid>, .reclaim.<pid>.<pass>, .beatnew.<pid>
#   files         owner pid started beat worktree project
#   liveness      kill -0 succeeds AND the beat is younger than the threshold
#   heartbeat     every holder beats at least every 60s; no reader's threshold
#                 is below 600s (CF_GATE_STALE_SECONDS under that is refused
#                 when GATE_LOCK_DIR is set)
#   reclaim       rename aside, verify what moved, then delete
#   MAX_SLOTS     64
#   pid namespace ONE for every participant — a containerised gate reads every
#                 pid as dead and reclaims holders that are running
#
# NEVER on mergerfs or NFS. A pool there merges branches: two candidates on two
# branches can both win one name, and a cross-branch rename can fall back to
# copy+delete, which is the race that reclaims a live holder (see the beat,
# below). Midnight's TMPDIR is mergerfs over three disks, which is exactly why
# the heartbeat stages its beat INSIDE the pool beside its own slot instead of
# on TMPDIR.
#
# CF_GATE_SLOTS and CF_TEST_MAX_WORKERS are kept for ONE release and mean what
# they always meant — one project's own view of the host — so an operator who
# set them before the pool existed keeps a working host. Under GATE_LOCK_DIR
# the host variables are the pool's, and a project variable that disagrees with
# them is refused rather than obeyed: a seat's view of the host is the thing that
# is wrong, and lock correctness survives the disagreement while the thread
# budget does not.
#
# ONE GATE PER WORKTREE, even at SLOTS>1, because the lock is per host and not
# per checkout: `verify-manifests` mutates the tree it is verifying, so two
# gates in ONE worktree would each be handed a different slot and each would
# then write manifests the other is reading. (Two lanes in two worktrees is the
# case slots exist for, and is not what this rule is about.)
#
# So `acquire` learns WHICH worktree the caller is standing in, records it in its
# own slot as the fifth file `worktree`, and — having won a slot, before the pin
# is written — looks over every other slot for one that names the same worktree
# under a holder that is still alive and answering. Finding one, it gives its own
# slot back and answers 75: busy, and the words "same worktree" beside the holder
# it yielded to. See acquire, worktree_holder and same_worktree_exit.
#
# ANY other slot, not only a lower-numbered one. Yielding only downward looks
# equivalent and is not: a third holder releasing slot 0 between the two acquires
# leaves the later acquirer BELOW the earlier one, after the earlier one has
# already checked and found nothing above it. Two gates then run in one worktree
# and the rule is enforced nowhere.
#
# This never lets two run, because the winner is still working when the loser
# looks: whichever of two same-worktree acquirers checks second sees the other at
# its own name. The one residual is a double yield — both land before either has
# checked — and that is the busy contract both already had: two callers told to
# sleep and retry, neither running. A slot with no `worktree` file never blocks:
# a holder from before this rule existed never claimed one, and treating that
# empty answer as a match would lock the whole host against a lock that has
# nothing to say about worktrees.
#
# A HOLDER PINS ITS SLOT, and only acts on the pinned path. `acquire` writes the
# slot it took into the file named by CF_GATE_SLOT_OUT, the caller reads it back,
# and everything afterwards — the beat, the verify, the release — is handed that
# one path in CF_GATE_SLOT_PATH and asks nobody to search for it. The reason is
# the lock parent: it is ${TMPDIR:-/tmp}, and /tmp is 1777. A scan cannot
# distinguish a real slot from a directory somebody else planted there, and a
# planted one sorts first whenever its name does — at SLOTS>1, a forged
# canonical `cf-gate.lock.1` carrying a slot-2 holder's owner and pid is enough
# to have that holder's callers verify and heartbeat the forgery while its real
# slot goes stale and is reclaimed underneath it. A pin has no such ambiguity:
# it is the path the acquire itself took, and it is checked for PROVENANCE
# before it is touched (a slot must be a directory, NOT a symlink, owned by this
# user) and never for anything else. Callers with no pin — anything that did not
# come from an acquire — still scan, but only over slots that pass those same
# two filters.
#
# The lock is a directory at ${TMPDIR:-/tmp}/cf-gate.lock — or, under
# GATE_LOCK_DIR, at $GATE_LOCK_DIR/gate.lock (see the pool above) — and mkdir is
# the atomic test-and-set, there is nothing else in POSIX sh. It holds six files:
#   owner    the lane id that took it
#   pid      the HOLDER's pid (the shell that runs the locked steps, or `run`)
#   started  epoch second of acquisition
#   beat     epoch second of the last heartbeat
#   worktree the worktree the holder was standing in when it took the slot
#            (see the header: one gate per worktree, and this is what "the same
#            worktree" is compared against — written last because a lock that
#            cannot answer it simply never blocks)
#   project  the repository the holder was standing in, for DISPLAY only: it is
#            what `status` prints so a slot held by another project reads as one,
#            and nothing validates or compares it. Slot validation keys on owner
#            and pid (see slot_is_provenance and MH2's forged-slot rules), and a
#            slot without the file prints `unknown` rather than being rejected —
#            a lock written before this file existed is not a forgery.
# The pid is the HOLDER's, and a holder only holds while it is alive: a lock
# whose recorded pid is gone is reclaimed by the next acquire, so the pid has
# to name a process that outlives the work. It is therefore never guessed.
# `yarn gate` passes its own (gate.sh sets CF_GATE_CALLER_PID) and `run` records
# its own $$, because `run` IS the holder — the one shell that stays alive for
# exactly as long as the command it is holding the lock for. A bare `acquire`
# with no CF_GATE_CALLER_PID can only record this short-lived script, whose pid
# is dead before the caller runs a step, so that call is REFUSED (exit 2,
# naming `run`): the w06 brief template recommended exactly that call, and it
# produced locks that could be reclaimed the moment they were taken (M3). It is
# refused while the lock is held too — "busy" is not an answer to a call that
# cannot name a real holder. Release, verify and heartbeat read the same pid:
# they act only when the lock still names that owner and pid, so a holder whose
# lock was reclaimed can neither delete the replacement nor keep refreshing its
# beat.
#
# acquire judges a held lock in this order, and says so on stdout before it
# reclaims:
#   1. the recorded pid is not alive (`kill -0`)  -> reclaimed;
#   2. the beat is older than 10 minutes          -> reclaimed
#      (CF_GATE_STALE_SECONDS overrides the threshold; the default stays 600);
#   3. otherwise the holder is alive and fresh    -> exit 75.
# A pid can be recycled after a crash, which is exactly why the heartbeat
# exists: a live-looking pid with a stale beat is still reclaimed.
#
# Exit 75 means BUSY, and this script defines that contract: the holder named
# in the lock is alive and its beat is fresh. Sleep and retry; do not remove
# the lock by hand while its holder may still be running. A COMMAND that exits
# 75 is not busy — the busy line above is on stderr and only a holder's own
# refusal prints it, so that line is what tells the two apart.
#
# POSIX sh (not zsh): GitHub Linux runners do not ship zsh, and any test that
# spawns zsh fails in CI. For the same reason there is no $PPID (dash does not
# set it) and no fractional sleep assumption beyond what BSD and GNU sleep both
# accept — the waits below use whole seconds.
#
# Residual races, named honestly: two acquirers that both judge the lock
# reclaimable are arbitrated by `mv` (only one wins the rename; the loser
# re-inspects and eventually exits 75), and creation is atomic (a fully
# written temp directory renamed onto the name), so no half-written lock can
# appear at the name for a contender to misjudge. A reclaimer that renamed a
# lock it did not inspect restores or leaves it rather than deleting it (see
# take_stale). A lock is dev-host machinery; nothing here assumes a filesystem
# more clever than rename.
#
# One gap is left open on purpose, and it is not a race. NOTHING watches the
# heartbeat's own death: kill the pid `run` prints and the loop is simply gone,
# so the beat goes stale, the next acquire reclaims the lock as one whose holder
# has stopped answering for it, and the command carries on running against a
# lock nobody holds until it ends or `run` is signalled. Measured here with
# CF_GATE_HEARTBEAT_SECONDS=1, CF_GATE_STALE_SECONDS=2 and a 20s command, after
# killing the printed pid: the lock was reclaimed 0.7s later under /bin/sh and
# 1.6s under /bin/dash, with `run` and the command both still alive and neither
# aware of it. `run` does close the other direction — a refresh that FAILS stops
# the command at once — because a failure the loop can see is a failure it can
# act on. Closing this one needs a supervisor that outlives the loop, and the
# only pid available to be that supervisor is the one acquire already judges by
# liveness, so a pid-recycled holder would be reported as supervising a lock it
# no longer holds. It is left named rather than half-closed, and gate.sh has the
# same gap.
set -u

# This script's own directory, resolved once. `run` re-invokes it — heartbeat,
# verify, release — from a background subshell, and a command that changes
# directory must not be able to take those invocations with it.
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

BUSY=75

# Where the slots live (LOCK_BASE), how many there are (SLOTS), how stale a beat
# may be (STALE_SECONDS) and which format the pool speaks are ONE decision, and
# they are made in a single block far below — after slot_is_provenance, because
# the check that GATE_LOCK_DIR itself goes through is that same function's: a
# pool directory is judged exactly as a slot is judged, by the same uid seam and
# by the same "[ ! -L ], [ -d ], find … -user" idiom, and it has to be DEFINED
# before it can be used. LOCK and MAX_SLOTS are assigned there too. Nothing
# between here and there reads them: they are only ever read inside functions,
# which the shell does not execute until a subcommand reaches them.

# A slot's path. Slot 0 is unsuffixed so that SLOTS=1 leaves the historical name
# exactly as it was; every later slot is the base plus its number.
slot_path() {
  if [ "$1" -eq 0 ]; then
    printf '%s\n' "$LOCK_BASE"
  else
    printf '%s\n' "$LOCK_BASE.$1"
  fi
}

# Is this path one of the slots? A slot is `cf-gate.lock`, or `cf-gate.lock.<n>`
# where `<n>` is 1..MAX_SLOTS-1 — that is, ONE or TWO digits with no leading
# zero, and no greater than the last slot. Under GATE_LOCK_DIR the base is
# `$GATE_LOCK_DIR/gate.lock`, and the same shape applies there.
#
# Both halves of that are load-bearing, and neither is "digits and nothing else":
#   the shape      is what keeps a slot's own transients out of the slot set:
#                  `cf-gate.lock.1.cand.999`, `cf-gate.lock.1.reclaim.999.x` and
#                  `cf-gate.lock.1.beatnew.999` all start with a digit, so a
#                  `cf-gate.lock.[0-9]*` glob would read them as slots 1 and 1 — a
#                  status that listed a candidate directory as a holder, and a
#                  scan that would happily release or heartbeat one. The staged
#                  beat is the one that has to be right by NAME rather than by
#                  where it lives, because it is written beside the lock (under
#                  TMPDIR by default, inside the pool when GATE_LOCK_DIR is set)
#                  rather than inside the lock directory, so the shape is all
#                  that keeps it out of the slot set;
#   below MAX_SLOTS is what keeps a name nobody could have taken from being acted
#                  on. MAX_SLOTS is a COUNT, so the slots are 0..MAX_SLOTS-1 and
#                  `cf-gate.lock.64` is not one of them even at
#                  CF_GATE_SLOTS=64; `.0` is not slot 0 either (that is the
#                  unsuffixed name), and `.007` is not slot 7. A directory that
#                  is not a slot is not this lock, and a forged one in a 1777
#                  lock parent is exactly what must never be read as a holder's
#                  own.
is_slot_path() {
  case "$1" in
    "$LOCK_BASE")
      return 0
      ;;
    "$LOCK_BASE".*)
      ;;
    *)
      return 1
      ;;
  esac
  slot_suffix=${1#"$LOCK_BASE".}
  case "$slot_suffix" in
    [1-9]|[1-9][0-9])
      ;;
    *)
      return 1
      ;;
  esac
  [ "$slot_suffix" -lt "$MAX_SLOTS" ]
}

# The uid a slot must be owned by before anything here will read it as a
# holder's lock. CF_GATE_TEST_EXPECT_UID overrides it, and is INERT unless it
# carries a value: the expansion is `:-` rather than `-`, so an override that is
# set but EMPTY falls back to this user's own id like one that was never set —
# `find -user ""` matches nothing at all, which would make every slot invisible
# and read as a free host rather than as the seam the caller asked for.
slot_uid=""

# Provenance: is this a lock directory this user actually took? A directory, not
# a symlink, owned by the expected uid — and nothing else counts.
#
# The symlink test comes FIRST and on its own line, because `find` on a symlink
# start point reports the LINK's own owner and never descends: a symlink to a
# directory we own passes `-user` while the thing at the name is somebody else's
# — and a symlink into another user's tree is the cheapest forgery there is,
# since it needs no write access to the lock parent at all beyond the link.
#
# `-prune` is the POSIX spelling of "do not go below this", and it works on GNU
# and BSD find alike: the point is to read the directory's own uid without
# walking a holder's six files (or anything else it may since have grown).
#
# The uid is resolved HERE, into the one `slot_uid` this script caches it in, and
# the pool directory below resolves it the same way — through the same variable
# and the same CF_GATE_TEST_EXPECT_UID seam. They are two copies of three lines
# rather than one shared function, and that is deliberate: it keeps this
# function's text exactly as MH2's manifest anchors it, so the claim that
# provenance is what makes a planted directory unusable is still replayable.
# Change one and the other must change with it.
slot_is_provenance() {
  [ ! -L "$1" ] || return 1
  [ -d "$1" ] || return 1
  if [ -z "$slot_uid" ]; then
    slot_uid="${CF_GATE_TEST_EXPECT_UID:-$(id -u)}"
  fi
  find "$1" -prune -user "$slot_uid" -print 2>/dev/null | grep -q .
}

# ─────────────────────────────────────────────────────────────────────────────
# THE POOL: where the slots live, what format it speaks, and how many it has.
#
# All of it is here, at top level, ONCE per invocation — including for `status`
# and for the heartbeat child `run` re-invokes — because every one of these is a
# property of the pool rather than of the call, and a subcommand that answered
# about a differently-configured pool than the one its acquirer saw would be
# reading a lock it cannot interpret. The block sits after slot_is_provenance
# rather than beside LOCK_BASE because it USES it.
# ─────────────────────────────────────────────────────────────────────────────

# An empty value is an unset one, for all three of the pool's variables: a
# wrapper that exports them unconditionally on a host that has nothing to say
# about them must not be told it is misconfigured.
GATE_LOCK_DIR="${GATE_LOCK_DIR:-}"
GATE_HOST_SLOTS="${GATE_HOST_SLOTS:-}"
GATE_HOST_WORKERS="${GATE_HOST_WORKERS:-}"

# Where the slots live. GATE_LOCK_DIR is the HOST's pool, project-neutral, and
# its slots are named for the pool rather than for a project's TMPDIR; unset is
# today's path, byte for byte, which is what every caller, message and test
# outside this file already names.
#
# The trailing slashes go FIRST, and before LOCK_BASE is built from it, because a
# trailing slash is not a spelling here — it is a way past the checks below. Every
# test that walks to a path ending in `/` RESOLVES the link first: `[ -L
# "$d/link/" ]` is false for a symlink to a directory, and `find "$d/link/"`
# descends through it rather than reporting the link's own owner and mode. So a
# pool named as a symlink plus one slash is judged through its target and
# accepted, and the name is compared with a truth test rather than as a name. The
# one value that cannot be reduced is `/`, which is the filesystem root and not a
# pool anybody may take a slot in.
if [ -n "$GATE_LOCK_DIR" ]; then
  case "$GATE_LOCK_DIR" in
    /*) ;;
    *)
      # A relative path would resolve against whatever directory the caller's
      # command happens to leave it in, and two seats standing in two
      # directories would then be in two pools that cannot see each other — the
      # exact failure GATE_LOCK_DIR exists to remove.
      printf '%s\n' "gate-lock: GATE_LOCK_DIR must be an absolute path: $GATE_LOCK_DIR" >&2
      exit 2
      ;;
  esac
  while :; do
    case "$GATE_LOCK_DIR" in
      ?*/) GATE_LOCK_DIR="${GATE_LOCK_DIR%/}" ;;
      *) break ;;
    esac
  done
  if [ -z "$GATE_LOCK_DIR" ] || [ "$GATE_LOCK_DIR" = "/" ]; then
    printf '%s\n' "gate-lock: GATE_LOCK_DIR must name a pool directory of its own, not the filesystem root: $GATE_LOCK_DIR" >&2
    exit 2
  fi
  LOCK_BASE="$GATE_LOCK_DIR/gate.lock"
else
  LOCK_BASE="${TMPDIR:-/tmp}/cf-gate.lock"
fi

# The slot this invocation is working on. It is slot 0's path until an acquire
# takes another one, and from then on the caller's OWN slot: every read, write
# and message below names this variable, so a holder with SLOTS>1 touches its own
# slot and nothing else.
LOCK="$LOCK_BASE"

# Judge the pool directory before anything else uses it, because everything else
# is a rename INTO it. Two directories are judged: its PARENT, which nothing at
# the leaf can see, and then the pool itself.
#
# `mkdir -m 0700` before the pool's own checks, and the failures of the mkdir are
# swallowed: EEXIST from a concurrent acquirer, from a directory the operator
# made, and from a symlink are all the same situation from here — the name
# exists and the verify is the only thing that can say what it is. Creating it
# first is what makes a missing pool directory a non-event rather than a refusal
# an operator has to answer with a mkdir.
if [ -n "$GATE_LOCK_DIR" ]; then
  # The pool's owner, resolved first: both checks below name it, and a refusal
  # message that carries an empty uid tells the operator nothing about what to fix.
  # It comes through the same cache and the same seam slot_is_provenance fills —
  # see that function for why these three lines are written twice.
  if [ -z "$slot_uid" ]; then
    slot_uid="${CF_GATE_TEST_EXPECT_UID:-$(id -u)}"
  fi
  pool_uid="$slot_uid"
  # The PARENT, judged with the same three questions and refused with the same
  # exit 2, BEFORE anything is created under it. This is the check the header
  # promises and the leaf's own mode cannot do: the pool's 0700 protects the names
  # INSIDE it and nothing about the name itself, which is a directory entry in the
  # parent. A parent another user can write lets that user rename the pool away
  # between one acquirer's mkdir and the next one's rename, onto a directory they
  # own holding a `.format` they wrote and slots they seeded — and by the time
  # anything looks at the pool again it has moved, so nothing at the leaf can say
  # so. It is asked first so that a refusal leaves no directory behind: creating a
  # pool inside a parent nobody may write is not a small thing to undo, and there
  # is nothing to gain by discovering the parent is wrong after doing it.
  #
  # `${GATE_LOCK_DIR%/*}` is the parent, and empty means the root: a pool directly
  # under `/` has no parent but `/`, which is not writable by this user, so it is
  # refused here rather than by a check that has to know it.
  pool_parent="${GATE_LOCK_DIR%/*}"
  [ -n "$pool_parent" ] || pool_parent="/"
  if [ -L "$pool_parent" ] || [ ! -d "$pool_parent" ] ||
    ! find "$pool_parent" -prune -user "$pool_uid" ! -perm -g+w ! -perm -o+w -print 2>/dev/null |
      grep -q .; then
    printf '%s\n' "gate-lock: GATE_LOCK_DIR's parent $pool_parent must be owned by uid $pool_uid and not writable by group or others; it is refused and no lock was taken" >&2
    exit 2
  fi
  mkdir -m 0700 "$GATE_LOCK_DIR" 2>/dev/null || true
  # The mode test is a `find` predicate for the same reason the uid test is:
  # POSIX sh has no portable `stat`, and `test -w` would answer "this user can
  # write it" — which is true for the owner of a world-writable directory, and
  # is exactly the answer that must not be taken here.
  if [ -L "$GATE_LOCK_DIR" ] || [ ! -d "$GATE_LOCK_DIR" ] ||
    ! find "$GATE_LOCK_DIR" -prune -user "$pool_uid" ! -perm -g+w ! -perm -o+w -print 2>/dev/null |
      grep -q .; then
    printf '%s\n' "gate-lock: GATE_LOCK_DIR=$GATE_LOCK_DIR is not a lock directory this user can hold alone — it must exist (its parent must exist too), be a directory, not a symlink, be owned by uid $pool_uid, and be neither group- nor world-writable; it was refused and no lock was taken" >&2
    exit 2
  fi
fi

# The format marker, `1`. Written as a temp file and `ln`ed onto the name
# because link(2) refuses to replace an existing file and that is the portable
# atomic no-replace; `mv -n` is a no-op that reports success on some hosts and a
# rename on others, and on macOS it is not atomic. A `ln` that FAILS is not an
# error: it means somebody else published first, or published before this
# process looked — so the temp file goes away and the answer is read back from
# the name either way. That read-back is the check, and it is what makes two
# acquirers racing into an empty pool a non-event rather than a corrupt marker:
# whichever `ln` lost, both read `1`.
if [ -n "$GATE_LOCK_DIR" ]; then
  format_path="$GATE_LOCK_DIR/.format"
  if [ ! -e "$format_path" ]; then
    format_tmp="$format_path.tmp.$$"
    if printf '1\n' > "$format_tmp" 2>/dev/null; then
      # Test hook (CF_GATE_TEST_PAUSE_BEFORE_FORMAT_LN): between the temp file and
      # the `ln`, and reached only when `.format` is absent, which is the only
      # state in which the two acquirers can overlap at all. Parking it here is
      # what turns "two processes raced" from something a test cannot schedule
      # into a window it holds open on both sides.
      if [ -n "${CF_GATE_TEST_PAUSE_BEFORE_FORMAT_LN:-}" ]; then
        touch "$CF_GATE_TEST_PAUSE_BEFORE_FORMAT_LN" 2>/dev/null
        while [ -f "$CF_GATE_TEST_PAUSE_BEFORE_FORMAT_LN" ]; do sleep 1; done
      fi
      ln "$format_tmp" "$format_path" 2>/dev/null || true
    fi
    rm -f "$format_tmp" 2>/dev/null
  fi
  format_found=$(cat "$format_path" 2>/dev/null)
  # Anything but 1 is refused, including a marker this very process could not
  # read or write: two projects on different lock semantics must never share a
  # pool, and a project that cannot read the marker cannot know whether it can.
  if [ "$format_found" != 1 ]; then
    printf '%s\n' "gate-lock: GATE_LOCK_DIR holds lock format ${format_found:-nothing}; this gate speaks 1" >&2
    exit 2
  fi
fi

STALE_SECONDS="${CF_GATE_STALE_SECONDS:-600}"
case "$STALE_SECONDS" in
  ''|*[!0-9]*)
    printf '%s\n' "gate-lock: CF_GATE_STALE_SECONDS must be a number of seconds: $STALE_SECONDS" >&2
    exit 2
    ;;
esac
# 600s is part of FORMAT 1, not a default anyone may lower: the threshold is
# what every READER judges a foreign holder by, and a pool shared by several
# projects is a pool where one project lowering it reclaims holders belonging to
# the projects that did not — from a lock that is perfectly alive.
if [ -n "$GATE_LOCK_DIR" ] && [ "$STALE_SECONDS" -lt 600 ]; then
  printf '%s\n' "gate-lock: CF_GATE_STALE_SECONDS=$STALE_SECONDS is below the 600s a shared pool requires; every reader judges every other project's holder by this number, so a seat that lowers it reclaims locks that are alive. Set it host-wide, or leave it unset." >&2
  exit 2
fi

# How many slots this host has. Validated exactly like CF_GATE_STALE_SECONDS —
# a value that cannot be a count is a broken invocation whichever subcommand it
# arrived on. The two range tests that follow are separate on purpose, and the
# ceiling is judged FIRST and BY DIGITS, because neither a shell's integer test
# nor a count with more slots than the host has gates for is a report of busy:
#
#   0            is not a host with no gates, it is a host where every caller
#                is silently unprotected  -> exit 2, "at least one slot"
#   1..64        is a host with that many  -> accepted
#   65+          is a broken invocation    -> exit 2, "at most 64 slots"
#   99999…       (20 or 30 digits) is not a comparison any shell can make. `[`
#                answers false and says so — `Illegal number` under dash,
#                `integer expression expected` under bash — so BOTH range tests
#                fall through, the slot loop is entered with a count nothing can
#                bound, and an idle host is reported as `busy` with exit 75 —
#                telling the caller to sleep and retry a host that is not
#                holding anything, forever. So a value of three or more digits
#                is over the ceiling whatever it is, and is answered before any
#                `[` sees it; only a one- or two-digit value (at most 99) is
#                handed to the tests below.
#
# Leading zeros are a SPELLING, not a count, and they are stripped before any of
# that: `064` is sixty-four slots and must be accepted, not read as the
# three-digit value the ceiling test below exists to refuse. Stripping also
# keeps the ceiling test honest for a padded value — `00000000000000065` is
# sixty-five slots, not a number no shell can compare — and the loop keeps at
# least one digit, so `0` and `00` are the "at least one slot" refusal rather
# than an empty string that `[` cannot compare with anything. The refusals name
# the value AS GIVEN (`065`, not `65`): the caller has to be able to find the
# spelling it set wrong in the message about it.
#
# It takes the VARIABLE'S NAME, because CF_GATE_SLOTS and GATE_HOST_SLOTS are
# the same count arriving by two roads and each refusal has to name the one the
# operator actually set.
MAX_SLOTS=64
read_slot_count() {
  slots_name=$1
  slots_given=$2
  case "$slots_given" in
    ''|*[!0-9]*)
      printf '%s\n' "gate-lock: $slots_name must be a number of slots: $slots_given" >&2
      exit 2
      ;;
  esac
  slots_count="$slots_given"
  while :; do
    case "$slots_count" in
      0?*) slots_count="${slots_count#0}" ;;
      *) break ;;
    esac
  done
  case "$slots_count" in
    [0-9][0-9][0-9]*) slots_over_cap=yes ;;
    *)
      slots_over_cap=no
      if [ "$slots_count" -gt "$MAX_SLOTS" ]; then
        slots_over_cap=yes
      fi
      ;;
  esac
  if [ "$slots_over_cap" = yes ]; then
    printf '%s\n' "gate-lock: $slots_name must be at most $MAX_SLOTS slots: $slots_given" >&2
    exit 2
  fi
  if [ "$slots_count" -lt 1 ]; then
    printf '%s\n' "gate-lock: $slots_name must be at least one slot: $slots_given" >&2
    exit 2
  fi
  SLOTS="$slots_count"
}

# GATE_HOST_WORKERS — the host's worker budget — is a positive whole number and
# nothing else. It is NOT bounded by MAX_SLOTS (that ceiling is about slots) and
# it is NOT compared against nproc here either: the thread count this host
# reports and the one a container or a cpuset hands the same kernel are
# different numbers, and refusing a host because its two disagree would stop the
# gate on the very hosts that need it most. The comparison belongs where the
# workers are actually spent — tools/gate/lib/max-workers.ts, which refuses a
# cap above availableParallelism() at config load, naming this variable.
#
# The same digit rule as a slot count, and the same reason: a 30-digit spelling
# is not a comparison `[` can make, and it is judged by its digits before any
# test sees it.
read_host_workers() {
  host_workers_name=$1
  host_workers_given=$2
  case "$host_workers_given" in
    ''|*[!0-9]*)
      printf '%s\n' "gate-lock: $host_workers_name must be a number of workers: $host_workers_given" >&2
      exit 2
      ;;
  esac
  host_workers_count="$host_workers_given"
  while :; do
    case "$host_workers_count" in
      0?*) host_workers_count="${host_workers_count#0}" ;;
      *) break ;;
    esac
  done
  case "$host_workers_count" in
    # Three or more digits is certainly at least one worker, and is not a
    # comparison this shell may make — see read_slot_count for the whole story.
    [0-9][0-9][0-9]*) ;;
    *)
      if [ "$host_workers_count" -lt 1 ]; then
        printf '%s\n' "gate-lock: $host_workers_name must be at least one worker: $host_workers_given" >&2
        exit 2
      fi
      ;;
  esac
  HOST_WORKERS="$host_workers_count"
}

# A count clamped to what `$(( ))` can hold on every POSIX shell, because an
# overflowed arithmetic expansion wraps rather than failing: a host that reports
# more processors than a 32-bit int could name would otherwise answer a slot
# count of whatever the wrapped remainder happened to be. A clamped count is
# still over MAX_SLOTS either way, which is the only thing it is used for.
arithmetic_safe() {
  case "$1" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*) printf '%s\n' 999999999 ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# This host's processor count, read once per invocation and normalised the same
# way every other count here is. `CF_GATE_TEST_NPROC` injects it, because a test
# on a 4-core runner cannot otherwise ask what a 24-core host would derive — and
# getconf is the only portable source there is: nproc(1) is not in POSIX, and
# /proc/cpuinfo is Linux-only.
#
# A value that is not a number is a refusal rather than a guess in both places
# that need it, and the message says which decision wanted it. Inventing a
# processor count would be inventing the host's budget, and a budget nobody wrote
# down is how a host ends up oversubscribed by a factor with no red anywhere.
read_host_nproc() {
  host_nproc="${CF_GATE_TEST_NPROC:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)}"
  case "$host_nproc" in
    ''|*[!0-9]*)
      printf '%s\n' "gate-lock: GATE_HOST_WORKERS=$HOST_WORKERS needs this host's processor count to derive a slot count, and getconf _NPROCESSORS_ONLN printed '$host_nproc'; set GATE_HOST_SLOTS on the host, or unset GATE_HOST_WORKERS to fall back to CF_GATE_SLOTS" >&2
      exit 2
      ;;
  esac
  while :; do
    case "$host_nproc" in
      0?*) host_nproc="${host_nproc#0}" ;;
      *) break ;;
    esac
  done
  HOST_NPROC="$host_nproc"
}

SLOTS=""
PROJECT_SLOTS=""
HOST_SLOTS=""
HOST_SLOTS_SOURCE=""
if [ -z "$GATE_LOCK_DIR" ]; then
  # No pool: today's precedence exactly. The host's variables are not consulted
  # at all, so an operator who has both the old and the new settings exported
  # during the release gets the lock this file has always taken, and gets no
  # refusal for the settings they have not migrated yet.
  read_slot_count CF_GATE_SLOTS "${CF_GATE_SLOTS:-1}"
else
  # The PROJECT's own count is read first and on its own, so that the
  # disagreement below is a comparison of two numbers rather than of two
  # spellings — and so that a value that is not a count is refused as one,
  # whatever the host's variables happen to say about the pool.
  if [ -n "${CF_GATE_SLOTS:-}" ]; then
    read_slot_count CF_GATE_SLOTS "$CF_GATE_SLOTS"
    PROJECT_SLOTS="$SLOTS"
  fi
  if [ -n "$GATE_HOST_WORKERS" ]; then
    read_host_workers GATE_HOST_WORKERS "$GATE_HOST_WORKERS"
    # One host, one worker budget: a per-run cap that differs from the host's is
    # the same disagreement as a slot count that differs, and it costs the same
    # budget. Refused here rather than left to vitest, because the party that can
    # fix it is the one that set the variable, and it is a host-wide value.
    #
    # COMPARED AS NUMBERS, through the same leading-zero strip read_host_workers
    # applies to its own side: `04` is four workers, exactly as read_slot_count
    # says `006` is six slots, and max-workers.ts already accepts `04` as four.
    # A string compare here would refuse two spellings of the same decision —
    # which is the refusal the operator cannot act on, because there is nothing
    # wrong with either value.
    if [ -n "${CF_TEST_MAX_WORKERS:-}" ]; then
      case_max_workers="$CF_TEST_MAX_WORKERS"
      while :; do
        case "$case_max_workers" in
          0?*) case_max_workers="${case_max_workers#0}" ;;
          *) break ;;
        esac
      done
      if [ "$case_max_workers" != "$HOST_WORKERS" ]; then
        # Named AS GIVEN, not normalised: the operator has to be able to find the
        # spelling in the message about it.
        printf '%s\n' "gate-lock: CF_TEST_MAX_WORKERS=$CF_TEST_MAX_WORKERS does not match GATE_HOST_WORKERS=$HOST_WORKERS on a host with GATE_LOCK_DIR set; a run's worker cap and the host's worker budget are one decision, and a seat that disagrees gets a lane running beside a host it cannot see" >&2
        exit 2
      fi
    fi
  fi
  if [ -n "$GATE_HOST_SLOTS" ]; then
    read_slot_count GATE_HOST_SLOTS "$GATE_HOST_SLOTS"
    HOST_SLOTS_SOURCE=GATE_HOST_SLOTS
  elif [ -n "$GATE_HOST_WORKERS" ]; then
    # The derivation, which is a NAMED FALLBACK rather than the way midnight is
    # configured: slots = max(1, nproc / workers), capped at MAX_SLOTS. 24/4 = 6,
    # 24/5 = 4, 3/4 = 1 — the last of which is the point. A host with fewer
    # threads than one worker's worth still gets ONE gate, because a pool with
    # zero slots is a host on which nothing is ever gated.
    read_host_nproc
    HOST_SLOTS=$(( $(arithmetic_safe "$HOST_NPROC") / $(arithmetic_safe "$HOST_WORKERS") ))
    if [ "$HOST_SLOTS" -lt 1 ]; then
      HOST_SLOTS=1
    fi
    if [ "$HOST_SLOTS" -gt "$MAX_SLOTS" ]; then
      HOST_SLOTS="$MAX_SLOTS"
    fi
    SLOTS="$HOST_SLOTS"
    HOST_SLOTS_SOURCE=GATE_HOST_WORKERS
  else
    # Neither host variable: this project's own count, as it has always been, and
    # nothing for it to disagree with.
    read_slot_count CF_GATE_SLOTS "${CF_GATE_SLOTS:-1}"
  fi
  # BOTH counts given: the budget they multiply into has to fit the host. This is
  # the one refusal here that needs no second opinion from anybody's seat, because
  # both numbers are the host's own and their product is checkable against the
  # host's own processors: seven gates of four workers each is 28 runnable
  # workers asked of 24 threads, and the failure mode is not a refusal but tens of
  # gigabytes of RSS and false timeouts on the tests that fail on their own
  # internal deadlines.
  #
  # The product is never computed, because it does not have to be: slots ×
  # workers > nproc is the same question as slots > floor(nproc / workers), and
  # the second one divides two clamped values rather than multiplying them, so a
  # 30-digit spelling on either side cannot overflow the arithmetic into an answer
  # nobody wrote down.
  if [ -n "$HOST_SLOTS_SOURCE" ] && [ "$HOST_SLOTS_SOURCE" = GATE_HOST_SLOTS ] &&
    [ -n "$GATE_HOST_WORKERS" ]; then
    read_host_nproc
    if [ "$SLOTS" -gt $(( $(arithmetic_safe "$HOST_NPROC") / $(arithmetic_safe "$HOST_WORKERS") )) ]; then
      printf '%s\n' "gate-lock: GATE_HOST_SLOTS=$SLOTS with GATE_HOST_WORKERS=$HOST_WORKERS asks for more workers than this host's $HOST_NPROC processors; a pool's slots and a run's workers are one budget, so the two must multiply out to at most the thread count. Lower GATE_HOST_SLOTS, raise GATE_HOST_WORKERS, or unset GATE_HOST_WORKERS and let the slot count be derived from it." >&2
      exit 2
    fi
  fi
  # A project variable that disagrees with the pool's own count is refused, and
  # names both. It is exit 2 and not a preference because the pool is shared: the
  # seat that disagrees does not get a different pool, it gets a seat that
  # believes the host holds fewer gates than it does — and takes one anyway,
  # beside a holder it cannot see. Lock correctness survives the disagreement;
  # the thread budget the two counts multiply into does not.
  if [ -n "$PROJECT_SLOTS" ] && [ -n "$HOST_SLOTS_SOURCE" ] && [ "$PROJECT_SLOTS" != "$SLOTS" ]; then
    printf '%s\n' "gate-lock: CF_GATE_SLOTS=$PROJECT_SLOTS does not match the host's pool, where $HOST_SLOTS_SOURCE gives $SLOTS slots on a host with GATE_LOCK_DIR=$GATE_LOCK_DIR; the count is a property of the host and every project in the pool shares it. Set CF_GATE_SLOTS host-wide to the same number, or unset it and let the host variables decide." >&2
    exit 2
  fi
fi

# Every slot that EXISTS, whatever CF_GATE_SLOTS says — a host whose slots were
# lowered underneath a holder still has that holder's lock, and a caller that
# only looked at 0..N-1 would report the host free while a slot is taken. The
# numbered ones are found by glob and then filtered, because a glob cannot
# express "a slot number and nothing else" and because the lock parent may hold
# anything at all: is_slot_path keeps out the transients and the names no
# acquirer could have produced, and slot_is_provenance keeps out a directory
# that is not this user's lock. Both filters apply to the PINNED path as well
# (see require_trusted_slot), so a scan and a pin agree about what a slot is.
existing_slots() {
  for slot_candidate in "$LOCK_BASE" "$LOCK_BASE".[0-9]*; do
    [ -d "$slot_candidate" ] || continue
    is_slot_path "$slot_candidate" || continue
    slot_is_provenance "$slot_candidate" || continue
    printf '%s\n' "$slot_candidate"
  done
}

# The pinned slot, checked before anything is done to it. A caller that was told
# which slot it took gets THAT one and never a scan (see the header: the lock
# parent may be 1777, and a scan answers whoever planted a name that sorts
# first). The pin is still checked — it is a path in the environment, so it is
# a claim, not a fact: it must be a slot name and it must be a lock directory
# this user owns. A pin that is not exits 2, naming itself, because that is a
# broken invocation rather than a lost lock, and answering it as a lost lock
# would send a live holder's gate down the "lock lost" path.
require_trusted_slot() {
  if ! is_slot_path "$1"; then
    printf '%s\n' "gate-lock: CF_GATE_SLOT_PATH is not a slot on this host: $1" >&2
    exit 2
  fi
  # A pin that is GONE is not a forgery: it is a lock this caller has lost, and
  # the subcommand's own "no lock at …" refusal — exit 1, which every caller
  # above this one already reads as lock lost — is the honest answer for it.
  # Judging provenance of a path that is not there would report a broken
  # invocation for a lock that was simply deleted, and hide the message the
  # holder's cleanup is looking for.
  [ -e "$1" ] || return 0
  if ! slot_is_provenance "$1"; then
    printf '%s\n' "gate-lock: CF_GATE_SLOT_PATH is not a lock directory this user owns: $1 (a slot must be a directory, not a symlink, owned by this user); it was left alone" >&2
    exit 2
  fi
  return 0
}

# The caller's own slot, found by scanning for the owner AND the pid — the same
# pair release demands before deleting anything, so a stale holder whose lock was
# reclaimed finds nothing and no stranger's slot is ever touched. Empty when the
# caller holds no slot.
#
# This is the UNPINNED fallback: a caller that came from an acquire names its
# slot instead (CF_GATE_SLOT_PATH) and never scans, because a scan over a 1777
# lock parent can be answered by a directory somebody planted. It still sees only
# slots that pass both filters, because a forged directory this user owns would
# pass a uid test and a name test just as well as a real one.
caller_slot() {
  slot_found=""
  while IFS= read -r slot_candidate; do
    [ "$(cat "$slot_candidate/owner" 2>/dev/null)" = "$1" ] || continue
    [ "$(cat "$slot_candidate/pid" 2>/dev/null)" = "$recorded_pid" ] || continue
    slot_found="$slot_candidate"
    break
  done <<EOF
$(existing_slots)
EOF
  [ -n "$slot_found" ] || return 1
  printf '%s\n' "$slot_found"
  return 0
}

# The same scan by pid alone, for `heartbeat`: it takes no lane, so the owner is
# not available to match on, and the pid — the holder's own — is what the beat
# belongs to. One pid holds one slot, so the first match is the only match.
#
# "One pid holds one slot" is an invariant this scan CANNOT enforce and acquire
# now enforces instead (see acquire): nothing stops a pid from appearing in two
# lock directories, and when it does, a scan picks whichever sorts first — which
# is precisely how a planted forgery gets itself refreshed. A caller that knows
# its slot pins it; this is only for callers that do not.
pid_slot() {
  slot_found=""
  while IFS= read -r slot_candidate; do
    [ "$(cat "$slot_candidate/pid" 2>/dev/null)" = "$1" ] || continue
    slot_found="$slot_candidate"
    break
  done <<EOF
$(existing_slots)
EOF
  [ -n "$slot_found" ] || return 1
  printf '%s\n' "$slot_found"
  return 0
}

# Does this caller's own pid already hold a slot that is ALIVE and FRESH? One
# slot, printed, or 1. `acquire` refuses on this (see below): one pid holds one
# slot, and a holder that took a second would leave the first with nothing
# refreshing its beat — so the next acquire would reclaim it and this caller
# would carry on running against a lock nobody holds.
#
# Alive AND fresh, both, and not either on its own. A slot whose pid is dead is
# a crashed holder's and the reclaim path is right; a slot whose beat is stale is
# a holder that has stopped answering for it, and the normal reclaim path takes
# it. The third case is the one this exists for: a LIVE holder with a FRESH beat
# and this pid is not a leftover at all, it is this same caller — usually a pid
# the kernel has handed to a new process while the seat that had it was still
# running the old one — and taking another slot on top of it would strand the
# first.
self_held_slot() {
  while IFS= read -r slot_candidate; do
    [ -n "$slot_candidate" ] || continue
    slot_seen_pid=$(cat "$slot_candidate/pid" 2>/dev/null)
    [ "$slot_seen_pid" = "$recorded_pid" ] || continue
    pid_alive "$slot_seen_pid" || continue
    slot_seen_beat=$(cat "$slot_candidate/beat" 2>/dev/null)
    beat_is_stale "$slot_seen_beat" && continue
    printf '%s\n' "$slot_candidate"
    return 0
  done <<EOF
$(existing_slots)
EOF
  return 1
}

# The pid recorded in the lock: the caller's when it says so (gate.sh does,
# and run sets the variable to its own $$ for the sub-commands below), otherwise
# this process. Only acquire can WRITE a lock, and it refuses to do so without
# a caller pid — so the fallback here can only ever be read by release, verify
# and heartbeat, where a pid that matches nobody is a refusal, not a hazard.
recorded_pid="${CF_GATE_CALLER_PID:-$$}"

# The worktree the CALLER is standing in, which is the identity `run` and
# `acquire` hold the lock for: one gate per worktree (see the header).
#
# `git rev-parse --show-toplevel` names the worktree this directory belongs to,
# and `pwd -P` is the answer for a directory that is not in one at all — a
# lane's own scratch, a checkout nobody has initialised. Nothing here changes
# directory, so this is the caller's own cwd: the worktree root for `yarn gate`,
# whatever directory the lane is in for `run`, and — in a linked worktree — that
# worktree's OWN root rather than the main checkout's, because git resolves it
# from where the caller is standing.
#
# Resolved ONCE per acquire, not per slot: it is one answer about one directory,
# and the slot loop would otherwise fork `git` once per pass to learn it again.
caller_worktree() {
  worktree=$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)
  # An empty answer is not an identity. `pwd -P` cannot fail while the shell is
  # running, but git can exit 0 having printed nothing, and a lock that recorded
  # "" would then match every other lock that recorded "" — including the ones
  # that mean nothing by it.
  [ -n "$worktree" ] || worktree=$(pwd -P)
  printf '%s\n' "$worktree"
}

# The project the CALLER is standing in, for DISPLAY only. It is the basename of
# the same answer worktree is: `campaign-foundry` from
# `/…/campaign-foundry`, and in a linked worktree the worktree directory's own
# name, which is the more useful half of the answer for a pool several projects
# share. Nothing validates it and nothing compares it — a slot without the file
# prints `unknown` — so an empty answer is recorded as an empty file rather than
# refused, exactly as a display field should be. It is `${worktree##*/}` rather
# than `basename` because that is the same answer with no fork, and this block
# is resolved once per acquire beside the `git` call it reuses.
caller_project() {
  project="${worktree##*/}"
}

# The first OTHER slot that is in the caller's own worktree and whose holder is
# still answering for it, or 1. Prints the slot; nothing else.
#
# Three filters, and each is one this file already has:
#   existing_slots  so only a canonical slot name this user actually owns is
#                   read at all — a scan answers whoever planted a directory
#                   that happens to carry the right contents;
#   != $LOCK        so the slot this caller JUST won is not its own rival. Its
#                   worktree file is this caller's own, and it is still fresh:
#                   without this every acquire would refuse itself;
#   live AND fresh  `pid_alive` and not `beat_is_stale`, which is the slot loop's
#                   own judgement a few lines below. A holder the loop would
#                   reclaim is not one to yield to — it is not running — and
#                   refusing on it would leave a worktree nobody is gating
#                   unable to gate itself until the corpse is cleared.
#
# A slot with no `worktree` file, or an empty one, matches nothing: a lock from
# before this rule existed never claimed a worktree, and reading its silence as
# agreement would block the whole host against it.
worktree_holder() {
  while IFS= read -r slot_candidate; do
    [ -n "$slot_candidate" ] || continue
    [ "$slot_candidate" = "$LOCK" ] && continue
    slot_seen_worktree=$(cat "$slot_candidate/worktree" 2>/dev/null)
    [ -n "$slot_seen_worktree" ] || continue
    [ "$slot_seen_worktree" = "$worktree" ] || continue
    slot_seen_pid=$(cat "$slot_candidate/pid" 2>/dev/null)
    pid_alive "$slot_seen_pid" || continue
    slot_seen_beat=$(cat "$slot_candidate/beat" 2>/dev/null)
    beat_is_stale "$slot_seen_beat" && continue
    printf '%s\n' "$slot_candidate"
    return 0
  done <<EOF
$(existing_slots)
EOF
  return 1
}

usage() {
  printf '%s\n' "usage: $0 run <lane> -- <command...> | acquire <lane> | release <lane> | verify <lane> | status | heartbeat" >&2
  exit 2
}

pid_alive() {
  case "$1" in
    ''|0|*[!0-9]*)
      # Empty, zero (kill -0 0 would signal the whole process group) or not a
      # number: not a pid we can vouch for.
      return 1
      ;;
  esac
  kill -0 "$1" 2>/dev/null
}

beat_is_stale() {
  case "$1" in
    ''|*[!0-9]*)
      # A beat that cannot be read is as good as stale: the holder writes it
      # during acquire, so its absence past the read-waits means the lock was
      # abandoned mid-write or corrupted.
      return 0
      ;;
  esac
  now=$(date +%s)
  # A future beat (clock stepped between holders) is not stale.
  [ $((now - $1)) -ge "$STALE_SECONDS" ]
}

# mkdir the lock and write it. Creation is atomic: the metadata is written
# into a temp directory first, and `mv` moves the FINISHED directory onto the
# lock name — the rename is the only moment the name exists. A lock without
# metadata can therefore only be one that was abandoned, never one still
# being written: the old mkdir-then-write ordering had exactly that window,
# and a contender that reclaimed the half-written name left its creator
# writing into a directory it no longer owned. The name being held (busy) shows
# up either as a failed `mv` or, since `mv` onto an existing directory moves the
# candidate INTO it and exits 0, as our candidate nested inside the holder's
# lock; both return 1. Returns 0 only if the lock is verifiably ours.
try_create() {
  cand="$LOCK.cand.$$"
  # Our own pid is unique among live processes, so a leftover cand dir with
  # this name can only be a dead attempt's (pids recycle); clear it first.
  rm -rf "$cand" 2>/dev/null
  mkdir "$cand" 2>/dev/null || return 1
  now=$(date +%s)
  printf '%s\n' "$1" > "$cand/owner" 2>/dev/null || { rm -rf "$cand"; return 1; }
  printf '%s\n' "$now" > "$cand/started" 2>/dev/null || { rm -rf "$cand"; return 1; }
  printf '%s\n' "$recorded_pid" > "$cand/pid" 2>/dev/null || { rm -rf "$cand"; return 1; }
  printf '%s\n' "$now" > "$cand/beat" 2>/dev/null || { rm -rf "$cand"; return 1; }
  # The fifth file, and the one `worktree_holder` reads. Written inside the
  # candidate like the rest, so it appears at the name with the rename and never
  # before: a slot that exists is a slot whose worktree is already known, which
  # is what lets the check after this decide on it without a second wait.
  printf '%s\n' "$worktree" > "$cand/worktree" 2>/dev/null || { rm -rf "$cand"; return 1; }
  # The sixth file, and the only one nothing judges: `status` prints it so a slot
  # held by another PROJECT in a shared pool reads as such, which is the whole
  # question an operator has when the pool is the host's rather than their own.
  # It is written inside the candidate like the rest, so a slot that exists has
  # already answered it.
  printf '%s\n' "$project" > "$cand/project" 2>/dev/null || { rm -rf "$cand"; return 1; }
  # Test hook (CF_GATE_TEST_PAUSE_BEFORE_MV): a pause point between the fully
  # written temp directory and the rename, so a test can prove no partial
  # lock ever appears at the name and can race a contender in.
  if [ -n "${CF_GATE_TEST_PAUSE_BEFORE_MV:-}" ]; then
    touch "$CF_GATE_TEST_PAUSE_BEFORE_MV" 2>/dev/null
    while [ -f "$CF_GATE_TEST_PAUSE_BEFORE_MV" ]; do sleep 1; done
  fi
  if mv "$cand" "$LOCK" 2>/dev/null; then
    # `mv` onto an EXISTING directory does not rename over it: it moves the
    # candidate INTO it and exits 0. That happens on every attempt at a busy
    # slot (acquire always tries the create first), so it is checked before
    # anything else, and our candidate — this caller's own `.cand.<pid>` name,
    # never a contender's — is taken back out of the holder's lock. Left there,
    # every busy retry would add one more directory to someone else's lock. It
    # is also the only way to tell this apart from a win when the lock already
    # names our own pid (a recycled pid taking back its own stale slot).
    if [ -d "$LOCK/${cand##*/}" ]; then
      rm -rf "${LOCK:?}/${cand##*/}" 2>/dev/null
      return 1
    fi
    # Read-back: the name holds OUR metadata — a rename cannot have replaced
    # a non-empty directory, so nothing could have taken the name in between.
    [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$recorded_pid" ] || return 1
    return 0
  fi
  rm -rf "$cand"
  return 1
}

# Move a judged-stale lock aside and delete it — but only the lock that was
# judged. `mv` is the arbitration: two concurrent reclaimers cannot both win
# the rename, and an acquirer that recreated the name in between makes our mv
# fail — the loop re-inspects. The verification closes the subtler race: a
# fresh lock that replaced the stale one between the inspection (above) and
# this rename. After the move, the moved directory's owner, pid and beat must
# still be the ones that were judged stale; anything else is a lock that was
# never judged — a fresh holder's — and it is NEVER deleted: it is renamed
# back when the name is still free, and left aside when it is not (its
# holder's heartbeat then fails, and whoever now holds the name is
# re-inspected by the loop).
take_stale() {
  judged_owner="${1:-}"
  judged_pid="${2:-}"
  judged_beat="${3:-}"
  # The pass suffix keeps a copy left aside by an earlier pass from blocking
  # this pass's rename (a directory rename onto a non-empty name fails).
  aside="$LOCK.reclaim.$$.${4:-x}"
  if ! mv "$LOCK" "$aside" 2>/dev/null; then
    return 1
  fi
  moved_owner=$(cat "$aside/owner" 2>/dev/null)
  moved_pid=$(cat "$aside/pid" 2>/dev/null)
  moved_beat=$(cat "$aside/beat" 2>/dev/null)
  if [ "$moved_owner" = "$judged_owner" ] &&
    [ "$moved_pid" = "$judged_pid" ] &&
    [ "$moved_beat" = "$judged_beat" ]; then
    rm -rf "$aside"
    return 0
  fi
  # Test hook (CF_GATE_TEST_PAUSE_BEFORE_RESTORE): between the move-aside and
  # the restore attempt, for the test that takes the name in that window.
  if [ -n "${CF_GATE_TEST_PAUSE_BEFORE_RESTORE:-}" ]; then
    touch "$CF_GATE_TEST_PAUSE_BEFORE_RESTORE" 2>/dev/null
    while [ -f "$CF_GATE_TEST_PAUSE_BEFORE_RESTORE" ]; do sleep 1; done
  fi
  if [ ! -d "$LOCK" ] && mv "$aside" "$LOCK" 2>/dev/null; then
    printf '%s\n' "gate-lock: reclaim aborted — the renamed lock is not the one that was judged stale; restored it at $LOCK" >&2
    return 1
  fi
  printf '%s\n' "gate-lock: reclaim aborted — the renamed lock is not the one that was judged stale; the name is taken, the moved copy is left at $aside and never deleted" >&2
  return 1
}

busy_exit() {
  printf '%s\n' "gate-lock: busy — held by ${1:-unknown} (pid ${2:-?}, beat ${3:-?}) at ${4:-$LOCK}; 75 means busy: sleep and retry, never remove the lock by hand" >&2
  exit $BUSY
}

# Give a slot back — but only while it is still THIS invocation's.
#
# `rm -rf` on a path is a statement about the NAME, not about the directory this
# process created, and both of acquire's give-backs are reached after the name
# could have moved on. A contender that judged the slot dead and took it in the
# window has its replacement deleted by an acquire that had already been
# refused, so the refused caller takes out a lock it never held and never named.
# That window is real and this lane's own neighbour found it: MH5's acquire
# window is gate.sh TERMed while the acquire child carries on, so the recorded
# caller pid is gone mid-acquire and the very next contender judges the slot
# reclaimable on its first pass.
#
# So the same contract release uses (see release) applies here: re-read owner
# and pid, remove only while both are still this invocation's, and otherwise
# leave whatever is at the name completely alone. A holder that lost its lock can
# neither delete the replacement nor keep it.
#
# Always returns 0, and changes no exit code. Both callers are about to exit 75
# or 2 regardless — the caller does not get a slot out of this either way — and
# a removal declined here means the name belongs to a contender now, which is
# the right place for it and is visible in `status`. Silent by design: the
# refusal that brought us here has already said why we are leaving.
give_back_slot() {
  if [ "$(cat "$LOCK/owner" 2>/dev/null)" != "$lane" ]; then
    return 0
  fi
  if [ "$(cat "$LOCK/pid" 2>/dev/null)" != "$recorded_pid" ]; then
    return 0
  fi
  rm -rf "$LOCK" 2>/dev/null
  return 0
}

# The same 75, for a host that HAS room and must not be used anyway: another
# live holder is gating the very tree this caller is standing in. It names the
# holder, the slot it holds, and the worktree they share, because `busy` on its
# own sends a caller looking for a full host — sleeping and retrying a host that
# will never be free for it, for as long as that holder runs — rather than for a
# second gate beside it in its own checkout.
same_worktree_exit() {
  holder_owner=$(cat "$1/owner" 2>/dev/null)
  holder_pid=$(cat "$1/pid" 2>/dev/null)
  holder_beat=$(cat "$1/beat" 2>/dev/null)
  printf '%s\n' "gate-lock: busy — same worktree: $worktree is already gated by ${holder_owner:-unknown} (pid ${holder_pid:-?}, beat ${holder_beat:-?}) at $1; 75 means busy: sleep and retry, never remove the lock by hand" >&2
  exit $BUSY
}

# acquire WRITES a lock, so it needs a pid that will still be alive while the
# work it protects runs. With no CF_GATE_CALLER_PID the only pid on offer is
# this script's own, and that process is gone before the caller has run a step:
# the lock is reclaimable at once, the caller is told it succeeded, and the
# second lane to arrive takes the name (M3 — this call is what the w06 brief
# template recommended, and it is how one lane reclaimed another's lock
# mid-run). Refusing is the only honest answer, and the message names the
# subcommand that does the job instead.
require_caller_pid() {
  if [ -n "${CF_GATE_CALLER_PID:-}" ]; then
    return 0
  fi
  printf '%s\n' "gate-lock: acquire without CF_GATE_CALLER_PID is refused — the only pid it could record is this script's own, which exits before the lock does, so the lock is reclaimable the moment it is taken. Lock a command instead: $0 run <lane> -- <command>" >&2
  exit 2
}

# Take ONE slot, trying them in order: the first free one wins, and a slot whose
# holder is alive and fresh is not this caller's business — it hands over to the
# next slot rather than exiting, which is the whole difference between a
# semaphore and a mutex. Only a caller that has run out of slots is busy.
#
# Everything the judgement needs is per slot: the pass counter (so five passes
# without winning a NAME is still five passes on that slot, not five spread over
# the host), the reclaim, and the pause hook the reclaim races through. At
# SLOTS=1 the outer loop runs once and the PATH it names and the exit codes are
# exactly what a single-slot host produced before slots existed — the lock is
# still `cf-gate.lock` unsuffixed, which is what D188 stamps, and 0/2/75 mean
# what they always meant. Four messages did gain a suffix, naming the slot path
# where they used to name `cf-gate.lock` in prose: `acquired by … at $LOCK`,
# `busy — … at $LOCK`, `released by … from $LOCK` and status' `slot $LOCK held
# by`. Nothing consumes a whole line of those — the tests match the part before
# the path — and a message that says which slot it means is worth more at
# SLOTS>1 than byte-equality with a message that could only ever be about slot 0.
#
# Before the slot loop, one refusal that is not about the host at all: a call
# whose own pid already holds a live, fresh slot (self_held_slot above). That is
# a caller that would end up holding two, and the first one's beat has nothing
# left to refresh it, so it is reclaimed from under it while it works. Exit 2,
# not 75 — the host is not busy, this caller is (see the header on which answer
# belongs where). A same-pid slot with a STALE beat is left to the normal path,
# which reclaims it: that is a pid the kernel has since handed to somebody else,
# and refusing on it would deadlock its own owner into waiting for a holder that
# is not answering.
#
# A SAME-WORKTREE REFUSAL happens here too, and is the one 75 that is not about
# the host having no room left: this caller has just won a slot and is giving it
# straight back because a live holder is gating the tree it is standing in. It is
# 75 and not 2 because the host is not broken and the caller is not wrong — it
# is another caller, doing the same work in the same place, and the answer is the
# same sleep and retry. See the header for why it is any other slot and not only
# a lower one.
#
# On success the slot taken is written to CF_GATE_SLOT_OUT, when that is set. It
# is how the caller learns which slot it got instead of guessing it, and it is
# what its heartbeat, verify and release are pinned to (see the header). A
# caller that cannot be told is given nothing: the lock is given back rather
# than left held by a holder nobody can pin.
acquire() {
  lane=$1
  if self_held=$(self_held_slot); then
    printf '%s\n' "gate-lock: acquire refused — pid $recorded_pid already holds $self_held with a live holder and a fresh heartbeat (beat $(cat "$self_held/beat" 2>/dev/null)); one pid holds one slot, and a second would leave the first unrefreshed and reclaimable under this caller" >&2
    exit 2
  fi
  # The worktree this caller is in, once, before the loop — see caller_worktree.
  # Every slot it could take is the same caller's, so this is one answer asked
  # once rather than a fork per pass.
  worktree=$(caller_worktree)
  # The display name of the same tree, resolved once beside it — see
  # caller_project. `try_create` writes it into every slot this caller takes, and
  # nothing reads it back to make a decision.
  caller_project
  # No identity, no lock — fail CLOSED, and before the slot loop, so nothing has
  # been taken and nothing has to be given back. `caller_worktree` asks git and
  # then `pwd -P`, and both can come back empty: the cwd has been deleted or
  # become unreachable underneath this process, which is a real shape here rather
  # than a theory (MH5's acquire window is a gate TERMed mid-acquire, and a
  # directory removed under a running shell is one `rmdir` away).
  #
  # Recording "" instead is the one answer that silently disarms the rule: an
  # empty worktree file matches nothing in worktree_holder, so this holder would
  # be invisible to the very next acquire from the same directory, and two gates
  # in one worktree would each hold a slot — which is the whole defect this lane
  # closed. Exit 2, not 75: the host is not busy and retrying will not help
  # while the caller's own directory is gone.
  if [ -z "$worktree" ]; then
    printf '%s\n' "gate-lock: cannot determine the caller's worktree — the caller's directory is gone or unreadable, so no lock was taken (a lock with no worktree cannot be compared and would not be seen by the next acquire)" >&2
    exit 2
  fi
  slot_no=0
  busy_owner=""
  busy_pid=""
  busy_beat=""
  busy_slot=""
  while [ "$slot_no" -lt "$SLOTS" ]; do
    LOCK=$(slot_path "$slot_no")
    pass=0
    while :; do
      pass=$((pass + 1))
      if try_create "$lane"; then
        # One gate per worktree, decided HERE, and for two reasons in one place.
        # After try_create's read-back, so the slot is certainly this caller's:
        # the scan is over every slot that is canonical and this user's, and it
        # skips this one by path. Before the pin is written below, so a slot
        # given back here is never a pin the caller — or a cleanup fallback
        # reading one — can heartbeat, verify or release.
        #
        # And before the "acquired by" line as well, which is the same point on
        # stdout: a caller that reads that line believes it holds a slot, and on
        # this path it no longer does. The busy line below is the whole truth.
        if same_worktree_slot=$(worktree_holder); then
          # Test hook (CF_GATE_TEST_PAUSE_BEFORE_SAME_WORKTREE_RM): between the
          # scan and the give-back, which is the window the name can be taken in
          # and the give-back can then delete the taker. Parking it is the only
          # way to hit that window on purpose: the scan and the removal are
          # microseconds apart, and a test that raced them would be racing luck.
          if [ -n "${CF_GATE_TEST_PAUSE_BEFORE_SAME_WORKTREE_RM:-}" ]; then
            touch "$CF_GATE_TEST_PAUSE_BEFORE_SAME_WORKTREE_RM" 2>/dev/null
            while [ -f "$CF_GATE_TEST_PAUSE_BEFORE_SAME_WORKTREE_RM" ]; do sleep 1; done
          fi
          give_back_slot
          same_worktree_exit "$same_worktree_slot"
        fi
        printf '%s\n' "gate-lock: acquired by $lane (pid $recorded_pid) at $LOCK"
        if [ -n "${CF_GATE_SLOT_OUT:-}" ]; then
          if ! printf '%s\n' "$LOCK" > "$CF_GATE_SLOT_OUT" 2>/dev/null; then
            give_back_slot
            printf '%s\n' "gate-lock: acquire — cannot record the slot taken in $CF_GATE_SLOT_OUT; the lock is given back rather than left held by a caller that cannot pin it" >&2
            exit 2
          fi
        fi
        return 0
      fi
      pid=$(cat "$LOCK/pid" 2>/dev/null)
      beat=$(cat "$LOCK/beat" 2>/dev/null)
      owner=$(cat "$LOCK/owner" 2>/dev/null)
      # Creation is atomic, so a lock without pid or beat cannot be mid-write —
      # it is abandoned (or the filesystem is failing). Re-read instead of
      # judging on the first pass anyway, bounded: an abandoned one is reclaimed
      # at pass 3. The second wait covers a pid present but beat missing — a
      # live holder always has a beat, so that too reads as abandoned.
      if [ -z "$pid" ] && [ -z "$beat" ] && [ "$pass" -lt 3 ]; then
        sleep 1
        continue
      fi
      if [ -n "$pid" ] && pid_alive "$pid" && [ -z "$beat" ] && [ "$pass" -lt 3 ]; then
        sleep 1
        continue
      fi
      if [ -n "$pid" ] && pid_alive "$pid" && ! beat_is_stale "$beat"; then
        # Remember the FIRST busy holder, which is the one a caller retrying
        # wants named, and try the next slot.
        if [ -z "$busy_slot" ]; then
          busy_owner="$owner"
          busy_pid="$pid"
          busy_beat="$beat"
          busy_slot="$LOCK"
        fi
        break
      fi
      if [ "$pass" -ge 5 ]; then
        # Five passes without winning the name: someone else is reclaiming it.
        # This slot is not available to us either — try the next one.
        if [ -z "$busy_slot" ]; then
          busy_owner="$owner"
          busy_pid="${pid:-none}"
          busy_beat="${beat:-none}"
          busy_slot="$LOCK"
        fi
        break
      fi
      if [ -n "$pid" ] && pid_alive "$pid"; then
        printf '%s\n' "gate-lock: reclaiming — owner ${owner:-unknown} (pid $pid) has a stale or missing heartbeat (beat ${beat:-missing}, threshold ${STALE_SECONDS}s) at $LOCK"
      else
        printf '%s\n' "gate-lock: reclaiming — owner ${owner:-unknown} (pid ${pid:-none}) is not alive at $LOCK"
      fi
      # Test hook (CF_GATE_TEST_PAUSE_AFTER_INSPECT): a pause between judging
      # the lock stale and moving it, so a test can replace the lock in that
      # window and prove the reclaimer never deletes a lock it did not judge.
      if [ -n "${CF_GATE_TEST_PAUSE_AFTER_INSPECT:-}" ]; then
        touch "$CF_GATE_TEST_PAUSE_AFTER_INSPECT" 2>/dev/null
        while [ -f "$CF_GATE_TEST_PAUSE_AFTER_INSPECT" ]; do sleep 1; done
      fi
      take_stale "$owner" "${pid:-}" "${beat:-}" "$pass"
    done
    slot_no=$((slot_no + 1))
  done
  # Every slot is held by a live, fresh holder. That is the one answer that is
  # 75: the host has no room left, and the first holder found is the one to wait
  # for — the last slot tried would be a worse answer, because it is the newest
  # and least likely to be the one that frees up first.
  busy_exit "$busy_owner" "$busy_pid" "$busy_beat" "$busy_slot"
}

# Hand a signal to the command and leave through the EXIT trap, which is what
# releases the lock. Forwarding is the whole reason the command is a BACKGROUND
# job: a trap on a foreground child does not run until that child exits (dash
# defers it for the full `sleep 30`, measured on this repo's runners' shell),
# so a `run` waiting on a foreground command would keep its lock for as long as
# the command refused to stop — the opposite of what the signal asked for.
# Exiting 130/143 (not the command's own status) is what keeps the two apart
# for a caller: the command is gone, and the lock is on its way out too.
#
# BOTH traps send TERM; the two exit codes are what tells the caller which
# signal it was. `kill -INT` is not sent because it could not work: with job
# control disabled, POSIX 2.11 (Shell Execution) has the child of an
# asynchronous list start with SIGINT and SIGQUIT set to SIG_IGN, and the child
# keeps that disposition — so under `"$@" &` a `sh` command ignores INT
# outright and only a command that resets its own handlers (node does) is
# reachable by it. Measured here, one shell, one instant: the same `kill -INT`
# left the sh child alive and killed the node child. A forwarded INT therefore
# gave the worst possible answer — `run` exited 130, released the lock, and left
# `sh scripts/verify-manifests.sh` mutating the tree with no holder left and no
# signal left to forward to it. TERM is not on that list, so it is the one
# signal that reaches every command `run` can be given.
#
# `set -m` is NOT the way out of that: it would put the command in its own
# process group, so the Ctrl-C the tty driver sends to the foreground group
# would no longer reach the command either, and the job-control output it
# prints would interleave with the command's own.
#
# A SECOND signal, arriving while the wait below is still running, is the one
# case that used to cost the lock, and the two shells answered it differently
# enough that neither answer could be described as "the signal is handled".
# Measured here — one command that catches TERM and takes 2s to tear down, two
# TERMs 500ms apart, /bin/sh (bash 3.2) and /bin/dash:
#   bash DEFERS the second TERM and re-enters this handler at exit, after the
#   command has been reaped. `wait` then has no child left (`wait: pid N is not
#   a child of this shell`) and the `exit 143` runs without ever entering the
#   EXIT trap. Observed 6 times in 6: exit 143, no "released by", the lock left
#   at the name with all of its files, and the heartbeat still looping
#   under a pid that had died — a lock the next acquire reclaims on pid-death
#   and an orphan refreshing a dead holder's beat. A CI timeout that sends TERM
#   twice is exactly that.
#   dash re-enters at once, re-sends TERM, and leaves through the EXIT trap.
# A second INT is a third answer: bash DROPS it and never re-enters, so INT was
# already safe on its own — which is why the note that used to sit here, "bash
# does not re-enter this trap while it is running, so a second INT/TERM is
# dropped", was half right and read as though both signals were covered.
#
# So the second signal is ignored here, in BOTH shells, deliberately
# (`trap '' INT TERM`, below). Answering it again is the only thing this
# handler can do that is worse than doing nothing: under bash it re-enters with
# the command already reaped, and the one job left — leaving through the EXIT
# trap so the lock goes — is precisely the job it cannot do any more. Ignoring
# is the answer that cannot skip the cleanup. The cost is that nothing outside
# can break the wait any more, not even a second TERM, so `kill -9` on the
# command or on this pid is the way out of a command that will not stop: the
# former unwinds cleanly, the latter leaves a lock the next acquire reclaims as
# a dead pid.
forward_signal() {
  trap '' INT TERM
  if [ -n "$cmd_pid" ]; then
    kill -TERM "$cmd_pid" 2>/dev/null
    # And WAIT for it, here, before the lock goes with it. A signalled command
    # is not a dead one: a TERM'd vitest is still tearing down, and the lock
    # exists to stop the next lane's command from running beside it. Killing
    # and exiting in the same breath handed the name on while the command was
    # still writing to the tree.
    #
    # The wait is a real wait, with no timeout, and that is deliberate: a
    # command that will not stop keeps the lock, which is what a lock is for.
    # INT and TERM are both ignored from here on (see above), so the wait ends
    # when the command ends and on nothing else.
    wait "$cmd_pid" 2>/dev/null
  fi
  exit "$2"
}

# The one exit path for `run`, on the command's status, on a signal and on a
# failed acquire alike. The lock is released only when it still names this pid,
# so a replacement is never deleted — but a lock that could NOT be released is
# reported and makes the run non-zero: a command that finished against a lock
# nobody can prove was dropped is not a run that succeeded.
run_cleanup() {
  status=$?
  # Ignore a second signal until the lock has been released, and clear the EXIT
  # trap FIRST so nothing re-enters this function while it runs. The order is
  # the whole fix, and the previous order (`trap - INT TERM EXIT`) was a bug: it
  # restored the DEFAULT disposition, undoing the `trap '' INT TERM` that
  # forward_signal had just installed, so a second TERM arriving during the
  # cleanup killed this shell outright — before `release`, with the lock still at
  # the name. Measured here with one refresh parked in
  # CF_GATE_TEST_PAUSE_BEFORE_BEAT_MV, a TERM, and a second TERM 0.5s later:
  # exit 143, no "released by" line, and the lock left at the name with all
  # of its files, under /bin/sh AND /bin/dash. A CI timeout that sends TERM
  # twice is exactly that. Nothing outside can break the cleanup any more, and
  # `kill -9` on this pid remains the way out of a command that will not stop.
  trap - EXIT
  trap '' INT TERM
  if [ -n "$run_hb_pid" ]; then
    # Kill the heartbeat loop and reap it, so nothing outlives `run` by even
    # a moment. Its stdio was detached when it started, so the `sleep` it is
    # in the middle of holds nothing open when the subshell is orphaned.
    kill "$run_hb_pid" 2>/dev/null
    wait "$run_hb_pid" 2>/dev/null
    run_hb_pid=""
  fi
  if [ -n "$HB_FAILED" ]; then
    rm -f "$HB_FAILED" 2>/dev/null
  fi
  held=$lock_held
  lock_held=0
  # Drop the lock whenever this run may have taken one, NOT only when it knows
  # it did. A signal can land between the acquire that created the lock and the
  # assignment that records it, and skipping the release there leaves a lock
  # whose only possible releaser is the process that just died.
  #
  # `lock_held` is still 0 in two other cases, and both must leave the holder's
  # lock alone: an acquire that was refused as busy, where the lock names
  # someone else and belongs to a run that is still working, and a signal that
  # arrived before any lock existed. Asking first is what keeps a busy exit
  # from reporting "release refused" for a lock it never took — and the release
  # itself re-checks owner and pid, so a lock reclaimed between the question
  # and the answer is still refused rather than deleted.
  if [ "$held" -eq 1 ] || lock_is_ours "$lane"; then
    if ! release "$lane"; then
      lock_lost=1
    fi
  fi
  if [ "$lock_lost" -eq 1 ]; then
    printf '%s\n' "gate-lock: FAILED to release the lock — it may still be held at $LOCK, or another holder has it now" >&2
    if [ "$status" -eq 0 ]; then
      status=1
    fi
  fi
  exit "$status"
}

# Hold the lock around one command, as the command's own holder. Everything a
# gate needs to be correct about concurrency, in one call: the lock is taken
# before the command starts, a heartbeat keeps it fresh while the command runs,
# the command's own exit code is this one's, and INT is forwarded as TERM so
# both signals stop the command. The lock outlives the command in every exit —
# including a signalled one, where the command is reaped before the name is
# handed on.
#
# There is no capture: the command inherits this script's stdout and stderr
# unchanged, because a gate that buffered a failing test run would report it
# late and the exit code would be the only thing that arrived. It is invoked as
# "$@", never eval, so quoting survives and a `--` inside the command is just
# one of its arguments. Backgrounded, so its stdin is /dev/null; the commands
# this wraps (a test run, a mutate replay, a manifest verification) read none.
run_locked() {
  lane=$1
  shift
  [ $# -ge 1 ] || usage
  # The separator is the ONLY thing the lane may be followed by. It used to be
  # searched for, which meant everything before it was shifted away in
  # silence: `run lane-a extra -- cmd one two` started `cmd` with `two` and
  # reported success. A run that does not look like the usage is a usage error
  # rather than a guess, because a silently dropped argument is a command that
  # runs with less than the caller asked for — and the caller is a lane that
  # cannot see it.
  [ "$1" = "--" ] || usage
  shift
  [ $# -ge 1 ] || usage
  HB_SECONDS="${CF_GATE_HEARTBEAT_SECONDS:-60}"
  case "$HB_SECONDS" in
    ''|*[!0-9]*)
      printf '%s\n' "gate-lock: CF_GATE_HEARTBEAT_SECONDS must be a number of seconds: $HB_SECONDS" >&2
      exit 2
      ;;
  esac
  # A number, but not an interval. `sleep 0` returns immediately, so a zero here
  # is not a fast heartbeat — it is no sleep at all: a loop forking a shell per
  # iteration to write a beat carrying the same second-resolution value over
  # and over. Measured over three seconds of one run, 619 events in the lock
  # directory at 0 against 6 at the intended one-second tick.
  if [ "$HB_SECONDS" -lt 1 ]; then
    printf '%s\n' "gate-lock: CF_GATE_HEARTBEAT_SECONDS must be at least one second: $HB_SECONDS" >&2
    exit 2
  fi
  # This process, whatever CF_GATE_CALLER_PID says: an inherited pid belongs to
  # whatever launched this script, and that is free to exit while the command
  # runs. Traps go on BEFORE the acquire, so the window between holding a lock
  # and being ready to release it is not a signal-shaped hole.
  recorded_pid=$$
  run_hb_pid=""
  cmd_pid=""
  lock_held=0
  lock_lost=0
  # An inherited pin belongs to whatever launched this script — a previous
  # holder's, or a stranger's — and `run` is about to take its own slot. Cleared
  # before the acquire so nothing here can act on a pin this run did not earn.
  #
  # `unset`, not an assignment to "": an EXPORTED CF_GATE_SLOT_PATH stays exported
  # when it is assigned to, so `run`'s own slot — set below — would travel into
  # the command under the lock, and every process that command starts with it.
  # Unsetting drops the export attribute as well as the value, which is what
  # "deliberately NOT exported" below actually takes.
  unset CF_GATE_SLOT_PATH
  # Empty until the heartbeat has a marker to write; `set -u` is on, and the
  # cleanup below reads it on every exit, including the ones that happen before
  # the heartbeat exists.
  HB_FAILED=""
  trap run_cleanup EXIT
  trap 'forward_signal INT 130' INT
  trap 'forward_signal TERM 143' TERM
  acquire "$lane"
  # The slot this run holds IS the path acquire left in $LOCK — it is not searched
  # for again, and nothing here asks. That is the whole point of pinning: at
  # SLOTS>1 the holder's own heartbeat, verify and release would otherwise scan a
  # lock parent that may be 1777, and a directory planted there with this run's
  # pid in it can be answered by whichever name sorts first. This variable is
  # what the heartbeat child below is given and what this run's own verify and
  # release act on; it is deliberately NOT exported, so the command under the lock
  # does not inherit a claim to somebody's lock.
  CF_GATE_SLOT_PATH="$LOCK"
  # A busy acquire exits here, before the command exists at all.
  # Test hook (CF_GATE_TEST_PAUSE_AFTER_ACQUIRE): between the acquire that
  # created the lock and the assignment that records it as held, so a test can
  # signal `run` in exactly that window and prove the lock is released anyway.
  if [ -n "${CF_GATE_TEST_PAUSE_AFTER_ACQUIRE:-}" ]; then
    touch "$CF_GATE_TEST_PAUSE_AFTER_ACQUIRE" 2>/dev/null
    while [ -f "$CF_GATE_TEST_PAUSE_AFTER_ACQUIRE" ]; do sleep 1; done
  fi
  lock_held=1
  # Where the heartbeat records that the lock went, for the foreground to find.
  # A dead loop is a zombie its own parent's kill -0 reports as alive, so the
  # marker is the only way the foreground learns it stopped (as in gate.sh).
  HB_FAILED="${TMPDIR:-/tmp}/cf-gate.hbfailed.$$"
  # The command starts BEFORE its heartbeat, which is the order that lets the
  # loop stop it: the loop needs the command's pid, and the beat is already
  # fresh from the acquire, so nothing is unprotected by the milliseconds this
  # costs.
  "$@" &
  cmd_pid=$!
  (
    # A refresh in flight is never left half-finished, because the rename it
    # ends with lands INSIDE the lock directory. Measured over 200 one-second
    # runs on this host: 13 under /bin/sh, 18 under /bin/dash, every one of them
    # a false "release failed — could not remove … Directory not empty", a lock
    # left behind, and a non-zero exit for a command that had succeeded.
    #
    # The wait below is what closes it, and it closes it by construction rather
    # than by luck. A refresh is a FOREGROUND child here, and a trap on a
    # foreground child does not run until that child exits, so a TERM that
    # arrives mid-refresh is deferred until the refresh has finished: the loop
    # only exits once no `sh gate-lock.sh heartbeat` of its own is still
    # running, and `run`'s cleanup waits for this loop before it removes the
    # lock. By the time that removal starts there is nothing in flight that can
    # land in the directory it is removing.
    #
    # The sleep is backgrounded and waited for so the trap still fires AT ONCE
    # when the signal lands during it. A foreground sleep would defer a TERM
    # for up to the whole interval, and a heartbeat that ignored its first TERM
    # for a minute is one the next acquire has already judged stale. The trap
    # kills that sleep on its way out, so the early exit leaves no orphan
    # holding a pid.
    hb_sleep=""
    trap - INT EXIT
    trap 'kill "$hb_sleep" 2>/dev/null; exit 0' TERM
    while :; do
      sleep "$HB_SECONDS" &
      hb_sleep=$!
      wait "$hb_sleep"
      # Ownership-checked on the lock side: the heartbeat refreshes only a lock
      # that still names this pid ($$ is this shell's even inside the subshell),
      # so a lock reclaimed under us is never refreshed on its way past, and
      # the loop dies rather than keeping someone else's lock alive. It is also
      # PINNED to the slot this run took, so the refresh cannot land on a
      # different lock that happens to carry the same pid.
      if ! CF_GATE_CALLER_PID=$$ CF_GATE_SLOT_PATH="$CF_GATE_SLOT_PATH" \
        sh "$HERE/gate-lock.sh" heartbeat >/dev/null 2>&1; then
        # A failed refresh means the lock is GONE or is someone else's — the
        # refresh is ownership-checked, so it fails after a reclaim, never
        # before one. Either way the command is now running with no lock behind
        # it, and the foreground is blocked in `wait` where it cannot see any of
        # this. So the loop stops the command itself: leaving it running is
        # exactly what the heartbeat exists to prevent, and a stopped command
        # plus a loud failure is a better answer than a protected-looking run
        # that is not protected.
        printf '%s\n' "lost" > "$HB_FAILED" 2>/dev/null
        kill -TERM "$cmd_pid" 2>/dev/null
        exit 1
      fi
    done
  ) >/dev/null 2>&1 &
  run_hb_pid=$!
  printf '%s\n' "gate-lock: heartbeat pid $run_hb_pid (every ${HB_SECONDS}s while $lane runs)"
  wait "$cmd_pid"
  status=$?
  cmd_pid=""
  # Did the loop have to stop the command? The run is already failing on the
  # lost lock below; this says why the command ended when it did, which is not
  # something a caller can otherwise infer from a 143.
  if [ -f "$HB_FAILED" ]; then
    printf '%s\n' "gate-lock: FAILED — the lock was lost while the command ran, and the command was stopped" >&2
    lock_lost=1
  fi
  # Still ours? A lock that is gone or someone else's means the command ran
  # unprotected, which release alone would not say: with the lock simply
  # deleted, release reports "nothing to release" and exits 0.
  if ! verify "$lane"; then
    lock_lost=1
  fi
  exit "$status"
}

# Does a slot still name this caller, as its lane and its pid? The question
# `release` answers before deleting, asked on its own and quietly: a caller that
# is tidying up after itself needs to know whether there is anything of ITS OWN
# to drop, and asking must not print a refusal about a lock that belongs to a run
# still going somewhere else. With slots there is more than one lock on the host,
# so the answer is the caller's own slot — the pinned one where there is one, a
# scan where there is not — and the answer's VALUE is that slot's path: `LOCK`
# moves to it, and every message and removal below names the slot this caller
# actually holds.
#
# Existence is all this answers, and that is deliberate: `release` itself
# re-reads owner and pid before it removes anything, so a pin that no longer
# names this caller is refused there rather than here.
lock_is_ours() {
  if [ -n "${CF_GATE_SLOT_PATH:-}" ]; then
    [ -d "$CF_GATE_SLOT_PATH" ] || return 1
    LOCK="$CF_GATE_SLOT_PATH"
    return 0
  fi
  own=$(caller_slot "$1") || return 1
  LOCK="$own"
  return 0
}

# Release the lock — but only the caller's own. After a reclaim, a stale
# holder's cleanup must not delete the lock that replaced it: the removal
# happens only when the lock still names this owner AND this caller's pid.
# Anything else warns and fails, and leaves the lock alone.
#
# WITH a pin (CF_GATE_SLOT_PATH) that pin is the only slot considered and no
# scan happens at all; WITHOUT one the caller's slot is found by scanning for
# owner AND pid, so with slots on the host this still removes the caller's own
# lock and not another holder's — and a caller that holds nothing at all still
# answers on the slot it would have used, which is what makes the "nothing to
# release" and "refused" lines name a path a reader can go and look at.
release() {
  if [ -n "${CF_GATE_SLOT_PATH:-}" ]; then
    require_trusted_slot "$CF_GATE_SLOT_PATH"
    LOCK="$CF_GATE_SLOT_PATH"
  else
    own=$(caller_slot "$1") && LOCK="$own"
  fi
  if [ ! -d "$LOCK" ]; then
    printf '%s\n' "gate-lock: nothing to release — no lock at $LOCK"
    return 0
  fi
  owner=$(cat "$LOCK/owner" 2>/dev/null)
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  if [ "$owner" != "$1" ] || [ "$pid" != "$recorded_pid" ]; then
    printf '%s\n' "gate-lock: release refused — the lock at $LOCK names ${owner:-unknown} (pid ${pid:-?}), not $1 (pid $recorded_pid); it was left alone" >&2
    return 1
  fi
  # Test hook (CF_GATE_TEST_PAUSE_BEFORE_RELEASE): after the owner/pid check and
  # before the removal — the window in which a SECOND signal used to kill this
  # process (or its parent, in gate.sh) and leave the lock on disk. Parking the
  # heartbeat does not open it: gate.sh's loop has TERM at default and dies at
  # once, so nothing blocks there for a signal to land in.
  if [ -n "${CF_GATE_TEST_PAUSE_BEFORE_RELEASE:-}" ]; then
    touch "$CF_GATE_TEST_PAUSE_BEFORE_RELEASE" 2>/dev/null
    while [ -f "$CF_GATE_TEST_PAUSE_BEFORE_RELEASE" ]; do sleep 1; done
  fi
  # The removal's status is the release's status: a removal that failed on
  # permissions or I/O must be reported, not announced as released — the lock
  # would linger until a liveness reclaim picked it up.
  if ! rm -rf "$LOCK"; then
    printf '%s\n' "gate-lock: release failed — could not remove $LOCK" >&2
    return 1
  fi
  printf '%s\n' "gate-lock: released by $1 (pid $recorded_pid) from $LOCK"
  return 0
}

# Verify the lock still names this holder — the gate calls this at every
# locked-step boundary, so a gate whose lock was reclaimed (or whose loop
# could no longer vouch for it) fails as lock lost instead of continuing
# unprotected. This holder is the lane AND the caller's pid, exactly what
# release requires, found by the same means: the pinned slot where there is one,
# a scan by owner AND pid where there is not.
verify() {
  if [ -n "${CF_GATE_SLOT_PATH:-}" ]; then
    require_trusted_slot "$CF_GATE_SLOT_PATH"
    LOCK="$CF_GATE_SLOT_PATH"
  else
    own=$(caller_slot "$1") && LOCK="$own"
  fi
  if [ ! -d "$LOCK" ]; then
    printf '%s\n' "gate-lock: verify — no lock at $LOCK" >&2
    return 1
  fi
  owner=$(cat "$LOCK/owner" 2>/dev/null)
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  if [ "$owner" != "$1" ] || [ "$pid" != "$recorded_pid" ]; then
    printf '%s\n' "gate-lock: verify failed — the lock at $LOCK names ${owner:-unknown} (pid ${pid:-?}), not $1 (pid $recorded_pid)" >&2
    return 1
  fi
  return 0
}

# Every slot that exists, whatever the count says — a host whose slots were
# lowered underneath a holder still has that holder's lock, and a caller that
# only looked at 0..N-1 would report the host free while a slot is taken. The
# one answer an operator must never be given. Slot 0 keeps its unsuffixed name,
# so a single-slot host prints the same line it always did with the slot named,
# and `project` sits between the owner and the timestamps: a pool shared by
# several projects is exactly the case where "who" is not enough.
status() {
  slots_listed=0
  while IFS= read -r slot_path_seen; do
    [ -n "$slot_path_seen" ] || continue
    slots_listed=1
    LOCK="$slot_path_seen"
    owner=$(cat "$LOCK/owner" 2>/dev/null)
    pid=$(cat "$LOCK/pid" 2>/dev/null)
    started=$(cat "$LOCK/started" 2>/dev/null)
    beat=$(cat "$LOCK/beat" 2>/dev/null)
    project=$(cat "$LOCK/project" 2>/dev/null)
    if pid_alive "$pid"; then
      life="pid $pid alive"
    else
      life="pid ${pid:-none} not alive"
    fi
    if beat_is_stale "$beat"; then
      heart="heartbeat stale or missing (threshold ${STALE_SECONDS}s)"
    else
      heart="heartbeat fresh (beat $beat)"
    fi
    printf '%s\n' "gate-lock: slot $LOCK held by ${owner:-unknown} project ${project:-unknown} (started ${started:-?}, $life, $heart)"
  done <<EOF
$(existing_slots)
EOF
  if [ "$slots_listed" -eq 0 ]; then
    printf '%s\n' "gate-lock: free (no lock at $LOCK_BASE)"
  fi
  return 0
}

# Refresh the beat — only on the caller's own lock. A holder whose lock was
# reclaimed must not keep refreshing the lock that replaced it: the beat is
# written only when the lock still names this pid, and the refusal is what
# tells the holder's loop (and the gate, at its next step boundary) that the
# lock is lost.
#
# Which lock that is comes from the pin when there is one. Heartbeat is the
# subcommand a scan is most dangerous for: it takes no lane, so it has only the
# pid to match on, and at SLOTS>1 a pid can appear in more than one lock
# directory — including a planted one, since the lock parent may be 1777. The
# scan would take whichever name sorts first; the pin takes the slot this holder
# was given.
heartbeat() {
  if [ -n "${CF_GATE_SLOT_PATH:-}" ]; then
    require_trusted_slot "$CF_GATE_SLOT_PATH"
    LOCK="$CF_GATE_SLOT_PATH"
  else
    own=$(pid_slot "$recorded_pid") && LOCK="$own"
  fi
  if [ ! -d "$LOCK" ]; then
    printf '%s\n' "gate-lock: heartbeat — no lock at $LOCK; nothing to refresh" >&2
    return 1
  fi
  pid=$(cat "$LOCK/pid" 2>/dev/null)
  if [ "$pid" != "$recorded_pid" ]; then
    printf '%s\n' "gate-lock: heartbeat refused — the lock at $LOCK names pid ${pid:-?}, not this holder (pid $recorded_pid); the beat was not touched" >&2
    return 1
  fi
  # Refresh the beat by REPLACING it, never by truncating it. `acquire` and
  # `status` both read this file, and an empty beat reads as stale
  # (beat_is_stale), so a reader that caught the moment between the truncation
  # and the write would judge a live, heartbeating holder's lock reclaimable
  # and take it. Write the new value beside the old one and rename: that is the
  # same atomic rename the lock's own creation uses, and the previous beat stays
  # readable right up to it. Measured on this host: a reader looping on the file
  # saw an empty value 10 times in 7 seconds.
  #
  # The new value is staged BESIDE THE LOCK, not inside it, so the lock
  # directory holds nothing but the six files try_create wrote: a removal never
  # has to unlink a file that is still being written, and the only entry that
  # can appear after creation is the finished one this rename delivers.
  # Same filesystem by construction — the staged file is a sibling of the lock
  # directory itself, so it renames onto $LOCK/beat whatever the lock's parent
  # is. That is the whole reason it is not `${TMPDIR}/cf-gate.beatnew.$$`, which
  # is what this used to stage: once the pool lives on /run/user/1000 and TMPDIR
  # is mergerfs, a rename from TMPDIR onto the pool crosses a filesystem, and a
  # cross-device rename is not a rename — it is copy-then-unlink, so the beat is
  # briefly ABSENT at the name, and the readers above judge an absent beat as
  # stale and reclaim a holder that is alive and heartbeating (see
  # beat_is_stale). This is exactly the shape mergerfs merges on top of: two
  # candidates can both win one name, and a cross-branch rename can fall back to
  # copy+delete.
  #
  # What staging beside the lock does NOT do is make the removal safe: this
  # rename's TARGET is inside the lock, so a `rm -rf` of the lock that is in
  # flight while this function runs can still lose the race with it and fail
  # with "Directory not empty". It is closed one level up instead, in the loop
  # that calls this: that loop never exits with a refresh in flight, so a holder
  # that stops the loop and then removes the lock has already waited for every
  # rename performed here. The comment that used to sit here claimed the
  # directory was read-only from try_create onward, with "nothing in it for a
  # removal to race" — and the directory this function writes into is exactly
  # the thing a removal races.
  #
  # `$$` is this heartbeat's own pid, so a refresh that is killed between the
  # write and the rename leaves one file named after a pid that is not there —
  # which is the same shape as `.cand.<pid>` and is kept out of the slot set by
  # the suffix rule in is_slot_path, not by where it sits.
  beat_new="$LOCK.beatnew.$$"
  if ! printf '%s\n' "$(date +%s)" > "$beat_new" 2>/dev/null; then
    printf '%s\n' "gate-lock: heartbeat — cannot write $LOCK/beat" >&2
    return 1
  fi
  # Test hook (CF_GATE_TEST_PAUSE_BEFORE_BEAT_MV): the instant this refresh is
  # in flight — staged, about to rename — which is the state a `rm -rf` of the
  # lock can lose the race with. A test holds one here across a release to
  # prove the holder waits for it (see the loop in run_locked).
  if [ -n "${CF_GATE_TEST_PAUSE_BEFORE_BEAT_MV:-}" ]; then
    touch "$CF_GATE_TEST_PAUSE_BEFORE_BEAT_MV" 2>/dev/null
    while [ -f "$CF_GATE_TEST_PAUSE_BEFORE_BEAT_MV" ]; do sleep 1; done
  fi
  if ! mv "$beat_new" "$LOCK/beat" 2>/dev/null; then
    # A lock reclaimed under us in the window above takes its directory with
    # it, so the rename fails; the file we wrote goes with it, and the refusal
    # is what tells this loop its lock is gone.
    rm -f "$beat_new" 2>/dev/null
    printf '%s\n' "gate-lock: heartbeat — cannot replace $LOCK/beat" >&2
    return 1
  fi
  return 0
}

case "${1:-}" in
  run)
    [ $# -ge 2 ] || usage
    run_lane=$2
    shift 2
    # Everything after the lane is the command, arguments and all; run_locked
    # finds the `--` that separates them.
    run_locked "$run_lane" "$@"
    ;;
  acquire)
    [ $# -ge 2 ] || usage
    require_caller_pid
    acquire "$2"
    ;;
  release)
    [ $# -ge 2 ] || usage
    release "$2"
    ;;
  verify)
    [ $# -ge 2 ] || usage
    verify "$2"
    ;;
  status)
    [ $# -eq 1 ] || usage
    status
    ;;
  heartbeat)
    [ $# -eq 1 ] || usage
    heartbeat
    ;;
  *)
    usage
    ;;
esac