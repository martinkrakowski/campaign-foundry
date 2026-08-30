import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type FieldLineTone = "error" | "warning" | "muted";

export interface FieldLineProps {
  /** `error` for a refusal, `warning` for *cannot run here*, `muted` for a hint. */
  readonly tone?: FieldLineTone;
  readonly className?: string;
  readonly children?: ReactNode;
}

const TONE_CLASSES: Record<FieldLineTone, string> = {
  error: "text-error",
  warning: "text-warning",
  muted: "text-text-muted",
};

/**
 * The 11px line beneath a control: an error, a hint, or a derived readout
 * (W2a.6 / L1). Six bespoke copies of this line existed; the point of one primitive
 * is not the saved line of markup but that the size and the tone vocabulary cannot
 * drift apart one section at a time.
 *
 * Deliberately **not** a live region. GB-D1 gates an error's visibility on the field
 * being touched or the section being attempted, so these lines come and go with the
 * user's own focus; making each one a `role="alert"` would narrate the whole form and
 * would put red on a blank brief that must show none. A message that has to be spoken
 * — a refusal, a clamp notice — is wrapped in `role="status"` by its caller, as
 * `StatusLine` and the clamp notice already are.
 */
export function FieldLine({ tone = "muted", className, children }: FieldLineProps): ReactNode {
  return <p className={cn("text-[11px]", TONE_CLASSES[tone], className)}>{children}</p>;
}
