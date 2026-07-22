"use strict";

/* ---------- Isometric projection ---------- */

const ISO_HW = 8, ISO_HH = 4, ISO_BZ = 8; // block: 16px wide diamond, 8px tall sides

function isoX(x, y) { return (x - y) * ISO_HW; }
function isoY(x, y, z) { return (x + y) * ISO_HH - z * ISO_BZ; }

/* ---------- colour helpers ---------- */

function hex2rgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function shadeCss(hex, f) {
  const [r, g, b] = hex2rgb(hex);
  return `rgb(${Math.min(255, (r * f) | 0)},${Math.min(255, (g * f) | 0)},${Math.min(255, (b * f) | 0)})`;
}

/* ---------- per-material face textures ----------
 * Every material gets a handful of pre-rendered sprite variants per face
 * (top diamond, left, right). Blocks pick a variant by position hash, so the
 * terrain looks textured but rendering stays plain drawImage calls.
 */

const SKY_MAT_STYLE = {
  [SM.GRASS]: { top: "#7cb95c", side: "#8a6b4a", topSpeckle: ["#8fce6b", "#68a84e", "#a5d97f"], sideSpeckle: ["#7a5c40", "#9a7a55"] },
  [SM.DIRT]: { top: "#94724f", side: "#8a6b4a", topSpeckle: ["#a5825c", "#7d5f42"], sideSpeckle: ["#7a5c40", "#9a7a55"] },
  [SM.STONE]: { top: "#98948c", side: "#8d8880", topSpeckle: ["#a8a49c", "#807c74"], sideSpeckle: ["#9c9890", "#767068"] },
  [SM.SAND]: { top: "#e8d7a0", side: "#d9c186", topSpeckle: ["#f2e3b4", "#d9c184"], sideSpeckle: ["#e6d29a", "#c9b276"] },
  [SM.SNOW]: { top: "#eef3f6", side: "#cfdbe4", topSpeckle: ["#ffffff", "#dfe9f2"], sideSpeckle: ["#dce6ee", "#c2d2de"] },
  [SM.WATER]: { top: "#58a7d6", side: "#3f8dc4", topSpeckle: ["#7fc0e4", "#4a9cd0"], sideSpeckle: ["#5aa5d4", "#3a82b6"] },
  [SM.TRUNK]: { top: "#8a6844", side: "#7a5a3a", topSpeckle: ["#9a7852", "#6e5236"], sideSpeckle: ["#684c30", "#8a6844"] },
  [SM.LEAF]: { top: "#578f46", side: "#4a7f3c", topSpeckle: ["#69a455", "#487b39", "#7bb464"], sideSpeckle: ["#548b44", "#3f6f33"] },
  [SM.CHARRED]: { top: "#3a3430", side: "#322c28", topSpeckle: ["#241f1c", "#4a423c"], sideSpeckle: ["#241f1c", "#443c36"] },
};

const skySprites = {};
const SPR_VARIANTS = 4;

function makeTopSprite(st, r, mat) {
  const c = document.createElement("canvas");
  c.width = 16; c.height = 8;
  const g = c.getContext("2d");
  g.beginPath();
  g.moveTo(8, 0); g.lineTo(16, 4); g.lineTo(8, 8); g.lineTo(0, 4);
  g.closePath();
  g.save();
  g.clip();
  g.fillStyle = shadeCss(st.top, 0.96 + r() * 0.08);
  g.fillRect(0, 0, 16, 8);
  const n = mat === SM.SNOW ? 5 : 12;
  for (let i = 0; i < n; i++) {
    g.fillStyle = st.topSpeckle[(r() * st.topSpeckle.length) | 0];
    g.fillRect((r() * 15) | 0, (r() * 7) | 0, 1, 1);
  }
  if (mat === SM.GRASS && r() < 0.3) { // occasional tiny flower
    g.fillStyle = r() < 0.5 ? "#f2f0da" : "#e8c95c";
    g.fillRect(4 + ((r() * 8) | 0), 2 + ((r() * 4) | 0), 1, 1);
  }
  if (mat === SM.STONE) { // hairline crack
    g.strokeStyle = "rgba(60,58,54,.5)";
    g.lineWidth = 1;
    g.beginPath();
    const x0 = 3 + r() * 6, y0 = 2 + r() * 3;
    g.moveTo(x0, y0); g.lineTo(x0 + 3, y0 + 1 + r() * 2);
    g.stroke();
  }
  if (mat === SM.WATER) { // ripple glint
    g.fillStyle = "rgba(220,240,250,.5)";
    g.fillRect(3 + ((r() * 6) | 0), 2 + ((r() * 3) | 0), 4, 1);
  }
  if (mat === SM.CHARRED && r() < 0.5) { // faint ember fleck
    g.fillStyle = "#c25a24";
    g.fillRect(4 + ((r() * 8) | 0), 2 + ((r() * 4) | 0), 1, 1);
  }
  g.restore();
  // bevel highlight on the two back edges
  g.strokeStyle = "rgba(255,255,255,.25)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0.5, 4); g.lineTo(8, 0.5); g.lineTo(15.5, 4);
  g.stroke();
  return c;
}

function makeSideSprite(st, r, mat, right) {
  const c = document.createElement("canvas");
  c.width = 8; c.height = 12;
  const g = c.getContext("2d");
  g.beginPath();
  if (right) { g.moveTo(8, 0); g.lineTo(0, 4); g.lineTo(0, 12); g.lineTo(8, 8); }
  else { g.moveTo(0, 0); g.lineTo(8, 4); g.lineTo(8, 12); g.lineTo(0, 8); }
  g.closePath();
  g.save();
  g.clip();
  const f = right ? 0.74 : 0.55;
  g.fillStyle = shadeCss(st.side, f * (0.96 + r() * 0.08));
  g.fillRect(0, 0, 8, 12);
  for (let i = 0; i < 7; i++) {
    g.fillStyle = shadeCss(st.sideSpeckle[(r() * st.sideSpeckle.length) | 0], f);
    g.fillRect((r() * 8) | 0, (r() * 12) | 0, 1, 1);
  }
  if (mat === SM.GRASS) { // grass fringe hanging over the dirt
    for (let px = 0; px < 8; px++) {
      const edgeY = right ? (8 - px) * 0.5 : px * 0.5;
      g.fillStyle = shadeCss(["#6da84f", "#7cb95c", "#5c9843"][(r() * 3) | 0], right ? 0.88 : 0.7);
      g.fillRect(px, edgeY, 1, 1.5 + r() * 1.5);
    }
  }
  if (mat === SM.TRUNK) { // bark grain
    g.strokeStyle = "rgba(40,26,14,.45)";
    g.lineWidth = 1;
    for (let i = 1; i <= 2; i++) { g.beginPath(); g.moveTo(i * 2.5, 0); g.lineTo(i * 2.5, 12); g.stroke(); }
  }
  // baked-in bottom darkening for depth
  const grad = g.createLinearGradient(0, 4, 0, 12);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,.25)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 12);
  g.restore();
  return c;
}

function buildSkySprites() {
  for (const matStr of Object.keys(SKY_MAT_STYLE)) {
    const mat = +matStr;
    const st = SKY_MAT_STYLE[mat];
    skySprites[mat] = { top: [], left: [], right: [] };
    for (let v = 0; v < SPR_VARIANTS; v++) {
      const r = mulberry32((0xbeef + mat * 97 + v * 31) >>> 0);
      skySprites[mat].top.push(makeTopSprite(st, r, mat));
      skySprites[mat].right.push(makeSideSprite(st, r, mat, true));
      skySprites[mat].left.push(makeSideSprite(st, r, mat, false));
    }
  }
}

/* ---------- island prerender ----------
 * Each island renders once into its own canvas; per frame we just composite
 * the canvases (with a bob offset). Damaged islands re-render individually.
 */

function renderIsland(world, isl) {
  const { W, D, H, blocks, topZ, botZ } = world;
  let minsx = Infinity, maxsx = -Infinity, minsy = Infinity, maxsy = -Infinity;
  for (const c of isl.cols) {
    if (topZ[c] < 0) continue;
    const x = c % W, y = (c / W) | 0;
    const sx = isoX(x, y);
    if (sx - ISO_HW < minsx) minsx = sx - ISO_HW;
    if (sx + ISO_HW > maxsx) maxsx = sx + ISO_HW;
    const syTop = isoY(x, y, topZ[c]);
    const syBot = isoY(x, y, botZ[c]) + 2 * ISO_HH + ISO_BZ;
    if (syTop < minsy) minsy = syTop;
    if (syBot > maxsy) maxsy = syBot;
  }
  if (!isFinite(minsx)) { isl.canvas = null; return; } // island fully destroyed

  const w = Math.ceil(maxsx - minsx) + 2;
  const h = Math.ceil(maxsy - minsy) + 2;
  let cv = isl.canvas;
  if (!cv || cv.width !== w || cv.height !== h) {
    cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
  }
  const g = cv.getContext("2d");
  g.clearRect(0, 0, w, h);
  const ox = minsx - 1, oy = minsy - 1;

  for (const c of isl.cols) { // pre-sorted back-to-front by (x + y)
    if (topZ[c] < 0) continue;
    const x = c % W, y = (c / W) | 0;
    const base = c * H;
    for (let z = Math.max(0, botZ[c]); z <= topZ[c]; z++) {
      const mat = blocks[base + z];
      if (!mat) continue;
      const nT = z + 1 < H && blocks[base + z + 1];
      const nR = x + 1 < W && blocks[skyIdx(x + 1, y, z)];
      const nL = y + 1 < D && blocks[skyIdx(x, y + 1, z)];
      if (nT && nR && nL) continue;
      const spr = skySprites[mat];
      const v = (cellHash(x * 3 + z * 11, y * 5 + z * 7) * SPR_VARIANTS) | 0;
      const sx = isoX(x, y) - ox, sy = isoY(x, y, z) - oy;
      if (!nL) g.drawImage(spr.left[v], sx - ISO_HW, sy + ISO_HH);
      if (!nR) g.drawImage(spr.right[v], sx, sy + ISO_HH);
      if (!nT) g.drawImage(spr.top[v], sx - ISO_HW, sy);
    }
  }
  isl.canvas = cv;
  isl.ox = ox;
  isl.oy = oy;
}

/* ---------- clouds ---------- */

const cloudSprites = [];

function buildCloudSprites() {
  const crng = mulberry32(0xc100d5);
  for (let k = 0; k < 6; k++) {
    const c = document.createElement("canvas");
    c.width = 180; c.height = 90;
    const g = c.getContext("2d");
    const puffs = 7 + ((crng() * 5) | 0);
    for (let i = 0; i < puffs; i++) {
      const px = 30 + crng() * 120, py = 40 + crng() * 24;
      const pr = 14 + crng() * 22;
      const grad = g.createRadialGradient(px, py - 6, pr * 0.2, px, py, pr);
      grad.addColorStop(0, "rgba(255,255,255,.95)");
      grad.addColorStop(0.75, "rgba(244,248,252,.55)");
      grad.addColorStop(1, "rgba(238,244,250,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(px, py, pr, 0, Math.PI * 2);
      g.fill();
    }
    // soft blue-grey underside
    g.globalCompositeOperation = "source-atop";
    const sh = g.createLinearGradient(0, 40, 0, 90);
    sh.addColorStop(0, "rgba(160,185,210,0)");
    sh.addColorStop(1, "rgba(150,175,205,.45)");
    g.fillStyle = sh;
    g.fillRect(0, 0, 180, 90);
    g.globalCompositeOperation = "source-over";
    cloudSprites.push(c);
  }
}

/* ---------- sky backdrop ---------- */

let skyGradient = null, skyGradH = 0;

function drawSkyBackdrop(ctx, w, h) {
  if (!skyGradient || skyGradH !== h) {
    skyGradient = ctx.createLinearGradient(0, 0, 0, h);
    skyGradient.addColorStop(0, "#2e5c96");
    skyGradient.addColorStop(0.45, "#6fa3cc");
    skyGradient.addColorStop(0.8, "#cfe0e8");
    skyGradient.addColorStop(1, "#f2ddb8");
    skyGradH = h;
  }
  ctx.fillStyle = skyGradient;
  ctx.fillRect(0, 0, w, h);
  // sun glow
  const sx = w * 0.78, sy = h * 0.16;
  const sun = ctx.createRadialGradient(sx, sy, 6, sx, sy, 150);
  sun.addColorStop(0, "rgba(255,250,225,.85)");
  sun.addColorStop(0.25, "rgba(255,244,200,.35)");
  sun.addColorStop(1, "rgba(255,244,200,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(sx - 150, sy - 150, 300, 300);
}
