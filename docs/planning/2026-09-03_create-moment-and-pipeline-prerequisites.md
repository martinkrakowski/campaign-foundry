# The Create Moment & Pipeline Prerequisites — Architecture & Development Plan

**Date:** 2026-09-03
**Status:** for review
**Decision ids introduced:** D64 – D72 (D51–D63 are claimed by `2026-09-01_template-authoring-and-preview-fidelity.md` and `2026-09-01_r7-preview-panel.md`)
**Relates to:** D5 (brief id is a store key, not a field), D15 (a storage port before the S3 move), D35 (save and commit are one act), D37 (a brief's identity lives in the URL), D57 (new vocabulary lands in new optional fields), D62 (the template library is deferred)

---

## 0. What this plan answers

Two inputs arrived within a day of each other and change each other's meaning:

1. **A sketch for a "Create new campaign" modal** (`create-new.excalidraw`): campaign name, a
   world-map region picker with search, "start from a template", a drop zone with Add Link /
   Dropbox / Google Drive, then *Create campaign* and *Cancel*. The owner's stated intent: make the
   brief workflow "very intuitive", from authoring through Generate to the pipeline.
2. **The migration.** "We are going to migrate the entire application to a cloud based solution,
   e.g. server side database, s3 bucket, etc. … a cloud hosted, fully distributed and scalable
   creative pipeline."

This plan's central claim is that **the create moment is worth building now, but the modal as
sketched is not** — on either side of an identity decision the owner has not yet taken — and that
**two small API prerequisites are pure wins regardless of that decision** and unblock the
"seamless pipeline" objective more than any dialog does.

> **Provenance — two tiers, deliberately kept apart.**
>
> *Local tier (verified).* The sketch was read as JSON and compared with the code on `main` at
> `bb7fe4d` by five parallel readers plus a design adversary, producing 74 findings deduplicated to
> 58; the 26 highest-ranked were each challenged by three independent refuters (code, logic,
> default-skeptic) and all 26 survived the majority vote, most with severity corrections that are
> recorded here as the settled consequence. These are the **F-ids**.
>
> *Cloud tier (UNVERIFIED).* The same sketch was re-read under the migration by eight lenses,
> producing 67 findings deduplicated to 54. **The verification phase did not run**: every refuter
> and judge failed on a session limit. These are the **C-ids**. Each one names its basis — `code`
> (today's repo), `intent` (the recorded target in `.agents/architecture.md`, `.agents/tech-stack.md`,
> a D-id) or `design` (a distributed-systems judgment). The author re-read the code for the
> load-bearing ones and marks those **self-verified** with the line read; everything else in the
> cloud tier is a hypothesis this plan's two reviewers were asked to attack first (§8). No lane in
> wave 1 depends on an unverified cloud claim; the decisions that do are marked.

---

## 0.1 Proposed decisions

| id | Decision | Why |
|---|---|---|
| **D64** | **OPEN — the owner's call: the identity model.** *(a) Object-store-only:* the slug stays the storage key, as the recorded S3 shape has it (`.agents/architecture.md:87` maps `brief.id -> s3://bucket/briefs/<id>.yaml`; `:97` prefixes assets by `briefId`). Keys are immutable, a rename is copy-then-delete, uniqueness is bucket-global. *(b) Database-fronted:* a row with a surrogate id, a mutable display name, and the slug as a per-workspace unique column — what D5 was reaching for. **Nothing in wave 1 assumes a side.** The consequence table is in §1 (C1, C7, C12, C23, C24 — cloud tier). | Every finding about the sketch's first field, about rename, about assets keyed by slug, about drafts and about delete resolves differently on the two sides. The owner's own words ("server side database") lean (b); the repo's only recorded target is (a). Deciding this is the highest-leverage act in the migration and it is not a plan author's to take. |
| **D65** | **Create is a seam, not a POST.** The dialog hands `{ name, region, audience, mode, source? }` to one client function, `createCampaign()`, and receives `{ id, route }`. **The dialog derives no id and shows no slug**; the Identity section keeps its readout. Wave 1's implementation seeds the editor draft and writes nothing (§3 W1). Under D64(b) the implementation becomes a POST that mints a draft row and lands on `/brief/<serverId>`; the dialog does not change. **That (b) implementation reopens D35** — Save stops being the one act that creates a campaign, and C14 names the split into autosave, Publish and Run. Stated here; decided in the migration plan, not by this one. *(Review finding, gemini.)* | The only create verb today is `BriefStorePort.createBrief(brief)` keyed on a client-chosen `brief.id` (`brief-store.port.ts:53`; `fs-brief-store.ts:101`), and the editor computes that id on every name keystroke (`editor-state.ts:631-634`). A modal built as a thin UI over that POST bakes slug-as-identity into a second surface the migration must then unpick (C4, self-verified on the port signature). A seam makes the dialog fork-independent. |
| **D66** | **The create dialog *is* the Identity step, and lands the user on Copy.** It collects the four things the wizard's first step decides — name, region, audience, mode — and nothing the wizard does not require. (Mode is the dialog's only *choice* that a chosen start-from source overrides: the copy inherits the source's mode and W2 turns the toggle into a readout saying so.) The guided step list is unchanged in wave 1; the dialog lands on the Copy step via the existing step stash, and Identity stays reachable from the step bar for editing. *(Owner's option: retire step 1 in guided mode once the dialog is the only door. Default: keep it.)* | As sketched the modal was the Identity step minus its audience field, plus two things the API cannot back, and it retired nothing — a net additional screen (F12, adversary; verified). Audience is required by `validateIdentity` (`validate.ts:95`) and is prompt context for every generator; mode is the brief's first decision and reorders the steps (`sections/index.ts:40-45`). A dialog that collects all four can honestly skip step 1. |
| **D67** | **Ask, then write.** The dirty guard answers *before* the dialog opens (`guardedAction(openDialog)`); Create then navigates with a plain push. A cancelled create leaves nothing behind — no draft key, no file, no row. The same rule is applied to the picker's Duplicate, which today POSTs before the guard asks (`BriefPicker.tsx:85` then `:94`). | Every current "Create new" runs the guard first (`Sidebar.tsx:36-41`; `BriefPicker.tsx:68-73`); a modal that navigated on Create would ask "leave anyway?" after five fields were filled (F7). In a shared store a write-before-answer is a row every collaborator lists, with no delete route (C25 — cloud tier, mechanism verified locally: `routes/campaigns/briefs/` holds only `[id].put.ts` and `[id]/duplicate.post.ts`). |
| **D68** | **The brief boundary checks shape, not just presence.** `parseBrief` rejects an array or object where a scalar belongs (`targetRegion`, `targetAudience`, `campaignMessage`, `localizedMessage`) and a non-object product entry, in both modes. **It keeps accepting `null` and `""`** — the D15 authoring leniency — because the lister skips any file the parser throws on (`fs-brief-store.ts:57-61`), and a YAML `targetAudience:` with no value parses to `null`; tightening that would make an operator's half-written brief vanish from the picker. No new brief field lands without its own shape check. | Today `REQUIRED_FIELDS` is checked with `field in record` (`load-brief.ts:25, 556-559`) and the record is cast (`:599`). A list-typed region is persisted, then crashes the editor on reload (`validate.ts:94` calls `.trim()`) and the headline-pool route (`OpenRouterCopyGenerator.ts:34`), while the image adapters silently render "DE,US" (F2, verified). In a multi-client cloud API the editor is one writer among several and the corrupted object is shared (C8). This is a migration prerequisite that costs one lane now. |
| **D69** | **Additive fields only, region included.** `targetRegion` stays the single-string prompt context. If several markets per campaign are ever wanted, they arrive as a **new optional field** (e.g. `markets?: { code; locale?; localizedMessage? }[]`), absent → today's single run byte-identical, appended to `BRIEF_KEY_ORDER`. **The region control is the chip vocabulary plus Other**, as the Identity step renders it (`IdentitySection.tsx:14, 177-189`); a map may illustrate the selection, `aria-hidden`, never be the control. | Verified this plan's own premise: `hashPolicy` never reads the region (`VariationPolicy.vo.ts:265-288`), so D57's hash rule does *not* forbid widening — what forbids it is the additive-field discipline every extension has followed (`copy`, `style`, `ratio`, `anchor` in `CampaignBrief.ts`) and the four scalar consumers that would break (C17). The map cannot address GLOBAL, APAC or Other — the rendered silhouette is cropped before Asia — and DE sits inside EU (F10, F11, F15; verified). |
| **D70** | **No control advertises a capability the host does not have** (extends DESIGN.md §5 capability gating). Add Link, Dropbox and Google Drive are out of wave 1 entirely; the multi-file drop zone is out of wave 1; when uploads return to the create moment their limits come from a capabilities response, not a constant. | Nothing exists for any of the three sources (F14, verified by grep), and "Add Link" is worse than dead: a URL previews in `LogoField` but is dropped at compose time, shipping a logo-less creative (F14 correction). Under the migration these become an ingestion service with its own auth and an SSRF surface (C27) — a separate plan. |
| **D71** | **"Start from an existing campaign" is Duplicate with overrides, and Duplicate copies the copy pool.** The dialog's own name, region and audience win over the source's. **The word "template" is reserved for the D62 look**; the D62 *library* stays deferred until D64 is (b). | No template library exists; in code the word means the per-brief style block (F3, verified). Duplicate exists and copies assets with path rewriting (`duplicate.post.ts:55-64`) but **never touches `briefs/<id>/pools.json`** — `duplicate.post.ts` does not import `pools.ts` (self-verified: consumers of `pools.js` are `pipeline.ts`, `plan.post.ts` and the three `pools/` routes) — so a duplicated randomized brief using `pool://copy` arrives unable to plan (C9). |
| **D72** | **Ownership attaches at Create — as a dependency, not a wave-1 lane.** Before any per-workspace list exists, both ports gain a scope axis; until then the dialog's "start from" list is the whole store and says nothing else. | No user, tenant or ownership concept exists anywhere: `listBriefs()` takes no argument (`brief-store.port.ts:26`), `listAssets(briefId)` is keyed by slug alone (`asset-store.port.ts:35`). The grep for tenancy words hit six files of incidental prose (C6, C15 — lens-verified only). The migration plan owns this; this plan names it so the dialog is not specified as if the list were the world. |

---

## 1. Findings

### 1.1 Local tier — verified against `bb7fe4d`

Severity is the refuters' settled consequence, not the raw label.

| id | Finding | Anchor |
|---|---|---|
| **F1** | **Region is one string end-to-end; the sketch's add/remove map is multi-select.** The domain, the image port, the editor state and the chip group are all scalar. | `CampaignBrief.ts:15`; `ImageGeneratorPort.ts:13`; `chip-group.tsx:31` |
| **F2** | **A list-typed region is persisted, then crashes the editor on reload and the pool route**; the image adapters coerce it to "DE,US" silently. Root cause: the presence-only check. | `load-brief.ts:557, 599`; `validate.ts:94`; `OpenRouterCopyGenerator.ts:34` |
| **F3** | **No template library; "template" means the per-brief style block; Duplicate is the source.** Low severity as wiring: no user-visible string uses the word. | `LayoutSection.tsx:88-89`; `duplicate.post.ts:10-17` |
| **F4** | **"Create campaign" as a file write persists a brief the editor refuses to save.** `{id, region, audience:"", message:"", products:[]}` passes the parser. The editor then opens it with every error revealed at once. | `load-brief.ts:25, 565`; `briefs.post.ts:71`; `BriefEditor.tsx:391` |
| **F5** | **The sketch never asks who the campaign is for.** Audience is required by the editor and consumed by both generators. Low severity as coherence: the field is quiet, not red, on landing; the footer status names it. | `validate.ts:95`; `BriefEditor.tsx:1041-1046` |
| **F6** | **A written skeleton opens dirty, red, and name-locked, with Save as… refused and no delete route.** The strongest single argument against writing on Create under today's store. | `editor-state.ts:1220-1224`; `IdentitySection.tsx:115`; `BriefEditor.tsx:874-875` |
| **F7** | **Guard timing.** Today the guard runs first everywhere; a modal that navigates on Create moves the question after the form. Settled as a rule, not a defect: ask once, never write before the answer — either guard the open or guard the verb. | `Sidebar.tsx:38-40`; `editor-dirty-context.tsx:74` |
| **F8** | **On `/brief/new` a shell modal cannot create by navigating: the same-URL push resets nothing**, and the shell has no dispatch into the mounted editor. A seed needs a one-shot carrier the editor consumes on mount *and* watches while mounted. | `BriefEditor.tsx:736-746`; `layout.tsx:42` |
| **F9** | **Rename after an early upload strands assets under the old slug**: the save-time rescue copies a folder only when a product path references it. Status quo for the wizard's eager uploads; new for an unattached drop zone. | `assets.post.ts:31`; `briefs.post.ts:51-52`; `asset-files.ts:109` |
| **F10** | **The local (A)-over-(B) verdict**: seed the draft, write nothing. **Superseded** — see §7: it rested on the file store holding only complete briefs. | `BriefEditor.tsx:777, 816-819` |
| **F11** | **A silhouette map cannot address the six-token vocabulary**: GLOBAL and Other have no geometry, DE sits inside EU, APAC is off the rendered map. The control is the chip group. | `IdentitySection.tsx:14, 178`; `chip-group.tsx:31` |
| **F12** | **Adversary: the modal is a second, weaker Identity step that retires no wizard step.** Answered by D66. | `sections/index.ts:44`; `IdentitySection.tsx:146, 177` |
| **F13** | **A clickable SVG map is keyboard-unreachable, unnamed and colour-only** unless every region is a real, named, `aria-pressed` control — at which point it is a chip group with a picture behind it. | `dialog-shell.tsx:23`; DESIGN.md §7 |
| **F14** | **No Add Link, Dropbox or Drive path exists**; the only OAuth-shaped code is Firefly's IMS exchange. A pasted URL previews then is dropped at compose time. | `FireflyImageGenerator.ts:131`; `assets.post.ts:16`; `LogoField.tsx:72-79` |
| **F15** | **A world-map picker has nothing to build on**: no SVG, no geo library, no select control in the kit; happy-dom cannot hit-test it. Cost large, web-only, unjustified by six values. | `apps/web/package.json`; `messages.ts:30` |
| **F16** | **Six sections at 1454 px vs "five things, then a door"**; the dialog body scrolls inside 80 vh and the verbs must live in `DialogFoot`. Low severity, implementation note. | `dialog-shell.tsx:193, 246`; DESIGN.md §5 |
| **F17** | **Campaign Name is never persisted**; after the first save every view shows the slug. Already true on every path today; a dialog must not promise otherwise. | `editor-state.ts:631-634, 1324` |
| **F18** | **The modal must import, not reproduce, the Identity step's rules** — `slugify`, `SAFE_ID_PATTERN`, the duplicate check, the strings. Two implementations drift. Answered by D65 (the dialog derives no id at all). | `validate.ts:88-101`; `BriefEditor.tsx:895-898` |
| **F19** | **Seeding via `cf:draft:new` silently overwrites an abandoned draft the recovery exists to keep.** The carrier must be a separate one-shot key, merged onto whatever the editor restores. | `editor-state.ts:373-378`; `BriefEditor.tsx:404-411` |
| **F20** | **Copy pool is a second per-slug store that Duplicate does not copy** (critic). Qualifies "start from an existing campaign". | `pools.ts:19-21`; `duplicate.post.ts:55-64` |
| **F21** | **The D35 three-way fires on an untouched skeleton**: under a written create, `draftDiffers` is true on arrival and Generate opens "Run this draft / Save and run" on a screen the user has not touched. | `BriefEditor.tsx:476-479, 964-989`; `Header.tsx:222-225` |
| **F22** | **Two entry points nobody counted**: the first-run auto-opened picker (a modal over it stacks two dialogs at the same layer) and the `/new` server redirect no shell modal can intercept. Below `lg`, Create new lives only in the mobile menu footer, which closes itself before the guard prompts. | `run-context.tsx:479-486`; `new/page.tsx:8-10`; `MobileMenu.tsx:147` |
| **F23** | **Tests that pin today's Create-new behaviour** and must be updated deliberately, never deleted: `shell-nav.test.tsx:351-359, 377-400`; `BriefPicker.test.tsx:49-55`; `shell-modals.test.tsx:273, 318-330`; `brief-editor.test.tsx:368-377, 393-406, 428-448, 3209, 3414-3421`; `new-redirect.test.ts:10` (unchanged). The jargon gate scans only `campaign/messages.ts`; strings elsewhere are ungated. | as listed |

### 1.2 Cloud tier — UNVERIFIED hypotheses (basis in brackets; "self-verified" = the author re-read the anchor)

| id | Finding | Verification |
|---|---|---|
| **C1** | [intent] **Campaign Name is the fork made visible**: under (a) the slug is still the immutable identity and "Summer Spark" becomes `summer-spark` forever at Create; under (b) the name is a column and the sketch's field is honest without editor surgery. | self-verified: `architecture.md:87`; `editor-state.ts:1270, 1324` |
| **C2/C3/C13** | [design] **The (A)-over-(B) verdict flips under (b)**: a draft row with a status dissolves the parse gate, the name freeze and the orphan; under (a) every front survives and the orphan becomes a shared object with no delete. | reasoning only |
| **C4** | [code] **No server allocates an id.** The only create verb takes a client-chosen id; the only server-minted identifier is the job UUID in an in-process map. A dialog built over today's POST bakes that in on both sides. | self-verified: `brief-store.port.ts:53`; `fs-brief-store.ts:101`; `jobs.ts:61` |
| **C5** | [intent] **Duplicate-id checks become advisory**: the per-process lock (`fs-brief-store.ts:225-237`) is not a lock across instances; the 409 is the truth, the listing a hint; under (a) collisions are bucket-global and leak another tenant's campaign name. | lens only |
| **C6/C15** | [code] **Neither port takes a tenant; Create records no owner.** | grep self-run; six hits not individually read |
| **C7** | [intent] **Rename orphans assets under the slug-keyed S3 shape even under (b)**, unless assets are re-keyed to the surrogate id — a second decision D64 does not make by itself. | self-verified: `architecture.md:97, 100` |
| **C8** | [design] **The presence-only boundary worsens with untrusted multi-client writers.** | mechanism verified locally (F2) |
| **C9** | [code] **Duplicate never touches the pool; a `pool://copy` source arrives unable to plan.** | self-verified: consumers grep; `duplicate.post.ts:55-64` |
| **C11** | [code] **A server-minted id breaks `createBrief(brief)`** in five places: port, adapter, parser (`id` is required and asserted a slug), client function, reducer. | self-verified: `load-brief.ts:25, 564`; `briefs-api.ts:197-203`; `editor-state.ts:1025` |
| **C12** | [code] **Under (a) the slug keys six stores** — brief, assets, pool, report, packages, job map — and only the first two sit behind a port. | self-verified: `report.ts:21-23`; `package.post.ts`; `jobs.ts:59-62` |
| **C14** | [design] **"Save and commit are one act" splits into autosave, Publish and Run**; the dialog's Create is none of them — it inserts a draft — and Publish must be enforced server-side. | reasoning only |
| **C16** | [code+intent] **The recorded S3 shape proxies uploads** (`PutObject` with bytes in hand, `architecture.md:98`), so the magic/size checks survive; a presigned client PUT is an *unrecorded* option that would need post-upload validation and a third asset state. | self-verified: `architecture.md:98`; `assets.post.ts:40-63` |
| **C17** | [code] **Widen nothing: the hash never reads region**; the additive-field discipline and four scalar consumers are what forbid it. | self-verified: `VariationPolicy.vo.ts:265-288` |
| **C18/C22** | [code] **Every run store is keyed by campaignId alone**, and rendered bytes are keyed by product/ratio only — two campaigns sharing a product id already overwrite each other's PNGs; a market fan-out makes that N-way. | lens only; `GenerateCampaignUseCase.use-case.ts:271-273` not re-read |
| **C19** | [code] **`localizedMessage` is one market's copy**; the copy port's `locale` is half-built and no route sets it. | lens only |
| **C20/C21/C28** | [design] **Template as an entity is a (b)-only concept; apply by snapshot at create time, never late-bound** — the revision digest and the preview's one-derivation rule both break under late binding. | reasoning only |
| **C24/C25** | [design] **`cf:draft:new`, the same-URL no-op and the guard's write-ordering dissolve under (b) with server drafts; persist under (a)** and gain a multi-device hole. | reasoning only |
| **C26/C27** | [design] **Presigned uploads and external ingestion** are migration-plan work; Add Link becomes a queue job with an SSRF surface. | reasoning only |
| **C31** | [code] **D37 binds the route to the slug**: rename breaks links; a surrogate id must still pass `SAFE_ID_PATTERN` or the `[id]` route refuses it. | lens only; `validate.ts:32` pattern is `^[a-z0-9][a-z0-9-]{0,63}$`, which a lowercase UUID satisfies |

---

## 2. The recommendation

**Decide D64 first, but do not wait for it.** Wave 1 is three lanes that are correct on both
sides of the fork and one that only matters under the seed implementation:

- **P1 and P2 are prerequisites the pipeline needs regardless of any dialog.** P1 closes the one
  boundary hole that turns a bad client into a corrupted shared brief. P2 puts the copy pool
  behind a port — the last store the *create* flow touches directly — and makes Duplicate honest.
- **W1 builds the create moment as a dialog over a seam.** It is the Identity step in a dialog,
  it lands on Copy, it derives no id, and its Create verb is one function whose body swaps when
  D64 is decided. Everything in it that is UI survives the migration; the only throwaway is the
  seed implementation of the seam, which is small and isolated by construction.
- **W2 adds "start from an existing campaign"** on Duplicate-with-overrides, and **W3** closes the
  one hazard the seed implementation introduces (F19).

**What this plan does not build**, each with the decision it waits on, is in §6. The sketch's
map, its three external sources and its multi-file drop zone are all there.

**What the local review got wrong** and this plan corrects: its (A) recommendation is provisional,
not settled (§7).

---

## 3. Lanes

One lane per PR. Ownership is exclusive among *concurrent* lanes; the W lanes are sequential and
may touch each other's files only after the previous one has merged.

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **P1** | **Typed shape checks at the brief boundary** (**D68**). In `parseBrief`, after the presence loop: `targetRegion`, `targetAudience`, `campaignMessage`, `localizedMessage` must be `string`, `null` or absent — an array or object throws with a message in the parser's existing voice; each `products` entry must be a plain object (today only its `id` is asserted). Both modes. **Do not reject `null` or `""`** (the lister skips files whose parse throws; a YAML `targetAudience:` with no value is `null`). Tests: a list-typed region is a 400 on `POST /campaigns/briefs`, on `generate` and on `plan`; a `null` audience still lists; every existing fixture still parses byte-identically. **Accepted consequence:** a hand-edited brief that already carries a list-typed region stops being listed (the lister skips and warns, `fs-brief-store.ts:57-61`) instead of crashing the editor on open (F2) — the warn line names the file, and the PR body says so. Mutation check: remove the new branch and show the list-region test failing. | `apps/api/server/lib/load-brief.ts`, `apps/api/server/lib/__tests__/load-brief*.test.ts`, route tests that post malformed bodies | F2's root cause closed; C8's cloud-tier risk closed before it exists. |
| **P2** | **A `PoolStorePort`, and Duplicate copies the pool** (**D71**). New `ports/pool-store.port.ts` (`readPool`, `writePool`, `copyPool(from, to)`, `withPoolLock`) with an fs adapter that keeps today's `briefs/<id>/pools.json` path and symlink refusal; `pools.ts` keeps `planInputFor`/`pooledPlanner`/`wantsHeadlinePool` and reads through the port; the three `pools/` routes and `plan.post.ts`/`pipeline.ts` consumers unchanged in behaviour. `duplicate.post.ts` copies the pool inside the `withBriefLock(newId)` it already holds, and gains an optional `overrides` body (`targetRegion`, `targetAudience`, and — because the copy is a new brief — the caller's chosen `newId` already exists) applied after the spread and before `parseBrief`-equivalent validation. The merged brief goes through `parseBrief` before the create, so P1's shape checks apply to overrides too. **`mode` is deliberately NOT an override**, and the route says so in a comment: overriding a classic source to `"variation"` needs a `variation.count`, which `parseBrief` requires (`load-brief.ts:593-596`) and which is an *editor* default (`"12"` at `editor-state.ts:401`), not the route's to invent; the reverse direction leaves the source's `variation` block in the file, structurally valid but inert (`validateVariation` runs unconditionally, `load-brief.ts:574`). W2 answers the UI side. *(Review finding, Qodo #2 — finding accepted, its remedy refuted.)* **Non-atomicity is a stated property, not a transaction:** the route copies assets, then the pool, and creates the brief **last**, so a failure leaves inert prefixes and never a listed brief missing its pool. One test covers it — a failure injected after the pool copy leaves no listed brief. Known gap, owned by the migration plan, not patched here: a *fresh* create under an id whose earlier duplicate failed part-way would adopt the orphaned pool, because `briefs.post.ts` never touches pools; a re-run of the duplicate itself overwrites the orphan and self-heals. *(Review finding, Qodo #4 — property accepted, staging/commit refuted.)* Tests: duplicate of a `pool://copy` source plans; duplicate without a pool still 201s; overrides win; **a list-typed region override is a 400** *(review finding, gemini — this is why P2 follows P1)*; a symlinked pool dir is refused as today. | `apps/api/server/lib/pools.ts`, `apps/api/server/lib/ports/pool-store.port.ts` (new), `ports/fs-pool-store.ts` (new), `ports/index.ts`, `routes/campaigns/pools/*`, `routes/campaigns/briefs/[id]/duplicate.post.ts`, their tests | C9/F20 closed; the last create-flow store is portable (D15); W2 has a route to call. |
| **W1** | **The create dialog and the seam** (**D65**, **D66**, **D67**). *(1)* `CreateCampaignDialog` on `DialogShell`: name (`Input`), region (`ChipGroup` over `REGION_OPTIONS` with Other, as Identity renders it), audience (`Input`), mode (`ModePanel`, default classic); *Create campaign* and *Cancel* in `DialogFoot`; Create never disabled — an empty name or audience answers in a `role="status"` line with the Identity step's own strings. Title and description are house dialog scale; the description is one sentence in `messages.ts`, not the sketch's placeholder. *(2)* The seam: `createCampaign(input): Promise<{ id; route }>` in a new `lib/create-campaign.ts`; wave-1 body = write a one-shot seed and return `{ id: "", route: "/brief/new" }`. *(3)* **The seed carrier — the lane's hardest mechanic, named here so it does not thrash:** a `cf:create-seed` key in the `cf:step-handoff` shape (`{ name, targetRegion, targetAudience, mode }`), consumed once. The editor consumes it *on mount* on the blank route **and** *while mounted* there, via a `CreateSeedProvider` in the shell layout that the editor subscribes to (the same-URL push resets nothing — F8). Applying a seed **never calls `requestReplace`**: the guard was the one question (D67), asked before the dialog opened, and `guardedAction` does not reset the editor's dirty state — so a seed that asked again through `requestReplace` (`BriefEditor.tsx:714-721`, which re-evaluates `isDirtySinceSave`) would pop *Unsaved edits* a second time on a dirty `/brief/new`. *(Review finding, gemini — blocker, accepted.)* The seed applies directly: `purgeDraftFromStorage`, `dispatch load blankBrief()`, then **`patch` actions** for name/region/audience and the mode action, so slug derivation stays in the reducer (F18); then `go("copy")` in place, or `stashStep("copy")` before a push from another route. *(4)* Entry points rewired through the guard: `BrowseBriefsButton` (desktop and mobile), the picker's Create new row, the editor's "New brief…", the M3 empty-state link, **and the picker's Duplicate — the one site where D67 is violated today**: `confirmDuplicate` awaits `duplicateBrief` (`BriefPicker.tsx:85`) and only then calls `guardedAction` (`:94`), so a declined prompt leaves a created brief behind. The whole async sequence moves inside the guarded callback. **Mind the signature:** `guardedAction` takes `() => void` and returns `false` when it parks the action (`editor-dirty-context.tsx:52, 71-83`), so the callback owns its own `duplicating` flag and its own `setActionError` — the outer `try/catch/finally` cannot wrap a parked action, and a `finally` that clears `duplicating` before the parked action fires is the bug to avoid. Regression test: decline the prompt, assert no POST. *(Review finding, Qodo #1 — accepted.)* Direct URLs (`/brief/new`, the `/new` redirect) stay the blank editor — the dialog is a door, not a wall. The first-run picker closes before the dialog opens (F22). *(5)* F23's tests updated deliberately; new tests: guard-before-open, Cancel leaves no key, seed applied in place on the blank route, seed applied on mount from the grid, slug readout shown only in Identity. | `apps/web/src/components/shell/CreateCampaignDialog.tsx` (new), `apps/web/src/lib/create-campaign.ts` (new), `apps/web/src/lib/create-seed-context.tsx` (new), `apps/web/src/app/(shell)/layout.tsx`, `components/shell/Sidebar.tsx`, `components/shell/BriefPicker.tsx`, `components/campaign/BriefEditor.tsx` (seed consumption, `createNew`), `components/campaign/messages.ts` (append), the tests in F23 | The create moment, fork-independent; the Identity step answered in one screen; nothing baked in that the migration unpicks. |
| **W2** | **Start from an existing campaign** (**D71**). A `StartFromExistingPicker` inside the dialog listing `listBriefs()` rows (id · products · region, as the picker shows them) with an M3-voice empty state and error state in `messages.ts`. Choosing one turns Create into `duplicateBrief(sourceId, newId, overrides)` through the seam — `newId` derived by the seam, not the dialog — then a plain push to `/brief/<newId>`, inside the guarded action (D67). **Choosing a source replaces the mode toggle with a readout** naming the source's mode ("This copy starts as a Randomized campaign — change it in the wizard"), because the copy inherits the source's mode (P2). It is a readout, **not a disabled control**: DESIGN.md §5 lets only work in flight disable a control, and a source-chosen mode is neither an invalid draft nor a host capability, so neither of §5's two rules licenses a dead toggle. *(Review finding, Qodo #2 — the UI half.)* The word "template" appears nowhere. | `CreateCampaignDialog.tsx` (mount slot only), `components/shell/StartFromExistingPicker.tsx` (new), `lib/briefs-api.ts` (`duplicateBrief` gains `overrides`), `lib/create-campaign.ts`, `messages.ts` (append), their tests | The sketch's "template" row, honestly named and backed by a route that copies everything including the pool. |
| **W3** | **The seed never destroys an abandoned draft** (F19). Before writing the seed, read `cf:draft:new`; if it holds a non-pristine draft, the dialog asks *resume it or start over* (its own two-way, inside the dialog, not the guard's). "Resume" opens `/brief/new` with no seed. **Scope condition — ask only where the guard could not:** capture `isDirty` (exposed by `useGuardedNavigation`) at the moment the create gesture starts, before the guard runs; when it was `true` the user has already answered *leave anyway?* about this very draft (the autosave effect writes any non-pristine state to `cf:draft:new`, `BriefEditor.tsx:450-454`), so W3 stays silent and the seed proceeds. It asks only when the guard was not engaged — no editor mounted, so `isDirty` is `false` (`BriefEditor.tsx:445-446` sets the flag only from a mounted editor and clears it on unmount) — which is F19's actual case: a draft from an earlier session, invisible from `/grid`. The two cases are exhaustive: a mounted editor on the blank route restores the stored draft on mount (`BriefEditor.tsx:339-352`), which makes it non-pristine and therefore dirty, so "mounted, pristine, stale draft on disk" cannot persist. *(Review finding, Qodo #3 — accepted.)* | `CreateCampaignDialog.tsx`, `lib/create-campaign.ts`, `editor-state.ts` (a read-only `hasRecoverableDraft(key)` helper), tests | The one hazard the seed implementation adds, closed. Dissolves under D64(b). |

**Order.** P1 ‖ W1 now, on disjoint files. P2 after P1 merges (its override test asserts P1's
400). Then W2 (needs P2's route), then W3 (needs W1). Parallelism cap 3. **Nothing in wave 1 assumes a side of D64**; the only wave-1 code that D64(b) retires is
the body of `createCampaign()` and W3.

**Explicitly not in wave 1:** the estimate sentence in the dialog (it needs a product count the
dialog does not have), the drop zone, the map, the external sources, retiring guided step 1.

---

## 4. Definition of Done

For every lane, before the PR is opened:

- The existing gate is green in the lane's worktree: `yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn sync:check && yarn test:cov`, with 100 % on all four counters kept.
- **A mutation check per behavioural claim**: the lane's PR body names the source mutation that makes each new test fail, and it was run. A test that cannot fail against the defect it names is not done.
- Every new user-facing string lives in `campaign/messages.ts` and passes the jargon gate; no string in a section or shell file.
- No `getBoundingClientRect` or computed-style assertions (happy-dom performs no layout); no class-string assertions as proof of layout (D47).
- **P1**: every fixture under `briefs/sample-*` and every test fixture still parses; the list-region 400 is proven on all three routes.
- **P2**: `arch validate` passes with `pools.ts` free of `node:fs` except inside the fs adapter; the duplicate-of-a-pooled-brief test plans successfully.
- **W1**: the guard prompts exactly once for a dirty editor (before the dialog); Cancel leaves no `cf:create-seed`; the seed applies in place on `/brief/new` and on mount from `/grid`; no slug is rendered anywhere in the dialog; F23's tests are updated with a one-line reason each, none deleted.
- **W2**: a duplicated `pool://copy` source can plan; overrides from the dialog win; the empty and error states use `messages.ts`.
- PR body carries a *Deviations* section, even if empty.

---

## 5. Open questions — for the owner and the reviewers

1. **D64.** Object-store-only, or database-fronted? The consequence table (C1, C7, C12, C23, C24)
   is unverified but each row names its mechanism; the author's reading is that (b) is what
   "server side database" means, and that (a) keeps every slug-as-identity consequence forever.
2. **D66's option.** Once the dialog is the only door, should guided mode retire step 1?
3. **The asset key under (b).** Even with a surrogate row id, assets keyed by slug still orphan on
   rename (C7). Re-key assets to the row id, or accept copy-then-delete?
4. **D64-independent but urgent:** the per-process one-run-per-campaign lock (`jobs.ts:82-85`)
   and the 409-adopt behind it stop nothing across instances. This plan does not own it; it
   belongs at the top of the migration plan's list.
5. Does any lane above assume a side of D64? (The question the reviewers were asked to answer.)

---

## 6. Explicitly deferred — each with the decision it waits on

| Item | Waits on | Why not now |
|---|---|---|
| Server-side drafts, autosave to a row, a `status` column, Publish as a server-enforced transition (C14) | D64(b) | No row exists to autosave to; under (a) there is no draft home but a slug-keyed object. |
| Server-minted ids through the port (C11) | D64(b) | Touches port, adapter, parser, client and reducer together; a plan of its own. |
| Ownership and a scope axis on both ports (D72) | the migration plan | No user model exists; the dialog's list is global until then. |
| The D62 template library as an entity, applied by snapshot (C20, C21) | D64(b) | Under (a) "template" can only mean Duplicate. |
| Markets as a new optional field, per-market copy and pools, a run identity of (campaign, market) (C17–C19) | D69's shape decided; a report/output port | Every run store is keyed by campaignId alone; a fan-out overwrites itself. |
| Presigned uploads with post-upload validation; the drop zone's return to the create moment (C16, C26) | the migration plan | The recorded S3 shape proxies uploads; presigned is an unrecorded option. |
| Add Link as an ingestion job; Dropbox and Drive (C27) | an ingestion service with an SSRF design | Nothing exists; a link that previews and then drops the logo is worse than none. |
| Ports for reports, packages and output bytes; queue-backed jobs and a distributed run lock (C12, C22, §5.4) | the migration plan | Not the create moment's to fix, but the "seamless pipeline" objective does not survive without them. |
| The world-map region picker | never, as a control (D69) | A picture may illustrate the chips. |
| The estimate sentence in the dialog | a product count | Meaningless at zero products. |

---

## 7. Corrections this plan records

- **The local review's (A) recommendation is superseded, not amended.** It rested on the file
  store holding only complete briefs and on localStorage being a good enough draft home. Under
  D64(b) neither premise holds; D65 makes Create a seam so the verdict can flip without rebuilding
  the dialog.
- **The facts sheet given to the analysts was wrong in three places**, all caught by refuters:
  `briefs/` *is* gitignored except `sample-*` (`.gitignore:43-45`, PR #167); the cited
  `editor-state.ts:88-94` is the `ProductDraft` interface, not the layout template; DESIGN.md never
  names the dialog kit — the anatomy is documented in `dialog-shell.tsx` only.
- **DESIGN.md's control table lags the code on region**: §5 files it under free text, §4 and the
  code render a chip group. The code is the authority here; the table should be fixed separately.
- **"D57 forbids widening `targetRegion`" was the author's premise and it is false**: the hash
  never reads region. The prohibition is the additive-field discipline and the scalar consumers.
- **The cloud tier is unverified** (provenance note). Twenty-four local findings and fifty-four
  cloud findings were not refuter-checked; the ones this plan leans on are marked self-verified.
  The two plan reviewers were asked to attack that tier first; their verdicts are in §8.
- **v1 of this plan had the seed re-asking the guard's question** (`requestReplace` inside the seed
  application) and **left D65's reopening of D35 unstated**. Both caught by review (gemini);
  corrected in W1 and D65.
- **v1 declared D67's ask-then-write rule for the picker's Duplicate and assigned it to no lane.**
  W1 owns `BriefPicker.tsx` but its task list named only the Create-new row. Caught by review
  (Qodo #1); the site and the `guardedAction` signature wrinkle are now in W1 item (4).
- **v1 collected a mode in the dialog that a start-from-existing create would silently ignore.**
  Caught by review (Qodo #2). Its proposed remedy — carry `mode` in the override contract — is
  **refuted**: it would 400 on a classic source (no `variation.count`) and strand an inert
  `variation` block on the reverse. The copy inherits the source's mode; W2 turns the toggle into a
  readout. The author's own first remedy (*disable the control and show the reason*) is **also
  refuted**, by DESIGN.md §5: only work in flight may disable a control, and this is neither an
  invalid draft nor a host capability.
- **v1's W3 would have asked about a draft the guard had just discussed.** Caught by review
  (Qodo #3); W3 now carries the `isDirty`-at-gesture-start scope condition, and the plan records
  why the two cases are exhaustive.
- **Qodo's atomicity demand (staging/commit or rollback across three stores) is refuted as
  disproportionate**, and its premise corrected: the plan never claimed the lock was a transaction,
  and the existing write order already puts the brief last so a partial failure cannot list a brief
  missing its pool. The property, the one failure test and the one genuinely new gap (a fresh create
  adopting an orphaned pool) are now stated in P2, with the transaction story left to the migration
  plan.

---

## 8. Review record

Both reviewers ran read-only against the code, were told which tier was unverified, and were
asked to attack it first and to answer §5.5 ("does any lane assume a side of D64?").

**gemini-3.1-pro (high), 2026-09-03 — verdict: approve-with-changes.**
Cloud tier: C1, C4, C7, C9, C11, C12, C16, C17 all **hold**, each with the line read. §5.5: no lane
assumes a side. Findings: *(blocker, W1)* the seed's `requestReplace` would re-ask the guard —
**accepted**, W1 rewritten; *(high, D65)* the (b) implementation reopens D35 unstated — **accepted**,
D65 now says so; *(medium, P2)* overrides need the list-typed 400 test — **accepted**, and P2 now
follows P1. Its answer to §5.4 (P1 hides a list-region brief from the lister rather than crashing
the editor) is recorded in P1 as an accepted consequence. Its reading of P2's lock question: copying
inside `withBriefLock(newId)` is sufficient because `writePool` renames atomically
(`pools.ts:112`) — adopted.

**grok-4.6 (high), 2026-09-03 — NOT DELIVERED.** Launched on the same brief at 09:44 and still
producing nothing at 11:03: 78 minutes elapsed, 34 seconds of cumulative CPU, zero bytes written,
no error. Treated as stalled rather than waited on. The plan therefore carries **one** independent
plan review, not two — model diversity on the *plan* is weaker than intended, and the
`docs/planning` convention's two-reviewer pass is satisfied only in part. If grok lands later its
findings arrive as a follow-up commit on this branch.

**Qodo (PR bot), 2026-09-03 — four findings, all against this plan, all verified against the code
by the orchestrator before disposition.** Three accepted as plan defects (the unassigned Duplicate
guard fix; the silently-ignored mode; W3 re-asking the guard's question), each now fixed in the
lane that owns the file. One accepted as a property with its remedy refuted (duplication is not
atomic — stated, tested at one point, and left to the migration plan rather than given a
staging/commit protocol). Two *remedies* were refuted with the mechanism, including one of the
author's own; see §7. CodeRabbit skipped the file by path filter (`!docs/planning/**`), so it
contributed nothing.

**Verification note.** The adversarial check of these four dispositions was to run as a subagent
fan-out; every agent failed twice on HTTP 529, so the checks were done by the orchestrator in the
main loop, reading each cited site directly. Two of the four remedies changed as a result. That is
weaker than an independent pass and is recorded as such.
