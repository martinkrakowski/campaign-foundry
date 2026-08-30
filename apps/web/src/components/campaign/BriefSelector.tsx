"use client";

import { useState, useCallback } from "react";
import { Input } from "@/components/ui";
import type { BriefEntry } from "@/lib/briefs-api";

/**
 * The filter field's placeholder and its accessible name are the same words: a
 * placeholder is a hint, not a name (DESIGN.md §7), so the label repeats them
 * instead of inventing a second string the two could then drift from.
 */
const FILTER_LABEL = "Search briefs...";

interface BriefSelectorProps {
  briefs: BriefEntry[];
  currentId: string | undefined;
  onSelect: (entry: BriefEntry) => void;
  onCreateNew: () => void;
}

export function BriefSelector({ briefs, currentId, onSelect, onCreateNew }: BriefSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filteredBriefs = briefs.filter((entry) =>
    entry.brief.id.toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = useCallback(
    (entry: BriefEntry) => {
      onSelect(entry);
      setOpen(false);
      setSearch("");
    },
    [onSelect]
  );

  const handleCreateNew = useCallback(() => {
    onCreateNew();
    setOpen(false);
    setSearch("");
  }, [onCreateNew]);

  const currentBrief = briefs.find((b) => b.brief.id === currentId);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-emphasis transition-colors hover:bg-surface-2"
      >
        <span className="font-mono text-[13px]">
          {currentBrief ? currentBrief.brief.id : "New brief..."}
        </span>
        <svg
          className={`h-4 w-4 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-surface shadow-2xl">
          <div className="border-b border-border p-2">
            <Input
              type="text"
              placeholder={FILTER_LABEL}
              aria-label={FILTER_LABEL}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 rounded-sm text-[13px]"
              autoFocus
            />
          </div>

          <div className="max-h-64 overflow-y-auto">
            <button
              type="button"
              onClick={handleCreateNew}
              className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-[13px] font-medium text-brand-primary transition-colors hover:bg-surface-2"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m-7-7h14" />
              </svg>
              New brief...
            </button>

            {filteredBriefs.map((entry) => (
              <button
                key={entry.brief.id}
                type="button"
                onClick={() => handleSelect(entry)}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-2 ${
                  entry.brief.id === currentId ? "text-text-emphasis" : "text-text-primary"
                }`}
              >
                <span className="font-mono">{entry.brief.id}</span>
                {entry.brief.id === currentId && (
                  <span className="text-[10px] text-text-muted">current</span>
                )}
              </button>
            ))}

            {filteredBriefs.length === 0 && search && (
              <p className="px-3 py-2 text-[12px] text-text-muted">No briefs found</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
