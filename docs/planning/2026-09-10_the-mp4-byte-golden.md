# The MP4 Byte Golden — Architecture & Development Plan

**Date:** 2026-09-10 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
**Verified against:** `main` at `f4f4d63`. **Expands lane VF2** of `2026-09-10_finishing-video.md`.

---

## 0. What is actually missing

**D10 freezes motion bytes. Nothing measures them.**

`NodeCanvasCompositor.goldens.test.ts` hashes **still** PNGs. C1 (#313) added **frame** goldens —
48 sha256 cells of individual rendered frames. **Neither touches the encoded MP4.** So every claim
about motion byte stability today is a claim about the frames going *into* the encoder, not about
what comes out.

**The encoder was designed for this and never verified.** `CanvasFfmpegVideoCompositor` already
passes `-fflags +bitexact`, with the comment *"bitexact strips encoder tags so identical frames yield
identical bytes"*, uses `libx264` with a fixed `-preset` and `-crf`, and `ffmpeg-static` is **pinned
at 5.3.0**. Every precondition for a byte golden is in place. **It has simply never been asserted.**

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **G-D1** | **Prove determinism before recording anything.** Encode the same input twice in one process and compare. Only if the two agree does a golden get committed. | A golden recorded from a non-deterministic producer is worse than none: it flaps, people learn to re-record it, and the habit spreads to the goldens that do work. |
| **G-D2** | **Key it like the PNG goldens** — `${platform}-${arch}` — and additionally record the **ffmpeg and libx264 versions** in the fixture. | The MP4 encodes canvas frames, and Skia already rasterises differently across OS and arch, so the same split applies. The encoder version is a second axis the PNG goldens never had; recording it turns a future mismatch into a legible diff instead of a mystery. |
| **G-D3** | **Hash the whole file, and separately the video stream.** If the container carries anything time-varying that `+bitexact` misses, the stream hash still holds and the file hash localises the problem. | One hash cannot distinguish "the encoder changed" from "the container stamped something". |
| **G-D4** | **If determinism does not hold, delete D10's freeze claim** in the same PR that proves it. | A rule nothing can enforce is worse than no rule: it gets cited in reviews as though it were guaranteed. That has already happened this session. |
| **G-D5** | **One short canonical timeline, not a matrix.** | The frame goldens already cover the motion matrix. This asserts the encode, and a second matrix costs CI minutes to re-prove what C1 proved. |

---

## 1. Lanes

| Lane | Task | Proof |
|---|---|---|
| **G1** | **The determinism probe.** Encode one canonical short-video timeline twice in a single run; compare bytes. **Commit the probe as a test regardless of the outcome** — it is the thing that keeps the answer true. | Two encodes agree, or they do not; both are reportable results. |
| **G2** | **The golden, if G1 passed.** Record file and stream hashes for the canonical timeline under the platform key, with the ffmpeg and x264 versions beside them. Use the repo's existing `record-goldens` workflow for the Linux key — **on real hardware, never in an emulated container.** | The recorded hash reproduces on a second CI run before the PR merges. |
| **G3** | **If G1 failed: remove the claim.** Amend D10 to say what is actually true — frames are pinned, the encode is not — and say why. | The plan and the code agree again. |

**Order.** G1 gates everything. **Do not write G2's fixture before G1's result is known.**

**A trap this lane must avoid, learned the hard way in C1:** goldens were once recorded inside an
emulated Linux container and validated against the *still* cells, which passed — because those cells
never exercise the code paths that diverged. **Validating a recording environment against assertions
that do not touch the new code proves nothing.** Record on the same hardware CI uses.

## 2. Definition of Done

- Either an MP4 byte golden exists and has reproduced on two independent CI runs, **or** D10 no
  longer claims a freeze and says what replaced it.
- The determinism probe is committed either way.
- The fixture records ffmpeg and x264 versions, so a future mismatch reads as a version change rather
  than a regression.

## 3. What this plan refuses

- **It does not record a golden it has not proved stable** (G-D1).
- **It does not re-record to make a lane green.** A moved hash is a finding.
- **It does not add a matrix.** G-D5.
