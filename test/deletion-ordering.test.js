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

describe('the Android app shell', () => {
  // These are the cases a browser or a Node client never exercises, and they
  // are the ones the Play build actually depends on. Found by running the real
  // app on a Pixel: the WebSocket upgrade was refused and every fetch came back
  // as "Failed to fetch", so deletion silently reported "offline" on Android
  // and had never worked there at all.
  const NATIVE = 'capacitor://localhost'
  const ALLOWED = 'https://joining-palms.app,https://www.joining-palms.app'

  it('admits the WebSocket upgrade from the app shell', async () => {
    const res = await exports.default.fetch('http://sync-engine.local/?cell=1,2', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: NATIVE }
    })
    expect(res.status).toBe(101)
  })

  it('still refuses an unrecognised origin', async () => {
    const res = await exports.default.fetch('http://sync-engine.local/?cell=1,3', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: 'https://evil.example' }
    })
    expect(res.status).toBe(403)
  })

  it('still refuses an arbitrary OPAQUE origin (no cross-site hijack)', async () => {
    // The whole reason capacitor:// is compared literally rather than through
    // the origin normaliser: normalising both sides yields null === null, which
    // would admit every opaque origin on the internet.
    for (const origin of ['null', 'file://', 'some-app://localhost', 'capacitor://evil']) {
      const res = await exports.default.fetch('http://sync-engine.local/?cell=1,4', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: origin }
      })
      expect(res.status, `origin ${origin} must be refused`).toBe(403)
    }
  })

  it('answers the preflight so the browser will make the real request', async () => {
    const res = await exports.default.fetch('http://sync-engine.local/delete', {
      method: 'OPTIONS',
      headers: { Origin: NATIVE, 'access-control-request-method': 'POST' }
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(NATIVE)
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type')
  })

  it('sends CORS headers on EVERY delete outcome, not just success', async () => {
    // A blocked body is indistinguishable from being offline, so a missing
    // header on any branch reads to the client as "could not reach the server".
    const cases = [
      { body: { anonId: 'cors-a', token: 'tok-a' }, want: 404 }, // not_found
      { body: { anonId: 'cors-b' }, want: 400 }, // bad_request
      { body: {}, want: 400 }
    ]
    for (const c of cases) {
      const res = await exports.default.fetch('http://sync-engine.local/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: NATIVE, 'CF-Connecting-IP': nextIp() },
        body: JSON.stringify(c.body)
      })
      expect(res.status).toBe(c.want)
      expect(res.headers.get('access-control-allow-origin'), `body ${JSON.stringify(c.body)}`).toBe(NATIVE)
    }
  })

  it('sends no CORS header to an origin we do not recognise', async () => {
    const res = await exports.default.fetch('http://sync-engine.local/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://evil.example', 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify({ anonId: 'x', token: 'y' })
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('admits the app shell for /delete even though the route has its own check', async () => {
    const res = await exports.default.fetch('http://sync-engine.local/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: NATIVE, 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify({ anonId: 'cors-c', token: 'tok-c' })
    })
    expect(res.status).toBe(404) // not_found, i.e. not "forbidden"
  })

  void ALLOWED
})

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