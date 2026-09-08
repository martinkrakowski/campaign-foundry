# The Create Dialog Against DESIGN.md — Audit

**Date:** 2026-09-08
**Author:** orchestrator
**Status:** findings — read-only; no code changed. For the owner, who disclosed that the
2026-09-06 dialog mock had been drawn against another project's DESIGN.md, and supplied a
regenerated mock built against this one.
**Verified against:** `main` at `888675e`
**Scope:** `apps/web/src/components/shell/CreateCampaignDialog.tsx` and the kit pieces it composes
(`DialogShell`, `DialogHead/Body/Foot`, `OptionTile`, `PosterStack`, `PosterFrame`, `ScrubBar`,
`GuardBar`, `Input`, `Button`), audited against DESIGN.md §1 principles, §2 tokens and motion,
§3 overlays, §4 components, §5 patterns, §7 accessibility, §9 changing the system. §6 says how the
regenerated mock fares against the same rules.
**Relates to:** `2026-09-06_create-dialog-recomposition.md` (D86 form adopted, D88 no new loops),
`2026-09-07_graphics-and-the-world-map.md` (D93 preview panels are operational chrome, D96 arcs
stay, ping goes), `2026-09-07_two-field-create.md` (D97 the dialog asks name and type), P1 (#240,
the kit moved to `packages/ui`)

---

## 0. Verdict

**The shipped dialog passes the design contract on everything the contract actually enforces**:
tokens, both themes, motion, gating, overlay anatomy, keyboard and screen-reader behaviour, and
copy. The wrong DESIGN.md never reached the product, because the pipeline took only the mock's
*form* (D86) and re-expressed it in this repo's kit and tokens.

**The gaps are in the contract document, not the dialog.** DESIGN.md has fallen behind the kit by
seven components and one path, prescribes a stock-colour scrim its own first principle forbids,
and has no token for text painted on the brand colour — which is why nineteen `text-white` sites
exist across eight kit files. Two arbitrary type sizes sit off the documented scale. None of this
is visible to a user; all of it is visible to the next person who reads DESIGN.md to build a
component.

---

## 1. Findings

Graded C/H/M/L as in every plan here. Each cites what was read.

#### **F1 · H · DESIGN.md §4 does not know seven of the components the dialog is made of**

`grep -n "OptionTile\|PosterFrame\|PosterStack\|ScrubBar\|WorldMap\|DialogShell\|GuardBar" DESIGN.md`
returns nothing. All seven live in `packages/ui/src/` (158, 134, 54, 32, 140, 344 and 68 lines),
all shipped between #196 and #240, all with states, roles and names in code. §9 says a new
component "starts from the nearest kit primitive; takes colours from tokens; gets a role and a
name; writes its states explicitly" — the code did that; the document never recorded it. The
graphics plan's DoD did not require a DESIGN.md entry, so no lane wrote one. **This is the finding
that matters:** the next dialog built from DESIGN.md alone would re-invent `OptionTile` from
`AxisCard`, which is exactly what #203 did before the graphics plan corrected it.

#### **F2 · M · The kit path in DESIGN.md is stale**

§4 is headed "UI kit (`src/components/ui`)"; the kit has lived in `packages/ui` since P1 (#240).
`grep -c "packages/ui" DESIGN.md` → 0. A reader following the document goes to a directory that
holds only re-exports.

#### **F3 · M · Text on the brand colour has no token, so it is a literal nineteen times**

§1.1: "a stock Tailwind colour in a component is a defect." `text-white` appears at 19 sites in 8
kit files — `button.tsx` (the primary verb), `option-tile.tsx` (the check badge, the one place the
dialog inherits it), `axis-card`, `preview-card`, `creative-glyph`, `platform-card`,
`swatch-picker`, `duration-strip`. It does not break theming — `--color-brand-primary` is the same
`#1473e6` in both blocks, so white on it reads the same on both grounds — but it is a literal for
a real design decision ("what colour is ink on the brand?") that `tokens.css` does not express.
The regenerated mock makes the same choice (`color:#fff` on `.fcheck`, `.stepnum`, `text-white` on
primary buttons), which confirms the intent and confirms the missing token. Remedy: one token,
`--color-brand-on-primary`, both themes, mapped as `text-brand-on-primary`; a sweep of 19 sites.

#### **F4 · L · Two arbitrary type sizes sit off the documented scale**

§2 Typography names 10, 11, 13 and 14 px. The dialog paints its error line at `text-[12px]`;
`OptionTile` paints its meta at `text-[12px]` and its name at `text-[15px]`. Neither is on the
scale. `12px` may be a deliberate step between caption and body — if so, the scale should say
so; `15px` for a tile name is one pixel off `text-sm` and reads as an accident.

#### **F5 · L · DESIGN.md §3 prescribes a scrim its own §1 forbids**

§3 Overlays: "`bg-black/80 backdrop-blur-sm` scrim." `bg-black` is a stock colour; §1.1 calls that
a defect. The code is already right — `grep -rl bg-black apps/web/src packages/ui/src` → nothing;
`--color-scrim` exists in both theme blocks and the overlays use it. The document lags the code.

#### **F6 · pass · Tokens and themes (§1.1, §1.2)**

`CreateCampaignDialog.tsx`: zero hex, `rgb(`, `hsl(` or stock-colour hits; every class resolves to
a token (`text-text-muted`, `text-error`, `border-border`…). Every import is from `@/components/ui`
(the kit re-export) or the domain. `tokens.css` and DESIGN.md last changed 2026-09-02, before the
mock existed — the wrong contract touched neither.

#### **F7 · pass · Dense and operational, no hero areas (§1.3)**

The tile anatomy — preview panel, name, uppercase mono tag, blurb, mono meta — was ruled
operational chrome under **D93**, taken against this repo's §1.3. The regenerated mock, built on
the correct DESIGN.md, arrives at the same anatomy (`.fpv` / `.fhead` / `.ftag` / `.fblurb` /
`.fmeta`), which is the best available evidence that the anatomy is this system's, not the other
project's. The eyebrow and mini-chip idioms predate the mock in this kit.

#### **F8 · pass · Motion (§2)**

`globals.css` carries exactly four `infinite` animations, the four `kf-*` motion kinds §2 names;
the other eight keyframes are one-shots. The dialog has zero `animate-` classes; `PosterStack`,
`PosterFrame` and `ScrubBar` are static pictures, per **D88**. The map (now in the editor, not the
dialog — §5 below) keeps arc and dot-reveal *transitions* and dropped its ping, per **D96**.

#### **F9 · pass · Gating and verbs (§1.5, §5)**

Create is disabled only while a request is in flight (`disabled={creating}`), never for
invalidity; the file's own comment cites the rule. Invalid state is spoken in a `role="status"`
line beside the field. The type tiles are single-select with one always pressed — "an axis cannot
be emptied" holds. `GuardBar` offers keep-or-discard; leaving stays possible.

#### **F10 · pass · Overlay anatomy and accessibility (§3, §7)**

`DialogShell`: `role="dialog"`, `aria-modal`, labelled, focus trapped (the stray-Tab fix in #196 is
what F5 of the remaining-work plan named), Escape closes. Tiles use `aria-pressed`; their
descriptions ride `aria-describedby`; the name input carries an `aria-label`; the type group is a
labelled `role="group"`. Accessible names are raw ids with display words in `description`, per
the kit contract, and the jargon gate is green on main.

---

## 2. What the dialog inherited from the mock, and what it did not

| From the mock (form, D86) | Anchored to this repo instead |
|---|---|
| A dialog of tiles rather than a form of fields | Every colour, radius, shadow and duration — tokens only |
| The three-part tile (preview / body / meta) — confirmed by D93 and by the regenerated mock | The question set: name and type (D97, D108), not the mock's format / regions / assets |
| Poster-stack and scrub-bar previews — as static pictures (D88) | No looping animation outside the four motion kinds |
| The dirty guard as an inline bar (D89/D90) | The kit's `DialogShell` contract, focus trap, `aria-*` |
| The mono tag / mono meta idiom | `Eyebrow`, `MiniChip`, `RatioFrame`, `CreativeGlyph` — all pre-existing |

---

## 3. Remediation, in the order it pays

| # | Task | Size | Why this order |
|---|---|---|---|
| **R1** | **DESIGN.md §4 gains the seven missing entries**, each in the house shape (what it is, its slots, its states, its aria), and the kit path becomes `packages/ui`. Doc-only. | S | F1 and F2 are the ones that mislead the next builder. |
| **R2** | **`--color-brand-on-primary`** in both theme blocks, mapped in `tailwind.config.ts`; sweep the 19 `text-white` sites; a kit-boundaries assertion that `text-white` does not reappear. | S–M | F3. One token, one sweep, one test — and it gives the regenerated mock's `#fff` a home. |
| **R3** | **§2 typography states the scale the kit uses**, or the two off-scale sizes move onto it (`12px` → declared or `text-[11px]`; `15px` → `text-sm`). Design review decides which. | S | F4. |
| **R4** | **§3 says `bg-scrim/80`**, matching the code. One line. | XS | F5. |

R1 and R4 are documentation and need no lane. R2 and R3 touch the kit and go through design
review as DESIGN.md requires. None is urgent; all are cheap.

---

## 4. What this audit did not do

It did not compare the dialog pixel-for-pixel with either mock; parity was the graphics plan's
question and the owner judged it. It did not audit the editor's Identity section, where the map
now lives — only the note in §5. It did not run the app: every fact above comes from the source,
the token file and the design document.

---

## 5. A note on the map

The regenerated mock puts a multi-select world map inside the dialog. In the product the map
moved to the editor's Identity section with the two-field create (D97), is single-select, and
renders its SVG `aria-hidden` with a visually-hidden hint and the chips as the accessible path —
the pointer-only affordance is by design, not an omission. Multi-select still waits on **D95**
(what more than one region *means* for generation), a decision the code cannot take.

---

## 6. The regenerated mock against the same rules

The owner supplied a second mock drawn against this repo's DESIGN.md. It is a better source than
the first, and it is worth saying precisely where it agrees with the system and where it would
break it, so that "adopt the mock" cannot happen by accident.

**Where it is this system.** Its token block is `tokens.css` value for value — both themes, the
twelve dark values, brand, tint and on-tint, Inter and Fira Code, the 4/8/12 radii, the 150/250/
2400 ms durations. Its tile anatomy is the shipped `OptionTile`. Its messages are one voice in one
object, its verbs refuse out loud, its guard is inline, its last-region rule holds, its estimate is
a sentence. It reads DESIGN.md §5 back almost clause by clause.

**Where it would break the contract.**

| The mock does | The rule | Disposition |
|---|---|---|
| Plays the four `kf-*` loops inside the *format tile* preview (`.cga`) | §2: the loops play on the glyph inside a `MotionKindPanel`; **D88**: tile previews are static, selection is what animates | A new loop site. D88 was a decision, not a constraint of the wrong DESIGN.md; it stands unless the owner reopens it. |
| Reintroduces the map `ping` (three rings on selection) | **D96** removed it; §2 permits one-shots on interaction, and three iterations over ~8 s is a one-shot by count | Arguable either way; a decision to revisit, not a violation. |
| `animate-pulse` on the probe dot, `spin` on Execute | §2 permits exactly these loops in `ProbeRow` and `Button` | Allowed. |
| `color:#fff` / `text-white` on brand surfaces | §1.1 — and the same gap the kit has (F3) | Confirms R2. |
| `text-[10px]`, `[11px]`, `[13px]`, `[15px]` | §2 scale: 10/11/13/14 | `15px` again — confirms R3. |

**Where it is a different product, again.** This is the part that matters most, and it is not a
styling question. The mock's dialog asks **format → regions → finish (name, per-region count,
seed, assets, an ID readout)** across a three-step rail. The product's dialog asks **name and
type** (D97, D108) and has no campaign *type* in the mock at all. Every one of the mock's extra
questions was priced and declined before, with the reason still standing:

| Mock question | Prior disposition |
|---|---|
| Static / Video format tiles | **C5** declined — format is gated on the ffmpeg probe *and* `mode === "variation"`, neither known at create |
| Multi-select regions with arcs | **D95** open — the code cannot decide what two regions mean |
| Assets at create (drop zone, links) | **C4** declined — the create path has no asset write seam |
| The estimate sentence in the footer | **C6** declined — needs a product count and platform set the dialog does not collect |
| Per-region count slider, seed | No create-time seam; both are editor axes today |
| Campaign-ID readout with regen | **D65** not reopened — the dialog derives no id and shows no slug |

Adopting any row is a product decision with a plan behind it, the way the campaign type got one.
The mock is now a faithful picture of the system's *style*; it is still not a specification of
the dialog's *questions*, and the owner should read it as the former.
