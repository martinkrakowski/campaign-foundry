# The HTML Layer — Architecture & Development Plan

**Date:** 2026-09-10 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
**Verified against:** `main` at `f4f4d63`. **Owner's brief:** an HTML layer with tooling — add text,
add link, add button — and the ability to bring an existing campaign's styles into it.

---

## 0. What L6 already shipped — read this before the rest

**This plan is not new work. It is the remainder of lane L6**, and an earlier draft did not say so —
the same failure that retired three plans this week. What exists on `main` today:

| Piece | Where |
|---|---|
| `format: "html"` as a third family | `GeneratedAsset.ts`, `campaign-types.ts`, `PlatformProfile.vo.ts` |
| The `image-html` creative type, its compat table and `outputFamilies: ["html"]` | `creative-types.ts` |
| `canonical-image-html` carrying an **`{ id: "html", kind: "html" }` layer** | `creative-templates.ts` |
| `htmlBundlePath` and `htmlFallbackPath` on the asset **and** on `PackageableAsset` | `GeneratedAsset.ts`, `PackageForPlatformUseCase.use-case.ts` |
| `packageHtml` — reads bundle + fallback, writes both, **refuses an html asset with no fallback** | `PackageForPlatformUseCase.use-case.ts` |
| **A per-platform byte budget already enforced**: `bundle.length <= profile.maxBytes` | same file |
| The API boundary accepting `html` | `load-brief.ts`, `SUPPORTED_FORMATS` |

**And one thing that does not work today, found during review.** `GenerateCampaignUseCase` emits
`format: "static"` or `format: "motion"` and **never `"html"`**. So an `image-html` brief is accepted
at the boundary and **renders silently as a static row** — the same "silently produced the wrong
thing" shape as `short-video` before C3. **Recording it here as the current state**, because a plan
that does not know what the product does today is how the last three failed.

**What this changes about the decisions below.** **HL-D6's 150 KB constant is withdrawn** — a
per-platform `maxBytes` already exists and a second budget is the two-sources defect this arc exists
to remove. The build-time meter reads **that** number. And the lanes must populate **both**
`htmlBundlePath` and `htmlFallbackPath`, which is the contract `packageHtml` already checks.

## 0. The constraint that decides the whole design

**D122 already settles the hardest question, and it is not the one it looks like.**

> HTML assembles markup **server-side**, packages as an HTML unit, and **always carries a raster
> rendition** produced by the existing pipeline as its static fallback. **Markup is never rasterised.**

The reason recorded there: a headless browser buys one output family at the cost of a heavy
dependency and cross-platform pixel determinism — in a repo that has already proved fonts rasterise
differently on macOS and Linux.

**So the fallback image is not a screenshot of the ad. It is a second rendering of the same thing.**
And that forces the design:

> **Every element the HTML tooling can add must be expressible as something the canvas compositor can
> already draw.**

Otherwise the backup image and the live ad show different creatives — and in display advertising the
backup image is what a large share of placements actually serve. **One model, two renderers**, which
is the shape this codebase has spent its whole arc converging on.

**This is the single most important thing in this document.** A tooling design that ignores it
produces an HTML layer whose fallback is wrong, and nobody notices until a buyer complains.

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **HL-D1** | **The HTML layer holds *elements*, not layers.** An element is `{ kind, text?, href?, style?, frame }` — the tooling's "add text / add link / add button" produce elements inside one `html` layer. | **Pushback on the brief as stated.** "Add text layer" inside an HTML layer would create a second way to add text beside the existing `static-text` **layer kind**, addressed differently, drawn by a different path. That is the exact duplication this codebase spent a day removing (D121). One vocabulary for layers; a nested, narrower vocabulary for what lives inside an HTML unit. |
| **HL-D2** | **Element kinds are constrained to what both renderers can express**: `text`, `button`, `image`. A **link is not an element kind** — it is a property any element may carry. | A `<div>`-anything builder cannot have a faithful raster fallback. Constraining the vocabulary is what makes HL-D5 possible at all. |
| **HL-D3** | **The click destination is a first-class brief field, and it emits `clickTag`, not `href`.** | **There is no click destination anywhere in this codebase today** — I checked. That is a real gap for an advertising product: an ad that cannot be clicked is not an ad. And ad servers require the `clickTag` convention so the server can wrap and measure the click; an `<a href>` produces an ad that renders and does not track, which is the worst failure mode because it looks fine. |
| **HL-D4** | **Style comes from the brief's own `creative-style`, not from an importer.** | The brief already carries `fontFamily`, `fontWeight` and the product colours the editor sets. **"Import the campaign's styles" is already true** — they are in the brief. Building an importer would create a second style source beside `creative-style`, which D126 keeps as the single one until its own deprecation lane. Per-element overrides use the same optional-override shape as D134 props. |
| **HL-D5** | **The raster fallback is produced by the canvas compositor from the same element list**, not by rendering the markup — which means **HL3 adds an `html` entry to `LAYER_DRAWERS`.** | D122 forbids rasterising **markup**. It says nothing against the compositor drawing a *typed element list* natively, and the two are not the same thing. This matters concretely: `canonical-image-html` carries an `html` **layer**, and `drawLayer` throws on any kind absent from the table — so **the fallback render of an `image-html` brief is impossible without that entry.** An earlier draft of the finishing-video plan refused it; that refusal was wrong and is withdrawn. |
| **HL-D6** | **The weight budget is shown while building — and it is `profile.maxBytes`, not a new constant.** | A builder that lets a user assemble an over-budget unit and finds out at packaging has wasted their work. But `packageHtml` **already enforces `bundle.length <= profile.maxBytes`** per platform, so the number exists and varies by placement. Surfacing a second hard-coded 150 KB beside it would be two budgets disagreeing — the defect this arc exists to remove. **The meter reads the profile.** |
| **HL-D7** | **User-authored content is never rendered into the app's own DOM.** The editor preview is a sandboxed frame, or it is the canvas rendition. | Text and URLs a user types, assembled into markup and injected into the editor, is an XSS surface in the operator's own tool. |

---

## 1. Feedback on the brief as stated

**What is right.** A constrained element palette is the correct instinct for ad units — real HTML5
ad builders are deliberately narrow. And tying styles to the campaign is right, because ad units are
brand-locked artefacts, not free web pages.

**What I would change.**

1. **"Add text layer" should not be a layer.** HL-D1. The word "layer" already means something
   precise here, and a second meaning nested inside the first will produce two text vocabularies
   that drift.
2. **"Add link" should not be an element.** HL-D2/HL-D3. A link is a behaviour a text or button or
   image carries. As its own element it invites a bare `<a>` with no visual, and it hides the
   `clickTag` problem behind a familiar word.
3. **"Import styles" is already solved.** HL-D4. The campaign's styles are in the brief.

**What is missing, and matters for web advertising specifically.**

- **The click destination (HL-D3).** The most consequential gap. Nothing in this repo can express
  where an ad goes when clicked.
- **The backup image is an industry deliverable, not an implementation detail.** It should be named,
  visible in the editor, and reviewable — a buyer asks for it by name.
- **The weight budget (HL-D6)** surfaced live while building, reading the per-platform `maxBytes` that packaging already enforces.
- **Alt text**, which the backup image needs and which no current layer carries.
- **Animation belongs to keyframing, not to a second system.** If the HTML layer ever animates, the
  track model in `2026-09-10_keyframing.md` should drive both the CSS and the canvas —
  **one model, two renderers**, the same shape as the fallback. Building a separate CSS-animation
  editor would be a fourth motion vocabulary; the keyframing plan already refuses the third.

**What I would not build, at least not first.** Free-form CSS entry, arbitrary nesting, custom fonts
beyond the brief's family, and any third-party script. Each breaks either the fallback fidelity
(HL-D5) or the weight budget (HL-D6), and each is very hard to withdraw once shipped.

---

## 2. Lanes

| Lane | Task | Buys |
|---|---|---|
| **HL1** | **The element vocabulary and its validation.** `HtmlElement` value object, its per-kind fields, `frame` geometry reusing D130's shape, validation at the brief boundary. **No rendering.** | The contract both renderers read |
| **HL2** | **The click destination** (HL-D3) on the brief, validated as an absolute URL, with the `clickTag` emission rule stated. Independent of the rest and useful on its own. | An ad that can be clicked and measured |
| **HL3** | **The canvas rendition** — the compositor draws the element list, giving the backup image. **Before the markup**, so the fallback can never lag the ad. | HL-D5, and the ad-industry deliverable |
| **HL4** | **The markup assembler** — server-side, self-contained, `clickTag` wired, weight measured and refused over budget. | The HTML unit itself |
| **HL5** | **The editor tooling** — add text, add button, add image, set the destination, per-element style overrides, live weight meter, sandboxed preview. | What the owner asked for |

**Order.** HL1 → HL2 → **HL3 → HL4** → HL5. **HL3 before HL4 is the load-bearing choice**: build the
fallback first and the markup is written to match a rendering that already exists, rather than the
fallback being reverse-engineered from markup and quietly diverging.

**Blocked on:** `fill` and per-element frames want D130/D131 (L10/L11). HL1 and HL2 are not blocked.

**HL4 must also emit `format: "html"` from the generation path** — it does not today — and set both `htmlBundlePath` and `htmlFallbackPath`, which `packageHtml` already requires.

## 3. Definition of Done

- An `image-html` brief produces **both** an HTML unit and a backup image that a person would call
  the same creative.
- Every element the tooling can add appears in both. **A tool that can produce an element the canvas
  cannot draw is a defect, not a feature.**
- A unit over the weight budget is refused **while building**, naming the budget and the overage.
- The click destination reaches the packaged unit as a `clickTag`. **`packageHtml` already refuses an html asset with no fallback; the clickTag check is a change to that function, owned by HL4.**
- No user-authored string is ever rendered into the operator's own DOM.

## 4. What this plan refuses

- **A headless browser.** D122 settled it; HL-D5 is only achievable because HL-D2 constrains the
  vocabulary.
- **Free-form HTML or CSS entry.** It cannot have a faithful fallback and cannot be weight-bounded.
- **A second style source.** HL-D4.
- **A CSS animation editor.** If HTML animates, keyframing drives it.

---

## 5. Premises

Each lane states the claim that makes it necessary, as a script that exits 0 **while the gap is
still open**. `yarn plan:verify` runs them. **Probe the thing that decides, not a string near it.**

```premise HL1
# What decides HL1 is the brief boundary's element vocabulary: the layer
# shape in brief-template.ts / creative-templates.ts. The html layer carries
# nothing today (`html: []` in LAYER_PROPS is the props vocabulary — D134's
# lesson from X2), no element type exists anywhere in the domain, and no
# "elements" field exists at the boundary.
grep -q '^  html: \[\],' packages/CampaignOrchestration/src/domain/value-objects/brief-template.ts && ! grep -rqi "HtmlElement" packages/CampaignOrchestration/src && ! grep -rq '"elements"' packages/CampaignOrchestration/src apps/api/server
```

```premise HL2
# HL-D3's gap is "no click destination anywhere in this codebase". The thing
# that decides is a field for it under any sane identifier; today none
# exists — only prose ("the blocked click through the guard") and build
# caches, so the probe runs over source files and identifier shapes.
! grep -rqiE "clicktag|clickurl|clickdestination|clickthrough|landingurl|landingpage|destinationurl" packages apps tools --include='*.ts' --include='*.tsx'
```

```premise HL3
# Two sites decide HL3 and it changes both: the X6 boundary guard (#331)
# refuses image-html precisely because no renderer exists, and the fallback
# canvas rendition is impossible while `html` has no entry in the
# LAYER_DRAWERS table. Exit 0 requires the guard live AND the drawer absent;
# either landing flips it — the safe direction, since a guard still live
# with no drawer is exactly the state that makes this lane necessary.
grep -q '"image-html" is not supported' packages/CampaignOrchestration/src/application/use-cases/GenerateCampaignUseCase.use-case.ts && ! grep -qE '^  html: ' packages/CreativeGeneration/src/infrastructure/adapters/NodeCanvasCompositor.ts
```

```premise HL4
# What decides HL4 is the generation path emitting format "html" and setting
# htmlBundlePath — §2's explicit requirement, and the two fields packageHtml
# already checks. Today GenerateCampaignUseCase emits only static/motion and
# never names htmlBundlePath; the field existing in the entity type does not
# close this, only writing it there does.
! grep -qE 'format: "html"|htmlBundlePath' packages/CampaignOrchestration/src/application/use-cases/GenerateCampaignUseCase.use-case.ts
```

```premise HL5
# The tooling lane's deciding facts are the element palette and the live
# weight meter reading profile.maxBytes (HL-D6). maxBytes is enforced in
# Distribution today and reaches neither apps/web nor packages/ui; no element
# tooling exists either. When the drawer ships, the number it must display
# crosses into the web surface and this flips.
! grep -rqiE "maxBytes|weight.?meter|budget.?meter|addelement|element.?kind" apps/web/src packages/ui/src
```
