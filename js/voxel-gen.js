import * as THREE from "three";
import { buildBlockMaterials, disposeBlockMaterials, buildZombieMaterials, disposeZombieMaterials } from "./voxel-textures.js";
import {
  playExplosion, playZombieKill, playHeartHit, playWaveStart,
  playGameOver, playPurchase, playTurretShot, setMasterVolume,
} from "./voxel-audio.js";

/* ---------- Biome presets ---------- */

// Rock colors deliberately avoid true gray — a bare, low-saturation gray is
// exactly what reads as flat/bland "gray blocks" once tinted by ambient light
// and viewed from a few meters out. Every biome's shallow rock instead leans
// warm or cool toward its theme (see paintRock in voxel-textures.js for the
// pebble/mica detail layered on top of these).
const BIOMES = {
  plains: {
    scale: 1.6, octaves: 4, heightMul: 6, baseHeight: 5,
    seaLevel: -1, treeDensity: 0.02,
    top: 0x6cbf4f, sub: 0x8a5a34, rock: 0x8c7d64,
    sand: 0xdccb7a, snowLine: 999, snow: 0xffffff,
    water: 0x3a7bd5, sky: [0x9fd6ff, 0xd8f0ff],
  },
  desert: {
    scale: 2.0, octaves: 4, heightMul: 4, baseHeight: 4,
    seaLevel: -3, treeDensity: 0.0,
    top: 0xe3c877, sub: 0xcaa85c, rock: 0xa8875a,
    sand: 0xe3c877, snowLine: 999, snow: 0xffffff,
    water: 0x2f7fb0, sky: [0xffd9a0, 0xfff2d8],
  },
  snowy: {
    scale: 1.8, octaves: 4, heightMul: 7, baseHeight: 6,
    seaLevel: -1, treeDensity: 0.012,
    top: 0xf4f8fb, sub: 0x8a5a34, rock: 0x8497a8,
    sand: 0xe7edf2, snowLine: 2, snow: 0xffffff,
    water: 0x3f6f9c, sky: [0xbcd7e8, 0xeaf4fb],
  },
  islands: {
    scale: 1.5, octaves: 5, heightMul: 8, baseHeight: 2,
    seaLevel: 1, treeDensity: 0.03,
    top: 0x5fc25a, sub: 0x8a6a34, rock: 0x8a7361,
    sand: 0xe8d692, snowLine: 999, snow: 0xffffff,
    water: 0x2489c9, sky: [0x7fd6ff, 0xd0f4ff],
  },
  mountains: {
    scale: 1.6, octaves: 5, heightMul: 20, baseHeight: 5,
    seaLevel: -2, treeDensity: 0.015,
    top: 0x5c9a4b, sub: 0x7a5a3a, rock: 0x6d7a8c,
    sand: 0xd4c483, snowLine: 9, snow: 0xffffff,
    water: 0x2f6fa8, sky: [0x8fb8e0, 0xdcecfb],
  },
  swamp: {
    scale: 3.4, octaves: 3, heightMul: 4, baseHeight: 3,
    seaLevel: 0, treeDensity: 0.025,
    top: 0x5a7a3f, sub: 0x4a3c28, rock: 0x64684a,
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
// prudent. There is NO cap on monsters.length, ever. MONSTER_COUNT below is
// only the *initial* spawn count at world-gen time — it is not a ceiling. Do
// not add a cap here (or a general population cap anywhere else in this
// file) without explicit user direction; if a limit starts to feel necessary
// for performance, raise it with the user rather than silently capping.
// Population flows are all user-tweakable sliders (⚙️ Tweaks panel):
// spawnsPerKill fresh zombies per player blast kill (default 2), and
// spawnsPerEat per zombie eaten by another zombie via resolveZombieKill()
// (default 1 = eats are population-neutral; 0 = the strong thin the herd).
// User-chosen slider values are settings, not artificial limits.
const MONSTER_COUNT = 9;
const EAT_DIST = 0.85; // how close two zombies must be to fight (see updateZombieCombat)
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
let currentHeights = null, originalHeights = null, currentSeaLevel = -99, currentBiome = null;
let tintNoise = null; // smooth per-world noise field driving terrainTint below
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

/* ---------- The Heart: the thing you're defending ---------- */
// The game's objective. Zombies gravitate toward it and shoot it with the
// same projectiles they use on each other; when its HP reaches 0 the run
// ends. `stackLevel: 1` makes it a valid projectile target with zero armor
// (defenseFor(1) === 0) — every zombie can always hurt the Heart.
/* ---------- Legacy: permanent cross-run progression ---------- */
// Shards are earned every run (scaled by score) and spent on permanent
// perks from the game-over screen. This is the "one more run" hook: every
// defeat still banks progress toward stronger future runs.
let legacy = { shards: 0, heartRank: 0, energyRank: 0, blastRank: 0 };
function loadLegacy() {
  try {
    const saved = JSON.parse(localStorage.getItem("vx-legacy") || "{}");
    for (const k of Object.keys(legacy)) if (typeof saved[k] === "number") legacy[k] = saved[k];
  } catch { /* fresh legacy */ }
}
function saveLegacy() {
  try { localStorage.setItem("vx-legacy", JSON.stringify(legacy)); } catch { /* private mode */ }
}
function legacyCost(rank) { return 3 + rank * 2; } // shards; grows per rank
loadLegacy();

/* ---------- difficulty, settings, achievements ---------- */

// Difficulty scales the Heart's durability and how fast pressure arrives.
// Chosen on the title screen; persists across sessions.
const DIFFICULTIES = {
  easy: { label: "🌱 Easy", hp: 1.5, wave: 1.35, trickle: 1.4 },
  normal: { label: "⚔️ Normal", hp: 1, wave: 1, trickle: 1 },
  hard: { label: "💀 Hard", hp: 0.75, wave: 0.75, trickle: 0.75 },
};
let difficulty = "normal";

function heartMaxHp() {
  return Math.round((100 + legacy.heartRank * 20) * DIFFICULTIES[difficulty].hp);
}

const settings = { volume: 1, shake: true };

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("vx-settings") || "{}");
    if (typeof saved.volume === "number") settings.volume = saved.volume;
    if (typeof saved.shake === "boolean") settings.shake = saved.shake;
    if (DIFFICULTIES[saved.difficulty]) difficulty = saved.difficulty;
  } catch { /* defaults */ }
  setMasterVolume(settings.volume);
}
function saveSettings() {
  try {
    localStorage.setItem("vx-settings", JSON.stringify({ ...settings, difficulty }));
  } catch { /* private mode */ }
}
loadSettings();

// Lightweight local achievements: unlocked once, persisted, announced with a
// toast. Checked at the moments their stats change, not polled.
const ACHIEVEMENTS = {
  "first-blood": "🏆 First Blood — destroy your first zombie",
  "exterminator": "🏆 Exterminator — 100 kills in one run",
  "wave-5": "🏆 Holding On — survive to wave 5",
  "wave-10": "🏆 Unbreakable — survive to wave 10",
  "evolved-5": "🏆 It's Growing — witness a level 5 zombie",
  "evolved-10": "🏆 Apex Predator — witness a level 10 zombie",
  "engineer": "🏆 Engineer — 3 turrets standing at once",
  "rich": "🏆 War Chest — hold 500 energy",
};
let unlockedAchievements = {};
try { unlockedAchievements = JSON.parse(localStorage.getItem("vx-achievements") || "{}"); } catch { /* none */ }

function unlockAchievement(key) {
  if (unlockedAchievements[key]) return;
  unlockedAchievements[key] = true;
  try { localStorage.setItem("vx-achievements", JSON.stringify(unlockedAchievements)); } catch { /* oh well */ }
  showToast(ACHIEVEMENTS[key]);
  playPurchase(); // reuse the reward chime
}
let heart = null; // { isHeart, x, z, y, visualY, stackLevel, hp, group, crystal, glow, light }
let gameState = "playing"; // "playing" | "paused" | "over"
let waveNumber = 0, waveTimer = 18, trickleTimer = 5;
let runStartTime = 0; // seconds (performance.now() clock) when the current run began
let lastHeartHitSound = 0; // throttle: a swarm chips the Heart every frame, the alarm shouldn't

// ⚡ Energy: the run's spendable currency, earned 1:1 with XP from kills but
// tracked separately — XP is a lifetime total that drives blast-radius
// unlocks and must never decrease, while energy is drained by shop purchases.
let energy = 0;
let repairCost = 50, turretCost = 120;
let turrets = []; // { x, z, y, group, head, cooldown }
let turretBolts = []; // { mesh, target }

function heightAt(x, z) {
  const xi = Math.max(0, Math.min(GRID - 1, Math.round(x)));
  const zi = Math.max(0, Math.min(GRID - 1, Math.round(z)));
  return currentHeights ? currentHeights[zi * GRID + xi] : 0;
}

// Whether (x,z) is a real, permanent body of water — judged from the PRISTINE
// height, not the current (possibly dug) one. Blast craters carve indefinitely
// deep with no floor, so a deep crater's current height easily drops below sea
// level; checking currentHeights there would wrongly treat "a hole you blew in
// the ground" as a lake and block zombies from ever walking into it.
function isWaterAt(x, z) {
  const xi = Math.max(0, Math.min(GRID - 1, Math.round(x)));
  const zi = Math.max(0, Math.min(GRID - 1, Math.round(z)));
  return originalHeights ? originalHeights[zi * GRID + xi] <= currentSeaLevel : false;
}

// Vertical-movement state for a zombie: instead of snapping to the new block
// height the instant it crosses a column boundary, it hops there smoothly.
function initVerticalState(x, z) {
  const y = heightAt(x, z) + 0.5;
  return { groundTarget: y, visualY: y, hopFrom: y, hopTo: y, hopT: 1 };
}

// Finds dry land nearest the map center for the Heart to stand on —
// spirals outward from dead center until it hits a non-water column.
function findHeartSpot() {
  const c = GRID / 2;
  for (let r = 0; r < GRID / 2; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        const x = Math.round(c + dx), z = Math.round(c + dz);
        if (x < 3 || z < 3 || x >= GRID - 3 || z >= GRID - 3) continue;
        if (!isWaterAt(x, z)) return { x, z };
      }
    }
  }
  return { x: Math.round(c), z: Math.round(c) };
}

// Builds (or rebuilds, on terrain change) the Heart crystal at the map
// center: a slowly spinning octahedron with a glow sprite and its own light.
// keepHp preserves damage across a keep-zombies terrain regen.
function buildHeart(keepHp = false) {
  const prevHp = keepHp && heart ? heart.hp : heartMaxHp();
  if (heart) root.remove(heart.group);
  const { x, z } = findHeartSpot();
  const y = heightAt(x, z) + 1;

  const group = new THREE.Group();
  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.75),
    new THREE.MeshLambertMaterial({ color: 0x66d9ff, emissive: 0x1c5a78 })
  );
  crystal.position.y = 1.1;
  group.add(crystal);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.75, 0.35, 8),
    new THREE.MeshLambertMaterial({ color: 0x3a4a58 })
  );
  base.position.y = 0.18;
  group.add(base);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0x7fe8ff, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glow.scale.setScalar(4.2);
  glow.position.y = 1.2;
  group.add(glow);

  const light = new THREE.PointLight(0x7fe8ff, 6, 14, 2);
  light.position.y = 2;
  group.add(light);

  group.position.set(x, y, z);
  root.add(group);

  heart = { isHeart: true, x, z, y, visualY: y + 0.3, stackLevel: 1, hp: prevHp, group, crystal, glow, light };
  updateHeartHud();
}

// Spin/bob the crystal, track terrain height (blasts can lower the ground
// under it), and pulse faster the closer the Heart is to dying.
function updateHeart(now) {
  if (!heart) return;
  const y = heightAt(heart.x, heart.z) + 1;
  heart.y = y;
  heart.visualY = y + 0.3;
  heart.group.position.y = y;
  heart.crystal.rotation.y = now * 0.8;
  const frac = Math.max(0, heart.hp) / heartMaxHp();
  const urgency = 1 + (1 - frac) * 3;
  heart.crystal.position.y = 1.1 + Math.sin(now * 1.6 * urgency) * 0.12;
  heart.glow.material.opacity = 0.4 + 0.2 * Math.sin(now * 2 * urgency) + (1 - frac) * 0.15;
}

function updateHeartHud() {
  const fill = document.getElementById("vx-heart-fill");
  const waveEl = document.getElementById("vx-wave-val");
  if (waveEl) waveEl.textContent = waveNumber === 0 ? "Calm before the storm" : `Wave ${waveNumber}`;
  if (!fill) return;
  const frac = Math.max(0, heart ? heart.hp : 0) / heartMaxHp();
  fill.style.width = `${frac * 100}%`;
  fill.classList.toggle("hurt", frac <= 0.6 && frac > 0.3);
  fill.classList.toggle("critical", frac <= 0.3);
}

let vignetteTimer = null;
function damageHeart(amount) {
  if (!heart || gameState !== "playing") return;
  heart.hp -= amount;
  updateHeartHud();

  // Red edge-of-screen flash + throttled alarm so damage is FELT even while
  // the player is staring at a fight on the other side of the map.
  const vignette = document.getElementById("vx-vignette");
  if (vignette) {
    vignette.classList.add("flash");
    clearTimeout(vignetteTimer);
    vignetteTimer = setTimeout(() => vignette.classList.remove("flash"), 90);
  }
  const now = performance.now() / 1000;
  if (now - lastHeartHitSound > 0.35) {
    lastHeartHitSound = now;
    playHeartHit();
  }

  if (heart.hp <= 0) endRun();
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
  pendingSpawns = []; // don't let a queued respawn from the old world pop into the new one
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
      speed: stackSpeed(1) + rand() * 0.2, // small jitter only — level 2+ must always outrun a fresh level 1
      timer: rand() * 2,
      phase: rand() * Math.PI * 2,
      walkPhase: rand() * Math.PI * 2,
      hp: 1, stackLevel: 1, eatXp: 0, eatPulse: 0, fightTarget: null, attackTimer: 0,
      ...initVerticalState(x, z),
      ...createMonsterUi(),
    });
  }
  killCount = 0;
  xp = 0;
  maxUnlockedBlast = STARTING_MAX_BLAST + legacy.blastRank; // Demolitionist legacy perk
  updateScoreHud();
  updateZombieBoard();
}

// Spawns one fresh zombie at a random valid spot — used to replace a killed one.
function spawnRandomZombie(atEdge = false) {
  const biome = currentBiome;
  let x = GRID / 2, z = GRID / 2, h;
  for (let tries = 0; tries < 30; tries++) {
    if (atEdge) {
      // Invasion spawns arrive from the map's rim, not teleported into the
      // middle of the defense — a narrow band along a random side.
      const side = Math.floor(Math.random() * 4);
      const along = 3 + Math.random() * (GRID - 6);
      const inset = 3 + Math.random() * 2;
      if (side === 0) { x = along; z = inset; }
      else if (side === 1) { x = along; z = GRID - inset; }
      else if (side === 2) { x = inset; z = along; }
      else { x = GRID - inset; z = along; }
    } else {
      x = 3 + Math.random() * (GRID - 6);
      z = 3 + Math.random() * (GRID - 6);
    }
    h = heightAt(x, z);
    if (h > biome.seaLevel && h < biome.snowLine) break;
  }
  const mats = buildZombieMaterials(currentSeed, monsterIdCounter++);
  const rig = createZombieMesh(mats);
  monsterGroup.add(rig.root);
  monsters.push({
    rig, mats, x, z,
    angle: Math.random() * Math.PI * 2,
    speed: stackSpeed(1) + Math.random() * 0.2,
    timer: Math.random() * 2,
    phase: Math.random() * Math.PI * 2,
    walkPhase: Math.random() * Math.PI * 2,
    hp: 1, stackLevel: 1, eatXp: 0, eatPulse: 0, fightTarget: null, attackTimer: 0,
    ...initVerticalState(x, z),
    ...createMonsterUi(),
  });
  updateZombieBoard();
}

// Replacement spawns go through this queue instead of appearing instantly,
// so the HUD "Respawn delay" slider can hold them back. To stop production
// entirely, set the "Spawns per blast kill" and "Spawns per eaten" sliders
// to 0 — then nothing gets queued in the first place, which starves the map
// of fresh level 1s and lets the big zombies' dominance actually play out.
let spawnDelay = 0; // seconds
let pendingSpawns = []; // due-timestamps (seconds, performance.now() clock)

function queueZombieSpawn() {
  if (spawnDelay <= 0) { spawnRandomZombie(); return; }
  pendingSpawns.push(performance.now() / 1000 + spawnDelay);
}

function processPendingSpawns(now) {
  if (pendingSpawns.length === 0) return;
  const due = pendingSpawns.filter((t) => t <= now);
  if (due.length === 0) return;
  pendingSpawns = pendingSpawns.filter((t) => t > now);
  for (let i = 0; i < due.length; i++) spawnRandomZombie();
}

/* ---------- run structure: waves, defeat, restart ---------- */

// The difficulty engine. Waves land on a shrinking timer and each brings a
// bigger batch of edge-spawned invaders; between waves a trickle keeps
// low-grade pressure on. Combined with zombie-vs-zombie eating (which
// concentrates all those bodies into ever-higher levels), the siege
// escalates on its own — the player is racing the evolution curve.
function updateWaves(dt) {
  if (gameState !== "playing") return;
  waveTimer -= dt;
  if (waveTimer <= 0) {
    waveNumber++;
    waveTimer = Math.max(10, 22 - waveNumber * 0.5) * DIFFICULTIES[difficulty].wave;
    const count = 2 + waveNumber;
    for (let i = 0; i < count; i++) spawnRandomZombie(true);
    playWaveStart();
    showToast(`🌊 Wave ${waveNumber} — ${count} invaders!`);
    if (waveNumber >= 5) unlockAchievement("wave-5");
    if (waveNumber >= 10) unlockAchievement("wave-10");
    updateHeartHud();
  }
  trickleTimer -= dt;
  if (trickleTimer <= 0) {
    trickleTimer = Math.max(1.5, 5 - waveNumber * 0.15) * DIFFICULTIES[difficulty].trickle;
    spawnRandomZombie(true);
  }
}

function runScore(survivalSeconds) {
  return Math.round(survivalSeconds) + killCount * 5;
}

function endRun() {
  gameState = "over";
  const now = performance.now() / 1000;
  const survived = now - runStartTime;
  let maxLevel = 1;
  for (const m of monsters) if (m.stackLevel > maxLevel) maxLevel = m.stackLevel;
  const score = runScore(survived);
  let best = 0;
  try {
    best = Number(localStorage.getItem("vx-best-score") || 0);
    if (score > best) { best = score; localStorage.setItem("vx-best-score", String(score)); }
  } catch { /* storage may be unavailable; the run still ends cleanly */ }

  playGameOver();

  // A last blast of drama at the Heart as it shatters.
  if (heart) {
    spawnEatFx(heart.x, heart.y + 1, heart.z);
    shake = 4.5;
  }

  // Bank Legacy shards — every defeat still buys future power.
  const shardsEarned = Math.max(1, Math.floor(score / 50));
  legacy.shards += shardsEarned;
  saveLegacy();

  const stats = document.getElementById("vx-go-stats");
  if (stats) {
    const mins = Math.floor(survived / 60), secs = Math.round(survived % 60);
    stats.innerHTML =
      `Survived <b>${mins}m ${secs}s</b> across <b>${waveNumber}</b> waves<br>` +
      `Zombies destroyed: <b>${killCount}</b> · Strongest evolved: <b>Lvl ${maxLevel}</b><br>` +
      `Score: <b>${score}</b> · <span class="go-best">Best: ${best}</span><br>` +
      `🔮 Shards earned: <b>+${shardsEarned}</b>`;
  }
  renderLegacyShop();
  document.getElementById("vx-gameover")?.classList.add("show");
  updateHeartHud();
}

// The permanent-upgrade storefront on the defeat screen. Perks apply from
// the NEXT run on; buying re-renders in place so shards can be chain-spent.
const LEGACY_PERKS = [
  { key: "heartRank", icon: "💪", name: "Reinforced Heart", desc: "+20 max Heart HP" },
  { key: "energyRank", icon: "⚡", name: "Head Start", desc: "+40 starting energy" },
  { key: "blastRank", icon: "💥", name: "Demolitionist", desc: "+1 starting blast radius" },
];

function renderLegacyShop() {
  const el = document.getElementById("vx-legacy-shop");
  if (!el) return;
  const rows = LEGACY_PERKS.map((p, i) => {
    const rank = legacy[p.key];
    const cost = legacyCost(rank);
    const afford = legacy.shards >= cost;
    return `<div class="legacy-row">
      <span class="legacy-name">${p.icon} ${p.name} <em>Lv ${rank}</em><br><small>${p.desc}</small></span>
      <button class="legacy-buy" data-perk="${i}" ${afford ? "" : "disabled"}>${cost} 🔮</button>
    </div>`;
  }).join("");
  el.innerHTML = `<div class="legacy-title">🔮 Legacy — ${legacy.shards} shards</div>${rows}`;
  for (const btn of el.querySelectorAll(".legacy-buy")) {
    btn.addEventListener("click", () => {
      const perk = LEGACY_PERKS[Number(btn.dataset.perk)];
      const cost = legacyCost(legacy[perk.key]);
      if (legacy.shards < cost) return;
      legacy.shards -= cost;
      legacy[perk.key]++;
      saveLegacy();
      playPurchase();
      renderLegacyShop();
    });
  }
}

// Fresh run on the CURRENT world: new Heart at full HP, wave clock reset.
// Called from generateWorld (every new world starts a fresh run) and the
// game-over restart button (which regenerates the world too).
function resetRun() {
  gameState = "playing";
  waveNumber = 0;
  waveTimer = 18 * DIFFICULTIES[difficulty].wave;
  trickleTimer = 5 * DIFFICULTIES[difficulty].trickle;
  runStartTime = performance.now() / 1000;
  buildHeart(false);
  clearTurrets();
  energy = legacy.energyRank * 40; // Head Start legacy perk
  repairCost = 50;
  turretCost = 120;
  document.getElementById("vx-gameover")?.classList.remove("show");
  document.getElementById("vx-paused")?.classList.remove("show");
  updateHeartHud();
  updateScoreHud(); // energy was just reset/seeded above — refresh its readout
  updateShopHud();
}

/* ---------- shop: spend energy on defenses ---------- */

// Both purchases escalate in price each time so the run stays a resource
// squeeze: cheap early saves, increasingly costly late-game lifelines.
function updateShopHud() {
  const repairBtn = document.getElementById("vx-shop-repair");
  const turretBtn = document.getElementById("vx-shop-turret");
  const repairCostEl = document.getElementById("vx-repair-cost");
  const turretCostEl = document.getElementById("vx-turret-cost");
  if (repairCostEl) repairCostEl.textContent = `${repairCost}⚡`;
  if (turretCostEl) turretCostEl.textContent = `${turretCost}⚡`;
  if (repairBtn) repairBtn.disabled = gameState !== "playing" || energy < repairCost || !heart || heart.hp >= heartMaxHp();
  if (turretBtn) turretBtn.disabled = gameState !== "playing" || energy < turretCost;
}

function buyRepair() {
  if (gameState !== "playing" || energy < repairCost || !heart || heart.hp >= heartMaxHp()) return;
  energy -= repairCost;
  repairCost = Math.round(repairCost * 1.5);
  heart.hp = Math.min(heartMaxHp(), heart.hp + 30);
  playPurchase();
  spawnEatFx(heart.x, heart.y + 1.2, heart.z); // reuse the flash/ring as a "heal burst"
  updateHeartHud();
  updateScoreHud();
}

function buyTurret() {
  if (gameState !== "playing" || energy < turretCost) return;
  energy -= turretCost;
  turretCost = Math.round(turretCost * 1.6);
  buildTurret();
  if (turrets.length >= 3) unlockAchievement("engineer");
  playPurchase();
  updateScoreHud();
}

/* ---------- turrets: automated defense ---------- */

const TURRET_RANGE = 8;
const TURRET_COOLDOWN = 0.8;
const TURRET_DMG = 1; // flat, ignores zombie armor — turrets are tech, like blasts

// Each new turret takes the next slot on a ring around the Heart (golden-
// angle spacing so any count spreads evenly without overlapping).
function buildTurret() {
  const idx = turrets.length;
  const angle = idx * 2.399963; // golden angle in radians
  const ringR = 3.2 + (idx % 3) * 0.8;
  const x = heart.x + Math.sin(angle) * ringR;
  const z = heart.z + Math.cos(angle) * ringR;
  const y = heightAt(x, z) + 0.5;

  const group = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.22, 1.1, 6),
    new THREE.MeshLambertMaterial({ color: 0x4a5a68 })
  );
  post.position.y = 0.55;
  group.add(post);
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.3, 0.42),
    new THREE.MeshLambertMaterial({ color: 0x77e0a8, emissive: 0x1c4a30 })
  );
  head.position.y = 1.2;
  group.add(head);
  group.position.set(x, y, z);
  root.add(group);

  turrets.push({ x, z, y, group, head, cooldown: 0 });
}

function clearTurrets() {
  for (const t of turrets) {
    root.remove(t.group);
    t.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  }
  turrets = [];
  for (const b of turretBolts) {
    root.remove(b.mesh);
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
  }
  turretBolts = [];
}

// Re-seat turrets on new ground after a keep-zombies terrain regen.
function reseatTurrets() {
  for (const t of turrets) {
    t.y = heightAt(t.x, t.z) + 0.5;
    t.group.position.y = t.y;
  }
}

function updateTurrets(dt) {
  for (const t of turrets) {
    t.cooldown -= dt;
    // Track + shoot the nearest zombie in range.
    let best = null, bestD = TURRET_RANGE;
    for (const m of monsters) {
      const d = Math.hypot(m.x - t.x, m.z - t.z);
      if (d < bestD) { best = m; bestD = d; }
    }
    if (!best) continue;
    t.head.rotation.y = Math.atan2(best.x - t.x, best.z - t.z);
    if (t.cooldown > 0) continue;
    t.cooldown = TURRET_COOLDOWN;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 6, 5),
      new THREE.MeshBasicMaterial({
        color: 0x7fffd0, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    mesh.position.set(t.x, t.y + 1.2, t.z);
    root.add(mesh);
    turretBolts.push({ mesh, target: best });
    playTurretShot();
  }

  for (let i = turretBolts.length - 1; i >= 0; i--) {
    const b = turretBolts[i];
    if (!monsters.includes(b.target)) {
      root.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
      turretBolts.splice(i, 1);
      continue;
    }
    const ty = b.target.visualY + 0.9 * stackScale(b.target.stackLevel);
    const dx = b.target.x - b.mesh.position.x, dy = ty - b.mesh.position.y, dz = b.target.z - b.mesh.position.z;
    const dist = Math.hypot(dx, dy, dz);
    const step = 30 * dt;
    if (dist <= Math.max(0.25, step)) {
      b.target.hp -= TURRET_DMG;
      root.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
      turretBolts.splice(i, 1);
      if (b.target.hp <= 0) killZombieByPlayer(b.target);
      continue;
    }
    b.mesh.position.x += (dx / dist) * step;
    b.mesh.position.y += (dy / dist) * step;
    b.mesh.position.z += (dz / dist) * step;
  }
}

// A single player-credited kill (turret bolt finished a zombie off): same
// rewards and respawn rules as a blast kill, minus the area logic.
function killZombieByPlayer(m) {
  if (!monsters.includes(m)) return;
  monsterGroup.remove(m.rig.root);
  disposeZombieMaterials(m.mats);
  disposeMonsterUi(m);
  spawnGibs(m.x, heightAt(m.x, m.z) + 0.9, m.z);
  monsters.splice(monsters.indexOf(m), 1);
  playZombieKill(1);
  killCount++;
  const earned = m.stackLevel * 10;
  xp += earned;
  energy += earned;
  unlockAchievement("first-blood");
  if (killCount >= 100) unlockAchievement("exterminator");
  if (energy >= 500) unlockAchievement("rich");
  updateScoreHud();
  checkBlastUnlocks();
  let toSpawn = spawnsPerKill;
  while (toSpawn-- > 0) queueZombieSpawn();
  updateZombieBoard();
}

function stackScale(level) { return 1 + (level - 1) * 0.3; }
/* ---------- live-tweakable sim knobs (⚙️ Tweaks panel in the HUD) ---------- */
let spawnsPerKill = 2; // fresh zombies spawned per player blast kill
let spawnsPerEat = 1; // fresh zombies spawned per zombie eaten by another zombie (0 = the strong thin the herd)
let speedPerLevel = 0.3; // extra speed a zombie gains per level past 1
let simSpeed = 1; // time multiplier for the zombie sim (movement + combat), not the player's missiles
let hpPerLevel = 1; // extra max HP per level past 1 — crank it to make elites tanky against blasts too
let dmgPerLevel = 1; // extra DPS per level past 1 dealt in zombie-vs-zombie fights
let atkPerLevel = 0.25; // attack-rate growth per level past 1 (0 = every level shoots at the same cadence)

// Max HP and fight-DPS as functions of level, both anchored at 1 for a
// level-1 zombie and growing by their sliders. Blast damage stays flat
// (1, 2 in the core), so raising hpPerLevel directly makes high levels
// harder for the PLAYER to kill, not just for other zombies.
function maxHpFor(level) { return 1 + (level - 1) * hpPerLevel; }
function dpsFor(level) { return 1 + (level - 1) * dmgPerLevel; }

// Flat armor against zombie-vs-zombie projectiles: a level-X zombie shrugs
// off X-2 points of incoming DPS. With default damage (DPS = attacker's
// level) that means anything more than 2 levels below its target can't
// scratch it at all — runts simply cannot gang up on an elite. Player
// blasts ignore defense entirely.
function defenseFor(level) { return Math.max(0, level - 2); }

// No cap, deliberately — a high-level zombie is hard-won (see
// eatsNeededForLevel) so it should keep getting faster forever, but linearly:
// x1 at level 1, +speedPerLevel per level after (an earlier x1.5-compounding
// curve made high levels comically untrackable).
function stackSpeed(level) { return 1 + (level - 1) * speedPerLevel; }
// Odd numbers: 1, 3, 5, 7, ... — how many zombies a zombie at this level must
// eat to advance to the next level. Escalates faster than a flat rate so
// early levels come quickly but high levels are a real achievement.
function eatsNeededForLevel(level) { return 2 * level - 1; }

const HP_BAR_W = 0.9, HP_BAR_H = 0.13;
const HP_BAR_INNER_W = 0.8, HP_BAR_INNER_H = 0.08;

// How far above a zombie's feet its health bar / aura should float, scaled
// to how tall that particular stack level actually renders.
function hpBarOffset(level) { return 1.95 * stackScale(level) + 0.35; }

// Soft white radial-gradient texture, built once and shared (tinted per
// instance via SpriteMaterial.color) by the health bar and elite-marker glow.
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
// fill drains correctly regardless of camera angle). All added to
// monsterUiGroup so world-reset cleanup is free. (Every zombie's stack level
// is now called out only on demand — see the "Locate strongest" elite-marker
// pool further down — not with an always-on per-zombie glow, which got
// unreadable once a few dozen zombies were all wearing one at once.)
function createMonsterUi() {
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

  return { healthBg, healthFill };
}

// Removes one zombie's UI sprites — never disposes .geometry (Sprites share a
// module-level singleton), only the per-instance materials.
function disposeMonsterUi(m) {
  monsterUiGroup.remove(m.healthBg, m.healthFill);
  m.healthBg.material.dispose();
  m.healthFill.material.dispose();
}

// Attack cadence: higher levels shoot faster (rate growth per level is the
// atkPerLevel slider). Damage per projectile is scaled by the interval so
// actual DPS is exactly dpsFor(level) regardless of how fast the shots come
// — cadence is presentation, the damage sliders control the math.
function attackInterval(level) { return 1.0 / (1 + atkPerLevel * (level - 1)); }

// Any two zombies that wander close enough fight it out — no same-level
// restriction. Fighters STOP moving, square up face to face, and lob
// projectiles at each other; each projectile carries its shooter's
// level-scaled damage, so a fresh fight between equal levels is still an
// even coin-toss while a higher level is a strong favorite. hp persists
// between fights (and blast damage!), so a wounded big zombie CAN lose to a
// fresh runt. Reach scales with both fighters' body size — a big zombie
// starts shooting from further out.
function updateZombieCombat(dt) {
  for (const m of monsters) m.fightTarget = null;
  for (let i = 0; i < monsters.length; i++) {
    const a = monsters[i];
    for (let j = i + 1; j < monsters.length; j++) {
      const b = monsters[j];
      const reach = EAT_DIST * 1.6 * (stackScale(a.stackLevel) + stackScale(b.stackLevel)) / 2;
      if (Math.hypot(a.x - b.x, a.z - b.z) >= reach) continue;
      if (!a.fightTarget) a.fightTarget = b;
      if (!b.fightTarget) b.fightTarget = a;
    }
  }
  // Anyone not busy brawling turns its guns on the Heart when close enough —
  // sieging the objective, not just each other.
  if (heart && gameState === "playing") {
    for (const m of monsters) {
      if (m.fightTarget) continue;
      const reach = EAT_DIST * 2.4 * stackScale(m.stackLevel);
      if (Math.hypot(m.x - heart.x, m.z - heart.z) < reach) m.fightTarget = heart;
    }
  }
  for (const m of monsters) {
    if (!m.fightTarget) continue;
    m.attackTimer -= dt;
    if (m.attackTimer <= 0) {
      m.attackTimer = attackInterval(m.stackLevel);
      fireZombieProjectile(m, m.fightTarget);
    }
  }
  updateZombieProjectiles(dt);
}

// A glowing bile blob lobbed from attacker to target — the actual damage
// carrier. Size grows with the shooter's level so a high-level zombie's
// shots read as genuinely dangerous from across the map.
let zombieProjectiles = [];

function fireZombieProjectile(shooter, target) {
  const level = shooter.stackLevel;
  const radius = 0.07 + Math.min(0.5, level * 0.035);
  const geo = new THREE.SphereGeometry(radius, 8, 6);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x8aff3a, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(shooter.x, shooter.visualY + 1.2 * stackScale(level), shooter.z);
  root.add(mesh);
  zombieProjectiles.push({
    mesh, shooter, target,
    // Raw DPS + this shot's interval, kept separate so the target's defense
    // (a DPS-denominated stat) can be subtracted at hit time — see
    // updateZombieProjectiles.
    dps: dpsFor(level),
    interval: attackInterval(level),
    speed: 40, // super fast — reads as a shot, not a lobbed balloon
  });
}

function updateZombieProjectiles(dt) {
  for (let i = zombieProjectiles.length - 1; i >= 0; i--) {
    const p = zombieProjectiles[i];
    // Target already died/got eaten mid-flight (or the run ended, for the
    // Heart): the blob fizzles out.
    const targetAlive = p.target.isHeart ? gameState === "playing" : monsters.includes(p.target);
    if (!targetAlive) {
      root.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      zombieProjectiles.splice(i, 1);
      continue;
    }
    const tx = p.target.x, ty = p.target.visualY + 0.9 * stackScale(p.target.stackLevel), tz = p.target.z;
    const dx = tx - p.mesh.position.x, dy = ty - p.mesh.position.y, dz = tz - p.mesh.position.z;
    const dist = Math.hypot(dx, dy, dz);
    const step = p.speed * dt;
    if (dist <= Math.max(0.25, step)) {
      // Hit: damage after the target's flat armor (defenseFor, in DPS
      // terms — an attacker whose DPS doesn't clear it deals nothing),
      // then resolve a possible kill. The Heart's stackLevel of 1 gives it
      // zero armor, so every zombie always chips it.
      const effDmg = Math.max(0, (p.dps - defenseFor(p.target.stackLevel)) * p.interval);
      root.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      zombieProjectiles.splice(i, 1);
      if (p.target.isHeart) {
        damageHeart(effDmg);
      } else {
        p.target.hp -= effDmg;
        if (p.target.hp <= 0) resolveZombieKill(p.shooter, p.target);
      }
      continue;
    }
    p.mesh.position.x += (dx / dist) * step;
    p.mesh.position.y += (dy / dist) * step;
    p.mesh.position.z += (dz / dist) * step;
  }
}

// The loser is killed outright and immediately replaced by a fresh level-1
// zombie elsewhere on the map, so zombie-on-zombie combat never shrinks the
// total population: only a player blast kill (see killMonstersNear, which
// spawns replacements) changes the total count. The killer earns XP equal to
// the LOSER'S level — eating something tougher is worth proportionally more,
// same idea as a real RPG — and can level up multiple times off one huge
// kill. No ceiling: left alone long enough, constantly-replenished weak
// zombies feed a slow "survival of the fittest" climb toward one monster.
function resolveZombieKill(killer, loser) {
  const lx = loser.x, lz = loser.z;
  monsterGroup.remove(loser.rig.root);
  disposeZombieMaterials(loser.mats);
  disposeMonsterUi(loser);
  monsters.splice(monsters.indexOf(loser), 1);

  spawnEatFx(lx, heightAt(lx, lz) + 1, lz);
  spawnGibs(lx, heightAt(lx, lz) + 0.9, lz);

  // Replacement spawns — default 1-for-1 keeps eats population-neutral, but
  // it's a tweakable: 0 lets the strong actually thin the herd, higher
  // values make eating feed the swarm.
  for (let s = 0; s < spawnsPerEat; s++) queueZombieSpawn();

  // The killer may itself have died from a crossing projectile in the same
  // instant — a corpse doesn't eat, so the XP just goes unclaimed.
  if (!monsters.includes(killer)) return;

  // A quick lunge toward the kill spot sells the "eating" motion.
  killer.x += (lx - killer.x) * 0.5;
  killer.z += (lz - killer.z) * 0.5;
  killer.eatPulse = 0.3;

  killer.eatXp += loser.stackLevel;
  while (killer.eatXp >= eatsNeededForLevel(killer.stackLevel)) {
    killer.eatXp -= eatsNeededForLevel(killer.stackLevel);
    killer.stackLevel++;
    killer.hp = maxHpFor(killer.stackLevel); // leveling up fully heals
    killer.speed = stackSpeed(killer.stackLevel) + Math.random() * 0.2;
  }
  if (killer.stackLevel >= 5) unlockAchievement("evolved-5");
  if (killer.stackLevel >= 10) unlockAchievement("evolved-10");
  updateZombieBoard();
}

function updateScoreHud() {
  const killEl = document.getElementById("vx-score-val");
  if (killEl) killEl.textContent = String(killCount);

  const energyEl = document.getElementById("vx-energy-val");
  if (energyEl) energyEl.textContent = String(energy);
  updateShopHud();

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
    let moving = false;
    // Mid-fight (fightTarget set by updateZombieCombat, one frame behind):
    // plant feet and square up toward the opponent — all damage comes from
    // the projectiles, so a fighting zombie stands its ground and shoots.
    const fighting = m.fightTarget && (m.fightTarget.isHeart || monsters.includes(m.fightTarget));
    if (fighting) {
      m.angle = Math.atan2(m.fightTarget.x - m.x, m.fightTarget.z - m.z);
    } else {
      m.timer -= dt;
      if (m.timer <= 0) {
        // The siege instinct: most retargets head for the Heart (with some
        // spread so the horde doesn't single-file), the rest wander — and
        // the pull gets stronger as waves ramp up.
        const heartBias = Math.min(0.85, 0.4 + waveNumber * 0.03);
        if (heart && gameState === "playing" && Math.random() < heartBias) {
          m.angle = Math.atan2(heart.x - m.x, heart.z - m.z) + (Math.random() - 0.5) * 0.9;
        } else {
          m.angle = Math.random() * Math.PI * 2;
        }
        m.timer = 1.5 + Math.random() * 2.5;
      }
      const nx = m.x + Math.sin(m.angle) * m.speed * dt;
      const nz = m.z + Math.cos(m.angle) * m.speed * dt;
      const inBounds = nx > 2 && nx < GRID - 3 && nz > 2 && nz < GRID - 3;
      // Zombies can walk anywhere regardless of elevation — no slope/height gate
      // at all, only actual water (see isWaterAt) and the map edge stop them.
      if (inBounds && !isWaterAt(nx, nz)) {
        m.x = nx; m.z = nz;
        moving = true;
      } else {
        m.angle += Math.PI + (Math.random() - 0.5);
      }
    }
    // Smooth step-height changes into a hop instead of snapping. Climbing
    // gradually scales with how many blocks tall the step is (a 3-block climb
    // takes ~3x as long as a 1-block one); descending is just a fall from the
    // top block to the bottom one, so its duration doesn't scale with drop
    // height the same way — it's always quick, never a slow gradual descent.
    const groundTarget = heightAt(m.x, m.z) + 0.5;
    if (Math.abs(groundTarget - m.groundTarget) > 0.01) {
      m.hopFrom = m.visualY;
      m.hopTo = groundTarget;
      m.hopT = 0;
      m.groundTarget = groundTarget;
    }
    if (m.hopT < 1) {
      const climbing = m.hopTo > m.hopFrom;
      const stepSize = Math.abs(m.hopTo - m.hopFrom);
      const hopDuration = climbing ? 0.5 * Math.max(1, stepSize) : 0.2;
      m.hopT = Math.min(1, m.hopT + dt / hopDuration);
      if (climbing) {
        const ease = 1 - (1 - m.hopT) * (1 - m.hopT); // ease-out
        const arc = Math.sin(m.hopT * Math.PI) * 0.24;
        m.visualY = m.hopFrom + (m.hopTo - m.hopFrom) * ease + arc;
      } else {
        const fall = m.hopT * m.hopT; // ease-in — accelerating like gravity
        m.visualY = m.hopFrom + (m.hopTo - m.hopFrom) * fall;
      }
    } else {
      m.visualY = m.hopTo;
    }
    const idleBob = m.hopT >= 1 ? Math.sin(now * 2.2 + m.phase) * 0.04 : 0;
    m.rig.root.position.set(m.x, m.visualY + idleBob, m.z);
    m.rig.root.rotation.y = m.angle;

    // Base size always tracks current level (so a level-up from eating grows
    // it immediately) with a brief punchy pulse layered on top right after a
    // kill, to sell the "eating" impact.
    if (m.eatPulse > 0) m.eatPulse = Math.max(0, m.eatPulse - dt);
    const pulse = m.eatPulse > 0 ? 1 + 0.25 * Math.sin((m.eatPulse / 0.3) * Math.PI) : 1;
    m.rig.root.scale.setScalar(stackScale(m.stackLevel) * pulse);

    if (moving) m.walkPhase += dt * m.speed * 3.2;
    const swing = Math.sin(m.walkPhase) * 0.5;
    m.rig.legL.rotation.x = swing;
    m.rig.legR.rotation.x = -swing;
    m.rig.armL.rotation.x = -1.15 - swing * 0.3;
    m.rig.armR.rotation.x = -1.15 + swing * 0.3;

    // Health bar — only shown once damaged, hidden again at full HP.
    const damaged = m.hp < maxHpFor(m.stackLevel);
    m.healthBg.visible = m.healthFill.visible = damaged;
    if (damaged) {
      const barY = m.visualY + hpBarOffset(m.stackLevel);
      m.healthBg.position.set(m.x, barY, m.z);
      m.healthFill.position.set(m.x, barY, m.z);
      const ratio = Math.max(0, m.hp / maxHpFor(m.stackLevel));
      m.healthFill.scale.set(HP_BAR_INNER_W * ratio, HP_BAR_INNER_H, 1);
      m.healthFill.material.color.setHex(ratio > 0.5 ? 0x4fd68a : ratio > 0.25 ? 0xffcf5a : 0xff5a4a);
    }
  }
  updateEliteMarkers(now);
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
    energy += earned; // spendable twin of the XP payout — see the energy declaration
    unlockAchievement("first-blood");
    if (killCount >= 100) unlockAchievement("exterminator");
    if (energy >= 500) unlockAchievement("rich");
    updateScoreHud();
    checkBlastUnlocks();
    if (kills >= 2) spawnKillStreakPopup(bx, heightAt(bx, bz) + 2.6, bz, kills);
    // No cap, intentionally — see the "no artificial limits" note near
    // MONSTER_COUNT. Every kill spawns `spawnsPerKill` more (default 2, user
    // tweakable down to 0 from the ⚙️ Tweaks panel), unconditionally, forever.
    let toSpawn = kills * spawnsPerKill;
    while (toSpawn-- > 0) queueZombieSpawn();
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

// Flash + shockwave at the spot a zombie got eaten — paired with a gib burst
// (see resolveZombieKill) so the kill reads as violent, not a polite hand-off.
function spawnEatFx(x, y, z) {
  const ringGeo = new THREE.RingGeometry(0.2, 0.35, 24);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xff5a3c, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.set(x, y - 0.8, z);
  ring.rotation.x = -Math.PI / 2;
  root.add(ring);
  fx.push({ type: "ring", obj: ring, age: 0, life: 0.5, maxR: 2.2 });

  const flashGeo = new THREE.SphereGeometry(0.4, 10, 8);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffcf6b, transparent: true, opacity: 0.9,
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
  if (depth <= 9) return { type: "ironstone", resistance: 6 };
  if (depth <= 19) return { type: "deepstone", resistance: 10 };
  return { type: "bedrock", resistance: 18 };
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

// A brightness multiplier sampled from smooth, continuous noise over a
// block's real world position — used as an InstancedMesh per-instance color
// (see rebuildBlockMeshes) so mineral variation blends across many
// neighboring blocks into patches and streaks, the way a real rock face
// looks, instead of each block being independently random and reading as its
// own separately-tinted swatch. Two octaves at different frequencies: one
// broad (large light/dark patches) and one finer (subtler local variation) —
// y is folded in at a different frequency so the patches aren't just
// vertical bands, they wander in 3D as you dig.
function terrainTint(x, y, z) {
  const broad = fbm(tintNoise, x * 0.045, z * 0.045 + y * 0.03, 2, 0.5);
  const fine = tintNoise.noise2D(x * 0.16 - y * 0.11, z * 0.16 + 50);
  const t = broad * 0.75 + fine * 0.25; // roughly [-1, 1]
  return 0.86 + (t * 0.5 + 0.5) * 0.28; // ~0.86–1.14 brightness
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

// Rebuilds the terrain InstancedMeshes from currentHeights/damageAccum. Called
// on world generation and again after every explosion edits the terrain.
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
  const { materials, variantCounts, stagedTypes } = activeMaterials;

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
        const stratum = stratumAt(biome, y, originalHeight);
        const type = stratum.type;
        // A block that's been hit but not yet broken shows cracks scaled to
        // how close it is to breaking, on top of ITS OWN material — there is
        // no separate "scorched" block type overlaid on top of it. Only the
        // current top-of-column block can carry unresolved damage.
        let stage = 0;
        if (y === height && stagedTypes.has(type) && stratum.resistance > 1) {
          const ratio = damageAccum[idx] / stratum.resistance;
          if (ratio > 0) stage = Math.min(3, Math.ceil(ratio * 3));
        }
        const variant = Math.floor(cellHash(x + y * 97, z) * variantCounts[type]);
        const key = `${type}:${variant}:${stage}`;
        let list = buckets.get(key);
        if (!list) { list = []; buckets.set(key, list); }
        list.push(x, y, z);
      }
    }
  }

  if (blockMeshes) { for (const m of blockMeshes) root.remove(m); }
  blockMeshes = [];
  const dummy = new THREE.Object3D();
  const dummyColor = new THREE.Color();
  for (const [key, list] of buckets) {
    const [type, variantStr, stageStr] = key.split(":");
    const variant = Number(variantStr);
    const stage = Number(stageStr);
    // Grass keeps its 6-face [side,side,top,bottom,side,side] array as-is —
    // it's topsoil (resistance 1) and never carries partial damage, so it has
    // no crack-stage ladder to index into. It also skips the tint below (see
    // terrainTint) since its material array isn't set up for vertex colors.
    const stages = materials[type][variant];
    const mat = type === "grass" ? stages : stages[Math.min(stage, stages.length - 1)];
    const n = list.length / 3;
    const mesh = new THREE.InstancedMesh(blockGeo, mat, n);
    for (let i = 0; i < n; i++) {
      const bx = list[i * 3], by = list[i * 3 + 1], bz = list[i * 3 + 2];
      dummy.position.set(bx, by, bz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      if (type !== "grass") {
        dummyColor.setScalar(terrainTint(bx, by, bz));
        mesh.setColorAt(i, dummyColor);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    root.add(mesh);
    blockMeshes.push(mesh);
  }
}

function generateWorld(seed, biomeKey, keepZombies = false) {
  const biome = BIOMES[biomeKey];
  currentBiome = biome;
  currentHeights = buildHeightmap(seed, biome);
  originalHeights = currentHeights.slice(); // pristine reference for depth/strata lookups — never mutated
  damageAccum = new Uint16Array(GRID * GRID);
  tintNoise = seededNoise(seed + ":tint");
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

  // clear any missiles/zombie projectiles/fx left over from the previous world
  for (const m of missiles) root.remove(m.mesh);
  missiles = [];
  for (const p of zombieProjectiles) {
    root.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
  }
  zombieProjectiles = [];
  for (const p of fx) {
    root.remove(p.obj);
    if (!p.obj.isSprite) p.obj.geometry?.dispose?.();
    p.obj.material?.map?.dispose?.();
    p.obj.material?.dispose?.();
  }
  fx = [];

  if (keepZombies) {
    // Fresh land, same population: keep every zombie (level, hp, eat-XP and
    // all) and just settle them onto the new ground where they stand. Score,
    // XP, blast unlocks — and the run itself (Heart damage, wave count) —
    // are untouched: this is a mid-run terrain shuffle, not a restart.
    currentSeaLevel = biome.seaLevel;
    currentSeed = seed;
    for (const m of monsters) {
      m.fightTarget = null;
      Object.assign(m, initVerticalState(m.x, m.z));
    }
    buildHeart(true); // re-seat the Heart on the new ground, keeping its HP
    reseatTurrets();
  } else {
    spawnMonsters(biome, currentHeights, seed);
    resetRun(); // every brand-new world is a brand-new run
  }
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

// "Locate strongest" — toggled from the HUD button instead of an always-on
// per-zombie aura. An always-on glow on every leveled-up zombie became
// useless once a few dozen were wandering around all wearing one at once;
// this instead calls out ONLY the single current highest level (ties
// included) on demand, with a rotating ring at its feet plus a tall beacon
// so it's spottable over trees/hills/other zombies from across the map.
//
// Added to `root`, NOT `monsterUiGroup` — that group is wiped by clearGroup()
// on every world regen (see spawnMonsters), which would leave this pool
// holding disposed objects. Like `highlightPool` above, these are
// regen-independent: just repositioned onto whichever zombie is currently
// the elite, every frame.
let locateEliteOn = false;
let eliteRingGeo = null;
const eliteMarkerPool = []; // { ring: Mesh, beam: Sprite }

function ensureEliteMarker(i) {
  while (eliteMarkerPool.length <= i) {
    const ring = new THREE.Mesh(eliteRingGeo, new THREE.MeshBasicMaterial({
      color: 0xff2a1a, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    ring.renderOrder = 995;
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    root.add(ring);

    const beam = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xff3a20, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    beam.renderOrder = 994;
    beam.visible = false;
    root.add(beam);

    eliteMarkerPool.push({ ring, beam });
  }
  return eliteMarkerPool[i];
}

function hideAllEliteMarkers() {
  for (const p of eliteMarkerPool) { p.ring.visible = false; p.beam.visible = false; }
}

function updateEliteMarkers(now) {
  if (!locateEliteOn || monsters.length === 0) { hideAllEliteMarkers(); return; }
  // Highlight every zombie tied for the current max level — even when that
  // max is 1 (everyone highlighted): the button means "show me the top", and
  // showing nothing when nobody has leveled up yet reads as broken.
  let maxLevel = 1;
  for (const m of monsters) if (m.stackLevel > maxLevel) maxLevel = m.stackLevel;
  let count = 0;
  for (const m of monsters) {
    if (m.stackLevel !== maxLevel) continue;
    const { ring, beam } = ensureEliteMarker(count++);
    ring.position.set(m.x, m.visualY + 0.05, m.z);
    ring.rotation.z = now * 1.8;
    const pulse = 1 + 0.15 * Math.sin(now * 3 + m.phase);
    ring.scale.setScalar(stackScale(m.stackLevel) * pulse);
    ring.visible = true;

    beam.position.set(m.x, m.visualY + hpBarOffset(m.stackLevel) + 1.6, m.z);
    beam.scale.set(0.7, 3.2, 1);
    beam.material.opacity = 0.65 + 0.15 * Math.sin(now * 3 + m.phase);
    beam.visible = true;
  }
  for (let i = count; i < eliteMarkerPool.length; i++) {
    eliteMarkerPool[i].ring.visible = false;
    eliteMarkerPool[i].beam.visible = false;
  }
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

  // Friendly fire: a blast landing near the Heart hurts it. Zombies swarm
  // the crystal, so the tempting "just nuke the pile on top of it" play has
  // a real cost — precision matters.
  if (heart && Math.hypot(bx - heart.x, bz - heart.z) <= maxUnlockedBlast + 1) {
    damageHeart(6);
    showToast("⚠️ You hit the Heart!");
  }

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
  const s = settings.shake ? shake : 0; // screen-shake can be disabled in settings
  const jx = (Math.random() - 0.5) * s;
  const jy = (Math.random() - 0.5) * s;
  const jz = (Math.random() - 0.5) * s;
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

  eliteRingGeo = new THREE.RingGeometry(0.55, 0.78, 28);

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
        // Free pan — no bounds. Digging has no floor, so the camera can't
        // have one either: clamping the target made deep pits and the map's
        // underside literally unviewable.
        const scale = 0.045 / zoomLevel;
        const fwd = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
        const right = new THREE.Vector3(-Math.sin(theta), 0, Math.cos(theta));
        target.addScaledVector(right, -dxPix * scale);
        target.addScaledVector(fwd, -dyPix * scale);
      } else {
        theta -= dxPix * 0.006;
        // Near-full vertical orbit: from almost level with the horizon (you
        // can look at the terrain edge-on, even slightly from below) to
        // almost straight down. Only an epsilon off the exact poles, where
        // the orbit math degenerates.
        phi = Math.min(1.55, Math.max(0.02, phi - dyPix * 0.006));
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
    // Practically unbounded zoom — wide enough to frame the whole map from
    // afar or fill the screen with a single block.
    zoomLevel = Math.min(40, Math.max(0.05, zoomLevel * factor));
    onResize();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    keys[e.key.toLowerCase()] = true;
    if (e.key.toLowerCase() === "r") regenerate(true);
    if (e.key.toLowerCase() === "p") togglePause();
  });
  window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });

  const seedInput = document.getElementById("vx-seed");
  const biomeSelect = document.getElementById("vx-biome");
  document.getElementById("vx-new").addEventListener("click", () => regenerate(true));
  seedInput.addEventListener("change", () => regenerate(false));
  biomeSelect.addEventListener("change", () => regenerate(false));

  const locateBtn = document.getElementById("vx-locate-elite");
  locateBtn.addEventListener("click", () => {
    locateEliteOn = !locateEliteOn;
    locateBtn.classList.toggle("active", locateEliteOn);
    if (!locateEliteOn) hideAllEliteMarkers();
  });

  // Tweaks sliders: `input` (not `change`) so values apply live while
  // dragging, each mirrored into its readout label.
  const bindSlider = (id, format, apply) => {
    const el = document.getElementById(id);
    const label = document.getElementById(id + "-val");
    el.addEventListener("input", () => {
      const v = Number(el.value);
      label.textContent = format(v);
      apply(v);
    });
  };
  bindSlider("vx-spawn-per-kill", (v) => String(v), (v) => { spawnsPerKill = v; });
  bindSlider("vx-spawn-per-eat", (v) => String(v), (v) => { spawnsPerEat = v; });
  bindSlider("vx-spawn-delay", (v) => String(v), (v) => { spawnDelay = v; });
  bindSlider("vx-speed-per-level", (v) => v.toFixed(2), (v) => {
    speedPerLevel = v;
    // Re-derive every living zombie's speed from its level so the new slope
    // applies immediately, not just to future spawns/level-ups.
    for (const m of monsters) m.speed = stackSpeed(m.stackLevel) + Math.random() * 0.2;
  });
  bindSlider("vx-sim-speed", (v) => v.toFixed(1), (v) => { simSpeed = v; });
  bindSlider("vx-hp-per-level", (v) => v.toFixed(2), (v) => {
    hpPerLevel = v;
    // Max HP just changed for everyone — heal all to their new full so no
    // zombie is left with hp above max (or unfairly half-dead vs a new scale).
    for (const m of monsters) m.hp = maxHpFor(m.stackLevel);
  });
  bindSlider("vx-dmg-per-level", (v) => v.toFixed(2), (v) => { dmgPerLevel = v; });
  bindSlider("vx-atk-per-level", (v) => v.toFixed(2), (v) => { atkPerLevel = v; });
  document.getElementById("vx-spawn-one").addEventListener("click", () => spawnRandomZombie());
  document.getElementById("vx-new-terrain").addEventListener("click", () => {
    const seedInput2 = document.getElementById("vx-seed");
    seedInput2.value = Math.random().toString(36).slice(2, 9);
    generateWorld(seedInput2.value, biomeSelect.value, true);
  });
  document.getElementById("vx-kill-all").addEventListener("click", () => {
    for (const m of monsters) {
      monsterGroup.remove(m.rig.root);
      disposeZombieMaterials(m.mats);
      disposeMonsterUi(m);
    }
    monsters = [];
    pendingSpawns = [];
    updateZombieBoard();
  });

  document.getElementById("vx-go-restart").addEventListener("click", () => regenerate(true));
  document.getElementById("vx-shop-repair").addEventListener("click", buyRepair);
  document.getElementById("vx-shop-turret").addEventListener("click", buyTurret);

  // Title screen: play, difficulty, settings — controls seeded from the
  // persisted settings so the menu reflects what's actually active.
  document.getElementById("vx-title-play").addEventListener("click", startFromTitle);
  for (const btn of document.querySelectorAll(".diff-btn")) {
    btn.classList.toggle("active", btn.dataset.diff === difficulty);
    btn.addEventListener("click", () => {
      difficulty = btn.dataset.diff;
      for (const b of document.querySelectorAll(".diff-btn")) b.classList.toggle("active", b === btn);
      saveSettings();
    });
  }
  const volumeEl = document.getElementById("vx-volume");
  volumeEl.value = String(settings.volume);
  volumeEl.addEventListener("input", () => {
    settings.volume = Number(volumeEl.value);
    setMasterVolume(settings.volume);
    saveSettings();
  });
  const shakeEl = document.getElementById("vx-shake-toggle");
  shakeEl.checked = settings.shake;
  shakeEl.addEventListener("change", () => {
    settings.shake = shakeEl.checked;
    saveSettings();
  });

  regenerate(false);
  showTitle(); // first visit lands on the menu, world idling behind it
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
  // No pan bounds — see the mouse-pan handler for why.

  shake *= Math.exp(-4.5 * dt);
  // On defeat or pause the sim freezes mid-tableau (no movement, fights,
  // spawns, or player shots) behind the overlay; camera stays free so the
  // frozen battlefield can still be orbited. Missiles/fx also freeze while
  // paused (a true pause), but keep playing out on defeat for drama.
  if (gameState === "playing") {
    processClickQueue();
    updateMonsters(dt * simSpeed, now);
    updateZombieCombat(dt * simSpeed);
    updateTurrets(dt * simSpeed);
    processPendingSpawns(now);
    updateWaves(dt * simSpeed);
  } else {
    clickQueue = [];
  }
  if (gameState !== "paused") {
    updateHeart(now);
    updateMissiles(dt);
    updateFx(dt);
  }
  updateCamera();
  renderer.render(scene, camera);
}

// The pre-run menu: world renders and idles behind it, sim frozen until
// Play. Doubles as the settings + difficulty screen.
function showTitle() {
  gameState = "menu";
  const meta = document.getElementById("vx-title-meta");
  if (meta) {
    let best = 0;
    try { best = Number(localStorage.getItem("vx-best-score") || 0); } catch { /* fresh */ }
    const unlocked = Object.keys(unlockedAchievements).length;
    meta.innerHTML =
      `Best score: <b>${best}</b> · Achievements: <b>${unlocked}/${Object.keys(ACHIEVEMENTS).length}</b>` +
      ` · Legacy shards: <b>${legacy.shards}</b>`;
  }
  document.getElementById("vx-title")?.classList.add("show");
}

function startFromTitle() {
  document.getElementById("vx-title")?.classList.remove("show");
  gameState = "playing";
  // Menu time doesn't count as survival, and difficulty may have changed —
  // rebuild the Heart at the (possibly rescaled) full HP and restart clocks.
  resetRun();
}

let pauseStartedAt = 0;
function togglePause() {
  if (gameState === "over" || gameState === "menu") return;
  const now = performance.now() / 1000;
  if (gameState === "paused") {
    gameState = "playing";
    runStartTime += now - pauseStartedAt; // paused time doesn't count as survival
  } else {
    gameState = "paused";
    pauseStartedAt = now;
  }
  document.getElementById("vx-paused")?.classList.toggle("show", gameState === "paused");
  updateShopHud();
}

// version.json is generated by the deploy workflow (stamped with the commit
// SHA at deploy time) and doesn't exist in the repo, so this is a no-op "dev"
// badge locally and shows the real deployed commit on GitHub Pages.
fetch("version.json", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((v) => {
    if (v?.commit) document.getElementById("vx-version-val").textContent = v.commit;
  })
  .catch(() => {});

init();
