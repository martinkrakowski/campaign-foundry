import { describe, test, expect } from "vitest";
import { screen } from "@testing-library/react";
import { createElement } from "react";
import userEvent from "@testing-library/user-event";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { renderWithRun } from "@/__tests__/helpers";
import { useRun } from "@/lib/run-context";
import { SidebarContent } from "../Sidebar";

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

  test("a variation-mode brief with no variation block still falls back to every ratio", async () => {
    const user = userEvent.setup();
    renderWithRun(createElement(BriefSwitcher, { brief: { ...BASE, mode: "variation" } }));
    await user.click(screen.getByRole("button", { name: "Switch" }));
    expect(screen.getByText(ALL_RATIOS)).toBeTruthy();
  });
});