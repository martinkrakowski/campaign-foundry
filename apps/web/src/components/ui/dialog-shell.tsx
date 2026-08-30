"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";

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
    container.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]'),
  ).filter(isFocusableCandidate);
}

function isFocusableCandidate(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) return false;
  if (element.getAttribute("tabindex") === "-1") return false;
  if (element.closest("[hidden]")) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
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

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

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
      previouslyFocused?.focus?.();
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
  const resolvedCloseLabel = closeLabel ?? (closeText ? undefined : "Close");

  return (
    <div className={cn("flex items-start justify-between gap-3 border-b border-border px-4 py-3", className)}>
      <div>
        <Heading className="text-sm font-semibold text-text-emphasis">{title}</Heading>
        {description ? <p className="mt-0.5 text-[11px] text-text-muted">{description}</p> : null}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {actions}
        {onClose ? (
          closeText ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={resolvedCloseLabel}
              className="rounded px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis"
            >
              {closeText}
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              aria-label={resolvedCloseLabel}
              className="shrink-0 text-text-muted transition-colors hover:text-text-emphasis"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
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
  return <div className={cn("border-t border-border bg-surface-2/40 px-4 py-3", className)}>{children}</div>;
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
  useDialogFocusTrap({ open, onClose, dialogRef });

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
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
  useDialogFocusTrap({ open, onClose, dialogRef });

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
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
