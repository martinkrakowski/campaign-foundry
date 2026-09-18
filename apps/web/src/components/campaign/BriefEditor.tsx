"use client";

import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useLayoutEffect,
  type ReactNode,
  type RefObject,
} from "react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { Button, Input, OverflowMenu, ConfirmDialog, useDialogFocusTrap } from "@/components/ui";
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
  initialEditorState,
  toBrief,
  isDirtySinceSave,
  isDirtySinceApply,
  isPristine,
  valuesEqual,
  canonicalBrief,
  getDraftKey,
  saveDraftToStorage,
  loadDraftFromStorage,
  purgeDraftFromStorage,
  blankBrief,
  slugify,
  asCopyTimeline,
  timelineDurations,
} from "@/components/campaign/editor-state";
import { useEditorHistory, useHistoryKeys } from "@/components/campaign/editor-history";
import {
  validateState,
  validateWarnings,
  getTotalErrorCount,
  motionUnavailableReason,
  SAFE_ID_PATTERN,
  type FieldErrors,
} from "@/components/campaign/validate";
import {
  IdentitySection,
  CopySection,
  ProductsSection,
  TreatmentsSection,
  OutputSection,
  PolicySection,
  TemplateSection,
} from "@/components/campaign/sections";
import { StatusChip } from "@/components/campaign/StatusChip";
import { StatusLine } from "@/components/campaign/StatusLine";
import {
  ErrorStrip,
  MOTION_ERROR_KEY,
  MOTION_HOST_SECTION,
  sectionForErrorBucket,
} from "@/components/campaign/ErrorStrip";
import { ErrorPill } from "@/components/ui";
import { useEditorDirty, type DraftRunHandoff } from "@/lib/editor-dirty-context";
import { useCreateCampaign } from "@/lib/create-campaign-context";
import { takeSeed } from "@/lib/create-campaign";
import { FloatingBar } from "@/components/shell/FloatingBar";
import { SectionModeContext } from "@/components/campaign/SectionModeContext";
import { useEditorPanelPublisher } from "@/lib/editor-panels-context";
import { Accordion } from "@/components/shell/Accordion";
import { revealSection } from "@/lib/scroll-to-section";
import { cn } from "@/lib/cn";
import { BriefSelector } from "@/components/campaign/BriefSelector";
import { HeadlinePoolDrawer } from "@/components/campaign/HeadlinePoolDrawer";
import { AssetPickerDrawer } from "@/components/campaign/AssetPickerDrawer";
import { ModePanel } from "@/components/campaign/ModePanel";
import { SectionOutline } from "@/components/ui/section-outline";
import { EstimatePanel } from "@/components/campaign/EstimatePanel";
import { sectionOrder, LayoutSection, type SectionId } from "./sections";
import { PreviewDock, PreviewRailEmptyState, type PlayheadState } from "./PreviewDock";
import { previewDockProps, previewRailKey } from "./preview-props";
import { LayerStack } from "./LayerStack";
import { layerStackKey, layerStackProps } from "./layer-stack-props";
import { useViewportMinWidth, RAIL_VIEWPORT_MIN_PX } from "@/lib/use-viewport-min-width";
import { DEFAULT_DURATION_SEC } from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import { resolveTimeline } from "@campaignfoundry/CampaignOrchestration/copy-timeline";
import { TimelineTape, beatUnderFloor } from "@/components/campaign/TimelineTape";
import * as messages from "./messages";
import type { CampaignMode } from "@/components/campaign/editor-state";

/* ── The editor's one presentation (SG-D2) ────────────────────────────────── */

/**
 * SG1 — the six-step wizard is gone. `guided`, the step cursor, the segbar, the
 * step header/footer, the step-card transition and the `review` step were all
 * deleted with it, and `Presentation` collapsed from a union to nothing: there
 * is ONE editor now, the single scrolling column `everything` already rendered.
 *
 * D137 dissolves with it. `studio` was only ever going to be a third value beside
 * `guided`/`everything`, so with the wizard removed there is no presentation to add
 * a value to — the wireframe's right column (the rail, CC3) is the layout.
 *
 * The `cf:presentation` key is no longer read or written. Nothing migrates it: it
 * chose between two presentations and only one survives, so an old value in a
 * returning operator's `localStorage` simply stops meaning anything.
 */

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

/* ── The playhead (CC5) ───────────────────────────────────────────────────── */

/**
 * The editor's playhead: the ONE owner of the live and committed seconds.
 *
 * Before CC5 the pair was a `useState` inside `PreviewDock` (`PreviewDock.tsx:240`),
 * which made a second surface — the timeline tape — unable to draw the same second
 * without a second copy of it, and a second copy desyncs the preview (D146's risk,
 * the plan's §0 C1). So the state moves up here, where the rail's dock and the
 * tape are both in scope, and `PreviewDock` receives it (VE-D5: scrub is ephemeral
 * component state, never an editor action — no reducer is involved anywhere below).
 *
 * **Why this is its own component rather than two `useState`s in `BriefEditor`'s
 * body.** The live second moves on every pointermove. `BriefEditor` is the largest
 * component in the app, `renderStepCard` builds the whole step form inline, and NO
 * section is `memo`-wrapped — so a `setScrubSec` in `BriefEditor`'s own body would
 * re-render the entire editor tree per frame of a drag, re-opening the cost defect
 * CC2 closed, through a new component (the plan's §4 acceptance (b)).
 *
 * **RS2 changed how that is true, and made it structural.** This component used to
 * take the main column as `children` and rely on React's element-identity bailout
 * to skip it during a scrub. The rail now lives in the shell row, published through
 * `useEditorPanels`, so this component is mounted INSIDE the rail's own aside and
 * the editor's form is not in its subtree at all: a second that moves re-renders
 * this component and the surfaces it draws, and there is nothing else under it to
 * skip. `children` is gone with the reason for it. The property is unchanged and
 * still measured where it matters — `brief-editor.playhead.test.tsx` counts the
 * form's renders across a five-frame drag and expects zero.
 *
 * **Why the seconds moved in here rather than staying wrapped around the column.**
 * Publishing a playhead-dependent element through `setRail` on every frame would
 * write context state per pointermove, so every frame would re-render the shell's
 * columns and place a fresh rail — per frame of a drag, for a second that only the
 * rail draws. Keeping the state below the publish point means a scrub writes no
 * context at all. Nothing in the main column reads the playhead today, which is
 * what makes this possible.
 *
 * Every literal the plan's §5 makes load-bearing survives: the `useState` pair,
 * `onScrubLive` as a bare setter (already stable) and `handleScrubCommit` as a
 * `useCallback` with an empty dependency list, writing BOTH seconds so the thumb
 * does not jump back.
 *
 * TS2's section host (D146) draws the same second under the Copy form, which is in
 * `<main>` — a sibling of this subtree, not a descendant. So it needs a
 * subscription (the plan already said "its own slot or a subscription"); a second
 * `useState` pair would desync the preview, which is the risk D146 names.
 */
export function PlayheadHost({
  durationSec,
  rail,
}: {
  /** The previewed clip length. A change to it re-clamps both seconds. */
  durationSec: number;
  /** The surfaces that draw the playhead, re-invoked on every scrub. */
  rail: (playhead: PlayheadState) => ReactNode;
}): ReactNode {
  const [scrubSec, setScrubSec] = useState(0);
  const [committedSec, setCommittedSec] = useState(0);

  /**
   * A commit moves BOTH seconds. Writing only the committed one would let a
   * ±1 s nudge or a ruler click move the frame while the thumb stayed where the
   * finger left it. Empty dependency list: both setters are stable, so this
   * function is allocated once — an inline arrow here would hand the
   * `memo`-wrapped dock and tape a fresh prop on every keystroke and defeat the
   * memo boundary CC1/CC2 built (the plan's §5; review caught exactly this in an
   * earlier draft).
   */
  const handleScrubCommit = useCallback((sec: number) => {
    setScrubSec(sec);
    setCommittedSec(sec);
  }, []);

  // `Math.max(0, durationSec)` guards a zero/negative axis: the ceiling can never
  // be below the floor.
  const ceiling = Math.max(0, durationSec);

  /**
   * A shortened axis clamps the STORED seconds, not only the ones read below.
   *
   * Clamping on read alone leaves the two out of step, and the divergence is not
   * harmless: commit 9 on a 10 s clip, shorten to 5 (the surfaces correctly show
   * 5), then lengthen back to 10 — and the untouched 9 in state reappears. The
   * playhead jumps to a second the operator last chose two axis changes ago and
   * `usePreviewFrame` fetches that frame, with no gesture anywhere in between.
   * Scrubbing is user-driven (VE-D5); a second nobody asked for is not.
   *
   * The clamp on read STAYS as well. This effect runs after the render that first
   * sees the new duration, so for exactly one commit the raw state is still the
   * old second — and that is the render `PreviewFrame` would build a request from.
   * Belt and braces, in the order they fire.
   */
  useEffect(() => {
    setScrubSec((sec) => Math.min(sec, ceiling));
    setCommittedSec((sec) => Math.min(sec, ceiling));
  }, [ceiling]);

  /**
   * ONE object per distinct playhead, not one per render.
   *
   * `PreviewDock` is `memo`-wrapped and takes this whole object as a prop, so a
   * fresh literal here would fail its shallow compare on every render — and this
   * component re-renders whenever `BriefEditor` republishes the rail, which is
   * every keystroke. That silently re-opens the half of CC1/CC2's contract that is
   * about RE-RENDERS rather than fetches ("lets this bail on a re-render for a
   * keystroke the look does not change, exactly as it already skips a network
   * fetch for one"). The fetch-count proofs never saw it, because
   * `usePreviewFrame` has a content key of its own and does not care how often
   * its component re-renders; the tape never saw it either, because it is handed
   * primitives rather than this object. Caught by a render count on the dock.
   */
  const playhead = useMemo<PlayheadState>(
    () => ({
      durationSec,
      scrubSec: Math.min(Math.max(0, scrubSec), ceiling),
      committedSec: Math.min(Math.max(0, committedSec), ceiling),
      // A `useState` setter is already referentially stable — no wrapper needed.
      onScrubLive: setScrubSec,
      onScrubCommit: handleScrubCommit,
    }),
    [durationSec, ceiling, scrubSec, committedSec, handleScrubCommit],
  );

  return rail(playhead);
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
  const { guardedPush, guardedAction } = useGuardedNavigation();
  const { setDirty, setDraftRun } = useEditorDirty();
  const { openCreateDialog, seedVersion } = useCreateCampaign();
  const { setPanels, setTopPanels, setRail } = useEditorPanelPublisher();
  // VE1 — history lives in the hook, never in `EditorState` (R6): `state` is the
  // present draft, so persistence and the stored-draft diff see exactly what they
  // saw before, and `dispatch` is a drop-in for the reducer's. The keyboard
  // shortcut is wired once here (task 6).
  const history = useEditorHistory(initialEditorState());
  const { state, dispatch } = history;
  useHistoryKeys(history);
  const [briefs, setBriefs] = useState<BriefEntry[]>([]);
  const [briefsLoaded, setBriefsLoaded] = useState(false);
  // D83/F-A — a listing that failed is a different fact from one that came back
  // empty: recorded here so the route can tell "the store said nothing" from "we
  // could not ask the store". The console.error in loadBriefs stays (a failing
  // list is logged); this is the recorded state *as well as* the log.
  const [briefsFailed, setBriefsFailed] = useState(false);
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
    if (section)
      setTouchedSections((prev) => (prev.has(section) ? prev : new Set([...prev, section])));
  }, []);
  const [attempted, setAttempted] = useState(false);

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
    // D83/F-A: a listing that failed says nothing about which ids exist — an id is
    // unknown only when a listing that *succeeded* does not contain it. Leave the
    // editor's state alone: the failure state below answers instead, with a retry,
    // and a later successful listing re-runs this effect and decides then.
    if (briefsFailed) return;
    const match = briefs.find((entry) => entry.brief.id === routeId);
    // M3: an id the listing does not know is answered where the user landed — the
    // empty state below — never a silent new unsaved draft.
    if (!match) {
      setUnknownId(routeId);
      return;
    }
    setUnknownId(null);
    dispatch({
      type: "load",
      brief: match.brief,
      entry: { file: match.file, revision: match.revision },
    });
    // The file identity rides the load, so the canonical projection is what `apply`
    // snapshots — and committing the shell here (never before) is what makes
    // Generate run the brief the URL named.
    dispatch({ type: "apply" });
    setRunBrief(match.brief);
    // A loaded brief shows its real errors at once: they are the file's, not the
    // user's, and the user asked for this brief by opening the route.
    setAttempted(true);
  }, [routeId, routeLoadedId, briefs, briefsLoaded, briefsFailed, setRunBrief]);

  /**
   * D83/F-A — where a failed listing is allowed to speak: exactly where the
   * not-found alert would otherwise render (a named route whose brief has not
   * loaded). A failed refresh on a loaded editor — the window-focus refetch, the
   * listing handleSave issues after a successful write — changes nothing on
   * screen, and `/brief/new` never needs the listing at all.
   */
  const failedRouteId =
    briefsFailed && routeId !== undefined && routeLoadedId !== routeId ? routeId : null;

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

  // Derived from state on every render (X30): these three used to be
  // useState mirrors written by a `[state, briefs]` effect, which meant every
  // keystroke paid its own commit (dispatch's render) *plus* a second commit
  // for this effect's setState calls, on top of a third for the dirty-flag
  // effect below — three full re-renders of the whole "everything"-presentation
  // tree per interaction where one suffices. `validateState`/`validateWarnings`
  // are pure functions of `state` (and the id list), so deriving them with
  // `useMemo` folds that second commit into the first: still recomputed on every
  // state change, but during the render `dispatch` already scheduled, not after
  // it as a chained update. See .agents/manifests/x30.json and the work-count
  // test in brief-editor.test.tsx that pins the commit count this removes.
  const existingIds = useMemo(() => briefs.map((b) => b.brief.id), [briefs]);
  const errors = useMemo(() => validateState(state, existingIds), [state, existingIds]);
  const warnings = useMemo(() => validateWarnings(state), [state]);
  // Not a boolean: the section that blocks is what the refusal needs to scroll to, and
  // deriving it here keeps "is it blocked" and "where" from disagreeing. null = valid.
  const blockedAt = useMemo(() => {
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
    return (
      Object.keys(structural)
        .filter((bucket) => getTotalErrorCount({ [bucket]: structural[bucket] }) > 0)
        .sort((a, b) => walkIndex(a) - walkIndex(b))[0] ?? null
    );
  }, [state, existingIds]);

  // Publish dirty state (X32). `isPristine`/`isDirtySinceSave` are pure functions of
  // `state`, so most renders recompute the exact same boolean this effect already
  // published — but the effect's deps are `[state, setDirty]`, and `state` is a new
  // object on every keystroke, so without a guard it would call `setDirty` on every
  // single render regardless of whether the boolean actually changed. Worse: a bare
  // `return () => setDirty(false)` cleanup ran on every dep change too (not only
  // unmount), so an unrelated keystroke paid a real false→true round trip through the
  // sibling `EditorDirtyContext` even when the flag was already `true` on both sides —
  // two full commits of that context's subscribers for zero observable change. The ref
  // remembers the last value actually pushed, so an unchanged boolean is a no-op here;
  // the unmount-only clear moved to its own effect below (see .agents/manifests/x32.json
  // and the work-count test in brief-editor.test.tsx that pins the commit count this
  // removes). Cannot be a bare `useMemo`: the value lands in a sibling context's state,
  // and writing another component's state during render is not allowed.
  const lastPublishedDirtyRef = useRef<boolean | null>(null);
  useEffect(() => {
    // The flag answers "is there unsaved work?". `isDirtySinceSave` alone would count
    // every unnamed draft as dirty by definition — which would make the guard prompt
    // "unsaved changes" on a pristine form, e.g. when the user picks a brief from the
    // blank route. A pristine editor has nothing to lose, so it never prompts.
    const next = !isPristine(state) && isDirtySinceSave(state);
    if (lastPublishedDirtyRef.current !== next) {
      lastPublishedDirtyRef.current = next;
      setDirty(next);
    }
  }, [state, setDirty]);

  // The provider outlives this route, so clear the flag on unmount — otherwise every
  // later navigation in the shell keeps prompting about a route that is long gone.
  // Split from the effect above (X32): that effect's deps include `state`, so a bare
  // `return () => setDirty(false)` there ran this clear on every keystroke too, not
  // only when the route actually unmounts.
  useEffect(() => () => setDirty(false), []);

  // Auto-save, but only for a draft that has actually diverged from a pristine editor.
  // Writing unconditionally would recreate the key that Save and Discard just purged.
  // VE1 adds the return half: a draft that UNDO steps back to pristine holds nothing
  // to recover, and a stale copy would come back on reload with no history left to
  // undo it — so the key is purged. The flag is what distinguishes that RETURN from
  // the START: the first render is always pristine, and the recovery effect above may
  // still be waiting on the route's load before it reads storage. Purging there would
  // delete the draft the reload came for; only a draft that has diverged in THIS
  // session may purge.
  const draftDivergedRef = useRef(false);
  useEffect(() => {
    if (!isPristine(state)) {
      draftDivergedRef.current = true;
      saveDraftToStorage(state);
      return;
    }
    if (draftDivergedRef.current) purgeDraftFromStorage(state);
  }, [state]);

  // W1 — the create dialog's seed (D65/D66). The editor consumes it on mount on the
  // blank route AND while already mounted there: the same-URL push resets nothing
  // (F8), so an in-place create needs the watch, and the seed key is persisted
  // exactly so a create that navigated here is still found on mount. The read
  // happens in an effect, never a `useState` initializer — the server has no
  // localStorage, and a read during render would make the first client render
  // disagree with it (the trap `Disclosure` documents). The baton is spent by a
  // read: `takeSeed()` is `takeStashedStep`'s pattern.
  // Layout, not passive: a refused seed spends its companion step baton inside
  // `takeSeed`, and that spend must happen before the navigation hook's mount
  // effect applies a leftover `"copy"` from a previous build. A `useEffect` here
  // is declared after that hook and would lose the race.
  useLayoutEffect(() => {
    // A seed arriving while a named brief is open must never load a blank draft in
    // place — the gate is the route's own statement about what this editor is.
    if (!blank) return;
    const seed = takeSeed();
    if (!seed) return;
    // Never through `requestReplace`: the guard already asked before the dialog
    // opened (D67) and does not clear the dirty flag, so asking again here would
    // pop "Unsaved edits" a second time on a dirty blank route.
    purgeDraftFromStorage(state);
    dispatch({ type: "load", brief: blankBrief() });
    // `patch` actions — not a hand-built state — so slug derivation stays in the
    // reducer (F18), exactly as the Identity step's own controls dispatch. D108 —
    // the seed carries the name and the campaign type; region and audience are
    // the Identity step's answers, and no seed may half-answer them. The type's
    // preset (platforms, formats, mode) is resolved by the `applyPreset` action,
    // exactly once, here on arrival (D109) — the seed is spent by the `takeSeed`
    // read above, so no remount, load or presentation switch can re-apply it.
    dispatch({ type: "patch", patch: { campaignName: seed.name } });
    dispatch({ type: "applyPreset", campaignType: seed.type });
    // The reset createNew performed (L1.1): an in-place seed after a refused Save
    // would otherwise inherit `attempted` and paint Identity red on arrival.
    setAttempted(false);
    setTouched(new Set());
    setTouchedSections(new Set());
    // SG1 — D98's cursor move ("land on Identity, not Copy") is gone with the step
    // cursor. It is not a behaviour this lane dropped: Identity is the first
    // section of the one column, so a seeded draft arrives at the top of it by
    // construction, with nothing to move and nothing that can land one step past
    // two empty required fields.
  }, [seedVersion, blank]);

  // The projection, exactly once: `toBrief(state)` is what Save sends, and the D35
  // handoff, the rail's YAML view and `draftDiffers` all read this one object rather
  // than each projecting again.
  const draftBrief = useMemo(() => toBrief(state), [state]);
  // R7.2/D45 — the dock's props come from the one exported derivation, fed by the live
  // draft. Null (nothing to draw) means an empty state, never an invented creative
  // (D26/D142) — the house rule is `hasProduct`. SG1: no cursor is passed because
  // there is no longer one to pass — the rail's M2 step readout went with the walk.
  const rawRailProps = previewDockProps(state);
  // CC1/CC2 — value-keyed, not `[state]`: a keystroke that changes neither the
  // look, anything the frame's own fetch reads, nor the previewed creative's
  // OWN identity (`previewRailKey`, `preview-props.ts` — that file's comment
  // has the full reasoning, including the identity term Qodo's review added)
  // returns the SAME cached object below, letting the `memo`-wrapped
  // `PreviewDock` bail out of a re-render exactly as `usePreviewFrame`'s own
  // key already bails out of a re-fetch. `toBrief(state)` above still runs
  // every keystroke (for the YAML view, `draftDiffers`, Save, Review) — this
  // key is a SECOND, narrower fingerprint over the same object, an accepted
  // extra cost of the memo boundary, not a replacement for it.
  const previewKey = previewRailKey(rawRailProps, draftBrief, state.products[0]?.id ?? "");
  const railProps = useMemo(() => rawRailProps, [previewKey]);
  // The rail's own `brief` prop, stabilised on the SAME key — a look-preserving
  // keystroke feeds `PreviewDock` (and the fetch inside it) the identical
  // reference, never a fresh `toBrief` result the memo above could not see
  // through. The YAML view below reads the live `draftBrief` instead, on
  // purpose: memoising it here would go stale (D61).
  const previewBrief = useMemo(() => draftBrief, [previewKey]);
  // CC5 — the previewed clip length, derived ONCE and from the same brief object
  // the dock itself receives, so the range's `max`, the playhead's clamp and the
  // frame request can never disagree about how long the clip is. Duration is part
  // of `previewFetchKey`'s content fingerprint, so `previewBrief` moves whenever
  // the axis does.
  const previewDurationSec = previewBrief.variation?.axes?.duration?.[0] ?? DEFAULT_DURATION_SEC;
  /**
   * TS1 — the tape's projection of the copy timeline, memoised on the three
   * things it reads. The windows come from `resolveTimeline` — the compositor's
   * own function, the rule `ProportionBar` already lives by — so the tape never
   * divides a weight and the two surfaces cannot disagree about the same beat.
   *
   * The floor is evaluated at the SHORTEST duration the axis can draw, not at the
   * previewed one (`studio-editor.md` §4.2), and with the domain's own slack:
   * `3 × MIN_DWELL_SEC` is `3.5999999999999996`, so a strict comparison marks a
   * beat the validator accepts.
   */
  const shortestDurationSec = Math.min(...timelineDurations(state));
  const tapeBeats = useMemo(
    () =>
      resolveTimeline(asCopyTimeline(state.timeline), previewDurationSec).map((beat) => ({
        text: beat.text,
        startT: beat.startT,
        endT: beat.endT,
        underFloor: beatUnderFloor((beat.endT - beat.startT) * shortestDurationSec),
      })),
    [state.timeline, previewDurationSec, shortestDurationSec],
  );
  /** D139 — which beat the operator has picked out. Ephemeral, never a document field. */
  const [selectedBeatIndex, setSelectedBeatIndex] = useState<number | null>(null);
  /**
   * An edit to the sequence RETIRES the selection rather than re-pointing it.
   *
   * The selection is a raw array index, and the beats are a list the operator can
   * reorder, insert into and remove from. Carrying an index across that edit does
   * not keep the selection on the beat it was on — it silently moves it to
   * whichever beat now occupies that slot, which is the exact invariant
   * `CopyTimeline.vo.ts` names for the PERSISTED `keyBeat` ("the selected text
   * must not change because rows moved") and says a reducer must maintain. There
   * is no reducer for an ephemeral selection, so the honest answer is to drop it:
   * a cleared highlight is obviously nothing, a moved one looks like an answer.
   *
   * Keyed on the beats array's identity, so any edit to the sequence clears it.
   * A later lane that wants to SURVIVE an edit (SE1's inspector) needs per-beat
   * identity to do it correctly; an index cannot, and should not pretend to.
   */
  useEffect(() => {
    setSelectedBeatIndex(null);
  }, [state.timeline.beats]);
  /**
   * CC3 — the rail's layer stack, fed and memoised exactly as the preview is.
   *
   * `layerStackKey` is the layer-side twin of `previewKey`: a fingerprint of
   * everything `layerStackProps` reads (the creative type, each layer's id,
   * kind and enabled flag IN ORDER, the occlusion advisory). `previewKey`
   * cannot serve here — it fingerprints the previewed LOOK and carries no layer
   * at all, so switching a layer off would not move it — and `[state]` cannot
   * serve either, because that is the whole defect: the rail is a child of the
   * editor's single commit, so a keystroke in `targetAudience` would re-render
   * every layer row without it. A fresh object here defeats `LayerStack`'s
   * `memo` while every fetch-count assertion stays green, which is how #469
   * regressed; `brief-editor.layers.test.tsx` counts the re-render for that
   * reason rather than inferring it from the network.
   */
  const rawLayerStackProps = layerStackProps(state);
  const layerStackFingerprint = layerStackKey(state);
  const layerStack = useMemo(() => rawLayerStackProps, [layerStackFingerprint]);
  /**
   * D139 — which layer the operator has picked out. Ephemeral: local component
   * state, the same bucket as the scrub position (VE-D5), the tape's beat and
   * the timeline zoom (D147). Never a field of `EditorState`, never in the
   * brief, never in `localStorage` — a selection that reached the document
   * would dirty a loaded brief on a click that changed nothing.
   */
  /**
   * An ID, never an index — the opposite of `selectedBeatIndex` above, and for
   * a reason that reverses its conclusion. A beat has no identity but its slot,
   * so carrying an index across an edit silently re-points the selection at
   * whichever beat now occupies it and the honest answer is to retire it. A
   * layer HAS an identity: its id survives a reorder, so a selection keyed on
   * the id follows the layer the operator picked rather than the slot it was
   * standing in, instead of being retired by every edit to the list.
   *
   * It is retired by the two things that make it stop naming anything, and the
   * two are separate because they are different facts about the draft —
   * neither reset implies the other, and a fix that ships one of them is half
   * a fix that still hands CC4's sheet a layer nobody picked.
   */
  const [pickedLayerId, setPickedLayerId] = useState<string | null>(null);
  /**
   * (1) The layer is gone.
   *
   * Keyed on the layers array's identity, so any edit to the list re-checks —
   * and the check is what keeps a REORDER (a new array, same ids) from
   * clearing a pick that is still perfectly valid. A removal is the case that
   * bites: the id then names no row.
   *
   * The updater returns the SAME id when it still resolves, so React bails out
   * of the write and this costs nothing on a reorder or an unrelated edit.
   */
  useEffect(() => {
    setPickedLayerId((id) =>
      id !== null && !state.template.layers.some((layer) => layer.id === id) ? null : id,
    );
  }, [state.template.layers]);
  /**
   * (2) The document underneath changed.
   *
   * D139 puts the selection OUTSIDE `EditorState` on purpose, so it does not
   * travel with the brief — which is exactly why nothing in the reducer clears
   * it, and why loading another brief would otherwise inherit the previous
   * one's pick. (1) cannot cover this: the canonical templates share their
   * layer ids, so `accent` picked in one brief resolves in the next and the
   * stale highlight survives while naming a different layer entirely. The
   * clear is therefore unconditional on the identity of the brief on screen —
   * `loadedId` for a saved brief, `tempId` for a draft, the same pair
   * `previewIdentityKey` keys frame identity on.
   */
  const openBriefKey = state.source.kind === "file" ? state.source.loadedId : state.source.tempId;
  useEffect(() => {
    setPickedLayerId(null);
  }, [openBriefKey]);
  /** Stable across every render: a fresh arrow would defeat the `memo` above. */
  const pickLayer = useCallback((id: string) => setPickedLayerId(id), []);
  // CC2 — the JS-side mirror of the gate that hides the rail, now the shell's
  // own VIEWPORT breakpoint (RS2) rather than a container query on a row the
  // rail no longer lives in. The mirror itself does not retire with the query:
  // `hidden lg:flex` still hides without unmounting, so the rail would keep
  // fetching frames nobody can see without this.
  const isRailWideEnough = useViewportMinWidth(RAIL_VIEWPORT_MIN_PX);
  /**
   * D35 — whether Generate's default target (the shell's brief) and the screen
   * disagree. A pristine editor holds the blank template, not a draft anybody is
   * editing, so it never counts as differing — otherwise a freshly mounted editor
   * (or a reverted one) would offer to run an empty form over a perfectly good
   * committed brief.
   */
  const draftDiffers = useMemo(
    () => !isPristine(state) && !valuesEqual(draftBrief, canonicalBrief(runBrief)),
    [state, draftBrief, runBrief],
  );

  // Mount, window focus, the post-save refresh and the failure state's retry all
  // funnel through loadBriefs, and their answers can land out of order. Stamp each
  // call so a slow older answer cannot replace a newer one. A ref, not a `let`:
  // the capabilities effect's generation works only because it lives inside a
  // `useEffect(…, [])`, while this function is re-created every render.
  const briefsGeneration = useRef(0);

  const loadBriefs = async () => {
    const generation = ++briefsGeneration.current;
    try {
      const entries = await listBriefs();
      if (generation !== briefsGeneration.current) return;
      setBriefs(entries);
      setBriefsFailed(false);
    } catch (error) {
      // Symmetry with the `try` guard above. Unlike that one, this branch has NO
      // UI-observable pin and none was contrived for it: every ordering in which a stale
      // FAILURE lands is already answered by something that renders first — after the
      // route has loaded `routeLoadedId === routeId` nulls `failedRouteId`, and after an
      // empty success `unknownId` renders at the not-found branch before the failure one.
      // It is kept because a later navigation would make a stale failure observable, and
      // removing it would leave that to be rediscovered. Verified on PR #197 by mutation:
      // deleting this line alone turns no test red.
      if (generation !== briefsGeneration.current) return;
      console.error("Failed to load briefs:", error);
      // D83/F-A: record the failure as well as logging it — a failed read is
      // never presented as an empty result.
      setBriefsFailed(true);
    } finally {
      // Only the current generation may declare the listing settled. A stale answer that
      // returned above still reaches this block, and marking it loaded there would hand the
      // route effect an empty `briefs` with `briefsFailed` still false — which is the false
      // not-found this lane exists to remove, reintroduced by its own retry path. Found by
      // three reviewers on PR #197.
      if (generation === briefsGeneration.current) setBriefsLoaded(true);
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
        if (touched.has(key) || touchedSections.has(section) || touchedSections.has(host))
          filteredSection[key] = msg;
      }
      if (Object.keys(filteredSection).length > 0) filtered[section] = filteredSection;
    }
    return filtered;
  }, [errors, touched, touchedSections, attempted]);

  // L1.1: Touch field on blur
  const handleMainBlur = useCallback((e: React.FocusEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const field = target.closest("[data-field-key]") as HTMLElement | null;
    if (field) {
      // Every `data-field-key` in the tree comes from error-sections.ts, and the
      // coverage test proves that set matches what validateState emits — so a key
      // found here is known by construction.
      // The element matched `[data-field-key]`, so the attribute is present by
      // construction. X32: re-blurring an already-touched field (correcting an
      // earlier field after filling the rest of the draft, e.g.) used to call
      // `new Set(prev).add(key)` unconditionally — a Set add is idempotent in
      // *content*, but that line built a new object every time regardless, so an
      // already-touched key still produced a fresh `touched` reference. That
      // changes `visibleErrors` (below) to a fresh reference too, which republishes
      // the top panels for zero observable difference. `touchSectionFromEvent`
      // right below already had this exact guard; this brings the blur handler
      // in line with it.
      const key = field.getAttribute("data-field-key") as string;
      setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
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
  // or chip that wants to point at a section ends here.
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

  /**
   * SG1 — a reveal is now a scroll and nothing else.
   *
   * With the step cursor gone there is no step to change first: every section of
   * the brief is mounted in the one column, all the time, so the scroll can always
   * run synchronously. The whole deferred half of W6.2 goes with it — the
   * `pendingReveal` marker, the layout effect that spent it, and the step-heading
   * focus handoff it had to suppress.
   *
   * Motion has no section of its own; it validates inside its Output host, so the
   * two halves of a reveal point at DIFFERENT nodes: the scroll reaches the motion
   * panel (`#motion`, where the field the user has to fix is), and the focus
   * handoff goes to the host `<section>`, which is what `focusSection` can make
   * focusable. Every other bucket makes those the same node.
   *
   * The host is derived BEFORE the branch, not inside it: the mapping is a property
   * of the bucket, not of whether focus was asked for, and a motion reveal without
   * focus (every ErrorStrip chip) is what exercises it. The declared constants are
   * read rather than spelled again — the totality test asserts them, and a third
   * copy here would let the code and the test disagree silently, the exact drift
   * the vocabulary collapse exists to stop.
   */
  const reveal = useCallback(
    (section: string, focus = false) => {
      const host = section === MOTION_ERROR_KEY ? MOTION_HOST_SECTION : section;
      revealSection(section);
      if (focus) focusSection(host);
    },
    [focusSection],
  );

  /** The outline's rows crawl their section into view and hand it focus (W4.2). */
  const outlineActivate = useCallback((section: string) => reveal(section, true), [reveal]);

  // D4/U1: the mode chooser is the first decision a brief makes, so it is the first
  // thing the bar shows. Published like every other editor panel — the page keeps the
  // dispatch, the bar only places it — which also gives the mobile menu the chooser.
  // The Sections outline (D25) sits directly below the pair: below the mode, but
  // before the read-only brief, so mode stays the first decision (GB-D4).
  //
  // X32: this used to `return () => setTopPanels(null)` unconditionally, so every
  // dep change (which is every render — `visibleErrors` is a fresh object every time,
  // see its own comment) nulled the published panels and then immediately republished
  // them. JSX has no stable identity to bail out on, so both the null and the new JSX
  // were genuine transitions through `EditorPanelsContext` — a real two-commit round
  // trip nobody ever saw on screen, since the new content replaced the null within the
  // same effect flush. The M3/D83 gate already nulls explicitly when there is nothing
  // to publish; the only case that ever needed the cleanup was the route actually
  // unmounting, which is now its own effect below.
  useEffect(() => {
    // M3: while the route's id names no brief there is no editor to publish for —
    // the shell's panels would be controls mutating a draft nobody can see.
    // D83/F-A: the same silence while a failed listing stands in for a route the
    // editor could not load — this page is not an editor in that state either.
    if (unknownId !== null || failedRouteId !== null) {
      setTopPanels(null);
      return;
    }
    setTopPanels(
      <>
        <ModePanel
          mode={state.mode}
          onSetMode={(mode: CampaignMode) => dispatch({ type: "setMode", mode })}
          compact
          formatDropped={state.mode === "brief" && state.formats.includes("motion")}
        />
        <SectionOutline
          mode={state.mode}
          visibleErrors={visibleErrors}
          onActivate={outlineActivate}
        />
      </>,
    );
  }, [
    state.mode,
    state.formats,
    visibleErrors,
    setTopPanels,
    outlineActivate,
    unknownId,
    failedRouteId,
  ]);
  useEffect(() => () => setTopPanels(null), []);

  // Publish the sections that live in the left bar while this editor is mounted. The
  // page keeps the state, dispatch and validation and republishes on every change; the
  // bar only places them. The Estimate travels with it (D31): it was previously inside
  // PolicySection alone, so a Classic draft had no deliverables readout at all — now it
  // is published for both modes, randomized through the planner and classic derived.
  const policyErrors = Object.keys(sectionErrorsVisible("policy")).length;
  // X32: same fix as the topPanels effect above — the unconditional
  // `return () => setPanels(null)` forced a null round trip through
  // `EditorPanelsContext` on every state change (this effect's `state` dependency is
  // the whole editor state, so that was every keystroke and every click), even though
  // the new content overwrote the null in the same effect flush. The M3/D83 gate
  // still nulls explicitly when there is nothing to publish; only unmount needs the
  // cleanup now, and that moved to its own effect below.
  useEffect(() => {
    // The M3 gate, plus the failed-listing silence (D83/F-A): no editor, nothing
    // published.
    if (unknownId !== null || failedRouteId !== null) {
      setPanels(null);
      return;
    }
    setPanels(
      <>
        {state.mode === "variation" ? (
          // SG1 — `policy` is the one section the column has never rendered: in
          // `everything` it lived here in the sidebar, and the `presentation` term
          // on this gate is what kept it from doubling the Guided policy STEP. With
          // the step gone the gate is the mode alone, and the sidebar accordion is
          // the only Variation Policy surface there is — a real presentational loss
          // (it was a full-width step card in Guided) recorded rather than hidden.
          // The panel renders in the sidebar, outside this page's DOM subtree, so it
          // needs its own capture: a click on an axis card there is still "the user
          // has been to the policy section" (D1).
          <div onClickCapture={touchSectionFromEvent} data-section="policy">
            <Accordion
              title="Variation Policy"
              aside={policyErrors > 0 ? <ErrorPill count={policyErrors} /> : null}
            >
              <PolicySection
                state={state}
                dispatch={dispatch}
                errors={sectionErrorsVisible("policy")}
                compact
              />
            </Accordion>
          </div>
        ) : null}
        <Accordion title="Estimate">
          <EstimatePanel state={state} />
        </Accordion>
      </>,
    );
    // sectionErrors only reads what `errors` already covers.
  }, [state, errors, policyErrors, setPanels, touchSectionFromEvent, unknownId, failedRouteId]);
  useEffect(() => () => setPanels(null), []);

  /**
   * The preview rail's BODY — `PlayheadHost`'s own slot (CC5), published up to
   * the shell row where it wears `SidebarShell` (RS2). The container is no longer
   * written here: the aside, its width, its border and its `lg:` gate are the
   * shell's one definition, shared with the left sidebar. What is left is the
   * scrolling body, spelled the way the left sidebar spells its own.
   *
   * **What retired with the move, and why none of it was a tidy-up.** The old
   * container was `sticky top-0 max-h-screen self-start` three levels inside
   * `main`'s scroller — the best a box in there can do, and never browser-height,
   * because `h-full` in a scroller means "as tall as the scrolled content". It was
   * `w-64` with a `border-l` where the left column is `w-[320px]` with panel
   * chrome. And its gate was `[@container(min-width:56rem)]` against a container
   * of `viewport − 368px`, so it appeared at 1264px of viewport while the left
   * sidebar appeared at 1024px: that 240px band is why the rail was invisible on
   * the owner's screen for two days while every merge landed correctly, and it is
   * deleted here rather than re-numbered.
   *
   * It is a function rather than an element because it is the half of the row that
   * MUST re-render when a second moves — the dock's thumb and (for a motion draft)
   * the tape's diamond follow the live value.
   *
   * D43/D44/D61/D141 — the rail used to be gated. D141 already amended D43 ("the
   * dock mounts in Guided only and is suppressed on the Review step",
   * `r7-preview-panel.md:39`) down to "every presentation, every step except
   * Review and Layout", because those two carried a composed frame of their own
   * (`ReviewStep`, and `LayoutSection` with `preview`, D63). SG1 removes the rest
   * of the gate: that exclusion was only ever a STEP concept, and there is no step
   * cursor any more.
   *
   * What must survive the simplification is D43's COUNT invariant — exactly one
   * composed frame — and it does, for a reason and not by luck: Review is deleted,
   * and the column's `LayoutSection` is rendered WITHOUT `preview`, so the rail
   * holds the only one. Re-introducing either would break it silently, which is
   * why the proof is a count of MOUNTS: `isRailWideEnough` (CC2) is the JS mirror
   * of the shell's viewport gate and gates only the FETCH — the rail still mounts
   * below the breakpoint, so a resize above it pays no fresh debounce, and a count
   * of what is VISIBLE would read zero while one is mounted.
   *
   * **`useCallback`, and its dependency list is load-bearing.** This closure is
   * published through context from an effect, so a fresh identity per render would
   * write context on every render — one extra shell render per keystroke, for a
   * rail whose content did not change. It is no longer a LOOP: the editor reads
   * the setters from a context of their own (`useEditorPanelPublisher`, `:290`)
   * and subscribes to nothing it publishes into, which is what a mutation replay
   * forced (see the comment on `EditorPanelPublisherContext` — while the two
   * shared a context this list was the difference between a defeated `memo` and a
   * livelock).
   *
   * Every value the body reads is therefore named below; a missing one leaves the
   * rail showing a stale draft, which no render count can see — a stale subtree
   * re-renders LESS, not more. The react-hooks lint plugin is not wired into this
   * project's eslint config, so the list is maintained by hand, by
   * `rail-in-shell.test.tsx`'s live-YAML assertion, and by `rs.json`'s mutation
   * that drops one entry from it.
   */
  const railSlot = useCallback(
    (playhead: PlayheadState): ReactNode => (
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
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
          railProps !== null ? (
            // CC2 — below the breakpoint, `brief` is withheld: `usePreviewFrame`
            // (inside `PreviewDock` → `PreviewFrame`) treats an undefined brief
            // exactly like an unspecified look and never builds a request, so a
            // rail nobody can see never reaches the network.
            <>
              <PreviewDock
                {...railProps}
                brief={isRailWideEnough ? previewBrief : undefined}
                playhead={playhead}
                host="rail"
              />
              {/* TS1 — the time surface, under the creative it belongs to. It
                mounts ONLY for a moving draft: a still brief has no seconds to
                draw, and a tape over a static creative would invite a scrub
                that means nothing. `hasMotion` is the rail's own look, so the
                tape and the dock's range appear and disappear together. */}
              {railProps.motion !== undefined ? (
                <TimelineTape
                  durationSec={playhead.durationSec}
                  beats={tapeBeats}
                  shortestDurationSec={shortestDurationSec}
                  scrubSec={playhead.scrubSec}
                  committedSec={playhead.committedSec}
                  selectedBeatIndex={selectedBeatIndex}
                  onScrubLive={playhead.onScrubLive}
                  onScrubCommit={playhead.onScrubCommit}
                  onSelectBeat={setSelectedBeatIndex}
                  host="rail"
                />
              ) : null}
            </>
          ) : (
            // D142 — the empty state before the first product has an id: names
            // the missing field, never "add a product" (the Products section
            // already shows a stub) and never a fabricated placeholder creative.
            <PreviewRailEmptyState campaignName={state.campaignName} />
          )
        ) : (
          <pre className="overflow-auto text-[11px] text-text-primary">
            {/* Real YAML, because that is what the label promises and what the
              save path writes — a JSON body under a `</>`-YAML name showed a
              format the pipeline never reads (CodeRabbit, PR #174). Always the
              LIVE `draftBrief`, never the memoised `previewBrief`: this is the
              rail's read-only SECOND view (D61) and must never lag the preview's
              own memo boundary (CC1/CC2 mutation (c)). */}
            {dump(draftBrief)}
          </pre>
        )}
        {/* CC3 — the layers container under the creative, which is where the
          owner's diagram puts it. Outside the view switcher on purpose: the
          switcher is exclusive between the composed PREVIEW and the YAML
          projection (D61), and a list of controls is neither — hiding the
          only layer stack in the tree behind a read-only view would make it
          unreachable while that view is up. Outside the `railProps !== null`
          branch for the same kind of reason: the template is real whether or
          not the first product has an id yet (D142 is about the preview), and
          answering "no layers" because the preview has nothing to draw would
          be a failure dressed as an empty result. */}
        <LayerStack
          {...layerStack}
          dispatch={dispatch}
          selectedLayerId={pickedLayerId}
          onSelectLayer={pickLayer}
        />
      </div>
    ),
    [
      // The rail's own view state and its switcher.
      railView,
      chooseRailView,
      // The preview: memoised on the content fingerprint (CC1), plus the gate
      // that withholds `brief` while the column is CSS-hidden (CC2).
      railProps,
      previewBrief,
      isRailWideEnough,
      // The tape (TS1) and its ephemeral selection (D139).
      tapeBeats,
      shortestDurationSec,
      selectedBeatIndex,
      // The layer stack (CC3): props memoised on their own fingerprint.
      layerStack,
      dispatch,
      pickedLayerId,
      pickLayer,
      // The YAML view reads the LIVE draft, never the memoised preview brief
      // (D61, CC1 mutation (c)) — so it is a dependency and the rail is
      // republished on every keystroke, which is the point.
      draftBrief,
      // D142's empty state names the campaign.
      state.campaignName,
    ],
  );

  /**
   * RS2 — publish the preview rail into the shell's right-hand column, through the
   * same seam the left bar's panels already use. The shell places it and knows
   * nothing else about it: presence of this value is what reveals the column
   * (RS-D3), so the aside cannot exist as an empty 256px strip on a route that
   * happens to match while publishing nothing — which is the defect that shipped.
   *
   * The M3/D83 gate is the panels effect's, for the same reason: when the editor is
   * showing "no such brief" or the failed-listing silence there is no draft to
   * preview, and a rail beside that message would be a surface with nothing in it.
   *
   * `railSlot` is a `useCallback`, so this effect fires when the rail's content
   * changes and not once per render. The publisher does not subscribe to the slots
   * it writes (`useEditorPanelPublisher` is a context of its own), so a publish
   * cannot re-enter this component — which is what keeps an unmemoised value in
   * `railSlot`'s dependency list a defeated `memo` (caught by a render count)
   * rather than a publish loop with no fixed point. That distinction was measured,
   * not assumed: see the comment on `EditorPanelPublisherContext`.
   */
  useEffect(() => {
    if (unknownId !== null || failedRouteId !== null) {
      setRail(null);
      return;
    }
    setRail({
      label: messages.previewLegend,
      // `PlayheadHost` is mounted INSIDE the published subtree, not around the
      // editor's column: the seconds move on every pointermove, and publishing a
      // playhead-dependent element per frame would write context per frame.
      // Keeping the state below the publish point means a scrub writes none.
      content: <PlayheadHost durationSec={previewDurationSec} rail={railSlot} />,
    });
  }, [railSlot, previewDurationSec, setRail, unknownId, failedRouteId]);
  useEffect(() => () => setRail(null), []);

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

  /**
   * W1 (D66/D67): the create gesture opens the dialog — the guard asks first, and
   * the dialog opens on consent. The old blank-route in-place reset is the seed's
   * job now: the dialog's Create hands this editor a seed and the effect above
   * applies it in place, landed on Copy.
   */
  const createNew = () => {
    guardedAction(openCreateDialog);
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
        entry: {
          file: stored.file,
          ...(stored.revision === undefined ? {} : { revision: stored.revision }),
        },
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
        // SG1: H5's step baton is gone with the step cursor. It existed because a
        // first save moves `/brief/new` to `/brief/{id}` — different route
        // segments, so the page remounts and the cursor was rebuilt from scratch,
        // throwing the user back to step one with nothing said. A column has no
        // cursor to rebuild, so there is nothing to carry across the change.
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
   * SG1: H5's step stash went with the wizard — there is no cursor for the segment
   * change to reset.
   */
  const adoptSavedCopy = async (created: BriefEntry) => {
    purgeDraftFromStorage(state);
    if (created.brief.id === routeId) {
      dispatch({
        type: "load",
        brief: created.brief,
        entry: { file: created.file, revision: created.revision },
      });
      setRunBrief(created.brief);
      setSaveAsId(null);
      return;
    }
    await loadBriefs();
    setSaveAsId(null);
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
   * D38 — the status surface travels with the verbs. The refusal a verb speaks is
   * produced and consumed in one React commit: `refuseInvalid` sets `attempted`
   * (which makes `StatusLine` emit the refusal) and reveals the first failing
   * section in the same commit — so the surface has to be mounted where the press
   * happens, not on a card the press could unmount. SG1: with the wizard gone
   * there is no second, per-step mount of it and no Review-step bar to keep the
   * verbs in; the one action bar at the foot carries both, so the "one status
   * line, not two" rule holds by construction rather than by a flag.
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
        {getTotalErrorCount(visibleErrors) > 0 ? (
          <ErrorStrip errors={visibleErrors} onErrorClick={reveal} />
        ) : null}
      </div>
    </>
  );

  /** The bar's verbs. */
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
   * W8.2 — the action bar, at the foot of the column, surface and verbs together.
   * SG1: the `withStatus` parameter is gone with the Guided placement it existed
   * for — one bar, one status surface, and no way to mount the pair twice.
   */
  const actionBar = (
    <FloatingBar data-testid="action-bar">
      <div className="flex items-center gap-3 w-full">
        {statusSurface}
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
            <Link
              href="/brief/new"
              className="underline hover:text-text-emphasis"
              onClick={(e) => {
                // A modified or non-primary click is the browser's to handle — new tab, new
                // window, download. Only a plain activation is ours to route through the guard.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                // W1 (D66/D67): the door is the create dialog, not a direct
                // navigation — and the guard asks first. No editor is mounted here
                // (M3), so the guard is silent and the dialog opens at once.
                e.preventDefault();
                guardedAction(openCreateDialog);
              }}
            >
              {messages.briefNotFoundNew}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // D83/F-A — the listing failed, not the campaign. Same chrome as the not-found
  // state (`role="alert"`, no sidebar panels — the gates above), but the copy
  // names the real fact and the way out is the truth: the read failed, so retry
  // it here. Never "start a new brief" — that remedy invites a duplicate of a
  // campaign that may be fine. The in-page retry is the way out that works
  // without leaving the page: window focus re-runs the listing, but never fires
  // for a user sitting on this screen reading the last answer.
  if (failedRouteId !== null) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 pb-24 sm:p-8">
        <div role="alert" className="rounded-xl border border-border bg-surface p-6">
          <p className="text-[13px] text-text-primary">{messages.briefListFailed(failedRouteId)}</p>
          <div className="mt-4 flex items-center gap-4">
            <Button variant="secondary" onClick={() => void loadBriefs()}>
              {messages.briefListFailedRetry}
            </Button>
            <Link
              href="/grid"
              className="text-[13px] font-medium text-brand-primary underline hover:text-text-emphasis"
            >
              {messages.briefNotFoundGrid}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    // No h-full / inner overflow: like every other view, this one flows and the
    // shell's main container is the scroller. The action bar stays put with
    // `sticky`, which is scoped to that container — never the viewport.
    <div className="flex flex-col">
      {/* RS2 — the row that used to hold the main column AND the rail, with
          `[container-type:inline-size]` on it so the rail's own container query
          could read its width. The rail is a shell column now and the query is
          gone, so the container-type went with its only consumer; the row itself
          stays as the column's flex host. TS2's narrow host (D146) draws the tape
          under Copy, inside this column — it needs the seconds, not a query
          container, and its own gate has to be the shell's viewport breakpoint or
          the two hosts stop being complements of each other, which is the class of
          defect this lane exists to delete. */}
      <div className="flex items-start">
        <SectionModeContext.Provider value={state.mode}>
          {/* Main content */}
          <div
            className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-8 pb-24"
            onBlurCapture={handleMainBlur}
            onClickCapture={touchSectionFromEvent}
          >
            {/* SG1 — the header row: the brief selector and the draft's status
              chip. The presentation toggle stood on the right of it and is gone
              with `guided`; the chip is no longer conditional, because there is
              no longer a StepHeader anywhere else announcing the same status. */}
            <div className="flex items-center gap-4">
              <BriefSelector
                briefs={briefs}
                currentId={state.source.kind === "file" ? state.source.loadedId : undefined}
                onSelect={loadBrief}
                onCreateNew={createNew}
              />
              <StatusChip state={state} />
            </div>

            {/* SG1 — the sections, in the one scrolling column the editor now is.
              This is the `everything` stack unchanged: `identity`, `copy`,
              `products`, `treatments` (brief mode only), `template`, `layout` and
              `output`, each where it already was. `policy` is the one section that
              has never been here — it renders as the sidebar accordion published
              above, which is where `everything` always put it. */}
            <div className="space-y-8">
              <div>
                <IdentitySection
                  state={state}
                  dispatch={dispatch}
                  errors={sectionErrorsVisible("identity")}
                />
              </div>
              <div>
                <CopySection
                  state={state}
                  dispatch={dispatch}
                  errors={sectionErrorsVisible("copy")}
                  warnings={warnings.copy}
                  onOpenPool={() => setPoolDrawerOpen(true)}
                />
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
                  <TreatmentsSection
                    state={state}
                    dispatch={dispatch}
                    errors={sectionErrorsVisible("treatments")}
                  />
                ) : null}
              </div>
              {/* The layer list (L5): the offer is the boundary's own (D124). */}
              <TemplateSection
                state={state}
                dispatch={dispatch}
                errors={sectionErrorsVisible("template")}
              />
              {/* The template view (T7): the type block and NO frame. This is the
                  half of D43's one-composed-frame invariant that lives in the
                  column: the rail holds the only composed preview, so `preview`
                  must not be passed here. It is not a leftover of D43's original
                  "Guided-only" clause — D141 dropped that — the frame the Layout
                  STEP carried went with the step, and adding one back here would
                  put a second composed frame in the tree. */}
              <LayoutSection
                state={state}
                dispatch={dispatch}
                errors={sectionErrorsVisible("layout")}
              />
              <OutputSection
                state={state}
                dispatch={dispatch}
                errors={{
                  ...sectionErrorsVisible("output"),
                  ...sectionErrorsVisible("motion"),
                }}
              />
            </div>
          </div>
        </SectionModeContext.Provider>
      </div>

      {/* W8.2 — the bar at the foot, floating over the whole column, surface and
          verbs together. Unconditional since SG1: there is no other placement of
          it left to choose between. */}
      {actionBar}

      {/* Headline pool drawer */}
      <HeadlinePoolDrawer
        state={state}
        dispatch={dispatch}
        open={poolDrawerOpen}
        onClose={() => setPoolDrawerOpen(false)}
      />

      {/* M7 — the Asset Bin drawer, hoisted to the editor's root beside the headline
           pool drawer. The original reason was the guided step card's permanent
           transform, which made it the containing block for `fixed` descendants and
           trapped the drawer's viewport-covering scrim inside the card; the card is
           gone, and the root is still where a scrim belongs, so it stays here rather
           than moving back under a section that could acquire a transform of its own.
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
            <h3 id="save-as-title" className="mb-4 text-sm font-semibold text-text-emphasis">
              Save as...
            </h3>
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
