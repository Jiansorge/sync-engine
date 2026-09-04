# sync-engine

[![CI](https://github.com/Jiansorge/sync-engine/actions/workflows/test.yml/badge.svg)](https://github.com/Jiansorge/sync-engine/actions/workflows/test.yml)
[![Live — joining-palms.app](https://img.shields.io/badge/live-joining--palms.app-DFB05C)](https://joining-palms.app)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

A **privacy-first, real-time sync layer** built on Cloudflare Workers + Durable
Objects: WebSocket presence, live broadcasting, and durable anonymous state.
It is intentionally **app-agnostic** — **Joining Palms** (formerly Prayer Earth,
live at `https://joining-palms.app`) is the first consumer, but any app that
needs "who's here, live" can use it.

## Preview

```
Browser (Prayer Earth)                 Cloudflare
┌─────────────────────┐   WS   ┌───────────────────────────────┐
│  sync/engine.js     │ ─────▶ │ Worker + ASSETS (edge cache)  │
│  145 prayers × 15 traditions    │   · SyncRoom / Coordinator DOs│
│  12 languages, PWA  │        │   · live lights + durable totals│
└─────────────────────┘        └───────────────────────────────┘
```

*This repo is **public and contains zero secrets** — safe to share. No `CF_API_TOKEN`, no `ADMIN_KEY`, no KV/R2 IDs beyond the public namespace id (which is not a credential). See **Private data** below.*

## Project

* **What it does:** `presence` (who's praying now, coarse 1° cell), `feed` (recent prayers), `sync` (anonymous lifetime counters, max-merged), all over a single WebSocket. See `src/protocol.js` (single source of truth, drift-tested).
* **Why Workers + DOs:** ~$0/mo free tier, global edge, SQLite-backed DO storage survives every deploy, no cold starts. App swaps `SyncEngine`→`CfEngine` with zero app-code change.
* **Reuse:** Copy `src/engine.js` + `src/protocol.js` — any app needing "who's here live" can use it.

## Private data

| What | How we handle it |
|---|---|
| **Location** | Only coarse **1° cell** (`gridKey`) ever sent; precise lat/lng never leaves device. Server re-rounds `cell` into `[-180,180)` grid. |
| **Identity** | No accounts. `anonId` is random UUID, `name`/`avatar` user-chosen, stored in `localStorage` only. |
| **IPs** | Raw IPs **never logged** — upgrade throttle stores only `SHA-256(IP)` in memory. |
| **Payloads** | Caps: `name` 24, ids 60, `anonId` 64, WS 64KB, `sync` 250KB; `__proto__`/`constructor` stripped. |
| **Secrets** | **None in repo.** `wrangler.toml` vars are non-secret; real `ADMIN_KEY`/`CF_API_TOKEN` live in `wrangler secret` / GitHub Secrets. `.dev.vars`/`.env` are gitignored (`sync-engine/.gitignore`). |
| **Compliance** | Anonymous aggregates only; durable totals mirror to `TOTALS_BACKUP` KV every ~6h + 30-day PITR. |

## Why this architecture

- **~$0/month** — Cloudflare's free tier (Workers requests, Durable Object
  storage, Pages/R2 static) covers a real app.
- **Global + always-on** — Workers run at the edge; Durable Objects hold
  persistent, live connections. No sleep, no cold starts.
- **Durable by design** — DO `storage` (SQLite-backed) replaces JSON files on
  disk: totals and anonymous sync data survive every redeploy automatically.
- **Reusable** — the engine is a standalone package; the app depends only on a
  tiny interface (`src/engine.js`), so swapping backends never touches app code.

## Architecture

```
Browser (Prayer Earth)                 Cloudflare
┌─────────────────────┐   WS   ┌───────────────────────────────┐
│  sync/engine.js     │ ─────▶ │ Worker (src/worker.js)        │
│  (app never changes)│        │   · origin allow-list          │
│                     │        │   · optional upgrade throttle  │
└─────────────────────┘        │   · WS upgrade → shard DO      │
                               │   · static assets (env.ASSETS) │
                               │   · GET /stats, /health        │
                               │ SyncRoom (src/worker.js)       │
                               │   · hibernating live sessions  │
                               │   · coalesced state/feed       │
                               │   · durable totals (storage)   │
                               │ Coordinator (src/worker.js)    │
                               │   · aggregates totals/users*   │
                               │     across shards for /stats   │
                               └───────────────────────────────┘
```

## Protocol (the contract) — see `src/protocol.js`

Every message is a JSON object with a `type`. This file is the single source of
truth; apps copy it as `src/sync/protocol.js`. **Keep the two copies
byte-identical — a drift test enforces it.**

| Direction | type | payload |
|---|---|---|
| C→E | `presence` | `{ praying, prayerId?, spiritId?, name, cell? }` |
| C→E | `sync` | `{ anonId, stats }` (lifetime counters, max-merged) |
| C→E | `ping` | `{}` (client keepalive probe) |
| E→C | `state` | `{ people, lights, lightSpirits, prayers, spirits, totals, usersToday, usersWeek, totalPrayerSeconds }` |
| E→C | `feed` | `{ feed: [{id,t,name,spiritId,prayerId,cell?}] }` (≤ 40) |
| E→C | `sync` | `{ stats }` (merged) |
| E→C | `pong` | `{}` (liveness ack; client treats a missed pong as a dead socket) |
| E→C | `error` | `{ code }` — engine's reason before it closes a socket (e.g. `rate`) |

Privacy is in the wire format: **only a coarse 1° cell** is ever shared, never a
precise location or identity. Raw IPs are never logged; the only thing derived
from a peer address is a SHA-256 hash used by the optional upgrade throttle.

## App integration

The app depends only on `src/engine.js` (the `SyncEngine` interface). Two
implementations exist:
- `SyncEngine` (plain WebSocket — matches the reference Node server).
- `CfEngine` (same protocol, Cloudflare URL + keepalive).

Swap engines by choosing which to instantiate; app code stays identical.
**The public surface (`connect/send/disconnect`, `onMessage/onStatus`) is
frozen** — application code never changes.

## Reusable beyond Prayer Earth

`sync-engine` is **app-agnostic presence + live broadcast + anonymous
telemetry** — not Prayer Earth code. The wire contract is generic
(`presence`/`sync`/`ping`); Prayer Earth's `spiritId`/`prayerId`/`totals`
fields are treated by the engine as **opaque identifiers**. Any app that needs
"who's here right now, live", a bounded live feed, and durable anonymous
counters can drop in the same `engine.js` and Worker:
- live "X people doing Y right now" indicators
- real-time activity feeds
- anonymous aggregate counters (with privacy built into the format)
- room/region sharding via `?cell=` and `NUM_SHARDS`

To reuse: copy `src/engine.js` + `src/protocol.js` into your app, and deploy
this Worker as-is. Only the app's payload *field names* (prayerId etc.) are
Prayer Earth's — change them on both sides of the wire if you need different
semantics (bump `PROTOCOL_VERSION` when you do).

## Durable state (in DO storage)

All-time numbers live in `SyncRoom`'s SQLite-backed `storage` and survive every
redeploy and DO eviction:

| key | holds |
|---|---|
| `schema` | `{ v: 1 }` — bump on storage shape changes |
| `totals` | `{ prayers, spirits, updatedAt }` — all-time prayer-start counts |
| `totalPrayerSeconds` | running collective prayer seconds |
| `anonSeen` | `[anonId, lastActiveDay][]` (bounded to ~7 days) — drives `usersToday`/`usersWeek` |
| `['people', anonId]` | merged per-device lifetime stats (max-merge, idempotent) — **kept forever** |
| `counts` | anonymous usage counters (`connects/messages/presence/sync/starts`) |

Writes are **debounced** (≈1 s, `PERSIST_DEBOUNCE_MS`) — never per-message —
and forced through on close and on the sweep alarm. `totals.prayers/spirits`
are incremented once per newly-started prayer (matching the reference Node
server), `totalPrayerSeconds` accumulates ~1 s per actively-praying person, and
`usersToday/usersWeek` are derived from the anonymous `anonSeen` map. All of
them are emitted from `state` broadcasts.

**Data safety:** every `['people', anonId]` blob with real lifetime data is kept
forever — the retention sweep deletes only empty/synthetic blobs (anonId-rotation
abuse). A failed storage read retries instead of persisting zeros, and the
engine mirrors the anonymous totals to the optional `TOTALS_BACKUP` KV every
~6 h for disaster recovery (see `docs/OPERATIONS.md`).

Live sessions/feed are in-memory only (that is "right now" data) and reset on
eviction — acceptable by design.

## Sharding (v1 isn't a dead end)

`src/shard.js` maps a coarse cell onto a shard:
- `NUM_SHARDS = 1` (default) → everything lands on the single `world` DO
  (backward compatible; v1 runs exactly like today).
- `NUM_SHARDS > 1` → `shardName(cell, n)` hashes the cell to `shard-0..N-1`.
  The app opts in by appending `?cell=LLL,LLL` to the socket URL (the worker
  reads it at upgrade time; without it the socket goes to `shard-0`).

The **coordinator DO** (`Coordinator`) aggregates across shards: `GET /stats`
asks every shard for its `/summary` (`totals`, `usersToday`, `usersWeek`,
`seconds`, `people`) and merges them (sums, ~5 s cache). It always reads
`world` in addition to `shard-0..N-1`, so a live 1→N shard flip keeps the
pre-shard all-time totals aggregated (no history vanishes). `users*` are a light
upper bound because a person whose cell changes can appear on two shards.
Live **feed is per-shard** — cross-shard feed merging is still open (see gaps).

## Development

```
npm install
npm run dev                 # local Workers runtime on http://127.0.0.1:8787
npm test                    # vitest: protocol + DO integration (53 tests)
npm run smoke ws://localhost:8790   # tiny WS client against a running `npm run dev`
npm run deploy:app          # one-command deploy (test → build app → stage → deploy)
npm run ship                # same as deploy:app — the easy "push everything live"
npm run kv:setup            # once: create the TOTALS_BACKUP KV namespace
npm run verify -- https://<worker>.workers.dev   # health + stats + live WS smoke
```

`npm run dev` uses `wrangler.toml` (`new_sqlite_classes` SyncRoom + Coordinator,
`[assets]` with an `ASSETS` binding and `run_worker_first`). Note `wrangler dev`
uses port 8787 by default — run Prayer Earth's Node server on a different port,
or pass `wrangler dev --port 8790` and `npm run smoke ws://localhost:8790`.

Tests (`test/`):
- `protocol.test.js` — `mergeStats` idempotency, grid clamping, **drift test**
  (diffs the two `protocol.js` copies byte-for-byte; bump `PROTOCOL_VERSION` on
  any shape change).
- `security.test.js` / `stats.test.js` / `shard.test.js` — pure unit tests.
- `worker.test.js` — runs the real Worker + DOs in the Workers runtime:
  keepalive ping→pong, presence → state/feed broadcast + all-time totals,
  sync merge that **survives a DO restart** (`evictDurableObject`), stale-session
  sweep, and the per-connection message budget.

## Deployment

> Full, current guides: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (per-tenant
> deploy + hardening), [`docs/OPERATIONS.md`](docs/OPERATIONS.md) (runbook:
> monitoring, backup/RPO, incident quick-ref), and
> [`docs/SECURITY.md`](docs/SECURITY.md) (trust model + audit findings).

### Standard (one Worker per community, per-tenant)

Cloudflare's Terms favor each community running its **own** Workers account.
Per tenant:

```
cd sync-engine
npm i -g wrangler && wrangler login
# 1. point wrangler.toml at your deployable domains:
#      [assets] binding stays ASSETS
#      ALLOWED_ORIGINS = "https://your.app,https://www.your.app"
# 2. optional hardening: MAX_UPGRADES_PER_IP, NUM_SHARDS
npm run deploy
```

The engine URL is the Worker's public URL. The app connects with
`CfEngine` and `VITE_SYNC_ENGINE=cf` (Prayer Earth already supports this). In
`wrangler.toml` keep `PROTOCOL_VERSION` in sync with `src/protocol.js`.

### Production hardening checklist

- **Origin allow-list** — `ALLOWED_ORIGINS`. Leave unset only for local dev
  (unset means "allow any origin"). 403 otherwise.
- **Per-connection message budget** — `MAX_MSG_PER_SEC` (default 20). A
  connection over budget is closed.
- **Upgrade throttle (optional)** — `MAX_UPGRADES_PER_IP` (default 0 = off) and
  `UPGRADE_WINDOW_MS`. Keyed on a SHA-256 hash of the peer IP; the raw IP is
  never logged or stored.
- **Ops secret** — `ADMIN_KEY` (`wrangler secret put`): required before
  `GET /stats?fresh=1` is honored. 
- **Presence sweep** — `PRESENCE_TTL_MS` (30 s) + `SWEEP_ALARM_MS` (30 s).
  Sessions that stop sending are closed by the DO alarm sweep.
- **`sync` rate** — one processed `sync` per connection per ~5 s
  (`SYNC_MIN_INTERVAL_MS`), plus the 250 KB payload cap and 64 KB message cap.

### Backup / recovery (high-value totals)

`totals`, `totalPrayerSeconds`, and `anonSeen` live in Durable Object storage
(SQLite-backed, with 30-day point-in-time recovery on SQLite-backed DOs). If
you want an external copy for the all-time numbers:

- **KV/R2 snapshot**: run a scheduled `GET /stats` into KV/R2 periodically
  (e.g. hourly) or export the DO via `wrangler`/an admin route. **Recovery
  point (RPO): one snapshot interval** (e.g. ≤ 1 hour if hourly). Because the
  DO's own storage is the durable source of truth, the external copy is only a
  belt-and-suspenders for catastrophic loss — with 30-day PITR on the SQLite
  backend, true loss is very unlikely.
- Treat the snapshot as anonymous data; never write raw IPs.

## Client reconnect policy

`CfEngine` (the Cloudflare engine) owns liveness and recovery so app code
doesn't have to:

- **Keepalive**: sends `{type:'ping'}` every 20 s; the DO answers `pong`.
- **Dead-socket detection**: if no `pong` for 60 s, the socket is torn down and
  `onStatus(false)` fires.
- **Reconnect/backoff**: the app reacts to `onStatus(false)` and reconnects
  with backoff (Prayer Earth does this in `src/sync/client.js` — it flips to a
  local simulation while disconnected and retries every ~10 s). Reconnects are
  idempotent: `presence` re-syncs the live view and `sync` (max-merge) is safe
  to replay.
- On a reconnect the DO sends the current `state` + `feed` immediately, so the
  world view refreshes without an extra round trip.

## Security & privacy

- Public-by-design anonymous presence; nothing personal ever rides the socket
  (coarse cells + pure counters only).
- No outbound calls from WS input (no SSRF). `JSON.parse` is wrapped; inbound
  WS messages > 64 KB are dropped before parsing.
- Payload caps: `name` 24, ids 60, `anonId` 64, `sync` stats ≤ 250 KB.
- Raw IPs are never logged. The upgrade throttle hashes the peer address.
- No secrets in the engine; keep `wrangler` pinned; audit deps before release.

### Trust boundaries (read this before calling anything a defense)

- **The Origin check is a browser-only control.** It stops cross-site WebSocket
  hijacking from a *browser*. A native client simply omits `Origin`, so it is
  **not** an auth boundary — the real abuse controls are the per-connection
  message budget and the optional upgrade throttle. Anonymous public presence
  means there is no identity to gate on, by design.
- **`MAX_UPGRADES_PER_IP` is per-isolate best-effort, not global.** The throttle
  map lives in one Worker isolate's memory; an attacker hitting different
  Cloudflare locations/isolates gets separate budgets. It is a deterrent, not a
  hard global limit. (A global limit would need a DO/KV counter — not worth it
  for anonymous presence; the message budget already bounds a single socket.)
- **Tenant isolation is a deployment rule.** DO storage is scoped by
  (account, Worker name, DO class + id). If two communities deploy this worker
  to the *same account and worker name*, they share all-time totals. Each tenant
  must deploy to its own account (or at minimum a unique worker name). Never run
  this as a shared public multitenant host.
- **Feed content is JSON; rendering is the app's job.** The engine only
  transports `name`/`cell`/ids as JSON. If the app injects a feed `name` into
  the DOM as HTML, that is an app-side XSS surface — the engine does not emit
  HTML and never interprets these fields.

### Ambient totals integrity

`totalPrayerSeconds` accrues ~1 s per **actively-praying** session per second —
idle/botnet sockets do not inflate it. `usersToday/usersWeek` are derived from
validated day strings (no far-future spoof). `totals.prayers/spirits` are gated
per prayer start per session. All are debounced, durable, and aggregated by the
coordinator.

---

# The Plan — evaluated 3× for gaps, security, and durability

Honest reviews, kept current. **Bold** = still open before v1 is "done."

## GAPS — pass 1
- **Cross-shard aggregation** — `usersToday/usersWeek`, all-time `totals`, and
  global feed need a coordinator once there is more than one shard.
  **Status:** totals/users* aggregated by the `Coordinator` DO (`/stats`);
  **feed is still per-shard only** (open).
- **Client keepalive/timeout** — **DONE:** `CfEngine` pings every 20 s and
  treats a missed `pong` in 60 s as a dead socket (reconnect doc above).
- **Client reconnect/backoff** — **DONE:** documented policy; Prayer Earth
  already implements it in `client.js`.
- **Auth/ratelimit** — **DONE (rate):** per-connection budget + optional
  upgrade throttle; auth is out of scope by design (anonymous public presence).
- **DO hibernation CPU limits** — **DONE:** feed capped (40), state/feed
  broadcasts coalesced, durable writes debounced.

## GAPS — pass 2
- **Feed is per-shard only** — **open**: cross-shard feed merging needs a
  coordinator fan-out; v1 runs one shard so this is invisible today.
- **Presence expiry** — **DONE:** `PRESENCE_TTL_MS` + DO alarm sweep
  (`sweepStale`); stale sockets are closed and cleaned up.
- **`mergeStats` wired in the DO** — **DONE:** `onSync` uses the shared
  `mergeStats` (protocol.js), max-merge is idempotent, no client/server drift.
- **Tests** — **DONE:** vitest suite covers merge idempotency, DO broadcast,
  restart survival, keepalive, rate budget, sweep, and the protocol drift test.
- **Engine URL wiring (dev vs prod)** — **DONE:** documented (`wrangler dev`
  port, per-tenant URL, `CfEngine`).

## GAPS — pass 3
- **Storage key design / write coalescing** — **DONE:** durable keys
  (`schema`, `totals`, `totalPrayerSeconds`, `anonSeen`, `['people', id]`) with
  a debounced writer; no per-message writes.
- **Idempotency for `sync`** — **DONE + tested:** max-merge is idempotent;
  a replay is safe (unit + restart tests).
- **Metrics/logging** — **DONE:** lightweight anonymous usage counters
  (`connects`/`messages`/`presence`/`sync`/`starts`), persisted debounced,
  exposed per-shard in `/summary` and aggregated in `/stats`. Never personal
  data; message contents are never logged (only an error marker).
- **Graceful degradation doc** — **DONE:** Prayer Earth falls back to a local
  sim when the engine is unreachable (kept); reconnect policy documented.

## SECURITY — pass 1
- **Open CORS-free WS is the design** — anonymous by design; nothing personal
  rides the socket; no secrets ever.
- **Payload caps + WS size cap** — **DONE:** 64 KB raw-message cap before parse
  plus field caps.
- **Coarse-cell enforced server-side** — **DONE:** whatever `cell` a client
  sends, `onPresence` re-rounds it through `gridKey` (and normalizes longitude
  into `[-180,180)`), so a precise or malformed value never circulates — only
  1° grid cells reach `lights`/`lightSpirits`/`feed`.
- **SSRF/injection** — no outbound calls from WS input; JSON.parse wrapped;
  handlers wrapped so one bad message can't crash the DO; the WS handshake
  (101) never depends on a successful state greeting (best-effort), and every
  timer/async path has a catch so storage hiccups surface as logs, never as
  unhandled rejections.

## SECURITY — pass 2
- **Rate limiting** — **DONE:** per-connection message budget
  (`MAX_MSG_PER_SEC`, 20/s default) closes over-budget connections; optional
  upgrade throttle (`MAX_UPGRADES_PER_IP`) hashes the peer IP.
- **`sync` storage abuse** — **DONE (rate + hygiene):** per-connection `sync`
  throttle (~1/5 s), size cap, and `sanitizeStats` strips prototype-pollution
  keys (`__proto__`/`constructor`/`prototype`) before the shared merge; total
  keys per anonId is naturally one; global key growth is bounded by the 7-day
  `anonSeen` prune (documented).
- **Durable-totals inflation** — **DONE:** prayer starts are rate-gated per
  session (`START_MIN_INTERVAL_MS`, default 10 s), so one socket alternating
  `prayerId`s can't inflate the all-time `totals`; feed entries are only pushed
  on counted starts.
- **Coordinator amplification** — **DONE:** `GET /stats?fresh=1` bypasses the
  aggregate cache only when the request also carries `x-sync-admin: <ADMIN_KEY>`
  (a secret); publicly it is ignored, so a hammer can't force a fan-out to every
  shard per request.
- **Feed spam** — **DONE:** `pushFeed` is coalesced (~250 ms) so one abusive
  client can't flood the world.
- **Origin allow-list** — **DONE:** `ALLOWED_ORIGINS` checked on upgrade; 403
  for disallowed origins. **When unset, the default is now same-origin** (plus
  Origin-less native clients), so cross-site WebSocket hijacking is closed out
  of the box and local dev still works.
- **usersToday/usersWeek spoof** — **DONE:** active days are validated
  (`YYYY-MM-DD`, not beyond tomorrow with a UTC+14 tolerance), so a spoofed
  `lastPrayedDay: 9999-12-31` can't permanently inflate the counters.

## SECURITY — pass 3
- **Per-tenant hosting** — **DONE (docs):** documented per-account deploy path;
  do not run it as one shared public multitenant host.
- **Privacy promise in code** — **DONE:** raw IPs never logged; upgrade
  throttle stores only a SHA-256 hash.
- **Dependency hygiene** — keep `wrangler` pinned; audit before release.
- **Secrets** — zero secrets in the engine (no keys needed by design).

## DURABILITY — pass 1
- **DO storage is durable** — **DONE:** totals + sync data live in storage and
  survive redeploys (tested via restart-survival test).
- **In-memory-only state loss** — **DONE:** live sessions/feed are in-memory by
  design; all-time numbers are durable. Schema version key present.
- **Single DO as SPOF** — fine for v1; DOs auto-recreate on failure.

## DURABILITY — pass 2
- **Write coalescing** — **DONE:** state/feed broadcasts debounced
  (~150/250 ms), durable writes debounced (~1 s).
- **Feed bounded** — capped at 40, coalesced.
- **Reconnect client** — documented policy (see above); app already implements.
- **Clock** — `Date.now()` for feed/ambient times; DOs share a
  consistent-enough clock for "recent".

## DURABILITY — pass 3
- **Storage schema versioning** — **DONE:** `schema` key (`{ v: 1 }`).
- **Shard migration path** — **DONE:** `shard.js` (hash cell → shard id),
  `NUM_SHARDS` env, and the `Coordinator` DO aggregate `/stats`. v1 stays a
  single `world` DO; enabling sharding is a config change plus `?cell=` in the
  app URL.
- **Catastrophic loss** — **DONE (implemented):** the engine mirrors the
  anonymous lifetime totals to the optional `TOTALS_BACKUP` KV every ~6 h
  (RPO ≤ 6 h) plus SQLite-backed DO PITR (30 days). Lifetime per-user stats are
  never pruned — only empty/synthetic blobs are garbage-collected.
- **Restart-survival test** — **DONE:** writes sync → evicts the DO → fresh
  instance reads storage → merge survived.
- **Feed ids across restarts** — **DONE:** `feedSeq` is seeded from the clock, so
  entry ids stay monotonic across DO restarts and can't collide with
  pre-restart entries still held by clients.
- **Presence survives hibernation** — **DONE:** session state is persisted per
  socket via `serializeAttachment`, so when a DO wakes from hibernation a
  person's light/prayer doesn't flicker out until their next presence.

## PASS 4 — interface re-review

- `E_STATE` schema matches the app (`prayers`/`spirits`/`totalPrayerSeconds`). ✔
- Keepalive handshake is client-initiated: `C_PING` every 20 s, `E_PONG` ack. ✔
- `mergeStats` wired in the DO (idempotent, no drift). ✔
- `webSocketError` cleans up like `close` (no leaked presence). ✔
- 64 KB inbound cap. ✔
- **Protocol drift test** — **DONE:** `test/protocol.test.js` diffs both
  `protocol.js` copies byte-for-byte; bump `PROTOCOL_VERSION` on any shape
  change.
- **Remaining (documented, not closed):** cross-shard feed merge, and the
  actual production deploy behind a feature flag in Prayer Earth (an app-side
  decision; Prayer Earth untouched except the byte-identical `protocol.js`
  copy).

---

## Handoff checklist
1. **DONE** — `merge` wired to the shared `mergeStats` in `worker.js`.
2. **DONE** — 64 KB message cap + `webSocketError` session cleanup.
3. **DONE** — per-connection rate budget, Origin allow-list, feed coalescing,
   presence last-seen sweep (DO alarm).
4. **DONE** — `totals`/`usersToday`/`usersWeek`/`totalPrayerSeconds` in durable
   `storage` with a debounced writer; `schema` version key; sharding plan +
   `Coordinator` DO implemented.
5. **DONE** — vitest for protocol + DO state (incl. restart-survival) + drift
   test diffing `protocol.js` across the two copies.
6. **DONE** — per-tenant Cloudflare deploy path + client reconnect policy
   documented; `npm run dev/deploy/smoke` + `[assets]`/`new_sqlite_classes`
   wired in `wrangler.toml`. Prayer Earth deploy behind a feature flag is left
   to the app team (only the byte-identical `protocol.js` is copied over).

## License

**AGPL-3.0** — free for everyone to use, modify, and host. Because it is
copyleft and network-copyleft, anyone who serves a modified version or ships it
as part of a product must make their changes available under the same license,
so it can never be locked up or sold as a closed product. See [`LICENSE`](LICENSE).
