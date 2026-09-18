import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRun } from "@/__tests__/helpers";
import { TelemetryDrawer, TELEMETRY_DRAWER_ID } from "../TelemetryDrawer";

/**
 * LP1 moved the drawer's chrome into `LogPanel` (SG-D21). A refactor that
 * declares no behaviour change has to prove it, so this file pins the drawer's
 * own root — the part that did NOT move — against what it rendered before.
 *
 * **On the strength of the claim.** RS1's standard was byte-identical markup,
 * and this is deliberately one step weaker: the class *set* rather than the
 * class *string*. The surface tokens now arrive from `LOG_PANEL_SURFACE` and
 * the instance tokens from this component, so `cn()` emits them in a different
 * order than the single literal did. The order carries no meaning here — none
 * of these tokens compete for the same CSS property, so the computed style is
 * unchanged — but a string compare would fail on it, and weakening the
 * assertion quietly to make it pass would be the wrong way round. Said out
 * loud instead: same tokens, same structure, order not asserted.
 */
const EXPECTED_ROOT_TOKENS = [
  "-translate-x-1/2",
  "absolute",
  "bg-surface",
  "border",
  "border-border",
  "bottom-24",
  "duration-300",
  "flex",
  "flex-col",
  "h-48",
  "left-1/2",
  "max-w-[800px]",
  "opacity-100",
  "overflow-hidden",
  "rounded-xl",
  "shadow-2xl",
  "transition-all",
  "w-full",
  "z-10",
] as const;

const root = (): HTMLElement => document.getElementById(TELEMETRY_DRAWER_ID) as HTMLElement;

describe("TelemetryDrawer — the chrome survived the extraction (LP1)", () => {
  test("the open drawer's root carries exactly the classes it carried before", () => {
    renderWithRun(<TelemetryDrawer open onClose={() => {}} />);

    const tokens = [...root().classList].sort();
    expect(tokens).toEqual([...EXPECTED_ROOT_TOKENS]);
  });

  test("its id, and the two state attributes, are still on that same root", () => {
    renderWithRun(<TelemetryDrawer open onClose={() => {}} />);
    const el = root();

    // The id is the contract `Header.tsx` names with `aria-controls`, so it has
    // to be on the drawer's own root and not on some new wrapper.
    expect(el.id).toBe(TELEMETRY_DRAWER_ID);
    expect(el.getAttribute("aria-hidden")).toBe("false");
    expect(el.hasAttribute("inert")).toBe(false);
  });

  test("the closed drawer is inert and hidden — the tab order is unchanged", () => {
    renderWithRun(<TelemetryDrawer open={false} onClose={() => {}} />);
    const el = root();

    // `inert` is what removes the drawer's buttons from the tab order while it
    // is collapsed-but-mounted for the slide animation; `aria-hidden` alone
    // would not. Both belong to the instance, so both had to stay behind when
    // the chrome left — this is the assertion that catches them leaving with it.
    expect(el.hasAttribute("inert")).toBe(true);
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect([...el.classList]).toContain("h-0");
  });

  test("it is one element deep: the root IS the panel, not a wrapper around it", () => {
    renderWithRun(<TelemetryDrawer open onClose={() => {}} />);

    // The panel owns the root so the extraction adds no box. A wrapper would
    // still look right and still pass every text assertion, while quietly
    // changing what `absolute`/`h-48` are positioning.
    const children = [...root().children];
    expect(children).toHaveLength(2);
    expect(screen.getByText("System Telemetry Stream").closest("div")).toBe(children[0]);
  });
});
