import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "../../../../bin/import.js";
import { getAssetStore, getBriefStore } from "../../ports/index.js";
import { resolveRefTargets } from "../asset-step.js";
import { existingDigest } from "../existing-campaigns.js";
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

/**
 * `resolveRefTargets` is wrapped so one test can drop a ref target in the
 * synchronous window between the classification's read and the hashing read
 * (`refTargetHashes`'s `readFileSync`) — a window nothing outside the module
 * can reach. The wrapper delegates to the real function on every other call,
 * so every other test runs unchanged.
 */
vi.mock("../asset-step.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../asset-step.js")>();
  return { ...real, resolveRefTargets: vi.fn(real.resolveRefTargets) };
});

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
    drafts?: number;
    files?: { ref: string; sha256: string }[];
  }[];
  normalise: number;
  refs: number;
  refused: number;
  withDraft?: number;
  counts?: unknown;
  digest?: string;
};
type Planned = {
  code: number;
  err: string[];
  lines: number;
  digest: string;
  existing: Section | null;
  /** The whole section as the plan JSON holds it. */
  section: Section | null;
  probesSkipped: string | null;
  writes: string[];
};

/** Any statement that changes a row. */
const WRITE = /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;
const EMPTY: Section = { campaigns: [], normalise: 0, refs: 0, refused: 0 };

/** sha256 in lower-case hex, computed here so the tests do not lean on the code's own hashing. */
const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
/** Another valid PNG: the same magic bytes, one more byte. */
const PNG_2 = Buffer.concat([PNG, Buffer.from([0])]);

/** The keys the later lanes added: to the section, and to each campaign of it. */
const ADDED = {
  section: ["withDraft", "counts", "digest"],
  campaign: ["drafts", "files"],
} as const;

/**
 * The first lane's view of the section: the section and each of its campaigns with only
 * the keys the later lanes added removed, so a leaked key is still seen by the assertions.
 */
function core(section: Section | null): Section | null {
  if (!section) return section;
  const keep = (x: object, dropped: readonly string[]) =>
    Object.fromEntries(Object.entries(x).filter(([key]) => !dropped.includes(key)));
  return {
    ...keep(section, ADDED.section),
    campaigns: section.campaigns.map((c) => keep(c, ADDED.campaign)),
  } as Section;
}

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
    existing: core(json.existingCampaigns),
    section: json.existingCampaigns,
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
    test("a ref target that vanishes after the classification and before the hashing read ends the plan with that error", async () => {
      const t = tree();
      root = t.root;
      writeAt(t.root, "assets/inputs/gone/logo.png", PNG);
      await briefs().createBrief(
        briefBody({ id: "gone", products: [product("assets/inputs/gone/logo.png")] }),
      );
      const real = (
        await vi.importActual<typeof import("../asset-step.js")>("../asset-step.js")
      ).resolveRefTargets;
      vi.mocked(resolveRefTargets).mockImplementationOnce((...args) => {
        rmSync(join(t.root, "assets/inputs/gone/logo.png"), { force: true });
        return real(...args);
      });
      const got = await plan(env, t.root, t.output);
      expect(got.code).toBe(1);
      expect(got.err).toEqual([
        expect.stringMatching(
          /ENOENT: no such file or directory, open '.*\/assets\/inputs\/gone\/logo\.png'/,
        ),
      ]);
      expect(got.writes).toEqual([]);
    });
    test("the section follows the target and the plan digest does not move with it", async () => {
      const t = tree();
      root = t.root;
      const empty = await plan(env, t.root, t.output);
      expect(empty.code).toBe(0);
      expect(empty.digest).toHaveLength(64);
      expect(empty.existing).toEqual(EMPTY);
      expect(empty.section).toMatchObject({
        withDraft: 0,
        counts: { campaigns: 0, briefVersions: 0, reports: 0, assets: 0 },
      });
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
    test("the section carries the org's row counts of campaign, brief_version, report and asset, tombstoned rows included", async () => {
      const t = tree();
      root = t.root;
      await briefs().createBrief(
        briefBody({ id: "one", products: [product("assets/inputs/a.png")] }),
      );
      await briefs().rewriteBrief(
        briefBody({ id: "one", products: [product("assets/inputs/b.png")] }),
      );
      await briefs().createCampaign("two");
      await getAssetStore(importTenant("local")).writeAsset("two", "logo.png", PNG);
      await briefs().createBrief(
        briefBody({ id: "gone", products: [product("assets/inputs/a.png")] }),
      );
      await env.db.query(
        "update campaign set deleted_at = now() where org_id = 'local' and slug = 'gone'",
      );
      await env.db.query(
        "insert into report (org_id, campaign_id, body, revision) values ('local', 'one', '{}', 'r1')",
      );
      await env.db.query("insert into org (id, name) values ('other', 'Other')");
      await env.db.query("insert into campaign (org_id, slug) values ('other', 'second')");
      await env.db.query(
        "insert into brief_version (campaign_id, version, body, revision, actor) " +
          "select id, 1, '{}', 'r1', 'test' from campaign where org_id = 'other'",
      );
      await env.db.query(
        "insert into report (org_id, campaign_id, body, revision) values ('other', 'second', '{}', 'r1')",
      );
      await env.db.query(
        "insert into asset (org_id, campaign_id, name, size, sha256, content_type) " +
          "select 'other', id, 'logo.png', 4, 'x', 'image/png' from campaign where org_id = 'other'",
      );
      const got = await plan(env, t.root, t.output);
      expect(got.err).toEqual([]);
      expect(got.code).toBe(0);
      expect(got.lines).toBe(5);
      expect(got.section?.counts).toEqual({
        campaigns: 3,
        briefVersions: 3,
        reports: 1,
        assets: 1,
      });
      expect(got.writes).toEqual([]);
    });
    test("a tombstoned campaign is not selected and not listed", async () => {
      const t = tree();
      root = t.root;
      const live = await briefs().createBrief(
        briefBody({ id: "live", products: [product("assets/inputs/a.png")] }),
      );
      await briefs().createBrief(
        briefBody({ id: "gone", products: [product("assets/inputs/a.png")] }),
      );
      await env.db.query(
        "update campaign set deleted_at = now() where org_id = 'local' and slug = 'gone'",
      );
      const got = await plan(env, t.root, t.output);
      expect(got.err).toEqual([]);
      expect(got.existing).toEqual({
        campaigns: [
          {
            slug: "live",
            revision: live.revision,
            state: "normalise",
            refs: [{ ref: "assets/inputs/a.png", kind: "root-level" }],
          },
        ],
        normalise: 1,
        refs: 1,
        refused: 0,
      });
      expect(got.writes).toEqual([]);
    });
    test("a class-(P) campaign that has a draft is listed with its number of drafts", async () => {
      const t = tree();
      root = t.root;
      const drafted = await briefs().createBrief(
        briefBody({ id: "drafted", products: [product("assets/inputs/a.png")] }),
      );
      await briefs().createBrief(
        briefBody({ id: "plain", products: [product("assets/inputs/a.png")] }),
      );
      for (const user of ["user-1", "user-2"]) {
        await env.db.query(
          "insert into draft (campaign_id, user_id, org_id, state, base_revision) " +
            "select id, $2::text, 'local', '{}'::jsonb, $3::text from campaign " +
            "where org_id = 'local' and slug = $1",
          ["drafted", user, drafted.revision],
        );
      }
      const got = await plan(env, t.root, t.output);
      expect(got.err).toEqual([]);
      expect(got.section?.campaigns.map((c) => [c.slug, c.state, c.drafts])).toEqual([
        ["drafted", "normalise", 2],
        ["plain", "normalise", 0],
      ]);
      expect(got.section?.withDraft).toBe(1);
      expect(got.existing?.normalise).toBe(2);
      expect(got.writes).toEqual([]);
    });
    test("the second digest covers each normalise campaign's slug, revision and ref-target hashes, and moves when a target's bytes or the revision move", async () => {
      const t = tree();
      root = t.root;
      writeAt(t.root, "assets/inputs/old/logo.png", PNG);
      const products = [product("assets/inputs/old/logo.png", "assets/inputs/a.png")];
      const stored = await briefs().createBrief(briefBody({ id: "old", products }));
      await briefs().createBrief(
        briefBody({ id: "gone", products: [product("assets/inputs/gone/logo.png")] }),
      );
      const first = await plan(env, t.root, t.output);
      expect(first.err).toEqual([]);
      const files = [
        { ref: "assets/inputs/old/logo.png", sha256: sha(PNG) },
        { ref: "assets/inputs/a.png", sha256: sha(PNG) },
      ];
      expect(first.section?.campaigns.map((c) => [c.slug, c.state, c.files])).toEqual([
        ["gone", "refused", undefined],
        ["old", "normalise", files],
      ]);
      const pairs = files.map((file) => [file.ref, file.sha256]);
      expect(first.section?.digest).toBe(sha(JSON.stringify([["old", stored.revision, pairs]])));
      writeAt(t.root, "assets/inputs/a.png", PNG_2);
      const second = await plan(env, t.root, t.output);
      expect(second.section?.digest).toHaveLength(64);
      expect(second.section?.digest).not.toBe(first.section?.digest);
      expect(second.digest).toBe(first.digest);
      await briefs().rewriteBrief(briefBody({ id: "old", campaignMessage: "Changed", products }));
      const third = await plan(env, t.root, t.output);
      expect(third.section?.digest).toHaveLength(64);
      expect(third.section?.digest).not.toBe(second.section?.digest);
      expect([first.writes, second.writes, third.writes]).toEqual([[], [], []]);
      expect(third.lines).toBe(5);
    });
    test("a second org's class-(P) campaign leaves the first org's digest byte-identical", async () => {
      const t = tree();
      root = t.root;
      const stored = await briefs().createBrief(
        briefBody({ id: "old", products: [product("assets/inputs/a.png")] }),
      );
      const without = await plan(env, t.root, t.output);
      expect(without.err).toEqual([]);
      expect(without.section?.campaigns).toEqual([
        {
          slug: "old",
          revision: stored.revision,
          state: "normalise",
          refs: [{ ref: "assets/inputs/a.png", kind: "root-level" }],
          drafts: 0,
          files: [{ ref: "assets/inputs/a.png", sha256: sha(PNG) }],
        },
      ]);
      await env.db.query("insert into org (id, name) values ('other', 'Other')");
      await env.db.query("insert into campaign (org_id, slug) values ('other', 'old')");
      await env.db.query(
        "insert into brief_version (campaign_id, version, body, revision, actor) " +
          "select id, 1, $1, 'r1', 'test' from campaign where org_id = 'other'",
        [JSON.stringify(briefBody({ id: "old", products: [product("assets/inputs/b.png")] }))],
      );
      const withOther = await plan(env, t.root, t.output);
      expect(withOther.err).toEqual([]);
      expect(withOther.section?.campaigns.map((c) => c.slug)).toEqual(["old"]);
      expect(withOther.section?.digest).toBe(without.section?.digest);
      expect(withOther.writes).toEqual([]);
    });
    test("existingDigest is the sha256 of one JSON array, campaigns by slug, files in the order given", () => {
      const a = {
        slug: "a",
        revision: "r1",
        files: [
          { ref: "assets/inputs/x.png", sha256: "h1" },
          { ref: "assets/inputs/a/y.png", sha256: "h2" },
        ],
      };
      const b = { slug: "b", revision: "r2", files: [] };
      const canonical =
        '[["a","r1",[["assets/inputs/x.png","h1"],["assets/inputs/a/y.png","h2"]]],["b","r2",[]]]';
      expect(existingDigest([b, a])).toBe(sha(canonical));
      expect(existingDigest([a, b])).toBe(sha(canonical));
      expect(existingDigest([])).toBe(sha("[]"));
      const swapped = { ...a, files: [a.files[1]!, a.files[0]!] };
      expect(existingDigest([swapped])).not.toBe(existingDigest([a]));
    });

    test("with no class-(P) campaign the second digest is the digest of the empty list", async () => {
      const t = tree();
      root = t.root;
      const got = await plan(env, t.root, t.output);
      expect(got.section?.digest).toBe(sha("[]"));
      expect(got.existing).toEqual(EMPTY);
    });
  },
);
