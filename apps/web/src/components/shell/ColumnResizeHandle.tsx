"use client";

import { type ReactNode } from "react";
import { PanelResizeHandle } from "react-resizable-panels";

/**
 * The separator's accessible name, exported so a test names it by derivation
 * rather than by restating the string.
 */
export const COLUMN_RESIZE_LABEL = "Resize the preview column";

/**
 * The drag handle between the shell row's middle column and its right-hand rail
 * (SG2, the owner's wireframe).
 *
 * **Why a dependency and not twenty lines of pointer handling (SG-D17).** The
 * acceptance criterion for this lane is a KEYBOARD contract: the split must move
 * on arrow keys, from a focusable `role="separator"` that reports where it sits.
 * `PanelResizeHandle` already is that — it registers the keydown listener, clamps
 * against both panels' `minSize`, and keeps `aria-controls`/`aria-valuemin`/
 * `aria-valuenow` current as the layout changes. Hand-rolling it means
 * reimplementing the W3C window-splitter pattern, not saving a package.
 *
 * **`enabled` is the viewport gate, and it is the whole reason this component
 * takes a prop.** The rail is `hidden lg:flex` (`SidebarShell.tsx:52`) — below
 * 1024px it is hidden but still MOUNTED, because every mount-count invariant in
 * the editor depends on the gate not unmounting it (D43). A handle beside it is
 * therefore mounted at 1000px too, and left alone it would be a 6px strip that
 * cannot be seen, tabs into focus, and resizes a column nobody can look at.
 *
 * Three mechanisms, because they cover three different things and no one of them
 * covers all three:
 *
 * - `hidden lg:flex` — the CSS half, and the only one that stops the handle
 *   RESERVING WIDTH. `display: none` takes it out of the flex row entirely.
 * - `tabIndex={-1}` — the tab order. `disabled` does NOT do this: the library
 *   defaults `tabIndex` to 0 and passes it straight through, so a disabled
 *   handle is still a tab stop. Measured with `userEvent.tab()`, which walks
 *   real tabbability, not with an attribute read.
 * - `disabled` — the behaviour. It is what makes the library's own keydown and
 *   pointer registration bail out (`useWindowSplitterResizeHandlerBehavior`
 *   returns before `addEventListener` when `disabled`), so an arrow key on a
 *   handle that somehow held focus still moves nothing.
 *
 * `inert` is deliberately not a fourth: it would be redundant with all three,
 * and `aria-hidden` is unnecessary because `display: none` is already out of the
 * accessibility tree.
 *
 * The grip is a child rather than a border on the handle itself, so the hit area
 * is the full 16px of the row's gap while the visible line stays 4px — the
 * wireframe's proportion. Styling is this repo's tokens (DESIGN.md §4.8's
 * focus-visible ring), not the reference implementation's.
 */
export function ColumnResizeHandle({ enabled }: { enabled: boolean }): ReactNode {
  return (
    <PanelResizeHandle
      aria-label={COLUMN_RESIZE_LABEL}
      disabled={!enabled}
      tabIndex={enabled ? 0 : -1}
      className="group hidden w-4 shrink-0 cursor-col-resize items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:flex"
    >
      <span
        aria-hidden="true"
        className="h-10 w-1 rounded-full bg-border transition-colors duration-fast group-hover:bg-border-hover group-data-[resize-handle-state=drag]:bg-brand-primary"
      />
    </PanelResizeHandle>
  );
}
