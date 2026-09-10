# Finishing Video — Architecture & Development Plan

**Date:** 2026-09-10 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
**Verified against:** `main` at `f4f4d63`, plus PR #322 (the `video` drawer) in flight.
**Hands off to:** `2026-09-10_keyframing.md`, whose gate this plan is.

---

## 0. Where video actually stands

| Piece | State |
|---|---|
| Motion path reads the layer list | **Done** (C1, #313) — for **ground layers only** |
| The brief's template reaches the renderer | **Done** (C3, #319) |
| `video` layer has a drawer | **In flight** (#322) — short-video renders again |
| Motion frames honour the **full** declared order | **Not done** — text and logo are drawn in fixed positions |
| A video **byte** golden | **Does not exist.** D10 freezes bytes nothing measures. C1 added *frame* goldens; the MP4 itself is unmeasured |
| `fill` and `html` layer kinds | No drawer; both throw. `html` is deliberate (D122) |

**The honest summary: video renders correctly and is not yet provably stable.**

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **VF-D1** | **The motion path honours the whole declared order, not just the ground.** | C1 scoped to the ground trio because copy is beat-selected and the logo is anchored to the key beat's rest-pose box. That was right for C1 and is not a resting place: a template that puts the logo below the shade is honoured in the still and ignored in the video. |
| **VF-D2** | **The MP4 gets a byte golden, or D10's freeze stops being claimed.** | A rule that freezes bytes nothing measures is a comment, not a guarantee. Either measure it or delete the claim; both are honest, pretending is not. |
| **VF-D3** | **`fill` before `html`.** `fill` is a canvas primitive the compositor can draw. `html` is an output family (D122) and is not a drawer problem at all. | They look like siblings in `LAYER_KINDS` and are not. Treating them as one lane is how `html` ends up half-built inside a compositor that D122 says must never rasterise markup. |
| **VF-D4** | **Video is "finished" when a reordered, toggled, framed template renders identically in the still and in every frame.** | Anything less leaves two renderers that agree by luck. |

---

## 1. Lanes

| Lane | Task | Proof |
|---|---|---|
| **VF1** | **The motion path honours the full order.** `drawTimeline` stops skipping `static-text`, `animated-text` and `logo`. The copy layer keeps its beat selection and the logo its key-beat anchor — **what changes is *when* they are drawn, not *how***. Where a layer's position in the list conflicts with its anchor, the list wins and the anchor is computed within it. | Frame goldens unchanged for canonical templates. A template with the logo below the shade renders that way in **both** paths. |
| **VF2** | **An MP4 byte golden.** Hash the encoded output, not just the frames, for one short canonical timeline per platform key. If ffmpeg's output proves not reproducible across runs, **say so and delete D10's freeze claim** rather than recording a hash that will flap. | The golden is stable across two consecutive runs on one machine before it is committed. |
| **VF3** | **The `fill` drawer** (D131). A solid or gradient region, the primitive `accent` already half-implements. | A `fill` layer renders; an undrawable kind still throws. |
| **VF4** | **Retire the `GROUND_KINDS`/`SEQUENCED_KINDS` split** once VF1 lands — it exists only to describe the exception VF1 removes. | The concept has no callers. |

**Order.** VF2 first — a golden before a refactor, the lesson C1 already paid for. Then VF1, then VF3.
VF4 whenever VF1 is in.

**Blocked on:** #322 merging.

## 2. Definition of Done

- A template that reorders **any** layer renders in that order in the still, in every MP4 frame, and
  in both previews.
- The MP4 has a byte golden **or** D10 no longer claims a freeze.
- `fill` draws. `html` still throws, and that is correct — see D122 and the HTML layer plan.
- `SEQUENCED_KINDS` is gone.

## 3. The handoff to keyframing

**This plan is keyframing's gate.** `2026-09-10_keyframing.md` says K1–K4 cannot start before the
motion path is list-driven, because *"keyframed per-layer motion is meaningless while the motion path
draws three of five layers by name."*

**C1 satisfied the letter of that and not the spirit.** The ground trio is list-driven; copy and logo
are not. A keyframe track addresses a layer by `id` (K-D4) and animates `opacity`, `scale`, `dx`,
`dy`. **A track on the logo cannot mean anything while the logo's position is computed outside the
list.** So:

**Keyframing's real gate is VF1, not C1.** Recorded here and in the keyframing plan, so K1 is not
started on the strength of C1 alone.

**What keyframing inherits when VF1 lands:** one ordered list, every layer addressed by id, both draw
paths iterating it, and — if VF2 succeeds — the first honest way to prove a motion change did not
move the bytes. **That last one is what makes K2's "byte-identical preset expansion" gate
checkable.** Without VF2, K2 can only compare frames, which is weaker than what D10 claims.

## 4. What this plan refuses

- **It does not build an `html` drawer.** D122 is explicit: markup is never rasterised, and the
  fallback is a separate rendition from the existing pipeline. An `html` entry in `LAYER_DRAWERS`
  would contradict it.
- **It does not add video decoding.** The `video` layer is the motion-context ground, drawing what
  `image` draws (#322). A brief carries no video input asset; `videoPath` is output only.
- **It does not re-record a golden to make a lane green.** If VF1 moves a frame hash, that is a
  finding.
