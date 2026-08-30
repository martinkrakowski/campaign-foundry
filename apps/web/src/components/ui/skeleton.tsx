import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SkeletonProps {
  readonly className?: string;
}

/**
 * A placeholder block for content that has not arrived (W2a.2 / SHELL-40).
 *
 * Static, not pulsing. D27 permits exactly four looping animations — the four
 * motion-kind previews — and a pulsing skeleton would be a fifth, so the block is
 * motionless and the wait is *announced* instead: the caller pairs it with a
 * `role="status"` sentence, which is also the only thing here a screen reader needs
 * (see `HeadlinePoolDrawer`, `TelemetryDrawer`). `aria-hidden` because a bare
 * rectangle says nothing the sentence has not already said.
 */
export function Skeleton({ className }: SkeletonProps): ReactNode {
  return <div aria-hidden="true" className={cn("h-4 w-full rounded-md bg-surface-2", className)} />;
}
