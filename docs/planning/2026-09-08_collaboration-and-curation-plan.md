# Implementation Plan: Collaboration, Drafts & Asset Curation

> **RETIRED 2026-09-10** — see `2026-09-10_reconciliation.md` §3. Phases 1 and 2 had **already
> shipped before this plan was drafted**: `StoredBrief.revision` with conditional writes and 409
> adoption (2026-08-28), and the copy-pool drawer with its `/campaigns/pools/*` routes
> (2026-08-30). The remainder is the **D64(b)** deferral list and **D82**, both open owner
> decisions. Inline legal linting survives as a lane. Kept for the record; do not implement.

**Date:** 2026-09-08
**Context:** Current campaigns exist as single-user local files, and copy pools lack curation UI. For market viability as an enterprise tool, Campaign Foundry needs collaborative workflows, revision history, and robust asset management.
**Architectural Goal:** Enhance the `CampaignOrchestration` domain with a `DraftCampaignService`, and expose `GovernanceAndCompliance` asset pools through a dedicated UI.

---

## 1. Architectural Strategy

We need to evolve beyond the current "edit file -> hit API" paradigm. We will introduce a stateful Draft layer that sits between the UI and the finalized Campaign Run.

### 1.1 The Draft Service Boundary

*   **Domain (`CampaignOrchestration`)**: Introduce `DraftBrief` and `Revision` entities.
    *   *Rule:* A draft is mutable; a committed campaign run is immutable.
*   **Ports (`ports/brief-store.port.ts`)**: Utilize optimistic concurrency control (ETags or version hashes) to prevent collision.
*   **UI (`apps/web`)**: Shift from `localStorage` state to server-synced draft state.

---

## 2. Core Collaborative Mechanisms

### 2.1 Optimistic Concurrency & Locking
*   **Mechanism:** Every read of a `DraftBrief` returns a `versionHash`. Any `PUT` or `PATCH` must include the `versionHash`. If it doesn't match the server, a `409 Conflict` is returned.
*   **Locking:** For deeper collaboration, implement a soft-lock (e.g., "Alice is currently editing this section") using the existing backend, expiring after a set TTL.

### 2.2 Revision History
*   Store a delta or full snapshot on every successful save.
*   Provide an API endpoint `GET /campaigns/:id/revisions` to allow the UI to rollback to a previous state.

---

## 3. Asset & Copy Pool Curation (The Library)

Currently, `pool://copy` exists in the backend but has no frontend management interface.

### 3.1 The Curation API
*   Expose endpoints for interacting with pools:
    *   `GET /pools/copy?status=rejected`
    *   `PATCH /pools/copy/:entryId`
    *   `POST /pools/copy/generate?count=10`

### 3.2 Inline Policy Linting
*   **The Problem:** Users find out a word is prohibited *after* generating the creative.
*   **The Solution:** Expose the `GovernanceAndCompliance` logic via a lightweight `POST /compliance/lint` endpoint. The UI calls this while the user types in the Brief Editor to flag issues in real-time.

---

## 4. Suggested Features (Phased Rollout)

### Phase 1: Drafts & Locking (MVP Collaboration)
*   **Draft API:** Implement the `DraftCampaignService` for saving WIP briefs with concurrency control.
*   **UI Integration:** Update the `BriefEditor` to sync with the API instead of relying solely on `localStorage`. Show warnings on 409 conflicts.

### Phase 2: The Asset Library UI
*   **Library Drawer:** Build a sliding drawer in `apps/web` to manage headlines, backgrounds, and logos.
*   **Real-time Linting:** Implement debounced calls to the compliance linter within the text inputs of the editor and library.

### Phase 3: Real-time Presence
*   **WebSockets/SSE:** Add server-sent events to broadcast "User X is viewing" or "User Y is editing" to all active clients viewing the same campaign ID.

---

## 5. Implementation Plan (Step-by-Step)

### Step 1: Enhance `BriefStorePort`
1.  Ensure `BriefStorePort` implementations support returning and accepting `ETag` or version hashes.
2.  Implement the `DraftCampaignService` in `CampaignOrchestration` to orchestrate reads, writes, and history logging.

### Step 2: Pool Management API
1.  Add controller routes for managing `pool://copy` and media assets.
2.  Wire these routes to the respective ports in `GovernanceAndCompliance`.

### Step 3: Editor State Refactor (UI)
1.  Refactor `apps/web/src/lib/editor-state.ts` to sync with the new Draft API.
2.  Handle `409 Conflict` responses gracefully by prompting the user to overwrite or reload.

### Step 4: Library Drawer Component
1.  Create a shared library UI component for viewing approved/rejected copy variants.
2.  Add bulk actions (Approve All, Regenerate).

### Step 5: Inline Linting
1.  Create the `POST /compliance/lint` endpoint.
2.  Add debounced fetching to the UI text areas, highlighting prohibited words in red.

---

## 6. Risks & Mitigation

*   **Risk:** `localStorage` to server-sync migration causes data loss for users with unsaved local drafts.
    *   **Mitigation:** On first load after the update, prompt the user: "We found a local draft. Would you like to upload it as a server draft?"
*   **Risk:** High API traffic from inline linting.
    *   **Mitigation:** Strictly debounce API calls (e.g., 500ms after typing stops). Eventually, consider compiling the ruleset into a WASM module for client-side evaluation.
