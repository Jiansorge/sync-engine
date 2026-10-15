// sync-engine — create the Cloudflare Cache Rules via the API (no dashboard).
//
//   CF_API_TOKEN=xxx npm run cache:rules
//
// Token (dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom):
//   - Zone | Cache Rules | Edit
//   - Zone | Zone | Read
//   Zone Resources: Include → Specific zone → joining-palms.app
//
// Creates three rules on the zone:
//   1. /         → edge 1 hour, browser 5 min   (app shell — drops repeat visits)
//   2. /assets/* → edge 1 month, browser 1 year  (hashed filenames — safe)
//   3. /audio/*  → edge 1 day, browser 1 day       (short so replacements propagate)
//   4. /health, /stats → BYPASS cache entirely      (see below)
//
// (4) is the one that matters and the one that was missing. /health is how the
// uptime check learns whether the Worker is serving, and for a long time the
// only thing protecting it was run_worker_first in wrangler.toml - correct while
// the Worker is serving, and useless the moment it is not: a cached SPA shell
// then answers /health for as long as the TTL lasts, so a dead Worker looks
// healthy and a healthy Worker can look dead depending on which PoP still holds
// a stale copy. A monitor that can be answered by a cache cannot be a monitor.
// Bypassing the cache removes the possibility rather than narrowing it.

const ZONE_NAME = process.env.CF_ZONE_NAME || 'joining-palms.app'
const TOKEN = process.env.CF_API_TOKEN

if (!TOKEN) {
  console.error('Set CF_API_TOKEN (see the header comment).')
  process.exit(1)
}

const api = async (path, opts = {}) => {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  })
  const j = await r.json()
  if (!r.ok || j.success === false) {
    console.error(`API ${r.status}:`, JSON.stringify(j.errors || j).slice(0, 300))
    process.exit(1)
  }
  return j
}

// Find the zone id from the name.
const zones = await api(`/zones?name=${encodeURIComponent(ZONE_NAME)}`)
const zone = zones.result && zones.result[0]
if (!zone) {
  console.error(`Zone "${ZONE_NAME}" not found on this token.`)
  process.exit(1)
}
console.log(`Zone: ${ZONE_NAME} (${zone.id})`)

const rules = [
  {
    action: 'set_cache_settings',
    expression: `(http.host eq "${ZONE_NAME}" and (http.request.uri.path eq "/" or http.request.uri.path eq "/index.html"))`,
    description: 'App shell — short edge cache to drop repeat visits',
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: 'override_origin',
        default: 3600, // 1 hour
        status_code_ttl: [{ status_code: 200, value: 3600 }]
      },
      browser_ttl: { mode: 'override_origin', default: 300 } // 5 min
    }
  },
  {
    action: 'set_cache_settings',
    expression: `(http.host eq "${ZONE_NAME}" and http.request.uri.path contains "/assets/")`,
    description: 'Hashed assets — immutable long cache',
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: 'override_origin',
        default: 2629743, // 1 month
        status_code_ttl: [{ status_code: 200, value: 2629743 }]
      },
      browser_ttl: { mode: 'override_origin', default: 31536000 } // 1 year
    }
  },
  {
    action: 'set_cache_settings',
    expression: `(http.host eq "${ZONE_NAME}" and http.request.uri.path contains "/audio/")`,
    description: 'Audio — short cache so replaced recordings propagate',
    action_parameters: {
      cache: true,
      edge_ttl: {
        mode: 'override_origin',
        default: 86400, // 1 day
        status_code_ttl: [{ status_code: 200, value: 86400 }]
      },
      browser_ttl: { mode: 'override_origin', default: 86400 }
    }
  },
  {
    action: 'set_cache_settings',
    expression: `(http.host eq "${ZONE_NAME}" and (http.request.uri.path eq "/health" or http.request.uri.path eq "/stats"))`,
    description: 'Health + stats — never cache (a cached answer is not a health check)',
    action_parameters: { cache: false }
  }
]

// Merge rather than replace. The ruleset entrypoint PUT below REPLACES the whole
// cache-settings ruleset, so a plain overwrite would delete any rule someone added
// in the dashboard - including the /health bypass this script exists to add, the
// next time it ran for an unrelated reason. Rules this script manages are
// identified by description and updated; everything else is carried over
// untouched.
const ENTRYPOINT = `/zones/${zone.id}/rulesets/phases/http_request_cache_settings/entrypoint`
const existing = (await api(ENTRYPOINT)).result?.rules || []
const MANAGED = new Set(rules.map((r) => r.description))
const MANAGED_EXPRESSIONS = new Set(rules.map((r) => r.expression))
// Two things have to be filtered out, and for different reasons:
//
//   a rule this script owns, identified by description — it is about to be
//   rewritten by the managed copy, so keeping it would duplicate it;
//
//   a rule with the same expression as one this script owns, even under a
//   different description. Someone may have built an equivalent rule by hand,
//   and a duplicate is worse than a deletion: with two rules on the same path
//   the later one wins, so the surviving configuration is whichever rule the
//   UI happens to sort last, not the one you intended to set.
//
// This pair existed because the filter above used to read
// `ours(r.description)` while `ours` itself did `r.description` - handing a
// string to something expecting a rule. `MANAGED.has(undefined)` is always
// false, so nothing was ever filtered and every existing rule was carried over
// on top of its own managed replacement.
const kept = existing.filter((r) => !MANAGED.has(r.description) && !MANAGED_EXPRESSIONS.has(r.expression))

const merged = [...rules.map((r) => ({ ...r })), ...kept]
const res = await api(ENTRYPOINT, {
  method: 'PUT',
  body: JSON.stringify({ rules: merged })
})

console.log(`Cache Rules applied (${rules.length} managed, ${kept.length} carried over):`)
for (const r of res.result.rules) {
  console.log(`  - ${r.description}  [${r.action}]`)
}
if (kept.length) {
  console.log('\nCarried over unchanged (not managed by this script):')
  for (const r of kept) console.log(`  - ${r.description || '(no description)'}`)
}
console.log('\nTip: purge the zone cache once (dashboard → Caching → Purge → Purge everything) so the new headers take effect immediately.')
