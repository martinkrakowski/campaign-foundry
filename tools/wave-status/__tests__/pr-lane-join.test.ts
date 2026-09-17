import { describe, test, expect } from "vitest";
import { readFile } from "node:fs/promises";

import { collect, type CollectDeps } from "../lib/collect.js";
import type { LaneStatus } from "../lib/types.js";

/**
 * The join, proved against a recording of real state on the machine this
 * lane was written on — the verbatim `gh pr list --state all` output and the
 * verbatim wave directory of `creative-templates-w01`. Hand-built fixtures
 * assume the convention was followed; this one keeps the casing, the slug
 * rewording (`L2a-compositor-layer-list` shipped as `feat/l2a-layer-list`)
 * and the prefix families (`fix/h2-hit-testing`) exactly as the orchestrator
 * produced them. That is the point.
 */
interface RecordedFixture {
  readonly ghPrList: readonly {
    readonly number: number;
    readonly state: string;
    readonly headRefName: string;
    readonly headRefOid: string;
  }[];
  readonly waveDirName: string;
  readonly entries: readonly string[];
  readonly events: string;
}

const ROOT = "/recorded";

async function recordedFixture(): Promise<{
  readonly lanes: readonly LaneStatus[];
  readonly fixture: RecordedFixture;
}> {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/pr-lane-join-2026-09-12.json", import.meta.url), "utf8"),
  ) as RecordedFixture;
  const dir = `${ROOT}/${fixture.waveDirName}`;
  const deps: CollectDeps = {
    readdir: async (path) => {
      if (path === ROOT) return [fixture.waveDirName];
      if (path === dir) return fixture.entries;
      throw new Error(`ENOENT: readdir ${path}`);
    },
    readFile: async (path) => {
      if (path === `${dir}/events.jsonl`) return fixture.events;
      throw new Error(`ENOENT: readFile ${path}`);
    },
    open: async (path) => {
      throw new Error(`ENOENT: open ${path}`);
    },
    pgrep: async () => 0,
    gh: async (args) =>
      (args[0] === "api" && args[1].includes("pulls")) || args[0] === "pr"
        ? JSON.stringify(fixture.ghPrList)
        : "not json",
  };
  const status = await collect(deps, ROOT, "2026-09-12T00:00:00Z");
  return {
    fixture,
    lanes: status.waves.find((wave) => wave.id === "creative-templates")?.lanes ?? [],
  };
}

/** Every lane → PR number the recorded data produces. Derived from the rules, not the code. */
const RECORDED_JOIN: Readonly<Record<string, number>> = {
  "H1-tokens-route": 275,
  "H1a-tokens-selector": 280,
  "H2-hit-testing": 285,
  "L12-schema-version": 255,
  "L1a-creative-vocabulary": 260,
  "L1b-brief-template": 263,
  "L2a-compositor-layer-list": 265,
  "L2b-preview-layer-order": 266,
  "L3a-template-required": 268,
  "L3b-layer-props": 273,
  "L4-compatibility-rules": 276,
  "L5-template-editor": 278,
  "L6-html-output-family": 277,
  "L7a1-template-store": 274,
  "L8a-reorder": 284,
  "W1c-cli-hardening": 287,
  "W2a-status-layout": 286,
  "W2b1-log-toolbar": 291,
};

/**
 * The lanes the recording's events name — all 24, sorted. The join resolves
 * 18 of them; the rest are the near-misses the last test pins.
 */
const RECORDED_EVENT_LANES: readonly string[] = [
  "H1-tokens-route",
  "H1a-tokens-selector",
  "H2-hit-testing",
  "L12-schema-version",
  "L1a-creative-vocabulary",
  "L1b-brief-template",
  "L2a-compositor-layer-list",
  "L2b-preview-layer-order",
  "L3a-template-required",
  "L3b-layer-props",
  "L4-compatibility-rules",
  "L5-template-editor",
  "L6-html-output-family",
  "L7a-template-library",
  "L7a1-template-store",
  "L8-reorder-occlusion",
  "L8a-reorder",
  "W1-status-cli",
  "W1c-cli-hardening",
  "W2a-status-layout",
  "W2b-log-viewer",
  "W2b1-log-toolbar",
  "W2b1r",
  "WS1b",
];

/**
 * Real lanes the recording ran but never reported: a log and a PR carry their
 * name, no event does. Under the evidence rule they are invisible to the
 * page — the honest cost of "a log never buys a row", asserted so the cost
 * cannot quietly turn back into a phantom-lane revival. Closing the gap means
 * making the runners emit, not making the page guess from filenames again.
 */
const NEVER_REPORTED: readonly string[] = [
  "L8m",
  "L8o",
  "M2",
  "R1",
  "T4",
  "VD",
  "W1a-status-cli",
  "W2b2",
  "WS1",
];

describe("the PR-to-lane join against a recording of real data", () => {
  test("the join is non-empty: 18 of the 24 recorded lanes the events name resolve to their PR", async () => {
    const { lanes } = await recordedFixture();
    expect(lanes.map((lane) => lane.lane).sort()).toEqual([...RECORDED_EVENT_LANES].sort());
    const joined: Record<string, number> = {};
    for (const lane of lanes) {
      if (lane.derived.pr !== undefined) joined[lane.lane] = lane.derived.pr.number;
    }
    expect(joined).toEqual(RECORDED_JOIN);
  });

  test("a log and a PR name a lane, but only an event creates one: the silent nine are absent", async () => {
    // Every one of these ran for real — dispatched without `wave-event.sh`.
    // The old collector showed them by counting their logs; the new one shows
    // nothing, and the nine are pinned here so the trade stays a decision,
    // not a drift.
    const { lanes } = await recordedFixture();
    const names = new Set(lanes.map((lane) => lane.lane));
    for (const silent of NEVER_REPORTED) {
      expect(names.has(silent)).toBe(false);
    }
  });

  test("the C1 defect is present in the fixture itself: the old exact `feat/<lane>` rule joined nothing", async () => {
    const { lanes, fixture } = await recordedFixture();
    const oldRuleKeys = fixture.ghPrList
      .filter((entry) => entry.headRefName.startsWith("feat/"))
      .map((entry) => entry.headRefName.slice("feat/".length));
    expect(lanes.map((lane) => lane.lane).filter((lane) => oldRuleKeys.includes(lane))).toEqual([]);
  });

  test("the event's own pr joins a lane whose branch slug was reworded and no branch could find", async () => {
    const { lanes, fixture } = await recordedFixture();
    const row = lanes.find((lane) => lane.lane === "L2a-compositor-layer-list");
    // S3: checks the sweep never took are "unknown", not the old overloaded
    // "none". The join — the point of this fixture — is untouched by it.
    expect(row?.derived.pr).toEqual({ number: 265, state: "merged", checks: "unknown" });
    expect(fixture.ghPrList.map((entry) => entry.headRefName)).not.toContain(
      "feat/L2a-compositor-layer-list",
    );
  });

  test("the fallback normalises case and prefix family without being pinned to either", async () => {
    const { lanes } = await recordedFixture();
    const rows = Object.fromEntries(lanes.map((lane) => [lane.lane, lane.derived.pr?.number]));
    // `H1a-tokens-selector`/`H2-hit-testing` reach lowercase `fix/` tails;
    // `L8a-reorder` reaches a `feat/` one. Case-folded and prefix-agnostic,
    // and pinned to no single family.
    expect(rows["H1a-tokens-selector"]).toBe(280);
    expect(rows["H2-hit-testing"]).toBe(285);
    expect(rows["L8a-reorder"]).toBe(284);
  });

  test("near-miss lanes join nothing: `W1` does not collect `W1a`'s PR", async () => {
    const { lanes } = await recordedFixture();
    const rows = Object.fromEntries(lanes.map((lane) => [lane.lane, lane.derived.pr?.number]));
    expect(rows["W1-status-cli"]).toBeUndefined();
    expect(rows["L7a-template-library"]).toBeUndefined();
    expect(rows["L8-reorder-occlusion"]).toBeUndefined();
    expect(rows["WS1b"]).toBeUndefined();
  });
});
