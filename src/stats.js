// sync-engine — pure aggregate/date helpers shared by the DO, the coordinator,
// and the vitest suite. No runtime dependencies so they run anywhere.

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

// A valid active day: YYYY-MM-DD and not beyond tomorrow. Anything else is
// malformed or a far-future spoof (e.g. '9999-12-31' would otherwise never be
// pruned and would inflate usersToday/usersWeek forever). We allow up to +1 day
// so legit UTC+14 users are never dropped.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const maxValidDay = () => dayKey(new Date(Date.now() + 86400000))

// The last day a synced device actually prayed, derived from the anonymous
// lifetime stats. Returns a `YYYY-MM-DD` string or null.
export function activeDayFromStats(stats) {
  const maxDay = maxValidDay()
  const okDay = (d) => typeof d === 'string' && DAY_RE.test(d) && d <= maxDay
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
const finiteNum = (v) => typeof v === 'number' && Number.isFinite(v)
const cleanMap = (map) => {
  const out = {}
  for (const [k, v] of Object.entries(map || {})) {
    if (DANGEROUS.has(k)) continue
    if (!finiteNum(v)) continue
    out[k] = v
  }
  return out
}
const cleanDayMap = (map) => {
  const out = {}
  for (const [d, m] of Object.entries(map || {})) {
    if (DANGEROUS.has(d)) continue
    const cleaned = cleanMap(m)
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
      if (finiteNum(v)) out[k] = v
    } else if (k === 'lastPrayedDay') {
      if (typeof v === 'string') out[k] = v
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
  if (s.prayerCompletions && Object.keys(s.prayerCompletions).length) return true
  if (s.prayerDayCompletions && Object.keys(s.prayerDayCompletions).length) return true
  if (s.prayerDayStats && Object.keys(s.prayerDayStats).length) return true
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
