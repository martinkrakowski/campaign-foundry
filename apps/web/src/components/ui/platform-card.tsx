import { useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { RatioFrame } from "./ratio-frame";
import { PreviewFrame } from "./PreviewFrame";
import type { PlatformProfile } from "@campaignfoundry/Distribution/platform-profiles";

export interface PlatformCardProps {
  /** The platform profile — its id is the button's accessible name verbatim. */
  readonly profile: PlatformProfile;
  readonly selected: boolean;
  readonly onToggle: (id: string) => void;
  /** Optional meta text below the label (e.g. ratio/format). */
  readonly meta?: string;
  /**
   * Why this platform is unavailable, or anything else assistive technology must
   * hear. Exposed via `aria-describedby`, so the accessible name stays exactly `profile.id`.
   */
  readonly description?: string;
  readonly disabled?: boolean;
}

/**
 * The selectable card for one platform in the Output section.
 *
 * In accordance with D7 and D18, the accessible name is exactly the raw platform `id`
 * (`aria-label={profile.id}`), while the visible screen label is `profile.label`
 * (e.g. "Instagram Feed", "Instagram Story") — the raw ID never reaches the user's eyes.
 * The preview frame, checkmark, and meta captions are all `aria-hidden`.
 */
export function PlatformCard({
  profile,
  selected,
  onToggle,
  meta,
  description,
  disabled = false,
}: PlatformCardProps): ReactNode {
  const descriptionId = `platform-card-description-${useId()}`;
  return (
    <button
      type="button"
      aria-label={profile.id}
      aria-pressed={selected}
      {...(description === undefined ? {} : { "aria-describedby": descriptionId })}
      disabled={disabled}
      onClick={() => onToggle(profile.id)}
      className={cn(
        "relative flex flex-col items-center gap-2 rounded-md border p-3 text-center transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-brand-primary bg-surface-2" : "border-border hover:border-border-hover",
      )}
    >
      {selected ? (
        <span className="absolute right-1.5 top-1.5" aria-hidden="true">
          <svg viewBox="0 0 12 12" focusable="false" aria-hidden="true" className="size-3 text-brand-primary">
            <path
              d="M2 6.5 5 9.5 10 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : null}
      <span aria-hidden="true" className="flex items-center justify-center">
        <PreviewFrame>
          <RatioFrame ratio={profile.ratio} size={40} />
        </PreviewFrame>
      </span>
      <span className={cn("text-[13px] font-medium leading-tight", selected ? "text-white" : "text-text-primary")}>
        {profile.label}
      </span>
      {meta ? (
        <span aria-hidden="true" className="text-[11px] text-text-muted">
          {meta}
        </span>
      ) : null}
      {description === undefined ? null : (
        <span id={descriptionId} className="text-[11px] text-warning">
          {description}
        </span>
      )}
    </button>
  );
}
