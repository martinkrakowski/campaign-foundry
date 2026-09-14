"use client";

import { useId, type Dispatch } from "react";
import { Button, IconButton, Input } from "@/components/ui";
import type {
  EditorAction,
  Frame,
  HtmlElement,
  HtmlElementKind,
} from "@/components/campaign/editor-state";
import {
  ANCHOR_OPTIONS,
  HTML_ELEMENT_KINDS,
} from "@/components/campaign/editor-state";
import { anchorDisplayName } from "@/components/campaign/display-names";
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
const FRAME_NUMBER_FIELDS = ["x", "y", "w", "h"] as const;

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

export function HtmlElementsEditor({
  layerId,
  elements,
  dispatch,
}: {
  layerId: string;
  elements: readonly HtmlElement[];
  dispatch: Dispatch<EditorAction>;
}) {
  // Description ids ride one instance id: the guided walk mounts two live
  // copies of the section during a step change, so a static id would be
  // duplicated in the document — the trap the kit's own cards avoid.
  const uid = useId();
  const addDescId = (kind: HtmlElementKind) => `${uid}-add-${kind}`;
  const moveUpDescId = (index: number) => `${uid}-up-${index}`;
  const moveDownDescId = (index: number) => `${uid}-down-${index}`;
  const removeDescId = (index: number) => `${uid}-remove-${index}`;

  const add = (kind: HtmlElementKind) =>
    dispatch({ type: "addHtmlElement", layerId, kind });

  return (
    <div className="space-y-2 pt-2">
      {elements.length > 0 ? (
        <ol
          aria-label={messages.htmlElementsLabel}
          className="space-y-2"
        >
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
                      value={element.text ?? ""}
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
                    <Field
                      key={field}
                      label={messages.htmlElementFrameLabel(position, field)}
                    >
                      <Input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        value={String(element.frame[field])}
                        onChange={(e) =>
                          dispatch({
                            type: "setHtmlElementFrame",
                            layerId,
                            index,
                            patch: framePatch(field, Number(e.target.value)),
                          })
                        }
                      />
                    </Field>
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
                      onClick={() =>
                        dispatch({ type: "removeHtmlElement", layerId, index })
                      }
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
              {messages.htmlElementAddDescription(
                messages.htmlElementKindLabel(kind),
              )}
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
    </div>
  );
}
