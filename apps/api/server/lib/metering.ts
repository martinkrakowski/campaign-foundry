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
import { errorMessage } from "@campaignfoundry/shared";
import type { UsageStorePort } from "./ports/usage-store.port.js";

/** Whose key paid for a generation. Always the platform's until PT-7b (BYOK). */
const KEY_OWNER = "platform";

/**
 * Thrown by a metered wrapper instead of calling the provider (PT-7a, D175, fix
 * round): `generate.post.ts`'s admission check is an early, best-effort refusal
 * before the job is even claimed, but it reads the count once, before the run
 * starts. A multi-cell run or a copy-pool request makes several provider calls
 * after that single read, so admission alone does not stop a run from crossing
 * the quota mid-flight — and a route that builds `copyGenerator()`/`imageGenerator()`
 * directly (the CLI, `bin/generate.ts`) never goes through the route's admission
 * check at all. This is the actual enforcement point: every wrapped call re-checks
 * before it would spend one, so a run that starts under quota stops making
 * provider calls the moment it is no longer under it.
 */
export class QuotaExceededError extends Error {
  constructor(readonly orgId: string) {
    super(`Org "${orgId}" has reached its monthly generation quota.`);
    this.name = "QuotaExceededError";
  }
}

/**
 * A usage-store failure must not fail a generation the provider already produced
 * and the caller already paid for (PT-7a, fix round): the row is unrecoverable
 * from here, so this logs enough to reconcile by hand (org, provider, model,
 * units) and swallows the error — the result the caller is holding is still
 * returned.
 */
async function settleUsage(
  usage: UsageStorePort,
  reservationId: string,
  record: Parameters<UsageStorePort["settle"]>[1],
): Promise<void> {
  try {
    await usage.settle(reservationId, record);
  } catch (error) {
    console.warn(
      `[metering] could not settle usage (reservation ${reservationId}, org ${record.orgId}, provider ${record.provider}, model ${record.model}, units ${record.units}): ${errorMessage(error)}`,
    );
  }
}

/**
 * A failure to release an unused reservation (e.g. store connectivity) must
 * not hide the original generator error or prevent returning a cached/fallback
 * result. The unreleased row will expire after RESERVATION_TTL_MS.
 */
async function releaseUsage(usage: UsageStorePort, reservationId: string): Promise<void> {
  try {
    await usage.release(reservationId);
  } catch (error) {
    console.warn(
      `[metering] could not release usage reservation ${reservationId}: ${errorMessage(error)}`,
    );
  }
}

/**
 * Meters one image provider (PT-7a, D175, H2; r2 concurrency under PT-7a2).
 * `pipeline.ts`'s `imageGenerator()` wraps the raw adapter it constructs —
 * `GeminiImageGenerator`, `OpenRouterImageGenerator`, `FireflyImageGenerator` —
 * directly, never the procedural generator (no provider call, no cost) and
 * never `AssetReusingImageGenerator`'s reuse branch (no generation happened).
 * Each of those adapters can also be the `fallback` another one calls
 * internally on failure, so wrapping the raw adapter — not the chain's entry
 * point — records a row for whichever layer actually resolved the background,
 * wherever it sits in the chain.
 *
 * Concurrency (PT-7a2): a reservation is acquired before the provider is
 * called. If the org is at quota, `reserve` returns null and
 * `QuotaExceededError` is thrown before any provider call. On success, the
 * reservation is settled to 'recorded'; on failure, cached result, or
 * fallback delegation, it is released in a finally block.
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
    const reservationId = await this.usage.reserve(this.orgId);
    if (reservationId === null) {
      throw new QuotaExceededError(this.orgId);
    }
    let settled = false;
    try {
      const result = await this.inner.resolveBackground(product, ratio, context, signal);
      // A cached result served no live call, so it billed nothing (D175: "every
      // generation" — a seed-cache hit is not one). And this layer only records
      // when it was the one that actually produced the result — never when a
      // wrapped adapter's internal fallback did the work and its result merely
      // passed back up through this layer unchanged (see the class doc).
      if (!result.cached && result.source === this.provider) {
        await settleUsage(this.usage, reservationId, {
          orgId: this.orgId,
          provider: this.provider,
          model: this.model,
          units: 1,
          keyOwner: KEY_OWNER,
        });
        settled = true;
      }
      return result;
    } finally {
      if (!settled) {
        await releaseUsage(this.usage, reservationId);
      }
    }
  }
}

/**
 * Meters copy-pool generation (PT-7a, D175; r2 concurrency under PT-7a2).
 * `pipeline.ts`'s `copyGenerator()` wraps the `OpenRouterCopyGenerator` it
 * constructs; `routes/campaigns/pools/copy.post.ts` only calls the port it gets
 * back, and maps a thrown `QuotaExceededError` to 429 the same way it already
 * maps `CopyGeneratorError`.
 *
 * Reserves a slot before calling the model, settles on success, and releases
 * in a finally block on failure.
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
    const reservationId = await this.usage.reserve(this.orgId);
    if (reservationId === null) {
      throw new QuotaExceededError(this.orgId);
    }
    let settled = false;
    try {
      const headlines = await this.inner.suggestHeadlines(input);
      await settleUsage(this.usage, reservationId, {
        orgId: this.orgId,
        provider: this.provider,
        model: this.inner.model,
        units: headlines.length,
        keyOwner: KEY_OWNER,
      });
      settled = true;
      return headlines;
    } finally {
      if (!settled) {
        await releaseUsage(this.usage, reservationId);
      }
    }
  }
}
