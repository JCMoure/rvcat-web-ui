import { describe, expect, it } from 'vitest'
import { blockLabel, longestBlockLabel, cacheStateAt, countsUpTo, nextMiss, memoryStateAt, arrayLayout } from './cacheTrace'

// Base-like trace: V[i] and W[i] (floats), cache of 2 lines of 32 bytes (8 floats), 10 accesses
const step = (k, array, elem, result, line, extra = {}) => {
  const base = array === 'V' ? 0 : 256
  const addr = base + elem * 4
  return { rep: 0, k, index: array === 'V' ? 0 : 2, oper: 'LOAD', array, elem, addr, block: addr - (addr % 32), result, line, victim: null, dirty: false, ...extra }
}
const trace = {
  blkSize: 32, nBlocks: 2,
  arrays: [{ name: 'V', base: 0, elem_size: 4, bytes: 256 }, { name: 'W', base: 256, elem_size: 4, bytes: 256 }],
  steps: [step(0, 'V', 0, 'cold', 0), step(0, 'W', 0, 'cold', 1), step(1, 'V', 1, 'hit', 0), step(1, 'W', 1, 'hit', 1),
          step(8, 'V', 8, 'cold', 0, { victim: 0 }), step(8, 'W', 8, 'cold', 1, { victim: 256 }),
          step(0, 'V', 0, 'capacity', 0, { victim: 32 })],
}

describe('cache trace', () => {
  it('names the blocks with the elements that they hold', () => {
    expect(blockLabel(trace, 32)).toMatchObject({ label: 'V[8–15]', short: 'V1', array: 'V' })
    expect(blockLabel(trace, 256)).toMatchObject({ label: 'W[0–7]', short: 'W0' })
  })

  it('rebuilds the lines of the cache after each step, with the LRU order', () => {
    expect(cacheStateAt(trace, 0).every(l => l.block === null)).toBe(true)
    const after3 = cacheStateAt(trace, 3)
    expect(after3.map(l => l.block)).toEqual([0, 256])
    expect(after3.map(l => l.rank)).toEqual([1, 2])        // V0 used at step 3: the most recent
    expect(cacheStateAt(trace, 6).map(l => l.block)).toEqual([32, 288])
  })

  it('counts the hits and misses up to a step, and finds the misses', () => {
    expect(countsUpTo(trace, 4)).toEqual({ accesses: 4, hit: 2, cold: 2, capacity: 0 })
    expect(countsUpTo(trace, 7).capacity).toBe(1)
    expect(nextMiss(trace, 2)).toBe(5)
    expect(nextMiss(trace, 5, -1)).toBe(2)
    expect(nextMiss(trace, 7)).toBe(null)
  })

  it('tells the blocks in the cache, the evicted ones and the elements read', () => {
    const m = memoryStateAt(trace, 6)
    expect(m.blocks.get(0)).toBe('out')
    expect(m.blocks.get(32)).toBe('in')
    expect(m.blocks.has(64)).toBe(false)
    expect(m.used.has('V:8')).toBe(true)
  })

  it('lays out an array in rows, marking where each block starts', () => {
    const l = arrayLayout(trace, trace.arrays[0], { V: 16 })
    expect(l.rows.length).toBe(4)
    expect(l.rows[0].cells.filter(c => c.blockStart).map(c => c.elem)).toEqual([0, 8])
    expect(arrayLayout(trace, trace.arrays[0], {}, { V: 8 }).width).toBe(8)
  })

  it('aligns an array to the blocks: the positions of its first and last blocks outside it are empty', () => {
    // W starts in the middle of a block (base 16: 4 floats after the start of the block 0)
    const t2 = { ...trace, arrays: [{ name: 'V', base: 0, elem_size: 4, bytes: 16 }, { name: 'W', base: 16, elem_size: 4, bytes: 40 }] }
    const w = arrayLayout(t2, t2.arrays[1], { W: 8 })
    expect(w.lead).toBe(4)
    expect(w.rows[0].cells.slice(0, 5).map(c => c.pad)).toEqual([true, true, true, true, false])
    expect(w.rows[0].cells[4]).toMatchObject({ elem: 0, block: 0 })
    expect(w.rows[1].cells.map(c => c.pad)).toEqual([false, false, false, false, false, false, true, true])
    expect(blockLabel(t2, 0).label).toBe('V[0–3] W[0–3]')
    expect(longestBlockLabel(t2)).toBe('V[0–3] W[0–3]'.length)
    const v = arrayLayout(t2, t2.arrays[0], { V: 8 })
    expect(v.rows[0].cells.map(c => c.pad)).toEqual([false, false, false, false, true, true, true, true])
  })
})
