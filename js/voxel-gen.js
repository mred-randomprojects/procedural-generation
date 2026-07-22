import * as THREE from "three";
import { buildBlockMaterials, disposeBlockMaterials, buildZombieMaterials, disposeZombieMaterials } from "./voxel-textures.js";
import { playExplosion, playZombieKill } from "./voxel-audio.js";

/* ---------- Biome presets ---------- */

const BIOMES = {
  plains: {
    scale: 1.6, octaves: 4, heightMul: 4, baseHeight: 4,
    seaLevel: -1, treeDensity: 0.02,
    top: 0x6cbf4f, sub: 0x8a5a34, rock: 0x8a8a8a,
    sand: 0xdccb7a, snowLine: 999, snow: 0xffffff,
    water: 0x3a7bd5, sky: [0x9fd6ff, 0xd8f0ff],
  },
  desert: {
    scale: 2.0, octaves: 4, heightMul: 3, baseHeight: 3,
    seaLevel: -3, treeDensity: 0.0,
    top: 0xe3c877, sub: 0xcaa85c, rock: 0x9c8452,
    sand: 0xe3c877, snowLine: 999, snow: 0xffffff,
    water: 0x2f7fb0, sky: [0xffd9a0, 0xfff2d8],
  },
  snowy: {
    scale: 1.8, octaves: 4, heightMul: 5, baseHeight: 5,
    seaLevel: -1, treeDensity: 0.012,
    top: 0xf4f8fb, sub: 0x8a5a34, rock: 0x8f97a0,
    sand: 0xe7edf2, snowLine: 2, snow: 0xffffff,
    water: 0x3f6f9c, sky: [0xbcd7e8, 0xeaf4fb],
  },
  islands: {
    scale: 1.5, octaves: 5, heightMul: 6, baseHeight: 1,
    seaLevel: 1, treeDensity: 0.03,
    top: 0x5fc25a, sub: 0x8a6a34, rock: 0x7f7f7f,
    sand: 0xe8d692, snowLine: 999, snow: 0xffffff,
    water: 0x2489c9, sky: [0x7fd6ff, 0xd0f4ff],
  },
  mountains: {
    scale: 1.6, octaves: 5, heightMul: 14, baseHeight: 4,
    seaLevel: -2, treeDensity: 0.015,
    top: 0x5c9a4b, sub: 0x7a5a3a, rock: 0x767b80,
    sand: 0xd4c483, snowLine: 9, snow: 0xffffff,
    water: 0x2f6fa8, sky: [0x8fb8e0, 0xdcecfb],
  },
  swamp: {
    scale: 3.4, octaves: 3, heightMul: 3, baseHeight: 2,
    seaLevel: 0, treeDensity: 0.025,
    top: 0x5a7a3f, sub: 0x4a3c28, rock: 0x6f6f60,
    sand: 0xa9a06a, snowLine: 999, snow: 0xffffff,
    water: 0x4a6b4a, sky: [0xaebfa0, 0xd8e2c8],
  },
};

const GRID = 44;
const DEPTH_LAYERS = 4; // rendered layers below the surface, deep enough for side views

const MONSTER_COUNT = 9;
const MAX_MONSTERS = 26;
const MERGE_DIST = 0.85;
const MIN_BLAST = 1, MAX_BLAST = 8;
const REGEN_DELAY = 6;    // seconds of no explosions before terrain starts healing
const REGEN_INTERVAL = 0.5; // seconds between regrowth ticks

let renderer, scene, camera, root;
let blockMeshes, blockGeo, water, activeMaterials;
let dragging = false, lastX = 0, lastY = 0;
let clickStartX = null, clickStartY = null, clickStartT = 0;
let theta = Math.PI / 4, phi = 0.95, dist = 46, zoomLevel = 1;
let target = new THREE.Vector3(GRID / 2, 0, GRID / 2);
const keys = {};

let monsterGroup, monsters = [];
let treeGroup, treeList = [];
let currentHeights = null, originalHeights = null, currentSeaLevel = -99, currentBiome = null, scorched = null;
let currentSeed = "terra", monsterIdCounter = 0;
let lastTime = 0;
let panHoldTime = 0;
let blastRadius = 3;
let shake = 0;
let killCount = 0, money = 0;
let lastExplosionTime = -999, regenTimer = 0;
let lastBlastX = 0, lastBlastZ = 0;

let raycaster, missiles = [], fx = [];
let missileGeo, missileMat;

function heightAt(x, z) {
  const xi = Math.max(0, Math.min(GRID - 1, Math.round(x)));
  const zi = Math.max(0, Math.min(GRID - 1, Math.round(z)));
  return currentHeights ? currentHeights[zi * GRID + xi] : 0;
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
      hp: 1, elite: false,
    });
  }
  killCount = 0;
  money = 0;
  updateScoreHud();
}

// Spawns one fresh zombie at a random valid spot — used to replace a killed one.
function spawnRandomZombie() {
  if (monsters.length >= MAX_MONSTERS) return;
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
    hp: 1, elite: false,
  });
}

// Two regular zombies that wander into each other fuse into one bigger,
// tougher "elite" zombie that takes two hits to put down.
function mergeZombies(a, b) {
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  monsterGroup.remove(a.rig.root, b.rig.root);
  disposeZombieMaterials(a.mats);
  disposeZombieMaterials(b.mats);
  monsters.splice(monsters.indexOf(b), 1);
  monsters.splice(monsters.indexOf(a), 1);

  spawnMergeFx(mx, heightAt(mx, mz) + 1, mz);

  const mats = buildZombieMaterials(currentSeed, monsterIdCounter++);
  const rig = createZombieMesh(mats);
  rig.root.scale.setScalar(1.45);
  monsterGroup.add(rig.root);
  monsters.push({
    rig, mats, x: mx, z: mz,
    angle: Math.random() * Math.PI * 2,
    speed: 0.75 + Math.random() * 0.5,
    timer: Math.random() * 2,
    phase: Math.random() * Math.PI * 2,
    walkPhase: Math.random() * Math.PI * 2,
    hp: 2, elite: true,
  });
}

function checkZombieMerges() {
  for (let i = 0; i < monsters.length; i++) {
    const a = monsters[i];
    if (a.elite) continue;
    for (let j = i + 1; j < monsters.length; j++) {
      const b = monsters[j];
      if (b.elite) continue;
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
  const moneyEl = document.getElementById("vx-money-val");
  if (moneyEl) moneyEl.textContent = "$" + String(money);
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
    const ground = heightAt(m.x, m.z);
    const bounce = Math.sin(now * 2.2 + m.phase) * 0.04;
    m.rig.root.position.set(m.x, ground + 0.5 + bounce, m.z);
    m.rig.root.rotation.y = m.angle;

    if (moving) m.walkPhase += dt * m.speed * 3.2;
    const swing = Math.sin(m.walkPhase) * 0.5;
    m.rig.legL.rotation.x = swing;
    m.rig.legR.rotation.x = -swing;
    m.rig.armL.rotation.x = -1.15 - swing * 0.3;
    m.rig.armR.rotation.x = -1.15 + swing * 0.3;
  }
}

function killMonstersNear(bx, bz, r) {
  let kills = 0, earned = 0;
  for (let i = monsters.length - 1; i >= 0; i--) {
    const m = monsters[i];
    if (Math.hypot(m.x - bx, m.z - bz) > r + 1) continue;
    m.hp -= 1;
    if (m.hp > 0) {
      spawnHitFlinch(m); // elite survives a hit — knock it back and flash it
      continue;
    }
    monsterGroup.remove(m.rig.root);
    disposeZombieMaterials(m.mats);
    spawnGibs(m.x, heightAt(m.x, m.z) + 0.9, m.z);
    monsters.splice(i, 1);
    kills++;
    earned += m.elite ? 25 : 10;
  }
  if (kills > 0) {
    playZombieKill();
    killCount += kills;
    money += earned;
    updateScoreHud();
    let toSpawn = kills * 2;
    while (toSpawn-- > 0) spawnRandomZombie();
  }
}

// A zombie that survived a hit (elites need two): knock it back from the
// blast and pop a couple of sparks so the hit still reads as impactful.
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

function layerType(biome, y, height) {
  if (y === height) {
    if (height <= biome.seaLevel + 1) return "sand";
    if (height >= biome.snowLine) return "snow";
    return "grass";
  }
  if (y >= height - 1) return "sub";
  return "rock";
}

function clearGroup(group) {
  while (group.children.length) {
    const c = group.children.pop();
    c.traverse((obj) => { obj.geometry?.dispose?.(); });
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
      else c.material.dispose();
    }
  }
}

// Rebuilds the terrain InstancedMeshes from currentHeights/scorched. Called on
// world generation and again after every explosion edits the terrain.
function rebuildBlockMeshes() {
  const biome = currentBiome;
  const heights = currentHeights;
  const { materials, variantCounts } = activeMaterials;

  const buckets = new Map();
  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      const idx = z * GRID + x;
      const height = heights[idx];
      const bottom = Math.max(0, height - DEPTH_LAYERS + 1);
      for (let y = height; y >= bottom; y--) {
        let type = layerType(biome, y, height);
        if (y === height && scorched[idx]) type = "charred";
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
  originalHeights = currentHeights.slice();
  scorched = new Uint8Array(GRID * GRID);
  lastExplosionTime = -999;
  regenTimer = 0;
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
  scene.fog = new THREE.Fog(biome.sky[1], 40, 90);

  // clear any missiles/fx left over from the previous world
  for (const m of missiles) root.remove(m.mesh);
  missiles = [];
  for (const p of fx) {
    root.remove(p.obj);
    p.obj.geometry?.dispose?.();
    p.obj.material?.dispose?.();
  }
  fx = [];

  spawnMonsters(biome, currentHeights, seed);
}

/* ---------- missiles & explosions ---------- */

const MISSILE_COOLDOWN = 0.5;
let lastFireTime = -999;

function tryFireMissile(clientX, clientY) {
  const now = performance.now() / 1000;
  if (now - lastFireTime < MISSILE_COOLDOWN) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(blockMeshes, false);
  if (!hits.length) return;
  lastFireTime = now;
  fireMissile(hits[0].point.x, hits[0].point.y, hits[0].point.z);
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
function craterEdit(bx, bz) {
  const R = blastRadius, R2 = R + 1.6;
  const cx = Math.round(bx), cz = Math.round(bz);
  const span = Math.ceil(R2);
  for (let dz = -span; dz <= span; dz++) {
    for (let dx = -span; dx <= span; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 1 || z < 1 || x >= GRID - 1 || z >= GRID - 1) continue;
      const d = Math.hypot(dx, dz);
      if (d > R2) continue;
      const idx = z * GRID + x;
      if (d <= R) {
        const carve = Math.max(1, Math.round((R - d) * 0.85 + 1));
        currentHeights[idx] = Math.max(0, currentHeights[idx] - carve);
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
  lastExplosionTime = performance.now() / 1000;

  craterEdit(bx, bz);
  destroyTreesNear(bx, bz, blastRadius);
  killMonstersNear(bx, bz, blastRadius);
  rebuildBlockMeshes();

  shake = Math.min(4.5, shake + 0.25 + blastRadius * 0.45);
  playExplosion(blastRadius);

  const center = new THREE.Vector3(bx, groundYBefore, bz);

  const light = new THREE.PointLight(0xffb060, 10, blastRadius * 6 + 8, 2);
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
  fx.push({ type: "fireball", obj: fireball, age: 0, life: 0.4, maxR: blastRadius * 0.9 + 1.2 });

  const ringGeo = new THREE.RingGeometry(0.6, 1, 32);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xfff2c8, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(bx, groundYBefore + 0.05, bz);
  root.add(ring);
  fx.push({ type: "ring", obj: ring, age: 0, life: 0.6, maxR: blastRadius * 1.6 + 2 });

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
      center.x + (Math.random() - 0.5) * blastRadius * 0.7,
      groundYBefore + 0.3,
      center.z + (Math.random() - 0.5) * blastRadius * 0.7
    );
    root.add(s);
    fx.push({
      type: "smoke", obj: s, age: -Math.random() * 0.3, life: 1.6 + Math.random() * 1.2,
      vy: 0.7 + Math.random() * 0.8, growTo: 1.6 + Math.random() * 1.4,
    });
  }

  const debrisColor = currentBiome.rock;
  const debrisCount = Math.min(24, 8 + blastRadius * 2);
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
    const ox = (Math.random() - 0.5) * blastRadius * 1.1;
    const oz = (Math.random() - 0.5) * blastRadius * 1.1;
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
      p.obj.geometry?.dispose?.();
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
    }
  }
}

function setBlastRadius(r) {
  blastRadius = Math.max(MIN_BLAST, Math.min(MAX_BLAST, r));
  const label = document.getElementById("vx-radius-val");
  if (label) label.textContent = String(blastRadius);
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

  blockGeo = new THREE.BoxGeometry(1, 1, 1);
  raycaster = new THREE.Raycaster();

  missileGeo = new THREE.ConeGeometry(0.14, 0.6, 8);
  missileGeo.rotateX(-Math.PI / 2); // tip points toward -Z so lookAt() aims it correctly
  missileMat = new THREE.MeshLambertMaterial({ color: 0x445055 });

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
    lastX = e.clientX; lastY = e.clientY;
    clickStartX = e.clientX; clickStartY = e.clientY; clickStartT = performance.now();
  });
  window.addEventListener("mouseup", (e) => {
    dragging = false;
    if (clickStartX === null) return;
    const moved = Math.hypot(e.clientX - clickStartX, e.clientY - clickStartY);
    const elapsed = performance.now() - clickStartT;
    if (moved < 6 && elapsed < 400) tryFireMissile(e.clientX, e.clientY);
    clickStartX = null;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    theta -= (e.clientX - lastX) * 0.006;
    phi = Math.min(1.45, Math.max(0.25, phi - (e.clientY - lastY) * 0.006));
    lastX = e.clientX; lastY = e.clientY;
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
    if (e.key === "+" || e.key === "=") setBlastRadius(blastRadius + 1);
    if (e.key === "-" || e.key === "_") setBlastRadius(blastRadius - 1);
  });
  window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });

  const seedInput = document.getElementById("vx-seed");
  const biomeSelect = document.getElementById("vx-biome");
  document.getElementById("vx-new").addEventListener("click", () => regenerate(true));
  seedInput.addEventListener("change", () => regenerate(false));
  biomeSelect.addEventListener("change", () => regenerate(false));

  document.getElementById("vx-radius-up")?.addEventListener("click", () => setBlastRadius(blastRadius + 1));
  document.getElementById("vx-radius-down")?.addEventListener("click", () => setBlastRadius(blastRadius - 1));
  setBlastRadius(blastRadius);

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
  updateMonsters(dt, now);
  checkZombieMerges();
  updateMissiles(dt);
  updateFx(dt);
  updateTerrainRegen(dt, now);
  updateCamera();
  renderer.render(scene, camera);
}

// Craters slowly regrow (and their char marks fade) once a patch of terrain
// has gone quiet for a while — nudges heights back toward the original
// heightmap a little at a time, only rebuilding the meshes when something changed.
function updateTerrainRegen(dt, now) {
  if (!currentHeights || now - lastExplosionTime < REGEN_DELAY) return;
  regenTimer += dt;
  if (regenTimer < REGEN_INTERVAL) return;
  regenTimer = 0;

  let changed = false;
  for (let i = 0; i < currentHeights.length; i++) {
    if (currentHeights[i] < originalHeights[i]) {
      currentHeights[i]++;
      changed = true;
    } else if (scorched[i]) {
      scorched[i] = 0;
      changed = true;
    }
  }
  if (changed) rebuildBlockMeshes();
}

init();
