# The Unowned Gaps — Architecture & Development Plan

> **Amended 2026-09-10 after review.** Two of the six were already owned and are demoted to notes; the
> lane prefix moved from `U` to `X`, because `U1`–`U8` are the directives in
> `2026-08-28_graphical-brief-editor.md`.

**Date:** 2026-09-10 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
**Verified against:** `main` at `f4f4d63`.

Every gap surfaced this session that **no plan owns**. Each carries a recommended default, because a
gap recorded without a decision is just a longer way of forgetting it.

---

## 1. Prettier has no configuration, and the repo has never been formatted

**Evidence.** No `.prettierrc`, no `prettier.config.*`, no `package.json` key — yet `yarn format`
runs `prettier --write` across the repo. So every invocation formats to Prettier's **80-column
default** against code whose measured width is p90 = 84, p99 = 116. Sampling 40 files: **19 are
unclean at the default and 15 at width 100.** The repo has never been consistently formatted.

**What it has cost.** Three PRs this session had real changes buried under hundreds of reformatted
lines, and I spent review time on each deciding whether the churn hid a defect. Every brief since
carries a "do not run Prettier" rule — a workaround for a missing config.

**Recommended default: adopt a config at width 100, do one repo-wide format commit, and add
`format:check` to the gate.** Width 100 is closest to the code as written, so the one-time diff is
smallest. **This lane must run alone** — it touches every file and will conflict with anything in
flight. After it, the "do not run Prettier" rule comes out of every brief.

## 2. No layer carries alt text

**Evidence.** `CreativeTemplateLayer` is `{ id, kind, props? }`; nothing anywhere carries alternative
text.

**Why it matters now.** The HTML layer plan makes a backup image a named deliverable, and a backup
image without alt text is not accessible — for an advertising product that is both a compliance and a
placement issue.

**Recommended default: add `alt` to the D134 props vocabulary** for `image`, `video` and `html`,
optional, absent meaning absent. It is the shape D134 already established, so it costs one entry
rather than a new mechanism. **Sequence it with the HTML layer**, which is the first consumer.

## 3. The `darwin-arm64` goldens are verified only on the machine that recorded them

**Evidence.** Every PNG and motion golden carries `darwin-arm64` and `linux-x64` keys. The Linux key
is re-proved by CI on every run. **The macOS key is proved by nothing** — no runner uses it — which
is true of the four pre-existing fixtures as well as C1's new ones.

**Recommended default: state the limitation in the fixture and stop implying parity.** A macOS runner
in CI is the real fix and it is not worth its cost yet; what is not acceptable is a fixture that
looks doubly verified and is not. **One comment, no code.**

## 4. Three brand tokens are unreachable by the wave-status page

**Evidence.** `--color-brand-primary`, `--color-brand-primary-hover` and `--color-brand-secondary`
are declared only in `:root`. The server's `/tokens.css` route serves **only the `.dark` block**, so
the page cannot see them. Two lanes have now worked around it by substituting a token that is served.

**Recommended default: serve `:root` as a base and `.dark` after it**, which is what a browser does
with the real stylesheet. The page then sees every token, and the two substitutions can be revisited
on their merits rather than on availability. **Guard it with a test** asserting every token the page
references resolves — the absence of that test is why this was found by accident twice.

## 5. D136 is half-shipped — **M4 plus a code change**

**Evidence.** The occlusion advisory reaches the editor and no further. `CompliancePort` and
`ComplianceResult` were listed in L8's ownership and never touched. The advisory encodes as
`{ passed: true, reason }` while `ComplianceResult` documents `reason` as *"populated on failure"* —
so an aggregator reading `passed` sees nothing and one reading `reason` sees a failure.

**M4 already owns "D136 as half-shipped"** (`2026-09-10_the-motion-path-and-l9.md`). What it does not own is the **encoding fix** — `{ passed: true, reason }` against a type documenting `reason` as *populated on failure*. **Recommended default: amend D136 to editor-only in M4, and fix the encoding as a small change beside it.** The compliance page is
**run-scoped** — one row per generated asset from `useRun()` — and an occlusion finding exists before
any run. Aggregating it there needs a page redesign that nothing else wants. **Amending is honest;
leaving a decision half-shipped is not.** The encoding ambiguity is real either way and should be
resolved whichever side is chosen.

## 6. `validateBrief` never checks copy against the template — **already M2's, not a lane**

**Evidence.** It validates style and sizes. It does **not** check the brief's copy fields against its
template's `accepts` / `required` sets, so a brief whose template omits a text kind can still carry
campaign copy the compositor will draw.

**Already assigned**: `2026-09-10_reconciliation.md` §4c gives it to M2. This is a note, not a lane. **One correction it needs**: `validateBrief` is a private method of `GenerateCampaignUseCase`, **not** `load-brief.ts` where M2's other work sits — M2's brief must say which boundary.
It is the same boundary, the same file, and the same kind of rule. **Written into M2's brief rather
than left as a note**, which is how it stayed unowned until now.

---

## 7. Order

| | Lane | Note |
|---|---|---|
| 1 | **X3** — the macOS golden caveat | one comment; do it first because it costs nothing |
| 2 | **X4** — serve `:root` as a base, with the resolve test | small, unblocks nothing, prevents a third workaround |
| 3 | **X5** — the encoding fix (the amendment itself is M4's) | small |
| 5 | **X2** — `alt` in the props vocabulary | sequence with the HTML layer |
| 6 | **X1** — **Prettier, alone** | last, because it conflicts with everything; run when no lane is in flight |

## 8. What this plan refuses

- **It does not batch X1 with anything.** A repo-wide reformat run beside another lane is how a real
  change gets buried, which is the problem it exists to solve.
- **It does not add a macOS CI runner** to close gap 3. The cost is real and the honest caveat is
  cheap.
- **It does not build the compliance-page aggregation** to close gap 5. Amending the decision is the
  smaller true thing.

---

## 9. Premises

Each gap states the claim that makes its lane necessary, as a script that exits 0 **while the gap is
still open**. `yarn plan:verify` runs them. This section exists because three lanes in this plan and
its siblings were dispatched — or nearly dispatched — against gaps that had already been closed.

```premise X1
# Ask Prettier itself: an rc file, a prettier.config.*, or a package.json
# "prettier" key all close the gap — three literal filenames do not.
! npx --no-install prettier --find-config-path package.json
```

**X2 — shipped in #370.** `alt` is in the props vocabulary for the `image` kind alone — the one kind
whose whole content is a picture a reader may not see, and therefore the only kind that can *mean* a
text alternative — validated as a string by the shared `layerPropsProblem`, so both boundaries read
one decision. Its premise grepped for the key in the vocabulary that decides, not a string near it,
so it cannot survive the fix; it is retired in the same commit that closes the lane.

**X3 — shipped in #335.** Its premise was retired when it landed; `plan:verify` no
longer tracks it.

**X4 — shipped in #327 (the serving) and #333 (the guard).** Its premise was retired when it landed; `plan:verify` no
longer tracks it.

**X5 — shipped in #334.** Its premise was retired when it landed; `plan:verify` no
longer tracks it.

---

## 10. A load-sensitive test fails CI at random (X7)

**Evidence.** `tools/wave-status/__tests__/server.test.ts > cleanup > listen rejects when the
requested port is already bound` failed once during the 2026-09-13 overnight run, in a full suite,
while several lanes and gates were running concurrently. It took **5 785 ms** — a timeout shape, not
a wrong assertion — and passes on its own (62 tests in that file).

The test starts a server on port 0, reads the ephemeral port, and expects a second `start()` on that
port to reject with `EADDRINUSE`.

**Why this matters more than one test.** A suite that fails at random teaches its readers that red
means *try again*, and this repository's entire discipline rests on a green mark meaning something.
**One flake is cheaper to fix than the habit it creates.**

**Recommended default: find the mechanism before changing the test.** Two candidates, and they want
opposite fixes — a rejection that arrives slower than the runner's patience under load (raise or
remove a wait, do not loosen the assertion), or a second bind that intermittently **succeeds**, in
which case the assertion is right and the server's listen options are the defect. Deciding which
without evidence is how a flaky test becomes a deleted one.

**X7 — retired.** The bind-conflict test binds an exclusive blocker directly,
eliminating the racy second-server overhead; `plan:verify` no longer tracks it.


---

## 11. A second load-sensitive test in the same file (X8)

**Evidence.** `tools/wave-status/__tests__/server.test.ts > cleanup > close() shuts the server, its
watchers and its interval down` failed once during the 2026-09-13 overnight run, in a full suite,
while another lane's gate was running. It took **5 142 ms** — a timeout shape, and suspiciously
close to vitest's 5 000 ms default, meaning `close()` did not resolve rather than resolving wrongly.
It passes alone (62 tests in that file) and passes on a second full run (250 files).

**This is not X7 returning, and not a regression from X7's fix.** `main` with X7 merged passes the
full suite cleanly, and X7's change was to `listen`, not to `close`. X7 fixed one instance; the file
has another.

**The mechanism, found.** `close()` ran its shutdown synchronously *through* the `fs.watch` handles it
had armed on the wave **directories**. On macOS a directory watch is FSEvents-backed, and a
`FSWatcher.close()` flushes the watcher's pending event batch inside the native call — synchronously,
on the awaited path. Measured with a backlogged `fseventsd` (ten concurrent suites hammering the temp
dir, which is what a full run plus another lane's gate looks like): closing 96 directory watchers took
**28–41 s**, and the test's own `close()` — two watchers, armed milliseconds after the fixture wrote
its files — was measured at **2.8–9.3 s**. The same watchers, armed on the lane *files* (kqueue-backed
on macOS), close in **0 ms**. The keep-alive socket hypothesis was right to be refuted: every phase
of `close()` except the watcher loop is 0–1 ms even under load. This is the second load-sensitive
flake in the file, and unlike X7 it is not a wrong assertion — it is a shutdown path whose cost the
platform does not bound.

**X8 — shipped in this PR.** The watchers are armed on lane artefacts (`*.log`, `events.jsonl`) under
each wave directory, never on the directories; listings go through the existing `deps.readdir` seam;
both shutdown paths share one synchronous `shutdown()` that refuses to arm anything after the close.
The cost of the narrower scope is named: a lane log created after startup is armed by the next poll
tick, not the instant it appears. Four new tests pin the contract (file scope, poll-tick discovery,
a listing that survives its own close, and a `close()` that closes every watcher it armed and starts
no collection afterwards), and seven mutations replay as caught in `.agents/manifests/x8.json`.

**The rule X7 established still governs**: find the mechanism before changing the test. A suite that
fails at random teaches its readers that red means *try again*.

---

## 12. The compositor cannot see a disabled layer (X9)

**Evidence.** `enabled` is a validated field on every layer — D129 gives it a dedicated problem
type, and both boundaries read the same decision — yet `NodeCanvasCompositor.ts` contains **zero**
occurrences of the word. Every layer draws, whether or not the brief disabled it.

**Why this matters.** An operator who disables a layer is told the brief is valid and then watches
the layer render anyway. This is worse than an unsupported field: the boundary's acceptance is read
as a promise the renderer never made.

**Scope.** This is pre-existing and applies to *every* kind, not to `html` alone. It was found while
reviewing HL3 and deliberately kept out of that lane — folding it in would have turned a drawer into
a dispatch-loop change touching every layer kind.

**X9 — shipped in this PR.** Its premise was retired when it landed; `plan:verify` no
longer tracks it.

---

## 13. Html text can leave its own frame (X10)

**Evidence.** `drawHtml` paints `text` and `button` labels with `fillText` at a size derived from
the frame's height, and the compositor performs no clipping anywhere — `.clip()` appears **0** times
in the file. A label longer than its frame is wide therefore paints straight across whatever sits
beside it.

**Why it is a deferral and not an HL3 defect.** HL3's acceptance criteria are that the element list
draws in template order and that the fallback exists before the markup does. Fidelity between the
raster fallback and the markup cannot be asserted until HL4 writes the markup — and the one thing
worse than an overflowing label is two renderers each clipping differently. **The lane that can test
this is HL4's successor, not HL3.**

**X10 — shipped in this PR.** Its premise was retired when it landed; `plan:verify` no
longer tracks it.

---

## 14. The editor guard and the API disagree about required layers (X11)

**Evidence.** Two boundaries validate the same persisted template and apply different rules.

- The API enforces the real rule. `load-brief.ts` collects `enabledKinds` from layers whose `enabled`
  is not `false` (`:253`, `:296`) and rejects at `:360` unless there is **at least one enabled
  instance of every required kind** (D129/MP-D4). `CREATIVE_TYPE_RULES.required` is
  `["image", "static-text"]`, `["image", "html"]`, `["video", "animated-text"]` — and its own comment
  says a required kind "cannot be removed or disabled".
- `isBriefTemplate` (`brief-template.ts:326`) checks id, version, creativeType, unit, layer shape,
  unique ids and order constraints — and **does not check required kinds at all**. The word
  `required` does not occur in the file.

So a persisted draft that the API refuses is accepted by the editor guard and handed to the
compositor, which renders it incomplete.

**The scope is wider than the case that surfaced it.** Found via a review finding on X9 (#374) about
a *disabled* required layer, but the gap is not about `enabled`: a template **missing** a required
layer entirely has always passed this guard too.

**A false claim to delete while fixing it.** The doc comment above `isBriefTemplate` says unique ids
are checked, "the rule the API's `validateTemplate` already applies, **so the two boundaries cannot
disagree about a draft's shape**." On required kinds they do disagree, and did before X9. Whoever
closes this lane should correct that sentence rather than leave a comment asserting an invariant the
function does not hold.

**X9 is not the cause and was right not to fix it.** Before X9 a disabled required layer drew, so the
preview looked complete while the brief was invalid; after it the preview is blank. Neither is
correct, but the compositor's job is to honour a validated field. The fix belongs to the boundary
validator, in a different package.

**Reference semantics: the API's rule**, mirrored into the editor guard — at least one enabled
instance of each required kind, absence of `enabled` meaning enabled. Whether a restored draft that
fails should fall back to the canonical template is the lane's to decide and to state.

**X11 — shipped in this PR.** Its premise was retired when it landed; `plan:verify` no
longer tracks it. The guard now mirrors every table rule the API applies — `accepts`, `maxOf`,
`sharedBudgets` and required-with-`enabled` — and a restored draft that fails falls back to the
canonical template.

---

## 15. A persisted row's click destination is believed, not checked (X12)

**Evidence.** `apps/api/server/lib/report.ts` declares `clickDestination?: string` on the persisted
asset row (HL4), and `isPersistedAsset` — a **type predicate** — verifies `htmlBundlePath` and
`htmlFallbackPath` for html rows but never `clickDestination`. The file states its own rule a few
lines above the guard: *whatever this type claims, callers believe after the guard returns.* The row's
destination flows into `PackageForPlatformUseCase`, which decides from it whether a bundle must carry
a `clickTag`.

**Severity: low.** It needs a malformed report row. It is recorded because it is exactly the class the
file's own comment exists to prevent, and because it was the only finding this wave that PR-Agent made
and Qodo did not (§8.1 of the verification-budget plan).

**Fix shape.** Verify the field in the guard — absent, or a string — the same way `videoPath` and
`durationSec` are verified for motion rows.

**X12 — shipped in this PR.** Its premise was retired when it landed; `plan:verify` no
longer tracks it.

---

## 16. The merge script does not enforce the merge condition (X13)

**Evidence.** `SKILL.md` stage 5 prescribes `scripts/merge-prs.sh` and, since 2026-09-14, requires a
merge only when the PR's *final* head has passing conclusions, the review bots have posted, and **zero
review threads are unresolved**. The script never queries review threads, and after it merges
`origin/main` into a lane and pushes the refreshed head it waits for check registration and CI, not for
review bots. On that refreshed head a bot can post a finding the merge never sees.

**Why it matters.** Both halves of this wave's merge discipline were earned the hard way: a merge gated on
CI alone raced the bots on #381, and the full condition held back #384 for a real defect found only on its
final head. A script that silently does less than the stage it implements invites exactly the regression
the rule exists to prevent.

**Fix shape.** After the refresh push and CI, wait for review bots on the new head, then refuse to merge
while `reviewThreads` has any unresolved node; name the open threads in the refusal. Test it against a
recorded GraphQL answer, as the wave-status tooling tests `gh`.

**X13 — shipped in this PR.** Its premise was retired when it landed; `plan:verify` no
longer tracks it. The condition is decided by `yarn sweep gate --pr <n> --sha <sha>`
(`tools/sweep`, tested against recorded GraphQL answers through the same injected `gh`
seam), and `scripts/merge-prs.sh` is only its caller: it settles for the bots, refuses
while a thread is open — each one named by author and excerpt — and re-reads the head
immediately before `gh pr merge`. A page of threads that cannot be read is
"could not decide" and refuses, never a silent zero. The premise is gone rather than
inverted because it greps `merge-prs.sh`, and with the logic in TypeScript that grep
would never have flipped on its own.

---

## 17. No platform accepts the HTML unit, so it is never packaged (X14)

**Evidence.** `PackageForPlatformUseCase` packages an `html` asset only for a profile whose `formats` include
`"html"` (`wantsHtml`, `PackageForPlatformUseCase.use-case.ts:142`). All ten profiles in
`PlatformProfile.vo.ts` declare `["static"]` or `["motion"]` — including the three display profiles,
`google-display`, `meta-audience-network` and `display-web`. `"html"` appears only in the `PlatformFormat`
union and two helpers.

**Consequence.** HL4 (#377) generates the HTML unit, wires `clickTag`, and adds packaging checks for its
raster fallback, its `clickTag` and its byte budget — and **no production path reaches them**, because no
platform ever selects an `html` row. It also leaves HL5's live weight meter (HL-D6) with no `maxBytes` to read.

**This needed an owner decision, not a lane default.** Which placements accept HTML5 display units, and each
one's byte budget, are ad-spec facts; HL-D6 already says the budget is per placement and must not be a single
constant.

**Decision, owner 2026-09-15 (recommended default, plan-reviewed — the numbers are owner-verifiable).** Add two profiles,
**`google-display-html`** and **`display-web-html`**, each `formats: ["html"]`, sizes `DISPLAY_ALL_SIZES`, and
`maxBytes: HTML_MAX_BYTES = 150 * 1024`. **`meta-audience-network` gains no html.** Separate profiles are the codebase's own
precedent for one network in two families (`instagram-feed` static vs `instagram-story` motion): no type change, `packageHtml`
and `wantsHtml` work unchanged, and HL-D6 stays one number per profile for HL5c's meter. Tests to update in the lane: `isPlatformVisible` treats `html`
like `static`, so both hard-coded id arrays in `PlatformProfile.vo.test.ts`'s `visiblePlatformIds` cases gain the two ids;
the all-profile loops survive because the new profiles carry `sizes`, not a `ratio`. No `campaign-types.ts` change is
needed — `OutputSection` offers profiles by `formats`, and the boundary accepts any visible id.

**Owner-verifiable, not verified here:** 150 KB is general industry knowledge (Google Ads / DV360 HTML5 zipped upload cap,
IAB initial-load guidance), and Meta Audience Network is understood not to take third-party HTML5 display creatives — check
both against the networks' current specs before relying on them.

**Known undercount, recorded for the X14 lane:** `packageHtml` measures `index.html` alone while the unit references
`fallback.png`, and generation calls `assembleHtml` without a `profile`, so "refused while building" is packaging-only today.
The X14 lane states which bytes the budget counts (the shipped zip is what the network measures).

**X14 — shipped in this PR.** Its premise was retired when it landed; `plan:verify` no
longer tracks it. The table gained **`google-display-html`** ("Google Display (HTML5)") and
**`display-web-html`** ("Display web (HTML5)") — each `formats: ["html"]` over the full
`DISPLAY_ALL_SIZES` with its static sibling's insets, `maxBytes: HTML_MAX_BYTES = 150 * 1024`;
`meta-audience-network` gained nothing. The size check in `packageHtml` counts **the bytes the
unit ships as** — `index.html` plus `fallback.png`, the package a network measures on upload —
not `index.html` alone: a bundle that fits while its fallback crosses the budget records
`checks.size: "fail"`. The item's `bytes` field still names the bundle, as a motion item names
its mp4. The 150 KiB figure stays an owner-verifiable ad-spec fact, now a single named constant
beside `STATIC_MAX_BYTES`, and HL5c's meter has a `profile.maxBytes` to read.

---

## 18. Field hints and errors are invisible to assistive technology (X15)

**Evidence.** The shared `Field` component (`apps/web/src/components/campaign/sections/IdentitySection.tsx`)
renders a field's label, its control, an optional `hint` and an optional `error` — the hint and the error as
plain sibling `<span>`s. It sets no `aria-describedby` linking them to the control and no `aria-invalid` on it.
`Field` is used **34** times across the brief editor's sections, **17** of them with a `hint` or an `error`.

**Consequence.** A screen-reader user focusing a field hears its label but not its guidance, and an invalid
field announces nothing about why. Found by Qodo on HL5b (#390), which used the existing component as-is.

**Fix shape, once for every field.** Give `Field` an id (`useId`), attach `aria-describedby` to the control naming
the hint and error elements that are present, and set `aria-invalid` while an error shows. It must work for both
`as="label"` and `as="div"` wrappers and for the controls passed as children.

**X15 — shipped in this PR.** Its premise was retired when it landed; `plan:verify` no
longer tracks it. `Field` assigns stable `useId` ids to hint and error elements, accepts
either element children (cloning the first valid non-Fragment child to attach `aria-describedby`
and `aria-invalid`) or a function `(control) => ReactNode` for wrapper call sites to spread
onto their real control directly without cloning. Kit components (`Slider`, `Stepper`, `ChipGroup`,
`SwatchPicker`, and `LogoField`) accept `aria-describedby` and place it on their accessible element,
and `aria-invalid` stays single-sourced at call sites.

---

## 19. A toggle round trip leaves an explicit `enabled: true` brief dirty (X16)

**Evidence.** `withEnabled` (`apps/web/src/components/campaign/editor-state.ts`, M3 #395) writes the canonical form
D129 names: switching a layer off writes `enabled: false`, and switching it back on **deletes the key**. The boundary
accepts any boolean, so a hand-authored brief may carry `enabled: true`. Toggling such a layer off and on returns
a template without the key, and `isDirtySinceSave` compares by value (`valuesEqual`), where `{ enabled: true }` and
`{}` differ. Found by Qodo on #395 and deferred there as narrow.

**Consequence.** The editor reports unsaved changes for a draft the user returned to its loaded state, and a save
rewrites the file without the key. Undo is unaffected (history restores the exact prior state). The editor itself never
writes `enabled: true`, so only hand-authored files reach it. HL5a's `withElements` adopts the same "empty is absent"
canonical form for an `html` layer's `elements`, so a loaded `elements: []` has the same round-trip shape.

**Fix shape, when it is worth one.** Either normalise at load — `load` canonicalises `enabled: true` and
`elements: []` to absent, and the saved snapshot is taken from the normalised template, so dirty-state compares like
with like — or have the value comparison treat those defaults as absent. Normalising at load keeps `valuesEqual`
generic, and it is the recommended shape.

**X16 — shipped in this PR.** `canonicalTemplate` in `editor-state.ts` maps each template layer's
`enabled: true` to absent and an empty `elements` array to absent, and changes nothing else;
`canonicalBrief` applies it (X17, §20, later extended `canonicalBrief` with the null-scalar rule).
`fromBrief` takes the draft's and `savedSnapshot`'s template from that form; `save` / `apply` snapshots,
recovered drafts, and the Generate-target comparison (`runBrief`) use the same function. `valuesEqual`
stays generic. An off→on toggle (or add→remove element) on a hand-authored explicit-default brief is
therefore not dirty.

---

## 20. Opening a brief with an empty scalar field crashes the editor (X17)

**Evidence.** The API boundary keeps `null` legal for the brief's scalar copy fields (D68):
`apps/api/server/lib/load-brief.ts` refuses only a non-string that is not null for `targetRegion`,
`targetAudience`, `campaignMessage`, `localizedMessage`. A YAML brief with `targetAudience:` (empty)
therefore lists and opens. `fromBrief` copied `targetRegion`, `targetAudience` and `campaignMessage`
without `?? ""` (only `localizedMessage` and `clickDestination` had it), and `validate.ts` called
`state.targetAudience.trim()` — TypeError, the editor crashed. Products failed the same way:
`{ ...emptyProduct(i + 1, p.primaryColor), ...p }` let `name: null` overwrite the default, and
`validate.ts` called `product.name.trim()`. The same class includes every product string the editor
`.trim()`s or reads as a string (`logoPath`, `inputAsset` in `toProduct`).

**Consequence.** An operator's half-written brief is listed (D15 leniency) and then crashes the
editor on open, so it cannot be fixed in the UI. The picker and the editor disagree about whether
the file is usable.

**Fix.** In `fromBrief`, coalesce every null/absent string scalar the draft holds as a string to
`""` (brief-level and per-product), matching the existing `localizedMessage ?? ""`. Do not change
the API.

**The dirty-state rule.** `toBrief` always emits `targetRegion`, `targetAudience`,
`campaignMessage` and the product fields `id`, `name`, `primaryColor`, `logoPath` as strings
(empty included). It omits `localizedMessage`, `clickDestination`, and product `inputAsset` when
empty. `canonicalBrief` maps null on the always-emitted fields to `""` and drops a null key on
the omitted fields, so a freshly opened null-scalar brief compares equal to the draft. `fromBrief`
coalesces the same fields to `""` independently so `.trim()` cannot throw.

**X17 — shipped in this PR.** `fromBrief` coalesces the brief-level scalars and every product
string field to `""`. `canonicalBrief` applies the dirty-state rule above so the snapshot is the
form `toBrief` writes. Validate reports the empty-field error instead of throwing; a freshly
opened null-scalar brief is not dirty.

---

## 21. A Field warning is invisible to assistive technology (X19)

**Evidence.** X15 linked `Field`'s hint and error to its control through `aria-describedby`, but
`Field` (`apps/web/src/components/campaign/sections/IdentitySection.tsx`) built the description
list from hint and error only (`if (hint) describedByIds.push(hintId); if (error)
describedByIds.push(errorId);`) and rendered the **warning** span — shown only when there is no
error — with no id (`<span className="mt-1 block text-[11px] text-warning">{warning}</span>`). The
prohibited-terms warnings on the headline and localized headline (`CopySection.tsx`, the two
`Field` call sites passing `warning=`) were therefore never referenced by anything.

**Consequence.** A screen-reader user focusing a headline containing a prohibited term hears the
label and nothing about the compliance warning. This is the advisory feedback — it never blocks
Save — so it is exactly the signal that exists only visually: a sighted editor fixes the copy
before generating, an AT user has no reason to.

**Fix.** Give the warning span a stable `useId` id and include it in the describedby list whenever
it renders (which is only without an error), in both the element-clone path and the
function-children path X15 added. `aria-invalid` stays error-only: a warning is not invalid.

**X19 — shipped in this PR.** `Field` names the warning element in `aria-describedby` for the
warning-only and hint + warning cases on both children paths, with the hint first; an error +
warning field references only the error, since the warning is not rendered there.

---

## 22. Timeline beat errors and warnings are invisible to assistive technology (X20)

**Evidence.** `TimelineSection` renders each beat's message — `errors["copy-timeline-beat-<i>"]
(weight out of range, dwell under the floor) and `warnings["copy-timeline-beat-<i>"]` (prohibited
terms in the beat's text) — as a plain `<span>` with no id (`TimelineSection.tsx:119-122`),
bypassing `Field` entirely. The text `Input` carries only an `aria-label`, and neither it nor
the weight `Stepper` sets `aria-invalid` or `aria-describedby`. Found by re-checking X15's scope:
`Field` fixed the 34 fields that use it; the beat rows build their controls by hand and were left behind.

**Consequence.** A beat under the dwell floor or with an out-of-range weight shows red text that a
screen-reader user never hears, and the control stays announced as valid. The one editor surface that
flags a structural breach is the one that cannot be read out.

**Fix.** X15's shape, applied outside `Field`: a `useId`-derived id on each beat's message span; the
weight error — all `errors["copy-timeline-beat-<i>"]` hold one, nothing in the error key is ever about
the beat's wording — describes and invalidates the weight stepper; the prohibited-terms warning, the
only message about the text, describes the text input, which is never marked invalid (`Stepper` forwards
`aria-describedby` (X15); this lane adds `aria-invalid`). No visible change.

**X20 — shipped in this PR.** `TimelineSection` names each beat's message element and links it:
`aria-describedby` on the weight stepper — plus `aria-invalid` there — for an error, and on the text
input only for the prohibited-terms warning when no error renders; the text input carries no
`aria-invalid`, because a weight error must not announce valid wording as invalid. `Stepper` forwards
`aria-invalid` to its spinbutton alongside the `aria-describedby` it already forwarded. No visible
change.

---

## 23. The seed the editor validates is not the seed it saves (X18)

**Evidence.** `validatePolicy` checked the variation policy numbers with `Number(value)` +
`Number.isInteger` (`isIntegerAtLeast` / `isIntegerInRange`,
`apps/web/src/components/campaign/validate.ts`), while `toBrief` in `editor-state.ts` saved the same
drafts with `parseInt(value, 10)` — as did `withCountClamp`, `canPlan`, and the floor-vs-count rule
inside the validator itself.

**Consequence.** The two parsers disagree on every non-trivial form: a free-typed seed of `1e5`
validated as the integer 100000 and was **saved as `1`**; a draft of `12abc` was refused by
validation yet would have truncated to `12` on any path that saved without the gate. The editor
showed green beside a number the file would not carry.

**Fix shape, when it is worth one.** One exported parser for both sides — draft string in, the
integer it means (digit string, optional sign, optional exponent) or `undefined` out — read by the
validators and by every `parseInt` site on the policy numbers. Validation acceptance must be exactly
the save.

**X18 — shipped in this PR.** `parsePolicyInteger` in `editor-state.ts` is that parser: it accepts a
trimmed `[+-]?digits` with an optional integer exponent (`1e5` → 100000, ` 42 ` → 42) and refuses
decimal form (`42.0`), trailing garbage (`12abc`) and blank — so `42.0` now validates as an error
instead of silently saving 42. `isIntegerAtLeast` / `isIntegerInRange` in `validate.ts`, the
floor-vs-count rule, `toBrief`, `withCountClamp` and `canPlan` all read through it. The API is
unchanged; `PolicySection`'s readouts (`PolicySection.tsx`), stepper value and bounds read
through the same parser.

---

## 24. `GET /output/<directory>` answers 200, as its own comment says it must not (X21)

**Evidence.** `apps/api/server/routes/output/[...path].get.ts` resolved the path and ran
`size = (await stat(target)).size` inside a try whose catch 404s. The comment claimed
`GET /output/ … 404s via stat` — but `stat` **succeeds on a directory**. The only root test used a
root that does not exist, so the directory case was untested.

**Consequence.** `GET /output/`, `/output/reports` or `/output/packages` on a deployed server set
200 headers carrying a directory's `content-length`, then `createReadStream` failed with EISDIR —
a half-sent response instead of the clean 404 the route promises for anything that is not a
downloadable creative.

**Fix shape, when it is worth one.** Keep the `stat` result and 404 (same body as not-found) when
`!st.isFile()`; keep the comment accurate.

**X21 — shipped in this PR.** The handler now holds the full `Stats`, and any target that is not a
regular file — the root directory, `reports/`, a FIFO — gets the same `{ error: "Not found" }` 404
as a missing path, before a single header is set. Three tests cover it: an existing root 404s, an
existing subdirectory 404s, an existing file still streams 200 with its size. Removing the
`isFile()` guard kills both directory tests (`.agents/manifests/x21.json`).

---

## 25. Duplicate 500s where its siblings 400 on a symlinked destination (X22)

**Evidence.** `POST /campaigns/briefs/:id/duplicate` mapped only `isExistsError` → 409 and
`InvalidCopyPoolError` → 422 in its outer catch; everything else re-threw to a 500. When
`briefs/<newId>.yaml` is a symlink, `findBriefById` does not see it (`listBriefs` keeps only
`isFile()` entries), so the request reaches `FsBriefStore.createBrief`, which throws
`SYMLINK_WRITE_ERROR` — the exact error `briefs.post.ts` and `briefs/[id].put.ts` both answer with
a 400 `{ error: "Refusing to write through a symlink." }`.

**Consequence.** Duplicating onto a planted symlink — the same attack surface the siblings guard —
leaked a 500 (and a stack-trace-shaped failure) where every other brief write answers 400,
treating a client-side path condition as a server fault.

**Fix shape, when it is worth one.** Add the `errorMessage(error) === SYMLINK_WRITE_ERROR` → 400
branch to the duplicate route's catch, with the siblings' exact body. Note, and deliberately do not
redesign here: `copyAssets` runs inside the lock before `createBrief`, so a symlinked destination
can leave `assets/inputs/<newId>/` behind — the pre-existing 409 path (an unparseable destination
file, which `findBriefById` also skips, turning the `wx` write into an EEXIST) has the identical
leftover property. Both are asset-copy-before-brief-write by construction.

**X22 — shipped in this PR.** The duplicate route's catch now maps `SYMLINK_WRITE_ERROR` to 400
with the siblings' exact body, pinned by a test that plants `briefs/copy.yaml` as a symlink to a
file outside the briefs dir, asserts the 400 and the response body, and asserts the outside file
is unchanged.

---

## 26. The Headline Pool drawer's outcome messages are never announced (X24)

**Evidence.** `HeadlinePoolDrawer.tsx` rendered its asynchronous outcome messages as plain
paragraphs: the unavailable warning and the error (`{error ? <p className="text-[13px]
text-error">…</p>`) carried no live role, while the sibling `AssetPickerDrawer.tsx` gives its
error paragraph `role="alert"`. A failed generate or patch — including the 409 "modified by
another user" — appeared silently for a screen-reader user. The existing tests found the text
with `findByText`, so nothing pinned the missing role.

**Consequence.** The drawer's only feedback for a rejected write was visual. A screen-reader
user who pressed Generate and got a 400, or approved an entry into someone else's revision,
received no announcement at all — the message appeared under a cursor they could not see.

**Fix.** `role="alert"` on the error paragraph, `role="status"` on the unavailable message.
These messages appear once, after a request settles — not on every keystroke — which is why a
live role is right here. No visible change.

**X24 — shipped in this PR.** Both roles are on, pinned by two tests that query by role:
`findByRole("alert")` after a 400 generate, `findByRole("status")` after a 503.

---

## 27. plan:verify ignores a premise fence that is never closed (X25)

**Evidence.** `tools/plan-verify/lib/premises.ts` matched premises with a whole-block regex whose
body (`[\s\S]*?`) demands a closing `^```[ \t]*$` line. A plan whose ```` ```premise W1 ```` block
is never closed does not match at all: the lane vanishes, the run prints "0 premise(s) hold" and
exits 0. Lines 15–17 already treat an empty script as an error precisely because silently
dropping a lane "would otherwise remove the lane from the check entirely" — an unclosed fence is
the identical loss, reachable by the laziest edit imaginable: delete one line from the end of the
block.

**Consequence.** A premise could be silenced not by retiring the lane but by breaking its fence —
the drift detector goes blind on that lane with no signal anywhere, and `plan:verify` keeps its
green exit.

**Fix shape, when it is worth one.** Count opening lines (`^```premise[ \t]+\S`, multiline) and
throw when there are more openings than matched blocks, naming the first unclosed lane. An
id-less opener must not be counted — `premises.test.ts` pins that a fence with no lane id is
ignored.

**X25 — shipped in this PR.** `parsePremises` now collects the index of every FENCE match, counts
openings with `OPENING`, and throws `UNCLOSED  <lane>  (<plan>)` when a lane is closed zero
times. Three tests pin it: an unclosed single block names its lane, a second unclosed block
names the second lane (not the first), and an id-less unclosed fence stays ignored. Removing
the count check kills the first two (`.agents/manifests/x25.json`).

---

## 28. Two packaging requests can delete each other's staging directory (X23)

**Evidence.** `FileSystemPackageStore` stages each platform in a sibling temp dir
(`mkdtemp(`${finalDir}.staging-`)`) and commits it with `rm(finalDir)` + `rename(staging, finalDir)`.
Before creating a staging dir, `ensureStaging` calls `removeStaleStaging(finalDir)`, which deletes
**every** `<platform>.staging-*` sibling — deliberately, so a leftover from a crashed run never
blocks the next one. `apps/api/server/routes/campaigns/package.post.ts` builds a **new store per
request** and takes no per-campaign lock (unlike `generate`'s `acquireJob` and the brief/pool
stores' `withPoolLock`). So: request A stages `instagram-feed.staging-X` and writes `alpha/1.png`;
request B's store, packaging the same campaign+platform, enters `ensureStaging` and its
`removeStaleStaging` deletes A's still-live `staging-X`; A's next `writePackaged` call recreates the
path through `mkdir(dirname(target), { recursive: true })` (output paths are nested, e.g.
`alpha/3.png`) and silently keeps going, so A's `writeManifest` commits a directory whose manifest
lists files (`alpha/1.png`) that were deleted out from under it.

**Consequence.** The class comment promises "a failure never leaves a mixed folder"; this leaves
exactly that — a committed package whose manifest lies about what is on disk, with no error
surfaced to either request. A buyer or downstream automation reading the manifest gets `404`s for
files the manifest says exist.

**Fix shape, when it is worth one.** Nothing here can tell "a staging dir a live store still owns"
apart from "one a crashed run abandoned" by state alone: both look identical on disk (a
`.staging-*` directory nothing has touched since it was created), and the pinned crash-leftover
test constructs exactly that shape on purpose (a store that stages once and is never used again,
i.e. simulates a crash within a single process). A shared in-memory registry of "live" staging
paths — skipped by `removeStaleStaging` — was considered and rejected: nothing ever un-registers
the pinned test's abandoned entry (its owning store is simply never called again, same as a real
crash), so the registry would protect it forever and the pinned test would start failing (a second,
now-orphaned `.staging-*` directory would sit next to the committed one). A lock held from the first
`ensureStaging` call through `writeManifest` has the identical problem — the same abandoned store
would hold it forever and every later request for that platform would hang. Both require a signal
this class does not have: whether the instance holding the entry is still going to call it again,
which only the request handler that owns it knows, and which a per-request store never reports.

Chosen instead: **detect at read time and fail loudly.** `ensureStaging`'s cache-hit path now calls
`assertStagingIntact`, which `stat`s the cached staging directory before handing it back; if it is
gone, it throws instead of letting `writePackaged`'s recursive `mkdir` resurrect a partial tree. This
is a plain disk check, not an in-memory registry, so it is not process-local — it catches the same
race across separate processes sharing the output root, not only within `apps/api`'s single Nitro
process (confirmed via `apps/api/nitro.config.ts` and its `dev`/`preview` scripts: no cluster/fork).
It does **not** prevent the deletion — `removeStaleStaging` still sweeps unconditionally, exactly as
before, which is what keeps the pinned crash-leftover test passing unchanged — so the loser of a
genuine race still fails and must be retried; it only stops the loser from committing garbage.

**Review round 2 (Qodo).** `assertStagingIntact` alone only narrows the corruption, it does not
close it: a sweep can land *after* that check and *before* the write it guards, and if a new request
for the same campaign+platform starts right then, a fresh staging dir with the same name pattern can
exist by the time this store writes again — `assertStagingIntact` would find *a* directory and pass,
but not the one this manifest was staged into, and `writeManifest` would still commit it. Closed with
a second, content-level check: `assertManifestFilesStaged` verifies, right before `rm(finalDir)` +
`rename`, that every file the manifest is about to claim — `packagedPath`, and `posterPath` /
`fallbackPath` when present — is actually present in the staging dir, by mapping each
output-root-relative path back under `staging` (stripping this platform's own directory prefix; a
path that does not start with it is refused the same way — defensive, since every path a real
manifest carries is produced by this same store's own `writePackaged`). If anything is missing, the
commit is refused before `finalDir` is touched, so a previously committed package survives
byte-for-byte. A sweep landing *after* this verification still deletes the whole staging dir, which
now makes `rename` fail outright — an error, never a partial commit. This closes the TOCTOU
partial-commit corruption; what remains is the same as before — the loser of a genuine race still
fails its request and must retry, and the pre-existing window where `rm(finalDir)` can drop a
still-good previous commit before `rename` puts the new one back is unchanged and still out of scope.
Both guard errors were also reworded in this round: the message reaches the export screen through
`PackageForPlatformUseCase`'s existing 422 path, so it now says "Another export of this campaign
started while this one was running, so this export was stopped to keep the package intact. Try
again." — no paths, no internal nouns (staging, sweep, directory) — instead of naming the mechanism.

**X23 — shipped in this PR.** `ensureStaging` verifies a cached staging directory still exists
before reusing it, and `writeManifest` additionally verifies every file its manifest claims is
staged before committing — both throw the same product-facing message and are refused before
`rm(finalDir)` + `rename` runs. Pinned by: the interleaving test (a second store's sweep deletes the
first's live staging dir; the first store's next write rejects, keeps rejecting rather than starting
over, and a prior committed package for that platform is untouched); a test that deletes a
manifest-claimed file out of an otherwise-intact staging dir and asserts `writeManifest` rejects and
the previous commit's bytes are unchanged; and a defensive test for a manifest item whose path does
not belong to the platform being committed. The pinned crash-leftover test
(`__tests__/FileSystemPackageStore.test.ts`, "a failed package never leaves a mixed final directory;
a later commit drops leftover staging") passes unchanged. Mutation manifest:
`.agents/manifests/x23.json` — removing either guard makes its corresponding test fail (2/2 caught).

---

## 29. A read route served any symlink inside the output root, even one pointing outside it (X26)

**Evidence.** `resolveConfined` (`apps/api/server/lib/confined-path.ts`) guards only lexically —
`resolve` + `startsWith(root + sep)`. The three read routes built on it (`GET /output/**`,
`GET /campaigns/packages/:campaignId`, `GET /campaigns/packages/:campaignId/:platform.zip`) then
`stat` / `createReadStream` / `readFile` the result, and every one of those follows symlinks. A
link planted inside the root aimed at anything on the filesystem: `output/leak.txt → /etc/shadow`,
or `output/packages/camp → <elsewhere>`. The write side had refused symlinked targets since
`SYMLINK_WRITE_ERROR` (`briefs.ts`, pinned in `briefs.test.ts`); the read side had no equivalent.

**Consequence.** Any process able to drop a file under the output root — a compromised generation
job, a shared volume — turned a public GET into an arbitrary file read outside it. No `..` needed,
so the lexical guard never fired: the traversal arrived as a filename.

**Fix.** A read-side helper beside `resolveConfined`: `resolveConfinedForRead(base, ...segments)`
keeps the lexical check, then compares `realpath(target)` against `realpath(base)` — comparing
both sides keeps a legitimately symlinked root (macOS `/tmp` → `/private/tmp`) working. A target
whose real path escapes throws like an escape does today; a missing target is returned untouched,
so each route's existing not-found path decides unchanged. Each route turns the throw into its own
not-found answer (the output route keeps 400 for lexical escapes only). `resolveConfined` itself
stays lexical: write paths call it before the file exists, where realpath has nothing to resolve.

**X26 — shipped in this PR.** The three routes call the new helper. Unit tests pin the helper's
four behaviours (outside symlink refused, inside symlink allowed, symlinked root allowed, missing
target untouched) and one route test per route pins that a symlink under the served root answers
that route's existing 404 body with none of the outside file's bytes in the response; a listing
test also pins that an inside symlink stays readable. Dropping the realpath comparison kills the
output-route symlink test (`.agents/manifests/x26.json`).

**X26 round 2 — the check and the read were still two lookups by the same pathname.** Qodo and
CodeRabbit found that `resolveConfinedForRead` validated `realpath(target)` but returned the
lexical `target`; every caller then re-looked the checked entry up by that same pathname (`stat`,
`createReadStream`, `readFile`, `readdir`). A process with write access to the output tree —
exactly the actor this section already assumes — could replace the checked entry with an
outside-pointing symlink in the window between the check and that second lookup, and the read
would follow it. **Fix:** `resolveConfinedForRead` now returns the real path it validated
(`realTarget`) instead of the lexical one, so a caller operating on the return value has no
symlink component left to re-follow; the ENOENT and symlinked-root behaviours are unchanged. The
output route additionally opens that real path once with
`fs.promises.open(realTarget, O_RDONLY | O_NOFOLLOW)` and takes both the size and the streamed
bytes from that single handle (closed on every exit, including a client abort) — a final-component
swap between the helper's check and this open now fails the open itself (`ELOOP`), answering the
route's existing 404, rather than depending on a second realpath comparison. The two package
routes needed no restructuring beyond consuming the corrected return value; their zip walk already
skips symlinked entries via `Dirent.isFile()`/`isDirectory()` (readdir's dirent type does not
follow the link), now pinned by a dedicated test.

**Residual — stated precisely, not more.** Node has no `openat`/`O_BENEATH`: there is no way to
open a path relative to an already-verified directory file descriptor and refuse a symlink in an
*intermediate* component. `O_NOFOLLOW` on the final open covers a swap of the last path segment
only. Replacing a real *directory* on the confined path with a symlink, between
`resolveConfinedForRead`'s check and the subsequent open/stat/readdir, is not closed by this fix —
the read would still follow it. Closing that would require holding an fd on each verified directory
and resolving every remaining segment against it (no such primitive exists in Node's fs API today),
or moving the output tree to a filesystem/mount arrangement where the output process cannot itself
be raced by whatever else has write access to it. The threat this leaves open therefore still
requires write access to the output tree (a compromised generation job, a shared volume — the same
actor named above) plus precise timing of an intermediate-directory swap, not just a planted file.
Mutation manifest: `.agents/manifests/x26.json` — dropping the realpath-vs-root comparison, the
ENOENT passthrough, the real-path return, or `O_NOFOLLOW` on the output route's open each kill a
distinct test (4/4 caught).

---

## 30. The manifest's per-context inventories were stale, and no gate could see it (X27)

**Evidence.** `.architecture/manifest.yaml` lists each bounded context's modules —
`entities`, `value_objects`, `domain_services`, `use_cases`, `ports.in`, `ports.out`,
`adapters` — but the lists had drifted from the tree: `ports.in`/`ports.out` were empty for
every context although ten port files exist (`CampaignOrchestration/src/application/ports/{in,out}/*.ts`
— `CampaignPipelinePort`, `BackgroundCachePort`, `CompliancePort`, `CompositorPort`,
`CopyGeneratorPort`, `ExportPort`, `ImageGeneratorPort`, `PlatformProfilePort`,
`VideoCompositorPort`, plus `Distribution/.../out/PackageStorePort.ts`), every `adapters`
list was empty although thirteen adapters exist, and four value objects and one use case of
`CampaignOrchestration` were undeclared. `hexagen arch validate` passes regardless — it
checks layer rules, not inventory — and `sync --check` only compares the tree against what
the manifest *emits*, and an empty list emits nothing.

**Consequence.** The manifest — the document the advisory PR reviewer, the ownership
registry and every new lane reads first — described a system with no ports and no adapters.
A reader trusting it concludes the hexagonal core has no boundaries at all.

**Fix.** Reconcile every list with the tree, and add the missing gate. The reconciliation
surfaced a second, deeper drift: hexagen's built-in stub naming (`{name}.in-port.ts`,
`{name}.adapter.ts`) does not match this repo's committed `<Name>Port.ts` / `<Name>.ts`
convention, so declaring any port or adapter made `sync --dry-run` plan to **create** a
duplicate stub beside every real module (e.g. `CampaignPipelinePort.in-port.ts`) — an
undeclarable gap, not a paperwork one. Aligning `generator.sync.stubs.naming` with the
files that actually exist removed every creation intent (verified: Stubs 0/0/0 created/
updated/deleted, 46 skipped, Total ops 0). Kebab-case data modules (`advertising-units.ts`,
`canvas-util.ts`, …) stay out of inventory by rule: the generator PascalCases every entry
name when it derives a filename, so such a file can never be a manifest module — the rule
is stated in `tools/arch-inventory/lib/naming.ts` and applied by the new check.

**X27 — shipped in this PR.** `.architecture/manifest.yaml` now lists all 46 modules
(10 ports, 13 adapters, the missing value objects and use case included), and
`tools/arch-inventory` (`yarn arch:inventory`, wired into CI next to `plan:verify`)
compares each of the seven lists against its folder — stale declared entries and missing
module files both fail — using the generator's own naming rules read from the manifest, so
the gate tracks convention changes instead of freezing them. Before the reconciliation it
reported **28 missing, 0 stale**; on the reconciled manifest it reports no drift. Unit
tests pin the comparison, the manifest parsing and the CLI exit codes on temp fixtures, not
the real tree. Mutation manifest: `.agents/manifests/x27.json` — skipping the ports lists in
the comparison kills the missing-port test, and treating a stale entry as fine kills the
stale test (2/2 caught).

**X27 — remediation (this PR).** Follow-up review (Qodo/CodeRabbit/PR-Agent) found the tool
above had re-implemented hexagen's own manifest model — parsing `.architecture/manifest.yaml`
with the bare `yaml` package (undeclared at the root: a transitive hoist, not a real
dependency) instead of the generator's own `loadManifest` — and that `.agents/architecture.md`
pointed contributors at a command that discards the fix. Both are corrected:

- `tools/arch-inventory` now loads the manifest through `@hexagen-monaco/sync`'s own
  `loadManifest` (anchors, split manifests, and the owned-port object form `{ name, owner? }`
  are its job, not this tool's), and resolves file names the way the generator does —
  `DEFAULT_NAMING`, then `generator.sync.stubs.naming`, then a context's own
  `generator.stubs.naming` override — reusing hexagen's exported `portName` and
  `sanitizeScope` (`resolveScope` is declared in the package's types but is **not** part of
  its runtime export list; this tool reimplements its precedence on top of the primitive
  hexagen does export, and says so in `naming.ts`). The check now also catches two declared
  entries that resolve to the same file (or a literal repeat), and a bare `{name}` naming
  template no longer collapses every entry to `"Stub"` (an off-by-`-0` in the suffix-slice).
  A malformed stub-naming template, or any other failure while resolving the manifest, now
  exits with the tool's malformed-input code and a message — the CLI no longer rethrows an
  unrecognized error as an uncaught exception.
- `.agents/architecture.md` and a new comment above `generator:` in
  `.architecture/manifest.yaml` now say to declare ports and modules by hand and verify with
  `yarn arch:inventory` + `yarn sync:dry`, and name why: **`hexagen arch port` and
  `hexagen arch context` both save the manifest through a path
  (`generateManifestYaml`/`generateManifestYaml2` → `saveManifest` in
  `@hexagen-monaco/sync`'s `dist/cli.js`) that keeps only `system, scope, architecture,
  bounded_contexts, monorepo, apps`** — verified against `dist/cli.js`; it drops the
  top-level `generator:` block, which holds this repo's `naming` overrides, so the next such
  command would scaffold duplicate stub files beside every real port and adapter. This is an
  upstream hexagen-monaco limitation, not a campaign-foundry one: `generateManifestYaml`/
  `generateManifestYaml2` should preserve `generator:` (or merge into it) the way the
  separately-exported `saveManifest` in `dist/index.js` already does (`yaml3.dump(manifest)`,
  no whitelist) — filed for the hexagen-monaco repository, not fixed here.

  One reviewed finding turned out **false** on inspection and was not applied: hexagen does
  **not** read a layer's configured `subfolders` (`generator.sync.layers.*.subfolders`) to
  decide where a named entity/port/adapter is written. `buildEmissionPlan` and
  `resolveEmissionDir` (`dist/index.js`) hard-code the seven emission sites
  (`domain/entities`, `domain/value-objects`, `domain/services`, `application/use-cases`,
  `application/ports/in`, `application/ports/out`, `infrastructure/adapters`) and only the
  layer's own `folder` is manifest-configurable; `subfolders` is read solely by
  `ensureLayerFolders` to scaffold empty placeholder directories. `tools/arch-inventory`
  already hard-codes the same seven sites (`inventory.ts`'s `LISTS`), which is the generator's
  own behavior, not a shortcut — reading `subfolders` instead would have made the check
  diverge from what hexagen actually does.

  Also confirmed, unchanged (PR-Agent, declined): an empty configured layer `folder` does not
  produce a leading double slash — hexagen's own `isSafeLayerFolder`/`resolveLayerDir`
  (`dist/index.js`) already treats an empty string as unsafe and falls back to `src/<layer>`,
  and this tool's own `layerFolders` does the same.

  Mutation manifest `.agents/manifests/x27.json` now carries three mutations — skipping the
  ports lists, treating a stale entry as fine, and dropping the duplicate check — all replay
  as caught (3/3). `yarn arch:inventory` and `yarn sync:dry` were re-run against the real
  repo after the rewrite: still no drift, still `Total ops : 0`.

---

## 31. A style-only element edit left the weight meter reading a stale byte count (X28)

**Evidence.** `htmlWeightKey` (`apps/web/src/components/campaign/derive.ts`) serialised each
gathered element as `[el.kind, el.text ?? "", el.frame]`. HL5e made `assembleHtml` write the
element's `style` into the inline CSS — so the assembled `byteLength` became a function of a
field the single-entry memo key did not contain. Changing one element's font family or weight
and nothing else hit the cache and returned the previous reading.

**Consequence.** The meter and the over-budget warning disagreed with the unit generation
would actually produce, silently, behind the memo — the exact figure HL-D6 exists to make
trustworthy.

**X28 — shipped in this PR.** The key now carries each element's `fontWeight`/`fontFamily`,
flattened in `ELEMENT_STYLE_FIELDS` declaration order, with absent / `{}` / all-undefined
blocks keying identically — because `htmlElementFont` and `elementStyleProblem` resolve them
identically, so the key stays no stricter than the domain's own vocabulary. Red-first tests
prime the reading and change only `fontWeight`, then only `fontFamily`, asserting the new
figure equals `assembleHtml(...).byteLength` computed independently (each with a sanity that
the override moves the byte count at all), plus a spy-counted test pinning the `{}` key-equals-
absent no-reweigh. Mutation manifest `.agents/manifests/hl5e.json`: dropping the two style
slots from the key kills the re-weigh tests (caught).

---

## 32. The generation path trusted an element's style that no boundary had checked (X29)

**Evidence.** `assembleHtml` interpolates `htmlElementFont(...)`'s `fontWeight`/`fontFamily`
straight into a quoted `style="…"` attribute. The API boundary's `layerElementsProblem`
allowlists both values, so a *parsed* brief is safe — but
`GenerateCampaignUseCase.validateBrief`, the repo's declared defence-in-depth for
programmatic callers that bypass parsing, checked the brief-level `style` (`styleProblem`,
the T5 precedent) and the click destination while forwarding the template's html elements to
the assembler unchecked.

**Consequence.** A programmatic `CampaignBrief` carrying
`style: { fontFamily: '"><script…' }` on an element reached the shipped markup — a value no
boundary had ever refused.

**X29 — shipped in this PR.** `validateBrief` now applies the same `layerElementsProblem`
the API parse and the stored-draft guard read to every template layer's elements, refusing
in the use case's existing `Campaign brief field "…" must …; got …` shape, mirroring the
`styleProblem` call above it. The font values are deliberately *not* escaped in the assembler
instead: the vocabulary allowlist stays the single source of truth, and escaping would hide an
invalid value rather than refuse it. Red-first tests: a forged quote-bearing `fontFamily` and
an off-vocabulary `fontWeight` are refused before any port is touched and no `index.html` is
exported, while a valid override still generates. Mutation manifest `.agents/manifests/hl5e.json`:
removing the refusal kills the forged-family test (caught).

---

## 33. The CI-only timeout on the brief editor's slowest tests is a margin problem, not the weight meter (X30)

**Evidence.** `brief-editor.test.tsx` failed in CI with `Test timed out in 5000ms` on four tests
("a motion brief authored from scratch saves with its motion policy", "motion without a kind or a
duration blocks Save", "a motion brief on a host without motion stays read-only…", "Save refuses a
click destination the API would refuse") — duration, not flakiness: on SHA `591ac73b`, the push run
passed in 4m20s and the PR run failed in 9m51s, and a re-run of the failed job failed again.

The lead hypothesis — HL5c/HL5f/HL5e's html weight meter doing real assembly work on every
keystroke — is **disproven**. None of the four tests select a platform whose `formats` include
`html` (`social-post`'s preset ships `instagram-feed`/`linkedin`/`x`, and the motion test adds
`instagram-reel`; only the two `*-html` display profiles carry `html`), so `htmlByteBudget` returns
`undefined` and `htmlWeightReading` returns before ever calling `assembleHtml`. Spying on
`assembleHtml` across all four tests, run to completion, measured **`assembleHtml: 0`** in every
one. `toBrief`/`validateState`/`validateWarnings` were also spied and timed directly: `validateState`
is called ~30–40 times per test (once for the visible errors, once for the structural/motion-host
check, per state change) but the cumulative time **inside** it across a whole test never exceeded 11ms
— not the cost.

Checked out `origin/main~6` (`a4476f3f`, before HL5c introduced the meter at all) and ran the same
four tests, three times each: medians were statistically the same as at HEAD (`f443fe4d`) — e.g.
"motion without a kind or a duration blocks Save" at ~1190ms pre-meter vs ~1190ms at HEAD, "Save
refuses a click destination" at ~815ms vs ~837ms. **These four tests were already the slowest tests
in the file before the meter existed.** There is no code-level regression from HL5c/HL5f/HL5e to
bisect; the CI timeout is a margin problem a loaded runner exposed, not a regression these lanes
introduced.

The real, measured cost: a `React.Profiler`-wrapped render showed a single user gesture (one
`dispatch`) committing the whole "everything"-presentation tree **three times**: the dispatch's own
render, a second because the validate-on-change effect (`errors`/`warnings`/`blockedAt`) mirrored
`state` into `useState` via `setState` calls of its own (a pure derivation with no other writer,
paying its own commit for nothing), and a third from the dirty-flag effect (`setDirty`, a context
setter whose provider outlives the route). Each of these four tests carries the highest interaction
count in the suite (many typed characters plus several motion-kind toggles), so they pay this
3-commits-per-interaction tax the most.

**Consequence.** A pre-existing rendering inefficiency (extra full-tree commits per interaction)
combined with the suite's most interaction-heavy tests to leave the smallest margin against the
fixed 5000ms per-test timeout — invisible on an idle runner, and exactly the margin a loaded CI
runner (concurrent test-file workers contending for CPU) spends first.

**X30 — shipped in this PR.** `errors`, `warnings`, and `blockedAt` in `BriefEditor.tsx` are now
derived with `useMemo` from `state` (and the brief id list) instead of mirrored into `useState` from
a `[state, briefs]` effect — folding the effect's own commit into the render `dispatch` already
scheduled. Verified directly: a `React.Profiler`-based render count for a single motion-kind click
dropped from 3 commits to 2 (the dispatch's own, plus the still-present dirty-flag effect). The html
weight meter's cache, key, and reported figure are **untouched** — HL5c/HL5f/HL5e's tests pass
unchanged, and this section states plainly that the meter was innocent rather than "fixing" it
without cause. Test-first (red before the fix, green after, work-count not wall-clock): a
`React.Profiler`-wrapped render asserts a single motion-kind toggle commits the editor at most
twice, never three times — failing with "expected 3 to be less than or equal to 2" on the pre-fix
effect-based code and passing at 2 after. Mutation manifest `.agents/manifests/x30.json`: reverting
the `useMemo` derivation back to the `useState`+effect mirror reopens the third commit and the new
test catches it (caught, reproduced by `yarn mutate:verify`). No second mutation is recorded: the
brief's suggested "drop a slot from the html weight key" mutation presumes the fix touches
`htmlWeightKey`, and X30 never does — manufacturing one to fill the slot would be dishonest about
what this PR actually changed.

**A coverage drop this fix surfaced, not caused.** The full gate flagged `LogoField.tsx` losing
branch coverage on `invalid ? "border-error" : "border-border"` inside the filled-tile block.
Grepped every writer of the `product-N-logo` error key across `apps/web/src`: exactly one —
`validateProducts` (`validate.ts:265`), gated strictly by `product.logoPath.trim() === ""`, message
text "No logo yet — upload one with the Logo button." `BriefEditor.tsx` adopts no server/API
refusal into `errors` (no `setErrors` call exists anywhere in the file post-X30; `errors` is the one
`useMemo` over `validateState`), and no other render site of `ProductsSection` passes a different
`errors` object. So `hasLogo` (a non-empty path) and `invalid` (an empty path) **cannot coexist in
any settled state** — old code or new. Reproduced empirically by instrumenting `LogoField` and typing
into an initially-empty, already-touched logo field on both refs: `origin/main` (the old
`useState`+effect mirror) hit `{value: "a", invalid: true}` every time — a real, reproducible
combination — while this branch never does. Mechanism: with `errors` one commit stale relative to
`state`, typing the first character into an empty field produced one render where `state.logoPath`
was already non-empty but `errors` still carried the just-stale "required" error — a false red
border flashing on a value the user had just typed correctly, for exactly one paint, on every such
keystroke throughout the suite (this is what fed the branch's coverage on `main`). X30's synchronous
`useMemo` derivation removes that stale frame, which removes the flicker, which removes the only
thing that ever executed this branch.

This is not a lost refusal — the "logo required" error still shows, and is still fully tested,
whenever the path really is empty. The branch was unreachable through genuine application behaviour,
covered only by the accident this lane fixes. Rather than carry a documented exception (a coverage
gate that quietly excuses a branch nobody can reach is the same defect this repo calls out
elsewhere), the branch is removed: `LogoField.tsx`'s filled-tile border is now unconditionally
`border-border`, with a comment at the site naming the invariant (the sole logo rule is "path is
empty") and stating that if a future rule can flag a non-empty path — a missing asset, a bad
extension, a server refusal — the conditional returns **with a test that reaches it through real
application behaviour**, not a hand-constructed prop. `invalid` stays live everywhere else it is
still reachable: the empty-tile block and the hidden mirror input's `aria-invalid`.

## 34. X30 closed one commit per gesture; the dirty-flag and panel-publishing effects still cost a second, and a real product bug costs a third on some keystrokes (X32)

**Evidence.** X30 (merged, `4540ce0b`) folded the validate-on-change mirror into a `useMemo`,
dropping a motion-kind click from 3 commits to 2. On the branch CI run after X30 merged,
`brief-editor.test.tsx` still failed with `Test timed out in 5000ms` on the same three tests plus
X30's own commit-count test — same SHA, 4m20s pass on the push run and 9m51s fail on the PR run.
X30 named two remaining candidates without verifying them: the dirty-flag effect's own commit
(`setDirty`'s cleanup running on every `state` change, not only unmount, so an unrelated keystroke
paid a false→true round trip through `EditorDirtyContext` even when the flag was already `true` on
both sides), and an unexplained gap where a keystroke cost one commit more than a click even after
X30 (3 vs 2).

Re-measured directly with `React.Profiler`, isolating each candidate:

- The dirty-flag round trip is real (two distinct `setDirty` calls, `false` then the real value,
  every time `state` changes) but does **not** cost an extra commit by itself: React's automatic
  batching folds a same-effect cleanup-then-body pair into one commit regardless of whether the two
  calls carry the same value or different ones. Reverting the fix below alone does not fail any test
  in the suite.
- The panel-publishing effects (`setTopPanels`/`setPanels`, ~L800/~L850) had the identical shape — an
  unconditional `return () => setPanels(null)` forced a real null→JSX round trip through
  `EditorPanelsContext` on every state change, even though the fresh content overwrote the null in
  the same effect flush. Same finding: batching absorbs it, and reverting this fix alone does not
  fail any test either.
- The commit X30 attributed to "the dirty-flag effect" in its pre-fix baseline was real (3 commits
  per interaction), but it came from the validate-on-change mirror's own separate `useEffect`
  (independently scheduled, with its own `setState` calls) being folded away by X30's fix — not from
  the dirty effect's internal round trip needing two commits on its own. X30's diagnosis of *what*
  was costing the third commit pre-fix was right; its prediction of what fixing the dirty effect's
  round trip would do post-fix does not hold under this React version's batching.
- The actual, unexplained "keystroke costs one more than click" gap (bullet 3, X32's own brief) is a
  genuine BriefEditor bug: `handleMainBlur` called `setTouched((prev) => new Set(prev).add(key))`
  unconditionally. Re-blurring a field the user had already visited once — correcting an earlier
  field after filling the rest of the draft, an entirely ordinary gesture — built a fresh `touched`
  reference for zero semantic change every time. `visibleErrors` depends on `touched` by reference,
  so that fresh reference republishes the top panels for nothing. `touchSectionFromEvent`, declared
  three lines above the same handler, already carried the correct `prev.has(x) ? prev : new Set(...)`
  guard — `handleMainBlur` simply never got it. Measured directly: re-blurring an already-touched
  field (Target Region, touched once by `fillValidDraft`'s own progression) and then typing into a
  different field costs **5 commits** with the bug, **3** with the guard.

**Consequence.** The suite's slowest tests carry many corrections and toggles (motion-kind switches,
going back to fix an earlier field after validation reveals it), each of which re-blurs
already-touched fields repeatedly. Each redundant re-blur republished the panels for nothing, adding
real, avoidable commits — and therefore real, avoidable render time — on exactly the interaction
pattern those tests exercise most.

**X32 — shipped in this PR.** Three changes to `BriefEditor.tsx`:

1. The dirty-flag effect now guards on a ref holding the last value actually published, so an
   unchanged boolean is a no-op; the unmount-only clear moved to its own `useEffect(() => () =>
   setDirty(false), [])`. Kept even though it does not move this suite's commit counts: it halves the
   number of writes into a context with subscribers outside this Profiler's reach (Header, Sidebar
   both consume `EditorDirtyContext`), which is a real cost this repo's test infrastructure cannot
   observe from inside `BriefEditor`'s own boundary.
2. The panel-publishing effects (`setTopPanels`, `setPanels`) no longer null their content on every
   dep change — only the M3/D83 "nothing to publish" gate nulls explicitly now, and unmount is its
   own effect. Kept for the same reason as (1): fewer writes into `EditorPanelsContext`, whose
   `EditorPanelsOutlet` consumer sits outside this suite's Profiler-measured tree.
3. `handleMainBlur`'s `setTouched` call now guards exactly like `touchSectionFromEvent` already did:
   `(prev) => (prev.has(key) ? prev : new Set(prev).add(key))`. This is the fix that actually moves a
   test.

**Commit counts, before → after:**

| Gesture | Before X32 | After X32 |
| --- | --- | --- |
| Click (motion-kind toggle, already dirty) — X30's own test | ≤ 2 (unchanged) | ≤ 2 (unchanged) |
| Keystroke, continuing to type in an already-focused field (steady state) | 3 | 3 (unchanged — see below) |
| Keystroke that re-blurs an already-touched field (the ordinary "go back and fix a field" gesture) | 5 | 3 |

The "3" that does **not** move (steady-state typing in an already-focused field) is not a
BriefEditor effect: instrumented every `setState` call BriefEditor's effects make (`setDirty`,
`setTopPanels`, `setPanels`, the D35 `setDraftRun` handoff, `setTouched`, `setTouchedSections`) and
confirmed each bails out correctly on that gesture — the third commit lands before this component's
own `dispatch` runs, before any of them. A control isolates it precisely: passing `{ skipClick: true
}` to `userEvent.type` (keyboard events only, no pointer events, on an already-focused field) drops
it to 2, matching a click. `userEvent.type` always precedes typing with a click sequence
(mousedown/mouseup/click) to establish focus and caret position, modelling a real user clicking into
a field before typing; that click lands on a controlled `<input>`, which pays a React-internal commit
a button's click never does. Not fixable without decontrolling the field — a correctness regression
(the typed value would stop round-tripping through validation) this lane will not make. This is the
honest floor "one gesture, one commit" hits for a keyboard gesture into a controlled text field:
3, not 1, and not fixable further from this layer.

**Test-first (red before, green after, work-count not wall-clock).** Extended X30's `React.Profiler`
approach with two new tests in `brief-editor.test.tsx`:

- `"a single keystroke into a text field commits the shell at most three times (X32)"` — fills a
  valid draft, revisits an already-touched field (the `handleMainBlur` guard's target), then types
  one character into a different field. Failed pre-fix with "expected 5 to be less than or equal to
  3"; passes at 3 post-fix.
- `"the dirty flag sets on a real edit, ignores a no-op edit, clears on save, and clears on unmount
  (X32)"` — a `DirtyProbe` component reading `useEditorDirty().isDirty` directly, pinning the
  semantics the ref-guard must preserve: unmount still clears it, a first real edit still sets it, a
  save still clears it, and replaying an unchanged value through the same `onChange` path does not
  toggle it. This test is unaffected by either mutation below (it pins correctness, not the
  ref-guard's performance claim) and passes unchanged throughout.

The four previously CI-timing-out tests ("a motion brief authored from scratch...", "motion without a
kind or a duration...", "a motion brief on a host without motion...", "Save refuses a click
destination...") pass unchanged — no test edit was needed for them, which is itself a finding: this
lane's fixes reduce real commit volume on the repeated-correction interaction pattern those tests
exercise, but the CI-only margin problem (idle-runner timing cannot reproduce it locally, matching
X30's own finding) is not something a single local verification pass can confirm as closed by
wall-clock alone.

**Mutation manifest (`.agents/manifests/x32.json`).** One mutation recorded and verified caught:
reverting the `handleMainBlur` guard turns the keystroke work-count test's measured gesture from 3
commits to 5. The brief's two suggested mutations — reverting the dirty effect's ref guard, and
reverting the panel effects' unconditional null-republish — were tried individually against every
test in this file and neither fails anything: applied alone, each still leaves every measured gesture
at its post-X32 commit count, because React's automatic batching folds the reintroduced
cleanup-then-body round trip into one commit regardless. Both fixes are kept for the reason given
above (fewer writes into contexts with subscribers outside this suite's Profiler reach), but
recording either as "caught" by a test that does not, in fact, fail without it would be exactly the
dishonesty X30's own manifest declined to commit for its second slot — so the manifest carries a
`note` explaining this instead of a second, false, mutation entry.

**The test's own cost, measured but not changed.** `fillValidDraft` types every field character by
character through `userEvent`, so its cost compounds: a first character into a newly-focused field
costs 3 commits (the click-driven React-internal commit plus dispatch plus the panels republish),
every subsequent character in the same field costs 2 (dispatch plus panels republish, verified
directly: typing 3 characters in one `.type()` call after the field is already focused costs exactly
7 = 1 + 2×3). `fillValidDraft`'s own sequence — 8 field entries, 22 characters total — costs
approximately 8×1 + 22×2 = 52 commits by this accounting. Replacing each `user.type(field, text)`
with a single `fireEvent.change(field, { target: { value: text } })` would cut this to roughly
8×2 = 16 commits (no click-driven cost at all, confirmed: `fireEvent.change` alone costs exactly 2,
matching a click), a ~70% reduction — a legitimate, assertion-preserving remedy this brief explicitly
allows for setup-only typing. **Not applied in this PR**: `fillValidDraft` is called by effectively
every test in this 180-test file, not only the four historically slow ones, so changing it is a
broader-blast-radius change than a single narrowly-scoped performance lane should take on without its
own dedicated verification pass across the whole file; and local timing cannot reproduce the CI-only
margin problem in the first place (matching X30's own finding), so there is no local feedback loop to
confirm a wall-clock win from this change without a CI round-trip, which is out of scope for one
lane's verification pass. Recorded here as a finding for whichever lane next touches this suite's
setup cost.
---

## 35. A selective re-roll's guard covers the variation axes, not the brief's copy or scenes (X33)

**Evidence.** A selective re-roll (`regenerateOnly`, the HITL re-roll of one or a few cells) is
pinned to the persisted report's `policyHash` so a re-roll cannot overlay one slot onto a plan that
has since changed underneath it (`apps/api/server/routes/campaigns/generate.post.ts`'s
`persistedPolicyHash`, checked in `runCampaign`, `pipeline.ts` ~181: `if (planned.value.policyHash
!== expectedPolicyHash) return err(...)`). That hash — `hashPolicy` in `VariationPolicy.vo.ts`
~265 — covers exactly the variation **axes**: `axisProductSize`, `backgroundSource`, `count`,
`coverage`, `layout`, `minDistance`, `paletteShift`, `productIds`, `ratios`, `seed`, `tone`, and
(conditionally, only when in use) the motion axes (`duration`/`mixStatic`/`motion`/`motionRatios`)
and the `headline`/`anchor` axes. It hashes nothing about the brief's free-text copy
(`campaignMessage`, `localizedMessage`) or its `copy.timeline` — neither the beats' `text` nor,
since VE5b2, their `background`.

**Consequence.** Two symptoms of the same hole, one pre-dating this lane and one it extends:

1. **Copy.** Editing the brief's message or a timeline beat's text and then re-rolling one
   *other* cell passes the `policyHash` check (the axes are unchanged) and merges the new copy
   into a campaign report that still carries other cells rendered under the old copy — one
   persisted report mixing two versions of the brief's message, silently.
2. **Scenes (VE5b2).** The identical mechanism now applies to a beat's `background`: editing
   which scene a beat names and re-rolling one cell merges that cell's new-scene output into a
   report whose other motion cells still show the old scene — because `hashPolicy` never covered
   `copy.timeline` at all, adding `background` to a `CopyBeat` (VE5a) could not have introduced
   this hole and VE5b2 (wiring scene bytes into generation) does not either; it only gives the
   pre-existing gap a second, visible way to bite.

**Fix sketch — not shipped — lane X33.** Widen `hashPolicy`'s input (or add a second hash
alongside `policyHash`) to cover the brief's copy surface — `campaignMessage`, `localizedMessage`,
and `copy.timeline` in full (beat text and `background` together, since both are the same class of
"content the re-roll must not silently mix") — and refuse a re-roll whose copy hash has moved,
the same way a moved `policyHash` is refused today. This is cross-cutting (it touches
`VariationPolicy.vo.ts`, `pipeline.ts`, and `generate.post.ts`, none of which VE5b2 owns) and
belongs to its own lane rather than either lane that exposed a symptom of it.
---

## 36. `fillValidDraft`'s own typing was the last unowned cost in the editor's CI margin (X34)

**Evidence.** X30 (`§33`) and X32 (`§34`) each measured and fixed a real rendering inefficiency in
`BriefEditor.tsx` — three commits per gesture down to two, and a re-blur bug down from five commits
to three — and each time `brief-editor.test.tsx` still timed out in CI at the fixed 5000ms
`testTimeout` on the same handful of tests. X32 named what was left without touching it:
`fillValidDraft` (and the individual per-field `user.type` calls three of the four historically
slow tests make right after calling it) drives `userEvent` character by character to reach a valid
draft, so every one of the file's 180-plus tests pays the full per-keystroke commit cost — three
commits for the first character in a newly-focused field, two for every character after — purely to
get eight fields into a state no assertion in most of those tests cares about the *keystrokes* for.
X32 measured the shape of this cost (`fillValidDraft`'s own sequence: 8 field entries, 22 characters,
≈ 8×1 + 22×2 = 52 commits by its accounting) and explicitly declined to touch it inside a product
lane, both because the helper is shared by the whole file and because local timing cannot reproduce
the CI-only loaded-runner regime that actually times these tests out — matching X30's own finding.

**The rule that decided every case here.** Typing that is the behaviour a test asserts on — that a
keystroke validates, that touched/dirty state flips, that history coalesces — must keep driving
`userEvent` exactly as it did. Only typing whose sole purpose is to get the draft into a valid state
so the real assertion can run is setup, and setup may take the cheapest form that produces the same
editor state. Grepped every top-level and describe-scoped helper in the file for a second
`fillValidDraft`-shaped sibling: none exists for the editor's own draft. Two do exist for a different
dialog — `fillDialog` (declared once in "the create seed (W1)" and again, identically, in "the
abandoned-draft two-way (W3 / F19)"), which types one field ("Summer Spark") into the Create Campaign
dialog's name input before confirming. Left unconverted: at least one of its eight call sites asserts
the exact typed string round-tripped through the seed-application handoff
(`expect(...).toBe("Summer Spark")`), so whether the *typed value itself* is the thing under test
there is ambiguous — this brief's own rule says ambiguous is behaviour, and `fillDialog` sits outside
the CI-margin investigation X30/X32/X34 have been tracking (it costs one field across eight tests, not
eight fields across 180). Reported here rather than converted. Every other `user.type` call in the
file sits inside an individual test's own body, driving the specific field that test's assertion is
about (e.g. typing the click destination whose validity `Save` must refuse, or re-typing a headline to
assert a debounce or an undo step) — those are behaviour under test and are unconverted.

**Coverage check (no `test:cov` run, per this lane's memory budget — checked by inspection instead).**
`fillValidDraft` typing produced a range of intermediate field values on every keystroke; the fast
path produces only the final value. Two sites looked like they might depend on that range for branch
coverage, X30's own coverage-drop pattern (`§33`) exactly:
- `LogoField.tsx`'s `fileExt = extMatch ? extMatch[1].toUpperCase() : "IMG"` computes on every render,
  gated behind nothing — so the `"IMG"` arm fires on the empty `value=""` every field starts at (both
  before and after this change, on every mount), and is exercised directly and repeatedly by
  `LogoField.test.tsx`'s own `value=""` fixtures. Not a coverage-only branch; unaffected.
- `chip-group.tsx`'s custom-input-open path (`isCustomValue`/`showCustomInput`, `packages/ui`): typing
  `"D"` then `"DE"` into Target Region used to open and close the "Other…" input transiently, since
  `"DE"` is a known `REGION_OPTIONS` value but `"D"` alone is not. The fast path never passes through
  `"D"`. But `packages/ui/src/__tests__/chip-group.test.tsx` drives this exact open/close flow
  directly (clicking "Other…", a known value arriving from outside closing it again) — this file's
  typing was never the only place that branch ran, and `packages/ui` is not this lane's area regardless.
No gap found at either site; both stay covered by their own component-level tests independent of this
conversion.

**X34 — shipped in this PR.** `fillValidDraft`'s eight `user.type` calls became one `fireEvent.click`
(marks the field's section touched — `touchSectionFromEvent`'s `onClickCapture` — exactly as the
click `userEvent.type` fires before every keystroke does), one `el.focus()` (moves real DOM focus,
which blurs whatever was focused before — `handleMainBlur`'s `onBlurCapture` — the same way focus
moving to the next field does mid-typing), and one `fireEvent.change` (the field's final value in one
dispatch instead of one per character). The one non-typing step (`Add product`, a button click) is
unchanged.

A first version of this fix used `fireEvent.change` + `fireEvent.blur` only, and an equivalence test
that compared only the saved draft. Model review (Qodo) on the PR caught what that version and that
test both missed: `fireEvent.change` + `fireEvent.blur` never fires a click, so `touchedSections`
stayed empty instead of gaining "identity"/"copy"/"products" the way real clicks-before-typing
populate it, and the sequence left the *last* field blurred (via the explicit `fireEvent.blur`)
instead of focused, where the typed path leaves it. Both are real, observable differences in
interaction state that a POST-body-only comparison cannot see, and the fact that all 182 tests passed
either way was evidence no test depended on it *yet* — not evidence the setup was equivalent. Fixed as
described above, and re-measured (numbers below already reflect the fix).

Proved equivalent, not asserted: the equivalence test now pins three things, not one —
`"fillValidDraft's fast path produces the same draft, touched sections, and focus the typed path
produces (X34)"` drives the *original* character-by-character sequence in one render and the
converted helper in a second, and compares (a) the two Save POST bodies (`toBrief(state)`'s wire
shape — no key order or intermediate frame visible either way, only the value each field settles on),
(b) which sections read as touched, observed through rendered state since there is no direct accessor
— after filling, product 0's colour is set to an invalid hex through its plain `<Input>`
(`fireEvent.change` only, no click or blur, so this cannot mark anything itself) and the test checks
whether the resulting error renders, which only happens if the Products section already reads as
touched, and (c) `document.activeElement`, identified by `Field`'s `data-field-key` (not the node,
since the two paths render separate trees) rather than the raw element. All three pass, and are equal
between the two paths; (c) is pinned to the concrete expected value ("product-1-logo", the second
product's Logo Path) rather than only to "the two paths agree." The X30 and X32 commit-count tests and
the four originally slow tests all pass unchanged — no test besides the new one was touched.

**The touched-sections check has an honest limit, reported rather than hidden.** (b) above proves the
Products section reads as touched in both paths, but it cannot isolate *why* — `fillValidDraft` always
clicks the real `Add product` button (unconverted, unchanged by this lane) once, before either path
ever writes the second product's fields, and that click alone already marks Products touched
regardless of what `setField` does per field. Manually reverting only the `fireEvent.click(el)` inside
`setField` (keeping `.focus()` and `fireEvent.change`) leaves this specific assertion passing — it does
not, and cannot, isolate the per-field click's own contribution for Products. Identity and Copy have
no candidate at all: every field either section contains is also directly field-touched by its own
blur, which already satisfies `visibleErrors`' gate on its own, so section-level touch produces no
additional externally observable difference there regardless of clicks. The click is kept in
`setField` anyway — it is what the real typed path does before every keystroke, and it is what would
actually change `touchedSections` for a differently-shaped `fillValidDraft` call in the future, even
where this file's current fields cannot expose the difference today. Recorded in
`.agents/manifests/x34.json`'s `note` rather than manufacturing a mutation this test does not, in
fact, catch — the same discipline X30's and X32's manifests already applied to their own declined
slots.

**Measured, three runs each, median stated (this machine, not CI; numbers below are for the
click+focus+change version, after the model-review fix):**

| Measurement | Before | After | Change |
| --- | --- | --- | --- |
| Commits for one `fillValidDraft` call (`React.Profiler`) | 70 | 30 | −57% |
| Whole file, wall-clock | 30.54s | 27.42s | −10% |
| "Save refuses a click destination…" | 579ms | 415ms | −28% |
| "a motion brief authored from scratch saves…" | 905ms | 681ms | −25% |
| "motion without a kind or a duration blocks Save…" | 1038ms | 821ms | −21% |
| "a motion brief on a host without motion…" (no `fillValidDraft` call) | 165ms | 149ms | ~0% (expected — unaffected; within run-to-run noise) |

The commit-count drop (57%) lands close to X32's own rough estimate of "≈70% reduction" for
converting this typing — closer than the first (change+blur-only) version's 51% did, because a click
event costs less than the blur this version no longer fires explicitly (blur now happens implicitly,
once, when the *next* field's `.focus()` runs — one blur total across the sequence's internal
transitions instead of one per field). That is the honest number for the equivalence this lane
actually ships, not the number either a less careful or a more literal-minded conversion would hit.

Mutation manifest (`.agents/manifests/x34.json`): three mutations against the equivalence test — (a)
skip the second product's logo field entirely, (b) write a different value ("z" instead of "a") into
Target Audience, (c) drop `el.focus()` from `setField` (added after the model-review fix, per the
brief that raised it: prove the new focus assertion actually pins something the draft comparison
cannot see). (a) and (b) leave the draft structurally valid, so only the byte-for-byte body comparison
catches either; (c) leaves the draft byte-identical (focus never touches `state`), so only the focus
assertion catches it. All three caught, reproduced by `yarn mutate:verify`. A fourth candidate — drop
`fireEvent.click(el)` — was tried and does not fail any current assertion, for the reason given above;
not recorded as a mutation, per the same rule X30 and X32 both followed for a slot they could not
honestly fill.

**Whether the four tests now have enough margin — the honest arithmetic.** The CI runner that
originally timed these tests out ran the whole job ≈2.3× slower than the runner that passed on the
same SHA (§33). Applying that multiplier to this lane's local numbers:

- Before this fix, ×2.3: "Save refuses…" ≈ 1332ms, "motion authored from scratch" ≈ 2082ms, "motion
  without a kind or a duration" ≈ 2387ms — all comfortably under the 5000ms `testTimeout`.
- After this fix, ×2.3: ≈ 955ms, ≈ 1566ms, ≈ 1888ms — also comfortably under 5000ms.

Both computations clear 5000ms, yet CI's loaded runner **did** time these tests out, both before this
lane and after X30 and X32's fixes (§33, §34). That is not a contradiction to paper over: it is proof
that a single whole-job multiplier (2.3×, an average across the entire suite, most of which is
async-wait-bound and not CPU-bound) is the wrong tool for predicting a synchronous, dispatch-heavy
test's slowdown under real CPU contention from concurrent test-file workers — the thing that
actually starves these specific tests scales however many CPU-bound workers happen to be scheduled
alongside this file, not by a fixed ratio applied to this file's own local time. X30 and X32 both
recorded the same limitation before shipping real, measured fixes anyway; this lane does the same. At
the time this PR merged, whether the reduction was *enough* margin against a loaded CI runner was a
question only a CI round-trip could answer — the same honest limit X30 and X32 both hit.

**The CI round-trip, and what it found.** X34 merged (`8bbca3e9`). The next lane to touch this file
(VE3b1) rebased onto it and its CI ran on the same loaded regime that failed every previous attempt —
an 11-minute pull-request run. Result: **the four tests X30, X32, and X34 were all written to
rescue — "a motion brief authored from scratch saves with its motion policy," "motion without a kind
or a duration blocks Save," "a motion brief on a host without motion stays read-only," and "Save
refuses a click destination the API would refuse" — all passed.** Three lanes' worth of measured,
sequential fixes (X30's `useMemo` derivation, X32's `handleMainBlur` guard, X34's setup-typing
conversion) together closed a CI-only margin problem that no single one of them closed alone, and
that local timing could never confirm in advance — exactly the limitation each lane recorded honestly
rather than papering over.

**One test failed on that same run, and it was this lane's own.** `"fillValidDraft's fast path
produces the same draft, touched sections, and focus the typed path produces (X34)"` timed out at
5000ms. Not a product regression: this test deliberately drives *both* paths — the original
character-by-character typed sequence as the reference, then the fast path to compare against it — so
it pays the typed path's full cost (comparable to what the four rescued tests used to cost before this
lane) **plus** the fast path's cost, in the same 5000ms budget every other test gets one of those for.
That made it the single most expensive test in the file, and on a loaded runner it was the only one
left without margin — the equivalence test needed its own treatment, separate from the product fix it
was written to pin.

**Treatment applied: split the cost across `testTimeout` and `hookTimeout`, not inside one `test()`.**
The typed path moved into a `beforeAll` (`typeFillValidDraftByHand` run once via a new
`observeFillValidDraft` helper, both hoisted out of the test body), which is gated by Vitest's
`hookTimeout` (10000ms by default — double `testTimeout` — and this repo overrides neither). The
`test()` itself now runs only the fast path and compares its three observations (saved draft, touched
sections, focus) against the `beforeAll`-built reference — the same three assertions, the same typed
path as the source of truth (never a hand-written expectation), just paid for once per file instead of
twice per test. This was chosen over option 2 (a per-test `testTimeout` override) because it got the
test under budget without touching any timeout at all: measured locally, the test's own body dropped
to ~247ms (three-run median), in line with every other `fillValidDraft`-based test in the file, while
the `beforeAll`'s one-time typed-path cost (~600ms locally) sits comfortably inside `hookTimeout`'s
10000ms even under the ≈2.3× loaded-runner multiplier (§33). `.agents/manifests/x34.json`'s three
mutations were re-verified against the restructured test (`yarn mutate:verify`) and still reproduce
unchanged — the mutations target `fillValidDraft`/`setField`, not the test's internal shape, so moving
where the typed reference is built did not change what any of them pin.

**A `beforeAll` loose in the parent describe has its own blast radius, caught by model review (Qodo)
before it shipped.** A `beforeAll` attached to "BriefPage — capabilities and motion" fails or skips
*every* test in that describe if it throws or exceeds `hookTimeout` — a broken equivalence fixture
would have silently taken out the unrelated capability tests around it, exactly the kind of coupling
that makes a red suite hard to read correctly. Separately, `view.unmount()`, `vi.restoreAllMocks()`,
and `localStorage.clear()` all ran only on the hook's success path; a mid-hook failure had nothing
(there is no `afterEach` for a `beforeAll`) to unmount a stray editor or restore a live `fetch` spy
before the next test ran. Fixed by moving the `beforeAll` and its test into their own nested
`describe("fillValidDraft equivalence (X34)")`, and wrapping both `observeFillValidDraft`'s render and
the `beforeAll`'s reference build in `try`/`finally` so cleanup runs regardless of where inside either
one a failure lands. Proved, not merely asserted: temporarily forced `typeFillValidDraftByHand` to
throw and ran the full file — exactly one test (this lane's own) showed as skipped, all 181 others
passed, including the four tests X30/X32/X34 exist to rescue and every test that runs immediately
after the failing describe in file order (the first place a leaked spy or a stray mounted editor would
have shown up). Restored afterward; the mutation manifest and the rest of the suite were re-verified
clean. No mutation is recorded for the isolation fix itself: `.agents/manifests/x34.json`'s `note`
states plainly why — this tool checks one command's exit code per mutation, and "a sibling test would
have been skipped" is a fact about how many tests a run affects, not something a single command's exit
code (caught vs. survived) can express.

---

## 40. The 5s per-test budget was never calibrated for the editor's integration tests (X36)

**Evidence.** `vitest.config.ts` sets no `testTimeout` at all, so every project inherits Vitest's
5000ms default — a number nobody chose for a 182-test React integration suite that renders a whole
editor shell per test. The standing rule is **never raise `testTimeout` to make a lane green**,
because a timeout raised over a slowdown hides the slowdown. That rule is intact. This lane is not
that: the owner approved the calibration on 2026-09-16, after three lanes first made the tests
measurably faster.

- **§33 (X30, merged `4540ce0b`).** Validation was mirrored into state by an effect; removing it cut
  a full commit per gesture (click 3→2, keystroke 4→3). CI still timed out.
- **§34 (X32, merged `deb6e5a9`).** Disproved the dirty-flag and panel-publishing theories (React
  batching absorbs a cleanup/body pair) and fixed a real bug: re-blurring an already-touched field
  cost 5 commits instead of 3. CI still timed out.
- **§36 (X34, merged `8bbca3e9` + `218b2d3d`).** `fillValidDraft` stopped typing character by
  character; setup commits 70 → 30 (**−57%**), the whole file 30.5s → 27.4s, and the four
  historically failing tests **passed** on a loaded runner.
- **What remains.** On VE3b1's head `a2981a77`, the pull-request run **passed** and the push run
  **failed** — same commit, job durations 9m23s vs 9m37s, a single test (`motion without a kind or a
  duration blocks Save`) exceeding 5000ms in one and not the other. Nearly identical job times means
  this is per-moment variance on a shared runner, not a slower machine and not a regression.

**Consequence.** A threshold nobody calibrated became the last blocker for an unrelated lane —
VE3b1 sat ready for hours behind it.

**X36 — shipped in this PR.** An explicit `testTimeout: 15000` on the **web project only** in
`vitest.config.ts`; `node`, `api` and `tools` keep Vitest's default. `hookTimeout` is untouched; no
per-test timeout was added; no test was weakened, skipped or deleted. A comment at the setting
records the sequence above and states that a **slowdown** is still never answered by raising this
number — the next person who finds a test near the limit should look for the cost, as X30/X32/X34
did. The pin test reads the config object (web = 15000ms; root / node / api / tools unset) so a
later edit that moves the number onto the root `test` block — which every project would then inherit
via `extends: true` — fails here. Mutation manifest `.agents/manifests/x36.json`: set the web
project's timeout back to the default (5000); the pin test catches it.

The rule against raising a timeout over a slowdown stands. This is a calibration of a default that
was never chosen, applied only after the cost was found and cut, and it does not license the next
timeout raise.
