import { describe, test, expect } from "vitest";
import { screen } from "@testing-library/react";
import { createElement } from "react";
import userEvent from "@testing-library/user-event";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { Asset } from "@/lib/run-context";
import { renderWithRun, seedPersistedRun } from "@/__tests__/helpers";
import { useRun } from "@/lib/run-context";
import { Sidebar, SidebarContent } from "../Sidebar";

const ALL_RATIOS = "1:1, 9:16, 16:9";

/** A valid classic brief; the per-test spread adds `mode`/`variation` when needed. */
const BASE: CampaignBrief = {
  id: "summer-hydration-2026",
  targetRegion: "DE",
  targetAudience: "Urban outdoor enthusiasts, 25-40",
  campaignMessage: "Stay wild. Stay hydrated.",
  localizedMessage: "Bleib wild. Bleib hydriert.",
  products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }],
};

/** Renders SidebarContent and swaps the run's brief behind a button, so each test
 * drives one Aspects derivation path against the real run context. */
function BriefSwitcher({ brief }: { brief: CampaignBrief }) {
  const { setBrief } = useRun();
  return (
    <div>
      <button type="button" onClick={() => setBrief(brief)}>
        Switch
      </button>
      <SidebarContent />
    </div>
  );
}

describe("SidebarContent — the Aspects readout derives per run mode", () => {
  test("a classic brief (no mode) lists every ratio", () => {
    renderWithRun(<SidebarContent />);
    expect(screen.getByText(ALL_RATIOS)).toBeTruthy();
  });

  test("a randomized brief shows its axes.ratio subset in its own order", async () => {
    const user = userEvent.setup();
    renderWithRun(
      createElement(BriefSwitcher, {
        brief: { ...BASE, mode: "variation", variation: { axes: { ratio: ["9:16", "1:1"] } } },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Switch" }));
    expect(screen.getByText("9:16, 1:1")).toBeTruthy();
  });

  test("a randomized brief without an axes.ratio selection falls back to every ratio", async () => {
    const user = userEvent.setup();
    renderWithRun(
      createElement(BriefSwitcher, {
        brief: { ...BASE, mode: "variation", variation: { count: 4 } },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Switch" }));
    expect(screen.getByText(ALL_RATIOS)).toBeTruthy();
  });

  test("a randomized brief whose ratio axis is empty falls back to every ratio", async () => {
    const user = userEvent.setup();
    renderWithRun(
      createElement(BriefSwitcher, {
        brief: { ...BASE, mode: "variation", variation: { axes: { ratio: [] } } },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Switch" }));
    // An emptied ratio axis is legal (DESIGN.md §5), and `[].join()` is "" — the readout
    // must show the default set, not a blank field.
    expect(screen.getByText(ALL_RATIOS)).toBeTruthy();
  });

  test("a variation-mode brief with no variation block still falls back to every ratio", async () => {
    const user = userEvent.setup();
    renderWithRun(createElement(BriefSwitcher, { brief: { ...BASE, mode: "variation" } }));
    await user.click(screen.getByRole("button", { name: "Switch" }));
    expect(screen.getByText(ALL_RATIOS)).toBeTruthy();
  });
});

/**
 * The control-boundary token (WCAG 1.4.11): these controls are identified only by
 * their hairline, so it must be `border-border-control` (≥ 3:1 on every ground).
 * jsdom applies no CSS, so the class list is the only observable — split, because
 * `border-border` is a substring of `border-border-control`.
 */
const classes = (el: Element): readonly string[] => el.className.split(/\s+/);

describe("Sidebar — control boundaries carry border-control", () => {
  test("the Browse-briefs button and the clickable asset rows (with their hover)", async () => {
    // listAssets resolves through the shared pipeline fetch router: a GET that is
    // neither a job nor a packages URL answers with the seeded report's assets.
    seedPersistedRun([{ name: "hero.png", type: "image/png", size: 1024 } as unknown as Asset]);
    renderWithRun(createElement(Sidebar));

    const browse = screen.getByRole("button", { name: "Browse briefs" });
    expect(classes(browse)).toContain("border-border-control");
    expect(classes(browse)).not.toContain("border-border");

    const row = (await screen.findByTitle("hero.png")).closest("div.cursor-pointer") as HTMLElement;
    expect(classes(row)).toContain("border-border-control");
    expect(classes(row)).toContain("hover:border-border-control-hover");
    expect(classes(row)).not.toContain("border-border");
    // The 36 px thumbnail rim inside the row stays decorative `border-border`.
    expect(classes(row.querySelector("div.rounded.border") as HTMLElement)).toContain("border-border");
  });
});