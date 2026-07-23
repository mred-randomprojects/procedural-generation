import * as THREE from "three";

const TILE = 16;

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

function dirtTexture(baseHex, rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.35, darkAmt: 20, lightAmt: 12, jitter: 8 });
  });
}

function rockTexture(baseHex, rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, baseHex, rand, { speckleChance: 0.25, darkAmt: 24, lightAmt: 20, jitter: 10 });
    paintCracks(ctx, rand, 3, "rgba(0,0,0,0.22)");
    paintCracks(ctx, rand, 2, "rgba(255,255,255,0.10)");
  });
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

function charredTexture(rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, 0x2a2321, rand, { speckleChance: 0.4, darkAmt: 18, lightAmt: 22, jitter: 10 });
    paintCracks(ctx, rand, 4, "rgba(0,0,0,0.4)");
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(rand() * TILE), y = Math.floor(rand() * TILE);
      ctx.fillStyle = `rgba(255,${90 + Math.floor(rand() * 80)},30,${0.5 + rand() * 0.4})`;
      ctx.fillRect(x, y, 1, 1);
    }
  });
}

// Deep strata are geology, not biome — same look everywhere regardless of
// what's growing on the surface above, matching how real rock layers work.
function deepstoneTexture(rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, 0x454b58, rand, { speckleChance: 0.3, darkAmt: 20, lightAmt: 14, jitter: 8 });
    paintCracks(ctx, rand, 3, "rgba(0,0,0,0.3)");
    paintCracks(ctx, rand, 2, "rgba(160,175,200,0.15)");
  });
}

function bedrockTexture(rand) {
  return makeCanvasTexture((ctx) => {
    paintSpeckled(ctx, 0x15171d, rand, { speckleChance: 0.25, darkAmt: 14, lightAmt: 22, jitter: 6 });
    paintCracks(ctx, rand, 4, "rgba(0,0,0,0.45)");
    // sparse bright mineral flecks
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(rand() * TILE), y = Math.floor(rand() * TILE);
      ctx.fillStyle = `rgba(170,205,255,${0.3 + rand() * 0.4})`;
      ctx.fillRect(x, y, 1, 1);
    }
  });
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

const VARIANT_COUNTS = { grass: 3, sub: 2, rock: 3, sand: 2, snow: 2, charred: 2, deepstone: 2, bedrock: 2 };

// Builds a fresh set of textured materials for the given biome, seeded so the
// same world seed always reproduces the same grain pattern.
export function buildBlockMaterials(biome, seed) {
  const materials = {}; // type -> array of THREE.Material (or array-of-6 for grass)
  const seedFor = (type, variant) => mulberry32(hashSeed(`${seed}:tex:${type}:${variant}`));

  materials.sub = [];
  for (let v = 0; v < VARIANT_COUNTS.sub; v++) {
    const tex = dirtTexture(biome.sub, seedFor("sub", v));
    materials.sub.push(new THREE.MeshLambertMaterial({ map: tex }));
  }

  materials.rock = [];
  for (let v = 0; v < VARIANT_COUNTS.rock; v++) {
    const tex = rockTexture(biome.rock, seedFor("rock", v));
    materials.rock.push(new THREE.MeshLambertMaterial({ map: tex }));
  }

  materials.sand = [];
  for (let v = 0; v < VARIANT_COUNTS.sand; v++) {
    const tex = sandTexture(biome.sand, seedFor("sand", v));
    materials.sand.push(new THREE.MeshLambertMaterial({ map: tex }));
  }

  materials.snow = [];
  for (let v = 0; v < VARIANT_COUNTS.snow; v++) {
    const tex = snowTexture(biome.snow, seedFor("snow", v));
    materials.snow.push(new THREE.MeshLambertMaterial({ map: tex }));
  }

  materials.charred = [];
  for (let v = 0; v < VARIANT_COUNTS.charred; v++) {
    const tex = charredTexture(seedFor("charred", v));
    materials.charred.push(new THREE.MeshLambertMaterial({ map: tex }));
  }

  materials.deepstone = [];
  for (let v = 0; v < VARIANT_COUNTS.deepstone; v++) {
    const tex = deepstoneTexture(seedFor("deepstone", v));
    materials.deepstone.push(new THREE.MeshLambertMaterial({ map: tex }));
  }

  materials.bedrock = [];
  for (let v = 0; v < VARIANT_COUNTS.bedrock; v++) {
    const tex = bedrockTexture(seedFor("bedrock", v));
    materials.bedrock.push(new THREE.MeshLambertMaterial({ map: tex }));
  }

  // grass gets a 6-face material array: [+x,-x,+y,-y,+z,-z] = [side,side,top,bottom,side,side]
  materials.grass = [];
  for (let v = 0; v < VARIANT_COUNTS.grass; v++) {
    const topTex = grassTopTexture(biome.top, seedFor("grasstop", v));
    const sideTex = grassSideTexture(biome.top, biome.sub, seedFor("grasside", v));
    const bottomTex = dirtTexture(biome.sub, seedFor("grassbottom", v));
    const side = new THREE.MeshLambertMaterial({ map: sideTex });
    const top = new THREE.MeshLambertMaterial({ map: topTex });
    const bottom = new THREE.MeshLambertMaterial({ map: bottomTex });
    materials.grass.push([side, side, top, bottom, side, side]);
  }

  return { materials, variantCounts: VARIANT_COUNTS };
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
