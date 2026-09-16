# The studio editor — a layer inspector and a time surface, on one document

**Date:** 2026-09-16 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
**Scope:** the editor chrome around `EditorState`. No new renderer, no new document field except where a lane says so.
**Premise of the whole plan:** `/brief/new` and `/brief/:id` already share `BriefEditor` and `editor-state`. The gap is not
a create surface. The gap is that `TemplateSection` and `TimelineSection` are **data entry for a list**, not editors of a
creative. This plan adds the two editors and refuses to add a second create path.

---

## 0. Findings from the current tree (verified at `origin/main` `218b2d3d`)

| # | Severity | Finding |
|---|---|---|
| **C1** | Critical | **`H2` is not preview hit-testing, and it already shipped.** `2026-09-08_creative-templates-and-units.md:381` defines H2 as **world-map** hit-testing by smallest containing footprint; it merged as #285 `e34fc51b`. The templates plan reuses only its *test technique* for the preview (`:325`). So there is nothing to "invert" and nothing to wait for: the real defect is that **L10-templates bundles two lanes** — the `frame` field (a document change the compositor reads) and preview selection-by-click (a UI affordance). §3.3 splits them as **L10a** and **L10b**, to be recorded in the templates plan, not here. |
| **C2** | Critical | **`L10` and `L11` are colliding ids.** `2026-09-04_run-exclusion-and-the-distributed-lock.md:77-78` uses L10/L11 for the pool revision and report merge (both closed). `2026-09-08_creative-templates-and-units.md:261-262` uses L10 for **Frame (D130)** and L11 for **fill/region (D131/D132)**. Every reference here is qualified **L10a/L10b-templates**, **L11-templates**. |
| **C3** | Critical | **Preview selection needs an API surface nobody has named.** H2's technique is SVG paint order over DOM footprints, with no coordinate arithmetic (`packages/ui/src/world-map.tsx:49-70`). A raster preview has no DOM per layer, and the logo relocates per headline, so selection needs **per-layer resolved footprints from the compositor** — a preview-route response change. That is a renderer/API lane, and **SE5 may not be scheduled until it exists**. |
| **H2f** | High | **`MAX_WEIGHT` is 20, not 5.** `CopyTimeline.vo.ts:38`. `TimelineSection.tsx:88` already binds the stepper to `MAX_WEIGHT`. Any ruler drag must commit integers in `[1, 20]` through the same path. |
| **M1** | Medium | **The create dialog is name + campaign type**, not name + mode (`CreateCampaignDialog.tsx:116`, T3/#236; `CAMPAIGN_TYPES` tiles at `:332`). Mode arrives through the type's preset (D110), applied once (D109). |
| **M2** | Medium | **There is no selection state anywhere** in `apps/web/src` — no `selectedLayerId`, no `selectedBeat`. Both editors need one, and D-select below decides where it lives. |
| **M3f** | Medium | **`addableKinds` / `removableLayerIds` already exist** (`derive.ts:162`, `:217`) and are the only legal source of add/remove offers. The inspector must not compute its own. |
| **L1** | Low | `packages/ui/src` already ships `option-tile.tsx` and `stepper.tsx`, which the studio chrome composes rather than duplicating. **`scrub-bar.tsx` is not one of them**: D88 froze it as a decorative glyph and VE-D5 explicitly leaves it alone (`scrub-bar.tsx:9`). The ruler is a new component; it must not be built by un-freezing that one. |
| **L2** | Low | **`TRACKABLE_LAYER_KINDS` is module-private** (`tracks.ts:91`), so a Tracks tab would hard-code the list and drift from the boundary. SE6 exports it (as K1a already did for `TEXT_LAYER_KINDS`) rather than restating it. Likewise every refusal the track form makes must be `layerTracksProblem`'s, called — the one-clock rule, the duplicate `t`, the clock-by-kind rule — never re-implemented in the UI. |

---

## 1. Decisions — answered by the owner on 2026-09-16

Everything else here follows from decisions already recorded. These four did not, and the owner **adopted the recommended default for each on 2026-09-16** (recommended defaults, plan-reviewed). They are stamped below and the lanes may be dispatched against them.

| ID | Question | **Decision (owner, 2026-09-16)** | Why |
|---|---|---|---|
| **D137** | A third presentation (`studio`) beside `guided` / `everything` — and is it **a user toggle** or **automatic**? | **Third presentation, chosen by the operator**, like the other two (D19): it joins the `Presentation` union (`BriefEditor.tsx:90`) and persists under `cf:presentation` (`:92`). It is offered only when the draft can use it (motion in `output.formats`, or a template larger than the canonical stack) but is **never switched on by itself**. The rail's breakpoint is the existing **container query** `@container(min-width:56rem)` (`BriefEditor.tsx:1664`), not a Tailwind `lg`. | A presentation the operator did not choose moves their editor under them. Offering-vs-selecting is the distinction §5 previously blurred. |
| **D138** | May a ruler drag rewrite beat weights, and what happens at the dwell floor — **snap back** (prevent) or **commit and flag** (today's policy)? | **Drag allowed**, as a **neighbour transfer** (see TL3). At the floor: **commit and flag**, matching the recorded policy that the dwell floor is "detection plus refusal to run, not prevention" (`2026-09-10_motion-copy-timeline.md:319-321`, implemented at `TimelineSection.tsx:28-32`). Snap-back would be a **new** policy and must be stamped as one. | A weight is the document; seconds are a projection. Two different floor policies in one editor is the defect this decision exists to avoid. |
| **D139** | Is "selected layer / selected beat" editor state, YAML, or ephemeral UI state? | **Ephemeral UI state**, extending **VE-D5**, which already put the scrub position in local component state and "never an editor action" (`2026-09-13_video-editing-features.md:26`). Not in `EditorState`, not in the brief, not in `localStorage`. | Selection is not a property of the campaign. Persisting it would dirty a loaded brief (X16) and would have to survive `fromBrief`. |
| **D140** | When K4 composes hand-authored tracks with a preset expansion, does the editor hide the preset, bake it, or show both? | **Two groups**: authored stops editable, preset stops read-only **and labelled with the kind and canvas they were expanded for** — `copyMotionTracks(motion, height)` is per-canvas (`motion-tracks.ts:104`) and `motion` is a per-cell axis value, so "the preset's stops" is not one list across a variation run. **"Detach" is explicitly *not* scoped here**, and may be infeasible while the motion axis holds more than one kind. | K-D9 fixed composition, not presentation. Presenting a per-cell expansion as if it were a single document list would be a lie the operator cannot check. |

---

## 2. What this plan refuses to build

Listed because each will look like "the editor" and each fights a recorded decision.

- A second create wizard with its own state, or a `/brief/new/studio` route.
- Timestamped beats (D1: beats and weights, never timestamps).
- Per-join transitions (the timeline carries one `transition`; per-join is a new domain decision).
- Any track UI before **K4** — the compositor does not read `layer.tracks` yet, so a stop the operator authored would do nothing.
- Props UI for fields no drawer reads: `image.props.alt`, `fill` before L11-templates. `shade.alpha` no longer exists (R-D4).
- The accent wipe as a `dx`/`opacity` track. It is a clip extent; K2 left it drawer-local deliberately.
- In-browser playback or encoding (VE-D2), footage import (VE-D11), per-creative finishing (D51).
- Track UI on `html` (not a trackable kind: two renderers must agree and the markup has no motion mechanism).

---

## 3. The layer editor

### 3.1 What exists

`TemplateSection.tsx` is an ordered list with the M3 enable toggle, add/remove/reorder filtered by the compatibility table, and `HtmlElementsEditor` nested under an `html` layer. It is a good **navigator**. There is no inspector: no props, no frame, no tracks.

### 3.2 The shape

Three panes against one selection: **stack** (today's list, plus selection), **inspector** (tabbed by what the selected kind can carry), and later **canvas selection**. Tabs that would be empty are omitted, never rendered disabled — the same rule that keeps a text input off an `image` element.

**Inspector tabs, and the order they may ship in:**

| Tab | Kind | Fields | May ship when |
|---|---|---|---|
| Props | `accent` | `solidHeight`, `fadeHeight` | **Now** — C4 made them live |
| Props | `logo` | `width`, `margin` | **Now** — C4 |
| Props | `static-text` / `animated-text` | `typeFloor` | **Now** — C4. The `anchor` prop control is **hidden while `variation.axes.anchor` is live**, with the reason shown (C4b refuses the combination at both boundaries) |
| Elements | `html` | the existing `HtmlElementsEditor` | **Now** — already the inspector for that kind |
| Frame | any drawn kind | `x`, `y`, `w`, `h`, `anchor` | **L10-templates** (D130) |
| Tracks | `image`, `video`, `static-text`, `animated-text` | see §4.4 | **K4** |
| — | `image`, `video` | nothing | `alt` stays hidden until a renderer emits it |
| — | `shade` | nothing | alpha withdrawn |
| — | `fill` | nothing | L11-templates |

Numeric fields use `HtmlElementsEditor`'s `FrameNumberInput` pattern — a local draft string while focused, committing only finite numbers — because a controlled numeric value cannot be half-typed. An edit that changes nothing returns the same state and creates no undo entry.

### 3.3 Lanes

| Lane | Depends on | Ships | Proof |
|---|---|---|---|
| **SE0** | D137 | The `studio` chrome itself: a third `Presentation` value, offered only when the draft can use it, selected only by the operator, laid out by the existing container query. No new section component. | Switching presentation changes no document byte; `guided` and `everything` render exactly as today. |
| **SE1** | SE0, D139 | Selection + inspector shell. Stack rows become selectable; the inspector **hosts the existing `HtmlElementsEditor`**, which stops being mounted inline in `TemplateSection`. | Selecting a row changes no document byte; the html element editor behaves identically to its inline mount, asserted by its existing tests. |
| **SE2** | SE1, C4 (shipped) | Live geometry props: accent heights, logo width/margin, text `typeFloor`. Closes the "YAML only" gap for every prop a drawer reads. | Every control maps to a `mergeGeometry` read; a brief with no props round-trips byte-identically; the anchor control is absent while the axis is live. |
| **SE3** | SE1, **L10a-templates** | Frame form (fraction inputs + anchor). | Frames present and defaulted leave the goldens unmoved — L10's own criterion, which belongs to L10a. |
| **SE5** | SE3, **L10b-templates**, and the preview-footprint API (C3) | Canvas handles. | A drag-then-blur writes the **same fractions** the form commits, asserted byte-equal. |
| **SE6** | K4 | Tracks tab. **This lane is K5** (`2026-09-10_keyframing.md:77`) and retires K5's fence. | §4.4. |

**Dropped after review: the occlusion lane.** The advisory notice already ships — the reducer sets it (`editor-state.ts:1380`) and `sections/TemplateSection.tsx:226-230` renders it with `role="status"`. It had no fence, which is exactly the drift a fence prevents; recorded here rather than re-planned.

**To be recorded in the templates plan, not here:** split L10 into **L10a** (the `frame` field, its compositor read, `CREATIVE_GEOMETRY` defaults, goldens unedited) and **L10b** (click-to-select in the preview, which needs C3's footprints).

---

## 4. The timeline editor

### 4.1 Three surfaces, three documents — named separately on purpose

| Surface | Document | Clock | State today |
|---|---|---|---|
| **Copy timeline** | `copy.timeline.beats[]` (`text`, `weight`, `background?`), `transition`, `keyBeat` | `copyT` → beat windows | The **form** is shipped and correct. No time surface. |
| **Motion tracks** | `layer.tracks[]` + preset expansion | `pose`, `beat`, `effect` | Model, resolver and expansion shipped. **Brief tracks unread (K4).** No UI (K5). |
| **Audio** | `brief.audio` | encode wall clock, rounded to whole frames | Rights spine shipped. Encoder in review (#431). No lane. |

The copy timeline sequences **what is said and which ground shows**. Tracks sequence **how a layer moves**. They share a playhead and a duration and nothing else. Conflating them is how this becomes an NLE.

### 4.2 The copy ruler

The ruler is a **projection of weights** onto the duration the preview is drawing — which is `axes.duration[0]` (`PreviewDock.tsx:177`), not the shortest. Three things follow, and the lane must honour all three:

- **Boundaries are duration-invariant** (`startT = Σw<i / Σw`, `CopyTimeline.vo.ts:117`), so the ruler's beat proportions are honest for every duration in the axis at once.
- **The dwell floor is not.** It binds at `min(durations)` (`:230`), so any under-floor mark, and any limit a drag enforces, must be evaluated at the **shortest** duration even while the ruler is drawn for the previewed one.
- **Fade bands are not either** — `fadeInT` is duration-dependent (`:104-108`, D9), so a drawn crossfade band belongs to the previewed duration and must be captioned as such.

**In scope:** select a beat (the inspector shows text, weight, key-beat, scene); drag a boundary to rewrite **weights** (D138) — a breach of the dwell floor is **committed and flagged**, never snapped back, because that is the recorded policy and the form already behaves that way; add/remove under the existing gates (`MAX_BEATS` 8, dwell floor); click the ruler to move the scrub position; a key-beat marker (the poster frame).

**Reordering stays on the existing control.** The ↑/↓ buttons already dispatch `moveBeat` (`TimelineSection.tsx:108-118`). Drag-to-reorder is **not** in any lane here; proposing it in prose without a lane is how a plan grows work nobody costed.

**Out of scope:** absolute timestamps, ripple/slip/slide, per-join transitions, per-ratio beat text, in-browser playback.

### 4.3 Scenes

VE5 shipped the whole spine; the editor needs one thin surface. Each beat may name an uploaded image; at most **3 distinct** values; a beat naming nothing spends nothing and repeats count once. **`scenesProblem` is the gate** — the editor already mirrors that count and must keep calling the domain function rather than keeping a second counter. A beat with no scene, and a beat whose scene is missing from the request, take the same fallback: the campaign ground. The chip says so; the editor must not imply a generated substitute (VE5b2 refuses one deliberately).

### 4.4 Tracks (after K4)

1. A trackable layer's properties are rows: `opacity`, `scale`, `dx`, `dy`.
2. A row is a list of stops: `t`, `value`, `easing?`, `clock`.
3. Adding a stop maps the playhead onto that row's clock — pose: `atSec / durationSec`; beat: local progress inside the current beat; effect: the resolver's own mapping.
4. **A track's clock is chosen once.** Changing it on a non-empty track creates a new track; it does not mutate the stops (the one-clock rule K1b added).
5. `beat` and `effect` clocks are offered on **text kinds only** — the boundary refuses them elsewhere, because a ground layer's beat-clock value would jump when the beat pair rotates.
6. A duplicate `t` on one clock is refused at commit, in the domain's words.
7. An empty stop list is an **absent track**, never `stops: []`.
8. Preset motion kinds stay a dropdown that expands to tracks; per **D140** the expansion's stops are shown read-only beside authored ones.

**Visual lane, only after the form works:** diamonds on the ruler, one row per property, dragging in `t` only. The value is edited in the inspector. No curve editor; easing is a select whose default is the resolver's default.

### 4.5 Audio lane (after #431)

One span labelled with the path and licence id; rights fields stay in Output. No per-beat music, no fade control (the fade is encoder policy). **The caption shows the encoded duration beside the brief duration**, because the encode rounds to whole frames — the drift review caught on #431 must not be able to hide behind a lane that draws the brief's number.

Captions (VE4) wait on the vendor; do not draw a caption lane that implies beat-tied cues, because cues come from speech timings.

### 4.6 Lanes

| Lane | Depends on | Ships | Proof |
|---|---|---|---|
| **TL1** | SE0, D139, VE2 (shipped) | One playhead, **two positions preserved**: the ruler follows the live drag position, the preview keeps the committed one. Both lift from `PreviewDock` to `BriefEditor` beside `railProps`; the form stays. | The ruler tracks the pointer without fetching a frame per pixel — `scrubSec`/`committedSec` (`PreviewDock.tsx:178-186`) keep their split, and the committed frame still equals the encoded frame. |
| **TL2** | VE5 (shipped) | Scene chips on beats: attach and clear an uploaded background. | The fourth distinct scene is refused by `scenesProblem`, not by a local count; a beat with no scene shows the campaign ground. **The PR states the X33 exposure.** |
| **TL3** | TL1, D138 | Boundary drag as a **neighbour transfer**: a new `shiftBeatBoundary`-shaped action moves weight between two adjacent beats (`w_i + Δ`, `w_{i+1} − Δ`), with a coalesce key so one drag is one undo entry, committed on release. | A drag writes integers in `[1, MAX_WEIGHT]`; the floor is checked with `dwellProblem` against a **simulated** timeline — the way `addBeatBlockedBy` already does (`editor-state.ts:869-885`) — never a literal 1.2; and per D138 the breach is **committed and flagged**, not prevented. |
| **TL4** | #431 | Audio span, display only. | The caption shows the encoded duration beside the brief's, and **reads the rounding from the encoder** rather than recomputing `round(durationSec × fps)` in the web app. |
| **TL5** | K4, SE1 | Track form in the inspector. **This is K5** and retires its fence. | An authored stop changes the preview; goldens unmoved when tracks are absent. Every refusal is `layerTracksProblem`'s, called — not restated. |
| **TL6** | TL5 | Diamonds on the ruler, time-only. | Dragging a diamond writes the same `t` the form commits. |
| **TL7** | TL5, D140 | Preset ⊕ authored shown as two groups. | An operator can tell which stops came from the preset. |

---

## 5. Create and edit share everything

Create is a **seed**, not a surface. The difference is state, not components:

- **Create:** no `source.revision`; the campaign type's canonical template materialised; empty copy; one product stub; formats seeded by the type; Guided on.
- **Edit:** a loaded snapshot, dirty-since-save, Save as…, duplicate, apply-to-run.

The dialog stays two fields (name + campaign type). Anything the editor owns does not move into the dialog — that argument is already settled and should not be reopened. "Start from existing" remains Duplicate in the picker (D71); a duplicate is **edit with a new id**, and it already carries pool, scenes, audio path and layers.

The studio chrome appears when the draft has motion in `output.formats` **or** a template larger than the canonical stack. Below `lg`, the same components render as today's sections.

---

## 6. Order

**Wave A — the chrome, then the two shells:** SE0 (studio presentation) → TL1 (one playhead, two positions) ‖ SE1 (selection + inspector shell) → TL2 (scene chips).
**Wave B — fields the compositor already reads:** SE2 (geometry props) ‖ TL3 (neighbour-transfer drag).
**Wave C — behind open fences and other plans:** **L10a-templates** → SE3 (frame form); K4 → TL5 = SE6 = **K5**; TL4 after #431 merges.
**Wave D — manipulation:** C3's preview-footprint API → **L10b-templates** → SE5 (handles); TL6 (diamonds); TL7 (preset honesty).

K3 (text effects as entrance tracks) may land in parallel with Wave C: it changes the expansion, not the editor.

**X33 is not an editor lane, but TL2 raises its cost.** Once scenes are operator-facing, a selective re-roll that merges old and new scenes becomes a user-visible defect rather than a latent one. X33 should be fenced before TL2 ships, or TL2 should state the exposure in its PR.

---

## 7. Definition of done

The editor is done for a new brief when all of these hold **without opening YAML**:

1. Dialog → Guided Identity → Copy → Products → the default stack is visible in the Template section.
2. Changing a logo margin changes the preview (SE2).
3. A `short-video` create shows the ruler; two beats with two scenes crossfade grounds at the same instant the copy crossfades; the scrubbed frame matches what generation draws (TL1 + TL2).
4. Save, reload at `/brief/:id`: stack, beats, scenes and mode are identical, and the brief is **not dirty**. (*Frames* join this list only once **L10a-templates** ships — an external dependency, named here rather than assumed.)
5. A sample motion brief opens in the same chrome — no create-only component exists.
6. A disabled layer disappears from the preview, and the **editor** offers it no track controls. This is an editor rule only: the domain accepts tracks on a disabled layer and K-D4 has them resolve to nothing, so the editor must not claim a refusal the boundary does not make.
7. After K4/K5: an authored `opacity` stop on an `animated-text` layer round-trips, moves the preview, and the 48 motion goldens still pass when tracks are absent.

Until (3) and (4), this is a form with extra panels. Until (7), it is a timeline of copy, not of motion.

---

## 8. Premises

Each open lane states the gap that makes it necessary as a script that exits 0 **while the gap is still open**. `yarn plan:verify` runs them.

Every fence below probes a **mechanism**, not a name an implementer is free to choose, and excludes test directories the way the keyframing plan's fences do. A fence that can only be flipped by naming something a particular way is not a fence — it is a wish.

```premise SE1
# Only two non-test files mention the html element editor: the component itself and
# the stack row that mounts it inline. An inspector that hosts it is necessarily a
# THIRD, whatever it is called -- and SE0 keeps the guided/everything mount in place,
# so a fence that demanded the tag leave TemplateSection could never flip. Counting
# the mount sites is the mechanism; the names are free.
test "$(grep -rl 'HtmlElementsEditor' apps/web/src/components/campaign | grep -vc '__tests__')" -le 2
```

```premise SE2
# Every prop a drawer reads (C4) can still only be set by hand-authoring YAML. The
# probe is `canonicalLayer`, because SE2 cannot ship without teaching it to drop an
# empty or default-valued `props` block (X16) -- an editor that writes props and does
# NOT extend it would dirty a loaded brief, so this flips for any correct SE2. The
# action union is not probed: its entries are multiline, so a same-line grep would
# hold forever whatever the implementer writes.
! tr '\n' ' ' < apps/web/src/components/campaign/editor-state.ts | grep -qE 'function canonicalLayer.{0,700}props'
```

```premise TL1
# PreviewDock still declares the playhead itself, so no other surface can draw a
# synchronised one. The pattern, not the identifier, is the probe: any `[<x>Sec,
# set<X>Sec] = useState` declaration in this file means the position is still owned
# here. TL1 moves the declaration to the editor, which flips this however the pair
# is renamed.
grep -qE 'const \[[a-zA-Z]*Sec, set[A-Z][a-zA-Z]*Sec\] = useState' apps/web/src/components/campaign/PreviewDock.tsx
```

```premise TL2
# A beat's background can be authored in YAML (VE5a) but not in the editor. The probe
# is the domain gate: no web file imports `scenesProblem` today -- `validate.ts`
# re-counts distinct scenes by hand instead, which is the debt TL2 must not copy. A
# scene chip that enforces the cap correctly must call it, so this flips exactly when
# the lane ships and not before. (A grep for "background" would false-flip on
# `toggleBackground`, the background-SOURCE axis, which is unrelated.)
! grep -rq 'scenesProblem' apps/web/src
```

---

## 9. Lane definitions: the reducer actions and component seams

Stated here so a lane brief can be written from this plan without re-deriving them. Every action below is an
`EditorAction` in `apps/web/src/components/campaign/editor-state.ts` unless it says otherwise; every one must be
reachable from a section component and from nowhere else.

### 9.1 New editor actions

| Lane | Action | Shape | Coalesce key (`editor-history.ts:coalesceKeyOf`) | Canonical-form duty |
|---|---|---|---|---|
| **SE2** | `setLayerProps` | `{ type; layerId: string; patch: Partial<LayerProps> }` | **Required**: `setLayerProps:<layerId>:<sorted patch keys>`, the `setHtmlElementFrame` rule (`editor-history.ts:78-79`). `FrameNumberInput` commits on every finite keystroke (`HtmlElementsEditor.tsx:114-124`), so without a key each digit is its own undo entry. | `canonicalLayer` must drop **`props: {}` and any prop equal to the kind's `CREATIVE_GEOMETRY` default** (`editor-state.ts:1062-1078`). Showing a default in the box and committing it writes a key the loaded snapshot never had — X16's exact failure. |
| **SE3** | `setLayerFrame` | `{ type; layerId: string; patch: Partial<Frame> }` | **Required**, same shape as SE2. | Commit through `clampedFrame`. **A frame equal to the kind default is omitted, not written** — otherwise opening a golden-fixture brief and touching nothing could move a golden. |
| **TL2** | `setBeatBackground` | `{ type; index: number; background?: string }` — `undefined` clears | `null` (a discrete pick, not a typed run) | Absent key, never `background: undefined`. **The gate is `scenesProblem`, called** — today no web component imports it and `validate.ts:215-238` re-counts scenes by hand; TL2 must not copy that debt. |
| **TL3** | `shiftBeatBoundary` | `{ type; boundary: number; delta: number }` — the join between beats `i` and `i+1` | **`null`, like `setBeatWeight`** — because the drag dispatches **once, on release**. Live movement is ephemeral component state (D139), so there is no run to coalesce and no reliance on `lastKey`, which `historyReducer` never clears on pointerup (`editor-history.ts:161-168`). | Integers in `[1, MAX_WEIGHT]`; a transfer that would push either neighbour out of range is a no-op. The floor is `dwellProblem` on a simulated timeline, as `addBeatBlockedBy` does — and per D138 a breach commits and flags. |
| **SE6 / TL5** | `setLayerTracks` | `{ type; layerId: string; tracks?: readonly Track[] }` | `null` for structural edits; a per-stop key shaped like `setHtmlElementFrame` for value typing | `canonicalLayer` must drop **`tracks: []`** — the domain accepts it (`tracks.ts:132-134`) and K4's own proof depends on an absent list. Every refusal comes from `layerTracksProblem`, called. |
| **TL6** | *(none — reuses `setLayerTracks`)* | — | **Required**: a diamond drag needs the same one-dispatch-on-release rule as TL3, or a coalesce key. It cannot inherit TL3's by accident. | — |

**Selection is not in this table on purpose.** Per D139 it is ephemeral React state in the studio chrome, so it takes no
action, no reducer case and no history entry.

### 9.2 Component seams

| Component | Lane | Signature sketch | Notes |
|---|---|---|---|
| `StudioChrome` | SE0 | `{ state, dispatch, railProps }` | Renders the existing section components in a new arrangement. Contains **no** field markup of its own. |
| `LayerInspector` | SE1 | `{ state, dispatch, layerId }` | Tabs by kind; hosts `HtmlElementsEditor` for `html`. Omits an empty tab rather than disabling it. |
| `TimelineRuler` | TL1 | `{ beats, transition, keyBeat, durationSec, scrubSec, onScrub, selectedBeat, onSelectBeat }` | Draws proportions from weights; the **form stays** in `TimelineSection`. |
| `SceneChip` | TL2 | `{ beatIndex, background, onPick, onClear }` | Says "campaign ground" when absent — the fallback the renderer actually applies. |
| `TrackRows` | SE6 | `{ layer, clocks, onChange }` | One row per `TRACK_PROPERTIES` member, read from the domain export (L2). |

### 9.3 The gesture and assistive-technology contract (TL3, TL6, SE5)

Every draggable thing this plan adds — a beat boundary, a keyframe diamond, a frame handle — must satisfy all five of
these, and a lane that ships one without them is incomplete. This repo spent four lanes (X15, X19, X20, X24) making the
editor's messages reachable; a new drag surface must not reopen that.

1. **It is a slider.** The recorded pattern is `packages/ui/src/duration-strip.tsx:93-95,233-240`: `role="slider"`, a
   stable accessible name, `aria-valuenow` / `aria-valuemin` / `aria-valuemax`, and arrow / PageUp / Home / End keys.
2. **The name is stable, not live.** "Beat 2 boundary" or "headline opacity stop 1" — **never** the live seconds or
   fraction, which would make the control announce a different name on every pixel of movement.
3. **`aria-valuenow` is the committed value** — the integer weight, or the stop's `t` — not the in-flight drag position.
4. **The dwell-floor flag must be hearable.** D138 commits and flags rather than preventing, so the flag is X20's
   pattern: `aria-describedby` to the message and `aria-invalid` on the handle that caused it.
5. **The guided walk must not steal the gesture.** `use-step-navigation.ts:159-167` hands a drag to the component only
   when the target matches `[role="slider"], input[type="range"], [draggable="true"]`. A handle outside that set is
   swallowed by the step swipe. TL1 must therefore either keep the native range input as the accessible playhead or give
   the ruler the slider role itself.

### 9.4 Exports the domain owes the editor

Each of these is a rule the UI would otherwise restate — the failure this plan's own kernel rule forbids.

| Needed by | What is private today | Why the editor cannot restate it |
|---|---|---|
| **SE2** | `LAYER_PROPS` (`brief-template.ts:96`) and the prop → `CREATIVE_GEOMETRY` default merge (`NodeCanvasCompositor.ts:80-81`, compositor-private) | §3.2's per-kind field table *is* `LAYER_PROPS` retyped, and an inspector that shows defaults needs the same merge the drawer applies. A second copy of either is a second geometry. |
| **TL5 / TL6** | `beatLocal` and `clockSample` (`resolve-tracks.ts:223-282`) | §4.4's "map the playhead onto the row's clock" is exactly these two functions described in words. Restating them gives the editor a second clock. |
| **SE6** | `TRACKABLE_LAYER_KINDS` (`tracks.ts:91`) | Otherwise the Tracks tab hard-codes the list and drifts from the boundary. |
| **TL4** | the encoder's frame rounding (`CanvasFfmpegVideoCompositor.ts:100,144`) | The caption exists to expose drift; recomputing the rounding in the web app would hide it. |

- **`TRACKABLE_LAYER_KINDS`** is module-private (`tracks.ts:91`). SE6 exports it, as K1a already did for `TEXT_LAYER_KINDS`.
- **The encoded-duration rounding** (`round(durationSec × fps)`, `CanvasFfmpegVideoCompositor.ts:100,144`) must be exported
  or served, so TL4's caption does not recompute it in the web app.

---

## 10. What this plan does not decide

- **The L10 split's ids and the preview-footprint lane's id.** H2 shipped (C1); what this plan needs are **L10a** / **L10b** and a preview-footprint API lane, all of which belong to `2026-09-08_creative-templates-and-units.md`. This plan does not mint ids in another plan's space; SE3 and SE5 stay blocked until that plan records them.
- **Whether the studio chrome replaces the Layout step or sits beside it.** D137 settles that `studio` is a third, operator-chosen presentation; it does not settle what happens to the Layout step inside it. **SE0 must state that in its PR.**
- **Detach** (baking a preset expansion into `layer.tracks`) — named in D140 and deliberately unscoped, because a preset expansion is per-canvas and per-cell, so it may not be expressible as one document write at all.
