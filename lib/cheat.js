'use strict';
// Server-side plausibility checks for the stats and cloud save a client submits.
//
// The server cannot replay the game, but it can check that the numbers are possible:
//   * Hard findings are impossible states (an upgrade above its maximum, a face above level 20, income far above what the
//     faces in the save could produce). They reject the sync AND count a strike; STRIKE_LIMIT strikes within STRIKE_WINDOW
//     seconds quarantine the account (it stops appearing on the leaderboards until an admin clears it).
//   * Soft findings are things an honest player could rarely trigger (a stat that does not match the save it came with,
//     coins or catches growing faster than the real time since the last sync allows, for example after playing on another
//     device while logged out). They reject the sync but never count a strike: the numbers become acceptable again once
//     enough real time has passed.
const { NR, NM, allow } = require('./util');

// Economy tables. MUST match RAR (inc, sell, fm), MUT (m) and UPS (max) in public/index.html; test/api.test.js checks this.
const RAR_INC = [1, 3.5, 14, 60, 300, 2000, 15000, 70000, 300000, 1.4e6, 7e6, 5e7, 3.5e8, 2.2e9, 1.4e10, 1e11, 8e11];
const RAR_SELL = [10, 40, 170, 800, 4500, 35000, 300000, 1.5e6, 8e6, 4e7, 2.5e8, 3e9, 2e10, 1.5e11, 1e12, 2e13, 1.6e14];
const RAR_FM = [1, 1.3, 1.7, 2.3, 3.5, 5, 8, 11, 15, 20, 28, 40, 55, 75, 100, 150, 220];
const MUT_M = [1, 2, 4, 10, 25];
const UP_MAX = { auto: 25, quick: 20, luck: 40, mut: 30, val: 50, multi: 25, crew: 19, cap: 10, guard: 10, farm: 29, soil: 40, feed: 25 };
// Every upgrade's cap starts at 40% of its final max and rises with each ascension, reaching the final max at ascension UP_FULL_ASC.
// MUST match upMax / UP_FULL_ASC in public/index.html; test/api.test.js checks this.
const UP_FULL_ASC = 10;
// Crew and Farm slots reach their final size (Crew 20, Farm 30) only at the maximum ascension; MUST match upFull in public/index.html.
const UP_FULL_MAX_ASC = 20;
const upFull = (k) => (k === 'crew' || k === 'farm' ? UP_FULL_MAX_ASC : UP_FULL_ASC);
// Base holds 30 + 7 per Bigger Base level, so 100 at the final level.
const baseCap = (lv) => 30 + 7 * lv;
const FOOD_MAX = 1e12;
function upCap(k, asc) {
  const mx = UP_MAX[k], s = Math.max(1, Math.ceil(mx * 0.4)), f = upFull(k), n = Math.max(0, Math.min(f, asc | 0));
  return Math.min(mx, s + Math.ceil((mx - s) * n / f));
}
const MAXLV = 20;
const BOOK_KEY = /^(?:[0-9]|1[0-6])_[0-4]$/;

const STRIKE_LIMIT = 3;
const STRIKE_WINDOW = 24 * 3600;

const MAX_GEMS = 3000; // hard ceiling: gems only come from bubbles, chests, quests and a daily streak, and reset on ascension
const GEMS_FIRST_SYNC = 500; // a first sync (no earlier profile) above this is not believable
const GEM_RATE = 0.02; // gems per real second a run can possibly gain
const CATCH_RATE = 100; // catches per real second: auto fish + frenzy clicking + double hook stays far below this
const MAX_SELL_MULT = 25 * (1 + 0.4 * (MAXLV - 1)); // top mutation x top level
const OFFLINE_SLACK = 7200 + 3000; // offline earnings (7200 s at 50%), plus a daily reward and chests, in seconds of income
const FIRST_SYNC_DAYS = 14; // a first sync may carry progress made as a guest: allow this many days of income

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

// s: the validated stats, o: the parsed cloud save (already passed validateSave), prev: the stored profile or null.
function inspect(s, o, prev, now) {
  const hard = [];
  const soft = [];
  const g = o.G;

  // ---- upgrades, gems ----
  const up = g.up && typeof g.up === 'object' ? g.up : {};
  const U = {};
  for (const k of Object.keys(UP_MAX)) {
    const v = up[k];
    if (v === undefined) { U[k] = 0; continue; }
    if (!Number.isInteger(v) || v < 0 || v > UP_MAX[k]) { hard.push('upgrade ' + k); U[k] = 0; continue; }
    U[k] = v;
    // Above this ascension's cap: impossible for a current client (ucv 1), but an older client that has not clamped yet is only soft.
    if (v > upCap(k, s.asc)) (g.ucv === 1 ? hard : soft).push('upgrade cap ' + k);
  }
  const gems = fin(g.gems) && g.gems >= 0 ? g.gems : -1;
  if (gems < 0 || gems > MAX_GEMS) hard.push('gems');
  const gemsC = Math.min(MAX_GEMS, Math.max(0, gems));

  // ---- faces ----
  const capN = baseCap(U.cap);
  const slots = 1 + U.crew;
  const fSlots = 1 + U.farm;
  const food = fin(g.food) ? g.food : g.food === undefined ? 0 : -1;
  if (food < 0 || food > FOOD_MAX) hard.push('food');
  const foodC = Math.min(FOOD_MAX, Math.max(0, food));
  const faces = o.faces;
  if (faces.length > capN + 3) hard.push('too many faces');
  let incBase = 0;
  let cpsSave = 0;
  let crew = 0;
  let farm = 0;
  let farmSave = 0;
  const have = new Map();
  for (const f of faces) {
    const r = f[1], m = f[2], l = f[3];
    if (!Number.isInteger(l) || l < 1 || l > MAXLV) { hard.push('face level'); break; }
    incBase += RAR_INC[r] * MUT_M[m] * 0.7 * (1 + 0.35 * (l - 1));
    if (f[4]) { crew++; cpsSave += RAR_FM[r] * (1 + 0.12 * (l - 1)) / 5; }
    if (f[7]) {
      farm++;
      if (f[4]) hard.push('crew and farm');
      farmSave += RAR_FM[r] * (1 + 0.12 * (l - 1)) / 10 * (1 + 0.2 * U.soil);
    }
    const key = r + '_' + m + '_' + l;
    have.set(key, (have.get(key) || 0) + 1);
  }
  if (crew > slots) hard.push('too many crew');
  if (farm > fSlots) hard.push('too many farmers');
  for (const t of s.top) {
    const key = t.join('_');
    const n = have.get(key) || 0;
    if (!n) { soft.push('top faces'); break; }
    have.set(key, n - 1);
  }

  // ---- Book ----
  const bookObj = g.book && typeof g.book === 'object' ? g.book : {};
  const bookKeys = Object.keys(bookObj);
  for (const k of bookKeys) {
    const v = bookObj[k];
    if (!BOOK_KEY.test(k) || !fin(v) || v < 1) { hard.push('book entry'); break; }
  }
  if (Math.abs(s.book - Math.min(80, bookKeys.length)) > 1) soft.push('book count');
  // (No Book-vs-catches check: saves from before Fuse was removed can hold Book entries that catches alone do not explain.)

  // ---- the stats must be the ones in the save they came with ----
  if (s.caught < 1e9 && g.caught !== s.caught) soft.push('caught mismatch');
  if (s.coins < 1e21 && !(fin(g.coins) && Math.abs(Math.floor(g.coins) - s.coins) <= Math.max(2, s.coins * 1e-6))) soft.push('coins mismatch');

  // ---- income and cast rate must be producible by the faces in the save ----
  // gMult in the client: val x gems x discoveries x achievements x a cash buff capped at 3.
  const ach = g.ach && typeof g.ach === 'object' ? Math.min(60, Object.keys(g.ach).length) : 0;
  const gmMax = (1 + 0.12 * U.val) * (1 + 0.1 * gemsC) * (1 + 0.03 * Math.max(bookKeys.length, s.book)) * (1 + 0.05 * ach) * 3;
  const incCeil = incBase * gmMax;
  if (s.inc > incCeil * 3 + 10) hard.push('income');
  else if (s.inc > incCeil * 1.05 + 1) soft.push('income');
  if (s.cps > cpsSave * 2 + 1) hard.push('cast rate');
  else if (s.cps > cpsSave * 1.05 + 0.05) soft.push('cast rate');

  // ---- growth against real time ----
  // Money spent on ascending in earlier runs (each costs 2e8 x 3^n, so all earlier ascensions together cost less than 1.5x the last one; 4x is a generous allowance), in the lifetime total only.
  const lifeSlack = s.asc > 0 ? 4 * 2e8 * Math.pow(3, s.asc) : 0;
  const sellMax = RAR_SELL[Math.max(0, Math.min(NR - 1, s.bestRar))] * MAX_SELL_MULT;
  if (!prev) {
    // First sync of this account: progress may have been made as a guest, so only an absolute bound applies.
    const bound = incCeil * 86400 * FIRST_SYNC_DAYS + 2e5 + (s.caught + 300) * sellMax;
    if (s.coins > bound * 20 + 1e7) hard.push('coins');
    else if (s.coins > bound) soft.push('coins');
    if (s.caught > 5e6) soft.push('catches');
    // Food only comes from farm faces (plus offline time), so a first sync cannot hold more than they could grow in the same allowance.
    const foodBound = farmSave * (86400 * FIRST_SYNC_DAYS + OFFLINE_SLACK) + 50;
    if (foodC > foodBound * 20 + 1e3) hard.push('food');
    else if (foodC > foodBound) soft.push('food');
    if (gemsC > GEMS_FIRST_SYNC) soft.push('gems');
    // Lifetime earnings also count what earlier runs paid for ascending, so allow for those costs on top of the usual bound.
    const lifeBound = bound + lifeSlack;
    if (s.life > lifeBound * 20 + 1e7) hard.push('lifetime');
    else if (s.life > lifeBound) soft.push('lifetime');
  } else {
    const dt = Math.max(0, (now - (prev.t || now)) / 1000);
    const sameRun = s.asc === (prev.asc | 0); // an ascension wipes coins, catches and gems, so the new run starts from zero
    const base = sameRun ? (fin(prev.rc) ? prev.rc : (fin(prev.peak) ? prev.peak : 0)) : 0;
    const dCaught = sameRun ? Math.max(0, s.caught - (prev.caught || 0)) : s.caught;
    const incRef = Math.max(incCeil, sameRun && fin(prev.incLast) ? prev.incLast * 3 : 0);
    const bound = incRef * (dt + OFFLINE_SLACK) + 2e5 + (dCaught + 300) * sellMax;
    const gain = s.coins - base;
    if (gain > bound * 20 + 1e7) hard.push('coin jump');
    else if (gain > bound) soft.push('coin jump');
    // Lifetime earnings: only checked once the profile has one (older profiles get theirs accepted on the first sync after the update).
    if (fin(prev.life)) {
      // Ascending in this window moves the finished run into the lifetime total, so allow what the old run could have earned.
      const lifeBound = bound + (sameRun ? 0 : lifeSlack + (fin(prev.incLast) ? prev.incLast * 3 * (dt + OFFLINE_SLACK) : 0));
      const lifeGain = s.life - prev.life;
      if (lifeGain > lifeBound * 20 + 1e7) hard.push('lifetime');
      else if (lifeGain > lifeBound) soft.push('lifetime');
    }
    if (dCaught > CATCH_RATE * dt + 500) soft.push('catch rate');
    if (!sameRun || fin(prev.gems)) {
      const gPrev = sameRun ? prev.gems : 0;
      if (gemsC - gPrev > GEM_RATE * dt + 20) soft.push('gem rate');
    }
  }
  return { hard, soft, gems: gemsC };
}

// Writes a finding to the admin-visible flag feed. Soft findings are throttled so one stuck client cannot flood it.
async function logFlag(store, lname, level, reasons, now) {
  try {
    if (level === 'soft' && !(await allow(store, 'flog:' + lname, 1, 600))) return;
    await store.lpush('flagfeed', JSON.stringify({ u: lname, k: level, r: reasons, t: now }));
    await store.ltrim('flagfeed', 0, 99);
  } catch (e) { console.error('flagfeed', e); }
}

// Counts a strike; returns { strikes, quarantined }. Quarantine = hidden from the leaderboards until an admin clears it.
async function addStrike(store, lname, now) {
  const k = 'strikes:' + lname;
  const n = await store.incr(k);
  if (n === 1) await store.expire(k, STRIKE_WINDOW);
  let quarantined = false;
  if (n >= STRIKE_LIMIT) { await store.set('q:' + lname, String(now)); quarantined = true; }
  return { strikes: n, quarantined };
}

module.exports = { baseCap, upFull, inspect, logFlag, addStrike, STRIKE_LIMIT, STRIKE_WINDOW, RAR_INC, RAR_SELL, RAR_FM, MUT_M, UP_MAX, UP_FULL_ASC, FOOD_MAX, upCap, MAXLV, NM };
