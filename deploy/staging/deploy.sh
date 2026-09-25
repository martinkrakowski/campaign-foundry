#!/bin/sh
# Build, push and roll out staging (deploy/staging/README.md).
#
# The image is built from `git archive HEAD` — tracked files only, so no
# .env.local, operator briefs or certificates can reach a layer — on the
# cluster's own amd64 node through a Docker context over SSH, and pushed to
# Harbor. The manifests are rendered here and applied on the node.
set -eu

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
remote() { ssh "$NODE" "KUBECONFIG=/etc/rancher/k3s/k3s.yaml $*"; }

echo "==> build $IMAGE on $CONTEXT"
git archive --format=tar HEAD | docker --context "$CONTEXT" build -t "$IMAGE" -
echo "==> push"
docker --context "$CONTEXT" push "$IMAGE"

# The new app must not start before its migrations have run: everything but the
# Deployment is applied first, then the migration, and only then the Deployment.
RENDERED=$(kubectl kustomize deploy/staging | sed "s#registry.midnight.lan/library/campaign-foundry:latest#$IMAGE#")
only_app() { node -e 'const d=require("fs").readFileSync(0,"utf8").split(/\n---\n/);process.stdout.write(d.filter(x=>/^kind: Deployment$/m.test(x)===(process.argv[1]==="app")).join("\n---\n"))' "$1"; }

echo "==> apply services"
printf '%s\n' "$RENDERED" | only_app services | remote kubectl apply -f -

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
