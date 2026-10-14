// Is production healthy right now, and if not, put it back?
//
//   node scripts/repair.mjs            check, and redeploy if the Worker is broken
//   node scripts/repair.mjs --check    check only, never deploy
//
// This exists because of a failure the other scripts could not reach.
//
// deploy-app.mjs verifies the Worker it just deployed, and it verifies correctly.
// But something else also deploys: on every push to prayer-earth a second,
// config-stripped assets-only build lands on joining-palms.app roughly 40 seconds
// later, with no fetch handler, no bindings, a deploy-day compatibility_date and
// SPA not-found handling. Observed and reproduced on 2026-10-14 at 19:30:58Z,
// 39 seconds after CI run #263 started. The uptime workflow only runs about every
// five hours, so the window is real: production serves the SPA shell for /health,
// /stats and the WebSocket handshake - meaning presence, prayer lights, totals and
// anonymous sync are all down - and the first sign of it is a failure email hours
// later.
//
// deploy-dispatch usually overwrites it about nine minutes later with a good
// deploy. When CI is red, nothing overwrites it, and it stays broken. That is the
// shape of the outage this prevents.
//
// What it is, narrowed as far as the available API allows:
//
//   ruled out   deploy-dispatch - skipped on both bad runs, and produced the
//               correct version on #263
//   ruled out   Pages - the account's only Pages project is portfolio-2026,
//               no Git provider, unrelated domain
//   ruled out   this repo - nothing in its scripts references wrangler or the
//               Cloudflare API
//   identified  by assets fingerprint. sync-engine/public/ ships a _headers file
//               (the CSP and cache headers); the stripped version carries NO
//               _headers, and prayer-earth's dist/ has no _headers in it. So the
//               upload is NOT the Worker package - it is prayer-earth's own build
//               output, deployed as static assets with no worker attached, under
//               the same script name. That is the fingerprint of a Workers Builds
//               connection on the prayer-earth repository, whose build config has
//               no `main`.
//
// The Workers Builds config endpoint 401s on the wrangler OAuth token, so it
// cannot be read or disabled from here. It needs an API token with
// Account | Workers Builds | Read (or Edit) on the account.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLiveVersionContract } from './verify-version.mjs'
import { verifyLive } from './verify-live.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.APP_URL || 'https://joining-palms.app'
const CHECK_ONLY = process.argv.includes('--check')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const log = (...a) => console.log('[repair]', ...a)

async function diagnose() {
  const problems = []
  const version = await checkLiveVersionContract({ requireAuth: true })
  if (version.skipped) {
    log('SKIPPED —', version.skipped)
    return null
  }
  if (!version.ok) {
    for (const r of version.reasons) problems.push(`version ${version.versionId}: ${r}`)
  }
  const live = await verifyLive(BASE)
  for (const f of live.failed || []) problems.push(`${f.name} — ${f.detail}`)
  return { version, problems }
}

const result = await diagnose()

if (!result) {
  console.log('[repair] cannot judge without Cloudflare credentials — exiting 2')
  process.exit(2)
}

if (!result.problems.length) {
  console.log(`[repair] production is healthy — ${result.version.versionId} carries the full contract,`)
  console.log('[repair] and /health, /stats and the WebSocket all answer.')
  process.exit(0)
}

console.log(`[repair] PRODUCTION IS BROKEN (${result.version.versionId}):`)
for (const p of result.problems) console.log(`[repair]   ✗ ${p}`)

if (CHECK_ONLY) {
  console.log('[repair] --check given, so nothing was changed.')
  process.exit(1)
}

log(`Redeploying a known-good Worker (this also reattaches the custom domain)…`)
const deploy = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'deploy-app.mjs'), '--skip-tests'], {
  cwd: ROOT, stdio: 'inherit'
})
if (deploy.status !== 0) {
  console.log('[repair] redeploy failed — production is still down. Look at the output above.')
  process.exit(1)
}

const after = await diagnose()
if (after && !after.problems.length) {
  console.log(`[repair] repaired — production is healthy on ${after.version.versionId}.`)
  process.exit(0)
}
console.log('[repair] still broken after redeploy. This needs a human:')
console.log('[repair]   1. Cloudflare dashboard -> Workers -> joining-palms -> Builds')
console.log('[repair]      (something uploads an assets-only build ~40s after a prayer-earth push)')
console.log('[repair]   2. Check for a Git-connected build or integration on the account.')
process.exit(1)