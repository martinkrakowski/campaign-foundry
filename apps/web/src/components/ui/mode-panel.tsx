import type { ReactNode } from "react";
import { AxisCard } from "./axis-card";
import { modeDisplayName } from "@/components/campaign/display-names";
import { MODE_OPTIONS, type CampaignMode } from "@/components/campaign/editor-state";

/** One miniature of the grid: the CreativeGlyph layer idiom at cell scale. */
interface CellSpec {
  /** Which edge carries the shade, the band and the text (layout). */
  readonly top: boolean;
  /** Text weight — the bar thickness (tone). */
  readonly bold: boolean;
  /** The accent band's token class (tint). */
  readonly band: string;
  /** The photo ground's token class (tint). */
  readonly ground: string;
}

const TIDY_CELL: CellSpec = { top: true, bold: true, band: "fill-brand-primary", ground: "fill-text-muted" };

/** Classic: near-identical miniatures — one design, repeated. */
const TIDY: readonly CellSpec[] = [TIDY_CELL, TIDY_CELL, TIDY_CELL, TIDY_CELL, TIDY_CELL, TIDY_CELL];

/** Randomized: the same six cells with different edges, weights and tints. */
const SCATTERED: readonly CellSpec[] = [
  { top: true, bold: true, band: "fill-brand-primary", ground: "fill-text-muted" },
  { top: false, bold: false, band: "fill-brand-secondary", ground: "fill-text-secondary" },
  { top: true, bold: false, band: "fill-brand-primary", ground: "fill-text-secondary" },
  { top: false, bold: true, band: "fill-brand-secondary", ground: "fill-text-muted" },
  { top: true, bold: true, band: "fill-brand-primary", ground: "fill-text-secondary" },
  { top: false, bold: false, band: "fill-brand-primary", ground: "fill-text-muted" },
];

const VIEWBOX = 46;
const CELL = 13;
const GAP = 2;
const MARGIN = 1.5;

/**
 * The mode's picture (D4): a 2×3 grid of creative miniatures — tidy and near-identical
 * for Classic, scattered across edges, weights and tints for Randomized. Drawn with
 * the same layer idiom as `CreativeGlyph` (photo ground → contrast shade on the
 * headline edge → accent band → text bar), in theme tokens, wholly `aria-hidden`:
 * the card's label carries the meaning, never the picture.
 */
function ModeGlyph({ scattered }: { scattered: boolean }): ReactNode {
  const cells = scattered ? SCATTERED : TIDY;
  return (
    <svg width={VIEWBOX} height={VIEWBOX} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} aria-hidden="true" focusable="false">
      {cells.map((cell, index) => {
        const x = MARGIN + (index % 3) * (CELL + GAP);
        const y = MARGIN + Math.floor(index / 3) * (CELL + GAP);
        // Deliberately literal black, like CreativeGlyph's shade: the compositor
        // darkens the headline edge with rgba(0, 0, 0, α) in every theme.
        const shadeHeight = CELL / 2;
        const barHeight = cell.bold ? 2 : 1;
        return (
          <g key={index}>
            {/* Layer 1 — photo ground. */}
            <rect x={x} y={y} width={CELL} height={CELL} className={cell.ground} />
            {/* Layer 2 — contrast shade on the headline edge. */}
            <rect
              x={x}
              y={cell.top ? y : y + shadeHeight}
              width={CELL}
              height={shadeHeight}
              fill="#000000"
              fillOpacity={cell.bold ? 0.5 : 0.25}
            />
            {/* Layer 3 — accent band flush to the headline edge. */}
            <rect
              x={x}
              y={cell.top ? y : y + CELL - 1.5}
              width={CELL}
              height={1.5}
              className={cell.band}
            />
            {/* Layer 4 — the message as one bar; tone sets its weight. */}
            <rect
              x={x + 3}
              y={cell.top ? y + 3 : y + CELL - 3 - barHeight}
              width={CELL - 6}
              height={barHeight}
              className="fill-text-primary"
            />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The mode switch as two pictures at the top of the sidebar (D4/U1): an AxisCard per
 * mode, its raw value (`brief` / `variation`) the whole accessible name and its caption
 * reading Classic / Randomized. Switching mode stays non-destructive (D10) — the
 * cards only dispatch `setMode`, exactly as the header buttons they replace did.
 */
export function ModePanel({
  mode,
  onSetMode,
}: {
  mode: CampaignMode;
  onSetMode: (mode: CampaignMode) => void;
}): ReactNode {
  return (
    <div className="grid grid-cols-2 gap-2">
      {MODE_OPTIONS.map((option) => (
        <AxisCard
          key={option}
          value={option}
          selected={mode === option}
          onToggle={(value) => onSetMode(value as CampaignMode)}
          meta={modeDisplayName(option)}
        >
          <ModeGlyph scattered={option === "variation"} />
        </AxisCard>
      ))}
    </div>
  );
}
