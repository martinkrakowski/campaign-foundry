# AGENTS.md

> An HITL orchestrator for deterministic creative generation and automated brand compliance.

This is the primary instruction set for AI agents (Claude Code and others)
working in this repository. It is a **living contract**, written in the
imperative — "You MUST", "Never", "Always". Explanations and longer guidance
live in the `.agents/` spec directory, not here.

If a request conflicts with this file, follow this file and say so.

---

## The Immutable Anchor

- This project follows the **hexagonal** architecture style. See
  `.agents/architecture.md` for layer boundaries and import rules — do not
  violate them.
- Match the surrounding code: naming, file layout, test style, and comment
  density. Read a neighbouring file before writing a new one.
- Prefer editing existing files over adding new ones. Do not introduce a new
  dependency without a clear reason.

## Before Every Exchange

1. Declare your **mode** (see the Mode System below) on the first line.
2. Restate the goal in one sentence.
3. Check this file and the relevant `.agents/` spec before acting.

## Tech Stack Reference

The canonical, explicit stack lives in `.agents/tech-stack.md`. It lists both
what IS used and what is **never** used — read it before suggesting any tool or
library, to avoid hallucinated dependencies.

## Conventions

- **Logging:** use the structured logger (`src/infrastructure/logging/logger.ts`, from the
  `observability` template) — e.g. `logger.info({ userId }, "user.created")`. **Never `console.log`**
  — it has no level, correlation id, or redaction and becomes technical debt. The `eslint-no-console`
  template enforces this in lint/CI; the only exempt sites are the logger transport, server startup,
  scripts, and config files.

## Commands After Edits

Run the matching command after each kind of change. On failure, stop and fix
before continuing.

| Trigger                  | Command                                  | On failure              |
| ------------------------ | ---------------------------------------- | ----------------------- |
| Before starting work     | `npm run build && npm run typecheck`     | STOP — fix first        |
| Any `.ts` / `.tsx` edit  | `npm run lint && npm run typecheck`      | Fix before continuing   |
| After adding a template  | `hexagen validate-templates`             | Resolve conflicts       |

(If this project uses yarn or pnpm, substitute the package manager — the
triggers stay the same.)

## Files Never Edit

Each rule has a reason; agents follow rules they understand.

| File                          | Reason                                                       |
| ----------------------------- | ----------------------------------------------------------- |
| `AGENTS.md`                   | This contract. Change it deliberately, never as a side effect. |
| `.agents/*.md` (except `session-log.md`) | Spec files — edit only when explicitly asked to update specs. `session-log.md` is the deliberate exception: append to it after each session. |
| `package-lock.json`           | Updated only via `npm` commands, never by hand.             |
| `DESIGN.md`                   | Design contract (if present). Changes require design review. |

## Mode System

Declare your mode at the top of every response. Do not blend modes.

| Mode               | Trigger                            | Behaviour                                          |
| ------------------ | ---------------------------------- | -------------------------------------------------- |
| Architect          | "design", "plan", "how should we"  | Think in layers, ports, trade-offs. No code.       |
| Implementer        | "build", "add", "implement"        | Write code. Follow conventions exactly.            |
| Debugger           | "fix", "broken", "error", "why"    | Find the root cause before touching code.          |
| Reviewer           | "review", "check", "audit"         | Read only. Report findings. No unsolicited fixes.  |
| Tester             | "test", "coverage", "spec"         | Write tests. Never modify the code under test.     |

## Commit & PR Conventions

See `.agents/git.md`. In short: Conventional Commits, branch names like
`feat/<desc>` or `fix/<desc>`, never `--no-verify`, never force-push the
default branch.

## Spec Directory

Deeper guidance lives in `.agents/`:

- `architecture.md` — layer boundaries and import rules
- `git.md` — commit/branch/PR rules
- `tech-stack.md` — exact tools, with negative examples
- `session-log.md` — running log of AI-assisted sessions (present when session
  logging is enabled)

## Wave Observability

When you are running the delegated pipeline (`/orchestrate-wave`), a read-only status
server can show every lane's stage, liveness, PR and gate at a glance.

| Trigger | Command | Notes |
| --- | --- | --- |
| Starting a wave | `yarn wave:status` | Serves `http://127.0.0.1:4317`. Read-only; it starts, kills and merges nothing. |
| Any stage transition | append an event (`scripts/wave-event.sh`) | **Emitting is part of the stage, not a courtesy** — see the skill. |

**Emit, do not infer.** Log sizes, `EXIT` markers and PR checks are derivable; which stage
a lane is in, how many findings were fixed versus refuted, and whether a mutation actually
bit are not — they exist only if you record them. The page shows derived facts and reported
events side by side and **flags disagreement rather than resolving it**: a lane reporting
`settled` with no PR is the single most useful thing the pipeline can tell you.

The server never binds `3000` or `3001` — those are the operator's `next dev` and API, and
it refuses them by construction.

Two constraints on that text, both deliberate. It **never says the dashboard is required** —
a wave must run correctly with nothing watching, and an agent that cannot start the server
should proceed, not stop. And it repeats *emitting is part of the stage* in the contract as
well as the skill, because the one thing this session proved is that a duty defined as a
separate final step is the duty that slides.

