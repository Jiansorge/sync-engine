// sync-engine — one-time upload of the prayer recordings to R2.
//
//   npm run audio:r2:upload          # upload prayer-earth/public/audio → joining-palms-audio bucket
//   npm run audio:r2:upload -- 4     # concurrency (default 8)
//
// Requires R2 to be enabled on the account (dashboard → R2 → Enable) and the
// bucket to exist. Once uploaded, the Worker serves /audio/* from R2 (it
// already falls back to the static bundle until objects exist). ~3.5k files
// takes ~10–15 min the first time; re-run after regenerating recordings.

import { spawn } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd() // sync-engine
const PE = join(ROOT, '..', 'prayer-earth')
const AUDIO = join(PE, 'public', 'audio')
const BUCKET = process.env.R2_BUCKET || 'joining-palms-audio'
const CONCURRENCY = Math.max(1, parseInt(process.argv[2], 10) || 8)

if (!existsSync(AUDIO)) {
  console.error(`No prayer-earth audio at ${AUDIO} — build/generate it first.`)
  process.exit(1)
}

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
console.log(`Uploading ${files.length} files to r2://${BUCKET} (concurrency ${CONCURRENCY})…`)

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
let done = 0
let failed = 0
const errors = []

function uploadOne(file, key) {
  return new Promise((resolve) => {
    const child = spawn(npx, ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file], {
      stdio: 'ignore',
      shell: process.platform === 'win32'
    })
    child.on('exit', (code) => {
      done++
      if (code !== 0) {
        failed++
        errors.push(key)
      }
      if (done % 100 === 0 || done === files.length) {
        console.log(`  ${done}/${files.length} (${failed} failed)`)
      }
      resolve()
    })
  })
}

;(async () => {
  let i = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < files.length) {
      const idx = i++
      await uploadOne(files[idx], keys[idx])
    }
  })
  await Promise.all(workers)

  console.log(`\nDone: ${done - failed}/${files.length} uploaded.`)
  if (failed) {
    console.error(`FAILED: ${failed} files`)
    for (const k of errors.slice(0, 20)) console.error('  ' + k)
    process.exit(1)
  }
  console.log('\nAudio is now served from R2 by the Worker (URLs unchanged).')
  console.log('Optional: remove public/audio from the bundle to shrink deploys (see docs).')
})()
