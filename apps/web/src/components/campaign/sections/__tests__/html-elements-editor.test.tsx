import { describe, test, expect, vi } from "vitest";
import { useReducer } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CANONICAL_TEMPLATES,
} from "@campaignfoundry/CampaignOrchestration/creative-templates";
import { assembleHtml } from "@campaignfoundry/CampaignOrchestration/markup-assembler";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import type { HtmlElement } from "@campaignfoundry/CampaignOrchestration/html-element";
import {
  editorReducer,
  initialEditorState,
  type EditorState,
} from "@/components/campaign/editor-state";
import { TemplateSection } from "../TemplateSection";
import { HtmlElementsEditor } from "../HtmlElementsEditor";
import * as messages from "../../messages";

/**
 * HL5a — the element editor under an `html` layer.
 *
 * Two things these tests hold the line on. A control that cannot act is ABSENT,
 * never present-and-disabled (DESIGN.md §1.5): no up on the first element, no
 * down on the last, no copy input on an image. And user text reaches the DOM
 * only as an input's value (HL-D7) — the string is never parsed as markup, so a
 * value that would be an element in a browser stays characters in a box.
 */

const CANONICAL = CANONICAL_TEMPLATES["image-html"];

/** No campaign type seeds `image-html`, so the pinned id is spelled out. */
const htmlTemplate = (): BriefTemplate => ({
  id: "canonical-image-html",
  version: CANONICAL.version,
  creativeType: CANONICAL.creativeType,
  unit: CANONICAL.unit,
  layers: CANONICAL.layers,
});

const frame = { x: 0.1, y: 0.2, w: 0.5, h: 0.3, anchor: "middle" } as const;

const htmlState = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState(),
  template: htmlTemplate(),
  ...over,
});

const withElements = (...elements: HtmlElement[]): EditorState => {
  const base = htmlState();
  return {
    ...base,
    template: {
      ...base.template,
      layers: base.template.layers.map((layer) =>
        layer.id === "html" ? { ...layer, elements } : layer,
      ),
    },
  };
};

const text: HtmlElement = { kind: "text", text: "Stay wild", frame };
const button: HtmlElement = { kind: "button", text: "Shop now", frame };
const image: HtmlElement = { kind: "image", frame };

const three = () => withElements(text, button, image);

/**
 * The add row, scoped so a layer row's own controls can never answer for it.
 * Every editor test reaches its controls through here or through an accessible
 * name, so a query can never pass on a control belonging to another layer.
 */
const addGroup = () =>
  within(screen.getByRole("group", { name: messages.htmlElementAddLabel }));

/** A form control's live value — the property the user's own typing writes. */
const valueOf = (control: HTMLElement): string =>
  (control as HTMLInputElement).value;

function Harness({ initial }: { initial: EditorState }) {
  const [state, dispatch] = useReducer(editorReducer, initial);
  return <TemplateSection state={state} dispatch={dispatch} errors={{}} />;
}

/**
 * The element editor alone, driven by the real reducer, with the frame the STATE
 * holds spelled out beside it. A typing test has to read both: the string in the
 * box is what the user sees, but only the state says what was committed — a
 * value the box shows and the draft never sent would otherwise pass.
 */
function FrameHarness({ initial }: { initial: EditorState }) {
  const [state, dispatch] = useReducer(editorReducer, initial);
  const elements =
    state.template.layers.find((layer) => layer.id === "html")?.elements ?? [];
  return (
    <>
      <HtmlElementsEditor
        layerId="html"
        elements={elements}
        dispatch={dispatch}
      />
      <span data-testid="stored-frame-x">{String(elements[0]?.frame.x)}</span>
    </>
  );
}

describe("HtmlElementsEditor — where it appears (HL5a)", () => {
  test("the html layer's row carries the element editor; no other row does", () => {
    render(<TemplateSection state={htmlState()} dispatch={vi.fn()} errors={{}} />);
    const rows = screen.getAllByRole("listitem");
    // canonical-image-html: image (0), html (1), logo (2).
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1]!).getByRole("group", {
        name: messages.htmlElementAddLabel,
      }),
    ).toBeTruthy();
    expect(
      within(rows[0]!).queryByRole("group", {
        name: messages.htmlElementAddLabel,
      }),
    ).toBeNull();
    expect(
      within(rows[2]!).queryByRole("group", {
        name: messages.htmlElementAddLabel,
      }),
    ).toBeNull();
  });

  test("a template with no html layer offers no element editing at all", () => {
    render(
      <TemplateSection
        state={initialEditorState()}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(
      screen.queryByRole("group", { name: messages.htmlElementAddLabel }),
    ).toBeNull();
    expect(screen.queryByText(messages.htmlElementsEmpty)).toBeNull();
  });

  test("an html layer holding nothing says so, and still offers the three adds", () => {
    render(
      <HtmlElementsEditor layerId="html" elements={[]} dispatch={vi.fn()} />,
    );
    expect(screen.getByText(messages.htmlElementsEmpty)).toBeTruthy();
    expect(
      addGroup()
        .getAllByRole("button")
        .map((control) => control.textContent),
    ).toEqual(["Text", "Button", "Image"]);
  });
});

describe("HtmlElementsEditor — the add offer (HL5a, D18)", () => {
  test("offers exactly the element kinds, each named by its raw id with the words in the description", () => {
    render(<TemplateSection state={htmlState()} dispatch={vi.fn()} errors={{}} />);
    const group = within(
      screen.getByRole("group", { name: messages.htmlElementAddLabel }),
    );
    for (const [kind, label] of [
      ["text", "Text"],
      ["button", "Button"],
      ["image", "Image"],
    ] as const) {
      const control = group.getByRole("button", {
        name: kind,
        description: messages.htmlElementAddDescription(label),
      });
      expect(control.textContent).toBe(label);
      expect(
        document.getElementById(control.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toBe(messages.htmlElementAddDescription(label));
    }
    expect(group.getAllByRole("button")).toHaveLength(3);
  });

  test("an add dispatches addHtmlElement with the layer id and the kind", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <HtmlElementsEditor layerId="html" elements={[]} dispatch={dispatch} />,
    );
    await user.click(
      addGroup().getByRole("button", {
        name: "button",
        description: messages.htmlElementAddDescription("Button"),
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "addHtmlElement",
      layerId: "html",
      kind: "button",
    });
  });

  test("adding through the real reducer renders the element's row", async () => {
    const user = userEvent.setup();
    render(<Harness initial={htmlState()} />);
    await user.click(
      within(
        screen.getByRole("group", { name: messages.htmlElementAddLabel }),
      ).getByRole("button", {
        name: "text",
        description: messages.htmlElementAddDescription("Text"),
      }),
    );
    expect(screen.queryByText(messages.htmlElementsEmpty)).toBeNull();
    expect(
      screen.getByRole("textbox", { name: messages.htmlElementTextLabel(1) }),
    ).toBeTruthy();
  });
});

describe("HtmlElementsEditor — one element's controls (HL5a)", () => {
  test("a text and a button element carry a copy input; an image carries none", () => {
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[text, button, image]}
        dispatch={vi.fn()}
      />,
    );
    expect(
      valueOf(
        screen.getByRole("textbox", {
          name: messages.htmlElementTextLabel(1),
        }),
      ),
    ).toBe("Stay wild");
    expect(
      screen.getByRole("textbox", { name: messages.htmlElementTextLabel(2) }),
    ).toBeTruthy();
    // Absent, never present-and-disabled (DESIGN.md §1.5).
    expect(
      screen.queryByRole("textbox", { name: messages.htmlElementTextLabel(3) }),
    ).toBeNull();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });

  test("every frame field and the anchor carry a control, each with an accessible name", () => {
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[text]}
        dispatch={vi.fn()}
      />,
    );
    for (const field of ["x", "y", "w", "h"] as const) {
      const input = screen.getByRole("spinbutton", {
        name: messages.htmlElementFrameLabel(1, field),
      });
      expect(input.getAttribute("min")).toBe("0");
      expect(input.getAttribute("max")).toBe("1");
      expect(input.getAttribute("step")).toBe("0.01");
      expect(valueOf(input)).toBe(String(frame[field]));
    }
    expect(screen.getAllByRole("spinbutton")).toHaveLength(4);
    const select = screen.getByRole("combobox", {
      name: messages.htmlElementAnchorLabel(1),
    });
    expect(valueOf(select)).toBe("middle");
    expect(
      Array.from((select as HTMLSelectElement).options).map(
        (option) => option.textContent,
      ),
    ).toEqual(["Top", "Middle", "Bottom"]);
  });

  test("a frame input is named by what the field means, never by its schema key", () => {
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[text]}
        dispatch={vi.fn()}
      />,
    );
    const words = [
      "horizontal position",
      "vertical position",
      "width",
      "height",
    ];
    for (const word of words) {
      expect(
        screen.getByRole("spinbutton", { name: `Element 1 ${word}` }),
      ).toBeTruthy();
    }
    // The keys are for code: `x` on a label reads as a letter, not a place.
    for (const field of ["x", "y", "w", "h"] as const) {
      expect(
        screen.queryByRole("spinbutton", {
          name: `Element 1 ${field}`,
        }),
      ).toBeNull();
    }
  });

  test("typing in the copy input dispatches setHtmlElementText with what was typed", () => {
    // A change, not a keystroke-by-keystroke `user.type`: the input is
    // controlled, so React restores the value the props carry after every
    // event a mocked dispatch does not answer — each character would arrive as
    // the first character of a fresh value. The real-reducer test below types
    // for real, where the state does answer.
    const dispatch = vi.fn();
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[{ kind: "text", text: "", frame }]}
        dispatch={dispatch}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: messages.htmlElementTextLabel(1) }),
      { target: { value: "Go" } },
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "setHtmlElementText",
      layerId: "html",
      index: 0,
      text: "Go",
    });
  });

  test("each frame field dispatches setHtmlElementFrame with the field it names", () => {
    const dispatch = vi.fn();
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[text]}
        dispatch={dispatch}
      />,
    );
    for (const [field, value] of [
      ["x", "0.4"],
      ["y", "0.5"],
      ["w", "0.6"],
      ["h", "0.7"],
    ] as const) {
      fireEvent.change(
        screen.getByRole("spinbutton", {
          name: messages.htmlElementFrameLabel(1, field),
        }),
        { target: { value } },
      );
      expect(dispatch).toHaveBeenCalledWith({
        type: "setHtmlElementFrame",
        layerId: "html",
        index: 0,
        patch: { [field]: Number(value) },
      });
    }
  });

  test("the anchor select dispatches setHtmlElementFrame with the anchor chosen", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[text]}
        dispatch={dispatch}
      />,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: messages.htmlElementAnchorLabel(1) }),
      "top",
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "setHtmlElementFrame",
      layerId: "html",
      index: 0,
      patch: { anchor: "top" },
    });
  });
});

describe("HtmlElementsEditor — move and remove (HL5a)", () => {
  test("the first element offers no up and the last offers no down — absent, never disabled", () => {
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[text, button, image]}
        dispatch={vi.fn()}
      />,
    );
    const up = (position: number) =>
      screen.queryByRole("button", {
        name: messages.htmlElementName(position),
        description: messages.htmlElementMoveUpDescription(position),
      });
    const down = (position: number) =>
      screen.queryByRole("button", {
        name: messages.htmlElementName(position),
        description: messages.htmlElementMoveDownDescription(position),
      });
    expect(up(1)).toBeNull();
    expect(down(3)).toBeNull();
    expect(down(1)).toBeTruthy();
    expect(up(2)).toBeTruthy();
    expect(down(2)).toBeTruthy();
    expect(up(3)).toBeTruthy();
    // Nothing anywhere in the editor is disabled: a control that cannot act is
    // not rendered (DESIGN.md §1.5).
    expect(
      screen.getAllByRole("button").filter((b) => b.hasAttribute("disabled")),
    ).toEqual([]);
  });

  test("a single element offers neither move control, and always offers remove", () => {
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[text]}
        dispatch={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", {
        description: messages.htmlElementMoveUpDescription(1),
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        description: messages.htmlElementMoveDownDescription(1),
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: messages.htmlElementName(1),
        description: messages.htmlElementRemoveDescription(1),
      }),
    ).toBeTruthy();
  });

  test("up, down and remove dispatch their action with the element's index", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[text, button, image]}
        dispatch={dispatch}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: messages.htmlElementName(2),
        description: messages.htmlElementMoveUpDescription(2),
      }),
    );
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "moveHtmlElement",
      layerId: "html",
      from: 1,
      to: 0,
    });
    await user.click(
      screen.getByRole("button", {
        name: messages.htmlElementName(2),
        description: messages.htmlElementMoveDownDescription(2),
      }),
    );
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "moveHtmlElement",
      layerId: "html",
      from: 1,
      to: 2,
    });
    await user.click(
      screen.getByRole("button", {
        name: messages.htmlElementName(2),
        description: messages.htmlElementRemoveDescription(2),
      }),
    );
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "removeHtmlElement",
      layerId: "html",
      index: 1,
    });
  });

  test("a move control's description is the sr-only span it points at", () => {
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[text, button]}
        dispatch={vi.fn()}
      />,
    );
    const move = screen.getByRole("button", {
      name: messages.htmlElementName(2),
      description: messages.htmlElementMoveUpDescription(2),
    });
    expect(
      document.getElementById(move.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe(messages.htmlElementMoveUpDescription(2));
  });

  test("reordering through the real reducer re-renders the rows in the new order", async () => {
    const user = userEvent.setup();
    render(<Harness initial={three()} />);
    const copy = (position: number) =>
      screen.getByRole("textbox", {
        name: messages.htmlElementTextLabel(position),
      });
    expect(valueOf(copy(1))).toBe("Stay wild");
    expect(valueOf(copy(2))).toBe("Shop now");
    await user.click(
      screen.getByRole("button", {
        name: messages.htmlElementName(2),
        description: messages.htmlElementMoveUpDescription(2),
      }),
    );
    expect(valueOf(copy(1))).toBe("Shop now");
    expect(valueOf(copy(2))).toBe("Stay wild");
  });
});

describe("HtmlElementsEditor — a frame value is typed one digit at a time (HL5a)", () => {
  /** The frame's `x` in the state the reducer holds — the value a Save would write. */
  const storedX = () =>
    document.querySelector('[data-testid="stored-frame-x"]')?.textContent;

  const xInput = () =>
    screen.getByRole("spinbutton", {
      name: messages.htmlElementFrameLabel(1, "x"),
    });

  test("a decimal fraction can be typed digit by digit: 0.25 reaches the state", async () => {
    const user = userEvent.setup();
    render(<FrameHarness initial={withElements(text)} />);
    await user.clear(xInput());
    await user.type(xInput(), "0.25");
    expect(valueOf(xInput())).toBe("0.25");
    expect(storedX()).toBe("0.25");
  });

  test("clearing the field commits nothing — never a zero the user did not type", async () => {
    const user = userEvent.setup();
    render(<FrameHarness initial={withElements(text)} />);
    expect(storedX()).toBe("0.1");
    await user.clear(xInput());
    await user.tab();
    // The box was emptied and left: the stored frame is the one it had, and the
    // box shows it again — an empty field is a state of the box, not a number.
    expect(storedX()).toBe("0.1");
    expect(valueOf(xInput())).toBe("0.1");
  });

  test("leaving the field shows the stored, clamped value — 1.5 was stored as 1", async () => {
    const user = userEvent.setup();
    render(<FrameHarness initial={withElements(text)} />);
    await user.clear(xInput());
    await user.type(xInput(), "1.5");
    // While the caret is in the box the user's own characters are on screen…
    expect(valueOf(xInput())).toBe("1.5");
    await user.tab();
    // …and once it leaves, the number the state clamped to (D130).
    expect(storedX()).toBe("1");
    expect(valueOf(xInput())).toBe("1");
  });

  test("a half-typed number is not a number — the box keeps '1e', the draft keeps 1", async () => {
    const user = userEvent.setup();
    render(<FrameHarness initial={withElements(text)} />);
    await user.clear(xInput());
    await user.type(xInput(), "1e");
    // "1" was a number and was committed (clamped to the top of the range);
    // "1e" is not one, so the characters stay in the box and nothing more is
    // written — the draft is never handed a NaN.
    expect(storedX()).toBe("1");
    expect(valueOf(xInput())).toBe("1e");
    // …and finishing it commits the number the box now holds.
    await user.type(xInput(), "-1");
    expect(storedX()).toBe("0.1");
    await user.tab();
    expect(valueOf(xInput())).toBe("0.1");
  });
});

describe("HtmlElementsEditor — user text never reaches the DOM as markup (HL-D7)", () => {
  test("a value that would be an element in a browser stays an input's value", async () => {
    const user = userEvent.setup();
    render(<Harness initial={withElements(text)} />);
    const hostile = '<img src=x onerror="window.__x=1">';
    const input = screen.getByRole("textbox", {
      name: messages.htmlElementTextLabel(1),
    });
    await user.clear(input);
    await user.type(input, hostile);
    // The characters are in the box, exactly as typed…
    expect(
      valueOf(
        screen.getByRole("textbox", {
          name: messages.htmlElementTextLabel(1),
        }),
      ),
    ).toBe(hostile);
    // …and nowhere else: no element was parsed out of them, and the handler
    // never ran.
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect((window as unknown as { __x?: number }).__x).toBeUndefined();
  });

  test("the editor renders no markup of the element's own making", () => {
    render(
      <HtmlElementsEditor
        layerId="html"
        elements={[{ kind: "text", text: "<b>bold</b>", frame }]}
        dispatch={vi.fn()}
      />,
    );
    expect(document.querySelector("b")).toBeNull();
    expect(
      valueOf(
        screen.getByRole("textbox", {
          name: messages.htmlElementTextLabel(1),
        }),
      ),
    ).toBe("<b>bold</b>");
  });
});

describe("HtmlWeightMeter — the live weight of the html unit (HL5c, HL-D6)", () => {
  /** The element editor's state, aimed at one html placement at one size. */
  const meterWith = (
    elements: HtmlElement[],
    over: Partial<EditorState> = {},
  ): EditorState => ({
    ...withElements(...elements),
    platforms: ["google-display-html"],
    sizes: ["300x250"],
    ...over,
  });

  /** The weight the assembler reports for exactly these inputs. */
  const assembledBytes = (elements: readonly HtmlElement[]): number =>
    assembleHtml({
      elements,
      canvas: { size: "300x250" },
      brandColor: "#1473E6",
      style: {},
    }).byteLength;

  test("the meter reads the measured weight against the placement's own budget", () => {
    render(
      <TemplateSection
        state={meterWith([text])}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(
      screen.getByText(
        messages.htmlWeightMeterText(
          assembledBytes([text]),
          150 * 1024,
          "Google Display (HTML5)",
        ),
      ),
    ).toBeTruthy();
    // The fallback sentence: its bytes join the same budget at packaging.
    expect(screen.getByText(messages.htmlWeightFallbackNote)).toBeTruthy();
  });

  test("over budget, the meter says so with the overage", () => {
    const big: HtmlElement = {
      kind: "text",
      text: "A".repeat(200_000),
      frame,
    };
    render(
      <TemplateSection state={meterWith([big])} dispatch={vi.fn()} errors={{}} />,
    );
    expect(
      screen.getByText(messages.htmlWeightOverage(assembledBytes([big]) - 150 * 1024)),
    ).toBeTruthy();
  });

  test("no meter without an html profile", () => {
    // The default draft selects the static platforms — no html budget exists
    // to read (HL-D6), so the meter shows nothing rather than a made-up number.
    render(
      <TemplateSection
        state={withElements(text)}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.queryByText(/KB of/)).toBeNull();
    expect(screen.queryByText(messages.htmlWeightFallbackNote)).toBeNull();
  });

  test("no meter on non-html layers", () => {
    render(
      <TemplateSection
        state={meterWith([], { template: initialEditorState().template })}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.queryByText(/KB of/)).toBeNull();
  });

  test("the meter measures the markup without ever putting it in the DOM (HL-D7)", () => {
    const hostile: HtmlElement = {
      kind: "text",
      text: '<img src=x onerror="window.__m=1">',
      frame,
    };
    render(
      <TemplateSection
        state={meterWith([hostile], {
          clickDestination: "https://example.com/<script>bad</script>",
        })}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    // The hostile strings are counted — but nothing was parsed out of them.
    expect(screen.getByText(messages.htmlWeightFallbackNote)).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { __m?: number }).__m).toBeUndefined();
    // And no user text reaches the DOM outside an input's value: the meter's
    // own sentence carries numbers and the profile label, never the copy.
    const offenders = Array.from(document.querySelectorAll("*")).filter(
      (el) =>
        el.tagName !== "INPUT" &&
        Array.from(el.childNodes).some(
          (node) =>
            node.nodeType === 3 &&
            (node.textContent ?? "").includes("onerror"),
        ),
    );
    expect(offenders).toEqual([]);
  });
});

/* ── HL5e — per-element style selects ─────────────────────────────────────── */

describe("HtmlElementsEditor — style overrides (HL5e)", () => {
  /** The element row for position `n`, scoped like every other row query:
   *  the list's order IS the elements' order, the panel's own contract. */
  const row = (n: number) => within(screen.getAllByRole("listitem")[n - 1]!);

  function StyleHarness({ initial }: { initial: EditorState }) {
    const [state, dispatch] = useReducer(editorReducer, initial);
    const elements =
      state.template.layers.find((layer) => layer.id === "html")?.elements ?? [];
    return (
      <>
        <HtmlElementsEditor layerId="html" elements={elements} dispatch={dispatch} />
        <span data-testid="stored-style">
          {JSON.stringify(elements[0]?.style ?? null)}
        </span>
      </>
    );
  }

  test("text and button rows carry a weight and a family select; an image row carries neither", () => {
    render(<StyleHarness initial={three()} />);
    for (const position of [1, 2]) {
      const r = row(position);
      r.getByRole("combobox", { name: messages.htmlElementWeightLabel(position) });
      r.getByRole("combobox", { name: messages.htmlElementFamilyLabel(position) });
    }
    const imageRow = row(3);
    expect(
      imageRow.queryByRole("combobox", {
        name: messages.htmlElementWeightLabel(3),
      }),
    ).toBeNull();
    expect(
      imageRow.queryByRole("combobox", {
        name: messages.htmlElementFamilyLabel(3),
      }),
    ).toBeNull();
  });

  test("the selects read 'brief default' while the element carries no override", () => {
    render(<StyleHarness initial={three()} />);
    const r = row(1);
    const weight = r.getByRole("combobox", {
      name: messages.htmlElementWeightLabel(1),
    }) as HTMLSelectElement;
    const family = r.getByRole("combobox", {
      name: messages.htmlElementFamilyLabel(1),
    }) as HTMLSelectElement;
    expect(weight.value).toBe("");
    expect(family.value).toBe("");
    expect(
      within(weight).getByRole("option", { name: messages.htmlElementStyleDefault }),
    ).toBeTruthy();
    expect(within(family).getByRole("option", { name: "Lora" })).toBeTruthy();
  });

  test("choosing an override dispatches it and the draft carries the key", async () => {
    const user = userEvent.setup();
    render(<StyleHarness initial={three()} />);
    const r = row(1);
    await user.selectOptions(
      r.getByRole("combobox", { name: messages.htmlElementWeightLabel(1) }),
      "400",
    );
    expect(screen.getByTestId("stored-style").textContent).toBe(
      JSON.stringify({ fontWeight: 400 }),
    );
    await user.selectOptions(
      r.getByRole("combobox", { name: messages.htmlElementFamilyLabel(1) }),
      "Lora",
    );
    expect(screen.getByTestId("stored-style").textContent).toBe(
      JSON.stringify({ fontWeight: 400, fontFamily: "Lora" }),
    );
  });

  test("choosing 'brief default' removes the field — and an all-absent style removes the key", async () => {
    const user = userEvent.setup();
    const styled: HtmlElement = {
      kind: "text",
      text: "Stay wild",
      frame,
      style: { fontWeight: 400, fontFamily: "Lora" },
    };
    render(<StyleHarness initial={withElements(styled)} />);
    const r = row(1);
    expect(
      (
        r.getByRole("combobox", { name: messages.htmlElementWeightLabel(1) }) as HTMLSelectElement
      ).value,
    ).toBe("400");
    await user.selectOptions(
      r.getByRole("combobox", { name: messages.htmlElementFamilyLabel(1) }),
      "",
    );
    expect(screen.getByTestId("stored-style").textContent).toBe(
      JSON.stringify({ fontWeight: 400 }),
    );
    await user.selectOptions(
      r.getByRole("combobox", { name: messages.htmlElementWeightLabel(1) }),
      "",
    );
    expect(screen.getByTestId("stored-style").textContent).toBe("null");
  });
});
