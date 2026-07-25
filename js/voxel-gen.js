import * as THREE from "three";
import { buildBlockMaterials, disposeBlockMaterials, buildZombieMaterials, disposeZombieMaterials } from "./voxel-textures.js";
import {
  playExplosion, playZombieKill, playHeartHit, playWaveStart,
  playGameOver, playPurchase, playTurretShot, setMasterVolume, unlockAudio,
  playComboTick, playBossSpawn, playBossDown, playContractDone, playNewBest,
} from "./voxel-audio.js";
// All balance curves, progression costs, and game rules live in the pure
// core module (tested by tests/heartfall-core.test.mjs); this file supplies
// the live state (slider values, legacy ranks, clocks) at call time.
import * as core from "./heartfall-core.js";

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
// spawnsPerKill fresh zombies per player blast kill (default 1.1 = every
// kill replaces itself +10% chance of a bonus runt — the waves drive real
// escalation; see core.spawnsForKills for the fractional roll), and
// spawnsPerEat per zombie eaten by another zombie via resolveZombieKill()
// (default 1 = eats are population-neutral; 0 = the strong thin the herd).
// User-chosen slider values are settings, not artificial limits.
// USER-DIRECTED exception (not a cap): CONDENSATION. When any single stack
// level accumulates core.CONDENSE_THRESHOLD living zombies, that cohort
// fuses into half as many zombies of the NEXT level (see checkCondensation)
// — total strength keeps escalating forever, only the entity count is tamed
// so the renderer survives. Population totals remain uncapped.
const MONSTER_COUNT = 9;
const EAT_DIST = 0.85; // how close two zombies must be to fight (see updateZombieCombat)
const STARTING_MAX_BLAST = core.STARTING_MAX_BLAST;
// XP thresholds bank upgrade POINTS; the player chooses each one's boon
// (+1 radius or +1 damage). Costs escalate geometrically, no ceiling (core).
const upgradeUnlockCost = core.upgradeUnlockCost;

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
let blastDamage = core.STARTING_BLAST_DAMAGE;
// Upgrade points banked by XP vs spent through the radius/damage chooser.
let upgradesEarned = 0, upgradesChosen = 0;
let shake = 0;
let killCount = 0, xp = 0;
let lastBlastX = 0, lastBlastZ = 0;

/* ---------- horde mutations (run-long, stacking, announced) ---------- */
// The numeric side of core.MUTATION_POOL: multipliers layered onto the stat
// wrappers below, plus the three "effect" mutations (regen ticks in
// updateMonsters, volatile bursts in the death paths, bloom in
// resolveZombieKill). Reset every run.
let mut = { hpMul: 1, dmgMul: 1, speedMul: 1, regen: 0, reachMul: 1, volatile: 0, eatLure: 0 };
let mutationsApplied = []; // core.MUTATION_POOL entries, in strike order
let mutationCount = 0;
let mutationTimer = Infinity; // sim-time countdown to the next strike
let mutationSeedStr = "terra"; // set per run — daily boards share one sequence

let raycaster, missiles = [], fx = [];
let missileGeo, missileMat;
let highlightGeo, highlightOuterMat, highlightCoreMat, hoverClientX = null, hoverClientY = null;

/* ---------- The Heart: the thing you're defending ---------- */
// The game's objective. Zombies gravitate toward it and shoot it with the
// same projectiles they use on each other; when its HP reaches 0 the run
// ends. `stackLevel: 1` makes it a valid projectile target with zero armor
// (core.armorReduction(1) === 0) — every zombie always hurts the Heart in
// full, and armor never zeroes damage anywhere (see damageTakenMultiplier).
/* ---------- Legacy: permanent cross-run progression ---------- */
// Shards are earned every run (scaled by score) and spent on permanent
// perks from the game-over screen. This is the "one more run" hook: every
// defeat still banks progress toward stronger future runs.
let legacy = core.sanitizeLegacy(null);
function loadLegacy() {
  try {
    legacy = core.sanitizeLegacy(JSON.parse(localStorage.getItem("vx-legacy") || "{}"));
  } catch { /* fresh legacy */ }
}
function saveLegacy() {
  try { localStorage.setItem("vx-legacy", JSON.stringify(legacy)); } catch { /* private mode */ }
}
const legacyCost = core.legacyCost; // shards; grows per rank
loadLegacy();

/* ---------- difficulty, settings, achievements ---------- */

// Difficulty scales the Heart's durability and how fast pressure arrives.
// Chosen on the title screen; persists across sessions. `difficulty` is the
// EFFECTIVE difficulty of the current run; `chosenDifficulty` is the user's
// persisted preference — they differ only in Daily mode, which forces
// "normal" so every day's board is a level playing field.
const DIFFICULTIES = core.DIFFICULTIES;
let difficulty = "normal";
let chosenDifficulty = "normal";
// "ranked" = the scored game: Tweaks are locked to canonical balance and the
// run banks best-score / achievements / Legacy shards. "daily" = ranked
// rules on the one fixed world all players share that day (UTC), with its
// own per-day scoreboard and a play streak. "sandbox" = free play: every
// Tweak is unlocked but NOTHING is saved. Chosen on the title screen,
// persisted across sessions. This is the wall that stops a doctored run from
// laundering easy progress into permanent meta-progression.
let mode = "ranked";

/* ---------- daily challenge state ---------- */
let daily = core.sanitizeDaily(null);
function loadDaily() {
  try { daily = core.sanitizeDaily(JSON.parse(localStorage.getItem("vx-daily") || "{}")); } catch { /* fresh */ }
}
function saveDaily() {
  try { localStorage.setItem("vx-daily", JSON.stringify(daily)); } catch { /* private mode */ }
}
loadDaily();
function todayStr() { return core.dayString(new Date()); }

/* ---------- lifetime stats ---------- */
let lifeStats = core.sanitizeStats(null);
function loadStats() {
  try { lifeStats = core.sanitizeStats(JSON.parse(localStorage.getItem("vx-stats") || "{}")); } catch { /* fresh */ }
}
function saveStats() {
  try { localStorage.setItem("vx-stats", JSON.stringify(lifeStats)); } catch { /* private mode */ }
}
loadStats();

// Fold the finished (or abandoned) run into the lifetime stats — called on
// defeat AND on quitting to the title, guarded so a run never double-counts
// and sandbox runs never count at all.
let runStatsFlushed = false;
function flushRunStats() {
  if (runStatsFlushed || mode === "sandbox") return;
  const now = performance.now() / 1000;
  // While paused, the pause span hasn't been folded into runStartTime yet.
  const survived = Math.max(0, (gameState === "paused" ? pauseStartedAt : now) - runStartTime);
  // A run with no kills and no waves never really started — the idle world
  // behind the title screen must not count as a run (its clock has been
  // running since page load).
  if (killCount === 0 && waveNumber === 0) return;
  runStatsFlushed = true;
  lifeStats.runs++;
  lifeStats.kills += killCount;
  lifeStats.bosses += bossesKilledThisRun;
  lifeStats.totalWaves += waveNumber;
  if (waveNumber > lifeStats.bestWave) lifeStats.bestWave = waveNumber;
  lifeStats.timePlayed += survived;
  if (mode === "daily") lifeStats.dailies++;
  lifeStats.contractsDone += contracts.filter((c) => c.done).length;
  if (runMaxCombo > lifeStats.bestCombo) lifeStats.bestCombo = runMaxCombo;
  saveStats();
  if (lifeStats.kills >= 1000) unlockAchievement("kills-1000");
}

function heartMaxHp() {
  return core.heartMaxHp(legacy.heartRank, difficulty);
}

const settings = { volume: 1, shake: true };

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("vx-settings") || "{}");
    if (typeof saved.volume === "number") settings.volume = saved.volume;
    if (typeof saved.shake === "boolean") settings.shake = saved.shake;
    if (DIFFICULTIES[saved.difficulty]) chosenDifficulty = saved.difficulty;
    if (saved.mode === "ranked" || saved.mode === "sandbox" || saved.mode === "daily") mode = saved.mode;
  } catch { /* defaults */ }
  difficulty = chosenDifficulty;
  setMasterVolume(settings.volume);
}
function saveSettings() {
  try {
    localStorage.setItem("vx-settings", JSON.stringify({ ...settings, difficulty: chosenDifficulty, mode }));
  } catch { /* private mode */ }
}
loadSettings();

// Lightweight local achievements: unlocked once, persisted, announced with a
// toast. Checked at the moments their stats change, not polled. The table
// itself lives in core (shared with tests and the Steam bridge).
const ACHIEVEMENTS = core.ACHIEVEMENTS;
let unlockedAchievements = {};
try { unlockedAchievements = JSON.parse(localStorage.getItem("vx-achievements") || "{}"); } catch { /* none */ }

function unlockAchievement(key) {
  if (mode === "sandbox") return; // sandbox runs never earn achievements
  if (unlockedAchievements[key]) return;
  unlockedAchievements[key] = true;
  try { localStorage.setItem("vx-achievements", JSON.stringify(unlockedAchievements)); } catch { /* oh well */ }
  // Desktop builds bridge unlocks to Steamworks via the Electron preload
  // (steam/preload.js); on the plain web build the bridge doesn't exist.
  try { window.heartfallBridge?.unlockAchievement?.(key); } catch { /* web build */ }
  showToast(ACHIEVEMENTS[key]);
  playPurchase(); // reuse the reward chime
}
let heart = null; // { isHeart, x, z, y, visualY, stackLevel, hp, group, crystal, glow, light }
let gameState = "playing"; // "playing" | "paused" | "over"
let waveNumber = 0, waveTimer = 18, trickleTimer = 5;
let runStartTime = 0; // seconds (performance.now() clock) when the current run began
let lastHeartHitSound = 0; // throttle: a swarm chips the Heart every frame, the alarm shouldn't

/* ---------- kill combos ---------- */
// Chained player kills inside a rolling window (core.COMBO_WINDOW) build a
// combo that multiplies every kill's XP/energy payout — the moment-to-moment
// "keep the streak alive" hook. Uncapped, like everything else here.
let combo = { count: 0, expiresAt: -Infinity };
let runMaxCombo = 0;

// Registers `kills` player kills right now and returns the payout
// multiplier those kills earn (the kills count toward their own combo, so
// one huge blast pays out at its own full chain).
function registerPlayerKills(kills) {
  const now = performance.now() / 1000;
  combo = core.applyCombo(combo, kills, now, core.comboWindow(legacy.comboRank));
  if (combo.count > runMaxCombo) runMaxCombo = combo.count;
  if (combo.count >= 10) unlockAchievement("combo-10");
  if (combo.count >= 2) playComboTick(combo.count);
  return core.comboMultiplier(combo.count);
}

function updateComboHud(now) {
  const el = document.getElementById("vx-combo");
  if (!el) return;
  const active = gameState === "playing" && combo.count >= 2 && now < combo.expiresAt;
  el.classList.toggle("active", active);
  if (!active) return;
  const val = document.getElementById("vx-combo-val");
  const mult = document.getElementById("vx-combo-mult");
  const fill = document.getElementById("vx-combo-fill");
  if (val) val.textContent = `×${combo.count}`;
  if (mult) mult.textContent = `payout ×${core.comboMultiplier(combo.count).toFixed(2)}`;
  // Killing Spree ranks widen the window, so the bar must drain over the
  // player's ACTUAL window, not the base one.
  const comboSpan = core.comboWindow(legacy.comboRank);
  if (fill) fill.style.width = `${Math.max(0, Math.min(1, (combo.expiresAt - now) / comboSpan)) * 100}%`;
}

/* ---------- per-run counters (feed the contracts system) ---------- */
// Shape defined in core (freshRunCounters) so contractProgress can read it.
let runCounters = core.freshRunCounters();

function noteContractKill(source, level) {
  runCounters.kills++;
  if (level > runCounters.maxLevelKilled) runCounters.maxLevelKilled = level;
  if (source === "mine") runCounters.mineKills++;
  else if (source === "turret") runCounters.turretKills++;
  checkContracts();
}

function noteBlastKills(kills, maxLevel) {
  runCounters.kills += kills;
  if (kills > runCounters.maxBlastKills) runCounters.maxBlastKills = kills;
  if (maxLevel > runCounters.maxLevelKilled) runCounters.maxLevelKilled = maxLevel;
  checkContracts();
}

/* ---------- run drama: personal-best + close-call tracking ---------- */
let bestAtRunStart = 0; // the score to beat when the run began (0 = none)
let newBestShown = false; // fanfare fires once per run
let lowestHeartFrac = 1; // the closest the Heart came to dying this run

// Fires the "new personal best" fanfare the moment a scored run overtakes
// the previous record — called from the score-changing paths, cheap.
function maybeCelebrateNewBest() {
  if (newBestShown || mode === "sandbox" || bestAtRunStart <= 0 || gameState !== "playing") return;
  const survived = performance.now() / 1000 - runStartTime;
  if (runScore(survived) > bestAtRunStart) {
    newBestShown = true;
    showToast("🏆 NEW PERSONAL BEST!");
    playNewBest();
  }
}

// ⚡ Energy: the run's spendable currency, earned 1:1 with XP from kills but
// tracked separately — XP is a run-long total that banks upgrade points
// and must never decrease, while energy is drained by shop purchases.
let energy = 0;
let repairCost = core.SHOP.repair.base, turretCost = core.SHOP.turret.base,
  frostCost = core.SHOP.frost.base, arcCost = core.SHOP.arc.base,
  lanceCost = core.SHOP.lance.base,
  mineCost = core.SHOP.mine.base, slowCost = core.SHOP.slow.base,
  wardCost = core.SHOP.ward.base;
let turrets = []; // { kind, x, z, y, group, head, cooldown, aura }
let turretBolts = []; // { mesh, target }
// 🛡️ Ward purchases this run — each one consecrates more ground around the
// Heart that fresh zombies may not spawn on (core.sanctuaryRadius).
let wardRank = 0;
let sanctuaryRing = null; // terrain-following outline of the consecrated edge
let mines = []; // { x, z, mesh }
let slowUntil = 0; // seconds (performance.now() clock) the Heart slow-field stays active
let slowDome = null; // translucent dome visual while the field is up
const SLOW_RADIUS = 6, SLOW_FACTOR = 0.4, SLOW_DURATION = 15;

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
  const frac = Math.max(0, heart.hp) / heartMaxHp();
  if (frac < lowestHeartFrac) lowestHeartFrac = frac;
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
//
// `tier` picks the BODY PLAN (core.EVOLUTION_FORMS): since drawn size is now
// capped at ×5, a monster that outgrows the cap metamorphoses instead of
// continuing to inflate, and what tells you it's dangerous is its shape.
// Each plan is built from the same voxel vocabulary as the walker (boxes,
// cones, one glowing core) so nothing looks imported from another game, and
// every plan keeps the same four pivots so the walk cycle is plan-agnostic.
//
// Accent geometry/materials are unique per rig, so they're tracked in
// `ownMats` and torn down by disposeRig.
function createZombieMesh(mats, tier = 0) {
  const grp = new THREE.Group();
  const ownMats = [];
  const form = core.evolutionForm(tier);

  // Higher tiers than the last authored plan keep escalating their glow, so
  // a tier-7 Abomination still reads as worse than a tier-3 one.
  const overTier = Math.max(0, tier - (core.EVOLUTION_FORMS.length - 1));
  const glow = Math.min(3, 1 + overTier * 0.5);

  // Accent material for horns, plates, spines and cores: emissive so the
  // silhouette stays readable against dark terrain at any zoom.
  function accent(color, emissive) {
    const m = new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: glow });
    ownMats.push(m);
    return m;
  }

  const heavy = form.key === "colossus" || form.key === "abomination";
  const torsoW = heavy ? 0.68 : form.key === "revenant" ? 0.46 : 0.5;
  const torsoH = heavy ? 0.72 : 0.65;
  const armLen = form.key === "revenant" ? 0.72 : 0.55;

  const torsoGeo = new THREE.BoxGeometry(torsoW, torsoH, heavy ? 0.36 : 0.28);
  const headGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
  const armGeo = new THREE.BoxGeometry(heavy ? 0.22 : 0.16, armLen, heavy ? 0.22 : 0.16);
  const legGeo = new THREE.BoxGeometry(heavy ? 0.26 : 0.18, 0.6, heavy ? 0.26 : 0.18);

  const hipY = 0.6, shoulderY = hipY + torsoH, headY = shoulderY + 0.21;

  const torso = new THREE.Mesh(torsoGeo, mats.clothes);
  torso.position.set(0, hipY + torsoH / 2, 0);
  grp.add(torso);

  // head faces +z; front face gets the eyes/mouth texture, rest get skin
  const headMats = [mats.skin, mats.skin, mats.skin, mats.skin, mats.face, mats.skin];
  const head = new THREE.Mesh(headGeo, headMats);
  head.position.set(0, headY, 0);
  grp.add(head);

  function makeLimb(geo, mat, side, pivotY, length, spread) {
    const pivot = new THREE.Group();
    pivot.position.set(side * spread, pivotY, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, -length / 2, 0);
    pivot.add(mesh);
    grp.add(pivot);
    return pivot;
  }

  const armSpread = torsoW / 2 + (heavy ? 0.13 : 0.09);
  const armL = makeLimb(armGeo, mats.skin, -1, shoulderY, armLen, armSpread);
  const armR = makeLimb(armGeo, mats.skin, 1, shoulderY, armLen, armSpread);
  const legL = makeLimb(legGeo, mats.clothes, -1, hipY, 0.6, torsoW * 0.28);
  const legR = makeLimb(legGeo, mats.clothes, 1, hipY, 0.6, torsoW * 0.28);

  armL.rotation.x = armR.rotation.x = -1.15; // zombie arms-forward idle pose

  // ---- per-form ornaments ----

  if (form.key === "revenant") {
    // Horns and a hunch: the first thing that stops being a person.
    const hornMat = accent(0x2a1a26, 0xff4a2a);
    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.34, 5), hornMat);
      horn.position.set(side * 0.15, headY + 0.32, -0.02);
      horn.rotation.z = side * 0.42;
      grp.add(horn);
    }
    const mantle = new THREE.Mesh(new THREE.BoxGeometry(torsoW + 0.22, 0.12, 0.36), accent(0x1d1420, 0x3a0f22));
    mantle.position.set(0, shoulderY + 0.02, 0);
    grp.add(mantle);
    torso.rotation.x = 0.16; // hunched forward
  }

  if (heavy) {
    // Plated shoulders and a crown of spines: a siege engine with a face.
    const plateMat = accent(0x2f3a46, 0x1a3a4e);
    for (const side of [-1, 1]) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 0.4), plateMat);
      pad.position.set(side * (torsoW / 2 + 0.06), shoulderY - 0.02, 0);
      grp.add(pad);
    }
    const spineMat = accent(0x1a2028, 0xff7a2a);
    for (let i = -2; i <= 2; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.26, 4), spineMat);
      spike.position.set(i * 0.11, headY + 0.26, -0.04);
      spike.rotation.z = i * 0.16;
      grp.add(spike);
    }
  }

  if (form.key === "abomination") {
    // A second pair of arms and a burning core — the point at which the
    // thing stops pretending to have been human.
    const lowerY = hipY + torsoH * 0.42;
    const armL2 = makeLimb(armGeo, mats.skin, -1, lowerY, armLen, armSpread + 0.06);
    const armR2 = makeLimb(armGeo, mats.skin, 1, lowerY, armLen, armSpread + 0.06);
    armL2.rotation.x = -0.5; armR2.rotation.x = -0.5;
    armL2.rotation.z = -0.35; armR2.rotation.z = 0.35;
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffb040, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    ownMats.push(coreMat);
    const heart2 = new THREE.Mesh(new THREE.OctahedronGeometry(0.17), coreMat);
    heart2.position.set(0, hipY + torsoH * 0.65, 0.2);
    grp.add(heart2);
  }

  return { root: grp, armL, armR, legL, legR, tier, ownMats };
}

// Tears down one rig's geometry and its per-rig accent materials. The
// skin/face/clothes materials are NOT touched here: they belong to the
// monster (see disposeZombieMaterials) and survive a metamorphosis.
function disposeRig(rig) {
  if (!rig) return;
  rig.root.traverse((o) => o.geometry?.dispose?.());
  for (const m of rig.ownMats || []) m.dispose();
}

/* ---------- metamorphosis ---------- */
// The moment a monster's level pushes its drawn size past the ×5 cap, it
// doesn't get bigger — it becomes something else (core.evolutionOf). This
// is called after every level-up; it's a no-op until a tier boundary is
// crossed, and then it re-forms the body, burns a shockwave, and announces
// the first sighting of each form in the run.
let formsSeenThisRun = new Set();
let lastMetamorphToast = -Infinity;

function maybeMetamorphose(m) {
  if (!m || !monsters.includes(m)) return;
  const tier = core.evolutionTier(m.stackLevel);
  if (tier === m.tier) return;
  m.tier = tier;
  remeshZombie(m, tier);
  m.eatPulse = 0.3;
  const form = core.evolutionForm(tier);
  spawnEatFx(m.x, heightAt(m.x, m.z) + 1, m.z);
  shake = Math.min(4.5, shake + 0.5);
  // Loud once per form per run: a wall of banners would be noise, but the
  // first Colossus of a run genuinely is the news of the minute.
  if (!formsSeenThisRun.has(form.key)) {
    formsSeenThisRun.add(form.key);
    playBossSpawn();
    showBanner("mut", "🧬 METAMORPHOSIS", `${form.icon} ${form.name}`,
      `${form.desc} — a level ${m.stackLevel} zombie has outgrown its body`);
  } else {
    // Throttled: deep in a run dozens of zombies cross a tier in the same
    // minute, and a toast per body would strobe the HUD into uselessness.
    const now = performance.now() / 1000;
    if (now - lastMetamorphToast > 6) {
      lastMetamorphToast = now;
      showToast(`${form.icon} A zombie re-forms into a ${form.name}!`);
    }
  }
  updateZombieBoard();
}

// A monster has outgrown its body plan: swap the rig in place, keeping its
// position, facing and animation phase. Called from the level-up path.
function remeshZombie(m, tier) {
  const prev = m.rig;
  monsterGroup.remove(prev.root);
  disposeRig(prev);
  m.rig = createZombieMesh(m.mats, tier);
  monsterGroup.add(m.rig.root);
  m.rig.root.position.copy(prev.root.position);
  m.rig.root.rotation.y = m.angle;
  m.rig.root.scale.copy(prev.root.scale);
}

function spawnMonsters(biome, heights, seed) {
  if (monsterGroup) {
    // clearGroup disposes geometry and top-level materials, but a rig's
    // accent materials hang off nested meshes — disposeRig gets those.
    for (const m of monsters) { disposeRig(m.rig); disposeZombieMaterials(m.mats); }
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
      // The idle world that greets the player is plain walkers — breeds are
      // an escalation the waves bring in (see core.rollArchetype).
      arch: core.ARCHETYPES.walker, frostTick: 0, tier: 0,
      ...initVerticalState(x, z),
      ...createMonsterUi(),
    });
  }
  updateScoreHud();
  updateZombieBoard();
}

// Creates one zombie at an exact spot. Shared by random/invasion spawns and
// by condensation (which re-spawns fused survivors where their cohort stood).
// `arch` defaults to a wave-scaled roll (core.rollArchetype) — pass one
// explicitly for spawns that shouldn't be breed-diverse (bosses, and the
// cohorts that come out of a condensation, which are pure mass).
function spawnZombieAt(x, z, level = 1, isBoss = false, arch = null) {
  const mats = buildZombieMaterials(currentSeed, monsterIdCounter++);
  const breed = arch || (isBoss ? core.ARCHETYPES.walker : core.rollArchetype(waveNumber));
  tintZombie(mats, breed);
  // A high-level spawn (condensation, a boss) is BORN in its evolved form.
  const tier = core.evolutionTier(level);
  const rig = createZombieMesh(mats, tier);
  monsterGroup.add(rig.root);
  // Bosses stalk rather than sprint — their level's full stackSpeed would be
  // comical, so it's damped (core.BOSS_SPEED_FACTOR).
  const speed = isBoss
    ? stackSpeed(level) * core.BOSS_SPEED_FACTOR
    : (stackSpeed(level) + Math.random() * 0.2) * breed.speed;
  const m = {
    rig, mats, x, z, isBoss, arch: breed,
    angle: Math.random() * Math.PI * 2,
    speed,
    timer: Math.random() * 2,
    phase: Math.random() * Math.PI * 2,
    walkPhase: Math.random() * Math.PI * 2,
    hp: 1, stackLevel: level, eatXp: 0, eatPulse: 0, fightTarget: null, attackTimer: 0,
    frostTick: 0, // seconds until this body takes its next chill tick
    tier, // body plan currently rendered — see remeshZombie
    ...initVerticalState(x, z),
    ...createMonsterUi(),
  };
  m.hp = maxHpFor(m); // breed HP multiplier needs the monster, not just its level
  monsters.push(m);
  noteBreedSeen(breed);
}

// The breed's tell: its tint multiplies the (already textured) skin and
// clothes materials, so a Brute reads as slate-blue and a Runner as hot
// orange at any zoom without a second texture set.
function tintZombie(mats, breed) {
  if (!breed.tint) return;
  mats.skin.color.setHex(breed.tint);
  mats.face.color.setHex(breed.tint);
  mats.clothes.color.setHex(breed.tint);
}

// Achievement bookkeeping: meeting all three special breeds in one run.
let breedsSeen = new Set();
function noteBreedSeen(breed) {
  if (breed.key === "walker" || breedsSeen.has(breed.key)) return;
  breedsSeen.add(breed.key);
  if (core.SPECIAL_ARCHETYPES.every((k) => breedsSeen.has(k))) unlockAchievement("menagerie");
}

// Spawns one fresh zombie at a random valid spot — used to replace a killed
// one. `level` > 1 (with isBoss) spawns a pre-evolved boss instead.
// Non-boss spawns are lifted to the condensation ratchet's minimum level
// (bosses already outlevel it and keep their story-scaled level).
function spawnRandomZombie(atEdge = false, level = 1, isBoss = false) {
  if (!isBoss) level = Math.max(level, minSpawnLevel);
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
    // Consecrated ground: nothing materializes inside the Sanctuary, so the
    // horde always has to cross open ground to reach the Heart.
    if (h > biome.seaLevel && h < biome.snowLine && !insideSanctuary(x, z)) break;
  }
  // Last resort (a wide Ward can leave few legal tiles): shove the spot
  // radially out past the Sanctuary edge rather than spawning on the Heart.
  if (insideSanctuary(x, z)) ({ x, z } = pushOutOfSanctuary(x, z));
  spawnZombieAt(x, z, level, isBoss);
  updateZombieBoard();
}

/* ---------- the Sanctuary: no-spawn ground around the Heart ---------- */

function sanctuaryRadius() { return core.sanctuaryRadius(wardRank, legacy.groundRank); }

function insideSanctuary(x, z) {
  if (!heart) return false;
  return Math.hypot(x - heart.x, z - heart.z) < sanctuaryRadius();
}

// Slides (x,z) straight out to the Sanctuary edge, then clamps it back
// inside the map — on a fully-consecrated map the horde ends up trickling in
// from the corners, which is a fair consequence of paying for that much Ward.
function pushOutOfSanctuary(x, z) {
  const dx = x - heart.x, dz = z - heart.z;
  const d = Math.hypot(dx, dz) || 1;
  const r = sanctuaryRadius() + 0.5;
  const ux = d > 0.001 ? dx / d : Math.sin(Math.random() * Math.PI * 2);
  const uz = d > 0.001 ? dz / d : Math.cos(Math.random() * Math.PI * 2);
  return {
    x: Math.max(3, Math.min(GRID - 3, heart.x + ux * r)),
    z: Math.max(3, Math.min(GRID - 3, heart.z + uz * r)),
  };
}

// A dotted outline of the consecrated edge, sampled onto the terrain so it
// hugs hills instead of slicing through them. Rebuilt whenever the radius or
// the ground changes; hidden entirely on the title screen's idle world.
function rebuildSanctuaryRing() {
  clearSanctuaryRing();
  if (!heart) return;
  const r = sanctuaryRadius();
  const pts = [];
  const steps = 128;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const x = heart.x + Math.sin(a) * r;
    const z = heart.z + Math.cos(a) * r;
    pts.push(new THREE.Vector3(x, heightAt(x, z) + 0.62, z));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineDashedMaterial({
    color: wardRank > 0 ? 0xffd782 : 0x7fd6ff, dashSize: 0.7, gapSize: 0.5,
    transparent: true, opacity: wardRank > 0 ? 0.75 : 0.4, depthWrite: false,
  });
  sanctuaryRing = new THREE.Line(geo, mat);
  sanctuaryRing.computeLineDistances(); // dashes need per-vertex arc length
  root.add(sanctuaryRing);
}

// Blasts chew the ground the ring is drawn on, so its heights are re-sampled
// on a slow timer (twice a second) rather than rebuilt — mutating the
// existing buffer keeps this off the allocation path entirely.
let sanctuaryRingTimer = 0;
function refreshSanctuaryRingHeights(dt) {
  if (!sanctuaryRing) return;
  sanctuaryRingTimer -= dt;
  if (sanctuaryRingTimer > 0) return;
  sanctuaryRingTimer = 0.5;
  const pos = sanctuaryRing.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)) + 0.62);
  }
  pos.needsUpdate = true;
}

function clearSanctuaryRing() {
  if (!sanctuaryRing) return;
  root.remove(sanctuaryRing);
  sanctuaryRing.geometry.dispose();
  sanctuaryRing.material.dispose();
  sanctuaryRing = null;
}

/* ---------- condensation: 200 of a level fuse into 100 of the next ---------- */
// The user-directed pressure valve on entity count (see the note by
// MONSTER_COUNT): the moment any stack level holds CONDENSE_THRESHOLD living
// non-boss zombies, the whole cohort fuses — all are removed, and half as
// many spawn at level+1 in the places where they stood. No payouts, no
// combo, no respawn rolls: it's a merge, not a kill, so it never feeds the
// player economy or the spawn loops. Bosses never fuse (they're story
// beats with bounties, not biomass).
// A fusion also RATCHETS the run: once level X condenses, fresh spawns
// enter at level X+1 minimum — the world as a whole outgrows its larva
// stage. Resets to 1 with each new run.
let minSpawnLevel = 1;

function checkCondensation() {
  if (monsters.length < core.CONDENSE_THRESHOLD) return; // cheap early-out
  const byLevel = new Map();
  for (const m of monsters) {
    if (m.isBoss) continue;
    let group = byLevel.get(m.stackLevel);
    if (!group) byLevel.set(m.stackLevel, (group = []));
    group.push(m);
  }
  let fused = false;
  for (const [level, group] of byLevel) {
    if (group.length < core.CONDENSE_THRESHOLD) continue;
    fused = true;
    const survivors = core.condenseSurvivors(group.length);
    const doomed = new Set(group);
    for (const m of group) {
      monsterGroup.remove(m.rig.root);
      disposeRig(m.rig);
      disposeZombieMaterials(m.mats);
      disposeMonsterUi(m);
    }
    monsters = monsters.filter((m) => !doomed.has(m));
    // Fused survivors rise where every other cohort member stood; the fx
    // burst covers only a sample — hundreds of shockwaves would melt the
    // frame budget (cosmetic thinning only, the spawns themselves are exact).
    for (let i = 0; i < survivors; i++) {
      const src = group[Math.min(group.length - 1, i * 2)];
      // A fusion melts breeds together — what rises is undifferentiated mass.
      spawnZombieAt(src.x, src.z, level + 1, false, core.ARCHETYPES.walker);
      if (i < 20) spawnEatFx(src.x, heightAt(src.x, src.z) + 1, src.z);
    }
    // Newborns pulse so the fusion reads as an event, not a glitch.
    for (let i = monsters.length - survivors; i < monsters.length; i++) monsters[i].eatPulse = 0.3;
    minSpawnLevel = core.condenseFloor(minSpawnLevel, level);
    showBanner("fuse", "⚗️ CRITICAL MASS", `${group.length} × Lv ${level} CONDENSE`,
      `${survivors} level-${level + 1} zombies rise — fresh spawns now start at Lv ${minSpawnLevel}`);
    unlockAchievement("critical-mass");
    playBossSpawn();
    shake = Math.min(4.5, shake + 1.2);
  }
  if (fused) updateZombieBoard();
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
    waveTimer = core.waveDelay(waveNumber, DIFFICULTIES[difficulty].wave);
    const count = core.waveSpawnCount(waveNumber);
    for (let i = 0; i < count; i++) spawnRandomZombie(true);
    // Every 5th wave a boss stalks in from the rim on top of the batch — a
    // pre-evolved elite with a bounty on its head (paid on a PLAYER kill).
    if (core.isBossWave(waveNumber)) {
      const bossLevel = core.bossLevelForWave(waveNumber);
      spawnRandomZombie(true, bossLevel, true);
      playBossSpawn();
      showToast(`☠️ BOSS WAVE ${waveNumber} — a level ${bossLevel} colossus approaches! Bounty: ${core.fmtNum(core.bossBounty(bossLevel))}⚡`);
    } else {
      playWaveStart();
      // Surviving a wave transition on a sliver of HP is a story moment —
      // call it out instead of letting it blur past.
      const frac = heart ? Math.max(0, heart.hp) / heartMaxHp() : 1;
      showToast(frac < 0.12
        ? `💦 Wave ${waveNumber} — the Heart barely holds at ${Math.max(1, Math.round(frac * 100))}%!`
        : `🌊 Wave ${waveNumber} — ${count} invaders!`);
    }
    if (waveNumber >= 5) unlockAchievement("wave-5");
    if (waveNumber >= 10) unlockAchievement("wave-10");
    if (waveNumber >= 15) unlockAchievement("wave-15");
    if (waveNumber >= 20) unlockAchievement("wave-20");
    maybeCelebrateNewBest();
    checkContracts(); // reach-wave / no-repair contracts tick on wave starts
    updateHeartHud();
  }
  trickleTimer -= dt;
  if (trickleTimer <= 0) {
    trickleTimer = core.trickleDelay(waveNumber, DIFFICULTIES[difficulty].trickle);
    spawnRandomZombie(true);
  }
}

function runScore(survivalSeconds) {
  return core.runScore(survivalSeconds, killCount);
}

function endRun() {
  gameState = "over";
  updateUpgradeChooser(); // any banked-but-unspent points die with the run
  const now = performance.now() / 1000;
  const survived = now - runStartTime;
  let maxLevel = 1;
  for (const m of monsters) if (m.stackLevel > maxLevel) maxLevel = m.stackLevel;
  const score = runScore(survived);

  playGameOver();

  // A last blast of drama at the Heart as it shatters.
  if (heart) {
    spawnEatFx(heart.x, heart.y + 1, heart.z);
    shake = 4.5;
  }

  const stats = document.getElementById("vx-go-stats");
  const mins = Math.floor(survived / 60), secs = Math.round(survived % 60);
  const contractsDone = contracts.filter((c) => c.done).length;
  const closest = lowestHeartFrac >= 1
    ? "untouched"
    : `${Math.max(0, Math.round(lowestHeartFrac * 100))}% HP`;
  const line1 =
    `Survived <b>${mins}m ${secs}s</b> across <b>${waveNumber}</b> waves<br>` +
    `Zombies destroyed: <b>${core.fmtNum(killCount)}</b> · Strongest evolved: <b>Lvl ${maxLevel}</b><br>` +
    `Best combo: <b>×${runMaxCombo}</b> · Bosses slain: <b>${bossesKilledThisRun}</b> · ` +
    `Mutations endured: <b>${mutationCount}</b><br>` +
    `Contracts: <b>${contractsDone}/3</b> · Closest call: <b>${closest}</b>`;

  flushRunStats();

  if (mode === "sandbox") {
    // Free play banks nothing: no best-score, no shards, no Legacy shop.
    if (stats) stats.innerHTML = `${line1}<br><span class="go-sandbox">🧪 Sandbox run — nothing saved</span>`;
    const shop = document.getElementById("vx-legacy-shop");
    if (shop) shop.innerHTML = "";
  } else {
    // Ranked and Daily both bank shards + achievements; they differ only in
    // which scoreboard the run posts to.
    let scoreLine;
    if (mode === "daily") {
      daily = core.recordDailyScore(daily, todayStr(), score);
      saveDaily();
      scoreLine =
        `Score: <b>${core.fmtNum(score)}</b> · <span class="go-best">Today's best: ${core.fmtNum(daily.todayBest)}</span>` +
        ` · 🔥 <b>${daily.streak}</b>-day streak`;
    } else {
      let best = 0;
      try {
        best = Number(localStorage.getItem("vx-best-score") || 0);
        if (score > best) { best = score; localStorage.setItem("vx-best-score", String(score)); }
      } catch { /* storage may be unavailable; the run still ends cleanly */ }
      scoreLine = `Score: <b>${core.fmtNum(score)}</b> · <span class="go-best">Best: ${core.fmtNum(best)}</span>`;
    }

    // Bank Legacy shards — every defeat still buys future power. Shard
    // Magnet ranks fatten the payout.
    const shardsEarned = core.shardsForScore(score, legacy.shardRank);
    legacy.shards += shardsEarned;
    saveLegacy();

    if (stats) stats.innerHTML =
      `${line1}<br>` +
      `${scoreLine}<br>` +
      `🔮 Shards earned: <b>+${core.fmtNum(shardsEarned)}</b>`;
    renderLegacyShop();
  }

  document.getElementById("vx-gameover")?.classList.add("show");
  updateHeartHud();
}

// The permanent-upgrade storefront on the defeat screen. Perks apply from
// the NEXT run on; buying re-renders in place so shards can be chain-spent.
const LEGACY_PERKS = core.LEGACY_PERKS;

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
  el.innerHTML = `<div class="legacy-title">🔮 Legacy — ${core.fmtNum(legacy.shards)} shards</div>${rows}`;
  for (const btn of el.querySelectorAll(".legacy-buy")) {
    btn.addEventListener("click", () => {
      const perk = LEGACY_PERKS[Number(btn.dataset.perk)];
      const cost = legacyCost(legacy[perk.key]);
      if (legacy.shards < cost) return;
      legacy.shards -= cost;
      legacy[perk.key]++;
      saveLegacy();
      if (core.legacyTotalRanks(legacy) >= 5) unlockAchievement("legacy-5");
      playPurchase();
      renderLegacyShop();
    });
  }
}

/* ---------- contracts: three optional objectives per run ---------- */
// The variable-reward loop: each contract pays out the moment it completes
// (energy immediately; shards banked too on scored runs), and clearing all
// three pays a bonus. Drawn seeded — normal runs reroll each run, while a
// daily's three contracts are the same for the whole day (its world seed is
// the day itself, no nonce).
let contracts = []; // [{ key, icon, kind, target, label, done }]
let contractsAllDone = false;
let contractRunNonce = 0;

function resetContractsForRun() {
  runCounters = core.freshRunCounters();
  contractsAllDone = false;
  contractRunNonce++;
  const seedStr = mode === "daily" ? currentSeed : `${currentSeed}:run${contractRunNonce}`;
  contracts = core.generateContracts(seedStr).map((c) => ({ ...c, done: false }));
  // The horde's mutation sequence shares the contracts' seeding scheme, so a
  // daily's mutations are the same for everyone playing that day's board.
  mutationSeedStr = seedStr;
  renderContracts();
}

function checkContracts() {
  if (contracts.length === 0 || gameState !== "playing") return;
  runCounters.wave = waveNumber;
  if (energy > runCounters.maxEnergy) runCounters.maxEnergy = energy;
  let all = true;
  for (const c of contracts) {
    if (!c.done && core.contractDone(c, runCounters)) {
      c.done = true;
      energy += core.CONTRACT_REWARD.energy;
      if (energy >= 500) unlockAchievement("rich"); // payout can cross the War Chest line
      let msg = `📜 ${c.label} — +${core.CONTRACT_REWARD.energy}⚡`;
      if (mode !== "sandbox") {
        legacy.shards += core.CONTRACT_REWARD.shards;
        saveLegacy();
        msg += ` +${core.CONTRACT_REWARD.shards}🔮`;
      }
      playContractDone();
      showToast(msg);
      updateScoreHud();
    }
    if (!c.done) all = false;
  }
  if (all && !contractsAllDone) {
    contractsAllDone = true;
    unlockAchievement("contracts");
    if (mode !== "sandbox") {
      legacy.shards += core.CONTRACTS_ALL_BONUS_SHARDS;
      saveLegacy();
      showToast(`📜 ALL CONTRACTS COMPLETE — bonus +${core.CONTRACTS_ALL_BONUS_SHARDS}🔮!`);
    } else {
      showToast("📜 All contracts complete!");
    }
  }
  renderContracts();
}

function renderContracts() {
  // The phone layout collapses the panel behind a 📜 pill — keep its
  // done/total count live so progress stays visible without the chrome.
  const pill = document.getElementById("vx-contracts-btn");
  if (pill) pill.textContent = `📜 ${contracts.filter((c) => c.done).length}/${contracts.length || 3}`;
  const el = document.getElementById("vx-contracts-list");
  if (!el) return;
  el.innerHTML = contracts.map((c) => {
    const progress = Math.min(core.contractProgress(c, runCounters), c.target);
    return `<div class="contract-row${c.done ? " done" : ""}" title="${c.label}">
      <span class="contract-label">${c.icon} ${c.label}</span>
      <span class="contract-progress">${c.done ? "✓" : `${progress}/${c.target}`}</span>
    </div>`;
  }).join("");
}

// Fresh run on the CURRENT world: new Heart at full HP, wave clock reset.
// Called from generateWorld (every new world starts a fresh run) and the
// game-over restart button (which regenerates the world too).
function resetRun() {
  gameState = "playing";
  // Sync HUD to the run's mode, and force canonical balance for scored runs
  // (ranked AND daily) so they can never inherit doctored Tweaks from a
  // sandbox session.
  applyMode();
  if (mode !== "sandbox") resetTweaksToDefaults();
  waveNumber = 0;
  waveTimer = 18 * DIFFICULTIES[difficulty].wave;
  trickleTimer = 5 * DIFFICULTIES[difficulty].trickle;
  runStartTime = performance.now() / 1000;
  combo = { count: 0, expiresAt: -Infinity };
  runMaxCombo = 0;
  bossesKilledThisRun = 0;
  // Per-run progression: kills, XP, and the blast upgrade tracks reset here
  // (not in spawnMonsters) so a run started from the title on an existing
  // world can never inherit a previous run's XP or upgrade points.
  killCount = 0;
  xp = 0;
  minSpawnLevel = 1; // condensation ratchet starts over
  turretDamageUps = 0;
  turretRangeUps = 0;
  turretRateUps = 0;
  boltSpeedUps = 0;
  breedsSeen = new Set();
  formsSeenThisRun = new Set();
  maxUnlockedBlast = STARTING_MAX_BLAST + legacy.blastRank; // Demolitionist legacy perk
  blastDamage = core.STARTING_BLAST_DAMAGE + legacy.damageRank; // Heavy Ordnance legacy perk
  upgradesEarned = 0;
  upgradesChosen = 0;
  // Fresh genome: mutations cleared, first strike scheduled (difficulty-scaled).
  mut = { hpMul: 1, dmgMul: 1, speedMul: 1, regen: 0, reachMul: 1, volatile: 0, eatLure: 0 };
  mutationsApplied = [];
  mutationCount = 0;
  mutationTimer = core.mutationDelay(0, DIFFICULTIES[difficulty].wave);
  renderMutationChips();
  updateUpgradeChooser();
  lowestHeartFrac = 1;
  newBestShown = false;
  runStatsFlushed = false;
  // The score to beat for the mid-run "new personal best" fanfare.
  bestAtRunStart = 0;
  if (mode === "ranked") {
    try { bestAtRunStart = Number(localStorage.getItem("vx-best-score") || 0); } catch { /* none */ }
  } else if (mode === "daily") {
    bestAtRunStart = daily.todayBest;
  }
  resetContractsForRun();
  buildHeart(false);
  clearTurrets();
  clearMines();
  // Minefield legacy perk: the run opens with a few mines already buried.
  for (let i = 0; i < core.freeMines(legacy.mineRank); i++) buildMine();
  slowUntil = 0;
  energy = legacy.energyRank * 40; // Head Start legacy perk
  repairCost = core.SHOP.repair.base;
  turretCost = core.SHOP.turret.base;
  frostCost = core.SHOP.frost.base;
  arcCost = core.SHOP.arc.base;
  lanceCost = core.SHOP.lance.base;
  mineCost = core.SHOP.mine.base;
  slowCost = core.SHOP.slow.base;
  wardCost = core.SHOP.ward.base;
  wardRank = 0;
  rebuildSanctuaryRing();
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
  const setBtn = (btnId, costId, cost, extraDisabled = false) => {
    const btn = document.getElementById(btnId);
    const costEl = document.getElementById(costId);
    if (costEl) costEl.textContent = `${core.fmtNum(cost)}⚡`;
    if (btn) btn.disabled = gameState !== "playing" || energy < cost || extraDisabled;
  };
  setBtn("vx-shop-repair", "vx-repair-cost", repairCost, !heart || heart.hp >= heartMaxHp());
  setBtn("vx-shop-turret", "vx-turret-cost", turretCost);
  setBtn("vx-shop-frost", "vx-frost-cost", frostCost);
  setBtn("vx-shop-arc", "vx-arc-cost", arcCost);
  setBtn("vx-shop-lance", "vx-lance-cost", lanceCost);
  setBtn("vx-shop-mine", "vx-mine-cost", mineCost);
  setBtn("vx-shop-slow", "vx-slow-cost", slowCost, performance.now() / 1000 < slowUntil);
  setBtn("vx-shop-ward", "vx-ward-cost", wardCost);
}

function buyRepair() {
  if (gameState !== "playing" || energy < repairCost || !heart || heart.hp >= heartMaxHp()) return;
  energy -= repairCost;
  repairCost = core.nextShopCost(repairCost, "repair");
  // The no-repair contract freezes at the wave of the FIRST repair.
  if (runCounters.waveAtFirstRepair === Infinity) {
    runCounters.waveAtFirstRepair = waveNumber;
    renderContracts();
  }
  // A share of MAX HP, so Reinforced Heart ranks make repairs bigger too.
  heart.hp = Math.min(heartMaxHp(), heart.hp + core.repairAmount(heartMaxHp()));
  playPurchase();
  spawnEatFx(heart.x, heart.y + 1.2, heart.z); // reuse the flash/ring as a "heal burst"
  updateHeartHud();
  updateScoreHud();
}

function buyTurret() {
  if (gameState !== "playing" || energy < turretCost) return;
  energy -= turretCost;
  turretCost = core.nextShopCost(turretCost, "turret");
  buildTurret("bolt");
  if (turrets.length >= 3) unlockAchievement("engineer");
  playPurchase();
  updateScoreHud();
}

function buyFrostTower() {
  if (gameState !== "playing" || energy < frostCost) return;
  energy -= frostCost;
  frostCost = core.nextShopCost(frostCost, "frost");
  buildTurret("frost");
  unlockAchievement("frostbite");
  if (turrets.length >= 3) unlockAchievement("engineer");
  playPurchase();
  updateScoreHud();
}

function buyArcTower() {
  if (gameState !== "playing" || energy < arcCost) return;
  energy -= arcCost;
  arcCost = core.nextShopCost(arcCost, "arc");
  buildTurret("arc");
  unlockAchievement("arclight");
  if (turrets.length >= 3) unlockAchievement("engineer");
  playPurchase();
  updateScoreHud();
}

function buyLanceTower() {
  if (gameState !== "playing" || energy < lanceCost) return;
  energy -= lanceCost;
  lanceCost = core.nextShopCost(lanceCost, "lance");
  buildTurret("lance");
  unlockAchievement("lancer");
  if (turrets.length >= 3) unlockAchievement("engineer");
  playPurchase();
  updateScoreHud();
}

// 🛡️ Ward: consecrate more ground. Doesn't touch anything already on the
// field — it buys the horde's WALK, not a wall, so the payoff is the extra
// seconds your towers get on everything that spawns from now on.
function buyWard() {
  if (gameState !== "playing" || energy < wardCost) return;
  energy -= wardCost;
  wardCost = core.nextShopCost(wardCost, "ward");
  wardRank++;
  runCounters.wardRank = wardRank;
  if (wardRank >= 3) unlockAchievement("sanctuary");
  rebuildSanctuaryRing();
  checkContracts();
  playPurchase();
  showToast(`🛡️ Sanctuary widened to ${sanctuaryRadius()} blocks — nothing spawns inside it`);
  updateScoreHud();
}

function buyMine() {
  if (gameState !== "playing" || energy < mineCost) return;
  energy -= mineCost;
  mineCost = core.nextShopCost(mineCost, "mine");
  buildMine();
  playPurchase();
  updateScoreHud();
}

function buySlow() {
  const now = performance.now() / 1000;
  if (gameState !== "playing" || energy < slowCost || now < slowUntil) return;
  energy -= slowCost;
  slowCost = core.nextShopCost(slowCost, "slow");
  slowUntil = now + SLOW_DURATION;
  if (!slowDome && heart) {
    slowDome = new THREE.Mesh(
      new THREE.SphereGeometry(SLOW_RADIUS, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x7fd6ff, transparent: true, opacity: 0.12,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    root.add(slowDome);
  }
  playPurchase();
  updateScoreHud();
}

// Whether a zombie at (x,z) is currently being slowed — by the purchased
// Heart slow-field, or by standing in any frost tower's aura. Returns the
// speed multiplier so the two sources can't silently stack to a standstill:
// the stronger one wins.
function slowFactorAt(x, z) {
  let factor = 1;
  if (heart && performance.now() / 1000 < slowUntil && Math.hypot(x - heart.x, z - heart.z) < SLOW_RADIUS) {
    factor = Math.min(factor, SLOW_FACTOR);
  }
  if (inFrostAura(x, z)) factor = Math.min(factor, core.FROST_SLOW);
  return factor;
}

/* ---------- mines: buried one-shot area denial ---------- */

const MINE_TRIGGER = 1.2, MINE_BLAST = 2.5, MINE_DMG = 3; // flat, armor-ignoring

// Buried on the approach ring (between turret ring and map): random angle,
// radius 4-7 from the Heart, so a minefield builds up organically.
function buildMine() {
  const angle = Math.random() * Math.PI * 2;
  const ringR = 4 + Math.random() * 3;
  const x = heart.x + Math.sin(angle) * ringR;
  const z = heart.z + Math.cos(angle) * ringR;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.34, 0.14, 10),
    new THREE.MeshLambertMaterial({ color: 0x8a2f26, emissive: 0x3a0f0a })
  );
  mesh.position.set(x, heightAt(x, z) + 0.58, z);
  root.add(mesh);
  mines.push({ x, z, mesh });
}

function clearMines() {
  for (const m of mines) {
    root.remove(m.mesh);
    m.mesh.geometry.dispose();
    m.mesh.material.dispose();
  }
  mines = [];
}

function updateMines() {
  for (let i = mines.length - 1; i >= 0; i--) {
    const mine = mines[i];
    mine.mesh.position.y = heightAt(mine.x, mine.z) + 0.58; // ride terrain edits
    let triggered = false;
    for (const m of monsters) {
      if (Math.hypot(m.x - mine.x, m.z - mine.z) < MINE_TRIGGER) { triggered = true; break; }
    }
    if (!triggered) continue;
    root.remove(mine.mesh);
    mine.mesh.geometry.dispose();
    mine.mesh.material.dispose();
    mines.splice(i, 1);
    spawnEatFx(mine.x, heightAt(mine.x, mine.z) + 1, mine.z);
    shake = Math.min(4.5, shake + 0.6);
    // Flat armor-ignoring area damage; any deaths are player kills.
    for (let j = monsters.length - 1; j >= 0; j--) {
      const m = monsters[j];
      if (Math.hypot(m.x - mine.x, m.z - mine.z) > MINE_BLAST) continue;
      m.hp -= MINE_DMG;
      if (m.hp <= 0) killZombieByPlayer(m, "mine");
    }
  }
}

/* ---------- towers: automated defense, four flavours ---------- */
// One ring, four answers to being overrun (core.TOWER_TYPES):
//   🗼 bolt  — single-target sniping, the reliable backbone
//   ❄️ frost — no bolts at all: a chill aura that slows AND ticks damage on
//              everything standing in it, which is what actually saves you
//              when the horde arrives faster than it can be shot one by one
//   ⚡ arc   — a forked shot that jumps through a clump; winds up slowly, so
//              it's wasted on stragglers and devastating on a packed wave
//   🔱 lance — a beam that pierces an unbounded line of bodies, for when the
//              horde files in along one approach; slowest cadence on the field
// All four run off the same four upgrade tracks (🎯 damage, 📡 range,
// ⏩ fire rate, 🚀 bolt speed), so no upgrade pick is ever dead.

// In-run ⭐ picks (reset each run): 🎯 shares the Legacy +0.5/rank damage
// scale, 📡 stretches range by 2 blocks (and frost auras by 1.5), ⏩ shares
// the Legacy Rapid Coils fire-rate scale.
let turretDamageUps = 0, turretRangeUps = 0, turretRateUps = 0, boltSpeedUps = 0;
// Flat, ignores zombie armor — towers are tech, like blasts. Overcharged
// Turrets legacy ranks and in-run 🎯 picks both raise it.
function turretRanks() { return legacy.turretRank + turretDamageUps; }
function rateRanks() { return legacy.rateRank + turretRateUps; }
function turretDmg() { return core.turretDamage(turretRanks()); }
function turretRange() { return core.turretRange(turretRangeUps); }
function turretCooldown() { return core.towerCooldown(rateRanks()); }
function boltRanks() { return legacy.boltRank + boltSpeedUps; }
function boltSpeed() { return core.boltSpeed(boltRanks()); }
// Shots per second across every standing tower — the number the ⏩ pick
// actually moves, shown in the chooser so the trade-off is legible.
function towerRateReadout(extraRate = 0) {
  return (1 / core.towerCooldown(rateRanks() + extraRate)).toFixed(2);
}

const TOWER_LOOK = {
  bolt: { post: 0x4a5a68, head: 0x77e0a8, emissive: 0x1c4a30, bolt: 0x7fffd0 },
  frost: { post: 0x3d5566, head: 0x8fe6ff, emissive: 0x1d4a5e, bolt: 0xa8ecff },
  arc: { post: 0x584a68, head: 0xc79bff, emissive: 0x3a1c58, bolt: 0xd9b3ff },
  lance: { post: 0x684a4a, head: 0xffb066, emissive: 0x5a2a10, bolt: 0xffd0a0 },
};

// Each new tower takes the next slot on a ring around the Heart (golden-
// angle spacing so any count spreads evenly without overlapping).
function buildTurret(kind = "bolt") {
  const idx = turrets.length;
  const angle = idx * 2.399963; // golden angle in radians
  const ringR = 3.2 + (idx % 3) * 0.8;
  const x = heart.x + Math.sin(angle) * ringR;
  const z = heart.z + Math.cos(angle) * ringR;
  const y = heightAt(x, z) + 0.5;
  const look = TOWER_LOOK[kind];

  const group = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.22, 1.1, 6),
    new THREE.MeshLambertMaterial({ color: look.post })
  );
  post.position.y = 0.55;
  group.add(post);
  // Silhouette per type, readable from the default camera height: the bolt
  // turret keeps its blocky head, frost wears an octahedral shard, arc an
  // emitter ring, lance a long barrel you can see aiming.
  let head;
  if (kind === "frost") {
    head = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.32),
      new THREE.MeshLambertMaterial({ color: look.head, emissive: look.emissive })
    );
  } else if (kind === "arc") {
    head = new THREE.Mesh(
      new THREE.TorusGeometry(0.26, 0.07, 6, 12),
      new THREE.MeshLambertMaterial({ color: look.head, emissive: look.emissive })
    );
    head.rotation.x = Math.PI / 2;
  } else if (kind === "lance") {
    // A long barrel: which way a lance is pointing IS its stat line, so the
    // silhouette has to read as a direction from across the map.
    head = new THREE.Group();
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.13, 1.15, 6),
      new THREE.MeshLambertMaterial({ color: look.head, emissive: look.emissive })
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 0.42;
    head.add(barrel);
  } else {
    head = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.3, 0.42),
      new THREE.MeshLambertMaterial({ color: look.head, emissive: look.emissive })
    );
  }
  head.position.y = 1.2;
  group.add(head);

  // Frost towers wear their reach: a translucent dome showing exactly which
  // ground is chilled, so placement is a decision rather than a guess.
  let aura = null;
  if (kind === "frost") {
    aura = new THREE.Mesh(
      new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x8fe6ff, transparent: true, opacity: 0.09,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    aura.position.y = -0.4;
    // The dome is scenery, not a hitbox: without this the inspector would
    // fire whenever the cursor sat anywhere inside a frost tower's radius.
    aura.raycast = () => {};
    group.add(aura);
  }

  group.position.set(x, y, z);
  root.add(group);

  turrets.push({ kind, x, z, y, group, head, aura, cooldown: 0, spin: 0 });
  runCounters.towersBuilt++;
  checkContracts();
  updateZombieBoard(); // the roster panel lists standing towers too
}

function clearTurrets() {
  // The inspector must not keep pointing at a tower that no longer exists.
  hoveredTower = null;
  clearTowerRangeRing();
  document.getElementById("vx-tower-tip")?.classList.remove("show");
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

function towerCount(kind) {
  return turrets.reduce((n, t) => n + (t.kind === kind ? 1 : 0), 0);
}

// Re-seat towers on new ground after a keep-zombies terrain regen.
function reseatTurrets() {
  for (const t of turrets) {
    t.y = heightAt(t.x, t.z) + 0.5;
    t.group.position.y = t.y;
  }
}

// True while any frost tower is chilling this spot — folded into slowFactorAt
// so movement code has one question to ask.
function inFrostAura(x, z) {
  const r = core.frostRadius(turretRangeUps);
  for (const t of turrets) {
    if (t.kind !== "frost") continue;
    if (Math.hypot(x - t.x, z - t.z) < r) return true;
  }
  return false;
}

function updateTurrets(dt) {
  const frostR = core.frostRadius(turretRangeUps);
  for (const t of turrets) {
    t.cooldown -= dt;
    if (t.kind === "frost") { updateFrostTower(t, dt, frostR); continue; }

    // Track + shoot the nearest zombie in range.
    let best = null, bestD = turretRange();
    for (const m of monsters) {
      const d = Math.hypot(m.x - t.x, m.z - t.z);
      if (d < bestD) { best = m; bestD = d; }
    }
    if (!best) continue;
    t.head.rotation.y = Math.atan2(best.x - t.x, best.z - t.z);
    if (t.cooldown > 0) continue;

    if (t.kind === "arc") {
      t.cooldown = core.arcCooldown(rateRanks());
      fireArc(t, best);
    } else if (t.kind === "lance") {
      t.cooldown = core.lanceCooldown(rateRanks());
      fireLance(t, best);
    } else {
      t.cooldown = turretCooldown();
      spawnBolt(t, best, turretDmg());
    }
    playTurretShot();
  }

  updateTurretBolts(dt);
}

// Frost towers never fire: they hold a chill field that slows everything
// inside (see slowFactorAt) and gnaws at it on a fixed tick, so a wall of bodies
// walking through takes damage no single-target turret could keep up with.
function updateFrostTower(t, dt, frostR) {
  t.spin += dt * 1.4;
  t.head.rotation.y = t.spin;
  if (t.aura) t.aura.scale.setScalar(frostR);
  if (t.cooldown > 0) return;
  t.cooldown = core.FROST_TICK;
  const dmg = core.frostTickDamage(turretRanks());
  for (let i = monsters.length - 1; i >= 0; i--) {
    const m = monsters[i];
    if (Math.hypot(m.x - t.x, m.z - t.z) > frostR) continue;
    m.hp -= dmg;
    if (m.hp <= 0) killZombieByPlayer(m, "turret");
  }
}

// Arc towers fork: the shot walks from the primary target to the nearest
// unhit body, up to core.ARC_CHAIN links, each link a shorter bolt. Cheap
// enough to run every shot — the chain is at most 3 nearest-neighbour scans.
function fireArc(t, first) {
  const hit = new Set([first]);
  let from = first;
  spawnBolt(t, first, core.arcDamage(turretRanks()));
  for (let link = 1; link < core.ARC_CHAIN; link++) {
    let next = null, bestD = core.ARC_JUMP;
    for (const m of monsters) {
      if (hit.has(m)) continue;
      const d = Math.hypot(m.x - from.x, m.z - from.z);
      if (d < bestD) { next = m; bestD = d; }
    }
    if (!next) break;
    hit.add(next);
    spawnBolt(t, next, core.arcDamage(turretRanks()), from);
    from = next;
  }
}

// Lance towers fire a piercing beam down the line to their target: EVERY
// zombie within core.LANCE_WIDTH of that line takes the hit, however many
// that is — the pierce is deliberately unbounded. What it costs is position
// and time: only bodies that happen to be lined up get hit, and the tower
// then spends three bolt-turret cooldowns winding the next shot up.
function fireLance(t, target) {
  const dx = target.x - t.x, dz = target.z - t.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const reach = turretRange();
  const dmg = core.lanceDamage(turretRanks());
  spawnLanceBeam(t, ux, uz, reach);
  // Iterate backwards: a killed body is spliced out of `monsters` in place.
  for (let i = monsters.length - 1; i >= 0; i--) {
    const m = monsters[i];
    const rx = m.x - t.x, rz = m.z - t.z;
    const along = rx * ux + rz * uz;              // distance down the beam
    if (along < 0 || along > reach) continue;      // behind the tower / past its reach
    const off = Math.abs(rx * uz - rz * ux);       // perpendicular distance
    if (off > core.LANCE_WIDTH) continue;
    m.hp -= dmg;
    if (m.hp <= 0) killZombieByPlayer(m, "turret");
  }
}

// The beam itself: a stretched additive box that fades out over ~0.25s, so
// the player can see exactly what line the shot swept.
function spawnLanceBeam(t, ux, uz, reach) {
  const geo = new THREE.BoxGeometry(core.LANCE_WIDTH * 2, 0.18, reach);
  const mat = new THREE.MeshBasicMaterial({
    color: TOWER_LOOK.lance.bolt, transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const beam = new THREE.Mesh(geo, mat);
  beam.position.set(t.x + ux * reach * 0.5, t.y + 1.2, t.z + uz * reach * 0.5);
  beam.rotation.y = Math.atan2(ux, uz);
  root.add(beam);
  fx.push({ type: "beam", obj: beam, age: 0, life: 0.25 });
}

// One travelling projectile. `origin` lets an arc link launch from the last
// body it struck instead of from the tower head.
function spawnBolt(t, target, damage, origin = null) {
  const look = TOWER_LOOK[t.kind];
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(t.kind === "arc" ? 0.11 : 0.09, 6, 5),
    new THREE.MeshBasicMaterial({
      color: look.bolt, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  if (origin) mesh.position.set(origin.x, origin.visualY + 0.9 * bodyScale(origin), origin.z);
  else mesh.position.set(t.x, t.y + 1.2, t.z);
  root.add(mesh);
  turretBolts.push({ mesh, target, damage });
}

function updateTurretBolts(dt) {
  for (let i = turretBolts.length - 1; i >= 0; i--) {
    const b = turretBolts[i];
    if (!monsters.includes(b.target)) {
      root.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
      turretBolts.splice(i, 1);
      continue;
    }
    const ty = b.target.visualY + 0.9 * bodyScale(b.target);
    const dx = b.target.x - b.mesh.position.x, dy = ty - b.mesh.position.y, dz = b.target.z - b.mesh.position.z;
    const dist = Math.hypot(dx, dy, dz);
    const step = boltSpeed() * dt;
    if (dist <= Math.max(0.25, step)) {
      b.target.hp -= b.damage;
      root.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
      turretBolts.splice(i, 1);
      if (b.target.hp <= 0) killZombieByPlayer(b.target, "turret");
      continue;
    }
    b.mesh.position.x += (dx / dist) * step;
    b.mesh.position.y += (dy / dist) * step;
    b.mesh.position.z += (dz / dist) * step;
  }
}

// A player kill landed the killing blow on a boss: pay the bounty (energy
// only — on top of the normal level-scaled payout) with full fanfare.
let bossesKilledThisRun = 0;
function onBossKilledByPlayer(m) {
  const bounty = core.bossBounty(m.stackLevel);
  energy += bounty;
  bossesKilledThisRun++;
  unlockAchievement("boss-slayer");
  playBossDown();
  showToast(`☠️ Boss destroyed! Bounty +${core.fmtNum(bounty)}⚡`);
}

// A single player-credited kill (a turret bolt or mine finished a zombie
// off): same rewards and respawn rules as a blast kill, minus the area
// logic. `source` says which defense earned it ("turret" | "mine").
function killZombieByPlayer(m, source = "turret") {
  if (!monsters.includes(m)) return;
  monsterGroup.remove(m.rig.root);
  disposeRig(m.rig);
  disposeZombieMaterials(m.mats);
  disposeMonsterUi(m);
  spawnGibs(m.x, heightAt(m.x, m.z) + 0.9, m.z);
  volatileBurst(m.x, m.z);
  monsters.splice(monsters.indexOf(m), 1);
  playZombieKill(1);
  killCount++;
  noteContractKill(source, m.stackLevel);
  const mult = registerPlayerKills(1);
  const earned = Math.round(core.killPayout(m.stackLevel) * mult);
  xp += earned;
  energy += earned;
  if (m.isBoss) onBossKilledByPlayer(m);
  unlockAchievement("first-blood");
  if (killCount >= 100) unlockAchievement("exterminator");
  if (energy >= 500) unlockAchievement("rich");
  maybeCelebrateNewBest();
  updateScoreHud();
  checkUpgradeUnlocks();
  let toSpawn = core.spawnsForKills(1, spawnsPerKill);
  while (toSpawn-- > 0) queueZombieSpawn();
  updateZombieBoard();
}

/* ---------- live-tweakable sim knobs (⚙️ Tweaks panel in the HUD) ---------- */
// Canonical (ranked) values live in core.CANONICAL_TWEAKS — tested — and
// every slider snaps back to them on scored runs via resetTweaksToDefaults.
let spawnsPerKill = core.CANONICAL_TWEAKS.spawnsPerKill; // fresh zombies per player blast kill (1.1 = replace + 10% bonus roll)
let spawnsPerEat = core.CANONICAL_TWEAKS.spawnsPerEat; // fresh zombies spawned per zombie eaten by another zombie (0 = the strong thin the herd)
let speedPerLevel = core.CANONICAL_TWEAKS.speedPerLevel; // extra speed a zombie gains per level past 1
let simSpeed = core.CANONICAL_TWEAKS.simSpeed; // time multiplier for the zombie sim (movement + combat), not the player's missiles
let hpPerLevel = core.CANONICAL_TWEAKS.hpPerLevel; // extra max HP per level past 1 — crank it to make elites tanky against blasts too
let dmgPerLevel = core.CANONICAL_TWEAKS.dmgPerLevel; // extra DPS per level past 1 dealt in zombie-vs-zombie fights
let atkPerLevel = core.CANONICAL_TWEAKS.atkPerLevel; // attack-rate growth per level past 1 (0 = every level shoots at the same cadence)

// The ⚙️ Tweaks sliders, described once so the input handlers (init) and
// resetTweaksToDefaults() share a single source of truth for each slider's
// default value, label formatting, and live apply side-effects.
const TWEAK_SLIDERS = [
  { id: "vx-spawn-per-kill", def: core.CANONICAL_TWEAKS.spawnsPerKill, fmt: (v) => String(Math.round(v * 10) / 10), apply: (v) => { spawnsPerKill = v; } },
  { id: "vx-spawn-per-eat", def: core.CANONICAL_TWEAKS.spawnsPerEat, fmt: (v) => String(v), apply: (v) => { spawnsPerEat = v; } },
  { id: "vx-spawn-delay", def: core.CANONICAL_TWEAKS.spawnDelay, fmt: (v) => String(v), apply: (v) => { spawnDelay = v; } },
  { id: "vx-speed-per-level", def: core.CANONICAL_TWEAKS.speedPerLevel, fmt: (v) => v.toFixed(2), apply: (v) => {
      speedPerLevel = v;
      // Re-derive every living zombie's speed so the new slope applies now.
      for (const m of monsters) m.speed = stackSpeed(m.stackLevel) + Math.random() * 0.2;
    } },
  { id: "vx-sim-speed", def: core.CANONICAL_TWEAKS.simSpeed, fmt: (v) => v.toFixed(1), apply: (v) => { simSpeed = v; } },
  { id: "vx-hp-per-level", def: core.CANONICAL_TWEAKS.hpPerLevel, fmt: (v) => v.toFixed(2), apply: (v) => {
      hpPerLevel = v;
      for (const m of monsters) m.hp = maxHpFor(m); // heal all to the new full
    } },
  { id: "vx-dmg-per-level", def: core.CANONICAL_TWEAKS.dmgPerLevel, fmt: (v) => v.toFixed(2), apply: (v) => { dmgPerLevel = v; } },
  { id: "vx-atk-per-level", def: core.CANONICAL_TWEAKS.atkPerLevel, fmt: (v) => v.toFixed(2), apply: (v) => { atkPerLevel = v; } },
];

// Snap every tweak — sim var AND slider/label DOM — back to its canonical
// default. Called at the start of every RANKED run (see resetRun).
function resetTweaksToDefaults() {
  for (const s of TWEAK_SLIDERS) {
    const el = document.getElementById(s.id);
    const label = document.getElementById(s.id + "-val");
    if (el) el.value = String(s.def);
    if (label) label.textContent = s.fmt(s.def);
    s.apply(s.def);
  }
}

// Reflect the current mode in the DOM: sandbox reveals the Tweaks panel and
// the "not saved" markers (via body.sandbox); ranked/daily hide Tweaks
// outright so a scored run has no doctoring surface at all. Daily also locks
// the world controls — its board is fixed for the day.
function applyMode() {
  const sandbox = mode === "sandbox";
  document.body.classList.toggle("sandbox", sandbox);
  document.body.classList.toggle("daily", mode === "daily");
  const tweaks = document.getElementById("vx-tweaks");
  if (tweaks) tweaks.style.display = sandbox ? "" : "none";
  const lock = mode === "daily";
  for (const id of ["vx-seed", "vx-biome", "vx-new"]) {
    const el = document.getElementById(id);
    if (el) el.disabled = lock;
  }
}

// Stat curves live in core; these wrappers bind the live Tweaks-slider
// slopes AND the run's stacking mutation multipliers (see `mut`), so every
// call site stays unchanged. Blast damage vs zombies is the player's
// blastDamage stat (see killMonstersNear) — raising hpPerLevel or landing a
// Thick Hide mutation makes high levels harder for the PLAYER to kill too.
// Per-MONSTER, not per-level: a zombie's breed (core.ARCHETYPES) multiplies
// its durability on top of the level curve, so a Brute is a wall and a
// Runner is paper at the very same level.
function maxHpFor(m) { return core.maxHpFor(m.stackLevel, hpPerLevel) * mut.hpMul * (m.arch?.hp ?? 1); }
function dpsFor(level) { return core.dpsFor(level, dmgPerLevel) * mut.dmgMul; }
function stackSpeed(level) { return core.stackSpeed(level, speedPerLevel) * mut.speedMul; }
const eatsNeededForLevel = core.eatsNeededForLevel;

// Rendered body size: the CAPPED evolution ladder (core.evolutionOf — a
// monster metamorphoses instead of growing past ×5) times the breed's build.
// Reach and hp-bar height read this too, so what a monster can touch always
// matches how big it looks; blast radii and targeting deliberately don't, so
// what you aim at is still exactly what you hit.
// The breed multiplier rides on top of the cap deliberately: it's a fixed
// ±35% build, not a growth term, so a Brute is simply a chunkier example of
// whatever form it currently wears — and which form that is stays a pure
// function of level, identical across breeds.
function bodyScale(m) { return core.displayScale(m.stackLevel) * (m.arch?.scale ?? 1); }

const HP_BAR_W = 0.9, HP_BAR_H = 0.13;
const HP_BAR_INNER_W = 0.8, HP_BAR_INNER_H = 0.08;

// How far above a zombie's feet its health bar / aura should float, scaled
// to how tall that particular stack level actually renders.
function hpBarOffset(m) { return 1.95 * bodyScale(m) + 0.35; }

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
function attackInterval(level) { return core.attackInterval(level, atkPerLevel); }

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
      const reach = EAT_DIST * 1.6 * (bodyScale(a) + bodyScale(b)) / 2;
      if (Math.hypot(a.x - b.x, a.z - b.z) >= reach) continue;
      if (!a.fightTarget) a.fightTarget = b;
      if (!b.fightTarget) b.fightTarget = a;
    }
  }
  // Anyone not busy brawling turns its guns on the Heart when close enough —
  // sieging the objective, not just each other. The Long Arms mutation
  // stretches this reach, so a mutated horde opens fire from farther out.
  if (heart && gameState === "playing") {
    for (const m of monsters) {
      if (m.fightTarget) continue;
      const reach = EAT_DIST * 2.4 * bodyScale(m) * mut.reachMul * (m.arch?.reach ?? 1);
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
  mesh.position.set(shooter.x, shooter.visualY + 1.2 * bodyScale(shooter), shooter.z);
  root.add(mesh);
  zombieProjectiles.push({
    mesh, shooter, target,
    // Raw DPS + this shot's interval, kept separate so the target's defense
    // (a DPS-denominated stat) can be subtracted at hit time — see
    // updateZombieProjectiles.
    dps: dpsFor(level) * (shooter.arch?.dmg ?? 1),
    interval: attackInterval(level),
    // Scales with the shooter's level: an elite's fire should read as fire,
    // not as a lobbed balloon you can stroll out of the way of.
    speed: core.zombieBoltSpeed(level),
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
    const tx = p.target.x, ty = p.target.visualY + 0.9 * bodyScale(p.target), tz = p.target.z;
    const dx = tx - p.mesh.position.x, dy = ty - p.mesh.position.y, dz = tz - p.mesh.position.z;
    const dist = Math.hypot(dx, dy, dz);
    const step = p.speed * dt;
    if (dist <= Math.max(0.25, step)) {
      // Hit: damage after the target's armor — a logarithmic reduction
      // (core.damageTakenMultiplier) that always leaves something landing,
      // so no target is ever fully immune. The Heart's stackLevel of 1
      // gives it no reduction at all, so every zombie chips it in full.
      const effDmg = core.effectiveHitDamage(p.dps, p.interval, p.target.stackLevel);
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
  disposeRig(loser.rig);
  disposeZombieMaterials(loser.mats);
  disposeMonsterUi(loser);
  monsters.splice(monsters.indexOf(loser), 1);

  spawnEatFx(lx, heightAt(lx, lz) + 1, lz);
  spawnGibs(lx, heightAt(lx, lz) + 0.9, lz);
  volatileBurst(lx, lz); // devoured counts as destroyed — Volatile still pops

  // Losing a boss to the horde is a story beat: whoever ate it inherits its
  // levels (eatXp below), and the bounty is gone. Punish hesitation loudly.
  if (loser.isBoss) showToast("😱 The boss was devoured — its power lives on!");

  // Replacement spawns — default 1-for-1 keeps eats population-neutral, but
  // it's a tweakable: 0 lets the strong actually thin the herd, higher
  // values make eating feed the swarm (the Corpse Bloom mutation piles its
  // lure on top of the slider). Fractional values roll stochastically.
  let eatSpawns = core.spawnsForKills(1, spawnsPerEat + mut.eatLure);
  while (eatSpawns-- > 0) queueZombieSpawn();

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
    killer.hp = maxHpFor(killer); // leveling up fully heals
    // A breed is for life: a Runner that eats its way up is a faster level 9.
    killer.speed = (stackSpeed(killer.stackLevel) + Math.random() * 0.2) * (killer.arch?.speed ?? 1);
  }
  maybeMetamorphose(killer);
  if (killer.stackLevel >= 5) unlockAchievement("evolved-5");
  if (killer.stackLevel >= 10) unlockAchievement("evolved-10");
  updateZombieBoard();
}

function updateScoreHud() {
  const killEl = document.getElementById("vx-score-val");
  if (killEl) killEl.textContent = core.fmtNum(killCount);

  const energyEl = document.getElementById("vx-energy-val");
  if (energyEl) energyEl.textContent = core.fmtNum(energy);
  updateShopHud();

  const radiusEl = document.getElementById("vx-radius-val");
  if (radiusEl) radiusEl.textContent = String(maxUnlockedBlast);
  const damageEl = document.getElementById("vx-damage-val");
  if (damageEl) damageEl.textContent = String(blastDamage);

  const xpEl = document.getElementById("vx-xp-val");
  if (xpEl) xpEl.textContent = core.fmtNum(xp);

  const fillEl = document.getElementById("vx-xp-fill");
  const nextEl = document.getElementById("vx-xp-next");
  const nextCost = upgradeUnlockCost(upgradesEarned + 1);
  const prevCost = upgradesEarned > 0 ? upgradeUnlockCost(upgradesEarned) : 0;
  const pct = Math.max(0, Math.min(1, (xp - prevCost) / (nextCost - prevCost)));
  if (fillEl) fillEl.style.width = `${Math.round(pct * 100)}%`;
  if (nextEl) nextEl.textContent = `${core.fmtNum(xp)} / ${core.fmtNum(nextCost)} XP → upgrade choice`;
}

// "Board" panel: how many zombies currently exist at each stack level.
function updateZombieBoard() {
  const el = document.getElementById("vx-board-list");
  if (!el) return;
  const counts = new Map();
  for (const m of monsters) counts.set(m.stackLevel, (counts.get(m.stackLevel) || 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  // Once condensation has ratcheted the spawn floor, say so — it explains
  // why "fresh" zombies suddenly arrive pre-evolved.
  const floorRow = minSpawnLevel > 1
    ? `<div class="hud-board-row hud-board-floor"><span>⬆ Spawn floor</span><span>Lv ${minSpawnLevel}</span></div>`
    : "";
  if (levels.length === 0) {
    el.innerHTML = `${floorRow}${formRows()}${breedRows()}${towerRows()}<div class="hud-board-empty">No zombies left</div>`;
    return;
  }
  el.innerHTML = floorRow + levels
    .map((lv) => `<div class="hud-board-row"><span>Lvl ${lv}</span><span>${counts.get(lv)}</span></div>`)
    .join("") + formRows() + breedRows() + towerRows();
}

// Which evolved forms are walking around. Only tiers past the plain walker
// are listed — the point of the panel is "something out there has already
// outgrown its body twice", which the level rows alone don't convey.
function formRows() {
  const counts = new Map();
  let deepest = 0;
  for (const m of monsters) {
    const tier = m.tier || 0;
    if (tier <= 0) continue;
    if (tier > deepest) deepest = tier;
    const form = core.evolutionForm(tier);
    counts.set(form, (counts.get(form) || 0) + 1);
  }
  if (counts.size === 0) return "";
  const rows = [...counts.entries()]
    .map(([f, n]) => `<div class="hud-board-row"><span>${f.icon} ${f.name}</span><span>${n}</span></div>
      <div class="hud-board-note">${f.desc}</div>`)
    .join("");
  // Past the last authored body plan the tier keeps counting (and glowing),
  // so say which generation the worst thing on the field is on.
  const gen = deepest >= core.EVOLUTION_FORMS.length
    ? `<div class="hud-board-note">Deepest metamorphosis: generation ${deepest}</div>`
    : "";
  return `<div class="hud-board-head">Evolved forms</div>${rows}${gen}`;
}

// Which breeds are on the field right now, with what each one actually does
// — the tints alone don't say that a Brute is 2.6× tougher.
function breedRows() {
  const counts = new Map();
  for (const m of monsters) {
    if (m.arch && m.arch.key !== "walker") counts.set(m.arch, (counts.get(m.arch) || 0) + 1);
  }
  if (counts.size === 0) return "";
  const rows = [...counts.entries()]
    .map(([a, n]) => `<div class="hud-board-row"><span>${a.icon} ${a.name}</span><span>${n}</span></div>
      <div class="hud-board-note">${breedTip(a)}</div>`)
    .join("");
  return `<div class="hud-board-head">Breeds afield</div>${rows}`;
}

// Human-readable stat line for a breed, built from its own multipliers so it
// can never drift out of sync with core.ARCHETYPES.
function breedTip(a) {
  const parts = [];
  const pct = (v) => `${v > 1 ? "+" : "−"}${Math.round(Math.abs(v - 1) * 100)}%`;
  if (a.hp !== 1) parts.push(`${pct(a.hp)} HP`);
  if (a.speed !== 1) parts.push(`${pct(a.speed)} speed`);
  if (a.dmg !== 1) parts.push(`${pct(a.dmg)} damage`);
  if (a.reach !== 1) parts.push(`${pct(a.reach)} siege reach`);
  return parts.join(", ");
}

// The tower line-up, so the shop's escalating prices are decisions made with
// the current roster in view.
function towerRows() {
  if (turrets.length === 0) return "";
  const rows = core.TOWER_TYPES
    .map((def) => [def, towerCount(def.key)])
    .filter(([, n]) => n > 0)
    .map(([def, n]) => `<div class="hud-board-row"><span>${def.icon} ${def.name}</span><span>${n}</span></div>
      <div class="hud-board-note">${def.desc}</div>`)
    .join("");
  return `<div class="hud-board-head">Towers standing</div>${rows}`;
}

// XP thresholds bank upgrade POINTS (no ceiling — the cost gaps grow
// geometrically, see core.upgradeUnlockCost); each point is spent through
// the on-screen chooser on +1 radius OR +1 damage. Called any time XP changes.
function checkUpgradeUnlocks() {
  const before = upgradesEarned;
  while (xp >= upgradeUnlockCost(upgradesEarned + 1)) upgradesEarned++;
  if (upgradesEarned > before) {
    playPurchase();
    if (before === upgradesChosen) showToast("⭐ Upgrade ready — choose: 💥 radius or ⚔️ damage!");
  }
  updateScoreHud();
  updateUpgradeChooser();
}

// The radius/damage chooser panel: visible whenever points are banked and
// the run is live. Non-blocking by design — the siege doesn't wait, so the
// player picks in a lull (points queue up; the ×N badge shows the backlog).
function pendingUpgradePoints() { return upgradesEarned - upgradesChosen; }

function updateUpgradeChooser() {
  const el = document.getElementById("vx-upgrade");
  if (!el) return;
  const show = pendingUpgradePoints() > 0 && gameState === "playing";
  el.classList.toggle("show", show);
  if (!show) return;
  const count = document.getElementById("vx-upgrade-count");
  if (count) count.textContent = pendingUpgradePoints() > 1 ? ` ×${pendingUpgradePoints()}` : "";
  const radiusVal = document.getElementById("vx-up-radius-val");
  if (radiusVal) radiusVal.textContent = `${maxUnlockedBlast} → ${maxUnlockedBlast + 1}`;
  const damageVal = document.getElementById("vx-up-damage-val");
  if (damageVal) damageVal.textContent = `${blastDamage} → ${blastDamage + 1}`;
  const tdVal = document.getElementById("vx-up-turretdmg-val");
  if (tdVal) tdVal.textContent = `${turretDmg()} → ${turretDmg() + 0.5}`;
  const trVal = document.getElementById("vx-up-turretrange-val");
  if (trVal) trVal.textContent = `${turretRange()} → ${turretRange() + 2}`;
  const trateVal = document.getElementById("vx-up-turretrate-val");
  if (trateVal) trateVal.textContent = `${towerRateReadout()} → ${towerRateReadout(1)}/s`;
  const bsVal = document.getElementById("vx-up-boltspeed-val");
  if (bsVal) bsVal.textContent = `${Math.round(boltSpeed())} → ${Math.round(core.boltSpeed(boltRanks() + 1))}`;
}

function chooseUpgrade(kind) {
  if (pendingUpgradePoints() <= 0 || gameState !== "playing") return;
  upgradesChosen++;
  if (kind === "radius") {
    maxUnlockedBlast++;
    showToast(`💥 Blast radius ${maxUnlockedBlast}!`);
  } else if (kind === "turretdmg") {
    turretDamageUps++;
    showToast(`🎯 Turret damage ${turretDmg()} — every bolt hits harder!`);
  } else if (kind === "turretrange") {
    turretRangeUps++;
    showToast(`📡 Turret range ${turretRange()} — bolts reach further out, frost auras widen!`);
  } else if (kind === "turretrate") {
    turretRateUps++;
    showToast(`⏩ Towers fire ${towerRateReadout()}/s — every tower winds up faster!`);
  } else if (kind === "boltspeed") {
    boltSpeedUps++;
    showToast(`🚀 Bolt speed ${Math.round(boltSpeed())} — shots stop losing races with Runners!`);
  } else {
    blastDamage++;
    showToast(`⚔️ Blast damage ${blastDamage} — deeper craters, harder hits!`);
  }
  playPurchase();
  updateScoreHud();
  updateAimIndicator();
  updateUpgradeChooser();
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

// Big center-screen announcement, reserved for run-defining events (horde
// mutations, condensations) — toasts are for routine feedback. `kind` picks
// the accent styling: "mut" (genetic purple) or "fuse" (alchemical amber).
let bannerTimer = null;
function showBanner(kind, kicker, title, desc) {
  const el = document.getElementById("vx-banner");
  if (!el) return;
  document.getElementById("vx-banner-kicker").textContent = kicker;
  document.getElementById("vx-banner-title").textContent = title;
  document.getElementById("vx-banner-desc").textContent = desc;
  el.className = `${kind} show`;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove("show"), 4600);
}

/* ---------- horde mutations: the timed escalation engine ---------- */

// Folds one drawn mutation into the live `mut` state. Multipliers compound
// (two Thick Hides = ×1.5625 HP); effect mutations stack additively. Living
// zombies are adjusted in place so the strike is felt immediately, not just
// by future spawns.
function applyMutation(def) {
  switch (def.key) {
    case "hide":
      mut.hpMul *= 1.25;
      // Scale current HP by the same factor: damage fractions are preserved
      // (a half-dead zombie stays half-dead, its bar doesn't refill).
      for (const m of monsters) m.hp *= 1.25;
      break;
    case "venom": mut.dmgMul *= 1.25; break;
    case "surge":
      mut.speedMul *= 1.15;
      for (const m of monsters) m.speed *= 1.15;
      break;
    case "regen": mut.regen += 0.5; break;
    case "arms": mut.reachMul *= 1.35; break;
    case "volatile": mut.volatile += 1; break;
    case "bloom": mut.eatLure += 0.5; break;
  }
}

// Counts down in sim time (pause and menu don't advance it; the sim-speed
// slider does) and strikes on schedule: draw the seeded mutation, apply it,
// and announce it with full fanfare. The pace tightens as the run goes on
// (core.mutationDelay), scaled by difficulty.
function updateMutations(dt) {
  if (gameState !== "playing") return;
  mutationTimer -= dt;
  if (mutationTimer > 0) return;
  const def = core.mutationAtIndex(mutationSeedStr, mutationCount);
  mutationCount++;
  mutationTimer = core.mutationDelay(mutationCount, DIFFICULTIES[difficulty].wave);
  mutationsApplied.push(def);
  applyMutation(def);
  showBanner("mut", "🧬 HORDE MUTATION", `${def.icon} ${def.name}`, def.desc);
  playBossSpawn();
  renderMutationChips();
  if (mutationCount >= 5) unlockAchievement("adapted");
}

// The compact "genome" readout under the Heart bar: one chip per distinct
// mutation with a stack count, so the horde's current buffs stay glanceable
// (crucial on phones, where the banner is long gone by the time it matters).
function renderMutationChips() {
  const el = document.getElementById("vx-mutations");
  if (!el) return;
  const stacks = new Map();
  for (const def of mutationsApplied) {
    const s = stacks.get(def.key) || { def, n: 0 };
    s.n++;
    stacks.set(def.key, s);
  }
  // Each chip carries its own explanation: a styled hover card on desktop
  // (data-tip, see voxel.css) and a tap-for-a-toast on phones, where a
  // native `title` never fires. The banner is long gone by the time a player
  // wonders what 🦑 did to the horde — this is where they find out.
  el.innerHTML = [...stacks.values()]
    .map(({ def, n }) => {
      const stack = n > 1 ? ` ×${n}` : "";
      const tip = `${def.name}${stack} — ${def.desc}`;
      return `<span class="mut-chip" data-tip="${tip}" data-mut="${def.key}" data-n="${n}" role="button" tabindex="0">${def.icon}${stack}</span>`;
    })
    .join("");
  for (const chip of el.querySelectorAll(".mut-chip")) {
    chip.addEventListener("click", () => showToast(`🧬 ${chip.dataset.tip}`));
  }
}

// Volatile mutation: any zombie destroyed close to the Heart bursts and
// chips it — turtling behind turrets (whose kills land right at the walls)
// stops being free once the horde turns volatile. Every death path calls
// this; it no-ops until the mutation is live.
function volatileBurst(x, z) {
  if (mut.volatile <= 0 || !heart || gameState !== "playing") return;
  if (Math.hypot(x - heart.x, z - heart.z) > 3.5) return;
  damageHeart(mut.volatile);
  const pos = new THREE.Vector3(x, heightAt(x, z) + 1, z);
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 2.5;
    const geo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x8aff3a, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const s = new THREE.Mesh(geo, mat);
    s.position.copy(pos);
    root.add(s);
    fx.push({
      type: "spark", obj: s, age: 0, life: 0.3 + Math.random() * 0.15,
      vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 2 + Math.random() * 2,
    });
  }
}

function updateMonsters(dt, now) {
  for (const m of monsters) {
    let moving = false;
    // Regeneration mutation: wounded zombies knit back toward full over sim
    // time — chip damage (turret bolts, glancing blasts) stops sticking.
    if (mut.regen > 0 && m.hp < maxHpFor(m)) {
      m.hp = Math.min(maxHpFor(m), m.hp + mut.regen * dt);
    }
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
      const spd = m.speed * slowFactorAt(m.x, m.z);
      const nx = m.x + Math.sin(m.angle) * spd * dt;
      const nz = m.z + Math.cos(m.angle) * spd * dt;
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
    m.rig.root.scale.setScalar(bodyScale(m) * pulse);

    if (moving) m.walkPhase += dt * m.speed * 3.2;
    const swing = Math.sin(m.walkPhase) * 0.5;
    m.rig.legL.rotation.x = swing;
    m.rig.legR.rotation.x = -swing;
    m.rig.armL.rotation.x = -1.15 - swing * 0.3;
    m.rig.armR.rotation.x = -1.15 + swing * 0.3;

    // Health bar — only shown once damaged, hidden again at full HP.
    const damaged = m.hp < maxHpFor(m);
    m.healthBg.visible = m.healthFill.visible = damaged;
    if (damaged) {
      const barY = m.visualY + hpBarOffset(m);
      m.healthBg.position.set(m.x, barY, m.z);
      m.healthFill.position.set(m.x, barY, m.z);
      const ratio = Math.max(0, m.hp / maxHpFor(m));
      m.healthFill.scale.set(HP_BAR_INNER_W * ratio, HP_BAR_INNER_H, 1);
      m.healthFill.material.color.setHex(ratio > 0.5 ? 0x4fd68a : ratio > 0.25 ? 0xffcf5a : 0xff5a4a);
    }
  }
  updateEliteMarkers(now);
  updateBossMarkers(now);
}

function killMonstersNear(bx, bz, r) {
  const coreR = Math.floor(r / 2); // inner half of the radius — double damage
  let kills = 0, earned = 0, maxLevelKilled = 0;
  const bossesDown = [];
  for (let i = monsters.length - 1; i >= 0; i--) {
    const m = monsters[i];
    const d = Math.hypot(m.x - bx, m.z - bz);
    if (d > r + 1) continue;
    // 1 outer / 2 core, times the blast-damage stat — a damage-built run
    // one-shots stacks a radius-built run only chips (core.blastZombieDamage).
    m.hp -= core.blastZombieDamage(d <= coreR, blastDamage);
    if (m.hp > 0) {
      spawnHitFlinch(m); // a tall stack survives a hit — knock it back and flash it
      continue;
    }
    monsterGroup.remove(m.rig.root);
    disposeRig(m.rig);
    disposeZombieMaterials(m.mats);
    disposeMonsterUi(m);
    spawnGibs(m.x, heightAt(m.x, m.z) + 0.9, m.z);
    volatileBurst(m.x, m.z);
    monsters.splice(i, 1);
    kills++;
    earned += core.killPayout(m.stackLevel);
    if (m.stackLevel > maxLevelKilled) maxLevelKilled = m.stackLevel;
    if (m.isBoss) bossesDown.push(m);
  }
  if (kills > 0) {
    playZombieKill(kills);
    killCount += kills;
    // The blast's own kills feed its combo before the payout is computed,
    // so one huge blast pays out at its full chained multiplier.
    const mult = registerPlayerKills(kills);
    const payout = Math.round(earned * mult);
    xp += payout;
    energy += payout; // spendable twin of the XP payout — see the energy declaration
    noteBlastKills(kills, maxLevelKilled);
    for (const b of bossesDown) onBossKilledByPlayer(b);
    unlockAchievement("first-blood");
    if (killCount >= 100) unlockAchievement("exterminator");
    if (energy >= 500) unlockAchievement("rich");
    maybeCelebrateNewBest();
    updateScoreHud();
    checkUpgradeUnlocks();
    if (kills >= 2) spawnKillStreakPopup(bx, heightAt(bx, bz) + 2.6, bz, kills);
    // No cap, intentionally — see the "no artificial limits" note near
    // MONSTER_COUNT. Every kill spawns `spawnsPerKill` more (default 1.1:
    // each kill replaces itself, fractional part rolls stochastically —
    // see core.spawnsForKills), unconditionally, forever.
    let toSpawn = core.spawnsForKills(kills, spawnsPerKill);
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
const stratumForDepth = core.stratumForDepth;

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
  // A brand-new world abandons whatever run was live — bank its stats
  // first (no-ops if already flushed, or if nothing really happened).
  if (!keepZombies) flushRunStats();
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
    // XP, upgrades, mutations — and the run itself (Heart damage, wave
    // count) — are untouched: a mid-run terrain shuffle, not a restart.
    currentSeaLevel = biome.seaLevel;
    currentSeed = seed;
    for (const m of monsters) {
      m.fightTarget = null;
      Object.assign(m, initVerticalState(m.x, m.z));
    }
    buildHeart(true); // re-seat the Heart on the new ground, keeping its HP
    reseatTurrets();
    rebuildSanctuaryRing(); // new hills under the same consecrated circle
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
  // showing nothing when nobody has leveled up yet reads as broken. Bosses
  // are excluded from the ranking — they wear permanent gold crowns instead.
  let maxLevel = 1;
  for (const m of monsters) if (!m.isBoss && m.stackLevel > maxLevel) maxLevel = m.stackLevel;
  let count = 0;
  for (const m of monsters) {
    if (m.stackLevel !== maxLevel || m.isBoss) continue; // bosses wear gold crowns already
    const { ring, beam } = ensureEliteMarker(count++);
    ring.position.set(m.x, m.visualY + 0.05, m.z);
    ring.rotation.z = now * 1.8;
    const pulse = 1 + 0.15 * Math.sin(now * 3 + m.phase);
    ring.scale.setScalar(bodyScale(m) * pulse);
    ring.visible = true;

    beam.position.set(m.x, m.visualY + hpBarOffset(m) + 1.6, m.z);
    beam.scale.set(0.7, 3.2, 1);
    beam.material.opacity = 0.65 + 0.15 * Math.sin(now * 3 + m.phase);
    beam.visible = true;
  }
  for (let i = count; i < eliteMarkerPool.length; i++) {
    eliteMarkerPool[i].ring.visible = false;
    eliteMarkerPool[i].beam.visible = false;
  }
}

// Bosses always wear a gold crown marker (ring + beacon) — unlike the
// on-demand red elite markers, these are on whenever a boss is alive, so
// the bounty target is never lost in the horde. Same pooling rules as the
// elite pool: added to `root`, repositioned every frame, survives regens.
const bossMarkerPool = []; // { ring: Mesh, beam: Sprite }

function ensureBossMarker(i) {
  while (bossMarkerPool.length <= i) {
    const ring = new THREE.Mesh(eliteRingGeo, new THREE.MeshBasicMaterial({
      color: 0xffc23a, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    ring.renderOrder = 995;
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    root.add(ring);

    const beam = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffd23a, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    beam.renderOrder = 994;
    beam.visible = false;
    root.add(beam);

    bossMarkerPool.push({ ring, beam });
  }
  return bossMarkerPool[i];
}

function updateBossMarkers(now) {
  let count = 0;
  for (const m of monsters) {
    if (!m.isBoss) continue;
    const { ring, beam } = ensureBossMarker(count++);
    ring.position.set(m.x, m.visualY + 0.05, m.z);
    ring.rotation.z = -now * 1.4;
    const pulse = 1 + 0.12 * Math.sin(now * 2.4 + m.phase);
    ring.scale.setScalar(bodyScale(m) * 1.15 * pulse);
    ring.visible = true;

    beam.position.set(m.x, m.visualY + hpBarOffset(m) + 1.8, m.z);
    beam.scale.set(0.9, 3.8, 1);
    beam.material.opacity = 0.7 + 0.15 * Math.sin(now * 2.4 + m.phase);
    beam.visible = true;
  }
  for (let i = count; i < bossMarkerPool.length; i++) {
    bossMarkerPool[i].ring.visible = false;
    bossMarkerPool[i].beam.visible = false;
  }
}

/* ---------- tower inspector: hover a tower to read its stats ---------- */
// Towers are bought blind otherwise — you can't tell a maxed frost aura from
// a fresh one by looking. Hovering one prints its live numbers and draws the
// exact ground it covers, which is what makes placement a real decision.

let hoveredTower = null;
let towerRangeRing = null;

// Ground-projected outline of a tower's coverage, sampled onto the terrain
// like the Sanctuary ring so it hugs hills instead of cutting through them.
function showTowerRangeRing(t, radius) {
  clearTowerRangeRing();
  const pts = [];
  const steps = 72;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const x = t.x + Math.sin(a) * radius;
    const z = t.z + Math.cos(a) * radius;
    pts.push(new THREE.Vector3(x, heightAt(x, z) + 0.6, z));
  }
  towerRangeRing = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({
      color: TOWER_LOOK[t.kind].bolt, transparent: true, opacity: 0.7, depthWrite: false,
    })
  );
  root.add(towerRangeRing);
}

function clearTowerRangeRing() {
  if (!towerRangeRing) return;
  root.remove(towerRangeRing);
  towerRangeRing.geometry.dispose();
  towerRangeRing.material.dispose();
  towerRangeRing = null;
}

// The stat block for one tower, as HTML rows. Every number is derived live,
// so it reflects the ⭐ picks and Legacy ranks already spent this run.
function towerStatsHtml(t) {
  const def = core.TOWER_TYPES.find((x) => x.key === t.kind);
  const rows = [];
  if (t.kind === "frost") {
    rows.push(["Aura", `${core.frostRadius(turretRangeUps).toFixed(1)} blocks`]);
    rows.push(["Chill", `${core.frostTickDamage(turretRanks()).toFixed(2)} dmg / ${core.FROST_TICK}s`]);
    rows.push(["Slow", `×${core.FROST_SLOW} move speed`]);
    rows.push(["Targets", "everything inside, at once"]);
  } else if (t.kind === "arc") {
    rows.push(["Range", `${turretRange()} blocks`]);
    rows.push(["Damage", `${core.arcDamage(turretRanks()).toFixed(2)} per body`]);
    rows.push(["Fire rate", `${(1 / core.arcCooldown(rateRanks())).toFixed(2)}/s`]);
    rows.push(["Forks", `up to ${core.ARC_CHAIN} bodies, ${core.ARC_JUMP} blocks apart`]);
    rows.push(["Bolt speed", `${Math.round(boltSpeed())} blocks/s`]);
  } else if (t.kind === "lance") {
    rows.push(["Range", `${turretRange()} blocks`]);
    rows.push(["Damage", `${core.lanceDamage(turretRanks()).toFixed(2)} per body`]);
    rows.push(["Fire rate", `${(1 / core.lanceCooldown(rateRanks())).toFixed(2)}/s`]);
    rows.push(["Pierce", `unlimited, ${core.LANCE_WIDTH * 2} blocks wide`]);
  } else {
    rows.push(["Range", `${turretRange()} blocks`]);
    rows.push(["Damage", `${turretDmg().toFixed(2)} per bolt`]);
    rows.push(["Fire rate", `${(1 / turretCooldown()).toFixed(2)}/s`]);
    rows.push(["DPS", `${(turretDmg() / turretCooldown()).toFixed(2)}`]);
    rows.push(["Bolt speed", `${Math.round(boltSpeed())} blocks/s`]);
  }
  return `<div class="tip-title">${def.icon} ${def.name}</div>
    <div class="tip-desc">${def.desc}</div>
    ${rows.map(([k, v]) => `<div class="tip-row"><span>${k}</span><span>${v}</span></div>`).join("")}
    <div class="tip-foot">Armor-ignoring · upgraded by 🎯 📡 ⏩ 🚀 picks</div>`;
}

// Raycast the cursor against the standing towers; show/hide the panel. Runs
// off the same pointermove as the aim indicator, so it costs one extra
// raycast against a handful of groups.
function updateTowerHover() {
  const tip = document.getElementById("vx-tower-tip");
  if (!tip) return;
  let hit = null;
  if (hoverClientX !== null && turrets.length) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((hoverClientX - rect.left) / rect.width) * 2 - 1,
      -((hoverClientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(turrets.map((t) => t.group), true);
    if (hits.length) {
      // Walk back up to the group the hit mesh belongs to.
      hit = turrets.find((t) => {
        let o = hits[0].object;
        while (o) { if (o === t.group) return true; o = o.parent; }
        return false;
      }) || null;
    }
  }
  if (hit !== hoveredTower) {
    hoveredTower = hit;
    clearTowerRangeRing();
    if (hit) showTowerRangeRing(hit, hit.kind === "frost" ? core.frostRadius(turretRangeUps) : turretRange());
  }
  if (!hit) { tip.classList.remove("show"); return; }
  tip.innerHTML = towerStatsHtml(hit);
  // Pin the panel to the cursor, flipping it before it can run off-screen.
  const pad = 14;
  const flipX = hoverClientX > window.innerWidth - 260;
  const flipY = hoverClientY > window.innerHeight - 200;
  tip.style.left = `${flipX ? hoverClientX - 240 - pad : hoverClientX + pad}px`;
  tip.style.top = `${flipY ? hoverClientY - 190 : hoverClientY + pad}px`;
  tip.classList.add("show");
}

function updateAimIndicator() {
  updateTowerHover();
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
  // First shot fired: the phone layout uses this to fade the how-to hint.
  document.body.classList.add("played");
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
  const R = maxUnlockedBlast;
  const cx = Math.round(bx), cz = Math.round(bz);
  const span = Math.ceil(R);
  for (let dz = -span; dz <= span; dz++) {
    for (let dx = -span; dx <= span; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= GRID || z >= GRID) continue; // stay in array bounds only — edges are destructible too
      const d = Math.hypot(dx, dz);
      // Distance falloff × the blast-damage stat (core.craterBlockDamage):
      // damage ranks punch through whole strata per shot, so a damage build
      // leaves genuinely deeper scars on the map than a radius build.
      const dmg = core.craterBlockDamage(d, R, blastDamage);
      if (dmg > 0) applyDamage(z * GRID + x, dmg);
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

  shake = Math.min(4.5, shake + 0.25 + maxUnlockedBlast * 0.45 + (blastDamage - 1) * 0.2);
  playExplosion(maxUnlockedBlast + (blastDamage - 1)); // damage ranks deepen the boom too

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
  // More rock flies as damage ranks up — the crater got deeper, after all.
  const debrisCount = Math.min(40, 8 + maxUnlockedBlast * 2 + (blastDamage - 1) * 3);
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
      // A lance beam: holds its line and thins out, so the swept lane stays
      // legible for the instant it's on screen.
      case "beam": {
        p.obj.material.opacity = 0.75 * (1 - t) * (1 - t);
        p.obj.scale.y = 1 - 0.6 * t;
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

  // Unified mouse + touch input via Pointer Events.
  // Mouse: hover aims, left-drag orbits, Cmd/⌥+drag pans, quick click fires.
  // Touch: a held finger shows the blast footprint and firing happens on
  // release-in-place (no time limit — deliberate aiming is allowed), a
  // one-finger drag orbits, two fingers pan the map and pinch to zoom.
  const activePointers = new Map(); // pointerId -> {x, y}
  let primaryPointerId = null;
  let touchAiming = false; // held touch that hasn't turned into a drag yet
  let multiTouched = false; // once true, this gesture can never fire on release
  let pinchStartDist = 0, pinchStartZoom = 1, lastMidX = 0, lastMidY = 0;
  const dragSlop = (type) => (type === "mouse" ? 6 : 11); // fingers wobble more than mice
  // The phone layout hides the settings panel behind a drawer (see voxel.css);
  // while it's open, a tap on the world closes it instead of firing.
  const phoneLayout = window.matchMedia("(max-width: 760px), (max-height: 520px)");

  function panCamera(dxPix, dyPix) {
    // Grab-the-world pan: the terrain follows the pointer on BOTH axes
    // (drag right → world slides right), matching every hand-tool and
    // touch map. The camera therefore moves opposite the drag. Keyboard
    // pan (WASD) keeps its own move-the-camera signs — keys steer, drags
    // grab.
    // Free pan — no bounds. Digging has no floor, so the camera can't have
    // one either: clamping the target made deep pits and the map's
    // underside literally unviewable.
    const scale = 0.045 / zoomLevel;
    const fwd = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta)); // toward viewer ≈ screen-down
    const right = new THREE.Vector3(Math.sin(theta), 0, -Math.cos(theta)); // screen-right
    target.addScaledVector(right, -dxPix * scale);
    target.addScaledVector(fwd, -dyPix * scale);
  }

  // (Re-)anchor the two-finger gesture: called when a second finger lands
  // AND when a third lifts, so the surviving pair never causes a zoom jump.
  function beginPinch() {
    const pts = [...activePointers.values()];
    pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    pinchStartZoom = zoomLevel;
    lastMidX = (pts[0].x + pts[1].x) / 2;
    lastMidY = (pts[0].y + pts[1].y) / 2;
  }

  function updatePinch() {
    const pts = [...activePointers.values()];
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
    // Same practically-unbounded zoom range as the wheel handler below.
    zoomLevel = Math.min(40, Math.max(0.05, pinchStartZoom * (d / pinchStartDist)));
    onResize();
    // Two-finger drag pans too — panCamera is grab-the-world, so raw
    // deltas already make the terrain follow the fingers.
    panCamera(midX - lastMidX, midY - lastMidY);
    lastMidX = midX; lastMidY = midY;
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.pointerType !== "mouse") e.preventDefault(); // no compat mouse events
    // Tapping the world should dismiss the seed input's keyboard on phones.
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur?.();
    }
    canvas.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1) {
      primaryPointerId = e.pointerId;
      multiTouched = false;
      dragging = true;
      panDragging = e.metaKey || e.altKey; // Cmd/Option+drag pans instead of orbiting
      lastX = e.clientX; lastY = e.clientY;
      clickStartX = e.clientX; clickStartY = e.clientY; clickStartT = performance.now();
      if (e.pointerType !== "mouse") {
        // Touch has no hover — show the blast footprint under the held finger.
        touchAiming = true;
        hoverClientX = e.clientX; hoverClientY = e.clientY;
        updateAimIndicator();
      }
    } else {
      // Second finger down: the gesture is now pan/zoom — never a shot.
      multiTouched = true;
      dragging = false;
      clickStartX = null;
      touchAiming = false;
      hoverClientX = null; hoverClientY = null;
      hideAllHighlights();
      if (activePointers.size === 2) beginPinch();
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const p = activePointers.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }

    if (activePointers.size >= 2) {
      if (p) updatePinch();
      return;
    }

    if (p && e.pointerId === primaryPointerId) {
      const dxPix = e.clientX - lastX, dyPix = e.clientY - lastY;
      const moved = clickStartX !== null &&
        Math.hypot(e.clientX - clickStartX, e.clientY - clickStartY) > dragSlop(e.pointerType);
      if (touchAiming && !moved) {
        // Finger still held in place: keep aiming, don't orbit yet.
        hoverClientX = e.clientX; hoverClientY = e.clientY;
        lastX = e.clientX; lastY = e.clientY;
        updateAimIndicator();
        return;
      }
      if (touchAiming && moved) {
        // It's a drag after all — drop the aim preview and start orbiting.
        touchAiming = false;
        hoverClientX = null; hoverClientY = null;
        hideAllHighlights();
      }
      if (panDragging) {
        panCamera(dxPix, dyPix);
      } else {
        // Touch is direct manipulation — the scene follows the finger — so
        // its orbit runs opposite to the mouse's move-the-camera scheme.
        const orbitDir = e.pointerType === "mouse" ? 1 : -1;
        theta -= dxPix * 0.006 * orbitDir;
        // Near-full vertical orbit: from almost level with the horizon (you
        // can look at the terrain edge-on, even slightly from below) to
        // almost straight down. Only an epsilon off the exact poles, where
        // the orbit math degenerates.
        phi = Math.min(1.55, Math.max(0.02, phi - dyPix * 0.006 * orbitDir));
      }
      lastX = e.clientX; lastY = e.clientY;
    }

    if (e.pointerType === "mouse") {
      hoverClientX = e.clientX; hoverClientY = e.clientY;
      updateAimIndicator();
    }
  });

  function releasePointer(e, allowClick) {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.delete(e.pointerId);
    if (e.pointerId === primaryPointerId) {
      primaryPointerId = null;
      dragging = false;
      if (allowClick && clickStartX !== null && !multiTouched) {
        const movedDist = Math.hypot(e.clientX - clickStartX, e.clientY - clickStartY);
        const elapsed = performance.now() - clickStartT;
        // Mouse keeps the quick-click time limit; touch deliberately has
        // none — press-and-hold to aim, release to fire.
        if (movedDist < dragSlop(e.pointerType) && (e.pointerType !== "mouse" || elapsed < 400)) {
          const overlayOpen = phoneLayout.matches &&
            (document.body.classList.contains("hud-open") || document.body.classList.contains("contracts-open"));
          if (overlayOpen) {
            // Tap on the world closes whatever phone overlay is up — it
            // must never double as a missile through the panel.
            document.body.classList.remove("hud-open");
            document.body.classList.remove("contracts-open");
          } else {
            queueClick(e.clientX, e.clientY);
          }
        }
      }
      clickStartX = null;
    }
    if (e.pointerType !== "mouse") {
      touchAiming = false;
      hoverClientX = null; hoverClientY = null;
      hideAllHighlights();
    }
    if (activePointers.size === 2) {
      beginPinch(); // a third finger lifted — re-anchor the remaining pair
    } else if (activePointers.size === 1) {
      // Pinch ended with one finger still down: it continues as an orbit drag.
      const [id, p] = activePointers.entries().next().value;
      primaryPointerId = id;
      dragging = true;
      panDragging = false;
      lastX = p.x; lastY = p.y;
      clickStartX = null; // a leftover pinch finger is never a tap
    } else if (activePointers.size === 0) {
      multiTouched = false;
      pinchStartDist = 0;
    }
  }
  canvas.addEventListener("pointerup", (e) => releasePointer(e, true));
  canvas.addEventListener("pointercancel", (e) => releasePointer(e, false));
  canvas.addEventListener("pointerleave", (e) => {
    // Mouse hover left the canvas (drags hold pointer capture, so this is
    // hover-only): drop the aim indicator.
    if (e.pointerType === "mouse" && !activePointers.has(e.pointerId)) {
      hoverClientX = null; hoverClientY = null;
      hideAllHighlights();
    }
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press menu on touch
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    // Practically unbounded zoom — wide enough to frame the whole map from
    // afar or fill the screen with a single block.
    zoomLevel = Math.min(40, Math.max(0.05, zoomLevel * factor));
    onResize();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    // Typing in the seed box (or any control) must never pan/regenerate/pause.
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    keys[e.key.toLowerCase()] = true;
    if (e.key.toLowerCase() === "r") restartRun();
    if (e.key.toLowerCase() === "p") togglePause();
    // Spend a banked upgrade point without mousing away from the fight —
    // chooseUpgrade itself no-ops when nothing is pending.
    if (e.key === "1") chooseUpgrade("radius");
    if (e.key === "2") chooseUpgrade("damage");
    if (e.key === "3") chooseUpgrade("turretdmg");
    if (e.key === "4") chooseUpgrade("turretrange");
    if (e.key === "5") chooseUpgrade("turretrate");
    if (e.key === "6") chooseUpgrade("boltspeed");
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
  // dragging, each mirrored into its readout label. Config lives in the
  // module-level TWEAK_SLIDERS table so resetTweaksToDefaults() shares it.
  for (const s of TWEAK_SLIDERS) {
    const el = document.getElementById(s.id);
    const label = document.getElementById(s.id + "-val");
    el.addEventListener("input", () => {
      const v = Number(el.value);
      label.textContent = s.fmt(v);
      s.apply(v);
    });
  }
  document.getElementById("vx-spawn-one").addEventListener("click", () => spawnRandomZombie());
  document.getElementById("vx-new-terrain").addEventListener("click", () => {
    const seedInput2 = document.getElementById("vx-seed");
    seedInput2.value = Math.random().toString(36).slice(2, 9);
    generateWorld(seedInput2.value, biomeSelect.value, true);
  });
  document.getElementById("vx-kill-all").addEventListener("click", () => {
    for (const m of monsters) {
      monsterGroup.remove(m.rig.root);
      disposeRig(m.rig);
      disposeZombieMaterials(m.mats);
      disposeMonsterUi(m);
    }
    monsters = [];
    pendingSpawns = [];
    updateZombieBoard();
  });

  document.getElementById("vx-go-restart").addEventListener("click", restartRun);
  document.getElementById("vx-up-radius")?.addEventListener("click", () => chooseUpgrade("radius"));
  document.getElementById("vx-up-damage")?.addEventListener("click", () => chooseUpgrade("damage"));
  document.getElementById("vx-up-turretdmg")?.addEventListener("click", () => chooseUpgrade("turretdmg"));
  document.getElementById("vx-up-turretrange")?.addEventListener("click", () => chooseUpgrade("turretrange"));
  document.getElementById("vx-up-turretrate")?.addEventListener("click", () => chooseUpgrade("turretrate"));
  document.getElementById("vx-up-boltspeed")?.addEventListener("click", () => chooseUpgrade("boltspeed"));
  document.getElementById("vx-shop-repair").addEventListener("click", buyRepair);
  document.getElementById("vx-shop-turret").addEventListener("click", buyTurret);
  document.getElementById("vx-shop-frost").addEventListener("click", buyFrostTower);
  document.getElementById("vx-shop-arc").addEventListener("click", buyArcTower);
  document.getElementById("vx-shop-lance").addEventListener("click", buyLanceTower);
  document.getElementById("vx-shop-ward").addEventListener("click", buyWard);
  document.getElementById("vx-shop-mine").addEventListener("click", buyMine);
  document.getElementById("vx-shop-slow").addEventListener("click", buySlow);

  // Mobile chrome: settings-drawer toggle, pause button, pause-overlay
  // actions (phones have no P/R keys). All work with a mouse too.
  // The two phone overlays (settings drawer, contracts list) are mutually
  // exclusive — opening one closes the other so panels never stack.
  document.getElementById("vx-menu-btn")?.addEventListener("click", () => {
    document.body.classList.toggle("hud-open");
    document.body.classList.remove("contracts-open");
  });
  document.getElementById("vx-contracts-btn")?.addEventListener("click", () => {
    document.body.classList.toggle("contracts-open");
    document.body.classList.remove("hud-open");
  });
  document.getElementById("vx-pause-btn")?.addEventListener("click", togglePause);
  document.getElementById("vx-resume-btn")?.addEventListener("click", togglePause);
  document.getElementById("vx-pause-newrun")?.addEventListener("click", restartRun);
  // Back to the title (also the only way to switch Ranked/Sandbox mid-session).
  document.getElementById("vx-pause-menu")?.addEventListener("click", goToTitle);
  document.getElementById("vx-go-menu")?.addEventListener("click", goToTitle);

  // Mobile browsers only allow audio to start inside a user gesture — see
  // unlockAudio. Every pointerdown re-checks, which also recovers the
  // context after an iOS audio-session interruption.
  window.addEventListener("pointerdown", unlockAudio);

  // Real-game behavior: losing the tab/window (alt-tab, phone lock, Steam
  // overlay) auto-pauses instead of letting the Heart die unattended.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && gameState === "playing") togglePause();
  });

  // Title screen: play, difficulty, settings — controls seeded from the
  // persisted settings so the menu reflects what's actually active.
  document.getElementById("vx-title-play").addEventListener("click", startFromTitle);
  for (const btn of document.querySelectorAll(".diff-btn")) {
    btn.addEventListener("click", () => {
      if (mode === "daily") return; // dailies are always ⚔️ Normal
      chosenDifficulty = btn.dataset.diff;
      difficulty = chosenDifficulty;
      for (const b of document.querySelectorAll(".diff-btn")) b.classList.toggle("active", b === btn);
      saveSettings();
    });
  }

  // Ranked / Daily / Sandbox selector — mirrors the persisted mode into the
  // title controls (active button, play-button label, the "what's saved"
  // note, and the difficulty row, which Daily locks to Normal).
  const modeNote = document.getElementById("vx-mode-note");
  const updateModeUi = () => {
    for (const b of document.querySelectorAll(".mode-btn")) b.classList.toggle("active", b.dataset.mode === mode);
    const playBtn = document.getElementById("vx-title-play");
    if (playBtn) {
      playBtn.textContent = mode === "sandbox" ? "🧪 Enter Sandbox"
        : mode === "daily" ? "📅 Play Today's Daily"
        : "▶ Defend the Heart";
    }
    if (modeNote) {
      if (mode === "sandbox") {
        modeNote.textContent = "Free experimentation — nothing is saved.";
      } else if (mode === "daily") {
        const today = todayStr();
        const playedToday = daily.lastDay === today;
        const bits = [`One fixed world per day (${today})`];
        if (daily.streak > 0) bits.push(`🔥 ${daily.streak}-day streak`);
        bits.push(playedToday ? `today's best: ${daily.todayBest}` : "not played yet — keep the flame alive!");
        modeNote.textContent = bits.join(" · ");
      } else {
        modeNote.textContent = "Best score, achievements & shards are saved.";
      }
    }
    const diffLocked = mode === "daily";
    for (const b of document.querySelectorAll(".diff-btn")) {
      b.disabled = diffLocked;
      b.classList.toggle("active", diffLocked ? b.dataset.diff === "normal" : b.dataset.diff === chosenDifficulty);
    }
  };
  for (const btn of document.querySelectorAll(".mode-btn")) {
    btn.addEventListener("click", () => {
      mode = btn.dataset.mode;
      updateModeUi();
      saveSettings();
    });
  }
  refreshModeUi = updateModeUi;
  updateModeUi();

  // 📊 Stats and 🏆 Achievements fold-out panels on the title screen —
  // mutually exclusive so the panel never grows past the viewport.
  const statsBtn = document.getElementById("vx-stats-btn");
  const achBtn = document.getElementById("vx-ach-btn");
  const statsPanel = document.getElementById("vx-stats-panel");
  const achPanel = document.getElementById("vx-ach-panel");
  statsBtn?.addEventListener("click", () => {
    const open = statsPanel?.classList.toggle("show");
    achPanel?.classList.remove("show");
    achBtn?.classList.remove("active");
    statsBtn.classList.toggle("active", !!open);
    renderStatsPanel();
  });
  achBtn?.addEventListener("click", () => {
    const open = achPanel?.classList.toggle("show");
    statsPanel?.classList.remove("show");
    statsBtn?.classList.remove("active");
    achBtn.classList.toggle("active", !!open);
    renderAchievementsPanel();
  });
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
    updateMines();
    processPendingSpawns(now);
    updateWaves(dt * simSpeed);
    updateMutations(dt * simSpeed);
    checkCondensation();
    refreshSanctuaryRingHeights(dt);
    // Slow-field dome: sits on the Heart while active, vanishes after.
    if (slowDome && heart) {
      const active = now < slowUntil;
      if (slowDome.visible && !active) updateShopHud(); // just expired — re-enable the buy button
      slowDome.visible = active;
      if (active) {
        slowDome.position.set(heart.x, heart.y, heart.z);
        slowDome.material.opacity = 0.08 + 0.05 * Math.sin(now * 3);
      }
    }
  } else {
    clickQueue = [];
  }
  if (gameState !== "paused") {
    updateHeart(now);
    updateMissiles(dt);
    updateFx(dt);
  }
  updateComboHud(now);
  updateCamera();
  renderer.render(scene, camera);
}

// Abandon the current run and return to the title (from pause or game-over).
// The sim freezes behind the menu; picking a mode + Play starts a fresh run.
function goToTitle() {
  flushRunStats(); // an abandoned run still counts toward lifetime stats
  document.getElementById("vx-gameover")?.classList.remove("show");
  document.getElementById("vx-paused")?.classList.remove("show");
  showTitle();
}

// The pre-run menu: world renders and idles behind it, sim frozen until
// Play. Doubles as the settings + difficulty + stats/achievements screen.
function showTitle() {
  gameState = "menu";
  const meta = document.getElementById("vx-title-meta");
  if (meta) {
    let best = 0;
    try { best = Number(localStorage.getItem("vx-best-score") || 0); } catch { /* fresh */ }
    const unlocked = Object.keys(unlockedAchievements).length;
    const streakBit = daily.streak > 0 ? ` · 📅 <b>${daily.streak}</b>-day streak` : "";
    meta.innerHTML =
      `Best score: <b>${core.fmtNum(best)}</b> · Achievements: <b>${unlocked}/${Object.keys(ACHIEVEMENTS).length}</b>` +
      ` · Legacy shards: <b>${core.fmtNum(legacy.shards)}</b>${streakBit}`;
  }
  renderStatsPanel();
  renderAchievementsPanel();
  refreshModeUi(); // daily note/streak may have changed since the last visit
  document.getElementById("vx-title")?.classList.add("show");
}

// Bound to the real updater inside init() (it closes over title DOM); a
// no-op until then so early showTitle callers are safe.
let refreshModeUi = () => {};

// Lifetime numbers, rendered into the title's 📊 panel.
function renderStatsPanel() {
  const el = document.getElementById("vx-stats-panel");
  if (!el) return;
  const s = lifeStats;
  const hours = Math.floor(s.timePlayed / 3600), minutes = Math.floor((s.timePlayed % 3600) / 60);
  const rows = [
    ["Runs", core.fmtNum(s.runs)],
    ["Zombies destroyed", core.fmtNum(s.kills)],
    ["Bosses slain", core.fmtNum(s.bosses)],
    ["Best wave", s.bestWave || "—"],
    ["Waves survived (total)", core.fmtNum(s.totalWaves)],
    ["Best combo", s.bestCombo >= 2 ? `×${s.bestCombo}` : "—"],
    ["Contracts completed", s.contractsDone],
    ["Dailies played", s.dailies],
    ["Time defending", hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`],
  ];
  el.innerHTML = rows
    .map(([k, v]) => `<div class="subpanel-row"><span>${k}</span><span>${v}</span></div>`)
    .join("");
}

// The full trophy cabinet: every achievement, unlocked ones lit up.
function renderAchievementsPanel() {
  const el = document.getElementById("vx-ach-panel");
  if (!el) return;
  el.innerHTML = Object.entries(ACHIEVEMENTS)
    .map(([key, label]) => {
      const got = !!unlockedAchievements[key];
      return `<div class="subpanel-row ach${got ? " got" : ""}">` +
        `<span>${got ? "🏆" : "🔒"}</span><span>${label.replace(/^🏆 /, "")}</span></div>`;
    })
    .join("");
}

// Kick off today's fixed daily board: streak bookkeeping, then the
// day-seeded world (generateWorld → resetRun starts the fresh run).
function startDailyRun() {
  const today = todayStr();
  daily = core.updateDailyOnPlay(daily, today);
  saveDaily();
  if (daily.streak >= 3) unlockAchievement("streak-3");
  difficulty = "normal"; // dailies are a level playing field
  const seedInput = document.getElementById("vx-seed");
  const biomeSelect = document.getElementById("vx-biome");
  if (seedInput) seedInput.value = core.dailySeed(today);
  if (biomeSelect) biomeSelect.value = core.dailyBiome(today);
  generateWorld(core.dailySeed(today), core.dailyBiome(today));
  target.set(GRID / 2, 0, GRID / 2);
}

function startFromTitle() {
  document.getElementById("vx-title")?.classList.remove("show");
  if (mode === "daily") {
    startDailyRun();
    return;
  }
  difficulty = chosenDifficulty;
  gameState = "playing";
  // Menu time doesn't count as survival, and difficulty may have changed —
  // rebuild the Heart at the (possibly rescaled) full HP and restart clocks.
  resetRun();
}

// "New run" (game-over, pause, R key): a fresh random world in ranked and
// sandbox, but the SAME fixed board in daily — replaying today's world is
// the whole point of a daily.
function restartRun() {
  if (gameState === "menu") return; // the title's Play button owns starts
  if (mode === "daily") startDailyRun();
  else regenerate(true);
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
  updateUpgradeChooser(); // hidden while paused, back if points remain
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
