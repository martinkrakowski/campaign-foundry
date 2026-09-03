"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button, ChipGroup, DialogBody, DialogFoot, DialogHead, DialogShell, Input } from "@/components/ui";
import { ModePanel } from "@/components/ui/mode-panel";
import { Field, REGION_OPTIONS } from "@/components/campaign/sections/IdentitySection";
import type { CampaignMode } from "@/components/campaign/editor-state";
import { stashStep } from "@/lib/use-step-navigation";
import { createCampaign } from "@/lib/create-campaign";
import { useCreateCampaign } from "@/lib/create-campaign-context";
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
  const [name, setName] = useState("");
  const [targetRegion, setTargetRegion] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [mode, setMode] = useState<CampaignMode>("brief");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  /** A cancelled or completed create leaves nothing behind — the typed fields included. */
  const closeAndReset = () => {
    closeCreateDialog();
    setName("");
    setTargetRegion("");
    setTargetAudience("");
    setMode("brief");
    setRefusal(null);
  };

  const handleCreate = async () => {
    // The refusal set is name, region and audience — all three (D66): region is
    // required by `validateIdentity` and its chips start at "", so omitting it would
    // land the user on Copy with a hole in the very step this dialog is. One
    // progressive sentence, first missing field wins; region and audience reuse the
    // Identity step's own strings, and the name's is this dialog's one new sentence.
    const missing =
      name.trim() === ""
        ? messages.campaignNameRequired
        : targetRegion.trim() === ""
          ? messages.targetRegion
          : targetAudience.trim() === ""
            ? messages.targetAudience
            : null;
    if (missing !== null) {
      setRefusal(missing);
      return;
    }
    setRefusal(null);
    setCreating(true);
    try {
      const result = await createCampaign({ name, targetRegion, targetAudience, mode });
      // D66 — the landing branch belongs to the caller, not the editor. Already on
      // the blank route: the mounted editor's seed effect moves the cursor itself.
      // Anywhere else: the step baton crosses the navigation this push causes, and
      // the editor's mount effect spends it. Never both — the baton is spent by a
      // read, so an unspent one would move the next mount's cursor.
      if (pathname !== "/brief/new") stashStep(COPY_STEP);
      closeAndReset();
      router.push(result.route);
    } finally {
      setCreating(false);
    }
  };

  return (
    <DialogShell open={createDialogOpen} onClose={closeAndReset} ariaLabel={messages.createCampaignTitle}>
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
        <Field fieldKey="createMode" label={messages.createModeLabel} as="div">
          <ModePanel mode={mode} onSetMode={setMode} />
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
  );
}
