#!/usr/bin/env bash
# Stages the web game into steam/app/ as a fully offline-capable desktop
# build: copies the game files, vendors three.js locally, rewrites the
# import map to the vendored copy, drops the ⌘S helper the page imports
# from jsDelivr, and stamps version.json. Idempotent — rerun after any game
# change, then `npm start` / `npm run package:*`.
set -euo pipefail
cd "$(dirname "$0")"

THREE_VERSION="0.160.0"

rm -rf app
mkdir -p app/js
# The game is the site's front page (../index.html); root voxel.html is just
# a redirect stub for old links. Stage it under the name main.js expects.
cp ../index.html app/voxel.html
cp ../voxel.css app/
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

# The page's ⌘S / Ctrl+S interception (cmd-s) is an inline module importing
# from jsDelivr: a network request the offline build must not make, and the
# Electron window has no save-page dialog for it to suppress. Drop that one
# <script type="module"> block, recognised by its URL; keep every other line.
awk '
  !inblock && /<script type="module">/ && !/<\/script>/ { inblock = 1; block = "" }
  inblock {
    block = block $0 "\n"
    if (/<\/script>/) {
      if (!index(block, "cdn.jsdelivr.net/gh/mred-randomprojects/cmd-s@")) printf "%s", block
      inblock = 0
    }
    next
  }
  { print }
  END { if (inblock) printf "%s", block }
' app/voxel.html > app/voxel.html.tmp
mv app/voxel.html.tmp app/voxel.html

if grep -qE 'https://(unpkg|cdn\.jsdelivr)' app/voxel.html; then
  echo "ERROR: app/voxel.html still loads from a CDN — check THREE_VERSION vs index.html, and the cmd-s block" >&2
  exit 1
fi

# The page fetches version.json for its version badge; stamp the desktop
# build so it doesn't show "dev".
COMMIT="$(git -C .. rev-parse --short HEAD 2>/dev/null || echo local)"
printf '{"commit": "%s-steam", "deployedAt": "%s"}\n' \
  "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > app/version.json

echo "Staged app/ — 'npm start' to test, 'npm run package:mac|win|linux' to ship."
