import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import type { CopyGeneratorError, CopyGeneratorPort } from "@campaignfoundry/CampaignOrchestration";

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
      added: number;
    };
    expect(createdBody.added).toBe(3);
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
    expect(await fetched.json()).toEqual({ pool: createdBody.pool });

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
      added: number;
    };
    expect(body.added).toBe(1);
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

  test("GET, PATCH and POST answer 422 naming the file when pools.json is hand-edited into an invalid shape", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["New angle"]));
    const { get, patch, generate } = await api();
    mkdirSync(join(dir, "briefs", "camp"), { recursive: true });
    writeFileSync(
      join(dir, "briefs", "camp", "pools.json"),
      JSON.stringify({ briefId: "camp", generatedAt: "t", model: "m", entries: [{ id: "h1", text: 42, status: "approved" }] }),
    );
    const error = "Copy pool briefs/camp/pools.json is invalid: entries[0].text must be a string.";

    const fetched = await get()(new Request("http://x/campaigns/pools/camp"));
    expect(fetched.status).toBe(422);
    expect(await fetched.json()).toEqual({ error });

    const patched = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", { entries: [{ id: "h1", status: "approved" }] }),
    );
    expect(patched.status).toBe(422);
    expect(await patched.json()).toEqual({ error });

    const generated = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    expect(generated.status).toBe(422);
    expect(await generated.json()).toEqual({ error });
    expect(readFileSync(join(dir, "briefs", "camp", "pools.json"), "utf8")).toContain('"text":42');
  });

  test("GET, PATCH and POST rethrow a non-shape read failure", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["New angle"]));
    const { get, patch, generate } = await api();
    mkdirSync(join(dir, "briefs", "camp", "pools.json"), { recursive: true });
    expect((await get()(new Request("http://x/campaigns/pools/camp"))).status).toBe(500);
    expect(
      (
        await patch()(
          jsonReq("http://x/campaigns/pools/camp", "PATCH", { entries: [{ id: "h1", status: "approved" }] }),
        )
      ).status,
    ).toBe(500);
    expect((await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }))).status).toBe(500);
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
      {
        entries: [
          { id: "h1", status: "approved" },
          { id: "h1", status: "rejected" },
        ],
      },
    ];
    for (const body of cases) {
      const res = await patch()(jsonReq("http://x/campaigns/pools/camp", "PATCH", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const unsafe = await patch()(
      jsonReq("http://x/campaigns/pools/Bad", "PATCH", { entries: [{ id: "h1", status: "approved" }] }),
    );
    expect(unsafe.status).toBe(400);

    const file = join(dir, "briefs", "camp", "pools.json");
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8"))));
    const before = readFileSync(file, "utf8");
    const empty = await patch()(jsonReq("http://x/campaigns/pools/camp", "PATCH", { entries: [] }));
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { pool: { entries: unknown[] } }).pool.entries).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(before);
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
  test("PATCH clears a stale legal reason when edited text passes and status stays rejected", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["A miracle in every sip"]));
    const { generate, patch } = await api();
    const created = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    expect(((await created.json()) as { pool: { entries: Array<{ reason?: string }> } }).pool.entries[0].reason).toBe(
      "Prohibited terminology: miracle",
    );

    const res = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", {
        entries: [{ id: "h1", status: "rejected", text: "Alpine spring water" }],
      }),
    );
    expect(res.status).toBe(200);
    const entry = ((await res.json()) as { pool: { entries: Array<Record<string, unknown>> } }).pool.entries[0];
    expect(entry).toEqual({ id: "h1", text: "Alpine spring water", status: "rejected" });
    expect("reason" in entry).toBe(false);
  });

  test("PATCH 422s when an edit duplicates another entry's text", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["Stay wild", "Stay hydrated"]));
    const { generate, patch } = await api();
    await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));

    const res = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", {
        entries: [{ id: "h2", status: "approved", text: "  stay   WILD " }],
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Edited text for entry "h2" duplicates entry "h1".' });
    const file = JSON.parse(readFileSync(join(dir, "briefs", "camp", "pools.json"), "utf8")) as {
      entries: Array<{ text: string }>;
    };
    expect(file.entries.map((e) => e.text)).toEqual(["Stay wild", "Stay hydrated"]);

    const sameEntry = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", {
        entries: [{ id: "h2", status: "approved", text: "Stay Hydrated" }],
      }),
    );
    expect(sameEntry.status).toBe(200);
  });

  test("POST caps persisted headlines at count and drops texts over 60 characters", async () => {
    const forty = Array.from({ length: 40 }, (_, i) => `Headline number ${i + 1}`);
    copyGeneratorMock.mockReturnValue(fakeGenerator(["x".repeat(61), ...forty]));
    const { generate } = await api();
    const res = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp", count: 1 }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pool: { entries: Array<{ text: string }> }; added: number };
    expect(body.added).toBe(1);
    expect(body.pool.entries.map((e) => e.text)).toEqual(["Headline number 1"]);

    copyGeneratorMock.mockReturnValue(fakeGenerator(["y".repeat(61)]));
    const tooLong = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    expect(tooLong.status).toBe(422);
  });

  test("POST responds 200 with added 0 when the model only repeats known headlines", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["Stay wild"]));
    const { generate } = await api();
    await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    const file = join(dir, "briefs", "camp", "pools.json");
    const before = readFileSync(file, "utf8");

    copyGeneratorMock.mockReturnValue(fakeGenerator(["STAY  wild"]));
    const res = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pool: { entries: Array<{ text: string }> }; added: number };
    expect(body.added).toBe(0);
    expect(body.pool.entries.map((e) => e.text)).toEqual(["Stay wild"]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("two concurrent POSTs both persist and neither set of entries is lost", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    copyGeneratorMock
      .mockReturnValueOnce(
        fakeGenerator(async () => {
          await firstDone;
          return ["First alpha", "First beta"];
        }),
      )
      .mockReturnValueOnce(fakeGenerator(["Second alpha", "Second beta"]));
    const { generate, get } = await api();
    const route = generate();

    const a = route(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    const b = route(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    releaseFirst();
    const [resA, resB] = await Promise.all([a, b]);
    expect([resA.status, resB.status]).toEqual([201, 201]);

    const final = await get()(new Request("http://x/campaigns/pools/camp"));
    const body = (await final.json()) as { pool: { entries: Array<{ id: string; text: string }> } };
    expect(body.pool.entries.map((e) => e.text).sort()).toEqual([
      "First alpha",
      "First beta",
      "Second alpha",
      "Second beta",
    ]);
    expect(new Set(body.pool.entries.map((e) => e.id)).size).toBe(4);
  });

  test("POST and PATCH refuse a symlinked briefs/<id> directory", async () => {
    copyGeneratorMock.mockReturnValue(fakeGenerator(["Stay wild"]));
    const { generate, patch } = await api();
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(dir, "briefs", "camp"));

    const created = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    expect(created.status).toBe(400);
    expect(await created.json()).toEqual({ error: "Refusing to write through a symlink." });
    expect(existsSync(join(elsewhere, "pools.json"))).toBe(false);

    const patched = await patch()(
      jsonReq("http://x/campaigns/pools/camp", "PATCH", { entries: [{ id: "h1", status: "approved" }] }),
    );
    expect(patched.status).toBe(400);
  });

  test("POST maps generator failures to sanitised HTTP replies", async () => {
    const { generate } = await api();
    // Same module instance as the route (api() resets modules) so instanceof holds.
    const { CopyGeneratorError } = await import("@campaignfoundry/CampaignOrchestration");
    const failing = (error: unknown): CopyGeneratorPort => ({
      model: "m",
      suggestHeadlines: async () => {
        throw error;
      },
    });
    const cases: Array<[CopyGeneratorError, number, string]> = [
      [new CopyGeneratorError("missing_key", "no key"), 503, "OPENROUTER_API_KEY is not set"],
      [new CopyGeneratorError("auth", "OpenRouter HTTP 401: bad key"), 502, "OpenRouter rejected the configured API key"],
      [new CopyGeneratorError("rate_limited", "429"), 503, "OpenRouter is rate limiting copy generation"],
      [new CopyGeneratorError("network", "timeout"), 503, "OpenRouter could not be reached"],
      [new CopyGeneratorError("malformed", "junk"), 422, "Copy generator returned an unreadable response"],
      [new CopyGeneratorError("upstream", "OpenRouter HTTP 500: boom"), 502, "OpenRouter returned an error"],
    ];
    for (const [error, status, message] of cases) {
      copyGeneratorMock.mockReturnValue(failing(error));
      const res = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
      expect(res.status, error.kind).toBe(status);
      expect(await res.json()).toEqual({ error: message });
      expect(res.headers.get("retry-after")).toBeNull();
    }

    copyGeneratorMock.mockReturnValue(failing(new CopyGeneratorError("rate_limited", "429", 7)));
    const limited = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");

    copyGeneratorMock.mockReturnValue(failing(new Error("unexpected")));
    const unknown = await generate()(jsonReq("http://x/campaigns/pools/copy", "POST", { briefId: "camp" }));
    expect(unknown.status).toBe(500);
    expect(existsSync(join(dir, "briefs", "camp"))).toBe(false);
  });
});
