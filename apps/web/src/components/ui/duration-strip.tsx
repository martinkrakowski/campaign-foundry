import { useId, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { MIN_DURATION_SEC, MAX_DURATION_SEC } from "@campaignfoundry/CampaignOrchestration/variation-defaults";

export { MIN_DURATION_SEC, MAX_DURATION_SEC };

export interface DurationStripProps {
  /** The duration values in seconds currently selected. */
  readonly values: readonly number[];
  readonly onChange?: (index: number, value: number) => void;
  readonly onAdd?: (value: number) => void;
  readonly onRemove?: (index: number) => void;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  /** Slot for timeline lanes (e.g. the copy timeline ruler). */
  readonly lanes?: ReactNode;
  readonly error?: string;
  readonly className?: string;
}

const TOTAL_SECONDS = 30;
const TICK_LABELS = [2, 5, 10, 15, 20, 25, 30] as const;

/**
 * Finds the closest available whole second in [MIN_DURATION_SEC, MAX_DURATION_SEC] (2..30)
 * that is not already taken in `values` (excluding `values[currentIndex]`).
 */
export function slideToFree(
  values: readonly number[],
  target: number,
  currentIndex?: number,
): number {
  const taken = new Set(
    values
      .filter((_, i) => i !== currentIndex)
      .map((v) => Math.round(v)),
  );
  const rounded = Math.max(MIN_DURATION_SEC, Math.min(MAX_DURATION_SEC, Math.round(target)));
  if (!taken.has(rounded)) return rounded;

  for (let step = 1; step <= MAX_DURATION_SEC; step += 1) {
    const higher = rounded + step;
    if (higher <= MAX_DURATION_SEC && !taken.has(higher)) return higher;
    const lower = rounded - step;
    if (lower >= MIN_DURATION_SEC && !taken.has(lower)) return lower;
  }
  return rounded;
}

/**
 * Computes the 0..30 second position from a clientX coordinate relative to a rect.
 */
export function secondsAtClientX(
  clientX: number,
  rect: DOMRect | { left: number; width: number },
): number {
  if (rect.width <= 0) return 0;
  const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return Math.round(fraction * TOTAL_SECONDS);
}

/**
 * Maps keyboard navigation keys to target seconds.
 */
export function keyToTarget(key: string, currentValue: number): number | undefined {
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return currentValue - 1;
    case "ArrowRight":
    case "ArrowUp":
      return currentValue + 1;
    case "PageDown":
      return currentValue - 5;
    case "PageUp":
      return currentValue + 5;
    case "Home":
      return MIN_DURATION_SEC;
    case "End":
      return MAX_DURATION_SEC;
    default:
      return undefined;
  }
}

/**
 * Film strip duration picker on a 0-based 31-column time axis (D10 / U7).
 *
 * - Columns 0..1 (0..2s) are hatched lead-in since minimum duration is 2 s.
 * - Each bead represents one duration, positioned precisely at its second mark.
 * - Loaded fractional or out-of-range values (e.g. 45 or 2.5) are clamp-placed
 *   without producing invalid grid-column properties, but retain their raw label and error border.
 * - Accessible as `role="slider"` with stable names ("Duration N (seconds)").
 * - Interactive: drag/click snaps to available whole seconds via `slideToFree`.
 * - Keyboard support: arrows ±1, PgUp/PgDn ±5, Home/End, Delete/Backspace removes.
 * - The last Remove stays enabled (an empty axis is legal).
 * - Houses the `lanes` slot for the copy timeline (D11).
 */
export function DurationStrip({
  values,
  onChange,
  onAdd,
  onRemove,
  readOnly = false,
  disabled = false,
  lanes,
  error,
  className,
}: DurationStripProps): ReactNode {
  const stripRef = useRef<HTMLDivElement>(null);
  const describedById = useId();

  const handleStripClick = (e: MouseEvent<HTMLDivElement>) => {
    if (readOnly || disabled || !onAdd || !stripRef.current) return;
    // Only handle direct clicks on track, not clicks inside duration beads
    if ((e.target as HTMLElement).closest("[role='slider'], button")) return;
    const rect = stripRef.current.getBoundingClientRect();
    const clickedSec = secondsAtClientX(e.clientX, rect);
    const target = Math.max(MIN_DURATION_SEC, clickedSec);
    const nextFree = slideToFree(values, target);
    onAdd(nextFree);
  };

  const handleKeyDown = (e: KeyboardEvent, index: number, currentValue: number) => {
    if (readOnly || disabled) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove?.(index);
      return;
    }
    const target = keyToTarget(e.key, currentValue);
    if (target !== undefined) {
      e.preventDefault();
      const next = slideToFree(values, target, index);
      onChange?.(index, next);
    }
  };

  const handlePointerDown = (e: React.PointerEvent, index: number) => {
    if (readOnly || disabled || !onChange || !stripRef.current) return;
    e.stopPropagation();
    const targetEl = e.currentTarget as HTMLElement;
    targetEl.setPointerCapture(e.pointerId);

    const onPointerMove = (moveEv: PointerEvent) => {
      if (!stripRef.current) return;
      const rect = stripRef.current.getBoundingClientRect();
      const sec = secondsAtClientX(moveEv.clientX, rect);
      const next = slideToFree(values, sec, index);
      onChange(index, next);
    };

    const onPointerUp = (_upEv: PointerEvent) => {
      targetEl.removeEventListener("pointermove", onPointerMove);
      targetEl.removeEventListener("pointerup", onPointerUp);
      targetEl.removeEventListener("pointercancel", onPointerUp);
    };

    targetEl.addEventListener("pointermove", onPointerMove);
    targetEl.addEventListener("pointerup", onPointerUp);
    targetEl.addEventListener("pointercancel", onPointerUp);
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div
        ref={stripRef}
        onClick={handleStripClick}
        className={cn(
          "relative select-none rounded-lg border border-border bg-surface p-3 transition-colors",
          !readOnly && !disabled && "cursor-pointer hover:border-border-hover",
          disabled && "cursor-not-allowed opacity-50",
          error && "border-error",
        )}
      >
        {/* Sprocket holes along top and bottom */}
        <div className="mb-2 flex justify-between px-1" aria-hidden="true">
          {Array.from({ length: 16 }).map((_, i) => (
            <span key={i} className="size-1.5 rounded-sm bg-surface-2 border border-border" />
          ))}
        </div>

        {/* 31-column grid ruler for 0..30 seconds */}
        <div
          className="relative grid h-10 w-full items-center gap-0"
          style={{ gridTemplateColumns: "repeat(31, minmax(0, 1fr))" }}
        >
          {/* Hatched lead-in area (0..2s, columns 1 to 2) */}
          <div
            className="absolute inset-y-0 rounded-l border-r border-border/50 bg-[repeating-linear-gradient(45deg,var(--color-surface-2),var(--color-surface-2)_4px,transparent_4px,transparent_8px)] opacity-60"
            style={{ gridColumn: "1 / 3" }}
            aria-hidden="true"
          />

          {/* Active duration reel fills from column 1 to each duration */}
          {values.map((val, i) => {
            const clamped = Math.max(0, Math.min(TOTAL_SECONDS, Math.round(val)));
            if (clamped <= 0) return null;
            return (
              <div
                key={`reel-${i}`}
                className="pointer-events-none absolute inset-y-2 rounded-l bg-brand-primary/20 border-r-2 border-brand-primary"
                style={{ gridColumn: `1 / ${clamped + 1}` }}
                aria-hidden="true"
              />
            );
          })}

          {/* Second grid lines / ticks */}
          {Array.from({ length: 31 }).map((_, sec) => (
            <div
              key={sec}
              className={cn(
                "h-full border-r border-border/30",
                sec < MIN_DURATION_SEC && "border-border/10",
                TICK_LABELS.includes(sec as (typeof TICK_LABELS)[number]) && "border-border/70",
              )}
              aria-hidden="true"
            />
          ))}

          {/* Interactive duration beads / chips */}
          {values.map((seconds, index) => {
            const clamped = Math.max(0, Math.min(TOTAL_SECONDS, Math.round(seconds)));
            const isValid =
              Number.isInteger(seconds) && seconds >= MIN_DURATION_SEC && seconds <= MAX_DURATION_SEC;
            // 1-based gridColumn placement for clamped second
            const gridCol = Math.max(1, Math.min(31, clamped + 1));

            return (
              <div
                key={`bead-${index}`}
                role="slider"
                tabIndex={readOnly || disabled ? -1 : 0}
                aria-label={`Duration ${index + 1} (seconds)`}
                aria-valuenow={seconds}
                aria-valuemin={MIN_DURATION_SEC}
                aria-valuemax={MAX_DURATION_SEC}
                aria-valuetext={`${seconds} seconds`}
                onKeyDown={(e) => handleKeyDown(e, index, clamped)}
                onPointerDown={(e) => handlePointerDown(e, index)}
                style={{ gridColumn: `${gridCol} / ${gridCol + 1}` }}
                className={cn(
                  "relative z-10 -ml-5 flex h-7 items-center justify-center gap-1 rounded-full border px-2 shadow-sm transition-transform",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
                  isValid
                    ? "border-brand-primary bg-brand-primary text-white"
                    : "border-error bg-surface text-error",
                  !readOnly && !disabled && "cursor-grab active:cursor-grabbing hover:scale-105",
                )}
              >
                <span className="font-mono text-[11px] font-semibold tracking-tight whitespace-nowrap">
                  {seconds} s
                </span>
                {!readOnly && onRemove && (
                  <button
                    type="button"
                    aria-label={`Remove duration ${seconds} s`}
                    tabIndex={-1}
                    disabled={disabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(index);
                    }}
                    className="ml-0.5 rounded-full p-0.5 opacity-80 hover:opacity-100 focus:outline-none"
                  >
                    <svg viewBox="0 0 10 10" focusable="false" aria-hidden="true" className="size-2.5">
                      <path
                        d="M2 2 L8 8 M8 2 L2 8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Sprocket holes along bottom */}
        <div className="mt-2 flex justify-between px-1" aria-hidden="true">
          {Array.from({ length: 16 }).map((_, i) => (
            <span key={i} className="size-1.5 rounded-sm bg-surface-2 border border-border" />
          ))}
        </div>

        {/* Tick labels */}
        <div
          className="mt-1 grid w-full font-mono text-[10px] text-text-muted"
          style={{ gridTemplateColumns: "repeat(31, minmax(0, 1fr))" }}
          aria-hidden="true"
        >
          {TICK_LABELS.map((tick) => (
            <span
              key={tick}
              style={{ gridColumn: `${tick + 1} / ${tick + 2}` }}
              className="-ml-2 text-center"
            >
              {tick}
            </span>
          ))}
        </div>
      </div>

      {/* Copy timeline ruler / lanes slot (D11 / L6) */}
      {lanes ? <div className="mt-2">{lanes}</div> : null}

      {error ? (
        <p id={describedById} className="text-[11px] text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
