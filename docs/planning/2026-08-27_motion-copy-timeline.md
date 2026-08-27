# Motion Copy Timeline — Architecture & Development Plan

**Date:** 2026-08-27
**Status:** Proposed v1 (decisions D1–D11 for review; Q1–Q3 open)
**Scope:** `packages/CampaignOrchestration` (domain VO + orchestration), `packages/CreativeGeneration` (compositor), `apps/api` (parse + capabilities), `apps/web` (Copy section editor)
**Related:** `2026-08-25_randomized-campaigns-and-motion.md` (motion wave), `2026-08-26_unified-campaign-editor.md` (D12/D15 authoring-vs-running), PRs #58 (motion), #75/#76 (motion planning fixes), #82 (field-shaped controls)

---

## 0. Verdict on the proposal

**The intent: agree, and it is the highest-value thing left in the motion wave.** Today a motion
asset is a still that moves. `NodeCanvasCompositor.draw` receives one `message` and paints it on
every frame; `t` moves the *background* (ken-burns), the *accent band* (accent-wipe) or the
*headline's entry* (headline-rise), but never the words. A six-second clip says one thing for six
seconds. Sequenced copy is what separates this from a Ken Burns slideshow, and nothing else in the
backlog changes the output as much.

**The mechanism as stated — absolute second ranges — disagree, for one concrete reason: duration
is a variation axis.** `axes.duration: [5, 10, 15]` is legal today and the planner draws a
`durationSec` per variant (`PlanCapacity.ts:46`). A timeline authored as *0–2s / 2–5s* is correct
for exactly one of those durations and wrong for the rest: at 15 s the copy finishes in the first
third and ten seconds run silent; at 3 s the second slide never renders at all. The timeline would
also silently constrain the duration axis — narrowing it is precisely the class of bug behind the
plan-shortfall message (#77) and the motion-only ratio narrowing (#75).

**The fix is small and makes the feature stronger: beats, not timestamps.** Author an ordered list
of copy *beats* with relative weights. Absolute seconds become a computed *display* — shown per
duration in the axis, so the author sees "at 5 s: 0.0–1.4 · 1.4–3.6 · 3.6–5.0" and "at 15 s: …" —
and never the stored value.

There is a pleasing consequence. `draw` already works in normalized `t ∈ [0,1]`. Proportional beats
resolve to `t`-windows that are **identical at every duration**, so the compositor needs no
duration awareness whatsoever: the same resolved timeline drives a 5 s and a 15 s clip. Seconds
enter in exactly two places — the readability floor (D3) and the editor's preview. That is a
smaller change than the timestamp version, not a larger one.

## 0.1 Proposed Decisions

| ID | Decision | Consequence |
|----|----------|-------------|
| **D1** | **Beats, not timestamps.** Copy for a motion clip is `copy.timeline.beats` — an ordered list of `{ text, weight }`. No second appears in the stored brief. | The same timeline is valid for every duration the axis can draw. Authoring is "what comes first", not "what starts at 2.0". |
| **D2** | **The timeline resolves in `t`-space, at prepare time.** `resolveTimeline()` maps beats to `[startT, endT)` windows over `[0,1]`; `NodeCanvasCompositor.prepare` stores the resolved list on `Prepared`. `draw(ctx, prepared, t, motion)` keeps its signature and stays pure. | The compositor never learns what a second is. `durationSec` is needed only to compute transition widths (D9), which happens once in `prepare`. |
| **D3** | **A readable-dwell floor is an authoring rule, not a runtime clamp.** `MIN_DWELL_SEC = 1.2`. `beats.length × MIN_DWELL_SEC ≤ min(axes.duration)` must hold, enforced by the editor and by `parseBrief` in running mode. | The editor refuses an unreadable timeline before the run, in the same idiom as #82's count slider: the ceiling is visible and the control cannot author past it. No silent truncation, no 0.3-second flash. |
| **D4** | **Beats are copy, so beats are governed.** Every distinct beat text is gated through `CompliancePort.validateLegalCopy` in the same deduped sweep that already covers pooled headlines (`GenerateCampaignUseCase.use-case.ts:360-363`), before a frame is drawn. The editor's beat field offers **Insert from pool**, which copies an *approved* text in and records its provenance. | A timeline cannot become an unapproved-copy side door. Approval happens at author time; the legal gate at run time is the backstop, not the only line. |
| **D5** | **v1: one sequence per campaign, not per variant.** The beat list lives on the brief and is fixed across variants. It is **not** a variation axis. | Keeps `axisProductSize` and `minDistance` untouched. Per-variant beat draws multiply the space combinatorially and need their own distance metric — deferred to Q3. |
| **D6** | **One type size for the whole sequence.** `layoutHeadline` fits to the *longest* beat and every beat renders at that size; per-beat layout is memoized on `Prepared`. | Independent autofit would make the type jump between beats, which reads as a bug. Memoization also removes the existing per-frame autofit loop — 180 frames × a shrink-until-fits loop today — so this is a net perf win. |
| **D7** | **The poster shows a designated key beat.** `copy.timeline.keyBeat` (1-based, default 1). The poster is drawn at `restT(kind)` for the *pose* and at the key beat for the *copy* — the two are decoupled. | Without this the poster shows whichever beat happens to be live at `restT`, which is `0` for `ken-burns-out` and `1` for every other kind (`MotionKind.vo.ts`): the same brief would poster its first beat for one motion kind and its last for another. The poster feeds the grid, export, packaging and the PDF proof, so incoherence there is expensive. |
| **D8** | **Compliance sampling covers every beat.** `sampleAt` becomes `MOTION_SAMPLE_AT ∪ { midpoint of each beat }`, deduped and sorted (the adapter already dedupes and sorts). | The fixed five-point sample can land entirely inside two beats. Brand density is measured on composed frames, and a long light-on-dark beat changes it. No beat goes visually unchecked. |
| **D9** | **Transitions are one per timeline, with a bounded width.** `transition: "cut" \| "fade"` (default `fade`). Fade width `= min(0.4 s, 25 % of the shorter adjacent beat)`, converted to `t` at prepare time. Slide/wipe deferred. | One knob, two values, no per-beat transition matrix in v1. The width bound keeps a fade from eating a short beat. |
| **D10** | **No timeline ⇒ today's behaviour, byte-identical.** An absent `copy.timeline` takes the existing single-`message` path unchanged. | The encoder runs `-fflags +bitexact` and the suite has golden-byte expectations; "unchanged" here must mean *identical bytes*, and is asserted as such. |
| **D11** | **Authoring vs running, per the editor plan's D15.** A timeline is structurally valid on a host without ffmpeg — listed, editable, saveable, preserved verbatim. Only `POST /campaigns/generate` and `/plan` enforce the capability and the D3 floor. | Same rule the motion fields already follow (D12/D15 of `2026-08-26`). Gating blocks entering a state, never leaving one — `DESIGN.md`, §Principles. |

---

## 1. Context & Current State (verified 2026-08-27)

- **Copy is one string, end to end.** `CampaignBrief.campaignMessage` (+ optional `localizedMessage`), or a pooled `variant.headline` when `axes.headline: pool://copy`. `CompositeRequest.message` carries it; `NodeCanvasCompositor.prepare` captures it on `Prepared`; `layoutHeadline` wraps and autofits it *inside `draw`*, per frame.
- **Motion animates everything but the words.** `draw` applies `easeOutCubic(t)` to: background zoom (`kenBurnsScale`), the accent band's fade height (`accent-wipe`), and the headline's `dy`/`alpha` (`headline-rise`). Layers 1–3 and 5 are otherwise `t`-invariant; the logo is deliberately pinned to the rest-pose headline box so it cannot jump mid-clip.
- **Duration is a drawn axis.** `axes.duration: number[]` → `PlanCapacity.ts:46` enumerates `motion × duration` cells → `variant.durationSec`. Fallback when the axis is empty: `DEFAULT_DURATION_SEC = 6` (`GenerateCampaignUseCase.use-case.ts:49`).
- **Motion assets already carry a poster.** `compositeVideo` returns `{ video, poster, sampledFrames, logoApplied }`; the poster is drawn at `restT(request.motion)` and saved to `identity.outputPath`, and it is what the grid, export, packaging and proof consume (`renderMotionVariant`).
- **Compliance is two gates.** `validateLegalCopy(text)` over every distinct copy string (deduped for pooled headlines at `:362`), and `validateBrandColorDensity(frame, hex)` over `MOTION_SAMPLE_AT = [0, 0.25, 0.5, 0.75, 1]`. A motion asset passes only if *all* sampled frames pass; the minimum score is recorded.
- **The copy pool is the governance surface.** `pools.json` per brief, entries `approved | rejected` (`pools.ts:53`); `approvedTexts()` feeds the planner. `HEADLINE_POOL_REF = "pool://copy"` is the only legal value of `axes.headline`.
- **The editor has motion controls since #82.** `state.motion: string[]`, `state.duration: number[]`, capability-gated, preserved verbatim when the capability is off (D12).

### Guiding Principles

1. The timeline describes *order and proportion*; the run supplies the seconds. Nothing stored is duration-specific.
2. A beat is copy. Everything the pool guarantees about a headline it must guarantee about a beat.
3. The compositor stays pure over `t`. All duration arithmetic happens once, in `prepare`.
4. Absent timeline ⇒ identical bytes. This feature adds a path; it does not modify the existing one.

---

## 2. Analysis of the proposal

| Proposal point | Assessment |
|---|---|
| Copy should change over a motion clip | **Agree, strongly.** It is the gap between "a still that moves" and video, and every other motion primitive is already in place to support it. |
| "0–2 seconds = text slide 01, 2–5 = text slide 02" | **Agree on the shape, refute the units.** Ordered slides: yes. Absolute seconds: no — `axes.duration` makes a second-keyed timeline correct for one duration and wrong for the others (H1). Weights resolve to the same `t`-windows at every duration. |
| Configurable "when motion is selected" | **Agree, with D11's caveat.** The control is *revealed* by motion and *enforced* at run time; it is never stripped when the capability is off. |
| Implied: a transition between slides | **Agree, bounded.** One `transition` per timeline, `cut` or `fade` (D9). A per-beat transition matrix is a v2 conversation. |
| Not stated: what the still shows | **Must be decided (H3).** Every motion asset posters a frame, and `restT` differs per motion kind, so "whatever is live at rest" produces first-beat posters for three kinds and last-beat posters for `ken-burns-out`. D7 makes it explicit. |
| Not stated: how beats interact with `headline: pool://copy` | **Must be decided (H2, Q3).** Both are "the words on the creative". D5 keeps them orthogonal in v1: the pooled headline axis and a fixed beat sequence are mutually exclusive per brief. |

### Findings

| # | Sev | Finding |
|---|-----|---------|
| **H1** | High | **Absolute timestamps are incompatible with the duration axis.** A brief with `duration: [5, 15]` and a 0–2 / 2–5 timeline renders correctly at 5 s and silently wrong at 15 s. Either the timeline constrains the axis to one value (removing a variation dimension the user just added) or it produces broken clips. → D1, D2. |
| **H2** | High | **Free-text beats bypass copy approval.** Pooled headlines are approved in `pools.json` and every distinct text is legal-gated before a frame is drawn. Beats authored as plain brief fields would be neither. This repo has a whole bounded context for compliance; a copy side-door is a regression, not a gap. → D4. |
| **H3** | High | **The poster becomes incoherent across motion kinds.** `restT` is `1` for `ken-burns-in`/`headline-rise`/`accent-wipe` and `0` for `ken-burns-out`. With a sequence, the same campaign posters its opening line for three kinds and its closing line for the fourth — into the grid, the export, the platform package and the PDF proof. → D7. |
| **M1** | Med | **Per-beat autofit makes the type size jump.** `layoutHeadline` shrinks from `width × 0.06` until the block fits, per call. A short beat and a long beat would render at different sizes mid-clip. → D6. |
| **M2** | Med | **The fixed 5-point brand sample can miss beats.** With four beats and samples at 0/.25/.5/.75/1, a beat spanning 0.26–0.49 is never measured. → D8. |
| **M3** | Med | **`headline-rise` is undefined over a sequence.** It currently rises once across the whole clip. With beats it must either rise once (and beats 2..n appear with no entry) or rise per beat. Per beat is the useful reading and makes it the natural default for a timeline — but it is a decision, not an inference. → Q1. |
| **M4** | Med | **`layoutHeadline` already runs per frame.** 180 frames × a measure-and-shrink loop, today, for text that never changes. Adding beats without memoization multiplies it; D6's memoization removes it outright. |
| **L1** | Low | **`DEFAULT_DURATION_SEC` disagrees across layers:** `6` in `GenerateCampaignUseCase` (the actual fallback), `5` in `editor-state.ts` (the first duration the editor offers). A brief with no duration axis runs 6 s while the editor's affordance says 5. |
| **L2** | Low | **`MAX_DURATION_SEC = 60` in the compositor vs `maxDurationSec: 600` on the YouTube profile.** A platform-legal 90 s clip cannot be encoded. Pre-existing; a timeline authored against the profile's cap would meet it. |

---

## 3. Target Design

### 3.1 Brief shape

```yaml
copy:
  timeline:
    transition: fade        # cut | fade          (D9)
    keyBeat: 1              # 1-based; posters and stills use this beat's text (D7)
    beats:
      - { text: "New season, new kit", weight: 2 }
      - { text: "Built for the cold",  weight: 3 }
      - { text: "Shop now",            weight: 2 }
```

`campaignMessage` remains required and unchanged — it is the still-format copy and the fallback for
any renderer without a timeline. `copy.timeline` is additive and optional (D10).

### 3.2 Domain — `CopyTimeline.vo.ts`

```ts
export const MIN_DWELL_SEC = 1.2;
export const MAX_BEATS = 8;

export interface CopyBeat   { readonly text: string; readonly weight: number }
export interface CopyTimeline {
  readonly beats: readonly CopyBeat[];
  readonly transition: "cut" | "fade";
  readonly keyBeat: number;
}
export interface ResolvedBeat {
  readonly text: string;
  readonly startT: number;   // inclusive
  readonly endT: number;     // exclusive; last beat ends at exactly 1
  readonly fadeInT: number;  // width in t, 0 for cut and for beat 1
}

/** Beats → t-windows. Duration is needed only to bound the fade width (D9). */
export function resolveTimeline(t: CopyTimeline, durationSec: number): readonly ResolvedBeat[];

/** The beat pair live at `t`, with the crossfade mix in [0,1]. */
export function beatAt(resolved: readonly ResolvedBeat[], t: number):
  { readonly current: ResolvedBeat; readonly incoming?: ResolvedBeat; readonly mix: number };

/** Authoring rule (D3): beats × MIN_DWELL_SEC ≤ shortest duration the axis can draw. */
export function timelineProblem(t: CopyTimeline, durations: readonly number[]): string | undefined;
```

Resolution is `startT_i = Σw_{<i} / Σw`, so the windows are **identical for every duration** — the
property that makes D2 possible. `endT` of the final beat is pinned to `1` rather than accumulated,
so float drift cannot leave a one-frame gap at the end of the clip.

### 3.3 Compositor

`PreparedCreative` gains `timeline?: readonly ResolvedBeat[]` and `beatLayouts?: Map<string, HeadlineLayout>`:

- `prepare` resolves the timeline once, fits every beat, takes the **minimum** fitted size across
  beats (D6) and re-lays every beat at that size, caching by text.
- `draw` picks `beatAt(prepared.timeline, t)`; with `mix > 0` it paints the outgoing beat at
  `1 - mix` and the incoming at `mix`. `headline-rise` applies its `dy`/`alpha` **per beat**,
  against that beat's local progress (Q1).
- With `prepared.timeline === undefined`, `draw` takes today's branch, untouched.
- `CompositeRequest` (the still path) has no `durationSec`, so stills never resolve a timeline; the
  still renders `message`, and the *poster* is drawn by asking `draw` for the key beat's window
  midpoint rather than `restT` alone (D7).

### 3.4 Orchestration

- `renderMotionVariant` builds `sampleAt` as `MOTION_SAMPLE_AT ∪ beat midpoints` (D8).
- The existing deduped legal-copy sweep grows the timeline's beat texts (D4) — one line at `:362`.
- `GeneratedAsset.descriptor` records `beats: n` so the grid and report can show it.
- `PlanCapacity` is untouched (D5: the timeline is not an axis).

### 3.5 Editor (`apps/web`)

The Copy section gains a **Timeline** sub-panel, revealed when `formats` includes `motion`:

- An ordered, drag-reorderable beat list. Each row: text input with **Insert from pool** (D4),
  a weight **Stepper** (1–5), and a delete. **Add beat** is disabled at `MAX_BEATS`, and disabled
  with a reason when adding one would breach the D3 floor — the same "the ceiling is the point"
  idiom as #82's count slider.
- A **proportion bar** under the list: one segment per beat, width = weight share, labelled with
  the resolved seconds **for each duration in the axis** (`at 5 s · at 15 s`). This is the whole
  argument for weights made visible.
- A **key beat** radio on each row (D7).
- **Transition** as a two-value toggle (D9).
- Capability-off renders the panel read-only with the reason and `toBrief()` preserves it verbatim
  (D11/D12).

---

## 4. Work Breakdown

### E1 — Domain (`packages/CampaignOrchestration`)

| # | Task | Files |
|---|------|-------|
| E1.1 | `CopyTimeline.vo.ts`: types, `resolveTimeline`, `beatAt`, `timelineProblem`, `MIN_DWELL_SEC`, `MAX_BEATS` | new VO + barrel |
| E1.2 | `CampaignBrief.copy?.timeline` (optional, documented as additive) | `entities/CampaignBrief.ts` |
| E1.3 | Unit tests: weight → window arithmetic at 3 durations proving identical `t`; last window pinned to 1; single beat ≡ no timeline; dwell floor boundary at exactly `n × 1.2`; `beatAt` at every boundary and inside every fade | `__tests__/copy-timeline.test.ts` |

### E2 — Compositor (`packages/CreativeGeneration`)

| # | Task | Files |
|---|------|-------|
| E2.1 | `PreparedCreative.timeline` + `beatLayouts`; resolve and fit in `prepare` | `NodeCanvasCompositor.ts` |
| E2.2 | Common type size across beats (D6); memoize layout by text (also removes the per-frame autofit, M4) | `NodeCanvasCompositor.ts` |
| E2.3 | `draw`: beat selection, crossfade, per-beat `headline-rise` | `NodeCanvasCompositor.ts` |
| E2.4 | `VideoCompositeRequest.timeline`; poster drawn at the key beat (D7) | `CanvasFfmpegVideoCompositor.ts`, `VideoCompositorPort.ts` |
| E2.5 | **Byte-identity test (D10):** a request with no timeline produces the same bytes as `main` for a fixed seed | `__tests__/` |

### E3 — Orchestration

| # | Task | Files |
|---|------|-------|
| E3.1 | Beat texts join the deduped legal-copy gate (D4) | `GenerateCampaignUseCase.use-case.ts` |
| E3.2 | `sampleAt` union with beat midpoints (D8) | same |
| E3.3 | `descriptor.beats` on the motion asset; report line names the beat count | same, `report.ts` |
| E3.4 | Fix L1: one `DEFAULT_DURATION_SEC`, exported from the domain and imported by the editor | domain + `editor-state.ts` |

### E4 — API

| # | Task | Files |
|---|------|-------|
| E4.1 | `parseBrief` accepts `copy.timeline`; structural validation in authoring mode, D3 floor + capability in running mode (D11) | `load-brief.ts` |
| E4.2 | Reject: empty beats, `weight < 1`, non-integer weight, `keyBeat` out of range, `> MAX_BEATS`, unknown `transition` — each naming the field, per the existing parser idiom | same |

### E5 — Editor

| # | Task | Files |
|---|------|-------|
| E5.1 | `EditorState.timeline` + reducer actions (add/remove/reorder/setText/setWeight/setKeyBeat/setTransition); `toBrief`/`fromBrief` round-trip incl. capability-off preservation | `editor-state.ts` |
| E5.2 | `TimelineSection` sub-panel: beat rows, Stepper weights, Add disabled with a reason at the D3 floor | `sections/CopySection.tsx` + new component |
| E5.3 | Proportion bar with per-duration second labels | same |
| E5.4 | **Insert from pool** — reuse `HeadlinePoolPanel`'s approved-text source (D4) | same |
| E5.5 | `validate.ts` mirrors `timelineProblem`; errors surface in the section's issue count (the #82 accordion aside) | `campaign/validate.ts` |
| E5.6 | `DESIGN.md` §4: the beat row and the proportion bar | `DESIGN.md` |

---

## 5. Definition of Done

- A brief with three beats and `duration: [5, 15]` produces a 5 s and a 15 s clip whose copy changes
  at the **same proportional points**, verified by sampling `t` in the adapter test — not by eye.
- A brief with **no** `copy.timeline` produces byte-identical output to `main` (D10), asserted.
- Every beat text appears in the legal-copy gate's deduped input; a prohibited term in beat 3 halts
  the run with beat 3 named.
- Every beat is represented in `sampledFrames`; the recorded `complianceScore` is the minimum across
  a set that includes one frame from each beat.
- The poster of a `ken-burns-out` motion variant and of a `ken-burns-in` one show the **same** beat.
- The editor cannot author a timeline that breaches the dwell floor: **Add beat** is disabled with a
  reason naming the shortest duration in the axis.
- The proportion bar's labels match `resolveTimeline` for every duration in the axis (one test
  asserts the UI's numbers against the VO's, so they cannot drift).
- Capability-off: a loaded timeline brief renders read-only with the reason, saves verbatim, and is
  rejected only by `generate`/`plan`.
- Gate: `build`, `typecheck`, `lint` 0 problems, `lint:arch`, `sync:check` 0 ops, `test:cov` 100 %.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Encode cost rises — more distinct canvas states per clip | D6's memoization removes the existing per-frame autofit; net cost should *fall*. Measure `compositeVideo` wall-clock before/after on a 6 s 1080×1920 clip and record it in the PR. |
| Crossfade doubles text draws in the transition window | Bounded to ≤ 0.4 s of a clip and only between beats; ≤ 12 frames per boundary at 30 fps. |
| The proportion bar is the feature's whole argument; if it is unclear the weights model feels arbitrary | Label with real seconds per duration, not percentages. Treat it as the section's primary control, not a decoration. |
| `MAX_BEATS = 8` is a guess | It is a guard, not a design claim; it exists so the layout pass is bounded. Raise it on evidence. |
| Scope creep into per-variant copy sequences | D5 draws the line explicitly; Q3 parks it. |

---

## 7. Open Questions

- **Q1 — `headline-rise` over a sequence: per beat, or once?** Recommendation: **per beat**, using
  each beat's local progress, which makes it the natural default motion for a timeline. Once-only
  would leave beats 2..n appearing with no entry animation while beat 1 rises. (M3)
- **Q2 — Should the timeline apply to *stills* too, via the key beat?** Recommendation: **no** in
  v1. A still brief has no `t`; using the key beat's text would silently change existing static
  output and break D10's byte-identity. `campaignMessage` stays the still's copy.
- **Q3 — Do beats eventually draw from the pool per variant?** Deferred. It turns an ordered
  sequence into a variation axis, multiplying `axisProductSize` by `|pool|^beats` and requiring a
  distance metric over sequences (`DISTANCE_AXES` compares scalars today). Worth doing; not worth
  entangling with v1.
