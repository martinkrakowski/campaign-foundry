"use client";

import type { CampaignBrief, Product } from "@campaignfoundry/CampaignOrchestration";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { API, useRun } from "@/lib/run-context";
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
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto p-8 pb-40">
      <div>
        <h2 className="text-xl font-bold text-white">Campaign Brief</h2>
        <p className="text-[13px] text-text-muted">Edit the brief the orchestrator runs against.</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
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
            <div className="grid grid-cols-2 gap-3">
              <LabeledInput label="ID" value={product.id} onChange={(v) => setProduct(i, { id: v })} />
              <LabeledInput
                label="Name"
                value={product.name}
                onChange={(v) => setProduct(i, { name: v })}
              />
            </div>
            <LabeledInput
              label="Primary Colour"
              value={product.primaryColor}
              onChange={(v) => setProduct(i, { primaryColor: v })}
            />
            <LogoField value={product.logoPath} onChange={(v) => setProduct(i, { logoPath: v })} />
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

const ACCEPTED_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Build the proxied preview URL for a repo-relative `assets/...` logo path. */
const logoSrc = (path: string): string => `${API}/assets/${path.replace(/^assets\//, "")}`;

/** Read a File as a base64 data URL (for upload + instant preview). */
const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });

/**
 * Logo field: a thumbnail preview, the editable repo-relative path, and an upload
 * button. Uploading sends the file to /assets/logo and sets the path to the stored
 * location; the path stays editable so existing `assets/...` references still work.
 */
function LogoField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setError(null);
    if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
      setError("Use a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError("Logo must be 2 MB or smaller.");
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await readAsDataUrl(file);
      const res = await fetch(`${API}/assets/logo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      const data = (await res.json()) as { path?: string; error?: string };
      if (!res.ok || !data.path) throw new Error(data.error ?? `Upload failed (HTTP ${res.status}).`);
      onChange(data.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <span className="mb-1.5 block text-[11px] text-text-muted">Logo</span>
      <div className="flex items-center gap-3">
        {value ? (
          // Plain <img>: an arbitrary user-supplied logo, not a known-size static asset.
          <img
            src={logoSrc(value)}
            alt="Logo preview"
            className="h-10 w-10 shrink-0 rounded-md border border-border bg-surface-2 object-contain p-1"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-[10px] text-text-muted">
            none
          </div>
        )}
        <Input
          value={value}
          placeholder="assets/inputs/logo.png"
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_LOGO_TYPES.join(",")}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? "Uploading…" : "Upload"}
        </Button>
      </div>
      {error && <p className="mt-1.5 text-[11px] text-error">{error}</p>}
    </div>
  );
}
