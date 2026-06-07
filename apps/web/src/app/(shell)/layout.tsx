"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { RunProvider } from "@/lib/run-context";
import { Header } from "@/components/shell/Header";
import { Sidebar } from "@/components/shell/Sidebar";
import { CommandBar } from "@/components/shell/CommandBar";
import { TelemetryDrawer } from "@/components/shell/TelemetryDrawer";

/**
 * The primary application shell: persistent header, brief/asset sidebar, the
 * pipeline command bar, and the telemetry drawer. Workspace views render into
 * `{children}` and read shared run state from RunProvider.
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  // The orchestrator (Execute + telemetry) only belongs on the review grid — that's
  // where the creatives and the approve/reject flow live. Other views are read-only
  // reports, so the floating bar would just obscure content there.
  const showOrchestrator = usePathname().startsWith("/grid");

  return (
    <RunProvider>
      <div className="flex h-full flex-col">
        <Header />
        <div className="relative z-0 flex flex-1 gap-4 overflow-hidden bg-background p-4">
          <Sidebar />
          {/* min-w-0: let this flex child shrink below its content's intrinsic width,
              so a wide child (e.g. the compliance table's min-width) scrolls inside
              its own container instead of stretching the whole column past the viewport. */}
          <main className="relative flex h-full min-w-0 flex-1 flex-col">
            <div className="relative flex-1 overflow-auto rounded-xl">{children}</div>
            {showOrchestrator && (
              <>
                <TelemetryDrawer open={terminalOpen} onClose={() => setTerminalOpen(false)} />
                <CommandBar onToggleTelemetry={() => setTerminalOpen((v) => !v)} />
              </>
            )}
          </main>
        </div>
      </div>
    </RunProvider>
  );
}
