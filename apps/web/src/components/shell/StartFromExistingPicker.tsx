"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { listBriefs, type BriefEntry } from "@/lib/briefs-api";
import {
  OptionTile,
  PosterFrame,
  PreviewPanel,
  type PosterVariant,
  type RatioOption,
} from "@/components/ui";
import type { CampaignMode } from "@/components/campaign/editor-state";
import { modeDisplayName } from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";

/** What a chosen row hands the dialog: the source's id and the mode its copy inherits. */
export interface StartFromSource {
  readonly id: string;
  readonly mode: CampaignMode;
}

/** The layout variants cycled across a brief card's frames, like `PosterStack`'s. */
const VARIANTS: readonly PosterVariant[] = ["pA", "pB", "pC"];
/** A brief card's preview frames are small enough that three fit the panel. */
const FRAME_SIZE = 64;
/** Every card in the rail is one width, so the frames line up across the row. */
const CARD_WIDTH = "w-52";

/** The brief's ratio axis narrowed to the domain's vocabulary, defensively —
 * the store's JSON is untrusted, so a value outside the union cannot reach
 * `PosterFrame`. Nothing known listed → every ratio, the planner's own default. */
function briefRatios(brief: CampaignBrief): readonly RatioOption[] {
  const requested = brief.variation?.axes?.ratio;
  const known = requested?.filter((value): value is RatioOption =>
    (RATIO_VALUES as readonly string[]).includes(value),
  );
  return known !== undefined && known.length > 0 ? known : RATIO_VALUES;
}

/** One brief card's picture: a frame per ratio at its true proportion. */
function briefPreview(brief: CampaignBrief): ReactNode {
  const ratios = briefRatios(brief);
  return (
    <PreviewPanel caption={messages.startFromRatioCaption(ratios)}>
      <span className="flex items-center gap-2">
        {ratios.map((ratio, index) => (
          <PosterFrame
            key={ratio}
            ratio={ratio}
            variant={VARIANTS[index % VARIANTS.length]}
            size={FRAME_SIZE}
          />
        ))}
      </span>
    </PreviewPanel>
  );
}

/**
 * W2 (D71) — "start from an existing campaign" inside the create dialog, as a
 * horizontal rail of `OptionTile`s (D93, the plan's G3): the blank card first —
 * three dashed empty frames, the resting selection — then one card per brief
 * with a miniature poster at each of its ratios. Each card's accessible name is
 * exactly its value (the blank message, or the brief's id — which *is* a slug,
 * though no slug is ever derived or previewed for the new campaign, D65), and
 * the whole card is the one control: keyboard reachable in DOM order, the rail
 * scrolls horizontally when the store is long. The meta line and the
 * loading/empty/error states are the row list's, unchanged. The caller owns the
 * selection; this component only renders it.
 */
export function StartFromExistingPicker({
  selectedId,
  onSelect,
}: {
  readonly selectedId: string | null;
  readonly onSelect: (source: StartFromSource | null) => void;
}) {
  const [entries, setEntries] = useState<BriefEntry[] | null>(null);
  const [error, setError] = useState(false);

  // Load once per mount — the dialog mounts this only while open, so each open
  // re-reads the store. Parse defensively so an API error surfaces as the error
  // state, not a misleading empty list.
  useEffect(() => {
    let active = true;
    setEntries(null);
    setError(false);
    (async () => {
      try {
        const briefs = await listBriefs();
        /* istanbul ignore next -- `active` is the unmount-race guard; false only if the dialog closes mid-fetch */
        if (active) setEntries(briefs);
      } catch {
        /* istanbul ignore next -- same unmount-race guard on the error path */
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return <p className="p-4 text-[13px] text-error">{messages.startFromExistingError}</p>;
  }
  if (entries === null) {
    return <p className="p-4 text-[13px] text-text-muted">{messages.startFromExistingLoading}</p>;
  }
  if (entries.length === 0) {
    // An empty store is not an error: this will be the first campaign.
    return <p className="p-4 text-[13px] text-text-muted">{messages.startFromExistingEmpty}</p>;
  }
  return (
    // The padding below keeps a tile's focus ring unclipped by the scroll box.
    <div className="flex gap-2 overflow-x-auto pb-2">
      <div className={`${CARD_WIDTH} shrink-0`}>
        <OptionTile
          value={messages.startFromExistingBlank}
          name={messages.startFromExistingBlank}
          selected={selectedId === null}
          onToggle={() => onSelect(null)}
          preview={
            <PreviewPanel caption={messages.startFromBlankCaption}>
              <span className="flex items-center gap-2">
                {RATIO_VALUES.map((ratio) => (
                  <PosterFrame key={ratio} ratio={ratio} variant="pA" size={FRAME_SIZE} blank />
                ))}
              </span>
            </PreviewPanel>
          }
        >
          {null}
        </OptionTile>
      </div>
      {entries.map((entry) => {
        const id = entry.brief.id;
        // An absent mode field means classic behaviour (the domain's own default).
        const mode: CampaignMode = entry.brief.mode ?? "brief";
        return (
          <div key={id} className={`${CARD_WIDTH} shrink-0`}>
            <OptionTile
              value={id}
              name={id}
              selected={selectedId === id}
              onToggle={() => onSelect({ id, mode })}
              tag={modeDisplayName(mode)}
              meta={messages.startFromRowMeta(
                entry.brief.products.length,
                entry.brief.treatments?.length ?? 1,
                entry.brief.targetRegion,
              )}
              preview={briefPreview(entry.brief)}
            >
              {null}
            </OptionTile>
          </div>
        );
      })}
    </div>
  );
}
