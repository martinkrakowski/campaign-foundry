# Staging (k3s on the LAN node)

Campaign Foundry's staging environment runs on the owner's k3s node `midnight`
(`ssh m`), reachable only on the local network or the VPN, at
**https://campaign-foundry.midnight.lan** (TLS from the cluster's self-signed
issuer). Production hosting is still open
(`docs/planning/2026-09-24_platform-and-tenancy.md`, §7 "What the owner is deciding"); this is not it.

## What runs (namespace `campaign-foundry-staging`)

| Piece | How | Notes |
|---|---|---|
| Web + API | `app.yaml`: one Pod, two containers from one image | The web app proxies `/api/pipeline/*` to `127.0.0.1:3001`, fixed at build time; sharing the Pod keeps that right. |
| Files | PVC `campaign-foundry-data` (local-path, 20Gi) at `/data` | Briefs, input assets, fonts and output. Seeded from the image's samples on first start. |
| PostgreSQL | CloudNativePG `Cluster` `cf-pg` | TLS; the app verifies against the operator's CA (`cf-pg-ca`). Migrated on every deploy. The app runs `STORE_BACKEND=fs` until PT-8 imports the seeded file data; switching to `postgres` before then would show empty tables. Separate from the Aiven database. |
| Kafka | Strimzi `Kafka` `cf-kafka`, KRaft, one node | TLS listener with client-certificate auth, as on Aiven. `KafkaUser` `campaign-foundry`. Unused until PT-6. |

No image-provider keys are configured, so renders are procedural and spend no
credits. To use real imagery, create a Secret with `GEMINI_API_KEY` or
`OPENROUTER_API_KEY` and reference it from the `api` container deliberately.

Object storage (D174c, Backblaze B2) is not set up: nothing uses it until PT-4.

## One-time setup (cluster-wide; done 2026-09-25)

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

Pushing to Harbor needs the pushing Docker daemon to trust Harbor's certificate,
in **two** places. Docker's containerd image store checks
`/etc/docker/certs.d/<registry>/ca.crt` for the registry requests, but its login
(token) request uses the **system** trust store. Harbor serves a cert-manager
self-signed certificate, which is reissued at every renewal, so both copies pin the
certificate Harbor serves now. Repeat both after each renewal, until Harbor's
certificate comes from a stable CA (a self-signed root CA Issuer in cert-manager,
trusted once):

```sh
# in your own terminal: sudo asks for a password. The certificate is read from
# Harbor's own Kubernetes Secret over the authenticated cluster API, not from the
# network, so an intercepted TLS connection cannot plant a trust root.
ssh -t m 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n registry get secret harbor-ingress -o jsonpath="{.data.tls\.crt}" \
  | base64 -d | openssl x509 | sudo tee /etc/docker/certs.d/registry.midnight.lan/ca.crt >/dev/null'
ssh -t m 'sudo cp /etc/docker/certs.d/registry.midnight.lan/ca.crt /usr/local/share/ca-certificates/registry.midnight.lan.crt \
  && sudo update-ca-certificates && sudo systemctl restart docker'
```

Restarting Docker restarts the node's Docker containers (not k3s). `curl` still
reports "couldn't get X509-issuer name" for this certificate, because it has an
empty subject; Docker and `openssl` verify it.

## Deploy

From a clean checkout of the commit to ship (Docker logged in to Harbor, a
`midnight` Docker context: `docker context create midnight --docker host=ssh://m`):

```sh
yarn deploy:staging   # runs deploy/staging/deploy.sh
```

It shows the commit and asks before building. Without a terminal (a script, CI or an
agent) it refuses unless given `--yes`, and any other argument is refused, so a stray
`--help` never deploys.

It builds on the node, pushes, applies `deploy/staging`, waits for Postgres, runs
the migrations (`jobs/migrate.yaml`), and restarts the app.

## Known limits

- One replica: the file stores assume one process, and the data volume is RWO.
- Google sign-in (PT-1) needs a public redirect URI; a `.lan` host can use
  email sign-in only.
