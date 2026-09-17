import type {
  CreativeTemplate,
  CreativeTemplateLayer,
} from "@campaignfoundry/CampaignOrchestration";
import {
  isBriefTemplate,
  type BriefTemplate,
} from "@campaignfoundry/CampaignOrchestration/brief-template";
import { ADVERTISING_UNITS } from "@campaignfoundry/CampaignOrchestration/advertising-units";
import { CREATIVE_TYPES } from "@campaignfoundry/CampaignOrchestration/creative-types";
import { LAYER_KINDS } from "@campaignfoundry/CampaignOrchestration/layer-kinds";

/**
 * The web client for the creative template library (TM1, D123).
 *
 * `GET /campaigns/templates` and `GET /campaigns/templates/:ref` shipped with L7
 * and nothing in the web app called either: `grep -rn "campaigns/templates"
 * apps/web/src` answered with the route tests alone. This module is that missing
 * half — no UI, no state, just the two reads and the pure collapses the library
 * modal needs over their answers.
 *
 * It does NOT share `briefs-api`'s request body path, and the difference is the
 * whole point of the lane's first red fault. `listBriefs` degrades a malformed
 * 200 to `[]`; the list route's own doc comment names why the library may not:
 * *"a store read failure is a 500, never an empty list — an empty answer reads as
 * 'no templates yet'"*. A client that answered `[]` for a body it could not
 * parse would re-introduce on this side of the wire exactly the ambiguity the
 * route refuses on the other. So every failure here THROWS, and only a
 * well-formed `{ templates: [...] }` — the empty array included — is an answer.
 *
 * Value imports come from the package's deep subpaths, never the source barrel:
 * the barrel resolves `.js` siblings and fails the Next build (`BriefPicker`
 * records the same trap for `SAFE_ID_PATTERN`).
 */

/** Same path as `briefs-api`'s `API`. Local so this module stays dependency-free. */
const API = "/api/pipeline";

/** HTTP (or shape) failure from the template routes; `status` is 0 for a network error. */
export class TemplatesApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TemplatesApiError";
    this.status = status;
  }
}

export function isTemplatesApiError(error: unknown): error is TemplatesApiError {
  return error instanceof TemplatesApiError;
}

async function parseJsonBody(res: Response): Promise<unknown> {
  const raw = await res.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function errorFrom(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null) {
    const message = (data as { error?: unknown }).error;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

async function requestJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new TemplatesApiError("Network error", 0);
  }
  // The body is a stream and can fail after `fetch` resolved; a rejection there is
  // still a failed read, not an empty library.
  let data: unknown;
  try {
    data = await parseJsonBody(res);
  } catch {
    throw new TemplatesApiError("Network error", res.status);
  }
  if (!res.ok) {
    throw new TemplatesApiError(errorFrom(data, `Request failed (HTTP ${res.status})`), res.status);
  }
  return data;
}

function isLayer(value: unknown): value is CreativeTemplateLayer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as { id?: unknown; kind?: unknown };
  return (
    typeof rec.id === "string" &&
    rec.id.length > 0 &&
    typeof rec.kind === "string" &&
    (LAYER_KINDS as readonly string[]).includes(rec.kind)
  );
}

/**
 * A library record, or a throw. Every field the modal renders is checked —
 * `name` and `unit` included — because a field carried across untrusted JSON
 * without a check is a field the component dereferences on a shape the route
 * never sent. The layers are checked per entry for the same reason
 * `isBriefTemplate` checks them: the grid's thumbnail dereferences
 * `layer.kind`, so a `null` entry would crash the render rather than surface as
 * an error state.
 */
export function asCreativeTemplate(data: unknown): CreativeTemplate {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TemplatesApiError("Invalid response", 200);
  }
  const rec = data as Record<string, unknown>;
  if (
    typeof rec.id !== "string" ||
    rec.id.length === 0 ||
    typeof rec.version !== "number" ||
    !Number.isInteger(rec.version) ||
    rec.version <= 0 ||
    typeof rec.name !== "string" ||
    typeof rec.unit !== "string" ||
    !(ADVERTISING_UNITS as readonly string[]).includes(rec.unit) ||
    typeof rec.creativeType !== "string" ||
    !(CREATIVE_TYPES as readonly string[]).includes(rec.creativeType) ||
    !Array.isArray(rec.layers) ||
    rec.layers.length === 0 ||
    !rec.layers.every(isLayer)
  ) {
    throw new TemplatesApiError("Invalid response", 200);
  }
  return rec as unknown as CreativeTemplate;
}

/**
 * Every record in the library, **one entry per version** (`TemplateStorePort`,
 * `template-store.port.ts:15`). Callers that show a picker must collapse with
 * {@link latestPerId} — three versions of one template are three records here,
 * and a grid that renders them raw shows the same template three times (T3).
 *
 * A failed read throws. There is no `[]`-on-failure path: see the module note.
 */
export async function listTemplates(): Promise<CreativeTemplate[]> {
  const data = await requestJson(`${API}/campaigns/templates`);
  if (typeof data !== "object" || data === null) {
    throw new TemplatesApiError("Invalid response", 200);
  }
  const templates = (data as { templates?: unknown }).templates;
  if (!Array.isArray(templates)) {
    throw new TemplatesApiError("Invalid response", 200);
  }
  return templates.map(asCreativeTemplate);
}

/**
 * One record by reference — `id` or `id@version`, exactly the `:ref` spelling
 * `[ref].get.ts` documents. Percent-encoded as one path segment: the route
 * splits on the last `@` of the decoded param, so `encodeURIComponent` is what
 * keeps an id containing `/` from becoming two segments.
 *
 * No version → the highest the store holds (the port's default). An exact
 * version the store does not have is a 404 and throws; it is never a different
 * version of the same id, which is D123's immutability promise on the wire.
 */
export async function getTemplate(ref: string): Promise<CreativeTemplate> {
  const data = await requestJson(`${API}/campaigns/templates/${encodeURIComponent(ref)}`);
  if (typeof data !== "object" || data === null) {
    throw new TemplatesApiError("Invalid response", 200);
  }
  return asCreativeTemplate((data as { template?: unknown }).template);
}

/** The pinned spelling of a record — `id@version`, the `:ref` the routes take. */
export function templateRef(template: CreativeTemplate): string {
  return `${template.id}@${template.version}`;
}

/**
 * T-D2 — the picker's collapse: **the highest version of each id**, in the
 * order the ids first appear. Browsing versions is a curation task; the picker
 * exists to pick, and the version rides along as a chip so the pin stays
 * visible.
 *
 * `>` on the version, never array order: `listTemplates` flattens a per-id map,
 * so nothing promises the store's records arrive ascending, and a first-wins or
 * last-wins collapse would pin whichever version the store happened to emit.
 */
export function latestPerId(templates: readonly CreativeTemplate[]): CreativeTemplate[] {
  const latest = new Map<string, CreativeTemplate>();
  for (const template of templates) {
    const known = latest.get(template.id);
    if (known === undefined || template.version > known.version) {
      latest.set(template.id, template);
    }
  }
  return [...latest.values()];
}

/** Every version of one id, newest first — the detail view's version history. */
export function versionsOf(templates: readonly CreativeTemplate[], id: string): CreativeTemplate[] {
  return templates.filter((template) => template.id === id).sort((a, b) => b.version - a.version);
}

/**
 * The library record as a brief's pinned template (D123), or `null` when the
 * record cannot be one.
 *
 * `null` is a real answer, not a defensive branch. `BriefTemplate.id` is
 * `CanonicalTemplateId` and `isBriefTemplate` additionally requires
 * `CANONICAL_TEMPLATES[creativeType].id === id`, so **only a canonical record
 * is pinnable today** — a library grown beyond the canonical three would serve
 * records no brief can carry. `FsTemplateStore` is seeded from
 * `CANONICAL_TEMPLATES` and nothing else, so every record the live library
 * serves passes; the refusal exists so an un-pinnable record is refused
 * visibly rather than cast through and half-applied at the editor's restore
 * boundary.
 *
 * The guard is `isBriefTemplate` itself — the same one both storage boundaries
 * use — never a second copy of its rules here.
 */
export function pinnableTemplate(template: CreativeTemplate): BriefTemplate | null {
  const candidate = {
    id: template.id,
    version: template.version,
    creativeType: template.creativeType,
    unit: template.unit,
    layers: template.layers,
  };
  return isBriefTemplate(candidate) ? candidate : null;
}
