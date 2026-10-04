import { describe, test, expect } from "vitest";
import {
  IMPORT_STEPS,
  type CampaignOutcome,
  type ImportStep,
  type PlannedCampaign,
  type StepContext,
} from "../steps.js";

/**
 * PT-8a item 12, PT-8-7: the one ordered step list and the shapes every later lane's step
 * takes. 8b, 8c, 8d and 8e each append ONE entry to `IMPORT_STEPS`, so this file pins the
 * CONTAINER and the signatures and says nothing about the list's length — a length
 * assertion here would be red the moment the second of those four merges.
 */
describe("IMPORT_STEPS", () => {
  test("is the ordered apply-step list, and every entry in it is a step function", () => {
    // Imported as a VALUE, not `import type`: the list is this module's one runtime
    // statement, and a type-only import would leave it uncovered.
    expect(Array.isArray(IMPORT_STEPS)).toBe(true);
    expect(IMPORT_STEPS.every((step) => typeof step === "function")).toBe(true);
  });

  test("a step takes the shared context and campaign and answers one campaign outcome", async () => {
    // `satisfies`, not an annotation: both halves are compile-time claims, so a later
    // lane that widens either shape fails `yarn typecheck` rather than a run. The
    // `.getTime()` is the pin that matters — `switchedAt` is the PARSED date PT-8a1 req 4
    // parses once and carries here, and widening it back to the raw `--switched-at`
    // string compiles everywhere until the first step calls a Date method on it.
    const ctx = {
      orgId: "local",
      switchedAt: new Date("2026-10-01T00:00:00Z"),
      projectRoot: "/p",
      outputRoot: "/o",
      includeSamples: false,
      fsOnly: true,
    } satisfies StepContext;
    const campaign = {
      slug: "acme-launch",
      sourcePath: "/p/briefs/acme-launch.yaml",
    } satisfies PlannedCampaign;
    const step = (async (c: StepContext, _campaign: PlannedCampaign) => {
      c.switchedAt.getTime();
      return { outcome: "unchanged" as const };
    }) satisfies ImportStep;

    expect(await step(ctx, campaign)).toEqual({ outcome: "unchanged" });

    // The four answers a step may give, in the order the plan reports them, each one a
    // step written against the same signature returning its own outcome.
    const outcomes: readonly CampaignOutcome[] = ["created", "completed", "unchanged", "refused"];
    for (const outcome of outcomes) {
      const answering = (async (_c: StepContext, _campaign: PlannedCampaign) => {
        return { outcome };
      }) satisfies ImportStep;
      expect(await answering(ctx, campaign)).toEqual({ outcome });
    }
  });
});
