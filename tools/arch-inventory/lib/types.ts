/**
 * Types shared by the arch-inventory tool.
 *
 * A "list" is one inventory array of the architecture manifest. Each list
 * owns exactly one folder in each bounded context package and maps to one
 * hexagen stub-naming kind, which pins how a module file is named:
 * `{name}.vo.ts` for value objects, `{name}.use-case.ts` for use cases, and
 * so on — the convention can be overridden per kind in the manifest under
 * `generator.sync.stubs.naming` (globally) or a context's own
 * `generator.stubs.naming` (per bounded context), which this tool honors in
 * the same precedence hexagen's own `resolveNaming` applies (see naming.ts).
 */

export type ListKey =
  | "entities"
  | "value_objects"
  | "domain_services"
  | "use_cases"
  | "ports.in"
  | "ports.out"
  | "adapters";

/** Mirrors the key set of `@hexagen-monaco/sync`'s `StubNaming` exactly — pinned by
 *  a structural assignment in naming.ts, so a drift in hexagen's own type fails a
 *  compile here rather than silently comparing the wrong kind. */
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
  /** Stub-naming template per kind, already resolved for this context: its own
   *  `generator.stubs.naming` override, else the manifest's global
   *  `generator.sync.stubs.naming`, else hexagen's `DEFAULT_NAMING`. */
  readonly naming: Readonly<Record<StubKind, string>>;
}

export interface Manifest {
  readonly contexts: readonly ContextDecl[];
  /** Layer folder inside each context package, from `generator.sync.layers`. */
  readonly folders: Record<LayerName, string>;
  /** The project's npm scope (without `@`), for a `{scope}` naming template. */
  readonly scope: string;
}

/** One context x one list: declared entries with no file, files with no entry,
 *  and declared entries that collide (a literal repeat, or two names the naming
 *  template resolves to the same file). */
export interface Finding {
  readonly context: string;
  readonly list: ListKey;
  readonly missing: readonly string[];
  readonly stale: readonly string[];
  readonly duplicates: readonly string[];
}
