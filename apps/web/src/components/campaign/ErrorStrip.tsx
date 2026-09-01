"use client";

import type { FieldErrors } from "./validate";
import { SECTION_TITLES, type SectionId } from "./sections";

interface ErrorStripProps {
  errors: Record<string, FieldErrors>;
  onErrorClick?: (section: string) => void;
}

/**
 * An error bucket keys either a section — one of the six in `SECTION_TITLES` — or
 * the one exception, `motion`, which validates under its host. The totality test
 * (W6.7) pins this map both ways and declares `MOTION_HOST_SECTION`, so a bucket
 * cannot reach the label lookup without a declared section — the chip label is
 * spelled by the one `SECTION_TITLES` vocabulary, never by a `||` fallback.
 */
export const SECTION_BY_ERROR_KEY: Record<SectionId, SectionId> = {
  identity: "identity",
  copy: "copy",
  products: "products",
  treatments: "treatments",
  output: "output",
  policy: "policy",
};

/** The one non-section bucket: motion's errors render inside its Output host. */
export const MOTION_ERROR_KEY = "motion";
export const MOTION_HOST_SECTION: SectionId = "output";
/** Motion is not a `SectionId`, so its chip label cannot come from `SECTION_TITLES`. */
export const MOTION_LABEL = "Motion";

/**
 * The section a validation bucket stands for — the one mapping the walk, `reveal`
 * and the D35 handoff's published verdict all share: the six sections pass through
 * unchanged, motion folds into its host. Null is "nothing blocks".
 */
export function sectionForErrorBucket(bucket: string | null): SectionId | null {
  if (bucket === null) return null;
  return bucket === MOTION_ERROR_KEY ? MOTION_HOST_SECTION : (bucket as SectionId);
}

export function ErrorStrip({ errors, onErrorClick }: ErrorStripProps) {
  const sectionsWithErrors = Object.entries(errors)
    .filter(([, sectionErrors]) => sectionErrors && Object.keys(sectionErrors).length > 0)
    // Only declared buckets — the six sections plus motion — reach the label lookup.
    // An undeclared bucket cannot occur from validate (W6.7 pins it), so it is
    // dropped rather than spelled as a raw-key chip.
    .filter(
      ([section]) =>
        section === MOTION_ERROR_KEY || SECTION_TITLES[SECTION_BY_ERROR_KEY[section as SectionId]],
    );

  if (sectionsWithErrors.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {sectionsWithErrors.map(([section, sectionErrors]) => {
        const errorCount = Object.keys(sectionErrors).length;
        const label =
          section === MOTION_ERROR_KEY
            ? MOTION_LABEL
            : SECTION_TITLES[SECTION_BY_ERROR_KEY[section as SectionId]];
        return (
          <button
            key={section}
            type="button"
            onClick={() => onErrorClick?.(section)}
            className="inline-flex items-center gap-1.5 rounded-full border border-error/50 bg-error/10 px-3 py-1 text-[11px] font-medium text-error transition-colors hover:bg-error/20"
          >
            <span>{label}</span>
            <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-error/30 px-1 text-[10px]">
              {errorCount}
            </span>
          </button>
        );
      })}
    </div>
  );
}
