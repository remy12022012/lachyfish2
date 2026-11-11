'use strict';
// Player-to-player trading. One face for one face, with any player, by invitation.
//
// The server only brokers the trade. A client's next sync would overwrite any change made to its stored save, so the swap itself is applied by the
// clients: when a player offers a face the server checks it against their last synced save and keeps it in escrow (the client removes it locally);
// when the trade completes or ends, each player's face is put in their delivery box (trbox:<name>) and the client adds it and then claims it.
//
// Keys: tr:<id> the trade record, trc:<name> the trade a player is currently in, trbox:<name> faces waiting to be delivered,
//       trl:<id> a short lock so two requests cannot change one trade at the same time.
const crypto = require('crypto');
const { NAME_RE, maxRarFor, send, readBody, handler, authUser, allow, parseJSON } = require('../lib/util');

const TTL = 3600; // seconds a trade record is kept
const INVITE_MS = 2 * 60 * 1000; // an unanswered invite expires after 2 minutes
const ACTIVE_MS = 20 * 60 * 1000; // an open trade with no activity expires after 20 minutes
const BOX_MAX = 30;
const FRESH_MS = 3 * 60 * 1000; // the stored save must come from a sync this recent before a face can be offered
const ID_RE = /^[a-f0-9]{16}$/;
const rid = (n) => crypto.randomBytes(n).toString('hex');
const live = (t) => t.s === 'invited' || t.s === 'active';
const expired = (t) => (t.s === 'invited' && Date.now() - t.ts > INVITE_MS) || (t.s === 'active' && Date.now() - t.ts > ACTIVE_MS);

async function load(store, id) { return typeof id === 'string' && ID_RE.test(id) ? parseJSON(await store.get('tr:' + id)) : null; }
async function put(store, t) { await store.set('tr:' + t.id, JSON.stringify(t), { ex: TTL }); }
async function boxAdd(store, lname, d) {
  const k = 'trbox:' + lname;
  const cur = parseJSON(await store.get(k)) || [];
  cur.push(d);
  await store.set(k, JSON.stringify(cur.slice(-BOX_MAX)), { ex: 7 * 86400 });
}
async function locked(store, id, fn) {
  const k = 'trl:' + id;
  if (!(await store.set(k, '1', { nx: true, ex: 5 }))) return null;
  try { return await fn(); } finally { await store.del(k); }
}
async function ascOf(store, lname) { const p = parseJSON(await store.get('p:' + lname)); return p && Number.isInteger(p.asc) ? p.asc : 0; }

// Ends a trade: any face still in escrow goes back to its owner's delivery box.
async function finish(store, t, s) {
  for (const side of ['a', 'b']) {
    const o = t['o' + side];
    if (o) await boxAdd(store, t[side], { d: rid(6), t: t.id, why: 'return', f: o.f });
    t['o' + side] = null;
  }
  t.s = s; t.ts = Date.now(); t.ca = false; t.cb = false;
  await put(store, t);
  return t;
}
async function expireIfNeeded(store, t) {
  if (!live(t) || !expired(t)) return t;
  const r = await locked(store, t.id, async () => {
    const f = await load(store, t.id);
    return f && live(f) && expired(f) ? finish(store, f, 'expired') : f;
  });
  return r || t;
}

function view(t, me) {
  const mine = t.a === me ? 'a' : 'b', th = mine === 'a' ? 'b' : 'a';
  return {
    id: t.id, s: t.s, inviter: t.a === me, partner: mine === 'a' ? t.bn : t.an,
    mine: t['o' + mine] ? t['o' + mine].f : null, theirs: t['o' + th] ? t['o' + th].f : null,
    myConf: !!t['c' + mine], theirConf: !!t['c' + th], v: t.v, ts: t.ts,
  };
}
async function state(store, me) {
  const [cur, box] = await Promise.all([store.get('trc:' + me), store.get('trbox:' + me)]);
  let t = await load(store, cur);
  if (t && t.a !== me && t.b !== me) t = null;
  if (t) t = await expireIfNeeded(store, t);
  else if (cur) await store.del('trc:' + me);
  return { trade: t ? view(t, me) : null, box: parseJSON(box) || [] };
}
// The face with this id in the player's last synced save, with the ascension count that save was made at (face ids restart after an ascension).
async function findFace(store, lname, fid) {
  const o = parseJSON(await store.get('sv:' + lname));
  if (!o || !Array.isArray(o.faces) || !o.G) return null;
  const f = o.faces.find((x) => Array.isArray(x) && x[0] === fid);
  return f ? { f, asc: o.G.asc | 0 } : null;
}
async function busy(store, lname) {
  const t = await load(store, await store.get('trc:' + lname));
  if (!t || (t.a !== lname && t.b !== lname)) return false;
  const f = await expireIfNeeded(store, t);
  return live(f);
}

// Everything that changes an existing trade. Runs under the trade's lock.
async function act(store, me, id, b) {
  const t = await load(store, id);
  if (!t || (t.a !== me && t.b !== me)) return { code: 404, error: 'No trade found.' };
  const mine = t.a === me ? 'a' : 'b', th = mine === 'a' ? 'b' : 'a', other = t[th];
  const a = b.action;
  if (a === 'ack') { if (!live(t)) await store.del('trc:' + me); return {}; }
  if (!live(t)) return { code: 409, error: 'This trade is over.' };
  if (expired(t)) { await finish(store, t, 'expired'); return { code: 409, error: 'This trade timed out.' }; }
  if (a === 'cancel') { await finish(store, t, 'cancelled'); return {}; }
  if (t.s === 'invited') {
    if (a === 'accept' && mine === 'b') { t.s = 'active'; t.ts = Date.now(); await put(store, t); return {}; }
    if (a === 'decline' && mine === 'b') { await finish(store, t, 'declined'); return {}; }
    return { code: 409, error: 'Waiting for them to accept.' };
  }
  if (a === 'offer') {
    if (b.fid === null) {
      if (t['o' + mine]) await boxAdd(store, me, { d: rid(6), t: t.id, why: 'return', f: t['o' + mine].f });
      t['o' + mine] = null;
    } else {
      const fid = b.fid;
      if (!Number.isInteger(fid) || fid < 0) return { code: 400, error: 'Pick a face to offer.' };
      if (t['u' + mine].includes(fid)) return { code: 409, error: 'That face was already used in this trade.' };
      // The save the server holds must be recent, so a face sold a while ago cannot still be offered from an old copy.
      const prof = parseJSON(await store.get('p:' + me));
      if (!prof || Date.now() - prof.t > FRESH_MS) return { code: 409, error: 'Syncing your game first...', sync: true, stale: true };
      const found = await findFace(store, me, fid);
      if (!found) return { code: 409, error: 'That face is not in your last synced save. Sync and try again.', sync: true };
      const sf = found.f;
      if (sf[4] || sf[5] || sf[7]) return { code: 409, error: 'Crew, Farm and locked faces cannot be traded. Take it off the crew or farm, or unlock it, then try again.', sync: true };
      const trx = parseJSON(await store.get('trx:' + me)) || [];
      if (trx.some((e) => e.i === fid && e.a === found.asc)) return { code: 409, error: 'That face is already in a trade.', sync: true };
      const r = sf[1], m = sf[2], l = sf[3];
      if (!Array.isArray(b.face) || b.face[0] !== r || b.face[1] !== m || b.face[2] !== l) return { code: 409, error: 'Your save is out of date. Sync and try again.', sync: true };
      if (r > maxRarFor(await ascOf(store, other))) return { code: 422, error: 'They have not ascended far enough to receive a face that rare.' };
      if (t['o' + mine]) await boxAdd(store, me, { d: rid(6), t: t.id, why: 'return', f: t['o' + mine].f });
      t['o' + mine] = { f: [r, m, l, Math.max(0, Math.floor(+sf[6]) || 0)] };
      t['u' + mine].push(fid);
      // Until a sync arrives without this face, saves that still hold it are refused (see api/submit.js), so it cannot be kept and traded.
      trx.push({ i: fid, a: found.asc });
      await store.set('trx:' + me, JSON.stringify(trx.slice(-40)), { ex: 7 * 86400 });
    }
    t.ca = false; t.cb = false; t.v++; t.ts = Date.now();
    await put(store, t);
    return {};
  }
  if (a === 'unconfirm') { t['c' + mine] = false; t.v++; t.ts = Date.now(); await put(store, t); return {}; }
  if (a === 'confirm') {
    if (!t.oa || !t.ob) return { code: 409, error: 'Both players must offer a face first.' };
    if (b.v !== t.v) return { code: 409, error: 'The offer changed. Check it again.' };
    t['c' + mine] = true; t.ts = Date.now();
    if (!(t.ca && t.cb)) { await put(store, t); return {}; }
    // Both confirmed: each side must still be able to hold what it gets, then the faces swap through the delivery boxes.
    const [aa, ab] = await Promise.all([ascOf(store, t.a), ascOf(store, t.b)]);
    if (t.ob.f[0] > maxRarFor(aa) || t.oa.f[0] > maxRarFor(ab)) { await finish(store, t, 'failed'); return { code: 422, error: 'A player can no longer receive that face, so the trade was cancelled and the faces returned.' }; }
    await boxAdd(store, t.a, { d: rid(6), t: t.id, why: 'trade', f: t.ob.f, from: t.bn });
    await boxAdd(store, t.b, { d: rid(6), t: t.id, why: 'trade', f: t.oa.f, from: t.an });
    t.s = 'done'; t.v++;
    await put(store, t);
    return {};
  }
  return { code: 400, error: 'Unknown action.' };
}

module.exports = handler(['GET', 'POST'], async (req, res, store) => {
  const me = await authUser(req, store);
  if (!me) return send(res, 401, { error: 'Please sign in again.' });
  if (!(await allow(store, 'trade:' + me, 90, 60))) return send(res, 429, { error: 'Too many requests. Slow down a little.' });
  if (req.method === 'GET') return send(res, 200, await state(store, me));

  const b = await readBody(req);
  if (!b || typeof b !== 'object' || typeof b.action !== 'string') return send(res, 400, { error: 'Bad request.' });

  if (b.action === 'invite') {
    const un = String(b.username || '').trim();
    if (!NAME_RE.test(un)) return send(res, 400, { error: 'Enter a valid player name.' });
    const them = un.toLowerCase();
    if (them === me) return send(res, 400, { error: 'You cannot trade with yourself.' });
    if (!(await allow(store, 'tinv:' + me, 8, 60))) return send(res, 429, { error: 'Too many invites. Wait a minute.' });
    const [ur, mr, banned, blocked] = await Promise.all([store.get('u:' + them), store.get('u:' + me), store.get('ban:' + them), store.get('trp:' + them)]);
    const urec = parseJSON(ur), mrec = parseJSON(mr);
    if (!urec || !mrec || banned) return send(res, 404, { error: 'No player with that name.' });
    if (blocked) return send(res, 403, { error: urec.name + ' is not accepting trade invites.' });
    if (await busy(store, me)) return send(res, 409, { error: 'Finish or cancel your current trade first.' });
    if (await busy(store, them)) return send(res, 409, { error: 'That player is busy in another trade.' });
    const t = { id: rid(8), a: me, b: them, an: mrec.name, bn: urec.name, s: 'invited', oa: null, ob: null, ca: false, cb: false, v: 1, ua: [], ub: [], ts: Date.now() };
    await put(store, t);
    await Promise.all([store.set('trc:' + me, t.id, { ex: TTL }), store.set('trc:' + them, t.id, { ex: TTL })]);
    return send(res, 200, await state(store, me));
  }

  if (b.action === 'prefs') {
    if (b.block) {
      await store.set('trp:' + me, '1');
      // An invite that is already waiting for this player is declined, so blocking takes effect at once.
      const cur = await load(store, await store.get('trc:' + me));
      if (cur && cur.s === 'invited' && cur.b === me) {
        await locked(store, cur.id, async () => {
          const f = await load(store, cur.id);
          if (f && f.s === 'invited' && f.b === me) await finish(store, f, 'declined');
        });
      }
    } else await store.del('trp:' + me);
    return send(res, 200, await state(store, me));
  }

  if (b.action === 'claim') {
    const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string').slice(0, BOX_MAX) : [];
    if (ids.length) {
      const k = 'trbox:' + me;
      const cur = (parseJSON(await store.get(k)) || []).filter((d) => !ids.includes(d.d));
      if (cur.length) await store.set(k, JSON.stringify(cur), { ex: 7 * 86400 }); else await store.del(k);
    }
    return send(res, 200, await state(store, me));
  }

  const id = await store.get('trc:' + me);
  if (!id) return send(res, 404, { error: 'You are not in a trade.' });
  const out = await locked(store, id, () => act(store, me, id, b));
  if (out === null) return send(res, 429, { error: 'The trade is busy. Try again.' });
  if (out.error) return send(res, out.code || 400, { error: out.error, sync: !!out.sync, stale: !!out.stale });
  send(res, 200, await state(store, me));
});
