import { describe, test, expect } from "vitest";
import {
  AspectRatio,
  type CopyGeneratorInput,
  type CopyGeneratorPort,
  type ImageGeneratorPort,
} from "@campaignfoundry/CampaignOrchestration";
import { MeteredCopyGenerator, MeteredImageGenerator } from "../metering.js";
import type { UsageRecord, UsageStorePort } from "../ports/usage-store.port.js";

const ratio = (v = "1:1") => {
  const r = AspectRatio.create(v);
  if (!r.success) throw r.error;
  return r.value;
};
const product = {
  id: "hydra",
  name: "Hydra Bottle",
  primaryColor: "#1473E6",
  logoPath: "assets/inputs/hydra-logo.png",
};
const context = { campaignMessage: "m", targetAudience: "Urban", targetRegion: "DE" };

/** A usage store double that records every call it was given, and nothing else. */
function fakeUsage(): UsageStorePort & { readonly records: UsageRecord[] } {
  const records: UsageRecord[] = [];
  return {
    records,
    record: async (usage) => {
      records.push(usage);
    },
    countThisMonth: async () => 0,
    quota: async () => null,
  };
}

describe("MeteredImageGenerator (PT-7a, D175)", () => {
  test("a non-cached generation records one row naming the org, provider and model", async () => {
    const usage = fakeUsage();
    const inner: ImageGeneratorPort = {
      resolveBackground: async () => ({ image: new Uint8Array([1]), source: "imagen" }),
    };
    const meter = new MeteredImageGenerator(
      inner,
      usage,
      "acme",
      "imagen",
      "imagen-4.0-generate-001",
    );
    const result = await meter.resolveBackground(product, ratio(), context);
    expect(result).toEqual({ image: new Uint8Array([1]), source: "imagen" });
    expect(usage.records).toEqual([
      {
        orgId: "acme",
        provider: "imagen",
        model: "imagen-4.0-generate-001",
        units: 1,
        keyOwner: "platform",
      },
    ]);
  });

  test("a cached result records nothing — the provider was never called", async () => {
    const usage = fakeUsage();
    const inner: ImageGeneratorPort = {
      resolveBackground: async () => ({
        image: new Uint8Array([1]),
        source: "imagen",
        cached: true,
      }),
    };
    const meter = new MeteredImageGenerator(
      inner,
      usage,
      "acme",
      "imagen",
      "imagen-4.0-generate-001",
    );
    await meter.resolveBackground(product, ratio(), context);
    expect(usage.records).toEqual([]);
  });

  test("records nothing when the result came from a further fallback, not this layer (no double-count)", async () => {
    // A raw adapter's own `fallback` option is itself a metered generator: when
    // this layer's inner adapter fails internally, it returns its fallback's
    // result unchanged — so a result whose `source` is a DIFFERENT provider means
    // that fallback already recorded its own row, and this layer must not record
    // a second one for work it never did.
    const usage = fakeUsage();
    const inner: ImageGeneratorPort = {
      resolveBackground: async () => ({ image: new Uint8Array([1]), source: "imagen" }),
    };
    const meter = new MeteredImageGenerator(inner, usage, "acme", "firefly", "v3");
    const result = await meter.resolveBackground(product, ratio(), context);
    expect(result.source).toBe("imagen"); // the fallback's result, passed through unchanged
    expect(usage.records).toEqual([]); // firefly did no work; nothing to bill it for
  });

  test("passes the run's abort signal through to the wrapped adapter", async () => {
    const usage = fakeUsage();
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const inner: ImageGeneratorPort = {
      resolveBackground: async (_p, _r, _c, signal) => {
        seen = signal;
        return { image: new Uint8Array(), source: "openrouter" };
      },
    };
    const meter = new MeteredImageGenerator(
      inner,
      usage,
      "local",
      "openrouter",
      "x-ai/grok-imagine-image-quality",
    );
    await meter.resolveBackground(product, ratio(), context, controller.signal);
    expect(seen).toBe(controller.signal);
  });
});

describe("MeteredCopyGenerator (PT-7a, D175)", () => {
  test("publishes the wrapped generator's model", () => {
    const usage = fakeUsage();
    const inner: CopyGeneratorPort = {
      model: "openai/gpt-4o-mini",
      suggestHeadlines: async () => [],
    };
    const meter = new MeteredCopyGenerator(inner, usage, "local", "openrouter");
    expect(meter.model).toBe("openai/gpt-4o-mini");
  });

  test("a successful call records one row, units the headlines the model returned", async () => {
    const usage = fakeUsage();
    const inner: CopyGeneratorPort = {
      model: "openai/gpt-4o-mini",
      suggestHeadlines: async () => ["Stay wild", "Go far", "Never settle"],
    };
    const meter = new MeteredCopyGenerator(inner, usage, "local", "openrouter");
    const input: CopyGeneratorInput = { brief: {} as CopyGeneratorInput["brief"], count: 3 };
    const headlines = await meter.suggestHeadlines(input);
    expect(headlines).toEqual(["Stay wild", "Go far", "Never settle"]);
    expect(usage.records).toEqual([
      {
        orgId: "local",
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        units: 3,
        keyOwner: "platform",
      },
    ]);
  });

  test("a failed call records nothing and rethrows", async () => {
    const usage = fakeUsage();
    const inner: CopyGeneratorPort = {
      model: "openai/gpt-4o-mini",
      suggestHeadlines: async () => {
        throw new Error("upstream boom");
      },
    };
    const meter = new MeteredCopyGenerator(inner, usage, "local", "openrouter");
    await expect(
      meter.suggestHeadlines({ brief: {} as CopyGeneratorInput["brief"], count: 1 }),
    ).rejects.toThrow("upstream boom");
    expect(usage.records).toEqual([]);
  });
});
