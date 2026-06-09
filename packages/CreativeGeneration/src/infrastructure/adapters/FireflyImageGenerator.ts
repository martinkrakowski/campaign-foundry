import { createCanvas, loadImage } from "@napi-rs/canvas";
import type {
  AspectRatio,
  BackgroundContext,
  BackgroundResult,
  ImageGeneratorPort,
  Product,
} from "@campaignfoundry/CampaignOrchestration";

/** Adobe IMS token endpoint (server-to-server client-credentials flow). */
const IMS_TOKEN_ENDPOINT = "https://ims-na1.adobelogin.com/ims/token/v3";
/** Firefly Services image generation (v3). */
const FIREFLY_GENERATE_ENDPOINT = "https://firefly-api.adobe.io/v3/images/generate";
/** Default IMS scopes for Firefly Services. */
const DEFAULT_SCOPE = "openid,AdobeID,firefly_api,ff_apis";
/** Stop reusing a cached IMS token this long before its reported expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** Conservative cache lifetime when IMS omits `expires_in`. */
const DEFAULT_TOKEN_TTL_SECONDS = 5 * 60;

interface ImsTokenResponse {
  access_token?: string;
  /** Lifetime in seconds — IMS reports ~24 h for client-credentials tokens. */
  expires_in?: number;
}
interface FireflyGenerateResponse {
  outputs?: Array<{ image?: { url?: string } }>;
}

export interface FireflyImageGeneratorOptions {
  /** Adobe IMS client id (also sent as the `x-api-key` header). */
  readonly clientId: string;
  readonly clientSecret: string;
  /** Override the IMS scope list if your credential differs. */
  readonly scope?: string;
  /** Used on any failure (auth, generation, network) so a run never aborts. */
  readonly fallback?: ImageGeneratorPort;
}

/**
 * FireflyImageGenerator — ImageGeneratorPort adapter backed by Adobe Firefly
 * Services (v3 image generation). It authenticates with Adobe IMS via the
 * client-credentials grant, generates a personalized hero background per product ×
 * aspect ratio, fetches the returned asset, and cover-fits it to the exact ratio
 * dimensions. On any failure it degrades to the injected fallback.
 *
 * This is the production seam the README describes: the domain depends only on
 * `ImageGeneratorPort`, so adopting Firefly is *this file plus one line at the
 * composition root* — the use case, compliance, export, and UI are untouched.
 */
export class FireflyImageGenerator implements ImageGeneratorPort {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scope: string;
  private readonly fallback?: ImageGeneratorPort;
  /** Bearer token reused across generations until shortly before its expiry. */
  private cachedToken?: { token: string; expiresAt: number };
  /** In-flight IMS grant shared by concurrent generations (a run resolves up to 8 cells at once). */
  private authRequest?: Promise<string>;

  constructor(options: FireflyImageGeneratorOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scope = options.scope && options.scope.length > 0 ? options.scope : DEFAULT_SCOPE;
    this.fallback = options.fallback;
  }

  async resolveBackground(
    product: Product,
    ratio: AspectRatio,
    context: BackgroundContext,
  ): Promise<BackgroundResult> {
    try {
      const token = await this.authenticate();
      const url = await this.generate(token, this.buildPrompt(product, context), ratio);
      const cover = await this.coverFit(await this.fetchImage(url), ratio);
      return { image: cover, source: "firefly" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.fallback) {
        // Observable degradation — a bad credential or a Firefly outage drops to the
        // next generator (which reports its own source), so a run never aborts.
        console.warn(`[FireflyImageGenerator] failed for ${product.id} @ ${ratio.value}; using fallback. ${message}`);
        return this.fallback.resolveBackground(product, ratio, context);
      }
      throw new Error(message);
    }
  }

  /**
   * Bearer token for Firefly calls. IMS client-credentials tokens are long-lived
   * (~24 h) and a campaign run resolves one background per product × ratio cell
   * concurrently, so the token is cached until shortly before expiry and concurrent
   * generations share a single in-flight grant instead of bursting the token endpoint.
   */
  private async authenticate(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) return this.cachedToken.token;
    // A settled grant always clears itself, so a failed one is retried on the next
    // generation (each failure already degrades per cell) instead of rejecting forever.
    this.authRequest ??= this.requestToken().finally(() => {
      this.authRequest = undefined;
    });
    return this.authRequest;
  }

  /** Client-credentials grant against Adobe IMS; caches and returns the bearer token. */
  private async requestToken(): Promise<string> {
    const response = await fetch(IMS_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: this.scope,
      }),
    });
    if (!response.ok) throw new Error(`Adobe IMS auth failed (HTTP ${response.status})`);
    const body = (await response.json()) as ImsTokenResponse;
    if (!body.access_token) throw new Error("Adobe IMS returned no access token");
    const ttlMs = (body.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000;
    this.cachedToken = { token: body.access_token, expiresAt: Date.now() + ttlMs - TOKEN_EXPIRY_MARGIN_MS };
    return body.access_token;
  }

  /** One Firefly generate call; returns the output image URL. */
  private async generate(token: string, prompt: string, ratio: AspectRatio): Promise<string> {
    const response = await fetch(FIREFLY_GENERATE_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-key": this.clientId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        numVariations: 1,
        size: { width: ratio.width, height: ratio.height },
      }),
    });
    if (!response.ok) {
      throw new Error(`Firefly HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const url = ((await response.json()) as FireflyGenerateResponse).outputs?.[0]?.image?.url;
    if (!url) throw new Error("Firefly returned no image URL");
    return url;
  }

  /** Firefly returns a presigned URL; fetch the actual bytes. */
  private async fetchImage(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Firefly image fetch failed (HTTP ${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
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

  /** Same intent as the Imagen/OpenRouter prompts: on-brand, photographic, text-free. */
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
