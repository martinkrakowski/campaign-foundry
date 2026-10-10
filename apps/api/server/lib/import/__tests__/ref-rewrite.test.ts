import { describe, expect, test } from "vitest";
import { briefBody } from "./fixtures/tree.js";
import { rewriteBriefRefs } from "../ref-rewrite.js";

const LOGO_ID = "44444444-4444-4444-4444-444444444444";
const INPUT_ID = "33333333-3333-3333-3333-333333333333";
const AUDIO_ID = "11111111-1111-1111-1111-111111111111";
const BEAT_ID = "22222222-2222-2222-2222-222222222222";

describe("rewriteBriefRefs", () => {
  test("the map is applied to all four ref fields", () => {
    const brief = briefBody({
      id: "acme",
      products: [
        {
          id: "p1",
          name: "P1",
          primaryColor: "#111111",
          logoPath: "assets/inputs/logo.png",
          inputAsset: "assets/inputs/acme/input.mp3",
        },
      ],
      audio: {
        path: "assets/inputs/acme/music.mp3",
        rights: { licenceId: "l", source: "library" },
      },
      copy: {
        timeline: {
          beats: [{ text: "Go", weight: 1, background: "assets/inputs/acme/bg.png" }],
          transition: "cut",
          keyBeat: 1,
        },
      },
    });

    const refToId = new Map<string, string>([
      ["assets/inputs/logo.png", LOGO_ID],
      ["assets/inputs/acme/input.mp3", INPUT_ID],
      ["assets/inputs/acme/music.mp3", AUDIO_ID],
      ["assets/inputs/acme/bg.png", BEAT_ID],
    ]);

    const rewritten = rewriteBriefRefs(brief, "acme", refToId);
    expect(rewritten.products[0].logoPath).toBe(LOGO_ID);
    expect(rewritten.products[0].inputAsset).toBe(INPUT_ID);
    expect(rewritten.audio?.path).toBe(AUDIO_ID);
    expect(rewritten.copy?.timeline?.beats[0]?.background).toBe(BEAT_ID);
  });

  test("an absent audio field stays absent after the rewrite", () => {
    const brief = briefBody({
      id: "acme",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
      ],
    });
    expect(brief.audio).toBeUndefined();

    const rewritten = rewriteBriefRefs(
      brief,
      "acme",
      new Map([["assets/inputs/logo.png", LOGO_ID]]),
    );
    expect(rewritten.audio).toBeUndefined();
    expect(rewritten.products[0].logoPath).toBe(LOGO_ID);
  });

  test("the ref rewrite throws and createBrief is not called when a path survives", () => {
    const brief = briefBody({
      id: "acme",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/logo.png" },
      ],
    });
    expect(() => rewriteBriefRefs(brief, "acme", new Map())).toThrow("logo.png");
  });
});
