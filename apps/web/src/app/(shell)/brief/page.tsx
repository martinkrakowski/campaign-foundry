"use client";

import type { CampaignBrief, Product } from "@campaignfoundry/CampaignOrchestration";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useRun } from "@/lib/run-context";
import { Button, Input } from "@/components/ui";
import { createBrief, isBriefsApiError, unknownErrorMessage } from "@/lib/briefs-api";

type ProductDraft = { id: string; name: string; primaryColor: string; logoPath: string };

// Mirrors the server's canonical SAFE_ID_PATTERN (CampaignOrchestration). The API is the
// authority and rejects an unsafe id; this just fails fast in the editor so a reviewer
// isn't surprised by a brief that runs but can't persist/reload by id. Keep in sync.
const BRIEF_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const toDraft = (p: Product): ProductDraft => ({
  id: p.id,
  name: p.name,
  primaryColor: p.primaryColor,
  logoPath: p.logoPath,
});

const formFromBrief = (source: CampaignBrief) => ({
  id: source.id,
  targetRegion: source.targetRegion,
  targetAudience: source.targetAudience,
  campaignMessage: source.campaignMessage,
  localizedMessage: source.localizedMessage ?? "",
  products: source.products.map(toDraft),
});

/** Merge editor drafts onto the loaded products so optional fields (inputAsset, …) survive. */
const mergeProducts = (originals: readonly Product[], drafts: readonly ProductDraft[]): Product[] =>
  drafts.map((draft, index) => {
    const original = originals.find((product) => product.id === draft.id) ?? originals[index];
    return original ? { ...original, ...draft } : draft;
  });

/** HITL brief authoring — edits the brief the orchestrator runs against. */
export default function BriefPage() {
  const { brief, setBrief } = useRun();
  const router = useRouter();

  const [form, setForm] = useState(() => formFromBrief(brief));
  const [savedFile, setSavedFile] = useState<string | undefined>();
  const [persistError, setPersistError] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveAsId, setSaveAsId] = useState<string | null>(null);
  const [pendingAsId, setPendingAsId] = useState<string | undefined>();

  useEffect(() => {
    setForm(formFromBrief(brief));
    setPersistError(undefined);
    setConflict(false);
    setSaveAsId(null);
    setPendingAsId(undefined);
    setSavedFile((file) => (file && file.startsWith(`${brief.id}.`) ? file : undefined));
  }, [brief.id]); // identity of the loaded brief (picker switch), not per-keystroke edits

  const draftStale = form.id !== brief.id;

  const setField = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const setProduct = (i: number, patch: Partial<ProductDraft>) =>
    setForm((f) => ({
      ...f,
      products: f.products.map((p, idx) => (idx === i ? { ...p, ...patch } : p)),
    }));

  const addProduct = () =>
    setForm((f) => ({
      ...f,
      products: [...f.products, { id: "", name: "", primaryColor: "#1473E6", logoPath: "" }],
    }));

  const removeProduct = (i: number) =>
    setForm((f) => ({ ...f, products: f.products.filter((_, idx) => idx !== i) }));

  const idValid = BRIEF_ID_PATTERN.test(form.id);

  const persistableBrief = (id: string): CampaignBrief => ({
    ...brief,
    id,
    targetRegion: form.targetRegion,
    targetAudience: form.targetAudience,
    campaignMessage: form.campaignMessage,
    localizedMessage: form.localizedMessage || undefined,
    products: mergeProducts(brief.products, form.products),
  });

  const save = () => {
    /* istanbul ignore next -- the Save button is disabled when the id is invalid; this is belt-and-suspenders */
    if (!idValid) return; // guard: the API would reject an unsafe id, and it can't persist/reload
    const next: CampaignBrief = {
      id: form.id,
      targetRegion: form.targetRegion,
      targetAudience: form.targetAudience,
      campaignMessage: form.campaignMessage,
      localizedMessage: form.localizedMessage || undefined,
      products: form.products,
    };
    setBrief(next);
    router.push("/grid");
  };

  const persist = async (opts: { replace?: boolean; asId?: string } = {}) => {
    const targetId = opts.asId ?? form.id;
    /* istanbul ignore next -- persist buttons are disabled when the current id is invalid */
    if (!opts.asId && !idValid) return;
    if (opts.asId !== undefined && !BRIEF_ID_PATTERN.test(opts.asId)) {
      setPersistError("New id must be a path-safe slug (lowercase letters, digits, hyphens; max 64).");
      return;
    }
    setSaving(true);
    setPersistError(undefined);
    setConflict(false);
    setPendingAsId(opts.asId);
    try {
      // Save-as always POSTs the in-memory editor (including unsaved edits) under the
      // new id, rather than duplicating a possibly stale on-disk file.
      const result = await createBrief(persistableBrief(targetId), { replace: opts.replace });
      setSavedFile(result.file);
      if (opts.asId) {
        setField("id", opts.asId);
        setBrief(result.brief);
        setSaveAsId(null);
      }
    } catch (error) {
      if (isBriefsApiError(error) && error.status === 409) {
        setConflict(true);
        setPersistError(error.message);
      } else {
        setPersistError(unknownErrorMessage(error, "Save failed"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto p-4 pb-12 sm:p-8">
      <div>
        <h2 className="text-xl font-bold text-white">Campaign Brief</h2>
        <p className="text-[13px] text-text-muted">Edit the brief the orchestrator runs against.</p>
        {savedFile ? (
          <p className="mt-1 font-mono text-[12px] text-text-muted">Saved to briefs/{savedFile}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <LabeledInput
          label="Brief ID"
          value={form.id}
          onChange={(v) => setField("id", v)}
          error={idValid ? undefined : "Lowercase letters, digits and hyphens only (max 64) — used as the reload key."}
        />
        <LabeledInput
          label="Target Region"
          value={form.targetRegion}
          onChange={(v) => setField("targetRegion", v)}
        />
      </div>

      <LabeledInput
        label="Target Audience"
        value={form.targetAudience}
        onChange={(v) => setField("targetAudience", v)}
      />
      <LabeledInput
        label="Campaign Message"
        value={form.campaignMessage}
        onChange={(v) => setField("campaignMessage", v)}
      />
      <LabeledInput
        label="Localized Message (optional)"
        value={form.localizedMessage}
        onChange={(v) => setField("localizedMessage", v)}
      />

      <div className="flex items-center justify-between">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Products ({form.products.length})
        </h3>
        <Button variant="secondary" size="sm" onClick={addProduct}>
          Add product
        </Button>
      </div>

      <div className="space-y-4">
        {form.products.map((product, i) => (
          <div key={i} className="space-y-3 rounded-lg border border-border bg-surface p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <LabeledInput label="ID" value={product.id} onChange={(v) => setProduct(i, { id: v })} />
              <LabeledInput
                label="Name"
                value={product.name}
                onChange={(v) => setProduct(i, { name: v })}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <LabeledInput
                label="Primary Colour"
                value={product.primaryColor}
                onChange={(v) => setProduct(i, { primaryColor: v })}
              />
              <LabeledInput
                label="Logo Path"
                value={product.logoPath}
                onChange={(v) => setProduct(i, { logoPath: v })}
              />
            </div>
            <Button variant="ghost" size="sm" onClick={() => removeProduct(i)}>
              Remove
            </Button>
          </div>
        ))}
      </div>

      {persistError ? <p className="text-[13px] text-error">{persistError}</p> : null}

      {saveAsId !== null ? (
        <div className="space-y-2 rounded-lg border border-border bg-surface p-4">
          <LabeledInput
            label="Save as new id"
            value={saveAsId}
            onChange={setSaveAsId}
            error={
              saveAsId.length > 0 && !BRIEF_ID_PATTERN.test(saveAsId)
                ? "Lowercase letters, digits and hyphens only (max 64)."
                : undefined
            }
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void persist({ asId: saveAsId })} disabled={saving}>
              Save copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSaveAsId(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button onClick={save} disabled={!idValid || draftStale}>
          Save brief
        </Button>
        <Button
          variant="secondary"
          onClick={() => void persist()}
          disabled={!idValid || saving || draftStale}
          isLoading={saving && pendingAsId === undefined}
        >
          Save to briefs/
        </Button>
        <Button variant="secondary" onClick={() => setSaveAsId("")} disabled={!idValid || saving || draftStale}>
          Save as…
        </Button>
        {conflict ? (
          <Button
            variant="secondary"
            onClick={() => void persist({ replace: true, asId: pendingAsId })}
            disabled={saving || draftStale}
          >
            Replace
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <div>
      <label className="block">
        <span className="mb-1.5 block text-[11px] text-text-muted">{label}</span>
        <Input value={value} onChange={(e) => onChange(e.target.value)} invalid={Boolean(error)} />
      </label>
      {error ? <span className="mt-1 block text-[11px] text-error">{error}</span> : null}
    </div>
  );
}
