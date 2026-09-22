# The Asset Model — one authoring surface, three compile targets

**Status:** **D158, D159, D160 and D163 STAMPED (Owner, 2026-09-21). D161 and D162 remain
unstamped.** **Third draft**, revised the same day on the owner's corrections: D160 no longer mints a
`button` layer kind (§7 says what the first draft got wrong), and the `html` rendition compiles
`<img>` and `<video>` from layers.
same day on the owner's correction: D160 no longer mints a `button` layer kind (§7 says what the
first draft got wrong), and the `html` rendition compiles `<img>` and `<video>` from layers.
**Scope:** how every asset type is **authored** and how each is **rendered**, stated once for all four
campaign types. It introduces no new creative surface; it proposes retiring one authoring model that
exists today and pointing the display-ad preset at machinery that is already built and unreachable.
**Verified against:** `main` at `d7e7cb0f`. Every claim below cites code that was read, not recalled.
**Decision ids introduced:** D158 – D163. Lane prefix **`AR-`**, checked free against every plan
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
| **M1** | Medium       | **Link-as-a-property was decided and never built.** HL-D2 states it outright — *"a link is not an element kind — it is a property any element may carry"* — but `HtmlElement` is `{ kind, text?, style?, frame }` with no link field, and HL-D8 records that the `href?` sketch never shipped. Today only the `button` **kind** is clickable, and it uses the brief's single `clickDestination`. The property HL-D2 promised does not exist on elements or on layers. |
| **M2** | Medium       | **The bundle emits no `<img>`/`<video>` from layers.** The assembler compiles an element list; `image-html` accepts only `image`, `html`, `logo` — **no `video` layer** — and there is no video element kind. Under D158 this is not a missing feature so much as a missing compile rule: an `image` layer becomes `<img>`, a `video` layer becomes `<video>`. |
| **H3** | High         | **An HTML5 bundle is capped at 150 KB, and that — not D118 — is what constrains a video ad.** `HTML_MAX_BYTES = 150 * 1024` on both html profiles, against `MOTION_MAX_BYTES` of 100 MB. A clip cannot be embedded in that budget at any duration. Real video display creatives **reference** a hosted clip (`<video src="https://…">`) so the bundle stays small — which means the `<video>` compile rule needs an asset URL, not bytes. |
| **H4** | High         | **That URL is behind D64.** Referencing a hosted clip requires object storage with stable public addresses — the cloud work D64 gates, whose list in `remaining-work.md` C1 names presigned uploads and object storage explicitly. The `<img>` half has the same shape but a smaller problem: an image can sit inside 150 KB, so it may embed as a data URI. **The `<video>` half of this plan is therefore gated by the same fork as everything else.** |
| **L1** | Low          | **The display-ad tile's preview is already honest about the gap.** `TypePreview` renders a 300×250 medium rectangle for `display-ad` — the right picture for an ad, attached to a preset that makes a flat PNG. |

---

## 2. Decisions proposed

| id | Decision | Why |
| --- | --- | --- |
| **D158** | **STAMPED — Owner, 2026-09-21.** **One authoring vocabulary: layers. `HL-D1` is amended — the html layer's nested `elements` are retired in favour of layer kinds.** A button becomes a layer kind; text stays `static-text`; an image stays `image`. `assembleHtml` compiles the **layer list**, not an element list. | This is HL-D1's own principle (D121) applied one step further. HL-D1 avoided a second way to add text by inventing a second, narrower vocabulary; reusing the first leaves exactly one. It also collapses two editors into one: the LayerStack and props sheet already do this job for every other creative. |
| **D159** | **STAMPED — Owner, 2026-09-21.** **HTML is a compile target, not a creative kind. `D122` is amended:** `format: "html"` stays a packaging family, but it stops implying its own `creativeType`. A creative is authored once; `static`, `motion` and `html` are renditions of it. | D122's own rule already says an html creative *"always carries a raster rendition"* — i.e. one creative, two outputs. Making html a sibling type forces a second authoring path for what is a second **output** of the same thing. It is also why the display-ad tile points at `image-text`: the type system made the honest choice expensive. |
| **D160** | **STAMPED — Owner, 2026-09-21; the decision's content is the owner's own correction in review, not a proposal they accepted.** **Linkability is a PROPERTY on a layer, not a layer kind. `button` is never minted.** Any layer may carry a click target: a `static-text` layer with it compiles to `<button>`; an `image` layer with it makes the whole rasterised creative clickable — the common display case. `clickTag` remains the emission, never `href` (HL-D3). | **The owner's correction, and it completes HL-D2 rather than amending it** — that decision already said a link is a property any element may carry, and the property was never built (M1). A `button` layer kind would have been a *third* way to say "text that is clickable", which is the duplication D121 and HL-D1 both exist to prevent. It also unlocks the case a button kind cannot express: a fully rasterised AI-generated ad whose single image layer is the click target. |
| **D161** | **UNSTAMPED — follows from D158/D159, still the author's proposal.** **The display-ad preset targets HTML5, with static as its fallback rendition — not as its product.** `display-ad` becomes `formats: ["html"]` on `google-display-html` / `display-web-html`, and D122's required raster fallback continues to serve `google-display` / `display-web` / `meta-audience-network`. | C1. The `-html` profiles exist (X14) and nothing routes to them. `meta-audience-network` correctly gains no html sibling — X14 records that it *"is understood not to take third-party HTML5 display creatives"* — so it keeps taking the fallback. |
| **D163** | **STAMPED — Owner, 2026-09-21; owner-raised — the request was a process to keep injected script out of the bundle.** **The bundle's only script is the one this codebase writes, and every value reaching markup is escaped at emission or gated by a closed vocabulary. D158 carries that property forward unchanged.** Concretely, after the rewrite: copy is `escapeHtml`'d wherever it lands; the `clickTag` declaration stays the sole `<script>` and keeps `escapeScriptJson`; any URL a layer contributes is scheme-gated to `http:`/`https:` the way `clickDestination` is; and per-layer style stays a closed union (`fontWeight`, `fontFamily`), never free CSS. | **This is already true and already tested — the risk is losing it in the rewrite, not acquiring it.** On `main`: `escapeHtml` is the five-character escape; `escapeScriptJson` turns `<`, `>`, `&` into `\uXXXX` so a crafted value cannot close the declaration with a literal `</script>` (HL-D7); `isAbsoluteUrl` refuses anything but http/https, with a test named *"refuses non-http/https protocols (XSS surface and untrackable schemes)"* asserting `javascript:alert(1)` is false; and `markup-assembler.test.ts` asserts a `<script>alert("xss")</script>` headline emits escaped. **The threat model is not hypothetical:** headline copy is LLM-generated, so an untrusted string reaches markup on the ordinary path, not only via a hostile operator. AR2 replaces the emission sites those guarantees live at, which is exactly when a property like this gets dropped silently. |
| **D162** | **UNSTAMPED — follows from D158/D159, still the author's proposal.** **The create modal offers three kinds, not two and not four-grouped-by-two: Still image · Video · HTML ad.** The four campaign types stay as the presets behind them; the tiles name what the user is making. | The owner's model — every asset is static or video — holds for **content**. HTML is the wrapper. A two-tile fork cannot route `paid-social`, which is deliberately `formats: ["static", "motion"]` (both), and a tile set that omits html hides the format C1 found unreachable. |

---

## 3. The matrix this plan exists to state

**Authoring is one surface for every row.** Layers, in the LayerStack, edited in the props sheet,
previewed in the rail. That is the whole of D158.

| Asset type | Preset | Layers authored | Rendered as | Packaged for |
| --- | --- | --- | --- | --- |
| **Social post** | `social-post` (`image-text`, brief) | image, shade, accent, static-text, logo | PNG per product × ratio | instagram-feed, linkedin, x |
| **Paid social** | `paid-social` (`image-text`, variation) | same, plus `animated-text` and tracks for the motion cells | PNG **and** MP4 — the same layers at two renditions | the seven social profiles |
| **Short video** | `short-video` (`video`, variation) | video, shade, animated-text, logo | MP4 + poster | instagram-story, instagram-reel, tiktok, youtube-short |
| **HTML ad** (D161) | `display-ad` (`image-html`, brief) | image **or video**, static-text, logo — any of them linkable (D160) | HTML bundle (`<img>` / `<video>` / `<button>`) + **required raster fallback** (D122) | `google-display-html`, `display-web-html`; the static profiles take the fallback |

**Display sizes** (D113) are the ad row's canvases: `300x250`, `728x90`, `160x600`, `320x50`,
`300x600`. The medium rectangle — 300×250 — is the one the tile already previews.

**The compile rules (D159), stated once:**

| Layer | `static` / `motion` rendition | `html` rendition |
| --- | --- | --- |
| `image` | drawn by `paintBackground` | `<img>` |
| `video` | frames through the compositor | `<video>` |
| `static-text` | drawn by `drawStaticText` | `<p>`, or `<button>` when linked |
| any layer carrying a click target (D160) | drawn normally | wrapped, emitting `clickTag` |

**What the rows share:** one layer vocabulary, one props sheet, one preview rail, one compositor
pass. **What differs is only the compile target**, which is the point of D159. A video display ad is
therefore not a fifth campaign type — it is this table's second row under the `html` column.

---

## 4. Lanes

| Lane | Delivers | Owns | Depends on |
| --- | --- | --- | --- |
| **AR1** | **Linkability as a layer property** (D160): the field, its validation at both boundaries, and the editor control. No new layer kind, so **no golden moves** — the raster rendition of a linked layer is byte-identical to the same layer unlinked. | `brief-template.ts`, `LayerPropsSheet.tsx`, `load-brief.ts`, `brief-yaml.ts` | **ready** (D160 stamped) |
| **AR2** | `assembleHtml` compiles **layers** to the §3 table: `<img>`, `<p>`/`<button>`, each wrapped with `clickTag` when linked. The element vocabulary and `HtmlElementsEditor` retire; `image-html.accepts` widens to the layer kinds. **`<video>` is NOT in this lane** — see AR6. | `markup-assembler.ts`, `html-element.ts`, `creative-types.ts`, `LayerPropsSheet.tsx` | AR1 |
| **AR3** | `display-ad` preset repointed at `image-html` + the `-html` profiles; the raster fallback routes to the static profiles. | `campaign-types.ts`, `PackageForPlatformUseCase` | AR2, **D161 — unstamped** |
| **AR4** | The create modal's three tiles (D162), and the `image-html` path reachable end to end. | `CreateCampaignDialog.tsx`, `messages.ts` | AR3, **D162 — unstamped** |
| **AR5** | Migration: every persisted brief carrying `html` elements is rewritten to layers, or refused at the boundary with a message naming the fix. **Scope measured:** zero of the seven tracked sample briefs carry them (`git grep -l 'elements:' -- 'briefs/*.yaml'` → 0); operator briefs are gitignored since #167, so their content is **unknown**, which is why this lane refuses rather than assumes. | `load-brief.ts`, `brief-yaml.ts` | AR2 |
| **AR6** | **`<video>` in the bundle — BLOCKED on D64.** `image-html.accepts` gains `video`, and the compile rule emits `<video src=…>` pointing at a hosted clip. Needs object storage with stable addresses (H3, H4). **The `src` is a new URL surface and takes `isAbsoluteUrl`'s scheme gate (D163)** — a hosted-asset URL is no more trusted than a click destination. | `markup-assembler.ts`, `creative-types.ts`, the asset store | **D64** |

**Sequencing note.** AR1 moves **goldens** — a new layer kind changes nothing about existing
canonical templates, so the byte expectation is *unmoved*, and that must be proven the way RW-4
proved it rather than assumed. AR2 is the only lane that deletes a shipped surface.

---

## 5. What this plan refuses

- **It does not ship `<video>` in the bundle.** That is AR6, and it is blocked on **D64**, not on
  renderer work: the 150 KB html ceiling (H3) means a clip must be REFERENCED, and a stable public
  URL is object-storage work behind the identity fork (H4). The first draft named this as a
  packaging-profile question; measuring `HTML_MAX_BYTES` showed the real constraint is the budget,
  and the real dependency is storage. **D118's stills-only rule is about the `static` family and is
  untouched** — an html bundle is not a static rendition.
- **It does not widen `image-text` to emit html.** D159 makes html a rendition, but the creative that
  carries a button and a click destination is the ad. One preset changes, not all four.
- **It does not touch `CAMPAIGN_TYPES`' membership.** D162 changes the tiles' *labels and grouping*,
  not the four presets behind them, so no `policyHash` moves. That is the difference between this
  plan and the 4:5 question.
- **It does not schedule anything.** AR1 and AR2 are **ready** on the stamped decisions; AR3 and AR4
  wait on D161 and D162, and AR6 on D64. Per RW-D4 a blocked lane does not occupy a slot, so the
  wave that runs this is AR1 → AR2 → AR5, and the tile work follows a second stamp.

---

## 6. Definition of done

1. One vocabulary: `grep` finds no `elements` field on any layer, and `HtmlElementsEditor` is deleted
   rather than left unreachable.
2. A user can create an HTML ad from the modal, author it with the same layers as a social post, and
   package it for `google-display-html` — asserted end to end.
3. Every html asset still carries its raster fallback (D122 unamended on that point), and the two
   renderers agree on what they draw (HL5f's property, extended to every linkable layer).
4. **The injection tests survive the rewrite against the LAYER path, not the retired element path**
   (D163): a `<script>`-bearing headline emits escaped, a non-http click target is refused, and the
   `clickTag` declaration is still the only script in the bundle. A test that passes only against
   `HtmlElementsEditor`'s vocabulary is a test that retires with it.
5. Goldens: existing canonical templates are byte-unmoved, proven against a pre-change baseline on
   the CI runner.
6. Every persisted brief with html elements either migrates or is refused with a message naming the
   fix — never silently dropped.
7. No planning document's status line contradicts the tree at the end.

---

## 7. What the owner is actually deciding

**D158, D159, D160 and D163 are stamped (Owner, 2026-09-21).** What is left to decide is **D161**
(does the display-ad preset target HTML5, with static as its fallback rather than its product) and
**D162** (the three tiles). Both follow naturally from the stamped four, and both are still the
author's proposals rather than the owner's words — which is why they are marked unstamped rather
than carried along.

**Original framing, kept because the reasoning is the record:** **D160 was rewritten on the owner's
correction (2026-09-21):** the first draft minted a `button` layer kind; linkability is a property
any layer may carry, which is what HL-D2 already decided and never built. That version was worse —
it would have added a third way to say "clickable text" and could not have expressed a rasterised
ad whose one image layer is the click target.

The case for: one authoring model for every asset, an already-built ad format made reachable, and
HL-D1's own anti-duplication principle carried to its conclusion.

**What stamping them buys immediately:** AR1–AR5 become dispatchable and the display-ad tile stops
making flat images. **AR6 does not** — the video half waits on D64 like everything else, so
stamping D158/D159 does not commit to it.

The case against, stated fairly: **HL-D1 and D122 are not mistakes.** HL-D2 constrains the element
vocabulary to `text`/`button`/`image` precisely so the raster fallback can be faithful — *"a
`<div>`-anything builder cannot have a faithful raster fallback"* — and that constraint must survive
the move to layers. AR2 deletes a shipped, tested surface. And this is the third open decision area
alongside **D64** and **Q2**.
