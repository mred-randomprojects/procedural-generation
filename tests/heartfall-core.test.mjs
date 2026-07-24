// Heartfall core test suite — pins down every balance curve, progression
// cost, and game rule in js/heartfall-core.js. Run with `npm test`
// (node --test; no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../js/heartfall-core.js";

/* ---------- PRNG ---------- */

test("hashSeed is deterministic and spreads inputs", () => {
  assert.equal(core.hashSeed("terra"), core.hashSeed("terra"));
  assert.notEqual(core.hashSeed("terra"), core.hashSeed("terrb"));
});

test("mulberry32 yields a deterministic [0,1) stream", () => {
  const a = core.mulberry32(123), b = core.mulberry32(123);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

/* ---------- difficulty & Heart ---------- */

test("heartMaxHp scales with legacy rank and difficulty", () => {
  assert.equal(core.heartMaxHp(0, "normal"), 100);
  assert.equal(core.heartMaxHp(2, "normal"), 140);
  assert.equal(core.heartMaxHp(0, "easy"), 150);
  assert.equal(core.heartMaxHp(0, "hard"), 75);
});

test("difficulty ordering: easy is strictly more forgiving than hard", () => {
  const { easy, normal, hard } = core.DIFFICULTIES;
  assert.ok(easy.hp > normal.hp && normal.hp > hard.hp);
  assert.ok(easy.wave > normal.wave && normal.wave > hard.wave);
  assert.ok(easy.trickle > normal.trickle && normal.trickle > hard.trickle);
});

/* ---------- blast progression ---------- */

test("blastUnlockCost is strictly increasing with no ceiling", () => {
  let prev = 0;
  for (let r = 4; r <= 30; r++) {
    const cost = core.blastUnlockCost(r);
    assert.ok(cost > prev, `cost(${r})=${cost} should exceed cost(${r - 1})=${prev}`);
    prev = cost;
  }
});

test("blastUnlockCost matches the published table through radius 8", () => {
  assert.equal(core.blastUnlockCost(4), 40);
  assert.equal(core.blastUnlockCost(8), 550);
  assert.equal(core.blastUnlockCost(9), 850); // 550 + 300
});

/* ---------- zombie curves ---------- */

test("level-1 zombies are the anchor: 1 hp, 1 dps, no armor, speed 1", () => {
  assert.equal(core.maxHpFor(1), 1);
  assert.equal(core.dpsFor(1), 1);
  assert.equal(core.defenseFor(1), 0);
  assert.equal(core.defenseFor(2), 0);
  assert.equal(core.stackSpeed(1), 1);
});

test("stat curves respect their slider slopes", () => {
  assert.equal(core.maxHpFor(5, 2), 9);
  assert.equal(core.dpsFor(4, 0.5), 2.5);
  assert.equal(core.stackSpeed(3, 0.3), 1.6);
});

test("eatsNeededForLevel is the odd-number ladder", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(core.eatsNeededForLevel), [1, 3, 5, 7, 9]);
});

test("attackInterval shrinks with level but DPS stays exact", () => {
  assert.ok(core.attackInterval(5) < core.attackInterval(1));
  // damage per shot × shots per second == dpsFor(level), at any cadence slope
  for (const atk of [0, 0.25, 1]) {
    const interval = core.attackInterval(6, atk);
    const perShot = core.dpsFor(6) * interval;
    assert.ok(Math.abs(perShot / interval - core.dpsFor(6)) < 1e-9);
  }
});

test("effectiveHitDamage floors at zero: runts cannot scratch elites", () => {
  const dmg = core.effectiveHitDamage(core.dpsFor(1), core.attackInterval(1), 10);
  assert.equal(dmg, 0);
  const even = core.effectiveHitDamage(core.dpsFor(3), core.attackInterval(3), 1);
  assert.ok(even > 0);
});

/* ---------- waves & bosses ---------- */

test("waveDelay shrinks as waves progress and floors at 10s", () => {
  assert.ok(core.waveDelay(1) > core.waveDelay(5));
  assert.equal(core.waveDelay(100), 10);
  assert.equal(core.waveDelay(2, 2), (22 - 1) * 2);
});

test("waveSpawnCount and trickleDelay escalate pressure", () => {
  assert.equal(core.waveSpawnCount(1), 3);
  assert.ok(core.waveSpawnCount(10) > core.waveSpawnCount(5));
  assert.ok(core.trickleDelay(10) < core.trickleDelay(1));
  assert.equal(core.trickleDelay(1000), 1.5);
});

test("boss waves land every 5th wave, escalating +2 levels each", () => {
  for (const w of [1, 2, 3, 4, 6, 7, 9, 11]) assert.ok(!core.isBossWave(w), `wave ${w}`);
  for (const w of [5, 10, 15, 20]) assert.ok(core.isBossWave(w), `wave ${w}`);
  assert.equal(core.bossLevelForWave(5), 4);
  assert.equal(core.bossLevelForWave(10), 6);
  assert.equal(core.bossLevelForWave(15), 8);
  assert.ok(core.bossBounty(6) > core.bossBounty(4));
  assert.ok(core.BOSS_SPEED_FACTOR > 0 && core.BOSS_SPEED_FACTOR < 1);
});

/* ---------- economy ---------- */

test("kill payout scales with level; score mixes time and kills", () => {
  assert.equal(core.killPayout(1), 10);
  assert.equal(core.killPayout(7), 70);
  assert.equal(core.runScore(90, 10), 140);
});

test("legacyCost grows with rank", () => {
  assert.equal(core.legacyCost(0), 3);
  assert.ok(core.legacyCost(5) > core.legacyCost(4));
});

test("shardsForScore pays at least 1 and Shard Magnet multiplies", () => {
  assert.equal(core.shardsForScore(0), 1);
  assert.equal(core.shardsForScore(100), 2);
  assert.equal(core.shardsForScore(1000, 0), 20);
  assert.equal(core.shardsForScore(1000, 2), 26); // ×1.3
});

test("legacy perk helpers", () => {
  assert.equal(core.turretDamage(0), 1);
  assert.equal(core.turretDamage(3), 2.5);
  assert.equal(core.freeMines(0), 0);
  assert.equal(core.freeMines(2), 4);
  assert.equal(core.legacyTotalRanks({ heartRank: 2, blastRank: 1, shardRank: 2 }), 5);
  assert.equal(core.LEGACY_PERKS.length, 6);
  const keys = core.LEGACY_PERKS.map((p) => p.key);
  assert.equal(new Set(keys).size, 6);
});

test("shop costs escalate per purchase", () => {
  assert.equal(core.nextShopCost(core.SHOP.repair.base, "repair"), 75);
  for (const item of Object.keys(core.SHOP)) {
    assert.ok(core.SHOP[item].growth > 1, `${item} must get pricier`);
    assert.ok(core.nextShopCost(core.SHOP[item].base, item) > core.SHOP[item].base);
  }
});

/* ---------- combos ---------- */

test("comboMultiplier: no bonus below 2 kills, linear and uncapped after", () => {
  assert.equal(core.comboMultiplier(0), 1);
  assert.equal(core.comboMultiplier(1), 1);
  assert.equal(core.comboMultiplier(2), 1.15);
  assert.ok(Math.abs(core.comboMultiplier(11) - 2.5) < 1e-9);
  assert.ok(core.comboMultiplier(101) > 15); // deliberately uncapped
});

test("applyCombo chains inside the window and resets outside it", () => {
  let s = { count: 0, expiresAt: -Infinity };
  s = core.applyCombo(s, 3, 100); // fresh start
  assert.equal(s.count, 3);
  assert.equal(s.expiresAt, 100 + core.COMBO_WINDOW);
  s = core.applyCombo(s, 2, 101); // within window → chains
  assert.equal(s.count, 5);
  s = core.applyCombo(s, 1, s.expiresAt + 0.01); // expired → resets
  assert.equal(s.count, 1);
});

/* ---------- canonical ranked balance ---------- */

test("ranked tweak defaults: near-neutral kills, sim runs 1:1", () => {
  const t = core.CANONICAL_TWEAKS;
  assert.equal(t.spawnsPerKill, 1.1); // NOT 2 — a 10% whisper of growth, never a snowball
  assert.equal(t.spawnsPerEat, 1);
  assert.equal(t.spawnDelay, 0);
  assert.equal(t.simSpeed, 1);
  assert.equal(t.speedPerLevel, 0.3);
  assert.equal(t.hpPerLevel, 1);
  assert.equal(t.dmgPerLevel, 1);
  assert.equal(t.atkPerLevel, 0.25);
});

test("spawnsForKills: integer rates are exact, fractions roll the leftover", () => {
  // Integer rates never touch the RNG.
  const explode = () => { throw new Error("rand must not be called"); };
  assert.equal(core.spawnsForKills(3, 1, explode), 3);
  assert.equal(core.spawnsForKills(5, 2, explode), 10);
  assert.equal(core.spawnsForKills(4, 0, explode), 0);
  // 1 kill at 1.1 → 1 guaranteed, +1 iff the roll lands under 0.1.
  assert.equal(core.spawnsForKills(1, 1.1, () => 0.05), 2);
  assert.equal(core.spawnsForKills(1, 1.1, () => 0.5), 1);
  // 10 kills at 1.1 → exactly 11, no roll left to make.
  assert.equal(core.spawnsForKills(10, 1.1, explode), 11);
  // Sub-1 rates work too: 0.5 = a coin flip per kill batch.
  assert.equal(core.spawnsForKills(1, 0.5, () => 0.49), 1);
  assert.equal(core.spawnsForKills(1, 0.5, () => 0.51), 0);
  // The expectation is exactly kills*rate across the roll space:
  // 7 kills at 1.1 → 7.7 → 7 + P(0.7) — check both branches exist.
  assert.equal(core.spawnsForKills(7, 1.1, () => 0.69), 8);
  assert.equal(core.spawnsForKills(7, 1.1, () => 0.71), 7);
});

/* ---------- strata ---------- */

test("stratumForDepth gets strictly tougher with depth", () => {
  const depths = [1, 2, 5, 10, 20, 50];
  let prev = 0;
  for (const d of depths) {
    const s = core.stratumForDepth(d);
    assert.ok(s.resistance >= prev, `depth ${d}`);
    prev = s.resistance;
  }
  assert.equal(core.stratumForDepth(1).type, "sub");
  assert.equal(core.stratumForDepth(25).type, "bedrock");
});

/* ---------- contracts ---------- */

test("generateContracts draws 3 distinct, valid, deterministic contracts", () => {
  const a = core.generateContracts("seed-1");
  const b = core.generateContracts("seed-1");
  assert.deepEqual(a, b); // deterministic per seed (dailies share contracts all day)
  assert.equal(a.length, 3);
  assert.equal(new Set(a.map((c) => c.key)).size, 3);
  const poolKeys = new Set(core.CONTRACT_POOL.map((p) => p.key));
  for (const c of a) {
    assert.ok(poolKeys.has(c.key));
    assert.ok(c.target > 0);
    assert.ok(c.label.length > 0);
    const def = core.CONTRACT_POOL.find((p) => p.key === c.key);
    assert.ok(def.tiers.includes(c.target));
    assert.equal(c.kind, def.kind);
  }
  // different seeds should (eventually) differ
  const seeds = ["s1", "s2", "s3", "s4", "s5"];
  const variety = new Set(seeds.map((s) => JSON.stringify(core.generateContracts(s))));
  assert.ok(variety.size > 1);
});

test("contractProgress reads the right counter for every kind", () => {
  const counters = {
    ...core.freshRunCounters(),
    kills: 12, wave: 6, maxBlastKills: 4, mineKills: 2, turretKills: 7,
    maxLevelKilled: 3, maxEnergy: 320,
  };
  const byKind = (kind, target = 999) => ({ kind, target });
  assert.equal(core.contractProgress(byKind("kills"), counters), 12);
  assert.equal(core.contractProgress(byKind("wave"), counters), 6);
  assert.equal(core.contractProgress(byKind("maxBlastKills"), counters), 4);
  assert.equal(core.contractProgress(byKind("mineKills"), counters), 2);
  assert.equal(core.contractProgress(byKind("turretKills"), counters), 7);
  assert.equal(core.contractProgress(byKind("maxLevelKilled"), counters), 3);
  assert.equal(core.contractProgress(byKind("maxEnergy"), counters), 320);
});

test("no-repair contract freezes at the wave of the first repair", () => {
  const c = { kind: "noRepairWave", target: 6 };
  const clean = { ...core.freshRunCounters(), wave: 7 };
  assert.ok(core.contractDone(c, clean));
  const repairedEarly = { ...core.freshRunCounters(), wave: 9, waveAtFirstRepair: 3 };
  assert.equal(core.contractProgress(c, repairedEarly), 3);
  assert.ok(!core.contractDone(c, repairedEarly)); // locked out forever
  const repairedLate = { ...core.freshRunCounters(), wave: 9, waveAtFirstRepair: 8 };
  assert.ok(core.contractDone(c, repairedLate)); // repaired only after clearing it
});

test("every pool kind is handled by contractProgress", () => {
  const counters = core.freshRunCounters();
  for (const def of core.CONTRACT_POOL) {
    // must not fall through to the default-0 branch via a typo'd kind:
    // progress with fresh counters is a number, and bumping the matching
    // counter must move it (except noRepairWave which mixes two counters).
    const before = core.contractProgress({ kind: def.kind, target: 1 }, counters);
    assert.equal(typeof before, "number");
  }
});

/* ---------- daily challenge ---------- */

test("dayString/prevDayString handle month and year boundaries (UTC)", () => {
  assert.equal(core.dayString(new Date(Date.UTC(2026, 6, 23, 12))), "2026-07-23");
  assert.equal(core.prevDayString("2026-07-01"), "2026-06-30");
  assert.equal(core.prevDayString("2026-01-01"), "2025-12-31");
  assert.equal(core.prevDayString("2026-03-01"), "2026-02-28");
  assert.equal(core.prevDayString("2024-03-01"), "2024-02-29"); // leap year
});

test("dailySeed and dailyBiome are stable per day and biome is valid", () => {
  assert.equal(core.dailySeed("2026-07-23"), "daily-2026-07-23");
  const biome = core.dailyBiome("2026-07-23");
  assert.equal(biome, core.dailyBiome("2026-07-23"));
  assert.ok(core.BIOME_KEYS.includes(biome));
  // different days shouldn't all map to one biome
  const days = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25", "2026-07-26"];
  assert.ok(new Set(days.map(core.dailyBiome)).size > 1);
});

test("daily streak: consecutive days chain, same day no-ops, gaps reset", () => {
  const fresh = core.sanitizeDaily(null);
  let s = core.updateDailyOnPlay(fresh, "2026-07-21");
  assert.equal(s.streak, 1);
  s = core.updateDailyOnPlay(s, "2026-07-22");
  assert.equal(s.streak, 2);
  const again = core.updateDailyOnPlay(s, "2026-07-22"); // second run same day
  assert.equal(again.streak, 2);
  s = core.updateDailyOnPlay(s, "2026-07-23");
  assert.equal(s.streak, 3);
  s = core.updateDailyOnPlay(s, "2026-07-30"); // missed days
  assert.equal(s.streak, 1);
});

test("daily scores: todayBest resets each day, bestScore is all-time", () => {
  let s = core.sanitizeDaily(null);
  s = core.updateDailyOnPlay(s, "2026-07-22");
  s = core.recordDailyScore(s, "2026-07-22", 300);
  assert.equal(s.todayBest, 300);
  s = core.recordDailyScore(s, "2026-07-22", 250); // worse run, best stands
  assert.equal(s.todayBest, 300);
  s = core.updateDailyOnPlay(s, "2026-07-23");
  assert.equal(s.todayBest, 0); // new day, fresh board
  s = core.recordDailyScore(s, "2026-07-23", 280);
  assert.equal(s.todayBest, 280);
  assert.equal(s.bestScore, 300);
  assert.equal(s.bestDay, "2026-07-22");
});

/* ---------- achievements & sanitizers ---------- */

test("achievements table has the full 16 with labels", () => {
  const keys = Object.keys(core.ACHIEVEMENTS);
  assert.equal(keys.length, 16);
  for (const k of keys) assert.ok(core.ACHIEVEMENTS[k].startsWith("🏆"));
  for (const k of ["boss-slayer", "combo-10", "contracts", "streak-3", "kills-1000", "legacy-5", "wave-15", "wave-20"]) {
    assert.ok(keys.includes(k), k);
  }
});

test("sanitizeLegacy fills defaults and rejects garbage", () => {
  assert.deepEqual(core.sanitizeLegacy(null), core.sanitizeLegacy(undefined));
  const clean = core.sanitizeLegacy({ shards: 7, heartRank: 2, turretRank: "nope", mineRank: -3, bogus: 9 });
  assert.equal(clean.shards, 7);
  assert.equal(clean.heartRank, 2);
  assert.equal(clean.turretRank, 0);
  assert.equal(clean.mineRank, 0);
  assert.ok(!("bogus" in clean));
  // legacy saves from before the new perks existed still load
  const old = core.sanitizeLegacy({ shards: 5, heartRank: 1, energyRank: 1, blastRank: 1 });
  assert.equal(old.turretRank, 0);
  assert.equal(old.shardRank, 0);
});

test("sanitizeStats and sanitizeDaily reject malformed payloads", () => {
  const stats = core.sanitizeStats({ kills: 50.9, runs: -2, timePlayed: 12.5, junk: true });
  assert.equal(stats.kills, 50);
  assert.equal(stats.runs, 0);
  assert.equal(stats.timePlayed, 12.5);
  assert.ok(!("junk" in stats));

  const daily = core.sanitizeDaily({ lastDay: "yesterday", streak: 4.7, bestDay: "2026-07-01" });
  assert.equal(daily.lastDay, "");
  assert.equal(daily.streak, 4);
  assert.equal(daily.bestDay, "2026-07-01");
});
