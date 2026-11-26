import {
  CanonicalTemplateCollisionError,
  InvalidTemplateError,
  TemplateVersionExistsError,
  TemplateWriteUnsupportedError,
} from "@campaignfoundry/CampaignOrchestration";
import { readRawBody, type H3Event } from "h3";
import type { TenantContext } from "./tenant.js";

/**
 * The raw-body cap for a template write, checked before any parse: a hostile
 * body is refused on its size alone, the same way `assets.post.ts` bounds its
 * uploads. 64 KiB is far past any real template (the canonical library's
 * largest is a few hundred bytes) and far under anything that could make a
 * JSON.parse itself a denial of service.
 */
export const MAX_TEMPLATE_BODY_BYTES = 64 * 1024;

/**
 * The route-side half of the template write permission (RW-22): templates are
 * org-wide — there is no `teamId` to hand `canAssignTeam` — so an org-wide
 * mutation is `owner`/`admin` only, the same rule `ownership.ts` applies to
 * clearing an assigned team. `LOCAL_TENANT` passes because its roles are
 * `["owner"]`.
 */
export function canWriteTemplates(tenant: TenantContext): boolean {
  return tenant.roles.includes("owner") || tenant.roles.includes("admin");
}

/**
 * A body the route refuses before any store call. Carries its own status —
 * `400` for a malformed or dishonest body, `413` for one over the cap — so
 * `respondTemplateWriteError` can map it without re-deciding.
 */
export class TemplateBodyError extends Error {
  readonly statusCode: 400 | 413;

  constructor(statusCode: 400 | 413, message: string) {
    super(message);
    this.name = "TemplateBodyError";
    this.statusCode = statusCode;
  }
}

/** The four fields a template write body may carry, still unvalidated. */
export interface TemplateWriteInput {
  name: unknown;
  unit: unknown;
  creativeType: unknown;
  layers: unknown;
}

/** The only top-level keys a template write body may carry. */
const ALLOWED_KEYS = new Set(["name", "unit", "creativeType", "layers"]);

/**
 * Read and shape a template write body. The raw string is read directly (not
 * `readBody`, which parses and bounds nothing): a body over the cap is refused
 * before it is ever parsed, and everything after is a deliberate shape check —
 * the JSON object must carry exactly the four template fields, and never
 * `id` or `version`, which the server mints and the store versions. The field
 * VALUES are left `unknown` on purpose: what makes them a template is
 * `templateProblem`, run by the store, which the routes map through
 * `InvalidTemplateError`.
 */
export async function parseTemplateWriteBody(event: H3Event): Promise<TemplateWriteInput> {
  const raw = await readRawBody(event, "utf8");
  if (raw === undefined || raw.trim() === "") {
    throw new TemplateBodyError(400, "Template body must be a JSON object.");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_TEMPLATE_BODY_BYTES) {
    throw new TemplateBodyError(413, "Template body exceeds the 64 KiB size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TemplateBodyError(400, "Template body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TemplateBodyError(400, "Template body must be a JSON object.");
  }
  const body = parsed as Record<string, unknown>;
  if (Object.hasOwn(body, "id")) {
    throw new TemplateBodyError(400, 'Template body must not carry "id"; the server mints it.');
  }
  if (Object.hasOwn(body, "version")) {
    throw new TemplateBodyError(
      400,
      'Template body must not carry "version"; the store assigns it.',
    );
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new TemplateBodyError(400, `Unknown template body key "${key}".`);
    }
  }
  return { name: body.name, unit: body.unit, creativeType: body.creativeType, layers: body.layers };
}

/**
 * Map every failure a template write can meet onto its one HTTP answer, in the
 * `{ error }` shape the other campaign routes return. An unexpected failure is
 * a fixed text, never the internal error's message — a store stack trace is
 * not a body to hand a client.
 */
export function respondTemplateWriteError(event: H3Event, error: unknown): { error: string } {
  if (error instanceof TemplateBodyError) {
    setResponseStatus(event, error.statusCode);
    return { error: error.message };
  }
  if (error instanceof InvalidTemplateError) {
    setResponseStatus(event, 400);
    return { error: error.message };
  }
  if (error instanceof CanonicalTemplateCollisionError) {
    setResponseStatus(event, 409);
    return { error: error.message };
  }
  if (error instanceof TemplateVersionExistsError) {
    setResponseStatus(event, 409);
    return { error: error.message };
  }
  if (error instanceof TemplateWriteUnsupportedError) {
    setResponseStatus(event, 501);
    return { error: error.message };
  }
  setResponseStatus(event, 500);
  return { error: "Could not save template." };
}
