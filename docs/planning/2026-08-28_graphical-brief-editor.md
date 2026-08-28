# Graphical Brief Editor — Architecture & Development Plan

**Date:** 2026-08-28
**Status:** Revised v1.2 (v1.1 after a CodeRabbit sweep; v1.2 after an adversarial plan review: D9 seed retraction, D14 rewrite rule covers `inputAsset`, §4 merge order corrected — L2–L4 share three hot files and merge sequentially — and a cross-lane error-key gate. Q1 decided: seed all four, retractable. 18 decisions · 34 tasks · 7 lanes.) Synthesised from a first-time-user critique, an information-architecture audit, three competing designs scored by two judges, a dedicated Output-controls design with an adversarial verification, and a 52-message copy panel — all run against the live page and the domain code, 2026-08-27/28.
**Scope:** `apps/web` — the `/brief` editor end to end (sidebar, main column, action bar, every control, every message); `apps/api` — a `GET /campaigns/assets` listing route and a storage-port boundary ahead of the FS → S3 move; `packages/CampaignOrchestration` — two additive exports (`MOTION_FPS`, `DEFAULT_*`). No brief-schema change.
**Related:** `2026-08-26_unified-campaign-editor.md` (D1–D15 stay locked), `2026-08-27_motion-copy-timeline.md` (the copy timeline — planned, **not yet built**; this plan builds the ruler it needs), PRs #82 (field-shaped controls), #84 (AxisCard + CreativeGlyph), #85 (RatioPanel), #86 (draft migration hotfix), `DESIGN.md`.

---

## 0. The verdict this plan answers

> *"The warning and error messaging is NOT in the least human friendly … We keep missing the mark on the original inspiration html … The complex fields NEED TO BE simplified BY graphically driven selection panels … This screen has to be grade-school-simple."*

Measured, not felt: **clicking "Create new" shows eleven red errors before a single keystroke** (`ux-evidence/04-blank-brief-errors.txt`), six of them about two empty product cards the user did not ask for. The information-architecture audit found the page exposes **~30 controls and 5 readouts** for a brief that `VariationPolicy.fromBrief` needs **nine decisions** to build. Every other value already has a safe domain default. The screen is not too small for its job; it is showing the planner's job instead of the user's.

Eight directives were given during the review and are first-class here: **U1** mode toggle → sidebar top as graphical panels · **U2** Brief ID is not an input (a store key; FS → S3) · **U3** copy adjustable across the selected clip length · **U4** brand assets chosen from storage · **U5** Still/Video as two panels, one animating · **U6** motion kinds as panels that show the transition · **U7** duration as a draggable film strip · **U8** the action bar floats like the grid's pipeline bar.

## 0.1 Proposed Decisions

| ID | Decision | Consequence |
|----|----------|-------------|
| **D1** | **Nothing is red until the user has been there.** Validation keeps running on every change (D7's persistable/runnable computation is untouched) but *display* is gated by a page-level `touched: Set<fieldKey>` and an `attempted` flag, neither persisted. A field shows its error after blur, or after Apply/Save is pressed. Loading a file sets `attempted = true` so real file problems show at once. | A blank brief shows **zero** red. Section pills, ErrorStrip chips and inline lines all read from the same `visibleErrors = pick(errors, touched ∪ attempted)` map — one filter, so the three surfaces can never disagree (the verifier caught that gating only the paragraphs leaves the badge and strip red). |
| **D2** | **One voice, one file.** Every user-facing error, warning, hint and status string moves to `apps/web/src/components/campaign/messages.ts`, in the inspiration's shape *"<what is wrong> — <what to do>"*, naming the on-screen label. A test asserts no string contains `[`, `>=`, `×`, `variation.`, `coverage.`, `axis`, `draw`, `floor`, `package`, `planner`. | The 52 rewrites in Appendix A are a find-and-replace; the voice becomes enforceable rather than aspirational. House style goes into `DESIGN.md` §Copy. |
| **D3** | **The action bar speaks one progressive sentence and floats (U8).** A single `StatusLine` (role=status) replaces `applyNotice`, `persistError` and the estimate's echoed refusal: *New brief — fill Identity, Copy, Products and Output…* → *Almost there — fill Products…* (section names are scroll-and-focus links) → *Ready — Apply to run, or Save & apply to keep it* → *Applied — press Generate in the top bar to make trail-blaze-2026*. Apply/Save **stay enabled**; pressing with errors sets `attempted`, scrolls to the first, and the sentence refuses: *Not applied — 1 thing to fix in Identity.* The bar takes the grid CommandBar's idiom (`absolute bottom-6`, centred, `max-w-[800px]`, `rounded-xl shadow-2xl`) **scoped to the main column**, never over the sidebar (#79's bug). YAML split moves to a ⋯ overflow. | ErrorStrip chips stay (the reference has them) but count only visible errors. The four D11 chip states are preserved verbatim, emoji → token-coloured glyphs. `/new` no longer exists (D1 of the editor plan) so the directive applies to `/brief` only. |
| **D4** | **Mode is the first thing in the sidebar, as two pictures (U1).** A `ModePanel` pair on `AxisCard` at the top of the sidebar: *Classic* (a tidy 2×3 grid of near-identical creative glyphs) and *Randomized* (the same grid, scattered — different layouts, tones, tints). Names stay `brief`/`variation` for the reducer; captions read *Classic* / *Randomized* with one-line meta. | The main-column header loses the two text buttons. `setMode` is already non-destructive (D10), so this is placement plus a glyph. |
| **D5** | **Brief ID is a store key, not a field (U2).** Identity gets *Campaign name*; the id is derived live by the existing `slugify` and shown as a mono readout with a copy button (*"This is the brief id — made from the name"*). **One lifecycle for every identifier:** a *new* brief's name drives the id live until its first Save; a *loaded* brief's name and id are read-only and *Save as…* (D9) is the only rename — it writes a copy under the new name; a *product* id is derived from its name until the user touches it via the edit affordance (the existing `idTouched`), after which it is theirs. Appendix A's *"pick a different Brief ID"* becomes *"try a different campaign name"* for a new brief and *"use Save as… with a different name"* for a loaded one. | Two of the eleven blank-brief errors vanish. The slug rule and the *"used as the reload key"* sentence never reach the user. Prerequisite for S3: the id stops meaning *filename* (D15). |
| **D6** | **The policy is five things, then Advanced.** "05 Variety" in the sidebar shows, in order: **How many ads?** (Slider, readout as a sentence: *12 ads · up to 24 with your choices*), **Text placement** and **Look** (the existing glyph cards, captions *Top / Bottom*, *Bold / Soft*, legend *Choose all that apply — every tick is another way the ads can differ*, and a **reducer min-one guard** so the last card cannot be unticked), **Shapes** (the #85 ratio panels), and the **Estimate** sentence. **Advanced** (a `Disclosure`, closed by default, remembered per section) holds: *Repeat the exact same set next time* (seed row), *How different must any two ads be?* (min-distance as a bounded slider with word ticks *a little · some · very*), *Make sure nothing is left out* (both coverage steppers, **max clamped** to `floor(count / n)`), **Background** (three `PreviewCard`s *Pattern / Photo / AI-generated*), **Colour variety** (three `SwatchChip`s tinted from the first product's colour). | Keeps the layout cards the user praised and honours *"all selected is allowed"* — both judges' winning design kept multi-select; the min-one guard deletes four *Select at least one…* errors by construction and survives a 3-value axis. Palette shift keeps today's editor default `[0, 0.1, 0.2]` (no silent variety loss for a new brief) but moves out of the first-timer's sight. New-brief defaults for min-distance (2 → automatic 1) and coverage (1/1 → none) become the **domain's** defaults, so a fresh brief no longer looks stricter than the planner is. |
| **D7** | **Platforms drive defaults; the user's panels win; loading never rewrites.** The Output section leads with a `PlatformCard` grid (true-proportion frames, `PlatformProfile.label`). Toggling platforms **derives** formats and shapes as *defaults* — but Still/Video (U5) and the ratio panels (#85) remain the authorable controls. Rule: a derived value is applied only while the user has not overridden it; on load, if a stored `output.formats` or `axes.ratio` differs from what its platforms imply — **including the absent-key = all-three case, which diverges for the default static platforms** — the stored value is kept, an override flag is set, and the relevant Advanced/panel is opened so the override is visible on arrival. Pure helpers live in `derive.ts` (`platformsToFormats`, `platformsToRatios`, `clampPolicy`), with `formatsFor()` / `motionPackagedRatios()` exported from `Distribution` so the editor, `validate.ts` and the API share one implementation. | Closes the single most dangerous trap both judges flagged: a naive "sync ratios from platforms" would change `axisProductSize` and `policyHash` for every existing brief on its first click. A test round-trips the default brief byte-identically through a platform toggle-and-untoggle. The ratio exclusion becomes **one** amber line under the grid with an inline *[Add a photo platform]* button — never two paragraphs on the cards. |
| **D8** | **Still and Video are two panels; Video moves (U5).** `FormatPanel` on `AxisCard`: the same `CreativeGlyph` at rest (*still · one frame*) and looping a slow ken-burns-in (*clip · 30 fps · 2–30 s*), so the loop visibly ends on the exact still — the lesson of the pair. CSS keyframes only (`--duration-preview: 2400ms`, `--easing-preview` = the compositor's ease-out-cubic); `prefers-reduced-motion` and **disabled** both switch to `animation: none` and reveal an always-rendered `.glyph-cue` group (direction arrows) — never a frame frozen mid-zoom. Gates are `aria-describedby` descriptions, never red: *Video cannot be made on this computer right now — your brief is safe to save*. Multi-select stays (mixed is legal); the last card is **not** locked. | `CreativeGlyph` gains one optional `motion` prop (`data-motion`, three animated `<g>`s, cue group). Tailwind alpha modifiers don't work on this token scale — add `--color-brand-tint` tokens rather than `bg-brand-primary/15`. `MOTION_FPS` moves beside `MOTION_KINDS` so the meta line is never hard-coded. |
| **D9** | **Motion kinds are panels that perform their transition (U6).** `MotionKindPanel` × 4, each hosting the glyph with `motion={kind}`: ken-burns-in/out zoom the ground only (band and text stay, as the compositor does); headline-rise lifts and fades the text bars 12 %; **accent-wipe grows the soft fade beneath the band vertically** — not a horizontal band wipe, which the compositor never performs (verifier bug, fixed in spec). Meta lines and cues come from a `Record<MotionKind, …>` (a new kind is a compile error). Toggling Video **on** for a fresh draft seeds the domain defaults (all kinds, `duration: [6]`) so a novice never meets an empty grid; the empty state stays reachable. **The seed is retractable display of the default, not a choice:** while the user has not touched the motion or duration axis, toggling Video **off** retracts both, so on-then-off is identity for a fresh draft — the same discipline D7 applies to derived shapes, in session rather than on load. Once either axis has been edited it is the user's and stays. A fresh-draft Video on→off identity test (bytes, `axisProductSize`, `policyHash`) sits beside L4.1's corpus test. | The four *reduced-motion* cues are also the *disabled* cues, so a gated card keeps its information. |
| **D10** | **Duration is a film strip on a 0-based time axis (U7).** `DurationStrip`: a sprocketed band over a `repeat(31, 1fr)` grid for seconds 0…30 (columns 0–1 are hatched lead-in, since the minimum is 2 s), fill from 0 to each marker, tick labels at 2/5/10/15/20/25/30, a bead per length with a chip *5 s*. Drag snaps cell to cell; keyboard: ←/→ ±1, PgUp/PgDn ±5, Home/End, Delete removes. Each bead is `role="slider"` with `aria-valuenow/min/max/valuetext` and a **stable** name *Duration N (seconds)* (a slider's name must not change with its value). `slideToFree` guarantees distinct whole seconds, so two of the three duration errors are unreachable. A loaded out-of-range or fractional value is placed at `clamp(round(v))` with the raw value in its chip and the invalid border — never an invalid `gridColumn`. The last Remove stays enabled (an empty axis is legal; the planner defaults to 6 s). | The verifier's first spec drew a 2–30 *value* scale as if it were a 0–d *timeline* (a 2 s clip showed no reel); D10 fixes the axis. The strip is the **shared ruler** for U3 (D11). |
| **D11** | **The copy timeline (U3) is built on the same ruler, in the Copy section.** Per `2026-08-27_motion-copy-timeline.md` E5.2, the beat editor lives in Copy. It renders its own `DurationStrip` instance with `values` = the duration axis (read-only there) and a `lanes` slot carrying the proportion bar — beats stored as weights, **labelled in seconds for each length on the strip**, so a single 5 s length reads as a plain 5 s timeline. The D3 dwell floor re-checks on any axis change. | One primitive, two placements; no cross-section rendering. E1–E5 of the timeline plan are sequenced after D10 lands and are *not* duplicated here. |
| **D12** | **Products start as one card and never ask for an id or a path.** A new brief has **one** product card (Randomized needs one; Classic adds a second with a hint). Per card: *Name*; the id as a derived mono readout with an edit affordance; **colour as the 8-swatch picker + hex readout**; **logo as an upload tile → thumbnail**, with *Choose from bin* (D14) beside *Upload*; the path only as 10 px meta. `addProduct` assigns the next unused swatch. Untouched cards show nothing red. | Six of the eleven blank-brief errors disappear. Duplicate ids are still *flagged* after touch — never silently suffixed (a judge's fatal on Design 2). |
| **D13** | **Warnings are information; errors are fixes; nothing is both.** RED = a structural error on a touched field or after an attempt, and the refusal sentence. AMBER = *cannot run here / not used for video* — drawn once, on the control it concerns, never counted in pills or chips, never blocking Save (D7/D12 preserved). MUTED = derived readouts and clamp notices (*Lowered to 6 — that is every combination your choices allow*, shown once beside any control the reducer clamps). | The two five-line amber paragraphs on the ratio cards become one line under the grid. |
| **D14** | **Assets are chosen from the store (U4).** `GET /campaigns/assets?briefId=` lists what the store holds (name, type, size, thumbnail URL); an `AssetPickerDrawer` in the reference's row idiom (thumb · mono name · TYPE · size · ★ hero); the sidebar **Project Bin lists real files** (today it lists *products* labelled "assets"). | Same port as D15 underneath. **`Save as…` copies the brief's assets**: `AssetStorePort.copy(fromBriefId, toBriefId)` duplicates `assets/inputs/<from>/*` under the new id and rewrites **every** brief-scoped path on the copy — `logoPath` *and* `inputAsset` (`Product.ts:13`; the reuse-background flow), and any future asset field — by one rule: *a path that starts with `assets/inputs/<from>/` becomes `assets/inputs/<to>/…`; any other path (the shared demo assets at `assets/inputs/*.png`, which `sample-campaign-reuse.yaml` uses) is left exactly as it is.* Sharing would break the moment the original is deleted, moving would break the original. Tested end to end with an uploaded asset (L5.5). |
| **D15** | **A storage port before the S3 move (U2/U4).** `BriefStorePort` and `AssetStorePort` in `apps/api` with the current filesystem behaviour as the adapter. 18 files in `apps/api` call `node:fs` directly today (routes, `load-brief`, `pools`, `report`, `pipeline`); after this lane the swap to S3 is **one adapter**, not 18 edits. Brief id becomes a store key with no filename semantics. | Additive; no behaviour change. Own lane, can run in parallel with the UI lanes. |
| **D16** | **Deterministic product keys (P0).** `emptyProduct()`'s module counter differs between server and client, so `id="logo-upload-${product.key}"` mismatches and Next.js throws a hydration error on every `/brief` load; the same counter resets per session while persisted keys don't, so a restored 5-product draft plus one new product can collide and `removeProduct` deletes two. Keys become deterministic per draft (a counter *inside* `EditorState`, restored with it), and DOM ids use `useId()`. **The counter is derived, never assumed:** `ProductDraft.key` is not part of `CampaignBrief`, so `fromBrief()` seeds `nextProductKey = max(products.key) + 1` (1 for an empty list), and the #86 normalizer does the same for a pre-D16 localStorage draft that carries products but no counter — otherwise `addProduct` can reissue a restored key and `removeProduct` removes two. A pre-D16 fixture test covers both paths. | Ships first; every other lane's screenshots are clean after it. |
| **D17** | **Section numbering is derived from the visible sections.** Randomized: 01 Identity · 02 Copy · 03 Products · 04 Output in the main column, **05 Variety** on the sidebar accordion with the same numeral style and `ErrorPill`; Classic: 01–05 with Treatments as 04. | No 1-2-3-5 gap; the sidebar panel is visibly step five. |
| **D18** | **Every new control reads the domain, never a copy of it.** Labels, options and defaults come from `MOTION_KINDS`, `RATIO_VALUES`, `PlatformProfile.label`, `LAYOUT_OPTIONS`, `TONE_OPTIONS`, and new additive `DEFAULT_MOTION / DEFAULT_DURATION / DEFAULT_PALETTE_SHIFT / DEFAULT_BACKGROUND_SOURCES` exports from `VariationPolicy.vo.ts`. Display names (*Still images*, *Video*, *Square*, *Tall*, *Wide*) live in one `display-names.ts` map. | The #84/#85 lanes both duplicated a vocabulary once; this is the rule that stops it recurring. |

---

## 1. Context & Current State (verified 2026-08-27)

- **Eleven errors on a blank brief**, both modes, before any input: brief id (slug rule), region, audience, message, *"requires at least 2 unique products"*, and id/name/logo for each of two empty cards. No per-field touched tracking exists — only whole-draft `isPristine`.
- **Three error surfaces plus two status surfaces** render at once: inline `Field.error`, the accordion's *N issues* aside, the `ErrorStrip` chips, the `StatusChip`, and the apply notice. None distinguishes *not yet filled in* from *wrong*.
- **36 validator strings**, many in schema vocabulary: `variation.seed must be an integer in [0, 2^32)`, `coverage.perRatio 2 × 3 selected ratios exceeds count 5`, *"used as the reload key"*, *"path-safe slug"*.
- **`AxisToggles` renders six axes as identical text pills**; #84 replaced two with glyph cards (praised), #85 added ratio panels — whose exclusion paragraph renders **twice, in amber, five lines each, in a 320 px column**.
- **Policy sidebar exposes 13 controls** (count, seed, min distance, per-product, per-ratio + readout, 3 ratio panels, layout ×2, tone ×2, background ×3, palette ×3, headline pool) where the domain needs one (count) and defaults the rest.
- **Output**: formats and motion kinds are text pills; durations are a number box + *Remove* + *Add duration*; platforms are pills. The mode toggle is two text buttons in the main header.
- **Products**: colour is a hex text box; logo is a path text box with a secondary *Upload*; id is a free-text slug field. There is an upload route but **no asset listing route**; the sidebar *Project Bin* lists products.
- **Copy timeline**: `2026-08-27_motion-copy-timeline.md` is merged as a plan; **no code exists**.
- **Hydration error on every load**: `ProductsSection.tsx:107` renders `id={`logo-upload-${product.key}`}` from a module counter that differs server/client. The Next.js dev badge it produces sits exactly over the sidebar's *Create new* button in dev.
- **Storage**: briefs are `briefs/<id>.yaml` (`brief-files.ts:52`); 18 API files use `node:fs` directly; no port.

### Guiding Principles

1. **Ask the nine decisions; default the rest.** Count, name, region, audience, headline, one product (name + logo), platforms, and — optionally — whether text placement / look vary. Everything else has a domain default and lives under Advanced.
2. **Draw what the compositor draws.** Every visual choice is a miniature of the output (`CreativeGlyph`), not a word for it.
3. **Red is for what you touched.** A first-timer sees a to-do sentence, never a fault list.
4. **Make the invalid state unauthorable before you write its message.** Then write the message anyway, for loaded files.
5. **Derive as a default, never as a rewrite.** Loaded briefs keep what they say; the UI shows the override.

---

## 2. Analysis

### 2.1 Findings (critique panel: 7 blocking · 31 major · 12 minor; Output verifier: 6 bugs, 4 risks)

| # | Sev | Finding | → |
|---|-----|---------|---|
| **C1** | Critical | **Eleven red errors before any input.** Untouched fields are validated and displayed; a blank brief reads as eleven mistakes. | D1, D3, D12 |
| **C2** | Critical | **The one thing the user wants — square and tall — is the most punishing control.** Two of three ratio cards locked under identical five-line amber paragraphs; the fix (one click on *static* in section 5) is invisible. | D7, D13 |
| **C3** | Critical | **Brief ID and product ID are free-text slug fields** with slug-rule errors; the user is naming files. | D5, D12 |
| **C4** | Critical | **Logo is a filesystem path box.** | D12, D14 |
| **C5** | Critical | **Hydration mismatch on every load** from the product-key counter; the same counter can collide keys on a restored draft. | D16 |
| **C6** | Critical | **Load-time derivation trap.** Any "sync ratios/formats from platforms" rewrites existing briefs (absent `axes.ratio` = three ratios in the VO, two by derivation for the default platforms) — `axisProductSize` and `policyHash` change on first click. | D7 |
| **C7** | Critical | **Output-strip spec drew a 2–30 value scale as a 0–d timeline** (a 2 s clip showed no reel; beat lanes would be wrong at every duration). | D10 |
| **H1** | High | 36 messages in schema vocabulary and math notation. | D2, App. A |
| **H2** | High | Five surfaces show the same error; pills and chips are not gated the way inline text would be. | D1, D3 |
| **H3** | High | 13 policy controls, one required decision. | D6 |
| **H4** | High | Four "Select at least one X" errors exist only because an empty axis is authorable. | D6 (min-one guard) |
| **H5** | High | `perProduct × products ≤ count` and `perRatio × ratios ≤ count` are checked after the fact (or never, client-side). | D6 (clamped steppers) |
| **H6** | High | Mode toggle is two words in the header; nothing explains the difference. | D4 |
| **H7** | High | Formats / motion kinds / durations are text pills and a number box for values that are literally pictures and a length. | D8, D9, D10 |
| **H8** | High | Section numbering 1-2-3-5. | D17 |
| **H9** | High | Two lanes duplicated a domain vocabulary in the last wave. | D18 |
| **H10** | High | The Output design's accent-wipe preview animated a horizontal band wipe the compositor never performs. | D9 |
| **H11** | High | Locking the last duration's Remove made a legal brief state unreachable and broke an existing test. | D10 |
| **M1** | Med | Tailwind alpha modifiers (`bg-brand-primary/15`) emit nothing on this token scale. | D8 (tint tokens) |
| **M2** | Med | `MOTION_FPS` is not importable from `apps/web` (not in the package's export map). | D8 |
| **M3** | Med | `paused` animation on a gated card freezes mid-frame when the capability verdict lands asynchronously. | D8 (`animation: none` + cue) |
| **M4** | Med | Estimate panel prints `axisProductSize`, `feasible`, `genaiCalls`. | D6 (sentence) |
| **M5** | Med | Palette shift is `0 / 0.1 / 0.2` with no referent. | D6 (swatches) |
| **M6** | Med | The headline-pool axis shows `pool://copy`; a loaded brief with the axis on and no pool passes validation and fails at plan time. | D6 (SwitchRow, three states) |
| **M7** | Med | No asset listing route; Project Bin lists products. | D14 |
| **L1** | Low | Region and audience are free text with no examples. | D12 lane: `ChipGroup` + *Other…*, placeholders |
| **L2** | Low | Emoji in the status chip; `text-white` literals. | D3 |
| **L3** | Low | The Next.js dev badge covers *Create new* — dev only, not shipped. | note |

### 2.2 Where the judges disagreed, and the calls made here

| Question | User-advocate judge | Domain-engineer judge | **This plan** |
|---|---|---|---|
| Layout / tone control | three-state *Vary / Top / Bottom* cards | keep multi-select cards + min-one guard | **Multi-select + guard + legend** — the user praised the cards, said all-selected is allowed, and it survives a third value. |
| Colour variety | Advanced, default `[0]` | main list, keep `[0, 0.1, 0.2]` | **Advanced, keep `[0, 0.1, 0.2]`** — placement from one, default from the other; no silent variety loss. |
| Formats / shapes | derived readout from platforms | derived with explicit load rule | **Derived *defaults* + user panels (U5, #85) + load rule** — the directives require panels; the load rule prevents the rewrite. |
| ErrorStrip | keep | keep | **Keep, visible-only.** Design 2's deletion was scored fatal by both. |

### 2.3 What is *not* taken from the panel

- Design 2's chip states (*New / Not applied yet / Applied / Changed since apply*) — collapses D11's two *applied* states. D11's four labels stay.
- Auto-suffixing duplicate product ids with `-2` — a derived value that surprises. Flag after touch instead.
- Cutting the platform/format compatibility rules while still allowing a formats override — the API would become the first voice.
- Seeding `[5]` **and** locking the last Remove — seeding stays (domain default `[6]`), the lock goes.

---

## 3. Target Design

### 3.1 The first-time experience (the DoD's north star)

She clicks **Create new**. Zero red. The sidebar shows two pictures — *Classic* and *Randomized* — with Randomized lit; below it *Campaign Brief*, *Project Bin*, and **05 Variety** with no pill. The main column reads 01 Identity · 02 Copy · 03 Products · 04 Output; the floating bar says *New brief — fill Identity, Copy, Products and Output to make it runnable.* She types a campaign name and watches *trail-blaze-2026* appear beneath it in mono. She taps *DE*. She types who it is for (the placeholder shows an example). She types a headline (a soft *17 / 60* counter). One product card: a name, an orange swatch, a dashed *Upload logo* tile that becomes a thumbnail. In Output she taps *Instagram Feed* (a square frame) and *Instagram Story* (a tall one); *Still images* lights; the shapes line under the grid reads *Square and Tall — from your platforms*. The bar now says *Almost there — fill Products to make it runnable*, then *Ready — Apply to run, or Save & apply to keep it.* She never opens Advanced. Had she pressed Apply with the audience empty, the only red on the page is that one line — *No audience yet — say who the ads are for, like urban outdoor enthusiasts, 25-40* — a *1* pill on 01 Identity, one strip chip, and *Not applied — 1 thing to fix in Identity.*

### 3.2 Sidebar (top to bottom)

`ModePanel` ×2 (D4) · **Campaign Brief** accordion (name, derived id + copy, region, status chip) · **Project Bin** (real assets, D14) · **05 Variety** (D6) · footer *Create new* / *Browse briefs*.

### 3.3 Main column

**01 Identity** — Campaign name → derived id readout · Region `ChipGroup` (GLOBAL EU DE UK US APAC · *Other…*) · Audience with placeholder.
**02 Copy** — *Headline* + counter · *Localized headline (optional)* · *Extra headlines…* ghost → drawer · **Timeline** sub-panel (D11; lands with the timeline plan).
**03 Products** — one card; name · derived id · swatch picker · logo tile (Upload / Choose from bin) · *Add product*.
**04 Output** — `ProbeRow` (*ffmpeg · found · 6.1*, with *probing…*) · **Where will the ads run?** `PlatformCard` grid · **Formats** `FormatPanel` ×2 · **Video** block (rail-indented, only while Video is on): `MotionKindPanel` ×4 · **Clip lengths** `DurationStrip` · one amber line for any exclusion with *[Add a photo platform]* · Advanced: formats/shapes override.
**Floating bar** — `ErrorStrip` (visible errors) · `StatusLine` · *Discard* · *Apply to run* · *Save ▾* · ⋯ (YAML split).

### 3.4 New primitives (kit, `apps/web/src/components/ui`)

`ModePanel` · `ChipGroup` (pick-one / multi with optional min-one guard) · `SwatchPicker` / `SwatchChip` · `PlatformCard` · `PreviewCard` · `Disclosure` · `SwitchRow` · `ErrorPill` · `DurationStrip` (+ pure `slideToFree`, `secondsAtClientX`, `keyToTarget`) · `CreativeGlyph` gains `motion?` · `AxisCard` gains `descriptionIcon?`. Campaign-level: `FormatPanel`, `MotionKindPanel`, `PreviewFrame`, `StatusLine`, `ShapeReadout`, `ProbeRow`, `LogoField`, `AssetPickerDrawer`, `messages.ts`, `display-names.ts`, `derive.ts`, `error-sections.ts`.

### 3.5 Tokens & CSS

`--duration-preview: 2400ms`, `--easing-preview: cubic-bezier(0.33, 1, 0.68, 1)`, `--color-brand-tint` (15 %) and `--color-brand-rail` (40 %) as explicit tokens; keyframes per motion kind in `globals.css` keyed by `[data-motion]`; two separate rules with the same body — `@media (prefers-reduced-motion: reduce) { .glyph-anim { animation: none } .glyph-cue { display: block } }` and `button:disabled .glyph-anim { animation: none } button:disabled .glyph-cue { display: block }` — a pseudo-class is not a media feature and cannot sit in a media prelude.

---

## 4. Work Breakdown — lanes and file ownership

**Merge order:** L0 → L1 → ( L5 ‖ L2 → L3 → L4 ) → L6. Only L5 is genuinely disjoint (it lives in `apps/api`). L2, L3 and L4 all own parts of three **hot files** — `editor-state.ts` (L0.1, L0.2, L2.2, L2.3, L3.1, L3.4, L4.1, L4.5), `PolicySection.tsx` (L2.2–2.4, L4.7) and `page.tsx` (L1.1, L1.4, L2.1) — so they may be *implemented* in parallel worktrees but **merge in that declared order**, each refreshing from `main` before its review. `DESIGN.md` and `messages.ts` are appended by several lanes and join the merge script's append-only list. **Cross-lane gate:** every error key a lane introduces must be covered by L1's `touched`/`visibleErrors` map and `error-sections.ts`, or C1 regresses (an ungated red line) or the error never shows; L1.1 ships a test asserting that the set of keys `validateState` can emit ⊆ the keys the visibility filter knows, and every later lane keeps it green.

### L0 — P0 correctness (ships first)

| # | Task | Owns |
|---|------|------|
| L0.1 | Deterministic product keys: a per-draft counter inside `EditorState` (restored with the draft); DOM ids via `useId()`; hydration warning gone | `editor-state.ts` (products only), `ProductsSection.tsx` (ids only) |
| L0.2 | `fromBrief` and `normalizeDraftState` seed the counter from `max(products.key) + 1`; a pre-D16 draft fixture (products, no counter) restores and `addProduct` never reissues a key | `editor-state.ts` (fromBrief, normalizeDraftState) |
| L0.3 | Test: SSR/CSR render of a fresh brief produces identical markup; a restored 5-product draft plus `addProduct` never collides; `removeProduct` removes one | `__tests__/` |

### L1 — Error model, copy, action bar (D1, D2, D3, D13, D17)

| # | Task | Owns |
|---|------|------|
| L1.1 | `touched` / `attempted` at page level; `visibleErrors` filter; `touch` on blur; `attempted` on Apply/Save/load; **coverage test:** every key `validateState` can emit is known to the visibility filter (fails when a later lane adds an error without registering its field) | `page.tsx` (state + bar), `IdentitySection.tsx` (`Field`) |
| L1.2 | `messages.ts` with every string from Appendix A; jargon test; `display-names.ts`. **Formatters receive display labels, never raw values**: every template that interpolates a format, ratio, platform id or candidate list (`platforms.incompatible`, `formats.unsupported`, `ratio.excluded.*`, `readout.ratioFloor`) is called with `displayName(value)`, and the message test asserts on *rendered* output — no `static`, `motion`, `9:16` or `instagram-feed` may appear in a rendered string | new files, `validate.ts` (strings only) |
| L1.3 | `StatusLine` progressive sentence; Apply/Save stay enabled, spoken refusal, scroll-to-first; `ErrorPill`; `ErrorStrip` visible-only; `error-sections.ts` shared map | `StatusLine.tsx`, `ErrorStrip.tsx`, `ui/error-pill.tsx`, `StatusChip.tsx` (glyphs) |
| L1.4 | **Floating bar (U8)**: CommandBar idiom scoped to the main column; YAML split → ⋯ | `page.tsx` (bar region), `SaveMenu.tsx` |
| L1.5 | Derived section numbering; `SectionShell` takes `ErrorPill` | `IdentitySection.tsx` (`SectionShell`), `sections/index.ts` |
| L1.6 | `DESIGN.md`: §Copy house style (Appendix B), `StatusLine`, `ErrorPill`, tone rules | `DESIGN.md` |

### L2 — Sidebar: mode panels and Variety (D4, D6, D18)

| # | Task | Owns |
|---|------|------|
| L2.1 | `ModePanel` ×2 at the top of the sidebar; header toggle removed | `ui/mode-panel.tsx`, `shell/Sidebar.tsx`, `page.tsx` (header only) |
| L2.2 | Count slider sentence readout; reducer **clamps** count to `axisProductSize` and emits the one-time *Lowered to N* notice | `PolicySection.tsx`, `editor-state.ts` (count/clamp), `validate.ts` (`axisProductSize` reuse) |
| L2.3 | Layout/Tone: captions, legend, **reducer min-one guard**; `CreativeGlyph` tone contrast exaggerated so cards differ at 46 px | `PolicySection.tsx`, `editor-state.ts` (toggleLayout/Tone), `ui/creative-glyph.tsx` (tone only) |
| L2.4 | `Disclosure` (Advanced, remembered); seed row; min-distance word slider; coverage steppers with clamped max; `PreviewCard` backgrounds; `SwatchChip` colour variety; `SwitchRow` headline pool with three states | `ui/disclosure.tsx`, `ui/preview-card.tsx`, `ui/swatch-chip.tsx`, `ui/switch-row.tsx`, `PolicySection.tsx` |
| L2.5 | Estimate as a sentence (*You will get 12 ads — 6 square, 6 tall — for 2 products. No AI image calls.*) | `EstimatePanel.tsx` |
| L2.6 | `DEFAULT_MOTION / DEFAULT_DURATION / DEFAULT_PALETTE_SHIFT / DEFAULT_BACKGROUND_SOURCES` exported from the VO (additive) | `VariationPolicy.vo.ts`, barrel |
| L2.7 | `DESIGN.md` §4 entries | `DESIGN.md` |

### L3 — Identity, Copy, Products (D5, D12)

| # | Task | Owns |
|---|------|------|
| L3.1 | Campaign name → derived id readout + copy; read-only for loaded briefs | `IdentitySection.tsx`, `editor-state.ts` (briefId derivation) |
| L3.2 | `ChipGroup` region + *Other…*; audience placeholder | `ui/chip-group.tsx`, `IdentitySection.tsx` |
| L3.3 | Copy: *Headline* + counter, *Localized headline*, *Extra headlines…* ghost; a slot for the timeline sub-panel | `CopySection.tsx` |
| L3.4 | Products: one card on new; derived id readout; `SwatchPicker`; `LogoField` (tile → thumbnail; *Upload* / *Choose from bin*); `addProduct` next unused swatch; Classic adds a second card with a hint | `ui/swatch-picker.tsx`, `LogoField.tsx`, `ProductsSection.tsx`, `editor-state.ts` (products) |
| L3.5 | `DESIGN.md` §4 entries | `DESIGN.md` |

### L4 — Output: platforms, formats, motion, film strip (D7, D8, D9, D10)

| # | Task | Owns |
|---|------|------|
| L4.1 | `derive.ts` (`platformsToFormats`, `platformsToRatios`, `clampPolicy`); `formatsFor()` / `motionPackagedRatios()` exported from `Distribution`; **load-time override rule** + flags; **round-trip test over the whole corpus**: every `briefs/*.yaml` on `main` is loaded, toggled through a platform on-and-off, and asserted byte-identical with unchanged `axisProductSize` and `policyHash` — plus three synthetic fixtures for a stored formats override, a stored ratio override, and the absent-key case, since one default brief cannot cover them | `derive.ts`, `editor-state.ts` (formats/ratio/platform reducers), `Distribution` barrel |
| L4.2 | `PlatformCard` grid with `PlatformProfile.label`; `ProbeRow` (+ optional additive `version` on `GET /campaigns/capabilities`) | `ui/platform-card.tsx`, `ProbeRow.tsx`, `OutputSection.tsx`, `capabilities.get.ts` |
| L4.3 | `CreativeGlyph.motion` (three animated groups + always-rendered cue group; fade layer for accent-wipe); keyframes; tint/rail tokens; `MOTION_FPS` beside `MOTION_KINDS` | `ui/creative-glyph.tsx` (motion), `tokens.css`, `globals.css`, `tailwind.config.ts`, `MotionKind.vo.ts` |
| L4.4 | `FormatPanel` ×2 with `formatGate()`; `AxisCard.descriptionIcon`; per-card gating replaces blanket `motionOff` (inverting the three `brief-editor.test.tsx` assertions that asserted the old behaviour — they are corrections, stated as such) | `FormatPanel.tsx`, `PreviewFrame.tsx`, `ui/axis-card.tsx`, `OutputSection.tsx` |
| L4.5 | `MotionKindPanel` ×4; fresh-draft seeding of domain defaults on Video-on, **retracted on Video-off while untouched** (D9); fresh-draft on→off identity test | `MotionKindPanel.tsx`, `editor-state.ts` (toggleFormat seed) |
| L4.6 | `DurationStrip` on a 0-based 31-column axis; pure helpers; keyboard; clamp-placed loaded values; empty-reel click adds; last Remove enabled; `lanes` slot | `ui/duration-strip.tsx`, `OutputSection.tsx` |
| L4.7 | One amber exclusion line with *[Add a photo platform]*; `RatioPanel` loses its paragraph | `OutputSection.tsx`, `RatioPanel.tsx`, `PolicySection.tsx` (shapes hint) |
| L4.8 | `DESIGN.md` §2 motion tokens, §4 entries | `DESIGN.md` |

### L5 — Storage port and asset picker (D14, D15)

| # | Task | Owns |
|---|------|------|
| L5.1 | `BriefStorePort` + `FsBriefStore`; `AssetStorePort` + `FsAssetStore`; the 18 `node:fs` call sites go through them | `apps/api/server/lib/ports/*`, `brief-files.ts`, `asset-files.ts`, `load-brief.ts` (read path), routes |
| L5.2 | `GET /campaigns/assets?briefId=` (name, type, size, thumbnail URL) | `routes/campaigns/assets.get.ts` |
| L5.3 | `AssetPickerDrawer`; `briefs-api.ts` client; Project Bin lists real files | `AssetPickerDrawer.tsx`, `lib/briefs-api.ts`, `shell/Sidebar.tsx` (bin) |
| L5.4 | `.agents/architecture.md`: the port boundary and the S3 adapter's shape | `.agents/architecture.md` |
| L5.5 | `AssetStorePort.copy(from, to)`; *Save as…* and the duplicate route copy the brief's assets and rewrite every `assets/inputs/<from>/…` path (`logoPath`, `inputAsset`) while leaving shared root assets untouched; end-to-end test with an uploaded logo *and* an uploaded background, plus the reuse brief whose root-level `inputAsset` must survive unchanged | `briefs.post.ts`, `briefs/[id]/duplicate.post.ts`, `asset-files.ts` |

### L6 — Copy timeline (D11 · U3)

Execute `2026-08-27_motion-copy-timeline.md` E1–E5 **after L4.6**, with one amendment: E5.2/E5.3 render the beat editor and proportion bar on a `DurationStrip` instance in Copy (`lanes` slot), values from the duration axis.

---

## 5. Definition of Done

- **Blank brief = zero red.** A test renders *Create new* in both modes and asserts no `text-error` element, no pill, no strip chip, and the *New brief —* sentence.
- **Every string passes the jargon test** in `messages.ts`; every current string in Appendix A is replaced (grep proves none remain).
- **Accessible names are unchanged**: `getByRole("button", { name: "headline-top" | "bold" | "1:1" | "static" | "motion" | "ken-burns-in" })` and the mode/platform names all resolve; the duration beads are `role="slider"` with stable names.
- **No existing brief changes behaviour**: `briefs/*.yaml` on `main` each load, round-trip through a platform toggle-and-untoggle, and serialise byte-identically; `axisProductSize` and `policyHash` are unchanged for every fixture.
- **The four D11 chip states** render with their exact meanings; Apply/Save are never disabled; the refusal sentence names the section.
- **The hydration warning is gone** on `/brief` (a test compares SSR and CSR markup of a fresh brief).
- **Reduced motion and disabled** both show the cue glyphs; no `paused` animation anywhere.
- **The film strip**: a 2 s clip shows a 2-cell reel from 0; `[45, 2.5]` loads without an invalid `gridColumn`; `slideToFree` never produces a duplicate; the last Remove works.
- **The sidebar still lays out at 320 px** with the mode panels, five Variety items and Advanced closed.
- **Gate**: `build`, `typecheck`, `lint` 0 problems, `lint:arch`, `sync:check` 0 ops, `test:cov` 100 % on all four counters; no test deleted without a stated reason in the PR.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| New-brief defaults for min-distance and coverage change from the editor's `2 / 1 / 1` to the domain's `1 / 0 / 0`; a fresh brief saved by the new editor differs from one saved today. | Stated in DESIGN.md and the session log; existing files are untouched (the load rule keeps stored values); the estimate sentence shows the effect. |
| Touched-gating means a user who never blurs and never presses sees no red at all. | The progressive sentence carries the to-do list; Apply reveals everything at once with a scroll-to-first. |
| Four looping previews may read as noisy. | 2.4 s cycle, ease-out with a hold; pause-on-hover is one CSS rule away if review says so (Q3). |
| `DESIGN.md` and `messages.ts` are touched by four lanes. | Append-only in `merge-prs.sh`; sequential merge order above. |
| The load-time override rule is the one place a silent rewrite could hide. | Byte-identical fixture round-trip test in L4.1 is a merge gate, not a nice-to-have. |
| Two prior lanes duplicated a vocabulary. | D18 is a review checklist item: *grep for a second copy of every option list you touched*. |

---

## 7. Open Questions

- **Q1 — Seed a motion kind on Video-on?** **Decided: yes, all four, retractable** (D9). `DEFAULT_MOTION = MOTION_KINDS` (`VariationPolicy.vo.ts:40`) and `DEFAULT_DURATION = [6]` (`:42`) — the seed shows what the planner already does for an absent axis; retraction on Video-off keeps a toggle an identity.
- **Q2 — Heading voice**: *Clip lengths* (novice) vs *Durations (seconds)* (schema). Recommendation: **Clip lengths** as the heading, the schema name as the `aria-label` group name only.
- **Q3 — Continuous preview loops vs on hover/selected.** Recommendation: **continuous, slow**; revisit after the first screenshots.
- **Q4 — Region chips**: the reference's six (GLOBAL EU DE UK US APAC) plus *Other…*, or a country list? Recommendation: the six plus *Other…*; the schema stays a free string.

---

## Appendix A — Message rewrites (find-and-replace; three implementation notes follow)

Notes from the copy editor: (1) `status.applyRefusal` currently reuses `motionUnavailableReason()` and needs its own string; (2) `readout.ratioFloor` is JSX text, not a template; (3) the template rows below still show raw interpolations (`${profile.id}`, `${format}`, `${candidates}`) because they are a find-and-replace on today's code — L1.2 requires the *formatter* to receive display labels, and its test asserts on rendered output, so no raw id, format or ratio value ever reaches the user.

| key | now | **new** |
|---|---|---|
| `briefId` | Lowercase letters, digits and hyphens only (max 64) — used as the reload key. | **Brief ID can only use small letters, numbers and dashes — try something like summer-launch.** |
| `briefId.duplicate` | A brief with id "${conflictingId}" already exists. | **A brief called ${conflictingId} already exists — pick a different Brief ID.** |
| `targetRegion` | Target region is required. | **No region yet — pick one of the region chips.** |
| `targetAudience` | Target audience is required. | **No audience yet — tell us who this campaign is for.** |
| `campaignMessage` | Campaign message is required. | **No message yet — write the one line you want people to remember.** |
| `products` | A ${mode} campaign requires at least ${min} unique product${s}. | **A ${mode} campaign needs ${min === 1 ? "at least one product" : "two different products"} — add ${min === 1 ? "one" : "a second one"} below.** |
| `product-N-id` | Product id must be a path-safe slug (lowercase letters, digits, hyphens; max 64). | **Product ID can only use small letters, numbers and dashes — try something like acrobat-pro.** |
| `product-N-id.duplicate` | Duplicate product id "${product.id}". | **Two products share the ID ${product.id} — give this one its own.** |
| `product-N-name` | Name is required. | **This product has no name yet — type one in.** |
| `product-N-color` | Colour must be a 6-digit hex value (e.g. #1473E6). | **That colour is not one we can read — pick it with the swatch, or type one like #1473E6.** |
| `product-N-logo` | Logo path is required (upload or enter a path). | **No logo yet — upload one with the Logo button.** |
| `treatment-N-id` | Treatment id must be a path-safe slug (lowercase letters, digits, hyphens; max 64). | **Treatment ID can only use small letters, numbers and dashes — try something like bold-hero.** |
| `treatment-N-id.duplicate` | Duplicate treatment id "${treatment.id}". | **Two treatments share the ID ${treatment.id} — give this one its own.** |
| `treatment-N-layout` | Invalid layout. Choose from: ${LAYOUT_OPTIONS.join(", ")}. | **That layout is not one of the choices — pick one in the Layout panel.** |
| `treatment-N-tone` | Invalid tone. Choose from: ${TONE_OPTIONS.join(", ")}. | **That tone is not one of the choices — pick one in the Tone panel.** |
| `count` | variation.count must be an integer >= 1. | **Count is empty — set it to 1 or more with the Count slider.** |
| `seed` | variation.seed must be an integer in [0, 2^32). | **Seed needs a whole number — press Random, or leave it blank.** |
| `minDistance` | variation.minDistance must be an integer in [0, ${maxDistance}] (the active axes). | **Min distance can be 0 to ${maxDistance} right now — move the Min distance slider back into that range.** |
| `perProduct` | coverage.perProduct must be an integer >= 0. | **Coverage per product needs a whole number — set it with the stepper, or leave it blank.** |
| `perRatio` | coverage.perRatio must be an integer >= 0. | **Coverage per ratio needs a whole number — set it with the stepper, or leave it blank.** |
| `perRatio.exceeds` | coverage.perRatio ${floor} × ${drawableCount} selected ratios exceeds count ${count} — lower the floor, raise the count, or select fewer ratios. | **${drawableCount} ratios at ${floor} each need more creatives than your Count of ${count} — raise Count, or lower Coverage per ratio.** |
| `ratio` | Select at least one aspect ratio. | **No aspect ratio picked — tap at least one shape.** |
| `ratio.noneDrawable.packaged` | None of the selected ratios can be drawn: motion-only output can draw [${packaged.join(", ")}] only — select one of those, or add the static format. | **Video only comes in ${packaged.join(", ")} for these platforms — pick one of those shapes, or turn on Still images too.** |
| `ratio.noneDrawable.none` | None of the selected ratios can be drawn: no selected platform packages motion at any ratio — add the static format, or a platform that packages motion. | **None of your platforms play video — turn on Still images, or add a platform that does.** |
| `ratio.excluded.packaged` | Excluded — motion-only output can draw [${motionRatios.join(", ")}] only; add the static format to draw this ratio. | **Not used for video — it only comes in ${motionRatios.join(", ")}. Turn on Still images to use this shape too.** |
| `ratio.excluded.none` | Excluded — no selected platform packages motion at any ratio; add the static format to draw this ratio. | **Not used for video — none of your platforms play video. Turn on Still images to use this shape.** |
| `layout` | Select at least one layout. | **No layout picked — tap at least one layout card; you can pick them all.** |
| `tone` | Select at least one tone. | **No tone picked — tap at least one tone card; Bold and Subtle can both be on.** |
| `background` | Select at least one background source. | **No background picked — tap at least one background card.** |
| `paletteShift` | Select at least one palette shift. | **No colour mood picked — tap at least one colour card.** |
| `formats` | Select at least one format. | **Nothing to make yet — turn on Still images, Video, or both.** |
| `platforms` | Select at least one platform. | **No platform picked yet — choose where these creatives will go.** |
| `platforms.incompatible` | "${profile.id}" only packages ${profile.formats.join(" or ")} — request that format, or remove the platform. | **${profile.id} only takes ${profile.formats.join(" or ")} — turn that on under Formats, or take the platform off.** |
| `formats.unsupported` | No selected platform packages "${format}" — add one of: ${candidates.join(", ")}. | **None of your platforms can take ${format} — add one of ${candidates.join(", ")}, or turn ${format} off.** |
| `formats.motionUnavailable` | Motion format is not available: ${state.capabilities.reason ?? "capability off"}. | **Video cannot be made on this computer right now — your brief is safe to save and will run once video is set up.** |
| `formats.motionNeedsRandomized` | Motion output requires a randomized campaign — switch the mode to Randomized. | **Video only works in a Randomized campaign — switch the mode toggle to Randomized, or turn Video off.** |
| `motion` | Select at least one motion kind. | **No video style picked — tap at least one video card.** |
| `duration` | Add at least one duration. | **No clip length yet — add one with the stepper, like 6 seconds.** |
| `duration.range` | Durations must be whole seconds between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC}. | **Clip lengths must be whole seconds from ${MIN_DURATION_SEC} to ${MAX_DURATION_SEC} — change the one outside that range.** |
| `duration.duplicate` | Each duration must be distinct — the planner draws each length once. | **Two clip lengths are the same — remove one of them.** |
| `status.applied` | Applied — Generate in the top bar will run "${state.briefId}". | **Applied — press Generate in the top bar to make ${state.briefId}.** |
| `status.applyRefusal` | (uses formats.motionUnavailable text) | **Applied, but video cannot be made on this computer right now — Generate will wait until it is set up.** |
| `status.leavePrompt` | You have unsaved changes. Are you sure you want to leave? | **You have changes that are not saved yet — leave anyway?** |
| `status.saveFailed` | Save failed | **Could not save — try Save again.** |
| `status.saveAsFailed` | Save as failed | **Could not save the copy — try Save as again.** |
| `hint.count` | How many creatives to draw — at most ${axisMax} from these axes | **How many creatives to make — up to ${axisMax} with what you have picked** |
| `hint.minDistance` | How many axes any two creatives must differ in — up to ${maxMinDistance(state)}, the active axes | **How different any two creatives must be — 0 means any two can match, ${maxMinDistance(state)} means they differ in everything** |
| `hint.seed` | Fixes the draw, so the same brief plans the same creatives | **Optional — keep the same number to get the same set of creatives every time** |
| `hint.perRatio` | Fewest creatives each aspect ratio must get | **Optional — make sure every shape gets at least this many** |
| `hint.perProduct` | Fewest creatives each product must get | **Optional — make sure every product gets at least this many** |
| `readout.ratioFloor` | floor ${floor} × ${drawable.length} selected = ${ratioFloorTotal} of count ${count}${over ? " — lower the floor, raise the count, or select fewer ratios" : ""} | **${drawable.length} shapes at ${floor} each use ${ratioFloorTotal} of your ${count} creatives${over ? " — that is too many; raise Count, or lower this" : ""}** |
| `readout.ratioFloor.unset` | No floor | **Any amount** |

## Appendix B — House style for copy (→ `DESIGN.md`)

1. Shape: '<what is missing or wrong> — <the one thing to do>'. One em dash, at most two clauses, never a parenthesis.
2. Name the control the user will touch, using its on-screen label exactly (Count, Min distance, Coverage per ratio, Brief ID, the Layout panel, the Random button). Never a YAML path or a config key.
3. Say things a ten-year-old reads: small letters, numbers, dashes, shapes, Still images, Video, clip length, how many. No 'integer', 'hex', 'slug', 'enum', 'format' as a noun where 'Still images/Video' will do.
4. Never the pipeline's words: planner, parser, API, axis/axes, draw, floor, ship, package, run as a noun, capability. The user makes creatives; we make them for them.
5. No maths: no '>=', '×', '=', ranges in brackets, powers. Write 'set it to 1 or more', 'from 2 to 30', 'use 6 of your 12 creatives'.
6. Empty fields on a new brief are to-dos, not faults: lead with 'No X yet' / 'Nothing to make yet', never 'X is required' or 'Invalid X'.
7. Warnings are information, never blame, and always say the data is safe: 'Not used for video — …', 'Video cannot be made on this computer right now — your brief is safe to save'. Never 'Excluded', 'skips', 'refused'.
8. Offer at most two remedies, and name them by control: 'raise Count, or lower Coverage per ratio'. If three would fit, cut the least likely one.
9. Examples are real and on-brand (summer-launch, acrobat-pro, bold-hero, #1473E6, 6 seconds), introduced with 'like' or 'try something like', never 'e.g.' and never a raw platform id.
10. Status lines keep the chip's word first (Applied, Saved, Not applied) so the strip and the chip agree, then say what to press next: 'Applied — press Generate in the top bar to make summer-launch.'
