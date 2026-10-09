/**
 * Path and mode predicates for the pull-request context collector.
 *
 * N2 (regular file mode) and N4 (allow/deny paths) live here so every other
 * module asks one question — "may I collect this entry?" — without re-deriving
 * the rules.
 */

/** Modes git reports for a regular (non-executable) file and an executable one. */
const REGULAR_MODES = new Set(["100644", "100755"]);

/**
 * Whether a tree entry's mode is a regular file that may be read.
 *
 * A symlink's mode is `120000`; it is refused because reading it would pull bytes
 * from the link's target, which need not live at the base commit. N2.
 */
export function isRegularMode(mode: string): boolean {
  return REGULAR_MODES.has(mode);
}

/** Path segments that always deny, even inside an allowed root (deny wins). */
const DENY_SEGMENTS = new Set([
  "__tests__", "certs", "secrets", "deploy", ".github",
  "fixtures", "__mocks__", "__fixtures__", "generated", "vendor", "test", "tests",
]);

const DENY_SUFFIXES = [
  ".d.ts", ".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".stories.tsx",
  ".pem", ".key", ".p12", ".crt",
];

function hasDeniedSegment(path: string): boolean {
  for (const segment of path.split("/")) {
    const lower = segment.toLowerCase();
    if (DENY_SEGMENTS.has(lower)) return true;
    if (lower.startsWith(".env")) return true;
  }
  return false;
}

function hasDeniedSuffix(path: string): boolean {
  return DENY_SUFFIXES.some((suf) => path.endsWith(suf));
}

function hasDeniedBaseName(path: string): boolean {
  const name = path.split("/").pop();
  /* istanbul ignore next -- split always returns at least one element */
  if (name === undefined) return false;
  const dot = name.lastIndexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  const lower = base.toLowerCase();
  return lower === "secrets" || lower === "credentials";
}

/** True when the file name ends in `.ts` or `.tsx`. */
function endsWithTs(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".tsx");
}

/**
 * Whether a base-tree path survives the deny list and matches one allow rule.
 *
 * The deny list wins: a `__tests__` file under `packages/x/src` is refused, and a
 * `.d.ts` is refused even though it ends in `.ts`. N4.
 */
export function isCollectable(path: string): boolean {
  if (hasDeniedSegment(path)) return false;
  if (hasDeniedSuffix(path)) return false;
  if (hasDeniedBaseName(path)) return false;
  const s = path.split("/");
  const last = s[s.length - 1];

  // packages/<name>/src/**/*.ts|tsx
  if (s[0] === "packages" && s[2] === "src" && endsWithTs(last)) return true;
  // apps/api/server/**/*.ts
  if (s[2] === "server" && s[1] === "api" && s[0] === "apps" && last.endsWith(".ts")) return true;
  // apps/api/bin/**/*.ts
  if (s[2] === "bin" && s[1] === "api" && s[0] === "apps" && last.endsWith(".ts")) return true;
  // apps/web/src/**/*.ts|tsx
  if (s[0] === "apps" && s[1] === "web" && s[2] === "src" && endsWithTs(last)) return true;
  // apps/api/server/lib/db/migrations/*.sql  (single segment only)
    if (
      s[0] === "apps" &&
      s[1] === "api" &&
      s[2] === "server" &&
      s[3] === "lib" &&
      s[4] === "db" &&
      s[5] === "migrations" &&
      s.length === 7 &&
      last.endsWith(".sql")
    ) {
      return true;
    }

    return false;
  }

  const SAFE_PATH_RE = /^[A-Za-z0-9_./@()[\]-]+$/;
  const WITHHELD_PATH = "a changed file (name withheld: unusual characters)";

  /** Escape a path taken from the diff so it can land in the output safely. */
  export function safePath(path: string): string {
    if (path.length > 200 || !SAFE_PATH_RE.test(path)) return WITHHELD_PATH;
    return path;
  }
