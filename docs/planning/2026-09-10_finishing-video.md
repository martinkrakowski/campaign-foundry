# Finishing Video — Architecture & Development Plan

> **Amended 2026-09-10 after review. This is a sequencing note over lanes that already have names,
> not a plan with its own prefix.** Three of its four lanes were renames: **VF1 is C5**
> (`2026-09-10_reconciliation.md` §4c), **VF2 is the VG plan**, and **VF3 is L11's `fill` half**. Only
> VF4 was new. I created a C1/M1 collision earlier this session and did not notice for hours; this is
> the same mistake and it is recorded rather than quietly renamed.

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

| Lane | Where it already lives | Note |
|---|---|---|
| **C5** | `2026-09-10_reconciliation.md` §4c | The motion path honours the **full** order. **Scope correction below.** |
| **VG1–VG3** | `2026-09-10_the-mp4-byte-golden.md` | The MP4 byte golden, or D10's claim withdrawn. |
| **L11 (`fill` half)** | `2026-09-08_creative-templates-and-units.md`, D131 | The `fill` drawer. |
| **VF4** | *new, and the only one* | Retire the `SEQUENCED_KINDS` split once C5 lands — it exists only to describe the exception C5 removes. |

**A scope correction C5 needs, found in review.** VF-D1 claimed a reordered template "is honoured in
the still and ignored in the video". **The still path cannot honour it either in one case**:
`drawLogo` throws *"the logo layer snaps to the text block, but no static-text layer ran before it"*
when no text layer has run, and the ordering table permits `[image, logo, shade, static-text]`. So
C5 must also take the logo's anchor from a prepared layout — as `drawTimeline` already does via
`scenes.anchor.box` — **or** narrow its definition of done and say why. As written, an implementer
lands the motion change, runs the DoD and finds the still path throwing.

**Order.** **VG first** — a golden before a refactor, the lesson C1 already paid for. Then **C5**, then **L11's fill half**. VF4 whenever C5 is in.

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

**C1 satisfied the letter of that and not the spirit — but my original reason was wrong**, and the
review corrected it. I claimed a track on the logo "cannot mean anything while the logo's position is
computed outside the list". **That is false**: the logo's `x`/`y` are computed in `prepare()` for
**both** paths, from geometry and insets, never from list order. A `dx`/`dy`/`opacity`/`scale` track
on the logo or the copy is **meaningful today** — copy already composes exactly such a pose per frame.

**The real reasons to gate keyframing on C5 are two, and both are engineering rather than semantic:**

1. **There is no single site to resolve a track by `id`.** `drawBeat` and the logo block never hold a
   layer record — copy is drawn without knowing *which* `static-text` layer it is, and a template
   with two text layers collapses to one beat block on the motion path. A track addressed by `id`
   has nothing to bind to.
2. **Z-order would be wrong, silently.** An opacity track fading a text layer the template places
   below the shade would fade it *above* the shade in motion. That is the C5 defect surfacing through
   keyframing rather than a keyframing defect.

**What keyframing inherits when VF1 lands:** one ordered list, every layer addressed by id, both draw
paths iterating it, and — if VF2 succeeds — the first honest way to prove a motion change did not
move the bytes. **That last one is what makes K2's "byte-identical preset expansion" gate
checkable.** Without VF2, K2 can only compare frames, which is weaker than what D10 claims.

## 4. What this plan refuses

- ~~It does not build an `html` drawer.~~ **Withdrawn — this was wrong.** D122 forbids rasterising
  **markup**; it says nothing against the compositor drawing a typed element list. And
  `canonical-image-html` carries an `html` **layer**, so the fallback render of an `image-html` brief
  is impossible without that entry. The `html` drawer is **HL3's**, in `2026-09-10_the-html-layer.md`.
- **It does not add video decoding.** The `video` layer is the motion-context ground, drawing what
  `image` draws (#322). A brief carries no video input asset; `videoPath` is output only.
- **It does not re-record a golden to make a lane green.** If VF1 moves a frame hash, that is a
  finding.
