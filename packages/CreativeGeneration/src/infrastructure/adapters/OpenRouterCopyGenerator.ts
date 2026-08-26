import type { CopyGeneratorInput, CopyGeneratorPort } from "@campaignfoundry/CampaignOrchestration";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

/** Minimal shape of the OpenAI-compatible chat-completion response we read. */
interface OpenRouterChatResponse {
  choices?: Array<{
    message?: { content?: unknown };
  }>;
}

export interface OpenRouterCopyGeneratorOptions {
  readonly apiKey: string;
  /** OpenRouter model id (default `openai/gpt-4o-mini`). */
  readonly model?: string;
  /** Injectable fetch seam (defaults to `globalThis.fetch`). */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * OpenRouterCopyGenerator — CopyGeneratorPort adapter backed by OpenRouter chat
 * completions. Used to build headline pools up front; never called per creative.
 */
export class OpenRouterCopyGenerator implements CopyGeneratorPort {
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: OpenRouterCopyGeneratorOptions) {
    if (!options.apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }
    this.apiKey = options.apiKey;
    this.model = options.model && options.model.length > 0 ? options.model : DEFAULT_MODEL;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async suggestHeadlines(input: CopyGeneratorInput): Promise<readonly string[]> {
    const response = await this.fetchFn(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: "json_object" },
        messages: this.buildMessages(input),
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error("OpenRouter copy response was not valid JSON");
    }
    return this.parseHeadlines(data);
  }

  private buildMessages(input: CopyGeneratorInput): Array<{ role: string; content: string }> {
    const { brief, count, locale } = input;
    const products = brief.products.map((product) => product.name).join(", ");
    const system = [
      `Generate ${count} distinct advertising headlines, each at most 60 characters,`,
      `for the given product, audience, and region.`,
      `Respond with a JSON object of the form {"headlines": string[]}.`,
    ].join(" ");
    const lines = [
      `Product(s): ${products}.`,
      `Audience: ${brief.targetAudience}.`,
      `Market/region: ${brief.targetRegion}.`,
      `Campaign message: ${brief.localizedMessage ?? brief.campaignMessage}.`,
    ];
    if (locale) lines.push(`Locale: ${locale}.`);
    return [
      { role: "system", content: system },
      { role: "user", content: lines.join(" ") },
    ];
  }

  private parseHeadlines(data: unknown): readonly string[] {
    if (typeof data !== "object" || data === null) {
      throw new Error("OpenRouter copy response was not a JSON object");
    }
    const content = (data as OpenRouterChatResponse).choices?.[0]?.message?.content;
    const parsed = this.parseContent(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("OpenRouter copy response was not a JSON object");
    }
    const headlines = (parsed as { headlines?: unknown }).headlines;
    if (!Array.isArray(headlines)) {
      throw new Error("OpenRouter copy response was missing a headlines array");
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of headlines) {
      if (typeof item !== "string") continue;
      const text = item.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    return out;
  }

  private parseContent(content: unknown): unknown {
    if (typeof content === "string") {
      try {
        return JSON.parse(content);
      } catch {
        throw new Error("OpenRouter copy response was not valid JSON");
      }
    }
    if (typeof content === "object" && content !== null) {
      return content;
    }
    throw new Error("OpenRouter copy response was not valid JSON");
  }
}
