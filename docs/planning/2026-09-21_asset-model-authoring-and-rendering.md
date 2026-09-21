# The Asset Model — one authoring surface, three compile targets

**Date:** 2026-09-21 · **Status:** **DRAFT — for the owner's decision. Nothing dispatched.**
**Scope:** how every asset type is **authored** and how each is **rendered**, stated once for all four
campaign types. It introduces no new creative surface; it proposes retiring one authoring model that
exists today and pointing the display-ad preset at machinery that is already built and unreachable.
**Verified against:** `main` at `d7e7cb0f`. Every claim below cites code that was read, not recalled.
**Decision ids introduced:** D158 – D162. Lane prefix **`AR-`**, checked free against every plan
(`grep -rniE '\bD158\b' docs/ .agents/` … 0 hits) per `the-unowned-gaps.md` §42.
**Relates to:** **HL-D1** and **D122**, both of which this plan proposes amending; **D121** (one
vocabulary), **D124** (the compatibility table), **HL-D2/HL-D3**, **D113** (display sizes), **X14**
(the html platform profiles).

---

## 0. The finding this document exists for

**The platform ships a complete HTML5 display-ad pipeline that no user can reach, and its
display-ad tile renders flat images instead.**

Every piece is on `main`:

| Piece | Where | State |
| --- | --- | --- |
| `image-html` creative type, `outputFamilies: ["html"]` | `creative-types.ts:104` | built |
| `canonical-image-html` template | `creative-templates.ts` | built |
| `html` layer kind + element vocabulary (`text`, `button`, `image`) | `html-element.ts` (HL-D2) | built |
| Markup assembler, emits `clickTag` not `href` | `markup-assembler.ts` (HL-D3) | built |
| Raster fallback, required on every html asset | `drawHtml` (D122, HL-D5) | built |
| `htmlBundlePath` / `htmlFallbackPath` on the asset | `GeneratedAsset.ts` | built |
| Element editor — add text / add link / add button | `HtmlElementsEditor` | built |
| HTML5 platform profiles | `google-display-html`, `display-web-html` (X14) | built |
| Packaging for html rows | `PackageForPlatformUseCase.use-case.ts:29-35` | built |

And the connection that would make it reachable:

```
grep -c 'image-html' packages/CampaignOrchestration/src/domain/value-objects/campaign-types.ts
0
```

**No campaign preset names it.** `display-ad` is `creativeType: "image-text"`, `formats: ["static"]`,
on the three **static** display profiles — not the `-html` ones X14 added for exactly this. The
template library cannot supply it either: that route reads a template **store**, and no templates are
authored on disk, so the canonical templates (domain constants) never appear there.

This is the eleven-PR HL arc (HL1–HL5f, stamped SHIPPED) terminating in a surface with no door.

---

## 1. Findings

| #      | Sev          | Finding |
| ------ | ------------ | ------- |
| **C1** | **Critical** | **A shipped ad format is unreachable.** Above. HTML5 is the dominant creative format for display inventory, and it is the one this product cannot currently make. The fix is a preset and a tile, not a renderer. |
| **C2** | **Critical** | **Authoring an ad is a different mental model from authoring anything else.** In a social post, text is a `static-text` **layer** in the LayerStack. In an html ad, text and button are **elements** nested inside one `html` layer, edited in a separate control. `html-element.ts:4`: *"An `html` layer holds elements, not layers (HL-D1)."* A user who has learned to compose one creative has to learn a second model for the other. |
| **H1** | High         | **HL-D1 solved a real problem and created the thing it was avoiding.** Its stated reason is D121: *"'Add text layer' inside an HTML layer would create a second way to add text beside the existing `static-text` layer kind."* Its remedy — *"One vocabulary for layers; a nested, narrower vocabulary for what lives inside an HTML unit"* — **is two vocabularies.** Reusing the layer vocabulary leaves one. |
| **H2** | High         | **D122 frames html as a third format beside static and motion; the code also models it as a layer kind.** Both are true at once and only the `accepts` table holds them apart: `image-text` and `video` do not accept an `html` layer, and `image-html`'s `outputFamilies` is `["html"]` exclusively. Nothing about the renderers requires this. |
| **M1** | Medium       | **There is no `button` layer kind.** `LAYER_KINDS` is image, fill, static-text, animated-text, html, video, logo, accent, shade. A clickable button exists only as an html *element*. Any move to one vocabulary must mint it. |
| **M2** | Medium       | **An HTML unit cannot contain a clip.** The assembler's element kinds are `text`, `button`, `image` — no video element. "Interactive layer over motion" is not buildable today on either the markup or the packaging side. |
| **L1** | Low          | **The display-ad tile's preview is already honest about the gap.** `TypePreview` renders a 300×250 medium rectangle for `display-ad` — the right picture for an ad, attached to a preset that makes a flat PNG. |

---

## 2. Decisions proposed

| id | Decision | Why |
| --- | --- | --- |
| **D158** | **One authoring vocabulary: layers. `HL-D1` is amended — the html layer's nested `elements` are retired in favour of layer kinds.** A button becomes a layer kind; text stays `static-text`; an image stays `image`. `assembleHtml` compiles the **layer list**, not an element list. | This is HL-D1's own principle (D121) applied one step further. HL-D1 avoided a second way to add text by inventing a second, narrower vocabulary; reusing the first leaves exactly one. It also collapses two editors into one: the LayerStack and props sheet already do this job for every other creative. |
| **D159** | **HTML is a compile target, not a creative kind. `D122` is amended:** `format: "html"` stays a packaging family, but it stops implying its own `creativeType`. A creative is authored once; `static`, `motion` and `html` are renditions of it. | D122's own rule already says an html creative *"always carries a raster rendition"* — i.e. one creative, two outputs. Making html a sibling type forces a second authoring path for what is a second **output** of the same thing. It is also why the display-ad tile points at `image-text`: the type system made the honest choice expensive. |
| **D160** | **`button` joins `LAYER_KINDS`, carrying the click destination.** A button layer is drawn by the compositor for the raster rendition and emitted as `<button>` with `clickTag` for the html rendition — the two renderers HL5f already made agree. | M1. The click destination is already a first-class brief field (HL-D3); a button layer is where it belongs per creative, and `clickTag` remains the emission, never `href`. |
| **D161** | **The display-ad preset targets HTML5, with static as its fallback rendition — not as its product.** `display-ad` becomes `formats: ["html"]` on `google-display-html` / `display-web-html`, and D122's required raster fallback continues to serve `google-display` / `display-web` / `meta-audience-network`. | C1. The `-html` profiles exist (X14) and nothing routes to them. `meta-audience-network` correctly gains no html sibling — X14 records that it *"is understood not to take third-party HTML5 display creatives"* — so it keeps taking the fallback. |
| **D162** | **The create modal offers three kinds, not two and not four-grouped-by-two: Still image · Video · HTML ad.** The four campaign types stay as the presets behind them; the tiles name what the user is making. | The owner's model — every asset is static or video — holds for **content**. HTML is the wrapper. A two-tile fork cannot route `paid-social`, which is deliberately `formats: ["static", "motion"]` (both), and a tile set that omits html hides the format C1 found unreachable. |

---

## 3. The matrix this plan exists to state

**Authoring is one surface for every row.** Layers, in the LayerStack, edited in the props sheet,
previewed in the rail. That is the whole of D158.

| Asset type | Preset | Layers authored | Rendered as | Packaged for |
| --- | --- | --- | --- | --- |
| **Social post** | `social-post` (`image-text`, brief) | image, shade, accent, static-text, logo | PNG per product × ratio | instagram-feed, linkedin, x |
| **Paid social** | `paid-social` (`image-text`, variation) | same, plus `animated-text` and tracks for the motion cells | PNG **and** MP4 — the same layers at two renditions | the seven social profiles |
| **Short video** | `short-video` (`video`, variation) | video, shade, animated-text, logo | MP4 + poster | instagram-story, instagram-reel, tiktok, youtube-short |
| **HTML ad** (D161) | `display-ad` (`image-html`, brief) | image, static-text, **button** (D160), logo | HTML bundle + **required raster fallback** (D122) | `google-display-html`, `display-web-html`; the static profiles take the fallback |

**Display sizes** (D113) are the ad row's canvases: `300x250`, `728x90`, `160x600`, `320x50`,
`300x600`. The medium rectangle — 300×250 — is the one the tile already previews.

**What the rows share:** one layer vocabulary, one props sheet, one preview rail, one compositor
pass. **What differs is only the compile target**, which is the point of D159.

---

## 4. Lanes

| Lane | Delivers | Owns | Depends on |
| --- | --- | --- | --- |
| **AR1** | `button` as a layer kind: vocabulary, occlusion class, default rect, compositor drawer, props (`label`, click destination). Raster rendition only. | `layer-kinds.ts`, `creative-types.ts`, `creative-geometry.ts`, `NodeCanvasCompositor.ts`, **goldens** | D160 stamped |
| **AR2** | `assembleHtml` compiles **layers**. The element vocabulary and `HtmlElementsEditor` retire; `image-html.accepts` widens to the layer kinds. | `markup-assembler.ts`, `html-element.ts`, `creative-types.ts`, `LayerPropsSheet.tsx` | AR1 |
| **AR3** | `display-ad` preset repointed at `image-html` + the `-html` profiles; the raster fallback routes to the static profiles. | `campaign-types.ts`, `PackageForPlatformUseCase` | AR2, D161 |
| **AR4** | The create modal's three tiles (D162), and the `image-html` path reachable end to end. | `CreateCampaignDialog.tsx`, `messages.ts` | AR3 |
| **AR5** | Migration: every persisted brief carrying `html` elements is rewritten to layers, or refused at the boundary with a message naming the fix. | `load-brief.ts`, `brief-yaml.ts` | AR2 |

**Sequencing note.** AR1 moves **goldens** — a new layer kind changes nothing about existing
canonical templates, so the byte expectation is *unmoved*, and that must be proven the way RW-4
proved it rather than assumed. AR2 is the only lane that deletes a shipped surface.

---

## 5. What this plan refuses

- **It does not make html a layer on top of motion.** M2: the assembler has no video element and the
  packaging path has no motion-html profile. "Interactive overlay on a clip" is a separate product
  decision with its own renderer work, and naming it here would make this plan look cheaper than it is.
- **It does not widen `image-text` to emit html.** D159 makes html a rendition, but the creative that
  carries a button and a click destination is the ad. One preset changes, not all four.
- **It does not touch `CAMPAIGN_TYPES`' membership.** D162 changes the tiles' *labels and grouping*,
  not the four presets behind them, so no `policyHash` moves. That is the difference between this
  plan and the 4:5 question.
- **It does not schedule anything.** Five decisions are unstamped. Per RW-D4, a blocked lane does not
  occupy a slot.

---

## 6. Definition of done

1. One vocabulary: `grep` finds no `elements` field on any layer, and `HtmlElementsEditor` is deleted
   rather than left unreachable.
2. A user can create an HTML ad from the modal, author it with the same layers as a social post, and
   package it for `google-display-html` — asserted end to end.
3. Every html asset still carries its raster fallback (D122 unamended on that point), and the two
   renderers agree on what they draw (HL5f's property, extended to the button layer).
4. Goldens: existing canonical templates are byte-unmoved, proven against a pre-change baseline on
   the CI runner.
5. Every persisted brief with html elements either migrates or is refused with a message naming the
   fix — never silently dropped.
6. No planning document's status line contradicts the tree at the end.

---

## 7. What the owner is actually deciding

**D158 and D159 are the plan.** D160–D162 follow from them.

The case for: one authoring model for every asset, an already-built ad format made reachable, and
HL-D1's own anti-duplication principle carried to its conclusion.

The case against, stated fairly: **HL-D1 and D122 are not mistakes.** HL-D2 constrains the element
vocabulary to `text`/`button`/`image` precisely so the raster fallback can be faithful — *"a
`<div>`-anything builder cannot have a faithful raster fallback"* — and that constraint must survive
the move to layers. AR2 deletes a shipped, tested surface. And this is the third open decision area
alongside **D64** and **Q2**.
