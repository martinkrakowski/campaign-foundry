"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Button,
  ChipGroup,
  DialogBody,
  DialogFoot,
  DialogHead,
  DialogShell,
  GuardBar,
  Input,
  JumpStrip,
  SectionBlock,
} from "@/components/ui";
import { ModePanel } from "@/components/campaign/ModePanel";
import { Field, REGION_OPTIONS } from "@/components/campaign/sections/IdentitySection";
import { stashStep } from "@/lib/use-step-navigation";
import { createCampaign } from "@/lib/create-campaign";
import { isBriefsApiError } from "@/lib/briefs-api";
import { useCreateCampaign } from "@/lib/create-campaign-context";
import { useGuardedNavigation } from "@/lib/use-guarded-navigation";
import { hasRecoverableDraft, slugify, type CampaignMode } from "@/components/campaign/editor-state";
import { modeDisplayName } from "@/components/campaign/display-names";
import { StartFromExistingPicker, type StartFromSource } from "@/components/shell/StartFromExistingPicker";
import * as messages from "@/components/campaign/messages";

/** The step Create lands on (D66) — the baton's payload, spent by the editor's mount. */
const COPY_STEP = "copy";

/**
 * The fields a refused create marks (D91): the closed set of answers that can be
 * missing. Mode cannot be — it has a default — and start-from cannot, so the
 * marks, the JumpStrip's chips and the sections they jump to are all keyed to
 * these three, never to free-form strings.
 */
type CreateMarkKey = "campaignName" | "targetRegion" | "targetAudience";

interface CreateMark {
  readonly key: CreateMarkKey;
  readonly message: string;
}

/** The JumpStrip chip's label for each mark — the field's own label, spelled once. */
const CREATE_MARK_LABELS: Record<CreateMarkKey, string> = {
  campaignName: messages.campaignNameLabel,
  targetRegion: messages.targetRegionLabel,
  targetAudience: messages.targetAudienceLabel,
};

/** The section each mark's chip jumps to: the name strip, or `01 · Targeting`. */
type CreateSectionKey = "identity" | "targeting";

const CREATE_MARK_SECTIONS: Record<CreateMarkKey, CreateSectionKey> = {
  campaignName: "identity",
  targetRegion: "targeting",
  targetAudience: "targeting",
};

/**
 * The create moment (W1): the Identity step in a dialog (D66), on the shared dialog
 * kit. It collects the five things the wizard's first step decides — name, region,
 * audience, start-from source and mode (D86) — and nothing else. The name stands
 * alone above the numbered sections; region and audience share `01 · Targeting`,
 * start-from is `02`, mode is `03`. Create is never disabled (DESIGN.md §5): the
 * press is how the user asks what is wrong, and the refusal answers in one
 * `role="status"` sentence — first missing field wins (D66) — while every missing
 * field is marked in place and one chip per mark jumps to its section (D91). The
 * dialog derives no id and shows no slug (D65) — the brief-id readout stays in
 * Identity.
 */
export function CreateCampaignDialog() {
  const { createDialogOpen, closeCreateDialog } = useCreateCampaign();
  const router = useRouter();
  const pathname = usePathname();
  // W3 — read only. The dialog never guards: the create gesture was already guarded
  // by the entry point that opened it (D67); `isDirty` scopes the F19 two-way below.
  const { isDirty } = useGuardedNavigation();
  const [name, setName] = useState("");
  const [targetRegion, setTargetRegion] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [mode, setMode] = useState<CampaignMode>("brief");
  // W2 (D71) — the chosen start-from source, `null` (a blank create) being both the
  // default and the resting state. The mode rides along for the readout only: the
  // copy inherits the source's mode, so the dialog's own choice is not sent.
  const [source, setSource] = useState<StartFromSource | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // D91 — every field a refused create found missing, not just the first: the
  // status line speaks one sentence, the marks and the footer's chips speak the
  // rest. Cleared wherever the refusal is (the next edit, a fresh press).
  const [marks, setMarks] = useState<readonly CreateMark[]>([]);
  const [creating, setCreating] = useState(false);
  const [resumePrompt, setResumePrompt] = useState(false);
  // W2(a) (D90) — the footer's third state: the inline discard guard. Raised by
  // any close gesture on a draft with work in it; taken down by Keep editing,
  // a second close gesture, the draft becoming empty, or spent by Discard and
  // close.
  const [guardOpen, setGuardOpen] = useState(false);
  const guardRef = useRef<HTMLDivElement>(null);
  // The control that raised the guard — focus returns there when it comes down,
  // provided the node is still connected; the name input is the stable fallback.
  const guardReturnFocusRef = useRef<HTMLElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // The sections a chip jumps to. Both always render while the dialog is open, so
  // a chip can only be clicked when both refs are attached.
  const identityRef = useRef<HTMLDivElement>(null);
  const targetingRef = useRef<HTMLDivElement>(null);
  const sectionRefs: Record<CreateSectionKey, RefObject<HTMLDivElement | null>> = {
    identity: identityRef,
    targeting: targetingRef,
  };

  /** Where a cleared answer takes its notice down: the marks ride with the refusal. */
  const clearRefusal = () => {
    setRefusal(null);
    setMarks([]);
  };

  /** The error a field shows in its own slot, when the refusal marked it. */
  const markFor = (key: CreateMarkKey): string | undefined =>
    marks.find((mark) => mark.key === key)?.message;

  /** A footer chip's jump: to the mark's section, calm under reduced motion (D28). */
  const jumpToSection = (key: string) => {
    const section = sectionRefs[CREATE_MARK_SECTIONS[key as CreateMarkKey]];
    // The strip is only clickable while the dialog is open, and both sections
    // render for the dialog's whole open life — the ref is attached.
    section.current!.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  };

  /** Keep editing: the guard comes down; the focus effect returns to the raiser. */
  const dismissGuard = () => setGuardOpen(false);

  /** A cancelled or completed create leaves nothing behind — the typed fields included. */
  const closeAndReset = () => {
    closeCreateDialog();
    setName("");
    setTargetRegion("");
    setTargetAudience("");
    setMode("brief");
    setSource(null);
    clearRefusal();
    setResumePrompt(false);
    setGuardOpen(false);
  };

  /**
   * D90 — the dialog's own notion of a draft with work in it: a name, a region,
   * an audience, or a chosen source. The mode toggle is deliberately absent: it
   * has a default the user may never have touched, so a pristine dialog whose
   * mode is untouched still closes on the first Cancel.
   */
  const draftHasWork =
    name.trim() !== "" ||
    targetRegion.trim() !== "" ||
    targetAudience.trim() !== "" ||
    source !== null;

  /**
   * D90 — every close gesture funnels here (Cancel, Escape, the scrim, the
   * head's close — `DialogShell` owns Escape, so the guard is consulted in the
   * close handler and the shell's own Escape path is untouched). An empty draft
   * closes exactly as it always did — a confirmation step on nothing would be
   * friction without a purpose. A draft with work asks first: the first ask
   * raises the guard, and while the guard shows the same gesture takes it down
   * — so a second Escape is Keep editing, never Discard, and no keystroke
   * sequence can destroy a filled-in form. Only the guard's Discard and close
   * button does that.
   */
  const requestClose = () => {
    if (!draftHasWork) {
      closeAndReset();
      return;
    }
    if (guardOpen) {
      dismissGuard();
      return;
    }
    guardReturnFocusRef.current = document.activeElement as HTMLElement | null;
    setGuardOpen(true);
  };

  // D90 — the guard is reachable by keyboard or it is not a guard: opening it
  // moves focus to its first control (its first answer), and taking it down
  // returns focus to the control that raised it — but only while that node is
  // still connected and enabled. The body stays interactive, so a conditionally
  // rendered raiser (the Other… input, a mode card) can unmount before Keep
  // editing, and focus() on a detached node is a silent no-op; the name input
  // is the stable fallback. An empty draft while the guard shows dismisses it
  // (there is nothing left to guard); the next run is the ordinary restore.
  // An effect, because the answer the button row is restored under — or the
  // guard replacing the row — only exists in the DOM after the commit; a full
  // close skips the restore (the shell's own trap hands focus back) and
  // clears the stale raiser.
  useEffect(() => {
    if (guardOpen && !draftHasWork) {
      setGuardOpen(false);
      return;
    }
    if (guardOpen) {
      guardRef.current?.querySelector("button")?.focus();
      return;
    }
    if (createDialogOpen && guardReturnFocusRef.current) {
      const raiser = guardReturnFocusRef.current;
      if (raiser.isConnected && !(raiser as HTMLButtonElement).disabled) {
        raiser.focus();
      } else {
        nameInputRef.current?.focus();
      }
    }
    guardReturnFocusRef.current = null;
  }, [guardOpen, createDialogOpen, draftHasWork]);

  const runCreate = async () => {
    setRefusal(null);
    setCreating(true);
    try {
      const result = await createCampaign({
        name,
        targetRegion,
        targetAudience,
        mode,
        source: source?.id,
      });
      // A blocked store is not a create: stay open and say so. Do not throw — the
      // typed answers must still be here for a retry. Dismiss the two-way first:
      // Start over calls this path while the overlay is up, and the status line
      // lives on the form underneath it. (The storage refusal is the blank path's
      // story alone — the source path rejects instead, into the catch below.)
      if (result === null) {
        setResumePrompt(false);
        setRefusal(messages.createCampaignBlocked);
        return;
      }
      // D66 — the landing branch belongs to the caller, not the editor. Already on
      // the blank route: the mounted editor's seed effect moves the cursor itself.
      // Anywhere else: the step baton crosses the navigation this push causes, and
      // the editor's mount effect spends it. Never both — the baton is spent by a
      // read, so an unspent one would move the next mount's cursor.
      //
      // W2: the baton is the blank create's landing branch only. A source create
      // publishes no seed (so no seed effect) and opens the copy itself.
      if (!source && pathname !== "/brief/new") stashStep(COPY_STEP);
      closeAndReset();
      router.push(result.route);
    } catch (err) {
      // W2 — the source path's refusals are the API's, not the storage's: the seam
      // lets the BriefsApiError reach this catch (a 409 collision, a 500, a dropped
      // connection) and never returns `null`, so the blank path's contract is not
      // overloaded. A refused create keeps the dialog open, answers in the status
      // line, and leaves the typed answers here for a retry.
      setResumePrompt(false);
      setRefusal(
        isBriefsApiError(err) && err.status === 409
          ? messages.createCampaignDuplicateConflict
          : messages.createCampaignDuplicateFailed,
      );
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = async () => {
    // The refusal set is name, region and audience — all three (D66): region is
    // required by `validateIdentity` and its chips start at "", so omitting it would
    // land the user on Copy with a hole in the very step this dialog is.
    //
    // D91 — two speakers, one set. `missing` is the FULL set in precedence order;
    // the status line speaks only its first entry (first-missing-wins, today's
    // exact strings — D66), while every entry marks its field in place and gets a
    // footer chip. Without the split the ladder would mark at most one field.
    //
    // W2 adds a second name refusal, source-only: the copy's own name is derived
    // from this one, and a name with no letters or numbers derives nothing — refused
    // here, BEFORE the request. This is a derivability check, not a derivation: no
    // slug is computed for display (D65); the seam derives the id itself.
    const missing: CreateMark[] = [];
    if (name.trim() === "") {
      missing.push({ key: "campaignName", message: messages.campaignNameRequired });
    } else if (source && slugify(name) === "") {
      missing.push({ key: "campaignName", message: messages.campaignNameNotSluggable });
    }
    if (targetRegion.trim() === "") {
      missing.push({ key: "targetRegion", message: messages.targetRegion });
    }
    if (targetAudience.trim() === "") {
      missing.push({ key: "targetAudience", message: messages.targetAudience });
    }
    if (missing.length > 0) {
      setMarks(missing);
      setRefusal(missing[0].message);
      return;
    }
    setMarks([]);
    // W3 (F19) — before the seed publishes, ask about the abandoned draft it would
    // overwrite. The scope term is the lane's heart, and both halves are mandatory:
    //
    // `isDirty && pathname === "/brief/new"` — only there do the guard's question and
    // this one concern the *same* draft. `setDirty` is driven by any mounted editor,
    // not just the blank one, so without the route term a stale `cf:draft:new` from an
    // earlier session plus a dirty editor on a named route would stay silent and the
    // seed would overwrite the blank draft unasked — F19 unfixed. On the blank route,
    // asking again after the guard's "Leave" would be the D67 double prompt.
    //
    // No capture-before-the-guard is needed: `guardedAction` never clears the flag and
    // no navigation has happened, so the value at press time is the value at gesture
    // start — and the gesture starts at four call sites this dialog does not own.
    //
    // W2 — source creates skip the two-way entirely: no seed is published, so the
    // abandoned draft is not at risk, and the prompt would lie — "Start over" would
    // duplicate the source and leave the draft untouched, while "Resume" would
    // silently discard the chosen source.
    if (!source && hasRecoverableDraft() && !(isDirty && pathname === "/brief/new")) {
      setResumePrompt(true);
      return;
    }
    await runCreate();
  };

  /** Resume: the draft stays on disk, no seed is published, no baton is stashed —
   *  the recovery effect restores the draft where the user left off. */
  const handleResume = () => {
    closeAndReset();
    router.push("/brief/new");
  };

  const cancelResumePrompt = () => setResumePrompt(false);

  return (
    <>
      <DialogShell
        open={createDialogOpen}
        onClose={requestClose}
        ariaLabel={messages.createCampaignTitle}
        className="max-w-[820px]"
      >
        <DialogHead
          title={messages.createCampaignTitle}
          description={messages.createCampaignDescription}
          onClose={requestClose}
        />
        <DialogBody className="space-y-6">
          {/* The identity strip: the name alone, above the numbered sections —
           *  no id, no slug, no regen control (D65). */}
          <div ref={identityRef} data-create-section="identity">
            <Field
              fieldKey="campaignName"
              label={messages.campaignNameLabel}
              error={markFor("campaignName")}
            >
              <Input
                ref={nameInputRef}
                aria-label={messages.campaignNameLabel}
                value={name}
                placeholder={messages.campaignNamePlaceholder}
                invalid={markFor("campaignName") !== undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  clearRefusal();
                }}
              />
            </Field>
          </div>
          <div ref={targetingRef} data-create-section="targeting">
            <SectionBlock
              numeral="01"
              title={messages.createSectionTargeting}
              hint={messages.createSectionTargetingHint}
            >
              <Field
                fieldKey="targetRegion"
                label={messages.targetRegionLabel}
                as="div"
                error={markFor("targetRegion")}
              >
                <ChipGroup
                  label={messages.targetRegionLabel}
                  otherInputLabel={messages.targetRegionOtherInputLabel}
                  options={REGION_OPTIONS}
                  value={targetRegion}
                  onChange={(value) => {
                    setTargetRegion(value);
                    clearRefusal();
                  }}
                  allowOther
                  otherLabel={messages.targetRegionOther}
                  otherPlaceholder={messages.targetRegionOtherPlaceholder}
                  invalid={markFor("targetRegion") !== undefined}
                />
              </Field>
              <Field
                fieldKey="targetAudience"
                label={messages.targetAudienceLabel}
                error={markFor("targetAudience")}
              >
                <Input
                  aria-label={messages.targetAudienceLabel}
                  value={targetAudience}
                  placeholder={messages.targetAudiencePlaceholder}
                  invalid={markFor("targetAudience") !== undefined}
                  onChange={(e) => {
                    setTargetAudience(e.target.value);
                    clearRefusal();
                  }}
                />
              </Field>
            </SectionBlock>
          </div>
          {/* W2 (D71) — the source list, in its own numbered section. Choosing is
           *  a selection, not a navigation, and the blank row is where the dialog
           *  rests. It precedes Mode deliberately: choosing a source replaces the
           *  mode control with the inherited readout, and this order keeps that
           *  change below the point of interaction, where the user is looking. */}
          <SectionBlock
            numeral="02"
            title={messages.createSectionStartFrom}
            hint={messages.createSectionStartFromHint}
          >
            <Field fieldKey="startFrom" label={messages.startFromExistingLabel} as="div">
              <StartFromExistingPicker
                selectedId={source?.id ?? null}
                onSelect={(next) => {
                  setSource(next);
                  clearRefusal();
                }}
              />
            </Field>
          </SectionBlock>
          {/* W2 — the mode field is a readout while a source is chosen: the copy
           *  inherits the source's mode (the route refuses a mode override, for a
           *  reason it documents), and a sentence can say so. Never a disabled
           *  control — DESIGN.md §5 lets only work in flight disable one; the raw
           *  mode goes through the display label at the call site, as validate.ts
           *  does. Deselecting the source restores the live toggle. */}
          <SectionBlock
            numeral="03"
            title={messages.createSectionMode}
            hint={messages.createSectionModeHint}
          >
            <Field fieldKey="createMode" label={messages.createModeLabel} as="div">
              {source ? (
                <p className="text-[13px] text-text-muted">
                  {messages.createModeInherited(modeDisplayName(source.mode))}
                </p>
              ) : (
                <ModePanel mode={mode} onSetMode={setMode} />
              )}
            </Field>
          </SectionBlock>
        </DialogBody>
        <DialogFoot>
          <div className="space-y-3">
            {/* D91 — one chip per marked field, above the one live region. The
             *  status line below stays first-missing-wins; the strip carries the
             *  rest of the set and jumps to the offending section. */}
            <JumpStrip
              items={marks.map((mark) => ({
                key: mark.key,
                label: CREATE_MARK_LABELS[mark.key],
                count: 1,
              }))}
              onJump={jumpToSection}
            />
            {refusal ? (
              <p role="status" className="text-[12px] text-error">
                {refusal}
              </p>
            ) : null}
            {/* D90 — the footer's third state. On a close ask with work in the
             *  draft the row is replaced in place by the guard: one overlay, one
             *  scrim, the form stays mounted, the answers survive. The detail
             *  names what is actually filled in — never a generic sentence. The
             *  button row stays mounted and the `[hidden]` attribute does the
             *  swapping: the row's own nodes survive the swap (so focus can
             *  return to Cancel or Create if either raised the guard), the
             *  hidden row is out of the trap's focusables and out of the
             *  accessibility tree, and a display:none class would be neither —
             *  happy-dom computes no stylesheet, so the attribute is the only
             *  honest hidden. The guard itself mounts only while it shows. */}
            <div hidden={guardOpen} className="flex justify-end gap-2">
              {/* D67: a cancelled create leaves nothing behind — the reset runs
               *  here too, now once the guard's Discard and close confirms it. */}
              <Button variant="ghost" onClick={requestClose}>
                {messages.confirmCancel}
              </Button>
              {/* D3: never a dead primary button — only the write in flight holds it. */}
              <Button disabled={creating} isLoading={creating} onClick={() => void handleCreate()}>
                {messages.createCampaignConfirm}
              </Button>
            </div>
            {guardOpen ? (
              <div ref={guardRef}>
                <GuardBar
                  title={messages.discardGuardTitle}
                  detail={messages.discardGuardDetail(
                    name.trim() !== "",
                    targetRegion.trim() !== "",
                    targetAudience.trim() !== "",
                    source !== null,
                  )}
                  actions={[
                    { label: messages.discardGuardKeepEditing, onAct: dismissGuard },
                    {
                      label: messages.discardGuardDiscardClose,
                      variant: "destructive",
                      onAct: closeAndReset,
                    },
                  ]}
                />
              </div>
            ) : null}
          </div>
        </DialogFoot>
      </DialogShell>
      {/* W3 (F19) — the two-way is the dialog's own question, not the navigation
       *  guard's, and it stacks the way ConfirmDialog does (z-80): the topmost
       *  overlay holds focus, so its Escape and scrim close only it (SHELL-39) and
       *  the form underneath keeps the typed answers. */}
      <DialogShell
        open={createDialogOpen && resumePrompt}
        onClose={cancelResumePrompt}
        ariaLabel={messages.resumeDraftTitle}
        containerClassName="z-[80]"
        className="max-w-md"
      >
        <DialogHead title={messages.resumeDraftTitle} onClose={cancelResumePrompt} />
        <DialogBody className="p-4">
          <p className="text-[13px] text-text-muted">{messages.resumeDraftQuestion}</p>
        </DialogBody>
        <DialogFoot className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={creating} onClick={cancelResumePrompt}>
            {messages.confirmCancel}
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={creating} onClick={handleResume}>
            {messages.resumeDraftResume}
          </Button>
          {/* The user's original intent, confirmed once the risk is named.
           *  Same in-flight hold as the form's Create: a second press would
           *  republish the seed, and under D64(b) mint a second campaign. */}
          <Button type="button" size="sm" disabled={creating} isLoading={creating} onClick={runCreate}>
            {messages.resumeDraftStartOver}
          </Button>
        </DialogFoot>
      </DialogShell>
    </>
  );
}

