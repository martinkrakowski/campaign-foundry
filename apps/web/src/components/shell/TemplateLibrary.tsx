"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Button,
  DialogBody,
  DialogFoot,
  DialogHead,
  DialogShell,
  Input,
  MiniChip,
} from "@/components/ui";
import type {
  CreativeTemplate,
  CreativeTemplateLayer,
} from "@campaignfoundry/CampaignOrchestration";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { CREATIVE_TYPES } from "@campaignfoundry/CampaignOrchestration/creative-types";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import { latestPerId, listTemplates, pinnableTemplate, versionsOf } from "@/lib/templates-api";
import { listBriefs, type BriefEntry } from "@/lib/briefs-api";
import { fetchPreviewFrame } from "@/lib/preview-frame";
import { useCreateCampaign } from "@/lib/create-campaign-context";
import { useRun } from "@/lib/run-context";
import {
  creativeTypeDisplayName,
  layerKindDisplayName,
  ratioDisplayName,
  unitDisplayName,
} from "@/components/campaign/display-names";

/**
 * One layer kind's band in the miniature. A Record over the whole vocabulary,
 * not a lookup with a fallback: a new `LayerKind` is then a compile error here
 * instead of a silently unpainted band, and there is no default branch that no
 * state can reach. Same idiom as `TOP_EDGE` in `creative-glyph.tsx`.
 */
const KIND_FILL: Record<LayerKind, string> = {
  image: "fill-text-muted",
  fill: "fill-surface-2",
  "static-text": "fill-text-primary",
  "animated-text": "fill-text-primary",
  video: "fill-text-muted",
  logo: "fill-brand-primary",
  accent: "fill-brand-primary",
  shade: "fill-scrim",
};

const THUMB_BOX = 48;

/**
 * T-D1(c) — the grid's thumbnail, **drawn from `layers`** and never fetched.
 *
 * A stored image would need a `thumbnail` field D123 names and
 * `CreativeTemplate` does not carry, and a compositor render would put a
 * `/preview-frame` call behind every card in the grid — fifty of them on open,
 * which is the exact cost T-D4 forbids for one. The create dialog's
 * `TypePreview` already proves structure alone reads: this stacks one band per
 * layer, bottom-first, because array position IS z-order (D128), so the
 * picture cannot disagree with the record it previews.
 *
 * `CreativeGlyph` is deliberately not reused: it paints `PREVIEW_LAYER_ORDER`
 * — the compositor's resolved order, not a record's own list — and carries a
 * byte-identity golden that a `layers` parameter would break.
 */
function TemplateThumb({ layers }: { layers: readonly CreativeTemplateLayer[] }): ReactNode {
  const band = THUMB_BOX / layers.length;
  return (
    <svg
      width={THUMB_BOX}
      height={THUMB_BOX}
      viewBox={`0 0 ${THUMB_BOX} ${THUMB_BOX}`}
      aria-hidden="true"
      focusable="false"
      className="shrink-0 rounded border border-border"
      data-testid="template-thumb"
    >
      {layers.map((layer, index) => (
        <rect
          key={layer.id}
          x="0"
          // Bottom-first: index 0 is the bottom layer (D128), so it paints the
          // bottom band. Reversing this would draw every template upside down.
          y={THUMB_BOX - (index + 1) * band}
          width={THUMB_BOX}
          height={band}
          className={KIND_FILL[layer.kind]}
        />
      ))}
    </svg>
  );
}

/**
 * The sorts the listing offers.
 *
 * T-D3 recommends "sorts by name and unit". **Unit is not a sort**, and the
 * reason is in the vocabulary rather than in this component: `ADVERTISING_UNITS`
 * has exactly one member (`"standard-web"`, and `advertising-units.ts` states
 * that one member is correct today), and `asCreativeTemplate` refuses any value
 * outside it — so every record the library can serve carries the same unit, and
 * a unit sort is a control that cannot reorder anything. It would also make the
 * plan's own DoD unsatisfiable: *"sort changes order … asserted on rendered
 * order, not on internal state"* has nothing to assert. Version takes its
 * place: it is a field a record does carry at differing values, and "newest
 * first" is the question an operator browsing a versioned library actually
 * asks. The unit still shows on every card.
 */
type SortKey = "name" | "version";

/**
 * The cell the detail view's render asks for: one representative look, stated
 * on screen beside the frame. The template decides the layers; the cell decides
 * the canvas and the treatment, and a library record answers neither — so
 * rather than invent per-template values, one fixed look is requested and
 * labelled as one. `1:1` because every social platform accepts it.
 */
const PREVIEW_CANVAS = { ratio: "1:1" } as const;
const PREVIEW_LAYOUT = "headline-top";
const PREVIEW_TONE = "bold";

/**
 * The creative template library (TM1–TM4, D123, plan §3).
 *
 * **One `DialogShell`, two views, no nesting.** Every shell sets
 * `aria-modal="true"` and traps focus, and `BriefPicker` already records that
 * two at one layer stack two scrims and two Escape handlers (F22) — so the
 * detail view is a swap of this shell's body, never a second shell. `Escape`
 * closes the whole modal from either view; **Back** returns to the listing and
 * restores the search term, the scroll offset and the focus.
 *
 * **Nothing here renders a creative on open** (T-D4). "The final creative as
 * generated" is a `/preview-frame` composite, the same path the rail uses, and
 * browsing is a casual gesture — an automatic fetch would spend the owner's
 * GenAI credits for a look nobody asked to see. The only call this component
 * ever makes to that route is inside the *Render preview* handler.
 */
export function TemplateLibrary() {
  const { templateLibraryOpen, closeTemplateLibrary } = useCreateCampaign();
  const { brief, setBrief } = useRun();
  const [entries, setEntries] = useState<CreativeTemplate[] | null>(null);
  const [error, setError] = useState(false);
  /**
   * T-D5's provenance source. `null` means *not known* — the brief listing
   * failed — which the detail view says out loud; an empty array means nothing
   * has pinned this record, which it says differently. Collapsing the two would
   * be the same defect as collapsing a 500 into "no templates yet".
   */
  const [briefs, setBriefs] = useState<BriefEntry[] | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const [detail, setDetail] = useState<{ id: string; version: number } | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);

  /**
   * Back's three restorations. Refs, not state: none of them is read during a
   * render — each is *spent* by the ref callback of the node that can act on it,
   * on the commit that remounts the listing, so holding them in state would
   * schedule a second render for a value nothing displays.
   */
  const listScrollTop = useRef(0);
  const pendingScrollTop = useRef<number | null>(null);
  const pendingFocusId = useRef<string | null>(null);
  /**
   * The view swap's other half. A card press unmounts the node that had focus,
   * which leaves `document.activeElement` on `document.body` — and
   * `dialogHoldsFocus` then answers false for this shell, so `Escape` would be
   * ignored until the user tabbed back in. The swap therefore hands focus to
   * the detail view's own Back control, exactly as Back hands it to the card.
   */
  const pendingFocusBack = useRef(false);
  /**
   * The in-flight composite's controller (review on #478, found by both
   * reviewers). It has to be HELD: `new AbortController().signal` passed inline
   * drops the controller on the same line, so nothing can ever abort the
   * request — and the damage is not only a dangling fetch. Switch version while
   * a render is in flight and the older response can resolve *second*, painting
   * a frame for the record you are no longer looking at; close the modal
   * mid-flight and the settle sets state after unmount.
   *
   * The ref is also the identity test: a settled request whose controller is no
   * longer the current one has been superseded and must not paint. Aborting
   * alone would not be enough — a mock (or a server that already sent) still
   * resolves — so ordering is decided by identity, not by the abort.
   */
  const renderAbort = useRef<AbortController | null>(null);

  // (Re)load the library each time the modal opens, and parse defensively: an
  // API failure must surface as an error state, never as a misleading empty
  // library — the route refuses that conflation on its side of the wire
  // (`templates.get.ts`'s doc comment) and the client refuses it on this one.
  useEffect(() => {
    if (!templateLibraryOpen) return;
    let active = true;
    setEntries(null);
    setError(false);
    setBriefs(null);
    setSearch("");
    setDetail(null);
    setFrame(null);
    setRendering(false);
    setRenderFailed(false);
    (async () => {
      try {
        const templates = await listTemplates();
        /* istanbul ignore next -- `active` is the unmount-race guard; false only if the modal closes mid-fetch */
        if (active) setEntries(templates);
      } catch {
        /* istanbul ignore next -- same unmount-race guard on the error path */
        if (active) setError(true);
      }
    })();
    // Provenance (T-D5) rides the same open. It is a brief-store read, not a
    // composite: no GenAI credit is spent, which is why it may happen without
    // being asked for where the render may not.
    (async () => {
      try {
        const listed = await listBriefs();
        /* istanbul ignore next -- unmount-race guard */
        if (active) setBriefs(listed);
      } catch {
        /* provenance stays unknown; the detail view says so rather than claiming none */
      }
    })();
    return () => {
      active = false;
      // A close (or an unmount) while a composite is in flight: abort it, and
      // drop the controller so its settle cannot set state on a gone component.
      renderAbort.current?.abort();
      renderAbort.current = null;
    };
  }, [templateLibraryOpen]);

  // T-D2 — one card per id, at its highest version. `listTemplates` answers one
  // record per version, so the raw list shows a three-revision template three
  // times (T3).
  const collapsed = entries === null ? [] : latestPerId(entries);
  const needle = search.trim().toLowerCase();
  const matching = collapsed
    .filter((template) => template.name.toLowerCase().includes(needle))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.version - a.version));

  const shown =
    detail === null || entries === null
      ? undefined
      : entries.find(
          (template) => template.id === detail.id && template.version === detail.version,
        );

  const openDetail = (template: CreativeTemplate) => {
    // A composite still in flight belongs to the record being left — the
    // version chips switch through here too. Abort it and drop the controller,
    // so a late settle neither paints a stale frame nor leaves the button
    // spinning for a request nobody is waiting on.
    renderAbort.current?.abort();
    renderAbort.current = null;
    setFrame(null);
    setRendering(false);
    setRenderFailed(false);
    pendingFocusBack.current = true;
    setDetail({ id: template.id, version: template.version });
  };

  /**
   * Back is a view swap, not a dismissal (plan §3): the search term survives
   * because it was never reset, and the scroll offset and the focus are handed
   * to the listing's own nodes to restore on the commit that remounts them.
   */
  const back = () => {
    /* istanbul ignore next -- Back only renders inside the detail view */
    if (detail === null) return;
    pendingScrollTop.current = listScrollTop.current;
    pendingFocusId.current = detail.id;
    setDetail(null);
  };

  const pinnable = shown === undefined ? null : pinnableTemplate(shown);
  const product = brief.products[0];

  /**
   * T-D4 — the only `/preview-frame` call this component makes, and it is
   * inside a click handler. The brief sent is the **open campaign's**, with its
   * template swapped for the record on screen: that is "the creative as
   * generated" for a real brief, where a brief invented for a library record
   * would be a fabrication D26 forbids. A template is ownerless and cannot
   * supply one.
   */
  const renderPreview = () => {
    /* istanbul ignore next -- unreachable: the verb is `disabled` unless both are present, and a disabled button dispatches no click. Disabled and not absent is deliberate here: a campaign without a product is a precondition the operator CAN fix, which DESIGN.md §5 answers with a disabled control and the reason beside it. */
    if (pinnable === null || product === undefined) return;
    // Supersede any earlier request before issuing this one: a second press
    // must not leave two composites racing to paint the same box.
    renderAbort.current?.abort();
    const controller = new AbortController();
    renderAbort.current = controller;
    setRendering(true);
    setRenderFailed(false);
    setFrame(null);
    fetchPreviewFrame(
      { ...brief, template: pinnable },
      {
        productId: product.id,
        canvas: PREVIEW_CANVAS,
        layout: PREVIEW_LAYOUT,
        tone: PREVIEW_TONE,
      },
      controller.signal,
    )
      .then((next) => {
        // Identity, not arrival order: this settle paints only if it is still
        // the request the component is waiting for.
        if (renderAbort.current !== controller) return;
        setFrame(next.dataUrl);
        setRendering(false);
      })
      .catch(() => {
        // Same test on the failure path — an ABORTED fetch rejects, and a
        // superseded request must not report a failure the operator's current
        // look never had.
        if (renderAbort.current !== controller) return;
        setRenderFailed(true);
        setRendering(false);
      });
  };

  /**
   * TM4 — the pin. `template@version`, both halves, because D123's whole
   * guarantee is that a running campaign does not change when the library does:
   * an id alone would follow the library forward.
   *
   * It writes the shell's active campaign, which is what the left column this
   * modal opens from displays. A mounted editor's unsaved draft is *not* that
   * brief (D35), so a pin made while the editor holds edits lands on the shell
   * and not on the draft — stated in the PR as a known gap, and the reason is
   * that carrying a pin into `EditorState` means the create seed and a reducer
   * action, which is the editor's lane and not this one's.
   *
   * The pinned reference arrives as a PARAMETER rather than being read off
   * `pinnable` here, and that is the review fix from #478 rather than a style
   * choice. The verb used to render `disabled` for an unpinnable record while a
   * guard in this function carried `istanbul ignore next -- the button only
   * renders for a pinnable record` — a claim the footer contradicted, excusing
   * coverage on a branch whose reachability it described backwards. The footer
   * now renders the verb only where there is something to pin, so the fact is
   * carried by the type and there is no branch left to excuse or to mis-explain.
   */
  const useTemplate = (pinned: BriefTemplate) => {
    setBrief({ ...brief, template: pinned });
    closeTemplateLibrary();
  };

  return (
    <DialogShell
      open={templateLibraryOpen}
      onClose={closeTemplateLibrary}
      ariaLabel="Template library"
      className="max-w-3xl"
    >
      {shown === undefined ? (
        <>
          <DialogHead
            title="Template library"
            description="Grouped by creative type. Pick one to see its layers and pin it to this campaign."
            onClose={closeTemplateLibrary}
            actions={
              <div className="flex items-center gap-2">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search templates by name"
                  placeholder="Search"
                  className="h-8 w-40"
                />
                <select
                  aria-label="Sort templates"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="h-8 rounded-lg border border-border-control bg-surface-2 px-2 text-[12px] text-text-primary"
                >
                  <option value="name">Name</option>
                  <option value="version">Newest version</option>
                </select>
              </div>
            }
          />
          <DialogBody className="overflow-hidden">
            <div
              ref={(node) => {
                if (node === null) return;
                const top = pendingScrollTop.current;
                if (top === null) return;
                pendingScrollTop.current = null;
                node.scrollTop = top;
              }}
              onScroll={(e) => {
                listScrollTop.current = e.currentTarget.scrollTop;
              }}
              data-testid="template-list"
              className="h-full space-y-6 overflow-y-auto p-4"
            >
              {error ? (
                <p className="text-[13px] text-error">
                  Could not load the template library. Is the API running?
                </p>
              ) : entries === null ? (
                <p className="text-[13px] text-text-muted">Loading templates…</p>
              ) : collapsed.length === 0 ? (
                <p className="text-[13px] text-text-muted">No templates yet.</p>
              ) : matching.length === 0 ? (
                <p className="text-[13px] text-text-muted">
                  No template matches “{search.trim()}”.
                </p>
              ) : (
                // T-D3 — grouped by `creativeType`, the field a template
                // actually has. "Campaign type" is not one: a campaign type
                // maps to formats and platforms through
                // `CAMPAIGN_TYPE_PRESETS`, and the relation to a template is
                // derived and many-to-many (T4).
                CREATIVE_TYPES.map((creativeType) => {
                  const group = matching.filter(
                    (template) => template.creativeType === creativeType,
                  );
                  if (group.length === 0) return null;
                  return (
                    <section key={creativeType}>
                      <h3 className="mb-2 text-[12px] font-semibold text-text-emphasis">
                        {creativeTypeDisplayName(creativeType)}
                      </h3>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {group.map((template) => (
                          <button
                            key={template.id}
                            type="button"
                            data-template-card={template.id}
                            ref={(node) => {
                              if (node === null || pendingFocusId.current !== template.id) return;
                              pendingFocusId.current = null;
                              node.focus();
                            }}
                            onClick={() => openDetail(template)}
                            className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 p-3 text-left transition-colors hover:border-border-control-hover"
                          >
                            <TemplateThumb layers={template.layers} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] text-text-primary">
                                {template.name}
                              </span>
                              <span className="mt-1 flex items-center gap-1">
                                <MiniChip tone="neutral">{unitDisplayName(template.unit)}</MiniChip>
                                <MiniChip tone="info">{`v${template.version}`}</MiniChip>
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })
              )}
            </div>
          </DialogBody>
        </>
      ) : (
        <TemplateDetail
          template={shown}
          // `shown` is only defined when `entries` is, so the history is read
          // from the loaded list — never a fetch, and never a fallback that no
          // state can reach.
          versions={versionsOf(entries as CreativeTemplate[], shown.id)}
          briefs={briefs}
          pinned={pinnable}
          canRender={pinnable !== null && product !== undefined}
          frame={frame}
          rendering={rendering}
          renderFailed={renderFailed}
          onBack={back}
          backRef={(node) => {
            if (node === null || !pendingFocusBack.current) return;
            pendingFocusBack.current = false;
            node.focus();
          }}
          onClose={closeTemplateLibrary}
          onSelectVersion={(version) => openDetail({ ...shown, version })}
          onRenderPreview={renderPreview}
          onUseTemplate={useTemplate}
        />
      )}
    </DialogShell>
  );
}

/**
 * The detail view (TM3): the same shell's body, swapped. It renders **no**
 * fragment of a `DialogShell` of its own — the whole point of T6.
 */
function TemplateDetail({
  template,
  versions,
  briefs,
  pinned,
  canRender,
  frame,
  rendering,
  renderFailed,
  onBack,
  backRef,
  onClose,
  onSelectVersion,
  onRenderPreview,
  onUseTemplate,
}: {
  readonly template: CreativeTemplate;
  readonly versions: readonly CreativeTemplate[];
  readonly briefs: readonly BriefEntry[] | null;
  /** The record as a brief's pinned reference, or `null` when it cannot be one. */
  readonly pinned: BriefTemplate | null;
  readonly canRender: boolean;
  readonly frame: string | null;
  readonly rendering: boolean;
  readonly renderFailed: boolean;
  readonly onBack: () => void;
  readonly backRef: (node: HTMLButtonElement | null) => void;
  readonly onClose: () => void;
  readonly onSelectVersion: (version: number) => void;
  readonly onRenderPreview: () => void;
  readonly onUseTemplate: (pinned: BriefTemplate) => void;
}): ReactNode {
  // T-D5 — provenance is the PINNED CAMPAIGN's, and it is labelled as such. A
  // template is ownerless (D123): presenting its own fields as "brief details"
  // would be a category error, and inventing a brief for it is forbidden
  // outright (D26). Matched on id AND version, because a campaign pinned one
  // version and a different version of the same id is a different record.
  //
  // `listBriefs` checks a listed entry's `file` and `products`, not its
  // `template`, so a stored brief written before D123 (or by hand) can arrive
  // without one even though the type declares it required — read it as
  // possibly absent rather than dereferencing a field the client never
  // validated.
  const usedBy =
    briefs === null
      ? null
      : briefs.filter((entry) => {
          const pinned = entry.brief.template as BriefTemplate | undefined;
          return (
            pinned !== undefined && pinned.id === template.id && pinned.version === template.version
          );
        });

  return (
    <>
      <DialogHead
        title={template.name}
        description={`${creativeTypeDisplayName(template.creativeType)} · ${unitDisplayName(template.unit)} · v${template.version}`}
        onClose={onClose}
        actions={
          // A plain button, not the `Button` kit: `ButtonProps` does not declare
          // `ref`, and this control is the view swap's focus target.
          <button
            type="button"
            ref={backRef}
            onClick={onBack}
            aria-label="Back to the listing"
            className="rounded px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis"
          >
            ← Back
          </button>
        }
      />
      <DialogBody className="space-y-4 p-4">
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="flex min-h-[160px] w-full max-w-[220px] shrink-0 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface-2 p-3">
            {frame === null ? (
              <>
                <TemplateThumb layers={template.layers} />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onRenderPreview}
                  disabled={!canRender || rendering}
                  isLoading={rendering}
                >
                  Render preview
                </Button>
                {/* T-D4, said out loud: the cost is the operator's to spend. */}
                <p className="text-center text-[10px] text-text-muted">
                  {canRender
                    ? "Nothing happens until you ask — a preview builds the real creative."
                    : "A preview needs a campaign with a product open, and a template that campaign can use."}
                </p>
                {renderFailed ? (
                  <p className="text-center text-[11px] text-error">Could not render a preview.</p>
                ) : null}
              </>
            ) : (
              <>
                {/* The frame IS the creative — decorative to the reader, named by the caption. */}
                <img src={frame} alt="" className="w-full rounded" data-testid="template-preview" />
                {/*
                  The caption used to read "Rendered at 1:1, headline-top ·
                  bold" — a raw ratio id and two raw axis values, which is the
                  same D18 / DESIGN.md §6.4 breach as the layer chip. The shape
                  goes through `ratioDisplayName`; the layout and tone have no
                  display names in this app, so they are not named at all
                  rather than shown raw — "one representative look" is the fact
                  the operator needs, and inventing two labels here would put a
                  second vocabulary beside the domain's.
                */}
                <p className="text-center text-[10px] text-text-muted">
                  {`A ${ratioDisplayName(PREVIEW_CANVAS.ratio).toLowerCase()} preview — one representative look, not every shape this template can make.`}
                </p>
              </>
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            <section>
              <h3 className="mb-1 text-[12px] font-semibold text-text-emphasis">Layers</h3>
              {/* Read-only, and bottom-first because array position is z-order (D128). */}
              <ol className="space-y-1" data-testid="template-layers">
                {template.layers.map((layer, index) => (
                  <li
                    key={layer.id}
                    className="flex items-center gap-2 text-[12px] text-text-primary"
                  >
                    {/*
                      The chip used to carry `layer.kind` — the domain token,
                      beside its own display name, so the row said the same
                      thing twice and one of the two was the editor's internal
                      vocabulary (D18, DESIGN.md §6.4: display names for
                      values, never raw keys). It now carries the layer's
                      position in the stack, counted from the bottom, which is
                      real information the row did not have: array position IS
                      z-order (D128), so 1 is the layer everything else is
                      drawn over.
                    */}
                    <MiniChip tone="neutral">{String(index + 1)}</MiniChip>
                    <span className="truncate">{layerKindDisplayName(layer.kind)}</span>
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <h3 className="mb-1 text-[12px] font-semibold text-text-emphasis">Version history</h3>
              <div className="flex flex-wrap gap-1" data-testid="template-versions">
                {versions.map((version) => (
                  <button
                    key={version.version}
                    type="button"
                    onClick={() => onSelectVersion(version.version)}
                    aria-current={version.version === template.version ? "true" : undefined}
                    className="rounded border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text-primary hover:border-border-control-hover"
                  >
                    {`v${version.version}`}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-1 text-[12px] font-semibold text-text-emphasis">Provenance</h3>
              {usedBy === null ? (
                <p className="text-[12px] text-text-muted">
                  Could not read the campaign briefs, so nothing is known about where this template
                  has been used.
                </p>
              ) : usedBy.length === 0 ? null : (
                <ul className="space-y-0.5">
                  {usedBy.map((entry) => (
                    <li key={entry.file} className="text-[12px] text-text-muted">
                      Last used by <span className="font-mono">{entry.brief.id}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </DialogBody>
      <DialogFoot>
        <div className="flex items-center justify-end gap-2">
          {/*
            Absent, not disabled — and the distinction is the rule, not a
            preference. DESIGN.md §5 keeps a verb live because "pressing a
            primary verb is how a user asks what is wrong", and its capability
            gating disables a control *and shows the reason* when the host
            cannot do the thing. Both are about a state that can CHANGE: the
            draft gets fixed, ffmpeg gets installed. This template can never
            become usable — the limit is in the shape a brief may carry, not in
            anything on screen — so a verb here would be permanently dead, and
            a control that can never become live is worse than one that is not
            there. The sentence carries the whole answer instead.
          */}
          {pinned === null ? (
            <p className="mr-auto text-[11px] text-text-muted">
              This template cannot be used for a campaign yet — only the built-in ones can, for now.
            </p>
          ) : (
            <Button size="sm" onClick={() => onUseTemplate(pinned)}>
              Use this template
            </Button>
          )}
        </div>
      </DialogFoot>
    </>
  );
}
