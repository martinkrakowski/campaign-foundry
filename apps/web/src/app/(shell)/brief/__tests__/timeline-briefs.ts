import { vi } from "vitest";
import { json } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";

/** The two beats the brief fixtures carry, shared so the two suites cannot drift. */
export const BEATS = ["Stay wild", "Stay hydrated"] as const;

/** The parts of a sequenced brief that differ between the two editor suites. */
export interface TimelineBriefShape {
  /** The canonical template the brief carries (video, or the default type). */
  readonly template: ReturnType<typeof templateFromCanonical>;
  /** The brief's output: which formats and platforms it ships. */
  readonly output: {
    readonly formats: readonly string[];
    readonly platforms: readonly string[];
  };
}

/**
 * The Randomized brief both editor suites load: creative type from the given
 * template, two beats, a motion look. Everything the two files copied — the
 * id, region, audience, products, copy and variation — lives here; the
 * template and output are the only parts that differ, so they are the
 * parameters.
 */
export const makeBrief = ({ template, output }: TimelineBriefShape) => ({
  schemaVersion: 1,
  template,
  id: "clip",
  mode: "variation",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
  copy: {
    timeline: {
      beats: BEATS.map((text) => ({ text, weight: 1 })),
      transition: "cut",
      keyBeat: 1,
    },
  },
  variation: {
    count: 4,
    axes: {
      layout: ["headline-bottom"],
      tone: ["bold"],
      background: { source: ["procedural"] },
      motion: ["ken-burns-in"],
      duration: [6],
    },
  },
  output,
});

export type Saved = Record<string, unknown>;

/** The bin's default listing: one asset with no id (the filesystem backend's shape). */
export const DEFAULT_ASSETS: Record<string, unknown>[] = [
  { name: "dusk.png", size: 2048, type: "image/png" },
];

/**
 * Routes the editor's calls and records every brief a save wrote. Shared by the
 * two editor suites; `assets` overrides the default listing for tests that need
 * a specific entry (e.g. one carrying an id).
 */
export const routes = (
  brief: Record<string, unknown>,
  assets?: Record<string, unknown>[],
): Saved[] => {
  const saved: Saved[] = [];
  let revision = 1;
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && u === `${API}/campaigns/capabilities`) {
      return Promise.resolve(json({ motion: true }));
    }
    if (u.includes("/campaigns/assets")) {
      return Promise.resolve(json({ assets: assets ?? DEFAULT_ASSETS }));
    }
    if (method === "GET" && u.startsWith(`${API}/campaigns/briefs`)) {
      return Promise.resolve(
        json({ briefs: [{ file: "clip.yaml", revision: `r${revision}`, brief }] }),
      );
    }
    if (method === "PUT" && u.includes("/campaigns/briefs/")) {
      const body = JSON.parse(String(init?.body)) as Saved;
      saved.push(body);
      revision += 1;
      return Promise.resolve(json({ file: "clip.yaml", revision: `r${revision}`, brief: body }));
    }
    return Promise.resolve(json({}, 200));
  });
  return saved;
};
