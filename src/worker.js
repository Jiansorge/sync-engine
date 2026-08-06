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
      return env.ASSETS.fetch(request)
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
    merged.generatedAt = now
    merged.shards = n
    merged.errors = errors
    merged.schema = 1
    this._cache = merged
    this._cacheAt = now
    return json(merged)
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
    this._loaded = false
    this._totals = null
    this._totalSeconds = 0
    this._anonSeen = new Map() // anonId -> last active day (YYYY-MM-DD)
    this._counts = null
    this._budgets = new WeakMap() // ws -> { rate, rateStart } (budgets every message)
    this._syncAt = new WeakMap() // ws -> last processed sync timestamp (rate-caps sync even pre-presence)
    this._loadPromise = null
    this._stateTimer = null
    this._feedTimer = null
    this._persistTimer = null
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
    return json({ type: 'sync-engine', protocol: PROTOCOL_VERSION, ok: true })
  }

  // ---- hibernation API ----
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') {
      try {
        raw = new TextDecoder('utf-8').decode(raw)
      } catch {
        return
      }
    }
    if (raw.length > MAX_WS_MSG) return

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

    // Per-connection rate budget. Applied to every message from any socket
    // (not just those that have sent presence). A connection over its budget is
    // closed — legit clients send a handful of messages per minute, so 20/s is
    // generous and only floods trip it.
    if (this._overBudget(ws)) return

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
    if (this.sessions.delete(ws)) this._markStateDirty()
    this.armSweep()
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
    const session = {
      name: (
        typeof msg.name === 'string' && msg.name.trim()
          ? msg.name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
          : 'Someone'
      ).slice(0, 24),
      prayerId: msg.praying ? String(msg.prayerId || '').slice(0, 60) : null,
      spiritId: msg.praying ? String(msg.spiritId || '').slice(0, 60) : null,
      cell,
      lastSeen: Date.now(),
      lastSyncAt: 0,
      lastStartAt: prev ? prev.lastStartAt : 0
    }
    this.sessions.set(ws, session)
    await this._bump('presence')
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
      now - session.lastStartAt >= startMin

    if (isNewStart) {
      session.lastStartAt = now
      this._totals.prayers[session.prayerId] = (this._totals.prayers[session.prayerId] || 0) + 1
      if (session.spiritId) {
        this._totals.spirits[session.spiritId] = (this._totals.spirits[session.spiritId] || 0) + 1
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

    const key = ['people', id]
    const prev = (await this.ctx.storage.get(key)) || {}
    // Shared max-merge (protocol.js) — idempotent, so replayed syncs are safe.
    const merged = mergeStats(prev, incoming)
    await this.ctx.storage.put(key, merged)
    await this._bump('sync')

    // Track active users from the synced lifetime stats (durable, debounced).
    await this._ensureLoaded()
    const day = activeDayFromStats(merged)
    if (day) {
      this._anonSeen.set(id, day)
      this._pruneSeen(false)
      this._seenDirty = true
      this._schedulePersist()
    }

    this._send(ws, JSON.stringify({ type: E_SYNC, stats: merged }))
  }

  // ---- feed (coalesced) ----
  pushFeed(session) {
    this.feed.push({
      id: ++this.feedSeq,
      t: Date.now(),
      name: session.name,
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
      if (!s.prayerId) continue
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
    // Never persist unloaded fallback state: writing zeroed totals over the
    // real durable data after a failed read would lose data permanently.
    if (!this._loaded) return
    const jobs = []
    if (this._totalsDirty) {
      jobs.push(this.ctx.storage.put('totals', this._totals))
      this._totalsDirty = false
    }
    if (this._secondsDirty) {
      jobs.push(this.ctx.storage.put('totalPrayerSeconds', this._totalSeconds))
      this._secondsDirty = false
    }
    if (this._seenDirty) {
      jobs.push(this.ctx.storage.put('anonSeen', Array.from(this._anonSeen.entries())))
      this._seenDirty = false
    }
    if (this._countsDirty) {
      jobs.push(this.ctx.storage.put('counts', this._counts))
      this._countsDirty = false
    }
    if (jobs.length) await Promise.all(jobs)
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
          'schema',
          'counts'
        ])
        if (!got.get('schema')) await this.ctx.storage.put('schema', { v: 1 })
        this._totals = got.get('totals') || { prayers: {}, spirits: {}, updatedAt: Date.now() }
        if (!this._totals.updatedAt) this._totals.updatedAt = Date.now()
        this._totalSeconds =
          typeof got.get('totalPrayerSeconds') === 'number' ? got.get('totalPrayerSeconds') : 0
        this._anonSeen = new Map(Array.isArray(got.get('anonSeen')) ? got.get('anonSeen') : [])
        this._counts = { ...EMPTY_COUNTS(), ...(got.get('counts') || {}) }
        this._loaded = true
      } catch {
        // Keep in-memory fallbacks so callers never crash, but leave _loaded
        // false and clear the promise so the NEXT call retries the read. If we
        // marked it loaded here, fallback zeros would be persisted over the
        // real durable totals after a single transient failure — permanent
        // data loss.
        if (!this._totals) this._totals = { prayers: {}, spirits: {}, updatedAt: Date.now() }
        if (!this._anonSeen) this._anonSeen = new Map()
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
    const week = new Date(now)
    week.setDate(now.getDate() - 7)
    const weekKey = dayKey(week)
    let today = 0
    let weekCount = 0
    for (const day of anonSeen.values()) {
      if (day >= todayKey) today += 1
      if (day >= weekKey) weekCount += 1
    }
    return { today, week: weekCount }
  }

  _pruneSeen(force) {
    const week = new Date()
    week.setDate(week.getDate() - 7)
    const weekKey = dayKey(week)
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
    return this._totalsDirty || this._secondsDirty || this._seenDirty || this._countsDirty
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
    await this._ensureLoaded() // _totals is null until loaded — never read it cold
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
