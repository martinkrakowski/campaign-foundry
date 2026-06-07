"use client";

import Link from "next/link";
import { Accordion } from "./Accordion";
import { useRun } from "@/lib/run-context";

/**
 * Floating left panel: the campaign brief (read-only) and the project asset bin.
 * Hidden below `lg` — on smaller screens its contents surface in the mobile menu.
 */
export function Sidebar() {
  return (
    <aside className="relative z-10 hidden h-full w-[320px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl lg:flex">
      <SidebarContent />
    </aside>
  );
}

/**
 * The brief + project-bin panel body, without the desktop `<aside>` chrome — shared
 * by the desktop Sidebar and the mobile fullscreen menu so both stay in sync.
 */
export function SidebarContent() {
  const { brief } = useRun();
  const aspectsLabel = "1:1, 9:16, 16:9";

  return (
    <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <Accordion
          title="Campaign Brief"
          aside={
            <Link
              href="/brief"
              className="text-[11px] font-medium text-text-muted transition-colors hover:text-white"
            >
              Edit
            </Link>
          }
        >
          <Field label="Brief ID">
            <span className="font-mono">{brief.id}</span>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Target Region">{brief.targetRegion}</Field>
            <Field label="Aspects">
              <span className="font-mono">{aspectsLabel}</span>
            </Field>
          </div>

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
            <span className="text-[11px] font-mono text-text-muted">
              {brief.products.length} assets
            </span>
          }
        >
          <div className="space-y-2">
            {brief.products.map((product) => (
              <div
                key={product.id}
                className="flex items-center space-x-3 rounded-lg border border-border bg-surface-2 p-2"
              >
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-md border border-border text-lg font-bold"
                  style={{ color: product.primaryColor }}
                >
                  {product.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-text-primary">{product.name}</div>
                  <div className="font-mono text-[10px] uppercase text-text-muted">{product.id}</div>
                </div>
              </div>
            ))}
          </div>
        </Accordion>
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
