# Motion sequence editor — preview and timeline

**Status:** proposal. No lane is dispatchable until the decisions in §6 are stamped.
**Date:** 2026-10-12.
**Inspiration (local, not in the repo):** `/Users/martin/Desktop/video-editor-timeline.html` (ReelCut studio mock: program monitor, transport, resizable pane, multi-track timeline).
**Related, already on main:** `2026-08-27_motion-copy-timeline.md` (beats are weights, not timestamps), `2026-09-13_video-editing-features.md` (VE-D5 scrub is local and never autoplays; VE-D11 refuses footage import), `2026-09-16_rail-timeline-surface.md` (TimelineTape), `2026-09-16_studio-editor.md`, `2026-09-10_keyframing.md` (property tracks, not clips), `DESIGN.md` §3 (rail anatomy).

This document analyses a request to put a primary video preview above a user-editable timeline on motion creatives, with tracks the operator adds as video, text, or audio, and clips that drag and resize. It recommends what to wire to the brief that already exists, what is missing, and what the ReelCut file must not be copied as.

---

## 1. What was asked

When the operator is creating or editing a motion or video creative:

1. A primary video preview panel.
2. A timeline editor directly under that preview.
3. Tracks the operator can add, remove, show, hide, lock, and reorder.
4. Adding a track offers three kinds: video, text, audio.
5. Clips on those tracks are draggable and resizable.
6. The panel is wired into the editor that already ships. Missing domain behaviour is named, not invented in the component.

The ReelCut file is the visual reference: dark program monitor, timecode, play/pause, frame step, zoom, snap, split, delete, undo, filmstrip clips, a playhead, and a row-resize between preview and timeline. Its script keeps clips as `{ id, name, start, dur }` in **seconds** on a fixed 40.45 s sequence. Preview pixels are a procedural canvas, not a campaign frame. There is no text track, no brief, and no save.

---

## 2. What already ships

### 2.1 Where a creative is edited

`BriefEditor` publishes the right rail. For a look that has a product id, the rail mounts, in order:

1. `PreviewDock` — the one composed frame (D43). It receives `playhead`.
2. `TimelineTape` — only when `railProps.motion !== undefined` **and** the rail is wide enough (`BriefEditor.tsx`, the `railSlot` callback).
3. `LayerStack` — add / reorder / enable layers. Adding a layer dispatches `addLayer` with a kind the creative type accepts.

`previewLook` (`preview-props.ts`) sets `motion` only when `state.mode === "variation"` and `state.formats` includes `"motion"`, taking `state.motion[0]`. A classic brief, and a variation brief that did not ask for motion, do not mount the tape. The comment in that file is explicit: the plan carries `motion` only for a brief that asked for video, so a static draft must not become a moving one.

So "the motion creative editor" today is the **rail of a variation brief whose formats include motion**, not a separate route and not "creative type is `video`".

### 2.2 Three clocks that must stay three clocks

| Document | What a mark on it means | Stored as |
| --- | --- | --- |
| Copy timeline (`CopyTimeline.vo.ts`) | Order and **weight** of up to 8 beats. `resolveTimeline` projects weights onto whatever `durationSec` the run is drawing. At most 3 distinct per-beat backgrounds. | No seconds in the brief (D1). |
| Duration axis | Which clip lengths the variation includes. | `axes.duration`, separate from the copy ruler. The rail-timeline plan (finding C4) forbids drawing duration beads and copy beats as one tape. |
| Property tracks (`tracks.ts`) | Keyframes of `opacity`, `scale`, `dx`, `dy` on a layer. Clocks are `pose`, `beat`, `effect`. | Normalised `t` in stops, nested on the layer. |

`TimelineTape` is a **view** of the first and a sliver of the third: resolved beats, one video span for the whole duration, the brief's single `audio.path` when present, and diamonds for the picked layer's tracks. Scrub position is playhead state, not an editor action (VE-D5). Diamond and beat-boundary edits commit through callbacks that `BriefEditor` wires; the tape does not import the reducer.

The rail-timeline plan also refuses, in writing: a `requestAnimationFrame` play clock, an `<video>` or Web Audio graph, footage import, per-clip trim of an uploaded video, and ripple / slip / slide.

### 2.3 What a "video" creative is allowed to contain

`CREATIVE_TYPE_RULES.video` (`creative-types.ts`):

- Accepts `video`, `shade`, `animated-text`, `logo`.
- Requires `video` and `animated-text`.
- Caps logo and shade at one. Caps animated text at one (shared budget).
- Does **not** cap `video`, so more than one video layer is legal.
- Output family is `motion` only.
- Does not accept `static-text`, `image`, `fill`, `html`, or any audio kind.

`image-text` also lists `motion` in `outputFamilies`. That is a still stack (image + text) with a motion kind (ken burns and copy motion), not a video-layer sequence. It does not accept kind `video`.

### 2.4 Audio

`CampaignBrief.audio` is **one** music bed: `path` plus a rights record. It is not a list of clips and not a layer. The encoder can mux one bed (`VideoCompositorPort.audio?: Uint8Array`; VE3b). The entity comment in `CampaignBrief.ts` still says a run that declares `audio` is refused until VE3b; that sentence is older than the VE3b briefs and should not be treated as the live rule without re-reading `GenerateCampaignUseCase`. Rights validation in `load-brief.ts` is live.

There is no second audio stem, no per-clip gain, and no mute stored on a track.

### 2.5 Preview

The dock asks the server for one composited frame at `atSec` when the cell carries motion, duration, and time together (VE-D5). It does not play. Playback in the browser would either ignore that frame (and lie) or request a frame per tick (and spend the preview path as a video player).

---

## 3. Feedback on the request

The layout is the right shape for creative type `video`: program monitor on top, timeline underneath, inside the rail that already owns both. The ReelCut pane divider matches the wireframe's resizer more honestly than a fixed-height tape. Track headers (name, hide, lock, mute) are a good operator model **once a track is a real brief object**.

Four parts of the request fight the domain if they are built as the HTML file builds them.

**Seconds as the stored clip.** ReelCut stores `start` and `dur` in seconds against one duration. A campaign brief's copy timeline is valid at every duration on the axis because it stores weights. A clip stored in seconds is a different document: change the duration axis and every clip is either clipped, scaled, or silently wrong. Display seconds against the previewed duration (`axes.duration[0]`, the same clock the tape already uses). Persist normalised `t`, or persist weights for text beats. Do not persist seconds.

**"Motion creatives" as one editor.** Motion format on `image-text` and creative type `video` are different recipes. Putting an NLE of video/text/audio tracks on a ken-burns social clip invites tracks the type will refuse at `validateTemplate`. Mount a sequence editor only when `template.creativeType === "video"`. Keep `TimelineTape` for `image-text` plus motion.

**Text as a free track of resizable clips.** The video type allows exactly one `animated-text` layer. The copy document allows up to eight **beats** on that one line, as weights. A second text track is a schema change (raise the shared budget, or add a new kind). Resizing a text clip is already almost `shiftBeatBoundary`: it moves weight between neighbours. Dragging a text clip to a new start **out of order** is a reorder of beats, which the reducer already has to keep `keyBeat` pointing at the same text. Dragging it onto another text track is not a feature until a second text layer is legal.

**Play, split, and a bin of uploaded footage.** The HTML's transport (play, step, mute, fullscreen) and split tool are a non-linear editor. The stamped rules say scrub commits one frame and the product does not import footage (VE-D11) and does not autoplay (VE-D5). Copying those controls without restamping those decisions would ship a player that the preview path cannot feed and a split that has nothing to split except a generated span.

Drag and resize **within one track**, for the objects the brief already has, is the part that should be built first.

---

## 4. What to wire, and what is missing

### 4.1 Wire now (no new persisted shape)

Host this in the rail, in place of `TimelineTape`, only for creative type `video` when the look has motion. `BriefEditor` keeps owning commits. The new component does not import the reducer and does not contain the word `dispatch` (same rule as `TimelineTape`).

| Track the operator sees | Source already in the draft | Drag | Resize |
| --- | --- | --- | --- |
| Text | `copy.timeline` beats, projected by `resolveTimeline` onto `playhead.durationSec` | Reorder beats (existing reducer). Refuse a drop that would imply a second text layer. | `shiftBeatBoundary` on pointerup, one history entry. Same floor the tape already uses (`beatUnderFloor`). |
| Video | Each **enabled** layer with `kind === "video"`, one clip spanning the whole duration | Reorder is layer order (`LayerStack`'s existing action), not a time shift. A video layer has no in/out in the brief. | Refuse. There is no in/out to write. |
| Audio | `state.audio?.path`, one clip from 0 to `durationSec` if present | Refuse time shifts. | Refuse. The bed is the whole clip. |
| Shade, logo | Not timeline clips. They stay in `LayerStack`. | — | — |

Preview stays `PreviewDock`. The sequence panel does not draw its own canvas of the creative. Scrub still calls `onScrubLive` / `onScrubCommit`. Selection of a text beat is `selectedBeatIndex`. Selection of a video row is the same `pickedLayerId` the layer stack and the inspector use.

Add-track:

- **Video** dispatches `addLayer` with kind `video` (legal; uncapped). The new row appears as a full-duration clip with no media until the layer has an asset. Empty is an honest empty state, not a coloured fake filmstrip.
- **Text** is enabled only while the type has no animated-text layer yet. After that the control is disabled and the message names the one-text rule. It does not open a second track.
- **Audio** opens the existing music-bed field (path + rights). It does not create a layer kind. If a bed already exists, the control is disabled.

Hide and lock, in this slice, are view state in the component (not the brief), or they map onto `enabled` for a video layer only. Do not invent `hidden` / `locked` keys on the brief in this slice. Mute maps onto nothing: there is one bed and no mute field. Omit mute, or make it a local preview mute that is not saved. Say which in the PR.

Zoom, snap-to-beat-boundary, and the playhead are view state, as timeline zoom already is (D147: not a property of the campaign).

### 4.2 Missing, if the operator is to get the ReelCut document

These are product decisions. They are not implied by "wire it into existing functionality."

| Gap | Why the UI cannot invent it | Smallest honest addition |
| --- | --- | --- |
| Clip in/out on a video layer | A video layer is a stack item, not a timed interval. | A new value object, e.g. `span: { startT, endT }` on a video layer, validated in `validateTemplate`, rendered by the video compositor. Until that lands, resize of a video clip stays disabled. |
| More than one text track | Shared budget of one animated-text. | Raise the budget and teach the compositor to draw N text layers. Copy beats today are one timeline for the brief, not per layer. |
| Several audio clips | One `audio` object, one encoder input. | A list of beds with `startT`/`endT`, rights on each, and a mix in the encoder. Determinism of that mix is the same class of problem VE3b solved for one bed. |
| Split | Split needs two spans and, for text, two beats. | Text split can be "insert a beat at the playhead" only after a weight-split rule exists. Video split waits on the span field. |
| Play | VE-D5 and the rail-timeline refusal. | Restamp, then play by sampling the existing preview-frame endpoint at the motion fps with a hard request cap, or play a blob the generate path already produced. Do not add a second renderer in the browser. |
| Filmstrip thumbnails | The HTML paints noise from a hash. The product's frames come from the compositor. | One thumbnail per video clip from the preview already fetched at the clip's start, or a flat token fill. Do not generate a strip of AI frames. |
| Upload bin / drag a file onto a lane | VE-D11. Assets already have an upload path for product and scene images and for the music bed. | A video-asset upload is a separate lane: storage, rights, duration probe, and a layer field that points at it. |

### 4.3 What not to reuse

- Do not store the ReelCut `tracks[]` beside the brief. A second sequence document will drift from `copy.timeline` and from `template.layers`.
- Do not draw property-track diamonds and NLE clips as the same rectangles. Diamonds stay on the picked layer (TL6) or move back to the inspector. Mixing them makes a keyframe look like a clip.
- Do not put duration-axis beads on this timeline (finding C4).
- Do not mount this editor for `image-text`.

---

## 5. Recommended shape

**VT1 — view and text edits (first pull request).** A `SequenceTimeline` under `PreviewDock` for creative type `video` only. Text clips drag to reorder and resize to shift weight. Video layers and the music bed are full-duration, non-resizable rows. Add-track is the three-way control with the disables in §4.1. Scrub unchanged. No play button. No seconds in `toBrief`. `TimelineTape` remains for other motion looks. `BriefEditor` is the only owner of the new callbacks, so this lane owns that file and nothing else may touch it in the same wave.

**VT2 — video spans, only after a stamped value object.** `startT`/`endT` on video layers, compositor honours them, resize and horizontal drag write those fields, overlap rule is explicit (see §6).

**VT3 — audio list, only after a stamped mix.** Not in VT1.

**VT4 — playback, only after VE-D5 is restamped.** Not in VT1.

The pane divider is part of VT1 if it is local state with the same bounds idea as the column resizer (keep the preview usable, keep the timeline from collapsing below one track header plus one lane). It is not persisted (SG-D3).

---

## 6. Decisions that need a stamp before code

| Id | Question | Recommendation |
| --- | --- | --- |
| **VT-D1** | Who sees the sequence editor? | Creative type `video` and a motion look. `image-text` motion keeps `TimelineTape`. |
| **VT-D2** | Are clip times stored? | Not in VT1. Text stays weights. Video and audio are the whole duration. Later spans store normalised `t`, never seconds. |
| **VT-D3** | May video clips overlap on one layer? | No in any slice that adds spans. Overlap is a composite rule the renderer does not have. A second video **layer** is the overlap, and paint order is layer order. |
| **VT-D4** | Does "add text" ever make a second text track? | No, until the shared budget and the compositor change. The control disables. |
| **VT-D5** | Does "add audio" create a layer? | No. It binds the one music bed. |
| **VT-D6** | Play in the monitor? | No in VT1. Restamp VE-D5 before any play control. |
| **VT-D7** | Hide / lock / mute persisted? | No in VT1. Video hide may reuse `enabled`. Mute is omitted. |

---

## 7. Adversarial review

Checked against the tree, not against earlier planning prose.

**The request treats "timeline" as one thing. The tree has three, and the last plan that touched this surface exists to stop them being drawn as one.** A component that lets the operator drag a text clip in seconds will write either a lie (the gesture does not round-trip) or a break of D1 (seconds land in the brief). VT1's resize path has to call `shiftBeatBoundary` and then show the **resolved** windows again. A test that only asserts pixel positions will pass while the saved YAML still has the old weights.

**"Add a text track" is refused by the type the feature claims to edit.** `CREATIVE_TYPE_RULES.video.sharedBudgets` allows one animated-text. An enabled "Text" item that dispatches `addLayer` anyway fails in the reducer or, worse, succeeds in the UI and fails at save. The plan's disable is the fix. A review that accepts a second track "because the HTML has two video lanes" has not read the rule table.

**"Add audio" can be implemented as a layer kind that no renderer reads.** That is how a feature looks done in the rail and produces a silent file. Audio stays `CampaignBrief.audio`. Rights are mandatory in `load-brief.ts`. A control that sets `path` and omits `rights` cannot save. The add-audio flow has to collect the rights record the API already requires, or it is a dead button.

**Multiple video layers are legal and untimed.** The type does not set `maxOf.video`. Drawing each as a full-width bar is honest. Letting the operator drag one bar to `t = 0.4` without a span field is not. VT1 must reject that pointerup with no brief change. A test that fires `pointerup` and expects a new `start` has nothing to expect.

**Play is the failure mode of the inspiration file.** ReelCut's `playing` flag advances `state.time` and redraws a fake canvas. Wiring that flag to `PreviewDock` either storms `/preview-frame` or plays pictures the server did not draw. Both contradict VE-D5. Shipping the button disabled "for later" still teaches the wrong tool. Leave it out until VT-D6 is stamped.

**The rail already has a timeline.** Replacing `TimelineTape` for every `motion !== undefined` look deletes beat diamonds, boundary drag, and the audio-path row for `image-text` campaigns, which cannot host video tracks. The condition has to be creative type **and** motion, and the `image-text` tests that mount the tape have to stay green without the new component.

**`BriefEditor.railSlot` is hand-maintained.** A new callback in that closure whose dependency is omitted leaves a stale timeline after a beat edit. The lane that adds it owns `BriefEditor.tsx` alone in its wave. A second lane on that file makes a green test on either branch meaningless.

**Preview cost.** Resize-during-drag must not commit. The tape already commits boundary and diamond on release. A preview fetch on every `pointermove` is the bug TS1's acceptance (b) forbids. The new component inherits that: live scrub of the **playhead** may follow the existing live/commit split; clip resize does not call preview until pointerup, and then only if the playhead time's frame would change.

**Empty video track.** Add-layer of `video` with no asset still has to preview. If the compositor throws or draws nothing, the timeline must still show the row. Otherwise the operator adds a track and the panel disappears behind an error state that looks like a failed mount.

**Accessibility.** ReelCut is a canvas ruler plus absolutely positioned clips with almost no names. The product's tape already has a status sentence and labelled controls. Clips need a name that includes kind, index, and timing in seconds **as a label**, keyboard move by one snap step, and a non-drag way to change a beat weight (the existing number in the copy section). Pointer-only resize fails the bar the editor already holds.

**The inspiration file is not a spec.** It hard-codes three tracks, a 40.45 s duration, and generated art. None of those numbers belong in the component. Copying its CSS variables (`#f6b73c`, `#0b0c10`) would bypass `DESIGN.md` tokens. The layout (monitor, transport row, header column, scrollport, playhead) can be copied in structure. The colours cannot.

**False comfort from "the tape is close."** `TimelineTape` does not add tracks, does not resize video, and does not represent text as free clips. Calling VT1 a restyle of that file hides the creative-type gate and the disabled controls, which are the actual behaviour.

---

## 8. Tests that must be able to fail

- A video creative shows `SequenceTimeline` and does not show `TimelineTape`. An `image-text` motion creative shows `TimelineTape` and does not show `SequenceTimeline`.
- Add text while an animated-text layer exists does not dispatch `addLayer`.
- Add video dispatches `addLayer` with kind `video` and the new row is a full-duration clip.
- Add audio with a bed already set does not write a second `audio` key.
- Resizing a beat calls the boundary commit once on pointerup and never on pointermove, and the saved timeline still has integer weights only.
- Dragging a video clip horizontally leaves the brief unchanged.
- A still brief mounts neither timeline.
- No preview-frame request on clip pointermove.

A test that renders the ReelCut HTML, or that asserts a play button toggles a timer, does not belong in VT1.

---

## 9. What this plan refuses

- A second sequence document beside the brief.
- Seconds persisted on beats, layers, or audio.
- Browser-side ffmpeg, a `<video>` element as the program monitor, or Web Audio playback in VT1.
- Footage import, split, ripple, slip, or slide in VT1.
- Replacing `LayerStack`. The timeline is a timed view of some layers, not the only place a layer exists.
- Using the ReelCut file as an asset in the app. It stays a desktop reference.

---

## 10. Open questions for the owner

1. Confirm VT-D1: sequence editor for creative type `video` only, tape remains for other motion.
2. Confirm that VT1 ships with video and audio clips that cannot be resized, and says so in the UI, rather than waiting for spans.
3. Whether add-audio in the timeline may open the existing rights form, or whether audio stays only in the form section for VT1 (the track would then be display-only).
