// sync-engine — one-time setup for the disaster-recovery KV backup.
//
//   npm run kv:setup
//
// Creates the TOTALS_BACKUP KV namespace (once) and writes the real binding
// into wrangler.toml, replacing the commented template. Idempotent: if the
// binding already exists it just prints the id.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = path.join(ROOT, 'wrangler.toml')
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const cfg = readFileSync(CONFIG, 'utf8')

// Already configured?
const existing = cfg.match(/binding\s*=\s*"TOTALS_BACKUP"[\s\S]*?id\s*=\s*"([a-f0-9]+)"/)
if (existing) {
  console.log(`TOTALS_BACKUP is already configured (id=${existing[1]}). Nothing to do.`)
  process.exit(0)
}

console.log('Creating the TOTALS_BACKUP KV namespace…')
const r = spawnSync(npxCmd, ['wrangler', 'kv', 'namespace', 'create', 'TOTALS_BACKUP'], {
  encoding: 'utf8',
  shell: process.platform === 'win32'
})
if (r.status !== 0) {
  console.error('wrangler kv namespace create failed. Are you logged in? (npx wrangler login)')
  console.error(r.stderr || r.stdout)
  process.exit(1)
}

const out = r.stdout + r.stderr
const m = out.match(/id\s*=\s*"([a-f0-9]+)"/)
if (!m) {
  console.error('Could not find the namespace id in wrangler output:')
  console.error(out)
  process.exit(1)
}
const id = m[1]

// Replace the commented template block with the real binding.
const TEMPLATE =
  '# Optional disaster-recovery backup for the lifetime totals. Create a namespace\n' +
  '# once per tenant and uncomment (the DO no-ops without the binding):\n' +
  '#   npx wrangler kv namespace create TOTALS_BACKUP\n' +
  '# [[kv_namespaces]]\n' +
  '# binding = "TOTALS_BACKUP"\n' +
  '# id = "<the printed id>"'

const BLOCK =
  '[[kv_namespaces]]\n' +
  'binding = "TOTALS_BACKUP"\n' +
  `id = "${id}"`

if (cfg.includes(TEMPLATE)) {
  writeFileSync(CONFIG, cfg.replace(TEMPLATE, BLOCK))
  console.log(`Wrote the TOTALS_BACKUP binding into wrangler.toml (id=${id}).`)
} else {
  // Template not found — append the block before [vars] if possible.
  const marker = '[vars]'
  if (cfg.includes(marker)) {
    writeFileSync(CONFIG, cfg.replace(marker, `${BLOCK}\n\n${marker}`))
    console.log(`Inserted the TOTALS_BACKUP binding into wrangler.toml (id=${id}).`)
  } else {
    writeFileSync(CONFIG, cfg + `\n${BLOCK}\n`)
    console.log(`Appended the TOTALS_BACKUP binding to wrangler.toml (id=${id}).`)
  }
}

console.log('Next: `npm run deploy` (or `npm run deploy:app`) to ship it.')
