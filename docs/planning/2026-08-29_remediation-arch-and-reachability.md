# Architecture & Development Plan — remediation: the unenforced layer graph, and data nothing reads

**Status:** Proposed v1.0
**Scope:** `packages/CampaignOrchestration`, `package.json`, `.architecture/`, `apps/api/server/lib/report.ts`, `apps/web` (grid + run-context)
**Follows:** #102 (the three PR-Agent reviewers), #108 (`descriptor.beats`), #110 (L6-E5 PR3)

---

## 0. Why this exists

Two unrelated problems, both found by looking rather than by failing.

**The layer graph is not enforced.** `hexagen arch validate` is a merge gate and reports
"Architecture is compliant" on a domain file that imports from infrastructure — because the
pinned linter skips the check for *relative* specifiers, and almost every intra-package
import is relative. The rule has been green because it has not been running, not because it
has been satisfied.

**Two fields are produced and stored but nothing reads them.** `descriptor.beats` (#108) and
`descriptor.headline` are set by the pipeline, declared on the web's `Asset` type (#108), and
rendered nowhere. That is the first defect class the API reviewer's own instructions name —
"coverage standing in for reachability" — and half of it was introduced by this session.

Neither is a crisis. Both are the kind of thing that stops being fixable cheaply once
something is built on top of it.

---

## 0.1 Proposed Decisions

| # | Decision | Consequence |
|---|---|---|
| **D1** | **Upgrade `@hexagen-monaco/arch-linter` to 0.12.1.** The gap is upstream and already fixed there; carrying a local workaround for a solved bug is worse than taking the fix. | Turns `lint:arch` from a check that passes into a check that verifies. Surfaces one real pre-existing violation, which D2 handles. |
| **D2** | **`node:crypto` leaves the domain — the value it produces does not change.** `policyHash` is pinned by a golden (`7181107a…`) and by persisted reports. Any approach that alters the digest is out of scope, not a judgement call. | The remediation is a *relocation*, not a redesign. A failing golden means the approach is wrong, not that the golden is stale. |
| **D3** | **The approach is chosen by evidence, not preference (R1.1).** Which layers 0.12.1's builtin check covers decides whether the hash may live in `application` or must reach `infrastructure`. Establish that first; §2.3 lists the options against each outcome. | Prevents a refactor built on a guess about a linter we have just learned to distrust. |
| **D4** | **Upgrade the linter alone; leave `@hexagen-monaco/sync` at 0.8.0.** `hexagen sync` rewrites scaffold and rolls back destructively on a dirty tree. | Two independent risks stay independent. The version skew is recorded (L1), not resolved by momentum. |
| **D5** | **A field the pipeline produces is either rendered or removed.** `descriptor.beats` and `descriptor.headline` get a place on screen, or they come out of the type. | No third option where data is carried, typed, tested and invisible — the state both fields are in today. |
| **D6** | ~~Descriptor provenance survives a reload.~~ **WITHDRAWN — it already does.** What remains is narrower and worth doing anyway: `PersistedAsset`'s *type* is silent about a field that is genuinely persisted, and nothing pins the round trip. | Declare the field as `unknown` and add a regression test. **Do not make `isPersistedAsset` stricter** — rejecting a row for a malformed descriptor would drop the whole asset to fix a defect that does not exist. And do not type it `VariantDescriptor` while leaving it unchecked: a type predicate asserts whatever its type claims, so an unvalidated shape would be a lie the compiler propagates. |
| **D7** | **Two lanes, no shared files** — with one named exception. R1 is `packages/` + config; R2 is `apps/`. **If §2.3's approach B is selected, R1 also owns the two composition sites** `apps/api/server/lib/pools.ts` and `apps/api/server/routes/campaigns/plan.post.ts`, which construct `PlanVariationsUseCase`. | Those two files are disjoint from R2's list (`report.ts`, `grid/page.tsx`, `messages.ts`), so the guarantee holds either way — but it has to be stated, or R1 discovers mid-lane that its chosen approach needs a file it was told not to touch. |
| **D8** | **`pr-agent-arch.yml`'s "class 0" is deleted by the same PR that lands the upgrade.** It exists only because the linter was blind. | The instruction file says so itself. Leaving it would tell the reviewer to report what the linter now catches — the exact duplication #102 was built to avoid. |

---

## 1. Context & Current State (verified 2026-08-29)

**The linter gap, verified in both directions.** Same file, same layer, two specifiers:

| change to a file under `src/domain/` | `yarn lint:arch` |
|---|---|
| `import { resolveAssetPath } from "../infrastructure/safe-path.js"` | ✅ "Architecture is compliant" |
| `import { platformProfile } from "@campaignfoundry/Distribution"` | ❌ correctly rejected |

In the shipped 0.8.0 build the domain branch reads:

```js
if (!spec.startsWith("@") && (spec.startsWith(".") || spec.startsWith("/"))) ; else { …check… }
```

— an empty statement. 0.12.1 adds `checkCrossLayerRelativeImport` and reports the first case
precisely:

```
Relative import '../infrastructure/safe-path.js' crosses out of the 'domain' layer into 'infrastructure'.
```

**What the upgrade surfaces.** Exactly one violation on today's `main`:

```
Domain file: packages/CampaignOrchestration/src/domain/value-objects/VariationPolicy.vo.ts
Node builtin 'node:crypto' imported in the 'domain' layer.
```

Plus one warning: `Could not load layout.yaml from .architecture/layout.yaml, using defaults`.

**Why that import is not cosmetic.** `variation-defaults.ts` exists *because of it*. Its own
header says so: *"`VariationPolicy.vo.ts` is the natural home, but it hashes its policy with
`node:crypto` and so can never be bundled for a browser."* The editor reads a split-out leaf
rather than the value object. Removing the import removes the reason for the split.

**What the hash is.** `hashPolicy` is module-private, called once, and returns
`createHash("sha256").update(canonicalJson(payload)).digest("hex")`. `VariationPolicy.fromBrief`
is the only production construction site (`PlanVariationsUseCase.plan`). The digest is pinned
by `"policyHash is the sha256 of canonical policy JSON (golden)"` and is written into every
persisted report.

**The fields nothing reads.**

| field | written by | typed on the client | rendered |
|---|---|---|---|
| `descriptor.beats` | `GenerateCampaignUseCase` (#108) | `run-context.tsx` (#108) | **nowhere** |
| `descriptor.headline` | the pooled-headline path | `run-context.tsx` (#108) | **nowhere** |

`grid/page.tsx` renders chips for `layout`, `tone`, `paletteShift` and `motion · durationSec`,
and stops there.

**The reload gap.** `PersistedAsset` is a flat row — `productId`, `aspectRatio`, `treatment`,
`outputPath`, `variantIndex`, `attempt`, `format`, `videoPath`, `durationSec`. **No
descriptor.** So a campaign reloaded from its persisted report has `asset.descriptor ===
undefined`, and every descriptor chip the grid draws disappears. Nothing warns; the row simply
gets quieter.

---

## 2. Analysis

### 2.1 Findings

| # | Sev | Finding |
|---|---|---|
| **C1** | Critical | **A merge gate that does not check.** `lint:arch` gates every PR and has been passing without testing relative imports. Every "the linter proves it" claim made in this repository — including in `.agents/architecture.md` and in #102's reviewer instructions — has been true only for package specifiers. → D1 |
| **H1** | High | **`node:crypto` in the domain layer.** Blocks D1, and has already cost a workaround: the browser-safe leaf exists solely to route around it. → D2, D3 |
| **H2** | High | **`descriptor.beats` and `descriptor.headline` are unreachable data.** Produced, persisted, typed, covered — and invisible. This is the class the API reviewer is instructed to hunt, and #108 created half of it while fixing a related gap. → D5 |
| **M1** | ~~Med~~ **WITHDRAWN** | ~~A reloaded campaign loses its descriptor chips.~~ **This finding was wrong.** It was inferred from `PersistedAsset`'s field list without reading the serialisation path. `ReportAsset` is `GeneratedAsset & { brandCompliant }` and `writeReport` spreads the whole asset, so the descriptor **is** persisted; `isPersistedAsset` is a boolean guard that ignores unknown fields, and the merge path stores whole rows. Descriptors already survive a reload. See §2.5. |
| **M2** | Med | **`.architecture/layout.yaml` is absent.** 0.12.1 warns and falls back to defaults, so the layer directories it checks are assumed rather than declared. Worth closing while the linter is in hand. |
| **L1** | Low | **Toolchain skew.** `@hexagen-monaco/sync` stays at ^0.8.0 while the linter moves to ^0.12.1. Deliberate (D4), and recorded so it is not rediscovered as a surprise. |

### 2.2 The constraint that shapes H1

`policyHash` is not an internal detail. It is:

- asserted against a literal digest in a golden test,
- written into every persisted campaign report,
- logged as run provenance (`policy ${plan.policyHash} seed …`),
- and carried on `VariationPlan` for `replan`.

So **the digest must not move.** That rules out "use a different hash", and it makes the
golden the acceptance test for the whole of R1: if `7181107a…` still comes out, the
relocation is faithful.

### 2.3 Three ways to get `node:crypto` out, and how to choose

The choice depends on a fact we do not yet have — **which layers 0.12.1's node-builtin check
covers.** R1.1 establishes it before anything is moved.

| | approach | if the check covers `domain` only | if it covers `application` too |
|---|---|---|---|
| **A** | `PlanVariationsUseCase` computes the digest and hands it to the VO | viable, smallest diff | ✗ moves the problem one layer up |
| **B** | The digest function is injected — a parameter with the implementation supplied by the caller | viable | viable **only if** the implementation itself sits in `infrastructure` |
| **C** | A portable sha256 inside the domain, no builtin | viable, and it also lets the web bundle the VO | viable |

**Recommendation: A if the check is domain-only, otherwise B with the implementation in
`infrastructure`.** C is last despite its appeal — AGENTS.md is explicit that a new dependency
needs a clear reason, and a hand-written digest is a correctness risk on a value that is
pinned by a golden and stored in user data. If the lane finds A and B both blocked, C becomes
the answer and the golden is what proves it safe.

**A caveat the lane must not skip:** A weakens the VO's own invariant — that `policyHash` is
the hash of its own fields — by letting a caller pass any string. If A is taken, the VO should
still verify what it is given, or the invariant should be restated honestly in the comment.

### 2.4 What "rendered" should mean for H2

Not a chip for its own sake. `beats` is only meaningful on a motion asset that carried a
sequence, and `headline` only on a pooled-copy slot — both are already conditional in the
data. The existing `motion · 6s` chip is the natural neighbour.

If a field turns out to have no place a person would look, **D5's other branch applies**:
remove it from the type and stop writing it. A plan that only allows "add UI" is not a plan.

### 2.5 A finding this plan got wrong

M1 claimed a reloaded campaign loses its descriptor chips. It does not, and the mistake is
worth recording because it is the same one this session has been catching in others: a
conclusion drawn from a type's field list without following the data.

`PersistedAsset` does omit `descriptor` — but it is a **validator and packaging type**, not
the serialisation shape. What is actually written is:

```ts
type ReportAsset = GeneratedAsset & { brandCompliant: boolean };
const fresh: ReportAsset[] = result.assets.map((a) => ({ ...a, brandCompliant: … }));
```

A whole-entity spread, and `GeneratedAsset` carries `descriptor`. The merge path keeps whole
rows in a `Map` and writes them back unchanged, and `isPersistedAsset` returns a boolean —
it never narrows a row, and extra properties pass it.

So descriptors already survive a reload. Two things are still worth doing, and R2.3/R2.4 are
rewritten to be only those: the type should stop lying about what a row holds, and the round
trip should be pinned by a test so that a future narrowing of `writeReport` is caught rather
than discovered.

**Credit where it is due:** this was caught by the Qodo reviewer on the plan's own PR (#112),
before the lane's work was merged.

---

## 3. Phases

### R1 — the architecture lane (`packages/`, config, workflow)

| # | Task | Owns |
|---|------|------|
| R1.1 | **Establish the facts first.** Upgrade the linter in a scratch branch and record: exactly which violations 0.12.1 reports on today's `main`, and whether its node-builtin check covers `application` and `infrastructure` or only `domain`. Write the answer into the PR body — §2.3's choice depends on it | — |
| R1.2 | Get `node:crypto` out of `VariationPolicy.vo.ts` by the approach R1.1 selects. **The golden digest `7181107a…` must be unchanged**, and the "same brief hashes the same twice" test must still hold | `VariationPolicy.vo.ts` (+ `PlanVariationsUseCase` if A or B) |
| R1.3 | Bump `@hexagen-monaco/arch-linter` to `^0.12.1`. Leave `@hexagen-monaco/sync` alone (D4) | `package.json`, `yarn.lock` |
| R1.4 | Add `.architecture/layout.yaml` so the layer directories are declared rather than defaulted, or record why the defaults are correct here | `.architecture/layout.yaml` |
| R1.5 | Delete "class 0" and the relative-import exception paragraph from `pr-agent-arch.yml`, and correct the **Who Enforces This** section of `.agents/architecture.md` — both say in writing that they exist only until this upgrade | `.github/workflows/pr-agent-arch.yml`, `.agents/architecture.md` |
| R1.6 | **Prove the gate now bites.** Add the deliberate violation, confirm `lint:arch` fails, revert it. Paste both outputs into the PR body | — |

### R2 — the reachability lane (`apps/`)

| # | Task | Owns |
|---|------|------|
| R2.1 | Render `descriptor.beats` where a person would look for it, next to the existing `motion · Ns` chip — or, if there is genuinely no place for it, remove the field from `run-context.tsx` and from the use case and say why (D5) | `grid/page.tsx`, `messages.ts` |
| R2.2 | Same decision for `descriptor.headline` | same |
| R2.3 | **Complete the `PersistedAsset` type** — it describes a persisted row and says nothing about `descriptor`, which **variation** rows carry (`GeneratedAsset.descriptor` is optional and documented variation-only; classic rows omit it). Declare it as **`unknown`**: `isPersistedAsset` is a type predicate, so whatever the type claims is what callers believe after it returns true, and this guard deliberately does not validate the descriptor. **Do not add validation that can reject a row** — a malformed descriptor must not cost the whole creative | `apps/api/server/lib/report.ts` |
| R2.4 | A test that a **reloaded** campaign shows the same descriptor chips as a freshly-run one. It passes today — that is the point. It pins behaviour that currently works by virtue of `writeReport` spreading the whole asset, so a future narrowing is caught | `__tests__` |
| R2.5 | All new copy in `messages.ts` (D2 of DESIGN.md), read through `display-names.ts` where a raw domain value would otherwise reach the screen (D18) | `messages.ts` |

---

## 4. Definition of Done

- `yarn lint:arch` **fails** on a deliberate relative cross-layer import, and passes on `main` — both observed, both pasted into R1's PR body.
- `policyHash` for the golden brief is still `7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9`. No `node:crypto` import remains under `src/domain/`.
- `pr-agent-arch.yml` no longer carries class 0, and `.agents/architecture.md` no longer describes a gap that has been closed.
- Every field on the web `Asset.descriptor` type is either rendered by a component a user can reach, or gone.
- A campaign reloaded from its persisted report shows the descriptor chips a freshly-run one shows — asserted by a test, not by inspection.
- A persisted report written **before** this change still loads.
- Gate, on one `&&` chain, per lane: `build`, `typecheck`, `lint` **0 problems**, `lint:arch`, `sync:check` **0 ops**, `test:cov` 100% on all four counters.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| The upgrade surfaces more than the one known violation — the observed run was on one machine, one moment. | R1.1 is a survey before a change, and its output is the input to the rest of the lane. If the list is longer than one, R1 stops and reports rather than fixing in bulk. |
| Relocating the hash changes the digest. | The golden is the acceptance test and it runs on every gate. D2 makes "the golden moved" a stop, not a merge conflict to resolve. |
| Approach A quietly weakens the VO's invariant. | §2.3 names it; the lane must either verify the passed digest or restate the invariant in the comment. |
| Adding the descriptor to `PersistedAsset` breaks reports already on disk. | The field is optional and `isPersistedAsset` keeps accepting rows without it, asserted by R2.4's sibling test. |
| The two lanes collide. | They share no file (D7). `messages.ts` is R2's alone; `packages/` is R1's alone. |
| `lint:arch` starts failing for everyone the moment R1 merges. | That is the point, and it is why R1.1 comes first: the violation list is known before the gate is armed. |
