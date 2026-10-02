import { availableParallelism } from "node:os";

/**
 * The worker cap for ONE vitest run: `CF_TEST_MAX_WORKERS` if it is set, and
 * `GATE_HOST_WORKERS` if it is not.
 *
 * The problem is arithmetic, and it is host-wide rather than per lane. Vitest's
 * default is `availableParallelism() - 1`, so on a 24-thread host every run
 * asks for ~23 workers. The gate's slot count decides how many runs happen at
 * once: three slots already give ~69 workers, and seven would ask for ~160 — tens
 * of gigabytes of RSS against ~40 free, and false timeouts on the CPU-bound tests,
 * which fail on their own internal deadlines and cannot be saved by a larger
 * `--testTimeout`.
 *
 * So the slot count and the worker count are ONE decision, made once, for the
 * host: `slots × CF_TEST_MAX_WORKERS ≤ threads`. On midnight that is 6 × 4 or
 * 7 × 3. Both are set in `/etc/environment`, never in one seat's environment —
 * a seat that disagrees does not get a smaller host, it gets a seat running
 * beside a host it cannot see.
 *
 * THE HOST-WIDE POOL (format 1) renames where that decision is recorded. With
 * `GATE_LOCK_DIR` set, every project on the host draws its gate slots from one
 * directory — `gate.lock` and `gate.lock.<n>` — marked with a `.format` file
 * holding `1`, so two projects cannot share a pool whose lock semantics they
 * disagree about. On midnight that is:
 *
 *   GATE_LOCK_DIR=/run/user/1000/gate-lock   local tmpfs, 0700, under linger
 *   GATE_HOST_WORKERS=4                      workers one run may spawn
 *   GATE_HOST_SLOTS=6                        optional; otherwise derived as
 *                                            max(1, nproc / workers), capped 64
 *
 * 24 / 4 = six slots, six × four workers = the host's 24 threads. `scripts/gate-lock.sh`
 * is where that is enforced: under a pool, a `CF_GATE_SLOTS` that disagrees with
 * the host's count, and a `CF_TEST_MAX_WORKERS` that disagrees with
 * `GATE_HOST_WORKERS`, are both refused by name rather than obeyed. This file is
 * the other half of the same rule — it reads `GATE_HOST_WORKERS` as the fallback,
 * applies the validation below to whichever variable supplied the value, and says
 * so in every message, so the operator is told which one to fix.
 *
 * The pool directory is judged, not assumed: absolute, created 0700 if missing,
 * not a symlink, owned by you, and neither group- nor world-writable. Its PARENT
 * must be too — owned by you and not writable by others — and midnight's
 * `/run/user/1000` is: the leaf's own mode protects the names inside it and
 * nothing about the name itself, which is a directory entry in the parent, so a
 * parent another user can write lets them rename the pool away and hand the next
 * acquirer a pool of their own.
 *
 * NEVER on mergerfs or NFS. A pool there merges branches: two candidates on two
 * branches can both win one name, and a cross-branch rename can fall back to
 * copy+delete — which is the race that reclaims a live holder. Midnight's TMPDIR
 * is mergerfs, which is why the pool is not TMPDIR.
 *
 * `CF_TEST_MAX_WORKERS` is kept for ONE release and still wins when it is set, so
 * an operator who set it before the pool existed keeps a working host; the two are
 * NOT compared here, because `scripts/gate-lock.sh` is where the comparison
 * belongs — it is the layer that knows whether this run is on a pool at all.
 *
 * Unset is the default and means unset: CI and the Mac pass nothing and get
 * vitest's own behaviour, byte for byte as it is today. That is the whole
 * reason the helper returns `undefined` rather than a number, and the reason
 * this lives in a file of its own — `vitest.config.ts` only calls it, so the
 * rules below are unit-testable without loading a config, and the throw is
 * raised at config load where the operator who set the variable will see it.
 *
 * Both parameters are arguments, not ambient reads, so the tests state their
 * own CPU count instead of inheriting the host's; the defaults exist for the
 * config's single call.
 */
export function resolveMaxWorkers(
  host: NodeJS.ProcessEnv = process.env,
  cpus: number = availableParallelism(),
): number | undefined {
  // Which variable supplied the value, asked BEFORE the two are folded together:
  // every refusal below has to name the one the operator actually set, and a
  // message that said CF_TEST_MAX_WORKERS on a host that only sets
  // GATE_HOST_WORKERS sends them to edit a variable nobody set.
  const name =
    host["CF_TEST_MAX_WORKERS"] === undefined ? "GATE_HOST_WORKERS" : "CF_TEST_MAX_WORKERS";
  // Which slot variable the operator's own naming of the decision uses, so that a
  // message on a pool-less host is not sent to a variable it does not have: the
  // two refusals below both name the slot count beside the cap, and
  // GATE_HOST_SLOTS only exists on a host that runs the pool.
  const slots = name === "GATE_HOST_WORKERS" ? "GATE_HOST_SLOTS" : "CF_GATE_SLOTS";
  // CF_TEST_MAX_WORKERS wins when it is set — including when it is set to
  // something unusable, which is refused below rather than quietly answered from
  // the host's variable: an operator who typed it deserves to be told, not to
  // have their value disappear and a different one take its place. Folding the
  // two into one name here means the validation, both refusals and the answer are
  // the same code whichever variable arrived.
  //
  // The fold is `??` and NOT `||`: CF_TEST_MAX_WORKERS="" is a variable the
  // operator believes they set, and it has always been refused by name, so an
  // empty one must not fall through to the host's value either. GATE_HOST_WORKERS
  // is the other way round, because an empty value there counts as UNSET — the
  // same rule scripts/gate-lock.sh applies to all three of its variables, and the
  // same wrapper that exports it unconditionally on a host with nothing to say
  // about it is the one that would export "".
  const env: NodeJS.ProcessEnv = {
    ...host,
    CF_TEST_MAX_WORKERS:
      host["CF_TEST_MAX_WORKERS"] ??
      (host["GATE_HOST_WORKERS"] === "" ? undefined : host["GATE_HOST_WORKERS"]),
  };
  const raw = env["CF_TEST_MAX_WORKERS"];
  if (raw === undefined) return undefined;

  // Not `Number(raw)`: that accepts "4.5", " 4 ", "0x4" and "4e0", four
  // spellings of a count that was never written as a count, and each of them
  // would reach vitest as a worker pool sized by a reader's guess.
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(
      `${name} must be a positive whole number, got '${raw}'. ` +
        `It caps the workers one vitest run spawns, so it is set HOST-WIDE beside ` +
        `${slots}, never per seat.`,
    );
  }

  const workers = Number(raw);
  // A cap above the CPU count is not a cap. It reads as a deliberate setting
  // and measures as nothing at all, and the operator who set it was answering
  // a question about slots × workers — so the answer they got is refused here
  // rather than quietly rounded down to something they did not ask for.
  if (workers > cpus) {
    throw new Error(
      `${name}=${workers} is above this host's availableParallelism() (${cpus}). ` +
        `A cap above the thread count is not a cap; pick a number at or below ${cpus} so that ` +
        `${slots} × ${name} stays within the host's threads.`,
    );
  }

  return workers;
}
