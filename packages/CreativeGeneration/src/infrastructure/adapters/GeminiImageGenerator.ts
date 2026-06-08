import { GoogleGenAI } from "@google/genai";
import type {
  AspectRatio,
  BackgroundContext,
  BackgroundResult,
  ImageGeneratorPort,
  Product,
} from "@campaignfoundry/CampaignOrchestration";

/** Default Imagen model (override with the IMAGEN_MODEL env var). */
const DEFAULT_MODEL = "imagen-4.0-generate-001";

/** The slice of the `@google/genai` client this adapter actually uses. */
export interface ImagenClient {
  models: {
    generateImages(args: {
      model: string;
      prompt: string;
      config: { numberOfImages: number; aspectRatio: string };
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

  constructor(options: GeminiImageGeneratorOptions) {
    this.ai = options.client ?? new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model && options.model.length > 0 ? options.model : DEFAULT_MODEL;
    this.fallback = options.fallback;
  }

  async resolveBackground(
    product: Product,
    ratio: AspectRatio,
    context: BackgroundContext,
  ): Promise<BackgroundResult> {
    try {
      const response = await this.ai.models.generateImages({
        model: this.model,
        prompt: this.buildPrompt(product, context),
        config: { numberOfImages: 1, aspectRatio: ratio.value },
      });
      const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
      if (!imageBytes) throw new Error("Imagen returned no image data");
      return { image: Buffer.from(imageBytes, "base64"), source: "imagen" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.fallback) {
        // Observable degradation — don't let a bad key/model silently look "fine".
        // The fallback reports its own source (openrouter / procedural), which
        // propagates up so the run log shows what actually produced the background.
        console.warn(`[GeminiImageGenerator] Imagen failed for ${product.id} @ ${ratio.value}; using fallback generator. ${message}`);
        return this.fallback.resolveBackground(product, ratio, context);
      }
      throw new Error(message);
    }
  }

  /** Build a text-to-image prompt personalized to the product and campaign. */
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
