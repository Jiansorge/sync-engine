// DO integration tests run in the Workers runtime (vitest-pool-workers).
// Test bindings force NUM_SHARDS=32, and each test picks a guaranteed-unique
// shard (via a cell that hashes to it) so no two tests ever share a DO's
// durable state.

import { describe, it, expect } from 'vitest'
import { env, exports } from 'cloudflare:workers'
import { runInDurableObject, evictDurableObject } from 'cloudflare:test'
import {
  C_PRESENCE,
  C_SYNC,
  C_PING,
  E_STATE,
  E_FEED,
  E_SYNC,
  E_PONG
} from '../src/protocol.js'
import { shardName, shardIndex } from '../src/shard.js'
import { dayKey } from '../src/stats.js'

const NUM_SHARDS = 32
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A cell string that FNV-hashes to exactly `shard` (see src/shard.js). Used for
// WS routing (?cell=); both sockets of a test share one cell → one shard.
function cellOnShard(shard) {
  for (let c = 0; c < 5000; c++) {
    const cell = `1,${shard * 97 + c * 13}`
    if (shardIndex(cell, NUM_SHARDS) === shard) return cell
  }
  throw new Error(`no cell found for shard ${shard}`)
}

const peopleKeyFor = (id) => `people,${id}`

let nextShard = 0
function freshCell() {
  return cellOnShard(nextShard++)
}

function shardId(cell) {
  return env.SYNC_ROOM.idFromName(shardName(cell, NUM_SHARDS))
}

async function openWs(cell) {
  const resp = await exports.default.fetch(
    `http://sync-engine.local/?cell=${encodeURIComponent(cell)}`,
    {
      // Same-origin so the default (no ALLOWED_ORIGINS) policy admits the test
      // browser client, exactly like a real page-origin socket.
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: 'http://sync-engine.local' }
    }
  )
  expect(resp.status).toBe(101)
  const ws = resp.webSocket
  ws.accept()
  return ws
}

function watch(ws) {
  const seen = []
  ws.addEventListener('message', (ev) => {
    try {
      seen.push(JSON.parse(ev.data))
    } catch {
      seen.push(ev.data)
    }
  })
  return seen
}

async function waitFor(seen, pred, timeout = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const m = seen.find(pred)
    if (m) return m
    await sleep(10)
  }
  throw new Error('timed out waiting for a message')
}

describe('SyncRoom over the wire', () => {
  it('answers a keepalive ping with a pong', async () => {
    const ws = await openWs(freshCell())
    const seen = watch(ws)
    ws.send(JSON.stringify({ type: C_PING }))
    const pong = await waitFor(seen, (m) => m.type === E_PONG)
    expect(pong).toEqual({ type: E_PONG })
    ws.close()
  })

  it('totals bucket self-heals instead of freezing when flooded with junk ids', async () => {
    // Regression: the old guard (`length < MAX` with no eviction) let an
    // attacker fill the bucket with ~1000 junk prayerIds and permanently wedge
    // all prayer counting. _countTotal must evict-and-insert so a real prayer
    // can always be counted again, the bucket stays bounded, AND (smallest-count
    // eviction) real, high-count prayers are never the thing that gets erased.
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    const result = await runInDurableObject(stub, async (instance) => {
      instance._totals = instance._totals || { prayers: {}, spirits: {} }
      // Mark loaded so _countTotal applies to _totals directly (in production
      // the load always completes before presence counts a start).
      instance._loaded = true
      // A real prayer with a healthy all-time count.
      for (let i = 0; i < 50; i++) instance._countTotal('prayers', 'mani')
      // Then flood with junk ids (each lands at 1).
      for (let i = 0; i < 1200; i++) instance._countTotal('prayers', `junk-${i}`)
      const mani = instance._totals.prayers.mani
      const keys = Object.keys(instance._totals.prayers).length
      return { mani, keys }
    })
    expect(result.mani).toBe(50) // real high-count prayer survived the junk flood
    expect(result.keys).toBe(1000) // bucket stayed bounded
  })

  it('does not lose starts counted while a durable load is pending', async () => {
    // F9: on a transient storage-read error _ensureLoaded leaves _loaded false
    // with fallback state; _countTotal must BUFFER (not write into a throwaway
    // the retry replaces), and the buffer must be folded in once loaded.
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    const result = await runInDurableObject(stub, async (instance) => {
      instance._totals = { prayers: {}, spirits: {}, updatedAt: Date.now() }
      instance._loaded = false // simulate a pending/failed load
      instance._countTotal('prayers', 'mani') // counted before load completes
      const buffered = (instance._preLoadTotals.prayers.mani || 0)
      // Simulate a successful load finishing: fold the buffer into _totals.
      instance._loaded = true
      const pending = instance._preLoadTotals.prayers
      instance._preLoadTotals.prayers = {}
      for (const [k] of Object.entries(pending)) instance._countTotal('prayers', k)
      return { buffered, after: instance._totals.prayers.mani || 0 }
    })
    expect(result.buffered).toBe(1) // went to the buffer, not the throwaway
    expect(result.after).toBe(1) // folded into real totals after load
  })

  it('falls back to static assets for /audio/* when R2 is not bound', async () => {
    // No AUDIO_BUCKET binding in the test env → /audio/* must route to ASSETS
    // (404 for a missing file) instead of crashing.
    const resp = await exports.default.fetch('http://sync-engine.local/audio/nope.mp3')
    expect(resp.status).toBe(404)
  })

  it('broadcasts state + feed from presence and counts all-time totals', async () => {
    const cell = freshCell()
    const observer = await openWs(cell)
    const seen = watch(observer)
    const sender = await openWs(cell)
    watch(sender)

    sender.send(
      JSON.stringify({
        type: C_PRESENCE,
        praying: true,
        prayerId: 'lords-prayer',
        spiritId: 'christianity',
        name: 'Tester',
        cell: '40,20'
      })
    )

    const state = await waitFor(seen, (m) => m.type === E_STATE && m.people >= 1)
    expect(state.prayers['lords-prayer']).toBeGreaterThanOrEqual(1)
    expect(state.spirits['christianity']).toBeGreaterThanOrEqual(1)
    expect(state.totals.prayers['lords-prayer']).toBeGreaterThanOrEqual(1)
    expect(state.totals.spirits['christianity']).toBeGreaterThanOrEqual(1)
    expect(typeof state.usersToday).toBe('number')
    expect(typeof state.totalPrayerSeconds).toBe('number')

    const feed = await waitFor(seen, (m) => m.type === E_FEED)
    expect(feed.feed.some((f) => f.prayerId === 'lords-prayer')).toBe(true)

    sender.close()
    observer.close()
  })

  it('merges sync into durable storage that survives a restart', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    const ws = await openWs(cell)
    const seen = watch(ws)

    const stats = {
      prayerCompletions: { 'lords-prayer': 3, mani: 1 },
      localPrayerSeconds: 42,
      bestStreak: 2,
      lastPrayedDay: new Date().toISOString().slice(0, 10)
    }
    ws.send(JSON.stringify({ type: C_SYNC, anonId: 'anon-restart', stats }))
    const reply = await waitFor(seen, (m) => m.type === E_SYNC && m.stats)
    expect(reply.stats.localPrayerSeconds).toBe(42)
    expect(reply.stats.prayerCompletions['lords-prayer']).toBe(3)

    // Replay the same sync — idempotent, and a second reply still holds.
    ws.send(JSON.stringify({ type: C_SYNC, anonId: 'anon-restart', stats }))
    await waitFor(seen, (m) => m.type === E_SYNC)

    // Restart: force the live instance's debounced durable writes to land
    // (anonSeen persists via a 1000ms timer that would otherwise die with the
    // instance), then tear it down and boot a fresh one from the same storage.
    await runInDurableObject(stub, async (instance) => {
      await instance._flushStorage()
    })
    await evictDurableObject(stub)
    const booted = await runInDurableObject(stub, async (instance, state) => {
      const people = await state.storage.list({ prefix: 'people' })
      const seenRaw = await state.storage.get('anonSeen')
      const schema = await state.storage.get('schema')
      return { merged: people.size ? [...people.values()][0] : undefined, seenRaw, schema }
    })

    expect(booted.merged).toMatchObject({
      prayerCompletions: { 'lords-prayer': 3, mani: 1 },
      localPrayerSeconds: 42,
      bestStreak: 2
    })
    // The active-user map persisted too, so usersToday survives a restart.
    expect(booted.seenRaw.some(([id]) => id === 'anon-restart')).toBe(true)
    // Durable storage is initialized (schema key) on the fresh instance.
    expect(booted.schema).toEqual({ v: 1 })

    try {
      ws.close()
    } catch {}
  })

  it('sweeps sessions that stop sending (silent network drop)', async () => {
    const cell = freshCell()
    const ws = await openWs(cell)
    const seen = watch(ws)
    ws.send(
      JSON.stringify({
        type: C_PRESENCE,
        praying: true,
        prayerId: 'mani',
        spiritId: 'buddhism',
        name: 'Sweeper',
        cell: '40,20'
      })
    )
    await waitFor(seen, (m) => m.type === E_STATE)

    const stub = env.SYNC_ROOM.get(shardId(cell))
    const clientClosed = new Promise((res) => ws.addEventListener('close', () => res(true)))
    const result = await runInDurableObject(stub, (instance) => {
      const before = instance.sessions.size
      const removed = instance.sweepStale(Date.now() + 120000)
      return { before, removed }
    })

    expect(result.before).toBe(1)
    expect(result.removed).toBe(1)
    // The sweep closed the stale socket (session cleanup lands via webSocketClose).
    expect(await clientClosed).toBe(true)
    try {
      ws.close()
    } catch {}
  })

  it('closes a connection that exceeds its message budget', async () => {
    const ws = await openWs(freshCell())
    const seen = watch(ws)
    const closed = new Promise((res) => ws.addEventListener('close', () => res(true)))
    ws.send(JSON.stringify({ type: C_PRESENCE, praying: false, name: 'Flooder' }))
    for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ type: C_PING }))
    expect(await closed).toBe(true)
    // The client is told why before the socket closes (user notification).
    expect(seen.some((m) => m.type === 'error' && m.code === 'rate')).toBe(true)
    try {
      ws.close()
    } catch {}
  })

  it('normalizes any cell to a coarse 1° grid server-side (privacy)', async () => {
    const cell = freshCell()
    const observer = await openWs(cell)
    const seen = watch(observer)
    const sender = await openWs(cell)
    watch(sender)
    // A malicious/precise cell must never circulate as-is.
    sender.send(
      JSON.stringify({
        type: C_PRESENCE,
        praying: true,
        prayerId: 'lords-prayer',
        spiritId: 'christianity',
        name: 'Precise',
        cell: '40.7128,-74.0060'
      })
    )
    const state = await waitFor(seen, (m) => m.type === E_STATE && m.people >= 1)
    const keys = Object.keys(state.lights || {})
    expect(keys.length).toBe(1)
    expect(keys[0]).toBe('41,-74') // 1° grid, not the precise value
    const feed = await waitFor(
      seen,
      (m) => m.type === E_FEED && m.feed.some((f) => f.cell === '41,-74')
    )
    expect(feed.feed.some((f) => f.cell === '40.7128,-74.0060')).toBe(false)
    sender.close()
    observer.close()
  })

  it('normalizes out-of-range longitude and latitude cells', async () => {
    const cell = freshCell()
    const observer = await openWs(cell)
    const seen = watch(observer)
    const sender = await openWs(cell)
    watch(sender)
    // -181 wraps to +179 (≡ -181 mod 360); lat 100 clamps to 72.
    sender.send(
      JSON.stringify({
        type: C_PRESENCE,
        praying: true,
        prayerId: 'psalm-23',
        spiritId: 'christianity',
        name: 'Edge',
        cell: '100,-181'
      })
    )
    const state = await waitFor(seen, (m) => m.type === E_STATE && m.people >= 1)
    const keys = Object.keys(state.lights || {})
    expect(keys).toEqual(['72,179'])
    sender.close()
    observer.close()
  })

  it('tracks anonymous usage counters durably', async () => {
    const cell = freshCell()
    const ws = await openWs(cell)
    const seen = watch(ws)
    ws.send(JSON.stringify({ type: C_PRESENCE, praying: true, prayerId: 'mani', spiritId: 'buddhism', name: 'Counted', cell: '30,70' }))
    ws.send(JSON.stringify({ type: C_SYNC, anonId: 'anon-count', stats: { localPrayerSeconds: 1 } }))
    ws.send(JSON.stringify({ type: C_PING }))
    await waitFor(seen, (m) => m.type === E_SYNC)
    const stub = env.SYNC_ROOM.get(shardId(cell))
    const booted = await runInDurableObject(stub, async (instance) => {
      await instance._flushStorage()
      return instance._counts
    })
    expect(booted.connects).toBeGreaterThanOrEqual(1)
    expect(booted.messages).toBeGreaterThanOrEqual(3)
    expect(booted.presence).toBeGreaterThanOrEqual(1)
    expect(booted.sync).toBeGreaterThanOrEqual(1)
    try {
      ws.close()
    } catch {}
  })

  it('rate-gates durable totals against prayerId alternation', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    await runInDurableObject(stub, async (instance) => {
      const ws = {}
      // Rapidly alternate prayerIds on one socket: only the first start counts.
      await instance.onPresence(ws, { praying: true, prayerId: 'a', spiritId: 's', name: 'x', cell: '0,0' })
      await instance.onPresence(ws, { praying: true, prayerId: 'b', spiritId: 's', name: 'x', cell: '0,0' })
      await instance.onPresence(ws, { praying: true, prayerId: 'a', spiritId: 's', name: 'x', cell: '0,0' })
      await instance.onPresence(ws, { praying: true, prayerId: 'b', spiritId: 's', name: 'x', cell: '0,0' })
      return { prayers: instance._totals.prayers }
    }).then((r) => {
      expect(r.prayers).toEqual({ a: 1 }) // alternation within 10s is gated
    })
  })

  it('deduplicates the same playback session across reconnects', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    await runInDurableObject(stub, async (instance) => {
      await instance.onPresence({}, {
        praying: true,
        prayerId: 'reconnect-prayer',
        spiritId: 'test-spirit',
        sessionId: 'playback-123',
        name: 'Reconnect',
        cell: '0,0'
      })
      await instance.onPresence({}, {
        praying: true,
        prayerId: 'reconnect-prayer',
        spiritId: 'test-spirit',
        sessionId: 'playback-123',
        name: 'Reconnect',
        cell: '0,0'
      })
      expect(instance._totals.prayers['reconnect-prayer']).toBe(1)
      expect(instance._totals.spirits['test-spirit']).toBe(1)
    })
  })

  it('persists recent playback ids used for restart deduplication', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    await runInDurableObject(stub, async (instance) => {
      await instance.onPresence({}, {
        praying: true,
        prayerId: 'durable-prayer',
        spiritId: 'test-spirit',
        sessionId: 'durable-playback',
        name: 'Durable',
        cell: '0,0'
      })
      await instance._flushStorage()
      expect(await instance.ctx.storage.get('recentStarts')).toEqual([
        ['durable-playback', expect.any(Number)]
      ])
    })
  })

  it('rate-caps sync per socket even without presence (no storage-write flood)', async () => {
    const ws = await openWs(freshCell())
    const seen = watch(ws)
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ type: C_SYNC, anonId: `flood-${i}`, stats: { localPrayerSeconds: 1 } }))
    }
    await sleep(500)
    // Only the first sync in the 5s window is processed (no presence sent).
    expect(seen.filter((m) => m.type === E_SYNC).length).toBe(1)
    try {
      ws.close()
    } catch {}
  })

  it('armSweep schedules a sweep alarm without resetting an existing one', async () => {
    const cell = freshCell()
    // A real live socket (not a faked session) so getWebSockets() reports it —
    // in production every session rides on a hibernating WebSocket.
    const ws = await openWs(cell)
    watch(ws)
    ws.send(JSON.stringify({ type: C_PRESENCE, praying: false, name: 'x' }))
    await sleep(250) // let presence land so the socket is a live session
    const stub = env.SYNC_ROOM.get(shardId(cell))
    const r = await runInDurableObject(stub, async (instance) => {
      await instance.armSweep()
      const t1 = await instance.ctx.storage.getAlarm()
      await instance.armSweep()
      const t2 = await instance.ctx.storage.getAlarm()
      return { t1, t2 }
    })
    expect(r.t1).not.toBe(null)
    expect(r.t2).toBe(r.t1) // presence churn must not push the sweep out forever
    try {
      ws.close()
    } catch {}
  })

  it('accrues ambient seconds only for praying sessions (no idle-socket inflation)', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    await runInDurableObject(stub, async (instance) => {
      await instance._ensureLoaded()
      instance._totalSeconds = 0
      instance.sessions.set({ p: 'a' }, { prayerId: 'a', spiritId: 's' }) // praying
      instance.sessions.set({ p: 'idle' }, { prayerId: null }) // idle socket
      instance.touchAmbient(1000) // baseline
      instance.touchAmbient(2000) // +1s, only the praying session counts
      return instance._totalSeconds
    }).then((s) => expect(s).toBe(1))
  })

  it('prunes only empty/synthetic people keys (never lifetime stats)', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put(['people', 'synthetic'], {}) // no data → prunable
      await instance.ctx.storage.put(['people', 'real-user'], { lastPrayedDay: dayKey(), localPrayerSeconds: 5 })
      const deleted = await instance.prunePeople()
      expect(deleted).toBe(1)
      const keys = [...(await instance.ctx.storage.list({ prefix: 'people' })).keys()].map(String)
      expect(keys.some((k) => k.includes('synthetic'))).toBe(false)
      expect(keys.some((k) => k.includes('real-user'))).toBe(true) // lifetime data kept
    })
  })

  it('alarm() sweeps, prunes, and flushes without error', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put(['people', 'synthetic-alarm'], {}) // empty → pruned
      await instance.alarm()
      const list = await instance.ctx.storage.list({ prefix: 'people' })
      expect(list.size).toBe(0)
    })
  })

  it('survives a barrage of hostile/malformed messages without crashing', async () => {
    const cell = freshCell()
    const ws = await openWs(cell)
    const seen = watch(ws)
    const hostile = [
      'not json at all',
      '"just a string"',
      '[]',
      '42',
      JSON.stringify({ type: 'bogus' }),
      JSON.stringify({ type: 'presence' }),
      JSON.stringify({ type: 'presence', praying: true, prayerId: 123, spiritId: {}, name: { x: 1 }, cell: 'not-a-cell' }),
      JSON.stringify({ type: 'presence', praying: true, prayerId: 'a'.repeat(5000), spiritId: 'b', name: '🙏🙏🙏', cell: '0,0' }),
      JSON.stringify({ type: 'sync', anonId: 42, stats: { prayerCompletions: { a: 'x' }, prayerDayCompletions: { bad: { x: {} } } } }),
      JSON.stringify({ type: 'sync', anonId: 'a'.repeat(100), stats: { nested: { deep: [1, 2, 3] } } }),
      JSON.stringify({ type: 'presence', cell: 'a,b,c,d,e' }),
      JSON.stringify({ type: 'presence', praying: true, prayerId: 'p', spiritId: 's', name: 'x', cell: '1e9,1e9' })
    ]
    // Pace under the test env's 5 msg/s budget so the malformed-data handling
    // is exercised (not the rate limiter, which has its own test).
    for (const m of hostile) {
      ws.send(m)
      await sleep(230)
    }
    await sleep(300)
    // A valid presence still lands and the DO is healthy afterwards.
    ws.send(JSON.stringify({ type: C_PRESENCE, praying: true, prayerId: 'mani', spiritId: 'buddhism', name: 'Healthy', cell: '40,20' }))
    const state = await waitFor(seen, (m) => m.type === E_STATE && m.people >= 1).catch((e) => {
      console.log('FUZZ DEBUG seen:', JSON.stringify(seen.map((m) => m.type).slice(0, 20)))
      throw e
    })
    expect(state.people).toBe(1)
    // An oversized frame (>64KB) is dropped by the app-level cap. Note: the
    // runtime itself may close the socket on such a frame, so it goes last.
    ws.send('x'.repeat(70000))
    await sleep(200)
    const stub = env.SYNC_ROOM.get(shardId(cell))
    const counts = await runInDurableObject(stub, async (instance) => {
      await instance._ensureLoaded()
      return instance._counts
    })
    expect(counts.messages).toBeGreaterThanOrEqual(1)
    try {
      ws.close()
    } catch {}
  })

  it('never persists unloaded fallback state (transient-read safety)', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    await runInDurableObject(stub, async (instance) => {
      instance._loaded = false
      instance._loadPromise = null
      instance._totals = { prayers: { a: 999 }, spirits: {}, updatedAt: Date.now() } // "fallback"
      await instance._flushStorage()
      const stored = await instance.ctx.storage.get('totals')
      expect(stored).toBeUndefined() // nothing persisted while unloaded
    })
  })

  it('mirrors lifetime totals to the backup KV (disaster recovery)', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    await runInDurableObject(stub, async (instance) => {
      await instance._ensureLoaded()
      instance._totals.prayers = { mani: 7 }
      instance._totals.spirits = { buddhism: 7 }
      instance._totalSeconds = 42
      await instance._backup()
    })
    const list = await env.TOTALS_BACKUP.list({ prefix: 'totals/' })
    // KV is shared across tests, so find THIS shard's backup by its payload.
    const raws = await Promise.all(list.keys.map((k) => env.TOTALS_BACKUP.get(k.name)))
    const v = raws.map((r) => JSON.parse(r)).find((x) => x.prayers && x.prayers.mani === 7)
    expect(v).toBeTruthy()
    expect(v.spirits).toEqual({ buddhism: 7 })
    expect(v.seconds).toBe(42)
    expect(typeof v.at).toBe('number')
  })

  // ---- durable merge across devices ----------------------------------------
  // Regression: the person record was read with a Durable Object array key,
  // which never matches what was written, so `prev` was always empty. Every
  // sync therefore merged against zero and REPLACED the stored totals instead of
  // max-merging them - so a second device with fewer prayers silently lowered
  // the record. This is the whole no-data-loss promise, so it gets a test.
  describe('lifetime stats survive a second device', () => {
    async function syncAnon(anonId, stats, cell) {
      const ws = await openWs(cell)
      const seen = watch(ws)
      ws.send(JSON.stringify({ type: C_SYNC, anonId, stats }))
      await waitFor(seen, (m) => m.type === E_SYNC)
      ws.close()
      await sleep(60) // clear the per-socket sync interval
    }

    it('does not let a lower total from another device overwrite a higher one', async () => {
      const cell = freshCell()
      const stub = env.SYNC_ROOM.get(shardId(cell))
      await syncAnon('merge-1', { localPrayerSeconds: 100, prayerCompletions: { mani: 9 } }, cell)
      await syncAnon('merge-1', { localPrayerSeconds: 5, prayerCompletions: { mani: 1 } }, cell)
      const rec = await runInDurableObject(stub, async (i) =>
        i.ctx.storage.get(peopleKeyFor('merge-1'))
      )
      expect(rec.localPrayerSeconds).toBe(100)
      expect(rec.prayerCompletions.mani).toBe(9)
    })

    it('keeps the higher value of each field independently', async () => {
      const cell = freshCell()
      const stub = env.SYNC_ROOM.get(shardId(cell))
      await syncAnon('merge-2', { localPrayerSeconds: 10, prayerCompletions: { mani: 2 } }, cell)
      await syncAnon('merge-2', { localPrayerSeconds: 4, prayerCompletions: { mani: 7 } }, cell)
      const rec = await runInDurableObject(stub, async (i) =>
        i.ctx.storage.get(peopleKeyFor('merge-2'))
      )
      expect(rec.localPrayerSeconds).toBe(10)
      expect(rec.prayerCompletions.mani).toBe(7)
    })

    it('is idempotent when the same device syncs repeatedly', async () => {
      const cell = freshCell()
      const stub = env.SYNC_ROOM.get(shardId(cell))
      const stats = { localPrayerSeconds: 42, prayerCompletions: { mani: 3 } }
      await syncAnon('merge-3', stats, cell)
      await syncAnon('merge-3', stats, cell)
      await syncAnon('merge-3', stats, cell)
      const rec = await runInDurableObject(stub, async (i) =>
        i.ctx.storage.get(peopleKeyFor('merge-3'))
      )
      expect(rec.localPrayerSeconds).toBe(42)
      expect(rec.prayerCompletions.mani).toBe(3)
    })
  })

  // ---- self-service deletion ------------------------------------------------
  // The deployed Worker is the only place a record can actually be erased, so
  // the contract has to be tested here. The dev server in prayer-earth proves
  // the same contract, but it is different code - these tests are what would
  // have caught an erased identity being written back to disk.
  describe('self-service deletion', () => {
    // The delete path has its own tight rate budget, keyed by IP. Every test
    // gets a distinct IP so one test cannot exhaust another's budget, which is
    // what made these flaky when they all shared an address.
    let ipCounter = 0
    const nextIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`

    const activeStats = () => ({
      localPrayerSeconds: 7,
      prayerCompletions: { mani: 1 },
      lastPrayedDay: dayKey()
    })

    async function register(anonId, token, cell, stats = activeStats()) {
      const ws = await openWs(cell)
      const seen = watch(ws)
      ws.send(JSON.stringify({ type: C_SYNC, anonId, token, stats }))
      await waitFor(seen, (m) => m.type === E_SYNC)
      ws.close()
    }

    const post = (body, ip = nextIp()) =>
      exports.default.fetch('http://sync-engine.local/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify(body)
      })

    it('erases the record AND the anonSeen entry from storage', async () => {
      const cell = freshCell()
      await register('del-erase', 'token-erase', cell)
      const stub = env.SYNC_ROOM.get(shardId(cell))
      await runInDurableObject(stub, async (instance) => {
        await instance._flushStorage() // the anonSeen write is debounced
        expect(await instance.ctx.storage.get(peopleKeyFor('del-erase'))).toBeTruthy()
        expect(instance._anonSeen.has('del-erase')).toBe(true)
      })

      const res = await post({ anonId: 'del-erase', token: 'token-erase' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, deleted: true })

      // The part that actually matters. Checking the live Map is not enough -
      // the object could hold the erased identity in memory and write it back.
      await runInDurableObject(stub, async (instance) => {
        expect(await instance.ctx.storage.get(peopleKeyFor('del-erase'))).toBeUndefined()
        const persisted = await instance.ctx.storage.get('anonSeen')
        expect(JSON.stringify(persisted || [])).not.toContain('del-erase')
      })
    })

    it('refuses a wrong token and leaves the record untouched', async () => {
      const cell = freshCell()
      await register('del-wrong', 'right-token', cell)
      const res = await post({ anonId: 'del-wrong', token: 'wrong-token' })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ ok: false, error: 'not_found' })
      await runInDurableObject(env.SYNC_ROOM.get(shardId(cell)), async (instance) => {
        expect(await instance.ctx.storage.get(peopleKeyFor('del-wrong'))).toBeTruthy()
      })
    })

    it('gives the same answer for an unknown id, so ids cannot be probed', async () => {
      const res = await post({ anonId: 'never-existed', token: 'whatever' })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ ok: false, error: 'not_found' })
    })

    it('refuses an id that synced before tokens existed', async () => {
      // No tokenHash means undeletable by design: otherwise anyone holding only
      // an old recovery code could erase that person.
      const cell = freshCell()
      await register('del-legacy', undefined, cell, {
        localPrayerSeconds: 3,
        prayerCompletions: {},
        lastPrayedDay: dayKey()
      })
      const res = await post({ anonId: 'del-legacy', token: 'anything' })
      expect(res.status).toBe(404)
    })

    it('keeps the first token across later syncs (no takeover by replay)', async () => {
      const cell = freshCell()
      await register('del-persist', 'tok-first', cell)
      // A replayed sync offering a different token must not take over deletion.
      await register('del-persist', 'tok-attacker', cell)
      const old = await post({ anonId: 'del-persist', token: 'tok-first' })
      expect(old.status).toBe(200)
    })

    it('rejects malformed bodies without touching anything', async () => {
      for (const body of [{}, { anonId: 'x' }, { token: 'x' }, { anonId: 1, token: 2 }]) {
        const res = await post(body)
        expect(res.status).toBe(400)
      }
      const res = await exports.default.fetch('http://sync-engine.local/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': nextIp() },
        body: 'not json'
      })
      expect(res.status).toBe(400)
    })

    it('does not lower the worldwide total when one person is deleted', async () => {
      const cell = freshCell()
      await register('del-total', 'tok-total', cell)
      const stub = env.SYNC_ROOM.get(shardId(cell))
      const before = await runInDurableObject(stub, async (i) => ({ ...i._totals }))
      await post({ anonId: 'del-total', token: 'tok-total' })
      const after = await runInDurableObject(stub, async (i) => ({ ...i._totals }))
      expect(after.prayers).toBe(before.prayers)
    })

    it('is a clean no-op when repeated', async () => {
      const cell = freshCell()
      await register('del-twice', 'tok-twice', cell)
      const ip = nextIp()
      expect((await post({ anonId: 'del-twice', token: 'tok-twice' }, ip)).status).toBe(200)
      const second = await post({ anonId: 'del-twice', token: 'tok-twice' }, ip)
      expect(second.status).toBe(404)
    })

    it('rate-limits a flood of delete attempts from one address', async () => {
      const ip = nextIp()
      const codes = []
      for (let i = 0; i < 9; i++) {
        codes.push((await post({ anonId: 'flood-' + i, token: 'x' }, ip)).status)
      }
      expect(codes).toContain(429)
      expect(codes[0]).not.toBe(429)
    })
  })
})
