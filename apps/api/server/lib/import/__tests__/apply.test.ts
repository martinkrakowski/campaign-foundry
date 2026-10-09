import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { main } from "../../../../bin/import.js";
import { trackedSampleTree, useApplyEnvironment, restoreApplyEnvironment, ON_A_REAL_TEST_SERVER } from "./fixtures/apply-harness.js";
import { dropRoot } from "./fixtures/tree.js";
import type { StepContext } from "../steps.js";
import { replan } from "../apply.js";

const SWITCHED_AT = "2026-10-01T00:00:00Z";

function io(): {
  out: string[];
  err: string[];
  deps: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
  };
}

describe.skipIf(ON_A_REAL_TEST_SERVER)("apply", () => {
  let env: Awaited<ReturnType<typeof useApplyEnvironment>>;
  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
  });

  test("replan returns the digest that plan prints and the reviewed file hashes", async () => {
    const { root } = trackedSampleTree();
    try {
      const output = join(root, "output");
      mkdirSync(output, { recursive: true });
      env.reinstall();
      const ctx: StepContext = {
        orgId: "local",
        switchedAt: new Date(SWITCHED_AT),
        projectRoot: root,
        outputRoot: output,
        includeSamples: true,
        fsOnly: false,
      };
      const { out, deps } = io();
      expect(
        await main(
          ["plan", "--project-root", root, "--output-root", output, "--switched-at", SWITCHED_AT, "--include-samples"],
          deps,
        ),
      ).toBe(0);
      const plan = JSON.parse(out[3]!) as { digest: string };
      const { digest, files, expectedHashes } = await replan(ctx);
      expect(digest).toBe(plan.digest);
      const contentFiles = files.filter((file) => file.sha256 !== undefined);
      expect(contentFiles.length).toBeGreaterThan(0);
      for (const file of contentFiles) {
        expect(expectedHashes.get(file.rel)).toBe(file.sha256);
      }
    } finally {
      dropRoot(root);
    }
  });
});
