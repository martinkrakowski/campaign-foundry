import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { main } from "../../../../bin/import.js";
import { trackedSampleTree, useApplyEnvironment, restoreApplyEnvironment, ON_A_REAL_TEST_SERVER } from "./fixtures/apply-harness.js";
import { dropRoot, makeRoot, writeAt, writeBrief, PNG } from "./fixtures/tree.js";
import type { StepContext } from "../steps.js";
import { replan } from "../apply.js";

const SWITCHED_AT = "2026-10-01T00:00:00Z";
const PNG2 = Buffer.concat([PNG, Buffer.from("second-bytes")]);

/** Counts the rows the harness's PGlite holds and the `put` calls on the wrapped store. */
async function counts(env: Awaited<ReturnType<typeof useApplyEnvironment>>): Promise<{
  campaigns: number;
  assets: number;
  versions: number;
  puts: number;
}> {
  const campaigns = (
    await env.db.query<{ n: number }>(`select count(*)::int as n from campaign where org_id=$1`, ["local"])
  ).rows[0]!.n;
  const assets = (
    await env.db.query<{ n: number }>(`select count(*)::int as n from asset where org_id=$1`, ["local"])
  ).rows[0]!.n;
  const versions = (await env.db.query<{ n: number }>(`select count(*)::int as n from brief_version`)).rows[0]!.n;
  return { campaigns, assets, versions, puts: env.objects.putCount };
}

/** A one-campaign sample tree with a PNG input, and its output dir. */
function sampleTree(): { root: string; output: string } {
  const root = makeRoot();
  const output = join(root, "output");
  mkdirSync(output, { recursive: true });
  writeAt(root, "assets/inputs/camp/logo.png", PNG);
  writeBrief(root, "camp.yaml", {
    id: "camp",
    products: [
      { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/camp/logo.png" },
    ],
  });
  return { root, output };
}

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

function ctxWith(root: string, output: string, includeSamples = false): StepContext {
  return {
    orgId: "local",
    switchedAt: new Date(SWITCHED_AT),
    projectRoot: root,
    outputRoot: output,
    includeSamples,
    fsOnly: false,
  };
}

/** The digest `apply` would re-plan for this tree — so a test can pass the real one to `--expect`. */
async function replannedDigest(root: string, output: string): Promise<string> {
  return (await replan(ctxWith(root, output))).digest;
}

/** A result path in the OS temp dir, never under the sample tree (N4). */
function freshResult(label: string): string {
  return join(tmpdir(), `cf-apply-${label}-${process.pid}.json`);
}

/** `apply` against this suite's temp tree, with any flags appended. */
function applyArgv(root: string, output: string, extra: readonly string[]): string[] {
  return [
    "apply",
    "--project-root",
    root,
    "--output-root",
    output,
    "--switched-at",
    SWITCHED_AT,
    "--org",
    "local",
    ...extra,
  ];
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

  test("apply without --expect refuses and writes nothing", async () => {
    const { root, output } = sampleTree();
    try {
      env.reinstall();
      const { err, deps } = io();
      expect(
        await main(
          ["apply", "--project-root", root, "--output-root", output, "--switched-at", SWITCHED_AT, "--org", "local", "--result", "/tmp/ignored"],
          deps,
        ),
      ).toBe(1);
      expect(err).toEqual(["apply needs --expect <digest>"]);
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
      expect(env.objects.putCount).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("apply without --result refuses and writes nothing", async () => {
    const { root, output } = sampleTree();
    try {
      env.reinstall();
      const { err, deps } = io();
      expect(
        await main(
          ["apply", "--project-root", root, "--output-root", output, "--switched-at", SWITCHED_AT, "--org", "local", "--expect", "0".repeat(64)],
          deps,
        ),
      ).toBe(1);
      expect(err).toEqual(["apply needs --result <path>"]);
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
      expect(env.objects.putCount).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("apply refuses unless STORE_BACKEND is postgres", async () => {
    const { root, output } = sampleTree();
    try {
      env.reinstall();
      process.env.STORE_BACKEND = "fs";
      const { err, deps } = io();
      expect(
        await main(
          [
            "apply",
            "--project-root",
            root,
            "--output-root",
            output,
            "--switched-at",
            SWITCHED_AT,
            "--org",
            "local",
            "--expect",
            "0".repeat(64),
            "--result",
            "/tmp/ignored",
          ],
          deps,
        ),
      ).toBe(1);
      expect(err[0]).toBe("apply needs STORE_BACKEND=postgres, and STORE_BACKEND is fs");
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
    } finally {
      dropRoot(root);
    }
  });

  test("apply refuses unless OBJECT_STORE is s3", async () => {
    const { root, output } = sampleTree();
    try {
      env.reinstall();
      process.env.OBJECT_STORE = "fs";
      const { err, deps } = io();
      expect(
        await main(
          [
            "apply",
            "--project-root",
            root,
            "--output-root",
            output,
            "--switched-at",
            SWITCHED_AT,
            "--org",
            "local",
            "--expect",
            "0".repeat(64),
            "--result",
            "/tmp/ignored",
          ],
          deps,
        ),
      ).toBe(1);
      expect(err[0]).toBe("apply needs OBJECT_STORE=s3, and OBJECT_STORE is fs");
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
    } finally {
      dropRoot(root);
    }
  });

  test("apply refuses when the org row does not exist", async () => {
    const { root, output } = sampleTree();
    try {
      env.reinstall();
      const { err, deps } = io();
      expect(
        await main(
          [
            "apply",
            "--project-root",
            root,
            "--output-root",
            output,
            "--switched-at",
            SWITCHED_AT,
            "--org",
            "nope",
            "--expect",
            "0".repeat(64),
            "--result",
            "/tmp/ignored",
          ],
          deps,
        ),
      ).toBe(1);
      expect(err[0]).toMatch(/no org "nope" exists/);
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
    } finally {
      dropRoot(root);
    }
  });

  test("apply with a digest that is not the re-planned digest refuses and writes nothing", async () => {
    const { root, output } = sampleTree();
    const result = freshResult("4");
    try {
      const real = await replannedDigest(root, output);
      const wrong = real.slice(0, 63) + (real.at(-1) === "0" ? "1" : "0");
      env.reinstall();
      const { err, deps } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", wrong, "--result", result]), deps),
      ).toBe(1);
      expect(err).toEqual([
        `--expect ${wrong} does not match the re-planned digest ${real}`,
      ]);
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
      expect(env.objects.putCount).toBe(0);
      expect(existsSync(result)).toBe(false);
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });

  test("a source file changed after the plan makes apply refuse the old digest", async () => {
    const { root, output } = sampleTree();
    const result = freshResult("6");
    try {
      const real = await replannedDigest(root, output);
      writeAt(root, "assets/inputs/camp/logo.png", PNG2);
      env.reinstall();
      const { err, deps } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
      ).toBe(1);
      expect(err[0]).toMatch(/does not match/);
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
      expect(env.objects.putCount).toBe(0);
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });

  test("apply refuses a result path that already exists", async () => {
    const { root, output } = sampleTree();
    const result = freshResult("11");
    writeFileSync(result, "existing content");
    try {
      const real = await replannedDigest(root, output);
      env.reinstall();
      const { err, deps } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
      ).toBe(1);
      expect(err[0]).toBe(`--result ${JSON.stringify(result)} already exists`);
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
      expect(env.objects.putCount).toBe(0);
      expect(readFileSync(result, "utf8")).toBe("existing content");
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });

  test("apply refuses a result path under the project root or the output root", async () => {
    const { root, output } = sampleTree();
    try {
      const real = await replannedDigest(root, output);
      for (const rel of ["result.json", "output/result.json"]) {
        const result = join(root, rel);
        env.reinstall();
        const { err, deps } = io();
        expect(
          await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
        ).toBe(1);
        expect(err).toEqual([
          `--result ${JSON.stringify(result)} is under the project or output root`,
        ]);
        expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
      }
    } finally {
      dropRoot(root);
    }
  });
});



