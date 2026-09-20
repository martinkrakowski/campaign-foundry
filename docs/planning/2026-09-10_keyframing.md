# Keyframing — Architecture & Development Plan

**Date:** 2026-09-10 · **Status:** in progress. **Stale as of 2026-09-16: K1a, K1b, K2, K3 and K4 have all
shipped.**
**Verified against:** `main` at `ed5e2dc`.
**Replaces** the keyframe half of the retired `2026-09-08_motion-composition-implementation-plan.md`.

---

## 0. The question the retired plan did not answer

Motion is already described **three** times:

| Vocabulary                                                                       | Scope                              | What it animates                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MOTION_KINDS` — `ken-burns-in`, `ken-burns-out`, `headline-rise`, `accent-wipe` | the whole creative, one per render | image scale, headline offset, accent reveal — each with a declared `REST_T` so the poster is a defined frame |
| `TEXT_EFFECT_VALUES` — `fade-in`, `rise-in`, `slide-in`, `scale-in`              | the copy layer                     | entrance pose over an entrance window, on **beat-local** progress                                            |
| `CopyTimeline` — `beats`, `transition`, `keyBeat`                                | copy sequencing                    | _when_ the text changes, and which beat the poster shows                                                     |

All three resolve through **one easing**, `easeOutCubic`, deliberately: one source, both draw paths.

**The retired plan proposed keyframes as a fourth, parallel system with no account of how the four
compose.** That is the same defect as four layer orders — and this plan exists to not repeat it.

## 0.1 Proposed decisions

| id       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **K-D1** | **Keyframes are the primitive. The three existing vocabularies become named presets that expand to keyframe tracks.** They stay in the brief vocabulary and stay the default way a user asks for motion; underneath, each resolves to the same track model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | One source of truth for motion, the way `BriefTemplate.layers` is one source for order. A fourth parallel system is the thing the reconciliation was written to stop.                                                                                                                                 |
| **K-D2** | **No new bounded context.** Tracks are value objects in `CampaignOrchestration/domain`; resolution is a pure function beside `beatAt`; the compositor reads a resolved pose.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `CreativeGeneration` is adapters-only — every `domain/` and `application/` under it holds a `.gitkeep`, and ports live in `CampaignOrchestration`. A package owning its own ports would be the first, and needs a manifest change and a new inter-context dependency to pass `hexagen arch validate`. |
| **K-D3** | **A preset must expand to exactly the frames it renders today.** Byte-identity per frame is the acceptance test, not a similarity judgement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ~~There is no video byte golden — D10 freezes bytes nothing measures.~~ **Corrected 2026-09-13: the MP4 byte golden shipped in #326**, so the freeze is measurable today and K2's gate is checkable rather than aspirational.                                                                         |
| **K-D4** | **Keyframes are per layer, addressed by layer `id`, and follow the layer list.** A track on a layer that is absent or disabled resolves to nothing, silently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Anything else reintroduces a second addressing scheme beside `BriefTemplate.layers`.                                                                                                                                                                                                                  |
| **K-D5** | **`restT` survives as a first-class idea, and it is per _preset_, not per track.** Every preset declares the `t` at which its pose is the settled one, and the poster renders that frame. **Amended 2026-09-13 after plan review:** a K1 brief asked for it per track, which has no poster semantics — two tracks declaring different rest times leave no single frame for the still — and the code already agrees with the plan: `REST_T` is `Record<MotionKind, number>` (`MotionKind.vo.ts:9`), one rest frame per render.                                                                                                                                                                                                                    | D7 depends on it. A naive keyframe model loses the notion of "the frame the still should be".                                                                                                                                                                                                         |
| **K-D6** | **This cannot start before the motion path is list-driven — and that means VF1, not C1.** C1 made the _ground trio_ list-driven; `static-text`, `animated-text` and `logo` are still drawn in fixed positions afterward. **Not because a track on them would be meaningless** — the logo's position comes from `prepare()` in both paths and copy already composes a per-frame pose — but because there is **no single site to resolve a track by `id`** (`drawBeat` never holds a layer record, and two text layers collapse to one beat block), and because **z would be silently wrong**: an opacity track on a text layer the template puts below the shade would fade it above the shade in motion. See `2026-09-10_finishing-video.md` §3. | Keyframed per-layer motion is meaningless while `drawTimeline` draws three of five layers by name.                                                                                                                                                                                                    |

---

## 1. The model

A **track** binds one layer id to one animatable property and a list of stops:

- **Properties**, initially: `opacity`, `scale`, `dx`, `dy`. **Amended 2026-09-13:** this used to read
  "exactly what the compositor already moves", and that is **false for `accent-wipe`**, which
  animates the _extent of a clip_ over a fixed gradient — `fillRect(0, solidH, width, fadeH * wipe)`
  (`NodeCanvasCompositor.ts:1057`, `:1066`). A `scale` track would compress the gradient into the
  shorter rect and cannot be byte-identical. The compositor moves five things; four of them are
  track properties and the fifth is K2's problem to express, which §4 already flags as the gate.
  Nothing wider until something needs it — an unread property is the `props` mistake again (D134
  shipped a vocabulary the compositor still never reads).
- **Stops** are `{ t, value, easing? }` ~~with `t` in the same normalised clock the draw paths already
  share~~ — **superseded by K-D8:** a stop names its clock (`pose`, `beat` or `effect`).
- **Easing** defaults to `easeOutCubic`, the one the codebase already uses. A per-stop override is
  allowed; a second _default_ is not.
- **Resolution** is a pure function: ~~given tracks and `t`, return a pose per layer~~ — **superseded by K-D8:**
  given tracks, beats and a clock set, return a pose per layer plus a copy pose per (beat, mix). It is the
  keyframe analogue of `beatAt`, and it lives beside it.

**Presets expand into this.** `ken-burns-in` becomes a `scale` track on the image layer; `rise-in`
becomes `opacity` + `dy` on a copy layer over the entrance window; `accent-wipe` becomes whatever
reproduces its current reveal exactly. **The expansion is the specification** — if a preset cannot be
expressed as tracks, that is a finding about the model, not a licence to special-case it.

**`CopyTimeline` is not absorbed.** It sequences _content_, not motion — which text is on screen. It
stays as it is, and text-effect tracks play on beat-local progress exactly as they do now.

---

## 2. Lanes

| Lane    | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **K1a** | **Shipped.** **The track model, no resolver.** Easing moves to the domain (K-D7); `Track`/`Stop` value objects (K-D8) and `layerTracksProblem`, validated at both brief boundaries (K-D9's one refusal: a duplicate `t` on one track's same clock). **No compositor _behaviour_ change (one import), no rendering, no resolver.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Round-trips through YAML in declared key order (positional); an invalid track is refused at both boundaries; the compositor's goldens are unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **K1b** | **Shipped.** **The resolver.** `resolveTracks(layers, beats, clocks) → { byLayer, copy }` (K-D8), pure, beside `beatAt`, in `resolve-tracks.ts`. Composition per property (K-D9), folded in declaration order. **No caller in the compositor yet** — K2 wires it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Interpolation at the default easing per clock; the legacy single-beat path; a crossfade instant's two complementary `copy` mixes; `dy` tracks add and `opacity` tracks multiply in a fixture that proves fold order matters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **K2**  | **Shipped.** **Three of the four `MOTION_KINDS` are tracks, rendered from the resolver; the fourth (`accent-wipe`) stayed drawer-local, decided, not deferred.** `ken-burns-in`/`ken-burns-out` are a `pose`-clock `scale` track on the ground (`image`/`video`) layer (K-D8 fix-round-2's refusal of a `beat`/`effect`-clock ground track was never tested against, since neither kind needs one). `headline-rise` is `opacity` + `dy` `beat`-clock tracks on the text layer, resolved through `resolveTracks`'s `copy` bucket. `accent-wipe`'s motion is a clip extent no `TRACK_PROPERTIES` member represents and the accent layer is not in `TRACKABLE_LAYER_KINDS` at all — reusing an existing property as a stand-in would be a fifth property in disguise (K4's future hand-authored tracks would then read it two different ways depending on layer kind), so `motion-tracks.ts`'s `accentWipeFraction` keeps the wipe as `paintAccent`'s own drawer-local animation and only relocates the `motion === "accent-wipe"` comparison itself, out of the compositor. The vocabulary the user writes does not change. | **Per-frame byte-identity** for every motion kind across the canonical templates. Any drift stops the lane. **Met:** all 48 motion-golden cells, the mp4 byte golden, and the HL3 raster suite are unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **K3**  | **Shipped.** **The four `TEXT_EFFECT_VALUES` are tracks, rendered from the resolver, the same way K2 did the four `MOTION_KINDS`.** `motion-tracks.ts`'s `textEffectTracks(effect, spec, width, height)` expands each kind into a single-property, two-stop `effect`-clock track on the text layer — `fade-in` → `opacity`, `rise-in` → `dy`, `slide-in` → `dx`, `scale-in` → `scale` — with stops at `t = 0` and `t = CREATIVE_GEOMETRY.textEffect.entranceFraction`; holding past the last stop (`resolveTracks`'s own contract) reproduces the settled pose with no separate branch. The tracks join `copyMotionTracks`'s own tracks in the SAME layer entry, so one `resolveTracks` call folds both in the old composition order (K-D9) — `NodeCanvasCompositor.ts`'s `textEffectPose` switch is gone, and `drawBeat`/`drawStaticText` now just paint the resolved `Pose` directly.                                                                                                                                                                                                                                   | **Per-frame byte-identity** for every text effect across the canonical templates, including the beat-local windows and the settled-pose behaviour. **Met, corrected 2026-09-16:** the K3 PR's first cut claimed this was proven by the 48 motion-golden cells, the mp4 byte golden and the HL3 raster suite — a reviewer (Qodo) and the K3 lane's own mutation manifest both found that none of those three ever sets `prepared.textEffect`, so they proved nothing about text effects specifically. `NodeCanvasCompositor.text-effect-goldens.test.ts` (added same-day) closes the gap: 16 committed cells (four effects × legacy/timeline path × an entrance and a settled frame — the timeline cells sample the second beat's own window with `effectT` left undefined, so the beat-local fallback clock is what is pinned, not a caller-supplied one), on two platforms, recorded from `origin/main`'s pre-K3 `textEffectPose` and reproduced byte-for-byte on the K3 branch before being committed — this is the suite K3's own mutations now fail (one by a genuine 4-cell hash move, one by a crash before any hash is computed — see §5's premise retirement for which is which). The original three suites still stay unchanged (a real, if narrower, proof that K3 did not disturb the motion/HL3/mp4 paths), and the pre-existing exact-`toBe` drawn-output suite (`NodeCanvasCompositor.text-effect.test.ts`) is unchanged too — but the per-frame byte-identity claim for text effects specifically now rests on the new golden family, not on those three. |
| **K4**  | **Shipped.** **A layer's own hand-authored `tracks` (K1a) now reach the renderer.** All three `resolveTracks` call sites in `NodeCanvasCompositor.ts` (`drawSequencedCopy`, `paintBackground`, `drawStaticText`) spread `...(layer.tracks ?? [])` as the LAST element of the tracks array they build — after both synthesized sources (K2's motion tracks, K3's text-effect tracks) — so a hand-authored track and a preset's expansion on one (layer, property) **compose per K-D9** (no precedence rule): preset expansions fold **before** hand-authored tracks, K3's existing order, and that is the only order. `html` refuses tracks (K1a), so K4 (and K5) never offer tracks on an `html` layer.                                                                                                                                                                                                                                                                                                                                                                                                                   | **Met.** A hand-authored track renders (proven on all three call sites); a track on a disabled layer renders nothing and says nothing (K-D4, via the existing `isDisabledLayer` skip and `resolveTracks`'s own `enabledTracks`); a fold-order fixture (preset, then two authored opacity tracks) proves the declared order is the only one that reproduces the pinned float. `canonicalLayer` (K5/X16 territory) is out of scope for this lane.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **K5**  | **The editor surface** — whatever minimum lets a user see and adjust a track. **SHIPPED as the Tracks section of the layer sheet (`TrackForm.tsx`), §4.4 rules 1–7.** Its scope was deferred to `2026-09-16_studio-editor.md` §4.4, where SE6 and TL5 both say "this is K5". **Rule 8 — a preset motion kind's expansion shown read-only beside the authored stops (D140) — is TL7's, not dropped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Out of scope for this document beyond naming it; the acceptance it shipped against is §4.4 there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Order.** The video plan first — **VF2** (an MP4 byte golden) then **VF1** (the full order) — then K1 → K2 → K3 → K4. VF2 matters to K2 specifically: without a byte golden the "byte-identical preset expansion" gate can only compare frames, which is weaker than what D10 claims. **K2 is the gate**: if the four

> **Corrected 2026-09-13:** both VF1 (#328) and VF2 (#326) have **shipped**. This ordering reads as if they are ahead; they are behind, and K2's byte gate is checkable now.
> existing motions cannot be reproduced frame-for-frame as tracks, the model is wrong and the plan
> stops rather than shipping a second system beside the presets.

## 3. Definition of Done

- **K1a**: a track survives a brief round trip; `layerTracksProblem` (`layerPropsProblem`'s sibling)
  refuses malformed ones at both boundaries. No resolver, no compositor caller.
- **K1b**: `resolveTracks` is pure, beside `beatAt`, and returns the identity pose for a layer with no
  tracks. Still no compositor caller — K2 wires it.
- **K2 (shipped)**: `ken-burns-in`/`ken-burns-out`/`headline-rise` render byte-identically through the
  resolver, per frame, proven through `NodeCanvasCompositor.draw` (48 motion-golden cells, the mp4
  byte golden, the HL3 raster suite). `accent-wipe` stayed drawer-local (decided, not deferred — see
  its lane row); `restT` and the poster frame are unchanged for all four kinds.
- **K3 (shipped)**: the four text effects render byte-identically through the resolver, per frame,
  including the beat-local windows and the settled-pose behaviour, proven through
  `NodeCanvasCompositor.text-effect-goldens.test.ts` (16 committed cells: four effects × legacy/timeline
  path × entrance/settled frame, on two platforms, recorded from pre-K3 `main` and reproduced
  byte-for-byte on the K3 branch) — corrected 2026-09-16 from an earlier claim that the 48
  motion-golden cells, the mp4 byte golden and the HL3 raster suite proved this; none of those three
  ever sets a text effect, so they proved only that K3 left the motion/HL3/mp4 paths undisturbed, not
  that the text effects themselves are byte-identical. Those three remain unchanged as well.
- **K4 (shipped)**: presets and hand-authored tracks coexist, composing per K-D9 — proven at all three
  `resolveTracks` call sites in `NodeCanvasCompositor.ts` (`drawSequencedCopy`/`paintBackground`/
  `drawStaticText`) by `NodeCanvasCompositor.authored-tracks.test.ts`: an authored track changes the
  drawn frame and removing it restores the pre-change bytes, a disabled layer's authored track resolves
  to nothing (K-D4), and a three-track fold-order fixture (preset, then two authored opacity tracks)
  shows the declared order is the only one that reproduces the pinned float. Every existing golden
  family — the 48 motion-golden cells, the 16 text-effect-golden cells, the mp4 byte golden, and the
  HL3 raster suite — is unchanged, because no canonical template's layers carry `tracks`, so
  `layer.tracks ?? []` spreads empty everywhere those suites render.
- **Throughout**: `MOTION_KINDS` and `TEXT_EFFECT_VALUES` remain the brief vocabulary. A user who
  never writes a track sees no change, ever.
- **Interim contract (from K1a's merge until K3/K4 ship):** a brief that carries `tracks` validates
  and renders **exactly as it would without them** — accepted at both boundaries, inert everywhere
  else, because nothing calls `resolveTracks` with a layer's OWN `tracks` field yet (K2's tracks are
  synthesized from the motion kind, never read off a layer's stored `tracks`) and nothing in the
  text-effect path reads it either.

## 4. What this plan refuses

- **It does not add a fourth motion vocabulary.** K-D1 is the whole point: presets become sugar over
  one model, or this is not worth doing.
- **It does not create `packages/MotionComposition`.** K-D2.
- **It does not widen the property set speculatively.** Four properties, because four are what the
  compositor moves today. `blendMode`, `rotation` and the rest arrive when something renders them.
- **It does not start before VF1 (= C1's successor, #328).** K-D6 — and this line used to say _C1_, which K-D6 explicitly corrects: C1 made the ground trio list-driven, and what K1 needs is the whole motion path, which is VF1.
- **It does not accept "looks the same" as proof.** K-D3.

---

## 5. Premises

Each lane states the claim that makes it necessary, as a script that exits 0 **while the gap is still
open**. `yarn plan:verify` runs them. K1a shipped with no premise of its own: it was the model lane
every other K lane is downstream of, and it was audited as open at the time these were written; there
is nothing left to probe for its own gap now that it has merged. **Probe the thing
that decides, not a string near it** — a motion kind's _name_ may live on as preset vocabulary after
K2 ships, so these probes sit on the compositor's per-kind pose mechanism, not on the names.

**K1a — shipped in this PR.** `easeOutCubic` moved out of the compositor into
`packages/CampaignOrchestration/src/domain/value-objects/easing.ts` (K-D7, byte-neutral — one import
back into `NodeCanvasCompositor.ts`), which also declares the easing vocabulary (`EASING_KINDS`:
`ease-out-cubic`, `linear`) and `DEFAULT_EASING` — both read by K1b's `EasingKind → (t) => number`
table, not by anything in this PR. `Track`/`Stop` and `layerTracksProblem` (K-D8, K-D9) are new in
`packages/CampaignOrchestration/src/domain/value-objects/tracks.ts`, wired into both boundaries —
`isLayerEntry` (`brief-template.ts`) and the API's `validateTemplate` (`apps/api/server/lib/load-brief.ts`)
— and `CreativeTemplateLayer` gains an optional `tracks` field. `LAYER_KEY_ORDER`
(`packages/shared/src/infrastructure/brief-yaml.ts`) gains `tracks` as its sixth, last key, with its own
`TRACK_KEY_ORDER`/`STOP_KEY_ORDER`. No resolver, no compositor behaviour change, no rendering — K1b.

**`TRACKABLE_LAYER_KINDS` (plan review 2026-09-15, narrowed from the first cut): `image`, `video`,
`static-text`, `animated-text`** — the kinds K2/K3 drive. Every other kind refuses, each for its own
stated reason: `html` because it renders through two independent paths (the canvas drawer and the
markup assembler) and only the canvas path has any motion mechanism, so a track would render
differently depending on which produced the creative; `fill` because no creative type accepts it yet
(D131) and this compositor draws it nowhere; `shade` and `logo` because their drawers (`paintShade`,
`drawLogo`) read neither `eased` nor `motion` — no pose mechanism exists to apply a track to; `accent`
because its only motion, the wipe, is a clip-extent animation none of the four `TRACK_PROPERTIES`
represents (§1's amendment). Widening is additive and never breaks a stored brief (`accent` once K2
gives the wipe a representable property, `shade`/`logo` with a generic per-drawer pose wrapper);
narrowing later would refuse tracks a brief already carries, which is why the first cut (every drawn
kind) was too wide. The duplicate-`t` refusal (K-D9) is scoped **per clock** (K-D8): a track's stops
may be declared in any order, and only a repeated `t` within one clock's own subsequence is refused —
the same `t` on two different clocks in one track is not a duplicate.

**K1b — shipped in this PR.** `resolveTracks(layers, beats, clocks) → { byLayer, copy }` (K-D8), pure,
beside `beatAt`, is new in `packages/CampaignOrchestration/src/domain/value-objects/resolve-tracks.ts`
(kebab-case, outside the manifest inventory like `tracks.ts`/`easing.ts` — verified empirically,
`arch:inventory` clean and `sync:dry` at Total ops 0, not assumed). It takes the layer list, `{ id,
enabled?, kind, tracks? }[]` — not bare tracks — because K-D4 addresses a track by the layer it nests
on, and "absent, disabled or trackless resolves to the identity pose" needs the `enabled` flag in
hand, not just the tracks; a layer id `resolveTracks` never saw reads the same way through the new
`poseOf(resolved, id)` helper, which defaults a missing `byLayer` key to `IDENTITY_POSE`. `Pose = {
dx, dy, opacity, scale }` is the new domain type, identities `0, 0, 1, 1`. The legacy (timeline-less)
path never calls `beatAt` — it uses one implicit beat spanning `[0, 1]` (exported as `IMPLICIT_BEAT`)
with `local = t` exactly, per K-D8; with a real timeline the beat is selected by `beatAt(beats,
clocks.copyT ?? clocks.t)`, and a crossfade instant yields two live beats, which is why `copy` is one
entry per `(beat, mix)` — folded across every enabled, tracked text-kind layer (`static-text`,
`animated-text`) into ONE pose per beat (K-D6: two text layers already collapse to one beat block),
never one entry per layer. A stop's `t` reads one of three clocks (K-D8) — `pose` is `clocks.t`
directly, `beat` is the beat-local progress `NodeCanvasCompositor.drawBeat` already computes, `effect`
is `effectT ?? local` (unifying the compositor's `effectT ?? local` / `effectT ?? t`, since the legacy
path's `local` IS `t`). **A track's stops all share one clock** — the one its first stop names —
**and `beat`/`effect` clocks are refused on any kind but `static-text`/`animated-text`** (both fix
round 2, review found after the first merge): `layerTracksProblem` originally let a track mix clocks
across its stops and let `image`/`video` carry a `beat`/`effect`-clock track, and the resolver
silently ignored what neither rule could give a defined meaning to — a mixed-clock track's off-clock
stops (data loss with no message, the exact defect this domain refuses everywhere else), and, for a
`beat`/`effect`-clock track on a ground layer, WHICH of the (at most two) live beats during a
crossfade its local progress would even read (nothing decides that; `byLayer` folds a non-text kind
at `clocks.t` alone now, never needing a beat at all). Both are refused at the boundary instead,
`layerTracksProblem` now taking `kind` down to the per-stop check that used to only see the stops
themselves. Two tracks on one (layer, property) fold in **declaration order** (`dx`/`dy` add,
`opacity`/`scale` multiply); a fixture proves the order matters, but needs **three** tracks, not two,
to do it — IEEE-754 multiplication is exactly commutative for a single pair (`a * b === b * a`, bit
for bit), so a two-operand product can never distinguish a fold from its reverse. `easing.ts` gains
the `EasingKind → (t) => number` table (`EASINGS`) K1b reads instead of switching on the string. Red
tests shown before each implementation, at all three points (the resolver, the domain boundary,
`isBriefTemplate`/`validateTemplate` — the last two share `layerTracksProblem`, so one function fix
closes both); `mutate:verify .agents/manifests/k1b.json`: 4 mutations re-run, all caught (the ending
stop's easing leaking into the segment before it; the fold folding in reverse declaration order,
caught only by the three-track fixture above; the one-clock-per-track refusal, caught at all three
boundaries with fixtures using distinct `t` values per clock so a coincidental duplicate-`t` refusal
cannot pass the assertion for the wrong reason; the beat/effect-needs-a-text-layer refusal, likewise
at all three boundaries).

**K2 — shipped in this PR.** `packages/CampaignOrchestration/src/domain/value-objects/motion-tracks.ts`
is the preset→track expansion, a pure function beside `beatAt` (K-D2): `groundMotionTracks(motion)`
expands `ken-burns-in`/`ken-burns-out` into a `pose`-clock `scale` track on the ground layer,
`copyMotionTracks(motion, height)` expands `headline-rise` into `beat`-clock `opacity`/`dy` tracks
on the text layer (resolved through `resolveTracks`'s `copy` bucket, K-D6), and `accentWipeFraction`
is the fourth kind's own decision (below) — not a track. Both expansion functions build SYNTHESIZED
tracks fresh from the motion kind on every draw, never reading a layer's own stored `tracks` field
(that stays K4's), so `paintBackground` and `drawStaticText`/`drawSequencedCopy` feed them straight
into `resolveTracks`/`poseOf` and read back `dx`/`dy`/`opacity`/`scale` — no `motion === "<kind>"`
comparison remains in `NodeCanvasCompositor.ts`, closing this premise (`grep -qE 'motion === "(ken-burns-in|ken-burns-out|headline-rise|accent-wipe)"' packages/CreativeGeneration/src/infrastructure/adapters/NodeCanvasCompositor.ts`
now exits 1). `LayerDrawContext` gained one field, `t` (the raw pose clock) — `resolveTracks` applies
its own per-stop easing internally, so a track-driven drawer must read the clock `draw()` was called
with, not the pre-eased `eased` the wipe still uses. `drawBeat`'s signature changed from a `rise:
boolean` to a resolved `pose: Pose`, sourced from ONE `resolveTracks` call per `drawSequencedCopy`
invocation against the real `scenes.resolved` beats — its internal beat pairing (`beatAt(scenes.resolved,
copyT)`) is the exact same pairing `drawSequencedCopy` already computed by hand, so `resolved.copy`
carries the same `(current, incoming)` order the old crossfade branch drew in. The legacy
(timeline-less) path (`drawStaticText`) uses `resolveTracks`'s own `beats: []` shortcut — one implicit
beat with `local = t` (K-D8) — which is exactly that path's contract, not a workaround.

**The accent-wipe decision (option b, not a): the wipe did NOT become a track.** Its motion is a clip
extent (`fillRect(..., fadeH * wipe)`) that none of `TRACK_PROPERTIES` represents, and the accent
layer is not in `TRACKABLE_LAYER_KINDS` at all (`tracks.ts`, deliberately, for the same reason).
Reusing an existing property — say, `opacity` — as a stand-in for a clip fraction would be a fifth
property in disguise: a hand-authored `opacity` track on an accent layer (K4, later) would then mean
something different from an `opacity` track on every other trackable kind, an ambiguity this lane
declines to introduce for one kind. So `paintAccent` keeps computing the wipe itself; only the
`motion === "accent-wipe"` comparison moved, into `accentWipeFraction`, closing the premise for this
kind the same way the other three close it by becoming tracks.

**Floating-point note, because the gate is byte-identity, not similarity (K-D3):** `resolveTracks`'s
fixed fold (`a.value + (b.value - a.value) * ease(progress)`) reassociates the old per-kind formulas
(`1 + Z * (1 - eased)` for ken-burns, `(1 - eased) * C` for the rise's `dy`) into a different order of
floating-point operations — bit-identical at the two stops themselves (`t = 0`, `t = 1`, one of which
is every kind's `restT`, where `resolveTracks` returns a stop's own value with no arithmetic at all)
and within the last bit of a double at an interior `t` otherwise (the rise's `opacity` track is the one
exception: `0 + (1 - 0) * eased` has no rounding at all, bit-identical everywhere). Proven, not assumed,
not to move a pixel: all 48 motion-golden cells, the mp4 byte golden, and the HL3 raster suite are
unchanged (`NodeCanvasCompositor.motion-goldens.test.ts`, `CanvasFfmpegVideoCompositor.byte-golden.test.ts`,
`NodeCanvasCompositor.layer-order.test.ts`). Red tests shown before the implementation (the domain
equivalence tests against a nonexistent module, then against a deliberately broken one; the
flat-background drawn-output test's own false negative, fixed before it proved anything);
`mutate:verify .agents/manifests/k2.json`: 2 mutations re-run, both caught (swapping the ken-burns
in/out expansion; dropping the accent wipe's progress to a constant 1) — both ALSO move a motion
golden, verified empirically before writing the manifest, worth stating because K1b's own mutations
found the opposite case (an equivalence bug the goldens could not see).

**K3 — shipped in this PR.** `motion-tracks.ts`'s `textEffectTracks(effect, spec, width, height)`
expands each of the four `TEXT_EFFECT_VALUES` into a single-property, two-stop `effect`-clock track
on the text layer — `fade-in` → `opacity` (`0 → 1`), `rise-in` → `dy`
(`riseOffsetFraction * height → 0`), `slide-in` → `dx` (`slideOffsetFraction * scaleBasis(spec, width,
height) → 0`), `scale-in` → `scale` (`1 - scaleAmplitude → 1`), stops at `t = 0` and
`t = CREATIVE_GEOMETRY.textEffect.entranceFraction` — reproducing `NodeCanvasCompositor.ts`'s old
`textEffectPose` switch, which is now gone: `grep -qE 'case "(fade-in|rise-in|slide-in|scale-in)"'
packages/CreativeGeneration/src/infrastructure/adapters/NodeCanvasCompositor.ts` no longer matches.
Holding a track's value past its last stop (`resolveTracks`'s own `sampleStops` contract) reproduces
the old settled pose with no separate "past the window" branch needed in the expansion. The entrance
window is expressed as stop positions, not re-read as a fraction inside the resolver path — the
constant stays in the expansion, exactly as K2 put `KEN_BURNS_ZOOM` there, and it is read from
`CREATIVE_GEOMETRY.textEffect` (the same leaf the web's preview reads) rather than copied into a
local literal.

The effect's tracks join `copyMotionTracks`'s own tracks in the SAME layer entry — one `resolveTracks`
call per draw path (`drawSequencedCopy` for the timeline path, `drawStaticText` for the legacy path),
folding both in the OLD composition order (K-D9: motion tracks first, effect tracks second, matching
`opacity = (riseAlpha * fx.alpha) * layerAlpha`). `drawBeat` no longer computes a text-effect pose of
its own — it paints the already-composed `Pose` `resolveTracks` returns.

`fade-in`'s `opacity` fold (`0 + (1 - 0) * eased`) has no rounding at all, bit-identical everywhere,
exactly like `headline-rise`'s own opacity track (K2). `rise-in`/`slide-in`/`scale-in` reassociate the
old per-kind formula into the fixed `a.value + (b.value - a.value) * ease(progress)` fold — bit-identical
at the two stops themselves and within the last bit of a double at an interior `t` otherwise, the same
finding K2 recorded. Red tests shown before the implementation (the per-effect equivalence tests against
a nonexistent `textEffectTracks`, computed independently from the old formula).

**Correction, 2026-09-16 (reviewer + K3's own mutation manifest found a gap the first cut of this PR
missed):** the first cut of this section claimed the reassociation was "proven, not assumed, not to move
a pixel" by the 48 motion-golden cells, the mp4 byte golden and the HL3 raster suite. Those three suites
ARE unchanged (`NodeCanvasCompositor.motion-goldens.test.ts`, `CanvasFfmpegVideoCompositor.byte-golden.test.ts`,
`NodeCanvasCompositor.layer-order.test.ts`), and the pre-existing `NodeCanvasCompositor.text-effect.test.ts`
drawn-output suite (byte-for-byte pose assertions on the live blit) is unchanged too — but none of the
three named golden suites ever sets `prepared.textEffect`, so none of them is evidence about text effects
specifically, only that K3 left the motion/HL3/mp4 paths it did not touch alone. `mutate:verify
.agents/manifests/k3.json`'s first run (2 mutations: swapping the fade-in/rise-in expansion; dropping
scale-in's entrance-window stop) proved this empirically — neither mutation moved any of the three named
goldens, only the domain equivalence test and the drawn-output suites caught them.

`NodeCanvasCompositor.text-effect-goldens.test.ts` closes the gap: 16 committed cells (four
`TEXT_EFFECT_VALUES` × two draw paths × an entrance frame and a settled frame), on one canonical
template, on both `darwin-arm64` and `linux-x64`. The `legacy` path is the clip shape with no timeline
at all (`effectT` falls back to `t`); the `timeline` path is the clip shape too, but with a real
two-beat `cut` timeline and `effectT` left undefined, sampled inside the SECOND beat's own window, so
the effect clock exercises the beat-local fallback (`effectT ?? local`) K1b/K3 actually added, not a
caller-supplied settled clock — and the two paths paint different beat text, so a passing suite is
evidence the timeline path was actually taken, not merely that some hash was computed. The baseline was
recorded from `origin/main` at `5aef4155` (pre-K3, `textEffectPose`'s own switch) — a scratch worktree
for `darwin-arm64`, a `linux/amd64` Docker container (`node:22-bookworm`) for `linux-x64` — then
reproduced byte-for-byte on the K3 branch (in the same two environments) before being committed; the
main-produced bytes are what shipped. All 32 cells (16 × 2 platforms) matched exactly — no divergence
to report. Re-running `mutate:verify .agents/manifests/k3.json` with the new suite added to each
mutation's command: (a), the fade-in/rise-in swap, now FAILS this suite too, but via a `TypeError`
(`textEffectTracks` returns `undefined` for the now-unmatched `"fade-in"` case, spread into the tracks
array) thrown before any hash is computed — it does not move a golden cell, it errors out; stated
precisely rather than folded into "moves a golden". (b), dropping scale-in's entrance stop, IS a
genuine hash mismatch: exactly the four scale-in cells (legacy/timeline × entrance/settled) move, all
landing on the same stuck-at-0.88 hash per platform, while the other twelve cells stay exactly as
committed. The three ORIGINAL named goldens still do not move under either mutation, for the same
reason as before (they never set `prepared.textEffect`) — that fact stands, it is simply no longer
being cited as proof of the text-effect claim.

**K4's premise is restated in the amendments below**, because the original would have been
retired by K1's own merge.

**K5 — shipped.** Its fence is retired here rather than left behind: the word "track"
now appears throughout `apps/web/src/components/campaign` — `TrackForm.tsx`, the three
track actions in `editor-state.ts`, and their messages — so the grep it ran can no longer
flip, and a stale fence is a stale report rather than a closed lane.

---

## Amendments, 2026-09-13 (plan review)

**Where a track lives: on the layer.** `layers[i].tracks`. A top-level `motion.tracks[]` with a
`layer` field is the second addressing scheme **K-D4 refuses**, and D128 already makes the layer list
the one place a layer is named. The cost is real and is accepted: `LAYER_KEY_ORDER` in
`packages/shared/src/infrastructure/brief-yaml.ts:30` gains a **sixth** key — it already carries five
(`id`, `kind`, `enabled`, `props`, `elements`; HL1 added the last in #354), and an earlier draft of
this amendment cited that line and miscounted it, so K1's "round-trips in
declared key order" proof reaches `packages/shared`, and the boundary check pairs with
`layerPropsProblem` in `brief-template.ts` rather than inventing a sibling convention. Tracks cannot
go under `props`: `layerPropsProblem` refuses any field outside the per-kind allowlist.

**A stop names its clock.** `headline-rise` runs on **two**: beat-local on the timeline path
(`local = clamp01((t - beat.startT) / (beat.endT - beat.startT))`, `NodeCanvasCompositor.ts:968`) and
global `eased` on the legacy path (`:1085`). §1's "the same normalised clock the draw paths already
share" was wrong. A stop declares which clock its `t` is in, or K2 cannot express `headline-rise` as
one track.

**Expect ulp-level drift as K2's first finding, not model failure.** Today
`riseDy = (1 - eased) * 0.12 * prepared.height`; a track lerp `v0 + (v1 - v0) * eased` is a different
float expression and may differ in the last bit. K-D3's per-frame byte gate is right and should be
kept — but the first red is more likely arithmetic than a wrong model.

**The completing PR retires its own premise fence.** `plan:verify` runs in CI, so a lane that ships
and leaves its fence behind fails its own build.

### K4's premise, rewritten now that K1b's resolver exists (K1b fix round)

The previous two attempts (recorded in git history) grepped the whole `CampaignOrchestration/domain`
tree for a _name_ — first "precedence" near "preset"/"track"/"authored" including comments (K1a's own
doc comment would have matched it), then a `SCREAMING_SNAKE` rule-constant guess. Both failed the same
way: **a decision has no fixed name**, so no string search reliably detects one. K-D9 also superseded
the premise's original framing — composition (not precedence) was fixed in K1, so K4 was never going
to add a rule-naming constant for this fence to find.

A third attempt (this PR's first pass, since replaced) probed `canonicalLayer`
(`apps/web/src/components/campaign/editor-state.ts`) instead — a concrete file, not a decision name —
but review found two defects: it could fail SAFE forever (K4 might defer the editor's canonical-form
handling of hand-authored tracks to K5), and worse, the line it watched for
(`layer.tracks`) has a word boundary at the `.` and so also flips K5's _existing_ fence
(`! grep -rqiE '\btracks?\b' apps/web/src/components/campaign --exclude-dir=__tests__`) — a K4 PR
retiring its own fence would flip K5's to STALE in the same commit, for a lane K4 did not ship.

**What K4 actually delivers** is not an editor default or a fold rule (K-D9 already fixed composition)
but the thing its own name says: **a brief's own tracks reaching the renderer** — a hand-authored
`layer.tracks` array read at the point K2/K3 already wired `resolveTracks` into
`NodeCanvasCompositor.ts`. That file is the right home for a K4 probe, and today it contains no
`.tracks` property access at all (checked, not assumed) — K2/K3 expand the four `MOTION_KINDS` and the
four text effects into _synthesized_ tracks (built from the motion/effect kind, not read off the
brief's layer) and pass those to `resolveTracks`; the interim contract (§3) is explicit that nothing in
the compositor reads a layer's `tracks` field until a lane makes it do so, and expanding a preset needs
no such read. K4 is that lane.

**K4 — shipped in this PR.** The read site is `NodeCanvasCompositor.ts`: all three `resolveTracks` call
sites (`drawSequencedCopy`, `paintBackground`, `drawStaticText`) now spread `...(layer.tracks ?? [])` as
the last element of the tracks array they build for that layer, after both synthesized sources (K2's
`copyMotionTracks`/`groundMotionTracks`, K3's `textEffectTracks`) — so a hand-authored track and a
preset's expansion on one (layer, property) compose per K-D9 (declaration order, never a precedence
rule): preset first, authored last, and that is the only order a fold-order fixture
(`NodeCanvasCompositor.authored-tracks.test.ts`) proves reproduces the pinned float. An absent
`layer.tracks` spreads an empty array, so every existing golden family — the 48 motion-golden cells, the
16 text-effect-golden cells, the mp4 byte golden, the HL3 raster suite — renders byte-identically,
because no canonical template's layers carry `tracks`. This fence (`! grep -q '\.tracks' …
NodeCanvasCompositor.ts`) now exits 1 — the file contains `.tracks` property accesses — so it is
retired here rather than left to flip `plan:verify` to STALE.

**K5 is now shipped.** K1–K4 have all shipped; K5 (the editor surface) can start. Its own premise
fence (below) stays live — nothing in `apps/web/src/components/campaign` reads or writes a track yet.

---

## K1 model decisions — owner 2026-09-15 (recommended defaults, plan-reviewed)

**K1 is dispatchable.** The three questions below are answered; the analysis that raised them stays under it as the record.
Several line references in that analysis have moved (e.g. `easeOutCubic` is now `NodeCanvasCompositor.ts:586`, not `:498`;
the poster clock sampling and the crossfade `drawBeat` calls have shifted) — **re-anchor by symbol, not line, when briefing.**

| id       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **K-D7** | **`easeOutCubic` moves to the domain** (`CampaignOrchestration` `domain/value-objects/easing.ts`, exported from the barrel); the compositor imports it back. K1's "no compositor change" means "no compositor **behaviour** change" — one import, byte-neutral.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **K-D8** | **A stop names its clock**: `clock: "pose" \| "beat" \| "effect"`. `pose` reads `clocks.t` directly. `beat` is beat-local progress — **corrected 2026-09-15 (mechanism, not the decision):** _which_ beat is current comes from `clocks.copyT`, via `beatAt(scenes.resolved, copyT)` inside `drawSequencedCopy` (`NodeCanvasCompositor.ts` ~1037), but the progress _within_ that beat runs on the **pose clock**: `local = clamp01((t - beat.startT) / (beat.endT - beat.startT))` (~1064) — `copyT` selects the beat, `t` is the axis the progress itself reads. `effect` reads `clocks.effectT`, falling back to the beat-local clock (`local`) on the timeline path and to `t` on the legacy path — unifying `effectT ?? local` with `effectT ?? t`. The poster samples all three independently: `t = restT(request.motion)`, `copyT = posterCopyTAt(...)` (`CanvasFfmpegVideoCompositor.ts` ~122, ~124), `effectT = 1`. The resolver is `resolveTracks(layers, beats, clocks: { t, copyT?, effectT? }) → { byLayer: Map<layerId, Pose>; copy: ReadonlyArray<{ beat, mix, pose }> }` — `layers`, not bare `tracks`, per K-D4 (shipped in K1b). The legacy (timeline-less) path is one implicit beat spanning [0, 1] with `local = t`. The copy pose is per **(beat, mix)** because `drawBeat` runs twice at one instant during a crossfade. **Amended K1b review, fix round 2:** a track's stops all share ONE clock — the one its first stop names; two clocks on one property is two single-clock tracks, composing per K-D9, not one track mixing clocks (the resolver has no meaning for that and previously dropped the off-clock stops silently). And `beat`/`effect` clocks are refused on any kind but `static-text`/`animated-text`: both clocks need a _beat_ to be local against, and only a text layer's pose is resolved per beat (`resolveTracks`'s `copy`, K-D6) — `image`/`video` resolve into `byLayer`, one pose per layer with no per-beat multiplicity, so during a crossfade there is no defined answer for which of the (at most two) live beats' local progress such a track would read; refused rather than resolved to an arbitrary, discontinuous one. Both refusals live in `layerTracksProblem` (`tracks.ts`), read at both brief boundaries. |
| **K-D9** | **Two tracks on one (layer, property) compose; they are never refused.** Operators are fixed per property: `dx`/`dy` **add**, `opacity`/`scale` **multiply**. K1's validator refuses only a stop set with duplicate `t` on one track (per clock, K-D8; declaration order of stops is free). K3 folds in today's order — `opacity = (riseAlpha * fx.alpha) * layerAlpha` — because float multiplication is not associative and the byte gate would move otherwise. K4's "precedence" framing is superseded: composition is fixed in K1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Risk carried: the `(beat, mix)` shape brings `CopyTimeline` into the resolver's signature; the alternative (per-layer pose only,
`drawBeat` keeps its own clock) makes K1 simpler but K3 unable to be byte-identical.

## K1 was not dispatchable — the three model decisions (answered above)

The K-D6 gate is satisfied (VF1 = C5, #328). What blocks an honest stage-1 author is that three
questions cannot be answered without contradicting something the plan already says. **A lane that has
to guess one of these will encode the guess in a test**, which is the failure the two-stage pass
exists to prevent.

**1. Where `easeOutCubic` lives.** The only definition is `NodeCanvasCompositor.ts:498` and it is not
exported. K-D2 puts the resolver in the domain; §1 says the default easing is "the one the codebase
already uses" and forbids a second default; K1 says "no compositor change". All three cannot hold.
**Decide:** move it to the domain and let the compositor import it back — it already imports from
`@campaignfoundry/CampaignOrchestration` (`NodeCanvasCompositor.ts:26`), so the cost is one import and
K1's "no compositor change" becomes "no compositor _behaviour_ change", which is what it meant.

**2. The resolver signature — there are three clocks, not two.** `t`, the copy clock, and `effectT`
(`NodeCanvasCompositor.ts:259-263`), and the poster samples all three **independently**:
`restT(request.motion)`, `posterCopyTAt(…)`, and `1` (`CanvasFfmpegVideoCompositor.ts:112-119`). A
resolver of `(tracks, t) → pose` cannot render the poster. It takes a **clock set**. And during a
crossfade `drawBeat` runs twice at one instant (`:943-945`), each with its own `local`, so the
timeline path has a pose per **(layer, beat)** — not per layer, as §1 says.

**3. Two tracks on one (layer, property).** The compositor already composes two presets there:
`dy = riseDy + fx.dy` and `alpha = riseAlpha * fx.alpha` (`:978-979`, `:1093-1094`) — `headline-rise`
and `rise-in` both drive copy `dy`. §1 says a track binds one layer to one property and is silent on
two sharing one. K1's validator must **refuse or compose**, and the plan assumes this is K4's
question. It is K3's at the latest, and K1's if the boundary is to refuse it.

**Smaller, and an author can carry them once stated:** `LAYER_KEY_ORDER` gains a sixth key, not a
fifth; neither boundary refuses an unknown layer key today, so `layerTracksProblem` is new work at
**both** (`isLayerEntry`, `brief-template.ts:339-362`, and `validateTemplate`, `load-brief.ts:255-327`),
shaped like `layerElementsProblem`; the round-trip proof needs a **positional** assertion, because
`orderedKeys` appends unnamed keys at the end and the suite already documents that escape
(`brief-yaml.test.ts:76-80`); and K-D4's "absent layer" clause is vacuous once tracks nest on the
layer — only "disabled" remains.

## Stale facts corrected

- **The MP4 byte golden exists** (VG, #326). K-D3's "There is **no video byte golden**" and §2's
  "VF2 then VF1" ordering are stale — K2's byte gate is checkable today.
- §4's "It does not start before C1" contradicts K-D6's "VF1, not C1". K-D6 is right.
- The header's "Verified against `main` at `ed5e2dc`" predates C5, VG and HL1.

## A limit of the premise mechanism, found here

**A premise can only detect a lane whose output has a detectable shape.** K4's output is a _rule_,
and a rule can be named anything — three fences failed in three different ways before this was
obvious. The mechanism is strong for lanes that add a file, a field, a call site or a branch, and
weak for lanes that add a decision.

Two consequences worth carrying:

- **A fence that cannot flip is silent.** `plan:verify` fails only on `STALE`, so a premise that
  always holds reads as coverage and provides none. The completing-PR rule — _retire your fence in
  the same commit_ — does not protect against it, because nothing fails to remind you.
- **Demonstrating a flip is not optional, and it is easy to demonstrate wrongly.** Two of the three
  broken fences here were declared working on the strength of a test that did not exercise them. The
  check is not "did I try" but "did I watch it change state, twice, in both directions".
