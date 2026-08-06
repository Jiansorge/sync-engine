// sync-engine — purge the Cloudflare edge cache (e.g. after changing audio).
//
//   $env:CF_API_TOKEN="..." ; npm run cache:purge                 # purge /audio/*
//   npm run cache:purge -- --all                                    # purge everything
//
// Token needs: Zone | Cache | Purge. (The cache:rules token has "Cache Settings
// Edit" — this needs the separate "Cache" purge permission.)
//
// Browsers also keep their own copy via the service worker. To force users to
// drop old audio, bump the CACHE name in prayer-earth/public/sw.js (v2 → v3);
// the new SW installs, deletes the old cache, and re-caches fresh files.

const ZONE_NAME = process.env.CF_ZONE_NAME || 'joining-palms.app'
const TOKEN = process.env.CF_API_TOKEN
const ALL = process.argv.includes('--all')

if (!TOKEN) {
  console.error('Set CF_API_TOKEN (a token with Zone > Cache > Purge).')
  process.exit(1)
}

const api = async (path, opts = {}) => {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  })
  const j = await r.json()
  if (!r.ok || j.success === false) {
    console.error(`API ${r.status}:`, JSON.stringify(j.errors || j).slice(0, 300))
    process.exit(1)
  }
  return j
}

const zones = await api(`/zones?name=${encodeURIComponent(ZONE_NAME)}`)
const zone = zones.result && zones.result[0]
if (!zone) {
  console.error(`Zone "${ZONE_NAME}" not found on this token.`)
  process.exit(1)
}

const body = ALL
  ? { purge_everything: true }
  : { files: [`https://${ZONE_NAME}/audio/*`] }

const res = await api(`/zones/${zone.id}/purge_cache`, { method: 'POST', body: JSON.stringify(body) })
console.log(ALL ? 'Purged the entire zone cache.' : `Purged /audio/* on ${ZONE_NAME}.`)
if (!ALL) {
  console.log('To also refresh the service-worker cache, bump CACHE in prayer-earth/public/sw.js and redeploy.')
}
