# Keyframing — Architecture & Development Plan

**Date:** 2026-09-10 · **Status:** in progress. **Stale as of 2026-09-15: "Nothing dispatched" —
K1a and K1b have both shipped; K2 (express the four `MOTION_KINDS` as tracks and render from the
resolver) is dispatchable next**, behind them.
**Verified against:** `main` at `ed5e2dc`.
**Replaces** the keyframe half of the retired `2026-09-08_motion-composition-implementation-plan.md`.

---

## 0. The question the retired plan did not answer

Motion is already described **three** times:

| Vocabulary | Scope | What it animates |
|---|---|---|
| `MOTION_KINDS` — `ken-burns-in`, `ken-burns-out`, `headline-rise`, `accent-wipe` | the whole creative, one per render | image scale, headline offset, accent reveal — each with a declared `REST_T` so the poster is a defined frame |
| `TEXT_EFFECT_VALUES` — `fade-in`, `rise-in`, `slide-in`, `scale-in` | the copy layer | entrance pose over an entrance window, on **beat-local** progress |
| `CopyTimeline` — `beats`, `transition`, `keyBeat` | copy sequencing | *when* the text changes, and which beat the poster shows |

All three resolve through **one easing**, `easeOutCubic`, deliberately: one source, both draw paths.

**The retired plan proposed keyframes as a fourth, parallel system with no account of how the four
compose.** That is the same defect as four layer orders — and this plan exists to not repeat it.

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **K-D1** | **Keyframes are the primitive. The three existing vocabularies become named presets that expand to keyframe tracks.** They stay in the brief vocabulary and stay the default way a user asks for motion; underneath, each resolves to the same track model. | One source of truth for motion, the way `BriefTemplate.layers` is one source for order. A fourth parallel system is the thing the reconciliation was written to stop. |
| **K-D2** | **No new bounded context.** Tracks are value objects in `CampaignOrchestration/domain`; resolution is a pure function beside `beatAt`; the compositor reads a resolved pose. | `CreativeGeneration` is adapters-only — every `domain/` and `application/` under it holds a `.gitkeep`, and ports live in `CampaignOrchestration`. A package owning its own ports would be the first, and needs a manifest change and a new inter-context dependency to pass `hexagen arch validate`. |
| **K-D3** | **A preset must expand to exactly the frames it renders today.** Byte-identity per frame is the acceptance test, not a similarity judgement. | ~~There is no video byte golden — D10 freezes bytes nothing measures.~~ **Corrected 2026-09-13: the MP4 byte golden shipped in #326**, so the freeze is measurable today and K2's gate is checkable rather than aspirational. |
| **K-D4** | **Keyframes are per layer, addressed by layer `id`, and follow the layer list.** A track on a layer that is absent or disabled resolves to nothing, silently. | Anything else reintroduces a second addressing scheme beside `BriefTemplate.layers`. |
| **K-D5** | **`restT` survives as a first-class idea, and it is per *preset*, not per track.** Every preset declares the `t` at which its pose is the settled one, and the poster renders that frame. **Amended 2026-09-13 after plan review:** a K1 brief asked for it per track, which has no poster semantics — two tracks declaring different rest times leave no single frame for the still — and the code already agrees with the plan: `REST_T` is `Record<MotionKind, number>` (`MotionKind.vo.ts:9`), one rest frame per render. | D7 depends on it. A naive keyframe model loses the notion of "the frame the still should be". |
| **K-D6** | **This cannot start before the motion path is list-driven — and that means VF1, not C1.** C1 made the *ground trio* list-driven; `static-text`, `animated-text` and `logo` are still drawn in fixed positions afterward. **Not because a track on them would be meaningless** — the logo's position comes from `prepare()` in both paths and copy already composes a per-frame pose — but because there is **no single site to resolve a track by `id`** (`drawBeat` never holds a layer record, and two text layers collapse to one beat block), and because **z would be silently wrong**: an opacity track on a text layer the template puts below the shade would fade it above the shade in motion. See `2026-09-10_finishing-video.md` §3. | Keyframed per-layer motion is meaningless while `drawTimeline` draws three of five layers by name. |

---

## 1. The model

A **track** binds one layer id to one animatable property and a list of stops:

- **Properties**, initially: `opacity`, `scale`, `dx`, `dy`. **Amended 2026-09-13:** this used to read
  "exactly what the compositor already moves", and that is **false for `accent-wipe`**, which
  animates the *extent of a clip* over a fixed gradient — `fillRect(0, solidH, width, fadeH * wipe)`
  (`NodeCanvasCompositor.ts:1057`, `:1066`). A `scale` track would compress the gradient into the
  shorter rect and cannot be byte-identical. The compositor moves five things; four of them are
  track properties and the fifth is K2's problem to express, which §4 already flags as the gate.
  Nothing wider until something needs it — an unread property is the `props` mistake again (D134
  shipped a vocabulary the compositor still never reads).
- **Stops** are `{ t, value, easing? }` ~~with `t` in the same normalised clock the draw paths already
  share~~ — **superseded by K-D8:** a stop names its clock (`pose`, `beat` or `effect`).
- **Easing** defaults to `easeOutCubic`, the one the codebase already uses. A per-stop override is
  allowed; a second *default* is not.
- **Resolution** is a pure function: ~~given tracks and `t`, return a pose per layer~~ — **superseded by K-D8:**
  given tracks, beats and a clock set, return a pose per layer plus a copy pose per (beat, mix). It is the
  keyframe analogue of `beatAt`, and it lives beside it.

**Presets expand into this.** `ken-burns-in` becomes a `scale` track on the image layer; `rise-in`
becomes `opacity` + `dy` on a copy layer over the entrance window; `accent-wipe` becomes whatever
reproduces its current reveal exactly. **The expansion is the specification** — if a preset cannot be
expressed as tracks, that is a finding about the model, not a licence to special-case it.

**`CopyTimeline` is not absorbed.** It sequences *content*, not motion — which text is on screen. It
stays as it is, and text-effect tracks play on beat-local progress exactly as they do now.

---

## 2. Lanes

| Lane | Task | Proof |
|---|---|---|
| **K1a** | **Shipped.** **The track model, no resolver.** Easing moves to the domain (K-D7); `Track`/`Stop` value objects (K-D8) and `layerTracksProblem`, validated at both brief boundaries (K-D9's one refusal: a duplicate `t` on one track's same clock). **No compositor *behaviour* change (one import), no rendering, no resolver.** | Round-trips through YAML in declared key order (positional); an invalid track is refused at both boundaries; the compositor's goldens are unchanged. |
| **K1b** | **Shipped.** **The resolver.** `resolveTracks(layers, beats, clocks) → { byLayer, copy }` (K-D8), pure, beside `beatAt`, in `resolve-tracks.ts`. Composition per property (K-D9), folded in declaration order. **No caller in the compositor yet** — K2 wires it. | Interpolation at the default easing per clock; the legacy single-beat path; a crossfade instant's two complementary `copy` mixes; `dy` tracks add and `opacity` tracks multiply in a fixture that proves fold order matters. |
| **K2** | **Express the four `MOTION_KINDS` as tracks and render from the resolver.** The vocabulary the user writes does not change. | **Per-frame byte-identity** for every motion kind across the canonical templates. Any drift stops the lane. |
| **K3** | **Express the four text effects the same way.** | Per-frame byte-identity, including the beat-local windows and the settled-pose behaviour. |
| **K4** | **Author tracks directly in a brief**, alongside presets; a hand-authored track and a preset's expansion on one layer and property **compose per K-D9** (no precedence rule) — preset expansions fold **before** hand-authored tracks, K3's existing order, and that is the only order. `html` refuses tracks (K1a), so K4 (and K5) never offer tracks on an `html` layer. | A hand-authored track renders; a track on an absent or disabled layer renders nothing and says nothing; `canonicalLayer` (K5/X16) drops `tracks: []` exactly as it drops `elements: []`. |
| **K5** | **The editor surface** — whatever minimum lets a user see and adjust a track. Scope deferred until K1–K4 land. | Out of scope for this document beyond naming it. |

**Order.** The video plan first — **VF2** (an MP4 byte golden) then **VF1** (the full order) — then K1 → K2 → K3 → K4. VF2 matters to K2 specifically: without a byte golden the "byte-identical preset expansion" gate can only compare frames, which is weaker than what D10 claims. **K2 is the gate**: if the four

> **Corrected 2026-09-13:** both VF1 (#328) and VF2 (#326) have **shipped**. This ordering reads as if they are ahead; they are behind, and K2's byte gate is checkable now.
existing motions cannot be reproduced frame-for-frame as tracks, the model is wrong and the plan
stops rather than shipping a second system beside the presets.

## 3. Definition of Done

- **K1a**: a track survives a brief round trip; `layerTracksProblem` (`layerPropsProblem`'s sibling)
  refuses malformed ones at both boundaries. No resolver, no compositor caller.
- **K1b**: `resolveTracks` is pure, beside `beatAt`, and returns the identity pose for a layer with no
  tracks. Still no compositor caller — K2 wires it.
- **K2/K3**: every preset renders byte-identically through the resolver, per frame, proven through
  `NodeCanvasCompositor.draw`. `restT` and the poster frame are unchanged.
- **K4**: presets and hand-authored tracks coexist, composing per K-D9.
- **Throughout**: `MOTION_KINDS` and `TEXT_EFFECT_VALUES` remain the brief vocabulary. A user who
  never writes a track sees no change, ever.
- **Interim contract (from K1a's merge until K2/K4 ship):** a brief that carries `tracks` validates
  and renders **exactly as it would without them** — accepted at both boundaries, inert everywhere
  else, because nothing calls `resolveTracks` yet and nothing in the compositor reads a layer's
  `tracks` field.

## 4. What this plan refuses

- **It does not add a fourth motion vocabulary.** K-D1 is the whole point: presets become sugar over
  one model, or this is not worth doing.
- **It does not create `packages/MotionComposition`.** K-D2.
- **It does not widen the property set speculatively.** Four properties, because four are what the
  compositor moves today. `blendMode`, `rotation` and the rest arrive when something renders them.
- **It does not start before VF1 (= C1's successor, #328).** K-D6 — and this line used to say *C1*, which K-D6 explicitly corrects: C1 made the ground trio list-driven, and what K1 needs is the whole motion path, which is VF1.
- **It does not accept "looks the same" as proof.** K-D3.

---

## 5. Premises

Each lane states the claim that makes it necessary, as a script that exits 0 **while the gap is still
open**. `yarn plan:verify` runs them. K1a shipped with no premise of its own: it was the model lane
every other K lane is downstream of, and it was audited as open at the time these were written; there
is nothing left to probe for its own gap now that it has merged. **Probe the thing
that decides, not a string near it** — a motion kind's *name* may live on as preset vocabulary after
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
path's `local` IS `t`). A track's stops are assumed to share one clock, the one its first stop names
— the validator (K1a) does not forbid a mixed-clock track, but nothing gives one a meaning, so stops
on any other clock are silently ignored, the same "resolves to nothing" shape K-D4 already uses. Two
tracks on one (layer, property) fold in **declaration order** (`dx`/`dy` add, `opacity`/`scale`
multiply); a fixture proves the order matters, but needs **three** tracks, not two, to do it — IEEE-754
multiplication is exactly commutative for a single pair (`a * b === b * a`, bit for bit), so a
two-operand product can never distinguish a fold from its reverse. `easing.ts` gains the
`EasingKind → (t) => number` table (`EASINGS`) K1b reads instead of switching on the string. Red
tests (15 cases) shown before the implementation; `mutate:verify .agents/manifests/k1b.json`: 2
mutations re-run, both caught (the ending stop's easing leaking into the segment before it; the fold
folding in reverse declaration order, caught only by the three-track fixture above).

```premise K2
# K2 moves preset application out of the compositor: the draw paths read a
# resolved pose instead of branching on the motion kind, because the
# preset→track expansion is a pure function beside beatAt (K-D2). These
# per-kind pose branches are the mechanism K2 replaces — not a name the
# vocabulary keeps (the names stay in the brief, but never in a `motion ===`
# comparison inside the compositor).
grep -qE 'motion === "(ken-burns-in|ken-burns-out|headline-rise|accent-wipe)"' packages/CreativeGeneration/src/infrastructure/adapters/NodeCanvasCompositor.ts
```

```premise K3
# K3 is the same lane for copy: the four text effects become entrance tracks,
# so the per-effect switch that decides the pose today (`textEffectPose`'s
# body) is resolved through the track model instead. The switch *is* the
# mechanism, and it sits inside the compositor, so it cannot outlive the lane
# the way W4's `.sort()` did.
grep -qE 'case "(fade-in|rise-in|slide-in|scale-in)"' packages/CreativeGeneration/src/infrastructure/adapters/NodeCanvasCompositor.ts
```

**K4's premise is restated in the amendments below**, because the original would have been
retired by K1's own merge.

```premise K5
# K5 is the editor surface where a user sees and adjusts a track. The word
# appears nowhere in the campaign editor's source today — only Tailwind
# `tracking-*` utilities and prose that the word boundary excludes — and the
# lane's own vocabulary is "track", so what ships names it.
! grep -rqiE '\btracks?\b' apps/web/src/components/campaign --exclude-dir=__tests__
```

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
tree for a *name* — first "precedence" near "preset"/"track"/"authored" including comments (K1a's own
doc comment would have matched it), then a `SCREAMING_SNAKE` rule-constant guess. Both failed the same
way: **a decision has no fixed name**, so no string search reliably detects one. K-D9 also superseded
the premise's original framing — composition (not precedence) was fixed in K1, so K4 was never going
to add a rule-naming constant for this fence to find.

A third attempt (this PR's first pass, since replaced) probed `canonicalLayer`
(`apps/web/src/components/campaign/editor-state.ts`) instead — a concrete file, not a decision name —
but review found two defects: it could fail SAFE forever (K4 might defer the editor's canonical-form
handling of hand-authored tracks to K5), and worse, the line it watched for
(`layer.tracks`) has a word boundary at the `.` and so also flips K5's *existing* fence
(`! grep -rqiE '\btracks?\b' apps/web/src/components/campaign --exclude-dir=__tests__`) — a K4 PR
retiring its own fence would flip K5's to STALE in the same commit, for a lane K4 did not ship.

**What K4 actually delivers** is not an editor default or a fold rule (K-D9 already fixed composition)
but the thing its own name says: **a brief's own tracks reaching the renderer** — a hand-authored
`layer.tracks` array read at the point K2/K3 already wired `resolveTracks` into
`NodeCanvasCompositor.ts`. That file is the right home for a K4 probe, and today it contains no
`.tracks` property access at all (checked, not assumed) — K2/K3 expand the four `MOTION_KINDS` and the
four text effects into *synthesized* tracks (built from the motion/effect kind, not read off the
brief's layer) and pass those to `resolveTracks`; the interim contract (§3) is explicit that nothing in
the compositor reads a layer's `tracks` field until a lane makes it do so, and expanding a preset needs
no such read. K4 is that lane.

```premise K4
# K4 authors tracks directly in a brief, alongside presets. K-D9 already fixed
# how a hand-authored track and a preset's expansion on one (layer, property)
# compose (declaration order, never a precedence rule), so K4's own
# contribution is the missing READ: a hand-authored layer.tracks reaching the
# renderer at all. (Two earlier framings failed first: two name-probes with
# no fixed decision name to find, then a canonicalLayer probe that could fail
# safe forever and also flipped K5's own fence in the same commit K4's PR
# would retire this one -- see the prose above.)
#
# By the time K4 ships, K2/K3 have already wired resolveTracks into
# NodeCanvasCompositor.ts, expanding MOTION_KINDS/text-effect presets into
# SYNTHESIZED tracks -- built from the motion/effect kind, never read off a
# layer's own `tracks` field (the interim contract, S3, is explicit that
# nothing in the compositor reads it until a lane makes it do so). Today
# this file contains no `.tracks` property access at all (verified). K4 is
# the lane that adds one -- reading a brief's hand-authored layer.tracks so
# it can fold alongside (or feed) the preset expansion.
#
# How this can still fail: if K2/K3's wiring passes the WHOLE layer object
# through to resolveTracks (rather than a synthesized-tracks-only view) for
# an unrelated reason, some ".tracks" access could appear before K4 for
# reasons that have nothing to do with hand-authored tracks, flipping this
# fence early on a K2/K3 PR. Re-anchor by symbol at that point rather than
# trusting the flip; `plan:verify` only fails on STALE, so nothing else will
# say which lane actually caused it.
! grep -q '\.tracks' packages/CreativeGeneration/src/infrastructure/adapters/NodeCanvasCompositor.ts
```

---

## K1 model decisions — owner 2026-09-15 (recommended defaults, plan-reviewed)

**K1 is dispatchable.** The three questions below are answered; the analysis that raised them stays under it as the record.
Several line references in that analysis have moved (e.g. `easeOutCubic` is now `NodeCanvasCompositor.ts:586`, not `:498`;
the poster clock sampling and the crossfade `drawBeat` calls have shifted) — **re-anchor by symbol, not line, when briefing.**

| id | Decision |
|---|---|
| **K-D7** | **`easeOutCubic` moves to the domain** (`CampaignOrchestration` `domain/value-objects/easing.ts`, exported from the barrel); the compositor imports it back. K1's "no compositor change" means "no compositor **behaviour** change" — one import, byte-neutral. |
| **K-D8** | **A stop names its clock**: `clock: "pose" \| "beat" \| "effect"`. `pose` reads `clocks.t` directly. `beat` is beat-local progress — **corrected 2026-09-15 (mechanism, not the decision):** *which* beat is current comes from `clocks.copyT`, via `beatAt(scenes.resolved, copyT)` inside `drawSequencedCopy` (`NodeCanvasCompositor.ts` ~1037), but the progress *within* that beat runs on the **pose clock**: `local = clamp01((t - beat.startT) / (beat.endT - beat.startT))` (~1064) — `copyT` selects the beat, `t` is the axis the progress itself reads. `effect` reads `clocks.effectT`, falling back to the beat-local clock (`local`) on the timeline path and to `t` on the legacy path — unifying `effectT ?? local` with `effectT ?? t`. The poster samples all three independently: `t = restT(request.motion)`, `copyT = posterCopyTAt(...)` (`CanvasFfmpegVideoCompositor.ts` ~122, ~124), `effectT = 1`. The resolver is `resolveTracks(layers, beats, clocks: { t, copyT?, effectT? }) → { byLayer: Map<layerId, Pose>; copy: ReadonlyArray<{ beat, mix, pose }> }` — `layers`, not bare `tracks`, per K-D4 (shipped in K1b). The legacy (timeline-less) path is one implicit beat spanning [0, 1] with `local = t`. The copy pose is per **(beat, mix)** because `drawBeat` runs twice at one instant during a crossfade. |
| **K-D9** | **Two tracks on one (layer, property) compose; they are never refused.** Operators are fixed per property: `dx`/`dy` **add**, `opacity`/`scale` **multiply**. K1's validator refuses only a stop set with duplicate `t` on one track (per clock, K-D8; declaration order of stops is free). K3 folds in today's order — `opacity = (riseAlpha * fx.alpha) * layerAlpha` — because float multiplication is not associative and the byte gate would move otherwise. K4's "precedence" framing is superseded: composition is fixed in K1. |

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
K1's "no compositor change" becomes "no compositor *behaviour* change", which is what it meant.

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

**A premise can only detect a lane whose output has a detectable shape.** K4's output is a *rule*,
and a rule can be named anything — three fences failed in three different ways before this was
obvious. The mechanism is strong for lanes that add a file, a field, a call site or a branch, and
weak for lanes that add a decision.

Two consequences worth carrying:

- **A fence that cannot flip is silent.** `plan:verify` fails only on `STALE`, so a premise that
  always holds reads as coverage and provides none. The completing-PR rule — *retire your fence in
  the same commit* — does not protect against it, because nothing fails to remind you.
- **Demonstrating a flip is not optional, and it is easy to demonstrate wrongly.** Two of the three
  broken fences here were declared working on the strength of a test that did not exercise them. The
  check is not "did I try" but "did I watch it change state, twice, in both directions".

