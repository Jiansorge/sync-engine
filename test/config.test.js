// Config-guard test: the Worker must keep serving the critical paths even
// though static assets would happily "answer" them. If run_worker_first ever
// drops "/health", "/stats" or "/" (or the assets binding is removed), a deploy
// silently breaks the API + WebSocket upgrade (the SPA HTML fallback serves
// instead of the Worker, and WS upgrades return HTTP instead of 101). This test
// makes that a build break, not an incident.

import { describe, it, expect } from 'vitest'
import toml from '../wrangler.toml?raw'

function section(name) {
  // Cheap section extractor for the small, hand-tuned TOML.
  const re = new RegExp(`^\\[${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*?(?=^\\[|\\Z)`, 'm')
  const m = toml.match(re)
  return m ? m[0] : ''
}

describe('assets routing (run_worker_first)', () => {
  it('mounts the static assets directory', () => {
    const assets = section('assets')
    expect(assets).toContain('directory = "./public"')
    expect(assets).toContain('binding = "ASSETS"')
  })

  it('routes "/", "/health" and "/stats" to the Worker first', () => {
    const assets = section('assets')
    expect(assets).toMatch(/run_worker_first\s*=\s*\[[^\]]*"\/"/)
    expect(assets).toMatch(/run_worker_first\s*=\s*\[[^\]]*"\/health"/)
    expect(assets).toMatch(/run_worker_first\s*=\s*\[[^\]]*"\/stats"/)
  })

  it('does not let the assets runtime claim the WebSocket path', () => {
    const assets = section('assets')
    // The whole origin upgrades to WS at "/", so "/" must stay worker-first.
    // run_worker_first on "/" also makes the app shell HTTP cacheable via a
    // Cache Rule, but never at the expense of the Worker owning "/".
    expect(assets).toMatch(/run_worker_first\s*=\s*\[[^\]]*"\/"/)
  })

  it('declares both Durable Objects used by the Worker', () => {
    const doSection = section('durable_objects')
    expect(doSection).toContain('"SYNC_ROOM"')
    expect(doSection).toContain('"COORDINATOR"')
  })
})