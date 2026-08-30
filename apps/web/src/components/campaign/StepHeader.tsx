"use client";

import type { Ref } from "react";
import { Eyebrow } from "@/components/ui";
import * as messages from "./messages";
import { StatusChip } from "./StatusChip";
import type { EditorState } from "./editor-state";

interface StepHeaderProps {
  /** The step shown, 1-based — the `n` in "STEP n OF N". */
  step: number;
  /** The total number of steps — the `N`. */
  total: number;
  title: string;
  subtitle: string;
  state: EditorState;
  /**
   * The focus handoff target (SHELL-55): the h1 is focused on step change, and
   * never on first render. `tabindex="-1"` makes it focusable without tabbing.
   */
  headingRef?: Ref<HTMLHeadingElement>;
}

/**
 * W6.4 — the guided step head. Sticky within the editor column (the shell's main
 * container is the scroller, so `sticky` here is scoped to the column, like the
 * FloatingBar below it). It is the one place a step's count, name and subtitle
 * are announced: the eyebrow reads the count from `stepEyebrow`, and the heading
 * is the step-change focus target.
 */
export function StepHeader({ step, total, title, subtitle, state, headingRef }: StepHeaderProps) {
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-background pb-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Eyebrow as="p">{messages.stepEyebrow(step, total)}</Eyebrow>
          <h1 ref={headingRef} tabIndex={-1} className="mt-1 text-lg font-semibold text-text-emphasis">
            {title}
          </h1>
          <p className="mt-0.5 text-[13px] text-text-muted">{subtitle}</p>
        </div>
        <StatusChip state={state} />
      </div>
    </div>
  );
}