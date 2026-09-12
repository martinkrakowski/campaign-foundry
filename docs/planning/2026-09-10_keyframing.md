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
| **K-D5** | **`restT` survives as a first-class idea.** Every preset declares the `t` at which its pose is the settled one, and the poster renders that frame. | D7 depends on it. A naive keyframe model loses the notion of "the frame the still should be". |
| **K-D6** | **This cannot start before the motion path is list-driven — and that means VF1, not C1.** C1 made the *ground trio* list-driven; `static-text`, `animated-text` and `logo` are still drawn in fixed positions afterward. **Not because a track on them would be meaningless** — the logo's position comes from `prepare()` in both paths and copy already composes a per-frame pose — but because there is **no single site to resolve a track by `id`** (`drawBeat` never holds a layer record, and two text layers collapse to one beat block), and because **z would be silently wrong**: an opacity track on a text layer the template puts below the shade would fade it above the shade in motion. See `2026-09-10_finishing-video.md` §3. | Keyframed per-layer motion is meaningless while `drawTimeline` draws three of five layers by name. |

---

## 1. The model

A **track** binds one layer id to one animatable property and a list of stops:

- **Properties**, initially exactly what the compositor already moves: `opacity`, `scale`, `dx`, `dy`.
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

```premise K4
# K4's deliverable is the written precedence rule for a preset and a
# hand-authored track naming one layer and property (§2's DoD). "The brief can
# carry a track" is K1's claim, not K4's — and no such rule exists today. The
# probe verifies the rule, not the word: `precedence` naming its subjects —
# a track, a preset, the authored side — on the deciding line, inside the
# motion resolver's mandated home (K-D2: the pure resolution function beside
# `beatAt`, in `CampaignOrchestration/domain`; `CreativeGeneration` is
# adapters-only). The old probe read the bare word across both packages'
# every source file, and retired the lane on any unrelated comment —
# z-order prose is one `precedence` away from a live lane never getting done.
! grep -rqiE '\b(tracks?|presets?|authored)\b.{0,160}precedence|precedence.{0,160}\b(tracks?|presets?|authored)\b' packages/CampaignOrchestration/src/domain
```

```premise K5
# K5 is the editor surface where a user sees and adjusts a track. The word
# appears nowhere in the campaign editor's source today — only Tailwind
# `tracking-*` utilities and prose that the word boundary excludes — and the
# lane's own vocabulary is "track", so what ships names it.
! grep -rqiE '\btracks?\b' apps/web/src/components/campaign --exclude-dir=__tests__
```
