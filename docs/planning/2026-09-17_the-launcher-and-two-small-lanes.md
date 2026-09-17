# The launcher, the target, and the token — three lanes from one night's corrections

**Date:** 2026-09-17 · **Status:** draft, for the owner's approval · **Nothing dispatched.**
**Verified against:** `origin/main` at `ddfea9a1`, after the 2026-09-16 wave (21 merges) and X1's reformat.
**Source:** three findings that surfaced while closing that wave — one from a reviewer on the orchestration
skill itself, one from the owner's `yarn dev` output, one from the state-freshness review this session added.
**Note on the third lane:** a fourth was proposed and is **refuted** here rather than dispatched. §1's L3 says why.

---

## 0. Why these three together

They share a shape: each is a mechanism that is *correct where you look* and wrong where nobody does.
The launcher emits a good event and kills the lane. The API compiles for ES2022 and bundles for es2019.
The staleness token is right at both of its sites and has no shared definition, so the third site is where
it goes wrong. None of them is a feature; all three are the kind of thing that costs a cycle later.

---

## 1. Findings

| # | Severity | Finding |
|---|---|---|
| **L1** | **Critical** | **`.claude/skills/orchestrate-wave/scripts/dispatch-lane.sh` kills the lanes it launches, and it is still the only path that emits wave events.** The skill retires it in prose (`SKILL.md`, the Implement stage: *"never through `scripts/dispatch-lane.sh`, whose detached launch killed every lane it started on 2026-09-13"*) while the same file names it as the path that emits for you. On 2026-09-16 **both** lanes dispatched through it (ES1 on `opencode/big-pickle`, CC6 on `openrouter/qwen/qwen3.8-flash`) wrote **0 bytes with no process**, while **all eight** lanes launched directly or through the `Agent` tool delivered — gemini via `agy`, grok via `nohup`, six Sonnet lanes. A retired script that still owns a required side effect is a trap with a documented history and an active foothold. |
| **L2** | High | **The API bundles for a target older than the syntax it contains.** `tsconfig.base.json:3` sets `"target": "ES2022"`, but Nitro's esbuild default is **es2019** and nothing overrides it — there is no `esbuild` block in `apps/api/nitro.config.ts`. `packages/CampaignOrchestration/src/application/use-cases/PlanCapacity.ts` uses BigInt **literals** (`0n`, `1n`), which are ES2020 syntax, so the API **build** prints seven warnings ending *"may crash at run-time"* (measured: `yarn workspace @campaignfoundry/api build` → 7). They appear on a `yarn dev` start too — that is where the owner first saw them — but the build is the reproduction this plan uses, because a lane may not start a dev server. It does not crash, because Node evaluates BigInt regardless of a declared target — the declaration is wrong, not the runtime. Seven warnings on every dev start is how a real warning gets missed. |
| **L3** | ~~Medium~~ → **refuted** | **A `revision` type that makes "no guard" unrepresentable was proposed and is not needed.** The suspicion was `editor-state.ts:1944`, `revision: entry?.revision`, sixteen lines below a comment forbidding exactly that. Reading the branch refutes it: `:1924-1932` is the **already-saved** path, where the guard exists and is correctly protected by `if (entry.revision !== undefined)`; `:1936-1947` is the **first save**, creating `source` for a draft that has no prior revision to wipe. `undefined` there honestly means *"no revision known yet"*, and the comment's other half — *"a fabricated one would satisfy a write that should fail"* — forbids inventing one. The code is correct. A type change would be prophylactic, and this plan does not dispatch prophylaxis. |
| **L4** | Medium | **Two hand-rolled copies of the staleness token, in two different shapes.** `BriefEditor.tsx:343-346` uses a closure variable (`let generation = 0`; `round !== generation`); `HeadlinePoolDrawer.tsx:133-175` uses a ref (`loadGeneration.current += 1`; `loadGeneration.current !== generation`) and returns a boolean from the guarded branch. Both are correct. There is no shared definition, so the invariant they encode — *the newest answer wins, a stale one is never admitted* — exists only as a pattern two authors happened to reproduce. |

---

## 2. Decisions

| id | Question | Decision | Why |
|---|---|---|---|
| **W-D1** | What happens to `dispatch-lane.sh`? | **Delete it, and move event emission to the orchestrator's own adjacency rule.** | A script that is retired in prose and live on disk will be reached for again — it already was, twice, on the day the prose was written. Keeping a fixed version is the tempting alternative and it re-creates the trap: the next orchestrator cannot tell a fixed script from the one that killed two lanes. |
| **W-D2** | Does deleting it lose anything? | **Only the atomicity, which the adjacency rule already replaces.** | The emit-adjacency rule (`SKILL.md`, pre-dispatch) requires the event in the call immediately before the launch. That is the supported shape for every seat: `Agent`, `agy`, `grok`. The script's one advantage was emitting and launching in a single call — for a launch that does not survive. |
| **W-D3** | How is the esbuild target set? | **Explicitly in `nitro.config.ts`, matching `tsconfig.base.json`.** | Inheriting a bundler default that contradicts the compiler's target is how this happened. Naming it makes the two visibly agree and makes a future divergence a diff. |
| **W-D4** | One helper for the token, or leave two shapes? | **One named helper, and the two sites adopt it.** | The two shapes are both correct, which is the point — the risk is the third site. A named helper also gives the state-freshness reviewer (`pr-agent-react.yml`) something to cite instead of describing the pattern in prose. |

---

## 3. Lanes

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **W1** | **Delete `.claude/skills/orchestrate-wave/scripts/dispatch-lane.sh`** and remove every reference that presents it as a live path. **A test suite depends on it** — `emit.test.ts:362` resolves and executes the script — so W1 must delete that suite too, or keep the script's event *format* under test without the script. The lane decides which and says why; deleting a suite is a claim about what stops being true. The skill's Implement stage keeps the *history* — a retired script's failure is worth remembering — but stops naming it as the emitting path. | `.claude/skills/orchestrate-wave/scripts/dispatch-lane.sh`, `SKILL.md`, `references/cast.md`, **`tools/wave-status/lib/__tests__/emit.test.ts`** (a whole `describe("scripts/dispatch-lane.sh emits its events")` at `:362`, resolving the script by path at `:14`), **`tools/wave-status/lib/collect.ts:57`** and **`tools/wave-status/__tests__/page.test.ts:4513`** (prose references) | A trap with a documented history and an active foothold, removed |
| **W2** | **Set the esbuild target** in `apps/api/nitro.config.ts` to match `tsconfig.base.json`'s ES2022, with a comment naming the BigInt literals that made the mismatch visible. | `apps/api/nitro.config.ts` | Seven warnings per build, gone; a bundle that declares what it contains |
| **W3** | **`useLatestOnly` (name to be chosen by the lane)** — one helper encoding the token, adopted by both existing sites, with its own tests. The two call shapes differ (closure vs ref, one returns a boolean); the helper must serve both without forcing either to contort, or the lane should report that they are genuinely different mechanisms and stop. | `apps/web/src/lib/`, `BriefEditor.tsx:343-346`, `HeadlinePoolDrawer.tsx:133-175` | One definition of the invariant the app is built on |

**Order.** **W1 ‖ W2 ‖ W3** — disjoint files, no shared ownership. W1 touches orchestration only; W2 touches one config; W3 touches `apps/web`.

**Seat.** Sonnet for W3 (it changes behaviour at two live call sites). W1 and W2 are small enough for any seat — and per L1, **whichever seat runs them must be launched directly, never through the script W1 deletes.**

---

## 4. Definition of done

Shared gate: CI, which runs every step (`sync:check`, `lint:arch`, `plan:verify`, `arch:inventory`, the
mutation replay, `format:check`, build, typecheck, lint, `test:cov` at 100%). Per the repo's own rule, each
lane names the fault that must turn it **red**:

- **W1** — `grep -rn "dispatch-lane" .claude/ tools/` returns only historical prose, no executable reference:
  no test resolves the path, and `SKILL.md` no longer presents it as a path to use. **The grep must span
  `tools/`, not just `.claude/`** — the first draft of this lane scoped it to `.claude/` and would have left a
  green suite executing a deleted file. No test can prove a deleted file stays deleted; the check is the grep,
  and the lane states that limit.
- **W2** — **`yarn workspace @campaignfoundry/api build` prints zero** "Big integer literals are not
  available" warnings, where it prints them today; the lane quotes both counts. **Deliberately the build and
  not `yarn dev`** — the house rules forbid a lane starting a dev server, so a DoD that required one could
  not be satisfied without breaking another rule. (The first draft of this plan said `yarn dev`, which is
  exactly that mistake.) If Nitro ignores the setting, that is the finding: report it rather than raising the
  target somewhere else until the warning stops.
- **W3** — a test drives two overlapping rounds through the helper and asserts the **older** one's answer is
  discarded when it resolves second; reverting the comparison makes that test fail. Both adopted call sites
  keep their existing tests green unchanged — if adopting the helper requires editing an existing assertion,
  the helper is wrong for that site and the lane says so rather than editing the assertion.

---

## 5. Premises

**W1 — shipped in this PR.** Its premise (`test -f
.claude/skills/orchestrate-wave/scripts/dispatch-lane.sh`) was retired when it landed; `plan:verify`
no longer tracks it. The fence is gone rather than inverted: **no test can prove a deleted file stays
deleted**, and a fence asserting absence would pass forever without checking anything. The standing
check is the grep in §4, which fails on an executable reference rather than on the file's existence.
The first draft of that fence pointed at `scripts/dispatch-lane.sh` and failed on its own first run —
the cheapest possible instance of the rule it was written under: run the fence before trusting it.

```premise W2
# No esbuild target is set for the API, so Nitro's es2019 default stands against
# tsconfig's ES2022. Measured: ~4 ms. Greps the config rather than running the
# bundler, because a fence that invokes a build cannot answer inside the budget --
# the lesson X1's second fence cost.
! grep -q "esbuild" apps/api/nitro.config.ts
```

```premise W3
# The staleness token has no shared definition. The mechanism, not the identifier: both
# sites compare a captured round against a live counter, so the probe counts SITES THAT
# DECLARE THEIR OWN comparison. An earlier draft counted files containing the substring
# `generation`, which a rename in one component would have flipped without the work being
# done -- a fence satisfiable by renaming is not a fence. Measured: ~52 ms.
test "$(grep -rlE '(let generation = 0|loadGeneration = useRef)' apps/web/src --include='*.tsx' | grep -vc __tests__)" -eq 2
```

---

## 6. What this plan does not do

- **It does not fix the launcher.** W-D1 deletes it. A repaired script is indistinguishable from the one
  that killed two lanes on the day its retirement was written down, and the next orchestrator has no way to tell.
- **It does not re-test the cheap seats.** `openrouter/qwen/qwen3.8-flash` and `opencode/big-pickle` were called
  broken on 2026-09-16 on evidence that turned out to indict the launcher instead. They are **untested through a
  working launcher**, and this plan corrects the claim without making a new one. Re-measuring them is a separate
  decision with a cost.
- **It does not add a `revision` type** (L3, refuted).
- **It does not touch the four PR-Agent reviewers.** Their yield was measured on one wave — Qodo and CodeRabbit
  found every real defect, PR-Agent about one in ten — and that remains the owner's V3 decision, not a lane here.
