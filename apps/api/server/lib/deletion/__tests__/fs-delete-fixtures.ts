import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
  type CampaignBrief,
} from "@campaignfoundry/CampaignOrchestration";
import { hashBytes, isErrno } from "../../brief-files.js";
import {
  getAssetStore,
  getBriefStore,
  getDecisionStore,
  getDraftStore,
  getJobStore,
  getLastOpenedStore,
  getReportStore,
} from "../../ports/index.js";
import type { TenantContext } from "../../tenant.js";

export const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Raw bytes of {@link PNG_B64}, used as an uploaded asset. */
export const PNG_BYTES: Buffer = Buffer.from(PNG_B64, "base64");

/** The one brief shape `?model=procedural` accepts; `id` is the campaign ref. */
export function sampleBrief(id: string): CampaignBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id,
    targetRegion: "US",
    targetAudience: "developers",
    campaignMessage: "Build faster",
    products: [
      {
        id: "alpha",
        name: "Alpha",
        primaryColor: "#1473E6",
        logoPath: `assets/inputs/${id}/logo.png`,
      },
    ],
  };
}

/** The roots a harness plants a campaign under; passed as a literal by the test. */
export interface Roots {
  readonly projectRoot: string;
  readonly outputRoot: string;
}

/**
 * Plant every fs location the delete library owns for one campaign, through the
 * real store producers (so the tree matches what the library reads back from),
 * plus two render files written by hand: `<output>/<slug>/alpha/1x1/default.png`
 * (the campaign's render tree, item 4) and `packages/<slug>/p1/x.zip` (item 5).
 */
export async function plantCampaign(
  tenant: TenantContext,
  roots: Roots,
  slug: string,
  user: string,
): Promise<void> {
  const brief = await getBriefStore(tenant).createCampaign(slug, {
    name: slug,
    type: "social-post",
  });
  await getBriefStore(tenant).createBrief(sampleBrief(slug));
  await getAssetStore(tenant).writeAsset(slug, "logo.png", PNG_BYTES);
  writeFileSync(
    join(roots.projectRoot, "briefs", slug, "pools.json"),
    JSON.stringify({ briefId: slug }),
  );
  await getDraftStore(tenant).writeDraft(slug, user, { n: 1 }, null);
  await getDecisionStore(tenant).writeDecisions(slug, {
    k: { verdict: "approved", actor: "a", at: "t", run: "r" },
  });
  await getReportStore(tenant).writeReport(slug, "{}");
  const claimed = await getJobStore(tenant).acquireJob(slug);
  if (claimed.acquired) {
    await getJobStore(tenant).failJob(claimed.jobId, "planted");
  }
  await getLastOpenedStore(tenant).write(slug, user);
  mkdirSync(join(roots.outputRoot, slug, "alpha", "1x1"), { recursive: true });
  writeFileSync(join(roots.outputRoot, slug, "alpha", "1x1", "default.png"), PNG_BYTES);
  mkdirSync(join(roots.outputRoot, "packages", slug, "p1"), { recursive: true });
  writeFileSync(join(roots.outputRoot, "packages", slug, "p1", "x.zip"), PNG_BYTES);
  void brief;
}

/**
 * Every path under `dir`, relative to it, mapped to its sha256 (files),
 * `"dir"` (directories) or `"link:<target>"` (symlinks). Walked with `lstat` and
 * `readdir({ withFileTypes })` — never follows a link, so a planted escaping
 * symlink is recorded, not traversed.
 */
export function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      const childAbs = join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        out.set(childRel, `link:${readlinkSync(childAbs)}`);
      } else if (st.isDirectory()) {
        out.set(childRel, "dir");
        walk(childAbs, childRel);
      } else {
        out.set(childRel, hashBytes(readFileSync(childAbs)));
      }
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Every path under `dir`, relative to it, where some SEGMENT is exactly `slug`
 * or some segment's stem (`segment.split(".")[0]`) is exactly `slug`. Exact, never
 * a prefix: `sale-2` is not `sale`.
 */
export function pathsNaming(dir: string, slug: string): string[] {
  const matches: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(abs, entry.name);
      const st = lstatSync(childAbs);
      if (pathNames(childRel, slug)) matches.push(childRel);
      if (st.isDirectory()) walk(childAbs, childRel);
    }
  };
  walk(dir, "");
  return matches;
}

function pathNames(relPath: string, slug: string): boolean {
  return relPath.split("/").some((seg) => seg === slug || seg.split(".")[0] === slug);
}

/** Names of the regular `.json` pointer files in `dir` whose parsed content names `slug`. */
export function pointedAt(dir: string, slug: string): string[] {
  const matches: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const candidate = join(dir, entry.name);
    let parsed: { campaignId?: unknown } | null;
    try {
      parsed = JSON.parse(readFileSync(candidate, "utf8")) as { campaignId?: unknown } | null;
    } catch {
      continue;
    }
    if (parsed?.campaignId === slug) matches.push(entry.name);
  }
  return matches;
}

/** True on Windows or when running as root, where permission tests misbehave. */
export const skipPermissionTests: boolean =
  process.platform === "win32" || process.getuid?.() === 0;
