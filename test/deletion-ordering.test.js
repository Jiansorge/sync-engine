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
  // Found by installing the app on a Pixel. Both failures here are invisible to
  // the rest of the suite, because it only ever exercises a browser origin and
  // a Node client that sends no Origin at all.
  //
  // The app shell is served from https://localhost, because capacitor.config
  // sets androidScheme:https. That matters: the previous scheme
  // (capacitor://) is a non-special scheme, so it is an OPAQUE origin, and
  // browsers serialise an opaque origin's header as the literal string "null".
  const SHELL = 'https://localhost'

  it('admits the WebSocket upgrade from the app shell', async () => {
    const res = await exports.default.fetch('http://sync-engine.local/?cell=1,2', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: SHELL }
    })
    expect(res.status).toBe(101)
  })

  it('REFUSES the opaque origin "null", even though our own app used to send it', async () => {
    // The trap this guards. "null" is what the app sent before androidScheme
    // was changed, and the tempting fix is to allow-list it - which would let
    // every sandboxed iframe, file:// page and data: document on the internet
    // open a WebSocket here. The app must fix its own origin instead, which it
    // now does. So "null" stays refused, permanently.
    const res = await exports.default.fetch('http://sync-engine.local/?cell=1,3', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: 'null' }
    })
    expect(res.status).toBe(403)
  })

  it('still refuses an unrecognised origin', async () => {
    const res = await exports.default.fetch('http://sync-engine.local/?cell=1,4', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: 'https://evil.example' }
    })
    expect(res.status).toBe(403)
  })

  it('still refuses other opaque schemes', async () => {
    for (const origin of ['file://', 'some-app://localhost', 'capacitor://localhost', 'capacitor://']) {
      const res = await exports.default.fetch('http://sync-engine.local/?cell=1,5', {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: origin }
      })
      expect(res.status, `origin ${origin} must be refused`).toBe(403)
    }
  })

  it('answers the preflight so the browser will make the real request', async () => {
    const res = await exports.default.fetch('http://sync-engine.local/delete', {
      method: 'OPTIONS',
      headers: { Origin: SHELL, 'access-control-request-method': 'POST' }
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(SHELL)
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type')
  })

  it('sends CORS headers on EVERY delete outcome, not just success', async () => {
    // A blocked body is indistinguishable from being offline, so a missing
    // header on any branch reads to the client as "could not reach the server".
    const cases = [
      { body: { anonId: 'cors-a', token: 'tok-a' }, want: 404 },
      { body: { anonId: 'cors-b' }, want: 400 },
      { body: {}, want: 400 }
    ]
    for (const c of cases) {
      const res = await exports.default.fetch('http://sync-engine.local/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: SHELL, 'CF-Connecting-IP': nextIp() },
        body: JSON.stringify(c.body)
      })
      expect(res.status).toBe(c.want)
      expect(res.headers.get('access-control-allow-origin'), JSON.stringify(c.body)).toBe(SHELL)
    }
  })

  it('sends no CORS header to an origin we do not recognise', async () => {
    for (const origin of ['https://evil.example', 'null']) {
      const res = await exports.default.fetch('http://sync-engine.local/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: origin, 'CF-Connecting-IP': nextIp() },
        body: JSON.stringify({ anonId: 'x', token: 'y' })
      })
      expect(res.headers.get('access-control-allow-origin'), `origin ${origin}`).toBeNull()
    }
  })

  it('the allow-list the Worker actually receives admits the app shell', async () => {
    // Assert on the real binding rather than re-reading wrangler.toml: this is
    // the value production runs with, and it also proves vitest.config.js is
    // wired to that file instead of a hardcoded string. (The workers pool has a
    // virtualised cwd, so reading the file from inside a test does not work.)
    const list = String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    expect(list.length).toBeGreaterThan(0)
    expect(list).toContain('https://localhost')
    // The trap must stay closed: "null" is not an origin we own.
    expect(list).not.toContain('null')
    // Every entry must be a real, normalisable origin. An opaque scheme would
    // normalise to null and be widened into "any opaque origin" by the
    // allow-list, which is the hijack this all guards against.
    for (const o of list) {
      expect(new URL(o).origin, `${o} must have a normalisable origin`).not.toBe('null')
    }
    // And the production hosts are still there, not replaced by the app shell.
    expect(list).toContain('https://joining-palms.app')
  })
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