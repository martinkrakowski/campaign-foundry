# Status Without Asking — Architecture & Development Plan

**Date:** 2026-09-12 · **Owner request:** *"I ask you for status often — can this roll into the wave
status page, so it's always automatically updated?"*

**Revised after plan review.** The first draft named the wrong headline defect, claimed a field was
missing that has been on disk for days, and asserted a PR count it could not support. What the
review found instead is worse than what the draft proposed to fix, and it is recorded here in place
of it.

---

## 1. What a status report contains, and what the page can answer

Every status report given this session answers four questions: **what is running**, **what is waiting
on me**, **what landed**, **what is left**.

The draft claimed the page answers the first today. **It does not.** Liveness is derived by `pgrep`
inside the lane-log loop (`collect.ts:131-136`), and since dispatch moved to the `Agent` tool
(SKILL.md:26-32) the current wave directories hold no lane logs at all — `/tmp/wave-W3` has only
`events.jsonl`. An event-only lane is merged in as `{ alive: false }` (`merge.ts:96`) and never
reaches the probe. So the page answers **none** of the four questions for a lane dispatched the way
lanes are dispatched now.

---

## 2. Findings

| Sev | Finding |
|---|---|
| **C1** | **The PR-to-lane join matches nothing.** `collect.ts:240-241` requires a branch of exactly `feat/<lane>`, and `prByLane[lane]` (`:152`) is a case-sensitive lookup. Measured on this machine: **151 lane logs, 46 `feat/` heads, zero intersection.** Lane ids are written `L3b`, branches are `feat/l3b-layer-props` — case and slug both differ. Every PR column the page could show is empty for structural reasons, and no amount of extra branch prefixes fixes it. |
| **C2** | **PR facts attach only to rows built from lane logs** (`collect.ts:148-153`). Even a correct join would attach nothing for the lanes we run today, which emit events and no log. C1 and C2 are separate mechanisms and both must go. |
| **H1** | **Unresolved review threads are not collected.** The one fact that separates *CI is green* from *this can merge*, and the fact nearly every status report turned on. |
| **H2** | **`checks: "none"` means at least four things**: no `Build*` check yet (`parseChecks`, `:278`, `:283`), unparseable JSON (`:280`), the call failed (`:253`), and the initial default (`:245`). Three consumers read it — `lane-state.ts:24,37,40`, `render.ts:81,123`, `index.html:1443-1449`. |
| **M1** | **The backlog is absent.** `plan:verify` computes it; the page does not show it. |
| **M2** | **The seat is recorded and never rendered.** `detail.seat` is on disk across three seats — `agy gemini-3.8-flash-high`, `opencode-go/glm-5.3-flash`, `opencode/big-pickle`. The page renders only `fixed/refuted/mutations/mutationsBit` from `detail` (`index.html:1494-1501`), and emission is convention rather than requirement. **The draft called this absent. It was not.** |

---

## 3. Lanes

| Lane | Task | Proof |
|---|---|---|
| **S1** | **Join PRs to lanes by something that exists.** The orchestrator already emits `pr` on the event (`types.ts:19`; 21 events on disk carry it). Prefer that to any branch-name convention; fall back to a normalised branch match. | A lane whose event carries `pr: N` shows that PR. The 151 lane logs and 46 heads on this machine produce a non-empty join, asserted against a recorded fixture. |
| **S2** | **Attach PR facts to event-only lanes** (C2), and derive liveness for them. | A lane with events and no log shows its PR and its liveness. |
| **S3** | **One PR-facts lane: threads (H1) and the `none` split (H2) together.** Both change `LaneObservation.pr`, both edit `prFacts`, both update the same three consumers. | A PR with an unresolved thread reads as needing attention with CI green. *Could not ask* renders differently from *nothing to ask about*, and nothing throws on either. |
| **S4** | **Render `detail.seat`, and make emitting it required** rather than customary (M2). | A lane's row names the seat that ran it; a lane dispatched without one says **unknown** rather than guessing. |
| **S5** | **A backlog panel from `plan:verify`.** | The panel matches `yarn plan:verify` for the same tree, by **importing `parsePremises`/`verifyPremises`** rather than re-implementing them — the only non-drifting option. |

**Order.** S1 → S2 → S3, strictly: all three edit `prFacts` in one loop, and the repository's own
rule is never to let two lanes own a file at once (SKILL.md:234). S4 and S5 are independent of them
and of each other.

**Everything here sequences behind #349** (rewrites `collect.ts`) **and #351** (changes
`lane-state.ts` and `index.html`, and already introduces the `unknown` state S3 must adopt rather
than invent a second spelling of).

---

## 4. Two questions this plan must answer before S5 is dispatched

**Does the read-only server execute shell?** Its charter is that it starts nothing, kills nothing and
merges nothing (`server.ts:114-118`, D106). A premise is arbitrary `sh` — X1 runs `npx prettier` —
and `plan:verify` executes them with `sh -c`. Running them on a 15-second poll inside a long-lived
localhost server **is a charter change**. The plan does not make it: S5 reads a result the CLI wrote,
or re-runs only when a plan file changes. Whichever is chosen goes in the lane brief explicitly.

**Does S3 only read threads?** V4 in the verification-budget plan owns *resolving* them. The same
GraphQL endpoint does both, so S3's brief must say read-only.

---

## 5. What this plan refuses

- **It does not add per-PR polling on top of what exists.** The draft claimed it "does not poll
  harder" while proposing a call per open PR, which doubles the sweep. S3 must fetch thread state for
  **all** open PRs in **one** query, or it is not in scope.
- **It does not summarise findings in prose.** Counts and states only. *Why* a thread is open is in
  the thread, and a page that paraphrases review will eventually paraphrase it wrongly.
- **It does not replace the disposition.** Deciding whether a finding is real stays a judgement made
  against the code.
- **It does not add an expiry**, unchanged from the command-monitor plan.

---

## 6. Definition of done

A developer opening the page can answer *what is running*, *what is waiting on me*, *what landed* and
*what is left* without asking anyone — for a lane dispatched the way lanes are dispatched **today** —
and every number is derived from a command rather than asserted.

**Each lane's own PR retires its own premise fence in the same diff.** `plan:verify` runs on every PR
(`ci.yml:95-96`), so a completing lane that leaves its fence behind fails its own CI. The draft
omitted this and S1 would have hit it first.

---

## 7. Premises

```premise S1
# The join key: PR facts are looked up by a branch-derived lane slug. The lane
# is done when the event's own `pr` number is what joins. Probing the lookup,
# not the prefix constant, because adding prefixes to a broken join changes
# nothing.
grep -q 'prByLane\[' tools/wave-status/lib/collect.ts
```

```premise S2
# Rows have exactly one source: the lane-log loop. An event-only lane therefore
# never reaches the PR attachment or the liveness probe. S2 adds a second source
# and a second push; until it does, there is one.
# Probing the count rather than the loop header, because the header is a name
# (`laneLogs`) and a rename would retire a live lane.
test "$(grep -c 'rows.push(' tools/wave-status/lib/collect.ts)" = "1"
```

```premise S3
# Thread state is never requested, and the checks union still carries no value
# for "could not ask". Either landing flips it.
! grep -rq 'reviewThreads' tools/wave-status/lib || ! grep -q '"unknown"' tools/wave-status/lib/types.ts
```

```premise S4
# The seat is on disk and the page never reads it. Probing the property access,
# not the word: "seat" is house vocabulary and appears in prose everywhere.
! grep -qE '\.seat\b' tools/wave-status/public/index.html
```

```premise S5
# The page cannot show premise state without wiring to the tool that computes
# it. Probing the wiring, because "premise" as an English word is house
# vocabulary and would retire this lane on any passing comment.
! grep -rq 'plan-verify' tools/wave-status --include=*.ts
```
