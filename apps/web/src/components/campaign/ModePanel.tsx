import type { ReactNode } from "react";
import {
  OptionTile,
  PosterFrame,
  PreviewPanel,
  type PosterVariant,
  type RatioOption,
} from "@/components/ui";
import { modeDisplayName } from "@/components/campaign/display-names";
import { MODE_OPTIONS, type CampaignMode } from "@/components/campaign/editor-state";
import * as messages from "@/components/campaign/messages";

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

/** The preview pictures' long side; six of them stack two rows high inside the 132px panel. */
const PREVIEW_SIZE = 56;

/**
 * One cell of the 3×2. `PosterFrame` sizes by its long side, so a `16:9` miniature
 * is `PREVIEW_SIZE` wide and overflows a ~46 px column on a 360 px viewport.
 * `max-w-full` on the wrapper (and on the svg) scales the frame to the cell —
 * not a smaller `PREVIEW_SIZE` at a breakpoint, and not an overflow-x scroller.
 */
function FrameCell({ ratio, variant }: { ratio: RatioOption; variant: PosterVariant }): ReactNode {
  return (
    <div className="min-w-0 max-w-full [&>svg]:h-auto [&>svg]:max-w-full">
      <PosterFrame ratio={ratio} variant={variant} size={PREVIEW_SIZE} />
    </div>
  );
}

/**
 * Classic's picture (F1/D93): the same poster six times — one design, repeated —
 * in a tidy three-by-two of `PosterFrame`s on the panel's own ground.
 */
function ClassicPreview(): ReactNode {
  return (
    <PreviewPanel caption={messages.modeTileCaptionBrief}>
      <div className="grid grid-cols-3 items-center justify-items-center gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <FrameCell key={index} ratio="9:16" variant="pA" />
        ))}
      </div>
    </PreviewPanel>
  );
}

/** Union-keyed so a fourth ratio or variant is a compile error, not a blank frame. */
const VARIATION_FRAMES: readonly { readonly ratio: RatioOption; readonly variant: PosterVariant }[] = [
  { ratio: "9:16", variant: "pA" },
  { ratio: "1:1", variant: "pB" },
  { ratio: "16:9", variant: "pC" },
  { ratio: "9:16", variant: "pB" },
  { ratio: "1:1", variant: "pC" },
  { ratio: "16:9", variant: "pA" },
];

/**
 * Randomized's picture (F1/D93): a set of variations — six `PosterFrame`s cycling
 * the three layout variants across the domain's ratios, no two rows alike.
 */
function RandomizedPreview(): ReactNode {
  return (
    <PreviewPanel caption={messages.modeTileCaptionVariation}>
      <div className="grid grid-cols-3 items-center justify-items-center gap-2">
        {VARIATION_FRAMES.map((frame, index) => (
          <FrameCell key={index} ratio={frame.ratio} variant={frame.variant} />
        ))}
      </div>
    </PreviewPanel>
  );
}

/** The full tile's body copy, keyed by the mode union so a new mode is a compile error. */
const MODE_TILE_EXTRAS: Record<CampaignMode, { tag: string; blurb: string; preview: ReactNode }> = {
  brief: {
    tag: messages.modeTileTagBrief,
    blurb: messages.modeTileBlurbBrief,
    preview: <ClassicPreview />,
  },
  variation: {
    tag: messages.modeTileTagVariation,
    blurb: messages.modeTileBlurbVariation,
    preview: <RandomizedPreview />,
  },
};

/**
 * The mode switch as two pictures at the top of the sidebar (D4/U1): an OptionTile per
 * mode, its raw value (`brief` / `variation`) the visible name and the whole accessible
 * name, and its muted caption (`meta`) reading Classic / Randomized. Switching mode
 * stays non-destructive (D10) — the tiles only dispatch `setMode`, exactly as the
 * header buttons they replace did.
 *
 * In the dialog the tile is the full three-part form (F1/D93): a `PreviewPanel` holding
 * the mode's picture edge to edge, then glyph, name, tag, blurb and meta. The
 * `compact` prop is the `SectionShell` idiom for the editor's 320px sidebar, where a
 * 132px panel cannot fit a ~150px tile: there the tile keeps today's glyph-only look.
 */
export function ModePanel({
  mode,
  onSetMode,
  compact = false,
  formatDropped = false,
}: {
  mode: CampaignMode;
  onSetMode: (mode: CampaignMode) => void;
  /** The sidebar form: no preview panel, no tag, no blurb — the glyph carries the tile. */
  compact?: boolean;
  /** True while Classic still holds the Video format the run paths refuse (D99) — said here, where the mode control lives. Derived by the caller from `mode === "brief" && formats.includes("motion")`. */
  formatDropped?: boolean;
}): ReactNode {
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-2">
        {MODE_OPTIONS.map((option) => (
          <OptionTile
            key={option}
            value={option}
            name={option}
            meta={modeDisplayName(option)}
            selected={mode === option}
            onToggle={(value) => onSetMode(value as CampaignMode)}
            {...(compact
              ? {}
              : {
                  preview: MODE_TILE_EXTRAS[option].preview,
                  tag: MODE_TILE_EXTRAS[option].tag,
                  blurb: MODE_TILE_EXTRAS[option].blurb,
                })}
          >
            <ModeGlyph scattered={option === "variation"} />
          </OptionTile>
        ))}
      </div>
      {/* D99: the drop is not silent. Muted, like the clamp notice — the flip
          succeeded; the sentence says what it cost and how to undo it. */}
      {formatDropped ? (
        <p role="status" className="text-[11px] text-text-muted">
          {messages.modeDroppedVideo}
        </p>
      ) : null}
    </div>
  );
}
