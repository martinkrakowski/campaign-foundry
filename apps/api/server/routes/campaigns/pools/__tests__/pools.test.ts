import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import type { CopyGeneratorPort } from "@campaignfoundry/CampaignOrchestration";

const { copyGeneratorMock } = vi.hoisted(() => ({ copyGeneratorMock: vi.fn() }));

vi.mock("../../../../lib/pipeline.js", () => ({
  copyGenerator: () => copyGeneratorMock() as CopyGeneratorPort | undefined,
}));

type Method = "get" | "post" | "patch";

const mount = (routes: { method: Method; path: string; handler: EventHandler }[]) => {
  const app = createApp();
  const router = createRouter();
  for (const r of routes) router[r.method](r.path, r.handler);
  app.use(router);
  return toWebHandler(app);
};

const jsonReq = (url: string, method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const validYaml =
  "id: camp\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n  - id: beta\n";

const fakeGenerator = (
  headlines: readonly string[] | (() => Promise<readonly string[]>),
  model = "openai/gpt-4o-mini",
): CopyGeneratorPort => ({
  model,
  suggestHeadlines: vi.fn(async () => (typeof headlines === "function" ? headlines() : headlines)),
});

const origRoot = process.env.PROJECT_ROOT;

describe("copy pool routes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-pool-routes-"));
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "camp.yaml"), validYaml);
    copyGeneratorMock.mockReset();
    copyGeneratorMock.mockReturnValue(undefined);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    vi.restoreAllMocks();
  });

  const api = async () => {
    vi.resetModules();
    process.env.PROJECT_ROOT = dir;
    const generate = (await import("../copy.post.js")).default as EventHandler;
    const get = (await import("../[briefId].get.js")).default as EventHandler;
    const patch = (await import("../[briefId].patch.js")).default as EventHandler;
    const list = (await import("../../briefs.get.js")).default as EventHandler;
    return {
      generate: () => mount([{ method: "post", path: "/campaigns/pools/copy", handler: generate }]),
      get: () => mount([{ method: "get", path: "/campaigns/pools/:briefId", handler: get }]),
      patch: () => mount([{ method: "patch", path: "/campaigns/pools/:briefId", handler: patch }]),
      list: () => mount([{ method: "get", path: "/campaigns/briefs", handler: list }]),
    };
  };

  test("POST generates, legal-gates, persists, and GET/PATCH round-trip", async () => {
    const generator = fakeGenerator([
      "Stay wild. Stay hydrated.",
      "stay wild. stay hydrated.",
      "A miracle in every sip",
      "  Trim me  ",
    ]);
    copyGeneratorMock.mockReturnValue(generator);
    const { generate, get, patch, list } = await api();

    const created = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      pool: {
        briefId: string;
        generatedAt: string;
        model: string;
        entries: Array<{ id: string; text: string; status: string; reason?: string }>;
      };
    };
    expect(createdBody.pool.briefId).toBe("camp");
    expect(createdBody.pool.model).toBe("openai/gpt-4o-mini");
    expect(createdBody.pool.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(createdBody.pool.entries).toEqual([
      { id: "h1", text: "Stay wild. Stay hydrated.", status: "approved" },
      {
        id: "h2",
        text: "A miracle in every sip",
        status: "rejected",
        reason: "Prohibited terminology: miracle",
      },
      { id: "h3", text: "Trim me", status: "approved" },
    ]);
    expect(generator.suggestHeadlines).toHaveBeenCalledWith({
      brief: expect.objectContaining({ id: "camp" }),
      count: 10,
    });
    expect(JSON.parse(readFileSync(join(dir, "briefs", "camp", "pools.json"), "utf8"))).toEqual(createdBody.pool);

    const listed = await list()(new Request("http://x/campaigns/briefs"));
    const listedJson = (await listed.json()) as { briefs: { file: string }[] };
    expect(listedJson.briefs.map((b) => b.file)).toEqual(["camp.yaml"]);

    const fetched = await get()(new Request("http://x/campaigns/pools/camp"));
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(createdBody);

    const patched = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", {
        entries: [
          { id: "h3", status: "rejected" },
          { id: "h2", status: "approved", text: "Fresh alpine water" },
        ],
      }),
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { pool: { entries: Array<{ id: string; status: string; text: string }> } };
    expect(patchedBody.pool.entries).toEqual([
      { id: "h1", text: "Stay wild. Stay hydrated.", status: "approved" },
      { id: "h2", text: "Fresh alpine water", status: "approved" },
      { id: "h3", text: "Trim me", status: "rejected" },
    ]);
  });

  test("POST merges with an existing pool and allocates unused ids", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["Stay wild. Stay hydrated."]));
    const { generate } = await api();
    expect((await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp", count: 1 }))).status).toBe(
      201,
    );

    copyGeneratorMock.mockReturnValue(fakeGenerator(["Stay wild. Stay hydrated.", "New angle"]));
    const again = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp", count: 2 }));
    expect(again.status).toBe(201);
    const body = (await again.json()) as {
      pool: { model: string; entries: Array<{ id: string; text: string }> };
    };
    expect(body.pool.entries.map((e) => ({ id: e.id, text: e.text }))).toEqual([
      { id: "h1", text: "Stay wild. Stay hydrated." },
      { id: "h2", text: "New angle" },
    ]);
    expect(body.pool.model).toBe("openai/gpt-4o-mini");
  });

  test("POST returns 404 when the brief is unknown", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["Hi"]));
    const { generate } = await api();
    const res = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "missing" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Brief "missing" not found.' });
    expect(existsSync(join(dir, "briefs", "missing"))).toBe(false);
  });

  test("POST returns 503 when OPENROUTER_API_KEY is missing", async () => {
    const { generate } = await api();
    const res = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "OPENROUTER_API_KEY is not set" });
  });

  test("POST returns 422 when the generator returns nothing usable", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["  ", ""]));
    const { generate } = await api();
    const res = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Copy generator returned no usable headlines" });
  });

  test("POST returns 400 for an invalid count or briefId", async () => {
    const { generate } = await api();
    const badCount = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp", count: 26 }));
    expect(badCount.status).toBe(400);
    expect(((await badCount.json()) as { error: string }).error).toMatch(/count must be an integer between 1 and 25/);

    const zero = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp", count: 0 }));
    expect(zero.status).toBe(400);

    const notInt = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp", count: 1.5 }));
    expect(notInt.status).toBe(400);

    const unsafe = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "Bad" }));
    expect(unsafe.status).toBe(400);

    const arrayBody = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", []));
    expect(arrayBody.status).toBe(400);
  });

  test("POST honours count 25 and rejects a non-object body", async () => {
    const generator = fakeGenerator(["Only one"]);
    copyGeneratorMock.mockReturnValue(generator);
    const { generate } = await api();
    const res = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp", count: 25 }));
    expect(res.status).toBe(201);
    expect(generator.suggestHeadlines).toHaveBeenCalledWith(expect.objectContaining({ count: 25 }));
  });

  test("POST returns 400 with errorMessage when body parsing throws a non-Error", async () => {
    const { generate } = await api();
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "non-error parse failure" });
    } finally {
      g.readBody = original;
    }
  });

  test("GET returns 404 when no pool exists and 400 for an unsafe id", async () => {
    const { get } = await api();
    const missing = await get()(new Request("http://x/campaigns/pools/camp"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Copy pool for brief "camp" not found.' });

    const unsafe = await get()(new Request("http://x/campaigns/pools/Bad"));
    expect(unsafe.status).toBe(400);
  });

  test("PATCH re-runs legal on edited text and persists a rejection with reason", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["Stay wild. Stay hydrated."]));
    const { generate, patch } = await api();
    await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));

    const res = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", {
        entries: [{ id: "h1", status: "approved", text: "Guaranteed hydration" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pool: { entries: unknown[] } }).pool.entries).toEqual([
      {
        id: "h1",
        text: "Guaranteed hydration",
        status: "rejected",
        reason: "Prohibited terminology: guaranteed",
      },
    ]);
  });

  test("PATCH can reject without re-running legal and 404s unknown ids", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["Stay wild. Stay hydrated."]));
    const { generate, patch } = await api();
    await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));

    const rejected = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", { entries: [{ id: "h1", status: "rejected" }] }),
    );
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { pool: { entries: Array<{ status: string }> } }).pool.entries[0].status).toBe(
      "rejected",
    );

    const unknown = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", { entries: [{ id: "nope", status: "approved" }] }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Copy pool entry "nope" not found.' });
  });

  test("PATCH returns 404 when no pool exists", async () => {
    const { patch } = await api();
    const res = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", { entries: [{ id: "h1", status: "approved" }] }),
    );
    expect(res.status).toBe(404);
  });

  test("PATCH returns 400 for invalid payloads", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["Stay wild. Stay hydrated."]));
    const { generate, patch } = await api();
    await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));

    const cases: unknown[] = [
      [],
      { entries: "nope" },
      { entries: ["x"] },
      { entries: [{ status: "approved" }] },
      { entries: [{ id: "", status: "approved" }] },
      { entries: [{ id: "h1", status: "maybe" }] },
      { entries: [{ id: "h1", status: "approved", text: 1 }] },
      { entries: [{ id: "h1", status: "approved", text: "   " }] },
    ];
    for (const body of cases) {
      const res = await patch()(jsonReq("http://x/campaigns/pools/camp", "PATCH", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const unsafe = await patch()(
      jsonReq("http://x/campaigns/pools/Bad", "PATCH", { entries: [{ id: "h1", status: "approved" }] }),
    );
    expect(unsafe.status).toBe(400);

    const empty = await patch()(jsonReq("http://x/campaigns/pools/camp", "PATCH", { entries: [] }));
    expect(empty.status).toBe(200);
  });

  test("PATCH returns 400 with errorMessage when body parsing throws a non-Error", async () => {
    const { patch } = await api();
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await patch()(
        jsonReq("http://x/campaigns/pools/camp", "PATCH", { entries: [{ id: "h1", status: "approved" }] }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "non-error parse failure" });
    } finally {
      g.readBody = original;
    }
  });

  test("PATCH keeps a HITL rejection when edited text still passes legal", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["Stay wild. Stay hydrated."]));
    const { generate, patch } = await api();
    await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    const res = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", {
        entries: [{ id: "h1", status: "rejected", text: "Alpine spring water" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pool: { entries: Array<{ status: string; text: string }> } }).pool.entries[0]).toEqual({
      id: "h1",
      text: "Alpine spring water",
      status: "rejected",
    });
  });
});
