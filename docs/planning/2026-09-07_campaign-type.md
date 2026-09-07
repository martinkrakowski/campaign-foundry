# Campaign Type — Architecture & Development Plan

**Date:** 2026-09-07
**Author:** orchestrator
**Status:** draft — for the owner's review
**Verified against:** `main` at `6217632`
**Decision ids introduced:** D108 – D112
**Supersedes:** **D97** of `2026-09-07_two-field-create.md` — the create dialog's second field is the
**campaign type**, not the campaign mode. Everything else in that plan stands; lane **S1** is
re-briefed against this one.
**Relates to:** D99 (a classic brief never carries motion), D94/D95 (regions), **C3** of the
recomposition plan (the template rail, declined for "no template concept") — this plan is the
concept it lacked.

---

## 0. What this plan answers

The owner stated the product's market: **online static and video ads**, and **social-media posts,
static and video** — and asked for the create dialog's second field to be the campaign *type*, and
whether a quick-win third type exists.

**The finding that shapes the answer.** The domain has seven platform profiles and every one of
them is social:

| Static, `1:1` / `16:9` | Motion, all `9:16` |
|---|---|
| `instagram-feed`, `linkedin`, `x` | `instagram-story`, `instagram-reel`, `tiktok`, `youtube-short` |

There is no display placement, no IAB size, no ad network. So of the owner's two markets, **social
posts are what the platform set already is**, **paid social is a preset over the same platforms**,
and **display advertising is a new ratio family** — costed in its own plan
(`2026-09-07_display-advertising.md`), not this one.

**The quick-win third type is short-form video.** The four motion platforms are already a coherent
cluster — same ratio, same format, safe-area insets defined — and "Reels & Shorts" is a campaign
category the owner's customers will recognise. It needs no new ratio, no new platform and no new
format. Given the owner's video ambition it is the type most likely to sell, and it is the one the
codebase is quietly already best at.

**What a type *is*, in this codebase.** A **preset**: which platforms start selected, which formats,
and which mode. Nothing more. It is stored on the brief so the editor, the picker and the generators
can read it, but it changes no rendering path — the three types below all live inside the existing
three ratios and two formats. That is the whole reason they are quick.

---

## 0.1 Proposed decisions

| id | Decision | Rationale |
|---|---|---|
| **D108** | **Three types: `social-post`, `paid-social`, `short-video`.** Display names *Social post*, *Paid social*, *Short-form video*. The vocabulary is a domain constant, union-keyed like `MODE_OPTIONS` and `RATIO_VALUES`, so a fourth is a compile error until it is deliberately added. | The three are exactly the presets the existing platform set can honestly express (§0). `display-ad` is **not** a member yet — it would be a type over ratios the compositor cannot render, and a create option that produces an unrenderable campaign is the D8 failure in a new costume. It joins the union in the display plan. |
| **D109** | **A type is a preset, applied once at create, and never re-applied.** Choosing a type seeds `platforms`, `formats` and `mode`; the user may then change any of them in the editor and the type does not fight back. The brief records `type` so surfaces can *read* it (a badge in the grid, a filter in the picker, a word in the generator prompt), not so it can *enforce* anything. | An enforcing type is a second mode system, and the editor already has one. A preset that re-asserts itself every time a section mounts would fight the user in exactly the way DESIGN.md §5 forbids. Record once, read anywhere, enforce nowhere. |
| **D110** | **`short-video` sets `mode: "variation"`, and the dialog says so in one line.** | Not a style choice — the API enforces it. `load-brief.ts:603` refuses a classic brief that requests `formats: motion` on every run path, and every short-video platform is motion-only. So the type must set the mode or it mints campaigns that list but never run — the D99 defect reintroduced at create. The other two types default to Classic. |
| **D111** | **`paid-social` is *all seven platforms, both formats, Randomized*.** | Paid social has no distinct platform set here — the placements are the same feeds, stories and reels. What distinguishes a paid campaign is that it wants **variants to test**, which is precisely what Randomized produces, and that it is not confined to one format. So the preset is "everything, varied". This is the weakest of the three structurally and the plan says so; it earns its place because it is the framing the owner's second market needs, and because it costs nothing. |
| **D112** | **`type` is optional on the brief and absent means `social-post`.** Existing briefs, every `briefs/sample-*` fixture, and the YAML corpus stay valid without edits. The scalar joins `brief-yaml.ts`'s list and gets a `validateType` beside `validateMode`. | The precedent is `mode?` at `CampaignBrief.ts:50`: optional, defaulted, validated at the boundary. A required field would be a migration for a preset. |

---

## 1. Findings

#### **F1 · M · "Type" does not exist anywhere in the domain**

No field on `CampaignBrief`, no vocabulary, no preset mechanism. The recomposition plan's C3 row
declined the template rail on exactly this ground — *"no template concept exists in the domain"* —
and that was correct as a description of the code. It is now false as a description of the product.
This plan adds the concept; C3's *affordance* (the start-from rail, still on `main` as
`StartFromExistingPicker` and the `OptionTile` rail) is where a template-shaped type picker would
naturally render later.

#### **F2 · M · The platform set splits perfectly, and the split is the type**

Three static platforms at `1:1`/`16:9`; four motion platforms all at `9:16`. There is no overlap and
no platform carries both formats. That is why `short-video` is free and why `paid-social` has no
platform identity of its own (F3).

#### **F3 · L · `paid-social` is the only type with no structural difference**

Same platforms as the other two combined. Its identity is *intent* — variants for testing, all
placements — which the preset expresses as `mode: variation` plus the full platform list. If a
customer never distinguishes paid from organic in practice, this type collapses into the other two
and should be removed rather than kept as a synonym. **Recorded as the type most likely to be
reconsidered.**

#### **F4 · M · The seed and the preset are the same seam**

Lane S3 made the seed `{ name, mode }` and applies it in `BriefEditor`'s seed effect. A type preset
is the same shape one field wider: the seed becomes `{ name, type }`, and the effect resolves the
type to `platforms`/`formats`/`mode` **once** (D109). `mode` leaves the seed — it is derived from the
type now, which also dissolves the `setMode` dispatch S3's round 1 found untested.

#### **F5 · L · The generators can read the type for free**

Every generator already interpolates `Audience: … Market/region: …` into its prompt
(`GeminiImageGenerator.ts:96` and siblings). A `Campaign type: short-form video` sentence is one more
interpolation from the same `BackgroundContext`, and is the cheapest way the type changes output
rather than only presets. **Optional, and a separate lane, because it touches four adapters and their
prompt goldens.**

---

## 2. The recommendation

```
T1  the domain        →  CAMPAIGN_TYPES, brief.type?, validateType, YAML scalar, presets table
T2  the seam          →  seed {name, type}; the editor applies the preset once
T3  the dialog        →  S1 re-briefed: name + type tiles (three OptionTiles with previews)
T4  read it back      →  a MiniChip in the grid and picker; type in the generator prompt   [optional]
```

**T1 → T2 → T3**, strictly: each consumes the previous one's exports. **T4 is independent of T3**
and optional.

### 2.1 The presets table (D108–D111), the whole of what a type does

| type | platforms | formats | mode |
|---|---|---|---|
| `social-post` | `instagram-feed`, `linkedin`, `x` | `static` | `brief` |
| `paid-social` | all seven | `static`, `motion` | `variation` |
| `short-video` | `instagram-story`, `instagram-reel`, `tiktok`, `youtube-short` | `motion` | `variation` |

Every cell is an existing value. The table lives in the domain beside the vocabulary, not in the web
app, so the API and any future consumer read the same presets.

### 2.2 The dialog (T3)

Name, then three `OptionTile`s. Each tile's picture is what the type produces — `PosterFrame`s at the
preset's ratios for the two static-capable types, `PosterStack` + `ScrubBar` for short-video — with a
`tag` naming the mode it sets (*Classic* / *Randomized*) and a `blurb` naming the platforms. The
short-video tile carries the D110 sentence. **Accessible name is the raw value** (`social-post`,
…), display words from a new `typeDisplayName`, per the kit contract.

---

## 3. Lanes

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **T1** | **The domain.** `CAMPAIGN_TYPES = ["social-post","paid-social","short-video"] as const` beside `RATIO_VALUES`; `CampaignBrief.type?: CampaignType`; `CAMPAIGN_TYPE_PRESETS: Record<CampaignType, { platforms, formats, mode }>` (§2.1) in the domain package — **each preset's platforms must be validated against `PLATFORM_PROFILES` in a test**, so a renamed profile fails at build. `validateType` in `load-brief.ts` beside `validateMode` (absent is fine; an unknown value is a 400). `"type"` joins `brief-yaml.ts`'s scalar list. `dumpBrief` round-trips it. Every `briefs/sample-*` fixture still parses **unedited**. | `CampaignOrchestration/src/domain/value-objects/campaign-types.ts` (new), `CampaignBrief.ts`, `apps/api/server/lib/load-brief.ts`, `packages/shared/src/infrastructure/brief-yaml.ts`, their tests | The concept, once, where every consumer reads it. |
| **T2** | **The seam and the preset application** (F4, D109). `CreateCampaignInput` becomes `{ name, type }`; `mode` leaves it. `isStoredSeed` validates the new shape and **rejects** S3's `{name, mode}` shape as it rejects the older one — same discard-not-half-apply rule, same baton-spending on refusal. The editor's seed effect resolves the type through `CAMPAIGN_TYPE_PRESETS` and patches `platforms`, `formats`, `mode` and `type` **once**, then resets `attempted`/`touched` as today. **Prove D109:** after the seed applies, toggling a platform off and re-mounting Identity does not restore it. **Prove D110:** a `short-video` seed yields `mode: "variation"` and the brief parses on the run path with `enforceCapabilities: true`. | `lib/create-campaign.ts`, `lib/briefs-api.ts`, `campaign/BriefEditor.tsx` (seed effect), `campaign/editor-state.ts` (a `applyPreset` reducer action + `type` on state + `toBrief`/`fromBrief`), `campaign/display-names.ts` (`typeDisplayName`), `campaign/messages.ts` (append), their tests | The preset applied exactly once. |
| **T3** | **The dialog — S1, re-briefed.** Everything in the two-field plan's S1 row stands (narrow centred dialog, reference styling, single `role="status"`, the discard guard, D65) **except the second field**: three `OptionTile`s over `CAMPAIGN_TYPES` (§2.2), default `social-post`, replacing the `ModePanel`. The short-video tile shows the D110 line. The seed carries `type`. **Mutation:** choose short-video → the seed's type is `short-video` and the resulting editor mode is `variation`. Jargon gate: display words from `typeDisplayName`; the raw ids `static`/`motion` do not appear in any new string. | `shell/CreateCampaignDialog.tsx`, `campaign/messages.ts` (append), the dialog's test, the `fillDialog` helpers | The dialog the owner asked for, with the field they meant. |
| **T4** | **Read it back** (F5) — *optional, independent of T3.* A `MiniChip` with the type's display name on the grid card and the picker row. `BackgroundContext` gains `campaignType`, and the four generators add one sentence to their prompts; **prompt goldens re-recorded deliberately**, with the diff shown in the PR. | `app/(shell)/grid/page.tsx`, `shell/BriefPicker.tsx`, `CreativeGeneration/src/infrastructure/adapters/*Generator.ts`, `GenerateCampaignUseCase` (context), their tests and goldens | The type changing what gets *made*, not only what starts selected. |

**Waves.** A: **T1**. B: **T2**. C: **T3 ‖ T4**. The two-field plan's `packages/ui` lane (**P1**)
still goes last, after all of this.

---

## 4. Definition of Done

Standing gate per lane (100 % ×4), a mutation per claim **confirmed to compile, run, and target the
path the test names** — this session found four distinct ways a mutation can misfire and each one
returned a false green.

- **T1**: `CAMPAIGN_TYPE_PRESETS` references only ids present in `PLATFORM_PROFILES` (asserted);
  every `briefs/sample-*` parses unedited; an unknown `type` is a 400 on `briefs`, `generate`, `plan`.
- **T2**: an S3-shape seed `{name, mode}` is **discarded**, not half-applied; the preset is applied
  once (D109 proven by the re-mount test); `short-video` → `variation` and parses on the run path.
- **T3**: exactly two controls; the tiles resolve by raw value; the short-video tile carries the
  D110 sentence; no slug (D65); the discard guard and resume two-way pass unedited.
- **T4**: prompt goldens re-recorded with the diff in the PR body; the grid chip reads the display
  name, never the raw id.

---

## 5. Deferred

| What | Waits on |
|---|---|
| **`display-ad` as a fourth type** | `2026-09-07_display-advertising.md` — a new ratio family, not a preset |
| A template picker rendered as the rail | a template *model* — the start-from rail is the affordance, this plan is the first concept it could point at |
| Removing `paid-social` if customers never use it | F3 — evidence, not a decision |

---

## 6. Open questions

1. **Does `paid-social` earn its tile?** F3 says it is the only type with no structural identity.
   The plan keeps it because it is the owner's stated market; the owner may prefer two types and a
   later fourth.
2. **Should a type ever be re-applied?** D109 says never. A "reset to preset" verb in the editor
   would be the honest way to offer it if wanted — a button, not an effect.
3. **T4's prompt sentence** — is `Campaign type: short-form video` the right hint to a background
   generator, or is it noise? Cheap to try, cheap to remove; the goldens make the change visible.

---

## 7. Corrections this plan records

- **D97 chose the wrong field**, and the orchestrator's own question invited it. Asked whether
  "template type" meant the render format or the campaign mode, the owner picked mode — but the
  owner's *market* statement, made afterwards, showed neither was the intended meaning. The right
  question was "what kind of campaign", and it was not on the list. Recorded because a well-formed
  question with the wrong options is more dangerous than a vague one: it produces a confident answer.
- **C3 was declined for a reason that was true of the code and is now false of the product.** "No
  template concept exists" was accurate. This plan adds the concept. The affordance C3 built anyway —
  the rail — is where it will render.
