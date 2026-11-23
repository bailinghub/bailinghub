#!/usr/bin/env bash
# Exercise release image copying with two disposable loopback-only TLS registries.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
registries=()
cleanup() {
  for container in "${registries[@]}"; do docker rm -fv "$container" >/dev/null; done
  rm -rf "$tmp"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
  -addext 'subjectAltName=IP:127.0.0.1' -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
export SSL_CERT_FILE="$tmp/cert.pem" REGISTRY_AUTH_FILE="$tmp/auth.json"
printf '{"auths":{}}\n' > "$REGISTRY_AUTH_FILE"

for side in source target; do
  container=$(docker create -p 127.0.0.1::5000 \
    -e REGISTRY_HTTP_TLS_CERTIFICATE=/etc/docker/registry/cert.pem \
    -e REGISTRY_HTTP_TLS_KEY=/etc/docker/registry/key.pem \
    registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373)
  registries+=("$container")
  docker cp "$tmp/cert.pem" "$container:/etc/docker/registry/cert.pem"
  docker cp "$tmp/key.pem" "$container:/etc/docker/registry/key.pem"
  docker start "$container" >/dev/null
  endpoint=$(docker port "$container" 5000/tcp)
  curl -fsS --cacert "$SSL_CERT_FILE" --retry 15 --retry-all-errors --retry-delay 1 "https://$endpoint/v2/" >/dev/null
  printf -v "${side}_repo" '%s/test/image' "$endpoint"
done

version=v1.2.3
revision=1234567890abcdef1234567890abcdef12345678
# A deterministic OCI layout with two platforms and BuildKit-style provenance.
python3 - "$tmp" "$version" "$revision" <<'PY'
import gzip, hashlib, io, json, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1]) / 'layout'
blobs = root / 'blobs' / 'sha256'
blobs.mkdir(parents=True)
oci = 'application/vnd.oci.image.'
def encode(obj):
    return json.dumps(obj, separators=(',', ':')).encode()
def blob(media, data):
    if not isinstance(data, bytes):
        data = encode(data)
    key = hashlib.sha256(data).hexdigest()
    (blobs / key).write_bytes(data)
    return {'mediaType': media, 'digest': 'sha256:' + key, 'size': len(data)}
def manifest(config, layers, **properties):
    media = oci + 'manifest.v1+json'
    return blob(media, {'schemaVersion': 2, 'mediaType': media, 'config': config, 'layers': layers, **properties})

payload = b'platform copy test\n'
tar = io.BytesIO()
with tarfile.open(fileobj=tar, mode='w') as archive:
    entry = tarfile.TarInfo('fixture.txt')
    entry.size = len(payload)
    archive.addfile(entry, io.BytesIO(payload))
raw = tar.getvalue()
layer = blob(oci + 'layer.v1.tar+gzip', gzip.compress(raw, mtime=0))
images = []
for arch in ['amd64', 'arm64']:
    platform = {'os': 'linux', 'architecture': arch}
    config = blob(oci + 'config.v1+json', {**platform, 'rootfs': {'type':'layers','diff_ids':['sha256:' + hashlib.sha256(raw).hexdigest()]},
                  'config': {'Labels': {'org.opencontainers.image.version':sys.argv[2], 'org.opencontainers.image.revision':sys.argv[3]}}})
    images.append({**manifest(config, [layer]), 'platform': platform})
proof = blob('application/vnd.in-toto+json', {'_type':'https://in-toto.io/Statement/v0.1', 'subject':[{'name':'fixture','digest':{'sha256':images[0]['digest'][7:]}}],
             'predicateType':'https://slsa.dev/provenance/v0.2', 'predicate':{}})
unknown = {'os':'unknown', 'architecture':'unknown'}
config = blob('application/vnd.oci.empty.v1+json', {})
subject = {key: images[0][key] for key in ['mediaType', 'digest', 'size']}
artifact = manifest(config, [proof], artifactType='application/vnd.docker.attestation.manifest.v1+json', subject=subject)
attestation = {**artifact, 'platform':unknown, 'annotations':{'vnd.docker.reference.type':'attestation-manifest','vnd.docker.reference.digest':images[0]['digest']}}
index = {'schemaVersion':2, 'mediaType':oci+'index.v1+json', 'manifests':[*images, attestation]}
descriptor = blob(index['mediaType'], index)
(root/'oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}')
(root/'index.json').write_bytes(encode({**index,'manifests':[{**descriptor,'annotations':{'org.opencontainers.image.ref.name':'fixture'}}]}))
PY
skopeo copy --all --preserve-digests "oci:$tmp/layout:fixture" "docker://$source_repo:$version" >/dev/null

# Read the v2 registry protocol directly for independent verification.
request() {
  local repo=$1 path=$2
  curl -fsS --cacert "$SSL_CERT_FILE" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://${repo%%/*}/v2/${repo#*/}/$path"
}
digest() { printf 'sha256:%s\n' "$(sha256sum "$1" | cut -d ' ' -f 1)"; }
request "$source_repo" "manifests/$version" > "$tmp/index"
index_digest=$(digest "$tmp/index")
runtime=$(jq -er '.manifests[] | select(.platform.architecture == "amd64") | .digest' "$tmp/index")
other=$(jq -er '.manifests[] | select(.platform.architecture == "arm64") | .digest' "$tmp/index")
proof=$(jq -er --arg runtime "$runtime" '.manifests[] | select(.annotations["vnd.docker.reference.type"] == "attestation-manifest" and .annotations["vnd.docker.reference.digest"] == $runtime) | .digest' "$tmp/index")
request "$source_repo" "manifests/$runtime" > "$tmp/runtime"
for tag in "$version" latest; do
  "$here/copy-acr-platform-image.sh" "$source_repo" "$index_digest" "$target_repo" "$tag" "$revision" "$version"
  request "$target_repo" "manifests/$tag" > "$tmp/published"
  cmp "$tmp/runtime" "$tmp/published"
  for blob in $(jq -r '.config.digest, .layers[].digest' "$tmp/runtime"); do
    request "$target_repo" "blobs/$blob" > "$tmp/blob"
    [[ $(digest "$tmp/blob") == "$blob" ]]
  done
done
# Existing single-platform Docker schema 2 images must also copy unchanged.
skopeo copy --format v2s2 "docker://$source_repo@$runtime" "docker://$source_repo:legacy" >/dev/null
request "$source_repo" manifests/legacy > "$tmp/legacy"
jq -e '.mediaType == "application/vnd.docker.distribution.manifest.v2+json"' "$tmp/legacy" >/dev/null
"$here/copy-acr-platform-image.sh" "$source_repo" "$(digest "$tmp/legacy")" "$target_repo" legacy "$revision" "$version"
request "$target_repo" manifests/legacy > "$tmp/published"
cmp "$tmp/legacy" "$tmp/published"

for scenario in wrong-platform wrong-revision wrong-version; do
  input=$index_digest want_revision=$revision want_version=$version
  case "$scenario" in
    wrong-platform) input=$other ;;
    wrong-revision) want_revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    wrong-version) want_version=v2.0.0 ;;
  esac
  if "$here/copy-acr-platform-image.sh" "$source_repo" "$input" "$target_repo" "$scenario" "$want_revision" "$want_version"; then
    echo "Unexpectedly accepted $scenario" >&2; exit 1
  fi
done
request "$target_repo" tags/list | jq -e --arg version "$version" '.tags | sort == ([$version, "latest", "legacy"] | sort)' >/dev/null
for absent in "$index_digest" "$proof" "$other"; do
  status=$(curl -sS --cacert "$SSL_CERT_FILE" -o /dev/null -w '%{http_code}' \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json' \
    "https://${target_repo%%/*}/v2/${target_repo#*/}/manifests/$absent")
  [[ $status == 404 ]] || { echo "Unexpected destination response for $absent: $status" >&2; exit 1; }
done
request "$source_repo" "manifests/$version" > "$tmp/after"
cmp "$tmp/index" "$tmp/after"
request "$source_repo" "manifests/$proof" > "$tmp/attestation"
[[ $(digest "$tmp/attestation") == "$proof" ]]
jq -e --arg runtime "$runtime" '.config.mediaType == "application/vnd.oci.empty.v1+json" and
  .artifactType == "application/vnd.docker.attestation.manifest.v1+json" and .subject.digest == $runtime' "$tmp/attestation" >/dev/null
request "$source_repo" "blobs/$(jq -er '.layers[0].digest' "$tmp/attestation")" | jq -e '.predicateType | startswith("https://slsa.dev/provenance/")' >/dev/null
# Recovery must leave an existing full index intact when its fallback is flattened.
restored=$("$here/restore-ghcr-version.sh" "$target_repo" "$source_repo" "$version")
[[ $restored == "$index_digest" ]]
request "$source_repo" "manifests/$version" > "$tmp/recovered"
cmp "$tmp/index" "$tmp/recovered"
# A historical fallback may itself be an index. Seed an existing repository missing this version.
recovery_repo="${target_repo%%/*}/test/recovery"
skopeo copy --preserve-digests "docker://$source_repo@$runtime" "docker://$recovery_repo:prior" >/dev/null
restored=$("$here/restore-ghcr-version.sh" "$source_repo" "$recovery_repo" "$version")
[[ $restored == "$index_digest" ]]
request "$recovery_repo" "manifests/$version" > "$tmp/recovered"
cmp "$tmp/index" "$tmp/recovered"
request "$recovery_repo" "manifests/$proof" > "$tmp/recovered"
cmp "$tmp/attestation" "$tmp/recovered"
printf 'PASS: source index %s and attestation %s retained; target %s and latest share runnable %s; legacy, rejection and recovery checks passed\n' \
  "$index_digest" "$proof" "$version" "$runtime"
