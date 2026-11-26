"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, DialogBody, DialogFoot, DialogHead, DialogShell, Input } from "@/components/ui";
import type { CreativeTemplateLayer } from "@campaignfoundry/CampaignOrchestration";
import type { AdvertisingUnit } from "@campaignfoundry/CampaignOrchestration/advertising-units";
import type { CreativeType } from "@campaignfoundry/CampaignOrchestration/creative-types";
import { saveTemplate, saveTemplateVersion } from "@/lib/templates-api";
import { creativeTypeDisplayName, unitDisplayName } from "./display-names";

/**
 * CFRW22C — the dialog behind the brief editor's "Save as template" action.
 *
 * The rail's button only asks for a name; everything this dialog does is one
 * write: `POST /campaigns/templates` for a new template, or `PUT
 * /campaigns/templates/:id` when the operator asks for a new version of a
 * template the org already owns (canonical templates are immutable, so they
 * never offer the version path). A refused save says so inline and keeps the
 * dialog open — the typed name and the version choice survive a retry, which is
 * the whole point of refusing inline rather than closing with an error.
 */

const TITLE = "Save as template";
const LEAD =
  "Saves this creative's look to the template library — a new template, or a new version of one you saved before.";
const NAME_LABEL = "Template name";
const NAME_PLACEHOLDER = "e.g. Summer promo";
const NAME_REQUIRED = "Name the template before saving.";
const VERSION_LABEL = "Save as new version";
const SAVE_LABEL = "Save template";
const CANCEL_LABEL = "Cancel";
const FALLBACK_ERROR = "Could not save template.";
const NO_LAYERS = "Add at least one layer before saving as a template.";
const UNSAVED_ERRORS = "Fix unsaved validation errors before saving as a template.";

/**
 * Why the editor's "Save as template" action is refused before the dialog even
 * opens — `null` means the action is available. The rail renders the reason
 * beside the disabled button, so the refusal is the same words in both places.
 */
export function saveTemplateBlockedReason(
  hasLayers: boolean,
  hasUnsavedErrors: boolean,
): string | null {
  if (!hasLayers) return NO_LAYERS;
  if (hasUnsavedErrors) return UNSAVED_ERRORS;
  return null;
}

export interface SaveTemplateDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The template's id — the PUT target when saving a new version of an owned org template. */
  readonly templateId: string;
  readonly unit: AdvertisingUnit;
  readonly creativeType: CreativeType;
  readonly layers: readonly CreativeTemplateLayer[];
  readonly isOwnedOrgTemplate: boolean;
  readonly onSaved?: () => void;
}

export function SaveTemplateDialog(props: SaveTemplateDialogProps): ReactNode {
  const { open, onClose, templateId, unit, creativeType, layers, isOwnedOrgTemplate, onSaved } =
    props;
  const [name, setName] = useState("");
  const [saveAsNewVersion, setSaveAsNewVersion] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A synchronous latch: `saving` is state, so it only disables the button after
  // a re-render. Two activations inside one render window (a double click) would
  // otherwise each reach the API. Same pattern as CreateCampaignDialog's
  // `createInFlightRef`.
  const inFlightRef = useRef(false);

  // A closed dialog leaves nothing behind: the typed name, the version toggle
  // and any refusal are dropped on every open/close transition, so a reopened
  // dialog is pristine whatever the last attempt did.
  useEffect(() => {
    setName("");
    setSaveAsNewVersion(false);
    setError(null);
  }, [open]);

  const handleSubmit = () => {
    if (inFlightRef.current) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(NAME_REQUIRED);
      return;
    }
    if (layers.length === 0) {
      setError(NO_LAYERS);
      return;
    }
    inFlightRef.current = true;
    setSaving(true);
    setError(null);
    const input = { name: trimmed, unit, creativeType, layers };
    const request =
      isOwnedOrgTemplate && saveAsNewVersion
        ? saveTemplateVersion(templateId, input)
        : saveTemplate(input);
    request
      .then(() => {
        // TemplateLibrary listens for this while it is open, so a save from the
        // editor is visible in the library without a close and a reopen.
        window.dispatchEvent(new CustomEvent("cf:templates-changed"));
        onSaved?.();
        setName("");
        setSaveAsNewVersion(false);
        setError(null);
        onClose();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : FALLBACK_ERROR);
      })
      .finally(() => {
        setSaving(false);
        inFlightRef.current = false;
      });
  };

  return (
    <DialogShell open={open} onClose={onClose} ariaLabel={TITLE} className="max-w-md">
      <DialogHead title={TITLE} description={LEAD} onClose={onClose} />
      <DialogBody className="space-y-4 px-4 py-4">
        <p className="text-[11px] text-text-muted">
          {creativeTypeDisplayName(creativeType)} · {unitDisplayName(unit)}
        </p>
        <label className="block">
          <span className="mb-1.5 block text-[11px] text-text-muted">{NAME_LABEL}</span>
          <Input
            aria-label={NAME_LABEL}
            value={name}
            placeholder={NAME_PLACEHOLDER}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </label>
        {/* Only an owned org template has a version history to append to: a
            canonical template is immutable, so the toggle does not exist there
            and the submit is always the POST. */}
        {isOwnedOrgTemplate ? (
          <label className="flex items-center gap-2 text-[12px] text-text-primary">
            <input
              type="checkbox"
              className="size-4 rounded border-border-control"
              checked={saveAsNewVersion}
              onChange={(e) => setSaveAsNewVersion(e.target.checked)}
            />
            {VERSION_LABEL}
          </label>
        ) : null}
      </DialogBody>
      <DialogFoot>
        <div className="space-y-3">
          <p role="status" className="text-[12px] text-error">
            {error ?? ""}
          </p>
          <div className="flex gap-2">
            <Button onClick={handleSubmit} disabled={saving}>
              {SAVE_LABEL}
            </Button>
            <Button variant="ghost" disabled={saving} onClick={onClose}>
              {CANCEL_LABEL}
            </Button>
          </div>
        </div>
      </DialogFoot>
    </DialogShell>
  );
}
