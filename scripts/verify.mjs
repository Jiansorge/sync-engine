// sync-engine — post-deploy verification.
//
//   npm run verify -- https://<your-worker>.workers.dev
//   npm run verify -- https://<your-worker>.workers.dev --skip-ws
//
// Checks /health + /stats over HTTP, then runs a live WebSocket smoke
// (presence → state → sync → ping/pong) unless --skip-ws.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const url = args.find((a) => a.startsWith('http')) || args[0]
const skipWs = args.includes('--skip-ws')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

if (!url) {
  console.log('usage: npm run verify -- https://<worker>.workers.dev [--skip-ws]')
  process.exit(1)
}

let failed = false
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

console.log(`Verifying ${url}\n`)

// /health
try {
  const h = await fetch(`${url}/health`)
  const j = await h.json()
  check('GET /health', h.ok && j.ok === true && j.protocol === 3, JSON.stringify(j))
} catch (e) {
  check('GET /health', false, e.message)
}

// /stats
try {
  const s = await fetch(`${url}/stats`)
  const j = await s.json()
  check(
    'GET /stats',
    s.ok && typeof j.seconds === 'number' && j.counts && typeof j.counts.connects === 'number',
    `seconds=${j.seconds} errors=${j.errors ?? 0} shards=${j.shards}`
  )
} catch (e) {
  check('GET /stats', false, e.message)
}

// Live WebSocket smoke
if (!skipWs) {
  const wsUrl = url.replace(/^https/, 'wss').replace(/^http/, 'ws')
  console.log('\nRunning live WebSocket smoke…')
  const r = spawnSync(npmCmd, ['run', 'smoke', '--', wsUrl], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  check('WS smoke (presence→state→sync→ping/pong)', r.status === 0)
} else {
  console.log('\nSkipping WS smoke (--skip-ws).')
}

console.log(failed ? '\nVERIFY FAILED' : '\nALL CHECKS PASSED')
process.exit(failed ? 1 : 0)
