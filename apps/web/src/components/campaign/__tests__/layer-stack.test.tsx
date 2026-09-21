import { describe, test, expect, vi } from "vitest";
import { useReducer, useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  editorReducer,
  fromBrief,
  initialEditorState,
  normalizeDraftState,
  toBrief,
  type EditorAction,
  type EditorState,
} from "@/components/campaign/editor-state";
import { removableLayerIds } from "@/components/campaign/derive";
import { layerKindDisplayName } from "@/components/campaign/display-names";
import { LayerStack } from "../LayerStack";
import { layerStackProps } from "../layer-stack-props";
import * as messages from "../messages";

/**
 * The layer stack (CC3), where it now lives: the creative rail, not the
 * Template step's form. These tests moved with the component, unchanged in
 * substance — the offers, the refusals, the ordering and the toggle are the same
 * domain rules they always pinned, and `premise CC3`'s disposition moved WHERE
 * the stack is, never WHAT it may do. What is new here is at the foot of the
 * file: the selection (D139) and the props seam the rail's memo boundary keys on.
 *
 * Every render goes through `layerStackProps`, the same function `BriefEditor`
 * feeds the rail with, so no test fixture is a second definition of how the
 * stack is fed.
 */

const state = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState(),
  ...over,
});

/** The add offer, scoped so a list row's remove control can never answer for it. */
const addGroup = () => within(screen.getByRole("group", { name: messages.templateAddLabel }));
/** The layer list, scoped the same way — the two offers never share a query. */
const list = () => within(screen.getByRole("list", { name: messages.templateListLabel }));

/**
 * The stack as the editor mounts it: state through `layerStackProps`, selection
 * as the host's own ephemeral state (D139). A static `state` with a `vi.fn()`
 * dispatch renders exactly the tree `BriefEditor` renders.
 */
function Stack({
  state,
  dispatch,
}: {
  state: EditorState;
  dispatch: (action: EditorAction) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <LayerStack
      {...layerStackProps(state)}
      dispatch={dispatch}
      selectedLayerId={picked}
      onSelectLayer={setPicked}
    />
  );
}

/**
 * A real-reducer harness: add and remove go through `editorReducer`, so the
 * round-trip tests exercise the editor's actual save path (`toBrief`) and its
 * actual load path (`fromBrief`), not a mock of either.
 */
function Harness({ initial }: { initial: EditorState }) {
  const [state, dispatch] = useReducer(editorReducer, initial);
  return <Stack state={state} dispatch={dispatch} />;
}

describe("LayerStack — the layer list (L5, D124)", () => {
  test("renders every layer bottom first, each with its kind's display name and its id", () => {
    render(<Stack state={state()} dispatch={vi.fn()} />);
    const rows = screen.getAllByRole("listitem");
    // image-text's canonical list, in draw order — the array order the list renders.
    const expected = [
      ["Image", "image"],
      ["Shade", "shade"],
      ["Accent", "accent"],
      ["Static text", "static-text"],
      ["Logo", "logo"],
    ];
    expect(rows).toHaveLength(expected.length);
    expected.forEach(([name, id], index) => {
      expect(rows[index].textContent).toContain(name);
      expect(rows[index].textContent).toContain(id);
    });
  });

  test("add offers exactly addableKinds and dispatches the kind alone", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<Stack state={state()} dispatch={dispatch} />);
    // The fresh social post's decorated kinds sit at their own caps or fill the
    // shared text budget; the two unbounded kinds — `image` and, since L11,
    // `fill` — are what remain.
    expect(addGroup().getAllByRole("button")).toHaveLength(2);
    await user.click(addGroup().getByRole("button", { name: "image" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "addLayer", kind: "image" });
  });

  test("a kind at its limit is absent from the offer, never present-and-disabled", () => {
    render(<Stack state={state()} dispatch={vi.fn()} />);
    // The fresh social post's decorated kinds sit at their own caps or fill the
    // shared text budget — one expect per kind: the scanner refuses a literal
    // list of the vocabulary here (D121), and the failures read better apart.
    expect(addGroup().queryByRole("button", { name: "shade" })).toBeNull();
    expect(addGroup().queryByRole("button", { name: "accent" })).toBeNull();
    expect(addGroup().queryByRole("button", { name: "static-text" })).toBeNull();
    expect(addGroup().queryByRole("button", { name: "animated-text" })).toBeNull();
    expect(addGroup().queryByRole("button", { name: "logo" })).toBeNull();
    // And the one offered kind is its raw id — `image`, the unbounded one.
    expect(addGroup().getByRole("button", { name: "image" })).toBeTruthy();
  });

  test("the offer follows the list: a removed kind joins it, a re-added one leaves it", async () => {
    const user = userEvent.setup();
    // The real reducer strips `shade`, whose kind is then under its cap.
    render(<Harness initial={editorReducer(state(), { type: "removeLayer", id: "shade" })} />);
    expect(addGroup().getByRole("button", { name: "shade" })).toBeTruthy();
    await user.click(addGroup().getByRole("button", { name: "shade" }));
    // Held once, the kind is back at its cap — gone from the offer, not disabled.
    expect(addGroup().queryByRole("button", { name: "shade" })).toBeNull();
    // The shared text budget still holds: `animated-text` stays unoffered.
    expect(addGroup().queryByRole("button", { name: "animated-text" })).toBeNull();
  });

  test("a required layer has no remove control; a removable one does — and the sentence says why", () => {
    render(<Stack state={state()} dispatch={vi.fn()} />);
    expect(
      list().queryByRole("button", {
        name: "image",
        description: messages.templateRemoveDescription("Image"),
      }),
    ).toBeNull();
    expect(
      list().queryByRole("button", {
        name: "static-text",
        description: messages.templateRemoveDescription("Static text"),
      }),
    ).toBeNull();
    expect(
      list().getByRole("button", {
        name: "shade",
        description: messages.templateRemoveDescription("Shade"),
      }),
    ).toBeTruthy();
    expect(
      list().getByRole("button", {
        name: "accent",
        description: messages.templateRemoveDescription("Accent"),
      }),
    ).toBeTruthy();
    expect(
      list().getByRole("button", {
        name: "logo",
        description: messages.templateRemoveDescription("Logo"),
      }),
    ).toBeTruthy();
    expect(screen.getByText(messages.templateRequiredNote(["Image", "Static text"]))).toBeTruthy();
  });

  test("removing a layer removes exactly it, and the order of the rest is unchanged", async () => {
    const user = userEvent.setup();
    render(<Harness initial={state()} />);
    // The remove control, named by its description: the row carries a toggle
    // with the same accessible name (D18), so the id alone is ambiguous here.
    await user.click(
      list().getByRole("button", {
        name: "shade",
        description: messages.templateRemoveDescription("Shade"),
      }),
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).queryByText("Shade")).toBeNull();
    // Array position is z-order (D128): nobody moved but the removed layer.
    expect(rows[0].textContent).toContain("image");
    expect(rows[1].textContent).toContain("accent");
    expect(rows[2].textContent).toContain("static-text");
    expect(rows[3].textContent).toContain("logo");
  });

  test("two layers sharing an id: each row carries its remove control (L5)", () => {
    // A draft restored before the storage guard refused duplicate ids can hold
    // a pair — the section renders a row for each, so the user sees two rows
    // and clicks one.
    const canonical = templateFromCanonical("social-post");
    const duplicated: EditorState = {
      ...state(),
      template: {
        ...canonical,
        layers: [...canonical.layers, { id: "shade", kind: "shade" }],
      },
    };
    render(<Stack state={duplicated} dispatch={vi.fn()} />);
    // One remove control per row — scoped by description, since each row's
    // toggle carries the same raw id as its name.
    expect(
      list().getAllByRole("button", {
        name: "shade",
        description: messages.templateRemoveDescription("Shade"),
      }),
    ).toHaveLength(2);
  });

  test("removing one of two layers sharing an id removes exactly it, the duplicate stays (L5)", () => {
    // The contract that click dispatches into: the FIRST match by id goes, and
    // the duplicate the user did not touch stays. Filtering by id used to take
    // both — the duplicated kind required, Save then failed for a layer the
    // user never touched.
    const canonical = templateFromCanonical("social-post");
    const duplicated: EditorState = {
      ...state(),
      template: {
        ...canonical,
        layers: [...canonical.layers, { id: "shade", kind: "shade" }],
      },
    };
    const next = editorReducer(duplicated, {
      type: "removeLayer",
      id: "shade",
    });
    // One row gone, one still there — and nobody moved but the removed layer
    // (array position is z-order, D128).
    expect(next.template.layers.map((layer) => layer.id)).toEqual([
      "image",
      "accent",
      "static-text",
      "logo",
      "shade",
    ]);
  });

  test("a template carrying no required kind says nothing about them, and offers the freed kinds", () => {
    // A template held verbatim may carry any shape the boundary's props guard
    // accepted — including one whose required kinds are absent. Derive the
    // layer subset through `removableLayerIds` itself: never a literal list of
    // the vocabulary here (D121).
    const base = initialEditorState();
    const removableIds = removableLayerIds(base);
    const stripped: EditorState = {
      ...base,
      template: {
        ...base.template,
        layers: base.template.layers.filter((layer) => removableIds.includes(layer.id)),
      },
    };
    render(<Stack state={stripped} dispatch={vi.fn()} />);
    // Nothing left under the list needs the why sentence: every layer shown
    // carries its own remove control.
    expect(document.querySelector('[data-testid="layer-stack"]')?.textContent).not.toContain(
      "cannot be removed",
    );
    // And the freed required kinds join the offer.
    expect(addGroup().getByRole("button", { name: "static-text" })).toBeTruthy();
    expect(addGroup().getByRole("button", { name: "animated-text" })).toBeTruthy();
  });

  test("a kind the offer could not present is refused in the draft itself (D124)", () => {
    const base = state();
    // The shared text budget is full on the canonical template, so an
    // `animated-text` add is a no-op in the reducer — the boundary's refusal,
    // not a hope that no caller will make it.
    expect(editorReducer(base, { type: "addLayer", kind: "animated-text" })).toBe(base);
  });

  test("a required layer's remove dispatch is refused in the draft itself (D124)", () => {
    const base = state();
    expect(editorReducer(base, { type: "removeLayer", id: "image" })).toBe(base);
  });

  test("each control names itself by its raw id; the display words live in the description", () => {
    render(<Stack state={state()} dispatch={vi.fn()} />);
    const remove = list().getByRole("button", {
      name: "shade",
      description: messages.templateRemoveDescription("Shade"),
    });
    expect(
      document.getElementById(remove.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe(messages.templateRemoveDescription("Shade"));
    const add = addGroup().getByRole("button", { name: "image" });
    expect(document.getElementById(add.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      messages.templateAddDescription("Image"),
    );
  });
});

describe("moveLayer (L8a, D128)", () => {
  test("moving a layer changes only its position, and the brief serialises in the new order", () => {
    const base = state();
    const next = editorReducer(base, { type: "moveLayer", from: 0, to: 2 });
    // Bottom first, the way the list renders: the ground layer re-pointed to
    // index 2 and nobody else moved — the splice carries the same layer objects,
    // never copies.
    expect(next.template.layers.map((layer) => layer.id)).toEqual([
      "shade",
      "accent",
      "image",
      "static-text",
      "logo",
    ]);
    expect(next.template.layers[2]).toBe(base.template.layers[0]);
    expect(next.template.layers).toHaveLength(base.template.layers.length);
    expect(toBrief(next).template.layers.map((layer) => layer.id)).toEqual([
      "shade",
      "accent",
      "image",
      "static-text",
      "logo",
    ]);
    // And back down again: the from>to splice restores the canonical order.
    const restored = editorReducer(next, { type: "moveLayer", from: 2, to: 0 });
    expect(restored.template.layers.map((layer) => layer.id)).toEqual(
      base.template.layers.map((layer) => layer.id),
    );
  });

  test("an out-of-range index is a no-op in both directions", () => {
    const base = state();
    // A non-integer index is no index at all — the guard `isBeatIndex` states.
    expect(editorReducer(base, { type: "moveLayer", from: -1, to: 0 })).toBe(base);
    expect(editorReducer(base, { type: "moveLayer", from: 0, to: -1 })).toBe(base);
    expect(editorReducer(base, { type: "moveLayer", from: 0.5, to: 0 })).toBe(base);
    expect(editorReducer(base, { type: "moveLayer", from: 5, to: 0 })).toBe(base);
    expect(editorReducer(base, { type: "moveLayer", from: 0, to: 5 })).toBe(base);
  });

  test("moving a layer onto its own index is a no-op", () => {
    const base = state();
    expect(editorReducer(base, { type: "moveLayer", from: 2, to: 2 })).toBe(base);
  });
});

describe("LayerStack — layer reordering (L8, D128)", () => {
  test("move controls name themselves by raw id and display words live in aria-describedby", () => {
    render(<Stack state={state()} dispatch={vi.fn()} />);
    // In canonical image-text, accent (index 2) can move up:
    const accentUp = list().getByRole("button", {
      name: "accent",
      description: messages.templateMoveUpDescription("Accent"),
    });
    expect(accentUp).toBeTruthy();
    expect(accentUp.textContent).toBe("↑");
    expect(
      document.getElementById(accentUp.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe(messages.templateMoveUpDescription("Accent"));

    // static-text (index 3) can move down:
    const textDown = list().getByRole("button", {
      name: "static-text",
      description: messages.templateMoveDownDescription("Static text"),
    });
    expect(textDown).toBeTruthy();
    expect(textDown.textContent).toBe("↓");
    expect(
      document.getElementById(textDown.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe(messages.templateMoveDownDescription("Static text"));
  });

  test("a move control dispatches moveLayer with the right indices", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<Stack state={state()} dispatch={dispatch} />);

    // In canonical image-text, accent sits at index 2. Moving it up moves to index 3:
    const accentUp = list().getByRole("button", {
      name: "accent",
      description: messages.templateMoveUpDescription("Accent"),
    });
    await user.click(accentUp);
    expect(dispatch).toHaveBeenCalledWith({
      type: "moveLayer",
      from: 2,
      to: 3,
    });

    // static-text sits at index 3. Moving it down moves to index 2:
    const textDown = list().getByRole("button", {
      name: "static-text",
      description: messages.templateMoveDownDescription("Static text"),
    });
    await user.click(textDown);
    expect(dispatch).toHaveBeenCalledWith({
      type: "moveLayer",
      from: 3,
      to: 2,
    });
  });

  test("the list re-renders in the new order after moving a layer", async () => {
    const user = userEvent.setup();
    render(<Harness initial={state()} />);

    // Canonical order: image (0), shade (1), accent (2), static-text (3), logo (4)
    let rows = screen.getAllByRole("listitem");
    expect(rows[2].textContent).toContain("accent");
    expect(rows[3].textContent).toContain("static-text");

    // Move accent up (from 2 to 3):
    const accentUp = within(rows[2]).getByRole("button", {
      name: "accent",
      description: messages.templateMoveUpDescription("Accent"),
    });
    await user.click(accentUp);

    // List re-renders in new order: image (0), shade (1), static-text (2), accent (3), logo (4)
    rows = screen.getAllByRole("listitem");
    expect(rows[2].textContent).toContain("static-text");
    expect(rows[3].textContent).toContain("accent");
  });

  test("a move creating an occlusion shows the advisory note, move still happens, and note clears when changed back (D135, D136)", async () => {
    const user = userEvent.setup();
    render(<Harness initial={state()} />);

    // Canonical order: image (0), shade (1), accent (2), static-text (3), logo (4)
    let rows = screen.getAllByRole("listitem");
    expect(rows[2].textContent).toContain("accent");
    expect(rows[3].textContent).toContain("static-text");
    // Initially, no occlusion note or live region is rendered
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/now sits above/)).toBeNull();

    // 1. Move accent up (from 2 to 3, above static-text)
    const accentUp = within(rows[2]).getByRole("button", {
      name: "accent",
      description: messages.templateMoveUpDescription("Accent"),
    });
    await user.click(accentUp);

    // The move still applied: accent is now at index 3, static-text at index 2
    rows = screen.getAllByRole("listitem");
    expect(rows[2].textContent).toContain("static-text");
    expect(rows[3].textContent).toContain("accent");

    // The quiet note shows, carrying role="status", naming both layers and what happens
    const note = screen.getByRole("status");
    expect(note).toBeTruthy();
    expect(note.textContent).toBe("the accent layer now sits above the headline and will mute it");
    expect(note.className).toContain("text-text-muted");

    // 2. Moving accent back down (from 3 to 2) clears the note
    const accentDown = within(rows[3]).getByRole("button", {
      name: "accent",
      description: messages.templateMoveDownDescription("Accent"),
    });
    await user.click(accentDown);

    // The move still applied: accent back at index 2, static-text back at index 3
    rows = screen.getAllByRole("listitem");
    expect(rows[2].textContent).toContain("accent");
    expect(rows[3].textContent).toContain("static-text");

    // The note clears and live region is emptied
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/now sits above/)).toBeNull();
  });

  test("a move that does not create an occlusion shows no note (D135, D136)", async () => {
    const user = userEvent.setup();
    render(<Harness initial={state()} />);

    // In canonical image-text: move static-text (index 3) up to index 4 (above logo at 3)
    let rows = screen.getAllByRole("listitem");
    const textUp = within(rows[3]).getByRole("button", {
      name: "static-text",
      description: messages.templateMoveUpDescription("Static text"),
    });
    await user.click(textUp);

    // Move still applied
    rows = screen.getAllByRole("listitem");
    expect(rows[3].textContent).toContain("logo");
    expect(rows[4].textContent).toContain("static-text");

    // Non-occluding move shows no note and no live region
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/now sits above/)).toBeNull();
  });

  test("the list is bottom-first: first layer offers no down toward bottom and last offers no up past top", () => {
    // Array position is z-order, bottom first (D128, per templateListLabel "Layers, bottom first"):
    // - Index 0 is the bottom layer (drawn first, behind everything).
    //   Moving down would mean moving below index 0 (past the bottom) — no down control is offered.
    // - Index length - 1 is the topmost layer (drawn last, on top of everything).
    //   Moving up would mean moving above the top — no up control is offered.
    // - "up" moves toward the top of the stack (from index i to i + 1).
    // - "down" moves toward the bottom of the stack (from index i to i - 1).
    render(<Stack state={state()} dispatch={vi.fn()} />);
    const rows = screen.getAllByRole("listitem");

    // First layer: image at index 0 (bottom).
    // It offers NO down control:
    expect(
      within(rows[0]).queryByRole("button", {
        name: "image",
        description: messages.templateMoveDownDescription("Image"),
      }),
    ).toBeNull();

    // Last layer: logo at index 4 (top).
    // It offers NO up control:
    expect(
      within(rows[4]).queryByRole("button", {
        name: "logo",
        description: messages.templateMoveUpDescription("Logo"),
      }),
    ).toBeNull();
  });

  test("a layer blocked by an ordering constraint offers no control in that direction", () => {
    // In canonical image-text, CREATIVE_TYPE_RULES declares:
    // - "logo above image"
    // - "shade directly above image"
    render(<Stack state={state()} dispatch={vi.fn()} />);
    const rows = screen.getAllByRole("listitem");

    // 1. image at index 0: moving up to 1 would place shade below image (or at index 0),
    // violating "shade directly above image". So image offers no "up" control:
    expect(
      within(rows[0]).queryByRole("button", {
        name: "image",
        description: messages.templateMoveUpDescription("Image"),
      }),
    ).toBeNull();

    // 2. shade at index 1:
    // - moving down to 0 would place shade below image, violating "shade directly above image".
    // - moving up to 2 would place accent between image and shade, violating "shade directly above image".
    // So shade offers NEITHER up NOR down move controls:
    expect(
      within(rows[1]).queryByRole("button", {
        name: "shade",
        description: messages.templateMoveDownDescription("Shade"),
      }),
    ).toBeNull();
    expect(
      within(rows[1]).queryByRole("button", {
        name: "shade",
        description: messages.templateMoveUpDescription("Shade"),
      }),
    ).toBeNull();

    // 3. accent at index 2:
    // - moving down to 1 would separate shade from image, violating "shade directly above image".
    // So accent offers NO down control:
    expect(
      within(rows[2]).queryByRole("button", {
        name: "accent",
        description: messages.templateMoveDownDescription("Accent"),
      }),
    ).toBeNull();
  });
});

describe("LayerStack — the layer toggle (L9, D129, MP-D3, MP-D4)", () => {
  test("disabling an optional layer serialises enabled: false, and the brief round-trips", () => {
    const base = state();
    const off = editorReducer(base, {
      type: "setLayerEnabled",
      id: "shade",
      enabled: false,
    });
    // `enabled: false` is the only `enabled` a brief ever carries: absent means
    // enabled, so switching off writes the field and switching on removes it —
    // an off→on round trip returns the layer to the shape it was loaded with.
    expect(off.template.layers.find((layer) => layer.id === "shade")).toEqual({
      id: "shade",
      kind: "shade",
      enabled: false,
    });
    expect(toBrief(off).template.layers).toContainEqual({
      id: "shade",
      kind: "shade",
      enabled: false,
    });
    // The saved brief reloads with the layer still off, in its slot (MP-D3's
    // other half: order constraints still see the whole array).
    const reloaded = fromBrief(toBrief(off));
    expect(reloaded.template.layers.map((layer) => layer.id)).toEqual(
      base.template.layers.map((layer) => layer.id),
    );
    expect(reloaded.template.layers.find((layer) => layer.id === "shade")?.enabled).toBe(false);
    // Back on: no `enabled` key at all — `toStrictEqual`, so a leftover
    // `enabled: undefined` would fail here.
    expect(
      editorReducer(off, { type: "setLayerEnabled", id: "shade", enabled: true }).template.layers,
    ).toStrictEqual(base.template.layers);
  });

  test("the last enabled required layer offers no toggle, and the reducer refuses it", () => {
    render(<Stack state={state()} dispatch={vi.fn()} />);
    // Absent from the offer, never present-and-disabled (DESIGN.md §1.5): image
    // and static-text are the type's required kinds, each present once.
    expect(
      list().queryByRole("button", {
        name: "image",
        description: messages.templateDisableDescription("Image"),
      }),
    ).toBeNull();
    expect(
      list().queryByRole("button", {
        name: "static-text",
        description: messages.templateDisableDescription("Static text"),
      }),
    ).toBeNull();
    expect(
      list().getByRole("button", {
        name: "shade",
        description: messages.templateDisableDescription("Shade"),
      }),
    ).toBeTruthy();
    // And the refusal is in the draft itself, the way `removeLayer`'s is.
    const base = state();
    expect(
      editorReducer(base, {
        type: "setLayerEnabled",
        id: "image",
        enabled: false,
      }),
    ).toBe(base);
    expect(
      editorReducer(base, {
        type: "setLayerEnabled",
        id: "static-text",
        enabled: false,
      }),
    ).toBe(base);
  });

  test("a toggle for an unknown id, or one asking for the state the layer already holds, changes nothing", () => {
    const base = state();
    expect(
      editorReducer(base, {
        type: "setLayerEnabled",
        id: "no-such-layer",
        enabled: false,
      }),
    ).toBe(base);
    // An enabled layer asked to go on: no edit, so no history entry either.
    expect(editorReducer(base, { type: "setLayerEnabled", id: "shade", enabled: true })).toBe(base);
    const off = editorReducer(base, {
      type: "setLayerEnabled",
      id: "shade",
      enabled: false,
    });
    expect(editorReducer(off, { type: "setLayerEnabled", id: "shade", enabled: false })).toBe(off);
  });

  test("the toggle dispatches setLayerEnabled with the layer id and the state it asks for", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<Stack state={state()} dispatch={dispatch} />);
    await user.click(
      list().getByRole("button", {
        name: "shade",
        description: messages.templateDisableDescription("Shade"),
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "setLayerEnabled",
      id: "shade",
      enabled: false,
    });
  });

  test("the toggle names itself by its raw id; the display words live in the description", () => {
    render(<Stack state={state()} dispatch={vi.fn()} />);
    const toggle = list().getByRole("button", {
      name: "shade",
      description: messages.templateDisableDescription("Shade"),
    });
    expect(
      document.getElementById(toggle.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe(messages.templateDisableDescription("Shade"));
  });

  test("switching a layer off and back on through the real reducer swaps the offer", async () => {
    const user = userEvent.setup();
    render(<Harness initial={state()} />);
    await user.click(
      list().getByRole("button", {
        name: "shade",
        description: messages.templateDisableDescription("Shade"),
      }),
    );
    // Off: the row offers the way back and nothing else — no downgrade to a
    // disabled control, and no other row moved.
    expect(
      list().getByRole("button", {
        name: "shade",
        description: messages.templateEnableDescription("Shade"),
      }),
    ).toBeTruthy();
    expect(
      list().queryByRole("button", {
        name: "shade",
        description: messages.templateDisableDescription("Shade"),
      }),
    ).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);

    await user.click(
      list().getByRole("button", {
        name: "shade",
        description: messages.templateEnableDescription("Shade"),
      }),
    );
    expect(
      list().getByRole("button", {
        name: "shade",
        description: messages.templateDisableDescription("Shade"),
      }),
    ).toBeTruthy();
  });

  test("a disabled layer produces no occlusion warning, and re-enabling it brings it back (MP-D3)", async () => {
    const user = userEvent.setup();
    render(<Harness initial={state()} />);

    // Accent (index 2) moves above the headline: the advisory appears.
    let rows = screen.getAllByRole("listitem");
    await user.click(
      within(rows[2]).getByRole("button", {
        name: "accent",
        description: messages.templateMoveUpDescription("Accent"),
      }),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "the accent layer now sits above the headline and will mute it",
    );

    // Switch the occluding layer off: it draws nothing, so it occludes nothing.
    rows = screen.getAllByRole("listitem");
    await user.click(
      within(rows[3]).getByRole("button", {
        name: "accent",
        description: messages.templateDisableDescription("Accent"),
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();

    // Back on: the occlusion is real again, and the note says so.
    rows = screen.getAllByRole("listitem");
    await user.click(
      within(rows[3]).getByRole("button", {
        name: "accent",
        description: messages.templateEnableDescription("Accent"),
      }),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "the accent layer now sits above the headline and will mute it",
    );
  });

  test("moving a disabled layer into an occluding position raises no warning (MP-D3)", async () => {
    const user = userEvent.setup();
    render(<Harness initial={state()} />);

    // Accent off first — the order constraints still police the move (MP-D3:
    // the full array), but the layer paints nothing.
    let rows = screen.getAllByRole("listitem");
    await user.click(
      within(rows[2]).getByRole("button", {
        name: "accent",
        description: messages.templateDisableDescription("Accent"),
      }),
    );
    rows = screen.getAllByRole("listitem");
    await user.click(
      within(rows[2]).getByRole("button", {
        name: "accent",
        description: messages.templateMoveUpDescription("Accent"),
      }),
    );
    // The move happened — accent is above the headline — and no notice fires.
    rows = screen.getAllByRole("listitem");
    expect(rows[3].textContent).toContain("accent");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("LayerStack — the draft and its brief", () => {
  test("adding a kind places a layer with that kind and a unique id at a legal index, and the brief serialises with it", () => {
    const added = editorReducer(state(), { type: "addLayer", kind: "image" });
    // The id derives from the kind, deduplicated against the ids held — and a
    // new layer carries no props (L5): `{ id, kind }` and nothing more.
    // In canonical image-text, logo must sit above image (D128), so image-2 is
    // placed at index 4 (below logo), not appended past logo.
    expect(added.template.layers.find((layer) => layer.id === "image-2")).toEqual({
      id: "image-2",
      kind: "image",
    });
    expect(toBrief(added).template.layers).toContainEqual({
      id: "image-2",
      kind: "image",
    });
  });

  test("the section round-trips: add, save, reload, and the layer is still there in the same position", () => {
    const added = editorReducer(state(), { type: "addLayer", kind: "image" });
    const before = added.template.layers.map((layer) => layer.id);
    const reloaded = fromBrief(toBrief(added));
    expect(reloaded.template.layers.map((layer) => layer.id)).toEqual(before);
    expect(reloaded.template.layers.find((layer) => layer.id === "image-2")?.kind).toBe("image");
  });

  test("an unknown kind's display name is the kind itself — never an empty label", () => {
    expect(layerKindDisplayName("made-up")).toBe("made-up");
  });
});

describe("LayerStack — a corrupt restored draft falls back, never crashes (L5)", () => {
  test("a draft whose layers hold non-objects falls back to the canonical template, and the section mounts", () => {
    // The crash this fix closes: `isBriefTemplate`'s per-layer check used to
    // answer "no props problem" for an entry that is not an object, so a stored
    // draft holding one rode the guard and `countKinds` threw on `layer.kind`
    // while the section mounted — the user could not even reach Save to repair
    // the draft. The restore refuses the template, and the canonical fallback
    // normalizeDraftState already applies takes over.
    const restored = normalizeDraftState({
      type: "social-post",
      template: {
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [null, "junk", {}],
      },
    });
    expect(restored.template).toEqual(templateFromCanonical("social-post"));
    render(<Stack state={restored} dispatch={vi.fn()} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  test("a draft whose template carries duplicate layer ids falls back to the canonical template", () => {
    // The storage boundary now states the rule the API's `validateTemplate`
    // already applied, so the two guards agree and a draft carrying duplicates
    // takes the fallback instead of rendering a row per copy.
    const canonical = templateFromCanonical("social-post");
    const restored = normalizeDraftState({
      type: "social-post",
      template: {
        ...canonical,
        layers: [...canonical.layers, { id: "shade", kind: "shade" }],
      },
    });
    expect(restored.template).toEqual(templateFromCanonical("social-post"));
  });
});

describe("LayerStack — the selection is ephemeral (CC3, D139)", () => {
  /** A row's own name control — the thing the operator clicks to pick a layer. */
  const pick = (id: string, name: string) =>
    list().getByRole("button", { name: id, description: messages.layerSelectDescription(name) });

  test("picking a row marks exactly that row, and reaches the reducer with nothing", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<Stack state={state()} dispatch={dispatch} />);
    // Nothing is picked on arrival: a stack that opened with a selection would
    // be asserting an answer the operator never gave.
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("false");

    await user.click(pick("accent", "Accent"));
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("true");
    // One at a time — never two pressed rows for one selection.
    expect(pick("shade", "Shade").getAttribute("aria-pressed")).toBe("false");
    expect(pick("logo", "Logo").getAttribute("aria-pressed")).toBe("false");
    // D139: the selection is local component state. The click must not reach
    // the reducer at all — a document action here would dirty a loaded brief
    // on a gesture that changed nothing about the creative.
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("the pick follows the LAYER across a reorder, not the slot it was standing in", async () => {
    const user = userEvent.setup();
    render(<Harness initial={state()} />);
    // Canonical image-text: image (0), shade (1), accent (2), static-text (3), logo (4).
    await user.click(pick("accent", "Accent"));

    // Move the picked layer up, so accent and static-text swap slots. An
    // index-keyed selection would stay on index 2 and silently re-point at
    // static-text — the exact invariant `CopyTimeline.vo.ts` names for the
    // persisted key beat ("the selected text must not change because rows
    // moved"), and the reason the tape's own beat selection is RETIRED on an
    // edit instead: a raw index cannot follow its subject, and a layer id can.
    await user.click(
      list().getByRole("button", {
        name: "accent",
        description: messages.templateMoveUpDescription("Accent"),
      }),
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows[2].textContent).toContain("static-text");
    expect(rows[3].textContent).toContain("accent");

    // Still accent, now in slot 3 — and static-text, which took slot 2, is not
    // picked. Both halves matter: the first alone would pass if every row were
    // pressed, the second alone if the selection had simply been dropped.
    expect(pick("accent", "Accent").getAttribute("aria-pressed")).toBe("true");
    expect(pick("static-text", "Static text").getAttribute("aria-pressed")).toBe("false");
  });

  test("removing the picked layer clears the pick, and picks nothing in its place", async () => {
    const user = userEvent.setup();
    render(<Harness initial={state()} />);
    await user.click(pick("shade", "Shade"));
    expect(pick("shade", "Shade").getAttribute("aria-pressed")).toBe("true");

    await user.click(
      list().getByRole("button", {
        name: "shade",
        description: messages.templateRemoveDescription("Shade"),
      }),
    );
    // The row is gone, and no surviving row inherited its highlight — the id
    // simply names nothing now, which is what `null` means here.
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    for (const [id, name] of [
      ["image", "Image"],
      ["accent", "Accent"],
      ["static-text", "Static text"],
      ["logo", "Logo"],
    ]) {
      expect(pick(id, name).getAttribute("aria-pressed")).toBe("false");
    }
  });

  test("the select control names itself by its raw id; the display words live in the description", () => {
    render(<Stack state={state()} dispatch={vi.fn()} />);
    const control = pick("shade", "Shade");
    expect(
      document.getElementById(control.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe(messages.layerSelectDescription("Shade"));
    // And it is not the remove control wearing the same name (D18 puts the raw
    // id on every control in the row): the two are told apart by description.
    expect(control).not.toBe(
      list().getByRole("button", {
        name: "shade",
        description: messages.templateRemoveDescription("Shade"),
      }),
    );
  });
});

describe("layerStackProps — the seam the rail's memo keys on (CC3)", () => {
  test("every offer is the derivation's answer, and a strict subset of the vocabulary", () => {
    const props = layerStackProps(state());
    // The fresh social post's decorated kinds sit at their own caps or fill the
    // shared text budget, so the unbounded pair is the offer: `image`, and
    // `fill` since L11. A hard-coded list would have to be exactly this, on
    // exactly this template, and would then be wrong for the stripped one below.
    expect([...props.addable]).toHaveLength(2);
    expect([...props.addable]).toContain("image");
    expect([...props.addable]).toContain("fill");
    expect(props.rows.map((row) => row.id)).toEqual([
      "image",
      "shade",
      "accent",
      "static-text",
      "logo",
    ]);
    // Required kinds carry no remove offer; the rest do.
    expect(props.rows.filter((row) => !row.removable).map((row) => row.id)).toEqual([
      "image",
      "static-text",
    ]);
    expect([...props.requiredNames]).toEqual(["Image", "Static text"]);

    // The same function on a template whose required kinds were stripped
    // answers differently — so the figures above are read, not written here.
    const base = initialEditorState();
    const removableIds = removableLayerIds(base);
    const stripped = layerStackProps({
      ...base,
      template: {
        ...base.template,
        layers: base.template.layers.filter((layer) => removableIds.includes(layer.id)),
      },
    });
    expect([...stripped.addable]).toContain("static-text");
    expect([...stripped.requiredNames]).toEqual([]);
  });
});
