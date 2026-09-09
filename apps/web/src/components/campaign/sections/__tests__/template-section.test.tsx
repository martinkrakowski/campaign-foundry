import { describe, test, expect, vi } from "vitest";
import { useReducer } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  editorReducer,
  fromBrief,
  initialEditorState,
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
