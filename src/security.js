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
  // Normalize to a comparable origin, but NEVER allow-list an opaque origin.
  // Opaque origins (capacitor://, file://, sandboxed iframes, data:, about:)
  // all serialize to the literal string "null" via `new URL(...).origin`, so
  // without this guard a single opaque entry (e.g. capacitor://localhost)
  // collapses to "null" and would match EVERY opaque origin — a cross-site
  // WebSocket hijack. Native clients send no Origin at all and are admitted by
  // the no-Origin path in shouldAllowUpgrade, so they never need an entry here.
  const norm = (u) => {
    try {
      const p = new URL(u)
      if (!p.protocol || p.origin === 'null') return null
      return p.origin
    } catch {
      return null
    }
  }
  const g = norm(given)
  if (!g) return false
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

// Deliberately NO special case for the app shell's own origin.
//
// The first attempt here compared "capacitor://localhost" literally, on the
// reasoning that Capacitor's WebView reports that origin. It does not: a
// non-special scheme is an OPAQUE origin, so every browser that serves the app
// from it serialises the header as the literal string "null". Verified on a
// Pixel - the device sent "null", and the upgrade was refused.
//
// Admitting "null" is not an option: every opaque origin on the internet sends
// it - sandboxed iframes, file:// documents, data: URLs - so allowing it would
// hand any site a cross-site WebSocket hijack against our own app.
//
// The fix belongs in the app, not here: Capacitor's androidScheme is set to
// "https", so the WebView is served from https://localhost, a REAL origin that
// normalises correctly and can be allow-listed exactly. That is the entry in
// ALLOWED_ORIGINS, and it is why there is nothing special to do in this file.

// CORS for the app shell.
//
// The Android WebView is served from https://localhost (androidScheme is
// "https" for exactly this reason), which is a real origin and therefore
// allow-listable. Every request it makes to this Worker is still cross-origin,
// so without these headers the browser blocks the response before the app sees
// it - and a blocked fetch is indistinguishable from being offline, so
// deletion silently reported "could not reach the server" and deleted nothing.
//
// Echoing the caller's Origin back is safe because /delete is authenticated by
// the deleteToken, not by the origin: a site that could make a victim's browser
// issue the request still cannot supply the token.
export function corsHeaders(originHeader, env) {
  const list = String((env && env.ALLOWED_ORIGINS) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // Only origins we recognise get the header echoed. Anything else gets none
  // at all, which is the browser's default deny. Never match "null": that
  // string is sent by every opaque origin, not just ours.
  const ok =
    !!originHeader &&
    originHeader !== 'null' &&
    list.some((u) => {
      try {
        return new URL(u).origin === new URL(originHeader).origin
      } catch {
        return false
      }
    })
  if (!ok) return {}
  return {
    'access-control-allow-origin': originHeader,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin'
  }
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
