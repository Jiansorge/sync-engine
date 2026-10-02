// sync-engine — Cloudflare Worker entry.
// Routes static assets, exposes /stats + /health, and hands WebSocket upgrades
// to a Durable Object shard. The SyncRoom DO holds one shard of the live world:
// hibernating WebSocket sessions, a coalesced broadcast loop, and durable
// all-time totals. Privacy is in the wire format — only coarse 1° cells and
// anonymous counters ever leave a device; raw IPs are never logged.

import { DurableObject } from 'cloudflare:workers'
import {
  PROTOCOL_VERSION,
  mergeStats,
  gridKey,
  C_PRESENCE,
  C_SYNC,
  C_PING,
  E_STATE,
  E_FEED,
  E_SYNC,
  E_PONG,
  E_ERROR
} from './protocol.js'
import { shardCount, shardName, allShardNames } from './shard.js'
import { dayKey, activeDayFromStats, mergeSummaries, sanitizeStats, hasLifetimeStats } from './stats.js'
import { shouldAllowUpgrade, createUpgradeThrottle, throttleKey, safeEqual } from './security.js'

// ---- limits (env overrides where noted) ----
const MAX_WS_MSG = 65536 // raw bytes, checked before parsing
const MAX_SYNC_STATS = 250000 // serialized size of a `sync` stats blob
const MAX_FEED = 40 // live feed window, bounded
const MAX_SEEN = 20000 // eager anonSeen prune only above this size (else on alarm)
const MAX_TOTALS_KEYS = 1000 // ceiling on distinct durable prayer/spirit ids
const MAX_RECENT_STARTS = 10000
const RECENT_START_TTL_MS = 7 * 86400000
// Keys a hostile client could abuse against plain-object maps. prayerId/spiritId
// are client-supplied strings and are used directly as keys in the durable
// totals — reject the prototype trio so totals can't be poisoned with string
// values or a polluted prototype.
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype'])
const safeKey = (k) => typeof k === 'string' && k.length > 0 && !DANGEROUS.has(k)
const safeStoredCounts = (value) => {
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, count] of Object.entries(value)) {
    if (safeKey(key) && Number.isSafeInteger(count) && count >= 0) out[key] = count
  }
  return out
}
const DEFAULTS = {
  maxMsgPerSec: 20, // per-connection message budget
  stateDebounceMs: 150, // broadcastState coalescing window
  feedDebounceMs: 250, // pushFeed coalescing window
  persistDebounceMs: 1000, // durable writer coalescing window
  presenceTtlMs: 60000, // a session is stale after this much silence (well above the 30s presence cadence)
  sweepAlarmMs: 30000, // how often the DO wakes to sweep/flush
  syncMinIntervalMs: 5000, // min gap between processed `sync` per connection
  startMinIntervalMs: 10000, // min gap between counted prayer starts per session
  coordCacheMs: 5000 // coordinator aggregate cache TTL
}

function envNum(env, key, fallback) {
  const n = Number(env && env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const JSON_HEADERS = {
  'content-type': 'application/json;charset=UTF-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS })

// Durable Object storage coerces a single-key ARRAY key to "people,<id>" when
// writing, but reading with that same array form looks up a DIFFERENT key and
// silently yields {} instead of the record. So every read, write and delete of
// a person record must go through this one helper and use the string form. The
// old inline ['people', id] meant every sync merged against an empty base (so a
// second device with lower numbers silently overwrote a higher total) and
// deletion deleted a key that was never there.
const peopleKey = (id) => `people,${id}`
// Tombstone for an identity that asked to be erased. Holds only a hash of the
// token that authorised the delete, so it can never authorise one itself.
const deletedKey = (id) => `deleted,${id}`

// Hash a delete token for storage. The raw token is never written down, so a
// dump of Durable Object storage cannot be replayed as a deletion capability.
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The app shell (/) is served here in the Worker (run_worker_first), so the
// `_headers` static-assets rules don't reach it — attach the security headers
// directly. Hashed /assets/*, /audio/* and icons are served by the assets
// runtime with their own headers from _headers.
const PAGE_HEADERS = {
  // The app shell must ALWAYS revalidate. It is a tiny document whose only job
  // is to point at the current hashed asset filenames; if the edge caches it
  // with a long TTL / stale-while-revalidate, a fresh deploy keeps serving the
  // OLD shell (and thus the old JS) to everyone for up to a day. `no-cache`
  // makes the edge re-check the Worker on each request, so a deploy's new asset
  // hashes are picked up immediately. Hashed /assets/* stay `immutable` (below),
  // so the real performance win — caching the big bundles — is unchanged.
  'cache-control': 'no-cache',
  'content-type': 'text/html;charset=UTF-8',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // Allow geolocation for the app itself (the map asks for a coarse fix) but
  // deny mic/camera; `geolocation=()` would break navigator.geolocation.
  'permissions-policy': 'geolocation=(self), microphone=(), camera=()',
  'content-security-policy':
    "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://storage.ko-fi.com; " +
    "media-src 'self' blob:; connect-src 'self' ws: wss: https://static.cloudflareinsights.com; " +
    "font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
}
async function servePage(request, env) {
  const resp = await env.ASSETS.fetch(request)
  const headers = new Headers(resp.headers)
  for (const [k, v] of Object.entries(PAGE_HEADERS)) headers.set(k, v)
  return new Response(resp.body, { status: resp.status, headers })
}

// Anonymous usage counters (never personal data).
const EMPTY_COUNTS = () => ({ connects: 0, messages: 0, presence: 0, sync: 0, starts: 0, errors: 0 })

// ---- Worker ----
// The upgrade throttle is in-memory per isolate (shared across requests). It is
// only engaged when MAX_UPGRADES_PER_IP > 0.
let upgradeThrottle = null
let upgradeThrottleMax = 0
function getThrottle(env) {
  const max = envNum(env, 'MAX_UPGRADES_PER_IP', 0)
  if (!upgradeThrottle || max !== upgradeThrottleMax) {
    upgradeThrottle = createUpgradeThrottle({
      max,
      windowMs: envNum(env, 'UPGRADE_WINDOW_MS', 60000)
    })
    upgradeThrottleMax = max
  }
  return upgradeThrottle
}

// ---- HTTP request rate limiting (DDoS / scrape defense) ----
// Per-IP sliding-window limiter for every non-WebSocket GET (app shell,
// /stats, /health). In-memory per isolate — a first line of defense that
// blunts floods/bots; the edge cache on / does the heavy lifting by serving
// repeat visits without ever reaching the Worker. Tune via env if needed.
const httpRateBuckets = new Map() // ip -> { start, count }
function httpRateLimited(ip, max, windowMs) {
  const now = Date.now()
  let b = httpRateBuckets.get(ip)
  if (!b || now - b.start >= windowMs) {
    b = { start: now, count: 0 }
    httpRateBuckets.set(ip, b)
  }
  b.count++
  if (httpRateBuckets.size > 2000) {
    for (const [k, v] of httpRateBuckets) if (now - v.start >= windowMs) httpRateBuckets.delete(k)
  }
  return b.count > max
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const isUpgrade = request.headers.get('Upgrade') === 'websocket'

    if (isUpgrade) {
      // Explicit allow-list wins; otherwise default to same-origin. Clients with
      // NO Origin header (native/script clients, e.g. the smoke client) are
      // always admitted — the Origin check is a browser-only control.
      const allowed = shouldAllowUpgrade(request.headers.get('Origin'), env.ALLOWED_ORIGINS, request.url)
      if (!allowed) {
        return new Response('Forbidden', { status: 403 })
      }
      if (envNum(env, 'MAX_UPGRADES_PER_IP', 0) > 0) {
        if (getThrottle(env).check(await throttleKey(request))) {
          return new Response('Too Many', { status: 429 })
        }
      }
      // Route onto a shard by coarse cell (the app sends ?cell=LLL,LLL when
      // sharding is enabled; v1 ignores it and everything lands on 'world').
      const n = shardCount(env)
      const cell = url.searchParams.get('cell') || ''
      const id = env.SYNC_ROOM.idFromName(shardName(cell, n))
      return env.SYNC_ROOM.get(id).fetch(request)
    }

    if (request.method === 'GET') {
      // First line of defense against floods/bots: cap requests per source IP.
      // Legitimate users make a handful of GETs per visit; anything above the
      // window is rejected before it can reach the Durable Object. The edge
      // cache on / already absorbs most repeat traffic; this caps the rest.
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
      if (httpRateLimited(ip, envNum(env, 'HTTP_RATE_MAX', 60), envNum(env, 'HTTP_RATE_WINDOW_MS', 10000))) {
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'retry-after': '10', 'cache-control': 'no-store' }
        })
      }
      // Recordings are served from the R2 bucket when it's configured (audio/
      // keys), falling back to the static bundle otherwise. R2 = no egress fees
      // and keeps the ~60 MB of MP3s out of the Worker bundle. No binding = the
      // static `public/audio` path serves them (dev/small scale).
      if (url.pathname.startsWith('/audio/') && env.AUDIO_BUCKET) {
        const obj = await env.AUDIO_BUCKET.get(url.pathname.slice(1))
        if (obj) {
          const headers = new Headers()
          obj.writeHttpMetadata(headers)
          headers.set('etag', obj.httpEtag)
          headers.set('cache-control', 'public, max-age=31536000, immutable')
          return new Response(obj.body, { headers })
        }
      }
      if (url.pathname === '/stats' || url.pathname === '/health') {
        // Aggregated across shards by the coordinator DO.
        const id = env.COORDINATOR.idFromName('global')
        return env.COORDINATOR.get(id).fetch(request)
      }
      return servePage(request, env)
    }

    // Self-service data deletion.
    //
    // Joining Palms has no accounts, so the anonymous ID is the only way to name
    // a record. Deleting on the ID alone would mean anyone who ever saw a
    // recovery code (people email them to us, or to each other) could destroy
    // that person's history. So deletion requires a SECOND secret that never
    // travels in the sync payload's identity: a high-entropy deleteToken,
    // generated on the device, stored only as a hash here, and compared in
    // constant time.
    //
    // The token rides the existing TLS connection, so the raw value is never
    // stored server-side and never leaves the encrypted channel.
    if (url.pathname === '/delete' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
      // Tighter than the read path: this is destructive and irreversible, so it
      // gets its own small budget to blunt both guessing and abuse.
      if (httpRateLimited(ip + ':del', envNum(env, 'DELETE_RATE_MAX', 5), envNum(env, 'DELETE_RATE_WINDOW_MS', 60000))) {
        return json({ ok: false, error: 'rate_limited' }, 429)
      }
      const origin = request.headers.get('Origin')
      if (origin && !shouldAllowUpgrade(origin, env.ALLOWED_ORIGINS, request.url)) {
        return json({ ok: false, error: 'forbidden' }, 403)
      }
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, error: 'bad_request' }, 400)
      }
      const anonId = typeof body?.anonId === 'string' ? body.anonId.slice(0, 64) : ''
      const token = typeof body?.token === 'string' ? body.token.slice(0, 128) : ''
      if (!anonId || !token) return json({ ok: false, error: 'bad_request' }, 400)

      // Records are sharded by the user's location cell, but a delete request
      // only knows the anonId - there is no cell in it, and an anonId is not
      // derivable to a shard. So the record could be in ANY shard, and this
      // route has to actually look. Each shard is asked to compare the token
      // itself and delete only if the hash matches, so the comparison always
      // happens where the data lives and two shards can never both claim it.
      // v1 runs a single shard, so this is exactly one round-trip in production.
      const n = shardCount(env)
      const payload = JSON.stringify({ anonId, token })
      const results = await Promise.all(
        allShardNames(n).map((name) =>
          env.SYNC_ROOM
            .get(env.SYNC_ROOM.idFromName(name))
            .fetch(
              new Request('https://internal/delete', { method: 'POST', body: payload })
            )
            .then((res) => res.json().catch(() => ({ ok: false, error: 'bad_gateway' })))
            .catch((err) => {
              console.error(`sync-engine: delete fan-out to ${name} failed`, err && err.message)
              return { ok: false, error: 'shard_unavailable' }
            })
        )
      )
      // A shard that matched wins. Otherwise report the most informative failure
      // so the client can tell "nothing deleted" from "could not reach it" -
      // the client must never wipe local data unless it sees ok:true.
      if (results.some((r) => r && r.ok)) {
        // Report whether the person's live presence was withdrawn too. The
        // client uses this to confirm the withdrawal landed rather than
        // assuming it did.
        return json({
          ok: true,
          deleted: true,
          withdrawn: results.some((r) => r && r.ok && r.withdrawn)
        })
      }
      // Do not paper over a real fault as "not found": that would tell a user
      // their data is gone when it is still on the server.
      const fault = results.find((r) => r && r.error && r.error !== 'not_found')
      if (fault) {
        const status = fault.error === 'bad_request' ? 400 : fault.error === 'rate_limited' ? 429 : 503
        return json({ ok: false, error: fault.error }, status)
      }
      return json({ ok: false, error: 'not_found' }, 404)
    }

    return new Response('Not found', { status: 404 })
  }
}

// Aggregates all-time totals / usersToday / usersWeek / totalPrayerSeconds
// across shards by reading each shard's /summary. Cached briefly so a busy app
// never hammers every shard per request.
export class Coordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this._cache = null
    this._cacheAt = 0
    this._inflight = null
    this._startAt = Date.now()
    this._freshAt = 0
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return json({
        ok: true,
        type: 'sync-engine',
        protocol: PROTOCOL_VERSION,
        schema: 1,
        shards: shardCount(this.env),
        uptimeMs: Date.now() - this._startAt
      })
    }

    // `?fresh=1` bypasses the aggregate cache for ops — but only with the admin
    // header. Publicly it is ignored: otherwise a hammer on /stats?fresh=1 would
    // force a fan-out to every shard per request (amplification).
    const adminKey = this.env.ADMIN_KEY
    const wantsFresh = url.searchParams.has('fresh')
    const isAdmin = !!adminKey && safeEqual(request.headers.get('x-sync-admin') || '', adminKey)
    const ttl = envNum(this.env, 'COORD_CACHE_MS', DEFAULTS.coordCacheMs)
    const now = Date.now()
    let fresh = wantsFresh && isAdmin
    // Even with the admin header, force at most one fresh fan-out per second —
    // a leaked key must not become a per-request amplification to every shard.
    if (fresh && this._freshAt && now - this._freshAt < 1000) {
      fresh = false
      if (this._cache && now - this._cacheAt < ttl) return json(this._cache)
    }
    if (fresh) this._freshAt = now
    if (!fresh && this._cache && now - this._cacheAt < ttl) return json(this._cache)

    const load = async () => {
      const n = shardCount(this.env)
      const summaries = []
      let errors = 0
      await Promise.all(
        allShardNames(n).map(async (name) => {
          try {
            const stub = this.env.SYNC_ROOM.get(this.env.SYNC_ROOM.idFromName(name))
            const res = await stub.fetch('https://shard/summary')
            if (res.ok) summaries.push(await res.json())
            else {
              errors++
              console.error(`sync-engine: shard ${name} summary returned ${res.status}`)
            }
          } catch (err) {
            errors++
            console.error(`sync-engine: shard ${name} summary failed`, err && err.message)
          }
        })
      )

      const merged = mergeSummaries(summaries)
      merged.generatedAt = Date.now()
      merged.shards = n
      merged.errors = errors
      merged.schema = 1
      this._cache = merged
      this._cacheAt = Date.now()
      return json(merged)
    }
    if (this._inflight) return this._inflight
    this._inflight = load()
    try {
      return await this._inflight
    } finally {
      this._inflight = null
    }
  }
}

// One shard of the live world. All live state (sessions/feed) is in-memory and
// may reset on eviction — that is "right now" data. The all-time numbers live
// in Durable Object storage (schema, totals, totalPrayerSeconds, anonSeen) and
// survive every redeploy.
export class SyncRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sessions = new Map() // ws -> { name, prayerId, spiritId, cell, lastSeen, lastSyncAt, lastStartAt }
    this.feed = []
    // Seed from the clock so feed entry ids stay monotonic across DO restarts
    // (otherwise ids restart at 1 and could collide with pre-restart entries
    // still held by clients, breaking list keys).
    this.feedSeq = Math.floor(Date.now() / 1000)
    this._stateDirty = false
    this._feedDirty = false
    this._totalsDirty = false
    this._secondsDirty = false
    this._seenDirty = false
    this._countsDirty = false
    this._startsDirty = false
    this._loaded = false
    this._totals = null
    // Totals counted while a durable load is still pending/failed. Folding these
    // in after a successful load means a transient storage-read failure can
    // never discard counted prayer starts (previously _countTotal wrote into a
    // throwaway object the successful retry then replaced).
    this._preLoadTotals = { prayers: {}, spirits: {} }
    this._totalSeconds = 0
    this._anonSeen = new Map() // anonId -> last active day (YYYY-MM-DD)
    this._recentStarts = new Map()
    this._counts = null
    this._budgets = new WeakMap() // ws -> { rate, rateStart } (budgets every message)
    this._syncAt = new WeakMap() // ws -> last processed sync timestamp (rate-caps sync even pre-presence)
    this._loadPromise = null
    this._stateTimer = null
    this._feedTimer = null
    this._persistTimer = null
    this._flushPromise = null
    this._lastAccum = null
    this._lastPrune = 0
    this._lastBackup = 0
  }

  // ---- fetch: upgrades + /summary ----
  async fetch(request) {
    const url = new URL(request.url)
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      this.ctx.acceptWebSocket(server)
      this.sessions.set(server, {
        name: 'Someone',
        prayerId: null,
        spiritId: null,
        cell: null,
        lastSeen: Date.now(),
        lastSyncAt: 0,
        lastStartAt: 0,
        sessionId: ''
      })
      try {
        server.serializeAttachment(this.sessions.get(server))
      } catch {}
      this.armSweep()
      // The greeting is best-effort: a storage hiccup must never fail the
      // handshake itself (the client still gets 101 + a state on its next
      // presence broadcast).
      try {
        await this._ensureLoaded()
        await this._bump('connects')
        this._send(server, JSON.stringify(await this._computeState()))
        if (this.feed.length) {
          this._send(server, JSON.stringify({ type: E_FEED, feed: this.feed }))
        }
      } catch (err) {
        console.error('sync-engine: greeting failed', err && err.message)
      }
      return new Response(null, { status: 101, webSocket: client })
    }
    if (url.pathname === '/summary') {
      await this._ensureLoaded()
      const { today, week } = this._activeCounts(this._anonSeen)
      return json({
        schema: 1,
        prayers: this._totals.prayers,
        spirits: this._totals.spirits,
        seconds: Math.round(this._totalSeconds),
        usersToday: today,
        usersWeek: week,
        people: this.sessions.size,
        counts: this._counts,
        updatedAt: this._totals.updatedAt
      })
    }
    // Self-service deletion, forwarded here from the edge. The raw token is
    // hashed and never stored; the stored hash is compared in constant time so
    // neither a wrong token nor a timing signal can walk toward a valid one.
    if (url.pathname === '/delete' && request.method === 'POST') {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, error: 'bad_request' }, 400)
      }
      const anonId = typeof body?.anonId === 'string' ? body.anonId.slice(0, 64) : ''
      const token = typeof body?.token === 'string' ? body.token.slice(0, 128) : ''
      if (!anonId || !token) return json({ ok: false, error: 'bad_request' }, 400)

      await this._ensureLoaded()
      const rec = (await this.ctx.storage.get(peopleKey(anonId))) || {}
      const storedHash = rec.tokenHash
      const givenHash = await sha256Hex(token)
      // No record, or no token was ever registered, or it does not match: all
      // the same answer, so this endpoint cannot be used to probe which
      // anonymous IDs exist.
      if (!storedHash || !safeEqual(storedHash, givenHash)) {
        return json({ ok: false, error: 'not_found' }, 404)
      }

      // Erase the record. The lifetime counters for this identity are gone, and
      // its rate-limit entry with it. The worldwide aggregate is deliberately
      // NOT adjusted: subtracting one person's prayers would lower the total for
      // everyone, and the aggregate is not attributable to anyone.
      await this.ctx.storage.delete(peopleKey(anonId))
      // Tombstone, so a second device holding the same identity cannot rebuild
      // the record we just erased.
      await this.ctx.storage.put(deletedKey(anonId), { tokenHash: rec.tokenHash || null, at: Date.now() })
      this._anonSeen.delete(anonId)
      // The anonSeen entry is a durable record that this anonId was ever seen.
      // Leaving it behind would mean a "deleted" identity is still written on
      // disk, so it has to be marked dirty and flushed before we answer.
      this._seenDirty = true
      await this._flushStorage()

// A deleted person must stop being visible immediately, not whenever the
  // 60s presence TTL happens to sweep them. Their socket may still be open -
  // the app clears local data but does not close the connection - so withdraw
  // every session that belongs to this identity and retract their feed
  // entries now, then tell them so their client stops publishing.
  //
  // This runs after the record is gone on purpose: a deletion must still
  // complete even if a socket dies mid-loop, and matching on the now-deleted
  // anonId cannot be spoofed by another identity claiming it.
  const doomed = []
      for (const [ws, sess] of this.sessions) {
        if (!sess || sess.anonId !== anonId) continue
        doomed.push({ ws, sid: sess.sessionId || '' })
      }
      for (const { ws, sid } of doomed) {
        this.sessions.delete(ws)
        try {
          this._send(ws, JSON.stringify({ type: E_SYNC, withdrawn: true, reason: 'deleted' }))
        } catch {}
        try {
          ws.close(1012, 'identity deleted')
        } catch {}
      }
      if (doomed.length) {
        // Retract only THIS person's entries - sids are per-session, so anyone
        // else's feed survives.
        const mine = new Set(doomed.map((d) => d.sid).filter(Boolean))
        this._retractFeed((e) => mine.has(e && e.sid))
        this._markStateDirty()
        this._flushState().catch(() => {})
      }
      return json({ ok: true, deleted: true, withdrawn: doomed.length > 0 })
    }
    return json({ type: 'sync-engine', protocol: PROTOCOL_VERSION, ok: true })
  }

  // ---- hibernation API ----
  async webSocketMessage(ws, raw) {
    // Per-connection rate budget, charged FIRST so every inbound frame counts —
    // including oversize frames that are rejected below before any other
    // accounting. (When the length check ran first, a flood of >MAX_WS_MSG
    // frames was unmetered and bypassed the anti-flood control entirely.)
    if (this._overBudget(ws)) return

    if (typeof raw !== 'string') {
      try {
        raw = new TextDecoder('utf-8').decode(raw)
      } catch {
        return
      }
    }
    if (raw.length > MAX_WS_MSG) {
      this._send(ws, JSON.stringify({ type: E_ERROR, code: 'too-large' }))
      this._closeSocket(ws)
      return
    }

    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    this.touchAmbient()
    let sess = this.sessions.get(ws)
    if (!sess) {
      // A socket that woke from hibernation lost the in-memory session; restore
      // it from the attachment so presence doesn't flicker out.
      try {
        const att = ws.deserializeAttachment()
        if (att && att.lastSeen) {
          this.sessions.set(ws, att)
          sess = att
        }
      } catch {}
    }
    if (sess) sess.lastSeen = Date.now()

    await this._bump('messages')
    try {
      if (msg.type === C_PRESENCE) return await this.onPresence(ws, msg)
      if (msg.type === C_SYNC) return await this.onSync(ws, msg)
      if (msg.type === C_PING) this._send(ws, JSON.stringify({ type: E_PONG }))
    } catch (err) {
      // One malformed/bad message must never take the DO down. Never log
      // message contents (privacy) — just a marker. Count it so /stats can
      // surface error rates for ops.
      console.error('sync-engine: message handler error', err && err.message)
      this._bump('errors').catch(() => {})
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws)
  }

  async webSocketClose(ws) {
    try {
      if (this.sessions.delete(ws)) this._markStateDirty()
      await this._flushStorage()
    } finally {
      this.armSweep()
    }
  }

  // Bounded, self-healing insert into a totals bucket. The previous guard was
  // `Object.keys(...).length < MAX_TOTALS_KEYS` with NO eviction: an attacker who
  // sent ~1000 distinct junk `prayerId`s (one socket, ~17 min) filled the bucket
  // and froze ALL prayer counting for the lifetime of the Durable Object's
  // storage — a permanent, silent, irreversible kill of the product's core
  // metric. Now, when a bucket is full and a genuinely new id arrives, we evict
  // the SMALLEST-COUNT key and insert the new one. Junk keys are inserted at 1
  // and rarely prayed again, so they self-evict while real prayers (which
  // accumulate high counts) are effectively immortal — a real prayer's all-time
  // count is never the thing that gets erased. Bounded AND self-healing.
  _countTotal(bucket, key) {
    if (!safeKey(key)) return
    // Before the durable load completes, buffer into _preLoadTotals so a
    // transient read failure can't discard the count when the retry replaces
    // _totals. The buffer is folded in on a successful load.
    if (!this._loaded) {
      const m = this._preLoadTotals[bucket] || (this._preLoadTotals[bucket] = {})
      m[key] = (m[key] || 0) + 1
      return
    }
    if (!this._totals || !this._totals[bucket]) return
    const map = this._totals[bucket]
    if (map[key] === undefined && Object.keys(map).length >= MAX_TOTALS_KEYS) {
      let victim = null
      let min = Infinity
      for (const [k, v] of Object.entries(map)) {
        if (v < min) {
          min = v
          victim = k
        }
      }
      if (victim !== null) delete map[victim]
    }
    map[key] = (map[key] || 0) + 1
  }

  // ---- presence / sync ----
  async onPresence(ws, msg) {
    await this._ensureLoaded()
    const prev = this.sessions.get(ws)
    // Privacy is enforced server-side too: whatever a client sends, only a
    // coarse 1° grid cell ever circulates. Precise or malformed cells become
    // null (or the rounded grid). Longitude is normalized into [-180, 180)
    // because the shared gridKey only wraps lon >= 180 — a value like -181
    // would otherwise pass straight through.
    let cell = null
    if (typeof msg.cell === 'string') {
      const [la, lo] = msg.cell.split(',').map(Number)
      if (Number.isFinite(la) && Number.isFinite(lo)) {
        const loN = ((lo + 180) % 360 + 360) % 360 - 180
        cell = gridKey(la, loN)
      }
    }
    // The server owns the session id. Trusting a client-supplied one would mean a
    // client that omits it (or restarts without persisting it) can never have
    // its own feed entries retracted, which is precisely the case where
    // retraction matters. A client-supplied value is still accepted, because it
    // lets a reconnect be recognised as the same person.
    const sessionId =
      (typeof msg.sessionId === 'string' && msg.sessionId.length <= 80 && safeKey(msg.sessionId)
        ? msg.sessionId
        : '') || (prev && prev.sessionId) || this._newSessionId()
    // A frame with no usable name is a WITHDRAWAL, not an anonymous entry, so
    // the empty name has to survive as '' rather than being replaced with
    // 'Someone'. The placeholder is applied only where a name is actually shown.
    const rawName =
      typeof msg.name === 'string' && msg.name.trim()
        ? msg.name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
        : ''
    const session = {
      name: rawName.slice(0, 24),
      prayerId: msg.praying ? String(msg.prayerId || '').slice(0, 60) : null,
      spiritId: msg.praying ? String(msg.spiritId || '').slice(0, 60) : null,
      cell,
      lastSeen: Date.now(),
      lastSyncAt: 0,
      lastStartAt: prev ? prev.lastStartAt : 0,
      sessionId
    }
    this.sessions.set(ws, session)
    await this._bump('presence')

    // Withdrawal: the client just sent a frame with no name and no cell, which
    // is how it revokes consent. Entries already pushed to the feed have
    // reached every connected client, so they are retracted here rather than
    // left to age out of the bounded window - otherwise "turn it off" would
    // still leave the name on screen for minutes.
    if (prev && prev.sessionId && (!session.name || !session.cell)) {
      this._retractFeed((e) => e && e.sid === prev.sessionId)
    }
    // Persist the session on the socket so presence survives DO hibernation
    // (the in-memory `sessions` map is lost on eviction; the attachment rides
    // the socket and is restored on the next message).
    try {
      ws.serializeAttachment(session)
    } catch {}

    // A "prayer start" only counts when a session moves to a NEW prayerId AND
    // enough time has passed since its last counted start. This bounds how much
    // one socket can inflate the durable all-time totals by rapidly alternating
    // prayerIds (mirrors the reference server but makes the abuse bounded).
    const now = Date.now()
    const startMin = envNum(this.env, 'START_MIN_INTERVAL_MS', DEFAULTS.startMinIntervalMs)
    const isNewStart =
      msg.praying &&
      session.prayerId &&
      (!prev || session.prayerId !== prev.prayerId) &&
      now - session.lastStartAt >= startMin &&
      (!sessionId || !this._recentStarts.has(sessionId))

    if (isNewStart) {
      session.lastStartAt = now
      if (sessionId) {
        this._recentStarts.set(sessionId, now)
        this._pruneRecentStarts(now)
        this._startsDirty = true
      }
      this._countTotal('prayers', session.prayerId)
      if (session.spiritId && safeKey(session.spiritId)) {
        this._countTotal('spirits', session.spiritId)
      }
      this._totals.updatedAt = now
      this._totalsDirty = true
      await this._bump('starts')
      this._schedulePersist()
      // A soul starts praying → share it with the world (coalesced, and only on
      // a counted start so feed can't be flooded either).
      this.pushFeed(session)
    }

    this._markStateDirty()
    this.armSweep()
  }

  async onSync(ws, msg) {
    const id = typeof msg.anonId === 'string' ? msg.anonId.slice(0, 64) : ''
    if (!id) return
    // Strip prototype-pollution keys before the (immutable, byte-identical)
    // mergeStats runs. mergeStats can't change without a protocol bump.
    const incoming = sanitizeStats(msg.stats)
    try {
      if (JSON.stringify(incoming).length > MAX_SYNC_STATS) return
    } catch {
      return
    }
    // Cap sync rate per connection (1 per N sec) so an abusive client can't
    // drive unbounded storage writes by rotating anonIds. Tracked per socket
    // (not per session) so a socket that never sends presence can't bypass it.
    const now = Date.now()
    const lastSync = this._syncAt.get(ws) || 0
    if (now - lastSync < envNum(this.env, 'SYNC_MIN_INTERVAL_MS', DEFAULTS.syncMinIntervalMs)) return
    this._syncAt.set(ws, now)

    // Tie the socket to its identity, so a deletion can find and withdraw the
    // live session of the person who asked to be removed. Presence alone carries
    // no identity, so this is the only link between the two.
    const sess = this.sessions.get(ws)
    if (sess) {
      sess.anonId = id
      try {
        ws.serializeAttachment(sess)
      } catch {}
    }

    const key = peopleKey(id)
    // A tombstone: this identity asked to be erased, so refuse to recreate it.
    //
    // Deletion closes the requesting device's socket, which stops THAT device
    // from resurrecting the record - but the whole point of a recovery code is
    // that several devices hold one identity, and every other device is still
    // connected and still syncing. Without this, the first one to sync after the
    // delete silently rebuilds everything the user just erased, while we have
    // already told them it was gone.
    //
    // The tombstone stores only a hash of the token that authorised the delete,
    // so it can never be used to authorise a deletion itself.
    const tomb = await this.ctx.storage.get(deletedKey(id))
    if (tomb) {
      // The holder of the deleting token is the same person, on another device:
      // honour the delete by minting them a fresh identity rather than
      // silently dropping their writes.
      if (
        typeof msg.token === 'string' &&
        msg.token &&
        msg.token.length <= 128 &&
        tomb.tokenHash &&
        safeEqual(await sha256Hex(msg.token), tomb.tokenHash)
      ) {
        const fresh = 'anon-' + crypto.randomUUID()
        const freshSess = this.sessions.get(ws)
        if (freshSess) freshSess.anonId = fresh
        this._syncAt.set(ws, now)
        await this._writeRecord(peopleKey(fresh), {
          ...incoming,
          tokenHash: typeof msg.token === 'string' && msg.token ? await sha256Hex(msg.token) : undefined
        })
        return this._send(
          ws,
          JSON.stringify({ type: E_SYNC, anonId: fresh, stats: incoming, reissued: true })
        )
      }
      // Someone without the deleting token: refuse, and say why. Silent
      // success here would let them believe their prayer history is safe when
      // nothing is being stored.
      this._bump('rejected').catch(() => {})
      return this._send(
        ws,
        JSON.stringify({ type: E_SYNC, error: 'deleted', anonId: id })
      )
    }

    // Must be a real read: with the old array key this always came back empty,
    // so every sync merged against zero and a second device with lower numbers
    // silently overwrote a higher lifetime total.
    const prev = (await this.ctx.storage.get(key)) || {}
    // Shared max-merge (protocol.js) — idempotent, so replayed syncs are safe.
    const merged = mergeStats(prev, incoming)

    // Register (or refresh) the delete-token hash on first sync, so the account
    // can later self-serve deletion. Only ever SET, never merged: a record keeps
    // the token it was created with, so a stolen replayed sync cannot silently
    // swap in an attacker's token and take over the ability to delete.
    if (typeof msg.token === 'string' && msg.token && msg.token.length <= 128 && !merged.tokenHash) {
      merged.tokenHash = await sha256Hex(msg.token)
    }

    // One write, and only after the token hash is attached: writing first would
    // persist a record with no hash, which a delete then refuses as not_found.
    await this._writeRecord(key, merged)
    this._send(ws, JSON.stringify({ type: E_SYNC, stats: merged }))
  }

  // Write one sync payload, and track the day for the usage counters.
  //
  // Extracted because a reissued identity has to go through exactly the same
  // path as a first-time sync. Sharing it is the point: a copy of the write
  // logic is a copy that can drift.
  async _writeRecord(key, merged) {
    await this.ctx.storage.put(key, merged)
    await this._bump('sync')
    await this._ensureLoaded()
    const day = activeDayFromStats(merged)
    if (day) {
      this._anonSeen.set(key.slice('people,'.length), day)
      this._pruneSeen(false)
      this._seenDirty = true
      this._schedulePersist()
    }
    return merged
  }

  // ---- feed (coalesced) ----
  _newSessionId() {
    this._sessionSeq = (this._sessionSeq || 0) + 1
    return 's' + this._sessionSeq.toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }

  pushFeed(session) {
    // The session id is carried so a later withdrawal can retract this entry.
    // Without it a name already published to every connected client would
    // survive until the bounded window rolled over, which is not the same thing
    // as withdrawing consent.
    this.feed.push({
      id: ++this.feedSeq,
      t: Date.now(),
      sid: session.sessionId || '',
      // A withdrawn session keeps an empty name; show the anonymous placeholder
    // only at display time so consent state is never conflated with anonymity.
    name: session.name || 'Someone',
      spiritId: session.spiritId,
      prayerId: session.prayerId,
      cell: session.cell
    })
    if (this.feed.length > MAX_FEED) this.feed.splice(0, this.feed.length - MAX_FEED)
    this._markFeedDirty()
  }

  // ---- broadcasting (coalesced) ----
  async _computeState() {
    await this._ensureLoaded()
    const { today, week } = this._activeCounts(this._anonSeen)
    const { people, prayers, spirits, lights, lightSpirits } = this._live()
    return {
      type: E_STATE,
      people,
      lights,
      lightSpirits,
      prayers,
      spirits,
      totals: { prayers: this._totals.prayers, spirits: this._totals.spirits },
      usersToday: today,
      usersWeek: week,
      totalPrayerSeconds: Math.round(this._totalSeconds)
    }
  }

  _live() {
    const prayers = {}
    const spirits = {}
    const lights = {}
    const lightSpirits = {}
    let people = 0
    for (const s of this.sessions.values()) {
      if (!s.prayerId || !safeKey(s.prayerId) || !safeKey(s.spiritId)) continue
      people += 1
      prayers[s.prayerId] = (prayers[s.prayerId] || 0) + 1
      if (s.spiritId) spirits[s.spiritId] = (spirits[s.spiritId] || 0) + 1
      if (s.cell) {
        lights[s.cell] = (lights[s.cell] || 0) + 1
        if (s.spiritId) lightSpirits[s.cell] = s.spiritId
      }
    }
    return { people, prayers, spirits, lights, lightSpirits }
  }

  _markStateDirty() {
    this._stateDirty = true
    if (this._stateTimer) return
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null
      void this._flushState().catch((err) =>
        console.error('sync-engine: state flush failed', err && err.message)
      )
    }, envNum(this.env, 'STATE_DEBOUNCE_MS', DEFAULTS.stateDebounceMs))
  }

  async _flushState() {
    if (!this._stateDirty) return
    this._stateDirty = false
    const payload = JSON.stringify(await this._computeState())
    this.ctx.getWebSockets().forEach((ws) => this._send(ws, payload))
  }

  _markFeedDirty() {
    this._feedDirty = true
    if (this._feedTimer) return
    this._feedTimer = setTimeout(() => {
      this._feedTimer = null
      try {
        this._flushFeed()
      } catch (err) {
        console.error('sync-engine: feed flush failed', err && err.message)
      }
    }, envNum(this.env, 'FEED_DEBOUNCE_MS', DEFAULTS.feedDebounceMs))
  }

  // Drop feed entries matching `pred` and re-broadcast. Used when consent is
// withdrawn or an identity is deleted: those entries have already reached every
// connected client, so leaving them to age out of the bounded window is not the
// same as retracting them.
_retractFeed(pred) {
  let purged = 0
  for (let i = this.feed.length - 1; i >= 0; i--) {
    if (pred(this.feed[i])) {
      this.feed.splice(i, 1)
      purged++
    }
  }
  if (purged) {
    this._markFeedDirty()
    this._flushFeed()
  }
  return purged
}

  _flushFeed() {
    if (!this._feedDirty) return
    this._feedDirty = false
    const payload = JSON.stringify({ type: E_FEED, feed: this.feed })
    this.ctx.getWebSockets().forEach((ws) => this._send(ws, payload))
  }

  // Guarded send: a socket can be closing/closed between a broadcast decision
  // and delivery (e.g. right after a sweep), and send() on it would throw.
  _send(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(payload)
    } catch {}
  }

  // ---- rate budget (every socket, presence or not) ----
  _overBudget(ws) {
    const max = envNum(this.env, 'MAX_MSG_PER_SEC', DEFAULTS.maxMsgPerSec)
    const now = Date.now()
    let b = this._budgets.get(ws)
    if (!b) {
      b = { rate: 1, rateStart: now }
      this._budgets.set(ws, b)
      return false
    }
    if (now - b.rateStart >= 1000) {
      b.rate = 1
      b.rateStart = now
      return false
    }
    b.rate = (b.rate || 0) + 1
    if (b.rate > max) {
      // Tell the client why (they can surface it to the user), then close.
      this._send(ws, JSON.stringify({ type: E_ERROR, code: 'rate' }))
      this._closeSocket(ws)
      return true
    }
    return false
  }

  // Debounced, durable anonymous usage counter. Awaits the storage load so a
  // bump on a cold wake never races a subsequent _ensureLoaded overwrite.
  async _bump(key) {
    await this._ensureLoaded()
    if (!this._counts) this._counts = EMPTY_COUNTS()
    this._counts[key] = (this._counts[key] || 0) + 1
    this._countsDirty = true
    this._schedulePersist()
  }

  // Hibernation-aware close with a standard fallback.
  _closeSocket(ws) {
    try {
      this.ctx.closeWebSocket(ws)
    } catch {
      try {
        ws.close()
      } catch {}
    }
  }

  // ---- presence sweep (silent network drops) ----
  sweepStale(now = Date.now()) {
    const ttl = envNum(this.env, 'PRESENCE_TTL_MS', DEFAULTS.presenceTtlMs)
    const stale = []
    for (const [ws, s] of this.sessions) {
      if (now - s.lastSeen > ttl) stale.push(ws)
    }
    for (const ws of stale) this._closeSocket(ws)
    if (stale.length) this._markStateDirty()
    return stale.length
  }

  // ---- durable writer (debounced) ----
  _schedulePersist() {
    if (this._persistTimer) return
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null
      void this._flushStorage().catch((err) =>
        console.error('sync-engine: storage flush failed', err && err.message)
      )
    }, envNum(this.env, 'PERSIST_DEBOUNCE_MS', DEFAULTS.persistDebounceMs))
  }

  async _flushStorage() {
    if (this._flushPromise) return this._flushPromise
    this._flushPromise = (async () => {
      if (!this._loaded) return
      const jobs = []
      const totalsDirty = this._totalsDirty
      const secondsDirty = this._secondsDirty
      const seenDirty = this._seenDirty
      const countsDirty = this._countsDirty
      const startsDirty = this._startsDirty
      if (totalsDirty) {
        this._totalsDirty = false
        // structuredClone, not {...this._totals}: the shallow copy left
        // prayers/spirit maps by reference, and _countTotal keeps mutating them
        // while the put is in flight, so what actually landed was
        // non-deterministic. Clone first so the write is an exact snapshot.
        jobs.push(this.ctx.storage.put('totals', structuredClone(this._totals)))
      }
      if (secondsDirty) {
        this._secondsDirty = false
        jobs.push(this.ctx.storage.put('totalPrayerSeconds', this._totalSeconds))
      }
      if (seenDirty) {
        this._seenDirty = false
        jobs.push(this.ctx.storage.put('anonSeen', Array.from(this._anonSeen.entries())))
      }
      if (countsDirty) {
        this._countsDirty = false
        jobs.push(this.ctx.storage.put('counts', { ...this._counts }))
      }
      if (startsDirty) {
        this._startsDirty = false
        jobs.push(
          this.ctx.storage.put('recentStarts', Array.from(this._recentStarts.entries()))
        )
      }
      if (!jobs.length) return
      try {
        await Promise.all(jobs)
      } catch (err) {
        if (totalsDirty) this._totalsDirty = true
        if (secondsDirty) this._secondsDirty = true
        if (seenDirty) this._seenDirty = true
        if (countsDirty) this._countsDirty = true
        if (startsDirty) this._startsDirty = true
        console.error('sync-engine: storage flush failed', err && err.message)
      }
    })()
    try {
      await this._flushPromise
    } finally {
      this._flushPromise = null
      if (this._hasPendingWrites()) this._schedulePersist()
    }
  }

  _ensureLoaded() {
    if (this._loaded) return Promise.resolve()
    if (this._loadPromise) return this._loadPromise
    this._loadPromise = (async () => {
      try {
        const got = await this.ctx.storage.get([
          'totals',
          'totalPrayerSeconds',
          'anonSeen',
          'recentStarts',
          'schema',
          'counts'
        ])
        if (!got.get('schema')) await this.ctx.storage.put('schema', { v: 1 })
        const storedTotals = got.get('totals') || {}
        this._totals = {
          prayers: safeStoredCounts(storedTotals.prayers),
          spirits: safeStoredCounts(storedTotals.spirits),
          updatedAt: Number.isFinite(storedTotals.updatedAt) ? storedTotals.updatedAt : Date.now()
        }
        this._totalSeconds =
          typeof got.get('totalPrayerSeconds') === 'number' ? got.get('totalPrayerSeconds') : 0
        this._anonSeen = new Map(Array.isArray(got.get('anonSeen')) ? got.get('anonSeen') : [])
        const recentStarts = Array.isArray(got.get('recentStarts')) ? got.get('recentStarts') : []
        this._recentStarts = new Map(recentStarts)
        this._pruneRecentStarts(Date.now())
        this._startsDirty = this._recentStarts.size !== recentStarts.length
        this._counts = { ...EMPTY_COUNTS(), ...(got.get('counts') || {}) }
        this._loaded = true
        // Fold in any totals counted while the load was pending/failed so no
        // counted start is lost to a transient storage-read error. (Set _loaded
        // first so _countTotal applies to _totals instead of re-buffering.)
        for (const bucket of ['prayers', 'spirits']) {
          const pending = this._preLoadTotals[bucket] || {}
          this._preLoadTotals[bucket] = {}
          let folded = false
          for (const [k] of Object.entries(pending)) {
            this._countTotal(bucket, k)
            folded = true
          }
          if (folded) this._totalsDirty = true
        }
        if (this._startsDirty) this._schedulePersist()
      } catch {
        // Keep in-memory fallbacks so callers never crash, but leave _loaded
        // false and clear the promise so the NEXT call retries the read. If we
        // marked it loaded here, fallback zeros would be persisted over the
        // real durable totals after a single transient failure — permanent
        // data loss.
        if (!this._totals) this._totals = { prayers: {}, spirits: {}, updatedAt: Date.now() }
        if (!this._anonSeen) this._anonSeen = new Map()
        if (!this._recentStarts) this._recentStarts = new Map()
        if (!this._counts) this._counts = EMPTY_COUNTS()
      } finally {
        this._loadPromise = null
      }
    })()
    return this._loadPromise
  }

  // ---- ambient all-time seconds ----
  // The world keeps praying a little even between syncs: totalPrayerSeconds
  // grows ~1 second per actively-praying person per second of real time.
  // Only praying sessions accrue, so idle/botnet sockets can't inflate it.
  touchAmbient(now = Date.now()) {
    if (this._lastAccum == null) {
      this._lastAccum = now
      return
    }
    const sec = (now - this._lastAccum) / 1000
    this._lastAccum = now
    if (sec > 0) {
      const praying = this._prayingCount()
      if (praying > 0) {
        this._totalSeconds += praying * sec
        this._secondsDirty = true
        this._schedulePersist()
      }
    }
  }

  _prayingCount() {
    let n = 0
    for (const s of this.sessions.values()) if (s.prayerId) n += 1
    return n
  }

  // ---- active-user counts ----
  _activeCounts(anonSeen) {
    const now = new Date()
    const todayKey = dayKey(now)
    const weekKey = dayKey(new Date(now.getTime() - 6 * 86400000))
    let today = 0
    let weekCount = 0
    for (const day of anonSeen.values()) {
      if (day === todayKey) today += 1
      if (day >= weekKey && day <= todayKey) weekCount += 1
    }
    return { today, week: weekCount }
  }

  _pruneRecentStarts(now = Date.now()) {
    const cutoff = now - RECENT_START_TTL_MS
    for (const [id, at] of this._recentStarts) {
      if (!Number.isFinite(at) || at < cutoff) this._recentStarts.delete(id)
    }
    while (this._recentStarts.size > MAX_RECENT_STARTS) {
      const oldest = this._recentStarts.keys().next().value
      this._recentStarts.delete(oldest)
    }
  }

  _pruneSeen(force) {
    const weekKey = dayKey(new Date(Date.now() - 6 * 86400000))
    // Eager prune only when the map grows large; otherwise the alarm flushes it
    // (keeps per-sync cost O(1) for a busy DO).
    if (!force && this._anonSeen.size < MAX_SEEN) return
    for (const [id, day] of this._anonSeen) {
      if (day < weekKey) this._anonSeen.delete(id)
    }
  }

  // Retention: garbage-collect only empty/synthetic per-anon keys. A blob with
  // any real lifetime data (completions, seconds, streaks, days) is kept
  // forever — lifetime stats are never erased. Empty blobs (anonId-rotation
  // abuse) are deleted. Paged and capped so one sweep can't pin a busy DO.
  async prunePeople() {
    try {
      let startAfter
      let deleted = 0
      let examined = 0
      for (;;) {
        const page = await this.ctx.storage.list({
          prefix: 'people',
          limit: 200,
          ...(startAfter ? { startAfter } : {})
        })
        const keys = [...page.keys()]
        if (!keys.length) break
        examined += keys.length
        const stale = []
        for (const k of keys) {
          const v = page.get(k)
          if (!hasLifetimeStats(v)) stale.push(k)
        }
        if (stale.length) await this.ctx.storage.delete(stale)
        deleted += stale.length
        startAfter = keys[keys.length - 1]
        // Bound both deletes and total scanned keys so a large mostly-fresh
        // people map can't pin a busy DO for a full O(n) scan every hour.
        if (deleted >= 5000 || examined >= 5000 || keys.length < 200) break
      }
      return deleted
    } catch (err) {
      console.error('sync-engine: prunePeople failed', err && err.message)
      return 0
    }
  }

  // ---- alarm: periodic sweep + flush ----
  _hasPendingWrites() {
    return (
      this._totalsDirty ||
      this._secondsDirty ||
      this._seenDirty ||
      this._countsDirty ||
      this._startsDirty
    )
  }

  // Arm (or disarm) the periodic sweep alarm. Crucially, this never resets an
  // already-scheduled alarm: on a busy shard presence arrives every few seconds
  // and would otherwise keep pushing the sweep out forever, so silent network
  // drops / the hourly prune would never run.
  armSweep() {
    const need = this.ctx.getWebSockets().length > 0 || this._hasPendingWrites()
    const sweepMs = envNum(this.env, 'SWEEP_ALARM_MS', DEFAULTS.sweepAlarmMs)
    return this.ctx.storage
      .getAlarm()
      .then((existing) => {
        if (need && existing == null) return this.ctx.storage.setAlarm(Date.now() + sweepMs)
        if (!need && existing != null) return this.ctx.storage.deleteAlarm()
      })
      .catch(() => {})
  }

  // Disaster-recovery backup. The lifetime totals live in DO storage (durable
  // and surviving redeploys), but a catastrophic storage loss would otherwise
  // have no recovery. Every few hours we mirror the totals to the optional
  // TOTALS_BACKUP KV binding (anonymous aggregates only — prayerId counts, not
  // people) so the world's lifetime counts can be restored. No-op without the
  // binding, so dev/test never needs it.
  async _backup() {
    const kv = this.env.TOTALS_BACKUP
    if (!kv) return
    await this._ensureLoaded()
    if (!this._loaded) return
    try {
      const name = this.ctx.id.name || 'shard'
      await kv.put(
        `totals/${name}`,
        JSON.stringify({
          schema: 1,
          prayers: this._totals.prayers,
          spirits: this._totals.spirits,
          seconds: Math.round(this._totalSeconds),
          at: Date.now()
        })
      )
    } catch (err) {
      console.error('sync-engine: backup failed', err && err.message)
    }
  }

  async alarm() {
    this.touchAmbient()
    this.sweepStale()
    this._pruneSeen(true)
    // Deep-prune durable people keys at most ~hourly so storage stays bounded.
    const now = Date.now()
    if (!this._lastPrune || now - this._lastPrune > 3600000) {
      this._lastPrune = now
      await this.prunePeople()
    }
    await this._flushStorage()
    // Mirror the lifetime totals to KV every ~6h for disaster recovery.
    if (!this._lastBackup || now - this._lastBackup > 21600000) {
      this._lastBackup = now
      await this._backup()
    }
    this.armSweep()
  }
}
