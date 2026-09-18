import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, memo, type ComponentType } from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import tailwindConfig from "../../../../tailwind.config";
import { json, nextMock } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { RAIL_VIEWPORT_MIN_PX } from "@/lib/use-viewport-min-width";
import { useMobileRail } from "@/lib/mobile-rail-context";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import * as messages from "@/components/campaign/messages";
import { BriefEditor } from "@/components/campaign/BriefEditor";
import type { LayerStackProps } from "@/components/campaign/LayerStack";
import type { TimelineTapeProps } from "@/components/campaign/TimelineTape";
import type { PreviewShowcaseProps } from "@/components/campaign/PreviewDock";
import ShellLayout from "../layout";

/**
 * RS2 — the preview rail as a column of the shell row.
 *
 * Everything here is measured through `ShellLayout`, not through the editor plus
 * a test outlet, because the shape is the claim: the rail's children are built by
 * `BriefEditor` and rendered in a subtree that is a SIBLING of `<main>`, crossing
 * a context boundary as a prop. CC1/CC2's cost contract, CC3's and TS1's
 * re-render assertions and D43's mount count were all measured with those
 * children inside the editor's own subtree, so this file re-proves them in the
 * published shape rather than inheriting them (the plan's §5).
 */

/** Renders of the editor's form, so "the form woke up" is a number. */
const formRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/components/campaign/sections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/campaign/sections")>();
  const counted = <P extends object>(Inner: ComponentType<P>): ComponentType<P> =>
    function Counted(props: P) {
      formRenders.count += 1;
      return createElement(Inner, props);
    };
  // One always-mounted section, deliberately: counting every section would turn
  // one commit into "one commit x however many sections this mode renders".
  return { ...actual, IdentitySection: counted(actual.IdentitySection) };
});

/**
 * The three surfaces the rail carries, each behind a `memo` boundary over exactly
 * the props `BriefEditor` hands it. "It re-rendered" then becomes a number — the
 * half of CC1/CC2's contract that no fetch count can see, because
 * `usePreviewFrame` has a content key of its own and does not care how often its
 * component is entered. #469 regressed precisely there with every network
 * assertion green.
 */
const stackRenders = vi.hoisted(() => ({ count: 0 }));
const tapeRenders = vi.hoisted(() => ({ count: 0 }));
const dockRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/components/campaign/LayerStack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/campaign/LayerStack")>();
  const Counting = memo(function CountingStack(props: LayerStackProps) {
    stackRenders.count += 1;
    return createElement(actual.LayerStack, props);
  });
  return { ...actual, LayerStack: Counting };
});

vi.mock("@/components/campaign/TimelineTape", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/campaign/TimelineTape")>();
  const Counting = memo(function CountingTape(props: TimelineTapeProps) {
    tapeRenders.count += 1;
    return createElement(actual.TimelineTape, props);
  });
  return { ...actual, TimelineTape: Counting };
});

vi.mock("@/components/campaign/PreviewDock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/campaign/PreviewDock")>();
  const Counting = memo(function CountingDock(props: PreviewShowcaseProps) {
    dockRenders.count += 1;
    return createElement(actual.PreviewDock, props);
  });
  return { ...actual, PreviewDock: Counting };
});

/** The map paints hundreds of SVG nodes per mount and has its own suite. */
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, WorldMap: () => <div data-testid="world-map-stub" /> };
});

const DURATION_SEC = 6;

/**
 * A motion draft whose LOOK is fully specified — both halves matter. Without
 * `layout`/`tone` the frame's `cell` is never built and NOTHING fetches, so "zero
 * calls after the keystroke" would agree with "zero calls before" for a reason
 * that has nothing to do with the memo boundary: the vacuous proof this lane is
 * warned about. Without `motion` there is no tape to count.
 */
const railBrief = {
  schemaVersion: 1,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "clip",
  mode: "variation",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
  copy: {
    timeline: {
      beats: [
        { text: "First beat", weight: 1 },
        { text: "Second beat", weight: 1 },
      ],
      transition: "cut",
      keyBeat: 1,
    },
  },
  variation: {
    count: 4,
    axes: {
      layout: ["headline-bottom"],
      tone: ["bold"],
      background: { source: ["procedural"] },
      motion: ["ken-burns-in"],
      duration: [DURATION_SEC],
    },
  },
  output: { formats: ["static", "motion"], platforms: ["linkedin"] },
};

type Call = { url: string; method: string };

const routes = (): Call[] => {
  const calls: Call[] = [];
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: u, method });
    if (method === "GET" && u === `${API}/campaigns/capabilities`) {
      return Promise.resolve(json({ motion: true }));
    }
    if (method === "GET" && u.startsWith(`${API}/campaigns/briefs`)) {
      return Promise.resolve(
        json({ briefs: [{ file: "clip.yaml", revision: "r1", brief: railBrief }] }),
      );
    }
    if (u.includes("/campaigns/preview-frame")) {
      return Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/png", "x-preview-frame-cache-key": "k".repeat(64) },
        }),
      );
    }
    return Promise.resolve(json({}, 200));
  });
  return calls;
};

const frameCalls = (calls: readonly Call[]) =>
  calls.filter((c) => c.url.includes("/campaigns/preview-frame"));

/** Longer than PREVIEW_FRAME_DEBOUNCE_MS, so a request that WOULD be issued has been. */
const settle = () => new Promise((r) => setTimeout(r, 400));

/**
 * happy-dom's viewport, which its `getComputedStyle` resolves `@media` against —
 * `window.innerWidth` set by hand does not reach it (measured; the first draft of
 * this file read `flex` at 1023 because of exactly that). Setting the viewport
 * moves BOTH, so the CSS gate and its JS mirror are driven by one lever here.
 *
 * Worth naming: happy-dom's DEFAULT viewport is 1024, which is now the breakpoint
 * itself, where the retired container mirror's 896 had 128px of slack. Nothing
 * rests on the coincidence — every fetch-dependent test asserts the mount's own
 * request actually happened (`toBeGreaterThan(0)`) before counting anything, so a
 * default that drifted below the gate would fail loudly rather than turn those
 * proofs vacuous.
 */
const setViewport = (width: number) => {
  (
    window as unknown as { happyDOM: { setViewport: (v: { width: number }) => void } }
  ).happyDOM.setViewport({ width });
};

/** The rail, BY LANDMARK — never by path, and never by a class or a test id. */
const rail = () => screen.getByRole("complementary", { name: messages.previewLegend });
const maybeRail = () => screen.queryByRole("complementary", { name: messages.previewLegend });
/** D43's count: composed frames MOUNTED, since neither gate unmounts. */
const mountedFrameCount = () => document.querySelectorAll('[data-testid="preview-frame"]').length;

const mountShellWithEditor = async () => {
  const calls = routes();
  render(
    <ShellLayout>
      <BriefEditor briefId="clip" />
    </ShellLayout>,
  );
  await waitFor(() =>
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"),
  );
  await waitFor(() => expect(maybeRail()).not.toBeNull());
  await settle();
  // The mount's own fetch actually happened: a zero here would make every "no
  // further calls" assertion below vacuous.
  //
  // `waitFor`, not a bare assertion after `settle()`: this one FLAKED in CI
  // (run 35307163168, `expected 0 to be greater than 0`) while passing on a
  // second run of the identical commit and locally. `settle()` is a fixed 400ms,
  // and on a loaded runner the mount's fetch had not been issued inside it. The
  // condition here becomes true rather than starting true, which is exactly what
  // `waitFor` is for — and note the contrast with the vacuity trap: waiting on
  // an ALREADY-true condition resolves on the first tick and proves nothing,
  // which is why the "no further calls" assertions below stay bare.
  await waitFor(() => expect(frameCalls(calls).length).toBeGreaterThan(0));
  return calls;
};

/**
 * Puts the compiled CSS in the document, so `getComputedStyle` — and
 * testing-library's own accessibility-tree filter — resolve the shipped rules.
 * Removed after each test: a `<style>` appended to `document.head` survives
 * `cleanup()`, and a leaked one silently hides the rail in every test that
 * follows (it did, on the first run of this file).
 */
function applyCss(css: string): void {
  const style = document.createElement("style");
  style.dataset.railCss = "";
  style.textContent = css;
  document.head.appendChild(style);
}

async function generateCss(classes: readonly string[]): Promise<string> {
  const html = classes.map((c) => `<div class="${c}"></div>`).join("\n");
  const result = await postcss([
    tailwindcss({ ...tailwindConfig, content: [{ raw: html, extension: "html" }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

afterEach(() => {
  for (const style of document.querySelectorAll("style[data-rail-css]")) style.remove();
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("cf:brief-picked", "1");
  setViewport(1280);
  formRenders.count = 0;
  stackRenders.count = 0;
  tapeRenders.count = 0;
  dockRenders.count = 0;
});

describe("RS-D3 — the column is revealed by content, never by the route", () => {
  /**
   * The decisive test, and the one that would have caught what shipped: the path
   * IS the editor's route and nothing publishes a rail, so there must be no
   * landmark. A route check passes this by being right about the route and wrong
   * about the content — which is exactly the empty 256px strip that shipped.
   */
  test("on /brief/new with no editor mounted, there is no rail at all", async () => {
    nextMock().nav.pathname = "/brief/new";
    routes();
    render(
      <ShellLayout>
        <div>workspace</div>
      </ShellLayout>,
    );
    await waitFor(() => expect(screen.getByText("workspace")).toBeTruthy());
    await settle();
    expect(maybeRail()).toBeNull();
    // Not "no rail because no aside": the left sidebar's landmark is there, so
    // this is the absence of the RIGHT column and not of the shell row.
    expect(document.querySelectorAll("aside")).toHaveLength(1);
  });

  test("an editor mounted on a path the shell knows nothing about still gets its rail", async () => {
    // `/grid` is the orchestrator's route. The shell carries no route list, so a
    // view that publishes a rail is placed wherever it is rendered — this is the
    // property a route check cannot have, and the reason a later view needs no
    // edit in the layout.
    nextMock().nav.pathname = "/grid";
    await mountShellWithEditor();
    expect(rail()).toBeTruthy();
  });

  test("the rail is present on /brief/new when the editor is, and goes when the editor does", async () => {
    nextMock().nav.pathname = "/brief/new";
    const view = render(
      <ShellLayout>
        <BriefEditor />
      </ShellLayout>,
    );
    await waitFor(() => expect(maybeRail()).not.toBeNull());

    /**
     * The shell STAYS MOUNTED and only the page swaps — which is what a client
     * navigation from `/brief/x` to `/grid` actually is, and the only shape in
     * which `BriefEditor`'s `setRail(null)` cleanup is load-bearing.
     *
     * This test used to call `view.unmount()`, and that could not fail: it tore
     * down `EditorPanelsProvider` along with the editor, so the aside went away
     * because the state holding it was gone, not because the editor had cleared
     * its slot. Deleting the cleanup left it green — and left the whole web
     * project green. Caught in review; `rs.json` now carries the deletion, and
     * the defect it hides is a stale rail beside the grid whose `LayerStack`
     * dispatches into an unmounted reducer.
     */
    view.rerender(
      <ShellLayout>
        <div>grid</div>
      </ShellLayout>,
    );
    expect(screen.getByText("grid")).toBeTruthy();
    expect(maybeRail()).toBeNull();
  });

  test("a route whose brief does not exist publishes no rail beside the M3 message", async () => {
    // The other half of the same gate (`:setRail(null)` on the not-found and
    // failed-listing branches). The order is what makes it a real test: the
    // editor mounts on the blank draft and publishes a rail, and only when the
    // listing comes back WITHOUT this id does `unknownId` become non-null — so a
    // gate that merely `return`ed would leave that first rail on screen beside
    // "no such brief", previewing a draft the page is not offering to edit.
    nextMock().nav.pathname = "/brief/nope";
    routes();
    render(
      <ShellLayout>
        <BriefEditor briefId="nope" />
      </ShellLayout>,
    );
    await waitFor(() => expect(screen.getByText(messages.briefNotFound("nope"))).toBeTruthy());
    await settle();
    expect(maybeRail()).toBeNull();
    // Absent, not merely hidden: the slot is empty, so there is no second
    // complementary column in the row at all.
    expect(document.querySelectorAll("aside")).toHaveLength(1);
  });

  test("the rail's landmark carries its own name, so two complementary columns are distinguishable", async () => {
    await mountShellWithEditor();
    const asides = [...document.querySelectorAll("aside")];
    expect(asides).toHaveLength(2);
    const named = asides.filter((el) => el.getAttribute("aria-label") !== null);
    expect(named).toHaveLength(1);
    expect(named[0].getAttribute("aria-label")).toBe(messages.previewLegend);
    // The left sidebar is unnamed and unchanged (RS1's red fault), so the name is
    // not simply "whichever aside came second".
    expect(asides[0].getAttribute("aria-label")).toBeNull();
  });
});

describe("RS-D1 — the rail is a column of the shell row, full height", () => {
  test("it is a sibling of <main> and of the left sidebar, not a descendant of either", async () => {
    await mountShellWithEditor();
    const aside = rail();
    const main = document.querySelector("main") as HTMLElement;
    const left = document.querySelectorAll("aside")[0];
    const row = left.parentElement as HTMLElement;

    /**
     * SG2 put the resizable pair inside a `PanelGroup`, so the rail's aside and
     * `<main>` are siblings ONE level below the row rather than in it — and the
     * group is the row's flex child, beside the left sidebar. The claim is
     * unchanged and is asserted the same way: the rail is not in `main`'s
     * scroller, and every box between it and the row is a full-height flex
     * child, which is what "the rail is a column of the shell row" means. Only
     * the depth moved; SG2's own suite covers why the group is there.
     */
    const railColumn = aside.parentElement as HTMLElement;
    const group = main.parentElement as HTMLElement;
    expect(railColumn.parentElement).toBe(group);
    expect(group.parentElement).toBe(row);
    expect(left.parentElement).toBe(row);
    // The position that matters: inside `main`'s scroller — where the rail used
    // to live, three levels down — `h-full` means "as tall as the scrolled
    // content", so the column could never be browser height.
    expect(main.contains(aside)).toBe(false);
    expect([...row.children]).toEqual([left, group]);
    // Left to right, and nothing else between them: the handle is the only thing
    // SG2 added to the row, and it sits between the two columns.
    expect([...group.children]).toEqual([main, screen.getByRole("separator"), railColumn]);
  });

  test("its box is the row's height, and it does not pin itself against a scrollport", async () => {
    await mountShellWithEditor();
    const aside = rail();
    applyCss(await generateCss(aside.className.split(/\s+/).filter(Boolean)));

    // `h-full` against a flex row that is itself `flex-1 overflow-hidden`: the
    // column is as tall as the row, which is as tall as the shell below the
    // header. Compiled from the class string that ships, not asserted as a class
    // name — a class that compiles to nothing looks identical to one that works.
    expect(window.getComputedStyle(aside).height).toBe("100%");
    // The old spelling, which is what "full height" had to be faked with inside a
    // scroller. `fixed` was the regression that covered the sidebar (D44).
    expect(aside.className).not.toMatch(/\bsticky\b/);
    expect(aside.className).not.toMatch(/\bfixed\b/);
    expect(aside.className).not.toContain("max-h-screen");
  });

  test("it wears the left sidebar's container: 320px and panel chrome, not 256px and a border-l", async () => {
    await mountShellWithEditor();
    const aside = rail();
    const left = document.querySelectorAll("aside")[0];
    // One definition, so the two cannot drift. Compared class-for-class rather
    // than by naming the properties: the divergence this lane deletes was three
    // separate classes drifting one at a time.
    expect(aside.className).toBe(left.className);
    expect(aside.className).toContain("w-[320px]");
    expect(aside.className).not.toMatch(/\bw-64\b/);
    expect(aside.className).not.toMatch(/\bborder-l\b/);
  });
});

describe("the gate is the shell's viewport breakpoint — 1024 present, 1023 absent", () => {
  /**
   * The boundary, evaluated against the CSS that actually ships.
   *
   * happy-dom performs no layout, but it does resolve `@media` rules in
   * `getComputedStyle` against its viewport — so compiling the rail's own class
   * string with this project's Tailwind config and reading `display` at two
   * widths is a real evaluation of the shipped gate, not a class-name match.
   *
   * **Reverting to a container query fails this test**, and for the right reason:
   * `[@container(min-width:56rem)]:flex` emits an `@container` rule and no
   * `@media` at all, so there is nothing here that could turn `display` from
   * `none` to `flex` at any viewport width.
   */
  test("the compiled gate is a viewport @media at exactly RAIL_VIEWPORT_MIN_PX", async () => {
    await mountShellWithEditor();
    const className = rail().className;
    const css = await generateCss(className.split(/\s+/).filter(Boolean));

    expect(css).toContain("display: none");
    const media = [...css.matchAll(/@media\s*\(min-width:\s*(\d+)px\)\s*\{([^}]*\{[^}]*\})/g)].find(
      ([, , body]) => body.includes("display: flex"),
    );
    expect(media).not.toBeUndefined();
    // Derived, not restated: the JS mirror that stops the FETCH and the CSS that
    // stops the PAINT are one number, or the rail is invisible while it works —
    // which is the defect this lane deletes, in its original form (a container
    // query at 1264px of viewport against a sidebar at 1024px).
    expect(Number(media![1])).toBe(RAIL_VIEWPORT_MIN_PX);
    expect(css).not.toContain("@container");
  });

  test("the landmark is there at 1024 and gone at 1023 — hidden, never unmounted", async () => {
    await mountShellWithEditor();
    const className = rail().className;
    applyCss(await generateCss(className.split(/\s+/).filter(Boolean)));

    /** A fresh element per read: happy-dom caches a computed style per element. */
    const displayAt = (width: number) => {
      setViewport(width);
      const probe = document.createElement("aside");
      probe.className = className;
      document.body.appendChild(probe);
      return window.getComputedStyle(probe).display;
    };

    expect(displayAt(RAIL_VIEWPORT_MIN_PX)).toBe("flex");
    expect(displayAt(RAIL_VIEWPORT_MIN_PX - 1)).toBe("none");

    // The same boundary as the DoD states it — through the rail that is actually
    // mounted, and through the accessibility tree rather than a `display` string:
    // `getByRole` excludes what the shipped CSS hides at this width, so "present"
    // and "absent" here mean what they mean to a reader.
    setViewport(RAIL_VIEWPORT_MIN_PX);
    fireEvent(window, new Event("resize"));
    await settle();
    expect(maybeRail()).not.toBeNull();

    setViewport(RAIL_VIEWPORT_MIN_PX - 1);
    fireEvent(window, new Event("resize"));
    await settle();
    expect(maybeRail()).toBeNull();

    // Red fault 5 — the gate HIDES, it does not unmount, which is what D43's count
    // invariant rests on: exactly one composed frame, counted by mount, so a resize
    // back above the breakpoint pays no fresh debounce.
    //
    // Read from the DOM and not by role, because at this width the landmark is
    // genuinely out of the accessibility tree — `computeAccessibleName` answers ""
    // for a CSS-hidden element, so even `hidden: true` cannot match it BY NAME.
    // That is the distinction the assertion needs: absent to a reader, present in
    // the tree, which is exactly what "neither gate unmounts" claims.
    expect(document.querySelector(`aside[aria-label="${messages.previewLegend}"]`)).not.toBeNull();
    expect(mountedFrameCount()).toBe(1);
  });

  test("below the breakpoint the rail mounts but nothing fetches (CC2, through the new gate)", async () => {
    // CC2's C3: `hidden lg:flex` hides without unmounting, so the rail would keep
    // asking for frames nobody can see. The JS mirror is what stops the WORK —
    // and this is the property RS-D4's "the mirror has nothing left to mirror"
    // would have deleted along with the container query.
    setViewport(500);
    const calls = routes();
    render(
      <ShellLayout>
        <BriefEditor briefId="clip" />
      </ShellLayout>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"),
    );
    // By MOUNT, not by visibility: this assertion is about a rail that exists and
    // does no work, which is the whole of CC2's C3 — no CSS is loaded in this test,
    // so `hidden: true` says what is meant rather than relying on that.
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: messages.previewLegend, hidden: true }),
      ).not.toBeNull(),
    );
    await settle();

    expect(frameCalls(calls).length).toBe(0);
  });
});

describe("§5 — the cost contract, re-measured with the rail across the boundary", () => {
  /**
   * The rail's children are now built in `BriefEditor`'s render and mounted in a
   * subtree that is a sibling of `<main>`, having crossed `EditorPanelsContext` as
   * a prop. `memo` compares PROPS at a stable position, not element identity, so
   * the boundary should survive the push — but "should" is what §5 refuses, and
   * the three assertions below are each broken before they are trusted.
   */
  /**
   * One look-preserving edit, and NOTHING else.
   *
   * No click and no focus first, though the sibling suites do both: the editor
   * captures clicks to mark a section touched, so a click of its own re-renders
   * the form — which would make assertion (3) below pass on the gesture rather
   * than on the edit, and pass just as happily on an editor that ignored the
   * edit entirely. The manifest's reducer mutation is what found that; the click
   * is gone so the rising count can only have come from the keystroke.
   */
  const keystroke = async () => {
    const audience = screen.getByLabelText("Target Audience") as HTMLInputElement;
    fireEvent.change(audience, { target: { value: `a new audience ${Date.now()}` } });
    await settle();
    return audience;
  };

  test("(1) a look-preserving keystroke issues zero /preview-frame calls", async () => {
    const calls = await mountShellWithEditor();
    const before = frameCalls(calls).length;
    // `targetAudience` rides in no frame request: CC1's fetch key is a
    // fingerprint of the LOOK, and this is not part of it.
    await keystroke();
    expect(frameCalls(calls).length).toBe(before);
  });

  test("(2) the same keystroke re-renders neither the layer stack nor the tape nor the dock", async () => {
    await mountShellWithEditor();
    expect(stackRenders.count).toBeGreaterThan(0);
    expect(tapeRenders.count).toBeGreaterThan(0);
    expect(dockRenders.count).toBeGreaterThan(0);
    const stackBefore = stackRenders.count;
    const tapeBefore = tapeRenders.count;
    const dockBefore = dockRenders.count;

    await keystroke();

    // If any prop these three are handed were freshly allocated per keystroke —
    // an inline arrow, a `beats` array rebuilt outside its memo, a playhead object
    // per render — these climb while every fetch assertion above stays green.
    expect(stackRenders.count).toBe(stackBefore);
    expect(tapeRenders.count).toBe(tapeBefore);
    expect(dockRenders.count).toBe(dockBefore);
  });

  test("(3) the form's own render count DOES rise — the liveness half", async () => {
    await mountShellWithEditor();
    formRenders.count = 0;
    const audience = await keystroke();
    // EXACTLY one, not "more than none". Two things ride on the number:
    //
    // - `> 0` is the liveness half — without it, (1) and (2) would both pass on
    //   an editor that ignored the event entirely, which is the vacuous shape §5
    //   names and the shape the manifest's handler mutation produces;
    // - `=== 1` is the publisher-cycle guard. Merging the setters back onto the
    //   slot context makes the editor a subscriber of its own publication, so a
    //   keystroke costs two commits instead of one. `toBeGreaterThan(0)` stayed
    //   green through exactly that (caught in review), which left the structural
    //   fix guarded only in another lane's file and only through the test outlet.
    //   `rs.json` carries the merge-back.
    expect(formRenders.count).toBe(1);
    // The edit also reached the draft: a count that rose while the field stayed
    // empty would be a render for some other reason.
    expect(audience.value).toContain("a new audience");
  });

  test("a scrub still redraws the rail's surfaces, and still leaves the form alone", async () => {
    await mountShellWithEditor();
    const playhead = screen.getByLabelText(messages.tapePlayheadName) as HTMLInputElement;
    const tapeBefore = tapeRenders.count;
    const dockBefore = dockRenders.count;
    formRenders.count = 0;

    // Five pointermoves' worth of live value. The seconds live inside the
    // published subtree, so a frame of a drag writes no context at all — the
    // reason the form's count can be asserted synchronously, before any timer.
    for (const value of ["1", "2", "3", "4", "5"]) {
      fireEvent.change(playhead, { target: { value } });
    }
    expect(playhead.value).toBe("5");
    expect(formRenders.count).toBe(0);
    expect(tapeRenders.count).toBeGreaterThan(tapeBefore);
    expect(dockRenders.count).toBeGreaterThan(dockBefore);
  });

  test("exactly one composed frame is mounted, and it is the rail's (D43)", async () => {
    await mountShellWithEditor();
    expect(mountedFrameCount()).toBe(1);
    expect(within(rail()).getAllByTestId("preview-frame")).toHaveLength(1);
  });

  /**
   * **SG4 — this test used to drive the RAIL's YAML view, and the rail has none.**
   *
   * It read: *"the rail's YAML view still reads the LIVE draft across the push"*,
   * and it was the proof for `rs.json`'s eighth mutation — dropping `draftBrief`
   * from `railSlot`'s `useCallback` list, which would have left the rail showing a
   * draft one keystroke stale. SG-D4 moves the one switch onto the middle column,
   * so the rail stops reading `draftBrief` at all: that dependency is gone from
   * the list legitimately, and **`rs.json` #8 is now the shipped code rather than
   * a mutation of it.** That is reported in the PR body, not re-authored here.
   *
   * What replaces it is the decision itself, pinned at the shell level where the
   * rail is actually placed: the rail carries NO view switcher and no document
   * view. The wireframe draws one switch; two would be two controls with one
   * vocabulary competing for the same corner (the plan's M1). The live-draft
   * property it used to guard is asserted for the column, in
   * `brief-editor.test.tsx` — the column reads `draftBrief` directly in render,
   * with no `useCallback` list to miss it.
   */
  test("the rail carries no view switcher and no document view — the one switch is the column's (SG-D4)", async () => {
    await mountShellWithEditor();

    expect(within(rail()).queryByRole("group", { name: messages.columnViews })).toBeNull();
    expect(rail().querySelector("pre")).toBeNull();
    expect(within(rail()).queryByRole("button", { name: messages.columnYamlView })).toBeNull();
    expect(within(rail()).queryByRole("button", { name: messages.columnEditorView })).toBeNull();
    // SG10 brought the third position, so it joins the negatives: a segment that
    // leaked into the rail would be a second switcher whichever one it was.
    expect(within(rail()).queryByRole("button", { name: messages.columnValidateView })).toBeNull();

    // The switch exists — outside the rail. Without this the five negatives above
    // would all hold on a build that shipped no switcher at all. Three since SG10
    // (SG-D13); the position COUNT is pinned in `brief-editor.test.tsx`, where the
    // control lives — this number is here only so the liveness check keeps meaning
    // "the whole switch is out here", not "some of it is".
    const views = screen.getByRole("group", { name: messages.columnViews });
    expect(rail().contains(views)).toBe(false);
    expect(within(views).getAllByRole("button")).toHaveLength(3);

    // And the rail still holds the composed frame while the column swaps.
    fireEvent.click(within(views).getByRole("button", { name: messages.columnYamlView }));
    await waitFor(() => expect(screen.getByTestId("column-yaml")).toBeTruthy());
    expect(mountedFrameCount()).toBe(1);
    expect(within(rail()).getAllByTestId("preview-frame")).toHaveLength(1);
  });
});

/**
 * SG11 — the owner's requirement: *"The three panels should always be
 * accessible. For mobile and tablet views the hamburger menu should allow user
 * to navigate to each panel."*
 *
 * Two of the three already surfaced in `MobileMenu` before this lane: the route
 * tabs, and the left panels via `SidebarContent` (shared with the desktop
 * `Sidebar`, so they cannot drift). The rail was the one with no path at any
 * width below `lg`.
 *
 * **The invariant these tests exist to protect** is that the rail is rendered in
 * exactly ONE place. `rail` holds rendered elements, so a second site means a
 * second mount: every `id` inside the rail duplicated, the `aria-controls` pairs
 * it builds broken, and two composed frames where §4.6 allows one. So every
 * assertion here is a count, not a presence check.
 */
describe("SG11 — the rail is reachable below the breakpoint, and still rendered once", () => {
  /**
   * Mounting BELOW the breakpoint, which `mountShellWithEditor` cannot do.
   *
   * That helper asserts the mount's own `/preview-frame` call happened, to keep
   * its later "no further calls" assertions honest. At this width there IS no
   * such call — CC2's gate withholds the brief from the dock below `lg`, which
   * is a contract this file asserts a few describes up ("the rail mounts but
   * nothing fetches"). So the guard is dropped here rather than worked around,
   * and nothing in this describe counts fetches; it counts MOUNTS.
   */
  const mountNarrow = async () => {
    routes();
    render(
      <ShellLayout>
        <BriefEditor briefId="clip" />
      </ShellLayout>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"),
    );
    await waitFor(() => expect(maybeRail()).not.toBeNull());
    await settle();
  };

  const openMenu = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Menu" })).toBeTruthy());
  };

  const railEntry = () =>
    within(screen.getByRole("dialog", { name: "Menu" })).getByRole("button", {
      name: messages.previewLegend,
    });

  test("the hamburger offers the rail, and choosing it shows the rail's content", async () => {
    setViewport(RAIL_VIEWPORT_MIN_PX - 24);
    await mountNarrow();
    await openMenu();

    // All three: the route tabs, the left panels, and — this lane — the rail.
    const menu = screen.getByRole("dialog", { name: "Menu" });
    expect(within(menu).getAllByRole("link").length).toBeGreaterThan(0);
    fireEvent.click(railEntry());

    // The menu stands aside rather than holding the panel it opened.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull());
    const panel = screen.getByRole("dialog", { name: messages.previewLegend });
    expect(within(panel).getByTestId("preview-frame")).toBeTruthy();
  });

  test("exactly one composed frame is mounted while the panel is open (D43 / §4.6)", async () => {
    setViewport(RAIL_VIEWPORT_MIN_PX - 24);
    await mountNarrow();
    expect(mountedFrameCount()).toBe(1);

    await openMenu();
    fireEvent.click(railEntry());
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: messages.previewLegend })).toBeTruthy(),
    );

    // The load-bearing count. Rendering the slot in the overlay WITHOUT the
    // shell column standing down reads as working — the panel shows the rail,
    // every control in it responds — and silently mounts the editor's composed
    // frame twice. Only a count says so.
    expect(mountedFrameCount()).toBe(1);
  });

  test("closing the panel hands the rail back to the shell column, still once", async () => {
    setViewport(RAIL_VIEWPORT_MIN_PX - 24);
    await mountNarrow();
    await openMenu();
    fireEvent.click(railEntry());
    const panel = await waitFor(() => screen.getByRole("dialog", { name: messages.previewLegend }));

    fireEvent.click(within(panel).getByRole("button", { name: `Close ${messages.previewLegend}` }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.previewLegend })).toBeNull(),
    );
    expect(maybeRail()).not.toBeNull();
    expect(mountedFrameCount()).toBe(1);
  });

  test("growing past the breakpoint closes the panel, so the two sites cannot both hold it", async () => {
    setViewport(RAIL_VIEWPORT_MIN_PX - 24);
    await mountNarrow();
    await openMenu();
    fireEvent.click(railEntry());
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: messages.previewLegend })).toBeTruthy(),
    );

    // Derived from the viewport rather than left to whoever opened it: a stale
    // request plus a widened window would otherwise leave the shell column
    // rendering the rail AND the overlay still up — two mounts, at the one width
    // where a reader would not think to look.
    setViewport(RAIL_VIEWPORT_MIN_PX);
    fireEvent(window, new Event("resize"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.previewLegend })).toBeNull(),
    );
    expect(mountedFrameCount()).toBe(1);
    expect(maybeRail()).not.toBeNull();
  });

  test("a route that publishes no rail offers no entry, and no empty panel", async () => {
    setViewport(RAIL_VIEWPORT_MIN_PX - 24);
    render(
      <ShellLayout>
        <div>a view with no editor</div>
      </ShellLayout>,
    );
    await openMenu();

    // An entry that opens an empty panel is the 256px-empty-strip defect in a
    // new place, and `rail` is null on every route with no editor mounted.
    expect(
      within(screen.getByRole("dialog", { name: "Menu" })).queryByRole("button", {
        name: messages.previewLegend,
      }),
    ).toBeNull();
  });

  test("at and above the breakpoint the rail stays in the row and no panel exists", async () => {
    setViewport(RAIL_VIEWPORT_MIN_PX);
    await mountShellWithEditor();

    expect(maybeRail()).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: messages.previewLegend })).toBeNull();
    expect(mountedFrameCount()).toBe(1);
  });

  test("Escape closes the panel, and any other key leaves it alone", async () => {
    setViewport(RAIL_VIEWPORT_MIN_PX - 24);
    await mountNarrow();
    await openMenu();
    fireEvent.click(railEntry());
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: messages.previewLegend })).toBeTruthy(),
    );

    // A key that is not Escape must not dismiss a panel the operator asked for.
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.getByRole("dialog", { name: messages.previewLegend })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.previewLegend })).toBeNull(),
    );
    // And the rail goes back to its column rather than vanishing with the panel.
    expect(maybeRail()).not.toBeNull();
    expect(mountedFrameCount()).toBe(1);
  });

  test("the hook refuses to run outside its provider", () => {
    const Probe = () => {
      useMobileRail();
      return null;
    };
    // Deliberately a throw and not a default value: the two render sites are
    // mutually exclusive only because one provider decides for both, so a
    // component that reads this outside it would silently get `open: false` and
    // the rail would be unreachable with nothing to show why.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/MobileRailProvider/);
    quiet.mockRestore();
  });
});
