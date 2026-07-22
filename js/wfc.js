"use strict";

/* ---------- Tile set ----------
 * Tiles form a height chain; a tile may only sit next to itself or its
 * immediate neighbours in the chain. That single rule is enough to make
 * coherent landscapes emerge from randomness.
 */

const WFC_TILES = [
  { key: "deep", name: "Deep water", color: [18, 50, 92], base: 0.55, group: "water" },
  { key: "water", name: "Water", color: [38, 100, 150], base: 1.0, group: "water" },
  { key: "sand", name: "Sand", color: [226, 208, 154], base: 0.55, group: "sand" },
  { key: "grass", name: "Grass", color: [116, 172, 92], base: 1.25, group: "grass" },
  { key: "forest", name: "Forest", color: [52, 114, 66], base: 1.0, group: "forest" },
  { key: "hill", name: "Hills", color: [146, 138, 100], base: 0.55, group: "mountain" },
  { key: "mountain", name: "Mountain", color: [112, 108, 102], base: 0.45, group: "mountain" },
  { key: "snow", name: "Snow", color: [238, 242, 246], base: 0.3, group: "mountain" },
];

const WFC_T = WFC_TILES.length;
const WFC_FULL = (1 << WFC_T) - 1;

// ALLOWED[t] = bitmask of tiles allowed next to tile t (chain ±1)
const WFC_ALLOWED = new Uint16Array(WFC_T);
for (let t = 0; t < WFC_T; t++) {
  let m = 1 << t;
  if (t > 0) m |= 1 << (t - 1);
  if (t < WFC_T - 1) m |= 1 << (t + 1);
  WFC_ALLOWED[t] = m;
}

// Popcount lookup for 8-bit masks
const WFC_POP = new Uint8Array(1 << WFC_T);
for (let m = 1; m < 1 << WFC_T; m++) WFC_POP[m] = WFC_POP[m >> 1] + (m & 1);

// UNION_ALLOWED[mask] = union of ALLOWED[t] for every tile t in mask
const WFC_UNION_ALLOWED = new Uint16Array(1 << WFC_T);
for (let m = 1; m < 1 << WFC_T; m++) {
  let u = 0;
  for (let t = 0; t < WFC_T; t++) if (m & (1 << t)) u |= WFC_ALLOWED[t];
  WFC_UNION_ALLOWED[m] = u;
}

/* ---------- The model ---------- */

class WFCModel {
  constructor(gw, gh, weights, rng) {
    this.gw = gw;
    this.gh = gh;
    this.n = gw * gh;
    this.rng = rng;
    this.weights = weights;
    this.domains = new Uint16Array(this.n).fill(WFC_FULL);
    this.status = "running"; // running | done | contradiction

    // Cache Shannon entropy per possible domain mask (only 256 of them)
    this.maskSumW = new Float64Array(1 << WFC_T);
    this.maskEntropy = new Float64Array(1 << WFC_T);
    for (let m = 1; m < 1 << WFC_T; m++) {
      let s = 0, sl = 0;
      for (let t = 0; t < WFC_T; t++) {
        if (m & (1 << t)) {
          const w = weights[t];
          s += w;
          sl += w * Math.log(w);
        }
      }
      this.maskSumW[m] = s;
      this.maskEntropy[m] = Math.log(s) - sl / s;
    }
  }

  // One observation: collapse the lowest-entropy cell. Returns ok | done | contradiction.
  step() {
    const D = this.domains;
    let best = -1, bestE = Infinity;
    for (let i = 0; i < this.n; i++) {
      const m = D[i];
      if (WFC_POP[m] <= 1) continue;
      const e = this.maskEntropy[m] + this.rng() * 0.02; // noise breaks ties
      if (e < bestE) { bestE = e; best = i; }
    }
    if (best < 0) { this.status = "done"; return "done"; }
    return this.collapseCell(best, this.chooseTile(D[best], best)) ? "ok" : "contradiction";
  }

  chooseTile(mask, cell) {
    // Weighted pick with clumping: tiles already chosen by collapsed
    // neighbours get a boost (coherent regions), and chain-adjacent tiles get
    // a smaller one (so the landscape keeps drifting through all the levels
    // instead of freezing into a single-tile monoculture).
    const D = this.domains, gw = this.gw, gh = this.gh;
    const x = cell % gw, y = (cell / gw) | 0;
    const nt = [];
    if (x > 0 && WFC_POP[D[cell - 1]] === 1) nt.push(31 - Math.clz32(D[cell - 1]));
    if (x < gw - 1 && WFC_POP[D[cell + 1]] === 1) nt.push(31 - Math.clz32(D[cell + 1]));
    if (y > 0 && WFC_POP[D[cell - gw]] === 1) nt.push(31 - Math.clz32(D[cell - gw]));
    if (y < gh - 1 && WFC_POP[D[cell + gw]] === 1) nt.push(31 - Math.clz32(D[cell + gw]));
    const w = new Float64Array(WFC_T);
    let total = 0;
    for (let t = 0; t < WFC_T; t++) {
      if (!(mask & (1 << t))) continue;
      let wt = this.weights[t];
      for (const n of nt) {
        if (n === t) wt *= 4;
        else if (Math.abs(n - t) === 1) wt *= 1.75;
      }
      w[t] = wt;
      total += wt;
    }
    let r = this.rng() * total;
    for (let t = 0; t < WFC_T; t++) {
      if (w[t] > 0) {
        r -= w[t];
        if (r <= 0) return t;
      }
    }
    for (let t = WFC_T - 1; t >= 0; t--) if (mask & (1 << t)) return t;
    return 0;
  }

  collapseCell(i, tile) {
    if (!(this.domains[i] & (1 << tile))) return false;
    this.domains[i] = 1 << tile;
    return this.propagate(i);
  }

  // Arc-consistency propagation from a changed cell
  propagate(start) {
    const D = this.domains, gw = this.gw, gh = this.gh;
    const stack = [start];
    while (stack.length) {
      const c = stack.pop();
      const allow = WFC_UNION_ALLOWED[D[c]];
      const x = c % gw, y = (c / gw) | 0;
      const neigh = [];
      if (x > 0) neigh.push(c - 1);
      if (x < gw - 1) neigh.push(c + 1);
      if (y > 0) neigh.push(c - gw);
      if (y < gh - 1) neigh.push(c + gw);
      for (const j of neigh) {
        const nd = D[j] & allow;
        if (nd === 0) { this.status = "contradiction"; return false; }
        if (nd !== D[j]) { D[j] = nd; stack.push(j); }
      }
    }
    return true;
  }
}

/* ---------- Renderer ---------- */

// Returns the number of collapsed cells (for the progress readout)
function renderWFC(model, canvas) {
  const ctx = canvas.getContext("2d");
  const cw = canvas.width / model.gw;
  const ch = canvas.height / model.gh;
  ctx.fillStyle = "#0c0f13";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let done = 0;
  for (let i = 0; i < model.n; i++) {
    const m = model.domains[i];
    const x = i % model.gw, y = (i / model.gw) | 0;
    if (WFC_POP[m] === 1) {
      done++;
      const t = 31 - Math.clz32(m);
      const c = WFC_TILES[t].color;
      const j = 1 + (cellHash(x, y) - 0.5) * 0.1;
      ctx.fillStyle = rgbStr(c[0] * j, c[1] * j, c[2] * j);
      ctx.fillRect(x * cw, y * ch, cw + 0.5, ch + 0.5);
    } else {
      // superposition: weighted blend of the remaining options, dimmed by uncertainty
      let r = 0, g = 0, b = 0, s = 0;
      for (let t = 0; t < WFC_T; t++) {
        if (m & (1 << t)) {
          const w = model.weights[t];
          const c = WFC_TILES[t].color;
          r += c[0] * w; g += c[1] * w; b += c[2] * w; s += w;
        }
      }
      const bright = 0.2 + 0.45 * (1 - WFC_POP[m] / WFC_T);
      ctx.fillStyle = rgbStr((r / s) * bright, (g / s) * bright, (b / s) * bright);
      ctx.fillRect(x * cw + 1, y * ch + 1, cw - 2, ch - 2);
    }
  }
  return done;
}
