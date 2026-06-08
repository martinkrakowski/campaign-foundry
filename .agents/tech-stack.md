# Tech Stack Reference

The explicit, canonical list of tools. Read this before suggesting any library —
if it is not here (or is in "Never Suggest"), do not introduce it without asking.

## In Use

| Tool          | Purpose       | Notes                                              |
| ------------- | ------------- | -------------------------------------------------- |
| Next.js       | Web framework | App Router. Do not add Pages Router.               |
| React         | UI            | Function components + hooks; no class components.   |
| TypeScript    | Language      | `strict: true`. No `any` — narrow or use `unknown`. |
| Vitest        | Test runner   | `import { describe, test, expect } from "vitest"`; `vi` for mocks. |
| @testing-library/react | UI tests | Render/query components under happy-dom; assert with `expect`. |
| happy-dom     | Test DOM      | Vitest `environment: "happy-dom"` for the web project.           |

> Keep this table accurate. When you add a dependency (or a Hexagen template
> adds one), add its row here in the same change — a stale stack reference is
> how agents start hallucinating.

## Never Suggest

- **Jest / Mocha / Chai** — this project uses Vitest (with `@testing-library/react`
  + happy-dom for UI). Do not add a second test runner.
- **Pages Router** — App Router only.
- **`any`** — use a precise type, a generic, or `unknown` with narrowing.
- A new HTTP client, date library, or state manager **before checking** whether
  the standard platform API (`fetch`, `Intl`, React state) already covers it.

## Per-Template Additions

Hexagen templates extend this stack. After installing a template, add its
primary packages here — e.g. BullMQ + ioredis (background jobs), LangGraph
(agent graphs), Supabase (storage). Run `hexagen validate-templates` to see
what is installed.
