import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const stagingPath = (file: string): string =>
  fileURLToPath(new URL(`../../../deploy/staging/${file}`, import.meta.url));
const read = (file: string): string => readFileSync(stagingPath(file), "utf8");
const packageJson = fileURLToPath(new URL("../../../package.json", import.meta.url));

const CRON = "jobs/purge-cronjob.yaml";
const IMAGE = "registry.midnight.lan/library/campaign-foundry:IMAGE_TAG";
/** The settings the sweep takes from the api container, by name. */
const SHARED_ENV = [
  "DATABASE_URL",
  "DATABASE_CA_PATH",
  "OBJECT_STORE",
  "S3_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
];

/** Each `- name: UPPER_CASE` env entry -> its body lines, trimmed and joined (comments and blanks skipped). */
function envBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const head = /^(\s*)- name: ([A-Z][A-Z0-9_]*)$/.exec(line);
    if (!head) return;
    const indent = (head[1] ?? "").length;
    const body: string[] = [];
    for (const next of lines.slice(index + 1)) {
      const trimmed = next.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (next.length - next.trimStart().length <= indent) break;
      body.push(trimmed);
    }
    blocks.set(head[2] ?? "", body.join(" | "));
  });
  return blocks;
}

describe("staging purge sweep", () => {
  test("purge cronjob is the CronJob cf-purge-sweep in the staging namespace", () => {
    expect(read(CRON)).toContain(
      "apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: cf-purge-sweep\n  namespace: campaign-foundry-staging\n",
    );
  });
  test("purge cronjob runs every ten minutes", () => {
    expect(read(CRON)).toContain('\n  schedule: "*/10 * * * *"\n');
  });
  test("purge cronjob forbids concurrent runs", () => {
    expect(read(CRON)).toContain("\n  concurrencyPolicy: Forbid\n");
  });
  test("purge cronjob bounds its start deadline retries and history", () => {
    const text = read(CRON);
    for (const line of [
      "  startingDeadlineSeconds: 300",
      "  successfulJobsHistoryLimit: 1",
      "  failedJobsHistoryLimit: 3",
      "      backoffLimit: 1",
      "      activeDeadlineSeconds: 540",
      "          restartPolicy: Never",
    ]) {
      expect(text).toContain(`\n${line}\n`);
    }
  });
  test("purge cronjob runs the same command as the purge sweep script", () => {
    expect(read(CRON)).toContain(
      '\n              command: ["node", "node_modules/tsx/dist/cli.mjs", "apps/api/bin/purge.ts", "sweep"]\n',
    );
    const script = (
      JSON.parse(readFileSync(packageJson, "utf8")) as { scripts: Record<string, string> }
    ).scripts["purge:sweep"];
    expect(script).toBe("tsx apps/api/bin/purge.ts sweep");
  });
  test("purge cronjob uses the image placeholder that deploy sh substitutes", () => {
    expect(read(CRON)).toContain(`\n              image: ${IMAGE}\n`);
    expect(read("jobs/migrate.yaml")).toContain(`image: ${IMAGE}`);
  });
  test("purge cronjob runs as uid 1000 and never as root", () => {
    const text = read(CRON);
    expect(text).toContain(
      "          securityContext:\n            runAsUser: 1000\n            runAsGroup: 1000\n            runAsNonRoot: true\n",
    );
    expect(text).not.toContain("runAsUser: 0");
    expect(text).not.toContain("privileged");
  });
  test("purge cronjob takes its database and object store settings from the same sources as the api container", () => {
    const cron = envBlocks(read(CRON));
    const app = envBlocks(read("app.yaml"));
    for (const name of SHARED_ENV) {
      expect(app.get(name), `${name} in app.yaml`).toBeDefined();
      expect(cron.get(name), `${name} in the cronjob`).toBe(app.get(name));
    }
  });
  test("purge cronjob carries no secret value", () => {
    for (const [name, body] of envBlocks(read(CRON))) {
      if (!/(SECRET|KEY|PASSWORD|URL)/.test(name)) continue;
      expect(body, name).toMatch(/^valueFrom: | secretKeyRef:/);
      expect(body, name).not.toContain("value: ");
      expect(body, name).not.toContain("optional");
    }
  });
  test("purge cronjob mounts the database CA from the secret the app uses", () => {
    const text = read(CRON);
    expect(text).toContain("secretName: cf-pg-ca");
    expect(text).toContain("mountPath: /etc/campaign-foundry/db");
    expect(read("app.yaml")).toContain("secretName: cf-pg-ca");
  });
  test("kustomization does not list the purge cronjob", () => {
    const text = read("kustomization.yaml");
    expect(text).toContain("  - app.yaml");
    expect(text).not.toContain("purge-cronjob");
    expect(text).not.toMatch(/^\s*- jobs\//m);
  });
  test("deploy sh applies the purge cronjob directly after the rollout", () => {
    const script = read("deploy.sh");
    const apply = script.indexOf(
      'sed "s#IMAGE_TAG#$TAG#" deploy/staging/jobs/purge-cronjob.yaml | remote kubectl apply -f -',
    );
    const rollout = script.indexOf(
      'remote kubectl -n "$NS" rollout status deployment/campaign-foundry',
    );
    const done = script.indexOf('echo "==> https://campaign-foundry.midnight.lan');
    expect(rollout).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(rollout);
    expect(done).toBeGreaterThan(apply);
    expect(
      script.split("\n").filter((l) => l.includes("purge-cronjob") && l.includes("RENDERED")),
    ).toEqual([]);
  });
  test("deploy sh still parses as POSIX sh", () => {
    const result = spawnSync("sh", ["-n", stagingPath("deploy.sh")], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
  test("the run requests topic keeps messages for 24 hours", () => {
    const topic = read("kafka.yaml")
      .split("\n---\n")
      .find((doc) => doc.includes("kind: KafkaTopic") && doc.includes("name: cf.run-requests"));
    expect(topic).toBeDefined();
    expect(topic).toContain("  partitions: 3\n  replicas: 1\n");
    expect(topic).toContain("  config:\n    retention.ms: 86400000\n    segment.ms: 3600000\n");
  });
  test("README names the purge cronjob and the 24 hour retention", () => {
    const readme = read("README.md");
    expect(readme).toContain("### Purge sweep (PT-9q)");
    expect(readme).toContain("cf-purge-sweep");
    expect(readme).toContain("retention.ms: 86400000");
  });
  test("purge cronjob does not set the purge reconcile switch", () => {
    expect(read(CRON)).not.toContain("PURGE_RECONCILE");
  });
});
