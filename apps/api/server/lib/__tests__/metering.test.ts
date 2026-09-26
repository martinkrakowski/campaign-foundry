import { describe, test, expect, vi } from "vitest";
import {
  AspectRatio,
  type CopyGeneratorInput,
  type CopyGeneratorPort,
  type ImageGeneratorPort,
} from "@campaignfoundry/CampaignOrchestration";
import { MeteredCopyGenerator, MeteredImageGenerator, QuotaExceededError } from "../metering.js";
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

/** A usage store double that records every call it was given, and tracks reservations. */
function fakeUsage(): UsageStorePort & {
  readonly records: UsageRecord[];
  readonly reservations: string[];
  readonly settled: { id: string; record: UsageRecord }[];
  readonly released: string[];
} {
  const records: UsageRecord[] = [];
  const reservations: string[] = [];
  const settled: { id: string; record: UsageRecord }[] = [];
  const released: string[] = [];
  let nextId = 1;
  return {
    records,
    reservations,
    settled,
    released,
    reserve: async () => {
      const id = `res-${nextId++}`;
      reservations.push(id);
      return id;
    },
    settle: async (id: string, record: UsageRecord) => {
      settled.push({ id, record });
      records.push(record);
    },
    release: async (id: string) => {
      released.push(id);
    },
    record: async (usage: UsageRecord) => {
      records.push(usage);
    },
    countThisMonth: async () => 0,
    quota: async () => null,
  };
}

/**
 * A usage store double with a fixed quota and a count that increments as
 * records are made — for the "stops once the quota is reached" tests, where a
 * sequence of calls has to see the count move the same way `PgUsageStore`
 * would as each one commits.
 */
function statefulUsage(
  quota: number | null,
  startCount = 0,
): UsageStorePort & { readonly records: UsageRecord[] } {
  const records: UsageRecord[] = [];
  let count = startCount;
  let nextId = 1;
  return {
    records,
    reserve: async () => {
      if (quota !== null && count >= quota) return null;
      count += 1;
      return `res-${nextId++}`;
    },
    settle: async (_id, usage) => {
      records.push(usage);
    },
    release: async () => {
      count -= 1;
    },
    record: async (usage) => {
      records.push(usage);
      count += 1;
    },
    countThisMonth: async () => count,
    quota: async () => quota,
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

  test("refuses at the quota without calling the provider, and records nothing (fix round)", async () => {
    const usage = statefulUsage(2, 2); // already at the quota
    const inner: ImageGeneratorPort = {
      resolveBackground: vi.fn(async () => ({
        image: new Uint8Array([1]),
        source: "imagen" as const,
      })),
    };
    const meter = new MeteredImageGenerator(inner, usage, "acme", "imagen", "imagen-4.0");
    await expect(meter.resolveBackground(product, ratio(), context)).rejects.toThrow(
      QuotaExceededError,
    );
    expect(inner.resolveBackground).not.toHaveBeenCalled();
    expect(usage.records).toEqual([]);
  });

  test("a run admitted under quota stops calling the provider once the count reaches it (fix round)", async () => {
    // Same behaviour a multi-cell campaign run relies on: admission read the
    // count once, before the run started (quota - 1), but every one of these
    // calls re-checks it live.
    const usage = statefulUsage(2, 0);
    const inner: ImageGeneratorPort = {
      resolveBackground: vi.fn(async () => ({
        image: new Uint8Array([1]),
        source: "imagen" as const,
      })),
    };
    const meter = new MeteredImageGenerator(inner, usage, "acme", "imagen", "imagen-4.0");
    await meter.resolveBackground(product, ratio(), context); // count 0 -> 1
    await meter.resolveBackground(product, ratio(), context); // count 1 -> 2 (now at quota)
    expect(inner.resolveBackground).toHaveBeenCalledTimes(2);
    await expect(meter.resolveBackground(product, ratio(), context)).rejects.toThrow(
      QuotaExceededError,
    );
    expect(inner.resolveBackground).toHaveBeenCalledTimes(2); // no third call
  });

  test("a usage-store settle failure still returns the result and warns (fix round)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const usage = fakeUsage();
    usage.settle = async () => {
      throw new Error("connection reset");
    };
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
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain("acme");
    expect(message).toContain("imagen");
    expect(message).toContain("connection reset");
    warn.mockRestore();
  });

  test("a usage-store release failure still returns the result and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const usage = fakeUsage();
    usage.release = async () => {
      throw new Error("release failed");
    };
    const inner: ImageGeneratorPort = {
      resolveBackground: async () => ({
        image: new Uint8Array([1]),
        source: "imagen",
        cached: true,
      }),
    };
    const meter = new MeteredImageGenerator(inner, usage, "acme", "imagen", "imagen-4.0");
    const result = await meter.resolveBackground(product, ratio(), context);
    expect(result.cached).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain("could not release usage reservation");
    expect(message).toContain("release failed");
    warn.mockRestore();
  });

  test("releases reservation on provider failure (PT-7a2, D175)", async () => {
    const usage = fakeUsage();
    const inner: ImageGeneratorPort = {
      resolveBackground: async () => {
        throw new Error("provider error");
      },
    };
    const meter = new MeteredImageGenerator(inner, usage, "acme", "imagen", "imagen-4.0");
    await expect(meter.resolveBackground(product, ratio(), context)).rejects.toThrow(
      "provider error",
    );
    expect(usage.reservations).toHaveLength(1);
    expect(usage.released).toEqual([usage.reservations[0]]);
    expect(usage.settled).toHaveLength(0);
  });

  test("releases reservation on cached result (PT-7a2, D175)", async () => {
    const usage = fakeUsage();
    const inner: ImageGeneratorPort = {
      resolveBackground: async () => ({
        image: new Uint8Array([1]),
        source: "imagen",
        cached: true,
      }),
    };
    const meter = new MeteredImageGenerator(inner, usage, "acme", "imagen", "imagen-4.0");
    await meter.resolveBackground(product, ratio(), context);
    expect(usage.reservations).toHaveLength(1);
    expect(usage.released).toEqual([usage.reservations[0]]);
    expect(usage.settled).toHaveLength(0);
  });

  test("releases reservation on fallback-owned result (PT-7a2, D175)", async () => {
    const usage = fakeUsage();
    const inner: ImageGeneratorPort = {
      resolveBackground: async () => ({ image: new Uint8Array([1]), source: "imagen" }),
    };
    const meter = new MeteredImageGenerator(inner, usage, "acme", "firefly", "v3");
    const result = await meter.resolveBackground(product, ratio(), context);
    expect(result.source).toBe("imagen");
    expect(usage.reservations).toHaveLength(1);
    expect(usage.released).toEqual([usage.reservations[0]]);
    expect(usage.settled).toHaveLength(0);
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

  test("refuses at the quota without calling the provider, and records nothing (fix round)", async () => {
    const usage = statefulUsage(1, 1); // already at the quota
    const inner: CopyGeneratorPort = {
      model: "openai/gpt-4o-mini",
      suggestHeadlines: vi.fn(async () => ["Stay wild"]),
    };
    const meter = new MeteredCopyGenerator(inner, usage, "acme", "openrouter");
    await expect(
      meter.suggestHeadlines({ brief: {} as CopyGeneratorInput["brief"], count: 1 }),
    ).rejects.toThrow(QuotaExceededError);
    expect(inner.suggestHeadlines).not.toHaveBeenCalled();
    expect(usage.records).toEqual([]);
  });

  test("releases reservation on copy provider failure (PT-7a2, D175)", async () => {
    const usage = fakeUsage();
    const inner: CopyGeneratorPort = {
      model: "openai/gpt-4o-mini",
      suggestHeadlines: async () => {
        throw new Error("copy failure");
      },
    };
    const meter = new MeteredCopyGenerator(inner, usage, "acme", "openrouter");
    await expect(
      meter.suggestHeadlines({ brief: {} as CopyGeneratorInput["brief"], count: 1 }),
    ).rejects.toThrow("copy failure");
    expect(usage.reservations).toHaveLength(1);
    expect(usage.released).toEqual([usage.reservations[0]]);
    expect(usage.settled).toHaveLength(0);
  });
});
