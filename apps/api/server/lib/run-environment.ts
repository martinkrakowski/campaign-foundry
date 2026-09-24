import { join } from "node:path";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { ALLOWED_FONT_FAMILIES } from "@campaignfoundry/CreativeGeneration";
import { projectRoot } from "@campaignfoundry/shared";
import { outputRoot } from "./config.js";
import { loadEnv } from "./env.js";
import { LOCAL_TENANT, type TenantContext } from "./tenant.js";

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
  /**
   * Where this tenant's runs write their output, and so where every adapter built
   * from this environment keeps its files, the generation cache included (PT-0c).
   */
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
 * A tenant's output root under the process's (PT-0c, C7). The local operator keeps
 * the root itself, so nothing on disk moves; any other org gets `orgs/<orgId>`,
 * so what one org generates, caches or packages is never under another org's
 * root. An org id is a path segment here, so it must be a safe id: anything else
 * is refused rather than joined.
 */
export function tenantRoot(root: string, tenant: TenantContext): string {
  if (tenant.orgId === LOCAL_TENANT.orgId) return root;
  if (!SAFE_ID_PATTERN.test(tenant.orgId)) {
    throw new Error(`Tenant org id ${JSON.stringify(tenant.orgId)} is not a safe id.`);
  }
  return join(root, "orgs", tenant.orgId);
}

/** The name PT-0c shipped; the rule applies to every root, so it is `tenantRoot`. */
export const tenantOutputRoot = tenantRoot;

/** Where a tenant's stores keep their files (PT-0b2): both roots scoped by `tenantRoot`. */
export interface StorageRoots {
  /** Output: runs, reports, packages, jobs, the generation cache. */
  readonly outputRoot: string;
  /** Authored data: briefs, pools and uploaded assets (`assets/inputs`). */
  readonly projectRoot: string;
}

/** A tenant's storage roots. The stores are built from these, never from env (D167). */
export function storageRoots(tenant: TenantContext): StorageRoots {
  loadEnv();
  return {
    outputRoot: tenantRoot(outputRoot(), tenant),
    projectRoot: tenantRoot(projectRoot(), tenant),
  };
}

/**
 * What a store is asked for: a tenant, whose roots are resolved now, or a run's
 * captured environment, whose roots are the ones it was admitted with (review on
 * #575). A run passes its environment everywhere, so its job updates and report
 * land beside its assets even if the process configuration moved meanwhile.
 */
export type StorageScope = TenantContext | RunEnvironment;

/** The tenant a scope acts for: a run's captured one, or the tenant itself. */
export function scopeTenant(scope: StorageScope): TenantContext {
  return "outputRoot" in scope ? scope.tenant : scope;
}

/** The storage roots a scope names: captured for a run, resolved for a tenant. */
export function scopeRoots(scope: StorageScope): StorageRoots {
  return "outputRoot" in scope
    ? { outputRoot: scope.outputRoot, projectRoot: scope.assetRoot }
    : storageRoots(scope);
}

/**
 * Resolve a tenant's run environment. The local operator resolves to the
 * process's output root, so bytes land exactly where they did; another org
 * resolves to its own root beneath it (`tenantOutputRoot`).
 */
export function runEnvironment(tenant: TenantContext): RunEnvironment {
  const roots = storageRoots(tenant);
  return {
    tenant,
    outputRoot: roots.outputRoot,
    // The same root the tenant's briefs and uploads live under, so a brief's
    // `assets/inputs/…` path resolves inside its own org.
    assetRoot: roots.projectRoot,
    messageFont: messageFont(),
    providers: providerSettings(),
  };
}
