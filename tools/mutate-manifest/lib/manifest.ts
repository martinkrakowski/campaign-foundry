import type { Manifest, ManifestMutation } from "./types.js";

export class ManifestError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const requireString = (v: unknown, field: string): string => {
  if (typeof v !== "string" || v === "") throw new ManifestError(`${field} must be a non-empty string`);
  return v;
};

function parseMutation(raw: unknown, index: number): ManifestMutation {
  const at = `mutations[${index}]`;
  if (!isRecord(raw)) throw new ManifestError(`${at} must be an object`);
  const command = raw["command"];
  if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== "string")) {
    throw new ManifestError(`${at}.command must be a non-empty array of strings`);
  }
  const verdict = raw["verdict"];
  if (verdict === "survived") {
    throw new ManifestError(
      `${at}.verdict is "survived": a manifest records the mutations a lane's tests CATCH. ` +
        `A surviving mutant is a finding to fix, not a result to ship.`,
    );
  }
  if (verdict !== "caught") throw new ManifestError(`${at}.verdict must be "caught"`);
  const before = requireString(raw["before"], `${at}.before`);
  const after = requireString(raw["after"], `${at}.after`);
  if (before === after) throw new ManifestError(`${at}: before and after are identical — nothing is mutated`);
  return {
    file: requireString(raw["file"], `${at}.file`),
    before,
    after,
    because: requireString(raw["because"], `${at}.because`),
    command: command as readonly string[],
    verdict: "caught",
  };
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // `JSON.parse` throws `SyntaxError` and nothing else, so there is no
    // non-Error arm to guard here — adding one would be an unreachable branch.
    throw new ManifestError(`not valid JSON: ${(error as SyntaxError).message}`);
  }
  if (!isRecord(raw)) throw new ManifestError("manifest must be an object");
  if (raw["version"] !== 1) throw new ManifestError('version must be 1');
  const mutations = raw["mutations"];
  if (!Array.isArray(mutations) || mutations.length === 0) {
    throw new ManifestError("mutations must be a non-empty array — an empty manifest claims nothing");
  }
  return {
    version: 1,
    lane: requireString(raw["lane"], "lane"),
    mutations: mutations.map(parseMutation),
  };
}
