import { describe, test, expect, vi, afterEach } from "vitest";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { OpenRouterCopyGenerator } from "../OpenRouterCopyGenerator.js";

const brief: CampaignBrief = {
  id: "camp",
  targetRegion: "DE",
  targetAudience: "Urban outdoor enthusiasts",
  campaignMessage: "Stay wild. Stay hydrated.",
  products: [{ id: "hydra", name: "Hydra Bottle", primaryColor: "#1473E6", logoPath: "x.png" }],
};

const input = { brief, count: 3 };

/** Minimal fetch Response stand-in. */
const res = (opts: { ok?: boolean; status?: number; json?: unknown; text?: string }): Response =>
  ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? "",
  }) as unknown as Response;

const messageWith = (content: unknown) => ({ choices: [{ message: { content } }] });

const headlinesJson = (headlines: unknown) => JSON.stringify({ headlines });

type FetchFn = ReturnType<typeof vi.fn<typeof fetch>>;

function requestOf(fetchFn: FetchFn): { url: string; body: Record<string, unknown>; init: RequestInit } {
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

describe("OpenRouterCopyGenerator", () => {
  afterEach(() => vi.restoreAllMocks());

  test("returns trimmed, de-duplicated headlines and maps brief fields into the prompt", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      res({
        json: messageWith(headlinesJson(["  Stay wild  ", "", "Stay wild", "Stay hydrated", 12])),
      }),
    );
    const out = await new OpenRouterCopyGenerator({ apiKey: "k", fetch: fetchFn }).suggestHeadlines(input);

    expect(out).toEqual(["Stay wild", "Stay hydrated"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const { url, init, body } = requestOf(fetchFn);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain("3 distinct");
    expect(messages[0].content).toContain("60 characters");
    expect(messages[0].content).toContain('{"headlines": string[]}');
    expect(messages[1].content).toContain("Hydra Bottle");
    expect(messages[1].content).toContain("Urban outdoor enthusiasts");
    expect(messages[1].content).toContain("DE");
    expect(messages[1].content).toContain("Stay wild. Stay hydrated.");
    expect(messages[1].content).not.toContain("Locale:");
  });

  test("honours a custom model id and includes locale when provided", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => res({ json: messageWith({ headlines: ["Hallo"] }) }));
    await new OpenRouterCopyGenerator({ apiKey: "k", model: "openai/custom", fetch: fetchFn }).suggestHeadlines({
      ...input,
      locale: "de-DE",
    });
    const { body } = requestOf(fetchFn);
    expect(body.model).toBe("openai/custom");
    expect((body.messages as Array<{ content: string }>)[1].content).toContain("Locale: de-DE");
  });

  test("reads headlines from already-parsed JSON object content", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => res({ json: messageWith({ headlines: ["One"] }) }));
    const out = await new OpenRouterCopyGenerator({ apiKey: "k", fetch: fetchFn }).suggestHeadlines(input);
    expect(out).toEqual(["One"]);
  });

  test("prefers localizedMessage over campaignMessage in the prompt", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => res({ json: messageWith({ headlines: ["x"] }) }));
    await new OpenRouterCopyGenerator({ apiKey: "k", fetch: fetchFn }).suggestHeadlines({
      brief: { ...brief, localizedMessage: "Bleib wild." },
      count: 1,
    });
    const { body } = requestOf(fetchFn);
    expect((body.messages as Array<{ content: string }>)[1].content).toContain("Bleib wild.");
    expect((body.messages as Array<{ content: string }>)[1].content).not.toContain("Stay wild. Stay hydrated.");
  });

  test("falls back to globalThis.fetch when no fetch is injected", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res({ json: messageWith({ headlines: ["Hi"] }) }));
    const out = await new OpenRouterCopyGenerator({ apiKey: "k" }).suggestHeadlines(input);
    expect(out).toEqual(["Hi"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("defaults an empty model id to gpt-4o-mini", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => res({ json: messageWith({ headlines: ["Hi"] }) }));
    await new OpenRouterCopyGenerator({ apiKey: "k", model: "", fetch: fetchFn }).suggestHeadlines(input);
    expect(requestOf(fetchFn).body.model).toBe("openai/gpt-4o-mini");
  });

  test("throws when the API key is missing", () => {
    expect(() => new OpenRouterCopyGenerator({ apiKey: "" })).toThrow(/OPENROUTER_API_KEY/);
  });

  test("rejects HTTP 429 with a useful message and no secret", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => res({ ok: false, status: 429, text: "rate limited" }));
    await expect(
      new OpenRouterCopyGenerator({ apiKey: "super-secret", fetch: fetchFn }).suggestHeadlines(input),
    ).rejects.toThrow("OpenRouter HTTP 429: rate limited");
  });

  test("rejects a non-JSON HTTP body", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("bad json");
          },
          text: async () => "",
        }) as unknown as Response,
    );
    await expect(new OpenRouterCopyGenerator({ apiKey: "k", fetch: fetchFn }).suggestHeadlines(input)).rejects.toThrow(
      "OpenRouter copy response was not valid JSON",
    );
  });

  test("rejects malformed JSON in the message content", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => res({ json: messageWith("not-json") }));
    await expect(new OpenRouterCopyGenerator({ apiKey: "k", fetch: fetchFn }).suggestHeadlines(input)).rejects.toThrow(
      "OpenRouter copy response was not valid JSON",
    );
  });

  test("rejects a missing choices/content payload", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => res({ json: {} }));
    await expect(new OpenRouterCopyGenerator({ apiKey: "k", fetch: fetchFn }).suggestHeadlines(input)).rejects.toThrow(
      "OpenRouter copy response was not valid JSON",
    );
  });

  test("rejects a non-object HTTP JSON payload", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => res({ json: 12 }));
    await expect(new OpenRouterCopyGenerator({ apiKey: "k", fetch: fetchFn }).suggestHeadlines(input)).rejects.toThrow(
      "OpenRouter copy response was not a JSON object",
    );
  });

  test("rejects a JSON array in the message content", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => res({ json: messageWith("[]") }));
    await expect(new OpenRouterCopyGenerator({ apiKey: "k", fetch: fetchFn }).suggestHeadlines(input)).rejects.toThrow(
      "OpenRouter copy response was not a JSON object",
    );
  });

  test("rejects a missing headlines array", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => res({ json: messageWith("{}") }));
    await expect(new OpenRouterCopyGenerator({ apiKey: "k", fetch: fetchFn }).suggestHeadlines(input)).rejects.toThrow(
      "OpenRouter copy response was missing a headlines array",
    );
  });
});
