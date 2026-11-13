'use strict';
// Live chat room: one public room for every signed-in player (no private chats).
//
// Vercel functions cannot hold a connection open, so the page polls GET /api/chat?after=<last id seen>.
// Keeping it light:
//  - the room is a short rolling list (KEEP messages), and the whole room expires after a day with no messages;
//  - a warm function instance keeps the room in memory for CACHE_MS, so many players polling at once cost one Redis read, not one each;
//  - the poll rate limit lives in memory, not in Redis.
//
// Keys: chat:log the newest KEEP messages (JSON strings, newest first), chat:seq the id of the newest message,
//       chatd:<name> the player's last message (blocks repeats, 30 s), mute:<name> present while the player is muted (see lib/mute.js).
// Admins (see lib/adminCodes.js) can mute and unmute players (also from the owner panel, api/admin.js) and clear the room.
const { NAME_RE, send, readBody, handler, authUser, allow, parseJSON, queryOf } = require('../lib/util');
const { adminOf, tagOf } = require('../lib/adminCodes');
const { MUTE_MAX, span, setMute, muteLeft } = require('../lib/mute');

const LOG = 'chat:log';
const SEQ = 'chat:seq';
const KEEP = 60; // messages kept in the room
const FIRST = 40; // messages sent to a player who just opened the chat
const MAX_LEN = 200;
const TTL = 86400; // seconds: an untouched room disappears after a day
const CACHE_MS = 1500;

// One line of plain text: control characters and bidi overrides become spaces, runs of whitespace collapse.
function clean(t) {
  if (typeof t !== 'string') return '';
  return t.replace(/[\u0000-\u001f\u007f\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
}

// Per-instance limiter for polls (cheap: no Redis commands).
const hits = new Map();
function quick(key, max, secs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.r < now) { if (hits.size > 5000) hits.clear(); h = { n: 0, r: now + secs * 1000 }; hits.set(key, h); }
  return ++h.n <= max;
}

// The room as {seq, rows (oldest first)}, reused for CACHE_MS. Any write on this instance drops it.
let room = null;
async function loadRoom(store) {
  const now = Date.now();
  if (room && room.store === store && now - room.t < CACHE_MS) return room;
  const seq = +(await store.get(SEQ)) || 0;
  if (room && room.store === store && room.seq === seq) { room.t = now; return room; } // nothing new: keep the parsed rows
  const rows = seq ? (await store.lrange(LOG, 0, KEEP - 1)).map(parseJSON).filter(Boolean).reverse() : [];
  room = { store, t: now, seq, rows };
  return room;
}

async function admin(store, me, res) {
  if (await adminOf(store, me)) return true;
  send(res, 403, { error: 'Only admins can do that.' });
  return false;
}

module.exports = handler(['GET', 'POST'], async (req, res, store) => {
  const me = await authUser(req, store);
  if (!me) return send(res, 401, { error: 'Sign in to use the chat.' });

  if (req.method === 'GET') {
    if (!quick(me, 60, 60)) return send(res, 429, { error: 'Too many requests. Slow down a little.' });
    const r = await loadRoom(store);
    let after = parseInt(queryOf(req).get('after'), 10);
    if (!Number.isInteger(after) || after < 0 || after > r.seq) after = 0; // an id from a room that has since been reset starts over
    if (after === r.seq) return send(res, 200, { seq: r.seq, msgs: [] });
    const rows = r.rows.filter((m) => m.i > after);
    return send(res, 200, { seq: r.seq, msgs: after === 0 ? rows.slice(-FIRST) : rows });
  }

  if (!(await allow(store, 'chat:' + me, 6, 15))) return send(res, 429, { error: 'You are sending too fast. Wait a few seconds.' });
  const b = await readBody(req);
  if (!b || typeof b !== 'object') return send(res, 400, { error: 'Bad request.' });

  // ---- moderation ----
  if (b.clear === true) {
    if (!(await admin(store, me, res))) return;
    await Promise.all([store.del(LOG), store.del(SEQ)]); // a lower seq than the clients hold makes them drop what they show
    room = null;
    return send(res, 200, { ok: true, note: 'Chat cleared.' });
  }
  if (b.mute !== undefined) {
    if (!(await admin(store, me, res))) return;
    const name = String(b.mute).trim();
    if (!NAME_RE.test(name)) return send(res, 400, { error: 'Not a valid username.' });
    const lname = name.toLowerCase();
    const mins = Number.isInteger(b.mins) ? Math.max(0, Math.min(MUTE_MAX, b.mins)) : 10;
    if (!(await store.get('u:' + lname))) return send(res, 404, { error: 'No player with that name.' });
    if (await adminOf(store, lname)) return send(res, 403, { error: 'Admins cannot be muted.' });
    await setMute(store, lname, mins);
    return send(res, 200, { ok: true, note: mins === 0 ? name + ' can chat again.' : name + ' is muted for ' + span(mins) + '.' });
  }

  // ---- a normal message ----
  const text = clean(b.text);
  if (!text) return send(res, 400, { error: 'Type a message first.' });
  const left = await muteLeft(store, me);
  if (left) return send(res, 403, { error: 'You are muted for ' + span(left) + ' more.' });
  if ((await store.get('chatd:' + me)) === text) return send(res, 429, { error: 'You just said that.' });
  await store.set('chatd:' + me, text, { ex: 30 });

  const [urec, tag] = await Promise.all([store.get('u:' + me), tagOf(store, me)]);
  const user = parseJSON(urec);
  const msg = { i: await store.incr(SEQ), n: (user && user.name) || me, t: text, ts: Date.now() };
  if (tag) msg.d = tag;
  await store.lpush(LOG, JSON.stringify(msg));
  await Promise.all([store.ltrim(LOG, 0, KEEP - 1), store.expire(LOG, TTL), store.expire(SEQ, TTL)]);
  room = null;
  send(res, 200, { ok: true, msg });
});
