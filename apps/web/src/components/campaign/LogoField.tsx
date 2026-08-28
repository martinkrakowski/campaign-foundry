"use client";

import { useId, type ChangeEvent, type ReactNode } from "react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import * as messages from "@/components/campaign/messages";

export interface LogoFieldProps {
  /** The current logo path (e.g. "assets/inputs/camp/hydra-logo.png"). */
  readonly value: string;
  /** Optional resolved thumbnail data URL or preview URL (e.g. from L5 asset store or local upload). */
  readonly thumbnailUrl?: string;
  /** Callback when logo path changes. */
  readonly onChange: (path: string) => void;
  /** Callback when a local file is picked for upload. */
  readonly onUploadFile: (file: File) => Promise<void> | void;
  /**
   * Optional affordance to choose from the campaign's project bin (D14 / L5 seam).
   * Rendered ONLY when this handler is provided; left unrendered otherwise.
   */
  readonly onChooseFromBin?: () => void;
  /** Whether a logo upload is currently in progress. */
  readonly uploading?: boolean;
  /** Optional error message to display. */
  readonly error?: string;
  readonly invalid?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
}

/**
 * Brand asset upload control that renders as a dashed tile when unset and transitions
 * to an image thumbnail or filename badge once set (D12 / L3.4).
 *
 * Displays the asset path as 10px monospace metadata and houses the Upload action.
 * The Choose from bin action renders only when wired via `onChooseFromBin`.
 */
export function LogoField({
  value,
  thumbnailUrl,
  onChange,
  onUploadFile,
  onChooseFromBin,
  uploading = false,
  error,
  invalid = false,
  disabled = false,
  readOnly = false,
}: LogoFieldProps): ReactNode {
  const instanceId = useId();
  const inputId = `logo-upload-input-${instanceId}`;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void onUploadFile(file);
    }
    e.target.value = "";
  };

  const hasLogo = value.trim().length > 0;
  // A direct URL (data:, blob:, http:, https:) or an explicit thumbnailUrl resolves
  // directly in the browser; raw filesystem paths (assets/inputs/...) have no route
  // serving them yet, so degrade honestly to a file-type badge rather than a broken <img>.
  const imageSrc =
    thumbnailUrl ||
    (value.startsWith("data:") ||
    value.startsWith("blob:") ||
    value.startsWith("http://") ||
    value.startsWith("https://")
      ? value
      : undefined);

  const extMatch = value.match(/\.([a-zA-Z0-9]+)$/);
  const fileExt = extMatch ? extMatch[1].toUpperCase() : "IMG";

  return (
    <div className="space-y-1.5">
      <input
        type="file"
        id={inputId}
        accept="image/png,image/jpeg"
        className="hidden"
        aria-label={messages.logoUploadAria}
        disabled={disabled || readOnly || uploading}
        onChange={handleFileChange}
      />
      <input
        type="text"
        aria-label={messages.logoPathAria}
        className="sr-only"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        tabIndex={-1}
      />

      {hasLogo ? (
        <div
          className={cn(
            "flex items-center justify-between rounded-lg border bg-surface p-3 transition-colors",
            invalid ? "border-error" : "border-border",
          )}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-10 shrink-0 overflow-hidden rounded border border-border bg-surface-2/60 p-1 flex items-center justify-center">
              {imageSrc ? (
                <img
                  src={imageSrc}
                  alt={messages.logoPreviewAlt}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-text-muted">
                  {fileExt}
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <span
                className="block font-mono text-[10px] text-text-muted truncate max-w-[200px] sm:max-w-xs"
                title={value}
              >
                {value}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => document.getElementById(inputId)?.click()}
              disabled={disabled || readOnly || uploading}
            >
              {uploading ? messages.logoUploading : messages.logoReplace}
            </Button>
            {onChooseFromBin ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={onChooseFromBin}
                disabled={disabled || readOnly || uploading}
              >
                {messages.logoChooseFromBin}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center transition-colors",
            invalid ? "border-error bg-error/5" : "border-border bg-surface-2/30 hover:border-border-hover",
          )}
        >
          <div className="flex items-center justify-center size-8 rounded-full bg-surface-2 text-text-muted" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="currentColor" className="size-4">
              <path
                fillRule="evenodd"
                d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <p className="text-[11px] text-text-muted">{messages.logoEmpty}</p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => document.getElementById(inputId)?.click()}
              disabled={disabled || readOnly || uploading}
            >
              {uploading ? messages.logoUploading : messages.logoUpload}
            </Button>
            {onChooseFromBin ? (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={onChooseFromBin}
                disabled={disabled || readOnly || uploading}
              >
                {messages.logoChooseFromBin}
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {error ? <span className="block text-[11px] text-error">{error}</span> : null}
    </div>
  );
}
