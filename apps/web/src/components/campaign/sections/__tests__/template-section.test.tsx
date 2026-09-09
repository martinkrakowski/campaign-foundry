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

const state = (over: Partial<EditorState> = {}): EditorState => ({ ...initialEditorState(), ...over });

/** The add offer, scoped so a list row's remove control can never answer for it. */
const addGroup = () => within(screen.getByRole("group", { name: messages.templateAddLabel }));
/** The layer list, scoped the same way — the two offers never share a query. */
const list = () => within(screen.getByRole("list", { name: messages.templateListLabel }));

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
    render(<TemplateSection state={state()} dispatch={vi.fn()} errors={{}} />);
    expect(list().queryByRole("button", { name: "image" })).toBeNull();
    expect(list().queryByRole("button", { name: "static-text" })).toBeNull();
    expect(list().getByRole("button", { name: "shade" })).toBeTruthy();
    expect(list().getByRole("button", { name: "accent" })).toBeTruthy();
    expect(list().getByRole("button", { name: "logo" })).toBeTruthy();
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
      template: { ...canonical, layers: [...canonical.layers, { id: "shade", kind: "shade" }] },
    };
    render(<TemplateSection state={duplicated} dispatch={vi.fn()} errors={{}} />);
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
      template: { ...canonical, layers: [...canonical.layers, { id: "shade", kind: "shade" }] },
    };
    const next = editorReducer(duplicated, { type: "removeLayer", id: "shade" });
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
    render(<TemplateSection state={stripped} dispatch={vi.fn()} errors={{}} />);
    // Nothing left under the list needs the why sentence: every layer shown
    // carries its own remove control.
    expect(document.querySelector('[data-section="template"]')?.textContent).not.toContain(
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
    render(<TemplateSection state={state()} dispatch={vi.fn()} errors={{}} />);
    const remove = list().getByRole("button", { name: "shade" });
    expect(document.getElementById(remove.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      messages.templateRemoveDescription("Shade"),
    );
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
    expect(restored.template.layers.map((layer) => layer.id)).toEqual(base.template.layers.map((layer) => layer.id));
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

describe("TemplateSection — the draft and its brief", () => {
  test("adding a kind appends a layer with that kind and a unique id, and the brief serialises with it", () => {
    const added = editorReducer(state(), { type: "addLayer", kind: "image" });
    // The id derives from the kind, deduplicated against the ids held — and a
    // new layer carries no props (L5): `{ id, kind }` and nothing more.
    expect(added.template.layers.at(-1)).toEqual({ id: "image-2", kind: "image" });
    expect(toBrief(added).template.layers).toContainEqual({ id: "image-2", kind: "image" });
  });

  test("the section round-trips: add, save, reload, and the layer is still there in the same position", () => {
    const added = editorReducer(state(), { type: "addLayer", kind: "image" });
    const before = added.template.layers.map((layer) => layer.id);
    const reloaded = fromBrief(toBrief(added));
    expect(reloaded.template.layers.map((layer) => layer.id)).toEqual(before);
    expect(reloaded.template.layers.at(-1)?.kind).toBe("image");
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
      template: { ...canonical, layers: [...canonical.layers, { id: "shade", kind: "shade" }] },
    });
    expect(restored.template).toEqual(templateFromCanonical("social-post"));
  });
});
