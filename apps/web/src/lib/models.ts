/**
 * Curated image-model catalog for the header model selector. `id` is what the UI
 * sends as `?model=` to the pipeline; the backend infers the provider from it
 * (null/"auto" → default chain, "procedural", "imagen", or "<provider>/<model>" →
 * OpenRouter). Edit this list to expose more OpenRouter models.
 */
export interface ModelOption {
  /** null = Auto (the default Imagen → OpenRouter → procedural chain). */
  readonly id: string | null;
  readonly label: string;
  readonly provider: string;
}

export const MODELS: readonly ModelOption[] = [
  { id: null, label: "Auto", provider: "Imagen → fallback chain" },
  { id: "firefly", label: "Adobe Firefly", provider: "Adobe Firefly Services" },
  { id: "imagen", label: "Google Imagen", provider: "Google" },
  { id: "x-ai/grok-imagine-image-quality", label: "Grok Imagine", provider: "xAI · OpenRouter" },
  { id: "google/gemini-2.5-flash-image", label: "Nano Banana", provider: "Google · OpenRouter" },
  { id: "openai/gpt-5-image", label: "GPT Image", provider: "OpenAI · OpenRouter" },
  { id: "procedural", label: "Procedural (offline)", provider: "Local gradient" },
];

/** Human label for the currently-selected model id (defaults to Auto). */
export const labelFor = (id: string | null): string =>
  MODELS.find((m) => m.id === id)?.label ?? "Auto";
