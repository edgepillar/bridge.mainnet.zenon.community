#!/usr/bin/env bash
# The bridge lab: a go-zenon devnet with a usable bridge, and anvil.
#
#   e2e/lab/lab.sh build    znnd image from go-zenon's HEAD plus znnd/devnet_bridge.go
#   e2e/lab/lab.sh up       start it (builds and makes assets if needed)
#   e2e/lab/lab.sh status   containers, and whether it is producing
#   e2e/lab/lab.sh down     stop it, Zenon chain kept (anvil is always fresh)
#   e2e/lab/lab.sh wipe     stop it and delete the chain and assets
#
# GO_ZENON_DIR points at a go-zenon checkout (default ../../../go-zenon).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
go_zenon="${GO_ZENON_DIR:-$here/../../../go-zenon}"
build="$here/.build"
assets="$here/assets"

# Index 1 of go-zenon's devnet mnemonic: funded and fused in genesis. It is the
# lab's bridge administrator, orchestrator sender and test user (e2e/lib/keys.ts).
export LAB_BRIDGE_ADMIN="z1qq6eg8n43g032hanpsfp02qcdmv7zfj3y2lt5d"

tag() {
  if [ ! -f "$build/revision" ]; then
    echo "No image yet: run 'lab.sh build'." >&2
    exit 1
  fi
  cat "$build/revision"
}

compose() {
  LAB_ZNND_TAG="$(tag)" docker compose -f "$here/docker-compose.yml" "$@"
}

do_build() {
  local revision
  revision="$(git -C "$go_zenon" rev-parse --short HEAD)-bridge"
  # A clean export of HEAD, not the working tree: a tree with CRLF endings
  # gives an entrypoint that does not run.
  rm -rf "$build/src"
  mkdir -p "$build/src"
  git -C "$go_zenon" archive HEAD | tar -x -C "$build/src"
  cp "$here/znnd/devnet_bridge.go" "$build/src/vm/constants/devnet_bridge.go"
  docker build -t "bridge-lab-znnd:$revision" "$build/src"
  echo "$revision" > "$build/revision"
  echo "built bridge-lab-znnd:$revision"
}

do_assets() {
  [ -f "$assets/genesis.json" ] && return 0
  node "$here/make-assets.mjs" "$build/src/docker/devnet" "$assets"
}

case "${1:-}" in
  build)
    do_build
    ;;
  up)
    [ -f "$build/revision" ] || do_build
    docker image inspect "bridge-lab-znnd:$(tag)" > /dev/null
    do_assets
    compose up -d
    node "$here/frontier.mjs" 180 --wait 120
    ;;
  status)
    compose ps -a
    node "$here/frontier.mjs" 30
    ;;
  down)
    compose down
    ;;
  wipe)
    compose down -v
    rm -rf "$assets"
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 2
    ;;
esac
