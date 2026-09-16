/**
 * Node, not happy-dom: importing vitest.config.ts evaluates
 * `fileURLToPath(new URL(..., import.meta.url))`, which throws under happy-dom
 * (`The URL must be of scheme file`). This is an environment pin, not a timeout.
 *
 * @vitest-environment node
 */
import { describe, expect, test } from "vitest";
import config from "../../../../vitest.config";

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

const isProjectBlock = (value: unknown): value is ProjectBlock =>
  typeof value === "object" && value !== null && "test" in value;

const project = (name: string): ProjectBlock => {
  const found = (config.test?.projects ?? []).find(
    (entry) => isProjectBlock(entry) && entry.test?.name === name,
  );
  if (!isProjectBlock(found)) {
    throw new Error(`vitest project "${name}" is missing from vitest.config.ts`);
  }
  return found;
};

describe("web project testTimeout (X36)", () => {
  test("is 15000ms and the other projects do not inherit it", () => {
    expect(config.test && "testTimeout" in config.test).toBe(false);
    expect(project("web").test?.testTimeout).toBe(WEB_TEST_TIMEOUT_MS);
    expect(project("node").test?.testTimeout).toBeUndefined();
    expect(project("api").test?.testTimeout).toBeUndefined();
    expect(project("tools").test?.testTimeout).toBeUndefined();
  });
});
