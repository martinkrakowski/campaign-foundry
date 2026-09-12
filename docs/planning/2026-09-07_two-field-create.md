# The Two-Field Create — Architecture & Development Plan

**Date:** 2026-09-07
**Author:** orchestrator
**Status:** draft — for the owner's review
**Verified against:** `main` at `1f0944c` (the graphics arc merged; gate green, 100 % ×4)
**Decision ids introduced:** D97 – D101
**Relates to:** **D86** (the dialog's question set), **D66** (the dialog is the Identity step, and
where Create lands), **D71** (start-from), **D8 / DESIGN.md §5** (gating blocks *entering* a state,
never leaving one), **D92** (the kit stays in `apps/web` — this plan reverses it), **D94** (the map)

---

## 0. What this plan answers

The owner reviewed the shipped dialog in the browser and asked for three things: cut it to a
**campaign name** and a **template type**; move everything else into the editor's **Everything** and
**Guided** views with no duplication; and make the components reusable via **`packages/ui`**.

**Two readings were confirmed with the owner before this plan was written**, because each changed
its size:

- **"Template type" means the campaign mode — Classic / Randomized**, not the `static` / `motion`
  render format. This matters enormously. `format` is `output.formats` (an array nested under
  `output`, `CampaignBrief.ts:91`), and it is **gated at the API, not just the UI**:
  `load-brief.ts:603` refuses a classic brief requesting `formats: motion` on every run path.
  Offering it at create would have required motion to silently set the mode, which cannot fire on
  the start-from path at all (`mode` is deliberately not a duplicate override,
  `duplicate.post.ts:88-92`). Choosing the mode instead is ungated, needs no probe, and is the
  two-way choice the product actually has.
- **Start-from moves to `BriefPicker`'s Duplicate**, which already exists and is already wired
  through the navigation guard (W1). The capability survives; the dialog keeps two fields.

**A third reading, stated rather than asked.** The reference image shows a materials drop-zone and
three source buttons, but instruction (1) says *only* a name and a template type. This plan takes
the **instruction** as the content spec and the **image** as the visual target: a narrow centred
dialog, a centred title over a two-line description, one prominent field, a full-width primary
button, and a plain text *Cancel* beneath it. **Assets at create stay declined** — there is still no
asset write on the create path.

**Point 2 is mostly a deletion.** `IdentitySection.tsx:177-187` already renders target region and
audience through the same `ChipGroup` over the same `REGION_OPTIONS`; `BriefEditor.tsx:749` already
renders `ModePanel compact`; and both presentations (`cf:presentation` = `guided` | `everything`)
render the *same* sections. **The dialog has duplicated the Identity step since W1.** Exactly one
thing has to move: the `WorldMap`, which lives only in the dialog.

**What this reverses, plainly.** M2 (#214) put the map in the dialog and G3 (#209) turned the
start-from picker into a card rail there — both shipped today. **The map moves to Identity; the rail
leaves the dialog.** Every kit component survives; the rail's affordance survives as Duplicate.

---

## 0.1 Proposed decisions

| id | Decision | Rationale |
|---|---|---|
| **D97** | **The create dialog asks two things: a campaign name and a mode (Classic / Randomized).** Region, audience, the map, the mode's own duplicate in the sidebar, the start-from rail, the numbered sections and the jump strip all leave it. | The dialog was answering the Identity step twice over — every field except the name already exists in `IdentitySection` or the editor's sidebar. Mode is the one remaining choice that genuinely belongs at create: it decides the section list the editor renders (`sectionOrder`), so asking it later would mean re-laying-out the editor under the user. |
| **D98** | **Create lands on Identity, not Copy.** The `stashStep("copy")` baton becomes `stashStep("identity")`. | D66 sent Create to Copy *because the dialog had already answered Identity*. It no longer does: region and audience are now unanswered and both are required by `validateIdentity`. Landing on Copy would drop the user one step past two empty required fields and refuse them at the next Create — the D8 shape again, in navigation form. This is a direct consequence of D97 and must land in the same wave. |
| **D99** | **`setMode` must clear a mode-incompatible format — a live defect on `main`, independent of this plan.** `editor-state.ts:626` is `return { ...state, mode: action.mode }`. Flipping Randomized → Classic leaves `output.formats: ["motion"]` intact, and `load-brief.ts:603` then refuses that brief on **every run path** while it stays listed and looks fine. | Reachable in today's editor: pick Randomized, choose motion in Output, flip the sidebar toggle to Classic. The user is left holding a campaign that cannot generate, with nothing said. DESIGN.md §5 names this exact class and records that it has already happened three times. It is not caused by this plan and should not wait for it, but this plan found it and owns the fix. |
| **D100** | **`packages/ui` now — the kit moves, minus the four files that cannot.** This reverses **D92**. `kit-boundaries.test.ts` already proves the kit is domain-free except a declared four-entry allowlist (`section-outline`, `confirm-dialog`, `seg-bar`, `theme-toggle` — all importing `campaign/messages`). Those four **stay in `apps/web`**; the other 38 move. | D92 deferred on cost and said "revisit when a second consumer exists". No second consumer exists; the owner asking twice is the better signal. The costs are now measured rather than estimated: `transpilePackages` already lists five workspace packages and takes one more; Tailwind's `content` is one glob; the vitest `web` project and the coverage `include` are one path each; `linter-config.yaml` has a `global_whitelist`. **The one real question is that `layer-rules.yaml` has no presentation layer at all** — D92 called that "no rule for a UI package" without noticing it is a design decision, not a config line. |
| **D101** | **The dialog's mode tiles are the kit's `OptionTile` with real previews.** Classic shows one design repeated; Randomized shows a set — the pictures G1 built and G2 wired, at the create moment. | The tiles exist, are tested, and are already the mode control in the editor's sidebar (compact). Using them here means the create moment and the editor show the same thing for the same choice, which is the reason `ModePanel` was made domain-aware and prop-driven in the first place. |

---

## 1. Findings

Severity: **C** breaks a user's data or the build · **H** the product tells the user something false
· **M** a real defect with a bounded blast radius · **L** correctness of the estate.

#### **F1 · H · Flipping mode leaves an unrunnable brief, and says nothing** *(pre-existing)*

```ts
// apps/web/src/components/campaign/editor-state.ts:626
case "setMode": {
  return { ...state, mode: action.mode };
}
```

`output.formats` is untouched. So Randomized + motion, then Classic, yields a brief that
`load-brief.ts:603` refuses on every run path — deliberately, because *"the classic product × ratio
× treatment matrix has no motion path, so it would silently render stills"* — while authoring keeps
accepting it *"so the file stays listed and can be fixed in the editor"*. The user is never told.
Graded **H**: the product hands back a broken artefact and reports success. **D99.**

#### **F2 · M · The dialog has duplicated the Identity step since W1**

Region and audience: `IdentitySection.tsx:177-187`. Mode: `BriefEditor.tsx:749`. The dialog renders
all three again. Two controls for one value is how they drift — and "ensure no duplication" is
satisfied by deletion, not by building anything.

#### **F3 · M · Create would land the user past two empty required fields**

`stashStep("copy")` exists because the dialog answered Identity (D66). Under D97 it does not:
`validateIdentity` requires region and audience, and both are now unanswered at create. **D98.**

#### **F4 · M · The map has no compact form, and Identity renders in the sidebar too**

`SectionShell` takes `compact`, and `BriefEditor` renders Identity in the 320 px bar as well as the
page. A 960×500 map cannot go there. Moving `WorldMap` into Identity needs the treatment `ModePanel`
got in G2: **compact omits the map**, the chips remain the accessible and keyboard control (D94), so
nothing is lost.

#### **F5 · M · The seed contract changes shape, and its test is a deep-equal**

`CreateCampaignDialog.test.tsx:133-138` pins the seed as exactly
`{name, targetRegion, targetAudience, mode}`. Two fields leave. That ripples to
`CreateCampaignInput`, `isStoredSeed`, `publishSeed`, `takeSeed`, the editor's seed effect, and
`duplicateBrief`'s overrides body. **The test is rewritten deliberately**, and §3 names exactly which
fields leave so no lane improvises. `isStoredSeed` must **reject** an old-shape seed rather than
half-apply one written by the previous build.

#### **F6 · L · The refusal ladder collapses, and the jump strip becomes pointless**

`campaignNameRequired → campaignNameNotSluggable → targetRegion → targetAudience` becomes the name
rungs alone — and `campaignNameNotSluggable` goes too, since it existed only on the source path,
which D98's answer retires. A `JumpStrip` that can hold one chip is decoration: **remove it from the
dialog**; it stays in the kit for the editor.

#### **F7 · L · Two suites already query buttons named `static` and `motion`**

`format-panel.test.tsx` and `sections.test.tsx` query the Output step's `FormatPanel` by raw value,
and `brief-editor.test.tsx` both queries those *and* opens the dialog. Under the confirmed reading
the dialog renders **Classic / Randomized**, not `static` / `motion`, so the collision does not
arise — recorded because it would have, under the other reading, and the dialog's tiles must keep
querying as `brief` / `variation` with `within(dialog)` scoping where both are mounted.

---

## 2. The recommendation

```
S4  the setMode leak     →  clearing a mode-incompatible format          (independent; ship first)
S3  the seam             →  CreateCampaignInput {name, mode}; the baton to Identity
S1  the dialog           →  two fields, the reference styling
S2  Identity gets the map →  WorldMap above the chips; compact omits it
P1  packages/ui          →  the kit moves, minus the four allowlisted     (last, alone)
```

**S3 and S1 collide on `lib/create-campaign.ts`** — S3 owns it, S1 consumes it. **S1 and S2 both
append to `messages.ts`** — own block each, appended at the end under a comment header naming the
lane, so the merge resolver keeps both. **P1 goes last**: every other lane imports
`@/components/ui`, and moving the kit underneath them mid-flight is a rebase for no gain.

### 2.1 What the dialog becomes

- a narrow centred dialog (~`max-w-md`) — 820 px was for three sections and is now wrong
- a centred title over a two-line description
- **Campaign name** — one prominent `Input`
- **Template type** — two `OptionTile`s (Classic / Randomized) with the previews G1 built (D101)
- a **full-width primary** *Create campaign*, with a plain text *Cancel* beneath it
- one `role="status"` refusal line; **no `JumpStrip`** (F6)
- **W2(a)'s inline discard guard stays** — a typed name is still worth confirming before discard

### 2.2 What leaves, and where it goes

| Leaves the dialog | Goes to | Kit component |
|---|---|---|
| Target region (`ChipGroup`) | already in `IdentitySection` | — |
| Target audience (`Input`) | already in `IdentitySection` | — |
| The world map | **moves** to `IdentitySection`, above the chips | `WorldMap` kept |
| Start-from rail | `BriefPicker`'s **Duplicate** (already exists, already guarded) | `OptionTile` kept |
| `JumpStrip`, numbered `SectionBlock`s | removed from the dialog | both kept for the editor |
| Mode | **stays** — it is the dialog's second field (D97) | `OptionTile` via `ModePanel` |

---

## 3. Lanes

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **S4** | **`setMode` clears a mode-incompatible format** (**D99**, F1). Flipping to `brief` drops `motion` from `output.formats`; flipping to `variation` changes nothing. Say it in a `role="status"` line where the mode control lives, so the user learns the format changed rather than discovering it at the next run — DESIGN.md §5's "copy names the remedy". **Ships independently of the rest of this plan** — it is a live defect on `main`. Tests: Randomized + motion → `setMode("brief")` → `formats` excludes motion and the line says so; a classic brief with no formats is untouched; the reverse flip is inert. **Mutation:** restore the passthrough → the test fails. | `campaign/editor-state.ts`, `campaign/messages.ts` (append), their tests | The D8 loop closed, and a broken-artefact path removed. |
| **S3** | **The seam and the landing step** (**D98**, F5). `CreateCampaignInput` becomes `{ name, mode }`; `targetRegion` and `targetAudience` leave. `isStoredSeed` validates the new shape and **rejects the old one** (a seed from the previous build must be discarded, not half-applied). The editor's seed effect patches name and mode, then resets `attempted`/`touched` exactly as today. `stashStep(COPY_STEP)` becomes `stashStep("identity")` — the constant and its comment change together. `duplicateBrief`'s overrides body drops region/audience. Tests: a seed applies name and mode and lands on Identity; an old-shape seed is discarded; the 409 and blocked-store paths are unchanged. | `lib/create-campaign.ts`, `lib/briefs-api.ts`, `campaign/BriefEditor.tsx` (seed effect + baton only), their tests | The contract S1 depends on, and a landing that is not past two empty fields. |
| **S1** | **The dialog, cut to two fields** (**D97**, **D101**, F6). Name + mode, styled to §2.1. The mode tiles keep the kit contract — accessible name is the raw value (`brief` / `variation`), display words from `modeDisplayName` — so the pinned queries survive; scope with `within(dialog)` wherever the editor is also mounted (F7). Remove region, audience, `WorldMap`, `StartFromExistingPicker`, the `SectionBlock`s and the `JumpStrip`. Keep the single `role="status"`, W2(a)'s discard guard, the resume two-way, D65 (no slug). The ladder collapses to the name rungs; `campaignNameNotSluggable` goes with the source path. New strings appended to `messages.ts` under a `// S1` header. | `shell/CreateCampaignDialog.tsx`, `campaign/messages.ts` (append, own block), the dialog's test, `shell/__tests__/{shell-nav,shell-modals,BriefPicker}.test.tsx`, `brief-editor.test.tsx`'s `fillDialog` helpers | The dialog the owner asked for. |
| **S2** | **Identity gets the map** (F4). `WorldMap` above the existing `ChipGroup`, wired as M2 wired it — same `labelFor` from `messages.ts`, same `fallbackHint`, `Other…` clears the map's selection. **`compact` omits the map**; the chips stay the keyboard path (D94). The hint keeps M2's wording and must not say "dispatch" or "per region". New strings appended under a `// S2` header. | `campaign/sections/IdentitySection.tsx`, its tests, `campaign/messages.ts` (append, own block) | The map where the region actually lives. |
| **P1** | **`packages/ui`** (**D100**) — **last, alone.** A new `@campaignfoundry/ui` workspace package holding the kit's 38 domain-free files. **`section-outline`, `confirm-dialog`, `seg-bar` and `theme-toggle` stay in `apps/web/src/components/ui`**, whose barrel re-exports the package so **no call site changes twice**. Config: add the package to `transpilePackages`; widen Tailwind `content`; widen the vitest `web` `include` and the coverage `include`; add the package to `linter-config.yaml`'s `global_whitelist`; and **add a presentation layer to `layer-rules.yaml`, or a written exemption** — that is D100's real question and the PR must state which was taken and why. **`kit-boundaries.test.ts` moves with the kit and must scan BOTH directories** — after the move the four staying files are the only ones left in `apps/web`, and all four are allowlisted, so a single-directory scan would pass vacuously against an empty set. **No component's behaviour changes: no test file is edited.** | `packages/ui/**` (new), `apps/web/src/components/ui/**`, `next.config.ts`, `tailwind.config.ts`, `vitest.config.ts`, `.architecture/invariants/{layer-rules,linter-config}.yaml`, import sites | The reusability the owner asked for twice. |

**Waves.** A: **S4 ‖ S3** (disjoint). B: **S1 ‖ S2**. C: **P1**, alone.

**Every lane in this table has since shipped.** §8 names the PR and the symbol that closed each one.

---

## 4. Definition of Done

Standing gate per lane (`build`, `typecheck`, `lint`, `lint:arch`, `sync:check`, `test:cov` at
100 % ×4), a mutation per behavioural claim **confirmed to compile and run**, every new string in
`messages.ts` past the jargon gate, tokens only, no new looping animation, house test style.

- **S4**: Randomized + motion → Classic drops motion and says so; a brief with no formats is
  untouched; the reverse flip is inert; `OutputSection`'s existing suites pass unedited.
- **S3**: an old-shape seed is **discarded**, not partially applied; the baton lands on Identity;
  the 409 and blocked-store paths pass unedited.
- **S1**: the dialog contains exactly **two** controls; `getAllByRole("status")` is 1; no slug
  appears (D65); the discard guard and resume two-way pass unedited; the mode tiles still resolve as
  `getByRole("button", { name: "brief" })` / `"variation"`.
- **S2**: map and chips set the same value both directions; `compact` renders no map;
  `IdentitySection`'s existing tests pass unedited.
- **P1**: **no test file is edited**; `kit-boundaries.test.ts` scans both directories and its
  allowlist names the four that stayed; `yarn lint:arch` passes with the new rule; the PR states
  whether a presentation layer or an exemption was taken.

---

## 5. Deferred

| What | Waits on |
|---|---|
| Assets at create (the reference image's drop-zone) | no asset write on the create path — unchanged |
| Multi-region | **D95**, still open |
| The campaign-ID readout | **D65** stands |
| Untangling the four allowlisted kit files | each needs its `messages` dependency inverted |
| The `static` / `motion` choice at create | stays in Output, where its probe and mode gate live |

---

## 6. Open questions

1. **D100's real question** — a presentation layer in `layer-rules.yaml`, or a written exemption?
   The first is more honest and more work.
2. **Does the mode tile need a sentence about what it changes?** Mode decides the editor's section
   list; a user picking Randomized gets a different set of steps. One line may prevent surprise.
3. **Should S4 ship before this plan's docs PR merges?** It is a live defect and is independent.

---

## 7. Corrections this plan records

- **D92 is reversed.** It deferred `packages/ui` on cost and said to revisit when a second consumer
  existed. None does; the owner asking twice is the better signal. Its cost list was also wrong in
  both directions — `transpilePackages` already exists, and `layer-rules.yaml` having **no
  presentation layer** is a design decision it recorded as a config line.
- **The dialog has duplicated the Identity step since W1**, and three plans and eleven review passes
  did not say so. Each asked whether the dialog was internally correct; none asked whether its
  fields already existed elsewhere. **That is a gap in the review questions, not in any lane** — a
  reviewer given a diff cannot see a duplicate it was never pointed at.
- **The map and the rail shipped in the dialog hours before this plan moved them.** Not waste: the
  kit components are unchanged and the map simply lands where the region lives. Recorded because
  the arc's cost is only honest if the churn is counted.

---

## 8. Premises — audited 2026-09-12, every lane shipped

`yarn plan:verify` reads a ```` ```premise <lane> ```` fence from each plan: a POSIX `sh` script that
exits 0 **while the gap the lane describes is still open**, and fails once the gap has closed — four
lanes were dispatched, or nearly dispatched, against gaps that had already shipped. This plan has no
premises left to write, and that is the finding: **all five of its lanes landed** and the plan's own
text was never amended. A premise added now to a lane that has shipped can never hold — it would
report a finished lane as open, which is the expensive direction — so each lane is retired here with
the evidence a reader can check instead of re-deriving.

| Lane | Shipped | The evidence that closed it |
|---|---|---|
| **S4** | **#218** (`6217632`) | **The mechanism §3 wrote is not the mechanism that shipped, and the PR decided so.** §3 asks for a `setMode` state mutation. What closes the lane is a gate on serialisation: `serialisedFormats` (`apps/web/src/components/campaign/editor-state.ts:1646`), consumed by `toBrief` (`:1673`) and by `preview-props.ts` — `output.formats` cannot carry `motion` while `mode === "brief"`, however the draft got there — while `setMode` (`editor-state.ts:842`) deliberately **keeps** the draft's formats, and its comment says why: the D5 round-trip and the remedy ("switch back to Randomized") need them intact. The notice is derived, not latched: `BriefEditor.tsx:769` → `ModePanel.tsx:222` renders `messages.modeDroppedVideo` in one `role="status"` line beside the tiles. **#218 built §3's mutation first** (`formatDroppedByMode`, in the state, the reducer and `normalizeDraftState`) **and deleted it in the same PR** — *"a destructive setMode reds the D5 round-trip"* — so the lane is closed by a mode gate, not by a flip. Re-dispatching it literally would red D5 and re-argue a review already lost. **Mutation, run 2026-09-12:** a passthrough `serialisedFormats` fails 5 of the 9 tests in `editor-state.test.ts:3909`; the whole block is green again once reverted. |
| **S3** | **#217**, then **#228** | `CreateCampaignInput` (`apps/web/src/lib/create-campaign.ts`) is `{ name, type, source? }` — `targetRegion` and `targetAudience` left the seam, and `isStoredSeed` **rejects** both retired shapes instead of half-applying them; `CreateCampaignDialog` stashes `IDENTITY_STEP`, so Create lands on Identity rather than past two empty required fields. |
| **S1** | **#236** | The dialog is one name `Input` and one tile group (`apps/web/src/components/shell/CreateCampaignDialog.tsx`), `max-w-md`, a single `role="status"`; region, audience, the world map, the start-from rail, the numbered sections and the jump strip are all gone, and its test pins "exactly two controls". |
| **S2** | **#225** | `IdentitySection` renders `WorldMap` above the existing chips, and `{!compact ? … : null}` omits it in the 320 px sidebar while the chips stay the accessible and keyboard path (D94). |
| **P1** | **#240** | The domain-free kit moved to `@campaignfoundry/ui` (`packages/ui`). Outside this audit's four lanes, but §3 still lists it, so it is retired here too. |

**Three of the four arrived in a different shape than §3 wrote them, and the plan never said so.**
D100 aside, the dialog's second field is the **campaign type** (D108, four tiles), not D97's two-way
mode — #217 shipped `{ name, mode }` exactly as written, and #228/#236 replaced it with the type
whose preset carries the mode. **And S4's drop is a mode gate on serialisation, not the `setMode`
mutation §3 asked for** (see its row): #218 wrote the mutation and took it back out in the same PR,
so the lane is finished, but §3 still describes work that review rejected. Re-reading §3 literally
and re-dispatching S1, S3 or S4 today would delete shipped behaviour; that is precisely the drift
this section exists to make visible.
