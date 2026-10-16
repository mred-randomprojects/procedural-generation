#!/usr/bin/env bash
# Stages the web game into steam/app/ as a fully offline desktop build:
# copies the game files and the vendored three.js the page already loads
# (../vendor/, pinned by hash), drops the ⌘S helper, and stamps
# version.json. Idempotent — rerun after any game change, then
# `npm start` / `npm run package:*`.
set -euo pipefail
cd "$(dirname "$0")"

# Players get these bytes: fail unless the vendored files are the pinned releases.
node ../scripts/check-vendor.mjs

rm -rf app
mkdir -p app/js app/vendor
# The game is the site's front page (../index.html); root voxel.html is just
# a redirect stub for old links. Stage it under the name main.js expects.
cp ../index.html app/voxel.html
cp ../voxel.css app/
cp ../js/noise.js ../js/heartfall-core.js ../js/voxel-gen.js \
   ../js/voxel-textures.js ../js/voxel-audio.js app/js/
# The import map points at ./vendor/three-<version>.module.js, which
# resolves next to app/voxel.html just as it does next to ../index.html.
cp ../vendor/three-*.module.js app/vendor/

# The page's ⌘S / Ctrl+S interception (cmd-s) is an inline module importing
# ./vendor/cmd-s-<version>.js, and the Electron window has no save-page dialog
# for it to suppress. Drop that one <script type="module"> block, recognised by
# its import; keep every other line.
awk '
  !inblock && /<script type="module">/ && !/<\/script>/ { inblock = 1; block = "" }
  inblock {
    block = block $0 "\n"
    if (/<\/script>/) {
      if (!index(block, "vendor/cmd-s-")) printf "%s", block
      inblock = 0
    }
    next
  }
  { print }
  END { if (inblock) printf "%s", block }
' app/voxel.html > app/voxel.html.tmp
mv app/voxel.html.tmp app/voxel.html

if grep -qE 'https?://(unpkg|cdn\.jsdelivr)|vendor/cmd-s-' app/voxel.html; then
  echo "ERROR: app/voxel.html still loads from a CDN or still imports cmd-s — check the import map and the cmd-s block" >&2
  exit 1
fi
for f in $(grep -oE 'vendor/[A-Za-z0-9._-]+\.js' app/voxel.html | sort -u); do
  if [ ! -f "app/$f" ]; then
    echo "ERROR: app/voxel.html loads $f, which this script did not stage" >&2
    exit 1
  fi
done

# The page fetches version.json for its version badge; stamp the desktop
# build so it doesn't show "dev".
COMMIT="$(git -C .. rev-parse --short HEAD 2>/dev/null || echo local)"
printf '{"commit": "%s-steam", "deployedAt": "%s"}\n' \
  "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > app/version.json

echo "Staged app/ — 'npm start' to test, 'npm run package:mac|win|linux' to ship."
