# Security model — sync-engine

## Design posture

Anonymous public presence. There is **no identity, account, or auth** — the
product is "who's here, live" and "how much collective prayer happened". The
security work is therefore: (1) keep nothing personal or secret in scope,
(2) bound abuse of the public write path, and (3) make the wire format the
privacy boundary.

## Trust boundaries (what each control actually does)

| control | stops | does NOT stop |
|---|---|---|
| Origin allow-list (or same-origin default) | cross-site WS hijacking from a **browser** | a native client that omits `Origin` |
| per-connection message budget | floods from one socket | multi-socket floods alone |
| upgrade throttle (hashed IP, per-isolate) | fast socket churn per isolate | a distributed attacker across locations |
| prayer-start gate | durable-totals inflation by one socket | a large coordinated botnet |
| day-string validation | `usersToday/usersWeek` spoof (e.g. `9999-12-31`) | — |
| cell normalization (1° grid) | precise-location leakage from a malicious cell | — |
| `sanitizeStats` | prototype-pollution keys into storage | — |

Because it is anonymous-by-design, a determined attacker with many IPs can
still distort *live* counts (e.g. `people`, `prayers`). These self-correct when
sockets close; the **durable** numbers are rate-gated and debounced. That is
the honest ceiling of a no-auth design.

## Wire & storage privacy

- Only coarse 1° grid cells and anonymous counters ever circulate.
- `anonId` is random and opaque; it is never broadcast — it only keys a
  per-device stats blob in storage.
- Raw IPs are never logged or stored; the only derived value is a SHA-256 hash
  used by the upgrade throttle.
- Storage keys: `schema`, `totals`, `totalPrayerSeconds`, `anonSeen`,
  `['people', anonId]`, `counts` — all anonymous.

## Known limitations (accepted, documented)

- **anonId state-poisoning (low):** `sync` is a max-merge, so anyone who *knows*
  an anonId can only *raise* that user's counters (they cannot lower or steal).
  anonIds are unguessable random UUIDs. Full protection would require auth,
  which conflicts with the anonymous design.
- **`MAX_UPGRADES_PER_IP` is per-isolate best-effort**, not global.
- **The Origin check is a browser control**, not an auth boundary.
- **Feed `name` is JSON only**; the app must never inject it as HTML (app-side
  XSS responsibility).
- **Tenant isolation is a deployment rule** (see `DEPLOYMENT.md`): DO storage is
  scoped by account + Worker name; each tenant deploys separately.

## Hardening checklist (production)

- [ ] `ALLOWED_ORIGINS` set to the deployable domains.
- [ ] `MAX_UPGRADES_PER_IP` enabled (e.g. 10).
- [ ] `ADMIN_KEY` set via `wrangler secret put` (for `?fresh=1`).
- [ ] `wrangler` pinned; `npm audit` reviewed before release.
- [ ] No raw IPs anywhere; snapshots of `/stats` are the only external copy.
- [ ] `PROTOCOL_VERSION` bumped if the wire shape ever changes; drift test kept
      green (both `protocol.js` copies byte-identical).
