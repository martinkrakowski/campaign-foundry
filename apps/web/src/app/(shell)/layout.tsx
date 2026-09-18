"use client";

import { type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { RunProvider, useRun } from "@/lib/run-context";
import { EditorDirtyProvider } from "@/lib/editor-dirty-context";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { EditorPanelsProvider, useEditorPanels } from "@/lib/editor-panels-context";
import { Header } from "@/components/shell/Header";
import { Sidebar } from "@/components/shell/Sidebar";
import { SidebarShell } from "@/components/shell/SidebarShell";
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
            <div className="flex h-full flex-col">
              <Header />
              <div className="relative z-0 flex flex-1 gap-4 overflow-hidden bg-background p-4">
                <Sidebar />
                {/* min-w-0: let this flex child shrink below its content's intrinsic width,
                  so a wide child (e.g. the compliance table's min-width) scrolls inside
                  its own container instead of stretching the whole column past the viewport. */}
                <main className="relative flex h-full min-w-0 flex-1 flex-col">
                  <div className="relative flex-1 overflow-auto rounded-xl">{children}</div>
                  <TelemetrySlot showOrchestrator={showOrchestrator} />
                </main>
                <EditorRailSlot />
              </div>
            </div>
            {/* The shell overlays share this layer: the picker closes before the
              create dialog opens (F22 — two DialogShells at one layer stack two
              scrims and two key handlers). Each renders null while closed, so
              exactly one `[role=dialog]` is ever in the document — the template
              library's detail view is a swap of its own body, not a fourth
              entry here (T6). */}
            <BriefPicker />
            <CreateCampaignDialog />
            <TemplateLibrary />
          </EditorPanelsProvider>
        </CreateCampaignProvider>
      </EditorDirtyProvider>
    </RunProvider>
  );
}

/**
 * The shell row's right-hand column — the editor's preview rail (RS2).
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
function EditorRailSlot(): ReactNode {
  const { rail } = useEditorPanels();
  return rail === null ? null : <SidebarShell label={rail.label}>{rail.content}</SidebarShell>;
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
