"use client";

import type { FieldErrors } from "./validate";
import type { CampaignMode } from "./editor-state";

interface TocEntry {
  id: string;
  label: string;
  section: string;
}

const SECTIONS: TocEntry[] = [
  { id: "identity", label: "Identity", section: "identity" },
  { id: "copy", label: "Copy", section: "copy" },
  { id: "products", label: "Products", section: "products" },
  { id: "treatments", label: "Treatments", section: "treatments" },
  { id: "policy", label: "Variation Policy", section: "policy" },
  { id: "output", label: "Output", section: "output" },
];

interface TableOfContentsProps {
  errors: Record<string, FieldErrors>;
  mode: CampaignMode;
  onNavigate?: (sectionId: string) => void;
}

export function TableOfContents({ errors, mode, onNavigate }: TableOfContentsProps) {
  const getErrorCount = (section: string): number => {
    const sectionErrors = errors[section];
    if (!sectionErrors) return 0;
    return Object.keys(sectionErrors).length;
  };

  const visibleSections = SECTIONS.filter((entry) => {
    if (entry.section === "treatments") return mode === "brief";
    if (entry.section === "policy") return mode === "variation";
    return true;
  });

  const scrollToSection = (sectionId: string) => {
    const element = document.getElementById(sectionId);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    onNavigate?.(sectionId);
  };

  return (
    <nav className="sticky top-4 space-y-1">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Sections
      </p>
      {visibleSections.map((entry) => {
        const errorCount = getErrorCount(entry.section);
        const hasErrors = errorCount > 0;

        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => scrollToSection(entry.id)}
            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-surface-2"
          >
            <span>{entry.label}</span>
            {hasErrors && (
              <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500/20 px-1.5 text-[10px] font-bold text-red-400">
                {errorCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
