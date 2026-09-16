# Git Conventions

## Branches

- `feat/<short-description>` — new functionality
- `fix/<short-description>` — bug fixes
- `chore/<short-description>` — tooling, deps, docs
- Never commit directly to the default branch; branch first.

## Commits

- **Conventional Commits:** `type(scope): summary` — e.g.
  `feat(auth): add magic-link login`.
- Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`.
- **The scope names the area a reader would recognise — never a lane id.**
  `feat(music-bed):`, `fix(brief-editor):`, `test(goldens):` — not `feat(ve3b1):`
  or `test(x36):`, which are internal bookkeeping and mean nothing to someone
  reading `git log`. Keep the lane id where it stays useful: the PR body, the
  session log and the plan's shipped note, all of which are read by someone who
  already has the lane in hand.
- Subject in the imperative ("add", not "added"); body explains *why*, not what.
- One logical change per commit. Do not bundle unrelated edits.

## Pull Requests

- Title = the commit summary; description covers what changed and why, plus how
  it was verified.
- Squash merge so the default branch keeps one commit per PR.
- CI (build, typecheck, lint, test) must be green before merge.

## Never

- `git commit --no-verify` (it skips the hooks that protect the branch).
- Force-push the default branch.
- Commit secrets, `.env` files, or generated artifacts that are gitignored.
- Amend or rebase commits that have already been pushed and reviewed by others.
