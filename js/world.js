"use strict";

/* ---------- Biomes ---------- */

const BIOME = {
  OCEAN: 0, BEACH: 1, DESERT: 2, SAVANNA: 3, TROPICAL: 4,
  SHRUB: 5, GRASS: 6, FOREST: 7, TAIGA: 8, TUNDRA: 9,
  SNOW: 10, ROCK: 11, PEAK: 12,
};

const BIOME_INFO = [
  { name: "Ocean", color: [29, 79, 124] },
  { name: "Beach", color: [232, 216, 168] },
  { name: "Desert", color: [220, 199, 137] },
  { name: "Savanna", color: [184, 184, 102] },
  { name: "Tropical forest", color: [45, 138, 78] },
  { name: "Shrubland", color: [163, 160, 92] },
  { name: "Grassland", color: [139, 192, 99] },
  { name: "Forest", color: [53, 117, 62] },
  { name: "Taiga", color: [70, 112, 92] },
  { name: "Tundra", color: [152, 163, 137] },
  { name: "Snow", color: [232, 236, 240] },
  { name: "Bare rock", color: [138, 133, 120] },
  { name: "Snowy peak", color: [242, 245, 247] },
];

/* ---------- Town names ---------- */

const NAME_A = ["Oak", "Stone", "River", "Ash", "Wolf", "Bright", "Green", "Frost",
  "Salt", "Iron", "Raven", "Elder", "Mill", "Fox", "Thorn", "Amber", "Gold", "Wind",
  "Hazel", "Moss"];
const NAME_B = ["bridge", "haven", "field", "burg", "stead", "ford", "wick", "holm",
  "gate", "crest", "fall", "moor", "dale", "mouth", "brook", "cliff"];

function townName(rng, used) {
  for (let k = 0; k < 20; k++) {
    const n = NAME_A[(rng() * NAME_A.length) | 0] + NAME_B[(rng() * NAME_B.length) | 0];
    if (!used.has(n)) { used.add(n); return n; }
  }
  return "Newtown";
}

/* ---------- Helpers ---------- */

// Multi-source BFS over the grid (4-neighbour), capped at maxD steps
function bfsDistance(W, H, isSource, maxD) {
  const N = W * H;
  const dist = new Int16Array(N).fill(32767);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (isSource(i)) { dist[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const i = q[qh++], d = dist[i];
    if (d >= maxD) continue;
    const x = i % W, y = (i / W) | 0;
    if (x > 0 && dist[i - 1] > d + 1) { dist[i - 1] = d + 1; q[qt++] = i - 1; }
    if (x < W - 1 && dist[i + 1] > d + 1) { dist[i + 1] = d + 1; q[qt++] = i + 1; }
    if (y > 0 && dist[i - W] > d + 1) { dist[i - W] = d + 1; q[qt++] = i - W; }
    if (y < H - 1 && dist[i + W] > d + 1) { dist[i + W] = d + 1; q[qt++] = i + W; }
  }
  return dist;
}

class MinHeap {
  constructor() { this.p = []; this.v = []; }
  get size() { return this.p.length; }
  push(pri, val) {
    const p = this.p, v = this.v;
    p.push(pri); v.push(val);
    let i = p.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (p[par] <= p[i]) break;
      [p[par], p[i]] = [p[i], p[par]];
      [v[par], v[i]] = [v[i], v[par]];
      i = par;
    }
  }
  pop() {
    const p = this.p, v = this.v;
    const top = v[0];
    const lastP = p.pop(), lastV = v.pop();
    if (p.length) {
      p[0] = lastP; v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < p.length && p[l] < p[m]) m = l;
        if (r < p.length && p[r] < p[m]) m = r;
        if (m === i) break;
        [p[m], p[i]] = [p[i], p[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/* ---------- World generation ---------- */

function generateWorld(p) {
  const W = 320, H = 200, N = W * H;
  const seedNum = hashSeed(String(p.seed));
  const rng = mulberry32(seedNum);
  const elevN = new SimplexNoise(mulberry32((seedNum ^ 0x9e3779b9) >>> 0));
  const warpN = new SimplexNoise(mulberry32((seedNum ^ 0x85ebca6b) >>> 0));
  const moistN = new SimplexNoise(mulberry32((seedNum ^ 0xc2b2ae35) >>> 0));
  const tempN = new SimplexNoise(mulberry32((seedNum ^ 0x27d4eb2f) >>> 0));

  const sea = p.sea, mtn = p.mountain;
  const elev = new Float32Array(N);
  const moist = new Float32Array(N);
  const temp = new Float32Array(N);

  // --- Elevation (domain-warped fBm + island falloff), moisture, temperature ---
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const nx = (x / H) * p.scale, ny = (y / H) * p.scale;

      const qx = fbm(warpN, nx + 3.1, ny + 1.7, 2, 0.5);
      const qy = fbm(warpN, nx - 4.7, ny + 2.9, 2, 0.5);
      let e = fbm(elevN, nx + 0.35 * qx, ny + 0.35 * qy, p.octaves, p.persistence) * 0.5 + 0.5;

      const cx = (x / W) * 2 - 1, cy = (y / H) * 2 - 1;
      const d = Math.sqrt(cx * cx + cy * cy) / Math.SQRT2;
      e -= p.island * Math.pow(d, 2.4) * 0.9;
      elev[i] = clamp01(e);

      moist[i] = clamp01(fbm(moistN, nx * 0.9 + 11.3, ny * 0.9 - 7.1, 3, 0.5) * 0.5 + 0.5 + p.moistOff);

      const latT = y / H; // cold at the top, hot at the bottom
      const tn = fbm(tempN, nx * 0.7 - 2.2, ny * 0.7 + 9.4, 2, 0.5) * 0.5 + 0.5;
      temp[i] = clamp01(0.55 * latT + 0.45 * tn + p.tempOff - Math.max(0, elev[i] - sea) * 0.65);
    }
  }

  // --- Slope (used for shading, town placement and road costs) ---
  const slope = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const xl = Math.max(0, x - 1), xr = Math.min(W - 1, x + 1);
      const yu = Math.max(0, y - 1), yd = Math.min(H - 1, y + 1);
      const dx = (elev[y * W + xr] - elev[y * W + xl]) / 2;
      const dy = (elev[yd * W + x] - elev[yu * W + x]) / 2;
      slope[i] = Math.sqrt(dx * dx + dy * dy);
    }
  }

  // --- Rivers & ponds ---
  const fresh = new Uint8Array(N); // 1 = river, 2 = pond

  function makeLake(cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy > 5) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (elev[i] >= sea) fresh[i] = Math.max(fresh[i], 2);
      }
    }
  }

  function traceRiver(sx, sy) {
    let x = sx, y = sy;
    const path = [];
    const visited = new Set();

    for (let step = 0; step < 1500; step++) {
      const i = y * W + x;
      if (elev[i] < sea) break; // reached the sea
      if (fresh[i] === 1 && path.length > 3) { // merged into an existing river
        for (const c of path) fresh[c] = Math.max(fresh[c], 1);
        return true;
      }
      visited.add(i);
      path.push(i);

      // flow to the lowest unvisited neighbour (with a little meander noise)
      let best = -1, bestE = elev[i] + 0.03;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const x2 = x + dx, y2 = y + dy;
          if (x2 < 1 || y2 < 1 || x2 >= W - 1 || y2 >= H - 1) continue;
          const j = y2 * W + x2;
          if (visited.has(j)) continue;
          const ee = elev[j] + (rng() - 0.5) * 0.004;
          if (ee < bestE) { bestE = ee; best = j; }
        }
      }
      if (best < 0) { // stuck in a basin: pond up
        if (path.length > 4) {
          for (const c of path) fresh[c] = Math.max(fresh[c], 1);
          makeLake(x, y);
          return true;
        }
        return false;
      }
      x = best % W;
      y = (best / W) | 0;
    }
    if (path.length > 5) {
      for (const c of path) fresh[c] = Math.max(fresh[c], 1);
      return true;
    }
    return false;
  }

  let riverCount = 0;
  if (p.rivers > 0) {
    const hiThreshold = sea + (1 - sea) * 0.45;
    for (let tries = 0; tries < 6000 && riverCount < p.rivers; tries++) {
      const x = 2 + Math.floor(rng() * (W - 4));
      const y = 2 + Math.floor(rng() * (H - 4));
      if (elev[y * W + x] > hiThreshold && traceRiver(x, y)) riverCount++;
    }
  }

  // --- Rivers moisten their surroundings (green valleys) ---
  const riverDist = bfsDistance(W, H, (i) => fresh[i] > 0, 10);
  for (let i = 0; i < N; i++) {
    if (riverDist[i] < 32767 && !fresh[i]) {
      moist[i] = clamp01(moist[i] + (10 - riverDist[i]) * 0.035);
    }
  }

  // --- Biome classification (Whittaker-style lookup) ---
  const biome = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const e = elev[i], t = temp[i], m = moist[i];
    if (e < sea) { biome[i] = BIOME.OCEAN; continue; }
    if (e > mtn) { biome[i] = e > mtn + 0.05 + t * 0.12 ? BIOME.PEAK : BIOME.ROCK; continue; }
    if (e < sea + 0.02 && t >= 0.3) { biome[i] = BIOME.BEACH; continue; }
    if (t < 0.24) biome[i] = m < 0.35 ? BIOME.TUNDRA : m < 0.62 ? BIOME.TAIGA : BIOME.SNOW;
    else if (t < 0.62) biome[i] = m < 0.22 ? BIOME.SHRUB : m < 0.55 ? BIOME.GRASS : BIOME.FOREST;
    else biome[i] = m < 0.26 ? BIOME.DESERT : m < 0.58 ? BIOME.SAVANNA : BIOME.TROPICAL;
  }

  // --- Towns: score cells, keep the best that are far apart ---
  const waterDist = bfsDistance(W, H, (i) => elev[i] < sea || fresh[i] > 0, 14);
  const towns = [];
  if (p.towns > 0) {
    const usedNames = new Set();
    const cands = [];
    for (let k = 0; k < 6000; k++) {
      const x = 8 + Math.floor(rng() * (W - 16));
      const y = 8 + Math.floor(rng() * (H - 16));
      const i = y * W + x;
      const e = elev[i];
      // town centres need solid ground (not beach sand), below the mountains
      if (e < sea + 0.03 || e > mtn - 0.04 || fresh[i]) continue;
      if (slope[i] > 0.035) continue;
      let score = 1.5 - slope[i] * 30;
      if (waterDist[i] <= 12) score += (12 - waterDist[i]) * 0.12;
      const b = biome[i];
      if (b === BIOME.DESERT || b === BIOME.TUNDRA || b === BIOME.SNOW) score -= 0.7;
      if (b === BIOME.GRASS || b === BIOME.SAVANNA) score += 0.25;
      score += rng() * 0.4;
      cands.push([score, x, y]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    for (const [, x, y] of cands) {
      if (towns.length >= p.towns) break;
      let ok = true;
      for (const t of towns) {
        const dx = t.x - x, dy = t.y - y;
        if (dx * dx + dy * dy < 28 * 28) { ok = false; break; }
      }
      if (!ok) continue;
      towns.push({ x, y, size: 0.7 + rng() * 0.8, name: townName(rng, usedNames) });
    }
  }

  // --- Roads: minimum spanning tree between towns, A* over the terrain ---
  const road = new Uint8Array(N);

  function cellCost(i) {
    const e = elev[i];
    if (e < sea) return -1; // no ocean crossings
    let c = 1 + slope[i] * 90;
    if (fresh[i]) c += 45; // bridges are expensive
    if (e > mtn) c += 25; // avoid high passes
    if (road[i]) c *= 0.4; // reuse existing roads
    return c;
  }

  function tracePath(a, b) {
    const start = a.y * W + a.x, goal = b.y * W + b.x;
    const g = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    const gx = goal % W, gy = (goal / W) | 0;
    g[start] = 0;
    heap.push(0, start);
    let pops = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) break;
      if (++pops > 90000) return;
      const x = cur % W, y = (cur / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const x2 = x + dx, y2 = y + dy;
          if (x2 < 0 || y2 < 0 || x2 >= W || y2 >= H) continue;
          const j = y2 * W + x2;
          const cc = cellCost(j);
          if (cc < 0) continue;
          const ng = g[cur] + cc * (dx && dy ? 1.4142 : 1);
          if (ng < g[j]) {
            g[j] = ng;
            came[j] = cur;
            const h = Math.hypot(x2 - gx, y2 - gy) * 0.4; // admissible: min cost is 0.4
            heap.push(ng + h, j);
          }
        }
      }
    }
    if (!isFinite(g[goal])) return;
    let c = goal;
    while (c !== start && c >= 0) { road[c] = 1; c = came[c]; }
    road[start] = 1;
  }

  if (towns.length >= 2) {
    const inTree = [0];
    const left = towns.map((_, idx) => idx).slice(1);
    while (left.length) {
      let bi = -1, bj = -1, bd = Infinity;
      for (const i of inTree) {
        for (const j of left) {
          const dx = towns[i].x - towns[j].x, dy = towns[i].y - towns[j].y;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
      }
      tracePath(towns[bi], towns[bj]);
      inTree.push(bj);
      left.splice(left.indexOf(bj), 1);
    }
  }

  return { W, H, elev, moist, temp, slope, biome, fresh, road, towns, sea, mtn, riverCount };
}
