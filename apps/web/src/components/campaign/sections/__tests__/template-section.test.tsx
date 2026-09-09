import { describe, test, expect, vi } from "vitest";
import { useReducer } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  editorReducer,
  fromBrief,
  initialEditorState,
  normalizeDraftState,
  toBrief,
  type EditorState,
} from "@/components/campaign/editor-state";
import { removableLayerIds } from "@/components/campaign/derive";
import { layerKindDisplayName } from "@/components/campaign/display-names";
import { TemplateSection } from "../TemplateSection";
import * as messages from "../../messages";

const state = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState(),
  ...over,
});

/** The add offer, scoped so a list row's remove control can never answer for it. */
const addGroup = () =>
  within(screen.getByRole("group", { name: messages.templateAddLabel }));
/** The layer list, scoped the same way — the two offers never share a query. */
const list = () =>
  within(screen.getByRole("list", { name: messages.templateListLabel }));

/**
 * A real-reducer harness: add and remove go through `editorReducer`, so the
 * round-trip tests exercise the editor's actual save path (`toBrief`) and its
 * actual load path (`fromBrief`), not a mock of either.
 */
function Harness({ initial }: { initial: EditorState }) {
  const [state, dispatch] = useReducer(editorReducer, initial);
  return <TemplateSection state={state} dispatch={dispatch} errors={{}} />;
}

describe("TemplateSection — the layer list (L5, D124)", () => {
  test("renders every layer bottom first, each with its kind's display name and its id", () => {
    render(<TemplateSection state={state()} dispatch={vi.fn()} errors={{}} />);
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
    render(<TemplateSection state={state()} dispatch={dispatch} errors={{}} />);
    // The fresh social post's decorated kinds sit at their own caps or fill the
    // shared text budget; only `image` — unbounded — is offered.
    expect(addGroup().getAllByRole("button")).toHaveLength(1);
    await user.click(addGroup().getByRole("button", { name: "image" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "addLayer", kind: "image" });
  });

  test("a kind at its limit is absent from the offer, never present-and-disabled", () => {
    render(<TemplateSection state={state()} dispatch={vi.fn()} errors={{}} />);
    // The fresh social post's decorated kinds sit at their own caps or fill the
    // shared text budget — one expect per kind: the scanner refuses a literal
    // list of the vocabulary here (D121), and the failures read better apart.
    expect(addGroup().queryByRole("button", { name: "shade" })).toBeNull();
    expect(addGroup().queryByRole("button", { name: "accent" })).toBeNull();
    expect(
      addGroup().queryByRole("button", { name: "static-text" }),
    ).toBeNull();
    expect(
      addGroup().queryByRole("button", { name: "animated-text" }),
    ).toBeNull();
    expect(addGroup().queryByRole("button", { name: "logo" })).toBeNull();
    // And the one offered kind is its raw id — `image`, the unbounded one.
    expect(addGroup().getByRole("button", { name: "image" })).toBeTruthy();
  });

  test("the offer follows the list: a removed kind joins it, a re-added one leaves it", async () => {
    const user = userEvent.setup();
    // The real reducer strips `shade`, whose kind is then under its cap.
    render(
      <Harness
        initial={editorReducer(state(), { type: "removeLayer", id: "shade" })}
      />,
    );
    expect(addGroup().getByRole("button", { name: "shade" })).toBeTruthy();
    await user.click(addGroup().getByRole("button", { name: "shade" }));
    // Held once, the kind is back at its cap — gone from the offer, not disabled.
    expect(addGroup().queryByRole("button", { name: "shade" })).toBeNull();
    // The shared text budget still holds: `animated-text` stays unoffered.
    expect(
      addGroup().queryByRole("button", { name: "animated-text" }),
    ).toBeNull();
  });

  test("a required layer has no remove control; a removable one does — and the sentence says why", () => {
    render(<TemplateSection state={state()} dispatch={vi.fn()} errors={{}} />);
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
    expect(
      screen.getByText(messages.templateRequiredNote(["Image", "Static text"])),
    ).toBeTruthy();
  });

  test("removing a layer removes exactly it, and the order of the rest is unchanged", async () => {
    const user = userEvent.setup();
    render(<Harness initial={state()} />);
    await user.click(list().getByRole("button", { name: "shade" }));
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
    render(
      <TemplateSection state={duplicated} dispatch={vi.fn()} errors={{}} />,
    );
    expect(list().getAllByRole("button", { name: "shade" })).toHaveLength(2);
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
        layers: base.template.layers.filter((layer) =>
          removableIds.includes(layer.id),
        ),
      },
    };
    render(<TemplateSection state={stripped} dispatch={vi.fn()} errors={{}} />);
    // Nothing left under the list needs the why sentence: every layer shown
    // carries its own remove control.
    expect(
      document.querySelector('[data-section="template"]')?.textContent,
    ).not.toContain("cannot be removed");
    // And the freed required kinds join the offer.
    expect(
      addGroup().getByRole("button", { name: "static-text" }),
    ).toBeTruthy();
    expect(
      addGroup().getByRole("button", { name: "animated-text" }),
    ).toBeTruthy();
  });

  test("a kind the offer could not present is refused in the draft itself (D124)", () => {
    const base = state();
    // The shared text budget is full on the canonical template, so an
    // `animated-text` add is a no-op in the reducer — the boundary's refusal,
    // not a hope that no caller will make it.
    expect(
      editorReducer(base, { type: "addLayer", kind: "animated-text" }),
    ).toBe(base);
  });

  test("a required layer's remove dispatch is refused in the draft itself (D124)", () => {
    const base = state();
    expect(editorReducer(base, { type: "removeLayer", id: "image" })).toBe(
      base,
    );
  });

  test("each control names itself by its raw id; the display words live in the description", () => {
    render(<TemplateSection state={state()} dispatch={vi.fn()} errors={{}} />);
    const remove = list().getByRole("button", { name: "shade" });
    expect(
      document.getElementById(remove.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(messages.templateRemoveDescription("Shade"));
    const add = addGroup().getByRole("button", { name: "image" });
    expect(
      document.getElementById(add.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(messages.templateAddDescription("Image"));
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
    expect(editorReducer(base, { type: "moveLayer", from: -1, to: 0 })).toBe(
      base,
    );
    expect(editorReducer(base, { type: "moveLayer", from: 0, to: -1 })).toBe(
      base,
    );
    expect(editorReducer(base, { type: "moveLayer", from: 0.5, to: 0 })).toBe(
      base,
    );
    expect(editorReducer(base, { type: "moveLayer", from: 5, to: 0 })).toBe(
      base,
    );
    expect(editorReducer(base, { type: "moveLayer", from: 0, to: 5 })).toBe(
      base,
    );
  });

  test("moving a layer onto its own index is a no-op", () => {
    const base = state();
    expect(editorReducer(base, { type: "moveLayer", from: 2, to: 2 })).toBe(
      base,
    );
  });
});

describe("TemplateSection — layer reordering (L8, D128)", () => {
  test("move controls name themselves by raw id and display words live in aria-describedby", () => {
    render(<TemplateSection state={state()} dispatch={vi.fn()} errors={{}} />);
    // In canonical image-text, accent (index 2) can move up:
    const accentUp = list().getByRole("button", {
      name: "accent",
      description: messages.templateMoveUpDescription("Accent"),
    });
    expect(accentUp).toBeTruthy();
    expect(accentUp.textContent).toBe("↑");
    expect(
      document.getElementById(accentUp.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(messages.templateMoveUpDescription("Accent"));

    // static-text (index 3) can move down:
    const textDown = list().getByRole("button", {
      name: "static-text",
      description: messages.templateMoveDownDescription("Static text"),
    });
    expect(textDown).toBeTruthy();
    expect(textDown.textContent).toBe("↓");
    expect(
      document.getElementById(textDown.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(messages.templateMoveDownDescription("Static text"));
  });

  test("a move control dispatches moveLayer with the right indices", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<TemplateSection state={state()} dispatch={dispatch} errors={{}} />);

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
    // Initially, no occlusion note is rendered
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

    // The quiet note shows, naming both layers and what happens
    const note = screen.getByText(
      "the accent layer now sits above the headline and will mute it",
    );
    expect(note).toBeTruthy();
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

    // The note clears
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

    // Non-occluding move shows no note
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
    render(<TemplateSection state={state()} dispatch={vi.fn()} errors={{}} />);
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
    render(<TemplateSection state={state()} dispatch={vi.fn()} errors={{}} />);
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

describe("TemplateSection — the draft and its brief", () => {
  test("adding a kind places a layer with that kind and a unique id at a legal index, and the brief serialises with it", () => {
    const added = editorReducer(state(), { type: "addLayer", kind: "image" });
    // The id derives from the kind, deduplicated against the ids held — and a
    // new layer carries no props (L5): `{ id, kind }` and nothing more.
    // In canonical image-text, logo must sit above image (D128), so image-2 is
    // placed at index 4 (below logo), not appended past logo.
    expect(
      added.template.layers.find((layer) => layer.id === "image-2"),
    ).toEqual({
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
    expect(
      reloaded.template.layers.find((layer) => layer.id === "image-2")?.kind,
    ).toBe("image");
  });

  test("an unknown kind's display name is the kind itself — never an empty label", () => {
    expect(layerKindDisplayName("made-up")).toBe("made-up");
  });
});

describe("TemplateSection — a corrupt restored draft falls back, never crashes (L5)", () => {
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
    render(<TemplateSection state={restored} dispatch={vi.fn()} errors={{}} />);
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
