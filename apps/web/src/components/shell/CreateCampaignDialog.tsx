"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button, ChipGroup, DialogBody, DialogFoot, DialogHead, DialogShell, Input } from "@/components/ui";
import { ModePanel } from "@/components/ui/mode-panel";
import { Field, REGION_OPTIONS } from "@/components/campaign/sections/IdentitySection";
import { stashStep } from "@/lib/use-step-navigation";
import { createCampaign } from "@/lib/create-campaign";
import { isBriefsApiError } from "@/lib/briefs-api";
import { useCreateCampaign } from "@/lib/create-campaign-context";
import { useGuardedNavigation } from "@/lib/use-guarded-navigation";
import { hasRecoverableDraft, slugify, type CampaignMode } from "@/components/campaign/editor-state";
import { StartFromExistingPicker, type StartFromSource } from "@/components/shell/StartFromExistingPicker";
import * as messages from "@/components/campaign/messages";

/** The step Create lands on (D66) — the baton's payload, spent by the editor's mount. */
const COPY_STEP = "copy";

/**
 * The create moment (W1): the Identity step in a dialog (D66), on the shared dialog
 * kit. It collects the four things the wizard's first step decides — name, region,
 * audience, mode — and nothing else. Create is never disabled (DESIGN.md §5): the
 * press is how the user asks what is wrong, and the refusal answers in one
 * `role="status"` sentence. The dialog derives no id and shows no slug (D65) — the
 * brief-id readout stays in Identity.
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
  const [creating, setCreating] = useState(false);
  const [resumePrompt, setResumePrompt] = useState(false);

  /** A cancelled or completed create leaves nothing behind — the typed fields included. */
  const closeAndReset = () => {
    closeCreateDialog();
    setName("");
    setTargetRegion("");
    setTargetAudience("");
    setMode("brief");
    setSource(null);
    setRefusal(null);
    setResumePrompt(false);
  };

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
    // land the user on Copy with a hole in the very step this dialog is. One
    // progressive sentence, first missing field wins; region and audience reuse the
    // Identity step's own strings, and the name's is this dialog's one new sentence.
    //
    // W2 adds a second name refusal, source-only: the copy's own name is derived
    // from this one, and a name with no letters or numbers derives nothing — refused
    // here, BEFORE the request. This is a derivability check, not a derivation: no
    // slug is computed for display (D65); the seam derives the id itself.
    const missing =
      name.trim() === ""
        ? messages.campaignNameRequired
        : source && slugify(name) === ""
          ? messages.campaignNameNotSluggable
          : targetRegion.trim() === ""
            ? messages.targetRegion
            : targetAudience.trim() === ""
              ? messages.targetAudience
              : null;
    if (missing !== null) {
      setRefusal(missing);
      return;
    }
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
        onClose={closeAndReset}
        ariaLabel={messages.createCampaignTitle}
      >
        <DialogHead
          title={messages.createCampaignTitle}
          description={messages.createCampaignDescription}
          onClose={closeAndReset}
        />
        <DialogBody className="space-y-4">
          <Field fieldKey="campaignName" label={messages.campaignNameLabel}>
            <Input
              aria-label={messages.campaignNameLabel}
              value={name}
              placeholder={messages.campaignNamePlaceholder}
              invalid={refusal === messages.campaignNameRequired}
              onChange={(e) => {
                setName(e.target.value);
                setRefusal(null);
              }}
            />
          </Field>
          <Field fieldKey="targetRegion" label={messages.targetRegionLabel} as="div">
            <ChipGroup
              label={messages.targetRegionLabel}
              otherInputLabel={messages.targetRegionOtherInputLabel}
              options={REGION_OPTIONS}
              value={targetRegion}
              onChange={(value) => {
                setTargetRegion(value);
                setRefusal(null);
              }}
              allowOther
              otherLabel={messages.targetRegionOther}
              otherPlaceholder={messages.targetRegionOtherPlaceholder}
              invalid={refusal === messages.targetRegion}
            />
          </Field>
          <Field fieldKey="targetAudience" label={messages.targetAudienceLabel}>
            <Input
              aria-label={messages.targetAudienceLabel}
              value={targetAudience}
              placeholder={messages.targetAudiencePlaceholder}
              invalid={refusal === messages.targetAudience}
              onChange={(e) => {
                setTargetAudience(e.target.value);
                setRefusal(null);
              }}
            />
          </Field>
          {/* W2 (D71) — the source list. Choosing is a selection, not a navigation,
           *  and the blank row is where the dialog rests. */}
          <Field fieldKey="startFrom" label={messages.startFromExistingLabel} as="div">
            <StartFromExistingPicker
              selectedId={source?.id ?? null}
              onSelect={(next) => {
                setSource(next);
                setRefusal(null);
              }}
            />
          </Field>
          {/* W2 — the mode field is a readout while a source is chosen: the copy
           *  inherits the source's mode (the route refuses a mode override, for a
           *  reason it documents), and a sentence can say so. Never a disabled
           *  control — DESIGN.md §5 lets only work in flight disable one; the raw
           *  mode goes through the display label at the call site, as validate.ts
           *  does. Deselecting the source restores the live toggle. */}
          <Field fieldKey="createMode" label={messages.createModeLabel} as="div">
            {source ? (
              <p className="text-[13px] text-text-muted">
                {messages.createModeInherited(source.mode === "variation" ? "Randomized" : "Classic")}
              </p>
            ) : (
              <ModePanel mode={mode} onSetMode={setMode} />
            )}
          </Field>
        </DialogBody>
        <DialogFoot>
          <div className="space-y-3">
            {refusal ? (
              <p role="status" className="text-[12px] text-error">
                {refusal}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              {/* D67: a cancelled create leaves nothing behind — the reset runs here too. */}
              <Button variant="ghost" onClick={closeAndReset}>
                {messages.confirmCancel}
              </Button>
              {/* D3: never a dead primary button — only the write in flight holds it. */}
              <Button disabled={creating} isLoading={creating} onClick={() => void handleCreate()}>
                {messages.createCampaignConfirm}
              </Button>
            </div>
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

