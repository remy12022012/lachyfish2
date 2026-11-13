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
const RODS = [
  { id: 'twig', n: 'Twig Rod', cost: 0, luck: 1, cash: 1 },
  { id: 'bamboo', n: 'Bamboo Rod', cost: 5e4, luck: 1.1, cash: 1.05 },
  { id: 'carbon', n: 'Carbon Rod', cost: 5e6, luck: 1.25, cash: 1.1 },
  { id: 'coral', n: 'Coral Rod', cost: 5e8, luck: 1.45, cash: 1.2 },
  { id: 'abyssal', n: 'Abyssal Rod', cost: 5e10, luck: 1.7, cash: 1.3 },
  { id: 'void', n: 'Void Rod', cost: 5e12, luck: 2, cash: 1.5 },
];
// asc: ascensions needed before the location can be bought; cost in coins.
const LOCATIONS = [
  { id: 'pond', n: 'Quiet Pond', asc: 0, cost: 0, luck: 1, cash: 1 },
  { id: 'reef', n: 'Coral Reef', asc: 0, cost: 2e6, luck: 1.1, cash: 1.05 },
  { id: 'cave', n: 'Glow Cave', asc: 1, cost: 5e9, luck: 1.2, cash: 1.1 },
  { id: 'trench', n: 'Abyss Trench', asc: 3, cost: 5e12, luck: 1.35, cash: 1.15 },
  { id: 'rift', n: 'Void Rift', asc: 6, cost: 5e15, luck: 1.5, cash: 1.25 },
];
const MASTERY_MAX_LV = 20; // mastery level per location; each level adds 1% to cash
const MASTERY_CASH = 0.01;
const MASTERY_XP = 10; // catches needed to go from level L to L+1 is MASTERY_XP * (L+1)^2
const CHEST_MAX = 50; // unopened treasure chests a save may hold

const maxOf = (arr, k) => arr.reduce((m, v) => Math.max(m, v[k]), 1);
// The most any combination of expansion bonuses can multiply income: best rod x best location x best event x full mastery.
// lib/cheat.js multiplies its income ceiling by this for saves that carry G.x (and not at all for older saves).
const CASH_MAX = maxOf(RODS, 'cash') * maxOf(LOCATIONS, 'cash') * maxOf(EVENTS, 'cash') * (1 + MASTERY_CASH * MASTERY_MAX_LV);

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
// A list of distinct integers in [0, n) that includes 0 (the starter) and `cur`.
function idList(a, n, cur) {
  if (!Array.isArray(a) || a.length > n || !a.every((v) => isInt(v, 0, n - 1))) return false;
  return new Set(a).size === a.length && a.includes(0) && a.includes(cur);
}
// Bounds check for G.x, the compact expansion object in the save: { rod, rods, loc, locs, mxp: { <loc>: level }, chests }.
function validateX(x, asc) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const allowed = ['rod', 'rods', 'loc', 'locs', 'mxp', 'mxx', 'chests'];
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
  return true;
}

module.exports = { SLOT_MS, EVENT_CHANCE, EVENTS, h32, slotEvent, activeEvent, nextEvent, RODS, LOCATIONS, MASTERY_MAX_LV, MASTERY_CASH, MASTERY_XP, CHEST_MAX, CASH_MAX, validateX };
