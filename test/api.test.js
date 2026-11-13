'use strict';
// End-to-end API tests against the dev server (in-memory store). Run: npm test
const assert = require('assert');
const server = require('../dev.js');
const { getStore } = require('../lib/store');
const { maxRarFor } = require('../lib/util');
const { RAR_FM } = require('../lib/cheat');
const crypto = require('crypto');
const { hashCode } = require('../lib/adminCodes');

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
const stats = (o) => Object.assign({ season: 3, rev: require('../lib/util').CLIENT_REV, coins: 1000, inc: 10, asc: 0, caught: 5, book: 3, bestRar: 2, bestMut: 0, top: [[2, 0, 1], [1, 0, 1]], cps: 1.5 }, o || {});
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
  const g = Object.assign({ asc: s.asc, coins: Math.floor(s.coins), caught: s.caught, gems: 0, up: {}, book, ach: {} }, x.g || {});
  s.save = x.save !== undefined ? x.save : JSON.stringify(Object.assign({ S: 3, G: g, faces }, x.bp ? { bp: x.bp } : {}));
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
  await t('the 409 for an old season tells the client the update is required and names the live build', async () => {
    unlock('alice'); const r = await call('POST', '/api/submit', stats({ season: 1 }), A);
    assert.strictEqual(r.code, 409);
    assert.strictEqual(r.j.required, true);
    assert.match(r.j.build, /^[0-9a-f]{12}$/);
  });
  await t('version.json reports the live build and season and is never cached', async () => {
    const r = await fetch(base + '/version.json');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('cache-control') || '', /no-store/);
    const j = await r.json();
    assert.match(j.build, /^[0-9a-f]{12}$/);
    assert.strictEqual(j.season, require('../lib/util').SEASON);
    assert.strictEqual(j.build, require('../lib/build').currentBuild());
  });
  await t('the page is served with the live build id stamped in place of the placeholder', async () => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(!html.includes('__BUILD_ID__'), 'placeholder was replaced');
    assert.ok(html.includes("var BUILD='" + require('../lib/build').currentBuild() + "'"), 'page carries the live build id');
  });
  await t('build id is stable for the same sources, and the stamp script never rewrites the source page outside Vercel', async () => {
    const { computeId } = require('../lib/build');
    assert.strictEqual(computeId(), computeId());
    assert.match(computeId(), /^[0-9a-f]{12}$/);
    const { execFileSync } = require('child_process'), fs = require('fs'), path = require('path');
    const idx = path.join(__dirname, '..', 'public', 'index.html');
    const before = fs.readFileSync(idx, 'utf8');
    assert.ok(before.includes('__BUILD_ID__'), 'the source page keeps its placeholder');
    const env = Object.assign({}, process.env); delete env.VERCEL; delete env.BUILD_ID;
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-id.js')], { env }).toString();
    assert.match(out, /skipping/);
    assert.strictEqual(fs.readFileSync(idx, 'utf8'), before, 'source page untouched');
  });
  await t('cloud saves with a wrong season, tampered ascensions or impossible faces are not stored', async () => {
    const good = { S: 3, G: { asc: 0, coins: 1 }, faces: [[1, 2, 0, 1, 0, 0, 0]] };
    const bads = [{ ...good, S: 1 }, { ...good, G: { asc: 5 } }, { ...good, faces: [[1, 16, 0, 1, 0, 0, 0]] }, { ...good, G: { asc: 0, book: { '16_0': 1 } } }, { ...good, faces: [[1, 2, 9, 1, 0, 0, 0]] }];
    for (const bad of bads) {
      unlock('alice'); const r = await call('POST', '/api/submit', stats({ save: JSON.stringify(bad) }), A);
      assert.strictEqual(r.code, 422, JSON.stringify(bad));
    }
    assert.ok((await call('GET', '/api/me', undefined, A)).j.save.includes('"coins":1000'), 'the last valid save is kept');
  });
  await t('cloud saves accept a valid backpack and refuse an oversized or impossible one', async () => {
    const u = require('../lib/util');
    const base = { S: u.SEASON, G: { asc: 0 }, faces: [] };
    const ok = (bp) => u.validateSave(JSON.stringify({ ...base, bp }), { asc: 0 });
    assert.strictEqual(ok([[1, 2, 0, 1, 0], [2, 3, 4, 20, 99]]), true);
    assert.strictEqual(u.validateSave(JSON.stringify(base), { asc: 0 }), true, 'older saves without a backpack');
    assert.strictEqual(ok(new Array(3000).fill([1, 0, 0, 1, 0])), true, 'exactly 3000');
    assert.strictEqual(ok(new Array(3001).fill([1, 0, 0, 1, 0])), false, 'over 3000');
    assert.strictEqual(ok([[1, 16, 0, 1, 0]]), false, 'rarity above this ascension');
    assert.strictEqual(ok([[1, 2, 9, 1, 0]]), false, 'bad mutation');
    assert.strictEqual(ok([[1, 2, 0, 99, 0]]), false, 'bad level');
    assert.strictEqual(ok('x'), false, 'not a list');
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

  // ---- admin (one-time codes; there is no shared password) ----
  const adm = (body, token, n) => call('POST', '/api/admin', body, token, { 'x-real-ip': '10.2.0.' + (n || 1) }); // each group of calls uses its own client IP so the per-IP limits stay out of the way
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const ipOf = (n) => ({ 'x-real-ip': '10.1.0.' + n }); // a different client IP per account, so these tests never share a signup limit
  const signupAs = async (name, pw, n) => {
    const r = await call('POST', '/api/signup', { username: name, password: pw }, undefined, ipOf(n));
    assert.strictEqual(r.code, 200, JSON.stringify(r.j)); return r.j.token;
  };
  const mkCode = () => crypto.randomBytes(20).toString('hex').match(/.{4}/g).join('-');
  const codes = { owner: mkCode(), staff: mkCode(), staff2: mkCode(), spare: mkCode() };
  const setCodes = (list) => { process.env.ADMIN_CODES = (list || []).join(','); };
  const allCodes = () => ['owner:' + hashCode(codes.owner), hashCode(codes.staff), hashCode(codes.staff2), hashCode(codes.spare)];
  const statusOf = async (token, n) => (await adm({ action: 'status' }, token, n)).j;
  let D, O, S, S2, L;

  await t('admin is disabled (503) until ADMIN_CODES holds a valid hash', async () => {
    delete process.env.ADMIN_CODES;
    assert.strictEqual((await adm({ action: 'status' }, A)).code, 503);
    setCodes(['not-a-hash', codes.staff]); // raw codes and junk are ignored; only 64-hex SHA-256 hashes count
    assert.strictEqual((await adm({ action: 'status' }, A)).code, 503);
    setCodes(allCodes());
  });
  await t('admin rejects GET, anonymous and malformed requests', async () => {
    assert.strictEqual((await call('GET', '/api/admin')).code, 405);
    assert.strictEqual((await adm({ action: 'status' })).code, 401, 'no session, no admin');
    D = await signupAs('dave_4', 'hunter44', 50);
    assert.strictEqual((await adm('{not json', D)).code, 422);
    assert.strictEqual((await adm({ action: 'explode' }, D)).code, 403, 'not an admin');
  });
  await t('a normal player is not an admin: status says so and every action is 403', async () => {
    const s = await statusOf(D); assert.strictEqual(s.admin, false); assert.strictEqual(s.tier, null);
    for (const body of [{ action: 'kick', username: 'dave_4' }, { action: 'flags' }, { action: 'wipeall', confirm: 'DELETE ALL ACCOUNTS' }, { action: 'revoke', username: 'dave_4' }]) {
      assert.strictEqual((await adm(body, D)).code, 403, body.action);
    }
    assert.strictEqual((await call('GET', '/api/me', undefined, D)).code, 200, 'still signed in');
  });
  await t('redeem: wrong, short, unknown and missing codes are 403 and change nothing', async () => {
    for (const code of ['nope', mkCode(), undefined]) {
      const r = await adm({ action: 'redeem', code }, D); assert.strictEqual(r.code, 403, JSON.stringify(r.j)); assert.match(r.j.error, /not valid/);
    }
    assert.strictEqual((await statusOf(D)).admin, false);
    assert.strictEqual(await getStore().get('adm:dave_4'), null);
  });
  await t('redeem: a staff code turns the account into a staff admin for good', async () => {
    S = await signupAs('staff_1', 'staff-pw-1', 51);
    const r = await adm({ action: 'redeem', code: codes.staff }, S, 2);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.admin, true); assert.strictEqual(r.j.tier, 'staff');
    const s = await statusOf(S, 2); assert.strictEqual(s.admin, true); assert.strictEqual(s.tier, 'staff');
    assert.strictEqual((await adm({ action: 'redeem', code: codes.staff }, S, 2)).code, 200, 'the same account may redeem again');
    const loose = codes.staff.toUpperCase().replace(/-/g, ' ');
    assert.strictEqual((await adm({ action: 'redeem', code: loose }, S, 2)).code, 200, 'case, spaces and dashes are ignored');
  });
  await t('redeem: a code works for one account only', async () => {
    L = await signupAs('late_1', 'late-pw-1', 52);
    const r = await adm({ action: 'redeem', code: codes.staff }, L, 3);
    assert.strictEqual(r.code, 403); assert.match(r.j.error, /already been used/);
    assert.strictEqual((await statusOf(L, 3)).admin, false);
    assert.strictEqual(await getStore().get('adm:late_1'), null);
  });
  await t('redeem: an owner code gives the owner tier', async () => {
    O = await signupAs('boss_1', 'boss-pw-1', 53);
    const r = await adm({ action: 'redeem', code: codes.owner }, O, 2);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.tier, 'owner');
    const s = await statusOf(O, 2); assert.strictEqual(s.admin, true); assert.strictEqual(s.tier, 'owner');
  });
  await t('admin validates action and username; unknown player is 404', async () => {
    assert.strictEqual((await adm({ action: 'explode', username: 'dave_4' }, S, 2)).code, 422);
    assert.strictEqual((await adm({ action: 'kick', username: '<b>' }, S, 2)).code, 422);
    assert.strictEqual((await adm({ action: 'kick', username: 'nobody_x' }, S, 2)).code, 404);
  });
  await t('kick ends existing sessions but the player can sign in again', async () => {
    await sleep(5);
    const r = await adm({ action: 'kick', username: 'DAVE_4' }, S, 2);
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
    assert.strictEqual((await adm({ action: 'ban', username: 'dave_4' }, S, 2)).code, 200);
    assert.strictEqual((await call('GET', '/api/me', undefined, D)).code, 401);
    assert.strictEqual(await getStore().zrevrank('lb:peak', 'dave_4'), null);
    assert.strictEqual((await call('POST', '/api/login', { username: 'dave_4', password: 'hunter44' })).code, 403);
    assert.strictEqual((await adm({ action: 'unban', username: 'dave_4' }, S, 2)).code, 200);
    await sleep(5);
    const l = await call('POST', '/api/login', { username: 'dave_4', password: 'hunter44' });
    assert.strictEqual(l.code, 200, JSON.stringify(l.j)); D = l.j.token;
  });
  await t('reset wipes stats and cloud save but keeps the account', async () => {
    unlock('dave_4'); assert.strictEqual((await call('POST', '/api/submit', mk({ coins: 5e6 }), D)).code, 200);
    assert.strictEqual((await call('GET', '/api/leaderboard?u=dave_4')).code, 200);
    await sleep(5);
    assert.strictEqual((await adm({ action: 'reset', username: 'dave_4' }, S, 2)).code, 200);
    assert.strictEqual((await call('GET', '/api/leaderboard?u=dave_4')).code, 404);
    assert.strictEqual(await getStore().get('sv:dave_4'), null);
    await sleep(5);
    const l = await call('POST', '/api/login', { username: 'dave_4', password: 'hunter44' });
    assert.strictEqual(l.code, 200, JSON.stringify(l.j));
    assert.strictEqual((await call('GET', '/api/me', undefined, l.j.token)).j.save, null);
  });
  await t('tiers: staff cannot wipe, revoke or touch other admins; an owner can act on staff', async () => {
    const w = await adm({ action: 'wipeall', confirm: 'DELETE ALL ACCOUNTS' }, S, 2);
    assert.strictEqual(w.code, 403); assert.match(w.j.error, /owner/i);
    assert.strictEqual((await adm({ action: 'revoke', username: 'late_1' }, S, 2)).code, 403);
    const k = await adm({ action: 'kick', username: 'boss_1' }, S, 2);
    assert.strictEqual(k.code, 403); assert.match(k.j.error, /other admins/);
    assert.strictEqual((await adm({ action: 'ban', username: 'staff_1' }, S, 2)).code, 422, 'not on your own account');
    assert.strictEqual((await call('GET', '/api/me', undefined, O)).code, 200, 'the owner was not touched');
    assert.strictEqual((await adm({ action: 'quarantine', username: 'staff_1' }, O, 2)).code, 200, 'an owner may act on staff');
    assert.strictEqual((await adm({ action: 'unflag', username: 'staff_1' }, O, 2)).code, 200);
  });
  await t('revoke: an owner ends a staff admin, and the spent code cannot be used again', async () => {
    S2 = await signupAs('staff_2', 'staff2-pw-1', 54);
    assert.strictEqual((await adm({ action: 'redeem', code: codes.staff2 }, S2, 4)).code, 200);
    assert.strictEqual((await statusOf(S2, 4)).admin, true);
    assert.strictEqual((await adm({ action: 'revoke', username: 'dave_4' }, O, 2)).code, 404, 'not an admin');
    assert.strictEqual((await adm({ action: 'revoke', username: 'boss_1' }, O, 2)).code, 422, 'not yourself');
    assert.strictEqual((await adm({ action: 'revoke', username: 'staff_2' }, O, 2)).code, 200);
    assert.strictEqual((await statusOf(S2, 4)).admin, false);
    assert.strictEqual((await adm({ action: 'kick', username: 'dave_4' }, S2, 4)).code, 403);
    const again = await adm({ action: 'redeem', code: codes.staff2 }, S2, 4);
    assert.strictEqual(again.code, 403); assert.match(again.j.error, /already been used/);
    const other = await adm({ action: 'redeem', code: codes.staff2 }, L, 3);
    assert.strictEqual(other.code, 403); assert.match(other.j.error, /already been used/);
  });
  await t('removing a hash from ADMIN_CODES switches that admin off at once; putting it back restores it', async () => {
    setCodes(allCodes().filter((h) => h !== hashCode(codes.staff)));
    assert.strictEqual((await statusOf(S, 5)).admin, false);
    assert.strictEqual((await adm({ action: 'kick', username: 'dave_4' }, S, 5)).code, 403);
    setCodes(allCodes());
    assert.strictEqual((await statusOf(S, 5)).admin, true);
    setCodes(allCodes().map((h) => (h === hashCode(codes.staff) ? 'owner:' + h : h))); // the tier follows the env var
    assert.strictEqual((await statusOf(S, 5)).tier, 'owner');
    setCodes(allCodes());
    assert.strictEqual((await statusOf(S, 5)).tier, 'staff');
  });
  await t('wipeall: owner only, exact phrase needed, keeps the caller, deletes everyone else', async () => {
    const PH = 'DELETE ALL ACCOUNTS';
    assert.strictEqual((await adm({ action: 'wipeall', confirm: PH }, S, 6)).code, 403, 'staff cannot');
    const dl = await call('POST', '/api/login', { username: 'dave_4', password: 'hunter44' }); // reset ended the old session, so sign in again
    assert.strictEqual(dl.code, 200, JSON.stringify(dl.j)); D = dl.j.token;
    assert.strictEqual((await adm({ action: 'wipeall', confirm: PH }, D, 6)).code, 403, 'players cannot');
    assert.strictEqual((await adm({ action: 'wipeall' }, O, 6)).code, 422);
    assert.strictEqual((await adm({ action: 'wipeall', confirm: 'yes' }, O, 6)).code, 422);
    assert.strictEqual((await call('GET', '/api/me', undefined, A)).code, 200, 'nothing deleted without the phrase');
    const r = await adm({ action: 'wipeall', confirm: PH }, O, 6);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.done, true); assert.ok(r.j.deleted > 0);
    assert.strictEqual((await call('GET', '/api/me', undefined, A)).code, 401);
    assert.strictEqual((await call('GET', '/api/me', undefined, S)).code, 401);
    assert.strictEqual((await call('POST', '/api/login', { username: 'alice', password: 'secret1' })).code, 401);
    assert.strictEqual((await call('GET', '/api/me', undefined, O)).code, 200, 'the owner stays signed in');
    const s = await statusOf(O, 6); assert.strictEqual(s.admin, true); assert.strictEqual(s.tier, 'owner');
    const lb = await call('GET', '/api/leaderboard?feed=1');
    assert.strictEqual(lb.j.total, 0); assert.deepStrictEqual(lb.j.rows, []); assert.deepStrictEqual(lb.j.feed, []);
    assert.strictEqual((await call('POST', '/api/signup', { username: 'alice', password: 'fresh-pw-1' })).code, 200, 'names are free again');
    // A name registered again after the wipe is a different account and inherits no admin rights, and its old code stays spent.
    const S1 = await signupAs('staff_1', 'fresh-staff-1', 55);
    assert.strictEqual((await statusOf(S1, 6)).admin, false);
    const reuse = await adm({ action: 'redeem', code: codes.staff }, S1, 7);
    assert.strictEqual(reuse.code, 403); assert.match(reuse.j.error, /already been used/);
  });
  // ---- change password ----
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
    const fl = await adm({ action: 'flags' }, O, 8);
    assert.strictEqual(fl.code, 200, JSON.stringify(fl.j));
    assert.ok(fl.j.flags.some((f) => f.u === 'cheat_5' && f.k === 'hard'), 'hard flag listed');
    assert.ok(fl.j.accounts.some((a) => a.u === 'cheat_5' && a.quarantined && a.strikes >= 3), 'account shown as quarantined');
    assert.strictEqual((await adm({ action: 'flags' }, CH, 8)).code, 403, 'flags need an admin account');
    assert.strictEqual((await adm({ action: 'unflag', username: 'cheat_5' }, O, 8)).code, 200);
    r = await sync({ coins: 6000 }); assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.notStrictEqual(await getStore().zrevrank('lb:peak', 'cheat_5'), null, 'back on the board');
  });
  await t('anti-cheat: admin can quarantine an account by hand', async () => {
    assert.strictEqual((await adm({ action: 'quarantine', username: 'cheat_5' }, O, 8)).code, 200);
    assert.strictEqual(await getStore().zrevrank('lb:peak', 'cheat_5'), null);
    const r = await sync({ coins: 7000 }); assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual(await getStore().zrevrank('lb:peak', 'cheat_5'), null, 'stays hidden');
    assert.strictEqual((await adm({ action: 'unflag', username: 'cheat_5' }, O, 8)).code, 200);
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
  await t('upgrade caps rise with each ascension up to the final max; old clients without ucv are only soft', async () => {
    const { inspect, upCap, UP_MAX } = require('../lib/cheat'), now = Date.now();
    const run = (o, x) => { const b = mk(o, x); return inspect(b, JSON.parse(b.save), null, now); };
    assert.strictEqual(upCap('val', 0), 20);
    assert.strictEqual(upCap('val', 5), 35);
    assert.strictEqual(upCap('val', 10), 50);
    assert.strictEqual(upCap('val', 20), 50, 'never above the final max');
    for (const k of Object.keys(UP_MAX)) { let p = 0; for (let a = 0; a <= 20; a++) { const c = upCap(k, a); assert.ok(c >= p && c <= UP_MAX[k], k + ' at ' + a); p = c; } assert.strictEqual(p, UP_MAX[k]); }
    assert.ok(!run({}, { g: { ucv: 1, up: { val: 20 } } }).hard.length, 'at the cap');
    assert.ok(run({}, { g: { ucv: 1, up: { val: 21 } } }).hard.includes('upgrade cap val'), 'over the cap with a current client');
    const old = run({}, { g: { up: { val: 21 } } });
    assert.ok(!old.hard.length && old.soft.includes('upgrade cap val'), 'an old client that has not clamped yet');
    assert.ok(!run({ asc: 5 }, { g: { ucv: 1, up: { val: 35 } } }).hard.length, 'the cap rose with ascensions');
    assert.ok(run({}, { g: { up: { val: 51 } } }).hard.includes('upgrade val'), 'above the final max is always hard');
  });
  await t('farm and food: slots, no crew+farm, and Food is bounded', async () => {
    const { inspect } = require('../lib/cheat'), now = Date.now();
    const run = (o, x) => { const b = mk(o, x); return inspect(b, JSON.parse(b.save), null, now); };
    const two = [[1, 2, 0, 1, 0, 0, 0, 1], [2, 1, 0, 1, 0, 0, 0, 1]];
    assert.ok(run({}, { faces: two }).hard.includes('too many farmers'), '2 farmers with 1 plot');
    assert.ok(!run({}, { faces: two, g: { up: { farm: 1 } } }).hard.length, 'a second plot');
    assert.ok(run({}, { faces: [[1, 2, 0, 1, 1, 0, 0, 1], [2, 1, 0, 1, 0, 0, 0, 0]] }).hard.includes('crew and farm'));
    assert.ok(run({}, { g: { food: 1e13 } }).hard.includes('food'), 'above the hard ceiling');
    assert.ok(run({}, { g: { food: -5 } }).hard.includes('food'));
    assert.ok(run({}, { g: { food: 1e6 } }).hard.includes('food'), 'a lot of Food with nobody on the farm');
    assert.ok(run({}, { g: { food: 100 } }).soft.includes('food'));
    assert.ok(!run({}, { faces: two, g: { up: { farm: 1 }, food: 5000 } }).soft.includes('food'), 'Food the farmers could have grown');
  });
  await t('client upMax and UP_FULL_ASC match lib/cheat.js upCap', async () => {
    const cheat = require('../lib/cheat');
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const fn = /function upMax\(k,a\)\{[^\n]*\}/.exec(html), fa = /UP_FULL_ASC=(\d+)/.exec(html), uf = /function upFull\(k\)\{[^\n]*\}/.exec(html);
    assert.ok(fn && fa && uf, 'client has upMax, upFull and UP_FULL_ASC');
    assert.strictEqual(+fa[1], cheat.UP_FULL_ASC);
    const UPS = {}; for (const k of Object.keys(cheat.UP_MAX)) UPS[k] = { max: cheat.UP_MAX[k] };
    const upMax = new Function('UPS', 'G', 'UP_FULL_ASC', 'MAX_ASC', uf[0] + ';' + fn[0] + '; return upMax;')(UPS, { asc: 0 }, +fa[1], 20);
    // The headline sizes at the maximum ascension: Base 100, Crew 20, Farm 30.
    assert.strictEqual(cheat.baseCap(cheat.upCap('cap', 20)), 100);
    assert.strictEqual(1 + cheat.upCap('crew', 20), 20);
    assert.strictEqual(1 + cheat.upCap('farm', 20), 30);
    for (const k of Object.keys(UPS)) for (let a = 0; a <= 20; a++) assert.strictEqual(upMax(k, a), cheat.upCap(k, a), k + ' at ascension ' + a);
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

  await t('wrong admin codes are rate limited per IP and per account (429), even the right code waits', async () => {
    const X = await signupAs('guess_1', 'guess-pw-1', 56);
    let last; for (let i = 0; i < 7; i++) last = await adm({ action: 'redeem', code: mkCode() }, X, 9);
    assert.strictEqual(last.code, 429);
    assert.strictEqual((await adm({ action: 'redeem', code: codes.spare }, X, 9)).code, 429, 'same IP and account');
    assert.strictEqual((await adm({ action: 'redeem', code: codes.spare }, X, 10)).code, 429, 'the account stays locked from another IP');
    assert.strictEqual(await getStore().get('adm:guess_1'), null, 'nothing was bound');
    const Y = await signupAs('guess_2', 'guess-pw-2', 57);
    const ok = await adm({ action: 'redeem', code: codes.spare }, Y, 11);
    assert.strictEqual(ok.code, 200, 'another account is not locked out: ' + JSON.stringify(ok.j));
  });

  await t('a successful sync returns the live build id so open tabs can notice a new version', async () => {
    const X = await signupAs('build_1', 'build-pw-1', 71);
    const r = await call('POST', '/api/submit', mk(), X);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual(r.j.build, require('../lib/build').currentBuild());
  });

  // ---- lifetime ranking, DEV tags, owner switch ----
  let LA, LB;
  const lsub = async (name, token, o, x) => { unlock(name); return call('POST', '/api/submit', mk(o, x), token); };
  await t('lifetime board: the default view ranks by lifetime earnings and a client without "life" falls back to coins', async () => {
    LA = await signupAs('life_a', 'life-pw-1', 80);
    LB = await signupAs('life_b', 'life-pw-2', 81);
    let r = await lsub('life_a', LA, { coins: 5e6, life: 5e6, book: 9 }); assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    r = await lsub('life_b', LB, { coins: 2e6 }); assert.strictEqual(r.code, 200, JSON.stringify(r.j)); // no life sent
    const lb = await call('GET', '/api/leaderboard?n=100');
    const names = lb.j.rows.map((x) => x.name);
    assert.strictEqual(names[0], 'life_a');
    assert.ok(names.indexOf('life_a') < names.indexOf('life_b'));
    const pb = (await call('GET', '/api/leaderboard?u=life_b')).j.profile;
    assert.strictEqual(pb.life, 2e6, 'falls back to coins');
    assert.ok(!pb.dev, 'a normal player has no DEV tag');
    assert.strictEqual((await call('GET', '/api/leaderboard?view=life', undefined, LA)).j.me.rank, 1);
  });
  await t('lifetime board: a player keeps their rank and best Book after ascending', async () => {
    const before = (await call('GET', '/api/me', undefined, LA)).j.rank; assert.strictEqual(before, 1);
    await age('life_a');
    const r = await lsub('life_a', LA, { asc: 1, coins: 10, life: 5e6, book: 3 }); assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual((await call('GET', '/api/me', undefined, LA)).j.rank, 1, 'still first after the run was reset');
    const p = (await call('GET', '/api/leaderboard?u=life_a')).j.profile;
    assert.strictEqual(p.life, 5e6); assert.strictEqual(p.asc, 1); assert.strictEqual(p.bookMax, 9, 'best Book ever is kept'); assert.strictEqual(p.peak, 5e6);
    const bk = await call('GET', '/api/leaderboard?view=book');
    assert.strictEqual(bk.j.rows[0].name, 'life_a');
    assert.strictEqual((await call('GET', '/api/leaderboard?view=peak')).code, 200, 'the old boards still work');
  });
  await t('lifetime plausibility: a first sync with absurd lifetime earnings is refused', async () => {
    const X = await signupAs('life_c', 'life-pw-3', 82);
    const r = await lsub('life_c', X, { coins: 1000, life: 1e22 });
    assert.strictEqual(r.code, 422, JSON.stringify(r.j));
    assert.strictEqual((await call('GET', '/api/leaderboard?u=life_c')).code, 404, 'nothing was stored');
  });
  await t('DEV tags: owners are tagged, staff and players are not until an owner gives them the tag (owner only)', async () => {
    const st = (await call('POST', '/api/login', { username: 'guess_2', password: 'guess-pw-2' }, undefined, ipOf(57)));
    assert.strictEqual(st.code, 200, JSON.stringify(st.j));
    assert.strictEqual((await lsub('guess_2', st.j.token, { coins: 3000 })).code, 200);
    const r = await lsub('boss_1', O, { coins: 4000 }); assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    const rows = (await call('GET', '/api/leaderboard?n=100')).j.rows, by = (n) => rows.find((x) => x.name === n);
    assert.strictEqual(by('boss_1').dev, 'owner'); assert.ok(!by('guess_2').dev, 'staff admins have no tag by default');
    assert.ok(!by('life_a').dev && !by('life_b').dev);
    assert.strictEqual((await call('GET', '/api/leaderboard?u=boss_1')).j.profile.dev, 'owner');
    assert.ok(!(await call('GET', '/api/leaderboard?u=guess_2')).j.profile.dev);
    const tagged = async (n) => (await call('GET', '/api/leaderboard?n=100')).j.rows.find((x) => x.name === n).dev;
    assert.strictEqual((await adm({ action: 'devtag', username: 'life_a' }, st.j.token, 7)).code, 403, 'staff cannot give tags');
    assert.strictEqual((await adm({ action: 'devtag', username: 'guess_2' }, st.j.token, 7)).code, 403, 'not even to themselves');
    assert.strictEqual((await adm({ action: 'devtag', username: 'nobody_x' }, O, 7)).code, 404);
    assert.strictEqual((await adm({ action: 'devtag', username: 'life_a' }, O, 7)).code, 200);
    assert.strictEqual(await tagged('life_a'), 'dev');
    assert.strictEqual((await call('GET', '/api/leaderboard?u=life_a')).j.profile.dev, 'dev');
    assert.strictEqual((await adm({ action: 'devtag', username: 'guess_2' }, O, 7)).code, 200, 'an owner may tag staff');
    assert.strictEqual(await tagged('guess_2'), 'dev');
    assert.strictEqual((await adm({ action: 'undevtag', username: 'life_a' }, st.j.token, 7)).code, 403, 'staff cannot remove tags');
    assert.strictEqual((await adm({ action: 'undevtag', username: 'life_a' }, O, 7)).code, 200);
    assert.strictEqual((await adm({ action: 'undevtag', username: 'guess_2' }, O, 7)).code, 200);
    assert.ok(!(await tagged('life_a')) && !(await tagged('guess_2')));
  });
  await t('owner switch: an owner may sync a fully maxed account, anyone else is refused', async () => {
    const maxed = { asc: 20, bestRar: 16, book: 80, coins: 1e12, life: 1e13, inc: 1e9, top: [[16, 4, 2], [15, 0, 1]] };
    let r = await lsub('life_b', LB, maxed);
    assert.strictEqual(r.code, 422, 'a normal player cannot jump to 20 ascensions: ' + JSON.stringify(r.j));
    r = await lsub('boss_1', O, maxed);
    assert.strictEqual(r.code, 200, 'the owner can: ' + JSON.stringify(r.j));
    const lb = await call('GET', '/api/leaderboard?n=100');
    assert.strictEqual(lb.j.rows[0].name, 'boss_1'); assert.strictEqual(lb.j.rows[0].dev, 'owner');
    const p = (await call('GET', '/api/leaderboard?u=boss_1')).j.profile;
    assert.strictEqual(p.asc, 20); assert.strictEqual(p.life, 1e13);
    assert.strictEqual((await call('GET', '/api/me', undefined, O)).j.rank, 1);
  });

  // ---- trading ----
  let T1, T2;
  const tc = (m, b, tok) => call(m, '/api/trade', b, tok);
  const T1F = [[1, 2, 0, 1, 0, 0, 0, 0], [2, 1, 0, 1, 0, 0, 0, 0], [3, 0, 0, 1, 0, 1, 0, 0]];
  const T2F = [[1, 1, 0, 1, 0, 0, 0, 0], [2, 0, 0, 1, 0, 0, 0, 0], [3, 2, 1, 1, 0, 0, 0, 0]];
  const T1O = { top: [[2, 0, 1], [1, 0, 1], [0, 0, 1]] };
  const T2O = { top: [[2, 1, 1], [1, 0, 1], [0, 0, 1]] };
  await t('trade: needs sign-in, and invites are validated', async () => {
    T1 = await signupAs('trade_a', 'secret-a1', 91);
    T2 = await signupAs('trade_b', 'secret-b1', 92);
    assert.strictEqual((await tc('GET')).code, 401);
    assert.strictEqual((await tc('POST', { action: 'invite', username: 'trade_b' })).code, 401);
    assert.strictEqual((await tc('POST', { action: 'invite', username: 'x' }, T1)).code, 400);
    assert.strictEqual((await tc('POST', { action: 'invite', username: 'TRADE_A' }, T1)).code, 400, 'not yourself');
    assert.strictEqual((await tc('POST', { action: 'invite', username: 'nobody_here' }, T1)).code, 404);
    assert.strictEqual((await tc('POST', { action: 'offer', fid: 1, face: [2, 0, 1] }, T1)).code, 404, 'not in a trade');
    assert.strictEqual((await lsub('trade_a', T1, T1O, { faces: T1F })).code, 200);
    assert.strictEqual((await lsub('trade_b', T2, T2O, { faces: T2F })).code, 200);
  });
  await t('trade: blocking invites stops new invites', async () => {
    assert.strictEqual((await tc('POST', { action: 'prefs', block: true }, T2)).code, 200);
    const r = await tc('POST', { action: 'invite', username: 'trade_b' }, T1);
    assert.strictEqual(r.code, 403, JSON.stringify(r.j));
    assert.strictEqual((await tc('POST', { action: 'prefs', block: false }, T2)).code, 200);
  });
  await t('trade: invite, accept, offer, confirm swaps the faces through the delivery boxes', async () => {
    let r = await tc('POST', { action: 'invite', username: 'trade_b' }, T1);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual(r.j.trade.s, 'invited'); assert.ok(r.j.trade.inviter);
    r = await tc('GET', undefined, T2);
    assert.strictEqual(r.j.trade.s, 'invited'); assert.strictEqual(r.j.trade.inviter, false); assert.strictEqual(r.j.trade.partner, 'trade_a');
    assert.strictEqual((await tc('POST', { action: 'invite', username: 'trade_a' }, T2)).code, 409, 'busy');
    assert.strictEqual((await tc('POST', { action: 'accept' }, T1)).code, 409, 'only the invited player may accept');
    assert.strictEqual((await tc('POST', { action: 'offer', fid: 1, face: [2, 0, 1] }, T1)).code, 409, 'no offers before accepting');
    assert.strictEqual((await tc('POST', { action: 'accept' }, T2)).code, 200);
    // faces that cannot be offered
    assert.strictEqual((await tc('POST', { action: 'offer', fid: 3, face: [0, 0, 1] }, T1)).code, 409, 'locked face');
    assert.strictEqual((await tc('POST', { action: 'offer', fid: 99, face: [2, 0, 1] }, T1)).code, 409, 'unknown face');
    assert.strictEqual((await tc('POST', { action: 'offer', fid: 1, face: [5, 0, 1] }, T1)).code, 409, 'face does not match the save');
    r = await tc('POST', { action: 'offer', fid: 1, face: [2, 0, 1] }, T1);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j)); assert.deepStrictEqual(r.j.trade.mine.slice(0, 3), [2, 0, 1]);
    assert.strictEqual((await tc('POST', { action: 'confirm', v: r.j.trade.v }, T1)).code, 409, 'both must offer first');
    r = await tc('POST', { action: 'offer', fid: 3, face: [2, 1, 1] }, T2);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    const v = r.j.trade.v;
    assert.strictEqual((await tc('POST', { action: 'confirm', v: v - 1 }, T1)).code, 409, 'stale version');
    r = await tc('POST', { action: 'confirm', v }, T1);
    assert.ok(r.j.trade.myConf && !r.j.trade.theirConf);
    assert.strictEqual((await tc('POST', { action: 'confirm', v }, T2)).code, 200);
    r = await tc('GET', undefined, T1);
    assert.strictEqual(r.j.trade.s, 'done');
    const b1 = r.j.box.filter((d) => d.why === 'trade'), b2 = (await tc('GET', undefined, T2)).j.box.filter((d) => d.why === 'trade');
    assert.strictEqual(b1.length, 1); assert.deepStrictEqual(b1[0].f.slice(0, 3), [2, 1, 1]); assert.strictEqual(b1[0].from, 'trade_b');
    assert.strictEqual(b2.length, 1); assert.deepStrictEqual(b2[0].f.slice(0, 3), [2, 0, 1]);
    r = await tc('POST', { action: 'claim', ids: [b1[0].d] }, T1);
    assert.strictEqual(r.j.box.length, 0, 'claimed deliveries are removed');
    await tc('POST', { action: 'claim', ids: [b2[0].d] }, T2);
    await tc('POST', { action: 'ack' }, T1); await tc('POST', { action: 'ack' }, T2);
    assert.strictEqual((await tc('GET', undefined, T1)).j.trade, null);
  });
  await t('trade: an offered face cannot stay in the synced saves of the player who offered it (no duplicating)', async () => {
    let r = await lsub('trade_a', T1, T1O, { faces: T1F });
    assert.strictEqual(r.code, 422, 'the traded face is still in this save: ' + JSON.stringify(r.j));
    assert.match(r.j.error, /still in your save/);
    // Moving the offered face (same id) into the backpack must not hide it from the check.
    r = await lsub('trade_a', T1, { top: [[1, 0, 1], [0, 0, 1]] }, { faces: T1F.slice(1), bp: [[1, 2, 0, 1, 0]] });
    assert.strictEqual(r.code, 422, 'the traded face is still in the backpack: ' + JSON.stringify(r.j));
    assert.match(r.j.error, /still in your save/);
    r = await lsub('trade_a', T1, { top: [[1, 0, 1], [0, 0, 1]] }, { faces: T1F.slice(1) });
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
  });
  await t('trade: cancelling returns the offered face to its owner', async () => {
    assert.strictEqual((await tc('POST', { action: 'invite', username: 'trade_b' }, T1)).code, 200);
    assert.strictEqual((await tc('POST', { action: 'accept' }, T2)).code, 200);
    const r = await tc('POST', { action: 'offer', fid: 2, face: [1, 0, 1] }, T1);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual((await tc('POST', { action: 'cancel' }, T2)).code, 200);
    const s = await tc('GET', undefined, T1);
    assert.strictEqual(s.j.trade.s, 'cancelled');
    const ret = s.j.box.filter((d) => d.why === 'return');
    assert.strictEqual(ret.length, 1); assert.deepStrictEqual(ret[0].f.slice(0, 3), [1, 0, 1]);
    assert.strictEqual((await tc('POST', { action: 'offer', fid: 2, face: [1, 0, 1] }, T1)).code, 409, 'a finished trade takes no more offers');
    await tc('POST', { action: 'ack' }, T1); await tc('POST', { action: 'ack' }, T2);
    assert.strictEqual((await tc('POST', { action: 'offer', fid: 2, face: [1, 0, 1] }, T1)).code, 404, 'after acknowledging, the player is not in a trade');
  });
  await t('trade: faces in the backpack, on the farm and on the crew can be offered; locked faces still cannot', async () => {
    await getStore().del('rl:trade:trade_a');
    // 10 sits in the backpack, 11 is on the farm (flag 7), 12 is on the crew (flag 4), 3 is locked (flag 5).
    const sv = { faces: [[3, 0, 0, 1, 0, 1, 0, 0], [11, 1, 0, 1, 0, 0, 0, 1], [12, 0, 0, 1, 1, 0, 0, 0]], bp: [[10, 1, 0, 1, 0]] };
    let r = await lsub('trade_a', T1, { top: [[1, 0, 1], [0, 0, 1]] }, sv);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual((await tc('POST', { action: 'invite', username: 'trade_b' }, T1)).code, 200);
    assert.strictEqual((await tc('POST', { action: 'accept' }, T2)).code, 200);
    assert.strictEqual((await tc('POST', { action: 'offer', fid: 3, face: [0, 0, 1] }, T1)).code, 409, 'locked face');
    r = await tc('POST', { action: 'offer', fid: 10, face: [1, 0, 1] }, T1);
    assert.strictEqual(r.code, 200, 'backpack face: ' + JSON.stringify(r.j));
    assert.deepStrictEqual(r.j.trade.mine.slice(0, 3), [1, 0, 1]);
    r = await tc('POST', { action: 'offer', fid: 11, face: [1, 0, 1] }, T1);
    assert.strictEqual(r.code, 200, 'farm face: ' + JSON.stringify(r.j));
    r = await tc('POST', { action: 'offer', fid: 12, face: [0, 0, 1] }, T1);
    assert.strictEqual(r.code, 200, 'crew face: ' + JSON.stringify(r.j));
    assert.strictEqual((await tc('POST', { action: 'offer', fid: 10, face: [1, 0, 1] }, T1)).code, 409, 'a face already used in this trade');
    assert.strictEqual((await tc('POST', { action: 'cancel' }, T2)).code, 200);
    await tc('POST', { action: 'ack' }, T1); await tc('POST', { action: 'ack' }, T2);
    // The offered faces are gone from the player's hands, so the next sync no longer holds them.
    r = await lsub('trade_a', T1, { top: [[0, 0, 1]], inc: 1 }, { faces: [[3, 0, 0, 1, 0, 1, 0, 0]] });
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
  });
  await t('trade: a full backpack cannot offer or confirm, because received faces go into the backpack', async () => {
    await getStore().del('rl:trade:trade_a');
    const bpFull = [];
    for (let i = 0; i < 3000; i++) bpFull.push([100 + i, 0, 0, 1, 0]);
    let r = await lsub('trade_a', T1, { top: [[0, 0, 1]], inc: 1 }, { faces: [[3, 0, 0, 1, 0, 1, 0, 0]], bp: bpFull });
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.strictEqual((await tc('POST', { action: 'invite', username: 'trade_b' }, T1)).code, 200);
    assert.strictEqual((await tc('POST', { action: 'accept' }, T2)).code, 200);
    r = await tc('POST', { action: 'offer', fid: 100, face: [0, 0, 1] }, T1);
    assert.strictEqual(r.code, 409, JSON.stringify(r.j));
    assert.match(r.j.error, /backpack is full/);
    assert.strictEqual((await tc('POST', { action: 'cancel' }, T1)).code, 200);
    await tc('POST', { action: 'ack' }, T1); await tc('POST', { action: 'ack' }, T2);
    r = await lsub('trade_a', T1, { top: [[0, 0, 1]], inc: 1 }, { faces: [[3, 0, 0, 1, 0, 1, 0, 0]] });
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
  });

  // ---- forced update (client rev) and the chat room ----
  let C1, C2, CA;
  const cc = (m, b, tok) => call(m, m === 'GET' ? '/api/chat' + (b || '') : '/api/chat', m === 'GET' ? undefined : b, tok); // for GET, b is the query string
  const rl = (n) => getStore().del('rl:chat:' + n);

  await t('a sync without the current client rev is 409 and required; the current rev is accepted', async () => {
    const R = await signupAs('rev_user', 'secret-r1', 96); unlock('rev_user');
    const b = stats(); delete b.rev;
    const r = await call('POST', '/api/submit', b, R);
    assert.strictEqual(r.code, 409); assert.strictEqual(r.j.required, true); assert.match(r.j.build, /^[0-9a-f]{12}$/);
    unlock('rev_user'); assert.strictEqual((await call('POST', '/api/submit', stats({ rev: 1 }), R)).code, 409, 'an older rev is refused too');
    unlock('rev_user'); const ok = await call('POST', '/api/submit', mk(), R); assert.strictEqual(ok.code, 200, JSON.stringify(ok.j));
  });
  await t('chat needs a session', async () => {
    assert.strictEqual((await cc('GET', '?after=0')).code, 401);
    assert.strictEqual((await cc('POST', { text: 'hi' })).code, 401);
  });
  await t('chat: messages are shared and ordered, carry the registered name, and a poll returns only the new ones', async () => {
    C1 = await signupAs('chat_one', 'secret-c1', 93); C2 = await signupAs('Chat_Two', 'secret-c2', 94);
    const e = await cc('GET', '?after=0', C1); assert.strictEqual(e.code, 200); assert.deepStrictEqual(e.j, { seq: 0, msgs: [] });
    const a = await cc('POST', { text: 'hello   there' }, C1);
    assert.strictEqual(a.code, 200, JSON.stringify(a.j)); assert.strictEqual(a.j.msg.t, 'hello there'); assert.strictEqual(a.j.msg.n, 'chat_one');
    assert.strictEqual((await cc('POST', { text: 'hi back' }, C2)).code, 200);
    const all = await cc('GET', '?after=0', C2);
    assert.deepStrictEqual(all.j.msgs.map((m) => m.t), ['hello there', 'hi back']);
    assert.strictEqual(all.j.msgs[1].n, 'Chat_Two'); assert.strictEqual(all.j.seq, 2);
    assert.deepStrictEqual((await cc('GET', '?after=1', C1)).j.msgs.map((m) => m.t), ['hi back']);
    assert.deepStrictEqual((await cc('GET', '?after=2', C1)).j.msgs, []);
    assert.strictEqual((await cc('GET', '?after=99', C1)).j.msgs.length, 2, 'an id from a reset room starts over');
  });
  await t('chat: empty, malformed, control-character, over-long and repeated messages are handled', async () => {
    await rl('chat_one');
    assert.strictEqual((await cc('POST', { text: '   ' }, C1)).code, 400);
    assert.strictEqual((await cc('POST', { text: 123 }, C1)).code, 400);
    assert.strictEqual((await cc('POST', '{bad', C1)).code, 400);
    const r = await cc('POST', { text: 'a\u0000b\u202ec' + 'x'.repeat(300) }, C1);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.j.msg.t.length, 200); assert.ok(!/[\u0000\u202e]/.test(r.j.msg.t));
    assert.strictEqual((await cc('POST', { text: r.j.msg.t }, C1)).code, 429, 'the same text twice in a row');
  });
  await t('chat: sending too fast is 429', async () => {
    await rl('chat_two'); let last;
    for (let i = 0; i < 8; i++) last = await cc('POST', { text: 'spam ' + i }, C2);
    assert.strictEqual(last.code, 429);
  });
  await t('chat: the room keeps the newest 60 messages and a first poll sends the latest 40', async () => {
    const st = getStore(); await st.del('chat:log'); await st.del('chat:seq');
    for (let i = 0; i < 120; i++) { await rl('chat_one'); await st.del('chatd:chat_one'); await cc('POST', { text: 'm' + i }, C1); }
    const r = await cc('GET', '?after=0', C1);
    assert.strictEqual(r.j.msgs.length, 40); assert.strictEqual(r.j.msgs[0].t, 'm80'); assert.strictEqual(r.j.msgs[39].t, 'm119'); assert.strictEqual(r.j.seq, 120);
    const rest = await cc('GET', '?after=20', C1);
    assert.strictEqual(rest.j.msgs.length, 60); assert.strictEqual(rest.j.msgs[0].t, 'm60');
  });
  await t('chat: only admins can mute or clear; a muted player cannot talk until unmuted', async () => {
    const code = mkCode(); setCodes(allCodes().concat(hashCode(code)));
    CA = await signupAs('chat_admin', 'secret-ca', 95);
    assert.strictEqual((await adm({ action: 'redeem', code }, CA, 95)).code, 200);
    await rl('chat_one'); await rl('chat_two'); await rl('chat_admin');
    assert.strictEqual((await cc('POST', { mute: 'chat_two', mins: 5 }, C1)).code, 403, 'a normal player cannot mute');
    assert.strictEqual((await cc('POST', { clear: true }, C1)).code, 403, 'a normal player cannot clear');
    const m = await cc('POST', { mute: 'chat_two', mins: 5 }, CA); assert.strictEqual(m.code, 200, JSON.stringify(m.j));
    await rl('chat_two'); assert.strictEqual((await cc('POST', { text: 'let me talk' }, C2)).code, 403);
    assert.strictEqual((await cc('POST', { mute: 'chat_admin', mins: 5 }, CA)).code, 403, 'admins cannot be muted');
    assert.strictEqual((await cc('POST', { mute: 'nobody_here', mins: 5 }, CA)).code, 404);
    assert.strictEqual((await cc('POST', { mute: 'chat_two', mins: 0 }, CA)).code, 200);
    await rl('chat_two'); assert.strictEqual((await cc('POST', { text: 'back again' }, C2)).code, 200);
    assert.strictEqual((await cc('POST', { clear: true }, CA)).code, 200);
    assert.deepStrictEqual((await cc('GET', '?after=50', C1)).j, { seq: 0, msgs: [] }, 'clients holding a higher id are told to drop everything');
  });

  await t('owner panel: mute for a chosen time, unmute, and only admins may', async () => {
    await rl('chat_two'); await getStore().del('chatd:chat_two');
    assert.strictEqual((await adm({ action: 'mute', username: 'chat_two', mins: 60 }, C1, 95)).code, 403, 'a normal player cannot');
    assert.strictEqual((await adm({ action: 'mute', username: 'chat_two' }, CA, 95)).code, 422, 'a length is required');
    assert.strictEqual((await adm({ action: 'mute', username: 'chat_two', mins: 99999 }, CA, 95)).code, 422, 'too long');
    assert.strictEqual((await adm({ action: 'mute', username: 'chat_admin', mins: 5 }, CA, 95)).code, 422, 'not on yourself');
    const m = await adm({ action: 'mute', username: 'chat_two', mins: 60 }, CA, 95);
    assert.strictEqual(m.code, 200, JSON.stringify(m.j)); assert.match(m.j.note, /1 hour/);
    const r = await cc('POST', { text: 'muted?' }, C2);
    assert.strictEqual(r.code, 403); assert.match(r.j.error, /1 hour/);
    assert.strictEqual((await adm({ action: 'unmute', username: 'chat_two' }, CA, 95)).code, 200);
    await rl('chat_two'); assert.strictEqual((await cc('POST', { text: 'free again' }, C2)).code, 200);
  });

  await t('trade: the online list shows recent players, hides you and players who block invites, and drops expired ones', async () => {
    const tradeApi = require('../api/trade');
    const store = getStore();
    const ol = async (name, tok) => { tradeApi.resetOnline(); await store.del('rl:trade:' + name); return call('GET', '/api/trade?online=1', undefined, tok); };
    assert.strictEqual((await call('GET', '/api/trade?online=1')).code, 401, 'needs sign-in');
    await store.del('rl:trade:trade_b');
    const plain = await tc('GET', undefined, T2);
    assert.strictEqual(plain.j.online, undefined, 'the list is only sent when asked for');
    await ol('trade_b', T2);
    let r = await ol('trade_a', T1);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    assert.ok(Array.isArray(r.j.online));
    assert.ok(r.j.online.includes('trade_b'), 'a player who just polled is listed: ' + JSON.stringify(r.j.online));
    assert.ok(!r.j.online.includes('trade_a'), 'you are not in your own list');
    // blocking invites hides a player
    assert.strictEqual((await tc('POST', { action: 'prefs', block: true }, T2)).code, 200);
    r = await ol('trade_a', T1);
    assert.ok(!r.j.online.includes('trade_b'), 'a player blocking invites is not listed');
    await store.del('rl:trade:trade_b');
    assert.strictEqual((await tc('POST', { action: 'prefs', block: false }, T2)).code, 200);
    r = await ol('trade_a', T1);
    assert.ok(r.j.online.includes('trade_b'), 'listed again once unblocked');
    // an expired presence key drops the player and cleans the set
    await store.del('on:trade_b');
    r = await ol('trade_a', T1);
    assert.ok(!r.j.online.includes('trade_b'), 'expired players are not listed');
    assert.ok(!(await store.zrevrange('online', 0, -1)).includes('trade_b'), 'and are removed from the set');
    // clicking a listed name is the normal invite
    await ol('trade_b', T2);
    r = await ol('trade_a', T1);
    const nm = r.j.online.find((n) => n.toLowerCase() === 'trade_b');
    assert.ok(nm, 'listed to click');
    await store.del('rl:trade:trade_a');
    r = await tc('POST', { action: 'invite', username: nm }, T1);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.trade.s, 'invited');
    assert.strictEqual((await tc('POST', { action: 'cancel' }, T1)).code, 200);
    await tc('POST', { action: 'ack' }, T1); await tc('POST', { action: 'ack' }, T2);
  });

  await t('owner panel: giveface sends faces to a player\'s delivery box, owner only, validated, capped by ascension and by box size', async () => {
    const u = require('../lib/util'), store = getStore();
    const give = (body, tok) => adm({ action: 'giveface', username: 'trade_b', ...body }, tok, 97);
    const boxOf = async () => { await store.del('rl:trade:trade_b'); return (await tc('GET', undefined, T2)).j.box; };
    const clear = async () => { const b = await boxOf(); if (b.length) await tc('POST', { action: 'claim', ids: b.map((d) => d.d) }, T2); };
    await clear();
    assert.strictEqual((await give({ rar: 1, mut: 0, lvl: 1 }, T1)).code, 403, 'a normal player cannot (staff are refused by the same owner-tier check)');
    assert.strictEqual((await give({ rar: 1, mut: 0, lvl: 1 })).code, 401, 'sign-in needed');
    assert.strictEqual((await adm({ action: 'giveface', username: 'nobody_x', rar: 1, mut: 0, lvl: 1 }, O, 97)).code, 404);
    for (const bad of [{ rar: u.NR, mut: 0, lvl: 1 }, { rar: -1, mut: 0, lvl: 1 }, { rar: 1, mut: u.NM, lvl: 1 }, { rar: 1, mut: 0, lvl: 0 }, { rar: 1, mut: 0, lvl: 21 }, { rar: 1, mut: 0, lvl: 1, count: 11 }, { rar: 1.5, mut: 0, lvl: 1 }, { mut: 0, lvl: 1 }]) {
      assert.strictEqual((await give(bad, O)).code, 422, JSON.stringify(bad));
    }
    assert.strictEqual((await boxOf()).length, 0, 'refused grants leave the box alone');
    const cap = u.maxRarFor(0);
    if (cap + 1 < u.NR) assert.strictEqual((await give({ rar: cap + 1, mut: 0, lvl: 1 }, O)).code, 422, 'above what their ascension can hold');
    const r = await give({ rar: 1, mut: 1, lvl: 5, count: 2 }, O);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j)); assert.match(r.j.note, /2 faces/);
    const box = (await boxOf()).filter((d) => d.why === 'grant');
    assert.strictEqual(box.length, 2); assert.deepStrictEqual(box[0].f, [1, 1, 5, 0]);
    assert.notStrictEqual(box[0].d, box[1].d, 'each entry has its own id, so the client can tell them apart');
    await clear();
    assert.strictEqual((await boxOf()).length, 0, 'claimed grants are removed');
    for (let i = 0; i < 3; i++) assert.strictEqual((await give({ rar: 0, mut: 0, lvl: 1, count: 10 }, O)).code, 200);
    const full = await give({ rar: 0, mut: 0, lvl: 1 }, O);
    assert.strictEqual(full.code, 409, 'a full box is never overwritten'); assert.match(full.j.error, /full/);
    await clear();
  });

  await t('owner panel: an owner can make a player a staff admin without a code and revoke it at any time; granted staff cannot give faces or make admins', async () => {
    const G1 = await signupAs('grant_s', 'grant-pw-1', 98);
    const ad = (body, tok) => adm(body, tok, 98);
    assert.strictEqual((await ad({ action: 'makeadmin', username: 'grant_s' }, G1)).code, 403, 'a normal player cannot');
    assert.strictEqual((await ad({ action: 'makeadmin', username: 'nobody_x' }, O)).code, 404);
    assert.strictEqual((await ad({ action: 'makeadmin', username: 'boss_1' }, O)).code, 422, 'not yourself');
    const r = await ad({ action: 'makeadmin', username: 'grant_s' }, O);
    assert.strictEqual(r.code, 200, JSON.stringify(r.j));
    const s = await statusOf(G1, 98); assert.strictEqual(s.admin, true); assert.strictEqual(s.tier, 'staff');
    assert.strictEqual((await ad({ action: 'makeadmin', username: 'grant_s' }, O)).code, 409, 'already an admin');
    assert.strictEqual((await ad({ action: 'mute', username: 'trade_b', mins: 5 }, G1)).code, 200, 'staff can mute');
    assert.strictEqual((await ad({ action: 'unmute', username: 'trade_b' }, G1)).code, 200);
    assert.strictEqual((await ad({ action: 'giveface', username: 'trade_b', rar: 1, mut: 0, lvl: 1 }, G1)).code, 403, 'staff cannot give faces');
    assert.strictEqual((await ad({ action: 'giveface', username: 'grant_s', rar: 1, mut: 0, lvl: 1 }, G1)).code, 403, 'nor to themselves');
    assert.strictEqual((await ad({ action: 'makeadmin', username: 'trade_b' }, G1)).code, 403, 'staff cannot make admins');
    assert.strictEqual((await ad({ action: 'revoke', username: 'boss_1' }, G1)).code, 403, 'staff cannot revoke');
    assert.strictEqual((await ad({ action: 'revoke', username: 'grant_s' }, O)).code, 200, 'owner revokes at any time');
    assert.strictEqual((await statusOf(G1, 98)).admin, false);
    assert.strictEqual((await ad({ action: 'mute', username: 'trade_b', mins: 5 }, G1)).code, 403, 'revoked at once');
    assert.strictEqual((await ad({ action: 'makeadmin', username: 'grant_s' }, O)).code, 200, 'can be made admin again');
    assert.strictEqual((await ad({ action: 'revoke', username: 'grant_s' }, O)).code, 200);
  });

  await t('expansion: the event schedule is deterministic, never repeats back to back, stays inside its slot and runs a sensible share of the time', async () => {
    const x = require('../lib/expansion'), t0 = Date.UTC(2026, 10, 13), s0 = Math.floor(t0 / x.SLOT_MS);
    let on = 0, total = 7 * 1440;
    for (let m = 0; m < total; m++) {
      const a = x.activeEvent(t0 + m * 60000), b = x.activeEvent(t0 + m * 60000);
      assert.deepStrictEqual(a, b, 'same time, same answer');
      if (a) on++;
    }
    assert.ok(on / total > 0.05 && on / total < 0.3, 'events run ' + (on / total * 100).toFixed(1) + '% of the time');
    for (let s = s0; s < s0 + 1000; s++) {
      const e = x.slotEvent(s), n = x.slotEvent(s + 1);
      if (e) { assert.ok(e.start >= s * x.SLOT_MS && e.end <= (s + 1) * x.SLOT_MS, 'event stays inside its slot'); assert.ok(e.ev.dur < x.SLOT_MS); }
      if (e && n) assert.notStrictEqual(e.ev.id, n.ev.id, 'no event twice in a row');
    }
    const nx = x.nextEvent(t0);
    assert.ok(nx && nx.start > t0 && x.EVENTS.some((v) => v.id === nx.id), 'there is always a next event within a few hours');
    assert.strictEqual(x.activeEvent(nx.start).id, nx.id, 'the next event is active when it starts');
  });

  await t('expansion: only an owner can switch the preview, and /api/me reports the flag to owners only, with the server time for everyone', async () => {
    const sw = (on, tok) => adm({ action: 'expansion', on }, tok, 99);
    const me = (tok) => call('GET', '/api/me', undefined, tok);
    assert.strictEqual((await sw(true, T1)).code, 403, 'a normal player cannot switch it');
    assert.strictEqual((await sw(true)).code, 401, 'sign-in needed');
    assert.strictEqual((await sw('yes', O)).code, 422, 'on must be a boolean');
    let o = (await me(O)).j;
    assert.strictEqual(o.expansion, false, 'off by default');
    assert.ok(Math.abs(o.now - Date.now()) < 5000, 'me carries the server time');
    assert.strictEqual((await sw(true, O)).code, 200);
    assert.strictEqual((await me(O)).j.expansion, true, 'the owner sees it');
    const p = (await me(T1)).j;
    assert.strictEqual(p.expansion, false, 'players never see it while it is a preview');
    assert.ok(Math.abs(p.now - Date.now()) < 5000, 'players still get the server time');
    assert.strictEqual((await sw(false, O)).code, 200);
    assert.strictEqual((await me(O)).j.expansion, false, 'switched off again');
  });

  console.log(process.exitCode ? '\nSome tests FAILED' : '\nAll ' + passed + ' API tests passed');
  server.close(); process.exit(process.exitCode || 0);
})();
