// Contract-guard test: the live Worker version must carry the full Worker
// contract. The four config-stripped deploys (7f4214e9, df572735, f1004206,
// 571802ca) were Pages-style static uploads — no fetch handler, no bindings, an
// SPA not-found fallback, and compatibility_date defaulted to the deploy day.
// This test makes sure assertVersionContract flags exactly those violations,
// and accepts the healthy version (cc628a22) that replaced them.
//
// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { assertVersionContract } from '../scripts/verify-version.mjs'

// Healthy version cc628a22 — handlers fetch, full bindings, pinned compat
// date, worker-first assets. Shapes trimmed to the relevant resources.
const GOOD = {
  script: { handlers: ['fetch'] },
  bindings: [
    { type: 'plain_text', name: 'ALLOWED_ORIGINS' },
    { type: 'assets', name: 'ASSETS' },
    { type: 'durable_object_namespace', name: 'COORDINATOR' },
    { type: 'plain_text', name: 'HTTP_RATE_MAX' },
    { type: 'plain_text', name: 'HTTP_RATE_WINDOW_MS' },
    { type: 'plain_text', name: 'MAX_UPGRADES_PER_IP' },
    { type: 'plain_text', name: 'PROTOCOL_VERSION' },
    { type: 'durable_object_namespace', name: 'SYNC_ROOM' },
    { type: 'kv_namespace', name: 'TOTALS_BACKUP' },
    { type: 'plain_text', name: 'UPGRADE_WINDOW_MS' }
  ],
  script_runtime: {
    compatibility_date: '2025-01-01',
    assets: {
      raw_run_worker_first: ['/', '/health', '/stats']
    }
  }
}

// Config-stripped upload 571802ca / f1004206 — no handlers, no bindings,
// SPA fallback, compat date defaulted to the deploy day.
const BAD = {
  script: {},
  script_runtime: {
    compatibility_date: '2026-09-17',
    assets: {
      not_found_handling: 'single-page-application',
      serve_directly: true,
      raw_run_worker_first: false
    }
  }
}

const EXPECTED = {
  compatDate: '2025-01-01',
  requiredBindings: ['ASSETS', 'SYNC_ROOM', 'COORDINATOR', 'TOTALS_BACKUP']
}

describe('assertVersionContract', () => {
  it('accepts a healthy deploy', () => {
    expect(assertVersionContract(GOOD, EXPECTED)).toEqual([])
  })

  it('flags a config-stripped deploy', () => {
    const reasons = assertVersionContract(BAD, EXPECTED)
    expect(reasons.join('; ')).toContain("handlers missing 'fetch'")
    expect(reasons.join('; ')).toContain("binding 'ASSETS' missing")
    expect(reasons.join('; ')).toContain("binding 'SYNC_ROOM' missing")
    expect(reasons.join('; ')).toContain("compatibility_date=2026-09-17")
    expect(reasons.join('; ')).toContain('SPA (single-page-application)')
    expect(reasons.join('; ')).toContain('run_worker_first not set')
  })

  it('flags a missing fetch handler even when bindings are intact', () => {
    const resources = JSON.parse(JSON.stringify(GOOD))
    resources.script.handlers = []
    const reasons = assertVersionContract(resources, EXPECTED)
    expect(reasons.join('; ')).toContain("handlers missing 'fetch'")
  })

  it('flags a compat-date drift on an otherwise healthy deploy', () => {
    const resources = JSON.parse(JSON.stringify(GOOD))
    resources.script_runtime.compatibility_date = '2026-09-01'
    const reasons = assertVersionContract(resources, EXPECTED)
    expect(reasons.join('; ')).toContain('compatibility_date=2026-09-01')
  })

  it('flags a missing health route in run_worker_first', () => {
    const resources = JSON.parse(JSON.stringify(GOOD))
    resources.script_runtime.assets.raw_run_worker_first = ['/', '/stats']
    const reasons = assertVersionContract(resources, EXPECTED)
    expect(reasons.join('; ')).toContain("missing '/health'")
  })
})