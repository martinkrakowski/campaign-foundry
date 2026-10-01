# Waves service on midnight — one status page for every project

> **Architecture & Development Plan** · 2026-10-01 · status: **proposed** (owner request: "move the wave-status page over to midnight, and host it on k3s … ALL projects can update it. Each project would register itself … User loads https://waves.midnight.lan and sees all projects and their respective lanes.")

## 0. What this plan answers

Today `yarn wave:status` is a per-checkout, loopback-only, read-only page (`tools/wave-status/server.ts:19`, port 4317, GET only at `:65`). It **pulls**: `lib/collect.ts` reads `~/.waves/<wave>/events.jsonl`, lane logs and worktrees from the orchestrator's disk, and PR checks through `gh`. A pod on k3s can read none of that. So the move is a change of model, not of host: **projects push, and one service renders them all.**

This follows the same shape as the host-wide gate pool (HXF12): one shared service, one versioned contract, and every project a client.

## 0.1 Proposed decisions

| ID | Decision | Why |
|---|---|---|
| **D190** | **Push snapshots, not raw events.** The orchestrator's existing collector (`collect` → `derive`) builds the `WaveStatus` it already renders. `yarn wave:status --push` sends that snapshot to the service, once or every N seconds with `--watch`. The service stores the latest snapshot per project and renders it. | It reuses the collector, derivation and renderer unchanged: derived facts (log sizes, EXIT markers, PR checks) are computed where the data is. A raw-event feed would need the service to re-derive facts it cannot see. |
| **D191** | **A versioned push contract (`waves/v1`):** `{ schema: "waves/v1", project, generatedAt, status: WaveStatus }`. The server rejects any other `schema` with 422 and an unknown `project` with 404. Generated projects (hexagen-monaco) implement the same contract. | Two independent implementations can interoperate, as with the gate pool's `.format`. |
| **D192** | **Registration and auth:** an admin token (a k8s Secret) mints a **per-project token** through `yarn waves:register <project> [--name …] [--repo …]`. The token is printed once and stored on the client at `~/.config/waves/<project>.token` (0600). The server keeps only its sha256. Every write needs `Authorization: Bearer <project token>` and may write only its own project. Reads are unauthenticated on the LAN/VPN, like staging. | "Each project registers itself", but nothing on the LAN can write without a token the operator issued. A leaked project token can corrupt only that project's page. |
| **D193** | **TLS and trust:** an ingress at `waves.midnight.lan`, with `cert-manager.io/cluster-issuer: selfsigned-issuer` and Traefik, exactly like staging (`deploy/staging/app.yaml:205-230`). Clients pin the issuer's CA exported to `~/.config/waves/ca.crt`. **Never `curl -k` / `rejectUnauthorized: false`.** | Tokens cross the network, so TLS is mandatory and must be verified. |
| **D194** | **Storage:** a 1 Gi PVC holding `projects.json` (id, name, repo, tokenSha256, registeredAt) and `snapshots/<project>.json` (latest only), with atomic writes (temp + rename) and one replica. | Small, single-writer, no new dependency. History stays in each project's own `~/.waves` logs. |
| **D195** | **Staleness is shown, not hidden:** a project whose last push is older than 3× its declared interval (default 10 s × 3), or older than 5 min, renders as `stale since hh:mm`. Lanes are never inferred as still running. | This is the "emit, do not infer" rule from AGENTS.md. A silent orchestrator must not look healthy. |
| **D196** | **Waves is its own project, agnostic of any consumer (owner, 2026-10-01).** It is a new repository, working name `waves`, scaffolded with the owner's hexagen generator (hexagonal: the domain is projects and snapshots; ports are the store, auth and clock; adapters are the HTTP server, the file store and the k3s deploy). It ships a small client package (`waves push`, `waves register`) that any project uses. campaign-foundry and hexagen-monaco are both just clients of D191. | No project owns infrastructure that every project depends on. The contract, not a shared codebase, is the coupling. |
| **D198** | **AGENTS.md's "Wave Observability" section is updated** to describe the push and the service (owner-approved 2026-10-01). Only that section changes. | It is the contract agents read first, and it currently says loopback-only. |
| **D197** | **The local page stays.** `yarn wave:status` (loopback) keeps working with no service, and push is opt-in through `WAVES_URL`. A push failure warns and never fails a stage. | AGENTS.md: a wave must run correctly with nothing watching. |

## 1. Verified findings

| # | Sev | Finding | Evidence |
|---|---|---|---|
| F1 | H | The collector reads only the orchestrator's local disk and `gh`, so a pod cannot pull. | `tools/wave-status/lib/collect.ts:1-2,201-304` |
| F2 | H | The UI builds HTML with `innerHTML` and an `esc()` helper. On loopback a missed escape is self-XSS; on the LAN, lane-controlled text (lane ids, `--detail` JSON, PR titles) is stored XSS for every viewer. | `public/index.html:1541,1566,2082` |
| F3 | M | The server is GET-only and loopback-bound by design. A write path is new attack surface: it needs auth, a body cap, schema validation and per-token rate limiting. | `server.ts:19,62-65` |
| F4 | M | AGENTS.md states "Serves `http://127.0.0.1:4317`. Read-only". The contract text must change to describe the service, and AGENTS.md is a never-edit-as-a-side-effect file. | `AGENTS.md`, "Wave Observability" |
| F5 | L | The midnight k3s already provides Traefik, `selfsigned-issuer`, `registry.midnight.lan` and a deploy pattern. Nothing new is needed at the cluster level. | `kubectl get clusterissuer,ingressclass`; `deploy/staging/` |

## 2. Lanes

### 2.1 In the new `waves` repository (wave `waves-w01`)

| Lane | Risk | Delivers | Owns | Must not |
|---|---|---|---|---|
| **WV0-scaffold** | normal | Scaffold with the hexagen generator (latest release; record its version). One service app plus one client package. CI with a 100% coverage gate from day one, AGENTS.md, and `.agents/` specs per the generator. Pin Node 22. | the whole new repo | add product code here |
| **WV1-contract-and-store** | normal | The domain: the `waves/v1` envelope type and validator (schema, project id `^[a-z0-9][a-z0-9-]{0,62}$`, ISO `generatedAt`, the `status` shape, a 1 MiB cap); the `Project` registry and the latest `Snapshot` per project; D195 staleness as a pure function of (lastPush, interval, now). The store port has an in-memory adapter and a file adapter (atomic temp + rename, `projects.json` and `snapshots/<id>.json`). | `packages/domain/**`, `packages/store-*/**` | depend on HTTP or k8s |
| **WV2-server** | **high** | The HTTP adapter (Node `http`, no framework). **Routes:** `GET /`; `GET /p/<id>`; `GET /api/v1/projects`; `GET /api/v1/projects/<id>/status`; `PUT /api/v1/projects/<id>/status` (that project's token only); `POST /api/v1/projects` and `DELETE /api/v1/projects/<id>` (the admin token). **Hardening:** sha256 tokens compared in constant time; 1 MiB body cap (413); at most 1 write per second per token (429); CSP `default-src 'self'; script-src 'self'`, `nosniff`; no secret ever in a response or a log; `/healthz`. Tests run real `http` on an ephemeral loopback port against the in-memory store. | `apps/server/**` | accept a write without a token; log tokens; serve outside `public/`; add a framework |
| **WV3-ui** | **high** | The multi-project page: a project list (name, repo, last push, stale badge, lane counts by state); a per-project drill-down that renders the `WaveStatus` the way campaign-foundry's page does (ported, not imported); auto-refresh with no websockets. All lane-controlled text goes through `textContent` or one audited `esc()`, and no inline script. **An XSS test** feeds `<img src=x onerror=…>` and `"><script>` through every lane-controlled field (project name, lane id, detail, PR title, branch) and asserts no element or attribute from them reaches the DOM. | `apps/server/public/**` and its tests | inline scripts; fetch from another origin |
| **WV4-deploy** | normal | `deploy/k3s/`: a namespace `waves`; a Deployment (1 replica, non-root, read-only root fs, the PVC at `/data`); a Service; an Ingress `waves.midnight.lan` (Traefik, `selfsigned-issuer`, the same pattern as campaign-foundry's `deploy/staging/app.yaml:205-230`); a 1 Gi PVC; an out-of-band Secret `waves-admin`. An image pushed to `registry.midnight.lan/library/waves`. `deploy.sh` runs over `ssh m` with `KUBECONFIG=$HOME/.kube/config`. A README covers the admin Secret and exporting the CA. | `deploy/**`, `Dockerfile` | commit a token or key; disable TLS verification; touch any other namespace |
| **WV5-client** | normal | The client package and CLI. `waves register <id> [--name] [--repo]` takes the admin token from the env, prints the project token once and writes it to `~/.config/waves/<id>.token` (0600). `waves push` (`--file <status.json>` or `--stdin`) reads `WAVES_URL` and the project id, and refuses a token file not at 0600. The CA is pinned from `~/.config/waves/ca.crt` with verification always on. A failure exits non-zero and never retries more than twice. Published to npm (public, like `@hexagen-monaco/orchestration`). | `packages/client/**` | weaken TLS; store a token anywhere but the 0600 file |
| **WV6-contract-doc** | normal | `docs/waves-v1.md`: the envelope, the routes, auth, staleness, status codes and a curl example, which other projects implement against. | `docs/**` | |

### 2.2 In campaign-foundry (wave `waves-client-w01`, after WV5 publishes)

| Lane | Risk | Delivers | Owns | Must not |
|---|---|---|---|---|
| **WS1-push** | normal | `yarn wave:status --push [--watch[=s]]` builds the existing `WaveStatus` and hands it to `waves push --stdin` (the published client, a devDependency) with `WAVES_PROJECT=campaign-foundry`. A push failure warns and never fails a stage (D197). Unset `WAVES_URL` means exactly today's behaviour. | `tools/wave-status/cli.ts` (the flag), `lib/push.ts`, tests, `package.json`/`yarn.lock` (the dependency) | change the local page; fail a stage on push |
| **WS5-docs** | normal | The AGENTS.md "Wave Observability" section (D198); the pipeline doc and skill: start every wave with `yarn wave:status --push --watch`. | `AGENTS.md` (that section only), the pipeline doc, `SKILL.md` | change any other AGENTS.md rule |

hexagen-monaco adds the same client step to its orchestration package (its own lane), so every generated project can push.

Order: WV0 → WV1 → WV2 ∥ WV5 → WV3 → WV4 → WV6, then WS1 → WS5. WV2 and WV3 are high risk (a network-exposed write path, and stored XSS), so they get separate row, brief and pre-PR reviews.

## 3. Owner actions (not lanes)

1. **D196 confirmed** (its own project). **Decide the repository name and visibility** (working name `waves`, public like `campaign-foundry` and `hexagen-monaco`; no secret lives in code).
2. **D198 approved** (the AGENTS.md edit in WS5).
3. **DNS:** confirm `waves.midnight.lan` resolves (it does if `*.midnight.lan` is a wildcard, as `campaign-foundry.midnight.lan` suggests).
4. **Create the admin Secret** on midnight (`kubectl -n waves create secret generic waves-admin --from-literal=token=$(openssl rand -hex 32)`), and keep a copy in your password manager. Agents never see it.
5. **Export the CA once** to each client host's `~/.config/waves/ca.crt` (WS4's README gives the command).

## 4. Definition of done

- `https://waves.midnight.lan` serves every registered project, each with its waves and lanes, behind verified TLS.
- `yarn waves:register campaign-foundry` mints a token. `yarn wave:status --push --watch` from the Mac updates the page within one interval, and stopping it shows `stale since …` within 5 min.
- A second project (hexagen-monaco) registers and pushes through the same `waves/v1` contract and appears beside it.
- A write without a token, or with another project's token, is refused (401/403), and an oversize body gets 413. The XSS test passes for every lane-controlled field.
- With `WAVES_URL` unset, today's local page and every wave stage behave exactly as before.
- CI is green at 100% coverage; every lane has a manifest whose mutations are caught.
