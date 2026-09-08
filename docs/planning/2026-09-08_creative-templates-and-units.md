# Creative Templates, Layers and Advertising Units — Architecture & Development Plan

**Date:** 2026-09-08
**Author:** orchestrator
**Status:** revised 2026-09-08 after the owner's second-round answers (§0.1). **This is an arc, not a lane; §3 says where it splits.**
**Verified against:** `main` at `65518ac`
**Decision ids introduced:** D119 – D133
**Relates to:** `2026-09-07_campaign-type.md` (the create-time type this plan re-parents),
`2026-09-07_display-advertising.md` (**D118**, which this plan reopens by construction), **D10**
(byte-identical motion), **D26** (the preview shows only what the compositor draws), **D52–D55**
(the compositor is the one layout engine), **D113** (a canvas is a ratio *or* a size), **D64** (the
identity model — still open; §2.6 says what this plan does and does not need from it)

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

### 0.1 The owner's second-round answers, 2026-09-08 — and what each one changed

| # | The owner said | What it changed |
|---|---|---|
| 0 | Cloud migration: research whether the brief file should keep carrying configuration this complex. | **§2.6** — the recommendation, labelled design intent. Short form: the *document* stays, the *store* changes, and the document gets a version number before anything else. |
| 1 | A library of templates users choose from; templates exist without an owner. | **D123 reversed**: library-first, ownerless, versioned. **L7 ungated** — ownerless entities need nothing from D64. |
| 2 | Every campaign has a template. | **D120 amended**: each campaign-type preset names a default template; the brief's `template` is required, **defaulted at load** so existing briefs parse unedited. |
| 3 | Keep treatment as is. | **D126 confirmed** as written. Treatment stays a run-time axis over the copy layer. |
| 4 | Layers reorder; later toggle on/off, per-layer positioning, and a generative layer that fills the canvas or a custom shape. | **D128–D132**: the layer record grows `enabled`, `frame`, `region`; a `fill` kind; **L8–L11** as a roadmap; **H2 promoted** to a prerequisite. The split point in §3 moves. |

**What the first draft got wrong**, so the correction is on record: it put templates on the brief and
gated the library on ownership, which inverted the owner's product — the library *is* the product,
and an ownerless template asks nothing of the identity decision. It called hit-testing housekeeping
when positional editing makes it a prerequisite. It listed reorder as an open question when it is
the first rung of a Photoshop-style ladder. And it added a second level of nesting to a document
that has no schema version.

---

## 0.2 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **D119** | **Three levels, each a union-keyed domain constant.** `ADVERTISING_UNITS` (the placement family: `standard-web` first), `CREATIVE_TYPES` (the composition recipe: `image-text`, `image-html`, `video`), `LAYER_KINDS` (the atoms: `image`, `static-text`, `animated-text`, `html`, `video`, `logo`, `accent`, `shade`). | The repo already models every vocabulary this way — `RATIO_VALUES`, `DISPLAY_SIZES`, `CAMPAIGN_TYPES`, `MOTION_KINDS`, `LAYOUT_VALUES`. A fourth shape would be a second idiom for the same job, and the union key is what makes a fifth member a compile error rather than a runtime surprise. |
| **D120** | **`CAMPAIGN_TYPES` is re-parented, not replaced, and every type names a default template.** A campaign type stays the create dialog's second field and becomes a preset over `{ unit, creativeType, template, platforms, formats, mode }`. `display-ad` → `standard-web` + `image-text` + the canonical `image-text` template; the three social types keep their platform sets and gain the unit they always implied. **Every campaign has a template** (owner, item 2): `brief.template` is required in the domain and **defaulted at load** from the type's preset, so a brief written before this plan parses unedited and is normalised once. A brief with **no `type`** resolves through D112 to `social-post` first, then to that type's default template — type before template, one rule each. | The type exists because the create dialog needs *one* question, not three (D108). Re-parenting keeps the dialog and makes the levels beneath it addressable. Defaulting at load rather than refusing is the `mode`/`type` precedent: the validator convention here is to refuse the *wrong* value, not the *absent* one that has a sensible default. |
| **D121** | **The layer stack becomes data, and there is exactly one source of it.** A creative type declares an ordered layer list; the compositor draws that list; the kit's preview reads the same list; `CREATIVE_GEOMETRY` keeps the per-layer fractions. Today's five-layer stack becomes the canonical `image-text` template. | The order lives in three places now (compositor draw order, `preview-layers.ts` `LAYERS`, the geometry leaf) and they agree only because a human kept them in step. The moment a user reorders anything, "the preview shows what the compositor draws" (D26) is a promise no one can keep by hand. |
| **D122** | **HTML is `format: "html"`, a third member beside `static` and `motion`.** An HTML creative assembles markup server-side, packages as an HTML unit, and **always carries a raster rendition** produced by the existing pipeline as its static fallback. Markup is never rasterised. | The alternative — a headless browser — buys one output family at the price of a heavy dependency and cross-platform pixel determinism, and this repo has just spent a lane proving that fonts rasterise differently on macOS and Linux. A fallback rendition is what every ad server wants anyway. |
| **D123** | **Templates are library entities: ownerless, versioned, immutable per version.** A template is `{ id, version, name, unit, creativeType, layers, thumbnail }`; a new version is a new record, an old version is never edited, and a campaign **pins** `template@version`. The brief carries the pinned reference as provenance **and the materialised layer list**, so a campaign renders and exports with no library present, and editing a layer detaches the campaign from the library the way every design tool's "detach from component" does. Ownership is a nullable field the library does not use. | Reversed from the first draft on the owner's item 1. Immutable versions are what make a library safe to curate: a running campaign never changes because someone improved the template it started from. Materialising the layers costs brief size (§2.6) and buys reproducibility — a run is a function of one document and a seed, and that stays true. |
| **D124** | **Compatibility is a declared table, validated at the boundary.** Each creative type declares which layer kinds it accepts, how many of each, and which are required; `validateTemplate` refuses anything else on `briefs`, `generate` and `plan`, in authoring mode too. | "Compatible layers" is the whole of the user-facing promise; a rule that lives only in the editor is a rule the API does not have. Every other vocabulary in this repo is refused at the same boundary (`validateType`, `validateSizes`). |
| **D125** | **Pixel goldens pin the canonical templates only.** The three canonical types keep byte-identical goldens on both platforms; a user-assembled template is verified **structurally** — layer order, geometry, and that every declared layer drew — never by a recorded hash. | A composable stack is combinatorial; goldens over it would be a fixture farm nobody re-records honestly. The goldens exist to catch silent drift in the layout engine, and the canonical templates exercise every drawing path the engine has. |
| **D126** | **`Treatment` becomes a preset over the copy layer, kept until the template model ships.** `(layout, tone)` is a two-axis mini-template; once layers carry their own props it is `{ copy: { anchor, weight } }` by another name. The VO stays, the variation axis stays, and a later lane deprecates it deliberately. | Removing it in the same wave that introduces templates would rewrite the variation planner's axis model and the goldens' cell names at once. Two changes, two lanes. |
| **D127** | **`animated-text` is one layer kind, not three mechanisms.** Text already animates three ways — `CopyTimeline` beats, `MOTION_KINDS`, and the text-effect poses. The layer kind names the capability; its props select which mechanism drives it. Nothing new is animated in this plan. | The owner's list names "animated text" as an atom. The repo has the capability under three older names; adding a fourth without folding them in would be the third vocabulary for one behaviour. |
| **D128** | **Array position is z-order.** A template's `layers` array is the draw order, bottom first; there is no separate `order` field. Reordering is a move in the array. Ordering *rules* ("logo above image", "shade directly above image") live in the compatibility table as `above`/`below` constraints on kinds. | One source (D121) or none. A second `order` field is the three-lists problem of F1 brought back inside one record. |
| **D129** | **A layer can be disabled, unless it is required.** `enabled?: boolean` (default true) hides a layer without removing it. A layer the creative type marks **required** cannot be disabled *or* removed — the two are one rule in D124's table. | The owner's Photoshop analogy (item 4). "Required" has to mean something a brand can rely on: a logo the template requires is a logo that ships, not a logo that was merely present. |
| **D130** | **A frame is canvas-relative, and overridable per canvas family.** `frame?: { x, y, w, h, anchor }` in fractions of the resolved canvas, with `byFamily?: { ratio?, size? }` partial overrides. Absent, the kind's default frame applies — and **the canonical templates' default frames are `CREATIVE_GEOMETRY`'s fractions verbatim**, which is the mechanism that keeps goldens unedited in L2. | Every campaign renders across ratios *and* sizes (D113). "Bottom half" is a statement at 1:1 that means nothing at 728×90. The display plan already took this exact shape for insets (per-size, split by family under D114); frames follow the precedent rather than invent one. |
| **D131** | **`fill` is a layer kind, and it names a brand role, not a colour.** `fill: { role: "primary" \| "accent" \| "surface" \| … }` resolves through the brand palette at render. The owner's example — bottom half a solid colour under white text, top half an image — is `[image{frame: top½}, fill{frame: bottom½, role: primary}, static-text{frame: bottom½}, logo]`. | A template that hard-codes `#1a2b3c` is a template for one brand. A role makes the library reusable across brands, which is the library's reason to exist (D123). |
| **D132** | **A generative layer takes a `region`, and the region drives generation as well as clipping.** `region?: { shape: "rect" \| "path", …in canvas fractions }` on `image` and `video` layers when their source is generative. The compositor clips to it; the generation request derives its aspect from the region's bounding box, not the canvas. Absent, the region is the full canvas — today's behaviour. | Filling a 1:2 region with a 1:1 generation and clipping wastes two thirds of the pixels and the subject with them. The region is one fact used twice, and it is a value on the layer, so it verifies structurally (D125). |
| **D133** | **The brief gets a `schemaVersion` before it gets a `template`.** An integer, required at the boundary, defaulted at load for documents that predate it, with one normaliser per step. | The document is unversioned today and about to double in nesting. Every migration this plan implies — into a database or an object store — needs to know what shape it is reading. This is the cheapest decision in the table and the one that hurts most if taken late. |

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
unit, a creative type **and a default template** through its preset (D120). Choosing from the
library happens in the editor, where the brief already is: pick a template, and its layers are
materialised onto the brief (D123). From there the layer list is the editing surface — add and
remove within the compatibility table, reorder (D128), disable what is not required (D129), and
later position (D130) and shape the generative fill (D132) — every change previewed through the
real compositor (D26).

### 2.5 The layer, as a record

Design intent, not code. The fields arrive over four lanes (L2, L8, L9, L10–L11), but the shape is
fixed now so no lane invents a rival:

```ts
interface Layer {
  id: string;                 // stable within the template; the editor's handle
  kind: LayerKind;            // image | fill | static-text | animated-text | html | video | logo | accent | shade
  enabled?: boolean;          // D129 — default true; refused false on a required kind
  frame?: Frame;              // D130 — absent = the kind's default frame
  region?: Region;            // D132 — generative image/video only; absent = full canvas
  props: LayerPropsFor<kind>; // per-kind, validated per kind
}
// z-order is the array position (D128). There is no `order` field.
interface Frame { x: number; y: number; w: number; h: number; anchor: Anchor;
                  byFamily?: { ratio?: Partial<Frame>; size?: Partial<Frame> } }
interface Region { shape: "rect" | "path"; rect?: Frame; path?: string /* normalised, canvas fractions */ }
```

### 2.6 Item 0 — should the brief still carry all of this?

The owner asked for research and a recommendation. **Recommendation: keep the brief as the one
declarative document; stop inlining what it should reference; version it; and change the store,
not the format.** Design intent throughout — none of this is code.

**What the brief is today.** Ten top-level keys behind `BriefStorePort` — list, find, read, create,
rewrite, replace, with an optimistic `revision` — implemented once, by the filesystem store, as
`briefs/<id>.yaml`. That port is the migration seam the earlier plans built for exactly this
moment. The document has **no schema version**.

**Why the document should stay.** A run is a function of one document and a seed; that is what
makes goldens, replays and "regenerate only this size" possible. A document diffs in review, exports
and imports through one validator, and drives the CLI without a server. Decomposing layers into
relational rows would keep the data and lose all three properties. Every serious system in this
space keeps a document at the centre and puts the store around it.

**What must change in the document.**

1. **`schemaVersion`** (D133), first, before `template` lands.
2. **Templates by reference *and* materialised** (D123): `template: { id, version, layers: [...] }`.
   The reference is provenance; the layers are what renders. This roughly doubles a brief — from
   ~70 lines to ~140 — and that is the honest cost of reproducibility. It is still one screen.
3. **Assets by URI, never inline.** An `html` layer's markup, an uploaded image, a generated
   rendition: referenced by a storage key, resolved by a port. The brief names things; it does not
   contain them.

**What changes in the store, and what it needs from D64.** With the document versioned and
self-describing, the store is one adapter either way: a JSONB column with a handful of promoted
query fields (id, name, type, template id and version, updatedAt) under fork (b), or an object key
under fork (a). **This plan does not take a side on D64.** It notes one thing the owner should
weigh: the template library is a second versioned, ownerless entity behind a second port
(`TemplateStorePort`, mirroring `BriefStorePort`), and whatever answers D64 for briefs answers it
for templates. There is no third question.

**What not to do.** No synchronisation between a file tree and a store. One canonical store;
YAML and JSON are import and export formats passing through the same validator. A file that is
also a record is two sources of truth with a race between them.

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
| **L7** | **The template library** (D123). `TemplateStorePort` mirroring `BriefStorePort`, a filesystem adapter over versioned files, `GET /templates` and `GET /templates/:id@:version`, the three canonical templates as its seed, thumbnails rendered by the real compositor. Ownerless, so **independent of D64**. | new port + adapter, routes, `campaign/library/*`, tests | The product the owner described |
| **L8** | **Reorder** (D128). Move within the array; `above`/`below` constraints in the compatibility table; the preview follows. | `creative-types.ts`, `derive.ts`, the layer-list control, tests | Rung one of the ladder |
| **L9** | **Toggle** (D129). `enabled`; required kinds refuse it at the boundary and in the editor from one table. | `CampaignBrief.ts`, `load-brief.ts`, `derive.ts`, the control, tests | Rung two |
| **L10** | **Frame** (D130). Canvas-relative frames with per-family overrides; canonical defaults are `CREATIVE_GEOMETRY` verbatim; **goldens unedited**. Preview selection by clicking the layer — **H2 is a prerequisite**. | `NodeCanvasCompositor.ts`, `creative-geometry.ts`, `preview-layers.ts`, `CampaignBrief.ts`, tests | Rung three |
| **L11** | **Fill and generative region** (D131, D132). The `fill` kind resolving brand roles; `region` clipping in the compositor and shaping the generation request's aspect. | compositor, the image-generation port and adapters, `CampaignBrief.ts`, tests | The owner's example, rendered |
| **L12** | **`schemaVersion`** (D133). The field, the load-time default, one normaliser, the dumper's key order. **Runs first.** | `CampaignBrief.ts`, `brief-yaml.ts`, `load-brief.ts`, `editor-state.ts`, tests | A document that knows its shape |

**Waves.** **L12** → **L1** → **L2** → **L3** → **L4 ‖ L7** → **L6** → **L5** → **L8** → **L9** →
**H2** → **L10** → **L11**.

**Why so little runs in parallel.** The first revision paired lanes that own the same file, which
the orchestration skill names as a plan defect: L6 must widen `SUPPORTED_FORMATS` in
`load-brief.ts`, which L4 owns; L8 edits the layer-list control L5 creates; L7 seeds templates
typed against the `Layer` record L3 defines; L6's format panel lives in the sections L5 owns.
Each pair is now sequential. The one pair that is genuinely disjoint — L4 (vocabulary, validator,
derive) beside L7 (a new port, adapter, routes and library page) — stays parallel.

**Where this splits into two plans.** The first draft said "after L4"; that was wrong once frames
and regions turned out to be model changes, not surface ones. The honest split is **after L9**:
everything to that point is a *fixed-geometry* template model — vocabulary, one stack, per-layer
props, a library, compatibility, HTML, reorder, toggle. L10 and L11 make geometry a value, and that
is a second arc with its own design questions (per-family overrides in the editor, region drawing,
what the generation port does with a non-canvas aspect). Re-plan it with L1–L9 in hand.

---

## 4. Definition of Done

Standing gate per lane (100 % ×4); one mutation per behavioural claim, its diff shown before it runs,
confirmed to compile, run and fail the test it names.

- **L12**: every sample brief parses unedited and dumps with `schemaVersion` first; a document with
  a future version is refused, one with none is defaulted — both asserted.
- **L1**: every sample brief parses unedited **and comes back with the type's default template
  materialised** (D120) — a typeless brief with `social-post`'s, per D112; an unknown unit / creative type / layer kind is a 400 on `briefs`,
  `generate` and `plan`, in authoring mode too; nothing under `CreativeGeneration` changes
  (`git diff --stat` empty).
- **L2**: **the golden fixtures are untouched** and every social and display cell passes on both
  platforms; declared layer order equals drawn order, asserted structurally; the preview and the
  compositor read one list (a test greps for a second); **the canonical templates' default frames
  are `CREATIVE_GEOMETRY`'s fractions, asserted equal** — that equality is why the goldens hold.
- **L3**: a template round-trips through YAML and the editor verbatim — the `output.sizes` lesson:
  a subset the user chose comes back the subset they chose; a pre-template draft normalises.
- **L4**: an incompatible layer set is refused at the API **and** unreachable in the editor, both
  from the same table; a required layer cannot be removed; cardinality holds.
- **L5**: adding and removing a layer changes the rendered preview through the real compositor, not
  a mock; the accessible name of every control is its raw id with display words in `description`
  (the kit contract); jargon gate green.
- **L6**: an `image-html` creative packages markup **and** a raster fallback; the bundle's references
  resolve; a display profile that receives an HTML unit packages it; no pixel hash for markup.
- **L7**: a template version, once listed, never changes (a test rewrites and asserts a 409 or a new
  version, never a mutation); a brief with a pinned version renders with the library store absent;
  a thumbnail is the compositor's output for the template's own canonical brief, not a stored PNG.
- **L8**: a move that violates an `above`/`below` constraint is refused at the boundary and not
  offered in the editor; the preview after a legal move draws in the new order (structural).
- **L9**: disabling a required layer is a 400 and a disabled control; a disabled optional layer is
  absent from the draw list and present in the document.
- **L10**: **goldens unedited** with frames present and defaulted; a frame override under
  `byFamily.size` applies at 300×250 and not at 1:1, asserted on both; clicking a layer in the
  preview selects it by smallest containing footprint (H2's test, reused).
- **L11**: a `fill` layer resolves a brand role, never a literal; a generative `region` of 1:2 on a
  1:1 canvas requests a 1:2 generation (asserted at the port, with a fake adapter) and clips to the
  region in the compositor (structural + one canonical golden).

---

## 5. Deferred

| What | Waits on |
|---|---|
| Video display units (VAST, out-stream) | an ad-server integration that does not exist; D118's second half stands |
| Responsive / fluid units | a layout engine change, not a template change |
| Template *sharing* between organisations, and template ownership | an identity model (D64); versioning and the library itself are **not** deferred (L7) |
| Free-form vector editing, arbitrary shapes beyond `rect`/`path` regions, per-layer blend modes | a deliberate line — §9 "what not to build" |
| Deprecating `Treatment` in favour of copy-layer props | D126 — its own lane, after L3 |
| Third-party template import (AMPHTML, Google Web Designer) | a format contract nobody has asked for yet |

---

## 6. Open questions

1. ~~**Does a template belong to a brief or to a campaign type?**~~ **Answered (owner, item 2):**
   every campaign has one; the type's preset names the default; the library holds them (D120, D123).
2. ~~**May a user reorder layers?**~~ **Answered (owner, item 4):** yes, and then toggle, position
   and shape (D128–D132, L8–L11).
3. **Does `animated-text` on a `static`-format creative mean anything?** Today motion implies an MP4.
   A GIF-less animated banner is an HTML unit (L6), not a motion one — worth stating in D127's lane.
4. **The variation planner and templates.** Treatment is an axis with a coverage floor; is a template
   an axis too, or fixed per run? **The plan's working assumption, not the owner's decision:** with
   treatment kept as is (item 3), a template is **fixed per run** and treatment remains the only
   layout axis. Stated so a lane does not decide it by accident.

---

## 7. What this plan does not pretend

- **It is not a quick win.** L1–L4 is a model change under a test estate built on a fixed stack.
- **It does not make the compositor a general layout engine.** Layers are a declared, validated
  vocabulary — not arbitrary user markup rendered to pixels. D52 stands.
- **It does not deliver rich media.** `image-html` ships a packaged HTML unit with a raster fallback;
  animated HTML units, VAST and interactive formats remain out (D118's second half).
- **It does not decide D64.** The library needs nothing from it (ownerless, versioned files behind
  a port); sharing and ownership do, and they wait.
- **It does not make geometry a value in the first arc.** L10–L11 are specified so no earlier lane
  forecloses them, and split off so the first arc ships with a fixed stack that a user can compose.

---

## 8. Carried forward — the four approved remediations

Approved by the owner 2026-09-08, independent of the taxonomy above.

| Lane | Task |
|---|---|
| **H1** | `/tokens.css` served by the wave-status server; the page links it instead of redeclaring twelve custom properties (they match the app's dark tokens exactly today — this prevents drift, it does not fix drift). The route set is asserted as exactly four GETs, so this is a deliberate contract change. |
| **H2** | World-map hit-testing by the smallest containing footprint, independent of paint order, with the #215 sequence test: select the world, click a country, click it again, assert the selection did not move. **Promoted: a prerequisite for L10** — selecting a layer by clicking the preview is the same problem, and the kit should solve it once. |
| **H3** | The variation planner's estimate route — proceeds under §6 Q4's stated assumption (template fixed per run); today display is classic and static, so the route never sees a display brief and nothing is broken. |
| **H4** | Rich media: **partly superseded.** L6 delivers packaged HTML units; animated HTML and VAST stay deferred under D118's second half. |

---

## 9. Guidance for the direction — features and practices worth adopting

The owner asked for guidance on the product and marketing direction, not only a plan. This section
is opinion grounded in the code and in how ad production systems are built; numbers from external
specifications are marked **verify** because they change and cannot be checked from here.

**The product this taxonomy describes.** A template library × a unit catalogue × generative fill ×
spec compliance. That is a creative *production* system, not a brief renderer and not a design tool.
The moat is that one document renders correctly to every unit a campaign needs, with the image made
to fit the region it lands in. Everything below serves that sentence.

**1. Advertising units should carry their spec, and outputs should be checked against it.** An
`AdvertisingUnit` is where placement rules belong: maximum file weight, maximum animation length,
loop policy, whether a click-through hook is required, whether a backup image is required. Google
Ads HTML5 units are commonly cited at 150 KB zipped with a 30-second animation limit; IAB guidance
recommends 15 seconds and caps at 30 (**verify** the current documents before encoding either).
Packaging validates against the unit's spec and reports per output, the way `validateSizes` refuses
a size the vocabulary lacks. This is the feature a media buyer notices first, and none of it needs
the compositor.

**2. Templates reference brand roles, never values.** D131's `fill` is the first instance; text
colour, accent and shade should follow. A brand kit (palette by role, logo variants, type ramp) is a
small entity the library resolves against at render. This is what makes one library serve many
brands and what makes "swap brand, keep template" a click.

**3. Library curation is governance.** Required layers (D129) are how a brand locks its logo in.
Versions are immutable (D123); a template is *deprecated*, never deleted, so a campaign pinned to it
still renders. Thumbnails are rendered by the real compositor from the template's own canonical
brief, so the catalogue never shows what the engine cannot draw (D26 applied to the library).
Categorise by unit × creative type — the two axes users actually browse by.

**4. Legibility becomes a per-text-layer concern once text floats.** Today the shade layer exists to
guarantee contrast under the copy block; with frames (D130) text can land anywhere. Give each text
layer an optional `backdrop` (scrim, band, none) and run a contrast check at validation — **as a
warning, not a refusal**. Designers override contrast on purpose; the system should say so, not
stop them.

**5. Generative fill is region-first.** D132's region should drive three things: the generation
aspect, the subject placement hint (a prompt suffix such as "subject centred, negative space to the
left" derived from where text will sit), and the crop. When Firefly-class generators expose
outpainting or structure reference, the region is the input. Build the port so a fake adapter can
assert the aspect requested today, and the real one can grow.

**6. HTML units follow the IAB HTML5 conventions.** One zip, an index document, relative asset
paths, a click-through variable, a polite-load boundary, no external network except what the unit
allows, and the raster fallback beside it (D122). Structural verification is spec verification —
parse, resolve, weigh, look for the hook. Never rasterise (owner's decision); never rely on a
browser in CI.

**7. The roadmap order is not negotiable.** Reorder before toggle before frame before region. Each
rung adds one field to the same record (§2.5) and one rule to the same table (D124). Skipping to
frames without the stack-as-data (L2) means two geometry systems; skipping to regions without
frames means a region with nothing to be relative to.

**8. What not to build.** A free-form canvas editor. The layer vocabulary is typed, the props are
bounded, the regions are rectangles and normalised paths, and there are no blend modes, no arbitrary
transforms, no nested groups. The moment the editor competes with Photoshop it loses to Photoshop
and stops being reproducible. Parameterised templates that render everywhere are the product; a
worse Canva is not.

**9. Measure the arc by what a user can do, not by lanes merged.** After L9 a user can pick a
template from a library, compose its layers, and ship every unit their campaign type implies —
including an HTML unit with a fallback. That is the demo. Frames and regions are the second demo.
