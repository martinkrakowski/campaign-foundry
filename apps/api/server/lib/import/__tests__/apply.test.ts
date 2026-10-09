import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { main } from "../../../../bin/import.js";
import {
  trackedSampleTree,
  useApplyEnvironment,
  restoreApplyEnvironment,
  ON_A_REAL_TEST_SERVER,
  failOnNth,
} from "./fixtures/apply-harness.js";
import { dropRoot, makeRoot, writeAt, writeBrief, briefBody, PNG } from "./fixtures/tree.js";
import type { StepContext, CampaignOutcome, PlannedCampaign } from "../steps.js";
import {
  replan,
  applyCampaigns,
  planProbes,
  ResultWriter,
  openResult,
  describeResultRefusal,
  type CampaignEntry,
} from "../apply.js";
import { importCampaignStep, type HashedContext, type CampaignResult } from "../campaign-step.js";
import { importTenant } from "../import-tenant.js";
import { getAssetStore, getBriefStore, setAssetStore, setBriefStore } from "../../ports/index.js";
import { objectStoreClient } from "../../object-store/index.js";
import { orgPrefix } from "../../object-store/object-keys.js";

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
    await env.db.query<{ n: number }>(`select count(*)::int as n from campaign where org_id=$1`, [
      "local",
    ])
  ).rows[0]!.n;
  const assets = (
    await env.db.query<{ n: number }>(`select count(*)::int as n from asset where org_id=$1`, [
      "local",
    ])
  ).rows[0]!.n;
  const versions = (
    await env.db.query<{ n: number }>(`select count(*)::int as n from brief_version`)
  ).rows[0]!.n;
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

/** A three-campaign tree (shared input) so the apply loop runs three campaigns. */
function threeCampaignTree(): { root: string; output: string } {
  const root = makeRoot();
  const output = join(root, "output");
  mkdirSync(output, { recursive: true });
  writeAt(root, "assets/inputs/logo.png", PNG);
  for (const slug of ["alpha", "beta", "gamma"] as const) {
    writeBrief(root, `${slug}.yaml`, {
      id: slug,
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
      ],
    });
  }
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

/** `plan` against this suite's temp tree, with any flags appended. */
function planArgv(root: string, output: string, extra: readonly string[]): string[] {
  return [
    "plan",
    "--project-root",
    root,
    "--output-root",
    output,
    "--switched-at",
    SWITCHED_AT,
    ...extra,
  ];
}

/** The decoded lines of a JSON-lines result file: header, campaign entries, optional summary. */
function parseResult(path: string): {
  header: { kind: string; switchedAt: string; orgId: string; digest: string };
  campaigns: CampaignEntry[];
  summary?: {
    kind: string;
    created: number;
    completed: number;
    unchanged: number;
    refused: number;
    partial: boolean;
  };
} {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = lines[0] as { kind: string; switchedAt: string; orgId: string; digest: string };
  const campaigns = lines
    .slice(1)
    .filter((line) => line.kind === "campaign") as unknown as CampaignEntry[];
  const summaryLines = lines.filter((line) => line.kind === "summary");
  const summary = summaryLines.length
    ? (summaryLines[summaryLines.length - 1] as {
        kind: string;
        created: number;
        completed: number;
        unchanged: number;
        refused: number;
        partial: boolean;
      })
    : undefined;
  return { header, campaigns, summary };
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
          [
            "plan",
            "--project-root",
            root,
            "--output-root",
            output,
            "--switched-at",
            SWITCHED_AT,
            "--include-samples",
          ],
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
            "--result",
            "/tmp/ignored",
          ],
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
          ],
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
      expect(err).toEqual([`--expect ${wrong} does not match the re-planned digest ${real}`]);
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

  test("apply names an interrupted run's result file and refuses to overwrite it", async () => {
    const { root, output } = sampleTree();
    const result = freshResult("11b");
    try {
      const real = await replannedDigest(root, output);
      // Seed an interrupted run: a header and a campaign line, with no summary.
      const handle = await open(result, "wx");
      const writer = new ResultWriter(handle, SWITCHED_AT, "local", real);
      await writer.header();
      await writer.add({
        slug: "camp",
        outcome: "created",
        minted: { campaignId: "dead", assets: [] },
        unreferencedInputs: { count: 0, names: [] },
      });
      await writer.close();
      const seed = readFileSync(result, "utf8");

      env.reinstall();
      const { err, deps } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
      ).toBe(1);
      expect(err[0]).toBe(
        `the result file ${JSON.stringify(result)} exists and has no summary line: ` +
          "it is the record of an interrupted run. Keep it, and give this run a new --result path.",
      );
      // The file is neither deleted nor rewritten.
      expect(readFileSync(result, "utf8")).toBe(seed);
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });

  test("a complete result file is refused as already existing", async () => {
    const { root, output } = sampleTree();
    const result = freshResult("11c");
    try {
      const real = await replannedDigest(root, output);
      const handle = await open(result, "wx");
      const writer = new ResultWriter(handle, SWITCHED_AT, "local", real);
      await writer.header();
      await writer.add({
        slug: "camp",
        outcome: "unchanged",
        minted: { assets: [] },
        unreferencedInputs: { count: 0, names: [] },
      });
      await writer.summary({ created: 0, completed: 0, unchanged: 1, refused: 0, partial: false });
      await writer.close();
      const seed = readFileSync(result, "utf8");

      env.reinstall();
      const { err, deps } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
      ).toBe(1);
      expect(err[0]).toBe(`--result ${JSON.stringify(result)} already exists`);
      expect(readFileSync(result, "utf8")).toBe(seed);
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

  test("apply refuses a result path whose parent is a symbolic link into the project root", async () => {
    const { root, output } = sampleTree();
    const linkDir = mkdtempSync(join(tmpdir(), "cf-link-"));
    const link = join(linkDir, "into-root");
    try {
      symlinkSync(root, link);
      const real = await replannedDigest(root, output);
      env.reinstall();
      const { err, deps } = io();
      const result = join(link, "result.json");
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
      ).toBe(1);
      expect(err).toEqual([
        `--result ${JSON.stringify(result)} is under the project or output root`,
      ]);
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
    } finally {
      dropRoot(root);
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  test("apply with the re-planned digest imports the campaigns", async () => {
    const { root, output } = sampleTree();
    const result = freshResult("5");
    try {
      const real = await replannedDigest(root, output);
      env.reinstall();
      const { out, err, deps } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
      ).toBe(0);
      expect(err).toEqual([]);
      expect(out[0]).toBe("camp: created");
      expect(out[1]).toMatch(/^ {2}minted: campaign .+, 1 asset\(s\)$/);
      expect(out[2]).toMatch(/^ {4}asset .+ .+ .+$/);
      expect(out[3]).toBe("1 created, 0 completed, 0 unchanged, 0 refused");
      expect(out).toHaveLength(4);
      expect(await counts(env)).toEqual({ campaigns: 1, assets: 1, versions: 1, puts: 1 });
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });

  test("the apply tests query only the wrapped PGlite and reach only the in-memory object store", async () => {
    const { root, output } = sampleTree();
    const result = freshResult("13");
    try {
      const real = await replannedDigest(root, output);
      env.reinstall();
      const { deps } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
      ).toBe(0);
      const c = await counts(env);
      expect(c.campaigns).toBe(1);
      expect(env.queries.length).toBeGreaterThan(0);
      expect(objectStoreClient()).toBe(env.objects);
      expect(process.env.DATABASE_URL).toBe("postgres://nobody@unused.invalid:5432/none");
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });

  test("a second apply over the same source writes nothing and reports every campaign unchanged", async () => {
    const { root, output } = sampleTree();
    const first = freshResult("14a");
    const second = freshResult("14b");
    try {
      const real = await replannedDigest(root, output);
      env.reinstall();
      const { deps } = io();
      expect(await main(applyArgv(root, output, ["--expect", real, "--result", first]), deps)).toBe(
        0,
      );
      const before = await counts(env);

      env.reinstall();
      const { out, deps: deps2 } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", second]), deps2),
      ).toBe(0);
      expect(out).toEqual(["camp: unchanged", "0 created, 0 completed, 1 unchanged, 0 refused"]);
      expect(await counts(env)).toEqual(before);
      expect(env.objects.putCount).toBe(before.puts);

      const parsed = parseResult(second);
      expect(parsed.campaigns.map((c) => c.outcome)).toEqual(["unchanged"]);
      expect(parsed.campaigns[0]!.minted.assets).toEqual([]);
    } finally {
      dropRoot(root);
      rmSync(first, { force: true });
      rmSync(second, { force: true });
    }
  });

  test("an interrupted apply lists the rows and objects it left in the result file", async () => {
    const root = makeRoot();
    const output = join(root, "output");
    mkdirSync(output, { recursive: true });
    const result = freshResult("15");
    try {
      writeBrief(root, "three.yaml", {
        id: "three",
        products: [
          { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/three/a.png" },
          { id: "p2", name: "P2", primaryColor: "#222222", logoPath: "assets/inputs/three/b.png" },
          { id: "p3", name: "P3", primaryColor: "#333333", logoPath: "assets/inputs/three/c.png" },
        ],
      });
      writeAt(root, "assets/inputs/three/a.png", PNG);
      writeAt(root, "assets/inputs/three/b.png", PNG);
      writeAt(root, "assets/inputs/three/c.png", PNG);
      const real = await replannedDigest(root, output);
      env.reinstall();
      setAssetStore(failOnNth(getAssetStore(importTenant("local")), "writeAsset", 3));
      const { err, deps } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
      ).toBe(1);
      expect(err).toEqual([]);

      const parsed = parseResult(result);
      expect(parsed.header).toMatchObject({ kind: "header", orgId: "local", digest: real });
      const entry = parsed.campaigns[0];
      expect(entry).toBeDefined();
      expect(entry!.slug).toBe("three");
      expect(entry!.outcome).toBe("refused");
      expect(entry!.partial).toBe(true);
      expect(entry!.minted.campaignId).toBeDefined();
      expect(entry!.minted.assets).toHaveLength(2);
      const { rows: dbAssets } = await env.db.query<{ id: string }>(
        `select id from asset where campaign_id=$1`,
        [entry!.minted.campaignId],
      );
      expect(entry!.minted.assets.map((a) => a.id).sort()).toEqual(
        dbAssets.map((a) => a.id).sort(),
      );
      const listed = await env.objects.list(orgPrefix("local"));
      expect(entry!.minted.assets.map((a) => a.key).sort()).toEqual(
        listed.map((o) => o.key).sort(),
      );
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });

  test("the result file lists every campaign uuid, asset id and object key the run minted", async () => {
    const { root, output } = sampleTree();
    const first = freshResult("16a");
    const second = freshResult("16b");
    try {
      const real = await replannedDigest(root, output);
      env.reinstall();
      const { out, err, deps } = io();
      expect(await main(applyArgv(root, output, ["--expect", real, "--result", first]), deps)).toBe(
        0,
      );
      expect(err).toEqual([]);
      const firstParsed = parseResult(first);
      const entry = firstParsed.campaigns[0];
      expect(entry).toBeDefined();
      expect(entry!.slug).toBe("camp");
      expect(out[0]).toBe("camp: created");
      expect(out[1]).toMatch(/^ {2}minted: campaign .+, 1 asset\(s\)$/);
      expect(entry!.outcome).toBe("created");
      const { rows: campaigns } = await env.db.query<{ id: string }>(
        `select id from campaign where org_id=$1 and slug=$2`,
        ["local", "camp"],
      );
      expect(entry!.minted.campaignId).toBe(campaigns[0]!.id);
      const { rows: dbAssets } = await env.db.query<{ id: string; name: string }>(
        `select id, name from asset where org_id=$1`,
        ["local"],
      );
      expect(entry!.minted.assets.map((a) => a.id).sort()).toEqual(
        dbAssets.map((a) => a.id).sort(),
      );
      const listed = await env.objects.list(orgPrefix("local"));
      expect(entry!.minted.assets.map((a) => a.key).sort()).toEqual(
        listed.map((o) => o.key).sort(),
      );

      // A second apply reuses the asset, so it is not listed as minted.
      env.reinstall();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", second]), deps),
      ).toBe(0);
      const againParsed = parseResult(second);
      expect(againParsed.campaigns[0]!.outcome).toBe("unchanged");
      expect(againParsed.campaigns[0]!.minted.assets).toEqual([]);
    } finally {
      dropRoot(root);
      rmSync(first, { force: true });
      rmSync(second, { force: true });
    }
  });

  test("the result file is appended one line per campaign and never rewritten", async () => {
    const result = freshResult("W1");
    try {
      const handle = await open(result, "wx");
      const write = vi.spyOn(handle, "write").mockClear();
      const sync = vi.spyOn(handle, "sync").mockClear();
      const truncate = vi.spyOn(handle, "truncate").mockClear();
      const writer = new ResultWriter(handle, SWITCHED_AT, "local", "deadbeef");
      const campaign = (slug: string): CampaignEntry => ({
        slug,
        outcome: "created",
        minted: { campaignId: `c-${slug}`, assets: [] },
        unreferencedInputs: { count: 0, names: [] },
      });

      await writer.header();
      await writer.add(campaign("a"));
      await writer.add(campaign("b"));
      await writer.close();

      // Append-only: no truncation, and every write passes only (buf, offset,
      // length) — no position argument seeks back to 0 after the header.
      expect(truncate).not.toHaveBeenCalled();
      const writes = write.mock.calls;
      expect(writes).toHaveLength(3);
      expect(writes.every((c) => c.length === 3)).toBe(true);
      expect(sync).toHaveBeenCalledTimes(3);

      // The file is JSON Lines: header, then one line per campaign, no summary.
      const lines = readFileSync(result, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0])).toMatchObject({
        kind: "header",
        switchedAt: SWITCHED_AT,
        orgId: "local",
        digest: "deadbeef",
      });
      expect(JSON.parse(lines[1])).toMatchObject({ kind: "campaign", slug: "a" });
      expect(JSON.parse(lines[2])).toMatchObject({ kind: "campaign", slug: "b" });
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("a failed write of one campaign's line leaves every earlier line intact", async () => {
    const { root, output } = threeCampaignTree();
    const result = freshResult("W2");
    try {
      const real = await replannedDigest(root, output);
      env.reinstall();
      const originalAdd = ResultWriter.prototype.add;
      let calls = 0;
      const spy = vi.spyOn(ResultWriter.prototype, "add").mockImplementation(async function (
        this: ResultWriter,
        entry: CampaignEntry,
      ) {
        calls++;
        if (calls === 3) throw new Error("simulated result write failure");
        return originalAdd.call(this, entry);
      });
      const { err, deps } = io();
      try {
        expect(
          await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
        ).toBe(1);
        expect(err.length).toBeGreaterThan(0);
        expect(err[0]).toContain("could not write the result file");
        expect(err[0]).toContain(result);

        // The file is still JSON Lines: a header and the first two campaigns, and
        // nothing past them (no summary line — the run never finished).
        const lines = readFileSync(result, "utf8")
          .split("\n")
          .filter((l) => l.length > 0);
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0]).kind).toBe("header");
        expect(JSON.parse(lines[1]).kind).toBe("campaign");
        expect(JSON.parse(lines[2]).kind).toBe("campaign");
        expect(JSON.parse(lines[1]).slug).toBe("alpha");
        expect(JSON.parse(lines[2]).slug).toBe("beta");
        expect(lines.filter((l) => l.includes("summary"))).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });

  test("each campaign's line is synced before the next campaign starts", async () => {
    const result = freshResult("W3");
    try {
      const handle = await open(result, "wx");
      const sync = vi.spyOn(handle, "sync");
      const writer = new ResultWriter(handle, SWITCHED_AT, "local", "deadbeef");
      const hashedCtx: HashedContext = {
        ...ctxWith("", ""),
        expectedHashes: new Map(),
      } as HashedContext;
      const step = vi.fn(
        async (
          _ctx: StepContext,
          _campaign: PlannedCampaign,
        ): Promise<{ outcome: CampaignOutcome }> => ({
          outcome: "created",
        }),
      );
      await writer.header();
      await applyCampaigns(
        hashedCtx,
        [
          { slug: "a", sourcePath: "x" },
          { slug: "b", sourcePath: "y" },
        ],
        [step],
        async (entry: CampaignEntry) => writer.add(entry),
      );
      await writer.summary({ created: 0, completed: 0, unchanged: 0, refused: 0, partial: false });
      await writer.close();

      // After campaign "a" is appended and synced, the step for "b" may run.
      expect(step).toHaveBeenCalledTimes(2);
      const syncAfterAppend = sync.mock.invocationCallOrder[1];
      const nextStepCall = step.mock.invocationCallOrder[1];
      expect(nextStepCall).toBeGreaterThan(syncAfterAppend);
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("a kill after a campaign's writes and before its result line leaves its ids in the log and the next run reports it unchanged", async () => {
    const { root, output } = sampleTree();
    const first = freshResult("W7a");
    const second = freshResult("W7b");
    try {
      const real = await replannedDigest(root, output);
      env.reinstall();
      // The campaign mints to the DB and object store, then the result-line
      // append throws: the campaign's ids are still on stdout, but its line
      // is never written.
      const spy = vi.spyOn(ResultWriter.prototype, "add").mockImplementation(async function () {
        throw new Error("simulated kill: result line not written");
      });
      const { out, deps } = io();
      try {
        expect(
          await main(applyArgv(root, output, ["--expect", real, "--result", first]), deps),
        ).toBe(1);
      } finally {
        spy.mockRestore();
      }

      // The first result file holds only the header: the campaign's line was
      // never appended (no summary line either — the run never finished).
      const firstLines = readFileSync(first, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(firstLines).toHaveLength(1);
      expect(JSON.parse(firstLines[0])).toMatchObject({ kind: "header", digest: real });

      // The job's log holds the campaign uuid and every asset id and key.
      const { rows: campaigns } = await env.db.query<{ id: string }>(
        `select id from campaign where org_id=$1 and slug=$2`,
        ["local", "camp"],
      );
      const { rows: dbAssets } = await env.db.query<{ id: string; name: string }>(
        `select id, name from asset where org_id=$1`,
        ["local"],
      );
      const listed = await env.objects.list(orgPrefix("local"));
      const stdout = out.join("\n");
      expect(stdout).toContain(`minted: campaign ${campaigns[0]!.id}, 1 asset(s)`);
      expect(stdout).toContain(`asset ${dbAssets[0]!.id} ${dbAssets[0]!.name} ${listed[0]!.key}`);

      // A second apply over the same source, with a new --result path, finds the
      // campaign unchanged and writes nothing new.
      env.reinstall();
      const before = await counts(env);
      const { out: againOut, err: againErr, deps: againDeps } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", second]), againDeps),
      ).toBe(0);
      expect(againErr).toEqual([]);
      expect(againOut).toEqual([
        "camp: unchanged",
        "0 created, 0 completed, 1 unchanged, 0 refused",
      ]);
      const again = parseResult(second);
      expect(again.campaigns[0]!.outcome).toBe("unchanged");
      expect(again.campaigns[0]!.minted.assets).toEqual([]);
      expect(await counts(env)).toEqual(before);
      expect(env.objects.putCount).toBe(before.puts);
    } finally {
      dropRoot(root);
      rmSync(first, { force: true });
      rmSync(second, { force: true });
    }
  });

  test("a full disk on the append stops the run with exit 1 and names the result file", async () => {
    const { root, output } = threeCampaignTree();
    const result = freshResult("W7c");
    try {
      const real = await replannedDigest(root, output);
      env.reinstall();
      // A full disk on the third campaign's result line: the first two are
      // already on disk, and the run stops.
      const originalAdd = ResultWriter.prototype.add;
      let calls = 0;
      const spy = vi.spyOn(ResultWriter.prototype, "add").mockImplementation(async function (
        this: ResultWriter,
        entry: CampaignEntry,
      ) {
        calls++;
        if (calls === 3) {
          const error: NodeJS.ErrnoException = new Error("no space left on device");
          error.code = "ENOSPC";
          throw error;
        }
        return originalAdd.call(this, entry);
      });
      const { err, deps } = io();
      try {
        expect(
          await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
        ).toBe(1);
        expect(err.length).toBe(1);
        expect(err[0]).toContain("could not write the result file");
        expect(err[0]).toContain(result);
        expect(err[0]).toContain("ENOSPC");

        // The earlier lines are intact; nothing past the second campaign.
        const lines = readFileSync(result, "utf8")
          .split("\n")
          .filter((l) => l.length > 0);
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0]).kind).toBe("header");
        expect(JSON.parse(lines[1]).kind).toBe("campaign");
        expect(JSON.parse(lines[1]).slug).toBe("alpha");
        expect(JSON.parse(lines[2]).kind).toBe("campaign");
        expect(JSON.parse(lines[2]).slug).toBe("beta");
        expect(lines.filter((l) => l.includes("summary"))).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });

  test("a refused campaign does not run the later steps", async () => {
    const { root, output } = sampleTree();
    try {
      const campPath = join(root, "briefs", "camp.yaml");
      const briefsPath = writeBrief(root, "briefs.yaml", {
        id: "briefs",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const expectedHashes = (await replan(ctxWith(root, output))).expectedHashes;
      const hashedCtx: HashedContext = { ...ctxWith(root, output), expectedHashes };
      const spy = vi.fn(
        async (): Promise<{ outcome: CampaignOutcome }> => ({ outcome: "created" }),
      );
      const seen: string[] = [];
      const entries: CampaignEntry[] = [];
      await applyCampaigns(
        hashedCtx,
        [
          { slug: "camp", sourcePath: campPath },
          { slug: "briefs", sourcePath: briefsPath },
        ],
        [importCampaignStep, spy],
        async (entry: CampaignEntry) => {
          seen.push(entry.slug);
          entries.push(entry);
        },
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(["camp", "briefs"]);
      expect(entries.map((e) => e.slug)).toEqual(["camp", "briefs"]);
      // The created campaign ran the spy; the refused one did not reach it.
      expect(entries[0]!.outcome).toBe("created");
      expect(entries[1]!.outcome).toBe("refused");
    } finally {
      dropRoot(root);
    }
  });

  test("applyCampaigns runs the registered IMPORT_STEPS by default", async () => {
    const { root, output } = sampleTree();
    try {
      const expectedHashes = (await replan(ctxWith(root, output))).expectedHashes;
      const hashedCtx: HashedContext = { ...ctxWith(root, output), expectedHashes };
      env.reinstall();
      const entries: CampaignEntry[] = [];
      await applyCampaigns(
        hashedCtx,
        [{ slug: "camp", sourcePath: join(root, "briefs", "camp.yaml") }],
        undefined,
        async (entry: CampaignEntry) => {
          entries.push(entry);
        },
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe("created");
    } finally {
      dropRoot(root);
    }
  });

  test("a step that throws is recorded as refused and partial and the next campaign still runs", async () => {
    const { root, output } = sampleTree();
    try {
      const hashedCtx: HashedContext = {
        ...ctxWith(root, output),
        expectedHashes: new Map(),
      };
      const step = vi.fn(async (): Promise<CampaignResult> => {
        throw new Error("step blew up");
      });
      const entries: CampaignEntry[] = [];
      const counts = await applyCampaigns(
        hashedCtx,
        [
          { slug: "first", sourcePath: join(root, "briefs", "camp.yaml") },
          { slug: "second", sourcePath: join(root, "briefs", "camp.yaml") },
        ],
        [step],
        async (entry: CampaignEntry) => {
          entries.push(entry);
        },
      );
      expect(step).toHaveBeenCalledTimes(2);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        slug: "first",
        outcome: "refused",
        reason: "step blew up",
        partial: true,
      });
      expect(entries[0]!.minted).toEqual({ assets: [] });
      expect(entries[1]).toMatchObject({
        slug: "second",
        outcome: "refused",
        reason: "step blew up",
        partial: true,
      });
      expect(counts.refused).toBe(2);
      expect(counts.partial).toBe(true);
    } finally {
      dropRoot(root);
    }
  });

  test("the result writer is closed when a step throws", async () => {
    const result = freshResult("throw-close");
    try {
      const handle = await openResult(result);
      const writer = new ResultWriter(handle, SWITCHED_AT, "local", "digest");
      const closeSpy = vi.spyOn(writer, "close");
      await writer.header();
      const step = vi.fn(async (): Promise<CampaignResult> => {
        throw new Error("step blew up");
      });
      const counts = await applyCampaigns(
        { ...ctxWith(result, result), expectedHashes: new Map() },
        [{ slug: "camp", sourcePath: join(result, "camp.yaml") }],
        [step],
        async (entry: CampaignEntry) => {
          await writer.add(entry);
        },
      );
      await writer.summary(counts);
      await writer.close();
      expect(closeSpy).toHaveBeenCalled();
      const lines = readFileSync(result, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).kind).toBe("header");
      expect(JSON.parse(lines[1]).kind).toBe("campaign");
      expect(JSON.parse(lines[1]).slug).toBe("camp");
      expect(JSON.parse(lines[1]).outcome).toBe("refused");
      expect(JSON.parse(lines[1]).partial).toBe(true);
      expect(JSON.parse(lines[2]).kind).toBe("summary");
    } finally {
      rmSync(result, { force: true });
    }
  });

  test("a partial campaign makes apply exit 1 and a refusal before any write exits 0", async () => {
    // A campaign that writes a row and then fails on its only asset write is
    // partial: exit 1 (the campaign row is left, to be completed by a rerun).
    {
      const { root, output } = sampleTree();
      const result = freshResult("20a");
      try {
        const real = await replannedDigest(root, output);
        env.reinstall();
        setAssetStore(failOnNth(getAssetStore(importTenant("local")), "writeAsset", 1));
        const { deps } = io();
        expect(
          await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
        ).toBe(1);
        expect((await counts(env)).campaigns).toBe(1);
        expect(env.objects.putCount).toBe(0);
      } finally {
        dropRoot(root);
        rmSync(result, { force: true });
      }
    }

    // A campaign whose input is missing after the digest was taken is refused
    // before any write: nothing was half-done, so the run exits 3 (not 0) and
    // names the refusal, rather than reading as success.
    {
      const { root, output } = sampleTree();
      rmSync(join(root, "assets/inputs/camp/logo.png"));
      const result = freshResult("20b");
      try {
        const real = await replannedDigest(root, output);
        env.reinstall();
        const { out, err, deps } = io();
        expect(
          await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
        ).toBe(3);
        expect(err).toEqual([]);
        expect(out).toEqual([
          "0 created, 0 completed, 0 unchanged, 1 refused",
          "1 campaign(s) refused; nothing of theirs was written",
        ]);
      } finally {
        dropRoot(root);
        rmSync(result, { force: true });
      }
    }
  });

  test("a run whose only refusals happened before any write exits 3", async () => {
    const { root, output } = threeCampaignTree();
    try {
      // Removing the shared input refuses every campaign at scan, before any
      // write: a clean refusal, so the run exits 3 with the census and reason.
      rmSync(join(root, "assets/inputs/logo.png"));
      const result = freshResult("3");
      try {
        const real = await replannedDigest(root, output);
        env.reinstall();
        const { out, err, deps } = io();
        expect(
          await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
        ).toBe(3);
        expect(err).toEqual([]);
        expect(out).toEqual([
          "0 created, 0 completed, 0 unchanged, 3 refused",
          "3 campaign(s) refused; nothing of theirs was written",
        ]);
        expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
      } finally {
        rmSync(result, { force: true });
      }
    } finally {
      dropRoot(root);
    }
  });

  test("plan with a configured target writes no row and no object and the plan JSON holds probes", async () => {
    const { root } = trackedSampleTree();
    const output = join(root, "output");
    mkdirSync(output, { recursive: true });
    try {
      env.reinstall();
      const { out, deps } = io();
      expect(
        await main(planArgv(root, output, ["--include-samples", "--org", "local"]), deps),
      ).toBe(0);
      const plan = JSON.parse(out[3]!) as { probes: unknown; probesSkipped: unknown };
      expect(plan.probes).not.toBeNull();
      expect(plan.probesSkipped).toBeNull();
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
      expect(env.objects.putCount).toBe(0);
    } finally {
      dropRoot(root);
    }
  });

  test("plan lists probes for each slug when the target is postgres and s3", async () => {
    const root = makeRoot();
    const output = join(root, "output");
    mkdirSync(output, { recursive: true });
    try {
      for (const slug of ["absent", "completable", "unchanged", "refused"]) {
        writeAt(root, `assets/inputs/${slug}/logo.png`, PNG);
        writeBrief(root, `${slug}.yaml`, {
          id: slug,
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: `assets/inputs/${slug}/logo.png`,
            },
          ],
        });
      }
      const ctx = ctxWith(root, output);
      const expectedHashes = (await replan(ctx)).expectedHashes;
      const hashedCtx: HashedContext = { ...ctx, expectedHashes };
      env.reinstall();
      // Seed the target states the probes will find: a versionless row (completable),
      // a versionful row whose asset is missing (refused), and a fully-imported one (unchanged).
      const briefs = getBriefStore(importTenant("local"));
      await briefs.createCampaign("completable");
      await briefs.createCampaign("refused");
      await briefs.createBrief(
        briefBody({
          id: "refused",
          products: [
            {
              id: "p1",
              name: "P1",
              primaryColor: "#111111",
              logoPath: "assets/inputs/refused/logo.png",
            },
          ],
        }),
      );
      await importCampaignStep(hashedCtx, {
        slug: "unchanged",
        sourcePath: join(root, "briefs", "unchanged.yaml"),
      });
      env.reinstall();
      const { out, deps } = io();
      expect(await main(planArgv(root, output, ["--org", "local"]), deps)).toBe(0);
      const plan = JSON.parse(out[3]!) as {
        probes: { slug: string; state: string; reason?: string }[];
      };
      expect(plan.probes).toHaveLength(4);
      const bySlug = Object.fromEntries(plan.probes.map((p) => [p.slug, p.state]));
      expect(bySlug).toEqual({
        absent: "absent",
        completable: "completable",
        unchanged: "unchanged",
        refused: "refused",
      });
    } finally {
      dropRoot(root);
    }
  });

  test("plan lists no probes and says why when the target is not postgres and s3", async () => {
    const { root } = trackedSampleTree();
    const output = join(root, "output");
    mkdirSync(output, { recursive: true });
    try {
      // STORE_BACKEND=fs → backend fs-only → no campaign rows to probe.
      env.reinstall();
      process.env.STORE_BACKEND = "fs";
      const { out, deps } = io();
      expect(await main(planArgv(root, output, ["--include-samples"]), deps)).toBe(0);
      const plan = JSON.parse(out[3]!) as { probes: unknown; probesSkipped: string | null };
      expect(plan.probes).toBeNull();
      expect(plan.probesSkipped).toBe("needs STORE_BACKEND=postgres and OBJECT_STORE=s3");

      // OBJECT_STORE=fs (STORE_BACKEND=postgres) → backend is postgres but the store
      // is not s3, so the probe is still skipped and the reason is the same.
      env.reinstall();
      process.env.STORE_BACKEND = "postgres";
      process.env.OBJECT_STORE = "fs";
      const { out: out2, deps: deps2 } = io();
      expect(
        await main(planArgv(root, output, ["--include-samples", "--org", "local"]), deps2),
      ).toBe(0);
      const plan2 = JSON.parse(out2[3]!) as { probes: unknown; probesSkipped: string | null };
      expect(plan2.probes).toBeNull();
      expect(plan2.probesSkipped).toBe("needs STORE_BACKEND=postgres and OBJECT_STORE=s3");
    } finally {
      dropRoot(root);
    }
  });

  test("apply refuses --out as a flag it takes and writes nothing", async () => {
    const { root, output } = sampleTree();
    const result = freshResult("A");
    try {
      env.reinstall();
      const { err, deps } = io();
      expect(
        await main(
          applyArgv(root, output, [
            "--expect",
            "0".repeat(64),
            "--result",
            result,
            "--out",
            "/tmp/x",
          ]),
          deps,
        ),
      ).toBe(1);
      expect(err).toEqual(["--out is not a flag this command takes."]);
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });

  test("plan refuses --expect and --result as flags it takes", async () => {
    const { root, output } = sampleTree();
    try {
      for (const [flag, value] of [
        ["--expect", "deadbeef"],
        ["--result", "/tmp/x"],
      ] as const) {
        env.reinstall();
        const { err, deps } = io();
        expect(await main(planArgv(root, output, [flag, value]), deps)).toBe(1);
        expect(err).toEqual([`${flag} is not a flag this command takes.`]);
        expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
      }
    } finally {
      dropRoot(root);
    }
  });

  test("apply with an unwritable result path exits 1", async () => {
    const { root, output } = sampleTree();
    const badResult = join(tmpdir(), `cf-no-such-dir-${process.pid}`, "result.json");
    try {
      const real = await replannedDigest(root, output);
      env.reinstall();
      const { err, deps } = io();
      expect(
        await main(applyArgv(root, output, ["--expect", real, "--result", badResult]), deps),
      ).toBe(1);
      expect(err.length).toBe(1);
      expect(await counts(env)).toEqual({ campaigns: 0, assets: 0, versions: 0, puts: 0 });
    } finally {
      dropRoot(root);
      rmSync(badResult, { force: true });
    }
  });

  test("replan fingerprints a planned render and excludes it from the reviewed hashes", async () => {
    const root = makeRoot();
    const output = join(root, "output");
    try {
      writeAt(root, "assets/inputs/camp/logo.png", PNG);
      writeBrief(root, "camp.yaml", {
        id: "camp",
        products: [
          {
            id: "p1",
            name: "P1",
            primaryColor: "#111111",
            logoPath: "assets/inputs/camp/logo.png",
          },
        ],
      });
      const renderDir = join(output, "camp");
      mkdirSync(renderDir, { recursive: true });
      writeAt(root, "output/camp/logo.png", PNG);
      writeAt(
        root,
        "output/reports/camp.json",
        JSON.stringify({ outputPath: "camp/logo.png", proofPath: "../../etc/passwd" }),
      );
      const { files, expectedHashes } = await replan(ctxWith(root, output));
      const renderEntry = files.find((f) => f.rel === "camp/logo.png");
      expect(renderEntry).toBeDefined();
      expect(renderEntry!.sha256).toBeUndefined();
      expect(renderEntry!.fingerprint).toBeDefined();
      expect(expectedHashes.has("camp/logo.png")).toBe(false);
      expect(expectedHashes.has("briefs/camp.yaml")).toBe(true);
    } finally {
      dropRoot(root);
    }
  });

  test("planProbes refuses a campaign whose brief is not in the reviewed digest", async () => {
    const { root, output } = sampleTree();
    try {
      const ctx = ctxWith(root, output);
      const scanned = (await replan(ctx)).result.campaigns[0]!;
      const probes = await planProbes(ctx, [scanned], new Map());
      expect(probes).toEqual([{ slug: "camp", state: "refused", reason: expect.any(String) }]);
    } finally {
      dropRoot(root);
    }
  });

  test("planProbes refuses a campaign when the probe itself throws", async () => {
    const { root, output } = sampleTree();
    try {
      const ctx = ctxWith(root, output);
      const { expectedHashes, result } = await replan(ctx);
      const scanned = result.campaigns[0]!;
      env.reinstall();
      setBriefStore(failOnNth(getBriefStore(importTenant("local")), "campaignMeta", 1));
      const probes = await planProbes(ctx, [scanned], expectedHashes);
      expect(probes[0]!.state).toBe("refused");
      expect(probes[0]!.reason).toBeDefined();
    } finally {
      dropRoot(root);
    }
  });

  test("describeResultRefusal reports 'already exists' when the result path is absent", async () => {
    const path = freshResult("XR");
    try {
      expect(await describeResultRefusal(path)).toBe(
        `--result ${JSON.stringify(path)} already exists`,
      );
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("describeResultRefusal reports an interrupted run when the result file is empty", async () => {
    const path = freshResult("XE");
    try {
      writeFileSync(path, "");
      expect(await describeResultRefusal(path)).toBe(
        `the result file ${JSON.stringify(path)} exists and has no summary ` +
          "line: it is the record of an interrupted run. Keep it, and give this run a new --result path.",
      );
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("a non-Error result-write failure still surfaces as a 'could not write the result file' error", async () => {
    const { root, output } = threeCampaignTree();
    const result = freshResult("XN");
    try {
      const real = await replannedDigest(root, output);
      env.reinstall();
      const originalAdd = ResultWriter.prototype.add;
      let calls = 0;
      const spy = vi.spyOn(ResultWriter.prototype, "add").mockImplementation(async function (
        this: ResultWriter,
        entry: CampaignEntry,
      ) {
        calls++;
        if (calls === 3) throw "simulated non-error write failure";
        return originalAdd.call(this, entry);
      });
      const { err, deps } = io();
      try {
        expect(
          await main(applyArgv(root, output, ["--expect", real, "--result", result]), deps),
        ).toBe(1);
        expect(err.length).toBe(1);
        expect(err[0]).toContain("could not write the result file");
        expect(err[0]).toContain(result);
      } finally {
        spy.mockRestore();
      }
    } finally {
      dropRoot(root);
      rmSync(result, { force: true });
    }
  });
});
