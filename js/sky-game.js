"use strict";

/* ---------- Skylands: game loop, ship, missiles, fire, particles ---------- */

const skyCanvas = document.getElementById("sky-canvas");
const skyCtx = skyCanvas.getContext("2d");
const statsEl = document.getElementById("sky-stats");
const seedInput = document.getElementById("sky-seed");

let SVW = 0, SVH = 0, SDPR = 1;
function resizeSky() {
  SDPR = Math.min(window.devicePixelRatio || 1, 2);
  SVW = window.innerWidth;
  SVH = window.innerHeight;
  skyCanvas.width = Math.round(SVW * SDPR);
  skyCanvas.height = Math.round(SVH * SDPR);
  skyCanvas.style.width = SVW + "px";
  skyCanvas.style.height = SVH + "px";
  skyGradient = null;
}
window.addEventListener("resize", resizeSky);
resizeSky();

/* ---------- state ---------- */

let world = null;
const cam = { x: 0, y: 0 };
let shake = 0, shakeX = 0, shakeY = 0;
const ship = { x: 52, y: 52, vx: 0, vy: 0, z: 58 };
let missiles = [];
let particles = [];
const burning = new Map(); // blockIdx -> {x,y,z, ig, until}
const dirtyIslands = new Set();
let clouds = [];
const mouse = { x: -1000, y: -1000 };
const keys = new Set();
let muted = false;
let fireAcc = 0;
let lastShot = 0;
let lastT = 0;

function bobOf(isl, tSec) {
  return Math.round(Math.sin(tSec * isl.speed + isl.phase) * isl.amp);
}

function toScreenX(wx, wy) { return isoX(wx, wy) - cam.x + SVW / 2 + shakeX; }
function toScreenY(wx, wy, wz) { return isoY(wx, wy, wz) - cam.y + SVH / 2 + shakeY; }

/* ---------- audio (tiny synth) ---------- */

let actx = null;
function audio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === "suspended") actx.resume();
  return actx;
}
function boomSound() {
  if (muted) return;
  try {
    const a = audio(), t = a.currentTime, dur = 0.7;
    const buf = a.createBuffer(1, (a.sampleRate * dur) | 0, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
    const src = a.createBufferSource();
    src.buffer = buf;
    const lp = a.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(60, t + dur);
    const gn = a.createGain();
    gn.gain.setValueAtTime(0.5, t);
    gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(lp); lp.connect(gn); gn.connect(a.destination);
    src.start();
    const osc = a.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.5);
    const og = a.createGain();
    og.gain.setValueAtTime(0.45, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(og); og.connect(a.destination);
    osc.start(t); osc.stop(t + 0.55);
  } catch (e) { /* audio unavailable */ }
}
function whooshSound() {
  if (muted) return;
  try {
    const a = audio(), t = a.currentTime, dur = 0.4;
    const buf = a.createBuffer(1, (a.sampleRate * dur) | 0, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource();
    src.buffer = buf;
    const bp = a.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(1600, t + dur);
    const gn = a.createGain();
    gn.gain.setValueAtTime(0.16, t);
    gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp); bp.connect(gn); gn.connect(a.destination);
    src.start();
  } catch (e) { /* audio unavailable */ }
}

/* ---------- world lifecycle ---------- */

function newWorld(seedStr) {
  const t0 = performance.now();
  world = generateSky(seedStr);
  for (const isl of world.islands) renderIsland(world, isl);
  let best = null;
  for (const isl of world.islands) if (!best || isl.cols.length > best.cols.length) best = isl;
  if (best) { ship.x = best.cx; ship.y = best.cy; }
  ship.vx = ship.vy = 0;
  missiles = [];
  particles = [];
  burning.clear();
  dirtyIslands.clear();
  const crng = mulberry32(hashSeed(seedStr + ":clouds"));
  clouds = [];
  for (let i = 0; i < 16; i++) {
    clouds.push({
      x: crng() * world.W, y: crng() * world.D,
      z: i < 11 ? 2 + crng() * 5 : 56 + crng() * 6,
      spr: cloudSprites[(crng() * cloudSprites.length) | 0],
      sc: 0.7 + crng() * 1.6,
      v: 0.25 + crng() * 0.5,
    });
  }
  cam.x = isoX(ship.x, ship.y);
  cam.y = isoY(ship.x, ship.y, ship.z) + SVH * 0.22; // match the follow target
  seedInput.value = seedStr;
  statsEl.textContent =
    `${world.islands.length} islands · ${world.trees} trees · ${world.waterfalls.length} falls · ${Math.round(performance.now() - t0)} ms`;
}

function afterBlockEdits(changedCols) {
  const { W, H, blocks, topZ, botZ, islandOf } = world;
  for (const c of changedCols) {
    const x = c % W, y = (c / W) | 0;
    topZ[c] = -1;
    botZ[c] = -1;
    for (let z = H - 1; z >= 0; z--) if (blocks[skyIdx(x, y, z)]) { topZ[c] = z; break; }
    if (topZ[c] >= 0) {
      for (let z = 0; z < H; z++) if (blocks[skyIdx(x, y, z)]) { botZ[c] = z; break; }
    }
    if (islandOf[c] >= 0) dirtyIslands.add(islandOf[c]);
  }
}

/* ---------- picking (screen -> block) ---------- */

function pickBlock(mx, my, tSec) {
  if (!world) return null;
  const { W, D, H, blocks, islandOf, islands } = world;
  for (let k = islands.length - 1; k >= 0; k--) { // front to back
    const isl = islands[k];
    if (!isl.canvas) continue;
    const sxw = mx - SVW / 2 + cam.x - shakeX;
    const syw = my - SVH / 2 + cam.y - shakeY - bobOf(isl, tSec);
    const a = sxw / ISO_HW;
    let best = null;
    for (let z = H - 1; z >= 0; z--) {
      const b0 = (syw + z * ISO_BZ - ISO_HH) / ISO_HH;
      // a pixel can be a block's top face (offset 0) or a side face of a block
      // up to 3 columns in front (side faces extend 2*HH+BZ below the anchor)
      for (let off = 0; off <= 3; off++) {
        const b = b0 - off;
        const x = Math.round((a + b) / 2);
        const y = Math.round((b - a) / 2);
        if (x < 0 || y < 0 || x >= W || y >= D) continue;
        const c = skyCol(x, y);
        if (islandOf[c] !== isl.id) continue;
        if (!blocks[skyIdx(x, y, z)]) continue;
        const hiddenTop = z + 1 < H && blocks[skyIdx(x, y, z + 1)];
        const hiddenR = x + 1 < W && blocks[skyIdx(x + 1, y, z)];
        const hiddenL = y + 1 < D && blocks[skyIdx(x, y + 1, z)];
        if (hiddenTop && hiddenR && hiddenL) continue; // interior, not visible
        // keep the frontmost visible candidate (painter order), then highest
        if (!best || x + y > best.x + best.y || (x + y === best.x + best.y && z > best.z)) {
          best = { x, y, z, isl };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/* ---------- particles ---------- */

function spawn(p) {
  if (particles.length < 900) particles.push(p);
}

function spawnExplosionFx(sx, sy, big) {
  spawn({ type: "flash", x: sx, y: sy, age: 0, life: 0.14, r0: 8, r1: big ? 64 : 44 });
  spawn({ type: "ring", x: sx, y: sy, age: 0, life: 0.5, r0: 6, r1: big ? 84 : 58 });
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 200;
    spawn({
      type: "spark", x: sx, y: sy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.55 - 60,
      g: 320, age: 0, life: 0.35 + Math.random() * 0.35,
    });
  }
  for (let i = 0; i < 12; i++) {
    spawn({
      type: "smoke", x: sx + (Math.random() - 0.5) * 16, y: sy + (Math.random() - 0.5) * 8,
      vx: (Math.random() - 0.5) * 26, vy: -26 - Math.random() * 34, g: -14,
      age: -Math.random() * 0.25, life: 1.1 + Math.random() * 0.9,
      r: 4 + Math.random() * 5, dark: Math.random() < 0.45,
    });
  }
}

function spawnDebris(sx, sy, mat) {
  const st = SKY_MAT_STYLE[mat] || SKY_MAT_STYLE[SM.STONE];
  const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 130;
  spawn({
    type: "debris", x: sx, y: sy, vx: Math.cos(a) * sp, vy: -60 - Math.random() * 130,
    g: 420, age: 0, life: 0.8 + Math.random() * 0.7,
    size: 2 + Math.random() * 3, color: Math.random() < 0.5 ? st.top : st.side,
    rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
  });
}

function updateAndDrawParticles(ctx, dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age += dt;
    if (p.age < 0) continue;
    if (p.age >= p.life) {
      if (p.type === "water") { // waterfall droplets burst into mist
        spawn({
          type: "mist", x: p.x, y: p.y, vx: (Math.random() - 0.5) * 8, vy: 6, g: -8,
          age: 0, life: 0.7 + Math.random() * 0.5, r: 3 + Math.random() * 3,
        });
      }
      particles.splice(i, 1);
      continue;
    }
    const t = p.age / p.life;
    if (p.vx !== undefined) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.g || 0) * dt; }
    switch (p.type) {
      case "flash": {
        const r = p.r0 + (p.r1 - p.r0) * t;
        ctx.globalCompositeOperation = "lighter";
        const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        gr.addColorStop(0, `rgba(255,245,205,${0.9 * (1 - t)})`);
        gr.addColorStop(1, "rgba(255,180,80,0)");
        ctx.fillStyle = gr;
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
        ctx.globalCompositeOperation = "source-over";
        break;
      }
      case "ring": {
        const r = p.r0 + (p.r1 - p.r0) * (1 - Math.pow(1 - t, 2));
        ctx.strokeStyle = `rgba(255,240,215,${0.55 * (1 - t)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r, r * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "spark": {
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = t < 0.5 ? "rgba(255,220,140,.9)" : `rgba(255,120,40,${1.6 * (1 - t)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
        ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
        break;
      }
      case "smoke": {
        const r = p.r * (1 + t * 2.2);
        const al = 0.4 * (1 - t);
        ctx.fillStyle = p.dark ? `rgba(52,48,46,${al})` : `rgba(120,116,112,${al})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "steam": case "mist": {
        const r = p.r * (1 + t * 1.6);
        ctx.fillStyle = `rgba(235,244,250,${0.35 * (1 - t)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "flame": {
        ctx.globalCompositeOperation = "lighter";
        const r = p.r * (1 - t * 0.6);
        const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        gr.addColorStop(0, `rgba(255,230,150,${0.85 * (1 - t)})`);
        gr.addColorStop(0.6, `rgba(255,120,40,${0.5 * (1 - t)})`);
        gr.addColorStop(1, "rgba(200,40,10,0)");
        ctx.fillStyle = gr;
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
        ctx.globalCompositeOperation = "source-over";
        break;
      }
      case "debris": {
        p.rot += p.vr * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.fillStyle = "rgba(0,0,0,.3)";
        ctx.fillRect(-p.size / 2, 0, p.size, p.size / 2);
        ctx.restore();
        break;
      }
      case "water": {
        ctx.fillStyle = "rgba(190,228,247,.8)";
        ctx.fillRect(p.x, p.y, 1.5, 3.5);
        break;
      }
    }
  }
}

/* ---------- explosions & fire ---------- */

function igniteBlock(i, x, y, z, delay) {
  if (burning.size >= 170 || burning.has(i)) return;
  const now = performance.now();
  burning.set(i, { x, y, z, ig: now + delay, until: now + delay + 3200 + Math.random() * 2600 });
}

function explode(bx, by, bz, aerial, tSec) {
  shake = Math.min(12, shake + 7);
  boomSound();
  let bob = 0;
  if (!aerial && world) {
    const id = world.islandOf[skyCol(bx, by)];
    if (id >= 0) bob = bobOf(world.islands[id], tSec);
  }
  const sx = toScreenX(bx, by), sy = toScreenY(bx, by, bz) + bob;
  spawnExplosionFx(sx, sy, !aerial);
  if (aerial || !world) return;

  const R = 3.4, R2 = R + 1.7;
  const changed = new Set();
  let debris = 0;
  for (let dz = -5; dz <= 5; dz++) {
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const x = bx + dx, y = by + dy, z = bz + dz;
        if (x < 0 || y < 0 || z < 1 || x >= world.W || y >= world.D || z >= world.H) continue;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz * 1.15);
        if (d > R2) continue;
        const i = skyIdx(x, y, z);
        const mat = world.blocks[i];
        if (!mat) continue;
        if (d <= R) {
          world.blocks[i] = SM.AIR;
          burning.delete(i);
          changed.add(skyCol(x, y));
          const psx = toScreenX(x, y), psy = toScreenY(x, y, z) + bob;
          if (mat === SM.WATER) {
            spawn({ type: "steam", x: psx, y: psy, vx: 0, vy: -22, g: -10, age: 0, life: 1.1, r: 4 });
          } else if (debris < 46 && Math.random() < 0.8) {
            debris++;
            spawnDebris(psx, psy, mat);
          }
        } else if (SKY_FLAMMABLE.has(mat)) {
          if (Math.random() < 0.55) igniteBlock(i, x, y, z, Math.random() * 700);
          else if (Math.random() < 0.5) { world.blocks[i] = SM.CHARRED; changed.add(skyCol(x, y)); }
        } else if (mat !== SM.WATER && d < R + 0.9 && Math.random() < 0.35) {
          world.blocks[i] = SM.CHARRED; // scorched crater rim
          changed.add(skyCol(x, y));
        }
      }
    }
  }
  afterBlockEdits(changed);
}

function fireTick(tSec) {
  const now = performance.now();
  const changed = new Set();
  for (const [i, b] of Array.from(burning)) {
    if (now < b.ig) continue;
    const mat = world.blocks[i];
    if (!mat || !SKY_FLAMMABLE.has(mat)) { burning.delete(i); continue; }
    if (now > b.until) { // burn out
      world.blocks[i] = mat === SM.LEAF && Math.random() < 0.75 ? SM.AIR : SM.CHARRED;
      changed.add(skyCol(b.x, b.y));
      burning.delete(i);
      continue;
    }
    if (Math.random() < 0.3 && burning.size < 170) { // spread
      const dx = ((Math.random() * 3) | 0) - 1;
      const dy = ((Math.random() * 3) | 0) - 1;
      const dz = ((Math.random() * 3) | 0) - 1;
      const x = b.x + dx, y = b.y + dy, z = b.z + dz;
      if (x >= 0 && y >= 0 && z >= 1 && x < world.W && y < world.D && z < world.H) {
        const j = skyIdx(x, y, z);
        if (SKY_FLAMMABLE.has(world.blocks[j])) igniteBlock(j, x, y, z, 200 + Math.random() * 800);
      }
    }
  }
  afterBlockEdits(changed);
}

/* ---------- ship & missiles ---------- */

function updateShip(dt) {
  let ax = 0, ay = 0; // screen-space intent
  if (keys.has("KeyA") || keys.has("ArrowLeft")) ax -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) ax += 1;
  if (keys.has("KeyW") || keys.has("ArrowUp")) ay -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) ay += 1;
  // screen right = world (+x,-y), screen down = world (+x,+y)
  const k = 38 * dt;
  ship.vx += (ax + ay) * k;
  ship.vy += (ay - ax) * k;
  const damp = Math.max(0, 1 - 2.6 * dt);
  ship.vx *= damp;
  ship.vy *= damp;
  ship.x = Math.max(3, Math.min(world.W - 3, ship.x + ship.vx * dt));
  ship.y = Math.max(3, Math.min(world.D - 3, ship.y + ship.vy * dt));
}

function fireMissile(tSec) {
  const now = performance.now();
  if (now - lastShot < 180) return;
  lastShot = now;
  const pick = pickBlock(mouse.x, mouse.y, tSec);
  let tx, ty, tz, aerial;
  if (pick) {
    tx = pick.x; ty = pick.y; tz = pick.z; aerial = false;
  } else { // airburst where the click ray crosses mid-sky
    const sxw = mouse.x - SVW / 2 + cam.x;
    const syw = mouse.y - SVH / 2 + cam.y;
    const a = sxw / ISO_HW, b = (syw + 16 * ISO_BZ) / ISO_HH;
    tx = (a + b) / 2; ty = (b - a) / 2; tz = 16; aerial = true;
  }
  const dist = Math.hypot(tx - ship.x, ty - ship.y);
  missiles.push({
    x0: ship.x, y0: ship.y, z0: ship.z - 2,
    tx, ty, tz, aerial,
    t: 0, T: Math.max(0.5, Math.min(1.5, 0.45 + dist * 0.022)),
    arc: 5 + dist * 0.12,
  });
  whooshSound();
}

function missilePos(m) {
  const t = m.t;
  return {
    x: m.x0 + (m.tx - m.x0) * t,
    y: m.y0 + (m.ty - m.y0) * t,
    z: m.z0 + (m.tz - m.z0) * t + Math.sin(Math.PI * t) * m.arc,
  };
}

function updateMissiles(dt, tSec) {
  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i];
    m.t += dt / m.T;
    if (m.t >= 1) {
      missiles.splice(i, 1);
      explode(Math.round(m.tx), Math.round(m.ty), Math.round(m.tz), m.aerial, tSec);
      continue;
    }
    const p = missilePos(m);
    if (Math.random() < dt * 60) {
      spawn({
        type: "smoke", x: toScreenX(p.x, p.y), y: toScreenY(p.x, p.y, p.z),
        vx: (Math.random() - 0.5) * 10, vy: -6, g: -6,
        age: 0, life: 0.55 + Math.random() * 0.4, r: 1.6 + Math.random() * 1.6, dark: false,
      });
    }
  }
}

function drawMissiles(ctx) {
  for (const m of missiles) {
    const p = missilePos(m);
    const m2 = { ...m, t: Math.min(1, m.t + 0.03) };
    const p2 = missilePos(m2);
    const sx = toScreenX(p.x, p.y), sy = toScreenY(p.x, p.y, p.z);
    const ang = Math.atan2(toScreenY(p2.x, p2.y, p2.z) - sy, toScreenX(p2.x, p2.y) - sx);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(ang);
    ctx.globalCompositeOperation = "lighter"; // exhaust
    const fl = 6 + Math.random() * 5;
    const gr = ctx.createLinearGradient(-4 - fl, 0, -4, 0);
    gr.addColorStop(0, "rgba(255,120,30,0)");
    gr.addColorStop(1, "rgba(255,210,120,.9)");
    ctx.fillStyle = gr;
    ctx.fillRect(-4 - fl, -1.5, fl, 3);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#d8d3c8"; // body
    ctx.fillRect(-5, -2, 10, 4);
    ctx.fillStyle = "#b8412e"; // nose
    ctx.beginPath();
    ctx.moveTo(5, -2); ctx.lineTo(9, 0); ctx.lineTo(5, 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#8a8478"; // fins
    ctx.fillRect(-6, -3.5, 3, 2);
    ctx.fillRect(-6, 1.5, 3, 2);
    ctx.restore();
  }
}

function drawShip(ctx, tMs) {
  const sx = toScreenX(ship.x, ship.y);
  const sy = toScreenY(ship.x, ship.y, ship.z) + Math.sin(tMs * 0.0012) * 2;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(Math.max(-0.16, Math.min(0.16, ship.vx * 0.012)));
  // ropes
  ctx.strokeStyle = "rgba(60,44,26,.8)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-12, -26); ctx.lineTo(-7, -6);
  ctx.moveTo(0, -24); ctx.lineTo(0, -6);
  ctx.moveTo(12, -26); ctx.lineTo(7, -6);
  ctx.stroke();
  // balloon
  ctx.beginPath();
  ctx.ellipse(0, -38, 21, 15, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#c8452f";
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "#e8dcc8";
  for (let i = -2; i <= 2; i += 2) ctx.fillRect(i * 7 - 2.5, -56, 5, 40);
  ctx.fillStyle = "rgba(255,255,255,.28)"; // sheen
  ctx.beginPath();
  ctx.ellipse(-6, -44, 10, 5, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "rgba(90,40,26,.6)";
  ctx.stroke();
  // gondola
  ctx.fillStyle = "#7a5a3a";
  ctx.strokeStyle = "#54402a";
  ctx.beginPath();
  const gw = 11;
  ctx.moveTo(-gw, -7); ctx.lineTo(gw, -7); ctx.lineTo(gw - 3, 3); ctx.lineTo(-gw + 3, 3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "rgba(40,28,16,.5)";
  ctx.beginPath();
  ctx.moveTo(-gw + 1, -3.5); ctx.lineTo(gw - 1, -3.5);
  ctx.stroke();
  // propeller
  ctx.save();
  ctx.translate(-gw - 2, -2);
  ctx.rotate(tMs * 0.045);
  ctx.strokeStyle = "rgba(230,230,225,.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, -6); ctx.lineTo(0, 6);
  ctx.stroke();
  ctx.restore();
  // pennant
  ctx.strokeStyle = "#54402a";
  ctx.beginPath();
  ctx.moveTo(0, -53); ctx.lineTo(0, -60);
  ctx.stroke();
  ctx.fillStyle = "#e8c95c";
  ctx.beginPath();
  ctx.moveTo(0, -60); ctx.lineTo(9, -57.5); ctx.lineTo(0, -55);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ---------- main loop ---------- */

function skyFrame(tMs) {
  requestAnimationFrame(skyFrame);
  const dt = Math.min(0.05, (tMs - lastT) / 1000 || 0.016);
  lastT = tMs;
  const tSec = tMs / 1000;
  if (!world) return;

  updateShip(dt);
  updateMissiles(dt, tSec);
  fireAcc += dt;
  if (fireAcc > 0.32) { fireAcc = 0; fireTick(tSec); }

  // re-render one damaged island per frame
  if (dirtyIslands.size) {
    const id = dirtyIslands.values().next().value;
    dirtyIslands.delete(id);
    renderIsland(world, world.islands[id]);
  }

  // camera follows the ship, looking slightly below it
  shake *= Math.exp(-6 * dt);
  shakeX = (Math.random() - 0.5) * shake;
  shakeY = (Math.random() - 0.5) * shake;
  const cx = isoX(ship.x, ship.y);
  const cy = isoY(ship.x, ship.y, ship.z) + SVH * 0.22;
  cam.x += (cx - cam.x) * Math.min(1, 4 * dt);
  cam.y += (cy - cam.y) * Math.min(1, 4 * dt);

  const ctx = skyCtx;
  ctx.setTransform(SDPR, 0, 0, SDPR, 0, 0);
  ctx.imageSmoothingEnabled = false;

  drawSkyBackdrop(ctx, SVW, SVH);

  // low clouds drift beneath the islands
  for (const cl of clouds) {
    cl.x += cl.v * dt;
    cl.y -= cl.v * dt * 0.6;
    if (cl.x > world.W + 14) cl.x = -14;
    if (cl.y < -14) cl.y = world.D + 14;
    if (cl.z > 30) continue;
    const w = cl.spr.width * cl.sc, h = cl.spr.height * cl.sc;
    ctx.globalAlpha = 0.95;
    ctx.drawImage(cl.spr, Math.round(toScreenX(cl.x, cl.y) - w / 2), Math.round(toScreenY(cl.x, cl.y, cl.z) - h / 2), w, h);
    ctx.globalAlpha = 1;
  }

  // island soft shadows on the haze below
  for (const isl of world.islands) {
    if (!isl.canvas) continue;
    const sx = toScreenX(isl.cx, isl.cy);
    const sy = toScreenY(isl.cx, isl.cy, 2);
    const rx = isl.canvas.width * 0.32;
    ctx.fillStyle = "rgba(25,40,65,.14)";
    ctx.beginPath();
    ctx.ellipse(sx, sy, rx, rx * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // islands (prerendered, bobbing)
  for (const isl of world.islands) {
    if (!isl.canvas) continue;
    ctx.drawImage(
      isl.canvas,
      Math.round(isl.ox - cam.x + SVW / 2 + shakeX),
      Math.round(isl.oy - cam.y + SVH / 2 + shakeY + bobOf(isl, tSec))
    );
  }

  // waterfalls
  for (const wf of world.waterfalls) {
    if (world.blocks[skyIdx(wf.x, wf.y, wf.z)] !== SM.WATER) continue;
    const id = world.islandOf[skyCol(wf.x, wf.y)];
    const bob = id >= 0 ? bobOf(world.islands[id], tSec) : 0;
    if (Math.random() < dt * 50) {
      spawn({
        type: "water",
        x: toScreenX(wf.x, wf.y) + (wf.dx - wf.dy) * ISO_HW * 0.6 + (Math.random() - 0.5) * 3,
        y: toScreenY(wf.x, wf.y, wf.z) + bob + (wf.dx + wf.dy) * ISO_HH * 0.6 + ISO_HH,
        vx: (wf.dx - wf.dy) * 6, vy: 12, g: 150,
        age: 0, life: 0.75 + Math.random() * 0.3,
      });
    }
  }

  // ship shadow on the terrain below
  {
    const bx = Math.round(ship.x), by = Math.round(ship.y);
    if (bx >= 0 && by >= 0 && bx < world.W && by < world.D) {
      const c = skyCol(bx, by);
      if (world.topZ[c] >= 0) {
        const id = world.islandOf[c];
        const bob = id >= 0 ? bobOf(world.islands[id], tSec) : 0;
        const drop = ship.z - world.topZ[c];
        ctx.fillStyle = `rgba(10,16,28,${Math.max(0.06, 0.3 - drop * 0.005)})`;
        ctx.beginPath();
        ctx.ellipse(
          toScreenX(ship.x, ship.y),
          toScreenY(ship.x, ship.y, world.topZ[c] + 1) + bob + ISO_HH,
          10 + drop * 0.12, (10 + drop * 0.12) * 0.5, 0, 0, Math.PI * 2
        );
        ctx.fill();
      }
    }
  }

  // fire glow + flame emission on burning blocks
  const now = performance.now();
  for (const [, b] of burning) {
    if (now < b.ig) continue;
    const id = world.islandOf[skyCol(b.x, b.y)];
    const bob = id >= 0 ? bobOf(world.islands[id], tSec) : 0;
    const sx = toScreenX(b.x, b.y), sy = toScreenY(b.x, b.y, b.z) + bob;
    ctx.globalCompositeOperation = "lighter";
    const fl = 0.22 + 0.14 * Math.sin(tMs * 0.013 + b.x * 3.1 + b.y * 1.7);
    const gr = ctx.createRadialGradient(sx, sy, 1, sx, sy, 13);
    gr.addColorStop(0, `rgba(255,160,60,${fl})`);
    gr.addColorStop(1, "rgba(255,80,20,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(sx - 13, sy - 13, 26, 26);
    ctx.globalCompositeOperation = "source-over";
    if (Math.random() < dt * 7) {
      spawn({
        type: "flame", x: sx + (Math.random() - 0.5) * 8, y: sy - 2,
        vx: (Math.random() - 0.5) * 6, vy: -18 - Math.random() * 14, g: -8,
        age: 0, life: 0.4 + Math.random() * 0.3, r: 3 + Math.random() * 2.5,
      });
    }
    if (Math.random() < dt * 2.4) {
      spawn({
        type: "smoke", x: sx, y: sy - 8, vx: (Math.random() - 0.5) * 8, vy: -16, g: -8,
        age: 0, life: 1.4 + Math.random(), r: 2.5 + Math.random() * 2.5, dark: true,
      });
    }
  }

  updateAndDrawParticles(ctx, dt);
  drawMissiles(ctx);
  drawShip(ctx, tMs);

  // high wispy clouds in front
  for (const cl of clouds) {
    if (cl.z <= 30) continue;
    const w = cl.spr.width * cl.sc, h = cl.spr.height * cl.sc;
    ctx.globalAlpha = 0.35;
    ctx.drawImage(cl.spr, Math.round(toScreenX(cl.x, cl.y) - w / 2), Math.round(toScreenY(cl.x, cl.y, cl.z) - h / 2), w, h);
    ctx.globalAlpha = 1;
  }

  // crosshair + target marker
  const pick = pickBlock(mouse.x, mouse.y, tSec);
  if (pick) {
    const bob = bobOf(pick.isl, tSec);
    const mx = toScreenX(pick.x, pick.y), my = toScreenY(pick.x, pick.y, pick.z) + bob;
    const pulse = 1 + 0.15 * Math.sin(tMs * 0.008);
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx, my - 0.5 * pulse);
    ctx.lineTo(mx + ISO_HW * pulse, my + ISO_HH * pulse);
    ctx.lineTo(mx, my + 2 * ISO_HH * pulse + 0.5);
    ctx.lineTo(mx - ISO_HW * pulse, my + ISO_HH * pulse);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,255,255,.8)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(mouse.x, mouse.y, 7, 0, Math.PI * 2);
  ctx.moveTo(mouse.x - 11, mouse.y); ctx.lineTo(mouse.x - 4, mouse.y);
  ctx.moveTo(mouse.x + 4, mouse.y); ctx.lineTo(mouse.x + 11, mouse.y);
  ctx.moveTo(mouse.x, mouse.y - 11); ctx.lineTo(mouse.x, mouse.y - 4);
  ctx.moveTo(mouse.x, mouse.y + 4); ctx.lineTo(mouse.x, mouse.y + 11);
  ctx.stroke();
}

/* ---------- input ---------- */

window.addEventListener("keydown", (e) => {
  if (document.activeElement === seedInput) {
    if (e.code === "Enter") { seedInput.blur(); newWorld(seedInput.value.trim() || randomSkySeed()); }
    return;
  }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === "KeyR") newWorld(randomSkySeed());
  if (e.code === "KeyM") muted = !muted;
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

skyCanvas.addEventListener("pointermove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
skyCanvas.addEventListener("pointerdown", (e) => {
  seedInput.blur();
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  fireMissile(lastT / 1000);
});

document.getElementById("sky-new").addEventListener("click", () => newWorld(randomSkySeed()));

/* ---------- boot ---------- */

buildSkySprites();
buildCloudSprites();
newWorld("zephyr");
requestAnimationFrame(skyFrame);
