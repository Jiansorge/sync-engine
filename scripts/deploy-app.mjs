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
  // Windows can't spawn .cmd directly without a shell (EINVAL).
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')}`, 'exited non-zero')
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

  log('Deploying Prayer Earth + sync-engine to Cloudflare Workers')

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

  // 4. Warn if the origin allow-list isn't pinned (production)
  const wconfig = readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8')
  if (!/^\s*ALLOWED_ORIGINS\s*=/m.test(wconfig)) {
    log('NOTE: ALLOWED_ORIGINS is unset — the same-origin default applies.')
    log('      For a hardened multi-domain setup, set ALLOWED_ORIGINS in wrangler.toml.')
  }

  // 5. Deploy (or dry-run / stage-only)
  if (stageOnly) {
    log('Stage-only — no deploy. Rollback backup: ' + path.relative(ROOT, backup))
    log('Next: `npm run deploy` (or `npm run deploy:app -- --skip-tests --skip-build`).')
    return
  }
  if (dryRun) {
    log('Dry run — not deploying.')
    run(npxCmd(), ['wrangler', 'deploy', '--dry-run'], { cwd: ROOT })
    log('Done (dry). Rollback backup: ' + path.relative(ROOT, backup))
    return
  }
  log('Deploying Worker…')
  try {
    run(npmCmd, ['run', 'deploy'], { cwd: ROOT })
  } catch (err) {
    // A failed deploy must not leave public/ staged with a build the live
    // Worker doesn't have — restore the backup so the repo matches production.
    log('Deploy failed — restoring the previous public/ build.')
    try {
      rmSync(PUBLIC, { recursive: true, force: true })
      cpSync(backup, PUBLIC, { recursive: true })
    } catch {}
    fail('deploy failed', (err && err.message) + ` — restored ${path.relative(ROOT, backup)}`)
  }
  ok('deploy')

  // 6. Verify — the site must answer as the WORKER, not the static assets
  //    fallback. The failure mode we protect against: after a bad deploy the
  //    Worker stops getting requests and /health + /stats return the SPA HTML
  //    instead of JSON (and WebSocket upgrades hand back HTML, never 101). We
  //    assert all three and restore the previous build if anything is off.
  log('Verifying live site…')
  const base = (args.find((a) => a.startsWith('--url=')) || '--url=https://joining-palms.app').slice('--url='.length)
  let verifyFail = null
  try {
    const checkJson = async (path) => {
      const r = await fetch(base + path)
      const ct = (r.headers.get('content-type') || '').toLowerCase()
      const body = await r.text()
      if (!ct.includes('application/json') && !body.trim().startsWith('{')) {
        return `expected Worker JSON on ${base}${path}, got ${ct || 'no content-type'} (assets fallback?)`
      }
      if (path === '/health' && !body.includes('"ok":true')) {
        return `health ok flag missing on ${base}${path}`
      }
      return null
    }
    const health = await checkJson('/health')
    const stats = await checkJson('/stats')
    verifyFail = health || stats || null
    if (verifyFail) throw new Error(verifyFail)
    ok('Worker JSON on /health + /stats')
  } catch (err) {
    verifyFail = (err && err.message) || 'verify failed'
  }
  if (!verifyFail) {
    const smoke = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'smoke', '--', base.replace(/^https/, 'wss')],
      { stdio: 'inherit', shell: process.platform === 'win32', cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '--experimental-websocket' } }
    )
    verifyFail = smoke.status === 0 ? null : `ws smoke failed (exit ${smoke.status})`
    if (!verifyFail) ok('WebSocket smoke')
  }
  if (verifyFail) {
    log(`VERIFICATION FAILED — ${verifyFail}`)
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
