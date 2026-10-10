#!/usr/bin/env bash
# Lets wrangler use Podman in place of Docker.
#
# build: wrangler runs "docker build --load --provenance=false ... -f - <context>" and pipes
#   the Dockerfile on stdin. Drop --provenance (Podman does not know it) and --load (Podman
#   always loads), and save the piped Dockerfile to a temp file, because Podman cannot open
#   /dev/stdin when stdin is a socket.
# push: push in Docker (v2s2) format and save the digest the registry got. Podman compresses
#   layers again on push, so its local RepoDigests can differ from the pushed manifest.
# image inspect <ref> --format '{{ json .RepoDigests }}': answer with the saved push digest,
#   so wrangler deploys the image that is really in the registry; for a new tag of an image
#   pushed before, the digest saved under its image id, so an unchanged image is not pushed again.
# manifest inspect -v <ref>@<digest>: Docker's shape, so wrangler's "already there?" check works.
set -euo pipefail

digest_dir="${XDG_CACHE_HOME:-$HOME/.cache}/thunderdome-podman-digests"
digest_file() { printf '%s/%s' "$digest_dir" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"; }
# registry/ns/name:tag -> registry/ns/name (a ":" before the last "/" is a port, not a tag)
repo_of() {
  local ref="$1" last="${1##*/}"
  if [[ "$last" == *:* ]]; then printf '%s' "${ref%:*}"; else printf '%s' "$ref"; fi
}

case "${1:-}" in
  build)
    dockerfile=""
    cleanup() { [[ -n "$dockerfile" ]] && rm -f "$dockerfile"; }
    trap cleanup EXIT
    args=()
    expect_file=false
    for arg in "$@"; do
      if $expect_file; then
        expect_file=false
        if [[ "$arg" == "-" ]]; then
          dockerfile="$(mktemp "${TMPDIR:-/tmp}/thunderdome-dockerfile.XXXXXX")"
          cat >"$dockerfile"
          arg="$dockerfile"
        fi
        args+=("$arg")
        continue
      fi
      case "$arg" in
        --load | --provenance | --provenance=*) ;;
        -f | --file) args+=("$arg"); expect_file=true ;;
        *) args+=("$arg") ;;
      esac
    done
    podman "${args[@]}"
    ;;

  push)
    ref="${*: -1}"
    mkdir -p "$digest_dir"
    file="$(digest_file "$ref")"
    rm -f "$file"
    podman push --format v2s2 --digestfile "$file" "${@:2}"
    # Also by local image id: the next deploy builds the same image under a new tag.
    id="$(podman image inspect --format '{{.Id}}' "$ref")"
    printf '%s@%s' "$(repo_of "$ref")" "$(tr -d '[:space:]' <"$file")" >"$digest_dir/id-$id"
    ;;

  manifest)
    # manifest inspect -v <repo>@<digest>: wrangler's "already in the registry?" check before a
    # push. Podman prints the bare manifest; wrangler wants Docker's {"Descriptor":{"digest":...}}.
    if [[ "${2:-}" == "inspect" && "${3:-}" == "-v" && "${4:-}" == *@sha256:* ]]; then
      podman manifest inspect "$4" >/dev/null
      printf '{"Descriptor":{"digest":"%s"}}\n' "${4##*@}"
      exit 0
    fi
    exec podman "$@"
    ;;

  image)
    if [[ "${2:-}" == "inspect" && "${4:-}" == "--format" && "${5:-}" == *RepoDigests* ]]; then
      file="$(digest_file "$3")"
      if [[ -s "$file" ]]; then
        printf '["%s@%s"]\n' "$(repo_of "$3")" "$(tr -d '[:space:]' <"$file")"
        exit 0
      fi
      # A new tag of an image pushed before: the digest that push saved (see push).
      id="$(podman image inspect --format '{{.Id}}' "$3" 2>/dev/null || true)"
      if [[ -n "$id" && -s "$digest_dir/id-$id" ]]; then
        printf '["%s"]\n' "$(cat "$digest_dir/id-$id")"
        exit 0
      fi
    fi
    exec podman "$@"
    ;;

  *)
    exec podman "$@"
    ;;
esac
