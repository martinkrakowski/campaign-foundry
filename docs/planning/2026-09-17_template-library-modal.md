# The template library modal — browse, search, sort, and one detail view

**Date:** 2026-09-17 · **Status:** draft, for the owner's approval. **Nothing dispatched.**
**Verified against:** `origin/main` at `05db8e65`.
**Source:** the owner's decisions of 2026-09-17 (items 3, 3a, 3b, 3c) against their annotated wireframe — *"Opens a modal window allowing user to browse existing templates (Sorted by campaign type)."*
**Related:** `2026-09-08_creative-templates-and-units.md` (**D123** defines the library; **L7** shipped its store and routes), `2026-09-16_creative-first-chrome.md` (**CC7** — *"Browse over a real library… the library is its own plan"*; **this is that plan**), `2026-09-17_wireframe-gap.md` (SG-D5).

---

## 0. The good news, first

**This is not a greenfield feature.** Most of the substrate already shipped and nothing consumes it.

| Layer | State |
|---|---|
| **Decision** | **D123 is fully stamped.** A template is `{ id, version, name, unit, creativeType, layers, thumbnail }`, **ownerless, versioned, immutable per version**; a campaign **pins** `template@version`; the brief carries the pinned reference *and* the materialised layers, so a campaign renders with no library present. |
| **Store** | `TemplateStore` port + `FsTemplateStore` — `listTemplates()` returns one record **per version** (`template-store.port.ts:15`, `fs-template-store.ts:43`). |
| **API** | **`GET /campaigns/templates`** (`templates.get.ts`) and **`GET /campaigns/templates/[ref]`** both exist. The list route already follows the house rule that a store failure is a 500 and **never** an empty list. |
| **Domain type** | `CreativeTemplate` = `{ id, version, name, unit, creativeType, layers }` (`creative-templates.ts:57-64`) — **`thumbnail` is missing**, though D123 names it. |
| **Web client** | **Nothing.** `grep -rn "campaigns/templates" apps/web/src` returns **zero** non-test hits. |

So the work is a client, a modal, and one absent domain field — not a subsystem.

---

## 1. Findings

| # | Severity | Finding |
|---|---|---|
| **T1** | **Critical** | **The library is served and unreachable.** Both routes exist and are tested; the web app has no client for either and no UI. Every template in the store is invisible to the operator — the same failure shape as the rail: built, paid for, never surfaced. |
| **T2** | High | **`thumbnail` is in D123 and not in the type.** The owner's 3a requires thumbnails. `CreativeTemplate` has no such field, so there is nothing to render and no contract for what a thumbnail *is* — a stored image, a compositor render, or a derived preview. **T-D1 settles it**; without that decision the lane would invent one. |
| **T3** | High | **`listTemplates()` returns one record per version, and the operator must not browse versions.** D123 makes versions immutable and additive, so a library with three revisions of one template yields three records. A grid that renders them all shows the same template three times. The modal must collapse to **latest version per `id`** while keeping the pinned `@version` reachable — **T-D2**. |
| **T4** | Medium | **"Sorted by campaign type" is not a field on a template.** The wireframe's annotation says templates are sorted by campaign type, but a template carries `creativeType` and `unit` — **not** `CampaignType`. `CAMPAIGN_TYPE_PRESETS` maps campaign type → formats/platforms, so the relation exists but is derived and possibly many-to-many. **T-D3.** |
| **T5** | Medium | **"The final creative as generated" is a compositor render, not a stored asset.** 3c asks the detail view to show the creative as generated. That is `/preview-frame`, the same path the rail uses — which means the detail view inherits the rail's whole cost contract (debounce, 32-entry process-wide LRU, abort-does-not-stop-the-server) and can spend the owner's GenAI credits. **T-D4.** |
| **T6** | Medium | **A modal inside a modal.** 3b puts the detail view *within* the modal with a back arrow. Every existing shell sets `aria-modal="true"` and traps focus (`dialog-shell.tsx`), and `BriefPicker` already documents that **two `DialogShell`s at the same time is a defect** — it closes itself first (F22). So detail must be a **view swap inside one shell**, never a second shell. |
| **T7** | Low | **"All of the brief details" is ambiguous for a library entity.** A template is ownerless (D123) and has no brief. The owner's 3c likely means *the brief details of the campaign that produced the shown creative* — provenance, not the template. **T-D5.** |

---

## 2. Decisions needed

| ID | Question | Recommendation |
|---|---|---|
| **T-D1** | **What is a `thumbnail`?** (a) A stored image path in the record. (b) A compositor render at request time. (c) A cheap client-drawn glyph from `layers`, like the create dialog's `TypePreview`. | **(c) for the grid, (b) for the detail view.** The create dialog already draws recognisable previews from structure alone (`PosterFrames`, `PosterStack`), so a grid of 50 templates costs nothing and cannot fail. A real render is worth its cost once, on the one template the operator opened. This also means **`thumbnail` need not be added to the domain type at all** — which is the cheapest possible answer to T2, and it keeps a library record free of a rendering concern. If the owner wants art-directed thumbnails later, (a) is additive. |
| **T-D2** | **Does the grid show versions?** | **Latest per `id`, with the version shown as a chip on the card.** Older versions stay reachable from the detail view. Browsing versions is a curation task, not a picking task, and the picker exists to pick. |
| **T-D3** | **What does "sorted by campaign type" mean?** | **Group by `creativeType`, and offer sorts by name and unit.** `creativeType` is the field a template actually has and it is what the operator is choosing between (image-text vs video). If a campaign-type filter is wanted, derive it through `CAMPAIGN_TYPE_PRESETS` and state the many-to-many in the PR — do not add a field to the record. |
| **T-D4** | **May the detail view render a live creative?** | **Only on explicit request**, never on open. A button — *"Render preview"* — not an automatic fetch. The rail's own lesson (CC2) is that an always-on preview changes the cost of everything around it, and here the fetch is triggered by *browsing*, which the operator does casually. Opening a library must never spend credits. |
| **T-D5** | **Whose brief details does the detail view show?** | **The pinned campaign's, labelled as provenance** — "last used by", with the brief id and its assets — and **nothing** when no campaign has pinned that template yet. A template is ownerless; presenting template fields as "brief details" would be a category error, and fabricating a brief is forbidden by D26. |

---

## 3. What the modal is

**One `DialogShell`. Two views. No nesting.**

```
┌ Template library ─────────────────────────────── [search] [sort ▾] [×] ┐
│  Image & Text                                                          │
│  ┌──────┐ ┌──────┐ ┌──────┐   ← thumbnail: drawn from `layers` (T-D1c) │
│  │      │ │      │ │      │      name · unit · v2 chip                 │
│  └──────┘ └──────┘ └──────┘                                            │
│  Video                                                                 │
│  ┌──────┐ ┌──────┐                                                     │
│  └──────┘ └──────┘                                                     │
└────────────────────────────────────────────────────────────────────────┘
        │ click a card
        ▼                          same shell, view swapped
┌ ← Back │ Canonical Image & Text  v2 ───────────────────────────── [×] ┐
│  ┌─────────────────┐   Layers (from the record, read-only)            │
│  │  [Render        │   image · fill · static-text · logo              │
│  │   preview]      │   Unit · creativeType · version history          │
│  └─────────────────┘   ── Provenance (T-D5) ──                        │
│   no fetch on open     last used by <brief id> · attached assets      │
│                        (absent when nothing has pinned it)            │
│                                            [ Use this template ]      │
└───────────────────────────────────────────────────────────────────────┘
```

**Back is a view swap, not a dismissal.** `Escape` closes the whole modal from either view; **Back** returns to the listing and restores the scroll position and the search term. Focus moves to the card that was opened, not to the top of the grid.

---

## 4. Lanes

| Lane | Owns | Ships |
|---|---|---|
| **TM1** | `apps/web/src/lib/templates-api.ts` (new) | **The client.** `listTemplates()` / `getTemplate(ref)` against the two existing routes, with the house error contract: a failed read is an error state, **never an empty list**. No UI. |
| **TM2** | `apps/web/src/components/shell/TemplateLibrary.tsx` (new) | **The listing view** — grid, structural thumbnails (T-D1c), grouping by `creativeType` (T-D3), search over name, sort, latest-per-`id` collapse (T-D2), and the empty/error states distinguished. |
| **TM3** | same component | **The detail view** — view swap in one shell (T-D6/T6), back arrow with scroll + search restored, layers read-only, version history, provenance (T-D5), and the **on-request** render (T-D4). |
| **TM4** | `Sidebar.tsx`, `create-campaign-context.tsx` | **The entry point** — opened from the left column per the owner's flow (static/motion → pick a template), and `Use this template` pinning `template@version` onto the draft. |

**Order.** TM1 → TM2 → TM3 → TM4. TM2 and TM3 share a file, so they are **sequential, not parallel**.

---

## 5. Definition of done

Shared gate: CI. Each lane names the fault that must turn it **red**:

- **TM1** — a 500 from the route renders an **error**, and a genuinely empty library renders **"no templates yet"**; a test drives both and asserts they differ. Collapsing them is the repo's own recurring defect and the route's doc comment calls it out by name.
- **TM2** — a library holding three versions of one template shows **one** card; reverting the collapse makes the test fail. Search filters by name; sort changes order; both are asserted on rendered order, not on internal state.
- **TM3** — **opening the detail view issues zero `/preview-frame` calls**; pressing *Render preview* issues exactly one. This is the credit-safety gate and it is the one assertion that must not be vacuous — count network calls, not renders. Back restores the search term **and** the scroll offset, and returns focus to the originating card.
- **TM4** — `Use this template` writes `template@version` onto the draft; a test asserts the **pinned version**, not just the id, because D123's whole guarantee is that a running campaign never changes when the library does.

**Exactly one `DialogShell` is mounted at any time** — asserted by mount count, in both views. `BriefPicker` already documents why (F22).

---

## 6. What this plan does not do

- **It does not add `thumbnail` to `CreativeTemplate`.** T-D1's recommendation makes it unnecessary; if the owner picks (a), that is a domain change with a migration and belongs in the library's own arc.
- **It does not build template authoring or curation.** Browsing and picking only. Creating and versioning templates is `2026-09-08_creative-templates-and-units.md`'s arc.
- **It does not decide where Review lives.** Removing the wizard (SG-D2) displaces `ReviewStep`; that is the gap plan's question, not this one.
- **It does not touch the compositor.** The detail view's render is the existing `/preview-frame` path, unchanged.

---

## 7. Premises

`premise TM1` and `premise TM2` retired: **TM1–TM4 shipped in one PR.** The
client is `apps/web/src/lib/templates-api.ts` (`listTemplates` / `getTemplate`,
plus the pure `latestPerId` / `versionsOf` / `pinnableTemplate` the modal reads),
and the component is `apps/web/src/components/shell/TemplateLibrary.tsx`, mounted
once in `(shell)/layout.tsx` beside `BriefPicker` and `CreateCampaignDialog`. Both
fences probed exactly what left: the grep now hits the client, and the file exists.

Both premises were observed holding on `484fdf6b` before the lane started — the
grep exited 1 with the API routes and their two test files as the only repo-wide
hits, which is the state §0's table describes.

**Five things this lane found, recorded here rather than folded into the code:**

1. **A unit sort cannot reorder anything, so the listing sorts by version
   instead.** T-D3 recommends "sorts by name and unit". `ADVERTISING_UNITS` has
   exactly **one** member (`"standard-web"`, and `advertising-units.ts` states
   that one member is correct today), and the client refuses any value outside
   the vocabulary — so every record the library can serve carries the same unit
   and a unit sort is a control with nothing to do. It would also make §5's own
   DoD unsatisfiable: *"sort changes order … asserted on rendered order, not on
   internal state"* has nothing to assert. Version took its place; the unit still
   shows on every card. **T-D3's grouping half is unchanged** — `creativeType`
   does discriminate, and the many-to-many through `CAMPAIGN_TYPE_PRESETS` is
   named in the component rather than added to the record, as T-D3 asks.
2. **Only a canonical record is pinnable, and that is a domain limit, not a
   modal one.** `BriefTemplate.id` is `CanonicalTemplateId` and
   `isBriefTemplate` additionally requires
   `CANONICAL_TEMPLATES[creativeType].id === id`, so a library grown past the
   canonical three would serve records **no brief can carry**. Today that is
   invisible: `FsTemplateStore` is seeded from `CANONICAL_TEMPLATES` and nothing
   else, so every live record passes. `pinnableTemplate` returns `null` for one
   that does not, and *Use this template* refuses visibly with the reason rather
   than casting a record through to fail at the editor's restore boundary. The
   fix — a validated non-canonical template id — is a domain change with a
   migration and belongs to D123's own arc, exactly where §6 puts `thumbnail`.
3. **The pin lands on the shell's campaign, not on a mounted editor's draft.**
   `Use this template` writes `template@version` through `setBrief`, which is the
   campaign the left column this modal opens from displays. D35 is explicit that
   a draft is `EditorState` and not that brief, so a pin made while the editor
   holds unsaved edits reaches the shell and not the draft. Carrying it into the
   draft means the create seed (`CreateCampaignInput`, `isStoredSeed`) plus a
   reducer action on `applyPreset` — four files in the editor's lane, not this
   one's — and it needs a coherence rule this plan has not settled (a `video`
   template pinned into a static campaign type). Stated, not discovered later.
4. **The detail view's render needs a brief, and borrows the open campaign's.**
   T-D4 settles *when* the composite is requested and not *what is requested*:
   `/preview-frame` takes `{ brief, cell }`, and a template is ownerless (D123)
   so it can supply neither. The request is the open campaign's brief with its
   template swapped for the record on screen, at one fixed representative look
   (1:1, headline-top, bold) stated on screen beside the frame — a real brief,
   where a brief invented for a library record would be the fabrication D26
   forbids. `usePreviewFrame` could not serve this at all: it fetches from a
   mount effect after the debounce, which is what T-D4 forbids, so
   `fetchPreviewFrame` is now exported as the one-shot seam.
5. **Provenance needs a third state, not two.** T-D5 says "nothing when no
   campaign has pinned that template yet" — but the brief listing can also
   *fail*, and reading that as "nothing has used it" is the same conflation the
   list route refuses. The detail view distinguishes three: unknown (the listing
   failed, said out loud), none (nothing rendered, per T-D5), and named. The
   match is on **id and version**, because a campaign pinned one version and
   another version of the same id is a different record. `listBriefs` validates
   `file` and `products` and not `template`, so a stored brief with no template
   is read as pinning nothing rather than dereferenced.
