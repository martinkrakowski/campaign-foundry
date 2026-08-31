import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { ReviewStep } from "../ReviewStep";
import { SECTION_TITLES, sectionOrder } from "../sections";
import * as messages from "../messages";

/**
 * The review step's rows are generated from the projection handed to it — a
 * `toBrief` result, exactly what Apply and Save send (W8.1). These tests feed
 * `ReviewStep` projection-shaped briefs directly, so every branch of the row
 * generation is exercised against the contract, not against the editor.
 */

/** A classic brief carrying everything a row can show. */
const classic: CampaignBrief = {
  id: "summer-launch",
  targetRegion: "EU",
  targetAudience: "urban explorers",
  campaignMessage: "Stay wild",
  products: [
    { id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" },
    { id: "beta", name: "Beta", primaryColor: "#E0218A", logoPath: "b.png" },
  ],
  treatments: [{ id: "bold-hero", layout: "headline-top", tone: "bold" }],
  output: { formats: ["static"], platforms: ["linkedin"] },
};

/** The row container for one section — the review step's own list, not the sidebar's. */
const row = (section: string) => document.querySelector(`[data-review-row="${section}"]`);

const renderRows = (brief: CampaignBrief) => {
  const onEdit = vi.fn();
  const view = render(<ReviewStep brief={brief} onEdit={onEdit} />);
  // A second render in the same test must not stack a second copy — `row()`
  // reads the document, and only the first mounted copy would be found.
  return { onEdit, unmount: view.unmount };
};

describe("ReviewStep — summary rows", () => {
  test("one row per section the projection carries, titled by the one vocabulary", () => {
    renderRows(classic);
    for (const section of sectionOrder("brief")) {
      expect(row(section)).not.toBeNull();
      expect(row(section)?.textContent).toContain(SECTION_TITLES[section]);
    }
  });

  test("each row's Edit hands the row's section to the reveal", async () => {
    const user = userEvent.setup();
    const { onEdit } = renderRows(classic);
    for (const section of sectionOrder("brief")) {
      await user.click(screen.getByRole("button", { name: messages.reviewEditLabel(SECTION_TITLES[section]) }));
      expect(onEdit).toHaveBeenCalledWith(section);
    }
  });

  test("the output row speaks display names, never raw format or platform ids", () => {
    renderRows(classic);
    expect(row("output")?.textContent).toContain("Still images");
    expect(row("output")?.textContent).toContain("LinkedIn");
    expect(row("output")?.textContent).not.toContain("static");
    expect(row("output")?.textContent).not.toContain("linkedin");
  });

  test("a row whose field the projection omits does not render", () => {
    // No treatments, default output, classic mode: toBrief drops all three.
    const bare: CampaignBrief = {
      id: "bare",
      targetRegion: "EU",
      targetAudience: "urban explorers",
      campaignMessage: "Stay wild",
      products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }],
    };
    renderRows(bare);
    expect(row("identity")).not.toBeNull();
    expect(row("copy")).not.toBeNull();
    expect(row("products")).not.toBeNull();
    expect(row("treatments")).toBeNull();
    expect(row("output")).toBeNull();
    expect(row("policy")).toBeNull();
  });

  test("an empty treatments list draws no treatments row rather than a blank one", () => {
    renderRows({ ...classic, treatments: [] });
    expect(row("treatments")).toBeNull();
  });

  test("an empty formats or platforms list draws no output row rather than a blank one", () => {
    const emptyFormats = renderRows({ ...classic, output: { formats: [], platforms: ["linkedin"] } });
    expect(row("output")).toBeNull();
    emptyFormats.unmount();
    renderRows({ ...classic, output: { formats: ["static"], platforms: [] } });
    expect(row("output")).toBeNull();
  });

  test("an output block missing either list draws no output row rather than a half row", () => {
    const missingPlatforms = renderRows({ ...classic, output: {} });
    expect(row("output")).toBeNull();
    missingPlatforms.unmount();
    renderRows({ ...classic, output: { formats: ["static"] } });
    expect(row("output")).toBeNull();
  });

  test("the localized headline is a line only when the projection carries it", () => {
    const first = renderRows(classic);
    expect(row("copy")?.textContent).not.toContain("Localized Message");
    first.unmount();
    renderRows({ ...classic, localizedMessage: "Bleib wild" });
    expect(row("copy")?.textContent).toContain(`${messages.reviewRowLocalizedMessage}: Bleib wild`);
  });

  test("a variation brief walks the randomized order and shows the policy row", () => {
    const randomized: CampaignBrief = {
      ...classic,
      treatments: undefined,
      mode: "variation",
      variation: { count: 8, axes: { layout: ["headline-bottom"], tone: ["subtle"] } },
    };
    renderRows(randomized);
    expect(row("policy")).not.toBeNull();
    expect(row("policy")?.textContent).toContain(messages.reviewPolicyValue(8));
    expect(row("treatments")).toBeNull();
  });

  test("the policy row reads as one ad when the count is one", () => {
    renderRows({
      ...classic,
      treatments: undefined,
      mode: "variation",
      variation: { count: 1, axes: { layout: ["headline-top"], tone: ["bold"] } },
    });
    expect(row("policy")?.textContent).toContain(messages.reviewPolicyValue(1));
  });

  test("a variation block without a count draws no policy row rather than a zero one", () => {
    renderRows({ ...classic, mode: "variation", variation: {} });
    expect(row("policy")).toBeNull();
  });
});

describe("ReviewStep — the preview (D26)", () => {
  test("the creative beside the rows draws the brief's headline and names the ratio and platform", () => {
    renderRows(classic);
    const svg = document.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.textContent).toContain("Stay wild");
    // linkedin's own ratio is 1:1 — Square, in display names (D18).
    expect(screen.getByText(messages.previewCaption("Square", "LinkedIn"))).toBeTruthy();
  });

  test("no product, no creative: the projection has nothing to draw", () => {
    renderRows({ ...classic, products: [] });
    expect(document.querySelector("svg")).toBeNull();
  });

  test("no platform picked yet: the caption says so instead of inventing one", () => {
    renderRows({ ...classic, output: undefined });
    expect(screen.getByText(messages.previewCaption("Square", messages.previewNoPlatform))).toBeTruthy();
  });

  test("a motion brief previews the axis's own motion kind", () => {
    const motionBrief: CampaignBrief = {
      ...classic,
      treatments: undefined,
      mode: "variation",
      variation: {
        count: 8,
        axes: {
          layout: ["headline-bottom"],
          tone: ["subtle"],
          motion: ["ken-burns-in"],
          background: { source: ["procedural"] },
          paletteShift: [0],
        },
      },
      output: { formats: ["static", "motion"], platforms: ["instagram-reel"] },
    };
    renderRows(motionBrief);
    const ground = document.querySelector("svg g") as SVGGElement | null;
    expect(ground?.getAttribute("class")).toContain("kf-ken-burns-in");
  });

  test("a static brief plays nothing: the preview is a still", () => {
    renderRows(classic);
    const ground = document.querySelector("svg g") as SVGGElement | null;
    expect(ground?.getAttribute("class") ?? "").not.toContain("animate-");
  });
});
