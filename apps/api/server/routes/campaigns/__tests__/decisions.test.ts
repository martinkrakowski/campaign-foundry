import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler } from "h3";
import { resetDecisionStore } from "../../../lib/ports/index.js";
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
const put = (body: unknown) =>
  api()(
    new Request("http://x/campaigns/decisions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

type Stored = { decisions: Record<string, { verdict: string; actor: string; at: string }> };

describe("GET / PUT /campaigns/decisions (D173)", () => {
  let dir: string;
  const origOut = process.env.OUTPUT_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-decisions-route-"));
    process.env.OUTPUT_DIR = dir;
    resetDecisionStore();
  });
  afterEach(() => {
    resetDecisionStore();
    if (origOut === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = origOut;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a campaign with no decisions answers {}; a missing or unsafe id is 400", async () => {
    expect(await (await get("?campaignId=camp")).json()).toEqual({ decisions: {} });
    expect((await get("")).status).toBe(400);
    expect((await get("?campaignId=../evil")).status).toBe(400);
  });

  test("a PUT records who decided and when, and a GET returns it", async () => {
    const res = await put({ campaignId: "camp", decisions: { "alpha/v0": "approved" } });
    expect(res.status).toBe(200);
    const stored = ((await res.json()) as Stored).decisions["alpha/v0"]!;
    expect(stored.verdict).toBe("approved");
    expect(stored.actor).toBe("local");
    expect(Number.isNaN(Date.parse(stored.at))).toBe(false);
    expect(await (await get("?campaignId=camp")).json()).toEqual({
      decisions: { "alpha/v0": stored },
    });
  });

  test("an unchanged verdict keeps its original time across a later PUT; a dropped key is back in review", async () => {
    const first = (
      (await (
        await put({ campaignId: "camp", decisions: { a: "approved", b: "rejected" } })
      ).json()) as Stored
    ).decisions;
    await new Promise((r) => setTimeout(r, 5));
    const second = (
      (await (await put({ campaignId: "camp", decisions: { a: "approved" } })).json()) as Stored
    ).decisions;
    expect(second).toEqual({ a: first.a });
  });

  test("a bad body is 400, naming the problem, and stores nothing", async () => {
    expect((await put({ decisions: {} })).status).toBe(400);
    expect((await put(null)).status).toBe(400);
    const bad = await put({ campaignId: "camp", decisions: { k: "maybe" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/approved" or "rejected/);
    expect(await (await get("?campaignId=camp")).json()).toEqual({ decisions: {} });
  });
});
