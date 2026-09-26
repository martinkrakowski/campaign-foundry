import { describe, test, expect, vi, afterEach } from "vitest";
import type { CreativeTemplate } from "@campaignfoundry/CampaignOrchestration";
import { CANONICAL_TEMPLATES } from "@campaignfoundry/CampaignOrchestration/creative-templates";
import {
  TemplatesApiError,
  asCreativeTemplate,
  getTemplate,
  isTemplatesApiError,
  latestPerId,
  listTemplates,
  pinnableTemplate,
  templateRef,
  versionsOf,
} from "../templates-api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const mockFetch = (handler: (url: string) => Response | Promise<Response> | never) => {
  vi.mocked(globalThis.fetch).mockImplementation((url) => Promise.resolve(handler(String(url))));
};

const record = (over: Partial<CreativeTemplate> = {}): CreativeTemplate => ({
  ...CANONICAL_TEMPLATES["image-text"],
  ...over,
});

describe("listTemplates", () => {
  test("reads the list route and carries every field the modal renders", async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return json({ templates: [record()] });
    });
    const templates = await listTemplates();
    expect(urls).toEqual(["/api/pipeline/campaigns/templates"]);
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("Canonical Image & Text");
    expect(templates[0].unit).toBe("standard-web");
    expect(templates[0].creativeType).toBe("image-text");
    expect(templates[0].version).toBe(1);
    expect(templates[0].layers.map((layer) => layer.kind)).toEqual([
      "image",
      "shade",
      "accent",
      "static-text",
      "logo",
    ]);
  });

  test("a genuinely empty library is an empty list, not an error", async () => {
    mockFetch(() => json({ templates: [] }));
    await expect(listTemplates()).resolves.toEqual([]);
  });

  /**
   * The lane's first red fault, on the client side. The route's own doc comment
   * names the conflation ("a store read failure is a 500, never an empty list");
   * a client that answered `[]` for a 500 would restore it one layer up, and the
   * modal could not tell a broken API from an empty library.
   */
  test("a 500 throws with the route's message — never an empty list", async () => {
    mockFetch(() => json({ error: "Could not read templates: EACCES" }, 500));
    await expect(listTemplates()).rejects.toMatchObject({
      name: "TemplatesApiError",
      status: 500,
      message: "Could not read templates: EACCES",
    });
  });

  test("a 500 with no message still throws, naming the status", async () => {
    mockFetch(() => new Response("", { status: 500 }));
    await expect(listTemplates()).rejects.toMatchObject({
      status: 500,
      message: "Request failed (HTTP 500)",
    });
  });

  test("a 500 carrying an empty error string still says something useful", async () => {
    mockFetch(() => json({ error: "" }, 500));
    await expect(listTemplates()).rejects.toMatchObject({
      status: 500,
      message: "Request failed (HTTP 500)",
    });
  });

  test("a 500 whose error is not a string falls back to the status", async () => {
    mockFetch(() => json({ error: { code: 13 } }, 500));
    await expect(listTemplates()).rejects.toMatchObject({
      message: "Request failed (HTTP 500)",
    });
  });

  test("a network failure throws at status 0", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));
    await expect(listTemplates()).rejects.toMatchObject({ status: 0, message: "Network error" });
  });

  test("a body that fails mid-stream is a failed read, not an empty library", async () => {
    mockFetch(
      () =>
        ({
          ok: true,
          status: 200,
          text: () => Promise.reject(new Error("stream broke")),
        }) as unknown as Response,
    );
    await expect(listTemplates()).rejects.toMatchObject({ status: 200 });
  });

  test("a 200 that is not an object throws", async () => {
    mockFetch(() => json(null));
    await expect(listTemplates()).rejects.toMatchObject({ message: "Invalid response" });
  });

  test("a 200 whose body has no templates array throws", async () => {
    mockFetch(() => json({ templates: "three" }));
    await expect(listTemplates()).rejects.toMatchObject({ message: "Invalid response" });
  });

  test("an unparseable body throws", async () => {
    mockFetch(() => new Response("{", { status: 200 }));
    await expect(listTemplates()).rejects.toMatchObject({ message: "Invalid response" });
  });
});

describe("asCreativeTemplate", () => {
  test.each([
    ["not an object", "x"],
    ["an array", []],
    ["null", null],
    ["a blank id", record({ id: "" })],
    ["a non-integer version", record({ version: 1.5 })],
    ["a zero version", record({ version: 0 })],
    ["a non-number version", { ...record(), version: "1" }],
    ["a missing name", { ...record(), name: 7 }],
    ["an off-vocabulary unit", { ...record(), unit: "billboard" }],
    ["a non-string unit", { ...record(), unit: 3 }],
    ["an off-vocabulary creativeType", { ...record(), creativeType: "audio" }],
    ["a non-string creativeType", { ...record(), creativeType: 3 }],
    ["a non-array layers", { ...record(), layers: {} }],
    ["an empty layers", record({ layers: [] })],
    ["a null layer entry", { ...record(), layers: [null] }],
    ["a layer that is an array", { ...record(), layers: [[]] }],
    ["a layer with no id", { ...record(), layers: [{ kind: "image" }] }],
    ["a layer with a blank id", { ...record(), layers: [{ id: "", kind: "image" }] }],
    ["a layer with no kind", { ...record(), layers: [{ id: "a" }] }],
    ["a layer with an off-vocabulary kind", { ...record(), layers: [{ id: "a", kind: "audio" }] }],
  ])("refuses %s", (_label, body) => {
    expect(() => asCreativeTemplate(body)).toThrow(TemplatesApiError);
  });

  test("the error is recognisable through the type guard", () => {
    try {
      asCreativeTemplate("x");
      expect.unreachable("asCreativeTemplate must throw");
    } catch (error) {
      expect(isTemplatesApiError(error)).toBe(true);
      expect(isTemplatesApiError(new Error("plain"))).toBe(false);
    }
  });
});

describe("getTemplate", () => {
  test("pins one record by id@version, percent-encoded as one path segment", async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return json({ template: record({ version: 3 }) });
    });
    const template = await getTemplate("canonical-image-text@3");
    expect(urls).toEqual(["/api/pipeline/campaigns/templates/canonical-image-text%403"]);
    expect(template.version).toBe(3);
  });

  test("a 404 throws rather than resolving to some other version", async () => {
    mockFetch(() => json({ error: 'Template not found: "canonical-image-text@9"' }, 404));
    await expect(getTemplate("canonical-image-text@9")).rejects.toMatchObject({ status: 404 });
  });

  test("a 200 that is not an object throws", async () => {
    mockFetch(() => json(null));
    await expect(getTemplate("x")).rejects.toMatchObject({ message: "Invalid response" });
  });

  test("a 200 with no template throws", async () => {
    mockFetch(() => json({}));
    await expect(getTemplate("x")).rejects.toMatchObject({ message: "Invalid response" });
  });
});

describe("latestPerId", () => {
  /**
   * T-D2/T3. The versions are fed in a deliberately non-monotonic order: a
   * first-wins or last-wins collapse would pick v1 or v2 and pass a test that
   * only counted cards.
   */
  test("keeps the HIGHEST version of each id, whatever order the store emits", () => {
    const collapsed = latestPerId([
      record({ version: 2 }),
      record({ version: 3 }),
      record({ version: 1 }),
      CANONICAL_TEMPLATES.video,
    ]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0].version).toBe(3);
    expect(collapsed[1].id).toBe("canonical-video");
  });

  test("an empty library collapses to nothing", () => {
    expect(latestPerId([])).toEqual([]);
  });
});

describe("versionsOf", () => {
  test("is every version of one id, newest first", () => {
    const history = versionsOf(
      [record({ version: 1 }), CANONICAL_TEMPLATES.video, record({ version: 3 })],
      "canonical-image-text",
    );
    expect(history.map((template) => template.version)).toEqual([3, 1]);
  });
});

describe("templateRef", () => {
  test("is the id@version spelling the routes take", () => {
    expect(templateRef(record({ version: 4 }))).toBe("canonical-image-text@4");
  });
});

describe("pinnableTemplate", () => {
  /**
   * The version, not only the id: D123's guarantee is that a running campaign
   * does not change when the library does, and a pin that dropped the version
   * would follow the library forward.
   */
  test("a canonical record becomes a pinned reference carrying its version", () => {
    const pinned = pinnableTemplate(record({ version: 3 }));
    expect(pinned).toEqual({
      id: "canonical-image-text",
      version: 3,
      creativeType: "image-text",
      unit: "standard-web",
      layers: CANONICAL_TEMPLATES["image-text"].layers,
    });
  });

  /**
   * The finding this lane records rather than fixes: `BriefTemplate.id` is
   * `CanonicalTemplateId`, so a library grown past the canonical three would
   * serve records no brief can carry. Refused visibly, not cast through.
   */
  test("a record outside the canonical set is not pinnable", () => {
    expect(pinnableTemplate(record({ id: "house-promo" }))).toBeNull();
  });

  test("a canonical id whose creativeType disagrees with it is not pinnable", () => {
    expect(pinnableTemplate(record({ creativeType: "video" }))).toBeNull();
  });
});

// PT-1b2 item 2: `requestJson` (the shared fetch helper behind every templates-api
// call, including `listTemplates` used here) must route a 401 to /sign-in and surface
// a 403 no_membership as the shared typed error, exactly like every other pipeline
// call site (`briefs-api.ts`, `preview-frame.ts`).
describe("templates-api 401 and 403 handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a 401 unauthenticated routes to /sign-in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { ...window, location: { ...window.location, assign } });
    mockFetch(() => json({ error: "Sign in required.", code: "unauthenticated" }, 401));
    await expect(listTemplates()).rejects.toThrow();
    expect(assign).toHaveBeenCalledWith("/sign-in");
  });

  test("a 403 no_membership surfaces the typed membership error", async () => {
    mockFetch(() =>
      json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    );
    await expect(listTemplates()).rejects.toMatchObject({
      code: "no_membership",
      status: 403,
    });
  });
});
