# Procedural Worlds

A self-contained browser demo of procedural generation techniques — noise-based
terrain, wave function collapse, isometric 3D, and a full voxel Minecraft-style
world you can blow up. No build step beyond loading Three.js from a CDN.

**Run it:** open `index.html` directly, or serve the folder
(`python3 -m http.server 8123` → http://localhost:8123).

- `index.html` — noise terrain + wave function collapse (2D)
- `3d.html` — Skylands: isometric voxel archipelago with missiles
- `voxel.html` — **Voxel Worlds**: full 3D Minecraft-style biomes (Three.js),
  free camera, wandering zombies you can blast with missiles (they merge into
  tougher elites, drop money, and respawn), craters that heal over time

## Tab 1 — 🌍 Noise World (how Minecraft-style terrain works)

Three independent layers of seeded simplex noise — **elevation** (domain-warped
fBm), **moisture**, and **temperature** — are combined per cell:

1. Sea level & mountain line sliders are plain thresholds on elevation.
2. Everything in between is classified into a biome by a (temperature, moisture)
   lookup — a Whittaker diagram, which is why biomes border each other sensibly
   (tundra never touches desert).
3. Rivers start on high ground and flow downhill; they moisten nearby land, so
   valleys turn green.
4. Towns are scored placements (flat, near water, mild climate, far apart) with
   procedural names; roads are A* paths that avoid slopes and pay to bridge rivers.

Use the Height / Moisture / Heat views to show the raw layers behind the biomes.

## Tab 2 — 🧩 Wave Function Collapse

Every cell starts as a superposition of 8 tiles. Each step collapses the
lowest-entropy cell (weighted by the sliders, with a clumping bonus toward
collapsed neighbours), then constraint-propagates: tiles may only touch their
immediate neighbours in the chain
deep → water → sand → grass → forest → hills → mountain → snow.

A few lakes and peaks are seeded up front so maps span the whole chain. Paint a
tile to force a choice — if it's impossible there, the neighbourhood melts back
into superposition and re-collapses ("heals") around your choice.

## Files

- `js/noise.js` — seeded PRNG, simplex noise, fBm
- `js/world.js` — terrain, biomes, rivers, towns, roads
- `js/render.js` — pixel renderer, hillshading, houses & labels
- `js/wfc.js` — WFC model (bitmask domains, entropy cache, propagation)
- `js/main.js` — UI wiring, WFC animation loop, painting
