"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DialogShell, DialogHead, DialogBody, DialogFoot } from "@/components/ui/dialog-shell";
import * as messages from "@/components/campaign/messages";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title?: string;
  readonly message?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/**
 * Focus-trapped confirmation dialog (W10.3 / SHELL-35).
 * Replaces window.confirm for dirty state interception and critical user actions.
 * Follows the dialog contract: focus trap, Escape closes, scrim click closes, focus restored on close.
 */
export function ConfirmDialog({
  open,
  title = messages.confirmDialogTitle,
  message = messages.statusLeavePrompt,
  confirmLabel = messages.confirmDialogLeave,
  cancelLabel = messages.confirmDialogStay,
  onConfirm,
  onClose,
}: ConfirmDialogProps): ReactNode {
  return (
    <DialogShell
      open={open}
      onClose={onClose}
      ariaLabel={title}
      containerClassName="z-[80]"
      className="max-w-md"
    >
      <DialogHead title={title} onClose={onClose} />
      <DialogBody className="p-4">
        <p className="text-[13px] text-text-muted">{message}</p>
      </DialogBody>
      <DialogFoot className="flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onClose}
        >
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </DialogFoot>
    </DialogShell>
  );
}
