"use strict";

/* ---------- Small colour helpers ---------- */

function rgbStr(r, g, b) {
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// stops: [[t, [r,g,b]], ...] sorted by t
function rampColor(stops, t) {
  for (let k = 1; k < stops.length; k++) {
    if (t <= stops[k][0]) {
      const t0 = stops[k - 1][0], c0 = stops[k - 1][1];
      const t1 = stops[k][0], c1 = stops[k][1];
      return lerp3(c0, c1, (t - t0) / (t1 - t0 || 1));
    }
  }
  return stops[stops.length - 1][1];
}

/* ---------- Per-cell colours ---------- */

const WATER_SHALLOW = [66, 152, 186];
const WATER_DEEP = [15, 40, 84];
const FOAM = [220, 235, 240];
const RIVER_COLOR = [56, 122, 158];
const ROAD_COLOR = [150, 120, 86];
const BRIDGE_COLOR = [110, 82, 56];

// Biomes that get a stronger dappled texture (forests read as canopy)
const DAPPLED = new Set([BIOME.TROPICAL, BIOME.FOREST, BIOME.TAIGA]);

function hillshade(w, x, y) {
  const iNW = Math.max(0, y - 1) * w.W + Math.max(0, x - 1);
  const iSE = Math.min(w.H - 1, y + 1) * w.W + Math.min(w.W - 1, x + 1);
  const s = 1 + (w.elev[iNW] - w.elev[iSE]) * 9;
  return s < 0.76 ? 0.76 : s > 1.22 ? 1.22 : s;
}

function biomeColor(w, i, x, y) {
  const e = w.elev[i], sea = w.sea;
  const isWater = e < sea;
  const isFresh = w.fresh[i] > 0;

  if (w.road[i]) return isWater || isFresh ? BRIDGE_COLOR : ROAD_COLOR;
  if (isFresh && !isWater) return RIVER_COLOR;

  if (isWater) {
    const depth = Math.pow(clamp01((sea - e) / Math.max(sea, 0.001)), 0.55);
    let c = lerp3(WATER_SHALLOW, WATER_DEEP, depth);
    if (sea - e < 0.006) c = lerp3(c, FOAM, 0.35); // shoreline foam
    return c;
  }

  const b = w.biome[i];
  const base = BIOME_INFO[b].color;
  const shade = hillshade(w, x, y);
  const amp = DAPPLED.has(b) ? 0.18 : 0.09;
  const j = 1 + (cellHash(x, y) - 0.5) * amp;
  return [base[0] * shade * j, base[1] * shade * j, base[2] * shade * j];
}

const ELEV_LAND_RAMP = [
  [0, [70, 120, 60]],
  [0.4, [200, 190, 120]],
  [0.7, [140, 110, 80]],
  [1, [245, 245, 245]],
];

function elevColor(w, i, x, y) {
  const e = w.elev[i];
  if (e < w.sea) {
    const t = clamp01((w.sea - e) / Math.max(w.sea, 0.001));
    return lerp3([45, 58, 80], [18, 24, 36], t);
  }
  const t = clamp01((e - w.sea) / Math.max(1 - w.sea, 0.001));
  const c = rampColor(ELEV_LAND_RAMP, t);
  const shade = hillshade(w, x, y);
  return [c[0] * shade, c[1] * shade, c[2] * shade];
}

function moistColor(w, i) {
  if (w.elev[i] < w.sea) return [30, 34, 44];
  return lerp3([214, 204, 163], [24, 80, 150], clamp01(w.moist[i]));
}

function tempColor(w, i) {
  if (w.elev[i] < w.sea) return [30, 34, 44];
  return lerp3([64, 110, 200], [228, 88, 48], clamp01(w.temp[i]));
}

/* ---------- Main renderer ---------- */

function renderWorld(world, view, canvas) {
  const { W, H } = world;

  // draw the world at grid resolution, then upscale with crisp pixels
  const off = renderWorld._off || (renderWorld._off = document.createElement("canvas"));
  if (off.width !== W || off.height !== H) { off.width = W; off.height = H; }
  const octx = off.getContext("2d");
  const img = octx.createImageData(W, H);
  const data = img.data;

  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    let c;
    if (view === "elev") c = elevColor(world, i, x, y);
    else if (view === "moist") c = moistColor(world, i);
    else if (view === "temp") c = tempColor(world, i);
    else c = biomeColor(world, i, x, y);
    const o = i * 4;
    data[o] = Math.min(255, c[0]);
    data[o + 1] = Math.min(255, c[1]);
    data[o + 2] = Math.min(255, c[2]);
    data[o + 3] = 255;
  }
  octx.putImageData(img, 0, 0);

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

  if (view === "biome") drawTowns(ctx, world, canvas.width / W, canvas.height / H);
}

/* ---------- Towns: houses + labels ---------- */

const ROOF_COLORS = ["#b5543b", "#a04a32", "#8f6e4c", "#6d5844", "#95564a", "#7d6a52"];

function drawTowns(ctx, w, sx, sy) {
  for (const t of w.towns) {
    const trng = mulberry32(hashSeed(t.name));
    const n = Math.round(7 + t.size * 11);
    const rad = 3 + t.size * 4;

    const houses = [];
    for (let k = 0; k < n * 3 && houses.length < n; k++) {
      const a = trng() * Math.PI * 2;
      const d = Math.sqrt(trng()) * rad;
      const hx = Math.round(t.x + Math.cos(a) * d);
      const hy = Math.round(t.y + Math.sin(a) * d * 0.8);
      if (hx < 1 || hy < 1 || hx >= w.W - 1 || hy >= w.H - 1) continue;
      const i = hy * w.W + hx;
      if (w.elev[i] < w.sea || w.fresh[i]) continue;
      houses.push([hx, hy]);
    }

    for (const [hx, hy] of houses) {
      const px = hx * sx, py = hy * sy;
      const hw = 4 + ((trng() * 3) | 0), hh = 3 + ((trng() * 2) | 0);
      ctx.fillStyle = "rgba(30,22,16,0.85)";
      ctx.fillRect(px - hw / 2 - 1, py - hh / 2 - 1, hw + 2, hh + 2);
      ctx.fillStyle = ROOF_COLORS[(trng() * ROOF_COLORS.length) | 0];
      ctx.fillRect(px - hw / 2, py - hh / 2, hw, hh);
    }

    const lx = t.x * sx;
    const ly = Math.max(14, (t.y - rad - 2) * sy);
    ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(10,14,18,0.7)";
    ctx.strokeText(t.name, lx, ly);
    ctx.fillStyle = "#f2f6fa";
    ctx.fillText(t.name, lx, ly);
  }
}
