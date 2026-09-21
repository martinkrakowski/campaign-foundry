"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "./cn";
import { IconButton } from "./icon-button";

export interface UseDialogFocusTrapOptions {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly dialogRef: RefObject<HTMLElement | null>;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * The elements a Tab cycle can actually reach inside an overlay. Native Tab skips
 * disabled, hidden and aria-hidden content, so the boundary comparison must target
 * what a keyboard user can truly focus — otherwise a disabled control at the first
 * or last DOM position makes the cycle escape the dialog.
 */
export function getFocusableDialogElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select, [tabindex]"),
  ).filter(isFocusableCandidate);
}

function isFocusableCandidate(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) return false;
  if (element.getAttribute("tabindex") === "-1") return false;
  if (element.closest("[hidden]")) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  if (element.closest("[inert]")) return false;
  return true;
}

/**
 * Whether an Escape keydown belongs to this overlay. An open trap sets focus inside
 * itself, so the overlay currently holding focus is the topmost one — it and only
 * it may claim an Escape, and a ConfirmDialog stacked over an overlay leaves the
 * overlay beneath it open until its own Escape (SHELL-39).
 */
export function dialogHoldsFocus(dialog: HTMLElement | null): boolean {
  if (!dialog) return false;
  return dialog.contains(document.activeElement);
}

/**
 * Open-order registry of mounted traps, local to the Tab handler. Every mounted trap
 * registers its own `window` keydown listener, so with two overlays open both handlers
 * run on the same keypress — and if each one pulled stray focus into itself, the lower
 * would claim it for one synchronous tick before the topmost reclaims it: several
 * `preventDefault`s per keypress, focus ending up in the topmost's first control either
 * way, and no way for a test on final focus position to tell that apart. The
 * containment branch therefore fires only when this trap is the last entry — the most
 * recently *opened* overlay. Open order, never DOM order: paint order is set by callers
 * hand-raising `z` (`CreateCampaignDialog` passes `containerClassName="z-[80]"`), so
 * the last `[role=dialog]` in the document is not authoritative for which overlay is
 * on top. This is scoped to the Tab handler. Overlay depth (D84) is a separate
 * registry: `inert`, `aria-modal`, and paint order live there, not here.
 */
const openTraps: HTMLElement[] = [];

type OverlayKind = "dialog" | "drawer";

type OverlayLayer = {
  readonly inert: boolean;
  readonly ariaModal: boolean;
  readonly zIndex: number | undefined;
};

type OverlayRegistration = {
  readonly id: number;
  readonly kind: OverlayKind;
  readonly element: HTMLElement;
  readonly setLayer: (layer: OverlayLayer) => void;
};

/**
 * Open-order overlay stack for DialogShell and DrawerShell (D84). Every overlay
 * but the topmost is `inert` and drops `aria-modal`; only the topmost is modal.
 * Paint order is computed from this same stack so a `z-50` drawer opened over a
 * `z-[70]` dialog cannot sit under it. Callers may still raise `z` (`z-[80]` on
 * ConfirmDialog / the resume two-way) when stacking over a non-kit overlay this
 * counter cannot see; a lone kit shell therefore keeps its className z and gets
 * no inline override. Two or more kit shells always receive inline `paintZ`,
 * including index 0 — otherwise a buried `z-[80]` class ties the top's inline 80.
 */
const overlayStack: OverlayRegistration[] = [];
let overlaySeq = 0;

const DIALOG_BASE_Z = 70;
const DRAWER_BASE_Z = 50;
const OVERLAY_Z_STEP = 10;

const SINGLE_LAYER: OverlayLayer = { inert: false, ariaModal: true, zIndex: undefined };

function baseZ(kind: OverlayKind): number {
  return kind === "drawer" ? DRAWER_BASE_Z : DIALOG_BASE_Z;
}

function paintZ(index: number): number {
  let z = 0;
  for (let i = 0; i <= index; i++) {
    const base = baseZ(overlayStack[i]!.kind);
    z = i === 0 ? base : Math.max(base, z + OVERLAY_Z_STEP);
  }
  return z;
}

function layerOf(index: number): OverlayLayer {
  const isTop = index === overlayStack.length - 1;
  return {
    inert: !isTop,
    ariaModal: isTop,
    // Stacked shells must pin every layer, including the first: leaving index 0
    // on class-only z lets a buried `z-[80]` tie the top's inline 80. A lone
    // shell keeps class-only z so ConfirmDialog / CreateCampaignDialog can still
    // raise over a non-kit overlay this counter cannot see.
    zIndex: overlayStack.length > 1 ? paintZ(index) : undefined,
  };
}

function applyLayerDom(entry: OverlayRegistration, layer: OverlayLayer): void {
  const el = entry.element;
  el.toggleAttribute("inert", layer.inert);
  if (layer.ariaModal) el.setAttribute("aria-modal", "true");
  else el.removeAttribute("aria-modal");
  if (layer.zIndex !== undefined) el.style.zIndex = String(layer.zIndex);
  else el.style.removeProperty("z-index");
}

function publishLayers(): void {
  overlayStack.forEach((entry, index) => {
    const layer = layerOf(index);
    // Write the DOM immediately so a sibling's useEffect focus-restore (the trap)
    // sees the new topmost as focusable. Waiting for React to re-render left the
    // lower overlay `inert` for one tick, and happy-dom's focus() is a no-op on
    // an inert tree — Escape after dismissing a stacked shell then hit nobody.
    applyLayerDom(entry, layer);
    entry.setLayer(layer);
  });
}

function registerOverlay(
  kind: OverlayKind,
  setLayer: (layer: OverlayLayer) => void,
  element: HTMLElement,
): number {
  const id = ++overlaySeq;
  overlayStack.push({ id, kind, element, setLayer });
  publishLayers();
  return id;
}

function unregisterOverlay(id: number): void {
  // Mirrors `openTraps` removal: this id was pushed by the same effect invocation
  // that owns the cleanup, so `findIndex` is never -1 and a found-check would be
  // an unreachable branch this repo cannot cover.
  overlayStack.splice(
    overlayStack.findIndex((entry) => entry.id === id),
    1,
  );
  publishLayers();
}

function useOverlayDepth(
  open: boolean,
  kind: OverlayKind,
  elementRef: RefObject<HTMLElement | null>,
): OverlayLayer {
  const [layer, setLayer] = useState<OverlayLayer>(SINGLE_LAYER);

  useLayoutEffect(() => {
    if (!open) return;
    // The shell renders the overlay element before this effect when `open` is
    // true, so the ref is populated. A found-check would be an unreachable
    // branch this repo cannot cover.
    const id = registerOverlay(kind, setLayer, elementRef.current!);
    return () => {
      unregisterOverlay(id);
    };
  }, [open, kind, elementRef]);

  // After the trap's useEffect restore (this hook is declared first so this
  // cleanup runs last). The dismissed overlay may restore `body` — both shells
  // mounting together never captured a lower-overlay previouslyFocused, because
  // the lower was already inert when its trap ran.
  useEffect(() => {
    if (!open) return;
    return () => {
      const top = overlayStack[overlayStack.length - 1];
      if (top && !dialogHoldsFocus(top.element)) {
        getFocusableDialogElements(top.element)[0]?.focus();
      }
    };
  }, [open]);

  return open ? layer : SINGLE_LAYER;
}

/**
 * Focus trap and Escape key hook for dialogs and drawers (W10.5 / SHELL-41).
 * Captures previous active element on open, manages Tab wrapping, closes on Escape,
 * and restores focus on unmount.
 */
export function useDialogFocusTrap({
  open,
  onClose,
  dialogRef,
  initialFocusRef,
}: UseDialogFocusTrapOptions): void {
  // Hold the close callback in a ref updated on every render so the effect's
  // lifetime follows `open`, not the identity of a callback several callers pass as
  // a fresh inline arrow. Tearing the trap down and back up for each new identity
  // would re-run focus restoration and pull focus off the control the user was
  // using mid-interaction (SHELL-32).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const dialogElement = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    if (dialogElement) openTraps.push(dialogElement);

    if (initialFocusRef?.current) {
      initialFocusRef.current.focus();
    } else {
      getFocusableDialogElements(dialogElement)[0]?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!dialogHoldsFocus(dialogElement)) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }

      if (e.key !== "Tab") return;

      const focusables = getFocusableDialogElements(dialogElement);
      if (focusables.length === 0) return;

      // Only the most recently opened overlay claims a Tab (see `openTraps`): a lower
      // overlay must not touch the keystroke at all, so the upper keeps both the
      // containment decision and the cycle below.
      if (openTraps[openTraps.length - 1] !== dialogElement) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      // Containment (F5): a click on non-focusable panel content puts activeElement on
      // `document.body`, where `dialogHoldsFocus` answers false for *every* overlay at
      // once — so the registry rule above decides *which* trap handles it, and this
      // branch decides what it does: put focus back inside the dialog instead of
      // letting the browser's native Tab walk into the page behind the modal.
      if (!dialogHoldsFocus(dialogElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      // Mirrors the guarded push above: a trap with no element registered nothing.
      // `indexOf` is never -1 here, so the splice needs no found-check: this closure
      // and the push share one `dialogElement` const, React runs a cleanup exactly once
      // per effect invocation, and two mounted traps never share a DOM node — so every
      // push is balanced by this one removal of that same reference. A `!== -1` guard
      // would read as prudence, but its false arm is unreachable and this repo holds
      // 100 % branch coverage without `istanbul ignore`.
      if (dialogElement) openTraps.splice(openTraps.indexOf(dialogElement), 1);
      // Restoring onto `body` is a no-op for a lone overlay (unmount already
      // left focus there) and it steals from a remaining overlay this trap
      // stacked over — D84 has just made the new topmost focusable.
      if (previouslyFocused !== document.body) {
        previouslyFocused?.focus();
      }
    };
  }, [open, dialogRef, initialFocusRef, onCloseRef]);
}

export interface DialogHeadProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly onClose?: () => void;
  readonly closeLabel?: string;
  readonly closeText?: string;
  /**
   * The heading level for `title`. Overlays sit at different depths in their pages, so
   * the shared chrome must not flatten them all to one level — `HeadlinePoolDrawer` and
   * `AssetPickerDrawer` were `h3` before this extraction and stay `h3`.
   */
  readonly headingLevel?: 2 | 3;
  readonly actions?: ReactNode;
  readonly className?: string;
}

/** Shared head section for dialogs and drawers (W10.5 / SHELL-43 / TOK-51). */
export function DialogHead({
  title,
  description,
  onClose,
  closeLabel,
  closeText,
  headingLevel,
  actions,
  className,
}: DialogHeadProps): ReactNode {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  // An icon is nameless on its own, so it always carries a label; a word names itself
  // and only takes one when a caller wants to say *which* thing closes (drawers read
  // "Close drawer", and the suite queries that name).
  const iconCloseLabel = closeLabel ?? "Close";
  // WCAG 2.5.3 (Label in Name): when the control shows a word, its accessible name must
  // contain that word, or a voice-control user saying what they can see fails to
  // activate it. `closeLabel` is still useful for saying *which* thing closes ("Close
  // drawer"), so it is honoured only when it contains the visible text — otherwise the
  // visible text wins. This makes the bad pairing unauthorable rather than a caller's
  // duty to remember.
  const textCloseLabel =
    closeText !== undefined && closeLabel !== undefined && closeLabel.includes(closeText)
      ? closeLabel
      : undefined;

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 border-b border-border px-4 py-3",
        className,
      )}
    >
      <div>
        <Heading className="text-sm font-semibold text-text-emphasis">{title}</Heading>
        {description ? <p className="mt-0.5 text-[11px] text-text-muted">{description}</p> : null}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {actions}
        {onClose ? (
          // Two shapes, because the close control is either an icon or a word. The
          // word stays a plain button: it already has a name of its own.
          closeText ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={textCloseLabel}
              className="rounded px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis"
            >
              {closeText}
            </button>
          ) : (
            <IconButton label={iconCloseLabel} onClick={onClose}>
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </IconButton>
          )
        ) : null}
      </div>
    </div>
  );
}

export interface DialogBodyProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/** Shared body section for dialogs and drawers (W10.5 / SHELL-43). */
export function DialogBody({ children, className }: DialogBodyProps): ReactNode {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto", className)}>{children}</div>;
}

export interface DialogFootProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/** Shared foot section for dialogs and drawers (W10.5 / SHELL-43). */
export function DialogFoot({ children, className }: DialogFootProps): ReactNode {
  return (
    <div className={cn("border-t border-border bg-surface-2/40 px-4 py-3", className)}>
      {children}
    </div>
  );
}

export interface DialogShellProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly ariaLabel?: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly containerClassName?: string;
}

/**
 * Centered modal dialog shell (W10.5 / SHELL-42 / SHELL-43).
 * Enforces modal backdrop scrim, focus trap, Escape key, and focus restore.
 */
export function DialogShell({
  open,
  onClose,
  ariaLabel,
  children,
  className,
  containerClassName,
}: DialogShellProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const layer = useOverlayDepth(open, "dialog", dialogRef);
  useDialogFocusTrap({ open, onClose, dialogRef });

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal={layer.ariaModal ? true : undefined}
      aria-label={ariaLabel}
      inert={layer.inert}
      style={layer.zIndex !== undefined ? { zIndex: layer.zIndex } : undefined}
      className={cn(
        "fixed inset-0 z-[70] flex items-center justify-center bg-scrim/80 p-4 backdrop-blur-sm sm:p-8",
        containerClassName,
      )}
      onClick={onClose}
    >
      <div
        className={cn(
          "flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export interface DrawerShellProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly ariaLabel?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * Side-docked drawer shell (W10.5 / SHELL-42 / SHELL-43).
 * Enforces drawer backdrop scrim, focus trap, Escape key, and focus restore.
 */
export function DrawerShell({
  open,
  onClose,
  ariaLabel,
  children,
  className,
}: DrawerShellProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const layer = useOverlayDepth(open, "drawer", dialogRef);
  useDialogFocusTrap({ open, onClose, dialogRef });

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal={layer.ariaModal ? true : undefined}
      aria-label={ariaLabel}
      inert={layer.inert}
      style={layer.zIndex !== undefined ? { zIndex: layer.zIndex } : undefined}
      className="fixed inset-0 z-50 flex justify-end"
    >
      <div className="absolute inset-0 bg-scrim/80 backdrop-blur-sm" onClick={onClose} />
      <div
        className={cn(
          "relative flex w-96 flex-col overflow-y-auto border-l border-border bg-surface p-4",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
