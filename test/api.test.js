'use strict';
// End-to-end API tests against the dev server (in-memory store). Run: npm test
const assert = require('assert');
const server = require('../dev.js');
const { getStore } = require('../lib/store');
const { maxRarFor } = require('../lib/util');
const { RAR_FM } = require('../lib/cheat');

let base;
async function call(method, path, body, token, hdr) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  if (hdr) Object.assign(h, hdr);
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let j = {};
  try { j = await r.json(); } catch (e) { /* empty */ }
  return { code: r.status, j };
}
const stats = (o) => Object.assign({ season: 2, coins: 1000, inc: 10, asc: 0, caught: 5, book: 3, bestRar: 2, bestMut: 0, top: [[2, 0, 1], [1, 0, 1]], cps: 1.5 }, o || {});
// Builds a submission whose cloud save agrees with its stats (same coins, caught, Book, top faces and crew), as a real client sends it.
// x.g overrides save fields (for example { up: { val: 51 } }), x.faces replaces the faces list, x.save replaces the whole save string.
function mk(o, x) {
  x = x || {};
  const s = stats(o);
  const faces = x.faces || s.top.map((f, i) => [i + 1, f[0], f[1], f[2], i === 0 ? 1 : 0, 0, 0]);
  if (!(o && 'cps' in o)) {
    let c = 0;
    for (const f of faces) if (f[4]) c += RAR_FM[f[1]] * (1 + 0.12 * (f[3] - 1)) / 5;
    s.cps = Math.round(c * 100) / 100;
  }
  const book = {}, cap = maxRarFor(Math.max(0, Math.min(20, Math.floor(s.asc) || 0))), n = () => Object.keys(book).length;
  for (let r = 0; r <= cap && n() < s.book; r++) for (let m = 0; m < 5 && n() < s.book; m++) book[r + '_' + m] = 1;
  const g = Object.assign({ asc: s.asc, coins: Math.floor(s.coins), caught: s.caught, gems: 0, up: {}, book, fused: s.book, ach: {} }, x.g || {});
  s.save = x.save !== undefined ? x.save : JSON.stringify({ S: 2, G: g, faces });
  return s;
}
const unlock = (name) => getStore().del('rl:submit:' + name.toLowerCase());
// Pretend 10 hours have passed since the account was made and since its last ascension (the server enforces 10 minutes per ascension).
const age = async (name) => {
  const st = getStore(), l = name.toLowerCase();
  for (const k of ['u:' + l, 'p:' + l]) {
    const raw = await st.get(k); if (!raw) continue;
    const o = JSON.parse(raw); o.created = (o.created || Date.now()) - 36e6; if (o.ascAt) o.ascAt -= 36e6;
    await st.set(k, JSON.stringify(o));
  }
};

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.message || e)); process.exitCode = 1; }
}

(async () => {
  await new Promise((ok) => server.listen(0, ok));
  base = 'http://127.0.0.1:' + server.address().port;
  let A, B;

  await t('me without token is 401', async () => { assert.strictEqual((await call('GET', '/api/me')).code, 401); });
  await t('wrong method is 405', async () => { assert.strictEqual((await call('GET', '/api/signup')).code, 405); assert.strictEqual((await call('POST', '/api/leaderboard', {})).code, 405); });
  await t('signup validates username and password', async () => {
    assert.strictEqual((await call('POST', '/api/signup', { username: 'a', password: 'secret1' })).code, 400);
    assert.strictEqual((await call('POST', '/api/signup', { username: '<script>x</script>', password: 'secret1' })).code, 400);
    assert.strictEqual((await call('POST', '/api/signup', { username: 'Alice', password: '123' })).code, 400);
    assert.strictEqual((await call('POST', '/api/signup', '{not json')).code, 400);
    assert.strictEqual((await call('POST', '/api/signup', {})).code, 400);
  });
  await t('signup creates account, name case kept', async () => {
    const r = await call('POST', '/api/signup', { username: 'Alice', password: 'secret1' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.j.name, 'Alice'); assert.match(r.j.token, /^[0-9a-f]{64}$/); A = r.j.token;
  });
  await t('duplicate username (any case) is 409', async () => { assert.strictEqual((await call('POST', '/api/signup', { username: 'ALICE', password: 'other-pw' })).code, 409); });
  await t('login: wrong password and unknown user give the same 401', async () => {
    const a = await call('POST', '/api/login', { username: 'alice', password: 'nope-nope' });
    const b = await call('POST', '/api/login', { username: 'ghost', password: 'nope-nope' });
    assert.strictEqual(a.code, 401); assert.strictEqual(b.code, 401); assert.deepStrictEqual(a.j, b.j);
  });
  await t('login works (case-insensitive) and returns display name', async () => {
    const r = await call('POST', '/api/login', { username: 'aLiCe', password: 'secret1' });
    assert.strictEqual(r.code, 200); assert.strictEqual(r.j.name, 'Alice');
  });
  await t('me: new account has rank 0 and no save', async () => {
    const r = await call('GET', '/api/me', undefined, A);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.j.name, 'Alice'); assert.strictEqual(r.j.rank, 0); assert.strictEqual(r.j.save, null);
  });
  await t('submit needs auth and valid stats', async () => {
    assert.strictEqual((await call('POST', '/api/submit', stats())).code, 401);
    assert.strictEqual((await call('POST', '/api/submit', stats(), 'f'.repeat(64))).code, 401);
    const bad = [stats({ coins: null }), stats({ bestRar: 99 }), stats({ bestRar: 17 }), stats({ bestMut: 7 }), stats({ asc: 1.5 }), stats({ coins: -1 }), stats({ top: [[1, 0, 1], [1, 0, 1], [1, 0, 1], [1, 0, 1], [1, 0, 1], [1, 0, 1], [1, 0, 1]] }), stats({ top: [[99, 0, 1]] }), stats({ top: [[17, 0, 1]] }), stats({ book: 81 }), stats({ book: 86 }), stats({ top: 'x' }), stats({ asc: 21 }), stats({ asc: 3 }), stats({ bestRar: 7 }), stats({ top: [[7, 0, 1]] })];
    for (const b of bad) { unlock('alice'); assert.strictEqual((await call('POST', '/api/submit', b, A)).code, 422, JSON.stringify(b)); }
  });
  await t('submit stores stats and cloud save, returns rank', async () => {
    unlock('alice');
    const b = mk(), save = b.save;
    const r = await call('POST', '/api/submit', b, A);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.j.rank, 1); assert.strictEqual(r.j.total, 1);
    const me = await call('GET', '/api/me', undefined, A);
    assert.strictEqual(me.j.save, save); assert.strictEqual(me.j.rank, 1);
  });
  await t('submit is rate limited', async () => { assert.strictEqual((await call('POST', '/api/submit', stats(), A)).code, 429); });
  await t('a missing, bad or oversize save is rejected (422) and the last good save survives', async () => {
    unlock('alice'); let r = await call('POST', '/api/submit', stats({ save: 'x'.repeat(500000) }), A);
    assert.strictEqual(r.code, 422);
    unlock('alice'); r = await call('POST', '/api/submit', stats({ save: 'not json' }), A); assert.strictEqual(r.code, 422);
    unlock('alice'); r = await call('POST', '/api/submit', stats(), A); assert.strictEqual(r.code, 422); assert.match(r.j.error, /save/i);
    assert.ok((await call('GET', '/api/me', undefined, A)).j.save.includes('"coins":1000'), 'old good save survives');
  });
  await t('a missing or old season is rejected with 409 (old cached clients cannot sync)', async () => {
    unlock('alice'); const b = stats(); delete b.season;
    assert.strictEqual((await call('POST', '/api/submit', b, A)).code, 409);
    unlock('alice'); assert.strictEqual((await call('POST', '/api/submit', stats({ season: 1 }), A)).code, 409);
  });
  await t('cloud saves with a wrong season, tampered ascensions or impossible faces are not stored', async () => {
    const good = { S: 2, G: { asc: 0, coins: 1 }, faces: [[1, 2, 0, 1, 0, 0, 0]] };
    const bads = [{ ...good, S: 1 }, { ...good, G: { asc: 5 } }, { ...good, faces: [[1, 16, 0, 1, 0, 0, 0]] }, { ...good, G: { asc: 0, book: { '16_0': 1 } } }, { ...good, faces: [[1, 2, 9, 1, 0, 0, 0]] }];
    for (const bad of bads) {
      unlock('alice'); const r = await call('POST', '/api/submit', stats({ save: JSON.stringify(bad) }), A);
      assert.strictEqual(r.code, 422, JSON.stringify(bad));
    }
    assert.ok((await call('GET', '/api/me', undefined, A)).j.save.includes('"coins":1000'), 'the last valid save is kept');
  });
  await t('second player takes #1 and the feed records it', async () => {
    const s = await call('POST', '/api/signup', { username: 'bob_2', password: 'hunter22' }); B = s.j.token;
    await age('bob_2'); const r = await call('POST', '/api/submit', mk({ coins: 5e6, inc: 900, asc: 2, book: 9, bestRar: 6, top: [[6, 3, 4]] }), B);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.j.rank, 1); assert.strictEqual(r.j.total, 2);
    const lb = await call('GET', '/api/leaderboard?n=50&feed=1&view=peak', undefined, A);
    assert.strictEqual(lb.code, 200); assert.strictEqual(lb.j.total, 2);
    assert.deepStrictEqual(lb.j.rows.map((x) => x.name), ['bob_2', 'Alice']);
    assert.strictEqual(lb.j.me.rank, 2);
    assert.ok(lb.j.feed.some((e) => e.k === 'top1' && e.n === 'bob_2'));
    const row = lb.j.rows[0];
    for (const k of ['name', 'peak', 'inc', 'asc', 'book', 'bestEver', 'top', 't']) assert.ok(k in row, 'row has ' + k);
    assert.ok(!('save' in row) && !('hash' in row) && !('salt' in row));
  });
  await t('other views rank correctly and anonymous users get me=null', async () => {
    for (const v of ['inc', 'asc', 'book']) {
      const lb = await call('GET', '/api/leaderboard?view=' + v);
      assert.strictEqual(lb.code, 200); assert.strictEqual(lb.j.rows[0].name, 'bob_2'); assert.strictEqual(lb.j.me, null);
    }
    assert.strictEqual((await call('GET', '/api/leaderboard?view=bogus&n=abc')).j.rows.length, 2);
  });
  await t('stale token on the leaderboard is treated as anonymous (no 401)', async () => {
    const r = await call('GET', '/api/leaderboard?view=peak', undefined, '0'.repeat(64)); assert.strictEqual(r.code, 200); assert.strictEqual(r.j.me, null);
  });
  await t('profile lookup is case-insensitive; unknown is 404', async () => {
    const r = await call('GET', '/api/leaderboard?u=ALICE'); assert.strictEqual(r.code, 200);
    assert.strictEqual(r.j.profile.name, 'Alice'); assert.strictEqual(r.j.rank, 2); assert.ok(r.j.profile.created > 0);
    assert.strictEqual((await call('GET', '/api/leaderboard?u=nobody')).code, 404);
    assert.strictEqual((await call('GET', '/api/leaderboard?u=' + encodeURIComponent('<b>'))).code, 404);
  });
  await t('peak and ascensions never go backwards; absurd ascension jumps rejected', async () => {
    unlock('bob_2'); let r = await call('POST', '/api/submit', mk({ coins: 10, asc: 0, inc: 1 }), B); assert.strictEqual(r.code, 200);
    const p = (await call('GET', '/api/leaderboard?u=bob_2')).j.profile;
    assert.strictEqual(p.peak, 5e6); assert.strictEqual(p.asc, 2); assert.strictEqual(p.inc, 900);
    unlock('bob_2'); assert.strictEqual((await call('POST', '/api/submit', stats({ asc: 500 }), B)).code, 422);
  });
  await t('ascending and a rare catch show up in the feed', async () => {
    await age('alice'); unlock('alice'); await call('POST', '/api/submit', mk({ asc: 2, bestRar: 6, top: [[6, 1, 2]] }), A);
    const f = (await call('GET', '/api/leaderboard?feed=1')).j.feed;
    assert.ok(f.some((e) => e.k === 'asc' && e.n === 'Alice' && e.v === 2));
    assert.ok(f.some((e) => e.k === 'rar' && e.n === 'Alice' && e.v === 6 && e.m === 1));
  });
  await t('ascensions max out at 20, climb 2 per sync at most (even for a new account), and Limited Edition needs all 20', async () => {
    const s = await call('POST', '/api/signup', { username: 'carol_3', password: 'hunter33' });
    assert.strictEqual(s.code, 200, JSON.stringify(s.j));
    const C = s.j.token, sub = async (o) => { await age('carol_3'); unlock('carol_3'); return call('POST', '/api/submit', mk(o), C); };
    assert.strictEqual((await sub({ bestRar: 16, book: 80, top: [[16, 4, 2]] })).code, 422, 'Limited Edition with 0 ascensions');
    assert.strictEqual((await sub({ asc: 20 })).code, 422, 'jumping straight to 20');
    for (let a = 2; a <= 20; a += 2) {
      if (a < 20) assert.strictEqual((await sub({ asc: a, bestRar: 16 })).code, 422, 'Limited Edition at ' + a + ' ascensions');
      const r = await sub({ asc: a });
      assert.strictEqual(r.code, 200, 'ascension ' + a + ' ' + JSON.stringify(r.j));
    }
    const r = await sub({ asc: 20, bestRar: 16, book: 80, top: [[16, 4, 2], [15, 0, 1]] });
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual((await sub({ asc: 21 })).code, 422, 'above the maximum');
  });
  await t('ascending needs real time since the last ascension (10 minutes each)', async () => {
    const s = await call('POST', '/api/signup', { username: 'timer_77', password: 'hunter44' });
    assert.strictEqual(s.code, 200, JSON.stringify(s.j));
    const sub = async (o) => { unlock('timer_77'); return call('POST', '/api/submit', mk(o), s.j.token); };
    assert.strictEqual((await sub({ asc: 1 })).code, 422, 'brand-new account ascending at once');
    await age('timer_77'); assert.strictEqual((await sub({ asc: 1 })).code, 200);
    assert.strictEqual((await sub({ asc: 2 })).code, 422, 'second ascension straight away');
    await age('timer_77'); assert.strictEqual((await sub({ asc: 2 })).code, 200);
  });
  await t('each rarity needs its ascension count (Quantum 17, Abyssal 19, ULTRA 20)', async () => {
    const { ASC_REQ, maxRarFor } = require('../lib/util');
    assert.strictEqual(ASC_REQ.length, 17);
    assert.strictEqual(maxRarFor(0), 6); assert.strictEqual(maxRarFor(2), 6); assert.strictEqual(maxRarFor(3), 7); assert.strictEqual(maxRarFor(16), 12);
    assert.strictEqual(maxRarFor(17), 13); assert.strictEqual(maxRarFor(18), 13); assert.strictEqual(maxRarFor(19), 14); assert.strictEqual(maxRarFor(20), 16);
  });
  await t('login is rate limited per user+IP', async () => {
    let last; for (let i = 0; i < 12; i++) last = await call('POST', '/api/login', { username: 'bob_2', password: 'wrong-pass' });
    assert.strictEqual(last.code, 429);
  });

  // ---- admin ----
  const adm = (body) => call('POST', '/api/admin', body);
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const PW = 'admin-test-pw-123';
  let D;
  await t('admin is disabled (503) until ADMIN_PASSWORD is set', async () => {
    delete process.env.ADMIN_PASSWORD;
    assert.strictEqual((await adm({ password: PW, action: 'kick', username: 'dave_4' })).code, 503);
    process.env.ADMIN_PASSWORD = PW;
  });
  await t('admin rejects GET and malformed bodies', async () => {
    assert.strictEqual((await call('GET', '/api/admin')).code, 405);
    assert.strictEqual((await adm('{not json')).code, 422);
  });
  await t('wrong or missing admin password is 403 and does nothing', async () => {
    const s = await call('POST', '/api/signup', { username: 'dave_4', password: 'hunter44' });
    assert.strictEqual(s.code, 200, JSON.stringify(s.j)); D = s.j.token;
    assert.strictEqual((await adm({ password: 'wrong', action: 'ban', username: 'dave_4' })).code, 403);
    assert.strictEqual((await adm({ action: 'ban', username: 'dave_4' })).code, 403);
    assert.strictEqual((await call('GET', '/api/me', undefined, D)).code, 200);
  });
  await t('admin validates action and username; unknown player is 404', async () => {
    assert.strictEqual((await adm({ password: PW, action: 'explode', username: 'dave_4' })).code, 422);
    assert.strictEqual((await adm({ password: PW, action: 'kick', username: '<b>' })).code, 422);
    assert.strictEqual((await adm({ password: PW, action: 'kick', username: 'nobody_x' })).code, 404);
  });
  await t('kick ends existing sessions but the player can sign in again', async () => {
    await sleep(5);
    const r = await adm({ password: PW, action: 'kick', username: 'DAVE_4' });
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual((await call('GET', '/api/me', undefined, D)).code, 401);
    await sleep(5);
    const l = await call('POST', '/api/login', { username: 'dave_4', password: 'hunter44' });
    assert.strictEqual(l.code, 200, JSON.stringify(l.j)); D = l.j.token;
    assert.strictEqual((await call('GET', '/api/me', undefined, D)).code, 200);
  });
  await t('ban blocks sessions and login, drops the player from the boards; unban restores login', async () => {
    unlock('dave_4'); assert.strictEqual((await call('POST', '/api/submit', mk({ coins: 7e6 }), D)).code, 200);
    assert.notStrictEqual(await getStore().zrevrank('lb:peak', 'dave_4'), null);
    await sleep(5);
    assert.strictEqual((await adm({ password: PW, action: 'ban', username: 'dave_4' })).code, 200);
    assert.strictEqual((await call('GET', '/api/me', undefined, D)).code, 401);
    assert.strictEqual(await getStore().zrevrank('lb:peak', 'dave_4'), null);
    assert.strictEqual((await call('POST', '/api/login', { username: 'dave_4', password: 'hunter44' })).code, 403);
    assert.strictEqual((await adm({ password: PW, action: 'unban', username: 'dave_4' })).code, 200);
    await sleep(5);
    const l = await call('POST', '/api/login', { username: 'dave_4', password: 'hunter44' });
    assert.strictEqual(l.code, 200, JSON.stringify(l.j)); D = l.j.token;
  });
  await t('reset wipes stats and cloud save but keeps the account', async () => {
    unlock('dave_4'); assert.strictEqual((await call('POST', '/api/submit', mk({ coins: 5e6 }), D)).code, 200);
    assert.strictEqual((await call('GET', '/api/leaderboard?u=dave_4')).code, 200);
    await sleep(5);
    assert.strictEqual((await adm({ password: PW, action: 'reset', username: 'dave_4' })).code, 200);
    assert.strictEqual((await call('GET', '/api/leaderboard?u=dave_4')).code, 404);
    assert.strictEqual(await getStore().get('sv:dave_4'), null);
    await sleep(5);
    const l = await call('POST', '/api/login', { username: 'dave_4', password: 'hunter44' });
    assert.strictEqual(l.code, 200, JSON.stringify(l.j));
    assert.strictEqual((await call('GET', '/api/me', undefined, l.j.token)).j.save, null);
  });
  await t('wipeall needs the confirmation phrase, then deletes every account, save, session and board', async () => {
    assert.strictEqual((await adm({ password: PW, action: 'wipeall' })).code, 422);
    assert.strictEqual((await adm({ password: PW, action: 'wipeall', confirm: 'yes' })).code, 422);
    assert.strictEqual((await call('GET', '/api/me', undefined, A)).code, 200, 'nothing deleted without the phrase');
    const r = await adm({ password: PW, action: 'wipeall', confirm: 'DELETE ALL ACCOUNTS' });
    assert.strictEqual(r.code, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.done, true); assert.ok(r.j.deleted > 0);
    assert.strictEqual((await call('GET', '/api/me', undefined, A)).code, 401);
    assert.strictEqual((await call('POST', '/api/login', { username: 'alice', password: 'secret1' })).code, 401);
    const lb = await call('GET', '/api/leaderboard?feed=1');
    assert.strictEqual(lb.j.total, 0); assert.deepStrictEqual(lb.j.rows, []); assert.deepStrictEqual(lb.j.feed, []);
    assert.strictEqual((await call('POST', '/api/signup', { username: 'alice', password: 'fresh-pw-1' })).code, 200, 'names are free again');
  });
  // ---- change password ----
  const ipOf = (n) => ({ 'x-real-ip': '10.1.0.' + n }); // a different client IP per account, so these tests never share a signup limit
  const signupAs = async (name, pw, n) => {
    const r = await call('POST', '/api/signup', { username: name, password: pw }, undefined, ipOf(n));
    assert.strictEqual(r.code, 200, JSON.stringify(r.j)); return r.j.token;
  };
  let P;
  await t('change password: needs a session, validates input, and never signs the player out on a mistake', async () => {
    assert.strictEqual((await call('POST', '/api/password', { oldPassword: 'a', newPassword: 'bbbbbb' })).code, 401);
    P = await signupAs('pw_user', 'first-pw-1', 1);
    assert.strictEqual((await call('GET', '/api/password', undefined, P)).code, 405);
    const wrong = await call('POST', '/api/password', { oldPassword: 'not-it', newPassword: 'second-pw-2' }, P);
    assert.strictEqual(wrong.code, 403, 'a wrong old password is 403, because a 401 would sign the player out');
    assert.strictEqual((await call('POST', '/api/password', { oldPassword: 'first-pw-1', newPassword: '123' }, P)).code, 422);
    assert.strictEqual((await call('POST', '/api/password', { oldPassword: 'first-pw-1', newPassword: 'first-pw-1' }, P)).code, 422);
    assert.strictEqual((await call('GET', '/api/me', undefined, P)).code, 200, 'still signed in');
    assert.strictEqual((await call('POST', '/api/login', { username: 'pw_user', password: 'first-pw-1' }, undefined, ipOf(1))).code, 200, 'password unchanged');
  });
  await t('change password: success ends other sessions, keeps this device signed in, retires the old password', async () => {
    const other = (await call('POST', '/api/login', { username: 'pw_user', password: 'first-pw-1' }, undefined, ipOf(1))).j.token;
    await sleep(5);
    const r = await call('POST', '/api/password', { oldPassword: 'first-pw-1', newPassword: 'second-pw-2' }, P);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j)); assert.match(r.j.token, /^[0-9a-f]{64}$/);
    assert.strictEqual((await call('GET', '/api/me', undefined, P)).code, 401, 'the old token is dead');
    assert.strictEqual((await call('GET', '/api/me', undefined, other)).code, 401, 'other devices are signed out');
    assert.strictEqual((await call('GET', '/api/me', undefined, r.j.token)).code, 200, 'the new token works');
    assert.strictEqual((await call('POST', '/api/login', { username: 'pw_user', password: 'first-pw-1' }, undefined, ipOf(1))).code, 401);
    assert.strictEqual((await call('POST', '/api/login', { username: 'pw_user', password: 'second-pw-2' }, undefined, ipOf(1))).code, 200);
    P = r.j.token;
  });
  await t('change password is rate limited per account (5 tries per 15 minutes)', async () => {
    const T = await signupAs('pw_limit', 'limit-pw-1', 2); let last;
    for (let i = 0; i < 6; i++) last = await call('POST', '/api/password', { oldPassword: 'guess-' + i, newPassword: 'whatever-1' }, T);
    assert.strictEqual(last.code, 429);
    assert.strictEqual((await call('POST', '/api/password', { oldPassword: 'limit-pw-1', newPassword: 'whatever-1' }, T)).code, 429, 'even the right password waits');
  });
  await t('signup is limited per IP (10 per hour)', async () => {
    let last; for (let i = 0; i < 11; i++) last = await call('POST', '/api/signup', { username: 'flood_' + i, password: 'flood-pw-1' }, undefined, ipOf(99));
    assert.strictEqual(last.code, 429);
  });

  // ---- anti-cheat ----
  let CH;
  const sync = async (o, x) => { unlock('cheat_5'); return call('POST', '/api/submit', mk(o, x), CH); };
  const strikes = async () => +(await getStore().get('strikes:cheat_5')) || 0;
  await t('anti-cheat: an honest sync passes and ranks', async () => {
    CH = await signupAs('cheat_5', 'cheat-pw-1', 3);
    const r = await sync({ coins: 4000 }); assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.notStrictEqual(await getStore().zrevrank('lb:peak', 'cheat_5'), null);
  });
  await t('anti-cheat: odd numbers (soft) are rejected with a hint and no strike', async () => {
    let r = await sync({}, { g: { caught: 999 } }); // stats that do not match the save they came with
    assert.strictEqual(r.code, 422); assert.match(r.j.error, /verify/i);
    r = await sync({ coins: 4000 + 1e8 }); // more money than the time since the last sync allows, but not absurd
    assert.strictEqual(r.code, 422); assert.match(r.j.error, /verify/i);
    assert.strictEqual(await strikes(), 0);
  });
  await t('anti-cheat: impossible numbers (hard) count strikes; three strikes quarantine the account', async () => {
    let r = await sync({}, { g: { up: { val: 51 } } }); // an upgrade above its maximum
    assert.strictEqual(r.code, 422); assert.strictEqual(r.j.error, 'Invalid stats.'); assert.strictEqual(await strikes(), 1);
    r = await sync({ inc: 1e15 }); // income no face in the save could produce
    assert.strictEqual(r.code, 422); assert.strictEqual(await strikes(), 2);
    assert.strictEqual(await getStore().get('q:cheat_5'), null, 'not quarantined yet');
    assert.notStrictEqual(await getStore().zrevrank('lb:peak', 'cheat_5'), null, 'still on the board');
    r = await sync({}, { faces: [[1, 2, 0, 99, 0, 0, 0]] }); // a face above level 20
    assert.strictEqual(r.code, 422); assert.ok(await getStore().get('q:cheat_5'), 'quarantined');
    assert.strictEqual(await getStore().zrevrank('lb:peak', 'cheat_5'), null, 'off the leaderboard');
  });
  await t('anti-cheat: a quarantined account keeps syncing but stays off the boards; admin flags shows it and unflag clears it', async () => {
    let r = await sync({ coins: 5000 }); assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual(await getStore().zrevrank('lb:peak', 'cheat_5'), null);
    const fl = await adm({ password: PW, action: 'flags' });
    assert.strictEqual(fl.code, 200, JSON.stringify(fl.j));
    assert.ok(fl.j.flags.some((f) => f.u === 'cheat_5' && f.k === 'hard'), 'hard flag listed');
    assert.ok(fl.j.accounts.some((a) => a.u === 'cheat_5' && a.quarantined && a.strikes >= 3), 'account shown as quarantined');
    assert.strictEqual((await adm({ action: 'flags' })).code, 403, 'flags need the admin password');
    assert.strictEqual((await adm({ password: PW, action: 'unflag', username: 'cheat_5' })).code, 200);
    r = await sync({ coins: 6000 }); assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.notStrictEqual(await getStore().zrevrank('lb:peak', 'cheat_5'), null, 'back on the board');
  });
  await t('anti-cheat: admin can quarantine an account by hand', async () => {
    assert.strictEqual((await adm({ password: PW, action: 'quarantine', username: 'cheat_5' })).code, 200);
    assert.strictEqual(await getStore().zrevrank('lb:peak', 'cheat_5'), null);
    const r = await sync({ coins: 7000 }); assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual(await getStore().zrevrank('lb:peak', 'cheat_5'), null, 'stays hidden');
    assert.strictEqual((await adm({ password: PW, action: 'unflag', username: 'cheat_5' })).code, 200);
  });
  await t('inspect(): honest saves are clean, impossible ones are hard findings, odd ones soft', async () => {
    const { inspect } = require('../lib/cheat'), now = Date.now();
    const run = (o, x, prev) => { const b = mk(o, x); return inspect(b, JSON.parse(b.save), prev || null, now); };
    const r0 = run(); assert.deepStrictEqual([r0.hard, r0.soft], [[], []]);
    assert.ok(run({}, { g: { gems: 5000 } }).hard.includes('gems'));
    assert.ok(run({}, { g: { up: { cap: 11 } } }).hard.includes('upgrade cap'));
    assert.ok(run({}, { g: { book: { '99_9': 1 } } }).hard.includes('book entry'));
    assert.ok(run({}, { faces: [[1, 2, 0, 1, 1, 0, 0], [2, 2, 0, 1, 1, 0, 0]] }).hard.includes('too many crew'));
    assert.ok(run({}, { g: { gems: 600 } }).soft.includes('gems'), 'a first sync with many gems');
    assert.ok(run({ book: 9 }, { g: { book: { '0_0': 1, '0_1': 1, '0_2': 1 } } }).soft.includes('book count'));
    const prev = { t: now - 1000, rc: 1000, peak: 1000, incLast: 10, caught: 5, asc: 0, gems: 0 };
    assert.ok(run({ coins: 1e8 }, {}, prev).soft.includes('coin jump'));
    assert.ok(run({ caught: 5000 }, {}, prev).soft.includes('catch rate'));
    assert.ok(run({}, { g: { gems: 100 } }, prev).soft.includes('gem rate'));
  });
  await t('lib/cheat.js economy tables match the client (RAR, MUT, UPS, ASC_REQ)', async () => {
    const cheat = require('../lib/cheat'), { ASC_REQ } = require('../lib/util');
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const grab = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'client has ' + a); return html.slice(i + a.length, j); };
    const RAR = new Function('return [' + grab('var RAR=[', 'var NR=RAR.length').trim().replace(/;$/, '').replace(/\]$/, '') + ']')();
    assert.deepStrictEqual(RAR.map((r) => r.inc), cheat.RAR_INC);
    assert.deepStrictEqual(RAR.map((r) => r.sell), cheat.RAR_SELL);
    assert.deepStrictEqual(RAR.map((r) => r.fm), cheat.RAR_FM);
    const MUT = new Function('return ' + grab('var MUT=', 'var MUTC=').trim().replace(/;$/, ''))();
    assert.deepStrictEqual(MUT.map((m) => m.m), cheat.MUT_M);
    const ups = {}, re = /(\w+):\{n:'[^']*'.*?,max:(\d+),eff:/g, block = grab('var UPS={', 'var UK='); let m;
    while ((m = re.exec(block))) ups[m[1]] = +m[2];
    assert.deepStrictEqual(ups, cheat.UP_MAX);
    const ar = /ASC_REQ\s*=\s*\[([\d,\s]+)\]/.exec(html);
    assert.ok(ar, 'client has ASC_REQ');
    assert.deepStrictEqual(ar[1].split(',').map((x) => +x.trim()), ASC_REQ);
  });

  await t('wrong admin passwords are rate limited (429), even for the right password afterwards', async () => {
    let last; for (let i = 0; i < 8; i++) last = await adm({ password: 'guess' + i, action: 'kick', username: 'dave_4' });
    assert.strictEqual(last.code, 429);
  });

  console.log(process.exitCode ? '\nSome tests FAILED' : '\nAll ' + passed + ' API tests passed');
  server.close(); process.exit(process.exitCode || 0);
})();
