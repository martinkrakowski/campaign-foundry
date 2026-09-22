import { describe, test, expect, vi, afterEach } from "vitest";
import { useReducer } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CANONICAL_TEMPLATES } from "@campaignfoundry/CampaignOrchestration/creative-templates";
import {
  FILL_ROLES,
  type BriefTemplate,
} from "@campaignfoundry/CampaignOrchestration/brief-template";
import { fillRoleDisplayName } from "@/components/campaign/display-names";
import {
  editorReducer,
  initialEditorState,
  type EditorState,
} from "@/components/campaign/editor-state";
import * as messages from "@/components/campaign/messages";
import { LayerPropsSheet } from "../LayerPropsSheet";

/**
 * CC4 — the layer sheet, at the component level: what it renders per layer
 * kind, its own canonical form (no `aria-modal`, ever), and Escape.
 *
 * The undo/coalesce properties live in `editor-history.test.tsx` (the hook
 * that actually owns them); the mount site, the "creative stays visible" and
 * the full ⌘Z-with-the-sheet-open proofs live in `brief-editor.layers.test.tsx`
 * (only the mounted editor can show a sibling relationship to the step card,
 * or that the rail survives beside an open sheet). This file is the sheet's
 * own contract, driven by the real reducer so a click here is the same
 * dispatch `BriefEditor` would make.
 */

const TEXT_CANONICAL = CANONICAL_TEMPLATES["image-text"];
const HTML_CANONICAL = CANONICAL_TEMPLATES["image-html"];

const textTemplate = (): BriefTemplate => ({
  id: "canonical-image-text",
  version: TEXT_CANONICAL.version,
  creativeType: TEXT_CANONICAL.creativeType,
  unit: TEXT_CANONICAL.unit,
  layers: TEXT_CANONICAL.layers,
});

const htmlTemplate = (): BriefTemplate => ({
  id: "canonical-image-html",
  version: HTML_CANONICAL.version,
  creativeType: HTML_CANONICAL.creativeType,
  unit: HTML_CANONICAL.unit,
  layers: HTML_CANONICAL.layers,
});

function Harness({
  initial,
  layerId,
  onClose,
}: {
  initial: EditorState;
  layerId: string | null;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(editorReducer, initial);
  return (
    <LayerPropsSheet
      state={state}
      dispatch={dispatch}
      layerId={layerId}
      playhead={null}
      preset={null}
      onClose={onClose}
    />
  );
}

const StateHarness = ({
  initial,
  layerId,
  onClose,
  onState,
}: {
  initial: EditorState;
  layerId: string | null;
  onClose: () => void;
  onState: (state: EditorState) => void;
}) => {
  const [state, dispatch] = useReducer(editorReducer, initial);
  onState(state);
  return (
    <LayerPropsSheet
      state={state}
      dispatch={dispatch}
      layerId={layerId}
      playhead={null}
      preset={null}
      onClose={onClose}
    />
  );
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("LayerPropsSheet — mounting (D139, CC3's selection, never a second one)", () => {
  test("renders nothing when no layer is picked", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("renders nothing when the id names no row (a stale or cleared pick)", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="not-a-layer"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("named by the raw layer id (D18) — never a display name", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: messages.layerSheetTitle("accent") })).toBeTruthy();
  });
});

describe("LayerPropsSheet — never aria-modal (the undo gate's own contract)", () => {
  test("the sheet's own element carries no aria-modal attribute at all", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByTestId("layer-props-sheet");
    expect(dialog.hasAttribute("aria-modal")).toBe(false);
    // The exact signal `useHistoryKeys` reads — absent, not merely "false".
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });
});

describe("LayerPropsSheet — Escape dismisses (nothing to roll back)", () => {
  test("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a modal open elsewhere keeps the keystroke — this sheet does not also close", () => {
    const onClose = vi.fn();
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={onClose}
      />,
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a non-Escape key does nothing", () => {
    const onClose = vi.fn();
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a keydown already prevented (by another handler) is left alone", () => {
    const onClose = vi.fn();
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={onClose}
      />,
    );
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("the header's own close control also calls onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("LayerPropsSheet — per-kind fields (D134's table, brief-template.ts LAYER_PROPS)", () => {
  test("accent offers solid and fade height, and nothing else", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(messages.layerPropSolidHeightLabel)).toBeTruthy();
    expect(screen.getByLabelText(messages.layerPropFadeHeightLabel)).toBeTruthy();
    expect(screen.queryByLabelText(messages.layerPropWidthLabel)).toBeNull();
    expect(screen.queryByText(messages.layerPropsNone)).toBeNull();
  });

  test("logo offers width and margin", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="logo"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(messages.layerPropWidthLabel)).toBeTruthy();
    expect(screen.getByLabelText(messages.layerPropMarginLabel)).toBeTruthy();
  });

  test("static-text offers the autofit floor and the anchor, while the axis is not live", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="static-text"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(messages.layerPropTypeFloorLabel)).toBeTruthy();
    // Named, not "the only combobox": K5 adds the tracks clock select to this
    // same sheet, and the fact under test is that the ANCHOR control is offered.
    expect(screen.getByLabelText(messages.layerPropAnchorLabel)).toBeTruthy();
  });

  test("static-text offers no anchor control while the variation axis is live (SE2)", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate(), anchorExplicit: true }}
        layerId="static-text"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(messages.layerPropTypeFloorLabel)).toBeTruthy();
    // SE2 is about the ANCHOR control specifically. Asserting "no combobox"
    // said the same thing only while this sheet had exactly one select; K5 adds
    // another, and the weaker phrasing would have started passing for the wrong
    // reason or failing for one.
    expect(screen.queryByLabelText(messages.layerPropAnchorLabel)).toBeNull();
  });

  test("image offers the alt text override", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="image"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(messages.layerPropAltLabel)).toBeTruthy();
  });

  test("shade offers the click-target checkbox and no longer says it has nothing", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="shade"
        onClose={vi.fn()}
      />,
    );
    // D160 gave every kind a control, so the empty sentence is unreachable —
    // this assertion is what keeps the deleted branch from hiding behind an
    // uncoverable coverage gap.
    expect(screen.queryByText(messages.layerPropsNone)).toBeNull();
    expect(screen.getByRole("checkbox", { name: messages.layerLinkLabel })).toBeTruthy();
  });

  test("html offers the click-target checkbox and no element editor", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: htmlTemplate() }}
        layerId="html"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox", { name: messages.layerLinkLabel })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Add an element" })).toBeNull();
  });
});

describe("LayerPropsSheet — committing and clearing a geometry prop (D134, X16)", () => {
  test("typing a value dispatches setLayerProps, and the box reflects the committed state", () => {
    let latest: EditorState | undefined;
    render(
      <StateHarness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={vi.fn()}
        onState={(s) => {
          latest = s;
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText(messages.layerPropSolidHeightLabel), {
      target: { value: "0.2" },
    });
    expect(
      (latest!.template.layers.find((l) => l.id === "accent")!.props as { solidHeight?: number })
        ?.solidHeight,
    ).toBe(0.2);
  });

  test("an emptied box and a half-typed non-number commit nothing (the FrameNumberInput contract)", () => {
    const dispatch = vi.fn();
    render(
      <LayerPropsSheet
        state={{ ...initialEditorState(), template: textTemplate() }}
        dispatch={dispatch}
        layerId="accent"
        playhead={null}
        preset={null}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(messages.layerPropSolidHeightLabel);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "1e" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a Reset control appears once overridden, and clears the override on click", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: messages.layerPropResetLabel(messages.layerPropSolidHeightLabel),
      }),
    ).toBeNull();
    const input = screen.getByLabelText(messages.layerPropSolidHeightLabel);
    fireEvent.change(input, { target: { value: "0.2" } });
    // The box keeps its own draft string until blur (`FrameNumberInput`'s own
    // contract) — a real `user.type` focuses the field first, so clicking
    // elsewhere blurs it before this assertion reads the committed value.
    fireEvent.blur(input);
    const reset = await screen.findByRole("button", {
      name: messages.layerPropResetLabel(messages.layerPropSolidHeightLabel),
    });
    await user.click(reset);
    expect(
      screen.queryByRole("button", {
        name: messages.layerPropResetLabel(messages.layerPropSolidHeightLabel),
      }),
    ).toBeNull();
    // Back to the brief-default reading — the box shows the resolved fraction.
    expect(
      (screen.getByLabelText(messages.layerPropSolidHeightLabel) as HTMLInputElement).value,
    ).toBe("0.05");
  });

  test("the image alt field's empty string is a committed value, not a clear", () => {
    let latest: EditorState | undefined;
    render(
      <StateHarness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="image"
        onClose={vi.fn()}
        onState={(s) => {
          latest = s;
        }}
      />,
    );
    const input = screen.getByLabelText(messages.layerPropAltLabel);
    fireEvent.change(input, { target: { value: "A logo" } });
    fireEvent.change(input, { target: { value: "" } });
    const imageLayer = () => latest!.template.layers.find((l) => l.id === "image")!;
    expect(imageLayer().props).toEqual({ alt: "" });
    expect("props" in imageLayer()).toBe(true);
  });

  test("the alt field's Reset control clears the override entirely", async () => {
    const user = userEvent.setup();
    let latest: EditorState | undefined;
    render(
      <StateHarness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="image"
        onClose={vi.fn()}
        onState={(s) => {
          latest = s;
        }}
      />,
    );
    const input = screen.getByLabelText(messages.layerPropAltLabel);
    fireEvent.change(input, { target: { value: "A logo" } });
    const imageLayer = () => latest!.template.layers.find((l) => l.id === "image")!;
    expect(imageLayer().props).toEqual({ alt: "A logo" });
    await user.click(
      screen.getByRole("button", {
        name: messages.layerPropResetLabel(messages.layerPropAltLabel),
      }),
    );
    expect("props" in imageLayer()).toBe(false);
  });

  test("choosing an anchor commits it, and choosing 'brief default' clears the override", async () => {
    const user = userEvent.setup();
    let latest: EditorState | undefined;
    render(
      <StateHarness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="static-text"
        onClose={vi.fn()}
        onState={(s) => {
          latest = s;
        }}
      />,
    );
    const textLayer = () => latest!.template.layers.find((l) => l.id === "static-text")!;
    const select = screen.getByLabelText(messages.layerPropAnchorLabel);
    await user.selectOptions(select, "top");
    expect(textLayer().props).toEqual({ anchor: "top" });
    await user.selectOptions(select, messages.layerPropDefault);
    expect("props" in textLayer()).toBe(false);
  });
});

describe("LayerPropsSheet — the coalesce key it reuses (setHtmlElementFrame's rule)", () => {
  test("consecutive keystrokes into one field are one undo-worthy edit (asserted at the state, via history elsewhere)", () => {
    // The coalescing itself is `useEditorHistory`'s job and is pinned in
    // `editor-history.test.tsx`; this only confirms the sheet dispatches the
    // SAME field-scoped patch shape on every keystroke, which is what makes
    // that coalescing apply at all.
    const dispatch = vi.fn();
    function DispatchHarness() {
      return (
        <LayerPropsSheet
          state={{ ...initialEditorState(), template: textTemplate() }}
          dispatch={dispatch}
          layerId="accent"
          playhead={null}
          preset={null}
          onClose={vi.fn()}
        />
      );
    }
    render(<DispatchHarness />);
    fireEvent.change(screen.getByLabelText(messages.layerPropSolidHeightLabel), {
      target: { value: "0.1" },
    });
    fireEvent.change(screen.getByLabelText(messages.layerPropSolidHeightLabel), {
      target: { value: "0.15" },
    });
    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: "setLayerProps",
      layerId: "accent",
      patch: { solidHeight: 0.1 },
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "setLayerProps",
      layerId: "accent",
      patch: { solidHeight: 0.15 },
    });
  });
});

describe("LayerPropsSheet — the creative-visible claim's other half: this panel is not full-viewport", () => {
  test("the sheet renders beside whatever else is on screen, not over it", () => {
    render(
      <>
        <div role="region" aria-label="stand-in creative rail">
          creative
        </div>
        <Harness
          initial={{ ...initialEditorState(), template: textTemplate() }}
          layerId="accent"
          onClose={vi.fn()}
        />
      </>,
    );
    expect(
      within(screen.getByRole("region", { name: "stand-in creative rail" })).getByText("creative"),
    ).toBeTruthy();
  });
});

describe("LayerPropsSheet — the fill layer's brand role (L11, D131)", () => {
  /** A template whose fill layer the sheet can be pointed at. */
  const fillTemplate = (props?: unknown): BriefTemplate => ({
    ...textTemplate(),
    layers: [
      ...TEXT_CANONICAL.layers,
      { id: "band", kind: "fill", ...(props === undefined ? {} : { props }) } as never,
    ],
  });

  test("offers the roles the domain declares, and nothing else", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: fillTemplate() }}
        layerId="band"
        onClose={vi.fn()}
      />,
    );
    const select = screen.getByLabelText(messages.layerPropRoleLabel);
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    // The empty option is "no override"; the rest are FILL_ROLES, one for one.
    expect(options).toHaveLength(FILL_ROLES.length + 1);
    expect(options[0]).toBe(messages.layerPropDefault);
    for (const role of FILL_ROLES) {
      expect(options, `role "${role}" must be offered`).toContain(fillRoleDisplayName(role));
    }
  });

  test("choosing a role writes it onto that layer's props", () => {
    let latest: EditorState | undefined;
    render(
      <StateHarness
        initial={{ ...initialEditorState(), template: fillTemplate() }}
        layerId="band"
        onClose={vi.fn()}
        onState={(s) => {
          latest = s;
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText(messages.layerPropRoleLabel), {
      target: { value: "primary" },
    });
    // Asserted against the STATE the real reducer produced, not a spy call: a
    // control that renders and dispatches nothing passes a spy-free render test.
    expect(
      (latest!.template.layers.find((l) => l.id === "band")!.props as { role?: string })?.role,
    ).toBe("primary");
  });

  test("clearing the choice removes the key rather than writing a sentinel", () => {
    let latest: EditorState | undefined;
    render(
      <StateHarness
        initial={{ ...initialEditorState(), template: fillTemplate({ role: "primary" }) }}
        layerId="band"
        onClose={vi.fn()}
        onState={(s) => {
          latest = s;
        }}
      />,
    );
    // Without this the clear below would be a no-op and the assertion would
    // hold whether or not clearing does anything.
    expect((screen.getByLabelText(messages.layerPropRoleLabel) as HTMLSelectElement).value).toBe(
      "primary",
    );
    fireEvent.change(screen.getByLabelText(messages.layerPropRoleLabel), {
      target: { value: "" },
    });
    const props = latest!.template.layers.find((l) => l.id === "band")!.props as
      | { role?: string }
      | undefined;
    expect(props?.role).toBeUndefined();
  });

  test("no other kind is offered the role control", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="accent"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(messages.layerPropRoleLabel)).toBeNull();
  });
});

describe("LayerPropsSheet — the click-target checkbox (D160)", () => {
  const VIDEO_CANONICAL = CANONICAL_TEMPLATES["video"];

  /** The image-text template with `link` spelled onto the named layer. */
  const linkedTemplate = (layerId: string, link: boolean): BriefTemplate => ({
    id: "canonical-image-text",
    version: TEXT_CANONICAL.version,
    creativeType: TEXT_CANONICAL.creativeType,
    unit: TEXT_CANONICAL.unit,
    layers: TEXT_CANONICAL.layers.map((l) => (l.id === layerId ? { ...l, link } : l)),
  });

  const videoTemplate = (): BriefTemplate => ({
    id: "canonical-video",
    version: VIDEO_CANONICAL.version,
    creativeType: VIDEO_CANONICAL.creativeType,
    unit: VIDEO_CANONICAL.unit,
    layers: VIDEO_CANONICAL.layers,
  });

  test("every layer kind gets the checkbox — image-text's layers and video", () => {
    // The rows are read from the canonical template, never a literal list —
    // the D121 guard's own rule, applied to this file too.
    for (const candidate of TEXT_CANONICAL.layers) {
      render(
        <Harness
          initial={{ ...initialEditorState(), template: textTemplate() }}
          layerId={candidate.id}
          onClose={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("checkbox", { name: messages.layerLinkLabel }),
        `layer "${candidate.id}" must offer the click-target checkbox`,
      ).toBeTruthy();
      cleanup();
    }
    render(
      <Harness
        initial={{ ...initialEditorState(), template: videoTemplate() }}
        layerId="video"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox", { name: messages.layerLinkLabel })).toBeTruthy();
  });

  test("the help line names the destination's home without naming a field", () => {
    render(
      <Harness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="shade"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(messages.layerLinkHelp)).toBeTruthy();
  });

  test("the box is checked iff the layer carries link: true — a spelled false reads unchecked", () => {
    const cases: readonly [BriefTemplate, boolean][] = [
      [textTemplate(), false],
      [linkedTemplate("shade", true), true],
      [linkedTemplate("shade", false), false],
    ];
    for (const [template, checked] of cases) {
      render(
        <Harness
          initial={{ ...initialEditorState(), template }}
          layerId="shade"
          onClose={vi.fn()}
        />,
      );
      expect(
        (screen.getByRole("checkbox", { name: messages.layerLinkLabel }) as HTMLInputElement)
          .checked,
      ).toBe(checked);
      cleanup();
    }
  });

  test("toggling the box dispatches setLayerLink with the box's own checked value", () => {
    const dispatch = vi.fn();
    render(
      <LayerPropsSheet
        state={{ ...initialEditorState(), template: linkedTemplate("image", true) }}
        dispatch={dispatch}
        layerId="image"
        playhead={null}
        preset={null}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: messages.layerLinkLabel }));
    expect(dispatch).toHaveBeenCalledWith({ type: "setLayerLink", layerId: "image", link: false });
  });

  test("through the real reducer: ticking writes link: true, unticking deletes the key", () => {
    let latest: EditorState | undefined;
    render(
      <StateHarness
        initial={{ ...initialEditorState(), template: textTemplate() }}
        layerId="logo"
        onClose={vi.fn()}
        onState={(s) => {
          latest = s;
        }}
      />,
    );
    const box = screen.getByRole("checkbox", { name: messages.layerLinkLabel });
    fireEvent.click(box);
    expect(latest!.template.layers.find((l) => l.id === "logo")!.link).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: messages.layerLinkLabel }));
    expect(Object.keys(latest!.template.layers.find((l) => l.id === "logo")!)).not.toContain(
      "link",
    );
  });
});
