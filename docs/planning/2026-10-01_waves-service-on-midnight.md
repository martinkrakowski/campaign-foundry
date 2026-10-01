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
| **D196** | **Where the code lives:** the server, UI and deploy live in **campaign-foundry** (`tools/waves-server/`, `deploy/waves/`), which owns the canonical wave-status today; hexagen-monaco implements the D191 client. The server moves into the published orchestration package once hexagen's port settles. | It is the fastest path from the code and tests that exist, and the contract keeps the two repos from drifting. **Owner to confirm** (the alternative is building it in hexagen first). |
| **D197** | **The local page stays.** `yarn wave:status` (loopback) keeps working with no service, and push is opt-in through `WAVES_URL`. A push failure warns and never fails a stage. | AGENTS.md: a wave must run correctly with nothing watching. |

## 1. Verified findings

| # | Sev | Finding | Evidence |
|---|---|---|---|
| F1 | H | The collector reads only the orchestrator's local disk and `gh`, so a pod cannot pull. | `tools/wave-status/lib/collect.ts:1-2,201-304` |
| F2 | H | The UI builds HTML with `innerHTML` and an `esc()` helper. On loopback a missed escape is self-XSS; on the LAN, lane-controlled text (lane ids, `--detail` JSON, PR titles) is stored XSS for every viewer. | `public/index.html:1541,1566,2082` |
| F3 | M | The server is GET-only and loopback-bound by design. A write path is new attack surface: it needs auth, a body cap, schema validation and per-token rate limiting. | `server.ts:19,62-65` |
| F4 | M | AGENTS.md states "Serves `http://127.0.0.1:4317`. Read-only". The contract text must change to describe the service, and AGENTS.md is a never-edit-as-a-side-effect file. | `AGENTS.md`, "Wave Observability" |
| F5 | L | The midnight k3s already provides Traefik, `selfsigned-issuer`, `registry.midnight.lan` and a deploy pattern. Nothing new is needed at the cluster level. | `kubectl get clusterissuer,ingressclass`; `deploy/staging/` |

## 2. Lanes (wave `waves-service-w01`)

| Lane | Risk | Delivers | Owns | Must not |
|---|---|---|---|---|
| **WS1-push-contract** | normal | The `waves/v1` envelope type and a validator (`tools/wave-status/lib/push.ts`): schema, project id `^[a-z0-9][a-z0-9-]{0,62}$`, `generatedAt` ISO, `status` shape-checked against `WaveStatus`, a 1 MiB cap. `yarn wave:status --push [--watch[=s]]` reads `WAVES_URL`, the project token (`~/.config/waves/<project>.token`, refused unless 0600) and the CA (`~/.config/waves/ca.crt`). It POSTs with TLS verification ON; on failure it warns and continues (D197). The project id defaults to the repo basename, overridable with `WAVES_PROJECT`. Tests use an injected fetch; nothing real is called. | `tools/wave-status/lib/push.ts`, `cli.ts` (the flag), tests, manifest | weaken TLS verification; fail a wave stage on a push error; change the local page |
| **WS2-waves-server** | **high** | `tools/waves-server/`: Node `http`, no framework. **Routes:** `GET /` (all projects); `GET /p/<project>`; `GET /api/v1/projects`; `GET /api/v1/projects/<id>/status`; `PUT /api/v1/projects/<id>/status` (the project token); `POST /api/v1/projects` (the admin token: register, mint and return a token once); `DELETE /api/v1/projects/<id>` (admin). **Hardening:** constant-time token compare on sha256; 1 MiB body cap; at most 1 write per second per token; atomic file writes; `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`; `X-Content-Type-Options: nosniff`; and no secret ever in a response or a log line. D195 staleness lives in the rendered model. Tests run against an in-memory store and real `http` on an ephemeral loopback port. | `tools/waves-server/**`, its tests and manifest | add a dependency; log tokens; accept a write without a token; serve anything outside `public/` |
| **WS3-multi-project-ui** | **high** | The UI shows a project list (name, repo, last push, stale badge, lane counts by state), drills down per project to the existing wave/lane view (reusing today's renderer), and auto-refreshes with no websockets. **An XSS audit:** every `innerHTML` site either goes through `esc()` or becomes `textContent`, and a test feeds `<img src=x onerror=…>` and `"><script>` through every lane-controlled field (lane id, detail, PR title, branch) and asserts the rendered DOM contains no element or attribute from them. | `tools/waves-server/public/**`, `tools/wave-status/public/index.html` (only the escaping fixes, shared), tests | inline scripts (CSP); fetch from another origin |
| **WS4-deploy-k3s** | normal | `deploy/waves/`: a namespace `waves`; Deployment (1 replica, non-root, read-only root fs, the PVC at `/data`); Service; an Ingress `waves.midnight.lan` with `selfsigned-issuer` TLS (staging's pattern); a PVC of 1 Gi; and a Secret `waves-admin` (created out of band, never in git). An image from a small Dockerfile is pushed to `registry.midnight.lan/library/waves`. `deploy/waves/deploy.sh` mirrors `deploy/staging/deploy.sh`'s `remote()` (`KUBECONFIG=$HOME/.kube/config`). `yarn waves:register` lives here too (an admin-token CLI with the CA pinned). A README covers exporting the CA to `~/.config/waves/ca.crt`. | `deploy/waves/**`, `tools/waves-register/**`, `package.json` (scripts) | commit a token or key; disable TLS verification anywhere; touch the campaign-foundry-staging namespace |
| **WS5-docs-and-contract** | normal | The AGENTS.md "Wave Observability" table **(owner-approved edit, D198)**: `yarn wave:status --push --watch` to `https://waves.midnight.lan`, the token/CA locations, and that the dashboard is still never required. The pipeline doc and skill: start every wave with the push watch. The contract doc `docs/workflows/waves-v1.md`, which hexagen implements. | `AGENTS.md` (that section only), `docs/workflows/waves-v1.md`, the pipeline doc, `SKILL.md` | change any other AGENTS.md rule |

Order: WS1 ∥ WS2 → WS3 → WS4 → WS5. WS2 and WS3 are high risk (a network-exposed write path, and stored XSS), so they get separate row, brief and pre-PR reviews.

## 3. Owner actions (not lanes)

1. **Confirm D196** (the code lives in campaign-foundry first, or in hexagen first).
2. **Approve D198:** the AGENTS.md "Wave Observability" edit in WS5.
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
