"use client";

import { useId, useState, type Dispatch } from "react";
import {
  FONT_FAMILY_VALUES,
  FONT_WEIGHT_VALUES,
  type FontFamilyKind,
  type FontWeightKind,
} from "@campaignfoundry/CampaignOrchestration/creative-style";
import { Button, IconButton, Input } from "@/components/ui";
import type { HtmlWeightReading } from "@/components/campaign/derive";
import type {
  EditorAction,
  Frame,
  HtmlElement,
  HtmlElementKind,
} from "@/components/campaign/editor-state";
import { ANCHOR_OPTIONS, HTML_ELEMENT_KINDS } from "@/components/campaign/editor-state";
import { anchorDisplayName, weightDisplayName } from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";
import { Field } from "./IdentitySection";

/**
 * The `html` layer's element editor (HL5a, HL-D1, HL-D2).
 *
 * Elements are the second vocabulary — nested inside the layer list, never a
 * layer of their own — so this panel belongs beneath one layer rather than in a
 * section of its own. It adds, removes, reorders and edits them, and nothing
 * else: the frame it writes is geometry, the copy it writes is text, and every
 * value it can produce is one the domain already accepts at the boundary.
 * Beneath it, when an html placement is selected, rides the live weight meter
 * (HL5c, HL-D6) — the assembled markup measured against the placement's own
 * `maxBytes`, numbers only (see the HL-D7 note on the meter itself).
 *
 * A control that cannot act is ABSENT, never present-and-disabled (DESIGN.md
 * §1.5): the first element offers no move up, the last offers no move down, and
 * an `image` element — which the domain refuses copy on — offers no text input
 * at all.
 *
 * **HL-D7:** user text reaches the DOM only as an input's `value`. There is no
 * preview of the markup here, no `dangerouslySetInnerHTML` anywhere in this
 * file, and what the element would look like is the canvas rendition's job
 * (HL5d) — never this panel's.
 *
 * The kit's naming contract (D18, as `PlatformCard` pins it): an add control's
 * accessible name is the raw kind id and the display words live in an
 * `aria-describedby` description; an element row's controls name themselves by
 * the element's position, which is the only identity an element has, the way a
 * timeline beat's controls do.
 */

/** A frame's numeric fields, in the order the row shows them. */
const FRAME_NUMBER_FIELDS = [
  "x",
  "y",
  "w",
  "h",
] as const satisfies readonly messages.FrameNumberField[];

/** The one frame patch a number input can write — never a stringly-typed key. */
function framePatch(field: (typeof FRAME_NUMBER_FIELDS)[number], value: number): Partial<Frame> {
  switch (field) {
    case "x":
      return { x: value };
    case "y":
      return { y: value };
    case "w":
      return { w: value };
    case "h":
      return { h: value };
  }
}

/**
 * One frame field's number input (HL5a).
 *
 * What the user types is a STRING and what the draft holds is a CLAMPED NUMBER,
 * and the gap between them is where a decimal point goes to die. A controlled
 * `value={String(frame[field])}` re-renders after every keystroke with the
 * number's own rendering of what was typed, so a half-typed `0.` — which the
 * reducer stores as `0` — comes back as `"0"`, the point is gone and `0.25`
 * can never be finished. Worse, a field the user emptied reads as
 * `Number("") === 0`: a zero nobody typed, committed to the draft.
 *
 * So the box keeps its own draft string while it is being edited and hands a
 * number to the reducer only once the draft parses to a finite one. Blur drops
 * the draft and the box goes back to showing the stored — clamped — value,
 * which is also how a number the domain refuses but the box allows (1.5) is
 * corrected in front of the user rather than behind their back.
 */
function FrameNumberInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Field label={label}>
      <Input
        type="number"
        min={0}
        max={1}
        step={0.01}
        value={draft ?? String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          // Empty, and half-typed to something that is no number yet ("1e"):
          // states of the box, not numbers. Nothing is committed, and the
          // characters stay on screen so the next digit finishes the value.
          if (raw.trim() === "") return;
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return;
          onCommit(parsed);
        }}
        onBlur={() => setDraft(null)}
      />
    </Field>
  );
}

/** The one style patch a select can write — never a stringly-typed key. */
type ElementStyleField = "fontWeight" | "fontFamily";

function stylePatch(
  field: ElementStyleField,
  value: string,
): Partial<{ fontWeight: FontWeightKind; fontFamily: FontFamilyKind }> {
  // The "brief default" face is the empty value: it writes the ABSENT key
  // (HL5e) — the reducer drops the field, and drops the whole block when the
  // last one goes, so the round trip returns the element to its loaded shape.
  if (value === "") return { [field]: undefined };
  if (field === "fontWeight") return { fontWeight: Number(value) as FontWeightKind };
  return { fontFamily: value as FontFamilyKind };
}

/**
 * One style select (HL5e): the brief's own resolved value stands behind the
 * "brief default" face, and the vocabulary faces come from the domain's lists
 * — never restated here, the way every other option list in this panel is.
 */
function StyleSelect({
  label,
  value,
  options,
  onCommit,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onCommit: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        // The value the DOM can hand back is one of the options rendered
        // below, and the reducer checks it against the domain's own
        // vocabularies before it writes.
        onChange={(e) => onCommit(e.target.value)}
        className="rounded border border-border-control bg-surface px-3 py-2 text-sm text-text-emphasis"
      >
        <option value="">{messages.htmlElementStyleDefault}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function HtmlElementsEditor({
  layerId,
  elements,
  dispatch,
  reading,
}: {
  layerId: string;
  elements: readonly HtmlElement[];
  dispatch: Dispatch<EditorAction>;
  /**
   * The draft's weight reading (HL5c, HL-D6), derived by the section from the
   * same state this editor edits. Absent when there is nothing to weigh (no
   * html placement selected) — then no meter renders, never a meter at zero.
   */
  reading?: HtmlWeightReading;
}) {
  // Description ids ride one instance id: the guided walk mounts two live
  // copies of the section during a step change, so a static id would be
  // duplicated in the document — the trap the kit's own cards avoid.
  const uid = useId();
  const addDescId = (kind: HtmlElementKind) => `${uid}-add-${kind}`;
  const moveUpDescId = (index: number) => `${uid}-up-${index}`;
  const moveDownDescId = (index: number) => `${uid}-down-${index}`;
  const removeDescId = (index: number) => `${uid}-remove-${index}`;

  const add = (kind: HtmlElementKind) => dispatch({ type: "addHtmlElement", layerId, kind });

  return (
    <div className="space-y-2 pt-2">
      {elements.length > 0 ? (
        <ol aria-label={messages.htmlElementsLabel} className="space-y-2">
          {elements.map((element, index) => {
            const position = index + 1;
            const name = messages.htmlElementName(position);
            return (
              <li
                key={index}
                className="space-y-2 rounded-md border border-border bg-surface px-2 py-2"
              >
                <span className="block font-mono text-[11px] text-text-muted">
                  {messages.htmlElementKindLabel(element.kind)}
                </span>
                {element.kind === "image" ? null : (
                  <Field label={messages.htmlElementTextLabel(position)}>
                    <Input
                      // No `?? ""` fallback: the domain marks `text` required on
                      // the two kinds that reach this input, so an element
                      // without copy cannot be in the draft — and a fallback
                      // would be a branch no test could ever take.
                      value={element.text}
                      onChange={(e) =>
                        dispatch({
                          type: "setHtmlElementText",
                          layerId,
                          index,
                          text: e.target.value,
                        })
                      }
                    />
                  </Field>
                )}
                <div className="flex flex-wrap items-start gap-2">
                  {FRAME_NUMBER_FIELDS.map((field) => (
                    <FrameNumberInput
                      key={field}
                      label={messages.htmlElementFrameLabel(position, field)}
                      value={element.frame[field]}
                      onCommit={(value) =>
                        dispatch({
                          type: "setHtmlElementFrame",
                          layerId,
                          index,
                          patch: framePatch(field, value),
                        })
                      }
                    />
                  ))}
                  <Field label={messages.htmlElementAnchorLabel(position)}>
                    <select
                      value={element.frame.anchor}
                      // The value the DOM can hand back is one of the options
                      // rendered below, and the reducer checks it against the
                      // domain's own `ANCHOR_VALUES` before it writes.
                      onChange={(e) =>
                        dispatch({
                          type: "setHtmlElementFrame",
                          layerId,
                          index,
                          patch: { anchor: e.target.value as Frame["anchor"] },
                        })
                      }
                      className="rounded border border-border-control bg-surface px-3 py-2 text-sm text-text-emphasis"
                    >
                      {ANCHOR_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {anchorDisplayName(option)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {/* The font overrides (HL5e), beside the copy they restate:
                      the `text` and `button` rows only — the domain's field
                      table refuses `style` on an `image`, so the row offers no
                      control for it (DESIGN.md §1.5). */}
                  {element.kind === "image" ? null : (
                    <>
                      <StyleSelect
                        label={messages.htmlElementWeightLabel(position)}
                        value={
                          element.style?.fontWeight !== undefined
                            ? String(element.style.fontWeight)
                            : ""
                        }
                        options={FONT_WEIGHT_VALUES.map((weight) => ({
                          value: String(weight),
                          label: weightDisplayName(weight),
                        }))}
                        onCommit={(value) =>
                          dispatch({
                            type: "setHtmlElementStyle",
                            layerId,
                            index,
                            patch: stylePatch("fontWeight", value),
                          })
                        }
                      />
                      <StyleSelect
                        label={messages.htmlElementFamilyLabel(position)}
                        value={element.style?.fontFamily ?? ""}
                        options={FONT_FAMILY_VALUES.map((family) => ({
                          value: family,
                          label: family,
                        }))}
                        onCommit={(value) =>
                          dispatch({
                            type: "setHtmlElementStyle",
                            layerId,
                            index,
                            patch: stylePatch("fontFamily", value),
                          })
                        }
                      />
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {index > 0 ? (
                    <span className="flex shrink-0 items-center">
                      <span id={moveUpDescId(index)} className="sr-only">
                        {messages.htmlElementMoveUpDescription(position)}
                      </span>
                      <IconButton
                        label={name}
                        aria-describedby={moveUpDescId(index)}
                        onClick={() =>
                          dispatch({
                            type: "moveHtmlElement",
                            layerId,
                            from: index,
                            to: index - 1,
                          })
                        }
                      >
                        ↑
                      </IconButton>
                    </span>
                  ) : null}
                  {index < elements.length - 1 ? (
                    <span className="flex shrink-0 items-center">
                      <span id={moveDownDescId(index)} className="sr-only">
                        {messages.htmlElementMoveDownDescription(position)}
                      </span>
                      <IconButton
                        label={name}
                        aria-describedby={moveDownDescId(index)}
                        onClick={() =>
                          dispatch({
                            type: "moveHtmlElement",
                            layerId,
                            from: index,
                            to: index + 1,
                          })
                        }
                      >
                        ↓
                      </IconButton>
                    </span>
                  ) : null}
                  <span className="flex shrink-0 items-center">
                    <span id={removeDescId(index)} className="sr-only">
                      {messages.htmlElementRemoveDescription(position)}
                    </span>
                    <IconButton
                      label={name}
                      aria-describedby={removeDescId(index)}
                      onClick={() => dispatch({ type: "removeHtmlElement", layerId, index })}
                    >
                      ×
                    </IconButton>
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-[12px] text-text-muted">{messages.htmlElementsEmpty}</p>
      )}
      {/* The offer rides the group whenever the layer is mounted: an element
          kind is never at a cap, so there is no state this group shadows and no
          kind that would be offered-then-refused (§1.5). */}
      <div
        role="group"
        aria-label={messages.htmlElementAddLabel}
        className="flex flex-wrap items-center gap-2"
      >
        {HTML_ELEMENT_KINDS.map((kind) => (
          <span key={kind} className="flex items-center">
            <span id={addDescId(kind)} className="sr-only">
              {messages.htmlElementAddDescription(messages.htmlElementKindLabel(kind))}
            </span>
            <Button
              variant="secondary"
              size="sm"
              aria-label={kind}
              aria-describedby={addDescId(kind)}
              onClick={() => add(kind)}
            >
              {messages.htmlElementKindLabel(kind)}
            </Button>
          </span>
        ))}
      </div>
      {/* The live weight meter (HL5c, HL-D6), beneath the editor it weighs.
          **HL-D7:** `assembleHtml` ran only to count bytes — this renders the
          numbers and the profile label, never the markup, so what the elements
          say cannot reach the DOM from here. Over budget is a warning, not a
          refusal: the fallback's bytes join the same budget at packaging, so
          this figure is a lower bound and packaging's check enforces it. */}
      {reading ? (
        <div className="space-y-1 pt-2">
          <p className="text-[12px] text-text-muted">
            {messages.htmlWeightMeterText(reading.bytes, reading.maxBytes, reading.profileLabel)}
          </p>
          {reading.overBy > 0 ? (
            <p role="status" className="block text-[11px] text-warning">
              {messages.htmlWeightOverage(reading.overBy)}
            </p>
          ) : null}
          <p className="text-[11px] text-text-muted">{messages.htmlWeightFallbackNote}</p>
        </div>
      ) : null}
    </div>
  );
}
