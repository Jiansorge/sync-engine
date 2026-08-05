// sync-engine — one-time upload of the prayer recordings to R2.
//
//   npm run audio:r2:upload          # upload prayer-earth/public/audio → joining-palms-audio bucket
//   npm run audio:r2:upload -- 4     # concurrency (default 8)
//   npm run audio:r2:upload -- --force  # re-upload everything (ignore the hash cache)
//
// Requires R2 to be enabled on the account (dashboard → R2 → Enable) and the
// bucket to exist. Once uploaded, the Worker serves /audio/* from R2 (it
// already falls back to the static bundle until objects exist).
//
// Idempotent: files whose content hash matches the last successful run are
// skipped, so re-running after regenerating a few recordings only uploads the
// changed/new files (no duplicate uploads). The hash cache lives in
// `.r2-synced.json` (gitignored).

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd() // sync-engine
const PE = join(ROOT, '..', 'prayer-earth')
const AUDIO = join(PE, 'public', 'audio')
const BUCKET = process.env.R2_BUCKET || 'joining-palms-audio'
const STATE_FILE = join(ROOT, '.r2-synced.json')
const FORCE = process.argv.includes('--force')
const CONCURRENCY = Math.max(1, parseInt(process.argv[2], 10) || 8)

if (!existsSync(AUDIO)) {
  console.error(`No prayer-earth audio at ${AUDIO} — build/generate it first.`)
  process.exit(1)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}
const state = loadState()

function walk(dir, base) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, base))
    else out.push(p)
  }
  return out
}

const files = walk(AUDIO, AUDIO)
const keys = files.map((f) => `audio/${relative(AUDIO, f).replace(/\\/g, '/')}`)

// Skip files whose content hash is unchanged since the last successful run.
const todo = []
let skipped = 0
for (let i = 0; i < files.length; i++) {
  const hash = sha256(files[i])
  if (!FORCE && state[keys[i]] === hash) {
    skipped++
    continue
  }
  todo.push({ file: files[i], key: keys[i], hash })
}

console.log(
  `${todo.length} to upload, ${skipped} unchanged (skipped)` +
    (FORCE ? ' — forced' : '') +
    ` → r2://${BUCKET} (concurrency ${CONCURRENCY})`
)
if (!todo.length) {
  console.log('Nothing to upload — all files are already in sync.')
  process.exit(0)
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
let done = 0
let failed = 0
const errors = []

function uploadOne(item) {
  return new Promise((resolve) => {
    const child = spawn(npx, ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${item.key}`, '--file', item.file], {
      stdio: 'ignore',
      shell: process.platform === 'win32'
    })
    child.on('exit', (code) => {
      done++
      if (code !== 0) {
        failed++
        errors.push(item.key)
      } else {
        state[item.key] = item.hash
      }
      if (done % 100 === 0 || done === todo.length) {
        console.log(`  ${done}/${todo.length} (${failed} failed)`)
      }
      resolve()
    })
  })
}

;(async () => {
  let i = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < todo.length) {
      const idx = i++
      await uploadOne(todo[idx])
    }
  })
  await Promise.all(workers)

  if (failed) {
    console.error(`FAILED: ${failed} files`)
    for (const k of errors.slice(0, 20)) console.error('  ' + k)
    process.exit(1)
  }
  // Persist the hash cache so unchanged files are skipped on the next run.
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (e) {
    console.warn('could not write .r2-synced.json:', e.message)
  }
  console.log(`\nDone: ${todo.length} uploaded, ${skipped} unchanged (skipped).`)
  console.log('\nAudio is now served from R2 by the Worker (URLs unchanged).')
  console.log('Optional: remove public/audio from the bundle to shrink deploys (see docs).')
})()
