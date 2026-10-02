// Live verification that the deletion tombstone is deployed and working.
//
// Uses a disposable identity and removes it at the end, so it leaves nothing
// behind. The response to /delete now carries a `withdrawn` field that older
// builds did not send, so its presence is itself proof the new code is running.

const BASE = 'https://joining-palms.app'
const ANON = 'live-tombstone-verify-' + Math.random().toString(36).slice(2, 9)
const TOKEN = 'tok-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)

const STATS = { localPrayerSeconds: 11, prayerCompletions: { mani: 1 } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('https', 'wss')}/?cell=11,22`)
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', (e) => reject(new Error('ws error ' + (e.message || ''))))
    setTimeout(() => reject(new Error('ws open timeout')), 20000)
  })
}

async function sync(ws) {
  const reply = new Promise((resolve) => {
    ws.addEventListener(
      'message',
      (ev) => {
        try {
          const m = JSON.parse(ev.data)
          if (m.type === 'sync') resolve(m)
        } catch {}
      },
      { once: false }
    )
  })
  ws.send(JSON.stringify({ type: 'sync', anonId: ANON, token: TOKEN, stats: STATS }))
  return reply
}

const del = async () => {
  const r = await fetch(`${BASE}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ anonId: ANON, token: TOKEN })
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

console.log('identity:', ANON)

// 1. register the identity
let ws = await openWs()
let reply = await sync(ws)
console.log('1. registered       ->', reply.type, 'localPrayerSeconds =', reply.stats?.localPrayerSeconds)
if (reply.stats?.localPrayerSeconds !== 11) throw new Error('registration did not take')
ws.close()
await sleep(1500)

// 2. delete
const first = await del()
console.log('2. delete           ->', first.status, JSON.stringify(first.body))
if (first.status !== 200) throw new Error('delete failed: ' + first.status)
if (!('withdrawn' in (first.body || {}))) {
  console.log('   WARNING: no `withdrawn` field - the old Worker may still be live')
}

// 3. the resurrection attempt: a fresh connection, as if a backup were restored
ws = await openWs()
reply = await sync(ws)
console.log('3. re-sync          ->', JSON.stringify(reply).slice(0, 150))

const resurrected = reply.stats && reply.stats.localPrayerSeconds === 11 && !reply.reissued && !reply.error
if (resurrected) {
  console.log('   FAIL: the deleted record came back')
} else if (reply.error === 'deleted') {
  console.log('   ok: refused, because this device does not hold the deleting token')
} else if (reply.reissued) {
  console.log('   ok: reissued a fresh identity ->', reply.anonId)
  console.log('        (correct: same person on another device keeps their prayers)')
} else {
  console.log('   INCONCLUSIVE: reply was', JSON.stringify(reply))
}
ws.close()

// 4. clean up: the fresh identity, if one was issued, gets deleted too
if (reply.anonId && reply.reissued) {
  const r = await fetch(`${BASE}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ anonId: reply.anonId, token: TOKEN })
  })
  console.log('4. cleanup reissued ->', r.status)
}

console.log('\nverification complete')