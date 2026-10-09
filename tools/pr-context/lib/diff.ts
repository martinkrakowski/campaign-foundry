/**
 * Parsing a unified `git diff --unified=0` into the facts collect.ts needs:
 *
 *  - per changed path, the base-side line ranges of each hunk (`@@ -a,b ...` )
 *  - the combined text of added and removed lines, fed ONLY into name and table
 *    extraction — never written to the output. N1.
 *
 * The diff text is consumed and discarded: callers receive the extracted called
 * names and table names, never the raw diff body, so no diff line can leak into
 * the rendered file.
 */

/** One hunk's base-side span: lines [baseStart, baseStart + baseCount - 1]. */
export interface HunkRange {
  readonly baseStart: number;
  readonly baseCount: number;
}

/** A changed file and the base-side ranges the diff covers in it. */
export interface ChangedFile {
  readonly path: string;
  readonly ranges: HunkRange[];
  /** Called names extracted from this file's added/removed diff lines. */
  readonly calledNames: Set<string>;
  /** Table names extracted from this file's added/removed diff lines. */
  readonly tableNames: Set<string>;
}

/** What `parseDiff` yields: changed files plus extracted names. */
export interface DiffInfo {
  readonly files: readonly ChangedFile[];
  readonly calledNames: Set<string>;
  readonly tableNames: Set<string>;
}

/** Names that must not be treated as called: JS keywords and test shorthands. */
const KEYWORD_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "await",
  "typeof",
  "new",
  "expect",
  "describe",
  "test",
  "it",
]);

/**
 * Method-call pattern: ``.<name>(`` — captures the method name without the dot.
 * The second pattern (`\b<name>(`) catches bare function calls; both are run and
 * merged, since `.` is a word boundary and `foo.bar(` matches both.
 */
const METHOD_CALL = /\.([A-Za-z_$][\w$]*)\s*\(/g;
const FUNCTION_CALL = /\b([A-Za-z_$][\w$]*)\s*\(/g;

/** SQL keywords that precede a table name, case-insensitive. */
const TABLE_NAME =
  /\b(?:insert\s+into|update|delete\s+from|from|join|create\s+table(?:\s+if\s+not\s+exists)?)\s+"?([a-z_][a-z0-9_]*)"?/gi;

/**
 * Names that look like a *call* — `foo(` or `.foo(` — minus JS keywords and test
 * shorthands. `if (`, `for (`, `return (` etc. are control flow, not calls.
 */
function extractCalledNames(text: string, out: Set<string>): void {
  for (const pattern of [METHOD_CALL, FUNCTION_CALL]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1]!;
      if (!KEYWORD_NAMES.has(name)) {
        out.add(name);
      }
    }
  }
}

/** Table names following SQL keywords, case-insensitive. */
function extractTableNames(text: string, out: Set<string>): void {
  let match: RegExpExecArray | null;
  while ((match = TABLE_NAME.exec(text)) !== null) {
    const name = match[1]!;
    out.add(name);
  }
}

/**
 * Parse a unified diff (as produced by `git diff --unified=0 --no-color
 * --no-ext-diff --no-renames <base> <head>`) into per-file hunk ranges and the
 * called/table names extracted from added and removed lines.
 *
 * The raw body text is never returned — only the derived names — so no diff line
 * can ever reach the rendered file. N1.
 */
export function parseDiff(text: string): DiffInfo {
  const files: ChangedFile[] = [];
  const calledNames = new Set<string>();
  const tableNames = new Set<string>();

  let path: string | null = null;
  let ranges: HunkRange[] = [];
  let fileCalledNames: Set<string> | null = null;
  let fileTableNames: Set<string> | null = null;
  let bodyParts: string[] = [];
  let inHunk = false;

  function flush(): void {
    if (path !== null && fileCalledNames !== null && fileTableNames !== null) {
      extractCalledNames(bodyParts.join("\n"), fileCalledNames);
      extractTableNames(bodyParts.join("\n"), fileTableNames);
      files.push({ path, ranges, calledNames: fileCalledNames, tableNames: fileTableNames });
      // Merge into the global sets so callers that don't need provenance still work.
      for (const name of fileCalledNames) calledNames.add(name);
      for (const name of fileTableNames) tableNames.add(name);
    } else {
      extractCalledNames(bodyParts.join("\n"), calledNames);
      extractTableNames(bodyParts.join("\n"), tableNames);
    }
    bodyParts = [];
    fileCalledNames = null;
    fileTableNames = null;
  }

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      path = null;
      ranges = [];
      fileCalledNames = new Set();
      fileTableNames = new Set();
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match !== null && path !== null) {
        const baseStart = Number.parseInt(match[1]!, 10);
        const baseCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
        ranges.push({ baseStart, baseCount });
      }
      continue;
    }
    if (line.startsWith("--- ") && !inHunk) {
      const p = line.slice(4);
      if (p !== "/dev/null") {
        path = p.replace(/^a\//, "");
      }
      continue;
    }
    if (line.startsWith("+++ ") && !inHunk) {
      const p = line.slice(4);
      if (p !== "/dev/null" && path === null) {
        path = p.replace(/^b\//, "");
      }
      continue;
    }
    if (inHunk && (line.startsWith("-") || line.startsWith("+"))) {
      bodyParts.push(line.slice(1));
    }
  }
  flush();

  return { files, calledNames, tableNames };
}
