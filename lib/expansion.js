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

module.exports = { SLOT_MS, EVENT_CHANCE, EVENTS, h32, slotEvent, activeEvent, nextEvent };
