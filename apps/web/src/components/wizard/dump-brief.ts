import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";

/** Same key order as the API `dumpBrief` (copied; do not import from apps/api). */
export const BRIEF_KEY_ORDER = [
  "id",
  "targetRegion",
  "targetAudience",
  "campaignMessage",
  "localizedMessage",
  "products",
  "treatments",
  "mode",
  "variation",
  "output",
] as const;

const YAML_BOOL_NULL = /^(?:~|true|false|null|yes|no|on|off)$/i;
const YAML_NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const YAML_DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/;
const YAML_SPECIAL_START = /^[&*!%@`|>{}[\]#\\]/;

/** Quote strings js-yaml would resolve as a non-string (bool/null/number/date/indicator). */
export function quoteYamlScalar(value: string): string {
  const needsQuote =
    value === "" ||
    YAML_BOOL_NULL.test(value) ||
    YAML_NUMBER.test(value) ||
    YAML_DATE.test(value) ||
    YAML_SPECIAL_START.test(value) ||
    value.includes(": ") ||
    value.includes(" #") ||
    !/^[A-Za-z0-9_./-]+$/.test(value);
  return needsQuote ? JSON.stringify(value) : value;
}

function dumpArray(arr: unknown[], indent: number): string {
  const pad = "  ".repeat(indent);
  return arr
    .map((item) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const inner = dumpObject(item as Record<string, unknown>, indent + 1);
        const lines = inner.split("\n");
        const first = lines[0].replace(/^\s+/, "");
        const rest = lines.slice(1).join("\n");
        return `${pad}- ${first}${rest ? `\n${rest}` : ""}`;
      }
      const rendered = formatValue(item, indent + 1).replace(/^\n/, "");
      return `${pad}- ${rendered.trimStart()}`;
    })
    .join("\n");
}

function dumpObject(obj: Record<string, unknown>, indent: number): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    lines.push(`${pad}${key}:${formatValue(value, indent)}`);
  }
  return lines.join("\n");
}

function formatValue(value: unknown, indent: number): string {
  switch (typeof value) {
    case "string":
      return ` ${quoteYamlScalar(value)}`;
    case "number":
    case "boolean":
      return ` ${String(value)}`;
    case "object": {
      if (value === null) return " null";
      if (Array.isArray(value)) {
        if (value.length === 0) return " []";
        return `\n${dumpArray(value, indent + 1)}`;
      }
      const rec = value as Record<string, unknown>;
      const keys = Object.keys(rec).filter((key) => rec[key] !== undefined);
      if (keys.length === 0) return " {}";
      return `\n${dumpObject(rec, indent + 1)}`;
    }
    default:
      return ` ${String(value)}`;
  }
}

function orderedBrief(brief: CampaignBrief): Record<string, unknown> {
  const source = brief as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of BRIEF_KEY_ORDER) {
    if (source[key] !== undefined) ordered[key] = source[key];
  }
  for (const key of Object.keys(source)) {
    if (!(key in ordered) && source[key] !== undefined) ordered[key] = source[key];
  }
  return ordered;
}

/** YAML preview with the API's canonical key order. */
export function dumpBrief(brief: CampaignBrief): string {
  return `${dumpObject(orderedBrief(brief), 0)}\n`;
}
