import type { ReactNode } from "react";

export interface JumpStripItem {
  /** The identity the caller jumps to — opaque here, a section key there. */
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

export interface JumpStripProps {
  readonly items: readonly JumpStripItem[];
  readonly onJump?: (key: string) => void;
}

/**
 * The footer strip of error chips that jump to the offending section (F6): the
 * markup extracted from the brief editor's `ErrorStrip` with the bucket→label
 * lookup lifted out to the caller. The kit knows chips, not sections — which
 * keys exist and what they read is the feature's vocabulary, spelled by the
 * caller (in `ErrorStrip`'s case by the one `SECTION_TITLES` map, never a `||`
 * fallback).
 */
export function JumpStrip({ items, onJump }: JumpStripProps): ReactNode {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onJump?.(item.key)}
          className="inline-flex items-center gap-1.5 rounded-full border border-error/50 bg-error/10 px-3 py-1 text-[11px] font-medium text-error transition-colors hover:bg-error/20"
        >
          <span>{item.label}</span>
          <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-error/30 px-1 text-[10px]">
            {item.count}
          </span>
        </button>
      ))}
    </div>
  );
}
