import {
  CanonicalTemplateCollisionError,
  TemplateVersionExistsError,
  type CreativeTemplate,
} from "@campaignfoundry/CampaignOrchestration";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createEvent } from "h3";
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { FsTemplateStore } from "../../../lib/ports/fs-template-store.js";
import { resetTemplateStore, setTemplateStore } from "../../../lib/ports/index.js";
import type {
  TemplateStorePort,
  WritableTemplateStorePort,
} from "../../../lib/ports/template-store.port.js";
import type { TenantContext } from "../../../lib/tenant.js";
import { MAX_TEMPLATE_BODY_BYTES } from "../../../lib/template-write.js";
import listHandler from "../templates.get.js";
import postHandler from "../templates.post.js";
import byRefHandler from "../templates/[ref].get.js";
import putHandler from "../templates/[ref].put.js";
import {
  LOCAL_TENANT,
  mountTenantApp,
  setupPgHarness,
  type PgHarness,
} from "../../__tests__/tenant-harness.js";

/**
 * `POST /campaigns/templates` and `PUT /campaigns/templates/:ref` (RW-22) on
 * PGlite: every happy path and every refusal, each asserting real status, real
 * body, and real store state (a refusal must write nothing, a write must land
 * exactly one row). Handlers are STATIC imports — the harness's injected
 * database must reach the route, so nothing here re-imports modules.
 */

const OWNER_A: TenantContext = { orgId: "local", userId: "u1", roles: ["owner"], teamIds: [] };
const ADMIN_B: TenantContext = { orgId: "acme", userId: "u2", roles: ["admin"], teamIds: [] };
const VIEWER: TenantContext = { orgId: "local", userId: "u3", roles: ["viewer"], teamIds: [] };

/** A body the store's own validator accepts, one layer per canonical kind. */
const VALID_BODY = {
  name: "Summer Sale",
  unit: "standard-web",
  creativeType: "image-text",
  layers: [
    { id: "image", kind: "image" },
    { id: "shade", kind: "shade" },
    { id: "accent", kind: "accent" },
    { id: "static-text", kind: "static-text" },
    { id: "logo", kind: "logo" },
  ],
} as const;

let harness: PgHarness;
let tenant: TenantContext;

const web = mountTenantApp(
  [
    { method: "post", path: "/campaigns/templates", handler: postHandler },
    { method: "put", path: "/campaigns/templates/:ref", handler: putHandler },
    { path: "/campaigns/templates", handler: listHandler },
    { path: "/campaigns/templates/:ref", handler: byRefHandler },
  ],
  () => tenant,
);

const call = (method: string, path: string, body?: string): Promise<Response> =>
  web(
    new Request(
      `http://x${path}`,
      body === undefined
        ? { method }
        : { method, headers: { "content-type": "application/json" }, body },
    ),
  );

const postJson = (body: unknown): Promise<Response> =>
  call("post", "/campaigns/templates", JSON.stringify(body));

const putJson = (ref: string, body: unknown): Promise<Response> =>
  call("put", `/campaigns/templates/${ref}`, JSON.stringify(body));

const getJson = (path: string): Promise<Response> => call("get", path);

/** Non-canonical template rows in the org layer — what a write adds and a refusal must not. */
async function rowCount(): Promise<number> {
  const { rows } = await harness.db.query<{ n: number }>(
    "select count(*)::int as n from template where id not like 'canonical-%'",
  );
  return rows[0]!.n;
}

interface RouteBody {
  error?: string;
  template?: CreativeTemplate;
  templates?: CreativeTemplate[];
}

const bodyOf = async (res: Response): Promise<RouteBody> => (await res.json()) as RouteBody;

/**
 * A `ReadableStream` that records what the reader actually pulled from it:
 * `highWaterMark: 0` so no chunk is enqueued before a `read()` asks for one,
 * and a `cancel()` flag so an early abort is observable.
 */
interface StreamStats {
  chunksPulled: number;
  bytesPulled: number;
  cancelled: boolean;
}

const countingStream = (
  chunks: Uint8Array[],
): { stream: ReadableStream<Uint8Array>; stats: StreamStats } => {
  const stats: StreamStats = { chunksPulled: 0, bytesPulled: 0, cancelled: false };
  let next = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (next >= chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[next++]!;
        stats.chunksPulled += 1;
        stats.bytesPulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
};

/** Split a string's UTF-8 bytes into fixed-size stream chunks. */
const utf8Chunks = (raw: string, size: number): Uint8Array[] => {
  const bytes = new TextEncoder().encode(raw);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(bytes.slice(i, i + size));
  }
  return chunks;
};

/** POST a streamed body to the template route, with optional extra headers. */
const postStream = (
  stream: ReadableStream<Uint8Array>,
  headers?: Record<string, string>,
): Promise<Response> =>
  web(
    new Request("http://x/campaigns/templates", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: stream,
      duplex: "half",
    } as RequestInit),
  );

/**
 * A Node-path event (`createEvent(req, res)`, no `event.web`) whose request is
 * a counting `Readable` pushing the given chunks — what Nitro `node-server`
 * hands a handler, where `event.node.req` is the only body there is.
 */
const nodeEvent = (
  chunks: Buffer[],
  emitError?: Error,
): { event: ReturnType<typeof createEvent>; req: Readable; stats: { bytesPulled: number } } => {
  const stats = { bytesPulled: 0 };
  let next = 0;
  const req = new Readable({
    highWaterMark: 0,
    read() {
      if (next < chunks.length) {
        const chunk = chunks[next++]!;
        stats.bytesPulled += chunk.byteLength;
        this.push(chunk);
      } else if (emitError) {
        this.destroy(emitError);
      } else {
        this.push(null);
      }
    },
  });
  const incoming = Object.assign(req as unknown as IncomingMessage, {
    method: "POST",
    url: "/campaigns/templates",
    headers: { "content-type": "application/json" },
  });
  const event = createEvent(incoming, new ServerResponse(incoming));
  return { event, req, stats };
};

/** The handler function behind `defineEventHandler`, callable with a bare event. */
const postRoute = postHandler as unknown as (
  event: ReturnType<typeof createEvent>,
) => Promise<RouteBody>;

/** A read store with an optional write method, as `setTemplateStore` expects it. */
const storeDouble = (overrides: Partial<WritableTemplateStorePort>): TemplateStorePort => ({
  listTemplates: () => Promise.reject(new Error("unused")),
  findTemplate: () => Promise.reject(new Error("unused")),
  exists: () => Promise.reject(new Error("unused")),
  ...overrides,
});

describe("template write routes (POST /campaigns/templates, PUT /campaigns/templates/:ref)", () => {
  beforeEach(async () => {
    harness = await setupPgHarness();
    await harness.db.query(
      "insert into org (id, name) values ('local', 'Local') on conflict do nothing",
    );
    tenant = OWNER_A;
  });

  afterEach(async () => {
    resetTemplateStore();
    await harness.cleanup();
  });

  test("POST creates an org template at version 1 (201) and only its org sees it", async () => {
    const res = await postJson(VALID_BODY);
    expect(res.status).toBe(201);
    const { template } = await bodyOf(res);
    expect(template?.version).toBe(1);
    expect(template?.name).toBe("Summer Sale");
    expect(template?.id).toMatch(/^tpl-/);

    const listA = await bodyOf(await getJson("/campaigns/templates"));
    expect(listA.templates?.some((t) => t.id === template?.id)).toBe(true);

    tenant = ADMIN_B;
    const listB = await bodyOf(await getJson("/campaigns/templates"));
    expect(listB.templates?.some((t) => t.id === template?.id)).toBe(false);
    expect(await rowCount()).toBe(1);
  });

  test("PUT creates version 2 (200) and version 1 stays byte-identical", async () => {
    const created = await bodyOf(await postJson(VALID_BODY));
    const id = created.template!.id;

    const updated = await putJson(id, { ...VALID_BODY, name: "Summer Sale v2" });
    expect(updated.status).toBe(200);
    const v2 = (await bodyOf(updated)).template;
    expect(v2?.version).toBe(2);
    expect(v2?.name).toBe("Summer Sale v2");

    const pinned = await bodyOf(await getJson(`/campaigns/templates/${id}@1`));
    expect(pinned.template).toEqual(created.template);
    expect((await bodyOf(await getJson(`/campaigns/templates/${id}`))).template?.version).toBe(2);
    expect(await rowCount()).toBe(2);
  });

  test("PUT by org B on org A's template id returns 404 identical to a missing id and writes nothing", async () => {
    const id = (await bodyOf(await postJson(VALID_BODY))).template!.id;
    const before = await rowCount();

    tenant = ADMIN_B;
    const foreign = await putJson(id, VALID_BODY);
    const missing = await putJson("tpl-does-not-exist", VALID_BODY);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    // The 404 only echoes what the caller asked for; the body shape and status
    // are identical — nothing distinguishes another org's row from absence.
    expect((await bodyOf(foreign)).error).toMatch(/^Template not found: "/);
    expect((await bodyOf(missing)).error).toMatch(/^Template not found: "/);

    tenant = OWNER_A;
    expect(await rowCount()).toBe(before);
    const v1 = await bodyOf(await getJson(`/campaigns/templates/${id}@1`));
    expect(v1.template?.version).toBe(1);
    expect((await bodyOf(await getJson(`/campaigns/templates/${id}@2`))).template).toBeUndefined();
  });

  test("under AUTH_MODE=local, LOCAL_TENANT (owner) can POST and PUT", async () => {
    tenant = LOCAL_TENANT;
    const created = await bodyOf(await postJson(VALID_BODY));
    expect(created.template?.version).toBe(1);
    const updated = await bodyOf(await putJson(created.template!.id, VALID_BODY));
    expect(updated.template?.version).toBe(2);
  });

  test("refuses a role without write permission with 403 and writes nothing", async () => {
    tenant = VIEWER;
    const posted = await postJson(VALID_BODY);
    expect(posted.status).toBe(403);
    expect((await bodyOf(posted)).error).toBe("Not authorized to save templates.");

    tenant = { orgId: "local", userId: "u4", roles: [], teamIds: [] };
    const put = await putJson("tpl-x", VALID_BODY);
    expect(put.status).toBe(403);
    expect((await bodyOf(put)).error).toBe("Not authorized to save templates.");
    expect(await rowCount()).toBe(0);
  });

  test("refuses an oversize body with 413 and writes nothing", async () => {
    const big = JSON.stringify({ ...VALID_BODY, name: "x".repeat(70 * 1024) });
    const posted = await call("post", "/campaigns/templates", big);
    expect(posted.status).toBe(413);
    expect((await bodyOf(posted)).error).toBe("Template body exceeds the 64 KiB size limit.");

    const seeded = await bodyOf(await postJson(VALID_BODY));
    const put = await call(
      "put",
      `/campaigns/templates/${seeded.template!.id}`,
      JSON.stringify({ ...VALID_BODY, name: "x".repeat(70 * 1024) }),
    );
    expect(put.status).toBe(413);
    expect(await rowCount()).toBe(1);
  });

  test("aborts oversized chunked stream early with 413 without buffering full body", async () => {
    // A valid-prefix JSON stream far over the cap: 1 MiB in 16 KiB chunks.
    const raw = JSON.stringify({ ...VALID_BODY, name: "x".repeat(1024 * 1024) });
    const { stream, stats } = countingStream(utf8Chunks(raw, 16 * 1024));
    const posted = await postStream(stream);
    expect(posted.status).toBe(413);
    expect((await bodyOf(posted)).error).toBe("Template body exceeds the 64 KiB size limit.");
    // The reader stopped early — the cap was crossed and the stream cancelled,
    // never buffering the full 1 MiB.
    expect(stats.cancelled).toBe(true);
    expect(stats.bytesPulled).toBeLessThanOrEqual(MAX_TEMPLATE_BODY_BYTES + 16 * 1024);
    expect(await rowCount()).toBe(0);
  });

  test("refuses lying Content-Length when streamed bytes exceed 64 KiB", async () => {
    const raw = JSON.stringify({ ...VALID_BODY, name: "x".repeat(1024 * 1024) });
    const { stream, stats } = countingStream(utf8Chunks(raw, 16 * 1024));
    const posted = await postStream(stream, { "content-length": "100" });
    expect(posted.status).toBe(413);
    expect((await bodyOf(posted)).error).toBe("Template body exceeds the 64 KiB size limit.");
    expect(stats.bytesPulled).toBeLessThanOrEqual(MAX_TEMPLATE_BODY_BYTES + 16 * 1024);
    expect(await rowCount()).toBe(0);
  });

  test("refuses oversized Content-Length with 413 before reading any stream bytes", async () => {
    const { stream, stats } = countingStream(utf8Chunks("{}", 16 * 1024));
    const posted = await postStream(stream, {
      "content-length": String(MAX_TEMPLATE_BODY_BYTES + 1),
    });
    expect(posted.status).toBe(413);
    expect((await bodyOf(posted)).error).toBe("Template body exceeds the 64 KiB size limit.");
    expect(stats.chunksPulled).toBe(0);
    expect(stats.bytesPulled).toBe(0);
    expect(await rowCount()).toBe(0);
  });

  test("accepts exact 64 KiB body and refuses 64 KiB + 1 byte", async () => {
    // An uncapped layer `id` pads the body to an exact byte size while the
    // template stays valid: the pad image layer sits below the logo (D128's
    // `above`), and `image` carries no maxOf.
    const exactCapBody = (targetBytes: number): Record<string, unknown> => {
      const make = (pad: number): Record<string, unknown> => ({
        ...VALID_BODY,
        layers: [{ id: `pad-${"x".repeat(pad)}`, kind: "image" }, ...VALID_BODY.layers],
      });
      const base = Buffer.byteLength(JSON.stringify(make(0)), "utf8");
      return make(targetBytes - base);
    };
    const exact = await postJson(exactCapBody(MAX_TEMPLATE_BODY_BYTES));
    expect(exact.status).toBe(201);
    expect(await rowCount()).toBe(1);

    const over = await postJson(exactCapBody(MAX_TEMPLATE_BODY_BYTES + 1));
    expect(over.status).toBe(413);
    expect((await bodyOf(over)).error).toBe("Template body exceeds the 64 KiB size limit.");
    expect(await rowCount()).toBe(1);
  });

  test("decodes multi-byte UTF-8 characters split across chunk boundaries", async () => {
    const name = "Été ☀ 日 Café";
    const bytes = Buffer.from(JSON.stringify({ ...VALID_BODY, name }), "utf8");
    // Cut inside the multi-byte emoji, deliberately mid-character.
    const cut = bytes.indexOf(Buffer.from("☀", "utf8")) + 1;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new Uint8Array(bytes.subarray(0, cut)));
          controller.enqueue(new Uint8Array(bytes.subarray(cut)));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const posted = await postStream(stream);
    expect(posted.status).toBe(201);
    expect((await bodyOf(posted)).template?.name).toBe(name);
    expect(await rowCount()).toBe(1);
  });

  test("refuses an empty stream and a bodyless POST with 400 and writes nothing", async () => {
    // A 0-chunk stream (a POST/PUT carrying an empty body stream).
    const empty = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const emptyRes = await postStream(empty);
    expect(emptyRes.status).toBe(400);
    expect((await bodyOf(emptyRes)).error).toBe("Template body must be a JSON object.");

    // A bodyless POST: `event.web.request.body` is null, not an empty stream.
    const bodyless = await web(
      new Request("http://x/campaigns/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(bodyless.status).toBe(400);
    expect((await bodyOf(bodyless)).error).toBe("Template body must be a JSON object.");
    expect(await rowCount()).toBe(0);
  });

  test("pauses and unlistens oversized Node req stream early with 413", async () => {
    // 1 MiB of 16 KiB chunks on `event.node.req` — no `event.web` at all.
    const chunk = Buffer.alloc(16 * 1024, 0x78);
    const { event, req, stats } = nodeEvent(Array.from({ length: 64 }, () => chunk));
    const body = await postRoute(event);
    expect(event.node.res.statusCode).toBe(413);
    expect(body.error).toBe("Template body exceeds the 64 KiB size limit.");
    expect(stats.bytesPulled).toBeLessThanOrEqual(MAX_TEMPLATE_BODY_BYTES + 16 * 1024);
    // The request was paused and every attached listener removed, so no
    // further chunk is buffered or throws and the 413 response stays writable.
    expect(req.isPaused()).toBe(true);
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("end")).toBe(0);
    expect(req.listenerCount("error")).toBe(0);
    expect(await rowCount()).toBe(0);
  });

  test("accepts a small valid template on the Node path (event.node.req)", async () => {
    const { event } = nodeEvent([Buffer.from(JSON.stringify(VALID_BODY), "utf8")]);
    const body = await postRoute(event);
    expect(event.node.res.statusCode).toBe(201);
    expect(body.template?.version).toBe(1);
    expect(await rowCount()).toBe(1);
  });

  test("maps a Node req stream failure to the fixed 500 message and writes nothing", async () => {
    const { event, req } = nodeEvent(
      [Buffer.from('{"name":"partial"')],
      new Error("stream dropped"),
    );
    const body = await postRoute(event);
    expect(event.node.res.statusCode).toBe(500);
    expect(body.error).toBe("Could not save template.");
    expect(req.listenerCount("error")).toBe(0);
    expect(await rowCount()).toBe(0);
  });

  test("refuses empty, malformed, null, or array bodies with 400 and writes nothing", async () => {
    for (const raw of ["", "   ", "not json", "null", "[1]"]) {
      const res = await call("post", "/campaigns/templates", raw);
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error).toBeTruthy();
    }
    const put = await call("put", "/campaigns/templates/tpl-x", "null");
    expect(put.status).toBe(400);
    expect(await rowCount()).toBe(0);
  });

  test("refuses client-supplied id or version with 400 and writes nothing", async () => {
    for (const extra of [{ id: "tpl-custom" }, { version: 7 }]) {
      const res = await postJson({ ...VALID_BODY, ...extra });
      expect(res.status).toBe(400);
      const { error } = await bodyOf(res);
      expect(error).toContain(Object.keys(extra)[0]!);
    }
    const seeded = await bodyOf(await postJson(VALID_BODY));
    for (const extra of [{ id: "tpl-custom" }, { version: 7 }]) {
      const put = await putJson(seeded.template!.id, { ...VALID_BODY, ...extra });
      expect(put.status).toBe(400);
      expect((await bodyOf(put)).error).toContain(Object.keys(extra)[0]!);
    }
    expect(await rowCount()).toBe(1);
  });

  test("refuses unknown top-level keys with 400 and writes nothing", async () => {
    const res = await postJson({ ...VALID_BODY, extra: 1 });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toContain("extra");
    const put = await putJson("tpl-x", { ...VALID_BODY, extra: 1 });
    expect(put.status).toBe(400);
    expect((await bodyOf(put)).error).toContain("extra");
    expect(await rowCount()).toBe(0);
  });

  test("refuses PUT when :ref contains @ with 400", async () => {
    for (const ref of ["tpl-1@2", "a@b"]) {
      const res = await putJson(ref, VALID_BODY);
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error).toBe('Template id must not contain "@".');
    }
    expect(await rowCount()).toBe(0);
  });

  test("returns identical 404 for missing and cross-org template on PUT and writes nothing", async () => {
    const missing = await putJson("tpl-missing", VALID_BODY);
    expect(missing.status).toBe(404);
    expect((await bodyOf(missing)).error).toBe('Template not found: "tpl-missing"');
    expect(await rowCount()).toBe(0);
  });

  test("refuses invalid template fields (bad layer kind, bad unit, missing name) with 400 and writes nothing", async () => {
    for (const body of [
      { ...VALID_BODY, layers: [{ id: "a", kind: "marquee" }] },
      { ...VALID_BODY, unit: "billboard" },
      { ...VALID_BODY, name: "   " },
    ]) {
      const res = await postJson(body);
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error).toBeTruthy();
    }
    expect(await rowCount()).toBe(0);
  });

  test("maps CanonicalTemplateCollisionError to 409", async () => {
    setTemplateStore(
      storeDouble({
        saveTemplate: () =>
          Promise.reject(new CanonicalTemplateCollisionError('template id "x" collides')),
      }),
    );
    const res = await postJson(VALID_BODY);
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toMatch(/collides/);
  });

  test("maps TemplateVersionExistsError on concurrent PUT to 409", async () => {
    const existing: CreativeTemplate = {
      id: "tpl-x",
      version: 1,
      name: "Existing",
      unit: "standard-web",
      creativeType: "image-text",
      layers: VALID_BODY.layers,
    };
    setTemplateStore(
      storeDouble({
        findTemplate: (id) => Promise.resolve(id === "tpl-x" ? existing : undefined),
        exists: () => Promise.resolve(true),
        saveTemplate: () => Promise.reject(new TemplateVersionExistsError()),
      }),
    );
    const res = await putJson("tpl-x", VALID_BODY);
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toMatch(/already exists/);
  });

  test("returns 501 when the store throws TemplateWriteUnsupportedError", async () => {
    const existing: CreativeTemplate = {
      id: "tpl-x",
      version: 1,
      name: "Existing",
      unit: "standard-web",
      creativeType: "image-text",
      layers: VALID_BODY.layers,
    };
    // The read-only seed wrapped by `asWritableTemplateStore`: every write
    // answers `TemplateWriteUnsupportedError` and the route must map it to
    // 501, never 500.
    setTemplateStore(new FsTemplateStore([existing]));
    const posted = await postJson(VALID_BODY);
    expect(posted.status).toBe(501);
    expect((await bodyOf(posted)).error).toMatch(/does not support/);
    const put = await putJson("tpl-x", VALID_BODY);
    expect(put.status).toBe(501);
  });

  test("returns 500 with fixed message on unexpected store failure and leaves no partial write", async () => {
    const rows: CreativeTemplate[] = [];
    setTemplateStore(
      storeDouble({
        listTemplates: () => Promise.resolve(rows),
        findTemplate: () => Promise.reject(new Error("disk on fire")),
        saveTemplate: () => Promise.reject(new Error("disk on fire")),
      }),
    );
    const posted = await postJson(VALID_BODY);
    expect(posted.status).toBe(500);
    const body = await bodyOf(posted);
    expect(body.error).toBe("Could not save template.");
    expect(body.error).not.toMatch(/disk on fire/);

    // A PUT whose findTemplate throws maps the same way: the fixed text, and
    // nothing the double was given to hold.
    const put = await putJson("tpl-x", VALID_BODY);
    expect(put.status).toBe(500);
    expect((await bodyOf(put)).error).toBe("Could not save template.");
    expect(rows).toHaveLength(0);
  });
});
