// sync-engine — one-command deploy for Prayer Earth.
//
//   npm run deploy:app            # test → build app (cf engine) → stage → deploy → verify
//   npm run deploy:app:dry        # same, but only dry-run (no real deploy)
//   node scripts/deploy-app.mjs --skip-tests
//
// It builds prayer-earth with VITE_SYNC_ENGINE=cf, stages dist/ into the
// Worker's public/ (so the app and the sync socket share one origin), backs up
// the previous public/, then `wrangler deploy`s and verifies /health.
//
// Rollback: `node scripts/deploy-app.mjs --restore <backup-dir>` then redeploy.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, copyFileSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyLive } from './verify-live.mjs'
import { checkLiveVersionContract } from './verify-version.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')
const PE = path.resolve(ROOT, '..', 'prayer-earth')
const BACKUP_ROOT = path.join(ROOT, 'public-backups')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const args = process.argv.slice(2)
const flags = new Set(args)
const dryRun = flags.has('--dry-run')
const skipTests = flags.has('--skip-tests')
const skipBuild = flags.has('--skip-build')
const stageOnly = flags.has('--stage-only') // build + stage + backup, no deploy
const noAuth = flags.has('--no-auth') // bypass the Cloudflare login check (CI/testing)

// Where this deploy goes, selected with --env=staging (wrangler's own flag
// name, reused so there is one concept of "environment" across the repo).
//
// Stage-first by design: a green push to prayer-earth main deploys STAGING
// (see .github/workflows/deploy.yml), and production only changes when you
// promote it deliberately — workflow_dispatch with target=production, or
// `npm run ship`, which defaults to production.
const TARGETS = {
  production: {
    wranglerEnv: null, // top-level wrangler.toml config, no --env
    base: 'https://joining-palms.app',
    purge: true,
    // requiredBindings intentionally unset: production is held to the full
    // default set (ASSETS + both DOs + TOTALS_BACKUP) from expectedContractFromToml.
  },
  staging: {
    wranglerEnv: 'staging',
    base: 'https://staging.joining-palms.app',
    // Staging omits the edge-cache purge because every Cache Rule is pinned to
    // `http.host eq "joining-palms.app"` (scripts/setup-cache-rules.mjs), so
    // staging's shell is never edge-cached and there is nothing to invalidate.
    purge: false,
    // Staging omits the TOTALS_BACKUP KV on purpose: that namespace is disaster
    // recovery for production's lifetime totals, and staging's world is
    // disposable test data with nothing worth restoring. See [env.staging].
    requiredBindings: ['ASSETS', 'SYNC_ROOM', 'COORDINATOR'],
  },
}
const targetName = (args.find((a) => a.startsWith('--env=')) || '').slice('--env='.length) || 'production'

// The Worker script name for a target, read out of wrangler.toml so the config
// stays the single source of truth rather than duplicating names here.
function scriptNameFor(envName) {
  const raw = readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8')
  if (!envName) return raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null
  // The [env.X] section runs until the next table header, and `name` is its
  // first key.
  const section = raw.match(new RegExp(`^\\[env\\.${envName}\\][^\\[]*`, 'm'))?.[0] ?? ''
  return section.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null
}

function log(...a) {
  console.log('\n[deploy]', ...a)
}
function ok(name) {
  console.log(`[deploy] ✓ ${name}`)
}
function fail(name, detail) {
  const msg = `${name}${detail ? ' — ' + String(detail) : ''}`
  console.error(`[deploy] ✗ ${msg}`)
  throw new Error(msg)
}

function run(cmd, args, opts = {}) {
  // Windows can't spawn .cmd directly without a shell (EINVAL). But a shell
  // also splits *unquoted* paths on spaces — so quote the executable and any
  // arg that contains a space when we're going through a shell.
  const q = (s) => (/ /.test(s) ? `"${s}"` : s)
  const quotedCmd = process.platform === 'win32' ? q(cmd) : cmd
  const quotedArgs = process.platform === 'win32' ? args.map(q) : args
  const r = spawnSync(quotedCmd, quotedArgs, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  if (r.status !== 0) fail(`${quotedCmd} ${quotedArgs.join(' ')}`, 'exited non-zero')
  return r
}

function hasDist() {
  return existsSync(path.join(PE, 'dist', 'index.html'))
}

function restore(backupDir) {
  if (!backupDir) {
    log('usage: node scripts/deploy-app.mjs --restore <public-backups/YYYY-MM-DD_HH-mm-ss>')
    process.exit(1)
  }
  const src = path.join(BACKUP_ROOT, backupDir)
  if (!existsSync(src)) fail('backup not found', src)
  rmSync(PUBLIC, { recursive: true, force: true })
  cpSync(src, PUBLIC, { recursive: true })
  log(`Restored ${src} → public/. Now run \`npm run deploy\` to roll the Worker back.`)
}

async function main() {
  if (flags.has('--restore')) return restore(args[args.indexOf('--restore') + 1])

  const target = TARGETS[targetName]
  if (!target) fail(`unknown target "${targetName}"`, `expected one of: ${Object.keys(TARGETS).join(', ')}`)
  const script = scriptNameFor(target.wranglerEnv)
  if (!script) fail(`could not read the ${targetName} Worker name from wrangler.toml`)
  // Contract options for THIS target: its script name, and its binding set
  // (staging has no TOTALS_BACKUP KV by design).
  const contract = {
    script,
    requireAuth: !noAuth,
    ...(target.requiredBindings ? { requiredBindings: target.requiredBindings } : {}),
  }
  // Every wrangler call below must name the environment, or `--env staging`
  // deploys would silently hit the top-level (production) config instead.
  const envArgs = target.wranglerEnv ? ['--env', target.wranglerEnv] : []

  log(`Deploying Prayer Earth + sync-engine to Cloudflare Workers → ${targetName} (${script})`)

  // 0. Preflight
  if (!noAuth) {
    const who = spawnSync(npxCmd(), ['wrangler', 'whoami'], {
      encoding: 'utf8',
      shell: process.platform === 'win32'
    })
    if (who.status !== 0 || !/logged in/i.test(who.stdout + who.stderr)) {
      fail('not logged into Cloudflare', 'Run `npx wrangler login` first, then retry.')
    }
    ok('Cloudflare login')
  }

  if (!existsSync(PE)) fail('prayer-earth not found', `expected at ${PE}`)
  if (!hasDist() && !flags.has('--skip-build')) {
    log('prayer-earth has no dist/ yet — building it (this is normal on first run).')
  }

  // 1. Tests (skip with --skip-tests)
  if (!skipTests) {
    log('Running sync-engine tests…')
    run(npmCmd, ['test'], { cwd: ROOT })
    ok('tests')
    log('Running prayer-earth server aggregation tests…')
    run(process.execPath, [path.join(PE, 'scripts', 'test-server.mjs')], { cwd: PE })
    ok('app server tests')
  }

  // 2. Build the app with the Cloudflare engine selected
  if (!flags.has('--skip-build')) {
    log('Building prayer-earth with VITE_SYNC_ENGINE=cf…')
    run(npmCmd, ['run', 'build'], {
      cwd: PE,
      env: { ...process.env, VITE_SYNC_ENGINE: 'cf' }
    })
    ok('app build')
  }
  if (!hasDist()) fail('app build produced no dist/index.html')

  // 2b. Audit the built assets (no inline executable scripts, SW CORE intact,
  //     entry CSS inlined) BEFORE staging — a violation must never ship.
  log('Auditing built assets…')
  run(process.execPath, [path.join(PE, 'scripts', 'audit-build.mjs')], { cwd: PE })
  ok('asset audit')

  // 3. Back up the current public/ and stage the app build into it
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const backup = path.join(BACKUP_ROOT, stamp)
  mkdirSync(BACKUP_ROOT, { recursive: true })
  if (existsSync(PUBLIC) && readdirSync(PUBLIC).length) {
    cpSync(PUBLIC, backup, { recursive: true })
    log(`Backed up previous public/ → ${path.relative(ROOT, backup)}`)
  }
  rmSync(PUBLIC, { recursive: true, force: true })
  mkdirSync(PUBLIC, { recursive: true })
  for (const entry of readdirSync(path.join(PE, 'dist'))) {
    cpSync(path.join(PE, 'dist', entry), path.join(PUBLIC, entry), { recursive: true })
  }
  // Carry the static-assets headers config through to the staged build.
  const headersSrc = path.join(ROOT, '_headers')
  if (existsSync(headersSrc)) copyFileSync(headersSrc, path.join(PUBLIC, '_headers'))
  // Keep the tracked marker so a fresh clone has the assets dir for `wrangler dev`.
  writeFileSync(path.join(PUBLIC, '.gitkeep'), '')
  ok(`staged app build into public/ (${readdirSync(PUBLIC).length} entries)`)

  // 4. Warn if the origin allow-list isn't pinned (production only — staging
  //    deliberately has none, because same-origin covers page + socket there)
  const wconfig = readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8')
  if (target.wranglerEnv) {
    log('Staging: ALLOWED_ORIGINS intentionally unset (same-origin default covers it).')
  } else if (!/^\s*ALLOWED_ORIGINS\s*=/m.test(wconfig)) {
    log('NOTE: ALLOWED_ORIGINS is unset — the same-origin default applies.')
    log('      For a hardened multi-domain setup, set ALLOWED_ORIGINS in wrangler.toml.')
  }

  // Remember which version was serving BEFORE we replace it. The verification
  // below can tell us the deploy is wrong, but on its own that only means we
  // print an error and leave production broken - which is precisely what has been
  // happening: a deploy ships a config-stripped assets upload, verification
  // catches it correctly, public/ is restored, and the Worker stays down until
  // somebody notices the uptime email. This is the version to put back.
  //
  // Only recorded when the live version is ALREADY good. Rolling back to a
  // version that was itself stripped is not a rollback, it is a second outage.
  let previousVersionId = null
  try {
    const before = await checkLiveVersionContract(contract)
    if (before.ok && before.versionId) {
      previousVersionId = before.versionId
      ok(`previous live version ${previousVersionId} recorded for rollback`)
    } else {
      log('NOTE: the live version does not currently carry the Worker contract,')
      log('      so there is no known-good version to roll back to. Deploying anyway;')
      log('      if this deploy fails verification there will be nothing to undo.')
    }
  } catch (err) {
    log(`NOTE: could not read the current live version (${err && err.message}).`)
    log('      Rollback-on-failure will be unavailable; deploying anyway.')
  }

  // 5. Deploy (or dry-run / stage-only)
  if (stageOnly) {
    log('Stage-only — no deploy. Rollback backup: ' + path.relative(ROOT, backup))
    log('Next: `npm run deploy` (or `npm run deploy:app -- --skip-tests --skip-build`).')
    return
  }
  if (dryRun) {
    log('Dry run — not deploying.')
    run(npxCmd(), ['wrangler', 'deploy', '--dry-run', ...envArgs], { cwd: ROOT })
    log('Done (dry). Rollback backup: ' + path.relative(ROOT, backup))
    return
  }
  log(`Deploying Worker (${targetName})…`)
  try {
    run(npxCmd(), ['wrangler', 'deploy', ...envArgs], { cwd: ROOT, env: process.env })
  } catch (err) {
    // A deploy that dies partway can still have replaced the live version, so this
    // is not just a "the upload never landed" case. Roll back first, then restore
    // the repo, and verify the rollback rather than trusting that it worked.
    log('Deploy failed.')
    if (previousVersionId) {
      log(`Rolling the Worker back to ${previousVersionId}…`)
      try {
        run(npxCmd(), ['wrangler', 'rollback', previousVersionId, ...envArgs], { cwd: ROOT, env: process.env })
        const after = await checkLiveVersionContract(contract)
        ok(after.ok
          ? `live version ${after.versionId} carries the full Worker contract again`
          : `rollback left version ${after.versionId} still violating the contract`)
      } catch (rollbackErr) {
        log(`! rollback failed: ${rollbackErr && rollbackErr.message}`)
        log('  production may be DOWN - page a human')
      }
    }
    log('Restoring the previous public/ build.')
    try {
      rmSync(PUBLIC, { recursive: true, force: true })
      cpSync(backup, PUBLIC, { recursive: true })
    } catch {}
    fail('deploy failed', (err && err.message) + ` — restored ${path.relative(ROOT, backup)}`)
  }
  ok('deploy')

  // 6. Purge the edge cache for the Worker-first paths BEFORE verifying. The
  //    verification below hits them "fresh" (bypasses the edge), but a cached
  //    SPA HTML shell from when static assets were answering /health + /stats
  //    keeps being served to the real uptime probe (cache=HIT) no matter how
  //    correct run_worker_first is — that is exactly the "assets fallback?"
  //    uptime regression. run_worker_first fixes routing; only a purge makes
  //    the edge actually give up the stale shell. Requires the separate
  //    Zone>Cache>Purge token (CF_API_TOKEN); skipped with a warning if unset.
  // Staging is exempt: its Cache Rules are host-pinned to joining-palms.app,
  // so the staging shell is never edge-cached and a purge is a no-op there.
  if (!target.purge) {
    log('Skipping edge-cache purge (staging is not edge-cached).')
  } else if (process.env.CF_API_TOKEN) {
    log('Purging edge cache for /, /health, /stats…')
    try {
      run(process.execPath, [path.join(ROOT, 'scripts', 'purge-cache.mjs'), '--paths=/ /health /stats'], { cwd: ROOT, env: process.env })
      ok('edge cache purge (/health + /stats + /)')
    } catch (err) {
      // Best-effort: a 401 here usually means the deploy token is account-scoped
      // and lacks Zone>Cache>Purge. That is a cache optimization, NOT a deploy
      // correctness problem — the live verification below (version contract +
      // /health + /stats) is the real gate and will catch a genuinely broken
      // deploy. Do not fail the whole deploy just because the edge still has
      // a cached shell; the next purge (or cache TTL) will clear it.
      log('! edge cache purge failed (non-fatal) — continuing to live verification.')
      log(`  ${err && err.message}`)
    }
  } else {
    log('CF_API_TOKEN not set — skipping edge-cache purge. If /health regresses to')
    log('SPA HTML (cache=HIT), run `npm run cache:purge` before re-deploying.')
  }

  // 7. Verify — the site must answer as the WORKER, not the static assets
  //    fallback. The failure mode we protect against: after a bad deploy the
  //    Worker stops getting requests and /health + /stats return the SPA HTML
  //    instead of JSON (and WebSocket upgrades hand back HTML, never 101). We
  //    assert all three and restore the previous build if anything is off.
  //    Real logic lives in scripts/verify-live.mjs (shared with `npm run verify`).
  //    We ALSO assert the deployed version's resources carry the full Worker
  //    contract (fetch handler, bindings, pinned compat date, worker-first
  //    routing) via scripts/verify-version.mjs — catching a config-stripped
  //    static-assets upload before its /health symptoms even start. A version
  //    that passes /health for days is still wrong if it is a Pages-style SPA.
  log(`Verifying live site (${targetName})…`)
  const base = (args.find((a) => a.startsWith('--url=')) || `--url=${target.base}`).slice('--url='.length)
  let verifyFail = null
  try {
    const version = await checkLiveVersionContract(contract)
    if (!version.ok) {
      for (const reason of version.reasons) console.error(`[deploy]   ✗ version contract — ${reason}`)
      throw new Error(`live version ${version.versionId} violates the Worker contract`)
    }
    ok(`live version ${version.versionId} carries the full Worker contract`)
    const { ok: liveOk, failed } = await verifyLive(base)
    if (!liveOk) {
      for (const f of failed) console.error(`[deploy]   ✗ ${f.name} — ${f.detail}`)
      throw new Error(failed.map((f) => f.name).join(', '))
    }
    ok('Worker JSON on /health + /stats')
    ok('WebSocket smoke')
  } catch (err) {
    verifyFail = (err && err.message) || 'verify failed'
  }
  if (verifyFail) {
    log(`VERIFICATION FAILED — ${verifyFail}`)
    // Put the old Worker back BEFORE touching public/. Restoring the repo first
    // and then failing leaves the live Worker broken and the repo healthy, which
    // is the state that is hardest to reason about and easiest to leave in place
    // for days. Heal the live system first, then the repo.
    if (previousVersionId) {
      log(`Rolling the Worker back to ${previousVersionId}…`)
      try {
        run(npxCmd(), ['wrangler', 'rollback', previousVersionId, ...envArgs], { cwd: ROOT, env: process.env })
        ok(`rolled back to ${previousVersionId}`)
        // Confirm the rollback actually restored service rather than assuming it.
        // A rollback that silently fails is worse than no rollback, because it
        // converts a visible outage into an invisible one.
        const after = await checkLiveVersionContract(contract)
        if (after.ok) {
          ok(`live version ${after.versionId} carries the full Worker contract again`)
        } else {
          for (const reason of after.reasons || []) log(`  ✗ still: ${reason}`)
          fail('rollback did not restore a healthy Worker', 'production is still down - page a human')
        }
      } catch (err) {
        fail('rollback failed', `${err && err.message} — production is still down, page a human`)
      }
    } else {
      log('No known-good version was recorded, so there is nothing to roll back to.')
      log('Production is DOWN. Redeploy a good Worker by hand:')
      log('  node scripts/deploy-app.mjs --skip-tests')
    }
    log('Restoring the previous public/ build (the live Worker now diverges from repo).')
    try {
      rmSync(PUBLIC, { recursive: true, force: true })
      cpSync(backup, PUBLIC, { recursive: true })
    } catch {}
    fail('post-deploy verification failed', verifyFail + ` — restored ${path.relative(ROOT, backup)}`)
  }
  log('Deployed+verified. Rollback backup: node scripts/deploy-app.mjs --restore ' + stamp)
}

function npxCmd() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx'
}

main().catch((e) => {
  console.error(`[deploy] ✗ ${e && e.message}`)
  process.exit(1)
})
