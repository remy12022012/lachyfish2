'use strict';
// Expansion endpoint (owner preview): tournaments. Everything here is invisible (404) unless the caller is an owner AND the
// cfg:expansion flag is on, exactly like the flag /api/me reports. Scores are kept on the server; a save only records claimed windows.
const { send, readBody, handler, authUser, allow, parseJSON, queryOf } = require('../lib/util');
const { adminOf } = require('../lib/adminCodes');
const X = require('../lib/expansion');

const TOP_N = 20;
const keyBoard = (w) => 'tn:' + w; // sorted set: member = lowercase name, score = points
const keyScore = (w, n) => 'tns:' + w + ':' + n; // the player's points, read back with mget (sorted sets return members only)
const keyClaim = (w, n) => 'tnc:' + w + ':' + n; // claim marker, set once

async function gate(req, res, store) {
  const lname = await authUser(req, store);
  if (!lname) { send(res, 401, { error: 'Please sign in again.' }); return null; }
  const [flag, adm] = await Promise.all([store.get('cfg:expansion'), adminOf(store, lname)]);
  if (!(flag && adm && adm.tier === 'owner')) { send(res, 404, { error: 'Not found.' }); return null; }
  return lname;
}

async function board(store, w, me) {
  const key = keyBoard(w);
  const [members, total, myRank, myRaw] = await Promise.all([
    store.zrevrange(key, 0, TOP_N - 1), store.zcard(key),
    me ? store.zrevrank(key, me) : null,
    me ? store.get(keyScore(w, me)) : null,
  ]);
  const raws = members.length ? await store.mget(members.map((m) => keyScore(w, m))) : [];
  const profs = members.length ? await store.mget(members.map((m) => 'p:' + m)) : [];
  const rows = members.map((m, i) => {
    const p = parseJSON(profs[i]);
    return { name: p && p.name ? p.name : m, pts: Math.max(0, +raws[i] || 0) };
  });
  return { rows, total: total || 0, me: me ? { rank: myRank === null ? 0 : myRank + 1, pts: Math.max(0, +myRaw || 0) } : null };
}

module.exports = handler(['GET', 'POST'], async (req, res, store) => {
  const lname = await gate(req, res, store);
  if (!lname) return;
  const now = Date.now(), cur = X.tourneyWindow(now);

  if (req.method === 'GET') {
    const q = queryOf(req);
    const act = q.get('a');
    if (act !== 'tourney' && act !== 'crew') return send(res, 404, { error: 'Not found.' });
    if (!(await allow(store, 'xget:' + lname, 20, 10))) return send(res, 429, { error: 'Too many requests. Try again in a few seconds.' });
    if (act === 'crew') {
      // Crew competition: the best income rate synced during this window (written by api/submit.js while the preview flag is on).
      const key = 'tc:' + cur;
      const [members, total, myRank] = await Promise.all([store.zrevrange(key, 0, 9), store.zcard(key), store.zrevrank(key, lname)]);
      const profs = members.length ? await store.mget(members.map((m) => 'p:' + m)) : [];
      const mine = parseJSON(await store.get('p:' + lname));
      const rows = members.map((m, i) => {
        const p = parseJSON(profs[i]);
        return { name: p && p.name ? p.name : m, inc: Math.max(0, +(p && p.inc) || 0) };
      });
      return send(res, 200, {
        now, w: cur, start: cur * X.TOURNEY_MS, end: (cur + 1) * X.TOURNEY_MS, rows, total: total || 0,
        me: { rank: myRank === null ? 0 : myRank + 1, inc: Math.max(0, +(mine && mine.inc) || 0) },
      });
    }
    const b = await board(store, cur, lname);
    // Finished windows this player can still claim: they scored, the board has not expired and no claim marker exists.
    const ws = [];
    for (let w = cur - 1; w >= Math.max(0, cur - X.TOURNEY_CLAIM_WINDOWS); w--) ws.push(w);
    const [ranks, marks, raws] = await Promise.all([
      Promise.all(ws.map((w) => store.zrevrank(keyBoard(w), lname))),
      store.mget(ws.map((w) => keyClaim(w, lname))),
      store.mget(ws.map((w) => keyScore(w, lname))),
    ]);
    const claim = [];
    ws.forEach((w, i) => {
      if (ranks[i] === null || marks[i]) return;
      const rank = ranks[i] + 1;
      claim.push({ w, cat: X.tourneyCat(w).id, rank, pts: Math.max(0, +raws[i] || 0), reward: X.tourneyReward(rank).n });
    });
    return send(res, 200, {
      now, w: cur, cat: X.tourneyCat(cur).id, start: cur * X.TOURNEY_MS, end: (cur + 1) * X.TOURNEY_MS,
      rows: b.rows, total: b.total, me: b.me, claim,
    });
  }

  const body = await readBody(req);
  if (!body || typeof body !== 'object') return send(res, 422, { error: 'Invalid request.' });

  if (body.a === 'score') {
    if (!(await allow(store, 'xscore:' + lname, 1, 5))) return send(res, 429, { error: 'Syncing too fast.' });
    const pts = body.pts;
    if (!Number.isInteger(pts) || pts < 1 || pts > X.TOURNEY_PTS_MAX) return send(res, 422, { error: 'Invalid points.' });
    if (await store.get('q:' + lname)) return send(res, 200, { w: cur, pts: 0 }); // quarantined accounts keep playing but never rank
    const have = Math.max(0, +(await store.get(keyScore(cur, lname))) || 0);
    const next = Math.min(X.TOURNEY_WIN_MAX, have + pts);
    const ttl = X.TOURNEY_KEEP_S + Math.ceil(X.TOURNEY_MS / 1000);
    await Promise.all([store.set(keyScore(cur, lname), String(next), { ex: ttl }), store.zadd(keyBoard(cur), next, lname)]);
    await store.expire(keyBoard(cur), ttl);
    const rank = await store.zrevrank(keyBoard(cur), lname);
    return send(res, 200, { w: cur, pts: next, rank: rank === null ? 0 : rank + 1 });
  }

  if (body.a === 'claim') {
    if (!(await allow(store, 'xclaim:' + lname, 3, 10))) return send(res, 429, { error: 'Too many requests.' });
    const w = body.w;
    if (!Number.isInteger(w) || w >= cur || w < cur - X.TOURNEY_CLAIM_WINDOWS) return send(res, 422, { error: 'That tournament cannot be claimed.' });
    const rank0 = await store.zrevrank(keyBoard(w), lname);
    if (rank0 === null) return send(res, 422, { error: 'You did not score in that tournament.' });
    // The marker is set first and only once, so a double click or a second device can never pay out twice.
    const ok = await store.set(keyClaim(w, lname), '1', { nx: true, ex: X.TOURNEY_KEEP_S * 4 });
    if (!ok) return send(res, 409, { error: 'Already claimed.' });
    const r = X.tourneyReward(rank0 + 1);
    return send(res, 200, { w, rank: rank0 + 1, reward: r.n, mat: r.mat });
  }

  return send(res, 404, { error: 'Not found.' });
});
