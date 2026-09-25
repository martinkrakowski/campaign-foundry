import type { UsageRecord, UsageStorePort } from "./usage-store.port.js";

/**
 * No metering (`STORE_BACKEND=fs`, PT-7a, D175). Only the Postgres backend can
 * meter and admit any org other than the local operator: `record` drops the
 * row, `countThisMonth` is always 0 and `quota` is always unlimited, so the
 * admission check in `generate.post.ts` never refuses the operator's runs.
 */
export class FsUsageStore implements UsageStorePort {
  async record(_usage: UsageRecord): Promise<void> {
    // Metering exists only on the Postgres backend (D175): the local operator stays unmetered.
  }

  async countThisMonth(_orgId: string, _now: Date): Promise<number> {
    return 0;
  }

  async quota(_orgId: string): Promise<number | null> {
    return null;
  }
}
