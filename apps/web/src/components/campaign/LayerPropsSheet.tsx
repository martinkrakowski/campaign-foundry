"use client";

import { useEffect, useId, useState, type Dispatch, type ReactNode } from "react";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
// The domain's own list of kinds that may carry tracks (K1), so this sheet
// offers the section exactly where `layerTracksProblem` would accept one.
import { TRACKABLE_LAYER_KINDS } from "@campaignfoundry/CampaignOrchestration/tracks";
import { Button, DialogHead, Input } from "@/components/ui";
import { htmlWeightReading } from "@/components/campaign/derive";
import { HtmlElementsEditor } from "@/components/campaign/sections/HtmlElementsEditor";
import {
  ANCHOR_OPTIONS,
  anchorAxisActive,
  type EditorAction,
  type EditorState,
  type LayerPropsPatch,
} from "@/components/campaign/editor-state";
import { anchorDisplayName } from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";
import { TrackForm, type TrackPlayhead } from "@/components/campaign/TrackForm";
import type { PresetCell } from "@/components/campaign/preset-tracks";

/**
 * CC4 — the layer sheet: a **non-modal** panel that edits the layer CC3's
 * selection already names (`pickedLayerId`, read here, never a second
 * selection concept), live geometry props and the `html` layer's element
 * editor.
 *
 * **Never `aria-modal`.** `editor-history.ts`'s `useHistoryKeys` switches
 * `⌘Z` off while `[aria-modal="true"]` is anywhere in the document — that is
 * the ONLY signal it reads, not `role="dialog"` — so this panel carries the
 * role for assistive tech and nothing that would silence undo. There is
 * deliberately no focus trap either (`useDialogFocusTrap`, `DialogShell`,
 * `DrawerShell` are the modal shells `dialog-shell.tsx` documents as modal by
 * design; this is a new, smaller container, not a fourth caller of that
 * trap): Tab must keep reaching the rail beside it, and Escape is the only
 * way this panel closes itself.
 *
 * **Mount site.** This component renders nothing of its own chrome around the
 * editor — its caller (`BriefEditor`) mounts it as a sibling of the step
 * card, never inside it, for the reason `HeadlinePoolDrawer` and the Asset
 * Bin drawer are hoisted the same way: the step card is a transformed
 * element, which makes it the containing block for any `fixed` descendant, so
 * a sheet mounted inside it could never cover the viewport.
 */

/** One numeric geometry field this sheet can show (D134's table). */
type NumericField = "solidHeight" | "fadeHeight" | "width" | "margin" | "typeFloor";

const NUMERIC_FIELD_LABEL: Record<NumericField, string> = {
  solidHeight: messages.layerPropSolidHeightLabel,
  fadeHeight: messages.layerPropFadeHeightLabel,
  width: messages.layerPropWidthLabel,
  margin: messages.layerPropMarginLabel,
  typeFloor: messages.layerPropTypeFloorLabel,
};

/**
 * Which numeric fields a kind's `props` carries — `brief-template.ts`'s
 * `LAYER_PROPS` table, read through the controls it authorises rather than
 * restated as a second copy of the vocabulary. A kind absent here offers none
 * (`shade`, `video`, `html`, `fill` carry no props at all).
 */
const KIND_NUMERIC_FIELDS: Partial<Record<LayerKind, readonly NumericField[]>> = {
  accent: ["solidHeight", "fadeHeight"],
  logo: ["width", "margin"],
  "static-text": ["typeFloor"],
  "animated-text": ["typeFloor"],
};

/** The value an absent override already reads as — `CREATIVE_GEOMETRY`'s own fractions. */
const NUMERIC_FIELD_DEFAULT: Record<NumericField, number> = {
  solidHeight: CREATIVE_GEOMETRY.accentSolidHeightFraction,
  fadeHeight: CREATIVE_GEOMETRY.accentFadeHeightFraction,
  width: CREATIVE_GEOMETRY.logoWidthFraction,
  margin: CREATIVE_GEOMETRY.logoMarginFraction,
  typeFloor: CREATIVE_GEOMETRY.headlineTypeFloorFraction,
};

/**
 * A field's label and its control, associated by `htmlFor`/`id` rather than
 * by wrapping — a Reset control rides beside several of these controls, and
 * a `<button>` nested inside a `<label>` for another element is the kind of
 * structure that reads fine visually and behaves oddly for assistive tech.
 */
function SheetField({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1 text-[12px]">
      <label htmlFor={id} className="block font-medium text-text-primary">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

/**
 * One geometry field's number input — `HtmlElementsEditor.tsx`'s
 * `FrameNumberInput` shape, reused rather than re-invented: the box keeps its
 * own draft string while it is being typed into and hands a number to the
 * reducer only once the draft parses to a finite one, so a half-typed `0.`
 * survives its own re-render instead of losing the point. Every commit here
 * is one keystroke's worth — `setLayerProps`'s own coalesce key (the
 * `setHtmlElementFrame` rule) is what keeps a run of them to one undo entry.
 */
function GeometryNumberField({
  field,
  value,
  onCommit,
  onClear,
}: {
  field: NumericField;
  value: number | undefined;
  onCommit: (value: number) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const label = NUMERIC_FIELD_LABEL[field];
  const shown = value ?? NUMERIC_FIELD_DEFAULT[field];
  return (
    <SheetField label={label}>
      {(id) => (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={draft ?? String(shown)}
            onChange={(e) => {
              const raw = e.target.value;
              setDraft(raw);
              // Empty, and half-typed to something that is no number yet:
              // states of the box, not numbers — nothing is committed.
              if (raw.trim() === "") return;
              const parsed = Number(raw);
              if (!Number.isFinite(parsed)) return;
              onCommit(parsed);
            }}
            onBlur={() => setDraft(null)}
          />
          {value !== undefined ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={messages.layerPropResetLabel(label)}
              onClick={onClear}
            >
              Reset
            </Button>
          ) : null}
        </div>
      )}
    </SheetField>
  );
}

/**
 * The text layers' anchor override — the same "brief default" empty-option
 * idiom `HtmlElementsEditor`'s `StyleSelect` uses: the empty value clears the
 * key rather than writing it, so the reducer never sees a stringly-typed
 * sentinel for "no override".
 */
function AnchorField({
  value,
  onCommit,
  onClear,
}: {
  value: string | undefined;
  onCommit: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <SheetField label={messages.layerPropAnchorLabel}>
      {(id) => (
        <select
          id={id}
          value={value ?? ""}
          onChange={(e) => {
            if (e.target.value === "") onClear();
            else onCommit(e.target.value);
          }}
          className="w-full rounded border border-border-control bg-surface px-3 py-2 text-sm text-text-emphasis"
        >
          <option value="">{messages.layerPropDefault}</option>
          {ANCHOR_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {anchorDisplayName(option)}
            </option>
          ))}
        </select>
      )}
    </SheetField>
  );
}

/**
 * `image`'s alt override (X2). Three states, not two: absent (no key at
 * all), the empty string (declared decorative), and text — so clearing the
 * box types an empty string (a real, intentional value) while the Reset
 * control is the only way back to "no key", the same distinction
 * `setHtmlElementStyle`'s "brief default" face draws for a select.
 */
function AltField({
  value,
  onCommit,
  onClear,
}: {
  value: string | undefined;
  onCommit: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <SheetField label={messages.layerPropAltLabel}>
      {(id) => (
        <div className="flex items-center gap-2">
          <Input id={id} value={value ?? ""} onChange={(e) => onCommit(e.target.value)} />
          {value !== undefined ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={messages.layerPropResetLabel(messages.layerPropAltLabel)}
              onClick={onClear}
            >
              Reset
            </Button>
          ) : null}
        </div>
      )}
    </SheetField>
  );
}

export function LayerPropsSheet({
  state,
  dispatch,
  layerId,
  playhead,
  preset,
  onClose,
}: {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  /** CC3's own selection (`pickedLayerId`), read — never a second one. */
  layerId: string | null;
  /**
   * TS2's committed second, for the tracks form's pose mapping (§4.4 rule 3).
   * `null` where the editor has no timeline to read — the form then starts a
   * stop at 0 rather than inventing a position.
   */
  playhead: TrackPlayhead | null;
  /**
   * The previewed cell, for TL7 preset group. `null` when the rail composes
   * no motion - there is then no expansion to show rather than an empty one.
   */
  preset: PresetCell | null;
  onClose: () => void;
}) {
  const layer =
    layerId === null
      ? undefined
      : state.template.layers.find((candidate) => candidate.id === layerId);

  /**
   * Escape dismisses — nothing to roll back, so there is nothing to ask about.
   * Scoped to the document rather than this panel's own subtree because there
   * is no focus trap pulling focus inside it: a click on the rail while the
   * sheet is open must not leave Escape unable to find it. Guarded by the
   * same `[aria-modal="true"]` signal `useHistoryKeys` reads, so a
   * `ConfirmDialog` stacked over this sheet keeps the keystroke — one overlay
   * answers an Escape at a time, never two.
   */
  useEffect(() => {
    if (layer === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      if (document.querySelector('[aria-modal="true"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [layer, onClose]);

  if (layer === undefined) return null;

  // Loosely typed at this call boundary, the way every other reducer dispatch
  // in this file is (`framePatch`, `stylePatch`): the real contract is
  // `layerPropsProblem`, enforced inside the reducer, so a wrong field name or
  // an out-of-vocabulary value refuses the dispatch there rather than here.
  const setProp = (patch: Record<string, unknown>) =>
    dispatch({ type: "setLayerProps", layerId: layer.id, patch: patch as LayerPropsPatch });

  const props = layer.props as unknown as Record<string, unknown> | undefined;
  const numericFields = KIND_NUMERIC_FIELDS[layer.kind] ?? [];
  // SE2's own rule (`studio-editor.md` §3): the anchor control is absent
  // while the variation axis is live — the two can never both decide the
  // same placement, and `validate.ts` already refuses the conflict, so this
  // sheet never offers a control that would create one.
  const showAnchor =
    (layer.kind === "static-text" || layer.kind === "animated-text") && !anchorAxisActive(state);
  /**
   * K5's two gates, and no third one.
   *
   * `TRACKABLE_LAYER_KINDS` is the domain's own list, imported rather than
   * restated, so this section is offered exactly where `layerTracksProblem`
   * would accept a tracks block.
   *
   * The enabled check is DoD 6, and it is an EDITOR rule only: the domain
   * accepts tracks on a disabled layer and K-D4 resolves them to nothing, so
   * the controls go away without the editor claiming a refusal the boundary
   * does not make.
   *
   * There is deliberately no third gate on motion. A still resolves tracks the
   * same way, the domain accepts them either way, and withholding the section
   * on a still would be exactly the invented refusal DoD 6 warns against.
   */
  const showTracks = TRACKABLE_LAYER_KINDS.includes(layer.kind) && layer.enabled !== false;
  const hasControls =
    numericFields.length > 0 ||
    showAnchor ||
    showTracks ||
    layer.kind === "image" ||
    layer.kind === "html";

  return (
    <div
      role="dialog"
      aria-label={messages.layerSheetTitle(layer.id)}
      data-testid="layer-props-sheet"
      className="fixed bottom-4 right-4 z-40 flex max-h-[70vh] w-96 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
    >
      <DialogHead
        headingLevel={3}
        title={messages.layerSheetTitle(layer.id)}
        onClose={onClose}
        closeText="Close"
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {hasControls ? null : (
          <p className="text-[12px] text-text-muted">{messages.layerPropsNone}</p>
        )}
        {numericFields.map((field) => (
          <GeometryNumberField
            key={field}
            field={field}
            value={props?.[field] as number | undefined}
            onCommit={(value) => setProp({ [field]: value })}
            onClear={() => setProp({ [field]: undefined })}
          />
        ))}
        {showAnchor ? (
          <AnchorField
            value={props?.anchor as string | undefined}
            onCommit={(value) => setProp({ anchor: value })}
            onClear={() => setProp({ anchor: undefined })}
          />
        ) : null}
        {layer.kind === "image" ? (
          <AltField
            value={props?.alt as string | undefined}
            onCommit={(value) => setProp({ alt: value })}
            onClear={() => setProp({ alt: undefined })}
          />
        ) : null}
        {showTracks ? (
          <TrackForm layer={layer} dispatch={dispatch} playhead={playhead} preset={preset} />
        ) : null}
        {layer.kind === "html" ? (
          <HtmlElementsEditor
            layerId={layer.id}
            elements={layer.elements ?? []}
            dispatch={dispatch}
            reading={htmlWeightReading(state)}
          />
        ) : null}
      </div>
    </div>
  );
}
