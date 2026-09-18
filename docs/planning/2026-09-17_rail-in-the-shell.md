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
| `PREVIEW_RAIL_MIN_INLINE_PX`, `useMinInlineSize` | retire — and their tests, which is a claim the lane must state. **Amended as implemented, see §4.1: the CONTAINER mirror retires; the mirror's job does not** |
| `[container-type:inline-size]` on the editor row | **loses its only consumer.** Keep it **only** if TS2's narrow host needs it; otherwise remove. The lane must check rather than assume. **Checked and removed, see §4.2** |
| `w-64` | → `w-[320px]` |
| `border-l` | → the shared panel chrome |
| **SG2's resizer bound** | changes meaning: "must not drag below the container threshold" becomes a width bound in a shell row. SG2 has not been dispatched, so this is a spec edit, not rework |
| CC3's `LayerStack`, TS1's `TimelineTape`, `PreviewDock`, `playhead` | **ride along as children** — but see §5 |

### 4.1 RS-D4 was half right: the container mirror retires, its JOB does not

**Correction recorded rather than implemented around.** RS-D4's reason for retiring
`PREVIEW_RAIL_MIN_INLINE_PX`/`useMinInlineSize` was that they "exist **only** to
mirror" the container query, so "with a viewport gate they have nothing to mirror."
The first half is right and the second does not follow, and the mechanism is in the
hook's own doc comment: the mirror exists so a caller can *"stop the WORK, not only
hide the result"* (CC2's finding C3 — the rail *"still mounts and fetches while
hidden"*).

The new gate is still CSS-only visibility. `hidden lg:flex` hides without
unmounting — §7's own red fault 5 says so, and D43's mount count depends on it — so
below 1024px a rail nobody can see would go back to asking the route for a frame on
every look change. Deleting the mirror with the query, and its test with it, would
have lost CC2's contract silently on exactly the screens it was written for.

**What shipped:** the *container* mirror retires — the 896px constant, the
`ResizeObserver`, and the editor row it observed, none of which exist any more. A
viewport mirror replaces it (`use-viewport-min-width.ts`,
`RAIL_VIEWPORT_MIN_PX = 1024`), and the two representations are no longer a matter
of comment discipline: the test compiles the rail's shipped class string and reads
the `min-width` out of the emitted `@media` rule, so either side drifting alone
fails. `rs.json` carries the mutation.

### 4.2 `[container-type:inline-size]` — checked, and removed

**Grepped, not assumed.** The class had exactly one consumer in the tree, the
rail's own `@container` query, and it is removed with it.

- `useInlineWidth` (`use-min-inline-size.ts`) — TS1's tape fit — **does not need
  it.** It observes the tape's own scroll container with a `ResizeObserver`, which
  reads a box and not a query container.
- **TS2's narrow host does not need it either, and must not use one.** D146 spells
  the host as "at `≥56rem` it mounts in the rail … under `56rem` the tape mounts
  under `TimelineSection`", i.e. against the same container query. The two hosts
  have to be *complements* of each other or a narrow viewport shows two tapes or
  none — and a container query on the editor row cannot be the complement of a
  viewport gate on the shell column, which is precisely the 240px band this lane
  deletes. **TS2's gate is therefore a spec edit, like SG2's: it becomes the
  shell's viewport breakpoint.** TS2 is not dispatched, so this costs nothing now,
  and it is recorded here rather than left for the lane to rediscover.
- The tape under Copy will still need the *seconds*, which now live inside the
  published rail subtree (§5) — a sibling of `<main>`, not an ancestor. So TS2
  needs the subscription this plan already anticipated, not a query container.

### 4.3 Stale mutation anchors — what this lane could re-anchor, and what it could not

**Audited against both trees** (`git show origin/main:<file>` versus HEAD), because
"three anchors are stale" turned out to be wrong in both directions.

**Six are this lane's.** Three had their text only MOVED and are re-anchored in
place, with the mutation, its `because` and its command untouched: `cc1#1` (the
`<PreviewDock>` block, two columns right, into the `useCallback`), `cc3#0`
(`<TemplateSection>`) and `sg1#0` (`<LayoutSection>`), both two columns left where
the main column lost a nesting level.

**Three could not be re-anchored, and the gate proves why.** `cc1#3`
(`PREVIEW_RAIL_MIN_INLINE_PX = 896`) and `cc1#4` (`initialMinInlineSizeSeed`) are
deleted code; `sg1#3`'s `railSlot` is reshaped AND its own assertion no longer
moves, because the gate it mutates now hides an aside the *shell* publishes.

The mechanism, worth recording because it is not obvious and it decided the
outcome: `runMutation` refuses a mutation whose before-text has zero occurrences
(Rule 2), and `verify-manifests.sh` replays a manifest **whole** when any part of
it changed. So **a manifest that carries one claim about deleted code can never
pass a replay again** — and therefore re-anchoring a *different* entry in it turns
the gate red. Measured: with `cc1#1` and `sg1#0` re-anchored, `cc3.json` replayed
9 of 9 and `rs.json` 15 of 15, while `cc1.json` and `sg1.json` were refused
outright. The only ways past that are deleting another lane's claims (destroying
the evidence they are) or re-pointing them at code they never saw (asserting a
verdict nobody observed).

**So:** `cc3.json` keeps its re-anchor and replays green. `cc1.json` and
`sg1.json` are left exactly as they were on `main`, and the three properties are
carried by `rs.json`'s own mutations instead — #12 (the mount gated on the
viewport, D43's count), #13 (the JS mirror moved alone) and #14 (the
server-prerender guard removed) — each saying in its `because` why it is this
lane's claim and not cc1's or sg1's.

**Repo-level, not this lane's to fix:** the same audit found **~45 anchors already
stale before this branch** (`hl1`, `hl3`–`hl5c`, `k1a`, `s1`–`s5`, `v4`, `w2`,
`w3`, `x2`–`x31`, `ve1`, `ve2`, `ve5b1`…). Stale anchors in shipped manifests are
the repo's steady state, and `verify-manifests.sh` will never surface them,
because it only replays what a diff touched. Deciding a policy — retire, re-anchor
or archive — wants one sweep with the owner, not six lanes each guessing.

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

### 5.1 Measured: the boundary holds, and the one cost it does add is bounded at one commit

**The push does not defeat the memo boundary.** `memo` compares PROPS at a stable
position, not element identity, so an element built in `BriefEditor`'s render and
mounted in the shell's aside still bails when its props are referentially equal.
All three assertions hold in the published shape, each shown red first
(`rs.json`): zero `/preview-frame` calls for a look-preserving keystroke, no
re-render of the layer stack, the tape or the dock, and a rising form count as
liveness.

**Two things the move DID change, both measured:**

1. **The playhead's seconds moved into the published subtree.** Publishing a
   playhead-dependent element through `setRail` on every pointermove would write
   context per frame — and `BriefEditor` is itself a consumer of that context, so
   every frame would re-render the whole editor: CC2's defect through a new door.
   `PlayheadHost` is therefore mounted *inside* the rail rather than wrapped around
   the editor's column, which is possible because nothing in the main column reads
   the playhead. A drag writes no context at all; five frames leave the form's
   counter at zero. `PlayheadHost`'s `children` prop — the element-identity bailout
   the main column used to rely on — is gone with the reason for it, and the
   property it provided is now structural: the form is not in the playhead owner's
   subtree at all.
2. **The publisher must not subscribe to its own publication — found by mutation,
   fixed at the cause.** With the setters on the same context as the slots,
   publishing re-rendered the publisher: gesture → editor render → effect →
   `setRail` → context change → editor render. Two consequences, one measured as a
   cost and one as a hang:

   - a gesture that changes something the rail reads cost the editor an extra
     commit (a layer pick went 1 → 2);
   - **`railSlot`'s dependency list is maintained by hand** (the react-hooks lint
     plugin is not wired into this project's eslint config), and one unmemoised
     value in it closed the cycle with no fixed point. `rs.json`'s mutation
     dropping `layerStack`'s `useMemo` — a cost regression of exactly the #469
     shape — **spun a worker at 100% CPU for 22 minutes** instead of failing a
     render-count assertion. A livelock is a worse failure mode than the defect it
     replaced.

   **Fixed by splitting the context**: `useEditorPanels` reads the slots, a second
   context (`useEditorPanelPublisher`) carries the setters and is allocated once
   for the life of the provider. The editor subscribes to nothing it publishes
   into, so a publish cannot re-enter it. The same mutation now fails in **0.98 s
   with `expected 7 to be 5`**, the layer pick is back to **one** commit, and the
   extra commit the left bar's `panels` channel has paid since X32 is gone too.
   This is not a widened memo and not a deep compare: it is the publisher no
   longer being one of its own subscribers.

3. **Two of §5's own mutations were mis-aimed, and the replay said so.** Both
   assertions passed, and both would have passed on a defect:

   - **(1) zero fetches.** Feeding the dock the live `draftBrief` instead of the
     memoised one *survived*: it defeats the memo and re-renders the dock, but
     issues no request, because `usePreviewFrame` keys on a content fingerprint
     and not on its component's renders. The assertion pins `previewFetchKey`,
     so the mutation now widens that key with a field no request reads — the
     "include the whole brief, to be safe" change — and it goes red.
   - **(3) the form's count rises.** A reducer that dropped the edit *survived*,
     because the helper clicked the field before typing and the editor's own
     click capture re-rendered the form: the count rose for the gesture, not for
     the edit. The click is gone; the mutation is now the field's handler doing
     nothing, and (1) and (2) stay green on it — the vacuous shape, demonstrated
     rather than described.

   Worth stating plainly, because it is the second time in this lane that a
   green assertion was the wrong assertion: **the mutation replay is what found
   both, and neither was visible from reading the test.**

4. **And a third time, found in review: the unmount test could not fail.** It
   called `view.unmount()`, which tears down `EditorPanelsProvider` along with
   the editor — so the aside went away because the state holding it was gone, not
   because `BriefEditor` had cleared its slot. Deleting
   `useEffect(() => () => setRail(null), [])` left it green **and left the whole
   web project green**. The property it claimed to guard is a CLIENT NAVIGATION
   off `/brief`, where the shell persists and only the page swaps; the test now
   keeps the shell mounted and rerenders the child, which is that shape, and
   `rs.json` carries the deletion. The adjacent M3/D83 branch (`setRail(null)` on
   not-found and failed-listing) was executed but unasserted, and has a test and
   a mutation of its own now.

   **Five vacuous or mis-aimed assertions in one lane, four of them mine.** The
   pattern is worth naming: every one of them was about a *mechanism the test
   could not reach* — a provider torn down with its subtree, a click that
   re-rendered what the keystroke was supposed to, a fetch key the memo does not
   feed, a render count read as "more than none". None was visible from reading
   the test; each needed the mutation run.

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

**`premise RS2` retired: RS2 shipped in the same PR as RS1.** The container query
is gone from `BriefEditor.tsx` — the string the fence probed appears nowhere in
the tree — so it would report the lane stale rather than live. What replaced it is
stronger than a grep either way: `rail-in-shell.test.tsx` compiles the rail's own
class string with the project's Tailwind config and asserts the gate is a viewport
`@media` at exactly `RAIL_VIEWPORT_MIN_PX`, that no `@container` rule is emitted at
all, and that the landmark is in the accessibility tree at 1024px and out of it at
1023px while staying mounted.
