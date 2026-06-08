"use client";

import { useEffect, useRef, useState } from "react";
import { useRun } from "@/lib/run-context";
import { MODELS, labelFor } from "@/lib/models";
import { cn } from "@/lib/cn";

/** Header control: shows the active image model and opens a modal to switch it. */
export function ModelSelector() {
  const { selectedModel, setSelectedModel, brief } = useRun();
  const [open, setOpen] = useState(false);

  // A product with `inputAsset` reuses that image and skips the selected model for
  // that product — but only when the asset resolves and is readable server-side;
  // otherwise it falls back to generation. The UI can't know that outcome ahead of a
  // run, so this flags the *possibility* (and the wording below says "may"), letting
  // the reviewer notice the model choice could be overridden.
  const hasInputAssets = brief.products.some((p) => Boolean(p.inputAsset));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title="Change image model"
        className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1 font-mono text-[11px] text-text-primary transition-colors hover:border-border-hover"
      >
        <span className="text-brand-primary" aria-hidden>◆</span>
        <span className="hidden text-text-muted sm:inline">Model:</span> {labelFor(selectedModel)}
      </button>
      {hasInputAssets && (
        <span
          tabIndex={0}
          role="note"
          aria-label="Reuse brief: a product sets inputAsset, so the selected image model may be skipped for it. A missing or unreadable asset falls back to model generation."
          title="This brief sets inputAsset on a product. When that image resolves, it's reused and the selected model is skipped for that product; a missing or unreadable asset falls back to model generation."
          className="hidden cursor-default items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-1 font-mono text-[10px] text-warning outline-none focus-visible:ring-2 focus-visible:ring-warning sm:inline-flex"
        >
          <span aria-hidden>↻</span> reuse brief · model may be skipped
        </span>
      )}
      {open && (
        <ModelModal
          selected={selectedModel}
          onSelect={(id) => {
            setSelectedModel(id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Model picker. Closes on backdrop click, the × button, or Escape; traps focus. */
function ModelModal({
  selected,
  onSelect,
  onClose,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
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
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Select image model"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-white">Image model</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-text-muted transition-colors hover:text-white"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[60vh] divide-y divide-border overflow-y-auto">
          {MODELS.map((model, i) => {
            const active = model.id === selected;
            return (
              <button
                key={model.id ?? "auto"}
                ref={i === 0 ? firstRef : undefined}
                type="button"
                onClick={() => onSelect(model.id)}
                aria-pressed={active}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2",
                  active && "bg-surface-2",
                )}
              >
                <span className="flex flex-col">
                  <span className="text-[13px] text-text-primary">{model.label}</span>
                  <span className="font-mono text-[10px] text-text-muted">{model.provider}</span>
                </span>
                {active && (
                  <span className="text-brand-primary" aria-hidden>
                    ●
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <p className="border-t border-border px-4 py-2 font-mono text-[10px] text-text-muted">
          Selected model is the primary; the pipeline falls back automatically if it's unavailable.
        </p>
      </div>
    </div>
  );
}
