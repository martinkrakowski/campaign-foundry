# Wave Status as a Command Monitor — Architecture & Development Plan

**Date:** 2026-09-11 · **Owner request:** make the page readable at a glance; add *hide inactive*;
answer whether old waves ever expire.

The page today is an accurate **dump of fields**. It is not yet an instrument. A developer arriving
mid-wave has to read seven columns per lane and hold the decision rules in their head. This plan
does not add data — every signal below is already collected — it changes what the page *concludes*.

---

## 1. The question that was asked: do old waves expire?

**No. Nothing in this codebase ever removes a wave from the list.**

`WAVE_LOG_ROOT = "/tmp"`, and `collectStatus` lists every directory under it whose name starts with
`wave`. There is no retention window, no cap, no pruning, and no archive. A wave leaves the list only
when something outside the application deletes its directory — in practice an OS clear of `/tmp`
(typically at reboot; **no periodic `/tmp` cleaner is installed on this machine**, so it is not
happening on a daily schedule here) or a manual `rm`.

Two consequences, and they pull in opposite directions:

- **The list grows without bound** across a long session, and old waves crowd out the one being run.
- **History disappears unpredictably** — a reboot silently takes every wave record with it, including
  the evidence a wave record is supposed to preserve.

**Recommended default (F1):** do not add an expiry. Add **age** to the wave header and sort newest
first, so an old wave is visibly old rather than merely lower down; combine with *hide inactive* so
the default view is the work in flight. **Deleting a developer's only copy of a wave's logs on a
timer is a worse failure than a long list.**

**Recommended default (F2), separately:** move `WAVE_LOG_ROOT` off `/tmp` to a durable path.
This is a **behaviour change with a blast radius** — `dispatch-lane.sh`, `wave-event.sh` and every
brief that names a log path — so it is listed as its own lane, not folded into the UI work.

---

## 2. Findings

| Sev | Finding |
|---|---|
| **C1** | **`.active` does not mean "running" — it means "selected".** It is the highlight for the row whose log is open in the pane (`activeWave`/`activeLane`). A reader scanning for liveness finds a class named `active` on exactly one row and reasonably concludes that row is the live one. This is the specific confusion the owner reported, and it is a naming defect, not a missing feature. |
| **C2** | **No lane carries a single verdict.** The page shows `stage`, `liveness`, `log`, `pr · checks`, `gate`, `findings` and leaves the reader to combine them. The combination rules are fixed and known — so the page should apply them. |
| **H1** | **Nothing shows time.** `log.mtimeMs` is collected and never displayed. *When did this last do anything* is the first question about a running lane and the page cannot answer it. |
| **H2** | **A stalled lane is indistinguishable from a working one.** `alive: true` with a log that has not grown in twenty minutes renders exactly like healthy progress. The data to tell them apart is already present. |
| **H3** | **No roll-up.** There is no count of what is running, blocked, or finished — at either wave or page level. A command monitor answers *how many need me* before it answers anything else. |
| **M1** | **`disagreements` is the page's whole thesis and is rendered as just another column.** A conflict between what a lane *reported* and what was *derived* is the highest-value signal here and should outrank everything on the row. |
| **M2** | **No *hide inactive*.** Requested directly. |
| **L1** | Wave order is server order; age is not shown. |

---

## 3. The one idea: derive a lane state, then render it

Every rule below is already computable from `LaneStatus`. None needs new collection.

| State | Rule (first match wins) | Reads as |
|---|---|---|
| **conflict** | `disagreements.length > 0` | *report and reality differ — look here first* |
| **failed** | `derived.exit` non-zero, or `gate.exit` non-zero, or `pr.checks === "fail"` | needs a fix round |
| **stalled** | `alive` **and** `log.mtimeMs` older than the stall threshold | alive but not working |
| **running** | `alive` | working |
| **vanished** | not `alive`, no `exit`, no PR | died without finishing — the silent no-op |
| **blocked** | PR open and `checks === "pending"` | waiting on CI |
| **ready** | PR open and `checks === "pass"` | mergeable |
| **merged** | `pr.state === "merged"` | done |

**`conflict` outranks `failed` deliberately.** A lane that reports success while the derived status
says otherwise is worse than a lane that failed honestly, because it is the one a human would
otherwise skip. This ordering is the page's reason to exist expressed as a sort key.

The stall threshold is a **decision, not an inference** — lanes legitimately go quiet for minutes
during a build. **Recommended default: 15 minutes**, named as a constant with the reasoning beside
it, and shown in the UI as *"quiet 22m"* rather than as an accusation.

---

## 4. Lanes

| Lane | Task | Proof |
|---|---|---|
| **W1** | **Derive the state.** A pure function `laneState(status): LaneState` in `lib/`, plus the relative-time formatter. No UI. | A table test per state, including the precedence pairs (`conflict` over `failed`, `stalled` over `running`). Mutating the precedence order reds a test. |
| **W2** | **Render it.** One status cell per lane leading the row, colour **and** text (never colour alone), with *quiet Nm* on running lanes. Rename `.active` → `.selected` (C1). | The palette guard still passes; a row renders its state without the reader consulting another column. |
| **W3** | **Roll up and filter.** Per-wave counts in the wave header, a page-level summary bar, and the **hide inactive** toggle (M2). | Counts equal the rows they summarise — asserted against the same fixture, so they cannot drift. Toggle state survives a refresh. |
| **W4** | **Age and order** (L1, F1). Wave header shows age; newest first. | Assert order with waves collapsed — the state the sort defect hid in last time. |
| **W5** | **`WAVE_LOG_ROOT` off `/tmp`** (F2). Separate, because it touches the dispatcher and every brief that names a log path. | Existing waves still collected; `dispatch-lane.sh` and `wave-event.sh` agree with the server on one path. |

**W1 before W2/W3** — both consume the derived state, and two lanes inventing it separately is how
the counts and the rows come to disagree. **W5 is independent** and must not be bundled.

---

## 5. What this plan refuses

- **It does not add an expiry timer.** See F1 — silent deletion of a developer's only log copy is the
  worse failure.
- **It does not add auto-refresh polling beyond what exists.** The follow control already covers it.
- **It does not add new collection.** Every signal is present; the defect is that nothing concludes
  from it. A plan that starts by gathering more data would be avoiding the actual problem.
- **It does not colour-code by seat or model.** Interesting for the trial, irrelevant to *what needs
  me now*, and it would spend the one visual channel that matters on a question nobody asks mid-wave.

---

## 6. Definition of done

- A developer can answer *what needs me*, *what is moving*, and *what is stuck* from the top of the
  page without scrolling or opening a log.
- Every state is legible without colour.
- `hide inactive` leaves exactly the lanes that are running, stalled, conflicted or failed.
- The wave list makes an old wave look old.
- Full gate green, all four counters at 100 %, and the stall threshold has a test that fails if the
  constant changes meaning.

---

## 7. Premises

Each lane states the claim that makes it necessary, as a script that exits 0 **while the gap is still
open**. `yarn plan:verify` runs them. A non-zero exit means the gap has been closed by something else
and the lane would re-implement shipped behaviour — which happened three times in one day before this
existed, because nothing could tell a live lane from a finished one.

**W1 — shipped in #337.** `laneState` derives the state and `plan:verify` no longer tracks
it. The premise was retired as part of merging, which is the rule: a premise left behind after its
lane ships turns the check into noise.

```premise W2
grep -q "tr.lane.active" tools/wave-status/public/index.html
```

```premise W3
! grep -q "hide-inactive" tools/wave-status/public/index.html
```

**W4 — shipped in #340.** Its premise was retired late, and the delay is the lesson: it grepped
for the collector's lexicographic `.sort()`, and #340 **kept** that call as the stable base the
recency sort orders on top of. The string survived the fix, so the premise went on reporting a
shipped lane as live. **Probe the thing that decides, not a string near it** — the same correction
X1 and X2 needed in #338.

```premise W5
grep -q 'WAVE_LOG_ROOT = "/tmp"' tools/wave-status/lib/collect.ts
```
