import { describe, it, expect } from 'vitest'
import { mergeStats, gridKey, PROTOCOL_VERSION } from '../src/protocol.js'
// Vite `?raw` imports — inlined as strings so the drift test needs no node:fs
// (these tests run in the Workers runtime pool).
import engineProtocolRaw from '../src/protocol.js?raw'
import prayerEarthProtocolRaw from '../../prayer-earth/src/sync/protocol.js?raw'

describe('protocol.mergeStats', () => {
  it('is idempotent under replay', () => {
    const base = { prayerCompletions: { a: 2 }, localPrayerSeconds: 10, bestStreak: 3 }
    const inc = {
      prayerCompletions: { a: 5, b: 1 },
      prayerDayCompletions: { '2026-01-01': { a: 4 } },
      prayerDayStats: { '2026-01-01': { b: 2 } },
      localPrayerSeconds: 20,
      streak: 2,
      bestStreak: 5,
      lastPrayedDay: '2026-01-01'
    }
    const once = mergeStats(base, inc)
    const twice = mergeStats(once, inc)
    expect(twice).toEqual(once)
  })

  it('takes the max of each counter, never the sum', () => {
    const base = { prayerCompletions: { a: 7 }, localPrayerSeconds: 100, bestStreak: 9 }
    const inc = { prayerCompletions: { a: 3 }, localPrayerSeconds: 50, bestStreak: 4 }
    const out = mergeStats(base, inc)
    expect(out.prayerCompletions.a).toBe(7)
    expect(out.localPrayerSeconds).toBe(100)
    expect(out.bestStreak).toBe(9)
  })

  it('handles an empty base', () => {
    const out = mergeStats({}, { prayerCompletions: { a: 1 }, localPrayerSeconds: 5 })
    expect(out.prayerCompletions.a).toBe(1)
    expect(out.localPrayerSeconds).toBe(5)
  })

  it('keeps the latest lastPrayedDay', () => {
    const base = { lastPrayedDay: '2026-01-01' }
    const out = mergeStats(base, { lastPrayedDay: '2026-01-05' })
    expect(out.lastPrayedDay).toBe('2026-01-05')
  })
})

describe('protocol.gridKey', () => {
  it('rounds onto the coarse 1° grid and clamps latitude', () => {
    expect(gridKey(40.7, -74.0)).toBe('41,-74')
    expect(gridKey(0, 0)).toBe('0,0')
    expect(gridKey(90, 0)).toBe('72,0')
    expect(gridKey(-90, 0)).toBe('-60,0')
    // Matches the app's shared grid logic: a lon that rounds onto/over 180
    // wraps to -180 (the date line).
    expect(gridKey(0, 178)).toBe('0,178')
    expect(gridKey(0, 179)).toBe('0,179')
    expect(gridKey(0, 180)).toBe('0,-180')
  })
})

describe('protocol drift', () => {
  it('engine copy is byte-identical to the prayer-earth copy', () => {
    expect(engineProtocolRaw).toBe(prayerEarthProtocolRaw)
  })

  it('bumps PROTOCOL_VERSION on any shape change', () => {
    // Intentional guardrail: if you change the wire contract, bump this number.
    expect(PROTOCOL_VERSION).toBe(3)
  })
})
