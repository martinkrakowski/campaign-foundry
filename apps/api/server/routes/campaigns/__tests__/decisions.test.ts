import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import { getReportStore, resetDecisionStore, resetReportStore } from "../../../lib/ports/index.js";
import { reportRevision } from "../../../lib/report.js";
import { LOCAL_TENANT } from "../../../lib/tenant.js";
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

describe("GET / PUT /campaigns/decisions (D173)", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;
  const runReport = (assets: number) =>
    getReportStore(LOCAL_TENANT).writeReport("camp", JSON.stringify({ assets: Array(assets) }));
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cf-decisions-route-"));
    process.env.OUTPUT_DIR = dir;
    resetDecisionStore();
    resetReportStore();
    await runReport(1);
  });
  afterEach(() => {
    resetDecisionStore();
    resetReportStore();
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
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
    const res = await put({ campaignId: "other", revision: null, decisions: { a: "approved" } });
    expect(res.status).toBe(409);
    expect(await (await get("?campaignId=other")).json()).toEqual({
      decisions: {},
      revision: null,
    });
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
