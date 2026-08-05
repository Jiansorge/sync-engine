// sync-engine — check how close the Worker is to its included request quota.
//
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... npm run usage            # script name defaults to joining-palms
//   npm run usage -- <scriptName>
//
// Exits 0 (ok) / 1 (over 80%) / 2 (error). The reliable alert is Cloudflare's
// built-in "Workers Usage" notification (dashboard → Notifications) — this is a
// handy CLI check to run from cron too.
//
// Token: https://dash.cloudflare.com/profile/api-tokens → create with
// "Account > Workers Scripts > Read" (or the Account Analytics read permission).

const script = process.argv[2] || process.env.CF_SCRIPT || 'joining-palms'
const account = process.env.CF_ACCOUNT_ID
const token = process.env.CF_API_TOKEN
const WARN_AT = Number(process.env.WARN_AT || 80)

if (!account || !token) {
  console.error('Set CF_ACCOUNT_ID and CF_API_TOKEN (see the header comment).')
  process.exit(2)
}

const url =
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}` +
  `/workers/scripts/${encodeURIComponent(script)}/usage/models/requests`

try {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) {
    console.error(`API ${r.status}: ${await r.text()}`)
    process.exit(2)
  }
  const j = await r.json()
  const res = j?.result || {}
  // Fields vary by plan: value (used), total_quota (included), value_smoothed.
  const used = res.value ?? res.value_smoothed
  const quota = res.total_quota ?? res.included_quota
  if (typeof used !== 'number' || typeof quota !== 'number' || quota <= 0) {
    console.error('Could not read usage from API response:', JSON.stringify(res).slice(0, 300))
    process.exit(2)
  }
  const pct = Math.round((used / quota) * 1000) / 10
  const line = `Worker "${script}": ${used.toLocaleString()} / ${quota.toLocaleString()} requests (${pct}% of included)`
  if (pct >= WARN_AT) {
    console.error(`⚠️  ${line} — at/near your ${WARN_AT}% threshold. Consider enabling R2 or the paid tier.`)
    process.exit(1)
  }
  console.log(`${pct < 50 ? 'OK' : 'WATCH'}: ${line} (threshold ${WARN_AT}%)`)
  process.exit(0)
} catch (e) {
  console.error('usage check failed:', e.message)
  process.exit(2)
}
