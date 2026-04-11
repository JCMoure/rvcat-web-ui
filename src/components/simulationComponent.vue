<script setup>
  import { ref, toRaw, computed, onMounted, onUnmounted, nextTick, inject, watch, reactive } from "vue"
  import HelpComponent                                            from '@/components/helpComponent.vue'
  import { useRVCAT_Api }                                                             from '@/rvcatAPI'
  import { createGraphVizGraph  }                                                       from '@/common'

  const { getExecutionResults } = useRVCAT_Api();
  const { registerHandler }     = inject('worker');
  const simState                = inject('simulationState');

 /* ------------------------------------------------------------------
   * Simulation Results options (persistent in localStorage)
   * ------------------------------------------------------------------ */
  const STORAGE_KEY = 'simulationOptions'
  const MAX_ITERS    = 5000

  const defaultOptions = {
    iters:        1,
    autorun:      false,
    showPrevious: false
  }

  const savedOptions = (() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      console.log('🕐load options')
      return saved ? JSON.parse(saved) : defaultOptions
    } catch {
      return defaultOptions
    }
  })()

  const simulationOptions = reactive({ ...defaultOptions, ...savedOptions })

  const resultsSvg            = ref('')
  let   cleanupHandleResults  = null
  let   resultsTimeout        = null

  const saveOptions = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(simulationOptions))
    } catch (error) {
      console.error('🕐❌ Failed to save:', error)
    }
  }

  const inputValue   = ref('');
  const isInvalid    = ref(false);
  let   errorTimeout = null;

  const validateField = () => {
    const min = 1;
    const max = MAX_ITERS;
    let rawValue = inputValue.value;

    if (errorTimeout) clearTimeout(errorTimeout);

    if (rawValue === '' || rawValue === null || rawValue === undefined) {
      const lastValidValue = simulationOptions.iters;
      inputValue.value = lastValidValue ?? min;
      isInvalid.value = false;
      return;
    }

    let numValue = Number(rawValue);

    if (isNaN(numValue)) {
      const lastValidValue = simulationOptions.iters;
      inputValue.value = lastValidValue ?? min;
      isInvalid.value = false;
      return;
    }

    if (numValue < min) {
      numValue = min;
      inputValue.value = numValue;
      showTemporaryError(`Minimum is ${min}`);
    } else if (numValue > max) {
      numValue = max;
      inputValue.value = numValue;
      showTemporaryError(`Maximum is ${max}`);
    }

    if (simulationOptions.iters !== numValue) {
      simulationOptions.iters = numValue;
    }
  }

  const showTemporaryError = (message) => {
    isInvalid.value = true;
    errorTimeout = setTimeout(() => {
      isInvalid.value = false;
    }, 2000);
    console.warn(message);
  };

  const handleKeyPress = (event) => {
    if (event.key === 'Enter') {
      event.target.blur();
    }
  };

  const handleInput = (event) => {
    if (isInvalid.value) {
      isInvalid.value = false;
    }
    let value = event.target.value;
    if (value !== '' && !/^\d*$/.test(value)) {
      event.target.value = value.replace(/\D/g, '');
      inputValue.value = event.target.value;
    }
  };

  // Load from localStorage
  onMounted(() => {
    cleanupHandleResults  = registerHandler('get_execution_results', handleResults);
    console.log('🕐🎯 SimulationComponent mounted')
    simState.executionResults = null

    try {    // Load from localStorage
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        Object.assign(simulationOptions, JSON.parse(saved))
      }
    } catch (error) {
      console.error('🕐❌ Failed to load:', error)
    }
    if (simState.state >= 3 && simulationOptions.autorun)
      reloadExecutionResults()
  });

  // Clean up on unmount
  onUnmounted(() => {
     if (cleanupHandleResults) {
        cleanupHandleResults();
        cleanupHandleResults = null
     }
    })

  watch(() => simulationOptions.iters,
    (newVal) => {
      console.log('🕐🔄 modify number of iterations', newVal);
      inputValue.value = newVal ?? '';
      isInvalid.value  = false;
      saveOptions()
      if (simState.state >= 3 && simulationOptions.autorun) {
        reloadExecutionResults()
      }
    },
    { immediate: true }
  )

  watch( () => simState.simulatedProcess, () => {
      if (simState.state >= 3 && simState.simulatedProcess && simulationOptions.autorun) {
        console.log('🕐🔄 Re-execute simulation');
        // reloadExecutionResults()
      }
    },
    { deep: true, immediate: false }
  )

  // Handler for 'get_execution_results' message (fired by RVCAT getPerformanceAnalysis function)
  const handleResults = async (data, dataType) => {
    if (dataType === 'error') {
      console.error('🕐❌Failed to get execution results:', data);
      return;
    }
    try {
      console.log('🕐✅ Execution Results received')
      simState.executionResults = JSON.parse(data)

      if (simState.executionResults['data_type'] === 'error') {
          alert('Error running simulation');
          document.getElementById('run-simulation-spinner').style.display = 'none';
          document.getElementById('simulation-running').style.display     = 'none';
          document.getElementById('previous-simulations-section').style.display  = 'block';
          document.getElementById('run-simulation-button').disabled       = false;
          return;
      }
      // Hide spinner and show results after a short delay to ensure UI updates
      if (resultsTimeout) clearTimeout(resultsTimeout)
      resultsTimeout = setTimeout(() => {
        drawProcessorResults()
        document.getElementById('run-simulation-spinner').style.display = 'none';
        document.getElementById('simulation-running').style.display     = 'none';
        document.getElementById('previous-simulations-section').style.display  = 'block';
        document.getElementById('run-simulation-button').disabled       = false;
      }, 500)
    } catch (error) {
      console.error('🕐❌Failed to obtain execution results:', error)
    }
  }

 /* ------------------------------------------------------------------
  * Simulation options: UI actions
  * ------------------------------------------------------------------ */

  function togglePrevious() { simulationOptions.showPrevious = !simulationOptions.showPrevious }
  function toggleAutorun()  { simulationOptions.autorun      = !simulationOptions.autorun }

  const formattedResults = computed(() => {
    const results = simState.executionResults || {};

    return {
      instructions: results["total_instructions"]?.toLocaleString() ?? '0',
      cycles:       results["total_cycles"]?.toLocaleString() ?? '0',
      cpi:          results["cycles_per_iteration"]?.toFixed(2) ?? '0',
      ipc:          results["ipc"]?.toFixed(3) ?? '0',
      loads:        results["total_loads"]?.toLocaleString() ?? '0'
    };
  });

  const ipcColor = computed(() => {
    const ipc = simState.executionResults?.["ipc"] ?? 0
    const dw  = simState.simulatedProcess?.dispatch || 1

    if (!ipc || !dw || dw === 0) return '#666';

    const ratio = ipc / dw;

    // close to maximum (>= 80% of dispatch width) -> Green
    if (ratio >= 0.8) return '#00cc44';

    // Very low (<= 10% of dispatch width) -> Red
    if (ratio <= 0.1) return '#ff3333';

    // Intermediate: gradient from red to green
    const t     = (ratio - 0.1) / 0.7; // Normalize 0.1-0.8 to 0-1
    const red   = Math.floor(255 * (1 - t));
    const green = Math.floor(255 * t);

    return `rgb(${red}, ${green}, 0)`;
  });

  const ipcStyle = computed(() => ({
    color:      ipcColor.value,
    fontWeight: 'bold',
    fontSize:   '1.2em',
    backgroundColor: `${ipcColor.value}10`,
    padding:    '2px 6px',
    borderRadius: '4px',
    transition: 'all 0.3s ease'
  }));

  const ipcTooltip = computed(() => {
    const ipc = simState.executionResults?.["ipc"] ?? 0;
    const dw  = simState.simulatedProcess?.dispatch || 1;
    const efficiency = ((ipc / dw) * 100).toFixed(1);
    return `IPC: ${ipc.toFixed(3)} | Dispatch Width: ${dw}\nEfficiency: ${efficiency}% of maximum possible IPC`;
  });

  const reloadExecutionResults = async () => {
    clearTimeout(resultsTimeout)
    try {
      resultsTimeout = setTimeout(() => {
        document.getElementById('run-simulation-spinner').style.display = 'block';
        document.getElementById('simulation-running').style.display     = 'block';
        document.getElementById('previous-simulations-section').style.display  = 'none';
        document.getElementById('run-simulation-button').disabled       = true;

        const { ROBsize, dispatch, retire, sched, blksize, nBlocks, mPenalty, mIssueTime, instruction_list } = simState.simulatedProcess
        getExecutionResults(JSON.stringify( { ROBsize, dispatch, retire, sched, blksize, nBlocks, mPenalty, mIssueTime,
                                              instruction_list: toRaw(instruction_list)}, null, 2),
                            simulationOptions.iters) // Call Python RVCAT
        console.log('🕐✅ Reloading execution results')
       }, 200)
    } catch (error) {
      console.error('🕐❌Failed to request execution results:', error)
    }
  }

  const drawProcessorResults = async () => {
    try {
      const dotCode      = get_proc_results_dot (simState.simulatedProcess, simState.executionResults)
      const svg          = await createGraphVizGraph(dotCode);
      resultsSvg.value = svg.outerHTML;
    } catch (error) {
      console.error('💻❌ Failed to draw results+processor:', error)
      resultsSvg.value = `<div class="error">Failed to render graph</div>`;
    }
  }

  function get_proc_results_dot (process, results) {

    const ports    = process.ports
    const port_ids = Object.keys(ports)
    const ROBsize  = process.ROBsize || 20
    const dispatch = process.dispatch
    const retire   = process.retire

    // Colorscale from grey to red
    const color = [
      "#e0e0e0",  "#c8e6c9",  "#a5d6a7",  "#81c784",  "#66bb6a",  "#4caf50",  "#43a047",  "#388e3c",
      "#2e7d32",  "#558b2f",  "#7cb342",  "#9e9d24",  "#c0ca33",  "#d4b000",  "#c49000",  "#b37400",
      "#a35a00",  "#933f00",  "#832600",  "#731200",  "#630000",  "#4a0000"    ];

    let usage = 0
    if (results !== null)
      usage = (results.ipc / dispatch) * 100
    let dispatch_color = color[Math.floor(usage/5)]

    let message =  usage !== 0
      ? `&nbsp;&nbsp;&nbsp;Usage:<B><FONT COLOR="${dispatch_color}">${usage.toFixed(1)}%</FONT></B>`
      : ""

    // ---- Decode ----
    let decode_row = `<TR>
      <TD COLSPAN="${port_ids.length}" BGCOLOR="#eeeeee" TITLE="Usage of dispatch capacity"><FONT POINT-SIZE="20"><B>Dispatch:&nbsp;</B>&nbsp;${dispatch}/cycle${message}</FONT></TD>
      <TD ROWSPAN="3" BGCOLOR="#f0f0f0" ALIGN="CENTER" VALIGN="MIDDLE"><FONT POINT-SIZE="20"><B>ROB</B><BR/><BR/><B>${ROBsize}</B></FONT><BR/><FONT POINT-SIZE="16">entries</FONT></TD>
    </TR>`

    // ---- Port headers ----
    let port_header = "<TR>"

    for (let p of port_ids) {
      const style = ` BGCOLOR="#f5f5f5" TITLE="Usage of port ${p}"`
      usage = 0
      if (results?.ports?.[p] != null)
        usage = results.ports[p]
      let port_color = color[Math.floor(usage/5)]
      let message = usage !== 0
        ? `<FONT COLOR="${port_color}">${usage.toFixed(0)}%</FONT>`
        : ""
      port_header += `<TD${style}><FONT POINT-SIZE="20"><B>P${p} ${message}</B></FONT></TD>`
    }

    port_header += "</TR>"

    // ---- Registers & Retire ----
    usage = 0
    if (results !== null)
      usage = (results.ipc / retire) * 100
    let retire_color = color[Math.floor(usage/5)]

    message = usage !== 0
      ? `&nbsp;<B>Usage:<FONT COLOR="${retire_color}">${usage.toFixed(1)}%</FONT></B>`
      : ""

    let reg_row = `<TR>
      <TD WIDTH="538" COLSPAN="${port_ids.length}" BGCOLOR="#eeeeee" TITLE="Usage of retire capacity"><FONT POINT-SIZE="20"><B>Retire:</B>&nbsp;${retire}/cycle${message}</FONT></TD>
    </TR>`

    const dot = `
      digraph CPU {
        node [shape=plain fontname="Arial" width=0 height=0 margin=0]
        pipeline [
          label=<
            <TABLE WIDTH="600" BORDER="2" CELLBORDER="1" CELLSPACING="2" CELLPADDING="1">
              ${decode_row}
              ${port_header}
              ${reg_row}
            </TABLE>
          >
        ]
      }  `
    return dot
  }

/* ------------------------------------------------------------------
 * Help support
 * ------------------------------------------------------------------ */
  const showHelp1 = ref(false);  const showHelp2 = ref(false);
  const helpIcon1 = ref(null);   const helpIcon2 = ref(null);
  const helpPosition = ref({ top: '0%', left: '0%' });

  function openHelp1()  { nextTick(() => { showHelp1.value = true }) }
  function closeHelp1() { showHelp1.value  = false }
  function openHelp2()  { nextTick(() => { showHelp2.value = true }) }
  function closeHelp2() { showHelp2.value  = false }

</script>

<template>
  <div class="main">
    <div class="header">
      <div class="section-title-and-info">
        <span ref="helpIcon1" class="info-icon" @click="openHelp1" title="Show help">
           <img src="/img/info.png" class="info-img">
        </span>
        <span class="header-title">Simulate Execution of <strong>{{ simState.programName }}</strong></span>
      </div>
      <div class="iters-run">
        <button class="blue-button" @click="reloadExecutionResults"
          title="Run Simulation" id="run-simulation-button" >
          Run Simulation
        </button>
        <span>AutoRun:</span>
        <input type="checkbox"
              title="Set to run the simulation every time the processor/program/#iterations is modified"
              id="automatic-simulation-check"
              :checked="simulationOptions.autorun"
              @change="toggleAutorun"
          />

        <div class="iters-group">
          <span class="iters-label" :title="`Rang: 1 - ${MAX_ITERS} iters`">
            Iterations:
          </span>
          <input
            type=      "text"
            inputmode= "numeric"
            pattern=   "[0-9]*"
            :placeholder="100"
            v-model=  "inputValue"
            @blur=    "validateField"
            @keypress="handleKeyPress"
            @input=   "handleInput"
            id=       "simulation-iterations"
            :class=   "{ 'invalid': isInvalid }"
            :title=   "`Rang: 1 - ${MAX_ITERS} iters`"
          />
        </div>
      </div>
    </div>

    <div id="simulation-results-info" class="results-info">
      <div class="row">
        <div class="simulation-inline-item">
          <label for="instructions">Instructions:</label>
          <span id="instructions-output" title="Total executed instructions">{{ formattedResults.instructions }}</span>
        </div>
        <div class="simulation-inline-item">
          <label for="cycles">ClockCycles:</label>
          <span id="cycles-output" title="Total clock cycles">{{ formattedResults.cycles }}</span>
        </div>
        <div class="simulation-inline-item">
          <label for="cycles-per-iteration">Cycles per iteration:</label>
          <span id="cycles-per-iteration-output" title="Clock cycles per loop iteration">{{ formattedResults.cpi }}</span>
        </div>
      </div>
      <div class="row">
        <div class="simulation-inline-item">
          <label for="IPC">IPC:</label>
          <span
            id="IPC-output"
            :style="ipcStyle"
            :data-tooltip="ipcTooltip"
          >
            {{ formattedResults.ipc }}
          </span>
        </div>
        <div class="simulation-inline-item">
          <label for="Loads">Loads:</label>
          <span id="Loads-output" title="Total executed LOADs">{{ formattedResults.loads }}</span>
        </div>
      </div>
    </div>

    <div class="sim-running-msg">
      <div class="running-group">
        <div id="run-simulation-spinner" class="spinner" style="display: none;"></div>
        <div id="simulation-running"><p>Simulation on course...</p></div>
      </div>
    </div>

    <div class="dropdown-wrapper" id="previous-simulations-section">
      <span ref="helpIcon2" class="info-icon" @click="openHelp2" title="Show help">
         <img src="/img/info.png" class="info-img">
      </span>
      <button class="dropdown-header" @click="togglePrevious" :aria-expanded="showPrevious"
        title="Show previous simulation results"
        id   ="show-previous-button">
        <span class="arrow" aria-hidden="true">
          {{ simulationOptions.showPrevious ? '▼' : '▶' }}
        </span>
        <span class="dropdown-title">Previous simulation results</span>
      </button>
    </div>

    <div class="graph-section">
      <div class="processor-container">
        <div class="processor-img" v-html="resultsSvg" v-if="resultsSvg"></div>
      </div>
    </div>

    <Transition name="fold" appear>
      <prev v-show="simulationOptions.showPrevious" id="previous-results"></prev>
    </Transition>
  </div>

  <Teleport to="body">
    <HelpComponent v-if="showHelp1" :position="helpPosition"
    text="<strong>Simulate</strong> the execution of a specified number of program loop iterations and view aggregate performance metrics,
      including the total number of executed <em>instructions</em>, total clock <em>cycles</em>, cycles <em>per loop iteration</em>,
      and <em>Instructions Per Cycle</em> (IPC). To obtain meaningful results, ensure a representative number of loop iterations is selected,
      as very low iteration counts may not fully capture the program's behavior and performance characteristics.
      <p>The table below provides statistics of the utilization of core processor resources: dispatch and retire widths, and usage of execution ports.
        These metrics are crucial for identifying potential performance bottlenecks in the simulated execution.</p>
    "
    title="Overall Simulation Results"
    @close="closeHelp1"/>
  </Teleport>

  <Teleport to="body">
    <HelpComponent v-if="showHelp2" :position="helpPosition"
    text="Open this tab to visualize the <strong>performance results</strong> from previous simulations.
      <p>For a detailed analysis of the critical execution path for a limited number of loop iterations you must use the <strong>Timeline</strong> tab.</p>
      "
    title="Previous Performance Results"
    @close="closeHelp2"/>
  </Teleport>

</template>

<style scoped>
  .iters-run {
    display:     flex;
    align-items: center;
    gap:         12px;
  }

  .results-info {
    font-size: 16px; /* Tamaño base más grande */
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  }

  .results-info .row {
    display:       flex;
    gap:           20px;
    margin-bottom: 8px;
    flex-wrap:     wrap;
    justify-content: space-between;
  }

  .simulation-inline-item {
    flex:            1;
    display:         flex;
    padding:         2px 2px;
    justify-content: space-between;
    align-items:     center;
    background:      #f0f0f0;
    border-radius:   6px;
  }
  .simulation-inline-item label {
    flex:         1;
    margin-right: 10px;
    font-weight:  600;
    color:       #333;
    font-size:    1.2em;
  }
  .simulation-inline-item span {
    text-align:  right;
    flex-shrink: 0;
    font-weight: bold;
    font-size: 1.1em;
    transition: color 0.3s ease;
  }

  #IPC-output {
    font-weight: bold;
    font-size: 1.2em;
    padding: 2px 6px;
    border-radius: 4px;
    transition: all 0.3s ease;
    display: inline-block;
    min-width: 60px;
    text-align: center;
  }

  #IPC-output {
    cursor: help;
    position: relative;
  }

  #IPC-output:hover::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.8);
    color: white;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    white-space: nowrap;
    z-index: 1000;
    pointer-events: none;
  }

  .sim-running-msg {
    display: flex;
    width:   100%;
    align-items:     center;
    justify-content: center;
  }
  .running-group {
    display: flex;
    gap:     10px;
  }
  .spinner {
    width:  15px;
    height: 15px;
    width:  5vh;
    height: 5vh;
    margin: auto;
    animation:  spin 1s linear infinite;
    border:     8px solid #f0f0f0;
    border-top: 8px solid #0085dd;
    border-radius: 50%;
  }
  @keyframes spin {
      0% {
          transform: rotate(0deg);
      }
      100% {
          transform: rotate(360deg);
      }
  }

  .graph-section {
    display:         flex;
    justify-content: center;
    align-items:     center;
  }

  .processor-img {
    width:        100%;
    height:       100%;
    max-width:    150%;
    max-height:   150%;
    align-items:  center;
    object-fit:   contain;
    transform-box: fill-box;
  }

  .processor-img svg text {
    font-size:   12px !important;
    font-family: Arial, sans-serif !important;
  }

  .processor-img svg polygon,
  .processor-img svg path {
    stroke-width: 2px !important;
  }

  .processor-container {
    width:     100%;
    height:    100%;
    display:   flex;
    margin-top: 2px;
  }

</style>
