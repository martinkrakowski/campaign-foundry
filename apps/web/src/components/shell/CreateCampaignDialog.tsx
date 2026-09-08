"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_PRESETS,
  DEFAULT_CAMPAIGN_TYPE,
  type CampaignType,
} from "@campaignfoundry/CampaignOrchestration/campaign-types";
import {
  Button,
  DialogBody,
  DialogFoot,
  DialogHead,
  DialogShell,
  GuardBar,
  Input,
  OptionTile,
  PosterFrame,
  PosterStack,
  ScrubBar,
  type PosterVariant,
  type RatioOption,
} from "@/components/ui";
import { stashStep } from "@/lib/use-step-navigation";
import { createCampaign } from "@/lib/create-campaign";
import { useCreateCampaign } from "@/lib/create-campaign-context";
import { useGuardedNavigation } from "@/lib/use-guarded-navigation";
import { hasRecoverableDraft } from "@/components/campaign/editor-state";
import { formatDisplayName, modeDisplayName, platformDisplayName, typeDisplayName } from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";

/**
 * The step Create lands on (D98) — the baton's payload, spent by the editor's
 * mount. No longer Copy (D66): D66 sent Create past Identity because the dialog
 * answered Identity; under D97 it does not — region and audience are unanswered
 * here and both are required by `validateIdentity`, so landing on Copy would drop
 * the user one step past two empty required fields.
 */
const IDENTITY_STEP = "identity";

const STILL_FRAMES: readonly { readonly ratio: RatioOption; readonly variant: PosterVariant }[] = [
  { ratio: "1:1", variant: "pA" },
  { ratio: "16:9", variant: "pB" },
];
const MIXED_FRAMES: readonly { readonly ratio: RatioOption; readonly variant: PosterVariant }[] = [
  { ratio: "1:1", variant: "pA" },
  { ratio: "16:9", variant: "pB" },
  { ratio: "9:16", variant: "pC" },
];

/**
 * The type's picture (plan §2.2): PosterFrames at the still-capable ratios, or
 * PosterStack + ScrubBar when the preset is video-only. Wholly decorative — the
 * tile's accessible name is the raw type id. The display-ad tile is A4's union
 * at work: its frame is a CanvasSpec at a display size (D113), so the preview
 * is a 6:5 medium-rectangle, not a social ratio.
 */
function TypePreview({ type }: { type: CampaignType }): ReactNode {
  const { formats } = CAMPAIGN_TYPE_PRESETS[type];
  if (type === "display-ad") {
    return (
      <span className="flex items-end justify-center gap-1.5">
        <PosterFrame spec={{ size: "300x250" }} variant="pA" size={44} />
      </span>
    );
  }
  const hasStill = formats.includes("static");
  const hasVideo = formats.includes("motion");
  if (hasVideo && !hasStill) {
    return (
      <span className="flex w-full flex-col items-center gap-2">
        <PosterStack ratio="9:16" size={52} />
        <ScrubBar />
      </span>
    );
  }
  const frames = hasVideo ? MIXED_FRAMES : STILL_FRAMES;
  return (
    <span className="flex items-end justify-center gap-1.5">
      {frames.map((frame) => (
        <PosterFrame key={frame.ratio} ratio={frame.ratio} variant={frame.variant} size={44} />
      ))}
    </span>
  );
}

function typeTileBlurb(type: CampaignType): string {
  const preset = CAMPAIGN_TYPE_PRESETS[type];
  return messages.typeTileGives(
    preset.platforms.length,
    messages.joinList(preset.formats.map((format) => formatDisplayName(format))),
  );
}

/**
 * What assistive tech hears: `tag`/`blurb`/`meta` are aria-hidden, so the
 * display name, the gives line, the display placements (display-ad), and the
 * D110 sentence (short-video) go through `description` → `aria-describedby`.
 * Same formatters as the visible text.
 */
function typeTileDescription(type: CampaignType): string {
  const preset = CAMPAIGN_TYPE_PRESETS[type];
  const parts = [typeDisplayName(type), typeTileBlurb(type)];
  if (type === "short-video") {
    parts.push(messages.typeTileRunsAs(modeDisplayName("variation")));
  }
  if (type === "display-ad") {
    parts.push(messages.typeTilePlacements(messages.joinList(preset.platforms.map(platformDisplayName))));
  }
  return messages.joinList(parts);
}

/**
 * The create moment (T3): a name and a campaign type (D108), on the shared
 * dialog kit. Region, audience, the map, the start-from rail, the mode panel,
 * the numbered sections and the jump strip all left with S1/T3 — they already
 * live in Identity or the editor sidebar. Create is never disabled (DESIGN.md
 * §5): the press is how the user asks what is wrong, and the refusal answers
 * in one `role="status"` sentence. The dialog derives no id and shows no slug
 * (D65) — the brief-id readout stays in Identity.
 */
export function CreateCampaignDialog() {
  const { createDialogOpen, closeCreateDialog } = useCreateCampaign();
  const router = useRouter();
  const pathname = usePathname();
  // W3 — read only. The dialog never guards: the create gesture was already guarded
  // by the entry point that opened it (D67); `isDirty` scopes the F19 two-way below.
  const { isDirty } = useGuardedNavigation();
  const [name, setName] = useState("");
  const [type, setType] = useState<CampaignType>(DEFAULT_CAMPAIGN_TYPE);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [nameInvalid, setNameInvalid] = useState(false);
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

  /** Where a cleared answer takes its notice down. */
  const clearRefusal = () => {
    setRefusal(null);
    setNameInvalid(false);
  };

  /** Keep editing: the guard comes down; the focus effect returns to the raiser. */
  const dismissGuard = () => setGuardOpen(false);

  /** A cancelled or completed create leaves nothing behind — the typed fields included. */
  const closeAndReset = () => {
    closeCreateDialog();
    setName("");
    setType(DEFAULT_CAMPAIGN_TYPE);
    clearRefusal();
    setResumePrompt(false);
    setGuardOpen(false);
  };

  /**
   * D90 — the dialog's own notion of a draft with work in it: a typed name.
   * The type tiles are deliberately absent: they have a default the user may
   * never have touched, so a pristine dialog whose type is untouched still
   * closes on the first Cancel.
   */
  const draftHasWork = name.trim() !== "";

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
  // rendered raiser can unmount before Keep editing, and focus() on a detached
  // node is a silent no-op; the name input is the stable fallback. An empty
  // draft while the guard shows dismisses it (there is nothing left to guard);
  // the next run is the ordinary restore. An effect, because the answer the
  // button row is restored under — or the guard replacing the row — only exists
  // in the DOM after the commit; a full close skips the restore (the shell's
  // own trap hands focus back) and clears the stale raiser.
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
      const result = await createCampaign({ name, type });
      // A blocked store is not a create: stay open and say so. Do not throw — the
      // typed answers must still be here for a retry. Dismiss the two-way first:
      // Start over calls this path while the overlay is up, and the status line
      // lives on the form underneath it.
      if (result === null) {
        setResumePrompt(false);
        setRefusal(messages.createCampaignBlocked);
        return;
      }
      // D98 — the landing branch belongs to the caller, not the editor. Already on
      // the blank route: the mounted editor's seed effect moves the cursor itself.
      // Anywhere else: the step baton crosses the navigation this push causes, and
      // the editor's mount effect spends it. Never both — the baton is spent by a
      // read, so an unspent one would move the next mount's cursor.
      if (pathname !== "/brief/new") stashStep(IDENTITY_STEP);
      closeAndReset();
      router.push(result.route);
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = async () => {
    // The refusal ladder collapsed with the Identity fields: only the name can
    // be missing. Type has a default (D108).
    if (name.trim() === "") {
      setNameInvalid(true);
      setRefusal(messages.campaignNameRequired);
      return;
    }
    setNameInvalid(false);
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
    if (hasRecoverableDraft() && !(isDirty && pathname === "/brief/new")) {
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
        className="max-w-md"
      >
        <DialogHead
          title={messages.createCampaignTitle}
          description={messages.createCampaignLead}
          onClose={requestClose}
          className="relative [&>div:first-child]:w-full [&>div:first-child]:px-8 [&>div:first-child]:text-center"
        />
        <DialogBody className="space-y-5 px-4 py-4">
          {/* The name alone — no id, no slug, no regen control (D65). */}
          <label className="block">
            <span className="mb-1.5 block text-[11px] text-text-muted">{messages.campaignNameLabel}</span>
            <Input
              ref={nameInputRef}
              aria-label={messages.campaignNameLabel}
              value={name}
              placeholder={messages.campaignNamePlaceholder}
              invalid={nameInvalid}
              className="h-12 text-base"
              onChange={(e) => {
                setName(e.target.value);
                clearRefusal();
              }}
            />
            {nameInvalid ? (
              <span className="mt-1 block text-[11px] text-error">{messages.campaignNameRequired}</span>
            ) : null}
          </label>
          <div>
            <p className="mb-1.5 text-[11px] text-text-muted">{messages.createTypeLabel}</p>
            <div role="group" aria-label={messages.createTypeLabel} className="grid gap-2">
              {CAMPAIGN_TYPES.map((option) => {
                const preset = CAMPAIGN_TYPE_PRESETS[option];
                return (
                  <OptionTile
                    key={option}
                    value={option}
                    name={typeDisplayName(option)}
                    tag={modeDisplayName(preset.mode)}
                    blurb={typeTileBlurb(option)}
                    meta={
                      option === "short-video"
                        ? messages.typeTileRunsAs(modeDisplayName("variation"))
                        : undefined
                    }
                    description={typeTileDescription(option)}
                    selected={type === option}
                    onToggle={(value) => setType(value as CampaignType)}
                  >
                    <TypePreview type={option} />
                  </OptionTile>
                );
              })}
            </div>
          </div>
        </DialogBody>
        <DialogFoot>
          <div className="space-y-3">
            <p role="status" className="min-h-[1rem] text-[12px] text-error">
              {refusal ?? ""}
            </p>
            {/* D90 — the footer's third state. On a close ask with work in the
             *  draft the row is replaced in place by the guard: one overlay, one
             *  scrim, the form stays mounted, the answers survive. The button
             *  row stays mounted and the `[hidden]` attribute does the swapping:
             *  the row's own nodes survive the swap (so focus can return to
             *  Cancel or Create if either raised the guard), the hidden row is
             *  out of the trap's focusables and out of the accessibility tree,
             *  and a display:none class would be neither — happy-dom computes
             *  no stylesheet, so the attribute is the only honest hidden. The
             *  guard itself mounts only while it shows. */}
            <div hidden={guardOpen} className="flex flex-col gap-2">
              {/* D3: never a dead primary button — only the write in flight holds it. */}
              <Button
                className="w-full"
                disabled={creating}
                isLoading={creating}
                onClick={() => void handleCreate()}
              >
                {messages.createCampaignConfirm}
              </Button>
              {/* D67: a cancelled create leaves nothing behind — the reset runs
               *  here too, now once the guard's Discard and close confirms it. */}
              <button
                type="button"
                className="w-full py-1 text-center text-sm text-text-muted hover:text-text-primary"
                onClick={requestClose}
              >
                {messages.confirmCancel}
              </button>
            </div>
            {guardOpen ? (
              <div ref={guardRef}>
                <GuardBar
                  title={messages.discardGuardTitle}
                  detail={messages.discardGuardDetail(name.trim() !== "")}
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
