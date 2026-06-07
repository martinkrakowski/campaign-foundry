"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const TABS = [
  { href: "/grid", label: "Grid" },
  { href: "/compliance", label: "Compliance" },
  { href: "/export", label: "Export" },
  { href: "/runs", label: "Runs" },
] as const;

/** Top application bar: brand, pipeline breadcrumb, centered tab nav, HITL flag. */
export function Header() {
  const pathname = usePathname();
  return (
    <header className="relative z-50 flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
      <div className="flex items-center space-x-4">
        <div className="flex h-7 w-7 items-center justify-center rounded bg-brand-primary text-xs font-bold text-white">
          CF
        </div>
        <div className="flex cursor-default items-center space-x-2 text-text-primary">
          <span className="text-sm font-medium">Campaign Pipeline</span>
        </div>
      </div>

      <nav className="absolute left-1/2 flex h-full -translate-x-1/2 space-x-6 text-sm font-medium">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "flex h-full items-center border-b-2 px-1 transition-colors",
                active
                  ? "border-white text-white"
                  : "border-transparent text-text-muted hover:text-white",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center space-x-4 text-sm">
        <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
          HITL Mode Active
        </span>
      </div>
    </header>
  );
}
