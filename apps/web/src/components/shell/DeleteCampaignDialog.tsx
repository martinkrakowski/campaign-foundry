"use client";

import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, DialogBody, DialogFoot, DialogHead, DialogShell, Input } from "@/components/ui";
import * as messages from "@/components/campaign/messages";
import {
  deleteCampaign,
  isBriefsApiError,
  unknownErrorMessage,
  type BriefEntry,
} from "@/lib/briefs-api";

export interface DeleteCampaignDialogProps {
  /** The listing entry being deleted. The dialog is open for as long as it is mounted. */
  readonly entry: BriefEntry;
  readonly onClose: () => void;
  /** The server accepted the delete (any 2xx). */
  readonly onDeleted: (entry: BriefEntry) => void;
  /** 404: the campaign is already gone, so the picker should drop its row. */
  readonly onGone: (entry: BriefEntry) => void;
}

/**
 * One message per status the delete route answers (D234, D235); everything else shows the
 * server's own message (a `NoMembershipError` is an `Error` too) or the generic fallback.
 */
function failureMessage(err: unknown): string {
  if (isBriefsApiError(err)) {
    if (err.status === 409) return messages.deleteCampaignRunInProgress;
    if (err.status === 403) return messages.deleteCampaignForbidden;
    if (err.status === 404) return messages.deleteCampaignGone;
    if (err.status === 501) return messages.deleteCampaignUnsupported;
  }
  return unknownErrorMessage(err, messages.deleteCampaignFailed);
}

/**
 * Typed-name confirmation for deleting a campaign (PT-9p). Mounted only while a delete is
 * being confirmed, so its state (typed text, error, pending) is fresh on every open and
 * the trap's focus restore runs when it unmounts. It must be a SIBLING of the picker's
 * `DialogShell`, never a child: D84 makes every overlay but the newest `inert`.
 * Focus lands on the head's Close control (first focusable); the destructive button is
 * last and disabled until the typed text equals the campaign's slug exactly.
 */
export function DeleteCampaignDialog({
  entry,
  onClose,
  onDeleted,
  onGone,
}: DeleteCampaignDialogProps): ReactNode {
  const slug = entry.brief.id;
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // A synchronous latch (the mscyu pattern): `pending` is state, so two submissions
  // inside one render window both reach `submit` before the button disables.
  const pendingRef = useRef(false);
  const warningId = useId();
  const fieldId = useId();
  const matches = typed === slug;

  const close = () => {
    if (pendingRef.current) return;
    onClose();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!matches || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    void (async () => {
      try {
        await deleteCampaign(entry.campaignId ?? slug);
      } catch (err) {
        setError(failureMessage(err));
        if (isBriefsApiError(err) && err.status === 404) onGone(entry);
        pendingRef.current = false;
        setPending(false);
        return;
      }
      onDeleted(entry);
    })();
  };

  return (
    <DialogShell open onClose={close} ariaLabel={messages.deleteCampaignTitle} className="max-w-md">
      <DialogHead title={messages.deleteCampaignTitle} onClose={close} />
      <form onSubmit={submit}>
        <DialogBody className="space-y-3 p-4">
          <p id={warningId} className="text-[13px] text-text-primary">
            {messages.deleteCampaignWarning(slug)}
          </p>
          <label htmlFor={fieldId} className="block text-[12px] text-text-muted">
            {messages.deleteCampaignTypeLabel(slug)}
          </label>
          <Input
            id={fieldId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            readOnly={pending}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={warningId}
          />
          {error ? (
            <p role="alert" className="text-[13px] text-error">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFoot className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={close} disabled={pending}>
            {messages.confirmCancel}
          </Button>
          <Button type="submit" variant="destructive" size="sm" disabled={!matches || pending}>
            {pending ? messages.deleteCampaignPending : messages.deleteCampaignConfirm}
          </Button>
        </DialogFoot>
      </form>
    </DialogShell>
  );
}
