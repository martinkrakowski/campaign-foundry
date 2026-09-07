"use client";

import type { FieldErrors } from "./validate";
import { SECTION_TITLES, type SectionId } from "./sections";
import { JumpStrip } from "@/components/ui";

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
  layout: "layout",
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

  // The chips themselves are the kit's `JumpStrip` (F6); this component keeps only
  // the bucket→label mapping — the one `SECTION_TITLES` vocabulary, with motion
  // spelled by its own label, never a `||` fallback.
  return (
    <JumpStrip
      onJump={onErrorClick}
      items={sectionsWithErrors.map(([section, sectionErrors]) => ({
        key: section,
        label:
          section === MOTION_ERROR_KEY
            ? MOTION_LABEL
            : SECTION_TITLES[SECTION_BY_ERROR_KEY[section as SectionId]],
        count: Object.keys(sectionErrors).length,
      }))}
    />
  );
}
