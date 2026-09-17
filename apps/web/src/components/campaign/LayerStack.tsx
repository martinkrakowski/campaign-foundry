"use client";

import { memo, useId, type Dispatch } from "react";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import { Button, IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { layerKindDisplayName } from "./display-names";
import type { EditorAction } from "./editor-state";
import type { LayerStackLook } from "./layer-stack-props";
import * as messages from "./messages";

export interface LayerStackProps extends LayerStackLook {
  readonly dispatch: Dispatch<EditorAction>;
  /**
   * The picked layer's id, or null (D139). Ephemeral editor state owned by the
   * host — the same bucket as the scrub position (VE-D5) and the tape's beat:
   * never a field of `EditorState`, never in the brief, never in
   * `localStorage`. Persisting it would dirty a loaded brief the moment
   * somebody clicked a row.
   */
  readonly selectedLayerId: string | null;
  readonly onSelectLayer: (id: string) => void;
}

/**
 * The layer stack (CC3), in the creative rail — the campaign's layers as an
 * ordered list, array position is z-order, bottom first (D128), with select,
 * hide, reorder, add and remove offers that ARE the domain's compatibility
 * table.
 *
 * It moved here from `TemplateSection`, whole. The disposition the plan fixed
 * (`2026-09-16_creative-first-chrome.md`, lane CC3) is that the section STOPS
 * rendering the stack and this becomes the only one: the plan's §4.6 is "the
 * layer stack exists exactly once in the tree", and two synchronised copies
 * would be two places for the same offer to drift. The owner's diagram is why
 * it is here rather than in the form — the creative's own controls belong
 * beside the creative, not in a step you have to walk to.
 *
 * Every offer is READ from the derivations through `layerStackProps`, never
 * re-decided: `addableKinds`, `removableLayerIds`, `toggleableLayerIds` and
 * `layerMoveDirections` derive from the same `CREATIVE_TYPE_RULES` the boundary
 * validates against, so this surface cannot offer what Save would refuse (the
 * gating defect DESIGN.md §1.5 names): a kind at its cardinality limit is
 * absent from the offer, never present-and-disabled, a required layer has no
 * remove control, and a layer blocked by bounds or constraints has no move
 * control in that direction. `Video` and `Animated text` are part of every
 * creative of their type and cannot be removed — that rule lives in
 * `removableLayerIds`, and this file holds no copy of it.
 *
 * `memo`, for the reason `PreviewDock` and `TimelineTape` are (CC1/CC2): the
 * rail is a child of the editor's single commit, so without a boundary here
 * every layer row would re-render on every character typed anywhere in the
 * form. The boundary only works because `BriefEditor` hands it a props object
 * memoised on `layerStackKey` and callbacks that are referentially stable — a
 * fresh object allocated per render defeats a `memo`-wrapped child while every
 * fetch-count assertion stays green, which is exactly how #469 regressed.
 *
 * The kit's naming contract (D18, as `PlatformCard` pins it): every control's
 * accessible name is its raw id — the kind id on an add control, the layer id
 * on a select, hide, remove or move control — and the display words live in the
 * description, wired through `aria-describedby` so they never join the name.
 */
export const LayerStack = memo(function LayerStack({
  rows,
  addable,
  requiredNames,
  occlusionNotice,
  dispatch,
  selectedLayerId,
  onSelectLayer,
}: LayerStackProps) {
  // Description ids ride one instance id: the guided walk mounts two live
  // copies of a step's card during a step change, so a static id would be
  // duplicated in the document — the trap the kit's own cards avoid with
  // `useId`. The rail is a sibling of that card (D44) and not subject to it,
  // but the ids are per-instance anyway: nothing about this component may
  // assume it is mounted once per document.
  const uid = useId();
  const addDescId = (kind: LayerKind) => `${uid}-add-${kind}`;
  const moveDownDescId = (layerId: string, index: number) => `${uid}-move-down-${layerId}-${index}`;
  const moveUpDescId = (layerId: string, index: number) => `${uid}-move-up-${layerId}-${index}`;
  const removeDescId = (layerId: string, index: number) => `${uid}-remove-${layerId}-${index}`;
  const selectDescId = (layerId: string, index: number) => `${uid}-select-${layerId}-${index}`;
  const toggleDescId = (layerId: string, index: number) => `${uid}-toggle-${layerId}-${index}`;
  const listLabelId = `${uid}-list-label`;

  return (
    <div
      /* The mount marker the one-stack proof counts (the plan's §4.6). A count
         of rendered rows or visible SVGs cannot answer it: the rail's container
         query hides without unmounting, and happy-dom applies no CSS at all, so
         only a stable marker can tell "exactly one is MOUNTED" from "exactly
         one is VISIBLE". */
      data-testid="layer-stack"
      className="flex shrink-0 flex-col gap-2 border-t border-border pt-3"
    >
      <p id={listLabelId} className="text-[12px] text-text-muted">
        {messages.templateListLabel}
      </p>
      <ol aria-labelledby={listLabelId} className="space-y-2">
        {rows.map((row, index) => {
          const displayName = layerKindDisplayName(row.kind);
          const selected = row.id === selectedLayerId;
          return (
            <li
              key={row.id}
              className={cn(
                "space-y-2 rounded-md border bg-surface-2 px-3 py-2",
                selected ? "border-brand-primary" : "border-border",
              )}
            >
              <span className="flex items-center justify-between gap-3">
                {/* The row's own name IS the select control: a separate "pick
                    this" button beside a name that is not clickable is two
                    affordances for one idea. `aria-pressed` rather than
                    `aria-selected`, exactly as the tape's clips do it — the
                    list is not a `listbox` and inventing one would take over
                    the arrow keys the guided walk uses. */}
                <span id={selectDescId(row.id, index)} className="sr-only">
                  {messages.layerSelectDescription(displayName)}
                </span>
                <button
                  type="button"
                  aria-label={row.id}
                  aria-pressed={selected}
                  aria-describedby={selectDescId(row.id, index)}
                  onClick={() => onSelectLayer(row.id)}
                  className="min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  <span className="block text-[13px] text-text-primary">{displayName}</span>
                  <span className="block font-mono text-[11px] text-text-muted">{row.id}</span>
                </button>
                <span className="flex shrink-0 items-center gap-1">
                  {row.toggleable ? (
                    <span className="flex shrink-0 items-center">
                      <span id={toggleDescId(row.id, index)} className="sr-only">
                        {row.off
                          ? messages.templateEnableDescription(displayName)
                          : messages.templateDisableDescription(displayName)}
                      </span>
                      <IconButton
                        label={row.id}
                        aria-describedby={toggleDescId(row.id, index)}
                        onClick={() =>
                          dispatch({
                            type: "setLayerEnabled",
                            id: row.id,
                            enabled: row.off,
                          })
                        }
                      >
                        {row.off ? "○" : "◉"}
                      </IconButton>
                    </span>
                  ) : null}
                  {row.mayMoveDown ? (
                    <span className="flex shrink-0 items-center">
                      <span id={moveDownDescId(row.id, index)} className="sr-only">
                        {messages.templateMoveDownDescription(displayName)}
                      </span>
                      <IconButton
                        label={row.id}
                        aria-describedby={moveDownDescId(row.id, index)}
                        onClick={() =>
                          dispatch({
                            type: "moveLayer",
                            from: index,
                            to: index - 1,
                          })
                        }
                      >
                        ↓
                      </IconButton>
                    </span>
                  ) : null}
                  {row.mayMoveUp ? (
                    <span className="flex shrink-0 items-center">
                      <span id={moveUpDescId(row.id, index)} className="sr-only">
                        {messages.templateMoveUpDescription(displayName)}
                      </span>
                      <IconButton
                        label={row.id}
                        aria-describedby={moveUpDescId(row.id, index)}
                        onClick={() =>
                          dispatch({
                            type: "moveLayer",
                            from: index,
                            to: index + 1,
                          })
                        }
                      >
                        ↑
                      </IconButton>
                    </span>
                  ) : null}
                  {row.removable ? (
                    <span className="flex shrink-0 items-center">
                      <span id={removeDescId(row.id, index)} className="sr-only">
                        {messages.templateRemoveDescription(displayName)}
                      </span>
                      <IconButton
                        label={row.id}
                        aria-describedby={removeDescId(row.id, index)}
                        onClick={() => dispatch({ type: "removeLayer", id: row.id })}
                      >
                        ×
                      </IconButton>
                    </span>
                  ) : null}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {occlusionNotice !== null ? (
        <p role="status" className="text-[12px] text-text-muted">
          {occlusionNotice}
        </p>
      ) : null}
      {requiredNames.length > 0 ? (
        <p className="text-[12px] text-text-muted">
          {messages.templateRequiredNote([...requiredNames])}
        </p>
      ) : null}
      {/* The offer rides the group whenever the stack is mounted: a kind at its
          limit is absent from the group, and an offered-then-refused control
          would be the defect DESIGN.md §1.5 names. The group renders
          unconditionally because the offer is never empty for a template the
          boundary accepts — every creative type leaves its image or video kind
          unbounded — so there is no state this group shadows, and in
          particular a derivation that answered nothing must never be drawn as
          "no layers can be added". */}
      <div
        role="group"
        aria-label={messages.templateAddLabel}
        className="flex flex-wrap items-center gap-2 pt-1"
      >
        {addable.map((kind) => (
          <span key={kind} className="flex items-center">
            <span id={addDescId(kind)} className="sr-only">
              {messages.templateAddDescription(layerKindDisplayName(kind))}
            </span>
            <Button
              variant="secondary"
              size="sm"
              aria-label={kind}
              aria-describedby={addDescId(kind)}
              onClick={() => dispatch({ type: "addLayer", kind })}
            >
              {layerKindDisplayName(kind)}
            </Button>
          </span>
        ))}
      </div>
    </div>
  );
});
