"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Eyebrow } from "@/components/ui";
import { Panel, PanelGroup } from "react-resizable-panels";
import { RunProvider, useRun } from "@/lib/run-context";
import { RAIL_VIEWPORT_MIN_PX, useViewportMinWidth } from "@/lib/use-viewport-min-width";
import { EditorDirtyProvider } from "@/lib/editor-dirty-context";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { EditorPanelsProvider, useEditorPanels } from "@/lib/editor-panels-context";
import { MobileRailProvider, useMobileRail } from "@/lib/mobile-rail-context";
import { Header } from "@/components/shell/Header";
import { Sidebar } from "@/components/shell/Sidebar";
import { SidebarShell } from "@/components/shell/SidebarShell";
import { ColumnResizeHandle } from "@/components/shell/ColumnResizeHandle";
import { CommandBar } from "@/components/shell/CommandBar";
import { TelemetryDrawer } from "@/components/shell/TelemetryDrawer";
import { BriefPicker } from "@/components/shell/BriefPicker";
import { CreateCampaignDialog } from "@/components/shell/CreateCampaignDialog";
import { TemplateLibrary } from "@/components/shell/TemplateLibrary";

/**
 * The primary application shell: persistent header, brief/asset sidebar, the
 * pipeline command bar, and the telemetry drawer. Workspace views render into
 * `{children}` and read shared run state from RunProvider.
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  // The orchestrator (Execute + telemetry) only belongs on the review grid — that's
  // where the creatives and the approve/reject flow live. Other views are read-only
  // reports, so the floating bar would just obscure content there.
  const showOrchestrator = usePathname().startsWith("/grid");

  return (
    <RunProvider>
      <EditorDirtyProvider>
        {/* W1 — the create moment's open state and seed channel, one provider under
            the guard so every entry point can ask (D67) and then open the dialog. */}
        <CreateCampaignProvider>
          <EditorPanelsProvider>
            {/* SG11 — whether the rail has been summoned below `lg`. Inside the
                panels provider because the overlay reads the same slot the shell
                column does, and above `Header` because the control that opens it
                is in the mobile menu. */}
            <MobileRailProvider>
              <div className="flex h-full flex-col">
                <Header />
                <div className="relative z-0 flex flex-1 gap-4 overflow-hidden bg-background p-4">
                  <Sidebar />
                  <EditorColumns showOrchestrator={showOrchestrator}>{children}</EditorColumns>
                </div>
              </div>
              <MobileRailOverlay />
              {/* The shell overlays share this layer: the picker closes before the
                create dialog opens (F22 — two DialogShells at one layer stack two
                scrims and two key handlers). Each renders null while closed, so
                exactly one `[role=dialog]` is ever in the document — the template
                library's detail view is a swap of its own body, not a fourth
                entry here (T6). */}
              <BriefPicker />
              <CreateCampaignDialog />
              <TemplateLibrary />
            </MobileRailProvider>
          </EditorPanelsProvider>
        </CreateCampaignProvider>
      </EditorDirtyProvider>
    </RunProvider>
  );
}

/** The default split, in percent of the resizable region (SG2). See {@link EditorColumns}. */
const RAIL_DEFAULT_SIZE = 35;
/** Neither column may be dragged away: the rail's floor and the main column's. */
const RAIL_MIN_SIZE = 25;
const MAIN_MIN_SIZE = 50;

/**
 * The two resizable columns of the shell row: `<main>` and, when a view
 * publishes one, the preview rail — with the draggable separator between them
 * (SG2, the owner's wireframe).
 *
 * **The group is these two columns and nothing else, which is a correctness
 * requirement and not tidiness.** `react-resizable-panels` converts pointer
 * movement into a percentage of the GROUP's own width, while a panel's rendered
 * width is that percentage of the space the group has left to distribute. Put
 * the left sidebar (320px) and the row's two 16px gaps inside the group and
 * those two denominators stop matching: at 1280px the divider would travel 72px
 * for every 100px of pointer movement, drifting further from the cursor the
 * longer the drag. So the group is a flex CHILD of the row beside `Sidebar`,
 * which also keeps the left sidebar fixed at 320px, as the wireframe has it —
 * the handle is between the middle and right columns only.
 *
 * **The handle is the row's gap, not an addition to it.** `PanelGroup` carries no
 * `gap`, and the 16px handle sits exactly where the row's `gap-4` used to be, so
 * the rhythm of the three columns is unchanged.
 *
 * **Nothing is persisted (SG-D3).** No `autoSaveId`: the split resets on reload,
 * matching D147's reasoning for timeline zoom. A pane width is not a property of
 * the campaign, and persisting it surprises the second operator to open the same
 * brief.
 *
 * **Why the sizes are percentages.** The library has no pixel unit (v2 removed
 * it), so `RAIL_DEFAULT_SIZE` is 35% of the resizable region — 320px at the
 * 1280px viewport this was drawn for, proportionally wider on a larger screen.
 * The bounds are the load-bearing half and they are exact: `minSize` on both
 * panels means dragging to either extreme stops at a usable column instead of
 * collapsing one, which is what keeps the resizer from becoming a way to hide
 * the surface it exists to size.
 *
 * `main`'s own `defaultSize` follows the rail's presence so the two always total
 * 100: the library normalises a layout that does not, and says so on the console.
 *
 * **The rail slot, and why the structure does not branch on it.** RS2's rail is
 * presence-gated, so its `Panel` mounts and unmounts under a group that stays
 * put. `order` is explicit on both panels for that reason. What must NOT vary is
 * the shape above `{children}`: swapping `<main>` between a group child and a row
 * child would remount the whole view on the commit after the editor publishes its
 * rail — and the editor republishes from an effect, so that remount would publish
 * again, with no fixed point.
 *
 * The comments RS2 left on this slot are its own and still hold:
 *
 * **Presence-gated, never route-gated (RS-D3).** The owner asked to "reveal it
 * based on view"; this is that, expressed as content. `CommandBar` above is the
 * route-gated precedent (`showOrchestrator`) and it is a genuine alternative,
 * rejected for a decisive reason rather than overlooked: a route check can be
 * right about the route and wrong about the content, which is exactly the empty
 * 256px strip that shipped. Presence cannot be. The shell therefore carries no
 * route list, and a later view that publishes a rail needs no edit here.
 *
 * **Why here and not inside the editor.** This is a sibling of `<main>` and of
 * the left `Sidebar`, which is the only position in the tree that can be
 * browser-height: the rail used to live three levels inside `main`'s scroller,
 * where `h-full` means "as tall as the scrolled content" and `sticky
 * max-h-screen` was the best it could do. It wears the same `SidebarShell` as
 * the left column, so the `w-64`/`border-l`/container-query divergence that hid
 * it for two days cannot come back one class at a time.
 *
 * The panel is one commit behind the editor's mount, because `setRail` is
 * published from an effect — the same seam and the same timing the left bar's
 * `panels` have had in production. `useLayoutEffect` would close the one-frame
 * gap at the cost of diverging from that seam; it is not worth it unless the
 * arrival reads as a jump.
 */
function EditorColumns({
  children,
  showOrchestrator,
}: {
  children: ReactNode;
  showOrchestrator: boolean;
}): ReactNode {
  const { rail } = useEditorPanels();
  // The same JS mirror of `lg:` the rail itself uses (RS2/RS-D4), asked here for
  // the handle's interactivity: one number for the CSS that stops the paint and
  // the script that stops the gesture, or the handle is live while invisible.
  const canResize = useViewportMinWidth(RAIL_VIEWPORT_MIN_PX);
  const { open: railSummoned } = useMobileRail();

  /**
   * **SG11 — while the rail is summoned below `lg`, the overlay renders it and
   * this column does not.** `rail` holds rendered ELEMENTS, so two sites
   * rendering the slot means two mounts: every `id` inside the rail duplicated,
   * the `aria-controls` pairs it builds broken, and two composed frames where
   * §4.6 allows one. The two conditions are therefore complements —
   * `MobileRailProvider` forces `open` false at and above `lg`, so this column
   * owns the rail on desktop and the overlay owns it when summoned, never both.
   *
   * Default state is unchanged: `railSummoned` is false until the operator asks
   * from the mobile menu, so below `lg` the rail is still mounted here and still
   * hidden by `hidden lg:flex` — which is what RS2's "hidden, never unmounted"
   * and CC2's "mounts but nothing fetches" contracts pin, both untouched.
   */
  const showRailColumn = rail !== null && !railSummoned;

  return (
    <PanelGroup direction="horizontal" className="min-w-0 flex-1">
      {/* min-w-0: let this flex child shrink below its content's intrinsic width,
        so a wide child (e.g. the compliance table's min-width) scrolls inside
        its own container instead of stretching the whole column past the viewport. */}
      <Panel
        tagName="main"
        id="shell-main-column"
        order={1}
        defaultSize={rail === null ? 100 : 100 - RAIL_DEFAULT_SIZE}
        minSize={MAIN_MIN_SIZE}
        className="relative flex h-full min-w-0 flex-col"
      >
        <div className="relative flex-1 overflow-auto rounded-xl">{children}</div>
        <TelemetrySlot showOrchestrator={showOrchestrator} />
      </Panel>
      {!showRailColumn ? null : (
        <>
          <ColumnResizeHandle enabled={canResize} />
          {/* `hidden lg:flex` on the PANEL, beside the same gate on the aside inside
            it. Not a duplicate: the aside's gate hides the rail, and this one stops
            the panel RESERVING ITS WIDTH — a panel holding a `display: none` aside is
            a 35% strip of nothing, which is the invisible-surface defect this lane is
            written against. `display: none` leaves the flex row, so `main`'s
            flex-grow then takes the whole width, exactly as it did before the rail.

            `[&>aside]:w-full` is how the rail fills the column it is being handed.
            It has to come from OUT HERE: `SidebarShell`'s `w-[320px]` is the fixed
            width both columns of the shell row wear from one definition (RS1/RS-D2),
            and `rail-in-shell.test.tsx` asserts the two asides' class strings are
            identical — so a width prop on the shell would break that invariant even
            if this lane owned the file. The child combinator is load-bearing: it
            gives the rule a type selector, so it outranks `w-[320px]` on specificity
            (0,1,1 against 0,1,0) rather than on whatever order Tailwind emits. `*:`
            would tie and lose. */}
          <Panel
            id="shell-rail-column"
            order={2}
            defaultSize={RAIL_DEFAULT_SIZE}
            minSize={RAIL_MIN_SIZE}
            className="hidden lg:flex [&>aside]:w-full"
          >
            <SidebarShell label={rail.label}>{rail.content}</SidebarShell>
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}

/**
 * The preview rail, full-screen, below the `lg` breakpoint (SG11).
 *
 * The owner asked that **all three panels stay reachable** and that the
 * hamburger be the way to each: *"For mobile and tablet views the hamburger menu
 * should allow user to navigate to each panel."* The route tabs and the left
 * panels already surfaced in `MobileMenu` (`SidebarContent` is shared with the
 * desktop `Sidebar`, so they cannot drift); the rail was the one with no path at
 * all, because `SidebarShell` is `hidden lg:flex`.
 *
 * **A full-screen panel rather than a section inside the menu's scroller.** The
 * rail carries the layer stack, the timeline and the preview; at 400px wide,
 * nested inside a menu that is itself a scrolling dialog, it would be a scroller
 * in a scroller. "Navigate to" is better served by arriving somewhere.
 *
 * **It renders the same slot the shell column renders, never a copy** — see
 * `EditorColumns`. `MobileRailProvider` keeps the two mutually exclusive.
 *
 * Its own dialog semantics are deliberately light: this is a panel the operator
 * summoned, not a modal asking anything, so it takes `role="dialog"` with a name
 * and an Escape handler but does **not** set `aria-modal` or trap focus — F22's
 * "exactly one `aria-modal` at a time" invariant belongs to `DialogShell`, and
 * claiming it here would make this the second one whenever the create dialog is
 * also up.
 */
function MobileRailOverlay(): ReactNode {
  const { rail } = useEditorPanels();
  const { open, closeRail } = useMobileRail();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeRail]);

  // `rail === null` renders nothing at all, heading included: a chrome-only
  // panel over an empty slot is the 256px empty strip in a new place.
  if (!open || rail === null) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-background lg:hidden"
      role="dialog"
      aria-label={rail.label}
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <Eyebrow>{rail.label}</Eyebrow>
        <button
          type="button"
          onClick={closeRail}
          aria-label={`Close ${rail.label}`}
          className="text-text-muted transition-colors hover:text-text-emphasis"
        >
          <svg
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">{rail.content}</div>
    </div>
  );
}

/**
 * The telemetry drawer, and the command bar that also toggles it.
 *
 * The drawer is not grid-only any more: the header opens it from every route (W5.3),
 * so its state lives in the run context beside the brief picker's — and reading that
 * state has to happen *inside* the provider this layout renders, hence this wrapper.
 * The command bar stays on the grid, where the creatives it acts on are.
 */
function TelemetrySlot({ showOrchestrator }: { showOrchestrator: boolean }) {
  const { telemetryOpen, toggleTelemetry, closeTelemetry } = useRun();
  return (
    <>
      <TelemetryDrawer open={telemetryOpen} onClose={closeTelemetry} />
      {showOrchestrator && <CommandBar onToggleTelemetry={toggleTelemetry} />}
    </>
  );
}
