import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import * as messages from "../messages";
import { CreativesPanel, type PlannedCreative } from "../CreativesPanel";
import { useVariationPlanResult } from "../variation-plan";

/**
 * The list's own suite — the rows, and the seam that feeds them.
 *
 * What the list DOES is asserted through the editor that ships
 * (`brief-editor.creatives.test.tsx`): the planned slots, the click that loads a
 * creative, the edit that survives a switch. This file covers the two things
 * that suite cannot reach from a realistic plan — a row the planner drew with
 * nothing to say about it, and a consumer mounted outside the provider.
 */

const variant = (over: Partial<PlannedCreative> & { index: number }): PlannedCreative => over;

describe("CreativesPanel — a row with nothing to show but its slot", () => {
  /**
   * Every field but `index` is optional, because `planCampaign` does not
   * validate the variants array (`briefs-api.ts`). A row therefore has to render
   * for a variant that carries only a slot — and it must render the slot, not an
   * empty line where the axes and the headline would go.
   */
  test("renders the slot and no empty lines", () => {
    render(
      <CreativesPanel
        rows={[variant({ index: 4 })]}
        selected={null}
        onSelect={() => {}}
        onDelete={() => {}}
        deletable={false}
      />,
    );

    const row = screen.getByRole("button", { name: messages.creativeRowLabel(4) });
    // The whole row is the label: no summary line, no headline line, nothing
    // that would render as a blank strip under the name.
    expect(row.textContent).toBe(messages.creativeRowLabel(4));
    expect(row.getAttribute("aria-pressed")).toBe("false");
  });

  test("an empty-string headline is not a line either", () => {
    render(
      <CreativesPanel
        rows={[variant({ index: 0, headline: "", layout: "headline-top" })]}
        selected={0}
        onSelect={() => {}}
        onDelete={() => {}}
        deletable={false}
      />,
    );

    const row = screen.getByRole("button", { name: /^Creative 1/ });
    expect(row.textContent).toBe(`${messages.creativeRowLabel(0)}headline-top`);
    expect(row.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("creativeRowSummary", () => {
  test("joins the parts the plan sent and answers empty when it sent none", () => {
    expect(messages.creativeRowSummary({ aspectRatio: "1:1", layout: "headline-top" })).toBe(
      "1:1 · headline-top",
    );
    expect(messages.creativeRowSummary({})).toBe("");
    // An empty string is not a part — a route that sent one would otherwise
    // render a leading separator.
    expect(messages.creativeRowSummary({ aspectRatio: "", tone: "bold" })).toBe("bold");
  });
});

describe("the plan seam", () => {
  const Probe = () => <span>{String(useVariationPlanResult())}</span>;

  test("a consumer outside the provider fails loudly rather than reading a plan that never arrives", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used within a VariationPlanProvider/);
    error.mockRestore();
  });
});
