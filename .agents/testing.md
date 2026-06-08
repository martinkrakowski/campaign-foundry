# Testing

## Runner & Assertions

- **Runner:** **Vitest** — `import { describe, test, expect } from "vitest"`.
- **Assertions:** Vitest's `expect` — e.g. `expect(x).toBe()`, `expect(x).toEqual()`.
- **Mocks:** Vitest's `vi` — `vi.fn()`, `vi.spyOn()`, `vi.mock()`. Mock at the
  boundary (ports/adapters), not deep internals.
- **DOM:** UI tests run under the `happy-dom` environment with
  `@testing-library/react` + `@testing-library/user-event`. Render and query the
  component; assert with `expect`.
- **Never** introduce Jest, Mocha, or Chai. Vitest is the one runner.

## Conventions

- **File naming:** `*.test.ts` (`*.test.tsx` for UI). Not `*.spec.ts`.
- **Location:** a `__tests__/` directory adjacent to the module under test.
- **Determinism:** no real network, clock, or filesystem in unit tests — inject
  a fake at the seam (the ports make this trivial). Integration tests that need
  real I/O (canvas, PDF, filesystem, HTTP routes, the CLI) are named and
  isolated, using a `mkdtemp` working directory and fixtures under
  `__tests__/fixtures/`.

## What a Good Test Looks Like

- One behaviour per test; the name states the behaviour, not the method.
- Arrange / act / assert, with the assertion targeting observable output.
- Failing first: when fixing a bug, add the test that reproduces it before the
  fix, and confirm it goes red then green.

## Coverage

- Vitest v8 coverage (`yarn test:cov`). The repo targets **100%**
  (statements / branches / functions / lines); the gate is enforced in CI.
- Coverage exclusions must be non-executable or generated (re-export barrels,
  config files, type declarations) and justified inline in `vitest.config.ts`.

## Before You Commit

Run the suite (`yarn test`). A red suite blocks the commit — diagnose, do not
skip or delete the failing test to make it pass.
