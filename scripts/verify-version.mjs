// sync-engine — assert that the *live* deployed version of this Worker carries
// the full Worker contract, not a config-stripped static-assets upload.
//
// The failure that started this module: four real deploys (7f4214e9, df572735,
// f1004206, 571802ca) uploaded public/ as a Pages-style website — no fetch
// handler, no bindings, SPA not-found fallback, compatibility_date defaulted to
// the deploy day — and hijacked joining-palms.app. The HTTP /health + /stats +
// WebSocket checks (verify-live.mjs) only notice hours later, when traffic has
// already landed on the assets fallback.
//
// This checks the source of truth instead: the Worker's own deployments /
// versions API. A version is "good" iff its resources carry the same contract
// wrangler.toml declares today. Used as the post-deploy gate in deploy-app.mjs
// and as a scheduled check in .github/workflows/uptime.yml.
//
// Standalone: node scripts/verify-version.mjs   (exit 0 = live contract OK)

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Pure contract assertion (unit-testable, no network).
// ---------------------------------------------------------------------------

// The bindings every healthy deploy of this Worker must declare. The bad
// uploads declared none; a worker-first assets config is also required.
const TOML_REQUIRED_BINDINGS = ['ASSETS', 'SYNC_ROOM', 'COORDINATOR', 'TOTALS_BACKUP']

export function assertVersionContract(resources, expected) {
  const reasons = []

  const handlers = resources?.['script']?.handlers ?? []
  if (!Array.isArray(handlers) || !handlers.includes('fetch')) {
    reasons.push(`script.handlers missing 'fetch' (got ${JSON.stringify(handlers)})`)
  }

  const names = new Set((resources?.bindings ?? []).map((b) => b?.name))
  for (const required of expected.requiredBindings) {
    if (!names.has(required)) reasons.push(`binding '${required}' missing`)
  }

  const compat = resources?.script_runtime?.compatibility_date
  if (compat !== expected.compatDate) {
    reasons.push(`compatibility_date=${compat} (want ${expected.compatDate})`)
  }

  const assets = resources?.script_runtime?.assets
  if (!assets) {
    reasons.push('no assets runtime — worker-first routing unverifiable')
  } else {
    if (assets.not_found_handling === 'single-page-application') {
      reasons.push('assets fallback is SPA (single-page-application)')
    }
    const rwf = assets.raw_run_worker_first
    if (rwf === false || !Array.isArray(rwf)) {
      reasons.push(`run_worker_first not set (got ${JSON.stringify(rwf)})`)
    } else {
      for (const p of ['/health', '/stats']) {
        if (!rwf.includes(p)) reasons.push(`run_worker_first missing '${p}'`)
      }
    }
  }

  return reasons
}

// The contract wrangler.toml currently demands. Keep in sync with the config
// drift tests in test/config.test.js.
export function expectedContractFromToml(tomlPath = path.join(ROOT, 'wrangler.toml')) {
  const raw = readFileSync(tomlPath, 'utf8')
  const compat = raw.match(/^\s*compatibility_date\s*=\s*"([^"]+)"/m)?.[1] ?? null
  return { compatDate: compat, requiredBindings: [...TOML_REQUIRED_BINDINGS] }
}

export function scriptNameFromToml(tomlPath = path.join(ROOT, 'wrangler.toml')) {
  return readFileSync(tomlPath, 'utf8').match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null
}

// ---------------------------------------------------------------------------
// Credentials: env token first (CI), wrangler OAuth token fallback (local).
// ---------------------------------------------------------------------------

function oauthTokenFromConfigFiles() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates = []
  if (process.env.XDG_CONFIG_HOME) {
    candidates.push(path.join(process.env.XDG_CONFIG_HOME, '.wrangler', 'config', 'default.toml'))
  }
  candidates.push(path.join(home, '.config', '.wrangler', 'config', 'default.toml'))
  candidates.push(path.join(home, '.wrangler', 'config', 'default.toml'))
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml'))
  }
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf8')
      const m = raw.match(/^\s*oauth_token\s*=\s*"([^"]+)"/m)
      if (m?.[1]) return m[1]
    } catch {}
  }
  return null
}

async function resolveCredentials({ requireAuth }) {
  const token = process.env.CLOUDFLARE_API_TOKEN || oauthTokenFromConfigFiles()
  if (!token) {
    if (!requireAuth) return { token: null, accountId: null }
    throw new Error('no Cloudflare credentials (set CLOUDFLARE_API_TOKEN or run `npx wrangler login`)')
  }
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!accountId) {
    const r = await fetch('https://api.cloudflare.com/client/v4/memberships', {
      headers: { authorization: `Bearer ${token}` }
    })
    const j = await r.json()
    const accepted = j?.result?.find((m) => m?.status === 'accepted' && m?.account?.id)
    accountId = accepted?.account?.id ?? j?.result?.[0]?.account?.id
  }
  if (!accountId) throw new Error('could not resolve Cloudflare account id')
  return { token, accountId }
}

// ---------------------------------------------------------------------------
// Cloudflare API plumbing.
// ---------------------------------------------------------------------------

async function cfGet(token, url) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`Cloudflare ${r.status} for ${url}`)
  const j = await r.json()
  if (!j?.success) throw new Error(`Cloudflare error: ${JSON.stringify(j?.errors ?? j)}`)
  return j.result
}

// The id of the version currently serving 100%. Uses the format wrangler.toml
// deploys (percentage strategy, single 100% version per deployment).
async function liveVersionId({ token, accountId }, script) {
  const deployments = await cfGet(
    token,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${script}/deployments?per_page=5`
  )
  const list = Array.isArray(deployments)
    ? deployments
    : (deployments?.deployments ?? [])
  const live = list.find((d) => d?.versions?.[0]?.percentage === 100) ?? list[0]
  const vid = live?.versions?.[0]?.version_id
  if (!vid) throw new Error('no live deployment with a 100% version found')
  return vid
}

async function fetchVersionResources({ token, accountId }, script, versionId) {
  return cfGet(
    token,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${script}/versions/${versionId}`
  ).then((result) => result?.resources ?? result)
}

// ---------------------------------------------------------------------------
// The check itself.
// ---------------------------------------------------------------------------

export async function checkLiveVersionContract({
  script = scriptNameFromToml(),
  requireAuth = true,
  getVersion = liveVersionId,
  getResources = fetchVersionResources
} = {}) {
  const credentials = await resolveCredentials({ requireAuth })
  if (!credentials.token) {
    return { ok: true, skipped: 'no Cloudflare credentials available; version-contract check skipped' }
  }
  const versionId = await getVersion(credentials, script)
  const resources = await getResources(credentials, script, versionId)
  const expected = expectedContractFromToml()
  const reasons = assertVersionContract(resources, expected)
  return { ok: reasons.length === 0, versionId, reasons, expected }
}

// ---------------------------------------------------------------------------
// CLI entry: node scripts/verify-version.mjs
// ---------------------------------------------------------------------------

async function main() {
  try {
    const result = await checkLiveVersionContract({ requireAuth: true })
    if (result.skipped) {
      console.log(`[verify-version] SKIPPED — ${result.skipped}`)
      process.exit(0)
    }
    console.log(`[verify-version] live ${result.versionId}: ${result.ok ? 'contract OK' : 'CONTRACT VIOLATED'}`)
    for (const reason of result.reasons) console.log(`[verify-version]   ✗ ${reason}`)
    process.exit(result.ok ? 0 : 1)
  } catch (e) {
    console.error(`[verify-version] ✗ ${e?.message ?? e}`)
    process.exit(1)
  }
}

const invoked = process.argv[1]
if (invoked && path.resolve(invoked) === fileURLToPath(import.meta.url)) main()