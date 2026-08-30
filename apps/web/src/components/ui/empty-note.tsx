import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyNoteProps {
  readonly title?: ReactNode;
  readonly message?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * Shared empty-state block (W10.4 / SHELL-49).
 * Used for empty view pages and sections when no data or runs exist.
 */
export function EmptyNote({
  title,
  message,
  children,
  className,
}: EmptyNoteProps): ReactNode {
  return (
    <div className={cn("flex flex-col items-center justify-center p-6 text-center", className)}>
      {title ? <h2 className="mb-2 text-lg font-semibold text-text-emphasis">{title}</h2> : null}
      {message ? <p className="max-w-md text-[13px] text-text-muted">{message}</p> : null}
      {children}
    </div>
  );
}
