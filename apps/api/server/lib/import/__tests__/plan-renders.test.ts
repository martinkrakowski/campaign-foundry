import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderObjectKey } from "@campaignfoundry/Distribution";
import { main } from "../../../../bin/import.js";
import { renderPrefix } from "../../object-store/object-keys.js";
import { getBriefStore } from "../../ports/index.js";
import { PgReportStore } from "../../ports/pg-report-store.js";
import { importTenant } from "../import-tenant.js";
import { planRenderProbes } from "../renders-plan.js";
import {
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import { PNG, briefBody, dropRoot, makeRoot, writeAt, writeBrief } from "./fixtures/tree.js";

const SWITCHED_AT = "2026-10-01T00:00:00Z";
type Env = Awaited<ReturnType<typeof useApplyEnvironment>>;

const ONE = "camp/p1/1x1.png";
const VIDEO = "camp/p1/9x16.mp4";
const GONE = "camp/p1/4x5.png";
const WIDE = "camp/p1/16x9.png";
const OTHER = "other/p1/1x1.png";
const ALL = [ONE, VIDEO, GONE, WIDE, OTHER];
const ONE_BYTES = Buffer.from("the bytes of the first render");
const VIDEO_BYTES = Buffer.from("a video");
const STORED_VIDEO = Buffer.from("a video of another size, stored after the switch");
const OTHER_REFUSED =
  "Refusing an object key: a render path must start with the campaign segment its prefix was built for.";
const PRODUCT = {
  id: "p1",
  name: "P1",
  primaryColor: "#111111",
  logoPath: "assets/inputs/camp/logo.png",
};
/** A report as the application writes one: the render paths are on the rows of `assets`. */
const REPORT = {
  assets: [
    { outputPath: ONE, videoPath: VIDEO },
    { outputPath: GONE },
    { outputPath: WIDE },
    { outputPath: OTHER },
  ],
};

/** One campaign `camp` with a report naming five paths; three of the files are on disk. */
function tree(): { root: string; output: string } {
  const root = makeRoot();
  const output = join(root, "output");
  mkdirSync(output, { recursive: true });
  writeAt(root, "assets/inputs/camp/logo.png", PNG);
  writeBrief(root, "camp.yaml", { id: "camp", products: [PRODUCT] });
  writeAt(output, "reports/camp.json", JSON.stringify(REPORT));
  writeAt(output, ONE, ONE_BYTES);
  writeAt(output, VIDEO, VIDEO_BYTES);
  writeAt(output, WIDE, ONE_BYTES);
  return { root, output };
}

type Render = { path: string; predicted: string; key?: string; reason?: string };
type Probe = {
  slug: string;
  state: string;
  rows?: { kind: string; predicted: string }[];
  renders?: Render[];
};
type PlanJson = {
  digest: string;
  probes: Probe[];
  reports: { slug: string; fields: { path: string }[] }[];
};
type Planned = {
  code: number;
  err: string[];
  digest: string;
  fields: string[];
  probe: Probe;
  writes: string[];
};

/** Any statement that changes a row. */
const WRITE = /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;

/** Run `plan` on the tree against the harness's target. `writes` must always be empty. */
async function plan(env: Env, root: string, output: string): Promise<Planned> {
  env.reinstall();
  const out: string[] = [];
  const err: string[] = [];
  const from = env.queries.length;
  const code = await main(
    [
      "plan",
      "--project-root",
      root,
      "--output-root",
      output,
      "--switched-at",
      SWITCHED_AT,
      "--org",
      "local",
    ],
    { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
  );
  const json = JSON.parse(out[3]!) as PlanJson;
  return {
    code,
    err,
    digest: json.digest,
    fields: json.reports.flatMap((report) => report.fields.map((field) => field.path)).sort(),
    probe: json.probes[0]!,
    writes: env.queries.slice(from).filter((text) => WRITE.test(text)),
  };
}

/** The predictions by path: the order of a report's paths is the plan's, not this test's. */
const byPath = (renders: Render[] | undefined): Record<string, Render> =>
  Object.fromEntries((renders ?? []).map((render) => [render.path, render]));

describe.skipIf(ON_A_REAL_TEST_SERVER)("plan: predicted renders", () => {
  let env: Env;
  let root: string | undefined;
  beforeEach(async () => {
    env = await useApplyEnvironment();
  });
  afterEach(async () => {
    dropRoot(root);
    root = undefined;
    await restoreApplyEnvironment();
  });

  test("on an empty target each reviewed render is a write with no key, and plan writes and puts nothing", async () => {
    const t = tree();
    root = t.root;
    const got = await plan(env, t.root, t.output);
    expect(got.err).toEqual([]);
    expect(got.code).toBe(0);
    expect(got.fields).toEqual([...ALL].sort());
    expect(got.probe.state).toBe("absent");
    expect(byPath(got.probe.renders)).toEqual({
      [ONE]: { path: ONE, predicted: "write" },
      [VIDEO]: { path: VIDEO, predicted: "write" },
      [WIDE]: { path: WIDE, predicted: "write" },
      [GONE]: { path: GONE, predicted: "missing" },
      [OTHER]: { path: OTHER, predicted: "path-refused", reason: OTHER_REFUSED },
    });
    expect(got.writes).toEqual([]);
    expect(env.objects.putCount).toBe(0);
  });

  test("with the campaign in the target the prediction follows the stored objects by size, and the digest does not move", async () => {
    const t = tree();
    root = t.root;
    const empty = await plan(env, t.root, t.output);
    env.reinstall();
    const created = await getBriefStore(importTenant("local")).createCampaign("camp", {});
    const key = (path: string): string =>
      renderObjectKey(renderPrefix("local", created.campaignId), "camp", path);
    await env.objects.put(key(ONE), ONE_BYTES, { contentType: "image/png" });
    await env.objects.put(key(VIDEO), STORED_VIDEO, { contentType: "video/mp4" });
    await env.objects.put(key(GONE), ONE_BYTES, { contentType: "image/png" });
    const puts = env.objects.putCount;
    const got = await plan(env, t.root, t.output);
    expect(got.err).toEqual([]);
    expect(got.probe.state).toBe("completable");
    expect(byPath(got.probe.renders)).toEqual({
      [ONE]: { path: ONE, predicted: "already-there", key: key(ONE) },
      [VIDEO]: {
        path: VIDEO,
        predicted: "refuse",
        key: key(VIDEO),
        reason: `a render of another size is already stored for this path (stored ${STORED_VIDEO.length} bytes, the file ${VIDEO_BYTES.length} bytes)`,
      },
      [WIDE]: { path: WIDE, predicted: "write", key: key(WIDE) },
      [GONE]: { path: GONE, predicted: "present", key: key(GONE) },
      [OTHER]: { path: OTHER, predicted: "path-refused", reason: OTHER_REFUSED },
    });
    expect(got.writes).toEqual([]);
    expect(env.objects.putCount).toBe(puts);
    expect(got.digest).toBe(empty.digest);
  });
  test("when a different report is stored every render is listed as not written", async () => {
    const t = tree();
    root = t.root;
    await new PgReportStore(env.db, "local").writeReport(
      "camp",
      '{"assets":["a run made after the switch"]}',
    );
    const got = await plan(env, t.root, t.output);
    expect(got.code).toBe(0);
    expect(got.probe.rows?.[0]).toMatchObject({ kind: "report", predicted: "refuse" });
    const reason = "not written: this run would neither write nor skip the report for camp";
    expect(byPath(got.probe.renders)).toEqual(
      Object.fromEntries(ALL.map((path) => [path, { path, predicted: "refuse", reason }])),
    );
    expect(got.writes).toEqual([]);
    expect(env.objects.putCount).toBe(0);
  });

  test("a campaign whose probe is refused gets no render prediction", async () => {
    const t = tree();
    root = t.root;
    // A same-slug campaign a user created after the switch, with another body.
    env.reinstall();
    const briefs = getBriefStore(importTenant("local"));
    await briefs.createCampaign("camp", {});
    await briefs.createBrief(
      briefBody({ id: "camp", products: [{ ...PRODUCT, name: "SOMEONE ELSE" }] }),
    );
    const got = await plan(env, t.root, t.output);
    expect(got.code).toBe(0);
    expect(got.probe.state).toBe("refused");
    expect("renders" in got.probe).toBe(false);
  });

  test("a probe with no rows and no report in the plan gets an empty list", async () => {
    const t = tree();
    root = t.root;
    env.reinstall();
    const ctx = {
      orgId: "local",
      switchedAt: new Date(SWITCHED_AT),
      projectRoot: t.root,
      outputRoot: t.output,
      includeSamples: false,
      fsOnly: false,
    };
    const got = await planRenderProbes(ctx, [{ slug: "camp", state: "absent" }], [], []);
    expect(got).toEqual([{ slug: "camp", state: "absent", renders: [] }]);
  });
});
