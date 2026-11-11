'use strict';
// Admin actions: redeem (turn the signed-in account into an admin with a one-time code), status, kick, ban, unban, reset, flags, quarantine, unflag,
// revoke (owner) and wipeall (owner). There is no shared password: admins are ordinary accounts that redeemed a code from ADMIN_CODES (see lib/adminCodes.js),
// and every request is authorised by the caller's own session. Attempts are rate limited.
const { NAME_RE, send, readBody, handler, clientIp, allow, authUser, parseJSON } = require('../lib/util');
const { configured, redeem, adminOf, revoke, grantDev, removeDev } = require('../lib/adminCodes');

const ACTIONS = ['kick', 'ban', 'unban', 'reset', 'quarantine', 'unflag', 'revoke', 'devtag', 'undevtag'];
// wipeall deletes EVERY account, cloud save, session, moderation marker, leaderboard and the activity feed, except the calling owner's own account and sessions.
// It cannot be undone, so it needs an owner code and the exact confirmation phrase. Rate-limit counters (rl:*) and admin bindings (ac:*, adm:*) are left alone.
const WIPE_PHRASE = 'DELETE ALL ACCOUNTS';
const WIPE_PREFIXES = ['u:', 'p:', 'sv:', 's:', 'kick:', 'ban:', 'q:', 'strikes:', 'lb:', 'dev:'];
const BOARDS = ['lb:life', 'lb:peak', 'lb:inc', 'lb:asc', 'lb:book'];

// Deletes in batches and stops after ~7 s (the function limit is 10 s); the response says done:false until nothing is left, so just call it again.
async function wipeAll(store, keep) {
  const deadline = Date.now() + 7000;
  let deleted = 0;
  const doomed = async (prefix, keys) => {
    if (prefix === 'u:') return keys.filter((k) => k !== 'u:' + keep);
    if (prefix === 's:') { const vals = await store.mget(keys); return keys.filter((k, i) => !String(vals[i] || '').startsWith(keep + '|')); }
    return keys;
  };
  for (const prefix of WIPE_PREFIXES) {
    for (;;) {
      const keys = await store.keys(prefix, 500);
      if (!keys.length) break;
      const del = await doomed(prefix, keys);
      if (!del.length) break; // only the caller's own records are left
      await store.delMany(del);
      deleted += del.length;
      if (Date.now() > deadline) return { ok: true, action: 'wipeall', done: false, deleted };
    }
  }
  await store.del('feed');
  await store.del('flagfeed');
  return { ok: true, action: 'wipeall', done: true, deleted };
}

module.exports = handler(['POST'], async (req, res, store) => {
  if (!configured()) return send(res, 503, { error: 'Admin is not configured (ADMIN_CODES is not set).' });
  const ip = clientIp(req);
  if (!(await allow(store, 'admin-ip:' + ip, 60, 600))) return send(res, 429, { error: 'Too many requests. Wait a few minutes.' });
  const me = await authUser(req, store);
  if (!me) return send(res, 401, { error: 'Please sign in first.' });

  const b = await readBody(req);
  if (!b || typeof b !== 'object') return send(res, 422, { error: 'Invalid request.' });
  const action = b.action;

  if (action === 'redeem') {
    // Only wrong codes count toward the tight limits (per IP and per account), so a real admin is never locked out by normal use.
    const [fi, fu] = await Promise.all([store.get('rl:admin-fail:' + ip), store.get('rl:admin-fail-u:' + me)]);
    if ((+fi || 0) >= 5 || (+fu || 0) >= 5) return send(res, 429, { error: 'Too many wrong codes. Wait 15 minutes.' });
    const rec = parseJSON(await store.get('u:' + me));
    if (!rec) return send(res, 401, { error: 'Please sign in again.' });
    const r = await redeem(store, me, rec, b.code);
    if (!r.ok) {
      await Promise.all([allow(store, 'admin-fail:' + ip, 5, 900), allow(store, 'admin-fail-u:' + me, 5, 900)]);
      return send(res, 403, { error: r.reason === 'used' ? 'That code has already been used.' : 'That code is not valid.' });
    }
    return send(res, 200, { ok: true, action, admin: true, tier: r.tier });
  }

  const adm = await adminOf(store, me);
  if (action === 'status') return send(res, 200, { ok: true, action, admin: !!adm, tier: adm ? adm.tier : null });
  if (!adm) return send(res, 403, { error: 'This account is not an admin.' });

  if (action === 'wipeall') {
    if (adm.tier !== 'owner') return send(res, 403, { error: 'Only an owner code can wipe everything.' });
    if (b.confirm !== WIPE_PHRASE) return send(res, 422, { error: 'To delete every account, also send confirm: "' + WIPE_PHRASE + '".' });
    return send(res, 200, await wipeAll(store, me));
  }
  if (action === 'flags') {
    // The anti-cheat feed (newest first): which accounts sent impossible (hard) or suspicious (soft) numbers, and why.
    const raw = await store.lrange('flagfeed', 0, 99);
    const flags = raw.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
    const users = [...new Set(flags.map((f) => f.u))].slice(0, 50);
    const accounts = await Promise.all(users.map(async (u) => ({ u, quarantined: !!(await store.get('q:' + u)), strikes: +(await store.get('strikes:' + u)) || 0 })));
    return send(res, 200, { ok: true, action, flags, accounts });
  }

  const name = typeof b.username === 'string' ? b.username.trim() : '';
  if (!ACTIONS.includes(action) || !NAME_RE.test(name)) return send(res, 422, { error: 'Invalid request.' });
  const lname = name.toLowerCase();
  if (!(await store.get('u:' + lname))) return send(res, 404, { error: 'No such player.' });

  const tgt = await adminOf(store, lname);
  // DEV tags: only an owner may give or take them, for any player (staff included). The decision is made here from the caller's own admin record.
  if (action === 'devtag' || action === 'undevtag') {
    if (adm.tier !== 'owner') return send(res, 403, { error: 'Only an owner can give or remove DEV tags.' });
    if (action === 'devtag') await grantDev(store, lname, JSON.parse(await store.get('u:' + lname)));
    else await removeDev(store, lname);
    return send(res, 200, { ok: true, action, username: lname });
  }
  if (action === 'revoke') {
    if (adm.tier !== 'owner') return send(res, 403, { error: 'Only an owner can revoke an admin.' });
    if (lname === me) return send(res, 422, { error: 'You cannot revoke yourself.' });
    if (!tgt) return send(res, 404, { error: 'That player is not an admin.' });
    if (tgt.tier === 'owner') return send(res, 403, { error: 'Owner codes are revoked by removing them from ADMIN_CODES.' });
    await revoke(store, lname);
    return send(res, 200, { ok: true, action, username: lname });
  }
  // Admins cannot moderate each other (an owner may act on staff), so a leaked staff code cannot be used to knock out the owner.
  if (tgt && lname !== me && !(adm.tier === 'owner' && tgt.tier === 'staff')) return send(res, 403, { error: 'Admins cannot act on other admins.' });
  if (lname === me && (action === 'ban' || action === 'quarantine' || action === 'reset')) return send(res, 422, { error: 'Not on your own account.' });

  const removeFromBoards = () => Promise.all(BOARDS.map((k) => store.zrem(k, lname)));
  if (action === 'kick') {
    await store.set('kick:' + lname, Date.now()); // every session made up to now stops working; signing in again is allowed
  } else if (action === 'ban') {
    await Promise.all([store.set('ban:' + lname, '1'), store.set('kick:' + lname, Date.now()), removeFromBoards()]);
  } else if (action === 'unban') {
    await store.del('ban:' + lname);
  } else if (action === 'quarantine') {
    await Promise.all([store.set('q:' + lname, String(Date.now())), removeFromBoards()]); // hidden from the leaderboards, can still play and sync
  } else if (action === 'unflag') {
    await Promise.all([store.del('q:' + lname), store.del('strikes:' + lname)]); // back on the boards at their next sync
  } else if (action === 'reset') {
    await Promise.all([store.del('p:' + lname), store.del('sv:' + lname), store.del('q:' + lname), store.del('strikes:' + lname), store.set('kick:' + lname, Date.now()), removeFromBoards()]);
  }
  send(res, 200, { ok: true, action, username: lname });
});
