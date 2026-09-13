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

async function recordedFixture(): Promise<{ readonly lanes: readonly LaneStatus[]; readonly fixture: RecordedFixture }> {
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
    gh: async (args) => (args[0] === "pr" ? JSON.stringify(fixture.ghPrList) : "not json"),
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
  L8m: 297,
  L8o: 298,
  M2: 214,
  R1: 318,
  T4: 234,
  VD: 322,
  "W1a-status-cli": 282,
  "W1c-cli-hardening": 287,
  "W2a-status-layout": 286,
  "W2b1-log-toolbar": 291,
  W2b2: 293,
  WS1: 299,
};

describe("the PR-to-lane join against a recording of real data", () => {
  test("the join is non-empty: 27 of the recorded lanes resolve to their PR", async () => {
    const { lanes } = await recordedFixture();
    const joined: Record<string, number> = {};
    for (const lane of lanes) {
      if (lane.derived.pr !== undefined) joined[lane.lane] = lane.derived.pr.number;
    }
    expect(joined).toEqual(RECORDED_JOIN);
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
    expect(row?.derived.pr).toEqual({ number: 265, state: "merged", checks: "none" });
    expect(fixture.ghPrList.map((entry) => entry.headRefName)).not.toContain(
      "feat/L2a-compositor-layer-list",
    );
  });

  test("the fallback normalises case and prefix family without being pinned to either", async () => {
    const { lanes } = await recordedFixture();
    const rows = Object.fromEntries(lanes.map((lane) => [lane.lane, lane.derived.pr?.number]));
    expect(rows["M2"]).toBe(214);
    expect(rows["H1a-tokens-selector"]).toBe(280);
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
