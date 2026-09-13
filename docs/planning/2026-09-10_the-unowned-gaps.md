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

**One hypothesis is already refuted.** The obvious candidate — `server.close()` waiting out a
keep-alive socket — does not apply: `close()` already calls `server.closeAllConnections()` inside
the same promise, after ending every SSE client. The mechanism is still unknown.

**No premise yet — diagnosis comes first.** `plan:verify` does not track X8, deliberately: a premise
asserts the shape of a fix, and writing one now would pin a guess. The lane's first job is to
reproduce the hang deterministically — the second shutdown path at `server.ts:276`, which calls
`server.close()` with no `closeAllConnections()`, is where to start looking, as is whether an
in-flight `void syncWatchers()` outlives the close. **Only once the mechanism is named does X8 get a
premise and a fix.**

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

```premise X10
# drawHtml paints labels with no clipping; nothing in the compositor clips.
! grep -q '\.clip()' packages/CreativeGeneration/src/infrastructure/adapters/NodeCanvasCompositor.ts
```

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

```premise X11
# isBriefTemplate does not enforce required kinds at all — the API does.
! grep -q 'required' packages/CampaignOrchestration/src/domain/value-objects/brief-template.ts
```
