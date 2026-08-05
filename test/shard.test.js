import { describe, it, expect } from 'vitest'
import { shardCount, shardIndex, shardName, allShardNames } from '../src/shard.js'

describe('shardCount', () => {
  it('defaults to 1 (single world shard)', () => {
    expect(shardCount({})).toBe(1)
    expect(shardCount({ NUM_SHARDS: 'x' })).toBe(1)
    expect(shardCount({ NUM_SHARDS: 8 })).toBe(8)
  })
})

describe('shardName', () => {
  it('keeps the single "world" shard when n <= 1 (v1, backward compatible)', () => {
    expect(shardName('40,-74', 1)).toBe('world')
    expect(shardName('', 1)).toBe('world')
  })

  it('hashes a cell onto a stable shard when n > 1', () => {
    const a = shardName('40,-74', 8)
    const b = shardName('40,-74', 8)
    expect(a).toBe(b)
    expect(a).toMatch(/^shard-\d+$/)
  })

  it('is deterministic across runs', () => {
    expect(shardIndex('40,-74', 8)).toBe(shardIndex('40,-74', 8))
    expect(shardIndex('40,-74', 8)).toBeGreaterThanOrEqual(0)
    expect(shardIndex('40,-74', 8)).toBeLessThan(8)
  })
})

describe('allShardNames', () => {
  it('lists world when n <= 1', () => {
    expect(allShardNames(1)).toEqual(['world'])
  })
  it('lists world + shard-i for n > 1 (old totals stay aggregated on a flip)', () => {
    expect(allShardNames(3)).toEqual(['world', 'shard-0', 'shard-1', 'shard-2'])
  })
})
