// Ordering and re-creation paths of self-service deletion that worker.test.js
// does not cover.
//
// The one that matters is resurrection. Deletion closes the requesting device's
// socket, so THAT device cannot bring the record back. But the whole point of a
// recovery code is that several devices hold one identity, and a device that
// was offline at the time - a backup restored onto a new phone - has no socket
// to close. It connects afterwards and syncs, and with no tombstone the Worker
// rebuilds everything the user just erased while we have already told them it
// was gone.

import { describe, it, expect } from 'vitest'
import { env, exports } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { C_SYNC, E_SYNC } from '../src/protocol.js'
import { shardName, shardIndex } from '../src/shard.js'
import { dayKey } from '../src/stats.js'

const NUM_SHARDS = 32
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ipCounter = 9000
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`

function cellOnShard(shard) {
  for (let c = 0; c < 5000; c++) {
    const cell = `1,${shard * 97 + c * 13}`
    if (shardIndex(cell, NUM_SHARDS) === shard) return cell
  }
  throw new Error(`no cell found for shard ${shard}`)
}
// Shards 20-31: clear of worker.test.js's 0-31 range, so the two files cannot
// collide if vitest shares Durable Object storage between them.
let nextShard = 20
const freshCell = () => cellOnShard(nextShard++ % 12 + 20)
const shardId = (cell) => env.SYNC_ROOM.idFromName(shardName(cell, NUM_SHARDS))
const peopleKeyFor = (id) => `people,${id}`

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
    const m = seen.find(pred)
    if (m) return m
    await sleep(10)
  }
  throw new Error('timed out waiting for a message')
}

const post = (body, ip = nextIp()) =>
  exports.default.fetch('http://sync-engine.local/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body)
  })

const stats = {
  localPrayerSeconds: 42,
  prayerCompletions: { 'lords-prayer': 3 },
  bestStreak: 4,
  lastPrayedDay: dayKey()
}

describe('deletion ordering and re-creation', () => {
  it('does NOT resurrect a deleted identity when a stale sync lands afterwards', async () => {
    const cell = freshCell()
    const stub = env.SYNC_ROOM.get(shardId(cell))
    const ws = await openWs(cell)
    const seen = watch(ws)

    ws.send(JSON.stringify({ type: C_SYNC, anonId: 'resurrect-me', token: 'tok-r', stats }))
    await waitFor(seen, (m) => m.type === E_SYNC && m.stats)

    const res = await post({ anonId: 'resurrect-me', token: 'tok-r' })
    expect(res.status).toBe(200)

    // The in-flight sync, built before the delete, arriving after it.
    ws.send(JSON.stringify({ type: C_SYNC, anonId: 'resurrect-me', token: 'tok-r', stats }))
    await waitFor(seen, (m) => m.type === E_SYNC)
    await runInDurableObject(stub, async (i) => {
      await i._flushStorage()
    })

    const back = await runInDurableObject(stub, async (i) =>
      i.ctx.storage.get(peopleKeyFor('resurrect-me'))
    )
    expect(back).toBeUndefined()
    ws.close()
  })

  it(
    'a device that was offline at delete time cannot resurrect the record',
    async () => {
      const cell = freshCell()
      const stub = env.SYNC_ROOM.get(shardId(cell))

      const tablet = await openWs(cell)
      const tabletSeen = watch(tablet)
      tablet.send(JSON.stringify({ type: C_SYNC, anonId: 'two-devices', token: 'tok-2d', stats }))
      await waitFor(tabletSeen, (m) => m.type === E_SYNC && m.stats)

      // The tablet's record now has the token the delete will use.
      const rec = await runInDurableObject(stub, async (i) =>
        i.ctx.storage.get(peopleKeyFor('two-devices'))
      )
      expect(rec.tokenHash).toBeTruthy()

      const res = await post({ anonId: 'two-devices', token: 'tok-2d' })
      expect(res.status).toBe(200)

      // The tombstone must hold a hash, never the token: it authorises a
      // reissue, not a deletion.
      const tomb = await runInDurableObject(stub, async (i) =>
        i.ctx.storage.get('deleted,two-devices')
      )
      expect(tomb.tokenHash).toBeTruthy()
      expect(tomb.tokenHash).not.toBe('tok-2d')
      expect(tomb.tokenHash).toBe(rec.tokenHash)

      // The phone was offline: a backup restored onto a new device, connecting
      // for the first time since the delete. No socket existed to be closed.
      tablet.close()
      await sleep(100)
      const phone = await openWs(cell)
      const phoneSeen = watch(phone)
      phone.send(JSON.stringify({ type: C_SYNC, anonId: 'two-devices', token: 'tok-2d', stats }))
      const reply = await waitFor(phoneSeen, (m) => m.type === E_SYNC)
      await runInDurableObject(stub, async (i) => {
        await i._flushStorage()
      })

      // The erased record must not come back.
      const back = await runInDurableObject(stub, async (i) =>
        i.ctx.storage.get(peopleKeyFor('two-devices'))
      )
      expect(back).toBeUndefined()

      // The legitimate owner is reissued a fresh identity rather than being
      // silently dropped - same person, and losing their prayers would be its
      // own data loss.
      expect(reply.reissued).toBe(true)
      expect(reply.anonId).toBeTruthy()
      expect(reply.anonId).not.toBe('two-devices')
      const fresh = await runInDurableObject(stub, async (i) =>
        i.ctx.storage.get(peopleKeyFor(reply.anonId))
      )
      expect(fresh.localPrayerSeconds).toBe(42)

      // Someone WITHOUT the deleting token is refused outright, and refused
      // loudly: a silent success would let them believe their history is saved
      // when nothing is being written.
      const stranger = await openWs(cell)
      const strangerSeen = watch(stranger)
      stranger.send(JSON.stringify({ type: C_SYNC, anonId: 'two-devices', token: 'tok-wrong', stats }))
      const denied = await waitFor(strangerSeen, (m) => m.type === E_SYNC && m.error === 'deleted')
      expect(denied.error).toBe('deleted')
      expect(
        await runInDurableObject(stub, async (i) => i.ctx.storage.get(peopleKeyFor('two-devices')))
      ).toBeUndefined()

      stranger.close()
      phone.close()
    },
    20000
  )

  it('refuses a brand-new anonId that never existed', async () => {
    const res = await post({ anonId: 'never-existed-at-all', token: 'tok-x' })
    expect(res.status).toBe(404)
  })

  it('leaves a synced-before-tokens record intact when the delete is refused', async () => {
    const cell = freshCell()
    const ws = await openWs(cell)
    const seen = watch(ws)
    // No token on the first sync: exactly what a pre-feature device looks like.
    ws.send(JSON.stringify({ type: C_SYNC, anonId: 'legacy-no-token', stats }))
    await waitFor(seen, (m) => m.type === E_SYNC && m.stats)

    const res = await post({ anonId: 'legacy-no-token', token: 'tok-invented' })
    expect(res.status).toBe(404)

    // A refused attempt must not damage the record.
    ws.send(JSON.stringify({ type: C_SYNC, anonId: 'legacy-no-token', stats }))
    const still = await waitFor(
      seen,
      (m) => m.type === E_SYNC && m.stats && m.stats.localPrayerSeconds === 42
    )
    expect(still.stats.localPrayerSeconds).toBe(42)
    ws.close()
  })
})