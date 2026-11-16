'use strict';
const { SEASON, CLIENT_REV, MIN_ASC_MS, send, readBody, handler, authUser, allow, parseJSON, validateStats, validateSave } = require('../lib/util');
const { inspect, logFlag, addStrike } = require('../lib/cheat');
const { currentBuild } = require('../lib/build');
const { adminOf } = require('../lib/adminCodes');

const MAX_ASC_JUMP = 2; // ascensions gained between two syncs (each costs cash and wipes the run, so more than this in one sync is tampering)
const FEED_MIN_RAR = 5; // only Mythic and above make the activity feed
// lb:life ranks lifetime earnings (the default view), so a player keeps their place after ascending; lb:book ranks the best Book count ever reached.
const XPAND = require('../lib/expansion');
const BOARDS = ['lb:life', 'lb:peak', 'lb:inc', 'lb:asc', 'lb:book'];

module.exports = handler(['POST'], async (req, res, store) => {
  const lname = await authUser(req, store);
  if (!lname) return send(res, 401, { error: 'Please sign in again.' });
  if (!(await allow(store, 'submit:' + lname, 1, 5))) return send(res, 429, { error: 'Syncing too fast. Try again in a few seconds.' });

  const b = await readBody(req);
  if (b && typeof b === 'object' && (b.season !== SEASON || b.rev !== CLIENT_REV)) return send(res, 409, { error: 'The game was updated. Reload the page to keep playing online.', required: true, build: currentBuild() });
  const s = validateStats(b);
  if (!s) return send(res, 422, { error: 'Invalid stats.' });

  const [urec, prevRaw, quarantined] = await Promise.all([store.get('u:' + lname), store.get('p:' + lname), store.get('q:' + lname)]);
  const user = parseJSON(urec);
  if (!user) return send(res, 401, { error: 'Please sign in again.' });
  const prev = parseJSON(prevRaw);
  // Owners (decided here from the account's admin record, never from the request) may sync a maxed-out test state: they skip the
  // ascension jump, ascension timer and plausibility checks. Staff and everyone else are checked as usual.
  const adm = await adminOf(store, lname);
  const owner = !!adm && adm.tier === 'owner';
  // A brand-new account counts as 0 ascensions, so it cannot start with a high number either.
  const prevAsc = prev ? prev.asc : 0;
  if (!owner && s.asc > prevAsc + MAX_ASC_JUMP) return send(res, 422, { error: 'Invalid stats.' });

  const now = Date.now();
  // Real time must have passed for every ascension gained: counted from the last ascension (or from account creation).
  const lastAsc = prev ? (prev.ascAt || prev.created || now) : (user.created || now);
  if (!owner && s.asc > prevAsc && now - lastAsc < (s.asc - prevAsc) * MIN_ASC_MS) return send(res, 422, { error: 'Invalid stats.' });

  // The stats are only believable next to the save they came from, so a valid cloud save is required with every sync.
  if (s.save === null || !validateSave(s.save, s)) return send(res, 422, { error: 'Invalid save.' });
  // A face offered in a trade has left the player's hands: a save that still holds it (same ascension, so the same face id) is refused until it is gone.
  const trx = parseJSON(await store.get('trx:' + lname));
  if (Array.isArray(trx) && trx.length) {
    // Backpack faces count too: they keep their id (ids are shared by the Base and the backpack), so moving an offered face there must not hide it.
    const sv = parseJSON(s.save);
    const held = new Set(sv.faces.map((f) => f[0]));
    if (Array.isArray(sv.bp)) for (const f of sv.bp) if (Array.isArray(f)) held.add(f[0]);
    if (!owner && trx.some((e) => e && e.a === s.asc && held.has(e.i))) return send(res, 422, { error: 'A face you offered in a trade is still in your save. Reload the game and try again.' });
  }
  const verdict = inspect(s, parseJSON(s.save), prev, now);
  if (owner) { verdict.hard = []; verdict.soft = []; }
  if (verdict.hard.length || verdict.soft.length) {
    const hard = verdict.hard.length > 0;
    await logFlag(store, lname, hard ? 'hard' : 'soft', verdict.hard.concat(verdict.soft), now);
    if (hard) {
      // Impossible numbers count a strike; enough strikes quarantine the account (hidden from the leaderboards).
      const st = await addStrike(store, lname, now);
      if (st.quarantined) await Promise.all(BOARDS.map((k) => store.zrem(k, lname)));
      return send(res, 422, { error: 'Invalid stats.' });
    }
    return send(res, 422, { error: 'Your progress changed too fast for the server to verify. Wait a few minutes and sync again.' });
  }

  const asc = prev ? Math.max(prev.asc, s.asc) : s.asc;
  // Profiles from before lifetime ranking have no life or bookMax yet: they start from their peak money and their Book count.
  const prevLife = prev ? (Number.isFinite(prev.life) ? prev.life : prev.peak || 0) : 0;
  const prevBookMax = prev ? (Number.isFinite(prev.bookMax) ? prev.bookMax : prev.book || 0) : 0;
  const p = {
    name: user.name,
    peak: prev ? Math.max(prev.peak, s.coins) : s.coins,
    inc: prev ? Math.max(prev.inc, s.inc) : s.inc,
    asc,
    caught: prev ? Math.max(prev.caught, s.caught) : s.caught,
    book: s.book,
    life: Math.max(prevLife, s.life),
    bookMax: Math.max(prevBookMax, s.book),
    bestEver: prev ? Math.max(prev.bestEver, s.bestRar) : s.bestRar,
    bestMut: prev ? Math.max(prev.bestMut, s.bestMut) : s.bestMut,
    top: s.top.length ? s.top : (prev ? prev.top : []),
    cps: s.cps,
    // The equipped expansion title (display name). The id was already bounds-checked inside the save by validateX, and a Book title needs its goal claimed.
    ttl: (() => { const sv = parseJSON(s.save); return sv && sv.G && sv.G.x ? XPAND.titleName(sv.G.x.ttl) : ''; })(),
    ascAt: asc > prevAsc ? now : (prev && prev.ascAt) || 0,
    created: prev ? prev.created : user.created || now,
    // What the last accepted sync looked like: the next sync's growth checks compare against these.
    rc: s.coins,
    incLast: s.inc,
    gems: verdict.gems,
    t: now,
  };

  const peakUp = !prev || p.life > prevLife;
  const rankBefore = peakUp && !quarantined ? await store.zrevrank('lb:life', lname) : null;

  const writes = [
    store.set('p:' + lname, JSON.stringify(p)),
    store.set('sv:' + lname, s.save),
  ];
  if (quarantined) {
    // Quarantined accounts keep playing and syncing as normal, but never appear on a leaderboard.
    for (const k of BOARDS) writes.push(store.zrem(k, lname));
  } else {
    writes.push(
      store.zadd('lb:life', p.life, lname),
      store.zadd('lb:peak', p.peak, lname),
      store.zadd('lb:inc', p.inc, lname),
      store.zadd('lb:asc', p.asc * 1000 + p.book, lname),
      store.zadd('lb:book', p.bookMax * 10000 + p.asc, lname),
    );
    // Crew competition (owner preview): a board per tournament window ranked by the validated income rate. Only written while the preview flag is on.
    if (await store.get('cfg:expansion')) {
      const tw = XPAND.tourneyWindow(now), tk = 'tc:' + tw;
      writes.push(store.zadd(tk, p.inc, lname), store.expire(tk, XPAND.TOURNEY_KEEP_S + Math.ceil(XPAND.TOURNEY_MS / 1000)));
    }
  }
  // The save was accepted and no longer holds an offered face, so the record of offered faces can go.
  if (Array.isArray(trx) && trx.length) writes.push(store.del('trx:' + lname));
  await Promise.all(writes);

  const [rk, total] = await Promise.all([store.zrevrank('lb:life', lname), store.zcard('lb:life')]);

  // Activity feed (best effort: never fails the sync).
  if (!quarantined) {
    try {
      const ev = [];
      if (prev && p.asc > prev.asc) ev.push({ k: 'asc', v: p.asc, n: p.name, t: now });
      if (prev && p.bestEver > prev.bestEver && p.bestEver >= FEED_MIN_RAR) {
        const m = p.top.length && p.top[0][0] === p.bestEver ? p.top[0][1] : 0;
        ev.push({ k: 'rar', v: p.bestEver, m, n: p.name, t: now });
      }
      if (peakUp && rk === 0 && rankBefore !== 0 && total > 1) ev.push({ k: 'top1', n: p.name, t: now });
      for (const e of ev) await store.lpush('feed', JSON.stringify(e));
      if (ev.length) await store.ltrim('feed', 0, 49);
    } catch (e) { console.error('feed', e); }
  }

  send(res, 200, { ok: true, rank: rk === null ? 0 : rk + 1, total: total || 0, build: currentBuild() });
});
