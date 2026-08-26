"use client";

import { useReducer, useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { useRun } from "@/lib/run-context";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { listBriefs, createBrief, updateBrief, unknownErrorMessage, type BriefEntry } from "@/lib/briefs-api";
import { editorReducer, initialEditorState, toBrief, isDirtySinceSave, saveDraftToStorage, purgeDraftFromStorage } from "@/components/campaign/editor-state";
import { validateState, getTotalErrorCount, type FieldErrors } from "@/components/campaign/validate";
import { IdentitySection, CopySection, ProductsSection, TreatmentsSection, OutputSection } from "@/components/campaign/sections";
import { StatusChip } from "@/components/campaign/StatusChip";
import { TableOfContents } from "@/components/campaign/TableOfContents";
import { ErrorStrip } from "@/components/campaign/ErrorStrip";
import { BriefSelector } from "@/components/campaign/BriefSelector";

export default function BriefPage() {
  const { setBrief: setRunBrief } = useRun();
  const { setDirty } = useEditorDirty();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState());
  const [errors, setErrors] = useState<Record<string, FieldErrors>>({});
  const [briefs, setBriefs] = useState<BriefEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [persistError, setPersistError] = useState<string | undefined>();
  const [saveAsId, setSaveAsId] = useState<string | null>(null);
  const [showYamlSplit, setShowYamlSplit] = useState(false);

  // Load briefs on mount and set up focus listener
  useEffect(() => {
    loadBriefs();
    const handleFocus = () => loadBriefs();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  // Validate on state change
  useEffect(() => {
    const existingIds = briefs.map((b) => b.brief.id);
    const validationErrors = validateState(state, existingIds);
    setErrors(validationErrors);
  }, [state, briefs]);

  // Update dirty state
  useEffect(() => {
    const dirty = isDirtySinceSave(state);
    setDirty(dirty);
  }, [state, setDirty]);

  // Auto-save on state change
  useEffect(() => {
    saveDraftToStorage(state);
  }, [state]);

  const loadBriefs = async () => {
    try {
      const entries = await listBriefs();
      setBriefs(entries);
    } catch (error) {
      console.error("Failed to load briefs:", error);
    }
  };

  const loadBrief = useCallback((entry: BriefEntry) => {
    // Carry the revision through: handleSave sends it back as the conditional-write
    // guard, so dropping it here would silently downgrade every save to last-write-wins.
    dispatch({ type: "load", brief: entry.brief, entry: { file: entry.file, revision: entry.revision } });
  }, []);

  const createNew = () => {
    // No entry means `fromBrief` produces a "new" source, which is what a blank draft is.
    dispatch({
      type: "load",
      brief: { id: "", targetRegion: "", targetAudience: "", campaignMessage: "", products: [] } as CampaignBrief,
    });
  };

  const handleApply = () => {
    const brief = toBrief(state);
    dispatch({ type: "apply" });
    setRunBrief(brief);
  };

  const handleSave = async () => {
    setSaving(true);
    setPersistError(undefined);
    try {
      const brief = toBrief(state);
      if (state.source.kind === "file") {
        await updateBrief(state.source.loadedId, brief, { revision: state.source.revision });
      } else {
        await createBrief(brief);
      }
      dispatch({ type: "save" });
      purgeDraftFromStorage(state);
      await loadBriefs();
    } catch (error) {
      setPersistError(unknownErrorMessage(error, "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAs = async (newId: string) => {
    setSaving(true);
    setPersistError(undefined);
    try {
      const brief = toBrief(state);
      const newBrief = { ...brief, id: newId };
      await createBrief(newBrief);
      dispatch({ type: "load", brief: newBrief, entry: { file: `${newId}.yaml` } });
      purgeDraftFromStorage(state);
      await loadBriefs();
      setSaveAsId(null);
    } catch (error) {
      setPersistError(unknownErrorMessage(error, "Save as failed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    dispatch({ type: "discard" });
    purgeDraftFromStorage(state);
  };

  const totalErrors = getTotalErrorCount(errors);

  const scrollToFirstError = (section: string) => {
    const element = document.getElementById(section);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div className="flex h-full">
      {/* Sticky TOC */}
      {!showYamlSplit && (
        <div className="hidden w-48 shrink-0 p-4 lg:block">
          <TableOfContents errors={errors} />
        </div>
      )}

      {/* Main content */}
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto p-4 pb-12 sm:p-8">
        {/* Header with selector, mode toggle, status chip */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <BriefSelector
              briefs={briefs}
              currentId={state.source.kind === "file" ? state.source.loadedId : undefined}
              onSelect={loadBrief}
              onCreateNew={createNew}
            />
            <StatusChip state={state} />
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={state.mode === "brief" ? "primary" : "secondary"}
              size="sm"
              onClick={() => dispatch({ type: "setMode", mode: "brief" })}
            >
              Classic
            </Button>
            <Button
              variant={state.mode === "variation" ? "primary" : "secondary"}
              size="sm"
              onClick={() => dispatch({ type: "setMode", mode: "variation" })}
            >
              Randomized
            </Button>
          </div>
        </div>

        {/* Sections */}
        <div className="space-y-8">
          <div id="identity">
            <IdentitySection state={state} dispatch={dispatch} errors={errors.identity ?? {}} />
          </div>
          <div id="copy">
            <CopySection state={state} dispatch={dispatch} errors={errors.copy ?? {}} />
          </div>
          <div id="products">
            <ProductsSection state={state} dispatch={dispatch} errors={errors.products ?? {}} />
          </div>
          <div id="treatments">
            <TreatmentsSection state={state} dispatch={dispatch} errors={errors.treatments ?? {}} />
          </div>
          <div id="output">
            <OutputSection state={state} dispatch={dispatch} errors={errors.output ?? {}} />
          </div>
        </div>

        {persistError ? <p className="text-[13px] text-error">{persistError}</p> : null}
      </div>

      {/* YAML split view */}
      {showYamlSplit && (
        <div className="w-96 shrink-0 border-l border-border bg-surface p-4">
          <pre className="overflow-auto text-[11px] text-text-primary">
            {JSON.stringify(toBrief(state), null, 2)}
          </pre>
        </div>
      )}

      {/* Sticky action bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background p-4">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <Button onClick={handleApply}>
            Apply to run
          </Button>
          <Button variant="secondary" onClick={() => void handleSave()} disabled={saving || totalErrors > 0}>
            {saving ? "Saving..." : "Save & apply"}
          </Button>
          <Button variant="secondary" onClick={() => setSaveAsId("")}>
            Save as...
          </Button>
          <Button variant="ghost" onClick={handleDiscard}>
            Discard
          </Button>
          <Button variant="ghost" onClick={() => setShowYamlSplit(!showYamlSplit)}>
            YAML split {showYamlSplit ? "off" : "on"}
          </Button>

          <div className="ml-auto">
            {totalErrors > 0 ? (
              <ErrorStrip errors={errors} onErrorClick={scrollToFirstError} />
            ) : null}
          </div>
        </div>
      </div>

      {/* Save as dialog */}
      {saveAsId !== null && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6">
            <h3 className="mb-4 text-sm font-semibold text-white">Save as...</h3>
            <p className="mb-4 text-[12px] text-text-muted">
              This creates a copy. The original file stays on disk until deleted.
            </p>
            <input
              type="text"
              aria-label="New brief id"
              placeholder="New brief id"
              value={saveAsId}
              onChange={(e) => setSaveAsId(e.target.value)}
              className="mb-4 w-full rounded border border-border bg-background px-3 py-2 text-[13px] text-white"
              autoFocus
            />
            <div className="flex gap-2">
              <Button onClick={() => handleSaveAs(saveAsId)} disabled={saving || !saveAsId}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setSaveAsId(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
