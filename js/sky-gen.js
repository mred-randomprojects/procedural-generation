"use strict";

/* ---------- Skylands voxel world generation ----------
 * Column-based floating islands: a 2D "presence" noise field decides where
 * islands are; each island column gets a surface height, a thickness that
 * tapers toward the rim (lens shapes), and a craggy underside. Altitude
 * decides the biome band: sandy lowlands, green mid-band, frozen peaks.
 */

const SKY_W = 104, SKY_D = 104, SKY_H = 64;

const SM = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4,
  SNOW: 5, WATER: 6, TRUNK: 7, LEAF: 8, CHARRED: 9,
};

const SKY_FLAMMABLE = new Set([SM.GRASS, SM.TRUNK, SM.LEAF]);

const SKY_SEEDS = ["zephyr", "cumulus", "aurora", "mistral", "nimbus", "sirocco",
  "boreas", "cirrus", "monsoon", "tradewind", "gale", "stratus"];

function skyIdx(x, y, z) { return (y * SKY_W + x) * SKY_H + z; }
function skyCol(x, y) { return y * SKY_W + x; }

function randomSkySeed() {
  const base = SKY_SEEDS[(Math.random() * SKY_SEEDS.length) | 0];
  return Math.random() < 0.5 ? base : base + "-" + ((Math.random() * 90 + 10) | 0);
}

function generateSky(seedStr) {
  const W = SKY_W, D = SKY_D, H = SKY_H;
  const seedNum = hashSeed(String(seedStr));
  const rng = mulberry32(seedNum);
  const presenceN = new SimplexNoise(mulberry32((seedNum ^ 0x9e3779b9) >>> 0));
  const heightN = new SimplexNoise(mulberry32((seedNum ^ 0x85ebca6b) >>> 0));
  const thickN = new SimplexNoise(mulberry32((seedNum ^ 0xc2b2ae35) >>> 0));
  const cragN = new SimplexNoise(mulberry32((seedNum ^ 0x27d4eb2f) >>> 0));
  const forestN = new SimplexNoise(mulberry32((seedNum ^ 0x165667b1) >>> 0));
  const pondN = new SimplexNoise(mulberry32((seedNum ^ 0x0f1bbcdc) >>> 0));

  const blocks = new Uint8Array(W * D * H);
  const surf = new Int16Array(W * D).fill(-1);
  const mArr = new Float32Array(W * D);

  const SC = 2.6; // archipelago features across the map
  const T = 0.62; // island presence threshold

  // --- island columns ---
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x / W) * SC, ny = (y / D) * SC;
      const p = fbm(presenceN, nx, ny, 4, 0.5) * 0.5 + 0.5;
      if (p <= T) continue;
      const m = (p - T) / (1 - T); // 0 at the rim -> 1 at the core
      mArr[skyCol(x, y)] = m;

      const altN = fbm(heightN, nx * 0.55 + 7.3, ny * 0.55 - 2.1, 3, 0.5) * 0.5 + 0.5;
      const zs = Math.max(8, Math.min(H - 12,
        Math.round(13 + altN * 30 + m * 3 + fbm(thickN, nx * 2.3, ny * 2.3, 2, 0.5) * 2.5)));
      const bulk = fbm(thickN, nx * 1.7 - 4.2, ny * 1.7 + 9.1, 3, 0.5) * 0.5 + 0.5;
      const crag = fbm(cragN, nx * 3.1, ny * 3.1, 3, 0.5) * 0.5 + 0.5;
      const th = Math.max(1, Math.round(Math.pow(m, 0.75) * (5 + 10 * bulk) + m * crag * 7));
      const zb = Math.max(2, zs - th);

      for (let z = zb; z <= zs; z++) blocks[skyIdx(x, y, z)] = SM.STONE;
      if (zs < 24) { // low, warm islands
        blocks[skyIdx(x, y, zs)] = SM.SAND;
        if (zs - 1 >= zb) blocks[skyIdx(x, y, zs - 1)] = SM.SAND;
      } else if (zs < 38) { // green mid-band
        blocks[skyIdx(x, y, zs)] = SM.GRASS;
        for (let k = 1; k <= 2; k++) if (zs - k >= zb) blocks[skyIdx(x, y, zs - k)] = SM.DIRT;
      } else { // frozen peaks
        blocks[skyIdx(x, y, zs)] = SM.SNOW;
      }
      surf[skyCol(x, y)] = zs;
    }
  }

  // --- ponds on the green band ---
  for (let y = 1; y < D - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const c = skyCol(x, y);
      const zs = surf[c];
      if (zs < 0 || blocks[skyIdx(x, y, zs)] !== SM.GRASS) continue;
      const nx = (x / W) * SC, ny = (y / D) * SC;
      if (fbm(pondN, nx * 2.4 + 3.7, ny * 2.4 - 8.2, 3, 0.5) > 0.34 && mArr[c] > 0.25) {
        blocks[skyIdx(x, y, zs)] = SM.WATER;
      }
    }
  }

  // --- waterfalls: pond cells whose neighbour column drops away ---
  const waterfalls = [];
  for (let y = 1; y < D - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const zs = surf[skyCol(x, y)];
      if (zs < 0 || blocks[skyIdx(x, y, zs)] !== SM.WATER) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ns = surf[skyCol(x + dx, y + dy)];
        if (ns < zs - 1) { waterfalls.push({ x, y, z: zs, dx, dy }); break; }
      }
    }
  }

  // --- trees on grass ---
  let trees = 0;
  for (let y = 2; y < D - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const zs = surf[skyCol(x, y)];
      if (zs < 0 || blocks[skyIdx(x, y, zs)] !== SM.GRASS) continue;
      const nx = (x / W) * SC, ny = (y / D) * SC;
      if (fbm(forestN, nx * 1.9, ny * 1.9, 3, 0.5) < 0.12 || rng() > 0.16) continue;
      const h = 2 + ((rng() * 2) | 0);
      if (zs + h + 3 >= H) continue;
      for (let k = 1; k <= h; k++) blocks[skyIdx(x, y, zs + k)] = SM.TRUNK;
      for (let lz = 0; lz <= 2; lz++) {
        const rad = lz === 2 ? 0 : 1;
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            if (lz < 2 && Math.abs(dx) === 1 && Math.abs(dy) === 1 && rng() < 0.4) continue;
            const i = skyIdx(x + dx, y + dy, zs + h + lz);
            if (blocks[i] === SM.AIR) blocks[i] = SM.LEAF;
          }
        }
      }
      trees++;
    }
  }

  // --- column tops & bottoms ---
  const topZ = new Int16Array(W * D).fill(-1);
  const botZ = new Int16Array(W * D).fill(-1);
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < W; x++) {
      const c = skyCol(x, y);
      for (let z = H - 1; z >= 0; z--) if (blocks[skyIdx(x, y, z)]) { topZ[c] = z; break; }
      if (topZ[c] >= 0) {
        for (let z = 0; z < H; z++) if (blocks[skyIdx(x, y, z)]) { botZ[c] = z; break; }
      }
    }
  }

  // --- label islands (connected components of occupied columns) ---
  const islandOf = new Int16Array(W * D).fill(-1);
  const islands = [];
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < W; x++) {
      const c0 = skyCol(x, y);
      if (topZ[c0] < 0 || islandOf[c0] >= 0) continue;
      const cols = [];
      const q = [c0];
      islandOf[c0] = islands.length;
      while (q.length) {
        const c = q.pop();
        cols.push(c);
        const cx = c % W, cy = (c / W) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const x2 = cx + dx, y2 = cy + dy;
          if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= D) continue;
          const c2 = skyCol(x2, y2);
          if (topZ[c2] >= 0 && islandOf[c2] < 0) { islandOf[c2] = islands.length; q.push(c2); }
        }
      }
      let sd = 0, sx = 0, sy = 0;
      for (const c of cols) { const cx = c % W, cy = (c / W) | 0; sd += cx + cy; sx += cx; sy += cy; }
      cols.sort((a, b) => ((a % W) + ((a / W) | 0)) - ((b % W) + ((b / W) | 0)));
      islands.push({
        id: islands.length, cols,
        depth: sd / cols.length, cx: sx / cols.length, cy: sy / cols.length,
        phase: rng() * Math.PI * 2, amp: 2 + rng() * 2.5, speed: 0.35 + rng() * 0.4,
        canvas: null, ox: 0, oy: 0,
      });
    }
  }
  islands.sort((a, b) => a.depth - b.depth);
  islands.forEach((isl, i) => { isl.id = i; for (const c of isl.cols) islandOf[c] = i; });

  return {
    W, D, H, blocks, surf, topZ, botZ, islandOf, islands,
    waterfalls: waterfalls.slice(0, 12), trees, seed: String(seedStr),
  };
}
