import { describe, test, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useReducer, useState } from "react";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplateLayer,
} from "@campaignfoundry/CampaignOrchestration/creative-templates";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { editorReducer, initialEditorState, type EditorState } from "../editor-state";
import { LayerPropsSheet } from "../LayerPropsSheet";
import { poseTAt } from "../TrackForm";
import * as messages from "../messages";

/**
 * K5 / SE6 / TL5 — the tracks form, `studio-editor.md` §4.4.
 *
 * Driven through `LayerPropsSheet` rather than by mounting `TrackForm`
 * directly: the sheet owns the two gates (a trackable kind, and DoD 6's
 * disabled-layer rule), so testing the form alone would assert a surface the
 * operator cannot actually reach.
 */

const CANONICAL = CANONICAL_TEMPLATES["image-text"];
const TEXT_ID = CANONICAL.layers.find((l) => l.kind === "static-text")!.id;
const IMAGE_ID = CANONICAL.layers.find((l) => l.kind === "image")!.id;
const SHADE_ID = CANONICAL.layers.find((l) => l.kind === "shade")!.id;

const template = (layers: readonly CreativeTemplateLayer[] = CANONICAL.layers): BriefTemplate => ({
  id: "canonical-image-text",
  version: CANONICAL.version,
  creativeType: CANONICAL.creativeType,
  unit: CANONICAL.unit,
  layers,
});

function Harness({
  layers,
  layerId,
  playhead,
  onState,
}: {
  layers?: readonly CreativeTemplateLayer[];
  layerId: string;
  playhead?: { durationSec: number; committedSec: number } | null;
  onState?: (state: EditorState) => void;
}) {
  const [state, dispatch] = useReducer(editorReducer, {
    ...initialEditorState(),
    template: template(layers),
  });
  onState?.(state);
  return (
    <LayerPropsSheet
      state={state}
      dispatch={dispatch}
      layerId={layerId}
      playhead={playhead ?? null}
      onClose={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("poseTAt — §4.4 rule 3's one honest mapping", () => {
  test("maps the committed second onto the whole-creative clock", () => {
    expect(poseTAt({ durationSec: 8, committedSec: 2 })).toBe(0.25);
  });

  test("no playhead, and a zero duration, both start a stop at 0 rather than dividing", () => {
    expect(poseTAt(null)).toBe(0);
    expect(poseTAt({ durationSec: 0, committedSec: 3 })).toBe(0);
  });

  test("clamps into [0, 1] rather than trusting the caller", () => {
    expect(poseTAt({ durationSec: 4, committedSec: 9 })).toBe(1);
    expect(poseTAt({ durationSec: 4, committedSec: -2 })).toBe(0);
  });
});

describe("which layers are offered the section", () => {
  test("a trackable kind gets it", () => {
    render(<Harness layerId={TEXT_ID} />);
    expect(screen.getByTestId("layer-tracks")).toBeTruthy();
  });

  test("a kind outside TRACKABLE_LAYER_KINDS does not", () => {
    render(<Harness layerId={SHADE_ID} />);
    expect(screen.queryByTestId("layer-tracks")).toBeNull();
  });

  test("a DISABLED trackable layer does not (DoD 6)", () => {
    // Editor-only: the domain accepts tracks on a disabled layer and K-D4
    // resolves them to nothing, so the controls go away without the editor
    // claiming a refusal the boundary does not make.
    const layers = CANONICAL.layers.map((l) =>
      l.id === TEXT_ID ? ({ ...l, enabled: false } as CreativeTemplateLayer) : l,
    );
    render(<Harness layers={layers} layerId={TEXT_ID} />);
    expect(screen.queryByTestId("layer-tracks")).toBeNull();
  });
});

describe("the clock select — §4.4 rules 4 and 5", () => {
  test("a text kind is offered all three clocks", () => {
    render(<Harness layerId={TEXT_ID} />);
    const select = screen.getByLabelText(messages.tracksClockLabel) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["pose", "beat", "effect"]);
  });

  test("a non-text trackable kind is offered only `pose`, and told why", () => {
    // A select whose every dispatch the boundary would refuse is the
    // live-looking control SG-D22 argued against.
    render(<Harness layerId={IMAGE_ID} />);
    const select = screen.getByLabelText(messages.tracksClockLabel) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["pose"]);
    expect(screen.getByText(messages.tracksClockTextOnly)).toBeTruthy();
  });
});

describe("authoring a stop", () => {
  test("adding a stop writes it at the playhead's pose `t` (rule 3)", () => {
    let latest: EditorState | undefined;
    render(
      <Harness
        layerId={TEXT_ID}
        playhead={{ durationSec: 10, committedSec: 5 }}
        onState={(s) => (latest = s)}
      />,
    );
    fireEvent.click(
      screen.getByLabelText(messages.tracksAddStopLabel(messages.TRACK_PROPERTY_LABEL.opacity!)),
    );
    const tracks = latest!.template.layers.find((l) => l.id === TEXT_ID)!.tracks!;
    expect(tracks).toEqual([
      // The value is `IDENTITY_POSE.opacity`, so a new stop cannot move a
      // render on its own until it is edited.
      { property: "opacity", stops: [{ t: 0.5, value: 1, clock: "pose" }] },
    ]);
  });

  test("a second stop on a different clock starts a second track (rule 4)", () => {
    let latest: EditorState | undefined;
    render(<Harness layerId={TEXT_ID} onState={(s) => (latest = s)} />);
    const addOpacity = () =>
      screen.getByLabelText(messages.tracksAddStopLabel(messages.TRACK_PROPERTY_LABEL.opacity!));
    fireEvent.click(addOpacity());
    fireEvent.change(screen.getByLabelText(messages.tracksClockLabel), {
      target: { value: "beat" },
    });
    fireEvent.click(addOpacity());
    const tracks = latest!.template.layers.find((l) => l.id === TEXT_ID)!.tracks!;
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t) => t.stops[0]!.clock)).toEqual(["pose", "beat"]);
  });

  test("a stop the domain would refuse disables the control and says why, in the domain's words", () => {
    // Both stops would land at t=0 on the same (property, clock) pair, which
    // `layerTracksProblem` refuses as a duplicate. The message is its `must`
    // clause — the editor frames it and invents nothing.
    render(<Harness layerId={TEXT_ID} />);
    const add = () =>
      screen.getByLabelText(
        messages.tracksAddStopLabel(messages.TRACK_PROPERTY_LABEL.opacity!),
      ) as HTMLButtonElement;
    fireEvent.click(add());
    expect(add().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("unique");
  });

  test("removing the only stop takes the whole section back to empty", () => {
    let latest: EditorState | undefined;
    render(<Harness layerId={TEXT_ID} onState={(s) => (latest = s)} />);
    fireEvent.click(
      screen.getByLabelText(messages.tracksAddStopLabel(messages.TRACK_PROPERTY_LABEL.opacity!)),
    );
    fireEvent.click(
      screen.getByLabelText(
        messages.tracksRemoveStopLabel(messages.TRACK_PROPERTY_LABEL.opacity!, 0),
      ),
    );
    expect(latest!.template.layers.find((l) => l.id === TEXT_ID)!.tracks).toBeUndefined();
    expect(within(screen.getByTestId("layer-tracks")).getByText(messages.tracksNone)).toBeTruthy();
  });

  test("the easing select's Default option clears the key", () => {
    let latest: EditorState | undefined;
    render(<Harness layerId={TEXT_ID} onState={(s) => (latest = s)} />);
    fireEvent.click(
      screen.getByLabelText(messages.tracksAddStopLabel(messages.TRACK_PROPERTY_LABEL.opacity!)),
    );
    const easing = screen.getByLabelText(messages.tracksStopEasingLabel);
    fireEvent.change(easing, { target: { value: "linear" } });
    expect(
      latest!.template.layers.find((l) => l.id === TEXT_ID)!.tracks![0]!.stops[0]!.easing,
    ).toBe("linear");
    fireEvent.change(easing, { target: { value: "" } });
    expect(
      "easing" in latest!.template.layers.find((l) => l.id === TEXT_ID)!.tracks![0]!.stops[0]!,
    ).toBe(false);
  });
});

describe("the stop's number boxes keep their own draft (the GeometryNumberField rule)", () => {
  const seeded = (onState?: (s: EditorState) => void) => {
    render(<Harness layerId={TEXT_ID} onState={onState} />);
    fireEvent.click(
      screen.getByLabelText(messages.tracksAddStopLabel(messages.TRACK_PROPERTY_LABEL.opacity!)),
    );
  };

  test("typing a number into `t` commits it", () => {
    let latest: EditorState | undefined;
    seeded((s) => (latest = s));
    fireEvent.change(screen.getByLabelText(messages.tracksStopTimeLabel), {
      target: { value: "0.4" },
    });
    expect(latest!.template.layers.find((l) => l.id === TEXT_ID)!.tracks![0]!.stops[0]!.t).toBe(
      0.4,
    );
  });

  test("typing a number into `value` commits it", () => {
    let latest: EditorState | undefined;
    seeded((s) => (latest = s));
    fireEvent.change(screen.getByLabelText(messages.tracksStopValueLabel), {
      target: { value: "0.6" },
    });
    expect(latest!.template.layers.find((l) => l.id === TEXT_ID)!.tracks![0]!.stops[0]!.value).toBe(
      0.6,
    );
  });

  test("an emptied box and a half-typed one commit nothing — they are states of the box, not numbers", () => {
    let latest: EditorState | undefined;
    seeded((s) => (latest = s));
    const stopOf = () =>
      latest!.template.layers.find((l) => l.id === TEXT_ID)!.tracks![0]!.stops[0]!;
    const before = stopOf();
    fireEvent.change(screen.getByLabelText(messages.tracksStopTimeLabel), {
      target: { value: "" },
    });
    expect(stopOf()).toEqual(before);
    fireEvent.change(screen.getByLabelText(messages.tracksStopValueLabel), {
      target: { value: "abc" },
    });
    expect(stopOf()).toEqual(before);
  });

  test("blurring drops the draft so the box shows the committed value again", () => {
    seeded();
    const t = screen.getByLabelText(messages.tracksStopTimeLabel) as HTMLInputElement;
    fireEvent.change(t, { target: { value: "" } });
    expect(t.value).toBe("");
    fireEvent.blur(t);
    expect(t.value).toBe("0");

    // The value box keeps its own draft independently — same rule, second box.
    const v = screen.getByLabelText(messages.tracksStopValueLabel) as HTMLInputElement;
    fireEvent.change(v, { target: { value: "" } });
    expect(v.value).toBe("");
    fireEvent.blur(v);
    expect(v.value).toBe("1");
  });
});

describe("both number boxes refuse a draft that is not yet a number", () => {
  const seeded = (onState?: (s: EditorState) => void) => {
    render(<Harness layerId={TEXT_ID} onState={onState} />);
    fireEvent.click(
      screen.getByLabelText(messages.tracksAddStopLabel(messages.TRACK_PROPERTY_LABEL.opacity!)),
    );
  };

  test("`t` commits neither an empty box nor a non-numeric one", () => {
    let latest: EditorState | undefined;
    seeded((s) => (latest = s));
    const stopOf = () =>
      latest!.template.layers.find((l) => l.id === TEXT_ID)!.tracks![0]!.stops[0]!;
    const before = stopOf();
    const t = screen.getByLabelText(messages.tracksStopTimeLabel);
    fireEvent.change(t, { target: { value: "" } });
    expect(stopOf()).toEqual(before);
    // "1e" is the half-typed draft that SURVIVES a number input — a plain
    // word is blanked by the control before the handler sees it, so it would
    // only exercise the empty guard above (the idiom this file borrows from
    // LayerPropsSheet.test.tsx).
    fireEvent.change(t, { target: { value: "1e" } });
    expect(stopOf()).toEqual(before);
  });

  test("`value` commits neither an empty box nor a non-numeric one", () => {
    let latest: EditorState | undefined;
    seeded((s) => (latest = s));
    const stopOf = () =>
      latest!.template.layers.find((l) => l.id === TEXT_ID)!.tracks![0]!.stops[0]!;
    const before = stopOf();
    const v = screen.getByLabelText(messages.tracksStopValueLabel);
    fireEvent.change(v, { target: { value: "" } });
    expect(stopOf()).toEqual(before);
    fireEvent.change(v, { target: { value: "1e" } });
    expect(stopOf()).toEqual(before);
  });
});

describe("a clock the newly picked layer cannot carry falls back rather than sticking", () => {
  test("choosing `beat` on a text layer, then picking an image layer, lands on `pose`", () => {
    // The select's choice is component state and the sheet keeps ONE TrackForm
    // instance as the picked layer changes, so the chosen clock outlives the
    // layer it was chosen for. Without the fallback the select would show and
    // dispatch `beat` on an image — which `layerTracksProblem` refuses (rule
    // 5), i.e. a control that silently does nothing.
    function Switcher() {
      const [state, dispatch] = useReducer(editorReducer, {
        ...initialEditorState(),
        template: template(),
      });
      const [id, setId] = useState(TEXT_ID);
      return (
        <>
          <button type="button" onClick={() => setId(IMAGE_ID)}>
            to image
          </button>
          <LayerPropsSheet
            state={state}
            dispatch={dispatch}
            layerId={id}
            playhead={null}
            onClose={vi.fn()}
          />
        </>
      );
    }
    render(<Switcher />);
    fireEvent.change(screen.getByLabelText(messages.tracksClockLabel), {
      target: { value: "beat" },
    });
    expect((screen.getByLabelText(messages.tracksClockLabel) as HTMLSelectElement).value).toBe(
      "beat",
    );
    fireEvent.click(screen.getByRole("button", { name: "to image" }));
    const select = screen.getByLabelText(messages.tracksClockLabel) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["pose"]);
    expect(select.value).toBe("pose");
  });
});
