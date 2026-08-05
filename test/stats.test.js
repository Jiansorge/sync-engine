import { describe, it, expect } from 'vitest'
import {
  dayKey,
  activeDayFromStats,
  mergeSummaries,
  sanitizeStats,
  hasLifetimeStats
} from '../src/stats.js'

describe('dayKey', () => {
  it('formats YYYY-MM-DD with zero padding', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('activeDayFromStats', () => {
  it('prefers the most recent of lastPrayedDay / prayerDayCompletions', () => {
    const stats = {
      lastPrayedDay: '2026-01-01',
      prayerDayCompletions: { '2026-01-03': { a: 2 }, '2026-01-02': { b: 1 } }
    }
    expect(activeDayFromStats(stats)).toBe('2026-01-03')
  })

  it('returns null when there is no prayer activity', () => {
    expect(activeDayFromStats({})).toBe(null)
    expect(activeDayFromStats(null)).toBe(null)
  })

  it('ignores empty per-day maps', () => {
    expect(activeDayFromStats({ prayerDayCompletions: { '2026-01-01': {} } })).toBe(null)
  })

  it('rejects malformed or far-future days (usersToday/usersWeek spoof)', () => {
    expect(activeDayFromStats({ lastPrayedDay: '9999-12-31' })).toBe(null)
    expect(activeDayFromStats({ prayerDayCompletions: { '9999-12-31': { a: 1 } } })).toBe(null)
    expect(activeDayFromStats({ lastPrayedDay: 'not-a-date' })).toBe(null)
    expect(activeDayFromStats({ lastPrayedDay: '2026-13-40' })).toBe(null)
  })

  it('accepts today and tomorrow (UTC+14 users are not dropped)', () => {
    const today = dayKey()
    expect(activeDayFromStats({ lastPrayedDay: today })).toBe(today)
    const tomorrow = dayKey(new Date(Date.now() + 86400000))
    expect(activeDayFromStats({ lastPrayedDay: tomorrow })).toBe(tomorrow)
  })
})

describe('mergeSummaries', () => {
  it('sums per-shard aggregates', () => {
    const merged = mergeSummaries([
      {
        prayers: { a: 10, b: 2 },
        spirits: { s1: 8 },
        seconds: 100,
        usersToday: 5,
        usersWeek: 20,
        people: 3,
        counts: { connects: 10, messages: 40, presence: 30, sync: 5, starts: 2 },
        updatedAt: 1000
      },
      {
        prayers: { a: 4, c: 1 },
        spirits: { s2: 3 },
        seconds: 50,
        usersToday: 7,
        usersWeek: 9,
        people: 2,
        counts: { connects: 8, messages: 20, presence: 25, sync: 3, starts: 1 },
        updatedAt: 2000
      }
    ])
    expect(merged.prayers).toEqual({ a: 14, b: 2, c: 1 })
    expect(merged.spirits).toEqual({ s1: 8, s2: 3 })
    expect(merged.seconds).toBe(150)
    expect(merged.usersToday).toBe(12)
    expect(merged.usersWeek).toBe(29)
    expect(merged.people).toBe(5)
    expect(merged.counts).toEqual({ connects: 18, messages: 60, presence: 55, sync: 8, starts: 3, errors: 0 })
    expect(merged.updatedAt).toBe(2000)
  })

  it('handles an empty list', () => {
    expect(mergeSummaries([]).seconds).toBe(0)
  })
})

describe('sanitizeStats', () => {
  it('strips prototype-pollution keys from every level', () => {
    const dirty = {
      __proto__: { pollute: true },
      constructor: { pollute: true },
      prayerCompletions: { 'lords-prayer': 3, __proto__: { x: 1 }, constructor: { y: 2 } },
      prayerDayCompletions: { '2026-01-01': { a: 1, __proto__: { x: 1 } }, __proto__: { z: 1 } },
      localPrayerSeconds: 42,
      bestStreak: 2
    }
    const clean = sanitizeStats(dirty)
    expect(Object.hasOwn(clean, '__proto__')).toBe(false)
    expect(Object.hasOwn(clean, 'constructor')).toBe(false)
    expect(clean.prayerCompletions['lords-prayer']).toBe(3)
    expect(Object.hasOwn(clean.prayerCompletions, '__proto__')).toBe(false)
    expect(clean.prayerDayCompletions['2026-01-01'].a).toBe(1)
    expect(Object.hasOwn(clean.prayerDayCompletions['2026-01-01'], '__proto__')).toBe(false)
    expect(Object.hasOwn(clean.prayerDayCompletions, '__proto__')).toBe(false)
    expect(clean.localPrayerSeconds).toBe(42)
    expect(clean.bestStreak).toBe(2)
  })

  it('returns {} for non-object input', () => {
    expect(sanitizeStats(null)).toEqual({})
    expect(sanitizeStats('x')).toEqual({})
  })

  it('drops non-finite values so mergeStats never persists NaN', () => {
    const dirty = {
      prayerCompletions: { a: 3, bad: 'oops', nested: { x: 1 }, nan: 'not-a-number', ok: 2.5 },
      prayerDayCompletions: { '2026-01-01': { a: 1, bad: [1, 2] }, '2026-01-02': { x: 'str' } },
      prayerDayStats: { '2026-01-01': { b: 0, nope: true } },
      localPrayerSeconds: 42,
      streak: 'nope',
      bestStreak: 7,
      lastPrayedDay: 12345,
      unknownFutureKey: 'should be dropped'
    }
    const clean = sanitizeStats(dirty)
    expect(clean.prayerCompletions).toEqual({ a: 3, ok: 2.5 })
    expect(clean.prayerDayCompletions).toEqual({ '2026-01-01': { a: 1 } })
    expect(clean.prayerDayStats).toEqual({ '2026-01-01': { b: 0 } })
    expect(clean.localPrayerSeconds).toBe(42)
    expect(clean.streak).toBeUndefined()
    expect(clean.bestStreak).toBe(7)
    expect(clean.lastPrayedDay).toBeUndefined()
    expect(clean.unknownFutureKey).toBeUndefined()
  })
})

describe('hasLifetimeStats', () => {
  it('detects any real lifetime data', () => {
    expect(hasLifetimeStats({ localPrayerSeconds: 1 })).toBe(true)
    expect(hasLifetimeStats({ bestStreak: 3 })).toBe(true)
    expect(hasLifetimeStats({ lastPrayedDay: '2026-01-01' })).toBe(true)
    expect(hasLifetimeStats({ prayerCompletions: { a: 1 } })).toBe(true)
    expect(hasLifetimeStats({ prayerDayCompletions: { '2026-01-01': { a: 1 } } })).toBe(true)
  })

  it('returns false for empty/synthetic blobs (safe to prune)', () => {
    expect(hasLifetimeStats({})).toBe(false)
    expect(hasLifetimeStats(null)).toBe(false)
    expect(hasLifetimeStats(undefined)).toBe(false)
    expect(hasLifetimeStats({ localPrayerSeconds: 0, bestStreak: 0 })).toBe(false)
  })
})
