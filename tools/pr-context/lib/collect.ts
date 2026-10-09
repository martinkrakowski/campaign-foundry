import { Project, Node, SyntaxKind } from "ts-morph";
import type { DiffInfo } from "./diff.js";
import { safePath, isCollectable } from "./paths.js";

export interface CollectedBlock {
  readonly tier: number;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol: string;
  readonly why: string;
  readonly text: string;
}

interface BlockCandidate extends CollectedBlock {
  readonly reach: number;
}

interface Decl {
  readonly filePath: string;
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly bodyText: string;
  readonly className: string | null;
  readonly implementsNames: readonly string[];
  readonly kind: "function" | "method" | "arrow";
  readonly isExported: boolean;
}

interface InterfaceInfo {
  readonly name: string;
  readonly isPort: boolean;
  readonly methodNames: Set<string>;
}

const MAX_CALLERS = 6;
const HELPER_REGEX = /(visib|owner|owns|assert|resolve|allowed|scope|tenant|member)/i;

function isPortFile(p: string): boolean {
  return p.endsWith(".port.ts") || p.endsWith(".port.tsx") || p.includes("/ports/");
}

function cutTo120Lines(text: string): string {
  const l = text.split("\n");
  if (l.length <= 120) return text;
  return l.slice(0, 120).join("\n") + "\n// … cut at 120 lines";
}

function cutTo40Lines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 40) return text;
  return lines.slice(0, 40).join("\n") + "\n// … cut at 40 lines for budget";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePath(p: string): string {
  return p.replace(/^\//, "");
}

function makeCallPattern(name: string): RegExp {
  const e = escapeRegex(name);
  return new RegExp(`\\b${e}\\s*\\(|\\.${e}\\s*\\(`);
}

function rangesOverlap(s: number, e: number, hs: number, hc: number): boolean {
  return s <= hs + hc - 1 && e >= hs;
}

function isInsideHunk(path: string, start: number, end: number, diff: DiffInfo): boolean {
  for (const f of diff.files) {
    if (f.path !== path) continue;
    for (const r of f.ranges) {
      if (start >= r.baseStart && end <= r.baseStart + r.baseCount - 1) return true;
    }
  }
  return false;
}

function symbolFor(d: Decl): string {
  return d.className !== null ? `${d.className}.${d.name}` : d.name;
}

function buildProject(sources: Map<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, noResolve: true },
  });
  for (const [path, content] of sources) {
    if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      project.createSourceFile(path, content);
    }
  }
  return project;
}

function collectDecls(project: Project): Decl[] {
  const decls: Decl[] = [];
  for (const file of project.getSourceFiles()) {
    const filePath = normalizePath(file.getFilePath());
    for (const cls of file.getClasses()) {
      const className = cls.getName() ?? null;
      const implementsNames = cls.getImplements().map((i) => i.getText());
      for (const method of cls.getMethods()) {
        const name = method.getName();
        /* istanbul ignore next -- ts-morph always returns a name for class methods */
        if (!name) continue;
        const body = method.getBody();
        if (!body) continue;
        decls.push({
          filePath,
          name,
          startLine: method.getStartLineNumber(),
          endLine: method.getEndLineNumber(),
          text: cutTo120Lines(method.getText()),
          bodyText: body.getText(),
          className,
          implementsNames,
          kind: "method",
          isExported: false,
        });
      }
    }
    for (const fn of file.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      const fnBody = fn.getBody();
      if (!fnBody) continue;
      decls.push({
        filePath,
        name,
        startLine: fn.getStartLineNumber(),
        endLine: fn.getEndLineNumber(),
        text: cutTo120Lines(fn.getText()),
        bodyText: fnBody.getText(),
        className: null,
        implementsNames: [],
        kind: "function",
        isExported: fn.hasModifier(SyntaxKind.ExportKeyword),
      });
    }
    for (const vs of file.getVariableStatements()) {
      const isExported = vs.hasModifier(SyntaxKind.ExportKeyword);
      for (const decl of vs.getDeclarations()) {
        const init = decl.getInitializer();
        if (!init || !Node.isArrowFunction(init)) continue;
        const name = decl.getName();
        /* istanbul ignore next -- VariableDeclarations for arrow constants always have names when the initializer is an ArrowFunction */
        if (!name) continue;
        const arrowBody = init.getBody();
        /* istanbul ignore next -- arrow functions always have a body */
        if (!arrowBody) continue;
        decls.push({
          filePath,
          name,
          startLine: init.getStartLineNumber(),
          endLine: init.getEndLineNumber(),
          text: cutTo120Lines(init.getText()),
          bodyText: arrowBody.getText(),
          className: null,
          implementsNames: [],
          kind: "arrow",
          isExported,
        });
      }
    }
  }
  return decls;
}

function collectInterfaces(project: Project): InterfaceInfo[] {
  const interfaces: InterfaceInfo[] = [];
  for (const file of project.getSourceFiles()) {
    const filePath = normalizePath(file.getFilePath());
    const isPort = isPortFile(filePath);
    for (const iface of file.getInterfaces()) {
      const name = iface.getName();
      /* istanbul ignore next -- interfaces always have a name */
      if (!name) continue;
      const methodNames = new Set(
        iface
          .getMethods()
          .map((m) => m.getName())
          .filter((n): n is string => n !== undefined),
      );
      interfaces.push({ name, isPort, methodNames });
    }
  }
  return interfaces;
}

function buildNameReach(diff: DiffInfo): Map<string, Set<string>> {
  const reach = new Map<string, Set<string>>();
  for (const file of diff.files) {
    for (const name of file.calledNames) {
      if (!reach.has(name)) reach.set(name, new Set());
      reach.get(name)!.add(file.path);
    }
  }
  return reach;
}

function buildTableReach(diff: DiffInfo): Map<string, Set<string>> {
  const reach = new Map<string, Set<string>>();
  for (const file of diff.files) {
    for (const table of file.tableNames) {
      if (!reach.has(table)) reach.set(table, new Set());
      reach.get(table)!.add(file.path);
    }
  }
  return reach;
}

function sortCandidates(blocks: BlockCandidate[]): BlockCandidate[] {
  return [...blocks].sort((a, b) => {
    if (a.reach !== b.reach) return b.reach - a.reach;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.startLine - b.startLine;
  });
}

function acceptBlocks(
  accepted: CollectedBlock[],
  seen: Set<string>,
  blocks: BlockCandidate[],
  diff: DiffInfo,
): void {
  for (const block of blocks) {
    if (isInsideHunk(block.path, block.startLine, block.endLine, diff)) continue;
    const key = `${block.path}:${block.startLine}:${block.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(block);
  }
}

function tier1(
  decls: Decl[],
  interfaces: InterfaceInfo[],
  nameReach: Map<string, Set<string>>,
): BlockCandidate[] {
  const blocks: BlockCandidate[] = [];
  const portIfaces = interfaces.filter((i) => i.isPort);
  for (const [name, files] of nameReach) {
    const reach = files.size;
    const matched = portIfaces.filter((i) => i.methodNames.has(name));
    if (matched.length === 0) continue;
    for (const iface of matched) {
      for (const decl of decls) {
        if (decl.kind !== "method" || decl.className === null) continue;
        if (!decl.implementsNames.includes(iface.name)) continue;
        if (decl.name !== name) continue;
        for (const file of files) {
          blocks.push({
            tier: 1,
            path: decl.filePath,
            startLine: decl.startLine,
            endLine: decl.endLine,
            symbol: `${decl.className}.${name}`,
            why: `implements ${iface.name}.${name}, called from changed lines of ${safePath(file)}`,
            text: decl.text,
            reach,
          });
        }
      }
    }
  }
  return blocks;
}

function tier2(decls: Decl[], nameReach: Map<string, Set<string>>): BlockCandidate[] {
  const blocks: BlockCandidate[] = [];
  for (const [name, files] of nameReach) {
    if (!HELPER_REGEX.test(name)) continue;
    const reach = files.size;
    for (const decl of decls) {
      if (decl.name !== name) continue;
      if (decl.kind === "method") continue;
      if (decl.kind === "arrow" && !decl.isExported) continue;
      for (const file of files) {
        blocks.push({
          tier: 2,
          path: decl.filePath,
          startLine: decl.startLine,
          endLine: decl.endLine,
          symbol: name,
          why: `helper ${name} called from changed lines of ${safePath(file)}`,
          text: decl.text,
          reach,
        });
      }
    }
  }
  return blocks;
}

function findChangedSymbols(decls: Decl[], diff: DiffInfo): Decl[] {
  const changedPaths = new Set(diff.files.map((f) => f.path));
  const changed: Decl[] = [];
  for (const decl of decls) {
    if (!changedPaths.has(decl.filePath)) continue;
    const file = diff.files.find((f) => f.path === decl.filePath);
    /* istanbul ignore next -- changedPaths is built from diff.files, so the file always exists */
    if (!file) continue;
    for (const range of file.ranges) {
      if (rangesOverlap(decl.startLine, decl.endLine, range.baseStart, range.baseCount)) {
        changed.push(decl);
        break;
      }
    }
  }
  return changed;
}

function tier3(
  decls: Decl[],
  changedSymbols: readonly Decl[],
  nameReach: Map<string, Set<string>>,
): BlockCandidate[] {
  const blocks: BlockCandidate[] = [];
  for (const symbol of changedSymbols) {
    const reach = nameReach.get(symbol.name)?.size ?? 0;
    const pattern = makeCallPattern(symbol.name);
    const callers: Decl[] = [];
    for (const decl of decls) {
      if (decl.filePath === symbol.filePath) continue;
      if (pattern.test(decl.bodyText)) callers.push(decl);
    }
    callers.sort((a, b) => {
      const lenDiff = a.bodyText.length - b.bodyText.length;
      if (lenDiff !== 0) return lenDiff;
      const pathDiff = a.filePath.localeCompare(b.filePath);
      if (pathDiff !== 0) return pathDiff;
      return a.startLine - b.startLine;
    });
    for (let i = 0; i < Math.min(callers.length, MAX_CALLERS); i++) {
      const c = callers[i]!;
      blocks.push({
        tier: 3,
        path: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
        symbol: symbolFor(c),
        why: `calls ${symbol.name}, which this change edits in ${safePath(symbol.filePath)}`,
        text: c.text,
        reach,
      });
    }
  }
  return blocks;
}

function tier4(
  decls: Decl[],
  diff: DiffInfo,
  nameReach: Map<string, Set<string>>,
): BlockCandidate[] {
  const blocks: BlockCandidate[] = [];
  for (const file of diff.files) {
    for (const decl of decls) {
      if (decl.filePath !== file.path) continue;
      let overlaps = false;
      for (const range of file.ranges) {
        if (rangesOverlap(decl.startLine, decl.endLine, range.baseStart, range.baseCount)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      for (const table of diff.tableNames) {
        if (decl.bodyText.includes(table)) {
          blocks.push({
            tier: 4,
            path: decl.filePath,
            startLine: decl.startLine,
            endLine: decl.endLine,
            symbol: symbolFor(decl),
            why: `unchanged in ${safePath(file.path)}, also touches table ${table}`,
            text: decl.text,
            reach: nameReach.get(decl.name)?.size ?? 0,
          });
          break;
        }
      }
    }
  }
  return blocks;
}

function tier5(
  decls: Decl[],
  changedSymbols: readonly Decl[],
  interfaces: InterfaceInfo[],
  nameReach: Map<string, Set<string>>,
): BlockCandidate[] {
  const blocks: BlockCandidate[] = [];
  for (const changed of changedSymbols) {
    if (changed.kind !== "method" || changed.className === null) continue;
    const reach = nameReach.get(changed.name)?.size ?? 0;
    for (const implName of changed.implementsNames) {
      const iface = interfaces.find((i) => i.name === implName);
      if (!iface) continue;
      if (!iface.methodNames.has(changed.name)) continue;
      for (const decl of decls) {
        if (decl.kind !== "method" || decl.className === null) continue;
        if (decl.className === changed.className) continue;
        if (!decl.implementsNames.includes(implName)) continue;
        if (decl.name !== changed.name) continue;
        blocks.push({
          tier: 5,
          path: decl.filePath,
          startLine: decl.startLine,
          endLine: decl.endLine,
          symbol: `${decl.className}.${decl.name}`,
          why: `sibling of ${changed.className}.${changed.name} (both implement ${implName})`,
          text: decl.text,
          reach,
        });
      }
    }
  }
  return blocks;
}

function findCreateTable(
  sql: string,
  tableName: string,
): { text: string; startLine: number; endLine: number } | null {
  const escaped = escapeRegex(tableName);
  const pattern = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?"?${escaped}"?\\s*\\(`,
    "i",
  );
  const match = pattern.exec(sql);
  if (match === null || match.index === undefined) return null;
  const start = match.index;
  const end = sql.indexOf(");", start);
  if (end === -1) return null;
  const text = sql.slice(start, end + 2);
  const startLine = sql.slice(0, start).split("\n").length;
  const endLine = sql.slice(0, end + 2).split("\n").length;
  return { text, startLine, endLine };
}

function tier6(
  sources: Map<string, string>,
  diff: DiffInfo,
  tableReach: Map<string, Set<string>>,
): BlockCandidate[] {
  const blocks: BlockCandidate[] = [];
  for (const [path, content] of sources) {
    if (!path.endsWith(".sql")) continue;
    for (const table of diff.tableNames) {
      const stmt = findCreateTable(content, table);
      if (stmt === null) continue;
      blocks.push({
        tier: 6,
        path,
        startLine: stmt.startLine,
        endLine: stmt.endLine,
        symbol: table,
        why: `table ${table} is named in the change`,
        text: cutTo120Lines(stmt.text),
        reach: tableReach.get(table)!.size,
      });
    }
  }
  return blocks;
}

function buildMigrationTables(sources: Map<string, string>): Set<string> {
  const tables = new Set<string>();
  const pattern = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (const [path, content] of sources) {
    if (!path.endsWith(".sql")) continue;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      tables.add(match[1]!.toLowerCase());
    }
  }
  return tables;
}

function distanceToHunk(
  start: number,
  end: number,
  range: { baseStart: number; baseCount: number },
): number {
  const hEnd = range.baseStart + range.baseCount - 1;
  return Math.max(range.baseStart - end, start - hEnd, 0);
}

// Tier 7 ranks second: after tier 1 (port implementations) and before the
// helpers tier (tier 2). Numbered 7 so existing tier numbers and tests
// do not move.
function tier7(decls: Decl[], diff: DiffInfo): BlockCandidate[] {
  const blocks: BlockCandidate[] = [];
  for (const file of diff.files) {
    for (const decl of decls) {
      if (decl.filePath !== file.path) continue;
      let overlaps = false;
      for (const range of file.ranges) {
        if (rangesOverlap(decl.startLine, decl.endLine, range.baseStart, range.baseCount)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      if (decl.kind === "arrow" && !decl.isExported) continue;
      let minDist = Infinity;
      for (const range of file.ranges) {
        minDist = Math.min(minDist, distanceToHunk(decl.startLine, decl.endLine, range));
      }
      blocks.push({
        tier: 7,
        path: decl.filePath,
        startLine: decl.startLine,
        endLine: decl.endLine,
        symbol: symbolFor(decl),
        why: `unchanged in ${safePath(file.path)}, ${minDist} line(s) from a changed hunk`,
        text: decl.text,
        reach: minDist,
      });
    }
  }
  return blocks.sort((a, b) => {
    if (a.reach !== b.reach) return a.reach - b.reach;
    return a.startLine - b.startLine;
  });
}

function isRouteOrWebPath(path: string): boolean {
  return path.startsWith("apps/api/server/routes/") || path.startsWith("apps/web/src/");
}

function getStem(baseName: string): string {
  const dotIndex = baseName.indexOf(".");
  return dotIndex === -1 ? baseName : baseName.slice(0, dotIndex);
}

// Tier 8 ranks last: same-directory siblings of a changed route or component.
function tier8(decls: Decl[], sources: Map<string, string>, diff: DiffInfo): BlockCandidate[] {
  const changedPaths = new Set(diff.files.map((f) => f.path));
  const blocks: BlockCandidate[] = [];
  for (const file of diff.files) {
    if (!isRouteOrWebPath(file.path)) continue;
    const dir = file.path.substring(0, file.path.lastIndexOf("/"));
    const changedStem = getStem(file.path.split("/").pop()!);
    const siblings: string[] = [];
    for (const sibling of sources.keys()) {
      if (!isCollectable(sibling)) continue;
      if (sibling === file.path) continue;
      if (changedPaths.has(sibling)) continue;
      const siblingDir = sibling.substring(0, sibling.lastIndexOf("/"));
      if (siblingDir !== dir) continue;
      siblings.push(sibling);
    }
    siblings.sort((a, b) => {
      const aSame = getStem(a.split("/").pop()!) === changedStem;
      const bSame = getStem(b.split("/").pop()!) === changedStem;
      if (aSame !== bSame) return aSame ? -1 : 1;
      return a.localeCompare(b);
    });
    for (let i = 0; i < Math.min(siblings.length, 6); i++) {
      const siblingPath = siblings[i]!;
      for (const decl of decls) {
        if (decl.filePath !== siblingPath) continue;
        if (decl.kind === "method") continue;
        if (!decl.isExported) continue;
        blocks.push({
          tier: 8,
          path: decl.filePath,
          startLine: decl.startLine,
          endLine: decl.endLine,
          symbol: symbolFor(decl),
          why: `sibling of ${safePath(file.path)} in the same directory`,
          text: cutTo40Lines(decl.text),
          reach: 0,
        });
      }
    }
  }
  return blocks;
}

export function collectBlocks(sources: Map<string, string>, diff: DiffInfo): CollectedBlock[] {
  const project = buildProject(sources);
  const decls = collectDecls(project);
  const interfaces = collectInterfaces(project);
  const nameReach = buildNameReach(diff);
  const tableReach = buildTableReach(diff);
  // Only table names the base migrations actually CREATE TABLE count; a name
  // that appears after "from" in a comment is not a table. N5.
  const migrationTables = buildMigrationTables(sources);
  const validTableNames = new Set(
    [...diff.tableNames].filter((t) => migrationTables.has(t.toLowerCase())),
  );
  const filteredDiff: DiffInfo = { ...diff, tableNames: validTableNames };

  const accepted: CollectedBlock[] = [];
  const seen = new Set<string>();

  const changedSymbols = findChangedSymbols(decls, diff);
  acceptBlocks(accepted, seen, sortCandidates(tier1(decls, interfaces, nameReach)), diff);
  acceptBlocks(accepted, seen, tier7(decls, diff), diff);
  acceptBlocks(accepted, seen, sortCandidates(tier2(decls, nameReach)), diff);
  acceptBlocks(accepted, seen, sortCandidates(tier3(decls, changedSymbols, nameReach)), diff);
  acceptBlocks(accepted, seen, sortCandidates(tier4(decls, filteredDiff, nameReach)), diff);
  acceptBlocks(
    accepted,
    seen,
    sortCandidates(tier5(decls, changedSymbols, interfaces, nameReach)),
    diff,
  );
  acceptBlocks(accepted, seen, sortCandidates(tier6(sources, filteredDiff, tableReach)), diff);
  acceptBlocks(accepted, seen, tier8(decls, sources, diff), diff);

  return accepted;
}
