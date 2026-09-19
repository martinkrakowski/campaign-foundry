"use client";

import { useRef } from "react";

/**
 * One definition of the staleness token the app already relied on in two places.
 *
 * The invariant: **an answer about state that has since been re-read must not be
 * installed.** Overlapping async work is started in an order the network does not
 * respect, so a round is stamped when it begins and checked before its result is
 * allowed to land. An older answer arriving late is dropped, not applied.
 *
 * Both existing sites were hand-rolling this, and they were not identical:
 *
 * - `BriefEditor`'s capability probe kept `let generation = 0` inside the effect
 *   closure. Mount and focus requests overlap; the loader both bumps the token
 *   (on focus) and checks it (after `await`).
 * - `HeadlinePoolDrawer` kept `useRef(0)` at component scope, because the two
 *   halves are **different functions**: the load effect bumps it, and `apply` —
 *   an unrelated async writer — captures it before a write and re-checks it
 *   after, so a reopen or a brief switch that reloaded mid-write cannot have the
 *   write's stale revision installed over it.
 *
 * That second shape is why this is a **ref, not closure state**: the checker may
 * outlive the effect that started the round, and may not be the same function.
 * A closure-local counter cannot express it.
 *
 * ```ts
 * const round = useLatestOnly();
 * const token = round.begin();       // this work is now the current round
 * const result = await something();
 * if (!round.isCurrent(token)) return;  // a newer round started; drop this
 * ```
 *
 * This does not cancel anything and is not a substitute for `AbortController` or
 * an unmount flag — both sites keep theirs. It answers one question only:
 * *is the round I started still the current one?*
 */
export interface LatestOnly {
  /** Stamp a NEW round as current, and return its token. For the starter. */
  readonly begin: () => number;
  /**
   * The current round's token, WITHOUT starting one — for a caller that RIDES a
   * round rather than starting it. `HeadlinePoolDrawer`'s `apply` captures the
   * load's round before a write and re-checks it after.
   *
   * **Honest scope, measured:** using `begin()` there instead is currently
   * equivalent, because that load never checks its own token — it guards with a
   * `cancelled` flag, so nothing observes the extra bump. A mutation swapping
   * the two does not red. `current()` is kept because it says which of the two
   * roles the caller is in, and because the equivalence is an accident of the
   * loader's shape: the day a loader does check its own token, `begin()` in a
   * reader silently invalidates the very work it is riding. It is intent, not a
   * fix — recorded this way so nobody "simplifies" it on the strength of a
   * passing suite.
   */
  readonly current: () => number;
  /** Whether `token` names the round that is still current. */
  readonly isCurrent: (token: number) => boolean;
}

export function useLatestOnly(): LatestOnly {
  const round = useRef(0);
  // Stable across renders on purpose: `HeadlinePoolDrawer` reads these from an
  // async writer, and an identity that changed per render would make them a
  // dependency nobody can name.
  const api = useRef<LatestOnly>({
    begin: () => (round.current += 1),
    current: () => round.current,
    isCurrent: (token: number) => token === round.current,
  });
  return api.current;
}
