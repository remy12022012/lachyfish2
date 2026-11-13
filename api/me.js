'use strict';
const { send, handler, authUser, parseJSON } = require('../lib/util');
const { adminOf } = require('../lib/adminCodes');

module.exports = handler(['GET'], async (req, res, store) => {
  const lname = await authUser(req, store);
  if (!lname) return send(res, 401, { error: 'Please sign in again.' });
  const [u, save, rk, total, flag, adm] = await Promise.all([
    store.get('u:' + lname), store.get('sv:' + lname), store.zrevrank('lb:life', lname), store.zcard('lb:life'),
    store.get('cfg:expansion'), adminOf(store, lname),
  ]);
  const rec = parseJSON(u);
  if (!rec) return send(res, 401, { error: 'Please sign in again.' });
  // now: server time in ms, so the client can correct its clock for the global event schedule (lib/expansion.js).
  // expansion: the preview flag (owner-only admin action). Only owners ever receive true, so regular players never see the new systems.
  send(res, 200, {
    name: rec.name, rank: rk === null ? 0 : rk + 1, total: total || 0, save: save || null,
    now: Date.now(), expansion: !!(flag && adm && adm.tier === 'owner'),
  });
});
