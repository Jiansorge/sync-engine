// sync-engine — pure aggregate/date helpers shared by the DO, the coordinator,
// and the vitest suite. No runtime dependencies so they run anywhere.

export function dayKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate()
  ).padStart(2, '0')}`
}

// A valid active day: YYYY-MM-DD and not beyond tomorrow. Anything else is
// malformed or a far-future spoof (e.g. '9999-12-31' would otherwise never be
// pruned and would inflate usersToday/usersWeek forever). We allow up to +1 day
// so legit UTC+14 users are never dropped.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const maxValidDay = () => dayKey(new Date(Date.now() + 86400000))
const validDay = (d) => {
  if (typeof d !== 'string' || !DAY_RE.test(d)) return false
  const parsed = new Date(`${d}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d
}

// The last day a synced device actually prayed, derived from the anonymous
// lifetime stats. Returns a `YYYY-MM-DD` string or null.
export function activeDayFromStats(stats) {
  const maxDay = maxValidDay()
  const okDay = (d) => validDay(d) && d <= maxDay
  const days = []
  if (okDay(stats?.lastPrayedDay)) days.push(stats.lastPrayedDay)
  for (const d of Object.keys(stats?.prayerDayCompletions || {})) {
    const m = stats.prayerDayCompletions[d]
    if (m && typeof m === 'object' && Object.keys(m).length && okDay(d)) days.push(d)
  }
  return days.length ? days.sort().reverse()[0] : null
}

// Defensive pre-merge cleaning: a hostile client could embed prototype-pollution
// keys (`__proto__`, `constructor`, `prototype`) in a stats blob. mergeStats is
// shared/immutable (byte-identical contract), so strip them here before merging.
// Values are also type-checked: mergeStats uses Math.max(a||0, b||0), so a
// non-numeric value (e.g. a string or object) would produce NaN that persists
// durably forever. Only finite numbers (or plain maps of finite numbers) pass.
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype'])
const counter = (v) => Number.isSafeInteger(v) && v >= 0
const cleanMap = (map) => {
  const out = {}
  for (const [k, v] of Object.entries(map || {})) {
    if (DANGEROUS.has(k) || typeof k !== 'string' || k.length > 100) continue
    if (!counter(v)) continue
    out[k] = v
    if (Object.keys(out).length >= 1000) break
  }
  return out
}
const cleanDayMap = (map) => {
  const out = {}
  for (const d of Object.keys(map || {}).sort().slice(-62)) {
    if (DANGEROUS.has(d) || !validDay(d) || d > maxValidDay()) continue
    const cleaned = cleanMap(map[d])
    if (Object.keys(cleaned).length) out[d] = cleaned
  }
  return out
}
export function sanitizeStats(stats) {
  if (!stats || typeof stats !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(stats)) {
    if (DANGEROUS.has(k)) continue
    if (k === 'prayerCompletions') out[k] = cleanMap(v)
    else if (k === 'prayerDayCompletions' || k === 'prayerDayStats') out[k] = cleanDayMap(v)
    else if (k === 'localPrayerSeconds' || k === 'streak' || k === 'bestStreak') {
      if (counter(v)) out[k] = v
    } else if (k === 'lastPrayedDay') {
      if (validDay(v) && v <= maxValidDay()) out[k] = v
    }
    // unknown keys are dropped entirely
  }
  return out
}

// Whether a synced stats blob holds any real lifetime data. Used by the
// retention sweep: blobs WITHOUT data (anonId-rotation abuse) are garbage; a
// blob WITH data is a user's lifetime stats and must never be erased.
export function hasLifetimeStats(s) {
  if (!s || typeof s !== 'object') return false
  if ((s.localPrayerSeconds || 0) > 0) return true
  if ((s.streak || 0) > 0 || (s.bestStreak || 0) > 0) return true
  if (s.lastPrayedDay) return true
  const hasPositive = (map) =>
    Object.values(map || {}).some((v) => Number.isFinite(v) && v > 0)
  if (s.prayerCompletions && hasPositive(s.prayerCompletions)) return true
  if (s.prayerDayCompletions && Object.values(s.prayerDayCompletions || {}).some(hasPositive)) {
    return true
  }
  if (s.prayerDayStats && Object.values(s.prayerDayStats || {}).some(hasPositive)) return true
  return false
}

// Sum several per-shard summaries into one global picture. Approximate by
// design: a person whose cell changes may be counted on two shards, so
// usersToday/usersWeek are a light upper bound across shards. Usage `counts`
// are simple sums (anonymous counters only).
export function mergeSummaries(list) {
  const out = {
    schema: 1,
    prayers: {},
    spirits: {},
    seconds: 0,
    usersToday: 0,
    usersWeek: 0,
    people: 0,
    updatedAt: 0,
    counts: { connects: 0, messages: 0, presence: 0, sync: 0, starts: 0, errors: 0 }
  }
  for (const s of list || []) {
    for (const [k, v] of Object.entries(s?.prayers || {})) out.prayers[k] = (out.prayers[k] || 0) + v
    for (const [k, v] of Object.entries(s?.spirits || {})) out.spirits[k] = (out.spirits[k] || 0) + v
    out.seconds += s?.seconds || 0
    out.usersToday += s?.usersToday || 0
    out.usersWeek += s?.usersWeek || 0
    out.people += s?.people || 0
    if (s?.updatedAt) out.updatedAt = Math.max(out.updatedAt, s.updatedAt)
    for (const [k, v] of Object.entries(s?.counts || {})) {
      out.counts[k] = (out.counts[k] || 0) + v
    }
  }
  return out
}
