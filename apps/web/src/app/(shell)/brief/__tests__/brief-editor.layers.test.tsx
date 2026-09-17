import { describe, test, expect, beforeEach, vi } from "vitest";
import { createElement, memo, useState, type ComponentType } from "react";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
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
import { sectionOrder } from "@/components/campaign/sections";
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

/** Renders of the editor's form sections, so "the form woke up" is a number too. */
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

/** The rail's YAML projection, as text — the serialised brief, byte for byte. */
const railYaml = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(within(rail()).getByRole("button", { name: messages.previewRailYamlView }));
  const yaml = within(rail()).getByText(/schemaVersion/).textContent ?? "";
  await user.click(within(rail()).getByRole("button", { name: messages.previewRailPreviewView }));
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
  localStorage.setItem("cf:presentation", "guided");
  stackRenders.count = 0;
  formRenders.count = 0;
});

describe("the layer stack exists exactly once in the tree (CC3, plan §4.6)", () => {
  test("it is mounted in the rail, and the Template step points at it instead of holding one", async () => {
    const user = userEvent.setup();
    await mountEditor();

    // Walk to the step that used to own the stack — the one place a second copy
    // would be, and the only step on which a leftover in `renderStepCard` is
    // mounted at all.
    const steps = [...sectionOrder("brief"), "review"];
    await user.click(
      within(screen.getByRole("navigation", { name: messages.segBarLabel })).getAllByRole("button")[
        steps.indexOf("template")
      ],
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Template"),
    );

    // One stack, by the structural count and by the marker.
    expect(mountedStackCount()).toBe(1);
    expect(markedStackCount()).toBe(1);
    // And it is in the rail, not in the walk's card (D44 — the card renders two
    // live copies during a step change and its transform traps overlays).
    const group = screen.getByRole("group", { name: messages.templateAddLabel });
    expect(rail().contains(group)).toBe(true);
    expect(screen.getByTestId("step-card").contains(group)).toBe(false);
    // The step still says where its controls went: a step gone quiet reads as a
    // failure, and the html element editor is still the step's to host until
    // CC4's sheet takes it.
    expect(screen.getByText(messages.templateStackInRail)).toBeTruthy();
  });

  test("one stack in Everything too, where every section is mounted at once", async () => {
    const user = userEvent.setup();
    await mountEditor();
    await user.click(screen.getByRole("button", { name: messages.presentationEverything }));
    await waitFor(() => expect(document.getElementById("template")).toBeTruthy());

    // Everything mounts the Template section and the rail simultaneously, so a
    // section that still rendered a stack shows up here without any walking.
    expect(mountedStackCount()).toBe(1);
    expect(markedStackCount()).toBe(1);
    expect(rail().contains(screen.getByRole("group", { name: messages.templateAddLabel }))).toBe(
      true,
    );
  });

  test("the stack is there while the YAML view is up, and while the preview has nothing to draw", async () => {
    const user = userEvent.setup();
    await mountEditor();

    // D61's switcher is exclusive between the composed preview and the YAML —
    // the layers are neither, and the only stack in the tree must not vanish
    // behind a read-only view.
    await user.click(within(rail()).getByRole("button", { name: messages.previewRailYamlView }));
    expect(mountedStackCount()).toBe(1);
    await user.click(within(rail()).getByRole("button", { name: messages.previewRailPreviewView }));

    // And with no product id there is no creative to compose (D142) — but the
    // template is real either way. A stack that disappeared here would be a
    // failure presented as an empty result.
    const steps = [...sectionOrder("brief"), "review"];
    await user.click(
      within(screen.getByRole("navigation", { name: messages.segBarLabel })).getAllByRole("button")[
        steps.indexOf("products")
      ],
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Products"),
    );
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

    const before = await railYaml(user);
    // A real projection, not an empty string: an assertion that two blanks are
    // equal would pass whatever the click did.
    expect(before).toContain("schemaVersion");
    expect(before).toContain("layers");

    await user.click(pick("accent", "Accent"));
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("true");
    expect(await railYaml(user)).toBe(before);

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

    const before = await railYaml(user);
    await user.click(
      within(rail()).getByRole("button", {
        name: "accent",
        description: messages.templateDisableDescription("Accent"),
      }),
    );
    expect(await railYaml(user)).not.toBe(before);
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

  test("picking a layer redraws the stack and costs the form exactly one commit — the accepted cost, stated", async () => {
    const user = userEvent.setup();
    await mountEditor();
    const stackBefore = stackRenders.count;
    formRenders.count = 0;

    await user.click(pick("shade", "Shade"));
    // The stack must redraw: the row is pressed now.
    expect(stackRenders.count).toBeGreaterThan(stackBefore);
    /**
     * And the form commits ONCE — not zero.
     *
     * The selection is `BriefEditor`'s own `useState` because CC4's sheet is a
     * sibling of the step card (D44) and has to read it, so the state cannot
     * live under the memo boundary the way the playhead's does. That makes a
     * pick a commit of the editor, exactly like a press on any other control,
     * and this number is here to say so rather than to hide it: the cost
     * contract is about the PER-KEYSTROKE path (C3), where the assertions above
     * hold at zero. A count above one would be a cascade — two commits for one
     * gesture — and is what this pins.
     */
    expect(formRenders.count).toBe(1);
  });
});
