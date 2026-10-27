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
//
// `requiredBindings` is overridable because the staging Worker
// (joining-palms-staging) intentionally omits the TOTALS_BACKUP KV: that
// namespace is disaster recovery for production's lifetime totals, and
// staging's world is disposable test data with nothing worth restoring. See
// [env.staging] in wrangler.toml and TARGETS in scripts/deploy-app.mjs.
export function expectedContractFromToml(
  tomlPath = path.join(ROOT, 'wrangler.toml'),
  { requiredBindings = TOML_REQUIRED_BINDINGS } = {}
) {
  const raw = readFileSync(tomlPath, 'utf8')
  const compat = raw.match(/^\s*compatibility_date\s*=\s*"([^"]+)"/m)?.[1] ?? null
  return { compatDate: compat, requiredBindings: [...requiredBindings] }
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
  const envToken = process.env.CLOUDFLARE_API_TOKEN
  const token = envToken || oauthTokenFromConfigFiles()
  if (!token) {
    if (!requireAuth) return { token: null, accountId: null, source: null }
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
  // Which credential we are on decides whether a 401 is recoverable: a token from
  // the environment is the user's to rotate, while a wrangler OAuth session
  // expires on its own and wrangler will quietly renew it on the next command.
  return { token, accountId, source: envToken ? 'env' : 'oauth' }
}

// ---------------------------------------------------------------------------
// Cloudflare API plumbing.
// ---------------------------------------------------------------------------

async function cfGet(token, url) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok) {
    const err = new Error(`Cloudflare ${r.status} for ${url}`)
    err.status = r.status
    throw err
  }
  const j = await r.json()
  if (!j?.success) throw new Error(`Cloudflare error: ${JSON.stringify(j?.errors ?? j)}`)
  return j.result
}

// Ask wrangler to renew the OAuth session, then pick the refreshed token back up
// out of the config file it rewrites.
//
// The wrangler OAuth token expires on its own schedule (~55 minutes) and only
// wrangler refreshes it - the config file simply holds whatever wrangler last
// wrote. Reading that file directly means this script can be handed a token that
// is minutes from dead, which is exactly the wrong moment to fail: verify-version
// and repair are what you run when production is already down. Rather than
// reimplement the refresh (and wrangler's OAuth client id, which is not in the
// config and would have to be pinned here), call wrangler and let it do the one
// thing it is good at.
//
// Imported lazily because this module is also loaded by the unit tests, which run
// in the Workers runtime where node:child_process does not exist. The refresh is
// only ever reached when a live call has already been rejected, in a real shell,
// so the import never fires where it would break the suite.
async function refreshOauthViaWrangler() {
  const { spawnSync } = await import('node:child_process')
  // Drop the API tokens from the child's environment. repair runs with
  // CF_API_TOKEN set, and wrangler picks that up ("Using CF_API_TOKEN
  // environment variable") and tries to authenticate with it instead of the
  // OAuth session we are here to renew - which fails, because that token is
  // deliberately zone-scoped and cannot read accounts. Only by handing wrangler
  // an environment without either token do we get it to renew its own session.
  const env = { ...process.env }
  delete env.CF_API_TOKEN
  delete env.CLOUDFLARE_API_TOKEN
  const r = spawnSync('npx', ['wrangler', 'whoami'], {
    encoding: 'utf8',
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    // npx is a .cmd on Windows and will not exec without a shell.
    shell: process.platform === 'win32'
  })
  if (r.error) throw r.error
  if (r.status !== 0) {
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.replace(/\s+/g, ' ').trim()
    throw new Error(`wrangler could not renew the OAuth session (exit ${r.status}): ${out.slice(0, 300)}`)
  }
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
  getResources = fetchVersionResources,
  // Overridable so the staging Worker can be held to its own binding set (it
  // has no TOTALS_BACKUP KV by design). Production keeps the default.
  requiredBindings
} = {}) {
  let credentials = await resolveCredentials({ requireAuth })
  if (!credentials.token) {
    return { ok: true, skipped: 'no Cloudflare credentials available; version-contract check skipped' }
  }
  let versionId, resources
  try {
    ;({ versionId, resources } = await loadVersion(credentials, script, getVersion, getResources))
  } catch (e) {
    // A rejected wrangler session is self-healing, so heal it once instead of
    // reporting a broken production to someone whose production is fine.
    //
    // Triggered on 400 as well as 401 because Cloudflare answers 400 for a
    // rejected OAuth token on this endpoint, not the 401 you would expect - a
    // session that has gone bad is not reliably signalled as an auth failure.
    if (!(e?.status === 401 || e?.status === 400) || credentials.source !== 'oauth') throw e
    await refreshOauthViaWrangler()
    credentials = await resolveCredentials({ requireAuth })
    ;({ versionId, resources } = await loadVersion(credentials, script, getVersion, getResources))
  }
  const expected = expectedContractFromToml(path.join(ROOT, 'wrangler.toml'), { requiredBindings })
  const reasons = assertVersionContract(resources, expected)
  return { ok: reasons.length === 0, versionId, reasons, expected }
}

async function loadVersion(credentials, script, getVersion, getResources) {
  const versionId = await getVersion(credentials, script)
  const resources = await getResources(credentials, script, versionId)
  return { versionId, resources }
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