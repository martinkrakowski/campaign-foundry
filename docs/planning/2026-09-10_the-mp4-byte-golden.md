# The MP4 Byte Golden — Architecture & Development Plan

**Date:** 2026-09-10 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
**Verified against:** `main` at `f4f4d63`. **This is the lane the finishing-video plan called VF2.** That name is retired; these are the lanes.

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
| **VG-D1** | **Pin the free variables first, then probe.** `-threads` is unset, so libx264 defaults to `threads=auto` (≈1.5 × cores) — and the x264 SEI user-data NAL embeds the options string **including `threads=N`**, so two machines with different core counts produce different bytes *within one platform key*. `-sws_flags +accurate_rnd+bitexact` is also absent, and `-pix_fmt rgba → yuv420p` is a swscale conversion whose SIMD paths are not guaranteed bit-exact across CPU feature sets. Pin both, and the codec-level `-flags +bitexact` the comment already implies. | **This is free today, and only today**, because no MP4 golden exists to invalidate. A review caught it: my original claim that `+bitexact` plus a pinned binary made the encode deterministic **was wrong**, and the probe I designed could not have detected it. |
| **VG-D2** | **Prove it across runners, not across runs.** Encoding twice in one process holds core count and CPU constant, so it detects only time- or randomness-based inputs — which the args already eliminate. It would pass everywhere and prove nothing. | The axes that actually vary are between machines. |
| **VG-D5** | **One short canonical timeline, not a matrix.** | The frame goldens already cover the motion matrix. This asserts the encode, and a second matrix costs CI minutes to re-prove what C1 proved. |

---

## 1. Lanes

| Lane | Task | Proof |
|---|---|---|
| **VG1** | **Pin `-threads`, add the sws and codec bitexact flags, then probe** — twice in one run *and* on a second runner. **Commit the probe as a test regardless of the outcome** — it is the thing that keeps the answer true. | Two encodes agree, or they do not; both are reportable results. |
| **VG2** | **The golden, if VG1 passed.** Record file and stream hashes for the canonical timeline under the platform key, with the ffmpeg version, the x264 version **and the thread setting** beside them. Add the new test file to `.github/workflows/record-goldens.yml` — **it names test files explicitly and will not pick one up on its own** — and record on real hardware, never in an emulated container. | The recorded hash reproduces on a second CI run before the PR merges. |
| **VG3** | **If VG1 failed: remove the claim.** Amend D10 to say what is actually true — frames are pinned, the encode is not — and say why. | The plan and the code agree again. |

**Order.** VG1 gates everything. **Do not write VG2's fixture before VG1's result is known.**

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

- **It does not record a golden it has not proved stable** (VG-D1).
- **It does not re-record to make a lane green.** A moved hash is a finding.
- **It does not add a matrix.** VG-D5.
