import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { FsBriefStore } from "../apps/api/server/lib/ports/fs-brief-store.js";

/**
 * Finding L1 (plan `2026-09-29_wave-hardening-and-w05-follow-ups.md:48`):
 * `FsBriefStore.findBriefFileById` resolves one id by reading and YAML-parsing
 * EVERY brief file in the briefs root — it is `listBriefs()` plus a `find` over
 * the result — and it backs `resolveCampaign`, `campaignVisibility`,
 * `campaignMeta`, `campaignTeam`, `readBrief`, `getRevision`, `exists`,
 * `rewriteBrief` and `replaceBrief`, i.e. the assets, decisions, pools and
 * preview-frame routes.
 *
 * This script measures that, and exists because the row that chartered it is a
 * MEASUREMENT rather than a change: over 1,000 campaigns, a hit median over
 * 5 ms means the lane builds an in-memory id -> slug index, and a median under
 * it means the finding closes with these numbers and no index. Re-run it after
 * any change to `FsBriefStore`; the number it prints is the only evidence
 * either branch of that decision rests on.
 *
 * Not a test, and deliberately not one: it seeds a thousand campaigns and runs
 * a hundred timed lookups, which no assertion wants in CI. It lives in
 * `scripts/` rather than `apps/api/bin/` because `vitest.config.ts` puts
 * `apps/api/bin/**` inside the coverage include and holds it to 100%, and a
 * script whose only job is to print timings is not something to assert on.
 * (`scripts/check-env.ts` is the same kind of thing and lives beside it.)
 *
 * Run it in the foreground and read the whole output:
 *
 *   yarn tsx scripts/bench-fs-id-lookup.ts
 */

/** The corpus size the row names. */
const CAMPAIGNS = 1000;

/** The row's iteration count, per case. */
const ITERATIONS = 50;

/** The row's threshold: a hit median over this many ms is what an index is for. */
const THRESHOLD_MS = 5;

/**
 * Slugs are zero-padded so the lexicographic order `listBriefs` sorts by is the
 * numeric order — `bench-campaign-0999.yaml` is genuinely last, which is what
 * "a hit near the end" has to mean for the measurement to be the worst case.
 */
function slugFor(index: number): string {
  return `bench-campaign-${String(index).padStart(4, "0")}`;
}

function briefFor(id: string): CampaignBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id,
    targetRegion: "US",
    targetAudience: "developers",
    campaignMessage: "Build great things",
    products: [{ id: "prod-1", name: "Product 1", primaryColor: "#1473E6", logoPath: "logo.png" }],
  };
}

/**
 * Nearest-rank percentile over an ascending sample: the smallest value at or
 * above the requested share, so p95 of 50 iterations is the 48th value. No
 * interpolation — the sample is a set of whole measured calls, and inventing a
 * value between two of them would be a number no call ever produced.
 */
function percentile(ascending: readonly number[], p: number): number {
  const rank = Math.min(ascending.length, Math.max(1, Math.ceil((p / 100) * ascending.length)));
  return ascending[rank - 1];
}

function ms(value: number): string {
  // Four decimals: a hit served from the index is a Map read, and at three it
  // prints as a flat 0.000 — which reads as "not measured" rather than as the
  // sub-microsecond answer it is.
  return value.toFixed(4).padStart(10);
}

/**
 * Time `ITERATIONS` lookups of one id and report the spread. Every call's
 * result is checked: a benchmark that measured a lookup silently returning
 * nothing would report the cost of the failure path and look like the fast
 * branch, which is the one number in this lane that decides whether work
 * happens.
 */
async function measure(
  store: FsBriefStore,
  id: string,
  label: string,
  expect: (file: string | undefined) => boolean,
): Promise<{ median: number; p95: number }> {
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const file = await store.findBriefFileById(id);
    samples.push(performance.now() - start);
    if (!expect(file)) {
      throw new Error(
        `bench: iteration ${i} of the ${label} case looked up "${id}" and got ${JSON.stringify(file)}, which is not the result this case is measuring`,
      );
    }
  }
  // No warm-up and no discarded first call: a cold first iteration is part of
  // what a real first request pays, and min/max below show the spread either
  // way. The median is the number the decision reads.
  samples.sort((a, b) => a - b);
  const median = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  console.log(
    `  ${label.padEnd(4)} ${id.padEnd(22)} median ${ms(median)} ms   p95 ${ms(p95)} ms   min ${ms(samples[0])} ms   max ${ms(samples[samples.length - 1])} ms`,
  );
  return { median, p95 };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "cf-bench-fs-id-"));
  try {
    const store = new FsBriefStore(dir);

    // Two passes on purpose, never interleaved. `createCampaign` answers "is
    // this slug taken?" through `findBriefFileById` itself, so alternating the
    // two would make seeding quadratic — 1,000 reservations over a root that
    // grows to 1,000 brief files is ~500,000 file reads, and the seed would
    // outlast the measurement by orders of magnitude. Every reservation first
    // (each over a still-empty root), then every brief file.
    for (let i = 0; i < CAMPAIGNS; i++) {
      await store.createCampaign(slugFor(i));
    }
    for (let i = 0; i < CAMPAIGNS; i++) {
      await store.createBrief(briefFor(slugFor(i)));
    }

    // The last slug by sort order. Its position does not change the cost — the
    // scan reads all 1,000 files before `find` looks at the first entry — which
    // is the finding itself, and this case measures the worst end of it.
    const hitId = slugFor(CAMPAIGNS - 1);
    const missId = "no-such-campaign";

    console.log(
      `fs id lookups over ${CAMPAIGNS} campaigns + ${CAMPAIGNS} reservations, ${ITERATIONS} iterations per case (FsBriefStore.findBriefFileById)`,
    );
    const hit = await measure(store, hitId, "hit", (file) => file === `${hitId}.yaml`);
    await measure(store, missId, "miss", (file) => file === undefined);

    // The comparison the row turned on, reported as a measurement and not as
    // a verdict: this script is re-run after the index exists, where "no index
    // is needed" would be a conclusion about code that is not in front of the
    // reader. What each branch decided at the time is in this file's header.
    console.log(
      `  vs the row's ${THRESHOLD_MS} ms threshold: hit median ${hit.median.toFixed(4)} ms (${hit.median > THRESHOLD_MS ? "OVER" : "under"})`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
