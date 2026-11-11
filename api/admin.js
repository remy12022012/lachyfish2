'use strict';
// Admin actions: kick, ban, unban, reset. Protected by the ADMIN_PASSWORD environment variable (set it in the Vercel
// project settings); the password is never stored in the page. Every request must send it, and attempts are rate limited.
const crypto = require('crypto');
const { NAME_RE, send, readBody, handler, clientIp, allow } = require('../lib/util');

const ACTIONS = ['kick', 'ban', 'unban', 'reset', 'wipeall'];
// wipeall deletes EVERY account, cloud save, session, moderation marker, leaderboard and the activity feed. It cannot be undone,
// so it needs the admin password and the exact confirmation phrase. Rate-limit counters (rl:*) are left alone.
const WIPE_PHRASE = 'DELETE ALL ACCOUNTS';
const WIPE_PREFIXES = ['u:', 'p:', 'sv:', 's:', 'kick:', 'ban:', 'lb:'];
const BOARDS = ['lb:peak', 'lb:inc', 'lb:asc', 'lb:book'];
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function passwordOk(given) {
  const want = process.env.ADMIN_PASSWORD;
  if (!want || typeof given !== 'string' || !given) return false;
  return crypto.timingSafeEqual(digest(given), digest(want)); // equal-length digests: constant time
}

// Deletes in batches and stops after ~7 s (the function limit is 10 s); the response says done:false until nothing is left, so just call it again.
async function wipeAll(store) {
  const deadline = Date.now() + 7000;
  let deleted = 0;
  for (const prefix of WIPE_PREFIXES) {
    for (;;) {
      const keys = await store.keys(prefix, 500);
      if (!keys.length) break;
      await store.delMany(keys);
      deleted += keys.length;
      if (Date.now() > deadline) return { ok: true, action: 'wipeall', done: false, deleted };
    }
  }
  await store.del('feed');
  return { ok: true, action: 'wipeall', done: true, deleted };
}

module.exports = handler(['POST'], async (req, res, store) => {
  if (!process.env.ADMIN_PASSWORD) return send(res, 503, { error: 'Admin is not configured (ADMIN_PASSWORD is not set).' });
  const ip = clientIp(req);
  if (!(await allow(store, 'admin-ip:' + ip, 60, 600))) return send(res, 429, { error: 'Too many requests. Wait a few minutes.' });

  const b = await readBody(req);
  if (!b || typeof b !== 'object') return send(res, 422, { error: 'Invalid request.' });
  if (!passwordOk(b.password)) {
    // Only wrong passwords count toward the tight limit, so a legitimate admin is never locked out by their own use.
    if (!(await allow(store, 'admin-fail:' + ip, 5, 900))) return send(res, 429, { error: 'Too many wrong passwords. Wait 15 minutes.' });
    return send(res, 403, { error: 'Wrong admin password.' });
  }

  const action = b.action;
  if (action === 'wipeall') {
    if (b.confirm !== WIPE_PHRASE) return send(res, 422, { error: 'To delete every account, also send confirm: "' + WIPE_PHRASE + '".' });
    return send(res, 200, await wipeAll(store));
  }
  const name = typeof b.username === 'string' ? b.username.trim() : '';
  if (!ACTIONS.includes(action) || !NAME_RE.test(name)) return send(res, 422, { error: 'Invalid request.' });
  const lname = name.toLowerCase();
  if (!(await store.get('u:' + lname))) return send(res, 404, { error: 'No such player.' });

  const removeFromBoards = () => Promise.all(BOARDS.map((k) => store.zrem(k, lname)));
  if (action === 'kick') {
    await store.set('kick:' + lname, Date.now()); // every session made up to now stops working; signing in again is allowed
  } else if (action === 'ban') {
    await Promise.all([store.set('ban:' + lname, '1'), store.set('kick:' + lname, Date.now()), removeFromBoards()]);
  } else if (action === 'unban') {
    await store.del('ban:' + lname);
  } else if (action === 'reset') {
    await Promise.all([store.del('p:' + lname), store.del('sv:' + lname), store.set('kick:' + lname, Date.now()), removeFromBoards()]);
  }
  send(res, 200, { ok: true, action, username: lname });
});
