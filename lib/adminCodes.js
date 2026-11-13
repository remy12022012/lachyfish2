'use strict';
// Admin codes. The ADMIN_CODES env var holds only SHA-256 hashes of long random codes, so nothing secret is in the repo, the page or the database.
// A signed-in player redeems a code once; the first account to use it becomes an admin for good and the code is spent (it cannot be bound to a second account).
// The binding is tied to the account's creation time, so someone who registers a freed username later does not inherit admin.
// Revoking: remove the hash from ADMIN_CODES and redeploy (that admin stops working at once), or an owner uses the revoke action.
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

// Codes are typed or pasted by people, so dashes, spaces and letter case are ignored.
function normalizeCode(c) { return typeof c === 'string' ? c.replace(/[\s-]+/g, '').toLowerCase() : ''; }
function hashCode(c) { return sha(normalizeCode(c)); }

// ADMIN_CODES: entries separated by spaces, commas or new lines. Each is the SHA-256 hex of a code, optionally prefixed "owner:" (the default tier is staff).
// Owners can also run wipeall and revoke staff; staff can kick, ban, unban, reset, quarantine, unflag and read the flags.
function table() {
  const out = new Map();
  for (const part of String(process.env.ADMIN_CODES || '').split(/[\s,;]+/)) {
    const m = /^(?:(owner|staff):)?([0-9a-f]{64})$/i.exec(part);
    if (m) out.set(m[2].toLowerCase(), (m[1] || '').toLowerCase() === 'owner' ? 'owner' : 'staff');
  }
  return out;
}
const configured = () => table().size > 0;

// Binds a code to the signed-in account. Returns { ok: true, tier } or { ok: false, reason: 'invalid' | 'used' }.
async function redeem(store, lname, userRec, code) {
  const n = normalizeCode(code);
  if (n.length < 24 || n.length > 128) return { ok: false, reason: 'invalid' };
  const h = sha(n), tier = table().get(h);
  if (!tier) return { ok: false, reason: 'invalid' };
  const created = (userRec && userRec.created) || 0;
  const first = await store.set('ac:' + h, JSON.stringify({ u: lname, c: created, t: Date.now() }), { nx: true });
  if (!first) {
    const cur = parse(await store.get('ac:' + h));
    if (!cur || cur.u !== lname || cur.c !== created) return { ok: false, reason: 'used' }; // spent by someone else, or revoked
  }
  await store.set('adm:' + lname, JSON.stringify({ h, c: created }));
  return { ok: true, tier };
}

// { tier } when this account is a current admin, else null. A code that was removed from ADMIN_CODES no longer counts.
async function adminOf(store, lname) {
  const [a, u] = await Promise.all([store.get('adm:' + lname), store.get('u:' + lname)]);
  const rec = parse(a), user = parse(u);
  if (!rec || !user || (user.created || 0) !== rec.c) return null;
  if (rec.g) return { tier: 'staff', granted: true }; // given directly by an owner (no code); only an owner can make one, and revoke deletes the record
  const tier = table().get(rec.h);
  return tier ? { tier } : null;
}

// Owner-granted staff admin: no code involved. Tied to the account's creation time like the code-based ones.
async function grantAdmin(store, lname, userRec) { await store.set('adm:' + lname, JSON.stringify({ g: 1, c: (userRec && userRec.created) || 0, t: Date.now() })); }

// Ends one account's admin rights for good: the code stays spent, so it cannot be redeemed again.
async function revoke(store, lname) {
  const rec = parse(await store.get('adm:' + lname));
  if (rec && rec.h) await store.set('ac:' + rec.h, JSON.stringify({ u: '!revoked', c: 0, t: Date.now() }));
  await store.del('adm:' + lname);
}

// DEV tags are cosmetic and separate from admin rights: only an owner can grant or remove them (api/admin.js). The record is tied to the account's
// creation time, so someone who registers a freed username later does not inherit the tag. Owners always show a tag.
async function grantDev(store, lname, userRec) { await store.set('dev:' + lname, JSON.stringify({ c: (userRec && userRec.created) || 0, t: Date.now() })); }
async function removeDev(store, lname) { await store.del('dev:' + lname); }
async function hasDev(store, lname) {
  const [d, u] = await Promise.all([store.get('dev:' + lname), store.get('u:' + lname)]);
  const rec = parse(d), user = parse(u);
  return !!rec && !!user && (user.created || 0) === rec.c;
}
// 'owner', 'dev' or null: what tag to show next to this account's name.
async function tagOf(store, lname) {
  const a = await adminOf(store, lname);
  if (a && a.tier === 'owner') return 'owner';
  return (await hasDev(store, lname)) ? 'dev' : null;
}

module.exports = { grantAdmin, grantDev, removeDev, hasDev, tagOf, normalizeCode, hashCode, table, configured, redeem, adminOf, revoke };
