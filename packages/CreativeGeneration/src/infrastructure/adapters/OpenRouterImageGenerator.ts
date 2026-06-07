import { createCanvas, loadImage } from "@napi-rs/canvas";
import type {
  AspectRatio,
  BackgroundContext,
  BackgroundResult,
  ImageGeneratorPort,
  Product,
} from "@campaignfoundry/CampaignOrchestration";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** A different provider from Imagen by default, so it's a real second source. */
const DEFAULT_MODEL = "x-ai/grok-imagine-image-quality";

/**
 * Our ratios → OpenRouter's `image_config.aspect_ratio`. OpenRouter's shared set
 * is 1:1 / 2:3 / 3:2, so 9:16 and 16:9 request the nearest and are cover-fitted to
 * exact dimensions below — correct regardless of a model's native ratio support.
 */
const ASPECT_RATIO: Record<string, string> = {
  "1:1": "1:1",
  "9:16": "2:3",
  "16:9": "3:2",
};

/** Minimal shape of the OpenAI-compatible chat-completion response we read. */
interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      images?: Array<{ image_url?: { url?: string }; url?: string }>;
      content?: Array<{ image_url?: { url?: string } }> | string;
    };
  }>;
}

export interface OpenRouterImageGeneratorOptions {
  readonly apiKey: string;
  /** OpenRouter model id (default `x-ai/grok-imagine-image-quality`). */
  readonly model?: string;
  /** Used on any failure so a run never aborts. */
  readonly fallback?: ImageGeneratorPort;
}

/**
 * OpenRouterImageGenerator — ImageGeneratorPort adapter backed by OpenRouter's
 * OpenAI-compatible image generation (Grok Imagine, Nano Banana, GPT Image, …).
 * Used as the second GenAI source: when Imagen is rate-limited/unavailable, the
 * Gemini adapter falls back here before the procedural gradient.
 */
export class OpenRouterImageGenerator implements ImageGeneratorPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fallback?: ImageGeneratorPort;

  constructor(options: OpenRouterImageGeneratorOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model && options.model.length > 0 ? options.model : DEFAULT_MODEL;
    this.fallback = options.fallback;
  }

  async resolveBackground(
    product: Product,
    ratio: AspectRatio,
    context: BackgroundContext,
  ): Promise<BackgroundResult> {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          modalities: ["image", "text"],
          image_config: { aspect_ratio: ASPECT_RATIO[ratio.value] ?? "1:1" },
          messages: [{ role: "user", content: this.buildPrompt(product, context) }],
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenRouter HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const dataUrl = this.extractImageUrl((await response.json()) as OpenRouterResponse);
      if (!dataUrl) throw new Error("OpenRouter returned no image data");
      const cover = await this.coverFit(this.decodeDataUrl(dataUrl), ratio);
      return { image: cover, source: "openrouter" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.fallback) {
        console.warn(`[OpenRouterImageGenerator] failed for ${product.id} @ ${ratio.value}; using fallback. ${message}`);
        return this.fallback.resolveBackground(product, ratio, context);
      }
      throw new Error(message);
    }
  }

  /** Generated images come back as base64 data URLs in the assistant message. */
  private extractImageUrl(data: OpenRouterResponse): string | undefined {
    const message = data.choices?.[0]?.message;
    const fromImages = message?.images?.[0]?.image_url?.url ?? message?.images?.[0]?.url;
    if (typeof fromImages === "string") return fromImages;
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (typeof part.image_url?.url === "string") return part.image_url.url;
      }
    }
    return undefined;
  }

  private decodeDataUrl(url: string): Uint8Array {
    const comma = url.indexOf(",");
    return Buffer.from(comma >= 0 ? url.slice(comma + 1) : url, "base64");
  }

  /** Cover-fit the generated image to the exact ratio dimensions (no distortion). */
  private async coverFit(bytes: Uint8Array, ratio: AspectRatio): Promise<Uint8Array> {
    const image = await loadImage(Buffer.from(bytes));
    const canvas = createCanvas(ratio.width, ratio.height);
    const ctx = canvas.getContext("2d");
    const scale = Math.max(ratio.width / image.width, ratio.height / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (ratio.width - w) / 2, (ratio.height - h) / 2, w, h);
    return canvas.toBuffer("image/png");
  }

  /** Same intent as the Imagen prompt: on-brand, photographic, text-free. */
  private buildPrompt(product: Product, context: BackgroundContext): string {
    return [
      `Premium social-advertising hero background for the product "${product.name}".`,
      `Audience: ${context.targetAudience}. Market/region: ${context.targetRegion}.`,
      `Evoke the brand accent colour ${product.primaryColor}.`,
      `Cinematic, photographic, high production value, with clean negative space toward the bottom for a headline.`,
      `Absolutely no text, words, letters, logos or watermarks in the image.`,
    ].join(" ");
  }
}
