import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ShellProviders } from "@/__tests__/helpers";
import { Sidebar } from "../Sidebar";
import { SidebarShell } from "../SidebarShell";
import * as briefsApi from "@/lib/briefs-api";

/**
 * RS1's red fault: **the left sidebar's rendered markup is unchanged.**
 *
 * The extraction exists so the right-hand column can wear the same container
 * instead of a second, drifting copy of it — a lane that also "tidies" a class
 * while extracting has changed behaviour it did not declare. That is not a
 * hypothetical: the right rail's own container had drifted to 256px, a bare
 * `border-l`, and a CONTAINER query resolving to 1264px of viewport where this
 * column's `lg:` is 1024px.
 *
 * So the class string is asserted as a LITERAL, not derived from the component
 * under test (which would pass for any string), and the attribute list is
 * asserted too — an extraction that quietly added a `role` or an `aria-label` to
 * the left sidebar would change its accessibility tree while every class
 * assertion stayed green.
 */
const LEFT_SIDEBAR_CLASS =
  "relative z-10 hidden h-full w-[320px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl lg:flex";

describe("SidebarShell — RS1's identical-markup proof", () => {
  test("the left sidebar renders the same <aside>, with the same class and no other attribute", async () => {
    vi.spyOn(briefsApi, "listAssets").mockResolvedValue({ assets: [] });
    render(
      <ShellProviders>
        <Sidebar />
      </ShellProviders>,
    );
    await waitFor(() => expect(screen.getByText("Campaign Brief")).toBeTruthy());

    const aside = document.querySelector("aside") as HTMLElement;
    expect(aside).not.toBeNull();
    expect(aside.tagName).toBe("ASIDE");
    expect(aside.className).toBe(LEFT_SIDEBAR_CLASS);
    expect(aside.getAttributeNames()).toEqual(["class"]);
  });

  test("the shell itself is that chrome and nothing else — it wraps its children in place", () => {
    const { container } = render(
      <SidebarShell>
        <p>panel body</p>
      </SidebarShell>,
    );
    const aside = container.firstElementChild as HTMLElement;
    expect(aside.tagName).toBe("ASIDE");
    expect(aside.className).toBe(LEFT_SIDEBAR_CLASS);
    expect(aside.getAttributeNames()).toEqual(["class"]);
    // One wrapper, not two: the children are the aside's own, so a column's
    // scroll container and its footer stay direct flex children of the panel.
    expect(aside.children).toHaveLength(1);
    expect(aside.firstElementChild?.textContent).toBe("panel body");
  });

  /**
   * The three properties the right-hand column is about to inherit, pinned where
   * the definition lives rather than at each call site — `h-full` (a column can
   * only be browser-height as a child of the shell's flex row; `sticky
   * max-h-screen` inside `main`'s scroller never can), the VIEWPORT gate, and
   * the fact that the gate hides without unmounting.
   */
  test("the gate is a viewport breakpoint and the panel is full height", () => {
    const { container } = render(
      <SidebarShell>
        <p>body</p>
      </SidebarShell>,
    );
    const aside = container.firstElementChild as HTMLElement;
    expect(aside.className).toContain("lg:flex");
    expect(aside.className).toContain("hidden");
    expect(aside.className).toContain("h-full");
    // The rail's old spelling, which cannot be full height inside a scroller and
    // whose container query is the 240px band this lane deletes.
    expect(aside.className).not.toContain("@container");
    expect(aside.className).not.toMatch(/\bsticky\b/);
    expect(aside.className).not.toContain("max-h-screen");
    expect(aside.className).not.toMatch(/\bw-64\b/);
  });
});
