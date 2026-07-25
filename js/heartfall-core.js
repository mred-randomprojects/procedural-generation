// Heartfall core — every balance curve, progression cost, and game-rule
// computation, extracted into one dependency-free ES module. No THREE, no
// DOM, no timers: everything here is a pure function of its inputs, which is
// what lets the Node test suite (tests/heartfall-core.test.mjs) pin the
// game's math down without a browser. voxel-gen.js imports from here and
// supplies the live state (slider values, legacy ranks, clocks) at call time.
//
// GUIDING PRINCIPLE — no artificial limits. Curves here escalate forever by
// design (blast costs, combo multipliers, boss levels): do not add caps
// without explicit user direction. The one user-directed pressure valve is
// CONDENSATION (see CONDENSE_THRESHOLD below): a level's population fuses
// into half as many next-level zombies once it reaches the threshold —
// strength is conserved and keeps escalating, only the entity count is tamed.

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

// A 🔧 Repair restores a FRACTION of the Heart's maximum, not a flat 30 —
// so Reinforced Heart ranks make every future repair bigger too, and the
// perk compounds instead of being outscaled by the escalating repair price.
export const REPAIR_FRACTION = 0.3;
export function repairAmount(maxHp) {
  return Math.max(1, Math.round(maxHp * REPAIR_FRACTION));
}

/* ---------- blast upgrade progression ---------- */
// XP thresholds no longer auto-grow the radius — each one banks an upgrade
// POINT, and the player chooses what it buys: +1 blast radius or +1 blast
// damage. The old quadratic cost curve let a long run snowball to radius
// 324; the gap between upgrades now grows geometrically instead, so deep
// runs still earn upgrades forever (no ceiling) but each one is a real event.

export const STARTING_MAX_BLAST = 3;
export const STARTING_BLAST_DAMAGE = 1;
// Cumulative XP for the first upgrade choices (the old radius 4–8 table).
export const UPGRADE_XP = [40, 100, 200, 350, 550];
// Past the table, each successive XP gap is ×1.7 the previous one.
export const UPGRADE_GAP_GROWTH = 1.7;

// Cumulative XP needed to bank the nth upgrade point (n is 1-based).
export function upgradeUnlockCost(n) {
  if (n <= UPGRADE_XP.length) return UPGRADE_XP[n - 1];
  let cost = UPGRADE_XP[UPGRADE_XP.length - 1];
  let gap = UPGRADE_XP[UPGRADE_XP.length - 1] - UPGRADE_XP[UPGRADE_XP.length - 2];
  for (let i = UPGRADE_XP.length; i < n; i++) {
    gap = Math.round(gap * UPGRADE_GAP_GROWTH);
    cost += gap;
  }
  return cost;
}

/* ---------- blast damage ---------- */
// One blast hits every zombie inside the radius for 1 point — 2 inside the
// inner core (half the radius) — times the player's blast damage stat. The
// target's tech armor (techDamageMultiplier) is applied on top of this by
// the caller, as it is for every other player weapon.
export function blastZombieDamage(withinCore, blastDamage = 1) {
  return (withinCore ? 2 : 1) * blastDamage;
}

// Terrain hit-points dealt to the column at distance d from the center of a
// radius-R blast, scaled by blast damage — higher damage punches through
// more strata per shot, so craters get visibly deeper as damage ranks up
// (see stratumForDepth for the resistance ladder it chews through).
export function craterBlockDamage(d, R, blastDamage = 1) {
  if (d > R) return 0;
  const base = Math.max(1, Math.round((R - d) * 0.85 + 1));
  return (d <= Math.floor(R / 2) ? base * 2 : base) * blastDamage;
}

/* ---------- zombie stat curves ---------- */
// The per-level slopes (hpPerLevel etc.) are live Tweaks-slider values in
// the game, so they're arguments here, defaulting to canonical balance.

export function maxHpFor(level, hpPerLevel = 1) { return 1 + (level - 1) * hpPerLevel; }
export function dpsFor(level, dmgPerLevel = 1) { return 1 + (level - 1) * dmgPerLevel; }

/* ---------- armor: logarithmic damage reduction ---------- */
// Armor used to be FLAT subtraction (a level-X zombie shrugged off X-2 DPS),
// which had a hard failure mode: any attacker whose DPS didn't clear the
// threshold dealt literally nothing, so runts couldn't scratch an elite at
// all and the horde's own evolution stalled behind an invulnerability wall.
//
// It's now a multiplier that decays logarithmically — steep at first, then
// ever shallower, and asymptotically approaching (but never reaching) zero.
// A level-1000 monster still takes damage from a level-1 runt; it just takes
// a very long time. Player tech has its OWN, gentler curve — see
// techDamageMultiplier below.
// 0.5 keeps mid-level elites roughly as tanky as the old flat rule made
// them (a level 10 sheds ~53% instead of ~80%) while removing the wall:
// equal-level fights now resolve in seconds rather than grinding.
export const ARMOR_K = 0.5;

// Share of incoming damage that actually lands, in (0, 1].
export function damageTakenMultiplier(level) {
  return 1 / (1 + ARMOR_K * Math.log(Math.max(1, level)));
}

// The same number as a percentage reduction, for HUD readouts. 0 at level 1.
export function armorReduction(level) {
  return 1 - damageTakenMultiplier(level);
}

// Player tech — blasts, turret bolts, arcs, lances, frost, mines — used to
// ignore armor completely, which meant a monster's level bought it nothing
// against the things actually trying to kill it: a level-203 zombie has 203
// HP and died to a 28.5-damage bolt in 8 shots, exactly like a level-20 one
// would relative to its own pool.
//
// Tech now gets its own, deliberately GENTLER curve. Same shape (log decay,
// asymptotic to zero, never reaching it) so towers never become ornaments.
//
// The PIVOT is what keeps this off the early game's back: dividing by 20
// before the log means the curve is nearly flat through the levels a player
// meets in the first minutes (a level-5 zombie shrugs off 10%, a level-10
// one 17%) and only bites once the horde is deep into triple digits. Tuned
// so a level-203 target takes ~0.45 of each hit — ~16 bolts from a
// 28.5-damage turret instead of ~8, which is the ask that produced it.
export const TECH_ARMOR_K = 0.5;
export const TECH_ARMOR_PIVOT = 20;

// Anchored on (level - 1), so level 1 is EXACTLY 1.0 rather than 0.976.
// That precision matters more than it looks: a level-1 zombie has exactly
// 1 HP and the weakest blast deals exactly 1 damage, so a multiplier a hair
// under 1 would leave every runt alive on 0.02 HP.
export function techDamageMultiplier(level) {
  return 1 / (1 + TECH_ARMOR_K * Math.log1p(Math.max(0, level - 1) / TECH_ARMOR_PIVOT));
}

// Damage one armor-ignoring-in-name-only player hit actually deals.
export function effectiveTechDamage(damage, targetLevel) {
  return damage * techDamageMultiplier(targetLevel);
}

// Linear, uncapped: x1 at level 1, +speedPerLevel per level after.
export function stackSpeed(level, speedPerLevel = 0.3) { return 1 + (level - 1) * speedPerLevel; }

// The raw size ladder — still linear and still uncapped. Nothing renders
// this directly any more; evolutionOf() folds it into a form + a drawn size.
export function stackScale(level) { return 1 + (level - 1) * 0.3; }

/* ---------- evolution forms: size wraps, power doesn't ---------- */
// USER-DIRECTED: a zombie's DRAWN size is capped at ×5. The stat ladder
// above keeps climbing forever, but the moment the raw scale would exceed
// the cap the creature METAMORPHOSES — it re-forms into the next, scarier
// body plan at a smaller drawn size and starts growing again. So the
// silhouette stays legible on screen while strength escalates without end;
// what tells you a monster is terrifying is now its FORM, not its bulk.
//
// Each wrap re-bases the drawn scale from the cap down to EVOLUTION_TIER_FLOOR
// (higher forms are born chunkier than a fresh walker, so a metamorphosis
// reads as a change of kind rather than a demotion). Because the re-basing
// is a constant ratio, each form lasts ~2.8× longer in raw-scale terms than
// the one before: tier 1 near level 15, tier 2 near 44, tier 3 near 126…

export const EVOLUTION_SCALE_CAP = 5;
export const EVOLUTION_TIER_FLOOR = 1.8;

// Body plans. Beyond the last entry the form repeats — but `tier` keeps
// counting, and the renderer escalates its glow with it, so there is no
// point at which a monster stops looking more dangerous.
export const EVOLUTION_FORMS = [
  { tier: 0, key: "walker", icon: "🧟", name: "Walker", desc: "The baseline shambler" },
  { tier: 1, key: "revenant", icon: "👹", name: "Revenant", desc: "Horned, hunched, eyes lit from within" },
  { tier: 2, key: "colossus", icon: "💀", name: "Colossus", desc: "Plated shoulders and a crown of spines" },
  { tier: 3, key: "abomination", icon: "🕷️", name: "Abomination", desc: "Four arms around a burning core" },
];

// { tier, scale } for a stack level: `tier` selects the body plan, `scale`
// is what actually gets drawn and always lands in [1, EVOLUTION_SCALE_CAP).
export function evolutionOf(level) {
  let scale = stackScale(level);
  let tier = 0;
  while (scale >= EVOLUTION_SCALE_CAP) {
    scale = EVOLUTION_TIER_FLOOR * (scale / EVOLUTION_SCALE_CAP);
    tier++;
  }
  return { tier, scale };
}

export function evolutionTier(level) { return evolutionOf(level).tier; }
export function displayScale(level) { return evolutionOf(level).scale; }

// The body plan drawn for a tier — clamped to the last authored form, while
// the tier number itself keeps rising (see the note above).
export function evolutionForm(tier) {
  return EVOLUTION_FORMS[Math.min(tier, EVOLUTION_FORMS.length - 1)];
}

// Odd numbers: 1, 3, 5, 7… — eats required to advance from `level`.
export function eatsNeededForLevel(level) { return 2 * level - 1; }

// Attack cadence: higher levels shoot faster; damage per shot is scaled by
// the interval so true DPS is exactly dpsFor(level) at any cadence.
export function attackInterval(level, atkPerLevel = 0.25) { return 1.0 / (1 + atkPerLevel * (level - 1)); }

// Damage one projectile deals after the target's armor. Strictly positive
// for any positive dps — nothing in the horde is ever fully immune.
export function effectiveHitDamage(dps, interval, targetLevel) {
  return Math.max(0, dps * interval * damageTakenMultiplier(targetLevel));
}

/* ---------- zombie archetypes: breeds within the horde ---------- */
// Every level curve above is shared by the whole horde; an archetype is a
// multiplier set layered on top, rolled once when a zombie spawns and kept
// for life (a Runner that eats its way to level 9 is a level 9 Runner).
// They exist so a wave reads as a mixed force rather than N copies of one
// stat block: Runners rush the line, Brutes soak it, Spitters siege the
// Heart from outside a bolt turret's comfortable range.
//
// `scale` is body size (visual + hp-bar height only — it deliberately does
// NOT change blast footprints, so aiming stays honest). `tint` multiplies
// the zombie's skin texture so each breed is identifiable at a glance.

export const ARCHETYPES = {
  walker: { key: "walker", icon: "🧟", name: "Walker", hp: 1, speed: 1, dmg: 1, reach: 1, scale: 1, tint: null },
  runner: { key: "runner", icon: "🏃", name: "Runner", hp: 0.6, speed: 1.7, dmg: 0.8, reach: 1, scale: 0.85, tint: 0xff8a66 },
  brute: { key: "brute", icon: "🪨", name: "Brute", hp: 2.6, speed: 0.6, dmg: 1.3, reach: 1, scale: 1.35, tint: 0x8fa2bb },
  spitter: { key: "spitter", icon: "🧪", name: "Spitter", hp: 0.8, speed: 0.9, dmg: 1.4, reach: 2.2, scale: 0.95, tint: 0xb6ff5a },
};

// Breeds other than the plain Walker. Boss spawns never roll one — a boss is
// already its own stat block.
export const SPECIAL_ARCHETYPES = ["runner", "brute", "spitter"];

// Odds that a given spawn is a special breed. Zero at wave 0 (the opening
// minute is plain walkers, so the breeds read as an escalation when they
// arrive) and asymptotic to 1 — no cap, the horde just keeps diversifying.
export function archetypeChance(waveNumber) {
  const w = Math.max(0, waveNumber);
  return w / (w + 9);
}

export function rollArchetype(waveNumber, rand = Math.random) {
  if (rand() >= archetypeChance(waveNumber)) return ARCHETYPES.walker;
  return ARCHETYPES[SPECIAL_ARCHETYPES[Math.floor(rand() * SPECIAL_ARCHETYPES.length)]];
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

/* ---------- horde mutations: timed run-long escalations ---------- */
// Every so often the whole horde permanently mutates — announced loudly, so
// the run's difficulty visibly ratchets up over time no matter how wide the
// player's blasts get. Mutations stack forever (no cap, by design); the
// numeric effects live in voxel-gen's `mut` state, keyed by `key`.

export const MUTATION_POOL = [
  { key: "hide", icon: "🦏", name: "Thick Hide", desc: "Zombies gain +25% max HP" },
  { key: "venom", icon: "🐍", name: "Venom Glands", desc: "Zombie attacks deal +25% damage" },
  { key: "surge", icon: "💨", name: "Adrenal Surge", desc: "Zombies move +15% faster" },
  { key: "regen", icon: "♻️", name: "Regeneration", desc: "Zombies knit back together (+0.5 HP/s)" },
  { key: "arms", icon: "🦑", name: "Long Arms", desc: "Zombies besiege the Heart from +35% farther" },
  { key: "volatile", icon: "☣️", name: "Volatile", desc: "Zombies destroyed near the Heart burst and harm it" },
  { key: "bloom", icon: "🍄", name: "Corpse Bloom", desc: "Every devoured zombie lures +0.5 more to the field" },
];

// Seconds of sim time until the mutation AFTER `index` strikes: the first
// lands at 80s, then the pace tightens by 5s per mutation down to a 45s
// floor. waveMul is the difficulty's wave multiplier (easy mutates slower).
export function mutationDelay(index, waveMul = 1) {
  return Math.max(45, 80 - index * 5) * waveMul;
}

// Which mutation strikes at position `index` — seeded, so a daily's mutation
// sequence is identical for everyone playing that day's board.
export function mutationAtIndex(seedStr, index) {
  const rand = mulberry32(hashSeed(`${seedStr}:mutation:${index}`));
  return MUTATION_POOL[Math.floor(rand() * MUTATION_POOL.length)];
}

/* ---------- condensation: population converts into strength ---------- */
// USER-DIRECTED design (an explicit revision of the "no limits" principle,
// for performance): the total population is still never capped, but when any
// single stack level accumulates CONDENSE_THRESHOLD (100) living zombies,
// that whole cohort fuses — every one of them is removed and half as many spawn
// at the NEXT level up, in their places. Quantity becomes quality: entity
// counts stay renderable while the horde's strength keeps climbing.

// Lowered 500 → 200 → 100 at the user's direction: fusing sooner means the
// horde converts into strength faster and the frame budget never sees a
// four-figure crowd of one level.
export const CONDENSE_THRESHOLD = 100;

// How many level-(N+1) zombies a fusing cohort of `count` produces.
export function condenseSurvivors(count) {
  return Math.floor(count / 2);
}

// After a level-X cohort fuses, X+1 is the run's new minimum spawn level:
// fresh (non-boss) spawns enter at least this strong. The ratchet only
// climbs — a lower-level fusion never lowers an already-raised floor.
export function condenseFloor(currentFloor, fusedLevel) {
  return Math.max(currentFloor, fusedLevel + 1);
}

/* ---------- economy & scoring ---------- */

// Compact HUD readout for run-away numbers: 2321075 → "~2.3M". Values
// under 10k stay exact (still readable at a glance); the "~" appears only
// when rounding actually hid digits, so 2.5M / 45k render without it.
export function fmtNum(n) {
  if (!Number.isFinite(n)) return String(n);
  const neg = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a < 10000) return neg + String(a);
  const tiers = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];
  let i = tiers.findIndex(([div]) => a >= div);
  const v = a / tiers[i][0];
  let shown = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  if (shown >= 1000 && i > 0) { i--; shown /= 1000; } // 999950 → "1M", never "1000k"
  // Tolerance beats === here: 45.3 * 1000 is 45299.999…, and that float
  // dust must not stamp a "~" on a value that reads exactly.
  const exact = Math.abs(shown * tiers[i][0] - a) < 0.5;
  return `${exact ? "" : "~"}${neg}${shown}${tiers[i][1]}`;
}

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
  { key: "damageRank", icon: "⚔️", name: "Heavy Ordnance", desc: "+1 starting blast damage" },
  { key: "turretRank", icon: "🎯", name: "Overcharged Turrets", desc: "+0.5 turret damage" },
  { key: "mineRank", icon: "💣", name: "Minefield", desc: "Start each run with 2 buried mines" },
  { key: "rateRank", icon: "⏩", name: "Rapid Coils", desc: "Towers fire 25% faster" },
  { key: "boltRank", icon: "🚀", name: "Hypervelocity", desc: "Tower bolts fly 25% faster" },
  { key: "groundRank", icon: "🕯️", name: "Consecrated Ground", desc: "+2 starting Sanctuary radius" },
  { key: "comboRank", icon: "🔥", name: "Killing Spree", desc: "+0.5s to the combo window" },
  { key: "shardRank", icon: "🔮", name: "Shard Magnet", desc: "+15% shards earned" },
];

// `ranks` pools Legacy Overcharged Turrets ranks with in-run ⭐ upgrade
// picks — both are worth the same +0.5, so they share one scale.
export function turretDamage(ranks) { return 1 + 0.5 * ranks; }
// Targeting radius in blocks; each in-run 📡 pick extends it.
export function turretRange(rangeUps = 0) { return 8 + 2 * rangeUps; }
export function freeMines(mineRank) { return 2 * mineRank; }
export function legacyTotalRanks(legacy) {
  return LEGACY_PERKS.reduce((sum, p) => sum + (legacy[p.key] || 0), 0);
}

/* ---------- tower fire rate ---------- */
// Seconds between shots. `ranks` pools Legacy Rapid Coils with in-run ⏩
// picks (same +25% fire rate each), so cadence keeps improving forever —
// the interval shrinks hyperbolically toward, but never reaches, zero.
export const TOWER_BASE_COOLDOWN = 0.8;
export function towerCooldown(ranks = 0) {
  return TOWER_BASE_COOLDOWN / (1 + 0.25 * ranks);
}

/* ---------- tower types ---------- */
// Three buildable towers, each answering a different failure mode: bolt
// turrets for steady single-target damage, frost towers for crowd control
// once the horde arrives faster than it can be shot, arc towers for the
// packed late-run swarms where one bolt per second is wasted on one body.
// All three share the same damage/range/rate upgrade tracks; the per-type
// factors below are what make them feel distinct.

export const ARC_CHAIN = 3;         // bodies one arc shot jumps through
export const ARC_JUMP = 5;          // max blocks between two links of a fork
// Tuned so a full 3-body fork out-damages a bolt turret per second (1.5 vs
// 1.25 at rank 0) while a lone straggler is less than half as good — the arc
// tower must be a genuine choice, not a strict upgrade or a strict downgrade.
export const ARC_DAMAGE_FACTOR = 0.6;  // per body — less per hit, more total
export const ARC_COOLDOWN_FACTOR = 1.5; // …but it winds up half again as slowly
export const FROST_SLOW = 0.45;     // speed multiplier inside a frost aura
export const FROST_TICK = 1;        // seconds between chill damage ticks
export const FROST_DAMAGE_FACTOR = 0.5; // chill damage per tick, per body
export const LANCE_WIDTH = 0.9;     // blocks either side of the beam that get hit
// Nearly a bolt turret's damage per body, at a third of the cadence: four
// zombies lined up is the break-even point, and everything past that is
// pure profit (the pierce itself is unbounded).
export const LANCE_DAMAGE_FACTOR = 0.9; // per body — the pierce is the payoff
export const LANCE_COOLDOWN_FACTOR = 3; // …paid for with a long, visible wind-up

export const TOWER_TYPES = [
  { key: "bolt", icon: "🗼", name: "Bolt Turret", shop: "turret", desc: "Snipes the nearest zombie" },
  { key: "frost", icon: "❄️", name: "Frost Tower", shop: "frost", desc: "Chills and slows every zombie in its aura" },
  { key: "arc", icon: "⚡", name: "Arc Tower", shop: "arc", desc: "One shot forks through 3 bodies" },
  { key: "lance", icon: "🔱", name: "Lance Tower", shop: "lance", desc: "Beam pierces every zombie in a line" },
];

// Arc towers trade per-body damage and cadence for hitting a whole clump.
export function arcDamage(ranks) { return turretDamage(ranks) * ARC_DAMAGE_FACTOR; }
export function arcCooldown(ranks = 0) { return towerCooldown(ranks) * ARC_COOLDOWN_FACTOR; }
// Frost auras are tighter than a bolt turret's targeting radius (they're a
// zone you must walk into, not a sniper's reach) but grow with 📡 picks too.
export function frostRadius(rangeUps = 0) { return 5 + 1.5 * rangeUps; }
export function frostTickDamage(ranks) { return turretDamage(ranks) * FROST_DAMAGE_FACTOR; }
// Lance towers pierce an UNBOUNDED number of bodies — the line is the whole
// point, so nothing caps it. The nerf is positional and temporal instead:
// the beam only hits what happens to be lined up, and the tower spends three
// bolt-turret cooldowns winding the shot up.
export function lanceDamage(ranks) { return turretDamage(ranks) * LANCE_DAMAGE_FACTOR; }
export function lanceCooldown(ranks = 0) { return towerCooldown(ranks) * LANCE_COOLDOWN_FACTOR; }

/* ---------- zombie projectile speed ---------- */
// A zombie's bile shot flies faster the stronger it is: a high-level
// attacker's fire should feel like fire, not like a lobbed balloon you can
// walk out of. Linear and uncapped, like the rest of the horde's curves.
export const ZOMBIE_BOLT_BASE_SPEED = 40;
export function zombieBoltSpeed(level) {
  return ZOMBIE_BOLT_BASE_SPEED * (1 + 0.08 * Math.max(0, level - 1));
}

/* ---------- bolt travel speed ---------- */
// Blocks per second a tower projectile flies. Slow bolts miss fast movers
// (a Runner can outpace the shot that was aimed at it), so 🚀 picks and the
// Hypervelocity legacy perk are worth real money on a Runner-heavy board.
export const BOLT_BASE_SPEED = 30;
export function boltSpeed(ranks = 0) { return BOLT_BASE_SPEED * (1 + 0.25 * ranks); }

/* ---------- the Sanctuary: consecrated ground around the Heart ---------- */
// Fresh zombies never materialize on top of the Heart: every random spawn
// is pushed outside this radius. The 🛡️ Ward shop item consecrates more
// ground each purchase, so a rich player can buy breathing room — the horde
// then has to WALK in from further out, which is exactly the time a turret
// line needs. Wave invaders already arrive from the map rim, so this only
// ever moves the trickle/replacement spawns.
export const SANCTUARY_BASE = 9;
export const SANCTUARY_PER_WARD = 4;
export const SANCTUARY_PER_LEGACY = 2; // Consecrated Ground: banked between runs
export function sanctuaryRadius(wardRank = 0, groundRank = 0) {
  return SANCTUARY_BASE + SANCTUARY_PER_WARD * wardRank + SANCTUARY_PER_LEGACY * groundRank;
}

// Shop pricing: base cost + per-purchase growth so the run stays a squeeze.
export const SHOP = {
  repair: { base: 50, growth: 1.5 },
  turret: { base: 120, growth: 1.6 },
  frost: { base: 200, growth: 1.6 },
  arc: { base: 260, growth: 1.7 },
  lance: { base: 320, growth: 1.7 },
  mine: { base: 40, growth: 1.3 },
  slow: { base: 80, growth: 1.5 },
  ward: { base: 150, growth: 1.8 },
};
export function nextShopCost(currentCost, item) {
  return Math.round(currentCost * SHOP[item].growth);
}

/* ---------- kill combos ---------- */
// Chained kills inside a rolling window build a combo; the combo multiplies
// every kill's XP/energy payout. Uncapped — a monster streak SHOULD pay
// monstrously. State is a plain {count, expiresAt} record.

export const COMBO_WINDOW = 4; // seconds a combo stays alive after each kill

// Killing Spree legacy ranks buy breathing room between kills — the whole
// combo economy (payout multiplier, the ×10 achievement) opens up with it.
export function comboWindow(comboRank = 0) { return COMBO_WINDOW + 0.5 * comboRank; }

export function comboMultiplier(count) {
  return count <= 1 ? 1 : 1 + (count - 1) * 0.15;
}

export function applyCombo(state, kills, now, window = COMBO_WINDOW) {
  const count = now > state.expiresAt ? kills : state.count + kills;
  return { count, expiresAt: now + window };
}

/* ---------- canonical ranked balance for the Tweaks sliders ---------- */
// resetTweaksToDefaults snaps every slider to these at the start of every
// scored (ranked/daily) run. spawnsPerKill 1.1 means every kill replaces
// itself plus a 10% chance of one bonus runt (see spawnsForKills) — a
// whisper of growth so the map never thins out, without the self-feeding
// snowball that 2.0 was (that's a sandbox toy, not ranked balance).
export const CANONICAL_TWEAKS = {
  spawnsPerKill: 1.1,
  spawnsPerEat: 1,
  spawnDelay: 0,
  speedPerLevel: 0.3,
  simSpeed: 1,
  hpPerLevel: 1,
  dmgPerLevel: 1,
  atkPerLevel: 0.25,
};

/* ---------- the escalating spawn rate ---------- */
// USER-DIRECTED: every 25 levels the horde reaches, each zombie you kill
// spawns +0.1 more in its place — 1.1 → 1.2 → 1.3 → … with no ceiling. So a
// run that lets the horde evolve pays for it twice: the survivors are
// stronger AND they come back thicker. The anchor is the run's PEAK zombie
// level (the strongest thing that has existed this run), which rises through
// both eating and condensation, and never falls when that monster dies.

export const SPAWN_RATE_LEVEL_STEP = 25;
export const SPAWN_RATE_STEP = 0.1;

// How many whole 25-level thresholds the run has crossed.
export function spawnRateTier(peakLevel) {
  return Math.floor(Math.max(0, peakLevel) / SPAWN_RATE_LEVEL_STEP);
}

export function spawnRateBonus(peakLevel) {
  return SPAWN_RATE_STEP * spawnRateTier(peakLevel);
}

// The rate actually used for player kills. Rounded off float dust so the HUD
// never reads "×1.4000000000000001".
export function effectiveSpawnsPerKill(baseRate, peakLevel) {
  return Math.round((baseRate + spawnRateBonus(peakLevel)) * 1e6) / 1e6;
}

// The peak level at which the rate next steps up — drives the HUD's
// "next: ×1.4 at Lv 75" readout.
export function nextSpawnRateLevel(peakLevel) {
  return (spawnRateTier(peakLevel) + 1) * SPAWN_RATE_LEVEL_STEP;
}

// Fractional spawn rates, resolved stochastically: `kills` kills at `rate`
// spawn floor(kills*rate) guaranteed, +1 more with probability equal to the
// leftover fraction. Expected value is exactly kills*rate, and any 10 kills
// at 1.1 yield exactly 11 (the fraction only ever rolls once per call).
export function spawnsForKills(kills, rate, rand = Math.random) {
  // Nano-epsilon rounding so float noise (10 × 1.1 = 11.000000000000002)
  // never manufactures a phantom fraction to roll on.
  const expected = Math.round(kills * rate * 1e9) / 1e9;
  const guaranteed = Math.floor(expected);
  const frac = expected - guaranteed;
  return guaranteed + (frac > 0 && rand() < frac ? 1 : 0);
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
  { key: "no-repair", icon: "🩹", kind: "noRepairWave", tiers: [4, 6], label: (n) => `Reach wave ${n} before your first repair` },
  { key: "build-towers", icon: "🏗️", kind: "towersBuilt", tiers: [3, 5], label: (n) => `Raise ${n} towers` },
  { key: "consecrate", icon: "🛡️", kind: "wardRank", tiers: [1, 2], label: (n) => `Extend the Sanctuary ${n}×` },
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
    towersBuilt: 0, wardRank: 0,
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
    case "towersBuilt": return counters.towersBuilt;
    case "wardRank": return counters.wardRank;
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
  "adapted": "🏆 Adapted — endure 5 horde mutations in one run",
  "critical-mass": "🏆 Critical Mass — witness 100 zombies condense into a stronger horde",
  "frostbite": "🏆 Frostbite — raise a Frost Tower",
  "arclight": "🏆 Arclight — raise an Arc Tower",
  "lancer": "🏆 Lancer — raise a Lance Tower",
  "sanctuary": "🏆 Consecrated — extend the Sanctuary 3 times in one run",
  "menagerie": "🏆 Menagerie — face a Runner, a Brute and a Spitter in one run",
};

/* ---------- persisted-state sanitizers ---------- */
// localStorage payloads are user-editable and versions drift; every load
// goes through one of these so the game only ever sees a well-formed shape.

function nonNegNumber(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function sanitizeLegacy(raw) {
  const legacy = {
    heartRank: 0, energyRank: 0, blastRank: 0, damageRank: 0, turretRank: 0,
    rateRank: 0, boltRank: 0, groundRank: 0, comboRank: 0, mineRank: 0,
    shardRank: 0, shards: 0,
  };
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
