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
import type { LayoutOption, ToneOption } from "@/components/campaign/CreativePreview";

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
 *
 * **SL4 continues the file below property 5**, with the gestures the list was
 * always going to grow: add and delete. Same fixtures, same harness — the
 * difference is that the planner stub now answers for the brief it was SENT
 * rather than with a constant, because from here on the document moves.
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
      tone: ["bold", "subtle"],
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

/** The same brief with no occupancy block at all — a campaign saved before SL1. */
const denseBrief = { ...holeyBrief, id: "dense", variation: { ...holeyBrief.variation } } as {
  id: string;
  variation: { count: number; occupancy?: unknown };
};
delete denseBrief.variation.occupancy;

/**
 * One slot's draw. Adjacent slots are given DIFFERENT layouts, tones and
 * headlines on purpose: property 2 asserts the rail's rendered content, so the
 * slots have to be distinguishable by something the preview actually draws.
 *
 * `satisfies` against the EDITOR's vocabulary, not the wire type: `PlanVariant`
 * types `tone` as `string` because the route body may carry anything, and
 * `okPlan` widens to `readonly unknown[]` so a test can post a malformed plan on
 * purpose. Between the two there was nothing left to reject a tone the product
 * cannot draw — `tone: "minimal"` sat here, and `CreativeGlyph` resolves it as
 * `HEAVY["minimal"]`, i.e. `undefined`, which renders as the light variant. The
 * comment above said the tones differ; they did, but by an undefined lookup
 * rather than by the second tone. This annotation is what makes that sentence
 * true, and it is the guard: put "minimal" back and `yarn typecheck` fails.
 */
const DRAWS = [
  { aspectRatio: "1:1", layout: "headline-top", tone: "bold", headline: "Zerocreative" },
  { aspectRatio: "1:1", layout: "headline-top", tone: "bold", headline: "Onecreative" },
  { aspectRatio: "9:16", layout: "headline-bottom", tone: "subtle", headline: "Twocreative" },
  { aspectRatio: "1:1", layout: "headline-top", tone: "bold", headline: "Threecreative" },
  { aspectRatio: "9:16", layout: "headline-bottom", tone: "subtle", headline: "Fourcreative" },
] satisfies readonly {
  readonly aspectRatio: string;
  readonly layout: LayoutOption;
  readonly tone: ToneOption;
  readonly headline: string;
}[];
const drawn = (index: number) => ({
  index,
  productId: "alpha",
  backgroundSource: "procedural",
  paletteShift: 0,
  ...DRAWS[index]!,
});

/**
 * What the planner answers for `holeyBrief` — the EMITTED set, which is what
 * `PlanVariationsUseCase` returns (`use-case.ts:191`: `history.filter((variant)
 * => live.has(variant.index))`). Slot 1 is drawn and withheld, so it is absent
 * here exactly as it is absent from the real route's body.
 */
const EMITTED = [drawn(0), drawn(2)];

/**
 * The emitted slots of whatever brief the request carried — the planner's own
 * rule (`history.filter((variant) => live.has(variant.index))`) and the
 * domain's own resolution of an absent block (`nextIndex` is `count`), and
 * nothing else about the draw.
 *
 * SL3 answered with a fixed pair, which was enough while nothing could change
 * the document. SL4's gestures change it, so a fixed answer would make every
 * assertion after a gesture an assertion about this file's own constant. This
 * is still a stub — what the survivors LOOK like after a delete is proved
 * against the real planner in `editor-state.creative-slots.test.ts`, because no
 * stub can prove that — but which slots come back is now the document's doing.
 */
const emittedFor = (body: Record<string, unknown> | undefined) => {
  const variation = (body?.variation ?? {}) as {
    count?: number;
    occupancy?: { nextIndex: number; tombstoned?: readonly number[] };
  };
  const nextIndex = variation.occupancy?.nextIndex ?? variation.count ?? 0;
  const tombstoned = variation.occupancy?.tombstoned ?? [];
  return Array.from({ length: nextIndex }, (_unused, index) => index)
    .filter((index) => !tombstoned.includes(index))
    .map(drawn);
};

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
  /**
   * The stored briefs, and they are STORED: a save replaces the one it names, so
   * the next listing serves what was written. Without that, a round-trip test
   * would reload the fixture it started from and prove nothing about the save.
   */
  let briefs = [...(opts.briefs ?? [holeyBrief])];
  let revision = "r1";
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
    if (method === "PUT" && u.startsWith(`${API}/campaigns/briefs/`)) {
      const saved = parsed as { id: string };
      briefs = briefs.map((brief) => ((brief as { id: string }).id === saved.id ? saved : brief));
      revision = "r2";
      return Promise.resolve(json({ file: `${saved.id}.yaml`, revision, brief: saved }));
    }
    if (method === "GET" && u.startsWith(`${API}/campaigns/briefs`)) {
      return Promise.resolve(
        json({
          briefs: briefs.map((brief) => ({
            file: `${(brief as { id: string }).id}.yaml`,
            revision,
            brief,
          })),
        }),
      );
    }
    if (u.includes("/campaigns/plan")) {
      return Promise.resolve(opts.plan?.() ?? json(okPlan(emittedFor(parsed))));
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
/**
 * The rows, counted as list ITEMS rather than as buttons: since SL4 a row holds
 * two buttons (the row itself and its delete), so counting buttons would count
 * the controls and not the creatives.
 */
const rows = () => within(list()).queryAllByRole("listitem");
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

const show = (id: string) => (
  <>
    <DirtyProbe />
    <BriefEditor briefId={id} />
  </>
);

const ready = async (id: string) => {
  await waitFor(() =>
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id),
  );
  await settle();
};

const mountWith = async (id: string, opts: Parameters<typeof routes>[0]) => {
  const calls = routes(opts);
  const view = renderWithRun(show(id));
  await ready(id);
  return { calls, view };
};

const mount = async (id = "holey", opts: Parameters<typeof routes>[0] = {}) =>
  (await mountWith(id, opts)).calls;

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
    expect(lastCell(calls).tone).toBe("subtle");
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
    // SL4: the document still says two slots are live and the answer carries
    // one, which is exactly the shortfall the pending line counts — but the
    // answer is IN, so nothing is being made and the line must not appear. A
    // pending notice keyed on the shortfall alone would stand here forever.
    expect(screen.queryByText(messages.creativeDrawing)).toBeNull();
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

/* ------------------------------------------------------------------------- *
 * SL4 — add and delete, the owner's third ask: *"User should be able to add
 * and delete the creatives."*
 *
 * What the gestures DO to the plan — a delete leaving every survivor
 * byte-identical, an add allocating above every index ever used — is asserted
 * against the real planner in `editor-state.creative-slots.test.ts`, because a
 * mocked route cannot prove it. What is asserted here is the half that only the
 * shipping editor has: what the operator presses, what the editor then SENDS,
 * what the list shows in between, and what survives a save and a reload.
 * ------------------------------------------------------------------------- */

const deleteControl = (slot: number) =>
  screen.queryByRole("button", { name: messages.creativeDeleteLabel(slot) });
const addControl = () => screen.getByRole("button", { name: messages.creativeAdd });
type Variation = { count?: number; occupancy?: unknown };
/** The variation block of the LAST plan request — what the editor is asking for now. */
const askedFor = (calls: readonly Call[]): Variation =>
  (planCalls(calls).at(-1)?.body as { variation?: Variation } | undefined)?.variation ?? {};
const savedBodies = (calls: readonly Call[]) =>
  calls
    .filter((c) => c.method === "PUT" && c.url.includes("/campaigns/briefs/"))
    .map((c) => c.body as { variation?: Variation });

/**
 * A brief whose axes can produce exactly one creative: one layout, one tone, one
 * background, one palette shift, one static platform, one product. Its single
 * slot is therefore both the last live creative AND the whole of what the axes
 * can draw, so it is the fixture for both refusals.
 */
const singleBrief = {
  ...base,
  id: "single",
  mode: "variation",
  variation: {
    count: 1,
    axes: {
      layout: ["headline-top"],
      tone: ["bold"],
      // The ratio axis is absent-means-every-ratio, so it has to be named: an
      // unnamed ratio axis is three combinations, not one.
      ratio: ["1:1"],
      background: { source: ["procedural"] },
      paletteShift: [0],
    },
  },
  output: { formats: ["static"], platforms: ["linkedin"] },
};

describe("(6) deleting a creative", () => {
  test("the row goes at once, the request carries a tombstone, and count is untouched", async () => {
    const user = userEvent.setup();
    const calls = await mount();
    // What the editor was asking for before the gesture: three slots allocated,
    // the middle one already deleted, `count` of three.
    expect(askedFor(calls)).toMatchObject({
      count: 3,
      occupancy: { nextIndex: 3, tombstoned: [1] },
    });
    expect(rows()).toHaveLength(2);

    await user.click(deleteControl(2)!);

    // **Before the planner has been asked anything.** The slot is gone from the
    // document, so a row for it would be the list lying about what exists for as
    // long as the debounce and the round trip take. A delete that waited for the
    // answer passes every assertion below this one and fails this.
    expect(rows()).toHaveLength(1);
    expect(row(0)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${messages.creativeRowLabel(2)}`) }),
    ).toBeNull();

    await settle();

    // And what it then asked the planner for: the same recipe, one more
    // tombstone. `count` is the recipe's target cardinality (SL-D5) and the
    // gesture does not touch it — an add that raised it would re-open the
    // exhaustive search, and a delete that lowered it would strand a brief whose
    // plan that search produced.
    expect(askedFor(calls)).toMatchObject({
      count: 3,
      occupancy: { nextIndex: 3, tombstoned: [1, 2] },
    });
    expect(rows()).toHaveLength(1);
  });

  test("it asks nothing first — ⌘Z is the undo, and it brings the same creative back", async () => {
    const user = userEvent.setup();
    const calls = await mount();
    expect(row(2).textContent).toContain("Twocreative");

    await user.click(deleteControl(2)!);
    // No confirm. The delete is a draft edit like any other: nothing is on disk
    // until Save, and the chord below reverses it exactly.
    expect(screen.queryByRole("dialog")).toBeNull();
    await settle();
    expect(rows()).toHaveLength(1);

    await user.keyboard("{Meta>}z{/Meta}");
    await settle();

    // The SAME creative, at the same slot, with the same draw — which is what
    // makes ⌘Z an undo and a re-add not one. The request says so too: the
    // tombstone is gone and `count` never moved.
    expect(rows()).toHaveLength(2);
    expect(row(2).textContent).toContain("Twocreative");
    expect(askedFor(calls)).toMatchObject({
      count: 3,
      occupancy: { nextIndex: 3, tombstoned: [1] },
    });
  });

  test("deleting the selected creative retires the selection rather than leaving the rail on it", async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(row(2));
    await settle();
    // The positive half first: the rail really is composing slot 2's own draw,
    // so its disappearance below is a retirement and not a rail that never
    // showed anything.
    expect(railShows("Twocreative")).toBeGreaterThan(0);

    await user.click(deleteControl(2)!);
    await settle();

    // D139: a selection that names nothing retires. The rail is back on the
    // brief's own words, and no row is pressed.
    expect(railShows("Twocreative")).toBe(0);
    expect(railShows("Hi")).toBeGreaterThan(0);
    expect(row(0).getAttribute("aria-pressed")).toBe("false");
  });

  test("the last remaining creative carries no delete control, and the panel says why", async () => {
    const user = userEvent.setup();
    await mount();
    // The positive half: with two creatives, both rows offer the gesture.
    expect(deleteControl(0)).toBeTruthy();
    expect(deleteControl(2)).toBeTruthy();
    expect(screen.queryByText(messages.creativeDeleteLastNote)).toBeNull();

    await user.click(deleteControl(2)!);
    await settle();

    // One left. A control that is offered and then refuses is the defect
    // DESIGN.md §1.5 names, so it is not offered — and the reason is on screen
    // rather than left for the operator to infer from a dead button.
    expect(rows()).toHaveLength(1);
    expect(deleteControl(0)).toBeNull();
    expect(screen.getByText(messages.creativeDeleteLastNote)).toBeTruthy();
  });
});

describe("(7) adding a creative", () => {
  test("a fresh slot above every index ever used, and count is untouched", async () => {
    const user = userEvent.setup();
    const calls = await mount();
    expect(rows()).toHaveLength(2);

    await user.click(addControl());

    // Nothing is invented while the planner draws it: an undrawn creative has no
    // axes, no seed and no look, and this list has never fabricated one
    // (D26/D142). It says the slot is coming instead.
    expect(rows()).toHaveLength(2);
    expect(screen.getByText(messages.creativeDrawing)).toBeTruthy();

    await settle();

    // The new slot is the cursor — slot 3, "Creative 4" — and NOT the hole at
    // slot 1. A scheme that reused the lowest tombstoned slot would also produce
    // one more row here, which is why the fixture starts with a hole in it.
    expect(rows()).toHaveLength(3);
    expect(row(3).textContent).toContain("Threecreative");
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${messages.creativeRowLabel(1)}`) }),
    ).toBeNull();
    expect(askedFor(calls)).toMatchObject({
      count: 3,
      occupancy: { nextIndex: 4, tombstoned: [1] },
    });
    // And the line comes down when the answer lands — a pending notice that
    // never went away would be the worse lie.
    expect(screen.queryByText(messages.creativeDrawing)).toBeNull();
    // The creatives that were already there are untouched, rows and all.
    expect(row(0).textContent).toContain("Zerocreative");
    expect(row(2).textContent).toContain("Twocreative");
  });

  test("add is refused when the axes cannot produce another creative, and says so", async () => {
    await mount("single", { briefs: [singleBrief] });
    expect(rows()).toHaveLength(1);

    expect((addControl() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(messages.creativeAddBlocked)).toBeTruthy();
  });

  test("a brief with room in its axes offers the gesture", async () => {
    // The positive half of the refusal above, in the same words: nothing on
    // screen for the blocked reason, and the control is live.
    await mount();
    expect((addControl() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(messages.creativeAddBlocked)).toBeNull();
  });
});

describe("(8) the round trip — a gesture survives a save and a reload", () => {
  test("add, delete, Save, reload: the occupancy comes back and so do the creatives", async () => {
    const user = userEvent.setup();
    const { calls, view } = await mountWith("holey", {});

    await user.click(addControl());
    await settle();
    await user.click(deleteControl(0)!);
    await settle();
    expect(rows()).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(savedBodies(calls)).toHaveLength(1));

    // What went to disk: the cursor the add advanced, both tombstones, and the
    // `count` neither gesture touched.
    expect(savedBodies(calls)[0]!.variation).toMatchObject({
      count: 3,
      occupancy: { nextIndex: 4, tombstoned: [0, 1] },
    });

    // Reload the editor against the stored brief — a different mount reading
    // what the save wrote, which is the only form of this claim that means
    // anything.
    view.unmount();
    renderWithRun(show("holey"));
    await ready("holey");

    // The same two creatives, at the same slots, and the reloaded draft asks the
    // planner the same question the saved one did.
    expect(rows()).toHaveLength(2);
    expect(row(2).textContent).toContain("Twocreative");
    expect(row(3).textContent).toContain("Threecreative");
    expect(askedFor(calls)).toMatchObject({
      count: 3,
      occupancy: { nextIndex: 4, tombstoned: [0, 1] },
    });
  });

  test("a brief that never had occupancy saves without acquiring one (SL1's back-compat)", async () => {
    const user = userEvent.setup();
    const calls = await mount("dense", { briefs: [denseBrief] });
    // The absent block resolves to the count, so the brief has three creatives
    // and no `occupancy` key — the pre-SL1 document, behaving as it does today.
    expect(rows()).toHaveLength(3);
    expect(askedFor(calls).occupancy).toBeUndefined();

    // An ordinary edit, not a creative gesture, and a save.
    const audience = screen.getByLabelText("Target Audience") as HTMLInputElement;
    await user.clear(audience);
    await user.type(audience, "commuters");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(savedBodies(calls)).toHaveLength(1));

    // The key is still absent. A `toBrief` that derived the block from `count`
    // would write `occupancy: { nextIndex: 3 }` here, and every existing
    // campaign's YAML would churn on its first save.
    const variation = savedBodies(calls)[0]!.variation!;
    expect(variation.count).toBe(3);
    expect(Object.keys(variation)).not.toContain("occupancy");
  });
});
