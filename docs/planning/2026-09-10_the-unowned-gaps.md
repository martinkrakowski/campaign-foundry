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

**This needs an owner decision, not a lane default.** Which placements accept HTML5 display units, and each
one's byte budget, are ad-spec facts; HL-D6 already says the budget is per placement and must not be a single
constant.

```premise X14
# No platform profile declares the html format.
! grep -qE 'formats: \[[^]]*"html"' packages/Distribution/src/domain/value-objects/PlatformProfile.vo.ts
```

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

**X16 — shipped in this PR.** `canonicalBrief` / `canonicalTemplate` in `editor-state.ts` map each
template layer's `enabled: true` to absent and an empty `elements` array to absent, and change nothing
else. `fromBrief` builds both the draft and `savedSnapshot` from that form; `save` / `apply` snapshots,
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
