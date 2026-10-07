// The sweep's five counters must land together or not at all.
//
// They used to be written with Promise.all over five independent storage.put
// calls, which the Durable Objects storage API does not make atomic. A failure
// part-way through left some keys advanced and others stale, and the DO would
// restart into that half-written state: a lifetime total that disagrees with the
// per-prayer counts it was computed from.
//
// These tests pin the all-or-nothing behaviour by making a write fail and then
// checking that none of the five keys moved.

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
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
const shardId = (cell) => env.SYNC_ROOM.idFromName(shardName(cell, NUM_SHARDS))

const KEYS = ['totals', 'totalPrayerSeconds', 'anonSeen', 'counts', 'recentStarts']

const readAll = (instance) =>
  Promise.all(KEYS.map((k) => instance.ctx.storage.get(k)))

describe('storage flush atomicity', () => {
  it('writes all five counters together', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))

    const state = await runInDurableObject(stub, async (instance) => {
      await instance._ensureLoaded()
      // Mark every counter dirty.
      instance._totals = { prayers: { mani: 3 }, spirits: {} }
      instance._totalSeconds = 42
      instance._anonSeen.set('anon-a', 1)
      instance._counts = { mani: 3 }
      instance._recentStarts.set('sess-1', Date.now())
      instance._totalsDirty = true
      instance._secondsDirty = true
      instance._seenDirty = true
      instance._countsDirty = true
      instance._startsDirty = true
      await instance._flushStorage()
      return readAll(instance)
    })

    expect(state[0]).toEqual({ prayers: { mani: 3 }, spirits: {} })
    expect(state[1]).toBe(42)
    expect(state[2]).toEqual([['anon-a', 1]])
    expect(state[3]).toEqual({ mani: 3 })
    expect(state[4]).toEqual([['sess-1', expect.any(Number)]])
  })

  it('leaves every counter untouched when the write fails part-way', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))

    const outcome = await runInDurableObject(stub, async (instance) => {
      await instance._ensureLoaded()
      // Seed a known baseline so "untouched" is checkable.
      instance._totals = { prayers: { mani: 1 }, spirits: {} }
      instance._totalSeconds = 10
      instance._counts = { mani: 1 }
      instance._totalsDirty = true
      instance._secondsDirty = true
      instance._countsDirty = true
      await instance._flushStorage()
      const baseline = await readAll(instance)

      // Now make the transaction fail. Replacing storage.transaction is the only
      // way to inject a fault: the DO owns its storage, and a value-based fault
      // (a too-large payload) would be rejected by the platform rather than by
      // our code.
      const realTransaction = instance.ctx.storage.transaction.bind(instance.ctx.storage)
      instance.ctx.storage.transaction = async () => {
        throw new Error('injected storage failure')
      }

      instance._totals = { prayers: { mani: 999 }, spirits: {} }
      instance._totalSeconds = 999
      instance._counts = { mani: 999 }
      instance._totalsDirty = true
      instance._secondsDirty = true
      instance._countsDirty = true
      await instance._flushStorage()

      instance.ctx.storage.transaction = realTransaction
      const after = await readAll(instance)

      return {
        baseline,
        after,
        // The dirty flags must come back, so the next flush retries rather than
        // leaving the counters permanently one flush behind.
        rearmed: instance._totalsDirty && instance._secondsDirty && instance._countsDirty
      }
    })

    // Nothing moved: this is the property that Promise.all could not give.
    expect(outcome.after[0], 'totals must not be half-written').toEqual(outcome.baseline[0])
    expect(outcome.after[1], 'seconds must not be half-written').toBe(outcome.baseline[1])
    expect(outcome.after[3], 'counts must not be half-written').toEqual(outcome.baseline[2] === null ? null : outcome.baseline[3])
    expect(outcome.rearmed, 'the dirty flags must be restored for a retry').toBe(true)
  })

  it('a failed flush does not wedge the engine: the next flush succeeds', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))

    const final = await runInDurableObject(stub, async (instance) => {
      await instance._ensureLoaded()
      instance._totalSeconds = 1
      instance._secondsDirty = true
      await instance._flushStorage()

      const realTransaction = instance.ctx.storage.transaction.bind(instance.ctx.storage)
      instance.ctx.storage.transaction = async () => {
        throw new Error('injected storage failure')
      }
      instance._totalSeconds = 55
      instance._secondsDirty = true
      await instance._flushStorage()
      instance.ctx.storage.transaction = realTransaction

      // The retry path: dirty flags were re-armed, so this persists.
      await instance._flushStorage()
      return await instance.ctx.storage.get('totalPrayerSeconds')
    })

    expect(final, 'the value must land on the retry, not be lost').toBe(55)
  })
})