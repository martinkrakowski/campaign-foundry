import { describe, test, expect, afterEach } from "vitest";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplate,
} from "@campaignfoundry/CampaignOrchestration";
import { FsTemplateStore } from "../../../lib/ports/fs-template-store.js";
import { setTemplateStore, resetTemplateStore } from "../../../lib/ports/index.js";
import listHandler from "../templates.get.js";
import byRefHandler from "../templates/[ref].get.js";

type Method = "get";

const mount = (routes: { method: Method; path: string; handler: EventHandler }[]) => {
  const app = createApp();
  const router = createRouter();
  for (const r of routes) router[r.method](r.path, r.handler);
  app.use(router);
  return toWebHandler(app);
};

const web = mount([
  { method: "get", path: "/campaigns/templates", handler: listHandler },
  { method: "get", path: "/campaigns/templates/:ref", handler: byRefHandler },
]);

const get = (path: string) => web(new Request(`http://x${path}`));

// One id, two versions (the seed store only carries one version per id, but the
// library format allows more — L7's whole point).
const v1: CreativeTemplate = CANONICAL_TEMPLATES["image-text"];
const v2: CreativeTemplate = { ...v1, version: 2, name: "Canonical Image & Text v2" };
const other: CreativeTemplate = CANONICAL_TEMPLATES["video"];

describe("GET /campaigns/templates", () => {
  afterEach(() => {
    resetTemplateStore();
  });

  test("returns every seeded record, including two versions of one id", async () => {
    setTemplateStore(new FsTemplateStore([v1, v2, other]));

    const res = await get("/campaigns/templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: CreativeTemplate[] };
    expect(body.templates).toHaveLength(3);
    expect(body.templates.filter((t) => t.id === v1.id).map((t) => t.version).sort()).toEqual([
      1, 2,
    ]);
  });

  test("a store that throws is a 500 with an error message, never an empty list", async () => {
    setTemplateStore({
      listTemplates: () => Promise.reject(new Error("disk on fire")),
      findTemplate: () => Promise.reject(new Error("unused")),
      exists: () => Promise.reject(new Error("unused")),
    });

    const res = await get("/campaigns/templates");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; templates?: unknown };
    expect(body.templates).toBeUndefined();
    expect(body.error).toMatch(/disk on fire/);
  });
});

describe("GET /campaigns/templates/:ref", () => {
  afterEach(() => {
    resetTemplateStore();
  });

  test("an exact version returns that version", async () => {
    setTemplateStore(new FsTemplateStore([v1, v2]));

    const res = await get(`/campaigns/templates/${v1.id}@1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: CreativeTemplate };
    expect(body.template.version).toBe(1);
    expect(body.template.name).toBe(v1.name);
  });

  test("a version the store does not have is a 404, and the body does not contain the other version's data", async () => {
    setTemplateStore(new FsTemplateStore([v1, v2]));

    const res = await get(`/campaigns/templates/${v1.id}@99`);
    const text = await res.text();
    // Checked before the status: a fallback mutation must fail on the leaked
    // payload (D123's immutability promise), not merely on a wrong status code.
    expect(text).not.toContain(v1.name);
    expect(text).not.toContain(v2.name);
    expect(res.status).toBe(404);
  });

  test("a percent-encoded @ in the path segment reaches the handler as a literal @ (h3 decodes router params)", async () => {
    setTemplateStore(new FsTemplateStore([v1, v2]));

    const res = await get(`/campaigns/templates/${v1.id}%401`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: CreativeTemplate };
    expect(body.template.version).toBe(1);
  });

  test("no version returns the highest version present", async () => {
    setTemplateStore(new FsTemplateStore([v1, v2]));

    const res = await get(`/campaigns/templates/${v1.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: CreativeTemplate };
    expect(body.template.version).toBe(2);
  });

  test.each([
    "abc",
    "1.5",
    "0",
    "-1",
    "007",
    "9007199254740993",
    "99999999999999999999",
  ])("a non-integer / zero / negative / non-canonical / unsafe version (%s) is a 400 naming the field", async (bad) => {
    setTemplateStore(new FsTemplateStore([v1, v2]));

    const res = await get(`/campaigns/templates/${v1.id}@${bad}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/version/i);
  });

  test.each(["1", "2"])("a canonical version (%s) is accepted, not rejected as unsafe", async (ok) => {
    setTemplateStore(new FsTemplateStore([v1, v2]));

    const res = await get(`/campaigns/templates/${v1.id}@${ok}`);
    expect(res.status).toBe(200);
  });

  test("an id containing @ resolves by splitting at the LAST @, so a version still pins", async () => {
    const weird: CreativeTemplate = { ...v1, id: "a@b", version: 3 };
    setTemplateStore(new FsTemplateStore([weird]));

    const res = await get("/campaigns/templates/a@b@3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: CreativeTemplate };
    expect(body.template.id).toBe("a@b");
    expect(body.template.version).toBe(3);
  });

  test("a store that throws is a 500 with an error message", async () => {
    setTemplateStore({
      listTemplates: () => Promise.reject(new Error("unused")),
      findTemplate: () => Promise.reject(new Error("disk on fire")),
      exists: () => Promise.reject(new Error("unused")),
    });

    const res = await get(`/campaigns/templates/${v1.id}`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; template?: unknown };
    expect(body.template).toBeUndefined();
    expect(body.error).toMatch(/disk on fire/);
  });
});
