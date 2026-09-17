import { portName } from "@hexagen-monaco/sync";
import type {
  BoundedContext,
  LegacyOrNewPort,
  Manifest as HexManifest,
} from "@hexagen-monaco/sync";
import { DEFAULT_NAMING, NamingError, resolveScope, resolveTemplate } from "./naming.js";
import type { ContextDecl, ContextLists, LayerName, Manifest, StubKind } from "./types.js";

const LAYER_DEFAULTS: Record<LayerName, string> = {
  domain: "src/domain",
  application: "src/application",
  infrastructure: "src/infrastructure",
};

const STUB_KINDS: readonly StubKind[] = [
  "entity",
  "valueObject",
  "domainService",
  "useCase",
  "inPort",
  "outPort",
  "adapter",
];

function layerFolders(manifest: HexManifest): Record<LayerName, string> {
  const layers = manifest.generator?.sync?.layers ?? {};
  const folders = {} as Record<LayerName, string>;
  for (const layer of Object.keys(LAYER_DEFAULTS) as LayerName[]) {
    const configured = layers[layer]?.folder;
    folders[layer] =
      typeof configured === "string" && configured.length > 0 ? configured : LAYER_DEFAULTS[layer];
  }
  return folders;
}

/**
 * Resolve one context's stub naming, kind by kind, in the same precedence as
 * hexagen's own `resolveNaming` (`src/generators/stubs.ts`, `dist/index.js`):
 * the context's own `generator.stubs.naming` override, else the manifest's
 * global `generator.sync.stubs.naming`, else `DEFAULT_NAMING`. Resolving here
 * (rather than per list-check) makes the result total — every kind always
 * has a template, so nothing downstream needs an `??` fallback again.
 *
 * Also validates each resolved template eagerly (`resolveTemplate` throws a
 * `NamingError` for a template with no `{name}`, or two): hexagen's own
 * generator tolerates that at the cost of a broken filename, but this tool's
 * comparison depends on `{name}` being invertible, so it refuses up front —
 * here, where `fromHexagen`'s caller can catch it as one malformed manifest,
 * rather than lazily inside `checkInventory` where nothing is watching.
 */
function resolveNaming(
  manifest: HexManifest,
  context: BoundedContext,
  scope: string,
): Readonly<Record<StubKind, string>> {
  const manifestNaming = manifest.generator?.sync?.stubs?.naming ?? {};
  const contextNaming = context.generator?.stubs?.naming ?? {};
  const naming = {} as Record<StubKind, string>;
  for (const kind of STUB_KINDS) {
    const template = contextNaming[kind] ?? manifestNaming[kind] ?? DEFAULT_NAMING[kind];
    try {
      resolveTemplate(template, scope);
    } catch (error) {
      /* istanbul ignore next -- resolveTemplate throws only NamingError. The
         guard exists so an unexpected failure surfaces as itself rather than
         as a bad naming template. */
      if (!(error instanceof NamingError)) throw error;
      throw new NamingError(`${context.name}: stubs.naming.${kind}: ${error.message}`);
    }
    naming[kind] = template;
  }
  return naming;
}

/** Ports may be a bare name or an owned-port object `{ name, owner? }`
 *  (`LegacyOrNewPort`) — `portName` extracts the name either way, the same
 *  as hexagen's own `buildEmissionPlan`. */
function portNames(ports: readonly LegacyOrNewPort[] | undefined): readonly string[] {
  return (ports ?? []).map(portName);
}

function contextLists(context: BoundedContext): ContextLists {
  const domain = context.layers?.domain ?? {};
  const application = context.layers?.application ?? {};
  const infrastructure = context.layers?.infrastructure ?? {};
  return {
    entities: domain.entities ?? [],
    value_objects: domain.value_objects ?? [],
    domain_services: domain.domain_services ?? [],
    use_cases: application.use_cases ?? [],
    "ports.in": portNames(application.ports?.in),
    "ports.out": portNames(application.ports?.out),
    adapters: infrastructure.adapters ?? [],
  };
}

/**
 * Adapt hexagen's own loaded manifest (anchors resolved, split manifests
 * merged, owned-port objects intact — all `loadManifest`'s job, not this
 * tool's) into the shape `checkInventory` compares against the tree.
 */
export function fromHexagen(manifest: HexManifest): Manifest {
  const scope = resolveScope(manifest);
  const contexts: ContextDecl[] = (manifest.bounded_contexts ?? []).map((context) => ({
    name: context.name,
    lists: contextLists(context),
    naming: resolveNaming(manifest, context, scope),
  }));
  return { contexts, folders: layerFolders(manifest), scope };
}
