import { normalizeHueTurns } from "@campaignfoundry/CampaignOrchestration/palette-shift";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

const HEX_PATTERN = /^#([0-9a-f]{6})$/i;

/**
 * A client-side hue rotation of a hex colour by `shift` × 360° — preview-only, so the
 * chips can show what each palette-shift option does to the first product's colour
 * without shipping a colour library. The brief itself keeps the raw shift values.
 */
export function hueShiftHex(hex: string, shift: number): string {
  const match = HEX_PATTERN.exec(hex);
  if (match === null) return hex;
  const numeric = Number.parseInt(match[1], 16);
  const r = ((numeric >> 16) & 255) / 255;
  const g = ((numeric >> 8) & 255) / 255;
  const b = (numeric & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let saturation = 0;
  if (delta !== 0) {
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
  }
  // The compositor's own wrap, imported rather than restated. This line used to read
  // `(hue + shift) % 1`, which leaves a negative shift negative — so the chip previewed a
  // colour the pipeline would never render.
  hue = normalizeHueTurns(hue + shift);
  // HSL → RGB (the standard piecewise conversion).
  const channel = (n: number): number => {
    const k = (n + hue * 12) % 12;
    const a = saturation * Math.min(lightness, 1 - lightness);
    return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to255 = (value: number): number => Math.round(value * 255);
  const rgb = [to255(channel(0)), to255(channel(8)), to255(channel(4))] as const;
  return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export interface SwatchChipProps {
  /** The raw palette-shift value — also the chip's accessible name, verbatim. */
  readonly value: number;
  readonly selected: boolean;
  /** The hex colour the swatch derives from — the first product's primary colour. */
  readonly baseColor: string;
  readonly onToggle: (value: number) => void;
}

/**
 * A toggle chip for one palette-shift value, its fill the base colour hue-shifted by
 * that value — the shift stops being a bare number and shows its effect (D6/M5).
 * The swatch and the value are `aria-hidden`; the accessible name is the raw value.
 */
export function SwatchChip({ value, selected, baseColor, onToggle }: SwatchChipProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={String(value)}
      aria-pressed={selected}
      onClick={() => onToggle(value)}
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-1.5 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
        selected ? "border-brand-primary bg-surface-2 text-text-emphasis" : "border-border-control text-text-muted",
      )}
    >
      <span
        aria-hidden="true"
        className="size-4 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: hueShiftHex(baseColor, value) }}
      />
      <span aria-hidden="true" className="font-mono text-[12px]">
        {value}
      </span>
    </button>
  );
}
