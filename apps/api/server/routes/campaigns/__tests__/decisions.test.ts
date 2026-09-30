import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { resetProjectRoot } from "@campaignfoundry/shared";
import {
  DecisionConflictError,
  getBriefStore,
  getReportStore,
  resetBriefStore,
  resetDecisionStore,
  resetReportStore,
  setDecisionStore,
} from "../../../lib/ports/index.js";
import { reportRevision } from "../../../lib/report.js";
import { LOCAL_TENANT } from "../../../lib/tenant.js";
import { resetDatabase, setDatabase } from "../../../lib/db/database.js";
import { migratedDatabase } from "../../../lib/db/__tests__/pglite-client.js";
import getHandler from "../decisions.get.js";
import putHandler from "../decisions.put.js";

const api = () => {
  const app = createApp();
  const router = createRouter();
  router.get("/campaigns/decisions", getHandler);
  router.put("/campaigns/decisions", putHandler);
  app.use(router);
  return toWebHandler(app);
};
const get = (query: string) => api()(new Request(`http://x/campaigns/decisions${query}`));
const putRaw = (body: string) =>
  api()(
    new Request("http://x/campaigns/decisions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
const put = (body: unknown) => putRaw(JSON.stringify(body));

type Record_ = { verdict: string; actor: string; at: string; run: string };
type Stored = { decisions: Record<string, Record_>; revision: string | null };

const sampleBrief: CampaignBrief = {
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "camp",
  mode: "brief",
  targetRegion: "US",
  targetAudience: "developers",
  campaignMessage: "Build faster",
  products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  treatments: [{ id: "bold", layout: "headline-bottom", tone: "bold" }],
};

describe("GET / PUT /campaigns/decisions (D173)", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;
  const origRoot = process.env.PROJECT_ROOT;
  const runReport = (assets: number) =>
    getReportStore(LOCAL_TENANT).writeReport("camp", JSON.stringify({ assets: Array(assets) }));
  beforeEach(async () => {
    resetProjectRoot();
    dir = mkdtempSync(join(tmpdir(), "cf-decisions-route-"));
    process.env.OUTPUT_DIR = dir;
    process.env.PROJECT_ROOT = dir;
    resetDecisionStore();
    resetReportStore();
    resetBriefStore();
    await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
    await runReport(1);
  });
  afterEach(() => {
    resetDecisionStore();
    resetReportStore();
    resetBriefStore();
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    resetProjectRoot();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a campaign with no decisions answers {} at a null revision; a missing or unsafe id is 400", async () => {
    expect(await (await get("?campaignId=camp")).json()).toEqual({ decisions: {}, revision: null });
    expect((await get("")).status).toBe(400);
    expect((await get("?campaignId=../evil")).status).toBe(400);
  });

  test("a PUT records who decided, when and against which run, and a GET returns it", async () => {
    const res = await put({
      campaignId: "camp",
      revision: null,
      decisions: { "alpha/v0": "approved" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Stored;
    const stored = body.decisions["alpha/v0"]!;
    expect(stored.verdict).toBe("approved");
    expect(stored.actor).toBe("local");
    expect(stored.run).toBe(await reportRevision(LOCAL_TENANT, "camp"));
    expect(Number.isNaN(Date.parse(stored.at))).toBe(false);
    expect(await (await get("?campaignId=camp")).json()).toEqual({
      decisions: { "alpha/v0": stored },
      revision: body.revision,
    });
  });

  test("an unchanged verdict keeps its original time and run across a later run; a dropped key is back in review", async () => {
    const first = (await (
      await put({ campaignId: "camp", revision: null, decisions: { a: "approved", b: "rejected" } })
    ).json()) as Stored;
    await runReport(2); // a later run (a merge that kept `a`) moves the report
    await new Promise((r) => setTimeout(r, 5));
    const second = (await (
      await put({ campaignId: "camp", revision: first.revision, decisions: { a: "approved" } })
    ).json()) as Stored;
    expect(second.decisions).toEqual({ a: first.decisions.a });
  });

  test("a save from a stale read is a 409 carrying the current revision, and changes nothing", async () => {
    const tabA = (await (await get("?campaignId=camp")).json()) as Stored;
    const tabB = tabA; // a second tab read the same revision
    const saved = (await (
      await put({ campaignId: "camp", revision: tabA.revision, decisions: { a: "approved" } })
    ).json()) as Stored;
    const stale = await put({
      campaignId: "camp",
      revision: tabB.revision,
      decisions: { b: "rejected" },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ revision: saved.revision });
    expect(await (await get("?campaignId=camp")).json()).toEqual(saved);
  });

  test("a campaign with no run has nothing to decide on: 409, and nothing stored", async () => {
    await getBriefStore(LOCAL_TENANT).createBrief({ ...sampleBrief, id: "other" });
    const res = await put({ campaignId: "other", revision: null, decisions: { a: "approved" } });
    expect(res.status).toBe(409);
    expect(await (await get("?campaignId=other")).json()).toEqual({
      decisions: {},
      revision: null,
    });
  });

  test("reviewing an unsaved campaign with a report succeeds and reads back (H1 / H2)", async () => {
    await getReportStore(LOCAL_TENANT).writeReport("unsaved-camp", JSON.stringify({ assets: [] }));
    const putRes = await put({
      campaignId: "unsaved-camp",
      revision: null,
      decisions: { "p1/1x1/bold": "approved" },
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as Stored;
    expect(putBody.decisions["p1/1x1/bold"]?.verdict).toBe("approved");

    const getRes = await get("?campaignId=unsaved-camp");
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as Stored;
    expect(getBody.decisions["p1/1x1/bold"]?.verdict).toBe("approved");
  });

  test("a `__proto__` key is refused at the body parser, and a `toString` key is an ordinary review key", async () => {
    const proto = await putRaw(
      '{"campaignId":"camp","revision":null,"decisions":{"__proto__":"approved"}}',
    );
    expect(proto.status).toBe(400);
    const res = await put({
      campaignId: "camp",
      revision: null,
      decisions: { toString: "approved" },
    });
    expect(res.status).toBe(200);
    const { decisions } = (await (await get("?campaignId=camp")).json()) as Stored;
    expect(Object.keys(decisions)).toEqual(["toString"]);
    expect(decisions["toString" as string]!.verdict).toBe("approved");
  });

  test("a bad body is 400, naming the problem, and stores nothing", async () => {
    expect((await put({ revision: null, decisions: {} })).status).toBe(400);
    expect((await put(null)).status).toBe(400);
    expect((await put({ campaignId: "camp", decisions: {} })).status).toBe(400); // no revision
    expect((await put({ campaignId: "camp", revision: 7, decisions: {} })).status).toBe(400);
    const bad = await put({ campaignId: "camp", revision: null, decisions: { k: "maybe" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/approved" or "rejected/);
    expect(await (await get("?campaignId=camp")).json()).toEqual({ decisions: {}, revision: null });
  });
});

describe("GET / PUT /campaigns/decisions on Postgres (PT-3)", () => {
  let dir: string;
  let db: Awaited<ReturnType<typeof migratedDatabase>> | undefined;
  const origOut = process.env.OUTPUT_DIR;
  const origBackend = process.env.STORE_BACKEND;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-decisions-pg-"));
    process.env.OUTPUT_DIR = dir;
    process.env.STORE_BACKEND = "postgres";
    db = await migratedDatabase();
    setDatabase(db);
    resetDecisionStore();
    resetReportStore();
    resetBriefStore();
    await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
    await getReportStore(LOCAL_TENANT).writeReport("camp", JSON.stringify({ assets: [] }));
  });
  afterEach(async () => {
    resetDecisionStore();
    resetReportStore();
    resetBriefStore();
    resetDatabase();
    // Closes the database `beforeEach` opened: on a real server that is a
    // `cf_t_*` database, not an instance the collector reclaims.
    await db?.end();
    db = undefined;
    if (origBackend === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = origBackend;
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    rmSync(dir, { recursive: true, force: true });
  });

  test("the same contract: a save names its revision, a stale one is a 409, and a read returns the save", async () => {
    const tab = (await (await get("?campaignId=camp")).json()) as Stored;
    expect(tab).toEqual({ decisions: {}, revision: null });
    const saved = (await (
      await put({ campaignId: "camp", revision: null, decisions: { a: "approved" } })
    ).json()) as Stored;
    expect(saved.decisions.a!.run).toBe(await reportRevision(LOCAL_TENANT, "camp"));
    const stale = await put({ campaignId: "camp", revision: null, decisions: { b: "rejected" } });
    expect(stale.status).toBe(409);
    expect(await (await get("?campaignId=camp")).json()).toEqual(saved);
  });
});

describe("PUT /campaigns/decisions when the store refuses the write (PT-3)", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;
  const origRoot = process.env.PROJECT_ROOT;
  beforeEach(async () => {
    resetProjectRoot();
    dir = mkdtempSync(join(tmpdir(), "cf-decisions-refused-"));
    process.env.OUTPUT_DIR = dir;
    process.env.PROJECT_ROOT = dir;
    resetDecisionStore();
    resetReportStore();
    resetBriefStore();
    await getBriefStore(LOCAL_TENANT).createBrief(sampleBrief);
    await getReportStore(LOCAL_TENANT).writeReport("camp", JSON.stringify({ assets: [] }));
  });
  afterEach(() => {
    resetDecisionStore();
    resetReportStore();
    resetBriefStore();
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    resetProjectRoot();
    rmSync(dir, { recursive: true, force: true });
  });

  const refusing = (error: Error) =>
    setDecisionStore({
      readDecisions: async () => ({ decisions: {}, revision: null }),
      writeDecisions: async () => {
        throw error;
      },
    });

  test("another process's save between the read and the write is a 409 carrying its revision", async () => {
    refusing(new DecisionConflictError("camp", "theirs"));
    const res = await put({ campaignId: "camp", revision: null, decisions: { a: "approved" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ revision: "theirs" });
  });

  test("any other failure is not dressed up as a conflict", async () => {
    refusing(new Error("database down"));
    const res = await put({ campaignId: "camp", revision: null, decisions: { a: "approved" } });
    expect(res.status).toBe(500);
  });
});
