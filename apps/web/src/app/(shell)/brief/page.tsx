"use client";

import { useReducer, useState, useEffect } from "react";
import { Button } from "@/components/ui";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { useRun } from "@/lib/run-context";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import {
  listBriefs,
  createBrief,
  updateBrief,
  getCapabilities,
  isTransientCapabilities,
  CAPABILITIES_RETRY_MS,
  CAPABILITIES_MAX_RETRIES,
  unknownErrorMessage,
  isBriefsApiError,
  type BriefEntry,
} from "@/lib/briefs-api";
import {
  editorReducer,
  initialEditorState,
  toBrief,
  isDirtySinceSave,
  isDirtySinceApply,
  isPristine,
  getDraftKey,
  saveDraftToStorage,
  loadDraftFromStorage,
  purgeDraftFromStorage,
} from "@/components/campaign/editor-state";
import {
  validateState,
  getTotalErrorCount,
  motionUnavailableReason,
  type FieldErrors,
} from "@/components/campaign/validate";
import { IdentitySection, CopySection, ProductsSection, TreatmentsSection, OutputSection, PolicySection } from "@/components/campaign/sections";
import { StatusChip } from "@/components/campaign/StatusChip";
import { ErrorStrip } from "@/components/campaign/ErrorStrip";
import { SaveMenu } from "@/components/campaign/SaveMenu";
import { useEditorPanels } from "@/lib/editor-panels-context";
import { Accordion } from "@/components/shell/Accordion";
import { scrollToSection } from "@/lib/scroll-to-section";
import { BriefSelector } from "@/components/campaign/BriefSelector";
import { HeadlinePoolDrawer } from "@/components/campaign/HeadlinePoolDrawer";

const LEAVE_PROMPT = "You have unsaved changes. Are you sure you want to leave?";

export default function BriefPage() {
  const { brief: runBrief, setBrief: setRunBrief } = useRun();
  const { setDirty } = useEditorDirty();
  const { setPanels } = useEditorPanels();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState());
  const [errors, setErrors] = useState<Record<string, FieldErrors>>({});
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [briefs, setBriefs] = useState<BriefEntry[]>([]);
  const [briefsLoaded, setBriefsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [persistError, setPersistError] = useState<string | undefined>();
  const [saveAsId, setSaveAsId] = useState<string | null>(null);
  const [showYamlSplit, setShowYamlSplit] = useState(false);
  const [poolDrawerOpen, setPoolDrawerOpen] = useState(false);

  // Load briefs on mount and set up focus listener
  useEffect(() => {
    loadBriefs();
    const handleFocus = () => loadBriefs();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  // Capabilities from the API's boot probe. Nitro does not await the ffmpeg probe,
  // so the route may answer `{ motion: false, reason: "not probed" }` for the first
  // moments after boot — that snapshot is retried, never taken as the verdict, and
  // the window reopens on focus.
  useEffect(() => {
    let cancelled = false;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Mount and focus requests overlap, and responses can land out of order. Stamp
    // each round so a slow older answer cannot replace a newer verdict.
    let generation = 0;
    const load = async (round: number) => {
      const capabilities = await getCapabilities();
      if (cancelled || round !== generation || capabilities === null) return;
      if (isTransientCapabilities(capabilities)) {
        // Still probing. Retry, and if it never settles leave capabilities unknown
        // rather than committing a snapshot we know is transient — "not probed" is
        // not a verdict, and gating on it would report a false negative with a
        // meaningless reason. A later focus refetch reopens the window.
        if (retries < CAPABILITIES_MAX_RETRIES) {
          retries += 1;
          timer = setTimeout(() => void load(round), CAPABILITIES_RETRY_MS);
        }
        return;
      }
      dispatch({ type: "setCapabilities", capabilities });
    };
    void load(generation);
    const handleFocus = () => {
      retries = 0;
      generation += 1;
      clearTimeout(timer);
      void load(generation);
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  // D11 recovery: reinstate an auto-saved draft, once per draft key and only when it
  // actually differs from what is on screen. Keying on the draft rather than on mount
  // matters — a new draft's key contains a temp id minted at mount, so an unsaved edit
  // is only ever recoverable once the editor has settled on the brief it belongs to.
  const draftKey = getDraftKey(state);
  useEffect(() => {
    const draft = loadDraftFromStorage(state);
    if (draft && JSON.stringify(draft) !== JSON.stringify(state)) {
      dispatch({ type: "restore", state: draft });
    }
  }, [draftKey]);

  // The shell's picker and the sidebar's Edit both set the run-context brief. Follow it
  // so the editor never sits on stale content while /brief is mounted; never over a
  // dirty draft, and re-attach the file identity from the listing when we have it.
  useEffect(() => {
    // Wait for the listing: syncing before it arrives would adopt the brief without its
    // file identity, and the editor would then be too dirty to re-attach it.
    if (!briefsLoaded) return;
    const loadedId = state.source.kind === "file" ? state.source.loadedId : undefined;
    if (loadedId === runBrief.id || (!isPristine(state) && isDirtySinceSave(state))) return;
    const match = briefs.find((entry) => entry.brief.id === runBrief.id);
    dispatch({
      type: "load",
      brief: match ? match.brief : runBrief,
      ...(match ? { entry: { file: match.file, revision: match.revision } } : {}),
    });
  }, [runBrief, briefs, briefsLoaded]);

  // Validate on state change
  useEffect(() => {
    const existingIds = briefs.map((b) => b.brief.id);
    setErrors(validateState(state, existingIds));
    // D7: Save is blocked by structural invalidity only. A capability being off
    // makes the draft unrunnable on this host, not unsavable — so the gating check
    // runs the same validation with the capability unknown. The API parses saves in
    // authoring mode; a motion brief must round-trip on a host without ffmpeg.
    setSaveBlocked(getTotalErrorCount(validateState({ ...state, capabilities: null }, existingIds)) > 0);
  }, [state, briefs]);

  // Update dirty state. The provider outlives this route, so clear the flag on unmount —
  // otherwise every later navigation in the shell keeps prompting.
  useEffect(() => {
    setDirty(isDirtySinceSave(state));
    return () => setDirty(false);
  }, [state, setDirty]);

  // Auto-save, but only for a draft that has actually diverged from a pristine editor.
  // Writing unconditionally would recreate the key that Save and Discard just purged.
  useEffect(() => {
    if (isPristine(state)) return;
    saveDraftToStorage(state);
  }, [state]);

  const loadBriefs = async () => {
    try {
      const entries = await listBriefs();
      setBriefs(entries);
    } catch (error) {
      console.error("Failed to load briefs:", error);
    } finally {
      setBriefsLoaded(true);
    }
  };

  const totalErrors = getTotalErrorCount(errors);


  // Derived, not stored: the refusal describes the draft *as applied*, so it holds
  // exactly while the applied snapshot still matches the draft. Any edit — switching
  // away from motion, or a capability verdict landing — re-evaluates it, and storing
  // it would leave the page claiming motion is unavailable after that stopped being
  // true. Both Apply and Save & apply set the snapshot, so both surface it.
  const applied = state.appliedSnapshot !== null && !isDirtySinceApply(state);
  const applyRefusal = applied ? motionUnavailableReason(state) : undefined;
  // Apply changes state the user cannot see from here — the pipeline lives in the top
  // bar — so say plainly what happened and what runs it. Without this, Apply looked
  // like it did nothing at all.
  const applyNotice = applied
    ? (applyRefusal ?? `Applied — Generate in the top bar will run "${state.briefId}".`)
    : undefined;

  /** Section errors before the first validation pass lands. */
  const sectionErrors = (section: string): FieldErrors => errors[section] ?? {};

  // Publish the sections that live in the left bar while this editor is mounted. The
  // page keeps the state, dispatch and validation and republishes on every change; the
  // bar only places them.
  const policyErrors = Object.keys(sectionErrors("policy")).length;
  useEffect(() => {
    setPanels(
      state.mode === "variation" ? (
        <Accordion
          title="Variation Policy"
          aside={
            policyErrors > 0 ? (
              <span className="font-mono text-[11px] text-error">
                {policyErrors} {policyErrors === 1 ? "issue" : "issues"}
              </span>
            ) : null
          }
        >
          <PolicySection state={state} dispatch={dispatch} errors={sectionErrors("policy")} compact />
        </Accordion>
      ) : null,
    );
    return () => setPanels(null);
    // sectionErrors only reads what `errors` already covers.
  }, [state, errors, policyErrors, setPanels]);

  /** Every path that replaces the draft goes through the same D14 confirmation. */
  const confirmReplace = (): boolean =>
    isPristine(state) || !isDirtySinceSave(state) || window.confirm(LEAVE_PROMPT);

  const loadBrief = (entry: BriefEntry) => {
    if (!confirmReplace()) return;
    // Carry the revision through: handleSave sends it back as the conditional-write
    // guard, so dropping it here would silently downgrade every save to last-write-wins.
    dispatch({ type: "load", brief: entry.brief, entry: { file: entry.file, revision: entry.revision } });
    // Picking a brief is choosing which campaign to work on, so it becomes the active
    // one — the same thing the shell's picker does with `setBrief`. Without this the
    // editor and the pipeline disagree: Generate would run whatever was active before,
    // so choosing a motion brief here and running it produced the previous brief's
    // output. Typed edits still need Apply; only the choice of brief is immediate.
    // No `applied` here: the reducer processes this after the load, so it snapshots the
    // canonical `toBrief` of the loaded draft. Passing the file's brief instead would
    // differ by key order alone and read as dirty the moment it was applied.
    dispatch({ type: "apply" });
    setRunBrief(entry.brief);
  };

  const createNew = () => {
    if (!confirmReplace()) return;
    // No entry means `fromBrief` produces a "new" source, which is what a blank draft is.
    dispatch({
      type: "load",
      brief: { id: "", targetRegion: "", targetAudience: "", campaignMessage: "", products: [] } as CampaignBrief,
    });
  };

  const handleApply = () => {
    const brief = toBrief(state);
    dispatch({ type: "apply", applied: brief });
    setRunBrief(brief);
    // D7: applying a motion brief on a host that cannot run it must not pretend it
    // will produce clips — surface the probe's reason (the text the API's 400 would
    // quote) as the status message. Run still refuses it server-side.
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
      // D3: "Save & apply" does both. Pass the brief that was actually persisted so
      // edits made while the request was in flight stay dirty.
      dispatch({ type: "save", saved: brief });
      dispatch({ type: "apply", applied: brief });
      setRunBrief(brief);
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
      // D9: Save as… posts the *current draft* under the new id. A collision is offered
      // as an explicit overwrite rather than silently failing; the API's 409 is the
      // backstop for a brief that appeared since the list was fetched.
      const taken = briefs.some((entry) => entry.brief.id === newId);
      if (taken && !window.confirm(`A brief with id "${newId}" already exists. Overwrite it?`)) {
        setSaving(false);
        return;
      }
      try {
        await createBrief(newBrief, taken ? { replace: true } : {});
      } catch (error) {
        if (!isBriefsApiError(error) || error.status !== 409) throw error;
        if (!window.confirm(`A brief with id "${newId}" already exists. Overwrite it?`)) {
          setSaving(false);
          return;
        }
        await createBrief(newBrief, { replace: true });
      }
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

  const scrollToFirstError = (section: string) => scrollToSection(section);

  return (
    // No h-full / inner overflow: like every other view, this one flows and the
    // shell's main container is the scroller. The action bar and the YAML panel stay
    // put with `sticky`, which is scoped to that container — never the viewport.
    <div className="flex flex-col">
      <div className="flex items-start">
        {/* Main content */}
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-8">
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
            <div>
              <IdentitySection state={state} dispatch={dispatch} errors={sectionErrors("identity")} />
            </div>
            <div>
              <CopySection state={state} dispatch={dispatch} errors={sectionErrors("copy")} onOpenPool={() => setPoolDrawerOpen(true)} />
            </div>
            <div>
              <ProductsSection state={state} dispatch={dispatch} errors={sectionErrors("products")} />
            </div>
            <div>
              {state.mode === "brief" ? (
                <TreatmentsSection state={state} dispatch={dispatch} errors={sectionErrors("treatments")} />
              ) : null}
            </div>
            <OutputSection
              state={state}
              dispatch={dispatch}
              errors={{ ...sectionErrors("output"), ...sectionErrors("motion") }}
            />
          </div>

          {persistError ? <p className="text-[13px] text-error">{persistError}</p> : null}
          {applyNotice ? (
            <p className={applyRefusal ? "text-[13px] text-error" : "text-[13px] text-success"} role="status">
              {applyNotice}
            </p>
          ) : null}
        </div>

        {/* YAML split view */}
        {showYamlSplit && (
          <div className="sticky top-0 max-h-screen w-96 shrink-0 self-start overflow-y-auto border-l border-border bg-surface p-4">
            <pre className="overflow-auto text-[11px] text-text-primary">
              {JSON.stringify(toBrief(state), null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Action bar: in flow at the foot of this view, so it never covers the left bar */}
      <div data-testid="action-bar" className="sticky bottom-0 z-10 flex shrink-0 items-center gap-3 border-t border-border bg-background p-4">
        <Button variant="ghost" onClick={() => setShowYamlSplit(!showYamlSplit)}>
          YAML split {showYamlSplit ? "off" : "on"}
        </Button>
        <div className="min-w-0 flex-1">
          {totalErrors > 0 ? <ErrorStrip errors={errors} onErrorClick={scrollToFirstError} /> : null}
        </div>
        <Button variant="ghost" onClick={handleDiscard}>
          Discard
        </Button>
        <SaveMenu
          disabled={saveBlocked}
          saving={saving}
          onSaveAndApply={() => void handleSave()}
          onSaveAs={() => setSaveAsId("")}
        />
        <Button onClick={handleApply} disabled={saveBlocked}>
          Apply to run
        </Button>
      </div>

       {/* Headline pool drawer */}
       <HeadlinePoolDrawer
         state={state}
         dispatch={dispatch}
         open={poolDrawerOpen}
         onClose={() => setPoolDrawerOpen(false)}
       />

       {/* Save as dialog */}
      {saveAsId !== null && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-as-title"
            className="w-full max-w-md rounded-xl border border-border bg-surface p-6"
          >
            <h3 id="save-as-title" className="mb-4 text-sm font-semibold text-white">Save as...</h3>
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
              <Button onClick={() => handleSaveAs(saveAsId)} disabled={saving || !saveAsId || saveBlocked}>
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
