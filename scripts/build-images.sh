#!/bin/sh
set -eu

# Recreate the builder configuration while retaining its named cache volume.
# The deployment lock in deploy.py prevents concurrent release builds.
builder=peerpedia-release
docker buildx rm --keep-state "$builder" >/dev/null 2>&1 || true
docker buildx create --name "$builder" --driver docker-container \
  --driver-opt memory=512m,memory-swap=1g,cpu-period=100000,cpu-quota=100000 \
  --buildkitd-config deploy/buildkitd.toml
trap 'docker buildx stop "$builder" >/dev/null 2>&1 || true' 0
trap 'exit 130' INT
trap 'exit 143' TERM
docker buildx inspect --bootstrap "$builder"

# Share the reader-assets cache, but never run the two image builds together.
docker buildx build --builder "$builder" --load --target content-renderer \
  --tag peerpedia-renderer:local .
docker buildx build --builder "$builder" --load --target app \
  --tag peerpedia-web:local .
