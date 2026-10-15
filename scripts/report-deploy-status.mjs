// Tell the prayer-earth commit what actually happened to production.
//
// The gap this closes is specific and easy to miss. prayer-earth's
// `deploy-dispatch` job's only job is to POST a repository_dispatch and then
// exit 0 - so from prayer-earth's side the deploy always "succeeds", even when
// sync-engine goes on to fail every single step. A commit would show a green
// tick, production would be on the previous version, and nothing on the commit
// that caused it would mention either fact.
//
// This writes a commit status back onto that SHA instead, in two passes:
// pending as soon as the dispatch is picked up, then success or failure once
// the ship step has finished. The commit therefore shows deploying -> deployed,
// and a failure lands on the commit that caused it rather than only in a run
// in a different repository.
//
// Best-effort by design: every exit path is 0. This runs in a job whose real
// product is the deploy, and a problem with status reporting must not be able
// to fail, roll back or re-run a deploy that already happened.
//
// Usage:
//   DEPLOY_PAT=... TARGET_SHA=... RUN_URL=... node scripts/report-deploy-status.mjs
//   DEPLOY_PAT=... TARGET_SHA=... SHIP_CONCLUSION=success node scripts/report-deploy-status.mjs
//
// Env:
//   TARGET_SHA          the prayer-earth commit that triggered the deploy
//   TARGET_RUN_ID       the prayer-earth run (used only to build a link)
//   RUN_URL             this workflow run, used as the status target_url
//   SHIP_CONCLUSION     '' | 'success' | 'failure' | ...; empty means "pending"
//   DEPLOY_PAT          PAT with Statuses:write on Jiansorge/prayer-earth
//   CLOUDFLARE_*        optional; used only to name the live version on success

const {
  TARGET_SHA,
  TARGET_RUN_ID,
  RUN_URL,
  SHIP_CONCLUSION = '',
  DEPLOY_PAT,
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
} = process.env

const CONTEXT = 'deploy/production'
const MAX_DESCRIPTION = 140 // the API rejects anything longer

const log = (m) => console.log(`[status] ${m}`)

// Not every trigger carries a payload. A manual workflow_dispatch from
// sync-engine has no SHA to report against, and saying so is not a failure.
if (!TARGET_SHA) {
  log('no client_payload.sha (manual dispatch) - nothing to report')
  process.exit(0)
}

if (!DEPLOY_PAT) {
  log('DEPLOY_PAT is not set - skipping the commit status (best-effort)')
  process.exit(0)
}

// The version id of whatever is serving 100%. Read straight from the
// deployments list, the same source verify-version checks after a deploy - so
// the string on the commit is what is actually live, not what was intended.
// Any failure here is swallowed: the status still ships, just without a version.
async function liveVersionId() {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) return null
  const url =
    'https://api.cloudflare.com/client/v4/accounts/' +
    `${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/joining-palms/deployments?per_page=5`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
  })
  if (!res.ok) {
    log(`could not read deployments (HTTP ${res.status}) - the status will carry no version`)
    return null
  }
  const body = await res.json().catch(() => null)
  // The envelope is { result: { deployments: [...] } }. Taking `result` as the
  // list - which is what a first draft did - leaves `list.find` throwing on a
  // plain object, the catch swallows it, and every status quietly loses its
  // version. Unwrap first, then look for `.deployments`, matching how
  // verify-version reads the same endpoint.
  const inner = body?.result ?? body
  const list = Array.isArray(inner) ? inner : (inner?.deployments ?? [])
  const live = list.find((d) => d?.versions?.[0]?.percentage === 100) ?? list[0]
  const vid = live?.versions?.[0]?.version_id ?? null
  if (!vid) log('no version id found in the deployments list')
  return vid
}

function describe() {
  if (!SHIP_CONCLUSION) return 'deploying'
  if (SHIP_CONCLUSION !== 'success') return 'deploy failed - see the run for why'
  return 'production deployed'
}

const state = !SHIP_CONCLUSION ? 'pending' : SHIP_CONCLUSION === 'success' ? 'success' : 'failure'

let description = describe()

if (state === 'success') {
  const vid = await liveVersionId().catch(() => null)
  if (vid) description = `deployed ${vid.slice(0, 8)}`
}

if (description.length > MAX_DESCRIPTION) {
  description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`
}

const body = {
  state,
  description,
  context: CONTEXT,
  target_url: RUN_URL || undefined,
}

const res = await fetch(
  `https://api.github.com/repos/Jiansorge/prayer-earth/statuses/${TARGET_SHA}`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DEPLOY_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }
)

if (res.ok) {
  log(`${state} on ${TARGET_SHA.slice(0, 8)}: ${description}`)
} else {
  const text = await res.text().catch(() => '')
  log(`GitHub rejected the status (${res.status}): ${text.slice(0, 200)}`)
}

process.exit(0)
