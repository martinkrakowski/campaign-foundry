import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { isErrno } from "../brief-files.js";
import { blocksImport, classifyRefs } from "./classify.js";
import type { StepContext } from "./steps.js";

/**
 * One entry directly in a live campaign's `assets/inputs/<slug>/` (PT-8e 2): `ok` when
 * it passes the upload rules (D222), with the absolute path to read; `failed` with the
 * rule's reason otherwise. A failed file is listed and never refuses the campaign.
 */
export type OwnInput =
  | {
      readonly name: string;
      readonly ref: string;
      readonly state: "ok";
      readonly path: string;
    }
  | {
      readonly name: string;
      readonly ref: string;
      readonly state: "failed";
      readonly reason: string;
    };

/**
 * Every entry of `assets/inputs/<slug>/`, in name order, checked by `classifyRefs`:
 * the ONE place that decides D222, that refuses a symlink and a non-file, and that
 * never follows a link. Each entry is handed to it as the ref a brief would carry.
 * No folder is no inputs. A folder that cannot be listed throws: the caller refuses
 * the campaign before it writes anything. Read-only.
 */
export function ownInputs(ctx: StepContext, slug: string): OwnInput[] {
  const dir = join(ctx.projectRoot, "assets", "inputs", slug);
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const refs = names.map((name) => `assets/inputs/${slug}/${name}`);
  // A brief with one product per entry, only so that `classifyRefs` walks these refs.
  const brief = { products: refs.map((ref) => ({ logoPath: ref })) } as unknown as CampaignBrief;
  const classified = classifyRefs(ctx, {
    slug,
    sourcePath: "",
    name: null,
    type: null,
    brief,
    refs: [],
    sample: false,
  });
  return names.map((name, index): OwnInput => {
    const found = classified[index]!;
    return blocksImport(found)
      ? { name, ref: found.ref, state: "failed", reason: found.reason }
      : { name, ref: found.ref, state: "ok", path: join(dir, name) };
  });
}

/**
 * Whether normalising would change a stored brief version outside its refs (PT-8e 3).
 * `body` is the stored text; `brief` is what the parser made of it. The normalise
 * stores `JSON.stringify` of that brief with only the refs replaced, so the two must
 * be equal byte for byte here. `undefined` when they are; otherwise the reason, with
 * the position of the first difference. Pure.
 */
export function bodyDrift(body: string, brief: CampaignBrief): string | undefined {
  const again = JSON.stringify(brief);
  if (again === body) return undefined;
  let at = 0;
  while (at < again.length && at < body.length && again[at] === body[at]) at++;
  return (
    `the stored body is not what the import would write back (first difference at character ${at}): ` +
    "normalising would change more than the refs"
  );
}
