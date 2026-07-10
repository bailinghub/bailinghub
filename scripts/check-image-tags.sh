#!/bin/sh
set -eu

APP_NAME="bailinghub"
DEFAULT_REGISTRY="crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com"
DEFAULT_NAMESPACE="bailinghub"

REGISTRY="${BAILING_IMAGE_REGISTRY:-$DEFAULT_REGISTRY}"
NAMESPACE="${BAILING_IMAGE_NAMESPACE:-$DEFAULT_NAMESPACE}"
PACKAGE_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)"
TAG="${BAILING_IMAGE_TAG:-$PACKAGE_VERSION}"
[ -n "$TAG" ] || TAG="0.1.0"
MYSQL_TAG="${BAILING_MYSQL_IMAGE_TAG:-8.4}"
MYSQL_IMAGE="${BAILING_MYSQL_IMAGE:-$REGISTRY/$NAMESPACE/bailing-mysql:$MYSQL_TAG}"
PLATFORM="${BAILING_IMAGE_PLATFORM:-linux/amd64}"
PLATFORM_ARCH="${PLATFORM#*/}"
PLATFORM_OS="${PLATFORM%%/*}"

images="
$REGISTRY/$NAMESPACE/bailinghub:$TAG
$REGISTRY/$NAMESPACE/bailing-demo-business:$TAG
$MYSQL_IMAGE
"

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "[$APP_NAME images] ERROR: docker is required to inspect image manifests" >&2
  exit 1
fi

for image in $images; do
  printf '%s\n' "[$APP_NAME images] inspect $image"
  manifest="$(docker manifest inspect --verbose "$image")"
  printf '%s' "$manifest" | grep -Eq "\"os\"[[:space:]]*:[[:space:]]*\"$PLATFORM_OS\"" || {
    printf '%s\n' "[$APP_NAME images] ERROR: $image does not expose platform os=$PLATFORM_OS" >&2
    exit 1
  }
  printf '%s' "$manifest" | grep -Eq "\"architecture\"[[:space:]]*:[[:space:]]*\"$PLATFORM_ARCH\"" || {
    printf '%s\n' "[$APP_NAME images] ERROR: $image does not expose platform architecture=$PLATFORM_ARCH" >&2
    exit 1
  }
done

printf '%s\n' "[$APP_NAME images] all required image tags are available for $PLATFORM"
