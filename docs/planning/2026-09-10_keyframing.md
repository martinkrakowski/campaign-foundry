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
| **K-D6** | **This cannot start before the motion path is list-driven (C1).** | Keyframed per-layer motion is meaningless while `drawTimeline` draws three of five layers by name. |

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

**Order.** C1 first, from the reconciliation, then K1 → K2 → K3 → K4. **K2 is the gate**: if the four
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
