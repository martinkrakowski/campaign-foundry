import type {
  AspectRatio,
  BackgroundContext,
  BackgroundResult,
  BackgroundSource,
  CopyGeneratorInput,
  CopyGeneratorPort,
  ImageGeneratorPort,
  Product,
} from "@campaignfoundry/CampaignOrchestration";
import type { UsageStorePort } from "./ports/usage-store.port.js";

/** Whose key paid for a generation. Always the platform's until PT-7b (BYOK). */
const KEY_OWNER = "platform";

/**
 * Meters one image provider (PT-7a, D175, H2). `pipeline.ts`'s `imageGenerator()`
 * wraps the raw adapter it constructs — `GeminiImageGenerator`, `OpenRouterImageGenerator`,
 * `FireflyImageGenerator` — directly, never the procedural generator (no
 * provider call, no cost) and never `AssetReusingImageGenerator`'s reuse
 * branch (no generation happened). Each of those adapters can also be the
 * `fallback` another one calls internally on failure, so wrapping the raw
 * adapter — not the chain's entry point — records a row for whichever layer
 * actually resolved the background, wherever it sits in the chain.
 *
 * `BackgroundResult` carries `source` but not the model id, and the adapters
 * don't expose one publicly, so `provider` and `model` are supplied by the
 * caller: the same values `pipeline.ts` configured the wrapped adapter with.
 *
 * A raw adapter's own `fallback` option is itself a (metered) `ImageGeneratorPort`
 * — when Firefly fails, its `catch` returns `this.fallback.resolveBackground(...)`
 * unchanged, straight through Firefly's `resolveBackground`. Without a check, the
 * outer, Firefly-metered wrapper would then see a non-cached result and record a
 * firefly row too, on top of the imagen (or further) row the fallback layer
 * already recorded for itself: one generation, two billed rows. `source` is
 * exactly the provenance field for this — it names which layer actually produced
 * the bytes — so only the layer whose own `provider` matches `source` records.
 */
export class MeteredImageGenerator implements ImageGeneratorPort {
  constructor(
    private readonly inner: ImageGeneratorPort,
    private readonly usage: UsageStorePort,
    private readonly orgId: string,
    private readonly provider: BackgroundSource,
    private readonly model: string,
  ) {}

  async resolveBackground(
    product: Product,
    ratio: AspectRatio,
    context: BackgroundContext,
    signal?: AbortSignal,
  ): Promise<BackgroundResult> {
    const result = await this.inner.resolveBackground(product, ratio, context, signal);
    // A cached result served no live call, so it billed nothing (D175: "every
    // generation" — a seed-cache hit is not one). And this layer only records
    // when it was the one that actually produced the result — never when a
    // wrapped adapter's internal fallback did the work and its result merely
    // passed back up through this layer unchanged (see the class doc).
    if (!result.cached && result.source === this.provider) {
      await this.usage.record({
        orgId: this.orgId,
        provider: this.provider,
        model: this.model,
        units: 1,
        keyOwner: KEY_OWNER,
      });
    }
    return result;
  }
}

/**
 * Meters copy-pool generation (PT-7a, D175). `pipeline.ts`'s `copyGenerator()`
 * wraps the `OpenRouterCopyGenerator` it constructs; `routes/campaigns/pools/copy.post.ts`
 * only calls the port it gets back and is otherwise untouched. Copy has no
 * cache — every call is a live request — so one row is written per call,
 * `units` the number of headlines the model returned. `model` reads
 * `CopyGeneratorPort.model`, the field the port already publishes, rather
 * than a value duplicated here.
 */
export class MeteredCopyGenerator implements CopyGeneratorPort {
  constructor(
    private readonly inner: CopyGeneratorPort,
    private readonly usage: UsageStorePort,
    private readonly orgId: string,
    private readonly provider: string,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  async suggestHeadlines(input: CopyGeneratorInput): Promise<readonly string[]> {
    const headlines = await this.inner.suggestHeadlines(input);
    await this.usage.record({
      orgId: this.orgId,
      provider: this.provider,
      model: this.inner.model,
      units: headlines.length,
      keyOwner: KEY_OWNER,
    });
    return headlines;
  }
}
