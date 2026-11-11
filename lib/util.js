'use strict';
const crypto = require('crypto');
const { getStore } = require('./store');

const NR = 17; // rarities in the client (RAR.length, top tier is Limited Edition); valid index 0..NR-1
const NM = 5; // mutations (Normal, Shiny, Golden, Rainbow, Void)
const MAX_ASC = 20; // hard cap on ascensions
const SEASON = 3; // bump to invalidate every older save and cached client (the accounts were reset for season 3)
// Minimum ascensions before each rarity (index = rarity) can be caught or fused. MUST match ASC_REQ in public/index.html.
const ASC_REQ = [0, 0, 0, 0, 0, 0, 0, 3, 5, 7, 9, 11, 13, 17, 19, 20, 20];
// Each ascension costs cash in the client (2e8 * 3.4^n) and wipes the run, so the server also enforces a minimum real time per ascension.
const MIN_ASC_MS = 10 * 60 * 1000;
function maxRarFor(asc) { let m = 0; for (let i = 0; i < ASC_REQ.length; i++) if (ASC_REQ[i] <= asc) m = i; return m; }
const MAX_BODY = 1.5 * 1024 * 1024;
const MAX_SAVE = 400000; // characters; larger saves are skipped, stats still sync
const NAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;
const SESSION_TTL = 60 * 60 * 24 * 90;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let b;
  try { b = req.body; } catch (e) { return null; } // Vercel throws on malformed JSON
  if (b !== undefined && b !== null) {
    if (typeof b === 'object' && !Buffer.isBuffer(b)) return b;
    try { return JSON.parse(Buffer.isBuffer(b) ? b.toString('utf8') : String(b)); } catch (e) { return null; }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) return null;
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch (e) { return null; }
}

function handler(methods, fn) {
  return async function (req, res) {
    try {
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        return send(res, 405, { error: 'Method not allowed.' });
      }
      const store = getStore();
      if (!store) return send(res, 503, { error: 'The server database is not connected yet.' });
      await fn(req, res, store);
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      if (!res.headersSent) send(res, 500, { error: 'Server error. Please try again.' });
    }
  };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((ok, bad) => crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? bad(e) : ok(k))));
const DUMMY_SALT = Buffer.alloc(16, 7);

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt);
  return { salt: salt.toString('hex'), hash: h.toString('hex') };
}
async function checkPassword(pw, rec) {
  if (!rec) { await scrypt(pw, DUMMY_SALT); return false; } // same cost whether or not the user exists
  const h = await scrypt(pw, Buffer.from(rec.salt, 'hex'));
  const want = Buffer.from(rec.hash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

async function newSession(store, lname, at) {
  const token = crypto.randomBytes(32).toString('hex');
  // The value carries the login time so a "kick" (admin action or password change) can invalidate every session older than the kick.
  // `at` lets a caller stamp the session just after a kick it made itself, so the new session is not caught by that kick.
  await store.set('s:' + sha(token), lname + '|' + (at || Date.now()), { ex: SESSION_TTL });
  return token;
}
// Returns the lowercase username for a valid Bearer token, else null.
async function authUser(req, store) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer ([0-9a-f]{64})$/.exec(h);
  if (!m) return null;
  const v = await store.get('s:' + sha(m[1]));
  if (!v) return null;
  const parts = String(v).split('|');
  const lname = parts[0], made = +parts[1] || 0; // sessions from before this change count as time 0
  const [kick, ban] = await Promise.all([store.get('kick:' + lname), store.get('ban:' + lname)]);
  if (ban) return null;
  if (kick && +kick >= made) return null;
  return lname;
}

function clientIp(req) {
  const x = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (x || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 64);
}
async function allow(store, key, max, windowSec) {
  const k = 'rl:' + key;
  const n = await store.incr(k);
  if (n === 1) await store.expire(k, windowSec);
  return n <= max;
}

function parseJSON(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function queryOf(req) { return new URL(req.url || '/', 'http://x').searchParams; }

// ---- validation of the stats the client submits ----
function num(v, min, max, int) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null;
  if (int && !Number.isInteger(v)) return null;
  return v;
}
function validateStats(b) {
  if (!b || typeof b !== 'object') return null;
  const s = {
    coins: num(b.coins, 0, 1e21, false),
    inc: num(b.inc, 0, 1e20, false),
    asc: num(b.asc, 0, MAX_ASC, true),
    caught: num(b.caught, 0, 1e9, true),
    book: num(b.book, 0, 80, true), // the client sends Math.min(80, entries found)
    bestRar: num(b.bestRar, 0, NR - 1, true),
    bestMut: num(b.bestMut, 0, NM - 1, true),
    cps: num(b.cps, 0, 1e6, false),
    // Lifetime earnings across every run (the client's lp + run). Older clients do not send it, so it falls back to the coins held.
    life: b.life === undefined ? num(b.coins, 0, 1e21, false) : num(b.life, 0, 1e24, false),
  };
  for (const k in s) if (s[k] === null) return null;
  if (s.life < s.coins) s.life = s.coins; // lifetime earnings can never be below what is held right now
  const cap = maxRarFor(s.asc); // no rarity above what this many ascensions can reach
  if (s.bestRar > cap) return null;
  if (!Array.isArray(b.top) || b.top.length > 6) return null;
  s.top = [];
  for (const f of b.top) {
    if (!Array.isArray(f) || f.length < 3) return null;
    const r = num(f[0], 0, NR - 1, true), m = num(f[1], 0, NM - 1, true), l = num(f[2], 1, 20, true);
    if (r === null || m === null || l === null || r > cap) return null;
    s.top.push([r, m, l]);
  }
  s.save = typeof b.save === 'string' ? b.save : null;
  return s;
}

// The cloud save is loaded back into the game, so it gets the same checks as the stats: current season, ascensions equal to
// the submitted stats, and no face or Book entry of a rarity this ascension count cannot reach.
function validateSave(raw, s) {
  if (typeof raw !== 'string' || raw.length > MAX_SAVE) return false;
  const o = parseJSON(raw);
  if (!o || typeof o !== 'object' || o.S !== SEASON) return false;
  const g = o.G;
  if (!g || typeof g !== 'object' || g.asc !== s.asc) return false;
  const cap = maxRarFor(s.asc);
  if (!Array.isArray(o.faces) || o.faces.length > 3000) return false;
  for (const f of o.faces) {
    if (!Array.isArray(f) || !Number.isInteger(f[1]) || f[1] < 0 || f[1] > cap) return false;
    if (!Number.isInteger(f[2]) || f[2] < 0 || f[2] >= NM) return false;
  }
  if (g.book && typeof g.book === 'object') {
    for (const k of Object.keys(g.book)) { const r = parseInt(k, 10); if (!Number.isInteger(r) || r > cap) return false; }
  }
  return true;
}

module.exports = { NR, NM, MAX_ASC, SEASON, ASC_REQ, MIN_ASC_MS, maxRarFor, validateSave, MAX_SAVE, NAME_RE, send, readBody, handler, hashPassword, checkPassword, newSession, authUser, clientIp, allow, parseJSON, queryOf, validateStats };
