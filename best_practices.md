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
3. **The web test environment is happy-dom: it performs NO layout.** `getBoundingClientRect`
   returns zeros and `getComputedStyle` cannot see class-driven styles. Never suggest
   computed-style or geometry assertions; the repo's D47 rule forbids class-string assertions
   as *proof* of layout for the same reason.
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
