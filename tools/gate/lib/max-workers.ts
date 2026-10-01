import { availableParallelism } from "node:os";

/**
 * `CF_TEST_MAX_WORKERS` — how many workers ONE vitest run may spawn.
 *
 * The problem is arithmetic, and it is host-wide rather than per lane. Vitest's
 * default is `availableParallelism() - 1`, so on a 24-thread host every run
 * asks for ~23 workers. `CF_GATE_SLOTS` decides how many runs happen at once:
 * three slots already give ~69 workers, and the owner's next step (six or seven
 * slots) would ask for ~160 — tens of gigabytes of RSS against ~40 free, and
 * false timeouts on the CPU-bound tests, which fail on their own internal
 * deadlines and cannot be saved by a larger `--testTimeout`.
 *
 * So the two variables are ONE decision, made once, for the host:
 * `CF_GATE_SLOTS × CF_TEST_MAX_WORKERS ≤ threads`. On midnight that is 6 × 4
 * or 7 × 3. Both are set in `/etc/environment`, never in one seat's environment
 * — a seat that disagrees does not get a smaller host, it gets a seat running
 * beside a host it cannot see.
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
  env: NodeJS.ProcessEnv = process.env,
  cpus: number = availableParallelism(),
): number | undefined {
  const raw = env["CF_TEST_MAX_WORKERS"];
  if (raw === undefined) return undefined;

  // Not `Number(raw)`: that accepts "4.5", " 4 ", "0x4" and "4e0", four
  // spellings of a count that was never written as a count, and each of them
  // would reach vitest as a worker pool sized by a reader's guess.
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(
      `CF_TEST_MAX_WORKERS must be a positive whole number, got '${raw}'. ` +
        `It caps the workers one vitest run spawns, so it is set HOST-WIDE beside ` +
        `CF_GATE_SLOTS, never per seat.`,
    );
  }

  const workers = Number(raw);
  // A cap above the CPU count is not a cap. It reads as a deliberate setting
  // and measures as nothing at all, and the operator who set it was answering
  // a question about slots × workers — so the answer they got is refused here
  // rather than quietly rounded down to something they did not ask for.
  if (workers > cpus) {
    throw new Error(
      `CF_TEST_MAX_WORKERS=${workers} is above this host's availableParallelism() (${cpus}). ` +
        `A cap above the thread count is not a cap; pick a number at or below ${cpus} so that ` +
        `CF_GATE_SLOTS × CF_TEST_MAX_WORKERS stays within the host's threads.`,
    );
  }

  return workers;
}
