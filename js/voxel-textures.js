import * as THREE from "three";

// Bumped up from the original 16px: rock tiers need enough resolution for
// multi-pixel mineral blotches to survive being viewed from a distance —
// single-pixel speckle alone anti-aliases away to a flat, "gray block" blur
// once a face is only a handful of screen pixels wide.
const TILE = 24;

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function makeCanvasTexture(paint) {
  const canvas = document.createElement("canvas");
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext("2d");
  paint(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Grainy speckled fill: per-pixel jitter plus occasional darker/lighter fleck.
function paintSpeckled(ctx, baseHex, rand, opts = {}) {
  const { speckleChance = 0.3, darkAmt = 22, lightAmt = 16, jitter = 8, darkChance = 0.6 } = opts;
  const base = new THREE.Color(baseHex);
  const br = base.r * 255, bg = base.g * 255, bb = base.b * 255;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let r = br, g = bg, b = bb;
      if (rand() < speckleChance) {
        const amt = rand() < darkChance ? -darkAmt : lightAmt;
        r = clamp255(r + amt); g = clamp255(g + amt); b = clamp255(b + amt);
      } else {
        const j = (rand() - 0.5) * jitter;
        r = clamp255(r + j); g = clamp255(g + j); b = clamp255(b + j);
      }
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function paintCracks(ctx, rand, count, colorRgba) {
  ctx.strokeStyle = colorRgba;
  ctx.lineWidth = 1;
  for (let i = 0; i < count; i++) {
    let x = Math.floor(rand() * TILE), y = Math.floor(rand() * TILE);
    ctx.beginPath();
    ctx.moveTo(x, y);
    const len = 2 + Math.floor(rand() * 4);
    for (let s = 0; s < len; s++) {
      x += rand() < 0.5 ? 1 : -1;
      y += rand() < 0.5 ? 1 : 0;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// A short jagged mineral vein — 2px thick and more directional than a crack,
// used to give each deep rock tier its own identity (rust streaks, quartz
// seams, ...). Thickness matters as much as color here: a 1px-wide feature on
// a block viewed from a few meters away lands on well under one screen pixel
// and simply disappears; 2px survives being seen from a normal play distance.
function paintVein(ctx, rand, colorRgba, count) {
  ctx.fillStyle = colorRgba;
  for (let i = 0; i < count; i++) {
    let x = Math.floor(rand() * TILE), y = Math.floor(rand() * TILE);
    const len = 4 + Math.floor(rand() * 6);
    const dx = rand() < 0.5 ? 1 : -1;
    for (let s = 0; s < len; s++) {
      ctx.fillRect(x, y, 2, 2);
      x = Math.max(0, Math.min(TILE - 2, x + dx));
      if (rand() < 0.4) y = Math.max(0, Math.min(TILE - 2, y + (rand() < 0.5 ? 1 : -1)));
    }
  }
}

// Chunky mineral blotches (pebbles, quartz knots, mica clumps) — the main fix
// for rock tiers reading as a flat gray smear from a few meters out. Per-pixel
// speckle alone gets lost the moment a block face shrinks to a handful of
// screen pixels; a blob several pixels wide keeps its contrast at any normal
// viewing distance because it isn't relying on hitting one exact texel.
function paintBlotches(ctx, rand, colorRgba, count, sizeMin = 2, sizeMax = 4) {
  ctx.fillStyle = colorRgba;
  for (let i = 0; i < count; i++) {
    const size = sizeMin + Math.floor(rand() * (sizeMax - sizeMin + 1));
    const x = Math.floor(rand() * (TILE - size));
    const y = Math.floor(rand() * (TILE - size));
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        // round off the corners so it reads as a pebble, not a square tile
        if ((dx === 0 || dx === size - 1) && (dy === 0 || dy === size - 1) && rand() < 0.5) continue;
        ctx.fillRect(x + dx, y + dy, 1, 1);
      }
    }
  }
}

// Damage cracks layered on top of a block's normal texture, in proportion to
// how close the block is to breaking — replaces a separate "scorched" block
// type entirely, so a hit-but-not-broken block still reads as itself (rock,
// deepstone, ...) instead of vanishing under a flat black scorch mark.
const DAMAGE_STAGES = 4; // 0 = pristine
function paintDamageOverlay(ctx, rand, stage) {
  if (stage <= 0) return;
  const crackCounts = [0, 2, 4, 6];
  const darken = [0, 0.1, 0.2, 0.32];
  paintCracks(ctx, rand, crackCounts[stage], `rgba(8,6,5,${0.4 + stage * 0.12})`);
  if (darken[stage] > 0) {
    ctx.fillStyle = `rgba(0,0,0,${darken[stage]})`;
    ctx.fillRect(0, 0, TILE, TILE);
  }
}

// Builds one variant's full damage-stage ladder [pristine, light, medium, heavy
// cracks]. Every stage repaints the exact same base pattern (same seed) so only
// the crack overlay changes between stages, then wraps each in its own material.
function buildStagedVariant(baseSeed, paintBase, makeMaterial = (opts) => new THREE.MeshLambertMaterial(opts)) {
  const mats = [];
  for (let s = 0; s < DAMAGE_STAGES; s++) {
    const tex = makeCanvasTexture((ctx) => {
      paintBase(ctx, mulberry32(hashSeed(baseSeed)));
      paintDamageOverlay(ctx, mulberry32(hashSeed(`${baseSeed}:crack:${s}`)), s);
    });
    mats.push(makeMaterial({ map: tex }));
  }
  return mats;
}

function grassTopTexture(baseHex, rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.28, darkAmt: 20, lightAmt: 22, jitter: 10 });
    // blade streaks
    for (let i = 0; i < 18; i++) {
      const x = Math.floor(rand() * TILE), y = Math.floor(rand() * TILE);
      const shade = rand() < 0.5 ? "rgba(0,0,0,0.16)" : "rgba(255,255,255,0.14)";
      ctx.fillStyle = shade;
      ctx.fillRect(x, y, 1, 1 + Math.floor(rand() * 2));
    }
  });
}

function grassSideTexture(topHex, dirtHex, rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, dirtHex, rand, { speckleChance: 0.3, darkAmt: 18, lightAmt: 14, jitter: 8 });
    for (let x = 0; x < TILE; x++) {
      const edge = 3 + Math.floor(rand() * 3);
      for (let y = 0; y < edge; y++) {
        const base = new THREE.Color(topHex);
        const j = (rand() - 0.5) * 16;
        const r = clamp255(base.r * 255 + j), g = clamp255(base.g * 255 + j), b = clamp255(base.b * 255 + j);
        ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        ctx.fillRect(x, y, 1, 1);
      }
      // ragged transition pixel
      ctx.fillStyle = `rgba(0,0,0,0.12)`;
      ctx.fillRect(x, edge, 1, 1);
    }
  });
}

function paintDirt(ctx, baseHex, rand) {
  paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.35, darkAmt: 20, lightAmt: 12, jitter: 8 });
}

function dirtTexture(baseHex, rand) {
  return makeCanvasTexture((ctx) => paintDirt(ctx, baseHex, rand));
}

// Shallow rock, one layer down from topsoil: coarse granite ground mass
// studded with chunky pebbles and mica flecks in contrasting tones. The base
// speckle alone reads as flat gray once a face is small on screen — the
// multi-pixel blotches are what actually stay legible at a normal play
// distance, so they carry most of the visual weight here.
function paintRock(ctx, baseHex, rand) {
  paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.3, darkAmt: 30, lightAmt: 26, jitter: 12 });
  paintBlotches(ctx, rand, "rgba(20,16,14,0.35)", 5, 2, 4);
  paintBlotches(ctx, rand, "rgba(235,232,222,0.4)", 4, 2, 3);
  paintCracks(ctx, rand, 3, "rgba(0,0,0,0.3)");
}

// A tier down from rock: dark rust-brown ground mass shot through with bold
// orange ironstone veins and nodules — distinct in HUE (not just value) from
// the neighboring tiers, so digging past it reads as reaching a new kind of
// rock rather than just a darker version of the last one.
function paintIronstone(ctx, baseHex, rand) {
  paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.3, darkAmt: 26, lightAmt: 18, jitter: 10 });
  paintBlotches(ctx, rand, "rgba(196,94,36,0.6)", 5, 2, 4);
  paintVein(ctx, rand, "rgba(224,132,48,0.5)", 3);
  paintCracks(ctx, rand, 2, "rgba(0,0,0,0.32)");
}

function sandTexture(baseHex, rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.4, darkAmt: 14, lightAmt: 16, jitter: 6 });
  });
}

function snowTexture(baseHex, rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.2, darkAmt: 10, lightAmt: 14, jitter: 5 });
    for (let i = 0; i < 10; i++) {
      const x = Math.floor(rand() * TILE), y = Math.floor(rand() * TILE);
      ctx.fillStyle = "rgba(190,225,255,0.5)";
      ctx.fillRect(x, y, 1, 1);
    }
  });
}

function skinTexture(baseHex, rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.3, darkAmt: 20, lightAmt: 14, jitter: 9 });
    // scattered "wound" / grime marks
    for (let i = 0; i < 4; i++) {
      const x = Math.floor(rand() * TILE), y = Math.floor(rand() * TILE);
      ctx.fillStyle = "rgba(70,20,20,0.35)";
      ctx.fillRect(x, y, 1 + Math.floor(rand() * 2), 1);
    }
  });
}

function faceTexture(baseHex, rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.25, darkAmt: 18, lightAmt: 12, jitter: 8 });
    // sunken eye sockets
    ctx.fillStyle = "rgba(15,10,10,0.75)";
    ctx.fillRect(3, 6, 3, 2);
    ctx.fillRect(10, 6, 3, 2);
    ctx.fillStyle = "rgba(210,40,30,0.9)";
    ctx.fillRect(4, 6, 1, 1);
    ctx.fillRect(11, 6, 1, 1);
    // mouth
    ctx.fillStyle = "rgba(20,10,10,0.6)";
    ctx.fillRect(5, 11, 6, 1);
  });
}

function clothesTexture(baseHex, rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.4, darkAmt: 24, lightAmt: 10, jitter: 10 });
    // torn tatter marks along the bottom edge
    for (let x = 0; x < TILE; x++) {
      if (rand() < 0.4) {
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.fillRect(x, TILE - 1 - Math.floor(rand() * 3), 1, 2);
      }
    }
  });
}

// Deep strata are geology, not biome — same look everywhere regardless of
// what's growing on the surface above, matching how real rock layers work.
// Cool slate base with pale quartz seams, distinct in hue from ironstone above
// and bedrock below so each tier reads as its own kind of rock while digging.
function paintDeepstone(ctx, baseHex, rand) {
  paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.32, darkAmt: 26, lightAmt: 20, jitter: 10 });
  paintBlotches(ctx, rand, "rgba(15,16,22,0.4)", 5, 2, 4);
  paintVein(ctx, rand, "rgba(200,220,245,0.5)", 4);
  paintCracks(ctx, rand, 3, "rgba(0,0,0,0.32)");
}

// The oldest, toughest rock: near-black stone shot through with glowing
// violet-blue crystal knots, so a deep pit reads as "ancient crystal cavern"
// rather than a flat black void.
function paintBedrock(ctx, baseHex, rand) {
  paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.28, darkAmt: 18, lightAmt: 24, jitter: 8 });
  paintCracks(ctx, rand, 4, "rgba(0,0,0,0.42)");
  paintVein(ctx, rand, "rgba(150,115,255,0.6)", 3);
  paintBlotches(ctx, rand, "rgba(170,205,255,0.55)", 5, 2, 3);
}

const ZOMBIE_SKIN_TONES = [0x4f8a4a, 0x7a8c4a, 0x6a8f6f, 0x8a7a4a];

// Builds one articulated-zombie material set (skin/face/clothes), seeded per instance
// so each zombie's grime pattern is reproducible but distinct.
export function buildZombieMaterials(seed, instanceId) {
  const tone = ZOMBIE_SKIN_TONES[Math.floor(mulberry32(hashSeed(`${seed}:ztone:${instanceId}`))() * ZOMBIE_SKIN_TONES.length)];
  const skinRand = mulberry32(hashSeed(`${seed}:zskin:${instanceId}`));
  const faceRand = mulberry32(hashSeed(`${seed}:zface:${instanceId}`));
  const clothesRand = mulberry32(hashSeed(`${seed}:zclothes:${instanceId}`));
  const skin = new THREE.MeshLambertMaterial({ map: skinTexture(tone, skinRand) });
  const face = new THREE.MeshLambertMaterial({ map: faceTexture(tone, faceRand) });
  const clothesHex = 0x3d4a3a;
  const clothes = new THREE.MeshLambertMaterial({ map: clothesTexture(clothesHex, clothesRand) });
  return { skin, face, clothes };
}

export function disposeZombieMaterials(mats) {
  for (const m of [mats.skin, mats.face, mats.clothes]) {
    m.map?.dispose();
    m.dispose();
  }
}

const VARIANT_COUNTS = { grass: 3, sub: 3, rock: 4, ironstone: 4, sand: 2, snow: 2, deepstone: 3, bedrock: 3 };

// Types tough enough (resistance > 1, see stratumForDepth in voxel-gen.js) to
// ever sit mid-damage — these get the full crack-stage ladder. Everything
// else breaks in one hit, so a second stage would never be seen.
const STAGED_TYPES = new Set(["rock", "ironstone", "deepstone", "bedrock"]);

// Deep strata are geology, not biome — same base tone everywhere regardless of
// what's growing on the surface above.
const IRONSTONE_BASE = 0x5a4238;
const DEEPSTONE_BASE = 0x454b58;
const BEDROCK_BASE = 0x1c1e26;

// Builds a fresh set of textured materials for the given biome, seeded so the
// same world seed always reproduces the same grain pattern.
//
// materials[type][variant] is an array of damage-stage materials (length 1 for
// one-hit-break types, DAMAGE_STAGES for the staged rock tiers above) — except
// materials.grass[variant], which is a 6-face material array for the cube.
//
// Every variant shares the SAME base color — texture variants here only exist
// to vary the pebble/crack/vein *pattern* a little. Color richness instead
// comes from a continuous per-instance tint (see applyTerrainTint in
// voxel-gen.js) driven by smooth noise over world position, so neighboring
// blocks blend into patches and streaks instead of each one reading as its
// own separately-dyed swatch. vertexColors is on so that tint can multiply in.
export function buildBlockMaterials(biome, seed) {
  const materials = {}; // type -> variant[] -> stage[] (or array-of-6 for grass)
  const seedFor = (type, variant) => `${seed}:tex:${type}:${variant}`;
  const single = (mat) => [mat]; // wraps a one-stage material to match the staged shape
  const tinted = (opts) => new THREE.MeshLambertMaterial({ ...opts, vertexColors: true });

  materials.sub = [];
  for (let v = 0; v < VARIANT_COUNTS.sub; v++) {
    materials.sub.push(single(tinted({ map: dirtTexture(biome.sub, mulberry32(hashSeed(seedFor("sub", v)))) })));
  }

  materials.rock = [];
  for (let v = 0; v < VARIANT_COUNTS.rock; v++) {
    materials.rock.push(buildStagedVariant(seedFor("rock", v), (ctx, rand) => paintRock(ctx, biome.rock, rand), tinted));
  }

  materials.ironstone = [];
  for (let v = 0; v < VARIANT_COUNTS.ironstone; v++) {
    materials.ironstone.push(buildStagedVariant(seedFor("ironstone", v), (ctx, rand) => paintIronstone(ctx, IRONSTONE_BASE, rand), tinted));
  }

  materials.sand = [];
  for (let v = 0; v < VARIANT_COUNTS.sand; v++) {
    materials.sand.push(single(tinted({ map: sandTexture(biome.sand, mulberry32(hashSeed(seedFor("sand", v)))) })));
  }

  materials.snow = [];
  for (let v = 0; v < VARIANT_COUNTS.snow; v++) {
    materials.snow.push(single(tinted({ map: snowTexture(biome.snow, mulberry32(hashSeed(seedFor("snow", v)))) })));
  }

  materials.deepstone = [];
  for (let v = 0; v < VARIANT_COUNTS.deepstone; v++) {
    materials.deepstone.push(buildStagedVariant(seedFor("deepstone", v), (ctx, rand) => paintDeepstone(ctx, DEEPSTONE_BASE, rand), tinted));
  }

  materials.bedrock = [];
  for (let v = 0; v < VARIANT_COUNTS.bedrock; v++) {
    materials.bedrock.push(buildStagedVariant(seedFor("bedrock", v), (ctx, rand) => paintBedrock(ctx, BEDROCK_BASE, rand), tinted));
  }

  // grass gets a 6-face material array: [+x,-x,+y,-y,+z,-z] = [side,side,top,bottom,side,side]
  materials.grass = [];
  for (let v = 0; v < VARIANT_COUNTS.grass; v++) {
    const topTex = grassTopTexture(biome.top, mulberry32(hashSeed(seedFor("grasstop", v))));
    const sideTex = grassSideTexture(biome.top, biome.sub, mulberry32(hashSeed(seedFor("grasside", v))));
    const bottomTex = dirtTexture(biome.sub, mulberry32(hashSeed(seedFor("grassbottom", v))));
    const side = new THREE.MeshLambertMaterial({ map: sideTex });
    const top = new THREE.MeshLambertMaterial({ map: topTex });
    const bottom = new THREE.MeshLambertMaterial({ map: bottomTex });
    materials.grass.push([side, side, top, bottom, side, side]);
  }

  return { materials, variantCounts: VARIANT_COUNTS, stagedTypes: STAGED_TYPES };
}

export function disposeBlockMaterials(materials) {
  for (const key of Object.keys(materials)) {
    for (const m of materials[key]) {
      if (Array.isArray(m)) {
        for (const face of m) { face.map?.dispose(); face.dispose(); }
      } else {
        m.map?.dispose();
        m.dispose();
      }
    }
  }
}
