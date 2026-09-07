import { useId, type ReactNode } from "react";
import { Button } from "./button";

export type GuardBarActionVariant = "primary" | "secondary" | "ghost" | "destructive";

export interface GuardBarAction {
  readonly label: string;
  readonly onAct: () => void;
  /** Defaults to `secondary`; the destructive answer is the caller's to name. */
  readonly variant?: GuardBarActionVariant;
  readonly disabled?: boolean;
}

export interface GuardBarProps {
  readonly title: string;
  readonly detail?: string;
  /**
   * An answer is in flight: the actions hold still (never a spinner of the
   * guard's own) and the region says so to assistive technology.
   */
  readonly busy?: boolean;
  /**
   * The answers, in render order — not a fixed confirm/cancel pair, because a
   * two-way can need three buttons (keep / discard / start over).
   */
  readonly actions: readonly GuardBarAction[];
}

/**
 * The inline confirm strip (D89): a warning-tinted panel that replaces a
 * footer's button row in place. It is a region inside a footer, not a dialog —
 * no overlay, no scrim, no focus trap, no Escape handling; the surface around
 * it already owns modality. Every word is a prop; no literals, no `messages`
 * import.
 */
export function GuardBar({ title, detail, busy = false, actions }: GuardBarProps): ReactNode {
  const titleId = `guard-bar-title-${useId()}`;
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4"
    >
      <div className="min-w-0">
        <p id={titleId} className="text-[13px] font-semibold text-text-emphasis">
          {title}
        </p>
        {detail ? <p className="mt-0.5 text-[12px] leading-snug text-text-secondary">{detail}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {actions.map((action, index) => (
          // labels are not unique; GuardBarAction carries no id
          <Button
            key={index}
            type="button"
            size="sm"
            variant={action.variant ?? "secondary"}
            disabled={busy || action.disabled}
            onClick={action.onAct}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
