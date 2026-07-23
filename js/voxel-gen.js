import * as THREE from "three";
import { buildBlockMaterials, disposeBlockMaterials, buildZombieMaterials, disposeZombieMaterials } from "./voxel-textures.js";
import { playExplosion, playZombieKill } from "./voxel-audio.js";

/* ---------- Biome presets ---------- */

const BIOMES = {
  plains: {
    scale: 1.6, octaves: 4, heightMul: 6, baseHeight: 5,
    seaLevel: -1, treeDensity: 0.02,
    top: 0x6cbf4f, sub: 0x8a5a34, rock: 0x8a8a8a,
    sand: 0xdccb7a, snowLine: 999, snow: 0xffffff,
    water: 0x3a7bd5, sky: [0x9fd6ff, 0xd8f0ff],
  },
  desert: {
    scale: 2.0, octaves: 4, heightMul: 4, baseHeight: 4,
    seaLevel: -3, treeDensity: 0.0,
    top: 0xe3c877, sub: 0xcaa85c, rock: 0x9c8452,
    sand: 0xe3c877, snowLine: 999, snow: 0xffffff,
    water: 0x2f7fb0, sky: [0xffd9a0, 0xfff2d8],
  },
  snowy: {
    scale: 1.8, octaves: 4, heightMul: 7, baseHeight: 6,
    seaLevel: -1, treeDensity: 0.012,
    top: 0xf4f8fb, sub: 0x8a5a34, rock: 0x8f97a0,
    sand: 0xe7edf2, snowLine: 2, snow: 0xffffff,
    water: 0x3f6f9c, sky: [0xbcd7e8, 0xeaf4fb],
  },
  islands: {
    scale: 1.5, octaves: 5, heightMul: 8, baseHeight: 2,
    seaLevel: 1, treeDensity: 0.03,
    top: 0x5fc25a, sub: 0x8a6a34, rock: 0x7f7f7f,
    sand: 0xe8d692, snowLine: 999, snow: 0xffffff,
    water: 0x2489c9, sky: [0x7fd6ff, 0xd0f4ff],
  },
  mountains: {
    scale: 1.6, octaves: 5, heightMul: 20, baseHeight: 5,
    seaLevel: -2, treeDensity: 0.015,
    top: 0x5c9a4b, sub: 0x7a5a3a, rock: 0x767b80,
    sand: 0xd4c483, snowLine: 9, snow: 0xffffff,
    water: 0x2f6fa8, sky: [0x8fb8e0, 0xdcecfb],
  },
  swamp: {
    scale: 3.4, octaves: 3, heightMul: 4, baseHeight: 3,
    seaLevel: 0, treeDensity: 0.025,
    top: 0x5a7a3f, sub: 0x4a3c28, rock: 0x6f6f60,
    sand: 0xa9a06a, snowLine: 999, snow: 0xffffff,
    water: 0x4a6b4a, sky: [0xaebfa0, 0xd8e2c8],
  },
};

const GRID = 44;
// Rendered layers below the surface. Digging has no floor — craters carve
// indefinitely deeper instead of healing — so this is the constant buffer of
// diggable rock always visible below whatever the deepest point currently is.
// Spare buffer of solid rock kept below the single deepest dug point on the
// whole map (not per-column) — see rebuildBlockMeshes.
const DEPTH_SPARE = 5;

// GUIDING PRINCIPLE — no artificial limits. This game is more fun for humans
// when systems are left uncapped, even when a limit seems "reasonable" or
// prudent. The zombie population is the canonical example: every kill spawns
// 2 new zombies (see killMonstersNear) with NO cap on monsters.length, ever.
// MONSTER_COUNT below is only the *initial* spawn count at world-gen time —
// it is not a ceiling. Do not add a cap here (or a general population cap
// anywhere else in this file) without explicit user direction; if a limit
// starts to feel necessary for performance, raise it with the user rather
// than silently capping. Zombies do consolidate via mergeZombies() when two
// same-level stacks touch — that reduces the on-screen entity count as a
// gameplay mechanic, but it is not a spawn limit and must not become one.
const MONSTER_COUNT = 9;
const MERGE_DIST = 0.85;
const STARTING_MAX_BLAST = 3;
// Cumulative XP needed to unlock each bigger blast radius, up through 8.
const BLAST_UNLOCK_XP = { 4: 40, 5: 100, 6: 200, 7: 350, 8: 550 };
// No hard ceiling — past 8 the cost keeps escalating indefinitely.
function blastUnlockCost(r) {
  if (r <= 8) return BLAST_UNLOCK_XP[r];
  const extra = r - 8;
  return 550 + extra * (300 + (extra - 1) * 150);
}

let renderer, scene, camera, root;
let blockMeshes, blockGeo, water, activeMaterials;
let dragging = false, panDragging = false, lastX = 0, lastY = 0;
let clickStartX = null, clickStartY = null, clickStartT = 0;
let theta = Math.PI / 4, phi = 0.95, dist = 46, zoomLevel = 1;
let target = new THREE.Vector3(GRID / 2, 0, GRID / 2);
const keys = {};

let monsterGroup, monsterUiGroup, glowTex, monsters = [];
let treeGroup, treeList = [];
let currentHeights = null, originalHeights = null, currentSeaLevel = -99, currentBiome = null, scorched = null;
let damageAccum = null; // hit-points chipped into whatever block currently tops each column
let currentSeed = "terra", monsterIdCounter = 0;
let lastTime = 0;
let panHoldTime = 0;
let maxUnlockedBlast = STARTING_MAX_BLAST;
let shake = 0;
let killCount = 0, xp = 0;
let lastBlastX = 0, lastBlastZ = 0;

let raycaster, missiles = [], fx = [];
let missileGeo, missileMat;
let highlightGeo, highlightOuterMat, highlightCoreMat, hoverClientX = null, hoverClientY = null;

function heightAt(x, z) {
  const xi = Math.max(0, Math.min(GRID - 1, Math.round(x)));
  const zi = Math.max(0, Math.min(GRID - 1, Math.round(z)));
  return currentHeights ? currentHeights[zi * GRID + xi] : 0;
}

// Vertical-movement state for a zombie: instead of snapping to the new block
// height the instant it crosses a column boundary, it hops there smoothly.
function initVerticalState(x, z) {
  const y = heightAt(x, z) + 0.5;
  return { groundTarget: y, visualY: y, hopFrom: y, hopTo: y, hopT: 1 };
}

/* ---------- zombies ---------- */

// Articulated voxel zombie: torso + head + pivoted arms/legs so they can
// swing in a walk cycle, built from procedurally-painted pixel textures.
function createZombieMesh(mats) {
  const grp = new THREE.Group();

  const torsoGeo = new THREE.BoxGeometry(0.5, 0.65, 0.28);
  const headGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
  const armGeo = new THREE.BoxGeometry(0.16, 0.55, 0.16);
  const legGeo = new THREE.BoxGeometry(0.18, 0.6, 0.18);

  const hipY = 0.6, shoulderY = hipY + 0.65, headY = shoulderY + 0.21;

  const torso = new THREE.Mesh(torsoGeo, mats.clothes);
  torso.position.set(0, hipY + 0.325, 0);
  grp.add(torso);

  // head faces +z; front face gets the eyes/mouth texture, rest get skin
  const headMats = [mats.skin, mats.skin, mats.skin, mats.skin, mats.face, mats.skin];
  const head = new THREE.Mesh(headGeo, headMats);
  head.position.set(0, headY, 0);
  grp.add(head);

  function makeLimb(geo, mat, side, pivotY, length) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.17 * (geo === armGeo ? 1.9 : 0.8), pivotY, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, -length / 2, 0);
    pivot.add(mesh);
    grp.add(pivot);
    return pivot;
  }

  const armL = makeLimb(armGeo, mats.skin, -1, shoulderY, 0.55);
  const armR = makeLimb(armGeo, mats.skin, 1, shoulderY, 0.55);
  const legL = makeLimb(legGeo, mats.clothes, -1, hipY, 0.6);
  const legR = makeLimb(legGeo, mats.clothes, 1, hipY, 0.6);

  armL.rotation.x = armR.rotation.x = -1.15; // zombie arms-forward idle pose

  return { root: grp, armL, armR, legL, legR };
}

function spawnMonsters(biome, heights, seed) {
  if (monsterGroup) {
    for (const m of monsters) disposeZombieMaterials(m.mats);
    clearGroup(monsterGroup);
    clearGroup(monsterUiGroup);
  }
  monsters = [];
  currentHeights = heights;
  currentSeaLevel = biome.seaLevel;
  currentSeed = seed;
  monsterIdCounter = 0;
  const rand = mulberry32(hashSeed(seed + ":monsters"));
  for (let i = 0; i < MONSTER_COUNT; i++) {
    let x, z, h;
    for (let tries = 0; tries < 30; tries++) {
      x = 3 + rand() * (GRID - 6);
      z = 3 + rand() * (GRID - 6);
      h = heightAt(x, z);
      if (h > biome.seaLevel && h < biome.snowLine) break;
    }
    const mats = buildZombieMaterials(seed, monsterIdCounter++);
    const rig = createZombieMesh(mats);
    monsterGroup.add(rig.root);
    monsters.push({
      rig, mats, x, z,
      angle: rand() * Math.PI * 2,
      speed: 1.0 + rand() * 1.0,
      timer: rand() * 2,
      phase: rand() * Math.PI * 2,
      walkPhase: rand() * Math.PI * 2,
      hp: 1, stackLevel: 1,
      ...initVerticalState(x, z),
      ...createMonsterUi(1),
    });
  }
  killCount = 0;
  xp = 0;
  maxUnlockedBlast = STARTING_MAX_BLAST;
  updateScoreHud();
  updateZombieBoard();
}

// Spawns one fresh zombie at a random valid spot — used to replace a killed one.
function spawnRandomZombie() {
  const biome = currentBiome;
  let x = GRID / 2, z = GRID / 2, h;
  for (let tries = 0; tries < 30; tries++) {
    x = 3 + Math.random() * (GRID - 6);
    z = 3 + Math.random() * (GRID - 6);
    h = heightAt(x, z);
    if (h > biome.seaLevel && h < biome.snowLine) break;
  }
  const mats = buildZombieMaterials(currentSeed, monsterIdCounter++);
  const rig = createZombieMesh(mats);
  monsterGroup.add(rig.root);
  monsters.push({
    rig, mats, x, z,
    angle: Math.random() * Math.PI * 2,
    speed: 1.0 + Math.random() * 1.0,
    timer: Math.random() * 2,
    phase: Math.random() * Math.PI * 2,
    walkPhase: Math.random() * Math.PI * 2,
    hp: 1, stackLevel: 1,
    ...initVerticalState(x, z),
    ...createMonsterUi(1),
  });
  updateZombieBoard();
}

function stackScale(level) { return 1 + (level - 1) * 0.3; }
function stackSpeed(level) { return Math.min(4.5, 1.0 + (level - 1) * 0.18); }

const HP_BAR_W = 0.9, HP_BAR_H = 0.13;
const HP_BAR_INNER_W = 0.8, HP_BAR_INNER_H = 0.08;

// How far above a zombie's feet its health bar / aura should float, scaled
// to how tall that particular stack level actually renders.
function hpBarOffset(level) { return 1.95 * stackScale(level) + 0.35; }

// Aura color ramps from warm orange (just-merged) through magenta to a hot
// pink/red as the stack gets absurd — a quick "how dangerous is this" read.
function auraColor(level) {
  const t = Math.min(1, (level - 2) / 8);
  const hue = (30 - t * 90 + 360) % 360;
  return new THREE.Color().setHSL(hue / 360, 0.85, 0.55);
}

// Soft white radial-gradient texture, built once and shared (tinted per
// instance via SpriteMaterial.color) by every zombie's aura glow.
function buildGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Health bar (background + fill, both anchored left via Sprite.center so the
// fill drains correctly regardless of camera angle) plus a soft glow aura for
// stacked zombies. All added to monsterUiGroup so world-reset cleanup is free.
function createMonsterUi(level) {
  const bgMat = new THREE.SpriteMaterial({ color: 0x120a08, transparent: true, opacity: 0.75, depthTest: false });
  const fillMat = new THREE.SpriteMaterial({ color: 0x4fd68a, transparent: true, opacity: 0.95, depthTest: false });
  const healthBg = new THREE.Sprite(bgMat);
  const healthFill = new THREE.Sprite(fillMat);
  healthBg.center.set(0, 0.5);
  healthFill.center.set(0, 0.5);
  healthBg.scale.set(HP_BAR_W, HP_BAR_H, 1);
  healthBg.visible = healthFill.visible = false;
  healthBg.renderOrder = 997;
  healthFill.renderOrder = 998;
  monsterUiGroup.add(healthBg, healthFill);

  const auraMat = new THREE.SpriteMaterial({
    map: glowTex, color: auraColor(level), transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  });
  const aura = new THREE.Sprite(auraMat);
  aura.renderOrder = 996;
  aura.visible = level >= 2;
  monsterUiGroup.add(aura);

  return { healthBg, healthFill, aura };
}

// Removes one zombie's UI sprites — never disposes .geometry (Sprites share a
// module-level singleton) or the shared aura glow texture, only the
// per-instance materials.
function disposeMonsterUi(m) {
  monsterUiGroup.remove(m.healthBg, m.healthFill, m.aura);
  m.healthBg.material.dispose();
  m.healthFill.material.dispose();
  m.aura.material.dispose();
}

// Zombies of the SAME level that wander into each other fuse into one
// zombie one level higher (1+1→2, 2+2→3, 3+3→4, ...), with no ceiling —
// each level adds one required hit and visibly grows it further.
function mergeZombies(a, b) {
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  const level = a.stackLevel + 1;
  monsterGroup.remove(a.rig.root, b.rig.root);
  disposeZombieMaterials(a.mats);
  disposeZombieMaterials(b.mats);
  disposeMonsterUi(a);
  disposeMonsterUi(b);
  monsters.splice(monsters.indexOf(b), 1);
  monsters.splice(monsters.indexOf(a), 1);

  spawnMergeFx(mx, heightAt(mx, mz) + 1, mz);

  const mats = buildZombieMaterials(currentSeed, monsterIdCounter++);
  const rig = createZombieMesh(mats);
  rig.root.scale.setScalar(stackScale(level));
  monsterGroup.add(rig.root);
  monsters.push({
    rig, mats, x: mx, z: mz,
    angle: Math.random() * Math.PI * 2,
    speed: stackSpeed(level) + Math.random() * 0.2,
    timer: Math.random() * 2,
    phase: Math.random() * Math.PI * 2,
    walkPhase: Math.random() * Math.PI * 2,
    hp: level, stackLevel: level,
    ...initVerticalState(mx, mz),
    ...createMonsterUi(level),
  });
  updateZombieBoard();
}

function checkZombieMerges() {
  for (let i = 0; i < monsters.length; i++) {
    const a = monsters[i];
    for (let j = i + 1; j < monsters.length; j++) {
      const b = monsters[j];
      if (a.stackLevel !== b.stackLevel) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) < MERGE_DIST) {
        mergeZombies(a, b);
        return; // arrays mutated — resume scanning next frame
      }
    }
  }
}

function updateScoreHud() {
  const killEl = document.getElementById("vx-score-val");
  if (killEl) killEl.textContent = String(killCount);

  const radiusEl = document.getElementById("vx-radius-val");
  if (radiusEl) radiusEl.textContent = String(maxUnlockedBlast);

  const xpEl = document.getElementById("vx-xp-val");
  if (xpEl) xpEl.textContent = String(xp);

  const fillEl = document.getElementById("vx-xp-fill");
  const nextEl = document.getElementById("vx-xp-next");
  const nextCost = blastUnlockCost(maxUnlockedBlast + 1);
  const prevCost = maxUnlockedBlast > STARTING_MAX_BLAST ? blastUnlockCost(maxUnlockedBlast) : 0;
  const pct = Math.max(0, Math.min(1, (xp - prevCost) / (nextCost - prevCost)));
  if (fillEl) fillEl.style.width = `${Math.round(pct * 100)}%`;
  if (nextEl) nextEl.textContent = `${xp} / ${nextCost} XP → radius ${maxUnlockedBlast + 1}`;
}

// "Board" panel: how many zombies currently exist at each stack level.
function updateZombieBoard() {
  const el = document.getElementById("vx-board-list");
  if (!el) return;
  const counts = new Map();
  for (const m of monsters) counts.set(m.stackLevel, (counts.get(m.stackLevel) || 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  if (levels.length === 0) {
    el.innerHTML = `<div class="hud-board-empty">No zombies left</div>`;
    return;
  }
  el.innerHTML = levels
    .map((lv) => `<div class="hud-board-row"><span>Lvl ${lv}</span><span>${counts.get(lv)}</span></div>`)
    .join("");
}

// Bigger blast radii unlock permanently as you earn more XP, with no ceiling —
// called any time XP changes; announces each new unlock with an on-screen toast.
function checkBlastUnlocks() {
  let unlocked = false;
  while (xp >= blastUnlockCost(maxUnlockedBlast + 1)) {
    maxUnlockedBlast++;
    unlocked = true;
    showToast(`💥 Blast radius ${maxUnlockedBlast} unlocked!`);
  }
  updateScoreHud();
  if (unlocked) updateAimIndicator();
}

let toastTimer = null;
function showToast(text) {
  const el = document.getElementById("vx-toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function updateMonsters(dt, now) {
  for (const m of monsters) {
    m.timer -= dt;
    if (m.timer <= 0) {
      m.angle = Math.random() * Math.PI * 2;
      m.timer = 1.5 + Math.random() * 2.5;
    }
    const nx = m.x + Math.sin(m.angle) * m.speed * dt;
    const nz = m.z + Math.cos(m.angle) * m.speed * dt;
    const inBounds = nx > 2 && nx < GRID - 3 && nz > 2 && nz < GRID - 3;
    const h = inBounds ? heightAt(nx, nz) : 0;
    let moving = false;
    if (inBounds && h > currentSeaLevel && h < 99) {
      m.x = nx; m.z = nz;
      moving = true;
    } else {
      m.angle += Math.PI + (Math.random() - 0.5);
    }
    // Smooth step-height changes into a little hop instead of snapping —
    // climbing up is deliberately slower/floatier than settling back down.
    const groundTarget = heightAt(m.x, m.z) + 0.5;
    if (Math.abs(groundTarget - m.groundTarget) > 0.01) {
      m.hopFrom = m.visualY;
      m.hopTo = groundTarget;
      m.hopT = 0;
      m.groundTarget = groundTarget;
    }
    if (m.hopT < 1) {
      const climbing = m.hopTo > m.hopFrom;
      const hopDuration = climbing ? 0.55 : 0.25;
      m.hopT = Math.min(1, m.hopT + dt / hopDuration);
      const ease = 1 - (1 - m.hopT) * (1 - m.hopT); // ease-out
      const base = m.hopFrom + (m.hopTo - m.hopFrom) * ease;
      const arc = Math.sin(m.hopT * Math.PI) * (climbing ? 0.24 : 0.1);
      m.visualY = base + arc;
    } else {
      m.visualY = m.hopTo;
    }
    const idleBob = m.hopT >= 1 ? Math.sin(now * 2.2 + m.phase) * 0.04 : 0;
    m.rig.root.position.set(m.x, m.visualY + idleBob, m.z);
    m.rig.root.rotation.y = m.angle;

    if (moving) m.walkPhase += dt * m.speed * 3.2;
    const swing = Math.sin(m.walkPhase) * 0.5;
    m.rig.legL.rotation.x = swing;
    m.rig.legR.rotation.x = -swing;
    m.rig.armL.rotation.x = -1.15 - swing * 0.3;
    m.rig.armR.rotation.x = -1.15 + swing * 0.3;

    // Health bar — only shown once damaged, hidden again at full HP.
    const damaged = m.hp < m.stackLevel;
    m.healthBg.visible = m.healthFill.visible = damaged;
    if (damaged) {
      const barY = m.visualY + hpBarOffset(m.stackLevel);
      m.healthBg.position.set(m.x, barY, m.z);
      m.healthFill.position.set(m.x, barY, m.z);
      const ratio = Math.max(0, m.hp / m.stackLevel);
      m.healthFill.scale.set(HP_BAR_INNER_W * ratio, HP_BAR_INNER_H, 1);
      m.healthFill.material.color.setHex(ratio > 0.5 ? 0x4fd68a : ratio > 0.25 ? 0xffcf5a : 0xff5a4a);
    }

    // Aura — a gently pulsing glow for any zombie that has merged at least once.
    if (m.stackLevel >= 2) {
      const auraY = m.visualY + hpBarOffset(m.stackLevel) * 0.55;
      m.aura.position.set(m.x, auraY, m.z);
      const pulse = 0.85 + 0.15 * Math.sin(now * 2.6 + m.phase);
      m.aura.scale.setScalar(stackScale(m.stackLevel) * 1.8 * pulse);
      m.aura.material.opacity = 0.35 + 0.15 * Math.sin(now * 2.6 + m.phase);
    }
  }
}

function killMonstersNear(bx, bz, r) {
  const coreR = Math.floor(r / 2); // inner half of the radius — double damage
  let kills = 0, earned = 0;
  for (let i = monsters.length - 1; i >= 0; i--) {
    const m = monsters[i];
    const d = Math.hypot(m.x - bx, m.z - bz);
    if (d > r + 1) continue;
    m.hp -= d <= coreR ? 2 : 1;
    if (m.hp > 0) {
      spawnHitFlinch(m); // a tall stack survives a hit — knock it back and flash it
      continue;
    }
    monsterGroup.remove(m.rig.root);
    disposeZombieMaterials(m.mats);
    disposeMonsterUi(m);
    spawnGibs(m.x, heightAt(m.x, m.z) + 0.9, m.z);
    monsters.splice(i, 1);
    kills++;
    earned += m.stackLevel * 10;
  }
  if (kills > 0) {
    playZombieKill(kills);
    killCount += kills;
    xp += earned;
    updateScoreHud();
    checkBlastUnlocks();
    if (kills >= 2) spawnKillStreakPopup(bx, heightAt(bx, bz) + 2.6, bz, kills);
    // No cap, intentionally — see the "no artificial limits" note near
    // MONSTER_COUNT. Every kill spawns 2 more, unconditionally, forever.
    let toSpawn = kills * 2;
    while (toSpawn-- > 0) spawnRandomZombie();
  }
}

// A zombie that survived a hit (taller stacks need one hit per layer): knock
// it back from the blast and pop a couple of sparks so it still reads as impactful.
function spawnHitFlinch(m) {
  const dx = m.x - lastBlastX, dz = m.z - lastBlastZ;
  const d = Math.hypot(dx, dz) || 1;
  m.x += (dx / d) * 1.2;
  m.z += (dz / d) * 1.2;
  const pos = new THREE.Vector3(m.x, heightAt(m.x, m.z) + 1, m.z);
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 3;
    const geo = new THREE.BoxGeometry(0.07, 0.07, 0.07);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff5540, transparent: true, opacity: 1 });
    const s = new THREE.Mesh(geo, mat);
    s.position.copy(pos);
    root.add(s);
    fx.push({
      type: "spark", obj: s, age: 0, life: 0.25 + Math.random() * 0.15,
      vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 2 + Math.random() * 2,
    });
  }
}

function spawnMergeFx(x, y, z) {
  const ringGeo = new THREE.RingGeometry(0.2, 0.35, 24);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x9d5cff, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.set(x, y - 0.8, z);
  ring.rotation.x = -Math.PI / 2;
  root.add(ring);
  fx.push({ type: "ring", obj: ring, age: 0, life: 0.5, maxR: 2.2 });

  const flashGeo = new THREE.SphereGeometry(0.4, 10, 8);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xc99bff, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.position.set(x, y, z);
  root.add(flash);
  fx.push({ type: "fireball", obj: flash, age: 0, life: 0.35, maxR: 2.4 });
}

// A big floating "×N" combo callout for multi-kill blasts, drawn to a canvas
// texture and shown on a camera-facing sprite so it always reads clearly.
function spawnKillStreakPopup(x, y, z, count) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const label = `×${count}`;
  ctx.font = "900 92px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 12;
  ctx.strokeStyle = "rgba(10,5,0,0.9)";
  ctx.strokeText(label, 128, 66);
  const hue = count >= 6 ? "#ff3b3b" : count >= 4 ? "#ff9c3b" : "#ffd23b";
  ctx.fillStyle = hue;
  ctx.fillText(label, 128, 66);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const baseScale = 1.6 + Math.min(1.8, count * 0.15);
  sprite.scale.set(baseScale * 2, baseScale, 1);
  sprite.position.set(x, y, z);
  root.add(sprite);
  fx.push({ type: "killtext", obj: sprite, age: 0, life: 1.4, baseScale });
}

/* ---------- terrain generation ---------- */

function seededNoise(seedStr) {
  const rand = mulberry32(hashSeed(seedStr));
  return new SimplexNoise(rand);
}

function buildHeightmap(seed, biome) {
  const noise = seededNoise(seed);
  const h = new Int32Array(GRID * GRID);
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const nx = x / GRID - 0.5, nz = z / GRID - 0.5;
      const n = fbm(noise, nx * biome.scale * 4, nz * biome.scale * 4, biome.octaves, 0.5);
      const edge = 1 - Math.min(1, Math.hypot(nx, nz) * 1.7); // gentle island falloff
      const val = biome.baseHeight + n * biome.heightMul * (0.6 + 0.4 * edge);
      h[z * GRID + x] = Math.max(0, Math.round(val));
    }
  }
  return h;
}

// Depth-based rock strata, like real geology: soft dirt gives way to
// progressively tougher rock the deeper you dig. Depth is measured from the
// PRISTINE original surface (originalHeights), not the current dug-down
// height — so a block newly exposed at the bottom of a deep hole still shows
// (and resists like) whatever it truly is, not the grass/dirt cap that's long
// gone. Resistance is in hit-points; see applyDamage.
function stratumForDepth(depth) {
  if (depth <= 1) return { type: "sub", resistance: 1 };
  if (depth <= 4) return { type: "rock", resistance: 3 };
  if (depth <= 9) return { type: "deepstone", resistance: 6 };
  return { type: "bedrock", resistance: 10 };
}

function stratumAt(biome, y, originalHeight) {
  const depth = originalHeight - y;
  if (depth <= 0) {
    if (originalHeight <= biome.seaLevel + 1) return { type: "sand", resistance: 1 };
    if (originalHeight >= biome.snowLine) return { type: "snow", resistance: 1 };
    return { type: "grass", resistance: 1 };
  }
  return stratumForDepth(depth);
}

function clearGroup(group) {
  while (group.children.length) {
    const c = group.children.pop();
    // THREE.Sprite instances all share one module-level geometry singleton —
    // disposing it would break every other sprite in the app, so skip those.
    c.traverse((obj) => { if (!obj.isSprite) obj.geometry?.dispose?.(); });
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
      else c.material.dispose();
    }
  }
}

// Rebuilds the terrain InstancedMeshes from currentHeights/scorched. Called on
// world generation and again after every explosion edits the terrain.
//
// Every column fills all the way down to the SAME global floor — the single
// lowest point anywhere on the map, minus a spare buffer — not just some
// fixed depth below its own top. A per-column relative depth left visible
// gaps (rendered as blank sky through the terrain) between a tall column and
// a neighboring freshly-dug deep one, since their filled ranges never
// overlapped; a shared floor guarantees they always do.
function rebuildBlockMeshes() {
  const biome = currentBiome;
  const heights = currentHeights;
  const { materials, variantCounts } = activeMaterials;

  let minHeight = Infinity;
  for (let i = 0; i < heights.length; i++) if (heights[i] < minHeight) minHeight = heights[i];
  const globalBottom = minHeight - DEPTH_SPARE;

  const buckets = new Map();
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const idx = z * GRID + x;
      const height = heights[idx];
      const originalHeight = originalHeights[idx];
      const bottom = globalBottom; // same for every column — see comment above
      for (let y = height; y >= bottom; y--) {
        let type = stratumAt(biome, y, originalHeight).type;
        // Char is a surface scorch mark from the blast, not a permanent stain on
        // the column — once digging exposes real rock strata below the original
        // topsoil, show that rock/deepstone/bedrock instead of hiding it under black.
        if (y === height && scorched[idx] && originalHeight - y <= 1) type = "charred";
        const variant = Math.floor(cellHash(x + y * 97, z) * variantCounts[type]);
        const key = `${type}:${variant}`;
        let list = buckets.get(key);
        if (!list) { list = []; buckets.set(key, list); }
        list.push(x, y, z);
      }
    }
  }

  if (blockMeshes) { for (const m of blockMeshes) root.remove(m); }
  blockMeshes = [];
  const dummy = new THREE.Object3D();
  for (const [key, list] of buckets) {
    const [type, variantStr] = key.split(":");
    const variant = Number(variantStr);
    const mat = materials[type][variant];
    const n = list.length / 3;
    const mesh = new THREE.InstancedMesh(blockGeo, mat, n);
    for (let i = 0; i < n; i++) {
      dummy.position.set(list[i * 3], list[i * 3 + 1], list[i * 3 + 2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    root.add(mesh);
    blockMeshes.push(mesh);
  }
}

function generateWorld(seed, biomeKey) {
  const biome = BIOMES[biomeKey];
  currentBiome = biome;
  currentHeights = buildHeightmap(seed, biome);
  originalHeights = currentHeights.slice(); // pristine reference for depth/strata lookups — never mutated
  scorched = new Uint8Array(GRID * GRID);
  damageAccum = new Uint16Array(GRID * GRID);
  const rand = mulberry32(hashSeed(seed + ":trees"));

  if (activeMaterials) disposeBlockMaterials(activeMaterials.materials);
  activeMaterials = buildBlockMaterials(biome, seed);

  rebuildBlockMeshes();

  // trees
  clearGroup(treeGroup);
  treeList = [];
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x3f8f3a });
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2c });
  const leafGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  const trunkGeo = new THREE.BoxGeometry(0.35, 1, 0.35);
  for (let z = 1; z < GRID - 1; z++) {
    for (let x = 1; x < GRID - 1; x++) {
      const height = currentHeights[z * GRID + x];
      if (height <= biome.seaLevel + 1 || height >= biome.snowLine) continue;
      if (rand() > biome.treeDensity) continue;
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.set(x + 0.5, height + 1, z + 0.5);
      treeGroup.add(trunk);
      const leaf = new THREE.Mesh(leafGeo, leafMat);
      leaf.position.set(x + 0.5, height + 1.7, z + 0.5);
      treeGroup.add(leaf);
      treeList.push({ x: x + 0.5, z: z + 0.5, trunk, leaf });
    }
  }

  // water
  if (water) root.remove(water);
  if (biome.seaLevel >= 0) {
    const waterGeo = new THREE.PlaneGeometry(GRID, GRID);
    const waterMat = new THREE.MeshLambertMaterial({ color: biome.water, transparent: true, opacity: 0.75 });
    water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(GRID / 2, biome.seaLevel + 0.55, GRID / 2);
    root.add(water);
  } else {
    water = null;
  }

  scene.background = new THREE.Color(biome.sky[1]);
  // No fog: with bottomless digging, deep crater walls can sit well past any
  // reasonable fog distance and would fade to sky-white "mist" instead of
  // staying visible — everything should render solid at all times.
  scene.fog = null;

  // clear any missiles/fx left over from the previous world
  for (const m of missiles) root.remove(m.mesh);
  missiles = [];
  for (const p of fx) {
    root.remove(p.obj);
    if (!p.obj.isSprite) p.obj.geometry?.dispose?.();
    p.obj.material?.map?.dispose?.();
    p.obj.material?.dispose?.();
  }
  fx = [];

  spawnMonsters(biome, currentHeights, seed);
}

/* ---------- missiles & explosions ---------- */

function raycastGround(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(blockMeshes, false);
  return hits.length ? hits[0].point : null;
}

// Every click is captured into this queue immediately, even if it can't be
// resolved to a ground point right away — no cooldown, and no click is ever
// silently dropped. Drained every frame in the render loop: a click that
// resolves fires instantly (usually the very next frame), and one that
// still hasn't resolved after a few attempts (e.g. it was aimed at open
// sky, not terrain) is discarded rather than retried forever.
let clickQueue = [];
const CLICK_MAX_ATTEMPTS = 6;

function queueClick(clientX, clientY) {
  clickQueue.push({ clientX, clientY, attempts: 0 });
}

function processClickQueue() {
  if (clickQueue.length === 0) return;
  const remaining = [];
  for (const c of clickQueue) {
    const point = raycastGround(c.clientX, c.clientY);
    if (point) {
      fireMissile(point.x, point.y, point.z);
      continue;
    }
    c.attempts++;
    if (c.attempts < CLICK_MAX_ATTEMPTS) remaining.push(c);
  }
  clickQueue = remaining;
}

// Preview of where a missile would land: a thin translucent cap laid directly
// on top of every column that would actually take damage, so the true
// destruction footprint is visible block-by-block — not just an approximate
// glow. Brighter/redder over the double-damage core, dimmer orange outside
// it. Pooled meshes, reused/repositioned each hover update instead of
// recreated, since the affected-area size changes with the blast radius.
let highlightPool = [];

function ensureHighlightMesh(i) {
  while (highlightPool.length <= i) {
    const m = new THREE.Mesh(highlightGeo, highlightOuterMat);
    m.visible = false;
    m.renderOrder = 5;
    root.add(m);
    highlightPool.push(m);
  }
  return highlightPool[i];
}

function hideAllHighlights() {
  for (const m of highlightPool) m.visible = false;
}

function updateAimIndicator() {
  if (hoverClientX === null || !blockMeshes) { hideAllHighlights(); return; }
  const point = raycastGround(hoverClientX, hoverClientY);
  if (!point) { hideAllHighlights(); return; }

  const cx = Math.round(point.x), cz = Math.round(point.z);
  const R = maxUnlockedBlast;
  const coreR = Math.floor(R / 2);
  const span = Math.ceil(R);
  let count = 0;
  for (let dz = -span; dz <= span; dz++) {
    for (let dx = -span; dx <= span; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= GRID || z >= GRID) continue;
      const d = Math.hypot(dx, dz);
      if (d > R) continue;
      const mesh = ensureHighlightMesh(count++);
      mesh.position.set(x, heightAt(x, z) + 0.53, z);
      mesh.material = d <= coreR ? highlightCoreMat : highlightOuterMat;
      mesh.visible = true;
    }
  }
  for (let i = count; i < highlightPool.length; i++) highlightPool[i].visible = false;
}

function fireMissile(tx, ty, tz) {
  const ox = (Math.random() - 0.5) * 12;
  const oz = (Math.random() - 0.5) * 12;
  const start = new THREE.Vector3(tx + ox, ty + 26 + Math.random() * 6, tz + oz);
  const end = new THREE.Vector3(tx, ty + 0.6, tz);
  const mesh = new THREE.Mesh(missileGeo, missileMat);
  mesh.position.copy(start);
  root.add(mesh);
  missiles.push({ mesh, start, end, t: 0, duration: 0.75 + Math.random() * 0.2, trailTimer: 0 });
}

function bezierPoint(p0, p1, p2, t, out) {
  out.copy(p0).lerp(p1, t);
  const b = p1.clone().lerp(p2, t);
  return out.lerp(b, t);
}

const _tmpA = new THREE.Vector3(), _tmpB = new THREE.Vector3();

function updateMissiles(dt) {
  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i];
    m.t += dt / m.duration;
    if (m.t >= 1) {
      root.remove(m.mesh);
      explodeAt(m.end.x, m.end.z);
      missiles.splice(i, 1);
      continue;
    }
    const eased = m.t * m.t; // accelerating fall
    const ctrl = new THREE.Vector3(
      (m.start.x + m.end.x) / 2,
      Math.max(m.start.y, m.end.y) + 5,
      (m.start.z + m.end.z) / 2
    );
    const p = bezierPoint(m.start, ctrl, m.end, eased, _tmpA);
    const prevP = bezierPoint(m.start, ctrl, m.end, Math.max(0, eased - 0.02), _tmpB);
    m.mesh.position.copy(p);
    const dir = p.clone().sub(prevP);
    if (dir.lengthSq() > 1e-6) m.mesh.lookAt(p.clone().add(dir));

    m.trailTimer -= dt;
    if (m.trailTimer <= 0) {
      m.trailTimer = 0.035;
      spawnTrailPuff(p);
    }
  }
}

function spawnTrailPuff(pos) {
  const geo = new THREE.SphereGeometry(0.16, 6, 5);
  const mat = new THREE.MeshBasicMaterial({ color: 0xdadada, transparent: true, opacity: 0.5 });
  const s = new THREE.Mesh(geo, mat);
  s.position.copy(pos);
  root.add(s);
  fx.push({ type: "trail", obj: s, age: 0, life: 0.4 });
}

// Carves a crater into currentHeights and marks the char/scorch mask; does not
// touch the render meshes (caller rebuilds them once, after other edits).
// Deals damage to the block currently topping a column, carrying any
// leftover through to the next-deepest block if it breaks (so one very
// strong hit can punch through several soft layers, or a string of weaker
// hits gradually wears down one tough one — damage persists between shots).
function applyDamage(idx, dmg) {
  damageAccum[idx] += dmg;
  while (true) {
    const depth = originalHeights[idx] - currentHeights[idx];
    const resistance = depth <= 0 ? 1 : stratumForDepth(depth).resistance;
    if (damageAccum[idx] < resistance) break;
    damageAccum[idx] -= resistance;
    currentHeights[idx] -= 1; // no floor — always more (tougher) rock below
  }
}

function craterEdit(bx, bz) {
  const R = maxUnlockedBlast, R2 = R + 1.6;
  const coreR = Math.floor(R / 2); // inner half of the radius — double damage
  const cx = Math.round(bx), cz = Math.round(bz);
  const span = Math.ceil(R2);
  for (let dz = -span; dz <= span; dz++) {
    for (let dx = -span; dx <= span; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= GRID || z >= GRID) continue; // stay in array bounds only — edges are destructible too
      const d = Math.hypot(dx, dz);
      if (d > R2) continue;
      const idx = z * GRID + x;
      if (d <= R) {
        const base = Math.max(1, Math.round((R - d) * 0.85 + 1));
        const dmg = d <= coreR ? base * 2 : base;
        applyDamage(idx, dmg);
        scorched[idx] = 1;
      } else if (Math.random() < 0.55) {
        scorched[idx] = 1;
      }
    }
  }
}

function destroyTreesNear(bx, bz, r) {
  for (let i = treeList.length - 1; i >= 0; i--) {
    const t = treeList[i];
    if (Math.hypot(t.x - bx, t.z - bz) <= r + 1) {
      treeGroup.remove(t.trunk, t.leaf); // geometry/material shared across all trees; do not dispose
      treeList.splice(i, 1);
    }
  }
}

function spawnGibs(x, y, z) {
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 4;
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const mat = new THREE.MeshLambertMaterial({ color: 0x5a8a4a, transparent: true, opacity: 1 });
    const g = new THREE.Mesh(geo, mat);
    g.position.set(x, y, z);
    root.add(g);
    fx.push({
      type: "debris", obj: g, age: 0, life: 0.7 + Math.random() * 0.4,
      vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 3 + Math.random() * 3,
      rx: (Math.random() - 0.5) * 10, rz: (Math.random() - 0.5) * 10,
    });
  }
}

function explodeAt(bx, bz) {
  const groundYBefore = heightAt(bx, bz) + 0.5;
  lastBlastX = bx; lastBlastZ = bz;

  craterEdit(bx, bz);
  destroyTreesNear(bx, bz, maxUnlockedBlast);
  killMonstersNear(bx, bz, maxUnlockedBlast);
  rebuildBlockMeshes();

  shake = Math.min(4.5, shake + 0.25 + maxUnlockedBlast * 0.45);
  playExplosion(maxUnlockedBlast);

  const center = new THREE.Vector3(bx, groundYBefore, bz);

  const light = new THREE.PointLight(0xffb060, 10, maxUnlockedBlast * 6 + 8, 2);
  light.position.set(bx, groundYBefore + 2, bz);
  root.add(light);
  fx.push({ type: "light", obj: light, age: 0, life: 0.35, baseIntensity: 10 });

  const fireGeo = new THREE.SphereGeometry(1, 10, 8);
  const fireMat = new THREE.MeshBasicMaterial({
    color: 0xffcf6b, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const fireball = new THREE.Mesh(fireGeo, fireMat);
  fireball.position.copy(center);
  root.add(fireball);
  fx.push({ type: "fireball", obj: fireball, age: 0, life: 0.4, maxR: maxUnlockedBlast * 0.9 + 1.2 });

  const ringGeo = new THREE.RingGeometry(0.6, 1, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xfff2c8, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(bx, groundYBefore + 0.05, bz);
  root.add(ring);
  fx.push({ type: "ring", obj: ring, age: 0, life: 0.6, maxR: maxUnlockedBlast * 1.6 + 2 });

  for (let i = 0; i < 18; i++) {
    const a = Math.random() * Math.PI * 2, speed = 4 + Math.random() * 7;
    const geo = new THREE.BoxGeometry(0.08, 0.08, 0.08);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffdd88, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const s = new THREE.Mesh(geo, mat);
    s.position.copy(center);
    root.add(s);
    fx.push({
      type: "spark", obj: s, age: 0, life: 0.35 + Math.random() * 0.3,
      vx: Math.cos(a) * speed, vz: Math.sin(a) * speed, vy: 3 + Math.random() * 5,
    });
  }

  for (let i = 0; i < 10; i++) {
    const geo = new THREE.SphereGeometry(0.5, 8, 6);
    const mat = new THREE.MeshLambertMaterial({
      color: Math.random() < 0.5 ? 0x3a3630 : 0x6b6660, transparent: true, opacity: 0.55,
    });
    const s = new THREE.Mesh(geo, mat);
    s.position.set(
      center.x + (Math.random() - 0.5) * maxUnlockedBlast * 0.7,
      groundYBefore + 0.3,
      center.z + (Math.random() - 0.5) * maxUnlockedBlast * 0.7
    );
    root.add(s);
    fx.push({
      type: "smoke", obj: s, age: -Math.random() * 0.3, life: 1.6 + Math.random() * 1.2,
      vy: 0.7 + Math.random() * 0.8, growTo: 1.6 + Math.random() * 1.4,
    });
  }

  const debrisColor = currentBiome.rock;
  const debrisCount = Math.min(24, 8 + maxUnlockedBlast * 2);
  for (let i = 0; i < debrisCount; i++) {
    const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5;
    const size = 0.12 + Math.random() * 0.18;
    const geo = new THREE.BoxGeometry(size, size, size);
    const mat = new THREE.MeshLambertMaterial({ color: debrisColor, transparent: true, opacity: 1 });
    const d = new THREE.Mesh(geo, mat);
    d.position.copy(center);
    root.add(d);
    fx.push({
      type: "debris", obj: d, age: 0, life: 0.9 + Math.random() * 0.6,
      vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 3 + Math.random() * 4,
      rx: (Math.random() - 0.5) * 8, rz: (Math.random() - 0.5) * 8,
    });
  }

  // lingering embers so the crater keeps "burning" for a couple seconds
  for (let i = 0; i < 7; i++) {
    const geo = new THREE.ConeGeometry(0.14, 0.4, 6);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff8a3c, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const f = new THREE.Mesh(geo, mat);
    const ox = (Math.random() - 0.5) * maxUnlockedBlast * 1.1;
    const oz = (Math.random() - 0.5) * maxUnlockedBlast * 1.1;
    f.position.set(bx + ox, groundYBefore + 0.2, bz + oz);
    root.add(f);
    fx.push({
      type: "flame", obj: f, age: -Math.random() * 1.2, life: 1.6 + Math.random() * 1.4,
      baseY: groundYBefore + 0.2, phase: Math.random() * 10,
    });
  }
}

function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const p = fx[i];
    p.age += dt;
    if (p.age < 0) continue;
    const t = p.age / p.life;
    if (t >= 1) {
      root.remove(p.obj);
      // Sprites share one module-level geometry singleton — never dispose it.
      if (!p.obj.isSprite) p.obj.geometry?.dispose?.();
      p.obj.material?.map?.dispose?.();
      p.obj.material?.dispose?.();
      fx.splice(i, 1);
      continue;
    }
    switch (p.type) {
      case "light":
        p.obj.intensity = p.baseIntensity * (1 - t) * (1 - t);
        break;
      case "fireball": {
        const r = 0.4 + p.maxR * Math.min(1, t * 2.2);
        p.obj.scale.setScalar(r);
        p.obj.material.opacity = 0.9 * (1 - t);
        break;
      }
      case "ring": {
        const r = 0.6 + p.maxR * (1 - Math.pow(1 - t, 2));
        p.obj.scale.set(r, r, 1);
        p.obj.material.opacity = 0.8 * (1 - t);
        break;
      }
      case "spark": {
        p.vy -= 9 * dt;
        p.obj.position.x += p.vx * dt;
        p.obj.position.z += p.vz * dt;
        p.obj.position.y += p.vy * dt;
        p.obj.material.opacity = 1 - t;
        break;
      }
      case "smoke": {
        p.obj.position.y += p.vy * dt;
        p.obj.scale.setScalar(0.5 + (p.growTo - 0.5) * t);
        p.obj.material.opacity = 0.55 * (1 - t);
        break;
      }
      case "debris": {
        p.vy -= 9 * dt;
        p.obj.position.x += p.vx * dt;
        p.obj.position.z += p.vz * dt;
        p.obj.position.y += p.vy * dt;
        const floor = heightAt(p.obj.position.x, p.obj.position.z) + 0.2;
        if (p.obj.position.y < floor) { p.obj.position.y = floor; p.vy = 0; p.vx *= 0.8; p.vz *= 0.8; }
        p.obj.rotation.x += p.rx * dt;
        p.obj.rotation.z += p.rz * dt;
        p.obj.material.opacity = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
        break;
      }
      case "flame": {
        const flick = 0.75 + 0.25 * Math.sin((p.age + p.phase) * 14);
        p.obj.scale.set(flick, flick * 1.1, flick);
        p.obj.position.y = p.baseY + Math.sin((p.age + p.phase) * 6) * 0.05;
        p.obj.material.opacity = 0.9 * (1 - Math.max(0, (t - 0.7) / 0.3));
        break;
      }
      case "trail": {
        p.obj.material.opacity = 0.5 * (1 - t);
        p.obj.scale.setScalar(1 + t);
        break;
      }
      case "killtext": {
        p.obj.position.y += 1.3 * dt;
        const popIn = Math.min(1, p.age / 0.15);
        const s = p.baseScale * (0.4 + 0.6 * popIn);
        p.obj.scale.set(s * 2, s, 1);
        p.obj.material.opacity = t > 0.55 ? 1 - (t - 0.55) / 0.45 : 1;
        break;
      }
    }
  }
}

/* ---------- camera / render loop ---------- */

function updateCamera() {
  const x = target.x + dist * Math.sin(phi) * Math.cos(theta);
  const y = target.y + dist * Math.cos(phi);
  const z = target.z + dist * Math.sin(phi) * Math.sin(theta);
  const jx = (Math.random() - 0.5) * shake;
  const jy = (Math.random() - 0.5) * shake;
  const jz = (Math.random() - 0.5) * shake;
  camera.position.set(x + jx, y + jy, z + jz);
  camera.lookAt(target);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  const aspect = w / h;
  const viewSize = 26 / zoomLevel;
  camera.left = -viewSize * aspect;
  camera.right = viewSize * aspect;
  camera.top = viewSize;
  camera.bottom = -viewSize;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function init() {
  root = new THREE.Group();
  scene = new THREE.Scene();
  scene.add(root);
  treeGroup = new THREE.Group();
  root.add(treeGroup);
  monsterGroup = new THREE.Group();
  root.add(monsterGroup);
  monsterUiGroup = new THREE.Group();
  root.add(monsterUiGroup);
  glowTex = buildGlowTexture();

  blockGeo = new THREE.BoxGeometry(1, 1, 1);
  raycaster = new THREE.Raycaster();

  missileGeo = new THREE.ConeGeometry(0.14, 0.6, 8);
  missileGeo.rotateX(-Math.PI / 2); // tip points toward -Z so lookAt() aims it correctly
  missileMat = new THREE.MeshLambertMaterial({ color: 0x445055 });

  // Blast-radius preview: a thin translucent cap on every column that would
  // actually take damage (see updateAimIndicator) — pool geometry/materials
  // shared across every highlighted block.
  highlightGeo = new THREE.BoxGeometry(0.96, 0.05, 0.96);
  highlightOuterMat = new THREE.MeshBasicMaterial({
    color: 0xff9a3c, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false,
  });
  highlightCoreMat = new THREE.MeshBasicMaterial({
    color: 0xff2e1c, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false,
  });

  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  document.getElementById("voxel-root").appendChild(renderer.domElement);

  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(30, 60, 20);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbcd6ff, 0.45);
  fill.position.set(-25, 30, -30);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));

  onResize();
  window.addEventListener("resize", onResize);

  const canvas = renderer.domElement;
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    panDragging = e.metaKey || e.altKey; // Cmd/Option+drag pans instead of orbiting
    lastX = e.clientX; lastY = e.clientY;
    clickStartX = e.clientX; clickStartY = e.clientY; clickStartT = performance.now();
  });
  window.addEventListener("mouseup", (e) => {
    dragging = false;
    if (clickStartX === null) return;
    const moved = Math.hypot(e.clientX - clickStartX, e.clientY - clickStartY);
    const elapsed = performance.now() - clickStartT;
    if (moved < 6 && elapsed < 400) queueClick(e.clientX, e.clientY);
    clickStartX = null;
  });
  window.addEventListener("mousemove", (e) => {
    if (dragging) {
      const dxPix = e.clientX - lastX, dyPix = e.clientY - lastY;
      if (panDragging) {
        const scale = 0.045 / zoomLevel;
        const fwd = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
        const right = new THREE.Vector3(-Math.sin(theta), 0, Math.cos(theta));
        target.addScaledVector(right, -dxPix * scale);
        target.addScaledVector(fwd, -dyPix * scale);
        target.x = Math.max(2, Math.min(GRID - 2, target.x));
        target.z = Math.max(2, Math.min(GRID - 2, target.z));
      } else {
        theta -= dxPix * 0.006;
        phi = Math.min(1.45, Math.max(0.25, phi - dyPix * 0.006));
      }
      lastX = e.clientX; lastY = e.clientY;
    }
    hoverClientX = e.clientX; hoverClientY = e.clientY;
    updateAimIndicator();
  });
  canvas.addEventListener("mouseleave", () => {
    hoverClientX = null; hoverClientY = null;
    hideAllHighlights();
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomLevel = Math.min(4, Math.max(0.35, zoomLevel * factor));
    onResize();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    keys[e.key.toLowerCase()] = true;
    if (e.key.toLowerCase() === "r") regenerate(true);
  });
  window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });

  const seedInput = document.getElementById("vx-seed");
  const biomeSelect = document.getElementById("vx-biome");
  document.getElementById("vx-new").addEventListener("click", () => regenerate(true));
  seedInput.addEventListener("change", () => regenerate(false));
  biomeSelect.addEventListener("change", () => regenerate(false));

  regenerate(false);
  requestAnimationFrame(loop);
}

function regenerate(randomizeSeed) {
  const seedInput = document.getElementById("vx-seed");
  const biomeSelect = document.getElementById("vx-biome");
  if (randomizeSeed) seedInput.value = Math.random().toString(36).slice(2, 9);
  generateWorld(seedInput.value || "terra", biomeSelect.value);
  target.set(GRID / 2, 0, GRID / 2);
}

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now() / 1000;
  const dt = lastTime ? Math.min(0.05, now - lastTime) : 0;
  lastTime = now;

  const panning = keys["w"] || keys["arrowup"] || keys["s"] || keys["arrowdown"] ||
    keys["a"] || keys["arrowleft"] || keys["d"] || keys["arrowright"];
  panHoldTime = panning ? panHoldTime + dt : 0;
  const panRamp = Math.min(3.5, 1 + panHoldTime * 2.2); // accelerates the longer a key is held
  const panSpeed = (16 / zoomLevel) * dt * panRamp;
  const fwd = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
  const right = new THREE.Vector3(-Math.sin(theta), 0, Math.cos(theta));
  if (keys["w"] || keys["arrowup"]) target.addScaledVector(fwd, -panSpeed);
  if (keys["s"] || keys["arrowdown"]) target.addScaledVector(fwd, panSpeed);
  if (keys["a"] || keys["arrowleft"]) target.addScaledVector(right, panSpeed);
  if (keys["d"] || keys["arrowright"]) target.addScaledVector(right, -panSpeed);
  target.x = Math.max(2, Math.min(GRID - 2, target.x));
  target.z = Math.max(2, Math.min(GRID - 2, target.z));

  shake *= Math.exp(-4.5 * dt);
  processClickQueue();
  updateMonsters(dt, now);
  checkZombieMerges();
  updateMissiles(dt);
  updateFx(dt);
  updateCamera();
  renderer.render(scene, camera);
}

init();
