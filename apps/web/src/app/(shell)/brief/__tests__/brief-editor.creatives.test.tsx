import { describe, test, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun as renderWithShell, json } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import * as messages from "@/components/campaign/messages";
import { BriefEditor } from "@/components/campaign/BriefEditor";

/**
 * **SL3 — the creatives list in the left sidebar, through the editor that ships.**
 *
 * The owner's words: *"2a. The creatives are listed in the left sidebar. 2b.
 * Clicking through the various creatives updates the editor to that instance of
 * the creative… Before loading a new creative on user-click, the current
 * creative should be saved/preserved."*
 *
 * Five properties, each of which is a way this could ship broken:
 *
 * 1. The list shows the PLANNED creatives, one row per emitted slot, and a
 *    tombstoned slot is not a row. Asserted two-sided: the request carries the
 *    occupancy (so the planner CAN exclude) and the rows are exactly the
 *    response's `index` values, labelled from the index and not from position.
 * 2. Clicking a row loads that creative — the rail composes THAT instance's
 *    look, read off rendered content rather than off a spy.
 * 3. Nothing is lost by switching. An edit made before the switch survives it.
 * 4. Selection is not a document change: no dirty flag, no write, and no extra
 *    `/campaigns/plan` call.
 * 5. A brief with no variation plan shows no list and no empty chrome.
 */

/** The map paints hundreds of SVG nodes per mount and has its own suite. */
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, WorldMap: () => <div data-testid="world-map-stub" /> };
});

const renderWithRun = (ui: React.ReactElement) =>
  renderWithShell(<CreateCampaignProvider>{ui}</CreateCampaignProvider>);

const base = {
  schemaVersion: 1,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
};

/**
 * A randomized brief with a HOLE in it: three slots were allocated and the
 * middle one was deleted, so occupancy is `nextIndex: 3` with slot 1 tombstoned.
 * SL1 put that block in the document and SL2 made the draw replay the whole
 * history and emit only the survivors, so the plan the route answers for this
 * brief is slots 0 and 2 — never slot 1, and never a renumbered pair.
 */
const holeyBrief = {
  ...base,
  id: "holey",
  mode: "variation",
  variation: {
    count: 3,
    occupancy: { nextIndex: 3, tombstoned: [1] },
    axes: {
      layout: ["headline-top", "headline-bottom"],
      tone: ["bold", "minimal"],
      background: { source: ["procedural"] },
      paletteShift: [0],
    },
  },
};

/** The same brief with no plan at all: classic mode. */
const classicBrief = {
  ...base,
  id: "classic",
  mode: "brief",
  treatments: [{ id: "t1", layout: "headline-bottom" as const, tone: "bold" as const }],
  output: { formats: ["static"], platforms: ["linkedin"] },
};

/**
 * What the planner answers for `holeyBrief` — the EMITTED set, which is what
 * `PlanVariationsUseCase` returns (`use-case.ts:191`: `history.filter((variant)
 * => live.has(variant.index))`). Slot 1 is drawn and withheld, so it is absent
 * here exactly as it is absent from the real route's body.
 *
 * The two survivors are given DIFFERENT layouts, tones and headlines on purpose:
 * property 2 asserts the rail's rendered content, so the two slots have to be
 * distinguishable by something the preview actually draws.
 */
const EMITTED = [
  {
    index: 0,
    productId: "alpha",
    aspectRatio: "1:1",
    layout: "headline-top",
    tone: "bold",
    backgroundSource: "procedural",
    paletteShift: 0,
    headline: "Zerocreative",
  },
  {
    index: 2,
    productId: "alpha",
    aspectRatio: "9:16",
    layout: "headline-bottom",
    tone: "minimal",
    backgroundSource: "procedural",
    paletteShift: 0,
    headline: "Twocreative",
  },
];

const okPlan = (variants: readonly unknown[] = EMITTED) => ({
  policyHash: "abc",
  seed: 7,
  estimate: {
    creatives: variants.length,
    axisProductSize: 4,
    feasible: true,
    genaiCalls: 0,
  },
  variants,
});

/**
 * Route by URL and method and record every call with its parsed body, so a test
 * can both COUNT `/campaigns/plan` and read what it sent. Anything unmatched
 * answers 404 rather than hanging.
 */
const routes = (opts: { briefs?: readonly unknown[]; plan?: () => Response } = {}) => {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  const briefs = opts.briefs ?? [holeyBrief];
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
        json({
          briefs: briefs.map((brief) => ({
            file: `${(brief as { id: string }).id}.yaml`,
            revision: "r1",
            brief,
          })),
        }),
      );
    }
    if (u.includes("/campaigns/plan")) {
      return Promise.resolve(opts.plan?.() ?? json(okPlan()));
    }
    if (u.includes("/campaigns/preview-frame")) {
      return Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/png", "x-preview-frame-cache-key": "k".repeat(64) },
        }),
      );
    }
    return Promise.resolve(json({}, 404));
  });
  return calls;
};

/** Longer than both the plan debounce (250 ms) and the frame debounce (300 ms). */
const settle = () => new Promise((r) => setTimeout(r, 450));

type Call = { url: string; method: string; body?: Record<string, unknown> };

const planCalls = (calls: readonly Call[]) =>
  calls.filter((c) => c.url.includes("/campaigns/plan"));
const frameCalls = (calls: readonly Call[]) =>
  calls.filter((c) => c.url.includes("/campaigns/preview-frame"));
/**
 * The cell the LAST frame request asked the server to composite
 * (`fetchPreviewFrame` posts `{ brief, cell }`, `preview-frame.ts:104`).
 *
 * The rail's picture is server-rendered, so what it "shows" for the selected
 * creative is settled by the request that drew it, not by the DOM: the
 * composed SVG is a placeholder that the returned PNG replaces. Reading the
 * body is therefore the honest form of the claim for `layout` and `tone`,
 * which — unlike the headline — reach the compositor rather than the page.
 */
const lastCell = (calls: readonly Call[]) =>
  (frameCalls(calls).at(-1)?.body?.cell ?? {}) as Record<string, unknown>;
/** Calls that actually WROTE something — a plan and a frame persist nothing. */
const writes = (calls: readonly { url: string; method: string }[]) =>
  calls.filter(
    (c) =>
      c.method !== "GET" &&
      !c.url.includes("/campaigns/plan") &&
      !c.url.includes("/campaigns/preview-frame"),
  );

const list = () => screen.getByRole("list", { name: messages.creativesLegend });
const rows = () => within(list()).getAllByRole("button");
const row = (slot: number) =>
  screen.getByRole("button", { name: new RegExp(`^${messages.creativeRowLabel(slot)}`) });
const rail = () => screen.getByRole("complementary", { name: messages.previewLegend });
/**
 * How many places in the rail show this string.
 *
 * The rail draws the headline twice, from the same `PreviewShowcaseProps` the
 * look produces: as real SVG `<text>` inside `CreativePreview`
 * (`CreativePreview.tsx:363`) and as the brief line beside the swatch
 * (`PreviewDock.tsx:220`). A COUNT rather than a `getByText`, because the SVG
 * half is transient — once the server frame's PNG lands it replaces the composed
 * drawing, so `getByText` finds two elements before the fetch resolves and one
 * after, and a test written either way is a coin toss on timing. The brief line
 * is always there, so `> 0` and `=== 0` are both stable, and both are still
 * rendered state fed by the selected slot's look.
 */
const railShows = (text: string) => within(rail()).queryAllByText(text).length;

const DirtyProbe = () => {
  const { isDirty } = useEditorDirty();
  return <span data-testid="dirty-probe">{isDirty ? "dirty" : "clean"}</span>;
};

const mount = async (id = "holey", opts: Parameters<typeof routes>[0] = {}) => {
  const calls = routes(opts);
  renderWithRun(
    <>
      <DirtyProbe />
      <BriefEditor briefId={id} />
    </>,
  );
  await waitFor(() =>
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id),
  );
  await settle();
  return calls;
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("cf:brief-picked", "1");
});

describe("(1) the list shows the planned creatives, and a tombstoned slot is not one", () => {
  test("the request carries the occupancy, and the rows are the emitted slots — labelled from the index, not the position", async () => {
    const calls = await mount();

    // The half that makes the absence mean something: the planner was ASKED a
    // question it could answer with a hole. A request that dropped occupancy
    // would get three contiguous slots back and this file would be asserting
    // nothing but the shape of its own mock.
    const [planned] = planCalls(calls);
    expect(planned).toBeTruthy();
    expect((planned!.body as { variation?: { occupancy?: unknown } }).variation?.occupancy).toEqual(
      {
        nextIndex: 3,
        tombstoned: [1],
      },
    );

    // Two rows, and they are slots 0 and 2 — "Creative 1" and "Creative 3".
    expect(rows()).toHaveLength(2);
    expect(row(0)).toBeTruthy();
    expect(row(2)).toBeTruthy();
    // The discriminating half. A list keyed on array POSITION renders "Creative
    // 1" and "Creative 2" for the same response: both assertions above still
    // pass, and this one does not.
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${messages.creativeRowLabel(1)}`) }),
    ).toBeNull();

    // And the row carries the slot's own draw, so a row is identifiable as a
    // creative rather than as a number.
    expect(row(0).textContent).toContain("Zerocreative");
    expect(row(2).textContent).toContain("Twocreative");
    expect(row(2).textContent).toContain("headline-bottom");
  });

  test("the list is in the left sidebar's published panels, not in the editor column or the rail", async () => {
    await mount();
    expect(rail().contains(list())).toBe(false);
    expect(document.getElementById("policy")?.contains(list()) ?? false).toBe(false);
  });
});

describe("(2) clicking a row loads that creative", () => {
  test("the rail composes the clicked slot's own look, not the first value of each axis", async () => {
    const user = userEvent.setup();
    const calls = await mount();

    // Before any click: no slot is loaded, so the rail draws the BRIEF's own
    // words and the draft's first-of-each-axis look — `headline-top`/`bold`,
    // the head of each axis list on `holeyBrief`.
    expect(railShows("Hi")).toBeGreaterThan(0);
    expect(lastCell(calls).layout).toBe("headline-top");
    expect(lastCell(calls).tone).toBe("bold");
    const framesBefore = frameCalls(calls).length;

    await user.click(row(2));
    await settle();

    // Rendered state, not a spy: the composed creative in the rail now draws
    // slot 2's own headline, and the brief's words are gone from it.
    expect(railShows("Twocreative")).toBeGreaterThan(0);
    expect(railShows("Hi")).toBe(0);
    // And the picture itself moved. The headline is drawn on the page, but
    // `layout` and `tone` are the SERVER's to composite, so the claim about
    // them is a claim about the request: exactly one new frame, asking for slot
    // 2's own axes rather than the head of each axis list.
    expect(frameCalls(calls).length).toBe(framesBefore + 1);
    expect(lastCell(calls).layout).toBe("headline-bottom");
    expect(lastCell(calls).tone).toBe("minimal");
    // And the row says it is the one selected.
    expect(row(2).getAttribute("aria-pressed")).toBe("true");
    expect(row(0).getAttribute("aria-pressed")).toBe("false");

    // Clicking through to the other creative moves the editor with it (2b).
    await user.click(row(0));
    await settle();
    expect(railShows("Zerocreative")).toBeGreaterThan(0);
    expect(railShows("Twocreative")).toBe(0);
    expect(row(0).getAttribute("aria-pressed")).toBe("true");
    expect(row(2).getAttribute("aria-pressed")).toBe("false");
  });

  test("re-clicking the creative already loaded fetches nothing — no plan, no frame", async () => {
    const user = userEvent.setup();
    const calls = await mount();
    await user.click(row(2));
    await settle();

    const plansBefore = planCalls(calls).length;
    const framesBefore = frameCalls(calls).length;
    // The positive half in the same moment: the run above DID fetch a frame for
    // the new look, so "no new frame" below is a statement about the re-click
    // rather than about a rail that never fetches at all.
    expect(framesBefore).toBeGreaterThan(0);

    await user.click(row(2));
    await settle();

    expect(planCalls(calls).length).toBe(plansBefore);
    expect(frameCalls(calls).length).toBe(framesBefore);
    expect(row(2).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("(3) nothing is lost by switching", () => {
  /**
   * The owner's *"before loading a new creative on user-click, the current
   * creative should be saved/preserved"*, answered by construction rather than
   * by a prompt: selecting a creative writes nothing, so there is nothing to
   * save. The draft is the same object before and after the click. This test is
   * what makes that claim checkable — if selection ever became a document
   * change, or ever reloaded the draft from anywhere, the edit would be gone.
   *
   * **And it discriminates against the OTHER reading of the owner's sentence**
   * — an implicit Save on click. That reading loses no text, so the field's
   * value alone cannot tell the two apart; what tells them apart is that the
   * unsaved edit is still UNSAVED afterwards. A click that quietly committed
   * the draft would leave the operator's work on disk under a gesture they made
   * to look at a picture, and would clear the guard that is supposed to ask
   * before they navigate away.
   */
  test("an edit made before the switch is still there after switching away and back, and still unsaved", async () => {
    const user = userEvent.setup();
    await mount();

    const audience = screen.getByLabelText("Target Audience") as HTMLInputElement;
    await user.clear(audience);
    await user.type(audience, "cyclists");
    expect(audience.value).toBe("cyclists");
    expect(screen.getByTestId("dirty-probe").textContent).toBe("dirty");

    await user.click(row(2));
    await settle();
    await user.click(row(0));
    await settle();

    expect((screen.getByLabelText("Target Audience") as HTMLInputElement).value).toBe("cyclists");
    // Still unsaved — the switch preserved the work by not touching it, which
    // is a different thing from having saved it for the operator.
    expect(screen.getByTestId("dirty-probe").textContent).toBe("dirty");
    // The positive half: the switch really happened, so the survival above is
    // not the survival of a click that did nothing.
    expect(row(0).getAttribute("aria-pressed")).toBe("true");
    expect(railShows("Zerocreative")).toBeGreaterThan(0);
  });
});

describe("(4) selection is not a document change", () => {
  test("it does not dirty the brief, writes nothing, and issues no extra /campaigns/plan call", async () => {
    const user = userEvent.setup();
    const calls = await mount();

    expect(screen.getByTestId("dirty-probe").textContent).toBe("clean");
    const plansBefore = planCalls(calls).length;
    // The positive half: a plan DID happen, so "no more of them" is a count and
    // not the absence of a feature.
    expect(plansBefore).toBeGreaterThan(0);

    await user.click(row(2));
    await settle();
    await user.click(row(0));
    await settle();

    // A loaded brief the operator only LOOKED at is still byte-identical, so the
    // unsaved-work guard has nothing to ask about (D139).
    expect(screen.getByTestId("dirty-probe").textContent).toBe("clean");
    expect(writes(calls)).toEqual([]);
    expect(planCalls(calls).length).toBe(plansBefore);
  });

  test("the editor asks the planner ONCE per draft — the Estimate and the list read the same answer", async () => {
    const calls = await mount();
    // Both surfaces are on screen…
    expect(rows()).toHaveLength(2);
    expect(screen.getByText(/You will get/)).toBeTruthy();
    // …and between them they cost exactly one request. Two callers would read 2
    // here, which is the cost regression this lane had to avoid.
    expect(planCalls(calls)).toHaveLength(1);
  });
});

describe("(5) a brief with no variation plan shows no list and no empty chrome", () => {
  test("a classic brief: no list, no heading, and the Estimate is still there", async () => {
    await mount("classic", { briefs: [classicBrief] });

    expect(screen.queryByRole("list", { name: messages.creativesLegend })).toBeNull();
    // Not just the list — the ACCORDION too. A heading over an empty box is the
    // defect; a test that only looked for the rows would pass on one.
    expect(screen.queryByText(messages.creativesLegend)).toBeNull();
    // The positive half in the same moment: the sidebar is publishing panels at
    // all, so the absence above is about the creatives list and not about a
    // sidebar that never rendered.
    expect(screen.getAllByText("Estimate").length).toBeGreaterThan(0);
  });

  test("a randomized brief the planner refuses: no list, no heading, and the refusal is shown", async () => {
    await mount("holey", {
      plan: () => json({ error: "Variation plan is not feasible." }, 422),
    });

    expect(screen.queryByRole("list", { name: messages.creativesLegend })).toBeNull();
    expect(screen.queryByText(messages.creativesLegend)).toBeNull();
    expect(screen.getByText("Variation plan is not feasible.")).toBeTruthy();
  });

  test("a plan that answers with no creatives at all: no list, no heading", async () => {
    await mount("holey", { plan: () => json(okPlan([])) });

    expect(screen.queryByRole("list", { name: messages.creativesLegend })).toBeNull();
    expect(screen.queryByText(messages.creativesLegend)).toBeNull();
  });

  test("a variant the route sent without an index is not a row", async () => {
    // `planCampaign` does not validate the variants array — it is an unchecked
    // cast. A row keyed on array position would render this one and mislabel
    // every row after it.
    await mount("holey", {
      plan: () => json(okPlan([{ productId: "alpha", aspectRatio: "1:1" }, ...EMITTED])),
    });

    expect(rows()).toHaveLength(2);
    expect(row(0)).toBeTruthy();
    expect(row(2)).toBeTruthy();
  });
});

describe("the selection is ephemeral and host-owned (D139)", () => {
  test("it does not survive a re-plan that drops the slot", async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(row(2));
    await settle();
    expect(row(2).getAttribute("aria-pressed")).toBe("true");
    expect(railShows("Twocreative")).toBeGreaterThan(0);

    // The planner now answers with slot 2 gone. The selection names nothing, so
    // it retires rather than pointing at a creative that is not there.
    vi.mocked(globalThis.fetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/campaigns/plan")) return Promise.resolve(json(okPlan([EMITTED[0]!])));
      if (u.includes("/campaigns/preview-frame")) {
        return Promise.resolve(
          new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { "content-type": "image/png", "x-preview-frame-cache-key": "k".repeat(64) },
          }),
        );
      }
      if (u === `${API}/campaigns/capabilities`) return Promise.resolve(json({ motion: true }));
      return Promise.resolve(json({ briefs: [] }));
    });
    const audience = screen.getByLabelText("Target Audience") as HTMLInputElement;
    await user.clear(audience);
    await user.type(audience, "z");
    await settle();

    expect(rows()).toHaveLength(1);
    expect(row(0).getAttribute("aria-pressed")).toBe("false");
    // Back to the brief's own words — no slot is loaded.
    expect(railShows("Hi")).toBeGreaterThan(0);
  });

  /**
   * The other thing a re-plan can do to a selected slot: KEEP it and redraw it.
   * It happens whenever the operator edits an axis with a row selected. The row
   * shows the new draw off the fresh plan; the rail composes off the selection.
   * If the selection is not re-pointed at the fresh object, the two surfaces
   * disagree about the same creative — the row says one headline, the preview
   * draws another, and neither is obviously the stale one.
   */
  test("a re-plan that redraws the selected slot moves the rail with the row", async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(row(2));
    await settle();
    expect(railShows("Twocreative")).toBeGreaterThan(0);

    // Slot 2 survives, drawn differently.
    const redrawn = { ...EMITTED[1]!, headline: "Tworedrawn", layout: "headline-top" };
    vi.mocked(globalThis.fetch).mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/campaigns/plan")) {
        return Promise.resolve(json(okPlan([EMITTED[0]!, redrawn])));
      }
      if (u.includes("/campaigns/preview-frame")) {
        return Promise.resolve(
          new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { "content-type": "image/png", "x-preview-frame-cache-key": "k".repeat(64) },
          }),
        );
      }
      if (u === `${API}/campaigns/capabilities`) return Promise.resolve(json({ motion: true }));
      return Promise.resolve(json({ briefs: [] }));
    });
    const audience = screen.getByLabelText("Target Audience") as HTMLInputElement;
    await user.clear(audience);
    await user.type(audience, "z");
    await settle();

    // The slot is still selected — it did not retire, because it still exists…
    expect(row(2).getAttribute("aria-pressed")).toBe("true");
    expect(row(2).textContent).toContain("Tworedrawn");
    // …and the rail followed it rather than holding the draw it was handed.
    expect(railShows("Tworedrawn")).toBeGreaterThan(0);
    expect(railShows("Twocreative")).toBe(0);
  });
});
