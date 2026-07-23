// Heartfall core — every balance curve, progression cost, and game-rule
// computation, extracted into one dependency-free ES module. No THREE, no
// DOM, no timers: everything here is a pure function of its inputs, which is
// what lets the Node test suite (tests/heartfall-core.test.mjs) pin the
// game's math down without a browser. voxel-gen.js imports from here and
// supplies the live state (slider values, legacy ranks, clocks) at call time.
//
// GUIDING PRINCIPLE — no artificial limits. Curves here escalate forever by
// design (blast costs, combo multipliers, boss levels): do not add caps
// without explicit user direction.

/* ---------- seeded PRNG (self-contained copy for contracts/daily) ---------- */

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- difficulty & the Heart ---------- */

// Difficulty scales the Heart's durability and how fast pressure arrives.
export const DIFFICULTIES = {
  easy: { label: "🌱 Easy", hp: 1.5, wave: 1.35, trickle: 1.4 },
  normal: { label: "⚔️ Normal", hp: 1, wave: 1, trickle: 1 },
  hard: { label: "💀 Hard", hp: 0.75, wave: 0.75, trickle: 0.75 },
};

export function heartMaxHp(heartRank, difficulty) {
  return Math.round((100 + heartRank * 20) * DIFFICULTIES[difficulty].hp);
}

/* ---------- blast-radius progression ---------- */

export const STARTING_MAX_BLAST = 3;
// Cumulative XP needed to unlock each bigger blast radius, up through 8.
export const BLAST_UNLOCK_XP = { 4: 40, 5: 100, 6: 200, 7: 350, 8: 550 };

// No hard ceiling — past 8 the cost keeps escalating indefinitely.
export function blastUnlockCost(r) {
  if (r <= 8) return BLAST_UNLOCK_XP[r];
  const extra = r - 8;
  return 550 + extra * (300 + (extra - 1) * 150);
}

/* ---------- zombie stat curves ---------- */
// The per-level slopes (hpPerLevel etc.) are live Tweaks-slider values in
// the game, so they're arguments here, defaulting to canonical balance.

export function maxHpFor(level, hpPerLevel = 1) { return 1 + (level - 1) * hpPerLevel; }
export function dpsFor(level, dmgPerLevel = 1) { return 1 + (level - 1) * dmgPerLevel; }

// Flat armor against zombie-vs-zombie projectiles: a level-X zombie shrugs
// off X-2 points of incoming DPS. Player blasts/turrets/mines ignore it.
export function defenseFor(level) { return Math.max(0, level - 2); }

// Linear, uncapped: x1 at level 1, +speedPerLevel per level after.
export function stackSpeed(level, speedPerLevel = 0.3) { return 1 + (level - 1) * speedPerLevel; }
export function stackScale(level) { return 1 + (level - 1) * 0.3; }

// Odd numbers: 1, 3, 5, 7… — eats required to advance from `level`.
export function eatsNeededForLevel(level) { return 2 * level - 1; }

// Attack cadence: higher levels shoot faster; damage per shot is scaled by
// the interval so true DPS is exactly dpsFor(level) at any cadence.
export function attackInterval(level, atkPerLevel = 0.25) { return 1.0 / (1 + atkPerLevel * (level - 1)); }

// Damage one projectile deals after the target's flat armor.
export function effectiveHitDamage(dps, interval, targetLevel) {
  return Math.max(0, (dps - defenseFor(targetLevel)) * interval);
}

/* ---------- waves & bosses ---------- */

export function waveDelay(waveNumber, waveMul = 1) {
  return Math.max(10, 22 - waveNumber * 0.5) * waveMul;
}
export function waveSpawnCount(waveNumber) { return 2 + waveNumber; }
export function trickleDelay(waveNumber, trickleMul = 1) {
  return Math.max(1.5, 5 - waveNumber * 0.15) * trickleMul;
}

// Every 5th wave brings a boss — a pre-evolved elite with a bounty on its
// head. The pressure spike (and the reward spike) is the point.
export const BOSS_WAVE_EVERY = 5;
// Bosses stalk rather than sprint — a high level's stackSpeed would make
// them comically fast, so their speed is damped by this factor.
export const BOSS_SPEED_FACTOR = 0.6;

export function isBossWave(waveNumber) {
  return waveNumber > 0 && waveNumber % BOSS_WAVE_EVERY === 0;
}
// Wave 5 → level 4, wave 10 → level 6, wave 15 → level 8 … (+2 per boss).
export function bossLevelForWave(waveNumber) {
  return 4 + 2 * (Math.floor(waveNumber / BOSS_WAVE_EVERY) - 1);
}
// Extra energy paid on top of the normal kill payout when the PLAYER lands
// the killing blow (a zombie that eats the boss keeps the XP instead…).
export function bossBounty(level) { return level * 30; }

/* ---------- economy & scoring ---------- */

export function killPayout(level) { return level * 10; }
export function runScore(survivalSeconds, killCount) {
  return Math.round(survivalSeconds) + killCount * 5;
}

export function legacyCost(rank) { return 3 + rank * 2; } // shards; grows per rank

// Shards banked at the end of a scored run; Shard Magnet ranks multiply.
export function shardsForScore(score, shardRank = 0) {
  return Math.max(1, Math.floor((score / 50) * (1 + 0.15 * shardRank)));
}

// The permanent-upgrade storefront on the defeat screen.
export const LEGACY_PERKS = [
  { key: "heartRank", icon: "💪", name: "Reinforced Heart", desc: "+20 max Heart HP" },
  { key: "energyRank", icon: "⚡", name: "Head Start", desc: "+40 starting energy" },
  { key: "blastRank", icon: "💥", name: "Demolitionist", desc: "+1 starting blast radius" },
  { key: "turretRank", icon: "🎯", name: "Overcharged Turrets", desc: "+0.5 turret damage" },
  { key: "mineRank", icon: "💣", name: "Minefield", desc: "Start each run with 2 buried mines" },
  { key: "shardRank", icon: "🔮", name: "Shard Magnet", desc: "+15% shards earned" },
];

export function turretDamage(turretRank) { return 1 + 0.5 * turretRank; }
export function freeMines(mineRank) { return 2 * mineRank; }
export function legacyTotalRanks(legacy) {
  return LEGACY_PERKS.reduce((sum, p) => sum + (legacy[p.key] || 0), 0);
}

// Shop pricing: base cost + per-purchase growth so the run stays a squeeze.
export const SHOP = {
  repair: { base: 50, growth: 1.5 },
  turret: { base: 120, growth: 1.6 },
  mine: { base: 40, growth: 1.3 },
  slow: { base: 80, growth: 1.5 },
};
export function nextShopCost(currentCost, item) {
  return Math.round(currentCost * SHOP[item].growth);
}

/* ---------- kill combos ---------- */
// Chained kills inside a rolling window build a combo; the combo multiplies
// every kill's XP/energy payout. Uncapped — a monster streak SHOULD pay
// monstrously. State is a plain {count, expiresAt} record.

export const COMBO_WINDOW = 4; // seconds a combo stays alive after each kill

export function comboMultiplier(count) {
  return count <= 1 ? 1 : 1 + (count - 1) * 0.15;
}

export function applyCombo(state, kills, now) {
  const count = now > state.expiresAt ? kills : state.count + kills;
  return { count, expiresAt: now + COMBO_WINDOW };
}

/* ---------- terrain strata ---------- */
// Depth-based rock strata measured from the pristine surface; resistance is
// in hit-points (see applyDamage in voxel-gen.js).

export function stratumForDepth(depth) {
  if (depth <= 1) return { type: "sub", resistance: 1 };
  if (depth <= 4) return { type: "rock", resistance: 3 };
  if (depth <= 9) return { type: "ironstone", resistance: 6 };
  if (depth <= 19) return { type: "deepstone", resistance: 10 };
  return { type: "bedrock", resistance: 18 };
}

/* ---------- contracts: per-run optional objectives ---------- */
// Three are drawn per run (seeded — a daily's contracts are the same all
// day). Each pays instantly on completion; finishing all three pays a bonus.
// Progress is computed purely from the run's counter snapshot, so the same
// code drives the HUD and the tests.

export const CONTRACT_REWARD = { energy: 120, shards: 2 };
export const CONTRACTS_ALL_BONUS_SHARDS = 3;

export const CONTRACT_POOL = [
  { key: "blast-multi", icon: "💥", kind: "maxBlastKills", tiers: [3, 4, 5], label: (n) => `Kill ${n} zombies with one blast` },
  { key: "mine-kills", icon: "💣", kind: "mineKills", tiers: [4, 8], label: (n) => `Destroy ${n} zombies with mines` },
  { key: "turret-kills", icon: "🗼", kind: "turretKills", tiers: [10, 20], label: (n) => `Turrets destroy ${n} zombies` },
  { key: "reach-wave", icon: "🌊", kind: "wave", tiers: [5, 7, 9], label: (n) => `Reach wave ${n}` },
  { key: "kill-count", icon: "🧟", kind: "kills", tiers: [40, 75, 120], label: (n) => `Destroy ${n} zombies` },
  { key: "elite-kill", icon: "👑", kind: "maxLevelKilled", tiers: [3, 4, 5], label: (n) => `Destroy a level ${n}+ zombie` },
  { key: "hold-energy", icon: "⚡", kind: "maxEnergy", tiers: [250, 400], label: (n) => `Hold ${n} energy at once` },
  { key: "no-repair", icon: "🛡️", kind: "noRepairWave", tiers: [4, 6], label: (n) => `Reach wave ${n} before your first repair` },
];

export function generateContracts(seedStr) {
  const rand = mulberry32(hashSeed(seedStr + ":contracts"));
  const pool = [...CONTRACT_POOL];
  const picked = [];
  for (let i = 0; i < 3; i++) {
    const idx = Math.floor(rand() * pool.length);
    const def = pool.splice(idx, 1)[0];
    const target = def.tiers[Math.floor(rand() * def.tiers.length)];
    picked.push({ key: def.key, icon: def.icon, kind: def.kind, target, label: def.label(target) });
  }
  return picked;
}

// Counter snapshot shape kept by the game during a run — see freshRunCounters.
export function freshRunCounters() {
  return {
    kills: 0, wave: 0, maxBlastKills: 0, mineKills: 0, turretKills: 0,
    maxLevelKilled: 0, maxEnergy: 0, waveAtFirstRepair: Infinity,
  };
}

export function contractProgress(contract, counters) {
  switch (contract.kind) {
    case "maxBlastKills": return counters.maxBlastKills;
    case "mineKills": return counters.mineKills;
    case "turretKills": return counters.turretKills;
    case "wave": return counters.wave;
    case "kills": return counters.kills;
    case "maxLevelKilled": return counters.maxLevelKilled;
    case "maxEnergy": return counters.maxEnergy;
    // Frozen at the wave you first repaired on — repairing before the target
    // wave locks this contract out for the rest of the run.
    case "noRepairWave": return Math.min(counters.wave, counters.waveAtFirstRepair);
    default: return 0;
  }
}

export function contractDone(contract, counters) {
  return contractProgress(contract, counters) >= contract.target;
}

/* ---------- daily challenge ---------- */
// One fixed world per UTC day: same seed, same biome, same contracts for
// every run that day. Playing on consecutive days builds a streak.

export const BIOME_KEYS = ["plains", "desert", "snowy", "islands", "mountains", "swamp"];

export function dayString(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function prevDayString(day) {
  const [y, m, d] = day.split("-").map(Number);
  return dayString(new Date(Date.UTC(y, m - 1, d) - 86400000));
}

export function dailySeed(day) { return `daily-${day}`; }

export function dailyBiome(day) {
  return BIOME_KEYS[hashSeed(day) % BIOME_KEYS.length];
}

// Called when a daily run STARTS (playing at all is what keeps the flame
// alive). Same-day replays don't re-count; a missed day resets to 1.
export function updateDailyOnPlay(state, today) {
  if (state.lastDay === today) return { ...state };
  const streak = state.lastDay === prevDayString(today) ? state.streak + 1 : 1;
  return { ...state, lastDay: today, streak, todayBest: 0 };
}

// Called when a daily run ENDS with its score.
export function recordDailyScore(state, today, score) {
  const next = { ...state };
  if (state.lastDay === today) next.todayBest = Math.max(state.todayBest, score);
  if (score > (state.bestScore || 0)) { next.bestScore = score; next.bestDay = today; }
  return next;
}

/* ---------- achievements ---------- */

export const ACHIEVEMENTS = {
  "first-blood": "🏆 First Blood — destroy your first zombie",
  "exterminator": "🏆 Exterminator — 100 kills in one run",
  "wave-5": "🏆 Holding On — survive to wave 5",
  "wave-10": "🏆 Unbreakable — survive to wave 10",
  "wave-15": "🏆 Bulwark — survive to wave 15",
  "wave-20": "🏆 Eternal Vigil — survive to wave 20",
  "evolved-5": "🏆 It's Growing — witness a level 5 zombie",
  "evolved-10": "🏆 Apex Predator — witness a level 10 zombie",
  "engineer": "🏆 Engineer — 3 turrets standing at once",
  "rich": "🏆 War Chest — hold 500 energy",
  "boss-slayer": "🏆 Giantsbane — destroy a boss",
  "combo-10": "🏆 Rampage — chain a ×10 kill combo",
  "contracts": "🏆 Contractor — complete all 3 contracts in one run",
  "streak-3": "🏆 Devoted — 3-day Daily Challenge streak",
  "kills-1000": "🏆 Legion Slayer — 1,000 lifetime kills",
  "legacy-5": "🏆 Dynasty — earn 5 Legacy ranks",
};

/* ---------- persisted-state sanitizers ---------- */
// localStorage payloads are user-editable and versions drift; every load
// goes through one of these so the game only ever sees a well-formed shape.

function nonNegNumber(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function sanitizeLegacy(raw) {
  const legacy = { heartRank: 0, energyRank: 0, blastRank: 0, turretRank: 0, mineRank: 0, shardRank: 0, shards: 0 };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(legacy)) legacy[k] = Math.floor(nonNegNumber(raw[k]));
  }
  return legacy;
}

export function sanitizeStats(raw) {
  const stats = {
    runs: 0, kills: 0, bosses: 0, totalWaves: 0, bestWave: 0,
    timePlayed: 0, dailies: 0, contractsDone: 0, bestCombo: 0,
  };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(stats)) stats[k] = nonNegNumber(raw[k]);
    for (const k of Object.keys(stats)) if (k !== "timePlayed") stats[k] = Math.floor(stats[k]);
  }
  return stats;
}

export function sanitizeDaily(raw) {
  const daily = { lastDay: "", streak: 0, todayBest: 0, bestScore: 0, bestDay: "" };
  if (raw && typeof raw === "object") {
    if (typeof raw.lastDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastDay)) daily.lastDay = raw.lastDay;
    if (typeof raw.bestDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.bestDay)) daily.bestDay = raw.bestDay;
    daily.streak = Math.floor(nonNegNumber(raw.streak));
    daily.todayBest = Math.floor(nonNegNumber(raw.todayBest));
    daily.bestScore = Math.floor(nonNegNumber(raw.bestScore));
  }
  return daily;
}
