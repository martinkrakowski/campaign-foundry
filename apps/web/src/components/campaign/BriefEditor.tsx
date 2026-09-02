"use client";

import { useReducer, useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect, type ReactNode, type RefObject } from "react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { Button, Input, SegBar, OverflowMenu, ConfirmDialog, useDialogFocusTrap } from "@/components/ui";
import { useRun } from "@/lib/run-context";
import { useRouter } from "next/navigation";
import { dump } from "js-yaml";
import Link from "next/link";
import { useGuardedNavigation } from "@/lib/use-guarded-navigation";
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
  valuesEqual,
  getDraftKey,
  saveDraftToStorage,
  loadDraftFromStorage,
  purgeDraftFromStorage,
  blankBrief,
  slugify,
} from "@/components/campaign/editor-state";
import {
  validateState,
  getTotalErrorCount,
  motionUnavailableReason,
  SAFE_ID_PATTERN,
  type FieldErrors,
} from "@/components/campaign/validate";
import { IdentitySection, CopySection, ProductsSection, TreatmentsSection, OutputSection, PolicySection } from "@/components/campaign/sections";
import { StatusChip } from "@/components/campaign/StatusChip";
import { StatusLine } from "@/components/campaign/StatusLine";
import { ErrorStrip, MOTION_ERROR_KEY, MOTION_HOST_SECTION, sectionForErrorBucket } from "@/components/campaign/ErrorStrip";
import { ErrorPill } from "@/components/ui/error-pill";
import { useEditorDirty, type DraftRunHandoff } from "@/lib/editor-dirty-context";
import { FloatingBar } from "@/components/shell/FloatingBar";
import { SectionModeContext } from "@/components/campaign/SectionModeContext";
import { useEditorPanels } from "@/lib/editor-panels-context";
import { Accordion } from "@/components/shell/Accordion";
import { revealSection } from "@/lib/scroll-to-section";
import {
  useStepNavigation,
  stashStep,
  useStepKeys,
  useStepSwipe,
  useBecameTrue,
  STEP_TRANSITION_MS,
} from "@/lib/use-step-navigation";
import { cn } from "@/lib/cn";
import { BriefSelector } from "@/components/campaign/BriefSelector";
import { HeadlinePoolDrawer } from "@/components/campaign/HeadlinePoolDrawer";
import { AssetPickerDrawer } from "@/components/campaign/AssetPickerDrawer";
import { ModePanel } from "@/components/ui/mode-panel";
import { SectionOutline } from "@/components/ui/section-outline";
import { EstimatePanel } from "@/components/campaign/EstimatePanel";
import { StepHeader } from "@/components/campaign/StepHeader";
import { StepFooter } from "@/components/campaign/StepFooter";
import { SECTION_TITLES, sectionOrder, LayoutSection, type SectionId } from "./sections";
import { ReviewStep } from "./ReviewStep";
import { PreviewDock } from "./PreviewDock";
import { previewDockProps } from "./preview-props";
import * as messages from "./messages";
import type { CampaignMode } from "@/components/campaign/editor-state";

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

/** The two views the preview rail switches between (D61) — exclusive, never side by side. */
type RailView = "preview" | "yaml";

const RAIL_VIEW_KEY = "cf:preview-rail-view";

/**
 * The one rail view the editor reads or writes, closed over two values — the same
 * guarded pair the presentation reads, so a private-mode store can neither throw
 * nor leave the two controls disagreeing about the last choice.
 */
function readRailView(): RailView {
  try {
    const stored = window.localStorage.getItem(RAIL_VIEW_KEY);
    if (stored === "preview" || stored === "yaml") return stored;
    return "preview";
  } catch {
    return "preview";
  }
}

function persistRailView(next: RailView): void {
  try {
    window.localStorage.setItem(RAIL_VIEW_KEY, next);
  } catch {
    // Storage unavailable in this context; the switch still works for the tab.
  }
}

/** The subtitle under each step heading, keyed by the same vocabulary as the headings. */
const STEP_SUBTITLES: Record<StepId, string> = {
  identity: messages.stepSubtitleIdentity,
  copy: messages.stepSubtitleCopy,
  products: messages.stepSubtitleProducts,
  treatments: messages.stepSubtitleTreatments,
  layout: messages.stepSubtitleLayout,
  policy: messages.stepSubtitlePolicy,
  output: messages.stepSubtitleOutput,
  review: messages.stepSubtitleReview,
};

function stepTitle(step: StepId): string {
  return step === "review" ? "Review" : SECTION_TITLES[step];
}

/**
 * The campaign editor. Two routes render it: `/brief/{id}` edits that brief — the
 * route is the single source of truth for which brief is open (D37), so a reload or
 * a shared link lands on exactly it — and `/brief/new` starts a blank one. The
 * difference is the `briefId` prop, which is a statement about the URL rather than a
 * moment in a click handler: absent means the blank route, and that holds for the
 * whole life of the page, rather than for the one render before something adopts a
 * brief behind the route's back.
 */
export function BriefEditor({ briefId: routeId }: { briefId?: string }) {
  const blank = routeId === undefined;
  const { brief: runBrief, setBrief: setRunBrief } = useRun();
  const router = useRouter();
  const { guardedPush } = useGuardedNavigation();
  const { setDirty, setDraftRun } = useEditorDirty();
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
  // D9 — the Save-as overwrite decision, parked between attempt and answer. Set when
  // the first write attempt finds the id taken (the listing knew, or the API's 409
  // said so); the dialog's confirm is what sends `{ replace: true }`.
  const [pendingOverwrite, setPendingOverwrite] = useState<string | null>(null);
  // Synchronous latch for the overwrite retry. `saving` is React state, so a second
  // confirm in the same frame still reads the pre-setSaving closure and would POST
  // `{ replace: true }` twice and run `adoptSavedCopy` twice. The ref is set at
  // entry and cleared in `finally` — a `saving` check is the stale-closure trap.
  const overwriteInFlightRef = useRef(false);
  // The Save-as dialog's field: where the invalid-id guard hands focus back (D3).
  const saveAsFieldRef = useRef<HTMLInputElement | null>(null);
  const saveAsDialogRef = useRef<HTMLDivElement | null>(null);
  // The Save-as dialog is `aria-modal` but was hand-rolled, so it had no Escape and
  // no focus containment: Cancel was the only way out, and Tab walked off into the
  // editor behind the scrim. The kit hook every other overlay uses supplies both,
  // plus focus restoration to whatever opened it.
  useDialogFocusTrap({
    open: saveAsId !== null,
    // Not while the write is in flight. `handleSaveAs` captures the draft before it
    // awaits and dispatches `load` — a full state replace — when the server answers,
    // so any edit typed between a dismissal and that answer is silently discarded.
    // The door was already open via Cancel, which `main` never gated either; adding
    // Escape without this would have widened a live data-loss race.
    onClose: () => {
      if (!saving) setSaveAsId(null);
    },
    dialogRef: saveAsDialogRef,
    initialFocusRef: saveAsFieldRef,
  });
  // D61 — the rail remembers its last view, the way the presentation remembers itself.
  // "preview" on the FIRST render, always: the server has no storage, so reading it
  // in the initializer renders one view there and the other here, and hydration
  // mismatches — the trap Disclosure documents. The remembered view applies on mount.
  const [railView, setRailView] = useState<RailView>("preview");
  useEffect(() => {
    const stored = readRailView();
    if (stored !== "preview") setRailView(stored);
  }, []);
  const chooseRailView = useCallback((next: RailView) => {
    setRailView(next);
    persistRailView(next);
  }, []);
  const [poolDrawerOpen, setPoolDrawerOpen] = useState(false);
  // M7 — which product opened the Asset Bin. The drawer itself renders at this
  // component's root, outside the transformed step card: the card is the containing
  // block for `fixed` descendants, so a drawer mounted inside it (as ProductsSection
  // once did) could never cover the viewport in Guided. Same hoist, same reason as
  // the headline pool drawer above.
  const [assetPickerKey, setAssetPickerKey] = useState<number | null>(null);
  // D14 — the replace confirmation's parked action, the two-phase form of the old
  // synchronous `window.confirm` gate: a dirty draft ends the gesture here, the
  // ConfirmDialog asks, and the confirm (or the refusal) finishes the story.
  const [pendingReplace, setPendingReplace] = useState<(() => void) | null>(null);
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
  // W7.1: `direction` and `maxVisited` come off the same cursor — the segbar paints
  // the walk (how far it got) and the step card slides the way the user came.
  const { index: stepIndex, direction, maxVisited, go } = useStepNavigation(steps);

  // W6.2: a reveal that points at another step cannot scroll there synchronously —
  // in Guided the target section is unmounted until the step change commits. The
  // pending marker is spent in a layout effect on the committed step.
  const pendingReveal = useRef<{ section: string; step: string; focus: boolean } | null>(null);
  // The reveal that drove a step change already pointed at the step's own content, so
  // the step-change focus lands nowhere else. Consumed by the step-focus effect.
  const suppressStepHeading = useRef(false);
  const lastFocusedStep = useRef<number | null>(null);
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
  // matters — on a named route the draft key only becomes the brief's own once the
  // route's brief has loaded, so an unsaved edit is only ever recoverable once the
  // editor has settled on the brief it belongs to (H6: `/brief/new`'s key is stable,
  // so a reload there finds its draft immediately).
  const draftKey = getDraftKey(state);
  const routeLoadedId = state.source.kind === "file" ? state.source.loadedId : undefined;
  useEffect(() => {
    // On a named route, wait for the route's brief: before it lands the draft key is
    // not yet the route's, and restoring against it would seed the editor with a
    // draft the URL says nothing about.
    if (routeId !== undefined && routeLoadedId !== routeId) return;
    const draft = loadDraftFromStorage(state);
    // The same `valuesEqual` the dirty checks use, not a second stringified
    // comparison: a key-order-sensitive stringify here would restore a draft
    // whose keys merely arrived in a different order. The helper is shape-agnostic
    // — editor states are JSON-able, so the same canonicalisation applies.
    if (draft && !valuesEqual(draft, state)) {
      dispatch({ type: "restore", state: draft });
    }
  }, [draftKey, routeId, routeLoadedId]);

  // D37 — the route drives the load, and nothing else does. `routeId` is the URL's
  // word for which brief is open, and it is the only source of truth: the editor
  // loads that brief from the listing (carrying its file identity and revision —
  // the conditional-write guard for the next save), and the shell follows *after*
  // the load succeeds, so Generate runs what the URL shows. One direction only:
  // the editor never follows `runBrief`, or the two would be two sources of truth
  // for the same question — the bug this fixes.
  const [unknownId, setUnknownId] = useState<string | null>(null);
  useEffect(() => {
    if (routeId === undefined) return;
    // SAFE_ID_PATTERN is the one rule a brief id answers to (the same one the
    // Save-as backstop enforces): a malformed id cannot name a brief, so it is
    // refused here — before any match attempt, and before anything reaches the API.
    if (!SAFE_ID_PATTERN.test(routeId)) {
      setUnknownId(routeId);
      return;
    }
    // Wait for the listing: loading before it arrives would miss the entry, and the
    // entry is where the file identity and revision come from.
    if (!briefsLoaded) return;
    if (routeLoadedId === routeId) return;
    const match = briefs.find((entry) => entry.brief.id === routeId);
    // M3: an id the listing does not know is answered where the user landed — the
    // empty state below — never a silent new unsaved draft.
    if (!match) {
      setUnknownId(routeId);
      return;
    }
    setUnknownId(null);
    dispatch({ type: "load", brief: match.brief, entry: { file: match.file, revision: match.revision } });
    // The file identity rides the load, so the canonical projection is what `apply`
    // snapshots — and committing the shell here (never before) is what makes
    // Generate run the brief the URL named.
    dispatch({ type: "apply" });
    setRunBrief(match.brief);
    // A loaded brief shows its real errors at once: they are the file's, not the
    // user's, and the user asked for this brief by opening the route.
    setAttempted(true);
  }, [routeId, routeLoadedId, briefs, briefsLoaded, setRunBrief]);

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

  // Validate on state change
  useEffect(() => {
    const existingIds = briefs.map((b) => b.brief.id);
    setErrors(validateState(state, existingIds));
    // D7: Save is blocked by structural invalidity only. A capability being off
    // makes the draft unrunnable on this host, not unsavable — so the gating check
    // runs the same validation with the capability unknown. The API parses saves in
    // authoring mode; a motion brief must round-trip on a host without ffmpeg.
    const structural = validateState({ ...state, capabilities: null }, existingIds);
    // M1: the refusal bounces to the first failing *step* in the order the user
    // walks, never the first bucket in validateState's key order — that order puts
    // `policy` before `output`, so a variation draft failing both used to land the
    // user on Variation Policy while the walk reaches Output first. Motion is not a
    // step; it sorts at its host's position, where its panel lives.
    const walk = sectionOrder(state.mode);
    const walkIndex = (bucket: string) =>
      walk.indexOf((bucket === MOTION_ERROR_KEY ? MOTION_HOST_SECTION : bucket) as SectionId);
    setBlockedAt(
      Object.keys(structural)
        .filter((bucket) => getTotalErrorCount({ [bucket]: structural[bucket] }) > 0)
        .sort((a, b) => walkIndex(a) - walkIndex(b))[0] ?? null,
    );
  }, [state, briefs]);

  // Update dirty state. The provider outlives this route, so clear the flag on unmount —
  // otherwise every later navigation in the shell keeps prompting.
  useEffect(() => {
    // The flag answers "is there unsaved work?". `isDirtySinceSave` alone would count
    // every unnamed draft as dirty by definition — which would make the guard prompt
    // "unsaved changes" on a pristine form, e.g. when the user picks a brief from the
    // blank route. A pristine editor has nothing to lose, so it never prompts.
    setDirty(!isPristine(state) && isDirtySinceSave(state));
    return () => setDirty(false);
  }, [state, setDirty]);

  // Auto-save, but only for a draft that has actually diverged from a pristine editor.
  // Writing unconditionally would recreate the key that Save and Discard just purged.
  useEffect(() => {
    if (isPristine(state)) return;
    saveDraftToStorage(state);
  }, [state]);

  // W8.1 — the review step's projection: one `toBrief` call, passed into `ReviewStep`,
  // so its rows are generated from exactly what Save sends — a field the projection
  // drops loses its row too, and the review can never disagree with the submission
  // about what the brief contains. Declared here (not beside the review step) because
  // the D35 handoff below reads it on every render.
  const draftBrief = useMemo(() => toBrief(state), [state]);
  // R7.2/D45 — the dock's props come from the one exported derivation, fed by the live
  // draft and the walk's cursor. Null (nothing to draw) means no rail at all: the
  // house rule is `hasProduct`, and the dock never invents a creative (D26).
  const railProps = useMemo(
    () => previewDockProps(state, stepIndex, steps.length),
    [state, stepIndex, steps.length],
  );
  /**
   * D35 — whether Generate's default target (the shell's brief) and the screen
   * disagree. A pristine editor holds the blank template, not a draft anybody is
   * editing, so it never counts as differing — otherwise a freshly mounted editor
   * (or a reverted one) would offer to run an empty form over a perfectly good
   * committed brief.
   */
  const draftDiffers = useMemo(
    () => !isPristine(state) && !valuesEqual(draftBrief, runBrief),
    [state, draftBrief, runBrief],
  );

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


  // Derived, not stored: the refusal describes the draft *as committed*, so it holds
  // exactly while the committed snapshot still matches the draft. Any edit — switching
  // away from motion, or a capability verdict landing — re-evaluates it, and storing
  // it would leave the page claiming motion is unavailable after that stopped being
  // true. Save and load both set the snapshot, so both surface it.
  const applied = state.appliedSnapshot !== null && !isDirtySinceApply(state);
  const applyRefusal = applied ? motionUnavailableReason(state) : undefined;
  // Committing changes state the user cannot see from here — the pipeline lives in the
  // top bar — so say plainly what happened and what runs it. Without this, a save
  // looked like it did nothing at all.

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
      // Motion has no section and no step; it validates inside its host, so a motion
      // chip points at whatever step hosts it and scrolls the motion panel. Read the
      // declared constants rather than spelling the pair again: the totality test
      // asserts them, and a third copy here would let the code and the test disagree
      // silently — the exact drift the vocabulary collapse exists to stop.
      const step = section === MOTION_ERROR_KEY ? MOTION_HOST_SECTION : section;
      const targetStepIndex = steps.findIndex((candidate) => candidate === step);
      if (presentation === "guided" && targetStepIndex !== -1 && targetStepIndex !== stepIndex) {
        pendingReveal.current = { section, step, focus };
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
    // The mapped step, matching the immediate path above: a motion reveal scrolls
    // `#motion` but hands focus to its host section, and the two paths must not
    // disagree about which.
    if (pending.focus) focusSection(pending.step);
    // The reveal already pointed at the step's own content; the step-change focus
    // handoff must not steal it. (A chip reveal is scroll-only and expects the same.)
    suppressStepHeading.current = true;
  }, [stepIndex, focusSection]);

  // SHELL-55: the step heading is the focus handoff target on a step change — *never*
  // on first render, and never after a reveal that already pointed somewhere. The
  // heading is mounted for every guided step (including review), so the call needs no
  // guard: a non-null ref here is guaranteed by construction.
  useEffect(() => {
    // Keyed off the step actually changing rather than a "have I run before" flag.
    // React StrictMode invokes an effect twice on mount, and a flag flipped by the
    // first pass lets the second one through — which stole focus on first paint in
    // development. Comparing the previous step is idempotent: a repeated run sees no
    // change and does nothing.
    const previous = lastFocusedStep.current;
    lastFocusedStep.current = stepIndex;
    if (previous === null || previous === stepIndex) return;
    if (suppressStepHeading.current) {
      suppressStepHeading.current = false;
      return;
    }
    (stepHeadingRef.current as HTMLHeadingElement).focus();
  }, [stepIndex]);

  // W7.2 — the card on its way out. Only the step it is and the way the user went;
  // the card itself is rendered from that, fresh, so nothing stale is held in state.
  const [exiting, setExiting] = useState<{ index: number; direction: 1 | -1 } | null>(null);
  const shownStep = useRef(stepIndex);

  useEffect(() => {
    const from = shownStep.current;
    // A re-run that is not a step change has nothing to animate out: the direction
    // can flip without the cursor moving, when the walk is asked for the step it is
    // already on.
    if (from === stepIndex) return;
    shownStep.current = stepIndex;
    setExiting({ index: from, direction });
  }, [stepIndex, direction]);

  // …and spent one transition later. Keyed on the card rather than the step, so
  // typing on the step that just arrived cannot clear the one that is leaving.
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => setExiting(null), STEP_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [exiting]);

  // D4/U1: the mode chooser is the first decision a brief makes, so it is the first
  // thing the bar shows. Published like every other editor panel — the page keeps the
  // dispatch, the bar only places it — which also gives the mobile menu the chooser.
  // The Sections outline (D25) sits directly below the pair: below the mode, but
  // before the read-only brief, so mode stays the first decision (GB-D4).
  useEffect(() => {
    // M3: while the route's id names no brief there is no editor to publish for —
    // the shell's panels would be controls mutating a draft nobody can see.
    if (unknownId !== null) {
      setTopPanels(null);
      return;
    }
    setTopPanels(
      <>
        <ModePanel mode={state.mode} onSetMode={(mode: CampaignMode) => dispatch({ type: "setMode", mode })} />
        <SectionOutline mode={state.mode} visibleErrors={visibleErrors} onActivate={outlineActivate} />
      </>,
    );
    return () => setTopPanels(null);
  }, [state.mode, visibleErrors, setTopPanels, outlineActivate, unknownId]);

  // Publish the sections that live in the left bar while this editor is mounted. The
  // page keeps the state, dispatch and validation and republishes on every change; the
  // bar only places them. The Estimate travels with it (D31): it was previously inside
  // PolicySection alone, so a Classic draft had no deliverables readout at all — now it
  // is published for both modes, randomized through the planner and classic derived.
  const policyErrors = Object.keys(sectionErrorsVisible("policy")).length;
  useEffect(() => {
    // Same M3 gate as the top panels: no editor, nothing published.
    if (unknownId !== null) {
      setPanels(null);
      return;
    }
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
  }, [state, errors, policyErrors, setPanels, touchSectionFromEvent, presentation, unknownId]);

  /**
   * Every path that replaces the draft goes through the same D14 confirmation — now
   * two-phase. `window.confirm` blocked the thread synchronously, which is the defect
   * family the kit's ConfirmDialog exists for: a dirty draft parks the action in
   * `pendingReplace` and the dialog asks (the shell's own "Unsaved edits" pattern —
   * one prompt, a refusal changes nothing, and re-triggering never stacks a second
   * question, DESIGN.md §5). A clean draft acts at once. Callers fire-and-forget —
   * the parked action is the contract; the old boolean "did it proceed?" is gone.
   */
  const requestReplace = (action: () => void): void => {
    if (isPristine(state) || !isDirtySinceSave(state)) {
      action();
      return;
    }
    // Never stack: a second trigger while one question stands changes nothing.
    setPendingReplace((prev) => prev ?? action);
  };

  /**
   * D37: picking a brief is navigating to it — the same act the shell's picker
   * performs. The route drives the load (with the entry's file identity and
   * revision, so the next save guards its write), and the shell follows after the
   * load succeeds. The guarded push carries the unsaved-changes prompt — asking
   * `confirmReplace` here too would be the same question twice — and a refused
   * prompt does not navigate.
   */
  const loadBrief = (entry: BriefEntry) => {
    guardedPush(`/brief/${entry.brief.id}`);
  };

  const createNew = () => {
    // Already on the blank route: there is nowhere to navigate to, so empty the form in
    // place. `guardedPush` would be a no-op on the same URL and nothing would reset.
    if (blank) {
      // H6: the blank route's draft key is stable, so the discarded draft occupies
      // the very key a reload would restore from — purge it here, where the reset
      // makes the editor pristine and autosave will not refill it (the L1 rule).
      // No entry means `fromBrief` produces a "new" source, which is what a blank
      // draft is.
      requestReplace(() => {
        purgeDraftFromStorage(state);
        dispatch({ type: "load", brief: blankBrief() });
        // L1.1: New brief resets touched/attempted
        setAttempted(false);
        setTouched(new Set());
        setTouchedSections(new Set());
      });
      return;
    }
    // guardedPush carries the unsaved-changes prompt, so requestReplace here would ask
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
    // H2: the press that bounces unmounts its own button, so focus would drop to
    // `document.body` — no landing point at all for a keyboard or screen-reader
    // user. The refusal hands focus to the revealed section, the same target the
    // outline's activation uses (W4.2); the reveal's step-heading suppression keeps
    // the step handoff from fighting it.
    reveal(blockedAt, true);
    return true;
  };

  /**
   * D35: Save writes the file and commits the brief to the shell — the one act, told
   * once. Resolves with the brief exactly as the server stored it (what Generate's
   * "Save and run" runs), or null when the draft was refused or the write failed; the
   * status surface already speaks for those, so callers have nothing to add.
   */
  const handleSave = async (): Promise<CampaignBrief | null> => {
    if (refuseInvalid()) return null;
    setSaving(true);
    setPersistError(undefined);
    try {
      const brief = toBrief(state);
      // Keep what the API returns: the stored revision is the conditional-write guard
      // for the *next* save. Discarding it left state.source.revision at its load-time
      // value, so the second save of any loaded brief sent a stale revision and was
      // refused with an untrue "Brief was modified by another user." — the same trap
      // loadBrief and handleSaveAs carry the revision to avoid.
      const stored =
        state.source.kind === "file"
          ? await updateBrief(state.source.loadedId, brief, { revision: state.source.revision })
          : await createBrief(brief);
      // `save` (not `load`): the snapshot and the fresh file identity/revision ride
      // the save action, so the draft the user kept typing into is NOT replaced —
      // edits made while the request was in flight survive and stay dirty. A
      // first-time save still gains its file identity, so the next save is a
      // conditional PUT rather than another POST.
      dispatch({
        type: "save",
        saved: stored.brief,
        entry: { file: stored.file, ...(stored.revision === undefined ? {} : { revision: stored.revision }) },
      });
      // D35: committing and saving are one act — the shell runs what was written.
      dispatch({ type: "apply", applied: stored.brief });
      setRunBrief(stored.brief);
      purgeDraftFromStorage(state);
      await loadBriefs();
      // D37: the URL is the source of truth for which brief is open. A first save
      // turned "new" into a named brief, so the route must stop calling it new —
      // otherwise a reload would blank the brief that was just saved. (A save of a
      // file-backed brief is already at its own route; nothing to move.)
      if (state.source.kind === "new") {
        // H5: carry the step across the segment change this navigation causes.
        stashStep(steps[stepIndex] as string);
        router.replace(`/brief/${stored.brief.id}`);
      }
      return stored.brief;
    } catch (error) {
      // A 409 carries the store's fresh revision (API E1.0). Adopt it — through the
      // entry-only `save`, so the draft is untouched — and say what happened: the
      // retry that overwrites the other write is the user's decision, never an
      // automatic re-send, because the guard exists to make that write visible.
      const conflictRevision =
        isBriefsApiError(error) && error.status === 409 ? error.revision : undefined;
      if (
        conflictRevision !== undefined &&
        state.source.kind === "file" &&
        state.source.savedSnapshot !== null
      ) {
        dispatch({
          type: "save",
          saved: state.source.savedSnapshot,
          entry: { file: state.source.file, revision: conflictRevision },
        });
        setPersistError(messages.statusSaveConflict);
      } else {
        setPersistError(unknownErrorMessage(error, "Save failed"));
      }
      return null;
    } finally {
      setSaving(false);
    }
  };

  /**
   * D37 — the copy is adopted once, for both Save-as attempts (the first, and the
   * overwrite retry): a copy that took the id this route already names is loaded
   * in place — the SERVER's stored brief, whose asset paths were rewritten during
   * the copy and whose revision is the guard for the next save (an absent revision
   * leaves the guard untouched, the `save` action's rule) — and any other copy is
   * adopted by navigating to it, the route driving the load. The listing is
   * refreshed first, so the route's load finds the copy the moment the URL changes.
   * H5: Save as… also moves the route out from under the wizard, so the step is
   * stashed across the segment change.
   */
  const adoptSavedCopy = async (created: BriefEntry) => {
    purgeDraftFromStorage(state);
    if (created.brief.id === routeId) {
      dispatch({ type: "load", brief: created.brief, entry: { file: created.file, revision: created.revision } });
      setRunBrief(created.brief);
      setSaveAsId(null);
      return;
    }
    await loadBriefs();
    setSaveAsId(null);
    stashStep(steps[stepIndex] as string);
    router.replace(`/brief/${created.brief.id}`);
  };

  const handleSaveAs = async (rawId: string) => {
    if (refuseInvalid()) return;
    // B1: the dialog asks for an id while the user is thinking of a name — "Trail
    // Blaze 2026" once reached the server verbatim and came back a 400 nobody
    // explained. The field shows the rule as it is typed (below); this guard is the
    // backstop, so no unvalidated id reaches createBrief, and trimming happens here
    // where an invisible trailing space would otherwise be a server 400.
    const newId = rawId.trim();
    // D3: a live button answers. The field shows the rule as it is typed, so this
    // backstop usually finds the error already on screen — the press still has to
    // produce a response, so it hands focus back to the field.
    if (!SAFE_ID_PATTERN.test(newId)) {
      saveAsFieldRef.current?.focus();
      return;
    }
    setSaving(true);
    setPersistError(undefined);
    try {
      const brief = toBrief(state);
      const newBrief = { ...brief, id: newId };
      // D9: Save as… posts the *current draft* under the new id. A collision is
      // never written and never silently failed: the attempt ends here and the
      // overwrite dialog asks — whether the listing already knew the id, or the
      // API's 409 backstop caught a brief that appeared since it was fetched. (The
      // two `window.confirm` calls that used to gate this decision blocked the
      // thread and fought the app's own overlays; the kit's ConfirmDialog is the
      // house pattern.) The confirm retries with `{ replace: true }` — the
      // overwrite is a visible user decision, never an automatic re-send.
      if (briefs.some((entry) => entry.brief.id === newId)) {
        setPendingOverwrite(newId);
        return;
      }
      await adoptSavedCopy(await createBrief(newBrief));
    } catch (error) {
      if (!isBriefsApiError(error) || error.status !== 409) {
        setPersistError(unknownErrorMessage(error, "Save as failed"));
        return;
      }
      setPendingOverwrite(newId);
    } finally {
      setSaving(false);
    }
  };

  /**
   * D9 — the overwrite dialog's confirm. The retry is the user's own decision,
   * posting with `{ replace: true }`, and it adopts what the server stored exactly
   * as a first-attempt success does. A failed retry is answered the way any save
   * failure is: the error surfaces and the Save-as dialog stays open.
   */
  const retrySaveAsOverwrite = async (newId: string) => {
    if (overwriteInFlightRef.current) return;
    overwriteInFlightRef.current = true;
    setSaving(true);
    setPersistError(undefined);
    try {
      const brief = toBrief(state);
      await adoptSavedCopy(await createBrief({ ...brief, id: newId }, { replace: true }));
      // Same-id overwrite adopts in place (no navigation unmounts this editor), so
      // the dialog must clear here too. After adoptSavedCopy, while `saving` still
      // holds #163's gate — a dismissal window must not open mid-adoption.
      setPendingOverwrite(null);
    } catch (error) {
      setPersistError(unknownErrorMessage(error, "Save as failed"));
      setPendingOverwrite(null);
    } finally {
      overwriteInFlightRef.current = false;
      setSaving(false);
    }
  };

  /**
   * D35 — the run-without-write handoff. The freshest draft and save path ride refs
   * assigned every render, so the published handoff never goes stale while the user
   * keeps typing; the publish effect runs only on a differs-flip, so keystrokes never
   * churn every provider consumer. While the handoff stands, Generate asks the
   * three-way question (Header.tsx) — which replaces the guard's prompt for the whole
   * gesture, exactly one question either way.
   */
  const draftRunDraftRef = useRef<CampaignBrief | null>(null);
  const draftRunSaveRef = useRef<(() => Promise<CampaignBrief | null>) | undefined>(undefined);
  const draftRunBlockedRef = useRef<SectionId | null>(null);
  const draftRunRefuseRef = useRef<(() => boolean) | undefined>(undefined);
  draftRunDraftRef.current = draftDiffers ? draftBrief : null;
  // `blockedAt` keys validateState's buckets, and motion is one of them without being
  // a section — the refusal that reads this hands it to `reveal`, which folds motion
  // into its host. Publish the same mapped section, from the one mapping helper.
  draftRunBlockedRef.current = sectionForErrorBucket(blockedAt);
  draftRunRefuseRef.current = refuseInvalid;
  draftRunSaveRef.current = handleSave;
  useEffect(() => {
    if (!draftDiffers) {
      setDraftRun(null);
      return;
    }
    const handoff: DraftRunHandoff = {
      // Assigned every render: null exactly when `!draftDiffers`, which is when this
      // effect's other branch unpublishes the handoff — so while the handoff stands
      // the ref always holds the freshest draft. The cast only restates that
      // invariant for the type, the same way `saveAndRun`'s does below; the dialog
      // that reads it has no null branch to guard, because none exists.
      draftRef: draftRunDraftRef as Readonly<RefObject<CampaignBrief>>,
      // The editor's own verdict, on the same ref-and-refresh cadence as the draft:
      // a plain `blocked` would go stale the moment the user fixed the field it
      // named, because this effect only runs on a differs-flip.
      blockedRef: draftRunBlockedRef,
      // Assigned every render before any handoff can be published — the same cast
      // restating the invariant as the two refs above.
      refuseInvalid: () => (draftRunRefuseRef.current as () => boolean)(),
      // Assigned every render before any handoff can be published, so the cast only
      // restates the invariant — the call itself is always the freshest save.
      saveAndRun: () => (draftRunSaveRef.current as () => Promise<CampaignBrief | null>)(),
    };
    setDraftRun(handoff);
    return () => setDraftRun(null);
  }, [draftDiffers, setDraftRun]);

  // The Save-as field speaks the same rule as the briefId field (messages.briefId),
  // evaluated on the *trimmed* value so the verdict matches what Save would send.
  // Because the field asks for an id while the user is thinking of a name, the
  // slugified form of what was typed is offered as a click — shown, never applied
  // silently: an id that slugifies to nothing gets the refusal but no suggestion.
  const saveAsTrimmed = (saveAsId ?? "").trim();
  const saveAsInvalid =
    saveAsId !== null && saveAsTrimmed !== "" && !SAFE_ID_PATTERN.test(saveAsTrimmed);
  const saveAsSlug = slugify(saveAsId ?? "");

  // The errors behind one step. `errors` is keyed by every bucket once validation has
  // landed, but the first paint carries the empty put-state — so the bucket read still
  // falls back, and the guided first paint is what exercises that side. Motion folds
  // into its Output host. `ErrorStrip` deliberately does NOT: a strip chip is a
  // *scroll target*, and motion has its own (`#motion`, inside the Output panel), so
  // folding it there would land the user on the section instead of the field. The two
  // differ because they answer different questions — which sections are incomplete,
  // versus which buckets hold errors — not because they drifted.
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

  // W6.5 / W7.4 — the step's own errors, read once and answered twice: the footer's
  // sentence speaks the first of them, and the Next button's ready ring fires the
  // moment there are none.
  const stepErrors = stepSectionErrors(steps[stepIndex]);
  const stepValid = Object.keys(stepErrors).length === 0;
  // W7.4 — the ready ring counts the transitions of *this* step into complete, so
  // walking onto a step that was already finished is not an event, and neither is
  // any render of one that stays finished.
  const readyKey = useBecameTrue(stepValid, stepIndex);
  const stepFooterStatus =
    steps[stepIndex] === "review"
      ? messages.statusStepReview
      : stepValid
        ? messages.statusStepReady
        : Object.values(stepErrors)[0];

  // W7.1 — one segment per step, mapped off the same list the cursor walks. The
  // segbar takes the steps and their issue counts and knows nothing else, so the
  // six cannot disagree with the walk the footer moves.
  const segments = useMemo(
    () =>
      steps.map((step) => ({
        id: step,
        label: stepTitle(step),
        issues: Object.keys(stepSectionErrors(step)).length,
      })),
    [steps, stepSectionErrors],
  );

  // W7.3 — the two gestures, live only while there is a walk to move. Both end in
  // `go`, which clamps, so a swipe or an arrow past either end does nothing.
  useStepKeys({ enabled: presentation === "guided", onStep: (move) => go(stepIndex + move) });
  const swipe = useStepSwipe((move) => go(stepIndex + move));

  /**
   * D40 — the exit verb. Cancel leaves the editor for the grid, and the dirty guard
   * owns the one question: unsaved work is asked about, a clean editor just leaves.
   * (The old Discard took the user nowhere and never asked.)
   */
  const handleCancel = () => {
    guardedPush("/grid");
  };

  /**
   * D40 — the destructive verb, split out of Discard: Revert restores the last saved
   * state, and asks first, through the same replace confirmation every other replace
   * path uses. M5: the old Discard never confirmed — with `confirm` stubbed to return
   * false it still wiped the field, and the stub was never called.
   */
  const handleRevert = () => {
    requestReplace(() => {
      // L1 — purge only when the autosave effect will not rewrite the key. A
      // revert-to-saved is not pristine, so autosave refills the key with the reverted
      // (== saved) state in the same tick and a purge here would be a no-op fight;
      // a discarded NEW source mints a fresh temp id, so nothing overwrites the old
      // key and the purge is what keeps the discarded edits from lingering forever.
      if (state.source.kind === "new") purgeDraftFromStorage(state);
      dispatch({ type: "discard" });
      // L1.1: Revert resets touched/attempted
      setAttempted(false);
      setTouched(new Set());
      setTouchedSections(new Set());
    });
  };

  /**
   * A guided step card wraps the same sections the everything stack renders — one at a
   * time, so a step and "the section on that step" are the same thing. The switch is
   * over the closed six (exhaustive): the review step is handled by the caller, and the
   * mode-derived step list guarantees this only ever receives one of these six.
   */
  const renderStepSection = (section: SectionId) => {    switch (section) {
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
        return (
          <ProductsSection
            state={state}
            dispatch={dispatch}
            errors={sectionErrorsVisible("products")}
            onChooseFromBin={setAssetPickerKey}
          />
        );
      case "treatments":
        return <TreatmentsSection state={state} dispatch={dispatch} errors={sectionErrorsVisible("treatments")} />;
      case "layout":
        // The template's home (T7): the T5 type block and the step's own
        // compositor frame (D63) — the guided walk mounts the preview.
        return <LayoutSection state={state} dispatch={dispatch} errors={sectionErrorsVisible("layout")} preview />;
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

  // W8.1 — the review step renders the projection itself: the `draftBrief` memo
  // (declared beside the dirty-flag effect, where the D35 handoff also reads it) is
  // passed into `ReviewStep`, so its rows are generated from exactly what Save sends —
  // a field the projection drops loses its row too, and the review can never disagree
  // with the submission about what the brief contains.

  /** The review step is the one card that is not a section (W6.1). */
  const renderStepCard = (step: StepId): ReactNode =>
    step === "review" ? (
      <>
        <p className="text-[13px] text-text-primary">{messages.stepReviewIntro}</p>
        <ReviewStep brief={draftBrief} onEdit={reveal} />
      </>
    ) : (
      renderStepSection(step)
    );

  /**
   * D38 — the status surface is not review-only. The refusal a verb speaks is
   * produced and consumed in one React commit: `refuseInvalid` sets `attempted`
   * (which makes `StatusLine` emit the refusal) and bounces to the first failing
   * step in the same commit — so a surface that lived only in the Review-step bar
   * was unmounted by the very press that filled it, and the user landed elsewhere
   * with no message and no "Apply" on the page. It renders on every guided step,
   * so the refusal survives the jump and is readable where the user lands. The
   * verbs stay in the Review-step bar alone.
   */
  const statusSurface = (
    <>
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
    </>
  );

  /** The bar's verbs, once — the two placements below cannot grow divergent copies. */
  const actionVerbs = (
    <>
      {/*
        D35 — the verb model: `Cancel` exits to the grid, `Save` persists with one
        press, and "Apply to run" is retired (every persist path already commits the
        brief, so a third verb for the same idea was the confusion the user reported).
        A disclosure that hid Save behind Save was the same two-labels-one-verb
        problem in a new shape, so the primary is a plain button.
        D40 — Revert and the secondary `Save as…` live behind the overflow, which
        also keeps the developer affordances off the primary row. */}
      <Button variant="ghost" onClick={handleCancel}>
        {messages.editorCancel}
      </Button>
      <Button
        /* D3: never a dead primary button — pressing an invalid brief sets
           `attempted`, reveals every error and speaks the refusal. */
        disabled={saving}
        isLoading={saving}
        onClick={() => void handleSave()}
      >
        {messages.editorSave}
      </Button>
      {/* D3: the bar's primary row is the status sentence and the two verbs.
          Save as…, developer affordances and Revert live behind the overflow so
          the sentence has room. */}
      <OverflowMenu
        label="More actions"
        items={[
          { label: messages.editorSaveAs, onSelect: () => setSaveAsId("") },
          { label: messages.editorRevert, onSelect: handleRevert },
        ]}
      />
    </>
  );

  /**
   * W8.2 — the action bar, one component with two placements: on the Review step in
   * Guided (the last look) and at the foot in Everything. Guided's Review placement
   * takes the verbs ONLY (D38): the status surface is already mounted on every guided
   * step, and a second one in the bar would read the refusal twice. Everything's foot
   * keeps the surface in the bar — it has no per-step mount.
   */
  const actionBar = (withStatus: boolean) => (
    <FloatingBar data-testid="action-bar">
      <div className="flex items-center gap-3 w-full">
        {withStatus ? statusSurface : null}
        {actionVerbs}
      </div>
    </FloatingBar>
  );

  // M3 — the route's id names no brief. The empty state answers where the user
  // landed, naming the id the URL carried (that is the fact being reported) and
  // giving the two ways out. No draft is created, nothing is released in the shell,
  // and nothing is published into the sidebar: this page is not an editor.
  if (unknownId !== null) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 pb-24 sm:p-8">
        <div role="alert" className="rounded-xl border border-border bg-surface p-6">
          <p className="text-[13px] text-text-primary">{messages.briefNotFound(unknownId)}</p>
          <div className="mt-4 flex gap-4 text-[13px] font-medium text-brand-primary">
            <Link href="/grid" className="underline hover:text-text-emphasis">
              {messages.briefNotFoundGrid}
            </Link>
            <Link href="/brief/new" className="underline hover:text-text-emphasis">
              {messages.briefNotFoundNew}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    // No h-full / inner overflow: like every other view, this one flows and the
    // shell's main container is the scroller. The action bar and the preview rail
    // stay put with `sticky`, which is scoped to that container — never the viewport.
    <div className="flex flex-col">
      {/* §6 question 1 — the row is the query container the rail's visibility reads,
          so the rail's own width can never lie to a viewport breakpoint. */}
      <div className="flex items-start [container-type:inline-size]">
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
              // Always visible. It is the only control that returns to Guided, and the
              // choice persists — hiding it in Everything made Guided unreachable for
              // good, including across a reload. jsdom applies no CSS, so the suite
              // could still find the button and the tests passed regardless.
              className="flex shrink-0 items-center gap-1"
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
            <div className="space-y-4">
              {/* W7.1 — the walk, above the sticky step head: the segbar scrolls away
                  with the page while the head stays, and the two never fight for the
                  same pixel. */}
              <SegBar segments={segments} index={stepIndex} maxVisited={maxVisited} onSelect={go} />
              <div className="space-y-8">
                <StepHeader
                  step={stepIndex + 1}
                  total={steps.length}
                  title={stepTitle(steps[stepIndex])}
                  subtitle={STEP_SUBTITLES[steps[stepIndex]]}
                  state={state}
                  headingRef={stepHeadingRef}
                />
                {/* W7.2 — the two cards of a step change. The arriving one is keyed on
                    the step, because a CSS animation only replays on a fresh node;
                    the leaving one is out of flow for the same breath, so the pair
                    slide past each other instead of reflowing down the column. */}
                <div className="relative" data-testid="step-card" {...swipe}>
                  {exiting ? (
                    <div
                      key={`exit-${exiting.index}`}
                      // Inert as well as hidden: an `aria-hidden` box full of live
                      // controls is a trap, and this one has a whole section's worth
                      // of them for as long as it is on screen. `pointer-events-none`
                      // is the same promise to an engine that has no `inert`.
                      aria-hidden="true"
                      inert
                      className={cn(
                        "pointer-events-none absolute inset-x-0 top-0",
                        exiting.direction === 1 ? "step-exit-l" : "step-exit-r",
                      )}
                    >
                      {renderStepCard(steps[exiting.index])}
                    </div>
                  ) : null}
                  <div key={stepIndex} className={direction === 1 ? "step-enter-r" : "step-enter-l"}>
                    {renderStepCard(steps[stepIndex])}
                  </div>
                </div>
                <StepFooter
                  statusText={stepFooterStatus}
                  onBack={stepIndex > 0 ? () => go(stepIndex - 1) : undefined}
                  onNext={steps[stepIndex] === "review" ? undefined : () => handleNext()}
                  // The last section step, not a named one: `output` is last in classic
                  // but randomized puts `policy` after it, so keying on the id promised
                  // a launch and delivered the Variation Policy step.
                  nextLabel={stepIndex === steps.length - 2 ? messages.stepNextReview : undefined}
                  nudgeKey={nudgeKey}
                  readyKey={readyKey}
                />
                {/* D38 — the surface stands on every guided step, Review included: a
                    refusal spoken from the Review bar names sections on steps the user
                    is about to be bounced to, and it must still be on screen there. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">{statusSurface}</div>
                {/* W8.2 — Guided placement: the verbs stand on the Review step. The
                    status surface above is the step's own, so the bar carries only
                    the verbs (D38) — one status line, not two. */}
                {steps[stepIndex] === "review" ? actionBar(false) : null}
              </div>
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
                  <ProductsSection
                    state={state}
                    dispatch={dispatch}
                    errors={sectionErrorsVisible("products")}
                    onChooseFromBin={setAssetPickerKey}
                  />
                </div>
               <div>
                 {state.mode === "brief" ? (
                   <TreatmentsSection state={state} dispatch={dispatch} errors={sectionErrorsVisible("treatments")} />
                 ) : null}
               </div>
               {/* The template view (T7): the type block, no frame — the Everything
                   stack has no composed preview surface by design (D43 keeps the
                   preview Guided-only), so the step-scoped frame stays a step's. */}
               <LayoutSection state={state} dispatch={dispatch} errors={sectionErrorsVisible("layout")} />
               <OutputSection
                 state={state}
                 dispatch={dispatch}
                 errors={{ ...sectionErrorsVisible("output"), ...sectionErrorsVisible("motion") }}
               />
            </div>
          )}

        </div>

        {/* D43/D44/D61 — the preview rail: one right-hand slot, a sibling of the main
            column — never inside `renderStepCard`, which renders two live copies during
            a step change and whose `transform` traps overlays (M7). `sticky top-0
            self-start` resolves against the shell's own scrollport; never `fixed`.
            Guided only, and suppressed on Review and on the Layout step — the figure
            owns Review and the Layout step carries its own frame (D63), so exactly
            one composed preview is on screen (D43). Visibility is the row's container
            query (§6 question 1): the rail shows when the row has room for it. */}
          {presentation === "guided" &&
          steps[stepIndex] !== "review" &&
          steps[stepIndex] !== "layout" &&
          railProps !== null ? (
          <aside
            role="complementary"
            aria-label={messages.previewLegend}
            className="sticky top-0 hidden max-h-screen w-64 shrink-0 self-start flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-4 [@container(min-width:56rem)]:flex"
          >
            {/* The segmented switcher (D61): an eye for the preview, code for the
                YAML view — exclusive, never side by side. The glyphs are decoration;
                the names are on the buttons. */}
            <div
              role="group"
              aria-label={messages.previewRailViews}
              className="flex shrink-0 items-center gap-1"
            >
              <button
                type="button"
                aria-pressed={railView === "preview"}
                aria-label={messages.previewRailPreviewView}
                onClick={() => chooseRailView("preview")}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  railView === "preview"
                    ? "bg-surface-2 text-text-emphasis"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-primary",
                )}
              >
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" className="size-4">
                  <path
                    d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  />
                  <circle cx="12" cy="12" r="2.75" fill="none" stroke="currentColor" strokeWidth={2} />
                </svg>
              </button>
              <button
                type="button"
                aria-pressed={railView === "yaml"}
                aria-label={messages.previewRailYamlView}
                onClick={() => chooseRailView("yaml")}
                className={cn(
                  "rounded-md p-1.5 transition-colors",
                  railView === "yaml"
                    ? "bg-surface-2 text-text-emphasis"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-primary",
                )}
              >
                <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" className="size-4">
                  <path
                    d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
            {railView === "preview" ? (
              <PreviewDock {...railProps} brief={draftBrief} />
            ) : (
              <pre className="overflow-auto text-[11px] text-text-primary">
                {/* Real YAML, because that is what the label promises and what the
                    save path writes — a JSON body under a `</>`-YAML name showed a
                    format the pipeline never reads (CodeRabbit, PR #174). */}
                {dump(draftBrief)}
              </pre>
            )}
          </aside>
        ) : null}
        </SectionModeContext.Provider>
      </div>

      {/* W8.2 — Everything placement: the bar at the foot, floating over the whole
          stack as it always has, surface and verbs together — there is no per-step
          mount to carry the surface here. */}
      {presentation === "everything" ? actionBar(true) : null}

       {/* Headline pool drawer */}
       <HeadlinePoolDrawer
         state={state}
         dispatch={dispatch}
         open={poolDrawerOpen}
         onClose={() => setPoolDrawerOpen(false)}
       />

       {/* M7 — the Asset Bin drawer, hoisted to the editor's root beside the headline
           pool drawer for the same reason: the guided step card's permanent transform
           makes it the containing block for `fixed` descendants, so the drawer's
           viewport-covering scrim is trapped inside the card if it mounts there.
           ProductsSection keeps the trigger; this owns the drawer and the selection. */}
       <AssetPickerDrawer
         briefId={state.briefId}
         open={assetPickerKey !== null}
         onClose={() => setAssetPickerKey(null)}
         selectedPath={state.products.find((p) => p.key === assetPickerKey)?.logoPath}
         onSelect={(asset) => {
           // The drawer renders only while a product opened it, so the key is set
           // by construction — the cast restates it, like the step-heading handoff.
           dispatch({
             type: "setProduct",
             key: assetPickerKey as number,
             patch: { logoPath: `assets/inputs/${state.briefId}/${asset.name}` },
           });
           setAssetPickerKey(null);
         }}
       />

       {/* D14 — the replace confirmation, the editor's own instance of the shell's
           "Unsaved edits" pattern (DESIGN.md §5): one prompt, a refusal changes
           nothing, and re-triggering never stacks a second question. Revert and the
           blank route's New brief both throw away unsaved work, so both park their
           action in `pendingReplace` and ask here. */}
       <ConfirmDialog
         open={pendingReplace !== null}
         message={messages.statusReplacePrompt}
         confirmLabel={messages.confirmDialogDiscard}
         onConfirm={() => {
           const action = pendingReplace;
           setPendingReplace(null);
           action?.();
         }}
         onClose={() => setPendingReplace(null)}
       />

       {/* D9 — the Save-as overwrite decision. The confirm is what sends
           `{ replace: true }`; the cancel clears the pending id and returns to the
           Save-as dialog. Escape and Cancel are held while the retry write is in
           flight (the #163 `saving` guard) — a dismissal would hand the user an
           editable page whose pending adoption is about to discard their edits. */}
       {pendingOverwrite !== null && (
         <ConfirmDialog
           open
           title={messages.saveAsOverwriteTitle}
           message={messages.saveAsOverwritePrompt(pendingOverwrite)}
           confirmLabel={messages.saveAsOverwriteConfirm}
           cancelLabel={messages.confirmCancel}
           onConfirm={() => void retrySaveAsOverwrite(pendingOverwrite)}
           onClose={() => {
             if (!saving) setPendingOverwrite(null);
           }}
         />
       )}

       {/* Save as dialog */}
      {saveAsId !== null && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-scrim/80 p-4 backdrop-blur-sm">
          <div
            ref={saveAsDialogRef}
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
              invalid={saveAsInvalid}
              onChange={(e) => setSaveAsId(e.target.value)}
              className="mb-4"
              ref={saveAsFieldRef}
              autoFocus
            />
            {saveAsInvalid ? (
              <>
                <p className="mb-2 text-[12px] text-error" role="alert">
                  {messages.briefId}
                </p>
                {saveAsSlug !== "" ? (
                  <button
                    type="button"
                    onClick={() => setSaveAsId(saveAsSlug)}
                    className="mb-4 block text-left text-[12px] text-text-primary underline hover:text-text-emphasis"
                  >
                    {messages.saveAsIdSuggestion(saveAsSlug)}
                  </button>
                ) : null}
              </>
            ) : null}
            <div className="flex gap-2">
              <Button onClick={() => handleSaveAs(saveAsId)} disabled={saving || !saveAsId}>
                Save
              </Button>
              {/* Held back only while the write is in flight, for the reason the
                  focus trap's `onClose` gives — and visibly, so a press that does
                  nothing is not the answer a user gets. */}
              <Button variant="ghost" disabled={saving} onClick={() => setSaveAsId(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
