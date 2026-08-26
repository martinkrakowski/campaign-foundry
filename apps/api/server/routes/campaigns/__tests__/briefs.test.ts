import { createHash } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
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

  test("lists a motion brief while the ffmpeg capability is off (D15 authoring mode)", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "good.yaml"), validBrief);
    writeFileSync(
      join(dir, "briefs", "motion.yaml"),
      `${validBrief.replace("id: good", "id: clip")}mode: variation\nvariation:\n  count: 1\n  axes:\n    motion: [ken-burns-in]\noutput:\n  formats: [static, motion]\n`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await web(await handlerFor(dir))(new Request("http://x/campaigns/briefs"));
    const json = (await res.json()) as { briefs: { file: string }[] };

    expect(json.briefs.map((entry) => entry.file)).toEqual(["good.yaml", "motion.yaml"]);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/skipped motion\.yaml/);
  });

  test("returns an empty list when the briefs directory is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await web(await handlerFor(dir))(new Request("http://x/campaigns/briefs")); // no briefs/ dir
    expect((await res.json()) as { briefs: unknown[] }).toEqual({ briefs: [] });
    expect(warn).toHaveBeenCalled();
  });

  test("includes revision (content hash) on every entry", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(join(dir, "briefs", "good.yaml"), validBrief);
    const res = await web(await handlerFor(dir))(new Request("http://x/campaigns/briefs"));
    const json = (await res.json()) as { briefs: { file: string; brief: { id: string }; revision: string }[] };
    expect(json.briefs).toHaveLength(1);
    expect(json.briefs[0].revision).toBeDefined();
    expect(json.briefs[0].revision).toMatch(/^[a-f0-9]{64}$/);
    const expectedHash = createHash("sha256").update(validBrief).digest("hex");
    expect(json.briefs[0].revision).toBe(expectedHash);
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

  const yamlPath = (...parts: string[]) => join(dir, "briefs", ...parts);
  const campYaml = () => yamlPath("camp.yaml");

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
    expect(json.briefs).toMatchObject([{ file: "camp.yaml", brief: payload }]);
    expect(json.briefs[0]).toHaveProperty("revision");

    const onDisk = await loadBrief(campYaml());
    expect(onDisk).toMatchObject({ id: "camp", localizedMessage: "Hallo" });
    const dumped = readFileSync(campYaml(), "utf8");
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

  test("POST preserves an extra top-level key through the file and GET", async () => {
    const { create, list } = await api();
    const payload = brief({ notes: "keep-me" });
    const posted = await create()(jsonReq("http://x/campaigns/briefs", "POST", payload));
    expect(posted.status).toBe(201);
    expect(((await posted.json()) as { brief: { notes: string } }).brief.notes).toBe("keep-me");
    expect(readFileSync(campYaml(), "utf8")).toMatch(/^notes: keep-me$/m);
    const listed = await list()(new Request("http://x/campaigns/briefs"));
    const json = (await listed.json()) as { briefs: { brief: { notes?: string } }[] };
    expect(json.briefs[0]?.brief.notes).toBe("keep-me");
  });

  test("POST without replace returns 409 when the yaml already exists", async () => {
    const { create } = await api();
    const first = await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    expect(first.status).toBe(201);
    const original = readFileSync(campYaml());
    const again = await create()(jsonReq("http://x/campaigns/briefs", "POST", brief({ campaignMessage: "Nope" })));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'Brief "camp" already exists.' });
    expect(readFileSync(campYaml())).toEqual(original);
  });

  test("POST without replace 409s when the id lives in a differently named file", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    const original = validBrief.replace("id: good", "id: camp");
    writeFileSync(yamlPath("sample-campaign.yaml"), original);
    const { create } = await api();
    const res = await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    expect(res.status).toBe(409);
    expect(readFileSync(yamlPath("sample-campaign.yaml"), "utf8")).toBe(original);
    expect(existsSync(campYaml())).toBe(false);
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
    expect(await loadBrief(campYaml())).toMatchObject({
      campaignMessage: "Updated",
    });
  });

  test("POST ?replace=1&replace=1 still replaces", async () => {
    const { create } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const replaced = await create()(
      jsonReq("http://x/campaigns/briefs?replace=1&replace=1", "POST", brief({ campaignMessage: "Twice" })),
    );
    expect(replaced.status).toBe(201);
    expect(await loadBrief(campYaml())).toMatchObject({ campaignMessage: "Twice" });
  });

  test("POST ?replace=1 rewrites the file that owns the id in its own format", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(yamlPath("sample-campaign.json"), JSON.stringify(brief()));
    const { create } = await api();
    const replaced = await create()(
      jsonReq("http://x/campaigns/briefs?replace=1", "POST", brief({ campaignMessage: "Updated" })),
    );
    expect(replaced.status).toBe(201);
    expect(((await replaced.json()) as { file: string }).file).toBe("sample-campaign.json");
    expect(existsSync(campYaml())).toBe(false);
    expect(JSON.parse(readFileSync(yamlPath("sample-campaign.json"), "utf8"))).toMatchObject({
      campaignMessage: "Updated",
    });
  });

  test("POST ?replace=1 creates when the id is new", async () => {
    const { create } = await api();
    const res = await create()(jsonReq("http://x/campaigns/briefs?replace=1", "POST", brief()));
    expect(res.status).toBe(201);
    expect(existsSync(campYaml())).toBe(true);
  });

  test("POST ?replace=1 refuses a symlink at briefs/<id>.yaml", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    const outside = join(dir, "outside.yaml");
    writeFileSync(outside, "ORIGINAL");
    symlinkSync(outside, campYaml());
    const { create } = await api();
    const res = await create()(jsonReq("http://x/campaigns/briefs?replace=1", "POST", brief()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Refusing to write through a symlink." });
    expect(readFileSync(outside, "utf8")).toBe("ORIGINAL");
  });

  test("two concurrent POSTs yield one 201 and one 409, and the winner's bytes stay", async () => {
    const { create } = await api();
    const handler = create();
    const [a, b] = await Promise.all([
      handler(jsonReq("http://x/campaigns/briefs", "POST", brief())),
      handler(jsonReq("http://x/campaigns/briefs", "POST", brief({ campaignMessage: "Other" }))),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    await a.json();
    await b.json();
    expect(existsSync(campYaml())).toBe(true);
    const onDisk = await loadBrief(campYaml());
    expect(["Hi", "Other"]).toContain(onDisk.campaignMessage);
  });

  test("POST 409 on a pre-existing unparseable file does not overwrite it", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    const original = "not-valid-yaml: [";
    writeFileSync(campYaml(), original);
    const { create } = await api();
    const res = await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    expect(res.status).toBe(409);
    expect(readFileSync(campYaml(), "utf8")).toBe(original);
  });

  test("POST rejects an invalid brief with 400", async () => {
    const { create } = await api();
    const res = await create()(jsonReq("http://x/campaigns/briefs", "POST", { id: "camp" }));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
    expect(existsSync(campYaml())).toBe(false);
  });

  test("POST surfaces an unexpected write error", async () => {
    const { create } = await api();
    const briefFiles = await import("../../../lib/brief-files.js");
    const spy = vi
      .spyOn(briefFiles, "createBriefFile")
      .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    const res = await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    expect(res.status).toBe(500);
    expect(existsSync(campYaml())).toBe(false);
    spy.mockRestore();
  });

  test("POST returns 400 with errorMessage when body parsing throws a non-Error", async () => {
    const { create } = await api();
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "non-error parse failure" });
      expect(existsSync(campYaml())).toBe(false);
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
    writeFileSync(yamlPath("camp.yml"), validBrief.replace("id: good", "id: camp"));
    const { update } = await api();
    const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", brief()));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { file: string }).file).toBe("camp.yml");
    expect(await loadBrief(yamlPath("camp.yml"))).toMatchObject({ id: "camp" });
  });

  test("PUT rewrites a JSON brief in place as JSON", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(yamlPath("camp.json"), JSON.stringify(brief()));
    const { update } = await api();
    const res = await update()(
      jsonReq("http://x/campaigns/briefs/camp", "PUT", brief({ campaignMessage: "From JSON" })),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { file: string }).file).toBe("camp.json");
    expect(existsSync(campYaml())).toBe(false);
    expect(JSON.parse(readFileSync(yamlPath("camp.json"), "utf8"))).toMatchObject({
      campaignMessage: "From JSON",
    });
  });

  test("PUT rewrites a differently named file that owns the id", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(yamlPath("sample-campaign.yaml"), validBrief.replace("id: good", "id: camp"));
    const { update } = await api();
    const res = await update()(
      jsonReq("http://x/campaigns/briefs/camp", "PUT", brief({ campaignMessage: "Named" })),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { file: string }).file).toBe("sample-campaign.yaml");
    expect(existsSync(campYaml())).toBe(false);
    expect(await loadBrief(yamlPath("sample-campaign.yaml"))).toMatchObject({
      campaignMessage: "Named",
    });
  });

  test("PUT returns 400 when the path id does not match brief.id", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const original = readFileSync(campYaml());
    const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", brief({ id: "other" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Path id "camp" does not match brief.id "other".',
    });
    expect(readFileSync(campYaml())).toEqual(original);
  });

  test("PUT returns 404 when no file has the id", async () => {
    const { update } = await api();
    const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", brief()));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Brief "camp" not found.' });
    expect(existsSync(campYaml())).toBe(false);
  });

  test("PUT rejects an unsafe path id with 400", async () => {
    const { update } = await api();
    const res = await update()(jsonReq("http://x/campaigns/briefs/Bad", "PUT", brief()));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/path-safe slug/),
    });
    expect(existsSync(join(dir, "briefs"))).toBe(false);
  });

  test("PUT rejects an invalid brief with 400", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const original = readFileSync(campYaml());
    const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", { id: "camp" }));
    expect(res.status).toBe(400);
    expect(readFileSync(campYaml())).toEqual(original);
  });

  test("PUT returns 400 when rewrite refuses a symlink", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const original = readFileSync(campYaml());
    const briefFiles = await import("../../../lib/brief-files.js");
    const spy = vi.spyOn(briefFiles, "rewriteBriefFile").mockRejectedValueOnce(
      new Error("Refusing to write through a symlink."),
    );
    const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", brief({ campaignMessage: "Nope" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Refusing to write through a symlink." });
    expect(readFileSync(campYaml())).toEqual(original);
    spy.mockRestore();
  });

  test("PUT surfaces an unexpected rewrite error", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const original = readFileSync(campYaml());
    const briefFiles = await import("../../../lib/brief-files.js");
    const spy = vi
      .spyOn(briefFiles, "rewriteBriefFile")
      .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    const res = await update()(
      jsonReq("http://x/campaigns/briefs/camp", "PUT", brief({ campaignMessage: "Nope" })),
    );
    expect(res.status).toBe(500);
    expect(readFileSync(campYaml())).toEqual(original);
    spy.mockRestore();
  });

  test("PUT returns 400 with errorMessage when body parsing throws a non-Error", async () => {
    const { update } = await api();
    const g = globalThis as Record<string, unknown>;
    const original = g.readBody;
    g.readBody = async () => {
      throw "non-error parse failure";
    };
    try {
      const res = await update()(jsonReq("http://x/campaigns/briefs/camp", "PUT", brief()));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "non-error parse failure" });
      expect(existsSync(campYaml())).toBe(false);
    } finally {
      g.readBody = original;
    }
  });

  test("POST ?replace=1 with stale revision returns 409 with current revision", async () => {
    const { create } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const staleRevision = "stalehash";
    const res = await create()(
      jsonReq(
        `http://x/campaigns/briefs?replace=1&revision=${staleRevision}`,
        "POST",
        brief({ campaignMessage: "Updated" }),
      ),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; revision: string };
    expect(json.error).toBe("Brief was modified by another user.");
    expect(json.revision).toBeDefined();
    expect(json.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(json.revision).not.toBe(staleRevision);
    expect(await loadBrief(campYaml())).toMatchObject({ campaignMessage: "Hi" });
  });

  test("POST ?replace=1 without revision succeeds (backward compatible)", async () => {
    const { create } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const res = await create()(
      jsonReq("http://x/campaigns/briefs?replace=1", "POST", brief({ campaignMessage: "Updated" })),
    );
    expect(res.status).toBe(201);
    expect(await loadBrief(campYaml())).toMatchObject({ campaignMessage: "Updated" });
  });

  test("PUT with stale revision returns 409 with current revision", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const staleRevision = "stalehash";
    const res = await update()(
      jsonReq(`http://x/campaigns/briefs/camp?revision=${staleRevision}`, "PUT", brief({ campaignMessage: "Edited" })),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; revision: string };
    expect(json.error).toBe("Brief was modified by another user.");
    expect(json.revision).toBeDefined();
    expect(json.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(json.revision).not.toBe(staleRevision);
    expect(await loadBrief(campYaml())).toMatchObject({ campaignMessage: "Hi" });
  });

  test("PUT without revision succeeds (backward compatible)", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const res = await update()(
      jsonReq("http://x/campaigns/briefs/camp", "PUT", brief({ campaignMessage: "Edited" })),
    );
    expect(res.status).toBe(200);
    expect(await loadBrief(campYaml())).toMatchObject({ campaignMessage: "Edited" });
  });

  test("PUT with current revision succeeds", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const currentRevision = createHash("sha256").update(readFileSync(campYaml())).digest("hex");
    const res = await update()(
      jsonReq(
        `http://x/campaigns/briefs/camp?revision=${currentRevision}`,
        "PUT",
        brief({ campaignMessage: "Edited" }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await loadBrief(campYaml())).toMatchObject({ campaignMessage: "Edited" });
  });

  test("POST ?replace=1 with revision as array uses first value", async () => {
    const { create } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const currentRevision = createHash("sha256").update(readFileSync(campYaml())).digest("hex");
    const res = await create()(
      jsonReq(
        `http://x/campaigns/briefs?replace=1&revision=${currentRevision}&revision=stale`,
        "POST",
        brief({ campaignMessage: "Updated" }),
      ),
    );
    expect(res.status).toBe(201);
    expect(await loadBrief(campYaml())).toMatchObject({ campaignMessage: "Updated" });
  });

  test("PUT with revision as array uses first value", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const currentRevision = createHash("sha256").update(readFileSync(campYaml())).digest("hex");
    const res = await update()(
      jsonReq(
        `http://x/campaigns/briefs/camp?revision=${currentRevision}&revision=stale`,
        "PUT",
        brief({ campaignMessage: "Edited" }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await loadBrief(campYaml())).toMatchObject({ campaignMessage: "Edited" });
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
    expect(await loadBrief(yamlPath("camp-copy.yaml"))).toMatchObject({ id: "camp-copy" });
  });

  test("duplicate loads a JSON source", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(yamlPath("camp.json"), JSON.stringify(brief()));
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "from-json" }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { file: string }).file).toBe("from-json.yaml");
  });

  test("duplicate finds the source by brief.id, not filename", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(yamlPath("sample-campaign.yaml"), validBrief.replace("id: good", "id: camp"));
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "from-sample" }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { file: string }).file).toBe("from-sample.yaml");
  });

  test("duplicate returns 404 when the source is missing", async () => {
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Brief "camp" not found.' });
    expect(existsSync(yamlPath("copy.yaml"))).toBe(false);
  });

  test("duplicate returns 404 when the source file is malformed", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(campYaml(), "id: 1\nproducts: not-an-array\n");
    const original = readFileSync(campYaml());
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(404);
    expect(readFileSync(campYaml())).toEqual(original);
    expect(existsSync(yamlPath("copy.yaml"))).toBe(false);
  });

  test("duplicate returns 409 when any file already has newId", async () => {
    const { create, duplicate } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief({ id: "copy" })));
    const original = readFileSync(yamlPath("copy.yaml"));
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Brief "copy" already exists.' });
    expect(readFileSync(yamlPath("copy.yaml"))).toEqual(original);
  });

  test("duplicate 409s when newId lives in a differently named file", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(yamlPath("sample.yaml"), validBrief.replace("id: good", "id: camp"));
    writeFileSync(yamlPath("other.yaml"), validBrief.replace("id: good", "id: copy"));
    const original = readFileSync(yamlPath("other.yaml"));
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(409);
    expect(readFileSync(yamlPath("other.yaml"))).toEqual(original);
    expect(existsSync(yamlPath("copy.yaml"))).toBe(false);
  });

  test("duplicate 409s without overwriting a pre-existing dest file", async () => {
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(campYaml(), validBrief.replace("id: good", "id: camp"));
    const dest = yamlPath("copy.yaml");
    writeFileSync(dest, "UNPARSED");
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(409);
    expect(readFileSync(dest, "utf8")).toBe("UNPARSED");
  });

  test("duplicate surfaces an unexpected write error", async () => {
    const { create, duplicate } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const briefFiles = await import("../../../lib/brief-files.js");
    const spy = vi
      .spyOn(briefFiles, "createBriefFile")
      .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(500);
    expect(existsSync(yamlPath("copy.yaml"))).toBe(false);
    spy.mockRestore();
  });

  test("duplicate rejects an unsafe source id with 400", async () => {
    const { duplicate } = await api();
    const res = await duplicate()(
      jsonReq("http://x/campaigns/briefs/Bad/duplicate", "POST", { newId: "copy" }),
    );
    expect(res.status).toBe(400);
    expect(existsSync(yamlPath("copy.yaml"))).toBe(false);
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
    const original = readFileSync(campYaml());
    const res = await duplicate()(jsonReq("http://x/campaigns/briefs/camp/duplicate", "POST", body));
    expect(res.status).toBe(400);
    expect(readFileSync(campYaml())).toEqual(original);
    expect(existsSync(yamlPath("copy.yaml"))).toBe(false);
  });

  test("duplicate returns 400 with errorMessage when body parsing throws a non-Error", async () => {
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
      expect(await res.json()).toEqual({ error: "non-error parse failure" });
      expect(existsSync(yamlPath("copy.yaml"))).toBe(false);
    } finally {
      g.readBody = original;
    }
  });

  test("POST with concurrent delete in replace mode falls through to create", async () => {
    const { create } = await api();
    const briefFiles = await import("../../../lib/brief-files.js");
    mkdirSync(join(dir, "briefs"), { recursive: true });
    writeFileSync(campYaml(), briefFiles.dumpBrief(brief({ campaignMessage: "Original" })));
    vi.spyOn(briefFiles, "hashFile").mockImplementation(async (_path: string) => {
      // Throw ENOENT to simulate the file being deleted between lookup and hash
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const res = await create()(
      jsonReq("http://x/campaigns/briefs?replace=1&revision=stalehash", "POST", brief({ campaignMessage: "Fallback" })),
    );
    // ENOENT during hash check in replace mode falls through to create attempt
    expect([201, 409]).toContain(res.status);
    vi.spyOn(briefFiles, "hashFile").mockRestore();
  });

  test("PUT with concurrent delete returns 404", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const briefFiles = await import("../../../lib/brief-files.js");
    vi.spyOn(briefFiles, "hashFile").mockImplementation(async (_path: string) => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const res = await update()(
      jsonReq(`http://x/campaigns/briefs/camp?revision=stalehash`, "PUT", brief({ campaignMessage: "Edited" })),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Brief "camp" not found.' });
  });

  test("POST with unexpected hash error surfaces the error", async () => {
    const { create } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const briefFiles = await import("../../../lib/brief-files.js");
    vi.spyOn(briefFiles, "hashFile").mockImplementation(async (_path: string) => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    const res = await create()(
      jsonReq("http://x/campaigns/briefs?replace=1&revision=stalehash", "POST", brief({ campaignMessage: "Nope" })),
    );
    expect(res.status).toBe(500);
  });

  test("PUT with unexpected hash error surfaces the error", async () => {
    const { create, update } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const briefFiles = await import("../../../lib/brief-files.js");
    vi.spyOn(briefFiles, "hashFile").mockImplementation(async (_path: string) => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    const res = await update()(
      jsonReq(`http://x/campaigns/briefs/camp?revision=stalehash`, "PUT", brief({ campaignMessage: "Edited" })),
    );
    expect(res.status).toBe(500);
  });

  test("two conditional PUTs with the same revision: exactly one wins, the other gets 409", async () => {
    const { create, update, list } = await api();
    await create()(jsonReq("http://x/campaigns/briefs", "POST", brief()));
    const listed = (await (await list()(new Request("http://x/campaigns/briefs"))).json()) as {
      briefs: { revision: string }[];
    };
    const revision = listed.briefs[0].revision;

    // Both requests are issued against the same handler instance and awaited together,
    // so they overlap exactly the way two browser tabs would. Without the per-brief lock
    // both pass the hash comparison and the later write silently discards the earlier.
    const put = update();
    const [first, second] = await Promise.all([
      put(jsonReq(`http://x/campaigns/briefs/camp?revision=${revision}`, "PUT", brief({ campaignMessage: "A" }))),
      put(jsonReq(`http://x/campaigns/briefs/camp?revision=${revision}`, "PUT", brief({ campaignMessage: "B" }))),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    // The loser must not have written: the file holds exactly the winner's message.
    expect(await loadBrief(campYaml())).toMatchObject({
      campaignMessage: first.status === 200 ? "A" : "B",
    });
  });

  test("the listing revision matches the write path's hash for a non-UTF-8 file", async () => {
    const { list } = await api();
    mkdirSync(join(dir, "briefs"), { recursive: true });
    // A lone 0xFF byte is not valid UTF-8. Decoding to a string and re-encoding replaces
    // it with U+FFFD and changes the digest, so the listing would hand out a revision no
    // conditional write could ever match — a 409 the client can never clear.
    writeFileSync(
      campYaml(),
      Buffer.concat([
        Buffer.from('id: camp\ntargetRegion: DE\ntargetAudience: a\ncampaignMessage: "hi '),
        Buffer.from([0xff]),
        Buffer.from('"\nproducts:\n  - id: alpha\n  - id: beta\n'),
      ]),
    );

    const listed = (await (await list()(new Request("http://x/campaigns/briefs"))).json()) as {
      briefs: { revision: string }[];
    };
    const { hashFile } = await import("../../../lib/brief-files.js");
    expect(listed.briefs).toHaveLength(1);
    expect(listed.briefs[0].revision).toBe(await hashFile(campYaml()));
  });

  test("D12: a motion brief is created, updated and re-read verbatim while the capability is off", async () => {
    const { setCapabilities } = await import("../../../lib/capabilities.js");
    setCapabilities({ motion: false, reason: "ffmpeg-static binary is not available" });
    try {
      const { create, update } = await api();
      const motion = brief({
        mode: "variation",
        variation: {
          count: 4,
          axes: {
            layout: ["headline-top"],
            tone: ["bold"],
            background: { source: ["procedural"] },
            paletteShift: [0],
            motion: ["ken-burns-in"],
            duration: [6],
          },
        },
        output: { formats: ["motion"], platforms: ["instagram-reel"] },
      });

      // authoring mode: this host cannot run it, but it must still persist (D7/D12)
      const created = await create()(jsonReq("http://x/campaigns/briefs", "POST", motion));
      expect(created.status).toBe(201);

      const afterCreate = await loadBrief(campYaml());
      expect(afterCreate.variation?.axes?.motion).toEqual(["ken-burns-in"]);
      expect(afterCreate.variation?.axes?.duration).toEqual([6]);
      expect(afterCreate.output?.formats).toEqual(["motion"]);

      const updated = await update()(
        jsonReq("http://x/campaigns/briefs/camp", "PUT", { ...motion, campaignMessage: "Edited" }),
      );
      expect(updated.status).toBe(200);

      // nothing stripped on the way through the second write either
      const afterUpdate = await loadBrief(campYaml());
      expect(afterUpdate.campaignMessage).toBe("Edited");
      expect(afterUpdate.variation?.axes?.motion).toEqual(["ken-burns-in"]);
      expect(afterUpdate.variation?.axes?.duration).toEqual([6]);
      expect(afterUpdate.output?.platforms).toEqual(["instagram-reel"]);
    } finally {
      setCapabilities({ motion: false, reason: "not probed" });
    }
  });

});
