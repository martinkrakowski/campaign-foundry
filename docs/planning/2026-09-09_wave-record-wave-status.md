# Wave Record — the wave-status tool, and the verification-budget plan

**Date:** 2026-09-09 · **Plan:** `2026-09-09_verification-budget.md` (#288) · **Main:** `fc6dff9`, green

## What merged

| PR | Lane | What | Gate | Fixed | Refuted |
|---|---|---|---|---|---|
| [#287](https://github.com/martinkrakowski/campaign-foundry/pull/287) | W1b + W1c | The CLI cannot be spoofed, raced or mis-rooted | green | 2 | 0 |
| [#288](https://github.com/martinkrakowski/campaign-foundry/pull/288) | — | The verification-budget plan | green | — | — |
| [#289](https://github.com/martinkrakowski/campaign-foundry/pull/289) | V5 | Mutation and merge preconditions | green | 1 | 1 |
| [#290](https://github.com/martinkrakowski/campaign-foundry/pull/290) | V1 | Forbid the absence claim | green | — | — |
| [#291](https://github.com/martinkrakowski/campaign-foundry/pull/291) | W2b1 | Log toolbar and line-number gutter | green | 6 | 4 |
| [#292](https://github.com/martinkrakowski/campaign-foundry/pull/292) | — | The agy seat needs `LANE_CMD` | green | 1 | 2 |
| [#293](https://github.com/martinkrakowski/campaign-foundry/pull/293) | W2b2 | Export a whole lane log | green | 4 | 2 |

## The V3 data point — first measurement after V1

**Not yet a verdict.** V3's gate is one full wave; this is three PRs, two of them small.

| Reviewer | Threads | Accepted | Refuted |
|---|---|---|---|
| Qodo | 12 | **9** | 3 |
| PR-Agent | 6 | 1 | **5** |

**The prohibition appears to have killed its class. Zero of the refuted findings were absence
claims** — none said a symbol was undefined, missing or never called. The five refuted PR-Agent
findings were: the happy-dom premise (three times), the `LANE_CMD` quoting, and a request to trim a
string with no failing input.

So the honest reading is **not** "V1 did not work". Its target class is gone from this sample; the
refused rate stayed high on unrelated grounds. **Do not disable yet** — the gate says one wave, and
this is a third of one.

**Qodo earned its keep.** Nine accepted across three PRs, including the two most serious defects of
the wave: a rotating log crashing the whole server, and a client that buffered the entire file the
route had just been rewritten to stream.

**A first: both bots converged on the same false finding.** On #292 each independently read the
single quotes in the documented agy dispatch as a bug that stops the brief reaching the command.
Probed with the wrapper's real interpolation and a stub: the contents arrive. The substitution is
deferred to the `zsh -c` the wrapper spawns in the worktree, which is the only shell whose working
directory is right. Recorded because Qodo is otherwise the reliable reviewer here.

## The seat trial

| Lane | Seat | Outcome |
|---|---|---|
| W2b, W2b1 | `opencode/big-pickle` | **Two silent no-ops**, exit `0`, nothing committed. The second made two reads and one shell call, then spent 31,974 reasoning tokens against 26 output tokens and stopped on `"reason":"length"`. |
| W2b1, W2b2 + three fix rounds | `agy gemini-3.8-flash-high` | Every lane and every round committed. Ten verified defects fixed across the rounds. |

The brief did not change between the three attempts at W2b1 and sits inside the 2–3 deliverable
band that has always shipped, so **this is a seat difference rather than a brief-size one** — the
first case where that can be said cleanly. Still one lane.

trial index: 4

## What the plan left undone

- **V4** (the class-disposition tool) was "whenever convenient" and has not been built. Disposals
  were done by hand.
- **V2 was withdrawn on evidence**, not deferred: the instruction block already demands a concrete
  failure scenario and already prefers silence, and produced mechanism-shaped falsehoods anyway.
- **V3 is open by design** and needs a full wave before its arithmetic decides anything.

## Two things worth carrying forward

**A guard can be pinned by a run-level failure rather than a test.** Removing the stream's error
handler leaves every named test in the file passing, and the run still exits `1` on an unhandled
`EISDIR`. I first read that mutation as surviving because I grepped for failing test names and
never looked at the exit code — the sixth misfire of the session, and a class the V5 rule did not
cover until this record's companion commit. A future vitest config that ignores unhandled errors
would silence that pin without any test turning red.

**One test's name overstates what it checks.** *"at a narrow width every toolbar control is still
reachable"* asserts that `flex-wrap` is `wrap` and that the buttons exist. It would pass at any
width, because happy-dom performs no layout. The fix behind it is right and the rule is pinned;
the coverage of actual clipping is not there and should not be counted.

## Next

**L8b** in `2026-09-08_creative-templates-and-units.md` — the occlusion guards (D135/D136), the
move control, and the run key. A different plan and a different arc; it needs its own go-ahead.
