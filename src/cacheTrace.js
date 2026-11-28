// Cache trace: the accesses of the program to the cache in a sequential execution, without time
// (Program.get_cache_trace of RVCAT gives the result of each access). This module rebuilds, for the
// view, the state of the cache after any step, the names of the blocks and the counters.
//
// trace: { blkSize, nBlocks, arrays: [{ name, base, elem_size, bytes }], steps: [{ rep, k, index, oper,
//          array, elem, addr, block, result: hit|cold|capacity, line, victim, dirty }], totals, truncated }
// Step n of the view: the cache after the first n accesses (0: empty, before the first one).

export const isMiss = (step) => step?.result === 'cold' || step?.result === 'capacity'

// The array whose data a block holds (the first one that has an element in it)
function arrayOfBlock(trace, block) {
  const blk = trace.blkSize
  return (trace.arrays ?? []).find(a => a.base < block + blk && a.base + a.bytes > block) ?? null
}

// Name of a block: the elements of the array that it holds, e.g. V[8–15]; short: V1 (the second
// block of V, counting from the block of its first element)
export function blockLabel(trace, block) {
  const a = arrayOfBlock(trace, block)
  if (!a) return { label: String(block), short: String(block), array: null }
  const es = a.elem_size || 1
  const n = Math.max(1, Math.floor(a.bytes / es))
  const first = Math.max(0, Math.ceil((block - a.base) / es))
  const last = Math.min(n - 1, Math.floor((block + trace.blkSize - 1 - a.base) / es))
  const index = Math.floor(block / trace.blkSize) - Math.floor(a.base / trace.blkSize)
  return { label: first === last ? `${a.name}[${first}]` : `${a.name}[${first}–${last}]`, short: `${a.name}${index}`, array: a.name }
}

// The lines of the cache after n steps: [{ line, block, dirty, since, last, rank }] (block null: free;
// rank 1 = the most recently used), and the line that step n used
export function cacheStateAt(trace, n) {
  const lines = Array.from({ length: trace.nBlocks }, (_, line) => ({ line, block: null, dirty: false, since: -1, last: -1 }))
  const steps = trace.steps ?? []
  const upto = Math.min(n, steps.length)
  for (let i = 0; i < upto; i++) {
    const s = steps[i], l = lines[s.line]
    if (!l) continue
    if (s.result !== 'hit') { l.block = s.block; l.dirty = false; l.since = i }
    l.last = i
    if (s.oper === 'STORE') l.dirty = true
  }
  const used = lines.filter(l => l.block !== null).sort((a, b) => b.last - a.last)
  used.forEach((l, i) => { l.rank = i + 1 })
  return lines
}

// Accesses, hits and misses of the first n steps
export function countsUpTo(trace, n) {
  const c = { accesses: 0, hit: 0, cold: 0, capacity: 0 }
  for (const s of (trace.steps ?? []).slice(0, n)) { c.accesses++; c[s.result]++ }
  return c
}

// The step (1-based position n such that step n-1 is a miss) of the next or previous miss
export function nextMiss(trace, n, dir = 1) {
  const steps = trace.steps ?? []
  if (dir > 0) {
    for (let i = n; i < steps.length; i++) if (isMiss(steps[i])) return i + 1
    return null
  }
  for (let i = n - 2; i >= 0; i--) if (isMiss(steps[i])) return i + 1
  return null
}

// State of each block and of each element after n steps, for the memory map:
//   blocks: Map block -> 'in' (in the cache) | 'out' (it was, and it was evicted)   (absent: never)
//   used:   Set of "array:elem" accessed
export function memoryStateAt(trace, n) {
  const inCache = new Set(cacheStateAt(trace, n).filter(l => l.block !== null).map(l => l.block))
  const blocks = new Map(), used = new Set()
  for (const s of (trace.steps ?? []).slice(0, n)) {
    blocks.set(s.block, 'out')
    used.add(`${s.array}:${s.elem}`)
  }
  for (const b of inCache) blocks.set(b, 'in')
  return { blocks, used }
}

// Layout of an array in the memory map: rows of `width` elements, each element with its block
// width: mapWidth of the program, or the elements that the array advances in each call, or 8 blocks
export const MAP_MAX_ELEMENTS = 1024
export function arrayLayout(trace, array, mapWidth = {}, repStrides = {}) {
  const es = array.elem_size || 1
  const count = Math.max(1, Math.floor(array.bytes / es))
  const perBlock = Math.max(1, Math.floor(trace.blkSize / es))
  const width = Number(mapWidth?.[array.name]) > 0 ? Number(mapWidth[array.name])
              : Number(repStrides?.[array.name]) > 1 ? Number(repStrides[array.name])
              : Math.min(count, perBlock * 8)
  if (count > MAP_MAX_ELEMENTS) return { name: array.name, count, tooLarge: true, rows: [] }
  const rows = []
  for (let start = 0; start < count; start += width) {
    const cells = []
    for (let e = start; e < Math.min(count, start + width); e++) {
      const addr = array.base + e * es
      const block = addr - (addr % trace.blkSize)
      cells.push({ elem: e, block, blockStart: e === 0 || (addr % trace.blkSize) < es })
    }
    rows.push({ start, cells })
  }
  return { name: array.name, count, width, perBlock, rows }
}
