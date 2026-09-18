# The rail becomes a shell sidebar — one container, two sides, no container query

**Date:** 2026-09-17 · **Status:** draft, for the owner's approval. **Nothing dispatched.**
**Verified against:** `origin/main` at `484fdf6b`.
**Source:** the owner, 2026-09-17 — *"The right sidebar should re-use the left sidebar container, it should span the full height of the browser view just like the left sidebar"*, then *"make it a part of the main shell and then reveal it based on view."*
**Related:** `2026-09-17_wireframe-gap.md` (§9 SG-D16/17/18, SG2, SG11), `2026-09-16_creative-first-chrome.md` (CC1/CC2's cost contract, CC3 shipped), `2026-09-16_rail-timeline-surface.md` (TS1 shipped), `DESIGN.md` §3.

---

## 1. The two containers today

| | Left sidebar | Right rail |
|---|---|---|
| **Where** | `Sidebar.tsx:19` — direct child of the shell row, **sibling of `<main>`** | `BriefEditor.tsx:1899` — **three levels inside** `main`'s scroller (`layout.tsx:42`) |
| **Height** | `h-full`, `overflow-hidden` + inner `flex-1 overflow-y-auto` | `sticky top-0 max-h-screen self-start overflow-y-auto` |
| **Width** | `w-[320px]` | `w-64` (256px) |
| **Chrome** | `rounded-xl border border-border bg-surface shadow-2xl` | `border-l` only — a divider, not a panel |
| **Gate** | `lg:flex` — a **viewport** media query | `[@container(min-width:56rem)]` — a **container** query |

**The rail cannot be full-height where it lives.** It is inside the scrolling div, so `h-full` means "as tall as the scrolled content", not "as tall as the browser". Full height requires becoming a sibling of `<main>`.

### 1.1 Why the gate difference is the whole bug we chased today

The rail's container is `viewport − 368px` (32 page padding + 320 left sidebar + 16 gap), so `56rem` resolves to **1264px of viewport** — measured, not computed. The left sidebar's `lg:` is **1024px**.

That 240px gap is why the rail was invisible on the owner's screen for two days while every merge landed correctly. **Moving the rail to the shell replaces the container query with `lg:` and removes the defect structurally**, rather than by choosing a better number.

---

## 2. The seam already exists

`BriefEditor` already pushes rendered panels **up** into the shell, and the left sidebar already renders them conditionally:

```
BriefEditor.tsx:341    const { setPanels, setTopPanels } = useEditorPanels();
BriefEditor.tsx:1232   useEffect(() => () => setPanels(null), []);   // clears on unmount
Sidebar.tsx:83,234     const { panels } = useEditorPanels();  …  {panels ? (…) : null}
```

That is how Variation Policy already reaches the left sidebar. **Nothing new has to be invented** — the right sidebar is a second consumer of a mechanism in production.

`Sidebar.tsx:74` also already separates body from chrome: *"The brief + project-bin panel body, without the desktop `<aside>` chrome — shared."* The chrome is therefore the thing to extract.

---

## 3. Decisions

| ID | Question | Decision |
|---|---|---|
| **RS-D1** | Where does the right sidebar live? | **The shell**, as a sibling of `<main>` and of the left sidebar — the only position that can be full-height. |
| **RS-D2** | Does it reuse the left container? | **Yes, via an extracted `SidebarShell`.** `Sidebar.tsx:19`'s chrome becomes a component both sides wear, so the two cannot drift. `w-[320px]` for both; `w-64` retires. |
| **RS-D3** | **Route-gated or presence-gated?** | **Presence-gated.** Render the aside when rail content exists, not when the path matches. *(The owner asked "reveal it based on view"; this is that, expressed as content rather than as a route list.)* **Why:** the shell then knows nothing about routes, a future view needs no shell edit, `/brief` vs `/brief/new` vs later views cannot drift out of sync — and, decisively, **a route check can be right about the route and wrong about the content**, which is exactly the 256px empty strip that shipped today. Presence cannot be. The precedent for route-gating (`CommandBar`, `layout.tsx:25,72`) is a genuine alternative and is rejected for these reasons, not overlooked. |
| **RS-D4** | What happens to the container query? | **Retires**, along with its JS mirror. `PREVIEW_RAIL_MIN_INLINE_PX = 896` (`use-min-inline-size.ts:12`) and `useMinInlineSize` exist **only** to mirror it; with a viewport gate they have nothing to mirror. |
| **RS-D5** | What replaces it below `lg`? | **SG11 unchanged, and now symmetric.** The right panel joins the same narrow-width route the left one already has (`MobileMenu` shares `SidebarContent`), so SG-D16's segmented control carries both sides through one mechanism instead of two. |
| **RS-D6** | Variation Policy | **STAMPED (owner, 2026-09-17): it stays in the sidebar.** SG1 (#479) declared that retiring `guided` leaves Policy as the compact sidebar accordion only, losing its full-width step card. That is accepted. **This unblocks #479.** |

---

## 4. What this invalidates — none of it silently

| Thing | Fate |
|---|---|
| `[@container(min-width:56rem)]` on the aside | retires (RS-D4) |
| `PREVIEW_RAIL_MIN_INLINE_PX`, `useMinInlineSize` | retire — and their tests, which is a claim the lane must state |
| `[container-type:inline-size]` on the editor row | **loses its only consumer.** Keep it **only** if TS2's narrow host needs it; otherwise remove. The lane must check rather than assume |
| `w-64` | → `w-[320px]` |
| `border-l` | → the shared panel chrome |
| **SG2's resizer bound** | changes meaning: "must not drag below the container threshold" becomes a width bound in a shell row. SG2 has not been dispatched, so this is a spec edit, not rework |
| CC3's `LayerStack`, TS1's `TimelineTape`, `PreviewDock`, `playhead` | **ride along as children** — but see §5 |

---

## 5. The one risk: CC1/CC2's cost contract was measured in the old position

This is where the change could quietly undo work that shipped today.

CC1/CC2 built a memo boundary so *"a look-preserving keystroke issues zero `/preview-frame` calls"*, and CC3 and TS1 were both accepted against a **re-render** assertion as well, after a fresh object per render was found defeating a `memo`-wrapped child while every fetch assertion stayed green.

Pushing the rail's children through `setPanels` means **rendered elements cross the boundary as a prop** — which is how `panels` already works, but the cost property was never measured in that shape.

**The lane must re-prove it, not inherit it:**

- a look-preserving keystroke issues **zero** `/preview-frame` calls;
- the same keystroke does **not** re-render the layer stack or the tape;
- the form's own render count still rises (liveness — so the assertion cannot pass on an editor that ignored the event).

**If the push defeats the boundary, that is a finding: report it and stop.** Do not widen the memo, do not memoise `panels` by deep-compare, and do not accept "it looks smooth."

---

## 6. Lanes

| Lane | Owns | Ships |
|---|---|---|
| **RS1** | `Sidebar.tsx` | **Extract `SidebarShell`** — the `<aside>` chrome, no behaviour change. Left sidebar wears it; the rendered DOM is byte-identical. |
| **RS2** | `(shell)/layout.tsx`, `editor-panels-context`, `BriefEditor.tsx` | **The right sidebar**: presence-gated, full-height, wearing `SidebarShell`; rail content pushed through the existing slot; container query and JS mirror retired. |

**Order.** RS1 → RS2. They share `Sidebar.tsx`, and RS1 with an identical-DOM proof makes RS2's diff readable.

**Contention.** RS2 touches `BriefEditor.tsx`. **SG1 (#479) must merge first** — it is `+847/−3,899` in that file and rebasing RS2 under it would be worse than waiting.

---

## 7. Definition of done

- **RS1** — the left sidebar's rendered markup is **unchanged**, asserted by snapshot or by class-string equality. A lane that "tidies" a class while extracting has changed behaviour it did not declare.
- **RS2** — at a viewport of **1024px** the right sidebar is present and full-height (its box height equals the row's); at **1023px** it is absent and reachable through SG11's control. Reverting the gate to a container query fails the test.
- **RS2** — the aside is **absent** on a route that pushes no rail content, and **present** on `/brief/new`. Asserted by querying for the landmark, not by path.
- **RS2** — §5's three cost assertions, each broken and shown red.
- **RS2** — **exactly one composed frame mounted** (D43) survives the move; assert by mount count, since neither gate unmounts.

---

## 8. What this plan does not do

- **It does not restyle the rail's contents.** Preview, layers, timeline and the playhead move as they are.
- **It does not build SG11.** RS2 makes the narrow-width case symmetric with the left sidebar; the control is still SG11's.
- **It does not touch the left sidebar's content**, only its chrome's location in the file.
- **It does not widen the rail's scope.** Same children, same order, new container.

---

## 9. Premises

**`premise RS1` retired: RS1 shipped.** The chrome is `SidebarShell`
(`apps/web/src/components/shell/SidebarShell.tsx`), worn by `Sidebar` and — the
point of the extraction — by the right-hand column, so the class string the fence
probed is no longer in `Sidebar.tsx` and the fence would report the lane stale
rather than live. The property it guarded is now a test, not a grep: the left
sidebar's rendered `<aside>` carries exactly that class and no other attribute
(`SidebarShell.test.tsx`), asserted as a literal so it cannot drift with the
component it checks.

```premise RS2
# The rail is still container-gated inside the editor. Flips when it moves to the
# shell with a viewport gate. Probes BriefEditor for the container query rather
# than the layout for an aside -- the layout already has one (the left sidebar),
# so an aside-count fence would never flip. Measured: ~20 ms.
grep -q '@container(min-width:56rem)' apps/web/src/components/campaign/BriefEditor.tsx
```
