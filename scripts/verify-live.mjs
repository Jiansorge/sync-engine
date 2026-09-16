// sync-engine — single source of truth for "is the live site actually the
// Worker?" post-deploy/uptime verification. Used by scripts/verify.mjs (manual
// CLI) and scripts/deploy-app.mjs (automatic post-deploy gate). Kept as one
// module so the two callers can never drift: the exact failure mode we ship
// against — /health and /stats answering with SPA HTML instead of Worker JSON,
// and WebSocket upgrades handing back HTTP instead of 101 — is checked in one
// place, using the protocol version from the source of truth, not a literal.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '../src/protocol.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

async function probe(base, relPath) {
  const r = await fetch(base + relPath)
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  const body = await r.text()
  let json = null
  try {
    json = JSON.parse(body)
  } catch {}
  return { r, ct, body, json }
}

// A Workers-Static-Assets "answer" has a text/html content-type and a body that
// is the app shell — never JSON-like. Anything without a JSON content-type (or
// at least a leading '{') means assets stole the route.
function looksWorkerJson(ct, body) {
  return ct.includes('application/json') || body.trim().startsWith('{')
}

// /health must be Worker JSON claiming ok, at the current wire version.
export async function checkHealth(base) {
  const { ct, body, json } = await probe(base, '/health')
  if (!looksWorkerJson(ct, body)) {
    return { ok: false, reason: `assets fallback? got ${ct || 'no content-type'}` }
  }
  if (!json || json.ok !== true) {
    return { ok: false, reason: `health ok flag missing/wrong (${body.slice(0, 120)})` }
  }
  if (json.protocol !== PROTOCOL_VERSION) {
    return { ok: false, reason: `protocol mismatch: server=${json.protocol} want=${PROTOCOL_VERSION}` }
  }
  return { ok: true, detail: body.slice(0, 160) }
}

// /stats must be Worker JSON with the counters we aggregate.
export async function checkStats(base) {
  const { ct, body, json } = await probe(base, '/stats')
  if (!looksWorkerJson(ct, body)) {
    return { ok: false, reason: `assets fallback? got ${ct || 'no content-type'}` }
  }
  const s = json || {}
  if (typeof s.seconds !== 'number' || !s.counts || typeof s.counts.connects !== 'number') {
    return { ok: false, reason: `stats shape unexpected (${body.slice(0, 120)})` }
  }
  return { ok: true, detail: body.slice(0, 160) }
}

// WebSocket upgrade must actually 101 (never the SPA HTML fallback). Runs the
// standalone smoke client against the ws(s):// form of the base URL.
export function smokeCheck(url) {
  const wsUrl = url.replace(/^https/, 'wss').replace(/^http/, 'ws')
  const r = spawnSync(npmCmd, ['run', 'smoke', '--', wsUrl], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_OPTIONS: '--experimental-websocket' }
  })
  return { ok: r.status === 0, status: r.status }
}

// Run /health + /stats, then the WS smoke unless skipWs. Returns { ok, failed, passed }.
export async function verifyLive(base, { skipWs = false } = {}) {
  const results = []
  const run = async (name, fn) => {
    try {
      const res = await fn()
      results.push({ name, ok: res.ok, detail: res.reason || res.detail })
      return res.ok
    } catch (e) {
      results.push({ name, ok: false, detail: e && e.message })
      return false
    }
  }
  const h = await run('GET /health', () => checkHealth(base))
  const s = await run('GET /stats', () => checkStats(base))
  let w = true
  if (!skipWs) {
    w = await run('WebSocket smoke', () => new Promise((res) => res(smokeCheck(base))))
  }
  const failed = results.filter((r) => !r.ok)
  return { ok: failed.length === 0 && h && s && w, failed, passed: results.filter((r) => r.ok) }
}