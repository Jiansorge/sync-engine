# Deployment — sync-engine

Per-tenant Cloudflare deployment guide. **Each community/tenant deploys to its
own Cloudflare account** (or, at minimum, its own Worker name). DO storage is
scoped by (account, Worker name, DO class + id) — two tenants sharing an account
and name would silently share all-time totals.

## Prereqs

- Node 18+ and a Cloudflare account.
- `npm i -g wrangler` (or use `npx wrangler`).

## Steps

```bash
cd sync-engine
npm install
npm test                 # 53 tests — should be green before you ship
npx wrangler login
```

Before deploying, edit `wrangler.toml`:

1. **`name`** — set something unique to the tenant (the Worker's public name).
2. **`ALLOWED_ORIGINS`** — the exact origin(s) the app is served from, e.g.:
   ```toml
   ALLOWED_ORIGINS = "https://prayer-earth.<your-subdomain>.workers.dev,https://prayer.earth"
   ```
   Because the app is served **by the Worker itself**, the same-origin default
   already admits it — `ALLOWED_ORIGINS` just pins it explicitly and lets you
   add extra domains (e.g. a custom domain + `www`). Unset means same-origin
   only, which is safe for local dev.
3. Optional hardening (all have safe defaults in `src/worker.js`):

   | var | default | note |
   |---|---|---|
   | `MAX_UPGRADES_PER_IP` | 0 (off) | enable (e.g. 10) to deter socket churn; per-isolate best-effort |
   | `MAX_MSG_PER_SEC` | 20 | per-connection budget; over-budget sockets are closed |
   | `NUM_SHARDS` | 1 | single `world` DO; raise later to shard by `?cell=` |
   | `PRESENCE_TTL_MS` | 30000 | stale-session sweep threshold |
   | `SWEEP_ALARM_MS` | 30000 | DO alarm cadence for sweep + durable flush |
   | `START_MIN_INTERVAL_MS` | 10000 | prayer-start gate (protects durable totals) |

4. Secrets: `npx wrangler secret put ADMIN_KEY` (needed for `GET /stats?fresh=1`
   to bypass the cache). Never put real secrets in `wrangler.toml`.

Deploy:

```bash
npm run deploy
```

The engine URL is the Worker's public URL; the app connects with `CfEngine` and
`VITE_SYNC_ENGINE=cf` (Prayer Earth already supports this), socket on the same
origin as the app.

## One-command deploy (app + engine together)

`scripts/deploy-app.mjs` does the whole flow for Prayer Earth in one command:

```bash
npm run deploy:app           # test → build app (VITE_SYNC_ENGINE=cf) → stage → deploy
npm run deploy:app:dry       # dry-run only
node scripts/deploy-app.mjs --stage-only --skip-tests   # build + stage, no deploy
```

What it does, safely:

1. **Preflight** — checks `wrangler login` (skip with `--no-auth` for CI).
2. **Tests** — runs the sync-engine suite (skip with `--skip-tests`).
3. **Builds Prayer Earth** with `VITE_SYNC_ENGINE=cf` so the app connects with
   `CfEngine` to the Worker socket.
4. **Stages** the build into `public/` (the Worker's assets), **backing up the
   previous `public/`** to `public-backups/<timestamp>` first.
5. **Deploys** the Worker (or `--dry-run`), then prints verification steps.

The app and the sync socket then share one origin, so Prayer Earth's
`defaultUrl()` resolves to the same host — no URL wiring needed.

**Rollback:** the previous app build is safe in `public-backups/`:
`node scripts/deploy-app.mjs --restore <timestamp>` then `npm run deploy`.
(The Node reference server stays on :8787 as the app-level fallback.)

**Related one-time scripts:**

```bash
npm run kv:setup            # create TOTALS_BACKUP KV + patch wrangler.toml (once)
npm run verify -- https://<worker>.workers.dev   # health + stats + live WS smoke
```

**App assets (e.g. prayer recordings) ride along.** Prayer Earth's recordings live
in `prayer-earth/public/audio/` and are described by `manifest.json`; the build
copies them into `dist/audio`, and `deploy:app` stages that into `public/`. So
any audio change ships with the next `deploy:app`. To remove/replace recordings
safely, use Prayer Earth's `npm run audio:remove` (keeps the manifest in sync) —
see `prayer-earth/docs/AUDIO.md`.

> `public/` is a generated deploy target. A placeholder `index.html` is committed
> so `wrangler dev` works on a fresh clone; run the stage step (or `deploy:app`)
> to serve the real app locally.

## Data safety — lifetime stats are never erased

All-time `totals`, `totalPrayerSeconds`, `anonSeen`, `counts`, and every
`['people', anonId]` blob are **durable** (SQLite-backed DO storage, survives
every redeploy/restart). The retention sweep deletes **only empty/synthetic**
per-anon blobs (anonId-rotation abuse sends empty stats); **any blob with real
lifetime data is kept forever**. A failed storage read retries instead of
persisting zeros. On top of that, SQLite-backed DOs give 30-day point-in-time
recovery, and an optional KV/R2 snapshot of `GET /stats` gives an external copy
(RPO = one snapshot interval). The app's own device copy is the final fallback:
a re-sync after any loss re-accumulates from the device.

## Verify after deploy

- `GET /health` → `{"ok":true,"type":"sync-engine","protocol":3,"shards":1}`
- `GET /stats` → aggregated totals (with `counts`)
- `npm run smoke https://your.worker.dev` → presence → state → sync → ping/pong
- Static page served at the root (assets binding).

## Scaling to shards (later)

Set `NUM_SHARDS = 8` and have clients append `?cell=LLL,LLL` to the socket URL;
the Worker hashes the cell to a shard. `/stats` continues to aggregate via the
Coordinator DO, which always includes `world` — so a 1→N flip keeps the old
all-time totals visible (no history vanishes). Live feed remains per-shard.

## Persistence model — what is never lost, and the one honest caveat

**Durable by design (survives every redeploy):**

- **All-time totals** (`totals`, `totalPrayerSeconds`) — the world's lifetime
  prayer counts. Stored in DO SQLite storage, written on a debounced writer,
  **never pruned**. This is the data "lifetime prayers made for the app" means,
  and it is append-only.
- **Per-user anonymous lifetime stats** (`people/<anonId>`) — the retention
  sweep **only** removes keys with no lifetime stats at all (empty/junk); any
  key with real counters, streaks, or completion history is kept forever.

**Disaster recovery:** DO storage is durable, but a catastrophic loss (account
deletion, manual purge) would otherwise be unrecoverable. Enable the optional
**`TOTALS_BACKUP` KV binding** (see `wrangler.toml`): each shard mirrors its
lifetime totals to KV every ~6h, so ops can restore the world's counts. No
automated restore is provided — document a manual restore runbook.

**The honest caveat:** per-user history follows the opaque `anonId` stored in the
person's own `localStorage`. If they clear browser data or switch devices, that
person's *individual* stats start fresh (a new anonId) — the world's lifetime
totals are unaffected. Recovering per-person history across devices would
require an account, which this app deliberately avoids for privacy. This is a
design constraint, not a bug.

**Pruned by design (not user data):** the in-memory `_anonSeen` index (used for
the "prayed today / this week" glow) is kept to a ~7-day window; live sessions
and the feed are ephemeral by nature.

## Operational limits & parity (from the security audits)

**Cloudflare platform ceilings to design around** (not engine bugs — document so
operators don't mistake a cap for a fault):

- **WebSockets per DO**: Cloudflare allows ~10,000 concurrent WebSockets per
  Durable Object. A single `world` shard (NUM_SHARDS=1) is the live-session
  ceiling. Raised via sharding, not by tuning the engine.
- **Storage**: SQLite-backed DOs (`new_sqlite_classes`) have generous durable
  storage. `people` keys are the only unbounded store — the retention sweep
  deletes only empty/synthetic blobs (lifetime stats are kept forever), so
  growth is bounded by real users + abuse; `MAX_UPGRADES_PER_IP` deters anonId
  rotation. Keep it enabled in production.
- **Alarms**: `SWEEP_ALARM_MS` is a cadence hint; alarms are reliable but not
  sub-second. The DO also re-arms on activity, so the sweep is best-effort.
- **Message rate**: `MAX_MSG_PER_SEC` (default 20) is per connection; the
  upgrade throttle (`MAX_UPGRADES_PER_IP`) is the only per-IP backstop, and it
  keys on a SHA-256 hash of the peer address — never the raw IP.

**Parity with the reference Node server** (known, intentional differences a
consumer app should expect when it flips `VITE_SYNC_ENGINE`):

- **`totalPrayerSeconds` accrual differs**: the Node reference adds a flat
  `clients.size × 0.25` every 250ms for *all* connected sockets; the engine
  accrues ~1s per *actively praying* session per second. The engine's number is
  the more honest one, but it will read lower than the Node server's.
- **`E_ERROR`**: the engine sends `{type:'error', code:'rate'}` before closing a
  rate-limited socket; the Node server just closes. Both engines trigger the
  app's reconnect/sim fallback — the `error` frame is just friendlier.
- **Cross-shard `usersToday/usersWeek`** are an approximate upper bound (a
  person on two shards counts twice) — fine for a glow meter, not for billing.
- **Feed is per-shard** (and per-engine) — entries are never cross-shard merged.


## Cache invalidation � after changing the MP3 library or removing prayers

The app's service worker is **cache-first for every same-origin GET, including
`/audio/*.mp3`**, and Cloudflare's CDN caches static assets at the edge. So when
the prayer library changes (new recordings, renamed files, or prayers removed),
stale audio can keep being served. The process to push fresh audio:

1. **Bump the app's service-worker cache version** � edit
   `prayer-earth/public/sw.js`: `const CACHE = 'prayer-earth-vX'` ? bump X. On
   the next load the new SW installs, its `activate` deletes the old cache, and
   it re-caches the fresh files. This is the primary mechanism.
2. **Purge the Cloudflare CDN cache for `/audio/*`** when the app is served
   through this Worker (via `env.ASSETS`): Cloudflare edge cache purge from the
   dashboard, or `npx wrangler` / the API � otherwise the edge keeps handing out
   the old MP3s even after the SW clears.
3. **No action needed for the app's in-memory audio cache** � `cloudCache`
   (speech.js) is per-session and clears on reload.
4. **Removed prayers**: after the SW version bump, the old files are simply no
   longer referenced; you may delete them from the assets/deploy in the same
   release.
