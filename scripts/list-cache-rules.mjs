// Read-only dump of the zone's cache-rules entrypoint, so duplicates are visible.
import { readFileSync } from 'node:fs'

const TOKEN = process.env.CF_API_TOKEN
const ZONE_NAME = process.env.CF_ZONE_NAME || 'joining-palms.app'

const api = async (path) => {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, {
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  const j = await r.json()
  if (!r.ok || j.success === false) throw new Error(`API ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 300)}`)
  return j
}

const zones = await api(`/zones?name=${encodeURIComponent(ZONE_NAME)}`)
const zone = zones.result[0]
const ep = await api(`/zones/${zone.id}/rulesets/phases/http_request_cache_settings/entrypoint`)
const rules = ep.result?.rules || []
console.log(`${rules.length} rule(s) on http_request_cache_settings\n`)
rules.forEach((r, i) => {
  console.log(`${i + 1}. ${r.description || '(no description)'}`)
  console.log(`   expression: ${(r.expression || '').slice(0, 150)}`)
  const s = r.action_parameters || {}
  if (s.cache_key) console.log(`   cache_key : ${JSON.stringify(s.cache_key)}`)
  if (s.edge_ttl) console.log(`   edge_ttl  : ${JSON.stringify(s.edge_ttl)}`)
  if (s.cache) console.log(`   cache     : ${JSON.stringify(s.cache)}`)
  if (s.origin_cache_control !== undefined) console.log(`   origin_cc : ${s.origin_cache_control}`)
  console.log()
})
