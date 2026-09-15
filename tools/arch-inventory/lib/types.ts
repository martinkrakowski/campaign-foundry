/**
 * Types shared by the arch-inventory tool.
 *
 * A "list" is one inventory array of the architecture manifest. Each list
 * owns exactly one folder in each bounded context package and maps to one
 * hexagen stub-naming kind, which pins how a module file is named:
 * `{name}.vo.ts` for value objects, `{name}.use-case.ts` for use cases, and
 * so on — the convention can be overridden per kind in the manifest under
 * `generator.sync.stubs.naming`, which this tool honors.
 */

export type ListKey =
  | "entities"
  | "value_objects"
  | "domain_services"
  | "use_cases"
  | "ports.in"
  | "ports.out"
  | "adapters";

export type StubKind =
  | "entity"
  | "valueObject"
  | "domainService"
  | "useCase"
  | "inPort"
  | "outPort"
  | "adapter";

export type LayerName = "domain" | "application" | "infrastructure";

/** The seven inventory arrays of one bounded context, always present. */
export interface ContextInventory {
  readonly entities: readonly string[];
  readonly value_objects: readonly string[];
  readonly domain_services: readonly string[];
  readonly use_cases: readonly string[];
  readonly "ports.in": readonly string[];
  readonly "ports.out": readonly string[];
  readonly adapters: readonly string[];
}

export interface ContextDecl {
  readonly name: string;
  readonly inventory: ContextInventory;
}

export interface Manifest {
  readonly contexts: readonly ContextDecl[];
  /** Stub-naming overrides from `generator.sync.stubs.naming` (may be empty). */
  readonly naming: Partial<Record<StubKind, string>>;
  /** Layer folder per context package, from `generator.sync.layers`. */
  readonly layerFolders: Record<LayerName, string>;
}

/** One declared entry with no matching module file. */
export interface ListResult {
  readonly key: ListKey;
  readonly missing: readonly string[];
  readonly stale: readonly string[];
}

export interface ContextResult {
  readonly name: string;
  readonly lists: readonly ListResult[];
}
