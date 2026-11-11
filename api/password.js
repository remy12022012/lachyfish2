'use strict';
const { send, readBody, handler, authUser, checkPassword, hashPassword, newSession, clientIp, allow, parseJSON } = require('../lib/util');

// Change the signed-in player's password. The old password is required, attempts are rate limited, every other session is
// ended (a "kick" marker, the same mechanism the admin kick uses) and a fresh token is returned for this device.
module.exports = handler(['POST'], async (req, res, store) => {
  const lname = await authUser(req, store);
  if (!lname) return send(res, 401, { error: 'Please sign in again.' });
  const ip = clientIp(req);
  if (!(await allow(store, 'pw:' + lname, 5, 900)) || !(await allow(store, 'pw-ip:' + ip, 20, 900))) {
    return send(res, 429, { error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const b = await readBody(req);
  const oldPw = b && typeof b.oldPassword === 'string' ? b.oldPassword : '';
  const newPw = b && typeof b.newPassword === 'string' ? b.newPassword : '';
  if (!oldPw || oldPw.length > 72) return send(res, 403, { error: 'Your current password is wrong.' });
  if (newPw.length < 6 || newPw.length > 72) return send(res, 422, { error: 'The new password must be 6 to 72 characters.' });
  if (newPw === oldPw) return send(res, 422, { error: 'The new password must be different from the old one.' });

  const rec = parseJSON(await store.get('u:' + lname));
  if (!rec) return send(res, 401, { error: 'Please sign in again.' });
  // 403, not 401: the client signs the player out on any 401.
  if (!(await checkPassword(oldPw, rec))) return send(res, 403, { error: 'Your current password is wrong.' });

  const h = await hashPassword(newPw);
  const now = Date.now();
  const oldKick = +(await store.get('kick:' + lname)) || 0;
  await store.set('u:' + lname, JSON.stringify({ ...rec, salt: h.salt, hash: h.hash, pwAt: now }));
  await store.set('kick:' + lname, Math.max(oldKick, now)); // every session made up to now stops working
  const token = await newSession(store, lname, Math.max(oldKick, now) + 1); // this device keeps playing on a new one
  send(res, 200, { ok: true, token });
});
