import { describe, test, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESERVED_ROUTE_SEGMENTS } from "@campaignfoundry/CampaignOrchestration";
import { staticRouteSegments } from "./route-tree.js";

// This file lives in routes/campaigns/__tests__/, one level below the routes
// it inventories.
const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("static route segments under routes/campaigns/ (HX1/D181)", () => {
  test("every static segment on disk is in RESERVED_ROUTE_SEGMENTS", () => {
    const onDisk = staticRouteSegments(ROUTES_DIR);
    const reserved = new Set<string>(RESERVED_ROUTE_SEGMENTS);
    const missing = onDisk.filter((segment) => !reserved.has(segment));
    expect(
      missing,
      `on disk under routes/campaigns/ but missing from RESERVED_ROUTE_SEGMENTS: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  // The other direction: a segment reserved for a route that no longer exists
  // costs a real campaign a usable slug for nothing. Together with the test
  // above this makes RESERVED_ROUTE_SEGMENTS exactly the route tree's static
  // segments, not merely a superset of them.
  test("RESERVED_ROUTE_SEGMENTS has no segment absent from disk", () => {
    const onDisk = new Set(staticRouteSegments(ROUTES_DIR));
    const stale = RESERVED_ROUTE_SEGMENTS.filter((segment) => !onDisk.has(segment));
    expect(stale, `in RESERVED_ROUTE_SEGMENTS but not on disk: ${stale.join(", ")}`).toEqual([]);
  });

  // A manifest mutation only replaces text — it cannot add a file — so the
  // claim that this derivation actually catches an unreserved static route
  // needs its own fixture tree, built and torn down here.
  test("the derivation catches a static segment a fixture tree's caller list omits", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "cf-route-tree-fixture-"));
    try {
      writeFileSync(join(fixtureDir, "widgets.get.ts"), "export default () => {};\n");
      mkdirSync(join(fixtureDir, "gadgets"), { recursive: true });
      writeFileSync(join(fixtureDir, "index.post.ts"), "export default () => {};\n");
      mkdirSync(join(fixtureDir, "[id]"), { recursive: true });
      mkdirSync(join(fixtureDir, "__tests__"), { recursive: true });
      writeFileSync(join(fixtureDir, "__tests__", "helper.ts"), "export {};\n");

      const onDisk = staticRouteSegments(fixtureDir);
      // "index" and "__tests__" are excluded by the derivation itself; "[id]"
      // is excluded too — none of the three should ever reach the caller.
      expect(onDisk).toEqual(["gadgets", "widgets"]);

      const deliberatelyIncompleteList = new Set(["widgets"]);
      const missing = onDisk.filter((segment) => !deliberatelyIncompleteList.has(segment));
      expect(missing).toEqual(["gadgets"]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
