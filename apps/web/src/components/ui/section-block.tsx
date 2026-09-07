import { useId, type ReactNode } from "react";

export interface SectionBlockProps {
  /** The section number as it reads ("01"), rendered muted ahead of the title. */
  readonly numeral: string;
  readonly title: string;
  /** The one-line hint under the heading. */
  readonly hint?: string;
  /** A badge beside the title (e.g. an `ErrorPill`); decorative, so a prop not a lookup. */
  readonly badge?: ReactNode;
  /**
   * The heading level for `title`. Overlays sit at different depths in their
   * pages, so the shared chrome must not flatten them all to one level — the
   * same reason `DialogHead` takes one: inside a dialog whose head is an `h2`,
   * sibling `h2`s flatten the outline. Defaults to `h3`.
   */
  readonly headingLevel?: 2 | 3;
  readonly children: ReactNode;
}

/**
 * The numbered section (D86): an eyebrow numeral, a heading and an optional
 * hint, mirroring the editor's `SectionShell` without its `sectionOrder`
 * dependency — the numeral is a prop here, not derived from a feature's ordered
 * list, so any surface can number its own sections.
 */
export function SectionBlock({
  numeral,
  title,
  hint,
  badge,
  headingLevel = 3,
  children,
}: SectionBlockProps): ReactNode {
  const headingId = `section-block-heading-${useId()}`;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={headingId} className="space-y-4 scroll-mt-24">
      <Heading id={headingId} className="flex items-baseline gap-2 text-lg font-semibold text-text-emphasis">
        <span aria-hidden="true" className="font-mono text-[11px] font-medium tracking-wider text-text-muted">
          {numeral}
        </span>
        <span>{title}</span>
        {badge ?? null}
      </Heading>
      {hint ? <p className="text-[12px] leading-snug text-text-muted">{hint}</p> : null}
      {children}
    </section>
  );
}
