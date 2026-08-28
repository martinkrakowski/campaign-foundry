# DESIGN.md — Campaign Foundry visual system

The contract behind `apps/web`. `tailwind.config.ts` and `src/styles/tokens.css` both
point here; this is the document they were pointing at.

Scope: the HITL web app (`apps/web`). Print proofs and packaged creatives are governed by
the pipeline, not this file.

---

## 1. Principles

1. **Tokens, never literals.** Every colour, font, radius, shadow and duration resolves to
   a CSS custom property in `src/styles/tokens.css`, reached through the Tailwind scale in
   `tailwind.config.ts` (`bg-surface`, `text-text-muted`, `border-border`, `rounded-lg`…).
   A raw hex value or a stock Tailwind colour (`text-red-400`) in a component is a defect —
   it will not follow a theme change and does not exist in the other theme.
2. **Dark first.** The root layout sets `class="dark"` on `<html>`; the dark block in
   `tokens.css` is the "Firefly" palette the product ships with. Light is the un-classed
   `:root` and must keep working, but it is not what users see.
3. **Dense and operational, not editorial.** This is a review console: small type,
   monospace identifiers, tight spacing, status encoded in form (chips, pills, badges) as
   well as colour. No hero areas, no marketing rhythm.
4. **Copy names the remedy.** An error says what to change, not only what is wrong.
   *"No selected platform packages "motion" — add one of: instagram-story, instagram-reel…"*
   The API states the rejection; the editor, standing next to the control, states the fix.
5. **Gating blocks entering a state, never leaving one.** A control may refuse to *select*
   something the host cannot do; it must never leave the user with a disabled control as the
   only way out of a state they are already in. This rule has been violated three times in
   this codebase (headline axis, motion format, platforms) — treat it as a review checklist item.
6. **Chrome is scoped to its view.** A floating bar belongs to the surface it acts on and sits
   inside it, in flow. `position: fixed` against the viewport is reserved for true overlays
   (dialogs, drawers, the mobile menu), never for toolbars — a fixed toolbar covers other
   chrome and hides content beneath it.

---

## 2. Tokens

Source of truth: `apps/web/src/styles/tokens.css`. Change a value there; nothing recompiles.

### Colour

| Token | Light (`:root`) | Dark (`.dark`, default) | Tailwind | Use |
|---|---|---|---|---|
| `--color-brand-primary` | `#1473e6` | inherits | `bg-brand-primary` `text-brand-primary` | primary actions, brand mark, active states |
| `--color-brand-primary-hover` | `color-mix(primary 85%, black)` | inherits | `hover:bg-brand-primary-hover` | |
| `--color-brand-secondary` | `#8b5cf6` | inherits | `brand-secondary` | accents, rarely |
| `--color-background` | `#ffffff` | `#0f0f0f` | `bg-background` | page ground, inputs |
| `--color-surface` | `#f8fafc` | `#1c1c1c` | `bg-surface` | panels, cards, menus, drawers |
| `--color-surface-2` | `#f1f5f9` | `#262626` | `bg-surface-2` | a raised surface on a surface (rows, inputs on a panel, hover) |
| `--color-border` | `#e2e8f0` | `#333333` | `border-border` | every hairline |
| `--color-border-hover` | `#cbd5e1` | `#444444` | `hover:bg-border-hover` | |
| `--color-text-primary` | `#0f172a` | `#e8e8e8` | `text-text-primary` | body |
| `--color-text-secondary` | `#64748b` | `#9e9e9e` | `text-text-secondary` | |
| `--color-text-muted` | `#94a3b8` | `#9e9e9e` | `text-text-muted` | labels, hints, captions |
| `--color-success` | `#10b981` | inherits | `text-success` | applied, passed |
| `--color-warning` | `#f59e0b` | inherits | `text-warning` | unavailable, degraded |
| `--color-error` | `#ef4444` | inherits | `text-error` `bg-error/20` | validation, refusals, rejected |
| `--color-info` | `#3b82f6` | inherits | `text-info` | |

Semantic colours (success / warning / error) carry state. The brand blue is *not* a state
colour; do not use it to mean "good".

`text-white` is used for emphasised text on dark surfaces (headings, selected chips). It is
the one literal tolerated, because it is equally correct on every surface the app paints.

### Typography

Loaded with `next/font` in the root layout; the token stacks add fallbacks.

| Token | Family | Tailwind |
|---|---|---|
| `--font-sans` | Inter, system-ui | `font-sans` (default) |
| `--font-mono` | Fira Code, ui-monospace | `font-mono` |

Monospace is semantic: identifiers (brief ids, product ids, hashes, ratios, axis values)
are set in `font-mono` so they read as data, not prose.

The scale as actually used — these are deliberate, keep to them:

| Role | Classes |
|---|---|
| Section heading | `text-lg font-semibold text-white` |
| Panel / dialog title | `text-sm font-semibold text-white` |
| Body, controls | `text-sm` (14px) / `text-[13px]` |
| Field label | `text-[11px] text-text-muted` |
| Group label (eyebrow) | `font-mono text-[11px] uppercase tracking-widest text-text-muted` |
| Hint, caption, badge | `text-[11px]` / `text-[10px]` |

### Spacing, radius, elevation, motion

- Spacing: Tailwind's 4px scale (`--space-*` mirror it). Panels pad `p-4`; dialogs `p-6`;
  rows `px-3 py-2`.
- Radius: `--radius-sm` 4px (inputs' inner), `--radius-md` 8px (buttons, inputs, rows),
  `--radius-lg` 12px (panels, cards, dialogs, the sidebar), `full` for chips and pills.
- Shadow: `shadow-sm` on cards; `shadow-2xl` on floating chrome (sidebar, menus, drawers).
- Motion: `--duration-fast` 150ms for hover/colour, `--duration-normal` 250ms for
  open/close. `transition-colors` is the default; respect `prefers-reduced-motion` for
  anything larger.

---

## 3. Shell anatomy

```
┌──────────────────────────────────────────────────────────────────────┐
│ Header   [brand mark] Campaign Pipeline   Grid Compliance Export Runs │  h-14, model picker, ☰ < lg
├────────────┬─────────────────────────────────────────────────────────┤
│ Sidebar    │ main (rounded-xl, scrolls inside itself)                │
│ 320px      │                                                         │
│ hidden <lg │   the route's view                                      │
│            │                                                         │
│ Campaign   │                                                         │
│ Campaign   │                                                         │
│  Brief     │                                                         │
│ Project Bin│                                                         │
│────────────│─────────────────────────────────────────────────────────│
│ Create new │ CommandBar (only on /grid): status · Regenerate · Execute│
│ Browse     │                                                         │
└────────────┴─────────────────────────────────────────────────────────┘
* placed by the brief editor while it is mounted
```

- **Header** — brand mark (`bg-brand-primary` square + "Campaign Pipeline"), four route tabs
  centred, the image-model picker, and a hamburger below `lg` that opens the **mobile
  menu**: a full-screen dialog (focus-trapped, body scroll locked, Escape closes) holding the
  tabs and the sidebar's content.
- **Sidebar** — a floating `rounded-xl` panel, `bg-surface`, `shadow-2xl`, `w-[320px]`,
  hidden below `lg`. Content is `Accordion` sections; the footer holds **Create new**
  (primary) and **Browse briefs** (secondary). Whatever the sidebar shows, the mobile menu
  shows — they share `SidebarContent`.
- **Main** — the route's view, `overflow-auto` inside its own rounded container. Views own
  their chrome (see §1.6): the brief editor's action bar is the last row of *its* column.
- **CommandBar** — the pipeline's controls, rendered only on `/grid` where the creatives
  and the approve/reject flow live. Elsewhere it would obscure read-only reports.
- **Overlays** — `BriefPicker`, the headline pool drawer, the Save-as dialog, the telemetry
  drawer: `fixed inset-0` with a `bg-black/80 backdrop-blur-sm` scrim, `z-50`+, and a
  `role="dialog"` (labelled) on the panel.

---

## 4. Components

### UI kit (`src/components/ui`)

Skeletal by design — patterns to extend, not a library.

- **Button** — variants `primary` (brand), `secondary` (surface + border), `ghost`,
  `destructive`; sizes `sm` h-8, `md` h-10 (default), `lg` h-12. `isLoading` swaps the label
  for a spinner and sets `aria-busy`. Disabled: `opacity-50`, no pointer events.
- **Input** — h-10, `bg-background`, token border; `invalid` sets `aria-invalid` and the
  error border. Always paired with a visible label or `aria-label`.
- **Slider** — a bounded integer whose *bound is the point*: the user is spending a budget
  (how many creatives, out of what the axes can produce) rather than typing a figure, and
  the track shows how much room is left. A readout keeps the number legible, since a range
  alone shows only a position.
- **Stepper** — a small bounded integer with a handful of sensible settings. It states its
  bounds by disabling its own buttons and cannot accept the malformed input a free-text
  number field invites. `allowUnset` adds an explicit "Auto" at the bottom of the range, so
  an optional field can say *"I have not chosen"* instead of showing an empty box that reads
  as a mistake. The readout is `role="spinbutton"` with `aria-valuenow`/`min`/`max` — not
  `<output>`, whose implicit `role="status"` would make every stepper a live region.
- **Card / CardHeader / CardContent** — `bg-surface`, `border-border`, `rounded-lg`, `shadow-sm`.
- **CreativeGlyph** — a miniature of the creative the compositor will paint, drawn in the
  compositor's own layer order (photo ground → contrast shade on the headline edge → brand
  accent band flush to that edge → two text bars). It encodes the two visual axes of a
  variation policy: `layout` picks which edge carries the shade, band and text; `tone` scales
  the shade opacity and the text weight (the compositor's own `shadeAlpha`: 0.7 bold, 0.4
  subtle). The arrangement mirrors `NodeCanvasCompositor.draw`, not the pixels — colours are
  theme tokens so the miniature reads in both themes. Purely decorative: `aria-hidden`, so
  the label beside it carries the meaning.
- **AxisCard** — the selectable card for one value of a fixed-vocabulary axis, generic over
  the value: it knows how to be chosen (pressed/unpressed, the selected border + tint, a
  check mark, `focus-visible` ring), not what a choice means — that is the preview it hosts
  (a `CreativeGlyph` for layout and tone). The accessible name is **exactly the raw option
  value**, set as an explicit `aria-label` — that label is what fixes the name, since an
  `aria-label` overrides descendant content. The preview and the check mark are `aria-hidden`
  because they are decoration; the meta caption is too, as defence in depth, so that dropping
  the label some day degrades to the bare value rather than to "headline-top shade .7" — which
  would orphan every `getByRole("button", { name })` query in the suite.

- **ModePanel** (L2.1) — the two campaign modes as pictures at the top of the sidebar, one
  per `AxisCard`: Classic draws one creative, Randomized draws a fan of them. It is the
  first decision a brief makes, so it is the first thing the bar shows.
- **Disclosure** (L2.4) — one door over everything a first-timer does not need. Closed by
  default; the open state is remembered per `id` in `localStorage` (`cf:disclosure:<id>`),
  so opening Advanced once is not punished on every later visit. A blocked or absent store
  reads as closed and never throws. `aria-expanded` / `aria-controls`; ordinary flow, not a
  dialog — no focus trap, no Escape handling.
- **PreviewCard** (L2.4) — `AxisCard`'s horizontal sibling, for options whose preview is a
  picture of the *result* rather than a miniature of the creative: the background sources
  (a drawn pattern, your own images, made by AI). Same a11y contract as every card in the
  kit — the accessible name is exactly the raw value, and the picture, the caption and the
  check mark are all `aria-hidden`. Anything assistive tech must hear goes through
  `aria-describedby`, which never joins the name.
- **SwatchChip** (L2.4) — one palette-shift value, filled with that value applied to the
  first product's colour, so the shift stops being a bare number. The hue rotation is
  preview-only (`hueShiftHex`); the brief keeps the raw values.
- **SwitchRow** (L2.4) — a labelled boolean with room for a status line, for optional axes
  that read as a sentence ("Vary the headline too · 2 approved headlines"). A real
  `role="switch"`: `aria-checked` carries the state, the knob is decoration. Gating blocks
  entering a state, never leaving one — off must stay clickable.

### Shell (`src/components/shell`)

- **Accordion** — the sidebar's section: bold 13px title, chevron, optional `aside` slot on
  the right (a count, an "Edit" link). Anything placed in the sidebar should be one of these.
- **Field** (sidebar) — 11px muted label over a `bg-surface-2` value box.
- **Editor panels** — sections a view places in the sidebar rather than its own column. The
  brief editor publishes its Variation Policy through `EditorPanelsProvider`: rendered
  elements are the payload, so the page keeps the state, dispatch and validation and the bar
  only places them — and the mobile menu gets them free, sharing the sidebar's content. A
  placed section renders as an ordinary `Accordion` (its `aside` carrying the issue count)
  and drops its own heading (`SectionShell compact`), because two stacked titles read as two
  sections.
- **BriefPicker**, **MobileMenu**, **TelemetryDrawer**, **CommandBar** — see §3.

### Campaign editor (`src/components/campaign`)

- **Sections** (`sections/*`) — each is a `SectionShell` (numbered `text-lg` heading with an
  error-count badge) of `Field`s (11px label, control, 11px error line beneath).
- **StatusChip** — four states, colour *and* icon: 🔴 *Draft not applied* · 🟠 *Applied,
  never saved* · 🟡 *Applied, unsaved edits* · 🟢 *Saved & applied*.
- **ErrorStrip** — one `rounded-full` chip per section with errors, red border/tint, count
  pill; clicking scrolls to the section. Lives in the action bar.
- **SaveMenu** — "Save ▾" opening upward (it sits in a footer): *Save & apply*,
  *Save as…*, each with a one-line description. `role="menu"` / `menuitem`, Escape and outside-click close.
- **EstimatePanel**, **HeadlinePoolDrawer**, **BriefSelector** — panels; a panel that can be
  in a loading, empty, error or unavailable state renders each one explicitly.
- **StatusLine** (L1.3) — `role="status"`, progressive sentence that updates as the brief is
  filled in: *New brief — fill Identity, Copy, Products and Output to make it runnable* →
  *Almost there — fill Products to make it runnable* → *Ready — Apply to run, or Save & apply
  to keep it* → *Applied — press Generate in the top bar to make ${briefId}*. Refusal
  sentence on Apply/Save with errors.
- **ErrorPill** (L1.3) — 16px count, red background, white text, rounded full. Used in
  `SectionShell` and sidebar accordion aside.
- **FloatingBar** (L1.4) — `sticky bottom-6 z-20 mx-auto w-full max-w-[800px] rounded-xl
  border border-border bg-surface p-2 shadow-2xl`. `sticky`, not `absolute` and not
  `fixed`: it must stay at the bottom of the main column's own scroll box, so a long
  brief scrolls *under* it. `absolute` anchors it to the content and it scrolls away;
  `fixed` anchors it to the viewport and it covers the 320px sidebar. Contains
  StatusLine, ErrorStrip and the action buttons — none of which is ever disabled by
  invalidity: pressing a verb is how a user asks what is wrong, so the refusal is
  spoken (see §5).

---

## 5. Patterns

**Five things, then a door.** A section shows only what a first-timer must decide; the rest
goes behind one `Disclosure` titled *Advanced*. For the variation policy that is: how many,
which shapes, which layouts, which tones, and what you will get. Seed, minimum distance,
coverage floors, background sources, palette shift and the headline axis all live behind the
door, which remembers that it was opened.

**An axis cannot be emptied.** Toggling the last selected value of an axis is refused by the
reducer rather than accepted and reported as an error: an axis with no values draws nothing,
and a control that lets you break the brief and then scolds you is worse than one that holds.
The ratio axis is the exception — it can be emptied, and says so.

**The estimate is a sentence, not a field dump.** *You will get 12 ads — 6 square, 6 tall —
for 2 products. No AI image calls.* The planner's own vocabulary (`axisProductSize`,
`genaiCalls`, `feasible`) never reaches the screen.

**Nothing is disabled for being invalid.** Pressing a primary verb is how a user asks what is
wrong, and a dead button cannot answer. Apply, Save and Save as stay live; an invalid draft is
answered by revealing every error, saying the refusal in the status line, and scrolling to the
first problem. Only work in flight (`saving`) disables a control.


**Status feedback.** Anything that changes state the user cannot see from where they are
says so in a `role="status"` line next to the control — *"Applied — Generate in the top bar
will run "clip""*. Success is `text-success`, a refusal `text-error`.

**Capability gating.** When the host cannot do something (no ffmpeg → no motion) the control
is disabled *and the reason is shown*, quoting the probe. A brief that declares the thing
stays visible and saveable (structurally valid ⇒ persistable); only running it is refused.
"Unknown" (probe unreachable, still probing) is not "unavailable" — leave the editor ungated.

**Dirty guard.** Leaving an edited draft — any shell link, the sidebar buttons, the brief
picker, the editor's own selector — prompts once, through `useGuardedNavigation`. Never
stack a second `confirm` on top of it.

**Actionable errors.** Name the field, the rule, and the fix. Prefer *"lower count to 8,
lower minDistance (at 1 the maximum is 24), or add axis values"* to *"shortfall"*.

**Text over icons.** Icons accompany labels; they do not replace them. Decorative SVGs are
`aria-hidden`. Emoji are used only inside the StatusChip, where the label carries the meaning.

**Pick the control from the field's shape, not its storage type.** Everything in a brief is
a string on the way to YAML; that is not a reason to render a text box. Ask what the value
*is*:

| The field is… | Control | In this app |
| --- | --- | --- |
| a bounded count, where the ceiling matters | **Slider** + readout | `variation.count`, bounded by `axisProductSize` — the editor cannot author a count the planner will refuse |
| a small bounded integer, often optional | **Stepper** (`allowUnset`) | `minDistance` (0…active axes, "Auto (1)"), `coverage.perProduct` / `perRatio` ("No floor") |
| a set drawn from a fixed vocabulary | **Toggle chips** (or **AxisCard** + `CreativeGlyph` when the choice is visual) | background, palette shift, formats, platforms, motion kinds (chips); layout, tone (cards) |
| an opaque value that is either automatic or exact | **Input + an action** | `variation.seed` — *Pick* fills one, *Clear* returns to automatic |
| free text | **Input** | ids, region, audience, messages |

A number input is the fallback, not the default. It accepts values the field cannot hold,
says nothing about the range, and turns a bound into an error message the user meets only
after typing.

## 6. Copy (house style, Appendix B)

1. **One voice, one file.** All user-facing strings live in `messages.ts`; no string in `validate.ts` or section files.
2. **Name the remedy.** An error says what to change, not only what is wrong: *"No selected platform packages 'motion' — add one of: instagram-story, instagram-reel…"*.
3. **No jargon.** Strings must not contain `[`, `>=`, `×`, `variation.`, `coverage.`, `axis`, `axes`, `draw`, `floor`, `package`, `planner`, `parser`, nor raw format/ratio/platform ids (`static`, `motion`, `9:16`, `instagram-feed`).
4. **Display names for values.** Formats, ratios, platforms are referred to by their display names (`Still images`, `Video`, `Square`, `Tall`, `Wide`, `Instagram Feed`) — never raw keys.
5. **Progressive status.** The `StatusLine` speaks one sentence that changes as the brief is filled in, never multiple notices.
6. **Tone rules (D13):**
   - **RED** = a structural error on a touched field or after an attempt, and the refusal sentence.
   - **AMBER** = *cannot run here* (never counted in pills/chips, never blocks Save).
   - **MUTED** = everything else (derived readouts, clamp notices).

## 7. Accessibility

- A section placed in the sidebar exists twice below `lg` (the CSS-hidden desktop bar stays
  mounted while the mobile menu shows the same content), so it carries `data-section` rather
  than an `id`, and per-instance heading ids. Navigation prefers the copy the browser has
  actually laid out.
- Every interactive element has an accessible name: visible text, `aria-label`, or a
  wrapping `<label>`. Inputs never rely on `placeholder` alone.
- Toggles use `aria-pressed`; menus `aria-haspopup="menu"` + `aria-expanded`; dialogs
  `role="dialog"` + `aria-modal` + a label; live messages `role="status"`.
- Keyboard: Escape closes anything that floats; focus is trapped inside modal overlays
  (`exerciseFocusTrap` in tests proves it); `focus-visible` rings on every control.
- Colour never carries meaning alone — pair it with text, an icon, or a count.

---

## 7. Responsive

Breakpoints are Tailwind's. `lg` is the line: below it the sidebar hides and its content
moves into the mobile menu; the header tabs collapse behind the hamburger. Wide content
(tables, YAML, the 100-creative grid) scrolls inside its own `overflow-auto` container —
the page body never scrolls sideways.

---

## 8. Testing the UI

- Vitest + Testing Library on happy-dom. **No jest-dom**: assert with plain DOM
  (`el.hasAttribute("disabled")`, `container.innerHTML === ""`), not `toBeInTheDocument`.
- Render through `renderWithRun` (`src/__tests__/helpers.ts`), which wraps the full shell
  provider tree; tests that build the tree by hand use `ShellProviders`.
- Query by role and name. When a label matches more than one control (a menu trigger and a
  dialog's confirm both called "Save"), scope with `within(dialog)` rather than loosening
  the query.
- The global fetch mock keeps its last implementation across tests: `mockClear()` and
  reinstate a benign default in `beforeEach`; `mockReset()` lets a real fetch escape.
- happy-dom does no layout. A test can prove a bar is not `fixed` and sits after the
  scrolling column; it cannot prove pixels clear. Check layout in the browser.

---

## 9. Changing the system

- **New colour or size:** add the custom property to `tokens.css` (both themes if it differs),
  map it in `tailwind.config.ts`, use the class. Never a literal in a component.
- **New component:** start from the nearest kit primitive; take colours from tokens; give it
  a role and a name; write its states (empty, loading, error, disabled) explicitly.
- **New chrome:** decide which view owns it and render it inside that view, in flow.
- **New gating:** it blocks entering a state; leaving must stay possible; the reason is visible.

Related: `README.md` (product, architecture), `docs/planning/*` (the decisions — D-ids —
behind the editor's behaviour), `AGENTS.md` (engineering conventions and the 100 % gate).
