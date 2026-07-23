#!/usr/bin/env bash
# Stages the web game into steam/app/ as a fully offline-capable desktop
# build: copies the game files, vendors three.js locally, rewrites the
# import map to the vendored copy, and stamps version.json. Idempotent —
# rerun after any game change, then `npm start` / `npm run package:*`.
set -euo pipefail
cd "$(dirname "$0")"

THREE_VERSION="0.160.0"

rm -rf app
mkdir -p app/js
cp ../voxel.html ../voxel.css app/
cp ../js/noise.js ../js/heartfall-core.js ../js/voxel-gen.js \
   ../js/voxel-textures.js ../js/voxel-audio.js app/js/

echo "Vendoring three.js ${THREE_VERSION}…"
curl -fsSL "https://unpkg.com/three@${THREE_VERSION}/build/three.module.js" \
  -o app/js/three.module.js

# Point the import map at the vendored copy — Steam builds must run offline.
# (Write-to-temp instead of sed -i: macOS and GNU sed disagree on -i.)
sed "s#https://unpkg.com/three@${THREE_VERSION}/build/three.module.js#./js/three.module.js#" \
  app/voxel.html > app/voxel.html.tmp
mv app/voxel.html.tmp app/voxel.html

if grep -q "unpkg.com" app/voxel.html; then
  echo "ERROR: import map still points at unpkg — check THREE_VERSION vs voxel.html" >&2
  exit 1
fi

# The page fetches version.json for its version badge; stamp the desktop
# build so it doesn't show "dev".
COMMIT="$(git -C .. rev-parse --short HEAD 2>/dev/null || echo local)"
printf '{"commit": "%s-steam", "deployedAt": "%s"}\n' \
  "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > app/version.json

echo "Staged app/ — 'npm start' to test, 'npm run package:mac|win|linux' to ship."
