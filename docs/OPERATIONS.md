# Operations runbook — sync-engine

## Health & monitoring

- **`GET /health`** — liveness + `protocol` + `shards`. Monitor this on an
  interval (e.g. 60 s) and alert on non-200.
- **`GET /stats`** — the one useful dashboard number. It returns:
  `prayers` / `spirits` (all-time totals), `seconds` (totalPrayerSeconds),
  `usersToday` / `usersWeek`, `people` (live now), `counts`
  (`connects/messages/presence/sync/starts`), `errors` (shards that failed to
  answer), `generatedAt` (cache age).
- Watch for: a persistent `people` of 0 while the app reports connected users;
  `errors > 0` (a shard is unhealthy); `counts.connects` collapsing (clients
  can't upgrade).

## Known behaviors (not bugs)

- **Deploys disconnect every WebSocket.** Cloudflare restarts all DOs on a new
  version; live presence resets and clients reconnect (the app's backoff +
  idempotent `presence`/`sync` handle it).
- **Live state resets on DO eviction.** Sessions/feed are in-memory; all-time
  totals, `anonSeen`, `counts`, and per-anon sync live in durable storage.
  Session presence is persisted per-socket (`serializeAttachment`) so it
  survives hibernation.
- **`usersToday/usersWeek` use UTC days** and are derived from validated day
  strings; near midnight UTC they may differ from a client's local day.
- **`MAX_UPGRADES_PER_IP` is per-isolate best-effort**, not a global limit.
- **`totalPrayerSeconds` accrues only for actively-praying sessions** and pauses
  during hibernation gaps (the durable floor is preserved).

## Backup / recovery (high-value totals)

`totals`, `totalPrayerSeconds`, and `anonSeen` live in SQLite-backed DO
storage, which has **30-day point-in-time recovery**. On top of that, the engine
**mirrors the anonymous lifetime totals to a KV namespace every ~6 hours** (RPO
≤ 6h). Create it once per tenant and uncomment the binding in `wrangler.toml`:

```
npx wrangler kv namespace create TOTALS_BACKUP
```

The DO writes `totals/<shard>` keys (prayerId/spiritId counts + seconds — no
personal data). Restore = read those keys back into `storage.totals` on a
rebuilt shard. Without the binding the DO no-ops (dev/tests never need it). For
extra belt-and-suspenders, snapshot `GET /stats` externally too. Never write raw
IPs to any backup.

## Capacity alerts (get notified before you hit limits)

The free Workers plan includes **100,000 requests/day** — audio plays count toward
it until audio is served from R2. Set up alerts so you know before you're near:

1. **Cloudflare's built-in email (recommended, zero setup):** Dashboard →
   **Notifications → Add → Workers Usage** → set thresholds (e.g. 50% / 80%) →
   destination email. Cloudflare emails you when usage crosses them. (Also add an
   **R2 Usage** notification once the bucket exists.)
2. **CLI check (cron-able):** `CF_API_TOKEN=... CF_ACCOUNT_ID=... npm run usage`
   exits non-zero at ≥ 80% (default). Make an API token with
   *Account > Workers Scripts > Read* at https://dash.cloudflare.com/profile/api-tokens.
3. **Offload when you approach it:** enable R2 (dashboard → R2 → Enable), then
   `npx wrangler r2 bucket create joining-palms-audio`, `npm run audio:r2:upload`,
   uncomment the `[[r2_buckets]]` binding in `wrangler.toml`, redeploy. R2 absorbs
   the audio reads (free tier ≈ 330k plays/day) and has no egress fees.

The dashboard also shows per-Worker request graphs under **Analytics → Workers**.

## Tuning & optimizations

- **Presence cadence is the #1 cost lever at scale.** The app sends `presence`
  every 5 s while open; each is a DO message (billed 20:1, so ~4/s per user →
  1 billed request/5 s/user). At large concurrent-user counts this dominates the
  DO bill. Raising the cadence to 15–30 s (prayer-earth `client.js` `PING_MS`)
  cuts it 3–6× with a minor freshness tradeoff — the engine broadcasts on change
  regardless, so the world still updates live.
- **R2 makes deploys fast.** The app bundle (incl. ~3.5k audio files) is staged
  into `public/` on every deploy (~30 s, ~7,200 files). Enabling R2 moves audio
  to the bucket, shrinking deploys to ~5 s and the Worker upload to the app
  shell + engine. It is NOT required for cost (static assets are free) — it is
  a deploy-speed/size win.
- **Audio caching**: files serve with `max-age=0, must-revalidate` (correct when
  you replace a recording in place). If you want longer caching, version audio
  filenames (content hash) and add immutable cache headers — only worth it at
  high play volume.
- **Monitoring covers degradation**: the uptime Action checks both `/health`
  and `/stats` `errors`, so a shard that stops answering raises an issue, not
  just a hard outage.

## Debugging

- Local: `npm run dev -- --port 8790` then `npm run smoke ws://localhost:8790`.
  (`8787` is often Prayer Earth's Node server.)
- The DO logs errors as `sync-engine: ...` markers with no message payloads
  (privacy) — a marker means a handler/storage/flush error; check the surrounding
  stack in Cloudflare's live tail.
- `wrangler tail` shows request-level logs for the deployed Worker.

## Incident quick-ref

| symptom | likely cause | action |
|---|---|---|
| `people` stuck at 0 with live clients | clients on a different shard / wrong URL | check `?cell=` routing + app URL |
| `errors > 0` in `/stats` | a shard's `/summary` failing | tail that DO; DOs auto-recreate |
| clients reconnecting in a loop | deploy rolled out (expected) or Origin 403 | confirm `ALLOWED_ORIGINS`; let backoff settle |
| totals suspiciously inflated | prayer-start gate or ambient wrong | check `START_MIN_INTERVAL_MS`; alert on deltas |
| `/stats?fresh=1` ignored | `ADMIN_KEY` missing or header wrong | `wrangler secret put ADMIN_KEY`; send `x-sync-admin` |
