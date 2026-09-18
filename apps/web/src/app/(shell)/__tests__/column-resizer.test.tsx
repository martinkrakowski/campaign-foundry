import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import tailwindConfig from "../../../../tailwind.config";
import { useEditorPanelPublisher } from "@/lib/editor-panels-context";
import { RAIL_VIEWPORT_MIN_PX } from "@/lib/use-viewport-min-width";
import { COLUMN_RESIZE_LABEL } from "@/components/shell/ColumnResizeHandle";
import ShellLayout from "../layout";

/**
 * SG2 — the draggable separator between the shell row's middle column and the
 * preview rail.
 *
 * **Measured through `ShellLayout` with a STUB publisher, never through
 * `BriefEditor`.** The claim here is the geometry of the shell row, which the
 * layout owns; that the editor publishes a rail at all is RS2's claim and has its
 * own suite next door. A stub also makes the presence transition something this
 * file can drive on demand rather than something it waits for.
 *
 * Two things in this file are not decoration and were verified before anything
 * was built on them:
 *
 * - **The library's NODE build is a stub.** Every layout effect is stripped from
 *   it, so `Panel` never registers with its group: panels render at their
 *   `defaultSize` and there is no `aria-valuenow`, no keydown listener and no
 *   bound. Vitest runs a project in Vite's SSR environment, so the `node`
 *   condition won this package's `exports` map until `vitest.config.ts` asked
 *   for `browser`. Every assertion below was run against that stub first and
 *   would have been measuring a component that cannot resize.
 * - **Tab order is asserted with `userEvent.tab()`**, which walks real
 *   tabbability. `.focus()` proves nothing about a tab stop: happy-dom focuses a
 *   `tabIndex={-1}` element quite happily.
 */

/** happy-dom's viewport, which its `getComputedStyle` resolves `@media` against. */
const setViewport = (width: number) => {
  (
    window as unknown as { happyDOM: { setViewport: (v: { width: number }) => void } }
  ).happyDOM.setViewport({ width });
};

const RAIL_LABEL = "Stub rail";

/**
 * A view that publishes a rail the way the editor does — from an effect, through
 * the publisher context — and can take it away again.
 */
function StubView({ rail }: { rail: boolean }) {
  const { setRail } = useEditorPanelPublisher();
  useEffect(() => {
    setRail(rail ? { label: RAIL_LABEL, content: <button>rail anchor</button> } : null);
    return () => setRail(null);
  }, [rail, setRail]);
  return <button>main body</button>;
}

/** The handle BY ROLE and NAME — the separator a keyboard user would land on. */
const handle = () => screen.getByRole("separator", { name: COLUMN_RESIZE_LABEL });
const maybeHandle = () =>
  screen.queryByRole("separator", { name: COLUMN_RESIZE_LABEL, hidden: true });
const mainColumn = () => document.querySelector("main") as HTMLElement;
const railColumn = () => document.getElementById("shell-rail-column") as HTMLElement;

/**
 * The panel's own record of its size, which is the number the library writes and
 * the browser lays out from (`flex-grow`, to one decimal). Read from the DOM
 * rather than from a callback: a layout that never reached an element is not a
 * layout.
 */
const sizeOf = (panel: HTMLElement) => Number(panel.getAttribute("data-panel-size"));

const mountWithRail = async (rail = true) => {
  const view = render(
    <ShellLayout>
      <StubView rail={rail} />
    </ShellLayout>,
  );
  await screen.findByText("main body");
  if (rail) await waitFor(() => expect(railColumn()).not.toBeNull());
  return view;
};

async function generateCss(classes: readonly string[]): Promise<string> {
  const html = classes.map((c) => `<div class="${c}"></div>`).join("\n");
  const result = await postcss([
    tailwindcss({ ...tailwindConfig, content: [{ raw: html, extension: "html" }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

/**
 * Puts the compiled CSS in the document so `getComputedStyle` — and
 * testing-library's own accessibility-tree filter — resolve the shipped rules.
 * Removed after each test: a `<style>` in `document.head` survives `cleanup()`,
 * and a leaked one would silently hide the handle in every test that follows.
 */
function applyCss(css: string): void {
  const style = document.createElement("style");
  style.dataset.sg2Css = "";
  style.textContent = css;
  document.head.appendChild(style);
}

beforeEach(() => {
  localStorage.setItem("cf:brief-picked", "1");
  setViewport(1280);
});

afterEach(() => {
  for (const style of document.querySelectorAll("style[data-sg2-css]")) style.remove();
});

describe("red fault 1 — a keyboard user resizes the column", () => {
  test("arrow keys move the split, and the separator reports where it now sits", async () => {
    await mountWithRail();
    const separator = handle();

    // The handle is the window-splitter pattern, wired to the column it moves:
    // without `aria-controls` and `aria-valuenow` a screen-reader user is
    // dragging something that never says where it is.
    expect(separator.getAttribute("aria-controls")).toBe(mainColumn().id);
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(65);
    expect(sizeOf(mainColumn())).toBe(65);
    expect(sizeOf(railColumn())).toBe(35);

    separator.focus();
    expect(document.activeElement).toBe(separator);
    fireEvent.keyDown(separator, { key: "ArrowLeft" });

    // The SPLIT moved — both panels, by the same amount, in the direction the key
    // names. A test that only found the separator, or only read its aria value,
    // would pass against a handle that resizes nothing at all.
    expect(sizeOf(mainColumn())).toBe(55);
    expect(sizeOf(railColumn())).toBe(45);
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(55);

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(sizeOf(mainColumn())).toBe(65);
    expect(sizeOf(railColumn())).toBe(35);
  });
});

describe("red fault 2 — the bounds hold at both extremes", () => {
  /**
   * `Home`/`End` are the splitter pattern's "as far as it goes" keys (a delta of
   * ±100%), so they ask for the collapse the pointer can only approach. The
   * numbers are the two `minSize` props: with either removed the panel on that
   * side goes to 0 and the column the resizer exists to size is gone.
   */
  test("dragging the rail to the far edge leaves it usable, and cannot collapse main", async () => {
    await mountWithRail();
    const separator = handle();
    separator.focus();

    fireEvent.keyDown(separator, { key: "End" });
    expect(sizeOf(railColumn())).toBe(25);
    expect(sizeOf(mainColumn())).toBe(75);

    fireEvent.keyDown(separator, { key: "Home" });
    expect(sizeOf(mainColumn())).toBe(50);
    expect(sizeOf(railColumn())).toBe(50);

    // Neither extreme collapsed anything: said as the property, not as two more
    // numbers, because that is the claim the bound makes.
    for (const key of ["Home", "End", "Home", "End"]) {
      fireEvent.keyDown(separator, { key });
      expect(sizeOf(mainColumn())).toBeGreaterThanOrEqual(50);
      expect(sizeOf(railColumn())).toBeGreaterThanOrEqual(25);
    }
  });
});

describe("red fault 3 — below the breakpoint the handle is not a surface at all", () => {
  test("the compiled gate is a viewport @media at exactly RAIL_VIEWPORT_MIN_PX", async () => {
    await mountWithRail();
    const css = await generateCss([
      ...handle().className.split(/\s+/).filter(Boolean),
      ...railColumn().className.split(/\s+/).filter(Boolean),
    ]);

    // Derived from the same constant the rail's own gate is derived from (RS-D4),
    // so the handle cannot appear at a width where the rail does not.
    expect(css).toContain("display: none");
    const media = [...css.matchAll(/@media\s*\(min-width:\s*(\d+)px\)\s*\{([^}]*\{[^}]*\})/g)].find(
      ([, , body]) => body.includes("display: flex"),
    );
    expect(media).not.toBeUndefined();
    expect(Number(media![1])).toBe(RAIL_VIEWPORT_MIN_PX);
    expect(css).not.toContain("@container");
  });

  test("it reserves no width: the rail's panel is display:none and main keeps the row", async () => {
    await mountWithRail();
    const separator = handle();
    applyCss(
      await generateCss([
        ...separator.className.split(/\s+/).filter(Boolean),
        ...railColumn().className.split(/\s+/).filter(Boolean),
      ]),
    );

    /** A fresh element per read: happy-dom caches a computed style per element. */
    const displayAt = (width: number, className: string) => {
      setViewport(width);
      const probe = document.createElement("div");
      probe.className = className;
      document.body.appendChild(probe);
      return window.getComputedStyle(probe).display;
    };

    expect(displayAt(RAIL_VIEWPORT_MIN_PX, separator.className)).toBe("flex");
    expect(displayAt(RAIL_VIEWPORT_MIN_PX - 1, separator.className)).toBe("none");
    // The panel, not only the handle. A panel that still reserved its 35% would
    // hold a strip of nothing beside a rail nobody can see — and `display: none`
    // is what takes it out of the flex row, so `main`'s flex-grow takes the width
    // back rather than sharing it with an empty box.
    expect(displayAt(RAIL_VIEWPORT_MIN_PX, railColumn().className)).toBe("flex");
    expect(displayAt(RAIL_VIEWPORT_MIN_PX - 1, railColumn().className)).toBe("none");
  });

  test("it is not a tab stop below the breakpoint, by either half of the gate", async () => {
    const user = userEvent.setup();
    await mountWithRail();

    /**
     * `userEvent.tab()` walks real tabbability — it honours `tabIndex={-1}` —
     * which is the property being claimed. `separator.focus()` would answer a
     * different question and answer it "yes" in both cases: happy-dom focuses a
     * `tabIndex={-1}` element quite happily.
     *
     * Backwards from the rail's own control, rather than forwards from the top of
     * the document: the separator's only forward neighbour is the rail, so one
     * shift-tab is the whole question. (Walking the shell from the top costs ~40
     * tabs through the sidebar's template list and proves nothing more.)
     */
    const shiftTabFromRail = async () => {
      screen.getByText("rail anchor").focus();
      await user.tab({ shift: true });
      return document.activeElement;
    };

    // Liveness first, and the stop BEFORE it: at 1280 the separator is in the tab
    // order, between the rail's control and the main column's last one.
    const separator = handle();
    expect(await shiftTabFromRail()).toBe(separator);
    await user.tab({ shift: true });
    const stopBeforeTheSeparator = document.activeElement;
    expect(stopBeforeTheSeparator).not.toBe(separator);

    // The JS half, alone: no CSS is loaded in this test, so the only thing that
    // can keep the separator out of the tab order is `tabIndex={-1}` from the
    // viewport mirror. `disabled` does NOT do it — the library defaults tabIndex
    // to 0 and passes it straight through, which is the dead 6px tab stop this
    // fault is about.
    setViewport(1000);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(maybeHandle()?.getAttribute("tabindex")).toBe("-1"));

    // Said as the exact shape of the claim: the tab order below the breakpoint is
    // the tab order above it with the separator taken out — the same shift-tab
    // now skips straight to the stop beyond it. Derived from the walk above, so
    // no element is named twice.
    expect(await shiftTabFromRail()).toBe(stopBeforeTheSeparator);

    // And the behaviour, for a handle that somehow held focus anyway: `disabled`
    // is what stops the library registering its keydown listener, so the arrow
    // key that moved the split at 1280 moves nothing here.
    const before = sizeOf(mainColumn());
    separator.focus();
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(sizeOf(mainColumn())).toBe(before);
  });

  test("the rail is still MOUNTED below the breakpoint — the gate hides, it does not unmount", async () => {
    // D43's invariant, which is why the gate cannot simply skip the panel: the
    // rail must survive a narrow viewport so a resize back does not pay a fresh
    // mount. Read from the DOM, because at this width the landmark is genuinely
    // out of the accessibility tree.
    await mountWithRail();
    setViewport(1000);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(maybeHandle()?.getAttribute("tabindex")).toBe("-1"));
    expect(document.querySelector(`aside[aria-label="${RAIL_LABEL}"]`)).not.toBeNull();
    expect(railColumn()).not.toBeNull();
  });
});

describe("red fault 4 — the presence transition is clean", () => {
  test("rail absent → present → absent leaves no orphan handle and no stranded split", async () => {
    const view = await mountWithRail(false);
    const separators = () => document.querySelectorAll('[role="separator"]').length;

    // Absent: one panel, no separator, and `main` holds the whole row. A handle
    // rendered here would be a 16px strip that tabs into focus and resizes
    // nothing — there is no second column for it to move.
    //
    // `1`, not `100`: with a single panel the library stops apportioning and
    // writes `flex-grow: 1`, which is the same rendered width by a different
    // route. Asserted with the panel COUNT beside it, so "the whole row" cannot
    // be satisfied by a second panel that merely happens to be tiny.
    expect(railColumn()).toBeNull();
    expect(separators()).toBe(0);
    expect(document.querySelectorAll("[data-panel]")).toHaveLength(1);
    expect(sizeOf(mainColumn())).toBe(1);
    expect(mainColumn().style.flexGrow).toBe("1");
    const firstMain = mainColumn();

    view.rerender(
      <ShellLayout>
        <StubView rail={true} />
      </ShellLayout>,
    );
    await waitFor(() => expect(railColumn()).not.toBeNull());
    expect(separators()).toBe(1);
    expect(sizeOf(mainColumn())).toBe(65);
    expect(sizeOf(railColumn())).toBe(35);
    // The default split, not a layout the library improvised from reassigned
    // panel ids: `order` is explicit for exactly this transition.
    expect(Number(handle().getAttribute("aria-valuenow"))).toBe(65);

    view.rerender(
      <ShellLayout>
        <StubView rail={false} />
      </ShellLayout>,
    );
    await waitFor(() => expect(railColumn()).toBeNull());
    expect(separators()).toBe(0);
    // Back to the whole row, with no stranded 35% where the rail used to be.
    expect(document.querySelectorAll("[data-panel]")).toHaveLength(1);
    expect(sizeOf(mainColumn())).toBe(1);

    // And `main` was never remounted through any of it. This is the load-bearing
    // half: if the row's shape branched on the rail's presence, the editor's own
    // subtree would be torn down on the commit after it publishes — and it
    // publishes from an effect, so the remount would publish again.
    expect(mainColumn()).toBe(firstMain);
    expect(screen.getByText("main body")).toBeTruthy();
  });

  test("a second appearance returns to the default split, not to the last one", async () => {
    const view = await mountWithRail();
    const separator = handle();
    separator.focus();
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(sizeOf(railColumn())).toBe(45);

    view.rerender(
      <ShellLayout>
        <StubView rail={false} />
      </ShellLayout>,
    );
    await waitFor(() => expect(railColumn()).toBeNull());
    view.rerender(
      <ShellLayout>
        <StubView rail={true} />
      </ShellLayout>,
    );
    await waitFor(() => expect(railColumn()).not.toBeNull());

    // The rail is a fresh column each time it is published, so it arrives at the
    // width the shell chose — never at a width some earlier view left behind.
    expect(sizeOf(railColumn())).toBe(35);
    expect(sizeOf(mainColumn())).toBe(65);
  });
});

describe("red fault 5 — nothing persists (SG-D3)", () => {
  test("a remount starts at the default split, and the resize writes no storage", async () => {
    const view = await mountWithRail();
    const separator = handle();
    separator.focus();
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(sizeOf(railColumn())).toBe(45);
    const keysDuring = Object.keys({ ...localStorage });

    // Longer than the library's 100ms save debounce, so a width that WOULD have
    // been written has been. Without this wait an `autoSaveId` could be added and
    // this test would still pass — the vacuous shape this lane was warned about.
    await new Promise((r) => setTimeout(r, 300));
    view.unmount();

    render(
      <ShellLayout>
        <StubView rail={true} />
      </ShellLayout>,
    );
    await waitFor(() => expect(railColumn()).not.toBeNull());
    expect(sizeOf(railColumn())).toBe(35);
    expect(sizeOf(mainColumn())).toBe(65);

    // And nothing was written under any key: a pane width is not a property of
    // the campaign, and a persisted one surprises the next operator to open the
    // same brief (SG-D3, D147's reasoning for timeline zoom).
    expect(Object.keys({ ...localStorage })).toEqual(keysDuring);
    expect(localStorage.getItem("react-resizable-panels:shell")).toBeNull();
  });
});
