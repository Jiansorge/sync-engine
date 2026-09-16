// sync-engine — post-deploy verification (manual CLI).
//
//   npm run verify -- https://<your-worker>.workers.dev
//   npm run verify -- https://<your-worker>.workers.dev --skip-ws
//
// Checks /health + /stats over HTTP (asserting Worker JSON, not the SPA HTML
// fallback, and the current PROTOCOL_VERSION), then runs a live WebSocket
// smoke (presence → state → sync → ping/pong) unless --skip-ws. This is the
// thin CLI front for scripts/verify-live.mjs — the identical checks back the
// automatic post-deploy gate in scripts/deploy-app.mjs.

import { verifyLive } from './verify-live.mjs'

const args = process.argv.slice(2)
const url = args.find((a) => a.startsWith('http')) || args[0]
const skipWs = args.includes('--skip-ws')

if (!url) {
  console.log('usage: npm run verify -- https://<worker>.workers.dev [--skip-ws]')
  process.exit(1)
}

console.log(`Verifying ${url}\n`)

const { ok, failed, passed } = await verifyLive(url, { skipWs })
for (const p of passed) console.log(`PASS  ${p.name}${p.detail ? ` — ${p.detail}` : ''}`)
for (const f of failed) console.log(`FAIL  ${f.name} — ${f.detail}`)

if (skipWs) console.log('\nSkipping WS smoke (--skip-ws).')
console.log(ok && failed.length === 0 ? '\nALL CHECKS PASSED' : '\nVERIFY FAILED')
process.exit(ok && failed.length === 0 ? 0 : 1)