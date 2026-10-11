import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main } from "../../../../bin/import.js";
import { getAssetStore, getBriefStore } from "../../ports/index.js";
import { importTenant } from "../import-tenant.js";
import {
  ON_A_REAL_TEST_SERVER,
  restoreApplyEnvironment,
  useApplyEnvironment,
} from "./fixtures/apply-harness.js";
import {
  HTML_LAYER_REFUSAL,
  PNG,
  briefBody,
  dropRoot,
  makeRoot,
  writeAt,
} from "./fixtures/tree.js";

const SWITCHED_AT = "2026-10-01T00:00:00Z";
type Env = Awaited<ReturnType<typeof useApplyEnvironment>>;

/** The section as the plan JSON holds it. Typed here, so the test does not lean on the code's own type. */
type Section = {
  campaigns: {
    slug: string;
    revision: string;
    state: string;
    refs?: { ref: string; kind: string }[];
    reason?: string;
  }[];
  normalise: number;
  refs: number;
  refused: number;
};
type Planned = {
  code: number;
  err: string[];
  lines: number;
  digest: string;
  existing: Section | null;
  probesSkipped: string | null;
  writes: string[];
};

/** Any statement that changes a row. */
const WRITE = /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;
const EMPTY: Section = { campaigns: [], normalise: 0, refs: 0, refused: 0 };

/** An empty legacy tree: `briefs/` with no brief, and the two root-level files the refs name. */
function tree(): { root: string; output: string } {
  const root = makeRoot();
  const output = join(root, "output");
  mkdirSync(output, { recursive: true });
  mkdirSync(join(root, "briefs"), { recursive: true });
  writeAt(root, "assets/inputs/a.png", PNG);
  writeAt(root, "assets/inputs/b.png", PNG);
  return { root, output };
}

/** Run `plan` against the harness's target; `writes` is every INSERT, UPDATE or DELETE it sent. */
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
  const json = JSON.parse(out[3] ?? "{}") as {
    digest: string;
    existingCampaigns: Section | null;
    probesSkipped: string | null;
  };
  return {
    code,
    err,
    lines: out.length,
    digest: json.digest,
    existing: json.existingCampaigns,
    probesSkipped: json.probesSkipped,
    writes: env.queries.slice(from).filter((text) => WRITE.test(text)),
  };
}

const briefs = () => getBriefStore(importTenant("local"));
const product = (logoPath: string, inputAsset?: string) => ({
  id: "p1",
  name: "P1",
  primaryColor: "#111111",
  logoPath,
  ...(inputAsset === undefined ? {} : { inputAsset }),
});

describe.skipIf(ON_A_REAL_TEST_SERVER)(
  "plan: existing campaigns that still carry a path ref",
  () => {
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
    test("an existing campaign whose latest version carries path refs is listed with each ref classified, and plan writes nothing", async () => {
      const t = tree();
      root = t.root;
      writeAt(t.root, "assets/inputs/old/logo.png", PNG);
      const stored = await briefs().createBrief(
        briefBody({
          id: "old",
          products: [product("assets/inputs/old/logo.png", "assets/inputs/a.png")],
        }),
      );
      const got = await plan(env, t.root, t.output);
      expect(got.err).toEqual([]);
      expect(got.code).toBe(0);
      expect(got.lines).toBe(5);
      expect(got.existing).toEqual({
        campaigns: [
          {
            slug: "old",
            revision: stored.revision,
            state: "normalise",
            refs: [
              { ref: "assets/inputs/old/logo.png", kind: "own-campaign" },
              { ref: "assets/inputs/a.png", kind: "root-level" },
            ],
          },
        ],
        normalise: 1,
        refs: 2,
        refused: 0,
      });
      expect(got.writes).toEqual([]);
      expect(env.objects.putCount).toBe(0);
    });
    test("the latest version decides; an id ref, a campaign with only ids and a versionless campaign are not listed", async () => {
      const t = tree();
      root = t.root;
      await briefs().createBrief(
        briefBody({ id: "moved", products: [product("assets/inputs/a.png")] }),
      );
      const second = await briefs().rewriteBrief(
        briefBody({ id: "moved", products: [product("assets/inputs/b.png")] }),
      );
      const assets = getAssetStore(importTenant("local"));
      await briefs().createCampaign("clean");
      const clean = await assets.writeAsset("clean", "logo.png", PNG);
      await briefs().createBrief(
        briefBody({ id: "clean", products: [product(clean.id as string)] }),
      );
      await briefs().createCampaign("mixed");
      const mixed = await assets.writeAsset("mixed", "logo.png", PNG);
      await briefs().createBrief(
        briefBody({ id: "mixed", products: [product(mixed.id as string, "assets/inputs/a.png")] }),
      );
      await briefs().createCampaign("blank");
      const got = await plan(env, t.root, t.output);
      expect(got.err).toEqual([]);
      expect(got.existing).toEqual({
        campaigns: [
          {
            slug: "mixed",
            revision: expect.stringMatching(/^[0-9a-f]{64}$/),
            state: "normalise",
            refs: [{ ref: "assets/inputs/a.png", kind: "root-level" }],
          },
          {
            slug: "moved",
            revision: second.revision,
            state: "normalise",
            refs: [{ ref: "assets/inputs/b.png", kind: "root-level" }],
          },
        ],
        normalise: 2,
        refs: 2,
        refused: 0,
      });
      expect(got.writes).toEqual([]);
    });
    test("a latest body that does not parse is listed refused with the parser's message, never dropped", async () => {
      const t = tree();
      root = t.root;
      const setBody = (slug: string, body: string) =>
        env.db.query(
          "update brief_version set body = $1 where campaign_id = (select id from campaign where org_id = 'local' and slug = $2)",
          [body, slug],
        );
      const html = await briefs().createBrief(
        briefBody({ id: "old-html", products: [product("assets/inputs/a.png")] }),
      );
      const htmlBody = JSON.stringify(html.brief).replace('"kind":"static-text"', '"kind":"html"');
      expect(htmlBody).toContain('"kind":"html"');
      await setBody("old-html", htmlBody);
      const bad = await briefs().createBrief(
        briefBody({ id: "not-json", products: [product("assets/inputs/a.png")] }),
      );
      await setBody("not-json", "{not json");
      const got = await plan(env, t.root, t.output);
      expect(got.err).toEqual([]);
      expect(got.code).toBe(0);
      expect(got.existing).toEqual({
        campaigns: [
          {
            slug: "not-json",
            revision: bad.revision,
            state: "refused",
            reason: expect.stringMatching(/JSON/),
          },
          {
            slug: "old-html",
            revision: html.revision,
            state: "refused",
            reason: HTML_LAYER_REFUSAL,
          },
        ],
        normalise: 0,
        refs: 0,
        refused: 2,
      });
      expect(got.writes).toEqual([]);
    });
    test("a path ref whose file is missing refuses the campaign with the ref named", async () => {
      const t = tree();
      root = t.root;
      const stored = await briefs().createBrief(
        briefBody({
          id: "gone",
          products: [product("assets/inputs/gone/logo.png", "assets/inputs/a.png")],
        }),
      );
      const got = await plan(env, t.root, t.output);
      expect(got.existing).toEqual({
        campaigns: [
          {
            slug: "gone",
            revision: stored.revision,
            state: "refused",
            reason: 'ref "assets/inputs/gone/logo.png": no file at "assets/inputs/gone/logo.png"',
          },
        ],
        normalise: 0,
        refs: 0,
        refused: 1,
      });
      expect(got.writes).toEqual([]);
    });
    test("the section follows the target and the plan digest does not move with it", async () => {
      const t = tree();
      root = t.root;
      const empty = await plan(env, t.root, t.output);
      expect(empty.code).toBe(0);
      expect(empty.digest).toHaveLength(64);
      expect(empty.existing).toEqual(EMPTY);
      await briefs().createBrief(
        briefBody({ id: "old", products: [product("assets/inputs/a.png")] }),
      );
      const full = await plan(env, t.root, t.output);
      expect(full.existing?.normalise).toBe(1);
      expect(full.digest).toBe(empty.digest);
      expect([empty.writes, full.writes]).toEqual([[], []]);
    });

    test("the section is null when the target probes are skipped", async () => {
      const t = tree();
      root = t.root;
      await briefs().createBrief(
        briefBody({ id: "old", products: [product("assets/inputs/a.png")] }),
      );
      process.env.OBJECT_STORE = "fs";
      const got = await plan(env, t.root, t.output);
      expect(got.code).toBe(0);
      expect(got.probesSkipped).toBe("needs STORE_BACKEND=postgres and OBJECT_STORE=s3");
      expect(got.existing).toBeNull();
    });
  },
);
