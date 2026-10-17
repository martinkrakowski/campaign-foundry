import { describe, test, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun as renderWithShell, json } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { CreateCampaignDialog } from "@/components/shell/CreateCampaignDialog";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import * as messages from "@/components/campaign/messages";
import { BriefEditor } from "@/components/campaign/BriefEditor";

/**
 * VT1's host tests (`2026-10-12_motion-sequence-editor.md` §8): the mount gates
 * and the editor-wired gestures, at the editor, through the real rail and the
 * real Copy section — because the claims are about which surface a moving draft
 * gets (VT-D1) and which actions its controls commit (§4.1), and neither is a
 * property of any one component's props.
 *
 * The variant-branch of the motion gate — a selected creative's own `motion`
 * overriding the draft's first-of-axis default — is `previewLook`'s contract,
 * pinned in `preview-props.test.ts`; what this file pins is that both hosts
 * read that one look (`railProps.motion`, published to the narrow host through
 * the playhead) and split on `creativeType` beside it.
 */

/** The map paints hundreds of SVG nodes per mount and has its own suite. */
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, WorldMap: () => <div data-testid="world-map-stub" /> };
});

const renderWithRun = (ui: React.ReactElement) =>
  renderWithShell(
    <CreateCampaignProvider>
      {ui}
      <CreateCampaignDialog />
    </CreateCampaignProvider>,
  );

const BEATS = ["Stay wild", "Stay hydrated"] as const;

/**
 * A Randomized `short-video` brief: creative type `video`, motion-only output,
 * a motion look and two beats — the draft VT-D1 says mounts the sequence
 * timeline on both hosts.
 */
const videoBrief = {
  schemaVersion: 1,
  template: templateFromCanonical("short-video"),
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
  output: { formats: ["motion"], platforms: ["tiktok"] },
};

/** The same brief with a static-only look — the "still brief" of §8. */
const stillBrief = (() => {
  const brief = JSON.parse(JSON.stringify(videoBrief)) as typeof videoBrief & {
    output: { formats: string[]; platforms: string[] };
    variation: { axes: Record<string, unknown> };
  };
  brief.output = { formats: ["static"], platforms: ["linkedin"] };
  delete (brief.variation.axes as Record<string, unknown>).motion;
  return brief;
})();

type Saved = Record<string, unknown>;

const DEFAULT_ASSETS: Record<string, unknown>[] = [
  { name: "dusk.png", size: 2048, type: "image/png" },
];

/** Routes the editor's calls and records every brief a save wrote. */
const routes = (brief: Record<string, unknown>): Saved[] => {
  const saved: Saved[] = [];
  let revision = 1;
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && u === `${API}/campaigns/capabilities`) {
      return Promise.resolve(json({ motion: true }));
    }
    if (u.includes("/campaigns/assets")) {
      return Promise.resolve(json({ assets: DEFAULT_ASSETS }));
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

const atWidth = (px: number) => {
  const original = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
  return () => Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
};

/** Mounts the editor at the brief's own route and waits for the brief to land. */
const open = async (brief: Record<string, unknown>) => {
  const saved = routes(brief);
  renderWithRun(<BriefEditor briefId="clip" />);
  await waitFor(() =>
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"),
  );
  await waitFor(() => expect(document.querySelector('[data-slot="copy-timeline"]')).toBeTruthy());
  return saved;
};

const save = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /^Save$/ }));

const timelines = () =>
  Array.from(document.querySelectorAll("[data-tape-host], [data-sequence-host]"));

const savedTimeline = (brief: Saved | undefined) =>
  (brief?.copy as { timeline?: { beats?: { text: string }[]; keyBeat?: number } } | undefined)
    ?.timeline;

describe("VT1 — the sequence editor's mount gates and wired gestures", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  describe("VT-D1 — who sees which timeline", () => {
    test("wide rail: a video creative mounts the sequence, not the tape, exactly once", async () => {
      const restore = atWidth(1440);
      try {
        await open(videoBrief);
        await waitFor(() => expect(timelines().length).toBeGreaterThan(0));
        expect(timelines()).toHaveLength(1);
        expect(timelines()[0]?.getAttribute("data-sequence-host")).toBe("rail");
        expect(document.querySelector("[data-tape-host]")).toBeNull();
      } finally {
        restore();
      }
    });

    test("narrow: the Copy section hosts the sequence, still exactly one timeline", async () => {
      const restore = atWidth(500);
      try {
        await open(videoBrief);
        await waitFor(() => expect(timelines().length).toBeGreaterThan(0));
        expect(timelines()).toHaveLength(1);
        expect(timelines()[0]?.getAttribute("data-sequence-host")).toBe("section");
        expect(document.querySelector("[data-tape-host]")).toBeNull();
      } finally {
        restore();
      }
    });

    test("an image-text motion look keeps the tape and does not show the sequence", async () => {
      const restore = atWidth(1440);
      try {
        // The default type's brief: image-text, motion look, two beats.
        await open({
          ...videoBrief,
          template: templateFromCanonical("paid-social"),
          output: { formats: ["static", "motion"], platforms: ["linkedin", "tiktok"] },
        });
        await waitFor(() => expect(timelines().length).toBeGreaterThan(0));
        expect(timelines()).toHaveLength(1);
        expect(timelines()[0]?.getAttribute("data-tape-host")).toBe("rail");
        expect(document.querySelector("[data-sequence-host]")).toBeNull();
      } finally {
        restore();
      }
    });

    test("a still brief mounts neither timeline, on either host", async () => {
      // Narrow, which is the permissive width for the section host: if the old
      // rule (playhead + beats) still mounted anything, it mounts here.
      const restore = atWidth(500);
      try {
        await open(stillBrief);
        await waitFor(() =>
          expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"),
        );
        expect(timelines()).toHaveLength(0);
      } finally {
        restore();
      }
    });
  });

  describe("§4.1 — add-track, at the editor", () => {
    test("add video commits a layer with no media field, and the row spans the whole duration", async () => {
      const user = userEvent.setup();
      const restore = atWidth(1440);
      try {
        const saved = await open(videoBrief);
        expect(document.querySelectorAll('[data-sequence-clip="video"]')).toHaveLength(1);

        await user.click(screen.getByRole("button", { name: messages.sequenceAddVideoTrack }));
        await waitFor(() =>
          expect(document.querySelectorAll('[data-sequence-clip="video"]')).toHaveLength(2),
        );

        await save(user);
        await waitFor(() => expect(saved).toHaveLength(1));
        const layers = (saved[0]?.template as { layers: Record<string, unknown>[] }).layers;
        const added = layers.find((l) => l.id === "video-2");
        // VT-D2: `{ id, kind }` and nothing else — no span, no media ref, no
        // seconds. The new row paints the shared background.
        expect(added).toEqual({ id: "video-2", kind: "video" });
        // And the row it drew is full-duration (pxPerSec is the fit floor in
        // happy-dom: 6 s at 28 px/s).
        const clips = document.querySelectorAll('[data-sequence-clip="video"]');
        expect((clips[1] as HTMLElement).style.width).toBe("168px");
      } finally {
        restore();
      }
    });

    test("add text stays disabled: the one animated-text layer already exists", async () => {
      const user = userEvent.setup();
      const restore = atWidth(1440);
      try {
        const saved = await open(videoBrief);
        const control = screen.getByRole("button", {
          name: messages.sequenceAddTextTrack,
        }) as HTMLButtonElement;
        expect(control.disabled).toBe(true);
        expect(screen.getAllByText(messages.sequenceAddTextBlocked).length).toBeGreaterThan(0);

        // A click on a disabled control commits nothing; the proof is the file.
        await save(user);
        await waitFor(() => expect(saved).toHaveLength(1));
        const layers = (saved[0]?.template as { layers: { kind: string }[] }).layers;
        expect(layers.filter((l) => l.kind === "animated-text")).toHaveLength(1);
      } finally {
        restore();
      }
    });
  });

  describe("§4.1 — the text clip's drag, against the saved brief", () => {
    test("a reorder commits once on release, and the poster keeps naming the same text", async () => {
      const user = userEvent.setup();
      const restore = atWidth(1440);
      try {
        const saved = await open(videoBrief);

        const clip = screen.getByRole("button", {
          name: messages.sequenceBeatClip(1, 0, 3),
        });
        fireEvent.pointerDown(clip, { clientX: 28 });
        // The move must not commit: nothing but the view follows the finger.
        fireEvent.pointerMove(clip, { clientX: 84 });
        expect(savedTimeline(saved[0])).toBeUndefined();
        fireEvent.pointerMove(clip, { clientX: 28 * 4.5 });
        fireEvent.pointerUp(clip);

        await save(user);
        await waitFor(() => expect(saved).toHaveLength(1));
        const timeline = savedTimeline(saved[0]);
        expect(timeline?.beats?.map((b) => b.text)).toEqual([...BEATS].reverse());
        // §8: the persisted poster still names the beat it named — "Stay wild"
        // was beat 1 and is beat 2 now, and `keyBeat` followed it.
        expect(timeline?.keyBeat).toBe(2);
        expect(timeline?.beats?.[1]?.text).toBe("Stay wild");
      } finally {
        restore();
      }
    });
  });

  describe("TL3 — the boundary's drag, against the saved brief", () => {
    test("releasing a boundary handle writes two integer weights, the sum intact", async () => {
      const user = userEvent.setup();
      const restore = atWidth(1440);
      try {
        // Weights of 1 leave the handle no room: the pair's own transfer range
        // is [1, pair-1], so this drag needs a join with slack on both sides.
        const saved = await open({
          ...videoBrief,
          copy: {
            timeline: {
              beats: [
                { text: "Stay wild", weight: 2 },
                { text: "Stay hydrated", weight: 4 },
              ],
              transition: "cut",
              keyBeat: 1,
            },
          },
        });

        // The same gesture the tape test commits: the change paints, the
        // release writes. 4 s of the 6 s pair is weight 4 left, 2 right.
        const boundary = screen.getByRole("slider", {
          name: messages.tapeBeatBoundaryName(1),
        });
        fireEvent.change(boundary, { target: { value: "4" } });
        fireEvent.pointerUp(boundary);

        await save(user);
        await waitFor(() => expect(saved).toHaveLength(1));
        const beats = savedTimeline(saved[0])?.beats as
          | { text: string; weight: number }[]
          | undefined;
        expect(beats?.map((b) => b.weight)).toEqual([4, 2]);
        // The domain stores weights, not seconds: a neighbour transfer moves
        // whole units, so both stay integers and the pair keeps its sum.
        for (const beat of beats ?? []) expect(Number.isInteger(beat.weight)).toBe(true);
        expect((beats ?? []).reduce((sum, beat) => sum + beat.weight, 0)).toBe(6);
      } finally {
        restore();
      }
    });
  });

  describe("TL6 / VT-D8 — the picked layer's diamond, against the saved brief", () => {
    /** The canonical video template, with one pose-clock key on the video layer. */
    const trackedTemplate = () => {
      const base = templateFromCanonical("short-video");
      return {
        ...base,
        layers: base.layers.map((layer) =>
          layer.kind === "video"
            ? {
                ...layer,
                tracks: [{ property: "opacity", stops: [{ t: 0.5, value: 1, clock: "pose" }] }],
              }
            : layer,
        ),
      };
    };

    test("dragging a key on the picked video layer writes the stop's t", async () => {
      const user = userEvent.setup();
      const restore = atWidth(1440);
      try {
        const saved = await open({ ...videoBrief, template: trackedTemplate() });

        // The pick the diamonds ride on (CC3): the video row itself is the
        // pick control on the sequence host.
        await user.click(screen.getByRole("button", { name: messages.sequenceVideoClip(1, 6) }));
        const key = await screen.findByRole("slider", {
          name: messages.tapeDiamondName(messages.TRACK_PROPERTY_LABEL.opacity, 0),
        });
        // The slider's value is seconds: 1.5 s of the 6 s clock is t 0.25.
        fireEvent.change(key, { target: { value: "1.5" } });
        fireEvent.pointerUp(key);

        await save(user);
        await waitFor(() => expect(saved).toHaveLength(1));
        const layers = (
          saved[0]?.template as {
            layers: { id: string; tracks?: { stops: { t: number }[] }[] }[];
          }
        ).layers;
        expect(layers.find((l) => l.id === "video")?.tracks?.[0]?.stops?.[0]?.t).toBe(0.25);
      } finally {
        restore();
      }
    });
  });

  describe("VT-D7 — hide, against the saved brief", () => {
    test("hiding a video row writes enabled:false, stays on the timeline, and comes back", async () => {
      const user = userEvent.setup();
      const restore = atWidth(1440);
      try {
        const saved = await open(videoBrief);

        // One video layer is the last enabled required one: no hide control.
        expect(
          screen.queryByRole("button", { name: messages.sequenceHideVideoTrack(1) }),
        ).toBeNull();

        await user.click(screen.getByRole("button", { name: messages.sequenceAddVideoTrack }));
        await waitFor(() =>
          expect(document.querySelectorAll('[data-sequence-clip="video"]')).toHaveLength(2),
        );

        await user.click(screen.getByRole("button", { name: messages.sequenceHideVideoTrack(1) }));
        await save(user);
        await waitFor(() => expect(saved).toHaveLength(1));
        const layers = (saved[0]?.template as { layers: { id: string; enabled?: boolean }[] })
          .layers;
        expect(layers.find((l) => l.id === "video")?.enabled).toBe(false);

        // The disabled row is still on the timeline, offering its way back.
        const show = await screen.findByRole("button", {
          name: messages.sequenceShowVideoTrack(1),
        });
        await user.click(show);
        await save(user);
        await waitFor(() => expect(saved).toHaveLength(2));
        const restored = (saved[1]?.template as { layers: { id: string; enabled?: boolean }[] })
          .layers;
        expect(restored.find((l) => l.id === "video")?.enabled).toBeUndefined();
      } finally {
        restore();
      }
    });
  });
});
