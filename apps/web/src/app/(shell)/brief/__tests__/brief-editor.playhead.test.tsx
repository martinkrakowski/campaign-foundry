import { describe, test, expect, beforeEach, vi } from "vitest";
import { createElement, memo, type ComponentType } from "react";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { renderWithRun as renderWithShell, json } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { CreateCampaignDialog } from "@/components/shell/CreateCampaignDialog";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import * as messages from "@/components/campaign/messages";
import { BriefEditor } from "@/components/campaign/BriefEditor";
import type { TimelineTapeProps } from "@/components/campaign/TimelineTape";

/**
 * CC5's cost criterion, through the editor that actually ships (the plan's §4
 * acceptance (b), which the brief calls "where this lane can quietly undo CC2"):
 *
 * 1. a pointermove drag across the range issues ZERO `/preview-frame` calls;
 * 2. the release issues EXACTLY ONE, at the committed second;
 * 3. the step form does not re-render during the drag.
 *
 * (3) is the one a reviewer cannot see: `BriefEditor` is the largest component in
 * the app and nothing under it is `memo`-wrapped, so a naive lift of the playhead
 * into its body would re-render the whole form per frame of a drag. The counter
 * below is therefore not decoration — it is the assertion, and it goes red the
 * moment the seconds move back into `BriefEditor`'s own body.
 *
 * The keyboard half of (2) is separate on purpose: `onPointerUp` never fires for
 * an arrow key, so a pointer-only commit leaves a keyboard user able to move the
 * thumb and unable to move the frame (the plan's §3.3a — a regression it already
 * caught once).
 */

/** Renders of the editor's form sections, counted through the module BriefEditor imports. */
const formRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/components/campaign/sections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/campaign/sections")>();
  const counted = <P extends object>(Inner: ComponentType<P>): ComponentType<P> =>
    function Counted(props: P) {
      formRenders.count += 1;
      return createElement(Inner, props);
    };
  return {
    ...actual,
    IdentitySection: counted(actual.IdentitySection),
    CopySection: counted(actual.CopySection),
    ProductsSection: counted(actual.ProductsSection),
    TreatmentsSection: counted(actual.TreatmentsSection),
    TemplateSection: counted(actual.TemplateSection),
    LayoutSection: counted(actual.LayoutSection),
    OutputSection: counted(actual.OutputSection),
    PolicySection: counted(actual.PolicySection),
  };
});

/**
 * Renders of the tape ITSELF, behind a `memo` with the default shallow compare.
 *
 * The real component is underneath: what this wrapper adds is a second memo
 * boundary over exactly the props `BriefEditor` passes, so "the tape re-rendered"
 * becomes a number. The plan's revision note is why it exists — CC1 keyed the
 * rail's feed on a content fingerprint precisely so a look-preserving keystroke
 * costs nothing, and a new component whose props are freshly allocated per keystroke
 * would re-open that cost through the back door.
 */
const tapeRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/components/campaign/TimelineTape", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/campaign/TimelineTape")>();
  const Counting = memo(function CountingTape(props: TimelineTapeProps) {
    tapeRenders.count += 1;
    return createElement(actual.TimelineTape, props);
  });
  return { ...actual, TimelineTape: Counting };
});

/**
 * The map paints hundreds of SVG nodes per mount under happy-dom and has its own
 * suite; a stub keeps this file about the playhead.
 */
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, WorldMap: () => <div data-testid="world-map-stub" /> };
});

const renderWithRun = (ui: React.ReactElement) =>
  renderWithShell(
    <CreateCampaignProvider>
      {ui}
      <CreateCampaignDialog />
    </CreateCampaignProvider>,
  );

const DURATION_SEC = 6;

/**
 * A motion draft whose LOOK is fully specified.
 *
 * Both halves matter. Without `layout`/`tone` the frame's own `cell` is never
 * built and NOTHING fetches at all — "zero calls during the drag" and "zero calls
 * after the release" would then agree for a reason that has nothing to do with
 * the live/committed split, which is exactly the vacuous proof this lane is
 * warned about. Without `motion` there is no range control to drag.
 */
const tapeBrief = {
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
        { text: "First beat", weight: 2 },
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

type Call = { url: string; method: string; body?: Record<string, unknown> };

const routes = (): Call[] => {
  const calls: Call[] = [];
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body;
    const parsed =
      typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    calls.push({ url: u, method, ...(parsed ? { body: parsed } : {}) });
    if (method === "GET" && u === `${API}/campaigns/capabilities`) {
      return Promise.resolve(json({ motion: true }));
    }
    if (method === "GET" && u.startsWith(`${API}/campaigns/briefs`)) {
      return Promise.resolve(
        json({ briefs: [{ file: "clip.yaml", revision: "r1", brief: tapeBrief }] }),
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

const scrub = () => screen.getByLabelText(messages.previewScrubLabel) as HTMLInputElement;

/**
 * Mounts the editor on the motion draft and lets the mount's own frame request
 * land, so every count below is about the drag and nothing else.
 */
const mountScrubbing = async () => {
  const calls = routes();
  renderWithRun(<BriefEditor briefId="clip" />);
  await waitFor(() =>
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"),
  );
  await waitFor(() => expect(screen.queryByLabelText(messages.previewScrubLabel)).not.toBeNull());
  await settle();
  // The mount's own fetch actually happened: a zero here would make every
  // "no further calls" assertion below vacuous.
  expect(frameCalls(calls).length).toBeGreaterThan(0);
  return calls;
};

describe("the playhead's cost (CC5, plan §4 acceptance (b))", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem("cf:presentation", "guided");
    formRenders.count = 0;
    tapeRenders.count = 0;
  });

  test("a drag issues no frame request and does not re-render the step form", async () => {
    const calls = await mountScrubbing();
    const before = frameCalls(calls).length;
    formRenders.count = 0;

    // Five pointermoves' worth of live value. `onChange` on a range fires all
    // through a drag — that is why the commit cannot live on it (plan §3.3a).
    for (const value of ["1", "2", "3", "4", "5"]) {
      fireEvent.change(scrub(), { target: { value } });
    }
    expect(scrub().value).toBe("5");

    // Asserted synchronously, before any timer can commit anything else into the
    // window: the form must not have re-rendered ONCE for five moves.
    expect(formRenders.count).toBe(0);

    await settle();
    expect(frameCalls(calls).length).toBe(before);
  });

  test("the release issues exactly one request, at the committed second", async () => {
    const calls = await mountScrubbing();
    const before = frameCalls(calls).length;

    fireEvent.change(scrub(), { target: { value: "4" } });
    await settle();
    expect(frameCalls(calls).length).toBe(before);

    fireEvent.pointerUp(scrub());
    await settle();

    const after = frameCalls(calls);
    expect(after.length).toBe(before + 1);
    const cell = after[after.length - 1].body?.cell as { atSec?: number } | undefined;
    expect(cell?.atSec).toBe(4);
  });

  test("a keyboard commit lands too — onPointerUp never fires for an arrow key", async () => {
    const calls = await mountScrubbing();
    const before = frameCalls(calls).length;

    // The shape an arrow key produces: the range's value changes, then keyup.
    // No pointer event is dispatched anywhere in this test.
    fireEvent.change(scrub(), { target: { value: "3" } });
    await settle();
    expect(frameCalls(calls).length).toBe(before);

    fireEvent.keyUp(scrub(), { key: "ArrowRight" });
    await settle();

    const after = frameCalls(calls);
    expect(after.length).toBe(before + 1);
    const cell = after[after.length - 1].body?.cell as { atSec?: number } | undefined;
    expect(cell?.atSec).toBe(3);
  });

  test("the committed second survives a commit at the very end of the clip", async () => {
    const calls = await mountScrubbing();
    const before = frameCalls(calls).length;

    fireEvent.change(scrub(), { target: { value: String(DURATION_SEC) } });
    fireEvent.pointerUp(scrub());
    await settle();

    const after = frameCalls(calls);
    expect(after.length).toBe(before + 1);
    const cell = after[after.length - 1].body?.cell as
      | { atSec?: number; durationSec?: number }
      | undefined;
    // The clamp's ceiling is the previewed duration, not one frame short of it:
    // the encoder renders t = 1 on every clip's final frame (VE-D6).
    expect(cell?.atSec).toBe(DURATION_SEC);
    expect(cell?.durationSec).toBe(DURATION_SEC);
  });
});

describe("TS1 — the tape in the rail (plan §4 acceptance (e), §5)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem("cf:presentation", "guided");
    tapeRenders.count = 0;
  });

  test("a moving draft mounts exactly one tape, inside the rail's landmark", async () => {
    await mountScrubbing();
    const rail = screen.getByRole("complementary", { name: messages.previewLegend });
    const playheads = screen.getAllByLabelText(messages.tapePlayheadName);
    expect(playheads).toHaveLength(1);
    expect(rail.contains(playheads[0])).toBe(true);
    // The tape's own lanes, drawn from the brief's beats through resolveTimeline.
    expect(screen.getByRole("button", { name: messages.tapeBeatName(1) })).toBeTruthy();
    expect(screen.getByRole("button", { name: messages.tapeBeatName(2) })).toBeTruthy();
    expect(screen.getByRole("button", { name: messages.tapeVideoClip })).toBeTruthy();
  });

  test("a brief with no motion mounts no tape at all", async () => {
    const stillBrief = {
      ...tapeBrief,
      id: "still",
      variation: {
        ...tapeBrief.variation,
        axes: { ...tapeBrief.variation.axes, motion: [] as string[] },
      },
      output: { formats: ["static"], platforms: ["linkedin"] },
    };
    vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && u === `${API}/campaigns/capabilities`) {
        return Promise.resolve(json({ motion: true }));
      }
      if (method === "GET" && u.startsWith(`${API}/campaigns/briefs`)) {
        return Promise.resolve(
          json({ briefs: [{ file: "still.yaml", revision: "r1", brief: stillBrief }] }),
        );
      }
      return Promise.resolve(json({}, 200));
    });
    renderWithRun(<BriefEditor briefId="still" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("still"),
    );
    await settle();

    // The rail is there — the still creative is still previewed — but there are
    // no seconds to draw, so neither the tape nor the dock's own range mounts.
    expect(screen.getByRole("complementary", { name: messages.previewLegend })).toBeTruthy();
    expect(screen.queryByLabelText(messages.tapePlayheadName)).toBeNull();
    expect(screen.queryByLabelText(messages.previewScrubLabel)).toBeNull();
    expect(screen.queryByText(messages.tapeLegend)).toBeNull();
    expect(tapeRenders.count).toBe(0);
  });

  test("a look-preserving keystroke does not re-render the tape (CC1/CC2, through a new component)", async () => {
    await mountScrubbing();
    expect(tapeRenders.count).toBeGreaterThan(0);
    const before = tapeRenders.count;

    // `targetAudience` rides in no frame request and appears nowhere on the tape.
    // If any prop the tape is handed were freshly allocated per keystroke — an
    // inline arrow, or a `beats` array rebuilt outside its memo — this climbs.
    const audience = screen.getByLabelText("Target Audience") as HTMLInputElement;
    fireEvent.click(audience);
    audience.focus();
    fireEvent.change(audience, { target: { value: "a new audience" } });
    await settle();

    expect(tapeRenders.count).toBe(before);
  });

  test("a scrub DOES re-render the tape — the sibling proof that the test above is not vacuous", async () => {
    await mountScrubbing();
    const before = tapeRenders.count;
    fireEvent.change(scrub(), { target: { value: "2" } });
    expect(tapeRenders.count).toBeGreaterThan(before);
  });
});
