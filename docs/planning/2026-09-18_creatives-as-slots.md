# Creatives as slots — a durable identity for a drawn creative

**Date:** 2026-09-18
**Status:** **COMPLETE.** SL0–SL4 shipped (#496, #497, #500, #504, #506). SL-D2 stamped option (a). **SL5 dropped by the owner and SL-D8 withdrawn** — the rename is not wanted.
**Supersedes:** `2026-09-17_creatives-as-a-list.md` §6's two options. That note's CL-D10 ("occupied-set planning") survives and is adopted here as **SL-D4**.
**Related:** `2026-09-17_wireframe-gap.md` (SG-D7, the exhaustive-draw proof), `2026-09-18_projection-drop-measurement.md`.

## 0. What the owner asked for

> _"1. User selects static or motion 2. Clicks create then > User is presented with the editor for the 1st creative. 2a. The creatives are listed in the left sidebar. 2b. Clicking through the various creatives updates the editor to that instance of the creative… User should be able to add and delete the creatives. Clicking the creative loads the creative. Before loading a new creative on user-click, the current creative should be saved/preserved."_

and, separately:

> _"The variable should be more descriptive of what it is. The minimum should be 1. A user should be able to generate just a single final output creative if they wish."_

Four asks: **list**, **click-to-load**, **add/delete**, and **`minDistance` renamed with a floor of 1**. Only the first two are expressible today.

## 1. What the code does today — measured, not recalled

A brief is a **recipe**. Creatives are derived from it, two ways:

| Mode              | Cells                                                                                  | An emitted asset's key                                                        |
| ----------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `brief` (classic) | `products × canvas × treatments`, canvas being a social ratio or a display size (D113) | `` `${productId}/${assetCanvas(a)}/${a.treatment}` `` — **content-addressed** |
| `variation`       | a seeded sampled draw over the `DISTANCE_AXES`, accepted under a Hamming `minDistance` | `` `${productId}/v${a.variantIndex}` `` — **slot-addressed**                  |

**The domain already states the identity model**, `Variant.ts:7-12`:

> _"Identity in variation mode is `productId` + `index`. `seed` is provenance. `treatment` is not stored: use `variantTreatmentId`."_

Three facts that follow, each verified:

- **`index` compacts.** `PlanVariationsUseCase.use-case.ts:85` — `const index = accepted.length`. Delete a creative, replan the same `count`, and that index is **reborn**, with the same `seedFrom(brief.id, String(index), "0")`. _This is the whole of the recreate-on-delete problem._ It is a compaction artifact, not a property of drawing.
- **Nothing persists a plan.** A `VariationPlan` appears in no outbound port and no API route — it is derived on every run. So occupancy has nowhere to live today.
- **Re-roll is the existence proof that identity is a slot.** `replan(plan, index, attempt)` keeps the index, redraws the axes, and restamps `seedFrom(briefId, index, attempt)`. `regenerateOnly` targets cells "by the same identity the review UI keys on" (`GenerateCampaignUseCase.use-case.ts:296-302`).

## 2. The proposal that was considered and rejected — recorded because it was nearly adopted

The owner asked whether the brief could **parent creatives the way it parents treatments and aspect ratios**. The orchestrator's answer was: yes, by making the **axis tuple** the address and deriving the seed from it instead of from the index, with a sparse override map keyed by coordinate (exclusion = delete, pin = add, non-matching override = orphaned).

**It was refuted on review, and the refutation is the more useful artifact.** Five reasons, in order of weight:

1. **It does not achieve its own goal.** The axes come from a _single sequential RNG consumed per candidate_, not per accept (`:75`, `:88`). Making the background seed coordinate-stable makes a given point always _look_ the same; it does not stop the other rows moving. Exclude a point and re-run and the accept path changes, `minDistance` neighbourhoods reopen, coverage re-ranks, and the remaining rows reshuffle regardless.
2. **Classic's address is not a coordinate of a draw — it is a coordinate of _named inputs_.** `Treatment.id` is authored by the operator. An axis tuple is the _output_ of a sample. Parenting a sampled point onto itself is selector semantics applied to a generator.
3. **Delete is cardinality, not a ban on a point in the space.** An operator who deleted one bad background did not mean _never emit `headline-top`+`bold`+`procedural`+`0.1` again_.
4. **Orphaning is a landmine rather than graceful degradation.** An orphaned _exclusion_ does nothing until a later draw happens to hit that tuple, then fires. And identity-is-the-look means **editing a creative's look moves its id** — the opposite of a durable sidebar row.
5. **`minDistance: 0` is legal and operator-reachable**, so duplicate tuples exist and are distinct images _only because seeds are index-derived_. Coordinate-addressing collapses two slots to one key **and** one PNG, so the address cannot be adopted without forbidding Hamming 0 — an identity invariant smuggled in as a rename.

Also: a hash-as-address is a **filesystem** problem before it is a legibility one — `SAFE_ID_PATTERN` governs ids that become path segments, and CL-D3 already rejected this.

**And the decisive economy:** an override map keyed by coordinate **is** the list of creatives, with a worse key. It costs a forced golden re-record (every existing variation PNG changes) and does not deliver add/delete.

## 3. The adopted shape — holey monotonic slots

**Keep the recipe. Keep index-derived seeds. Stop compacting the index.**

| Gesture                  | Mechanism                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| **list / click-to-load** | read the planned variants; no persistence needed                                                       |
| **delete**               | tombstone that slot. Remaining rows keep their `index`, `seed`, axes and asset path `…/v${index}.png`  |
| **add**                  | allocate `nextIndex` (monotonic, never reused) and draw **one** candidate against the **occupied** set |
| **re-roll**              | unchanged — `replan` already keeps the slot and restamps from `attempt`                                |

No seed migration. No golden re-record. No rewrite of `regenerateOnly`. No literal authored list of creatives.

## 4. Decisions

| ID        | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **SL-D1** | **Identity is the slot (`productId` + `index`), not the axis tuple.** Recorded with §2's refutation so the coordinate idea is not re-proposed from scratch. `Variant.ts:10` already said so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **proposed**                                   |
| **SL-D2** | **Where occupancy lives.** A delete must survive a save, a reload and a second operator, so it cannot be client-ephemeral (unlike D139's selection or D147's zoom). Options: **(a)** the brief gains occupancy — `nextIndex` plus tombstoned indices — making it a document property the operator saves; **(b)** persist the `VariationPlan` behind a new port. **(a) is recommended**: the brief is already the thing that is saved and versioned, and (b) introduces storage for a value the brief can carry. **Stamped (a) by the owner, 2026-09-18.** The brief is already the thing that is saved, versioned and handed between operators, so occupancy belongs in it; persisting a plan behind a new port would introduce storage for a value the document can carry. | **STAMPED — (a), the brief carries occupancy** |
| **SL-D3** | **A deleted index is never reused.** Monotonic allocation is the entire fix for recreate-on-delete; compaction (`:85`) is the bug.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **proposed**                                   |
| **SL-D4** | **Append draws against occupants** — adopted from CL-D10. `conflicts(a, b, minDistance)` (`PlanCapacity.ts:69`) already takes pairs; the use case never calls it, planning a _fresh_ set instead. Appending one creative to eleven must distance against the eleven.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **proposed**                                   |
| **SL-D5** | **`count` becomes the recipe's target cardinality; occupancy is what exists.** They diverge the moment a slot is tombstoned, and the UI must show the second. A run generates the occupied slots, not `count` fresh draws.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **proposed**                                   |
| **SL-D6** | **`minDistance` is floored at 1, in both sites** — `meetsMinDistance` **and** `conflicts`. Independent of identity; it is SG-D7's finding and closes a live hole where the draw samples with replacement (83 of 120 distinct, operator-reachable through the Advanced stepper's `min={0}` with no warning). Flooring only `meetsMinDistance` leaves the suite **green** while distinct collapses to 1 of 120 — measured.                                                                                                                                                                                                                                                                                                                                                    | **proposed, and shippable alone**              |
| **SL-D7** | **`minDistance` is demoted to a generator control** — it governs append and re-roll against occupants, and is not a runtime invariant over an editable list. A global Hamming floor over rows the operator can edit fights the operator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **proposed**                                   |
| **SL-D8** | ~~**The rename waits for the demotion.**~~ **WITHDRAWN by the owner, 2026-09-18.** SL-D7's demotion was verified real — the draw distances against history and `replan` against live occupants, so `minDistance` is a generator control and the rename would have been honest. The owner dropped it anyway once the floor of 1 (SL-D6) had shipped, which is the half that fixed a defect; the rename is cosmetic and carries a migration obligation, since `minDistance` is a persisted YAML key in briefs this repo never sees. **Do not re-propose it.**                                                                                                                                                                                                                 |
| **SL-D9** | **Seeds stay index-derived.** Moving them buys "same tuple ⇒ same background" at the price of changing every existing variation PNG, and does not deliver add/delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **proposed**                                   |

## 5. Findings

| ID     | Sev      | Finding                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1** | **High** | **A bounds check assumes contiguous indices.** `GenerateCampaignUseCase.use-case.ts:585` rejects a target when `target.variantIndex >= plan.variants.length`. With holes that is wrong by construction: slots `0,1,3` give `length 3`, so re-rolling slot 3 would be refused. **This is the one existing line that holes break**, and it must be fixed in the same change that introduces them.       |
| **H2** | **High** | **`minDistance: 0` samples with replacement, silently.** SG-D7 measured 83 of 120 distinct at the ceiling. Reachable through the stepper's `min={0}` with no notice. SL-D6 closes it.                                                                                                                                                                                                                 |
| **M1** | Medium   | **A mixed `static`+`motion` brief overcounts its own ceiling** — `VariationPolicy.vo.ts:271` and `editor-state.ts:707` multiply the motion factor across every ratio while `enumerateAxes` only enumerates over `motionRatios` (48 vs a real space of 32), so `count` at the slider maximum is unplannable. Refused loudly, not silent. Independent of this plan; recorded so it is not rediscovered. |
| **M2** | Medium   | **Nothing persists a plan today**, so SL-D2 is not a preference but a prerequisite.                                                                                                                                                                                                                                                                                                                   |
| **L1** | Low      | `variantTreatmentId()` = `` `${layout}-${tone}` `` is a _display_ label and collides across the full axis space. Safe as a label; never an identity. Worth a comment saying so.                                                                                                                                                                                                                       |

## 6. Lanes

| Lane    | Owns                                                               | Depends on | Ships                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SL0** | `validate.ts`, `PlanVariationsUseCase`, `PlanCapacity`             | —          | **SL-D6 alone.** Floor `minDistance` at 1 in both sites, with the stepper's minimum raised to match and a test at the ceiling. **Dispatchable now**; nothing else waits on it. |
| **SL1** | `VariationPolicy.vo.ts` / the brief schema, `parseBrief`           | **SL-D2**  | Occupancy in the document: `nextIndex` + tombstones, with round-trip and back-compat for briefs that carry neither.                                                            |
| **SL2** | `PlanVariationsUseCase`, `PlanCapacity`, `GenerateCampaignUseCase` | SL1        | Monotonic allocation, append-against-occupants (SL-D4), and **H1's bounds fix**.                                                                                               |
| **SL3** | `BriefEditor.tsx`, the left sidebar                                | SL1        | The list, click-to-load, and save-the-current-before-loading-the-next. Read-only over occupancy.                                                                               |
| **SL4** | as SL3                                                             | SL2, SL3   | Add and delete wired to the gestures.                                                                                                                                          |
| ~~SL5~~ | —                                                                  | —          | **DROPPED by the owner, 2026-09-18** (SL-D8 withdrawn). The floor of 1 shipped in SL0; the rename did not, and is not wanted.                                                  |

## 7. Definition of done

- Deleting a creative and re-running leaves the **other** creatives byte-identical — the property the coordinate proposal could not deliver. Asserted on emitted asset keys and on seeds, not on a screenshot.
- A deleted index is never re-issued: add after delete allocates a **new** index, and the tombstoned asset path is not overwritten.
- Appending one creative to an existing set distances against the occupants, and a request that cannot satisfy `minDistance` is refused **loudly**, naming the shortfall.
- Re-roll still works **on a holey set** — H1's bounds check no longer refuses a valid high index.
- `minDistance` cannot be set to 0 from the UI, and the draw at `count = axisProductSize` enumerates the space exactly once (SG-D7's property, retained).
- A brief saved before SL1 loads without occupancy and behaves as it does today.

## 8. Premise

**`premise SL` retired: SL2 shipped.** The fence asserted that `index` still
compacts, so a deleted creative is reborn with its old seed — and it probed for
that by grepping `const index = accepted.length` in
`PlanVariationsUseCase.use-case.ts`. Both halves are now false. The line is gone:
the index comes from an explicit allocation cursor over `[0, occupancy.nextIndex)`,
and what the draw accumulates is no longer the emitted set but the **allocation
history**, renamed accordingly, because it now retains tombstoned slots that are
drawn and never emitted. The fence would report the lane stale rather than live.

What replaced it is stronger than the grep was, and is the reason the grep was
only ever a proxy: the property is **deleting a creative leaves the others
byte-identical**, and it is asserted as `toEqual` over the whole surviving
`Variant` objects — axes included — for a plain brief and for one whose plan came
from the exhaustive search (`PlanVariationsUseCase.use-case.test.ts`, "monotonic
slots (SL2)"). Seeds and asset keys are asserted too, but only alongside: both are
index-derived, so they survive a wrong allocation scheme that keeps the index and
moves the axes, which is exactly the near-miss design this lane had to reject.

## 9. What this plan does not do

- **It does not make the brief a literal list of creatives.** If the operator must hand-edit one row's axes, that is the list, and this plan does not pretend otherwise — it would be a further decision, not an extension.
- **It does not move the seed.** SL-D9.
- **It does not rename `minDistance` yet.** SL-D8.
- **SL-D2 is stamped**, so SL1–SL5 are dispatchable in dependency order. **SL0 went first** — it is independent and is the lane the owner asked for twice.
