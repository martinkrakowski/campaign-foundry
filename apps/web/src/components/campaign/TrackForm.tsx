"use client";

import { useId, useState, type Dispatch } from "react";

import {
  STOP_CLOCKS,
  TEXT_LAYER_KINDS,
  TRACK_PROPERTIES,
  layerTracksProblem,
  type Stop,
  type StopClock,
  type Track,
  type TrackProperty,
} from "@campaignfoundry/CampaignOrchestration/tracks";
import { EASING_KINDS, type EasingKind } from "@campaignfoundry/CampaignOrchestration/easing";
import { IDENTITY_POSE } from "@campaignfoundry/CampaignOrchestration/resolve-tracks";
import type { CreativeTemplateLayer } from "@campaignfoundry/CampaignOrchestration/creative-templates";

import { Button, Input } from "@/components/ui";
import * as messages from "@/components/campaign/messages";
import { MOTION_KIND_META } from "@/components/campaign/MotionKindPanel";
import { canvasDisplayName } from "@/components/campaign/display-names";
import { presetTracksFor, type PresetCell } from "@/components/campaign/preset-tracks";
import type { EditorAction } from "@/components/campaign/editor-state";

/**
 * The committed playhead, or `null` where there is none to read.
 *
 * TS2 publishes only the COMMITTED second out of `PlayheadHost` — the live
 * scrub second deliberately stays in the rail so a drag writes no context per
 * pointermove. That is the second this form maps, and it is the right one:
 * a stop is committed state, so prefilling it from a value that changes on
 * every frame of a drag would be a stop whose `t` depended on when the render
 * happened.
 */
export interface TrackPlayhead {
  readonly durationSec: number;
  readonly committedSec: number;
}

/**
 * Where a new stop's `t` lands (§4.4 rule 3), for the one clock this editor can
 * answer honestly.
 *
 * `pose` is `committedSec / durationSec` — the whole-creative clock, which is
 * exactly what `clockSample`'s `"pose"` branch reads.
 *
 * `beat` and `effect` are NOT mapped here, and that is deliberate rather than
 * unfinished. Both need a beat to be local against: the resolver derives one
 * with `beatAt` + `beatLocal` over `ResolvedBeat`s, and this editor has no
 * `ResolvedBeat` anywhere — `TimelineTape` takes an editor-shaped beat row, not
 * the domain's. Writing the mapping here would be a SECOND statement of the
 * resolver's clock math, free to drift from the one that actually renders, and
 * TL5's rule is that every refusal and every mapping is the domain's, called.
 * So a stop on those clocks starts at 0 and the operator types its `t`, which
 * resolves identically at render. Prefilling them is TL6's, which has the
 * ruler — and the beats — already.
 */
export function poseTAt(playhead: TrackPlayhead | null): number {
  if (playhead === null) return 0;
  if (!(playhead.durationSec > 0)) return 0;
  const raw = playhead.committedSec / playhead.durationSec;
  return raw < 0 ? 0 : raw > 1 ? 1 : raw;
}

function clockOf(track: Track): StopClock {
  // A track's stops share one clock (K1b) and `stops` is never empty, so the
  // first stop names it for the whole track.
  return track.stops[0]!.clock;
}

function Row({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[11px] font-medium text-text-muted">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

/**
 * One stop's three editable values. The number boxes keep their own draft
 * string while being typed into — `GeometryNumberField`'s rule, for the same
 * reason: a half-typed `0.` must survive its own re-render.
 */
function StopFields({
  stop,
  propertyLabel,
  clockLabel,
  index,
  problemOf,
  onPatch,
  onRemove,
}: {
  stop: Stop;
  propertyLabel: string;
  clockLabel: string;
  index: number;
  /** The domain's `must` clause for a candidate patch, or `undefined` if legal. */
  problemOf: (patch: { t?: number; value?: number }) => string | undefined;
  onPatch: (patch: { t?: number; value?: number; easing?: EasingKind | undefined }) => void;
  onRemove: () => void;
}) {
  const [tDraft, setTDraft] = useState<string | null>(null);
  const [valueDraft, setValueDraft] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  /**
   * One commit path for both boxes: parse, ask the domain, then either dispatch
   * or SAY WHY. Without the middle step a refused edit was invisible — the
   * reducer returned the same state, the box kept the draft, and blur silently
   * put the old number back.
   */
  const commit = (patch: { t?: number; value?: number }) => {
    const must = problemOf(patch);
    if (must !== undefined) {
      setRefused(must);
      return;
    }
    setRefused(null);
    onPatch(patch);
  };
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-2">
      <div className="w-20">
        <Row label={messages.tracksStopTimeLabel}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={tDraft ?? String(stop.t)}
              onChange={(e) => {
                const raw = e.target.value;
                setTDraft(raw);
                if (raw.trim() === "") return;
                const parsed = Number(raw);
                if (!Number.isFinite(parsed)) return;
                commit({ t: parsed });
              }}
              onBlur={() => setTDraft(null)}
            />
          )}
        </Row>
      </div>
      <div className="w-24">
        <Row label={messages.tracksStopValueLabel}>
          {(id) => (
            <Input
              id={id}
              type="number"
              step={0.01}
              value={valueDraft ?? String(stop.value)}
              onChange={(e) => {
                const raw = e.target.value;
                setValueDraft(raw);
                if (raw.trim() === "") return;
                const parsed = Number(raw);
                if (!Number.isFinite(parsed)) return;
                commit({ value: parsed });
              }}
              onBlur={() => setValueDraft(null)}
            />
          )}
        </Row>
      </div>
      <div className="flex-1">
        <Row label={messages.tracksStopEasingLabel}>
          {(id) => (
            <select
              id={id}
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-[12px]"
              value={stop.easing ?? ""}
              // The empty option clears the key rather than writing the
              // default's name — absence IS the domain default (K-D7), and
              // spelling it out would be a second statement of which easing
              // that is. The `AnchorField` idiom.
              onChange={(e) =>
                onPatch({
                  easing: e.target.value === "" ? undefined : (e.target.value as EasingKind),
                })
              }
            >
              <option value="">{messages.tracksEasingDefault}</option>
              {EASING_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {messages.TRACK_EASING_LABEL[kind]}
                </option>
              ))}
            </select>
          )}
        </Row>
      </div>
      {refused === null ? null : (
        <p role="status" className="w-full text-[11px] text-text-muted">
          {messages.tracksRefused(refused)}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={messages.tracksRemoveStopLabel(propertyLabel, clockLabel, index)}
        onClick={onRemove}
      >
        {messages.tracksRemoveShort}
      </Button>
    </div>
  );
}

/**
 * The tracks section of the layer sheet — K5 / SE6 / TL5, `studio-editor.md`
 * §4.4 rules 1–7.
 *
 * **Rule 8 is not here and is not dropped:** showing a preset motion kind's
 * expansion read-only beside the authored stops is **TL7**'s lane in that same
 * plan, which owns D140's two-group presentation. This form authors; TL7
 * displays the preset half beside it.
 *
 * Every refusal shown is `layerTracksProblem`'s. It is called twice on purpose
 * and that is not a restatement: once HERE, on the candidate, so a duplicate
 * `t` says why instead of the keystroke vanishing, and once in the reducer,
 * which is the boundary that actually holds — a hand-restored draft reaches
 * that one without passing this.
 */
export function TrackForm({
  layer,
  dispatch,
  playhead,
  preset,
}: {
  layer: CreativeTemplateLayer;
  dispatch: Dispatch<EditorAction>;
  playhead: TrackPlayhead | null;
  /**
   * The previewed cell, whose preset expansion this form may honestly show
   * (TL7, D140). `null` when the rail composes no motion — there is then no
   * expansion to display rather than an empty one.
   */
  preset: PresetCell | null;
}) {
  const tracks = layer.tracks ?? [];
  // Called, not restated: the same expanders the compositor folds (K2).
  const presetTracks = presetTracksFor(layer.kind, preset);
  const textKind = TEXT_LAYER_KINDS.includes(layer.kind);
  const [clock, setClock] = useState<StopClock>("pose");
  // A clock the layer's kind cannot carry is never the live one: a select that
  // always refuses is the live-looking control SG-D22 argued against.
  const offeredClocks = STOP_CLOCKS.filter((candidate) => candidate === "pose" || textKind);
  const liveClock = offeredClocks.includes(clock) ? clock : "pose";

  const addStop = (property: TrackProperty) => {
    dispatch({
      type: "addTrackStop",
      layerId: layer.id,
      property,
      clock: liveClock,
      t: poseTAt(liveClock === "pose" ? playhead : null),
      // The neutral element for both fold operators (K-D8), imported rather
      // than retyped: a new stop changes nothing until it is edited, so adding
      // one cannot move a render on its own.
      value: IDENTITY_POSE[property],
    });
  };

  return (
    <section className="space-y-3" data-testid="layer-tracks">
      <h4 className="text-[12px] font-semibold text-text-primary">{messages.tracksHeading}</h4>

      <Row label={messages.tracksClockLabel}>
        {(id) => (
          <select
            id={id}
            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-[12px]"
            value={liveClock}
            onChange={(e) => setClock(e.target.value as StopClock)}
          >
            {offeredClocks.map((candidate) => (
              <option key={candidate} value={candidate}>
                {messages.TRACK_CLOCK_LABEL[candidate]}
              </option>
            ))}
          </select>
        )}
      </Row>
      {textKind ? null : (
        <p className="text-[11px] text-text-muted">{messages.tracksClockTextOnly}</p>
      )}

      {tracks.length === 0 ? (
        <p className="text-[12px] text-text-muted">{messages.tracksNone}</p>
      ) : null}

      {/* TL7 / D140 — the preset half, READ-ONLY and labelled with the video
          style AND the canvas it was expanded for. Two groups rather than one
          merged list: a preset expansion belongs to a cell, not to the
          document, so showing it as though the brief carried these stops would
          be a claim the operator could not check. It offers no control at all,
          which is what makes read-only structural rather than a disabled-
          looking button.

          Rendered ONLY when there is an expansion to show. An empty bordered
          group would imply this creative has preset keys, which is the same
          mistake TS1 lane rule names ("an empty waveform now would imply a
          bed the brief does not carry") and which two reviewers caught here. */}
      {preset !== null && presetTracks.length > 0 ? (
        <section className="space-y-2 rounded-md border border-dashed border-border p-2">
          <h5 className="text-[11px] font-semibold text-text-primary">
            {messages.tracksPresetHeading(
              MOTION_KIND_META[preset.motion],
              canvasDisplayName(preset.canvas),
            )}
          </h5>
          <p className="text-[11px] text-text-muted">{messages.tracksPresetReadOnly}</p>
          {presetTracks.map((track, i) => (
            <div key={`${track.property}:${i}`} className="space-y-1">
              <p className="text-[11px] font-medium text-text-muted">
                {messages.TRACK_PROPERTY_LABEL[track.property]} ·{" "}
                {messages.TRACK_CLOCK_LABEL[clockOf(track)]}
              </p>
              <ul className="space-y-0.5">
                {track.stops.map((stop, j) => (
                  <li key={`${stop.t}:${j}`} className="text-[11px] text-text-muted">
                    {messages.tracksPresetStop(stop.t, stop.value)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {TRACK_PROPERTIES.map((property) => {
        const propertyLabel = messages.TRACK_PROPERTY_LABEL[property]!;
        // Every track this property has, with its index in the layer's own list
        // — the address the reducer's actions take. A property may hold more
        // than one, since a second clock is a second track (§4.4 rule 4).
        const mine = tracks
          .map((track, trackIndex) => ({ track, trackIndex }))
          .filter((entry) => entry.track.property === property);
        // The candidate this button would dispatch, gated by the same function
        // the reducer uses, so the message is the domain's.
        const candidateStop: Stop = {
          t: poseTAt(liveClock === "pose" ? playhead : null),
          value: IDENTITY_POSE[property],
          clock: liveClock,
        };
        const target = mine.find((entry) => clockOf(entry.track) === liveClock);
        const candidateTracks: readonly Track[] =
          target === undefined
            ? [...tracks, { property, stops: [candidateStop] }]
            : tracks.map((track, i) =>
                i === target.trackIndex
                  ? { ...track, stops: [...track.stops, candidateStop] }
                  : track,
              );
        const problem = layerTracksProblem(layer.kind, candidateTracks);

        return (
          <div key={property} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-text-primary">{propertyLabel}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={messages.tracksAddStopLabel(propertyLabel)}
                disabled={problem !== undefined}
                onClick={() => addStop(property)}
              >
                {messages.tracksAddShort}
              </Button>
            </div>
            {problem !== undefined ? (
              <p role="status" className="text-[11px] text-text-muted">
                {messages.tracksRefused(problem.must)}
              </p>
            ) : null}
            {/* Grouped by track, with its clock named. A property may hold one
                track per clock (rule 4), and a flat list of rows made those
                indistinguishable — two `pose` and `beat` rows looked identical
                and their remove controls shared an accessible name, so neither
                an operator nor a test could say which timeline a row drove. */}
            {mine.map((entry) => {
              const clock = clockOf(entry.track);
              const clockLabel = messages.TRACK_CLOCK_LABEL[clock]!;
              return (
                <div key={`${property}:${clock}`} className="space-y-2">
                  <p className="text-[11px] text-text-muted">{clockLabel}</p>
                  {entry.track.stops.map((stop, stopIndex) => (
                    <StopFields
                      /* Keyed by the stop's IDENTITY, not its position. `t` is
                         unique within a track by the domain's own rule (K-D9),
                         so this is stable — where an index key was not:
                         removing an earlier track shifts the later ones down,
                         and React would hand a surviving row the removed row's
                         half-typed draft. */
                      key={`${property}:${clock}:${stop.t}`}
                      stop={stop}
                      propertyLabel={propertyLabel}
                      clockLabel={clockLabel}
                      index={stopIndex}
                      /* The same gate the Add button uses, on the EDIT
                         candidate: a `t` that duplicates a sibling, or falls
                         outside [0, 1], is refused by the reducer, and without
                         this the draft simply reverted on blur with nothing
                         said. */
                      problemOf={(patch) =>
                        layerTracksProblem(
                          layer.kind,
                          tracks.map((track, i) =>
                            i === entry.trackIndex
                              ? {
                                  ...track,
                                  stops: track.stops.map((candidate, j) =>
                                    j === stopIndex ? { ...candidate, ...patch } : candidate,
                                  ),
                                }
                              : track,
                          ),
                        )?.must
                      }
                      onPatch={(patch) =>
                        dispatch({
                          type: "setTrackStop",
                          layerId: layer.id,
                          trackIndex: entry.trackIndex,
                          stopIndex,
                          patch,
                        })
                      }
                      onRemove={() =>
                        dispatch({
                          type: "removeTrackStop",
                          layerId: layer.id,
                          trackIndex: entry.trackIndex,
                          stopIndex,
                        })
                      }
                    />
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
