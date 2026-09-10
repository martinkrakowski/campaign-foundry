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
   earlier version of this entry claimed that mutation failed *two* tests; it did when first
   measured, and one of the two later stopped reading computed style, so the count went stale. One
   test fails today.

   **Declared is not measured.** Even where a rule resolves, `flexWrap === "wrap"` only restates the
   stylesheet — a tautology, not a proof that anything wrapped. Prefer asserting state the code
   controls (`hidden`, an ARIA attribute, a class it toggles). That is what D47's ban on
   class-string assertions as *proof of layout* was always about.

4. **`NodeCanvasCompositor` and everything under `packages/CreativeGeneration` is server-side
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
   `getByText(messages.x(...))` deliberately: they pin state→message *wiring*; copy content is
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

## What is always worth reporting

The classes that have shipped real bugs here: cache keys missing a request field; a test that
cannot fail against the defect it names (vacuous tripwires, early returns before assertions);
per-frame/two-path features applied to only one draw path; rest-pose/poster clocks sampling the
wrong `t`; synchronous double-fire on async confirm handlers; dirty-state machinery fighting a
navigation. Findings in these classes have a near-100% acceptance rate — spend the effort there.
