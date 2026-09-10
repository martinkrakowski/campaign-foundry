# The Unowned Gaps — Architecture & Development Plan

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

## 5. D136 is half-shipped

**Evidence.** The occlusion advisory reaches the editor and no further. `CompliancePort` and
`ComplianceResult` were listed in L8's ownership and never touched. The advisory encodes as
`{ passed: true, reason }` while `ComplianceResult` documents `reason` as *"populated on failure"* —
so an aggregator reading `passed` sees nothing and one reading `reason` sees a failure.

**Recommended default: amend D136 to editor-only, and fix the encoding.** The compliance page is
**run-scoped** — one row per generated asset from `useRun()` — and an occlusion finding exists before
any run. Aggregating it there needs a page redesign that nothing else wants. **Amending is honest;
leaving a decision half-shipped is not.** The encoding ambiguity is real either way and should be
resolved whichever side is chosen.

## 6. `validateBrief` never checks copy against the template

**Evidence.** It validates style and sizes. It does **not** check the brief's copy fields against its
template's `accepts` / `required` sets, so a brief whose template omits a text kind can still carry
campaign copy the compositor will draw.

**Recommended default: fold it into M2**, where the boundary is already being extended for `enabled`.
It is the same boundary, the same file, and the same kind of rule. **Written into M2's brief rather
than left as a note**, which is how it stayed unowned until now.

---

## 7. Order

| | Lane | Note |
|---|---|---|
| 1 | **U3** — the macOS golden caveat | one comment; do it first because it costs nothing |
| 2 | **U4** — serve `:root` as a base, with the resolve test | small, unblocks nothing, prevents a third workaround |
| 3 | **U5** — amend D136 and fix the encoding | a decision plus a small change |
| 4 | **U6** — fold the copy/template cross-check into M2's brief | no code; it changes a brief |
| 5 | **U2** — `alt` in the props vocabulary | sequence with the HTML layer |
| 6 | **U1** — **Prettier, alone** | last, because it conflicts with everything; run when no lane is in flight |

## 8. What this plan refuses

- **It does not batch U1 with anything.** A repo-wide reformat run beside another lane is how a real
  change gets buried, which is the problem it exists to solve.
- **It does not add a macOS CI runner** to close gap 3. The cost is real and the honest caveat is
  cheap.
- **It does not build the compliance-page aggregation** to close gap 5. Amending the decision is the
  smaller true thing.
