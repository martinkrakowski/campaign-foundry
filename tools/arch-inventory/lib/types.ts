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
export type ContextLists = Record<ListKey, readonly string[]>;

export interface ContextDecl {
  readonly name: string;
  readonly lists: ContextLists;
}

export interface Manifest {
  readonly contexts: readonly ContextDecl[];
  /** Stub-naming overrides from `generator.sync.stubs.naming` (may be empty). */
  readonly naming: Partial<Record<StubKind, string>>;
  /** Layer folder inside each context package, from `generator.sync.layers`. */
  readonly folders: Record<LayerName, string>;
}

/** One context x one list: declared entries with no file, files with no entry. */
export interface Finding {
  readonly context: string;
  readonly list: ListKey;
  readonly missing: readonly string[];
  readonly stale: readonly string[];
}
