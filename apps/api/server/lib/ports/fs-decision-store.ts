import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SAFE_ID_PATTERN } from "@campaignfoundry/CampaignOrchestration";
import { hashBytes, isErrno } from "../brief-files.js";
import {
  DecisionConflictError,
  type DecisionMap,
  type DecisionStorePort,
  type StoredDecisions,
} from "./decision-store.port.js";

/** `<root>/decisions/<campaignId>.json`, or null when the id is not one safe segment. */
function decisionsPath(root: string, campaignId: string): string | null {
  if (!SAFE_ID_PATTERN.test(campaignId)) return null;
  return resolve(root, "decisions", `${campaignId}.json`);
}

/** Whether a parsed record is a decision map: an object of complete records. */
function isDecisionMap(value: unknown): value is DecisionMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (record: unknown) =>
      typeof record === "object" &&
      record !== null &&
      ((record as { verdict?: unknown }).verdict === "approved" ||
        (record as { verdict?: unknown }).verdict === "rejected") &&
      typeof (record as { actor?: unknown }).actor === "string" &&
      typeof (record as { at?: unknown }).at === "string" &&
      typeof (record as { run?: unknown }).run === "string",
  );
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

  async readDecisions(campaignId: string): Promise<StoredDecisions> {
    const path = decisionsPath(this.root, campaignId);
    if (!path) return { decisions: {}, revision: null };
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { decisions: {}, revision: null };
      throw error;
    }
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isDecisionMap(parsed)) {
      throw new Error(
        `The decisions recorded for campaign "${campaignId}" are not a decision map.`,
      );
    }
    // A null prototype, so a stored `__proto__` or `toString` key is a key and
    // an absent one is not an inherited member.
    return {
      decisions: Object.assign(Object.create(null) as Record<string, never>, parsed),
      revision: hashBytes(bytes),
    };
  }

  async writeDecisions(
    campaignId: string,
    decisions: DecisionMap,
    expectedRevision?: string | null,
    _fence?: { runId: string },
  ): Promise<string> {
    const path = decisionsPath(this.root, campaignId);
    if (!path) {
      throw new Error(`Decisions campaign id ${JSON.stringify(campaignId)} is not a safe id.`);
    }
    // On files the compare and the write are not one step (D79); the file store's
    // phase runs one API process, and the decision lock serialises it.
    if (expectedRevision !== undefined) {
      const { revision } = await this.readDecisions(campaignId);
      if (revision !== expectedRevision) throw new DecisionConflictError(campaignId, revision);
    }
    await mkdir(resolve(this.root, "decisions"), { recursive: true });
    const tmp = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify(decisions, null, 2)}\n`, "utf8");
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    return hashBytes(bytes);
  }
}
