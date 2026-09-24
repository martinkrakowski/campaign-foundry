import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { isErrno } from "../brief-files.js";
import type { DecisionMap, DecisionStorePort } from "./decision-store.port.js";

/** `<root>/decisions/<campaignId>.json`, or null when the id is not one safe segment. */
function decisionsPath(root: string, campaignId: string): string | null {
  if (!SAFE_ID_PATTERN.test(campaignId)) return null;
  return resolve(root, "decisions", `${campaignId}.json`);
}

/**
 * Decisions as one JSON file per campaign under the root the composition root
 * built this store with (D167), written with the same unique-temp-then-rename
 * the report store uses, so a reader never parses a torn file.
 */
export class FsDecisionStore implements DecisionStorePort {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async readDecisions(campaignId: string): Promise<DecisionMap> {
    const path = decisionsPath(this.root, campaignId);
    if (!path) return {};
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return {};
      throw error;
    }
    return JSON.parse(text) as DecisionMap;
  }

  async writeDecisions(campaignId: string, decisions: DecisionMap): Promise<void> {
    const path = decisionsPath(this.root, campaignId);
    if (!path) {
      throw new Error(`Decisions campaign id ${JSON.stringify(campaignId)} is not a safe id.`);
    }
    await mkdir(resolve(this.root, "decisions"), { recursive: true });
    const tmp = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(decisions, null, 2)}\n`);
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }
}
