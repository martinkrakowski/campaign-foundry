import type { ReactNode } from "react";

/**
 * The action bar, floating over the view it belongs to — the grid's pipeline-bar
 * idiom. `sticky` (never `fixed`) keeps it pinned to the bottom of the column's own
 * scroll box: it cannot cover the sidebar, and it cannot scroll away up the page,
 * which `absolute` inside a scrolling child would do.
 */
export function FloatingBar({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) {
  return (
    <div
      {...rest}
      className="sticky bottom-6 z-20 mx-auto w-full max-w-[800px] rounded-xl border border-border bg-surface p-2 shadow-2xl"
    >
      {children}
    </div>
  );
}
