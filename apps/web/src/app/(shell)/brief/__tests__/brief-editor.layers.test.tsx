import { describe, test, expect, beforeEach, vi } from "vitest";
import { createElement, memo, useState, type ComponentType } from "react";
import { screen, waitFor, within, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun as renderWithShell, json, nextMock } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { CreateCampaignDialog } from "@/components/shell/CreateCampaignDialog";
import { BrowseBriefsButton } from "@/components/shell/Sidebar";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import * as messages from "@/components/campaign/messages";
import { BriefEditor } from "@/components/campaign/BriefEditor";
import type { LayerStackProps } from "@/components/campaign/LayerStack";

/**
 * CC3, through the editor that ships: **one stack, in the rail, and it does not
 * re-render on a keystroke.**
 *
 * Three properties, none of which the component's own suite can see:
 *
 * 1. Exactly one layer stack is MOUNTED (the plan's §4.6). The count has to be
 *    of mounts, not of visible rows: the rail's container query hides without
 *    unmounting, and happy-dom applies no CSS at all, so a test that counted
 *    rendered nodes would pass on two stacks. The count is over the add-offer
 *    GROUP, which is structurally part of any layer stack whoever writes it —
 *    a `data-testid` on this lane's own component would not notice a
 *    hand-rolled second copy in the form.
 * 2. Picking a layer dirties nothing (D139). The selection is local component
 *    state, so a loaded brief stays byte-identical and the unsaved-work guard
 *    has nothing to ask about.
 * 3. A look-preserving keystroke does not re-render the stack. This is the half
 *    of CC1/CC2's contract that fetch counts cannot see — #469 regressed
 *    exactly here with every network assertion green, because a freshly
 *    allocated prop object defeats a `memo`-wrapped child while the fetch key
 *    underneath it stays stable. So the stack's renders are counted.
 */

/** Renders of the STACK itself, behind a memo boundary over the props the editor passes. */
const stackRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/components/campaign/LayerStack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/campaign/LayerStack")>();
  const Counting = memo(function CountingStack(props: LayerStackProps) {
    stackRenders.count += 1;
    return createElement(actual.LayerStack, props);
  });
  return { ...actual, LayerStack: Counting };
});

/**
 * Commits of the editor's form, so "the form woke up" is a number too.
 *
 * SG1 — this counts ONE section (`IdentitySection`), deliberately. It used to
 * count every section, which was the same thing while `guided` mounted exactly
 * one of them at a time: one commit, one render. The column mounts all of them,
 * so the aggregate would be "one commit" × "however many sections this mode
 * renders" and the exact-count assertion below would read 6 or 7 and mean 1.
 * Counting a single always-mounted section keeps the number a COMMIT count,
 * which is what the cost contract is about.
 */
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
  };
});

/**
 * The map paints hundreds of SVG nodes per mount under happy-dom and has its own
 * suite; a stub keeps this file about the layers.
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

/**
 * A loaded brief whose LOOK is fully specified — `layout` and `tone` are both
 * needed or `previewLook` answers nothing and the rail shows its empty state.
 * That branch matters here (the stack must mount in it too) and is tested for
 * itself below, so the default fixture is the one that draws.
 */
const layerBrief = {
  schemaVersion: 1,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "layers",
  mode: "brief",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
  treatments: [{ id: "t1", layout: "headline-bottom" as const, tone: "bold" as const }],
  output: { formats: ["static"], platforms: ["linkedin"] },
};

/**
 * A SECOND brief, and it deliberately shares the first one's layer ids.
 *
 * Both are seeded from the same canonical template, so `accent` resolves in
 * either. That is what makes the brief-switch reset a separate fact from the
 * layer-removal one: a pick carried across a load would still name a row, so
 * the highlight would survive and be pointing at another brief's layer.
 */
const otherBrief = { ...layerBrief, id: "other", campaignName: "other" };

const routes = (briefs: readonly unknown[] = [layerBrief]) => {
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
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
};

/** Longer than the frame debounce, so anything that would settle has. */
const settle = () => new Promise((r) => setTimeout(r, 400));

const rail = () => screen.getByRole("complementary", { name: messages.previewLegend });

/**
 * "A layer stack", identified by the add-offer group rather than by any marker
 * this lane's own component happens to carry: whoever renders a stack renders
 * that group, so the count answers "how many stacks are mounted" even for a
 * copy written by hand somewhere else.
 */
const mountedStackCount = () =>
  screen.queryAllByRole("group", { name: messages.templateAddLabel }).length;
/** The same count through the component's own mount marker — the secondary read. */
const markedStackCount = () => document.querySelectorAll('[data-testid="layer-stack"]').length;

const mountEditor = async (briefs?: readonly unknown[]) => {
  routes(briefs);
  renderWithRun(<BriefEditor briefId="layers" />);
  await waitFor(() =>
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("layers"),
  );
  await settle();
};

/**
 * SG4 — the view switch is the MIDDLE column's now, not the rail's, so the YAML
 * is read there. The switch is found by its group, which is the control's own
 * landmark and is not inside the rail.
 */
const viewSwitch = () => screen.getByRole("group", { name: messages.columnViews });

/** The column's YAML projection, as text — the serialised brief, byte for byte. */
const columnYaml = async (user: ReturnType<typeof userEvent.setup>) => {
  // SG10-b: the YAML view is reached from the action bar's `⋯` now, not from a
  // segment of the switcher — the owner's "tuck it in as a menu item". The view,
  // and everything these tests read off it, is unchanged.
  await user.click(screen.getByText("⋯"));
  await user.click(await screen.findByText(messages.editorYamlItem));
  const yaml = screen.getByTestId("column-yaml").textContent ?? "";
  await user.click(within(viewSwitch()).getByRole("button", { name: messages.columnEditorView }));
  return yaml;
};

const pick = (id: string, name: string) =>
  within(rail()).getByRole("button", {
    name: id,
    description: messages.layerSelectDescription(name),
  });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("cf:brief-picked", "1");
  stackRenders.count = 0;
  formRenders.count = 0;
});

describe("the layer stack exists exactly once in the tree (CC3, plan §4.6)", () => {
  /**
   * SG1 — this test used to WALK to the Template step first, because the step
   * card was the one place a second stack could be mounted at all. The column
   * mounts every section at once, so the count is taken over the whole editor
   * with no navigation: a section that still rendered a stack of its own shows
   * up here immediately. (The two tests this replaces were the guided walk and
   * its Everything twin; they asserted the same count twice.)
   */
  test("it is mounted in the rail, and the Template section points at it instead of holding one", async () => {
    await mountEditor();

    // The Template section is on screen from the start now.
    expect(document.getElementById("template")).toBeTruthy();

    // One stack, by the structural count and by the marker.
    expect(mountedStackCount()).toBe(1);
    expect(markedStackCount()).toBe(1);
    // And it is in the rail, not in the column (D44).
    const group = screen.getByRole("group", { name: messages.templateAddLabel });
    expect(rail().contains(group)).toBe(true);
    expect((document.getElementById("template") as HTMLElement).contains(group)).toBe(false);
    // The section still says where its controls went: a section gone quiet reads
    // as a failure, and the html element editor is still the section's to host
    // until CC4's sheet takes it.
    expect(screen.getByText(messages.templateStackInRail)).toBeTruthy();
  });

  test("the stack is there while the YAML view is up, and while the preview has nothing to draw", async () => {
    const user = userEvent.setup();
    await mountEditor();

    // SG4 — the switch moved to the middle column and it must not reach into the
    // rail: the only layer stack in the tree lives there, so a switch that swapped
    // the rail as well as the column would hide the layers behind a read-only view
    // of the document. The stack is counted while `yaml` is showing, and the
    // switch's own group is asserted to be OUTSIDE the rail, so this cannot pass
    // by finding a second control that happens to sit in the right place.
    expect(rail().contains(viewSwitch())).toBe(false);
    await user.click(screen.getByText("⋯"));
    await user.click(await screen.findByText(messages.editorYamlItem));
    expect(screen.getByTestId("column-yaml")).toBeTruthy();
    expect(mountedStackCount()).toBe(1);
    await user.click(within(viewSwitch()).getByRole("button", { name: messages.columnEditorView }));

    // And with no product id there is no creative to compose (D142) — but the
    // template is real either way. A stack that disappeared here would be a
    // failure presented as an empty result.
    await user.click(screen.getAllByRole("button", { name: messages.productRemove })[0]);
    await waitFor(() =>
      expect(within(rail()).getByText(messages.previewNeedsProductId)).toBeTruthy(),
    );
    expect(mountedStackCount()).toBe(1);
    expect(within(rail()).getByRole("list", { name: messages.templateListLabel })).toBeTruthy();
  });
});

describe("picking a layer changes no document byte (CC3, D139)", () => {
  test("the serialised brief is byte-identical and the unsaved-work guard has nothing to ask", async () => {
    const user = userEvent.setup();
    nextMock().nav.pathname = "/brief/layers";
    routes();
    renderWithRun(
      <>
        <BrowseBriefsButton />
        <BriefEditor briefId="layers" />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("layers"),
    );
    await settle();

    const before = await columnYaml(user);
    // A real projection, not an empty string: an assertion that two blanks are
    // equal would pass whatever the click did.
    expect(before).toContain("schemaVersion");
    expect(before).toContain("layers");

    await user.click(pick("accent", "Accent"));
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("true");
    expect(await columnYaml(user)).toBe(before);

    // The guard asks only about unsaved work, so its silence IS the dirty flag
    // (D67): a selection that had reached `EditorState` would open this dialog.
    await user.click(screen.getByRole("button", { name: /Create new/ }));
    await screen.findByRole("dialog", { name: messages.createCampaignTitle });
    expect(screen.queryByRole("dialog", { name: messages.confirmDialogTitle })).toBeNull();
  });

  test("the pick follows the LAYER across a reorder, and is gone when the layer is", async () => {
    const user = userEvent.setup();
    await mountEditor();
    const rows = () => within(rail()).getAllByRole("listitem");

    // Canonical image-text, bottom first: image, shade, accent, static-text, logo.
    await user.click(pick("accent", "Accent"));
    await user.click(
      within(rail()).getByRole("button", {
        name: "accent",
        description: messages.templateMoveUpDescription("Accent"),
      }),
    );
    expect(rows()[2].textContent).toContain("static-text");
    expect(rows()[3].textContent).toContain("accent");

    // The editor holds the selection as an ID, so it followed the layer. Held
    // as an index it would have stayed in slot 2 and now name `static-text` —
    // the invariant `CopyTimeline.vo.ts` states for the persisted key beat, and
    // the reason the tape's own beat selection is retired on an edit instead.
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("true");
    expect(pick("static-text", "Static text").getAttribute("aria-pressed")).toBe("false");

    // And removing the picked layer leaves nothing picked — the id names no row.
    await user.click(
      within(rail()).getByRole("button", {
        name: "accent",
        description: messages.templateRemoveDescription("Accent"),
      }),
    );
    expect(rows()).toHaveLength(4);
    // Scoped to the list: the rail's own view switcher carries `aria-pressed`
    // too, and its eye button is legitimately pressed.
    expect(
      within(within(rail()).getByRole("list", { name: messages.templateListLabel })).queryAllByRole(
        "button",
        { pressed: true },
      ),
    ).toEqual([]);
  });

  test("the sibling proof: switching a layer off DOES dirty it — so the silence above means something", async () => {
    const user = userEvent.setup();
    nextMock().nav.pathname = "/brief/layers";
    routes();
    renderWithRun(
      <>
        <BrowseBriefsButton />
        <BriefEditor briefId="layers" />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("layers"),
    );
    await settle();

    const before = await columnYaml(user);
    await user.click(
      within(rail()).getByRole("button", {
        name: "accent",
        description: messages.templateDisableDescription("Accent"),
      }),
    );
    expect(await columnYaml(user)).not.toBe(before);
    await user.click(screen.getByRole("button", { name: /Create new/ }));
    expect(await screen.findByRole("dialog", { name: messages.confirmDialogTitle })).toBeTruthy();
  });
});

describe("the pick is retired when it stops naming anything (CC3, D139)", () => {
  /**
   * Two resets, two tests, because neither implies the other and a fix that
   * ships one of them is half a fix. Both were found in review on #474: the
   * stored id was never cleared, so a removed layer left it dangling and a
   * loaded brief inherited its predecessor's pick. Today's visible symptom is
   * a highlight that matches nothing; CC4's sheet READS this value to decide
   * what it hosts, which is where a dangling id stops being cosmetic.
   */

  test("removing the picked layer clears the stored id — a re-added layer of the same id is not pre-picked", async () => {
    const user = userEvent.setup();
    await mountEditor();
    await user.click(pick("shade", "Shade"));
    expect(pick("shade", "Shade").getAttribute("aria-pressed")).toBe("true");

    await user.click(
      within(rail()).getByRole("button", {
        name: "shade",
        description: messages.templateRemoveDescription("Shade"),
      }),
    );
    // The row is gone, so no rendering assertion can tell a cleared id from a
    // dangling one. Adding the kind back can: freed from its cap it rejoins the
    // offer, and `addLayer` derives the id from the kind deduplicated against
    // the ids held — so the new layer is `shade` again. A stale stored id
    // resolves to it and the fresh layer arrives pre-picked, which is the
    // defect, and is invisible until exactly this sequence.
    await user.click(
      within(screen.getByRole("group", { name: messages.templateAddLabel })).getByRole("button", {
        name: "shade",
      }),
    );
    expect(pick("shade", "Shade").getAttribute("aria-pressed")).toBe("false");
  });

  test("loading another brief does not inherit its predecessor's pick", async () => {
    /**
     * The route is the single source of truth for which brief is open (D37), so
     * a change of route id IS the load — the same path a reload or a shared link
     * takes. The two briefs share their layer ids on purpose: a pick carried
     * across the load would still resolve, so the highlight would survive while
     * naming a layer of a brief nobody is editing any more.
     */
    function Switchable() {
      const [id, setId] = useState("layers");
      return (
        <>
          <button type="button" onClick={() => setId("other")}>
            go to other
          </button>
          <BriefEditor briefId={id} />
        </>
      );
    }
    const user = userEvent.setup();
    routes([layerBrief, otherBrief]);
    renderWithRun(<Switchable />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("layers"),
    );
    await settle();

    await user.click(pick("accent", "Accent"));
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("true");

    await user.click(screen.getByRole("button", { name: "go to other" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("other"),
    );
    // The layer is still there — this is not "the row vanished", it is the same
    // canonical `accent` in a different document — and it is not picked.
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("false");
    expect(
      within(within(rail()).getByRole("list", { name: messages.templateListLabel })).queryAllByRole(
        "button",
        { pressed: true },
      ),
    ).toEqual([]);
  });
});

describe("the stack lives inside CC1/CC2's cost contract (CC3, C3)", () => {
  test("a keystroke that changes no layer does not re-render the stack", async () => {
    await mountEditor();
    // A zero here would make everything below vacuous.
    expect(stackRenders.count).toBeGreaterThan(0);
    const before = stackRenders.count;

    // `targetAudience` is in no layer, in no offer and in no frame request. If
    // any prop the stack is handed were freshly allocated per render — the
    // props object outside its memo, an inline arrow for the selection, a
    // derivation array rebuilt per keystroke — this climbs. The fetch-count
    // proofs would not notice: `usePreviewFrame` has a content key of its own.
    const audience = screen.getByLabelText("Target Audience") as HTMLInputElement;
    fireEvent.click(audience);
    audience.focus();
    fireEvent.change(audience, { target: { value: "a new audience" } });
    await settle();

    expect(stackRenders.count).toBe(before);
    // The keystroke really did commit — the form re-rendered. Without this the
    // assertion above could be satisfied by an editor that ignored the event.
    expect(formRenders.count).toBeGreaterThan(0);
  });

  test("the sibling proof: a layer edit DOES re-render it, so the memo is not simply frozen", async () => {
    const user = userEvent.setup();
    await mountEditor();
    const before = stackRenders.count;
    await user.click(
      within(rail()).getByRole("button", {
        name: "accent",
        description: messages.templateDisableDescription("Accent"),
      }),
    );
    expect(stackRenders.count).toBeGreaterThan(before);
    // And it redrew the right thing: the row now offers the way back.
    expect(
      within(rail()).getByRole("button", {
        name: "accent",
        description: messages.templateEnableDescription("Accent"),
      }),
    ).toBeTruthy();
  });

  test("picking a layer redraws the stack and costs the form nothing at all", async () => {
    const user = userEvent.setup();
    await mountEditor();
    const stackBefore = stackRenders.count;
    formRenders.count = 0;

    await user.click(pick("shade", "Shade"));
    // The stack must redraw: the row is pressed now.
    expect(stackRenders.count).toBeGreaterThan(stackBefore);
    /**
     * And the form commits ZERO times.
     *
     * **This number CHANGED, from one to zero, and it is declared rather than
     * relaxed.** The selection is `BriefEditor`'s own `useState` because CC4's
     * sheet is a sibling of the column (D44) and has to read it, so the state
     * cannot live under a memo boundary the way the playhead's does — a pick is
     * therefore still a commit of `BriefEditor` itself, exactly as it was. What
     * changed is what that commit costs: SG4's review remediation memoised
     * `columnPanels`, and `pickedLayerId` is not one of its inputs, so the record
     * survives the render, `{columnPanels[columnView]}` hands React the identical
     * element, and the form's subtree is not reconciled at all. The gesture now
     * redraws the surface it touched and nothing else.
     *
     * Zero rather than one is why this assertion is still exact. It used to read
     * `toBe(1)` to pin a CASCADE — two commits for one gesture — with the one
     * commit named as the accepted cost. Zero pins strictly more: it goes red both
     * for a cascade and for the loss of the memo above it (`sg4.json`'s eighth
     * mutation is the other half of that guard, in the playhead file).
     *
     * **RS2 nearly made it two, and this is the test that said so.** The rail is
     * published through `EditorPanelsContext`, and `pickedLayerId` is one of the
     * values the rail reads — so while the setters lived on the same context as
     * the slots, publishing re-rendered the publisher: gesture → render →
     * effect → `setRail` → context change → render. The setters are a separate
     * context now (`useEditorPanelPublisher`), so the editor subscribes to
     * nothing it publishes into. That fix is what makes zero reachable here; both
     * commits would have had to bail, and only one of them could.
     */
    expect(formRenders.count).toBe(0);
  });
});

/**
 * CE1 — the creative itself as a way in to a layer, measured through the editor
 * that ships, because the claim is about two surfaces agreeing.
 *
 * The regions' own behaviour is `preview-hit-regions.test.tsx`'s. What only
 * this file can see is that **there is one selection, reached two ways**: the
 * region and the row are handed the same `pickedLayerId` and the same
 * `pickLayer`, so a click on the creative lights the row and a click on the row
 * lights the region. A second selection concept would pass every component-level
 * assertion and fail here.
 *
 * The fixture is an `image-html` template, because an html element's `frame` is
 * the only DECLARED geometry in the vocabulary — every other layer's position
 * is decided by a layout engine (`anchorFirstY` over a measured span and type
 * size, and the logo's snap against that measured block), so none of them is
 * hit-testable and all of them stay reachable through the list. The canonical
 * `image-text` brief the rest of this file uses therefore has no regions at
 * all, which is asserted below rather than assumed.
 */
const htmlElementBrief = {
  schemaVersion: 1,
  template: {
    id: "canonical-image-html",
    version: 1,
    creativeType: "image-html",
    unit: "standard-web",
    layers: [
      { id: "image", kind: "image" },
      {
        id: "html",
        kind: "html",
        elements: [
          { kind: "text", text: "Hello", frame: { x: 0.1, y: 0.2, w: 0.5, h: 0.3, anchor: "top" } },
        ],
      },
    ],
  },
  id: "layers",
  mode: "brief",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
  treatments: [{ id: "t1", layout: "headline-bottom" as const, tone: "bold" as const }],
  output: { formats: ["html"], platforms: ["linkedin"] },
};

/** The region drawn over the creative — named by the raw layer id, like every control in the stack (D18). */
const region = () =>
  within(rail()).getByRole("button", {
    name: "html",
    description: messages.previewRegionDescription("HTML", "Text"),
  });

/**
 * A whole-layer region over the creative (CE2) — the ground kinds' own way in,
 * named by the raw layer id exactly as the element region and the row are.
 */
const wholeRegion = (id: string, name: string) =>
  within(rail()).getByRole("button", {
    name: id,
    description: messages.previewWholeLayerRegionDescription(name),
  });

/** Mounts the html fixture and waits for the REAL frame: the regions ride it, never the placeholder. */
const mountWithFrame = async () => {
  await mountEditor([htmlElementBrief]);
  await waitFor(() => expect(rail().querySelector("img")).not.toBeNull());
};

/** Mounts the DEFAULT fixture — canonical `image-text`, the social-post preset — and waits for its frame. */
const mountDefaultWithFrame = async () => {
  await mountEditor();
  await waitFor(() => expect(rail().querySelector("img")).not.toBeNull());
};

/** `/preview-frame` calls only — the network count red fault 3 is about. */
const frameCallCount = () =>
  vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).includes("/preview-frame"))
    .length;

describe("the creative and the list are one selection (CE1)", () => {
  test("clicking the creative lights the row — read off the rendered list, not a spy", async () => {
    const user = userEvent.setup();
    await mountWithFrame();
    expect(pick("html", "HTML").getAttribute("aria-pressed")).toBe("false");

    await user.click(region());

    expect(pick("html", "HTML").getAttribute("aria-pressed")).toBe("true");
    expect(region().getAttribute("aria-pressed")).toBe("true");
  });

  test("clicking the row lights the region — the list's own path is unchanged", async () => {
    const user = userEvent.setup();
    await mountWithFrame();

    await user.click(pick("html", "HTML"));

    expect(region().getAttribute("aria-pressed")).toBe("true");
    expect(pick("html", "HTML").getAttribute("aria-pressed")).toBe("true");
  });

  /**
   * The two paths produce the IDENTICAL state, and neither breaks the other: a
   * pick made on the canvas is moved by a row, and a pick made on a row is
   * moved by the canvas. A second selection concept would leave one of the two
   * surfaces showing the stale layer here.
   */
  test("the two paths agree in both directions", async () => {
    const user = userEvent.setup();
    await mountWithFrame();

    await user.click(region());
    expect(pick("html", "HTML").getAttribute("aria-pressed")).toBe("true");
    expect(pick("image", "Image").getAttribute("aria-pressed")).toBe("false");

    // The row moves the pick the canvas made.
    await user.click(pick("image", "Image"));
    expect(pick("image", "Image").getAttribute("aria-pressed")).toBe("true");
    expect(region().getAttribute("aria-pressed")).toBe("false");

    // And the canvas moves the pick the row made.
    await user.click(region());
    expect(region().getAttribute("aria-pressed")).toBe("true");
    expect(pick("image", "Image").getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * Red fault 3 — a click is not a document change, so it asks the route for
   * nothing. `/preview-frame` is credit-free (D52 wires the procedural
   * generator directly), so this is about responsiveness rather than money:
   * re-fetching a frame because somebody selected something would be a plain
   * regression of CC1/CC2's contract.
   */
  test("selecting on the canvas issues zero preview-frame calls", async () => {
    const user = userEvent.setup();
    await mountWithFrame();
    const before = frameCallCount();
    // A zero here would make the assertion below vacuous: the frame is painted,
    // so the route HAS been asked, and what follows must add nothing.
    expect(before).toBeGreaterThan(0);

    await user.click(region());
    await settle();

    expect(frameCallCount()).toBe(before);
    // And the painted frame is still there — "no calls" must not mean "no frame".
    expect(rail().querySelector("img")).not.toBeNull();
    expect(pick("html", "HTML").getAttribute("aria-pressed")).toBe("true");
  });

  /**
   * Red fault 4 — D139: the pick is ephemeral state owned by the host. It is
   * not a field of `EditorState`, not a byte of the brief, and not a key in
   * `localStorage`; a remount starts with nothing picked.
   */
  test("a canvas pick persists nothing — a remount has no layer picked", async () => {
    const user = userEvent.setup();
    await mountWithFrame();
    // Read through the Storage interface, not `Object.keys`: the suite's
    // in-memory storage is a plain object whose own keys are its METHODS, so
    // `Object.keys` would compare the same six names before and after and
    // notice nothing at all.
    const storedKeys = () =>
      Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();
    const keysBefore = storedKeys();
    // The sentinel `beforeEach` writes is in there — a snapshot that read as
    // empty would make the comparison below true for the wrong reason.
    expect(keysBefore).toContain("cf:brief-picked");

    await user.click(region());
    expect(pick("html", "HTML").getAttribute("aria-pressed")).toBe("true");
    expect(storedKeys()).toEqual(keysBefore);

    cleanup();
    await mountWithFrame();
    expect(pick("html", "HTML").getAttribute("aria-pressed")).toBe("false");
    expect(region().getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * Red fault 5 — a click region over an image is invisible to a keyboard, so
   * these are real `<button>`s: focusable, named, and activated by the key a
   * button is activated by. The layer list remains the primary accessible path
   * and is asserted to still work above; this is the additional affordance
   * being reachable rather than mouse-only.
   */
  test("a keyboard user reaches the same behaviour: focus the region, press Enter", async () => {
    const user = userEvent.setup();
    await mountWithFrame();

    region().focus();
    expect(document.activeElement).toBe(region());
    await user.keyboard("{Enter}");

    expect(pick("html", "HTML").getAttribute("aria-pressed")).toBe("true");
  });

  /**
   * The element exclusion, through the editor: the canonical `image-text`
   * brief the rest of this file uses carries no `html` layer at all, so there
   * is no ELEMENT region over its creative. Its ground layer has one — that is
   * CE2's own block below — and the element vocabulary is untouched by it.
   */
  test("a template that declares no element frames puts no element region over the creative", async () => {
    await mountDefaultWithFrame();

    expect(
      within(rail()).queryAllByRole("button", {
        description: messages.previewRegionDescription("HTML", "Text"),
      }),
    ).toEqual([]);
  });
});

/**
 * CE2 — the same claim, on the template a new campaign actually gets.
 *
 * CE1 built the regions out of an element's DECLARED frame, which is the right
 * geometry and reaches almost nothing: only an `html` layer may carry elements,
 * and the social-post preset resolves to canonical `image-text`, which has no
 * `html` layer. So the feature was inert on every new campaign — an operator
 * clicked the creative and nothing happened.
 *
 * The extension is the one CE1 named: the GROUND kinds (`image`, `video`) are
 * drawn by `paintBackground` at `(0, 0, width, height)`, so a region over the
 * whole canvas is that layer's own draw rect rather than a guess. Nothing else
 * gains one — see `preview-hit-regions.test.tsx` for the exclusions and why.
 *
 * These tests run the DEFAULT fixture (`layerBrief`, `templateFromCanonical`
 * of `DEFAULT_CAMPAIGN_TYPE`) deliberately: the lane's whole premise is that
 * the campaign nobody configured is the one that has to work.
 */
describe("the default template is clickable (CE2)", () => {
  test("a default campaign has a region over its creative, and clicking it lights the image row", async () => {
    const user = userEvent.setup();
    await mountDefaultWithFrame();
    expect(pick("image", "Image").getAttribute("aria-pressed")).toBe("false");

    await user.click(wholeRegion("image", "Image"));

    expect(pick("image", "Image").getAttribute("aria-pressed")).toBe("true");
    expect(wholeRegion("image", "Image").getAttribute("aria-pressed")).toBe("true");
  });

  test("the default creative and its list agree in both directions", async () => {
    const user = userEvent.setup();
    await mountDefaultWithFrame();

    await user.click(wholeRegion("image", "Image"));
    expect(pick("image", "Image").getAttribute("aria-pressed")).toBe("true");

    // The row moves the pick the canvas made — onto a layer with no region of
    // its own, which must leave the canvas showing nothing picked.
    await user.click(pick("accent", "Accent"));
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("true");
    expect(wholeRegion("image", "Image").getAttribute("aria-pressed")).toBe("false");

    // And the canvas moves the pick the row made.
    await user.click(wholeRegion("image", "Image"));
    expect(wholeRegion("image", "Image").getAttribute("aria-pressed")).toBe("true");
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("false");
  });

  /** CE1's cost assertion, on the default path: a click is not a document change. */
  test("selecting the default creative issues zero preview-frame calls", async () => {
    const user = userEvent.setup();
    await mountDefaultWithFrame();
    const before = frameCallCount();
    // A zero here would make the assertion below vacuous.
    expect(before).toBeGreaterThan(0);

    await user.click(wholeRegion("image", "Image"));
    await settle();

    expect(frameCallCount()).toBe(before);
    expect(rail().querySelector("img")).not.toBeNull();
    expect(pick("image", "Image").getAttribute("aria-pressed")).toBe("true");
  });

  /** CE1's keyboard affordance, on the default path: a real button, focused and pressed. */
  test("a keyboard user reaches the default creative's region and presses it", async () => {
    const user = userEvent.setup();
    await mountDefaultWithFrame();

    wholeRegion("image", "Image").focus();
    expect(document.activeElement).toBe(wholeRegion("image", "Image"));
    await user.keyboard("{Enter}");

    expect(pick("image", "Image").getAttribute("aria-pressed")).toBe("true");
  });

  /**
   * The exclusions, through the editor. The canonical `image-text` template
   * carries every frameless kind CE2 declined — `shade`, `accent`,
   * `static-text`, `logo` — and not one of them gains a region; the list stays
   * their only way in, and is asserted still to work.
   */
  test("the frameless kinds stay list-only: no region is invented for shade, accent, text or logo", async () => {
    const user = userEvent.setup();
    await mountDefaultWithFrame();

    for (const [id, name] of [
      ["shade", "Shade"],
      ["accent", "Accent"],
      ["static-text", "Static text"],
      ["logo", "Logo"],
    ] as const) {
      expect(
        within(rail()).queryAllByRole("button", {
          description: messages.previewWholeLayerRegionDescription(name),
        }),
      ).toEqual([]);
      // The row is still there, and still picks.
      await user.click(pick(id, name));
      expect(pick(id, name).getAttribute("aria-pressed")).toBe("true");
    }
  });
});

/**
 * CC4 — the layer sheet, through the editor that ships. `LayerPropsSheet`'s
 * own suite (`LayerPropsSheet.test.tsx`) pins its per-kind fields and its own
 * Escape/no-aria-modal contract in isolation; what only the mounted editor
 * can show is the mount SITE (a sibling of the step card, reading CC3's own
 * selection) and the four red faults, end to end.
 */
const sheetEl = () => screen.getByTestId("layer-props-sheet");

describe("CC4 — the sheet is a sibling of the step card, and reads CC3's selection", () => {
  test("no sheet exists before a layer is picked", async () => {
    await mountEditor();
    expect(screen.queryByTestId("layer-props-sheet")).toBeNull();
  });

  test("picking a layer mounts the sheet as a sibling — never inside the Template section or the rail", async () => {
    const user = userEvent.setup();
    await mountEditor();
    await user.click(pick("accent", "Accent"));
    const el = sheetEl();
    expect((document.getElementById("template") as HTMLElement | null)?.contains(el)).toBeFalsy();
    expect(rail().contains(el)).toBe(false);
  });

  test("closing the sheet clears the SAME pick — never a second selection concept", async () => {
    const user = userEvent.setup();
    await mountEditor();
    await user.click(pick("accent", "Accent"));
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("true");
    await user.click(within(sheetEl()).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("layer-props-sheet")).toBeNull();
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("K5 — the tracks form reaches the operator through the real editor", () => {
  /**
   * Mounted through `BriefEditor`, not through the sheet, and that is the whole
   * point of these two. `TrackForm.test.tsx` already drives the form itself; a
   * prop nobody passes is indistinguishable from one that does not exist
   * (D157), so the wiring at the sheet's real call site needs its own witness.
   */
  test("picking a trackable layer offers the tracks section", async () => {
    const user = userEvent.setup();
    await mountEditor();
    await user.click(pick("image", "Image"));
    expect(within(sheetEl()).getByTestId("layer-tracks")).toBeTruthy();
  });

  test("the clock select is live, which is only true if the playhead prop arrived", async () => {
    // `playhead` is typed `TrackPlayhead | null`, so a caller that forgot it
    // fails typecheck — but a caller passing a permanently-null literal would
    // still compile and still render. This asserts the section renders with its
    // control usable from the editor's own tree.
    const user = userEvent.setup();
    await mountEditor();
    await user.click(pick("image", "Image"));
    const select = within(sheetEl()).getByLabelText(messages.tracksClockLabel);
    expect((select as HTMLSelectElement).options.length).toBeGreaterThan(0);
  });
});

describe("CC4 — red fault 1: the creative stays visible with the sheet open", () => {
  test("the preview is still rendered, not merely that the sheet mounted", async () => {
    const user = userEvent.setup();
    await mountDefaultWithFrame();
    await user.click(pick("image", "Image"));
    expect(sheetEl()).toBeTruthy();
    expect(rail().querySelector("img")).not.toBeNull();
  });
});

describe("CC4 — red fault 2: ⌘Z still undoes with the sheet open, and it carries no aria-modal", () => {
  test("a geometry edit made through the sheet is undoable, with no [aria-modal] anywhere", async () => {
    const user = userEvent.setup();
    await mountEditor();
    const before = await columnYaml(user);

    await user.click(pick("accent", "Accent"));
    // The exact signal `editor-history.ts`'s `useHistoryKeys` reads for
    // switching ⌘Z off — absent, with the sheet open, is the whole claim.
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();

    const input = within(sheetEl()).getByLabelText(messages.layerPropSolidHeightLabel);
    fireEvent.change(input, { target: { value: "0.2" } });
    fireEvent.blur(input);
    const edited = await columnYaml(user);
    expect(edited).not.toBe(before);

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(await columnYaml(user)).toBe(before);
  });
});

describe("CC4 — red fault 3: set then clear leaves the brief byte-identical", () => {
  test("a geometry override, set then cleared through Reset, round-trips to the loaded YAML exactly", async () => {
    const user = userEvent.setup();
    await mountEditor();
    const before = await columnYaml(user);

    await user.click(pick("logo", "Logo"));
    const input = within(sheetEl()).getByLabelText(messages.layerPropWidthLabel);
    fireEvent.change(input, { target: { value: "0.3" } });
    fireEvent.blur(input);
    expect(await columnYaml(user)).not.toBe(before);

    const reset = within(sheetEl()).getByRole("button", {
      name: messages.layerPropResetLabel(messages.layerPropWidthLabel),
    });
    await user.click(reset);
    expect(await columnYaml(user)).toBe(before);
  });
});

describe("CC4 — red fault 4: a live run on one field is one undo entry, not one per commit", () => {
  test("four commits to one geometry field revert in a single ⌘Z", async () => {
    const user = userEvent.setup();
    await mountEditor();
    const before = await columnYaml(user);

    await user.click(pick("accent", "Accent"));
    const input = within(sheetEl()).getByLabelText(messages.layerPropSolidHeightLabel);
    for (const value of ["0.1", "0.15", "0.2", "0.24"]) {
      fireEvent.change(input, { target: { value } });
    }
    fireEvent.blur(input);
    expect(await columnYaml(user)).not.toBe(before);

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(await columnYaml(user)).toBe(before);
    // Nothing left to undo from this run — a second ⌘Z is a no-op, not a
    // partial revert of a run that was secretly four entries.
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(await columnYaml(user)).toBe(before);
  });
});
