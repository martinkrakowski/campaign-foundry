import { GoogleGenAI } from "@google/genai";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  campaignTypePromptSentence,
  type AspectRatio,
  type BackgroundCachePort,
  type BackgroundContext,
  type BackgroundResult,
  type ImageGeneratorPort,
  type Product,
} from "@campaignfoundry/CampaignOrchestration";
import { resolveCachedBackground } from "./FileSystemBackgroundCache.js";
import { requestSignal } from "./request-deadline.js";

/** Default Imagen model (override with the IMAGEN_MODEL env var). */
const DEFAULT_MODEL = "imagen-4.0-generate-001";

/** The slice of the `@google/genai` client this adapter actually uses. */
export interface ImagenClient {
  models: {
    generateImages(args: {
      model: string;
      prompt: string;
      config: {
        numberOfImages: number;
        aspectRatio: string;
        /** R5 — the run deadline. Part of the SEAM, or a test double could not
            observe that the adapter passes one. */
        abortSignal?: AbortSignal;
      };
    }): Promise<{ generatedImages?: Array<{ image?: { imageBytes?: string } }> }>;
  };
}

export interface GeminiImageGeneratorOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** Used on any API failure (no access, rate limit, network) so a run never aborts. */
  readonly fallback?: ImageGeneratorPort;
  /** Injectable client seam (defaults to a real GoogleGenAI) — lets tests stub the SDK. */
  readonly client?: ImagenClient;
  /** Optional seed cache; used only when `context.seed` is present. */
  readonly cache?: BackgroundCachePort;
}

/**
 * GeminiImageGenerator — ImageGeneratorPort adapter backed by Google Imagen
 * (via @google/genai). Generates a personalized hero background per product ×
 * aspect ratio from the campaign context, then degrades gracefully to the
 * procedural fallback if the call fails. The exact GenAI seam the README describes.
 */
export class GeminiImageGenerator implements ImageGeneratorPort {
  private readonly ai: ImagenClient;
  private readonly model: string;
  private readonly fallback?: ImageGeneratorPort;
  private readonly cache?: BackgroundCachePort;

  constructor(options: GeminiImageGeneratorOptions) {
    this.ai = options.client ?? new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model && options.model.length > 0 ? options.model : DEFAULT_MODEL;
    this.fallback = options.fallback;
    this.cache = options.cache;
  }

  async resolveBackground(
    product: Product,
    ratio: AspectRatio,
    context: BackgroundContext,
    signal?: AbortSignal,
  ): Promise<BackgroundResult> {
    try {
      const prompt = this.buildPrompt(product, context);
      return await resolveCachedBackground(
        this.cache,
        context.seed,
        { provider: "imagen", model: this.model, prompt, ratio: ratio.value },
        async () => {
          const response = await this.ai.models.generateImages({
            model: this.model,
            prompt,
            config: {
              numberOfImages: 1,
              // Imagen has no 4:5; its nearest is 3:4, cover-fitted to the exact
              // 4:5 canvas below so the pixels are never distorted.
              aspectRatio: ratio.value === "4:5" ? "3:4" : ratio.value,
              // The SDK is explicit that this is client-only: aborting stops us
              // WAITING, it does not stop the service, and the usage is still
              // billed. That is the right trade here anyway — the point is to
              // free the slot a hung call is holding, not to save the spend on
              // a call already made.
              abortSignal: requestSignal(signal),
            },
          });
          const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
          if (!imageBytes) throw new Error("Imagen returned no image data");
          if (ratio.value === "4:5") {
            return this.coverFit(Buffer.from(imageBytes, "base64"), ratio);
          }
          return Buffer.from(imageBytes, "base64");
        },
        "imagen",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.fallback) {
        // Observable degradation — don't let a bad key/model silently look "fine".
        // The fallback reports its own source (openrouter / procedural), which
        // propagates up so the run log shows what actually produced the background.
        console.warn(
          `[GeminiImageGenerator] Imagen failed for ${product.id} @ ${ratio.value}; using fallback generator. ${message}`,
        );
        return this.fallback.resolveBackground(product, ratio, context, signal);
      }
      throw new Error(message);
    }
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

  /** Build a text-to-image prompt personalized to the product and campaign. */
  private buildPrompt(product: Product, context: BackgroundContext): string {
    return [
      `Premium social-advertising hero background for the subject "${product.name}".`,
      `Audience: ${context.targetAudience}. Market/region: ${context.targetRegion}.`,
      `Evoke the brand accent colour ${product.primaryColor}.`,
      `Cinematic, photographic, high production value, with clean negative space toward the bottom for a headline.`,
      `Absolutely no text, words, letters, logos or watermarks in the image.`,
      campaignTypePromptSentence(context.campaignType),
    ].join(" ");
  }
}
