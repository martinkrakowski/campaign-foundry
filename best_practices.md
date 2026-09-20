# Reviewer facts — campaign-foundry

Ground truths for automated reviewers. Every class below produced **multiple refuted findings**
in past reviews; each cost a human a verification cycle. Check the fact before reporting the
class. A finding whose premise one of these facts disproves should not be posted.

## Environment facts

1. **The test runner is Vitest.** `expect(actual, message)` — the two-argument form — is
   Vitest's own documented API for a custom failure message. It runs and fails correctly; do
   not report it as an incorrect call.
2. **React 19.** `ref` is an ordinary prop on function components. Never suggest `forwardRef`;
   never claim `aria-*`/`ref` props "cause TypeScript errors" on a tree whose typecheck CI is
   green — a green compile disproves missing-prop and missing-import claims.
3. **happy-dom performs NO layout, and whether a class resolves depends on whether its stylesheet
   is loaded.** `getBoundingClientRect` returns zeros, `offsetWidth`/`offsetHeight` are zero, and
   nothing requiring a measured box — clipping, overflow, wrapping, visual covering, reachability —
   can be observed. **Never suggest a geometry assertion, and never accept a computed value as
   proof that something is reachable or visible.**

   On class-driven `getComputedStyle`, this file previously said a flat "cannot see them". That is
   wrong, and the truth is a distinction neither document was making:
   - **`apps/web` component tests load no stylesheet at all** — `apps/web/vitest.setup.ts` imports
     no CSS, so Tailwind classes have no rules behind them and class-driven values really do resolve
     to `""`. An assertion there cannot tell a real class from a typo, which is what
     `2026-09-01_r7-preview-panel.md` says and it is right **for that suite**.
   - **`tools/wave-status` page tests load the real page, `<style>` block and all** — the test reads
     `public/index.html` itself. Class-driven declarations resolve there. Measured: changing
     `.gutter { user-select: none }` to `auto` flips `getComputedStyle(gutter).userSelect` and fails
     `the gutter is user-select: none…`, an assertion in `main` under a green gate.

   **So before endorsing or refuting a computed-style finding, ask which suite it is in.** An
   earlier version of this entry claimed that mutation failed _two_ tests; it did when first
   measured, and one of the two later stopped reading computed style, so the count went stale. One
   test fails today.

   **Declared is not measured.** Even where a rule resolves, `flexWrap === "wrap"` only restates the
   stylesheet — a tautology, not a proof that anything wrapped. Prefer asserting state the code
   controls (`hidden`, an ARIA attribute, a class it toggles). That is what D47's ban on
   class-string assertions as _proof of layout_ was always about.

4. **There is no `DESIGN.md` §1.5, and the two rules that sound alike are different.** I cited
   "§1.5" for the offer rule throughout one session; it does not exist. The two real rules:
   - **§1 Principles (line 30)** — a refusal "must never leave the user with a disabled control as
     the answer". This is the **offer** rule: a control the boundary would refuse is **absent**, not
     present-and-disabled. `TemplateSection.tsx` follows it for add and remove.
   - **§5 Patterns, "Capability gating"** — when the **host** cannot do something (no ffmpeg → no
     motion) the control **is disabled and the reason is shown**, quoting the probe.

   **They are resolved by cause, not by preference.** A rule the product would refuse → hide the
   offer. A capability the machine lacks → disable and say why, because the user can act on that.
   Citing the wrong one inverts the fix. Quote the section name, never a subsection number.

5. **`NodeCanvasCompositor` and everything under `packages/CreativeGeneration` is server-side
   Skia canvas.** There is no DOM, no stylesheet, no theme, and no CSS cascade there.
   `ctx.fillStyle = "var(--…)"` is an invalid canvas color that silently paints black.
   DESIGN.md's token rule governs the web app's styles only; the compositor's unconditional
   `#ffffff` headline is a recorded decision (C3/T1a — the preview was corrected to match the
   render, never the reverse).

## House rules that look like bugs

5. **Unreachable guards are restructured away, never added.** Before reporting a missing
   null/undefined/fallback guard, check the type (closed unions, non-optional state fields)
   and the normalization layer (`normalizeDraftState` repairs drafts element-by-element;
   `list()`'s consumers validate members). A guard for a state the type system or normalizer
   forbids will be refused, because it is uncoverable under the 100% branch bar.
6. **The conditional-spread hash pattern is deliberate.** `VariationPolicy` spreads optional
   axes into `policyHash` only when present, so every pre-existing brief's hash — which the
   re-roll path pins — stays byte-identical. Suggesting unconditional fields, or widening
   `LAYOUT_VALUES`, silently re-plans live campaigns. New vocabulary lands in NEW optional
   fields.
7. **`messages.ts` is append-only and every user-facing string lives there.** A jargon gate
   test forbids raw domain ids ("planner", "draw", axis values, platform ids) in user copy.
   Copy suggestions must survive that gate.
8. **Helper-referenced test assertions are house style.** Tests assert
   `getByText(messages.x(...))` deliberately: they pin state→message _wiring_; copy content is
   owned by the jargon gate and helper-level tests. Do not ask for literal-string rewrites.
9. **`Record<ClosedUnion, string>` maps are compile-enforced exhaustive.** Adding a union
   member breaks the build until the map is updated — do not report "manual sync" drift for
   them, and do not ask for `Readonly` on maps nothing mutates (the sibling maps are plain
   `Record`, and `Readonly` is compile-time only).
10. **Component state dies with unmount.** Do not request unmount-cleanup effects for
    `useState` values; nothing persists after navigation by construction. Conversely, DO look
    for the real variant: state that must survive a **route segment change** goes through the
    documented one-shot handoff patterns, and reading storage in a `useState` initializer is
    the repo's documented hydration trap (`Disclosure`'s comment) — that one is always worth
    reporting.

## Defensive code is refused here, not merely unnecessary (2026-09-20)

Four PRs on 2026-09-20 (#535, #537, #538, #539) produced **eleven** findings in the four classes
below. All eleven were refuted with the same few facts. Check these before reporting the class.

1. **"Add a guard / fallback / default for this impossible case."** This repeats House rules 5
   above — kept here only for the evidence: **five** such suggestions were refuted across #535,
   #537, #538 and #539 in one day, and two genuine dead branches were **removed** for the same
   reason. If House rules 5 were enough on its own, that count would be lower.

2. **"Validate this invariant at the point of use."** The domain validates once, at its own
   boundary, and both brief boundaries plus every editor write call the same function. So
   `track.stops[0]!` cannot throw (`layerTracksProblem` refuses an empty `stops` array), and a
   track cannot hold mixed clocks (it refuses those too, because K1b found the resolver silently
   ignoring off-clock stops — data loss with no message). Re-validating is a **second statement of
   the rule**, free to drift from the one that actually holds.

3. **"Memoise this / wrap it in `useCallback`."** The cost contracts here are specific and
   **measured by render-count tests** (CC1/CC2 for the rail, SG1 for the form). Code outside those
   paths has no budget to protect, and this repository records memo-driven restructuring going the
   wrong way: `variation-plan.tsx` went from 1 render to 4 on one look-preserving keystroke. Cite
   a count, or do not report it.

4. **"Make this required prop optional / give it a default."** That is precisely how a call site
   silently stops passing it — **D157: a prop nobody passes is indistinguishable from one that
   does not exist.** A required prop makes a missed caller a compile error. Three vacuous caller
   tests were found and rewritten on 2026-09-20 for exactly this failure.

**The counter-case, and it is worth more than all four:** a test that _cannot fail_ against the
defect it names. Two shipped on 2026-09-20 and both were caught in review — one asserted a select
had options (true with or without the prop), another asserted a number was finite (true of `0`).
Both would have passed with the wiring deleted. **That class is always worth reporting.**

## The `§` convention points at DESIGN.md (2026-09-20)

A bare `§6` or `§4.4` in a comment resolves to **DESIGN.md's** top-level sections — "Copy (house
style)" and "Components". A reference to a planning document must name the file
(`studio-editor.md` §4.4 rule 8), or a reader follows it to the wrong document. Three such
references shipped and were corrected in review.

## What is always worth reporting

The classes that have shipped real bugs here: cache keys missing a request field; a test that
cannot fail against the defect it names (vacuous tripwires, early returns before assertions);
per-frame/two-path features applied to only one draw path; rest-pose/poster clocks sampling the
wrong `t`; synchronous double-fire on async confirm handlers; dirty-state machinery fighting a
navigation. Findings in these classes have a near-100% acceptance rate — spend the effort there.

## A mutation is only evidence if the mutant changes behaviour (2026-09-11)

`yarn mutate` refuses a **textual** no-op — it checks the file's bytes changed and that the intended
text landed. It cannot tell that the _program_ still behaves identically, and a fallback path is
exactly where that hides.

**The case.** A reviewer claimed a YAML round-trip test could not see `enabled: true` being dropped.
The orchestrator "confirmed" it by mutating `orderedKeys` so the declared-order loop skipped every
`true`-valued key, ran the suite, saw 16 passes, and reported the test vacuous. `orderedKeys` has a
**second, catch-all loop**:

```ts
for (const key of order) {
  const value = source[key];
  if (value !== undefined) out[key] = value; // ← mutated here
}
for (const key of Object.keys(source)) {
  if (!Object.prototype.hasOwnProperty.call(out, key) && source[key] !== undefined)
    out[key] = source[key];
} // ← copies it straight back
```

The key still reached the output, merely later in the order. Nothing failed because nothing had
changed. Mutating **both** loops reds two tests — including one older than the branch under review.
The suite was never blind, and a fix round was dispatched on a false premise.

**The check, before reading any verdict.** Prove the mutant changes an observable: call the mutated
function once and diff its output against the original, or assert the mutated behaviour directly.
Ten seconds, and it separates _the test is weak_ from _my mutation did nothing_.

**The tell.** A surviving mutant on a path that is obviously covered should raise suspicion of the
mutation, not of the test. Ask what else in the function could be compensating — a fallback, a
default, a second pass, a `??`, a catch-all — before concluding the assertion is vacuous.

**Where this bites hardest.** A survived verdict is an accusation against a test. Acting on a false
one costs a delegated round and, worse, teaches the suite's readers that a good test was bad.
