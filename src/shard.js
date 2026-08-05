// sync-engine — sharding helpers.
// v1 runs a single SyncRoom named 'world'. When scale demands, set NUM_SHARDS > 1
// and the Worker hashes a coarse 1° grid cell onto a shard id (`shard-<i>`); clients opt
// into that by appending `?cell=LLL,LLL` to the socket URL. The wire protocol is
// shard-agnostic, so enabling sharding never changes the app surface.

export function shardCount(env) {
  const n = Number(env && env.NUM_SHARDS)
  return Number.isInteger(n) && n > 0 ? n : 1
}

// FNV-1a — deterministic, cheap, and stable across isolates/redeploys.
export function shardIndex(cell, n) {
  let h = 2166136261
  const s = String(cell || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % n
}

// The DO id name for a cell. n <= 1 keeps the single 'world' shard (v1,
// backward compatible) so adding sharding later is a pure config change.
export function shardName(cell, n) {
  return n <= 1 ? 'world' : `shard-${shardIndex(cell, n)}`
}

export function allShardNames(n) {
  if (n <= 1) return ['world']
  // 'world' is always included: during a live 1→N shard flip the pre-shard
  // all-time totals stay aggregated in /stats instead of vanishing.
  return ['world', ...Array.from({ length: n }, (_, i) => `shard-${i}`)]
}
