# Keyframing — Architecture & Development Plan

**Date:** 2026-09-10 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
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
| **K-D3** | **A preset must expand to exactly the frames it renders today.** Byte-identity per frame is the acceptance test, not a similarity judgement. | There is **no video byte golden** — D10 freezes bytes nothing measures. So the freeze has to be demonstrated. |
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
- **Stops** are `{ t, value, easing? }` with `t` in the same normalised clock the draw paths already
  share, so a track needs no new time concept.
- **Easing** defaults to `easeOutCubic`, the one the codebase already uses. A per-stop override is
  allowed; a second *default* is not.
- **Resolution** is a pure function: given tracks and `t`, return a pose per layer. It is the
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
| **K1** | **The track model and its resolver.** Value objects, validation at the brief boundary, the pure resolve function. **No compositor change, no rendering.** | Round-trips through YAML in declared key order; an invalid track is refused at both boundaries. |
| **K2** | **Express the four `MOTION_KINDS` as tracks and render from the resolver.** The vocabulary the user writes does not change. | **Per-frame byte-identity** for every motion kind across the canonical templates. Any drift stops the lane. |
| **K3** | **Express the four text effects the same way.** | Per-frame byte-identity, including the beat-local windows and the settled-pose behaviour. |
| **K4** | **Author tracks directly in a brief**, alongside presets, with a stated precedence when both name one layer and property. | A hand-authored track renders; a track on an absent or disabled layer renders nothing and says nothing. |
| **K5** | **The editor surface** — whatever minimum lets a user see and adjust a track. Scope deferred until K1–K4 land. | Out of scope for this document beyond naming it. |

**Order.** The video plan first — **VF2** (an MP4 byte golden) then **VF1** (the full order) — then K1 → K2 → K3 → K4. VF2 matters to K2 specifically: without a byte golden the "byte-identical preset expansion" gate can only compare frames, which is weaker than what D10 claims. **K2 is the gate**: if the four
existing motions cannot be reproduced frame-for-frame as tracks, the model is wrong and the plan
stops rather than shipping a second system beside the presets.

## 3. Definition of Done

- **K1**: a track survives a brief round trip; `layerPropsProblem`'s sibling refuses malformed ones.
- **K2/K3**: every preset renders byte-identically through the resolver, per frame, proven through
  `NodeCanvasCompositor.draw`. `restT` and the poster frame are unchanged.
- **K4**: presets and hand-authored tracks coexist under a written precedence rule.
- **Throughout**: `MOTION_KINDS` and `TEXT_EFFECT_VALUES` remain the brief vocabulary. A user who
  never writes a track sees no change, ever.

## 4. What this plan refuses

- **It does not add a fourth motion vocabulary.** K-D1 is the whole point: presets become sugar over
  one model, or this is not worth doing.
- **It does not create `packages/MotionComposition`.** K-D2.
- **It does not widen the property set speculatively.** Four properties, because four are what the
  compositor moves today. `blendMode`, `rotation` and the rest arrive when something renders them.
- **It does not start before C1.** K-D6.
- **It does not accept "looks the same" as proof.** K-D3.

---

## 5. Premises

Each lane states the claim that makes it necessary, as a script that exits 0 **while the gap is still
open**. `yarn plan:verify` runs them. K1 has no premise here: it is the model lane every other K
lane is downstream of, and it was audited as open at the time these were written. **Probe the thing
that decides, not a string near it** — a motion kind's *name* may live on as preset vocabulary after
K2 ships, so these probes sit on the compositor's per-kind pose mechanism, not on the names.

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

### K4's premise was one merge from retiring a live lane

It grepped for `precedence` within 160 characters of `track|preset|authored` across the whole
`CampaignOrchestration/domain` tree, **including tests and comments** — and "preset" is already live
prose there (`campaign-types.ts:6-16`). **K1's own value object would trigger it**: the natural
sentence to write is *"precedence between a preset and an authored track is K4's"*, and that retires
K4 the day K1 merges. It now probes the resolver's own decision rather than the vocabulary around it.

```premise K4
# KNOWN-WEAK, and recorded as such rather than trusted.
#
# K4 decides a precedence RULE between a preset's expansion and a hand-authored
# track. A rule can be named anything, so no name probe can reliably detect it.
# Three attempts failed in three different ways: the first matched "precedence"
# near "preset" across the tree including comments, so K1's own doc comment would
# have retired K4 on merge; the second probed camelCase in a repository that
# names fixed rules in SCREAMING_SNAKE; this third one still misses plausible
# names — PRESET_OVER_AUTHORED and TRACK_SOURCE_ORDER both leave it holding,
# verified.
#
# It is kept because it can only fail SAFE: it holds until one of these names
# appears, so it cannot retire a live lane. It cannot be relied on to notice
# that K4 has shipped. **Retire this fence by hand when K4 merges** — the
# completing-PR rule does not protect a fence that never flips, because
# plan:verify only fails on STALE.
#
# The durable fix is not a better regex. K4 is blocked behind K1's resolver, and
# once that exists the rule has a home: probe THAT file for a second input, not
# the whole tree for a word.
! grep -rqiE '(track|preset)[_-]?precedence|precedence[_-]?(rule|order)|authored[_-]?wins|preset[_-]?wins|reconcile[_-]?tracks|merge[_-]?tracks' packages/CampaignOrchestration/src/domain --include=*.ts
```

---

## K1 is not dispatchable yet — three model decisions remain

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

