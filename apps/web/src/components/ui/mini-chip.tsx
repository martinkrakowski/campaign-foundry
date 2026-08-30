import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type MiniChipTone = "neutral" | "success" | "warning" | "error" | "info";

export interface MiniChipProps {
  readonly children: ReactNode;
  readonly tone?: MiniChipTone;
  readonly className?: string;
  readonly title?: string;
}

const TONE_CLASSES: Record<MiniChipTone, string> = {
  neutral: "border-border bg-surface-2 text-text-muted",
  success: "border-success/30 bg-success/20 text-success",
  warning: "border-warning/30 bg-warning/20 text-warning",
  error: "border-error/30 bg-error/20 text-error",
  info: "border-info/30 bg-info/20 text-info",
};

/**
 * 20px monospace status pill (W10.4 / D29 / SHELL-51).
 * Used for gate verdicts (PASS/FAIL), run states, and file metadata badges.
 */
export function MiniChip({
  children,
  tone = "neutral",
  className,
  title,
}: MiniChipProps): ReactNode {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 items-center justify-center rounded border px-1.5 font-mono text-[10px] font-medium uppercase tracking-wider",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
