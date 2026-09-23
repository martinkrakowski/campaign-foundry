import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import { addableKinds, layerMoveDirections, removableLayerIds, toggleableLayerIds } from "./derive";
import { layerKindDisplayName } from "./display-names";
import type { EditorState } from "./editor-state";

/**
 * One row of the stack, with every offer already answered by the domain.
 *
 * The four booleans are not opinions this file holds — they are lookups into
 * `removableLayerIds`, `toggleableLayerIds` and `layerMoveDirections`, which
 * derive from the same `CREATIVE_TYPE_RULES` the boundary validates against
 * (D121/D124). A rail that re-decided any of them would be the second copy of
 * the compatibility table those derivations exist to prevent.
 */
export interface LayerStackRow {
  readonly id: string;
  readonly kind: LayerKind;
  /** Switched off (MP-D3): it keeps its slot and its move controls, it just draws nothing. */
  readonly off: boolean;
  readonly toggleable: boolean;
  readonly removable: boolean;
  readonly mayMoveUp: boolean;
  readonly mayMoveDown: boolean;
}

/**
 * Everything the layer stack draws, derived from the draft — the layer half of
 * what `previewDockProps` is for the preview (D45): the one place that answers
 * how the rail is fed, in product code, so no test fixture is the only
 * definition of it.
 *
 * `rows` carries the array in template order, bottom first (D128) — array
 * position IS z-order, so the view walks the list it is handed and never sorts.
 */
export interface LayerStackLook {
  readonly rows: readonly LayerStackRow[];
  /** What may still be added (D124). Never empty for a template the boundary accepts. */
  readonly addable: readonly LayerKind[];
  /** The kinds no row offers to remove, as display names — the "why" sentence's subject. */
  readonly requiredNames: readonly string[];
  /** The reducer's advisory about an order that mutes the headline (D135/D136). */
  readonly occlusionNotice: string | null;
}

export function layerStackProps(state: EditorState): LayerStackLook {
  // Every offer, consumed — never reimplemented (D124).
  const removable = removableLayerIds(state);
  const toggleable = toggleableLayerIds(state);
  const rows = state.template.layers.map((layer, index) => {
    const directions = layerMoveDirections(state, index);
    return {
      id: layer.id,
      kind: layer.kind,
      off: layer.enabled === false,
      toggleable: toggleable.includes(layer.id),
      removable: removable.includes(layer.id),
      mayMoveUp: directions.includes("up"),
      mayMoveDown: directions.includes("down"),
    };
  });
  return {
    rows,
    addable: addableKinds(state),
    // The required kinds, as display names: a layer with no remove control is one
    // the boundary would refuse to strip — every template the editor can hold
    // carries each required kind exactly once (a second presence would be
    // removable, per `removableLayerIds` itself).
    requiredNames: [
      ...new Set(rows.filter((row) => !row.removable).map((row) => layerKindDisplayName(row.kind))),
    ],
    occlusionNotice: state.occlusionNotice,
  };
}

/**
 * `BriefEditor`'s memo key for the stack — the layer-side twin of
 * `previewRailKey` (CC1/CC2), and needed for exactly the same reason: the rail
 * is a child of the editor's single commit, so a keystroke in a field the stack
 * does not draw must hand the `memo`-wrapped `LayerStack` the identical props
 * object and let it bail out of the re-render. `previewRailKey` cannot serve
 * here — it is a fingerprint of the previewed LOOK and carries no layer at all,
 * so switching a layer off would not move it.
 *
 * The key is a fingerprint of everything `layerStackProps` reads, and only
 * that: the creative type (the compatibility table's other input), each layer's
 * id, kind and enabled flag in array order (position is z-order, D128 — so the
 * ORDER being part of the string is the point, not an accident of `map`), and
 * the occlusion advisory. `layerMoveDirections`, `removableLayerIds`,
 * `toggleableLayerIds` and `addableKinds` read nothing else (`derive.ts`), so
 * two states with the same key cannot differ in anything the stack shows.
 *
 * A layer's `props` are deliberately absent: the stack draws none of them, so
 * props changes cannot affect anything the stack shows.
 */
export function layerStackKey(state: EditorState): string {
  return JSON.stringify([
    state.template.creativeType,
    state.template.layers.map((layer) => [layer.id, layer.kind, layer.enabled !== false]),
    state.occlusionNotice,
  ]);
}
