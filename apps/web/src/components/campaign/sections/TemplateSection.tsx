"use client";

import { useId } from "react";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import { Button, IconButton } from "@/components/ui";
import {
  addableKinds,
  canMoveLayer,
  htmlWeightReading,
  removableLayerIds,
  toggleableLayerIds,
} from "@/components/campaign/derive";
import { layerKindDisplayName } from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";
import { HtmlElementsEditor } from "./HtmlElementsEditor";
import { SectionShell, type SectionProps } from "./IdentitySection";

/**
 * The Template step (L5, L8 — D124, D128): the campaign's layers as an ordered list —
 * array position is z-order, bottom first (D128) — with add, remove and move offers
 * that ARE the domain's compatibility table. `addableKinds`, `removableLayerIds`,
 * and `canMoveLayer` are derived from the same `CREATIVE_TYPE_RULES` the
 * boundary validates against, so this section cannot offer what Save would
 * refuse (the gating defect DESIGN.md §1.5 names): a kind at its cardinality
 * limit is absent from the offer, never present-and-disabled, a required
 * layer has no remove control, and a layer blocked by bounds or constraints has
 * no move control in that direction.
 *
 * Reordering (L8, D128): each layer offers controls to move it within the list
 * (up toward top, down toward bottom) when the move is legal. New layers carry no
 * props — per-layer prop editing is out of scope — so an add dispatches the kind
 * alone, and the id is the reducer's derivation.
 *
 * Switching a layer off (L9, D129): each layer that may be switched carries a
 * toggle, derived by `toggleableLayerIds` from the same table — the last enabled
 * instance of a required kind has NO control, never a disabled one (§1.5), and a
 * disabled layer keeps its slot and its move controls: it still governs order, it
 * simply draws nothing (MP-D3).
 *
 * The kit's naming contract (D18, as `PlatformCard` pins it): every control's
 * accessible name is its raw id — the kind id on an add control, the layer id
 * on a remove or move control — and the display words live in the description, wired
 * through `aria-describedby` so they never join the name.
 */
export function TemplateSection({ state, dispatch }: SectionProps) {
  // Description ids ride one instance id: the guided walk mounts two live
  // copies during a step change, so a static id would be duplicated in the
  // document — the trap the kit's own cards avoid with `useId`.
  const uid = useId();
  const addDescId = (kind: LayerKind) => `${uid}-add-${kind}`;
  const moveDownDescId = (layerId: string, index: number) =>
    `${uid}-move-down-${layerId}-${index}`;
  const moveUpDescId = (layerId: string, index: number) =>
    `${uid}-move-up-${layerId}-${index}`;
  const removeDescId = (layerId: string, index: number) =>
    `${uid}-remove-${layerId}-${index}`;
  const toggleDescId = (layerId: string, index: number) =>
    `${uid}-toggle-${layerId}-${index}`;
  const listLabelId = `${uid}-list-label`;

  // Both offers, consumed — never reimplemented (D124).
  const addable = addableKinds(state);
  const removable = removableLayerIds(state);
  const toggleable = toggleableLayerIds(state);
  // The live weight reading (HL5c, HL-D6), computed once for the section: it
  // weighs the whole draft's html markup against the tightest selected html
  // placement, so every html layer's editor shows the same figure. Undefined
  // when no html placement is selected — then no meter renders at all.
  const reading = htmlWeightReading(state);
  // The required kinds, as display names: a layer with no remove control is
  // one the boundary would refuse to strip — every template the editor can
  // hold carries each required kind exactly once (a second presence would be
  // removable, per `removableLayerIds` itself).
  const requiredNames = [
    ...new Set(
      state.template.layers
        .filter((layer) => !removable.includes(layer.id))
        .map((layer) => layerKindDisplayName(layer.kind)),
    ),
  ];

  return (
    <SectionShell id="template" title="Template">
      <p id={listLabelId} className="text-[12px] text-text-muted">
        {messages.templateListLabel}
      </p>
      <ol aria-labelledby={listLabelId} className="space-y-2">
        {state.template.layers.map((layer, index) => {
          const layerRemovable = removable.includes(layer.id);
          const layerOff = layer.enabled === false;
          const layerToggleable = toggleable.includes(layer.id);
          const mayMoveDown = canMoveLayer(state, index, "down");
          const mayMoveUp = canMoveLayer(state, index, "up");
          return (
            <li
              key={layer.id}
              className="space-y-2 rounded-md border border-border bg-surface-2 px-3 py-2"
            >
              <span className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-[13px] text-text-primary">
                    {layerKindDisplayName(layer.kind)}
                  </span>
                  <span className="block font-mono text-[11px] text-text-muted">
                    {layer.id}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                {layerToggleable ? (
                  <span className="flex shrink-0 items-center">
                    <span
                      id={toggleDescId(layer.id, index)}
                      className="sr-only"
                    >
                      {layerOff
                        ? messages.templateEnableDescription(
                            layerKindDisplayName(layer.kind),
                          )
                        : messages.templateDisableDescription(
                            layerKindDisplayName(layer.kind),
                          )}
                    </span>
                    <IconButton
                      label={layer.id}
                      aria-describedby={toggleDescId(layer.id, index)}
                      onClick={() =>
                        dispatch({
                          type: "setLayerEnabled",
                          id: layer.id,
                          enabled: layerOff,
                        })
                      }
                    >
                      {layerOff ? "○" : "◉"}
                    </IconButton>
                  </span>
                ) : null}
                {mayMoveDown ? (
                  <span className="flex shrink-0 items-center">
                    <span
                      id={moveDownDescId(layer.id, index)}
                      className="sr-only"
                    >
                      {messages.templateMoveDownDescription(
                        layerKindDisplayName(layer.kind),
                      )}
                    </span>
                    <IconButton
                      label={layer.id}
                      aria-describedby={moveDownDescId(layer.id, index)}
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
                {mayMoveUp ? (
                  <span className="flex shrink-0 items-center">
                    <span
                      id={moveUpDescId(layer.id, index)}
                      className="sr-only"
                    >
                      {messages.templateMoveUpDescription(
                        layerKindDisplayName(layer.kind),
                      )}
                    </span>
                    <IconButton
                      label={layer.id}
                      aria-describedby={moveUpDescId(layer.id, index)}
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
                {layerRemovable ? (
                  <span className="flex shrink-0 items-center">
                    <span
                      id={removeDescId(layer.id, index)}
                      className="sr-only"
                    >
                      {messages.templateRemoveDescription(
                        layerKindDisplayName(layer.kind),
                      )}
                    </span>
                    <IconButton
                      label={layer.id}
                      aria-describedby={removeDescId(layer.id, index)}
                      onClick={() =>
                        dispatch({ type: "removeLayer", id: layer.id })
                      }
                    >
                      ×
                    </IconButton>
                  </span>
                ) : null}
                </span>
              </span>
              {/* The html layer's own vocabulary (HL5a, HL-D1): elements are
                  not layers, so this rides beneath the one layer that carries
                  them rather than in a section of its own. */}
              {layer.kind === "html" ? (
                <HtmlElementsEditor
                  layerId={layer.id}
                  elements={layer.elements ?? []}
                  dispatch={dispatch}
                  reading={reading}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {state.occlusionNotice ? (
        <p role="status" className="text-[12px] text-text-muted">
          {state.occlusionNotice}
        </p>
      ) : null}
      {requiredNames.length > 0 ? (
        <p className="text-[12px] text-text-muted">
          {messages.templateRequiredNote(requiredNames)}
        </p>
      ) : null}
      {/* The offer rides the group whenever the section is mounted: a kind at
          its limit is absent from the group, and an offered-then-refused
          control would be the defect DESIGN.md §1.5 names. The group renders
          unconditionally because the offer is never empty for a template the
          boundary accepts — every creative type leaves its image or video kind
          unbounded — so there is no state this group shadows. */}
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
    </SectionShell>
  );
}
