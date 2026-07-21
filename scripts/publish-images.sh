#!/bin/sh
set -eu

APP_NAME="bailinghub"
DEFAULT_REGISTRY="crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com"
DEFAULT_NAMESPACE="bailinghub"

REGISTRY="${BAILING_IMAGE_REGISTRY:-$DEFAULT_REGISTRY}"
NAMESPACE="${BAILING_IMAGE_NAMESPACE:-$DEFAULT_NAMESPACE}"
PACKAGE_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
TAG="${BAILING_IMAGE_TAG:-$PACKAGE_VERSION}"
[ -n "$TAG" ] || TAG="0.1.5"
NODE_IMAGE="${BAILING_NODE_IMAGE:-node:22-bookworm-slim}"
PLATFORM="${BAILING_IMAGE_PLATFORM:-linux/amd64}"
PUSH="${BAILING_PUSH_IMAGES:-0}"

AI_IMAGE="$REGISTRY/$NAMESPACE/bailinghub:$TAG"
AI_IMAGE_LATEST="$REGISTRY/$NAMESPACE/bailinghub:latest"
DEMO_IMAGE="$REGISTRY/$NAMESPACE/bailing-demo-business:$TAG"
DEMO_IMAGE_LATEST="$REGISTRY/$NAMESPACE/bailing-demo-business:latest"

log() { printf '%s\n' "[$APP_NAME images] $*"; }

log "build $AI_IMAGE ($PLATFORM)"
docker build \
  --platform "$PLATFORM" \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  -t "$AI_IMAGE" \
  -t "$AI_IMAGE_LATEST" \
  .

log "build $DEMO_IMAGE ($PLATFORM)"
docker build \
  --platform "$PLATFORM" \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  -t "$DEMO_IMAGE" \
  -t "$DEMO_IMAGE_LATEST" \
  ./demo/business

if [ "$PUSH" = "1" ]; then
  log "push $AI_IMAGE"
  docker push "$AI_IMAGE"
  docker push "$AI_IMAGE_LATEST"
  log "push $DEMO_IMAGE"
  docker push "$DEMO_IMAGE"
  docker push "$DEMO_IMAGE_LATEST"
else
  cat <<EOF

[$APP_NAME images] build complete, push skipped.

To push:
  docker login --username=<aliyun-account> $REGISTRY
  BAILING_PUSH_IMAGES=1 npm run images:publish

Images:
  $AI_IMAGE
  $AI_IMAGE_LATEST
  $DEMO_IMAGE
  $DEMO_IMAGE_LATEST

EOF
fi
