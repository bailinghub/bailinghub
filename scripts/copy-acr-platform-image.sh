#!/usr/bin/env bash
# Copy the runnable manifest while keeping the build attestations in the source registry.
set -euo pipefail

if [[ $# != 6 ]]; then
  echo "usage: $0 SOURCE_REPO SOURCE_DIGEST TARGET_REPO TARGET_TAG EXPECTED_REVISION EXPECTED_VERSION" >&2
  exit 2
fi
source_repo=$1
build_digest=$2
target="docker://$3:$4"
revision=$5
version=$6
digest_pattern='^sha256:[0-9a-f]{64}$'
[[ $build_digest =~ $digest_pattern ]] || { echo 'Expected a build digest' >&2; exit 1; }

platform_digest=$(
  skopeo inspect --retry-times 3 --raw "docker://$source_repo@$build_digest" |
    jq -er --arg build "$build_digest" '
      if (.manifests | type) == "array" then
        [.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")] |
        if length == 1 then .[0].digest else error("expected exactly one linux/amd64 image") end
      elif .config.digest and (.layers | type) == "array" then $build
      else error("expected an image manifest or index") end'
)
[[ $platform_digest =~ $digest_pattern ]] || { echo 'Invalid platform manifest digest' >&2; exit 1; }
source_image="docker://$source_repo@$platform_digest"

skopeo inspect --retry-times 3 --config "$source_image" |
  jq -e --arg revision "$revision" --arg version "$version" '
    .os == "linux" and .architecture == "amd64" and
    .config.Labels["org.opencontainers.image.revision"] == $revision and
    .config.Labels["org.opencontainers.image.version"] == $version' >/dev/null

skopeo copy --retry-times 3 --preserve-digests "$source_image" "$target"
# The manifest digest also binds the config and every ordered layer digest.
actual=$(skopeo inspect --retry-times 3 --raw "$target" | sha256sum | cut -d ' ' -f 1)
if [[ sha256:$actual != "$platform_digest" ]]; then
  echo "Published manifest at $target does not match $platform_digest" >&2
  exit 1
fi
printf '%s -> %s (%s)\n' "$source_image" "$target" "$revision"
