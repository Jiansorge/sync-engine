// sync-engine — create the Cloudflare Cache Rules via the API (no dashboard).
//
//   CF_API_TOKEN=xxx npm run cache:rules
//
// Token (dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom):
//   - Zone | Cache Rules | Edit
//   - Zone | Zone | Read
//   Zone Resources: Include → Specific zone → joining-palms.app
//
// Creates two rules on the zone:
//   1. /assets/* → edge 1 month, browser 1 year  (hashed filenames — safe)
//   2. /audio/*  → edge 1 day, browser 1 day       (short so replacements propagate)

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
    expression: `(http.host eq "${ZONE_NAME}" and http.request.uri.path contains "/assets/")`,
    description: 'Hashed assets — immutable long cache',
    action_parameters: {
      cache: true,
      edge_ttl: { mode: 'override_origin', status_code_ttl: [{ status_code: 200, value: 2629743 }] },
      browser_ttl: { mode: 'override_origin', default: 31536000 }
    }
  },
  {
    action: 'set_cache_settings',
    expression: `(http.host eq "${ZONE_NAME}" and http.request.uri.path contains "/audio/")`,
    description: 'Audio — short cache so replaced recordings propagate',
    action_parameters: {
      cache: true,
      edge_ttl: { mode: 'override_origin', status_code_ttl: [{ status_code: 200, value: 86400 }] },
      browser_ttl: { mode: 'override_origin', default: 86400 }
    }
  }
]

const res = await api(`/zones/${zone.id}/rulesets/phases/http_request_cache_settings/entrypoint`, {
  method: 'PUT',
  body: JSON.stringify({ rules })
})

console.log('Cache Rules applied:')
for (const r of res.result.rules) {
  console.log(`  - ${r.description}  [${r.action}]`)
}
console.log('\nTip: purge the zone cache once (dashboard → Caching → Purge → Purge everything) so the new headers take effect immediately.')
