import { describe, test, expect, afterEach } from "vitest";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { CANONICAL_TEMPLATES, type CreativeTemplate } from "@campaignfoundry/CampaignOrchestration";
import { FsTemplateStore } from "../../../lib/ports/fs-template-store.js";
import { setTemplateStore, resetTemplateStore } from "../../../lib/ports/index.js";
import {
  MAX_TEMPLATES_PAGE_SIZE,
  encodeTemplateCursor,
  type TemplateStorePort,
} from "../../../lib/ports/template-store.port.js";
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
    expect(
      body.templates
        .filter((t) => t.id === v1.id)
        .map((t) => t.version)
        .sort(),
    ).toEqual([1, 2]);
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

  test("omitting limit returns every template with no nextCursor, past the page size", async () => {
    // More templates than MAX_TEMPLATES_PAGE_SIZE: without a limit the whole
    // library is served — the shape the web client reads — never capped at
    // the page size.
    const library: CreativeTemplate[] = Array.from(
      { length: MAX_TEMPLATES_PAGE_SIZE + 5 },
      (_, i) => ({
        ...v1,
        id: `tpl-${String(i).padStart(3, "0")}`,
      }),
    );
    setTemplateStore(new FsTemplateStore(library));

    const res = await get("/campaigns/templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      templates: CreativeTemplate[];
      skipped: number;
      nextCursor?: string;
    };
    expect(body.templates).toHaveLength(MAX_TEMPLATES_PAGE_SIZE + 5);
    expect(body.skipped).toBe(0);
    expect(body.nextCursor).toBeUndefined();
  });

  test("limit and cursor paginate across pages in byIdThenVersion order", async () => {
    const b1: CreativeTemplate = { ...v1, id: "tpl-b", version: 1 };
    const b2: CreativeTemplate = { ...v1, id: "tpl-b", version: 2 };
    const a1: CreativeTemplate = { ...v1, id: "tpl-a", version: 1 };
    const c1: CreativeTemplate = { ...v1, id: "tpl-c", version: 1 };
    setTemplateStore(new FsTemplateStore([b1, b2, a1, c1]));

    const first = await get("/campaigns/templates?limit=2");
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      templates: CreativeTemplate[];
      skipped: number;
      nextCursor?: string;
    };
    expect(page1.templates.map((t) => `${t.id}:${t.version}`)).toEqual(["tpl-a:1", "tpl-b:1"]);
    expect(page1.skipped).toBe(0);
    expect(page1.nextCursor).toBeDefined();

    const second = await get(
      `/campaigns/templates?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as {
      templates: CreativeTemplate[];
      nextCursor?: string;
    };
    expect(page2.templates.map((t) => `${t.id}:${t.version}`)).toEqual(["tpl-b:2", "tpl-c:1"]);
    expect(page2.nextCursor).toBeUndefined();

    // A cursor past the last page answers an empty list, not a rewind.
    const third = await get(
      `/campaigns/templates?limit=2&cursor=${encodeURIComponent(encodeTemplateCursor({ id: "zzz", version: 1 }))}`,
    );
    const page3 = (await third.json()) as { templates: CreativeTemplate[] };
    expect(page3.templates).toEqual([]);
  });

  test("surfaces skipped when the store reports skipped rows", async () => {
    const pageStore = {
      listTemplates: () => Promise.resolve([v1]),
      findTemplate: () => Promise.resolve(undefined),
      exists: () => Promise.resolve(false),
      listTemplatesPage: () =>
        Promise.resolve({ templates: [v1], skipped: 2, nextCursor: undefined }),
    } as unknown as TemplateStorePort;
    setTemplateStore(pageStore);

    const res = await get("/campaigns/templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped: number };
    expect(body.skipped).toBe(2);
  });

  test("a store without listTemplatesPage is paginated over the plain list", async () => {
    // Minimal test doubles (and any store predating the additive port):
    // insertion order in, byIdThenVersion pagination out.
    setTemplateStore({
      listTemplates: () => Promise.resolve([other, v1, v2]),
      findTemplate: () => Promise.resolve(undefined),
      exists: () => Promise.resolve(false),
    });

    const res = await get("/campaigns/templates?limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: CreativeTemplate[]; nextCursor?: string };
    expect(body.templates.map((t) => `${t.id}:${t.version}`)).toEqual(["canonical-image-text:1"]);
    expect(body.nextCursor).toBeDefined();
  });

  test.each(["0", "-1", "abc", "1.5", String(MAX_TEMPLATES_PAGE_SIZE + 1), ""])(
    "a malformed or out-of-range limit (%s) is a 400",
    async (bad) => {
      setTemplateStore(new FsTemplateStore([v1]));

      const res = await get(`/campaigns/templates?limit=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Invalid "limit" query parameter.');
    },
  );

  test("the page-size boundary limit is accepted", async () => {
    setTemplateStore(new FsTemplateStore([v1]));

    const res = await get(`/campaigns/templates?limit=${MAX_TEMPLATES_PAGE_SIZE}`);
    expect(res.status).toBe(200);
  });

  test.each([
    "!!not-a-cursor!!",
    Buffer.from("not json", "utf8").toString("base64url"),
    encodeTemplateCursor({ id: "", version: 1 }),
    Buffer.from(JSON.stringify({ version: 1 }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ id: "tpl-a" }), "utf8").toString("base64url"),
    encodeTemplateCursor({ id: "tpl-a", version: 0 }),
    encodeTemplateCursor({ id: "tpl-a", version: -1 }),
    encodeTemplateCursor({ id: "tpl-a", version: 1.5 }),
    "",
  ])("refuses a malformed cursor (%s) with 400", async (bad) => {
    setTemplateStore(new FsTemplateStore([v1]));

    const res = await get(`/campaigns/templates?cursor=${encodeURIComponent(bad)}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Invalid "cursor" query parameter.');
  });

  test("a well-formed cursor for an unknown position is accepted, not rejected", async () => {
    setTemplateStore(new FsTemplateStore([v1]));

    const res = await get(
      `/campaigns/templates?cursor=${encodeURIComponent(encodeTemplateCursor({ id: "tpl-a", version: 1 }))}`,
    );
    expect(res.status).toBe(200);
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

  test.each(["abc", "1.5", "0", "-1", "007", "9007199254740993", "99999999999999999999"])(
    "a non-integer / zero / negative / non-canonical / unsafe version (%s) is a 400 naming the field",
    async (bad) => {
      setTemplateStore(new FsTemplateStore([v1, v2]));

      const res = await get(`/campaigns/templates/${v1.id}@${bad}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/version/i);
    },
  );

  test.each(["1", "2"])(
    "a canonical version (%s) is accepted, not rejected as unsafe",
    async (ok) => {
      setTemplateStore(new FsTemplateStore([v1, v2]));

      const res = await get(`/campaigns/templates/${v1.id}@${ok}`);
      expect(res.status).toBe(200);
    },
  );

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
