"use client";

import type { CampaignBrief, Product } from "@campaignfoundry/CampaignOrchestration";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useRun } from "@/lib/run-context";
import { Button, Input } from "@/components/ui";

type ProductDraft = { id: string; name: string; primaryColor: string; logoPath: string };

const toDraft = (p: Product): ProductDraft => ({
  id: p.id,
  name: p.name,
  primaryColor: p.primaryColor,
  logoPath: p.logoPath,
});

/** HITL brief authoring — edits the brief the orchestrator runs against. */
export default function BriefPage() {
  const { brief, setBrief } = useRun();
  const router = useRouter();

  const [form, setForm] = useState({
    id: brief.id,
    targetRegion: brief.targetRegion,
    targetAudience: brief.targetAudience,
    campaignMessage: brief.campaignMessage,
    localizedMessage: brief.localizedMessage ?? "",
    products: brief.products.map(toDraft),
  });

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

  const save = () => {
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

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto p-4 pb-12 sm:p-8">
      <div>
        <h2 className="text-xl font-bold text-white">Campaign Brief</h2>
        <p className="text-[13px] text-text-muted">Edit the brief the orchestrator runs against.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <LabeledInput label="Brief ID" value={form.id} onChange={(v) => setField("id", v)} />
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

      <div className="flex gap-3">
        <Button onClick={save}>Save brief</Button>
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] text-text-muted">{label}</span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
