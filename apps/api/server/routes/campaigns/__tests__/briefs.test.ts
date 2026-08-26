import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { loadBrief } from "../../../lib/load-brief.js";

type Method = "get" | "post" | "put";

const mount = (routes: { method: Method; path: string; handler: EventHandler }[]) => {
  const app = createApp();
  const router = createRouter();
  for (const r of routes) router[r.method](r.path, r.handler);
  app.use(router);
  return toWebHandler(app);
};

const web = (handler: EventHandler) => mount([{ method: "get", path: "/campaigns/briefs", handler }]);

/** Fresh handler import with PROJECT_ROOT pointed at `root` (projectRoot is memoized). */
const handlerFor = async (root: string): Promise<EventHandler> => {
  vi.resetModules();
  process.env.PROJECT_ROOT = root;
  return (await import("../briefs.get.js")).default;
};

const handlersFor = async (root: string) => {
  vi.resetModules();
  process.env.PROJECT_ROOT = root;
  return {
    list: (await import("../briefs.get.js")).default as EventHandler,
    create: (await import("../briefs.post.js")).default as EventHandler,
    update: (await import("../briefs/[id].put.js")).default as EventHandler,
    duplicate: (await import("../briefs/[id]/duplicate.post.js")).default as EventHandler,
  };
};

const validBrief =
  "id: good\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: Hi\nproducts:\n  - id: alpha\n  - id: beta\n";

const brief = (over: Record<string, unknown> = {}) => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
    { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "assets/inputs/trail-logo.png" },
  ],
  ...over,
});

const jsonReq = (url: string, method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("GET /campaigns/briefs", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-briefs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    vi.restoreAllMocks();
  });

  test("lists parseable briefs and skips malformed ones", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "good.yaml"), validBrief);
    writeFileSync(join(dir, "briefs", "bad.yaml"), "id: 1\nproducts: not-an-array\n"); // invalid → skipped
    writeFileSync(join(dir, "briefs", "ignore.txt"), "not a brief"); // wrong extension → filtered
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await web(await handlerFor(dir))(new Request("http://x/campaigns/briefs"));
    const json = (await res.json()) as { briefs: { file: string; brief: { id: string } }[] };

    expect(json.briefs).toHaveLength(1);
    expect(json.briefs[0]).toMatchObject({ file: "good.yaml", brief: { id: "good" } });
    expect(warn).toHaveBeenCalled(); // logged the skipped malformed brief
  });

  test("returns an empty list when the briefs directory is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await web(await handlerFor(dir))(new Request("http://x/campaigns/briefs")); // no briefs/ dir
    expect((await res.json()) as { briefs: unknown[] }).toEqual({ briefs: [] });
    expect(warn).toHaveBeenCalled();
  });
});

describe("authoring briefs", () => {
  let dir: string;
  const origRoot = process.env.PROJECT_ROOT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-briefs-write-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
    vi.restoreAllMocks();
  });

  const api = async () => {
    const h = await handlersFor(dir);
    return {
      h,
      list: () => mount([{ method: "get", path: "/campaigns/briefs", handler: h.list }]),
      create: () => mount([{ method: "post", path: "/campaigns/briefs", handler: h.create }]),
      update: () => mount([{ method: "put", path: "/campaigns/briefs/:id", handler: h.update }]),
      duplicate: () =>
        mount([{ method: "post", path: "/campaigns/briefs/:id/duplicate", handler: h.duplicate }]),
    };
  };

  test("POST writes yaml, GET lists it, and parseBrief accepts the file", async () => {
    const { create, list } = await api();
    const payload = brief({
      localizedMessage: "Hallo",
      treatments: [{ id: "bold-bottom", layout: "headline-bottom", tone: "bold" }],
      mode: "brief",
    });
    const posted = await create()(jsonReq("http://x/campaigns/briefs", "POST", payload));
    expect(posted.status).toBe(201);
    expect(await posted.json()).toEqual({ file: "camp.yaml", brief: payload });

    const listed = await list()(new Request("http://x/campaigns/briefs"));
    const json = (await listed.json()) as { briefs: { file: string; brief: { id: string } }[] };
    expect(json.briefs).toEqual([{ file: "camp.yaml", brief: payload }]);

    const onDisk = await loadBrief(join(dir, "briefs", "camp.yaml"));
    expect(onDisk).toMatchObject({ id: "camp", localizedMessage: "Hallo" });
    const dumped = readFileSync(join(dir, "briefs", "camp.yaml"), "utf8");
    expect([...dumped.matchAll(/^([a-zA-Z]+):/gm)].map((m) => m[1])).toEqual([
      "id",
      "targetRegion",
      "targetAudience",
      "campaignMessage",
      "localizedMessage",
      "products",
      "treatments",
      "mode",
    ]);
  });

  test("POST without replace returns 409 when the yaml already exists", async () => {
    const { create } = await api();
    const first = await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    expect(first.status).toBe(201);
    const again = await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'Brief "camp.yaml" already exists.' });
  });

  test("POST ?replace=1 overwrites an existing yaml", async () => {
    const { create } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const replaced = await create()(
      jsonReq("http://x/campaigns/briefs?replace=1", "POST", brief({ campaignMessage: "Updated" })),
    );
    expect(replaced.status).toBe(201);
    expect(((await replaced.json()) as { brief: { campaignMessage: string } }).brief.campaignMessage).toBe(
      "Updated",
    );
    expect(await loadBrief(join(dir, "briefs", "camp.yaml"))).toMatchObject({
      campaignMessage: "Updated",
    });
  });

  test("POST rejects an invalid brief with 400", async () => {
    const { create } = await api();
    const res = await create()(jsonReq("http://x/campaigns/briefs", "POST", { id: "camp" }));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  test("POST returns 400 with a default message when body parsing throws a non-Error", async () => {
    const { create } = await api();
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid campaign brief" });
    } finally {
      g.readBody = original;
    }
  });

  test("PUT rewrites an existing yaml and returns 200", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const res = await update()(
      jsonReq("http://x/campaigns/briefs/camp", "PUT", brief({ campaignMessage: "Edited" })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      file: "camp.yaml",
      brief: brief({ campaignMessage: "Edited" }),
    });
  });

  test("PUT rewrites an existing .yml in place", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "camp.yml"), validBrief.replace("id: good", "id: camp"));
    const { update } = await api();
    const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", brief()));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { file: string }).file).toBe("camp.yml");
    expect(await loadBrief(join(dir, "briefs", "camp.yml"))).toMatchObject({ id: "camp" });
  });

  test("PUT returns 400 when the path id does not match brief.id", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", brief({ id: "other" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Path id "camp" does not match brief.id "other".',
    });
  });

  test("PUT returns 404 when no yaml/yml file exists", async () => {
    const { update } = await api();
    const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", brief()));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Brief "camp" not found.' });
  });

  test("PUT returns 404 for a JSON-only brief", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "camp.json"), JSON.stringify(brief()));
    const { update } = await api();
    const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", brief()));
    expect(res.status).toBe(404);
  });

  test("PUT rejects an unsafe path id with 400", async () => {
    const { update } = await api();
    const res = await update()(jsonReq("http://x/campaigns/briefs/Bad", "PUT", brief()));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/path-safe slug/),
    });
  });

  test("PUT rejects an invalid brief with 400", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", { id: "camp" }));
    expect(res.status).toBe(400);
  });

  test("PUT returns 400 with a default message when body parsing throws a non-Error", async () => {
    const { update } = await api();
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", brief()));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid campaign brief" });
    } finally {
      g.readBody = original;
    }
  });

  test("duplicate copies products, changes id, and returns 201", async () => {
    const { create, duplicate } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "camp-copy" }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { file: string; brief: { id: string; products: unknown[] } };
    expect(json.file).toBe("camp-copy.yaml");
    expect(json.brief.id).toBe("camp-copy");
    expect(json.brief.products).toEqual(brief().products);
    expect(await loadBrief(join(dir, "briefs", "camp-copy.yaml"))).toMatchObject({ id: "camp-copy" });
  });

  test("duplicate loads a JSON source", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "camp.json"), JSON.stringify(brief()));
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "from-json" }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { file: string }).file).toBe("from-json.yaml");
  });

  test("duplicate returns 404 when the source is missing", async () => {
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Brief "camp" not found.' });
  });

  test("duplicate returns 409 when the target yaml exists", async () => {
    const { create, duplicate } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief({ id: "copy" })));
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Brief "copy.yaml" already exists.' });
  });

  test("duplicate rejects an unsafe source id with 400", async () => {
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/Bad/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(400);
  });

  test.each([
    ["a missing body object", 42],
    ["null", null],
    ["a missing newId", {}],
    ["a non-string newId", { newId: 1 }],
    ["an unsafe newId", { newId: "Not Safe" }],
  ])("duplicate rejects %s with 400", async (_label, body) => {
    const { create, duplicate } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const res = await duplicate()(jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", body));
    expect(res.status).toBe(400);
  });

  test("duplicate returns 400 when the source file is malformed", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "camp.yaml"), "id: 1\nproducts: not-an-array\n");
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  test("duplicate returns 400 with a default message when body parsing throws a non-Error", async () => {
    const { duplicate } = await api();
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await duplicate()(
        jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "copy" }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid duplicate request" });
    } finally {
      g.readBody = original;
    }
  });

});
