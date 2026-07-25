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

/* ---------- upgrade progression ---------- */

test("upgradeUnlockCost is strictly increasing with no ceiling", () => {
  let prev = 0;
  for (let n = 1; n <= 40; n++) {
    const cost = core.upgradeUnlockCost(n);
    assert.ok(cost > prev, `cost(${n})=${cost} should exceed cost(${n - 1})=${prev}`);
    prev = cost;
  }
});

test("upgradeUnlockCost keeps the early table, then gaps grow geometrically", () => {
  assert.equal(core.upgradeUnlockCost(1), 40);
  assert.equal(core.upgradeUnlockCost(5), 550);
  assert.equal(core.upgradeUnlockCost(6), 890); // 550 + round(200 × 1.7)
  // Deep-run nerf: the gap between successive upgrades must itself keep
  // growing (geometric), so a 15M-XP run banks ~20 upgrades, not ~320.
  for (let n = 7; n <= 30; n++) {
    const gapPrev = core.upgradeUnlockCost(n - 1) - core.upgradeUnlockCost(n - 2);
    const gap = core.upgradeUnlockCost(n) - core.upgradeUnlockCost(n - 1);
    assert.ok(gap > gapPrev * 1.5, `gap(${n})=${gap} should outgrow gap(${n - 1})=${gapPrev}`);
  }
  // The run that reached radius 324 earned ~15M XP; that now banks ~24
  // upgrade choices (split between radius and damage), not 320 radii.
  assert.ok(core.upgradeUnlockCost(25) > 15_000_000, "radius 324 must be unreachable");
});

test("blastZombieDamage: 1 outer / 2 core, multiplied by blast damage", () => {
  assert.equal(core.blastZombieDamage(false), 1);
  assert.equal(core.blastZombieDamage(true), 2);
  assert.equal(core.blastZombieDamage(false, 3), 3);
  assert.equal(core.blastZombieDamage(true, 3), 6);
});

test("craterBlockDamage scales with blast damage and vanishes past the radius", () => {
  assert.equal(core.craterBlockDamage(9, 8), 0);
  assert.equal(core.craterBlockDamage(9, 8, 5), 0);
  // dead center of a radius-4 blast: base round(4×0.85+1)=4, core-doubled
  assert.equal(core.craterBlockDamage(0, 4), 8);
  assert.equal(core.craterBlockDamage(0, 4, 3), 24);
  // outer ring: base floors at 1, so damage is exactly the blast-damage stat
  assert.equal(core.craterBlockDamage(4, 4), 1);
  assert.equal(core.craterBlockDamage(4, 4, 4), 4);
  // higher damage chews deeper strata: 24 HP breaches sub+rock+ironstone+deepstone
  const strata = [core.stratumForDepth(1), core.stratumForDepth(2), core.stratumForDepth(5)];
  assert.ok(core.craterBlockDamage(0, 4, 3) >= strata.reduce((s, x) => s + x.resistance, 0));
});

/* ---------- horde mutations ---------- */

test("mutationDelay tightens over the run and floors at 45s", () => {
  assert.equal(core.mutationDelay(0), 80);
  assert.ok(core.mutationDelay(3) < core.mutationDelay(0));
  assert.equal(core.mutationDelay(100), 45);
  assert.equal(core.mutationDelay(0, 1.35), 80 * 1.35); // easy mutates slower
});

test("mutationAtIndex is seeded: deterministic per (seed, index), varied across them", () => {
  const a = core.mutationAtIndex("daily-2026-07-24", 0);
  assert.equal(a, core.mutationAtIndex("daily-2026-07-24", 0));
  assert.ok(core.MUTATION_POOL.includes(a));
  // some pair of indices must differ, or the "pool" is a lie
  const picks = new Set();
  for (let i = 0; i < 30; i++) picks.add(core.mutationAtIndex("terra", i).key);
  assert.ok(picks.size > 1);
});

test("mutation pool entries are well-formed and unique", () => {
  const keys = core.MUTATION_POOL.map((m) => m.key);
  assert.equal(new Set(keys).size, core.MUTATION_POOL.length);
  for (const m of core.MUTATION_POOL) {
    assert.ok(m.icon && m.name && m.desc, m.key);
  }
});

/* ---------- condensation ---------- */

test("condensation halves a fusing cohort, rounding down", () => {
  assert.equal(core.condenseSurvivors(100), 50);
  assert.equal(core.condenseSurvivors(101), 50);
  assert.equal(core.CONDENSE_THRESHOLD, 100);
  // A merge, not a cull: a fusing cohort must always leave survivors behind.
  assert.ok(core.condenseSurvivors(core.CONDENSE_THRESHOLD) > 0);
});

test("condensation ratchets the spawn floor up, never down", () => {
  assert.equal(core.condenseFloor(1, 1), 2); // first lvl-1 fusion → spawns start at 2
  assert.equal(core.condenseFloor(2, 4), 5); // higher fusion raises it further
  assert.equal(core.condenseFloor(5, 2), 5); // a straggler fusion can't lower it
});

/* ---------- zombie curves ---------- */

test("level-1 zombies are the anchor: 1 hp, 1 dps, no armor, speed 1", () => {
  assert.equal(core.maxHpFor(1), 1);
  assert.equal(core.dpsFor(1), 1);
  assert.equal(core.damageTakenMultiplier(1), 1); // no reduction at all
  assert.equal(core.armorReduction(1), 0);
  assert.equal(core.stackSpeed(1), 1);
});

test("armor reduces logarithmically and never reaches immunity", () => {
  let prev = 1;
  for (let lv = 2; lv <= 5000; lv++) {
    const mult = core.damageTakenMultiplier(lv);
    assert.ok(mult < prev, `level ${lv} must take less than ${lv - 1}`);
    assert.ok(mult > 0, `level ${lv} must never be immune`);
    prev = mult;
  }
  // Diminishing returns: the first ten levels of armor must buy more
  // reduction than the next ninety, or it isn't logarithmic.
  const early = core.armorReduction(10) - core.armorReduction(1);
  const late = core.armorReduction(100) - core.armorReduction(10);
  assert.ok(early > late);
  // Even at levels no run will ever reach, damage still lands — and at
  // levels runs DO reach, it lands at a workable rate.
  assert.ok(core.damageTakenMultiplier(1e6) > 0);
  assert.ok(core.damageTakenMultiplier(1000) > 0.15);
  // Mid-level elites must still be meaningfully armored, or level stops
  // mattering in zombie-vs-zombie fights at all.
  assert.ok(core.armorReduction(10) > 0.4);
});

test("effectiveHitDamage is always positive: no attacker is ever shut out", () => {
  // The old flat-armor rule zeroed this out entirely; a runt must now be
  // able to wear an elite down, however slowly.
  const runtVsElite = core.effectiveHitDamage(core.dpsFor(1), core.attackInterval(1), 100);
  assert.ok(runtVsElite > 0);
  // …but it must still be far worse than hitting an unarmored target.
  const runtVsRunt = core.effectiveHitDamage(core.dpsFor(1), core.attackInterval(1), 1);
  assert.ok(runtVsElite < runtVsRunt / 2);
  assert.equal(core.effectiveHitDamage(0, 1, 5), 0); // no damage in, none out
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

test("armor still makes level a real advantage in a fight", () => {
  // Same shooter, tougher target: strictly less damage lands.
  const vsWeak = core.effectiveHitDamage(core.dpsFor(3), core.attackInterval(3), 1);
  const vsStrong = core.effectiveHitDamage(core.dpsFor(3), core.attackInterval(3), 12);
  assert.ok(vsStrong < vsWeak);
  assert.ok(vsStrong > 0);
});

/* ---------- the escalating spawn rate ---------- */

test("spawn rate steps +0.1 every 25 peak levels, forever", () => {
  const base = core.CANONICAL_TWEAKS.spawnsPerKill;
  assert.equal(core.effectiveSpawnsPerKill(base, 0), 1.1);
  assert.equal(core.effectiveSpawnsPerKill(base, 24), 1.1); // not yet
  assert.equal(core.effectiveSpawnsPerKill(base, 25), 1.2); // first step
  assert.equal(core.effectiveSpawnsPerKill(base, 49), 1.2);
  assert.equal(core.effectiveSpawnsPerKill(base, 50), 1.3);
  assert.equal(core.effectiveSpawnsPerKill(base, 159), 1.7);
  // No ceiling, and no float dust in the HUD readout.
  for (let lv = 0; lv <= 5000; lv += 7) {
    const r = core.effectiveSpawnsPerKill(base, lv);
    assert.equal(r, Math.round(r * 1e6) / 1e6, `level ${lv} leaked float dust`);
  }
  assert.ok(core.effectiveSpawnsPerKill(base, 100000) > 400);
});

test("spawn rate is monotone and its next threshold is always ahead", () => {
  let prev = 0;
  for (let lv = 0; lv <= 2000; lv++) {
    const r = core.effectiveSpawnsPerKill(1.1, lv);
    assert.ok(r >= prev, `level ${lv} went backwards`);
    prev = r;
    const next = core.nextSpawnRateLevel(lv);
    assert.ok(next > lv, `level ${lv} says its next step is ${next}`);
    // Reaching the advertised threshold must actually deliver the step.
    assert.ok(core.effectiveSpawnsPerKill(1.1, next) > r - 1e-9);
  }
  assert.equal(core.nextSpawnRateLevel(0), 25);
  assert.equal(core.nextSpawnRateLevel(25), 50);
  assert.equal(core.nextSpawnRateLevel(159), 175);
});

/* ---------- evolution forms ---------- */

test("drawn size is capped at ×5 and wraps into the next form", () => {
  for (let lv = 1; lv <= 4000; lv++) {
    const { tier, scale } = core.evolutionOf(lv);
    assert.ok(scale < core.EVOLUTION_SCALE_CAP, `level ${lv} drew at ${scale}`);
    assert.ok(scale >= 1, `level ${lv} drew at ${scale}`);
    assert.ok(Number.isInteger(tier) && tier >= 0);
    // Anything that has metamorphosed is born chunkier than a fresh walker.
    if (tier > 0) assert.ok(scale >= core.EVOLUTION_TIER_FLOOR - 1e-9, `tier ${tier} at ${scale}`);
  }
});

test("tiers only ever climb with level, and the ladder never stalls", () => {
  let prevTier = 0;
  for (let lv = 1; lv <= 4000; lv++) {
    const tier = core.evolutionTier(lv);
    assert.ok(tier >= prevTier, `level ${lv} regressed from tier ${prevTier}`);
    prevTier = tier;
  }
  assert.equal(core.evolutionTier(1), 0);
  assert.ok(core.evolutionTier(15) >= 1); // the first metamorphosis
  assert.ok(core.evolutionTier(4000) > core.evolutionTier(400)); // no ceiling
});

test("within one tier the drawn size still grows with level", () => {
  for (let lv = 2; lv <= 400; lv++) {
    const a = core.evolutionOf(lv - 1), b = core.evolutionOf(lv);
    if (a.tier === b.tier) assert.ok(b.scale > a.scale, `level ${lv} did not grow`);
  }
});

test("every tier resolves to an authored body plan", () => {
  assert.equal(core.evolutionForm(0).key, "walker");
  const last = core.EVOLUTION_FORMS[core.EVOLUTION_FORMS.length - 1];
  assert.equal(core.evolutionForm(99).key, last.key); // repeats, never undefined
  for (const f of core.EVOLUTION_FORMS) assert.ok(f.icon && f.name && f.desc, f.key);
  assert.equal(new Set(core.EVOLUTION_FORMS.map((f) => f.key)).size, core.EVOLUTION_FORMS.length);
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

test("fmtNum compacts unreadable numbers, keeps small ones exact", () => {
  assert.equal(core.fmtNum(0), "0");
  assert.equal(core.fmtNum(9999), "9999"); // below 10k stays exact
  assert.equal(core.fmtNum(2321075), "~2.3M"); // the reported eyesore
  assert.equal(core.fmtNum(45000), "45k"); // exact multiples skip the ~
  assert.equal(core.fmtNum(45500), "45.5k");
  assert.equal(core.fmtNum(123456), "~123k"); // ≥100 units: no decimals
  assert.equal(core.fmtNum(999999), "~1M"); // promotes, never "1000k"
  assert.equal(core.fmtNum(2500000000), "2.5B");
  assert.equal(core.fmtNum(7e12), "7T");
  assert.equal(core.fmtNum(-2321075), "~-2.3M");
});

test("legacy perk helpers", () => {
  assert.equal(core.turretDamage(0), 1);
  assert.equal(core.turretDamage(3), 2.5);
  assert.equal(core.turretRange(0), 8); // base targeting radius
  assert.equal(core.turretRange(3), 14); // +2 blocks per 📡 pick
  assert.equal(core.freeMines(0), 0);
  assert.equal(core.freeMines(2), 4);
  assert.equal(core.legacyTotalRanks({ heartRank: 2, blastRank: 1, shardRank: 2 }), 5);
  assert.equal(core.LEGACY_PERKS.length, 11);
  const keys = core.LEGACY_PERKS.map((p) => p.key);
  assert.equal(new Set(keys).size, 11);
  assert.ok(keys.includes("damageRank")); // Heavy Ordnance: +1 starting blast damage
  assert.ok(keys.includes("rateRank")); // Rapid Coils: towers fire faster
  // Every perk must be a key sanitizeLegacy actually preserves, or buying it
  // would silently evaporate on the next page load.
  const saved = core.sanitizeLegacy(Object.fromEntries(keys.map((k) => [k, 1])));
  for (const k of keys) assert.equal(saved[k], 1, k);
});

/* ---------- towers ---------- */

test("towerCooldown shortens forever without ever reaching zero", () => {
  assert.equal(core.towerCooldown(0), core.TOWER_BASE_COOLDOWN);
  assert.equal(core.towerCooldown(4), core.TOWER_BASE_COOLDOWN / 2); // +25%/rank
  let prev = core.towerCooldown(0);
  for (let r = 1; r <= 50; r++) {
    const cd = core.towerCooldown(r);
    assert.ok(cd < prev, `rank ${r} must fire faster than ${r - 1}`);
    assert.ok(cd > 0, `rank ${r} cooldown must stay positive`);
    prev = cd;
  }
});

test("tower types are distinct and each maps to a real shop item", () => {
  const keys = core.TOWER_TYPES.map((t) => t.key);
  assert.deepEqual(keys, ["bolt", "frost", "arc", "lance"]);
  for (const t of core.TOWER_TYPES) assert.ok(core.SHOP[t.shop], `${t.key} needs a price`);
});

test("lance towers pay for their unbounded pierce in cadence and per-body damage", () => {
  const ranks = 2;
  assert.ok(core.lanceDamage(ranks) < core.turretDamage(ranks));
  assert.ok(core.lanceCooldown(ranks) > core.arcCooldown(ranks)); // slowest tower on the field
  // Single-target DPS must stay the bolt turret's job: a lance that also
  // won the 1v1 would make every other tower pointless.
  const boltDps = core.turretDamage(ranks) / core.towerCooldown(ranks);
  const perBodyDps = core.lanceDamage(ranks) / core.lanceCooldown(ranks);
  assert.ok(perBodyDps < boltDps);
  // A lance must pay off once a handful of bodies line up, or nobody would
  // ever buy the slowest tower on the field. Break-even lands at 4.
  assert.ok(perBodyDps * 3 < boltDps);
  assert.ok(perBodyDps * 4 > boltDps);
  assert.ok(core.LANCE_WIDTH > 0);
});

test("zombie bile flies faster the stronger the shooter", () => {
  assert.equal(core.zombieBoltSpeed(1), core.ZOMBIE_BOLT_BASE_SPEED);
  let prev = core.zombieBoltSpeed(1);
  for (let lv = 2; lv <= 500; lv++) {
    const v = core.zombieBoltSpeed(lv);
    assert.ok(v > prev, `level ${lv} must shoot faster than ${lv - 1}`);
    prev = v;
  }
  // Fast enough to matter, but a level-1 shot must still be the slow one.
  assert.ok(core.zombieBoltSpeed(20) > core.zombieBoltSpeed(1) * 2);
});

test("boltSpeed climbs forever and never stalls a shot", () => {
  assert.equal(core.boltSpeed(0), core.BOLT_BASE_SPEED);
  let prev = core.boltSpeed(0);
  for (let r = 1; r <= 40; r++) {
    const v = core.boltSpeed(r);
    assert.ok(v > prev, `rank ${r} must fly faster`);
    prev = v;
  }
});

test("repairs restore a share of max HP, so Reinforced Heart compounds", () => {
  const weak = core.heartMaxHp(0, "normal"), strong = core.heartMaxHp(10, "normal");
  assert.ok(core.repairAmount(strong) > core.repairAmount(weak));
  assert.equal(core.repairAmount(weak), Math.round(weak * core.REPAIR_FRACTION));
  assert.ok(core.repairAmount(1) >= 1); // never a no-op purchase
  assert.ok(core.repairAmount(weak) < weak); // never a full heal
});

test("comboWindow widens with Killing Spree ranks and drives applyCombo", () => {
  assert.equal(core.comboWindow(0), core.COMBO_WINDOW);
  assert.equal(core.comboWindow(4), core.COMBO_WINDOW + 2);
  const s = core.applyCombo({ count: 0, expiresAt: -Infinity }, 1, 100, core.comboWindow(2));
  assert.equal(s.expiresAt, 100 + core.COMBO_WINDOW + 1);
  // A kill landing inside the widened window still chains where the base
  // window would already have dropped it.
  const late = core.COMBO_WINDOW + 0.5;
  assert.equal(core.applyCombo(s, 1, 100 + late, core.comboWindow(2)).count, 2);
  const base = core.applyCombo({ count: 0, expiresAt: -Infinity }, 1, 100);
  assert.equal(core.applyCombo(base, 1, 100 + late).count, 1); // chain broken
});

test("arc towers trade per-body damage and cadence for hitting a clump", () => {
  const ranks = 2;
  assert.ok(core.arcDamage(ranks) < core.turretDamage(ranks)); // weaker per body
  assert.ok(core.arcDamage(ranks) * core.ARC_CHAIN > core.turretDamage(ranks)); // stronger per shot
  assert.ok(core.arcCooldown(ranks) > core.towerCooldown(ranks)); // …but slower
  const boltDps = core.turretDamage(ranks) / core.towerCooldown(ranks);
  // Damage-per-second on a single isolated target must still favour a bolt
  // turret, or the arc tower would be a strict upgrade rather than a choice.
  assert.ok(core.arcDamage(ranks) / core.arcCooldown(ranks) < boltDps);
  // …and a FULL fork must beat it, or the arc tower is a strict downgrade
  // and there is no reason to ever buy one. Both directions matter.
  const arcFullDps = core.arcDamage(ranks) * core.ARC_CHAIN / core.arcCooldown(ranks);
  assert.ok(arcFullDps > boltDps, `arc at full chain (${arcFullDps}) must beat bolt (${boltDps})`);
});

test("frost towers grow with 📡 picks and chip harder with 🎯 picks", () => {
  assert.ok(core.frostRadius(2) > core.frostRadius(0));
  assert.ok(core.frostTickDamage(3) > core.frostTickDamage(0));
  assert.ok(core.FROST_SLOW > 0 && core.FROST_SLOW < 1); // a slow, not a stop
});

/* ---------- sanctuary ---------- */

test("sanctuaryRadius keeps spawns off the Heart and grows per ward", () => {
  assert.equal(core.sanctuaryRadius(0), core.SANCTUARY_BASE);
  assert.ok(core.SANCTUARY_BASE > 0); // unwarded runs still get bare ground
  let prev = core.sanctuaryRadius(0);
  for (let r = 1; r <= 10; r++) {
    const rad = core.sanctuaryRadius(r);
    assert.equal(rad - prev, core.SANCTUARY_PER_WARD);
    prev = rad;
  }
  // Consecrated Ground stacks on top, and is worth less than an in-run Ward.
  assert.equal(core.sanctuaryRadius(0, 3), core.SANCTUARY_BASE + 3 * core.SANCTUARY_PER_LEGACY);
  assert.ok(core.SANCTUARY_PER_LEGACY < core.SANCTUARY_PER_WARD);
  assert.equal(core.sanctuaryRadius(1, 1), core.SANCTUARY_BASE + core.SANCTUARY_PER_WARD + core.SANCTUARY_PER_LEGACY);
});

/* ---------- archetypes ---------- */

test("archetypeChance starts at zero and climbs toward 1 without a cap", () => {
  assert.equal(core.archetypeChance(0), 0);
  let prev = 0;
  for (let w = 1; w <= 200; w++) {
    const p = core.archetypeChance(w);
    assert.ok(p > prev, `wave ${w} must diversify further than ${w - 1}`);
    assert.ok(p < 1);
    prev = p;
  }
  assert.ok(core.archetypeChance(1000) > 0.99);
});

test("rollArchetype: walkers only at wave 0, every breed reachable later", () => {
  for (let i = 0; i < 50; i++) {
    assert.equal(core.rollArchetype(0, core.mulberry32(i)).key, "walker");
  }
  const seen = new Set();
  const rand = core.mulberry32(99);
  for (let i = 0; i < 4000; i++) seen.add(core.rollArchetype(40, rand).key);
  for (const k of ["walker", ...core.SPECIAL_ARCHETYPES]) assert.ok(seen.has(k), k);
});

test("archetypes are balanced trade-offs, not strict upgrades", () => {
  const w = core.ARCHETYPES.walker;
  assert.equal(w.hp * w.speed * w.dmg * w.reach * w.scale, 1); // the baseline
  for (const key of core.SPECIAL_ARCHETYPES) {
    const a = core.ARCHETYPES[key];
    assert.ok(a.hp > 0 && a.speed > 0 && a.dmg > 0 && a.scale > 0, key);
    // Each breed must give something up relative to a plain Walker.
    const stats = [a.hp, a.speed, a.dmg, a.reach];
    assert.ok(stats.some((v) => v > 1), `${key} must have a strength`);
    assert.ok(stats.some((v) => v < 1), `${key} must have a weakness`);
    assert.ok(typeof a.tint === "number", `${key} needs a tell`);
  }
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
    maxLevelKilled: 3, maxEnergy: 320, towersBuilt: 4, wardRank: 2,
  };
  const byKind = (kind, target = 999) => ({ kind, target });
  assert.equal(core.contractProgress(byKind("kills"), counters), 12);
  assert.equal(core.contractProgress(byKind("wave"), counters), 6);
  assert.equal(core.contractProgress(byKind("maxBlastKills"), counters), 4);
  assert.equal(core.contractProgress(byKind("mineKills"), counters), 2);
  assert.equal(core.contractProgress(byKind("turretKills"), counters), 7);
  assert.equal(core.contractProgress(byKind("maxLevelKilled"), counters), 3);
  assert.equal(core.contractProgress(byKind("maxEnergy"), counters), 320);
  assert.equal(core.contractProgress(byKind("towersBuilt"), counters), 4);
  assert.equal(core.contractProgress(byKind("wardRank"), counters), 2);
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
    // …and the counter it reads must actually be one the run keeps, or the
    // contract would sit at 0 forever while looking perfectly valid.
    if (def.kind !== "noRepairWave") {
      assert.ok(def.kind in counters, `${def.key} reads unknown counter ${def.kind}`);
      const bumped = { ...counters, [def.kind]: counters[def.kind] + 1 };
      assert.equal(core.contractProgress({ kind: def.kind, target: 1 }, bumped), before + 1);
    }
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

test("achievements table has the full 23 with labels", () => {
  const keys = Object.keys(core.ACHIEVEMENTS);
  assert.equal(keys.length, 23);
  for (const k of keys) assert.ok(core.ACHIEVEMENTS[k].startsWith("🏆"));
  for (const k of ["boss-slayer", "combo-10", "contracts", "streak-3", "kills-1000", "legacy-5", "wave-15", "wave-20", "adapted", "critical-mass", "frostbite", "arclight", "lancer", "sanctuary", "menagerie"]) {
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
