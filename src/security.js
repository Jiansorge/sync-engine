// sync-engine — security helpers (pure + deterministic so they unit-test well).
// Privacy rule: raw IPs are never logged or stored. The upgrade throttle keys
// on a SHA-256 hash of the peer address, never the address itself.

// Origin allow-list for WS upgrades. An empty/unset list means "allow all"
// (convenient for local dev; set ALLOWED_ORIGINS in production).
export function allowOrigin(originHeader, allowedCsv) {
  const list = (allowedCsv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (list.length === 0) return true
  const given = (originHeader || '').trim()
  if (!given) return false
  const norm = (u) => {
    try {
      return new URL(u).origin
    } catch {
      return u.replace(/\/+$/, '')
    }
  }
  const g = norm(given)
  return list.some((u) => norm(u) === g)
}

// Default when no ALLOWED_ORIGINS is configured: same-origin only (browser
// clients), plus non-browser clients that send no Origin header at all. This
// closes cross-site WebSocket hijacking out of the box while keeping local dev
// (and native clients) working. An explicit allow-list overrides it.
export function isSameOrigin(requestUrl, originHeader) {
  if (!originHeader) return true
  try {
    return new URL(originHeader).origin === new URL(requestUrl).origin
  } catch {
    return false
  }
}

// Decides whether a WS upgrade is admitted. The Origin header is a browser-only
// control: browsers always send it, native clients don't. So:
//   - no Origin  → allow (native/script clients — nothing to validate)
//   - allow-list → the header must match it
//   - otherwise  → same-origin only
export function shouldAllowUpgrade(originHeader, allowedCsv, requestUrl) {
  if (!originHeader) return true
  if (allowedCsv) return allowOrigin(originHeader, allowedCsv)
  return isSameOrigin(requestUrl, originHeader)
}

// Per-connection message budget: `max` messages per rolling `windowMs`.
export function createRateBudget({ max, windowMs = 1000 } = {}) {
  const state = { count: 0, start: 0 }
  return {
    allow(now = Date.now()) {
      if (now - state.start >= windowMs) {
        state.count = 1
        state.start = now
        return true
      }
      state.count += 1
      return state.count <= max
    },
    reset() {
      state.count = 0
      state.start = 0
    }
  }
}

// Optional throttle on new upgrades, keyed by a hashed peer address.
// `check` returns true when the key is over its window budget.
export function createUpgradeThrottle({ max, windowMs = 60000 } = {}) {
  const hits = new Map() // key -> number[] of timestamps
  return {
    check(key, now = Date.now()) {
      let arr = hits.get(key) || []
      arr = arr.filter((t) => now - t < windowMs)
      if (arr.length >= max) {
        hits.set(key, arr)
        return true
      }
      arr.push(now)
      hits.set(key, arr)
      return false
    }
  }
}

// A stable, non-reversible key for the peer address. Prefers Cloudflare's
// real client IP header, falls back for local dev. Nothing here is logged.
export async function throttleKey(request) {
  const raw =
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return 'unknown'
  }
}

// Constant-time string comparison so a secret check (`x-sync-admin` vs the
// ADMIN_KEY) never leaks the key length or position through timing.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
