# Architecture & Development Plan — two more PR-Agent reviewers: API and architecture

**Status:** Proposed v1.0
**Scope:** `.github/workflows/` and `.pr_agent.toml` — two additional PR-Agent workflows beside the
existing UI-contract reviewer. No application code changes.
**Depends on:** #96 (the UI-contract PR-Agent, merged as `caa329f`)

---

## 0. Verdict on the proposal

**Both are worth adding, but for opposite reasons, and the architecture one is the riskier of the
two by a wide margin.**

The API reviewer is straightforward: nothing in this repository reviews Nitro route semantics
today. CodeRabbit is generic, the PR-Agent from #96 is pointed at `DESIGN.md`, and neither knows
what an H3 handler is supposed to do about a repeated query parameter or a conditional write. That
is a genuine gap and the defects to prove it are already in the git history.

The architecture reviewer is the dangerous one, and the user is right to flag it. `hexagen arch
validate` already enforces the layer graph **deterministically**, from
`.architecture/invariants/layer-rules.yaml`. An LLM asked to "review the architecture" will
re-derive those same rules, report them as findings, and be wrong slower and less reliably than a
linter that is already green. That is worse than adding nothing: it trains people to skim the bot.

**So the architecture reviewer is only worth building if it is scoped to what the linter provably
cannot see.** §2.2 draws that line precisely; §3.2 is the mandate that follows from it. If we
cannot hold that line, we should ship the API reviewer alone — a second opinion nobody reads is a
cost, not a safety net.

---

## 0.1 Proposed Decisions

| # | Decision | Consequence |
|---|---|---|
| **D1** | **Three reviewers, one workflow file each**, not one workflow with three personas. Each has its own concurrency group, its own `extra_instructions`, and its own failure guard. | A rate-limited or failing API review cannot cancel or mask the UI one. The concurrency-key bug the #96 header documents at length was exactly this class; three keys keep it solved. |
| **D2** | **The architecture reviewer never reports what `hexagen arch validate` reports.** Its mandate is the complement of the linter: semantics the import graph cannot express. It is told the linter's rules explicitly so it can recognise and *refuse* them. | Prevents the failure that makes a second reviewer worthless. See §2.2 for the boundary and §3.2 for the wording. |
| **D3** | **Both new reviewers run `/improve`, not `/review`.** Same finding as #96: `/review` emits an effort estimate and a focus-areas section that is empty when it has nothing to say; only `/improve` produces line-anchored suggestions. | Consistent with the UI reviewer. `auto_review = false`, `auto_improve = true`. |
| **D4** | **Path-scoped triggering.** The API reviewer runs only when `apps/api/**` changes; the architecture reviewer only when `packages/*/src/**`, `.architecture/**` or `.agents/architecture.md` changes. | A CSS-only PR should not pay for three LLM reviews. Uses `on.pull_request.paths`. |
| **D5** | **Every finding must name a failure scenario**, as #96 requires. A finding without concrete inputs and a wrong output is not reported. | The three reviewers already produce ~20 threads on a large PR; the sweep cost is real and rises with noise. |
| **D6** | **Each reviewer's instructions are grounded in defects this repository actually shipped**, cited by PR number, not in generic best practice. | #96's instructions were written this way and its first automatic run found a real `NaN`-silently-swallows-a-fade bug on #97. Generic prompts produce generic findings. |
| **D7** | **`.pr_agent.toml` stays single.** PR-Agent reads one config from the default branch; per-workflow differences live in each workflow's `env:` block. | Splitting the toml is not supported. The existing file's `[pr_reviewer]`/`[pr_code_suggestions]` sections stay as the UI reviewer's defaults; the new workflows override in `env`. |
| **D8** | **No new merge gates.** All three reviewers are advisory. The only job that may fail is the existing "did the review actually run" guard. | A green check must never claim a review that did not happen (#96); an LLM opinion must never block a merge. |

---

## 1. Context & Current State (verified 2026-08-29)

**What reviews a PR here today**

| Reviewer | Scope | Deterministic? |
|---|---|---|
| CI (`ci.yml`) | build, typecheck, lint, `lint:arch`, `sync:check`, `test:cov` at 100 % | yes |
| `hexagen arch validate` | the layer import graph, from `.architecture/invariants/layer-rules.yaml` | **yes** |
| CodeRabbit | generic correctness, repo-wide | no |
| Qodo | best practices | no |
| PR-Agent "UI Review" (#96) | `DESIGN.md` and the D-decisions | no |

**What `hexagen arch validate` enforces, exactly.** From `.architecture/invariants/layer-rules.yaml`:

- `domain` — `internal-only`; may import `@campaignfoundry/shared`
- `application` — `ports-only`; may import `domain`, `shared`
- `infrastructure` — `adapters`; may import `domain`, `application`, `shared`
- a `global_whitelist` (`@campaignfoundry/shared/**`, and the `CampaignOrchestration` root
  entrypoint so adapter packages can implement its ports)
- `test_double_rules.allowed_cross_package_imports: true`

It is a **static import-graph check**. It reads edges between files and packages.

**The API surface nothing reviews.** `apps/api/server` is a Nitro app: `routes/campaigns/**`
handlers, `lib/` helpers, `plugins/ffmpeg-check.ts`. Its conventions — `defineEventHandler`,
`getQuery` returning `string | string[]`, `H3Error` shapes, status codes, the conditional-write
`revision` guard — are enforced by nothing but review.

---

## 2. Analysis

### 2.1 Findings

| # | Sev | Finding |
|---|---|---|
| **C1** | Critical | **An architecture LLM that duplicates the linter is a net negative.** It will report layer violations the linter already proves absent, with lower precision, and the sweep cost falls on a human. Any version of this reviewer that cannot state what it is *not* allowed to report should not ship. → D2, §2.2 |
| **H1** | High | **The linter cannot tell a port from a leak.** `BriefStorePort.readBrief` accepted an absolute filesystem path and read it (#93). Every import in that file was legal; the layer graph was green. The abstraction was the thing that was wrong, and only a reader catches that. |
| **H2** | High | **The linter cannot see through a legal import to an illegal runtime.** `editor-state.ts` imported the `CampaignOrchestration` barrel — explicitly whitelisted — which re-exports infrastructure adapters and dragged `node:fs`/`node:path`/`node:crypto` into the browser bundle. `lint:arch` passed; `yarn build` failed (#91). A reviewer that knows which leaves are browser-safe catches it in review instead. |
| **H3** | High | **Nothing reviews Nitro route semantics.** Two real defects shipped past CI: assets were copied *before* the lock and revision check, so a rejected write still mutated storage; and the duplicate route raced its own id check (#93). Both are ordering bugs inside a single handler — invisible to an import-graph linter and to a UI-contract reviewer. |
| **M1** | Med | **Additive response fields get dropped by their own client.** `GET /campaigns/capabilities` returns an ffmpeg `version`; the web client rebuilt the response as `{ motion, reason }` and dropped it, so the component rendering it was unreachable at 100 % coverage (#95). A route-and-client reviewer sees both halves. |
| **M2** | Med | **Query-parameter handling is repeatedly subtle.** `getQuery(event).replace` may be `string \| string[]`; `briefs.post.ts` handles the array case deliberately. Nothing checks that new handlers do. |
| **M3** | Med | **Ports are not proven swappable.** The S3 adapter does not exist yet, so nothing tests that `BriefStorePort`/`AssetStorePort` *could* be implemented by one. A reviewer can ask the question a test cannot yet. |
| **L1** | Low | **Three reviewers on one PR is a sweep cost.** #95 drew 26 threads. Path-scoping (D4) and a hard "failure scenario or silence" rule (D5) keep it proportionate. |

### 2.2 The line the architecture reviewer must not cross

This is the heart of the plan. The reviewer is given both columns and told the left one is the
linter's job.

| `hexagen arch validate` owns — **never report** | The reviewer owns — **the actual mandate** |
|---|---|
| Which layers may import which | Whether a *port* is an abstraction or a disguised implementation detail (a filesystem path, an errno, a `Buffer` where a stream belongs) |
| Package-boundary violations | Whether an adapter's failure modes leak through the port (fs `ENOENT` reaching a use case as-is) |
| Whitelist conformance | Whether a legal import pulls an **illegal runtime** into a bundle — `node:*` reaching `apps/web` through a whitelisted barrel (H2) |
| Circular dependencies between modules | Whether a "port" has exactly one adapter and no prospect of a second — an interface that is really just indirection |
| File placement under `domain/`, `application/`, `infrastructure/` | Whether the code in a correctly-placed file *belongs* to that layer: business rules in an adapter, I/O in a use case, a clock read in the domain |
| | Whether a new port is wired to anything — a port and adapter nobody constructs is dead weight at 100 % coverage (#93's drawer, in a different guise) |
| | Whether `.agents/architecture.md` still describes the code after the change |

**The test for a valid finding:** could `hexagen arch validate` have caught this? If yes, it is out
of scope and must not be reported — the linter is green, so by construction the answer is that it
did not occur.

---

## 3. Target Design

### 3.1 API reviewer — `.github/workflows/pr-agent-api.yml`

Same skeleton as #96 (digest pin, allowlist guard, concurrency key split by sender type and by
what the run produces, and the "did it actually run" step). Differences:

- `on.pull_request.paths: ["apps/api/**"]` plus the `issue_comment` command path (D4).
- `concurrency.group` prefix `pr-agent-api-` so it cannot cancel the UI reviewer's run.
- `config.repo_context_files: [".agents/architecture.md", "AGENTS.md", ".agents/testing.md"]`.
- Its own `pr_code_suggestions.extra_instructions` (§3.3).

### 3.2 Architecture reviewer — `.github/workflows/pr-agent-arch.yml`

Same skeleton. Differences:

- `on.pull_request.paths: ["packages/*/src/**", ".architecture/**", ".agents/architecture.md"]`.
- `concurrency.group` prefix `pr-agent-arch-`.
- `config.repo_context_files: [".agents/architecture.md", ".architecture/invariants/layer-rules.yaml", ".architecture/invariants/linter-config.yaml"]` — **the linter's own rules are context**, so the reviewer can recognise and refuse them (D2).
- Instructions open with the prohibition, not the mandate (§3.3).

### 3.3 The instructions, in outline

Both follow #96's shape: an adversarial stance, a hard requirement that every finding carries a
concrete failure scenario, and a list of defect classes **drawn from this repository's own
history** (D6).

**API reviewer hunts:**

1. **Mutation before validation.** Anything written, copied or deleted before the lock, the
   revision check, or the id check. (#93: assets copied before the conditional write, so a
   rejected 409 still moved files.)
2. **Path handling.** Any path from a request reaching the filesystem without confinement.
   (#93: `readBrief("/etc/hosts")` escaped the store; the file's own `resolveConfined` helper was
   used on one path and not the others.)
3. **Query and body shapes.** `getQuery` values that may be arrays; unvalidated JSON bodies;
   a repeated parameter whose second value silently wins.
4. **Status and error semantics.** A 500 where a 4xx belongs; an `H3Error` whose message leaks an
   absolute path; a catch that turns "I could not tell" into "nothing was wrong".
5. **Additive contract drift.** A field added to a response that its own client does not carry
   (M1), or a field removed without a version bump.
6. **Locking scope.** Whether the lock is process-local when the operation needs to be
   cross-process, stated honestly rather than assumed (a known limitation of `FsBriefStore`).

**Architecture reviewer hunts** — after being told plainly what it may not report (§2.2):

1. **Leaky ports.** A port signature that names a filesystem, a Buffer, an errno, or anything else
   only one adapter could satisfy (H1).
2. **Illegal runtime through a legal import** (H2) — `node:*` reaching a browser bundle via a
   whitelisted barrel. It is told which leaves are browser-safe.
3. **Layer-correct but semantically misplaced code** — business rules inside an adapter, I/O
   inside a use case.
4. **Ports with no adapter, or adapters nobody wires.**
5. **Drift between the change and `.agents/architecture.md`.**

---

## 4. Phases

### P1 — API reviewer

| # | Task | Owns |
|---|------|------|
| P1.1 | `pr-agent-api.yml` from #96's skeleton: digest pin, allowlist guard, split concurrency key, run-actually-happened guard | `.github/workflows/pr-agent-api.yml` |
| P1.2 | `paths` filter for `apps/api/**` + the `issue_comment` command path (D4) | same |
| P1.3 | `extra_instructions` for the six API classes in §3.3, each citing the PR it came from | same |
| P1.4 | Verify: the workflow parses, and a PR touching only `apps/web/**` does **not** trigger it | — |

### P2 — Architecture reviewer

| # | Task | Owns |
|---|------|------|
| P2.1 | `pr-agent-arch.yml` from the same skeleton, with the `packages/*/src/**` paths filter | `.github/workflows/pr-agent-arch.yml` |
| P2.2 | `repo_context_files` includes both invariant YAMLs so the linter's rules are in context (D2) | same |
| P2.3 | `extra_instructions` **opening with the prohibition table** from §2.2, then the five classes in §3.3 | same |
| P2.4 | Verify the boundary holds: run it against a PR with a known layer-rule violation and confirm it defers to the linter rather than reporting it | — |

#### P2.4 result (2026-08-29) — the reviewer did NOT defer

**Verdict: P2.4 fails as written.** The architecture reviewer reported a violation that
`hexagen arch validate` already catches.

**Method.** `packages/CreativeGeneration/src/domain/index.ts` was given one deliberate
relative cross-layer import, `../infrastructure/safe-path.js`, on a throwaway branch, and a
**non-draft** PR was opened (#118) so the reviewer would actually run. `lint:arch` rejected
it first, as the experiment requires:

```text
Domain Violation in [CreativeGeneration]:
  Relative import '../infrastructure/safe-path.js' crosses out of the 'domain' layer
  into 'infrastructure'.
```

**What the reviewer said**, quoted from its own run log rather than paraphrased:

> The domain layer must not import directly from the infrastructure layer. Replace the
> direct import with a port abstraction defined in the application layer, and have the
> infrastructure adapter implement that port. This removes the layer violation and keeps
> the domain pure.

Attributed to the architecture reviewer specifically (run 33266345460), not to the UI
reviewer, which posted separately on the same PR.

Its instructions say: *"THE TEST FOR EVERY FINDING: could `hexagen arch validate`, as
pinned, have caught this? If yes, say nothing."* It could, and it did.

**The nuance that stops this being a straight deletion.** The prohibition is written
conditionally — *"the linter is green on this pull request, so … none of them occurred"* —
and on this PR the linter was **red**. The reviewer saw a real violation and described it
correctly. So the experiment cannot distinguish

- *the reviewer ignores its prohibition*, from
- *the prohibition's stated premise was false here, and it reported a genuine defect*.

It also cannot occur on a mergeable PR: `lint:arch` is a merge gate, so any PR where this
duplication is possible is already blocked. The cost to a reader is zero on a PR that cannot
land.

**What §6 prescribes** on a P2.4 failure is to ship the API reviewer alone and drop this one.
That reads too strong against the evidence. The narrower conclusion is that the *instruction*
is at fault rather than the reviewer: the prohibition should be unconditional, and should say
what to do when the linter is red — stay silent, because the gate has already spoken.

**Decision: option 1** — fix the instruction, keep the reviewer, re-run the test.

The three options were:

1. **Taken.** Make the prohibition unconditional, add a "when `lint:arch` is failing, say
   nothing about layer rules" clause, and re-run P2.4.
2. Accept the behaviour as harmless — such a PR cannot merge — and record P2.4 as passed
   *with the caveat that it holds only on green PRs*.
3. Follow §6 literally and delete the architecture reviewer.

Two things were wrong with the instruction, and the second was invisible until the first was
found:

- It was **conditional**: *"the linter is green on this pull request, so … none of them
  occurred."* On a PR where the linter is red that premise is false, and a reviewer
  reasoning from it correctly concludes it may speak. The rule now holds unconditionally,
  and says explicitly that a red gate is the strongest reason to stay silent — the gate has
  already caught it, said so precisely, and blocked the merge.
- It still said the linter proves the layer graph **"for imports written as a package
  specifier"**. That qualifier was true of the pinned 0.8.0 and became stale the moment
  #115 upgraded to 0.12.1, which catches relative imports too. R1.5 removed the reviewer's
  "class 0" but left this sentence behind, so the reviewer was being told the linter is
  blind to exactly the case the experiment used.

#### P2.4 re-run (2026-08-29) — option 1 did not work

The instruction was fixed as decided above and the experiment re-run against it (#121, since
closed, branch deleted). **The reviewer reported the layer violation again**, in nearly the
same words:

> The domain layer must not import directly from the infrastructure layer. Replace the direct
> import with a port defined in the application layer and have an infrastructure adapter
> implement it.

It did so with the prohibition unconditional, with an explicit paragraph saying a failing
gate is the strongest reason to stay silent, and with the stale "package specifier" qualifier
removed so it could no longer believe the linter was blind to relative imports. It also
posted a second, unrelated suggestion about wrapping the import — so it was not merely
pattern-matching one rule.

**Option 1 is exhausted.** Two runs, materially different instructions, same behaviour: this
model does not honour a negative constraint of this shape. That is a fact about the reviewer,
not about the wording, and no further rewording is worth the attempt.

The instruction fix is kept regardless — both faults it corrected were real, and the stale
qualifier was actively misleading.

**What remains:**

- **Accept it (was option 2).** The behaviour only occurs when `lint:arch` is red, and such
  a PR cannot merge — it is a duplicated message on a blocked PR, which costs a reader one
  extra paragraph and never reaches `main`. On every green PR this session the reviewer
  stayed inside its lane.
- **Delete it (was option 3, and §6's literal remedy).** C1's argument stands: a reviewer
  that repeats a solved problem teaches people to skim it, and skimming is how a real finding
  gets missed later.

A third possibility neither option named: **change the model for this reviewer only.** All
three run `openrouter/inception/mercury-2`; the arch reviewer is the one asked to obey a
prohibition rather than to find things, which is a different skill. Its `config.model` can be
set per workflow without touching the other two.

#### P2.4 run 3 (2026-08-29) — PASSES, with the instruction rewritten as a procedure

**The reviewer stayed silent.** Its AI response was `code_suggestions: []`.

**What changed.** Runs 1 and 2 were prohibitions and broke identically: the reviewer framed a
candidate finding, then judged whether the rule covered *that framing* — and always found one
it did not obviously cover, usually "the real problem is the missing port abstraction". The
instruction is now a **procedure over an object the model does not choose**: before any
finding exists, sweep the import specifiers the diff adds, resolve each against
`layer-rules.yaml`, mark OWNED or CLEAR. One OWNED import **closes the file**, and the only
publishable finding about a closed file is one that would still be true if the offending
import lines were deleted outright.

That deletion test is what closes the reframing route: the missing port, the re-export and
the dragged runtime all disappear when the line is deleted, which is the proof none of them
belonged to the reviewer. Three further leaks were closed explicitly — the sweep is working
state and must never be printed; a shape rule forbids any suggestion whose fix adds, moves or
reroutes an import in a closed file, whatever class it is filed under; and prose in
`.agents/architecture.md` that merely restates the layer graph is named as the linter's
finding in words.

The wording was drafted and attacked rather than written by hand: four independent strategies,
each stress-tested twice by a model role-playing the reviewer hunting for a loophole. Every
earlier shape, including both hand-written ones, fell to the same reframing route.

**Tested on unseen ground.** Runs 1 and 2 used
`packages/CreativeGeneration/src/domain/index.ts` importing `../infrastructure/safe-path.js`.
Run 3 used `packages/Distribution/src/domain/value-objects/PlatformProfile.vo.ts` importing
`../../infrastructure/adapters/FileSystemExporter.js`, so a pass could not be memorisation of
the example in the prompt.

**Honest limits.**

- One run. Silence is also what a reviewer that simply found nothing produces, and on the
  OWNED branch a correct execution and a skipped one are indistinguishable — PR-Agent has no
  channel for the sweep. The next green PR carrying a genuine class-1 or class-3 defect is
  the test that the procedure did not simply buy silence everywhere.
- **The UI reviewer spoke on the same PR**, about the Node adapter reaching a domain module.
  That reviewer has no `paths` filter, so it reviews every file in the repository including
  packages it has no mandate over. Not a P2.4 failure — different reviewer, different
  instructions — but a live question of its own: should the UI reviewer be commenting on a
  domain value object at all?

**Run 4 (2026-08-29) — confirms it.** After the sweep gained its test-file exemption, the
check was re-run on a third distinct site: `packages/GovernanceAndCompliance/src/domain/index.ts`
importing Distribution's `FileSystemExporter`. The architecture reviewer's only AI response
was again `code_suggestions: []`.

Attribution matters here and was checked rather than assumed: the phrase "port abstraction
defined in the application layer" appears in *both* reviewers' run logs, because the
architecture reviewer receives the diff and the concurrently-posted comment as context. Only
the UI reviewer produced suggestions; the architecture reviewer's sole AI response was the
empty list.

**Status: P2.4 satisfied.** Two distinct violation sites, both silent, after an instruction
that was drafted adversarially rather than by hand. The reviewer ships, and §6's remedy is
not invoked.

#### Does it still FIND things? (2026-08-29) — yes, both classes

P2.4 proved the reviewer stopped duplicating the linter. It could not prove it still worked,
because silence is also what a broken reviewer produces. So a PR was opened carrying two
genuine defects, one from each flagship class, both modelled on real incidents here.

**The precondition that made it a fair test:** `yarn lint:arch` was **green** with both
defects present, so the sweep marked both files CLEAR and left them open. Nothing in the
instructions gave the reviewer cover for silence.

| defect | shape | reviewer's verdict |
|---|---|---|
| `BriefStorePort.readBriefFromPath(absolutePath, mode): Promise<Buffer>` | class 1, leaky port (#93) | **found** |
| `apps/web` importing `MOTION_KINDS` from the package root instead of the leaf | class 3, illegal runtime (#91) | **found** |

Quoted from run `33274326381`:

> The new `readBriefFromPath` method leaks a concrete filesystem path into the
> `BriefStorePort` abstraction, breaking the hexagonal rule that ports must not expose I/O
> details.

> Importing `MOTION_KINDS` from the `CampaignOrchestration` barrel pulls in infrastructure
> adapters (e.g., node:fs) that are illegal in browser bundles. Switch to a browser-safe
> export that does not re-export node built-ins.

The second names the mechanism — the barrel re-exporting infrastructure — rather than
generic advice. The API reviewer flagged the same import for the wrong reason ("unnecessary
bundle size and potential circular dependencies"), which is the difference between a reviewer
that knows this codebase and one pattern-matching.

**So the sweep bought deference, not silence.** Together with runs 3 and 4 this closes the
question C1 raised: the reviewer is worth having.

**A methodology note.** The first extraction of that run reported only one finding. That was
an error in the extractor, not the reviewer: PR-Agent logs suggestions both JSON-escaped and
as raw YAML block scalars, and the regex matched only the first. Verify the extractor before
trusting a negative result about a model's output.

**One open question this raised.** The UI reviewer spoke on both experiment PRs, about layer
violations in `packages/**` — a domain value object and a governance barrel. It has no
`paths` filter, so it reviews every file in the repository including packages far outside its
DESIGN.md mandate, and it is now the reviewer duplicating the linter. Worth deciding
separately: give it a `paths` filter, or extend the sweep to its instructions too.

**A first attempt reached the opposite conclusion and was wrong.** It opened the experiment
PR with `--draft`, and `pr-agent-arch.yml` guards its job with
`github.event.pull_request.draft == false`, so the run completed in 1 s with conclusion
`skipped`. "No output" was recorded as silence. A check that did not run is not a check that
passed — the same failure the did-it-actually-run guard in #96 exists to catch, reproduced
inside the experiment built to test the reviewer.

### P3 — Config and docs

| # | Task | Owns |
|---|------|------|
| P3.1 | `.pr_agent.toml` comment noting three workflows share it and where per-reviewer overrides live (D7) | `.pr_agent.toml` |
| P3.2 | `.agents/architecture.md`: a line recording that architecture has both a deterministic linter and an advisory reviewer, and which owns what | `.agents/architecture.md` |

---

## 5. Definition of Done

- Both workflows parse (`yaml.safe_load`) and declare one job, the two triggers, and three steps.
- Every file named in `repo_context_files` exists on the default branch. A missing entry is
  *skipped, not fatal*, so a stale list silently ships a weaker reviewer — this is checked, not
  assumed.
- The paths filters are proven by observation: a PR touching only `apps/web/**` triggers the UI
  reviewer and neither new one.
- The architecture reviewer, run against a PR containing a deliberate layer-rule violation,
  **does not report it** — it defers to `hexagen arch validate`. If it reports it, D2 has failed
  and the reviewer does not ship (C1).
- No new required check. `ci.yml` remains the only merge gate (D8).
- Each reviewer's instructions cite at least three defects by PR number (D6).

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| The architecture reviewer re-derives the linter's rules anyway, despite the prohibition. | P2.4 tests exactly this before it ships. If it fails, ship P1 alone — an unreliable second opinion on a solved problem is worse than none (C1). |
| Three reviewers make sweeps expensive; people start skimming. | D4 path-scoping, D5 failure-scenario-or-silence, and `publish_output_no_suggestions = false` so a clean PR gets silence rather than an empty table. |
| The three workflows drift apart as #96's skeleton is fixed in one and not the others. | The concurrency and guard blocks are identical by construction; a change to one is a change to all three, stated in each header. #96's own header already carries the reasoning. |
| `mercury-2` or its fallback becomes unavailable and all three reviewers fail at once. | They fail independently (D1) and none is a merge gate (D8). The run-actually-happened guard turns a silent failure into a red check on the affected reviewer only. |
| Path filters mean a cross-cutting PR gets reviewed by only one agent. | `paths` is a union across the three workflows; a PR touching `apps/api` *and* `packages/*/src` triggers both. Verified in P1.4/P2.4. |
