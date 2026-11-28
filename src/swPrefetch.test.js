import { describe, expect, it } from 'vitest'
import { validateProgram, instructionTiming, unassignedOperations, charToProcessingState } from './common'
import { instructionSummary } from './instructionSummary'

const load = { text: 't = A[b+h]', type: 'MEM', oper: 'LOAD', size: 'word', destin: 't', source1: 'b',
               source2: 'A', source3: 'h', constant: '', stride: 0, lanes: 1, access: 'search' }
const prefetch = (ahead, path, extra = {}) => ({ text: 'prefetch A[b+h/2]', type: 'MEM', oper: 'PREFETCH', size: 'word',
  destin: '', source1: 'b', source2: 'A', source3: 'h', constant: '', stride: 0, lanes: 1, access: 'search', ahead, path, ...extra })
const program = (...memory) => ({
  name: 'BSEARCH', N: 16,
  instruction_list: [
    { text: 'h = n >> 1', type: 'INT', oper: 'SHIFT', size: 'word', destin: 'h', source1: 'n', source2: '', source3: '', constant: '1' },
    ...memory,
    { text: 'if c go back', type: 'BRANCH', oper: '', size: '', destin: '', source1: 'c', source2: '', source3: '', constant: '', stride: 1 },
  ],
})

describe('software prefetch and binary search', () => {
  it('accepts a search with its prefetches', () => {
    expect(validateProgram(program(prefetch(1, 'L'), prefetch(2, 'RL'), load))).toEqual([])
  })

  it('checks the fields of the search and of the prefetches', () => {
    const errors = validateProgram(program(
      { ...load, access: 'random' },
      prefetch(0, ''),
      prefetch(2, 'LX'),
      prefetch(1, 'L', { destin: 't' }),
      { ...load, type: 'VMEM', lanes: 4 },
    ))
    expect(errors.some(e => e.includes('access must be empty or "search"'))).toBe(true)
    expect(errors.some(e => e.includes('ahead of a PREFETCH of a search must be an integer between 1 and 4'))).toBe(true)
    expect(errors.some(e => e.includes('path of a PREFETCH of a search must have 2 letters L or R'))).toBe(true)
    expect(errors.some(e => e.includes('a PREFETCH has no destination'))).toBe(true)
    expect(errors.some(e => e.includes('only a scalar memory instruction (MEM) can have the access "search"'))).toBe(true)
  })

  it('executes a PREFETCH in the ports of the LOAD, with its latency', () => {
    expect(instructionTiming({ type: 'MEM', oper: 'PREFETCH', size: 'word' }, { 'MEM.LOAD': 5 }, { 'MEM.LOAD': 12 }))
      .toEqual({ latency: 5, ports: 12 })
  })

  it('does not ask for PREFETCH among the operations of the ports', () => {
    expect(unassignedOperations({ 0: ['MEM.LOAD', 'MEM.STORE'] })).not.toContain('MEM.PREFETCH')
  })

  it('describes a PREFETCH', () => {
    expect(charToProcessingState('E', 2, 64, 'Prefetch of')).toBe('Prefetch addr 64 on P2')
    expect(instructionSummary([prefetch(1, 'R')], 0)).toContain('software prefetch')
    expect(instructionSummary([prefetch(1, 'R')], 0)).toContain('right')
    expect(instructionSummary([load], 0)).toContain('binary search')
  })
})
