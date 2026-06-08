# Session Log

A running record of AI-assisted work sessions. After each session, append an
entry using the template below. Keep entries short — this is a memory aid for
the next session, not documentation.

Unlike the other `.agents/*.md` spec files (which AGENTS.md marks "never edit"),
this file is **append-only by design** — adding session entries is expected.

To keep this file out of version control, add `.agents/session-log.md` to
`.gitignore`.

---

## Template (copy for each session)

**Session:** YYYY-MM-DD — topic

- **Mode:** Implementer
- **Changes:**
  - (what was edited, at a file/feature level)
- **Decisions:**
  - (choices made and the reason, so they are not relitigated)
- **Left open:**
  - (follow-ups, known gaps, anything the next session should pick up)

---

## 2026-01-01 — example entry

- **Mode:** Architect
- **Changes:**
  - none (planning only)
- **Decisions:**
  - Adopted the Hexagen template system for infrastructure slices.
- **Left open:**
  - Decide which auth provider template to install.

---

## 2026-06-08 — 100% test coverage

- **Mode:** Implementer
- **Changes:**
  - Stood up Vitest (istanbul coverage, happy-dom for the UI) and switched the
    test contract from node:test (`.agents/testing.md`, `.agents/tech-stack.md`,
    AGENTS.md). Wrote 271 tests across every workspace reaching 100%
    statements/branches/functions/lines; CI `test:cov` now enforces the gate.
  - Small seam refactors shipped with their tests: injectable client on
    GeminiImageGenerator; exported bin/generate `main()`; shared `errorMessage`
    helper. Deleted four dead generated stubs from the shared kernel.
- **Decisions:**
  - Chose Vitest over node:test (user call): the UI coverage target made happy-dom
    + built-in coverage decisive. Coverage runs as the full suite so each project
    transforms its own files.
  - Justified `istanbul ignore` only on genuinely-unreachable defensive guards
    (focus-trap `!focusables`, disabled-button/unmount-race guards).
- **Left open:**
  - Package-level `lint` script can't resolve the eslint bin inside a workspace
    (pre-existing; eslint works at the repo root).
