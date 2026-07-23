# Procedural Worlds

A self-contained browser demo of procedural generation techniques — noise-based
terrain, wave function collapse, isometric 3D, and **Heartfall**, a full voxel
tower-defense game. No build step beyond loading Three.js from a CDN.

**Run it:** open `index.html` directly, or serve the folder
(`python3 -m http.server 8123` → http://localhost:8123).

**Test it:** `npm test` (Node ≥ 18; runs the game-logic suite in `tests/`).

- `index.html` — noise terrain + wave function collapse (2D)
- `3d.html` — Skylands: isometric voxel archipelago with missiles
- `voxel.html` — **💎 Heartfall**: defend the Heart against an evolving
  voxel zombie horde (see below)

## Heartfall (voxel.html)

A complete siege-defense game on procedurally generated voxel terrain:

- **The loop** — zombies invade in escalating waves and eat each other to
  evolve; you call down missiles (destructible terrain, permanent craters),
  build turrets, bury mines and trigger slow-fields to keep the Heart alive.
- **Kill combos** — chained kills inside a 4-second window multiply every
  payout, uncapped.
- **Boss waves** — every 5th wave lands a crowned colossus with an energy
  bounty; let the horde eat it and its power passes on.
- **Contracts** — three optional objectives per run paying instant energy
  plus banked shards.
- **Modes** — 🏆 Ranked (scored, canonical balance), 📅 Daily Challenge
  (one fixed world per UTC day, per-day scoreboard, play streaks) and
  🧪 Sandbox (every knob unlocked, nothing saved).
- **Legacy** — permanent cross-run perks bought with shards earned every
  run: Heart HP, starting energy, blast radius, turret damage, opening
  minefields, shard gain.
- **16 achievements**, lifetime stats, and a Steam-ready Electron shell in
  `steam/` (see `steam/README.md`).

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
- `js/heartfall-core.js` — every Heartfall balance curve and game rule as
  pure functions (no DOM/THREE), covered by `tests/heartfall-core.test.mjs`
- `js/voxel-gen.js` — the Heartfall game itself (world gen, sim, rendering,
  input, HUD)
- `js/voxel-textures.js`, `js/voxel-audio.js` — procedural block/zombie
  textures and the synthesized SFX kit
- `steam/` — Electron shell + `build.sh` staging script for Steam depots
