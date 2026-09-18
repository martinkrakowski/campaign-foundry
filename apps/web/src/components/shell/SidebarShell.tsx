import { type ReactNode } from "react";

/**
 * The shell's side-panel chrome: the floating `<aside>` a sidebar column wears.
 *
 * RS1/RS-D2 — one definition, so the two sides of the shell row cannot drift.
 * Before this existed the left sidebar's chrome was inline in `Sidebar.tsx` and
 * the right-hand preview rail carried a *different* container three levels inside
 * `main`'s scroller: 256px against 320px, a bare `border-l` against panel chrome,
 * and — the part that cost two days — a **container** query against this one's
 * **viewport** `lg:`. The rail's container was `viewport − 368px`, so its
 * `@container(min-width:56rem)` resolved to 1264px of viewport while this column
 * appeared at 1024px, and the 240px band between them hid the rail on the owner's
 * screen while every merge landed correctly.
 *
 * Three properties are load-bearing here, and all three are the reason the right
 * sidebar wears this rather than a copy of it:
 *
 * - `h-full` inside the shell's flex row is the only way a column is as tall as
 *   the browser. `sticky max-h-screen` inside `main`'s scroller — what the rail
 *   used — can never be, because that box is as tall as the scrolled content.
 * - `lg:flex` is a VIEWPORT gate, the same number for both columns.
 * - `hidden`/`lg:flex` hides without unmounting, which every mount-count
 *   invariant in the editor (D43) depends on.
 */
export function SidebarShell({ children }: { children: ReactNode }): ReactNode {
  return (
    <aside className="relative z-10 hidden h-full w-[320px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl lg:flex">
      {children}
    </aside>
  );
}
