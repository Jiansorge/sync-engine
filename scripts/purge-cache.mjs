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
// Explicit URL paths (e.g. --paths="/health /stats /"). Purges only those files,
// used by the deploy gate after a routing change so a stale cached SPA HTML shell
// can never keep answering /health + /stats instead of Worker JSON.
//
// Both --paths="/a /b" and --paths=/a /b have to work. The second is what you
// actually type, and an unquoted list splits into separate argv entries, so
// `--paths=/ /health /stats` left PATHS holding only "/" and silently purged
// nothing else — the exact set this gate exists to clear. Everything after
// --paths= up to the next --flag is collected now.
const PATHS = []
{
  const argv = process.argv.slice(2)
  const at = argv.findIndex((a) => a.startsWith('--paths='))
  if (at >= 0) {
    const inline = argv[at].slice('--paths='.length).trim()
    if (inline) PATHS.push(...inline.split(/\s+/).filter(Boolean))
    for (let i = at + 1; i < argv.length && !argv[i].startsWith('--'); i++) {
      PATHS.push(...argv[i].split(/\s+/).filter(Boolean))
    }
  }
}

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

const FILES = PATHS.map((p) => `https://${ZONE_NAME}${p.startsWith('/') ? p : '/' + p}`)
const body = ALL
  ? { purge_everything: true }
  : { files: FILES.length ? FILES : [`https://${ZONE_NAME}/audio/*`] }

const res = await api(`/zones/${zone.id}/purge_cache`, { method: 'POST', body: JSON.stringify(body) })
// Report what was actually purged. The message used to say "/audio/*" no matter
// what was passed, which is the kind of small lie that makes someone distrust
// every other line this prints - including the ones that matter after a routing
// change, when "did the purge include /health?" is the whole question.
if (ALL) {
  console.log('Purged the entire zone cache.')
} else if (PATHS.length) {
  console.log(`Purged ${PATHS.length} path(s) on ${ZONE_NAME}: ${PATHS.join(', ')}`)
} else {
  console.log(`Purged /audio/* on ${ZONE_NAME}.`)
  console.log('To also refresh the service-worker cache, bump CACHE in prayer-earth/public/sw.js and redeploy.')
}
