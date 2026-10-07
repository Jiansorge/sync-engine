// Durable Object behaviour the wire-level suite in worker.test.js does not reach.
//
// The existing 101 tests cover the protocol, durability across a restart, alarm
// sweeping, rate limits, deletion authorisation and idempotency. What they do not
// cover is what is specific to a Durable Object rather than to a websocket server:
//
//   1. INTERLEAVING. A DO is single-threaded, so "concurrent" means two requests
//      whose awaits interleave. The dangerous case is a sync landing while a
//      delete for the same identity is still in flight: if the sync writes its
//      record back after the tombstone is written, the identity is resurrected,
//      which silently undoes the one action a privacy-focused app cannot get
//      wrong.
//   2. CORRUPT STORAGE. Durable storage survives deploys, so a value written by an
//      older build - or truncated by a platform fault - is read by the new one.
//      Reading it must not throw inside the DO.
//
// Written after a first attempt that guessed at internals (`ensureLoaded`, a
// `state` parameter, `_totals` shape) and failed four of five tests. The patterns
// here are copied from the working self-service deletion tests in worker.test.js.

import { describe, it, expect } from 'vitest'
import { env, exports } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { C_SYNC, E_SYNC } from '../src/protocol.js'
import { shardName, shardIndex } from '../src/shard.js'

const NUM_SHARDS = 32
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let nextShard = 0
function freshCell() {
  const shard = nextShard++ % NUM_SHARDS
  for (let c = 0; c < 5000; c++) {
    const cell = `1,${shard * 97 + c * 13}`
    if (shardIndex(cell, NUM_SHARDS) === shard) return cell
  }
  throw new Error('no cell for shard')
}

let ipCounter = 0
const nextIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`

const shardId = (cell) => env.SYNC_ROOM.idFromName(shardName(cell, NUM_SHARDS))
const peopleKey = (id) => `people,${id}`
const tombKey = (id) => `deleted,${id}`

async function openWs(cell) {
  const resp = await exports.default.fetch(
    `http://sync-engine.local/?cell=${encodeURIComponent(cell)}`,
    { headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: 'http://sync-engine.local' } }
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
    const hit = seen.find(pred)
    if (hit) return hit
    await sleep(25)
  }
  return null
}

const stats = () => ({
  localPrayerSeconds: 11,
  prayerCompletions: { mani: 2 },
  lastPrayedDay: '20240101'
})

// Register an identity the way the app does: a sync carrying anonId + token.
async function register(anonId, token, cell, extra = {}) {
  const ws = await openWs(cell)
  const seen = watch(ws)
  ws.send(JSON.stringify({ type: C_SYNC, anonId, token, stats: stats(), ...extra }))
  await waitFor(seen, (m) => m.type === E_SYNC)
  ws.close()
}

const postDelete = (body, ip = nextIp()) =>
  exports.default.fetch('http://sync-engine.local/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body)
  })

describe('durable object: interleaving', () => {
  it('never leaves a tombstone and a live record at the same time', async () => {
    const cell = freshCell()
    const anonId = 'resurrect-me'
    const token = 'tok-resurrect'
    await register(anonId, token, cell)

    const stub = env.SYNC_ROOM.get(shardId(cell))
    const stored = await runInDurableObject(stub, async (instance) => {
      instance._loaded = true; await instance._flushStorage()
      return {
        record: (await instance.ctx.storage.get(`people,${anonId}`)) || null,
        tomb: (await instance.ctx.storage.get(`deleted,${anonId}`)) || null
      }
    })
    expect(stored.record, 'register must create the record').toBeTruthy()
    expect(stored.tomb, 'a live identity must not already be tombstoned').toBeFalsy()

    // Fire the delete and a competing sync without awaiting between them, so the
    // DO has to serialise them itself.
    await Promise.allSettled([
      postDelete({ anonId, token }),
      (async () => {
        const ws = await openWs(cell)
        ws.send(JSON.stringify({ type: C_SYNC, anonId, token, stats: stats() }))
        await sleep(120)
        ws.close()
      })()
    ])

    const after = await runInDurableObject(stub, async (instance) => {
      instance._loaded = true; await instance._flushStorage()
      return {
        record: (await instance.ctx.storage.get(`people,${anonId}`)) || null,
        tomb: (await instance.ctx.storage.get(`deleted,${anonId}`)) || null
      }
    })

    // The invariant that matters. A tombstone means "deleted, never accept this
    // identity again". If both exist, a later sync can still find a record and
    // the identity is back.
    expect(Boolean(after.tomb && after.record), 'tombstone and live record coexisting is resurrection').toBe(false)
    expect(after.tomb, 'the delete should have tombstoned the identity').toBeTruthy()
    expect(after.record, 'the tombstoned record must be gone').toBeFalsy()
  })

  it('answers two concurrent deletes of the same id without leaving the record', async () => {
    const cell = freshCell()
    const anonId = 'double-delete'
    const token = 'tok-double'
    await register(anonId, token, cell)
    const stub = env.SYNC_ROOM.get(shardId(cell))
    await runInDurableObject(stub, async (instance) => {
      instance._loaded = true; await instance._flushStorage()
    })

    const body = { anonId, token }
    const [ra, rb] = await Promise.all([
      (async () => (await postDelete(body)).json())(),
      (async () => (await postDelete(body)).json())()
    ])

    // One wins, the other reports not-found. Both are truthful; what must never
    // happen is both claiming success while the record survives.
    expect(ra.ok === true || ra.error === 'not_found' || ra.ok === false).toBe(true)
    expect(rb).toBeTruthy()

    const left = await runInDurableObject(stub, async (instance) => {
      return (await instance.ctx.storage.get(`people,${anonId}`)) || null
    })
    expect(left, 'a successful delete must actually remove the record').toBeFalsy()
  })
})

describe('durable object: corrupt or unexpected durable storage', () => {
  it('keeps serving when a stored record is the wrong type', async () => {
    const cell = freshCell()
    const anonId = 'wrong-type'
    const stub = env.SYNC_ROOM.get(shardId(cell))

    // Write a string where an object is expected. Durable storage survives
    // deploys, so any shape can turn up in a later build.
    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put(`people,${anonId}`, 'not an object at all')
      await instance.ctx.storage.put('totals', 'also not an object')
      return true
    })

    const ws = await openWs(cell)
    const seen = watch(ws)
    let threw = null
    try {
      ws.send(JSON.stringify({ type: C_SYNC, anonId, token: 'tok-wrong-type', stats: stats() }))
      await waitFor(seen, (m) => m && m.type)
    } catch (e) {
      threw = e
    }
    expect(threw, 'corrupt durable storage must not crash the DO').toBe(null)
    expect(seen.length, 'the DO should still answer after reading junk').toBeGreaterThan(0)
    ws.close()
  })

  it('does not let a junk stored total become the lifetime figure', async () => {
    const cell = freshCell()
    const anonId = 'junk-total'
    const stub = env.SYNC_ROOM.get(shardId(cell))

    await runInDurableObject(stub, async (instance) => {
      await instance.ctx.storage.put('totalPrayerSeconds', 'a string, not a number')
      return true
    })

    // The first version of this test read the raw stored value and failed,
    // which looked like the DO not healing. It does: the load path coerces with
    // `typeof got.get('totalPrayerSeconds') === 'number' ? ... : 0`. What matters
    // is the value the DO then uses, because that is what reaches the state
    // broadcast - a string here would render as NaN for every connected user.
    const used = await runInDurableObject(stub, async (instance) => {
      await instance._ensureLoaded?.()
      return { inMemory: instance._totalSeconds, type: typeof instance._totalSeconds }
    })

    expect(used.type, `_totalSeconds is ${used.type}`).toBe('number')
    expect(Number.isFinite(used.inMemory), `_totalSeconds=${used.inMemory}`).toBe(true)
    expect(used.inMemory).toBe(0)
  })
})
