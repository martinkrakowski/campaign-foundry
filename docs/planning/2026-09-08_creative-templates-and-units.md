# Creative Templates, Layers and Advertising Units — Architecture & Development Plan

**Date:** 2026-09-08
**Author:** orchestrator
**Status:** draft — for the owner's review. **This is an arc, not a lane; §3 says where it splits.**
**Verified against:** `main` at `65518ac`
**Decision ids introduced:** D119 – D127
**Relates to:** `2026-09-07_campaign-type.md` (the create-time type this plan re-parents),
`2026-09-07_display-advertising.md` (**D118**, which this plan reopens by construction), **D10**
(byte-identical motion), **D26** (the preview shows only what the compositor draws), **D52–D55**
(the compositor is the one layout engine), **D113** (a canvas is a ratio *or* a size)

---

## 0. What this plan answers

The owner asked for three things: define **creative types**, define **creative layers** — where
different creatives carry different sets, and the user may add or remove compatible layers to build
their own templates — and define **advertising units**.

Two of those are vocabulary. The third is not: *"the user builds their own template"* turns the
compositor's fixed five-layer stack into data, and an HTML layer turns a raster pipeline into two
output families. Both are worth doing. Neither is small, and the plan says so before the lanes.

**The owner's decisions, taken 2026-09-08 before drafting:**

- **HTML is its own output family.** The compositor is untouched; an HTML creative assembles markup
  and packages as an HTML unit with a raster rendition as its static fallback. No headless browser.
- **Three levels.** Advertising unit → creative type → layers, with campaign type re-parented as a
  create-time preset over a (unit, creative type) pair.

---

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **D119** | **Three levels, each a union-keyed domain constant.** `ADVERTISING_UNITS` (the placement family: `standard-web` first), `CREATIVE_TYPES` (the composition recipe: `image-text`, `image-html`, `video`), `LAYER_KINDS` (the atoms: `image`, `static-text`, `animated-text`, `html`, `video`, `logo`, `accent`, `shade`). | The repo already models every vocabulary this way — `RATIO_VALUES`, `DISPLAY_SIZES`, `CAMPAIGN_TYPES`, `MOTION_KINDS`, `LAYOUT_VALUES`. A fourth shape would be a second idiom for the same job, and the union key is what makes a fifth member a compile error rather than a runtime surprise. |
| **D120** | **`CAMPAIGN_TYPES` is re-parented, not replaced.** A campaign type stays the create dialog's second field and becomes a preset over `{ unit, creativeType, platforms, formats, mode }`. `display-ad` → `standard-web` + `image-text`; `social-post`/`paid-social`/`short-video` keep their platform sets and gain the unit they always implied. | The type exists because the create dialog needs *one* question, not three (D108). Deleting it would put a taxonomy in front of a user who wants to name a campaign and start. Re-parenting keeps the dialog and makes the levels beneath it addressable. |
| **D121** | **The layer stack becomes data, and there is exactly one source of it.** A creative type declares an ordered layer list; the compositor draws that list; the kit's preview reads the same list; `CREATIVE_GEOMETRY` keeps the per-layer fractions. Today's five-layer stack becomes the canonical `image-text` template. | The order lives in three places now (compositor draw order, `preview-layers.ts` `LAYERS`, the geometry leaf) and they agree only because a human kept them in step. The moment a user reorders anything, "the preview shows what the compositor draws" (D26) is a promise no one can keep by hand. |
| **D122** | **HTML is `format: "html"`, a third member beside `static` and `motion`.** An HTML creative assembles markup server-side, packages as an HTML unit, and **always carries a raster rendition** produced by the existing pipeline as its static fallback. Markup is never rasterised. | The alternative — a headless browser — buys one output family at the price of a heavy dependency and cross-platform pixel determinism, and this repo has just spent a lane proving that fonts rasterise differently on macOS and Linux. A fallback rendition is what every ad server wants anyway. |
| **D123** | **A template is a brief-level object first, a library second.** `brief.template` carries the ordered layers and their props; a named, reusable library of templates waits on the cloud-migration identity decision. | Templates that live on the brief need no new storage, no ownership model and no sharing semantics, and they make the feature real in one wave. A library is a product surface with an identity question attached, and that question is explicitly open. |
| **D124** | **Compatibility is a declared table, validated at the boundary.** Each creative type declares which layer kinds it accepts, how many of each, and which are required; `validateTemplate` refuses anything else on `briefs`, `generate` and `plan`, in authoring mode too. | "Compatible layers" is the whole of the user-facing promise; a rule that lives only in the editor is a rule the API does not have. Every other vocabulary in this repo is refused at the same boundary (`validateType`, `validateSizes`). |
| **D125** | **Pixel goldens pin the canonical templates only.** The three canonical types keep byte-identical goldens on both platforms; a user-assembled template is verified **structurally** — layer order, geometry, and that every declared layer drew — never by a recorded hash. | A composable stack is combinatorial; goldens over it would be a fixture farm nobody re-records honestly. The goldens exist to catch silent drift in the layout engine, and the canonical templates exercise every drawing path the engine has. |
| **D126** | **`Treatment` becomes a preset over the copy layer, kept until the template model ships.** `(layout, tone)` is a two-axis mini-template; once layers carry their own props it is `{ copy: { anchor, weight } }` by another name. The VO stays, the variation axis stays, and a later lane deprecates it deliberately. | Removing it in the same wave that introduces templates would rewrite the variation planner's axis model and the goldens' cell names at once. Two changes, two lanes. |
| **D127** | **`animated-text` is one layer kind, not three mechanisms.** Text already animates three ways — `CopyTimeline` beats, `MOTION_KINDS`, and the text-effect poses. The layer kind names the capability; its props select which mechanism drives it. Nothing new is animated in this plan. | The owner's list names "animated text" as an atom. The repo has the capability under three older names; adding a fourth without folding them in would be the third vocabulary for one behaviour. |

---

## 1. Findings

#### **F1 · C · The layer stack is hard-coded in three places that agree only by hand**

The compositor draws background, contrast shade, accent band and fade, the copy block, then the
logo — the order is the shape of `drawLegacy` and `drawTimeline`, not a value. The kit mirrors it in
`preview-layers.ts` as `LAYERS` ("Layer 2 — tone → shade alpha", "Layer 3 — the solid accent band",
"Layer 4 — the message bars"), and the fractions live a third time in `CREATIVE_GEOMETRY`. Nothing
enforces that the three agree. D26 says the preview shows only what the compositor draws; today
that holds because two humans kept two lists in step. **A composable stack makes that promise
unkeepable until the list is one value read by both.**

#### **F2 · C · The verification estate cannot follow a composable stack**

Correctness here is byte-identical PNG goldens: twelve base cells on each of two platforms, the
inset cell, and now twenty display cells. That estate is why D114's scaling change could be proven
safe. A user-assembled template multiplies renders combinatorially, and a golden per combination is
a fixture farm that will be re-recorded to green rather than read. **The plan needs two tiers**
(D125): canonical templates keep pixels; user templates are proven structurally.

#### **F3 · H · There is no template concept anywhere**

No entity, no persistence, no UI, no validation. `git grep Template` in `packages/*/src` and
`apps/*/src` returns nothing outside tests. "The user builds a template" is a new object with a
lifecycle, and the honest first version is the smallest one that is still real (D123).

#### **F4 · H · `format` is a two-member union threaded through six surfaces**

The literal union `"static" | "motion"` lives in six files outside tests — `campaign-types.ts`,
`GeneratedAsset.ts`, `PackageForPlatformUseCase`, `PackageStorePort`, `PlatformProfile.vo.ts` and
the grid page — and the API validates against a *capability-gated* list beside it
(`SUPPORTED_FORMATS = ["static"]`, with motion admitted only when the host reports it). Adding
`"html"` is the exact shape of lane A4b: a small union widened across every consumer the compiler
can find, plus one gate to decide (is HTML a capability, or always available?). Budget it as its
own lane, not as a corner of the template lane.

#### **F5 · M · Treatments are already a two-axis template**

`Treatment` is `{ id, layout, tone }` over `LAYOUT_VALUES` and `TONE_VALUES`, and the variation
planner treats treatment as an axis with a coverage floor. A template model subsumes it. Doing both
at once rewrites the planner's axis arithmetic in the same wave that introduces layers (D126).

#### **F6 · M · The brief has no per-layer configuration**

`style` is global type configuration; motion is a per-run axis; the copy block's anchor comes from
the treatment. Layers with their own props need a nested structure that the YAML key order, the
dumper, the validator and the editor all carry — the `output.sizes` lesson, one level deeper.

#### **F7 · M · "Standard web ads" is the unit the display plan already built**

`PLATFORM_PROFILES` gained `google-display`, `meta-audience-network` and `display-web`, each
carrying `sizes` with per-size insets, and the run path renders and packages them. **The first
advertising unit is not new work** — it is a name for what shipped in #248–#252, which is why the
first lane is vocabulary rather than capability.

---

## 2. The recommendation

### 2.1 The three levels, concretely

```
advertising unit   standard-web            (then: social, native, dooh…)
  creative type    image-text | image-html | video
    layers         [ image, shade, accent, static-text | animated-text | html, logo, video ]
```

An **advertising unit** owns *where a creative runs*: its placements, its canvases (`sizes` or
`ratio`), its safe insets, its packaging rules. That is exactly what a `PlatformProfile` carries
today, so the unit is a grouping over profiles, not a new mechanism.

A **creative type** owns *what a creative is made of*: an ordered, validated layer list with a
declared compatibility rule. The three the owner named map cleanly:

| creative type | layers | output family |
|---|---|---|
| `image-text` | image, shade, accent, static-text \| animated-text, logo | `static`, or `motion` when a layer animates |
| `image-html` | image, html, logo | `html` + a raster fallback (D122) |
| `video` | video, shade, animated-text, logo | `motion` |

A **layer kind** owns *one drawing responsibility* and its own props. Today's stack is the canonical
`image-text` template with `static-text`; that equivalence is the acceptance test of the second lane.

### 2.2 What "the same output" must mean

The second lane turns the stack into data **without moving a pixel**: the canonical templates must
reproduce today's renders byte-identically on both platforms, goldens unedited. This is the A2
discipline and it is not negotiable — if the stack-as-data cannot reproduce the stack-as-code, the
change is a redesign wearing a refactor's clothes, and the lane stops and reports.

### 2.3 HTML, without a browser

An `html` layer carries markup and its assets. The server assembles the unit (markup, inlined or
referenced assets, a manifest entry) and packages it; **every HTML creative also renders its raster
fallback through the existing pipeline**, so an ad server that wants an image always has one.
Verification is structural: the bundle parses, references resolve, the declared layers are present,
the fallback exists and matches its own golden. No pixel hash is recorded for markup.

### 2.4 Where the user's choice lives

The create dialog does not grow a third field. Campaign type stays one question and resolves to a
unit and a creative type through its preset (D120). Template editing lives in the editor, where the
brief already is: a layer list with add and remove restricted to the compatibility table, each layer
opening its own props, previewed through the real compositor (D26).

---

## 3. Lanes

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **L1** | **The vocabulary** (D119, D120). `advertising-units.ts`, `creative-types.ts`, `layer-kinds.ts` as union-keyed constants with their presets and the compatibility table (D124, data only); `CAMPAIGN_TYPE_PRESETS` gains `unit` and `creativeType`; `brief.template?` typed but not yet read by the compositor; `validateTemplate` at the boundary; every `briefs/sample-*` parses unedited. **Nothing renders differently.** | `CampaignOrchestration/.../value-objects/*`, `CampaignBrief.ts`, `load-brief.ts`, `brief-yaml.ts`, their tests | The nouns, refusable at the API |
| **L2** | **The stack becomes data** (D121, D125). The compositor draws a layer list resolved from the creative type; `preview-layers.ts` and `CREATIVE_GEOMETRY` read the same source; the canonical templates reproduce today's output **byte-identically on both platforms, goldens unedited**; a structural test asserts declared order equals drawn order. | `NodeCanvasCompositor.ts`, `preview-layers.ts`, `creative-geometry.ts`, goldens (unchanged), tests | One source of the stack |
| **L3** | **Per-layer props on the brief** (F6). The nested `template` block: ordered layers, each with its own props; YAML round-trip and key order; validation per layer kind; draft normalisation for briefs saved before it. | `CampaignBrief.ts`, `brief-yaml.ts`, `load-brief.ts`, `editor-state.ts`, tests | A template a brief can carry |
| **L4** | **Compatibility, enforced** (D124). The table becomes rules: which kinds a creative type accepts, cardinality, required layers, legal positions. Refused at the boundary in both modes; the editor derives *which layers can be added or removed right now* from the same table. | `creative-types.ts`, `load-brief.ts`, `derive.ts`, tests | The promise, kept on both sides |
| **L5** | **The template editor** (the owner's "add or remove layers"). A layer list in the editor: add from the compatible set, remove what is not required, reorder within the rules, each layer's props inline, previewed through the real compositor. | `campaign/sections/*`, `packages/ui` (a layer-list control), `messages.ts`, tests | The feature the owner asked for |
| **L6** | **HTML as an output family** (D122, F4). `format` gains `"html"`; the markup assembler; packaging an HTML unit; the raster fallback beside it; structural verification. Follows the A4b shape — widen the union, let the compiler enumerate the consumers. | `CompositorPort`/format union, `PackageForPlatformUseCase`, the run path, export page, tests | `image-html`, and D118's first half |
| **L7** | **The template library** (D123's second half). Named, reusable templates with an owner. **Gated on the cloud-migration identity decision** — do not dispatch before it. | new storage surface, API routes, editor | Reuse across campaigns |

**Waves.** **L1** → **L2** → **L3** → **L4 ‖ L6** → **L5**. L7 is gated, not scheduled.

**Where this splits into two plans.** L1–L4 are the model: vocabulary, one stack, per-layer props,
enforced compatibility. They stand on their own and change nothing a user sees. L5–L7 are the
product surface. If the arc runs long, split after L4 and re-plan the surface with the model in hand
— the second half is where the design questions live, and they are easier to answer against a model
that exists.

---

## 4. Definition of Done

Standing gate per lane (100 % ×4); one mutation per behavioural claim, its diff shown before it runs,
confirmed to compile, run and fail the test it names.

- **L1**: every sample brief parses unedited; an unknown unit / creative type / layer kind is a 400
  on `briefs`, `generate` and `plan`, in authoring mode too; nothing under `CreativeGeneration`
  changes (`git diff --stat` empty).
- **L2**: **the golden fixtures are untouched** and every social and display cell passes on both
  platforms; declared layer order equals drawn order, asserted structurally; the preview and the
  compositor read one list (a test greps for a second).
- **L3**: a template round-trips through YAML and the editor verbatim — the `output.sizes` lesson:
  a subset the user chose comes back the subset they chose; a pre-template draft normalises.
- **L4**: an incompatible layer set is refused at the API **and** unreachable in the editor, both
  from the same table; a required layer cannot be removed; cardinality holds.
- **L5**: adding and removing a layer changes the rendered preview through the real compositor, not
  a mock; the accessible name of every control is its raw id with display words in `description`
  (the kit contract); jargon gate green.
- **L6**: an `image-html` creative packages markup **and** a raster fallback; the bundle's references
  resolve; a display profile that receives an HTML unit packages it; no pixel hash for markup.
- **L7**: not scheduled.

---

## 5. Deferred

| What | Waits on |
|---|---|
| Video display units (VAST, out-stream) | an ad-server integration that does not exist; D118's second half stands |
| Responsive / fluid units | a layout engine change, not a template change |
| Template library, sharing, versioning | the cloud-migration identity decision (L7) |
| Deprecating `Treatment` in favour of copy-layer props | D126 — its own lane, after L3 |
| Third-party template import (AMPHTML, Google Web Designer) | a format contract nobody has asked for yet |

---

## 6. Open questions

1. **Does a template belong to a brief or to a campaign type?** D123 puts it on the brief. If a
   campaign type should *ship* with a template the user then edits, the preset grows a template
   reference and L1 changes shape.
2. **May a user reorder layers, or only add and remove?** The compatibility table can express legal
   positions either way; reordering multiplies what L5's preview must show.
3. **Does `animated-text` on a `static`-format creative mean anything?** Today motion implies an MP4.
   A GIF-less animated banner is an HTML unit (L6), not a motion one — worth stating in D127's lane.
4. **The variation planner and templates.** Treatment is an axis with a coverage floor; is a template
   an axis too, or fixed per run? This is the same question the display plan left open for sizes.

---

## 7. What this plan does not pretend

- **It is not a quick win.** L1–L4 is a model change under a test estate built on a fixed stack.
- **It does not make the compositor a general layout engine.** Layers are a declared, validated
  vocabulary — not arbitrary user markup rendered to pixels. D52 stands.
- **It does not deliver rich media.** `image-html` ships a packaged HTML unit with a raster fallback;
  animated HTML units, VAST and interactive formats remain out (D118's second half).
- **It does not decide the library.** L7 is written down so it is not forgotten, and gated so it is
  not started on the wrong side of an open identity decision.

---

## 8. Carried forward — the four approved remediations

Approved by the owner 2026-09-08, independent of the taxonomy above.

| Lane | Task |
|---|---|
| **H1** | `/tokens.css` served by the wave-status server; the page links it instead of redeclaring twelve custom properties (they match the app's dark tokens exactly today — this prevents drift, it does not fix drift). The route set is asserted as exactly four GETs, so this is a deliberate contract change. |
| **H2** | World-map hit-testing by the smallest containing footprint, independent of paint order, with the #215 sequence test: select the world, click a country, click it again, assert the selection did not move. |
| **H3** | The variation planner's estimate route — **needs open question 4 answered first**; today display is classic and static, so the route never sees a display brief and nothing is broken. |
| **H4** | Rich media: **partly superseded.** L6 delivers packaged HTML units; animated HTML and VAST stay deferred under D118's second half. |
