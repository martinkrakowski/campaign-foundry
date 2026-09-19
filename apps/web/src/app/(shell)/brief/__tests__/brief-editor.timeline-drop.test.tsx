import { describe, test, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun as renderWithShell, json } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { CreateCampaignDialog } from "@/components/shell/CreateCampaignDialog";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { HEADLINE_POOL_REF } from "@/components/campaign/editor-state";
import * as messages from "@/components/campaign/messages";
import { BriefEditor } from "@/components/campaign/BriefEditor";

/**
 * SG6′ — the copy sequence the projection will not write, said out loud
 * (`2026-09-18_projection-drop-measurement.md` §3.1, §3.2, finding H1).
 *
 * The defect these tests pin is not a rendering one. `CopySection` shows the
 * sequence panel on `mode === "variation"` alone; `toBrief` writes `copy.timeline`
 * only when `canSerializeTimeline(state)` holds too — Video selected, and the
 * headline pool off. An operator could author a sequence, watch `validate.ts`
 * check its weights, press Save, and find the block absent. Nothing said so.
 *
 * Three things follow from that, and they decide how this file is written.
 *
 * **It runs at the editor, through the controls.** The claim is about what an
 * operator sees and does, and neither control is in the panel that loses the work:
 * Video is a card in Output, the pool is a switch in Variation Policy. Dispatching
 * `toggleFormat` directly would prove the component's props, not the route.
 *
 * **Every assertion about the notice is made in the same breath as an assertion
 * about the SAVED BRIEF.** The plan's definition of done is explicit that the test
 * asserts against the projection rather than against the string, so the notice
 * cannot drift from what it reports. The PUT body below IS `toBrief(state)` —
 * `handleSave` passes it to `updateBrief` unchanged — so "the notice is showing"
 * and "`copy` is absent from the file" are checked against one another, not
 * separately.
 *
 * **The absence half is a test, not an afterthought.** A notice that is always on
 * is not a notice: a saveable draft must show nothing, and so must a draft that
 * has no beats to lose.
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
 * A Randomized brief that saves its sequence: Video on, no headline pool, two
 * beats. Every route below starts here, because the interesting transitions are
 * *out* of the serialisable state — §3.2's row in particular is the one where the
 * beats were already reaching the file and a switch in another section withdrew
 * them.
 *
 * Two things in it are chosen rather than typical, and both are about keeping the
 * draft VALID on either side of the gesture — Save refuses an invalid draft, and a
 * refused Save would make red fault 3's "it still saves" untestable.
 *
 * `motion` and `duration` carry values (`validateMotion` requires both while Video
 * is selected), and `minDistance` is left out: turning Video off drops two axes
 * from `maxMinDistance`'s ceiling, so a draft sitting near it would fail on the
 * very gesture these tests make, for a reason that has nothing to do with beats.
 *
 * The platform pair is the other one. No profile ships both formats
 * (`PlatformProfile.vo.ts` — the three social platforms are still-only, the four
 * clip platforms are motion-only), and `validateOutput` refuses BOTH directions: a
 * platform with nothing to ship, and a format nothing ships. So a Randomized draft
 * carrying Video needs a clip platform beside its still one, and the honest way to
 * reach §3.1's state — `formats: ["static"]`, with the panel still on screen — is
 * to take the clip platform away and let `togglePlatform` re-derive the formats.
 */
const sequencedBrief = {
  schemaVersion: 1,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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
  output: { formats: ["static", "motion"], platforms: ["linkedin", "tiktok"] },
};

/** A brief with the same shape and no sequence at all — the `beats.length` conjunct. */
const unsequencedBrief = (() => {
  const { copy: _copy, ...rest } = sequencedBrief;
  return rest;
})();

type Saved = Record<string, unknown>;

/**
 * Routes the editor's calls and records every brief a save wrote.
 *
 * The PUT handler echoes the body back as the stored entry, which is what the real
 * route does — so the editor adopts exactly what it sent and a second save in the
 * same test starts from the state the first one left.
 */
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
      return Promise.resolve(
        json({ assets: [{ name: "dusk.png", size: 2048, type: "image/png" }] }),
      );
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

/** The Video card in Output. `AxisCard` names itself by the axis value it toggles. */
const videoCard = () => screen.getByRole("button", { name: "motion" }) as HTMLButtonElement;

/**
 * The draft's one clip platform, in Output.
 *
 * Removing it is how an operator reaches §3.1's state with a draft that still
 * saves: `togglePlatform` re-derives `formats` from the remaining platforms while
 * `formatsOverridden` is false (it is — the loaded formats are exactly what the
 * loaded platforms derive), so Video goes off as a consequence and nothing else
 * in Output is left contradicting itself. Pressing the Video card alone reaches
 * the same `formats` and leaves `tiktok` with nothing to ship, which Output
 * reports as a field error and Save then refuses — a true refusal, but not this
 * lane's subject. The card's own route is asserted at the end of the test, where
 * the notice is all that is being claimed.
 */
const clipPlatform = () => screen.getByRole("button", { name: "tiktok" }) as HTMLButtonElement;

/** The Variation Policy panel, published to the sidebar rather than this column. */
const policyPanel = () => document.querySelector('[data-section="policy"]') as HTMLElement;

/**
 * Opens the policy panel's *Advanced* disclosure, which is where the headline-pool
 * switch lives (D6 puts it behind one door, closed on first render). Clicked rather
 * than pre-seeded into `cf:disclosure:policy-advanced`, because the route matters:
 * the operator who withdraws their own sequence does it from here.
 */
const openAdvanced = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(within(policyPanel()).getByRole("button", { name: "Advanced" }));
};

/** The headline-pool switch in Variation Policy (`SwitchRow`, labelled by the ref). */
const poolSwitch = () => screen.getByRole("switch", { name: HEADLINE_POOL_REF });

const notice = () =>
  screen.queryByText(messages.timelineDroppedNoVideo) ??
  screen.queryByText(messages.timelineDroppedHeadlinePool);

const save = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /^Save$/ }));

/** Mounts the editor at the brief's own route and waits for the brief to land. */
const open = async (brief: Record<string, unknown>) => {
  const saved = routes(brief);
  renderWithRun(<BriefEditor briefId="clip" />);
  await waitFor(() =>
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"),
  );
  // The panel is on screen with the authored beats in it — every assertion below is
  // about a sequence the operator can see, not about a state object.
  await waitFor(() => expect(document.querySelector('[data-slot="copy-timeline"]')).toBeTruthy());
  // The sidebar's Variation Policy panel is published in an effect, one flush behind
  // the adopted brief — and it renders only in Randomized, so waiting for it is
  // waiting for the whole adoption to settle. Pressing Save before it does would test
  // the pre-adoption draft, which is a green assertion about the wrong document.
  await waitFor(() => expect(policyPanel()).toBeTruthy());
  return saved;
};

const copyBlock = (brief: Saved | undefined) =>
  brief?.copy as { timeline?: { beats?: { text: string }[] } } | undefined;

const beatTexts = (brief: Saved | undefined): unknown =>
  copyBlock(brief)?.timeline?.beats?.map((b) => b.text);

describe("SG6′ — the copy sequence says when it will not be saved", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  /**
   * §3.1 — R1, the strongest row: Video off in a Randomized draft.
   *
   * The whole cycle in one test, because each half is what makes the other mean
   * something. The draft starts saveable and silent; the Output card makes it
   * lossy and the panel says so *and names Output*; the save that follows proves
   * the sentence true by writing a brief with no `copy`; and turning the card back
   * on restores both the silence and the beats — which is the claim the sentence
   * makes when it says "not saved" rather than "lost", and the one red fault this
   * lane was told to stop on if it failed.
   */
  test("turning Video off names Output, and the brief that saves has no sequence", async () => {
    const user = userEvent.setup();
    const saved = await open(sequencedBrief);

    // Red fault 2, the false-positive half: a draft whose beats WILL be saved is silent.
    expect(notice()).toBeNull();
    await save(user);
    await waitFor(() => expect(saved.length).toBe(1));
    expect(beatTexts(saved[0])).toEqual([...BEATS]);

    await user.click(clipPlatform());

    const line = await screen.findByText(messages.timelineDroppedNoVideo);
    // This IS §3.1's state and not something adjacent: Video is off.
    await waitFor(() => expect(videoCard().getAttribute("aria-pressed")).toBe("false"));
    // Red fault 3: a status, never an error. The value is fine — it did not reach
    // the document — so nothing about this may read as a refusal.
    expect(line.getAttribute("role")).toBe("status");
    // The OTHER sentence is absent: the panel names the condition that is actually
    // unmet, so an operator sent to Variation Policy would be sent to the wrong one.
    expect(screen.queryByText(messages.timelineDroppedHeadlinePool)).toBeNull();

    // The notice is checked against the projection it reports, in one moment: the
    // draft still saves (red fault 3's other half) and the file has no sequence.
    await save(user);
    await waitFor(() => expect(saved.length).toBe(2));
    expect(beatTexts(saved[1])).toBeUndefined();
    // §3.1 step 4 says `toBrief(state).copy` is undefined, and that is true of a
    // sequence AUTHORED in the session (the last test here shows it). This brief
    // LOADED one, so `copyExplicit` holds and D11's exemption preserves the
    // declared-but-now-empty `copy: {}` the file wrote. The block survives; the
    // beats do not, which is the loss the notice is about.
    expect(copyBlock(saved[1])?.timeline).toBeUndefined();
    expect(copyBlock(saved[1])).toEqual({});

    // Red fault 4, and the reason the sentence may say "not saved" rather than
    // "lost": the beats were never touched. The way back is the one the sentence
    // names — press Video, in Output. Output offers only the platforms the selected
    // formats can ship, so the clip platform reappears with it and is put back too;
    // the notice is gone on the press itself, before that second click, which is
    // what makes it the Video condition and not the platform one.
    await user.click(videoCard());
    await waitFor(() => expect(notice()).toBeNull());
    await user.click(clipPlatform());

    // The very same two beats are in the projection again. If they were not, this
    // lane's copy would be a promise the editor does not keep — and the brief that
    // dispatched it said to stop and report rather than ship the sentence.
    await save(user);
    await waitFor(() => expect(saved.length).toBe(3));
    expect(beatTexts(saved[2])).toEqual([...BEATS]);
  });

  /**
   * §3.2 — R2, the worse row to read: the value was already reaching the document
   * and a switch in a different section withdrew it. The remedy is in Variation
   * Policy, which is why one sentence naming both ways back would have been the
   * wrong copy: on this route "turn Video on" is advice for a control that is
   * already on.
   */
  test("switching the headline pool on names Variation Policy, and the sequence stops saving", async () => {
    const user = userEvent.setup();
    const saved = await open(sequencedBrief);

    expect(notice()).toBeNull();

    await openAdvanced(user);
    await user.click(poolSwitch());

    const line = await screen.findByText(messages.timelineDroppedHeadlinePool);
    expect(line.getAttribute("role")).toBe("status");
    expect(screen.queryByText(messages.timelineDroppedNoVideo)).toBeNull();
    // Video never moved — the sentence that names it would be false here.
    expect(videoCard().getAttribute("aria-pressed")).toBe("true");

    await save(user);
    await waitFor(() => expect(saved.length).toBe(1));
    expect(beatTexts(saved[0])).toBeUndefined();
    expect(copyBlock(saved[0])?.timeline).toBeUndefined();

    // Reversible on this route too, and by its own control.
    await user.click(poolSwitch());
    await waitFor(() => expect(notice()).toBeNull());
    await save(user);
    await waitFor(() => expect(saved.length).toBe(2));
    expect(beatTexts(saved[1])).toEqual([...BEATS]);
  });

  /**
   * The `beats.length > 0` conjunct, which the `canSerializeTimeline` half does not
   * cover: with Video off and nothing authored there is no sequence to lose, and a
   * panel that announced a drop anyway would be reporting on an empty list. This is
   * the state an operator meets first — an empty sequence in a still-only draft —
   * so a notice here would be the one they see most and mean least.
   */
  test("an empty sequence in a still-only draft says nothing", async () => {
    const user = userEvent.setup();
    await open(unsequencedBrief);

    await user.click(clipPlatform());
    await waitFor(() => expect(videoCard().getAttribute("aria-pressed")).toBe("false"));

    expect(notice()).toBeNull();
    // The panel itself is still there, and still offering a first beat — the silence
    // is about having nothing to lose, not about the panel being gone.
    expect(screen.getByText(messages.timelineEmpty)).toBeTruthy();
  });

  /**
   * §3.1's reproduction as it is written — the operator authoring a sequence into a
   * still-only Randomized draft, rather than loading one.
   *
   * This is the case the plan states its projection claim for (`toBrief(state).copy`
   * is *undefined*, not an empty block), and the one that matters most: the notice
   * has to be on screen while the beats are being typed, not only after a reload.
   * It also pins the first beat as the moment the notice arrives — before it, there
   * is nothing to lose and the panel is properly silent.
   */
  test("authoring a beat into a still-only draft says so from the first beat, and Save writes no copy", async () => {
    const user = userEvent.setup();
    const saved = await open(unsequencedBrief);

    await user.click(clipPlatform());
    await waitFor(() => expect(videoCard().getAttribute("aria-pressed")).toBe("false"));
    expect(notice()).toBeNull();

    await user.click(screen.getByRole("button", { name: messages.timelineAddBeat }));
    await user.type(screen.getByLabelText(messages.timelineBeatTextLabel(1)), "Stay wild");

    expect(await screen.findByText(messages.timelineDroppedNoVideo)).toBeTruthy();

    await save(user);
    await waitFor(() => expect(saved.length).toBe(1));
    // The plan's own words: the whole block is absent. Nothing in the editor said
    // so before this lane — `validate.ts` had checked the beat and passed it.
    expect(saved[0]?.copy).toBeUndefined();
  });

  /**
   * Both conditions unmet at once — the state a single sentence has to be chosen for,
   * and the reason this notice names the unmet condition rather than the true one.
   *
   * There is no honest way for one line to send an operator to two sections, so the
   * panel names one. Which one is not arbitrary: naming the headline pool first would
   * be *true* and still useless here, because switching the pool off leaves Video off
   * and the sequence still unsaved, with the panel now saying something different and
   * the operator no closer. Naming Video first is monotone — each sentence, followed,
   * clears the condition it names and the next one is the truth about what is left,
   * until there is nothing left and the line goes.
   */
  test("with both conditions unmet the panel names Video first, then the pool, then nothing", async () => {
    const user = userEvent.setup();
    await open(sequencedBrief);

    await user.click(clipPlatform());
    expect(await screen.findByText(messages.timelineDroppedNoVideo)).toBeTruthy();

    // Now the pool as well. The sentence must not move to Variation Policy: Video is
    // still off, so that advice would be a step that changes nothing an operator can see.
    await openAdvanced(user);
    await user.click(poolSwitch());
    expect(screen.getByText(messages.timelineDroppedNoVideo)).toBeTruthy();
    expect(screen.queryByText(messages.timelineDroppedHeadlinePool)).toBeNull();

    // Do what it said. The line does not go — it becomes the truth about what is left.
    await user.click(videoCard());
    expect(await screen.findByText(messages.timelineDroppedHeadlinePool)).toBeTruthy();
    expect(screen.queryByText(messages.timelineDroppedNoVideo)).toBeNull();

    // Do what that said. Now there is nothing left to say.
    await user.click(poolSwitch());
    await waitFor(() => expect(notice()).toBeNull());

    // And the control the first sentence names, pressed directly rather than reached
    // by re-deriving the formats: turning the Video card off says the same thing. The
    // draft is not saveable in this state — the platform set left here cannot ship a
    // clip, which Output reports in its own field — so this asserts only what the
    // panel says, which is the whole of the claim being made about the card.
    await user.click(videoCard());
    expect(await screen.findByText(messages.timelineDroppedNoVideo)).toBeTruthy();
  });

  /**
   * TL2 — a beat's own scene, attached from the same hoisted Asset Bin the
   * product logo uses. The drawer is keyed on a discriminated `assetTarget`
   * rather than a product key, because a bare `number | null` cannot say whether
   * 0 means "product 0" or "beat 0" — and a wrong guess is a silent write to the
   * other one, which is why this asserts where the pick did NOT land as well.
   */
  test("picking an asset for a beat sets that beat's scene, and clearing restores the ground", async () => {
    const user = userEvent.setup();
    await open(sequencedBrief);

    const chip = () => screen.getByRole("button", { name: messages.timelineBeatSceneLabel(1) });
    expect(chip().textContent).toBe(messages.timelineBeatSceneNone);

    await user.click(chip());
    await screen.findByRole("dialog", { name: "Asset Bin" });
    await user.click(await screen.findByRole("button", { name: "Choose dusk.png" }));

    await waitFor(() => expect(chip().textContent).toBe("dusk.png"));
    // It landed on the BEAT, not on a product — the branch it must not have taken.
    const logos = screen
      .getAllByLabelText("Logo Path")
      .filter((el) => el.tagName === "INPUT" && el.getAttribute("type") !== "file");
    expect((logos[0] as HTMLInputElement).value).not.toContain("dusk.png");

    await user.click(screen.getByRole("button", { name: messages.timelineBeatSceneClearLabel(1) }));
    await waitFor(() => expect(chip().textContent).toBe(messages.timelineBeatSceneNone));
  });
});
