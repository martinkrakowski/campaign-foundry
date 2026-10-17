import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PutObjectOptions } from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import { renderObjectKey } from "@campaignfoundry/Distribution";
import { main } from "../../../../bin/import.js";
import { hashBytes } from "../../brief-files.js";
import { setObjectStoreClient } from "../../object-store/index.js";
import { orgPrefix, renderPrefix } from "../../object-store/object-keys.js";
import { PgReportStore } from "../../ports/pg-report-store.js";
import { replan, ResultWriter, type CampaignEntry } from "../apply.js";
import { importRendersStep } from "../renders-step.js";
import type { StepContext, StepLine } from "../steps.js";
import {
  CountingObjects,
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import { PNG, dropRoot, makeRoot, writeAt, writeBrief } from "./fixtures/tree.js";

const SWITCHED_AT = "2026-10-01T00:00:00Z";
type Env = Awaited<ReturnType<typeof useApplyEnvironment>>;

const ONE = "camp/p1/1x1.png";
const VIDEO = "camp/p1/9x16.mp4";
const WIDE = "camp/p1/16x9.png";
const GONE = "camp/p1/4x5.png";
// A path of the old shape: its first segment is a product id, not the campaign's slug.
const OLD_SHAPE = "city-backpack/1x1/hero.png";
// The same campaign, written in a way the key builder does not accept.
const DOTTED = "./camp/p1/dotted.png";
const NOT_THIS_CAMPAIGN =
  "Refusing an object key: a render path must start with the campaign segment its prefix was built for.";
const NOT_WRITTEN = "not written: this run neither wrote nor skipped the report for camp";
const BYTES: Record<string, Buffer> = {
  [ONE]: Buffer.from("the first render"),
  [VIDEO]: Buffer.from("a video, a little longer"),
  [WIDE]: Buffer.from("the wide render"),
};

/** The harness's counting store; `failKeyEnding` makes the `put` of a matching key throw. */
class FailingStore extends CountingObjects {
  failKeyEnding: string | undefined;

  override async put(key: string, bytes: Uint8Array, options?: PutObjectOptions): Promise<void> {
    if (this.failKeyEnding !== undefined && key.endsWith(this.failKeyEnding)) {
      throw new Error("injected");
    }
    await super.put(key, bytes, options);
  }
}

/** One campaign `camp` whose report names `paths` (one row each); `files` are the render files on disk. */
function tree(
  paths: readonly string[],
  files: Record<string, Buffer>,
): { root: string; output: string; report: Buffer } {
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
  const rows = paths.map((outputPath) => ({ outputPath }));
  const report = Buffer.from(JSON.stringify({ assets: rows }), "utf8");
  writeAt(output, "reports/camp.json", report);
  for (const [path, bytes] of Object.entries(files)) writeAt(output, path, bytes);
  return { root, output, report };
}

function ctxWith(root: string, output: string): StepContext {
  return {
    orgId: "local",
    switchedAt: new Date(SWITCHED_AT),
    projectRoot: root,
    outputRoot: output,
    includeSamples: false,
    fsOnly: false,
  };
}

type Line = Record<string, unknown>;
type Applied = {
  code: number;
  out: string[];
  err: string[];
  all: Line[];
  line: CampaignEntry;
  summary: Line;
};

const kinds = (applied: Applied): unknown[] => applied.all.map((line) => line.kind);
const objectLines = (applied: Applied): Line[] =>
  applied.all.filter((line) => line.kind === "object");
const statuses = (line: CampaignEntry): string[] =>
  (line.renders ?? []).map((render) => `${render.path}:${render.status}`);
const keyOf = (campaignId: string, path: string): string =>
  renderObjectKey(renderPrefix("local", campaignId), "camp", path);

const results: string[] = [];

/** Run `apply` on the tree with its real digest; answers the exit code, stdout, stderr and the result file's lines. */
async function apply(env: Env, root: string, output: string, label: string): Promise<Applied> {
  const digest = (await replan(ctxWith(root, output))).digest;
  env.reinstall();
  const out: string[] = [];
  const err: string[] = [];
  const result = join(tmpdir(), `cf-apply-renders-${label}-${process.pid}.jsonl`);
  rmSync(result, { force: true });
  results.push(result);
  const argv = ["apply", "--project-root", root, "--output-root", output];
  argv.push("--switched-at", SWITCHED_AT, "--org", "local", "--expect", digest, "--result", result);
  const code = await main(argv, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  const all = readFileSync(result, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Line);
  const line = all.find((entry) => entry.kind === "campaign") as unknown as CampaignEntry;
  return {
    code,
    out,
    err,
    all,
    line,
    summary: all.find((entry) => entry.kind === "summary") ?? {},
  };
}

describe.skipIf(ON_A_REAL_TEST_SERVER)("apply: a campaign's renders", () => {
  let env: Env;
  let objects: FailingStore;
  let root: string | undefined;
  beforeEach(async () => {
    env = await useApplyEnvironment();
    // A clock that steps: an object written twice would show a later time in a listing.
    let tick = Date.parse("2026-10-11T00:00:00Z");
    objects = new FailingStore(new InMemoryObjectStore({ now: () => (tick += 1000) }));
    setObjectStoreClient(objects);
    env.reinstall();
  });
  afterEach(async () => {
    await restoreApplyEnvironment();
    dropRoot(root);
    root = undefined;
    for (const path of results.splice(0)) rmSync(path, { force: true });
  });

  /** The keys of every render object the store holds, sorted. */
  const renderKeys = async (): Promise<string[]> =>
    (await objects.list(orgPrefix("local")))
      .map((object) => object.key)
      .filter((key) => key.includes("/renders/"))
      .sort();

  test("apply writes each render the reviewed report names, prints its key, and gives it a line in the result file before the campaign's line", async () => {
    const t = tree([ONE, VIDEO, WIDE], BYTES);
    root = t.root;
    const got = await apply(env, t.root, t.output, "w1");
    expect(got.err).toEqual([]);
    expect(got.code).toBe(0);
    const id = got.line.minted.campaignId!;
    const minted = [ONE, VIDEO, WIDE].map((path) => ({ key: keyOf(id, path), path }));
    expect(got.line.renders).toEqual(
      minted.map(({ key, path }) => ({ path, status: "written", key })),
    );
    expect(got.line.partial).toBeUndefined();
    expect(kinds(got)).toEqual(["header", "object", "object", "object", "campaign", "summary"]);
    expect(objectLines(got)).toEqual(minted.map((object) => ({ kind: "object", ...object })));
    expect(got.line.minted.objects).toEqual(minted);
    expect(got.summary).toMatchObject({ objectsMinted: 3, partial: false });
    for (const { key, path } of minted) {
      const stored = await objects.get(key);
      expect(Buffer.from(stored!.bytes).equals(BYTES[path]!)).toBe(true);
      const printed = got.out.indexOf(`camp: minted render ${path} ${key}`);
      expect(printed).toBeGreaterThanOrEqual(0);
      expect(printed).toBeLessThan(got.out.indexOf("camp: created"));
      expect(got.out).toContain(`  render ${path}: written`);
    }
    expect((await objects.get(keyOf(id, VIDEO)))!.contentType).toBe("video/mp4");
    // The recorded keys are exactly the render objects the store now holds.
    expect(await renderKeys()).toEqual(minted.map((object) => object.key).sort());
  });

  test("a second apply writes nothing: every render is skipped, no object is recorded, and the stored objects are as they were", async () => {
    const t = tree([ONE, VIDEO, WIDE], BYTES);
    root = t.root;
    const first = await apply(env, t.root, t.output, "w2a");
    expect(first.code).toBe(0);
    const before = await objects.list(orgPrefix("local"));
    const second = await apply(env, t.root, t.output, "w2b");
    expect(second.code).toBe(0);
    expect(statuses(second.line)).toEqual([
      `${ONE}:skipped`,
      `${VIDEO}:skipped`,
      `${WIDE}:skipped`,
    ]);
    expect(kinds(second)).toEqual(["header", "campaign", "summary"]);
    expect(second.line.minted.objects).toBeUndefined();
    expect(second.summary).toMatchObject({ objectsMinted: 0, partial: false });
    expect(second.out.join("\n")).not.toContain("minted render");
    // Key, size, etag and time of every object: an overwrite would show a later time.
    expect(await objects.list(orgPrefix("local"))).toEqual(before);
  });

  test("a put that fails on the second render: the first is recorded, the failed one is not, the rest are not tried, exit 1; the next apply finishes them", async () => {
    const t = tree([ONE, VIDEO, WIDE], BYTES);
    root = t.root;
    objects.failKeyEnding = "/renders/p1/9x16.mp4";
    const first = await apply(env, t.root, t.output, "w3a");
    expect(first.code).toBe(1);
    const id = first.line.minted.campaignId!;
    expect(first.line.renders).toEqual([
      { path: ONE, status: "written", key: keyOf(id, ONE) },
      { path: VIDEO, status: "failed", key: keyOf(id, VIDEO), reason: "injected" },
    ]);
    expect(first.line.partial).toBe(true);
    expect(first.line.stepError).toBeUndefined();
    expect(objectLines(first)).toEqual([{ kind: "object", key: keyOf(id, ONE), path: ONE }]);
    expect(first.line.minted.objects).toEqual([{ key: keyOf(id, ONE), path: ONE }]);
    expect(first.summary).toMatchObject({ objectsMinted: 1, partial: true });
    expect(await renderKeys()).toEqual([keyOf(id, ONE)]);

    objects.failKeyEnding = undefined;
    const second = await apply(env, t.root, t.output, "w3b");
    expect(second.code).toBe(0);
    expect(statuses(second.line)).toEqual([
      `${ONE}:skipped`,
      `${VIDEO}:written`,
      `${WIDE}:written`,
    ]);
    const finished = [VIDEO, WIDE].map((path) => ({ key: keyOf(id, path), path }));
    expect(objectLines(second)).toEqual(finished.map((object) => ({ kind: "object", ...object })));
    expect(second.line.minted.objects).toEqual(finished);
  });

  test("a different render already stored is refused and never overwritten; the line is partial and the run exits 1", async () => {
    const t = tree([ONE], { [ONE]: BYTES[ONE]! });
    root = t.root;
    const first = await apply(env, t.root, t.output, "w4a");
    expect(first.code).toBe(0);
    const key = keyOf(first.line.minted.campaignId!, ONE);
    const before = await objects.list(orgPrefix("local"));
    // The file changes after the first import; the new plan is reviewed and applied.
    writeAt(t.output, ONE, Buffer.from("another render under the same path, and longer"));
    const second = await apply(env, t.root, t.output, "w4b");
    expect(second.code).toBe(1);
    expect(second.line.renders).toEqual([
      {
        path: ONE,
        status: "refused",
        key,
        reason: "a different render is already stored for this path",
      },
    ]);
    expect(second.line.partial).toBe(true);
    expect(objectLines(second)).toEqual([]);
    expect(second.summary).toMatchObject({ objectsMinted: 0 });
    expect(Buffer.from((await objects.get(key))!.bytes).equals(BYTES[ONE]!)).toBe(true);
    expect(await objects.list(orgPrefix("local"))).toEqual(before);
    // The report row stays imported.
    expect(second.line.rows?.[0]).toMatchObject({ kind: "report", status: "skipped" });
  });

  test("a missing file makes the line partial and the run exit 1 while the report row stays imported; an object with no file is present and leaves the line clean", async () => {
    const t = tree([ONE, GONE], { [ONE]: BYTES[ONE]! });
    root = t.root;
    const first = await apply(env, t.root, t.output, "w5a");
    expect(first.code).toBe(1);
    const id = first.line.minted.campaignId!;
    expect(first.line.renders).toEqual([
      { path: ONE, status: "written", key: keyOf(id, ONE) },
      { path: GONE, status: "missing", key: keyOf(id, GONE) },
    ]);
    expect(first.line.partial).toBe(true);
    expect(first.line.rows?.[0]).toEqual({
      kind: "report",
      status: "written",
      revision: hashBytes(t.report),
    });
    expect(await new PgReportStore(env.db, "local").getRevision("camp")).toBe(hashBytes(t.report));
    // A render made after the switch: an object at the key, no file in the legacy tree.
    const later = Buffer.from("made after the switch");
    await objects.put(keyOf(id, GONE), later, { contentType: "image/png" });
    const second = await apply(env, t.root, t.output, "w5b");
    expect(second.code).toBe(0);
    expect(statuses(second.line)).toEqual([`${ONE}:skipped`, `${GONE}:present`]);
    expect(second.line.partial).toBeUndefined();
    expect(objectLines(second)).toEqual([]);
    expect(second.line.minted.objects).toBeUndefined();
  });

  test("when a different report is stored no render is written and each path is listed as not written", async () => {
    const t = tree([ONE, VIDEO], BYTES);
    root = t.root;
    const theirs = '{"assets":["a run made after the switch"]}';
    await new PgReportStore(env.db, "local").writeReport("camp", theirs);
    const got = await apply(env, t.root, t.output, "w6");
    expect(got.code).toBe(1);
    expect(got.line.rows?.[0]).toMatchObject({ kind: "report", status: "refused" });
    expect(got.line.renders).toEqual(
      [ONE, VIDEO].map((path) => ({ path, status: "refused", reason: NOT_WRITTEN })),
    );
    expect(got.out).toContain(`  render ${ONE}: refused: ${NOT_WRITTEN}`);
    expect(await renderKeys()).toEqual([]);
    expect(objectLines(got)).toEqual([]);
    expect(await new PgReportStore(env.db, "local").getRevision("camp")).toBe(
      hashBytes(Buffer.from(theirs, "utf8")),
    );
  });

  test("an old-shape path and a path written ./camp/… are refused and nothing is written for them; the report is stored byte for byte", async () => {
    const files = {
      [ONE]: BYTES[ONE]!,
      [OLD_SHAPE]: Buffer.from("an old-shape render"),
      [DOTTED]: Buffer.from("a dotted render"),
    };
    const t = tree([ONE, OLD_SHAPE, DOTTED], files);
    root = t.root;
    const got = await apply(env, t.root, t.output, "w7");
    expect(got.code).toBe(1);
    const id = got.line.minted.campaignId!;
    expect(got.line.renders).toEqual([
      { path: ONE, status: "written", key: keyOf(id, ONE) },
      { path: OLD_SHAPE, status: "refused", reason: NOT_THIS_CAMPAIGN },
      { path: DOTTED, status: "refused", reason: NOT_THIS_CAMPAIGN },
    ]);
    expect(got.line.partial).toBe(true);
    expect(await renderKeys()).toEqual([keyOf(id, ONE)]);
    expect(got.line.rows?.[0]).toEqual({
      kind: "report",
      status: "written",
      revision: hashBytes(t.report),
    });
  });

  test("when an object's line cannot be written the run ends at once: its key is on stdout, the next render is not written, and the error names the result file", async () => {
    const t = tree([ONE, VIDEO, WIDE], BYTES);
    root = t.root;
    const spy = vi.spyOn(ResultWriter.prototype, "object").mockImplementation(async () => {
      const error: NodeJS.ErrnoException = new Error("no space left on device");
      error.code = "ENOSPC";
      throw error;
    });
    try {
      const got = await apply(env, t.root, t.output, "w8");
      expect(got.code).toBe(1);
      expect(got.err).toHaveLength(1);
      expect(got.err[0]).toContain("could not write the result file");
      expect(got.err[0]).toContain("ENOSPC");
      // The one object that was created is named on stdout; nothing was written after it.
      const keys = await renderKeys();
      expect(keys).toHaveLength(1);
      expect(got.out).toContain(`camp: minted render ${ONE} ${keys[0]}`);
      expect(kinds(got)).toEqual(["header"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("plan accepts a path written ./camp/… that apply refuses (a known difference, pinned)", async () => {
    const t = tree([DOTTED], { [DOTTED]: Buffer.from("a dotted render") });
    root = t.root;
    const fields = (await replan(ctxWith(t.root, t.output))).assembled.reports[0]!.fields;
    expect(fields.map((field) => `${field.path}:${field.status}`)).toEqual([`${DOTTED}:ok`]);
  });
});

describe("apply: importRendersStep", () => {
  const CAMP = { slug: "camp", sourcePath: "x" };
  const noLine: StepLine = { rows: [], recordMinted: async () => {} };
  const withReport: StepLine = {
    rows: [{ kind: "report", status: "written", revision: "r1" }],
    recordMinted: async () => {},
  };
  const bare = ctxWith("/nowhere", "/nowhere");

  test("a campaign with no report row names no render: nothing is read and nothing is needed", async () => {
    expect(await importRendersStep(bare, CAMP, noLine)).toEqual({ rows: [] });
  });

  test("with a report row, a context without the reviewed hashes or without the render fingerprints is an error, never a silent import", async () => {
    const wanted = "no reviewed render fingerprints in the step context";
    await expect(importRendersStep(bare, CAMP, withReport)).rejects.toThrow(wanted);
    const hashed = { ...bare, expectedHashes: new Map<string, string>() };
    await expect(importRendersStep(hashed, CAMP, withReport)).rejects.toThrow(wanted);
  });
});
