<script setup>
  // Panel Cache: the accesses of the program to the cache in a sequential execution, without time
  // (only the LOADs and STOREs, in program order). Step by step: the memory map (the blocks of each
  // array: in the cache, evicted, never used), the lines of the cache with the LRU order, the table
  // of the accesses (address, block, hit or miss), an optional grid (lines × steps), a prediction
  // mode (the student says hit or miss before each access) and the totals of the whole program.
  import { t } from '@/i18n'
  import { ref, reactive, computed, watch, inject, onMounted, onUnmounted, nextTick, toRaw } from 'vue'
  import HelpComponent from '@/components/helpComponent.vue'
  import { useRVCAT_Api } from '@/rvcatAPI'
  import { getLogicalElementCount } from '@/common'
  import { blockLabel, cacheStateAt, countsUpTo, nextMiss, memoryStateAt, arrayLayout, isMiss } from '@/cacheTrace'

  const simState = inject('simulationState')
  const { registerHandler, isReady } = inject('worker')
  const { getCacheTrace } = useRVCAT_Api()

  const trace = ref(null)
  const error = ref('')
  const loading = ref(false)
  const step = ref(0)                 // accesses done: the cache after them
  const opts = reactive({ hex: false, grid: false, predict: false, speed: 4 })
  try { Object.assign(opts, JSON.parse(localStorage.getItem('cacheTraceOptions') ?? '{}')) } catch { /* defaults */ }
  opts.predict = false
  watch(opts, () => { try { localStorage.setItem('cacheTraceOptions', JSON.stringify({ hex: opts.hex, grid: opts.grid, speed: opts.speed })) } catch { /* ignore */ } })

  const proc = computed(() => simState.simulatedProcess ?? {})
  const hasCache = computed(() => (Number(proc.value.nBlocks) || 0) > 0)
  const steps = computed(() => trace.value?.steps ?? [])
  const total = computed(() => steps.value.length)

  // ---- request -------------------------------------------------------------------------------
  const signature = computed(() => JSON.stringify({
    list: proc.value.instruction_list, iters: proc.value.iters, rep: proc.value.rep, repStrides: proc.value.repStrides,
    epilogue: proc.value.epilogue, nBlocks: proc.value.nBlocks, blkSize: proc.value.blkSize }))
  let timer = null, requested = ''
  function request() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!isReady.value || !hasCache.value || !Array.isArray(proc.value.instruction_list)) return
      const p = proc.value
      const N = getLogicalElementCount(p.instruction_list, p.iters)
      requested = signature.value
      loading.value = true
      getCacheTrace(JSON.stringify({ instruction_list: toRaw(p.instruction_list), rep: p.rep ?? 1,
                                     repStrides: toRaw(p.repStrides ?? {}), epilogue: toRaw(p.epilogue ?? []) }),
                    N, Number(p.nBlocks), Number(p.blkSize)).catch(() => { loading.value = false })
    }, 150)
  }
  function handleTrace(data, dataType) {
    loading.value = false
    if (dataType === 'error') { error.value = String(data).split('\n').filter(Boolean).pop() ?? String(data); trace.value = null; return }
    try {
      trace.value = JSON.parse(data)
      error.value = ''
      step.value = 0
      prediction.right = 0; prediction.total = 0; prediction.last = null
      simState.cacheTraceReady = (simState.cacheTraceReady ?? 0) + 1
      applyRequest()
    } catch (e) { error.value = String(e) }
  }
  watch(signature, () => { if (signature.value !== requested) request() })
  watch(isReady, (r) => { if (r) request() })

  // ---- requests of the tutorial cards (action cacheTrace) -----------------------------------------
  function applyRequest() {
    const r = simState.cacheTraceRequest
    if (!r || !trace.value) return
    if (r.predict !== undefined) setPredict(r.predict)
    if (r.grid !== undefined) opts.grid = r.grid
    if (r.step !== undefined) go(r.step === 'end' ? total.value : Number(r.step) || 0)
    simState.cacheTraceRequest = null
  }
  watch(() => simState.cacheTraceRequest, applyRequest, { deep: true })

  // ---- navigation -----------------------------------------------------------------------------
  const playing = ref(false)
  let playTimer = null
  function go(n) { step.value = Math.max(0, Math.min(total.value, Math.round(n))) }
  function stepBy(d) { if (opts.predict && d > 0) return; stop(); go(step.value + d) }
  function toMiss(dir) { stop(); const n = nextMiss(trace.value ?? {}, step.value, dir); if (n !== null) go(n) }
  function stop() { playing.value = false; clearInterval(playTimer) }
  function play() {
    if (playing.value) return stop()
    if (step.value >= total.value) go(0)
    playing.value = true
    playTimer = setInterval(() => { if (step.value >= total.value) stop(); else go(step.value + 1) }, 1000 / opts.speed)
  }
  watch(() => opts.speed, () => { if (playing.value) { stop(); play() } })

  // ---- prediction ----------------------------------------------------------------------------
  const prediction = reactive({ right: 0, total: 0, last: null })
  function setPredict(on) { stop(); opts.predict = !!on; prediction.right = 0; prediction.total = 0; prediction.last = null }
  function predict(miss) {
    const s = steps.value[step.value]
    if (!s) return
    const ok = isMiss(s) === miss
    prediction.total++
    if (ok) prediction.right++
    prediction.last = { ok, miss }
    go(step.value + 1)
  }

  // the keys of the prediction: the initials of hit and miss in the language of the interface
  const hitKey  = computed(() => t('key: hit'))
  const missKey = computed(() => t('key: miss'))
  function onKey(e) {
    if (!trace.value || e.target?.closest?.('input, select, textarea, [contenteditable]')) return
    if (!document.getElementById('cache-trace-root')) return
    const k = e.key
    const key = k.length === 1 ? k.toUpperCase() : k
    if (opts.predict && (key === hitKey.value || key === 'H' || key === 'A')) { predict(false); e.preventDefault() }
    else if (opts.predict && (key === missKey.value || key === 'M' || key === 'F')) { predict(true); e.preventDefault() }
    else if (k === 'ArrowRight') { stepBy(1); e.preventDefault() }
    else if (k === 'ArrowLeft') { stepBy(-1); e.preventDefault() }
  }

  // ---- what is shown ---------------------------------------------------------------------------
  const current = computed(() => (step.value > 0 ? steps.value[step.value - 1] : null))   // the last access done
  const lines = computed(() => (trace.value ? cacheStateAt(trace.value, step.value) : []))
  const mem = computed(() => (trace.value ? memoryStateAt(trace.value, step.value) : { blocks: new Map(), used: new Set() }))
  const sofar = computed(() => (trace.value ? countsUpTo(trace.value, step.value) : { accesses: 0, hit: 0, cold: 0, capacity: 0 }))
  const label = (block) => (trace.value ? blockLabel(trace.value, block) : { label: '', short: '' })
  const addr = (a) => (opts.hex ? '0x' + Number(a).toString(16).toUpperCase() : String(a))

  const instrText = (index) => {
    const p = proc.value, n = p.instruction_list?.length ?? 0
    const inst = index < n ? p.instruction_list?.[index] : p.epilogue?.[index - n]
    return inst?.text ?? `#${index}`
  }
  const resultText = (r) => (r === 'hit' ? t('hit') : r === 'cold' ? t('cold miss') : t('capacity miss'))
  const elemText = (s) => `${s.array}[${s.elem}]`

  // the explanation of the last access
  const message = computed(() => {
    const s = current.value
    if (!s) return t('The cache is empty. Step forward (▶ or →) to execute the first access.')
    const where = t('{e} (address {a}) is in the block {b} ({blk}).', { e: elemText(s), a: addr(s.addr), b: addr(s.block), blk: label(s.block).label })
    if (s.result === 'hit') return `${where} ${t('The block is in line L{l}: hit.', { l: s.line })}`
    const why = s.result === 'cold' ? t('The block was never in the cache: cold miss.')
                                    : t('The block was in the cache, but it was evicted: capacity miss.')
    const into = s.victim === null ? t('It goes into line L{l}, which was free.', { l: s.line })
               : t('It goes into line L{l}, replacing {v}, the least recently used{d}.', { l: s.line, v: label(s.victim).label, d: s.dirty ? t(' (modified: it is written back to memory)') : '' })
    return `${where} ${why} ${into}`
  })

  // memory map
  const layouts = computed(() => (trace.value ? trace.value.arrays.map(a => arrayLayout(trace.value, a, proc.value.mapWidth, proc.value.repStrides)) : []))
  function cellClass(name, cell) {
    const st = mem.value.blocks.get(cell.block)
    const s = current.value
    return {
      'ct-in': st === 'in', 'ct-out': st === 'out', 'ct-used': mem.value.used.has(`${name}:${cell.elem}`),
      'ct-now': !!s && s.array === name && s.elem === cell.elem,
      'ct-nowblock': !!s && s.block === cell.block && !(s.array === name && s.elem === cell.elem),
      'ct-bstart': cell.blockStart,
    }
  }

  // table: a window of rows around the current step
  const ROWS = 15
  const windowStart = computed(() => Math.max(0, Math.min(total.value - ROWS, step.value - 6)))
  const tableRows = computed(() => steps.value.slice(windowStart.value, windowStart.value + ROWS).map((s, j) => ({ s, i: windowStart.value + j })))
  function onTableWheel(e) { if (opts.predict && e.deltaY > 0) return; stop(); go(step.value + (e.deltaY > 0 ? 1 : -1)) }

  // grid: lines × the last steps
  const GRID = 16
  const gridOk = computed(() => (trace.value?.nBlocks ?? 0) <= 16)
  const gridCols = computed(() => {
    if (!trace.value || !opts.grid || !gridOk.value) return []
    const end = Math.max(step.value, Math.min(total.value, GRID)), start = Math.max(0, end - GRID)
    const cols = []
    for (let n = start + 1; n <= end; n++) {
      const st = cacheStateAt(trace.value, n), s = steps.value[n - 1]
      cols.push({ n, s, lines: st.map(l => (l.block === null ? '' : label(l.block).short)), future: n > step.value })
    }
    return cols
  })

  // totals of the whole program, per instruction
  const perInstruction = computed(() => Object.entries(trace.value?.totals?.per_instruction ?? {})
    .map(([index, c]) => ({ index: Number(index), text: instrText(Number(index)), ...c }))
    .sort((a, b) => a.index - b.index))
  const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + ' %' : '—')

  // highlight of the instruction in the Program panel while the pointer is on a row
  function hoverRow(s) { simState.instrHighlightedIdx = s ? s.index : -1 }

  // help
  const showHelp = ref(false)
  const helpPosition = ref({ top: '0%', left: '0%' })

  let cleanup = null
  onMounted(() => {
    cleanup = registerHandler('get_cache_trace', handleTrace)
    window.addEventListener('keydown', onKey)
    nextTick(request)
  })
  onUnmounted(() => {
    cleanup?.(); stop(); clearTimeout(timer)
    window.removeEventListener('keydown', onKey)
    simState.instrHighlightedIdx = -1
  })
</script>

<template>
  <div class="main ct-main" id="cache-trace-root">
    <div class="header">
      <div class="section-title-and-info">
        <span class="info-icon" @click="showHelp = true" :title="t('Show Help')"><img src="/img/info.png" class="info-img"></span>
        <span class="header-title">{{ t('Cache trace') }}: <strong>{{ proc.name }}</strong>
          <template v-if="hasCache"> · {{ Number(proc.nBlocks) === 1 ? t('1 line of {b} bytes', { b: proc.blkSize }) : t('{n} lines of {b} bytes', { n: proc.nBlocks, b: proc.blkSize }) }}</template></span>
      </div>
      <div class="ct-options">
        <label :title="t('Before each access, say whether it will hit or miss')"><input type="checkbox" id="ct-predict" :checked="opts.predict" @change="setPredict($event.target.checked)"> {{ t('Predict') }}</label>
        <label v-if="gridOk" :title="t('The lines of the cache in the last steps (a column per access)')"><input type="checkbox" id="ct-grid" v-model="opts.grid"> {{ t('Grid') }}</label>
        <label :title="t('Addresses in hexadecimal')"><input type="checkbox" id="ct-hex" v-model="opts.hex"> hex</label>
      </div>
    </div>
    <p class="ct-subtitle">{{ t('Sequential execution, without time: only the LOADs and STOREs, in program order. The cache is fully associative with LRU replacement.') }}</p>

    <div v-if="!hasCache" class="ct-note" id="ct-no-cache">{{ t('The processor has no cache: give it lines in the Memory box of the Processor panel.') }}</div>
    <div v-else-if="error" class="ct-note ct-error">{{ error }}</div>
    <div v-else-if="!trace" class="ct-note">{{ loading ? t('Computing the accesses…') : '' }}</div>

    <template v-else>
      <!-- controls -->
      <div class="ct-controls" id="ct-controls">
        <button id="ct-first" @click="stop(); go(0)" :title="t('Back to the start (empty cache)')">⏮</button>
        <button id="ct-prev-miss" @click="toMiss(-1)" :disabled="opts.predict" :title="t('Previous miss')">◀F</button>
        <button id="ct-prev" @click="stepBy(-1)" :title="t('Previous access (←)')">◀</button>
        <template v-if="!opts.predict">
          <button id="ct-next" @click="stepBy(1)" :title="t('Next access (→)')">▶</button>
          <button id="ct-next-miss" @click="toMiss(1)" :title="t('Next miss')">F▶</button>
          <button id="ct-last" @click="stop(); go(total)" :title="t('To the end')">⏭</button>
          <button id="ct-play" class="ct-play" @click="play" :title="t('Play the accesses')">{{ playing ? '⏸' : '▶▶' }}</button>
          <select v-model.number="opts.speed" :title="t('Accesses per second')"><option v-for="v in [1, 2, 4, 8, 16]" :key="v" :value="v">{{ v }}/s</option></select>
        </template>
        <template v-else>
          <span class="ct-ask">{{ t('Next access:') }} <b v-if="steps[step]">{{ elemText(steps[step]) }}</b></span>
          <button id="ct-predict-hit" class="ct-hitbtn" :disabled="step >= total" @click="predict(false)" :title="t('Key {k}', { k: hitKey })">{{ t('Hit') }} ({{ hitKey }})</button>
          <button id="ct-predict-miss" class="ct-missbtn" :disabled="step >= total" @click="predict(true)" :title="t('Key {k}', { k: missKey })">{{ t('Miss') }} ({{ missKey }})</button>
          <span class="ct-score" id="ct-score">{{ t('Right predictions: {r} of {n}', { r: prediction.right, n: prediction.total }) }}
            <span v-if="prediction.last" :class="prediction.last.ok ? 'ct-ok' : 'ct-ko'">{{ prediction.last.ok ? '✓' : '✗' }}</span></span>
        </template>
        <input type="range" class="ct-range" min="0" :max="total" :value="step" :disabled="opts.predict" @input="stop(); go(Number($event.target.value))">
        <span class="ct-pos" id="ct-step">{{ t('Access {n} of {t}', { n: step, t: total }) }}</span>
      </div>
      <div class="ct-message" id="ct-message" :class="current ? 'ct-msg-' + current.result : ''">{{ message }}</div>

      <div class="ct-top">
        <!-- memory map -->
        <div class="ct-map" id="ct-map">
          <div class="ct-legend">
            <span><i class="ct-sw"></i>{{ t('never in the cache') }}</span>
            <span><i class="ct-sw ct-in"></i>{{ t('in the cache') }}</span>
            <span><i class="ct-sw ct-out"></i>{{ t('evicted') }}</span>
            <span><i class="ct-sw ct-now"></i>{{ t('element accessed') }}</span>
            <span>│ {{ t('start of a block') }}</span>
          </div>
          <div v-for="lay in layouts" :key="lay.name" class="ct-array">
            <div class="ct-array-name">{{ lay.name }} <span class="ct-dim">({{ t('{n} elements', { n: lay.count }) }})</span></div>
            <div v-if="lay.tooLarge" class="ct-dim">{{ t('too large to draw') }}</div>
            <div v-for="row in lay.rows" :key="row.start" class="ct-row">
              <span class="ct-rowlabel">{{ row.start }}</span>
              <span v-for="c in row.cells" :key="c.elem" class="ct-cell" :class="cellClass(lay.name, c)"
                    :title="`${lay.name}[${c.elem}] · ${t('block')} ${addr(c.block)} (${label(c.block).label})`"></span>
            </div>
          </div>
        </div>

        <!-- lines of the cache -->
        <div class="ct-cache" id="ct-cache">
          <table>
            <thead><tr><th>{{ t('Line') }}</th><th>{{ t('Block') }}</th><th :title="t('Order of use: 1 = the most recently used')">LRU</th><th :title="t('Modified (dirty)')">M</th></tr></thead>
            <tbody>
              <tr v-for="l in lines" :key="l.line" :id="'ct-line-' + l.line"
                  :class="{ 'ct-line-now': current && current.line === l.line, ['ct-line-' + (current?.result ?? '')]: current && current.line === l.line }">
                <td>L{{ l.line }}</td>
                <td>{{ l.block === null ? '—' : label(l.block).label }}<span v-if="l.block !== null" class="ct-dim"> · {{ addr(l.block) }}</span></td>
                <td>{{ l.rank ?? '' }}</td>
                <td>{{ l.dirty ? 'M' : '' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="current && current.victim !== null" class="ct-victim">{{ t('Evicted: {v}', { v: label(current.victim).label }) }}<span v-if="current.dirty"> ({{ t('written back') }})</span></div>
          <div class="ct-sofar" id="ct-sofar">{{ t('So far: {h} hits, {c} cold misses, {p} capacity misses', { h: sofar.hit, c: sofar.cold, p: sofar.capacity }) }}</div>
        </div>
      </div>

      <!-- grid: lines × steps -->
      <div v-if="opts.grid && gridOk" class="ct-grid" id="ct-grid">
        <table>
          <thead><tr><th>{{ t('Access') }}</th><th v-for="c in gridCols" :key="c.n" :class="{ 'ct-g-now': c.n === step, 'ct-future': c.future }">{{ c.n }}</th></tr>
            <tr><th></th><th v-for="c in gridCols" :key="'e' + c.n" :class="{ 'ct-future': c.future }" class="ct-g-elem">{{ elemText(c.s) }}</th></tr></thead>
          <tbody>
            <tr v-for="(l, li) in lines" :key="li"><th>L{{ li }}</th>
              <td v-for="c in gridCols" :key="c.n" :class="{ 'ct-g-new': !c.future && c.s.line === li && c.s.result !== 'hit', 'ct-g-hit': !c.future && c.s.line === li && c.s.result === 'hit', 'ct-g-now': c.n === step, 'ct-future': c.future }">{{ c.future ? '' : c.lines[li] }}</td></tr>
            <tr><th>{{ t('Result') }}</th><td v-for="c in gridCols" :key="'r' + c.n" :class="{ 'ct-future': c.future }">{{ c.future ? '' : (c.s.result === 'hit' ? hitKey : missKey) }}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- accesses -->
      <div class="ct-table" id="ct-table" @wheel.prevent="onTableWheel">
        <table>
          <thead><tr><th>#</th><th>{{ t('Call') }}</th><th>{{ t('It.') }}</th><th>{{ t('Instruction') }}</th><th>{{ t('Element') }}</th>
            <th>{{ t('Address') }}</th><th>{{ t('Block') }}</th><th>{{ t('Result') }}</th><th>{{ t('Line') }}</th><th>{{ t('Evicted') }}</th></tr></thead>
          <tbody>
            <tr v-for="r in tableRows" :key="r.i" :class="{ 'ct-row-now': r.i === step - 1, 'ct-future': r.i >= step }"
                @click="!opts.predict && (stop(), go(r.i + 1))" @mouseenter="hoverRow(r.s)" @mouseleave="hoverRow(null)">
              <td>{{ r.i + 1 }}</td><td>{{ r.s.rep }}</td><td>{{ r.s.k }}</td><td class="ct-instr">{{ instrText(r.s.index) }}</td>
              <td>{{ elemText(r.s) }}</td><td>{{ addr(r.s.addr) }}</td><td>{{ addr(r.s.block) }}</td>
              <td :class="r.i < step ? 'ct-res-' + r.s.result : ''">{{ r.i < step ? resultText(r.s.result) : '·' }}</td>
              <td>{{ r.i < step ? 'L' + r.s.line : '' }}</td>
              <td>{{ r.i < step && r.s.victim !== null ? label(r.s.victim).label : '' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="ct-dim ct-tablehint">{{ t('Click a row to go to that access; the wheel moves one access.') }}</div>
      </div>

      <!-- totals -->
      <div class="ct-summary" id="ct-summary">
        <div class="ct-summary-title">{{ t('Whole program') }}<span v-if="trace.truncated" class="ct-dim"> · {{ t('only the first {n} accesses are shown step by step', { n: total }) }}</span></div>
        <div class="ct-totals">
          <span>{{ t('Accesses') }}: <b id="ct-total-accesses">{{ trace.totals.accesses }}</b></span>
          <span>{{ t('Hits') }}: <b id="ct-total-hits">{{ trace.totals.hit }}</b></span>
          <span>{{ t('Cold misses') }}: <b id="ct-total-cold">{{ trace.totals.cold }}</b></span>
          <span>{{ t('Capacity misses') }}: <b id="ct-total-capacity">{{ trace.totals.capacity }}</b></span>
          <span>{{ t('Miss rate') }}: <b id="ct-miss-rate">{{ pct(trace.totals.cold + trace.totals.capacity, trace.totals.accesses) }}</b></span>
          <span :title="t('Modified blocks evicted (the ones left in the cache at the end are not counted)')">{{ t('Blocks written back') }}: <b id="ct-total-writebacks">{{ trace.totals.writebacks }}</b></span>
        </div>
        <table class="ct-per">
          <thead><tr><th>{{ t('Instruction') }}</th><th>{{ t('Accesses') }}</th><th>{{ t('Hits') }}</th><th>{{ t('Cold misses') }}</th><th>{{ t('Capacity misses') }}</th><th>{{ t('Miss rate') }}</th></tr></thead>
          <tbody><tr v-for="p in perInstruction" :key="p.index" :id="'ct-instr-' + p.index">
            <td class="ct-instr">{{ p.text }}</td><td>{{ p.accesses }}</td><td>{{ p.hit }}</td><td>{{ p.cold }}</td><td>{{ p.capacity }}</td><td>{{ pct(p.cold + p.capacity, p.accesses) }}</td></tr></tbody>
        </table>
      </div>
    </template>
  </div>

  <Teleport to="body">
    <HelpComponent v-if="showHelp" :position="helpPosition" :text="t('help.cacheTrace')" :title="t('Cache trace')" @close="showHelp = false"/>
  </Teleport>
</template>

<style scoped>
  .ct-main { overflow-y: auto; padding-bottom: 16px; }
  .header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .ct-options { display: flex; gap: 14px; font-size: 0.9em; }
  .ct-options label { cursor: pointer; white-space: nowrap; }
  .ct-subtitle { margin: 2px 0 8px; color: #555; font-size: 0.88em; }
  .ct-note { padding: 14px; border: 1px dashed #bbb; border-radius: 6px; color: #555; }
  .ct-error { color: #c62828; }
  .ct-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  .ct-controls button { min-width: 34px; padding: 3px 8px; border: 1px solid #90a4ae; border-radius: 5px; background: #fff; cursor: pointer; font-size: 0.95em; }
  .ct-controls button:hover:not(:disabled) { background: #e3f2fd; }
  .ct-controls button:disabled { opacity: 0.4; cursor: default; }
  .ct-play { font-weight: 700; }
  .ct-range { flex: 1; min-width: 120px; }
  .ct-pos { font-size: 0.88em; color: #444; white-space: nowrap; }
  .ct-hitbtn { border-color: #2e7d32 !important; color: #2e7d32; font-weight: 600; }
  .ct-missbtn { border-color: #c62828 !important; color: #c62828; font-weight: 600; }
  .ct-score { font-size: 0.88em; }
  .ct-ok { color: #2e7d32; font-weight: 700; } .ct-ko { color: #c62828; font-weight: 700; }
  .ct-message { padding: 6px 10px; border-left: 4px solid #90a4ae; background: #f5f7f8; border-radius: 4px; margin-bottom: 8px; min-height: 1.4em; }
  .ct-msg-hit { border-left-color: #2e7d32; background: #eef7ee; }
  .ct-msg-cold { border-left-color: #1565c0; background: #eaf2fb; }
  .ct-msg-capacity { border-left-color: #c62828; background: #fcefee; }
  .ct-top { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
  .ct-map { flex: 1 1 360px; min-width: 0; }
  .ct-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 0.8em; color: #555; margin-bottom: 4px; }
  .ct-sw { display: inline-block; width: 11px; height: 11px; border: 1px solid #bbb; background: #eceff1; margin-right: 3px; vertical-align: -1px; }
  .ct-array { margin-bottom: 6px; }
  .ct-array-name { font-weight: 700; font-size: 0.9em; }
  .ct-row { display: flex; align-items: center; line-height: 0; margin: 1px 0; }
  .ct-rowlabel { width: 32px; font-size: 0.7em; color: #888; text-align: right; padding-right: 4px; line-height: 1; }
  .ct-cell { display: inline-block; width: 13px; height: 13px; border: 1px solid #fff; background: #eceff1; box-sizing: border-box; }
  .ct-cell.ct-bstart { border-left: 2px solid #455a64; }
  .ct-in { background: #a5d6a7 !important; }
  .ct-out { background: #f4c7c3 !important; }
  .ct-cell.ct-used::after { content: ''; display: block; width: 3px; height: 3px; margin: 4px; border-radius: 50%; background: #37474f; }
  .ct-now { outline: 2px solid #ff6f00; outline-offset: -1px; background: #ffcc80 !important; }
  .ct-sw.ct-now { outline-offset: 0; }
  .ct-nowblock { box-shadow: inset 0 0 0 1px #ff6f00; }
  .ct-cache { flex: 0 0 auto; min-width: 250px; font-size: 0.88em; }
  .ct-cache table, .ct-table table, .ct-grid table, .ct-per { border-collapse: collapse; }
  .ct-cache th, .ct-cache td { border: 1px solid #ddd; padding: 2px 6px; text-align: left; }
  .ct-cache th { background: #eceff1; }
  .ct-line-now.ct-line-hit td { background: #c8e6c9; }
  .ct-line-now.ct-line-cold td { background: #bbdefb; }
  .ct-line-now.ct-line-capacity td { background: #ffcdd2; }
  .ct-victim { margin-top: 4px; color: #c62828; }
  .ct-sofar { margin-top: 4px; color: #444; }
  .ct-dim { color: #888; font-weight: normal; }
  .ct-grid { margin: 10px 0; overflow-x: auto; font-size: 0.8em; }
  .ct-grid th, .ct-grid td { border: 1px solid #ddd; padding: 1px 4px; text-align: center; min-width: 30px; }
  .ct-grid thead th { background: #eceff1; }
  .ct-g-elem { font-weight: normal; }
  .ct-g-new { background: #bbdefb; font-weight: 700; }
  .ct-g-hit { background: #c8e6c9; }
  .ct-g-now { outline: 2px solid #ff6f00; outline-offset: -2px; }
  .ct-table { margin-top: 10px; font-size: 0.85em; overflow-x: auto; }
  .ct-table th, .ct-table td { border-bottom: 1px solid #eee; padding: 2px 6px; text-align: left; white-space: nowrap; }
  .ct-table thead th { background: #eceff1; position: sticky; top: 0; }
  .ct-table tbody tr { cursor: pointer; }
  .ct-row-now td { background: #fff3e0; font-weight: 600; }
  .ct-future td { color: #aaa; }
  .ct-instr { font-family: monospace; }
  .ct-res-hit { color: #2e7d32; } .ct-res-cold { color: #1565c0; font-weight: 600; } .ct-res-capacity { color: #c62828; font-weight: 600; }
  .ct-tablehint { font-size: 0.85em; margin-top: 2px; }
  .ct-summary { margin-top: 12px; padding: 8px 10px; border: 1px solid #cfd8dc; border-radius: 6px; background: #fafafa; }
  .ct-summary-title { font-weight: 700; margin-bottom: 4px; }
  .ct-totals { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 6px; }
  .ct-per { font-size: 0.85em; }
  .ct-per th, .ct-per td { border-bottom: 1px solid #eee; padding: 2px 8px; text-align: left; }
  .ct-ask { font-size: 0.9em; }
</style>
