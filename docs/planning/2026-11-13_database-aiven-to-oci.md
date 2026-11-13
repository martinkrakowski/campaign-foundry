# DB-1 — The database from retired Aiven to Oracle Cloud (OCI) — Architecture & Development Plan

**Date:** 2026-11-13 · **Status:** r1 — DRAFT. **No decision is STAMPED.** D247 is a cost/ownership fork only the owner can take (Q1); D248 depends on it. Nothing is dispatched until Q1 is answered.
**Verified against:** `main` at `bbeebf2c`. The OCI facts below were read from the live tenancy with `oci` CLI 3.95.0 (profile `DEFAULT`, tenancy `…l44dzwvftd3q`, 2026-11-13), not from documentation. The Aiven facts were read by DNS resolution, not assumed from the owner's note.
**Decision ids introduced:** D247 – D252 · **r2 2026-11-13:** solstice verified by `kubectl` (F13–F15); D247 gained option (c) · **r3 2026-11-13:** reframed after the owner's correction — Aiven was never populated, and this is the cloud rollout, not a recovery (F1, D249); staging now runs the whole path (F16) (`git grep -ohP "\bD\d{3}\b" -- docs .agents | sort -u | tail -1` → D246). **Lane ids `DB-1a` … `DB-1f`** (`git grep -cE "DB-1[a-z]" -- docs` → 0 hits).
**Relates to:** **D174a** (PostgreSQL as the store backend), **D201** (B2/object store is production-only, deferred by the owner 2026-10-06), **PT-3** (Postgres adapters, migrations under an advisory lock), **PT-3d** (a PT-8 import does not keep brief revisions), **PT-8** (`2026-10-04_pt-8-data-migration.md` — the fs→rows importer this plan re-uses whole), **PT-6** (workers share the connection budget), **PT-1a Finding 3** (Better Auth's own pool).

Findings carry the house evidence labels: **[code]** read in the tree, **[data]** names/counts/sizes of operator data (never contents), **[intent]** a recorded decision, **[oci]** read from the live tenancy through `oci` CLI.

---

## 0. The finding this document exists for

**This is not a data migration, and it never was. Aiven was a target that was never populated.**

The task was given as "move the database from Aiven to OCI", and r1 of this document read that as a rescue: it said rows were "already gone" and "unrecoverable". That was wrong. The owner corrected it on 2026-11-13: **the Aiven database was never populated** [intent]. Nothing was lost, because nothing was ever there. Aiven was provisioned as the destination for a move that had not happened yet, and then retired.

What is actually being built is a **product feature**: campaign-foundry keeps its briefs, assets and renders on a local filesystem, and the cloud rollout moves them into a server database and an object-storage bucket [intent, owner 2026-11-13]. That feature is PT-3 (Postgres adapters), PT-4 (the object store) and PT-8 (the importer that carries the file stores across). DB-1 is not a recovery plan standing beside them; it is the infrastructure half of the same rollout.

So DB-1 is three jobs wearing one name:

1. **Provide** the database and the bucket the rollout needs (greenfield — no PostgreSQL DB system exists anywhere in the tenancy; all five compartments return an empty list [oci]).
2. **Carry the local stores across** with PT-8's importer. This is the feature working as designed, not a restore: the filesystem is the source of record until it runs.
3. **Un-pick Aiven from the code**, where a never-used vendor is still baked into pool constants, error strings and 19 files.

The Aiven hostname no longer resolves (`dig +short …aivencloud.com` → empty [data, 2026-11-13]), which settles only that the old target is gone — not that anything of value went with it.

And two OCI facts decide the shape of all three:

- **OCI Database with PostgreSQL has no public endpoint.** `oci psql db-system create --generate-param-json-input network-details` returns exactly `{isReaderEndpointEnabled, nsgIds, primaryDbEndpointPrivateIp, subnetId}` [oci]. There is no public-endpoint flag to set. Aiven handed out a public TLS endpoint that the owner's Mac and the midnight k3s staging both dial directly; **OCI will not.**
- **The smallest managed shape is 2 OCPU / 32 GB** (`PostgreSQL.VM.Standard.E5.Flex.2.32GB`) [oci]. There is no small tier and none of it is Always Free. The retired Aiven plan allowed 15 connections in total [code: `database-config.ts:34-39`] — a plan sized for a demo. The managed OCI floor is not that.

---

## 1. Findings

| id | Sev | Finding |
|---|---|---|
| **F1** | **M** | **Aiven never held data, so there is no source database and nothing was lost** [intent, owner 2026-11-13; corrected from r1, which wrongly called the rows unrecoverable]. The hostname no longer resolves and no dump exists locally [data], but both facts are about a destination that was never filled. PT-8 §0 class **(X)** — rows in another database — is therefore **empty**, not out of scope. The file stores are the only source of record, which is exactly what PT-8's importer expects. |
| **F2** | **C** | **The managed service is reachable only from inside the VCN.** `network-details` accepts `subnetId` and `primaryDbEndpointPrivateIp` and nothing else [oci]. Today's consumer is the owner's Mac (`.env.local` → `DATABASE_URL`, `DATABASE_HOST`, `DATABASE_PORT` [data]), which is outside any OCI VCN and **loses its route on day one** unless D248 provides one. Staging is no longer a second consumer — see F13. |
| **F3** | **C** | **The managed floor is 2 OCPU / 32 GB, with no free tier.** Shapes offered to this tenancy start at `…E5.Flex.2.32GB`; the ladder is 2/32, 4/64, 8/128, 16/256, 32/512, 64/1024 across E5, E6 and Standard3 [oci]. Aiven was retired; a replacement with a higher floor than the thing that was too expensive is a decision, not a default. **Price is not quoted here** — it must come from the OCI cost estimator before Q1 is answered, not from me. |
| **F4** | **H** | **Aiven's capacity is a compile-time constant.** `MAX_POOL = 15` is documented as "the whole of the Aiven service's capacity", `DEFAULT_POOL_MAX = 5`, and `AUTH_POOL_MAX = 2` exists so store+auth never exceed 15 [code: `database-config.ts:34-46`]. On any new host these numbers are wrong in both directions — they are a provider's plan limit wearing the costume of a domain rule. |
| **F5** | **H** | **The pasted dev failure is two faults, and only one is Aiven's.** `databaseConfig` throws for any non-local host when `DATABASE_CA_PATH` is unset [code: `database-config.ts:74-81`], and `.env.local` defines `DATABASE_URL`, `DATABASE_HOST`, `DATABASE_PORT`, `STORE_BACKEND` but **no `DATABASE_CA_PATH`** [data]. So `yarn dev` would fail on the CA even if Aiven were alive. The error text also hard-codes Aiven's console path as the operator's instruction. |
| **F6** | **H** | **"Aiven" appears in 19 tracked files** [code], including `.agents/tech-stack.md` — which AGENTS.md forbids editing as a side effect — and the operator-facing error string in F5. Renaming is therefore a scoped lane with an explicit ask, not a `sed`. |
| **F7** | **M** | **The tenancy's limits disagree with themselves, and availability confirms it.** `dbsystem-count` reports `available: 0, used: 0`, while `dbsystem-e5-count` reports `available: 20, used: 0` (E6 5, Standard3 5) [oci, 2026-11-13]. So the generic counter is genuinely zero rather than merely unset, and the E5 family has headroom. The likeliest reading is that the per-family limits supersede the generic one — **but a create is the only thing that proves it**, and it could be refused on a limit that reads zero. Settle with Oracle support, or accept a failed create as the probe, **before** DB-1b commits to option (a). |
| **F8** | **M** | **The one running VM is already somebody's production.** The sole non-terminated instance is `prod-node-1` — `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, private IP `10.0.1.200`, **no public IP**, AD-3, created 2026-10-18 [oci]. It is named for a role and is presumably the `ack-challenge` / fleetcloud work. **Nothing in this plan touches it.** Always Free allows 4 OCPU / 24 GB of A1 in total, so a second A1 at 2 OCPU / 12 GB fits beside it — exactly, with nothing spare. |
| **F9** | **M** | **The seed source exists and the tool for it is already built.** `briefs/`, `assets/inputs/` and `output/` are present in the checkout [data], and `apps/api/server/lib/import/` ships `apply.ts`, `census.ts`, `classify.ts`, `existing-apply.ts`, `normalise-step.ts` with a `plan`/`apply` CLI (`--org`, `--project-root`, `--output-root`, `--switched-at`, `--result`, `--expect`) [code]. DB-1 re-uses PT-8 whole; it writes no new import code. |
| **F10** | **M** | **The VCN is ready; the subnets are already correct.** `krakowski-cloud-solutions-vcn` (10.0.0.0/16) has a private subnet `10.0.1.0/24` (`prohibit-public-ip-on-vnic: true`) and a public subnet `10.0.0.0/24` [oci]. A managed DB system drops into the private subnet with no new network design. |
| **F11** | **L** | **18 migrations, run under an advisory lock with checksums** (`0001_org` … `0018_org_deleted_at`), entry point `yarn db:migrate`, health check `yarn db:ping` [code]. Better Auth owns `0008_auth.sql` and its own 2-connection pool [code]. A greenfield target needs only `db:migrate`; there is no schema drift to reconcile, because there is no old schema to reconcile against. |
| **F12** | **L** | **Only `us-ashburn-1` is subscribed** [oci]. Every resource here lands in IAD; latency from the owner's network is a given, not a choice, unless a region is added. |
| **F13** | **H** | **The `campaign-foundry` namespace on solstice exists and is EMPTY** [verified 2026-11-13, `kubectl get all,ingressroute,clusters.postgresql.cnpg.io,pvc -n campaign-foundry` → `No resources found`]. It was created ~2026-10-27 (17d) and never filled: no workload, no service, no route, no database, no PVC. Retired midnight is unreachable (`campaign-foundry.midnight.lan` → HTTP 000). So **no staging environment exists on either host** — solstice holds a reserved name, nothing more. |
| **F14** | **M** | **solstice's k3s routes with Traefik `IngressRoute` CRDs, not core `Ingress`** — `kubectl get ingress -A` returns nothing cluster-wide while `hexagen-site`, `krakowski-cloud`, `martinkrakowski-com` and `fleet-v2` are all served [verified 2026-11-13]. The 404s measured against every campaign-foundry hostname remain valid evidence that no route matches; the earlier reading of them as "no Ingress object" named the wrong resource type. Any redeploy writes `IngressRoute`, not the `Ingress` in `deploy/staging/app.yaml`. |
| **F15** | **H** | **A Postgres operator is already running on solstice, cluster-wide.** `cnpg-system` runs CloudNativePG with `plugin-barman-cloud` (object-storage backups), 25d old, alongside cert-manager, external-secrets, flux, kyverno, keda, strimzi and a VictoriaMetrics stack [verified 2026-11-13]. Nothing is provisioned for campaign-foundry — but the **capability** to run an operator-managed, backed-up Postgres at no cost exists today, on a host the owner already operates. This is the basis of option (c) in §3. |
| **F16** | **M** | **Staging now runs the whole rollout path, and it works** [verified 2026-11-13]. campaign-foundry is live on solstice via platform PR #76: a CloudNativePG `db`, all 18 migrations applied by an initContainer, 23 tables confirmed by querying Postgres, and the site serving. `yarn import plan` then ran against that live database and answered **4 importable, 0 refused briefs** (digest `a5bc46d1599e`), with the 99 `.md` lane briefs correctly counted as non-brief files and the 8 samples skipped. `apply` is gated on the bucket (F17). So the feature in D249 is no longer theoretical: the only untested step is the write itself. |
| **F17** | **H** | **The importer refuses to write without an object store.** `applyGuards()` answers `apply needs OBJECT_STORE=s3, and OBJECT_STORE is fs` before touching anything [code: `apply.ts:85-90`, pinned by `apply.test.ts:380`], because asset bytes belong in the bucket and a render key derives from a campaign uuid [code: `config.ts:159`]. **The database and the bucket are therefore one deliverable, not two** — which is exactly how the owner described the rollout. OCI bucket `campaign-foundry-staging` was created 2026-11-13 and platform PR #77 wires it; it waits on a Vault-held key. |

---

## 2. Decisions

| id | Decision | Why / consequence |
|---|---|---|
| **D247** | **The target host. UNSTAMPED — this is Q1.** Option **(a)** OCI Database with PostgreSQL, managed, `…E5.Flex.2.32GB` in the private subnet. Option **(b)** self-managed Postgres on a **new** Always Free A1 instance (2 OCPU / 12 GB, beside `prod-node-1`). Option **(c)**, added 2026-11-13 after F15 and **outside the stated OCI brief**: a CloudNativePG `Cluster` in solstice's already-empty `campaign-foundry` namespace. | The whole plan forks here. (a) buys managed backups, patching and server TLS, and costs real money at a floor well above the plan that was just retired (F3). (b) is £0 and fits the Always Free headroom exactly (F8), and costs the owner backups, patching and a certificate he must issue himself (D251). **Recommendation: (b) now, (a) when the project is production.** That is the same shape as D201, where the owner deferred B2 until "full working order before production". |
| **D248** | **The route in, decided by D247.** Under (a): OCI Bastion (managed, no public IP, session-scoped) as the default, with a public-subnet jump host as the fallback. Under (b): the instance sits in the **private** subnet and is reached the same way — never by giving a database a public IP. | F2 removes the public endpoint the code currently assumes. A bastion keeps the database off the internet in both options; it also means `yarn dev` needs a tunnel up, which is a real change to the daily loop and must be written down in the README, not discovered. |
| **D249** | **The database starts empty, takes its schema from `yarn db:migrate`, and is filled by `yarn import` from the filesystem store — as a feature, not a restore.** Nothing is carried over from Aiven because nothing was ever in it (F1). | The file stores are the source of record until the importer runs, so an empty database is the correct starting state, not a degraded one. PT-3d notes that an import does not preserve brief revisions [intent]: on a first-ever import there is no prior revision to preserve, so that caveat costs nothing here. |
| **D250** | **The pool constants stop being Aiven's plan.** `MAX_POOL` / `DEFAULT_POOL_MAX` become configuration with a documented default sized to the chosen host, and the comments naming Aiven's 15 go. `AUTH_POOL_MAX + DATABASE_POOL_MAX <= MAX_POOL` is kept as the invariant, because that one *is* a domain rule. | F4. Carrying a dead vendor's connection cap into a new host is how a limit outlives its reason and nobody can say why it is 15. |
| **D251** | **TLS stays mandatory, and the CA file is explicit.** `databaseConfig` keeps refusing a remote host without `DATABASE_CA_PATH` [code]; only the *operator instruction* in the error changes. Under D247(a) the CA is OCI's; under (b) the owner issues one and the server is configured for it. | F5. The current refusal is correct and should not be weakened to get the dev loop running again — that would trade a visible failure for an invisible one. |
| **D252** | **The Aiven rename is scoped, and `.agents/tech-stack.md` needs an explicit ask.** Code, tests, deploy READMEs and the F5 error string move in DB-1e. Spec files under `.agents/` move only when the owner asks, per AGENTS.md. Historical planning docs are **not** rewritten — they record what was true. | F6. Editing a spec as a side effect is exactly what AGENTS.md's "Files Never Edit" table exists to stop. |

---

## 3. The fork, stated plainly

| | **(a) OCI Database with PostgreSQL** | **(b) Self-managed on Always Free A1** | **(c) CloudNativePG on solstice** |
|---|---|---|---|
| Floor | 2 OCPU / 32 GB, no free tier [oci] | 2 OCPU / 12 GB, £0, fits beside `prod-node-1` with nothing spare [oci] | Shares solstice (112 threads, already host to 25+ namespaces) |
| Cost | Real, recurring, **must be priced before Q1** | None | None |
| Backups | Managed, plus PITR [oci: `pitr-details`, `backup`] | The owner's job (`pg_dump` to Object Storage on a timer) | Barman plugin, already installed (F15) |
| Patching | Managed | The owner's job | Operator-managed |
| Server TLS | Provided | The owner issues a cert and wires it (D251) | cert-manager is already in the cluster |
| Reachability | Private subnet only (F2) | Private subnet by choice (D248) | On the owner's LAN; no tunnel for the Mac |
| Connection ceiling | Shape-dependent, far above 15 | Tunable in `postgresql.conf` | Tunable in the `Cluster` spec |
| Risk it carries | Spending more than the thing that was retired for cost | Operational work landing on one person, and a restore path that is only as good as the last time it was tested | **It is not Oracle Cloud** — it does not do what was asked. One host becomes lane runner, build host and database. No off-site copy unless Barman targets one |

**On option (c), stated plainly:** it was not asked for. The brief said Oracle Cloud, and (c) is not Oracle Cloud. It is listed because F15 found the capability already running, free and backed up, and leaving that out of a cost comparison would be withholding the cheapest option on the table. **If the goal is "off the Mac, off a dead vendor, at no cost", (c) wins. If the goal is "on OCI", (c) is disqualified by definition.** Only the owner knows which goal is real — that is Q1.

**Recommendation among the OCI options: (b).** The signal in "Aiven, service already retired" is cost, and (a)'s floor is higher than the plan that was just given up. (b) is free, fits the existing estate exactly, and keeps the managed option open — the schema is 18 plain SQL migrations and the seed is a CLI, so moving (b)→(a) later is a `db:migrate` plus an `import`, not a rewrite. The cost of (b) is operational, and it should be taken only with D251's certificate and a **tested** restore, not an intended one.

---

## 4. Lanes

Sized per the house rule that a lane is one reviewable PR, not a 40-file diff.

| lane | What | Touches | Depends on | DoD / proof |
|---|---|---|---|---|
| **DB-1a** | **Price (a), and settle the rest of F7.** Availability is already measured (F7): E5 has 20, the generic counter 0. What remains is (i) a real monthly number for D247(a) from the OCI cost estimator and (ii) confirmation from Oracle support that the E5 family limit governs. Read-only; provisions nothing. | — | — | A recorded answer to Q1's cost half, and a yes/no on whether (a) is creatable in this tenancy today. **No resource is created in this lane.** Needed only if Q1 leans (a). |
| **DB-1b** | **Provision**, per the answer to Q1: either the managed DB system in the private subnet, or the second A1 with Postgres, TLS and a firewall. Plus D248's bastion. | infra only | Q1, DB-1a | `yarn db:ping` succeeds through the tunnel from the Mac. The database has **no** public IP. |
| **DB-1c** | **Schema and seed.** `yarn db:migrate` against the new host, then `yarn import plan` and `yarn import apply` from the checkout's fs store, with the result JSON kept. | — (uses existing tooling) | DB-1b | 18 migrations applied; a second `apply` reports `unchanged`, not `refused` (PT-8's own idempotence criterion); row counts recorded in the PR. |
| **DB-1d** | **Pool constants become configuration** (D250), with the `AUTH_POOL_MAX + DATABASE_POOL_MAX <= MAX_POOL` invariant kept and tested. | `database-config.ts` + its tests | DB-1b (to know the real ceiling) | A test proves the invariant still refuses an over-budget pair; no Aiven number survives in the module. |
| **DB-1e** | **Un-pick Aiven** (D252): code, tests, deploy READMEs, and the F5 operator instruction rewritten for the new host. | the 19 files minus `.agents/**` and historical plans | DB-1b | `git grep -ci aiven -- apps packages deploy` → 0. `.agents/` and `docs/planning/` untouched. |
| **DB-1f** | **Write the loop down.** README: how the tunnel comes up, what `DATABASE_CA_PATH` points at now, how staging reaches the database, and how a restore is tested. | README / deploy docs | DB-1b…e | A reader who has never seen this plan can start `yarn dev` from a clean machine. |

---

## 5. Definition of done

- `yarn dev` starts clean on the owner's Mac with no Aiven reference anywhere in the path it takes.
- The database holds no public IP, and the route to it is documented and repeatable.
- `yarn db:ping` and `yarn db:migrate` succeed; a second `yarn import apply` is a no-op.
- `DATABASE_CA_PATH` points at a real CA and `rejectUnauthorized: true` is still in force — TLS was never relaxed to get green.
- The pool ceiling is configuration with a stated reason, not a retired vendor's plan limit.
- **A restore has been performed, not merely configured.** Under D247(b) this is the lane's single most important proof.
- The PR states plainly that the database starts empty by design and is filled by the importer (D249) — never implying a restore.

---

## 6. Open questions

| id | Question | Why it blocks | My recommendation |
|---|---|---|---|
| **Q1** | **D247: OCI managed (a), OCI self-managed Always Free (b), or CloudNativePG on solstice (c) — and is "on OCI" the goal, or "off Aiven at no cost"?** | Every other lane's shape, and the whole cost envelope. (c) also makes D248's tunnel unnecessary. | If the OCI target is firm: **(b)**, with D251's certificate and a tested restore as non-negotiable. If the real goal is the cheapest sound home: **(c)**, per §3 and F15. I will not pick between those two for you — it is a question about intent, not engineering. |
| **Q2** | **ANSWERED 2026-11-13 (owner): Aiven was never populated.** The file stores are the whole truth, and the import is a feature of the rollout rather than a recovery. | Settled D249 and downgraded F1 from critical to a note. | No action. Kept here because r1 of this plan asserted the opposite, and a reader of the earlier revision deserves to see the correction rather than a silent edit. |
| **Q3** | **ANSWERED 2026-11-13 (F13): there is no staging environment anywhere.** midnight is unreachable and solstice's k3s has no campaign-foundry route. Remaining question: should DB-1 stand staging back up on solstice, or is that a separate plan? | Decides whether D248 must also solve a LAN→OCI route. | **A separate plan.** D248 solves the developer tunnel only; standing staging back up on solstice is its own piece of work (new hostnames, a new ClusterIssuer, a registry, and a `deploy.sh` that no longer names midnight). Do not let it ride in on DB-1b. |

---

## 7. What this plan deliberately does not do

- **It does not recover data from Aiven**, because there is none to recover (F1). r1 of this document claimed otherwise; that claim was wrong and is corrected rather than quietly removed.
- **It does not touch `prod-node-1`** (F8), the fleet repo, or `.agents/` specs (D252).
- **It does not quote a price** for option (a). DB-1a produces that number from the cost estimator; inventing one here would be the sort of confident guess that gets budgeted against.
