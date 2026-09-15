import { parse } from "yaml";
import { NamingError, splitTemplate } from "./naming.js";
import type { ContextDecl, ContextLists, LayerName, Manifest, StubKind } from "./types.js";

export class ManifestError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One section of the manifest tree: absent means empty, wrong shape is an error. */
function section(value: unknown, owner: string, key: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new ManifestError(`${owner}: ${key} must be a mapping`);
  }
  return value;
}

/** One inventory array: absent means empty, anything but strings is an error. */
function strArray(value: unknown, owner: string, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ManifestError(`${owner}: ${key} must be a list of strings`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ManifestError(`${owner}: ${key} must be a list of strings`);
    }
  }
  return [...value];
}

function parseContext(raw: unknown): ContextDecl {
  if (!isRecord(raw) || typeof raw["name"] !== "string" || raw["name"].length === 0) {
    throw new ManifestError("every bounded context needs a non-empty name");
  }
  const name = raw["name"];
  const layers = section(raw["layers"], name, "layers");
  const domain = section(layers["domain"], name, "layers.domain");
  const application = section(layers["application"], name, "layers.application");
  const ports = section(application["ports"], name, "application.ports");
  const infrastructure = section(layers["infrastructure"], name, "layers.infrastructure");
  const lists: ContextLists = {
    entities: strArray(domain["entities"], name, "entities"),
    value_objects: strArray(domain["value_objects"], name, "value_objects"),
    domain_services: strArray(domain["domain_services"], name, "domain_services"),
    use_cases: strArray(application["use_cases"], name, "use_cases"),
    "ports.in": strArray(ports["in"], name, "ports.in"),
    "ports.out": strArray(ports["out"], name, "ports.out"),
    adapters: strArray(infrastructure["adapters"], name, "adapters"),
  };
  return { name, lists };
}

const LAYER_DEFAULTS: Record<LayerName, string> = {
  domain: "src/domain",
  application: "src/application",
  infrastructure: "src/infrastructure",
};

function layerFolders(generator: Record<string, unknown>): Record<LayerName, string> {
  const sync = section(generator["sync"], "generator", "sync");
  const layers = section(sync["layers"], "generator.sync", "layers");
  const folders = {} as Record<LayerName, string>;
  for (const layer of Object.keys(LAYER_DEFAULTS) as LayerName[]) {
    const declared = section(layers[layer], `generator.sync.layers`, layer)["folder"];
    folders[layer] = typeof declared === "string" ? declared : LAYER_DEFAULTS[layer];
  }
  return folders;
}

const STUB_KINDS: readonly StubKind[] = [
  "entity",
  "valueObject",
  "domainService",
  "useCase",
  "inPort",
  "outPort",
  "adapter",
];

function stubNaming(generator: Record<string, unknown>): Partial<Record<StubKind, string>> {
  const sync = section(generator["sync"], "generator", "sync");
  const stubs = section(sync["stubs"], "generator.sync", "stubs");
  const naming = section(stubs["naming"], "generator.sync.stubs", "naming");
  const resolved: Partial<Record<StubKind, string>> = {};
  for (const kind of STUB_KINDS) {
    const value = naming[kind];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new ManifestError(`stubs.naming.${kind} must be a string template`);
    }
    try {
      splitTemplate(value);
    } catch (error) {
      /* istanbul ignore next -- splitTemplate throws only NamingError. The
         guard exists so an unexpected failure surfaces as itself rather
         than as a bad naming template. */
      if (!(error instanceof NamingError)) throw error;
      throw new ManifestError(`stubs.naming.${kind}: ${error.message}`);
    }
    resolved[kind] = value;
  }
  return resolved;
}

/**
 * Read the architecture manifest far enough to compare inventories: the
 * per-context lists, the layer folders, and the stub-naming overrides.
 * Structural rules of the wider schema belong to `hexagen arch validate`;
 * this only refuses what would silently skew the comparison.
 */
export function parseManifest(text: string): Manifest {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error: unknown) {
    // The yaml parser throws YAMLException and nothing else, so there is no
    // non-Error arm to guard here — adding one would be an unreachable branch.
    throw new ManifestError(`invalid YAML: ${(error as SyntaxError).message}`);
  }
  if (!isRecord(doc) || doc["bounded_contexts"] === undefined) {
    throw new ManifestError("manifest is not a mapping with a bounded_contexts list");
  }
  const contexts = doc["bounded_contexts"];
  if (!Array.isArray(contexts)) {
    throw new ManifestError("bounded_contexts must be a list");
  }
  const generator = section(doc["generator"], "manifest", "generator");
  return {
    contexts: contexts.map(parseContext),
    naming: stubNaming(generator),
    folders: layerFolders(generator),
  };
}
