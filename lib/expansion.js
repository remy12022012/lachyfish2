'use strict';
// Expansion tables shared by the server and mirrored in public/index.html (keep both in sync; test/api.test.js checks this).
// Global events are a pure function of server time: the clock is cut into fixed slots and a hash of the slot number decides whether an
// event runs in it, which one, and when it starts. Every player computes the same schedule, so nothing is stored and nothing can drift.

const SLOT_MS = 30 * 60 * 1000; // one possible event per slot
const EVENT_CHANCE = 0.6; // chance that a slot holds an event
const MIN = 60 * 1000;

// luck: rarity luck multiplier, cash: sell/income multiplier, mut: mutation chance multiplier, chest: treasure chest frequency multiplier.
// dur must stay below SLOT_MS. Two slots in a row never hold the same event, which gives each event type a cooldown of at least one slot.
const EVENTS = [
  { id: 'bloodmoon', n: 'Blood Moon', dur: 8 * MIN, luck: 2, cash: 1, mut: 1.5, chest: 1, col: '#ff3b3b', d: 'Rarer catches under a red moon' },
  { id: 'goldentide', n: 'Golden Tide', dur: 8 * MIN, luck: 1, cash: 2, mut: 1, chest: 1, col: '#ffd23f', d: 'Everything sells for double' },
  { id: 'voidstorm', n: 'Void Storm', dur: 6 * MIN, luck: 1.5, cash: 1, mut: 2, chest: 1, col: '#9b5cff', d: 'Void-only catches rise from the deep' },
  { id: 'luckyhour', n: 'Lucky Hour', dur: 10 * MIN, luck: 2.5, cash: 1, mut: 1, chest: 1, col: '#5cf27a', d: 'A big luck bonus for everyone' },
  { id: 'treasurerain', n: 'Treasure Rain', dur: 7 * MIN, luck: 1, cash: 1, mut: 1, chest: 3, col: '#ffb347', d: 'Treasure chests pour from the sky' },
];

// 32-bit integer hash (murmur3 finaliser): deterministic and identical in Node and the browser.
function h32(n) {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

const runs = (s) => h32(s * 7 + 2) % 100 < EVENT_CHANCE * 100;
const typeOf = (s) => h32(s * 3 + 1) % EVENTS.length;

// The event scheduled in slot s, or null: { ev, start, end } in ms since the epoch.
function slotEvent(s) {
  if (!runs(s)) return null;
  const t = typeOf(s);
  if (runs(s - 1) && typeOf(s - 1) === t) return null; // cooldown: never the same event twice in a row
  const ev = EVENTS[t];
  const off = h32(s * 11 + 3) % (SLOT_MS - ev.dur + 1);
  const start = s * SLOT_MS + off;
  return { ev, start, end: start + ev.dur };
}

// The event running at time `now` (ms), or null.
function activeEvent(now) {
  const e = slotEvent(Math.floor(now / SLOT_MS));
  return e && now >= e.start && now < e.end ? { id: e.ev.id, start: e.start, end: e.end } : null;
}

// The next event that starts after `now`, or null if none in the next few hours.
function nextEvent(now) {
  const s0 = Math.floor(now / SLOT_MS);
  for (let s = s0; s < s0 + 12; s++) {
    const e = slotEvent(s);
    if (e && e.start > now) return { id: e.ev.id, start: e.start, end: e.end };
  }
  return null;
}

// ---- rods, locations, mastery ----
// luck multiplies the rarity luck roll (rarity gating by ascension stays as it is); cash multiplies sell value and income.
// Rod evolution: each owned rod can evolve EVO_MAX times by spending materials. Every tier adds EVO_CASH cash and EVO_LUCK luck on top of the rod, plus its special ability (ab):
// ab.k is 'mut' (mutation chance) or 'chest' (chest chance), and the bonus is 1 + ab.v * tier.
const EVO_MAX = 3;
const EVO_CASH = 0.1;
const EVO_LUCK = 0.05;
const MAT_MAX = 9999; // most of one material a save may hold
const MATERIALS = [
  { id: 'scale', n: 'Fish Scale', i: '&#128031;', col: '#9fd8ff' },
  { id: 'pearl', n: 'Pearl', i: '&#9898;', col: '#ffe6f7' },
  { id: 'shard', n: 'Void Shard', i: '&#128142;', col: '#a24bff' },
];
const MAT_IDS = MATERIALS.map((m) => m.id);
// Materials (scale, pearl, shard) needed for tier t (1..EVO_MAX) of rod i: later rods need rarer materials.
const evoCost = (i, t) => [20 * (i + 1) * t, i >= 1 ? 4 * i * t : 0, i >= 3 ? 2 * (i - 2) * t : 0];
const RODS = [
  { id: 'wooden', n: 'Wooden Rod', cost: 0, luck: 1, cash: 1, ab: { k: 'chest', v: 0.1, n: 'Treasure Sense', d: '+10% chest chance per evolution' } },
  { id: 'golden', n: 'Golden Rod', cost: 5e4, luck: 1.1, cash: 1.05, ab: { k: 'mut', v: 0.08, n: 'Gilded Touch', d: '+8% mutation chance per evolution' } },
  { id: 'crystal', n: 'Crystal Rod', cost: 5e6, luck: 1.25, cash: 1.1, ab: { k: 'chest', v: 0.15, n: 'Clear Sight', d: '+15% chest chance per evolution' } },
  { id: 'void', n: 'Void Rod', cost: 5e8, luck: 1.45, cash: 1.2, ab: { k: 'mut', v: 0.15, n: 'Void Pull', d: '+15% mutation chance per evolution' } },
  { id: 'celestial', n: 'Celestial Rod', cost: 5e10, luck: 1.7, cash: 1.3, ab: { k: 'chest', v: 0.2, n: 'Starfall', d: '+20% chest chance per evolution' } },
  { id: 'prismatic', n: 'Prismatic Rod', cost: 5e12, luck: 2, cash: 1.5, ab: { k: 'mut', v: 0.25, n: 'Spectrum', d: '+25% mutation chance per evolution' } },
];
RODS.forEach((r, i) => { r.evo = [1, 2, 3].map((t) => evoCost(i, t)); });
// asc: ascensions needed before the location can be bought; cost in coins.
// Extra fields per location:
//   rb: rarity weight multipliers for [Common-Rare (0-2), Epic-Mythic (3-5), Divine and above (6+)] applied on top of the normal roll.
//   exc: three exclusive catches; each catch at the location has an EXC_CHANCE chance to be one of them (picked by weight p) and pays v x a tenth of the sell value of its rarity (capped at Mythic), ten times that the first time.
//   lv / mast: milestone to unlock (fishing level, and mastery level [loc index, level] at an earlier location). Checked in the client when buying.
//   vis: sky (3 stops) and sea (4 stops) colours, plus the ambient effect kind the scene draws.
const EXC_CHANCE = 0.03;
const LOCATIONS = [
  { id: 'pond', n: 'Quiet Pond', asc: 0, cost: 0, luck: 1, cash: 1, rb: [1, 1, 1], lv: 1, mast: null,
    exc: [{ id: 'minnow', n: 'Silver Minnow', p: 6, v: 20 }, { id: 'lily', n: 'Lily Koi', p: 3, v: 40 }, { id: 'moonpond', n: 'Moon Carp', p: 1, v: 120 }],
    vis: { sky: ['#8fd0ff', '#bfe6ff', '#e8f6ff'], sea: ['#3aa0e8', '#2a7fd0', '#1f5fb0', '#174a90'], amb: 'none' } },
  { id: 'cove', n: 'Coral Cove', asc: 0, cost: 2e6, luck: 1.1, cash: 1.05, rb: [0.9, 1.15, 1.2], lv: 1, mast: null,
    exc: [{ id: 'clown', n: 'Cove Clown', p: 6, v: 25 }, { id: 'anemone', n: 'Anemone Imp', p: 3, v: 55 }, { id: 'pearlfin', n: 'Pearlfin', p: 1, v: 150 }],
    vis: { sky: ['#ffb38a', '#ffd9b0', '#fff0dc'], sea: ['#2fd6c6', '#1aa9b8', '#127c9a', '#0d5a80'], amb: 'bubbles' } },
  { id: 'frozen', n: 'Frozen Lake', asc: 1, cost: 5e9, luck: 1.2, cash: 1.1, rb: [0.85, 1.2, 1.3], lv: 1, mast: null,
    exc: [{ id: 'icefin', n: 'Icefin', p: 6, v: 30 }, { id: 'rime', n: 'Rimeback', p: 3, v: 70 }, { id: 'aurorafish', n: 'Aurora Smelt', p: 1, v: 200 }],
    vis: { sky: ['#9fc4e8', '#cfe4f5', '#f2f8ff'], sea: ['#6fc4ee', '#4aa0d8', '#3478b8', '#265a98'], amb: 'snow' } },
  { id: 'volcanic', n: 'Volcanic Depths', asc: 3, cost: 5e12, luck: 1.35, cash: 1.15, rb: [0.8, 1.25, 1.4], lv: 1, mast: null,
    exc: [{ id: 'ember', n: 'Ember Eel', p: 6, v: 40 }, { id: 'magma', n: 'Magma Maw', p: 3, v: 90 }, { id: 'phoenixfin', n: 'Phoenixfin', p: 1, v: 260 }],
    vis: { sky: ['#3a1410', '#6a2214', '#a0401c'], sea: ['#6a1a10', '#4e1410', '#34100e', '#200a0a'], amb: 'embers' } },
  { id: 'abyssal', n: 'Abyssal Ocean', asc: 6, cost: 5e15, luck: 1.5, cash: 1.25, rb: [0.7, 1.3, 1.6], lv: 1, mast: null,
    exc: [{ id: 'lantern', n: 'Lantern Angler', p: 6, v: 60 }, { id: 'ghostjelly', n: 'Ghost Jelly', p: 3, v: 130 }, { id: 'leviathan', n: 'Leviathan Spawn', p: 1, v: 400 }],
    vis: { sky: ['#0a1030', '#10204a', '#183060'], sea: ['#0e2a5a', '#0a1e44', '#061230', '#030a1c'], amb: 'motes' } },
  { id: 'heaven', n: "Heaven's Gate", asc: 9, cost: 5e18, luck: 1.65, cash: 1.3, rb: [0.6, 1.35, 1.8], lv: 20, mast: [4, 10],
    exc: [{ id: 'seraph', n: 'Seraphfin', p: 6, v: 90 }, { id: 'halo', n: 'Halo Ray', p: 3, v: 200 }, { id: 'gatekeeper', n: 'Gatekeeper Koi', p: 1, v: 600 }],
    vis: { sky: ['#fff2c0', '#ffe39a', '#fff8e0'], sea: ['#f0b840', '#d9922c', '#b06a22', '#7c4418'], amb: 'halo' } },
  { id: 'glitch', n: 'Glitched Dimension', asc: 13, cost: 5e21, luck: 1.8, cash: 1.35, rb: [0.5, 1.4, 2], lv: 30, mast: [5, 10],
    exc: [{ id: 'pixel', n: 'Pixel Perch', p: 6, v: 140 }, { id: 'null', n: 'Null Pointer', p: 3, v: 320 }, { id: 'segfault', n: 'Segfault Shark', p: 1, v: 900 }],
    vis: { sky: ['#0a0a14', '#14202a', '#0a2a1c'], sea: ['#0a3a2a', '#082a3a', '#1a0a3a', '#0a0a1a'], amb: 'glitch' } },
  { id: 'voidrealm', n: 'Void Realm', asc: 17, cost: 5e24, luck: 2, cash: 1.4, rb: [0.4, 1.5, 2.4], lv: 40, mast: [6, 10],
    exc: [{ id: 'umbra', n: 'Umbra Ray', p: 6, v: 220 }, { id: 'nothing', n: 'The Nothing', p: 3, v: 500 }, { id: 'oblivion', n: 'Oblivion Whale', p: 1, v: 1500 }],
    vis: { sky: ['#05000f', '#12002a', '#220048'], sea: ['#1a0036', '#12002a', '#0a001a', '#040008'], amb: 'void' } },
];
const EXC_IDS = [];
LOCATIONS.forEach((l, i) => l.exc.forEach((e, j) => EXC_IDS.push(i + '_' + j)));
const MASTERY_MAX_LV = 20; // mastery level per location; each level adds 1% to cash
const MASTERY_CASH = 0.01;
const MASTERY_XP = 10; // catches needed to go from level L to L+1 is MASTERY_XP * (L+1)^2
const CHEST_MAX = 50; // unopened treasure chests a save may hold (all tiers together)

// ---- fishing level: every catch earns XP; each level gives a small permanent cash and luck bonus ----
const LEVEL_MAX = 50;
const LEVEL_CASH = 0.005; // +0.5% cash per level above 1
const LEVEL_LUCK = 0.004; // +0.4% luck per level above 1
const levelNeed = (l) => Math.round(40 * Math.pow(l, 1.6)); // XP needed to go from level l to l+1
// Titles a player can equip: milestone levels, plus one per achievement below that names a title.
const LEVEL_TITLES = [{ id: 'lv10', lv: 10, n: 'Angler' }, { id: 'lv20', lv: 20, n: 'Seasoned' }, { id: 'lv30', lv: 30, n: 'Veteran' }, { id: 'lv40', lv: 40, n: 'Master Angler' }, { id: 'lv50', lv: 50, n: 'Grandmaster' }];
// Expansion achievements (the conditions live in the client; the server only checks ids). sec: secret until earned. ttl: the title it unlocks.
const XACH = [
  { id: 'x_leg', i: '&#11088;', n: 'Legend Found', d: 'Catch your first Legendary', ttl: 'Legend Seeker' },
  { id: 'x_1k', i: '&#127907;', n: 'Thousand Casts', d: 'Catch 1,000 fish', ttl: 'Dedicated' },
  { id: 'x_mut', i: '&#129516;', n: 'Mutant Collector', d: 'Discover every mutation', ttl: 'Mutagen' },
  { id: 'x_loc', i: '&#128506;', n: 'Explorer', d: 'Unlock every fishing location', ttl: 'Explorer' },
  { id: 'x_1m', i: '&#127920;', n: 'One in a Million', d: 'Catch an Abyssal or rarer fish', ttl: 'Impossible' },
  { id: 'x_lv10', i: '&#128201;', n: 'Getting Serious', d: 'Reach fishing level 10' },
  { id: 'x_lv25', i: '&#128200;', n: 'Seasoned Angler', d: 'Reach fishing level 25' },
  { id: 'x_lv50', i: '&#128081;', n: 'Grandmaster', d: 'Reach fishing level 50', ttl: 'Max Level' },
  { id: 'x_chest', i: '&#127873;', n: 'Treasure Trove', d: 'Open 25 chests', ttl: 'Treasure Hunter' },
  { id: 'x_myth', i: '&#128142;', n: 'Mythical Haul', d: 'Open a Mythical chest', ttl: 'Fortune Favoured' },
  { id: 'x_rod', i: '&#127907;', n: 'Rod Collector', d: 'Own every rod' },
  { id: 'x_evt', i: '&#127769;', n: 'Event Chaser', d: 'Catch 25 fish during world events', ttl: 'Event Chaser' },
  { id: 'x_moon', i: '&#128302;', n: 'Moonlit Miracle', d: 'Catch a Legendary or better under a Blood Moon', sec: 1, ttl: 'Moonlit' },
  { id: 'x_void', i: '&#128376;', n: 'Void Touched', d: 'Catch a Void mutation during a Void Storm', sec: 1, ttl: 'Void Touched' },
];
// The last four titles are the Book goal titles (BOOK_GOALS, defined further down); an equipped one needs its goal claimed.
const TITLE_IDS = LEVEL_TITLES.map((t) => t.id).concat(XACH.filter((a) => a.ttl).map((a) => a.id)).concat(['bk25', 'bk50', 'bk75', 'bk100']);
const XACH_IDS = XACH.map((a) => a.id);
// Treasure chest tiers, rarest last. w: relative chance a chest is this tier; m: reward size multiplier.
const CHEST_TIERS = [
  { id: 'common', n: 'Common', col: '#cfd8e3', w: 70, m: 1 },
  { id: 'rare', n: 'Rare', col: '#4aa8ff', w: 20, m: 3 },
  { id: 'epic', n: 'Epic', col: '#c66bff', w: 7, m: 10 },
  { id: 'legendary', n: 'Legendary', col: '#ffc61a', w: 2.5, m: 40 },
  { id: 'mythical', n: 'Mythical', col: '#ff4f6d', w: 0.5, m: 200 },
];

// ---- museum: display cases for the player's best catches, themes unlocked by fishing level, and up to 3 pinned achievements ----
// G.x.mu = { cs: [[rarity, mutation, caughtAtMs], ...] (at most MUSEUM_CASES), th: theme index, pin: [achievement ids] }.
const MUSEUM_CASES = 12;
const MUSEUM_MIN_RAR = 3; // Epic and above can be put on display
const MUSEUM_PINS = 3;
const MUSEUM_THEMES = [
  { id: 'classic', n: 'Classic Hall', lv: 1, bg: ['#2a3a52', '#1a2638'], acc: '#ffe36b' },
  { id: 'ocean', n: 'Deep Ocean', lv: 10, bg: ['#0e3a63', '#06203a'], acc: '#7dd3ff' },
  { id: 'gold', n: 'Gilded Hall', lv: 20, bg: ['#5a4216', '#2e210a'], acc: '#ffd23f' },
  { id: 'void', n: 'Void Gallery', lv: 35, bg: ['#2a1050', '#0e0420'], acc: '#b97cff' },
  { id: 'cosmic', n: 'Cosmic Vault', lv: 50, bg: ['#10205a', '#04081e'], acc: '#ff7de9' },
];

// ---- Book goals: completion milestones of the collection Book (entries discovered out of 85). Each pays materials once and unlocks a title. ----
// G.x.bc = { <goal id>: 1 } for the goals already claimed. The client checks the percentage; the server only checks ids.
const BOOK_TOTAL = 85;
const BOOK_GOALS = [
  { id: 'bk25', pct: 25, n: 'Curious Collector', ttl: 'Curious', mat: { scale: 60 } },
  { id: 'bk50', pct: 50, n: 'Dedicated Curator', ttl: 'Curator', mat: { scale: 120, pearl: 20 } },
  { id: 'bk75', pct: 75, n: 'Master Archivist', ttl: 'Archivist', mat: { pearl: 40, shard: 6 } },
  { id: 'bk100', pct: 100, n: 'Completionist', ttl: 'Completionist', mat: { pearl: 80, shard: 20 } },
];
const BOOK_IDS = BOOK_GOALS.map((g) => g.id);

// ---- tournaments ----
// Like the events, tournaments are a pure function of server time: the clock is cut into fixed windows and the window number picks the scoring category.
// Scores live on the server (sorted set tn:<window>); the only thing a save keeps is which windows' rewards were already claimed (G.x.tr).
const TOURNEY_MS = 6 * 60 * 60 * 1000; // one tournament per window
const TOURNEY_KEEP_S = 3 * 24 * 3600; // a finished board is kept this long, so the last windows can still be claimed
const TOURNEY_CLAIM_WINDOWS = 8; // a reward can be claimed for any of this many most recent finished windows
const TOURNEY_PTS_MAX = 5000; // most points one submission may add
const TOURNEY_WIN_MAX = 200000; // most points one player may hold in one window
const TOURNEY_CATS = [
  { id: 'value', n: 'Catch Value', i: '\u{1F4B0}', d: 'Points for the value of every catch' },
  { id: 'rare', n: 'Rare Catches', i: '\u{1F48E}', d: 'Epic and better catches score big' },
  { id: 'mut', n: 'Mutation Hunt', i: '\u{1F9EC}', d: 'Only mutated catches score' },
];
// Materials by finishing rank: the first band whose max is at least your rank pays out. Everyone who scored gets the last band.
const TOURNEY_REWARDS = [
  { max: 1, n: 'Champion', mat: { scale: 40, pearl: 15, shard: 4 } },
  { max: 3, n: 'Podium', mat: { scale: 30, pearl: 10, shard: 2 } },
  { max: 10, n: 'Top 10', mat: { scale: 20, pearl: 5 } },
  { max: 1e9, n: 'Finisher', mat: { scale: 8 } },
];
const tourneyWindow = (now) => Math.floor(now / TOURNEY_MS);
const tourneyCat = (w) => TOURNEY_CATS[h32(w * 5 + 4) % TOURNEY_CATS.length];
const tourneyReward = (rank) => TOURNEY_REWARDS.find((r) => rank <= r.max);

// Display name of a title id (level titles, achievement titles and Book titles); '' for anything unknown.
const TITLE_NAMES = {};
LEVEL_TITLES.forEach((t) => { TITLE_NAMES[t.id] = t.n; });
XACH.forEach((a) => { if (a.ttl) TITLE_NAMES[a.id] = a.ttl; });
BOOK_GOALS.forEach((g) => { TITLE_NAMES[g.id] = g.ttl; });
const titleName = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(TITLE_NAMES, id) ? TITLE_NAMES[id] : '');

const maxOf = (arr, k) => arr.reduce((m, v) => Math.max(m, v[k]), 1);
// The most any combination of expansion bonuses can multiply income: best rod x best location x best event x full mastery.
// lib/cheat.js multiplies its income ceiling by this for saves that carry G.x (and not at all for older saves).
const CASH_MAX = maxOf(RODS, 'cash') * maxOf(LOCATIONS, 'cash') * maxOf(EVENTS, 'cash') * (1 + MASTERY_CASH * MASTERY_MAX_LV) * (1 + LEVEL_CASH * (LEVEL_MAX - 1)) * (1 + EVO_CASH * EVO_MAX);

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
// A list of distinct integers in [0, n) that includes 0 (the starter) and `cur`.
function idList(a, n, cur) {
  if (!Array.isArray(a) || a.length > n || !a.every((v) => isInt(v, 0, n - 1))) return false;
  return new Set(a).size === a.length && a.includes(0) && a.includes(cur);
}
// Bounds check for G.x, the compact expansion object in the save: { rod, rods, loc, locs, mxp: { <loc>: level }, chests }.
function validateX(x, asc) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const allowed = ['rod', 'rods', 'loc', 'locs', 'mxp', 'mxx', 'chests', 'lv', 'xp', 'ttl', 'xa', 'cht', 'evc', 'ev', 'mat', 'exc', 'mu', 'bc', 'tr', 'pr'];
  if (Object.keys(x).some((k) => !allowed.includes(k))) return false;
  if (!isInt(x.rod, 0, RODS.length - 1) || !idList(x.rods, RODS.length, x.rod)) return false;
  if (!isInt(x.loc, 0, LOCATIONS.length - 1) || !idList(x.locs, LOCATIONS.length, x.loc)) return false;
  if (x.locs.some((i) => LOCATIONS[i].asc > asc)) return false; // a location cannot be unlocked before its ascension
  if (x.mxp !== undefined) {
    if (!x.mxp || typeof x.mxp !== 'object' || Array.isArray(x.mxp)) return false;
    for (const k of Object.keys(x.mxp)) if (!/^\d$/.test(k) || !isInt(+k, 0, LOCATIONS.length - 1) || !isInt(x.mxp[k], 0, MASTERY_MAX_LV)) return false;
  }
  if (x.mxx !== undefined) { // catch progress towards the next mastery level, per location
    if (!x.mxx || typeof x.mxx !== 'object' || Array.isArray(x.mxx)) return false;
    for (const k of Object.keys(x.mxx)) if (!/^\d$/.test(k) || !isInt(+k, 0, LOCATIONS.length - 1) || !isInt(x.mxx[k], 0, MASTERY_XP * (MASTERY_MAX_LV + 1) ** 2)) return false;
  }
  if (x.chests !== undefined && !isInt(x.chests, 0, CHEST_MAX)) return false;
  // Fishing level, XP towards the next level, equipped title, earned expansion achievements, chests by tier, and the event-catch counter.
  if (x.lv !== undefined && !isInt(x.lv, 1, LEVEL_MAX)) return false;
  if (x.xp !== undefined && !isInt(x.xp, 0, x.lv === LEVEL_MAX ? 0 : levelNeed(x.lv || 1))) return false;
  if (x.ttl !== undefined && x.ttl !== '' && !TITLE_IDS.includes(x.ttl)) return false;
  if (x.xa !== undefined) {
    if (!x.xa || typeof x.xa !== 'object' || Array.isArray(x.xa)) return false;
    for (const k of Object.keys(x.xa)) if (!XACH_IDS.includes(k) || x.xa[k] !== 1) return false;
  }
  if (x.cht !== undefined) {
    if (!Array.isArray(x.cht) || x.cht.length !== CHEST_TIERS.length || !x.cht.every((v) => isInt(v, 0, CHEST_MAX))) return false;
    if (x.cht.reduce((a, b) => a + b, 0) + (x.chests || 0) > CHEST_MAX) return false;
  }
  if (x.evc !== undefined && !isInt(x.evc, 0, 1e9)) return false;
  // Milestone locations: owning one needs its fishing level and the mastery of an earlier location (both only ever go up).
  for (const i of x.locs) {
    const l = LOCATIONS[i];
    if (l.lv > (x.lv || 1)) return false;
    if (l.mast && ((x.mxp && x.mxp[l.mast[0]]) || 0) < l.mast[1]) return false;
  }
  // Exclusive catches: how many of each were caught, keyed '<location>_<n>'; only at a location the save owns.
  if (x.exc !== undefined) {
    if (!x.exc || typeof x.exc !== 'object' || Array.isArray(x.exc)) return false;
    for (const k of Object.keys(x.exc)) if (!EXC_IDS.includes(k) || !isInt(x.exc[k], 1, 1e9) || !x.locs.includes(+k.split('_')[0])) return false;
  }
  // Rod evolution tier per rod (only owned rods may be evolved) and the materials stash.
  if (x.ev !== undefined) {
    if (!Array.isArray(x.ev) || x.ev.length !== RODS.length || !x.ev.every((v) => isInt(v, 0, EVO_MAX))) return false;
    if (x.ev.some((v, i) => v > 0 && !x.rods.includes(i))) return false;
  }
  if (x.mat !== undefined) {
    if (!x.mat || typeof x.mat !== 'object' || Array.isArray(x.mat)) return false;
    for (const k of Object.keys(x.mat)) if (!MAT_IDS.includes(k) || !isInt(x.mat[k], 0, MAT_MAX)) return false;
  }
  // Museum: displayed catches (Epic and above), the theme (unlocked by fishing level) and pinned achievements (earned ones only).
  if (x.mu !== undefined) {
    const m = x.mu;
    if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some((k) => !['cs', 'th', 'pin'].includes(k))) return false;
    if (m.cs !== undefined) {
      if (!Array.isArray(m.cs) || m.cs.length > MUSEUM_CASES) return false;
      for (const c of m.cs) {
        if (!Array.isArray(c) || c.length !== 3 || !isInt(c[0], MUSEUM_MIN_RAR, 16) || !isInt(c[1], 0, 4) || !isInt(c[2], 0, 4e12)) return false;
      }
    }
    if (m.th !== undefined && (!isInt(m.th, 0, MUSEUM_THEMES.length - 1) || MUSEUM_THEMES[m.th].lv > (x.lv || 1))) return false;
    if (m.pin !== undefined) {
      if (!Array.isArray(m.pin) || m.pin.length > MUSEUM_PINS || new Set(m.pin).size !== m.pin.length) return false;
      if (!m.pin.every((id) => XACH_IDS.includes(id) && x.xa && x.xa[id] === 1)) return false;
    }
  }
  // Book goals already claimed; an equipped Book title needs its goal claimed.
  if (x.bc !== undefined) {
    if (!x.bc || typeof x.bc !== 'object' || Array.isArray(x.bc)) return false;
    for (const k of Object.keys(x.bc)) if (!BOOK_IDS.includes(k) || x.bc[k] !== 1) return false;
  }
  if (x.ttl && BOOK_IDS.includes(x.ttl) && !(x.bc && x.bc[x.ttl] === 1)) return false;
  // Tournament rewards already claimed, keyed by window number. A window can only be claimed once it has finished, so it can never be ahead of the server clock (one window of slack for clock skew).
  // Promo codes already redeemed on this account: upper-case code -> 1 (the codes themselves are defined by the game, not the save).
  if (x.pr !== undefined) {
    if (!x.pr || typeof x.pr !== 'object' || Array.isArray(x.pr)) return false;
    const pk = Object.keys(x.pr);
    if (pk.length > 64) return false;
    for (const k of pk) if (!/^[A-Z0-9]{1,40}$/.test(k) || x.pr[k] !== 1) return false;
  }
  if (x.tr !== undefined) {
    if (!x.tr || typeof x.tr !== 'object' || Array.isArray(x.tr)) return false;
    const ks = Object.keys(x.tr), cur = tourneyWindow(Date.now());
    if (ks.length > 64) return false;
    for (const k of ks) if (!/^\d{1,9}$/.test(k) || +k > cur + 1 || x.tr[k] !== 1) return false;
  }
  return true;
}

module.exports = { SLOT_MS, EVENT_CHANCE, EVENTS, h32, slotEvent, activeEvent, nextEvent, RODS, LOCATIONS, EXC_CHANCE, EXC_IDS, MASTERY_MAX_LV, MASTERY_CASH, MASTERY_XP, CHEST_MAX, EVO_MAX, EVO_CASH, EVO_LUCK, MAT_MAX, MATERIALS, MAT_IDS, evoCost, LEVEL_MAX, LEVEL_CASH, LEVEL_LUCK, levelNeed, LEVEL_TITLES, XACH, TITLE_IDS, CHEST_TIERS, CASH_MAX, validateX, MUSEUM_CASES, MUSEUM_MIN_RAR, MUSEUM_PINS, MUSEUM_THEMES, BOOK_TOTAL, BOOK_GOALS, BOOK_IDS, TOURNEY_MS, TOURNEY_KEEP_S, TOURNEY_CLAIM_WINDOWS, TOURNEY_PTS_MAX, TOURNEY_WIN_MAX, TOURNEY_CATS, TOURNEY_REWARDS, tourneyWindow, tourneyCat, tourneyReward, titleName };
