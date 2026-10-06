import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { SAFE_ID_PATTERN, isReservedCampaignId } from "@campaignfoundry/CampaignOrchestration";
import { isErrno, withBriefLock } from "../brief-files.js";
import { resolveConfined } from "../confined-path.js";
import { withDecisionLock } from "../decisions.js";
import { RESERVED_OUTPUT_ROOT_NAMES } from "../import/census.js";
import { withPoolLock } from "../pools.js";
import { getBriefStore, getJobStore } from "../ports/index.js";
import { scopeRoots } from "../run-environment.js";
import { LOCAL_TENANT, type TenantContext } from "../tenant.js";

/** A storage path of the campaign passes through a symlink; thrown BEFORE anything is removed. */
export class UnsafeCampaignPathError extends Error {
  constructor(slug: string) {
    super(`Campaign "${slug}" has a symlinked storage path; nothing was deleted.`);
    this.name = "UnsafeCampaignPathError";
  }
}

export type FsDeleteOutcome =
  | { readonly outcome: "deleted" }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "active-job"; readonly jobId: string };

/** One location: `segments` below `root`. The ONLY way a path is made from a slug is `pathOf`. */
interface Target {
  readonly root: string;
  readonly segments: readonly string[];
}

interface Plan {
  readonly jobIds: readonly string[];
  /** Everything that is NOT what the campaign is resolved by. Removed first. */
  readonly data: readonly Target[];
  /** The brief file(s), then `briefs/<slug>/`: what `campaignMeta` resolves by. Removed LAST. */
  readonly markers: readonly Target[];
}

const at = (root: string, ...segments: string[]): Target => ({ root, segments });
const pathOf = (target: Target): string => resolveConfined(target.root, ...target.segments);

/** A top-level name under `<output>/` that is a shared store area, never one campaign's tree. */
function isSharedOutputName(slug: string): boolean {
  return (
    isReservedCampaignId(slug) || (RESERVED_OUTPUT_ROOT_NAMES as readonly string[]).includes(slug)
  );
}

/**
 * Refuse a symlink at ANY component of the target below its root (the root itself is the
 * trusted anchor `scopeRoots` handed out). `lstat` never follows the final component, and
 * checking every component from the root down is what stops `briefs/sale -> briefs/sale-2`
 * (inside the root, still another campaign's tree), `-> /etc`, and a symlinked `briefs`
 * directory itself (`briefs` is a WALKED component, never the root of a walk). A component
 * that does not exist ends the walk: nothing deeper can exist.
 */
async function assertNoSymlinkOnPath(target: Target, slug: string): Promise<void> {
  for (let depth = 1; depth <= target.segments.length; depth += 1) {
    let st;
    try {
      st = await lstat(resolveConfined(target.root, ...target.segments.slice(0, depth)));
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    if (st.isSymbolicLink()) throw new UnsafeCampaignPathError(slug);
  }
}

/** True when the pointer file at `path` names `slug` in its CONTENT. Exact, never a prefix. */
async function pointsAt(path: string, slug: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { campaignId?: unknown } | null;
    return parsed?.campaignId === slug;
  } catch {
    return false;
  }
}

/** The pointer file NAMES (`<userId>.json`) whose content names `slug`. */
async function pointerFilesFor(dir: string, slug: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    // `isFile()` is false for a symlink and a directory: a link is never read through.
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (await pointsAt(resolveConfined(dir, entry.name), slug)) names.push(entry.name);
  }
  return names;
}

async function planDelete(tenant: TenantContext, slug: string): Promise<Plan> {
  const { projectRoot, outputRoot } = scopeRoots(tenant);
  const data: Target[] = [
    at(outputRoot, "decisions", `${slug}.json`),
    at(outputRoot, "reports", `${slug}.json`),
    at(outputRoot, "packages", slug),
    at(projectRoot, "assets", "inputs", slug),
  ];
  if (!isSharedOutputName(slug)) data.push(at(outputRoot, slug));

  // Directories that are READ or unlinked-through below are checked first: `readdir` and
  // `unlink` follow a link in a parent component.
  const pointerDir = at(projectRoot, "state", "last-opened");
  await assertNoSymlinkOnPath(pointerDir, slug);
  await assertNoSymlinkOnPath(at(outputRoot, "jobs"), slug);
  for (const file of await pointerFilesFor(pathOf(pointerDir), slug)) {
    data.push(at(projectRoot, "state", "last-opened", file));
  }

  // Brief files: every file whose PARSED id is exactly the slug, plus the canonical
  // `<slug>.yaml|.yml|.json` when it is unparseable (so the slug is released) - but never a
  // canonical-named file that declares ANOTHER campaign's id.
  const store = getBriefStore(tenant);
  const listed = await store.listBriefs();
  const declared = new Map(listed.map((brief) => [brief.file, brief.campaignId]));
  const files = new Set(
    listed.filter((brief) => brief.campaignId === slug).map((brief) => brief.file),
  );
  const canonical = await store.findBriefFile(slug);
  if (canonical !== undefined && (declared.get(canonical) ?? slug) === slug) files.add(canonical);
  // `briefs` is a component of every marker path, so the preflight walks it. Files first,
  // the directory LAST (decision 4).
  const markers = [
    ...[...files].map((file) => at(projectRoot, "briefs", file)),
    at(projectRoot, "briefs", slug),
  ];

  const jobIds = (await getJobStore(tenant).listJobs())
    .filter((job) => job.campaignId === slug)
    .map((job) => job.id);
  return { jobIds, data, markers };
}

async function removeTargets(targets: readonly Target[]): Promise<void> {
  // `rm` on a symlink removes the link, never its target; the preflight already refused any.
  for (const target of targets) await rm(pathOf(target), { recursive: true, force: true });
}

async function deleteLocked(tenant: TenantContext, slug: string): Promise<FsDeleteOutcome> {
  if ((await getBriefStore(tenant).campaignMeta(slug)) === undefined) {
    return { outcome: "not-found" };
  }
  const jobs = getJobStore(tenant);
  const jobId = await jobs.getRunningJobId(slug);
  if (jobId !== undefined) return { outcome: "active-job", jobId };

  const plan = await planDelete(tenant, slug);
  // The targets' ROOTS are the org-scoped roots `scopeRoots` handed out, and
  // `assertNoSymlinkOnPath` walks below a root, not the root itself — so a symlinked
  // `orgs/<orgId>` (the whole non-local tenant tree) is otherwise invisible, and a
  // `orgs/<orgId> -> ..` link would make every confined removal resolve back into the
  // local tree. Refuse it first, on the LOCAL roots where `orgs/<orgId>` is a real
  // child of the trusted anchor.
  if (tenant.orgId !== LOCAL_TENANT.orgId) {
    const localRoots = scopeRoots(LOCAL_TENANT);
    await assertNoSymlinkOnPath(at(localRoots.projectRoot, "orgs", tenant.orgId), slug);
    await assertNoSymlinkOnPath(at(localRoots.outputRoot, "orgs", tenant.orgId), slug);
  }
  for (const target of [...plan.data, ...plan.markers]) {
    await assertNoSymlinkOnPath(target, slug);
  }
  // Nothing has been removed yet. From here a failure leaves the markers in place, so the
  // campaign still resolves and a retry completes the delete.
  for (const id of plan.jobIds) await jobs.deleteJob(id);
  await removeTargets(plan.data);
  await removeTargets(plan.markers);
  return { outcome: "deleted" };
}

/**
 * Remove every filesystem location that holds data for ONE campaign (fs backend).
 *
 * This is the file-store half of PT-9n: `deleteCampaignOnFileStore` deletes one
 * campaign under the store's locks and nothing else. It is NOT wired to any route
 * (PT-9n2 hangs `DELETE /campaigns/:id`'s fs branch off it); the route still
 * answers 501 until then.
 *
 * The nine locations planted for a campaign, with their removal rules:
 *   1. `briefs/<slug>/` (campaign.json, pools.json, drafts/<user>.json, *.tmp) — whole directory, symlink-refused, removed LAST of all as the marker.
 *   2. brief version file(s) `briefs/<file>` whose parsed id === slug (legacy `.yml`/`.json` too) — unlinked from this module before the directory; before the directory so a crash that takes the directory leaves a resolvable campaign.
 *   3. `assets/inputs/<slug>/` — whole tree.
 *   4. `<output>/<slug>/` (renders, proofs) — whole tree, EXCEPT a shared output name (decision 5).
 *   5. `packages/<slug>/` — whole tree.
 *   6. `reports/<slug>.json` — one file.
 *   7. `decisions/<slug>.json` — one file.
 *   8. `jobs/<jobId>.json` for every settled job whose `campaignId` === slug — via `deleteJob`.
 *   9. `state/last-opened/<user>.json` whose CONTENT names the slug — exact match, never a prefix.
 *
 * Order is data first, then the brief file(s), then `briefs/<slug>/` LAST.
 * `campaignMeta` resolves through the markers, so any failure before the last
 * removal leaves the campaign resolvable and a second call completes it
 * (idempotent, no orphans). Nothing is removed before the symlink preflight
 * passes, and every path is built through `resolveConfined` from the trusted
 * `scopeRoots` anchor — never by concatenating a slug.
 *
 * Residual races left open for a follow-up lane (decision 7): `generate.post`
 * checks `campaignMeta` with no lock and then enqueues a run; a request that
 * passed before the delete can enqueue after it and write renders/reports/jobs
 * for the deleted campaign, which a re-created campaign of the same slug
 * inherits (the C1 hazard). `assets.post` (no lock) and `decisions.put`/
 * `pools/*`/`last-opened.put` that passed their own check before the delete can
 * each re-create one file after it. This lane serialises a single operator on a
 * single process under brief -> pool -> decision -> job locks; the PR body
 * notes that explicitly.
 */
export async function deleteCampaignOnFileStore(
  tenant: TenantContext,
  slug: string,
): Promise<FsDeleteOutcome> {
  if (!SAFE_ID_PATTERN.test(slug)) {
    throw new Error(`Campaign id ${JSON.stringify(slug)} is not a safe id.`);
  }
  return withBriefLock(tenant, slug, () =>
    withPoolLock(tenant, slug, () =>
      withDecisionLock(tenant, slug, () =>
        getJobStore(tenant).withJobLock(slug, () => deleteLocked(tenant, slug)),
      ),
    ),
  );
}
