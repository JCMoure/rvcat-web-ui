<script setup>
  // Panel Cache: the accesses of the program to the cache in a sequential execution, without time
  // (only the LOADs and STOREs, in program order). The space of the panel is shared, without a scroll
  // of the whole panel (each part scrolls by itself):
  //   1 title and model (one line)          2 controls
  //   3 explanation of the last access (one line, scrolled with ◀ ▶)
  //   4 memory map (the arrays side by side)   5 lines of the cache, with the counters
  //   6 grid (lines × steps) or 7 table of the accesses
  //   8 totals of the whole program
  // Two modes: "global" (after a new program or cache: the totals, the map and the cache empty, the
  // controls dimmed) and "trace" (any control: step by step; Σ goes back to the totals).
  import { t } from '@/i18n'
  import { ref, reactive, computed, watch, inject, onMounted, onUnmounted, nextTick, toRaw } from 'vue'
  import HelpComponent from '@/components/helpComponent.vue'
  import { useRVCAT_Api } from '@/rvcatAPI'
  import { getLogicalElementCount } from '@/common'
  import { textScale } from '@/textScale'
  import { blockLabel, longestBlockLabel, cacheStateAt, countsUpTo, nextMiss, memoryStateAt, arrayLayout, isMiss } from '@/cacheTrace'

  const simState = inject('simulationState')
  const { registerHandler, isReady } = inject('worker')
  const { getCacheTrace } = useRVCAT_Api()

  const trace = ref(null)
  const error = ref('')
  const loading = ref(false)
  const step = ref(0)                 // accesses done: the cache after them
  const mode = ref('global')          // 'global' (totals) or 'trace' (step by step)
  const tracing = computed(() => mode.value === 'trace')
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
      mode.value = 'global'                // a new program or cache: its totals first
      stop()
      opts.predict = false
      prediction.right = 0; prediction.total = 0; prediction.last = null
      simState.cacheTraceReady = (simState.cacheTraceReady ?? 0) + 1
      applyRequest()
      nextTick(measure)
    } catch (e) { error.value = String(e) }
  }
  watch(signature, () => { if (signature.value !== requested) request() })
  watch(isReady, (r) => { if (r) request() })

  // ---- requests of the tutorial cards (action cacheTrace) -----------------------------------------
  function applyRequest() {
    const r = simState.cacheTraceRequest
    if (!r || !trace.value) return
    if (r.mode !== undefined) { if (r.mode === 'global') toGlobal(); else mode.value = 'trace' }
    if (r.predict !== undefined) setPredict(r.predict)
    if (r.grid !== undefined) opts.grid = r.grid
    if (r.step !== undefined) { mode.value = 'trace'; go(r.step === 'end' ? total.value : Number(r.step) || 0) }
    simState.cacheTraceRequest = null
  }
  watch(() => simState.cacheTraceRequest, applyRequest, { deep: true })

  // ---- navigation (any control enters the trace mode) --------------------------------------------
  const playing = ref(false)
  let playTimer = null
  function go(n) { step.value = Math.max(0, Math.min(total.value, Math.round(n))) }
  function enter() { mode.value = 'trace' }
  function stepBy(d) { enter(); if (opts.predict && d > 0) return; stop(); go(step.value + d) }
  function toMiss(dir) { enter(); stop(); const n = nextMiss(trace.value ?? {}, step.value, dir); if (n !== null) go(n) }
  function toStart() { enter(); stop(); go(0) }
  function toEnd() { enter(); stop(); go(total.value) }
  function stop() { playing.value = false; clearInterval(playTimer) }
  function play() {
    enter()
    if (playing.value) return stop()
    if (step.value >= total.value) go(0)
    playing.value = true
    playTimer = setInterval(() => { if (step.value >= total.value) stop(); else go(step.value + 1) }, 1000 / opts.speed)
  }
  function toGlobal() { stop(); opts.predict = false; mode.value = 'global' }
  watch(() => opts.speed, () => { if (playing.value) { stop(); play() } })

  // ---- prediction ----------------------------------------------------------------------------
  const prediction = reactive({ right: 0, total: 0, last: null })
  function setPredict(on) {
    stop(); opts.predict = !!on; prediction.right = 0; prediction.total = 0; prediction.last = null
    if (on) enter()
  }
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

  // ---- what is shown (in the global mode: the map and the cache empty) ---------------------------
  const shownStep = computed(() => (tracing.value ? step.value : 0))
  const current = computed(() => (shownStep.value > 0 ? steps.value[shownStep.value - 1] : null))   // the last access done
  const lines = computed(() => (trace.value ? cacheStateAt(trace.value, shownStep.value) : []))
  const mem = computed(() => (trace.value ? memoryStateAt(trace.value, shownStep.value) : { blocks: new Map(), used: new Set() }))
  const sofar = computed(() => (trace.value ? countsUpTo(trace.value, shownStep.value) : { accesses: 0, hit: 0, cold: 0, capacity: 0 }))
  const label = (block) => (trace.value ? blockLabel(trace.value, block) : { label: '', short: '' })
  const addr = (a) => (opts.hex ? '0x' + Number(a).toString(16).toUpperCase() : String(a))

  const instrText = (index) => {
    const p = proc.value, n = p.instruction_list?.length ?? 0
    const inst = index < n ? p.instruction_list?.[index] : p.epilogue?.[index - n]
    return inst?.text ?? `#${index}`
  }
  const resultText = (r) => (r === 'hit' ? t('hit') : r === 'cold' ? t('cold miss') : t('capacity miss'))
  const elemText = (s) => `${s.array}[${s.elem}]`

  // 3: the explanation of the last access
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
  // one line: the arrows at its ends scroll it
  const msgEl = ref(null)
  const msgScroll = reactive({ left: false, right: false })
  function updateMsgArrows() {
    const el = msgEl.value
    if (!el) return
    msgScroll.left = el.scrollLeft > 0
    msgScroll.right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
  }
  function scrollMsg(dir) {
    const el = msgEl.value
    if (!el) return
    el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' })
    setTimeout(updateMsgArrows, 350)
  }
  watch(message, () => nextTick(() => { if (msgEl.value) msgEl.value.scrollLeft = 0; updateMsgArrows() }))

  // ---- The size of the text: the one of A−/A+, limited by the width of the panel (it needs about
  // PANEL_EM ems of width: a narrow panel keeps a smaller text). When it is limited, a button folds the
  // Processor and Program panels to give it room. Sizes in pixels (cells, rows) follow it. ----
  const PANEL_EM = 45
  const rootEl = ref(null)
  const panelW = ref(0)
  const scale = computed(() => {
    const k = textScale.value
    if (!panelW.value) return k
    return Math.min(k, Math.max(0.875, panelW.value / (16 * PANEL_EM)))
  })
  const limited = computed(() => scale.value < textScale.value - 0.001)
  const sideOpen = ref(true)
  function foldSide() { document.getElementById('side-panel-toggle')?.click() }
  const px = (n) => Math.round(n * scale.value)
  const rootStyle = computed(() => ({ fontSize: `${16 * scale.value}px`, '--cell': `${px(13)}px` }))

  // ---- 4: memory map: the arrays side by side; each one scrolls by itself, and follows the element
  // accessed. When they do not fit in the width, all of them but the one of the last access are
  // compressed (narrower cells) -----------------------------------------------------------------
  const CELL_BASE = 13, ROWLABEL_BASE = 34, GAP = 14
  const CELL = computed(() => px(CELL_BASE))
  const ROWLABEL = computed(() => px(ROWLABEL_BASE))
  const mapEl = ref(null)
  const mapSize = reactive({ w: 0, h: 0 })
  const bottomEl = ref(null)
  const bottomSize = reactive({ w: 0, h: 0 })
  function measure() {
    if (rootEl.value) panelW.value = rootEl.value.clientWidth
    sideOpen.value = !!document.getElementById('side-panel-toggle')
    if (mapEl.value) { mapSize.w = mapEl.value.clientWidth; mapSize.h = mapEl.value.clientHeight }
    if (bottomEl.value) { bottomSize.w = bottomEl.value.clientWidth; bottomSize.h = bottomEl.value.clientHeight }
    updateMsgArrows()
  }
  const layouts = computed(() => {
    if (!trace.value) return []
    const arrays = trace.value.arrays ?? []
    const each = Math.max(CELL.value, (mapSize.w - GAP * arrays.length) / Math.max(1, arrays.length) - ROWLABEL.value)
    return arrays.map(a => arrayLayout(trace.value, a, proc.value.mapWidth, proc.value.repStrides, Math.floor(each / CELL.value)))
  })
  const activeArray = computed(() => current.value?.array ?? null)
  // the width of the cells of each array
  const cellWidths = computed(() => {
    const ls = layouts.value
    const cell = CELL.value, rowLabel = ROWLABEL.value
    const natural = ls.reduce((s, l) => s + rowLabel + GAP + (l.width ?? 0) * cell, 0)
    if (natural <= mapSize.w || !mapSize.w) return Object.fromEntries(ls.map(l => [l.name, cell]))
    const active = ls.find(l => l.name === activeArray.value)
    const others = ls.filter(l => l !== active)
    const room = mapSize.w - ls.length * (rowLabel + GAP) - (active ? (active.width ?? 0) * cell : 0)
    const cw = Math.max(2, Math.min(cell, Math.floor(room / Math.max(1, others.reduce((s, l) => s + (l.width ?? 0), 0)))))
    return Object.fromEntries(ls.map(l => [l.name, l === active ? cell : cw]))
  })
  function cellClass(name, cell) {
    const st = mem.value.blocks.get(cell.block)
    const s = current.value
    if (cell.pad) return { 'ct-pad': true, 'ct-in': st === 'in', 'ct-out': st === 'out', 'ct-bstart': cell.blockStart,
                           'ct-nowblock': !!s && s.block === cell.block }
    return {
      'ct-in': st === 'in', 'ct-out': st === 'out', 'ct-used': mem.value.used.has(`${name}:${cell.elem}`),
      'ct-now': !!s && s.array === name && s.elem === cell.elem,
      'ct-nowblock': !!s && s.block === cell.block && !(s.array === name && s.elem === cell.elem),
      'ct-bstart': cell.blockStart,
    }
  }
  // 5: the table of the cache has a fixed width (its widest possible contents), so that the map does
  // not move when the lines fill: the longest name of a block (A[first–last]) and address
  const cacheCols = computed(() => {
    const arrays = trace.value?.arrays ?? []
    const digits = (n) => String(Math.max(0, Math.floor(n))).length
    const name = Math.max(6, trace.value ? longestBlockLabel(trace.value) : 0)
    const top = Math.max(0, ...arrays.map(a => a.base + a.bytes))
    const address = opts.hex ? 2 + top.toString(16).length : digits(top)
    return { line: 5, block: name + 3 + address, lru: 4, m: 3 }
  })
  const cacheWidth = computed(() => { const c = cacheCols.value; return `calc(${c.line + c.block + c.lru + c.m}ch + 60px)` })
  // a scroll box shows its marked element (inside the box only)
  function keepInView(box, el) {
    if (!box || !el) return
    const b = box.getBoundingClientRect(), r = el.getBoundingClientRect()
    if (r.top < b.top) box.scrollTop -= b.top - r.top + 4
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 4
  }
  const cacheBox = ref(null)
  watch(() => [shownStep.value, mode.value], () => nextTick(() => {
    for (const box of document.querySelectorAll('#ct-map .ct-array-rows')) keepInView(box, box.querySelector('.ct-now'))
    keepInView(cacheBox.value, cacheBox.value?.querySelector('.ct-line-now'))
  }))

  // ---- 7: table of the accesses: as many rows as fit, around the current one ----------------------
  const rowsFit = computed(() => Math.max(3, Math.floor((bottomSize.h - px(26)) / px(21))))
  const windowStart = computed(() => Math.max(0, Math.min(total.value - rowsFit.value, step.value - Math.floor(rowsFit.value / 3))))
  const tableRows = computed(() => steps.value.slice(windowStart.value, windowStart.value + rowsFit.value).map((s, j) => ({ s, i: windowStart.value + j })))
  function onTableWheel(e) { if (opts.predict && e.deltaY > 0) return; enter(); stop(); go(step.value + (e.deltaY > 0 ? 1 : -1)) }

  // ---- 6: grid: lines × the steps that fit in the width (the current one at the right) --------------
  const gridOk = computed(() => (trace.value?.nBlocks ?? 0) <= 16)
  const showGrid = computed(() => opts.grid && gridOk.value)
  const gridCols = computed(() => {
    if (!trace.value || !showGrid.value) return []
    const fit = Math.max(8, Math.floor((bottomSize.w - px(60)) / px(46)))
    const end = Math.max(step.value, Math.min(total.value, fit)), start = Math.max(0, end - fit)
    const cols = []
    for (let n = start + 1; n <= end; n++) {
      const st = cacheStateAt(trace.value, n), s = steps.value[n - 1]
      cols.push({ n, s, lines: st.map(l => (l.block === null ? '' : label(l.block).short)), future: n > step.value })
    }
    return cols
  })

  // ---- 8: totals of the whole program, per instruction ---------------------------------------------
  const perInstruction = computed(() => Object.entries(trace.value?.totals?.per_instruction ?? {})
    .map(([index, c]) => ({ index: Number(index), text: instrText(Number(index)), ...c }))
    .sort((a, b) => a.index - b.index))
  const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + ' %' : '—')

  // highlight of the instruction in the Program panel while the pointer is on a row
  function hoverRow(s) { simState.instrHighlightedIdx = s ? s.index : -1 }

  // help
  const showHelp = ref(false)
  const helpPosition = ref({ top: '0%', left: '0%' })

  let cleanup = null, observer = null
  onMounted(() => {
    cleanup = registerHandler('get_cache_trace', handleTrace)
    window.addEventListener('keydown', onKey)
    observer = new ResizeObserver(measure)
    observer.observe(document.getElementById('cache-trace-root'))
    nextTick(() => { request(); measure() })
  })
  watch(scale, () => nextTick(measure))
  watch(() => [mode.value, showGrid.value, !!trace.value], () => nextTick(() => {
    for (const el of [mapEl.value, bottomEl.value]) if (el) observer?.observe(el)
    measure()
  }))
  onUnmounted(() => {
    cleanup?.(); stop(); clearTimeout(timer)
    observer?.disconnect()
    window.removeEventListener('keydown', onKey)
    simState.instrHighlightedIdx = -1
  })
</script>

<template>
  <div class="main ct-main" id="cache-trace-root" ref="rootEl" :style="rootStyle">
    <!-- 1: title, options and the model (one line each) -->
    <div class="ct-head">
      <span class="info-icon" @click="showHelp = true" :title="t('Show Help')"><img src="/img/info.png" class="info-img"></span>
      <span class="ct-title">{{ t('Cache trace') }}: <strong>{{ proc.name }}</strong></span>
      <span class="ct-model" :title="t('Sequential execution, without time: only the LOADs and STOREs, in program order. The cache is fully associative with LRU replacement.')">
        <template v-if="hasCache">{{ t('Cache: {n} lines × blocks of {b} B, fully associative, LRU · sequential, no time: LOADs and STOREs only', { n: proc.nBlocks, b: proc.blkSize }) }}</template>
      </span>
      <button v-if="limited && sideOpen" class="ct-room" id="ct-more-room" @click="foldSide"
              :title="t('The text of this panel is smaller than the size chosen (A+): fold the Processor and Program panels to give it room')">⇤ A+</button>
      <span class="ct-options">
        <label :title="t('Before each access, say whether it will hit or miss')"><input type="checkbox" id="ct-predict" :checked="opts.predict" @change="setPredict($event.target.checked)"> {{ t('Predict') }}</label>
        <label v-if="gridOk" :title="t('The lines of the cache in the last steps (a column per access), instead of the table of the accesses')"><input type="checkbox" id="ct-grid" v-model="opts.grid"> {{ t('Grid') }}</label>
        <label :title="t('Addresses in hexadecimal')"><input type="checkbox" id="ct-hex" v-model="opts.hex"> hex</label>
      </span>
    </div>

    <div v-if="!hasCache" class="ct-note" id="ct-no-cache">{{ t('The processor has no cache: give it lines in the Memory box of the Processor panel.') }}</div>
    <div v-else-if="error" class="ct-note ct-error">{{ error }}</div>
    <div v-else-if="!trace" class="ct-note">{{ loading ? t('Computing the accesses…') : '' }}</div>

    <template v-else>
      <!-- 2: controls (dimmed in the global mode: any of them starts the trace) -->
      <div class="ct-controls" id="ct-controls" :class="{ 'ct-dimmed': !tracing }">
        <button id="ct-global" class="ct-sigma" :class="{ on: !tracing }" @click="toGlobal" :title="t('Whole program: the totals (leave the trace)')">Σ</button>
        <button id="ct-first" @click="toStart" :title="t('Back to the start (empty cache)')">⏮</button>
        <button id="ct-prev-miss" @click="toMiss(-1)" :disabled="opts.predict" :title="t('Previous miss')">◀F</button>
        <button id="ct-prev" @click="stepBy(-1)" :title="t('Previous access (←)')">◀</button>
        <template v-if="!opts.predict">
          <button id="ct-next" @click="stepBy(1)" :title="t('Next access (→)')">▶</button>
          <button id="ct-next-miss" @click="toMiss(1)" :title="t('Next miss')">F▶</button>
          <button id="ct-last" @click="toEnd" :title="t('To the end')">⏭</button>
          <button id="ct-play" class="ct-play" @click="play" :title="t('Play the accesses')">{{ playing ? '⏸' : '▶▶' }}</button>
          <select v-model.number="opts.speed" @change="enter" :title="t('Accesses per second')"><option v-for="v in [1, 2, 4, 8, 16]" :key="v" :value="v">{{ v }}/s</option></select>
        </template>
        <template v-else>
          <span class="ct-ask">{{ t('Next access:') }} <b v-if="steps[step]">{{ elemText(steps[step]) }}</b></span>
          <button id="ct-predict-hit" class="ct-hitbtn" :disabled="step >= total" @click="predict(false)" :title="t('Key {k}', { k: hitKey })">{{ t('Hit') }} ({{ hitKey }})</button>
          <button id="ct-predict-miss" class="ct-missbtn" :disabled="step >= total" @click="predict(true)" :title="t('Key {k}', { k: missKey })">{{ t('Miss') }} ({{ missKey }})</button>
          <span class="ct-score" id="ct-score">{{ t('Right: {r} of {n}', { r: prediction.right, n: prediction.total }) }}
            <span v-if="prediction.last" :class="prediction.last.ok ? 'ct-ok' : 'ct-ko'">{{ prediction.last.ok ? '✓' : '✗' }}</span></span>
        </template>
        <input type="range" class="ct-range" min="0" :max="total" :value="step" :disabled="opts.predict" @input="enter(); stop(); go(Number($event.target.value))">
        <span class="ct-pos" id="ct-step">{{ t('Access {n} of {t}', { n: shownStep, t: total }) }}</span>
      </div>

      <!-- 3: the last access (one line) -->
      <div v-if="tracing" class="ct-message" id="ct-message" :class="current ? 'ct-msg-' + current.result : ''">
        <button v-show="msgScroll.left" class="ct-msg-arrow" @click="scrollMsg(-1)" :title="t('Scroll the text')">◀</button>
        <div ref="msgEl" class="ct-msg-text" @scroll="updateMsgArrows" :title="message">{{ message }}</div>
        <button v-show="msgScroll.right" class="ct-msg-arrow" @click="scrollMsg(1)" :title="t('Scroll the text')">▶</button>
      </div>

      <!-- 8: totals of the whole program (global mode) -->
      <div v-if="!tracing" class="ct-summary" id="ct-summary">
        <div class="ct-totals">
          <b>{{ t('Whole program') }}</b>
          <span>{{ t('Accesses') }}: <b id="ct-total-accesses">{{ trace.totals.accesses }}</b></span>
          <span>{{ t('Hits') }}: <b id="ct-total-hits">{{ trace.totals.hit }}</b></span>
          <span>{{ t('Cold misses') }}: <b id="ct-total-cold">{{ trace.totals.cold }}</b></span>
          <span>{{ t('Capacity misses') }}: <b id="ct-total-capacity">{{ trace.totals.capacity }}</b></span>
          <span>{{ t('Miss rate') }}: <b id="ct-miss-rate">{{ pct(trace.totals.cold + trace.totals.capacity, trace.totals.accesses) }}</b></span>
          <span :title="t('Modified blocks evicted (the ones left in the cache at the end are not counted)')">{{ t('Blocks written back') }}: <b id="ct-total-writebacks">{{ trace.totals.writebacks }}</b></span>
        </div>
        <div class="ct-per-box">
          <table class="ct-per">
            <thead><tr><th>{{ t('Instruction') }}</th><th>{{ t('Accesses') }}</th><th>{{ t('Hits') }}</th><th>{{ t('Cold misses') }}</th><th>{{ t('Capacity misses') }}</th><th>{{ t('Miss rate') }}</th></tr></thead>
            <tbody><tr v-for="p in perInstruction" :key="p.index" :id="'ct-instr-' + p.index">
              <td class="ct-instr">{{ p.text }}</td><td>{{ p.accesses }}</td><td>{{ p.hit }}</td><td>{{ p.cold }}</td><td>{{ p.capacity }}</td><td>{{ pct(p.cold + p.capacity, p.accesses) }}</td></tr></tbody>
          </table>
        </div>
        <div class="ct-dim ct-hint">{{ t('Step through the accesses with the controls above (▶, →); Σ comes back here.') }}<span v-if="trace.truncated"> {{ t('Only the first {n} accesses can be shown step by step.', { n: total }) }}</span></div>
      </div>

      <!-- 4 and 5: memory map and lines of the cache (the same height) -->
      <div class="ct-legend">
        <span><i class="ct-sw"></i>{{ t('never in the cache') }}</span>
        <span><i class="ct-sw ct-in"></i>{{ t('in the cache') }}</span>
        <span><i class="ct-sw ct-out"></i>{{ t('evicted') }}</span>
        <span><i class="ct-sw ct-now"></i>{{ t('element accessed') }}</span>
        <span>│ {{ t('start of a block') }}</span>
      </div>
      <div class="ct-middle">
        <div class="ct-mapcol">
          <div class="ct-map" id="ct-map" ref="mapEl">
            <div v-for="lay in layouts" :key="lay.name" class="ct-array" :class="{ 'ct-array-active': lay.name === activeArray }">
              <div class="ct-array-name">{{ lay.name }} <span class="ct-dim">({{ t('{n} elements', { n: lay.count }) }})</span></div>
              <div v-if="lay.tooLarge" class="ct-dim">{{ t('too large to draw') }}</div>
              <div v-else class="ct-array-rows">
                <div v-for="row in lay.rows" :key="row.start" class="ct-row">
                  <span class="ct-rowlabel">{{ row.start }}</span>
                  <span v-for="c in row.cells" :key="c.elem" class="ct-cell" :class="cellClass(lay.name, c)"
                        :style="{ width: cellWidths[lay.name] + 'px' }"
                        :title="(c.pad ? '' : `${lay.name}[${c.elem}] · `) + `${t('block')} ${addr(c.block)} (${label(c.block).label})`"></span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="ct-cache" id="ct-cache" :style="{ width: cacheWidth }">
          <div class="ct-counters" id="ct-sofar">
            <div>{{ t('Hits') }} <b>{{ sofar.hit }}</b> · {{ t('cold') }} <b>{{ sofar.cold }}</b> · {{ t('capacity') }} <b>{{ sofar.capacity }}</b></div>
            <div class="ct-victim">{{ current && current.victim !== null ? t('Out: {v}', { v: label(current.victim).label }) + (current.dirty ? ' ✎' : '') : ' ' }}</div>
          </div>
          <div class="ct-cache-rows" ref="cacheBox">
            <table class="ct-cache-table">
              <colgroup><col :style="{ width: cacheCols.line + 2 + 'ch' }"><col><col :style="{ width: cacheCols.lru + 2 + 'ch' }"><col :style="{ width: cacheCols.m + 2 + 'ch' }"></colgroup>
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
          </div>
        </div>
      </div>

      <!-- 6 or 7: the grid, or the table of the accesses (trace mode) -->
      <div v-if="tracing" class="ct-bottom" ref="bottomEl">
        <div v-if="showGrid" class="ct-grid" id="ct-grid">
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
        <div v-else class="ct-table" id="ct-table" @wheel.prevent="onTableWheel" :title="t('Click a row to go to that access; the wheel moves one access.')">
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
        </div>
      </div>
    </template>
  </div>

  <Teleport to="body">
    <HelpComponent v-if="showHelp" :position="helpPosition" :text="t('help.cacheTrace')" :title="t('Cache trace')" @close="showHelp = false"/>
  </Teleport>
</template>

<style scoped>
  .ct-main { display: flex; flex-direction: column; overflow: hidden; padding: 2px 6px 4px; gap: 4px; }
  /* 1 */
  .ct-head { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 0 0 auto; }
  .ct-title { white-space: nowrap; font-size: 1.05em; }
  .ct-model { flex: 1 1 0; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #555; font-size: 0.85em; }
  .ct-room { flex: 0 0 auto; border: 1px solid #1565c0; color: #1565c0; background: #fff; border-radius: 4px; padding: 0 0.4em; font-size: 0.8em; cursor: pointer; }
  .ct-room:hover { background: #e3f2fd; }
  .ct-options { display: flex; gap: 10px; font-size: 0.85em; white-space: nowrap; }
  .ct-options label { cursor: pointer; }
  .ct-note { padding: 14px; border: 1px dashed #bbb; border-radius: 6px; color: #555; }
  .ct-error { color: #c62828; }
  /* 2 */
  .ct-controls { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; min-width: 0; }
  .ct-controls button { min-width: 1.9em; height: 1.75em; padding: 0 0.4em; border: 1px solid #90a4ae; border-radius: 4px; background: #fff; cursor: pointer; font-size: 0.85em; line-height: 1; }
  .ct-controls button:hover:not(:disabled) { background: #e3f2fd; }
  .ct-controls button:disabled { opacity: 0.4; cursor: default; }
  .ct-controls select { height: 1.75em; font-size: 0.85em; }
  .ct-controls.ct-dimmed > :not(.ct-sigma) { opacity: 0.45; }
  .ct-controls.ct-dimmed > :not(.ct-sigma):hover { opacity: 0.8; }
  .ct-sigma { font-weight: 700; }
  .ct-sigma.on { background: #1565c0 !important; color: #fff; border-color: #1565c0 !important; }
  .ct-play { font-weight: 700; }
  .ct-range { flex: 1 1 60px; min-width: 50px; }
  .ct-pos { font-size: 0.82em; color: #444; white-space: nowrap; }
  .ct-hitbtn { border-color: #2e7d32 !important; color: #2e7d32; font-weight: 600; }
  .ct-missbtn { border-color: #c62828 !important; color: #c62828; font-weight: 600; }
  .ct-score, .ct-ask { font-size: 0.82em; white-space: nowrap; }
  .ct-ok { color: #2e7d32; font-weight: 700; } .ct-ko { color: #c62828; font-weight: 700; }
  /* 3 */
  .ct-message { display: flex; align-items: center; flex: 0 0 auto; height: 1.6em; border-left: 4px solid #90a4ae; background: #f5f7f8; border-radius: 4px; min-width: 0; }
  .ct-msg-text { flex: 1 1 0; min-width: 0; overflow: hidden; white-space: nowrap; padding: 0 8px; font-size: 0.9em; }
  .ct-msg-arrow { flex: 0 0 auto; border: none; background: transparent; cursor: pointer; color: #37474f; padding: 0 4px; font-size: 0.8em; }
  .ct-msg-hit { border-left-color: #2e7d32; background: #eef7ee; }
  .ct-msg-cold { border-left-color: #1565c0; background: #eaf2fb; }
  .ct-msg-capacity { border-left-color: #c62828; background: #fcefee; }
  /* 8 */
  .ct-summary { flex: 0 1 auto; max-height: 45%; display: flex; flex-direction: column; min-height: 0; padding: 4px 8px; border: 1px solid #cfd8dc; border-radius: 6px; background: #fafafa; }
  .ct-totals { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 0.9em; }
  .ct-per-box { overflow: auto; min-height: 0; margin-top: 4px; }
  .ct-per { font-size: 0.85em; border-collapse: collapse; }
  .ct-per th, .ct-per td { border-bottom: 1px solid #eee; padding: 1px 8px; text-align: left; white-space: nowrap; }
  .ct-hint { font-size: 0.82em; margin-top: 3px; }
  /* 4 and 5 */
  .ct-middle { flex: 1 1 0; min-height: 90px; display: flex; gap: 10px; min-width: 0; }
  .ct-mapcol { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .ct-legend { display: flex; flex-wrap: nowrap; gap: 12px; font-size: 0.78em; color: #555; flex: 0 0 auto; white-space: nowrap; overflow: hidden; }
  .ct-sw { display: inline-block; width: 0.8em; height: 0.8em; border: 1px solid #bbb; background: #eceff1; margin-right: 3px; vertical-align: -1px; }
  .ct-map { flex: 1 1 0; min-height: 0; display: flex; gap: 14px; align-items: stretch; overflow: hidden; }
  .ct-array { display: flex; flex-direction: column; min-height: 0; flex: 0 0 auto; }
  .ct-array-name { font-weight: 700; font-size: 0.85em; white-space: nowrap; }
  .ct-array-active .ct-array-name { color: #e65100; }
  .ct-array-rows { overflow-y: auto; overflow-x: hidden; min-height: 0; flex: 1 1 0; }
  .ct-row { display: flex; align-items: center; line-height: 0; margin: 1px 0; }
  .ct-rowlabel { width: calc(var(--cell) * 2.3); flex: 0 0 calc(var(--cell) * 2.3); font-size: 0.68em; color: #888; text-align: right; padding-right: 4px; line-height: 1; }
  .ct-cell { display: inline-block; flex: 0 0 auto; height: var(--cell); border: 1px solid #fff; background: #eceff1; box-sizing: border-box; }
  .ct-cell.ct-bstart { border-left: 2px solid #455a64; }
  /* positions of a block outside the array (another array, or nothing): the colour of the block, dimmed */
  .ct-cell.ct-pad { opacity: 0.35; background: transparent; border-top-style: dashed; }
  .ct-cell.ct-pad:not(.ct-in):not(.ct-out) { background: repeating-linear-gradient(45deg, #eceff1 0 2px, #fff 2px 4px); }
  .ct-in { background: #a5d6a7 !important; }
  .ct-out { background: #f4c7c3 !important; }
  .ct-cell.ct-used::after { content: ''; display: block; width: 3px; height: 3px; margin: calc(var(--cell) / 2 - 2.5px) auto 0; border-radius: 50%; background: #37474f; }
  .ct-now { outline: 2px solid #ff6f00; outline-offset: -1px; background: #ffcc80 !important; }
  .ct-sw.ct-now { outline-offset: 0; }
  .ct-nowblock { box-shadow: inset 0 0 0 1px #ff6f00; }
  .ct-cache { flex: 0 0 auto; display: flex; flex-direction: column; min-height: 0; font-size: 0.85em; max-width: 50%; }
  .ct-cache-table { table-layout: fixed; width: 100%; }
  .ct-counters > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ct-counters { flex: 0 0 auto; line-height: 1.25; }
  .ct-victim { color: #c62828; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.25em; }
  .ct-cache-rows { flex: 1 1 0; min-height: 0; overflow-y: auto; }
  .ct-cache table, .ct-table table, .ct-grid table { border-collapse: collapse; }
  .ct-cache th, .ct-cache td { border: 1px solid #ddd; padding: 1px 4px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ct-cache thead th { background: #eceff1; position: sticky; top: 0; }
  .ct-line-now.ct-line-hit td { background: #c8e6c9; }
  .ct-line-now.ct-line-cold td { background: #bbdefb; }
  .ct-line-now.ct-line-capacity td { background: #ffcdd2; }
  .ct-dim { color: #888; font-weight: normal; }
  /* 6 and 7 */
  .ct-bottom { flex: 1 1 0; min-height: 80px; min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
  .ct-grid { overflow: auto; font-size: 0.8em; flex: 1 1 0; min-height: 0; }
  .ct-grid th, .ct-grid td { border: 1px solid #ddd; padding: 1px 4px; text-align: center; min-width: 2.6em; }
  .ct-grid thead th { background: #eceff1; }
  .ct-g-elem { font-weight: normal; }
  .ct-g-new { background: #bbdefb; font-weight: 700; }
  .ct-g-hit { background: #c8e6c9; }
  .ct-g-now { outline: 2px solid #ff6f00; outline-offset: -2px; }
  .ct-table { font-size: 0.85em; overflow-x: auto; overflow-y: hidden; flex: 1 1 0; min-height: 0; }
  .ct-table table { width: 100%; }
  .ct-table th, .ct-table td { border-bottom: 1px solid #eee; padding: 1px 6px; text-align: center; white-space: nowrap; height: 1.45em; }
  .ct-table thead th { background: #eceff1; }
  .ct-table tbody tr { cursor: pointer; }
  .ct-row-now td { background: #fff3e0; font-weight: 600; }
  .ct-future td { color: #aaa; }
  .ct-instr { font-family: monospace; }
  .ct-res-hit { color: #2e7d32; } .ct-res-cold { color: #1565c0; font-weight: 600; } .ct-res-capacity { color: #c62828; font-weight: 600; }
</style>
