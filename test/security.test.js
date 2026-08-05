import { describe, it, expect } from 'vitest'
import {
  allowOrigin,
  isSameOrigin,
  shouldAllowUpgrade,
  createRateBudget,
  createUpgradeThrottle,
  throttleKey,
  safeEqual
} from '../src/security.js'

describe('allowOrigin', () => {
  const list = 'https://prayer.earth,https://www.prayer.earth'

  it('allows listed origins', () => {
    expect(allowOrigin('https://prayer.earth', list)).toBe(true)
    expect(allowOrigin('https://www.prayer.earth/', list)).toBe(true)
  })

  it('rejects unlisted origins', () => {
    expect(allowOrigin('https://evil.example', list)).toBe(false)
    expect(allowOrigin('', list)).toBe(false)
    expect(allowOrigin(null, list)).toBe(false)
  })

  it('allows everything when unset (local dev)', () => {
    expect(allowOrigin('https://anything.dev', '')).toBe(true)
    expect(allowOrigin(null, undefined)).toBe(true)
  })
})

describe('isSameOrigin (default when ALLOWED_ORIGINS is unset)', () => {
  it('allows matching origins and absent Origin (native clients)', () => {
    expect(isSameOrigin('http://localhost:8787/', 'http://localhost:8787')).toBe(true)
    expect(isSameOrigin('http://sync-engine.local/', null)).toBe(true)
  })

  it('rejects cross-site origins by default', () => {
    expect(isSameOrigin('http://sync-engine.local/', 'http://localhost:8787')).toBe(false)
    expect(isSameOrigin('http://sync-engine.local/', 'https://evil.example')).toBe(false)
    expect(isSameOrigin('http://sync-engine.local/', 'not-a-url')).toBe(false)
  })
})

describe('shouldAllowUpgrade', () => {
  const list = 'https://joining-palms.app'

  it('admits clients with no Origin header even when an allow-list is set', () => {
    // Native/script clients send no Origin — the check is browser-only.
    expect(shouldAllowUpgrade(null, list, 'https://joining-palms.app/')).toBe(true)
    expect(shouldAllowUpgrade(undefined, list, 'https://x.workers.dev/')).toBe(true)
  })

  it('enforces the allow-list when an Origin is present', () => {
    expect(shouldAllowUpgrade('https://joining-palms.app', list, 'https://x.workers.dev/')).toBe(true)
    expect(shouldAllowUpgrade('https://evil.example', list, 'https://x.workers.dev/')).toBe(false)
  })

  it('falls back to same-origin when no list is configured', () => {
    expect(shouldAllowUpgrade('https://x.workers.dev', '', 'https://x.workers.dev/')).toBe(true)
    expect(shouldAllowUpgrade('https://evil.example', '', 'https://x.workers.dev/')).toBe(false)
  })
})

describe('createRateBudget', () => {
  it('allows max per window then blocks until the window rolls', () => {
    const b = createRateBudget({ max: 3, windowMs: 1000 })
    expect(b.allow(0)).toBe(true)
    expect(b.allow(100)).toBe(true)
    expect(b.allow(200)).toBe(true)
    expect(b.allow(300)).toBe(false)
    expect(b.allow(999)).toBe(false)
    expect(b.allow(1000)).toBe(true) // window rolled
  })
})

describe('createUpgradeThrottle', () => {
  it('limits each key independently within the window', () => {
    const t = createUpgradeThrottle({ max: 2, windowMs: 60000 })
    expect(t.check('a', 0)).toBe(false)
    expect(t.check('a', 10)).toBe(false)
    expect(t.check('a', 20)).toBe(true) // over budget
    expect(t.check('b', 30)).toBe(false) // other key unaffected
    expect(t.check('a', 60001)).toBe(false) // window rolled
  })
})

describe('throttleKey', () => {
  it('hashes the peer address (never returns the raw value)', async () => {
    const req = new Request('https://example.com', {
      headers: { 'cf-connecting-ip': '203.0.113.9' }
    })
    const key = await throttleKey(req)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain('203.0.113.9')
  })
})

describe('safeEqual', () => {
  it('matches only exact strings (constant-time compare)', () => {
    expect(safeEqual('secret', 'secret')).toBe(true)
    expect(safeEqual('secret', 'secreX')).toBe(false)
    expect(safeEqual('secret', 'secre')).toBe(false) // length mismatch
    expect(safeEqual('secret', '')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual(undefined, 'secret')).toBe(false)
    expect(safeEqual('secret', null)).toBe(false)
  })

  it('handles a non-ASCII secret without throwing', () => {
    expect(safeEqual('😀a', '😀a')).toBe(true)
    expect(safeEqual('😀a', '😀b')).toBe(false)
  })
})
