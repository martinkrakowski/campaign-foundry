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
 * Refuse before the provider is called, not after (PT-7a, D175, fix round):
 * called first in both wrappers below, so a refusal records no usage row and
 * spends nothing. `null` quota is unlimited, same as the admission check.
 *
 * Soft under concurrency, by design: this reads `countThisMonth` and `quota`
 * fresh on every call rather than holding a lock across the check-and-record,
 * so two calls admitted from the same one-under-quota count can both pass and
 * both record — an org can run slightly over its quota, never far over it, and
 * the next call after either commits sees the incremented count and refuses.
 * A hard cap would need a locked counter (e.g. `UPDATE ... RETURNING`), which
 * D175 does not ask for.
 */
async function assertUnderQuota(usage: UsageStorePort, orgId: string): Promise<void> {
  const quota = await usage.quota(orgId);
  if (quota === null) return;
  const count = await usage.countThisMonth(orgId, new Date());
  if (count >= quota) throw new QuotaExceededError(orgId);
}

/**
 * A usage-store failure must not fail a generation the provider already produced
 * and the caller already paid for (PT-7a, fix round): the row is unrecoverable
 * from here, so this logs enough to reconcile by hand (org, provider, model,
 * units) and swallows the error — the result the caller is holding is still
 * returned.
 */
async function recordUsage(
  usage: UsageStorePort,
  record: Parameters<UsageStorePort["record"]>[0],
): Promise<void> {
  try {
    await usage.record(record);
  } catch (error) {
    console.warn(
      `[metering] could not record usage (org ${record.orgId}, provider ${record.provider}, model ${record.model}, units ${record.units}): ${errorMessage(error)}`,
    );
  }
}

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
    // Re-checked here, not just once at admission (see QuotaExceededError's doc):
    // a run already in flight must stop calling this provider the moment the
    // org is no longer under quota, and the CLI never passes through the
    // route's admission check at all.
    await assertUnderQuota(this.usage, this.orgId);
    const result = await this.inner.resolveBackground(product, ratio, context, signal);
    // A cached result served no live call, so it billed nothing (D175: "every
    // generation" — a seed-cache hit is not one). And this layer only records
    // when it was the one that actually produced the result — never when a
    // wrapped adapter's internal fallback did the work and its result merely
    // passed back up through this layer unchanged (see the class doc).
    if (!result.cached && result.source === this.provider) {
      await recordUsage(this.usage, {
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
 * only calls the port it gets back, and maps a thrown `QuotaExceededError` to
 * 429 the same way it already maps `CopyGeneratorError`. Copy has no
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
    // Re-checked here, not just once at admission — see QuotaExceededError's doc.
    await assertUnderQuota(this.usage, this.orgId);
    const headlines = await this.inner.suggestHeadlines(input);
    await recordUsage(this.usage, {
      orgId: this.orgId,
      provider: this.provider,
      model: this.inner.model,
      units: headlines.length,
      keyOwner: KEY_OWNER,
    });
    return headlines;
  }
}
