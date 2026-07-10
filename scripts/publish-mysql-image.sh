#!/bin/sh
set -eu

APP_NAME="bailinghub"
DEFAULT_REGISTRY="crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com"
DEFAULT_NAMESPACE="bailinghub"

REGISTRY="${BAILING_IMAGE_REGISTRY:-$DEFAULT_REGISTRY}"
NAMESPACE="${BAILING_IMAGE_NAMESPACE:-$DEFAULT_NAMESPACE}"
MYSQL_TAG="${BAILING_MYSQL_IMAGE_TAG:-8.4}"
MYSQL_IMAGE_NAME="${BAILING_MYSQL_IMAGE_NAME:-bailing-mysql}"
SOURCE_IMAGE="${BAILING_MYSQL_SOURCE_IMAGE:-mysql:$MYSQL_TAG}"
PUSH="${BAILING_PUSH_IMAGES:-0}"

TARGET_IMAGE="$REGISTRY/$NAMESPACE/$MYSQL_IMAGE_NAME:$MYSQL_TAG"

log() { printf '%s\n' "[$APP_NAME mysql-image] $*"; }

log "pull $SOURCE_IMAGE"
docker pull "$SOURCE_IMAGE"

log "tag $TARGET_IMAGE"
docker tag "$SOURCE_IMAGE" "$TARGET_IMAGE"

if [ "$PUSH" = "1" ]; then
  log "push $TARGET_IMAGE"
  docker push "$TARGET_IMAGE"
else
  cat <<EOF

[$APP_NAME mysql-image] mirror complete, push skipped.

To push:
  docker login --username=<aliyun-account> $REGISTRY
  BAILING_PUSH_IMAGES=1 npm run images:publish-mysql

Image:
  $TARGET_IMAGE

EOF
fi
