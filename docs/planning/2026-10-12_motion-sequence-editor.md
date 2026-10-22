# Motion sequence editor — preview and timeline

**Status:** r2 — two plan reviews folded (2026-10-12). **§6 VT-D1..D8 stamped by the owner as written, 2026-10-22** ("Stamp all 8 as written"); VT1 (#820) may merge when green. The reviews' blockers are corrected in §2, §4, §5 and §8; they are listed in §11.
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

`BriefEditor` publishes the right rail. `PreviewDock` mounts whenever `railProps !== null` (`railSlot`), which is whenever the draft has a product with an id. It is not gated on motion. Under it, when the rail is wide enough:

1. `TimelineTape` — only when `railProps.motion !== undefined` **and** the rail is wide enough (`BriefEditor.tsx`, the `railSlot` callback).
2. `LayerStack` — add / reorder / enable layers. Adding a layer dispatches `addLayer`. Reorder is `moveLayer`. Hide is `setLayerEnabled`.

`previewLook` (`preview-props.ts`) derives the **default** `motion` only when `state.mode === "variation"`, `state.formats` includes `"motion"`, and `state.motion` is non-empty, taking `state.motion[0]`. The selected creative then overrides that default unconditionally: `motion: (variant?.motion as MotionKind | undefined) ?? motion`. `BriefEditor` passes `selectedCreative` into `previewDockProps`. A classic brief normally mounts neither timeline. A supplied or retained `variant.motion` can still mount the tape on a draft whose own mode and formats would not.

Below the rail breakpoint, `TimelineSection` (`sectionTape`) mounts a second `TimelineTape` when the rail is hidden, a playhead exists, and the draft has beats. That host wires scrub and beat selection only. It does not wire diamond or boundary commits. Replacing the rail tape and leaving `sectionTape` alone leaves a video creative on a narrow viewport on the old tape.

`canSerializeTimeline` is stricter than "the tape is mounted": the beats reach `toBrief` only when mode is variation, formats include motion, **and** the headline-pool axis is off. Edited beats that fail that gate must keep `TimelineSection`'s existing dropped-timeline notice. The sequence panel does not get its own copy of the rule.

So "the motion creative editor" today is not a separate route and not "creative type is `video`".

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

`CampaignBrief.audio` is **one** music bed: `path` plus a rights record (`validateAudio` in `load-brief.ts`). It is not a list of clips and not a layer. The encoder muxes that bed: `GenerateCampaignUseCase` resolves it (`resolveBriefAudio`) and passes the bytes into `compositeVideo`. The sentence in `CampaignBrief.ts` that still says a run declaring `audio` is refused until VE3b is stale. VE3b2 retired that interim refusal. It did not retire the footage-import or video-decode refusal (VE-D11).

The web editor does not author audio. `BriefEditor.collectUnresolvedAssetRefs` says `audio.path` has no control that reads or writes it. `EditorAction` has no audio setter; the general patch path does not write `audio`. `EditorState.audio` is kept verbatim across load and save when it satisfies `isAudio`. There is no music-bed field and no rights form to open.

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
| Text | `copy.timeline` beats, projected by `resolveTimeline` onto `playhead.durationSec` | `moveBeat({ from, to })` on pointerup. One text layer, so a drop never creates a second track. | `shiftBeatBoundary({ boundary, delta })` on pointerup, and only at an **internal** join. The outer edges of the sequence, and a one-beat sequence, have no boundary (`TimelineTape`'s `BeatBoundary`). Weights stay integers in `[1, MAX_WEIGHT]`. A dwell-floor breach is committed and flagged (`beatUnderFloor`), not refused. |
| Video | Each video layer, **including disabled ones**, one clip spanning the whole duration | `moveLayer` (stack order), not a time shift. `CreativeTemplateLayer` has no media ref and no span. `LAYER_PROPS.video` accepts no props. `LAYER_DRAWERS.video` paints the shared background. | Refuse. There is no in/out to write. |
| Audio | `state.audio?.path`, one clip from 0 to `durationSec` if present. Display only. | Refuse. | Refuse. |
| Shade, logo | Not timeline clips. They stay in `LayerStack`. | — | — |
| Diamonds | The picked layer's property tracks, the same `trackDiamonds` / `onDiamondCommit` → `setTrackStop` pair the rail tape has today | — | The diamond commit stays on this component in VT1. `LayerPropsSheet` and `LayerStack` do not draw diamonds. Dropping them here removes TL6 for video creatives. `TrackForm` remains the numeric editor. |

`moveBeat` keeps the persisted `keyBeat` on the same text. `BriefEditor` clears the ephemeral beat selection after sequence edits. A reorder test has to assert the saved `keyBeat`, not the selection highlight.

Preview stays `PreviewDock`. The sequence panel does not draw its own canvas of the creative. Scrub still calls `onScrubLive` / `onScrubCommit`. Selection of a text beat is `selectedBeatIndex`. Selection of a video row is the same `pickedLayerId` the layer stack and the inspector use.

Add-track:

- **Video** dispatches `addLayer` with kind `video` (legal; uncapped). The new row is another full-duration layer that paints the shared background. It is not an empty footage slot.
- **Text** is enabled only while the type has no animated-text layer yet, counting disabled layers (the shared budget counts them). After that the control is disabled and the message names the one-text rule.
- **Audio** is display-only in VT1, the same fact `TimelineTape` shows as `audioPath`. There is no field to open. A writable bed is a later lane: a path-and-rights control plus an `EditorAction`. Do not add a layer kind.

Copy-section actions that already exist and that VT1 does not move onto the timeline: `setBeatText`, `setKeyBeat`, `setBeatBackground`, `setTransition`, `addBeat`, `removeBeat`. They stay in `TimelineSection`. The timeline's text track is order and weight only.

Hide on a video row dispatches `setLayerEnabled`. `setLayerEnabled` refuses to disable the last enabled layer of a required kind, and video is required, so the last enabled video row cannot be hidden. A successful disable must **leave the row visible** and offer enable again. Filtering the timeline to `enabled !== false` hides the only control that can turn the layer back on. Lock is omitted in VT1 (no stored lock). Mute is omitted (no stored mute, and no local preview mute in this slice).

`LayerStack` stays mounted under the timeline, so add, reorder, and enable also exist there. VT1's track header repeats those offers for video rows. That repetition is accepted so the timeline can be used without scrolling to the stack. It is not a second source of truth: both call the same actions. Weight steppers in `TimelineSection` likewise stay; the boundary drag is the same `shiftBeatBoundary`.

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
- Do not draw property-track diamonds as if they were clips. In VT1 they stay on `SequenceTimeline`, committed with `setTrackStop`, because no other surface draws them. A later lane may move them to the inspector only after that surface commits `setTrackStop`.
- Do not put duration-axis beads on this timeline (finding C4).
- Do not mount this editor for `image-text`.

---

## 5. Recommended shape

**VT1 — view and text edits (first pull request).** A `SequenceTimeline` under `PreviewDock` when the creative type is `video` **and** the mounted look has motion (including a selected variant's own `motion`). Text clips drag via `moveBeat` and resize via `shiftBeatBoundary` at internal joins. Video layers, disabled ones included, and the music bed are full-duration, non-resizable rows. Audio is display-only. Diamonds stay, wired as they are on the rail tape today. Add-track is video (another background-painting layer) or text (only while the budget allows). Scrub unchanged. No play button. No seconds in `toBrief`. `TimelineTape` remains for other motion looks.

The lane owns `BriefEditor.tsx` and `TimelineSection.tsx`. The narrow host (`sectionTape`, D146, under 56rem) must mount `SequenceTimeline` for a video creative and `TimelineTape` otherwise, or a narrow video draft keeps the old tape. Nothing else may touch those two files in the same wave. The new component does not import the reducer and does not contain the word `dispatch`.

**VT2 — video spans, only after a stamped value object.** `startT`/`endT` on video layers, compositor honours them, resize and horizontal drag write those fields, overlap rule is explicit (see §6).

**VT3 — audio list, only after a stamped mix.** Not in VT1.

**VT4 — playback, only after VE-D5 is restamped.** Not in VT1.

The pane divider is part of VT1 if it is local state with the same bounds idea as the column resizer (keep the preview usable, keep the timeline from collapsing below one track header plus one lane). It is not persisted (SG-D3).

---

## 6. Decisions that need a stamp before code

**Stamped 2026-10-22 by the owner: VT-D1 to VT-D8, all as written below.**

| Id | Question | Recommendation |
| --- | --- | --- |
| **VT-D1** | Who sees the sequence editor? | Creative type `video` and a motion look, on both hosts (rail and the narrow Copy-section tape). The look's motion includes a selected variant's `motion`, which can override the variation-and-format default. `image-text` motion keeps `TimelineTape`. A classic video brief whose look has no motion still mounts neither timeline; that matches `previewLook` today. Giving that brief a timeline means restamping the variation gate, not slipping it into VT1. |
| **VT-D2** | Are clip times stored? | Not in VT1. Text stays weights. Video and audio are the whole duration. Later spans store normalised `t`, never seconds. |
| **VT-D3** | May video clips overlap on one layer? | No in any slice that adds spans. Overlap is a composite rule the renderer does not have. A second video **layer** is the overlap, and paint order is layer order. |
| **VT-D4** | Does "add text" ever make a second text track? | No, until the shared budget and the compositor change. The control disables. |
| **VT-D5** | Does "add audio" create a layer or open a form? | No. VT1 shows `state.audio?.path` and does not write it. A path-and-rights control plus an editor action is a later lane. |
| **VT-D6** | Play in the monitor? | No in VT1. Restamp VE-D5 before any play control. |
| **VT-D7** | Hide / lock / mute? | Video hide dispatches `setLayerEnabled` and the row stays on the timeline when disabled, so it can be enabled again. The last enabled required video layer cannot be disabled. Lock and mute are omitted. No new brief keys. |
| **VT-D8** | Where do property-track diamonds go in VT1? | They stay on `SequenceTimeline`, same callbacks as today's rail tape. They are not dropped and not redrawn as clips. |

---

## 7. Adversarial review

Checked against the tree, not against earlier planning prose.

**The request treats "timeline" as one thing. The tree has three, and the last plan that touched this surface exists to stop them being drawn as one.** A component that lets the operator drag a text clip in seconds will write either a lie (the gesture does not round-trip) or a break of D1 (seconds land in the brief). VT1's resize path has to call `shiftBeatBoundary` and then show the **resolved** windows again. A test that only asserts pixel positions will pass while the saved YAML still has the old weights.

**"Add a text track" is refused by the type the feature claims to edit.** `CREATIVE_TYPE_RULES.video.sharedBudgets` allows one animated-text. An enabled "Text" item that dispatches `addLayer` anyway fails in the reducer or, worse, succeeds in the UI and fails at save. The plan's disable is the fix. A review that accepts a second track "because the HTML has two video lanes" has not read the rule table.

**"Add audio" cannot open a form that is not in the tree.** `EditorAction` has no audio setter. VT1 shows the path and writes nothing. A control that set `path` and omitted `rights` would still fail `validateAudio`. Authoring the bed is a later lane, not a button in VT1.

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

- Wide rail, variation, motion format, creative type `video`, a product id, and a motion look: `SequenceTimeline` is mounted and `TimelineTape` is not. The same draft below the rail breakpoint: the Copy section mounts `SequenceTimeline`, not `TimelineTape`.
- An `image-text` motion look on either host shows `TimelineTape` and does not show `SequenceTimeline`.
- A classic brief with no variant motion, and a still brief, mount neither timeline on either host.
- A selected variant that carries `motion` mounts the timeline even when the draft's own mode would not. The video-type branch of that case mounts `SequenceTimeline`.
- Add text while an animated-text layer exists (enabled or disabled) does not dispatch `addLayer`.
- Add video dispatches `addLayer` with kind `video`. The new row spans the whole duration. The saved layer has no media field.
- The audio row reads `state.audio?.path`. No action writes `audio`.
- Resizing an internal beat join calls `shiftBeatBoundary` once on pointerup and never on pointermove. A one-beat sequence and the outer edges have no handle. Saved weights are integers in `[1, MAX_WEIGHT]`.
- Reorder calls `moveBeat` once on pointerup. The persisted `keyBeat` still names the same beat text.
- Dragging a video clip horizontally leaves the brief unchanged. Hiding a video row calls `setLayerEnabled`. Hiding the last enabled video layer leaves the draft unchanged. A disabled video row is still in the timeline and can be enabled.
- When `canSerializeTimeline` is false and beats exist, the Copy section still shows the dropped-timeline notice.
- Diamonds for the picked layer still commit `setTrackStop` on release.
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
3. Whether a later lane should add the missing path-and-rights control. VT1 does not: there is no form section to leave the audio in. The row is display-only.

---

## 11. Plan review, 2026-10-12

Two read-only reviews. Both treated a false claim about shipped code as blocking. Folded above. What each blocker was, and where it went:

| Review | Blocker | Correction |
| --- | --- | --- |
| 1 | `previewLook` lets `variant.motion` override the variation-and-format default. | §2.1, VT-D1. |
| 1 and 2 | No music-bed field, no rights form, no `EditorAction` for audio. | §2.4, §4.1, VT-D5. Question 3 withdrawn. |
| 1 | A video layer has no footage slot; the drawer paints the shared background. | §4.1 add-video. |
| 1 and 2 | `TimelineSection.sectionTape` still mounts `TimelineTape` under the breakpoint. | §2.1, §5, §8. VT1 owns that file too. |
| 2 | Dropping diamonds removes TL6; the inspector does not draw them. | §4.1, §4.3, VT-D8. Diamonds stay on the new component. |
| 2 | A non-variation video brief has no motion look, so VT-D1 mounts nothing. | Kept, and named in VT-D1. `outputFamilies: ["motion"]` does not by itself set `previewLook.motion`. Changing that is a restamp, not VT1. |

Also folded from the fix lists, not only the blockers: `moveBeat` / `moveLayer` / `setLayerEnabled` by name; internal joins only; dwell floor is flagged after commit; the interim audio refusal is stale because `resolveBriefAudio` already feeds `compositeVideo`; disabled rows stay visible; `canSerializeTimeline` includes the headline-pool axis; `keyBeat` survives `moveBeat`.

Notes kept as notes: one video layer is not capped; a second animated-text layer is refused even when disabled; no stored clip span (`ResolvedBeat.startT` / `endT` are derived); VE-D5, VE-D11, and the rail-timeline play-clock refusal are still live; `LayerStack` and the Copy form's beat controls stay mounted beside the timeline.
