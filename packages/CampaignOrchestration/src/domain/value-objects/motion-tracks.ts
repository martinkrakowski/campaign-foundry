/**
 * K2: the preset → track expansion for the four `MOTION_KINDS`, a pure
 * function beside `beatAt` (K-D2), replacing the per-kind `motion === "<kind>"`
 * branches the compositor used to hold (`kenBurnsScale`, `drawTimeline`'s and
 * `drawLegacy`'s copy-layer `rise`, `paintAccent`'s `wipe`). The vocabulary a
 * brief writes does not change (K-D1) — only where the branch lives does.
 *
 * `groundMotionTracks` and `copyMotionTracks` build SYNTHESIZED `Track[]`
 * (K2/K3 amendment, 2026-09-13): never read off a layer's own `tracks` field,
 * built fresh from the motion kind on every draw and fed straight to
 * `resolveTracks`, so a stored brief's own hand-authored tracks (K4, later)
 * are untouched by this module.
 *
 * K2's scope (§2's K2 row): a `MOTION_KINDS` track lands on either an
 * `image`/`video` (ground) layer or a `static-text`/`animated-text` (copy)
 * layer, and K-D8's fix-round-2 refusal applies to the ground case — a
 * `beat`/`effect`-clock stop has no defined meaning on a layer with no
 * per-beat multiplicity of its own. So `groundMotionTracks` emits only
 * `pose`-clock stops, and `copyMotionTracks` — whose track lands on the text
 * layer, resolved through `resolveTracks`'s `copy` bucket, not `byLayer` — is
 * free to use `beat`-clock stops, which is exactly what `headline-rise`'s
 * per-beat reset (Q1) needs.
 *
 * `accent-wipe` is the one kind that does NOT become a track — see
 * {@link accentWipeFraction}'s own doc comment for why, and the PR body for
 * the fuller reasoning.
 *
 * K3: {@link textEffectTracks} expands the four `TEXT_EFFECT_VALUES` the same
 * way, replacing `NodeCanvasCompositor.ts`'s own `textEffectPose` switch.
 * Every kind becomes a single-property, two-stop `effect`-clock track on the
 * text layer — the clock K1b defined as `clocks.effectT ?? local` for exactly
 * this lane — with stops at `t = 0` and `t = entranceFraction`, so holding
 * past the last stop (`resolveTracks`'s own `sampleStops` contract) reproduces
 * the old settled pose with no separate "past the window" branch needed here.
 * The four canvas fractions stay `CREATIVE_GEOMETRY.textEffect`'s own — read
 * here, in the expansion, not re-read inside `resolve-tracks.ts` — the same
 * leaf the web's preview reads, so render and preview cannot drift
 * (`creative-geometry.ts`'s own doc comment).
 */
import { scaleBasis, type CanvasSpec } from "./aspect-ratios.js";
import { CREATIVE_GEOMETRY } from "./creative-geometry.js";
import type { TextEffectKind } from "./creative-style.js";
import type { MotionKind } from "./MotionKind.vo.js";
import type { Track } from "./tracks.js";

/**
 * Zoom amount applied away from the ken-burns rest pose so `scale(restT) === 1`
 * (moved here from the compositor's own `KEN_BURNS_ZOOM`, K2 — the constant
 * a pose-clock `scale` track's stop values are built from, not read by
 * anything else).
 */
const KEN_BURNS_ZOOM = 0.08;

/**
 * How far a rising headline starts below its rest position, as a fraction of
 * the canvas height (moved here from the compositor's own literal `0.12`, K2
 * — the constant a beat-clock `dy` track's stop values are built from).
 */
const HEADLINE_RISE_OFFSET_FRACTION = 0.12;

/**
 * `ken-burns-in`/`ken-burns-out` as a `scale` track on the ground
 * (`image`/`video`) layer: two `pose`-clock stops at the default easing
 * (`ease-out-cubic`), reproducing `kenBurnsScale`'s old
 * `1 + KEN_BURNS_ZOOM * (1 - eased)` / `1 + KEN_BURNS_ZOOM * eased` exactly at
 * `t = 0` and `t = 1` — `resolveTracks`'s `sampleStops` returns a boundary
 * stop's own value with no arithmetic at all there — and to within the last
 * bit of a double everywhere else: the fold reassociates the same two terms
 * (`a.value + (b.value - a.value) * eased` instead of `1 + Z * (1 - eased)`),
 * a difference the canvas rasterizer does not see (the goldens are the proof
 * — 48 motion cells, the mp4 byte golden, unchanged). Every other kind
 * (`undefined`, `headline-rise`, `accent-wipe`) returns no track, which folds
 * to the identity scale (1) — exactly `kenBurnsScale`'s old `else 1` branch.
 */
export function groundMotionTracks(motion: MotionKind | undefined): readonly Track[] {
  if (motion === "ken-burns-in") {
    return [
      {
        property: "scale",
        stops: [
          { t: 0, value: 1 + KEN_BURNS_ZOOM, clock: "pose" },
          { t: 1, value: 1, clock: "pose" },
        ],
      },
    ];
  }
  if (motion === "ken-burns-out") {
    return [
      {
        property: "scale",
        stops: [
          { t: 0, value: 1, clock: "pose" },
          { t: 1, value: 1 + KEN_BURNS_ZOOM, clock: "pose" },
        ],
      },
    ];
  }
  return [];
}

/**
 * `headline-rise` as `opacity` + `dy` tracks on the text layer, resolved
 * through `resolveTracks`'s `copy` bucket (K-D6: two text layers already
 * collapse to one beat block) — `beat`-clock stops, because a rising
 * headline resets on every beat's OWN local progress (Q1), which is exactly
 * what the `beat` clock reads; K-D8's fix-round-2 refusal is about a ground
 * layer, not a text one, so it does not apply here.
 *
 * `opacity`'s stops (`0 → 1`) fold to exactly `easeOutCubic(local)` with no
 * reassociation at all (`0 + (1 - 0) * ease(progress)` — multiplying and
 * adding the identity elements is exact in IEEE-754) — bit-identical to the
 * old `riseAlpha`. `dy`'s stops (`height * HEADLINE_RISE_OFFSET_FRACTION →
 * 0`) reassociate the old `(1 - eased) * C` into `C + (0 - C) * eased`,
 * within a double's last bit at an interior `t` — again, not something the
 * rasterizer resolves (the goldens are the proof). Every other kind returns
 * no track, folding to the identity pose (`dy = 0`, `opacity = 1`) — exactly
 * the old `else` branches.
 */
export function copyMotionTracks(motion: MotionKind | undefined, height: number): readonly Track[] {
  if (motion !== "headline-rise") return [];
  return [
    {
      property: "opacity",
      stops: [
        { t: 0, value: 0, clock: "beat" },
        { t: 1, value: 1, clock: "beat" },
      ],
    },
    {
      property: "dy",
      stops: [
        { t: 0, value: HEADLINE_RISE_OFFSET_FRACTION * height, clock: "beat" },
        { t: 1, value: 0, clock: "beat" },
      ],
    },
  ];
}

/**
 * `accent-wipe`'s fraction of the accent band's soft fade to reveal — the one
 * `MOTION_KINDS` member K2 does NOT turn into a track. Its motion is a clip
 * extent (`fillRect(..., fadeH * wipe)`, `paintAccent`), which none of
 * `TRACK_PROPERTIES` represents (`tracks.ts`'s own doc comment) — the accent
 * layer is not even in `TRACKABLE_LAYER_KINDS`, deliberately, for exactly
 * this reason.
 *
 * Reusing an existing property (say, `opacity`) as a stand-in for a clip
 * fraction would be a fifth property in disguise: a hand-authored `opacity`
 * track on an accent layer (K4, later) would then mean something different
 * from an `opacity` track on every other trackable kind — real per-pixel
 * alpha everywhere else, a clip fraction here — an ambiguity this module
 * declines to introduce for one kind. So the wipe stays the one drawer-local
 * animation `paintAccent` computes directly; only the `motion === "..."`
 * comparison itself moves here, out of the compositor, closing `premise K2`
 * for this kind the same way the other three close it by becoming tracks.
 */
export function accentWipeFraction(motion: MotionKind | undefined, eased: number): number {
  return motion === "accent-wipe" ? eased : 1;
}

/**
 * The four text effects (T6/K3) as `effect`-clock tracks on the text layer,
 * resolved through `resolveTracks`'s `copy` bucket alongside
 * {@link copyMotionTracks}'s own tracks — one `resolveTracks` call, one fold,
 * in the SAME declaration order the old code composed in (`opacity =
 * (riseAlpha * fx.alpha) * layerAlpha`, K-D9): `copyMotionTracks`'s tracks
 * first, this module's second, so a headline-rise `opacity` term (when
 * present) always multiplies BEFORE a `fade-in` term, matching the byte gate.
 *
 * Each kind touches exactly one `TRACK_PROPERTY` (`textEffectPose`'s own
 * `TEXT_EFFECT_REST` spread — every kind changed exactly one field), with two
 * stops: the entrance's start (`t = 0`) and its end (`t = entranceFraction`).
 * `resolveTracks`'s `sampleStops` returns a boundary stop's own value with no
 * arithmetic at all, so both ends are bit-identical to the old formula
 * evaluated at `local = 0` and `local = entranceFraction` — the same "exact at
 * the stops" property K2 proved for ken-burns/headline-rise. Holding the last
 * stop's value past `t = entranceFraction` (`sampleStops`'s own contract) is
 * exactly `textEffectPose`'s settled pose — no separate branch needed here.
 *
 * `fade-in`'s `opacity` stops (`0 → 1`) fold to exactly
 * `easeOutCubic(local / entranceFraction)` with no reassociation at all — `0 +
 * (1 - 0) * ease(progress)` is exact in IEEE-754, and `progress` here IS
 * `local / entranceFraction` (the same division the old `settled` computed,
 * `clamp01` a no-op in range) — bit-identical everywhere, not just the stops.
 * `rise-in`'s `dy` and `slide-in`'s `dx` stops (`C → 0`) reassociate the old
 * `(1 - eased) * C` into `C + (0 - C) * eased`, within a double's last bit at
 * an interior `t` — the same finding K2 recorded for `headline-rise`'s `dy`.
 * `scale-in`'s `scale` stops (`1 - scaleAmplitude → 1`) reassociate the old
 * `1 - (1 - eased) * A` the same way. Every reassociation is proven not to
 * move a rendered pixel by the compositor's goldens (48 motion cells, the mp4
 * byte golden, the HL3 raster suite), the real proof for a byte-identity
 * gate — two mathematically-identical, differently-associated floating-point
 * expressions, not a similarity judgement.
 *
 * An undefined effect returns no track, folding to the identity pose —
 * exactly `textEffectPose`'s own `kind === undefined` early return.
 */
export function textEffectTracks(
  effect: TextEffectKind | undefined,
  spec: CanvasSpec,
  width: number,
  height: number,
): readonly Track[] {
  if (effect === undefined) return [];
  const { entranceFraction, riseOffsetFraction, slideOffsetFraction, scaleAmplitude } =
    CREATIVE_GEOMETRY.textEffect;
  switch (effect) {
    case "fade-in":
      return [
        {
          property: "opacity",
          stops: [
            { t: 0, value: 0, clock: "effect" },
            { t: entranceFraction, value: 1, clock: "effect" },
          ],
        },
      ];
    case "rise-in":
      return [
        {
          property: "dy",
          stops: [
            { t: 0, value: riseOffsetFraction * height, clock: "effect" },
            { t: entranceFraction, value: 0, clock: "effect" },
          ],
        },
      ];
    case "slide-in":
      return [
        {
          property: "dx",
          stops: [
            { t: 0, value: slideOffsetFraction * scaleBasis(spec, width, height), clock: "effect" },
            { t: entranceFraction, value: 0, clock: "effect" },
          ],
        },
      ];
    case "scale-in":
      return [
        {
          property: "scale",
          stops: [
            { t: 0, value: 1 - scaleAmplitude, clock: "effect" },
            { t: entranceFraction, value: 1, clock: "effect" },
          ],
        },
      ];
  }
}
