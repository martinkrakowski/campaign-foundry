# Staging (k3s on the LAN node)

Campaign Foundry's staging environment runs on the owner's k3s node `midnight`
(`ssh m`), reachable only on the local network or the VPN, at
**https://campaign-foundry.midnight.lan** (TLS from the cluster's self-signed
issuer). Production hosting is still open (plan §7); this is not it.

## What runs (namespace `campaign-foundry-staging`)

| Piece | How | Notes |
|---|---|---|
| Web + API | `app.yaml`: one Pod, two containers from one image | The web app proxies `/api/pipeline/*` to `127.0.0.1:3001`, fixed at build time; sharing the Pod keeps that right. |
| Files | PVC `campaign-foundry-data` (local-path, 20Gi) at `/data` | Briefs, input assets, fonts and output. Seeded from the image's samples on first start. |
| PostgreSQL | CloudNativePG `Cluster` `cf-pg` | TLS; the app verifies against the operator's CA (`cf-pg-ca`). Decisions live here (`STORE_BACKEND=postgres`). Separate from the Aiven database. |
| Kafka | Strimzi `Kafka` `cf-kafka`, KRaft, one node | TLS listener with client-certificate auth, as on Aiven. `KafkaUser` `campaign-foundry`. Unused until PT-6. |

No image-provider keys are configured, so renders are procedural and spend no
credits. To use real imagery, create a Secret with `GEMINI_API_KEY` or
`OPENROUTER_API_KEY` and reference it from the `api` container deliberately.

Object storage (D174c, Backblaze B2) is not set up: nothing uses it until PT-4.

## One-time setup (cluster-wide; the owner's to run)

The two operators are cluster-scoped installs:

```sh
ssh m
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm install cnpg cnpg/cloudnative-pg --version 0.29.1 \
  --namespace cnpg-system --create-namespace --wait
helm install strimzi oci://quay.io/strimzi-helm/strimzi-kafka-operator --version 1.2.0 \
  --namespace strimzi --create-namespace \
  --set "watchNamespaces={campaign-foundry-staging}" --wait
```

Pushing to Harbor needs the pushing Docker daemon to trust Harbor's certificate.
Harbor serves a cert-manager self-signed certificate that is reissued on renewal,
and the node's `/etc/docker/certs.d/registry.midnight.lan/ca.crt` expired on
2026-06-14. Refresh it (it pins the certificate Harbor serves now, so repeat it
after each renewal until Harbor gets a certificate from a stable CA):

```sh
ssh -t m 'echo | openssl s_client -connect registry.midnight.lan:443 -servername registry.midnight.lan 2>/dev/null \
  | openssl x509 | sudo tee /etc/docker/certs.d/registry.midnight.lan/ca.crt >/dev/null'
```

## Deploy

From a clean checkout of the commit to ship (Docker logged in to Harbor, a
`midnight` Docker context: `docker context create midnight --docker host=ssh://m`):

```sh
deploy/staging/deploy.sh
```

It builds on the node, pushes, applies `deploy/staging`, waits for Postgres, runs
the migrations (`jobs/migrate.yaml`), and restarts the app.

## Known limits

- One replica: the file stores assume one process, and the data volume is RWO.
- Google sign-in (PT-1) needs a public redirect URI; a `.lan` host can use
  email sign-in only.
