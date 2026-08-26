"use client";

import type { FieldErrors } from "./validate";

interface ErrorStripProps {
  errors: Record<string, FieldErrors>;
  onErrorClick?: (section: string) => void;
}

const SECTION_LABELS: Record<string, string> = {
  identity: "Identity",
  copy: "Copy",
  products: "Products",
  treatments: "Treatments",
  policy: "Policy",
  output: "Output",
  motion: "Motion",
};

export function ErrorStrip({ errors, onErrorClick }: ErrorStripProps) {
  const sectionsWithErrors = Object.entries(errors).filter(
    ([, sectionErrors]) => sectionErrors && Object.keys(sectionErrors).length > 0
  );

  if (sectionsWithErrors.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {sectionsWithErrors.map(([section, sectionErrors]) => {
        const errorCount = Object.keys(sectionErrors).length;
        const label = SECTION_LABELS[section] || section;

        return (
          <button
            key={section}
            type="button"
            onClick={() => onErrorClick?.(section)}
            className="inline-flex items-center gap-1.5 rounded-full border border-red-500/50 bg-red-500/10 px-3 py-1 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-500/20"
          >
            <span>{label}</span>
            <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500/30 px-1 text-[10px]">
              {errorCount}
            </span>
          </button>
        );
      })}
    </div>
  );
}
