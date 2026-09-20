import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { AspectRatio, type ImageGeneratorPort } from "@campaignfoundry/CampaignOrchestration";
import { FireflyImageGenerator } from "../FireflyImageGenerator.js";

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};
const ctx = { campaignMessage: "m", targetAudience: "Urban", targetRegion: "DE" };
const product = { id: "hydra", name: "Hydra Bottle", primaryColor: "#1473E6", logoPath: "x.png" };
const fallback = (): ImageGeneratorPort => ({
  resolveBackground: vi.fn(async () => ({
    image: new Uint8Array([7]),
    source: "procedural" as const,
  })),
});

/** A real 4×4 PNG (standalone buffer) so the cover-fit step's loadImage works. */
const pngBytes = (): Uint8Array => {
  const c = createCanvas(4, 4);
  c.getContext("2d").fillRect(0, 0, 4, 4);
  return Uint8Array.from(c.toBuffer("image/png"));
};

/** Minimal fetch Response stand-in. */
const res = (opts: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
}): Response =>
  ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? "",
    arrayBuffer: async () => (opts.bytes ?? new Uint8Array()).buffer,
  }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Route the three calls: IMS auth → Firefly generate → presigned image fetch. */
const wire = (opts: { ims?: Response; generate?: Response; image?: Response } = {}) =>
  fetchMock.mockImplementation((url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("adobelogin"))
      return Promise.resolve(opts.ims ?? res({ json: { access_token: "tok" } }));
    if (u.includes("firefly-api"))
      return Promise.resolve(
        opts.generate ?? res({ json: { outputs: [{ image: { url: "https://img/x.png" } }] } }),
      );
    return Promise.resolve(opts.image ?? res({ bytes: pngBytes() }));
  });

const creds = { clientId: "cid", clientSecret: "secret" };

/** IMS grants made so far — the caching tests assert how many actually ran. */
const imsCalls = () =>
  fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]).includes("adobelogin")).length;

describe("FireflyImageGenerator", () => {
  test("authenticates, generates, and returns a firefly-sourced image", async () => {
    wire();
    const out = await new FireflyImageGenerator(creds).resolveBackground(
      product,
      ratio("16:9"),
      ctx,
    );

    expect(out.source).toBe("firefly");
    expect(Array.from(out.image.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic

    // IMS call: client-credentials grant with the default scope.
    const imsBody = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(imsBody.get("grant_type")).toBe("client_credentials");
    expect(imsBody.get("scope")).toMatch(/firefly_api/);

    // Firefly generate call: x-api-key + size from the ratio + a personalized prompt.
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("cid");
    const body = JSON.parse(init.body as string);
    expect(body.size).toEqual({ width: 1920, height: 1080 });
    expect(body.prompt).toContain("Hydra Bottle");
    expect(body.prompt).toContain("DE");
  });

  test("uses a custom IMS scope when provided", async () => {
    wire();
    await new FireflyImageGenerator({ ...creds, scope: "custom_scope" }).resolveBackground(
      product,
      ratio(),
      ctx,
    );
    expect((fetchMock.mock.calls[0][1]?.body as URLSearchParams).get("scope")).toBe("custom_scope");
  });

  test("falls back when IMS auth fails", async () => {
    wire({ ims: res({ ok: false, status: 401 }) });
    const fb = fallback();
    const out = await new FireflyImageGenerator({ ...creds, fallback: fb }).resolveBackground(
      product,
      ratio(),
      ctx,
    );
    expect(out.source).toBe("procedural");
    expect(fb.resolveBackground).toHaveBeenCalledOnce();
  });

  test("falls back when IMS returns no access token", async () => {
    wire({ ims: res({ json: {} }) });
    const out = await new FireflyImageGenerator({
      ...creds,
      fallback: fallback(),
    }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("procedural");
  });

  test("falls back on a non-OK Firefly generate response", async () => {
    wire({ generate: res({ ok: false, status: 500, text: "boom" }) });
    const out = await new FireflyImageGenerator({
      ...creds,
      fallback: fallback(),
    }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("procedural");
  });

  test("falls back when Firefly returns no image URL", async () => {
    wire({ generate: res({ json: { outputs: [{}] } }) });
    const out = await new FireflyImageGenerator({
      ...creds,
      fallback: fallback(),
    }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("procedural");
  });

  test("falls back when the presigned image fetch fails", async () => {
    wire({ image: res({ ok: false, status: 403 }) });
    const out = await new FireflyImageGenerator({
      ...creds,
      fallback: fallback(),
    }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("procedural");
  });

  test("rethrows when there is no fallback", async () => {
    wire({ ims: res({ ok: false, status: 500 }) });
    await expect(
      new FireflyImageGenerator(creds).resolveBackground(product, ratio(), ctx),
    ).rejects.toThrow(/IMS auth failed/);
  });

  test("falls back when fetch rejects with a non-Error reason", async () => {
    fetchMock.mockRejectedValueOnce("network kaput");
    const out = await new FireflyImageGenerator({
      ...creds,
      fallback: fallback(),
    }).resolveBackground(product, ratio(), ctx);
    expect(out.source).toBe("procedural");
  });

  test("caches the IMS token across sequential generations", async () => {
    wire();
    const generator = new FireflyImageGenerator(creds);
    await generator.resolveBackground(product, ratio(), ctx);
    await generator.resolveBackground(product, ratio("16:9"), ctx);
    expect(imsCalls()).toBe(1);
  });

  test("concurrent generations share one in-flight IMS grant", async () => {
    wire();
    const generator = new FireflyImageGenerator(creds);
    await Promise.all([
      generator.resolveBackground(product, ratio(), ctx),
      generator.resolveBackground(product, ratio("16:9"), ctx),
    ]);
    expect(imsCalls()).toBe(1);
  });

  test("re-authenticates when the remaining token lifetime is inside the refresh margin", async () => {
    wire({ ims: res({ json: { access_token: "tok", expires_in: 30 } }) }); // 30 s < the 60 s margin
    const generator = new FireflyImageGenerator(creds);
    await generator.resolveBackground(product, ratio(), ctx);
    await generator.resolveBackground(product, ratio(), ctx);
    expect(imsCalls()).toBe(2);
  });

  test("does not cache a failed grant — the next generation retries IMS", async () => {
    wire({ ims: res({ ok: false, status: 503 }) });
    const generator = new FireflyImageGenerator({ ...creds, fallback: fallback() });
    expect((await generator.resolveBackground(product, ratio(), ctx)).source).toBe("procedural");
    wire(); // IMS recovers
    expect((await generator.resolveBackground(product, ratio(), ctx)).source).toBe("firefly");
    expect(imsCalls()).toBe(2);
  });

  test("pins the prompt shape, including the campaign-type sentence", async () => {
    wire();
    const promptOf = (): string => {
      const generateCall = fetchMock.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes("firefly-api"),
      );
      return JSON.parse((generateCall![1] as RequestInit).body as string).prompt as string;
    };

    await new FireflyImageGenerator(creds).resolveBackground(product, ratio(), ctx);
    expect(promptOf()).toBe(
      'Premium social-advertising hero background for the subject "Hydra Bottle". Audience: Urban. Market/region: DE. Evoke the brand accent colour #1473E6. Cinematic, photographic, high production value, with clean negative space toward the bottom for a headline. Absolutely no text, words, letters, logos or watermarks in the image. Campaign type: a social post for organic feeds.',
    );

    fetchMock.mockClear();
    wire();
    await new FireflyImageGenerator(creds).resolveBackground(product, ratio(), {
      ...ctx,
      campaignType: "paid-social",
    });
    expect(promptOf()).toBe(
      'Premium social-advertising hero background for the subject "Hydra Bottle". Audience: Urban. Market/region: DE. Evoke the brand accent colour #1473E6. Cinematic, photographic, high production value, with clean negative space toward the bottom for a headline. Absolutely no text, words, letters, logos or watermarks in the image. Campaign type: paid social advertising across feeds, stories and reels.',
    );
  });
});

describe("FireflyImageGenerator — the run deadline (R5, D77)", () => {
  /** The signal each call was actually made with, by endpoint. */
  const signalsByHost = () => {
    const out: Record<string, AbortSignal | undefined> = {};
    for (const call of fetchMock.mock.calls as unknown[][]) {
      const url = String(call[0]);
      const init = call[1] as RequestInit | undefined;
      const host = url.includes("adobelogin") ? "ims" : url.includes("firefly-api") ? "gen" : "img";
      out[host] = init?.signal ?? undefined;
    }
    return out;
  };

  test("every call carries a signal — the adapter had none at all before", async () => {
    wire();
    await new FireflyImageGenerator(creds).resolveBackground(product, ratio("1:1"), ctx);
    const s = signalsByHost();
    expect(s.ims).toBeInstanceOf(AbortSignal);
    expect(s.gen).toBeInstanceOf(AbortSignal);
    expect(s.img).toBeInstanceOf(AbortSignal);
  });

  test("an already-aborted run stops the generate call, and never reaches the image fetch", async () => {
    // The mock must honour the signal, because that is what real `fetch` does:
    // otherwise this would assert the mock's indifference, not the adapter's
    // wiring. A generator with a fallback degrades rather than throwing, so the
    // observable fact is which calls were MADE.
    fetchMock.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) return Promise.reject(new Error("aborted"));
      const u = String(url);
      if (u.includes("adobelogin")) return Promise.resolve(res({ json: { access_token: "tok" } }));
      if (u.includes("firefly-api"))
        return Promise.resolve(
          res({ json: { outputs: [{ image: { url: "https://img/x.png" } }] } }),
        );
      return Promise.resolve(res({ bytes: pngBytes() }));
    });
    const run = AbortSignal.abort(new Error("run abandoned"));
    const out = await new FireflyImageGenerator({
      ...creds,
      fallback: fallback(),
    }).resolveBackground(product, ratio("1:1"), ctx, run);
    // It degraded to the fallback rather than producing a Firefly image...
    expect(out.source).toBe("procedural");
    // ...and the presigned image fetch was never reached.
    const hosts = (fetchMock.mock.calls as unknown[][]).map((c) => String(c[0]));
    expect(hosts.some((u) => u.includes("https://img/"))).toBe(false);
  });

  test("the SHARED token grant is never bound to one run's signal", async () => {
    // `authenticate` memoises its promise across runs. Binding run A's signal to
    // it would cancel the token run B is waiting on — so the IMS call takes the
    // ceiling only, and must NOT abort when this run does.
    wire();
    const run = new AbortController();
    await new FireflyImageGenerator(creds).resolveBackground(
      product,
      ratio("1:1"),
      ctx,
      run.signal,
    );
    const s = signalsByHost();
    run.abort(new Error("this run is done"));
    expect(s.ims!.aborted).toBe(false);
    // The run-scoped calls do follow it.
    expect(s.gen!.aborted).toBe(true);
  });
});
