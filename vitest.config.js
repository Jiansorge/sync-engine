import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
          kvNamespaces: ['TOTALS_BACKUP'],
          bindings: {
            // Deterministic test environment. 32 shards + per-test unique shard
            // selection (see worker.test.js) so no two tests ever share a DO.
            // ALLOWED_ORIGINS is overridden to empty so tests use the same-origin
            // default regardless of the production value in wrangler.toml.
            NUM_SHARDS: 32,
            MAX_MSG_PER_SEC: 5,
            PRESENCE_TTL_MS: 2000,
            SWEEP_ALARM_MS: 5000,
            ALLOWED_ORIGINS: '',
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