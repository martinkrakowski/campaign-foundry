/**
 * The pure `templateProblem` validator for a `CreativeTemplate` (RW-22) and
 * the typed errors the template store boundary throws.
 *
 * A template arrives as untrusted request-body JSON, so `templateProblem`
 * never throws: every failure path returns a non-empty problem string and a
 * valid template returns `undefined`. It mirrors the checks the read side
 * already applies (`apps/web`'s `asCreativeTemplate`) and the layer vocabulary
 * the brief boundary already owns (`isBriefTemplate`, the `layer*Problem`
 * family), so the two boundaries cannot drift — a problem the API refuses is a
 * problem this validator refuses, in the same words.
 */
import { ADVERTISING_UNITS } from "./advertising-units.js";
import {
  layerEnabledProblem,
  layerFrameProblem,
  layerLinkProblem,
  layerPropsProblem,
  satisfiesOrderConstraints,
} from "./brief-template.js";
import { CREATIVE_TYPES, CREATIVE_TYPE_RULES, type CreativeType } from "./creative-types.js";
import { LAYER_KINDS, type LayerKind } from "./layer-kinds.js";
import { layerTracksProblem } from "./tracks.js";
import { layerSpanProblem, layerTimeFieldProblem } from "./video-span.js";

/** The longest template `id` a template may carry. */
export const MAX_TEMPLATE_ID_LENGTH = 128;

/** The longest template `name` a template may carry. */
export const MAX_TEMPLATE_NAME_LENGTH = 200;

/** The highest template `version` (the signed 32-bit int the store column holds). */
export const MAX_TEMPLATE_VERSION = 2_147_483_647;

/**
 * The most layers a template may hold. `brief-template.ts` declares no
 * `MAX_*` of its own; this cap keeps the validator's per-template work
 * bounded — a hostile body naming an enormous `layers.length` is refused on
 * the length alone, before any element is walked.
 */
export const MAX_TEMPLATE_LAYERS = 64;

/** Own keys a template or layer may never carry: they pollute the prototype. */
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"] as const;

/** The first own forbidden key on `value`, or undefined when it carries none. */
function forbiddenKey(value: Record<string, unknown>): string | undefined {
  for (const key of FORBIDDEN_KEYS) {
    if (Object.hasOwn(value, key)) return key;
  }
  return undefined;
}

/** Formats an offending value the way the `got <JSON>` clause reads. */
function gotText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The problem shape the layer validators return: one names a `field`
 * (`layerEnabledProblem`, `layerLinkProblem`), one names a `path` (every
 * other member of the `layer*Problem` family). One of the two is always
 * present, so the formatter needs no defensive fallback.
 */
type LayerProblem =
  | { field: string; must: string; value: unknown }
  | { path: string; must: string; value: unknown };

/**
 * Formats a `{ field | path, must, value }` problem under a `layers[i]`
 * prefix. `section` is the layer property the validator inspected —
 * `""` for the layer's own fields (enabled, link, the seconds keys),
 * `".frame"`, `".props"`, `".tracks"` or `".span"` for the sub-objects —
 * the same way the brief boundary builds `template.layers[${i}].tracks`
 * plus the problem path in `apps/api/server/lib/load-brief.ts`. A `path`
 * already carries its own leading `.` (or starts with `[`), so the two
 * concatenate directly.
 */
function formatLayerProblem(index: number, section: string, problem: LayerProblem): string {
  const where = "field" in problem ? `.${problem.field}` : problem.path;
  return `layers[${index}]${section}${where} must ${problem.must} (got ${gotText(problem.value)})`;
}

/**
 * Why `template` is not a template the store may hold (RW-22); undefined when
 * it is. Never throws: a getter that throws, a Proxy that traps every
 * operation, or a value that cannot be stringified is caught and reported as
 * `"template could not be read"` — the same text the route shows.
 */
export function templateProblem(template: unknown): string | undefined {
  try {
    if (typeof template !== "object" || template === null || Array.isArray(template)) {
      return "template must be a plain object";
    }
    const rec = template as Record<string, unknown>;

    const polluting = forbiddenKey(rec);
    if (polluting !== undefined) {
      return `template contains forbidden key "${polluting}"`;
    }

    if (
      typeof rec.id !== "string" ||
      rec.id.trim().length === 0 ||
      rec.id.length > MAX_TEMPLATE_ID_LENGTH
    ) {
      return `template id must be a non-empty string of at most ${MAX_TEMPLATE_ID_LENGTH} characters`;
    }
    if (rec.id.includes("@")) {
      return 'template id must not contain "@"';
    }

    if (
      typeof rec.version !== "number" ||
      !Number.isInteger(rec.version) ||
      rec.version < 1 ||
      rec.version > MAX_TEMPLATE_VERSION
    ) {
      return `template version must be an integer between 1 and ${MAX_TEMPLATE_VERSION}`;
    }

    if (
      typeof rec.name !== "string" ||
      rec.name.trim().length === 0 ||
      rec.name.length > MAX_TEMPLATE_NAME_LENGTH
    ) {
      return `template name must be a non-empty string of at most ${MAX_TEMPLATE_NAME_LENGTH} characters`;
    }

    if (
      typeof rec.unit !== "string" ||
      !(ADVERTISING_UNITS as readonly string[]).includes(rec.unit)
    ) {
      return `template unit must be one of ${ADVERTISING_UNITS.map((unit) => `"${unit}"`).join(", ")}`;
    }

    if (
      typeof rec.creativeType !== "string" ||
      !(CREATIVE_TYPES as readonly string[]).includes(rec.creativeType)
    ) {
      return `template creativeType must be one of ${CREATIVE_TYPES.map((type) => `"${type}"`).join(", ")}`;
    }

    if (!Array.isArray(rec.layers)) {
      return "layers must be an array";
    }
    if (rec.layers.length === 0) {
      return "layers must not be empty";
    }
    if (rec.layers.length > MAX_TEMPLATE_LAYERS) {
      return `layers must have at most ${MAX_TEMPLATE_LAYERS} entries`;
    }

    const creativeType = rec.creativeType as CreativeType;
    const rules = CREATIVE_TYPE_RULES[creativeType];
    const counts = new Map<string, number>();
    const enabledKinds = new Set<string>();
    const seenLayerIds = new Set<string>();

    for (let i = 0; i < rec.layers.length; i += 1) {
      if (!(i in rec.layers)) {
        return `layers[${i}] must be an object`;
      }
      const layer: unknown = rec.layers[i];
      if (typeof layer !== "object" || layer === null || Array.isArray(layer)) {
        return `layers[${i}] must be an object`;
      }
      const layerRec = layer as Record<string, unknown>;

      const layerPolluting = forbiddenKey(layerRec);
      if (layerPolluting !== undefined) {
        return `layers[${i}] contains forbidden key "${layerPolluting}"`;
      }

      if (typeof layerRec.id !== "string" || layerRec.id.length === 0) {
        return `layers[${i}] id must be a non-empty string`;
      }
      if (seenLayerIds.has(layerRec.id)) {
        return `layers[${i}] id "${layerRec.id}" is already used by an earlier layer`;
      }
      seenLayerIds.add(layerRec.id);

      if (
        typeof layerRec.kind !== "string" ||
        !(LAYER_KINDS as readonly string[]).includes(layerRec.kind)
      ) {
        return `layers[${i}] kind must be one of ${LAYER_KINDS.map((kind) => `"${kind}"`).join(", ")}`;
      }
      const kind = layerRec.kind as LayerKind;

      const enabledProblem = layerEnabledProblem(layerRec.enabled);
      if (enabledProblem !== undefined) {
        return formatLayerProblem(i, "", enabledProblem);
      }
      const linkProblem = layerLinkProblem(layerRec.link);
      if (linkProblem !== undefined) {
        return formatLayerProblem(i, "", linkProblem);
      }
      const frameProblem = layerFrameProblem(layerRec.frame);
      if (frameProblem !== undefined) {
        return formatLayerProblem(i, ".frame", frameProblem);
      }
      if (layerRec.props !== undefined) {
        const propsProblem = layerPropsProblem(kind, layerRec.props);
        if (propsProblem !== undefined) {
          return formatLayerProblem(i, ".props", propsProblem);
        }
      }
      if (Object.hasOwn(layerRec, "elements")) {
        return `layers[${i}] must not carry its own "elements" property`;
      }
      const tracksProblem = layerTracksProblem(kind, layerRec.tracks);
      if (tracksProblem !== undefined) {
        return formatLayerProblem(i, ".tracks", tracksProblem);
      }
      const timeFieldProblem = layerTimeFieldProblem(layerRec);
      if (timeFieldProblem !== undefined) {
        return formatLayerProblem(i, ".", timeFieldProblem);
      }
      const spanProblem = layerSpanProblem(kind, layerRec.span);
      if (spanProblem !== undefined) {
        return formatLayerProblem(i, ".span", spanProblem);
      }

      if (!(rules.accepts as readonly string[]).includes(kind)) {
        return `layers[${i}] kind "${kind}" is not accepted by creative type "${creativeType}"`;
      }
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (layerRec.enabled !== false) {
        enabledKinds.add(kind);
      }
    }

    for (const kind of rules.accepts) {
      const max = rules.maxOf[kind];
      if (max !== undefined && (counts.get(kind) ?? 0) > max) {
        return `layers must hold at most ${max} of kind "${kind}"`;
      }
    }
    for (const budget of rules.sharedBudgets) {
      const used = budget.kinds.reduce((sum, kind) => sum + (counts.get(kind) ?? 0), 0);
      if (used > budget.max) {
        return `layers must hold at most ${budget.max} across kinds ${budget.kinds.map((kind) => `"${kind}"`).join(", ")}`;
      }
    }
    for (const kind of rules.required) {
      if (!enabledKinds.has(kind)) {
        return `creative type "${creativeType}" requires an enabled "${kind}" layer`;
      }
    }
    if (
      !satisfiesOrderConstraints(
        creativeType,
        rec.layers as readonly { readonly kind: LayerKind }[],
      )
    ) {
      return `layers order must satisfy the order constraints of creative type "${creativeType}"`;
    }

    return undefined;
  } catch {
    return "template could not be read";
  }
}

/** The error the template store throws for a template `templateProblem` refuses. */
export class InvalidTemplateError extends Error {
  /** The problem text `templateProblem` returned. */
  readonly problem: string;

  constructor(problem: string) {
    super(problem);
    this.name = "InvalidTemplateError";
    this.problem = problem;
  }
}

/** The error thrown when a template id collides with a canonical template id. */
export class CanonicalTemplateCollisionError extends Error {
  constructor(message = "template id collides with a canonical template id") {
    super(message);
    this.name = "CanonicalTemplateCollisionError";
  }
}

/** The error thrown when a template version already exists for its id. */
export class TemplateVersionExistsError extends Error {
  constructor(message = "a template with this id and version already exists") {
    super(message);
    this.name = "TemplateVersionExistsError";
  }
}

/** The error thrown when the backing store cannot support the write. */
export class TemplateWriteUnsupportedError extends Error {
  constructor(message = "the template store does not support this write") {
    super(message);
    this.name = "TemplateWriteUnsupportedError";
  }
}
