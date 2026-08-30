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
2. **Dark first, and light is reachable.** The root layout renders `class="dark"` on
   `<html>`; the dark block in `tokens.css` is the "Firefly" palette the product ships
   with and the one the server sends. Light is the un-classed `:root`, and the header's
   theme toggle takes the class off — so light is a theme a user can actually see, and
   every value in both blocks is measured against the ground it is painted on (§2).
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
| `--color-border` | `#e2e8f0` | `#333333` | `border-border` | every hairline: frames, rules, ticks, fills |
| `--color-border-hover` | `#cbd5e1` | `#444444` | `hover:bg-border-hover` | hover fills (and decorative hover edges) |
| `--color-border-control` | `#78889b` | `#757575` | `border-border-control` | a control's own edge, where its fill does not distinguish it from its ground (WCAG 1.4.11) |
| `--color-border-control-hover` | `#64748b` | `#8f8f8f` | `hover:border-border-control-hover` | the hover of that edge |
| `--color-text-primary` | `#0f172a` | `#e8e8e8` | `text-text-primary` | body |
| `--color-text-secondary` | `#475569` | `#9e9e9e` | `text-text-secondary` | supporting copy |
| `--color-text-muted` | `#5b6b80` | `#9e9e9e` | `text-text-muted` | labels, hints, captions |
| `--color-text-emphasis` | `#0f172a` | `#ffffff` | `text-text-emphasis` | headings, and the inverse of the page ground |
| `--color-scrim` | `#000000` | `#000000` | `bg-scrim` | overlays, modal backgrounds |
| `--color-success` | `#065f46` | `#10b981` | `text-success` `bg-success/20` | applied, passed |
| `--color-warning` | `#92400e` | `#f59e0b` | `text-warning` `bg-warning/20` | unavailable, degraded |
| `--color-error` | `#991b1b` | `#ef4444` | `text-error` `bg-error/20` | validation, refusals, rejected |
| `--color-info` | `#1e40af` | `#3b82f6` | `text-info` `bg-info/20` | provenance, informational |
| `--color-modified` | `#6d28d9` | `#c4b5fd` | `text-modified` `bg-modified/20` | changed since the last apply or save |
| `--color-brand-tint` | `#cadff8` | `#1a2d44` | `bg-brand-tint` | opaque tint for FIREFLY badge |
| `--color-brand-on-tint` | `#0b4a8c` | `#7cc4ff` | `text-brand-on-tint` | text on brand tint |

Semantic colours (success / warning / error / info / modified) carry state. The brand blue is
*not* a state colour; do not use it to mean "good".

**The two themes no longer share a semantic value.** A state colour is painted two ways — as
text on its own 20 % tint (chips, pills, badges) and as a solid ground behind white text (the
destructive `Button`) — and one value cannot do both jobs across two grounds. The dark set fits
the second; on a light ground it failed the first at 1.7–3.1 : 1. Light therefore carries the
same hues down the ramp, and both blocks state all five. The light text ramp moved for the same
reason: at `slate-400` `muted` measured 2.3 : 1 on `surface-2`, and `muted` now sits between
`slate-500` and `slate-600` because the ramp has no step there that clears 4.5 : 1 on that
ground — the darkest it is painted on. See the W3.2 audit below for the measurements.

Every colour maps to a `color-mix(in srgb, var(--color-x) calc(<alpha-value> * 100%), transparent)` form in `tailwind.config.ts`. This permits native Tailwind opacity modifiers like `bg-error/20` and `hover:bg-border/40` on tokens without defining separate `-alpha` scales in CSS. Arbitrary alphas require bracket syntax, e.g. `bg-black/[0.08]`.

**The boundary rule: `border-border` frames things, `border-border-control` bounds controls.**
`--color-border` was deliberately left alone — it is double-booked. It is a *fill* (`bg-border`
skeleton loaders, sidebar rules) and it paints ~119 decorative hairlines (card frames, dialog
frames, `divide-border` row rules, table rules, image rims, tick marks), which 1.4.11 exempts;
a 3 : 1 value would turn skeletons into mid-grey blocks and the whole app into a wireframe.
But a control whose fill differs from its ground by almost nothing (`surface` on `background`
is 1.05 : 1; `surface-2` on `surface` is 1.05 : 1 light, 1.13 : 1 dark) is identified *only*
by its hairline, so that hairline — the control's own edge, and its hover — uses
`border-border-control`, which clears 3 : 1 on the worst ground each theme draws on.

### Themes

Two themes, one bit of state: the `dark` class on `<html>`. Everything else follows from it,
including `color-scheme`, which is declared in **both** blocks so native controls, form
widgets, scrollbars and the default canvas follow the palette instead of staying light under a
dark theme.

| Part | Where | Why it is there |
|---|---|---|
| `class="dark"` | `app/layout.tsx` | The server's answer. It has no `localStorage`, so it always sends dark. |
| `THEME_BOOT_SCRIPT` | inline, first child of `<body>` | Corrects the class **before first paint**. It cannot go in `<head>`: App Router renders head children into the flight payload but not into the document shell, so they only apply after hydration — which is the flash this exists to prevent. |
| `cf:theme` (`"light"` \| `"dark"`) | `localStorage` | The remembered choice. Anything that is not exactly `"light"` reads as dark, so no stored value ever needs migrating. |
| `ThemeToggle` | `Header` | The control. 32px `IconButton`; see §4. |
| `readStoredTheme` / `storeTheme` / `applyTheme` | `lib/theme.ts` | Every access is wrapped: a private window, a disabled store and a full quota are ordinary, and a toggle that throws takes the header down with it. A blocked or absent store reads as dark and never throws. |

The toggle's first render is always the dark default and the stored theme is adopted on mount,
not in the initialiser — the server has no storage, so reading it during render would produce
one tree on the server and another in the browser. `Disclosure` is the same shape for the same
reason. The boot script has already corrected the class by the time the toggle mounts, so what
is painted and what the control says agree.

### W3.2 — the light-theme audit

Light was a complete palette nobody had ever seen. Every surface W0/W0b/W2a/W2b/W9/W10 touched
was measured against a light ground in this pass. Contrast is WCAG 2.1 relative luminance;
small text (10–13 px) needs **4.5 : 1**, a control boundary **3 : 1**.

**Fixed**

| What | Where | Measured (light, before → after) |
|---|---|---|
| Three of the four `bg-white` / `text-black` / `hover:bg-gray-200` pills | `export/page.tsx`, `CommandBar.tsx` ×2 → `bg-text-emphasis text-background hover:opacity-90` | invisible: a white button on a white ground. The pill is now the inverse of the ground in both themes — 17.9 : 1 light, 19.2 : 1 dark. The fourth is recorded below, because its ground is not the page |
| `StatusChip`'s fourth state (`yellow-400`) | `StatusChip.tsx` → `--color-modified` | 1.4 : 1 on its own tint → 4.67 : 1. A new state colour, not a second `warning` (UE-D11) |
| The semantic tints — `ErrorPill`, the three other chip states, the grid source and compliance badges, `MiniChip`, `FieldLine` | `tokens.css` → a light semantic set | 1.7–3.1 : 1 → 4.67–6.19 : 1 |
| The light text ramp | `tokens.css` | `muted` 2.3 : 1 → 4.97 : 1 on `surface-2`; `secondary` 4.3 : 1 → 6.9 : 1 on the same ground |
| The telemetry log panel | `TelemetryDrawer.tsx` → `bg-surface-2`, skeletons to `bg-border` | `text-text-primary` on `#000000` was **1.18 : 1** — unreadable. A ground that is black in both themes cannot carry theme text |
| `SwitchRow`'s knob | `switch-row.tsx` → `bg-text-emphasis` | a white knob on the near-white `surface-2` rail was 1.1 : 1 — no edge at all. Now 16.3 : 1 off and 3.9 : 1 on the brand rail (light), 15.1 : 1 / 4.5 : 1 (dark) |
| The secondary `Button` hover | `button.tsx` → `hover:bg-border-hover` | `bg-border/40` over `surface` is a **1.07 : 1** shift — not a hover. Now 1.42 : 1 light / 1.75 : 1 dark |
| The grid's *can't play* pill | `grid/page.tsx` → `bg-surface` | `text-error` on a 70 % scrim measured 1.30 : 1 in the light theme (2.26 : 1 dark): a translucent ground over a clip hands its contrast to the video. Now 7.9 : 1 light / 4.5 : 1 dark |
| The FIREFLY provenance badge | `grid/page.tsx:390` → an opaque `brand-tint` / `brand-on-tint` pair | 3.34 : 1 light / 3.06 : 1 dark on `bg-surface` — and **2.34 : 1** for the same badge over the lightbox's scrim. Now 6.50 : 1 / 7.45 : 1, ground-independent |
| The lightbox chrome — close, caption, asset label | `grid/page.tsx:730,760,763` → fixed white | `bg-scrim/80` is black in both themes, so over the **light** page it composites to `#333333`: `text-text-muted` was 2.32 : 1 and `text-text-primary` **1.41 : 1**. Now 7.09 : 1 and 12.63 : 1 light, 9.84 : 1 and 20.6 : 1 dark |
| Control boundaries below 3 : 1 (WCAG 1.4.11) | new `--color-border-control` / `--color-border-control-hover` pair, repointed at the controls' own edges (Input, Button secondary's border, Stepper, ChipGroup, SwatchChip's button, SwatchPicker, AxisCard, PreviewCard, PlatformCard, SwitchRow's off rail, ModelSelector's trigger) | `border-border` measured 1.13–1.23 : 1 light and 1.35–1.52 : 1 dark — no perceptible edge for a control whose fill is 1.05 : 1 from its ground. The new token clears 3 : 1 on the worst ground its theme draws on: 3.31 : 1 light (3.62 / 3.46 on `background` / `surface`), 3.28 : 1 dark (4.16 / 3.70); hover 4.34 : 1 light, 4.68 : 1 dark. `--color-border` itself is unchanged — see the boundary rule in §2 |

**Found, not fixed** — each needs a decision this lane must not take alone:

- **Dark's own tints sit below 4.5 : 1 — on every ground, not only `surface-2`.** An earlier
  pass measured this against `surface-2` alone and so understated it; the chip idiom
  (`bg-X/20 text-X border-X/50`) is painted over all three grounds. Measured per ground:

  | | `background` `#0f0f0f` | `surface` `#1c1c1c` | `surface-2` `#262626` |
  |---|---|---|---|
  | `error` | 4.12 : 1 | 3.63 : 1 | 3.24 : 1 |
  | `info` | 4.13 : 1 | 3.60 : 1 | 3.21 : 1 |
  | `success` | 5.56 : 1 | 4.84 : 1 | 4.29 : 1 |
  | `warning` | 6.25 : 1 | 5.40 : 1 | 4.79 : 1 |
  | `modified` | 6.96 : 1 | 5.90 : 1 | 5.21 : 1 |

  So `error` and `info` fail on *all three*, and `success` fails on `surface-2` only —
  `warning` and `modified` clear it everywhere. Raising the failing values collides with their
  second job: `Button`'s destructive variant is `bg-error text-white`, and a lighter red puts
  white text below 4.5 : 1 on it. No single value serves both; it needs a `-tint` token pair,
  and the ~40 call sites that spell `/20`.
- **`grid/page.tsx`'s *Preview* pill keeps `bg-white text-black hover:bg-gray-200`, and gains
  a `ring-1 ring-scrim`.** It is the fourth pill the audit was asked about, and the one whose
  ground is not the page. Tokenising it to `bg-text-emphasis` would make it near-black on
  near-black in the light theme (1.41 : 1, down from 12.6 : 1), so the literal stays — but the
  first version of this note justified it as sitting on `bg-scrim/80`, which is only the still
  tile. A **motion** tile keeps the scrim at `/40` so the clip stays visible, and there the
  pill's ground is the video: over a white frame a 40 % black scrim composites to `#999999`,
  against which a white pill is **2.85 : 1** — below the 3 : 1 a control boundary needs
  (WCAG 1.4.11). The ring fixes it in both directions without touching the fill, because a
  black ring reads against a light frame (7.37 : 1) and the white fill reads against a dark
  one (21 : 1); the worst case over any frame is now 7.37 : 1. A translucent ground hands its
  contrast to whatever is behind it, so a control on one needs a boundary of its own.

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
| Section heading | `text-lg font-semibold text-text-emphasis` |
| Panel / dialog title | `text-sm font-semibold text-text-emphasis` |
| Body, controls | `text-sm` (14px) / `text-[13px]` |
| Field label | `text-[11px] text-text-muted` |
| Group label (eyebrow) | `Eyebrow` — `font-mono text-[11px] uppercase tracking-eyebrow text-text-muted` (`tracking-eyebrow` is `0.08em`, a token in `tailwind.config.ts`) |
| Hint, caption, badge | `text-[11px]` / `text-[10px]` |

The 70 existing `text-white` occurrences across 29 files migrate to `text-text-emphasis` in lane W0b.3; the table above is the instruction for new code.

### Spacing, radius, elevation, motion

- Spacing: Tailwind's 4px scale (`--space-*` mirror it). Panels pad `p-4`; dialogs `p-6`;
  rows `px-3 py-2`.
- Radius: `--radius-sm` 4px (inputs' inner), `--radius-md` 8px (buttons, inputs, rows),
  `--radius-lg` 12px (panels, cards, dialogs, the sidebar), `--radius-full` for chips and pills.
- Shadow: `--shadow-sm` on cards; `--shadow-md`, `--shadow-lg`; `--shadow-2xl` on floating chrome (sidebar, menus, drawers).
- Motion: `--duration-fast` 150ms for hover/colour, `--duration-normal` 250ms for
  open/close, `--duration-preview` 2400ms. `--easing-default` for UI, `--easing-preview` for the creative preview. `transition-colors` is the default; respect `prefers-reduced-motion` for
  anything larger.
- **Looping previews** (L4.3): the four motion kinds each have a keyframe animation in
  `globals.css` — `kf-ken-burns-in`, `kf-ken-burns-out`, `kf-headline-rise`,
  `kf-accent-wipe` — played on the glyph inside a `MotionKindPanel` so a user sees the
  transition rather than reading its name. Loading indicators (`animate-spin` in `Button`, `CommandBar`, grid; `animate-pulse` in `ProbeRow`) are the only other permitted loops. Every
  other animation in the system is a one-shot on interaction.
- **A loop is never the only carrier of meaning.** Each motion glyph renders a static cue
  group *as well as* the animated one, always, so the kind is legible with animation off.
  Under `prefers-reduced-motion` and on a disabled card the animation does not run and the
  cue is what remains — the reveal is CSS-only, never a `paused` animation, because a paused
  animation still says "this is moving" to anything reading the DOM.

---

## 3. Shell anatomy

**Routes.** `/grid` (the app opens here), `/brief`, `/brief/new`, `/compliance`,
`/export`, `/runs`. There is one campaign editor and it lives at `/brief`; `/brief/new`
is that same editor started empty, and `/new` — the step wizard's old address — redirects
to it. Making the blank start a *route* rather than a button's side effect is what keeps
"the user asked for an empty brief" true for the whole life of the page: the editor
otherwise adopts whichever brief the shell has active, and a blank draft is pristine, so
it passes every dirty guard that would have held that off. Arriving there also releases
the campaign being left — the shell's active brief and its saved draft both — because a
brief nobody is editing must not still be the one **Generate** would run.


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
- **ChipGroup** (L3.2) — a labelled set of single-select chips with an *Other…* escape that
  reveals a free-text input. Same a11y contract as `AxisCard` — the accessible name of every option
  chip is exactly its raw value (`aria-label={option}`), keeping queries and assistive tech stable.
  Used for fixed vocabularies that allow custom values, such as Target Region.
- **SwatchPicker** (L3.4) — an 8-swatch colour selector paired with a mono hex readout. Swatches
  carry `aria-label` with their hex value; the active swatch reflects both click selection and
  typed hex matches. It offers the brand palette at a single click while preserving arbitrary
  hex inputs for custom themes.

- **PlatformCard** (L4.2) — one card per delivery platform, showing `PlatformProfile.label`
  and its shape through a `PreviewFrame`. The accessible name stays the raw platform id, as
  every card in this kit does; the label is what the screen reads.
- **PreviewFrame** (L4.2) — the aspect-correct frame a card's preview sits in, so a 9:16 and
  a 1:1 card are visibly the shapes they name rather than two equal rectangles.
- **FormatPanel** (L4.4) — Still images and Video as two cards, gated per card by
  `formatGate()` rather than by one blanket switch: a host without ffmpeg disables the Video
  card *and says why on that card*, instead of hiding the choice. The visible label is the
  display name (D18) while the accessible name stays `static` / `motion`.
- **MotionKindPanel** (L4.5) — one card per motion kind, each playing its own transition.
  Turning Video on seeds the domain's default kinds into a fresh draft and turning it off
  again retracts them while untouched (D9), so an accidental toggle leaves no trace.
- **ProbeRow** (L4.2) — what this host can actually do, from the boot probe: ffmpeg found or
  not, its version when the probe could read one, and the reason when it could not.
- **DurationStrip** (L4.6) — clip lengths as a film strip on a 0-based 31-column axis. Beads
  are dragged along the reel; a click on empty reel adds one; the last remaining length can
  still be removed. Values loaded from a brief are clamped into place rather than producing
  an out-of-range column. It carries a `lanes` slot, which the copy timeline (L6) mounts into
  so beats line up against the same seconds axis.
- **ThemeToggle** (W3.1 / SHELL-08) — the header's 32px `IconButton`, sun when dark and moon
  when light. **The accessible name states the action, not the state** — *"Switch to the light
  theme"* while dark — so it is deliberately *not* `aria-pressed`: a name that says where the
  user is leaves nothing to say about the button they are on, and a pressed state on a control
  whose label changes would report the same fact twice in two directions. (§7's `aria-pressed`
  rule is about state *toggles* — `SwitchRow`, a play/pause — whose label is fixed; this is an
  action button whose label moves with the state.) It renders the server's dark default first
  and adopts the stored theme on mount, so it never disagrees with what the pre-paint script
  has already put on `<html>`.

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
- **LogoField** (L3.4) — brand asset upload rendered as a dashed drop tile that transforms into an
  image thumbnail (or file-type badge when unrendered directly) once populated. The path is relegated
  to 10px monospace meta, elevating visual identity over filesystem mechanics. Houses the *Upload* action
  and an optional *Choose from bin* affordance (when wired), with explicit uploading states.
- **StatusChip** — four states, four colours, border/tint/dot (no emoji): *Draft not applied*
  (error) · *Applied, never saved* (warning) · *Applied, unsaved edits* (modified) · *Saved &
  applied* (success). UE-D11 requires the four to stay colour-distinct, so the third is its own
  `--color-modified` state colour rather than a second amber (§2, and the W3.2 audit).
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
- **TimelineSection** (L6-E5) — the copy-sequence sub-panel inside Copy, shown only on a
  Randomized draft (only a Randomized brief renders motion). One row per beat: text `Input`,
  a share `Stepper` bounded `[1, MAX_WEIGHT]`, a *Poster frame* toggle (`aria-pressed`, and
  exactly one beat carries it), reorder arrows disabled at the ends, and remove.
  - **Add beat** is disabled *with the reason beside it*, never silently. Two reasons, and
    they are different sentences: the sequence is at its beat ceiling, or another beat would
    drop one under the readability floor on the shortest clip. The reason is re-derived on
    every render by simulating the click and asking the domain — so **narrowing the duration
    axis re-answers it** with no control to disable, which is the case a click-time check
    misses.
  - This is an exception to §5's *never disable a verb*, and only because *Add beat* is not
    a verb in that sense: it does not commit the draft. Save and Apply stay live and refuse
    out loud, as ever. What the editor guarantees is **detection plus refusal to run**, not
    prevention — narrowing the axis after the fact breaches the floor with every control
    enabled, and the flag, not the control, is what catches it.
- **ProportionBar** (L6-E5) — one 24px bar per clip length in the duration axis, each
  segment's width and label taken from the compositor's own `resolveTimeline`. Segments
  under the floor take the error tint and say so in words as well as colour. It computes
  nothing itself: a bar that divided the weights would agree with the domain until the
  domain changed, then be quietly wrong.
- **ErrorPill** (L1.3) — `min-w-[18px]` count, `bg-error/20` background, `text-error`, rounded full. Used in
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
goes behind one `Disclosure` titled *Advanced*. For the variation policy those five are: how
many (Count), which shapes (Aspect ratios), which layouts, which tones, and what you will get
(Estimate). Seed, minimum distance, the coverage floors, background sources, palette shift and
the headline axis all live behind the door, which remembers that it was opened.

**A number the user cannot have is lowered, and says so.** Narrowing an axis below the
requested count clamps it to what the axes can produce and states the new figure once
(`role="status"`); the next edit to the count takes the notice down. A silent clamp and a
red error are both worse: one hides the change, the other blames the user for it.

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
`aria-hidden`.

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
  `role="dialog"` + `aria-modal` + a label; live messages `role="status"`. The one exception
  is a control whose name already states the action — `ThemeToggle` — where a pressed state
  would say the same thing twice (§4).
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
