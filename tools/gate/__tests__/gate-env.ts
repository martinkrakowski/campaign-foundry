/**
 * The environment every test in this directory drives `gate.sh` or
 * `gate-lock.sh` with.
 *
 * There is one builder because the reason a test needs it is a HOST, not a
 * test: a host that has adopted the shared gate pool exports `GATE_LOCK_DIR`,
 * `GATE_HOST_SLOTS` and `GATE_HOST_WORKERS`, and each of those three redirects
 * where the lock lives, how many slots it has, or how many workers one run may
 * spawn. Inherit them and the suite starts planting slots in the real pool, on
 * a host with a real count, for a test written against the default of one slot —
 * and it does so silently: the test still passes its own assertions, and the
 * suite has been taking a seat out of the operator's pool while it ran.
 *
 * So all three are DELETED rather than overridden, and `CF_GATE_SLOTS` is pinned
 * to 1 in their place, which is the default every one of these tests is written
 * against. A test that means a different pool says so in its own overrides,
 * which are spread last and therefore win — including the new-pool tests, which
 * pass `GATE_LOCK_DIR` explicitly.
 *
 * `TMPDIR` is the fourth assignment for the same reason: the lock's parent is
 * `${TMPDIR:-/tmp}`, so a per-test scratch directory is what keeps a test's lock
 * out of the host's, and putting it here means no spawn site can forget.
 */
export function gateEnv(dir: string, overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Not destructured on purpose: `const { GATE_LOCK_DIR, ...rest } = process.env`
  // reads as removing them and trips `no-unused-vars` on the binding, which is a
  // lint error that would push the next edit back towards spreading them.
  delete env["GATE_LOCK_DIR"];
  delete env["GATE_HOST_SLOTS"];
  delete env["GATE_HOST_WORKERS"];
  env["CF_GATE_SLOTS"] = "1";
  env["TMPDIR"] = dir;
  return { ...env, ...overrides };
}
