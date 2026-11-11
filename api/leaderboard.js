'use strict';
const { NAME_RE, send, handler, authUser, parseJSON, queryOf } = require('../lib/util');
const { adminOf } = require('../lib/adminCodes');

// life: lifetime earnings across every ascension (the default, so players keep their place after ascending); peak: most money held at once;
// inc: best income per second; asc: ascensions; book: the best Book count ever reached.
const VIEWS = ['life', 'peak', 'inc', 'asc', 'book'];

// life and bookMax are missing on profiles saved before lifetime ranking; they fall back to the older stats until the next sync.
function pub(p, dev) {
  const o = {
    name: p.name, peak: p.peak, inc: p.inc, asc: p.asc, caught: p.caught, book: p.book,
    life: Number.isFinite(p.life) ? p.life : p.peak,
    bookMax: Number.isFinite(p.bookMax) ? p.bookMax : p.book,
    bestEver: p.bestEver, bestMut: p.bestMut, top: p.top, cps: p.cps, created: p.created, t: p.t,
  };
  if (dev) o.dev = dev; // 'owner' or 'staff': shown as a DEV tag next to the name
  return o;
}

// Which of these accounts are admins. One batched read of the admin bindings, then the full check (is the code still valid?) only for accounts that have one.
async function devTags(store, lnames) {
  const out = new Map();
  if (!lnames.length) return out;
  const recs = await store.mget(lnames.map((m) => 'adm:' + m));
  await Promise.all(lnames.map(async (m, i) => {
    if (!recs[i]) return;
    const a = await adminOf(store, m);
    if (a) out.set(m, a.tier);
  }));
  return out;
}

module.exports = handler(['GET'], async (req, res, store) => {
  const q = queryOf(req);

  // Profile: /api/leaderboard?u=name
  const u = q.get('u');
  if (u !== null) {
    if (!NAME_RE.test(u)) return send(res, 404, { error: 'Not found.' });
    const lname = u.toLowerCase();
    const [raw, rk, adm] = await Promise.all([store.get('p:' + lname), store.zrevrank('lb:life', lname), adminOf(store, lname)]);
    const p = parseJSON(raw);
    if (!p) return send(res, 404, { error: 'Not found.' });
    return send(res, 200, { profile: pub(p, adm ? adm.tier : null), rank: rk === null ? 0 : rk + 1 });
  }

  // List: /api/leaderboard?n=50&feed=1&view=life
  const view = VIEWS.includes(q.get('view')) ? q.get('view') : 'life';
  const n = Math.max(1, Math.min(100, parseInt(q.get('n'), 10) || 50));
  const key = 'lb:' + view;
  const me = await authUser(req, store); // optional: a stale token just means anonymous
  const [members, total, myRank, feedRaw] = await Promise.all([
    store.zrevrange(key, 0, n - 1),
    store.zcard(key),
    me ? store.zrevrank(key, me) : null,
    q.get('feed') === '1' ? store.lrange('feed', 0, 19) : null,
  ]);
  const raws = members.length ? await store.mget(members.map((m) => 'p:' + m)) : [];
  const tags = await devTags(store, members);
  const rows = [];
  raws.forEach((r, i) => { const p = parseJSON(r); if (p) rows.push(pub(p, tags.get(members[i]) || null)); });
  const out = { rows, total: total || 0, me: me ? { rank: myRank === null ? 0 : myRank + 1 } : null };
  if (feedRaw) out.feed = feedRaw.map(parseJSON).filter(Boolean);
  send(res, 200, out);
});
