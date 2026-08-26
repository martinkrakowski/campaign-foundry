# Unified Campaign Editor — Architecture & Development Plan

**Date:** 2026-08-26
**Status:** Revised v2.2 (decisions D1–D15 locked after an Architect review, a Reviewer pass and a bot sweep; Q1/Q2 resolved)
**Scope:** `apps/web` — merge the `/brief` editor and the `/new` wizard into one campaign editor; `apps/api` — one small read-only route (`GET /campaigns/capabilities`)
**Related:** `2026-08-25_randomized-campaigns-and-motion.md` (Phase 1 wizard, Phase 6 UI), PRs #51 (wizard), #57 (pool panel), #58 (motion), #62 (nav entry points)

---

## 0. Proposed Decisions

| ID | Decision | Consequence |
|----|----------|-------------|
| **D1** | **One editor, one route.** `/brief` becomes *the* campaign editor for both new and existing briefs; `/new` and the step wizard are removed. | The sidebar's **Edit** and **Create new** both land on `/brief` (the latter with a blank draft). The `New campaign` header tab from #62 is removed. |
| **D2** | **Brief selector, not a text id.** The editor header carries a **Brief** combobox: every entry from `GET /campaigns/briefs` plus **New brief…**. Choosing an entry loads it; **New brief…** resets the draft. The id itself is edited in the Identity section like any other field. | No dependency on a YAML file to start: a new brief exists in memory and can be run immediately; **Save** is what creates the file. |
| **D3** | **Two verbs, not three.** The editor edits a *draft*. **Apply to run** commits it to `run-context.setBrief` (in-memory, today's HITL loop). **Save & apply** persists via the briefs API (`POST`; `?replace=1` after the D9 guard; `PUT` when saving the brief that was loaded) **and** applies — committing to disk always means "this is the truth". | Closes the state-triangle trap (save-but-not-applied, applied-but-not-saved). The action bar's status chip makes the remaining two states legible (D11). Picker-switch race fix from #51 stays in force. |
| **D4** | **Sections, not steps.** The page is one scrollable form in sections with a sticky action bar; the wizard's step components become section components. Mode (Classic / Randomized) is a toggle at the top that shows/hides the mode-specific sections. | The wizard reducer (`wizard-state.ts`) becomes the editor reducer; `Wizard.tsx` (stepper) and the Review step go away — the YAML preview becomes a collapsible panel in the action bar. |
| **D5** | **Field parity with the brief schema.** Every `CampaignBrief` field is editable: id, region, audience, message, localized message, products (id, name, colour, logo upload/path, `inputAsset`), **treatments** (classic — no UI exposes them today; E1 adds one), variation policy (count, seed, minDistance, coverage, axes incl. `headline` pool, and — new — `motion`/`duration`), output (formats incl. `motion`, platforms filtered to compatible ones). | The remaining plan-deferred item "wizard has no motion controls" closes here. |
| **D6** | **Capabilities from the API.** `GET /campaigns/capabilities` → `{ motion: boolean, reason?: string }` (reads the existing probe). The editor disables motion controls with the reason when off. | Replaces the hard-coded `STATIC_PLATFORMS` list; platforms come from `PLATFORM_PROFILES` filtered by capability and the selected formats (mirrors the parser's compatibility rule from #58). |
| **D7** | **Three validity questions, never conflated.** *Persistable* = structurally valid (Save is allowed). *Editable* = a control may be read-only because a capability is off, which does **not** make the brief invalid. *Runnable* = fully valid including capabilities. Client validation mirrors `parseBrief`'s structural rules only; the API stays authoritative. **Save** is blocked solely by structural invalidity; **Apply/Run** additionally surfaces the API's capability error as the status message. | Resolves the D7/D12 contradiction: a motion brief on a host without ffmpeg is persistable and editable but not runnable. |
| **D8** | **Unsaved-changes guard.** Switching brief in the selector or the picker, or navigating away, prompts when the draft is dirty (in-app dialog, not `window.confirm`). | No silent loss of an unsaved new brief. |
| **D9** | **Rename is a copy, never an in-place rename.** The id field is editable only for a *new* draft. For a loaded brief it is read-only with a **Save as…** action that writes **the current draft** under the new id via `POST /campaigns/briefs` — never the duplicate route, which copies the file on disk and would silently drop unsaved edits (the picker's row-level Duplicate keeps using it, for an unchanged copy) — and states, in the dialog, that the original file stays on disk until deleted (Q2 backlog). Any Save/Save as… that would land on an existing id — client-side against the selector list **excluding `source.loadedId`**, with the API 409 as the backstop for a stale list — opens the same severe confirm naming the brief that would be overwritten before `?replace=1`. | `PUT /campaigns/briefs/:id` rejects `id !== brief.id`, so an in-place rename is impossible with the API; the UI says what actually happens (fork, old file kept) instead of hiding it. |
| **D10** | **Non-destructive mode toggle.** `EditorState` keeps both the classic (`treatments`) and randomized (`variation`, `pool`, motion/duration/formats) data when the mode toggle flips; `toBrief()` and `validate()` only read the active mode's data. | A misclick on the toggle loses nothing; toggling back restores the policy. |
| **D11** | **Draft auto-recovery + status legibility.** The draft is mirrored to `localStorage` (`cf:draft:<id or temp uuid>`) on every change; on load, recovery is offered **only when the recovered draft differs from the saved snapshot**; the key is purged on Save, Discard, and when a new draft's temp id becomes a real id. The action bar shows one of **four** states: 🔴 draft not applied · 🟠 applied, never saved (exists only in memory) · 🟡 applied, unsaved edits to a saved file · 🟢 saved & applied. | A crash never loses an in-memory brief; a clean reload never prompts; "closing loses a file that exists nowhere" is distinguishable from "closing loses edits". |
| **D12** | **Capability-off never rewrites a brief.** If `GET /campaigns/capabilities` reports motion off and the loaded brief has motion fields, the motion controls render **read-only with the reason**, `toBrief()` **preserves** the fields verbatim, and Save & apply persists them unchanged; Apply/Run surfaces the parser's 400 as the status message. Only an explicit user edit of those controls (when enabled) changes them. | Same class of bug as D10: gating must never strip data. Preserve, don't filter. Requires **D15** — today's capability-gated parser omits such a brief from the listing and 400s the save, so D12 is not implementable without it. |
| **D13** | **Stale-write protection is server-side.** `GET /campaigns/briefs` returns a `revision` per entry (hash of the file's bytes). `POST …?replace=1` and `PUT …/:id` accept the `revision` the client loaded and return **409 with the current revision** when it no longer matches; that 409 drives the conflict dialog (reload theirs / overwrite). The client-side compare and the `storage` event from another tab are UX pre-checks only. | A client re-fetch-then-write is a TOCTOU race — two tabs can both pass the check and the later write wins silently. Only a conditional write on the server closes it. |
| **D14** | **Navigation guard mechanism, and its stated limit.** Every shell navigation — header tabs, sidebar Edit/Create new, the picker, **and `MobileMenu`'s own links** — goes through one `useGuardedNavigate()` hook that consults the dirty state and opens the D8 dialog; `beforeunload` covers tab close and reload. Browser **Back/Forward is not intercepted**: the App Router exposes no supported route-change hook, and `popstate` interception is unreliable. D8 and the Definition of Done are therefore scoped to guarded shell links plus tab close; **D11's auto-save is the safety net for history navigation**, and that is written down rather than implied. | An honest, testable guarantee beats a promise that fragile `popstate` handling cannot keep. |
| **D15** | **Authoring parse mode in the API.** `parseBrief` gains a mode: *authoring* validates structure only, *running* additionally enforces capabilities. `GET /campaigns/briefs`, `POST /campaigns/briefs` and `PUT …/:id` use authoring, so a motion brief is listed and can be saved on a host without ffmpeg; `POST /campaigns/generate` and `POST /campaigns/plan` keep full enforcement, so it still cannot be *run* there. | Without this, D12's preserve-don't-strip guarantee is unimplementable: the brief is skipped by the listing and rejected by save. |

---

## 1. Context & Current State (verified 2026-08-26)

- Two authoring surfaces exist: `/brief` (`page.tsx`, 299 lines: id, region, audience, message, localized, products[id/name/colour/logo]; buttons *Save brief* = apply to run-context, *Save to briefs/*, *Save as…*) and `/new` (`Wizard.tsx` 137 + `steps.tsx` 740 + `wizard-state.ts` 353 lines: steps type → products → copy → policy → output → review; randomized policy with estimate panel; headline pool panel; logo upload via assets route; classic products ≥ 2 / randomized ≥ 1).
- The wizard's **Brief ID** field is a text input for the *new* slug; it is not a lookup. Nothing in `/brief` can change `mode`, `variation`, `output`, or `treatments`; nothing in `/new` can open an existing brief.
- Motion controls exist nowhere in the UI (motion is enabled by editing YAML); the export page infers motion platforms from the run. No capabilities route exists (`package.post.ts` reads `getCapabilities()` server-side only).
- Entry points after #62: header tab **New campaign** → `/new`; sidebar **Create new** → `/new`; sidebar **Edit** → `/brief`; picker **Create new** → `/new`, **Duplicate** per row.
- Reusable pieces: `wizard-state.ts` reducer + `toBrief()` + `validate.ts` (mirrors `parseBrief`), `steps.tsx` sections (`ProductsStep`, `CopyStep` + `HeadlinePoolPanel`, `PolicyStep` + `EstimatePanel`, `OutputStep`), `briefs-api.ts` (create/replace/duplicate/upload/plan/pools), `dump-brief.ts` (YAML preview), `mockPipelineApi`.

### Guiding Principles

1. One mental model: *a campaign is a brief; the editor shows all of it.* Mode only reveals or hides sections.
2. The in-memory HITL loop (edit → Apply → Run) is untouched; persistence is explicit.
3. Reuse the wizard's reducer/sections/validation; delete the stepper. No new dependencies.
4. Nothing the editor can produce is rejected by `parseBrief` (compatibility rules for formats/platforms, motion capability, pool axis gating), and everything `parseBrief` accepts is representable.

---

## 2. Analysis of the proposal

| Proposal point | Assessment |
|---|---|
| Remove the **New campaign** header tab | Agree — with one editor there is one place; the sidebar's **Create new** stays and simply opens the editor with a blank draft. Header nav returns to Grid / Compliance / Export / Runs. |
| New and edit should be the same screen | Agree. Today's split exists only because the wizard was built to *author from scratch* while `/brief` was the HITL editor; the reducer and sections already cover 90 % of the fields. |
| "Brief ID as a selector of existing briefs or *create new*" | Agree on the intent, with a refinement: the **selector is a separate control** (which brief am I editing) and the **id stays a field** (what is this brief called). Folding both into one dropdown makes renaming impossible and conflates "open" with "name". |
| Not relying on a YAML file to create a brief | Already true in memory; the gap was that the wizard forced a Save at the end and `/brief` couldn't hold a randomized brief. With D2/D3 a new brief can be edited, applied, and run entirely in memory; Save is optional and creates the file. |
| "All elements of campaign brief and configuration" | Requires adding what neither screen has: treatments (classic), motion/duration axes and `formats: motion`, platform compatibility, capability awareness (D5/D6). |

Adversarial review (external Architect pass, 2026-08-26) added four findings, all accepted: the Save/Apply **state triangle** (→ D3 v2: Save always applies), **rename overwrites** (→ D9), **mode-toggle data loss** (→ D10), and **validation opacity** on a long form (→ TOC error badges, §3.1). Two of its layout proposals were accepted as-is (sticky TOC with badges; headline pool as a side drawer), one adapted (YAML **split view** as a toggle that replaces the TOC column rather than a third pane — the shell already spends 320 px on the sidebar), and auto-recovery was accepted as D11.

A Reviewer pass (2026-08-26) then found two holes and six gaps, all resolved in v2.1: rename of a loaded brief is impossible in place with the API (→ D9 rewritten as copy-not-rename); capability-off must preserve, not strip, motion fields (→ D12); the wizard must keep working during E1–E2 (→ move-by-re-export shim, E1.1); SPA navigation guard mechanism (→ D14); split view hiding the badges (→ mode-independent error strip); multi-tab / stale-list / orphaned draft keys (→ D13, D11); the status chip conflating never-saved with edited (→ four states, D11); task inconsistencies (→ Create new repointed in E1, tests renumbered, `updateBrief` client tasked, Save as… 409 uses the D9 dialog).

Risks the proposal doesn't mention: (a) a long single form needs a sticky action bar and section anchors to stay usable at 100+ variants' worth of policy options; (b) picker vs. selector — two ways to choose a brief; keep the picker (it is also the mobile path and offers Duplicate) but make it *drive the same selector state*; (c) the draft/apply/save trinity must be legible — three verbs on the bar, each with a status chip.

---

## 3. Target Design

### 3.1 Screen: `/brief` — "Campaign"

```text
┌ Header ─────────────────────────────────────────────────────────────┐
│ Brief: [ trail-blaze-2026 ▾ ]  ● unsaved changes   Mode: (Classic | Randomized) │
│         ├ summer-hydration-2026 (sample-campaign.yaml)                          │
│         ├ … every GET /campaigns/briefs entry, file name as hint                │
│         └ ＋ New brief…                                                         │
├ 1 Identity ─────────────────────────────────────────────────────────┤
│ Brief id (slug) · Target region · Target audience                     │
├ 2 Copy ─────────────────────────────────────────────────────────────┤
│ Campaign message · Localized message                                 │
│ [Randomized] Headline pool panel (list, approve/reject/edit,          │
│              Generate 10 suggestions, 503/404 states)                 │
├ 3 Products ─────────────────────────────────────────────────────────┤
│ Cards: id · name · primary colour · logo (upload → assets/inputs/<id>/ │
│ or path) · input asset (optional) · Remove   [+ Add product]           │
│ Rule: classic ≥ 2, randomized ≥ 1 (inline)                            │
├ 4a Treatments  [Classic] ───────────────────────────────────────────┤
│ Rows: id · layout · tone  [+ Add treatment]  (absent = default)       │
├ 4b Variation policy  [Randomized] ──────────────────────────────────┤
│ count · seed · minDistance (bound = active axes) · coverage per       │
│ product / per ratio · axes: layout, tone, background source,          │
│ paletteShift, headline (pool://copy, gated on ≥1 approved),           │
│ motion kinds + duration (gated on capability, with reason)            │
│ Estimate panel (creatives · axis product · feasible · GenAI calls ·   │
│ frames + encode minutes) — debounced POST /campaigns/plan             │
├ 5 Output ───────────────────────────────────────────────────────────┤
│ Formats: static · motion (gated) · Platforms: only those compatible   │
│ with the chosen formats (PLATFORM_PROFILES × capability)              │
├ Sticky action bar ──────────────────────────────────────────────────┤
│ [Apply to run]  [Save & apply]  [Save as…]  [Discard]  [YAML split ⇄]  │
│ status: 🔴 draft not applied · 🟠 applied, never saved · 🟡 applied,  │
│         unsaved edits · 🟢 saved & applied — plus the first blocking   │
│         error, linked to its section                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**Layout details (from the review):** a sticky in-page **table of contents** on the left of the form (Identity · Copy · Products · Treatments/Policy · Output) with a red error badge and count on any section that has invalid fields — clicking scrolls to the first error; the **headline pool** opens as a right-hand **drawer** from the Copy section (review, approve/reject, edit, Generate) so the main scroll stays short; **YAML split view** is a toggle that swaps the TOC column for a live, read-only YAML pane (same dumper as the preview) — off by default, remembered in `localStorage`. Because the error badges live in the TOC, the **action bar always carries a mode-independent error strip** (one chip per invalid section, click → first error), so split view never hides validation state.

### 3.2 State model

- `EditorState` = today's `WizardState` minus `stepIndex`, plus `source: { kind: "new", tempId } | { kind: "file", file, loadedId, savedSnapshot }`, `treatments: TreatmentDraft[]`, `motion: string[]`, `duration: number[]`, `formats: string[]`; both mode branches are always present (D10); derived `dirtySinceSave` and `dirtySinceApply` drive the traffic-light status; `appliedSnapshot` is what `run-context` last received.
- `fromBrief(brief, entry?)` (new) and `toBrief(state)` (exists) are the two boundaries; `validate(state)` (exists, extended for treatments/motion/duration/compatibility).
- Selector change / picker select / sidebar Create new → the same `load(brief | null)` action, guarded by D8 when dirty.

### 3.3 API touch

Three changes, not one — the review established that two of the client-side guarantees are
unimplementable without server support:

- `GET /campaigns/capabilities` → `{ motion, reason? }` (new, read-only) — **D6**.
- **Authoring vs. running parse mode** (**D15**): `parseBrief(value, { enforceCapabilities })`;
  listing and persistence use authoring, generate/plan keep enforcement.
- **Conditional write** (**D13**): `revision` (content hash) on each listing entry, accepted by
  `POST …?replace=1` and `PUT …/:id`, returning 409 + the current revision on mismatch.

Everything else — duplicate, upload, plan, pools — already exists and is unchanged.

### 3.4 What is removed

- `apps/web/src/app/(shell)/new/**`, `components/wizard/Wizard.tsx`, the Review step, `STATIC_PLATFORMS`, the **New campaign** header tab; picker/sidebar/Edit links repointed to `/brief`.

---

## 4. Open Questions

*Resolved 2026-08-26:* **Q1 — Apply is explicit** (a button; live-applying `brief.id` would thrash grid keys and persisted-run restore). **Q2 — delete is out of scope** (no route; users delete the YAML; backlog item with a confirm dialog and delete-while-running handling).

| ID | Question | Blocks |
|----|----------|--------|
| — | none open | — |

---

## 5. Phased Implementation Plan

Three PRs, sequential (each edits the same files), each green at the 100 % gate.

### Phase E1 — Editor shell (classic parity + selector)

| # | Task | File(s) |
|---|------|---------|
| E1.0 | **API (D13):** `revision` (content hash) on every `GET /campaigns/briefs` entry; `POST …?replace=1` and `PUT …/:id` accept it and return 409 + the current revision on mismatch. | `apps/api/server/routes/campaigns/briefs*.ts`, `lib/brief-files.ts` |
| E1.1 | `EditorState` from `WizardState` (drop `stepIndex`, add `source`, `dirtySinceSave`/`dirtySinceApply`, `treatments`; both mode branches retained); `fromBrief()`; extend `validate.ts` (treatments; id uniqueness against the selector list **excluding `source.loadedId`**, or every loaded brief is invalid and can never be saved). **Move by re-export:** `components/campaign/*` becomes the home; `components/wizard/*` re-exports from it so `/new` keeps working until E3 (same package — no cross-layer import). | `components/campaign/editor-state.ts`, `validate.ts`, `components/wizard/*` (shims) |
| E1.2 | `/brief` page rebuilt from sections: header (Brief selector + mode toggle), Identity, Copy, Products, Treatments (classic), sticky action bar (Apply / Save / Save as… / Discard / YAML preview). Section components moved from `wizard/steps.tsx` unchanged where possible. | `app/(shell)/brief/page.tsx`, `components/campaign/*` |
| E1.3 | Selector data: `listBriefs()` on mount, after Save, and on window focus (D13); **New brief…** resets; picker select, picker **Create new**, and sidebar **Create new** all go to `/brief` and dispatch the same `load` **from E1 onward** (the wizard is no longer an entry point, only a route until E3). D8 dirty guard via `useGuardedNavigate()` (D14) + `beforeunload`, applied to **every** shell navigation including `MobileMenu`'s own links. `briefs-api.updateBrief()` (PUT) restored. | `components/shell/{BriefPicker,Sidebar,Header,MobileMenu}.tsx`, `lib/briefs-api.ts`, `lib/use-guarded-navigate.ts` |
| E1.4 | D9: id read-only for loaded briefs; **Save as…** posts the **current draft** under the new id (never the duplicate route — it would copy the file on disk and drop unsaved edits) with a dialog stating the original file stays; overwrite confirm for id collisions (client list minus `loadedId`, 409 backstop) shared by Save and Save as…; D3 **Save & apply** semantics (PUT for the loaded id, POST for new, both carrying the loaded `revision`); D13 conflict dialog driven by the API's 409. | action bar, `editor-state.ts`, `briefs-api.ts` |
| E1.5 | D11 four-state status chip + mode-independent error strip + first-error link; sticky TOC with error badges; D10 non-destructive toggle; D11 auto-save with purge rules and "only when different" recovery. | action bar, TOC, `editor-state.ts` |
| E1.6 | Tests (written with each task, listed last only for reading): load existing / new / switch-with-dirty-guard incl. guarded shell links; Apply updates `run-context.brief`; Save & apply → POST 201 + apply / loaded id → PUT; new-id collision → D9 dialog → `?replace=1`; **Save as… preserves unsaved draft edits** and 409 → D9 dialog; loaded id read-only; a guarded `MobileMenu` link prompts when dirty; stale-`revision` 409 → conflict dialog; treatments round-trip; toggle keeps both branches; auto-save purge + "only when different" recovery; four-state chip; error strip in split view. | `__tests__/` |

**Acceptance:** every classic brief in `briefs/` opens, edits, applies, and saves from `/brief`; the old `/brief` behaviours (Save brief = Apply) still pass their tests.

### Phase E2 — Randomized sections + motion controls + capabilities

| # | Task | File(s) |
|---|------|---------|
| E2.1 | `GET /campaigns/capabilities` route + test. **D15:** `parseBrief(value, { enforceCapabilities })` — listing and persistence authoring-mode, generate/plan enforcing; a motion brief is listed and saveable on a host without ffmpeg and still refused by run. | `apps/api/server/routes/campaigns/capabilities.get.ts`, `lib/load-brief.ts`, `briefs*.ts`, `briefs.get.ts` |
| E2.2 | Variation policy section (from `PolicyStep`) + Estimate panel; Headline pool as a **drawer** opened from Copy (from #57's panel, with the brief-scoped race guard); YAML **split view** toggle. | `components/campaign/*` |
| E2.3 | Motion controls: `formats` (motion gated on capability with reason), `motion` kinds, `duration` list; `minDistance` bound from active axes (shared rule with the VO); Output platforms filtered by compatibility (mirror of `validateFormatPlatformCompatibility`). **D12:** capability off + loaded motion brief → controls read-only, fields preserved verbatim through `toBrief()`/Save (structurally valid ⇒ persistable, per D7); Apply shows the API's capability error. | `editor-state.ts`, `validate.ts`, Output section |
| E2.4 | Tests: capability off → the brief is **listed** and round-trips through Save unchanged while Apply/Run is refused (D7/D12/D15); controls disabled with reason; compatibility filtering; estimate frames/minutes for motion; pool axis gating; drawer race guard; split view keeps the error strip. | `__tests__/` |

**Acceptance:** `briefs/sample-motion.yaml` and `sample-pooled.yaml` open fully editable; a randomized motion brief can be authored from **New brief…**, applied, and run without touching YAML.

### Phase E3 — Remove the wizard and the extra entry point

| # | Task | File(s) |
|---|------|---------|
| E3.1 | Delete `/new`, `Wizard.tsx`, Review step, `STATIC_PLATFORMS`; drop the **New campaign** header tab (revert of #62's tab; keep the sidebar button). | `app/(shell)/new/**`, `components/wizard/**`, `Header.tsx` |
| E3.2 | Remove the `components/wizard/*` re-export shims; migrate/delete wizard tests (entry points were already repointed in E1.3). | `components/wizard/**`, tests |
| E3.3 | README (Modes/authoring), plan `2026-08-25` deferred list (wizard motion controls → done), session log. | docs |

**Acceptance:** no route or link to `/new` remains; `yarn test:cov` 100 %; README screenshots/paths updated.

---

## 6. Dependency Graph

```text
E1 (shell + selector, classic parity)
 └── E2 (randomized + motion + capabilities)
      └── E3 (remove wizard + header tab, docs)
```

---

## 7. Cross-Cutting Concerns

- **Identity keys:** `run-context.brief.id` drives grid keys and persisted-run restore; only **Apply** changes it (Q1).
- **Drafts vs. files:** a brief that was never saved shows `● in memory` in the header; Save creates the file; Replace only after an explicit 409 prompt.
- **A11y:** sections are `<section aria-labelledby>` with an in-page nav; the dirty guard is a focus-trapped dialog (reuse the picker's trap).
- **Mobile:** the mobile menu keeps **Create new** / **Browse briefs**; the editor is the same page.

---

## 8. Risks & Notes

- **Scope of E1.2** — the biggest diff; keep section components byte-moved from `steps.tsx` to make the review tractable.
- **Two selection paths** (selector + picker) must never disagree: both dispatch `load`; the picker remains for Duplicate and mobile.
- **`treatments` UI is new** — small, but it changes what classic briefs can express from the UI; validate ids as path-safe slugs like the parser.
- **Capability timing** — Nitro serves before the async probe completes; the capabilities route returns `not probed` briefly; the editor re-fetches on focus.

---

## 9. Definition of Done

1. A brand-new randomized motion brief is authored from **New brief…**, applied, run (clips in the grid), and only then saved to `briefs/` — with no YAML editing.
2. Every sample brief in `briefs/` opens in the editor with all fields populated and round-trips through Save unchanged (key order per the API dumper).
3. `/new` is gone; the header has no **New campaign** tab; sidebar **Create new** opens a blank editor.
4. Switching briefs or following any shell link — desktop or mobile menu — with unsaved edits prompts (browser Back/Forward is out of scope by D14; D11 auto-save covers it); discarding restores the selected brief; a loaded brief cannot be renamed in place — Save as… copies and says the original remains; landing on an existing id prompts before overwriting; a stale file (other tab) prompts before overwriting; toggling mode and back loses nothing; a reload after a crash offers the draft back only when it differs.
6. A motion brief opened on a machine without ffmpeg is listed in the selector, round-trips through Save with its motion fields intact, and is refused only when run.
7. Two tabs editing the same brief cannot silently overwrite each other: the second Save gets a 409 and the conflict dialog.
5. `yarn test:cov` at 100 %, `lint`, `typecheck`, `lint:arch` green; README and the 2026-08-25 plan's deferred list updated.
