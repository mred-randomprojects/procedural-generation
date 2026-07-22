"use strict";

const $ = (s) => document.querySelector(s);
const worldCanvas = $("#world-canvas");
const wfcCanvas = $("#wfc-canvas");
const statusEl = $("#status");

let activeTab = "world";
let world = null;
let view = "biome";
let lastWorldStatus = "";

function setStatus(msg) { statusEl.textContent = msg; }

/* ---------- Slider value read-outs ---------- */

document.querySelectorAll("label input[type=range]").forEach((inp) => {
  const span = inp.closest("label").querySelector(".val");
  const update = () => { if (span) span.textContent = inp.value; };
  inp.addEventListener("input", update);
  update();
});

/* ---------- World tab ---------- */

function readParams() {
  return {
    seed: $("#seed").value || "gaia",
    scale: +$("#p-scale").value,
    octaves: +$("#p-octaves").value,
    persistence: +$("#p-rough").value,
    island: +$("#p-island").value,
    sea: +$("#p-sea").value,
    mountain: +$("#p-mtn").value,
    moistOff: +$("#p-moist").value,
    tempOff: +$("#p-temp").value,
    rivers: +$("#p-rivers").value,
    towns: +$("#p-towns").value,
  };
}

function regenWorld() {
  const params = readParams();
  const t0 = performance.now();
  world = generateWorld(params);
  renderWorld(world, view, worldCanvas);
  const ms = Math.round(performance.now() - t0);
  lastWorldStatus = `Generated in ${ms} ms · ${world.towns.length} towns · ${world.riverCount} rivers · seed “${params.seed}”`;
  if (activeTab === "world") setStatus(lastWorldStatus);
}

let regenTimer = 0;
function scheduleRegen() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(regenWorld, 160);
}

$("#panel-world").addEventListener("input", scheduleRegen);

$("#dice").addEventListener("click", () => {
  $("#seed").value = (
    NAME_A[(Math.random() * NAME_A.length) | 0] +
    NAME_B[(Math.random() * NAME_B.length) | 0]
  ).toLowerCase();
  regenWorld();
});

document.querySelectorAll(".view").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".view").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    view = btn.dataset.view;
    if (world) renderWorld(world, view, worldCanvas);
  });
});

// Legend
{
  const legend = $("#legend");
  BIOME_INFO.forEach((b) => {
    const el = document.createElement("div");
    el.className = "legend-item";
    el.innerHTML = `<span class="swatch" style="background: rgb(${b.color})"></span>${b.name}`;
    legend.appendChild(el);
  });
}

/* ---------- WFC tab ---------- */

let wfcModel = null;
let wfcRaf = 0;
let wfcRestarts = 0;
let wfcLastT = 0;

function buildWeights() {
  const groups = {
    water: +$("#w-water").value,
    sand: +$("#w-sand").value,
    grass: +$("#w-grass").value,
    forest: +$("#w-forest").value,
    mountain: +$("#w-mountain").value,
  };
  return WFC_TILES.map((t) => Math.max(0.05, t.base * groups[t.group]));
}

function updateWfcStatus(done) {
  if (activeTab !== "wfc") return;
  const pct = Math.round((done / wfcModel.n) * 100);
  setStatus(
    `Collapse: ${pct}%` +
    (wfcModel.status === "done" ? " · complete ✓ (hit Restart or repaint the weights)" : "") +
    (wfcRestarts ? ` · ${wfcRestarts} restart${wfcRestarts === 1 ? "" : "s"}` : "")
  );
}

// setTimeout (not requestAnimationFrame) so the collapse keeps running even
// when the window is backgrounded — rAF freezes entirely in occluded windows.
function scheduleWfcTick() {
  clearTimeout(wfcRaf);
  wfcRaf = setTimeout(wfcLoop, 16);
}

// Force a few far-apart lakes and peaks up front so the map reliably spans the
// whole tile chain — the random walk alone tends to hover around the middle.
function seedWfc(model) {
  const spots = [];
  const seed = (tile, count) => {
    for (let k = 0; k < count; k++) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const x = 4 + Math.floor(Math.random() * (model.gw - 8));
        const y = 4 + Math.floor(Math.random() * (model.gh - 8));
        if (spots.some(([sx, sy]) => (sx - x) ** 2 + (sy - y) ** 2 < 15 * 15)) continue;
        const i = y * model.gw + x;
        if (!(model.domains[i] & (1 << tile))) continue;
        if (model.collapseCell(i, tile)) spots.push([x, y]);
        break;
      }
    }
  };
  seed(0, 3); // deep-water lakes
  seed(WFC_T - 1, 2); // snow peaks
}

function wfcRestart(resetCounter = true) {
  clearTimeout(wfcRaf);
  if (resetCounter) wfcRestarts = 0;
  wfcModel = new WFCModel(80, 50, buildWeights(), mulberry32((Math.random() * 4294967296) >>> 0));
  seedWfc(wfcModel);
  wfcLastT = 0;
  const done = renderWFC(wfcModel, wfcCanvas);
  updateWfcStatus(done);
  if (activeTab === "wfc") scheduleWfcTick();
}

function wfcLoop() {
  clearTimeout(wfcRaf);
  // Time-based stepping: "speed" means collapses per 60fps-frame, so the pace
  // stays constant even when the browser throttles requestAnimationFrame.
  const now = performance.now();
  const dt = wfcLastT ? Math.min(now - wfcLastT, 2000) : 16.7;
  wfcLastT = now;
  const speed = +$("#wfc-speed").value;
  const steps = Math.min(4000, Math.max(1, Math.round(speed * (dt / 16.7))));
  for (let k = 0; k < steps && wfcModel.status === "running"; k++) {
    const st = wfcModel.step();
    if (st === "contradiction") {
      wfcRestarts++;
      wfcRestart(false);
      return;
    }
    if (st === "done") break;
  }
  const done = renderWFC(wfcModel, wfcCanvas);
  updateWfcStatus(done);
  if (wfcModel.status === "running") scheduleWfcTick();
}

$("#wfc-restart").addEventListener("click", () => wfcRestart());

let wfcWeightTimer = 0;
document.querySelectorAll(".wfc-weight").forEach((inp) => {
  inp.addEventListener("input", () => {
    clearTimeout(wfcWeightTimer);
    wfcWeightTimer = setTimeout(() => wfcRestart(), 250);
  });
});

/* ---------- WFC painting ---------- */

let paintTile = -1;
{
  const paletteEl = $("#palette");
  WFC_TILES.forEach((t, idx) => {
    const b = document.createElement("button");
    b.className = "tilebtn";
    b.innerHTML = `<span class="swatch" style="background: rgb(${t.color})"></span>${t.name}`;
    b.addEventListener("click", () => {
      paintTile = paintTile === idx ? -1 : idx;
      document.querySelectorAll(".tilebtn").forEach((el, k) =>
        el.classList.toggle("selected", k === paintTile)
      );
    });
    paletteEl.appendChild(b);
  });
}

let painting = false;

// When a painted tile is impossible somewhere, dissolve a disc of cells back
// into full superposition and re-impose the constraints from the intact ring
// around it — the area then re-collapses ("heals") around the painted tile.
function meltRegion(center) {
  const m = wfcModel, gw = m.gw, gh = m.gh, D = m.domains;
  const cx = center % gw, cy = (center / gw) | 0;
  const R = 8;
  const x0 = Math.max(0, cx - R), x1 = Math.min(gw - 1, cx + R);
  const y0 = Math.max(0, cy - R), y1 = Math.min(gh - 1, cy + R);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= R * R) D[y * gw + x] = WFC_FULL;
    }
  }
  for (let y = Math.max(0, y0 - 1); y <= Math.min(gh - 1, y1 + 1); y++) {
    for (let x = Math.max(0, x0 - 1); x <= Math.min(gw - 1, x1 + 1); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) m.propagate(y * gw + x);
    }
  }
}

function paintAt(ev) {
  if (paintTile < 0 || !wfcModel) return;
  const rect = wfcCanvas.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - rect.left) / rect.width) * wfcModel.gw);
  const y = Math.floor(((ev.clientY - rect.top) / rect.height) * wfcModel.gh);
  if (x < 0 || y < 0 || x >= wfcModel.gw || y >= wfcModel.gh) return;
  const i = y * wfcModel.gw + x;
  const bit = 1 << paintTile;
  if (wfcModel.domains[i] === bit) return; // already exactly this tile
  if (!(wfcModel.domains[i] & bit)) meltRegion(i);
  if (!wfcModel.collapseCell(i, paintTile)) {
    wfcRestarts++;
    wfcRestart(false);
    return;
  }
  wfcModel.status = "running";
  wfcLastT = 0;
  const done = renderWFC(wfcModel, wfcCanvas);
  updateWfcStatus(done);
  scheduleWfcTick();
}

wfcCanvas.addEventListener("pointerdown", (ev) => { painting = true; paintAt(ev); });
wfcCanvas.addEventListener("pointermove", (ev) => { if (painting) paintAt(ev); });
window.addEventListener("pointerup", () => { painting = false; });

/* ---------- Tabs ---------- */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    $("#panel-world").hidden = activeTab !== "world";
    $("#panel-wfc").hidden = activeTab !== "wfc";
    worldCanvas.hidden = activeTab !== "world";
    wfcCanvas.hidden = activeTab !== "wfc";
    if (activeTab === "wfc") {
      if (!wfcModel) {
        wfcRestart();
      } else if (wfcModel.status === "running") {
        scheduleWfcTick();
      } else {
        updateWfcStatus(renderWFC(wfcModel, wfcCanvas));
      }
    } else {
      clearTimeout(wfcRaf);
      setStatus(lastWorldStatus);
    }
  });
});

/* ---------- Go ---------- */

regenWorld();
