#!/bin/sh
# Build, push and roll out staging (deploy/staging/README.md).
#
# The image is built from `git archive HEAD` — tracked files only, so no
# .env.local, operator briefs or certificates can reach a layer — on the
# cluster's own amd64 node through a Docker context over SSH, and pushed to
# Harbor. The manifests are rendered here and applied on the node.
#
#   yarn deploy:staging          asks before building (needs a terminal)
#   yarn deploy:staging --yes    deploys without asking (scripts, agents)
#
# Anything else is refused, so a stray `--help` or typo never deploys.
set -eu

CONFIRMED=no
for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRMED=yes ;;
    *)
      echo "usage: yarn deploy:staging [--yes]" >&2
      exit 2
      ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "deploy.sh: the tree has changes; the image is built from HEAD, so commit or stash first." >&2
  exit 1
fi

TAG=$(git rev-parse --short HEAD)
IMAGE="registry.midnight.lan/library/campaign-foundry:$TAG"
CONTEXT="${STAGING_DOCKER_CONTEXT:-midnight}"
NODE="${STAGING_SSH:-m}"
NS=campaign-foundry-staging
remote() { ssh "$NODE" "KUBECONFIG=\$HOME/.kube/config $*"; }

if [ "$CONFIRMED" != yes ]; then
  if [ ! -t 0 ]; then
    echo "deploy.sh: no terminal to confirm on; pass --yes to deploy $TAG to staging." >&2
    exit 1
  fi
  printf 'Deploy %s (%s) to staging (https://campaign-foundry.midnight.lan)? [y/N] ' \
    "$TAG" "$(git log -1 --format=%s)"
  read -r answer
  case "$answer" in
    y | Y | yes) ;;
    *)
      echo "Not deployed."
      exit 1
      ;;
  esac
fi

# Better Auth needs a secret of at least 32 characters, or the API refuses to
# boot and the Recreate rollout leaves staging down. It is created once, on the
# node, by the owner (README "Auth secret"). Checked before anything is built,
# pushed or migrated; only its length leaves the node, never its value.
echo "==> auth secret"
SECRET_LEN=$(remote "kubectl -n $NS get secret campaign-foundry-auth -o jsonpath={.data.secret} 2>/dev/null | base64 -d 2>/dev/null | wc -c" | tr -d ' ')
if [ "${SECRET_LEN:-0}" -lt 32 ]; then
  echo "deploy.sh: secret campaign-foundry-auth is missing, has no \"secret\" key, or is shorter than 32 characters; create it (deploy/staging/README.md, \"Auth secret\") and deploy again." >&2
  exit 1
fi

# The object store's identities: an admin key that may create and delete buckets,
# and an app key scoped to the one bucket (D201). Created by the owner (README
# "Object store (once, owner)", step 3). Checked here too, for the same reason and
# the same way: weed boots with an unreadable identities file, the bucket never
# appears and the app has nothing to talk to, so this must fail before the build
# and not after it. Length is not enough on its own: the initContainer printf's
# these values into JSON string literals, so a quote, a backslash or a newline
# would pass a length check and then leave a corrupt s3.json behind.
#
# Since PT-4j the app keys are the `api` container's own object-store identity
# (secretKeyRef, app.yaml), and neither is optional, so this same check is also
# what keeps the app Pod out of CreateContainerConfigError: a missing mandatory
# key is a Pod that never starts, and the kubelet only says so after Recreate
# has already stopped the one that was running.
echo "==> object-store secret"
for key in admin-access-key admin-secret-key app-access-key app-secret-key; do
  SECRET_LEN=$(remote "kubectl -n $NS get secret seaweedfs-s3 -o jsonpath={.data.$key} 2>/dev/null | base64 -d 2>/dev/null | wc -c" | tr -d ' ')
  if [ "${SECRET_LEN:-0}" -lt 32 ]; then
    echo "deploy.sh: secret seaweedfs-s3 is missing, has no \"$key\" key, or that value is shorter than 32 bytes; create it (deploy/staging/README.md, \"Object store (once, owner)\", step 3) and deploy again." >&2
    exit 1
  fi
  if ! remote "kubectl -n $NS get secret seaweedfs-s3 -o jsonpath={.data.$key} 2>/dev/null | base64 -d 2>/dev/null | grep -Eqxz '[0-9a-f]+'"; then
    echo "deploy.sh: secret seaweedfs-s3 key $key must be lowercase hex (README \"Object store (once, owner)\" step 3)" >&2
    exit 1
  fi
done

# The hostPath the object data lives on. seaweedfs.yaml mounts it with type
# Directory, so nothing creates it, and the Pod runs as uid 1000: if the
# directory is absent or owned by anyone else, weed's TestFolderWritable Fatalf's
# and the Pod crash-loops — but only after the image was built and pushed.
# Checked here, on the node, before the build.
echo "==> object-store data directory"
DATA_DIR_UID=$(remote "stat -c %u /mnt/pool/campaign-foundry-staging/seaweedfs 2>/dev/null" | tr -d ' ')
if [ "$DATA_DIR_UID" != 1000 ]; then
  echo "deploy.sh: /mnt/pool/campaign-foundry-staging/seaweedfs is missing or not owned by uid 1000 on $NODE; run README \"Object store (once, owner)\", step 1 and deploy again." >&2
  exit 1
fi

# Both certificates now come from midnight-ca, which must exist before the
# Ingresses that name it or cert-manager logs a failed issuer and leaves them on
# the old, self-signed one.
echo "==> TLS issuer"
if ! remote "kubectl get clusterissuer midnight-ca -o name" >/dev/null 2>&1; then
  echo "deploy.sh: ClusterIssuer midnight-ca is missing; create it (cert-manager) or the Ingresses stay on their previous certificate." >&2
  exit 1
fi

echo "==> build $IMAGE on $CONTEXT"
git archive --format=tar HEAD | docker --context "$CONTEXT" build -t "$IMAGE" -
echo "==> push"
docker --context "$CONTEXT" push "$IMAGE"

# Every deploy leaves a ~1.8 GB image on midnight's Docker, whose data lives on the
# root SSD; twenty of them filled it (2026-10-05). The registry holds every tag and
# k3s pulls from the registry, never from these local images, so keep only the two
# newest locally. A failed removal never fails the deploy.
echo "==> prune local images (keep the 2 newest)"
if ! local_images=$(docker --context "$CONTEXT" image ls \
  --format "{{.CreatedAt}}|{{.Repository}}:{{.Tag}}" registry.midnight.lan/library/campaign-foundry); then
  echo "deploy.sh: could not list local images; prune skipped (old images remain on midnight)" >&2
else
  printf '%s\n' "$local_images" | sort -r | tail -n +3 | cut -d"|" -f2 |
    while read -r old; do
      [ -n "$old" ] || continue
      docker --context "$CONTEXT" rmi "$old" >/dev/null 2>&1 ||
        echo "deploy.sh: could not remove $old (kept)" >&2
    done
fi

# The app must not start before its migrations have run: everything but the app's
# own Deployment is applied first, then the migration, and only then the app. The
# app is therefore selected by NAME as well as by kind — matching `kind: Deployment`
# alone would put SeaweedFS's Deployment in the app phase and leave staging without
# an object store until the app was already up.
RENDERED=$(kubectl kustomize deploy/staging | sed "s#registry.midnight.lan/library/campaign-foundry:latest#$IMAGE#")
only_app() { node -e 'const d=require("fs").readFileSync(0,"utf8").split(/\n---\n/);const isApp=x=>/^kind: Deployment$/m.test(x)&&/^  name: campaign-foundry$/m.test(x);process.stdout.write(d.filter(x=>isApp(x)===(process.argv[1]==="app")).join("\n---\n"))' "$1"; }

echo "==> apply services"
printf '%s\n' "$RENDERED" | only_app services | remote kubectl apply -f -

# The bucket exists before anything that could ask for it, and it exists before
# the migrations run: the object store is part of the platform the app boots on.
echo "==> wait for SeaweedFS"
remote kubectl -n "$NS" rollout status deployment/seaweedfs --timeout=5m
echo "==> create the bucket"
remote kubectl -n "$NS" delete job s3-bootstrap --ignore-not-found
cat deploy/staging/jobs/s3-bootstrap.yaml | remote kubectl apply -f -
remote kubectl -n "$NS" wait job/s3-bootstrap --for=condition=complete --timeout=5m

# The app's own key, against the bucket, before the app is applied. The boot
# guard reads the six S3_* variables and opens no socket, so a wrong bucket name
# or a key that does not match the identities file the SeaweedFS Pod wrote at
# startup passes it — and then every read answers ENOENT, a missing logo rather
# than a misconfiguration. This runs after the bucket exists and before the
# rollout, so the deploy stops while the old Pod is still serving.
echo "==> prove the app key"
remote kubectl -n "$NS" delete job s3-app-probe --ignore-not-found
cat deploy/staging/jobs/s3-app-probe.yaml | remote kubectl apply -f -
if ! remote kubectl -n "$NS" wait job/s3-app-probe --for=condition=complete --timeout=2m; then
  remote kubectl -n "$NS" logs job/s3-app-probe || true
  echo 'deploy.sh: the app key cannot round-trip an object in bucket campaign-foundry; see the probe log above' >&2
  exit 1
fi

# The API consumes cf.run-requests at boot (KAFKA_CONSUME=true), so the topic and
# the user's ACLs must be ready before the new app starts.
echo "==> wait for Kafka"
remote kubectl -n "$NS" wait kafkatopic/cf.run-requests --for=condition=Ready --timeout=5m
remote kubectl -n "$NS" wait kafkauser/campaign-foundry --for=condition=Ready --timeout=5m

echo "==> wait for Postgres"
remote kubectl -n "$NS" wait cluster/cf-pg --for=condition=Ready --timeout=10m

echo "==> migrate"
remote kubectl -n "$NS" delete job cf-migrate --ignore-not-found
sed "s#IMAGE_TAG#$TAG#" deploy/staging/jobs/migrate.yaml | remote kubectl apply -f -
remote kubectl -n "$NS" wait job/cf-migrate --for=condition=complete --timeout=5m

echo "==> roll out"
printf '%s\n' "$RENDERED" | only_app app | remote kubectl apply -f -
remote kubectl -n "$NS" rollout status deployment/campaign-foundry --timeout=10m
echo "==> https://campaign-foundry.midnight.lan ($TAG)"
