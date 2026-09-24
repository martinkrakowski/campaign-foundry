# The Asset Model, Finished — Architecture & Development Plan

**Date:** 2026-09-23 · **Status:** **CLOSED — every lane merged, 2026-09-24.** AF3 [#559](https://github.com/martinkrakowski/campaign-foundry/pull/559) (`3208e55c`), AF5 [#560](https://github.com/martinkrakowski/campaign-foundry/pull/560) (`8a0067dd`), AF1 [#562](https://github.com/martinkrakowski/campaign-foundry/pull/562) (`d08fa210`), AF2 [#563](https://github.com/martinkrakowski/campaign-foundry/pull/563) (`8cbcb616`), AF4 [#564](https://github.com/martinkrakowski/campaign-foundry/pull/564) (`cd9abd4e`), AF6 (this status, docs-only push). **D164 was stamped after AF1 had already shipped** (§7). **The Google HTML5 validator check it required was run three times on 2026-09-24.** The validator only ran its App Campaigns rules, but every display-relevant check passed, and its preview painted the headline once. The one display requirement the bundle was missing, `<meta name="ad.size">`, shipped as [#566](https://github.com/martinkrakowski/campaign-foundry/pull/566) (`e73df68d`) (§7). D165 and D161 are stamped, and L3a is kept as is. **Still open:** a Google Ads UI upload for a display-rule verdict (the h5validator only runs playable rules; on the owner's 2026-09-24 run it read `ad.size` and sized the preview to 300x250), and AR6, which waits on a storage plan now that D64 is answered (b), database-fronted, 2026-09-24. r1 was
reviewed the same day by Fable 5.1 against `425e59e4`. It returned four blocking or major errors in r1
itself, all corrected here and listed in §8, because they are the kind this repository keeps
repeating.
**Scope:** the gaps a verification pass found between `2026-09-21_asset-model-authoring-and-rendering.md`
(the "asset-model plan") and `main`. It introduces no new creative surface. Every lane below closes a
Definition-of-Done item that plan claims and the tree does not yet meet.
**Verified against:** `main` at `425e59e4`. Every claim below cites code that was read, not recalled.
**Decision ids introduced:** D164 – D165 (`git grep -ohE "D[0-9]{3}" -- docs .agents | cut -c2- | sort -n -u | tail -1`
→ 163). **Lane prefix `AF-`**, checked free with `git grep -cP "\bAF[0-9]+\b" -- docs .agents` → 0.
(Use `-P` for `\b`: macOS `git grep -E` treats `\b` as matching nothing, so an `-E` count of 0 proves
nothing. r1 made that mistake.)
**Relates to:** D122 (the required raster fallback), D158 (one vocabulary), D160 (linkability as a
property), D161 (stamped after the fact 2026-09-24), D163 (the bundle's injection guarantees), HL-D1 / HL5f
(`2026-09-10_the-html-layer.md`), CE2's hit-region decision (`PreviewHitRegions.tsx:96-100`), L3a's
draft fallback (`editor-state.ts:3303-3318`), **D64** (AR6's blocker; answered (b), database-fronted, 2026-09-24).

---

## 0. The finding this document exists for

**Every HTML ad the platform generates paints its headline twice.**

The chain, each link read on `main` and re-verified by review:

1. `GenerateCampaignUseCase.use-case.ts:545` writes `htmlFallbackPath` from `composite.image`, which is
   the whole composite: the same bytes as the row's `outputPath`. The variation path does the same at
   `:985`.
2. The compositor draws `static-text` for every creative type. `LAYER_DRAWERS` maps
   `"static-text": drawStaticText` (`NodeCanvasCompositor.ts:299-308`) and nothing gates on
   `creativeType`. `static-text` is `required` for `image-html` (`creative-types.ts:105`), so it cannot
   be disabled, and the canonical template carries it (`creative-templates.ts:100`).
3. `assembleHtml` compiles the `image` layer to `<img src="fallback.png">` over the full canvas
   (`markup-assembler.ts:196-200`) **and** the `static-text` layer to a white `<p>{headline}</p>`
   (`:203-211`).

The bundle is therefore the finished raster, headline included, with a second live headline on top.
The two copies cannot line up:

- **Font.** The markup names the right family (`font-family: Inter, sans-serif`,
  `markup-assembler.ts:189`), but the bundle ships no font (`git grep "@font-face"` in
  `packages/CampaignOrchestration/src` → 0). Unless the viewer has Inter installed, the browser uses
  its fallback font.
- **Position.** The compositor places the headline by **measured layout**: `anchorFirstY` over a
  measured span and a fitted type size (`NodeCanvasCompositor.ts:796`, `:952`). A declared frame only
  clips it (`:1455-1462`) and never moves it. The bundle's frameless box is a fixed
  `5% / 10% / 90% / 30%` (`markup-assembler.ts:143`). No DOM box can reproduce the compositor's
  position without re-measuring the text, which is exactly what D52 deleted from the web side (CE2
  records this at `PreviewHitRegions.tsx:96-100`).

**The suite pins the defect.** `markup-assembler.test.ts:99`, *"an image layer emits one img of the
fallback, and a logo does not repeat that raster"*, asserts both `fallback.png` and `>Shop</p>` in the
same bundle. The comment beside the logo branch (`markup-assembler.ts:194-195`) already knows the
raster is the whole creative. The rule it applies to `logo` was never applied to `static-text`.

The asset-model plan's §3 table says `image` → `<img>`, meaning the image *layer*. AR2 (#555) used the
D122 fallback raster as that `<img>` instead, and that raster has every layer baked in. Asset-model
DoD 3 ("the two renderers agree on what they draw") is not met while this stands.

---

## 1. Findings

| #      | Sev        | Finding |
| ------ | ---------- | ------- |
| **H1** | **High**   | **The headline is painted twice in every html bundle.** See §0. Every display-ad run since AR2 (#555) ships it, and `markup-assembler.test.ts:99` asserts the doubled output. |
| **H2** | **High**   | **A linked headline's click region is a guess.** The bundle's frameless box is `5% / 10% / 90% / 30%` (`markup-assembler.ts:143`). `layerBoxStyle` resolves a *declared* frame through `resolveLayerFrame` but never falls back to `defaultLayerRect("static-text")`, which is the band the compositor's layout is constrained to (x 0, y 0.1, w 1, h 0.82, `creative-geometry.ts:282-287`). The glyphs themselves sit wherever `anchorFirstY` put them inside that band, and the domain assembler cannot know where: the measurement is infrastructure. **The best the bundle can do is the band.** That is the same conclusion CE2 reached for the preview's hit regions, where it excluded static-text outright. |
| **H3** | **High**   | **An unlinked headline blocks clicks on a linked image.** `assembleHtml` emits the `<img>` wrapper first and the `<p>` after, both `position: absolute` (`markup-assembler.ts:196-209`). The later element is on top, so clicks inside the headline's box never reach the linked image's `<button>`. This is live today and is fixed by D164. |
| **M1** | Medium     | **The html profile is never packaged end to end.** The only route-level display test (`routes.test.ts:174`) packages **`google-display`**, the raster fallback (`:219`). `google-display-html` and `display-web-html` are packaged only in unit tests over hand-built rows (`PackageForPlatformUseCase.use-case.test.ts:860`, `:923`). Asset-model DoD 2 says "asserted end to end". |
| **M2** | Medium     | **The API refuses a retired `html` kind without naming the fix.** AR7 (#558) removed `html` from `LAYER_KINDS` and relied on the generic accepts refusal: `"template.layers[i].kind" must be one of [...]; got "html".` (`load-brief.ts:272-276`). The retired `elements` field got a message that names the fix (`load-brief.ts:338-341`). The kind that carried it did not. Operator briefs are gitignored since #167, so how many carry the kind is **unknown**. **The editor's draft restore is a different case, and it is by design:** `normalizeDraftState` swaps in the canonical template for any template that fails `isBriefTemplate` (`editor-state.ts:3303-3318`), silently. L3a's recorded intent is "a user reopening a damaged draft gets a working editor", and an `html` layer fails `isLayerEntry`'s `LAYER_KINDS` check, so it takes that path. Changing it is an owner question (§7), not a lane's call. |
| **M3** | Medium     | **The "Click target" control appears where it compiles to nothing.** `LayerPropsSheet.tsx:410-437` renders the checkbox on every layer kind of every creative type. `assembleHtml` honours `link` on `image` and `static-text` only, and only an `image-html` creative has an html rendition. On a social post, or on a logo, shade, accent or fill layer, ticking it changes nothing, and the help text ("Opens this brief's click destination", `messages.ts:1403`) says it will. Nothing in the editor's `validate.ts` checks `link`. |
| **L1** | Low        | **The retired model is still described in code.** `brief-yaml.test.ts` carries `kind: "html"` and `elements` fixtures at `:341-380`, `:383-401`, `:437` and `:647-677`, and asserts `elements:`'s key position. Comments that still describe the element editor or the html layer as live: `layer-stack-props.ts:92-94`, `PreviewFrame.tsx:135-136`, `brief-editor.layers.test.tsx:754`, `editor-state.test.ts:4679`, and `PackageForPlatformUseCase.use-case.ts:111` ("none ships one yet", stale since X14 shipped two html profiles). |
| **L2** | Low        | **Two planning documents contradict the tree.** `2026-09-10_the-html-layer.md` is stamped SHIPPED and states HL-D1 ("holds *elements*, not layers", `:63`) with no pointer to D158, AR2 (#555) or AR7 (#558), which retired it. The asset-model plan's own header repeats a line (`unstamped.**`, lines 3-4) and still says "verified against `d7e7cb0f`" after five merges. Asset-model DoD 7. |

**Checked and passing (not findings):**
- DoD 4: the injection tests run on the layer path (`markup-assembler.test.ts:53`, `:61`, `:74`).
- AR1: `link` is validated by the shared `layerLinkProblem` (`brief-template.ts:182`) at both boundaries.
- AR3's preset, AR4's three tiles and AR7's template all match their rows.
- CI on `main` is green at `425e59e4`.

**Still open, owned elsewhere:** **AR6** (`<video>` in the bundle) stays blocked on **D64**, and this
plan does not re-plan it. **D161** was unstamped at `425e59e4` although AR3 (#556) shipped its content; the owner stamped it
2026-09-24 (§7).

---

## 2. Decisions proposed

| id | Decision | Why |
| --- | --- | --- |
| **D164** | **STAMPED — Owner, 2026-09-24, after the fact: AF1 (#562) shipped it the day before, unstamped. The Google HTML5 validator check below is still not done.** **One raster per html unit, and the bundle paints nothing the raster already paints.** The `<img>` stays the D122 fallback. An **unlinked** `static-text` layer emits **nothing**, the same rule `logo` already follows (`markup-assembler.ts:194-195`). The headline is in the pixels, and the `<img>` `alt` carries the copy when the image layer has no `alt` prop of its own. A **linked** `static-text` layer emits a transparent `<button>` over the band (H2): the resolved declared frame, else `defaultLayerRect("static-text")`. Its copy goes in a visually-hidden span, escaped, so the button has an accessible name. | **Recommended**, for four reasons, each measured: (1) **No double paint.** Only one renderer paints text. (2) **Weight.** A unit is `bundle + fallback` (`PackageForPlatformUseCase.use-case.ts:378`) against `HTML_MAX_BYTES` = 150 KB (`PlatformProfile.vo.ts:108`), so a second raster roughly doubles the image payload of every unit. (3) **No "hidden text" exposure.** Visually-hidden text inside an interactive control is the standard accessibility pattern. A paragraph of `color: transparent` copy (r1's proposal) reads as cloaked text. (4) **It fixes H3.** The only DOM element over the image is the linked one. **D163 holds:** the copy is still `escapeHtml`'d, and nothing new is interpolated. **Unverified, and must be checked before stamping:** that Google's HTML5 validator accepts a transparent `<button>` over an `<img>`. |
| | *Alternative, not recommended:* render a second composite with `static-text` disabled, save it as `backdrop.png`, and paint live white text over it. | This gives live, restylable text. It costs a second render per cell, a new asset field threaded through `GeneratedAsset`, the report, packaging and the unit-weight sum, and it still depends on a font the bundle does not ship. Worth revisiting only if D64's object storage brings hosted web fonts. |
| **D165** | **STAMPED — Owner, 2026-09-24. Shipped as AF4 (#564).** **Where a click target compiles is declared once, in the creative-type rules.** `CREATIVE_TYPE_RULES[type]` gains `linkable: readonly LayerKind[]`: `["image", "static-text"]` for `image-html`, `[]` for `image-text` and `video`. **Three readers, three different behaviours, each named:** (a) `assembleHtml` reads it for the link decision. (b) **The API refuses** `link: true` on a kind the type does not list, in `load-brief.ts`, with a message naming where it compiles. (c) **The editor** shows the checkbox only on linkable kinds, and `validate.ts` reports a linked layer elsewhere as an error that names the fix, the same way it mirrors other API refusals. **`layerLinkProblem` and `isBriefTemplate` do not change:** they stay shape-only. | D160 says linkability is a property, not a kind. It does not say every kind on every type must accept it. Today the answer lives only in `assembleHtml`'s branches, so the editor offers a control the compiler ignores (M3). **Why the domain guard stays shape-only:** `isBriefTemplate` failing is **silent** in three web consumers. `normalizeDraftState` replaces the whole template with the canonical one (`editor-state.ts:3316-3318`), `templates-api.ts:232` returns null, and `run-context.tsx:388` filters the template out. Refusing there would discard authored work without a word, which is the opposite of what this decision is for. **Changing type is safe:** `applyPreset` reseeds the template through `templateFromCanonical` (`editor-state.ts:1456`), so no linked layer survives a switch to a type that cannot compile it. **Cost:** a brief authored since AR1 (#554, 2026-09-21) with `link: true` on, say, a logo is refused by the API on its next load, and the editor shows the same error. That is two days of exposure on operator briefs, whose content is unknown. |

---

## 3. What each layer compiles to in the bundle, after D164 and D165

| Layer | Raster (fallback and `<img>`) | Bundle markup |
| --- | --- | --- |
| `image` | drawn | `<img src="fallback.png" alt="…">` over the full canvas, wrapped in a `<button>` that opens `clickTag` when linked |
| `shade`, `accent`, `fill`, `logo` | drawn | nothing, because the `<img>` already carries it |
| `static-text`, unlinked | drawn | nothing; its copy is the `<img>` `alt` when the image layer sets none |
| `static-text`, linked | drawn | a transparent `<button>` over the band, with the copy escaped in a visually-hidden span |
| a kind `linkable` does not list, with `link: true` | — | refused by the API and flagged by the editor (D165) |

---

## 4. Lanes

| Lane | Delivers | Owns | Depends on |
| --- | --- | --- | --- |
| **AF1** | **One raster per unit (D164), with the click region on the band (H2) and nothing unlinked on top (H3).** Unlinked `static-text` emits nothing; the `<img>` `alt` falls back to the escaped copy. Linked `static-text` emits a transparent `<button>` at `resolveLayerFrame(frame, spec) ?? defaultLayerRect("static-text")`, with the copy in a visually-hidden span. The fixed `5% / 10% / 90% / 30%` box is deleted. Rewrite `markup-assembler.test.ts:99` to assert one `<img>` and no visible text node, and add a test that a linked image with unlinked copy has exactly one interactive element. **Rendering lane:** model review, plus one replayed mutation (restore the unlinked `<p>`, and show the new test fails). `derive.test.ts:630-845` compares against `assembleHtml` itself, so it follows the change without edits. Confirm this in the PR. | `markup-assembler.ts`, `markup-assembler.test.ts` | **D164** stamped, after the validator check it names |
| **AF2** | **The html profile, packaged end to end (M1).** Add a sibling to `routes.test.ts:174`: generate a display-ad, then package **`google-display-html`**. Assert that the packaged directory holds `index.html` **and** the file its `<img src>` names, side by side. Assert that the manifest item has `checks.size === "pass"` and `bytes` equal to the bundle's length (`PackageForPlatformUseCase.use-case.ts:388-389`); the bundle-plus-fallback sum exists only as `checks.size`. Finally, assert that the packaged `index.html` contains exactly one `<img` and no visible headline text: AF1's claim, end to end. | `apps/api/server/routes/__tests__/routes.test.ts` | AF1 (its last assertion reads AF1's output) |
| **AF3** | **The API names the fix for the retired kind (M2).** Ahead of the generic accepts check, `load-brief.ts` refuses `kind: "html"` with: *`"template.layers[i].kind" "html" is retired; delete the layer and author the copy as a static-text layer.`* One test for the message, and one showing that any other unknown kind still gets the generic message. **The editor's draft path is not touched.** L3a's silent canonical fallback is a standing decision, and §7 asks whether to change it. | `load-brief.ts`, `load-brief.test.ts` | — |
| **AF4** | **Linkability declared where it compiles (D165, M3).** Add `linkable` to `CREATIVE_TYPE_RULES`, and have `assembleHtml` read it. `load-brief.ts` refuses `link: true` outside it, with a message. `LayerPropsSheet` renders the checkbox only on linkable kinds of the current type. `validate.ts` reports a linked non-linkable layer, and the help text says where a click target works. Rewrite the existing tests that tick `link` on shade or logo (`LayerPropsSheet.test.tsx:673-728`). Add one test per refused case at the API, one per creative type for the sheet, and one for `validate.ts`. The `setLayerLink` reducer (`editor-state.ts:1696-1713`) is unchanged: the control that dispatches it is what narrows. | `creative-types.ts`, `creative-types.test.ts`, `markup-assembler.ts`, `markup-assembler.test.ts`, `load-brief.ts`, `load-brief.test.ts`, `LayerPropsSheet.tsx`, `LayerPropsSheet.test.tsx`, `validate.ts`, its test, `messages.ts`; `editor-state.layer-link.test.ts` if its fixtures use non-linkable kinds | **D165** stamped; AF1 and AF3 (shared files) |
| **AF5** | **The retired model leaves the code (L1).** Rewrite every `html`/`elements` fixture in `brief-yaml.test.ts` (`:341-380`, `:383-401`, `:437`, `:647-677`) on the current layer shape, a `static-text` layer with `link`, asserting the real `LAYER_KEY_ORDER` (`id, kind, enabled, frame, props, link, tracks`). Correct the five stale comments. Comments and fixtures only; no source behaviour changes, so no mutation round. | `brief-yaml.test.ts`, `layer-stack-props.ts`, `PreviewFrame.tsx`, `brief-editor.layers.test.tsx`, `editor-state.test.ts` (comment only), `PackageForPlatformUseCase.use-case.ts` (comment only) | — |
| **AF6** | **The documents match the tree (L2).** In `2026-09-10_the-html-layer.md`, add one line to the status and one to HL-D1's row: *amended by D158; the element model was retired by AR2 (#555) and the `html` kind by AR7 (#558).* In the asset-model plan: remove the duplicated header line, update "verified against", name AF1–AF6 as the owners of its DoD 2, 3, 6 and 7, and record D161 once §7 is answered. Docs only; a direct push to `main` is acceptable. | the two planning documents | last, after AF1–AF5 merge, so it cites their PR numbers |

**Sequencing.**
- **Wave 1:** **AF1** (once D164 is stamped), **AF3** and **AF5**. Their Owns columns are disjoint.
- **Wave 2:** **AF2** and **AF4**. AF2 asserts AF1's output, and AF4 edits files AF1 and AF3 own.
- **Last:** **AF6**.

AF4 is blocked on D165 and does not hold a slot while it waits (RW-D4). Each lane is one PR.

**AR6 is not here.** It stays in the asset-model plan, blocked on D64.

---

## 5. What this plan refuses

- **It does not add a second raster to the bundle.** That is D164's alternative, and §2 says why not.
- **It does not ship fonts in the bundle.** Hosted web fonts belong with D64's object storage, like
  AR6's hosted clip. D164 makes fonts unnecessary for a correct ad.
- **It does not measure text on the web side to place the click region.** D52 deleted that
  measurement, and CE2 kept it deleted. The band is the region.
- **It does not migrate operator briefs.** AF3 refuses with a message naming the fix, the same choice
  AR5 made, because their content is unknown.
- **It does not change L3a's draft fallback.** §7 asks whether it should.
- **It does not re-record goldens.** No lane changes a compositor draw: AF1 changes only markup, and
  the compositor goldens build `CompositeRequest`s by hand (`NodeCanvasCompositor.goldens.test.ts`).
  A lane whose golden test fails has changed something it does not own.

---

## 6. Definition of done

1. An html bundle contains exactly one raster and no visible text node. Asserted in
   `markup-assembler.test.ts`, and again end to end in AF2.
2. A linked headline's click region is the band the compositor's layout is constrained to: the
   declared frame resolved for the canvas, else `defaultLayerRect("static-text")`. Asserted for a
   frameless layer and for a framed layer with a display-size overlay.
3. No unlinked element sits over a linked one. A linked image with unlinked copy has exactly one
   interactive element.
4. A generated display-ad is packaged for `google-display-html` in a route-level test, with its bundle
   and the file its `<img>` references side by side, and `checks.size === "pass"`.
5. A brief carrying the `html` kind is refused by the API with a message that names the fix.
6. The "Click target" control appears exactly where a click target compiles. A brief asking for one
   anywhere else is refused by the API and flagged by the editor's `validate.ts`. Neither path drops
   the template silently.
7. `git grep -nP "\belements\b"` over `packages/*/src` and `apps/api/server` finds only the AR2
   refusal, its doc comments and its tests. `apps/web` is excluded because it uses the word for DOM
   nodes; there, AF5's named sites are the check.
8. D163's three guarantees still hold on the new markup: escaped copy, the `clickTag` declaration as
   the only script, and non-http(s) destinations refused.
9. No planning document's status line contradicts the tree, and D161 is either stamped or recorded
   as the owner's open question.

---

## 7. What the owner decided (2026-09-24)

- **D164 — stamped, after the fact.** AF1 (#562) shipped the single-raster bundle on 2026-09-23 while
  this document still listed D164 as PROPOSED and said AF1 could not be dispatched until it was
  stamped. The owner stamped it on 2026-09-24. **The validator check this section required first
  — that Google's HTML5 validator accepts a transparent `<button>` over an `<img>` — has not been
  done.** It is the one open item this plan leaves, besides AR6.

  **Validator run, 2026-09-24 (owner-approved upload of a synthetic bundle):** a real
  `assembleHtml` output (image layer, linked `static-text`, clickTag to `https://example.com`, a
  plain 300x250 PNG) was uploaded to `h5validator.appspot.com/adwords/asset` twice (results
  `5421204784152576` and `5754646918987776`). Both runs used the **App Campaigns** (playable-ad) rule
  set. That checkbox is on by default, and the drop upload ignored unticking it. So the two failures
  are playable-ad rules that do not apply to a display ad: `ExitApi.exit()` missing, and 320x480
  dimensions. **Every check that does apply to display passed:** Multiple Click Exits (the
  transparent button plus clickTag is one exit), HTML5 Not Allowed Features, Missing asset, 4th
  party calls, Secure URL, File Type/Count, Bundle Size and structure. The owner ran a third upload
  by hand and got the identical App Campaigns result. The validator's own preview painted "Hi"
  once, which is independent confirmation of H1's fix. **`ad.size` settled:** Google Ads' uploaded
  display ads specification (support.google.com/google-ads/answer/1722096) requires the size meta
  tag in `<head>`, and nothing emitted it. [#566](https://github.com/martinkrakowski/campaign-foundry/pull/566)
  (`e73df68d`) declares the resolved canvas, asserted for three sizes and end to end. **Not
  obtainable here:** a display-rule verdict from this validator page, which ran the playable rules
  on every upload. The next real check is an upload in the Google Ads UI.

  **Cleanup, same day:** the band height printed as `205.00000000000003px`, and box pixels now
  round to hundredths ([#568](https://github.com/martinkrakowski/campaign-foundry/pull/568)). The
  `capability-race.test.ts` teardown flake was traced to a generate run leaking past its test into
  the next test's `OUTPUT_DIR`, and fixed ([#567](https://github.com/martinkrakowski/campaign-foundry/pull/567)). Recorded as fact, the way the
  asset-model plan recorded D161. It is the second time in two plans that a lane shipped ahead of
  its decision.
- **D165 — stamped** as recommended, and shipped as AF4 (#564). Review of #564 found one more
  reader of the new `template` error bucket, `StatusLine`'s section links, which is now fixed in
  that PR. The same function also ignored `treatments`, a gap older than this plan; #565 fixed it.
- **L3a — kept as is.** A restored draft carrying a retired layer kind still becomes the canonical
  template, silently, by the recorded L3a design. No lane.
- **D161 — stamped**, after the fact. The asset-model plan records it.

---

## 8. What review changed (r1 → r2)

Fable 5.1 reviewed r1 against `425e59e4`. Every point below was re-checked against the code before it
was accepted.

- **r1's H2 was false.** It said the compositor draws the headline at
  `LAYER_KIND_DEFAULT_RECTS["static-text"]`, calling it "the one table both renderers should read".
  The compositor places the headline by measured layout (`anchorFirstY`), and a frame only clips it.
  DoD 2 was untestable as written. It is now the band.
- **r1's D165 would have dropped work silently.** Refusing inside `layerLinkProblem` flips
  `isBriefTemplate`, which three web consumers treat as "discard". The refusal is now at the API
  and in `validate.ts`.
- **r1 called the draft path "not measured".** It was readable, and its behaviour is a recorded
  decision (L3a). It is now an owner question, not a lane's fix.
- **r1's DoD 6 grep and its `AF-` id check used `git grep -E "\b…"`**, which matches nothing on
  macOS, so both would have passed on any tree. Both now use `-P`.
- **r1's AF2 asserted a weight field that does not exist.** It now asserts `checks.size` and `bytes`.
- **Also taken:**
  - The click interception (H3) is new.
  - The font argument is now stated accurately: the family is named but not shipped.
  - `color: transparent` was replaced by visually-hidden text in a control.
  - AF4 and AF5's Owns columns were completed.
