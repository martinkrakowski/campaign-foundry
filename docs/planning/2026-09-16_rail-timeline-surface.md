# The rail timeline surface — one scrollport, one playhead, DESIGN.md tokens

**Date:** 2026-09-16 · **Revised:** 2026-09-17 · **Status:** decisions adopted by the owner; TS1 and TS2 dispatchable.
**Scope:** the *visual* time surface that CC5 / TL1 mount in the rail, and — under D146, now adopted — under the Copy form on a narrow container. No new renderer. No new document field. No second playhead. No play-through clock.
**Related:** `DESIGN.md` (tokens, density, chrome-in-flow, §7 sideways-scroll rule), `2026-09-16_studio-editor.md` (D137–D140, TL1–TL7, §9 gesture contract), `2026-09-16_creative-first-chrome.md` (D141–D145, CC5 closes TL1), `2026-09-13_video-editing-features.md` (VE-D2, VE-D5, VE-D6, VE2 shipped), `2026-08-27_motion-copy-timeline.md` (D7 weights-not-timestamps), `2026-09-10_keyframing.md` (K4 shipped, K5 open).
**Sketch that does not ship:** `timeline-component.html` (2026-09-16), a layout experiment. Three lessons survive: one scrollport owns ruler + lanes + playhead; an end pad stops the last second being cropped; sticky lane labels. Four things in it are **defects against recorded decisions** and are listed in §2 so they cannot leak into the PR.

### Revision note — what the 2026-09-17 pass changed, and why

The first draft was verified against `origin/main` as fetched on **2026-09-16**. Between then and this revision the
repository landed **23 merges**, including **X1**, which reformatted **400 files** across `apps/web`, `packages`,
`apps/api`, `tools` and `scripts`, and **CC1** (#453), which rewrote how the rail is fed. Every line citation in the
first draft was therefore re-checked. The *mechanisms* all survived; several *addresses* did not, and one file was
cited at a path that does not exist:

| First draft said | Verified 2026-09-17 |
|---|---|
| PreviewDock scrub split at `:182-217` | **`PreviewDock.tsx:240-244`** — `scrubSec` / `committedSec` and their clamps. `:182` is now CC1's mount-marker comment. |
| DurationStrip `lanes` slot at `:16-17` | **`duration-strip.tsx:18-19`** |
| `usePreviewFrame` refetches on `atSec` at `preview-frame.ts:102` | **`preview-frame.ts:165`** — `cell?.atSec` in the request memo's dependency list |
| `TimelineSection.tsx` (`apps/web/src/components/campaign/TimelineSection.tsx`) under `components/campaign/sections/` | **`apps/web/src/components/campaign/TimelineSection.tsx`** — there is no `sections/` directory. `ProportionBar` lives inside that same file. |
| `CopyTimeline.vo.ts:38` `MAX_WEIGHT = 20` | unchanged ✅ |
| `resolveTimeline` | **`CopyTimeline.vo.ts:110`** ✅ exists with the assumed signature |
| `MIN_DWELL_SEC` / `DWELL_TOLERANCE` | **`CopyTimeline.vo.ts:20` and `:101`** ✅ (`1.2` and `1e-9`) |

**CC1 changed the ground under §5.** The rail is now fed through a memo keyed on `previewRailKey` — a content
fingerprint plus the identity axis `identityKey ?? brief.id` plus the first product's id — precisely so a
look-preserving keystroke does not re-render or re-fetch. TS1 inherits that: the tape's props must be stable across a
keystroke that changes nothing it draws, or CC2's acceptance criterion regresses through a new component. §5 is
restated against what shipped.

**Decisions D146 and D147 were adopted by the owner on 2026-09-17**, so TS2 is dispatchable rather than held.

---

---

## 0. Findings that constrain this surface

| # | Severity | Finding |
|---|---|---|
| **C1** | Critical | **CC5 already owns the playhead lift.** `2026-09-16_creative-first-chrome.md` lane CC5 "closes TL1": one playhead shared with the preview, live/committed split kept (`PreviewDock.tsx:240-244`), pointermove issues **no** `/preview-frame` call, pointerup commits `atSec`. This plan does not mint a parallel playhead lane. It specifies the **component CC5 mounts** and the layout contract that makes the right edge stop disappearing. |
| **C2** | Critical | **A play button that advances time in the browser is VE-D5 and VE-D2 in one control.** VE-D5: scrubbing is user-driven, **never autoplaying**, local state, never an editor action. VE-D2: the compositor is the only renderer; nothing plays in the browser. The HTML sketch's `requestAnimationFrame` clock is therefore not a "nice extra" — it is a second renderer with a different clock than `round(atSec / durationSec × (frames − 1))` (VE-D6). |
| **C3** | Critical | **The rail that will host this tape is hidden below `56rem` by a container query**, and today it still *mounts and fetches* while hidden (chrome plan C3 / CC2). A tape that exists only in that rail does not exist on a phone. The original brief for this surface was "elegant and easy to use on mobile." D145 says the rail gets the ruler and the form stays; it does not forbid the **same component** also mounting under `TimelineSection` when the rail is not shown. That is D146 below. |
| **C4** | Critical | **Two clocks already live in Copy and they must not be drawn as one tape.** DurationStrip is the 0–30 s **duration axis** (which clip lengths the variation includes). The copy ruler is a **projection of beat weights** onto *one* previewed duration (`axes.duration[0]`, `PreviewDock.tsx:240-244`). Painting beads and beats on the same horizontal unit is how an operator concludes a 4 s bead is "the first four seconds of the video." They are different documents. DurationStrip's `lanes` slot may sit *under* the beads; it must not become this tape's scrollport. |
| **H1** | High | **`MAX_WEIGHT` is 20**, not 5 (`CopyTimeline.vo.ts:38`). Any later boundary-drag (TL3) commits integers in `[1, 20]` through `shiftBeatBoundary`. The visual surface in TS1 does not drag weights — it only *draws* them. |
| **H2** | High | **The dwell floor is evaluated at `min(durations)`, the ruler is drawn for the previewed duration** (`studio-editor.md` §4.2). A beat that looks comfortable on a 15 s preview can still be under-floor on a 6 s cell. Under-floor paint uses `bg-error/20 text-error` and words, never colour alone (`DESIGN.md` §7; ProportionBar already does this in `TimelineSection.tsx` (`apps/web/src/components/campaign/TimelineSection.tsx`)). |
| **H3** | High | **A look-preserving pointermove must not fetch.** `usePreviewFrame` refetches on any `atSec` change (`preview-frame.ts:165`, `cell?.atSec` in the request memo deps). The live playhead position is `scrubSec`; the frame request is `committedSec` (VE-D5, CC5 proof). The tape's CSS `left` follows `scrubSec`. The PNG follows `committedSec`. |
| **M1** | Medium | **`packages/ui/src/scrub-bar.tsx` is frozen by D88** and VE-D5 leaves it alone. The tape is a new file. It does not import, wrap, or restyle that glyph. |
| **M2** | Medium | **Studio L1 already forbids building the ruler by un-freezing DurationStrip's internals.** Compose, do not fork. DurationStrip stays the duration-axis control. |
| **M3** | Medium | **Kind colours are not state colours.** `DESIGN.md` §2: brand blue is not "good"; success / warning / error / info / modified carry *state*. A video lane that is simply "the video" cannot be `text-success`. Lane tints below use brand-tint, brand-secondary/20, info/20, modified/20 as *identity chips* — the same idiom StatusChip already uses — and every lane still has a text label. |

---

## 1. Decisions

Everything visual in §3 follows from decisions already recorded (D138, D139, D145, VE-D2, VE-D5, VE-D6, DESIGN.md §1.1 and §7). Two questions this surface actually raises were not stamped. **Both were adopted by the owner on 2026-09-17**, so TS2 dispatches with TS1.

| ID | Question | **Decision — adopted by the owner, 2026-09-17** | Why |
|---|---|---|---|
| **D146** | On a container under `56rem`, where does the tape live? | **The same `TimelineTape` mounts under `TimelineSection`** (inside Copy, in flow — DESIGN.md §1.6). At `≥56rem` it mounts in the rail (CC5 / D145) and the Copy-form host is not rendered. `scrubSec` / `committedSec` stay lifted on `BriefEditor` so there is never a second playhead. | A tape that only exists in a CSS-hidden rail is a desktop toy. Duplicating the component with a second `useState` would desync the preview (H3). |
| **D147** | Is timeline zoom (`pxPerSec`) document state, a stored preference, or ephemeral? | **Ephemeral component state**, same bucket as selection and scrub (D139, VE-D5). Default is **fit**: `pxPerSec = max(28, min(48, floor((scrollportWidth − labelCol − endPad) / durationSec)))`. The operator may zoom in; reload resets to fit. | Zoom is not a property of the campaign. Persisting it would surprise a second operator on the same brief. Fit-then-zoom is what stops the right edge being "cut off" on a phone. |

No new decision is required for play-through: VE-D5 already forbids it. ±1 s buttons are allowed as **user-driven nudges** of `committedSec` (they are equivalent to clicking the ruler 1 s away). They must not start a clock.

---

## 2. What this plan refuses to build

Listed because each is in the HTML sketch, or looks like "the editor," and each fights a recorded decision.

- A `requestAnimationFrame` / `setInterval` play clock, a looping preview of the tape, or an `<video>` / WebAudio graph. (VE-D2, VE-D5, DESIGN.md looping-preview rule: the only permitted loops are the four motion-kind glyphs and loading indicators.)
- Raw hex, raw Tailwind palette classes (`bg-cyan-400`, `text-white` where `text-text-emphasis` exists), or a second token file inside the HTML. (`DESIGN.md` §1.1: a literal in a component is a defect.)
- Unsplash / remote filmstrip frames as the video-lane fill. The preview cell is the compositor frame (D52, VE-D6). The tape's video clip is a `bg-brand-tint` body with a CSS film perforation, not a second picture of the creative.
- Footage import, per-clip trim of an uploaded video, ripple / slip / slide. (VE-D11, studio §2.)
- Timestamped beats. (D1 / copy-timeline D7: weights, never timestamps.)
- Per-join transitions, a caption lane before VE4, track diamonds before K4/TL5. Those are TL2–TL7 and they paint *onto* this surface after it exists; they are not this PR.
- `position: fixed` chrome. (DESIGN.md §1.6.) The tape lives in the rail or in the Copy section.
- Page-level horizontal scroll. (DESIGN.md §7: wide content scrolls inside its own `overflow-auto` container.)
- Un-freezing `scrub-bar.tsx` or forking DurationStrip into a playhead.
- Auto-switching the operator into `studio` presentation so the tape has somewhere to live. (D137: offered, never switched on by itself.)

---

## 3. Target design

### 3.1 What the operator sees

A dense, operational strip — not a hero, not a marketing timeline.

```
┌ labelCol 52px ┬────────────────── scrollport ──────────────────────────┐
│               │ 0s    2s    4s    6s    8s   10s   12s   14s   16s     │
│               │ ┊     ┊     ┊     ┊     ┊     ┊     ┊     ┊     ┊      │
│ TITLE         │          [ Headline  ]                                 │
│ VIDEO         │    [||||||||||| filmstrip |||||||||||]                 │
│ B-ROLL        │                    [ B-roll ]                          │
│ AUDIO         │  [ Score  ~ ~ ~ ~ waveform ~ ~ ~ ~ ~ ~ ~ ]             │
│               │              ◆                                         │
│               │              │ playhead @ 00:06.40                     │
└───────────────┴─────────────────────────────────────────── endPad 32px ┘
  −1s    [scrub slider]    +1s                         Fit ──●── In
```

Four lanes in TS1. Each lane is a *projection* of a document that already exists:

| Lane | Document | Clip geometry | Empty state |
|---|---|---|---|
| Title | `copy.timeline.beats[]` concatenated on the weight axis | one rounded clip per beat, width = `weight / Σweight × durationSec × pxPerSec` | the Copy form still exists; the lane is omitted only when the draft has no motion |
| Video | the composed creative itself (always present on a motion draft) | one clip from `0` to `durationSec` | never empty on a motion draft |
| B-roll | `beats[i].background?` (VE5) | a clip per beat that names a scene, same window as that beat | no clip; the label still reads "B-roll" and the chip in the form says "campaign ground" |
| Audio | `brief.audio` (VE3) | one clip `0…encodedDurationSec` | lane omitted when `audio` is absent — do not draw an empty waveform that implies a bed |

TS1 draws Title + Video + the playhead. B-roll waits on TL2. Audio waits on TL4 / #431. The **scrollport, ruler, playhead, zoom and fit** ship in TS1 so later lanes have a coordinate system.

### 3.2 Coordinate system

```
x(seconds) = labelCol + seconds * pxPerSec
width(seconds) = seconds * pxPerSec
canvasWidth   = labelCol + durationSec * pxPerSec + endPad
```

Constants, as CSS custom properties on the tape root (not a second design-token file — they are *this component's* layout, the way DurationStrip's `TOTAL_SECONDS = 30` is local):

```css
.timeline-tape {
  --tt-label: 3.25rem;   /* 52px — lane name column */
  --tt-end-pad: 2rem;    /* 32px — why the last second is not cropped */
  --tt-px: 36;           /* written by React from the fit/zoom state */
  --tt-duration: 6;      /* previewed durationSec */
}
```

`labelCol` is `sticky left-0 z-10 bg-background` so a horizontal scroll does not take the names with it. The names are `font-mono text-[9px] uppercase tracking-eyebrow text-text-muted`.

**The cutoff defect, named so the PR can close it.** The sketch put the ruler in an `overflow-hidden` wrapper that did not share a scrollLeft with the clips, and the canvas width was `duration * px` with no end pad. The playhead at `t = durationSec` sat on the border-radius and lost its knob. TS1's acceptance includes: scroll the port to `scrollWidth - clientWidth` and assert the last tick label, the video clip's right edge, and the playhead knob at `t = durationSec` are all inside the canvas box (not clipped by the sheet, not outside `scrollWidth`).

### 3.3 Token mapping (DESIGN.md §2, §4)

Every class below already exists on the Tailwind scale in `apps/web/tailwind.config.ts`. A reviewer who finds a `#` or a `bg-cyan-*` in the tape rejects the PR.

| Element | Classes / tokens | Why |
|---|---|---|
| Sheet / rail well | `rounded-lg border border-border bg-background` | panels are `rounded-lg`; the tape is a well on `surface` |
| Ruler ticks | `font-mono text-[10px] text-text-muted border-l border-border` | identifiers are mono; ticks are decorative hairlines (`border-border`, 1.4.11-exempt) |
| Playhead line | `w-0.5 bg-text-emphasis` | inverse of the ground in both themes; not brand (brand is not "now") |
| Playhead knob | `size-3 rotate-45 rounded-sm bg-text-emphasis` | 12px, matches the sketch's diamond without a new radius token |
| Playhead readout | `font-mono text-[10px] rounded-full border border-border-control bg-surface px-1.5` | a *control* edge, so `border-control` (3:1), not `border` |
| Selected clip | `border-brand-primary shadow-[0_0_0_2px] shadow-brand-primary/30` | brand = active / selected |
| Title clips | `bg-modified/20 text-modified border-modified/50` | identity chip idiom; selected overrides the border to brand |
| Video clip | `bg-brand-tint text-brand-on-tint` | opaque pair, ground-independent (FIREFLY badge lesson) |
| B-roll clips | `bg-info/20 text-info border-info/50` | informational, not "good" |
| Audio clip | `bg-brand-secondary/20 text-brand-secondary border-brand-secondary/50` | the one sanctioned use of secondary |
| Under-floor beat | `bg-error/20 text-error` **and** the dwell sentence | colour never alone |
| ±1 s / zoom | `h-10 rounded-md border border-border-control bg-surface-2 text-sm` | secondary Button size `md` |
| Focus | `focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background` | DurationStrip's ring, including the offset so it reads on `surface-2` |
| Motion | `transition-colors duration-[var(--duration-fast)] ease-[var(--easing-default)]` | hover/colour only; `prefers-reduced-motion: reduce` kills the rest |

Playhead readout text is `00:06.40` — seconds in the playback timecode rounded **down** (DESIGN.md does not state this for the tape; VE-D6 rounds the *frame index* with `round`. The tape's label is the operator-facing clock and follows the editor's existing `fmt` in PreviewDock if one exists; if PreviewDock shows a raw range value, the tape matches that, it does not invent a third format). Implementer checks PreviewDock's visible number and uses the same function, exported if needed.

### 3.3a The range contract — taken from the shipped control, not invented

**Corrected 2026-09-17 after review.** An earlier draft of this plan said the live value arrives on `input` and the
commit on `change`. That is wrong in React, where `onChange` on a range fires continuously through the drag — so a
"commit on change" tape would issue a `/preview-frame` request per pointermove and break the very criterion TS1 is
measured against (§0 H3, CC2).

The shipped control already solves this, twenty lines from where the tape will mount
(`PreviewDock.tsx:270-283`), and TS1 copies it exactly rather than inventing a third convention:

```tsx
value={clampedScrubSec}          // the LIVE second, so the thumb tracks the finger
onChange={(e) => setScrubSec(Number(e.target.value))}   // live — fires all through the drag
onPointerUp={handleCommit}       // commit — pointer release
onKeyUp={handleCommit}           // commit — keyboard, and NOT optional
```

`onKeyUp` is the half a reviewer usually misses: `onPointerUp` never fires for an arrow key, so a pointer-only
commit leaves a keyboard user able to move the thumb and unable to move the frame. Both handlers read
`e.currentTarget.value`; neither recomputes the second from a pointer coordinate.

### 3.4 Component seam

New file: `apps/web/src/components/campaign/TimelineTape.tsx`. Not `packages/ui` — the tape knows beat windows, scenes and audio captions, which are campaign types. `packages/ui` keeps DurationStrip.

```ts
export type TimelineTapeBeat = {
  readonly text: string;
  readonly weight: number;
  readonly startT: number; // from resolveTimeline, not computed here
  readonly endT: number;
  readonly background?: string;
  readonly underFloor: boolean; // computed by the parent from dwellProblem
};

export type TimelineTapeProps = {
  readonly durationSec: number;
  readonly encodedDurationSec?: number; // TL4; omit until #431
  readonly beats: readonly TimelineTapeBeat[];
  readonly hasAudio: boolean;
  readonly audioLabel?: string; // path + licence id, already-display-safe
  readonly keyBeatIndex: number;
  readonly transition: "cut" | "fade";
  readonly previewedDurationSec: number; // fade-band caption; may equal durationSec
  readonly shortestDurationSec: number;  // floor evaluation
  readonly scrubSec: number;
  readonly committedSec: number;
  readonly selectedBeatIndex: number | null;
  readonly onScrubLive: (sec: number) => void;      // pointermove / arrow
  readonly onScrubCommit: (sec: number) => void;    // pointerup / click / ±1s
  readonly onSelectBeat: (index: number) => void;
  readonly host: "rail" | "section";
};
```

The parent (`BriefEditor` after CC5, or `TimelineSection` under D146) is the only place that owns the two seconds. The tape never calls `usePreviewFrame`.

`startT` / `endT` come from `resolveTimeline(asCopyTimeline(state.timeline), durationSec)` — the compositor's function, the same rule ProportionBar already lives by. The tape **does not divide weights itself**. A test pins `clip.style.width` against `(endT - startT) * durationSec * pxPerSec`.

### 3.5 Markup and styles to implement exactly

The scrollport is the whole point of this plan. Implement this structure; restyle only through the token classes above.

```tsx
<div
  className="rounded-lg border border-border bg-background"
  data-tape-host={host}
>
  <div className="flex items-baseline justify-between px-3 pt-3 pb-2">
    <h2 className="text-sm font-semibold text-text-emphasis">Timeline</h2>
    <p className="font-mono text-[11px] uppercase tracking-eyebrow text-text-muted">
      {pxPerSec} px/s
    </p>
  </div>

  <div
    ref={scrollRef}
    className="relative overflow-x-auto overflow-y-hidden overscroll-x-contain border-y border-border"
    // DESIGN.md §7: this is the only horizontal scroller.
  >
    <div
      className="relative min-h-[11.75rem]"
      style={{
        width: `calc(var(--tt-label) + ${durationSec} * ${pxPerSec}px + var(--tt-end-pad))`,
      }}
    >
      <Ruler durationSec={durationSec} />
      <Lane name="Title">{/* beat clips */}</Lane>
      <Lane name="Video">{/* single filmstrip clip 0…durationSec */}</Lane>
      {/* B-roll after TL2, Audio after TL4 */}

      <Playhead
        seconds={scrubSec}
        durationSec={durationSec}
        committedLabel={formatTapeClock(committedSec)}
      />
    </div>
  </div>

  <div className="flex items-center gap-2 px-3 py-3">
    <Nudge label="Back one second" onClick={() => onScrubCommit(committedSec - 1)}>−1s</Nudge>
    <PlayheadSlider
      durationSec={durationSec}
      committedSec={committedSec}
      onLive={onScrubLive}
      onCommit={onScrubCommit}
    />
    <Nudge label="Forward one second" onClick={() => onScrubCommit(committedSec + 1)}>+1s</Nudge>
    <ZoomFit value={pxPerSec} onChange={setPxPerSec} />
  </div>

  <p role="status" className="px-3 pb-3 text-[11px] text-text-muted">
    {statusSentence}
  </p>
</div>
```

**Playhead positioning** — one formula, used by the diamond and the slider so they cannot drift:

```ts
function xFor(seconds: number, pxPerSec: number): string {
  return `calc(var(--tt-label) + ${seconds} * ${pxPerSec}px)`;
}
```

```tsx
function Playhead({ seconds, durationSec, committedLabel }: {
  seconds: number;
  durationSec: number;
  committedLabel: string;
}) {
  const clamped = Math.min(durationSec, Math.max(0, seconds));
  return (
    <div
      role="presentation"
      className="pointer-events-none absolute inset-y-0 z-20 w-5 -ml-2.5"
      style={{ left: xFor(clamped, pxPerSec) }}
    >
      <span className="absolute left-1/2 top-0.5 size-3 -translate-x-1/2 rotate-45 rounded-sm bg-text-emphasis" />
      <span className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-text-emphasis" />
      <span className="absolute left-1/2 top-4 -translate-x-1/2 whitespace-nowrap rounded-full border border-border-control bg-surface px-1.5 font-mono text-[10px] text-text-primary">
        {committedLabel}
      </span>
    </div>
  );
}
```

The diamond is decorative (`pointer-events-none`). The accessible playhead is the range input in the dock — studio §9.3 point 5: `use-step-navigation.ts:159-167` only hands a drag to `[role="slider"], input[type="range"], [draggable="true"]`. A custom-painted knob that is *only* a painted knob is swallowed by the guided swipe. TS1 therefore **keeps a native `input[type="range"]`** as the named playhead, visually styled, and the painted diamond follows it.

```tsx
function PlayheadSlider(props: {
  durationSec: number;
  committedSec: number;
  onLive: (sec: number) => void;
  onCommit: (sec: number) => void;
}) {
  return (
    <input
      type="range"
      min={0}
      max={props.durationSec}
      step={1 / 30}              // MOTION_FPS; one encoded frame
      value={props.committedSec} // aria-valuenow == committed, studio §9.3.3
      aria-label="Playhead"
      className="h-10 flex-1 accent-brand-primary"
      onInput={(e) => props.onLive(Number((e.target as HTMLInputElement).value))}
      onChange={(e) => props.onCommit(Number((e.target as HTMLInputElement).value))}
    />
  );
}
```

`step={1 / 30}` is `1 / MOTION_FPS` imported from `MotionKind.vo.ts`, not a literal `30` restated. Clicking the ruler (empty canvas, not a clip) also commits: `seconds = (clientX - portRect.left + scrollLeft - labelCol) / pxPerSec`, clamped to `[0, durationSec]`, then `onScrubCommit`.

**Lane + clip:**

```tsx
function Lane({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="grid h-11 grid-cols-[var(--tt-label)_1fr] items-center">
      <div className="sticky left-0 z-10 flex h-full flex-col items-center justify-center gap-0.5 border-r border-border bg-background font-mono text-[9px] uppercase tracking-eyebrow text-text-muted">
        {name}
      </div>
      <div className="relative h-full" style={{ width: `calc(${durationSec} * ${pxPerSec}px + var(--tt-end-pad))` }}>
        {children}
      </div>
    </div>
  );
}

function Clip(props: {
  startSec: number;
  durSec: number;
  tone: "title" | "video" | "broll" | "audio";
  selected?: boolean;
  underFloor?: boolean;
  label: string;
  onSelect?: () => void;
}) {
  const tones = {
    title: "bg-modified/20 text-modified border-modified/50",
    video: "bg-brand-tint text-brand-on-tint border-border",
    broll: "bg-info/20 text-info border-info/50",
    audio: "bg-brand-secondary/20 text-brand-secondary border-brand-secondary/50",
  } as const;
  return (
    <button
      type="button"
      aria-label={props.label}          // stable name, not the live seconds
      aria-pressed={props.selected}
      aria-invalid={props.underFloor || undefined}
      className={cn(
        "absolute top-1 bottom-1 overflow-hidden rounded-md border text-left",
        tones[props.tone],
        props.selected && "border-brand-primary shadow-[0_0_0_2px] shadow-brand-primary/30",
        props.underFloor && "bg-error/20 text-error border-error/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary",
      )}
      style={{
        left: `calc(${props.startSec} * ${pxPerSec}px)`,
        width: `calc(${props.durSec} * ${pxPerSec}px)`,
      }}
      onClick={props.onSelect}
    >
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold">
        {props.label}
      </span>
    </button>
  );
}
```

Title-clip `aria-label` is `Beat ${index + 1}`, never `"${text} ${startSec}s"`. The live seconds belong on the playhead slider. Under-floor sets `aria-invalid` and `aria-describedby` pointing at the status sentence (X20 / studio §9.3.4).

**Video filmstrip fill** — CSS only, no network:

```tsx
<div
  aria-hidden="true"
  className="flex h-full"
>
  {Array.from({ length: 6 }, (_, i) => (
    <i
      key={i}
      className="min-w-0 flex-1 border-r border-scrim/20"
      style={{
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--color-scrim) 18%, transparent) 0 3px, transparent 3px calc(100% - 3px), color-mix(in srgb, var(--color-scrim) 18%, transparent) calc(100% - 3px))",
      }}
    />
  ))}
</div>
```

**Audio waveform** (TL4): an inline SVG `path` in `currentColor`, `preserveAspectRatio="none"`, stretched to the clip width. It is decoration (`aria-hidden`). The accessible name is the already-safe `audioLabel`. Do not synthesise a waveform from the file bytes in the browser — that is decode, and VE-D11 still stands. A static path that merely *looks* like a bed is honest because the encoder, not the tape, is the audio.

**Fit / zoom:**

```ts
const LABEL = 52;
const END_PAD = 32;
const PX_MIN = 28;
const PX_MAX = 96;

function fitPx(scrollportWidth: number, durationSec: number): number {
  const available = scrollportWidth - LABEL - END_PAD;
  if (available <= 0) return PX_MIN;
  return Math.max(PX_MIN, Math.min(48, Math.floor(available / durationSec)));
}
```

A `ResizeObserver` on the scrollport re-runs fit **only while the operator has not touched the zoom slider**. Touching the slider sets a `zoomedByUser` flag; changing `durationSec` clears it so a 6 s → 15 s axis change does not leave the tape at a 6 s zoom. Flag is React state, not `localStorage`.

**Nudge buttons** write `onScrubCommit(clamp(committedSec ± 1, 0, durationSec))`. They are `type="button"` with an action name (`Back one second`), size `h-10`, `border-border-control`. They do not become a hold-to-repeat clock.

**Status sentence** (`role="status"`, 11px muted, success when a commit lands):

- idle: *Drag the playhead to scrub. Scroll sideways for later seconds.*
- after commit: *Frame at 00:06.40 — matches the encoded frame.*
- under-floor (any beat): the existing `messages.timelineDwellUnderFloor` string, not a new one. Copy lives in `messages.ts` (DESIGN.md §6).

### 3.6 Light theme

`<html class="dark">` is the server default. The tape uses only tokens, so the header's `ThemeToggle` is sufficient — the tape does not grow its own toggle (the HTML sketch did; that was demo chrome and would have been a second source of `cf:theme`). Verify both grounds in the PR screenshots: playhead knob is `text-emphasis` (near-black on light, white on dark); video clip stays readable because `brand-tint` / `brand-on-tint` are an opaque pair.

### 3.7 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  .timeline-tape * {
    transition: none !important;
    animation: none !important;
  }
}
```

No loop ships on this surface, so the media query is belt-and-braces. The static film perforations and the waveform path remain; they are not motion.

---

## 4. Lanes

This plan adds **one dispatchable lane** and names the paint-overs that later plans already own. It does not restamp TL2–TL7.

| Lane | Depends on | Ships | Proof |
|---|---|---|---|
| **TS1** | CC2 (rail cost/memo — otherwise every pointermove re-renders the world), CC5 / TL1 (playhead lift), D147 | `TimelineTape` with ruler, title clips from `resolveTimeline`, video clip, painted playhead following `scrubSec`, native range + ±1 s writing `committedSec`, fit/zoom, one scrollport, end pad, DESIGN.md tokens, both hosts if D146 is adopted | (a) `scrollWidth >= label + durationSec * pxPerSec + endPad`; at `scrollLeft = max` the last tick, the video clip's right edge and the playhead at `t = durationSec` are inside the canvas. (b) pointermove on the range issues **zero** `/preview-frame` calls; pointerup issues one with `atSec = committedSec`. (c) no `#` and no `bg-red-` / `bg-cyan-` / `text-white` in the new file (W0b.3: `text-text-emphasis`). (d) `TimelineTape` does not import `editor-state` actions — scrub is not an action. (e) goldens unmoved; a brief without motion does not mount the tape. |
| **TS2** | TS1, D146 | The section host: `TimelineSection` renders `<TimelineTape host="section" />` when the rail host is not shown. | Exactly one `TimelineTape` mounted. A test that paints both presentations at a narrow container finds one playhead slider. |
| paint-over **TL2** | TS1, VE5 | Scene clips on the B-roll lane | Already specified in the studio plan; uses this coordinate system. |
| paint-over **TL3** | TS1, D138 | Beat-boundary handles as `role="slider"` on the title lane | Studio §9.1 / §9.3; not this PR. |
| paint-over **TL4** | TS1, #431 | Audio clip + encoded-vs-brief caption | Encoder rounding exported, not recomputed. |
| paint-over **TL6** | TS1, TL5 / K5 | Diamonds | Time-only; same `xFor`. |

**Order.** CC2 → CC5 (lift the seconds out of PreviewDock) → **TS1** (draw them) → TS2 if D146 → the studio paint-overs in the studio plan's Wave B–D.

TS1 may share a PR with CC5 if the diff stays reviewable. It may not share a PR with TL3 — boundary drag is a reducer action with a coalesce-key debate already settled, and mixing it with the first layout pass hides the cutoff fix.

---

## 5. Parent wiring (CC5 + TS1 together)

Lifted state already required by CC5, restated so the tape has a single call site:

```ts
// BriefEditor — the only owner
const durationSec = brief?.variation?.axes?.duration?.[0] ?? DEFAULT_DURATION_SEC;
const [scrubSec, setScrubSec] = useState(0);
const [committedSec, setCommittedSec] = useState(0);

const clampedLive = Math.min(Math.max(0, scrubSec), durationSec);
const clampedCommitted = Math.min(Math.max(0, committedSec), durationSec);

// PreviewFrame / usePreviewFrame sees only the committed second
atSec={hasMotion ? clampedCommitted : undefined}

// Tape sees both
<TimelineTape
  durationSec={durationSec}
  beats={resolvedBeats}          // resolveTimeline(...) mapped once
  shortestDurationSec={Math.min(...timelineDurations(state))}
  previewedDurationSec={durationSec}
  scrubSec={clampedLive}
  committedSec={clampedCommitted}
  selectedBeatIndex={selectedBeat}  // D139 ephemeral
  onScrubLive={setScrubSec}              // a setState function is already stable
  onScrubCommit={handleScrubCommit}      // useCallback — see below
  onSelectBeat={setSelectedBeat}
  host={railVisible ? "rail" : "section"}
/>
```

**Every callback must be referentially stable**, or the memo boundary CC1 built is defeated by this component:

```ts
const handleScrubCommit = useCallback((sec: number) => {
  setScrubSec(sec);
  setCommittedSec(sec);
}, []);   // both setters are stable; no dependency is needed
```

An inline arrow here would allocate a new function on every keystroke, so a `memo`-wrapped tape would re-render on
a keystroke it does not draw — re-opening CC2's cost defect through a new component. (An earlier draft of this
section wrote the arrow inline; review caught it.)

`resolvedBeats` is memoised on `state.timeline` + `durationSec` + `shortestDurationSec`. `underFloor` is `dwellSec < MIN_DWELL_SEC - DWELL_TOLERANCE` using the domain's own slack, the way ProportionBar already does — do not write `1.2` in the tape.

When `hasMotion` is false the tape is not mounted and the lifted state may stay at `0`; do not fetch.

---

## 6. Assistive-technology contract

Studio §9.3 applies in full. TS1's specific bindings:

| Control | Role / name | `aria-valuenow` | Keys |
|---|---|---|---|
| Playhead | native `input[type="range"]`, name **"Playhead"** | `committedSec` | native range keys; also −1s / +1s buttons |
| Title clip | `button` + `aria-pressed`, name **"Beat N"** | n/a | Enter / Space select |
| Zoom | native `input[type="range"]`, name **"Timeline zoom"** | `pxPerSec` | native |
| ±1 s | `button`, action names | n/a | — |

The painted diamond is `aria-hidden` via the `pointer-events-none` wrapper with `role="presentation"` — it has no tab stop. Two playheads in the accessibility tree (a painted slider *and* the range) would announce the same fact twice; that is the ThemeToggle lesson in DESIGN.md §4, applied here.

Guided walk: the range input already matches `use-step-navigation.ts`'s allow-list. Do not replace it with a `div` plus pointer handlers without also giving that `div` `role="slider"` **and** extending the allow-list in the same PR.

---

## 7. Copy

All operator-facing strings go in `messages.ts`. No new jargon (`px/s` is an eyebrow on a mono readout, allowed as a unit; "scrollport" is not). Display names only (`Video`, `Title`, `B-roll`, `Audio`, `Ken Burns in` from `MOTION_KIND_META`, never `ken-burns-in`).

Under-floor reuses `timelineDwellUnderFloor`. Add:

- `tapeLegend` — "Timeline"
- `tapeIdleStatus` — "Drag the playhead to scrub. Scroll sideways for later seconds."
- `tapeCommittedStatus(label)` — "Frame at ${label} — matches the encoded frame."
- `tapePlayheadName` — "Playhead"
- `tapeZoomName` — "Timeline zoom"
- `tapeNudgeBack` / `tapeNudgeForward` — "Back one second" / "Forward one second"
- `tapeBeatName(n)` — "Beat ${n}"

---

## 8. Tests

happy-dom does no layout (DESIGN.md §8). Pixel clearance of the end pad is a **browser check** recorded in the PR, not a Vitest assertion. What Vitest *can* pin:

- The tape is absent when `hasMotion` is false.
- `resolveTimeline` windows become clip `style.width` / `style.left` strings that contain the computed seconds (string match on the `calc(...)`, not getBoundingClientRect).
- `onScrubLive` fires on **`onChange`**; `onScrubCommit` fires on **`onPointerUp` and `onKeyUp`**. A test that mocks fetch asserts the live path does not call it, and a **keyboard** test asserts arrow-then-keyup commits — `onPointerUp` never fires for a key press, so a pointer-only commit would leave keyboard users unable to move the frame at all.
- Selecting beat 2 sets `aria-pressed` on that button only.
- An under-floor beat sets `aria-invalid` and points `aria-describedby` at the status node.
- No `EditorAction` is dispatched from the tape module (import graph).
- Token lint: the new file has no `#` hex and no `text-white` / `bg-white` / `bg-black` / `gray-` / `slate-` / `cyan-` / `red-400`.
- D146: at `host="section"` and `host="rail"`, the accessible name "Playhead" exists exactly once in a render that is given one host.

A capturing test that the committed frame equals the encoded frame **already exists** in VE2. TS1 does not restate it.

---

## 9. Premises

Each fence exits 0 **while the gap is still open**. `yarn plan:verify` runs them. They probe a mechanism, not a name.

**`premise TS1` retired — TS1 shipped in this PR, with CC5 in the same diff** (§4:
"TS1 may share a PR with CC5 if the diff stays reviewable"). Its probe was the
module's absence, and `apps/web/src/components/campaign/TimelineTape.tsx` now
exists, so `plan:verify` no longer tracks it. CC5's own half is retired where it
lived: `premise TL1` in `2026-09-16_studio-editor.md`.

**Where the implementation departs from this document, and why.** Two places, both
recorded in the PR body:

1. **§5 puts `scrubSec` / `committedSec` in `BriefEditor`'s body; they ship one
   level down, in a `PlayheadHost` component in that same file.** §4's own
   acceptance (b) is unsatisfiable in the body: `renderStepCard` builds the step
   form inline and no section is `memo`-wrapped, so a second that moves on every
   pointermove re-renders the whole editor tree per frame. The main column reaches
   the host as `children`, so React's element-identity bailout skips it. Ownership
   is still singular and still in `BriefEditor.tsx`, and every literal §5 makes
   load-bearing is unchanged. **TS2's section host lives inside that bailed-out
   subtree and will need its own slot or a subscription.**
2. **§3.5's `PlayheadSlider` sketch is the stale draft §3.3a corrects.** It shows
   `value={committedSec}`, `onInput` live and `onChange` committing — the exact
   "commit on change" §3.3a proves wrong in React, and a controlled range whose
   value is the committed second snaps its thumb back mid-drag. The shipped
   slider follows §3.3a, §8 and §10.2: `value` is the live second, `onChange` is
   live, and the commit is `onPointerUp` **and** `onKeyUp`.
3. **`xFor` spells the label column as a px constant, not `var(--tt-label)`.**
   happy-dom drops any `calc()` containing a `var()` outright, which makes §8's
   own proof for this lane — "a string match on the `calc(...)`" — impossible to
   write with that spelling. The number comes from the same exported constant the
   custom property is set from, so there is no second source of truth. `--tt-label`
   is still read, by the lane grid's `grid-cols-[var(--tt-label)_1fr]`;
   `--tt-end-pad`, `--tt-px` and `--tt-duration` ship on the root because §3.2
   declares them and the TL2–TL6 paint-overs will want them, but nothing reads
   them today.

Two more things a reviewer should weigh rather than assume:

- **§6's table says the playhead's `aria-valuenow` is `committedSec`.** The shipped
  slider binds `value={scrubSec}`. The two are equal at rest — a commit writes both
  seconds — and differ only mid-drag, which is when a native range should announce
  the thumb. Binding the committed second instead would snap the thumb back on
  every re-render and kill the drag (§3.3a).
- **Two range controls in the rail — SETTLED by the owner, 2026-09-17: the dock's
  range retires in the rail host and is kept for the narrow host.** TS1 first
  shipped both (the dock's VE-D5 scrub, named `previewScrubLabel`, beside the
  tape's "Playhead") because this document contradicts itself — §3.5's prose calls
  the dock's range "the accessible playhead" while §3.5's own markup puts a
  `PlayheadSlider` in the tape's footer, and §6 and §8 both name the tape's — and
  deleting a shipped, tested surface on a plan's ambiguity is not an implementer's
  call. **What shipped after the decision:** `PreviewShowcaseProps` carries the
  same `SurfaceHost` discriminant `TimelineTape` already took (imported, not
  restated, so the two cannot disagree about which of them owns the scrub), and
  the dock's range renders only under `host="section"`. The rail went from
  `['Scrub preview', 'Playhead', 'Timeline zoom']` to
  `['Playhead', 'Timeline zoom']`. The code path is **suppressed, not deleted**:
  D146's narrow host is where TS2 puts the tape under Copy, and the compact scrub
  is the control for that case. It has no production call site until TS2 lands, so
  both halves of the conditional are pinned by tests — the absence in the rail AND
  the presence in the section — because a conditional with only its negative
  asserted is one a later lane removes as dead code with nothing going red. The
  lifted second did not move: this changes which control is visible, never who
  owns the state.

**Fields of §3.4's `TimelineTapeProps` that TS1 does not ship**, each with the
lane that adds it, so no dead prop lands: `encodedDurationSec`, `hasAudio` and
`audioLabel` (TL4 / the audio-clip lane), `background` on a beat (TL2's scene
clips), `keyBeatIndex` (TS-Q1's recommendation is the form alone in TS1),
`transition` and `previewedDurationSec` (the fade band, which §11 defers to a
paint-over that can caption it). `weight` is absent because the windows come from
`resolveTimeline`, which is the point.

```premise TS2
# D146's section host is absent: TimelineSection does not render a tape.
# A grep for the host discriminant, not the tag, so an implementer can
# name the component anything; the mechanism is "Copy does not host it".
# Measured: ~6 ms. Both fences were run before this plan landed, per the
# skill's fence-runtime rule -- the rule exists because three fences failed
# on 2026-09-16, two by timing out and one by probing a proxy.
! grep -q 'host="section"' apps/web/src/components/campaign/TimelineSection.tsx
```

CC5's TL1 fence (`PreviewDock.tsx` still declaring `[xSec, setXSec] = useState`) lived in the studio plan, and this section used to end "TS1 does not steal it". **That is no longer true, and the sentence is corrected rather than left to mislead:** TS1 shipped the lift as CC5 in its own PR, so `PreviewDock` declares neither second and the probe is false by construction — `premise TL1` is retired in `2026-09-16_studio-editor.md`, in the same commit that removed the `useState` pair. A reader following the old sentence to the studio plan would look for a fence that is not there. Shipping TS1 without CC5 would have drawn a playhead the preview does not follow; the dependency table forbade that dispatch, which is exactly why the two travelled together.

---

## 10. Definition of done

1. A `short-video` brief shows the tape. A still-only brief does not.
2. Dragging the range moves the diamond on every **`onChange`** (live) and fetches a frame only on **`onPointerUp` / `onKeyUp`** (commit) — see §3.3a; "commit on change" would fetch per pointermove. A keyboard test covers the `onKeyUp` half. The PNG is the encoded frame at that second (VE-D6, already tested).
3. Scrolling the tape to the end shows the last tick, the video clip's right edge, and the playhead at `t = durationSec` — none of them cropped by the well's radius. Recorded as a screenshot in the PR on a 390-wide and a 1280-wide viewport.
4. Fit mode shows the full duration without a horizontal scrollbar on a 390-wide section host (D146) and on the rail at `56rem`. Zoom in introduces a scrollbar; the page `body` still does not scroll sideways.
5. Light and dark both keep a 3:1 playhead-readout edge (`border-border-control`) and a readable video clip (`brand-on-tint` on `brand-tint`).
6. No new hex, no play clock, no import of `scrub-bar.tsx`, no second `useState` pair for seconds outside `BriefEditor`.
7. ProportionBar and the title-lane widths agree to the pixel *formula* — both consume `resolveTimeline`. A named mutation that divides `weight / Σweight` inside `TimelineTape` fails a test.
8. `guided` and `everything` still render their Copy form. The tape sits beside it (D145) or under it (D146), never instead of it.

Until (3) and (4) this is the HTML sketch with tokens. Until (2) it is a picture.

---

## 11. Risks

- **CC2 slipping.** If the rail still rebuilds from whole `EditorState` per keystroke, a pointermove on the tape will feel like a stuck input. TS1 does not start while that feed is unmemoised.
- **Two hosts, one forgotten fetch.** D146's section host must not grow its own `usePreviewFrame`. The lift is the whole point.
- **Fit fighting the operator.** Re-fitting on every resize while `zoomedByUser` is true would steal a zoom. The flag is part of the lane, not a polish item.
- **Fade bands.** Drawing a crossfade on the title lane before anyone asks will be wrong at every duration except the previewed one (§4.2 of the studio plan). TS1 draws a 2px `border-l border-border` at each `startT` and leaves the fade band to a later paint-over that can caption "fade at 15 s preview."
- **happy-dom cannot see the cutoff.** The screenshot in the PR is the proof; a unit test that checks a style string containing `endPad` is necessary but not sufficient.

---

## 12. Open questions

| ID | Question | Blocks | Notes |
|---|---|---|---|
| **D146** | Section host under `56rem`, or rail-only? | TS2 | **Adopted 2026-09-17: section host.** **Gate amended by RS2 — see `2026-09-17_rail-in-the-shell.md` §4.2: "under `56rem`" becomes the shell's VIEWPORT breakpoint.** The rail's container query retired with the rail's move into the shell row, and a container query on the editor row cannot be the complement of a viewport gate on a shell column — a narrow viewport would show two tapes or none. TS2 is not dispatched, so this is a spec edit, not rework. The risk it retires: a tape living only in a CSS-hidden rail answers the mobile brief on paper and not on a phone. |
| **D147** | Zoom persistence | TS1 | **Adopted 2026-09-17: ephemeral, fit on load.** Zoom is not a property of the campaign; persisting it would surprise a second operator on the same brief. |
| **TS-Q1** | Does the video lane show the *key beat* as a tick on the filmstrip, or is the existing poster-frame toggle in the form enough? | none | Recommended: form only in TS1. A tick is decoration that would need a stable name if it became a control. |

VE-Q5 (speech vendor) and VE-D11 (footage) stay in the video-editing plan. They do not grow lanes here.

---

## 13. What this plan does not decide

- Whether `studio` presentation replaces the Layout step (studio §10; CC1 must settle it).
- Detach of preset tracks (D140).
- The L10a / L10b split and the preview-footprint API (C3 of the studio plan).
- Encoder fade policy for audio (stays encoder-side; the tape does not grow fade handles).
- Whether ProportionBar is *removed* once the title lane exists. D145 says the form stays; the bar is part of the form. Leaving it is the default; removing it is a copy-lane, not a tape-lane.

---

## 14. Relationship to the HTML sketch

Keep the sketch out of `apps/web`. It taught the cutoff lesson and the sticky-label lesson. It also taught four anti-lessons this plan exists to stop landing:

1. A play clock (`requestAnimationFrame`) that is not the encoder's frame index.
2. Literals (`#6ee7ff`, `#e8a04a`, `#7b5cff`) that cannot survive a theme toggle.
3. A second theme switch on the tape.
4. A ruler that does not share its scrollLeft with the clips — the cutoff.

The implementer reads §3 of this file, not the sketch, when writing `TimelineTape.tsx`.
