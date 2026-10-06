/**
 * Node, not happy-dom: importing vitest.config.ts evaluates
 * `fileURLToPath(new URL(..., import.meta.url))`, which throws under happy-dom
 * (`The URL must be of scheme file`). This is an environment pin, not a timeout.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * X36 calibrates the web project's testTimeout to 15000ms. The pin reads the
 * config object (not a resolved runtime, not a shell-out) so a later edit that
 * moves the number onto the root `test` block — which every project would then
 * inherit via `extends: true` — fails here, not in CI on an unrelated lane.
 */
const WEB_TEST_TIMEOUT_MS = 15_000;

type ProjectBlock = {
  readonly test?: {
    readonly name?: string;
    readonly testTimeout?: number;
  };
};

type Config = { readonly test?: { readonly testTimeout?: number; readonly projects?: unknown[] } };

const isProjectBlock = (value: unknown): value is ProjectBlock =>
  typeof value === "object" && value !== null && "test" in value;

const project = (config: Config, name: string): ProjectBlock => {
  const found = (config.test?.projects ?? []).find(
    (entry) => isProjectBlock(entry) && entry.test?.name === name,
  );
  if (!isProjectBlock(found)) {
    throw new Error(`vitest project "${name}" is missing from vitest.config.ts`);
  }
  return found;
};

describe("web project testTimeout (X36)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("is 15000ms and the other projects do not inherit it", async () => {
    // The config is imported with CF_TEST_TIMEOUT_MS stubbed to UNSET, so this pins the
    // COMMITTED numbers on every host. A slow lane host sets that variable to lift the
    // limits (tools/gate/lib/test-timeout.ts), and read through the host's own value the
    // 15000 below would be invisible there: with 30000 set, a web floor of 15000 and one
    // of 5000 both answer 30000, and this file's mutation would survive on that host.
    // The lift itself is pinned in tools/gate/__tests__/test-timeout.test.ts.
    vi.stubEnv("CF_TEST_TIMEOUT_MS", undefined);
    vi.resetModules();
    const { default: config } = (await import("../../../../vitest.config")) as { default: Config };
    expect(config.test?.testTimeout).toBeUndefined();
    expect(project(config, "web").test?.testTimeout).toBe(WEB_TEST_TIMEOUT_MS);
    expect(project(config, "node").test?.testTimeout).toBeUndefined();
    expect(project(config, "api").test?.testTimeout).toBeUndefined();
    expect(project(config, "tools").test?.testTimeout).toBeUndefined();
  });
});
