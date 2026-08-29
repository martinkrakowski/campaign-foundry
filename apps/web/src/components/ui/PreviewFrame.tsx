import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface PreviewFrameProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * A decorative container for miniature creative previews.
 */
export function PreviewFrame({ children, className }: PreviewFrameProps): ReactNode {
  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2",
        className,
      )}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}
