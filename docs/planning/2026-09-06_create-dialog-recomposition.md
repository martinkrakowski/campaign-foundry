# The Create Dialog, Recomposed — Architecture & Development Plan

**Date:** 2026-09-06
**Author:** orchestrator
**Status:** **accepted** — the owner confirmed the plan's recommended disposition on every open
row (2026-09-06). Wave 1 (K1) dispatched; §8 records the review pass.
**Verified against:** `main` at `708761a`
**Decision ids introduced:** D86 – D92
**Relates to:** **D65** (the dialog derives no id and shows no slug), **D66** (the dialog is the
Identity step, and one refusal sentence answers), **D67** (a cancelled create leaves nothing
behind), **D27/D28** (the looping-animation cap and the reduced-motion contract), **D84** (modality
belongs to the kit — OPEN), **F22** (two `DialogShell`s at one layer stack two scrims), DESIGN.md §1
(tokens, never literals), §2 (the `border-border` / `border-border-control` boundary rule), §5
(gating blocks entering a state, never leaving one)

---

## 0. What this plan answers

A reference mockup arrived for the **Create new campaign** dialog: a single-file HTML page carrying
a whole shell and, inside it, a much richer version of the dialog this repo ships. The request is to
adopt it, to make the React components properly reusable, and to keep the code idiomatic for this
repo.

The mockup is worth adopting. It is also, below the chrome, **a different product**. Its dialog asks
for a *format* (stills vs. motion cutdowns), a *template* from a scrolling rail, *five macro
regions* picked off an animated world map, and *assets* dropped into a project bin — then shows a
derived **campaign ID** with a regenerate control. Of those five things:

- one contradicts a recorded decision outright (**D65** — the dialog derives no id and shows no slug);
- one has no domain to stand on (`CampaignBrief.targetRegion` is a **single string**, and the UI
  vocabulary is `GLOBAL / EU / DE / UK / US / APAC` — there are no macro regions, and `GLOBAL` and
  `DE` have no polygon on any map);
- one has no domain concept at all (templates);
- one has no write seam on the create path (assets — `createCampaign` writes a `localStorage` seed
  or calls `duplicateBrief`, and touches no asset store);
- and one is a *name collision*: the mockup's "Format" is this app's **Mode** (Classic /
  Randomized). The app's real `format` axis (`static` / `motion`) lives in the editor's Output step
  and is gated on `mode === "variation"` **and** on the host's ffmpeg probe (`FormatPanel.formatGate`).

**So this plan splits the mockup in two and prices the halves separately.**

1. **The form — adopt it now.** Numbered `01 / 02 / 03` sections with an eyebrow, a heading and a
   hint; option tiles that carry a *picture, a name, a tag, a blurb and a meta line* instead of the
   kit's current value-plus-caption; per-field error text next to the field that is wrong; an error
   strip in the footer that jumps to the offending section; an inline discard guard that replaces
   the button row **inside the same dialog**; and a wider dialog to hold it. None of this needs a
   domain change, and all of it is reusable by the brief editor afterwards.

2. **The content — one decision per row, the owner's call.** §5 tables each of the five, names the
   decision it collides with, states what it would actually cost, and proposes a disposition. This
   plan's default recommendation is to take **none** of them in this wave, and to say so out loud
   rather than quietly shipping a map with two regions missing.

**What this plan is not.** It does not decide D64 (the identity model), it does not re-open D65, and
it does not extract `packages/ui` — §5 costs that extraction and recommends it as its own lane, for
reasons §2.3 gives.

**One hard constraint the mockup violates three times, stated up front.** `globals.css` is allowed
**exactly four looping animations** (D27), and a test asserts the exact four by name. The mockup's
tile previews add three more: a three-state cross-fade (`cycstep`), a scrubbing playhead (`sweep`)
and the map's ripple (`ping`). Any lane that lands them turns
`ui/__tests__/globals-motion.test.ts` red. §2.2 says what to do instead.

---

## 0.1 Proposed decisions

| id | Decision | Rationale |
|---|---|---|
| **D86** | **Adopt the mockup's form; the dialog's question set does not change in this wave.** The dialog keeps asking name, region, audience, mode and start-from-source — the four things D66 says the Identity step decides, plus W2's source. Every visual affordance below is a recomposition of those same five answers. | The mockup is a *design* reference, not a *requirements* document — nobody wrote a brief saying the product now has templates and five macro regions. Adopting its chrome is cheap, reversible and immediately reusable; adopting its content model means a domain change, a migration for every existing brief, and a map with holes in it. Shipping the second while calling it "a restyle" is how a UI starts lying about the data behind it. |
| **D87** | **`OptionTile` is a kit primitive and it is domain-free — and the boundary is a *declared allowlist that only shrinks*, not a clean sweep.** A new `components/ui/option-tile.tsx` renders picture + name + tag + blurb + meta + check badge, taking every one of those as a prop. A test asserts that no file under `components/ui/` imports `@/components/campaign/**` **except** the five that do today, each listed with a reason; K1 removes one of the five (`mode-panel.tsx`) and the list may never grow. | "Reusable" has a testable meaning here, and it is not "exported from the barrel". Five kit files reach into the campaign editor today — `mode-panel` (`MODE_OPTIONS`, `modeDisplayName`), `section-outline` (`SECTION_TITLES`, `sectionOrder`, `FieldErrors`), and `confirm-dialog` / `seg-bar` / `theme-toggle` (all for `messages`) — so a boundary test written as an absolute would be red on the day it lands, and the lane would either delete it or fix five unrelated components inside a visual PR. An allowlist that can only shrink is the version that survives contact: it is green now, it names the debt, and it makes the next violation impossible to add silently. `AxisCard`, in the same directory, is the shape being aimed at. |
| **D88** | **No new looping animation. The tile previews are static, and selection is what animates.** The mockup's cross-fade, playhead and ping are dropped; what survives is the existing one-shot `check-pop` on the badge and the `motion-safe:` hover/press transform `AxisCard` already carries. | D27 caps looping animations at four and names them; `globals-motion.test.ts` asserts the exact list. That cap exists because a review console with looping chrome in six tiles at once is unreadable, not because four was a convenient number. A tile that must loop to explain itself has not been designed yet — and the reduced-motion block would have to freeze it anyway (D28), which means the static frame is the one that has to carry the meaning regardless. |
| **D89** | **The discard guard is inline, in the footer, and it replaces the button row rather than stacking a second dialog. Moving the *existing* resume two-way in beside it is a separate, opt-in half.** | This is the mockup's best structural idea. The dialog stacks a second `DialogShell` today (`containerClassName="z-[80]"`), which is the F22 shape — two overlays at one layer, two scrims — and it is the configuration **D84 is still open about**. An inline swap has none of it: one overlay, one scrim, one focus trap, the form stays mounted so typed answers survive, and it needs no part of D84. **But the two halves do not cost the same, and the plan was wrong to price them together.** A *new* discard guard has no existing test to break. Moving the *resume* two-way inline breaks two that are behavioural, not cosmetic: `CreateCampaignDialog.test.tsx:225` asserts a second `role="dialog"` **named `resumeDraftTitle`**, and `:335` asserts Escape closes only that one while the form and its typed answers survive. Those pin modality, which is D84's subject. So: the discard guard is inline, and the resume two-way moves only if the owner says so — with both tests rewritten to assert the same *behaviours* (the question is asked; Escape dismisses the question, not the dialog; the answers survive) against the new presentation, each with a one-line reason. |
| **D90** | **A discard guard on close is NEW behaviour, and it gets its own id rather than riding in as chrome.** Today Cancel and Escape close immediately and reset (D67 — "a cancelled create leaves nothing behind"). The mockup asks first when the draft is non-empty. **Recommended: adopt it for Cancel, Escape and scrim, with "Discard and close" as the destructive answer** — and D67's guarantee restated as *a cancelled create leaves nothing behind, once confirmed*. | D67 is a promise about **state**, not about **friction**: it says the create leaves no residue, and an inline confirmation does not change that. But it was written when closing was free, and a plan that silently makes the exit path two-step is changing a behaviour the previous plan reasoned about explicitly. The owner should get to say no to this one alone without rejecting the rest. |
| **D91** | **One live region, and per-field errors are static text.** The dialog keeps exactly one `role="status"` — the footer refusal — and every field-level message renders through `Field`'s `error` slot as ordinary text. The mockup's five separate `role="status"` lines are not adopted. | D66 already fixed the refusal at one progressive sentence. Five live regions in one dialog means a screen reader hears up to five announcements for one keystroke, in an order nobody controls; the WAI practice is one status region per view, and this dialog is one view. The visual affordance the mockup wanted — a message *next to the control* — is `Field`'s `error` prop, which the editor's sections already use. |
| **D92** | **The kit stays at `apps/web/src/components/ui`. `packages/ui` is a separate lane, costed in §5, not a side effect of this one.** | The request named `packages/ui` as an example of reusability, and the honest answer is that this repo already has that kit — with a barrel, 30-odd components, its own test directory and a design contract pointing at it. Moving it into a workspace package is a real change with a real bill (`layer-rules.yaml` has no presentation layer and no whitelist entry for a UI package; plus `transpilePackages`, the Tailwind `content` globs, the vitest `web` project's `include`, and the 100 % coverage `include` patterns — five config surfaces, none of them in this dialog). Bundling it here would make a visual lane un-reviewable. |

---
## 1. Findings

Severity: **C** breaks a user's data or the build · **H** the product tells the user something false
· **M** a real defect with a bounded blast radius · **L** correctness of the estate, not the product.

Every row below was read from the code at the cited line, not from a planning document.

### 1.1 What the mockup collides with

---

#### **F1 · C · Three of the mockup's tile previews cannot land — the looping-animation budget is full**

`globals.css` is allowed **exactly four** looping animations, and the test names them:

```ts
// apps/web/src/components/ui/__tests__/globals-motion.test.ts
const expectedLoopingAnimations = [
  "kf-ken-burns-in", "kf-ken-burns-out", "kf-headline-rise", "kf-accent-wipe",
];
expect(animationNames.sort()).toEqual(expectedLoopingAnimations.sort());
expect(infiniteMatches.length).toBe(4);
```

The guard is deliberately hard to walk past — it matches the shorthand **and**
`animation-iteration-count: infinite` separately, precisely so a loop written the other way is not
missed. The mockup adds three: `@keyframes cycstep` (the motion tile's three-state cross-fade),
`@keyframes sweep` (the scrub playhead) and `@keyframes ping` (the map hub ripple).

This is graded **C** rather than **M** because it is a build break, not a visual regression: any
lane that lands the mockup's previews verbatim turns the suite red, and the tempting fix — widening
the expected list — deletes the only thing enforcing D27. **D88 is the answer: static previews.**

**The authority is DESIGN.md §2, not only the test.** DESIGN.md:203-208 names the four looping
previews and then closes the door: *"Loading indicators (`animate-spin`… `animate-pulse`…) are the
only other permitted loops. **Every other animation in the system is a one-shot on interaction.**"*
And DESIGN.md:209-213: *"A loop is never the only carrier of meaning"* — each motion glyph renders a
static cue **as well as** the animated one, *"because a paused animation still says 'this is moving'
to anything reading the DOM"*. The mockup's `@media (prefers-reduced-motion)` block does exactly
that — it sets `animation-play-state: paused` on the unselected tiles.

**And a hole the test does not cover, which the lane must not walk through.**
`apps/web/tailwind.config.ts` only *extends* the default theme, so stock `animate-ping` (literally
this ripple), `animate-bounce`, `animate-spin` and `animate-pulse` are all live class names. They
live in Tailwind's layer, not `globals.css`, so `globals-motion.test.ts` **would never see them** —
a looping tile preview smuggled in as a utility class or an inline style passes CI and still
violates §2. The DoD therefore states it as a review item, not only as a green test.

*Note what does not need to change.* The one-shot `check-pop` on the selected badge and
`motion-safe:hover:-translate-y-px` are already in the kit (`ui/axis-card.tsx`) and are already
exempt: they are not loops, and the reduced-motion block disables them by name.

---

#### **F2 · H · The mockup's region model is not this product's, and adopting it would draw a map with two regions missing**

The domain carries **one** region per campaign:

```ts
// packages/CampaignOrchestration/src/domain/entities/CampaignBrief.ts:15
readonly targetRegion: string;
```

and the UI vocabulary is six values, not five:

```ts
// apps/web/src/components/campaign/sections/IdentitySection.tsx:15
export const REGION_OPTIONS = ["GLOBAL", "EU", "DE", "UK", "US", "APAC"] as const;
```

The mockup's five macro regions (`na / latam / emea / apac / oc`) are a different vocabulary at a
different granularity, multi-select, and the two do not embed in each other: **`GLOBAL` is not a
place** and **`DE` is a country inside `emea`**. A world map cannot paint either one. Neither can a
five-chip strip represent today's `ChipGroup`, which also carries an `Other…` free-text escape that
the mockup has no equivalent for.

Graded **H** because the failure mode is the product asserting something false about the user's
data: a user who picks *EMEA* on a map and lands in an editor whose region says `EU` has been
shown a different campaign from the one they created.

---

#### **F3 · M · "Format" in the mockup is "Mode" in this app, and the app's real `format` axis is gated on two conditions the dialog cannot evaluate**

The mockup's 01 · Format tiles offer `static` (stills) and `motion` (cutdowns). This app has both
names, and they mean different things at different layers:

- **Mode** — `brief` (Classic) / `variation` (Randomized), `editor-state.ts`, chosen in this
  dialog today via `ModePanel`. This is the mockup's tile pair, semantically.
- **Format** — `static` / `motion`, an *Output-step* axis, and gated:

```ts
// apps/web/src/components/campaign/FormatPanel.tsx — formatGate
if (capabilities?.motion === false) { gated: true, disabled: !selected, … }
if (state.mode === "brief")         { gated: true, disabled: !selected, … }
```

So motion needs the host's ffmpeg probe **and** Randomized mode. The create dialog has neither: it
does not read the capabilities probe, and mode is a thing the user is still choosing in the same
breath. Putting a motion tile in this dialog means either a tile that refuses on press for a reason
the user has not been told yet, or a probe fetch on dialog open.

Graded **M**, not **H**: nothing is currently false, the cost is simply larger than "a nicer tile".

---

#### **F4 · M · The dialog stacks a second `DialogShell` — the F22 shape, in the file this work touches**

`CreateCampaignDialog.tsx` renders the resume two-way as a second overlay, hand-raised over the
first:

```tsx
// apps/web/src/components/shell/CreateCampaignDialog.tsx
<DialogShell open={createDialogOpen && resumePrompt} … containerClassName="z-[80]" className="max-w-md">
```

Both shells paint `bg-scrim/80 backdrop-blur-sm` (`ui/dialog-shell.tsx`), so two are composited —
the F22 finding. It works today because `dialogHoldsFocus` and the `openTraps` registry give the
topmost trap the keystrokes, but it is the exact configuration **D84 is still open about**, and D84
is not this plan's to decide.

This is a finding rather than a task because **D89 retires it as a side effect**: an inline footer
swap has one overlay. It is recorded so the lane does not "improve" the stacking instead.

---

#### **F5 · M · Five kit files import the campaign editor — the reusability defect is wider than the one file this work touches**

```tsx
// apps/web/src/components/ui/mode-panel.tsx:3-4
import { modeDisplayName } from "@/components/campaign/display-names";
import { MODE_OPTIONS, type CampaignMode } from "@/components/campaign/editor-state";
```

`mode-panel.tsx` is the one this work would otherwise clone, but it is not alone. Every file under
`components/ui/` that imports `@/components/campaign`:

| Kit file | Imports | Kind |
|---|---|---|
| `ui/mode-panel.tsx:3-4` | `modeDisplayName`, `MODE_OPTIONS`, `CampaignMode` | **vocabulary** — the component only works for one feature |
| `ui/section-outline.tsx:5-10` | `SECTION_TITLES`, `sectionOrder`, `CampaignMode`, `FieldErrors`, `messages` | **vocabulary** — same |
| `ui/confirm-dialog.tsx:6` | `messages` (default labels) | **strings** — the kit has adopted a feature's catalogue |
| `ui/seg-bar.tsx:5` | `messages` (incl. `messages.SegBarState`) | **strings** |
| `ui/theme-toggle.tsx:5` | `themeToDark`, `themeToLight` | **strings** |

A kit component that imports its vocabulary from one feature is reusable by exactly that feature.
`AxisCard`, in the same directory, shows the correct shape — `value`, `label`, `meta`,
`description` are all props and the accessible name is the raw `value`.

**This is why D87 is an allowlist and not a sweep.** Fixing all five is a worthwhile lane; doing it
inside a dialog PR would make the dialog un-reviewable, and doing none of it leaves the request's
actual ask — properly reusable components — unanswered. K1 fixes the one it is already replacing
and freezes the rest.

The fix direction for `mode-panel`: it is not deleted, it **moves** to
`components/campaign/ModePanel.tsx` where its domain imports are legal, and the *tile* it renders
stays in the kit. Two call sites follow it — the dialog deep-imports it today
(`shell/CreateCampaignDialog.tsx:6`), because `ModePanel` is one of four `ui/` components that are
**not in the barrel** at all (`ErrorPill`, `ModePanel`, `SectionOutline`, `PreviewFrame`).

*A different and defensible case, left alone:* seven kit files import **types and constants from
`@campaignfoundry/*` domain packages** (`ratio-frame`, `creative-glyph`, `platform-card`,
`swatch-chip`, `duration-strip`, `preview-layers`). Those are the *domain's* vocabulary, not a
sibling feature's, and DESIGN.md's own components are built on them. The lane does not touch them
and says so.

---

#### **F6 · L · `ErrorStrip` is the affordance the mockup wants, and it is domain-coupled**

The footer strip that jumps to a failing section already exists — `campaign/ErrorStrip.tsx` — and
is keyed to `SectionId` and `SECTION_TITLES`, i.e. the brief editor's six sections plus `motion`.
The dialog's sections are not those. Graded **L** because nothing is broken; it is a note that the
strip must be **extracted**, not imported, and that the extraction is the reusability win worth
banking (`ErrorStrip` then becomes a thin domain-aware wrapper over the kit's version).

#### **F8 · M · The dialog is already at DESIGN.md's field budget, and its own docstring has drifted**

DESIGN.md §5 (:480-484): *"**Five things, then a door.** A section shows only what a first-timer
must decide; the rest goes behind one `Disclosure` titled *Advanced*."*

The dialog asks **five** things today — name, region, audience, mode, start-from — and its own
docstring still claims four:

```tsx
// apps/web/src/components/shell/CreateCampaignDialog.tsx:22-24
// … It collects the four things the wizard's first step decides — name, region,
// audience, mode — and nothing else.
```

W2/D71 added the fifth (start-from) without updating the comment. So the budget is spent: **every
one of the mockup's content additions (§5, C1–C6) would be the sixth, seventh and eighth**, and
each would need a `Disclosure` door to be compliant — which a create dialog with three numbered
sections has no room for.

Graded **M** as a documentation defect with a real consequence: the next person to add a field will
read "four … and nothing else", count five, and conclude the rule is not enforced. **W1 corrects the
docstring** as part of touching the file; that is the whole fix.

---

#### **F7 · L · Four kit components are not in the kit's barrel, and callers deep-import them**

`components/ui/index.ts` opens by saying to import from the directory "rather than the individual
files so the public surface stays stable as components grow". Four components are missing from it —
`ErrorPill`, `ModePanel`, `SectionOutline`, `PreviewFrame` — so every consumer deep-imports instead
(`campaign/BriefEditor.tsx:49`, `sections/IdentitySection.tsx:8`, `ui/section-outline.tsx:8`,
`shell/CreateCampaignDialog.tsx:6`).

Graded **L** — nothing is broken and the barrel is not load-bearing at runtime. It is recorded
because the request was about reusability and this is the cheapest instance of it. **K1 closes two of the four, and refuses the
other two for stated reasons.** `ErrorPill` joins the barrel (it is domain-free; its call sites are
`campaign/BriefEditor.tsx:49` and `campaign/sections/IdentitySection.tsx:8`). `ModePanel` is closed
by removal — it leaves the kit entirely (F5).

**`SectionOutline` must NOT be barrelled**, and this corrects the plan's first draft: it is on
D87's allowlist precisely because it imports `campaign/sections`, `campaign/editor-state`,
`campaign/validate` and `campaign/messages`. Exporting it from `ui/index.ts` would make **every**
consumer of `@/components/ui` pull those campaign modules in transitively — the exact coupling D87
exists to prevent, achieved by the edit meant to improve reusability. Its one deep-import site
(`campaign/BriefEditor.tsx:71`) stays as it is, and the barrel gains a comment saying why.
**`PreviewFrame` is also left out**: there are **two** different components by that name
(`ui/PreviewFrame.tsx` and `campaign/PreviewFrame.tsx`), so a bare export needs a rename decision,
not a reflex.

---

### 1.2 What the mockup gets right, and this app does not have

Recorded so the lane knows which parts are the actual deliverable rather than restyling:

| # | The mockup's affordance | Today | Worth it? |
|---|---|---|---|
| 1 | Numbered `01/02/03` sections, each with a heading and a one-line hint under it | The dialog is a flat stack of four `Field`s | **Yes.** The brief editor already numbers its sections (`SectionShell` derives the numeral from `sectionOrder`); the dialog is the odd one out. |
| 2 | Option tiles with a picture **and** a name **and** a tag **and** a blurb **and** a meta line | `AxisCard` shows a 44px preview, a name and one caption | **Yes** — this is the `OptionTile` of D87, and the editor's Output/Format/Motion panels inherit it. |
| 3 | Per-field error text beside the field that is wrong | One refusal sentence in the footer for all four fields | **Yes**, and it is free: `Field` already takes an `error` prop (`sections/IdentitySection.tsx`) and the editor's sections already use it. |
| 4 | A footer strip of error chips that scrolls the offending section into view | Nothing — a long dialog can refuse for a field scrolled out of sight | **Yes.** F6's extraction. |
| 5 | The discard guard swapping the button row in place | A second stacked `DialogShell` (F4) | **Yes** — D89, and it retires F4. |
| 6 | A wider dialog (`max-w-[820px]`) with a scrolling body between a fixed head and foot | `DialogShell` is `max-w-lg` / `max-h-[80vh]`, already head-body-foot | **Yes, as a prop** — `DialogShell` takes `className`, so this is a call-site width, not a kit change. |

---
## 2. The recommendation

Three PRs, in order, each independently reviewable and each shippable on its own. The dialog is
visibly better after the first; it is the mockup's dialog after the third.

### 2.1 The shape

```
K1  kit primitives          →  option-tile, section-block, jump-strip, guard-bar   (no dialog change)
W1  the dialog, recomposed  →  three numbered sections on K1's primitives, per-field errors
W2  the guard, inlined      →  (a) D90 discard-on-close, inline in the footer   [owner's call]
                               (b) D89 the resume two-way moves in, F4 retired   [opt-in, D84]
```

K1 lands first and alone **because it is the reusability deliverable**. Its PR touches no feature
file, so its review is exactly the question the request asked: are these components properly
reusable? A reviewer can answer that without reading a dialog. If K1 and W1 were one PR, the answer
would be buried in a 40-file diff — the failure mode this repo already recorded (PRs #93/#94/#95).

W2 is separate, and **internally split**, because its two halves are different kinds of change.
(a) is new behaviour the owner may decline — decline it and W1 still ships, the dialog closing
exactly as it does today. (b) rewrites two tests that assert *modality*, which is **D84**'s open
subject; the plan recommends holding it until D84 lands rather than rewriting those tests twice.
Neither half blocks the other, and neither blocks K1 or W1.

### 2.2 What replaces the mockup's animation

D88 removes three loops. The affordances they carried are kept, statically:

| Mockup | Replacement | Why it still reads |
|---|---|---|
| Motion tile cross-fading three keyframes | **Three overlapping frames, offset** — the same three `pA/pB/pC` skeletons drawn as a small stack | A stack of frames says "several of these" without moving. The kit already draws this idiom — `CreativeGlyph`'s layered rects and `RatioFrame`'s proportioned outline. |
| Scrub playhead sweeping | **A static scrub with the head at ~30 % and two tick marks** | The ticks are what say "cutdowns at three lengths"; the sweep says nothing the ticks do not. |
| Map hub ripple | *dropped with the map* (F2) | — |
| Unselected tiles at `opacity:.55 saturate(.45)`, selected at full | **Kept** — it is a transition, not a loop, and `AxisCard` already inverts its preview tile on selection | This is the mockup's strongest single move: the preview *becomes* legible when chosen. |

### 2.3 What "properly reusable" means for K1, testably

Each is a review checklist item, not a sentiment:

1. **No `@/components/campaign` import** anywhere under `components/ui/` (D87). Enforced by a test
   that reads the directory and asserts the import set — the same shape as
   `globals-motion.test.ts`, which already policies a file by reading it.
2. **The accessible name is the raw `value`**, verbatim, via an explicit `aria-label`; picture,
   caption, blurb and badge are all `aria-hidden`. This is the kit's existing contract
   (`ui/axis-card.tsx`, `ui/preview-card.tsx`) and the suite depends on it —
   `getByRole("button", { name: "brief" })`.
3. **Every string is a prop** — never a literal in the kit and never a `messages.ts` import.
   `messages.ts` is the *feature's* catalogue, and three kit files import it today
   (`confirm-dialog`, `seg-bar`, `theme-toggle`, F5), which is exactly the habit the new
   primitives must not continue.
4. **Exported from `components/ui/index.ts`** with its props interface, per the barrel's own note.
5. **Colour, radius and duration are tokens** (DESIGN.md §1). Note specifically: the mockup's
   `rgb(var(--rgb-brand-primary) / .35)` idiom **does not exist here** — `tokens.css` defines no
   `--rgb-*` triples; this repo reaches alpha through Tailwind's `color-mix` scale, so every one of
   the mockup's alphas becomes `bg-brand-primary/35` and similar.
6. **A control's own edge is `border-border-control`, not `border-border`** (DESIGN.md §2, the
   boundary rule, WCAG 1.4.11). The mockup uses its single `--rgb-border` for both frames and
   controls, which is precisely the state the W3.2 audit fixed. Tiles are controls.

---
## 3. Lanes

One lane per PR. Ownership is exclusive among *concurrent* lanes; these three are **sequential** —
W1 builds on K1's exports, W2 on W1's footer. Parallelism cap 1.

| Lane | Task | Owns | Buys |
|---|---|---|---|
| **K1** | **The kit primitives** (**D87**, **D88**). Four new domain-free components, each exported from `components/ui/index.ts` with its props interface, each with a test in `components/ui/__tests__/` in the house style. *(1)* **`OptionTile`** — the richer sibling of `AxisCard`: props `value`, `selected`, `onToggle`, `children` (the picture), `name`, `tag?`, `blurb?`, `meta?`, `description?`, `disabled?`. **`blurb` and `description` are two slots, deliberately**: `AxisCard`'s single extra line is hard-coded `text-warning` and documented as *why this option is unavailable* (`ui/axis-card.tsx:19-24`), so reusing it for neutral prose would be a colour lie — `blurb` is `text-text-secondary` body copy, `description` keeps the warning tone **and** the `aria-describedby` wiring (never content, so it cannot join the name). The picture is a caller slot sized by the caller, not `AxisCard`'s fixed `size-11` well — that fixed well is exactly why `PlatformCard` cannot show anything but a `RatioFrame`. Accessible name is exactly `value` via an explicit `aria-label`; picture, tag, blurb, meta and check badge are `aria-hidden`. Selected: `border-brand-primary bg-brand-primary/[0.08]` plus the existing one-shot `motion-safe:animate-check-pop` badge; unselected: `border-border-control … hover:border-border-control-hover` (DESIGN.md §2 — **not** `border-border`). Unselected pictures render at reduced opacity/saturation and return to full on selection **via a transition, never a loop** (D88). *(2)* **`SectionBlock`** — the numbered section: `numeral`, `title`, `hint?`, `badge?`, `headingLevel?: 2 | 3`, `children`; renders `<section aria-labelledby>` mirroring `SectionShell`'s structure without its `sectionOrder` dependency. **`headingLevel` defaults to 3**, and for the same reason `DialogHead` takes one: inside a dialog whose head is an `h2`, three sibling `h2`s would flatten the outline. *(3)* **`JumpStrip`** — the footer error chips: `items: readonly { key, label, count }[]`, `onJump(key)`. This is `campaign/ErrorStrip.tsx`'s markup with the `SectionId`/`SECTION_TITLES` lookup lifted to the caller (F6); **`ErrorStrip` is re-pointed at it in the same PR** and the suites that exercise it pass **unedited** — that is the proof, and they are not where the name suggests: there is no `error-strip.test.tsx`; the assertions live in `campaign/__tests__/sections.test.tsx:713-745` (a whole `describe("ErrorStrip")`), `campaign/__tests__/error-key-coverage.test.ts:10`, and the chip behaviours in `app/(shell)/brief/__tests__/brief-editor.test.tsx:1157, 2289, 2836`. *(4)* **`GuardBar`** — the inline confirm strip: `title`, `detail?`, and its actions (the resume two-way needs three, so take an actions array or explicit slots rather than a fixed confirm/cancel pair), plus `busy?`. Renders the warning-tinted panel; **no overlay, no scrim, no focus trap** — it is a region inside a footer and the dialog owns modality. *(5)* **`ModePanel` moves out of the kit** to `components/campaign/ModePanel.tsx`, rendering `OptionTile`. Its two call sites are `campaign/BriefEditor.tsx:70, 749` and `shell/CreateCampaignDialog.tsx:6` — the second is **W1's file**, so K1 changes that one import line and nothing else in it, and W1 rebases onto it. **Only two suites query the mode cards by raw value** (`ui/__tests__/mode-panel.test.tsx` and `shell/__tests__/CreateCampaignDialog.test.tsx`); no test asserts `AxisCard`-specific markup on them from `BriefEditor`, so the swap's blast radius is those two files and K1 must leave both green. **Mind its second contract:** `ui/__tests__/mode-panel.test.tsx:12-13` asserts the rendered text contains `"Classic"` / `"Randomized"` — the visible `meta`, not the `aria-label` — so both the raw-value name (`"brief"` / `"variation"`) *and* the display name must survive the move; the test file moves with the component and its assertions do not change. *(6)* **Barrel gaps closed, selectively** (F7): `ErrorPill` is added to `index.ts` and its two deep-import sites updated (`campaign/BriefEditor.tsx:49`, `campaign/sections/IdentitySection.tsx:8`). **`SectionOutline` and `PreviewFrame` are deliberately NOT added**, and the barrel carries a one-line comment per omission: the first would drag four campaign modules into every kit consumer (it is on the D87 allowlist), the second collides by name with `campaign/PreviewFrame.tsx`. Adding either is a defect, not an oversight. *(7)* **The boundary test** `ui/__tests__/kit-boundaries.test.ts` reads every file under `components/ui/` and asserts none imports `@/components/campaign` **except a declared allowlist** — `section-outline`, `confirm-dialog`, `seg-bar`, `theme-toggle`, each with a one-line reason (F5) — and that `mode-panel` is **not** on it. The `@campaignfoundry/*` domain imports are explicitly out of scope, stated in the test. Mutation checks: add a campaign import to a kit file → test fails; remove an allowlist entry that is still needed → test fails. | `apps/web/src/components/ui/option-tile.tsx` (new), `section-block.tsx` (new), `jump-strip.tsx` (new), `guard-bar.tsx` (new), `index.ts`, `ui/mode-panel.tsx` (deleted), `ui/__tests__/mode-panel.test.tsx` (moved), `apps/web/src/components/campaign/ModePanel.tsx` (new), `apps/web/src/components/campaign/ErrorStrip.tsx`, the new kit tests, `components/campaign/BriefEditor.tsx` **(import line + render site only, `:70` and `:749`)**, `components/shell/CreateCampaignDialog.tsx` **(import line only, `:6`)** | The reusability deliverable, reviewable on its own — and the first thing in this repo that makes a kit-boundary violation impossible to add silently. |
| **W1** | **The dialog, recomposed** (**D86**, **D91**). `CreateCampaignDialog` becomes three numbered `SectionBlock`s over the *same five answers*: an **identity strip** (name — and nothing else; **no id, no slug, no regen**, D65), **`01 · Targeting`** (region `ChipGroup`, audience `Input`), **`02 · Start from`** (`StartFromExistingPicker`, component unchanged, in its own section), **`03 · Mode`** (`ModePanel` on `OptionTile`, with W2/D71's source-inherited readout preserved verbatim — a readout, never a disabled control, DESIGN.md §5). **Start-from precedes Mode deliberately, against the mockup's order:** choosing a source *replaces* the mode control with the inherited readout, and today's DOM order puts that control below the picker, where the user is already looking. Reversing them would make a choice change something above the point of interaction. Width goes to the mockup's ~820px through `DialogShell`'s existing `className` prop — **no kit change, and it genuinely works**: `lib/cn.ts` is `twMerge(clsx(...))`, so a caller's `max-w-[820px]` *replaces* the shell's `max-w-lg` rather than racing it in stylesheet order (the two-way already relies on this with `max-w-md`); body scrolls between the fixed head and foot, which `DialogBody`/`DialogFoot` already do. Per-field errors move to `Field`'s `error` slot; the footer keeps **exactly one `role="status"`** (D91) with `JumpStrip` above it. **The refusal *sentence* is not rewritten, but the *painting* set widens — state the two apart or the strip is dead weight.** The `role="status"` line stays **first-missing-wins** with today's exact strings and precedence (D66, and the eight singular `getByRole("status")` assertions keep passing); `Field`'s `error` slot and `JumpStrip` are computed from the **full** missing set, so a press with three empty fields marks three fields and shows three chips while still speaking one sentence. Without that split the ladder marks at most one field and the strip can never hold more than one chip — the affordance would be decoration. Fix the stale docstring (F8): it says four fields; there are five. **Explicitly untouched:** `lib/create-campaign.ts`, the seed's shape, the `stashStep` baton, the 409/500 paths, `hasRecoverableDraft`, and the resume two-way (W2's). **Blast radius — wider than one test file:** four other suites mount this dialog and drive its form — `app/(shell)/brief/__tests__/brief-editor.test.tsx` (two `fillDialog` helpers, `:3486` and `:3674`; and `:436-439` filters `getAllByLabelText` by `closest('[role="dialog"]')`, so the name field must stay *inside* the dialog element), `shell/__tests__/shell-nav.test.tsx`, `shell/__tests__/shell-modals.test.tsx`, `shell/__tests__/BriefPicker.test.tsx`. The lane owns them; a green run of only its own test file is not evidence. | `apps/web/src/components/shell/CreateCampaignDialog.tsx`, `apps/web/src/components/campaign/messages.ts` (append only), `shell/__tests__/CreateCampaignDialog.test.tsx`, `shell/__tests__/shell-nav.test.tsx`, `shell/__tests__/shell-modals.test.tsx`, `shell/__tests__/BriefPicker.test.tsx`, `app/(shell)/brief/__tests__/brief-editor.test.tsx` (helper updates only) | The mockup's dialog, on this product's questions. |
| **W2** | **The guard, inlined** (**D89**, **D90**) — *the first half only if the owner takes D90; the second half only if they take D89's opt-in.* **(a) The discard guard — new, nothing to break.** The footer gains a third state: button row → `GuardBar`. Cancel, Escape and scrim-click on a *non-empty* draft swap it in — "Discard this draft?", a detail line naming what would be dropped, *Keep editing* / *Discard and close*; an empty draft closes immediately, as today. Escape while the guard shows dismisses the **guard**, not the dialog — so a second Escape is *Keep editing*, never *Discard*, and no keystroke sequence can destroy a filled-in form. (This is the mockup's own `requestCloseNew` behaviour, and it is the deliberate answer to "Escape-then-Escape closes", which it is not.) `DialogShell` owns Escape (`useDialogFocusTrap`), so the dialog passes a close handler that consults its own guard state — **no kit change, no `openTraps` change, no dependency on D84**. Focus moves to the guard's first control and back to the control that raised it. Tests: dirty Cancel asks and does not close; *Keep editing* restores the row with every answer intact; *Discard and close* closes and leaves no `cf:create-seed` (D67, re-proven); empty draft closes on the first Cancel; Escape-then-Escape closes. **(b) The resume two-way moves in beside it — opt-in, because it rewrites two pinned tests.** `CreateCampaignDialog.test.tsx:225` asserts a second `role="dialog"` named `resumeDraftTitle`; `:335` asserts Escape closes only it while the form survives. Both are rewritten to assert the *same behaviours* against the inline presentation — the question is asked, Escape dismisses the question not the dialog, the typed answers survive, "Start over" still publishes the seed exactly once under the in-flight hold (`:271`), a blocked store still unmounts the question and refuses on the form's status line (`:296`) — each with a one-line reason in the diff, **none deleted**. This half is what retires F4's second scrim. | `apps/web/src/components/shell/CreateCampaignDialog.tsx`, its test, `campaign/messages.ts` (append only) | An exit path that cannot eat a filled-in form; and, with (b), one overlay instead of two. |

**Waves, for `/orchestrate-wave`.** One lane per wave — the shared file makes any overlap a collision:

| Wave | Lane | Gated on |
|---|---|---|
| **1** | **K1** | **Nothing.** K1 depends on no owner decision in §5 and no open decision elsewhere — it is dispatchable before the two-reviewer pass. |
| **2** | **W1** | K1 merged. Needs **D86** confirmed (the question set does not change), which is the plan's cheapest yes. |
| **3** | **W2(a)** | **D90** — the owner's call. |
| **—** | **W2(b)** | **D89(b)**, and the plan recommends waiting for **D84**. |

**Order.** K1 → W1 → W2, strictly. W1 imports K1's exports; W2 restructures the footer W1 lays out.
All three touch `CreateCampaignDialog.tsx` or its test, so they cannot overlap — and the shared file
is the reason the parallelism cap is 1 rather than 2.

**Explicitly not in these lanes** (each with its decision in §5): the world map, multi-region, the
template rail, the asset drop zone, the campaign-ID readout with regen, a `static`/`motion` format
tile, the run estimate line, and the `packages/ui` extraction.

---

## 4. Definition of Done

For every lane, before the PR is opened:

- The gate is green in the lane's worktree: `yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn sync:check && yarn test:cov`, with **100 % on all four counters kept** (`vitest.config.ts` — `lines/functions/branches/statements: 100`, no `istanbul ignore` added without a one-line reason on the pragma).
- **A mutation check per behavioural claim**: the PR body names the source mutation that makes each new test fail, and it was run. Specifically — and this repo has been bitten by both — a tile test must fail when `aria-pressed` is removed from `OptionTile`, and the boundary test must fail when a campaign import is added to a kit file. *A test that cannot fail against the defect it names is not done.*
- Every new user-facing string lives in `campaign/messages.ts`; **no string in a kit file** (K1's props carry them) and none in the shell file.
- **The jargon gate applies to every new string, and the mockup's own copy fails it.** `campaign/__tests__/messages.test.ts` collects every export and forbids, among others: `axis`, `axes`, `package`, `planner`, `parser`, `draw`, `floor`, `×`, `>=`, the raw ids `static` / `motion` / `1:1` / `9:16` / `16:9` / `genai` / `procedural` / `asset-pool`, and — case-insensitively — any string containing **`appl`** or **`launch`**. So the mockup's placeholder *"e.g. Fall Product Launch · EU"* is rejected, and a section hint that says "static" or "motion" is rejected. Write the copy against this list, not against the mockup.
- **A new `export function` in `messages.ts` needs an explicit call in a test if it branches.** `messages.test.ts` calls every function export with zero args, which satisfies *function* coverage but not *branch* coverage — a formatter with a ternary (as `startFromRowMeta` has) fails the 100 % branch gate without one.
- **No looping animation, by any route** (D88/F1): not in `globals.css` (the test catches it) and **not** as a stock Tailwind utility — `animate-ping`, `animate-bounce`, `animate-spin`, `animate-pulse` are all available and `globals-motion.test.ts` cannot see them. This one is a review item; DESIGN.md:203-213 is the authority.
- No `getBoundingClientRect` or computed-style assertions (happy-dom performs no layout); no class-string assertion standing in as proof of layout (D47).
- House test style, matched exactly: `vitest` + `@testing-library/react` + `userEvent`, and **no `jest-dom`** — this repo has no `toBeInTheDocument` / `toHaveAttribute`; assertions are raw DOM (`getAttribute(...).toBe("true")`, `toBeTruthy()`, `toBeNull()`). `fireEvent` only where `userEvent` would refuse (the disabled case). Test names are prose contracts, not labels.
- **No raw hex, no stock Tailwind colour, no `--rgb-*`** anywhere in the diff (DESIGN.md §1); a control's own edge is `border-border-control` (§2).
- `globals-motion.test.ts` is **untouched and passing** — the four-loop list is not widened (D88/F1).
- PR body carries a *Deviations* section, even if empty.

Per lane:

- **K1**: the four primitives are exported from the barrel with their props types; the four suites that exercise `ErrorStrip` (`sections.test.tsx`, `error-key-coverage.test.ts`, `brief-editor.test.tsx`, and the strip's own new kit test) pass against the extracted `JumpStrip` **without the first three being edited** — that is what proves the extraction was behaviour-preserving; the boundary test is green with a **four-entry** allowlist and `mode-panel` off it; `mode-panel.test.tsx`'s `"Classic"` / `"Randomized"` assertions survive the move unedited.
- **W1**: the dialog's accessible name and the mode cards' raw-value names (`"brief"`, `"variation"`) are unchanged; the region chips are still buttons named exactly `GLOBAL / EU / DE / UK / US / APAC / Other…`; **`container.textContent` still does not contain `"summer-spark"` after typing "Summer Spark"** (`:112` — D65, re-proven, and the assertion the mockup's ID readout would fail); **exactly one `role="status"` in the open dialog — assert the count, not the presence** (eight existing assertions call `getByRole("status")` in the singular and throw on a second); the seed object is still deep-equal to `{name, targetRegion, targetAudience, mode}` (`:133-138` — **no new field may join it**); the refusal precedence name → sluggability → region → audience is proven per rung; the baton and 409/500 paths untouched, their tests unedited; and **all four other suites that mount the dialog are green**, named in the PR body.
- **W2 (a)**: a dirty Cancel does not close; typed answers survive *Keep editing*; *Discard and close* leaves no `cf:create-seed`; an empty draft still closes on the first Cancel; **Escape-then-Escape returns to editing with the answers intact** — Escape never destroys, and *Discard and close* is the only thing that does.
- **W2 (b)**, if taken: `document.querySelectorAll('[role="dialog"]')` returns **1** while the question shows (F4 retired — asserted, not described); the five resume-path behaviours (`:225`, `:237`, `:257`, `:271`, `:296`, `:335`) each still have a test, rewritten not removed, each carrying its one-line reason.

---
## 5. The mockup's content — one decision each, for the owner

None of these is in a lane. Each is costed so the answer can be "yes, next wave" rather than "yes"
followed by a surprise.

**One constraint applies to all of them at once.** DESIGN.md §5 allows a section **five things, then
a door**, and this dialog already asks five (F8). Every row below would be the sixth or later, so
each needs not only its own decision but a `Disclosure` to live behind — which a three-section
create dialog has nowhere to put. That is a structural argument against adopting the mockup's
content wholesale, independent of what any single row costs.

| # | The mockup asks for | What it collides with | Real cost | Proposed disposition |
|---|---|---|---|---|
| **C1** | **A campaign-ID readout with a `regen` control**, derived from the name | **D65** — "the dialog derives no id and shows no slug"; the id is derived by the seam (`lib/create-campaign.ts` calls `slugify`), and the readout lives in the editor's Identity step | Small in code, large in meaning: it re-opens a decision **D64 (the identity model) is still open about**. Under D64(b) the id is the server's to mint, and a client-side `regen` button would show the user a value the server will ignore. There is also a test standing directly in front of it: `CreateCampaignDialog.test.tsx:112` asserts the dialog's whole `container.textContent` does **not** contain `"summer-spark"` after the name is typed. | **Decline, and keep D65.** Revisit only after D64 lands, and then as part of D64's own lane. |
| **C2** | **Five macro regions on an animated world map**, multi-select | F2 — `targetRegion` is one `string`; six values, two of which (`GLOBAL`, `DE`) are unmappable; `ChipGroup`'s `Other…` free-text has no map equivalent | A domain change (`targetRegion: string` → a list) at **every** layer that spells it: the entity (`CampaignBrief.ts:15`), the port (`ImageGeneratorPort.ts:13`), the YAML scalar list (`shared/…/brief-yaml.ts:15`), the API's required-field loop (`load-brief.ts:25, 567`), the editor state (`editor-state.ts:212, 387`), the seed type (`create-campaign.ts:19`), the duplicate route's overrides (which accepts *"`targetRegion` and `targetAudience` only"*), and the four generators that interpolate it into a prompt sentence (`Market/region: ${…}` — Gemini, Firefly, OpenRouter ×2). Plus a back-compat read for every existing `briefs/*.yaml`. Note there is **no enum and no schema**: `REGION_OPTIONS` is the only non-test source, and the vocabulary is re-typed as a literal in at least two test files. **This is a plan of its own, not a lane.** | **Decline for this wave.** If multi-region is genuinely wanted, it starts with a domain decision, not a dialog. |
| **C3** | **A template rail** with per-template section/platform counts and region presets | No template concept exists anywhere in the domain or the API | The *honest* analog already ships: `StartFromExistingPicker` (a blank row plus the store's briefs). W2 of the previous plan chose the name deliberately — "the word *template* appears nowhere". | **Adopt the affordance, refuse the name.** W1 already puts the picker in its own numbered section; **re-skinning its rows as an `OptionTile` rail is a small follow-up lane** once K1 exists. Do not invent a template model. |
| **C4** | **A drop zone and link/Dropbox/Drive attach**, at create time | The create path has no asset write: `createCampaign` publishes a `localStorage` seed or calls `duplicateBrief`; neither touches `AssetStorePort` | A create-time asset write means an upload route reachable before a brief exists, or a client-side staging area that survives navigation — and under D64(b) it changes again. The editor's `AssetPickerDrawer` already does this job *after* create. | **Decline.** The dialog's job is the four Identity answers (D66); assets belong to the step that already owns them. |
| **C5** | **`static` / `motion` format tiles** in the dialog | F3 — the app's `format` axis is gated on the ffmpeg probe **and** `mode === "variation"`, neither of which the dialog knows | Requires a capabilities fetch on dialog open, a probe-pending state, and a gate whose second condition is a control *in the same dialog* — so the tile's availability changes as the user picks a mode. Doable; not free. And DESIGN.md §5 constrains the answer: a refused format may never be a dead control the user cannot leave. | **Decline for this wave.** If wanted, it is its own lane with `ProbeRow` in the dialog, and it must state a probe-pending behaviour (the mockup's own answer — *ungated until the probe answers* — is a good one). |
| **C6** | **A run-estimate line in the footer** ("est. 24 creatives · 12/region") | Needs a product count and a platform set the dialog does not collect | The previous plan already ruled this out for the same reason. | **Decline**, unchanged. |
| **C7** | **`packages/ui`** | D92 — five config surfaces (`layer-rules.yaml` has no presentation layer; `linter-config.yaml`'s whitelist; Next's `transpilePackages`; the Tailwind `content` globs; the vitest `web` project's `include` and coverage `include`) | A mechanical but wide change, touching every one of ~90 import sites and five configs, with **zero user-visible effect**. Its value is real only when a second app consumes the kit — and today there is one app. | **Defer, and revisit when a second consumer exists** (the cloud migration is the plausible trigger). K1 delivers the reusability the request actually asked for — domain-free, props-driven, barrel-exported components — without the move. |

---

## 6. Open questions

1. **D90 — is a confirm-on-close wanted at all?** It is the one *new* behaviour here, and it is
   W2(a). Declining it costs nothing else: K1 and W1 ship unchanged and the dialog closes exactly as
   it does today. *The plan recommends taking it*, because the dialog is about to get long enough
   that losing a filled-in form to a stray Escape is a real loss rather than a hypothetical one.
2. **D89(b) — does the resume two-way move inline?** Separate question, separate price: it rewrites
   two tests that assert modality (`:225`, `:335`), and modality is what **D84** is open about.
   *The plan recommends deferring it until D84 lands* — F4 is a cosmetic double-scrim today, not a
   defect anyone has hit, and rewriting modality tests twice is worse than rewriting them once.
3. **Does `01 · Targeting` read better as two sections** (region, audience) than one? The mockup has
   three numbered sections and so does W1, but the mapping is this plan's, not the mockup's.
4. **C3's follow-up** — is the picker-as-tile-rail wanted, and if so, what does a row's picture
   show? A brief has no thumbnail today. (`CreativeGlyph` at row scale is the cheap answer;
   a real first-creative thumbnail is not, and would need the pipeline.)
5. **The kit's padding contradicts DESIGN.md and nobody has said which is right.** DESIGN.md:197
   says *"dialogs `p-6`"*; `DialogHead` and `DialogFoot` both use `px-4 py-3`
   (`ui/dialog-shell.tsx:197, 246`). The mockup uses the larger padding. W1 will make this visible
   at 820px wide, so it wants an answer — **change the doc, or change the kit** — rather than a
   third value at one call site.
6. **Does the brief editor adopt `OptionTile` in the same wave?** K1 makes it possible and W1 does
   not need it. Doing it later is free; doing it in K1 widens that PR's blast radius from four new
   files to four new files plus five panels.

---

## 7. Corrections this plan records

- **"The mockup is a restyle."** It is not. Six of its affordances are new *product surface* (§5),
  and one of them (the map) implies a domain change with a data migration. The request's framing —
  update the modal to use this modal — is reasonable, and the honest answer to it is §1's split
  rather than a yes.
- **"`packages/ui` doesn't exist here."** It does, under a different path: `apps/web/src/components/ui`
  is a 30-component kit with a barrel, its own test directory, and a design contract (DESIGN.md)
  that points at it. The reusability problem is not the *location*; it is that five kit files import
  the campaign editor's vocabulary or its string catalogue (F5), and four more are not in the barrel
  at all (F7).
- **"The kit-boundary violation is one file."** This plan's first draft said so, on the strength of
  `mode-panel.tsx`. It is five, and three of them are `messages` imports rather than vocabulary
  imports — a softer violation, but the same one. The correction is why **D87 is an allowlist**: an
  absolute rule would have been written, found red, and weakened in the same PR.
- **"The resume two-way can just move inline."** The plan's first draft folded it into D89 as
  presentation. It is not: two tests assert it is a *separate labelled dialog* and that Escape
  dismisses only it — modality claims, and modality is D84's open subject. D89 is now two halves
  with two prices, and the opt-in half rewrites those tests rather than pretending they were about
  layout.
- **"Adopt the mockup's tokens."** The mockup's `--rgb-*` triples and its single border colour are
  an *earlier* version of this repo's token system. `tokens.css` has since split the border token in
  two on a WCAG 1.4.11 finding and moved the light semantic ramp on a measured contrast audit
  (DESIGN.md §2, W3.2). Copying the mockup's CSS would regress both.

---

## 8. Decision record

**2026-09-06 — the owner accepted the plan's defaults**, to be revisited after a UI review of the
shipped dialog:

| Row | Disposition |
|---|---|
| **D86 – D92** | Adopted as written. |
| **D90** (confirm-on-close) | **Taken.** Wave 3 = W2(a). |
| **D89(b)** (the resume two-way moves inline) | **Deferred** pending **D84**. |
| **C1 – C7** (campaign ID, world map, template rail, drop zone, format tiles, estimate line, `packages/ui`) | **All declined** for this arc. |
| §6 open questions | The plan's own recommendation stands on each; Q5 (the `p-6` vs `px-4 py-3` padding contradiction) remains genuinely unanswered and is not blocking. |

Wave 1 is gated on none of the above: **K1 depends only on D87 and D88**, both adopted.

---

## 9. Review record

*(to be completed by the two-reviewer pass)*

---

## Premises

**K1 — shipped in #199.** Four domain-free kit primitives (`OptionTile`, `SectionBlock`, `JumpStrip`, `GuardBar`) exported from `apps/web/src/components/ui/index.ts`, `ModePanel` moved to `apps/web/src/components/campaign/ModePanel.tsx`, and boundary test in `apps/web/src/components/ui/__tests__/kit-boundaries.test.ts`.
