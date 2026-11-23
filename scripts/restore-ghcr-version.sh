#!/usr/bin/env bash
# Return the verified GHCR version digest. Existing version tags keep their full index.
set -euo pipefail

acr_repo=${1:?ACR repository required}
ghcr_repo=${2:?GHCR repository required}
version=${3:?version required}

manifest_digest() {
  local checksum
  checksum=$(skopeo inspect --retry-times 3 --raw "docker://$1" | sha256sum) || return
  printf 'sha256:%s\n' "${checksum%% *}"
}

runtime_config() {
  # Older mirrors may use a different manifest media type. Compare the complete runnable config,
  # including the ordered rootfs diff IDs, rather than treating the index itself as the platform.
  skopeo --override-os linux --override-arch amd64 inspect --retry-times 3 --config "docker://$1" |
    jq -ceS --arg version "$version" '
      select(.os == "linux" and .architecture == "amd64" and
             .config.Labels["org.opencontainers.image.version"] == $version and
             (.config.Labels["org.opencontainers.image.revision"] | test("^[0-9a-f]{40}$")) and
             (.rootfs.diff_ids | type == "array" and length > 0))' |
    sha256sum | cut -d ' ' -f 1
}

acr_digest=$(manifest_digest "$acr_repo:$version")
expected=$(runtime_config "$acr_repo@$acr_digest")
probe_error=$(mktemp)
trap 'rm -f "$probe_error"' EXIT
if ! ghcr_digest=$(manifest_digest "$ghcr_repo:$version" 2>"$probe_error"); then
  if ! grep -Eiq '(: |")manifest unknown([: "].*)?$' "$probe_error"; then
    cat "$probe_error" >&2
    exit 1
  fi
  # Require a successful authenticated tag listing as a second check before creating a missing tag.
  skopeo list-tags --retry-times 3 "docker://$ghcr_repo" |
    jq -e --arg version "$version" '.Tags | type == "array" and index($version) == null' >/dev/null
  skopeo copy --retry-times 3 --all --preserve-digests "docker://$acr_repo@$acr_digest" "docker://$ghcr_repo:$version" >&2
  ghcr_digest=$(manifest_digest "$ghcr_repo:$version")
  [[ "$ghcr_digest" == "$acr_digest" ]] || { echo "Restored GHCR version digest differs from ACR." >&2; exit 1; }
fi
actual=$(runtime_config "$ghcr_repo@$ghcr_digest")
if [[ "$actual" != "$expected" ]]; then
  echo "GHCR $version and ACR $version have different runnable configurations; stopping recovery." >&2
  exit 1
fi
printf '%s\n' "$ghcr_digest"
