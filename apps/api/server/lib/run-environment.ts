import { ALLOWED_FONT_FAMILIES } from "@campaignfoundry/CreativeGeneration";
import { projectRoot } from "@campaignfoundry/shared";
import { outputRoot } from "./config.js";
import { loadEnv } from "./env.js";
import type { TenantContext } from "./tenant.js";

/**
 * The composition root's view of the process environment (D167, PT-0b1).
 *
 * Everything below a route receives these values; nothing below it reads
 * `process.env`. This module, `config.ts` and `env.ts` are where the environment
 * is read, and a run captures its `RunEnvironment` when it is enqueued, so a job
 * keeps the location and credentials it started with (the #567 defect was a run
 * resolving `OUTPUT_DIR` again after its test had moved on).
 */

/** Provider credentials and model choices. Absent keys disable that provider. */
export interface ProviderSettings {
  readonly geminiKey?: string;
  readonly openRouterKey?: string;
  readonly fireflyClientId?: string;
  readonly fireflyClientSecret?: string;
  readonly imagenModel?: string;
  readonly openRouterImageModel?: string;
  readonly openRouterCopyModel?: string;
}

export interface RunEnvironment {
  readonly tenant: TenantContext;
  /** Where this tenant's runs write their output. */
  readonly outputRoot: string;
  /** The project root whose `assets/` tree confines brief-supplied asset reads. */
  readonly assetRoot: string;
  /** The validated headline font (D59). */
  readonly messageFont: string;
  readonly providers: ProviderSettings;
}

/**
 * The deployment headline font (D59), validated against the same allowlist the
 * brief parser applies to `style.fontFamily` (both name the bundled faces
 * `fonts.ts` registers). `MESSAGE_FONT` used to pass through unvalidated while
 * the renderer can see 312 system families — a determinism hole at deployment
 * scope. An invalid value falls back to Inter with a logged warning; it is
 * never passed through.
 */
export function messageFont(): string {
  loadEnv();
  const raw = process.env.MESSAGE_FONT;
  if (raw === undefined || raw === "") return "Inter";
  if ((ALLOWED_FONT_FAMILIES as readonly string[]).includes(raw)) return raw;
  console.warn(
    `[pipeline] MESSAGE_FONT "${raw}" is not a bundled font family (allowed: ${ALLOWED_FONT_FAMILIES.join(", ")}); falling back to "Inter".`,
  );
  return "Inter";
}

/** Read the provider settings. `.env` is loaded first, so no caller can race it. */
export function providerSettings(): ProviderSettings {
  loadEnv();
  const env = process.env;
  return {
    geminiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY,
    openRouterKey: env.OPENROUTER_API_KEY,
    fireflyClientId: env.FIREFLY_CLIENT_ID,
    fireflyClientSecret: env.FIREFLY_CLIENT_SECRET,
    imagenModel: env.IMAGEN_MODEL,
    openRouterImageModel: env.OPENROUTER_IMAGE_MODEL,
    openRouterCopyModel: env.OPENROUTER_COPY_MODEL,
  };
}

/**
 * Resolve a tenant's run environment. Today every tenant is `LOCAL_TENANT` and
 * resolves to the process's output root, so bytes land exactly where they did;
 * per-tenant roots arrive with the storage adapters (PT-3, PT-4).
 */
export function runEnvironment(tenant: TenantContext): RunEnvironment {
  loadEnv();
  return {
    tenant,
    outputRoot: outputRoot(),
    assetRoot: projectRoot(),
    messageFont: messageFont(),
    providers: providerSettings(),
  };
}
