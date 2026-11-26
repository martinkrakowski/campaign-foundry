import {
  CanonicalTemplateCollisionError,
  InvalidTemplateError,
  TemplateVersionExistsError,
  TemplateWriteUnsupportedError,
} from "@campaignfoundry/CampaignOrchestration";
import type { H3Event } from "h3";
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
 * Read and shape a template write body. The bytes are read straight off the
 * request stream under a running byte cap (not `readBody`, which parses and
 * bounds nothing): an honest oversized `Content-Length` is refused before a
 * single body byte is read, and a lying one — or no header at all — is caught
 * mid-stream, the moment the cap is crossed, so a hostile body is never
 * buffered in full. Everything after is a deliberate shape check — the JSON
 * object must carry exactly the four template fields, and never `id` or
 * `version`, which the server mints and the store versions. The field VALUES
 * are left `unknown` on purpose: what makes them a template is
 * `templateProblem`, run by the store, which the routes map through
 * `InvalidTemplateError`.
 */
export async function parseTemplateWriteBody(event: H3Event): Promise<TemplateWriteInput> {
  // Fail fast on a declared length that trims to a non-negative integer over
  // the cap. Absent, non-numeric, or understated headers fall through: the
  // streaming read below counts actual bytes, so a lying header is still
  // caught before the body is ever parsed.
  const declared = getRequestHeader(event, "content-length");
  if (declared !== undefined && /^\d+$/.test(declared.trim())) {
    if (Number.parseInt(declared.trim(), 10) > MAX_TEMPLATE_BODY_BYTES) {
      throw new TemplateBodyError(413, "Template body exceeds the 64 KiB size limit.");
    }
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (event.web?.request) {
    // Web path (Nitro's web compatibility layer): the body stream is nullable
    // — a POST/PUT with no body has none at all.
    const body = event.web.request.body;
    if (!body) {
      throw new TemplateBodyError(400, "Template body must be a JSON object.");
    }
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_TEMPLATE_BODY_BYTES) {
          chunks.length = 0;
          await reader.cancel();
          throw new TemplateBodyError(413, "Template body exceeds the 64 KiB size limit.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    // Node path: h3's `getRequestWebStream` wraps `req.on("data")` with no
    // cancel or backpressure, so consume `event.node.req` directly and stop it
    // ourselves on overflow — pause and unlisten, so no further chunk is
    // buffered or throws, and the 413 response stays writable.
    const req = event.node.req;
    await new Promise<void>((resolve, reject) => {
      const unlisten = (): void => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
      };
      const onData = (chunk: Buffer): void => {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_TEMPLATE_BODY_BYTES) {
          chunks.length = 0;
          req.pause();
          unlisten();
          reject(new TemplateBodyError(413, "Template body exceeds the 64 KiB size limit."));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        unlisten();
        resolve();
      };
      const onError = (error: Error): void => {
        unlisten();
        reject(error);
      };
      req.on("data", onData);
      req.once("end", onEnd);
      req.once("error", onError);
    });
  }

  if (totalBytes === 0) {
    throw new TemplateBodyError(400, "Template body must be a JSON object.");
  }
  // Multi-byte UTF-8 characters split across chunk boundaries survive: the
  // bytes are concatenated before the single decode.
  const raw = Buffer.concat(chunks, totalBytes).toString("utf8");
  if (raw.trim() === "") {
    throw new TemplateBodyError(400, "Template body must be a JSON object.");
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
