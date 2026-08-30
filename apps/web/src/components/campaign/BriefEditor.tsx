"use client";

import { useReducer, useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from "react";
import { Button, Input } from "@/components/ui";
import { useRun } from "@/lib/run-context";
import { useRouter } from "next/navigation";
import { useGuardedNavigation } from "@/lib/use-guarded-navigation";
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
  blankBrief,
} from "@/components/campaign/editor-state";
import {
  validateState,
  getTotalErrorCount,
  motionUnavailableReason,
  type FieldErrors,
} from "@/components/campaign/validate";
import { IdentitySection, CopySection, ProductsSection, TreatmentsSection, OutputSection, PolicySection } from "@/components/campaign/sections";
import { StatusChip } from "@/components/campaign/StatusChip";
import { StatusLine } from "@/components/campaign/StatusLine";
import { ErrorStrip } from "@/components/campaign/ErrorStrip";
import { ErrorPill } from "@/components/ui/error-pill";
import { SaveMenu } from "@/components/campaign/SaveMenu";
import { FloatingBar } from "@/components/shell/FloatingBar";
import { SectionModeContext } from "@/components/campaign/SectionModeContext";
import { useEditorPanels } from "@/lib/editor-panels-context";
import { Accordion } from "@/components/shell/Accordion";
import { revealSection } from "@/lib/scroll-to-section";
import { useStepNavigation } from "@/lib/use-step-navigation";
import { cn } from "@/lib/cn";
import { BriefSelector } from "@/components/campaign/BriefSelector";
import { HeadlinePoolDrawer } from "@/components/campaign/HeadlinePoolDrawer";
import { ModePanel } from "@/components/ui/mode-panel";
import { SectionOutline } from "@/components/ui/section-outline";
import { EstimatePanel } from "@/components/campaign/EstimatePanel";
import { StepHeader } from "@/components/campaign/StepHeader";
import { StepFooter } from "@/components/campaign/StepFooter";
import { SECTION_TITLES, sectionOrder, type SectionId } from "./sections";
import * as messages from "./messages";
import type { CampaignMode } from "@/components/campaign/editor-state";

const LEAVE_PROMPT = "You have unsaved changes. Are you sure you want to leave?";

/* ── Guided presentation (W6) ─────────────────────────────────────────────── */

/** A step is one of the six sections, or the review step the pipeline sends to. */
type StepId = SectionId | "review";

/** The two presentations the toggle offers (W6). */
type Presentation = "guided" | "everything";

const PRESENTATION_KEY = "cf:presentation";

/**
 * The one presentation the editor reads or writes, closed over two values.
 * `localStorage` can be gone (private mode) — the tried/fallback pair keeps a
 * read and a write from either throwing or depending on which side broadcasts.
 */
function readPresentation(): Presentation {
  try {
    const stored = window.localStorage.getItem(PRESENTATION_KEY);
    if (stored === "guided" || stored === "everything") return stored;
    return "guided";
  } catch {
    return "guided";
  }
}

function persistPresentation(next: Presentation): void {
  try {
    window.localStorage.setItem(PRESENTATION_KEY, next);
  } catch {
    // Storage unavailable in this context; the toggle still works for the tab.
  }
}

/** The subtitle under each step heading, keyed by the same vocabulary as the headings. */
const STEP_SUBTITLES: Record<StepId, string> = {
  identity: messages.stepSubtitleIdentity,
  copy: messages.stepSubtitleCopy,
  products: messages.stepSubtitleProducts,
  treatments: messages.stepSubtitleTreatments,
  policy: messages.stepSubtitlePolicy,
  output: messages.stepSubtitleOutput,
  review: messages.stepSubtitleReview,
};

function stepTitle(step: StepId): string {
  return step === "review" ? "Review" : SECTION_TITLES[step];
}

/**
 * The campaign editor. Two routes render it: `/brief` edits whatever brief the shell
 * has active, and `/brief/new` starts a blank one. The difference is `blank`, which is
 * a statement about the route rather than a moment in a click handler — that is what
 * keeps "the user asked for an empty brief" true for the whole life of the page,
 * rather than for the one render before an effect adopts the active brief again.
 */
export function BriefEditor({ blank = false }: { blank?: boolean }) {
  const { brief: runBrief, setBrief: setRunBrief } = useRun();
  const router = useRouter();
  const { guardedPush } = useGuardedNavigation();
  const { setDirty } = useEditorDirty();
  const { setPanels, setTopPanels } = useEditorPanels();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState());
  const [errors, setErrors] = useState<Record<string, FieldErrors>>({});
  // Not a boolean: the section that blocks is what the refusal needs to scroll to, and
  // deriving it here keeps "is it blocked" and "where" from disagreeing. null = valid.
  const [blockedAt, setBlockedAt] = useState<string | null>(null);
  const [briefs, setBriefs] = useState<BriefEntry[]>([]);
  const [briefsLoaded, setBriefsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [persistError, setPersistError] = useState<string | undefined>();
  const [saveAsId, setSaveAsId] = useState<string | null>(null);
  const [showYamlSplit, setShowYamlSplit] = useState(false);
  const [poolDrawerOpen, setPoolDrawerOpen] = useState(false);
  // L1.1: Touched/attempted state for error display gating
  const [touched, setTouched] = useState<Set<string>>(new Set());
  // D1: a control that is not a `Field` (an axis card, a chip, a stepper) still means
  // "the user has been here". Interacting anywhere inside a section marks that section,
  // so its errors become visible without every control having to know its own key.
  const [touchedSections, setTouchedSections] = useState<Set<string>>(new Set());
  // `motion` errors are validated separately but rendered inside Output, and the policy
  // panel is published into the sidebar — so a touch on the host section reveals them.
  const SECTION_HOSTS: Record<string, string> = { motion: "output" };
  const touchSectionFromEvent = useCallback((event: { target: EventTarget | null }) => {
    // React click/focus events inside this subtree always target an element, so there
    // is no non-Element case to branch on here.
    const el = (event.target as Element).closest("[data-section]");
    const section = el?.getAttribute("data-section");
    if (section) setTouchedSections((prev) => (prev.has(section) ? prev : new Set([...prev, section])));
  }, []);
  const [attempted, setAttempted] = useState(false);

  // W6: the guided/everything presentation. Stored outside the editor so the toggle
  // outlives a reload; the guarded read makes a blank choice before anything renders.
  const [presentation, setPresentation] = useState<Presentation>(() => readPresentation());
  const choosePresentation = useCallback((next: Presentation) => {
    setPresentation(next);
    persistPresentation(next);
  }, []);

  // The step list is derived from the mode, never stored (D19): both modes produce
  // five sections plus the review step. The cursor re-clamps when the mode flips.
  const steps = useMemo<StepId[]>(() => [...sectionOrder(state.mode), "review"], [state.mode]);
  const { index: stepIndex, go } = useStepNavigation(steps);

  // W6.2: a reveal that points at another step cannot scroll there synchronously —
  // in Guided the target section is unmounted until the step change commits. The
  // pending marker is spent in a layout effect on the committed step.
  const pendingReveal = useRef<{ section: string; focus: boolean } | null>(null);
  // The reveal that drove a step change already pointed at the step's own content, so
  // the step-change focus lands nowhere else. Consumed by the step-focus effect.
  const suppressStepHeading = useRef(false);
  const skippedStepHeading = useRef(false);
  const [nudgeKey, setNudgeKey] = useState(0);
  // SHELL-55: the guided step heading, the focus handoff target on a step change.
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);

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
    // `/brief/new` is a standing instruction, not a moment: never adopt the active
    // brief here, or the blank draft the user asked for is replaced by the campaign
    // they just left — a pristine draft passes the dirty guard below, so this is the
    // only thing stopping it.
    if (blank) return;
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
  }, [runBrief, briefs, briefsLoaded, blank]);

  // Arriving here means the last campaign is no longer the one being worked on. Let go
  // of it in the shell too: while it stayed active the selector kept advertising it and
  // Generate would have run it.
  //
  // Once, on arrival — this releases the brief the page *found*, never one it goes on to
  // create. Watching `runBrief.id` instead would fire again the moment Apply makes the
  // new draft active and throw it straight back away.
  const releasedRef = useRef(false);
  useEffect(() => {
    if (!blank || releasedRef.current) return;
    releasedRef.current = true;
    // The active brief only — not its autosaved draft. Reaching this page is not always
    // preceded by the unsaved-changes prompt: the dirty flag belongs to a mounted
    // editor, so coming here from any other view asks nothing, and a draft deleted then
    // is work the D11 recovery exists to keep. Letting go of the campaign is what stops
    // the selector advertising it and Generate running it; the draft stays where it is,
    // and comes back if its brief is opened again.
    setRunBrief(blankBrief());
  }, [blank, setRunBrief]);

  // …and the moment there is a campaign again, this page has stopped describing a new
  // brief, so the URL must stop saying so. Applying, saving, saving-as and choosing one
  // in the shell all arrive here as the same transition — no campaign, then one — which
  // is why none of those handlers navigates for itself.
  //
  // The transition is what matters, not the value: on the first commit `runBrief` is
  // still whatever the release above is in the middle of clearing, and reacting to that
  // would bounce straight back off this route.
  const previousBriefId = useRef(runBrief.id);
  useEffect(() => {
    const previous = previousBriefId.current;
    previousBriefId.current = runBrief.id;
    if (!blank || !releasedRef.current) return;
    if (previous === "" && runBrief.id !== "") router.replace("/brief");
  }, [blank, runBrief.id, router]);

  // Validate on state change
  useEffect(() => {
    const existingIds = briefs.map((b) => b.brief.id);
    setErrors(validateState(state, existingIds));
    // D7: Save is blocked by structural invalidity only. A capability being off
    // makes the draft unrunnable on this host, not unsavable — so the gating check
    // runs the same validation with the capability unknown. The API parses saves in
    // authoring mode; a motion brief must round-trip on a host without ffmpeg.
    const structural = validateState({ ...state, capabilities: null }, existingIds);
    setBlockedAt(
      Object.keys(structural).find((section) => getTotalErrorCount({ [section]: structural[section] }) > 0) ?? null,
    );
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

  // L1.1: Compute visible errors (gated by touched/attempted)
  const visibleErrors = useMemo(() => {
    if (attempted) return errors;
    const filtered: Record<string, FieldErrors> = {};
    for (const [section, sectionErrors] of Object.entries(errors)) {
      const filteredSection: FieldErrors = {};
      for (const [key, msg] of Object.entries(sectionErrors)) {
        const host = SECTION_HOSTS[section] ?? section;
        if (touched.has(key) || touchedSections.has(section) || touchedSections.has(host)) filteredSection[key] = msg;
      }
      if (Object.keys(filteredSection).length > 0) filtered[section] = filteredSection;
    }
    return filtered;
  }, [errors, touched, touchedSections, attempted]);

  // L1.1: Touch field on blur
  const handleMainBlur = useCallback((e: React.FocusEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const field = target.closest('[data-field-key]') as HTMLElement | null;
    if (field) {
      // Every `data-field-key` in the tree comes from error-sections.ts, and the
      // coverage test proves that set matches what validateState emits — so a key
      // found here is known by construction.
      // The element matched `[data-field-key]`, so the attribute is present by
      // construction. A Set add is idempotent, so there is nothing to branch on.
      const key = field.getAttribute("data-field-key") as string;
      setTouched((prev) => new Set(prev).add(key));
    }
  }, []);

  const sectionErrorsVisible = (section: string): FieldErrors => visibleErrors[section] ?? {};


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

  /** Section errors before the first validation pass lands. */

  // W6.2 — the reveal center. W4.2's outline handoff (scroll + focus) is one call
  // site of a single verb, and the FloatingBar's verbs are the rest: every row, link
  // or chip that wants to point at a section ends here. In Guided the section may
  // live on another step — then the step switches first, and the scroll runs once the
  // section is mounted, so a chip's click lands in the same place it does today.
  const focusSection = useCallback((section: string) => {
    // Same candidate strategy as `revealSection`: a section placed in the left bar
    // exists twice below `lg`, so prefer the copy that is actually laid out.
    const target = Array.from(
      document.querySelectorAll<HTMLElement>(`#${section}, [data-section="${section}"]`),
    ).find((el) => el.getClientRects().length > 0);
    if (!target) return;
    // A `<section>` is not focusable by default; make it so for the handoff, without
    // pulling the scroll position back (the scroll above already placed it). Assigned
    // unconditionally — it is idempotent, and guarding it would add a branch no test
    // can reach, since every section here starts at the default -1.
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }, []);

  const reveal = useCallback(
    (section: string, focus = false) => {
      // Motion has no section and no step; it validates inside its Output host, so a
      // motion chip points at whatever step hosts Output and scrolls the motion panel.
      const step = section === "motion" ? "output" : section;
      const targetStepIndex = steps.findIndex((candidate) => candidate === step);
      if (presentation === "guided" && targetStepIndex !== -1 && targetStepIndex !== stepIndex) {
        pendingReveal.current = { section, focus };
        go(targetStepIndex);
        return;
      }
      revealSection(section);
      if (focus) focusSection(step);
    },
    [presentation, steps, stepIndex, go],
  );

  /** The outline's rows crawl their section into view and hand it focus (W4.2). */
  const outlineActivate = useCallback((section: string) => reveal(section, true), [reveal]);

  // W6.2 — the deferred half of a reveal. The scroll (and focus, for the outline) set
  // aside by a guided step switch runs here, once the section is mounted under the new
  // step. Marker consumed so a later step of the same index cannot replay it.
  useLayoutEffect(() => {
    const pending = pendingReveal.current;
    if (!pending) return;
    pendingReveal.current = null;
    revealSection(pending.section);
    if (pending.focus) focusSection(pending.section);
    // The reveal already pointed at the step's own content; the step-change focus
    // handoff must not steal it. (A chip reveal is scroll-only and expects the same.)
    suppressStepHeading.current = true;
  }, [stepIndex, focusSection]);

  // SHELL-55: the step heading is the focus handoff target on a step change — *never*
  // on first render, and never after a reveal that already pointed somewhere. The
  // heading is mounted for every guided step (including review), so the call needs no
  // guard: a non-null ref here is guaranteed by construction.
  useEffect(() => {
    if (!skippedStepHeading.current) {
      skippedStepHeading.current = true;
      return;
    }
    if (suppressStepHeading.current) {
      suppressStepHeading.current = false;
      return;
    }
    (stepHeadingRef.current as HTMLHeadingElement).focus();
  }, [stepIndex]);

  // D4/U1: the mode chooser is the first decision a brief makes, so it is the first
  // thing the bar shows. Published like every other editor panel — the page keeps the
  // dispatch, the bar only places it — which also gives the mobile menu the chooser.
  // The Sections outline (D25) sits directly below the pair: below the mode, but
  // before the read-only brief, so mode stays the first decision (GB-D4).
  useEffect(() => {
    setTopPanels(
      <>
        <ModePanel mode={state.mode} onSetMode={(mode: CampaignMode) => dispatch({ type: "setMode", mode })} />
        <SectionOutline mode={state.mode} visibleErrors={visibleErrors} onActivate={outlineActivate} />
      </>,
    );
    return () => setTopPanels(null);
  }, [state.mode, visibleErrors, setTopPanels, outlineActivate]);

  // Publish the sections that live in the left bar while this editor is mounted. The
  // page keeps the state, dispatch and validation and republishes on every change; the
  // bar only places them. The Estimate travels with it (D31): it was previously inside
  // PolicySection alone, so a Classic draft had no deliverables readout at all — now it
  // is published for both modes, randomized through the planner and classic derived.
  const policyErrors = Object.keys(sectionErrorsVisible("policy")).length;
  useEffect(() => {
    setPanels(
      <>
        {state.mode === "variation" && presentation === "everything" ? (
          // W6: the sidebar's policy panel lives on the policy step in Guided — the
          // only section that does not render inside the step card — so it is
          // published only for the everything presentation.
          // The panel renders in the sidebar, outside this page's DOM subtree, so it
          // needs its own capture: a click on an axis card there is still "the user
          // has been to the policy section" (D1).
          <div onClickCapture={touchSectionFromEvent} data-section="policy">
          <Accordion
            title="Variation Policy"
            aside={
              policyErrors > 0 ? (
                <ErrorPill count={policyErrors} />
              ) : null
            }
          >
            <PolicySection state={state} dispatch={dispatch} errors={sectionErrorsVisible("policy")} compact />
          </Accordion>
          </div>
        ) : null}
        <Accordion title="Estimate">
          <EstimatePanel state={state} />
        </Accordion>
      </>,
    );
    return () => setPanels(null);
    // sectionErrors only reads what `errors` already covers.
  }, [state, errors, policyErrors, setPanels, touchSectionFromEvent, presentation]);

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
    // L1.1: Loaded brief shows real errors at once
    setAttempted(true);
  };

  const createNew = () => {
    // Already on the blank route: there is nowhere to navigate to, so empty the form in
    // place. `guardedPush` would be a no-op on the same URL and nothing would reset.
    if (blank) {
      if (!confirmReplace()) return;
      // No entry means `fromBrief` produces a "new" source, which is what a blank draft is.
      dispatch({ type: "load", brief: blankBrief() });
      // L1.1: New brief resets touched/attempted
      setAttempted(false);
      setTouched(new Set());
      setTouchedSections(new Set());
      return;
    }
    // guardedPush carries the unsaved-changes prompt, so confirmReplace here would ask
    // the same question twice.
    guardedPush("/brief/new");
  };

  // D3: the refusal lives in the handler, never in a `disabled` attribute. A dead
  // primary button cannot say why it is dead, and it also blocks the one gesture that
  // reveals the errors — pressing it is how a user asks "what is wrong?". So the verbs
  // stay live, and an invalid draft is answered: attempted, every error shown, the
  // status sentence refusing, and the view scrolled to the first problem.
  const refuseInvalid = (): boolean => {
    setAttempted(true);
    if (blockedAt === null) return false;
    reveal(blockedAt);
    return true;
  };

  const handleApply = () => {
    if (refuseInvalid()) return;
    const brief = toBrief(state);
    dispatch({ type: "apply", applied: brief });
    setRunBrief(brief);
    // D7: applying a motion brief on a host that cannot run it must not pretend it
    // will produce clips — surface the probe's reason (the text the API's 400 would
    // quote) as the status message. Run still refuses it server-side.
  };

  const handleSave = async () => {
    if (refuseInvalid()) return;
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
    if (refuseInvalid()) return;
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
      // Keep what the API returns: the copy's revision is the conditional-write guard
      // for the *next* save of it. Dropping it here downgraded that save to
      // last-write-wins, which is the same trap `loadBrief` carries the revision to avoid.
      let created;
      try {
        created = await createBrief(newBrief, taken ? { replace: true } : {});
      } catch (error) {
        if (!isBriefsApiError(error) || error.status !== 409) throw error;
        if (!window.confirm(`A brief with id "${newId}" already exists. Overwrite it?`)) {
          setSaving(false);
          return;
        }
        created = await createBrief(newBrief, { replace: true });
      }
      dispatch({
        type: "load",
        brief: newBrief,
        entry: { file: created.file, ...(created.revision === undefined ? {} : { revision: created.revision }) },
      });
      // The editor is on the copy now, so the shell must be too — otherwise Generate
      // runs the brief this one was copied from, which is the trap `loadBrief` documents.
      setRunBrief(newBrief);
      purgeDraftFromStorage(state);
      await loadBriefs();
      setSaveAsId(null);
    } catch (error) {
      setPersistError(unknownErrorMessage(error, "Save as failed"));
    } finally {
      setSaving(false);
    }
  };

  // The errors behind one step. `errors` is keyed by every bucket once validation has
  // landed, but the first paint carries the empty put-state — so the bucket read still
  // falls back, and the guided first paint is what exercises that side. Motion folds
  // into its Output host, exactly as the FloatingBar's strip treats it.
  const stepSectionErrors = useCallback(
    (step: StepId): FieldErrors => {
      if (step === "review") return {};
      return step === "output" ? { ...errors.output, ...errors.motion } : (errors[step] ?? {});
    },
    [errors],
  );

  // D3, on the step's own terms: a refused Next sets the attempted flag, reveals that
  // step's errors and replays the one-shot nudge — it never disables the button, so
  // pressing Next again is how the user re-asks what stands in the way.
  const handleNext = useCallback(() => {
    const sectionErrors = stepSectionErrors(steps[stepIndex]);
    if (Object.keys(sectionErrors).length > 0) {
      setAttempted(true);
      reveal(steps[stepIndex]);
      setNudgeKey((key) => key + 1);
      return;
    }
    setNudgeKey(0);
    go(stepIndex + 1);
  }, [steps, stepIndex, stepSectionErrors, reveal, go]);

  // W6.5 — the step's status sentence: the review step speaks for the whole brief,
  // and every other step says the first thing wrong or "Looking good."
  const stepFooterStatus = useMemo(() => {
    const step = steps[stepIndex];
    // The bucket read first: `stepSectionErrors` answers for "review" too (all of
    // nothing), and the step sentence that follows uses the same voice for both.
    const sectionErrors = stepSectionErrors(step);
    if (step === "review") return messages.statusStepReview;
    return Object.keys(sectionErrors).length > 0
      ? Object.values(sectionErrors)[0]
      : messages.statusStepReady;
  }, [steps, stepIndex, stepSectionErrors]);

  const handleDiscard = () => {
    dispatch({ type: "discard" });
    purgeDraftFromStorage(state);
    // L1.1: Discard resets touched/attempted
    setAttempted(false);
    setTouched(new Set());
    setTouchedSections(new Set());
  };

  /**
   * A guided step card wraps the same sections the everything stack renders — one at a
   * time, so a step and "the section on that step" are the same thing. The switch is
   * over the closed six (exhaustive): the review step is handled by the caller, and the
   * mode-derived step list guarantees this only ever receives one of these six.
   */
  const renderStepSection = (section: SectionId) => {
    switch (section) {
      case "identity":
        return <IdentitySection state={state} dispatch={dispatch} errors={sectionErrorsVisible("identity")} />;
      case "copy":
        return (
          <CopySection
            state={state}
            dispatch={dispatch}
            errors={sectionErrorsVisible("copy")}
            onOpenPool={() => setPoolDrawerOpen(true)}
          />
        );
      case "products":
        return <ProductsSection state={state} dispatch={dispatch} errors={sectionErrorsVisible("products")} />;
      case "treatments":
        return <TreatmentsSection state={state} dispatch={dispatch} errors={sectionErrorsVisible("treatments")} />;
      case "output":
        return (
          <OutputSection
            state={state}
            dispatch={dispatch}
            errors={{ ...sectionErrorsVisible("output"), ...sectionErrorsVisible("motion") }}
          />
        );
      case "policy":
        return <PolicySection state={state} dispatch={dispatch} errors={sectionErrorsVisible("policy")} />;
    }
  };

  return (
    // No h-full / inner overflow: like every other view, this one flows and the
    // shell's main container is the scroller. The action bar and the YAML panel stay
    // put with `sticky`, which is scoped to that container — never the viewport.
    <div className="flex flex-col">
      <div className="flex items-start">
       <SectionModeContext.Provider value={state.mode}>
           {/* Main content */}
            <div
              className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-8 pb-24"
              onBlurCapture={handleMainBlur} onClickCapture={touchSectionFromEvent}
            >
          {/* Header with selector, status chip, and the presentation toggle.
              In Guided the chip moves out of this row — the StepHeader announces the
              step's own status — so this row only ever holds one of the two. */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <BriefSelector
                briefs={briefs}
                currentId={state.source.kind === "file" ? state.source.loadedId : undefined}
                onSelect={loadBrief}
                onCreateNew={createNew}
              />
              {presentation === "everything" ? <StatusChip state={state} /> : null}
            </div>
            <div
              role="group"
              aria-label={messages.presentationLabel}
              className={cn("shrink-0 items-center gap-1", presentation === "guided" ? "flex" : "hidden")}
            >
              <button
                type="button"
                aria-pressed={presentation === "guided"}
                onClick={() => choosePresentation("guided")}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors",
                  presentation === "guided"
                    ? "bg-surface-2 text-text-emphasis"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-primary",
                )}
              >
                {messages.presentationGuided}
              </button>
              <button
                type="button"
                aria-pressed={presentation === "everything"}
                onClick={() => choosePresentation("everything")}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors",
                  presentation === "everything"
                    ? "bg-surface-2 text-text-emphasis"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-primary",
                )}
              >
                {messages.presentationEverything}
              </button>
            </div>
          </div>

          {/* Sections: the whole stack (Everything) or one step (Guided) */}
          {presentation === "guided" ? (
            <div className="space-y-8">
              <StepHeader
                step={stepIndex + 1}
                total={steps.length}
                title={stepTitle(steps[stepIndex])}
                subtitle={STEP_SUBTITLES[steps[stepIndex]]}
                state={state}
                headingRef={stepHeadingRef}
              />
              <div>
                {steps[stepIndex] === "review" ? (
                  <p className="text-[13px] text-text-primary">{messages.stepReviewIntro}</p>
                ) : (
                  renderStepSection(steps[stepIndex])
                )}
              </div>
              <StepFooter
                statusText={stepFooterStatus}
                onBack={stepIndex > 0 ? () => go(stepIndex - 1) : undefined}
                onNext={steps[stepIndex] === "review" ? undefined : () => handleNext()}
                nextLabel={steps[stepIndex] === "output" ? messages.stepNextReviewLaunch : undefined}
                nudgeKey={nudgeKey}
              />
            </div>
          ) : (
            <div className="space-y-8">
               <div>
                 <IdentitySection state={state} dispatch={dispatch} errors={sectionErrorsVisible("identity")} />
               </div>
               <div>
                 <CopySection state={state} dispatch={dispatch} errors={sectionErrorsVisible("copy")} onOpenPool={() => setPoolDrawerOpen(true)} />
               </div>
               <div>
                 <ProductsSection state={state} dispatch={dispatch} errors={sectionErrorsVisible("products")} />
               </div>
               <div>
                 {state.mode === "brief" ? (
                   <TreatmentsSection state={state} dispatch={dispatch} errors={sectionErrorsVisible("treatments")} />
                 ) : null}
               </div>
               <OutputSection
                 state={state}
                 dispatch={dispatch}
                 errors={{ ...sectionErrorsVisible("output"), ...sectionErrorsVisible("motion") }}
               />
            </div>
          )}

        </div>

        {/* YAML split view */}
        {showYamlSplit && (
          <div className="sticky top-0 max-h-screen w-96 shrink-0 self-start overflow-y-auto border-l border-border bg-surface p-4">
            <pre className="overflow-auto text-[11px] text-text-primary">
              {JSON.stringify(toBrief(state), null, 2)}
            </pre>
          </div>
         )}
        </SectionModeContext.Provider>
      </div>

      {/* Floating bar (L1.4) */}
       <FloatingBar data-testid="action-bar">
         <div className="flex items-center gap-3 w-full">
           <StatusLine
             state={state}
             attempted={attempted}
             applyRefusal={applyRefusal}
             persistError={persistError}
             onScrollToSection={reveal}
           />
           <div className="min-w-0 flex-1">
             {getTotalErrorCount(visibleErrors) > 0 ? <ErrorStrip errors={visibleErrors} onErrorClick={reveal} /> : null}
           </div>
           <Button variant="ghost" onClick={handleDiscard}>
             Discard
           </Button>
           <SaveMenu
             /* D3: never a dead primary button — pressing an invalid brief sets
                `attempted`, reveals every error and speaks the refusal. */
             saving={saving}
             onSaveAndApply={() => void handleSave()}
             onSaveAs={() => setSaveAsId("")}
           />
           <Button onClick={handleApply}>
             Apply to run
           </Button>
           {/* D3: the bar's primary row is the status sentence and the three verbs.
               Developer affordances live behind the overflow so the sentence has room. */}
           <details className="relative">
             <summary
               className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-primary"
               aria-label="More actions"
             >
               ⋯
             </summary>
             <div className="absolute bottom-full right-0 z-30 mb-2 min-w-[200px] rounded-md border border-border bg-surface p-1 shadow-2xl">
               <button
                 type="button"
                 className="w-full rounded-sm px-3 py-2 text-left text-[13px] text-text-primary hover:bg-surface-2"
                 onClick={() => setShowYamlSplit(!showYamlSplit)}
               >
                 YAML split {showYamlSplit ? "off" : "on"}
               </button>
             </div>
           </details>
         </div>
       </FloatingBar>

       {/* Headline pool drawer */}
       <HeadlinePoolDrawer
         state={state}
         dispatch={dispatch}
         open={poolDrawerOpen}
         onClose={() => setPoolDrawerOpen(false)}
       />

       {/* Save as dialog */}
      {saveAsId !== null && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-scrim/80 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-as-title"
            className="w-full max-w-md rounded-xl border border-border bg-surface p-6"
          >
            <h3 id="save-as-title" className="mb-4 text-sm font-semibold text-text-emphasis">Save as...</h3>
            <p className="mb-4 text-[12px] text-text-muted">
              This creates a copy. The original file stays on disk until deleted.
            </p>
            {/* The kit's input, so the Save-as field has the same focus halo as
                every other field in the editor — this one had none at all. */}
            <Input
              type="text"
              aria-label="New brief id"
              placeholder="New brief id"
              value={saveAsId}
              onChange={(e) => setSaveAsId(e.target.value)}
              className="mb-4"
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
