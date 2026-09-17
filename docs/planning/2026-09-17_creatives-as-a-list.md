# Creatives as a list — from a drawn set to an authored one

**Date:** 2026-09-17 · **Status:** draft, for the owner's approval. **Nothing dispatched.**
**Verified against:** `origin/main` at `78dc964a`.
**Source:** the owner's flow of 2026-09-17 — *"if user elects to generate a campaign with 2 variations (i.e. creatives), then 2 items appear in the left sidebar representing each of those creatives / configurations. User should be able to add and delete the creatives."*
**Supersedes:** SG-D1's *"count in the wizard"* framing (`2026-09-17_wireframe-gap.md`). **Does not touch** CC3, SG1, the template modal or the timeline — none of them depend on how variants are stored.

---

## 1. What the document is today

A brief describes a **space of creatives**, not the creatives themselves. The operator declares axes as *sets*; a count, a seed and a distance constraint tell the planner how to draw from them. `briefs/sample-motion.yaml`:

```yaml
variation:
  count: 8
  seed: 3
  minDistance: 2
  coverage:
    perProduct: 1
    perRatio: 1
  axes:
    layout: [headline-top, headline-bottom]
    tone: [bold, subtle]
    background:
      source: [procedural]
    paletteShift: [0, 0.1]
    motion: [ken-burns-in, headline-rise]
    duration: [6]
```

The type is `CampaignBrief.ts:75` — `variation?: { count?, seed?, minDistance?, coverage?, axes? }`, every axis a `readonly string[]`.

A concrete creative is a **`Variant`** — `{ index, seed, productId, aspectRatio, layout, tone, backgroundSource, paletteShift, headline?, anchor?, motion?, durationSec? }` (`entities/Variant.ts:13`).

**`Variant` is never written to disk.** It is derived at run time: the planner takes the axes, enumerates or samples the product space, filters pairs closer than `minDistance`, honours `coverage`, and emits `count` of them. That is the guarantee D123 leans on — *"a run is a function of one document and a seed"*. Same brief, same seed, same creatives, forever.

The older `brief` mode is the same document read differently: `treatments` (a list of `{id, layout, tone}`) crossed with products and canvases, exhaustively, no draw.

### 1.1 What that shape is good at, and what it fights

| The document is good at | The document fights |
|---|---|
| *"Explore this space and give me 8 spread-out options."* | *"I want exactly these three ads."* |
| Reproducibility — a seed replays a campaign byte-for-byte | Editing **one** creative. There is nowhere to put the edit: the axes describe all of them |
| Compactness — nine axes describe hundreds of creatives | Expressing a single creative, which becomes a set of one-element lists |
| Machine-side optimisation | Naming, reordering or deleting an individual creative — `Variant` has no identity beyond `index`, and `index` is a position in a draw |

**The second column is the owner's flow.** A sidebar list of creatives you click into, edit, add to and delete from is a list of *authored* things. Today's document has no place to store one.

---

## 2. The marketing case — why 1 and why 100

The current document implicitly assumes one marketing motion: *generate a spread, pick winners*. That is genuinely how paid social works, and it is the wrong shape for at least three other motions this product already claims to serve. The four campaign types are not four sizes of the same job.

### 2.1 One creative

**Organic social (`social-post`).** A brand posts *one* thing. There is no A/B test on a feed post — it goes out, it is the brand's voice that day. Asking an operator to express that as `count: 1` with nine single-element axes and a seed is asking them to describe a set that happens to have one member. They are not exploring a space; they are making an ad.

**Brand and launch moments.** A hero asset gets art direction, legal review and a sign-off. It is *the* creative. Its value is that it is singular, and a document that cannot name it cannot carry that.

**Client approval.** Agencies present a small number of concepts. "Here are three routes" is a deliverable; "here are 40 draws from a space" is a different conversation, and usually a worse one.

**Expensive formats (`short-video`).** Motion costs real compute and real money per unit — this repo's own estimate panel exists to say so. At high unit cost the operator wants deliberate choices, not volume.

### 2.2 A hundred creatives

**Paid social, where volume *is* the strategy (`paid-social`).** Meta and TikTok delivery optimisation needs creative volume to learn from: the platform decides which creative wins per audience slice, and it cannot do that with two. Creative volume is a targeting input, not laziness. This is exactly what the axes-and-draw model was built for and it should not be lost.

**Programmatic display (`display-ad`).** Volume comes from *placements*, not concepts — every IAB size, every market. One idea becomes forty assets because the inventory demands forty shapes. The operator is not exploring; they are fanning out mechanically.

**Localisation.** N markets × M languages, one concept. Volume is a property of the footprint.

**Fatigue and rotation.** A long-running campaign burns its audience on a creative in weeks; the answer is a deep well to rotate through. Volume is a schedule.

### 2.3 Why this argues for the change rather than against it

These are not points on a dial from 1 to 100 — **they are different jobs, and today only the second is well served.** The one-creative motions have to pretend to be a degenerate space, and the operator pays for a draw they did not want.

An authored list serves both directions honestly:

- **One** is one item. Nothing to configure away.
- **A hundred** is still the draw's job — but as an **authoring action** that *fills the list*, not a run-time computation that replaces it. "Add 40 variations across these axes" produces 40 items the operator can then inspect, reorder, delete three of, and hand-edit two of.

That last part is what neither model does today. The draw gives you volume you cannot touch; a hand-built list gives you control that does not scale. **The owner's flow asks for both, and the only way to have both is to make the list the document and the draw a generator that writes into it.**

---

## 3. The proposed document change

### 3.1 The shape

Creatives become **persisted, identified, individually-editable entries**. Sketch, deliberately not final:

```yaml
id: trail-blaze-2026
targetRegion: DE
campaignMessage: Ignite the trail.
products: [ … unchanged … ]
template: { … unchanged: pinned ref + materialised layers … }

creatives:
  - id: hero-bottle-square          # stable identity, not a draw index
    productId: blaze-bottle
    aspectRatio: "1:1"
    layout: headline-bottom
    tone: bold
    backgroundSource: procedural
    paletteShift: 0
  - id: story-pack-tall
    productId: blaze-pack
    aspectRatio: "9:16"
    layout: headline-top
    tone: subtle
    backgroundSource: procedural
    paletteShift: 0.1
    motion: ken-burns-in
    durationSec: 6
```

Each entry is close to today's `Variant` **plus a stable `id`** and **minus `index`/`seed`** — because position stops being meaning and reproducibility stops needing a seed.

### 3.2 What each existing concept becomes

| Today | Proposed |
|---|---|
| `variation.axes.*` (sets) | **An authoring input, not document state.** Used by the *Add variations* action to write entries; not stored as the description of the campaign |
| `variation.count` | **The length of `creatives`.** Derived, never set. Adding an entry is how it grows |
| `variation.seed` | **Retires as a run input.** It exists to make a draw replayable; an authored list is already exact. May survive *inside* an entry if a per-creative generator needs one |
| `variation.minDistance` | **Retires from the document.** There is no pair-wise constraint to enforce on a list the operator wrote — you simply do not add two identical entries. It may survive as an *option on the Add-variations action* ("spread these out"), which is where it is genuinely useful |
| `variation.coverage` | Same: an option on the generator, not a property of the campaign |
| `treatments` (classic) | **Retires.** Already dying with `mode` (SG-D1) |
| `Variant` | **Becomes the persisted entry.** Stops being derived |
| The planner | **Becomes a generator invoked by the editor**, not a stage of the run |

### 3.3 What this buys

- **The sidebar list is the document.** Clicking entry 2 loads entry 2; there is a place for the edit to live. No synthesis layer between what is stored and what is shown.
- **Reproducibility gets stronger, not weaker.** Today a run is a function of *(document, seed, planner version)* — and a planner change can move the output of an unchanged brief. An explicit list makes the run a function of the document alone.
- **`minDistance` stops needing a name.** The owner asked for a more descriptive one and a floor of 1. Under this model the control leaves the document and becomes an option on *Add variations*, where "how different should these be from each other?" is finally a question about the thing in front of you.
- **One creative is expressible without pretending.**

### 3.4 What it costs — stated plainly

- **Brief size.** Nine axes describing 100 creatives is a few lines; 100 entries is 100 stanzas. D123 already accepted this trade once for template layers (*"materialising the layers costs brief size and buys reproducibility"*), so the precedent and the reasoning both exist — but this is a larger instance of it.
- **Migration.** Every existing brief carries `variation.axes`. They must keep opening and keep rendering. The planner's draw becomes the reader for the old shape, which means **the draw code does not get deleted** — it gets demoted.
- **`policyHash` and the run path.** `variation` participates in hashing and in `regenerateOnly` keying. Both need rework, and the regenerate-rejected flow keys on a variant identity that is currently an index.
- **The estimate.** `EstimatePanel` branches on `mode` and reads `count`; it becomes a list length.
- **Loss of "explore".** A drawn space invites discovery — *"show me 8 I would not have thought of"*. A list does not, unless the generator is good and reachable. **This is the real risk of the change**, and it is why the draw must survive as an authoring action rather than be deleted.

---

## 4. Decisions needed

| ID | Question | Recommendation |
|---|---|---|
| **CL-D1** | **Does the draw survive?** (a) No — axes, count, seed, minDistance and the planner all retire. (b) Yes, demoted to an *Add variations* authoring action that writes entries. | **(b).** (a) deletes the one thing the product is unusually good at — and §2.2's motions are real. Demotion keeps the machinery, moves it to where the operator can see what it did, and makes every old brief readable through it. |
| **CL-D2** | **Is the minimum one creative, and is deleting the last refused?** | **Yes and yes.** A campaign with zero creatives has nothing to render. The owner's *"minimum should be 1"* is structural under this model, not a slider bound. |
| **CL-D3** | **Where does a creative's identity come from?** (a) An operator-visible `id` like a product's. (b) An opaque generated key. | **(a).** Products already work this way, the YAML stays human-readable, and a generated entry can seed a readable default the operator may rename. |
| **CL-D4** | **Do old briefs migrate on write, or keep both shapes?** | **Read both, write the new one; never rewrite a brief the operator did not save.** Migrating on open would silently rewrite hundreds of lines of someone's campaign. |
| **CL-D5** | **Does an entry own its own template/style, or does the campaign?** | **Campaign-level for now.** The wireframe shows one template panel and one layer stack; per-creative overrides are a much larger change and should not ride along on this one. |
| **CL-D6** | **What happens to `seed`?** | **Retires as a run input; may live inside an entry** if a per-creative image generation needs determinism. Not decided here — it depends on whether background generation stays seeded per variant. |

---

## 5. What this plan does not do

- **It does not touch the layout work.** CC3 (shipped), SG1, SG4, the template modal and the timeline are all independent of how variants are stored.
- **It does not redesign the generator's UI.** *Add variations* needs its own spec — that is where the renamed distance control and the coverage options land.
- **It does not decide per-creative templates or styles** (CL-D5 defers it).
- **It does not delete the planner.** CL-D1(b) demotes it; `PlanCapacity`, `PlanVariationsUseCase` and the exhaustive/greedy search all keep earning their place as the generator behind *Add variations*.

---

## 6. Premise

```premise CL0
# The brief has no `creatives` list; variation is still axes + count. Flips when the
# document gains the list. Probes the TYPE, not the YAML samples: a brief file that
# happens to omit `variation` would make a sample-based fence pass on an unchanged
# schema. Measured: ~30 ms.
! grep -qn 'creatives' packages/CampaignOrchestration/src/domain/entities/CampaignBrief.ts
```
