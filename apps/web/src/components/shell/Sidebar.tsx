"use client";

import { useState, useEffect } from "react";
import { Accordion } from "./Accordion";
import { useEditorPanels, usePanelSink } from "@/lib/editor-panels-context";
import { useRun } from "@/lib/run-context";
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { useGuardedNavigation } from "@/lib/use-guarded-navigation";
import { listAssets, formatBytes, type AssetEntry } from "@/lib/briefs-api";
import { AssetPickerDrawer } from "@/components/campaign/AssetPickerDrawer";

/**
 * Floating left panel: the campaign brief (read-only) and the project asset bin.
 * Hidden below `lg` — on smaller screens its contents surface in the mobile menu.
 */
export function Sidebar() {
  return (
    <aside className="relative z-10 hidden h-full w-[320px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl lg:flex">
      <SidebarContent />
      <BrowseBriefsButton />
    </aside>
  );
}

/**
 * Footer action that opens the brief picker. Shared by the desktop sidebar and the
 * mobile menu; `onActivate` lets the mobile menu close itself before the picker opens.
 */
export function BrowseBriefsButton({ onActivate }: { onActivate?: () => void }) {
  const { openBriefPicker } = useRun();
  const { guardedPush } = useGuardedNavigation();
  return (
    <div className="flex shrink-0 gap-2 border-t border-border p-3">
      <button
        type="button"
        onClick={() => {
          onActivate?.();
          // guardedPush already prompts when the editor is dirty — confirming here too
          // would show the same dialog twice.
          guardedPush("/brief/new");
        }}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-primary px-3 py-2 text-[12px] font-medium text-white transition-colors hover:bg-brand-primary-hover"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m-7-7h14" />
        </svg>
        Create new
      </button>
      <button
        type="button"
        onClick={() => {
          onActivate?.();
          openBriefPicker();
        }}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-control bg-surface-2 px-3 py-2 text-[12px] font-medium text-text-primary transition-colors hover:bg-border-hover"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
        </svg>
        Browse briefs
      </button>
    </div>
  );
}

/**
 * The brief + project-bin panel body, without the desktop `<aside>` chrome — shared
 * by the desktop Sidebar and the mobile fullscreen menu so both stay in sync.
 *
 * `onNavigate` fires when an in-panel link is clicked; the mobile menu passes its
 * close handler so following the "Edit" link dismisses the overlay even when it
 * points at the current route (where a route-change listener wouldn't fire).
 */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { brief } = useRun();
  const { panels, topPanels } = useEditorPanels();
  usePanelSink();
  const { guardedPush } = useGuardedNavigation();
  const aspectsLabel = (() => {
    const mode = brief.mode ?? "brief";
    if (mode === "variation") {
      const ratios = brief.variation?.axes?.ratio;
      // `length`, not `??`: the ratio axis is the one axis DESIGN.md §5 allows to be
      // emptied, so `[]` is a legal saved state — and `[].join(", ")` is "", which
      // would render the Aspects field blank rather than falling back.
      return ratios?.length ? ratios.join(", ") : RATIO_VALUES.join(", ");
    }
    // classic brief or undefined mode
    return RATIO_VALUES.join(", ");
  })();
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setAssets([]);
    const requestedId = brief.id;
    listAssets(requestedId, controller.signal)
      .then((res) => {
        if (!cancelled && brief.id === requestedId) setAssets(res.assets);
      })
      .catch(() => {
        if (!cancelled && brief.id === requestedId) setAssets([]);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [brief.id]);

  const handleEditClick = (e: React.MouseEvent) => {
    e.preventDefault();
    onNavigate?.();
    guardedPush("/brief");
  };

  return (
    <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {topPanels}
        <Accordion
          title="Campaign Brief"
          aside={
            <a
              href="/brief"
              onClick={handleEditClick}
              className="text-[11px] font-medium text-text-muted transition-colors hover:text-text-emphasis"
            >
              Edit
            </a>
          }
        >
          <Field label="Brief ID">
            <span className="font-mono">{brief.id}</span>
          </Field>

          <Field label="Target Region">{brief.targetRegion}</Field>
          <Field label="Aspects">
            <span className="font-mono">{aspectsLabel}</span>
          </Field>

          <Field label="Localized Copy">
            <span className="block select-text leading-relaxed">
              {brief.localizedMessage ?? brief.campaignMessage}
            </span>
          </Field>
        </Accordion>

        <div className="h-px w-full bg-border" />

        <Accordion
          title="Project Bin"
          aside={
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-text-muted">
                {assets.length} {assets.length === 1 ? "asset" : "assets"}
              </span>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="text-[11px] font-medium text-text-muted transition-colors hover:text-text-emphasis"
              >
                Browse
              </button>
            </div>
          }
        >
          {assets.length === 0 ? (
            <div className="text-[12px] text-text-muted">No assets uploaded yet.</div>
          ) : (
            <div className="space-y-2">
              {assets.map((asset) => (
                <div
                  key={asset.name}
                  onClick={() => setPickerOpen(true)}
                  className="flex cursor-pointer items-center space-x-3 rounded-lg border border-border-control bg-surface-2 p-2 transition-colors hover:border-border-control-hover"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-surface">
                    {asset.thumbnailUrl ? (
                      <img
                        src={asset.thumbnailUrl}
                        alt={asset.name}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="font-mono text-[9px] text-text-muted">
                        {(asset.type ?? "image/png").replace("image/", "").toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs text-text-primary" title={asset.name}>
                      {asset.name}
                    </div>
                    <div className="font-mono text-[10px] text-text-muted">
                      <span className="uppercase tracking-wider">{(asset.type ?? "image/png").replace("image/", "")}</span>
                      <span> · </span>
                      <span>{formatBytes(asset.size ?? 0)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Accordion>

        <AssetPickerDrawer
          briefId={brief.id}
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
        />

        {/* Editor sections the brief page places here — the variation policy. */}
        {panels ? (
          <>
            <div className="h-px w-full bg-border" />
            {panels}
          </>
        ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] text-text-muted">{label}</label>
      <div className="rounded-lg border border-border bg-surface-2 p-2.5 text-[13px] text-text-primary">
        {children}
      </div>
    </div>
  );
}
