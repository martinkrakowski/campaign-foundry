"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

interface AccordionProps {
  title: ReactNode;
  /** Optional element rendered on the right of the header (e.g. a count badge). */
  aside?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** Collapsible section used in the shell sidebar (replaces the POC's inline toggle). */
export function Accordion({ title, aside, defaultOpen = true, children }: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-4 flex w-full items-center justify-between text-text-primary transition-colors hover:text-white"
      >
        <span className="flex items-center gap-2">
          <svg
            className={cn("h-3.5 w-3.5 transition-transform", open ? "rotate-0" : "-rotate-90")}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
          </svg>
          <span className="text-[13px] font-bold">{title}</span>
        </span>
        {aside}
      </button>
      {open && <div className="space-y-4">{children}</div>}
    </div>
  );
}
