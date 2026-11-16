'use strict';
// Storage layer. Production uses Upstash Redis (the Vercel Marketplace "Upstash for Redis" / KV integration).
// Everything is stored as plain strings; callers JSON.stringify/parse themselves.
// An in-memory store is used ONLY for local development (never on Vercel, where it would silently lose data).

class MemoryStore {
  constructor() { this.kv = new Map(); this.exp = new Map(); this.z = new Map(); this.l = new Map(); }
  _alive(k) {
    const e = this.exp.get(k);
    if (e && e <= Date.now()) { this.kv.delete(k); this.exp.delete(k); return false; }
    return this.kv.has(k);
  }
  async get(k) { return this._alive(k) ? this.kv.get(k) : null; }
  async set(k, v, o) {
    o = o || {};
    if (o.nx && this._alive(k)) return null;
    this.kv.set(k, String(v));
    if (o.ex) this.exp.set(k, Date.now() + o.ex * 1000); else this.exp.delete(k);
    return 'OK';
  }
  async del(k) { this.kv.delete(k); this.exp.delete(k); this.z.delete(k); this.l.delete(k); }
  async delMany(keys) { for (const k of keys) await this.del(k); }
  // Up to `limit` keys that start with `prefix`, of any type (used by the admin "wipeall" action).
  async keys(prefix, limit) {
    const out = new Set();
    for (const k of [...this.kv.keys()]) if (k.startsWith(prefix) && this._alive(k)) out.add(k);
    for (const k of this.z.keys()) if (k.startsWith(prefix)) out.add(k);
    for (const k of this.l.keys()) if (k.startsWith(prefix)) out.add(k);
    return [...out].slice(0, limit);
  }
  async incr(k) { const v = (this._alive(k) ? +this.kv.get(k) : 0) + 1; this.kv.set(k, String(v)); return v; }
  async expire(k, s) { this.exp.set(k, Date.now() + s * 1000); }
  // Seconds left, -1 for a key with no expiry, -2 for a missing key (same as Redis TTL).
  async ttl(k) { if (!this._alive(k)) return -2; const e = this.exp.get(k); return e ? Math.max(0, Math.ceil((e - Date.now()) / 1000)) : -1; }
  async mget(keys) { return Promise.all(keys.map((k) => this.get(k))); }
  _zs(k) { if (!this.z.has(k)) this.z.set(k, new Map()); return this.z.get(k); }
  async zadd(k, score, member) { this._zs(k).set(member, score); }
  _sorted(k) {
    return [...this._zs(k).entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1)).map((e) => e[0]);
  }
  async zrevrank(k, m) { const i = this._sorted(k).indexOf(m); return i < 0 ? null : i; }
  async zrem(k, m) { this._zs(k).delete(m); }
  async zcard(k) { return this._zs(k).size; }
  async zrevrange(k, a, b) { return this._sorted(k).slice(a, b + 1); }
  async lpush(k, v) { const l = this.l.get(k) || []; l.unshift(String(v)); this.l.set(k, l); }
  async ltrim(k, a, b) { const l = this.l.get(k) || []; this.l.set(k, l.slice(a, b + 1)); }
  async lrange(k, a, b) { return (this.l.get(k) || []).slice(a, b + 1); }
}

class UpstashStore {
  constructor(url, token) {
    const { Redis } = require('@upstash/redis');
    // automaticDeserialization:false keeps JSON strings (like the save blob) as strings.
    this.r = new Redis({ url, token, automaticDeserialization: false });
  }
  get(k) { return this.r.get(k); }
  set(k, v, o) {
    o = o || {};
    const a = {};
    if (o.nx) a.nx = true;
    if (o.ex) a.ex = o.ex;
    return this.r.set(k, String(v), a);
  }
  del(k) { return this.r.del(k); }
  async delMany(keys) { for (let i = 0; i < keys.length; i += 500) await this.r.del(...keys.slice(i, i + 500)); }
  // Up to `limit` keys that start with `prefix`, found with SCAN (used by the admin "wipeall" action).
  async keys(prefix, limit) {
    const out = [];
    let cursor = '0';
    do {
      const res = await this.r.scan(cursor, { match: prefix + '*', count: 500 });
      cursor = String(res[0]);
      for (const k of res[1]) out.push(k);
    } while (cursor !== '0' && out.length < limit);
    return out.slice(0, limit);
  }
  incr(k) { return this.r.incr(k); }
  expire(k, s) { return this.r.expire(k, s); }
  ttl(k) { return this.r.ttl(k); }
  mget(keys) { return keys.length ? this.r.mget(...keys) : Promise.resolve([]); }
  zadd(k, score, member) { return this.r.zadd(k, { score, member }); }
  zrevrank(k, m) { return this.r.zrevrank(k, m); }
  zrem(k, m) { return this.r.zrem(k, m); }
  zcard(k) { return this.r.zcard(k); }
  zrevrange(k, a, b) { return this.r.zrange(k, a, b, { rev: true }); }
  lpush(k, v) { return this.r.lpush(k, String(v)); }
  ltrim(k, a, b) { return this.r.ltrim(k, a, b); }
  lrange(k, a, b) { return this.r.lrange(k, a, b); }
}

let cached = null;
function getStore() {
  if (cached) return cached;
  // A Vercel preview deployment must never touch the real player database, even if the production Redis variables are
  // shared with the Preview environment. Previews only use their own PREVIEW_REDIS_REST_* database; without one the API
  // answers 503 (or uses the memory store when ALLOW_MEMORY_STORE=1, which loses data between serverless calls).
  const preview = process.env.VERCEL_ENV === 'preview';
  const url = preview ? process.env.PREVIEW_REDIS_REST_URL : (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
  const token = preview ? process.env.PREVIEW_REDIS_REST_TOKEN : (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN);
  if (url && token) cached = new UpstashStore(url, token);
  else if (!process.env.VERCEL || process.env.ALLOW_MEMORY_STORE === '1') cached = new MemoryStore();
  return cached; // null on Vercel without a database: the API answers 503 with a clear message
}

module.exports = { getStore, MemoryStore, UpstashStore };
