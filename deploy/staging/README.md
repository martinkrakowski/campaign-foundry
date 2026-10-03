# Staging (k3s on the LAN node)

Campaign Foundry's staging environment runs on the owner's k3s node `midnight`
(`ssh m`), reachable only on the local network or the VPN, at
**https://campaign-foundry.midnight.lan** (TLS from the cluster's own issuer,
`midnight-ca`). Production hosting is still open
(`docs/planning/2026-09-24_platform-and-tenancy.md`, §7 "What the owner is deciding"); this is not it.

## What runs (namespace `campaign-foundry-staging`)

| Piece | How | Notes |
|---|---|---|
| Web + API | `app.yaml`: one Pod, two containers from one image | The web app proxies `/api/pipeline/*` to `127.0.0.1:3001`, fixed at build time; sharing the Pod keeps that right. |
| Files | PVC `campaign-foundry-data` (local-path, 20Gi) at `/data` | Briefs, input assets, fonts and output. Seeded from the image's samples on first start. |
| PostgreSQL | CloudNativePG `Cluster` `cf-pg` | TLS; the app verifies against the operator's CA (`cf-pg-ca`). Migrated on every deploy. The app runs `STORE_BACKEND=postgres` and `AUTH_MODE=better-auth` (since 2026-09-26: staging is where the platform is proven), so it starts with empty tables until PT-8 imports the seeded file data. Separate from the Aiven database. |
| Kafka | Strimzi `Kafka` `cf-kafka`, KRaft, one node | TLS listener with client-certificate auth, as on Aiven. `KafkaUser` `campaign-foundry`, with ACLs on topic `cf.run-requests` and group `cf-workers`. The API publishes queued runs there and consumes them itself (`KAFKA_CONSUME=true`, PT-6b2/PT-6b3); its client certificate and the cluster CA are mounted under `/data/certs`. |
| Object store | `seaweedfs.yaml`: one SeaweedFS Pod (master, volume server, filer and S3 gateway), Service `seaweedfs-s3` on 8333 | In-cluster on `http://seaweedfs-s3:8333`, and from a browser on **https://s3.midnight.lan** (path-style, `midnight-ca`) so a presigned URL is the same URL on both sides. Bucket `campaign-foundry`, created by `jobs/s3-bootstrap.yaml` on every deploy. Nothing reaches it over the app yet — `S3_*` arrives with PT-4j. |

No image-provider keys are configured, so renders are procedural and spend no
credits. To use real imagery, create a Secret with `GEMINI_API_KEY` or
`OPENROUTER_API_KEY` and reference it from the `api` container deliberately.

Object storage is SeaweedFS on this node (D201, replacing D174c's Backblaze B2,
which waits for production). Versioning and object lock stay **off**
(seaweedfs#8073): staging must behave like the cloud bucket it will become.

## One-time setup (cluster-wide; done 2026-09-25)

**Kubeconfig (2026-10-01):** every command here, and `deploy.sh`, uses a private copy at `~/.kube/config` on midnight (`0600`, owned by the operator), never the cluster-admin `/etc/rancher/k3s/k3s.yaml`, which is being moved to `0600 root`. One-time:

```sh
ssh m
mkdir -p ~/.kube && chmod 700 ~/.kube
sudo install -m 600 -o "$USER" -g "$USER" /etc/rancher/k3s/k3s.yaml ~/.kube/config
```

If the cluster CA or admin cert rotates, rerun the `install` line.

The two operators are cluster-scoped installs:

```sh
ssh m
export KUBECONFIG=$HOME/.kube/config
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
ssh -t m 'KUBECONFIG=$HOME/.kube/config kubectl -n registry get secret harbor-ingress -o jsonpath="{.data.tls\.crt}" \
  | base64 -d | openssl x509 | sudo tee /etc/docker/certs.d/registry.midnight.lan/ca.crt >/dev/null'
ssh -t m 'sudo cp /etc/docker/certs.d/registry.midnight.lan/ca.crt /usr/local/share/ca-certificates/registry.midnight.lan.crt \
  && sudo update-ca-certificates && sudo systemctl restart docker'
```

Restarting Docker restarts the node's Docker containers (not k3s). `curl` still
reports "couldn't get X509-issuer name" for this certificate, because it has an
empty subject; Docker and `openssl` verify it.

### Auth secret (once, owner)

Staging runs Better Auth (`AUTH_MODE=better-auth`), which needs a secret of at least 32
characters. It is generated on the node, so it never touches a laptop or the repo. On a fresh
cluster, create the namespace first (the deploy would otherwise create it):

```sh
ssh m 'KUBECONFIG=$HOME/.kube/config kubectl create namespace campaign-foundry-staging --dry-run=client -o yaml | KUBECONFIG=$HOME/.kube/config kubectl apply -f -'
ssh m 'KUBECONFIG=$HOME/.kube/config kubectl -n campaign-foundry-staging create secret generic campaign-foundry-auth --from-literal=secret="$(openssl rand -hex 32)"'
```

`deploy.sh` checks it before building anything, and refuses while it is missing, has no
`secret` key, or is shorter than 32 characters.

### Object store (once, owner)

Four steps, in this order. `deploy.sh` refuses to deploy until **steps 1 and 3**
are done and until the `midnight-ca` ClusterIssuer exists — it checks all three
before it builds anything, because each one only fails visibly after a build and
a rollout. It also refuses a key that is not lowercase hex: the Pod writes these
values straight into JSON, so a quote or a newline in one would leave a corrupt
`s3.json`. The first deploy after step 2 is the first that can pull the image.

**1. The data directory.** The object data (the `.dat` volumes) lives on the
`/mnt/pool` mergerfs, 18 TB free; the master's metadata, the `.idx` files and the
filer's LevelDB stay on local disk, on the `seaweedfs-metadata` PVC. The Pod runs
as uid 1000, so the directory is created here, owned by 1000:1000. `seaweedfs.yaml`
mounts it as a hostPath of type `Directory` and never `DirectoryOrCreate`, because a
kubelet-created directory is root-owned and `fsGroup` does not apply to a
hostPath. Nothing creates the directory below it either — the Pod makes its own
`data` on start — but the root itself must exist, or `type: Directory` leaves the
Pod with nothing to mount and it crash-loops. `deploy.sh` checks this before it
builds.

```sh
ssh m 'sudo install -d -o 1000 -g 1000 -m 750 /mnt/pool/campaign-foundry-staging/seaweedfs'
```

**2. Mirror the image into Harbor.** The cluster pulls only from
`registry.midnight.lan`, so `chrislusf/seaweedfs:4.48` is pulled once, re-tagged
and pushed:

```sh
docker --context midnight pull chrislusf/seaweedfs:4.48 && docker --context midnight tag chrislusf/seaweedfs:4.48 registry.midnight.lan/library/seaweedfs:4.48 && docker --context midnight push registry.midnight.lan/library/seaweedfs:4.48
```

`seaweedfs.yaml` pins the tag; the orchestrator adds the digest at deploy time.

**3. The identities secret.** Two identities: an `admin` key that may create
and delete buckets, and an app key scoped to the one bucket `campaign-foundry`.
There is no anonymous identity, so an unsigned or wrongly-keyed request is denied.
The single quotes keep `$(openssl …)` inside the ssh command, so the keys are
generated **on the node** and never touch a laptop or the repo, and
`KUBECONFIG=$HOME/.kube/config` resolves there too:

```sh
ssh m 'KUBECONFIG=$HOME/.kube/config kubectl -n campaign-foundry-staging create secret generic seaweedfs-s3 --from-literal=admin-access-key="$(openssl rand -hex 16)" --from-literal=admin-secret-key="$(openssl rand -hex 32)" --from-literal=app-access-key="$(openssl rand -hex 16)" --from-literal=app-secret-key="$(openssl rand -hex 32)"'
```

The access keys are 32 hex characters, so they clear the 32-byte minimum
`deploy.sh` checks — as do the 64-character secret keys. `deploy.sh` measures all
four with `base64 -d | wc -c` and never prints a value; the Pod reads them into
`/etc/seaweedfs/s3.json` and the bootstrap Job writes its curl config to an
emptyDir, so a key never appears in `ps` either. Changing a key means recreating
the Secret and then restarting the Pod: `weed` reads the identities file once, at
startup.

**4. Trust `midnight-ca` in the browser.** Both Ingresses now get their
certificate from the cluster's own issuer, `midnight-ca`, instead of a
self-signed one, so the browser needs that CA once. Export it to a file:

```sh
ssh m 'KUBECONFIG=$HOME/.kube/config kubectl -n cert-manager get secret midnight-ca -o jsonpath="{.data.ca\.crt}"' | base64 -d > midnight-ca.crt
```

Then trust it. On macOS (Safari and Chrome use the Keychain):

```sh
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain midnight-ca.crt
```

Firefox keeps its own store: Settings → Privacy & Security → Certificates → View
Certificates → Authorities → Import. On Debian/Ubuntu: `sudo cp midnight-ca.crt
/usr/local/share/ca-certificates/midnight-ca.crt && sudo update-ca-certificates`.

It is read from the cluster's own Kubernetes Secret over the authenticated
cluster API, not fetched over the network, so an intercepted TLS connection
cannot plant a trust root — the same reasoning as the Harbor CA above. Never
reach for `curl -k`, which proves nothing about who signed the response; delete
the file once it is imported.

### What may reach the store (every deploy)

`weed server` binds every listener to `0.0.0.0`: the S3 gateway on 8333, and
beside it the master, the filer, the gRPC ports and the volume port, all
unauthenticated HTTP. Hiding them from the Service and the Ingress is not enough,
because any pod in the cluster can still dial the Pod IP directly and skip S3 auth.
So `seaweedfs.yaml` carries a NetworkPolicy `seaweedfs` with **one** ingress rule:
TCP 8333 only, from pods in this namespace (the app's `api` container and the
`s3-bootstrap` Job) and from Traefik in `kube-system`. Egress is not restricted, so
the app still resolves and still reaches Postgres and Kafka. The Pod's own
components talk over loopback, which no policy touches, and the kubelet's readiness
probe comes from the node, which k3s's kube-router always allows.

After a deploy the orchestrator verifies it from a throwaway pod, because a policy
that is wrong in the permissive direction is silent: the `curl` on 8888 **must time
out**, and the `curl` on 8333 must answer **200**. The first is the check that
matters — if it answers anything at all, something is reaching past the signature.

### Resend key (once, owner)

Sign-in links are sent through Resend's HTTP API (D174b) from
`campaign-foundry@midnight.krakowski.cloud`. The domain's DKIM and SPF are verified in
Resend, and sending needs nothing else. The API key lives in the namespace's own secret,
`campaign-foundry-resend` (key `api-key`). The key is read with echo off on YOUR terminal
and piped to the node, so it is never shown, never lands in shell history, and never touches
the repo. (A `read -s` inside `ssh m '…'` would run on the node, which has no terminal to
silence, so a pasted key would echo locally.)

```sh
printf 'Resend API key: '; read -rs KEY; echo; [ -n "$KEY" ] && printf %s "$KEY" | ssh m 'export KUBECONFIG=$HOME/.kube/config; kubectl -n campaign-foundry-staging create secret generic campaign-foundry-resend --from-file=api-key=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -' || echo "no key entered"; unset KEY
```

This works in bash and zsh, and `create --dry-run=client | apply` also replaces an existing
secret, so it doesn't matter whether this is the first run. Paste the key at the prompt, **one
line at a time**: if the whole block is pasted at once, `read` takes the next pasted line as the
key. When already on the node, drop the `ssh m '…'` wrapper and `export KUBECONFIG` first.
Confirm the key landed without showing it; a Resend key is 36 characters, which is 48 in base64:

```sh
ssh m 'KUBECONFIG=$HOME/.kube/config kubectl -n campaign-foundry-staging get secret campaign-foundry-resend -o go-template="{{len (index .data \"api-key\")}}"'
```

If staging is already running, restart it so the pod picks the key up. On a fresh cluster, skip
this; the first deploy reads the secret:

```sh
ssh m 'KUBECONFIG=$HOME/.kube/config kubectl -n campaign-foundry-staging rollout restart deploy/campaign-foundry'
```

The secret is optional in `app.yaml`, so a deploy without it still works and falls back to
the log below.

### First sign-in (once, owner)

With the Resend key in place, request a link on https://campaign-foundry.midnight.lan/sign-in
and it arrives by email. **Without it**, the magic link is written to the API log, and
**anyone who can read that log can sign in as whoever requested a link**, so on staging log
access is then account access. Read it with:

```sh
ssh m 'KUBECONFIG=$HOME/.kube/config kubectl -n campaign-foundry-staging logs deploy/campaign-foundry -c api | grep "sign-in link" | tail -1'
```

After that first sign-in, make the account the owner of the `local` org:

```sh
ssh m 'KUBECONFIG=$HOME/.kube/config kubectl -n campaign-foundry-staging exec deploy/campaign-foundry -c api -- node node_modules/tsx/dist/cli.mjs apps/api/bin/auth-cli.ts you@example.com'
```

## Deploy

From a clean checkout of the commit to ship (Docker logged in to Harbor, a
`midnight` Docker context: `docker context create midnight --docker host=ssh://m`):

```sh
yarn deploy:staging   # runs deploy/staging/deploy.sh
```

It shows the commit and asks before building. Without a terminal (a script, CI or an
agent) it refuses unless given `--yes`, and any other argument is refused, so a stray
`--help` never deploys.

It builds on the node, pushes, applies `deploy/staging`, waits for SeaweedFS and
creates the bucket (`jobs/s3-bootstrap.yaml`), waits for Kafka and Postgres, runs
the migrations (`jobs/migrate.yaml`), and restarts the app.

## Known limits

- One replica: the file stores assume one process, and the data volume is RWO.
- Google sign-in (PT-1) needs a public redirect URI; a `.lan` host can use
  email sign-in only.
