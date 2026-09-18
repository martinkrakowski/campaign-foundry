# How often does the projection actually drop a valid field?

**Date:** 2026-09-18
**Status:** **measurement complete — one recommendation open for the owner (PD-D1).** This lane ships no product code.
**Verified against:** `origin/main` at `43e5fc2e`.
**Lane:** **SG5**, the first task under **SG-D8** of `2026-09-17_wireframe-gap.md`. SG5 gates **SG6** and nothing else.
**Related:** `2026-09-17_wireframe-gap.md` §8.4 (why the validation gate is not keyed on the projection), `apps/web/src/components/campaign/__tests__/editor-state.validation-gate.test.ts` (the Video-in-a-classic-draft case SG9 constructed).

---

## 0. The question, and the shape of the answer

SG-D8(i) asks for a **per-field inline projection notice**: *"the value is fine, it did not reach
the document."* SG5's job is to find out whether such a notice would ever fire, and on how many
fields — because *"a mapping that detects nothing is worse than no mapping."*

The answer is **not "never"**, so SG6 is not deleted outright. But it is close enough to "never" that
**SG6 as specified should not be built.** The measured numbers:

| | |
|---|---|
| Conditional writes and omissions enumerated (`toBrief` + the six helpers it calls) | **36** |
| …of which the omission is **lossless** — the absent key means exactly the value that was omitted | **26** |
| …**unreachable** through the UI as it ships | **1** |
| …**validation-gated** — the state is reachable, but `refuseInvalid` blocks Save so nothing reaches a document | **6** |
| …**reachable and silent** — the operator types a valid value, the field accepts it, nothing says a word, and it never reaches the document | **3** |
| …distinct **controls** those 3 attach to | **2** |
| …distinct controls after **SG-D1** (stamped: `mode` retired) | **1** |

**One control.** That is the whole finding. The per-field mapping SG-D8(i) describes — a projection
read wired into `validate.ts` and every field component, riding the `aria-describedby` rail — would
be built to serve a single `<fieldset>`, and the codebase **already has the pattern for exactly that
case**, hand-written, four lines long, at `ModePanel.tsx:243`.

---

## 1. Method, and what "operator could have entered it" means

Three things had to be true for a row to count as **reachable**:

1. **A control exists** that writes the value, and it is **rendered and enabled** while the dropping
   condition holds. A field that cannot be set while the condition holds is not a drop the operator
   can hit. This is the distinction the whole measurement turns on — without it the list is a code
   reading, not a measurement.
2. **The value survives to `toBrief`** — the reducer does not clear it when the condition arrives.
   Checked in the reducer, not taken from a docblock: `state.timeline` is written by exactly six
   branches (`:1526`, `:1554`, `:1560`, `:1581`, `:1593`, `:1598` — all of them beat edits).
   `toggleFormat` (`:1765`) and `toggleHeadline` (`:1678`, which writes `variation.headline` and
   nothing else) never touch it, and `setMode` (`:1154`) only sets `mode`. So R1, R2 and R3 all
   rest on a verified invariant.
3. **Nothing says so.** A drop that Save refuses, or that a `role="status"` line already announces,
   is not a missing notice. It is a notice that already exists.

Every row below was settled by reading the control, the reducer branch and `validate.ts` — not by
inference from `toBrief` alone. Where a path could not be settled by reading, it is marked
**UNREACHABLE with its evidence stated**, and says exactly what would make it reachable rather than leaving the label to stand on its own. (There is one such row: §3.4.)

**No test file was written** — this lane ships no code, and §3 gives the reproduction for the
reachable rows precisely enough that SG6's implementer can write the tests instead. The one
execution in this lane was read-only and against an **existing** file:
`yarn vitest run apps/web/src/components/campaign/__tests__/editor-state.validation-gate.test.ts`
— 4 passed, 1.20s, exit 0 — which is the file finding **L2** annotates. Everything else in this
document is settled by reading, and §9 says so.

---

## 2. The enumeration

Every conditional write and structural omission, by line. `toBrief` is
`apps/web/src/components/campaign/editor-state.ts:2103`.

**Class:** **LOSSLESS** (absent key ≡ the omitted value) · **UNREACHABLE** (no UI path to the state)
· **GATED** (reachable, but Save is refused or a notice already speaks) · **REACHABLE** (silent
loss of an operator-entered value).

### 2.1 `toBrief`'s own body — 25 conditional writes + 1 structural omission

| # | Line | Key | Dropped / narrowed when | Class | Why |
|---|---|---|---|---|---|
| 1 | `:2139` | `style` | `briefStyle()` is `undefined` | **LOSSLESS** | See #27 — the predicate covers **all seven** fields of `Style`. |
| 2 | `:2140` | `mode` | `mode === "brief" && !modeExplicit` | **LOSSLESS** | Absent ≡ `"brief"` at the parser. The key is omitted only when it would restate the default. |
| 3 | `:2145` | `type` | `type === DEFAULT_CAMPAIGN_TYPE && !typeExplicit` | **LOSSLESS** | Same rule (D112). |
| 4 | `:2146` | `output` (whole block) | `!outputExplicit && isDefaultOutput(state)` | **LOSSLESS** | See #31 — the predicate is "equals the absent-key default", by construction. |
| 5 | `:2153` | `output.sizes` | `sizes.length === 0` — and the whole block goes with #4 | **UNREACHABLE** | §3.4. No `toggleSize` action exists (`:397`), and the three `STATIC_PLATFORMS` carry no `sizes`. |
| 6 | `:2159` | `localizedMessage` | `.trim() === ""` | **LOSSLESS** | Whitespace-only is not a localised message. |
| 7 | `:2169` | `copy.timeline` (whole block) | `!canSerializeTimeline(state) \|\| beats.length === 0` | **REACHABLE** | **§3.1 and §3.2.** The two live rows. |
| 8 | `:2177` | `beat.background` | `!isNamedBackground(beat.background)` | **LOSSLESS** | See #34 — `""` and non-strings are the parser's spelling of "no background". |
| 9 | `:2184` | `copy` (block) | no timeline **and** `!copyExplicit` | **LOSSLESS** | An empty `copy: {}` says nothing an absent key does not; `copyExplicit` preserves a declared one. |
| 10 | `:2193` | `audio` | `state.audio === undefined` | **LOSSLESS** | No control authors it (VE3a/D11); present blocks ride through verbatim. |
| 11 | `:2196` | `treatments` | `mode === "brief" && treatments.length === 0` | **LOSSLESS** | An empty list is "no treatments", which is what the absent key means. |
| 12 | `:2200` | `clickDestination` (classic) | `.trim() === ""` | **LOSSLESS** | As #6. |
| 13 | `:2204` | `variation.count` | unparseable ⇒ **substituted with `0`** | **GATED** | §4.2 — a **substitution**, not an omission. `validate.ts:306` requires ≥ 1, so Save is refused. |
| 14 | `:2248` | `variation.seed` | `parsePolicyInteger` returns `undefined` | **GATED** | Blank ⇒ absent ≡ `seedFrom(brief.id)`. Unparseable ⇒ `validate.ts:309` errors, Save refused. |
| 15 | `:2249` | `variation.minDistance` | same | **GATED** | Same, via `validate.ts:313`. |
| 16 | `:2213` | `coverage.perProduct` | `undefined \|\| <= 0` | **LOSSLESS** | `VariationPolicy.vo.ts:144` reads `variation.coverage?.perProduct ?? 0` — absent **is** 0. But see §4.4. |
| 17 | `:2214` | `coverage.perRatio` | same | **LOSSLESS** | `VariationPolicy.vo.ts:150`, same default. See §4.4. |
| 18 | `:2217` | `coverage` (block) | both of #16/#17 dropped | **LOSSLESS** | Follows its two members. |
| 19 | `:2229` | `axes.anchor` | `!anchorAxisActive(state)` | **LOSSLESS** | See #33 — dropped only when the selection **equals** what the absent axis derives (D57). |
| 20 | `:2233` | `axes.ratio` | `ratio.length === RATIO_OPTIONS.length` | **LOSSLESS** | Absent ≡ every ratio. Dropped only when the selection is every ratio. |
| 21 | `:2238` | `axes.headline` | `!variation.headline` | **LOSSLESS** | Absent ≡ off; the key is a marker, not a value. |
| 22 | `:2241` | `axes.motion` | `motion.length === 0` | **LOSSLESS** | Empty is "no kinds"; `validate.ts:483` blocks an empty axis with Video on. |
| 23 | `:2242` | `axes.duration` | `duration.length === 0` | **LOSSLESS** | Same. |
| 24 | `:2253` | `copy` (variation branch) | as #9 | **LOSSLESS** | — |
| 25 | `:2254` | `clickDestination` (variation) | as #6 | **LOSSLESS** | — |
| 26 | `:2245` | **`treatments`, structurally** | `mode === "variation"` — the branch spreads `withLocalized`, never `withTreatments` | **REACHABLE** | **§3.3.** Not a conditional write at all: the key has no code path in this branch. |

### 2.2 The six helpers `toBrief` calls — 10 more sites

| # | Line | Helper | Condition | Class |
|---|---|---|---|---|
| 27 | `:2034` | `briefStyle` | `!styleExplicit && !styleDiverges(style)` | **LOSSLESS** — §4.5 |
| 28 | `:2050` | `serialisedFormats` | `mode !== "brief"` ⇒ passthrough | **LOSSLESS** (no drop) |
| 29 | `:2053` | `serialisedFormats` | motion dropped **and** the list would be empty ⇒ **substituted with `["static"]`** | **GATED** — §4.1 |
| 30 | `:2054` | `serialisedFormats` | `"motion"` filtered out of a classic brief (D99) | **GATED** — §4.1 |
| 31 | `:2063` | `isDefaultOutput` | formats `=== ["static"]` **and** platforms `=== STATIC_PLATFORMS` | **LOSSLESS**; but see §4.3 — it does **not** read `sizes` |
| 32 | `:2020` | `canSerializeTimeline` | `mode !== "variation"` ‖ no `"motion"` format ‖ `variation.headline` | **REACHABLE** ×2 — §3.1, §3.2 (the mode conjunct is GATED, §4.1) |
| 33 | `:659` | `anchorAxisActive` | `!anchorExplicit && isDerivedAnchorSelection(...)` | **LOSSLESS** |
| 34 | `:2100` | `isNamedBackground` | not a non-empty string | **LOSSLESS** |
| 35 | `:1999` | `toProduct` | `inputAsset.trim() === ""` | **LOSSLESS** |
| 36 | `:2083` | `parsePolicyInteger` | not a plain (optionally exponent) integer ⇒ `undefined` | **GATED** — shared with `validate.ts` by X18, so the two can never disagree |

`toProduct` (`:1991`) and `toTreatment` (`:2002`) were checked for **unconditional** narrowing as
well: `toProduct` writes every field of the domain `Product` and drops only `key` and `idTouched`
(React bookkeeping); `toTreatment` writes all three fields of `TreatmentDraft`. Neither loses an
authored value.

---

## 3. The reachable set — 3 rows, 2 controls

### 3.1 R1 — the copy sequence, in a Randomized draft with Video off

**The strongest row, and the only one that survives every stamped decision.**

`CopySection.tsx:188` renders the copy-timeline sub-panel on **one** condition: `state.mode ===
"variation"`. It does **not** consult `canSerializeTimeline`. `canSerializeTimeline` is referenced
by exactly one file in the tree — `editor-state.ts`, inside `toBrief` — so **no component anywhere
knows whether the timeline it is editing will be saved**.

`TimelineSection` is fully functional in a static Randomized draft: `timelineDurations`
(`:800`) falls back to `DEFAULT_DURATION` when `state.duration` is empty, so the proportion bar
renders, *Add beat* is enabled (`addBeatBlockedBy` blocks only on `MAX_BEATS` and the dwell floor —
never on serialisability), and every beat control works.

`validateTimeline` (`validate.ts:202`) then **validates the beats** — weights, key beat, scene
count, the dwell floor — and can block Save on a beat error. It never once says the beats will not
be written. The operator authors a sequence, is told its weights are wrong, fixes them, is told the
draft is valid, saves, and the sequence is not in the file.

**Reproduction.** A brief in Randomized mode with `output.formats: ["static"]`:

1. Create or load a Randomized (`mode: "variation"`) brief with Video **off**.
2. Copy → *Copy sequence*. Press **Add beat** twice; type text into both.
3. `validateState(state)` reports **0 errors**.
4. `toBrief(state).copy` is **`undefined`** — `canSerializeTimeline` is false on its
   `formats.includes("motion")` conjunct.
5. Save. Reload. The beats are gone, and nothing at any point said so.

### 3.2 R2 — the copy sequence, with the headline pool axis on

Same control, third conjunct. `canSerializeTimeline` also requires `!state.variation.headline`.
The headline switch is `PolicySection.tsx:291` (`SwitchRow`, label `pool://copy`). It is disabled
only when the pool has nothing approved — never because a timeline exists.

`validate.ts` contains **no rule at all** relating `variation.headline` to the timeline: the only
occurrence of `headline` in the file is `:80`, an axis **count** for the minDistance ceiling.

**Reproduction.**

1. Randomized brief, Video **on**, two beats authored. `toBrief(state).copy.timeline` is present.
2. Variation Policy → switch **`pool://copy`** on.
3. `validateState(state)` gains **0 errors**.
4. `toBrief(state).copy` is now **`undefined`** — the whole authored sequence is gone from the
   projection, on a switch in a different section that says nothing about it.

R2 is the worse of the two to read, because the value was *previously reaching the document* and a
toggle elsewhere silently withdrew it.

### 3.3 R3 — treatments, after a Classic → Randomized flip

`TreatmentsSection` renders only in `brief` mode (`sections/index.ts:53` omits it from the variation
order). The operator authors treatments there. `ModePanel` flips the mode; `setMode` (`:1154`) is
deliberately non-destructive, so `state.treatments` survives. In the variation branch `toBrief`
spreads `withLocalized` — **`treatments` has no code path in that branch at all** (#26).

`validateTreatments` (`validate.ts:283`) returns early on `state.mode !== "brief"`, so nothing is
reported either.

**Reproduction.** Classic brief → Treatments → add a treatment → flip to **Randomized** → Save.
`toBrief(state).treatments` is absent; 0 errors; no notice. Flipping back restores the draft, so the
loss is only visible after a save-and-reload.

**R3 is scheduled to dissolve with SG-D1** (stamped: `mode` retired as an operator-facing concept),
because SG-D2 already records that *"`treatments` exists only in `brief` mode, so retiring `mode`
deletes that section outright."* **Finding M2 below records that SG-D1 is stamped but assigned to no
lane**, so R3 is live today and has no dated owner.

### 3.4 The one row I could not settle by reading alone — and what settles it

`output.sizes` (#5). It is dropped when the whole `output` block is dropped, and `isDefaultOutput`
(#31) **does not look at `sizes`**. So a state holding `sizes: ["728x90"]` with
`formats: ["static"]` and `platforms === STATIC_PLATFORMS` would lose the sizes silently.

Through the UI as it ships, **that state cannot be produced**, and three separate facts have to hold
for it to stay that way — all three verified:

- there is **no `toggleSize` action** (`editor-state.ts:397`: *"no UI asks for it yet"*), so `sizes`
  is only ever written by `togglePlatform` (`:1818`), `applyPreset` (`:1216`) and `fromBrief`;
- `togglePlatform` **filters `sizes` down to what the remaining platforms offer** on every removal,
  so removing the last display platform empties the list;
- the three `STATIC_PLATFORMS` (`instagram-feed`, `linkedin`, `x`) carry **no `sizes`** at all
  (`PlatformProfile.vo.ts:111–134`), so a default platform set can never contribute one.

**It is reachable exactly one way**, and it is not an operator path: a hand-edited
`cf:draft:<id>` entry in `localStorage`. `fromDraft` (`:2918`) filters restored `sizes` against
`DISPLAY_SIZE_VALUES` only — **not against the platforms** — and sets `outputExplicit: raw.outputExplicit === true`.
A draft carrying `sizes`, the three social platforms and `outputExplicit: false` restores into
precisely the losing state.

I am calling this **UNREACHABLE, not a defect** — but the label is a statement about today's
controls, not about the code. **What would settle it differently:** the moment any lane adds a size
control, or changes `togglePlatform` to stop filtering `sizes`, this becomes live. Recorded as
finding **M1** so that lane does not have to rediscover it.

---

## 4. Worse than a drop

Five things in this class. Two are substitutions, one is a validity change, one is an asymmetry, one
is a coverage gap in a predicate. **None is currently a live defect** — but three of them are one
change away from being one, and that is why they are listed separately rather than folded into §2.

### 4.1 Substitution, not omission: `serialisedFormats` writes `["static"]`

`:2053`. A Randomized draft with Video on and Still **off** (both reachable — `formatGate("static", …)`
is never gated), flipped to Classic, projects `output.formats: ["static"]` — **a format the operator
did not choose**, in a document they are about to save. That is categorically worse than an omission:
an absent key can be reasoned about, a substituted one cannot.

**It never reaches a document, and it is not silent**, which is why it is GATED and not REACHABLE:

- `validate.ts:481` errors `formatsMotionNeedsRandomizedMode` whenever `formats` holds `"motion"`
  outside variation mode. `BriefEditor.tsx:719` (`blockedAt`) and `:1556` (`handleSave` →
  `refuseInvalid`) mean **Save is refused**.
- `ModePanel.tsx:243` **already renders a projection notice for exactly this case** — a
  `role="status"` line, `messages.modeDroppedVideo`, fed by `BriefEditor.tsx:1214`
  (`state.mode === "brief" && state.formats.includes("motion")`), with the comment
  *"D99: the drop is not silent."*

**This is the precedent SG6 should follow, and the proof that the per-field machinery is not needed
to follow it.** It is four lines in the component that owns the control.

### 4.2 Substitution: `count = parsePolicyInteger(...) ?? 0`

`:2204`. An unparseable count becomes **`0`**, not absent — and `VariationPolicy.fromBrief`
(`:135`) rejects `count` below 1, so the projection would carry a number the domain refuses.
GATED: `validate.ts:306` requires ≥ 1 through the *same parser* (X18), so Save is refused first.
Note the asymmetry with its four siblings — `seed`, `minDistance`, `perProduct`, `perRatio` all
become **absent** on the same input; only `count` substitutes. The `?? 0` is load-bearing only for
TypeScript's benefit (`count` is required on `VariationPolicy`).

### 4.3 `isDefaultOutput` does not read `sizes`

§3.4. The predicate answers *"does the serialised output equal the absent-key default?"* while
ignoring one of the three keys that output block carries. It is correct today only because of a
reducer invariant in a different function (`togglePlatform`'s filter). **M1.**

### 4.4 The five policy integers do not treat `0` alike

`seed: 0` and `minDistance: 0` **are written** (`!== undefined`). `perProduct: 0` and `perRatio: 0`
are **dropped** (`> 0`). Validation accepts `0` for both (`isOptionalIntegerAtLeast(…, 0)` at
`validate.ts:316`), so an operator *can* type `0` into a coverage field and watch the key vanish.

**It is lossless today**, and I checked rather than assumed: `VariationPolicy.vo.ts:144` and `:150`
read `variation.coverage?.perProduct ?? 0` and `?? 0`, so absent **is** 0 at the only consumer.
Graded **M3** rather than dismissed, because the guarantee lives in a default two packages away from
the `> 0` that depends on it, and nothing ties them together.

### 4.5 The `letterSpacing` hypothesis in SG-D8 is refuted

SG-D8(i) motivates the per-field notice with *"a valid letter-spacing that the projection drops has
nothing to complain about and no row to be missing from."* **That case does not exist.**
`styleDiverges` (`creative-style.ts:258`) tests **all seven** fields of `Style` —
`fontFamily`, `fontWeight`, `sizeScale`, `lineHeight`, `letterSpacing`, `align`, `textEffect` — so
`briefStyle` drops a style block only when every field equals its default. A dropped
`letterSpacing` is `letterSpacing: 0`, which is `DEFAULT_STYLE.letterSpacing`; the rendered creative
is identical. Recorded because the example is the one the decision was argued from, and it should
not be re-argued from it.

---

## 5. Findings

| # | Severity | Finding |
|---|---|---|
| **H1** | **High** | **The copy-timeline sub-panel is the only control in the editor that silently loses authored work.** It renders on `mode === "variation"` alone (`CopySection.tsx:188`), while `toBrief` writes it on three further conditions (`canSerializeTimeline`, `:2020`). `canSerializeTimeline` is read by **no `.tsx` file in the tree**, so no component can know. `validate.ts` validates the beats it will not save and says nothing about not saving them. Two reachable routes (§3.1 Video off, §3.2 headline pool on), **both surviving SG-D1 and SG1.** This single `<fieldset>` is the entire justification for SG6. |
| **M1** | Medium | **`isDefaultOutput` ignores `sizes`, and only a reducer invariant in another function keeps that safe.** `:2063` compares formats and platforms; `output.sizes` rides along and is dropped with the block. Unreachable today only because `togglePlatform` (`:1818`) filters `sizes` on every platform removal and the three `STATIC_PLATFORMS` carry none. **The comment at `:397` — *"There is no `toggleSize` action this round — no UI asks for it yet"* — names the lane that will break this.** Whoever adds a size control must either add `sizes` to `isDefaultOutput` or set `outputExplicit` on a size edit. |
| **M2** | Medium | **SG-D1 is stamped and assigned to no lane.** `mode` is retired as an operator-facing concept by a stamped decision, and SG-D2 records that treatments dissolve with it — but the SG lane table names no owner for the retirement, and `ModePanel` still renders at `BriefEditor.tsx:1210` on `43e5fc2e`. (SG1 shipped and retired **`presentation`**, which is a different axis; `BriefEditor.tsx:110` records that collapse.) So **R3 (§3.3) is live with no dated owner**, and the "after SG-D1 it is one control" figure in §0 is a projection, not a schedule. |
| **M3** | Medium | **The five policy integers disagree about `0`** (§4.4). `seed`/`minDistance` write it; `perProduct`/`perRatio` drop it; `count` substitutes it. Lossless only because `VariationPolicy.fromBrief` defaults the coverage pair to `0` two packages away. |
| **L1** | Low | **SG-D8's motivating example is refuted** (§4.5). `styleDiverges` covers all seven `Style` fields; a dropped letter-spacing is always the default. |
| **L2** | Low | **`editor-state.validation-gate.test.ts:50` reaches its state by a route the UI refuses.** The test dispatches `toggleFormat: "motion"` on a classic draft; through the Output section that card is a **disabled `<button>`** (`FormatPanel.tsx:37-43` → `AxisCard` `axis-card.tsx:58`). The test is correct and its assertion is the right one — the operator route to the same state is *Randomized → Video on → flip to Classic*, which `validate.ts:476-480` documents in its own comment. Worth a one-line note in the test so the next reader does not conclude the card is clickable. |

---

## 6. PD-D1 — the recommendation on SG6

| ID | Question | Recommendation |
|---|---|---|
| **PD-D1** | **Build SG6 as SG-D8(i) specifies, narrow it, or retire it?** | **Narrow it to one notice on one control, and delete the per-field mapping.** |

**SG6 as written should not be built.** SG-D8(i) specifies a projection read wired into `validate.ts`
and *"the field components"*, riding the `aria-describedby` rail. The measurement says that machinery
would serve **one `<fieldset>`** — and after SG-D1, still one. A mapping across every field that
fires on one of them is the cost of the general case without the general case.

**SG6 should not be deleted either.** The plan's own retirement condition is *"if the answer is
never"*, and the answer is not never: §3.1 and §3.2 are two reachable routes by which an operator
authors a copy sequence, is told the draft is valid, saves, and loses the work — with no control, no
error, no warning and no `role="status"` line anywhere in the path. That is a real defect and it is
the exact thing SG-D8(i) was raised to catch.

**What to build instead — SG6′:**

| | |
|---|---|
| **Owns** | `TimelineSection.tsx`, `messages.ts` |
| **Depends on** | — (independent of SG-D1, SG1 and every other SG lane; it shares no file with them) |
| **Ships** | One `role="status"` line inside the copy-timeline `<fieldset>`, rendered when `state.timeline.beats.length > 0 && !canSerializeTimeline(state)`, naming **which** conjunct is false and how to undo it — Video is off, or the headline pool axis is on. Worded and built exactly like `ModePanel.tsx:243`'s `modeDroppedVideo`: muted, not an error, because the value is fine and did not reach the document. |
| **Does not ship** | Any change to `validate.ts`. This is not a validation error and must not be counted as one — `getTotalErrorCount` feeds `blockedAt`, and blocking Save on it would be wrong: a draft with unsaved beats is a *valid* draft. |
| **Definition of done** | With beats authored and Video off, the panel names the drop; turning Video on removes the line. Deleting either conjunct from the render condition — or the whole line — makes a test fail. The test asserts against `toBrief(state).copy` being `undefined`, not against the string, so the notice cannot drift from the projection it reports. |

**What to do about R3 (treatments).** Nothing in SG6′. Either SG-D1 gets a lane and deletes it, or
it stays. **Do not build a second notice for a control that a stamped decision deletes** — that is
the mapping-that-detects-nothing failure in a different costume. **M2 is the action item**, not a
notice.

```premise SG6
# H1: no component in the tree reads the projection's timeline gate, so no control
# can tell the operator their authored beats will not be saved. This flips the
# moment SG6' wires `canSerializeTimeline` into TimelineSection.tsx.
# Greps source, not a build — measured ~40 ms, well inside the 10s budget.
! grep -rqn 'canSerializeTimeline' apps/web/src --include='*.tsx' --exclude-dir=__tests__
```

---

## 7. Tasks

| Task | Owns | Depends on | Ships |
|---|---|---|---|
| **SG6′** | `TimelineSection.tsx`, `messages.ts` | — | The copy-sequence projection notice. §6. |
| **PD1** | `2026-09-17_wireframe-gap.md` | PD-D1 stamped | Rewrite the **SG6** row to SG6′, and record that the per-field mapping is retired on this measurement rather than on assumption. |
| **PD2** | the SG lane table | **M2** | Give **SG-D1** a lane, or record that it is deferred. Until then R3 (§3.3) is a live silent drop with no owner. |
| **PD3** | `editor-state.ts:2063`, or the size-control lane | **M1** | Either add `sizes` to `isDefaultOutput`, or set `outputExplicit` on a size edit — whichever lane adds `toggleSize` must do one of them. Not urgent; it is a trap, not a defect. |
| **PD4** | `editor-state.validation-gate.test.ts` | **L2** | One comment line: the operator route to Video-in-a-classic-draft is the mode flip, not the card. |

---

## 8. Definition of done for this lane

Per the repo's rule, the fault that must turn this red:

- **SG5 is done** when the reachable count is a number someone can check, not a claim. It is **3**,
  on **2** controls, and §3 gives the reproduction for each in steps. The fault this prevents is
  building SG6's per-field mapping on SG-D8's *assumption* that drops are widespread — §2 shows 26
  of 36 sites are lossless by construction and 6 more are refused by Save before they reach a file.
- **`premise SG6`** (§6) fails the day a component reads `canSerializeTimeline`, which is the day
  SG6′ ships. A fence that cannot go stale is not guarding anything.

## 9. What this lane did not do

- **It wrote no test.** SG5 ships no code. §3.1–§3.3 are written as reproductions so SG6′'s
  implementer writes them instead — and so each is falsifiable by someone who disbelieves this
  document.
- **It did not verify R1/R2 by execution.** Every step of both is settled by reading — the render
  condition (`CopySection.tsx:188`), the gate (`:2020`), the duration fallback (`:800`), the
  *Add beat* guard (`:837`), and the absence of any `headline`/timeline rule in `validate.ts`. An
  execution check would be a stronger artefact, and SG6′'s test is where it belongs.
- **It did not look past `toBrief`.** The API boundary re-validates on save and can refuse a brief
  this projection emits; that is a different measurement and not SG5's question.
