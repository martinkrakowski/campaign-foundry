"use client";

import { Accordion } from "./Accordion";
import { useEditorOutline } from "@/lib/editor-outline-context";

/**
 * The editor's sections, at the top of the left bar. Rendered only while the brief
 * editor is mounted (it publishes the outline); styled as a sidebar section so it
 * reads as part of the bar rather than a widget dropped into it.
 */
export function EditorOutline({ onNavigate }: { onNavigate?: () => void }) {
  const { outline } = useEditorOutline();
  if (!outline) return null;
  const total = outline.sections.reduce((sum, section) => sum + section.errorCount, 0);
  return (
    <>
      <Accordion
        title="Sections"
        aside={
          total > 0 ? (
            <span className="font-mono text-[11px] text-error">
              {total} {total === 1 ? "issue" : "issues"}
            </span>
          ) : null
        }
      >
        <nav aria-label="Editor sections" className="space-y-1">
          {outline.sections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => {
                onNavigate?.();
                outline.navigate(section.id);
              }}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-surface-2 hover:text-white"
            >
              <span>{section.label}</span>
              {section.errorCount > 0 ? (
                <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-error/20 px-1.5 font-mono text-[10px] font-bold text-error">
                  {section.errorCount}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </Accordion>
      {outline.panels ? (
        <>
          <div className="h-px w-full bg-border" />
          <div className="space-y-5">{outline.panels}</div>
        </>
      ) : null}
      <div className="h-px w-full bg-border" />
    </>
  );
}
