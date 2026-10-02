import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { readFileSync } from 'node:fs'

// The tests must exercise the allow-list that PRODUCTION runs with.
//
// This config used to pin ALLOWED_ORIGINS to the empty string, which selects the
// same-origin default and is a configuration production never uses. That gap is
// why "deletion does not work on Android at all" shipped with a fully green
// suite: every test sent either no Origin or the same-origin default, and none
// of them ever looked at the real value.
//
// So: read it from wrangler.toml, and add the test client's own origin on top,
// because the test host is not one of our real ones.
const toml = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8')
const prodOrigins = (toml.split('\n').find((l) => /^ALLOWED_ORIGINS\s*=/.test(l)) || '')
  .split('=')[1]
  .trim()
  .replace(/^"|"$/g, '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const TEST_ORIGINS = 'http://sync-engine.local'
const ALLOWED_ORIGINS = [...new Set([...prodOrigins, TEST_ORIGINS])].join(',')

if (!prodOrigins.includes('https://localhost')) {
  throw new Error(
    'wrangler.toml ALLOWED_ORIGINS is missing https://localhost (the Capacitor app ' +
      'shell). The app would be refused its own WebSocket and every fetch.'
  )
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
          kvNamespaces: ['TOTALS_BACKUP'],
          bindings: {
            // Deterministic test environment. 32 shards + per-test unique shard
            // selection (see worker.test.js) so no two tests ever share a DO.
            // ALLOWED_ORIGINS is the PRODUCTION value plus the test client's own
            // origin, so a change to what we allow must break a test.
            NUM_SHARDS: 32,
            MAX_MSG_PER_SEC: 5,
            PRESENCE_TTL_MS: 2000,
            SWEEP_ALARM_MS: 5000,
            ALLOWED_ORIGINS,
            // Prod throttle is per hashed IP; tests share one key, so disable it.
            MAX_UPGRADES_PER_IP: 0
          }
      }
    })
  ],
  // Allow the drift test to import the sibling prayer-earth copy (outside the
  // project root) as a `?raw` string.
  server: { fs: { allow: ['..'] } },
  test: {
    include: ['test/**/*.test.js']
  }
})