// Tiny WebSocket smoke client for sync-engine.
// Usage: npm run smoke            (against npm run dev → ws://localhost:8787)
//        npm run smoke wss://yoursite.example.com/ws
// Exercises the full handshake: presence → state broadcast → sync merge → ping/pong.

const url = process.argv[2] || 'ws://localhost:8787'
const log = (...a) => console.log('[smoke]', ...a)
let failures = 0
const goal = (name, ok) => {
  log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failures++
}

// A deterministic anonymous identity + stats for the merge check.
const ANON_ID = `smoke-${Math.random().toString(36).slice(2, 8)}`
const STATS = {
  prayerCompletions: { 'lords-prayer': 3 },
  localPrayerSeconds: 42,
  bestStreak: 2
}

const ws = new WebSocket(url)
let gotState = false
let gotFeed = false

ws.addEventListener('open', () => {
  log('open')
  ws.send(
    JSON.stringify({
      type: 'presence',
      praying: true,
      prayerId: 'lords-prayer',
      spiritId: 'christianity',
      name: 'Smoke Tester',
      cell: '40,20'
    })
  )
  ws.send(JSON.stringify({ type: 'sync', anonId: ANON_ID, stats: STATS }))
  ws.send(JSON.stringify({ type: 'ping' }))
})

ws.addEventListener('message', (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    log('unparseable message', ev.data)
    return
  }
  if (msg.type === 'pong') goal('ping → pong', true)
  if (msg.type === 'sync' && msg.stats) goal('sync merge', msg.stats.localPrayerSeconds === 42)
  if (msg.type === 'state') {
    gotState = true
    goal(
      'state broadcast',
      typeof msg.people === 'number' &&
        typeof msg.totalPrayerSeconds === 'number' &&
        msg.totals && typeof msg.totals.prayers === 'object'
    )
  }
  if (msg.type === 'feed') {
    gotFeed = true
    goal('feed broadcast', Array.isArray(msg.feed))
  }
})

ws.addEventListener('close', (ev) => log(`closed (code ${ev.code})`))
ws.addEventListener('error', () => log('socket error'))

setTimeout(() => {
  if (!gotState) goal('state broadcast', false)
  if (!gotFeed) goal('feed broadcast', false)
  log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures} checks)`)
  process.exitCode = failures === 0 ? 0 : 1
  try {
    ws.close()
  } catch {}
}, 3000)